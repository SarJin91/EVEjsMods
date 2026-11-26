"use strict";

const { toBind } = require("../persistence/repository");
const { STRUCTURE_STATES: SS, MAX_STRUCTURE_END_REASON } = require("./schema");

const TX_REQUIRED = Object.freeze({ ok: false, reason: "TX_REQUIRED" });
const CAS_CONFLICT = Object.freeze({ ok: false, reason: "CAS_CONFLICT" });
const DUPLICATE = Object.freeze({ ok: false, reason: "DUPLICATE" });
const txMissing = (tx) => !tx || typeof tx.prepare !== "function";
const isTime = (v) => Number.isSafeInteger(v) && v >= 0;
const isId = (v) => Number.isSafeInteger(v) && v > 0;
const isKey = (v) => typeof v === "string" && v.length >= 13 && v.length <= 40;
const invalid = (detail) => ({ ok: false, reason: "INVALID_INPUT", detail });
const num = (v) => (v === null || v === undefined ? null : Number(v));
const END_STATES = Object.freeze([SS.LOST, SS.REMOVED, SS.FAILED]);
const OPEN_STATES = Object.freeze([SS.PLANNED, SS.ANCHORING, SS.ONLINE]);

const COLUMNS = "s.structure_key, s.corp_id, s.n, s.system_id, s.type_id, s.state, s.open, s.evejs_item_id, "
  + "s.cost_isk, s.penalty_isk, s.planned_at, s.anchored_at, s.online_at, s.ended_at, s.end_reason, s.updated_at, "
  + "s.version";
const CORP_COLUMNS = "c.open AS corp_open, c.state AS corp_state, c.name AS corp_name, c.ticker AS corp_ticker, "
  + "c.corporation_id AS corporation_id";
const INT_COLUMNS = Object.freeze(["corp_id", "n", "system_id", "type_id", "open", "evejs_item_id", "cost_isk",
  "penalty_isk", "planned_at", "anchored_at", "online_at", "ended_at", "updated_at", "version"]);

function rowOf(r) {
  const out = { ...r };
  for (const c of INT_COLUMNS) out[c] = num(r[c]);
  if (Object.prototype.hasOwnProperty.call(r, "corp_open")) {
    out.corp_open = r.corp_open === null || r.corp_open === undefined ? false : Number(r.corp_open) === 1;
    out.corporation_id = num(r.corporation_id);
  }
  return Object.freeze(out);
}

function isUnique(err) {
  return Boolean(err && typeof err.code === "string"
    && (err.code.startsWith("SQLITE_CONSTRAINT_UNIQUE") || err.code.startsWith("SQLITE_CONSTRAINT_PRIMARYKEY")))
    || Boolean(err && /UNIQUE constraint failed/.test(String(err.message)));
}

