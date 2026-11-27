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
const { runPacedBackup } = require("../../lib/persistence/pacedBackup");
const { createCheckpointer, decideCheckpoint } = require("../../lib/persistence/checkpointer");
const { startBackup } = require("../../lib/persistence/backupService");
const rules = require("../../lib/persistence/backupRules");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const PAGE = 4096;
const T0 = Date.UTC(2026, 10, 11, 12, 0, 0);
const DATA = path.resolve(os.tmpdir(), "lne-fake-paced", "data");
const BACKUPS = path.join(DATA, "backups");

const OPTS = Object.freeze({ pagesPerStep: 64, minPagesPerStep: 8, maxPagesPerStep: 256, stepTargetMs: 25,
  stepGapMs: 20, governorPauseMs: 5000, maxPauseMs: 300000 });

function fakeHandle(totalPages, clock, stepMs, { throwAt } = {}) {
  const h = { remaining: totalPages, used: [], closes: 0,
    transfer(n) {
      const i = h.used.length;
      if (throwAt === i) {
        const err = new Error("disk I/O error");
        err.code = "SQLITE_IOERR";
        throw err;
      }
      h.used.push(n);
      clock.now += stepMs(i, n);
      h.remaining = Math.max(0, h.remaining - n);
      return { totalPages, remainingPages: h.remaining };
    },
    close() { h.closes += 1; } };
  return h;
}

function manualLoop() {
  const armed = [];
  const delays = [];
  return { delays,
    setTimer(fn, ms) {
      assert.strictEqual(armed.length, 0, "never two steps armed at once");
      armed.push(fn);
      delays.push(ms);
      return { cancel() {} };
    },
    async run(limit = 10000) {
      for (let i = 0; i < limit && armed.length > 0; i += 1) armed.shift()();
    } };
}

function paced(handle, clock, loop, over = {}) {
  return runPacedBackup(handle, { ...OPTS, shouldAbort: () => null, shouldPause: () => false,
    nowMs: () => clock.now, setTimer: loop.setTimer, ...over });
}

function loadDriver() {
  const found = findServerSrcOnDisk(MOD_DIR, GAMESTORE_SEARCH_MAX_DEPTH, fs.existsSync);
  if (!found.ok) return { ok: false, detail: found.reason };
  return { ...resolveSqliteDriver(found.srcDir), srcDir: found.srcDir };
}

function dbImage(pageCount) {
  const b = Buffer.alloc(PAGE * pageCount);
  b.write("SQLite format 3\u0000", 0, "latin1");
  b.writeUInt16BE(PAGE, 16);
  b.writeUInt32BE(7, 24);
  b.writeUInt32BE(pageCount, 28);
  b.writeUInt32BE(7, 92);
  return b;
}

function enoent() {
  const err = new Error("ENOENT");
  err.code = "ENOENT";
  return err;
}

function fakeFs() {
  const files = new Map();
  const api = {
    put: (p, data) => files.set(path.resolve(p), data),
    names: (dir) => [...files.keys()].filter((k) => path.dirname(k) === path.resolve(dir)).map((k) => path.basename(k)),
    async mkdir() {},
    async readdir(dir) { return api.names(dir); },
    async stat(p) {
      const f = files.get(path.resolve(p));
      if (!f) throw enoent();
      return { size: f.length, isFile: () => true };
    },
    async statfs() { return { bavail: 1e12, bsize: 1 }; },
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
    async unlink(p) { if (!files.delete(path.resolve(p))) throw enoent(); },
  };
  return api;
}

