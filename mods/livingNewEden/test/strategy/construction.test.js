"use strict";

const assert = require("node:assert");

const { HULL_GROUPS, FLEET_ROLES, OPERATION_TYPES, OBJECTIVES } = require("../../lib/fleets/schema");
const { createHostility } = require("../../lib/battle/data/hostility");
const { REGISTRY_DATA_V1, createFactionRegistry } = require("../../lib/strategy/registry");
const { createOperationKinds } = require("../../lib/strategy/kinds");
const { OPERATION_KINDS_VERSION, OPERATION_KINDS_V1 } = require("../../lib/strategy/data/operationKinds");
const { TARGET_SCORING_V1 } = require("../../lib/strategy/data/targetScoring");
const { evaluateSupplyAndFronts } = require("../../lib/strategy/ai/supply");
const { countCaptureCandidates } = require("../../lib/strategy/ai/targeting");
const { planConstruction } = require("../../lib/strategy/ai/construction");
const { planLogistics } = require("../../lib/strategy/ai/logistics");
const RECIPES = require("../../lib/economy/data/hullRecipes");
const VOLUMES = require("../../lib/economy/data/cargoVolumes");

const SANSHA = 500019;
const AMARR = 500003;
const AT = 1760000000000;
const HOUR = 3600000;
const EDGES = [[1, 2], [2, 3], [3, 4], [4, 5], [3, 10], [10, 11], [1, 7], [7, 8], [8, 9], [1, 20]];
const NB = new Map();
for (const [a, b] of EDGES) {
  NB.set(a, [...(NB.get(a) || []), b]);
  NB.set(b, [...(NB.get(b) || []), a]);
}
const OWN = [1, 2, 3, 7, 8];

const registry = (() => {
  const r = createFactionRegistry(REGISTRY_DATA_V1, { hullGroups: HULL_GROUPS, fleetRoles: FLEET_ROLES,
    operationTypes: OPERATION_TYPES, hostility: createHostility(), maxFactions: 64, maxCampaignSystems: 40,
    maxShipsPerFleet: 500, maxCompositionEntries: 32, maxResourceUnits: 1000000000 });
  assert.ok(r.ok);
  return r.registry;
})();
const kinds = (() => {
  const k = createOperationKinds({ version: OPERATION_KINDS_VERSION, kinds: OPERATION_KINDS_V1 },
    { operationTypes: OPERATION_TYPES, objectives: OBJECTIVES, fleetRoles: FLEET_ROLES });
  assert.ok(k.ok, JSON.stringify(k));
  return k.kinds;
})();

const KIT = Object.freeze({ kitId: "k", items: { "mineral/type:34": 3000, "mineral/type:35": 1000 } });
const CONSTRUCTION = Object.freeze({ maxBuildsPerReview: 1, maxSiteCandidates: 16, minSiteGain: 1,
  requireKitInStock: true, maxOpenBuildsPerFaction: 1, kitId: "k", maxPerSystem: 8, maxPerSystemPerFaction: 3,
  targetsGateMax: 0, overdueMs: 0, minGapMs: 0, maxOpenBuildsTotal: 64, maxLiveStationsTotal: 100000 });
const PROD = Object.freeze({ maxJobsPerReview: 2, maxRunsPerJob: 4, maxActiveJobsPerFaction: 8, targetStockFleets: 1,
  mobilizeHulls: "required", miningNeedsHulls: false, mobilizationStations: 1, hullGroups: [...HULL_GROUPS] });
const LOG = Object.freeze({ maxFleetsPerFaction: 3, maxOpenConvoysPerFaction: 4, maxDispatchesPerReview: 2,
  maxMobilizationsPerReview: 1, carrierCapacityM3: 60000, maxCargoItems: 12, minLoadVolume: 100000,
  factoryRunsTarget: 2, maxConvoyJumps: 20, needsHulls: false, frontStationMaxJumps: 6,
  maxHullConvoysPerReview: 8, mineralSurplusThreshold: 1000, maxMineralConvoysPerReview: 4, mineralConvoyMinLoad: 100,
  volumes: { mineral: VOLUMES.MINERAL_VOLUME, hulls: VOLUMES.HULL_VOLUMES, carrierGroups: VOLUMES.CARRIER_GROUPS,
    unitsPerM3: VOLUMES.VOLUME_UNITS_PER_M3 } });
