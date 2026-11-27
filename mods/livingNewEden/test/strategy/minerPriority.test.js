"use strict";

const assert = require("node:assert");
const path = require("node:path");

const { buildUniverseGraph } = require("../../lib/graph/universeGraph");
const { createRouteFinder } = require("../../lib/graph/routes");
const { HULL_GROUPS, FLEET_ROLES, OPERATION_TYPES, OBJECTIVES } = require("../../lib/fleets/schema");
const { createHostility } = require("../../lib/battle/data/hostility");
const { GROUPS } = require("../../lib/battle/data/strengthCatalog");
const { REGISTRY_DATA_V1, createFactionRegistry } = require("../../lib/strategy/registry");
const { createOperationKinds } = require("../../lib/strategy/kinds");
const { OPERATION_KINDS_VERSION, OPERATION_KINDS_V1 } = require("../../lib/strategy/data/operationKinds");
const { TARGET_SCORING_V1 } = require("../../lib/strategy/data/targetScoring");
const { buildPowerTable } = require("../../lib/strategy/ai/strength");
const { decideReview } = require("../../lib/strategy/ai");
const { reserveForIndustry, minerPriorityOf } = require("../../lib/strategy/ai/industry");
const { planLogistics } = require("../../lib/strategy/ai/logistics");
const { affordableRuns } = require("../../lib/strategy/ai/production");
const { createHullLedger } = require("../../lib/strategy/ai/hulls");
const { createReviewService } = require("../../lib/strategy/reviewService");
const { createRecipeTable, recipeParamsOf } = require("../../lib/economy/production/recipes");
const RECIPES = require("../../lib/economy/data/hullRecipes");
const { k3StaticMap } = require("./fixtures/k3Cluster.fixture");
const config = require("../../config");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const AMARR = 500003;
const SANSHA = 500019;
const SAMINER = 30001721;
const AT = 1760000000000;
const HOUR = 3600000;
const BARGE = "mining_barge";
const CRUISER = "cruiser";
const NEW_KEYS = ["minerPriorityEnabled", "minerFloorPermille", "minerReserveRuns"];

const graph = (() => {
  const built = buildUniverseGraph(k3StaticMap());
  assert.ok(built.ok);
  return Object.freeze({ ...built.graph, ...createRouteFinder(built.graph, { cacheSize: 16, maxJumps: 40 }).publicApi });
})();
const NEXT = graph.getNeighbors(SAMINER)[0];
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
const THEATRE = [...registry.getCampaign("k3-stain").systemIds].sort((a, b) => a - b);
const hostility = createHostility();

function serviceOf(env = {}) {
  const resolved = config.resolveConfig({ modDir: MOD_DIR, env });
  assert.deepStrictEqual(resolved.errors || [], []);
  return createReviewService({ store: {}, journal: {}, strategyRepository: { limits: { maxResourceUnits: 1 } },
    intelRepository: {}, registry: {}, kinds: { list: [], get: () => null }, powerTable: {}, scoring: {},
    scheduler: {}, fleets: {}, clock: { now: () => 0 }, worldSeed: 1, config: resolved.config, hostility: () => true,
    isCampaignOk: () => true, industryCatalog: {} });
}

const DEF = config.resolveConfig({ modDir: MOD_DIR, env: {} }).config;
const SVC = serviceOf().params;
const table = createRecipeTable(RECIPES, recipeParamsOf(DEF.production));
const recipes = Object.fromEntries(HULL_GROUPS.map((g) => [g, { minerals: table.lookup(g).minerals }]));
const sum = (...lists) => {
  const out = {};
  for (const m of lists) for (const k of Object.keys(m)) out[k] = (out[k] || 0) + m[k];
  return out;
};

