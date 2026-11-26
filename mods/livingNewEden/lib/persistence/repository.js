"use strict";

const IDENTIFIER_RE = /^[a-z][a-z0-9_]*$/;
const VERSION_COLUMN = "version";
const MIN_VERSION = 1;
const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

const DESCRIPTORS = new WeakSet();

function isInt64(value) {
  return typeof value === "bigint" && value >= INT64_MIN && value <= INT64_MAX;
}

function toBind(value) {
  return Number.isSafeInteger(value) ? BigInt(value) : value;
}

function stateListSql(states, allowed) {
  if (!Array.isArray(states) || !Array.isArray(allowed)) throw new TypeError("stateListSql: arrays required");
  const list = [...new Set(states)].sort();
  for (const st of list) {
    if (typeof st !== "string" || !allowed.includes(st) || !/^[A-Za-z0-9_]+$/.test(st)) {
      throw new TypeError(`stateListSql: state outside the enum: ${String(st)}`);
    }
  }
  return `(${list.map((st) => `'${st}'`).join(",")})`;
}

function isIdentifier(value) {
  return typeof value === "string" && IDENTIFIER_RE.test(value);
}

function defineTable(spec) {
  if (!spec || typeof spec !== "object") throw new TypeError("defineTable: spec missing");
  const { name, idColumn, columns } = spec;
  if (!isIdentifier(name)) throw new TypeError(`defineTable: invalid table name ${name}`);
  if (!isIdentifier(idColumn)) throw new TypeError(`defineTable: invalid idColumn ${idColumn}`);
  if (!Array.isArray(columns) || columns.length === 0) {
    throw new TypeError("defineTable: columns must be a non-empty array");
  }
  for (const column of columns) {
    if (!isIdentifier(column)) throw new TypeError(`defineTable: invalid column ${column}`);
    if (column === idColumn || column === VERSION_COLUMN) {
      throw new TypeError(`defineTable: column ${column} cannot be patched`);
    }
  }
  if (new Set(columns).size !== columns.length) throw new TypeError("defineTable: duplicate column");
  const descriptor = Object.freeze({ name, idColumn, columns: Object.freeze([...columns]) });
  DESCRIPTORS.add(descriptor);
  return descriptor;
}

function isPatchValue(value) {
  if (value === null || typeof value === "string") return true;
  if (typeof value === "bigint") return isInt64(value);
  if (typeof value === "number") return Number.isFinite(value);
  return Buffer.isBuffer(value);
}

function invalid(detail) {
  return { ok: false, reason: "REPO_INVALID_INPUT", detail };
}

const cache = new WeakMap();

function statementsFor(db, table, keys) {
  let byDb = cache.get(db);
  if (!byDb) {
    byDb = new WeakMap();
    cache.set(db, byDb);
  }
  let byTable = byDb.get(table);
  if (!byTable) {
    byTable = new Map();
    byDb.set(table, byTable);
  }
  const cacheKey = keys.join(",");
  let stmts = byTable.get(cacheKey);
  if (!stmts) {
    const sets = keys.map((key) => `"${key}" = ?`).join(", ");
    stmts = {
      update: db.prepare(`UPDATE "${table.name}" SET ${sets}, ${VERSION_COLUMN} = ${VERSION_COLUMN} + 1
        WHERE "${table.idColumn}" = ? AND ${VERSION_COLUMN} = ?`),
      version: db.prepare(`SELECT ${VERSION_COLUMN} FROM "${table.name}" WHERE "${table.idColumn}" = ?`),
    };
    byTable.set(cacheKey, stmts);
  }
  return stmts;
}

function updateWithVersion(tx, table, id, expectedVersion, patch) {
  if (!tx || tx.inTransaction !== true) return { ok: false, reason: "TX_REQUIRED" };
  if (!table || typeof table !== "object" || !DESCRIPTORS.has(table)) return invalid("table: not from defineTable");
  if (!(Number.isSafeInteger(id) || isInt64(id) || (typeof id === "string" && id !== ""))) return invalid("id");
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < MIN_VERSION) return invalid("expectedVersion");
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return invalid("patch");
  const keys = Object.keys(patch).sort();
  if (keys.length === 0) return invalid("patch: empty");
  for (const key of keys) {
    if (!table.columns.includes(key)) return invalid(`patch: column ${key}`);
    if (!isPatchValue(patch[key])) return invalid(`patch: value of ${key}`);
  }
  const stmts = statementsFor(tx, table, keys);
  const boundId = toBind(id);
  const info = stmts.update.run(...keys.map((key) => toBind(patch[key])), boundId, toBind(expectedVersion));
  if (info.changes === 1) return { ok: true, version: expectedVersion + 1 };
  const row = stmts.version.get(boundId);
  if (!row) return { ok: false, reason: "ROW_NOT_FOUND" };
  return { ok: false, reason: "VERSION_CONFLICT", expectedVersion, actualVersion: row.version };
}

module.exports = { defineTable, updateWithVersion, toBind, stateListSql, VERSION_COLUMN };