module.exports = ({ test, skip }) => {
  test("PB1 runPacedBackup: AIMD to min on slow steps and to max on fast ones, gaps by setTimer, close() once",
    async () => {
      const clock = { now: 0 };
      const loop = manualLoop();
      const handle = fakeHandle(3000, clock, (i) => (i < 6 ? 100 : 1));
      const pending = paced(handle, clock, loop);
      await loop.run();
      const r = await pending;
      assert.strictEqual(r.ok, true, JSON.stringify(r));
      assert.deepStrictEqual(handle.used.slice(0, 8), [64, 32, 16, 8, 8, 8, 8, 16]);
      assert.strictEqual(Math.max(...handle.used), 256, "grows to maxPagesPerStep");
      assert.strictEqual(handle.used.reduce((a, b) => a + b, 0) >= 3000, true);
      assert.deepStrictEqual([r.maxStepMs, r.minPagesUsed, r.steps, r.pauses, r.pausedMs, r.paced, r.totalPages],
        [100, 8, handle.used.length, 0, 0, true, 3000]);
      assert.strictEqual(r.finalStepMs, 1);
      assert.strictEqual(loop.delays[0], 0, "first step through setTimer(…, 0)");
      assert.ok(loop.delays.slice(1).every((ms) => ms === OPTS.stepGapMs), loop.delays.join(","));
      assert.strictEqual(loop.delays.length, handle.used.length, "one timer per step");
      assert.strictEqual(handle.closes, 1, "close() exactly once");
    });

  test("PB2 runPacedBackup: pause instead of abort, maxPauseMs -> GOVERNOR, STOPPING, transfer throw", async () => {
    {
      const clock = { now: 0 };
      const loop = manualLoop();
      const handle = fakeHandle(200, clock, () => 5);
      let asks = 0;
      const pending = paced(handle, clock, loop, { shouldPause: () => { asks += 1; return asks === 2 || asks === 3; } });
      await loop.run();
      const r = await pending;
      assert.strictEqual(r.ok, true, JSON.stringify(r));
      assert.deepStrictEqual([r.pauses, r.pausedMs], [2, 2 * OPTS.governorPauseMs]);
      assert.deepStrictEqual(loop.delays.slice(0, 4), [0, OPTS.stepGapMs, OPTS.governorPauseMs, OPTS.governorPauseMs]);
      assert.strictEqual(handle.closes, 1);
    }
    {
      const clock = { now: 0 };
      const loop = manualLoop();
      const handle = fakeHandle(200, clock, () => 5);
      const pending = paced(handle, clock, loop, { shouldPause: () => true, maxPauseMs: OPTS.governorPauseMs });
      await loop.run();
      assert.deepStrictEqual(await pending, { ok: false, reason: "BACKUP_ABORTED", code: "GOVERNOR", paced: true });
      assert.deepStrictEqual([handle.used.length, handle.closes], [0, 1]);
      const h0 = fakeHandle(200, clock, () => 5);
      const p0 = paced(h0, clock, manualLoop(), { shouldPause: () => true, maxPauseMs: 0, setTimer: (fn) => {
        fn();
        return { cancel() {} };
      } });
      assert.strictEqual((await p0).code, "GOVERNOR");
    }
    {
      const clock = { now: 0 };
      const loop = manualLoop();
      const handle = fakeHandle(200, clock, () => 5);
      const pending = paced(handle, clock, loop, { shouldAbort: () => (handle.used.length >= 1 ? "STOPPING" : null) });
      await loop.run();
      assert.deepStrictEqual(await pending, { ok: false, reason: "BACKUP_ABORTED", code: "STOPPING", paced: true });
      assert.deepStrictEqual([handle.used.length, handle.closes], [1, 1]);
    }
    {
      const clock = { now: 0 };
      const loop = manualLoop();
      const handle = fakeHandle(200, clock, () => 5, { throwAt: 1 });
      const pending = paced(handle, clock, loop);
      await loop.run();
      const r = await pending;
      assert.deepStrictEqual([r.ok, r.reason, r.code, r.paced, handle.closes], [false, "BACKUP_FAILED", "SQLITE_IOERR",
        true, 1]);
    }
  });

  test("PB3 better-sqlite3 vendor fact + real handle through store.backup({paced}); vendor fallback without opener",
    async () => {
      const driver = loadDriver();
      if (!driver.ok) return skip("PB3 paced backup", `no sqlite driver: ${driver.detail}`);
      const pkg = path.join(path.dirname(driver.srcDir), "node_modules", "better-sqlite3");
      const backupJs = fs.readFileSync(path.join(pkg, "lib", "methods", "backup.js"), "utf8");
      for (const fact of ["this[cppdb].backup(this, attachedName, filename, isNewFile)", "backup.transfer(",
        "backup.close()", "remainingPages"]) {
        assert.ok(backupJs.includes(fact), `better-sqlite3 lib/methods/backup.js lost: ${fact}`);
      }
      assert.ok(fs.readFileSync(path.join(pkg, "lib", "util.js"), "utf8").includes("exports.cppdb = Symbol()"),
        "better-sqlite3 lib/util.js lost exports.cppdb = Symbol()");
      assert.strictEqual(typeof driver.openBackupHandle, "function", driver.backupHandleReason);

      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lne-pb3-"));
      const opened = [];
      const open = (file, opener) => {
        const r = openStore({ filePath: file, exclusiveLock: true, busyTimeoutMs: 0, maxRowsPerTransaction: 500,
          maxWriteMsPerPass: 5, randomSeed: () => 1, migrations: MIGRATIONS.slice(0, 1),
          openDatabase: (f) => new driver.Database(f), openBackupHandle: opener });
        assert.ok(r.ok, JSON.stringify(r));
        opened.push(r.store);
        return r.store;
      };
      const setTimer = (fn) => {
        setImmediate(fn);
        return { cancel() {} };
      };
      const knobs = { pagesPerStep: 1, minPagesPerStep: 1, maxPagesPerStep: 2, stepTargetMs: 1000, stepGapMs: 0,
        governorPauseMs: 100, maxPauseMs: 0, paced: true, shouldAbort: () => null, shouldPause: () => false, setTimer };
      try {
        const store = open(path.join(tmp, "p.sqlite"), driver.openBackupHandle);
        assert.ok(store.transaction("seed", (db) => {
          db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v BLOB NOT NULL)");
          const ins = db.prepare("INSERT INTO t (v) VALUES (?)");
          for (let i = 0; i < 60; i += 1) ins.run(Buffer.alloc(2000, i));
        }).ok);
        const dest = path.join(tmp, "p-copy.sqlite.tmp");
        const r = await store.backup(dest, knobs);
        assert.strictEqual(r.ok, true, JSON.stringify(r));
        assert.strictEqual(r.paced, true);
        assert.ok(r.steps > 3 && r.totalPages > 3 && r.minPagesUsed >= 1, JSON.stringify(r));
        const head = Buffer.alloc(100);
        const fd = fs.openSync(dest, "r");
        fs.readSync(fd, head, 0, 100, 0);
        fs.closeSync(fd);
        assert.strictEqual(rules.checkHeader(head, fs.statSync(dest).size, r.totalPages).ok, true);
        const copy = new driver.Database(dest);
        const n = copy.prepare("SELECT count(*) AS n FROM t").get().n;
        copy.close();
        assert.strictEqual(n, 60);

        const legacy = open(path.join(tmp, "q.sqlite"), null);
        const fb = await legacy.backup(path.join(tmp, "q-copy.sqlite.tmp"), knobs);
        assert.strictEqual(fb.ok, true, JSON.stringify(fb));
        assert.strictEqual(typeof fb.pacedFallback, "string");
        assert.strictEqual(fb.paced, undefined, "vendor loop result");
      } finally {
        for (const s of opened) s.close("test_cleanup");
        try {
          fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
        } catch (_err) {
        }
      }
      return undefined;
    });

  test("PB4 backupService: paced -> SHED pauses (shouldPause) and never aborts GOVERNOR; off -> today's options",
    async () => {
      const run = async (pacedFlag, extraResult = {}) => {
        const fsApi = fakeFs();
        fsApi.put(path.join(DATA, "world.sqlite"), dbImage(2));
        const governor = { mode: "NORMAL",
          getPolicy: () => ({ mode: governor.mode, classes: { MAINTENANCE: { admitted: governor.mode === "NORMAL" } } }) };
        const seen = {};
        const store = { filePath: path.join(DATA, "world.sqlite"), getState: () => "open",
          async backup(dest, opts) {
            fsApi.put(dest, dbImage(2));
            seen.keys = Object.keys(opts).sort();
            governor.mode = "SHED";
            seen.abort = opts.shouldAbort();
            seen.pause = typeof opts.shouldPause === "function" ? opts.shouldPause() : undefined;
            if (!pacedFlag) return { ok: false, reason: "BACKUP_ABORTED", code: seen.abort };
            return { ok: true, totalPages: 2, ms: 5, steps: 3, maxGapMs: 1, finalStepMs: 2, maxStepMs: 4, pauses: 1,
              pausedMs: 5000, minPagesUsed: 8, paced: true, ...extraResult };
          } };
        const base = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_DATA_ROOT: DATA, EVEJS_LNE_BACKUP_ENABLED: "1",
          EVEJS_LNE_BACKUP_PACED: pacedFlag ? "1" : "0" } }).config.backup;
        const counts = {};
        const observed = {};
        const lines = [];
        const telemetry = { count(n, v = 1) { counts[n] = (counts[n] || 0) + v; }, gauge() {},
          observe(n, v) { observed[n] = v; } };
        const started = startBackup({ config: { dataDir: DATA, backup: { ...base, startDelayMs: 0 } },
          persistence: { store }, modDir: MOD_DIR, getGovernor: () => governor, telemetry,
          logger: { log: (l) => lines.push(l) }, fsApi, setTimer: () => ({ cancel() {} }), wallNow: () => T0,
          perfNow: () => 0 });
        assert.ok(started.ok, JSON.stringify(started));
        const r = await started.backup.runNow();
        started.backup.stop("test");
        return { r, seen, counts, observed, lines, files: fsApi.names(BACKUPS) };
      };
      const on = await run(true);
      assert.strictEqual(on.r.ok, true, JSON.stringify(on.r));
      assert.deepStrictEqual([on.seen.abort, on.seen.pause], [null, true]);
      assert.ok(on.seen.keys.includes("paced") && on.seen.keys.includes("governorPauseMs"), on.seen.keys.join(","));
      assert.deepStrictEqual([on.r.paced, on.r.maxStepMs, on.r.pauses, on.r.minPagesUsed], [true, 4, 1, 8]);
      assert.deepStrictEqual([on.observed["persistence.backup.maxStepMs"], on.observed["persistence.backup.pauses"],
        on.observed["persistence.backup.pausedMs"]], [4, 1, 5000]);
      assert.ok(on.lines.some((l) => l.startsWith("backup: ok ") && l.endsWith("deleted=0 paced=1 maxStep=4 pauses=1 "
        + "minPages=8")), on.lines.join("\n"));

      const off = await run(false);
      assert.deepStrictEqual(off.seen.keys, ["pagesPerStep", "shouldAbort"], "today's options");
      assert.deepStrictEqual([off.r.reason, off.r.code], ["BACKUP_ABORTED", "GOVERNOR"]);
      assert.ok(off.lines.includes("backup: deferred - GOVERNOR"), off.lines.join("\n"));
      assert.deepStrictEqual(off.files, [], ".tmp removed");

      const fb = await run(true, { pacedFallback: "no backup handle opener", paced: undefined });
      assert.strictEqual(fb.counts["persistence.backup.pacedFallback"], 1);
      assert.ok(fb.lines.includes("backup: paced unavailable - no backup handle opener, using vendor loop"),
        fb.lines.join("\n"));
      assert.ok(fb.lines.some((l) => l.startsWith("backup: ok ") && l.endsWith("deleted=0")), "legacy ok line");
    });

  test("PB5 checkpoint backoff: slowMs 0 = today's table, backoff blocks target/interval not force; runOnce sets it; "
    + "config cross-check", () => {
    const S = { checkpointForceFrames: 4000, checkpointTargetFrames: 600, checkpointMaxIntervalMs: 30000 };
    const wal = (frames, rows, last, backoffUntilMs) => ({ estimatedFrames: frames, rowsSinceCheckpoint: rows,
      lastCheckpointAtMs: last, backoffUntilMs });
    const gov = { mode: "NORMAL", maintenanceAdmitted: true };
    const off = { ...S, checkpointSlowMs: 0 };
    assert.strictEqual(decideCheckpoint(wal(4000, 10, 0, 1e9), null, 1, off), "force");
    assert.strictEqual(decideCheckpoint(wal(600, 10, 0, 1e9), gov, 1, off), "target");
    assert.strictEqual(decideCheckpoint(wal(10, 3, 0, 1e9), gov, 30000, off), "interval");
    assert.strictEqual(decideCheckpoint(wal(3999, 10, 0, 1e9), { mode: "SHED", maintenanceAdmitted: false }, 1, off), null);
    const on = { ...S, checkpointSlowMs: 200 };
    assert.strictEqual(decideCheckpoint(wal(600, 10, 0, 50000), gov, 40000, on), null, "target in backoff");
    assert.strictEqual(decideCheckpoint(wal(10, 3, 0, 50000), gov, 40000, on), null, "interval in backoff");
    assert.strictEqual(decideCheckpoint(wal(4000, 10, 0, 50000), gov, 40000, on), "force", "force ignores backoff");
    assert.strictEqual(decideCheckpoint(wal(600, 10, 0, 50000), gov, 50000, on), "target", "backoff over");
    assert.strictEqual(decideCheckpoint(wal(600, 10, 0, null), gov, 1, on), "target", "no backoff yet");

    let now = 1000;
    const counted = {};
    const store = { getState: () => "open", getWalStatus: () => ({}),
      checkpoint: () => ({ ok: true, ms: 300, logFrames: 10, checkpointedFrames: 10, busy: 0 }) };
    const settings = { ...S, checkpointPollMs: 1000, checkpointAlignToTick: false, checkpointAlignWaitMs: 250,
      checkpointSlowMs: 200, checkpointSlowBackoffMs: 60000 };
    const cp = createCheckpointer({ store, settings, nowMs: () => now, setTimer: () => ({ cancel() {} }),
      metrics: { count: (n, v) => { counted[n] = (counted[n] || 0) + v; }, gauge() {} } });
    assert.strictEqual(cp.runOnce("target").ok, true);
    assert.deepStrictEqual([cp.getStatus().backoffUntilMs, cp.getStatus().backoffs,
      counted["persistence.checkpoints.backoff"]], [61000, 1, 1]);
    now = 2000;
    const fast = createCheckpointer({ store: { ...store, checkpoint: () => ({ ok: true, ms: 199, busy: 0 }) },
      settings, nowMs: () => now, setTimer: () => ({ cancel() {} }), metrics: { count: (n, v) => {
        counted[n] = (counted[n] || 0) + v;
      }, gauge() {} } });
    fast.runOnce("interval");
    assert.deepStrictEqual([fast.getStatus().backoffUntilMs, counted["persistence.checkpoints.backoff"]], [null, 1]);

    const bad = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_BACKUP_PACED: "1",
      EVEJS_LNE_BACKUP_MIN_PAGES_PER_STEP: "300", EVEJS_LNE_BACKUP_MAX_PAGES_PER_STEP: "100" } });
    assert.ok(bad.warnings.some((w) => w.startsWith("backup.minPagesPerStep=300 above maxPagesPerStep=100")),
      bad.warnings.join("\n"));
    assert.deepStrictEqual([bad.config.backup.minPagesPerStep, bad.config.backup.pagesPerStep], [100, 100]);
    assert.deepStrictEqual(resolveConfig({ modDir: MOD_DIR, env: {} }).warnings, [], "defaults: no warning");
  });
};