const PARAMS = Object.freeze({ maxReachJumps: 10, supplyChainJumps: 10, captureRangeFromStationJumps: 2,
  maxAssemblyJumps: 15, maxBfsSystems: 2000, maxTargetCandidates: 40, targetPickTopK: 3, maxOperationsPerReview: 1,
  maxFleetsPerOperation: 4, maxFleetsPerFaction: 12, maxMobilizationsPerReview: 2, mobilizeResourcePerShip: 10,
  mobilizeReservePerShip: 1, attackStrengthRatio: 1.2, intelTtlMs: 6 * HOUR, maxObservationsPerReview: 8,
  reconWindowMs: HOUR / 2, attackWindowMs: 2 * HOUR, operationGraceMs: HOUR, maxHousekeepingPerReview: 4,
  maxRefitRequestsPerReview: 2, kinds: kinds.list, scoring: TARGET_SCORING_V1, powerTable: {}, frontLimitCap: 2,
  routeMaxJumps: 40, construction: CONSTRUCTION, production: PROD, logistics: LOG });
const recipes = Object.fromEntries(Object.entries(RECIPES.GROUPS).map(([g, r]) => [g, { minerals: r.minerals }]));

function snap(factionId, o = {}) {
  const entry = registry.getFaction(factionId);
  const doctrine = registry.getDoctrine(entry.doctrineId);
  const extra = o.targets || [];
  const rows = [...OWN.map((id) => ({ systemId: id, controllerFactionId: factionId })),
    ...(o.target ? [{ systemId: 20, controllerFactionId: null }] : []),
    ...extra.map((id) => ({ systemId: id, controllerFactionId: null }))];
  const neighbors = (id) => {
    if (id === 1) return [...(NB.get(1) || []), ...extra];
    return extra.includes(id) ? [1] : (NB.get(id) || []);
  };
  return {
    v: 1, factionId, round: 7, at: AT, seed: 1,
    faction: { status: "ACTIVE", homeSystemId: 1, doctrineId: doctrine.doctrineId, resourceUnits: 20000,
      reserveUnits: 300, frontLimit: 1, version: 3 },
    entry: { kind: entry.kind, maxActiveFronts: 1, allies: [...entry.allies], homeRegionIds: [],
      ownerCorporationId: entry.ownerCorporationId },
    doctrine: { doctrineId: doctrine.doctrineId, canOccupy: doctrine.canOccupy,
      expandsBeyondTheatre: doctrine.expandsBeyondTheatre === true, operationTypes: [...doctrine.operationTypes],
      reachJumps: doctrine.reachJumps,
      templates: { invasion: [{ hullGroup: "cruiser", count: 2 }],
        logistics: [{ hullGroup: "industrial", count: 2 }] } },
    theatre: [...(o.target ? [20] : []), ...extra], expansion: [], border: undefined,
    neighbors, regionOf: () => null, isHostile: (x) => x !== factionId,
    stationsMode: "ready", stations: [{ systemId: 1, stationId: "st0" }], captureAnchors: [1],
    systems: rows.map((r) => ({ ...r, occupationState: "STABLE", controllerGarrison: 0, hostileStations: 0,
      liveStations: r.systemId === 1 ? 1 : 0, ownLiveStations: r.systemId === 1 ? 1 : 0, observed: false })),
    fleets: o.fleets || [], fleetsTruncated: false, operations: [], operationsTruncated: false, intel: [],
    sightings: [], occupations: [],
    production: { mode: "ready", recipesVersion: 1, recipes, inProduction: {}, activeJobsTotal: 0, truncated: false,
      stations: [{ stationId: "st0", systemId: 1, kind: "npc", lines: 2, activeJobs: [],
        minerals: o.minerals || { "type:34": 5000, "type:35": 1000 }, hulls: {} }] },
    construction: { mode: "ready", kit: KIT, open: o.open || [], truncated: false, targetable: (id) => id >= 4,
      ...(o.sc || {}) },
    logistics: o.logistics || null,
  };
}

const supplyOf = (s) => evaluateSupplyAndFronts(s, PARAMS);

