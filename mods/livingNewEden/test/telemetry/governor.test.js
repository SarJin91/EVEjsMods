"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const perfHooks = require("node:perf_hooks");

const { resolveConfig } = require("../../config");
const { MODE, WORK_CLASS_ORDER, ADMISSION, normalizeOptions, createLoadGovernor, fallbackPolicy } =
  require("../../lib/telemetry/loadGovernor");
const { governorOptionsFromConfig, startGovernor } = require("../../lib/telemetry/governorService");
const { wrapTickSample } = require("../../lib/adapter/tickSample");
const { startTelemetry } = require("../../lib/telemetry");
const { findServerSrcOnDisk } = require("../../lib/adapter/locator");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const SERVER_SEARCH_MAX_DEPTH = 5;
const CONFIG = resolveConfig({ modDir: MOD_DIR }).config;
const P95_CONFIG = { ...CONFIG, governor: { ...CONFIG.governor, signal: "p95" },
  telemetry: { ...CONFIG.telemetry, bootGraceSeconds: 0 } };

function options(override = {}) {
  return normalizeOptions({ ...governorOptionsFromConfig(CONFIG), signal: "p95", ...override }).options;
}

function feed(gov, value, count, atMs) {
  for (let i = 0; i < count; i += 1) gov.record(value, atMs);
}

function governor(extra = {}, override = {}) {
  const seen = [];
  const gov = createLoadGovernor({ options: options(override), tickAvailable: true, nowMs: 0,
    onModeChange: (from, to) => seen.push(`${from}->${to}`), ...extra });
  return { gov, seen };
}

const GF_OPTIONS = { sampleCount: 100, warningP95Ms: 120, overloadP95Ms: 130, emergencyMs: 500, unplayableMs: 600,
  recoveryThresholdMs: 112, recoveryMs: 15000, shedHoldMs: 1000, staleSampleMs: 5000, overloadExitP95Ms: 120,
  minModeHoldMs: 180000, shedMinHoldMs: 30000, shedFastExitCooldownMs: 3600000,
  signal: "p95", latenessSampleCount: 600, latenessWarningPercent: 15, latenessOverloadPercent: 25,
  latenessRecoveryPercent: 10, latenessOverloadExitPercent: 15 };

function gfGovernor(override = {}) {
  const raw = { ...GF_OPTIONS, budgets: governorOptionsFromConfig(CONFIG).budgets, ...override };
  const seen = [];
  const gov = createLoadGovernor({ options: normalizeOptions(raw).options, tickAvailable: true, nowMs: 0,
    onModeChange: (from, to) => seen.push(`${from}->${to}`) });
  return { gov, seen };
}

const TICK_STEP_MS = 100;
const PASS_MS = 1000;
const ticks = (value, count = PASS_MS / TICK_STEP_MS) => new Array(count).fill(value);

function drive(gov, seconds, perSecond, t0) {
  let t = t0;
  for (let s = 0; s < seconds; s += 1) {
    const values = perSecond(s);
    for (let i = 0; i < values.length; i += 1) gov.record(values[i], t + i * TICK_STEP_MS);
    t += PASS_MS;
    gov.evaluate(t);
  }
  return t;
}

function fakeGovTelemetry() {
  const counters = {};
  let listener = null;
  return { counters, push: (s) => listener(s),
    getStatus: () => ({ tick: "ok" }),
    addTickListener(fn) { listener = fn; return { ok: true, remove() {} }; },
    count(name, n = 1) { counters[name] = (counters[name] || 0) + n; },
    gauge() {}, attachGovernor() {} };
}

const EXPECTED = {
  NORMAL: ["SETTLEMENT", "LIVE", "OPERATIONAL", "STRATEGIC", "MAINTENANCE"],
  CONSTRAINED: ["SETTLEMENT", "LIVE", "OPERATIONAL"],
  OVERLOADED: ["SETTLEMENT", "LIVE"],
  SHED: [],
};

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

function fakeAdapter(tidi, disabled = {}) {
  const calls = { subscribe: 0 };
  return { calls, getDisabledModules: () => disabled,
    subscribeTickSamples(onSample) { calls.subscribe += 1; return wrapTickSample(tidi, onSample); } };
}

function summary(atMs, intervalMs, workMs = 2) {
  return { startedAtMonotonicMs: atMs, actualIntervalMs: intervalMs, targetTickIntervalMs: 100, tickDurationMs: workMs,
    latenessMs: 0, sceneCount: 1, tickedSceneCount: 1, collectedSceneCount: 0 };
}

