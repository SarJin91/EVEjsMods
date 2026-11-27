"use strict";

const assert = require("node:assert");
const path = require("node:path");

const { buildUniverseGraph } = require("../../lib/graph/universeGraph");
const { createRouteFinder } = require("../../lib/graph/routes");
const { createRng } = require("../../lib/util/rng");
const { HULL_GROUPS, FLEET_ROLES, OPERATION_TYPES, OBJECTIVES } = require("../../lib/fleets/schema");
const { createHostility } = require("../../lib/battle/data/hostility");
const { GROUPS } = require("../../lib/battle/data/strengthCatalog");
const { REGISTRY_DATA_V1, createFactionRegistry } = require("../../lib/strategy/registry");
const { createOperationKinds } = require("../../lib/strategy/kinds");
const { OPERATION_KINDS_VERSION, OPERATION_KINDS_V1 } = require("../../lib/strategy/data/operationKinds");
const { TARGET_SCORING_V1 } = require("../../lib/strategy/data/targetScoring");
const { buildPowerTable, strengthOf } = require("../../lib/strategy/ai/strength");
const { chooseNextOperation } = require("../../lib/strategy/ai/operations");
const { createHullLedger } = require("../../lib/strategy/ai/hulls");
const { decideReview } = require("../../lib/strategy/ai");
const { fitIskOf, warRoomOf } = require("../../lib/strategy/ai/warChest");
const { createHullValueTable } = require("../../lib/economy/treasury/hullValues");
const { createRecipeTable, recipeParamsOf } = require("../../lib/economy/production/recipes");
const { REF_PRICE_MILLI, HULL_VALUE_FACTOR_PERMILLE } = require("../../lib/economy/data/mineralRefPrices");
const { treasuryParamsOf } = require("../../lib/strategy/reviewService");
const RECIPES = require("../../lib/economy/data/hullRecipes");
const { k3StaticMap } = require("./fixtures/k3Cluster.fixture");
const config = require("../../config");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const AT = 1760000000000;
const HOUR = 3600000;
const F = 7;
const H = 9;

const kinds = (() => {
  const k = createOperationKinds({ version: OPERATION_KINDS_VERSION, kinds: OPERATION_KINDS_V1 },
    { operationTypes: OPERATION_TYPES, objectives: OBJECTIVES, fleetRoles: FLEET_ROLES });
  assert.ok(k.ok, JSON.stringify(k));
  return k.kinds;
})();
const POWER = buildPowerTable(GROUPS);
const INVASION = Object.freeze([{ hullGroup: "cruiser", count: 4 }]);
const SCOUT = Object.freeze([{ hullGroup: "frigate", count: 1 }]);
const PATROL = Object.freeze([{ hullGroup: "cruiser", count: 2 }]);
const comp = (t) => t.map((e) => ({ ...e, typeId: null }));
const INV_STRENGTH = strengthOf(comp(INVASION), POWER);
const PATROL_STRENGTH = strengthOf(comp(PATROL), POWER);

const PARAMS = Object.freeze({ maxReachJumps: 10, supplyChainJumps: 10, captureRangeFromStationJumps: 5,
  maxAssemblyJumps: 15, maxBfsSystems: 2000, mobilizeFallbackJumps: 30, mobilizeFallbackMaxSystems: 9000,
  maxTargetCandidates: 40, targetPickTopK: 1, maxOperationsPerReview: 1, maxFleetsPerOperation: 4,
  maxFleetsPerFaction: 12, maxMobilizationsPerReview: 2, mobilizeResourcePerShip: 10, mobilizeReservePerShip: 1,
  attackStrengthRatio: 1.2, intelTtlMs: 6 * HOUR, maxObservationsPerReview: 8, reconWindowMs: HOUR / 2,
  attackWindowMs: 2 * HOUR, operationGraceMs: HOUR, maxHousekeepingPerReview: 4, maxRefitRequestsPerReview: 2,
  kinds: kinds.list, scoring: TARGET_SCORING_V1, powerTable: POWER, frontLimitCap: 2, routeMaxJumps: 40,
  captureRequiresAdjacency: false });

const VALUE = Object.freeze({ cruiser: 10000000, frigate: 1000000 });
const CAP = 1500000000;
const WAR = Object.freeze({ room: 0, dayBudget: 0, spentToday: 0, captureIsk: CAP, fitPermille: 300,
  productionCap: 0, valueByGroup: VALUE });
const FIT_INV = fitIskOf(INVASION, VALUE, 300);
const FIT_SCOUT = fitIskOf(SCOUT, VALUE, 300);
const FIT_PATROL = fitIskOf(PATROL, VALUE, 300);

