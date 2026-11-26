"use strict";

const { TABLE, ROW_STATE, REWARD_STATE } = require("./schema");

const COLUMNS = "tale_id, generation, faction_id, constellation_id, security_band, target_system_id, steered, state, "
  + "bound_at, expires_at, outcome, terminal_event_id, effect, settled_at, attempts, version, reward_state, "
  + "reward_reason";
const MAX_REWARD_LIST = 8;
const REWARD_REASON_MAX = 32;
const TX_REQUIRED = Object.freeze({ ok: false, reason: "TX_REQUIRED" });
const MAX_SETTLED_LIST = 64;

const txMissing = (tx) => !tx || tx.inTransaction !== true || typeof tx.prepare !== "function";
const isId = (v) => Number.isSafeInteger(v) && v > 0;
const isTime = (v) => Number.isSafeInteger(v) && v >= 0;
const invalid = (detail) => ({ ok: false, reason: "NATIVE_INCURSION_INVALID_INPUT", detail });

function rowOf(r) {
  return Object.freeze({ taleId: r.tale_id, generation: r.generation, factionId: r.faction_id,
    constellationId: r.constellation_id, band: r.security_band, targetSystemId: r.target_system_id,
    steered: Number(r.steered) === 1, state: r.state, boundAt: r.bound_at, expiresAt: r.expires_at, outcome: r.outcome,
    terminalEventId: r.terminal_event_id, effect: r.effect, settledAt: r.settled_at, attempts: r.attempts,
    version: r.version, rewardState: r.reward_state === undefined ? null : r.reward_state,
    rewardReason: r.reward_reason === undefined ? null : r.reward_reason });
}

