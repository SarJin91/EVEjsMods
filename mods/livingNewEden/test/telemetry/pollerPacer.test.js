"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const perfHooks = require("node:perf_hooks");

const poller = require("../../lib/presence/poller");
const { createPollerPacer } = require("../../lib/telemetry/pollerPacer");
const { createCostLedger } = require("../../lib/telemetry/costLedger");
const { startTelemetry } = require("../../lib/telemetry");
const { buildDefaultServiceDefs } = require("../../lib/runtime/services");
const config = require("../../config");
const { findCompose, readCompose } = require("../config/composeKeys.test");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const MIN = 60000;

function resolved(env) {
  const r = config.resolveConfig({ modDir: MOD_DIR, env: { EVEJS_DATA_ROOT: os.tmpdir(), ...env } });
  assert.deepStrictEqual(r.errors, []);
  return r.config;
}

function defaults(over = {}) {
  const pp = resolved({}).perf.pollerPacing;
  return { ...pp, maxLabels: 256, ...over };
}

function timerSeam() {
  const delays = [];
  let last = null;
  return {
    delays,
    setTimer: (fn, ms) => {
      delays.push(ms);
      last = fn;
      return { cancel() {}, hasRef: () => false };
    },
    fire: () => last(),
  };
}

function withHooks(h, fn) {
  const before = poller.getPollerHooks();
  try {
    poller.installPollerHooks(h);
    return fn();
  } finally {
    poller.installPollerHooks(before);
  }
}

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

function listJs(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) listJs(p, out);
    else if (e.name.endsWith(".js")) out.push(p);
  }
  return out;
}

