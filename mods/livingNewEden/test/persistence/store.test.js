"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { findServerSrcOnDisk, GAMESTORE_SEARCH_MAX_DEPTH } = require("../../lib/adapter/locator");
const { resolveSqliteDriver } = require("../../lib/adapter/sqliteDriver");
const { resolveConfig } = require("../../config");
const { MIGRATIONS, LATEST_SCHEMA_VERSION } = require("../../lib/persistence/migrations");
const { openStore } = require("../../lib/persistence/store");
const { startPersistence, PERSISTENCE_DEPENDENTS } = require("../../lib/persistence");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const MAX_SEED = 0xFFFFFFFF;

function loadDriver() {
  const found = findServerSrcOnDisk(MOD_DIR, GAMESTORE_SEARCH_MAX_DEPTH, fs.existsSync);
  if (!found.ok) return { ok: false, detail: found.reason };
  return resolveSqliteDriver(found.srcDir);
}

const silentLogger = () => {
  const lines = [];
  return { lines, log: (m) => lines.push(m), logError: (m) => lines.push(m), debug: () => {} };
};

function fakeProcess() {
  const listeners = [];
  const removed = [];
  return {
    listeners, removed,
    once(event, fn) { listeners.push({ event, fn }); },
    removeListener(event, fn) { removed.push({ event, fn }); },
  };
}

function fakeAdapter(driver, { disabled = {}, hookResult } = {}) {
  const calls = { shutdown: [], ownerLost: [] };
  return {
    calls,
    getDisabledModules: () => disabled,
    loadSqliteDriver: () => driver,
    registerShutdownHook(name, fn) {
      calls.shutdown.push({ name, fn });
      return hookResult || { ok: true, unregister() {} };
    },
    onPersistenceOwnerLost(fn) {
      calls.ownerLost.push(fn);
      return { ok: true, unsubscribe() {} };
    },
  };
}

function configFor(tmp, env = {}) {
  return resolveConfig({ env: { EVEJS_DATA_ROOT: tmp, ...env }, modDir: MOD_DIR }).config;
}

