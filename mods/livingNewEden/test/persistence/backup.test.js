"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { findServerSrcOnDisk, GAMESTORE_SEARCH_MAX_DEPTH } = require("../../lib/adapter/locator");
const { resolveSqliteDriver } = require("../../lib/adapter/sqliteDriver");
const { resolveConfig } = require("../../config");
const { MIGRATIONS } = require("../../lib/persistence/migrations");
const { openStore } = require("../../lib/persistence/store");
const rules = require("../../lib/persistence/backupRules");
const { startBackup } = require("../../lib/persistence/backupService");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const HOUR = 3600000;
const T0 = Date.UTC(2026, 10, 2, 12, 0, 0);
const PAGE = 4096;

function loadDriver() {
  const found = findServerSrcOnDisk(MOD_DIR, GAMESTORE_SEARCH_MAX_DEPTH, fs.existsSync);
  if (!found.ok) return { ok: false, detail: found.reason };
  return resolveSqliteDriver(found.srcDir);
}

function header({ pageSize = PAGE, pageCount = 2, counter = 7, validFor = 7, magic = "SQLite format 3\u0000" } = {}) {
  const b = Buffer.alloc(100);
  b.write(magic, 0, "latin1");
  b.writeUInt16BE(pageSize === 65536 ? 1 : pageSize, 16);
  b.writeUInt32BE(counter, 24);
  b.writeUInt32BE(pageCount, 28);
  b.writeUInt32BE(validFor, 92);
  return b;
}

function dbImage(pageCount) {
  const data = Buffer.alloc(PAGE * pageCount);
  header({ pageCount }).copy(data, 0);
  return data;
}

function enoent() {
  const err = new Error("ENOENT: no such file");
  err.code = "ENOENT";
  return err;
}

function fakeFs(freeBytes) {
  const files = new Map();
  const calls = [];
  const api = {
    files, calls, free: freeBytes,
    put: (p, data) => files.set(path.resolve(p), Buffer.isBuffer(data) ? data : Buffer.from(String(data))),
    has: (p) => files.has(path.resolve(p)),
    names: (dir) => [...files.keys()].filter((k) => path.dirname(k) === path.resolve(dir)).map((k) => path.basename(k)).sort(),
    async mkdir(p) { calls.push(["mkdir", p]); },
    async readdir(dir) { calls.push(["readdir", dir]); return api.names(dir); },
    async stat(p) {
      const f = files.get(path.resolve(p));
      if (!f) throw enoent();
      return { size: f.length, isFile: () => true };
    },
    async statfs() { calls.push(["statfs"]); return { bavail: api.free, bsize: 1 }; },
    async open(p) {
      const f = files.get(path.resolve(p));
      if (!f) throw enoent();
      return { async read(buf, off, len, pos) { f.copy(buf, off, pos, pos + len); return { bytesRead: len }; },
        async close() {} };
    },
    async rename(a, b) {
      const f = files.get(path.resolve(a));
      if (!f) throw enoent();
      files.delete(path.resolve(a));
      files.set(path.resolve(b), f);
    },
    async unlink(p) {
      calls.push(["unlink", path.basename(p)]);
      if (!files.delete(path.resolve(p))) throw enoent();
    },
  };
  return api;
}

function fakeTelemetry() {
  const counts = {};
  const gauges = {};
  const observed = {};
  return { counts, gauges, observed,
    count(n, v = 1) { counts[n] = (counts[n] || 0) + v; },
    gauge(n, v) { gauges[n] = v; },
    observe(n, v) { (observed[n] = observed[n] || []).push(v); } };
}

function fakeGovernor(mode = "NORMAL") {
  const g = { mode,
    getPolicy: () => ({ mode: g.mode, classes: { MAINTENANCE: { admitted: g.mode === "NORMAL" } } }) };
  return g;
}

function manualTimers() {
  const list = [];
  return { list, setTimer(fn, ms) { const t = { fn, ms, cancelled: false }; list.push(t); return { cancel() { t.cancelled = true; } }; } };
}

