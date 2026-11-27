"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { findServerSrcOnDisk, GAMESTORE_SEARCH_MAX_DEPTH } = require("../../lib/adapter/locator");
const { resolveSqliteDriver } = require("../../lib/adapter/sqliteDriver");
const { MIGRATIONS, LATEST_SCHEMA_VERSION, META_TABLE } = require("../../lib/persistence/migrations");
const { openStore } = require("../../lib/persistence/store");
const { seedDbFile } = require("../_support/dbTemplate");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const SEED = 5;

function loadDriver() {
  const found = findServerSrcOnDisk(MOD_DIR, GAMESTORE_SEARCH_MAX_DEPTH, fs.existsSync);
  if (!found.ok) return { ok: false, detail: found.reason };
  return resolveSqliteDriver(found.srcDir);
}

function snapshot(store) {
  const read = store.transaction("tpl1_read", (db) => ({
    journal: String(db.pragma("journal_mode", { simple: true })).toLowerCase(),
    master: db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name").all(),
    meta: db.prepare(`SELECT * FROM ${META_TABLE} ORDER BY key`).all(),
  }));
  assert.ok(read.ok, JSON.stringify(read));
  return read.value;
}

module.exports = ({ test, skip }) => {
  const driver = loadDriver();
  const name = "TPL1 template copy == fresh migration: latest, applied 0, seed, WAL, same sqlite_master";
  if (!driver.ok) {
    skip(name, `better-sqlite3 unavailable (${driver.detail})`);
    return;
  }
  test(name, () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lne-tpl1-"));
    const open = [];
    const openAt = (file) => {
      const opened = openStore({ filePath: file, openDatabase: (f) => new driver.Database(f), exclusiveLock: true,
        busyTimeoutMs: 0, maxRowsPerTransaction: 500, maxWriteMsPerPass: 5, randomSeed: () => SEED,
        migrations: MIGRATIONS });
      assert.ok(opened.ok, JSON.stringify(opened));
      open.push(opened.store);
      return opened;
    };
    try {
      const freshFile = path.join(tmp, "fresh.sqlite");
      const copyFile = path.join(tmp, "copy.sqlite");
      const fresh = openAt(freshFile);
      assert.strictEqual(fresh.applied, LATEST_SCHEMA_VERSION, "reference really migrated from zero");
      assert.strictEqual(seedDbFile(driver, copyFile, { migrations: MIGRATIONS, seed: SEED }), true);
      assert.strictEqual(seedDbFile(driver, copyFile, { migrations: MIGRATIONS, seed: SEED }), false,
        "an existing file is never overwritten");
      const copy = openAt(copyFile);
      assert.deepStrictEqual([copy.schemaVersion, copy.applied, copy.worldSeed], [LATEST_SCHEMA_VERSION, 0, SEED]);
      const a = snapshot(fresh.store);
      const b = snapshot(copy.store);
      assert.strictEqual(b.journal, "wal");
      assert.ok(b.master.length > 0);
      assert.deepStrictEqual(b.master, a.master);
      assert.deepStrictEqual(b.meta, a.meta);
    } finally {
      for (const s of open) s.close("test_cleanup");
      try {
        fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      } catch (_err) {
      }
    }
  });
};