module.exports = ({ test }) => {
  test("G1 governor transitions: NORMAL -> CONSTRAINED -> OVERLOADED, spike overlay, step down one level per recovery", () => {
    const o = options({ minModeHoldMs: 0 });
    const { gov, seen } = governor({}, { minModeHoldMs: 0 });
    assert.strictEqual(gov.getPolicy().phase, "warming", "empty ring at start");
    feed(gov, 105, o.sampleCount, 1000);
    assert.strictEqual(gov.evaluate(1000).mode, MODE.NORMAL);
    feed(gov, 125, o.sampleCount, 2000);
    assert.strictEqual(gov.evaluate(2000).mode, MODE.CONSTRAINED);
    feed(gov, 135, o.sampleCount, 3000);
    assert.strictEqual(gov.evaluate(3000).mode, MODE.OVERLOADED);
    feed(gov, 500, 1, 4000);
    const shed = gov.evaluate(4000);
    assert.deepStrictEqual([shed.mode, shed.phase, shed.budgetMs, shed.maxJobs], [MODE.SHED, "shed", 0, 0]);
    assert.strictEqual(gov.getStatus().baseMode, MODE.OVERLOADED, "spike = overlay, base kept");
    const afterHold = 4000 + o.shedHoldMs + 1;
    feed(gov, 110, o.sampleCount, afterHold);
    const rec = gov.evaluate(afterHold);
    assert.deepStrictEqual([rec.mode, rec.phase], [MODE.OVERLOADED, "recovering"], "recovering keeps the base mode");
    feed(gov, 110, 1, afterHold + o.recoveryMs - 1);
    assert.strictEqual(gov.evaluate(afterHold + o.recoveryMs - 1).phase, "recovering");
    feed(gov, 110, 1, afterHold + o.recoveryMs);
    const down = gov.evaluate(afterHold + o.recoveryMs);
    assert.deepStrictEqual([down.mode, down.phase], [MODE.CONSTRAINED, "recovering"], "one level down");
    const second = afterHold + o.recoveryMs + 1;
    feed(gov, 110, 1, second);
    assert.strictEqual(gov.evaluate(second).mode, MODE.CONSTRAINED);
    feed(gov, 110, 1, second + o.recoveryMs);
    const back = gov.evaluate(second + o.recoveryMs);
    assert.deepStrictEqual([back.mode, back.phase], [MODE.NORMAL, "healthy"]);
    assert.deepStrictEqual(seen, ["CONSTRAINED->NORMAL", "NORMAL->CONSTRAINED", "CONSTRAINED->OVERLOADED",
      "OVERLOADED->CONSTRAINED", "CONSTRAINED->NORMAL"]);
    const st = gov.getStatus();
    assert.strictEqual(st.changes, seen.length);
    assert.strictEqual(st.counts.recoveryTransitions, 2);
    assert.strictEqual(st.counts.emergencySamples, 1);
    assert.strictEqual(st.counts.spikeSheds, 1);
    assert.ok(Object.isFrozen(st) && Object.isFrozen(st.counts) && Object.isFrozen(st.classes.LIVE));
  });

  test("G2 governor isolated spike = SHED overlay, NORMAL after the hold, no base change; 19+1x131 NORMAL; unplayable", () => {
    const o = options();
    const { gov } = governor();
    feed(gov, 105, o.sampleCount, 1000);
    assert.strictEqual(gov.evaluate(1000).mode, MODE.NORMAL);
    const changesBefore = gov.getStatus().changes;
    feed(gov, 500, 1, 2000);
    assert.strictEqual(gov.evaluate(2000).mode, MODE.SHED);
    assert.strictEqual(gov.evaluate(2000 + o.shedHoldMs).mode, MODE.SHED, "hold is inclusive");
    const after = gov.evaluate(2000 + o.shedHoldMs + 1);
    assert.deepStrictEqual([after.mode, after.phase], [MODE.NORMAL, "healthy"]);
    assert.strictEqual(gov.getStatus().counts.recoveryTransitions, 0);
    assert.strictEqual(gov.getStatus().changes, changesBefore, "a spike is not a base change");

    const fresh = governor().gov;
    feed(fresh, 105, o.sampleCount - 1, 1000);
    feed(fresh, 131, 1, 1000);
    assert.strictEqual(fresh.evaluate(1000).mode, MODE.NORMAL);
    feed(fresh, 600, 1, 1100);
    const p = fresh.evaluate(1100);
    assert.deepStrictEqual([p.mode, p.phase, p.reason], [MODE.SHED, "unplayable", "unplayable_circuit_breaker"]);
    assert.strictEqual(fresh.getStatus().counts.unplayableSamples, 1);
  });

  test("G3 governor admission table: 4 modes x 5 classes, budgets, unknown class; fallbackPolicy", () => {
    const o = options();
    assert.deepStrictEqual(JSON.parse(JSON.stringify(ADMISSION)), EXPECTED);
    const { gov } = governor();
    const inputs = { NORMAL: 105, CONSTRAINED: 125, OVERLOADED: 135, SHED: 500 };
    let t = 1000;
    for (const mode of Object.keys(EXPECTED)) {
      t += o.staleSampleMs;
      feed(gov, mode === "SHED" ? 105 : inputs[mode], o.sampleCount, t);
      if (mode === "SHED") feed(gov, inputs.SHED, 1, t);
      const policy = gov.evaluate(t);
      assert.strictEqual(policy.mode, mode);
      for (const wc of WORK_CLASS_ORDER) {
        const expected = EXPECTED[mode].includes(wc);
        assert.strictEqual(gov.admits(wc), expected, `${mode} ${wc}`);
        const c = policy.classes[wc];
        assert.strictEqual(c.admitted, expected, `${mode} ${wc} classes`);
        if (expected) assert.deepStrictEqual([c.budgetMs, c.maxJobs], [policy.budgetMs, policy.maxJobs]);
        else assert.deepStrictEqual([c.budgetMs, c.maxJobs], [0, 0]);
      }
      if (mode !== "SHED") assert.strictEqual(gov.admits("SETTLEMENT"), true);
      assert.strictEqual(gov.admits("NOPE"), false);
      assert.strictEqual(gov.admits("toString"), false);
    }
    assert.ok(o.budgets.CONSTRAINED.budgetMs <= o.budgets.NORMAL.budgetMs);
    const fb = fallbackPolicy("governor_unavailable", o.budgets.NORMAL);
    assert.deepStrictEqual([fb.mode, fb.phase, fb.reason], [MODE.NORMAL, "no_samples", "governor_unavailable"]);
    assert.ok(WORK_CLASS_ORDER.every((wc) => fb.classes[wc].admitted && fb.classes[wc].maxJobs === fb.maxJobs));
  });

  test("G4 governor without samples: tick unavailable, warming, stale; options without fallbacks", () => {
    const o = options();
    const off = createLoadGovernor({ options: o, tickAvailable: false, nowMs: 0 });
    feed(off, 600, 1, 0);
    assert.deepStrictEqual([off.evaluate(10).mode, off.getPolicy().reason], [MODE.NORMAL, "no_tick_samples"]);
    const { gov } = governor();
    feed(gov, 105, o.sampleCount - 1, 1000);
    assert.deepStrictEqual([gov.evaluate(1000).mode, gov.getPolicy().phase], [MODE.CONSTRAINED, "warming"]);
    const stale = gov.evaluate(1000 + o.staleSampleMs + 1);
    assert.deepStrictEqual([stale.mode, stale.reason], [MODE.NORMAL, "tick_samples_stale"]);
    assert.strictEqual(gov.getStatus().lastSampleAgeMs, o.staleSampleMs + 1);

    const raw = governorOptionsFromConfig(CONFIG);
    assert.throws(() => normalizeOptions({ ...raw, warningP95Ms: undefined }), RangeError);
    assert.throws(() => normalizeOptions({ ...raw, budgets: {} }), RangeError);
    const fixed = normalizeOptions({ ...raw, overloadP95Ms: raw.warningP95Ms - 1, shedHoldMs: raw.staleSampleMs + 1 });
    assert.deepStrictEqual(fixed.adjusted, ["overloadP95Ms", "shedHoldMs"]);
    assert.strictEqual(fixed.options.overloadP95Ms, raw.warningP95Ms);
  });

  test("G5 governor through telemetry: one wrap, throwing listener isolated, snapshot.governor; DRIFT", () => {
    const config = { ...P95_CONFIG, dataDir: null };
    const tidi = { observeRuntimeTickSample() { return { changed: false }; } };
    const adapter = fakeAdapter(tidi);
    const t = startTelemetry({ config, adapter, modDir: MOD_DIR, logger: { log() {} }, timers: fakeTimers(),
      perfHooks: fakePerf(), clock: { now: () => 0 } }).telemetry;
    let now = 1000;
    const lines = [];
    const started = startGovernor({ config, telemetry: t, logger: { log: (m) => lines.push(m) }, now: () => now });
    assert.strictEqual(started.ok, true);
    assert.ok(lines.some((l) => l.startsWith("governor: running") && l.includes("tick=ok")));
    const bad = t.addTickListener(() => { throw new Error("listener boom"); });
    assert.strictEqual(bad.ok, true);
    const n = options().sampleCount;
    for (let i = 0; i < n; i += 1) tidi.observeRuntimeTickSample(summary(now + i, 105));
    now += n;
    const snap = t.capture();
    assert.strictEqual(adapter.calls.subscribe, 1, "no second wrap");
    assert.strictEqual(snap.tick.wrapErrors, 0);
    assert.strictEqual(snap.telemetry.callbackErrors, n);
    assert.strictEqual(snap.governor.samples, n);
    assert.strictEqual(snap.governor.mode, MODE.NORMAL);
    assert.strictEqual(snap.channels.governor.mode, 0);
    assert.strictEqual(snap.channels.governor.modeChanges, 1, "warming -> NORMAL");
    assert.strictEqual(snap.channels.governor.p95Ms, 105);
    assert.ok(lines.some((l) => l.startsWith("governor: CONSTRAINED -> NORMAL")));
    started.governor.stop();
    started.governor.stop();
    bad.remove();
    assert.strictEqual(t.capture().governor, null);
    t.stop();
    assert.deepStrictEqual(t.addTickListener(() => {}), { ok: false, reason: "stopped" });

    const drifted = fakeAdapter(tidi, { telemetry: "missing:utils/tidiAutoscaler" });
    const t2 = startTelemetry({ config, adapter: drifted, modDir: MOD_DIR, logger: { log() {} }, timers: fakeTimers(),
      perfHooks: fakePerf(), clock: { now: () => 0 } }).telemetry;
    const g2 = startGovernor({ config, telemetry: t2, logger: { log() {} }, now: () => now });
    const s2 = t2.capture();
    assert.deepStrictEqual([s2.governor.mode, s2.governor.reason], [MODE.NORMAL, "no_tick_samples"]);
    assert.strictEqual(drifted.calls.subscribe, 0);
    g2.governor.stop();
    t2.stop();
    assert.deepStrictEqual(startGovernor({ config, telemetry: null, logger: { log() {} } }),
      { ok: false, reason: "telemetry_unavailable" });
  });

  test("GR1 governor runAdmitted: admits every known class inside the scope only, refused in SHED", () => {
    const config = { ...P95_CONFIG, dataDir: null };
    const tidi = { observeRuntimeTickSample() { return { changed: false }; } };
    const t = startTelemetry({ config, adapter: fakeAdapter(tidi), modDir: MOD_DIR, logger: { log() {} },
      timers: fakeTimers(), perfHooks: fakePerf(), clock: { now: () => 0 } }).telemetry;
    let now = 1000;
    const gov = startGovernor({ config, telemetry: t, logger: { log() {} }, now: () => now }).governor;
    assert.notStrictEqual(gov.getPolicy().mode, MODE.SHED);
    assert.strictEqual(gov.admits("MAINTENANCE"), false, "warming holds MAINTENANCE");
    const inside = gov.runAdmitted(() => [gov.admits("MAINTENANCE"), gov.admits("STRATEGIC"), gov.admits("NOPE")]);
    assert.deepStrictEqual(inside, { ok: true, value: [true, true, false] });
    assert.strictEqual(gov.admits("MAINTENANCE"), false, "scope ended");
    assert.throws(() => gov.runAdmitted(() => { throw new Error("boom"); }), /boom/);
    assert.strictEqual(gov.admits("MAINTENANCE"), false, "scope ended after a throw");
    assert.deepStrictEqual(gov.runAdmitted(null), { ok: false, reason: "BAD_ARGUMENT" });
    tidi.observeRuntimeTickSample(summary(now, 5000));
    now += 1;
    assert.strictEqual(gov.evaluate(now).mode, MODE.SHED);
    let ran = false;
    assert.deepStrictEqual(gov.runAdmitted(() => { ran = true; }), { ok: false, reason: "SHED" });
    assert.strictEqual(ran, false);
    gov.stop();
    t.stop();
  });

  test("T3 governor defaults: scattered 125 ms ticks stay NORMAL, 10 -> CONSTRAINED, 112 ms hysteresis", () => {
    assert.deepStrictEqual([options().sampleCount, options().recoveryThresholdMs, options().recoveryMs],
      [100, 112, 15000], "D-e defaults");
    const noHold = { minModeHoldMs: 0 };
    const o = options(noHold);
    const tickMs = 100;
    let t = 0;
    const run = (gov, value, count) => {
      for (let i = 0; i < count; i += 1) {
        t += tickMs;
        gov.record(value, t);
      }
      return gov.evaluate(t);
    };
    const { gov, seen } = governor({}, noHold);
    assert.strictEqual(run(gov, 100, o.sampleCount).mode, MODE.NORMAL);
    for (let k = 0; k < 4; k += 1) {
      run(gov, 125, 1);
      assert.strictEqual(run(gov, 100, 20).mode, MODE.NORMAL, `scattered 125 ms #${k + 1}`);
    }
    assert.strictEqual(run(gov, 125, 10).mode, MODE.CONSTRAINED);
    const rec = run(gov, 108, o.sampleCount);
    assert.deepStrictEqual([rec.mode, rec.phase], [MODE.CONSTRAINED, "recovering"]);
    const recoveryStart = t;
    while (t - recoveryStart < o.recoveryMs - tickMs) {
      assert.strictEqual(run(gov, 108, 1).phase, "recovering", `still recovering at +${t - recoveryStart} ms`);
    }
    const back = run(gov, 108, 1);
    assert.deepStrictEqual([back.mode, back.phase, t - recoveryStart >= o.recoveryMs], [MODE.NORMAL, "healthy", true]);
    assert.deepStrictEqual(seen, ["CONSTRAINED->NORMAL", "NORMAL->CONSTRAINED", "CONSTRAINED->NORMAL"]);

    const other = governor({}, noHold);
    run(other.gov, 100, o.sampleCount);
    assert.strictEqual(run(other.gov, 125, 10).mode, MODE.CONSTRAINED);
    const held = run(other.gov, 115, o.sampleCount);
    assert.deepStrictEqual([held.mode, held.phase], [MODE.CONSTRAINED, "constrained"], "115 >= 112 stays");
    assert.strictEqual(run(other.gov, 115, 200).mode, MODE.CONSTRAINED);
  });

  test("GF1 governor samples the tick interval: 100/5 -> NORMAL, 125/5 -> CONSTRAINED; vendor facts", () => {
    const src = findServerSrcOnDisk(MOD_DIR, SERVER_SEARCH_MAX_DEPTH, fs.existsSync);
    assert.ok(src.ok, "EveJS server/src not found above the mod");
    const tickSource = fs.readFileSync(path.join(src.srcDir, "space", "runtime", "spaceRuntime", "tick.js"), "utf8");
    assert.match(tickSource, /actualIntervalMs\s*=\s*Math\.max\(\s*this\._tickIntervalMs/);
    const clockSource = fs.readFileSync(path.join(src.srcDir, "space", "runtime", "runtimeClock.js"), "utf8");
    assert.match(clockSource, /RUNTIME_TICK_INTERVAL_MS\s*=\s*100\b/);

    const config = { ...P95_CONFIG, dataDir: null };
    const tidi = { observeRuntimeTickSample() { return { changed: false }; } };
    const t = startTelemetry({ config, adapter: fakeAdapter(tidi), modDir: MOD_DIR, logger: { log() {} },
      timers: fakeTimers(), perfHooks: fakePerf(), clock: { now: () => 0 } }).telemetry;
    let now = 1000;
    const started = startGovernor({ config, telemetry: t, logger: { log() {} }, now: () => now });
    assert.strictEqual(started.ok, true);
    const push = (intervalMs, workMs, count) => {
      for (let i = 0; i < count; i += 1) {
        now += TICK_STEP_MS;
        tidi.observeRuntimeTickSample(summary(now, intervalMs, workMs));
      }
    };
    push(100, 5, 200);
    const punctual = started.governor.evaluate(now);
    assert.deepStrictEqual([punctual.mode, punctual.latestMs], [MODE.NORMAL, 100], "100 ms = punctual tick");
    push(125, 5, 200);
    assert.strictEqual(started.governor.evaluate(now).mode, MODE.CONSTRAINED, "late ticks with 5 ms work");
    started.governor.stop();
    t.stop();
  });

  test("GF2 governor no flapping: band 120-129 <= 2 changes; production pattern stays OVERLOADED; bound 49/h", () => {
    const band = gfGovernor();
    drive(band.gov, 600, (s) => ticks(0).map((_, i) => 120 + ((s * 10 + i) % 10)), 0);
    assert.ok(band.gov.getStatus().changes <= 2, `band changes ${band.gov.getStatus().changes}`);
    assert.strictEqual(band.gov.getPolicy().mode, MODE.CONSTRAINED);

    const cycle = [121, 124, 127, 129, 122, 126, 128, 120, 123, 125];
    const production = (s) => [...ticks(100, 9), s % 60 < 10 ? 135 : cycle[s % cycle.length]];
    const prod = gfGovernor();
    drive(prod.gov, 1800, production, 0);
    assert.ok(prod.gov.getStatus().changes <= 2, `production changes ${prod.gov.getStatus().changes}`);
    assert.strictEqual(prod.gov.getStatus().baseMode, MODE.OVERLOADED);

    const old = gfGovernor({ minModeHoldMs: 0, overloadExitP95Ms: 130 });
    drive(old.gov, 1800, production, 0);
    assert.ok(old.gov.getStatus().changes >= 20, `control without hold oscillates: ${old.gov.getStatus().changes}`);

    const worst = gfGovernor();
    drive(worst.gov, 3600, (s) => ticks(s % 90 < 30 ? 135 : 100), 0);
    const changes = worst.gov.getStatus().changes;
    assert.ok(changes <= 44 && changes >= 2, `worst case changes ${changes}`);

    const sweep = {};
    for (const P of [31, 35, 45, 60, 200]) {
      const g = gfGovernor();
      drive(g.gov, 3600, (s) => ticks(s % P < 2 ? 650 : 100), 0);
      sweep[P] = g.gov.getStatus().changes;
    }
    assert.ok(Object.values(sweep).every((c) => c <= 50), `stall sweep ${JSON.stringify(sweep)}`);
    const noCooldown = gfGovernor({ shedFastExitCooldownMs: 0 });
    drive(noCooldown.gov, 3600, (s) => ticks(s % 35 < 2 ? 650 : 100), 0);
    assert.ok(noCooldown.gov.getStatus().changes >= 100,
      `control without the fast exit cooldown: ${noCooldown.gov.getStatus().changes}`);
  });

  test("GF3 governor spike overlay: SHED without a base change, no callback, back to the base after the hold", () => {
    const { gov, seen } = gfGovernor();
    let t = drive(gov, 150, () => ticks(100), 0);
    assert.strictEqual(gov.getPolicy().mode, MODE.NORMAL);
    const changes = gov.getStatus().changes;
    const calls = seen.length;
    gov.record(650, t + TICK_STEP_MS);
    const shed = gov.evaluate(t + TICK_STEP_MS + 500);
    const st = gov.getStatus();
    assert.deepStrictEqual([shed.mode, st.baseMode, st.overlay, gov.admits("SETTLEMENT"), st.changes, st.counts.spikeSheds,
      seen.length], [MODE.SHED, MODE.NORMAL, "unplayable", false, changes, 1, calls]);
    gov.evaluate(t + TICK_STEP_MS + 700);
    assert.deepStrictEqual([gov.getPolicy().mode, gov.getStatus().counts.spikeSheds], [MODE.SHED, 1]);
    const back = gov.evaluate(t + TICK_STEP_MS + 1500);
    assert.deepStrictEqual([back.mode, gov.getStatus().changes, gov.getStatus().overlay], [MODE.NORMAL, changes, null]);
    gov.record(650, t + TICK_STEP_MS + 1600);
    gov.evaluate(t + TICK_STEP_MS + 1700);
    assert.deepStrictEqual([gov.getPolicy().mode, gov.getStatus().counts.spikeSheds], [MODE.SHED, 2], "new episode");

    const c = gfGovernor();
    t = drive(c.gov, 150, () => ticks(125), 0);
    const since = c.gov.getStatus().modeSinceMs;
    assert.strictEqual(c.gov.getPolicy().mode, MODE.CONSTRAINED);
    c.gov.record(520, t + TICK_STEP_MS);
    c.gov.evaluate(t + TICK_STEP_MS + 500);
    assert.deepStrictEqual([c.gov.getPolicy().mode, c.gov.getStatus().baseMode, c.gov.getStatus().overlay],
      [MODE.SHED, MODE.CONSTRAINED, "shed"]);
    c.gov.evaluate(t + TICK_STEP_MS + 1500);
    assert.deepStrictEqual([c.gov.getPolicy().mode, c.gov.getStatus().modeSinceMs], [MODE.CONSTRAINED, since]);
  });

  test("GF4 governor escalates at once, steps down one level after the mode hold; sustained >= 600 -> base SHED", () => {
    const { gov, seen } = gfGovernor();
    let t = drive(gov, 150, () => ticks(100), 0);
    const before = seen.length;
    t = drive(gov, 1, () => ticks(135), t);
    const entry = t;
    assert.strictEqual(gov.getPolicy().mode, MODE.OVERLOADED);
    assert.deepStrictEqual(seen.slice(before), ["NORMAL->OVERLOADED"], "no CONSTRAINED step on the way up");
    const at = (target) => {
      t = drive(gov, (entry + target - t) / PASS_MS, () => ticks(100), t);
      return [gov.getPolicy().mode, gov.getPolicy().phase];
    };
    assert.deepStrictEqual(at(30000), [MODE.OVERLOADED, "recovering"]);
    assert.deepStrictEqual(at(179000), [MODE.OVERLOADED, "recovering"]);
    assert.strictEqual(at(180000)[0], MODE.CONSTRAINED, "one level down, not NORMAL");
    assert.strictEqual(at(359000)[0], MODE.CONSTRAINED);
    assert.strictEqual(at(360000)[0], MODE.NORMAL);
    const changes = gov.getStatus().changes;
    drive(gov, 20, () => ticks(650), t);
    const st = gov.getStatus();
    assert.deepStrictEqual([st.baseMode, st.reason, st.changes > changes], [MODE.SHED, "unplayable_circuit_breaker", true]);
  });

  test("GF5 governor log limiter: 1 line per window + suppressed summary; config defaults; overloadExit clamp", () => {
    const run = (logMinIntervalSeconds) => {
      const config = { ...CONFIG, governor: { ...P95_CONFIG.governor, minModeHoldSeconds: 0, recoverySeconds: 0,
        logMinIntervalSeconds } };
      const telemetry = fakeGovTelemetry();
      const lines = [];
      const started = startGovernor({ config, telemetry, logger: { log: (m) => lines.push(m) }, now: () => 0 });
      assert.strictEqual(started.ok, true);
      const step = (value, atMs) => {
        for (let i = 0; i < GF_OPTIONS.sampleCount; i += 1) telemetry.push({ intervalMs: value, workMs: 1, atMs });
        return started.governor.evaluate(atMs);
      };
      for (const [value, atMs] of [[100, 2000], [125, 3000], [135, 4000], [650, 5000], [125, 10000]]) step(value, atMs);
      return { lines, telemetry, started, step };
    };
    const limited = run(60);
    const transitions = () => limited.lines.filter((l) => l.includes(" -> "));
    assert.strictEqual(transitions().length, 1);
    assert.deepStrictEqual([limited.telemetry.counters["governor.logSuppressed"],
      limited.telemetry.counters["governor.modeChanges"]], [4, 5]);
    const before = limited.lines.length;
    assert.strictEqual(limited.step(125, 63000).mode, MODE.OVERLOADED);
    const added = limited.lines.slice(before);
    assert.strictEqual(added.length, 1);
    assert.ok(added[0].includes("suppressed=4"), added[0]);
    assert.strictEqual(limited.telemetry.counters["governor.spikeSheds"], 1);
    assert.strictEqual(run(0).lines.filter((l) => l.includes(" -> ")).length, 5);

    const overlaid = run(60);
    const mark = overlaid.lines.length;
    for (let i = 0; i < GF_OPTIONS.sampleCount - 1; i += 1) overlaid.telemetry.push({ intervalMs: 125, workMs: 1, atMs: 63000 });
    overlaid.telemetry.push({ intervalMs: 650, workMs: 1, atMs: 63000 });
    const policy = overlaid.started.governor.evaluate(63000);
    const summaryLines = overlaid.lines.slice(mark);
    assert.deepStrictEqual([policy.mode, overlaid.started.governor.getStatus().baseMode, summaryLines.length],
      [MODE.SHED, MODE.OVERLOADED, 1]);
    assert.ok(summaryLines[0].includes("now OVERLOADED (sustained_overload)") && summaryLines[0].includes("overlay=unplayable")
      && summaryLines[0].includes("suppressed=4") && !summaryLines[0].includes("unplayable_circuit_breaker"), summaryLines[0]);

    assert.deepStrictEqual([CONFIG.governor.overloadExitP95Ms, CONFIG.governor.minModeHoldSeconds,
      CONFIG.governor.logMinIntervalSeconds], [120, 180, 60]);
    const raw = governorOptionsFromConfig(CONFIG);
    assert.deepStrictEqual([raw.overloadExitP95Ms, raw.minModeHoldMs], [120, 180000]);
    const clamped = normalizeOptions({ ...raw, overloadExitP95Ms: 140, overloadP95Ms: 130 });
    assert.strictEqual(clamped.options.overloadExitP95Ms, 130);
    assert.ok(clamped.adjusted.includes("overloadExitP95Ms"));

    assert.deepStrictEqual([CONFIG.governor.shedMinHoldSeconds, CONFIG.governor.shedFastExitCooldownSeconds], [30, 3600]);
    assert.deepStrictEqual([raw.shedMinHoldMs, raw.shedFastExitCooldownMs], [30000, 3600000]);
    const shedClamped = normalizeOptions({ ...raw, shedMinHoldMs: 200000 });
    assert.strictEqual(shedClamped.options.shedMinHoldMs, 180000);
    assert.ok(shedClamped.adjusted.includes("shedMinHoldMs"));
  });

  const stall = (gov, t0) => {
    let t = t0;
    let shedAt = null;
    for (let i = 0; i < 2; i += 1) {
      t = drive(gov, 1, () => ticks(650), t);
      if (shedAt === null && gov.getStatus().baseMode === MODE.SHED) shedAt = t;
    }
    assert.ok(shedAt !== null, "stall enters base SHED");
    return { t, shedAt };
  };
  const until = (gov, t, target, value) => {
    assert.ok(target >= t, `target ${target} before now ${t}`);
    return drive(gov, (target - t) / PASS_MS, () => ticks(value), t);
  };
  const look = (gov) => [gov.getPolicy().mode, gov.getStatus().counts.shedFastExits];

  test("GF6 governor base SHED steps down after shedMinHold (fast exit), at most once per cooldown", () => {
    const { gov, seen } = gfGovernor();
    let t = drive(gov, 150, () => ticks(100), 0);
    const a = stall(gov, t);
    t = until(gov, a.t, a.shedAt + 29000, 300);
    assert.deepStrictEqual([gov.getPolicy().mode, gov.getPolicy().phase, gov.admits("SETTLEMENT")],
      [MODE.SHED, "recovering", false], "t_s + 29 s");
    t = until(gov, t, a.shedAt + 30000, 300);
    const fastExitAt = t;
    assert.deepStrictEqual([...look(gov), gov.admits("SETTLEMENT"), gov.admits("LIVE"), gov.admits("OPERATIONAL"),
      seen[seen.length - 1]], [MODE.OVERLOADED, 1, true, true, false, "SHED->OVERLOADED"], "t_s + 30 s");
    t = until(gov, t, a.shedAt + 90000, 300);
    assert.deepStrictEqual(look(gov), [MODE.OVERLOADED, 1], "t_s + 90 s");

    const b = stall(gov, t);
    t = until(gov, b.t, b.shedAt + 60000, 300);
    assert.deepStrictEqual(look(gov), [MODE.SHED, 1], "t_s2 + 60 s");
    t = until(gov, t, b.shedAt + 179000, 300);
    assert.deepStrictEqual(look(gov), [MODE.SHED, 1], "t_s2 + 179 s");
    t = until(gov, t, b.shedAt + 180000, 300);
    const slowExitAt = t;
    assert.deepStrictEqual(look(gov), [MODE.OVERLOADED, 1], "t_s2 + 180 s");

    t = until(gov, t, fastExitAt + GF_OPTIONS.shedFastExitCooldownMs, 300);
    assert.ok(t < slowExitAt + GF_OPTIONS.shedFastExitCooldownMs);
    const c = stall(gov, t);
    t = until(gov, c.t, c.shedAt + 29000, 300);
    assert.deepStrictEqual(look(gov), [MODE.SHED, 1], "t_s3 + 29 s");
    until(gov, t, c.shedAt + 30000, 300);
    assert.deepStrictEqual(look(gov), [MODE.OVERLOADED, 2], "t_s3 + 30 s");
  });

  test("GF7 governor gaps (J1/J5/J6): bounce restarts recovery, overloadExit raised, overlay during warm-up", () => {
    const { gov } = gfGovernor({ minModeHoldMs: 0 });
    let t = drive(gov, 150, () => ticks(100), 0);
    t = drive(gov, 1, () => ticks(135), t);
    assert.strictEqual(gov.getStatus().baseMode, MODE.OVERLOADED);
    let guard = 0;
    while (gov.getPolicy().p95Ms >= 120 && guard < 60) {
      t = drive(gov, 1, () => ticks(100), t);
      guard += 1;
    }
    t = drive(gov, 5, () => ticks(100), t);
    t = drive(gov, 1, () => ticks(125), t);
    assert.deepStrictEqual([gov.getPolicy().mode, gov.getPolicy().p95Ms], [MODE.OVERLOADED, 125], "bounce");
    guard = 0;
    do {
      t = drive(gov, 1, () => ticks(100), t);
      guard += 1;
    } while (gov.getPolicy().p95Ms >= 120 && guard < 60);
    const tb = t;
    const bounce = [gov.getPolicy().mode];
    t = until(gov, t, tb + 14000, 100);
    bounce.push(gov.getPolicy().mode);
    until(gov, t, tb + 15000, 100);
    bounce.push(gov.getPolicy().mode);
    assert.deepStrictEqual(bounce, [MODE.OVERLOADED, MODE.OVERLOADED, MODE.CONSTRAINED], "t_b, +14 s, +15 s");

    const raised = normalizeOptions({ ...governorOptionsFromConfig(CONFIG), overloadExitP95Ms: 105 });
    assert.deepStrictEqual([raised.options.overloadExitP95Ms, raised.adjusted.includes("overloadExitP95Ms")], [112, true]);

    const warm = gfGovernor().gov;
    for (let i = 0; i < 20; i += 1) warm.record(100, i * TICK_STEP_MS);
    warm.record(650, 2100);
    warm.evaluate(2600);
    const st = warm.getStatus();
    assert.deepStrictEqual([st.mode, st.phase, st.overlay, st.baseMode], [MODE.SHED, "unplayable", "unplayable", MODE.CONSTRAINED]);
    warm.evaluate(3200);
    const after = warm.getStatus();
    assert.deepStrictEqual([after.mode, after.phase, after.overlay], [MODE.CONSTRAINED, "warming", null]);
  });

  test("GL1 governor lateness: 6 x 400 ms in 10 s stays NORMAL (~2.91%), p95 signal OVERLOADED; padding after warm-up", () => {
    const lo = latenessOptions();
    const burst = (s) => [...ticks(100, 9), s < 6 ? 400 : 100];
    const run = (signal, punctual) => {
      const { gov, seen } = latenessGovernor({ signal });
      const t = driveLate(gov, punctual / ticks(0).length, () => ticks(100), 0);
      assert.strictEqual(gov.getStatus().baseMode, MODE.NORMAL, `${signal} warm`);
      const before = seen.length;
      driveLate(gov, 10, burst, t);
      return { gov, changes: seen.length - before };
    };
    const late = run("lateness", lo.latenessSampleCount);
    const st = late.gov.getStatus();
    assert.deepStrictEqual([st.baseMode, late.changes, st.latenessSamples], [MODE.NORMAL, 0, lo.latenessSampleCount]);
    assert.ok(Math.abs(st.latenessPercent - 2.91) < 0.01 && st.latenessPercent < lo.latenessWarningPercent,
      `lateness ${st.latenessPercent}`);
    assert.strictEqual(late.gov.getPolicy().latenessPercent, st.latenessPercent);
    assert.strictEqual(run("p95", lo.latenessSampleCount).gov.getStatus().baseMode, MODE.OVERLOADED, "p95 contrast");
    const warm = run("lateness", lo.sampleCount);
    const ws = warm.gov.getStatus();
    assert.deepStrictEqual([ws.baseMode, warm.changes, ws.latenessSamples], [MODE.NORMAL, 0, 200]);
    assert.ok(Math.abs(ws.latenessPercent - 2.91) < 0.01, `padded lateness ${ws.latenessPercent}`);
  });

  test("GL2 governor lateness: sustained 30% -> OVERLOADED, 18% -> CONSTRAINED; steps down one level after hold", () => {
    const lo = latenessOptions();
    const r = gl2Scenario();
    assert.ok(Math.abs(r.overloadedPercent - 30.07) < 0.01, `30% lateness ${r.overloadedPercent}`);
    assert.deepStrictEqual(r.seen, ["CONSTRAINED->NORMAL", "NORMAL->CONSTRAINED", "CONSTRAINED->OVERLOADED",
      "OVERLOADED->CONSTRAINED", "CONSTRAINED->NORMAL"]);
    const [, , up, down1, down2] = r.changes;
    assert.ok(down1.at - up.at >= lo.minModeHoldMs, "OVERLOADED held at least minModeHoldMs");
    assert.ok(down1.lateness < lo.latenessOverloadExitPercent, `exit OVERLOADED at ${down1.lateness}`);
    assert.ok(down2.at - down1.at >= lo.minModeHoldMs, "CONSTRAINED held at least minModeHoldMs");
    assert.ok(down2.lateness < lo.latenessRecoveryPercent, `exit CONSTRAINED at ${down2.lateness}`);
    assert.ok(down2.belowFor >= lo.recoveryMs, "below recovery for recoveryMs");

    const c = latenessGovernor();
    const t = driveLate(c.gov, lo.latenessSampleCount / ticks(0).length, () => ticks(100), 0);
    driveLate(c.gov, lo.latenessSampleCount / ticks(0).length, () => ticks(122), t);
    const cs = c.gov.getStatus();
    assert.strictEqual(cs.baseMode, MODE.CONSTRAINED);
    assert.ok(Math.abs(cs.latenessPercent - 18.03) < 0.01, `18% lateness ${cs.latenessPercent}`);
    assert.strictEqual(cs.reason, "tick_lateness_warning");
  });

  test("GL3 governor lateness keeps the SHED breaker and overlay: spike -> overlay, sustained 650 -> base SHED", () => {
    const lo = latenessOptions();
    const telemetry = fakeGovTelemetry();
    let now = 0;
    const started = startGovernor({ config: CONFIG, telemetry, logger: { log() {} }, now: () => now });
    assert.strictEqual(started.ok, true);
    const g = started.governor;
    const second = (values) => {
      for (let i = 0; i < values.length; i += 1) {
        telemetry.push({ intervalMs: values[i], workMs: 1, latenessMs: values[i] - 100, atMs: now + i * TICK_STEP_MS });
      }
      now += PASS_MS;
      return g.evaluate(now);
    };
    for (let s = 0; s < lo.latenessSampleCount / ticks(0).length; s += 1) second(ticks(100));
    assert.strictEqual(g.getStatus().baseMode, MODE.NORMAL);
    const spike = second([...ticks(100, 9), 700]);
    assert.deepStrictEqual([spike.mode, g.getStatus().baseMode, g.getStatus().counts.spikeSheds,
      telemetry.counters["governor.spikeSheds"]], [MODE.SHED, MODE.NORMAL, 1, 1]);
    assert.strictEqual(telemetry.counters["governor.escalations.p95Unplayable"], 0);
    for (let s = 0; s < 10; s += 1) second(ticks(650));
    assert.strictEqual(g.getStatus().baseMode, MODE.SHED);
    const shedAt = now;
    assert.strictEqual(telemetry.counters["governor.escalations.p95Unplayable"], 1);
    while (now - shedAt < lo.shedMinHoldMs) second(ticks(100));
    const st = g.getStatus();
    assert.deepStrictEqual([st.baseMode, st.counts.shedFastExits], [MODE.OVERLOADED, 1]);
    assert.ok(st.latenessPercent >= lo.latenessOverloadPercent, `window still late ${st.latenessPercent}`);
    started.governor.stop();
  });

  test("GL4 governor lateness options: signal, chain, record without lateness; residency sums to the run", () => {
    const raw = { ...governorOptionsFromConfig(CONFIG) };
    assert.throws(() => normalizeOptions({ ...raw, signal: "x" }), RangeError);
    assert.throws(() => normalizeOptions({ ...raw, latenessSampleCount: 0 }), RangeError);
    const up = normalizeOptions({ ...raw, latenessOverloadPercent: 10, latenessWarningPercent: 15 });
    assert.deepStrictEqual([up.options.latenessOverloadPercent, up.adjusted.includes("latenessOverloadPercent")],
      [15, true]);
    const down = normalizeOptions({ ...raw, latenessOverloadExitPercent: 40 });
    assert.deepStrictEqual([down.options.latenessOverloadExitPercent, down.adjusted.includes("latenessOverloadExitPercent")],
      [raw.latenessOverloadPercent, true]);
    const { gov } = latenessGovernor();
    gov.record(100, 0);
    gov.record(100, 0, Number.NaN);
    gov.record(100, 0, 101);
    gov.record(100, 0, -1);
    assert.strictEqual(gov.evaluate(0).latenessPercent, 0);
    assert.strictEqual(gov.getStatus().latenessSamples, 0);
    gov.record(100, 0, 0);
    gov.evaluate(0);
    assert.strictEqual(gov.getStatus().latenessSamples, 1);

    const r = gl2Scenario();
    const res = r.gov.getStatus().residencyMs;
    const total = res.NORMAL + res.CONSTRAINED + res.OVERLOADED + res.SHED;
    assert.strictEqual(total, r.t, "residency = time from the first to the last evaluation");
    assert.ok(res.OVERLOADED > 0 && Object.isFrozen(res));
  });

  test("GL5 governor lateness edge: sample latenessMs into the ring, gauges, latenessWarning, log; defaults; vendor fact", () => {
    assert.deepStrictEqual([CONFIG.governor.signal, CONFIG.governor.latenessSampleCount,
      CONFIG.governor.latenessWarningPercent, CONFIG.governor.latenessOverloadPercent,
      CONFIG.governor.latenessRecoveryPercent, CONFIG.governor.latenessOverloadExitPercent],
    ["lateness", 600, 15, 25, 10, 15], "Defaults");
    const src = findServerSrcOnDisk(MOD_DIR, SERVER_SEARCH_MAX_DEPTH, fs.existsSync);
    assert.ok(src.ok, "EveJS server/src not found above the mod");
    const tickSource = fs.readFileSync(path.join(src.srcDir, "space", "runtime", "spaceRuntime", "tick.js"), "utf8");
    assert.ok(tickSource.includes("latenessMs: Math.max(0, actualIntervalMs - this._tickIntervalMs)"));
    assert.match(tickSource, /const actualIntervalMs = Math\.max\(\r?\n\s*this\._tickIntervalMs,/);

    const config = { ...CONFIG, governor: { ...CONFIG.governor, logMinIntervalSeconds: 0 } };
    const telemetry = fakeGovTelemetry();
    const gauges = {};
    telemetry.gauge = (name, value) => { gauges[name] = value; };
    const lines = [];
    let now = 0;
    const started = startGovernor({ config, telemetry, logger: { log: (m) => lines.push(m) }, now: () => now });
    assert.strictEqual(started.ok, true);
    assert.ok(lines.some((l) => l.startsWith("governor: running") && l.includes("signal=lateness")
      && l.includes("latenessWindow=600")), lines[0]);
    telemetry.push({ intervalMs: 100, workMs: 1, latenessMs: 0, atMs: now });
    assert.strictEqual(started.governor.evaluate(now).latenessPercent, 0);
    assert.strictEqual(started.governor.getStatus().latenessSamples, 1);
    for (const name of ["governor.latenessPercent", "governor.residencySeconds.normal",
      "governor.residencySeconds.constrained", "governor.residencySeconds.overloaded", "governor.residencySeconds.shed"]) {
      assert.ok(Object.prototype.hasOwnProperty.call(gauges, name), name);
    }
    const second = (value) => {
      for (let i = 0; i < ticks(0).length; i += 1) {
        telemetry.push({ intervalMs: value, workMs: 1, latenessMs: value - 100, atMs: now + i * TICK_STEP_MS });
      }
      now += PASS_MS;
      started.governor.evaluate(now);
    };
    for (let s = 0; s < 60; s += 1) second(100);
    for (let s = 0; s < 60; s += 1) second(122);
    assert.strictEqual(started.governor.getStatus().baseMode, MODE.CONSTRAINED);
    assert.deepStrictEqual([telemetry.counters["governor.escalations.latenessWarning"],
      telemetry.counters["governor.escalations.p95Warning"], telemetry.counters["governor.escalations.latenessOverload"]],
    [1, 0, 0]);
    assert.ok(gauges["governor.latenessPercent"] > CONFIG.governor.latenessWarningPercent);
    const line = lines.find((l) => l.startsWith("governor: NORMAL -> CONSTRAINED"));
    assert.ok(line && line.includes("lateness=") && line.includes("(tick_lateness_warning)"), line);
    started.governor.stop();
  });

  test("GL6: a base change under the spike overlay logs the base reason + overlay", () => {
    const config = { ...CONFIG, governor: { ...CONFIG.governor, logMinIntervalSeconds: 0 } };
    const telemetry = fakeGovTelemetry();
    const lines = [];
    let now = 0;
    const started = startGovernor({ config, telemetry, logger: { log: (m) => lines.push(m) }, now: () => now });
    const g = started.governor;
    const second = (values) => {
      for (let i = 0; i < values.length; i += 1) {
        telemetry.push({ intervalMs: values[i], workMs: 1, latenessMs: values[i] - 100, atMs: now + i * TICK_STEP_MS });
      }
      now += PASS_MS;
      g.evaluate(now);
    };
    for (let s = 0; s < 60; s += 1) second(ticks(100));
    let guard = 0;
    while (g.getStatus().baseMode === MODE.NORMAL && guard < 120) {
      second([...ticks(100, 9), 550]);
      guard += 1;
    }
    const st = g.getStatus();
    assert.deepStrictEqual([st.baseMode !== MODE.NORMAL, st.overlay, st.mode], [true, "shed", MODE.SHED]);
    const line = lines.find((l) => l.startsWith("governor: NORMAL -> "));
    assert.ok(line && line.includes(`(${st.baseReason}) overlay=shed`) && !line.includes("emergency_background_shed"),
      line);
    g.stop();
  });

  test("GB1: the 21 s boot spike inside the grace is not counted; control without "
    + "grace goes OVERLOADED", () => {
    const run = (graceEnd) => {
      const gov = createLoadGovernor({ options: latenessOptions(), tickAvailable: true, nowMs: 0,
        bootGraceEndsAtMs: graceEnd });
      const modes = new Set();
      gov.record(BOOT_SPIKE_MS, BOOT_SPIKE_AT_MS, BOOT_SPIKE_MS - 100);
      for (let t = BOOT_SPIKE_AT_MS + TICK_STEP_MS; t <= GRACE_END_MS + 60000; t += TICK_STEP_MS) {
        gov.record(100, t, 0);
        if (t % PASS_MS === 0) {
          gov.evaluate(t);
          modes.add(gov.getPolicy().mode).add(gov.getStatus().baseMode);
        }
      }
      return { gov, modes };
    };
    const graced = run(GRACE_END_MS);
    const st = graced.gov.getStatus();
    assert.ok(!graced.modes.has(MODE.OVERLOADED) && !graced.modes.has(MODE.SHED), [...graced.modes].join(","));
    assert.strictEqual(st.latenessPercent, 0);
    assert.strictEqual(st.counts.emergencySamples, 0);
    assert.ok(st.counts.bootGraceSamples > 0, `bootGraceSamples ${st.counts.bootGraceSamples}`);
    const control = run(-Infinity);
    assert.ok(control.modes.has(MODE.OVERLOADED), `control ${[...control.modes].join(",")}`);
    assert.strictEqual(control.gov.getStatus().counts.bootGraceSamples, 0);
  });

  test("GB2: a spike starting after the grace escalates; no stale inside the grace", () => {
    const changes = [];
    const gov = createLoadGovernor({ options: latenessOptions(), tickAvailable: true, nowMs: 0,
      bootGraceEndsAtMs: GRACE_END_MS,
      onModeChange: (from, to, policy) => changes.push({ at: policy.evaluatedAtMs, reason: policy.reason }) });
    const phases = [];
    let t = 0;
    const until = (endMs) => {
      let n = 0;
      for (t += TICK_STEP_MS; t <= endMs; t += TICK_STEP_MS) {
        gov.record(100, t, 0);
        n += 1;
        if (n % (PASS_MS / TICK_STEP_MS) === 0) phases.push({ at: t, phase: gov.evaluate(t).phase });
      }
      t -= TICK_STEP_MS;
    };
    until(GRACE_END_MS + 60000);
    assert.ok(phases.filter((p) => p.at <= GRACE_END_MS).every((p) => p.phase !== "stale"), "no stale in the grace");
    assert.ok(!changes.some((c) => c.reason === "tick_samples_stale"), JSON.stringify(changes));
    assert.strictEqual(gov.getStatus().baseMode, MODE.NORMAL);
    const bootSamples = gov.getStatus().counts.bootGraceSamples;
    const spikeAt = t + BOOT_SPIKE_MS;
    assert.ok(spikeAt - BOOT_SPIKE_MS >= GRACE_END_MS);
    gov.record(BOOT_SPIKE_MS, spikeAt, BOOT_SPIKE_MS - 100);
    t = spikeAt;
    const overlay = gov.evaluate(t);
    assert.strictEqual(overlay.mode, MODE.SHED, "spike overlay as before");
    until(spikeAt + 20000);
    const st = gov.getStatus();
    assert.deepStrictEqual([st.baseMode, st.counts.bootGraceSamples, st.counts.unplayableSamples],
      [MODE.OVERLOADED, bootSamples, 1]);
  });
};

const BOOT_SPIKE_MS = 21118;
const BOOT_SPIKE_AT_MS = 1500;
const GRACE_END_MS = 30000;

function latenessOptions(override = {}) {
  return normalizeOptions({ ...governorOptionsFromConfig(CONFIG), ...override }).options;
}

function latenessGovernor(override = {}) {
  const seen = [];
  const changes = [];
  const gov = createLoadGovernor({ options: latenessOptions(override), tickAvailable: true, nowMs: 0,
    onModeChange: (from, to, policy) => {
      seen.push(`${from}->${to}`);
      changes.push({ at: policy.evaluatedAtMs, lateness: policy.latenessPercent });
    } });
  return { gov, seen, changes };
}

function driveLate(gov, seconds, perSecond, t0) {
  let t = t0;
  for (let s = 0; s < seconds; s += 1) {
    const values = perSecond(s);
    for (let i = 0; i < values.length; i += 1) gov.record(values[i], t + i * TICK_STEP_MS, values[i] - 100);
    t += PASS_MS;
    gov.evaluate(t);
  }
  return t;
}

function gl2Scenario() {
  const lo = latenessOptions();
  const { gov, seen, changes } = latenessGovernor();
  const windowSeconds = lo.latenessSampleCount / ticks(0).length;
  let t = driveLate(gov, windowSeconds, () => ticks(100), 0);
  t = driveLate(gov, windowSeconds, () => ticks(143), t);
  assert.strictEqual(gov.getStatus().baseMode, MODE.OVERLOADED);
  const overloadedPercent = gov.getStatus().latenessPercent;
  let belowSince = null;
  let belowFor = 0;
  let guard = 0;
  while (gov.getStatus().baseMode !== MODE.NORMAL && guard < 3600) {
    t = driveLate(gov, 1, () => ticks(100), t);
    const p = gov.getStatus().latenessPercent;
    if (p < lo.latenessRecoveryPercent) {
      if (belowSince === null) belowSince = t;
      belowFor = t - belowSince;
    }
    guard += 1;
  }
  const last = changes[changes.length - 1];
  if (last) last.belowFor = belowFor;
  return { gov, seen, changes, t, overloadedPercent };
}