function createFreeCorpStructureRepository() {
  const cache = new WeakMap();
  function stmts(db) {
    let s = cache.get(db);
    if (s) return s;
    s = {
      countOpen: db.prepare("SELECT COUNT(*) AS n FROM world_free_corp_structures WHERE open = 1"),
      openCorpIds: db.prepare("SELECT DISTINCT corp_id FROM world_free_corp_structures WHERE open = 1"),
      countOpenSystem: db.prepare("SELECT COUNT(*) AS n FROM world_free_corp_structures WHERE open = 1 "
        + "AND system_id = ?"),
      candidates: db.prepare("SELECT c.corp_id, c.state, c.sec_band, c.home_system_id, c.corporation_id, c.isk, "
        + "c.structure_seq, c.version, c.archetype, "
        + "(SELECT COUNT(*) FROM world_free_corp_structures s WHERE s.open = 1 AND s.corp_id = c.corp_id) AS openOfCorp, "
        + "(SELECT MAX(s.ended_at) FROM world_free_corp_structures s WHERE s.state = 'LOST' AND s.corp_id = c.corp_id) "
        + "AS lastLostAt FROM world_free_corps c WHERE c.open = 1 AND c.state = 'ACTIVE' "
        + "AND c.sec_band IN ('lowsec','nullsec') AND c.corporation_id IS NOT NULL AND c.isk >= ? "
        + "ORDER BY (c.archetype = 'structure') DESC, c.isk DESC, c.corp_id LIMIT ?"),
      insert: db.prepare("INSERT INTO world_free_corp_structures (structure_key, corp_id, n, system_id, type_id, state, "
        + "open, evejs_item_id, cost_isk, penalty_isk, planned_at, anchored_at, online_at, ended_at, end_reason, "
        + "updated_at, version) VALUES (?, ?, ?, ?, ?, 'PLANNED', 1, NULL, ?, 0, ?, NULL, NULL, NULL, NULL, ?, 1)"),
      get: db.prepare(`SELECT ${COLUMNS}, ${CORP_COLUMNS} FROM world_free_corp_structures s `
        + "LEFT JOIN world_free_corps c ON c.corp_id = s.corp_id WHERE s.structure_key = ?"),
      openWithItem: db.prepare(`SELECT ${COLUMNS}, ${CORP_COLUMNS} FROM world_free_corp_structures s `
        + "LEFT JOIN world_free_corps c ON c.corp_id = s.corp_id WHERE s.open = 1 AND s.evejs_item_id IS NOT NULL "
        + "ORDER BY s.structure_key LIMIT ?"),
      open: db.prepare(`SELECT ${COLUMNS}, ${CORP_COLUMNS} FROM world_free_corp_structures s `
        + "LEFT JOIN world_free_corps c ON c.corp_id = s.corp_id WHERE s.open = 1 ORDER BY s.structure_key LIMIT ?"),
      anchored: db.prepare("UPDATE world_free_corp_structures SET state = 'ANCHORING', evejs_item_id = ?, "
        + "anchored_at = ?, updated_at = ?, version = version + 1 WHERE structure_key = ? AND version = ? "
        + "AND state = 'PLANNED'"),
      online: db.prepare("UPDATE world_free_corp_structures SET state = 'ONLINE', online_at = ?, updated_at = ?, "
        + "version = version + 1 WHERE structure_key = ? AND version = ? AND state = 'ANCHORING'"),
      end: db.prepare("UPDATE world_free_corp_structures SET state = ?, open = 0, ended_at = ?, end_reason = ?, "
        + "penalty_isk = ?, updated_at = ?, version = version + 1 WHERE structure_key = ? AND version = ? "
        + "AND state = ?"),
      prune: db.prepare("DELETE FROM world_free_corp_structures WHERE structure_key IN (SELECT structure_key "
        + "FROM world_free_corp_structures WHERE open = 0 AND ended_at < ? AND (state <> 'LOST' OR ended_at < ?) "
        + "ORDER BY ended_at, structure_key LIMIT ?)"),
      byState: db.prepare("SELECT state, COUNT(*) AS n FROM world_free_corp_structures GROUP BY state ORDER BY state"),
      lostSince: db.prepare("SELECT COUNT(*) AS n FROM world_free_corp_structures WHERE open = 0 AND ended_at >= ? "
        + "AND state = 'LOST'"),
      recent: db.prepare(`SELECT ${COLUMNS} FROM world_free_corp_structures s `
        + "ORDER BY s.updated_at DESC, s.structure_key DESC LIMIT ?"),
    };
    cache.set(db, s);
    return s;
  }

  function countOpenInTx(tx) {
    if (txMissing(tx)) return TX_REQUIRED;
    return { ok: true, count: num(stmts(tx).countOpen.get().n) };
  }

  function openCorpIdsInTx(tx) {
    if (txMissing(tx)) return TX_REQUIRED;
    return { ok: true, ids: new Set(stmts(tx).openCorpIds.all().map((r) => num(r.corp_id))) };
  }

  function countOpenInSystemInTx(tx, systemId) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isId(systemId)) return invalid("systemId");
    return { ok: true, count: num(stmts(tx).countOpenSystem.get(toBind(systemId)).n) };
  }

  function candidatesInTx(tx, { minIsk, limit } = {}) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isTime(minIsk) || !isId(limit)) return invalid("candidates");
    const rows = stmts(tx).candidates.all(toBind(minIsk), toBind(limit)).map((r) => Object.freeze({
      corp_id: num(r.corp_id), state: r.state, sec_band: r.sec_band, home_system_id: num(r.home_system_id),
      corporation_id: num(r.corporation_id), isk: num(r.isk), structure_seq: num(r.structure_seq),
      version: num(r.version), openOfCorp: num(r.openOfCorp), lastLostAt: num(r.lastLostAt), archetype: r.archetype }));
    return { ok: true, rows };
  }

  function insertPlannedInTx(tx, { key, corpId, n, systemId, typeId, costIsk, now } = {}) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isKey(key) || !isId(corpId) || !isId(n) || !isId(systemId) || !isId(typeId) || !isTime(costIsk)
      || !isTime(now)) {
      return invalid("insert");
    }
    try {
      stmts(tx).insert.run(key, toBind(corpId), toBind(n), toBind(systemId), toBind(typeId), toBind(costIsk),
        toBind(now), toBind(now));
    } catch (err) {
      if (isUnique(err)) return DUPLICATE;
      throw err;
    }
    return { ok: true, key };
  }

  function getInTx(tx, key) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isKey(key)) return invalid("key");
    const r = stmts(tx).get.get(key);
    return { ok: true, row: r ? rowOf(r) : null };
  }

  function listOpenWithItemInTx(tx, { limit } = {}) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isId(limit)) return invalid("limit");
    return { ok: true, rows: stmts(tx).openWithItem.all(toBind(limit)).map(rowOf) };
  }

  function listOpenInTx(tx, { limit } = {}) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isId(limit)) return invalid("limit");
    return { ok: true, rows: stmts(tx).open.all(toBind(limit)).map(rowOf) };
  }

  function anchoredInTx(tx, { key, expectedVersion, itemId, now } = {}) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isKey(key) || !isId(expectedVersion) || !isId(itemId) || !isTime(now)) return invalid("anchored");
    try {
      const info = stmts(tx).anchored.run(toBind(itemId), toBind(now), toBind(now), key, toBind(expectedVersion));
      return info.changes === 1 ? { ok: true } : CAS_CONFLICT;
    } catch (err) {
      if (isUnique(err)) return DUPLICATE;
      throw err;
    }
  }

  function onlineInTx(tx, { key, expectedVersion, now } = {}) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isKey(key) || !isId(expectedVersion) || !isTime(now)) return invalid("online");
    const info = stmts(tx).online.run(toBind(now), toBind(now), key, toBind(expectedVersion));
    return info.changes === 1 ? { ok: true } : CAS_CONFLICT;
  }

  function endInTx(tx, { key, expectedVersion, expectedState, state, reason, penaltyIsk = 0, now } = {}) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isKey(key) || !isId(expectedVersion) || !OPEN_STATES.includes(expectedState) || !END_STATES.includes(state)
      || typeof reason !== "string" || reason === "" || !isTime(penaltyIsk) || !isTime(now)) {
      return invalid("end");
    }
    const info = stmts(tx).end.run(state, toBind(now), reason.slice(0, MAX_STRUCTURE_END_REASON), toBind(penaltyIsk),
      toBind(now), key, toBind(expectedVersion), expectedState);
    return info.changes === 1 ? { ok: true } : CAS_CONFLICT;
  }

  function pruneInTx(tx, { before, now, cooldownMs, limit } = {}) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isTime(before) || !isTime(now) || !isTime(cooldownMs) || !isId(limit)) return invalid("prune");
    const lostBefore = Math.max(0, now - cooldownMs);
    return { ok: true, deleted: Number(stmts(tx).prune.run(toBind(before), toBind(lostBefore), toBind(limit)).changes) };
  }

  function statsInTx(tx, { since } = {}) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isTime(since)) return invalid("since");
    const s = stmts(tx);
    const byState = {};
    let open = 0;
    for (const r of s.byState.all()) {
      byState[r.state] = num(r.n);
      if (OPEN_STATES.includes(r.state)) open += num(r.n);
    }
    return { ok: true, open, byState, lostSince: num(s.lostSince.get(toBind(since)).n) };
  }

  function recentInTx(tx, { limit } = {}) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isId(limit)) return invalid("limit");
    return { ok: true, rows: stmts(tx).recent.all(toBind(limit)).map(rowOf) };
  }

  return Object.freeze({ countOpenInTx, openCorpIdsInTx, countOpenInSystemInTx, candidatesInTx, insertPlannedInTx, getInTx,
    listOpenWithItemInTx, listOpenInTx, anchoredInTx, onlineInTx, endInTx, pruneInTx, statsInTx, recentInTx });
}

module.exports = { createFreeCorpStructureRepository };
