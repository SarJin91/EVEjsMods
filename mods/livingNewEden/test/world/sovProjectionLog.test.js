"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { findServerSrcOnDisk, GAMESTORE_SEARCH_MAX_DEPTH } = require("../../lib/adapter/locator");
const { resolveSqliteDriver } = require("../../lib/adapter/sqliteDriver");
const { MIGRATIONS, LATEST_SCHEMA_VERSION } = require("../../lib/persistence/migrations");
const { openStore } = require("../../lib/persistence/store");
const { seedDbFile } = require("../_support/dbTemplate");
const { upsertLog, getLog, listLogs } = require("../../lib/world/sovProjection/repository");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const NOW = 1700000000000;

function up(tx, systemId, controller, alliance, corp, action, seq, expectedVersion = 0, now = NOW) {
  return upsertLog(tx, { systemId, controller, alliance, corp, action, seq, expectedVersion, now });
}

function loadDriver() {
  const found = findServerSrcOnDisk(MOD_DIR, GAMESTORE_SEARCH_MAX_DEPTH, fs.existsSync);
  if (!found.ok) return { ok: false, detail: found.reason };
  return resolveSqliteDriver(found.srcDir);
}

function withStore(fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lne-sovlog-"));
  const file = path.join(tmp, "world.sqlite");
  const open = [];
  const driver = loadDriver();
  const reopen = () => {
    seedDbFile(driver, file, { migrations: MIGRATIONS, seed: 1 });
    const opened = openStore({
      filePath: file,
      openDatabase: (f) => new driver.Database(f),
      exclusiveLock: true,
      busyTimeoutMs: 0,
      maxRowsPerTransaction: 500,
      maxWriteMsPerPass: 5,
      randomSeed: () => 1,
      migrations: MIGRATIONS,
    });
    assert.ok(opened.ok, JSON.stringify(opened));
    open.push(opened.store);
    return opened.store;
  };
  try {
    return fn(reopen);
  } finally {
    for (const s of open) s.close("test_cleanup");
    try {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch (_err) {
    }
  }
}

module.exports = ({ test, skip }) => {
  const driver = loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  needsDriver("SovLog: insert new log entry", () => {
    withStore((reopen) => {
      const store = reopen();
      const result = store.transaction("upsert", (tx) =>
        up(tx, 30000101, 500016, 99000001, 99000011, "GAIN", 5)
      );
      assert.ok(result.ok && result.value.ok, JSON.stringify(result));
      assert.strictEqual(result.value.version, 1);

      const read = store.transaction("get", (tx) => getLog(tx, 30000101));
      assert.ok(read.ok && read.value.ok, JSON.stringify(read));
      const row = read.value.value;
      assert.strictEqual(row.system_id, 30000101);
      assert.strictEqual(row.last_controller, 500016);
      assert.strictEqual(row.last_alliance, 99000001);
      assert.strictEqual(row.last_corp, 99000011);
      assert.strictEqual(row.last_action, "GAIN");
      assert.strictEqual(row.last_seq, 5);
      assert.strictEqual(row.version, 1);
      assert.ok(row.updated_at > 0);
    });
  });

  needsDriver("SovLog: update existing log entry bumps version", () => {
    withStore((reopen) => {
      const store = reopen();
      let result = store.transaction("upsert1", (tx) =>
        up(tx, 30000101, 500016, 99000001, 99000011, "GAIN", 5)
      );
      assert.ok(result.ok && result.value.ok && result.value.version === 1);

      result = store.transaction("upsert2", (tx) =>
        up(tx, 30000101, 500017, 99000002, 99000012, "TRANSFER", 10, 1)
      );
      assert.ok(result.ok, JSON.stringify(result));
      assert.strictEqual(result.value.version, 2);

      const read = store.transaction("get", (tx) => getLog(tx, 30000101));
      assert.ok(read.ok && read.value.ok, JSON.stringify(read));
      const row = read.value.value;
      assert.strictEqual(row.last_controller, 500017);
      assert.strictEqual(row.last_alliance, 99000002);
      assert.strictEqual(row.last_corp, 99000012);
      assert.strictEqual(row.last_action, "TRANSFER");
      assert.strictEqual(row.last_seq, 10);
      assert.strictEqual(row.version, 2);
    });
  });

  needsDriver("SovLog TP2: expectedVersion from the caller -> VERSION_CONFLICT for the stale writer", () => {
    withStore((reopen) => {
      const store = reopen();
      store.transaction("upsert1", (tx) => up(tx, 30000101, 500016, 99000001, 99000011, "GAIN", 5));

      const read1 = store.transaction("get1", (tx) => getLog(tx, 30000101));
      assert.strictEqual(read1.value.value.version, 1);
      const upd2 = store.transaction("upsert2", (tx) =>
        up(tx, 30000101, 500017, 99000002, 99000012, "TRANSFER", 10, 1));
      assert.ok(upd2.ok && upd2.value.ok && upd2.value.version === 2, JSON.stringify(upd2));
      const stale = store.transaction("upsert3", (tx) =>
        up(tx, 30000101, 500018, 99000003, 99000013, "TRANSFER", 11, 1));
      assert.strictEqual(stale.value.reason, "VERSION_CONFLICT");
      assert.strictEqual(stale.value.actualVersion, 2);
      const insertAgain = store.transaction("upsert4", (tx) => up(tx, 30000101, 500016, 99000001, 99000011, "GAIN", 5));
      assert.strictEqual(insertAgain.value.reason, "VERSION_CONFLICT");
      const missing = store.transaction("upsert5", (tx) => up(tx, 30000199, 500016, 99000001, 99000011, "GAIN", 5, 1));
      assert.strictEqual(missing.value.reason, "ROW_NOT_FOUND");

      const read2 = store.transaction("get2", (tx) => getLog(tx, 30000101));
      assert.strictEqual(read2.value.value.version, 2);
      assert.strictEqual(read2.value.value.last_controller, 500017);
    });
  });

  needsDriver("SovLog TP2: TX_REQUIRED, STALE_SEQ, updated_at follows the pair (controller, alliance)", () => {
    withStore((reopen) => {
      const store = reopen();
      assert.strictEqual(up(null, 30000101, 500016, 99000001, 99000011, "GAIN", 3).reason, "TX_REQUIRED");
      assert.strictEqual(up({ inTransaction: false }, 30000101, 500016, 99000001, 99000011, "GAIN", 3).reason,
        "TX_REQUIRED");

      store.transaction("i", (tx) => up(tx, 30000101, 500016, 99000001, 99000011, "GAIN", 3, 0, 1000));
      const stale = store.transaction("s", (tx) => up(tx, 30000101, 500016, 99000001, 99000011, "GAIN", 1, 1, 2000));
      assert.strictEqual(stale.value.reason, "STALE_SEQ");
      const row1 = store.transaction("g1", (tx) => getLog(tx, 30000101)).value.value;
      assert.deepStrictEqual([row1.last_seq, row1.version, row1.updated_at], [3, 1, 1000]);

      const sync = store.transaction("y", (tx) => up(tx, 30000101, 500016, 99000001, 99000011, "SYNC", 4, 1, 3000));
      assert.ok(sync.value.ok, JSON.stringify(sync));
      const row2 = store.transaction("g2", (tx) => getLog(tx, 30000101)).value.value;
      assert.deepStrictEqual([row2.last_action, row2.last_seq, row2.version, row2.updated_at], ["SYNC", 4, 2, 1000]);

      const tr = store.transaction("t", (tx) => up(tx, 30000101, 500017, 99000002, 99000012, "TRANSFER", 4, 2, 4000));
      assert.ok(tr.value.ok, JSON.stringify(tr));
      const row3 = store.transaction("g3", (tx) => getLog(tx, 30000101)).value.value;
      assert.deepStrictEqual([row3.last_controller, row3.version, row3.updated_at], [500017, 3, 4000]);
    });
  });

  needsDriver("SovLog: getLog returns ROW_NOT_FOUND for missing system", () => {
    withStore((reopen) => {
      const store = reopen();
      const result = store.transaction("get", (tx) => getLog(tx, 99999999));
      assert.ok(result.ok);
      assert.strictEqual(result.value.reason, "ROW_NOT_FOUND");
    });
  });

  needsDriver("SovLog: getLog validates systemId input", () => {
    withStore((reopen) => {
      const store = reopen();
      let result = store.transaction("get", (tx) => getLog(tx, "abc"));
      assert.ok(result.ok);
      assert.strictEqual(result.value.reason, "REPO_INVALID_INPUT");

      result = store.transaction("get", (tx) => getLog(tx, -1));
      assert.ok(result.ok);
      assert.strictEqual(result.value.reason, "REPO_INVALID_INPUT");

      result = store.transaction("get", (tx) => getLog(tx, 0));
      assert.ok(result.ok);
      assert.strictEqual(result.value.reason, "REPO_INVALID_INPUT");
    });
  });

  needsDriver("SovLog: upsertLog validates inputs", () => {
    withStore((reopen) => {
      const store = reopen();
      let result = store.transaction("upsert", (tx) => up(tx, 0, 500016, 99000001, 99000011, "GAIN", 5));
      assert.ok(result.ok);
      assert.strictEqual(result.value.reason, "REPO_INVALID_INPUT");

      result = store.transaction("upsert", (tx) => up(tx, 30000101, -5, 99000001, 99000011, "GAIN", 5));
      assert.ok(result.ok);
      assert.strictEqual(result.value.reason, "REPO_INVALID_INPUT");

      result = store.transaction("upsert", (tx) => up(tx, 30000101, 500016, -1, 99000011, "GAIN", 5));
      assert.ok(result.ok);
      assert.strictEqual(result.value.reason, "REPO_INVALID_INPUT");

      result = store.transaction("upsert", (tx) => up(tx, 30000101, 500016, 99000001, -1, "GAIN", 5));
      assert.ok(result.ok);
      assert.strictEqual(result.value.reason, "REPO_INVALID_INPUT");

      result = store.transaction("upsert", (tx) => up(tx, 30000101, 500016, 99000001, 99000011, "", 5));
      assert.ok(result.ok);
      assert.strictEqual(result.value.reason, "REPO_INVALID_INPUT");

      result = store.transaction("upsert", (tx) => up(tx, 30000101, 500016, 99000001, 99000011, "A".repeat(33), 5));
      assert.ok(result.ok);
      assert.strictEqual(result.value.reason, "REPO_INVALID_INPUT");

      result = store.transaction("upsert", (tx) => up(tx, 30000101, 500016, 99000001, 99000011, "GAIN", -1));
      assert.ok(result.ok);
      assert.strictEqual(result.value.reason, "REPO_INVALID_INPUT");
    });
  });

  needsDriver("SovLog: listLogs returns all entries", () => {
    withStore((reopen) => {
      const store = reopen();
      store.transaction("upsert1", (tx) => up(tx, 30000101, 500016, 99000001, 99000011, "GAIN", 5));
      store.transaction("upsert2", (tx) => up(tx, 30000102, 500017, 99000002, 99000012, "LOSS", 3));
      store.transaction("upsert3", (tx) => up(tx, 30000103, 500018, 99000003, 99000013, "TRANSFER", 7));

      const result = store.transaction("list", (tx) => listLogs(tx, { limit: 10 }));
      assert.ok(result.ok && result.value.ok, JSON.stringify(result));
      assert.strictEqual(result.value.value.length, 3);
      assert.strictEqual(result.value.value[0].system_id, 30000101);
      assert.strictEqual(result.value.value[1].system_id, 30000102);
      assert.strictEqual(result.value.value[2].system_id, 30000103);
    });
  });

  needsDriver("SovLog: listLogs filters by lastController", () => {
    withStore((reopen) => {
      const store = reopen();
      store.transaction("upsert1", (tx) => up(tx, 30000101, 500016, 99000001, 99000011, "GAIN", 5));
      store.transaction("upsert2", (tx) => up(tx, 30000102, 500017, 99000002, 99000012, "LOSS", 3));
      store.transaction("upsert3", (tx) => up(tx, 30000103, 500016, 99000003, 99000013, "TRANSFER", 7));

      const result = store.transaction("list", (tx) => listLogs(tx, { lastController: 500016, limit: 10 }));
      assert.ok(result.ok && result.value.ok, JSON.stringify(result));
      assert.strictEqual(result.value.value.length, 2);
      assert.strictEqual(result.value.value[0].system_id, 30000101);
      assert.strictEqual(result.value.value[1].system_id, 30000103);
      assert.strictEqual(result.value.value[0].last_controller, 500016);
      assert.strictEqual(result.value.value[1].last_controller, 500016);
    });
  });

  needsDriver("SovLog: listLogs filters by lastAction", () => {
    withStore((reopen) => {
      const store = reopen();
      store.transaction("upsert1", (tx) => up(tx, 30000101, 500016, 99000001, 99000011, "GAIN", 5));
      store.transaction("upsert2", (tx) => up(tx, 30000102, 500017, 99000002, 99000012, "LOSS", 3));
      store.transaction("upsert3", (tx) => up(tx, 30000103, 500016, 99000003, 99000013, "GAIN", 7));

      const result = store.transaction("list", (tx) => listLogs(tx, { lastAction: "GAIN", limit: 10 }));
      assert.ok(result.ok && result.value.ok, JSON.stringify(result));
      assert.strictEqual(result.value.value.length, 2);
      assert.strictEqual(result.value.value[0].last_action, "GAIN");
      assert.strictEqual(result.value.value[1].last_action, "GAIN");
    });
  });

  needsDriver("SovLog: listLogs pagination with limit and offset", () => {
    withStore((reopen) => {
      const store = reopen();
      store.transaction("upsert1", (tx) => up(tx, 30000101, 500016, 99000001, 99000011, "GAIN", 5));
      store.transaction("upsert2", (tx) => up(tx, 30000102, 500017, 99000002, 99000012, "LOSS", 3));
      store.transaction("upsert3", (tx) => up(tx, 30000103, 500018, 99000003, 99000013, "TRANSFER", 7));
      store.transaction("upsert4", (tx) => up(tx, 30000104, 500019, 99000004, 99000014, "REINFORCE", 2));

      const page1 = store.transaction("list1", (tx) => listLogs(tx, { limit: 2, offset: 0 }));
      assert.ok(page1.ok && page1.value.ok);
      assert.strictEqual(page1.value.value.length, 2);
      assert.strictEqual(page1.value.value[0].system_id, 30000101);
      assert.strictEqual(page1.value.value[1].system_id, 30000102);

      const page2 = store.transaction("list2", (tx) => listLogs(tx, { limit: 2, offset: 2 }));
      assert.ok(page2.ok && page2.value.ok);
      assert.strictEqual(page2.value.value.length, 2);
      assert.strictEqual(page2.value.value[0].system_id, 30000103);
      assert.strictEqual(page2.value.value[1].system_id, 30000104);
    });
  });

  needsDriver("SovLog: listLogs validates limit and offset", () => {
    withStore((reopen) => {
      const store = reopen();
      let result = store.transaction("list", (tx) => listLogs(tx, { limit: 1001 }));
      assert.ok(result.ok);
      assert.strictEqual(result.value.reason, "REPO_INVALID_INPUT");

      result = store.transaction("list", (tx) => listLogs(tx, { limit: 0 }));
      assert.ok(result.ok);
      assert.strictEqual(result.value.reason, "REPO_INVALID_INPUT");

      result = store.transaction("list", (tx) => listLogs(tx, { offset: -1 }));
      assert.ok(result.ok);
      assert.strictEqual(result.value.reason, "REPO_INVALID_INPUT");
    });
  });

  needsDriver("SovLog: null controller, alliance, corp are allowed", () => {
    withStore((reopen) => {
      const store = reopen();
      const result = store.transaction("upsert", (tx) =>
        up(tx, 30000101, null, 99000001, 99000011, "LOSS", 5)
      );
      assert.ok(result.ok && result.value.ok, JSON.stringify(result));

      const read = store.transaction("get", (tx) => getLog(tx, 30000101));
      assert.ok(read.ok && read.value.ok, JSON.stringify(read));
      const row = read.value.value;
      assert.strictEqual(row.last_controller, null);
      assert.strictEqual(row.last_alliance, 99000001);
      assert.strictEqual(row.last_corp, 99000011);
      assert.strictEqual(row.last_action, "LOSS");
      assert.strictEqual(row.last_seq, 5);
    });
  });

  needsDriver("SovLog: migration 24 creates table with correct schema", () => {
    withStore((reopen) => {
      const store = reopen();
      const tables = store.transaction("tables", (tx) =>
        tx.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='world_sov_projection_log'").get()
      );
      assert.ok(tables.ok && tables.value, "world_sov_projection_log table exists");

      const cols = store.transaction("cols", (tx) =>
        tx.prepare("PRAGMA table_info(world_sov_projection_log)").all()
      );
      assert.ok(cols.ok);
      const colNames = cols.value.map((c) => c.name).sort();
      const expected = ["last_action", "last_alliance", "last_controller", "last_corp", "last_seq", "system_id", "updated_at", "version"].sort();
      assert.deepStrictEqual(colNames, expected);

      const idx = store.transaction("idx", (tx) =>
        tx.prepare("SELECT sql FROM sqlite_master WHERE name='world_sov_projection_log'").get()
      );
      assert.ok(idx.ok && idx.value.sql.includes("WITHOUT ROWID"));
    });
  });

  needsDriver("SovLog: migration 24 applied on reopen after slice(0,23)", () => {
    withStore((reopen) => {
      const store = reopen();
      const version = store.transaction("ver", (tx) =>
        tx.prepare("SELECT value FROM lne_meta WHERE key = 'schema_version'").get()
      );
      assert.ok(version.ok && version.value && Number(version.value.value) === LATEST_SCHEMA_VERSION, `fresh: ${JSON.stringify(version)}`);
      const tables = store.transaction("tables", (tx) =>
        tx.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='world_sov_projection_log'").get()
      );
      assert.ok(tables.ok && tables.value, "fresh: world_sov_projection_log table exists");
    });
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lne-sovlog-slice-"));
    const file = path.join(tmp, "world.sqlite");
    const driver = loadDriver();
    assert.ok(driver.ok, driver.detail);
    try {
      seedDbFile(driver, file, { migrations: MIGRATIONS.slice(0, 23), seed: 1 });
      const opened23 = openStore({
        filePath: file,
        openDatabase: (f) => new driver.Database(f),
        exclusiveLock: true,
        busyTimeoutMs: 0,
        maxRowsPerTransaction: 500,
        maxWriteMsPerPass: 5,
        randomSeed: () => 1,
        migrations: MIGRATIONS.slice(0, 23),
      });
      assert.ok(opened23.ok, JSON.stringify(opened23));
      const ver23 = opened23.store.transaction("ver23", (tx) =>
        tx.prepare("SELECT value FROM lne_meta WHERE key = 'schema_version'").get()
      );
      assert.ok(ver23.ok && ver23.value && Number(ver23.value.value) === 23, `slice: ${JSON.stringify(ver23)}`);
      const tables23 = opened23.store.transaction("tables23", (tx) =>
        tx.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='world_sov_projection_log'").get()
      );
      assert.ok(tables23.ok && !tables23.value, "slice: world_sov_projection_log table does NOT exist at v23");
      opened23.store.close("slice-test");
      const openedFull = openStore({
        filePath: file,
        openDatabase: (f) => new driver.Database(f),
        exclusiveLock: true,
        busyTimeoutMs: 0,
        maxRowsPerTransaction: 500,
        maxWriteMsPerPass: 5,
        randomSeed: () => 1,
        migrations: MIGRATIONS,
      });
      assert.ok(openedFull.ok, JSON.stringify(openedFull));
      const verFull = openedFull.store.transaction("verFull", (tx) =>
        tx.prepare("SELECT value FROM lne_meta WHERE key = 'schema_version'").get()
      );
      assert.ok(verFull.ok && verFull.value && Number(verFull.value.value) === LATEST_SCHEMA_VERSION, `full: ${JSON.stringify(verFull)}`);
      const tablesFull = openedFull.store.transaction("tablesFull", (tx) =>
        tx.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='world_sov_projection_log'").get()
      );
      assert.ok(tablesFull.ok && tablesFull.value, "full: world_sov_projection_log table EXISTS after migration 24");
      openedFull.store.close("full-test");
    } finally {
      try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch (_e) {}
    }
  });
};