module.exports = ({ test }) => {
  test("A1 planConstruction: no capture target -> BUILD_PLAN on the site with the largest gain; a target in "
    + "reach -> CONSTRUCTION_HAS_TARGETS; deterministic; Amarr does not build; no kit -> CONSTRUCTION_NO_KIT", () => {
    const s = snap(SANSHA);
    const supply = supplyOf(s);
    assert.deepStrictEqual([...supply.captureReach.keys()].sort((a, b) => a - b), [1, 2, 3, 7, 8, 20]);
    assert.strictEqual(countCaptureCandidates(s, supply, PARAMS), 0);
    const d = planConstruction(s, supply, PARAMS);
    assert.deepStrictEqual(d, { intents: [{ type: "BUILD_PLAN", slot: 0, systemId: 3, kitId: "k" }],
      notes: ["CONSTRUCTION_PLAN"] });
    assert.deepStrictEqual(planConstruction(s, supply, PARAMS), d, "deterministic");
    const t = snap(SANSHA, { target: true });
    const ts = supplyOf(t);
    assert.strictEqual(countCaptureCandidates(t, ts, PARAMS), 1);
    assert.deepStrictEqual(planConstruction(t, ts, PARAMS), { intents: [], notes: ["CONSTRUCTION_HAS_TARGETS"] });
    const a = snap(AMARR);
    assert.deepStrictEqual(planConstruction(a, supplyOf(a), PARAMS), { intents: [], notes: [] });
    const poor = snap(SANSHA, { minerals: { "type:34": 5000 } });
    assert.deepStrictEqual(planConstruction(poor, supplyOf(poor), PARAMS).notes, ["CONSTRUCTION_NO_KIT"]);
    const full = snap(SANSHA);
    full.systems = full.systems.map((x) => (x.systemId === 3 ? { ...x, ownLiveStations: 3, liveStations: 3 } : x));
    assert.strictEqual(planConstruction(full, supplyOf(full), PARAMS).intents[0].systemId, 2);
    assert.deepStrictEqual(planConstruction(s, supply, { ...PARAMS, construction: null }).notes, ["CONSTRUCTION_OFF"]);
  });

  const SUB1 = { ...CONSTRUCTION, targetsGateMax: 3, overdueMs: 48 * HOUR, minGapMs: 6 * HOUR, maxOpenBuildsTotal: 8,
    maxLiveStationsTotal: 100 };
  const withC = (c) => ({ ...PARAMS, construction: c });
  const FIVE = [21, 22, 23, 24, 25];
  const PLAN_3 = [{ type: "BUILD_PLAN", slot: 0, systemId: 3, kitId: "k" }];

  test("CB1 planConstruction: > targetsGateMax targets and a fresh build -> CONSTRUCTION_HAS_TARGETS; the last "
    + "build overdue (or none) -> BUILD_PLAN + CONSTRUCTION_PARALLEL; <= targetsGateMax targets -> BUILD_PLAN", () => {
    const p = withC({ ...SUB1, minGapMs: 0 });
    const run = (targets, since, params) => {
      const s = snap(SANSHA, { targets, sc: { openTotal: 0, liveTotal: 10, sinceLastBuildMs: since } });
      return planConstruction(s, supplyOf(s), params || p);
    };
    const five = snap(SANSHA, { targets: FIVE });
    assert.strictEqual(countCaptureCandidates(five, supplyOf(five), PARAMS), 5);
    assert.deepStrictEqual(run(FIVE, HOUR), { intents: [], notes: ["CONSTRUCTION_HAS_TARGETS"] });
    assert.deepStrictEqual(run(FIVE, 49 * HOUR), { intents: PLAN_3,
      notes: ["CONSTRUCTION_PARALLEL", "CONSTRUCTION_PLAN"] });
    assert.deepStrictEqual(run(FIVE, null), { intents: PLAN_3, notes: ["CONSTRUCTION_PARALLEL", "CONSTRUCTION_PLAN"] });
    assert.deepStrictEqual(run([21, 22], 7 * HOUR, withC(SUB1)), { intents: PLAN_3,
      notes: ["CONSTRUCTION_PARALLEL", "CONSTRUCTION_PLAN"] });
    assert.deepStrictEqual(run([21], null, withC({ ...SUB1, targetsGateMax: 0, overdueMs: 0, minGapMs: 0 })),
      { intents: [], notes: ["CONSTRUCTION_HAS_TARGETS"] });
  });

  test("CB2 planConstruction: the last build < minGapMs ago -> CONSTRUCTION_GAP; openTotal / liveTotal at the "
    + "global limit -> CONSTRUCTION_GLOBAL_CAP; the room is cut by maxOpenBuildsTotal - openTotal", () => {
    const run = (sc, c) => {
      const s = snap(SANSHA, { sc });
      return planConstruction(s, supplyOf(s), withC(c || SUB1));
    };
    assert.deepStrictEqual(run({ openTotal: 0, liveTotal: 0, sinceLastBuildMs: HOUR }),
      { intents: [], notes: ["CONSTRUCTION_GAP"] });
    assert.deepStrictEqual(run({ openTotal: 8, liveTotal: 0, sinceLastBuildMs: null }),
      { intents: [], notes: ["CONSTRUCTION_GLOBAL_CAP"] });
    assert.deepStrictEqual(run({ openTotal: 0, liveTotal: 100, sinceLastBuildMs: null }),
      { intents: [], notes: ["CONSTRUCTION_GLOBAL_CAP"] });
    const two = { ...SUB1, maxBuildsPerReview: 2, maxOpenBuildsPerFaction: 2 };
    assert.strictEqual(run({ openTotal: 0, liveTotal: 0, sinceLastBuildMs: null }, two).intents.length, 2);
    const cut = run({ openTotal: 2, liveTotal: 0, sinceLastBuildMs: null }, { ...two, maxOpenBuildsTotal: 3 });
    assert.deepStrictEqual(cut, { intents: PLAN_3, notes: ["CONSTRUCTION_PLAN"] });
  });

  const OUT = { ...SUB1, outpostsEnabled: true, outpostKinds: "empire", outpostEveryMs: 96 * HOUR, outpostMaxOpen: 1,
    outpostMaxStations: 4, outpostMaxCandidates: 16, outpostMinBorderNeighbours: 1 };
  const site = (systemId, borderNeighbours) => ({ systemId, borderNeighbours, liveStations: 0, ownLiveStations: 0 });
  const outpostRun = (factionId, outposts, edit) => {
    const s = snap(factionId, { sc: { openTotal: 0, liveTotal: 10, sinceLastBuildMs: null, outposts } });
    if (edit) edit(s);
    return planConstruction(s, supplyOf(s), withC(OUT));
  };
  const READY_TWO = { mode: "ready", sites: [site(5, 1), site(4, 3)] };

  test("CO1 planConstruction: an empire with outposts ready -> BUILD_PLAN on the site with most border "
    + "neighbours + OUTPOST_PLAN; outposts off -> nothing, no note (the behaviour before)", () => {
    assert.strictEqual(snap(AMARR).doctrine.expandsBeyondTheatre, false);
    assert.deepStrictEqual(outpostRun(AMARR, READY_TWO), {
      intents: [{ type: "BUILD_PLAN", slot: 0, systemId: 4, kitId: "k" }], notes: ["OUTPOST_PLAN"] });
    assert.deepStrictEqual(outpostRun(AMARR, { mode: "off", sites: [] }), { intents: [], notes: [] });
    assert.deepStrictEqual(outpostRun(AMARR, undefined), { intents: [], notes: [] });
  });

  test("CO2 planConstruction: wait -> OUTPOST_WAIT; 4 own upwell -> OUTPOST_CAP; no site -> OUTPOST_NO_SITE "
    + "the shared gap gate; a pirate with outposts ready takes the conquest branch", () => {
    assert.deepStrictEqual(outpostRun(AMARR, { mode: "wait", sites: [] }), { intents: [], notes: ["OUTPOST_WAIT"] });
    const upwell = (s) => {
      s.stations = [1, 2, 3, 7].map((id) => ({ systemId: id, stationId: `u${id}`, kind: "upwell" }));
    };
    assert.deepStrictEqual(outpostRun(AMARR, READY_TWO, upwell), { intents: [], notes: ["OUTPOST_CAP"] });
    assert.deepStrictEqual(outpostRun(AMARR, { mode: "ready", sites: [] }), { intents: [],
      notes: ["OUTPOST_NO_SITE"] });
    const gap = (s) => { s.construction.sinceLastBuildMs = HOUR; };
    assert.deepStrictEqual(outpostRun(AMARR, READY_TWO, gap), { intents: [], notes: ["CONSTRUCTION_GAP"] });
    assert.deepStrictEqual(outpostRun(SANSHA, READY_TWO), { intents: PLAN_3, notes: ["CONSTRUCTION_PLAN"] });
  });

  test("CO3 readOutpostSites: borderNeighbours from the graph (nullsec outside the territory), own station "
    + "systems skipped, one countLiveBySystem; off / wait / conquest doctrine -> no query", () => {
    const { readOutpostSites } = require("../../lib/strategy/reviewService");
    const SEC = { 1: "nullsec", 2: "nullsec", 3: "nullsec", 10: "nullsec", 11: "nullsec", 12: "nullsec",
      13: "nullsec", 14: "nullsec", 15: "highsec" };
    const NBR = { 1: [2, 10, 11], 2: [1, 3, 12], 3: [2, 13, 14, 15] };
    const graph = Object.freeze({ getSystem: (id) => (SEC[id] ? { secClass: SEC[id] } : null),
      getNeighbors: (id) => NBR[id] || [] });
    const calls = [];
    const repository = Object.freeze({ countLiveBySystem: (db, ids) => {
      calls.push(ids);
      return { ok: true, rows: [{ systemId: 3, factionId: AMARR, count: 1 }, { systemId: 3, factionId: 1, count: 1 }] };
    } });
    const input = (o) => ({ C: OUT, factionId: AMARR, entry: { kind: "empire" },
      doctrine: { canOccupy: true, expandsBeyondTheatre: false }, territory: [{ systemId: 1 }, { systemId: 2 },
        { systemId: 3 }], stations: [{ systemId: 1 }], open: [], sinceLastBuildMs: null, graph, repository, ...o });
    const r = readOutpostSites({}, input());
    assert.deepStrictEqual(r, { ok: true, outposts: { mode: "ready", sites: [
      { systemId: 3, borderNeighbours: 2, liveStations: 2, ownLiveStations: 1 },
      { systemId: 2, borderNeighbours: 1, liveStations: 0, ownLiveStations: 0 }] } });
    assert.deepStrictEqual(calls, [[3, 2]]);
    for (const o of [{ C: { ...OUT, outpostsEnabled: false } }, { entry: { kind: "pirate" } },
      { doctrine: { canOccupy: true, expandsBeyondTheatre: true } }]) {
      assert.strictEqual(readOutpostSites({}, input(o)).outposts.mode, "off");
    }
    assert.strictEqual(readOutpostSites({}, input({ sinceLastBuildMs: HOUR })).outposts.mode, "wait");
    assert.strictEqual(calls.length, 1, "off / wait read nothing");
  });

  test("A2 planLogistics 3c: a SUPPLYING site -> CONVOY_DISPATCH CONSTRUCTION to its stationId with the "
    + "missing kit minerals (a small last load passes); an open convoy to the site -> no second one", () => {
    const lf = { fleetId: "lf", version: 4, state: "IDLE", fleetRole: "logistics", systemId: 1, refitPending: false,
      shipCount: 2, strength: 0, operationId: null, legSeq: 0, homeSystemId: 1 };
    const build = { stationId: "st-site", systemId: 3, kitId: "k", state: "SUPPLYING", required: KIT.items,
      delivered: { "mineral/type:34": 0 }, remaining: { "mineral/type:34": 3000, "mineral/type:35": 500 },
      convoysLost: 0, supplyDeadlineAt: AT + 72 * HOUR, anchorUntilAt: null };
    const lg = { mode: "ready", open: [], busyFleetIds: [], carriers: { lf: 2 }, truncated: false };
    const s = snap(SANSHA, { fleets: [lf], open: [build], logistics: lg });
    const run = (x) => planLogistics(x, supplyOf(x), PARAMS, null, null, null).intents
      .filter((i) => i.type === "CONVOY_DISPATCH");
    assert.deepStrictEqual(run(s).map((i) => [i.fleetId, i.expectedVersion, i.purpose, i.sourceStationId,
      i.destStationId, i.items]), [["lf", 4, "CONSTRUCTION", "st0", "st-site", [
      { itemKind: "mineral", itemKey: "type:34", quantity: 3000 },
      { itemKind: "mineral", itemKey: "type:35", quantity: 500 }]]]);
    const busy = { ...lg, busyFleetIds: ["lf"], open: [{ convoyId: "cv1", fleetId: "lf", state: "TO_SOURCE",
      purpose: "CONSTRUCTION", sourceStationId: "st0", destStationId: "st-site", items: {} }] };
    assert.deepStrictEqual(run(snap(SANSHA, { fleets: [lf], open: [build], logistics: busy })), []);
  });
};

module.exports.helpers = { snap, supplyOf, PARAMS, CONSTRUCTION, SANSHA, AMARR, HOUR };
