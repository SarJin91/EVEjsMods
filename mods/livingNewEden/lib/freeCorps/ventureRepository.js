"use strict";

const { toBind } = require("../persistence/repository");
const { VENTURE_STATES, VENTURE_OPEN_STATES, VENTURE_KINDS_ALL, MAX_END_REASON_LENGTH } = require("./schema");

const TX_REQUIRED = Object.freeze({ ok: false, reason: "TX_REQUIRED" });
const CAS_CONFLICT = Object.freeze({ ok: false, reason: "CAS_CONFLICT" });
const txMissing = (tx) => !tx || typeof tx.prepare !== "function";
const isTime = (v) => Number.isSafeInteger(v) && v >= 0;
const isId = (v) => Number.isSafeInteger(v) && v > 0;
const invalid = (detail) => ({ ok: false, reason: "INVALID_INPUT", detail });
const num = (v) => (v === null || v === undefined ? null : Number(v));
const bindOrNull = (v) => (v === null || v === undefined ? null : toBind(v));

const COLUMNS = "venture_id, corp_id, seq, kind, state, open, home_system_id, system_id, target_system_id, "
  + "target_station_id, sec_band, jumps, crew, crew_lost, step, travel_steps, work_steps, steps_total, holds, "
  + "yield_isk, cost_isk, started_at, step_due_at, updated_at, ended_at, end_reason, version, "
  + "wh_route, wh_entry_system_id, stranded_steps";
const INT_COLUMNS = Object.freeze(["corp_id", "seq", "open", "home_system_id", "system_id", "target_system_id",
  "target_station_id", "jumps", "crew", "crew_lost", "step", "travel_steps", "work_steps", "steps_total", "holds",
  "yield_isk", "cost_isk", "started_at", "step_due_at", "updated_at", "ended_at", "version", "wh_entry_system_id",
  "stranded_steps"]);
const STATES = Object.freeze(Object.values(VENTURE_STATES));
const MAX_WH_ROUTE_LENGTH = 200;
const whRouteOf = (v) => (v === undefined ? null : v);
const whRouteOk = (v) => v === null || (typeof v === "string" && v.length >= 1 && v.length <= MAX_WH_ROUTE_LENGTH);
const strandedOf = (v) => (v === undefined ? 0 : v);

function rowOf(r) {
  const out = { ...r };
  for (const c of INT_COLUMNS) out[c] = num(r[c]);
  return Object.freeze(out);
}

function isUnique(err) {
  return Boolean(err && typeof err.code === "string"
    && (err.code.startsWith("SQLITE_CONSTRAINT_UNIQUE") || err.code.startsWith("SQLITE_CONSTRAINT_PRIMARYKEY")))
    || Boolean(err && /UNIQUE constraint failed/.test(String(err.message)));
}

function closingOk(row) {
  const open = VENTURE_OPEN_STATES.includes(row.state) ? 1 : 0;
  const ended = row.ended_at === null || row.ended_at === undefined ? null : row.ended_at;
  return STATES.includes(row.state) && row.open === open && (ended === null) === (open === 1)
    && (ended === null || isTime(ended));
}

function reasonOf(row) {
  return typeof row.end_reason === "string" && row.end_reason !== ""
    ? row.end_reason.slice(0, MAX_END_REASON_LENGTH) : null;
}

