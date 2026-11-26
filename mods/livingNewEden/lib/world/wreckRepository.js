"use strict";

const { defineTable, updateWithVersion, toBind } = require("../persistence/repository");
const { stableJson } = require("../util/fingerprint");
const {
  WRECK_TABLE_NAME, WRECK_AGGREGATE, WRECK_ACTIVE, WRECK_EXPIRED, END_REASONS, MAX_FIELD_ID_LENGTH,
  MAX_BATTLE_ID_LENGTH, MAX_ENUM_LENGTH, MAX_UNITS, PPM,
} = require("./wreckSchema");

const TX_REQUIRED = Object.freeze({ ok: false, reason: "TX_REQUIRED" });
const txMissing = (tx) => !tx || tx.inTransaction !== true;
const isText = (v, max) => typeof v === "string" && v.length >= 1 && v.length <= max;
const isTime = (v) => Number.isSafeInteger(v) && v >= 0;
const isPositiveInt = (v) => Number.isSafeInteger(v) && v > 0;
const isUnits = (v) => Number.isSafeInteger(v) && v >= 0 && v <= MAX_UNITS;
const invalid = (detail) => ({ ok: false, reason: "WRECK_INVALID_INPUT", detail });
const unwrap = (r) => (r && r.reason === "APPLY_REFUSED" && r.refusal ? r.refusal : r);

const WRECK_TABLE = defineTable({
  name: WRECK_TABLE_NAME,
  idColumn: "field_id",
  columns: ["state", "end_reason", "ended_at", "updated_at", "salvaged_salvage_units", "salvaged_loot_units",
    "materialized_at"],
});

const COLUMNS = "field_id, battle_id, source, system_id, environment, outcome, winner_faction_id, state, end_reason, "
  + "ships_lost, composition_json, salvage_units, loot_units, salvaged_salvage_units, salvaged_loot_units, "
  + "decay_floor_ppm, materialized_at, created_at, expires_at, ended_at, updated_at, version";
const LIST_COLUMNS = COLUMNS;

function toField(row, parseComposition) {
  if (!row) return null;
  return Object.freeze({
    fieldId: row.field_id,
    battleId: row.battle_id,
    source: row.source,
    systemId: row.system_id,
    environment: row.environment,
    outcome: row.outcome,
    winnerFactionId: row.winner_faction_id,
    state: row.state,
    endReason: row.end_reason,
    shipsLost: row.ships_lost,
    ...(parseComposition ? { composition: JSON.parse(row.composition_json) }
      : { compositionJson: row.composition_json }),
    salvageUnits: row.salvage_units,
    lootUnits: row.loot_units,
    salvagedSalvageUnits: row.salvaged_salvage_units,
    salvagedLootUnits: row.salvaged_loot_units,
    decayFloorPpm: row.decay_floor_ppm,
    materializedAt: row.materialized_at,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    endedAt: row.ended_at,
    updatedAt: row.updated_at,
    version: row.version,
  });
}

function checkField(f) {
  if (!f || typeof f !== "object") return "field";
  if (!isText(f.fieldId, MAX_FIELD_ID_LENGTH)) return "fieldId";
  if (f.battleId !== null && !isText(f.battleId, MAX_BATTLE_ID_LENGTH)) return "battleId";
  if (!isText(f.source, MAX_ENUM_LENGTH)) return "source";
  if (!isPositiveInt(f.systemId)) return "systemId";
  if (!isText(f.environment, MAX_ENUM_LENGTH)) return "environment";
  if (f.outcome !== null && !isText(f.outcome, MAX_ENUM_LENGTH)) return "outcome";
  if (f.winnerFactionId !== null && !isPositiveInt(f.winnerFactionId)) return "winnerFactionId";
  if (!isPositiveInt(f.shipsLost)) return "shipsLost";
  if (!Array.isArray(f.composition)) return "composition";
  if (!isUnits(f.salvageUnits)) return "salvageUnits";
  if (!isUnits(f.lootUnits)) return "lootUnits";
  if (!Number.isSafeInteger(f.decayFloorPpm) || f.decayFloorPpm < 0 || f.decayFloorPpm > PPM) return "decayFloorPpm";
  if (!isTime(f.createdAt)) return "createdAt";
  if (!Number.isSafeInteger(f.expiresAt) || f.expiresAt <= f.createdAt) return "expiresAt";
  return null;
}