const row = (systemId, controllerFactionId, extra = {}) => ({ systemId, controllerFactionId,
  occupationState: "STABLE", controllerGarrison: 0, hostileStations: 0, observed: false, ...extra });
const intelOf = (systemId, controllerFactionId, strength = 0) => ({ systemId, observedAt: AT - HOUR, hostileFleets: 0,
  hostileShips: 0, hostileStrength: strength, hostileStations: 0, controllerFactionId });
const fleet = (fleetId, systemId) => ({ fleetId, version: 1, state: "IDLE", fleetRole: "invasion", systemId,
  refitPending: false, shipCount: 4, strength: INV_STRENGTH, operationId: null, legSeq: 0, homeSystemId: systemId });
const launches = (r) => r.intents.filter((i) => i.type === "LAUNCH");

function star(o) {
  const HOME = 1;
  const adj = { 1: [2], 2: [1, 3, 4], 3: [2], 4: [2] };
  const s = { v: 1, factionId: F, round: 1, at: AT, seed: 1,
    faction: { status: "ACTIVE", homeSystemId: HOME, frontLimit: 2 }, entry: { homeRegionIds: [] },
    doctrine: { doctrineId: "wc", canOccupy: true, captureTargets: ["free", "hostile", "home", "contested"],
      operationTypes: ["recon", "invasion", "raid"], templates: { invasion: INVASION, scout: SCOUT, patrol: PATROL } },
    theatre: o.theatre || [], expansion: o.expansion || [], lostHome: { systemIds: o.lostHome || [] },
    neighbors: (id) => adj[id] || [], regionOf: () => null, isHostile: (x) => x === H,
    stations: [{ systemId: HOME, stationId: "st0" }],
    systems: [row(HOME, F), row(2, null), ...o.rows], fleets: o.fleets || [], operations: [],
    operationsTruncated: false, intel: o.intel || [], sightings: [] };
  const supply = { frontTargets: [], frontLimit: 2, anchors: [HOME], stationSystems: [HOME],
    affordable: { resourceUnits: 1e6, reserveUnits: 1e6, ...(o.isk === undefined ? {} : { isk: o.isk }) },
    reach: new Map([[2, 1], [3, 1], [4, 2]]), captureReach: new Map([[2, 1], [3, 1], [4, 2]]), captureRoom: null,
    border: new Map(), ...(o.isk === undefined ? {} : { war: WAR }) };
  return chooseNextOperation(s, supply, { ...PARAMS, ...(o.params || {}) }, createRng(1), null);
}

const recipes = Object.fromEntries(Object.entries(RECIPES.GROUPS).map(([g, r]) => [g, { minerals: r.minerals }]));

function line(isk, params) {
  const st = (stationId, systemId, hulls) => ({ stationId, systemId, kind: "npc", lines: 2, activeJobs: [],
    minerals: {}, hulls });
  const stations = [st("far", 25, { cruiser: 2 }), st("near", 38, { cruiser: 2 })];
  const s = { v: 1, factionId: F, round: 1, at: AT, seed: 1,
    faction: { status: "ACTIVE", homeSystemId: 40, frontLimit: 2 }, entry: { homeRegionIds: [] },
    doctrine: { doctrineId: "wc2", canOccupy: false, captureTargets: [], operationTypes: ["recon", "raid"],
      templates: { patrol: PATROL, scout: SCOUT } },
    theatre: [1, 39], expansion: [],
    neighbors: (id) => [id - 1, id + 1].filter((x) => x >= 1 && x <= 40), regionOf: () => null,
    isHostile: (x) => x === H, stations: stations.map((x) => ({ systemId: x.systemId, stationId: x.stationId })),
    systems: [row(1, H), row(39, H)], fleets: [], operations: [], operationsTruncated: false,
    intel: [intelOf(1, H, PATROL_STRENGTH), intelOf(39, H, 0)], sightings: [],
    production: { mode: "ready", recipesVersion: 1, recipes, inProduction: {}, activeJobsTotal: 0, truncated: false,
      stations } };
  const supply = { frontTargets: [], frontLimit: 2, anchors: [40], stationSystems: [25, 38],
    affordable: { resourceUnits: 1e6, reserveUnits: 1e6, isk }, reach: new Map([[1, 1], [39, 2]]),
    captureReach: new Map(), captureRoom: null, border: new Map(), war: WAR };
  const P = { ...PARAMS, maxOperationsPerReview: 2, maxMobilizationsPerReview: 3,
    production: { maxJobsPerReview: 8, maxRunsPerJob: 4, maxActiveJobsPerFaction: 8, targetStockFleets: 2,
      mobilizeHulls: "required", miningNeedsHulls: false, mobilizationStations: 1, hullGroups: [...HULL_GROUPS] },
    ...params };
  return chooseNextOperation(s, supply, P, createRng(1), createHullLedger(s, P));
}

