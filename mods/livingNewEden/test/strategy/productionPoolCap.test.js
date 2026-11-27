"use strict";

const assert = require("node:assert");
const path = require("node:path");
const { planProduction, poolCappedDeficit, templateNeedOf } = require("../../lib/strategy/ai/production");
const { createReviewService } = require("../../lib/strategy/reviewService");
const { NOTE_DICTIONARY } = require("../../lib/strategy/activity/notes");
const RECIPES = require("../../lib/economy/data/hullRecipes");
const { HULL_GROUPS } = require("../../lib/fleets/schema");
const config = require("../../config");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const AT = 1760000000000;
const SYS = 30001721;
const recipes = Object.fromEntries(Object.entries(RECIPES.GROUPS).map(([g, r]) => [g, { minerals: r.minerals }]));
const times = (g, n) => Object.fromEntries(Object.entries(RECIPES.GROUPS[g].minerals).map(([k, v]) => [k, v * n]));

const paramsOf = (extra = {}) => ({ production: { maxJobsPerReview: 8, maxRunsPerJob: 2, maxActiveJobsPerFaction: 24,
  targetStockFleets: 3, mobilizeHulls: "required", miningNeedsHulls: false, mobilizationStations: 2,
  hullGroups: [...HULL_GROUPS], poolCapEnabled: false, poolCapStations: 3, ...extra } });
const ON = { poolCapEnabled: true };

const st = (stationId, o = {}) => ({ stationId, systemId: SYS, kind: "npc", lines: o.lines === undefined ? 4 : o.lines,
  activeJobs: o.activeJobs || [], minerals: o.minerals || {}, hulls: o.hulls || {} });

function snapshotOf(stations) {
  return { v: 1, factionId: 500001, round: 7, at: AT, seed: 1,
    faction: { status: "ACTIVE", homeSystemId: SYS, doctrineId: "d", resourceUnits: 0, reserveUnits: 0, version: 1 },
    doctrine: { doctrineId: "d", templates: { invasion: [{ hullGroup: "frigate", count: 4 }] } },
    stationsMode: "ready", stations: stations.map((s) => ({ systemId: SYS, stationId: s.stationId })), systems: [],
    neighbors: () => [],
    production: { mode: "ready", recipesVersion: 1, recipes, inProduction: {},
      activeJobsTotal: stations.reduce((n, s) => n + s.activeJobs.length, 0), truncated: false, stations } };
}

function paramsFor(env) {
  const resolved = config.resolveConfig({ modDir: MOD_DIR, env });
  assert.deepStrictEqual(resolved.errors || [], []);
  const svc = createReviewService({ store: {}, journal: {}, strategyRepository: { limits: { maxResourceUnits: 1 } },
    intelRepository: {}, registry: {}, kinds: { list: [], get: () => null }, powerTable: {}, scoring: {},
    scheduler: {}, fleets: {}, clock: { now: () => 0 }, worldSeed: 1, config: resolved.config,
    hostility: () => true, isCampaignOk: () => true, industryCatalog: {} });
  return { p: svc.params.production, params: svc.params, warnings: resolved.warnings };
}

const produced = (plan) => plan.intents.map((i) => [i.stationId, i.hullGroup, i.runs]);

const relParamsOf = (extra = {}, top = {}) => ({ ...paramsOf({ poolCapEnabled: true, poolCapStations: 2, ...extra }),
  maxAssemblyJumps: 1, maxBfsSystems: 100, ...top });
const REL = { poolCapReleaseEnabled: true };
const relSnapshotOf = (stations, o = {}) => {
  const snap = snapshotOf(stations);
  snap.doctrine = { doctrineId: "d", templates: { invasion: [{ hullGroup: "frigate", count: 5 }] } };
  if (o.neighbors) snap.neighbors = o.neighbors;
  if (o.home !== undefined) snap.faction.homeSystemId = o.home;
  return snap;
};
const stAt = (stationId, systemId, o = {}) => ({ ...st(stationId, o), systemId });
const split = (patch = {}) => Array.from({ length: 10 }, (_, i) => st(`S${i}`, { hulls: { frigate: 4 },
  ...(i === 0 ? { minerals: times("frigate", 10) } : {}), ...(patch[i] || {}) }));

