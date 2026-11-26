"use strict";

const S = require("./schema");

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const isTime = (v) => Number.isSafeInteger(v) && v >= 0;
const isIndex = (v) => Number.isSafeInteger(v) && v >= 0;
const isText = (v, max) => typeof v === "string" && v.length >= 1 && v.length <= max;
const invalid = (detail) => ({ ok: false, reason: "INVALID_INPUT", detail });

function toSighting(row) {
  return Object.freeze({
    sightingId: Number(row.sighting_id),
    systemId: Number(row.system_id),
    fleetId: row.fleet_id,
    legSeq: Number(row.leg_seq),
    systemIndex: Number(row.system_index),
    factionId: Number(row.faction_id),
    fleetRole: row.fleet_role,
    sizeClass: row.size_class,
    fromSystemId: row.from_system_id === null ? null : Number(row.from_system_id),
    toSystemId: row.to_system_id === null ? null : Number(row.to_system_id),
    seenAt: Number(row.seen_at),
    createdAt: Number(row.created_at),
  });
}

function createSightingRepository() {
  function findInTx(db, k) {
    const o = k || {};
    if (!db) return invalid("db");
    if (!isId(o.systemId)) return invalid("systemId");
    if (!isText(o.fleetId, S.MAX_FLEET_ID)) return invalid("fleetId");
    if (!isIndex(o.legSeq)) return invalid("legSeq");
    const row = db.prepare(`SELECT * FROM ${S.TABLE} WHERE system_id = ? AND fleet_id = ? AND leg_seq = ?`)
      .get(o.systemId, o.fleetId, o.legSeq);
    return { ok: true, sighting: row ? toSighting(row) : null };
  }

  function insertInTx(db, s, now) {
    const o = s || {};
    if (!db) return invalid("db");
    if (!isId(o.systemId)) return invalid("systemId");
    if (!isText(o.fleetId, S.MAX_FLEET_ID)) return invalid("fleetId");
    if (!isIndex(o.legSeq)) return invalid("legSeq");
    if (!isIndex(o.systemIndex)) return invalid("systemIndex");
    if (!isId(o.factionId)) return invalid("factionId");
    if (!isText(o.fleetRole, S.MAX_FLEET_ROLE)) return invalid("fleetRole");
    if (!S.SIZE_CLASSES.includes(o.sizeClass)) return invalid("sizeClass");
    if (o.fromSystemId !== null && !isId(o.fromSystemId)) return invalid("fromSystemId");
    if (o.toSystemId !== null && !isId(o.toSystemId)) return invalid("toSystemId");
    if (!isTime(o.seenAt)) return invalid("seenAt");
    if (!isTime(now)) return invalid("now");
    const seen = db.prepare(`SELECT sighting_id FROM ${S.TABLE} WHERE system_id = ? AND fleet_id = ? AND leg_seq = ?`)
      .get(o.systemId, o.fleetId, o.legSeq);
    if (seen) return { ok: true, duplicate: true };
    db.prepare(`INSERT INTO ${S.TABLE} (system_id, fleet_id, leg_seq, system_index, faction_id, fleet_role, size_class,
      from_system_id, to_system_id, seen_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(o.systemId, o.fleetId, o.legSeq, o.systemIndex, o.factionId, o.fleetRole, o.sizeClass, o.fromSystemId,
        o.toSystemId, o.seenAt, now);
    return { ok: true, duplicate: false };
  }

  function pruneInTx(db, q) {
    const o = q || {};
    if (!db) return invalid("db");
    if (!isTime(o.before)) return invalid("before");
    if (!isId(o.batch)) return invalid("batch");
    const r = db.prepare(`DELETE FROM ${S.TABLE} WHERE sighting_id IN (SELECT sighting_id FROM ${S.TABLE}
      WHERE seen_at < ? ORDER BY seen_at, sighting_id LIMIT ?)`).run(o.before, o.batch);
    return { ok: true, deleted: Number(r.changes) };
  }

  function systemListOf(v) {
    return Array.isArray(v) && v.length >= 1 && v.length <= S.MAX_QUERY_SYSTEMS && v.every(isId) ? v : null;
  }

  function listMarkersInTx(db, q) {
    const o = q || {};
    if (!db) return invalid("db");
    const systemIds = systemListOf(o.systemIds);
    if (!systemIds) return invalid("systemIds");
    if (!isTime(o.since)) return invalid("since");
    if (!isId(o.limit)) return invalid("limit");
    const rows = db.prepare(`SELECT system_id, faction_id, size_class, COUNT(*) AS n, MAX(seen_at) AS last
      FROM ${S.TABLE} WHERE system_id IN (SELECT value FROM json_each(?)) AND seen_at >= ?
      GROUP BY system_id, faction_id, size_class ORDER BY last DESC, system_id, faction_id, size_class LIMIT ?`)
      .all(JSON.stringify(systemIds), o.since, o.limit);
    return { ok: true, markers: rows.map((r) => Object.freeze({ systemId: Number(r.system_id),
      factionId: Number(r.faction_id), sizeClass: r.size_class, count: Number(r.n), lastSeenAt: Number(r.last) })) };
  }

  function countBySystemSinceInTx(db, q) {
    const o = q || {};
    if (!db) return invalid("db");
    const systemIds = systemListOf(o.systemIds);
    if (!systemIds) return invalid("systemIds");
    if (!isTime(o.since)) return invalid("since");
    const rows = db.prepare(`SELECT system_id, COUNT(*) AS n FROM ${S.TABLE}
      WHERE system_id IN (SELECT value FROM json_each(?)) AND seen_at >= ? GROUP BY system_id`)
      .all(JSON.stringify(systemIds), o.since);
    return { ok: true, counts: new Map(rows.map((r) => [Number(r.system_id), Number(r.n)])) };
  }

  return Object.freeze({ findInTx, insertInTx, pruneInTx, listMarkersInTx, countBySystemSinceInTx });
}

module.exports = { createSightingRepository, toSighting };
