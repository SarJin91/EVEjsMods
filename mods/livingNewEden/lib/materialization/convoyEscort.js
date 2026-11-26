"use strict";

const F = require("../fleetExposure/factionEscortRules");
const PH = require("./presenceHostility");

const CONVOY = "CONVOY";
const VISIBLE = "VISIBLE";
const HELD = "HELD";
const MAX_DETAIL = 120;

function noop() {}

function messageOf(err) {
  return String((err && err.message) || err).slice(0, MAX_DETAIL);
}

function createConvoyEscort(deps) {
  const S = deps.settings;
  const escortGroups = Array.isArray(deps.escortGroups) ? deps.escortGroups : [];
  const ambush = deps.ambush && typeof deps.ambush.engagedPiratesOf === "function" ? deps.ambush
    : { engagedPiratesOf: () => [] };
  const bump = typeof deps.bump === "function" ? deps.bump : noop;
  const logLimited = typeof deps.logLimited === "function" ? deps.logLimited : noop;
  let pass = { at: null, orders: 0 };

  const isEscort = (m) => Boolean(m) && escortGroups.includes(m.hullGroup);

  function escortIdsOf(e) {
    return new Set(e.members.filter((m) => isEscort(m) && !m.destroyed && !e.pendingDestroyed.includes(m.memberKey))
      .map((m) => m.entityId));
  }

  function beginPass(now) {
    if (pass.at !== now) pass = { at: now, orders: 0 };
  }

  function init(e) {
    if (!e || typeof e !== "object") return;
    const has = e.kind === CONVOY && Array.isArray(e.members) && e.members.some(isEscort);
    e.factionEscort = has ? { awake: false, wokeBy: null, hostileShips: new Set(), killers: new Set(),
      targetsFull: false, orders: 0, lost: 0 } : null;
  }

  function full(fe) {
    if (!fe.targetsFull) bump("factionEscortTargetsFull");
    fe.targetsFull = true;
  }

  function noteKiller(e, characterId) {
    const fe = e && e.factionEscort;
    if (!fe || !Number.isSafeInteger(characterId) || characterId <= 0 || fe.killers.has(characterId)) return;
    if (fe.killers.size >= S.convoyEscortMaxTargets) {
      full(fe);
      return;
    }
    fe.killers.add(characterId);
  }

  function noteKillerShips(fe, players) {
    if (fe.killers.size === 0 || !players || players.ok !== true || !Array.isArray(players.ships)) return;
    for (const p of players.ships) {
      if (!p || !fe.killers.has(p.characterId) || !Number.isSafeInteger(p.entityId) || p.entityId <= 0) continue;
      if (fe.hostileShips.has(p.entityId)) continue;
      if (fe.hostileShips.size >= S.convoyEscortMaxTargets) {
        full(fe);
        continue;
      }
      fe.hostileShips.add(p.entityId);
    }
  }

  function noteHostiles(fe, facts) {
    for (const a of Array.isArray(facts.aggressors) ? facts.aggressors : []) {
      if (!a || a.aggressorKind !== "player" || !Number.isSafeInteger(a.aggressorId) || a.aggressorId <= 0) continue;
      if (fe.hostileShips.has(a.aggressorId)) continue;
      if (fe.hostileShips.size >= S.convoyEscortMaxTargets) {
        full(fe);
        continue;
      }
      fe.hostileShips.add(a.aggressorId);
    }
  }

  function order(e, fe, seam, o, now) {
    pass.orders += 1;
    let r;
    try {
      r = seam.attackTargets(e.systemId, [o.entityId], [o.targetId]);
    } catch (err) {
      r = { ok: false, reason: "ORDER_THREW", detail: messageOf(err) };
    }
    if (r && r.ok === true && !(Array.isArray(r.failed) && r.failed.length > 0)) {
      fe.orders += 1;
      bump("factionEscortOrders");
      return;
    }
    bump("factionEscortOrderFailed");
    logLimited(now, `fleetExposure: faction escort ${e.fleetId} ship ${o.entityId} -> ${o.targetId} refused - `
      + `${(r && r.reason) || (r && r.ok === true ? "failed" : "no result")}`);
  }

  function step(e, facts, seam, players, now) {
    try {
      const fe = e && e.factionEscort;
      if (!fe || e.despawned || (e.phase !== VISIBLE && e.phase !== HELD) || !facts) return;
      beginPass(now);
      const playerAggression = (Array.isArray(facts.aggressors) ? facts.aggressors : [])
        .some((a) => a && a.aggressorKind === "player");
      const pirates = ambush.engagedPiratesOf(e);
      if (!fe.awake) {
        const reason = F.wakeReasonOf({ phase: e.phase, ambushEngaged: pirates.length > 0, playerAggression });
        if (reason === null) return;
        fe.awake = true;
        fe.wokeBy = reason;
        bump("factionEscortWakes");
        logLimited(now, `fleetExposure: faction escort ${e.fleetId} in ${e.systemId} awake (${reason})`);
      }
      noteHostiles(fe, facts);
      noteKillerShips(fe, players);
      if (facts.sceneLoaded !== true || !seam || typeof seam.attackTargets !== "function") return;
      const ids = escortIdsOf(e);
      const escortShips = (Array.isArray(facts.alive) ? facts.alive : []).filter((s) => s && ids.has(s.entityId))
        .sort((a, b) => a.entityId - b.entityId);
      if (escortShips.length === 0) return;
      const targets = F.escortTargetsOf({ escortShips,
        players: players && players.ok === true && Array.isArray(players.ships) ? players.ships : [],
        hostileShips: fe.hostileShips, pirates, targetPlayers: S.convoyEscortTargetPlayers !== false });
      const room = S.convoyEscortMaxOrdersPerPass - pass.orders;
      if (targets.length === 0 || !(room > 0)) return;
      const plan = PH.orderPlan(escortShips.map((s) => ({ entityId: s.entityId,
        attackTargetId: s.vendorOrder && Number.isSafeInteger(s.vendorOrder.attackTargetId)
          ? s.vendorOrder.attackTargetId : 0 })), targets, room);
      for (const o of plan) order(e, fe, seam, o, now);
    } catch (err) {
      logLimited(now, `fleetExposure: faction escort ${e && e.fleetId} threw - ${messageOf(err)}`);
    }
  }

  function beforeExit(e, seam, alive, now) {
    try {
      const fe = e && e.factionEscort;
      if (!fe || !fe.awake || !seam || typeof seam.setSearch !== "function") return;
      const ids = escortIdsOf(e);
      const live = (Array.isArray(alive) ? alive : []).filter((s) => s && ids.has(s.entityId)).map((s) => s.entityId);
      if (live.length === 0) return;
      const r = seam.setSearch(e.systemId, live);
      if (!r || r.ok !== true) {
        logLimited(now, `fleetExposure: faction escort ${e.fleetId} search before exit - `
          + `${(r && r.reason) || "no result"}`);
      }
    } catch (err) {
      logLimited(now, `fleetExposure: faction escort ${e && e.fleetId} search threw - ${messageOf(err)}`);
    }
  }

  function noteLoss(e, member) {
    if (!e || !e.factionEscort || !isEscort(member)) return false;
    e.factionEscort.lost += 1;
    bump("factionEscortLost");
    return true;
  }

  function statusOf(e) {
    const fe = e && e.factionEscort;
    if (!fe) return null;
    return { awake: fe.awake, wokeBy: fe.wokeBy, ships: e.members.filter(isEscort).length, lost: fe.lost,
      orders: fe.orders, targets: fe.hostileShips.size };
  }

  return Object.freeze({ init, step, beforeExit, noteLoss, noteKiller, isEscort, statusOf, beginPass });
}

module.exports = { createConvoyEscort };
