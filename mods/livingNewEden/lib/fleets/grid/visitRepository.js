"use strict";

const { VISITS_TABLE, VIA, ANCHOR_KINDS, PURPOSE } = require("./schema");

const MAX_FLEET_ID = 64;
const DESTROYED = "DESTROYED";
const VIA_VALUES = Object.freeze(Object.values(VIA));

const isPosInt = (v) => Number.isSafeInteger(v) && v > 0;
const isNonNegInt = (v) => Number.isSafeInteger(v) && v >= 0;
const isFleetId = (v) => typeof v === "string" && v.length >= 1 && v.length <= MAX_FLEET_ID;
const invalid = (detail) => ({ ok: false, reason: "INVALID_INPUT", detail });
const numOrNull = (v) => (v === null || v === undefined ? null : Number(v));

const UPSERT_SQL = `INSERT INTO ${VISITS_TABLE} (fleet_id, system_id, leg_seq, arrived_at, entered_via,
  entry_from_system_id, move_seq, at_kind, at_id, to_kind, to_id, depart_at, arrive_at, purpose, target_fleet_id,
  attempts, updated_at, version)
  VALUES (?, ?, ?, ?, ?, ?, 0, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0, ?, 1)
  ON CONFLICT (fleet_id) DO UPDATE SET system_id = excluded.system_id, leg_seq = excluded.leg_seq,
    arrived_at = excluded.arrived_at, entered_via = excluded.entered_via,
    entry_from_system_id = excluded.entry_from_system_id, move_seq = 0, at_kind = NULL, at_id = NULL, to_kind = NULL,
    to_id = NULL, depart_at = NULL, arrive_at = NULL, purpose = NULL, target_fleet_id = NULL, attempts = 0,
    updated_at = excluded.updated_at, version = version + 1
  WHERE NOT (system_id = excluded.system_id AND leg_seq = excluded.leg_seq)`;

const SELECT_MANY_SQL = `SELECT fleet_id, system_id, leg_seq, arrived_at, entered_via, entry_from_system_id, move_seq,
  at_kind, at_id, to_kind, to_id, depart_at, arrive_at, purpose, target_fleet_id, attempts, updated_at, version
  FROM ${VISITS_TABLE} WHERE fleet_id IN (SELECT value FROM json_each(?))`;

const PURGE_SQL = `DELETE FROM ${VISITS_TABLE} WHERE fleet_id IN (
  SELECT v.fleet_id FROM ${VISITS_TABLE} v LEFT JOIN virtual_fleets f ON f.fleet_id = v.fleet_id
  WHERE v.system_id = ? AND v.fleet_id <> ?
    AND (f.fleet_id IS NULL OR f.state = ? OR f.current_system_id <> v.system_id OR f.leg_seq <> v.leg_seq)
  ORDER BY v.fleet_id LIMIT ?)`;

function recordArrivalInTx(tx, v) {
  if (!v || typeof v !== "object") return invalid("visit");
  if (!isFleetId(v.fleetId)) return invalid("fleetId");
  if (!isPosInt(v.systemId)) return invalid("systemId");
  if (!isNonNegInt(v.legSeq)) return invalid("legSeq");
  if (!isNonNegInt(v.at)) return invalid("at");
  if (!VIA_VALUES.includes(v.via)) return invalid("via");
  const from = v.fromSystemId === undefined ? null : v.fromSystemId;
  if (from !== null && !isPosInt(from)) return invalid("fromSystemId");
  if (v.via === VIA.GATE && from === null) return invalid("fromSystemId");
  if (v.via === VIA.NONE && from !== null) return invalid("fromSystemId");
  const info = tx.prepare(UPSERT_SQL).run(v.fleetId, v.systemId, v.legSeq, v.at, v.via, from, v.at);
  return { ok: true, written: Number(info.changes) > 0 };
}

function rowOf(r) {
  return Object.freeze({ fleetId: r.fleet_id, systemId: Number(r.system_id), legSeq: Number(r.leg_seq),
    arrivedAt: Number(r.arrived_at), enteredVia: r.entered_via, entryFromSystemId: numOrNull(r.entry_from_system_id),
    moveSeq: Number(r.move_seq), atKind: r.at_kind ?? null, atId: numOrNull(r.at_id), toKind: r.to_kind ?? null,
    toId: numOrNull(r.to_id), departAt: numOrNull(r.depart_at), arriveAt: numOrNull(r.arrive_at),
    purpose: r.purpose ?? null, targetFleetId: r.target_fleet_id ?? null, attempts: Number(r.attempts),
    updatedAt: Number(r.updated_at), version: Number(r.version) });
}

function getManyInTx(tx, fleetIds) {
  if (!Array.isArray(fleetIds) || !fleetIds.every(isFleetId)) return invalid("fleetIds");
  const visits = new Map();
  if (fleetIds.length === 0) return { ok: true, visits };
  for (const r of tx.prepare(SELECT_MANY_SQL).all(JSON.stringify(fleetIds))) visits.set(r.fleet_id, rowOf(r));
  return { ok: true, visits };
}

const MOVE_UPDATE_SQL = `UPDATE ${VISITS_TABLE} SET move_seq = move_seq + 1, at_kind = ?, at_id = ?, to_kind = ?,
  to_id = ?, depart_at = ?, arrive_at = ?, purpose = ?, target_fleet_id = ?, attempts = ?, updated_at = ?,
  version = version + 1
  WHERE fleet_id = ? AND system_id = ? AND leg_seq = ? AND move_seq = ?`;

