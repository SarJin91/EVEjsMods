"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const perfHooks = require("node:perf_hooks");

const { createHistogram } = require("../../lib/telemetry/histogram");
const { createRegistry } = require("../../lib/telemetry/registry");
const { wrapTickSample } = require("../../lib/adapter/tickSample");
const { startTelemetry } = require("../../lib/telemetry");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const NOW_MS = 1700000000000;

function makeConfig(dataDir, overrides = {}) {
  return {
    enabled: true,
    modules: { telemetry: { enabled: overrides.enabled !== false } },
    telemetry: { intervalSeconds: overrides.intervalSeconds || 10, histogramSamples: 64, maxMetrics: 64 },
    dataDir,
  };
}

function fakeTimers() {
  const calls = { set: [], clear: [] };
  return {
    calls,
    setInterval(fn, ms) {
      const handle = { fn, ms, unrefCalled: false, unref() { this.unrefCalled = true; return this; } };
      calls.set.push(handle);
      return handle;
    },
    clearInterval(handle) { calls.clear.push(handle); },
  };
}

function fakePerf() {
  const created = [];
  class FakeObserver {
    constructor(cb) { this.cb = cb; this.connected = false; created.push(this); }
    observe() { this.connected = true; }
    disconnect() { this.connected = false; }
  }
  FakeObserver.supportedEntryTypes = ["gc"];
  return { created, perfHooks: { PerformanceObserver: FakeObserver, constants: perfHooks.constants,
    performance: perfHooks.performance } };
}

function vanillaTidi() {
  return { observeRuntimeTickSample(_sample, _options) { return { changed: false, factor: 1, reason: "disabled" }; } };
}

function tickSummary(i) {
  return { startedAtMonotonicMs: 1000 + i * 100, actualIntervalMs: 100 + i, targetTickIntervalMs: 100,
    tickDurationMs: 2 + i, latenessMs: i, sceneCount: 3, tickedSceneCount: 2, collectedSceneCount: 0 };
}

function fakeAdapter(tidi, disabled = {}) {
  const calls = { subscribe: 0 };
  return { calls, getDisabledModules: () => disabled,
    subscribeTickSamples(onSample) { calls.subscribe += 1; return wrapTickSample(tidi, onSample); } };
}

