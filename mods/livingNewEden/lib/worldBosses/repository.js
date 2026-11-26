"use strict";

const S = require("./schema");
const { canTransition, MODE_TRANSITIONS } = require("./machine");

const COLUMNS = `boss_id, boss_no, kind, faction_id, origin_kind, origin_ref, state, mode, phase, units_json, hp_at,
  system_id, next_system_id, region_id, visit_no, hops, step_seq, visited_json, goal_system_id, seed, dwell_since,
  next_due_at, site_event_id, top_faction_id, created_at, expires_at, updated_at, ended_at, end_reason, version,
  next_clash_at, clash_round, open_clashes_json, damage_by_json, reward_state, live_since, live_boot_at,
  reward_attempts`;
const PAYOUT_COLUMNS = `payout_key, boss_id, character_id, system_id, amount_isk, state, attempts, next_attempt_at,
  last_reason, created_at, updated_at, settled_at, version`;

const PATCH_COLUMNS = Object.freeze({ state: "state", phase: "phase", unitsJson: "units_json", hpAt: "hp_at",
  systemId: "system_id", nextSystemId: "next_system_id", regionId: "region_id", visitNo: "visit_no", hops: "hops",
  stepSeq: "step_seq", visitedJson: "visited_json", goalSystemId: "goal_system_id", dwellSince: "dwell_since",
  nextDueAt: "next_due_at", siteEventId: "site_event_id", endedAt: "ended_at", endReason: "end_reason",
  nextClashAt: "next_clash_at", clashRound: "clash_round", openClashesJson: "open_clashes_json",
  damageByJson: "damage_by_json", rewardState: "reward_state", topFactionId: "top_faction_id",
  mode: "mode", liveSince: "live_since", liveBootAt: "live_boot_at",
  rewardAttempts: "reward_attempts" });

const OPEN_WHERE = "state IN ('DWELL', 'MOVING')";
const CAS_LOST = Symbol("worldBosses.CAS_LOST");

const messageOf = (err) => String((err && err.message) || err).slice(0, 160);
const num = (v) => (v === null || v === undefined ? null : Number(v));

function parseList(text) {
  try {
    const v = JSON.parse(text);
    return Array.isArray(v) ? v.filter((x) => Number.isSafeInteger(x)) : [];
  } catch (_err) {
    return [];
  }
}

function parseStrings(text) {
  try {
    const v = JSON.parse(text);
    return Array.isArray(v) ? v.filter((x) => typeof x === "string" && x !== "") : [];
  } catch (_err) {
    return [];
  }
}

function parseDamageBy(text) {
  const out = {};
  try {
    const v = JSON.parse(text);
    if (!v || typeof v !== "object" || Array.isArray(v)) return out;
    for (const [k, n] of Object.entries(v)) {
      if (/^\d+$/.test(k) && Number.isSafeInteger(n) && n > 0) out[k] = n;
    }
  } catch (_err) {
  }
  return out;
}

function rowOf(r) {
  if (!r) return null;
  return Object.freeze({ bossId: r.boss_id, bossNo: num(r.boss_no), kind: r.kind, factionId: num(r.faction_id),
    originKind: r.origin_kind, originRef: r.origin_ref === null ? null : r.origin_ref, state: r.state, mode: r.mode,
    phase: num(r.phase), unitsJson: r.units_json, hpAt: num(r.hp_at), systemId: num(r.system_id),
    nextSystemId: num(r.next_system_id), regionId: num(r.region_id), visitNo: num(r.visit_no), hops: num(r.hops),
    stepSeq: num(r.step_seq), visited: Object.freeze(parseList(r.visited_json)), goalSystemId: num(r.goal_system_id),
    seed: num(r.seed), dwellSince: num(r.dwell_since), nextDueAt: num(r.next_due_at),
    siteEventId: r.site_event_id === null ? null : r.site_event_id, topFactionId: num(r.top_faction_id),
    createdAt: num(r.created_at), expiresAt: num(r.expires_at), updatedAt: num(r.updated_at),
    endedAt: num(r.ended_at), endReason: r.end_reason === null ? null : r.end_reason, version: num(r.version),
    nextClashAt: r.next_clash_at === undefined ? null : num(r.next_clash_at),
    clashRound: r.clash_round === undefined ? 0 : num(r.clash_round),
    openClashes: Object.freeze(r.open_clashes_json === undefined ? [] : parseStrings(r.open_clashes_json)),
    damageBy: Object.freeze(r.damage_by_json === undefined ? {} : parseDamageBy(r.damage_by_json)),
    rewardState: r.reward_state === undefined ? null : r.reward_state,
    liveSince: r.live_since === undefined ? null : num(r.live_since),
    liveBootAt: r.live_boot_at === undefined ? null : num(r.live_boot_at),
    rewardAttempts: r.reward_attempts === undefined ? 0 : num(r.reward_attempts) });
}

