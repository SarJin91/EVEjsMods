"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { resolveConfig } = require("../../config");
const { buildTerritoryAreas } = require("../../lib/world/territoryAreas");
const { createViewRegistry } = require("../../lib/observer/views");
const { findServerSrcOnDisk, GAMESTORE_SEARCH_MAX_DEPTH } = require("../../lib/adapter/locator");
const { resolveSqliteDriver } = require("../../lib/adapter/sqliteDriver");
const { MIGRATIONS } = require("../../lib/persistence/migrations");
const { openStore } = require("../../lib/persistence/store");
const { seedDbFile } = require("../_support/dbTemplate");
const { createJournal } = require("../../lib/persistence/journal");
const { createManualClock } = require("../../lib/util/clock");
const { startWorld } = require("../../lib/world");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const DEFAULTS = resolveConfig({ modDir: MOD_DIR, env: {} }).config;
const START_MS = 1760000000000;
const A = 500001;
const B = 500002;
const OPTS = Object.freeze({ cellSize: 10, radius: 40, maxCells: 1000000, maxPoints: 100000, maxCoarsenSteps: 0,
  simplifyPercent: 50 });

const FIXTURE = [
  [1, 105, 105, A], [2, 135, 105, A], [3, 115, 135, A],
  [4, 805, 505, A], [5, 835, 505, A],
  [6, 195, 105, B], [7, 225, 115, B],
  [8, 165, 105, null],
  [9, 505, 905, B],
];

function columns(rows) {
  return { id: rows.map((r) => r[0]), x: rows.map((r) => r[1]), y: rows.map((r) => r[2]) };
}

function build(rows, opts) {
  return buildTerritoryAreas({ systems: columns(rows), grid: { width: 1000, height: 1000 },
    ownerOf: (i) => ({ factionId: rows[i][3], source: "world" }), opts: { ...OPTS, ...opts } });
}

