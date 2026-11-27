"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const perfHooks = require("node:perf_hooks");

const { resolveConfig } = require("../../config");
const { createSpikeAttribution } = require("../../lib/telemetry/spikeAttribution");
const { createSegmentMeter } = require("../../lib/telemetry/segmentMeter");
const { createPassRunner } = require("../../lib/scheduler/pass");
const { startGovernor } = require("../../lib/telemetry/governorService");
const { startTelemetry } = require("../../lib/telemetry");
const { findServerSrcOnDisk } = require("../../lib/adapter/locator");
const http = require("node:http");
const { createJournal } = require("../../lib/persistence/journal");
const { startTrade } = require("../../lib/economy/trade");
const { startObserver } = require("../../lib/observer");
const { createViewRegistry } = require("../../lib/observer/views");
const { createFakeTradeAdapter } = require("../_support/fakeTradeAdapter");
const { harness: H } = require("../battle/settlement.test");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const SERVER_SEARCH_MAX_DEPTH = 5;
const CONFIG = resolveConfig({ modDir: MOD_DIR }).config;
const WALL_AT_PERF_ZERO = 1700000000000;

function attribution(over = {}) {
  const lines = [];
  const counters = {};
  let perf = 0;
  const a = createSpikeAttribution({ thresholdMs: 500, ringSize: 16, maxPending: 4, maxOpsPerLine: 6,
    perfNow: () => perf, wallNow: () => WALL_AT_PERF_ZERO + perf,
    log: (line) => {
      lines.push(line);
      return true;
    },
    count: (name, n = 1) => {
      counters[name] = (counters[name] || 0) + n;
    }, ...over });
  return { a, lines, counters, setPerf: (v) => {
    perf = v;
  } };
}

function spikeAfter(a, prevWorkMs, spikeWorkMs = 2) {
  a.onTick({ intervalMs: 100, workMs: prevWorkMs, latenessMs: 0, atMs: 9400 });
  a.onTick({ intervalMs: 600, workMs: spikeWorkMs, latenessMs: 500, atMs: 10000 });
}