module.exports = ({ test }) => {
  test("WC1 chooseNextOperation war chest: capture of a free system short -> none + WAR_CHEST_SHORT, enough -> LAUNCH "
    + "warIsk; home reclaim without warIsk; hostile theatre -> raid; INSUFFICIENT_FORCE gives the price back", () => {
    assert.ok(FIT_INV > 0 && FIT_SCOUT > 0 && CAP > 2 * FIT_INV);
    const free = { expansion: [3], rows: [row(3, null), row(4, null)], intel: [intelOf(3, null)],
      fleets: [fleet("f1", 2)] };
    const short = star({ ...free, isk: CAP - 1 });
    assert.deepStrictEqual(launches(short), [], JSON.stringify(short));
    assert.deepStrictEqual(short.notes.filter((n) => n === "WAR_CHEST_SHORT"), ["WAR_CHEST_SHORT"], short.notes.join());
    const enough = star({ ...free, isk: CAP });
    assert.deepStrictEqual(launches(enough).map((l) => [l.kind, l.target.systemId, l.warIsk, l.mobilize.length]),
      [["invasion", 3, CAP, 0]], JSON.stringify(enough));
    const off = star(free);
    assert.deepStrictEqual(launches(off).map((l) => [l.kind, "warIsk" in l]), [["invasion", false]]);

    const home = star({ expansion: [3], lostHome: [3], rows: [row(3, null, { homeFactionId: F }), row(4, null)],
      intel: [intelOf(3, null)], fleets: [fleet("f1", 2)], isk: 0 });
    assert.deepStrictEqual(launches(home).map((l) => [l.kind, l.target.systemId, "warIsk" in l]),
      [["invasion", 3, false]], JSON.stringify(home));
    assert.ok(home.notes.includes("RECLAIM:3") && !home.notes.includes("WAR_CHEST_SHORT"), home.notes.join());

    const raid = star({ theatre: [3], rows: [row(3, H), row(4, null)], intel: [intelOf(3, H)],
      fleets: [fleet("f1", 2)], isk: 0 });
    assert.deepStrictEqual(launches(raid).map((l) => [l.kind, l.target.systemId, "warIsk" in l]), [["raid", 3, false]]);
    assert.deepStrictEqual(raid.notes.filter((n) => n === "WAR_CHEST_SHORT"), ["WAR_CHEST_SHORT"], raid.notes.join());

    const E = 8000;
    assert.ok(Math.ceil(E * 1.2) > 2 * INV_STRENGTH && E < 10000, `E ${E} strength ${INV_STRENGTH}`);
    const force = { expansion: [3, 4], rows: [row(3, null), row(4, null)], intel: [intelOf(3, null, E)],
      params: { maxOperationsPerReview: 2, maxMobilizationsPerReview: 3, maxFleetsPerOperation: 2 } };
    const r = star({ ...force, isk: CAP + 2 * FIT_INV + FIT_SCOUT });
    const mobs = r.intents.filter((i) => i.type === "MOBILIZE");
    assert.deepStrictEqual(mobs.map((m) => [m.role, m.warIsk]), [["invasion", FIT_INV], ["invasion", FIT_INV]],
      JSON.stringify(r));
    assert.ok(r.notes.includes("INSUFFICIENT_FORCE"), r.notes.join());
    assert.deepStrictEqual(launches(r).map((l) => [l.kind, l.target.systemId, "warIsk" in l,
      l.mobilize.map((m) => [m.role, m.warIsk])]), [["recon", 4, false, [["scout", FIT_SCOUT]]]], JSON.stringify(r));
    assert.ok(!r.notes.includes("WAR_CHEST_SHORT"), r.notes.join());
  });

  test("WC2 mobilize war chest: warIsk = fitIskOf(template); short -> no MOBILIZE (WAR_CHEST_SHORT before the hulls); "
    + "a rolled back far trial restores budget.isk (the plan of the variant without the trial)", () => {
    const strong = { expansion: [3], rows: [row(3, null), row(4, null)],
      intel: [intelOf(3, null, Math.floor(INV_STRENGTH * 4))], params: { maxFleetsPerOperation: 2 } };
    const short = star({ ...strong, isk: CAP + FIT_INV - 1 });
    assert.deepStrictEqual(short.intents, [], JSON.stringify(short));
    assert.deepStrictEqual(short.notes, ["WAR_CHEST_SHORT", "INSUFFICIENT_FORCE"]);
    assert.strictEqual(FIT_INV, Math.floor((4 * VALUE.cruiser * 300) / 1000));

    const trial = line(FIT_PATROL, {});
    const plain = line(FIT_PATROL, { mobilizeFallbackJumps: 0 });
    assert.deepStrictEqual(launches(trial).map((l) => [l.kind, l.target.systemId,
      l.mobilize.map((m) => [m.stationId, m.warIsk])]), [["raid", 39, [["near", FIT_PATROL]]]], JSON.stringify(trial));
    assert.deepStrictEqual(trial.intents, plain.intents);
    assert.ok(!trial.notes.includes("WAR_CHEST_SHORT") && !trial.notes.includes("MOBILIZE_FAR"), trial.notes.join());
  });

  test("WC3 decideReview: flag off = no pressure keys (deepStrictEqual); flag on: decision.warChest = warRoomOf, "
    + "MOBILIZE warIsk, small productionRoomSharePermille -> fewer PRODUCE", () => {
    const AMARR = 500003;
    const SANSHA = 500019;
    const SAMINER = 30001721;
    const graph = (() => {
      const built = buildUniverseGraph(k3StaticMap());
      assert.ok(built.ok);
      return Object.freeze({ ...built.graph, ...createRouteFinder(built.graph, { cacheSize: 16, maxJumps: 40 }).publicApi });
    })();
    const registry = createFactionRegistry(REGISTRY_DATA_V1, { hullGroups: HULL_GROUPS, fleetRoles: FLEET_ROLES,
      operationTypes: OPERATION_TYPES, hostility: createHostility(), maxFactions: 64, maxCampaignSystems: 40,
      maxShipsPerFleet: 500, maxCompositionEntries: 32, maxResourceUnits: 1000000000 }).registry;
    const theatre = [...registry.getCampaign("k3-stain").systemIds].sort((a, b) => a - b);
    const hostility = createHostility();
    const resolved = (env) => config.resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_TREASURY_ENABLED: "1", ...env } })
      .config;
    const tOff = treasuryParamsOf(resolved({}));
    const tOn = treasuryParamsOf(resolved({ EVEJS_LNE_TREASURY_PRESSURE_ENABLED: "1" }));
    const bare = Object.fromEntries(Object.entries(tOff).filter(([k]) => !["pressureEnabled",
      "adminIskPerCapturedSystemPerDay", "adminSprawlSystems", "savingsDrawPermillePerDay", "captureLaunchIsk",
      "mobilizeFitPermille", "productionRoomSharePermille", "lossesInRoomPermille"].includes(k)));
    const c = config.resolveConfig({ modDir: MOD_DIR, env: {} }).config;
    const values = createHullValueTable(createRecipeTable(RECIPES, recipeParamsOf(c.production)), REF_PRICE_MILLI,
      HULL_VALUE_FACTOR_PERMILLE).all();
    const PROD = { maxJobsPerReview: 8, maxRunsPerJob: 2, maxActiveJobsPerFaction: 64, targetStockFleets: 4,
      mobilizeHulls: "legacy", miningNeedsHulls: false, mobilizationStations: 1, hullGroups: [...HULL_GROUPS] };
    const P = { ...PARAMS, targetPickTopK: 3, maxTargetCandidates: 40, maxCapturedSystemsPerFaction: 24,
      captureRequiresAdjacency: true, defense: { enabled: true, maxPerReview: 1 }, maxThreatsRead: 32,
      maxLostHomeRead: 32, production: PROD };
    const plenty = Object.fromEntries(Object.keys(RECIPES.GROUPS).flatMap((g) => Object.keys(RECIPES.GROUPS[g]
      .minerals)).map((k) => [k, 1e12]));
    const today = { warSpend: 1e6, productionFees: 2e6, tradeOut: 3e6, losses: 4e6 };
    const snap = () => {
      const entry = registry.getFaction(AMARR);
      const doctrine = registry.getDoctrine(entry.doctrineId);
      const ids = [...new Set([...theatre, SAMINER])].sort((a, b) => a - b);
      return { v: 1, factionId: AMARR, round: 7, at: AT, seed: 12345,
        faction: { status: "ACTIVE", homeSystemId: entry.hqSystemId, doctrineId: doctrine.doctrineId,
          resourceUnits: 20000, reserveUnits: 300, frontLimit: 1, version: 3 },
        entry: { kind: entry.kind, maxActiveFronts: entry.maxActiveFronts, allies: [...entry.allies],
          homeRegionIds: [...entry.homeRegionIds], ownerCorporationId: entry.ownerCorporationId },
        doctrine: { doctrineId: doctrine.doctrineId, canOccupy: doctrine.canOccupy,
          operationTypes: [...doctrine.operationTypes], reachJumps: doctrine.reachJumps, templates: doctrine.templates,
          fieldsDefense: doctrine.fieldsDefense, captureTargets: doctrine.captureTargets },
        theatre, neighbors: (id) => graph.getNeighbors(id),
        regionOf: (id) => (graph.getSystem(id) ? graph.getSystem(id).regionId : null),
        isHostile: (x) => x !== AMARR && !entry.allies.includes(x) && hostility(AMARR, x),
        stationsMode: "ready", stations: [{ systemId: SAMINER, stationId: "st0" }], captureAnchors: [SAMINER],
        systems: ids.map((systemId) => ({ systemId, controllerFactionId: theatre.includes(systemId) ? SANSHA : null,
          occupationState: "STABLE", controllerGarrison: 0, hostileStations: 0, observed: false, homeFactionId: null })),
        fleets: [], fleetsTruncated: false, operations: [], operationsTruncated: false, intel: [], sightings: [],
        threats: { mode: "off", items: [] }, lostHome: { mode: "off", systemIds: [] }, capturedIds: [],
        upkeep: { mode: "off" }, territoryTruncated: false, occupations: [],
        production: { mode: "ready", recipesVersion: 1, recipes, inProduction: {}, activeJobsTotal: 0,
          truncated: false, stations: [{ stationId: "st0", systemId: SAMINER, kind: "npc", lines: 16, activeJobs: [],
            minerals: plenty, hulls: {} }] },
        treasury: { mode: "ready", seeded: true, kind: "empire", initialIsk: 5e12, balanceIsk: 4e11,
          accountMode: "NORMAL", paidUntil: AT - HOUR, valueByGroup: values, tradeHeldIsk: 0, tradeEligible: true,
          factionTradeOutToday: 0, galaxyTradeOutToday: 0, today } };
    };
    const off = decideReview(snap(), { ...P, treasury: tOff });
    assert.strictEqual(off.outcome, "REVIEWED", off.reason);
    assert.deepStrictEqual(decideReview(snap(), { ...P, treasury: bare }), off);
    assert.ok(!("warChest" in off) && !off.intents.some((i) => "warIsk" in i
      || (Array.isArray(i.mobilize) && i.mobilize.some((m) => "warIsk" in m))), JSON.stringify(off.intents));

    const on = decideReview(snap(), { ...P, treasury: tOn });
    assert.strictEqual(on.outcome, "REVIEWED", on.reason);
    const want = warRoomOf({ balanceIsk: 4e11, incomeDaily: tOn.baseIncomeIskPerDayEmpire, fleetUpkeepDaily: 0,
      adminDaily: 0, at: AT, today }, tOn);
    assert.deepStrictEqual(on.warChest, { dayBudget: want.dayBudget, room: want.room, spentToday: want.spentToday });
    assert.ok(want.room > 0 && want.spentToday === 1e6 + 2e6 + 3e6 + Math.floor(4e6 * tOn.lossesInRoomPermille / 1000),
      JSON.stringify(want));
    const mobs = on.intents.flatMap((i) => (i.type === "MOBILIZE" ? [i] : i.type === "LAUNCH" ? i.mobilize : []));
    assert.ok(mobs.length > 0, JSON.stringify(on.notes));
    for (const m of mobs) assert.strictEqual(m.warIsk, fitIskOf(m.composition, values, tOn.mobilizeFitPermille));
    const produces = (d) => d.intents.filter((i) => i.type === "PRODUCE");
    const tight = decideReview(snap(), { ...P, treasury: { ...tOn, productionRoomSharePermille: 1 } });
    assert.ok(produces(tight).length < produces(on).length,
      `${produces(tight).length} vs ${produces(on).length} ${tight.notes.join()}`);
    assert.ok(tight.notes.some((n) => n === "TREASURY_WAR_ROOM_FEE_CAP" || n.startsWith("TREASURY_FEE_CUT")),
      tight.notes.join());
    assert.ok(!tight.notes.includes("TREASURY_FEE_BROKE"), tight.notes.join());
  });
};
