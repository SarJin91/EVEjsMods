"use strict";

const { defineTable, updateWithVersion, toBind } = require("../../persistence/repository");
const { fingerprint, stableJson } = require("../../util/fingerprint");
const { TABLE_NAME, STATE, ANOMALY_ID_PREFIX, ANOMALY_ID_HASH_CHARS } = require("./schema");

const ANOMALY_TABLE = defineTable({
  name: TABLE_NAME,
  idColumn: "anomaly_id",
  columns: ["state", "end_reason", "placed_json", "wrecks_placed", "wrecks_remaining", "next_at", "updated_at",
    "ended_at"],
});

const INSERT_COLUMNS = Object.freeze(["anomaly_id", "field_id", "system_id", "state", "haul_salvage", "haul_loot",
  "seed", "plan_json", "wrecks_planned", "expires_at", "next_at", "created_at", "updated_at"]);

const cache = new WeakMap();

function stmts(tx) {
  let s = cache.get(tx);
  if (s) return s;
  s = {
    insert: tx.prepare(`INSERT INTO ${TABLE_NAME} (${INSERT_COLUMNS.join(", ")})
      VALUES (${INSERT_COLUMNS.map(() => "?").join(", ")})`),
    byId: tx.prepare(`SELECT * FROM ${TABLE_NAME} WHERE anomaly_id = ?`),
    byField: tx.prepare(`SELECT * FROM ${TABLE_NAME} WHERE field_id = ?`),
    countLive: tx.prepare(`SELECT COUNT(*) AS n FROM ${TABLE_NAME} WHERE state <> '${STATE.ENDED}'`),
    countLiveSystem: tx.prepare(`SELECT COUNT(*) AS n FROM ${TABLE_NAME}
      WHERE system_id = ? AND state <> '${STATE.ENDED}'`),
    countCollectableSystem: tx.prepare(`SELECT COUNT(*) AS n FROM ${TABLE_NAME}
      WHERE system_id = ? AND state IN ('${STATE.SITE_PENDING}', '${STATE.PLACING}', '${STATE.PLACED}')`),
    due: tx.prepare(`SELECT * FROM ${TABLE_NAME} WHERE state <> '${STATE.ENDED}' AND next_at <= ?
      ORDER BY next_at, anomaly_id LIMIT ?`),
    countByState: tx.prepare(`SELECT state, COUNT(*) AS n FROM ${TABLE_NAME} GROUP BY state`),
    listLive: tx.prepare(`SELECT * FROM ${TABLE_NAME} WHERE state <> '${STATE.ENDED}'
      ORDER BY created_at DESC, anomaly_id LIMIT ?`),
    listEnded: tx.prepare(`SELECT * FROM ${TABLE_NAME} WHERE state = '${STATE.ENDED}'
      ORDER BY ended_at DESC, anomaly_id LIMIT ?`),
    observedLive: new Map(),
    board: tx.prepare(`SELECT anomaly_id, system_id, state, wrecks_remaining, expires_at FROM ${TABLE_NAME}
      WHERE state = '${STATE.PLACED}' AND system_id IN (SELECT value FROM json_each(?))
      ORDER BY expires_at, anomaly_id LIMIT ?`),
    boardAll: tx.prepare(`SELECT anomaly_id, system_id, state, wrecks_remaining, expires_at FROM ${TABLE_NAME}
      WHERE state = '${STATE.PLACED}' ORDER BY expires_at, anomaly_id LIMIT ?`),
  };
  cache.set(tx, s);
  return s;
}

function anomalyIdOf(fieldId) {
  return `${ANOMALY_ID_PREFIX}${fingerprint({ fieldId }).slice(0, ANOMALY_ID_HASH_CHARS)}`;
}

function parseJsonArray(text) {
  try {
    const value = JSON.parse(text);
    return Array.isArray(value) ? value : [];
  } catch (_err) {
    return [];
  }
}

function num(v) {
  return v === null || v === undefined ? null : Number(v);
}

function rowOf(r) {
  if (!r) return null;
  return Object.freeze({
    anomalyId: r.anomaly_id, fieldId: r.field_id, systemId: Number(r.system_id), state: r.state,
    endReason: r.end_reason, haulSalvage: Number(r.haul_salvage), haulLoot: Number(r.haul_loot),
    seed: Number(r.seed), plan: parseJsonArray(r.plan_json), placed: parseJsonArray(r.placed_json),
    wrecksPlanned: Number(r.wrecks_planned), wrecksPlaced: Number(r.wrecks_placed),
    wrecksRemaining: Number(r.wrecks_remaining), expiresAt: Number(r.expires_at), nextAt: Number(r.next_at),
    createdAt: Number(r.created_at), updatedAt: Number(r.updated_at), endedAt: num(r.ended_at),
    version: Number(r.version),
  });
}