function settle(h) {
  h.setPerf(10005);
  const first = h.a.resolve(10005);
  h.setPerf(20005);
  const second = h.a.resolve(20005);
  return [first, second];
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const flush = () => new Promise((r) => setImmediate(r));

module.exports = ({ test }) => {
  test("SPK1 GC delivered after the tick: first resolve settles nothing, the second gives source=gc", () => {
    const h = attribution();
    spikeAfter(h.a, 3);
    h.a.noteGc("major", 9450, 480);
    h.setPerf(10005);
    assert.strictEqual(h.a.resolve(10005), 0, "first resolve after start settles nothing");
    assert.strictEqual(h.a.getStatus().pending, 1);
    h.setPerf(20005);
    assert.strictEqual(h.a.resolve(20005), 1);
    const st = h.a.getStatus();
    assert.deepStrictEqual([st.total, st.pending, st.last.source, st.last.gcMs, st.last.tickWorkMs, st.last.restMs],
      [1, 0, "gc", 480, 3, 20]);
    assert.deepStrictEqual([h.counters["telemetry.spikes"], h.counters["telemetry.spikeSource.gc"]], [1, 1]);
    assert.strictEqual(h.lines.length, 1);
    const line = h.lines[0];
    assert.ok(line.includes(": spike ") && line.includes("source=gc") && line.includes(" gc=480/1 ")
      && line.includes(`at=${new Date(WALL_AT_PERF_ZERO + 10000).toISOString()}`) && line.includes("ops=-"), line);

    h.a.onTick({ intervalMs: 600, workMs: 2, latenessMs: 500, atMs: 25000 });
    h.setPerf(30000);
    assert.deepStrictEqual([h.a.resolve(30000), h.a.getStatus().pending], [0, 1]);
    h.setPerf(40000);
    assert.deepStrictEqual([h.a.resolve(40000), h.a.getStatus().pending, h.a.getStatus().total], [1, 0, 2]);
  });

  test("SPK2 nested mod operations count once, GC inside an operation goes to gc: lne=250, source=lne", () => {
    const h = attribution();
    spikeAfter(h.a, 3);
    h.a.noteOp("sched", "FACTION_STRATEGY_REVIEW", 9500, 300);
    h.a.noteOp("tx", "scheduler.complete", 9700, 90);
    h.a.noteOp("tx", "before.gap", 9000, 100);
    h.a.noteGc("scavenge", 9600, 50);
    assert.deepStrictEqual(settle(h), [0, 1]);
    const st = h.a.getStatus();
    assert.deepStrictEqual([st.last.source, st.last.lneMs, st.last.gcMs, st.last.restMs], ["lne", 250, 50, 200]);
    assert.deepStrictEqual([h.counters["telemetry.spikeSource.lne"], h.counters["telemetry.spikeLne.sched"],
      st.byLneKind.sched], [1, 1, 1]);
    const line = h.lines[0];
    assert.ok(line.includes("ops=sched:FACTION_STRATEGY_REVIEW/300,tx:scheduler.complete/90") && line.includes(" lne=250 ")
      && !line.includes("before.gap"), line);
  });

  test("SPK3 nothing in the gap -> unattributed; previous tick work -> evejsTick; threshold; full pending dropped", () => {
    const empty = attribution();
    spikeAfter(empty.a, 3);
    settle(empty);
    const e = empty.a.getStatus().last;
    assert.deepStrictEqual([e.source, e.restMs], ["unattributed", 500]);
    assert.ok(empty.lines[0].includes("source=unattributed") && empty.lines[0].includes("rest=500"), empty.lines[0]);

    const busy = attribution();
    spikeAfter(busy.a, 800, 2);
    settle(busy);
    const b = busy.a.getStatus().last;
    assert.deepStrictEqual([b.source, b.tickWorkMs, b.restMs], ["evejsTick", 800, 0]);

    const below = attribution();
    below.a.onTick({ intervalMs: 499, workMs: 2, latenessMs: 399, atMs: 10000 });
    below.a.onTick({ intervalMs: NaN, workMs: -1, latenessMs: 0, atMs: 10100 });
    assert.strictEqual(below.a.getStatus().pending, 0);

    const full = attribution({ maxPending: 2 });
    for (let i = 0; i < 3; i += 1) full.a.onTick({ intervalMs: 600, workMs: 2, latenessMs: 500, atMs: 10000 + i * 600 });
    assert.deepStrictEqual([full.a.getStatus().pending, full.a.getStatus().dropped, full.counters["telemetry.spikeDropped"]],
      [2, 1, 1]);
  });

  test("S1: a gap starting inside the grace -> source=boot, after it -> unattributed",
    () => {
      const h = attribution({ bootGraceEndsAtMs: () => 1000 });
      h.a.onTick({ intervalMs: 600, workMs: 2, latenessMs: 500, atMs: 1500 });
      h.setPerf(1505);
      h.a.resolve(1505);
      h.setPerf(2005);
      assert.strictEqual(h.a.resolve(2005), 1);
      const st = h.a.getStatus();
      assert.deepStrictEqual([st.last.source, st.last.restMs, st.bySource.boot, st.bySource.unattributed,
        h.counters["telemetry.spikeSource.boot"]], ["boot", 500, 1, 0, 1]);
      assert.ok(h.lines[0].includes("source=boot") && h.lines[0].includes("rest=500"), h.lines[0]);

      const after = attribution({ bootGraceEndsAtMs: () => 1000 });
      spikeAfter(after.a, 3);
      settle(after);
      const a = after.a.getStatus();
      assert.deepStrictEqual([a.last.source, a.bySource.boot, a.bySource.unattributed], ["unattributed", 0, 1]);
    });

  test("SPK4 segmentMeter: exact segments between awaits, two in flight, settle after end, rejection unchanged", async () => {
    let t = 0;
    const segs = [];
    const meter = createSegmentMeter({ nowMs: () => t, onSegment: (label, at, ms) => segs.push([label, at, ms]) });
    const pending = { readA: [], readB: [], fail: [] };
    const returned = [];
    const facade = {
      value: 5,
      readA() {
        t += 2;
        const d = deferred();
        pending.readA.push(d);
        returned.push(d.promise);
        return d.promise;
      },
      readB() {
        const d = deferred();
        pending.readB.push(d);
        return d.promise;
      },
      fail() {
        const d = deferred();
        pending.fail.push(d);
        return d.promise;
      },
      sync() {
        t += 1;
        return 7;
      },
    };
    const w = meter.wrapFacade(facade);
    assert.strictEqual(w.value, 5);
    let fire = null;
    const timer = meter.wrapTimer((fn, ms) => {
      fire = fn;
      return { ms };
    });
    const err = new Error("boom");
    let settled = null;
    let passDone = false;
    const pass = async () => {
      t += 10;
      assert.strictEqual(w.sync(), 7, "non-thenable passes through and keeps the segment open");
      const pA = w.readA();
      assert.strictEqual(pA, returned[0], "the original promise is returned");
      await pA;
      t += 5;
      const pB = w.readB();
      const pF = w.fail();
      settled = await Promise.allSettled([pB, pF]);
      t += 7;
      w.readB();
      passDone = true;
    };
    let passPromise = null;
    assert.deepStrictEqual(timer(() => (passPromise = pass()), 25), { ms: 25 });
    assert.strictEqual(fire(), passPromise, "the timer callback's result passes through");
    assert.deepStrictEqual(segs, [["pass", 0, 13]]);
    t = 100;
    pending.readA[0].resolve(1);
    await flush();
    assert.deepStrictEqual(segs.slice(1), [["readA", 100, 5]]);
    t = 200;
    pending.readB[0].resolve("b");
    await flush();
    assert.strictEqual(segs.length, 2, "one call still in flight: no segment");
    t = 300;
    pending.fail[0].reject(err);
    await flush();
    assert.strictEqual(passDone, true);
    assert.deepStrictEqual(segs.slice(2), [["fail", 300, 7]]);
    assert.deepStrictEqual([settled[0].value, settled[1].status, settled[1].reason === err], ["b", "rejected", true]);
    t = 400;
    pending.readB[1].resolve("late");
    await flush();
    assert.strictEqual(segs.length, 3, "a settle after the end of the pass opens no segment");
    assert.deepStrictEqual(meter.getStatus(), { segments: 3, maxMs: 13, inPass: false });
  });

  test("SPK5 integration: scheduler noteOp + slow pass types; governor escalation counters; telemetry facade; facts",
    async () => {
      let t = 0;
      const ops = [];
      const lines = [];
      const events = [{ eventId: "e1", eventType: "TYPE_A", dueAt: 0, aggregateId: "x" },
        { eventId: "e2", eventType: "TYPE_B", dueAt: 0, aggregateId: "x" },
        { eventId: "e3", eventType: "TYPE_A", dueAt: 0, aggregateId: "x" }];
      let claims = 0;
      const runner = createPassRunner({
        queue: {
          claimDue: () => ({ ok: true, events: claims++ === 0 ? events : [], stoppedBy: "empty" }),
          complete: () => ({ ok: true }),
          retryOrQuarantine: () => ({ ok: true, state: "RETRY" }),
          enqueue: () => ({ ok: true }),
          nextDueAt: () => 0, countDue: () => ({ count: 0 }), parkedCount: () => 0, isReady: () => true,
          bump() {}, takeParkedNew: () => 0, forget() {},
        },
        handlers: { get: () => (ev) => {
          t += ev.eventType === "TYPE_A" ? 30 : 50;
          return { ok: true };
        } },
        store: { getState: () => "open", limits: { maxWriteMsPerPass: 1e9 } },
        clock: { now: () => 1000 }, nowMs: () => t, getGovernor: () => null,
        limits: { maxDueEventsPerPass: 10, maxSchedulerWorkMs: 1e6, maxCatchUpEventsPerPass: 10 },
        settings: { sliceMs: 1e6, claimBatchSize: 10, catchUpLagMs: 60000, backlogCountCap: 0, slowOpMs: 10,
          slowOpLogPerMin: 10 },
        metrics: { count() {}, gauge() {}, observe() {}, noteOp: (...a) => ops.push(a) },
        logger: { log: (l) => lines.push(l) }, isActive: () => true, onSuspend() {},
      });
      const r = await runner.runPass();
      assert.deepStrictEqual([r.ok, r.jobs], [true, 3]);
      assert.deepStrictEqual(ops, [["sched", "TYPE_A", 0, 30], ["sched", "TYPE_B", 30, 50], ["sched", "TYPE_A", 80, 30]]);
      const slow = lines.filter((l) => l.includes("scheduler: slow pass"));
      assert.strictEqual(slow.length, 1);
      assert.ok(slow[0].includes("jobs=3 catchUp=0 types=TYPE_B:1/50.0,TYPE_A:2/30.0"), slow[0]);

      const config = { ...CONFIG, governor: { ...CONFIG.governor, minModeHoldSeconds: 0, recoverySeconds: 0,
        logMinIntervalSeconds: 3600, signal: "p95" } };
      const counters = {};
      let listener = null;
      const telemetry = { getStatus: () => ({ tick: "ok" }),
        addTickListener(fn) {
          listener = fn;
          return { ok: true, remove() {} };
        },
        count(name, n = 1) {
          counters[name] = (counters[name] || 0) + n;
        },
        gauge() {}, attachGovernor() {} };
      const govLines = [];
      const started = startGovernor({ config, telemetry, logger: { log: (m) => govLines.push(m) }, now: () => 0 });
      assert.strictEqual(started.ok, true);
      assert.deepStrictEqual([counters["governor.escalations.p95Warning"], counters["governor.escalations.p95Overload"],
        counters["governor.escalations.p95Unplayable"], counters["governor.stepDowns"]], [0, 0, 0, 0]);
      const step = (value, atMs) => {
        for (let i = 0; i < config.governor.sampleCount; i += 1) listener({ intervalMs: value, workMs: 1, atMs });
        return started.governor.evaluate(atMs);
      };
      assert.strictEqual(step(100, 2000).mode, "NORMAL");
      const downs = counters["governor.stepDowns"];
      const linesBefore = govLines.filter((l) => l.includes(" -> ")).length;
      assert.strictEqual(step(135, 3000).mode, "OVERLOADED");
      assert.strictEqual(step(100, 4000).mode, "CONSTRAINED");
      assert.deepStrictEqual([counters["governor.escalations.p95Overload"], counters["governor.escalations.p95Warning"],
        counters["governor.stepDowns"] - downs], [1, 0, 1]);
      assert.strictEqual(govLines.filter((l) => l.includes(" -> ")).length, linesBefore, "log silenced");
      started.governor.stop();

      let gcCallback = null;
      class FakeObserver {
        constructor(cb) {
          gcCallback = cb;
        }
        observe() {}
        disconnect() {}
      }
      FakeObserver.supportedEntryTypes = ["gc"];
      const fakePerf = { PerformanceObserver: FakeObserver, constants: perfHooks.constants,
        performance: perfHooks.performance };
      const boot = (spikeAttribution) => {
        const logged = [];
        const io = { onSample: null, pass: null };
        const adapter = { getDisabledModules: () => ({}),
          subscribeTickSamples(onSample) {
            io.onSample = onSample;
            return { ok: true, errors: () => 0, unwrap() {} };
          } };
        const tele = startTelemetry({ config: { ...CONFIG, dataDir: null, telemetry: { ...CONFIG.telemetry,
          spikeAttribution, bootGraceSeconds: 0 } }, adapter, modDir: MOD_DIR, logger: { log: (l) => logged.push(l) },
        timers: { setInterval: (fn) => {
          io.pass = fn;
          return { unref() {} };
        }, clearInterval() {} }, perfHooks: fakePerf,
        clock: { now: () => WALL_AT_PERF_ZERO } }).telemetry;
        return { tele, logged, io };
      };
      const on = boot(true);
      const p0 = perfHooks.performance.now();
      on.io.onSample({ intervalMs: 100, workMs: 3, latenessMs: 0, sceneCount: 1, tickedSceneCount: 1, atMs: p0 - 600 });
      on.io.onSample({ intervalMs: 600, workMs: 2, latenessMs: 500, sceneCount: 1, tickedSceneCount: 1, atMs: p0 });
      gcCallback({ getEntries: () => [{ duration: 480, startTime: p0 - 550,
        detail: { kind: perfHooks.constants.NODE_PERFORMANCE_GC_MAJOR } }] });
      await on.io.pass();
      await on.io.pass();
      const spikes = on.tele.getSnapshot().spikes;
      assert.deepStrictEqual([spikes.total, spikes.last && spikes.last.source, spikes.last && spikes.last.gcMs],
        [1, "gc", 480]);
      assert.ok(on.logged.some((l) => l.startsWith("telemetry: spike 600ms ") && l.includes("source=gc")),
        on.logged.join("\n"));
      on.tele.noteOp("trade", "tradeCreateContract", 0, 412);
      on.tele.noteOp("observer", "/api/views/activity", 0, 230);
      on.tele.noteOp("bogus", "x", 0, 1);
      const snap = on.tele.capture();
      assert.deepStrictEqual([snap.spikes.enabled, snap.spikes.thresholdMs, snap.channels.trade.slowSegments,
        snap.channels.observer.slowRequests, snap.telemetry.callbackErrors],
      [true, CONFIG.governor.emergencyMs, 1, 1, 1]);
      assert.ok(on.logged.includes("trade: slow segment 412ms after=tradeCreateContract")
        && on.logged.includes("observer: slow request 230ms /api/views/activity"), on.logged.join("\n"));
      on.tele.stop();
      const off = boot(false);
      off.tele.noteOp("trade", "tradeCreateContract", 0, 412);
      const offSnap = off.tele.capture();
      assert.deepStrictEqual([offSnap.spikes, offSnap.channels.trade.slowSegments, off.logged.length], [null, undefined, 0]);
      off.tele.stop();

      const src = findServerSrcOnDisk(MOD_DIR, SERVER_SEARCH_MAX_DEPTH, fs.existsSync);
      assert.ok(src.ok, "EveJS server/src not found above the mod");
      const tick = fs.readFileSync(path.join(src.srcDir, "space", "runtime", "spaceRuntime", "tick.js"), "utf8");
      assert.match(tick, /previousTickStartedAtMonotonicMs\s*=\s*toFiniteNumber\(\s*this\._lastTickStartedAtMonotonicMs/);
      assert.match(tick, /startedAtMonotonicMs\s*-\s*previousTickStartedAtMonotonicMs/);
      const finished = tick.indexOf("const finishedAtMonotonicMs = getMonotonicTimeMs()");
      const summary = tick.indexOf("const tickSummary = {");
      const sceneLoop = tick.indexOf("for (const scene of this.scenes.values())");
      assert.ok(sceneLoop > 0 && finished > sceneLoop && summary > finished, "tickSummary after the scene loop");
    });

  test("SPK6 wiring: startTrade executor pass -> noteOp trade pass + adapter label; observer noteOp url <= 80",
    async () => {
      const driver = H.loadDriver();
      assert.ok(driver.ok, "better-sqlite3");
      const ops = [];
      const telemetry = { count() {}, gauge() {}, observe() {}, noteOp: (...a) => ops.push(a) };
      await H.withStore(driver, async (reopen) => {
        const opened = reopen();
        const shared = H.sharedOf();
        const journal = createJournal({ clock: shared.clock, maxPayloadBytes: 16384, maxRows: 500 });
        const timers = [];
        const setTimer = (fn, ms) => {
          const t = { fn, ms, cancel() {}, hasRef: () => false };
          timers.push(t);
          return t;
        };
        const cfg = { ...CONFIG, trade: { ...CONFIG.trade, enabled: true, contractsEnabled: true,
          externalPriceEnabled: false }, stations: { ...CONFIG.stations, enabled: true } };
        const adapter = createFakeTradeAdapter();
        const listTagged = adapter.tradeMarketListTaggedEscrows;
        adapter.tradeMarketListTaggedEscrows = (spec) => Promise.resolve(listTagged(spec));
        const started = startTrade({ config: cfg, persistence: { ok: true, store: opened.store, journal },
          clock: shared.clock, ids: shared.ids, adapter, setTimer, telemetry });
        assert.ok(started.ok, JSON.stringify(started));
        assert.ok(timers.length >= 1, "executor timer armed");
        await timers[0].fn();
        await new Promise((resolve) => setImmediate(resolve));
        started.trade.stop();
      });
      const trade = ops.filter((o) => o[0] === "trade").map((o) => o[1]);
      assert.ok(trade.includes("pass"), JSON.stringify(trade));
      assert.ok(trade.some((label) => label !== "pass"), `an adapter call resumed a segment: ${JSON.stringify(trade)}`);

      const keepAlive = setInterval(() => {}, 1000);
      let observer = null;
      try {
        const ctx = { modVersion: "t", state: {}, telemetry };
        const r = startObserver({ config: { observer: { ...CONFIG.observer, host: "127.0.0.1", port: 0 } }, ctx,
          views: createViewRegistry(), logger: { log() {} }, fail() {} });
        assert.ok(r.ok, JSON.stringify(r));
        observer = r.observer;
        for (let i = 0; i < 2000 && observer.address() === null; i += 1) {
          await new Promise((resolve) => setImmediate(resolve));
        }
        const longPath = `/api/views/${"x".repeat(200)}`;
        await new Promise((resolve, reject) => {
          const req = http.get({ host: "127.0.0.1", port: observer.address().port, path: longPath, agent: false },
            (res) => {
              res.resume();
              res.on("end", resolve);
            });
          req.on("error", reject);
        });
        for (let i = 0; i < 2000 && !ops.some((o) => o[0] === "observer"); i += 1) {
          await new Promise((resolve) => setImmediate(resolve));
        }
      } finally {
        if (observer) observer.stop();
        clearInterval(keepAlive);
      }
      const seen = ops.filter((o) => o[0] === "observer");
      assert.deepStrictEqual(seen.map((o) => [o[1], typeof o[2], typeof o[3]]),
        [[`/api/views/${"x".repeat(200)}`.slice(0, 80), "number", "number"]]);
    });
};
