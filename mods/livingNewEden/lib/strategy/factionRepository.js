"use strict";

const { defineTable, updateWithVersion, toBind } = require("../persistence/repository");
const { KIND_APPLY } = require("../persistence/journal");
const {
  FACTIONS_TABLE_NAME, FACTION_AGGREGATE, FACTION_STATUSES, EVENT_FACTION_CREATED, EVENT_FACTION_CHANGED,
  MAX_DOCTRINE_ID_LENGTH, MAX_UNITS_DDL, MAX_FRONT_LIMIT, MAX_KEY_LENGTH, MAX_REASON_LENGTH, MAX_UNPAID_PERIODS,
  MAX_UPKEEP_TOTAL,
} = require("./schema");

const INITIAL_VERSION = 1;
const INSERT_COLUMNS = "faction_id, status, home_system_id, doctrine_id, resource_units, reserve_units, front_limit, "
  + "registry_version, last_review_at, created_at, updated_at, version";
const COLUMNS = `${INSERT_COLUMNS}, upkeep_paid_until, upkeep_unpaid_periods, income_total, upkeep_total, `
  + "upkeep_unpaid_total, trade_funded_total";
const FACTIONS_TABLE = defineTable({ name: FACTIONS_TABLE_NAME, idColumn: "faction_id",
  columns: ["status", "home_system_id", "doctrine_id", "resource_units", "reserve_units", "front_limit",
    "last_review_at", "updated_at", "upkeep_paid_until", "upkeep_unpaid_periods", "income_total", "upkeep_total",
    "upkeep_unpaid_total", "trade_funded_total"] });
const DELTA_FIELDS = Object.freeze({ resourceUnits: "resource_units", reserveUnits: "reserve_units" });
const TOTAL_FIELDS = Object.freeze({ incomeTotal: "income_total", upkeepTotal: "upkeep_total",
  upkeepUnpaidTotal: "upkeep_unpaid_total", tradeFundedTotal: "trade_funded_total" });
const PATCH_FIELDS = Object.freeze({ status: "status", homeSystemId: "home_system_id", doctrineId: "doctrine_id",
  frontLimit: "front_limit", lastReviewAt: "last_review_at", upkeepPaidUntil: "upkeep_paid_until",
  upkeepUnpaidPeriods: "upkeep_unpaid_periods" });
const CHANGE_FIELDS = Object.freeze(["factionId", "expectedVersion", "key", "reason", "at", "deltas", "patch"]);
const RECORD_FIELDS = Object.freeze(["factionId", "status", "homeSystemId", "doctrineId", "resourceUnits",
  "reserveUnits", "frontLimit", "registryVersion", "lastReviewAt", "createdAt", "updatedAt"]);
const TX_REQUIRED = Object.freeze({ ok: false, reason: "TX_REQUIRED" });

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const isTime = (v) => Number.isSafeInteger(v) && v >= 0;
const isText = (v, max) => typeof v === "string" && v.length >= 1 && v.length <= max;
const own = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key);
const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

function invalid(detail) {
  return { ok: false, reason: "INVALID_INPUT", detail };
}

function txMissing(tx) {
  return !tx || tx.inTransaction !== true;
}

function toRecord(row) {
  return Object.freeze({
    factionId: row.faction_id,
    status: row.status,
    homeSystemId: row.home_system_id,
    doctrineId: row.doctrine_id,
    resourceUnits: row.resource_units,
    reserveUnits: row.reserve_units,
    frontLimit: row.front_limit,
    registryVersion: row.registry_version,
    lastReviewAt: row.last_review_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    version: row.version,
    upkeepPaidUntil: row.upkeep_paid_until,
    upkeepUnpaidPeriods: row.upkeep_unpaid_periods,
    incomeTotal: row.income_total,
    upkeepTotal: row.upkeep_total,
    upkeepUnpaidTotal: row.upkeep_unpaid_total,
    tradeFundedTotal: row.trade_funded_total,
  });
}