const DATA = path.resolve(os.tmpdir(), "lne-fake-backup", "data");
const BACKUPS = path.join(DATA, "backups");

function backupSettings(over = {}) {
  const base = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_DATA_ROOT: DATA, EVEJS_LNE_BACKUP_ENABLED: "1" } })
    .config.backup;
  return { ...base, startDelayMs: 0, ...over };
}

function fakeStore(fsApi, { steps = 3, pages = 2, onStep } = {}) {
  const s = { state: "open", calls: 0, filePath: path.join(DATA, "world.sqlite"), getState: () => s.state,
    async backup(dest, opts) {
      s.calls += 1;
      fsApi.put(dest, dbImage(pages));
      for (let i = 0; i < steps; i += 1) {
        if (onStep) onStep(i);
        const code = opts.shouldAbort();
        if (code) return { ok: false, reason: "BACKUP_ABORTED", code };
      }
      return { ok: true, totalPages: pages, ms: 5, steps, maxGapMs: 1, finalStepMs: 2 };
    } };
  return s;
}

function boot({ fsApi, store, settings, wall, governor, telemetry, timers, lines }) {
  return startBackup({ config: { dataDir: DATA, backup: settings }, persistence: { store }, modDir: MOD_DIR,
    getGovernor: () => governor || null, telemetry: telemetry || null,
    logger: { log: (l) => lines && lines.push(l) }, fsApi, setTimer: timers.setTimer, wallNow: () => wall.now,
    perfNow: () => wall.perf || 0 });
}

const nameAt = (ms) => rules.formatBackupName(ms);

