"use strict";

const { STATE: EVENT_STATE } = require("../scheduler/schema");
const { holdKey } = require("./resolutionService");
const { resolveKey } = require("./contactService");

const RECONCILE_EVENT = "BATTLE_RECONCILE";
const RESOLUTION_EVENT = "BATTLE_RESOLUTION";
const LIVE_RECOVER_EVENT = "BATTLE_LIVE_RECOVER";
const LIVE_MODE = "LIVE_EVEJS";
const OPEN_STATES = Object.freeze(["PENDING", "CLAIMED", "RESOLVING", "SETTLING"]);
const READ_STATES = Object.freeze([...OPEN_STATES, "LIVE"]);
const KEEPING_STATES = Object.freeze([...READ_STATES, "QUARANTINED"]);

const liveRecoverKey = (battleId, bootAt) => `battle:${battleId}:liverecover:${bootAt}`;
const revertResolveKey = (battleId, claimSeq) => `battle:${battleId}:resolve:r${claimSeq - 1}`;
const OPEN_EVENT = Object.freeze([EVENT_STATE.QUEUED, EVENT_STATE.RETRY, EVENT_STATE.CLAIMED]);
const LOGGED_ORPHANS = 3;

const reconcileKey = (bootAt, page) => (page === 0 ? `battle:reconcile:${bootAt}` : `battle:reconcile:${bootAt}:${page}`);

function messageOf(err) {
  return String((err && err.message) || err);
}