function createFreeCorpVentureRepository() {
  const cache = new WeakMap();
  function stmts(db) {
    let s = cache.get(db);
    if (s) return s;
    s = {
      open: db.prepare(`SELECT ${COLUMNS} FROM world_free_corp_ventures WHERE open = 1 AND corp_id = ?`),
      insert: db.prepare(`INSERT INTO world_free_corp_ventures (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, `
        + "?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"),
      update: db.prepare("UPDATE world_free_corp_ventures SET state = ?, open = ?, system_id = ?, crew_lost = ?, "
        + "step = ?, holds = ?, yield_isk = ?, cost_isk = ?, step_due_at = ?, ended_at = ?, end_reason = ?, "
        + "steps_total = ?, wh_route = ?, stranded_steps = ?, "
        + "version = version + 1, updated_at = ? WHERE venture_id = ? AND version = ? AND state = ?"),
      prune: db.prepare("DELETE FROM world_free_corp_ventures WHERE venture_id IN (SELECT venture_id FROM "
        + "world_free_corp_ventures WHERE open = 0 AND ended_at < ? ORDER BY ended_at, venture_id LIMIT ?)"),
      countOpen: db.prepare("SELECT COUNT(*) AS n FROM world_free_corp_ventures WHERE open = 1"),
      prey: db.prepare("SELECT venture_id, corp_id, kind, state, system_id, sec_band, crew, crew_lost, holds, "
        + "step_due_at, version FROM world_free_corp_ventures WHERE open = 1 AND state = 'WORKING' "
        + "AND kind NOT IN ('WH_HOME','WH_RAID','WH_HAUL') ORDER BY system_id LIMIT ?"),
      view: db.prepare(`SELECT ${COLUMNS} FROM world_free_corp_ventures WHERE open = 1 ORDER BY corp_id LIMIT ?`),
      counts: db.prepare("SELECT open, state, kind, COUNT(*) AS n FROM world_free_corp_ventures "
        + "GROUP BY open, state, kind ORDER BY open, state, kind"),
    };
    cache.set(db, s);
    return s;
  }

  function getOpenInTx(tx, corpId) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isId(corpId)) return invalid("corpId");
    const r = stmts(tx).open.get(toBind(corpId));
    return { ok: true, venture: r ? rowOf(r) : null };
  }

  function insertInTx(tx, row, at) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!row || typeof row.venture_id !== "string" || !isId(row.corp_id) || !isId(row.seq) || !isTime(at)) {
      return invalid("row/at");
    }
    if (!VENTURE_KINDS_ALL.includes(row.kind) || !closingOk(row)) return invalid("kind/state");
    const whRoute = whRouteOf(row.wh_route);
    const stranded = strandedOf(row.stranded_steps);
    const entry = row.wh_entry_system_id === undefined ? null : row.wh_entry_system_id;
    if (!whRouteOk(whRoute)) return invalid("wh_route");
    if (!isTime(stranded)) return invalid("stranded_steps");
    if (entry !== null && !isId(entry)) return invalid("wh_entry_system_id");
    try {
      stmts(tx).insert.run(row.venture_id, toBind(row.corp_id), toBind(row.seq), row.kind, row.state,
        toBind(row.open), toBind(row.home_system_id), toBind(row.system_id), toBind(row.target_system_id),
        bindOrNull(row.target_station_id), row.sec_band, toBind(row.jumps), toBind(row.crew), toBind(row.crew_lost),
        toBind(row.step), toBind(row.travel_steps), toBind(row.work_steps), toBind(row.steps_total),
        toBind(row.holds), toBind(row.yield_isk), toBind(row.cost_isk), toBind(row.started_at),
        toBind(row.step_due_at), toBind(at), bindOrNull(row.ended_at), reasonOf(row), toBind(row.version),
        whRoute, bindOrNull(entry), toBind(stranded));
    } catch (err) {
      if (isUnique(err)) return { ok: false, reason: "DUPLICATE" };
      throw err;
    }
    return { ok: true, ventureId: row.venture_id };
  }

  function updateInTx(tx, { ventureId, expectedVersion, expectedState, row, at } = {}) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (typeof ventureId !== "string" || !isId(expectedVersion) || !STATES.includes(expectedState) || !isTime(at)
      || !row) {
      return invalid("update");
    }
    if (!closingOk(row)) return invalid("state/open");
    for (const c of ["system_id", "crew_lost", "step", "holds", "yield_isk", "cost_isk", "step_due_at"]) {
      if (!isTime(row[c])) return invalid(c);
    }
    if (!isId(row.steps_total)) return invalid("steps_total");
    const whRoute = whRouteOf(row.wh_route);
    const stranded = strandedOf(row.stranded_steps);
    if (!whRouteOk(whRoute)) return invalid("wh_route");
    if (!isTime(stranded)) return invalid("stranded_steps");
    const info = stmts(tx).update.run(row.state, toBind(row.open), toBind(row.system_id), toBind(row.crew_lost),
      toBind(row.step), toBind(row.holds), toBind(row.yield_isk), toBind(row.cost_isk), toBind(row.step_due_at),
      bindOrNull(row.ended_at), reasonOf(row), toBind(row.steps_total), whRoute, toBind(stranded), toBind(at),
      ventureId, toBind(expectedVersion), expectedState);
    return info.changes === 1 ? { ok: true } : CAS_CONFLICT;
  }

  function pruneClosedInTx(tx, { before, limit } = {}) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isTime(before) || !isId(limit)) return invalid("before/limit");
    const info = stmts(tx).prune.run(toBind(before), toBind(limit));
    return { ok: true, deleted: Number(info.changes) };
  }

  function listPreyInTx(tx, { limit } = {}) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isId(limit)) return invalid("limit");
    const rows = stmts(tx).prey.all(toBind(limit + 1)).map((r) => Object.freeze({ venture_id: r.venture_id,
      corp_id: num(r.corp_id), kind: r.kind, state: r.state, system_id: num(r.system_id), sec_band: r.sec_band,
      crew: num(r.crew), crew_lost: num(r.crew_lost), holds: num(r.holds), step_due_at: num(r.step_due_at),
      version: num(r.version) }));
    const truncated = rows.length > limit;
    const kept = truncated ? rows.slice(0, limit) : rows;
    kept.sort((a, b) => a.system_id - b.system_id || (a.venture_id < b.venture_id ? -1
      : a.venture_id > b.venture_id ? 1 : 0));
    return { ok: true, rows: kept, truncated };
  }

  function countOpenInTx(tx) {
    if (txMissing(tx)) return TX_REQUIRED;
    return { ok: true, count: num(stmts(tx).countOpen.get().n) };
  }

  function listOpenForViewInTx(tx, { limit } = {}) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isId(limit)) return invalid("limit");
    const rows = stmts(tx).view.all(toBind(limit + 1)).map(rowOf);
    const truncated = rows.length > limit;
    return { ok: true, rows: truncated ? rows.slice(0, limit) : rows, truncated };
  }

  function countsForViewInTx(tx) {
    if (txMissing(tx)) return TX_REQUIRED;
    const rows = stmts(tx).counts.all().map((r) => Object.freeze({ open: num(r.open), state: r.state, kind: r.kind,
      n: num(r.n) }));
    return { ok: true, rows };
  }

  return Object.freeze({ getOpenInTx, insertInTx, updateInTx, pruneClosedInTx, listPreyInTx, countOpenInTx,
    listOpenForViewInTx,
    countsForViewInTx });
}

module.exports = { createFreeCorpVentureRepository };
