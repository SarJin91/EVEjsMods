"use strict";

const { toBind } = require("../persistence/repository");
const {
  INTEL_TABLE_NAME, INTEL_AGGREGATE, EVENT_INTEL_OBSERVED, MAX_INTEL_STRENGTH, MAX_INTEL_SOURCE_LENGTH, MAX_KEY_LENGTH,
} = require("./schema");

const COLUMNS = "faction_id, system_id, observed_at, controller_faction_id, hostile_fleets, hostile_ships, "
  + "hostile_strength, hostile_stations, source, updated_at, version";
const OBS_FIELDS = Object.freeze(["factionId", "systemId", "observedAt", "controllerFactionId", "hostileFleets",
  "hostileShips", "hostileStrength", "hostileStations", "source"]);
const TX_REQUIRED = Object.freeze({ ok: false, reason: "TX_REQUIRED" });

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const isCount = (v) => Number.isSafeInteger(v) && v >= 0;
const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const invalid = (detail) => ({ ok: false, reason: "INVALID_INPUT", detail });

function toRecord(row) {
  return Object.freeze({
    factionId: row.faction_id,
    systemId: row.system_id,
    observedAt: row.observed_at,
    controllerFactionId: row.controller_faction_id,
    hostileFleets: row.hostile_fleets,
    hostileShips: row.hostile_ships,
    hostileStrength: row.hostile_strength,
    hostileStations: row.hostile_stations,
    source: row.source,
    updatedAt: row.updated_at,
    version: row.version,
  });
}

function createIntelRepository(deps) {
  if (!deps || typeof deps !== "object") throw new TypeError("createIntelRepository: deps missing");
  const { journal, limits, onCount } = deps;
  if (!journal || typeof journal.applyOnce !== "function") {
    throw new TypeError("createIntelRepository: journal with applyOnce required");
  }
  for (const name of ["maxIntelRowsPerFaction", "maxListLimit"]) {
    if (!limits || !Number.isSafeInteger(limits[name]) || limits[name] < 1) {
      throw new TypeError(`createIntelRepository: limits.${name} must be a positive integer`);
    }
  }
  const L = Object.freeze({ maxIntelRowsPerFaction: limits.maxIntelRowsPerFaction, maxListLimit: limits.maxListLimit });
  let changeCount = 0;
  const count = (name) => {
    if (typeof onCount !== "function") return;
    try {
      onCount(name, 1);
    } catch (_err) {
    }
  };

  const perDb = new WeakMap();
  function stmts(db) {
    let s = perDb.get(db);
    if (s) return s;
    const T = INTEL_TABLE_NAME;
    s = {
      byKey: db.prepare(`SELECT ${COLUMNS} FROM ${T} WHERE faction_id = ? AND system_id = ?`),
      countOf: db.prepare(`SELECT count(*) AS n FROM ${T} WHERE faction_id = ?`),
      list: db.prepare(`SELECT ${COLUMNS} FROM ${T} WHERE faction_id = ?
        AND system_id IN (SELECT value FROM json_each(?)) ORDER BY system_id`),
      insert: db.prepare(`INSERT INTO ${T} (${COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`),
      update: db.prepare(`UPDATE ${T} SET observed_at = ?, controller_faction_id = ?, hostile_fleets = ?,
        hostile_ships = ?, hostile_strength = ?, hostile_stations = ?, source = ?, updated_at = ?, version = version + 1
        WHERE faction_id = ? AND system_id = ? AND version = ?`),
    };
    perDb.set(db, s);
    return s;
  }

  function validate(obs) {
    if (!isPlainObject(obs)) return "obs";
    for (const key of Object.keys(obs)) if (!OBS_FIELDS.includes(key)) return `obs.${key}`;
    if (!isId(obs.factionId)) return "obs.factionId";
    if (!isId(obs.systemId)) return "obs.systemId";
    if (!isCount(obs.observedAt)) return "obs.observedAt";
    if (!(obs.controllerFactionId === null || isId(obs.controllerFactionId))) return "obs.controllerFactionId";
    for (const k of ["hostileFleets", "hostileShips", "hostileStations"]) if (!isCount(obs[k])) return `obs.${k}`;
    if (!isCount(obs.hostileStrength) || obs.hostileStrength > MAX_INTEL_STRENGTH) return "obs.hostileStrength";
    if (typeof obs.source !== "string" || obs.source.length < 1 || obs.source.length > MAX_INTEL_SOURCE_LENGTH) {
      return "obs.source";
    }
    return null;
  }

  function upsertObservation(tx, obs, key) {
    if (!tx || tx.inTransaction !== true) return TX_REQUIRED;
    const bad = validate(obs);
    if (bad !== null) return invalid(bad);
    if (typeof key !== "string" || key.length < 1 || key.length > MAX_KEY_LENGTH) return invalid("key");
    const payload = Object.fromEntries(OBS_FIELDS.map((k) => [k, obs[k]]));
    const result = journal.applyOnce(tx, { key, aggregate: { type: INTEL_AGGREGATE, id: `${obs.factionId}:${obs.systemId}` },
      eventType: EVENT_INTEL_OBSERVED, payload }, (db) => {
      const s = stmts(db);
      const f = toBind(obs.factionId);
      const sys = toBind(obs.systemId);
      const row = s.byKey.get(f, sys);
      const values = [toBind(obs.observedAt), toBind(obs.controllerFactionId), toBind(obs.hostileFleets),
        toBind(obs.hostileShips), toBind(obs.hostileStrength), toBind(obs.hostileStations), obs.source,
        toBind(obs.observedAt)];
      if (row) {
        const r = s.update.run(...values, f, sys, toBind(row.version));
        if (r.changes !== 1) return { ok: false, reason: "VERSION_CONFLICT" };
      } else {
        const n = s.countOf.get(f).n;
        if (n >= L.maxIntelRowsPerFaction) return { ok: false, reason: "INTEL_LIMIT", limit: L.maxIntelRowsPerFaction };
        s.insert.run(f, sys, ...values);
      }
      return { ok: true, record: toRecord(s.byKey.get(f, sys)) };
    });
    if (!result.ok) {
      const refusal = result.reason === "APPLY_REFUSED" ? result.refusal : result;
      if (refusal.reason === "INTEL_LIMIT") count("strategy.intel.limit");
      return refusal;
    }
    if (result.duplicate) return { ok: true, duplicate: true };
    changeCount += 1;
    count("strategy.intel.observed");
    return { ok: true, duplicate: false, record: result.value.record };
  }

  function listIntel(tx, factionId, systemIds) {
    if (!tx || tx.inTransaction !== true) return TX_REQUIRED;
    if (!isId(factionId)) return invalid("factionId");
    if (!Array.isArray(systemIds) || !systemIds.every(isId)) return invalid("systemIds");
    const ids = [...new Set(systemIds)].sort((a, b) => a - b);
    if (ids.length > L.maxListLimit) return { ok: false, reason: "BATCH_TOO_LARGE", count: ids.length,
      limit: L.maxListLimit };
    if (ids.length === 0) return { ok: true, records: [] };
    return { ok: true, records: stmts(tx).list.all(toBind(factionId), JSON.stringify(ids)).map(toRecord) };
  }

  function countOf(tx, factionId) {
    if (!tx || tx.inTransaction !== true) return TX_REQUIRED;
    if (!isId(factionId)) return invalid("factionId");
    return { ok: true, count: stmts(tx).countOf.get(toBind(factionId)).n };
  }

  return Object.freeze({ upsertObservation, listIntel, countOf, getChangeCount: () => changeCount, limits: L });
}

module.exports = { createIntelRepository };