function paramsOf(production = {}) {
  return { maxReachJumps: 10, supplyChainJumps: 10, captureRangeFromStationJumps: 5,
    maxAssemblyJumps: 15, maxBfsSystems: 2000, maxTargetCandidates: 40, targetPickTopK: 3, maxOperationsPerReview: 1,
    maxFleetsPerOperation: 4, maxFleetsPerFaction: 12, maxMobilizationsPerReview: 2, mobilizeResourcePerShip: 10,
    mobilizeReservePerShip: 1, attackStrengthRatio: 1.2, intelTtlMs: 6 * HOUR, maxObservationsPerReview: 8,
    reconWindowMs: HOUR / 2, attackWindowMs: 2 * HOUR, operationGraceMs: HOUR, maxHousekeepingPerReview: 4,
    maxRefitRequestsPerReview: 2, kinds: kinds.list, scoring: TARGET_SCORING_V1, powerTable: buildPowerTable(GROUPS),
    frontLimitCap: 2, routeMaxJumps: 40, maxCapturedSystemsPerFaction: 24, captureRequiresAdjacency: true,
    defense: { enabled: true, maxPerReview: 1 }, maxThreatsRead: 32, maxLostHomeRead: 32,
    production: { ...SVC.production, mobilizationStations: 1, ...production }, industry: SVC.industry };
}
const ON = { minerPriorityEnabled: true };
const withoutNewKeys = (p) => ({ ...p, production: Object.fromEntries(Object.entries(p.production)
  .filter(([k]) => !NEW_KEYS.includes(k))) });

const station = (stationId, systemId, o = {}) => ({ stationId, systemId, kind: "npc", lines: o.lines === undefined
  ? 4 : o.lines, activeJobs: o.activeJobs || [], minerals: o.minerals || {}, hulls: o.hulls || {} });
const miner = (fleetId, home) => ({ fleetId, version: 1, state: "IDLE", fleetRole: "mining", systemId: THEATRE[0],
  homeSystemId: home, refitPending: false, shipCount: 3, strength: 1, operationId: null, legSeq: 0,
  composition: [{ hullGroup: "mining_frigate", typeId: null, count: 3 }] });

function snap(stations, fleets) {
  const entry = registry.getFaction(AMARR);
  const doctrine = registry.getDoctrine(entry.doctrineId);
  const ids = [...new Set([...THEATRE, SAMINER, NEXT])].sort((a, b) => a - b);
  return {
    v: 1, factionId: AMARR, round: 7, at: AT, seed: 12345,
    faction: { status: "ACTIVE", homeSystemId: entry.hqSystemId, doctrineId: doctrine.doctrineId,
      resourceUnits: 20000, reserveUnits: 300, frontLimit: 1, version: 3 },
    entry: { kind: entry.kind, maxActiveFronts: entry.maxActiveFronts, allies: [...entry.allies],
      homeRegionIds: [...entry.homeRegionIds], ownerCorporationId: entry.ownerCorporationId },
    doctrine: { doctrineId: doctrine.doctrineId, canOccupy: doctrine.canOccupy,
      operationTypes: [...doctrine.operationTypes], reachJumps: doctrine.reachJumps,
      templates: { invasion: [{ hullGroup: CRUISER, count: 4 }], mining: [{ hullGroup: "mining_frigate", count: 3 }] },
      fieldsDefense: doctrine.fieldsDefense, captureTargets: doctrine.captureTargets },
    theatre: THEATRE,
    neighbors: (id) => graph.getNeighbors(id),
    regionOf: (id) => (graph.getSystem(id) ? graph.getSystem(id).regionId : null),
    isHostile: (x) => x !== AMARR && !entry.allies.includes(x) && hostility(AMARR, x),
    stationsMode: "ready",
    stations: stations.map((s) => ({ systemId: s.systemId, stationId: s.stationId })),
    captureAnchors: [SAMINER],
    systems: ids.map((systemId) => ({ systemId, controllerFactionId: THEATRE.includes(systemId) ? SANSHA : null,
      occupationState: "STABLE", controllerGarrison: 0, hostileStations: 0, observed: false, homeFactionId: null })),
    fleets, fleetsTruncated: false, operations: [], operationsTruncated: false, intel: [], sightings: [],
    threats: { mode: "off", items: [] }, lostHome: { mode: "off", systemIds: [] }, capturedIds: [],
    upkeep: { mode: "off" }, territoryTruncated: false, occupations: [],
    production: { mode: "ready", recipesVersion: table.version, recipes, inProduction: {},
      activeJobsTotal: stations.reduce((n, s) => n + s.activeJobs.length, 0), truncated: false, stations },
  };
}
const produces = (d) => d.intents.filter((i) => i.type === "PRODUCE");
const brief = (d) => produces(d).map((i) => [i.slot, i.stationId, i.hullGroup, i.runs]);
const used = (list) => sum(...list.map((i) => Object.fromEntries(Object.entries(recipes[i.hullGroup].minerals)
  .map(([k, v]) => [k, v * i.runs]))));