function withTmp(fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lne-"));
  const handles = [];
  const keep = (handle) => { handles.push(handle); return handle; };
  try {
    return fn(tmp, keep);
  } finally {
    for (const h of handles) {
      try {
        if (typeof h.close === "function") h.close("test_cleanup");
      } catch (_err) {
      }
    }
    try {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch (_err) {
    }
  }
}

function tableMigration(version, sql, extra = {}) {
  return { version, name: `test_v${version}`, up(db) { db.exec(sql); if (extra.throwAfter) throw new Error("boom"); } };
}

const TEST_VERSION = LATEST_SCHEMA_VERSION + 1;
const TEST_TABLE_V2 = tableMigration(TEST_VERSION,
  "CREATE TABLE lne_test (id INTEGER PRIMARY KEY, uid INTEGER NOT NULL UNIQUE) STRICT");

function storeOpts(file, driver, extra = {}) {
  return {
    filePath: file, openDatabase: (f) => new driver.Database(f), exclusiveLock: true, busyTimeoutMs: 0,
    maxRowsPerTransaction: 500, maxWriteMsPerPass: 5, randomSeed: () => 1, ...extra,
  };
}

module.exports = ({ test, skip }) => {
  const driver = loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  needsDriver("P1 persistence: fresh file migrates to latest, restart re-reads data, world_seed kept as INTEGER", () => {
    withTmp((tmp, keep) => {
      const config = configFor(tmp);
      const list = [...MIGRATIONS, TEST_TABLE_V2];
      const first = startPersistence({ config, adapter: fakeAdapter(driver), modDir: MOD_DIR, logger: silentLogger(),
        processApi: fakeProcess(), migrations: list, randomSeed: () => MAX_SEED });
      assert.ok(first.ok, JSON.stringify(first));
      keep(first.store);
      assert.strictEqual(first.filePath, path.join(tmp, "mods", "livingNewEden", "world.sqlite"));
      assert.ok(fs.existsSync(first.filePath));
      assert.ok(!path.resolve(first.filePath).startsWith(MOD_DIR + path.sep));
      assert.strictEqual(first.schemaVersion, TEST_VERSION);
      assert.strictEqual(LATEST_SCHEMA_VERSION, MIGRATIONS.length);
      assert.strictEqual(first.worldSeed, MAX_SEED);
      const typed = first.store.transaction("check", (db) => db.prepare(
        "SELECT typeof(value) AS t, value FROM lne_meta WHERE key = 'world_seed'").get());
      assert.deepStrictEqual(typed.value, { t: "integer", value: MAX_SEED });
      assert.ok(first.store.transaction("insert", (db) => db.prepare("INSERT INTO lne_test (uid) VALUES (?)").run(42)).ok);
      first.store.close("restart");

      let upCalls = 0;
      const spied = list.map((m) => ({ ...m, up(db, ctx) { upCalls += 1; return m.up(db, ctx); } }));
      const second = startPersistence({ config, adapter: fakeAdapter(driver), modDir: MOD_DIR, logger: silentLogger(),
        processApi: fakeProcess(), migrations: spied, randomSeed: () => 7 });
      assert.ok(second.ok, JSON.stringify(second));
      keep(second.store);
      assert.strictEqual(upCalls, 0);
      assert.strictEqual(second.applied, 0);
      assert.strictEqual(second.worldSeed, MAX_SEED);
      assert.strictEqual(second.store.getWorldSeed(), 4294967295);
      const read = second.store.transaction("read", (db) => db.prepare("SELECT uid FROM lne_test").all());
      assert.deepStrictEqual(read.value, [{ uid: 42 }]);
      assert.ok(!fs.existsSync(`${first.filePath}-shm`), "no -shm after restart");
    });
  });

  needsDriver("P2 persistence: SCHEMA_TOO_NEW disables dependents without writing; failed migration rolls back", () => {
    withTmp((tmp, keep) => {
      const config = configFor(tmp);
      const file = path.join(tmp, "mods", "livingNewEden", "world.sqlite");
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const v2 = openStore(storeOpts(file, driver, { migrations: [...MIGRATIONS, TEST_TABLE_V2] }));
      assert.ok(v2.ok, JSON.stringify(v2));
      v2.store.close("setup");
      const metaOf = (f) => {
        const raw = keep(new driver.Database(f));
        const rows = raw.prepare("SELECT key, value FROM lne_meta ORDER BY key").all();
        raw.close();
        return rows;
      };
      const before = metaOf(file);
      const refused = startPersistence({ config, adapter: fakeAdapter(driver), modDir: MOD_DIR, logger: silentLogger(),
        processApi: fakeProcess() });
      assert.strictEqual(refused.ok, false);
      assert.strictEqual(refused.reason, "SCHEMA_TOO_NEW");
      assert.strictEqual(refused.disabledModules.world, "dependency_disabled:persistence");
      const after = metaOf(file);
      assert.deepStrictEqual(after, before);
      assert.strictEqual(after.find((r) => r.key === "schema_version").value, TEST_VERSION);

      const fresh = path.join(tmp, "fresh.sqlite");
      const broken = openStore(storeOpts(fresh, driver, {
        migrations: [...MIGRATIONS,
          tableMigration(TEST_VERSION, "CREATE TABLE lne_broken (id INTEGER) STRICT", { throwAfter: true })],
      }));
      assert.strictEqual(broken.ok, false);
      assert.strictEqual(broken.reason, "MIGRATION_FAILED");
      const raw = keep(new driver.Database(fresh));
      const tables = raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
      raw.close();
      assert.deepStrictEqual(tables, [], "no lne_meta, no v2 table: version 0");

      const foreign = path.join(tmp, "foreign.sqlite");
      const setup = keep(new driver.Database(foreign));
      setup.exec("CREATE TABLE someone_else (id INTEGER)");
      setup.close();
      const refusedForeign = openStore(storeOpts(foreign, driver));
      assert.strictEqual(refusedForeign.reason, "DB_FOREIGN");
      const check = keep(new driver.Database(foreign));
      assert.strictEqual(check.pragma("journal_mode", { simple: true }), "delete");
      check.close();
    });
  });

  needsDriver("P3 persistence: transaction rollback, TX_CONSTRAINT, TX_ROW_LIMIT, TX_NESTED, onTiming", () => {
    withTmp((tmp, keep) => {
      const timings = [];
      const opened = openStore(storeOpts(path.join(tmp, "tx.sqlite"), driver, {
        migrations: [...MIGRATIONS, TEST_TABLE_V2], maxRowsPerTransaction: 2,
        onTiming: (name, ms, outcome, rows, why, failure) => timings.push([name, ms, outcome, failure]),
      }));
      assert.ok(opened.ok, JSON.stringify(opened));
      const store = keep(opened.store);
      const insert = (db, uid) => db.prepare("INSERT INTO lne_test (uid) VALUES (?)").run(uid);
      const count = () => store.transaction("count", (db) => db.prepare("SELECT count(*) AS n FROM lne_test").get().n).value;

      const thrown = store.transaction("t1", (db) => { insert(db, 1); throw new Error("callback boom"); });
      assert.strictEqual(thrown.reason, "TX_FAILED");
      assert.strictEqual(count(), 0);

      const dup = store.transaction("dup", (db) => { insert(db, 5); insert(db, 5); });
      assert.strictEqual(dup.reason, "TX_CONSTRAINT");
      assert.strictEqual(dup.code, "SQLITE_CONSTRAINT_UNIQUE");
      assert.strictEqual(count(), 0);

      const tooMany = store.transaction("many", (db) => { insert(db, 1); insert(db, 2); insert(db, 3); });
      assert.strictEqual(tooMany.reason, "TX_ROW_LIMIT");
      assert.strictEqual(count(), 0);

      let inner;
      const outer = store.transaction("outer", (db) => {
        insert(db, 9);
        inner = store.transaction("inner", () => 1);
        return 2;
      });
      assert.strictEqual(inner.reason, "TX_NESTED");
      assert.deepStrictEqual([outer.ok, outer.reason, outer.rows], [false, "TX_NESTED", 1]);
      assert.strictEqual(count(), 0);

      const t1 = timings.find(([name]) => name === "t1");
      assert.ok(t1 && t1[1] >= 0, "onTiming(t1, ms)");
      assert.deepStrictEqual(t1.slice(2), ["TX_FAILED", { code: null, message: "callback boom", reason: null }]);
      const d = timings.find(([name]) => name === "dup");
      assert.strictEqual(d[2], "TX_CONSTRAINT");
      assert.strictEqual(d[3].code, "SQLITE_CONSTRAINT_UNIQUE");
      assert.ok(/UNIQUE/.test(d[3].message), d[3].message);
      assert.strictEqual(timings.find(([name]) => name === "many")[3], undefined, "TX_ROW_LIMIT: no failure");
      const sentinel = store.transaction("rb", () => { throw Object.assign(new Error("rolled"), { reason: "NOPE" }); });
      assert.strictEqual(sentinel.reason, "TX_FAILED");
      assert.strictEqual(timings.find(([name]) => name === "rb")[3].reason, "NOPE");
      assert.ok(timings.some(([name]) => name === "open") && timings.some(([name]) => name === "migrate"));
    });
  });

  needsDriver("P4 persistence: second writer DB_LOCKED, shutdown hook closes, owner lost suspends, rejected hook", () => {
    withTmp((tmp, keep) => {
      const config = configFor(tmp, { EVEJS_LNE_PERSISTENCE_BUSY_TIMEOUT_MS: "300" });
      const start = (adapter, processApi = fakeProcess()) => {
        const result = startPersistence({ config, adapter, modDir: MOD_DIR, logger: silentLogger(), processApi });
        if (result.ok) keep(result.store);
        return result;
      };
      const adapterA = fakeAdapter(driver);
      const processA = fakeProcess();
      const a = start(adapterA, processA);
      assert.ok(a.ok, JSON.stringify(a));
      assert.strictEqual(a.store.lockingMode, "exclusive");
      const lockedAt = Date.now();
      const locked = start(fakeAdapter(driver));
      const lockedMs = Date.now() - lockedAt;
      assert.strictEqual(locked.ok, false);
      assert.strictEqual(locked.reason, "DB_LOCKED");
      assert.ok(lockedMs < 450, `DB_LOCKED after ${lockedMs} ms`);

      assert.strictEqual(adapterA.calls.shutdown[0].name, "livingNewEden");
      adapterA.calls.shutdown[0].fn("SIGTERM");
      assert.strictEqual(a.store.isOpen(), false);
      assert.strictEqual(a.store.transaction("late", () => 1).reason, "STORE_CLOSED");
      assert.strictEqual(processA.removed.length, 1);
      assert.strictEqual(processA.removed[0].fn, processA.listeners[0].fn);
      assert.deepStrictEqual(a.store.close("again"), { ok: true, alreadyClosed: true });

      const adapterB = fakeAdapter(driver);
      const b = start(adapterB);
      assert.ok(b.ok, JSON.stringify(b));
      adapterB.calls.ownerLost[0]();
      assert.strictEqual(b.store.transaction("after_lost", () => 1).reason, "STORE_SUSPENDED");
      b.store.close("next");

      const c = start(fakeAdapter(driver, { hookResult: { ok: false, reason: "SHUTDOWN_HOOK_REJECTED" } }));
      assert.ok(c.ok, JSON.stringify(c));
      assert.strictEqual(c.shutdownHook, false);
      assert.strictEqual(c.shutdownHookReason, "SHUTDOWN_HOOK_REJECTED");
    });
  });

  test("P5 persistence without a driver: disabled_by_config, DB_PATH_IN_MOD_DIR, probe_drift", () => {
    withTmp((tmp) => {
      const noDriver = { ok: false, reason: "SQLITE_DRIVER_UNAVAILABLE", detail: "not used" };
      const off = startPersistence({ config: configFor(tmp, { EVEJS_LNE_PERSISTENCE_ENABLED: "0" }),
        adapter: fakeAdapter(noDriver), modDir: MOD_DIR, logger: silentLogger(), processApi: fakeProcess() });
      assert.strictEqual(off.reason, "disabled_by_config");
      assert.ok(!fs.existsSync(path.join(tmp, "mods")), "no directory when disabled");
      for (const name of PERSISTENCE_DEPENDENTS) {
        assert.strictEqual(off.disabledModules[name], "dependency_disabled:persistence", name);
      }
      assert.strictEqual(off.disabledModules.persistence, "disabled_by_config");
      assert.ok(!("graph" in off.disabledModules) && !("telemetry" in off.disabledModules));

      const insideRoot = path.join(MOD_DIR, "lne-test-data-root");
      const inside = startPersistence({ config: configFor(insideRoot), adapter: fakeAdapter(noDriver), modDir: MOD_DIR,
        logger: silentLogger(), processApi: fakeProcess() });
      assert.strictEqual(inside.reason, "DB_PATH_IN_MOD_DIR");
      assert.ok(!fs.existsSync(insideRoot), "nothing created in the mod directory");

      const drift = startPersistence({ config: configFor(tmp),
        adapter: fakeAdapter(noDriver, { disabled: { persistence: "missing: gameStore/index.onPersistenceOwnerLost" } }),
        modDir: MOD_DIR, logger: silentLogger(), processApi: fakeProcess() });
      assert.strictEqual(drift.reason, "probe_drift:missing: gameStore/index.onPersistenceOwnerLost");
      assert.strictEqual(drift.disabledModules.world, "dependency_disabled:persistence");
    });
  });
  needsDriver("T1 store: managed wal_autocheckpoint, rowsSinceCheckpoint, checkpoint(), TX_ACTIVE, closed", () => {
    withTmp((tmp, keep) => {
      const timers = [];
      const setTimer = (fn, ms) => {
        const t = { fn, ms, cancel() { this.cancelled = true; } };
        timers.push(t);
        return t;
      };
      const config = configFor(tmp);
      const started = startPersistence({ config, adapter: fakeAdapter(driver), modDir: MOD_DIR, logger: silentLogger(),
        processApi: fakeProcess(), setTimer });
      assert.ok(started.ok, JSON.stringify(started));
      const store = keep(started.store);
      const pragma = () => store.transaction("t1.pragma", (db) => db.pragma("wal_autocheckpoint", { simple: true }));
      assert.strictEqual(pragma().value, config.persistence.walSafetyPages);
      assert.deepStrictEqual([started.checkpointer.getStatus().state, timers.length], ["running", 1]);
      const before = store.getWalStatus().rowsSinceCheckpoint;
      const r = store.transaction("t1.rows", (db) => {
        db.exec("CREATE TABLE IF NOT EXISTS lne_t1 (id INTEGER PRIMARY KEY) STRICT");
        const ins = db.prepare("INSERT INTO lne_t1 (id) VALUES (?)");
        for (let i = 0; i < 50; i += 1) ins.run(i);
      });
      assert.ok(r.ok, JSON.stringify(r));
      assert.strictEqual(store.getWalStatus().rowsSinceCheckpoint - before, 50);
      const cp = store.checkpoint();
      assert.deepStrictEqual([cp.ok, cp.busy, cp.logFrames > 0, cp.checkpointedFrames], [true, 0, true, cp.logFrames]);
      const wal = store.getWalStatus();
      assert.deepStrictEqual([wal.managed, wal.rowsSinceCheckpoint, typeof wal.lastCheckpointAtMs], [true, 0, "number"]);
      const inner = store.transaction("t1.inner", (db) => {
        db.prepare("INSERT INTO lne_t1 (id) VALUES (?)").run(100);
        return store.checkpoint();
      });
      assert.deepStrictEqual([inner.ok, inner.value], [true, { ok: false, reason: "TX_ACTIVE" }], "tx commits");
      assert.strictEqual(store.transaction("t1.n", (db) => db.prepare("SELECT count(*) AS n FROM lne_t1").get().n)
        .value, 51);
      store.close("t1");
      assert.deepStrictEqual(store.checkpoint(), { ok: false, reason: "STORE_CLOSED" });
      assert.strictEqual(started.checkpointer.getStatus().state, "stopped", "close stops the checkpointer");
      assert.ok(timers[0].cancelled, "timer cancelled");

      const off = startPersistence({ config: configFor(tmp, { EVEJS_LNE_PERSISTENCE_MANAGED_CHECKPOINT: "0" }),
        adapter: fakeAdapter(driver), modDir: MOD_DIR, logger: silentLogger(), processApi: fakeProcess(), setTimer });
      assert.ok(off.ok, JSON.stringify(off));
      keep(off.store);
      assert.strictEqual(off.store.transaction("t1.pragma", (db) => db.pragma("wal_autocheckpoint", { simple: true }))
        .value, 1000);
      assert.deepStrictEqual([off.checkpointer, timers.length, off.store.getWalStatus().managed], [null, 1, false]);
    });
  });
  needsDriver("P6 store.getTxSeq: +1 per started top-level transaction (also a thrown one), not on "
    + "TX_NESTED / STORE_SUSPENDED / STORE_CLOSED", () => {
    withTmp((tmp, keep) => {
      const opened = openStore(storeOpts(path.join(tmp, "seq.sqlite"), driver));
      assert.ok(opened.ok, JSON.stringify(opened));
      const store = keep(opened.store);
      const s0 = store.getTxSeq();
      assert.strictEqual(store.transaction("a", () => store.getTxSeq()).value, s0 + 1, "seq seen inside the tx");
      assert.strictEqual(store.transaction("b", () => { throw new Error("boom"); }).reason, "TX_FAILED");
      assert.strictEqual(store.getTxSeq(), s0 + 2);
      let inner;
      store.transaction("outer", () => { inner = store.transaction("inner", () => 1); });
      assert.strictEqual(inner.reason, "TX_NESTED");
      assert.strictEqual(store.getTxSeq(), s0 + 3, "the nested refusal does not count");
      store.suspend("test");
      assert.strictEqual(store.transaction("c", () => 1).reason, "STORE_SUSPENDED");
      store.close("test");
      assert.strictEqual(store.transaction("d", () => 1).reason, "STORE_CLOSED");
      assert.strictEqual(store.getTxSeq(), s0 + 3);
    });
  });
};
