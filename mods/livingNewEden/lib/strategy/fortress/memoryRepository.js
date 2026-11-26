"use strict";

const { HALT_MEMORY_TABLE_NAME, MAX_HALT_MEMORY_HALTS } = require("../schema");

const COLUMNS = "system_id, faction_id, halts, last_halt_at, until_at, updated_at, version";
const HALT_FIELDS = Object.freeze(["at", "factionId", "systemId", "untilAt"]);
const TX_REQUIRED = Object.freeze({ ok: false, reason: "TX_REQUIRED" });

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const isTime = (v) => Number.isSafeInteger(v) && v >= 0;
const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const invalid = (detail) => ({ ok: false, reason: "INVALID_INPUT", detail });
const dbError = (err) => ({ ok: false, reason: "DB_ERROR", detail: String((err && err.message) || err) });

function createHaltMemoryRepository(deps) {
  const d = deps || {};
  const maxHalts = Number.isSafeInteger(d.maxHalts) && d.maxHalts >= 1 && d.maxHalts <= MAX_HALT_MEMORY_HALTS
    ? d.maxHalts : MAX_HALT_MEMORY_HALTS;
  const perDb = new WeakMap();
  function stmts(db) {
    let s = perDb.get(db);
    if (s) return s;
    const T = HALT_MEMORY_TABLE_NAME;
    s = {
      upsert: db.prepare(`INSERT INTO ${T} (${COLUMNS}) VALUES (?, ?, 1, ?, ?, ?, 1)
        ON CONFLICT(system_id, faction_id) DO UPDATE SET halts = min(halts + 1, ?),
        last_halt_at = max(last_halt_at, excluded.last_halt_at), until_at = max(until_at, excluded.until_at),
        updated_at = excluded.updated_at, version = version + 1`),
      byKey: db.prepare(`SELECT until_at, halts FROM ${T} WHERE system_id = ? AND faction_id = ?`),
      all: db.prepare(`SELECT system_id, faction_id, until_at, halts FROM ${T} ORDER BY system_id, faction_id`),
    };
    perDb.set(db, s);
    return s;
  }

  function validate(halt) {
    if (!isPlainObject(halt)) return "halt";
    if (Object.keys(halt).sort().join() !== HALT_FIELDS.join()) return "halt.keys";
    if (!isId(halt.systemId)) return "halt.systemId";
    if (!isId(halt.factionId)) return "halt.factionId";
    if (!isTime(halt.at)) return "halt.at";
    if (!isTime(halt.untilAt) || halt.untilAt < halt.at) return "halt.untilAt";
    return null;
  }

  function recordHaltInTx(tx, halt) {
    if (!tx || tx.inTransaction !== true) return TX_REQUIRED;
    const bad = validate(halt);
    if (bad) return invalid(bad);
    try {
      const s = stmts(tx);
      s.upsert.run(halt.systemId, halt.factionId, halt.at, halt.untilAt, halt.at, maxHalts);
      const row = s.byKey.get(halt.systemId, halt.factionId);
      if (!row) return { ok: false, reason: "DB_ERROR", detail: "row missing after upsert" };
      return { ok: true, untilAt: Number(row.until_at), halts: Number(row.halts) };
    } catch (err) {
      return dbError(err);
    }
  }

  function listAllInTx(tx) {
    if (!tx || tx.inTransaction !== true) return TX_REQUIRED;
    try {
      const rows = stmts(tx).all.all().map((r) => Object.freeze({ systemId: Number(r.system_id),
        factionId: Number(r.faction_id), untilAt: Number(r.until_at), halts: Number(r.halts) }));
      return { ok: true, rows: Object.freeze(rows) };
    } catch (err) {
      return dbError(err);
    }
  }

  return Object.freeze({ recordHaltInTx, listAllInTx });
}

module.exports = { createHaltMemoryRepository };