function createNativeIncursionRepository() {
  const cache = new WeakMap();

  function stmts(db) {
    let s = cache.get(db);
    if (!s) {
      s = {
        get: db.prepare(`SELECT ${COLUMNS} FROM ${TABLE} WHERE tale_id = ?`),
        listBound: db.prepare(`SELECT ${COLUMNS} FROM ${TABLE} WHERE state = 'BOUND' ORDER BY tale_id LIMIT ?`),
        countBound: db.prepare(`SELECT COUNT(*) AS n FROM ${TABLE} WHERE state = 'BOUND'`),
        listSettled: db.prepare(`SELECT ${COLUMNS} FROM ${TABLE} WHERE state = 'SETTLED'
          ORDER BY settled_at DESC, tale_id DESC LIMIT ?`),
        insert: db.prepare(`INSERT INTO ${TABLE} (tale_id, generation, faction_id, constellation_id, security_band,
          target_system_id, steered, state, bound_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'BOUND', ?, ?)`),
        settle: db.prepare(`UPDATE ${TABLE} SET state = 'SETTLED', outcome = ?, terminal_event_id = ?, effect = ?,
          settled_at = ?, reward_state = ?, version = version + 1 WHERE tale_id = ? AND state = 'BOUND' AND version = ?`),
        bump: db.prepare(`UPDATE ${TABLE} SET attempts = attempts + 1, version = version + 1
          WHERE tale_id = ? AND state = 'BOUND' AND version = ?`),
        listRewardPending: db.prepare(`SELECT ${COLUMNS} FROM ${TABLE} WHERE reward_state = 'PENDING'
          AND tale_id > ? ORDER BY tale_id LIMIT ?`),
        setReward: db.prepare(`UPDATE ${TABLE} SET reward_state = ?, reward_reason = ?, version = version + 1
          WHERE tale_id = ? AND reward_state = 'PENDING' AND version = ?`),
      };
      cache.set(db, s);
    }
    return s;
  }

  function getInTx(tx, taleId) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isId(taleId)) return invalid("taleId");
    const r = stmts(tx).get.get(taleId);
    return { ok: true, row: r ? rowOf(r) : null };
  }

  function listBoundInTx(tx, limit) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isId(limit)) return invalid("limit");
    return { ok: true, rows: stmts(tx).listBound.all(limit).map(rowOf) };
  }

  function listRecentSettledInTx(tx, limit) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isId(limit) || limit > MAX_SETTLED_LIST) return invalid("limit");
    return { ok: true, rows: stmts(tx).listSettled.all(limit).map(rowOf) };
  }

  function countBoundInTx(tx) {
    if (txMissing(tx)) return TX_REQUIRED;
    return { ok: true, count: stmts(tx).countBound.get().n };
  }

  function insertBoundInTx(tx, spec) {
    if (txMissing(tx)) return TX_REQUIRED;
    const s = spec || {};
    if (!isId(s.taleId) || !isId(s.generation) || !isId(s.factionId) || !isId(s.constellationId)
      || !["high", "low", "null"].includes(s.band) || !isId(s.targetSystemId) || typeof s.steered !== "boolean"
      || !isTime(s.boundAt) || !isTime(s.expiresAt)) {
      return invalid("spec");
    }
    if (stmts(tx).get.get(s.taleId)) return { ok: false, reason: "DUPLICATE" };
    stmts(tx).insert.run(s.taleId, s.generation, s.factionId, s.constellationId, s.band, s.targetSystemId,
      s.steered ? 1 : 0, s.boundAt, s.expiresAt);
    return { ok: true };
  }

  function settleInTx(tx, taleId, version, fields) {
    if (txMissing(tx)) return TX_REQUIRED;
    const f = fields || {};
    if (!isId(taleId) || !isId(version) || typeof f.outcome !== "string" || typeof f.effect !== "string"
      || !isTime(f.settledAt) || (f.terminalEventId !== null && typeof f.terminalEventId !== "string")) {
      return invalid("fields");
    }
    const rewardState = f.rewardState === undefined || f.rewardState === null ? null : f.rewardState;
    if (rewardState !== null && rewardState !== REWARD_STATE.PENDING) return invalid("rewardState");
    const eventId = f.terminalEventId === null ? null : f.terminalEventId.slice(0, 128);
    const info = stmts(tx).settle.run(f.outcome, eventId, f.effect, f.settledAt, rewardState, taleId, version);
    return info.changes === 1 ? { ok: true } : { ok: false, reason: "STALE" };
  }

  function listRewardPendingInTx(tx, limit, afterTaleId = 0) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isId(limit) || limit > MAX_REWARD_LIST) return invalid("limit");
    if (!isTime(afterTaleId)) return invalid("afterTaleId");
    return { ok: true, rows: stmts(tx).listRewardPending.all(afterTaleId, limit).map(rowOf) };
  }

  function setRewardInTx(tx, taleId, version, fields) {
    if (txMissing(tx)) return TX_REQUIRED;
    const f = fields || {};
    if (!isId(taleId) || !isId(version)
      || ![REWARD_STATE.PLANNED, REWARD_STATE.SKIPPED].includes(f.rewardState)
      || !(f.rewardReason === null || (typeof f.rewardReason === "string" && f.rewardReason !== ""
        && f.rewardReason.length <= REWARD_REASON_MAX))) {
      return invalid("fields");
    }
    const info = stmts(tx).setReward.run(f.rewardState, f.rewardReason, taleId, version);
    return info.changes === 1 ? { ok: true } : { ok: false, reason: "STALE" };
  }

  function bumpAttemptInTx(tx, taleId, version) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isId(taleId) || !isId(version)) return invalid("taleId");
    const info = stmts(tx).bump.run(taleId, version);
    return info.changes === 1 ? { ok: true } : { ok: false, reason: "STALE" };
  }

  return Object.freeze({ getInTx, listBoundInTx, listRecentSettledInTx, countBoundInTx, insertBoundInTx, settleInTx,
    bumpAttemptInTx, listRewardPendingInTx, setRewardInTx });
}

module.exports = { createNativeIncursionRepository, ROW_STATE, MAX_SETTLED_LIST, MAX_REWARD_LIST };