function insideArea(rings, x, y) {
  let inside = false;
  for (const r of rings) {
    const n = r.length / 2;
    for (let i = 0, j = n - 1; i < n; j = i, i += 1) {
      const xi = r[2 * i];
      const yi = r[2 * i + 1];
      const xj = r[2 * j];
      const yj = r[2 * j + 1];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

function loadDriver() {
  const found = findServerSrcOnDisk(MOD_DIR, GAMESTORE_SEARCH_MAX_DEPTH, fs.existsSync);
  if (!found.ok) return { ok: false, detail: found.reason };
  return resolveSqliteDriver(found.srcDir);
}

module.exports = ({ test, skip }) => {
  test("TA1 territory geometry: clusters -> areas, isolated blob, no foreign system covered, deterministic", () => {
    const r = build(FIXTURE);
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    const of = (f) => r.areas.filter((a) => a.factionId === f);
    assert.deepStrictEqual(of(A).map((a) => a.systems), [[1, 2, 3], [4, 5]]);
    assert.deepStrictEqual(of(B).map((a) => a.systems), [[6, 7], [9]]);
    assert.ok(r.areas.every((a) => a.source === "world"));
    const lonely = of(B)[1];
    assert.ok(lonely.rings.length >= 1 && lonely.rings[0].length >= 8, "isolated system -> a ring of >= 4 points");
    assert.deepStrictEqual([r.stats.unplaced, r.stats.areas, r.stats.coarsenSteps], [0, 4, 0]);
    for (const area of r.areas) {
      for (const [id, x, y, f] of FIXTURE) {
        const own = area.systems.includes(id);
        assert.strictEqual(insideArea(area.rings, x, y), own,
          `system ${id} (faction ${f}) ${own ? "outside its" : "inside a foreign"} area ${area.factionId}`);
      }
    }
    assert.deepStrictEqual(build(FIXTURE), r, "same input, same output");
  });

  test("TA2 territory budget: corner touch = 2 areas, coarsening under maxPoints, TOO_MANY_POINTS", () => {
    const corner = [[1, 25, 25, A], [2, 35, 35, A], [3, 35, 25, null], [4, 25, 35, null]];
    const c = build(corner, { radius: 10, simplifyPercent: 0 });
    assert.strictEqual(c.ok, true, JSON.stringify(c));
    assert.deepStrictEqual(c.areas.map((a) => a.systems), [[1], [2]]);
    assert.ok(c.areas.every((a) => a.rings.length === 1));

    const full = build(FIXTURE);
    const coarse = build(FIXTURE, { maxPoints: full.stats.points - 1, maxCoarsenSteps: 3 });
    assert.strictEqual(coarse.ok, true, JSON.stringify(coarse));
    assert.ok(coarse.stats.coarsenSteps > 0 && coarse.cellSize > OPTS.cellSize);
    assert.ok(coarse.stats.points <= full.stats.points - 1);
    const refused = build(FIXTURE, { maxPoints: 3, maxCoarsenSteps: 0 });
    assert.deepStrictEqual([refused.ok, refused.reason], [false, "TOO_MANY_POINTS"]);
    assert.strictEqual(buildTerritoryAreas({ systems: columns([]), grid: { width: 1, height: 1 },
      ownerOf: () => null, opts: OPTS }).reason, "NO_SYSTEMS");
  });

  test("TA5 territory work budget: radius 10000 bounded by stampOps/maxCells, defaults unchanged", () => {
    const n = 5500;
    const rows = [];
    for (let i = 0; i < n; i += 1) rows.push([i + 1, (i * 7919) % 10000, (i * 104729) % 9973, i % 2 === 0 ? A : B]);
    const o = DEFAULTS.observer;
    const def = { cellSize: o.galaxyTerritoryCellSize, radius: o.galaxyTerritoryRadius,
      maxCells: o.galaxyTerritoryMaxCells, maxStampOps: o.galaxyTerritoryMaxStampOps,
      maxPoints: o.galaxyTerritoryMaxPoints, maxCoarsenSteps: o.galaxyTerritoryMaxCoarsenSteps,
      simplifyPercent: o.galaxyTerritorySimplifyPercent };
    const run = (opts) => buildTerritoryAreas({ systems: columns(rows), grid: { width: 10000, height: 10000 },
      ownerOf: (i) => ({ factionId: rows[i][1] < 5000 ? A : B, source: "world" }), opts });

    const base = run(def);
    assert.strictEqual(base.ok, true, JSON.stringify(base.detail));
    assert.strictEqual(base.stats.workSteps, 0, "defaults: the work budget never doubles the cell");
    assert.strictEqual(base.cellSize, Math.max(def.cellSize, Math.ceil(Math.sqrt(1e8 / def.maxCells))),
      "defaults: the cell of the base formula");
    const { maxStampOps: _drop, ...noBudget } = def;
    assert.deepStrictEqual(run({ ...noBudget, maxCells: Number.MAX_SAFE_INTEGER, cellSize: base.cellSize }), base,
      "defaults: the same areas as without any work budget");

    const big = run({ ...def, radius: 10000 });
    assert.strictEqual(big.ok, true, JSON.stringify(big.detail));
    assert.ok(big.stats.stampOps <= def.maxStampOps, `stampOps ${big.stats.stampOps} <= ${def.maxStampOps}`);
    assert.ok(big.stats.cells <= def.maxCells, `cells ${big.stats.cells} <= ${def.maxCells}`);
    assert.ok(big.stats.workSteps > 0 && big.cellSize > base.cellSize, "the cell doubled for the work budget");
    assert.ok(big.stats.stampOps > 0 && base.stats.stampOps > 0);

    const refused = run({ ...def, radius: 10000, maxStampOps: n - 1 });
    assert.deepStrictEqual([refused.ok, refused.reason], [false, "TOO_MUCH_WORK"]);
  });

  const driver = loadDriver();
  const ta3 = "TA3 layer-territory view: manifest entry, cacheKey, memo on influence-only change, governor, off";
  if (!driver.ok) skip(ta3, `better-sqlite3 unavailable (${driver.detail})`);
  else {
    test(ta3, () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lne-ter-"));
      seedDbFile(driver, path.join(tmp, "world.sqlite"), { seed: 1 });
      const opened = openStore({ filePath: path.join(tmp, "world.sqlite"), openDatabase: (f) => new driver.Database(f),
        exclusiveLock: true, busyTimeoutMs: 0, maxRowsPerTransaction: 500, maxWriteMsPerPass: 5,
        randomSeed: () => 1, migrations: MIGRATIONS });
      assert.ok(opened.ok, JSON.stringify(opened));
      const store = opened.store;
      const ids = [30000001, 30000002, 30000003];
      const staticData = { available: true, grid: { width: 1000, height: 1000 },
        systems: { id: ids, x: [105, 135, 805], y: [105, 105, 505] } };
      const graph = { getGraph: () => ({ ok: true, graph: { getSystem: () => ({ factionId: 500003 }) } }) };
      let admit = true;
      const counts = {};
      const telemetry = { observe() {}, count: (n) => { counts[n] = (counts[n] || 0) + 1; } };
      const boot = (views, observer) => {
        views.registerView("galaxy-static", { title: "S", listed: false, getData: () => staticData,
          cacheKey: () => "g1" });
        const config = { enabled: true, modules: { world: { enabled: true } },
          world: { ...DEFAULTS.world, seedEnabled: false },
          observer: { ...DEFAULTS.observer, galaxyTerritoryCellSize: 10, galaxyTerritoryRadius: 40, ...observer } };
        return startWorld({ config, persistence: { ok: true, store, journal }, clock, views, graph, telemetry,
          getGovernor: () => ({ admits: () => admit }), logger: { log() {} } }).world;
      };
      const clock = createManualClock(START_MS);
      const journal = createJournal({ clock, maxPayloadBytes: 4096, maxRows: 500 });
      try {
        const views = createViewRegistry();
        const world = boot(views, {});
        assert.deepStrictEqual(views.listMapLayers().map((l) => [l.id, l.kind, l.order]),
          [["layer-territory", "areas", 5]]);
        const view = views.getView("layer-territory");
        const put = (systemId, version, controllerFactionId, score, key) => {
          const r = world.applyChange({ systemId, expectedVersion: version, reason: "TEST",
            state: version === 0 ? { securityClass: "nullsec", controllerFactionId } : { controllerFactionId },
            influence: [{ factionId: A, influenceScore: score }] }, key);
          assert.strictEqual(r.ok, true, JSON.stringify(r));
        };
        put(ids[0], 0, A, 10, "ter:1");
        put(ids[1], 0, A, 10, "ter:2");
        const k1 = view.cacheKey();
        assert.strictEqual(view.cacheKey(), k1, "stable without a change");
        const d1 = view.getData();
        assert.strictEqual(d1.available, true, JSON.stringify(d1));
        assert.deepStrictEqual(d1.areas.map((a) => [a[0], a[1], a[2]]), [[A, 0, [ids[0], ids[1]]]],
          "no row -> no area without the projection");
        assert.strictEqual(d1.key, k1);
        put(ids[0], 1, A, 55, "ter:3");
        const k2 = view.cacheKey();
        assert.notStrictEqual(k2, k1, "a world change -> new key");
        const d2 = view.getData();
        assert.strictEqual(counts["observer.galaxyTerritoryMemoHits"], 1, "same controllers -> memo");
        assert.deepStrictEqual(d2.areas, d1.areas);
        admit = false;
        assert.strictEqual(view.cacheKey(), null, "governor hold -> no key");
        assert.strictEqual(view.getData().reason, "GOVERNOR_HOLD");
        admit = true;
        world.stop("test");
        assert.strictEqual(views.getView("layer-territory"), null, "unregistered on stop");

        const pViews = createViewRegistry();
        const projected = boot(pViews, { galaxyTerritoryProjectEmpireSpace: true });
        const d3 = pViews.getView("layer-territory").getData();
        assert.deepStrictEqual(d3.areas.map((a) => [a[0], a[1], a[2]]), [[A, 0, [ids[0], ids[1]]],
          [500003, 1, [ids[2]]]], "no row + projection -> SDE area src 1");
        projected.stop("test");

        const offViews = createViewRegistry();
        const off = boot(offViews, { galaxyTerritoryEnabled: false });
        assert.strictEqual(offViews.getView("layer-territory"), null, "galaxyTerritoryEnabled=false");
        assert.ok(offViews.getView("galaxy-state"));
        off.stop("test");
      } finally {
        store.close("test_cleanup");
        try {
          fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
        } catch (_err) {
        }
      }
    });
  }
};
