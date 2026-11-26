"use strict";

const S = require("./schema");

const stmtCache = new WeakMap();
const BEACHHEADS_SQL = "SELECT invasion_id AS invasionId, faction_id AS factionId, beachhead_system_id AS systemId "
  + "FROM world_invasions WHERE open = 1 AND state = 'ACTIVE' ORDER BY invasion_id LIMIT ?";
const BEACHHEADS_IN_SQL = "SELECT invasion_id AS invasionId, faction_id AS factionId, beachhead_system_id AS systemId "
  + "FROM world_invasions WHERE open = 1 AND state = 'ACTIVE' "
  + "AND +beachhead_system_id IN (SELECT value FROM json_each(?)) ORDER BY invasion_id LIMIT ?";

function getStmts(db) {
  let entry = stmtCache.get(db);
  if (!entry) {
    entry = {
      list: db.prepare("SELECT beachhead_system_id AS systemId, capture_range_jumps AS jumps FROM world_invasions WHERE faction_id = ? AND state = 'ACTIVE' ORDER BY beachhead_system_id"),
      beachheads: db.prepare(BEACHHEADS_SQL),
      beachheadsIn: db.prepare(BEACHHEADS_IN_SQL),
    };
    stmtCache.set(db, entry);
  }
  return entry;
}

function listFootholdsInTx(tx, factionId) {
  if (!Number.isSafeInteger(factionId) || factionId <= 0) return { ok: false, reason: "INVASION_INVALID_INPUT" };
  try {
    const stmts = getStmts(tx);
    const rows = stmts.list.all(factionId);
    const footholds = rows.map((r) => ({ systemId: Number(r.systemId), jumps: Number(r.jumps) }));
    return { ok: true, footholds };
  } catch (err) {
    return { ok: false, reason: `TX_FAILED: ${String(err)}` };
  }
}

function listBeachheadsInTx(tx, opts) {
  const limit = opts && opts.limit;
  if (!Number.isSafeInteger(limit) || limit < 1) return { ok: false, reason: "INVASION_INVALID_INPUT" };
  const systems = opts.systems;
  if (systems !== undefined && (!Array.isArray(systems) || !systems.every((id) => Number.isSafeInteger(id)))) {
    return { ok: false, reason: "INVASION_INVALID_INPUT" };
  }
  if (Array.isArray(systems) && systems.length === 0) return { ok: true, beachheads: [], truncated: false };
  try {
    const stmts = getStmts(tx);
    const rows = Array.isArray(systems) ? stmts.beachheadsIn.all(JSON.stringify(systems), limit + 1)
      : stmts.beachheads.all(limit + 1);
    const beachheads = rows.slice(0, limit).map((r) => ({ invasionId: r.invasionId, factionId: Number(r.factionId),
      systemId: Number(r.systemId) }));
    return { ok: true, beachheads, truncated: rows.length > limit };
  } catch (err) {
    return { ok: false, reason: `TX_FAILED: ${String(err)}` };
  }
}

module.exports = { listFootholdsInTx, listBeachheadsInTx, BEACHHEADS_SQL, BEACHHEADS_IN_SQL };