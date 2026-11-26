"use strict";

const { toBind } = require("../persistence/repository");

const TX_REQUIRED = Object.freeze({ ok: false, reason: "TX_REQUIRED" });
const txMissing = (tx) => !tx || typeof tx.prepare !== "function";
const isId = (v) => Number.isSafeInteger(v) && v > 0;
const invalid = (detail) => ({ ok: false, reason: "INVALID_INPUT", detail });
const num = (v) => (v === null || v === undefined ? null : Number(v));

function createResidentReads(opts = {}) {
  const whHomeFilter = !opts || opts.whHomeFilter !== false;
  const cache = new WeakMap();
  function stmts(db) {
    let s = cache.get(db);
    if (s) return s;
    s = {
      venturesInSystem: db.prepare("SELECT corp_id, system_id, crew FROM world_free_corp_ventures "
        + "WHERE open = 1 AND system_id = ? ORDER BY corp_id LIMIT ?"),
      homeCorps: db.prepare(whHomeFilter ? "SELECT corp_id, state FROM world_free_corps "
        + "WHERE open = 1 AND state IN ('ACTIVE','STRUGGLING') AND home_system_id = ? "
        + "AND NOT EXISTS (SELECT 1 FROM world_free_corp_wh_homes h WHERE h.corp_id = world_free_corps.corp_id "
        + "AND h.open = 1) ORDER BY corp_id LIMIT ?"
        : "SELECT corp_id, state FROM world_free_corps "
        + "WHERE open = 1 AND state IN ('ACTIVE','STRUGGLING') AND home_system_id = ? ORDER BY corp_id LIMIT ?"),
      openVentureOf: db.prepare("SELECT system_id, crew FROM world_free_corp_ventures WHERE open = 1 AND corp_id = ?"),
      mapCorps: db.prepare("SELECT corp_id, archetype, state, name, ticker, home_system_id, members_target "
        + "FROM world_free_corps WHERE open = 1 AND state IN ('ACTIVE','STRUGGLING') ORDER BY corp_id LIMIT ?"),
      mapVentures: db.prepare("SELECT corp_id, kind, state, system_id, crew, step, steps_total "
        + "FROM world_free_corp_ventures WHERE open = 1 ORDER BY corp_id LIMIT ?"),
    };
    cache.set(db, s);
    return s;
  }

  function venturesInSystemInTx(tx, systemId, limit) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isId(systemId) || !isId(limit)) return invalid("systemId/limit");
    const rows = stmts(tx).venturesInSystem.all(toBind(systemId), toBind(limit)).map((r) => Object.freeze({
      corpId: num(r.corp_id), systemId: num(r.system_id), crew: num(r.crew) }));
    return { ok: true, rows };
  }

  function homeCorpsInTx(tx, systemId, limit) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isId(systemId) || !isId(limit)) return invalid("systemId/limit");
    const rows = stmts(tx).homeCorps.all(toBind(systemId), toBind(limit)).map((r) => Object.freeze({
      corpId: num(r.corp_id), state: String(r.state) }));
    return { ok: true, rows };
  }

  function openVentureOfInTx(tx, corpId) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isId(corpId)) return invalid("corpId");
    const r = stmts(tx).openVentureOf.get(toBind(corpId));
    return { ok: true, rows: r ? [Object.freeze({ systemId: num(r.system_id), crew: num(r.crew) })] : [] };
  }

  function mapCorpsInTx(tx, limit) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isId(limit)) return invalid("limit");
    const rows = stmts(tx).mapCorps.all(toBind(limit)).map((r) => Object.freeze({ corpId: num(r.corp_id),
      archetype: String(r.archetype), state: String(r.state), name: String(r.name), ticker: String(r.ticker),
      homeSystemId: num(r.home_system_id), membersTarget: num(r.members_target) }));
    return { ok: true, rows };
  }

  function mapVenturesInTx(tx, limit) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isId(limit)) return invalid("limit");
    const rows = stmts(tx).mapVentures.all(toBind(limit)).map((r) => Object.freeze({ corpId: num(r.corp_id),
      kind: String(r.kind), state: String(r.state), systemId: num(r.system_id), crew: num(r.crew),
      step: num(r.step), stepsTotal: num(r.steps_total) }));
    return { ok: true, rows };
  }

  return Object.freeze({ venturesInSystemInTx, homeCorpsInTx, openVentureOfInTx, mapCorpsInTx, mapVenturesInTx });
}

module.exports = { createResidentReads };
