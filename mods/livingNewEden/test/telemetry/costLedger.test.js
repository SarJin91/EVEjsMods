"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const perfHooks = require("node:perf_hooks");

const { createCostLedger } = require("../../lib/telemetry/costLedger");
const poller = require("../../lib/presence/poller");
const { buildSnapshot } = require("../../lib/telemetry/snapshot");
const { startTelemetry } = require("../../lib/telemetry");
const { buildDefaultServiceDefs } = require("../../lib/runtime/services");
const { buildModuleCostView } = require("../../lib/observer/views/moduleCost");
const config = require("../../config");
const { findCompose, readCompose } = require("../config/composeKeys.test");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const MIN = 60000;
const GIB = 1073741824;

function fakeTimers() {
  return { setInterval: () => ({ unref() { return this; } }), clearInterval() {} };
}

function fakePerf() {
  class FakeObserver {
    observe() {}
    disconnect() {}
  }
  FakeObserver.supportedEntryTypes = ["gc"];
  return { PerformanceObserver: FakeObserver, constants: perfHooks.constants, performance: perfHooks.performance };
}

function resolved(env) {
  const r = config.resolveConfig({ modDir: MOD_DIR, env: { EVEJS_DATA_ROOT: os.tmpdir(), ...env } });
  assert.deepStrictEqual(r.errors, []);
  return r.config;
}

function timerSeam() {
  const armed = [];
  return {
    armed,
    setTimer: (fn) => {
      const h = { fn, cancelled: false };
      armed.push(h);
      return { cancel: () => { h.cancelled = true; }, hasRef: () => false };
    },
    fire: () => armed[armed.length - 1].fn(),
  };
}

function snapState(heapUsed, budgets, moduleOverBudget) {
  return { seq: 1, capturedAtMs: 0, startedAtMs: 0, intervalMs: 10000, histogramSamples: 32, status: {},
    process: { heap: { afterMajor: { lastUsedBytes: heapUsed } } },
    metrics: { counters: {}, gauges: {}, histograms: {} },
    tick: { sceneCount: 0, tickedSceneCount: 0, samplesTotal: 0, lastSampleAgeMs: null, wrapErrors: 0 },
    gcKinds: {}, capture: { lastWriteMs: 0, writeSkips: 0, writeErrors: 0, lastWriteError: "", path: null },
    budgets, moduleOverBudget };
}

