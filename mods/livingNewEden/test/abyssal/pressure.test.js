"use strict";

const assert = require("node:assert");
const path = require("node:path");

const { abyssalPressure, topOf, createPressureMemo } = require("../../lib/abyssal/pressure");
const { startAbyssal, createUnavailableAbyssal } = require("../../lib/abyssal");
const { buildAbyssalRunsView } = require("../../lib/abyssal/view");
const { createViewRegistry } = require("../../lib/observer/views");
const { resolveConfig } = require("../../config");
const SH = require("../notices/storeHelper");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const T0 = 1700000000000;
const HOUR = 3600000;
const R1 = 10000001;
const R2 = 10000002;
const REGION_OF = new Map([[30000001, R1], [30000002, R1], [30000003, R2]]);
const regionOf = (id) => REGION_OF.get(id) || null;
const CFG = { exitedMilli: 1000, failedMilli: 500, lostMilli: 250, halfLifeMs: 24 * HOUR };
const run = (sourceSystemId, state, finishedAtMs) => ({ sourceSystemId, state, finishedAtMs });

const PRESSURE_CONFIG = resolveConfig({ env: { EVEJS_LNE_ABYSSAL_ENABLED: "1", EVEJS_LNE_ABYSSAL_PRESSURE_ENABLED: "1" },
  modDir: MOD_DIR });

module.exports = ({ test, skip }) => {
  test("AP1 abyssalPressure: sum per region, half after halfLifeMs, state weights, skipped runs", () => {
    const two = [run(30000001, "EXITED", T0), run(30000002, "EXITED", T0)];
    assert.deepStrictEqual([...abyssalPressure(two, T0, CFG, regionOf)], [[R1, 2000]]);
    assert.deepStrictEqual([...abyssalPressure(two, T0 + CFG.halfLifeMs, CFG, regionOf)], [[R1, 1000]]);
    const mixed = [run(30000003, "FAILED", T0), run(30000003, "LOST", T0), run(0, "EXITED", T0),
      run(30009999, "EXITED", T0), run(30000001, "ACTIVE", T0), run(30000001, "COMPLETED", T0),
      run(30000001, "EXITED", null), run(30000002, "EXITED", T0 + HOUR)];
    assert.deepStrictEqual([...abyssalPressure(mixed, T0, CFG, regionOf)].sort((a, b) => a[0] - b[0]),
      [[R1, 1000], [R2, 750]]);
    assert.deepStrictEqual(topOf(new Map([[R2, 5], [R1, 5], [10000003, 9], [10000004, 0]]), 2),
      [{ regionId: 10000003, milli: 9 }, { regionId: R1, milli: 5 }]);
    assert.strictEqual(topOf(new Map([[R1, 1]]), 99).length, 1);
  });

  test("AP2 memo reads memory only, refresh via the repository; facade keys = stub keys; panel section", () => {
    const settings = PRESSURE_CONFIG.config.abyssal;
    assert.deepStrictEqual(PRESSURE_CONFIG.errors || [], []);
    const asked = [];
    let rows = [run(30000001, "EXITED", T0), run(30000003, "FAILED", T0), run(30000002, "LOST", T0)];
    const memo = createPressureMemo({ settings, now: () => T0, getRegionOf: () => regionOf,
      listFinished: (q) => { asked.push(q); return rows ? { ok: true, runs: rows } : { ok: false, reason: "STORE_CLOSED" }; } });
    assert.deepStrictEqual(memo.pressureOf(R1), { ok: true, milli: 0, atMs: null });
    assert.deepStrictEqual(memo.topRegions(5), { ok: true, regions: [], atMs: null });
    assert.deepStrictEqual(memo.refresh(T0), { ok: true });
    assert.deepStrictEqual(asked, [{ sinceMs: T0 - settings.pressureWindowMs, newest: true,
      limit: Math.min(settings.pressureMaxRuns, settings.maxRows) }]);
    for (let i = 0; i < 5; i += 1) {
      assert.deepStrictEqual(memo.pressureOf(R1), { ok: true, milli: 1250, atMs: T0 });
      assert.deepStrictEqual(memo.topRegions(5), { ok: true, atMs: T0,
        regions: [{ regionId: R1, milli: 1250 }, { regionId: R2, milli: 500 }] });
    }
    assert.strictEqual(asked.length, 1, "pressureOf / topRegions never read the repository");
    rows = null;
    assert.deepStrictEqual(memo.refresh(T0 + HOUR), { ok: false, reason: "STORE_CLOSED" });
    assert.strictEqual(memo.pressureOf(R1).milli, 1250, "a failed refresh keeps the memo");
    assert.strictEqual(memo.getStatus().failures, 1);

    const graph = { getGraph: () => ({ ok: true, graph: { getSystem: () => null,
      getRegionName: (id) => (id === R1 ? "Derelik" : null) } }) };
    const repository = { listActive: () => ({ ok: true, runs: [] }), listFinished: () => ({ ok: true, runs: [] }) };
    const view = buildAbyssalRunsView({ repository, viewLimit: 5, now: () => T0, graph, getPressure: () => memo });
    assert.deepStrictEqual(view.getData().pressure, { atMs: T0,
      regions: [{ regionId: R1, region: "Derelik", milli: 1250 }, { regionId: R2, region: null, milli: 500 }] });
    assert.ok(!("pressure" in buildAbyssalRunsView({ repository, viewLimit: 5, now: () => T0 }).getData()));

    const stubKeys = Object.keys(createUnavailableAbyssal("x")).sort();
    assert.deepStrictEqual(createUnavailableAbyssal("x").pressureOf(R1), { ok: false, reason: "ABYSSAL_UNAVAILABLE" });
    const driver = SH.loadDriver();
    if (!driver.ok) return skip("AP2 facade keys", `better-sqlite3 unavailable (${driver.detail})`);
    return SH.withStore(driver, ({ store }) => {
      const timers = [];
      const setTimer = (fn, ms) => { const t = { fn, ms, on: true }; timers.push(t); return { cancel: () => { t.on = false; }, hasRef: () => false }; };
      const seam = { isAbyssalHost: () => false, readActiveRun: () => ({ ok: true, run: null }),
        installCompletionHook: () => ({ ok: false, reason: "SEAM_MISSING" }), projectRun: () => null,
        stats: () => ({ hostDegraded: false }) };
      const started = startAbyssal({ config: PRESSURE_CONFIG.config,
        ctx: { persistence: { store }, presence: null, views: createViewRegistry(), graph: null, governor: null },
        adapter: { abyssalSeams: () => ({ ok: true, seam }) }, clock: { now: () => T0 }, telemetry: null,
        logger: { log() {} }, setTimer });
      assert.ok(started.ok, JSON.stringify(started));
      const facade = started.abyssal;
      assert.deepStrictEqual(Object.keys(facade).sort(), stubKeys);
      assert.deepStrictEqual(facade.pressureOf(R1), { ok: true, milli: 0, atMs: null });
      assert.ok(timers.some((t) => t.on && t.ms === 0), "the first refresh is armed at once");
      facade.stop();
      assert.deepStrictEqual(facade.topRegions(5), { ok: false, reason: "ABYSSAL_UNAVAILABLE" });
    });
  });
};