module.exports = ({ test }) => {
  const driver = loadDriver();

  test("BK1 backupRules: names round-trip, rotation keeps the newest `keep`, foreign files and tool copies stay", () => {
    const t = Date.UTC(2026, 10, 2, 14, 22, 33, 789);
    assert.strictEqual(nameAt(t), "world-20261102-142233Z.sqlite");
    assert.deepStrictEqual(rules.parseBackupName(nameAt(t)), { ok: true, atMs: t - 789 });
    assert.strictEqual(rules.parseBackupName("world-20261302-142233Z.sqlite").ok, false, "month 13");
    assert.strictEqual(rules.isBackupTmpName(`${nameAt(t)}.tmp`), true);
    assert.strictEqual(rules.isBackupTmpName("world.sqlite.tmp"), false);
    const backups = [1, 2, 3, 4, 5].map((h) => ({ name: nameAt(T0 - h * HOUR), bytes: 10 }));
    const foreign = ["world.sqlite", "world.sqlite-wal", "x.sqlite", `${nameAt(T0)}.tmp`, "world-1.sqlite"]
      .map((name) => ({ name, bytes: 1 }));
    const tools = [
      { name: "world.sqlite.pre-compact-20261001-000000Z", bytes: 100 },
      { name: "world.sqlite.pre-compact-20261020-000000Z", bytes: 100 },
      { name: "world.sqlite.pre-reset-20260901-000000Z", bytes: 100 },
      { name: "other.sqlite.pre-reset-20260901-000000Z", bytes: 100 },
    ];
    const p0 = rules.planRotation([...foreign, ...backups, ...tools],
      { keep: 3, pruneToolCopiesDays: 0, nowMs: T0, dbFile: "world.sqlite" });
    assert.deepStrictEqual(p0.deleteBackups, [nameAt(T0 - 4 * HOUR), nameAt(T0 - 5 * HOUR)]);
    assert.deepStrictEqual(p0.backups.map((b) => b.name), [1, 2, 3, 4, 5].map((h) => nameAt(T0 - h * HOUR)));
    assert.strictEqual(p0.newestAtMs, T0 - HOUR);
    assert.deepStrictEqual(p0.deleteToolCopies, []);
    assert.strictEqual(p0.toolCopies.length, 3, "other.sqlite copies are not ours");
    const p1 = rules.planRotation([...foreign, ...tools], { keep: 3, pruneToolCopiesDays: 7, nowMs: T0, dbFile: "world.sqlite" });
    assert.deepStrictEqual(p1.deleteToolCopies, ["world.sqlite.pre-compact-20261001-000000Z"]);
    assert.deepStrictEqual(p1.deleteBackups, []);
    assert.strictEqual(p1.newestAtMs, null);
    const p2 = rules.planRotation([{ ...backups[0], where: "db" }, { ...tools[0], where: "backups" }],
      { keep: 1, pruneToolCopiesDays: 1, nowMs: T0, dbFile: "world.sqlite" });
    assert.deepStrictEqual([p2.backups.length, p2.toolCopies.length], [0, 0]);
    const d = (over, p = { intervalMs: 6 * HOUR, startDelayMs: 600000, retryMs: 900000 }) => rules.decideBackup({
      newestAtMs: null, startedAtMs: T0, nowMs: T0 + HOUR, lastFailAtMs: null, governor: null, inFlight: false,
      ...over }, p);
    assert.deepStrictEqual(d({}), { run: true });
    assert.strictEqual(d({ nowMs: T0 + 1000 }).reason, "START_DELAY");
    assert.strictEqual(d({ newestAtMs: T0 }).reason, "NOT_DUE");
    assert.deepStrictEqual(d({ newestAtMs: T0 + 2 * HOUR }), { run: true }, "a file from the future is due");
    assert.strictEqual(d({ lastFailAtMs: T0 + HOUR - 1000 }).reason, "RETRY_WAIT");
    assert.strictEqual(d({ governor: { admitted: false } }).reason, "GOVERNOR");
    assert.strictEqual(d({ inFlight: true }).reason, "IN_FLIGHT");
    assert.strictEqual(rules.requiredFreeBytes(1000, 1, 1.5, 1), 1502 + 1048576);
  });

  test("BK2 checkHeader: valid, bad magic, page_size 1 = 65536, size / pages mismatch, stale count", () => {
    assert.deepStrictEqual(rules.checkHeader(header(), 2 * PAGE, 2), { ok: true, pageSize: PAGE, pageCount: 2 });
    assert.strictEqual(rules.checkHeader(header({ magic: "SQLite format 4\u0000" }), 2 * PAGE, 2).reason, "BAD_MAGIC");
    assert.deepStrictEqual(rules.checkHeader(header({ pageSize: 65536, pageCount: 3 }), 3 * 65536, 3),
      { ok: true, pageSize: 65536, pageCount: 3 });
    assert.strictEqual(rules.checkHeader(header({ pageSize: 1000 }), 2000, 2).reason, "BAD_PAGE_SIZE");
    assert.strictEqual(rules.checkHeader(header(), 2 * PAGE + 1, 2).reason, "SIZE_MISMATCH");
    assert.strictEqual(rules.checkHeader(header(), 2 * PAGE, 3).reason, "PAGES_MISMATCH");
    assert.strictEqual(rules.checkHeader(header({ validFor: 6 }), 2 * PAGE, 2).reason, "STALE_COUNT");
    assert.strictEqual(rules.checkHeader(Buffer.alloc(10), 0, 0).reason, "BAD_MAGIC");
  });

  test("BK3 backupService: copy + rotation, governor abort = deferred + retry, no space = alarm, restart", async () => {
    {
      const fsApi = fakeFs(1e12);
      fsApi.put(path.join(DATA, "world.sqlite"), dbImage(2));
      fsApi.put(path.join(DATA, "world.sqlite-wal"), "wal");
      for (const h of [7, 13, 19]) fsApi.put(path.join(BACKUPS, nameAt(T0 - h * HOUR)), dbImage(2));
      fsApi.put(path.join(BACKUPS, "notes.txt"), "keep me");
      const wall = { now: T0 };
      const timers = manualTimers();
      const telemetry = fakeTelemetry();
      const lines = [];
      const store = fakeStore(fsApi);
      const started = boot({ fsApi, store, settings: backupSettings(), wall, telemetry, timers, lines,
        governor: fakeGovernor() });
      assert.ok(started.ok, JSON.stringify(started));
      assert.strictEqual(timers.list.length, 1, "first poll timer");
      const r = await started.backup.runNow();
      assert.strictEqual(r.ok, true, JSON.stringify(r));
      assert.strictEqual(r.file, nameAt(T0));
      assert.deepStrictEqual(fsApi.names(BACKUPS), [nameAt(T0 - 13 * HOUR), nameAt(T0 - 7 * HOUR), nameAt(T0),
        "notes.txt"].sort());
      assert.ok(fsApi.has(path.join(DATA, "world.sqlite")) && fsApi.has(path.join(DATA, "world.sqlite-wal")));
      const st = started.backup.getStatus();
      assert.deepStrictEqual([st.state, st.dir, st.files, st.counts.ok, st.counts.failed], ["idle", "backups", 3, 1, 0]);
      assert.strictEqual(telemetry.counts["persistence.backup.ok"], 1);
      assert.strictEqual(telemetry.gauges["persistence.backup.files"], 3);
      assert.strictEqual(telemetry.gauges["persistence.backup.enabled"], 1);
      assert.deepStrictEqual(telemetry.observed["persistence.backup.finalStepMs"], [2]);
      assert.ok(lines.some((l) => l.startsWith(`backup: ok file=${nameAt(T0)} pages=2 bytes=${2 * PAGE} `)
        && l.endsWith("deleted=1")), lines.join("\n"));
      assert.ok(!lines.some((l) => l.includes(DATA)), "no host path in the log");
      started.backup.stop("test");
    }
    {
      const fsApi = fakeFs(1e12);
      fsApi.put(path.join(DATA, "world.sqlite"), dbImage(2));
      const governor = fakeGovernor("NORMAL");
      const wall = { now: T0 };
      const telemetry = fakeTelemetry();
      const store = fakeStore(fsApi, { onStep: (i) => { if (i === 1) governor.mode = "SHED"; } });
      const settings = backupSettings();
      const started = boot({ fsApi, store, settings, wall, telemetry, timers: manualTimers(), governor });
      const r = await started.backup.runNow();
      assert.deepStrictEqual([r.reason, r.code], ["BACKUP_ABORTED", "GOVERNOR"]);
      assert.deepStrictEqual(fsApi.names(BACKUPS), [], ".tmp removed");
      const st = started.backup.getStatus();
      assert.deepStrictEqual([st.counts.deferred, st.counts.failed, st.consecutiveFailures], [1, 0, 0]);
      assert.strictEqual(telemetry.counts["persistence.backup.failed"], 0, "registered at 0, no alarm");
      governor.mode = "NORMAL";
      wall.now = T0 + settings.retryMs - 1000;
      assert.strictEqual((await started.backup.runNow()).reason, "RETRY_WAIT");
      wall.now = T0 + settings.retryMs;
      const okStore = fakeStore(fsApi);
      store.backup = okStore.backup;
      const again = await started.backup.runNow();
      assert.strictEqual(again.ok, true, JSON.stringify(again));
      started.backup.stop("test");
    }
    {
      const fsApi = fakeFs(1000);
      fsApi.put(path.join(DATA, "world.sqlite"), dbImage(2));
      const telemetry = fakeTelemetry();
      const store = fakeStore(fsApi);
      const started = boot({ fsApi, store, settings: backupSettings(), wall: { now: T0 }, telemetry,
        timers: manualTimers() });
      const r = await started.backup.runNow();
      assert.strictEqual(r.reason, "BACKUP_NO_SPACE");
      assert.strictEqual(store.calls, 0);
      const st = started.backup.getStatus();
      assert.deepStrictEqual([st.counts.noSpace, st.counts.failed, st.consecutiveFailures], [1, 1, 1]);
      assert.strictEqual(telemetry.counts["persistence.backup.failed"], 1);
      started.backup.stop("test");
    }
    {
      const fsApi = fakeFs(1e12);
      fsApi.put(path.join(DATA, "world.sqlite"), dbImage(2));
      fsApi.put(path.join(BACKUPS, nameAt(T0 - HOUR)), dbImage(2));
      fsApi.put(path.join(BACKUPS, `${nameAt(T0 - HOUR + 1000)}.tmp`), "partial");
      fsApi.put(path.join(BACKUPS, "other.sqlite.tmp"), "not ours");
      const store = fakeStore(fsApi);
      const started = boot({ fsApi, store, settings: backupSettings({ intervalMs: 6 * HOUR }), wall: { now: T0 },
        timers: manualTimers() });
      const r = await started.backup.runNow();
      assert.strictEqual(r.reason, "NOT_DUE");
      assert.strictEqual(store.calls, 0);
      assert.deepStrictEqual(fsApi.names(BACKUPS), [nameAt(T0 - HOUR), "other.sqlite.tmp"].sort());
      store.state = "closed";
      started.backup.stop("shutdown:SIGTERM");
      assert.strictEqual(started.backup.getStatus().state, "stopped");
      assert.strictEqual((await started.backup.runNow()).reason, "STOPPED");
    }
  });

  test("BK6: clock moved back, stop + closed db, db files skipped, hung copy",
    async () => {
      const settle = () => new Promise((resolve) => setImmediate(resolve));
      const dbName = nameAt(T0 - HOUR);
      const live = [dbName, `${dbName}-wal`, `${dbName}-shm`].map((name) => ({ name, bytes: 1 }));
      const pr = rules.planRotation([...live, { name: nameAt(T0 - 2 * HOUR), bytes: 1 }],
        { keep: 1, pruneToolCopiesDays: 0, nowMs: T0, dbFile: dbName });
      assert.deepStrictEqual([pr.backups.map((b) => b.name), pr.deleteBackups], [[nameAt(T0 - 2 * HOUR)], []]);
      {
        const fsApi = fakeFs(1e12);
        fsApi.put(path.join(DATA, "world.sqlite"), dbImage(2));
        const future = [1, 2, 3].map((d) => nameAt(T0 + d * 24 * HOUR));
        for (const n of future) fsApi.put(path.join(BACKUPS, n), dbImage(2));
        const wall = { now: T0 };
        const store = fakeStore(fsApi);
        const settings = backupSettings({ keep: 3 });
        const started = boot({ fsApi, store, settings, wall, timers: manualTimers() });
        const r = await started.backup.runNow();
        assert.strictEqual(r.ok, true, JSON.stringify(r));
        assert.deepStrictEqual(fsApi.names(BACKUPS), [nameAt(T0), future[1], future[2]].sort(), "new copy stays");
        wall.now = T0 + settings.pollMs;
        assert.strictEqual((await started.backup.runNow()).reason, "NOT_DUE");
        assert.strictEqual(store.calls, 1, "no copy every pollMs");
        started.backup.stop("test");
      }
      {
        const fsApi = fakeFs(1e12);
        fsApi.put(path.join(DATA, "world.sqlite"), dbImage(2));
        const telemetry = fakeTelemetry();
        const lines = [];
        let svc = null;
        const store = fakeStore(fsApi);
        store.backup = async (dest) => {
          fsApi.put(dest, dbImage(2));
          svc.stop("shutdown:SIGTERM");
          store.state = "closed";
          return { ok: false, reason: "BACKUP_FAILED", code: "SQLITE_MISUSE" };
        };
        const started = boot({ fsApi, store, settings: backupSettings(), wall: { now: T0 }, telemetry,
          timers: manualTimers(), lines });
        svc = started.backup;
        const r = await svc.runNow();
        assert.deepStrictEqual([r.reason, r.code], ["BACKUP_ABORTED", "STOPPING"]);
        const st = svc.getStatus();
        assert.deepStrictEqual([st.state, st.counts.deferred, st.counts.failed, st.counts.aborted, st.consecutiveFailures],
          ["stopped", 1, 0, 0, 0]);
        assert.strictEqual(telemetry.counts["persistence.backup.failed"], 0);
        assert.ok(!lines.some((l) => l.startsWith("backup: failed")), lines.join("\n"));
        assert.deepStrictEqual(fsApi.names(BACKUPS), [], ".tmp removed");
      }
      {
        const fsApi = fakeFs(1e12);
        fsApi.put(path.join(DATA, "world.sqlite"), dbImage(2));
        const telemetry = fakeTelemetry();
        const timers = manualTimers();
        const settings = backupSettings();
        const store = fakeStore(fsApi);
        let late = null;
        let tmp = null;
        store.backup = (dest) => {
          tmp = dest;
          fsApi.put(dest, "partial");
          return new Promise((resolve) => { late = resolve; });
        };
        const started = boot({ fsApi, store, settings, wall: { now: T0 }, telemetry, timers });
        const running = started.backup.runNow();
        let dog = null;
        for (let i = 0; i < 50 && !dog; i += 1) {
          await settle();
          dog = timers.list.find((t) => t.ms === settings.maxRunMs && !t.cancelled);
        }
        assert.ok(dog, "watchdog timer of maxRunMs");
        dog.fn();
        const r = await running;
        assert.deepStrictEqual([r.reason, r.code], ["BACKUP_ABORTED", "TIMEOUT"]);
        const st = started.backup.getStatus();
        assert.deepStrictEqual([st.state, st.counts.aborted, st.counts.failed], ["idle", 1, 1]);
        assert.strictEqual(telemetry.counts["persistence.backup.failed"], 1, "alarm");
        assert.deepStrictEqual(fsApi.names(BACKUPS), [], ".tmp removed");
        fsApi.put(tmp, "late");
        late({ ok: true, totalPages: 2 });
        for (let i = 0; i < 5; i += 1) await settle();
        assert.deepStrictEqual(fsApi.names(BACKUPS), [], "late .tmp removed");
        started.backup.stop("test");
        assert.ok(timers.list.every((t) => t.cancelled || t === dog), "no timer left");
      }
      {
        const fsApi = fakeFs(1e12);
        fsApi.put(path.join(DATA, "world.sqlite"), dbImage(2));
        const timers = manualTimers();
        const settings = backupSettings();
        const okRun = boot({ fsApi, store: fakeStore(fsApi), settings, wall: { now: T0 }, timers });
        assert.strictEqual((await okRun.backup.runNow()).ok, true);
        assert.ok(timers.list.filter((t) => t.ms === settings.maxRunMs).every((t) => t.cancelled), "watchdog cancelled");
        okRun.backup.stop("test");
        const fs2 = fakeFs(1e12);
        fs2.put(path.join(DATA, "world.sqlite"), dbImage(2));
        const hung = fakeStore(fs2);
        hung.backup = (dest) => { fs2.put(dest, "partial"); return new Promise(() => {}); };
        const timers2 = manualTimers();
        const started = boot({ fsApi: fs2, store: hung, settings, wall: { now: T0 }, timers: timers2 });
        const running = started.backup.runNow();
        for (let i = 0; i < 50 && !timers2.list.some((t) => t.ms === settings.maxRunMs); i += 1) await settle();
        started.backup.stop("shutdown:SIGTERM");
        const r = await running;
        assert.deepStrictEqual([r.reason, r.code], ["BACKUP_ABORTED", "STOPPING"]);
        const st = started.backup.getStatus();
        assert.deepStrictEqual([st.counts.deferred, st.counts.failed], [1, 0]);
        assert.deepStrictEqual(fs2.names(BACKUPS), []);
        assert.ok(timers2.list.every((t) => t.cancelled), "no timer left");
      }
    });

  test("BK4 store.backup on the real openStore facade: BACKUP_UNSUPPORTED without db.backup, real copy when present",
    async () => {
      assert.ok(driver.ok, `driver: ${driver.detail}`);
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lne-bk4-"));
      const opened = [];
      const open = (file, hide) => {
        const r = openStore({ filePath: file, exclusiveLock: true, busyTimeoutMs: 0, maxRowsPerTransaction: 500,
          maxWriteMsPerPass: 5, randomSeed: () => 1, migrations: MIGRATIONS.slice(0, 1),
          openDatabase: (f) => {
            const db = new driver.Database(f);
            if (hide) db.backup = undefined;
            return db;
          } });
        assert.ok(r.ok, JSON.stringify(r));
        opened.push(r.store);
        return r.store;
      };
      try {
        const hidden = open(path.join(tmp, "a.sqlite"), true);
        assert.strictEqual(typeof hidden.backup, "function", "facade has backup");
        assert.deepStrictEqual(await hidden.backup(path.join(tmp, "a-copy.sqlite"), { pagesPerStep: 1 }),
          { ok: false, reason: "BACKUP_UNSUPPORTED" });
        hidden.close("test");
        const probe = new driver.Database(":memory:");
        const native = typeof probe.backup === "function";
        probe.close();
        if (!native) return;
        const store = open(path.join(tmp, "b.sqlite"), false);
        assert.ok(store.transaction("seed", (db) => {
          db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v BLOB NOT NULL)");
          const ins = db.prepare("INSERT INTO t (v) VALUES (?)");
          for (let i = 0; i < 100; i += 1) ins.run(Buffer.alloc(2000, i));
        }).ok);
        let calls = 0;
        const dest = path.join(tmp, "b-copy.sqlite");
        const r = await store.backup(dest, { pagesPerStep: 1, shouldAbort: () => {
          calls += 1;
          if (calls === 3) {
            assert.ok(store.transaction("marker", (db) => db.prepare("INSERT INTO t (v) VALUES (?)").run(Buffer.from("m"))).ok);
          }
          return null;
        } });
        assert.strictEqual(r.ok, true, JSON.stringify(r));
        assert.ok(r.steps >= 3 && r.totalPages > 3, JSON.stringify(r));
        const head = Buffer.alloc(100);
        const fd = fs.openSync(dest, "r");
        fs.readSync(fd, head, 0, 100, 0);
        fs.closeSync(fd);
        assert.strictEqual(rules.checkHeader(head, fs.statSync(dest).size, r.totalPages).ok, true);
        const copy = new driver.Database(dest);
        const n = copy.prepare("SELECT count(*) AS n FROM t").get().n;
        copy.close();
        assert.strictEqual(n, 101, "the write between two steps is in the copy");
        const aborted = await store.backup(path.join(tmp, "b-abort.sqlite"),
          { pagesPerStep: 1, shouldAbort: () => "GOVERNOR" });
        assert.deepStrictEqual(aborted, { ok: false, reason: "BACKUP_ABORTED", code: "GOVERNOR" });
      } finally {
        for (const s of opened) s.close("test_cleanup");
        try {
          fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
        } catch (_err) {
        }
      }
    });

  test("BK5 config: defaults without warnings, relative backup.dir warned; off = no timer, no file; dir in modDir",
    () => {
      const bare = resolveConfig({ modDir: MOD_DIR, env: {} });
      assert.deepStrictEqual(bare.warnings, []);
      assert.deepStrictEqual([bare.config.backup.enabled, bare.config.backup.dir, bare.config.backup.keep],
        [false, "", 3]);
      const rel = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_BACKUP_DIR: "backups" } });
      assert.ok(rel.warnings.some((w) => w.includes("EVEJS_LNE_BACKUP_DIR")), rel.warnings.join("\n"));
      assert.strictEqual(rel.config.backup.dir, "");
      const fsApi = fakeFs(1e12);
      const timers = manualTimers();
      const off = startBackup({ config: { dataDir: DATA, backup: bare.config.backup }, persistence: { store: fakeStore(fsApi) },
        modDir: MOD_DIR, fsApi, setTimer: timers.setTimer });
      assert.deepStrictEqual(off, { ok: false, reason: "disabled_by_config" });
      assert.deepStrictEqual([timers.list.length, fsApi.calls.length], [0, 0]);
      const inMod = startBackup({ config: { dataDir: DATA, backup: backupSettings({ dir: path.join(MOD_DIR, "backups") }) },
        persistence: { store: fakeStore(fsApi) }, modDir: MOD_DIR, fsApi, setTimer: timers.setTimer });
      assert.strictEqual(inMod.reason, "BACKUP_DIR_IN_MOD_DIR");
      assert.deepStrictEqual([timers.list.length, fsApi.calls.length], [0, 0]);
    });
};
