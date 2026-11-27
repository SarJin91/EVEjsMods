"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createWarmup } = require("../../lib/persistence/warmup");
const { createCheckpointer } = require("../../lib/persistence/checkpointer");
const { startPersistence } = require("../../lib/persistence");
const { startTelemetry } = require("../../lib/telemetry");
const { findServerSrcOnDisk, GAMESTORE_SEARCH_MAX_DEPTH } = require("../../lib/adapter/locator");
const { resolveSqliteDriver } = require("../../lib/adapter/sqliteDriver");
const { resolveConfig, SCHEMA } = require("../../config");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const FD = 42;
const SETTINGS = Object.freeze({ warmupChunkBytes: 100, warmupPauseMs: 5, warmupMaxBytes: 1000 });

function fakeFs(size, { readError } = {}) {
  const calls = [];
  const queue = [];
  return { calls, queue,
    open(p, flags, cb) { calls.push(["open", flags]); queue.push(() => cb(null, FD)); },
    fstat(fd, cb) { calls.push(["fstat", fd]); queue.push(() => cb(null, { size })); },
    read(fd, buf, off, len, pos, cb) {
      calls.push(["read", fd, len, pos]);
      assert.ok(len <= buf.length, "read fits the one buffer");
      queue.push(() => (readError ? cb(Object.assign(new Error("io"), { code: readError }))
        : cb(null, Math.max(0, Math.min(len, size - pos)))));
    },
    close(fd, cb) { calls.push(["close", fd]); if (typeof cb === "function") cb(null); } };
}

function harness(size, opts = {}) {
  const fsApi = fakeFs(size, opts);
  const timers = [];
  const lines = [];
  const done = [];
  const w = createWarmup({ filePath: "/data/world.sqlite", settings: { ...SETTINGS, ...(opts.settings || {}) },
    fsApi, nowMs: () => 0, logger: { log: (m) => lines.push(m) }, onDone: (r) => done.push(r),
    setTimer: (fn, ms) => { const t = { fn, ms, cancelled: false, cancel() { this.cancelled = true; } };
      timers.push(t); return t; } });
  const drain = (maxSteps = 100) => {
    for (let i = 0; i < maxSteps; i += 1) {
      if (fsApi.queue.length > 0) {
        assert.strictEqual(fsApi.queue.length, 1, "one fs call in flight");
        fsApi.queue.shift()();
        continue;
      }
      const t = timers.find((x) => !x.cancelled && !x.fired);
      if (!t) return;
      t.fired = true;
      t.fn();
    }
    throw new Error("drain did not settle");
  };
  const count = (kind) => fsApi.calls.filter((c) => c[0] === kind).length;
  return { w, fsApi, timers, lines, done, drain, count };
}

function loadDriver() {
  const found = findServerSrcOnDisk(MOD_DIR, GAMESTORE_SEARCH_MAX_DEPTH, fs.existsSync);
  if (!found.ok) return { ok: false, detail: found.reason };
  return resolveSqliteDriver(found.srcDir);
}

function fakeAdapter(driver) {
  return { getDisabledModules: () => ({}), loadSqliteDriver: () => driver,
    registerShutdownHook: () => ({ ok: true, unregister() {} }),
    onPersistenceOwnerLost: () => ({ ok: true, unsubscribe() {} }) };
}

const fakeProcess = () => ({ once() {}, removeListener() {} });

function spyFs(order) {
  return {
    open: (p, flags, cb) => { order.push("open"); fs.open(p, flags, cb); },
    fstat: (fd, cb) => fs.fstat(fd, cb),
    read: (fd, buf, off, len, pos, cb) => fs.read(fd, buf, off, len, pos, cb),
    close: (fd, cb) => { order.push("close"); fs.close(fd, cb); },
  };
}

async function settle(isDone, maxTurns = 2000) {
  for (let i = 0; i < maxTurns && !isDone(); i += 1) await new Promise((r) => setImmediate(r));
}

