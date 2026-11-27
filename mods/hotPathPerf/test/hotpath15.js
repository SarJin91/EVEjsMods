"use strict";

const assert = require("assert");

const { createStructuresSystemFilter, toPositiveInt } = require("../lib/structuresSystemFilter");
const { createTickStructuresThrottle } = require("../lib/tickStructuresThrottle");

const clone = (v) => JSON.parse(JSON.stringify(v));

const ROWS = Object.freeze([
  { structureID: 1001, solarSystemID: 30000142, name: "A", destroyedAt: 0, nested: { hp: [1, 2] } },
  { structureID: 1002, solarSystemID: 30000144, name: "B", destroyedAt: 0 },
  { structureID: 1004, solarSystemID: 30000142, name: "D", destroyedAt: null, nested: { x: null } },
]);

function fakeState(rows) {
  const st = { cache: { rows: rows.map(clone) }, ticks: 0 };
  function tickStructures() {
    st.ticks += 1;
    st.cache = { rows: st.cache.rows.map((r) => ({ ...clone(r), ticked: (r.ticked || 0) + 1 })) };
    return st.cache.rows.map(clone);
  }
  function peekStructuresForSystem(solarSystemID, options = {}) {
    const n = toPositiveInt(solarSystemID, 0);
    if (!n) return [];
    return st.cache.rows.filter((e) => (options.includeDestroyed === true || !e.destroyedAt) && e.solarSystemID === n);
  }
  function listStructuresForSystem(solarSystemID, options = {}) {
    const n = toPositiveInt(solarSystemID, 0);
    if (!n) return [];
    if (options.refresh !== false) st.exports.tickStructures(Date.now());
    return peekStructuresForSystem(n, options).map(clone);
  }
  st.exports = { tickStructures, peekStructuresForSystem, listStructuresForSystem };
  return st;
}

function setup(cfg = {}) {
  const lines = [];
  const clock = { t: 1000000 };
  const st = fakeState(ROWS);
  const f = createStructuresSystemFilter({
    config: { structuresSystemFilterParityCheck: false, structuresRefreshCoalesce: false, structuresRefreshFreshMs: 5000, ...cfg },
    log: (l) => lines.push(l), now: () => clock.t,
  });
  assert.strictEqual(f.setDeps(st.exports), true);
  st.exports.listStructuresForSystem = f.wrapListForSystem(st.exports.listStructuresForSystem);
  return { st, f, lines, clock, call: (opts) => st.exports.listStructuresForSystem(30000142, opts) };
}