function insertInTx(tx, rec) {
  const s = stmts(tx);
  if (s.byId.get(rec.anomalyId) || s.byField.get(rec.fieldId)) return { ok: false, reason: "ANOMALY_EXISTS" };
  s.insert.run(rec.anomalyId, rec.fieldId, toBind(rec.systemId), STATE.SITE_PENDING, toBind(rec.haulSalvage),
    toBind(rec.haulLoot), toBind(rec.seed), stableJson(rec.planRows), toBind(rec.planRows.length),
    toBind(rec.expiresAt), toBind(rec.now), toBind(rec.now), toBind(rec.now));
  return { ok: true };
}

function getInTx(tx, anomalyId) {
  return rowOf(stmts(tx).byId.get(anomalyId));
}

function getByFieldInTx(tx, fieldId) {
  return rowOf(stmts(tx).byField.get(fieldId));
}

function countLiveInTx(tx) {
  return Number(stmts(tx).countLive.get().n);
}

function countLiveBySystemInTx(tx, systemId) {
  return Number(stmts(tx).countLiveSystem.get(toBind(systemId)).n);
}

function countCollectableBySystemInTx(tx, systemId) {
  return Number(stmts(tx).countCollectableSystem.get(toBind(systemId)).n);
}

function listDueInTx(tx, now, limit) {
  return stmts(tx).due.all(toBind(now), toBind(limit)).map(rowOf);
}

function countObservedLiveInTx(tx, systemIds) {
  const ids = Array.isArray(systemIds) ? systemIds.filter((id) => Number.isSafeInteger(id) && id > 0) : [];
  if (ids.length === 0) return 0;
  const s = stmts(tx);
  let stmt = s.observedLive.get(ids.length);
  if (!stmt) {
    stmt = tx.prepare(`SELECT COUNT(*) AS n FROM ${TABLE_NAME}
      WHERE system_id IN (${ids.map(() => "?").join(", ")}) AND state IN ('${STATE.PLACED}', '${STATE.ENDING}')`);
    s.observedLive.set(ids.length, stmt);
  }
  return Number(stmt.get(...ids.map(toBind)).n);
}

function countByStateInTx(tx) {
  const out = {};
  for (const r of stmts(tx).countByState.all()) out[r.state] = Number(r.n);
  return out;
}

function listLiveInTx(tx, limit) {
  return stmts(tx).listLive.all(toBind(limit)).map(rowOf);
}

function listBoardInTx(tx, opts) {
  const all = Boolean(opts) && opts.systemIds === null;
  const ids = opts && Array.isArray(opts.systemIds)
    ? opts.systemIds.filter((id) => Number.isSafeInteger(id) && id > 0) : [];
  const limit = opts && Number.isSafeInteger(opts.limit) && opts.limit > 0 ? opts.limit : 1;
  if (!all && ids.length === 0) return { ok: true, rows: [], truncated: false };
  const s = stmts(tx);
  const rows = all ? s.boardAll.all(toBind(limit + 1)) : s.board.all(JSON.stringify(ids), toBind(limit + 1));
  return { ok: true, truncated: rows.length > limit, rows: rows.slice(0, limit).map((r) => Object.freeze({
    anomalyId: r.anomaly_id, systemId: Number(r.system_id), state: r.state,
    wrecksRemaining: Number(r.wrecks_remaining), expiresAt: Number(r.expires_at) })) };
}

function listRecentEndedInTx(tx, limit) {
  return stmts(tx).listEnded.all(toBind(limit)).map(rowOf);
}

function transitionInTx(tx, row, patch) {
  const p = { ...patch };
  if (Array.isArray(p.placed_json)) p.placed_json = stableJson(p.placed_json);
  return updateWithVersion(tx, ANOMALY_TABLE, row.anomalyId, row.version, p);
}

module.exports = {
  ANOMALY_TABLE,
  anomalyIdOf,
  rowOf,
  insertInTx,
  getInTx,
  getByFieldInTx,
  countLiveInTx,
  countLiveBySystemInTx,
  countCollectableBySystemInTx,
  listDueInTx,
  countObservedLiveInTx,
  countByStateInTx,
  listLiveInTx,
  listBoardInTx,
  listRecentEndedInTx,
  transitionInTx,
};