module.exports = ({ test, skip }) => {
  test("PP1 no hook / flag off: every re-arm = intervalMs; services installs no pacer with the flag off", () => {
    const run = (hooks) => withHooks(hooks, () => {
      const t = timerSeam();
      const p = poller.createPoller({ runPass: () => {}, intervalMs: 5000, now: () => 0, setTimer: t.setTimer });
      p.start();
      for (let i = 0; i < 3; i += 1) t.fire();
      return [p.getPasses(), t.delays];
    });
    assert.deepStrictEqual(run(null), [3, [5000, 5000, 5000, 5000]]);
    const off = createPollerPacer(defaults({ enabled: false }), { getMode: () => "SHED", overBudget: () => true,
      count() {} });
    assert.deepStrictEqual(run({ pacer: off }), [3, [5000, 5000, 5000, 5000]], "flag off = intervalMs in SHED");
    const def = buildDefaultServiceDefs({ startTelemetry: () => ({ ok: true, telemetry: fakeTelemetry() }) })
      .find((d) => d.name === "telemetry");
    withHooks(null, () => {
      const ctx = { config: { ...resolved({ EVEJS_LNE_PERF_POLLER_PACING_ENABLED: "0" }),
        telemetry: { intervalSeconds: 10 } } };
      def.start(ctx, { logger: { log() {} } });
      assert.strictEqual(poller.getPollerHooks(), null);
      def.stop(ctx);
      const on = { config: { ...resolved({}), telemetry: { intervalSeconds: 10 } } };
      def.start(on, { logger: { log() {} } });
      assert.strictEqual(typeof poller.getPollerHooks().pacer.delayFor, "function", "default on: a pacer hook");
      assert.ok(!("meter" in poller.getPollerHooks()), "no notePoller -> no meter");
      def.stop(on);
      assert.strictEqual(poller.getPollerHooks(), null, "stop removes its own hooks");
    });
  });

  test("PP2 OVERLOADED 3x, SHED 6x with the cap; arm(0) during a pass wins", () => {
    let mode = "OVERLOADED";
    const pacer = createPollerPacer(defaults({ maxStretchMs: 20000 }), { getMode: () => mode, overBudget: () => false,
      count() {} });
    withHooks({ pacer }, () => {
      const t = timerSeam();
      let nudge = false;
      const p = poller.createPoller({ runPass: () => { if (nudge) p.arm(0); }, intervalMs: 3000, now: () => 0,
        setTimer: t.setTimer });
      p.start();
      t.fire();
      mode = "SHED";
      t.fire();
      mode = "CONSTRAINED";
      t.fire();
      mode = "SHED";
      nudge = true;
      t.fire();
      mode = null;
      nudge = false;
      t.fire();
      assert.deepStrictEqual(t.delays, [3000, 9000, 18000, 3000, 0, 3000]);
      mode = "SHED";
      const t2 = timerSeam();
      const slow = poller.createPoller({ runPass: () => {}, intervalMs: 5000, now: () => 0, setTimer: t2.setTimer });
      slow.start();
      t2.fire();
      assert.deepStrictEqual(t2.delays, [5000, 20000], "SHED 30000 capped at maxStretchMs 20000");
    });
    assert.strictEqual(pacer.delayFor("a/x.js:1", 30000, true), 30000, "an interval above the cap is never shortened");
  });

  test("PP3 pacing:false and exempt prefixes are never stretched; the 7 LIVE opt-outs in the source", () => {
    const pacer = createPollerPacer(defaults({ exempt: " highsecLife/index.js:584 , npcVoices/" }),
      { getMode: () => "SHED", overBudget: () => false, count() {} });
    assert.strictEqual(pacer.delayFor("bounty/index.js:129", 1000, true), 6000);
    assert.strictEqual(pacer.delayFor("presence/index.js:147", 1000, false), 1000, "pacing:false");
    assert.strictEqual(pacer.delayFor("highsecLife/index.js:584", 1000, true), 1000, "exempt label");
    assert.strictEqual(pacer.delayFor("npcVoices/index.js:260", 1000, true), 1000, "exempt prefix");
    withHooks({ pacer }, () => {
      const t = timerSeam();
      const p = poller.createPoller({ runPass: () => {}, intervalMs: 1000, now: () => 0, setTimer: t.setTimer,
        pacing: false });
      p.start();
      t.fire();
      assert.deepStrictEqual(t.delays, [1000, 1000]);
    });
    const libDir = path.join(MOD_DIR, "lib");
    const optOut = listJs(libDir).filter((f) => /createPoller\(\{[\s\S]{0,400}?\bpacing: false/.test(
      fs.readFileSync(f, "utf8"))).map((f) => path.relative(libDir, f).split(path.sep).join("/")).sort();
    assert.deepStrictEqual(optOut, ["abyssal/observer.js", "capsuleFx/index.js", "factionIncursions/hud.js",
      "heavyEvents/index.js",
      "highsecLife/index.js", "materialization/index.js", "miningEncounters/index.js", "presence/index.js", "situations/index.js",
      "worldBosses/index.js"]);
  });

  test("PP4 budget hysteresis: on after budgetWindows minutes above, off after as many in the budget", () => {
    const L = createCostLedger({ bucketMs: MIN, windowMinutes: 10, maxLabels: 16, topN: 10, moduleMsPerMin: 1000 });
    let now = 0;
    const gauges = [];
    const pacer = createPollerPacer(defaults(), { getMode: () => "NORMAL",
      overBudget: (label, w) => L.overBudget(label, now, w), inBudget: (label, w) => L.inBudget(label, now, w),
      count() {}, gauge: (n, v) => gauges.push([n, v]) });
    const hot = "strategy/review.js:40";
    const at = (bucket, ms) => {
      if (ms > 0) L.note(hot, ms, bucket * MIN + 10);
      now = (bucket + 1) * MIN + 5;
      return pacer.delayFor(hot, 1000, true);
    };
    assert.deepStrictEqual([at(0, 1200), at(1, 1200)], [1000, 1000], "2 minutes above: not yet");
    assert.strictEqual(at(2, 1200), 2000, "3rd full minute above -> x2 in NORMAL");
    assert.deepStrictEqual([at(3, 400), at(4, 0)], [2000, 2000], "1-2 minutes in the budget: still stretched");
    assert.strictEqual(at(5, 400), 1000, "3 minutes in the budget -> released");
    assert.strictEqual(at(6, 1200), 1000, "one minute above after the release: not yet");
    assert.deepStrictEqual(gauges, [["perf.stretchedLabels", 0], ["perf.stretchedLabels", 1],
      ["perf.stretchedLabels", 0]]);
    const none = createPollerPacer(defaults({ budgetStretch: false }), { getMode: () => null, overBudget: () => true,
      count() {} });
    assert.strictEqual(none.delayFor(hot, 1000, true), 1000, "budgetStretch=false");
    const full = createPollerPacer(defaults({ maxLabels: 1 }), { getMode: () => null, overBudget: () => true,
      inBudget: () => false, count() {} });
    assert.deepStrictEqual([full.delayFor("a/x.js:1", 1000, true), full.delayFor("b/x.js:1", 1000, true)],
      [2000, 1000], "a new label of a full set is not budget-stretched");
    const broken = createPollerPacer(defaults(), { getMode: () => { throw new Error("x"); },
      overBudget: () => { throw new Error("y"); }, count() {} });
    assert.strictEqual(broken.delayFor(hot, 1000, true), 1000, "throwing dependencies = factor 1");
  });

  test("PP5 counters and gauge in the snapshot channel perf; compose lines of perf.pollerPacing.*", () => {
    const r = startTelemetry({ config: resolved({}), adapter: null, modDir: MOD_DIR, logger: { log() {} },
      timers: fakeTimers(), perfHooks: fakePerf() });
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    const telemetry = r.telemetry;
    const def = buildDefaultServiceDefs({ startTelemetry: () => ({ ok: true, telemetry }) })
      .find((d) => d.name === "telemetry");
    withHooks(null, () => {
      let baseMode = "NORMAL";
      const ctx = { config: resolved({}), governor: { getPolicy: () => ({ mode: "SHED" }),
        getStatus: () => ({ baseMode }) } };
      try {
        def.start(ctx, { logger: { log() {} } });
        const h = poller.getPollerHooks();
        assert.strictEqual(h.meter, telemetry.notePoller);
        assert.strictEqual(h.pacer.delayFor("bounty/index.js:129", 1000, true), 1000, "spike overlay only: x1");
        baseMode = "SHED";
        assert.strictEqual(h.pacer.delayFor("bounty/index.js:129", 1000, true), 6000);
        assert.strictEqual(h.pacer.delayFor("presence/index.js:147", 1000, false), 1000);
        const perf = telemetry.capture().channels.perf;
        assert.deepStrictEqual([perf.pollerStretched, perf.pollerBudgetStretched || 0, perf.stretchedLabels],
          [1, 0, 0]);
      } finally {
        def.stop(ctx);
      }
    });
    const seen = [];
    const budget = createPollerPacer(defaults(), { getMode: () => "NORMAL", overBudget: () => true,
      inBudget: () => false, count: (n) => seen.push(n) });
    budget.delayFor("a/x.js:1", 1000, true);
    assert.deepStrictEqual(seen, ["perf.pollerStretched", "perf.pollerBudgetStretched"]);
    const composeFile = findCompose();
    if (!composeFile) {
      skip("PP5 compose lines", "compose.yaml not found above the mod (Docker image)");
      return;
    }
    const text = fs.readFileSync(composeFile, "utf8");
    const { env } = readCompose(composeFile);
    const rows = config.SCHEMA.filter((x) => x.key.startsWith("perf.pollerPacing."));
    assert.strictEqual(rows.length, 9);
    const missing = rows.filter((x) => !Object.prototype.hasOwnProperty.call(env, x.env)
      || !text.includes(`\${${x.env}:-}`)).map((x) => x.env);
    assert.deepStrictEqual(missing, []);
  });

  test("PP6: stop() releases the budget label; the cap cancels the budget counter", () => {
    const gauges = [];
    const pacer = createPollerPacer(defaults(), { getMode: () => "NORMAL", overBudget: () => true,
      inBudget: () => false, count() {}, gauge: (n, v) => gauges.push(v) });
    withHooks({ pacer }, () => {
      const t = timerSeam();
      const p = poller.createPoller({ runPass: () => {}, intervalMs: 1000, now: () => 0, setTimer: t.setTimer,
        label: "strategy/review.js:40" });
      p.start();
      t.fire();
      assert.deepStrictEqual(t.delays, [1000, 2000]);
      assert.deepStrictEqual(pacer.getStatus().stretchedLabels, ["strategy/review.js:40"]);
      p.stop();
    });
    assert.deepStrictEqual(pacer.getStatus().stretchedLabels, [], "Stop releases the label");
    assert.deepStrictEqual(gauges, [0, 1, 0]);
    const seen = [];
    const capped = createPollerPacer(defaults({ maxStretchMs: 1000 }), { getMode: () => "NORMAL",
      overBudget: () => true, inBudget: () => false, count: (n) => seen.push(n) });
    assert.strictEqual(capped.delayFor("a/x.js:1", 5000, true), 5000);
    assert.deepStrictEqual(seen, [], "No counter when the cap cancels the stretch");
  });
};

function fakeTelemetry() {
  return { getStatus: () => ({ tick: "ok", gc: "ok" }), getSnapshot: () => ({ status: {}, capture: { path: "x" } }),
    stop() {}, count() {}, gauge() {} };
}
