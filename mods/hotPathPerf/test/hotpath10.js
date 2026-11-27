"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const { createTickStructuresThrottle } = require("../lib/tickStructuresThrottle");
const { loadConfig } = require("../config");

function fakeWorld(options = {}) {
  const st = { calls: [], returned: [], throwNext: false };
  const ss = {
    tickStructures: function tickStructures(nowMs) {
      st.calls.push(nowMs);
      if (st.throwNext) {
        st.throwNext = false;
        throw new Error("tick boom");
      }
      return ["rows"];
    },
  };
  class SpaceRuntime {
    tick(now) {
      st.returned.push(ss.tickStructures(now));
      if (options.extraInTick) ss.tickStructures(now);
      return "ticked";
    }
  }
  const rt = Object.create(SpaceRuntime.prototype);
  st.ss = ss;
  st.rt = rt;
  st.Runtime = SpaceRuntime;
  st.original = ss.tickStructures;
  return st;
}

function wired(cfg = {}, options = {}) {
  const lines = [];
  const w = fakeWorld(options);
  const t = createTickStructuresThrottle({ config: { tickStructuresMinIntervalMs: 1000, ...cfg }, log: (l) => lines.push(l) });
  w.Runtime.prototype.tick = t.wrapRuntimeTick(w.Runtime.prototype.tick);
  w.ss.tickStructures = t.wrapTickStructures(w.ss.tickStructures);
  return { w, t, lines };
}