module.exports = ({ test, skip }) => {
  test("W1 warmup happy path: open, fstat, 3 reads one at a time, done once, fd NOT closed after done", () => {
    const h = harness(250);
    assert.deepStrictEqual(h.w.start(), { ok: true });
    assert.deepStrictEqual(h.w.start(), { ok: false, reason: "already_started" });
    h.drain();
    assert.deepStrictEqual(h.fsApi.calls, [["open", "r"], ["fstat", FD], ["read", FD, 100, 0], ["read", FD, 100, 100],
      ["read", FD, 50, 200]]);
    assert.deepStrictEqual(h.timers.map((t) => t.ms), [5, 5], "a pause between chunks");
    const st = h.w.getStatus();
    assert.strictEqual(st.state, "done");
    assert.strictEqual(st.bytes, 250);
    assert.strictEqual(st.chunks, 3);
    assert.deepStrictEqual(h.done, [{ bytes: 250, ms: 0, chunks: 3, truncated: false }]);
    assert.deepStrictEqual(h.lines, ["persistence: warmup done bytes=250 ms=0 chunks=3"]);
    assert.strictEqual(h.count("close"), 0, "Done keeps the fd open");
    h.w.stop();
    assert.deepStrictEqual(h.fsApi.calls.at(-1), ["close", FD], "stop closes it");
    assert.strictEqual(h.count("close"), 1);
  });

  test("W2 warmup: stop() during a read in flight closes the fd only in that read's callback, once", () => {
    const h = harness(250);
    h.w.start();
    h.fsApi.queue.shift()();
    h.fsApi.queue.shift()();
    assert.strictEqual(h.count("read"), 1);
    h.w.stop();
    assert.strictEqual(h.count("close"), 0, "no close while the threadpool still reads the fd");
    assert.strictEqual(h.w.getStatus().state, "stopped");
    h.fsApi.queue.shift()();
    assert.strictEqual(h.count("close"), 1, "closed in the read callback");
    h.drain();
    assert.strictEqual(h.count("read"), 1, "no read after stop");
    h.w.stop();
    assert.strictEqual(h.count("close"), 1, "second stop is a no-op");
    assert.deepStrictEqual(h.w.start(), { ok: false, reason: "WARMUP_STOPPED" });
    assert.deepStrictEqual(h.done, []);
  });

  const driver = loadDriver();
  const w3Name = "W3 startPersistence: warm-up fd closed after db.close(), warmupEnabled=false opens nothing";
  if (!driver.ok) skip(w3Name, `better-sqlite3 unavailable (${driver.detail})`);
  else test(w3Name, async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lne-w3-"));
    try {
      const order = [];
      const spied = { ...driver, Database: function SpyDatabase(file) {
        const db = new driver.Database(file);
        const realClose = db.close.bind(db);
        db.close = () => { order.push("db.close"); return realClose(); };
        return db;
      } };
      const lines = [];
      const gauges = {};
      const whys = [];
      const config = resolveConfig({ env: { EVEJS_DATA_ROOT: tmp }, modDir: MOD_DIR }).config;
      const on = startPersistence({ config, adapter: fakeAdapter(spied), modDir: MOD_DIR, processApi: fakeProcess(),
        logger: { log: (m) => lines.push(m) }, randomSeed: () => 1, warmupFs: spyFs(order),
        onTiming: (name, ms, outcome, rows, why) => { if (name === "wal.checkpoint") whys.push(why); },
        telemetry: { gauge: (n, v) => { gauges[n] = v; }, count() {}, addTickListener: () => ({ ok: false }) } });
      assert.strictEqual(on.ok, true, on.reason);
      assert.ok(lines.some((l) => l.startsWith("persistence: open ") && l.endsWith(" warmup=on")), lines.join("\n"));
      await settle(() => on.warmup.getStatus().state === "done");
      const st = on.warmup.getStatus();
      assert.strictEqual(st.state, "done");
      assert.strictEqual(st.bytes, fs.statSync(on.filePath).size);
      assert.strictEqual(gauges["persistence.warmupBytes"], st.bytes);
      assert.strictEqual(typeof gauges["persistence.warmupMs"], "number");
      assert.ok(lines.some((l) => l.startsWith(`persistence: warmup done bytes=${st.bytes} `)));
      assert.deepStrictEqual(order, ["open"], "done keeps the fd open");
      assert.strictEqual(on.store.checkpoint("manual").ok, true);
      on.store.checkpoint();
      assert.deepStrictEqual(whys.slice(-2), ["manual", undefined], "C1: the store hands why to onTiming");
      on.store.close("test");
      assert.deepStrictEqual(order, ["open", "db.close", "close"], "The warm-up fd closes after db.close()");

      const offOrder = [];
      const offLines = [];
      const offConfig = resolveConfig({ env: { EVEJS_DATA_ROOT: tmp, EVEJS_LNE_PERSISTENCE_WARMUP_ENABLED: "0" },
        modDir: MOD_DIR }).config;
      const off = startPersistence({ config: offConfig, adapter: fakeAdapter(driver), modDir: MOD_DIR,
        processApi: fakeProcess(), logger: { log: (m) => offLines.push(m) }, randomSeed: () => 1,
        warmupFs: spyFs(offOrder) });
      assert.strictEqual(off.ok, true, off.reason);
      assert.strictEqual(off.warmup, null);
      assert.ok(offLines.some((l) => l.startsWith("persistence: open ") && l.endsWith(" warmup=off")));
      off.store.close("test");
      assert.deepStrictEqual(offOrder, [], "no open with warmupEnabled=false");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  test("W4 warmup: warmupMaxBytes reads only the prefix (truncated); a read error fails once, fd kept to stop", () => {
    const h = harness(1000, { settings: { warmupMaxBytes: 250 } });
    h.w.start();
    h.drain();
    assert.deepStrictEqual(h.fsApi.calls.filter((c) => c[0] === "read").map((c) => c[2] + c[3]), [100, 200, 250]);
    assert.strictEqual(h.w.getStatus().bytes, 250);
    assert.deepStrictEqual(h.done, [{ bytes: 250, ms: 0, chunks: 3, truncated: true }]);
    assert.deepStrictEqual(h.lines, ["persistence: warmup done bytes=250 ms=0 chunks=3 truncated=1"]);

    const e = harness(250, { readError: "EIO" });
    e.w.start();
    e.drain();
    const st = e.w.getStatus();
    assert.strictEqual(st.state, "failed");
    assert.strictEqual(st.reason, "EIO");
    assert.strictEqual(e.count("read"), 1, "no retry");
    assert.deepStrictEqual(e.lines, ["persistence: warmup failed - EIO"]);
    assert.deepStrictEqual(e.done, []);
    assert.strictEqual(e.count("close"), 0, "Failed keeps the fd open until stop");
    e.w.stop();
    e.w.stop();
    assert.strictEqual(e.count("close"), 1);
  });

  test("W5 warmup: stop() before the open callback closes the late fd once, no fstat/read", () => {
    const h = harness(250);
    h.w.start();
    h.w.stop();
    assert.strictEqual(h.count("close"), 0, "fd not known yet");
    h.fsApi.queue.shift()();
    assert.deepStrictEqual(h.fsApi.calls, [["open", "r"], ["close", FD]]);
    h.drain();
    h.w.stop();
    assert.strictEqual(h.count("close"), 1);
    assert.deepStrictEqual(h.done, []);
  });

  const w6Name = "W6 openStore: db.close() throws -> onClose (warm-up stop) not called; clean close calls it";
  if (!driver.ok) skip(w6Name, `better-sqlite3 unavailable (${driver.detail})`);
  else test(w6Name, () => {
    const { openStore } = require("../../lib/persistence/store");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lne-w6-"));
    const handles = [];
    try {
      const run = (name, breakClose) => {
        const calls = [];
        const opened = openStore({ filePath: path.join(tmp, name), exclusiveLock: true, busyTimeoutMs: 0,
          maxRowsPerTransaction: 500, maxWriteMsPerPass: 5, randomSeed: () => 1,
          openDatabase: (f) => {
            const db = new driver.Database(f);
            handles.push(db);
            if (breakClose) db.close = () => { throw new Error("close failed"); };
            return db;
          },
          onClose: (why) => calls.push(why) });
        assert.strictEqual(opened.ok, true, opened.detail);
        return { res: opened.store.close("test"), calls };
      };
      const broken = run("a.sqlite", true);
      assert.strictEqual(broken.res.error.message, "close failed");
      assert.deepStrictEqual(broken.calls, [], "Live connection keeps the warm-up fd");
      const clean = run("b.sqlite", false);
      assert.strictEqual(clean.res.error, undefined);
      assert.deepStrictEqual(clean.calls, ["test"]);
    } finally {
      for (const db of handles) {
        try { delete db.close; db.close(); } catch (_err) {}
      }
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  });

  test("C1 checkpoint why: runOnce(reason) reaches onTiming, slow line has why=, interval default 120000", () => {
    const seen = [];
    const store = { getState: () => "open", getWalStatus: () => ({}),
      checkpoint: (why) => { seen.push(why); return { ok: true, ms: 1, logFrames: 6, checkpointedFrames: 6, busy: 0 }; } };
    const cp = createCheckpointer({ store, settings: {}, nowMs: () => 0 });
    cp.runOnce("interval");
    assert.deepStrictEqual(seen, ["interval"]);

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lne-c1-"));
    const lines = [];
    let t = null;
    try {
      const config = resolveConfig({ env: { EVEJS_DATA_ROOT: tmp }, modDir: MOD_DIR }).config;
      const started = startTelemetry({ config, modDir: MOD_DIR, adapter: null,
        logger: { log: (m) => lines.push(m), logError: (m) => lines.push(m) },
        timers: { setInterval: () => ({ unref() { return this; } }), clearInterval() {} } });
      assert.strictEqual(started.ok, true, started.reason);
      t = started.telemetry;
      const onTiming = t.hooks.onTiming;
      onTiming("wal.checkpoint", config.telemetry.slowOpMs + 50, "ok", 6, "interval");
      onTiming("wal.checkpoint", config.telemetry.slowOpMs + 50, "ok", 6);
      const slow = lines.filter((l) => l.includes(": slow checkpoint wal "));
      assert.strictEqual(slow.length, 2, lines.join("\n"));
      assert.ok(slow[0].endsWith(" frames=6 why=interval"), slow[0]);
      assert.ok(slow[1].endsWith(" frames=6"), slow[1]);
    } finally {
      if (t && typeof t.stop === "function") t.stop();
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
    const key = SCHEMA.find((s) => s.key === "persistence.checkpointMaxIntervalMs");
    assert.strictEqual(key.default, 120000);
  });
};
