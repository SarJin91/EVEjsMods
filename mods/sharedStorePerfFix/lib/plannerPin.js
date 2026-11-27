"use strict";

const { probeTriggerPlan, quoteIdentifier, resolveTarget } = require("./triggerProbe");

const STRUCTURES_TARGET = Object.freeze({
  trigger: "structure_collection_write",
  recordsTable: "structure_records",
  key: "structures",
  columns: Object.freeze(["parent_id", "ordinal"]),
});

const DEFAULT_PIN_ROWS = 100000;
const MIN_PIN_ROWS = 1000;
const MAX_PIN_ROWS = 10000000;

function pinStatOf(pinRows) {
  return `${pinRows} ${pinRows} 1`;
}

function isBusyError(error) {
  const code = String((error && error.code) || "");
  return code === "SQLITE_BUSY" || code.startsWith("SQLITE_BUSY_") || code === "SQLITE_LOCKED";
}

function statTableExists(db) {
  return Boolean(db.prepare("SELECT 1 AS present FROM sqlite_schema WHERE type = 'table' AND name = 'sqlite_stat1'").get());
}

function readStat(db, table, indexName) {
  if (!statTableExists(db)) return null;
  const row = db.prepare("SELECT stat FROM sqlite_stat1 WHERE tbl = ? AND idx = ?").get(table, indexName);
  return row ? String(row.stat) : null;
}

function reloadStats(db) {
  db.exec("ANALYZE sqlite_schema");
}

function inWriteTransaction(db, operation) {
  db.exec("BEGIN IMMEDIATE");
  try {
    operation();
    db.exec("COMMIT");
  } catch (error) {
    if (db.inTransaction) db.exec("ROLLBACK");
    throw error;
  }
}

function writeStat(db, table, indexName, stat) {
  inWriteTransaction(db, () => {
    // SQLite refuses CREATE TABLE sqlite_stat1; analyzing the one small index creates it.
    if (!statTableExists(db)) db.exec(`ANALYZE ${quoteIdentifier(indexName)}`);
    db.prepare("DELETE FROM sqlite_stat1 WHERE tbl = ? AND idx = ?").run(table, indexName);
    if (stat !== null) db.prepare("INSERT INTO sqlite_stat1 (tbl, idx, stat) VALUES (?, ?, ?)").run(table, indexName, stat);
  });
  reloadStats(db);
}

function probeVendorSchema(deps, liveTarget, openMemory) {
  const cache = deps.cache && typeof deps.cache === "object" ? deps.cache : null;
  if (cache && cache.vendorProbe) return cache.vendorProbe;
  let outcome;
  if (typeof deps.vendorSchemaSql !== "function") {
    outcome = { good: false, triggerSql: null, detail: "no vendor schema generator" };
  } else {
    let memory = null;
    try {
      memory = openMemory();
      memory.exec(deps.vendorSchemaSql());
      const target = resolveTarget(memory, liveTarget);
      const probe = target.ok ? probeTriggerPlan(memory, target) : { reason: target.reason, bad: 0, total: 0 };
      outcome = { good: probe.reason === "GOOD", triggerSql: target.ok ? target.triggerSql : null, probe };
    } catch (error) {
      outcome = { good: false, triggerSql: null, detail: String(error && error.message) };
    } finally {
      if (memory) {
        try {
          memory.close();
        } catch (_error) {
          // The probe connection holds nothing worth reporting.
        }
      }
    }
  }
  if (cache) cache.vendorProbe = outcome;
  return outcome;
}

function applyPlannerPin(db, deps = {}) {
  const now = typeof deps.now === "function" ? deps.now : Date.now;
  const started = now();
  const finish = (ok, reason, extra = {}) => ({ ok, reason, ...extra, ms: Math.max(0, now() - started) });
  if (deps.enabled === false) return finish(true, "DISABLED");
  if (deps.readOnly === true) return finish(true, "READ_ONLY");

  const pinRows = deps.pinRows === undefined ? DEFAULT_PIN_ROWS : deps.pinRows;
  if (!Number.isSafeInteger(pinRows) || pinRows < MIN_PIN_ROWS || pinRows > MAX_PIN_ROWS) {
    throw new RangeError(`pinRows must be an integer in ${MIN_PIN_ROWS}..${MAX_PIN_ROWS}`);
  }
  const target = deps.target || STRUCTURES_TARGET;
  const openMemory = typeof deps.openMemoryDb === "function" ? deps.openMemoryDb : () => new db.constructor(":memory:");
  const pinStat = pinStatOf(pinRows);

  try {
    if (db.pragma("application_id", { simple: true }) !== deps.applicationId) return finish(true, "NOT_SHARED");
    const live = resolveTarget(db, target);
    if (!live.ok) return finish(false, "DRIFT", { table: target.recordsTable, detail: live.reason });
    const base = { table: live.recordsTable, indexName: live.indexName, pinRows };
    if (db.inTransaction) return finish(false, "BUSY", { ...base, detail: "connection is inside a transaction" });

    const vendor = probeVendorSchema(deps, target, openMemory);
    if (vendor.good && vendor.triggerSql === live.triggerSql) {
      const removed = readStat(db, live.recordsTable, live.indexName) === pinStat;
      if (removed) writeStat(db, live.recordsTable, live.indexName, null);
      return finish(true, "VENDOR_FIXED", { ...base, removed });
    }

    const previous = readStat(db, live.recordsTable, live.indexName);
    if (previous !== null) {
      reloadStats(db);
      const probe = probeTriggerPlan(db, live);
      if (probe.reason === "GOOD") return finish(true, "ALREADY_PINNED", { ...base, probe });
      if (probe.reason === "NO_PROBE") return finish(false, "DRIFT", { ...base, detail: probe.detail });
      if (previous === pinStat) {
        writeStat(db, live.recordsTable, live.indexName, null);
        return finish(false, "PLAN_NOT_FIXED", { ...base, probe });
      }
    }

    writeStat(db, live.recordsTable, live.indexName, pinStat);
    const probe = probeTriggerPlan(db, live);
    if (probe.reason === "GOOD") return finish(true, "PINNED", { ...base, probe });
    writeStat(db, live.recordsTable, live.indexName, previous);
    if (probe.reason === "NO_PROBE") return finish(false, "DRIFT", { ...base, detail: probe.detail });
    return finish(false, "PLAN_NOT_FIXED", { ...base, probe });
  } catch (error) {
    if (isBusyError(error)) return finish(false, "BUSY", { detail: String(error.message) });
    throw error;
  }
}

function removePlannerPin(db, { pinRows = DEFAULT_PIN_ROWS, target = STRUCTURES_TARGET } = {}) {
  const live = resolveTarget(db, target);
  if (!live.ok) return { ok: false, reason: "DRIFT", detail: live.reason };
  const current = readStat(db, live.recordsTable, live.indexName);
  if (current === null) return { ok: true, reason: "NOT_PINNED", indexName: live.indexName };
  if (current !== pinStatOf(pinRows)) return { ok: false, reason: "FOREIGN_STAT", indexName: live.indexName, stat: current };
  writeStat(db, live.recordsTable, live.indexName, null);
  return { ok: true, reason: "REMOVED", indexName: live.indexName };
}

module.exports = {
  DEFAULT_PIN_ROWS,
  MAX_PIN_ROWS,
  MIN_PIN_ROWS,
  STRUCTURES_TARGET,
  applyPlannerPin,
  isBusyError,
  pinStatOf,
  probeVendorSchema,
  readStat,
  removePlannerPin,
  writeStat,
};