function payoutOf(r) {
  return Object.freeze({ payoutKey: r.payout_key, bossId: r.boss_id, characterId: num(r.character_id),
    systemId: num(r.system_id), amountIsk: num(r.amount_isk), state: r.state, attempts: num(r.attempts),
    nextAttemptAt: num(r.next_attempt_at), lastReason: r.last_reason === null ? null : r.last_reason,
    createdAt: num(r.created_at), updatedAt: num(r.updated_at), settledAt: num(r.settled_at),
    version: num(r.version) });
}

function createWorldBossRepository(deps) {
  const journal = deps && deps.journal;
  if (!journal || typeof journal.applyOnce !== "function") throw new TypeError("worldBosses repository: journal");
  const perDb = new WeakMap();

  function stmts(db) {
    let s = perDb.get(db);
    if (s) return s;
    s = {
      countOpen: db.prepare(`SELECT count(*) AS n FROM ${S.TABLE} WHERE ${OPEN_WHERE}`),
      listOpen: db.prepare(`SELECT ${COLUMNS} FROM ${S.TABLE} WHERE ${OPEN_WHERE}
        ORDER BY next_due_at, boss_id LIMIT ?`),
      byId: db.prepare(`SELECT ${COLUMNS} FROM ${S.TABLE} WHERE boss_id = ?`),
      byOrigin: db.prepare(`SELECT ${COLUMNS} FROM ${S.TABLE} WHERE origin_kind = ? AND origin_ref = ?`),
      byNo: db.prepare(`SELECT ${COLUMNS} FROM ${S.TABLE} WHERE boss_no = ?`),
      lastEnded: db.prepare(`SELECT max(ended_at) AS at FROM ${S.TABLE} WHERE ended_at IS NOT NULL`),
      maxNo: db.prepare(`SELECT max(boss_no) AS n FROM ${S.TABLE}`),
      insert: db.prepare(`INSERT INTO ${S.TABLE} (boss_id, boss_no, kind, faction_id, origin_kind, origin_ref, state,
        mode, phase, units_json, hp_at, system_id, next_system_id, region_id, visit_no, hops, step_seq, visited_json,
        goal_system_id, seed, dwell_since, next_due_at, site_event_id, created_at, expires_at, updated_at, version)
        VALUES (?, ?, ?, ?, ?, ?, '${S.STATES.DWELL}', '${S.MODES.VIRTUAL}', ?, ?, ?, ?, NULL, ?, ?, 0, 0, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, 1)`),
      endedIds: db.prepare(`SELECT boss_id FROM ${S.TABLE} WHERE ended_at IS NOT NULL AND ended_at < ?
        ORDER BY ended_at LIMIT ?`),
      delParticipants: db.prepare(`DELETE FROM ${S.PARTICIPANTS_TABLE} WHERE boss_id = ?`),
      countParticipants: db.prepare(`SELECT count(*) AS n FROM ${S.PARTICIPANTS_TABLE} WHERE boss_id = ?`),
      getParticipant: db.prepare(`SELECT phases_mask FROM ${S.PARTICIPANTS_TABLE} WHERE boss_id = ?
        AND character_id = ?`),
      insertParticipant: db.prepare(`INSERT INTO ${S.PARTICIPANTS_TABLE} (boss_id, character_id, phases_mask, first_at,
        last_at) VALUES (?, ?, ?, ?, ?)`),
      updateParticipant: db.prepare(`UPDATE ${S.PARTICIPANTS_TABLE} SET phases_mask = ?, last_at = ? WHERE boss_id = ?
        AND character_id = ?`),
      listParticipants: db.prepare(`SELECT character_id, phases_mask, first_at, last_at FROM ${S.PARTICIPANTS_TABLE}
        WHERE boss_id = ? ORDER BY character_id LIMIT ?`),
      delBoss: db.prepare(`DELETE FROM ${S.TABLE} WHERE boss_id = ?`),
      rewardDue: db.prepare(`SELECT ${COLUMNS} FROM ${S.TABLE} WHERE ended_at IS NOT NULL AND ended_at >= ?
        AND state = '${S.STATES.DEFEATED}' AND reward_state = '${S.REWARD_STATES.PENDING}'
        ORDER BY ended_at, boss_id LIMIT ?`),
      releaseDue: db.prepare(`SELECT ${COLUMNS} FROM ${S.TABLE} WHERE ended_at IS NOT NULL AND ended_at < ?
        AND reward_state = '${S.REWARD_STATES.PLACED}' AND site_event_id IS NOT NULL ORDER BY ended_at, boss_id
        LIMIT ?`),
      endedSince: db.prepare(`SELECT ${COLUMNS} FROM ${S.TABLE} WHERE ended_at IS NOT NULL AND ended_at >= ?
        ORDER BY ended_at, boss_id LIMIT ?`),
      insertPayout: db.prepare(`INSERT INTO ${S.PAYOUTS_TABLE} (payout_key, boss_id, character_id, system_id,
        amount_isk, state, attempts, next_attempt_at, last_reason, created_at, updated_at, settled_at, version)
        VALUES (?, ?, ?, ?, ?, '${S.PAYOUT_STATES.PENDING}', 0, ?, NULL, ?, ?, NULL, 1)
        ON CONFLICT(payout_key) DO NOTHING`),
      duePayouts: db.prepare(`SELECT ${PAYOUT_COLUMNS} FROM ${S.PAYOUTS_TABLE}
        WHERE state = '${S.PAYOUT_STATES.PENDING}' AND next_attempt_at <= ? ORDER BY next_attempt_at, payout_key
        LIMIT ?`),
      laterPayouts: db.prepare(`SELECT min(next_attempt_at) AS at, count(*) AS n FROM ${S.PAYOUTS_TABLE}
        WHERE state = '${S.PAYOUT_STATES.PENDING}' AND next_attempt_at > ?`),
      markPayout: db.prepare(`UPDATE ${S.PAYOUTS_TABLE} SET state = ?, attempts = ?, next_attempt_at = ?,
        last_reason = ?, updated_at = ?, settled_at = ?, version = version + 1 WHERE payout_key = ? AND version = ?
        AND state = '${S.PAYOUT_STATES.PENDING}'`),
      countPendingPayouts: db.prepare(`SELECT count(*) AS n FROM ${S.PAYOUTS_TABLE}
        WHERE state = '${S.PAYOUT_STATES.PENDING}'`),
      prunePayouts: db.prepare(`DELETE FROM ${S.PAYOUTS_TABLE} WHERE payout_key IN (SELECT payout_key
        FROM ${S.PAYOUTS_TABLE} WHERE state IN ('${S.PAYOUT_STATES.PAID}', '${S.PAYOUT_STATES.FAILED}')
        AND settled_at < ? ORDER BY settled_at LIMIT ?)`),
    };
    perDb.set(db, s);
    return s;
  }

  function read(fn) {
    try {
      return fn();
    } catch (err) {
      return { ok: false, reason: "SQL_FAILED", detail: messageOf(err) };
    }
  }

  const countOpenInTx = (tx) => read(() => ({ ok: true, count: Number(stmts(tx).countOpen.get().n) }));
  const listOpenInTx = (tx, limit) => read(() => ({ ok: true,
    rows: stmts(tx).listOpen.all(limit).map(rowOf) }));
  const getInTx = (tx, bossId) => read(() => ({ ok: true, row: rowOf(stmts(tx).byId.get(bossId)) }));
  const getByOriginInTx = (tx, originKind, originRef) => read(() => ({ ok: true,
    row: rowOf(stmts(tx).byOrigin.get(originKind, originRef)) }));
  const getByNoInTx = (tx, bossNo) => read(() => ({ ok: true, row: rowOf(stmts(tx).byNo.get(bossNo)) }));
  const lastEndedAtInTx = (tx) => read(() => {
    const r = stmts(tx).lastEnded.get();
    return { ok: true, at: r && r.at !== null ? Number(r.at) : null };
  });
  const nextBossNoInTx = (tx) => read(() => {
    const r = stmts(tx).maxNo.get();
    return { ok: true, bossNo: r && r.n !== null ? Number(r.n) + 1 : 1 };
  });

  function journalSpecOf(bossId, entry) {
    return { key: entry.key, aggregate: { type: S.JOURNAL_AGGREGATE, id: bossId }, eventType: entry.eventType,
      payload: entry.payload };
  }

  function insertInTx(tx, spec, entry) {
    try {
      const r = journal.applyOnce(tx, journalSpecOf(spec.bossId, entry), () => {
        stmts(tx).insert.run(spec.bossId, spec.bossNo, spec.kind, spec.factionId, spec.originKind,
          spec.originRef === undefined ? null : spec.originRef, spec.phase, spec.unitsJson, spec.now, spec.systemId,
          spec.regionId, spec.visitNo, spec.visitedJson, spec.goalSystemId, spec.seed, spec.now, spec.nextDueAt,
          spec.siteEventId === undefined ? null : spec.siteEventId, spec.now, spec.expiresAt, spec.now);
        return true;
      });
      if (!r.ok) return { ok: false, reason: r.reason, detail: r.error ? messageOf(r.error) : undefined };
      return { ok: true, duplicate: r.duplicate === true, row: rowOf(stmts(tx).byId.get(spec.bossId)) };
    } catch (err) {
      return { ok: false, reason: "SQL_FAILED", detail: messageOf(err) };
    }
  }

  function transitionInTx(tx, spec, entry) {
    try {
      if (spec.from !== spec.to && !canTransition(spec.from, spec.to)) {
        return { ok: false, reason: "BAD_TRANSITION", detail: `${spec.from}->${spec.to}` };
      }
      if (!Number.isSafeInteger(spec.now)) return { ok: false, reason: "BAD_PATCH", detail: "now" };
      const sets = ["state = ?"];
      const args = [spec.to];
      const patch = spec.patch || {};
      for (const [key, column] of Object.entries(PATCH_COLUMNS)) {
        if (key === "state" || !Object.prototype.hasOwnProperty.call(patch, key)) continue;
        sets.push(`${column} = ?`);
        args.push(patch[key]);
      }
      sets.push("updated_at = ?", "version = version + 1");
      args.push(spec.now, spec.bossId, spec.expectedVersion, spec.from);
      const modeCas = typeof spec.expectedMode === "string";
      if (modeCas) args.push(spec.expectedMode);
      const r = journal.applyOnce(tx, journalSpecOf(spec.bossId, entry), () => {
        const info = tx.prepare(`UPDATE ${S.TABLE} SET ${sets.join(", ")} WHERE boss_id = ? AND version = ?
          AND state = ?${modeCas ? " AND mode = ?" : ""}`).run(...args);
        if (info.changes !== 1) throw CAS_LOST;
        return true;
      });
      if (!r.ok) {
        if (r.error === CAS_LOST) return { ok: false, reason: "VERSION_CONFLICT" };
        return { ok: false, reason: r.reason, detail: r.error ? messageOf(r.error) : undefined };
      }
      return { ok: true, duplicate: r.duplicate === true, row: rowOf(stmts(tx).byId.get(spec.bossId)) };
    } catch (err) {
      return { ok: false, reason: "SQL_FAILED", detail: messageOf(err) };
    }
  }

  function liveWriteInTx(tx, spec, entry, expectedMode, modePatch) {
    if (modePatch !== null && !MODE_TRANSITIONS[expectedMode].includes(modePatch.mode)) {
      return { ok: false, reason: "BAD_TRANSITION", detail: `${expectedMode}->${modePatch.mode}` };
    }
    return transitionInTx(tx, { ...spec, expectedMode, patch: { ...(spec.patch || {}), ...(modePatch || {}) } },
      entry);
  }

  const liveStartInTx = (tx, spec, entry) => liveWriteInTx(tx, spec, entry, S.MODES.VIRTUAL,
    { mode: S.MODES.LIVE, liveSince: spec.now, liveBootAt: spec.bootAt });
  const liveLossInTx = (tx, spec, entry) => liveWriteInTx(tx, spec, entry, S.MODES.LIVE, null);
  const livePhaseInTx = (tx, spec, entry) => liveWriteInTx(tx, spec, entry, S.MODES.LIVE,
    spec.to === S.STATES.DEFEATED ? { mode: S.MODES.VIRTUAL, liveSince: null, liveBootAt: null } : null);
  const liveExitInTx = (tx, spec, entry) => liveWriteInTx(tx, spec, entry, S.MODES.LIVE,
    { mode: S.MODES.VIRTUAL, liveSince: null, liveBootAt: null });

  function upsertParticipantsInTx(tx, bossId, characterIds, phase, now, max) {
    return read(() => {
      if (!Number.isSafeInteger(phase) || phase < 1 || phase > 30 || !Number.isSafeInteger(now)) {
        return { ok: false, reason: "INVALID_INPUT" };
      }
      const s = stmts(tx);
      const bit = 2 ** (phase - 1);
      let count = Number(s.countParticipants.get(bossId).n);
      const out = { ok: true, inserted: 0, updated: 0, overflow: 0 };
      const ids = [...new Set(Array.isArray(characterIds) ? characterIds : [])]
        .filter((id) => Number.isSafeInteger(id) && id > 0).sort((a, b) => a - b);
      for (const characterId of ids) {
        const seen = s.getParticipant.get(bossId, characterId);
        if (seen) {
          const mask = Number(seen.phases_mask);
          s.updateParticipant.run(Math.floor(mask / bit) % 2 === 1 ? mask : mask + bit, now, bossId, characterId);
          out.updated += 1;
        } else if (count < max) {
          s.insertParticipant.run(bossId, characterId, bit, now, now);
          count += 1;
          out.inserted += 1;
        } else out.overflow += 1;
      }
      return out;
    });
  }

  const listParticipantsInTx = (tx, bossId, limit) => read(() => ({ ok: true,
    rows: stmts(tx).listParticipants.all(bossId, limit).map((r) => Object.freeze({ characterId: num(r.character_id),
      phasesMask: num(r.phases_mask), firstAt: num(r.first_at), lastAt: num(r.last_at) })) }));

  function pruneEndedInTx(tx, before, limit) {
    return read(() => {
      const s = stmts(tx);
      const ids = s.endedIds.all(before, limit).map((r) => r.boss_id);
      for (const id of ids) {
        s.delParticipants.run(id);
        s.delBoss.run(id);
      }
      return { ok: true, deleted: ids.length };
    });
  }

  const listRewardDueInTx = (tx, since, limit) => read(() => ({ ok: true,
    rows: stmts(tx).rewardDue.all(since, limit).map(rowOf) }));
  const listReleaseDueInTx = (tx, before, limit) => read(() => ({ ok: true,
    rows: stmts(tx).releaseDue.all(before, limit).map(rowOf) }));
  const listEndedSinceInTx = (tx, since, limit) => read(() => ({ ok: true,
    rows: stmts(tx).endedSince.all(since, limit).map(rowOf) }));

  const REWARD_PATCH = Object.freeze({ rewardState: "reward_state", rewardAttempts: "reward_attempts",
    siteEventId: "site_event_id" });

  function rewardMarkInTx(tx, spec, entry) {
    try {
      if (!Number.isSafeInteger(spec.now)) return { ok: false, reason: "BAD_PATCH", detail: "now" };
      const sets = [];
      const args = [];
      for (const [key, column] of Object.entries(REWARD_PATCH)) {
        if (!spec.patch || !Object.prototype.hasOwnProperty.call(spec.patch, key)) continue;
        sets.push(`${column} = ?`);
        args.push(spec.patch[key]);
      }
      if (sets.length === 0) return { ok: false, reason: "BAD_PATCH", detail: "empty" };
      sets.push("updated_at = ?", "version = version + 1");
      args.push(spec.now, spec.bossId, spec.expectedVersion);
      const write = () => {
        const info = tx.prepare(`UPDATE ${S.TABLE} SET ${sets.join(", ")} WHERE boss_id = ? AND version = ?
          AND state = '${S.STATES.DEFEATED}'`).run(...args);
        if (info.changes !== 1) throw CAS_LOST;
        return true;
      };
      if (!entry) {
        try {
          write();
        } catch (err) {
          if (err === CAS_LOST) return { ok: false, reason: "VERSION_CONFLICT" };
          throw err;
        }
        return { ok: true, duplicate: false, row: rowOf(stmts(tx).byId.get(spec.bossId)) };
      }
      const r = journal.applyOnce(tx, journalSpecOf(spec.bossId, entry), write);
      if (!r.ok) {
        if (r.error === CAS_LOST) return { ok: false, reason: "VERSION_CONFLICT" };
        return { ok: false, reason: r.reason, detail: r.error ? messageOf(r.error) : undefined };
      }
      return { ok: true, duplicate: r.duplicate === true, row: rowOf(stmts(tx).byId.get(spec.bossId)) };
    } catch (err) {
      return { ok: false, reason: "SQL_FAILED", detail: messageOf(err) };
    }
  }

  const insertPayoutsInTx = (tx, plan, now) => read(() => {
    let inserted = 0;
    for (const p of Array.isArray(plan) ? plan : []) {
      inserted += stmts(tx).insertPayout.run(p.payoutKey, p.bossId, p.characterId, p.systemId, p.amountIsk, now, now,
        now).changes;
    }
    return { ok: true, inserted };
  });

  const listDuePayoutsInTx = (tx, limit, now) => read(() => {
    const s = stmts(tx);
    const payouts = s.duePayouts.all(now, limit).map(payoutOf);
    const later = s.laterPayouts.get(now);
    return { ok: true, payouts, waiting: Number(later.n), nextDueAt: later.at === null ? null : Number(later.at) };
  });

  const markPayoutInTx = (tx, p, m, now) => read(() => {
    const settled = m.state === S.PAYOUT_STATES.PENDING ? null : now;
    const info = stmts(tx).markPayout.run(m.state, m.attempts, m.nextAttemptAt === null ? 0 : m.nextAttemptAt,
      m.lastReason, now, settled, p.payoutKey, p.version);
    return info.changes === 1 ? { ok: true } : { ok: false, reason: "VERSION_CONFLICT" };
  });

  const countPendingPayoutsInTx = (tx) => read(() => ({ ok: true,
    pending: Number(stmts(tx).countPendingPayouts.get().n) }));

  const prunePayoutsInTx = (tx, before, limit) => read(() => ({ ok: true,
    deleted: stmts(tx).prunePayouts.run(before, limit).changes }));

  return Object.freeze({ countOpenInTx, listOpenInTx, getInTx, getByOriginInTx, getByNoInTx, lastEndedAtInTx,
    nextBossNoInTx, insertInTx, transitionInTx, pruneEndedInTx, liveStartInTx, liveLossInTx, livePhaseInTx,
    liveExitInTx, upsertParticipantsInTx, listParticipantsInTx, listRewardDueInTx, listReleaseDueInTx,
    listEndedSinceInTx, rewardMarkInTx, insertPayoutsInTx, listDuePayoutsInTx, markPayoutInTx,
    countPendingPayoutsInTx, prunePayoutsInTx });
}

module.exports = { createWorldBossRepository, rowOf };