module.exports = ({ test, skip }) => {
  test("CL1 ledger: rotation, msPerMin over the window, maxLabels -> other, modules without tx:*", () => {
    const L = createCostLedger({ bucketMs: MIN, windowMinutes: 3, maxLabels: 3, maxPollerLabels: 2, topN: 10,
      moduleMsPerMin: 1000 });
    assert.strictEqual(L.note("highsecLife/index.js:751", 100, 1000), false);
    L.note("highsecLife/index.js:751", 20, 1500);
    L.note("tx:sentries.receiptPrune", 50, 2000);
    L.note("sched:FLEET_ARRIVAL", 30, 3000);
    assert.strictEqual(L.note("bounty/service.js:9", 6, 4000), true, "3rd poller label of a full pool -> other");
    const r = L.read(2 * MIN + 30000);
    assert.strictEqual(r.windowMs, 150000);
    assert.deepStrictEqual(r.labels, [
      { label: "highsecLife/index.js:751", module: "highsecLife", msPerMin: 48, calls: 2, maxMs: 100, overBudget: false },
      { label: "tx:sentries.receiptPrune", module: "tx:sentries", msPerMin: 20, calls: 1, maxMs: 50, overBudget: false },
      { label: "sched:FLEET_ARRIVAL", module: "sched:FLEET_ARRIVAL", msPerMin: 12, calls: 1, maxMs: 30,
        overBudget: false }]);
    assert.deepStrictEqual(r.modules, [{ module: "highsecLife", msPerMin: 48 }, { module: "sched:FLEET_ARRIVAL",
      msPerMin: 12 }], "tx:* never summed per module");
    assert.deepStrictEqual(r.other, { msPerMin: 2.4, labels: 1 });
    L.note("highsecLife/index.js:751", 150, 3 * MIN + 1);
    const r2 = L.read(3 * MIN + 30000);
    assert.deepStrictEqual(r2.labels.map((x) => [x.label, x.msPerMin, x.calls]), [["highsecLife/index.js:751", 60, 1]]);
    assert.deepStrictEqual(r2.other, { msPerMin: 0, labels: 0 });
    const top = createCostLedger({ bucketMs: MIN, windowMinutes: 2, maxLabels: 16, topN: 1, moduleMsPerMin: 1000 });
    top.note("a/x.js:1", 1, 0);
    top.note("b/x.js:1", 2, 0);
    assert.deepStrictEqual(top.read(MIN).labels.map((x) => x.label), ["b/x.js:1"], "topN by msPerMin");
  });

  test("CL2 overBudget(label, now, 3) only with 3 full buckets above the budget", () => {
    const L = createCostLedger({ bucketMs: MIN, windowMinutes: 5, maxLabels: 16, topN: 10, moduleMsPerMin: 1000 });
    const hot = "strategy/review.js:40";
    const warm = "sites/pump.js:12";
    for (const b of [0, 1, 2]) L.note(hot, 1200, b * MIN + 10);
    L.note(warm, 1200, 0 * MIN + 10);
    L.note(warm, 900, 1 * MIN + 10);
    L.note(warm, 1200, 2 * MIN + 10);
    const now = 3 * MIN + 5;
    assert.strictEqual(L.overBudget(hot, now, 3), true);
    assert.strictEqual(L.overBudget(warm, now, 3), false, "one bucket at 900 ms");
    assert.strictEqual(L.overBudget(warm, now, 1), true);
    assert.strictEqual(L.overBudget(hot, now, 4), false, "bucket -1 never existed");
    assert.strictEqual(L.overBudget(hot, now, 5), false, "more windows than full buckets of the ring");
    assert.strictEqual(L.overBudget("none/x.js:1", now, 1), false);
    assert.strictEqual(L.countOverBudget(now), 2);
    assert.deepStrictEqual(L.read(now).labels.map((x) => [x.label, x.overBudget]), [[hot, true], [warm, true]]);
    assert.strictEqual(L.countOverBudget(5 * MIN), 0, "bucket 4 is empty");
  });

  test("CL3 poller: no hooks = pass as before; meter label from the stack or deps.label; throwing meter swallowed",
    () => {
      const before = poller.getPollerHooks();
      const perf = perfHooks.performance;
      const ownNow = Object.prototype.hasOwnProperty.call(perf, "now");
      const originalNow = perf.now;
      let nowCalls = 0;
      try {
        poller.installPollerHooks(null);
        perf.now = function countedNow() {
          nowCalls += 1;
          return originalNow.call(perf);
        };
        const t = timerSeam();
        let passes = 0;
        const p = poller.createPoller({ runPass: () => { passes += 1; }, intervalMs: 1000, now: () => 0,
          setTimer: t.setTimer });
        assert.match(p.getLabel(), /^test\/telemetry\/costLedger\.test\.js:\d+$/);
        p.start();
        t.fire();
        assert.deepStrictEqual([passes, nowCalls, p.getPasses()], [1, 0, 1], "no hook: no performance.now()");
        const seen = [];
        poller.installPollerHooks({ meter: (label, ms) => seen.push([label, ms >= 0]) });
        t.fire();
        assert.deepStrictEqual(seen, [[p.getLabel(), true]]);
        assert.strictEqual(nowCalls, 2, "two clock reads per metered pass");
        const t2 = timerSeam();
        const named = poller.createPoller({ runPass: () => {}, intervalMs: 1000, now: () => 0, setTimer: t2.setTimer,
          label: "presence/custom" });
        named.start();
        t2.fire();
        assert.deepStrictEqual(seen[1], ["presence/custom", true]);
        poller.installPollerHooks({ meter: () => { throw new Error("meter down"); } });
        const armedBefore = t.armed.length;
        t.fire();
        assert.strictEqual(p.getPasses(), 3);
        assert.strictEqual(t.armed.length, armedBefore + 1, "the chain re-armed after a throwing meter");
        const frame = (rel, line) => `    at fn (${path.join(MOD_DIR, ...rel.split("/"))}:${line}:5)`;
        const stack = ["Error", frame("lib/presence/poller.js", 99), frame("lib/presence/index.js", 12)].join("\n");
        assert.strictEqual(poller.labelFromStack(stack), "presence/index.js:12");
        assert.strictEqual(poller.labelFromStack("Error\n    at <anonymous>"), "poller:unknown");
        const def = buildDefaultServiceDefs({ startTelemetry: () => ({ ok: true, telemetry: fakeTelemetry(true) }) })
          .find((d) => d.name === "telemetry");
        poller.installPollerHooks(null);
        const ctx = { config: { telemetry: { intervalSeconds: 10 } } };
        def.start(ctx, { logger: { log() {} } });
        assert.strictEqual(poller.getPollerHooks().meter, ctx.telemetry.notePoller);
        def.stop(ctx);
        assert.strictEqual(poller.getPollerHooks(), null);
        const off = buildDefaultServiceDefs({ startTelemetry: () => ({ ok: true, telemetry: fakeTelemetry(false) }) })
          .find((d) => d.name === "telemetry");
        off.start(ctx, { logger: { log() {} } });
        assert.strictEqual(poller.getPollerHooks(), null, "flag off: no notePoller, no hook");
        off.stop(ctx);
      } finally {
        if (ownNow) perf.now = originalNow;
        else delete perf.now;
        poller.installPollerHooks(before);
      }
    });

  test("CL4 snapshot alarms: heap after major GC warn / critical, moduleOverBudget count", () => {
    const d = (key) => config.SCHEMA.find((r) => r.key === key).default;
    const budgets = { moduleMsPerMin: d("telemetry.budgets.moduleMsPerMin"),
      heapAfterMajorWarnBytes: d("telemetry.budgets.heapAfterMajorWarnBytes"),
      heapAfterMajorCriticalBytes: d("telemetry.budgets.heapAfterMajorCriticalBytes") };
    const alarmsOf = (state) => buildSnapshot(state).alarms.map((a) => [a.id, a.level, a.count]);
    assert.deepStrictEqual(alarmsOf(snapState(5 * GIB, budgets, 0)), []);
    assert.deepStrictEqual(alarmsOf(snapState(6 * GIB, budgets, 0)), [["heapAfterMajorWarn", "warning", 1]]);
    assert.deepStrictEqual(alarmsOf(snapState(7 * GIB, budgets, 0)), [["heapAfterMajorCritical", "critical", 1]]);
    assert.deepStrictEqual(alarmsOf(snapState(null, budgets, 2)), [["moduleOverBudget", "warning", 2]]);
    assert.deepStrictEqual(alarmsOf(snapState(7 * GIB, null, 0)), [], "no budgets -> no heap alarm");
    assert.ok(!("moduleCost" in buildSnapshot(snapState(null, budgets, 0))), "no ledger -> no field");
  });

  test("CL5 telemetry + view module-cost (flag on / off) and compose lines of the new keys", () => {
    const start = (env) => {
      const r = startTelemetry({ config: resolved(env), adapter: null, modDir: MOD_DIR, logger: { log() {} },
        timers: fakeTimers(), perfHooks: fakePerf() });
      assert.strictEqual(r.ok, true, JSON.stringify(r));
      return r.telemetry;
    };
    const on = start({});
    try {
      on.notePoller("highsecLife/index.js:751", 12);
      on.noteOp("sched", "FLEET_ARRIVAL", 0, 3);
      on.hooks.onTiming("sentries.receiptPrune", 4, "ok", 1);
      assert.deepStrictEqual(on.registerMemoryProbe("graph.routeCache", () => ({ entries: 7, approxBytes: 70 })).ok,
        true);
      assert.deepStrictEqual(on.registerMemoryProbe("graph.routeCache", () => ({ entries: 1 })),
        { ok: false, reason: "DUPLICATE" });
      on.registerMemoryProbe("broken", () => { throw new Error("x"); });
      const snap = on.capture();
      const mc = snap.moduleCost;
      assert.deepStrictEqual(mc.labels.map((x) => x.label).sort(),
        ["highsecLife/index.js:751", "sched:FLEET_ARRIVAL", "tx:sentries.receiptPrune"]);
      assert.deepStrictEqual(mc.modules.map((x) => x.module).sort(), ["highsecLife", "sched:FLEET_ARRIVAL"]);
      assert.deepStrictEqual(mc.memory, [{ name: "broken", entries: null, approxBytes: null, error: true },
        { name: "graph.routeCache", entries: 7, approxBytes: 70 }]);
      const view = buildModuleCostView({ ctx: { telemetry: on } }).getData();
      assert.strictEqual(view.available, true);
      assert.strictEqual(view.moduleCost, snap.moduleCost, "the snapshot object as it is");
    } finally {
      on.stop();
    }
    const off = start({ EVEJS_LNE_TELEMETRY_MODULE_COST_ENABLED: "0" });
    try {
      assert.strictEqual(typeof off.notePoller, "undefined");
      assert.strictEqual(typeof off.registerMemoryProbe, "undefined");
      assert.ok(!("moduleCost" in off.capture()));
      assert.deepStrictEqual(buildModuleCostView({ ctx: { telemetry: off } }).getData(),
        { available: false, reason: "module_cost_disabled" });
    } finally {
      off.stop();
    }
    assert.deepStrictEqual(buildModuleCostView({ ctx: {} }).getData(),
      { available: false, reason: "telemetry_disabled" });
    const composeFile = findCompose();
    if (!composeFile) {
      skip("CL5 compose lines", "compose.yaml not found above the mod (Docker image)");
      return;
    }
    const text = fs.readFileSync(composeFile, "utf8");
    const { env } = readCompose(composeFile);
    const rows = config.SCHEMA.filter((r) => r.key.startsWith("telemetry.moduleCost.")
      || r.key.startsWith("telemetry.budgets."));
    assert.strictEqual(rows.length, 11);
    const missing = rows.filter((r) => !Object.prototype.hasOwnProperty.call(env, r.env)
      || !text.includes(`\${${r.env}:-`)).map((r) => r.env);
    assert.deepStrictEqual(missing, []);
  });

  test("CL6 () a bucket full of tx:* keeps a late poller visible with overBudget; observer label "
    + "without the query", () => {
    const d = (key) => config.SCHEMA.find((r) => r.key === key).default;
    const L = createCostLedger({ bucketMs: MIN, windowMinutes: d("telemetry.moduleCost.windowMinutes"),
      maxLabels: d("telemetry.moduleCost.maxLabels"), maxPollerLabels: d("telemetry.moduleCost.maxPollerLabels"),
      topN: 10, moduleMsPerMin: 1000 });
    const hot = "highsecLife/index.js:751";
    for (const b of [0, 1, 2]) {
      for (let i = 0; i < d("telemetry.moduleCost.maxLabels"); i += 1) L.note(`tx:t${i}`, 0.1, b * MIN + 1);
      assert.strictEqual(L.note("tx:late", 0.1, b * MIN + 2), true, "the tx pool is full");
      assert.strictEqual(L.note(hot, 1200, b * MIN + 59000), false, "the late poller has its own pool");
      assert.strictEqual(L.note("sched:FLEET_ARRIVAL", 1, b * MIN + 59500), false);
    }
    const now = 3 * MIN + 5;
    assert.strictEqual(L.overBudget(hot, now, 3), true);
    assert.strictEqual(L.countOverBudget(now), 1);
    const row = L.read(now).labels.find((x) => x.label === hot);
    assert.deepStrictEqual([row.calls, row.overBudget], [3, true]);
    const r = startTelemetry({ config: resolved({}), adapter: null, modDir: MOD_DIR, logger: { log() {} },
      timers: fakeTimers(), perfHooks: fakePerf() });
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    try {
      r.telemetry.noteOp("observer", "/api/view/system-card?param=30000142", 0, 2);
      r.telemetry.noteOp("observer", "/api/view/system-card?param=30002187", 0, 2);
      r.telemetry.noteOp("observer", "/api/status", 0, 1);
      const labels = r.telemetry.capture().moduleCost.labels.map((x) => [x.label, x.calls]).sort();
      assert.deepStrictEqual(labels, [["observer:/api/status", 1], ["observer:/api/view/system-card", 2]]);
    } finally {
      r.telemetry.stop();
    }
  });
};

function fakeTelemetry(withLedger) {
  return { getStatus: () => ({ tick: "ok", gc: "ok" }), getSnapshot: () => ({ status: {}, capture: { path: "x" } }),
    stop() {}, ...(withLedger ? { notePoller() {} } : {}) };
}
