"use strict";

const Module = require("module");

const TABLE = "dungeonRuntimeState";
const ROW_KEY_SEP = "\u001f";
const ROW_KEY_SEP_NEXT = " ";
const TABLE_NAME = /^[A-Za-z0-9_]+$/;

function openRowSource(options) {
  const { sqliteStoreFilename, dbPath } = options;
  const table = options.table === undefined ? TABLE : options.table;
  const busyTimeoutMs = Math.max(0, Math.floor(Number(options.busyTimeoutMs) || 0));
  if (typeof sqliteStoreFilename !== "string" || sqliteStoreFilename === "") throw new Error("sqliteStoreFilename required");
  if (typeof dbPath !== "string" || dbPath === "") throw new Error("dbPath required");
  if (typeof table !== "string" || !TABLE_NAME.test(table)) throw new Error("invalid table");
  const Database = Module.createRequire(sqliteStoreFilename)("better-sqlite3");
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  db.pragma(`busy_timeout = ${busyTimeoutMs}`);
  db.pragma("query_only = ON");

  const statements = {};
  function stmt(name, sql, pluck = false) {
    if (!statements[name]) {
      const prepared = db.prepare(sql);
      statements[name] = pluck ? prepared.pluck() : prepared;
    }
    return statements[name];
  }

  let inSnapshot = false;
  function guard() {
    if (!inSnapshot) throw new Error("RowTx used outside readSnapshot");
  }

  const tx = Object.freeze({
    tableExists() {
      guard();
      return stmt("exists", "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", true).all(table).length > 0;
    },
    listKeys() {
      guard();
      return stmt("keys", `SELECT key FROM "${table}"`, true).all();
    },
    readRows(keys) {
      guard();
      if (!Array.isArray(keys) || keys.length === 0) return [];
      return stmt("rows", `SELECT key, json FROM "${table}" WHERE key IN (SELECT value FROM json_each(?))`).all(JSON.stringify(keys));
    },
    readEntry(key) {
      guard();
      if (typeof key !== "string" || key === "") return [];
      return stmt("entry",
        `SELECT key, json FROM "${table}" WHERE key = ? ` +
        `UNION ALL SELECT key, json FROM "${table}" WHERE key >= ? AND key < ?`)
        .all(key, key + ROW_KEY_SEP, key + ROW_KEY_SEP_NEXT);
    },
    classify(entityKeys) {
      guard();
      if (!Array.isArray(entityKeys) || entityKeys.length === 0) return [];
      return stmt("classify",
        `SELECT key, CASE WHEN instr(json, '"abyssal-pocket"') = 0 THEN 0 ` +
        `ELSE (json_extract(json, '$.siteFamily') = 'abyssal' AND json_extract(json, '$.siteKind') = 'abyssal-pocket') END AS abyssal ` +
        `FROM "${table}" WHERE key IN (SELECT value FROM json_each(?))`).all(JSON.stringify(entityKeys));
    },
  });

  function readSnapshot(fn) {
    if (inSnapshot) throw new Error("readSnapshot is not reentrant");
    stmt("begin", "BEGIN DEFERRED").run();
    inSnapshot = true;
    let ok = false;
    try {
      const result = fn(tx);
      ok = true;
      return result;
    } finally {
      inSnapshot = false;
      if (db.inTransaction) stmt(ok ? "commit" : "rollback", ok ? "COMMIT" : "ROLLBACK").run();
    }
  }

  return {
    readSnapshot,
    close() { if (db.open) db.close(); },
    dbPath,
    explainListKeys() { return db.prepare(`EXPLAIN QUERY PLAN SELECT key FROM "${table}"`).all(); },
  };
}

module.exports = { openRowSource, TABLE, ROW_KEY_SEP };