function register(ctx) {
  const { test, src, config } = ctx;

  test("S1 refresh coalescing: default flags = every refresh ticks, config default off/5000", () => {
    assert.strictEqual(config.structuresRefreshCoalesce, false);
    assert.strictEqual(config.structuresRefreshFreshMs, 5000);
    const w = setup({ structuresRefreshCoalesce: config.structuresRefreshCoalesce });
    for (let i = 0; i < 4; i += 1) w.call();
    w.call({ refresh: false });
    assert.strictEqual(w.st.ticks, 4);
    const s = w.f.statsSnapshot();
    assert.deepStrictEqual([s.refreshRan, s.refreshSkipped, s.coalesce, s.served], [4, 0, "off", 5]);
    const z = setup({ structuresRefreshCoalesce: true, structuresRefreshFreshMs: 0 });
    z.call(); z.call();
    assert.strictEqual(z.st.ticks, 2);
  });

  test("S2 coalescing on: a series of 4 in the same ms = 1 tick, after the window a tick again; result = peek + clone", () => {
    const w = setup({ structuresRefreshCoalesce: true });
    const first = w.call();
    const skipped = [w.call(), w.call(), w.call()];
    assert.strictEqual(w.st.ticks, 1);
    const expected = w.st.exports.peekStructuresForSystem(30000142).map(clone);
    for (const r of skipped) {
      assert.deepStrictEqual(r, expected);
      assert.notStrictEqual(r, first);
      r.forEach((row, i) => assert.notStrictEqual(row, w.st.cache.rows.filter((e) => e.solarSystemID === 30000142)[i]));
    }
    w.clock.t += 4999;
    w.call();
    assert.strictEqual(w.st.ticks, 1);
    w.clock.t += 1;
    w.call();
    assert.strictEqual(w.st.ticks, 2);
    const s = w.f.statsSnapshot();
    assert.deepStrictEqual([s.refreshRan, s.refreshSkipped, s.refreshAgeMaxMs, s.coalesce, s.freshMs], [2, 4, 4999, "on", 5000]);
    const line = w.f.drainStatsLines()[0];
    assert.ok(/ refreshRan=2 refreshSkipped=4 refreshAgeMaxMs=4999 coalesce=on$/.test(line), line);
  });

  test("S3 freshness source from throttle: fresh lastRunAtMs = skip, throttle disabled = tick, clock moved back = tick", () => {
    const w = setup({ structuresRefreshCoalesce: true });
    const th = createTickStructuresThrottle({ config: { tickStructuresMinIntervalMs: 5000 }, log: () => {} });
    w.st.exports.tickStructures = th.wrapTickStructures(w.st.exports.tickStructures);
    assert.strictEqual(w.f.setFreshnessSource(() => { const s = th.status(); return s.enabled ? s.lastRunAtMs : null; }), true);
    assert.strictEqual(w.f.setFreshnessSource(() => 0), false, "second registration ignored");
    w.st.exports.tickStructures(w.clock.t - 100);
    assert.strictEqual(w.st.ticks, 1);
    w.call();
    assert.strictEqual(w.st.ticks, 1, "skip without its own tick");
    th.disable("test");
    w.call();
    assert.strictEqual(w.st.ticks, 2, "source null, no own refresh = tick");
    w.clock.t -= 10;
    w.call();
    assert.strictEqual(w.st.ticks, 3);
  });

  test("S4 a vendor exception in the tick propagates without a marker; source() exception = coalesce disabled:error, filter ready", () => {
    const w = setup({ structuresRefreshCoalesce: true });
    const real = w.st.exports.tickStructures;
    w.st.exports.tickStructures = () => { throw new Error("tick boom"); };
    assert.throws(() => w.call(), /tick boom/);
    w.st.exports.tickStructures = real;
    w.call();
    assert.strictEqual(w.st.ticks, 1, "the next call ticks again");
    const e = setup({ structuresRefreshCoalesce: true });
    e.f.setFreshnessSource(() => { throw new Error("src boom"); });
    e.call(); e.call();
    assert.strictEqual(e.st.ticks, 2);
    assert.deepStrictEqual([e.f.status().coalesce, e.f.status().state], ["disabled:error", "ready"]);
    assert.strictEqual(e.lines.filter((l) => l.startsWith("WARN structuresSystemFilter coalesce disabled: error (src boom")).length, 1);
  });

  test("S5 facts: peekStructuresForSystem, refresh in listStructures, placement without options, cap freshMs = cap throttle", () => {
    const text = src("services/structure/structureState.js").replace(/\r\n/g, "\n");
    assert.ok(text.includes("function peekStructuresForSystem("));
    assert.ok(text.includes("function listStructures(options = {}) {\n  if (options.refresh !== false) {\n    tickStructures(Date.now());"));
    const placement = src("services/structure/structureDeploymentPlacement.js").replace(/\r\n/g, "\n");
    assert.ok(placement.includes("getStructureState().listStructuresForSystem(systemID)"));
    const cfgMod = require("../config");
    const warns = [];
    const c = cfgMod.loadConfig({ env: { HOTPATH_STRUCTURES_REFRESH_COALESCE: "1", HOTPATH_STRUCTURES_REFRESH_FRESH_MS: "30000" },
      settingsPath: "<none>", warn: (m) => warns.push(m) });
    assert.deepStrictEqual([c.structuresRefreshCoalesce, c.structuresRefreshFreshMs], [true, cfgMod.TICK_STRUCTURES_MAX_INTERVAL_MS]);
    assert.ok(warns.some((m) => m.startsWith("WARN structuresRefreshFreshMs=30000 capped to")), warns.join("|"));
  });
}

module.exports = { register };