function createReconcile(deps) {
  const { store, scheduler, battleRepository, fleetRepository, settings, bump, gauge, logger } = deps;
  const max = settings.reconcileMaxBattles;
  let revivedTotal = 0;
  let recoverTotal = 0;
  let orphanTotal = 0;

  function readPage(tx, cursor) {
    const battles = [];
    let stateIdx = cursor.state === null ? 0 : READ_STATES.indexOf(cursor.state);
    if (stateIdx < 0) stateIdx = 0;
    let after = cursor.afterId;
    while (battles.length < max && stateIdx < READ_STATES.length) {
      const page = battleRepository.listByState(tx, READ_STATES[stateIdx],
        { limit: max - battles.length, ...(after ? { afterId: after } : {}) });
      if (!page.ok) return page;
      battles.push(...page.battles);
      if (page.nextAfterId !== null) after = page.nextAfterId;
      else {
        stateIdx += 1;
        after = null;
      }
    }
    const next = stateIdx < READ_STATES.length ? { state: READ_STATES[stateIdx], afterId: after } : null;
    return { ok: true, battles, next };
  }

  function readOrphans(tx) {
    const engaged = fleetRepository.listFleetsByState(tx, "ENGAGED", { limit: max });
    if (!engaged.ok) return engaged;
    const orphans = [];
    for (const f of engaged.fleets) {
      const b = battleRepository.getByFleet(tx, f.fleetId, { states: [...KEEPING_STATES], limit: 1 });
      if (!b.ok) return b;
      if (b.battles.length === 0) orphans.push(f.fleetId);
    }
    const counted = battleRepository.countByState(tx);
    if (!counted.ok) return counted;
    return { ok: true, orphans, quarantined: counted.counts.QUARANTINED || 0 };
  }

  function hasOpenEvent(keys) {
    for (const key of keys) {
      const found = scheduler.findByKey(key);
      if (!found || found.ok !== true) return { ok: false, reason: (found && found.reason) || "FIND_FAILED" };
      if (found.found && OPEN_EVENT.includes(found.event.state)) return { ok: true, open: true };
    }
    return { ok: true, open: false };
  }

  function onReconcile(ev, hctx) {
    try {
      const p = ev.payload || {};
      const page = Number.isSafeInteger(p.page) && p.page >= 0 ? p.page : 0;
      const bootAt = Number.isSafeInteger(p.bootAt) ? p.bootAt : ev.dueAt;
      const cursor = { state: typeof p.state === "string" ? p.state : null,
        afterId: typeof p.afterId === "string" ? p.afterId : null };
      const now = hctx && Number.isSafeInteger(hctx.now) ? hctx.now : ev.dueAt;
      const tx = store.transaction("battle.reconcileRead", (db) => readPage(db, cursor));
      const read = tx.ok ? tx.value : tx;
      if (!read || !read.ok) return { ok: false, reason: (read && read.reason) || "TX_FAILED" };
      const b = Math.floor(now / settings.holdRecheckMs);
      const revive = [];
      const recover = [];
      for (const battle of read.battles) {
        if (battle.state === "LIVE" || battle.mode === LIVE_MODE) {
          if (Number(battle.updatedAt) < bootAt) recover.push(battle.battleId);
          continue;
        }
        const keys = [resolveKey(battle.battleId), holdKey(battle.battleId, b), holdKey(battle.battleId, b + 1)];
        if (Number.isSafeInteger(battle.claimSeq) && battle.claimSeq >= 2) {
          keys.push(revertResolveKey(battle.battleId, battle.claimSeq));
        }
        const open = hasOpenEvent(keys);
        if (!open.ok) return { ok: false, reason: open.reason };
        if (!open.open) revive.push(battle.battleId);
      }
      let orphans = null;
      if (read.next === null) {
        const o = store.transaction("battle.reconcileOrphans", (db) => readOrphans(db));
        orphans = o.ok ? o.value : o;
        if (!orphans || !orphans.ok) return { ok: false, reason: (orphans && orphans.reason) || "TX_FAILED" };
      }
      const dueAt = (b + 1) * settings.holdRecheckMs;
      const result = { ok: true, outcome: read.next === null ? "DONE" : "NEXT_PAGE",
        effect: revive.length === 0 && recover.length === 0 ? undefined : (etx) => {
          for (const battleId of revive) {
            const r = scheduler.enqueue(RESOLUTION_EVENT, battleId, dueAt, { battleId, at: dueAt },
              holdKey(battleId, b + 1), { tx: etx, chained: true });
            if (!r || r.ok !== true) return { ok: false, reason: (r && r.reason) || "ENQUEUE_FAILED" };
          }
          for (const battleId of recover) {
            const r = scheduler.enqueue(LIVE_RECOVER_EVENT, battleId, dueAt, { battleId, bootAt },
              liveRecoverKey(battleId, bootAt), { tx: etx, chained: true });
            if (!r || r.ok !== true) return { ok: false, reason: (r && r.reason) || "ENQUEUE_FAILED" };
          }
          return { ok: true };
        },
        onCommitted: () => {
          revivedTotal += revive.length;
          recoverTotal += recover.length;
          if (revive.length > 0) bump("reconcile.revived", revive.length);
          if (orphans === null) return;
          orphanTotal += orphans.orphans.length;
          if (orphans.orphans.length > 0) bump("reconcile.orphanFleets", orphans.orphans.length);
          gauge("quarantinedOpen", orphans.quarantined);
          const ids = orphans.orphans.slice(0, LOGGED_ORPHANS).join(",");
          logger.log(`battle: reconcile revived=${revivedTotal} liveRecover=${recoverTotal} orphanFleets=${orphanTotal}`
            + ` quarantined=${orphans.quarantined}${ids ? ` (${ids})` : ""}`);
        } };
      if (read.next !== null) {
        result.reschedule = { dueAt: now, payload: { afterId: read.next.afterId, state: read.next.state,
          page: page + 1, bootAt }, idempotencyKey: reconcileKey(bootAt, page + 1) };
      }
      return result;
    } catch (err) {
      return { ok: false, reason: `HANDLER_FAILED: ${messageOf(err)}` };
    }
  }

  return Object.freeze({ onReconcile });
}

module.exports = { createReconcile, RECONCILE_EVENT, reconcileKey, OPEN_STATES };