function createFactionRepository(deps) {
  if (!deps || typeof deps !== "object") throw new TypeError("createFactionRepository: deps missing");
  const { journal, limits, onCount } = deps;
  if (!journal || typeof journal.applyOnce !== "function" || typeof journal.findByKey !== "function") {
    throw new TypeError("createFactionRepository: journal with applyOnce/findByKey required");
  }
  if (!limits || typeof limits !== "object") throw new TypeError("createFactionRepository: limits missing");
  const bounds = { maxResourceUnits: MAX_UNITS_DDL, maxFrontLimit: MAX_FRONT_LIMIT, maxListLimit: Infinity };
  for (const name of Object.keys(bounds)) {
    if (!Number.isSafeInteger(limits[name]) || limits[name] < 1 || limits[name] > bounds[name]) {
      throw new TypeError(`createFactionRepository: limits.${name} out of range, got ${limits[name]}`);
    }
  }
  if (onCount !== undefined && typeof onCount !== "function") {
    throw new TypeError("createFactionRepository: onCount must be a function");
  }
  const frozenLimits = Object.freeze({ maxResourceUnits: limits.maxResourceUnits, maxFrontLimit: limits.maxFrontLimit,
    maxListLimit: limits.maxListLimit });
  let changeCount = 0;

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
    s = {
      byId: db.prepare(`SELECT ${COLUMNS} FROM ${FACTIONS_TABLE_NAME} WHERE faction_id = ?`),
      list: db.prepare(`SELECT ${COLUMNS} FROM ${FACTIONS_TABLE_NAME} ORDER BY faction_id LIMIT ?`),
      insert: db.prepare(`INSERT INTO ${FACTIONS_TABLE_NAME} (${INSERT_COLUMNS})
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    };
    perDb.set(db, s);
    return s;
  }

  const isUnits = (v) => Number.isSafeInteger(v) && v >= 0 && v <= frozenLimits.maxResourceUnits;
  const isStatus = (v) => FACTION_STATUSES.includes(v);
  const isFrontLimit = (v) => Number.isSafeInteger(v) && v >= 0 && v <= frozenLimits.maxFrontLimit;

  function validateRecord(record) {
    if (!isPlainObject(record)) return "record";
    for (const key of Object.keys(record)) if (!RECORD_FIELDS.includes(key)) return `record.${key}`;
    if (!isId(record.factionId)) return "record.factionId";
    if (!isStatus(record.status)) return "record.status";
    if (!(record.homeSystemId === null || isId(record.homeSystemId))) return "record.homeSystemId";
    if (!isText(record.doctrineId, MAX_DOCTRINE_ID_LENGTH)) return "record.doctrineId";
    if (!isUnits(record.resourceUnits)) return "record.resourceUnits";
    if (!isUnits(record.reserveUnits)) return "record.reserveUnits";
    if (!isFrontLimit(record.frontLimit)) return "record.frontLimit";
    if (!isId(record.registryVersion)) return "record.registryVersion";
    if (!(record.lastReviewAt === undefined || record.lastReviewAt === null || isTime(record.lastReviewAt))) {
      return "record.lastReviewAt";
    }
    if (!isTime(record.createdAt)) return "record.createdAt";
    if (!isTime(record.updatedAt)) return "record.updatedAt";
    return null;
  }

  function readRow(db, factionId) {
    const row = stmts(db).byId.get(toBind(factionId));
    return row ? toRecord(row) : null;
  }

  function createFaction(tx, record, key) {
    if (txMissing(tx)) return TX_REQUIRED;
    const bad = validateRecord(record);
    if (bad !== null) return invalid(bad);
    if (!isText(key, MAX_KEY_LENGTH)) return invalid("key");
    const lastReviewAt = record.lastReviewAt === undefined ? null : record.lastReviewAt;
    const payload = { factionId: record.factionId, status: record.status, homeSystemId: record.homeSystemId,
      doctrineId: record.doctrineId, resourceUnits: record.resourceUnits, reserveUnits: record.reserveUnits,
      frontLimit: record.frontLimit, registryVersion: record.registryVersion, lastReviewAt };
    const spec = { key, aggregate: { type: FACTION_AGGREGATE, id: String(record.factionId) },
      eventType: EVENT_FACTION_CREATED, payload };
    const result = journal.applyOnce(tx, spec, (db) => {
      const s = stmts(db);
      if (s.byId.get(toBind(record.factionId))) return { ok: false, reason: "FACTION_EXISTS" };
      s.insert.run(toBind(record.factionId), record.status, toBind(record.homeSystemId), record.doctrineId,
        toBind(record.resourceUnits), toBind(record.reserveUnits), toBind(record.frontLimit),
        toBind(record.registryVersion), toBind(lastReviewAt), toBind(record.createdAt), toBind(record.updatedAt),
        toBind(INITIAL_VERSION));
      return { ok: true };
    });
    if (!result.ok) {
      if (result.reason === "APPLY_REFUSED") {
        count("strategy.faction.refused");
        return result.refusal;
      }
      return result;
    }
    if (result.duplicate) return { ok: true, duplicate: true, record: readRow(tx, record.factionId) };
    changeCount += 1;
    return { ok: true, record: readRow(tx, record.factionId) };
  }

  function getFaction(tx, factionId) {
    if (txMissing(tx)) return TX_REQUIRED;
    if (!isId(factionId)) return invalid("factionId");
    return { ok: true, record: readRow(tx, factionId) };
  }

  function listFactions(tx) {
    if (txMissing(tx)) return TX_REQUIRED;
    return { ok: true, records: stmts(tx).list.all(toBind(frozenLimits.maxListLimit)).map(toRecord) };
  }

  function isApplied(tx, key) {
    if (txMissing(tx)) return TX_REQUIRED;
    const found = journal.findByKey(tx, key);
    if (!found.ok) return found;
    return { ok: true, applied: found.found && found.entry.kind === KIND_APPLY };
  }

  function validateChange(change) {
    if (!isPlainObject(change)) return { detail: "change" };
    for (const key of Object.keys(change)) if (!CHANGE_FIELDS.includes(key)) return { detail: `change.${key}` };
    if (!isId(change.factionId)) return { detail: "change.factionId" };
    if (!Number.isSafeInteger(change.expectedVersion) || change.expectedVersion < 1) {
      return { detail: "change.expectedVersion" };
    }
    if (!isText(change.key, MAX_KEY_LENGTH)) return { detail: "change.key" };
    if (!isText(change.reason, MAX_REASON_LENGTH)) return { detail: "change.reason" };
    if (!isTime(change.at)) return { detail: "change.at" };
    const deltas = change.deltas === undefined ? {} : change.deltas;
    const patch = change.patch === undefined ? {} : change.patch;
    if (!isPlainObject(deltas)) return { detail: "change.deltas" };
    if (!isPlainObject(patch)) return { detail: "change.patch" };
    for (const [key, value] of Object.entries(deltas)) {
      if (!own(DELTA_FIELDS, key) && !own(TOTAL_FIELDS, key)) return { detail: `change.deltas.${key}` };
      if (!Number.isSafeInteger(value)) return { detail: `change.deltas.${key}` };
      if (own(TOTAL_FIELDS, key) && (value < 0 || value > MAX_UPKEEP_TOTAL)) return { detail: `change.deltas.${key}` };
    }
    const checks = {
      status: isStatus,
      homeSystemId: (v) => v === null || isId(v),
      doctrineId: (v) => isText(v, MAX_DOCTRINE_ID_LENGTH),
      frontLimit: isFrontLimit,
      lastReviewAt: (v) => v === null || isTime(v),
      upkeepPaidUntil: (v) => v === null || isTime(v),
      upkeepUnpaidPeriods: (v) => Number.isSafeInteger(v) && v >= 0 && v <= MAX_UNPAID_PERIODS,
    };
    for (const [key, value] of Object.entries(patch)) {
      if (!own(PATCH_FIELDS, key) || !checks[key](value)) return { detail: `change.patch.${key}` };
    }
    if (Object.keys(deltas).length === 0 && Object.keys(patch).length === 0) return { detail: "change: empty" };
    return { deltas, patch };
  }

  function applyFactionChange(tx, change) {
    if (txMissing(tx)) return TX_REQUIRED;
    const valid = validateChange(change);
    if (valid.detail) return invalid(valid.detail);
    const { deltas, patch } = valid;
    const spec = { key: change.key, aggregate: { type: FACTION_AGGREGATE, id: String(change.factionId) },
      eventType: EVENT_FACTION_CHANGED,
      payload: { factionId: change.factionId, reason: change.reason, deltas, patch } };
    const result = journal.applyOnce(tx, spec, (db) => {
      const row = readRow(db, change.factionId);
      if (!row) return { ok: false, reason: "ROW_NOT_FOUND" };
      if (row.version !== change.expectedVersion) {
        return { ok: false, reason: "VERSION_CONFLICT", expectedVersion: change.expectedVersion,
          actualVersion: row.version };
      }
      const columns = { updated_at: change.at };
      for (const [field, column] of Object.entries(DELTA_FIELDS)) {
        if (deltas[field] === undefined) continue;
        const value = row[field] + deltas[field];
        if (value < 0) return { ok: false, reason: "INSUFFICIENT_RESOURCES", detail: field };
        if (deltas[field] > 0 && value > frozenLimits.maxResourceUnits) {
          return { ok: false, reason: "RESOURCE_CAP", detail: field };
        }
        columns[column] = value;
      }
      for (const [field, column] of Object.entries(TOTAL_FIELDS)) {
        if (deltas[field] === undefined || deltas[field] === 0) continue;
        columns[column] = Math.min(MAX_UPKEEP_TOTAL, row[field] + deltas[field]);
      }
      for (const [field, column] of Object.entries(PATCH_FIELDS)) {
        if (own(patch, field)) columns[column] = patch[field];
      }
      const updated = updateWithVersion(db, FACTIONS_TABLE, change.factionId, change.expectedVersion, columns);
      if (!updated.ok) return updated;
      return { ok: true, record: readRow(db, change.factionId) };
    });
    if (!result.ok) {
      if (result.reason === "APPLY_REFUSED") {
        count("strategy.faction.refused");
        return result.refusal;
      }
      return result;
    }
    if (result.duplicate) return { ok: true, duplicate: true };
    changeCount += 1;
    count("strategy.faction.changed");
    return { ok: true, record: result.value.record };
  }

  return Object.freeze({
    createFaction,
    getFaction,
    listFactions,
    isApplied,
    applyFactionChange,
    getChangeCount: () => changeCount,
    limits: frozenLimits,
  });
}

module.exports = { createFactionRepository, FACTIONS_TABLE };