const SHORT = () => snap([station("stA", SAMINER, { minerals: sum(recipes[BARGE].minerals, recipes[CRUISER].minerals),
  hulls: { porpoise: 1 } })], [miner("m1", SAMINER)]);

module.exports = ({ test }) => {
  test("MP1 flag off = before: decideReview with minerPriorityEnabled false is "
    + "deepStrictEqual with the params without the three new keys (DoD 13)", () => {
    const P = paramsOf();
    assert.strictEqual(P.production.minerPriorityEnabled, false);
    const off = decideReview(SHORT(), P);
    assert.strictEqual(off.outcome, "REVIEWED", JSON.stringify(off.notes));
    assert.deepStrictEqual(off, decideReview(SHORT(), withoutNewKeys(P)));
    assert.ok(!off.notes.includes("INDUSTRY_PRIORITY"), off.notes.join());
    assert.ok(off.notes.includes(`INDUSTRY_NO_MINERALS:${BARGE}`), off.notes.join());
    assert.deepStrictEqual(brief(off), [[0, "stA", CRUISER, 2]]);
  });

  test("MP2 priority: minerals for 1 barge + 1 cruiser -> the first PRODUCE "
    + "mining_barge (slot 0), the cruisers from the rest, slots continuous and unique", () => {
    const s = SHORT();
    const on = decideReview(s, paramsOf(ON));
    assert.strictEqual(on.outcome, "REVIEWED", JSON.stringify(on.notes));
    const list = produces(on);
    assert.deepStrictEqual(list.map((i) => i.slot), list.map((_i, n) => n), JSON.stringify(brief(on)));
    assert.deepStrictEqual(list[0] && [list[0].hullGroup, list[0].stationId, list[0].runs], [BARGE, "stA", 1]);
    const rest = sum(s.production.stations[0].minerals, Object.fromEntries(Object.entries(recipes[BARGE].minerals)
      .map(([k, v]) => [k, -v])));
    const cruisers = list.filter((i) => i.hullGroup === CRUISER);
    assert.deepStrictEqual(cruisers.map((i) => i.runs), [affordableRuns(rest, recipes[CRUISER])]);
    const spent = used(list);
    const stock = s.production.stations[0].minerals;
    assert.deepStrictEqual(Object.keys(spent).filter((k) => spent[k] > (stock[k] || 0)), [], JSON.stringify(spent));
    assert.ok(on.notes.includes("INDUSTRY_PRIORITY") && !on.notes.some((n) => n.startsWith("INDUSTRY_RESERVE")),
      on.notes.join());
    const one = SHORT();
    one.production.stations[0].lines = 1;
    assert.deepStrictEqual(brief(decideReview(one, paramsOf(ON))), [[0, "stA", BARGE, 1]]);
  });

  test("MP3 reserve: minerals short of a barge at the mining station -> no combat "
    + "PRODUCE below the reserve, note INDUSTRY_RESERVE:mining_barge; MINERALS_TO_FACTORY never takes the reserve",
  () => {
    const poor = { ...recipes[BARGE].minerals, "type:34": recipes[BARGE].minerals["type:34"] - 1 };
    assert.ok(affordableRuns(poor, recipes[CRUISER]) >= 1);
    const stations = () => [station("stM", SAMINER, { lines: 2, activeJobs: [{ hullGroup: CRUISER, runs: 1 }] }),
      station("stR", NEXT, { minerals: { ...poor }, hulls: { porpoise: 1 } })];
    const on = decideReview(snap(stations(), [miner("m1", NEXT)]), paramsOf(ON));
    assert.ok(on.notes.includes(`INDUSTRY_RESERVE:${BARGE}`), on.notes.join());
    assert.deepStrictEqual(produces(on).filter((i) => i.stationId === "stR"), [], JSON.stringify(brief(on)));
    const bare = decideReview(snap(stations(), [miner("m1", NEXT)]), paramsOf({ ...ON, minerReserveRuns: 0 }));
    assert.ok(produces(bare).some((i) => i.stationId === "stR" && i.hullGroup === CRUISER), JSON.stringify(brief(bare)));
    assert.ok(!bare.notes.some((n) => n.startsWith("INDUSTRY_RESERVE")), bare.notes.join());

    const P = paramsOf();
    const logistics = { ...SVC.logistics, mineralSurplusThreshold: 0, mineralConvoyMinLoad: 1 };
    const s = { ...snap(stations(), [{ fleetId: "lf1", version: 1, state: "IDLE", fleetRole: "logistics",
      systemId: NEXT, homeSystemId: NEXT, refitPending: false, operationId: null,
      composition: [{ hullGroup: "industrial", count: 2 }] }]),
    logistics: { mode: "ready", open: [], busyFleetIds: [], carriers: { lf1: 2 }, truncated: false } };
    const supply = { frontTargets: [], affordable: { resourceUnits: 10000, reserveUnits: 1000 } };
    const r = reserveForIndustry(s.production, [], { hullGroup: BARGE, stationId: "stR" }, 1);
    assert.deepStrictEqual(r.reserve, [{ stationId: "stR", minerals: Object.fromEntries(Object.keys(poor).sort()
      .map((k) => [k, poor[k]])) }]);
    const convoys = (produced) => planLogistics(s, supply, { ...P, logistics }, produced,
      createHullLedger(s, P), null).intents.filter((i) => i.type === "CONVOY_DISPATCH"
      && i.purpose === "MINERALS_TO_FACTORY" && i.sourceStationId === "stR");
    assert.strictEqual(convoys({ intents: [] }).length, 1, "without a reserve stR feeds M");
    assert.deepStrictEqual(convoys({ intents: [], reserve: r.reserve }), []);
  });

  test("MP6 (J7): the reserve is no mineral of its station - step 3 "
    + "ships more to M by the reserve, step 3d feeds a station whose stock is only reserve, a kit (3c) never takes it, "
    + "a reserve of another station changes nothing", () => {
    const poor = { ...recipes[BARGE].minerals, "type:34": recipes[BARGE].minerals["type:34"] - 1 };
    const big = {};
    for (const g of HULL_GROUPS) for (const k of Object.keys(recipes[g].minerals)) big[k] = 10000000;
    const THIRD = graph.getNeighbors(NEXT).find((x) => x !== SAMINER);
    const P = paramsOf();
    const logistics = { ...SVC.logistics, mineralSurplusThreshold: 0, mineralConvoyMinLoad: 1 };
    const lf = (systemId) => ({ fleetId: "lf1", version: 1, state: "IDLE", fleetRole: "logistics", systemId,
      homeSystemId: systemId, refitPending: false, operationId: null,
      composition: [{ hullGroup: "industrial", count: 1000 }] });
    const supply = { frontTargets: [], affordable: { resourceUnits: 10000, reserveUnits: 1000 } };
    const withLg = (stations, systemId, extra = {}) => ({ ...snap(stations, [lf(systemId)]), ...extra,
      logistics: { mode: "ready", open: [], busyFleetIds: [], carriers: { lf1: 1000 }, truncated: false } });
    const dispatches = (s, produced) => planLogistics(s, supply, { ...P, logistics }, produced,
      createHullLedger(s, P), null).intents.filter((i) => i.type === "CONVOY_DISPATCH");
    const qty = (i) => Object.fromEntries(((i && i.items) || []).map((x) => [x.itemKey, x.quantity]));
    const total = (m) => Object.values(m).reduce((a, b) => a + b, 0);

    const s3 = withLg([station("stM", SAMINER, { lines: 2, activeJobs: [{ hullGroup: CRUISER, runs: 1 }],
      minerals: { ...poor }, hulls: { porpoise: 1 } }),
    station("stS", NEXT, { lines: 1, activeJobs: [{ hullGroup: CRUISER, runs: 1 }], minerals: { ...big } })], NEXT);
    const atM = reserveForIndustry(s3.production, [], { hullGroup: BARGE, stationId: "stM" }, 1).reserve;
    assert.deepStrictEqual(atM.map((x) => x.stationId), ["stM"]);
    const toM = (produced) => dispatches(s3, produced).filter((i) => i.purpose === "MINERALS_TO_FACTORY"
      && i.sourceStationId === "stS" && i.destStationId === "stM");
    const [bare] = toM({ intents: [] });
    const [held] = toM({ intents: [], reserve: atM });
    assert.ok(bare && held, JSON.stringify([bare, held]));
    const a = qty(bare);
    const b = qty(held);
    assert.ok(total(b) > total(a), JSON.stringify([a, b]));
    for (const k of Object.keys(b)) assert.strictEqual(b[k] - (a[k] || 0), Math.min(atM[0].minerals[k] || 0, b[k]), k);
    assert.deepStrictEqual(toM({ intents: [], reserve: [{ stationId: "stX", minerals: { ...big } }] }).map(qty), [a]);

    const s3d = withLg([station("stM", SAMINER, { lines: 2, activeJobs: [{ hullGroup: CRUISER, runs: 1 }] }),
      station("stR", NEXT, { minerals: { ...poor }, hulls: { porpoise: 1 } }),
      station("stS", THIRD, { lines: 1, activeJobs: [{ hullGroup: CRUISER, runs: 1 }], minerals: { ...big } })], THIRD);
    const atR = reserveForIndustry(s3d.production, [], { hullGroup: BARGE, stationId: "stR" }, 1).reserve;
    const toR = (produced) => dispatches(s3d, produced).filter((i) => i.purpose === "MINERALS_TO_FACTORY"
      && i.destStationId === "stR");
    assert.deepStrictEqual(toR({ intents: [] }), [], "without a reserve stR can build a cruiser");
    assert.deepStrictEqual(toR({ intents: [], reserve: atR }).map((i) => i.sourceStationId), ["stS"]);

    const site = { stationId: "site1", systemId: NEXT, state: "SUPPLYING", remaining: { "mineral/type:34": 1000 } };
    const s3c = withLg([station("stM", SAMINER, { lines: 2, activeJobs: [{ hullGroup: CRUISER, runs: 1 }] }),
      station("stK", SAMINER, { lines: 0, minerals: { ...poor } })], SAMINER,
    { construction: { mode: "ready", open: [site] } });
    const atK = reserveForIndustry(s3c.production, [], { hullGroup: BARGE, stationId: "stK" }, 1).reserve;
    const kits = (produced) => dispatches(s3c, produced).filter((i) => i.purpose === "CONSTRUCTION")
      .map((i) => [i.sourceStationId, i.destStationId, qty(i)]);
    assert.deepStrictEqual(kits({ intents: [] }), [["stK", "site1", { "type:34": 1000 }]]);
    assert.deepStrictEqual(kits({ intents: [], reserve: atK }), []);
  });

  test("MP8 (mineral): stock above the reserve - a reserve R on a stock S plans the "
    + "same convoy quantities as a stock S - R without a reserve (steps 3, 3d, 3c; R taken once, only at its station)",
  () => {
    const R = { ...recipes[BARGE].minerals };
    const plus = (extra) => sum(R, extra);
    const ones = Object.fromEntries(Object.keys(R).map((k) => [k, 1]));
    const THIRD = graph.getNeighbors(NEXT).find((x) => x !== SAMINER);
    const P = paramsOf();
    const logistics = { ...SVC.logistics, mineralSurplusThreshold: 0, mineralConvoyMinLoad: 1, minLoadVolume: 1 };
    const lf = (systemId) => ({ fleetId: "lf1", version: 1, state: "IDLE", fleetRole: "logistics", systemId,
      homeSystemId: systemId, refitPending: false, operationId: null,
      composition: [{ hullGroup: "industrial", count: 1000 }] });
    const supply = { frontTargets: [], affordable: { resourceUnits: 10000, reserveUnits: 1000 } };
    const withLg = (stations, systemId, extra = {}) => ({ ...snap(stations, [lf(systemId)]), ...extra,
      logistics: { mode: "ready", open: [], busyFleetIds: [], carriers: { lf1: 1000 }, truncated: false } });
    const big = {};
    for (const g of HULL_GROUPS) for (const k of Object.keys(recipes[g].minerals)) big[k] = 10000000;
    const qty = (i) => Object.fromEntries(((i && i.items) || []).map((x) => [x.itemKey, x.quantity]));
    const plan = (s, produced, purpose) => planLogistics(s, supply, { ...P, logistics }, produced,
      createHullLedger(s, P), null).intents.filter((i) => i.type === "CONVOY_DISPATCH" && i.purpose === purpose)
      .map((i) => [i.sourceStationId, i.destStationId, qty(i)]);
    const reserveAt = (stationId) => ({ intents: [], reserve: [{ stationId, minerals: { ...R } }] });
    const NONE = { intents: [] };

    const s3 = (minerals) => withLg([station("stM", SAMINER, { lines: 2,
      activeJobs: [{ hullGroup: CRUISER, runs: 1 }], minerals, hulls: { porpoise: 1 } }),
    station("stS", NEXT, { lines: 1, activeJobs: [{ hullGroup: CRUISER, runs: 1 }], minerals: { ...big } })], NEXT);
    const toM3 = plan(s3(plus(ones)), reserveAt("stM"), "MINERALS_TO_FACTORY").filter((x) => x[1] === "stM");
    assert.strictEqual(toM3.length, 1, JSON.stringify(toM3));
    assert.deepStrictEqual(toM3, plan(s3({ ...ones }), NONE, "MINERALS_TO_FACTORY").filter((x) => x[1] === "stM"));

    const s3d = (minerals) => withLg([station("stM", SAMINER, { lines: 2,
      activeJobs: [{ hullGroup: CRUISER, runs: 1 }] }),
    station("stR", NEXT, { minerals, hulls: { porpoise: 1 } }),
    station("stS", THIRD, { lines: 1, activeJobs: [{ hullGroup: CRUISER, runs: 1 }], minerals: { ...big } })], THIRD);
    const toR = plan(s3d(plus(ones)), reserveAt("stR"), "MINERALS_TO_FACTORY").filter((x) => x[1] === "stR");
    assert.strictEqual(toR.length, 1, JSON.stringify(toR));
    assert.deepStrictEqual(toR, plan(s3d({ ...ones }), NONE, "MINERALS_TO_FACTORY").filter((x) => x[1] === "stR"));

    const TRIT = 500;
    assert.ok(R["type:34"] > 2 * TRIT, JSON.stringify(R));
    const site = { stationId: "site1", systemId: NEXT, state: "SUPPLYING", remaining: { "mineral/type:34": 1000 } };
    const s3c = (minerals, others = []) => withLg([station("stM", SAMINER, { lines: 2,
      activeJobs: [{ hullGroup: CRUISER, runs: 1 }] }), station("stK", SAMINER, { lines: 0, minerals }), ...others],
    SAMINER, { construction: { mode: "ready", open: [{ ...site }] } });
    const kitK = plan(s3c(plus({ "type:34": TRIT })), reserveAt("stK"), "CONSTRUCTION");
    assert.deepStrictEqual(kitK, [["stK", "site1", { "type:34": TRIT }]]);
    assert.deepStrictEqual(kitK, plan(s3c({ "type:34": TRIT }), NONE, "CONSTRUCTION"));
    const stK2 = () => [station("stK2", SAMINER, { lines: 0, minerals: { "type:34": 2 * TRIT - 200 } })];
    const kitK2 = plan(s3c(plus({ "type:34": TRIT }), stK2()), reserveAt("stK"), "CONSTRUCTION");
    assert.deepStrictEqual(kitK2, [["stK2", "site1", { "type:34": 2 * TRIT - 200 }]]);
    assert.deepStrictEqual(kitK2, plan(s3c({ "type:34": TRIT }, stK2()), NONE, "CONSTRUCTION"));
  });

  test("MP7: the gates of the mode, paid from the "
    + "fleets, activeJobsTotal of the pseudo jobs, no reserve of only zeros", () => {
    const P = paramsOf(ON);
    const mining = { fleetsWanted: 1 };
    assert.strictEqual(minerPriorityOf(SHORT(), P, mining).on, true);
    const offWith = (s, p) => assert.deepStrictEqual(minerPriorityOf(s, p, mining), { on: false, paid: 0, slots: 0 });
    offWith(SHORT(), { ...P, industry: { ...P.industry, industryEnabled: false } });
    const cut = SHORT();
    cut.production.truncated = true;
    offWith(cut, P);
    const busy = SHORT();
    busy.production.mode = "busy";
    offWith(busy, P);
    offWith(SHORT(), { ...P, industry: { ...P.industry, maxIndustryJobsPerReview: 0 } });
    offWith({ ...SHORT(), stationsMode: "busy" }, P);
    offWith({ ...SHORT(), faction: { ...SHORT().faction, status: "DORMANT" } }, P);
    offWith({ ...SHORT(), fleetsTruncated: true }, P);
    const noJobs = { ...P, industry: { ...P.industry, maxIndustryJobsPerReview: 0 } };
    const dOff = decideReview(SHORT(), { ...noJobs, production: { ...noJobs.production, minerPriorityEnabled: false } });
    assert.deepStrictEqual(decideReview(SHORT(), noJobs), dOff);
    assert.ok(!dOff.notes.includes("INDUSTRY_PRIORITY"), dOff.notes.join());
    const fleet = { ...miner("m2", SAMINER), composition: [{ hullGroup: BARGE, typeId: null, count: 2 }] };
    const two = snap(SHORT().production.stations, [miner("m1", SAMINER), fleet]);
    assert.strictEqual(minerPriorityOf(two, P, mining).paid, 3);
    const s = SHORT();
    const intent = { type: "PRODUCE", slot: 0, stationId: "stA", systemId: SAMINER, hullGroup: BARGE, runs: 1 };
    assert.strictEqual(reserveForIndustry(s.production, [intent], null, 0).production.activeJobsTotal,
      s.production.activeJobsTotal + 1);
    const empty = reserveForIndustry(snap([station("stR", NEXT)], []).production, [],
      { hullGroup: BARGE, stationId: "stR" }, 1);
    assert.deepStrictEqual(empty.reserve, []);
    const bareStations = () => [station("stM", SAMINER, { lines: 2, activeJobs: [{ hullGroup: CRUISER, runs: 1 }] }),
      station("stR", NEXT, { hulls: { porpoise: 1 } })];
    const on = decideReview(snap(bareStations(), [miner("m1", NEXT)]), P);
    assert.ok(on.notes.includes("INDUSTRY_PRIORITY") && on.notes.includes(`INDUSTRY_NO_MINERALS:${BARGE}`),
      on.notes.join());
    assert.ok(!on.notes.some((n) => n.startsWith("INDUSTRY_RESERVE")), on.notes.join());
  });

  test("MP4 floor: paid mining hulls >= minerFloorPermille of the miner slots -> "
    + "decideReview deepStrictEqual with the flag off", () => {
    const s = () => snap([station("stA", SAMINER, { minerals: sum(recipes[BARGE].minerals, recipes[CRUISER].minerals),
      hulls: { porpoise: 1, [BARGE]: 1 } })], [miner("m1", SAMINER)]);
    const on = decideReview(s(), paramsOf(ON));
    assert.deepStrictEqual(on, decideReview(s(), paramsOf()));
    assert.ok(!on.notes.includes("INDUSTRY_PRIORITY"), on.notes.join());
    const low = snap([station("stA", SAMINER, { minerals: sum(recipes[BARGE].minerals, recipes[CRUISER].minerals),
      hulls: { porpoise: 1 } })], [miner("m1", SAMINER)]);
    assert.ok(decideReview(low, paramsOf(ON)).notes.includes("INDUSTRY_PRIORITY"));
  });

  test("MP5 params: the real reviewService passes the three keys to params.production "
    + "(defaults false / 500 / 1, env values); warning with industryEnabled=false only", () => {
    const pick = (p) => NEW_KEYS.map((k) => p.production[k]);
    assert.deepStrictEqual(pick(SVC), [false, 500, 1]);
    const env = { EVEJS_LNE_PRODUCTION_MINER_PRIORITY_ENABLED: "1", EVEJS_LNE_PRODUCTION_MINER_FLOOR_PERMILLE: "750",
      EVEJS_LNE_PRODUCTION_MINER_RESERVE_RUNS: "3" };
    assert.deepStrictEqual(pick(serviceOf(env).params), [true, 750, 3]);
    const warn = (e) => config.resolveConfig({ modDir: MOD_DIR, env: e }).warnings
      .filter((w) => w.startsWith("production.minerPriorityEnabled"));
    assert.deepStrictEqual([warn({}), warn(env).length,
      warn({ ...env, EVEJS_LNE_PRODUCTION_INDUSTRY_ENABLED: "0" }).length], [[], 0, 1]);
  });
};