module.exports = ({ test }) => {
  test("PC1 off pins PRODUCE on the full station A; on: no PRODUCE frigate + PRODUCTION_POOL_CAP:frigate", () => {
    const stations = () => [st("A", { hulls: { frigate: 100 }, minerals: times("frigate", 10) }), st("B")];
    const off = planProduction(snapshotOf(stations()), null, paramsOf());
    assert.deepStrictEqual(produced(off), [["A", "frigate", 2]], JSON.stringify(off));
    assert.ok(!off.notes.some((n) => n.startsWith("PRODUCTION_POOL_CAP")), JSON.stringify(off.notes));
    const { poolCapEnabled, poolCapStations, ...legacy } = paramsOf().production;
    assert.deepStrictEqual(planProduction(snapshotOf(stations()), null, { production: legacy }), off);
    const on = planProduction(snapshotOf(stations()), null, paramsOf(ON));
    assert.deepStrictEqual(on, { intents: [], notes: ["PRODUCTION_POOL_CAP:frigate"] });
    assert.strictEqual(NOTE_DICTIONARY.PRODUCTION_POOL_CAP.category, "oczekiwane");
  });

  test("PC2 pool 30 under the ceiling 36 -> runs = min(deficit, 6, maxRunsPerJob)", () => {
    const stations = () => [st("A", { hulls: { frigate: 12 }, minerals: times("frigate", 20) }), st("B"),
      st("D", { lines: 0, hulls: { frigate: 18 } })];
    assert.deepStrictEqual(produced(planProduction(snapshotOf(stations()), null, paramsOf({ maxRunsPerJob: 10 }))),
      [["A", "frigate", 10]]);
    const on = planProduction(snapshotOf(stations()), null, paramsOf({ ...ON, maxRunsPerJob: 10 }));
    assert.deepStrictEqual(produced(on), [["A", "frigate", 6]], JSON.stringify(on));
    assert.deepStrictEqual(on.notes, []);
    assert.deepStrictEqual(produced(planProduction(snapshotOf(stations()), null, paramsOf({ ...ON, maxRunsPerJob: 4 }))),
      [["A", "frigate", 4]]);
  });

  test("PC3 an ACTIVE job outside chosen and hulls on a station without lines count in the pool", () => {
    const P = paramsOf(ON).production;
    assert.deepStrictEqual(poolCappedDeficit({ frigate: 12 }, { frigate: 12 }, [{ lines: 0, hulls: { frigate: 20 } },
      { activeJobs: [{ hullGroup: "frigate", runs: 10 }] }], P),
    { deficit: { frigate: 6 }, capped: [], released: [], reach: null });
    const same = { frigate: 5 };
    assert.strictEqual(poolCappedDeficit(same, { frigate: 12 }, [], paramsOf().production).deficit, same);
    const stations = () => [st("A", { hulls: { frigate: 12 }, minerals: times("frigate", 10) }),
      st("B", { hulls: { frigate: 11 }, minerals: times("frigate", 1) }),
      st("C", { lines: 1, activeJobs: [{ hullGroup: "frigate", runs: 10 }] }),
      st("D", { lines: 0, hulls: { frigate: 8 } })];
    const off = planProduction(snapshotOf(stations()), null, paramsOf());
    assert.deepStrictEqual(produced(off), [["A", "frigate", 1]], JSON.stringify(off));
    const on = planProduction(snapshotOf(stations()), null, paramsOf(ON));
    assert.deepStrictEqual(on, { intents: [], notes: ["PRODUCTION_POOL_CAP:frigate"] });
  });

  test("PC4 params.production of the real review service carries poolCapEnabled / poolCapStations", () => {
    const def = paramsFor({});
    assert.deepStrictEqual([def.p.poolCapEnabled, def.p.poolCapStations], [false, 3]);
    const on = paramsFor({ EVEJS_LNE_PRODUCTION_POOL_CAP_ENABLED: "1", EVEJS_LNE_PRODUCTION_POOL_CAP_STATIONS: "1" });
    assert.deepStrictEqual([on.p.poolCapEnabled, on.p.poolCapStations], [true, 1]);
    const warn = (w) => w.filter((x) => x.startsWith("production.poolCapStations"));
    assert.deepStrictEqual([warn(def.warnings).length, warn(on.warnings).length], [0, 1]);
  });

  test("PC5 split pool (10 x 4 >= 30): release off -> POOL_CAP; on -> PRODUCE frigate; templateNeedOf", () => {
    const off = planProduction(relSnapshotOf(split()), null, relParamsOf());
    assert.deepStrictEqual(off, { intents: [], notes: ["PRODUCTION_POOL_CAP:frigate"] });
    const on = planProduction(relSnapshotOf(split()), null, relParamsOf(REL));
    assert.deepStrictEqual(produced(on), [["S0", "frigate", 2]], JSON.stringify(on));
    assert.ok(!on.notes.some((n) => n.startsWith("PRODUCTION_POOL_CAP")), JSON.stringify(on.notes));
    const P = relParamsOf(REL).production;
    assert.deepStrictEqual(templateNeedOf(relSnapshotOf([]).doctrine, P), { frigate: 5 });
    assert.deepStrictEqual(templateNeedOf({ templates: { a: [{ hullGroup: "frigate", count: 3 }],
      b: [{ hullGroup: "frigate", count: 2 }, { hullGroup: "frigate", count: 4 }] } }, P), { frigate: 6 });
    assert.deepStrictEqual(templateNeedOf({ hullsRequired: false, templates: { a: [{ hullGroup: "frigate",
      count: 3 }] } }, P), {});
  });

  test("PC6 one station holds a whole template (5) -> release on = release off", () => {
    const stations = () => split({ 5: { hulls: { frigate: 5 } } });
    const off = planProduction(relSnapshotOf(stations()), null, relParamsOf());
    assert.deepStrictEqual(off, { intents: [], notes: ["PRODUCTION_POOL_CAP:frigate"] });
    assert.deepStrictEqual(planProduction(relSnapshotOf(stations()), null, relParamsOf(REL)), off);
  });

  test("PC7 3 frigates + an ACTIVE frigate job runs 2 hold the ceiling", () => {
    const stations = () => split({ 3: { hulls: { frigate: 3 }, activeJobs: [{ hullGroup: "frigate", runs: 2 }] } });
    assert.deepStrictEqual(planProduction(relSnapshotOf(stations()), null, relParamsOf(REL)),
      { intents: [], notes: ["PRODUCTION_POOL_CAP:frigate"] });
  });

  test("PC8 reach: far pool does not block, PRODUCE only in reach; no site in reach -> PRODUCTION_NO_SITE", () => {
    const neighbors = (id) => [id - 1, id + 1].filter((n) => n >= 1 && n <= 6);
    const top = { mobilizeFallbackJumps: 2, mobilizeFallbackMaxSystems: 100 };
    const near = () => [stAt("FAR", 6, { hulls: { frigate: 100 }, minerals: times("frigate", 10) }),
      stAt("NEAR", 1, { minerals: times("frigate", 10) })];
    const capOnly = planProduction(relSnapshotOf(near(), { neighbors, home: 1 }), null, relParamsOf({}, top));
    assert.deepStrictEqual(capOnly, { intents: [], notes: ["PRODUCTION_POOL_CAP:frigate"] });
    const on = planProduction(relSnapshotOf(near(), { neighbors, home: 1 }), null, relParamsOf(REL, top));
    assert.deepStrictEqual(produced(on), [["NEAR", "frigate", 2]], JSON.stringify(on));
    assert.ok(!on.notes.some((n) => n.startsWith("PRODUCTION_POOL_CAP")), JSON.stringify(on.notes));
    const none = () => [stAt("FAR", 6, { hulls: { frigate: 100 }, minerals: times("frigate", 10) }),
      stAt("FAR2", 5, { minerals: times("frigate", 10) }), stAt("NEAR", 1, { lines: 0 })];
    const noSite = planProduction(relSnapshotOf(none(), { neighbors, home: 1 }), null, relParamsOf(REL, top));
    assert.deepStrictEqual(noSite, { intents: [], notes: ["PRODUCTION_NO_SITE:frigate"] });
  });

  test("PC10: released group with a station with lines in reach -> the notes of an unreleased "
    + "group (LINES_BUSY / MINERALS_SPENT), never NO_SITE", () => {
    const neighbors = (id) => [id - 1, id + 1].filter((n) => n >= 1 && n <= 6);
    const top = { mobilizeFallbackJumps: 2, mobilizeFallbackMaxSystems: 100 };
    const plan = (list, extra = {}) => planProduction(relSnapshotOf(list, { neighbors, home: 1 }), null,
      relParamsOf({ ...REL, ...extra }, top));
    const busy = [{ hullGroup: "frigate", runs: 1 }];
    const linesBusy = plan([stAt("FAR", 6, { hulls: { frigate: 100 }, minerals: times("frigate", 10) }),
      stAt("FAR2", 5, { minerals: times("frigate", 10) }),
      stAt("NEAR", 1, { lines: 1, activeJobs: busy, minerals: times("frigate", 10) })]);
    assert.deepStrictEqual(linesBusy, { intents: [], notes: ["PRODUCTION_LINES_BUSY:frigate"] });
    const spent = plan([stAt("FAR", 6, { hulls: { frigate: 100 }, minerals: times("frigate", 10) }),
      stAt("FAR2", 5, { minerals: times("frigate", 10) }), stAt("NEAR", 1)]);
    assert.deepStrictEqual(spent, { intents: [], notes: ["PRODUCTION_MINERALS_SPENT:frigate"] });
    const offList = () => [stAt("FAR", 6, { hulls: { frigate: 100 }, minerals: times("frigate", 10) }),
      stAt("NEAR", 1, { lines: 1, activeJobs: busy, minerals: times("frigate", 10) })];
    assert.deepStrictEqual(planProduction(relSnapshotOf(offList(), { neighbors, home: 1 }), null,
      relParamsOf({ poolCapReleaseEnabled: false }, top)), { intents: [], notes: ["PRODUCTION_POOL_CAP:frigate"] });
    assert.deepStrictEqual(planProduction(relSnapshotOf(offList(), { neighbors, home: 1 }), null,
      relParamsOf({ poolCapEnabled: false }, top)), planProduction(relSnapshotOf(offList(), { neighbors, home: 1 }),
      null, { ...relParamsOf({}, top), production: { ...relParamsOf({}, top).production, poolCapEnabled: false,
        poolCapReleaseEnabled: true } }));
  });

  test("PC9 the real review service carries poolCapReleaseEnabled; release without poolCap -> warning", () => {
    const warn = (w) => w.filter((x) => x.startsWith("production.poolCapReleaseEnabled"));
    const def = paramsFor({});
    assert.strictEqual(def.p.poolCapReleaseEnabled, false);
    assert.strictEqual(warn(def.warnings).length, 0);
    assert.ok(Number.isSafeInteger(def.params.mobilizeFallbackJumps), "mobilizeFallbackJumps in params");
    const alone = paramsFor({ EVEJS_LNE_PRODUCTION_POOL_CAP_RELEASE_ENABLED: "1" });
    assert.strictEqual(alone.p.poolCapReleaseEnabled, true);
    assert.deepStrictEqual(warn(alone.warnings),
      ["production.poolCapReleaseEnabled without production.poolCapEnabled - no effect"]);
    const both = paramsFor({ EVEJS_LNE_PRODUCTION_POOL_CAP_RELEASE_ENABLED: "1",
      EVEJS_LNE_PRODUCTION_POOL_CAP_ENABLED: "1" });
    assert.deepStrictEqual([both.p.poolCapEnabled, both.p.poolCapReleaseEnabled, warn(both.warnings).length],
      [true, true, 0]);
  });
};