function register(ctx) {
  const { test, config, loader, SERVER_SRC } = ctx;
  const { createState, patchTarget, probeMessage, checkTickStructDrift, requestPatternFor, TICKSTRUCT_POINTS } = loader;

  test("K1 structure tick: 30 ticks every 100 ms = original 3× (0, 1000, 2000), skipped=27, skipped ones return undefined", () => {
    const { w, t } = wired();
    for (let i = 0; i < 30; i += 1) assert.strictEqual(w.rt.tick(i * 100), "ticked");
    assert.deepStrictEqual(w.calls, [0, 1000, 2000]);
    assert.strictEqual(w.returned.filter((r) => r === undefined).length, 27);
    assert.deepStrictEqual(w.returned.filter((r) => r !== undefined), [["rows"], ["rows"], ["rows"]]);
    const snap = t.statsSnapshot();
    assert.deepStrictEqual([snap.ranFromTick, snap.skipped, snap.ranAdhoc, snap.maxGapMs, snap.state], [3, 27, 0, 1000, "ready"]);
    assert.strictEqual(t.drainStatsLines()[0], "stats tickStructuresThrottle state=ready ranFromTick=3 skipped=27 ranAdhoc=0 maxGapMs=1000");
    const z = wired({ tickStructuresMinIntervalMs: 0 });
    for (let i = 0; i < 5; i += 1) z.w.rt.tick(i * 100);
    assert.strictEqual(z.w.calls.length, 5);
  });

  test("K2 structure tick: ad-hoc and the second call in a tick always run the original; ad-hoc moves lastRunAtMs", () => {
    const { w, t } = wired({}, { extraInTick: true });
    w.rt.tick(0);
    w.rt.tick(100);
    assert.deepStrictEqual(w.calls, [0, 0, 100], "second call in a tick = original, the first in the window skipped");
    assert.deepStrictEqual(w.ss.tickStructures(150), ["rows"]);
    assert.deepStrictEqual(w.ss.tickStructures(160), ["rows"]);
    w.ss.tickStructures(1500);
    const before = w.calls.length;
    w.rt.tick(2000);
    assert.deepStrictEqual(w.calls.slice(before), [2000], "only the second one (scene loop) ran");
    const snap = t.statsSnapshot();
    assert.deepStrictEqual([snap.ranFromTick, snap.ranAdhoc, snap.skipped], [1, 6, 2]);
  });

  test("K3 structure tick: original's exception goes to the caller, the next tick in the window calls the original; clock moved back = original; non-number = original", () => {
    const { w, t } = wired();
    w.throwNext = true;
    assert.throws(() => w.rt.tick(0), /tick boom/);
    w.rt.tick(100);
    assert.deepStrictEqual(w.calls, [0, 100], "after an exception there is no lastRunAtMs, so it runs");
    w.rt.tick(5000);
    w.rt.tick(4000);
    assert.deepStrictEqual(w.calls, [0, 100, 5000, 4000], "clock moved back = runs");
    w.rt.tick(4100);
    assert.strictEqual(w.calls.length, 4, "after moving back the window counts from 4000");
    w.rt.tick("abc");
    assert.strictEqual(w.calls.length, 5, "non-number = runs");
    assert.strictEqual(t.status().disabledReason, null);
    const x = wired();
    x.w.rt.tick(0);
    x.w.ss.tickStructures(100);
    assert.strictEqual(x.w.calls.length, 2);
  });

  test("K4 structure tick: loader (flag false, order, drift, probe, require pattern) and config (clamp > 10000)", () => {
    const quiet = Object.fromEntries(loader.POINTS.map((p) => [p.flag, false]));
    const base = { ...config, ...quiet, prewarmLocations: false };
    const on = createState({ ...base, tickStructuresThrottle: true }, null, { log: () => {} });
    const v = fakeWorld();
    const rawTick = v.Runtime.prototype.tick;
    patchTarget("spaceRuntime", v.rt, on);
    patchTarget("structureState", v.ss, on);
    for (const p of TICKSTRUCT_POINTS) assert.ok(on.patched.has(p.symbol), p.symbol);
    assert.strictEqual(v.ss.tickStructures.__hotPathPerfOriginal, v.original);
    assert.strictEqual(v.Runtime.prototype.tick.__hotPathPerfOriginal, rawTick);
    const wrappedTick = v.Runtime.prototype.tick;
    on.patched.clear();
    patchTarget("spaceRuntime", v.rt, on);
    patchTarget("structureState", v.ss, on);
    assert.strictEqual(v.Runtime.prototype.tick, wrappedTick, "no double wrap");
    v.rt.tick(0);
    v.rt.tick(100);
    assert.deepStrictEqual(v.calls, [0]);
    on.gameSeen = true;
    assert.strictEqual(checkTickStructDrift(on), false);
    assert.ok(/^probe: passed \(2 /.test(probeMessage(on)), probeMessage(on));
    assert.ok(on.requestPattern.test("../services/structure/structureState"));
    assert.strictEqual(on.tickStruct.status().state, "ready");

    const off = createState(base, null);
    const f = fakeWorld();
    const fTick = f.Runtime.prototype.tick;
    patchTarget("spaceRuntime", f.rt, off);
    patchTarget("structureState", f.ss, off);
    assert.strictEqual(off.tickStruct, null);
    assert.strictEqual(f.ss.tickStructures, f.original);
    assert.strictEqual(f.Runtime.prototype.tick, fTick);
    assert.strictEqual(off.requestPattern.source, requestPatternFor({}).source);
    assert.strictEqual(config.tickStructuresThrottle, false, "mod default false");
    assert.strictEqual(config.tickStructuresMinIntervalMs, 5000, "Default 5000");

    const ord = createState({ ...base, tickStructuresThrottle: true }, null, { log: () => {} });
    const o = fakeWorld();
    const inner = o.ss.tickStructures;
    o.ss.tickStructures = function otherMod() { return inner.apply(this, arguments); };
    patchTarget("structureState", o.ss, ord);
    assert.strictEqual(ord.tickStruct.status().state, "disabled:order");
    assert.strictEqual(o.ss.tickStructures.name, "otherMod");

    const dr = createState({ ...base, tickStructuresThrottle: true }, null, { log: () => {} });
    const d = fakeWorld();
    patchTarget("structureState", d.ss, dr);
    dr.gameSeen = true;
    assert.strictEqual(checkTickStructDrift(dr), true);
    const msg = probeMessage(dr);
    assert.ok(msg.startsWith("DRIFT: SpaceRuntime.tick#tickStructScope") && msg.endsWith("; tickStructuresThrottle disabled: drift"), msg);
    d.ss.tickStructures(0);
    d.ss.tickStructures(1);
    assert.strictEqual(d.calls.length, 2);

    const warns = [];
    const missing = path.join(__dirname, "missing.json");
    const capped = loadConfig({ env: { HOTPATH_TICK_STRUCTURES_MIN_INTERVAL_MS: "20000", HOTPATH_TICK_STRUCTURES_THROTTLE: "1" }, settingsPath: missing, warn: (m) => warns.push(m) });
    assert.deepStrictEqual([capped.tickStructuresMinIntervalMs, capped.tickStructuresThrottle], [10000, true]);
    assert.deepStrictEqual(warns, ["WARN tickStructuresMinIntervalMs=20000 capped to 10000"]);
    assert.strictEqual(loadConfig({ env: { HOTPATH_TICK_STRUCTURES_MIN_INTERVAL_MS: "250.7" }, settingsPath: missing }).tickStructuresMinIntervalMs, 250);
  });

  test("K5 vendor facts: tick.js calls tickStructures(now) once before the scene loop, export, setInterval(this.tick)", () => {
    if (!fs.existsSync(SERVER_SRC)) return;
    const read = (rel) => fs.readFileSync(path.join(SERVER_SRC, rel), "utf8").replace(/\r\n/g, "\n");
    const tick = read("space/runtime/spaceRuntime/tick.js");
    const tStart = tick.indexOf("\ntick(wallclockNowMs) {");
    assert.ok(tStart > 0, "tick(wallclockNowMs)");
    const body = tick.slice(tStart, tick.indexOf("\n},\n", tStart));
    const first = body.indexOf("tickStructures");
    assert.ok(first > 0 && body.slice(first - "structureState.".length).startsWith("structureState.tickStructures(now);"), "first occurrence = statement");
    const loop = body.indexOf("for (const scene of this.scenes.values())");
    assert.ok(loop > first, "before the scene loop");
    assert.ok(/const structureState = require\(path\.join\(\s*runtimeEntryDirname,\s*"\.\.\/services\/structure\/structureState",?\s*\)\);/.test(tick), "module object, no destructuring");
    const ss = read("services/structure/structureState.js");
    assert.ok(ss.includes("function tickStructures(nowMs = Date.now()) {") && ss.includes("\n  tickStructures,\n"));
    assert.ok(read("space/runtime.js").includes("setInterval(() => this.tick()"));
  });
}

module.exports = { register };