function withTmp(fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lne-t-"));
  const cleanup = () => {
    try {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch (_err) {
    }
  };
  return Promise.resolve().then(() => fn(tmp)).finally(cleanup);
}

module.exports = ({ test }) => {
  test("T1 histogram ring nearest-rank + span; registry channel whitelist and maxMetrics", () => {
    const h = createHistogram(10);
    assert.deepStrictEqual(h.summarize(), { samples: 0, capacity: 10, spanMs: 0, avg: 0, p50: 0, p95: 0, max: 0 });
    for (let v = 1; v <= 25; v += 1) h.record(v, v * 100);
    h.record(-1);
    h.record(NaN);
    const s = h.summarize();
    assert.strictEqual(s.samples, 10);
    assert.strictEqual(s.p50, 20);
    assert.strictEqual(s.p95, 25);
    assert.strictEqual(s.max, 25);
    assert.strictEqual(s.avg, 20.5);
    assert.strictEqual(s.spanMs, 900, "atMs 1600..2500");
    assert.strictEqual(h.count(), 25);

    const r = createRegistry({ histogramSamples: 8, maxMetrics: 2 });
    assert.strictEqual(r.count("nochannel.x"), false);
    assert.strictEqual(r.count("tick"), false);
    assert.strictEqual(r.read().counters["telemetry.rejectedMetrics"], 2);
    assert.strictEqual(r.count("journal.duplicates", 2), true);
    assert.strictEqual(r.observe("tick.workMs", 3), true);
    assert.strictEqual(r.gauge("persistence.openMs", 1), false, "maxMetrics reached");
    assert.strictEqual(r.count("journal.duplicates"), true, "existing name still counts");
    const read = r.read();
    assert.strictEqual(read.counters["journal.duplicates"], 3);
    assert.strictEqual(read.counters["telemetry.rejectedMetrics"], 3);
    assert.strictEqual(read.histograms["tick.workMs"].max, 3);
    assert.deepStrictEqual(r.rejectedNames(), [{ name: "nochannel.x", reason: "BAD_NAME" },
      { name: "tick", reason: "BAD_NAME" }, { name: "persistence.openMs", reason: "REGISTRY_FULL" }],
      "refused names kept once, with the reason");
    const k = createRegistry({ histogramSamples: 8, maxMetrics: 8 });
    k.count("tick.both");
    assert.strictEqual(k.gauge("tick.both", 1), false);
    k.gauge("tick.both", 2);
    assert.deepStrictEqual(k.rejectedNames(), [{ name: "tick.both", reason: "KIND_CONFLICT" }]);
  });

  test("T2 tick seam: wrap through the module object, sample before original, refusals, DRIFT -> unavailable", () => {
    const tidi = vanillaTidi();
    const original = tidi.observeRuntimeTickSample;
    const got = [];
    const wrap = wrapTickSample(tidi, (s) => got.push(s));
    assert.strictEqual(wrap.ok, true);
    for (let i = 0; i < 3; i += 1) {
      assert.deepStrictEqual(tidi.observeRuntimeTickSample(tickSummary(i)),
        { changed: false, factor: 1, reason: "disabled" });
    }
    assert.strictEqual(got.length, 3);
    assert.deepStrictEqual(got[2], { intervalMs: 102, workMs: 4, latenessMs: 2, sceneCount: 3, tickedSceneCount: 2,
      atMs: 1200 });
    assert.deepStrictEqual(wrapTickSample(tidi, () => {}), { ok: false, reason: "already_wrapped" });
    const ours = tidi.observeRuntimeTickSample;
    tidi.observeRuntimeTickSample = function other(...args) { return ours.apply(this, args); };
    assert.deepStrictEqual(wrapTickSample(tidi, () => {}), { ok: false, reason: "already_wrapped" });
    tidi.observeRuntimeTickSample = ours;
    wrap.unwrap();
    assert.strictEqual(tidi.observeRuntimeTickSample, original);
    assert.deepStrictEqual(wrapTickSample({}, () => {}), { ok: false, reason: "tick_symbol_missing" });
    const frozen = Object.freeze({ observeRuntimeTickSample() {} });
    assert.deepStrictEqual(wrapTickSample(frozen, () => {}), { ok: false, reason: "tick_symbol_not_writable" });

    const { perfHooks: perf } = fakePerf();
    const drifted = fakeAdapter(vanillaTidi(), { telemetry: "missing:utils/tidiAutoscaler" });
    for (const adapter of [
      { getDisabledModules: () => ({}), subscribeTickSamples: () => ({ ok: false, reason: "server_src_unknown" }) },
      drifted,
      null,
    ]) {
      const started = startTelemetry({ config: makeConfig(null), adapter, modDir: MOD_DIR, logger: { log() {} },
        timers: fakeTimers(), perfHooks: perf, clock: { now: () => NOW_MS } });
      assert.strictEqual(started.ok, true);
      const snap = started.telemetry.getSnapshot();
      assert.strictEqual(snap.status.tick, "unavailable");
      assert.ok(snap.status.tickReason, "reason given");
      assert.ok(snap.process.rssBytes > 0);
      assert.strictEqual(snap.status.gc, "ok");
      assert.ok(snap.gc && snap.gc.pauseMs);
      started.telemetry.stop();
    }
    assert.strictEqual(drifted.calls.subscribe, 0, "probe DRIFT: no wrap attempted");
  });

  test("T3 snapshot + hooks + alarms + atomic write; write errors never reject; path in mod dir",
    () => withTmp(async (tmp) => {
    const tidi = vanillaTidi();
    const timers = fakeTimers();
    const { perfHooks: perf } = fakePerf();
    const lines = [];
    const started = startTelemetry({ config: makeConfig(tmp), adapter: fakeAdapter(tidi), modDir: MOD_DIR,
      logger: { log: (m) => lines.push(m) }, timers, perfHooks: perf, clock: { now: () => NOW_MS } });
    assert.strictEqual(started.ok, true);
    const t = started.telemetry;
    assert.strictEqual(t.getSnapshot().status.tick, "waiting");
    for (let i = 0; i < 5; i += 1) tidi.observeRuntimeTickSample(tickSummary(i));
    t.hooks.onTiming("open", 1);
    t.hooks.onTiming("t", 2, "ok", 3);
    t.hooks.onTiming("t", 4, "TX_FAILED", undefined);
    t.hooks.onCount("journal.duplicate", 1);
    t.hooks.onCount("journal.conflict", 1);
    const snap = t.capture();
    assert.ok(Object.isFrozen(snap) && Object.isFrozen(snap.tick.intervalMs));
    assert.strictEqual(t.getSnapshot(), snap);
    assert.strictEqual(snap.capturedAtMs, NOW_MS);
    assert.strictEqual(snap.status.tick, "ok");
    assert.ok(snap.process.rssBytes > 0 && snap.process.heapUsedBytes > 0);
    assert.strictEqual(snap.tick.intervalMs.p95, 104);
    assert.strictEqual(snap.tick.workMs.p95, 6);
    assert.strictEqual(snap.tick.intervalMs.spanMs, 400);
    assert.strictEqual(snap.window.histogramSamples, 64);
    assert.strictEqual(snap.persistence.txMs.p95, 4);
    assert.strictEqual(snap.persistence.txRows.samples, 1);
    assert.strictEqual(snap.persistence.tx.TX_FAILED, 1);
    assert.strictEqual(snap.persistence.tx.ok, 1);
    assert.strictEqual(snap.persistence.openMs, 1);
    assert.strictEqual(snap.journal.duplicates, 1);
    assert.deepStrictEqual(snap.alarms.map((a) => [a.id, a.level]),
      [["journal.conflict", "error"], ["persistence.tx.TX_FAILED", "warn"]]);
    assert.strictEqual(lines.filter((l) => l.includes("ALARM journal.conflict=1")).length, 1);
    assert.ok(snap.capture.buildDurationMs >= 0);
    assert.deepStrictEqual(snap.channels.scheduler, {});

    assert.strictEqual(timers.calls.set.length, 1);
    assert.strictEqual(await timers.calls.set[0].fn(), true);
    const file = path.join(tmp, "telemetry", "latest.json");
    const written = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.ok(written.process.rssBytes > 0 && written.tick.workMs.p95 === 6 && written.journal.duplicates === 1);
    assert.strictEqual(written.persistence.txMs.p95, 4);
    assert.ok(written.capture.buildDurationMs >= 0 && written.seq > snap.seq - 1);
    assert.ok(!fs.existsSync(`${file}.tmp`));
    assert.strictEqual(lines.filter((l) => l.includes("ALARM")).length, 1, "no repeat without growth");
    t.stop();

    const failing = { promises: { mkdir: async () => {}, writeFile: async () => { throw new Error("EPERM test"); },
      rename: async () => {} } };
    const t2Timers = fakeTimers();
    const t2 = startTelemetry({ config: makeConfig(path.join(tmp, "b")), adapter: null, modDir: MOD_DIR,
      logger: { log() {} }, timers: t2Timers, fsApi: failing, perfHooks: perf, clock: { now: () => NOW_MS } });
    const failTimers = t2.telemetry;
    assert.strictEqual(await t2Timers.calls.set[0].fn(), false);
    assert.strictEqual(failTimers.getStatus().snapshotWrite, "failing");
    assert.strictEqual(failTimers.capture().capture.writeErrors, 1);
    assert.strictEqual(failTimers.getSnapshot().alarms.some((a) => a.id === "capture.writeErrors"), true);
    failTimers.stop();

    const inMod = startTelemetry({ config: makeConfig(path.join(MOD_DIR, "data")), adapter: null, modDir: MOD_DIR,
      logger: { log() {} }, timers: fakeTimers(), perfHooks: perf, clock: { now: () => NOW_MS } });
    assert.strictEqual(inMod.telemetry.getSnapshot().status.snapshotWrite, "unavailable");
    assert.strictEqual(inMod.telemetry.getSnapshot().status.snapshotWriteReason, "SNAPSHOT_PATH_IN_MOD_DIR");
    inMod.telemetry.stop();
  }));

  test("T3j: a journal conflict with its detail logs one line (key, kind "
    + "eventType, aggregate, existing row; no payload), rate-limited by telemetry.slowOpLogPerMin", () => {
    const { perfHooks: perf } = fakePerf();
    const lines = [];
    const base = makeConfig(null);
    const config = { ...base, telemetry: { ...base.telemetry, slowOpLogPerMin: 1 } };
    const started = startTelemetry({ config, adapter: fakeAdapter(vanillaTidi()), modDir: MOD_DIR,
      logger: { log: (m) => lines.push(m) }, timers: fakeTimers(), perfHooks: perf, clock: { now: () => NOW_MS } });
    assert.strictEqual(started.ok, true);
    const detail = { kind: "APPLY", key: "strategy:react:500004:60000:000029895428:s0:LAUNCH",
      eventType: "STRATEGY_INTENT", aggregateType: "world_faction", aggregateId: "500004", journalId: 425468,
      existingKind: "APPLY", existingEventType: "STRATEGY_INTENT", existingAggregateType: "world_faction",
      existingAggregateId: "500004" };
    started.telemetry.hooks.onCount("journal.conflict", 1, detail);
    started.telemetry.hooks.onCount("journal.conflict", 1, detail);
    started.telemetry.hooks.onCount("journal.conflict", 1);
    const logged = lines.filter((l) => l.includes("journal conflict"));
    assert.deepStrictEqual(logged, ["telemetry: journal conflict kind=APPLY "
      + "key=strategy:react:500004:60000:000029895428:s0:LAUNCH eventType=STRATEGY_INTENT "
      + "aggregate=world_faction/500004 existing=425468 APPLY STRATEGY_INTENT world_faction/500004"]);
    assert.strictEqual(started.telemetry.capture().journal.conflicts, 3);
    started.telemetry.stop();
  });

  test("T3t: the first telemetry.txFailureLogLimit TX_FAILED / TX_CONSTRAINT get one "
    + "line (name, code, reason, message), then only the counter; a throwing logger never breaks the counter", () => {
    const { perfHooks: perf } = fakePerf();
    const lines = [];
    const base = makeConfig(null);
    const config = { ...base, telemetry: { ...base.telemetry, txFailureLogLimit: 2 } };
    const started = startTelemetry({ config, adapter: fakeAdapter(vanillaTidi()), modDir: MOD_DIR,
      logger: { log: (m) => lines.push(m) }, timers: fakeTimers(), perfHooks: perf, clock: { now: () => NOW_MS } });
    const on = started.telemetry.hooks.onTiming;
    on("scheduler.complete", 1, "TX_ABORTED", 0, undefined, undefined);
    on("scheduler.complete", 1, "TX_ABORTED", 0, undefined, undefined);
    on("scheduler.complete", 1, "TX_FAILED", 0, undefined,
      { code: null, message: "Symbol(scheduler-effect-abort)", reason: null });
    on("fleets.create", 1, "TX_CONSTRAINT", 0, undefined,
      { code: "SQLITE_CONSTRAINT_UNIQUE", message: "UNIQUE constraint\nfailed: x.y", reason: "R" });
    on("third", 1, "TX_FAILED", 0, undefined, { code: null, message: "never logged", reason: null });
    on("ok", 1, "ok", 1);
    const logged = lines.filter((l) => l.startsWith("persistence: tx "));
    assert.deepStrictEqual(logged, [
      "persistence: tx TX_FAILED scheduler.complete code=- error=Symbol(scheduler-effect-abort) (1/2)",
      "persistence: tx TX_CONSTRAINT fleets.create code=SQLITE_CONSTRAINT_UNIQUE reason=R "
        + "error=UNIQUE constraint failed: x.y (2/2)"]);
    const snap = started.telemetry.capture();
    assert.strictEqual(snap.persistence.tx.TX_FAILED, 2);
    assert.strictEqual(snap.persistence.tx.TX_CONSTRAINT, 1);
    assert.strictEqual(snap.persistence.tx.TX_ABORTED, 2, "Own counter");
    started.telemetry.stop();

    const broken = startTelemetry({ config, adapter: fakeAdapter(vanillaTidi()), modDir: MOD_DIR,
      logger: { log: () => { throw new Error("log down"); } }, timers: fakeTimers(), perfHooks: perf,
      clock: { now: () => NOW_MS } });
    assert.doesNotThrow(() => broken.telemetry.hooks.onTiming("x", 1, "TX_FAILED", 0, undefined, undefined));
    assert.strictEqual(broken.telemetry.capture().persistence.tx.TX_FAILED, 1);
    broken.telemetry.stop();

    const off = startTelemetry({ config: base, adapter: fakeAdapter(vanillaTidi()), modDir: MOD_DIR,
      logger: { log: (m) => lines.push(m) }, timers: fakeTimers(), perfHooks: perf, clock: { now: () => NOW_MS } });
    const before = lines.length;
    off.telemetry.hooks.onTiming("y", 1, "TX_FAILED", 0, undefined, { code: null, message: "m", reason: null });
    assert.strictEqual(lines.slice(before).filter((l) => l.startsWith("persistence: tx ")).length, 0, "absent key = 0");
    off.telemetry.stop();
  });

  test("T4 timer unref'd, stop idempotent; modules.telemetry.enabled=false -> zero timers, wraps, observers", () => {
    const real = { set: 0, clear: 0 };
    const timers = {
      setInterval: (fn, ms) => { real.set += 1; return setInterval(fn, ms); },
      clearInterval: (h) => { real.clear += 1; clearInterval(h); },
    };
    let handle = null;
    const spy = { setInterval: (fn, ms) => (handle = timers.setInterval(fn, ms)), clearInterval: timers.clearInterval };
    const { perfHooks: perf, created } = fakePerf();
    const started = startTelemetry({ config: makeConfig(null, { intervalSeconds: 300 }), adapter: null, modDir: MOD_DIR,
      logger: { log() {} }, timers: spy, perfHooks: perf, clock: { now: () => NOW_MS } });
    assert.strictEqual(started.ok, true);
    assert.strictEqual(handle.hasRef(), false);
    assert.strictEqual(started.telemetry.getStatus().timer, true);
    started.telemetry.stop();
    started.telemetry.stop();
    assert.strictEqual(real.clear, 1);
    assert.strictEqual(started.telemetry.getStatus().timer, false);
    assert.strictEqual(created[0].connected, false, "gc observer disconnected");

    const off = fakeTimers();
    const offPerf = fakePerf();
    const adapter = fakeAdapter(vanillaTidi());
    const disabled = startTelemetry({ config: makeConfig(null, { enabled: false }), adapter, modDir: MOD_DIR,
      logger: { log() {} }, timers: off, perfHooks: offPerf.perfHooks });
    assert.deepStrictEqual(disabled, { ok: false, reason: "disabled_by_config" });
    assert.strictEqual(off.calls.set.length, 0);
    assert.strictEqual(offPerf.created.length, 0);
    assert.strictEqual(adapter.calls.subscribe, 0);
  });

  test("TB1: bootGraceEndsAtMs -Infinity without tick or with 0 s, finite after "
    + "the subscription", () => {
    const boot = (adapter, bootGraceSeconds) => {
      const config = makeConfig(null);
      config.telemetry.bootGraceSeconds = bootGraceSeconds;
      return startTelemetry({ config, adapter, modDir: MOD_DIR, logger: { log() {} }, timers: fakeTimers(),
        perfHooks: fakePerf().perfHooks, clock: { now: () => NOW_MS } }).telemetry;
    };
    const noTick = boot(null, 30);
    assert.strictEqual(noTick.bootGraceEndsAtMs(), -Infinity);
    noTick.stop();
    const off = boot(fakeAdapter(vanillaTidi()), 0);
    assert.strictEqual(off.bootGraceEndsAtMs(), -Infinity);
    off.stop();
    const before = perfHooks.performance.now();
    const on = boot(fakeAdapter(vanillaTidi()), 30);
    const end = on.bootGraceEndsAtMs();
    assert.ok(Number.isFinite(end) && end >= before + 30000 && end <= perfHooks.performance.now() + 30000, String(end));
    on.stop();
  });
};