function createWreckRepository(deps) {
  if (!deps || typeof deps !== "object") throw new TypeError("createWreckRepository: deps missing");
  const { journal, onCount } = deps;
  if (!journal || typeof journal.applyOnce !== "function") {
    throw new TypeError("createWreckRepository: journal with applyOnce required");
  }
  if (onCount !== undefined && typeof onCount !== "function") {
    throw new TypeError("createWreckRepository: onCount must be a function");
  }
  const count = (name) => {
    if (!onCount) return;
    try {
      onCount(name, 1);
    } catch (_err) {
    }
  };

  const perDb = new WeakMap();
  function stmts(db) {
    let s = perDb.get(db);
    if (s) return s;
    const T = WRECK_TABLE_NAME;
    s = {
      byId: db.prepare(`SELECT ${COLUMNS} FROM ${T} WHERE field_id = ?`),
      byBattle: db.prepare(`SELECT field_id FROM ${T} WHERE battle_id = ?`),
      insert: db.prepare(`INSERT INTO ${T} (field_id, battle_id, source, system_id, environment, outcome,
        winner_faction_id, state, end_reason, ships_lost, composition_json, salvage_units, loot_units,
        decay_floor_ppm, created_at, expires_at, ended_at, updated_at, version)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 1)`),
      countAll: db.prepare(`SELECT count(*) AS n FROM ${T} WHERE state = ?`),
      countSystem: db.prepare(`SELECT count(*) AS n FROM ${T} WHERE state = ? AND system_id = ?`),
      countWithPool: db.prepare(`SELECT count(*) AS n FROM ${T} WHERE state = ? AND system_id = ? AND expires_at > ?
        AND (salvaged_salvage_units < salvage_units OR salvaged_loot_units < loot_units)`),
      oldestAll: db.prepare(`SELECT ${COLUMNS} FROM ${T} WHERE state = ? ORDER BY expires_at, field_id LIMIT 1`),
      oldestSystem: db.prepare(`SELECT ${COLUMNS} FROM ${T} WHERE state = ? AND system_id = ?`),
      listActive: db.prepare(`SELECT ${LIST_COLUMNS} FROM ${T} WHERE state = ? AND expires_at > ?
        ORDER BY expires_at, field_id LIMIT ?`),
      unmaterialized: db.prepare(`SELECT ${COLUMNS} FROM ${T} WHERE state = ? AND system_id = ? AND expires_at > ?
        AND materialized_at IS NULL ORDER BY expires_at, field_id LIMIT ?`),
      endedSince: db.prepare(`SELECT end_reason, count(*) AS n FROM ${T} WHERE state = ? AND expires_at > ?
        GROUP BY end_reason`),
    };
    perDb.set(db, s);
    return s;
  }

  function insertInTx(tx, field, idempotencyKey) {
    if (txMissing(tx)) return TX_REQUIRED;
    const bad = checkField(field);
    if (bad) return invalid(bad);
    let compositionJson;
    try {
      compositionJson = stableJson(field.composition);
    } catch (err) {
      return invalid(`composition: ${(err && err.message) || err}`);
    }
    const payload = { fieldId: field.fieldId, battleId: field.battleId, systemId: field.systemId,
      createdAt: field.createdAt, expiresAt: field.expiresAt, shipsLost: field.shipsLost,
      salvageUnits: field.salvageUnits, lootUnits: field.lootUnits };
    const result = journal.applyOnce(tx, { key: idempotencyKey, aggregate: { type: WRECK_AGGREGATE, id: field.fieldId },
      eventType: "WRECK_FIELD_CREATED", payload }, (db) => {
      const s = stmts(db);
      if (s.byId.get(field.fieldId)) return { ok: false, reason: "FIELD_EXISTS", fieldId: field.fieldId };
      if (field.battleId !== null && s.byBattle.get(field.battleId)) {
        return { ok: false, reason: "FIELD_EXISTS", battleId: field.battleId };
      }
      s.insert.run(field.fieldId, field.battleId, field.source, toBind(field.systemId), field.environment,
        field.outcome, toBind(field.winnerFactionId), WRECK_ACTIVE, toBind(field.shipsLost), compositionJson,
        toBind(field.salvageUnits), toBind(field.lootUnits), toBind(field.decayFloorPpm), toBind(field.createdAt),
        toBind(field.expiresAt), toBind(field.createdAt));
      return { ok: true };
    });
    if (!result.ok) return unwrap(result);
    if (result.duplicate) return { ok: true, duplicate: true, journalId: result.journalId };
    count("world.wrecks.inserted");
    return { ok: true, duplicate: false, fieldId: field.fieldId, journalId: result.journalId };
  }

  function transitionInTx(tx, change, idempotencyKey) {
    if (txMissing(tx)) return TX_REQUIRED;
    const c = change || {};
    if (!isText(c.fieldId, MAX_FIELD_ID_LENGTH)) return invalid("fieldId");
    if (!Number.isSafeInteger(c.expectedVersion) || c.expectedVersion < 1) return invalid("expectedVersion");
    if (c.from !== WRECK_ACTIVE || c.to !== WRECK_EXPIRED) return invalid("from/to");
    if (!END_REASONS.includes(c.endReason)) return invalid("endReason");
    if (!isTime(c.at)) return invalid("at");
    const payload = { fieldId: c.fieldId, from: c.from, to: c.to, endReason: c.endReason, at: c.at };
    const result = journal.applyOnce(tx, { key: idempotencyKey, aggregate: { type: WRECK_AGGREGATE, id: c.fieldId },
      eventType: "WRECK_FIELD_TRANSITION", payload }, (db) => {
      const row = stmts(db).byId.get(c.fieldId);
      if (!row) return { ok: false, reason: "NOT_FOUND", fieldId: c.fieldId };
      if (row.state !== c.from) return { ok: false, reason: "WRONG_STATE", expected: c.from, actual: row.state };
      if (row.version !== c.expectedVersion) {
        return { ok: false, reason: "VERSION_CONFLICT", expectedVersion: c.expectedVersion,
          actualVersion: row.version };
      }
      const written = updateWithVersion(db, WRECK_TABLE, c.fieldId, c.expectedVersion,
        { state: c.to, end_reason: c.endReason, ended_at: c.at, updated_at: c.at });
      if (!written.ok) return written;
      return { ok: true, version: written.version };
    });
    if (!result.ok) return unwrap(result);
    if (result.duplicate) return { ok: true, duplicate: true, journalId: result.journalId };
    count("world.wrecks.transition");
    return { ok: true, duplicate: false, version: result.value.version, journalId: result.journalId };
  }

  function recordSalvageInTx(tx, change, idempotencyKey) {
    if (txMissing(tx)) return TX_REQUIRED;
    const c = change || {};
    if (!isText(c.fieldId, MAX_FIELD_ID_LENGTH)) return invalid("fieldId");
    if (!Number.isSafeInteger(c.expectedVersion) || c.expectedVersion < 1) return invalid("expectedVersion");
    if (!isUnits(c.salvageUnits)) return invalid("salvageUnits");
    if (!isUnits(c.lootUnits)) return invalid("lootUnits");
    if (!isTime(c.at)) return invalid("at");
    const payload = { fieldId: c.fieldId, salvageUnits: c.salvageUnits, lootUnits: c.lootUnits, at: c.at };
    const result = journal.applyOnce(tx, { key: idempotencyKey, aggregate: { type: WRECK_AGGREGATE, id: c.fieldId },
      eventType: "WRECK_FIELD_SALVAGED", payload }, (db) => {
      const row = stmts(db).byId.get(c.fieldId);
      if (!row) return { ok: false, reason: "NOT_FOUND", fieldId: c.fieldId };
      if (row.state !== WRECK_ACTIVE) return { ok: false, reason: "WRONG_STATE", expected: WRECK_ACTIVE,
        actual: row.state };
      if (row.version !== c.expectedVersion) {
        return { ok: false, reason: "VERSION_CONFLICT", expectedVersion: c.expectedVersion,
          actualVersion: row.version };
      }
      if (c.salvageUnits > row.salvage_units || c.lootUnits > row.loot_units
        || c.salvageUnits < row.salvaged_salvage_units || c.lootUnits < row.salvaged_loot_units) {
        return { ok: false, reason: "WRECK_INVALID_INPUT", detail: "salvaged totals" };
      }
      const written = updateWithVersion(db, WRECK_TABLE, c.fieldId, c.expectedVersion,
        { salvaged_salvage_units: c.salvageUnits, salvaged_loot_units: c.lootUnits, updated_at: c.at });
      if (!written.ok) return written;
      return { ok: true, version: written.version };
    });
    if (!result.ok) return unwrap(result);
    if (result.duplicate) return { ok: true, duplicate: true, journalId: result.journalId };
    count("world.wrecks.salvaged");
    return { ok: true, duplicate: false, version: result.value.version, journalId: result.journalId };
  }

  function claimForAnomalyInTx(tx, change, idempotencyKey) {
    if (txMissing(tx)) return TX_REQUIRED;
    const c = change || {};
    if (!isText(c.fieldId, MAX_FIELD_ID_LENGTH)) return invalid("fieldId");
    if (!Number.isSafeInteger(c.expectedVersion) || c.expectedVersion < 1) return invalid("expectedVersion");
    if (!isTime(c.at)) return invalid("at");
    const payload = { fieldId: c.fieldId };
    const result = journal.applyOnce(tx, { key: idempotencyKey, aggregate: { type: WRECK_AGGREGATE, id: c.fieldId },
      eventType: "WRECK_FIELD_MATERIALIZED", payload }, (db) => {
      const row = stmts(db).byId.get(c.fieldId);
      if (!row) return { ok: false, reason: "NOT_FOUND", fieldId: c.fieldId };
      if (row.state !== WRECK_ACTIVE || row.expires_at <= c.at) {
        return { ok: false, reason: "WRONG_STATE", expected: WRECK_ACTIVE, actual: row.state };
      }
      if (row.materialized_at !== null) return { ok: false, reason: "ALREADY_MATERIALIZED", fieldId: c.fieldId };
      if (row.version !== c.expectedVersion) {
        return { ok: false, reason: "VERSION_CONFLICT", expectedVersion: c.expectedVersion,
          actualVersion: row.version };
      }
      const written = updateWithVersion(db, WRECK_TABLE, c.fieldId, c.expectedVersion,
        { salvaged_salvage_units: row.salvage_units, salvaged_loot_units: row.loot_units, materialized_at: c.at,
          updated_at: c.at });
      if (!written.ok) return written;
      return { ok: true, version: written.version };
    });
    if (!result.ok) return unwrap(result);
    if (result.duplicate) return { ok: true, duplicate: true, journalId: result.journalId };
    count("world.wrecks.materialized");
    return { ok: true, duplicate: false, version: result.value.version, journalId: result.journalId };
  }

  function listUnmaterializedInSystem(tx, opts) {
    if (txMissing(tx)) return TX_REQUIRED;
    const o = opts || {};
    if (!isPositiveInt(o.systemId)) return invalid("systemId");
    if (!isTime(o.at)) return invalid("at");
    if (!isPositiveInt(o.limit)) return invalid("limit");
    const rows = stmts(tx).unmaterialized.all(WRECK_ACTIVE, toBind(o.systemId), toBind(o.at), toBind(o.limit));
    return { ok: true, fields: rows.map((r) => toField(r, true)) };
  }

  function get(tx, fieldId) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isText(fieldId, MAX_FIELD_ID_LENGTH)) return invalid("fieldId");
    return { ok: true, field: toField(stmts(tx).byId.get(fieldId), true) };
  }

  const hasSystem = (opts) => opts && opts.systemId !== undefined && opts.systemId !== null;

  function countActive(tx, opts) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (hasSystem(opts) && !isPositiveInt(opts.systemId)) return invalid("systemId");
    const s = stmts(tx);
    const row = hasSystem(opts) ? s.countSystem.get(WRECK_ACTIVE, toBind(opts.systemId)) : s.countAll.get(WRECK_ACTIVE);
    return { ok: true, count: row.n };
  }

  function countWithPoolInSystem(tx, opts) {
    if (txMissing(tx)) return TX_REQUIRED;
    const o = opts || {};
    if (!isPositiveInt(o.systemId)) return invalid("systemId");
    if (!isTime(o.at)) return invalid("at");
    const row = stmts(tx).countWithPool.get(WRECK_ACTIVE, toBind(o.systemId), toBind(o.at));
    return { ok: true, count: Number(row.n) };
  }

  function oldestActive(tx, opts) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (hasSystem(opts) && !isPositiveInt(opts.systemId)) return invalid("systemId");
    const s = stmts(tx);
    const row = hasSystem(opts) ? s.oldestSystem.get(WRECK_ACTIVE, toBind(opts.systemId))
      : s.oldestAll.get(WRECK_ACTIVE);
    return { ok: true, field: toField(row, false) };
  }

  function listActive(tx, opts) {
    if (txMissing(tx)) return TX_REQUIRED;
    const at = opts && opts.at;
    const limit = opts && opts.limit;
    if (!isTime(at)) return invalid("at");
    if (!isPositiveInt(limit)) return invalid("limit");
    const rows = stmts(tx).listActive.all(WRECK_ACTIVE, toBind(at), toBind(limit + 1));
    const truncated = rows.length > limit;
    return { ok: true, fields: rows.slice(0, limit).map((r) => toField(r, false)), truncated };
  }

  function countEndedSince(tx, opts) {
    if (txMissing(tx)) return TX_REQUIRED;
    const since = opts && opts.since;
    if (!Number.isSafeInteger(since)) return invalid("since");
    const byReason = {};
    for (const r of stmts(tx).endedSince.all(WRECK_EXPIRED, toBind(since))) {
      byReason[r.end_reason === null ? "-" : String(r.end_reason)] = Number(r.n);
    }
    return { ok: true, byReason };
  }

  return Object.freeze({ insertInTx, transitionInTx, recordSalvageInTx, claimForAnomalyInTx, get, countActive,
    countWithPoolInSystem, oldestActive, listActive, listUnmaterializedInSystem, countEndedSince });
}

module.exports = { createWreckRepository, WRECK_TABLE };