const MOVE_FRESH_SQL = `INSERT INTO ${VISITS_TABLE} (fleet_id, system_id, leg_seq, arrived_at, entered_via,
  entry_from_system_id, move_seq, at_kind, at_id, to_kind, to_id, depart_at, arrive_at, purpose, target_fleet_id,
  attempts, updated_at, version)
  VALUES (?, ?, ?, ?, 'NONE', NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
  ON CONFLICT (fleet_id) DO UPDATE SET system_id = excluded.system_id, leg_seq = excluded.leg_seq,
    arrived_at = excluded.arrived_at, entered_via = 'NONE', entry_from_system_id = NULL, move_seq = excluded.move_seq,
    at_kind = excluded.at_kind, at_id = excluded.at_id, to_kind = excluded.to_kind, to_id = excluded.to_id,
    depart_at = excluded.depart_at, arrive_at = excluded.arrive_at, purpose = excluded.purpose,
    target_fleet_id = excluded.target_fleet_id, attempts = excluded.attempts, updated_at = excluded.updated_at,
    version = version + 1
  WHERE NOT (system_id = excluded.system_id AND leg_seq = excluded.leg_seq)`;

const PURPOSE_VALUES = Object.freeze(Object.values(PURPOSE));
const isAnchorRef = (a) => Boolean(a) && typeof a === "object" && ANCHOR_KINDS.includes(a.kind) && isPosInt(a.id);

function writeMoveInTx(tx, m) {
  if (!m || typeof m !== "object") return invalid("move");
  if (!isFleetId(m.fleetId)) return invalid("fleetId");
  if (!isPosInt(m.systemId)) return invalid("systemId");
  if (!isNonNegInt(m.legSeq)) return invalid("legSeq");
  if (typeof m.fresh !== "boolean") return invalid("fresh");
  if (!m.fresh && !isNonNegInt(m.expectedMoveSeq)) return invalid("expectedMoveSeq");
  if (m.fresh && !isPosInt(m.moveSeq)) return invalid("moveSeq");
  if (!isAnchorRef(m.at)) return invalid("at");
  if (!isAnchorRef(m.to)) return invalid("to");
  if (!isNonNegInt(m.departAt)) return invalid("departAt");
  if (!isNonNegInt(m.arriveAt) || m.arriveAt < m.departAt) return invalid("arriveAt");
  if (!PURPOSE_VALUES.includes(m.purpose)) return invalid("purpose");
  const target = m.targetFleetId === undefined ? null : m.targetFleetId;
  if (target !== null && !isFleetId(target)) return invalid("targetFleetId");
  const attempts = m.attempts === undefined ? 0 : m.attempts;
  if (!isNonNegInt(attempts)) return invalid("attempts");
  const move = [m.at.kind, m.at.id, m.to.kind, m.to.id, m.departAt, m.arriveAt, m.purpose, target, attempts,
    m.departAt];
  if (m.fresh) {
    const info = tx.prepare(MOVE_FRESH_SQL).run(m.fleetId, m.systemId, m.legSeq, m.departAt, m.moveSeq, ...move);
    return { ok: true, written: Number(info.changes) > 0, moveSeq: m.moveSeq };
  }
  const info = tx.prepare(MOVE_UPDATE_SQL).run(...move, m.fleetId, m.systemId, m.legSeq, m.expectedMoveSeq);
  return { ok: true, written: Number(info.changes) > 0, moveSeq: m.expectedMoveSeq + 1 };
}

function purgeStaleInSystemInTx(tx, systemId, keepFleetId, limit) {
  if (!isPosInt(systemId)) return invalid("systemId");
  if (keepFleetId !== null && !isFleetId(keepFleetId)) return invalid("keepFleetId");
  if (!isNonNegInt(limit)) return invalid("limit");
  if (limit === 0) return { ok: true, purged: 0 };
  const info = tx.prepare(PURGE_SQL).run(systemId, keepFleetId === null ? "" : keepFleetId, DESTROYED, limit);
  return { ok: true, purged: Number(info.changes) };
}

const PLACE_SQL = `UPDATE ${VISITS_TABLE} SET at_kind = ?, at_id = ?, updated_at = ?, version = version + 1
  WHERE fleet_id = ? AND system_id = ? AND leg_seq = ? AND at_kind IS NULL AND to_kind IS NULL`;

function placeAtInTx(tx, v) {
  if (!v || typeof v !== "object") return invalid("place");
  if (!isFleetId(v.fleetId)) return invalid("fleetId");
  if (!isPosInt(v.systemId)) return invalid("systemId");
  if (!isNonNegInt(v.legSeq)) return invalid("legSeq");
  if (!isAnchorRef(v.anchor)) return invalid("anchor");
  if (!isNonNegInt(v.at)) return invalid("at");
  const info = tx.prepare(PLACE_SQL).run(v.anchor.kind, v.anchor.id, v.at, v.fleetId, v.systemId, v.legSeq);
  return { ok: true, placed: Number(info.changes) > 0 };
}

module.exports = { recordArrivalInTx, getManyInTx, purgeStaleInSystemInTx, writeMoveInTx, placeAtInTx };
