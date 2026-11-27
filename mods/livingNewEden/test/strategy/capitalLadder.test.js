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
const { capitalClassesOf } = require("../../lib/strategy/data/factionHullClasses");
const { buildPowerTable } = require("../../lib/strategy/ai/strength");
const { decideReview } = require("../../lib/strategy/ai");
const { ladderPlanOf, recipePermilleOf } = require("../../lib/strategy/ai/capitalLadder");
const { planLogistics } = require("../../lib/strategy/ai/logistics");
const { planTribute } = require("../../lib/strategy/ai/tribute");
const { sellCandidates } = require("../../lib/strategy/ai/tradeSell");
const TRADE_STATES = require("../../lib/strategy/data/tradeStates");
const { createHullLedger } = require("../../lib/strategy/ai/hulls");
const { createFeeLedger, feeOf } = require("../../lib/strategy/ai/treasury");
const { createReviewService } = require("../../lib/strategy/reviewService");
const { createRecipeTable, recipeParamsOf } = require("../../lib/economy/production/recipes");
const RECIPES = require("../../lib/economy/data/hullRecipes");
const { k3StaticMap } = require("./fixtures/k3Cluster.fixture");
const config = require("../../config");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const AMARR = 500003;
const BLOOD = 500012;
const SANSHA = 500019;
const SAMINER = 30001721;
const AT = 1760000000000;
const HOUR = 3600000;
const CRUISER = "cruiser";
const CARRIER = "carrier";
const NEW_KEYS = ["capitalLadderEnabled", "ladderUnlockPermille", "ladderQuotaCarrier", "ladderQuotaDreadnought",
  "ladderQuotaForceAuxiliary", "ladderQuotaSupercarrier", "ladderQuotaTitan", "ladderFactionKinds",
  "supercarrierRecipePermille", "titanRecipePermille", "capitalHighsecAllowed", "capitalTiers"];

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
const mineralKey = (k) => TRADE_STATES.MINERAL_TYPE_IDS.includes(Number(k.slice("type:".length)));
const half = (m) =>Object.fromEntries(Object.keys(m).map((k) => [k, Math.floor(m[k] / 2)]));

function paramsOf(production = {}, extra = {}) {
  return { maxReachJumps: 10, supplyChainJumps: 10, captureRangeFromStationJumps: 5,
    maxAssemblyJumps: 15, maxBfsSystems: 2000, maxTargetCandidates: 40, targetPickTopK: 3, maxOperationsPerReview: 1,
    maxFleetsPerOperation: 4, maxFleetsPerFaction: 12, maxMobilizationsPerReview: 2, mobilizeResourcePerShip: 10,
    mobilizeReservePerShip: 1, attackStrengthRatio: 1.2, intelTtlMs: 6 * HOUR, maxObservationsPerReview: 8,
    reconWindowMs: HOUR / 2, attackWindowMs: 2 * HOUR, operationGraceMs: HOUR, maxHousekeepingPerReview: 4,
    maxRefitRequestsPerReview: 2, kinds: kinds.list, scoring: TARGET_SCORING_V1, powerTable: buildPowerTable(GROUPS),
    frontLimitCap: 2, routeMaxJumps: 40, maxCapturedSystemsPerFaction: 24, captureRequiresAdjacency: true,
    defense: { enabled: true, maxPerReview: 1 }, maxThreatsRead: 32, maxLostHomeRead: 32,
    production: { ...SVC.production, mobilizationStations: 1, ...production }, industry: SVC.industry, ...extra };
}
const ON = { capitalLadderEnabled: true };
const withoutNewKeys = (p) => ({ ...p, production: Object.fromEntries(Object.entries(p.production)
  .filter(([k]) => !NEW_KEYS.includes(k))) });

const station = (stationId, systemId, o = {}) => ({ stationId, systemId, kind: "npc", lines: o.lines === undefined
  ? 4 : o.lines, activeJobs: o.activeJobs || [], minerals: o.minerals || {}, hulls: o.hulls || {},
  secClass: o.secClass || "lowsec" });

function snap(stations, fleets = [], extra = {}) {
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
    capitalClasses: capitalClassesOf(AMARR),
    ...extra,
  };
}
const produces = (d) => d.intents.filter((i) => i.type === "PRODUCE");
const brief = (d) => produces(d).map((i) => [i.slot, i.stationId, i.hullGroup, i.runs, i.ladder === true]);
const BUILD = () => snap([station("stA", SAMINER, { hulls: { [CRUISER]: 7 },
  minerals: sum(recipes[CARRIER].minerals, recipes[CRUISER].minerals) })]);

module.exports = ({ test }) => {
  test("CL1 flag off = before: decideReview with capitalLadderEnabled false is "
    + "deepStrictEqual with the params without the new keys; on, the same snapshot builds a carrier", () => {
    const P = paramsOf();
    assert.strictEqual(P.production.capitalLadderEnabled, false);
    const off = decideReview(BUILD(), P);
    assert.strictEqual(off.outcome, "REVIEWED", JSON.stringify(off.notes));
    assert.deepStrictEqual(off, decideReview(BUILD(), withoutNewKeys(P)));
    assert.ok(!off.notes.some((n) => n.startsWith("LADDER_")), off.notes.join());
    assert.deepStrictEqual(brief(off), [[0, "stA", CRUISER, 1, false]]);
    assert.ok(produces(decideReview(BUILD(), paramsOf(ON))).some((i) => i.ladder === true));
  });

  test("CL2 reserve: half a carrier in Mc -> no subcap PRODUCE there, LADDER_SAVING; a "
    + "kit never takes the reserve; step 3f ships the rest of the recipe to Mc", () => {
    const stock = half(recipes[CARRIER].minerals);
    const poor = () => snap([station("stA", SAMINER, { hulls: { [CRUISER]: 7 }, minerals: { ...stock } })]);
    const off = decideReview(poor(), paramsOf());
    assert.deepStrictEqual(brief(off), [[0, "stA", CRUISER, 1, false]], "off: the stock builds a cruiser");
    const on = decideReview(poor(), paramsOf(ON));
    const pm = recipePermilleOf(stock, recipes[CARRIER]);
    assert.ok(pm > 400 && pm < 1000, String(pm));
    assert.ok(on.notes.includes(`LADDER_SAVING:${CARRIER}:${pm}`), on.notes.join());
    assert.deepStrictEqual(brief(on), [], "on: the reserve holds every carrier mineral of stA");

    const P = paramsOf(ON);
    const logistics = { ...SVC.logistics, mineralSurplusThreshold: 0, mineralConvoyMinLoad: 1, minLoadVolume: 1 };
    const lf = (systemId) => ({ fleetId: "lf1", version: 1, state: "IDLE", fleetRole: "logistics", systemId,
      homeSystemId: systemId, refitPending: false, operationId: null,
      composition: [{ hullGroup: "industrial", count: 1000 }] });
    const withLg = (stations, systemId, extra = {}) => snap(stations, [lf(systemId)], { ...extra,
      logistics: { mode: "ready", open: [], busyFleetIds: [], carriers: { lf1: 1000 }, truncated: false } });
    const supply = { frontTargets: [], affordable: { resourceUnits: 10000, reserveUnits: 1000 } };
    const dispatches = (s, produced) => planLogistics(s, supply, { ...P, logistics }, produced,
      createHullLedger(s, P), null).intents.filter((i) => i.type === "CONVOY_DISPATCH");
    const qty = (i) => Object.fromEntries(((i && i.items) || []).map((x) => [x.itemKey, x.quantity]));

    const site = { stationId: "site1", systemId: NEXT, state: "SUPPLYING", remaining: { "mineral/type:34": 1000 } };
    const kitScene = () => withLg([station("stA", SAMINER, { hulls: { [CRUISER]: 8 }, minerals: { ...stock } })],
      SAMINER, { construction: { mode: "ready", open: [site] } });
    const plan = ladderPlanOf(kitScene(), P);
    assert.deepStrictEqual([plan.cls, plan.stationId, plan.produce], [CARRIER, "stA", null]);
    assert.deepStrictEqual(plan.reserve && plan.reserve.minerals, stock);
    const kits = (produced) => dispatches(kitScene(), produced).filter((i) => i.purpose === "CONSTRUCTION")
      .map((i) => [i.sourceStationId, qty(i)]);
    assert.deepStrictEqual(kits({ intents: [] }), [["stA", { "type:34": 1000 }]]);
    assert.deepStrictEqual(kits({ intents: [], reserve: [plan.reserve] }), []);

    const big = Object.fromEntries(Object.keys(recipes[CARRIER].minerals).map((k) => [k, 100000000]));
    const s3f = withLg([station("stA", SAMINER, { hulls: { [CRUISER]: 8 }, minerals: { ...stock } }),
      station("stS", NEXT, { lines: 1, activeJobs: [{ hullGroup: CRUISER, runs: 1 }], minerals: big })], NEXT);
    const reserve = ladderPlanOf(s3f, P).reserve;
    const toMc = (produced) => dispatches(s3f, produced).filter((i) => i.purpose === "MINERALS_TO_FACTORY"
      && i.destStationId === "stA");
    assert.deepStrictEqual(toMc({ intents: [] }), [], "no reserve, no 3f convoy");
    const [convoy] = toMc({ intents: [], reserve: [reserve] });
    assert.strictEqual(convoy && convoy.sourceStationId, "stS", JSON.stringify(convoy));
    const want = Object.fromEntries(Object.keys(recipes[CARRIER].minerals).sort()
      .map((k) => [k, recipes[CARRIER].minerals[k] - stock[k]]));
    assert.deepStrictEqual(qty(convoy), want);
  });

  test("CL3 a full recipe + a free line -> PRODUCE carrier slot 0 ladder:true, the "
    + "subcap PRODUCE from slot 1 on the minerals left", () => {
    const on = decideReview(BUILD(), paramsOf(ON));
    assert.deepStrictEqual(brief(on), [[0, "stA", CARRIER, 1, true], [1, "stA", CRUISER, 1, false]]);
    assert.ok(on.notes.includes(`LADDER_PRODUCE:${CARRIER}`), on.notes.join());
    const [ladder] = produces(on);
    assert.deepStrictEqual(ladder, { type: "PRODUCE", slot: 0, stationId: "stA", systemId: SAMINER, hullGroup: CARRIER,
      runs: 1, recipesVersion: table.version, ladder: true });
    assert.deepStrictEqual(brief(decideReview(BUILD(), paramsOf({ ...ON, maxJobsPerReview: 1 }))),
      [[0, "stA", CARRIER, 1, true]]);
  });

  test("CL4 rungs: have = fleets + stock + ACTIVE jobs; S1 full -> supercarrier; no "
    + "supercarrier class -> titan; buffer below the unlock -> LADDER_WAIT_BUFFER; every quota full -> LADDER_FULL",
  () => {
    const P = paramsOf(ON);
    const fleet = { fleetId: "f1", version: 1, state: "IDLE", fleetRole: "invasion", systemId: SAMINER,
      composition: [{ hullGroup: "dreadnought", count: 1 }] };
    const full = snap([station("stA", SAMINER, { hulls: { [CRUISER]: 8, carrier: 2, dreadnought: 1 },
      activeJobs: [{ hullGroup: "force_auxiliary", runs: 1 }] })], [fleet]);
    const amarr = ladderPlanOf(full, P);
    assert.deepStrictEqual([amarr.on, amarr.cls, amarr.bufferPermille], [true, "supercarrier", 1000]);
    assert.deepStrictEqual(amarr.have, { carrier: 2, dreadnought: 2, force_auxiliary: 1, supercarrier: 0, titan: 0 });
    assert.deepStrictEqual(amarr.quota, { carrier: 2, dreadnought: 2, force_auxiliary: 1, supercarrier: 1, titan: 1 });

    const blood = snap([station("stA", SAMINER, { hulls: { [CRUISER]: 8, dreadnought: 2, force_auxiliary: 1 } })], [],
      { factionId: BLOOD, capitalClasses: capitalClassesOf(BLOOD) });
    blood.entry = { ...blood.entry, kind: "pirate" };
    const pirate = ladderPlanOf(blood, P);
    assert.deepStrictEqual([pirate.cls, pirate.quota.carrier, pirate.quota.supercarrier], ["titan", 0, 0]);

    const low = snap([station("stA", SAMINER, { hulls: { [CRUISER]: 6 } })]);
    assert.deepStrictEqual(ladderPlanOf(low, P).notes, ["LADDER_WAIT_BUFFER"]);
    assert.deepStrictEqual(ladderPlanOf(full, paramsOf({ ...ON, ladderQuotaSupercarrier: 0, ladderQuotaTitan: 0 }))
      .notes, ["LADDER_FULL"]);
    assert.strictEqual(ladderPlanOf(full, paramsOf({ ...ON, ladderFactionKinds: "pirate" })).on, false);
  });

  test("CL5 no ISK, treasury.minJobsWhenBroke 1 -> no ladder PRODUCE, note "
    + "LADDER_FEE_SHORT:carrier; the cruiser keeps minJobsWhenBroke and never takes the carrier minerals", () => {
    const T = serviceOf({ EVEJS_LNE_TREASURY_ENABLED: "1" }).params.treasury;
    assert.ok(T && T.minJobsWhenBroke === 1 && T.productionFeePermille > 0, JSON.stringify(T));
    const s = BUILD();
    s.treasury = { mode: "ready", seeded: true, kind: "empire", initialIsk: 0, balanceIsk: 0, paidUntil: AT,
      accountMode: "NORMAL", valueByGroup: { [CARRIER]: 1000000000, [CRUISER]: 10000000 } };
    const on = decideReview(s, paramsOf(ON, { treasury: T }));
    assert.strictEqual(on.outcome, "REVIEWED", JSON.stringify(on.notes));
    assert.ok(on.notes.includes(`LADDER_FEE_SHORT:${CARRIER}`), on.notes.join());
    assert.ok(!on.notes.some((n) => n.startsWith("LADDER_PRODUCE:")), on.notes.join());
    assert.deepStrictEqual(brief(on), [[0, "stA", CRUISER, 1, false]]);
  });

  test("CL6 a lasting titan deficit in Mc: with 1 or 2 dispatch slots "
    + "the front hulls (3b) and the kit (3c) get the slots before step 3f; with free slots 3f still ships to Mc", () => {
    const P = paramsOf({ ...ON, ladderQuotaCarrier: 0, ladderQuotaDreadnought: 0, ladderQuotaForceAuxiliary: 0,
      ladderQuotaSupercarrier: 0 });
    const lf = (fleetId) => ({ fleetId, version: 1, state: "IDLE", fleetRole: "logistics", systemId: NEXT,
      homeSystemId: NEXT, refitPending: false, operationId: null,
      composition: [{ hullGroup: "industrial", count: 1000 }] });
    const front = { fleetId: "inv1", version: 1, state: "IDLE", fleetRole: "invasion", systemId: NEXT,
      homeSystemId: NEXT, refitPending: false, operationId: null, composition: [{ hullGroup: CRUISER, count: 2 }] };
    const big = Object.fromEntries(Object.keys(recipes.titan.minerals).map((k) => [k, 100000000]));
    const site = { stationId: "site1", systemId: SAMINER, state: "SUPPLYING", remaining: { "mineral/type:34": 1000 } };
    const scene = (fleets) => snap([station("stA", SAMINER, { hulls: { [CRUISER]: 10 }, minerals: half(big) }),
      station("stS", NEXT, { lines: 1, activeJobs: [{ hullGroup: CRUISER, runs: 1 }], minerals: big })],
    [...fleets.map(lf), front], { construction: { mode: "ready", open: [site] },
      logistics: { mode: "ready", open: [], busyFleetIds: [], carriers: Object.fromEntries(fleets.map((f) => [f, 1000])),
        truncated: false } });
    const s0 = scene(["lf1"]);
    const plan = ladderPlanOf(s0, P);
    assert.deepStrictEqual([plan.cls, plan.stationId, plan.produce], ["titan", "stA", null], JSON.stringify(plan));
    const produced = { intents: [], reserve: [plan.reserve] };
    const purposes = (fleets, slots, targets) => {
      const logistics = { ...SVC.logistics, mineralSurplusThreshold: 0, mineralConvoyMinLoad: 1, minLoadVolume: 1,
        maxDispatchesPerReview: slots };
      const s = scene(fleets);
      return planLogistics(s, { frontTargets: targets, affordable: { resourceUnits: 10000, reserveUnits: 1000 } },
        { ...P, logistics }, produced, createHullLedger(s, P), null).intents.filter((i) => i.type === "CONVOY_DISPATCH")
        .map((i) => [i.purpose, i.destStationId]);
    };
    const TO_MC = ["MINERALS_TO_FACTORY", "stA"];
    assert.deepStrictEqual(purposes(["lf1", "lf2"], 2, []), [["CONSTRUCTION", "site1"], TO_MC]);
    assert.deepStrictEqual(purposes(["lf1"], 1, []), [["CONSTRUCTION", "site1"]]);
    assert.deepStrictEqual(purposes(["lf1"], 1, [NEXT]), [["HULLS_TO_FRONT", "stS"]]);
    assert.deepStrictEqual(purposes(["lf1", "lf2", "lf3"], 2, [NEXT]),
      [["HULLS_TO_FRONT", "stS"], ["CONSTRUCTION", "site1"]]);
    assert.deepStrictEqual(purposes(["lf1", "lf2", "lf3"], 3, [NEXT]),
      [["HULLS_TO_FRONT", "stS"], ["CONSTRUCTION", "site1"], TO_MC]);
  });

  test("CL7 a paid ladder PRODUCE never takes minJobsWhenBroke: the "
    + "ISK pays exactly the carrier, the cruiser after it still gets 1 run", () => {
    const T = serviceOf({ EVEJS_LNE_TREASURY_ENABLED: "1" }).params.treasury;
    assert.ok(T && T.minJobsWhenBroke === 1 && T.productionFeePermille > 0, JSON.stringify(T));
    const valueByGroup = { [CARRIER]: 1000000000, [CRUISER]: 10000000 };
    const fee = feeOf(1, valueByGroup[CARRIER], T.productionFeePermille);
    const proj = { projectedIsk: fee, valueByGroup, feePermille: T.productionFeePermille,
      minJobsWhenBroke: T.minJobsWhenBroke };
    const ladder = { type: "PRODUCE", slot: 0, stationId: "stA", hullGroup: CARRIER, runs: 1, ladder: true };
    const cruiser = { type: "PRODUCE", slot: 1, stationId: "stA", hullGroup: CRUISER, runs: 2 };
    const out = createFeeLedger(proj).cap({ intents: [ladder, cruiser], notes: [] });
    assert.deepStrictEqual(out.intents.map((i) => [i.hullGroup, i.runs, i.ladder === true]),
      [[CARRIER, 1, true], [CRUISER, 1, false]]);
    assert.ok(!out.notes.includes("TREASURY_FEE_BROKE"), out.notes.join());
    const alone = createFeeLedger({ ...proj, projectedIsk: 0 }).cap({ intents: [cruiser], notes: [] });
    assert.deepStrictEqual(alone.intents.map((i) => [i.hullGroup, i.runs]), [[CRUISER, 1]]);
    const two = createFeeLedger(proj).cap({ intents: [ladder, cruiser, { ...cruiser, slot: 2, stationId: "stB" }],
      notes: [] });
    assert.deepStrictEqual(two.intents.map((i) => [i.stationId, i.hullGroup, i.runs]),
      [["stA", CARRIER, 1], ["stA", CRUISER, 1]]);
    assert.ok(two.notes.includes("TREASURY_FEE_BROKE"), two.notes.join());
  });

  test("CL8 the tribute never takes the ladder reserve of Mc: off -> Mc "
    + "pays; on -> the other station pays, Mc alone -> TRIBUTE_NO_SURPLUS; an industry reserve changes nothing", () => {
    const stock = half(recipes[CARRIER].minerals);
    const tenth = Object.fromEntries(Object.keys(stock).map((k) => [k, Math.floor(stock[k] / 10)]));
    const reserve = { stationId: "stA", minerals: { ...stock }, ladder: true, hullGroup: CARRIER };
    const industry = { stationId: "stA", minerals: { ...stock } };
    const PT = { ratePermille: 100, reserveRuns: 0, minLoadVolume: 1, recipientMaxMineralUnits: 0 };
    const params = { tribute: PT, production: paramsOf(ON).production };
    const scene = (stations) => snap(stations, [], { logistics: { mode: "ready", open: [] },
      tribute: { mode: "ready", bucket: 5, paid: false, recipientFactionId: 500001, recipientMineralUnits: 0,
        maxStockQuantity: 1e15, recipientStations: [{ stationId: "rc", systemId: THEATRE[0], minerals: {},
          freeRows: 256 }] } });
    const two = scene([station("stA", SAMINER, { minerals: { ...stock } }),
      station("stB", NEXT, { minerals: { ...tenth } })]);
    const run = (s, produced) => planTribute(s, s.production, produced, [], params);
    const src = (r) => (r.plan ? r.plan.source.stationId : r.notes.join());
    const qty = (r) => Object.fromEntries(r.plan.items.map((it) => [it.itemKey, it.quantity]));

    const off = run(two, { intents: [] });
    assert.strictEqual(src(off), "stA");
    const owed = (k) => Math.floor((PT.ratePermille * (stock[k] + tenth[k])) / 1000);
    assert.deepStrictEqual(qty(off), Object.fromEntries(Object.keys(stock).sort().filter((k) => owed(k) > 0)
      .map((k) => [k, Math.min(owed(k), stock[k])])));
    assert.deepStrictEqual(run(two, { intents: [], reserve: [industry] }), off);
    const on = run(two, { intents: [], reserve: [reserve] });
    assert.strictEqual(src(on), "stB");
    assert.deepStrictEqual(qty(on), Object.fromEntries(Object.keys(tenth).sort()
      .filter((k) => Math.floor((PT.ratePermille * tenth[k]) / 1000) > 0)
      .map((k) => [k, Math.floor((PT.ratePermille * tenth[k]) / 1000)])));
    const alone = scene([station("stA", SAMINER, { minerals: { ...stock } })]);
    assert.strictEqual(src(run(alone, { intents: [] })), "stA");
    assert.deepStrictEqual(run(alone, { intents: [], reserve: [reserve] }), { plan: null, notes: ["TRIBUTE_NO_SURPLUS"] });
  });

  test("CL9 WTS never sells the ladder reserve of Mc outside "
    + "validChosen (mobilizationStations 2); off and an industry reserve -> the same candidates as before", () => {
    const stock = half(recipes[CARRIER].minerals);
    const keep = recipes[CRUISER].minerals;
    const minerals = sum(stock, keep);
    const reserve = { stationId: "stA", minerals: { ...stock }, ladder: true, hullGroup: CARRIER };
    const npc = (stationId) => ({ stationId, kind: "npc" });
    const args = (production) => ({ trade: { stations: [npc("stM1"), npc("stM2"), npc("stA")] },
      T: { wtsMineralSurplusRuns: 1 }, desired: { [CRUISER]: 1 }, recipes,
      stationsData: [station("stA", SAMINER, { minerals: { ...minerals } })], production,
      logistics: { intents: [] }, validChosen: [{ stationId: "stM1" }, { stationId: "stM2" }],
      warMinerals: new Set(), warHullGroups: new Set() });
    const offer = (r) => Object.fromEntries(r.candidates.map((c) => [`${c.stationId}:${c.itemKey}`, c.surplus]));
    const off = sellCandidates(args({ intents: [] }));
    const sold = Object.fromEntries(Object.keys(stock).filter((k) => mineralKey(k) && stock[k] > 0).sort()
      .map((k) => [`stA:${k}`, stock[k]]));
    assert.ok(Object.keys(sold).length > 0);
    assert.deepStrictEqual(offer(off), sold, "off: Mc sells everything above keep (the reserve included)");
    assert.deepStrictEqual(sellCandidates(args({ intents: [], reserve: [{ stationId: "stA", minerals: { ...stock } }] })),
      off, "an industry reserve is untouched (as before)");
    assert.deepStrictEqual(offer(sellCandidates(args({ intents: [], reserve: [reserve] }))), {},
      "on: the ladder reserve is never a WTS surplus");
    const more = args({ intents: [], reserve: [reserve] });
    more.stationsData = [station("stA", SAMINER, { minerals: sum(minerals, { "type:34": 7 }) })];
    assert.deepStrictEqual(offer(sellCandidates(more)), { "stA:type:34": 7 });
  });

  test("CL10 step 3f subtracts the minerals the kit (3c) took from "
    + "the same source (takenFrom): the convoy to Mc carries only the rest of the source stock", () => {
    const P = paramsOf(ON);
    const stock = half(recipes[CARRIER].minerals);
    const want = Object.fromEntries(Object.keys(recipes[CARRIER].minerals).sort()
      .map((k) => [k, recipes[CARRIER].minerals[k] - stock[k]]));
    const kit = Math.floor(want["type:34"] / 2);
    assert.ok(kit > 0);
    const lf = (fleetId) => ({ fleetId, version: 1, state: "IDLE", fleetRole: "logistics", systemId: NEXT,
      homeSystemId: NEXT, refitPending: false, operationId: null,
      composition: [{ hullGroup: "industrial", count: 1000 }] });
    const site = { stationId: "site1", systemId: SAMINER, state: "SUPPLYING", remaining: { "mineral/type:34": kit } };
    const s = snap([station("stA", SAMINER, { hulls: { [CRUISER]: 8 }, minerals: { ...stock } }),
      station("stS", NEXT, { lines: 1, activeJobs: [{ hullGroup: CRUISER, runs: 1 }], minerals: { ...want } })],
    [lf("lf1"), lf("lf2")], { construction: { mode: "ready", open: [site] },
      logistics: { mode: "ready", open: [], busyFleetIds: [], carriers: { lf1: 1000, lf2: 1000 }, truncated: false } });
    const reserve = ladderPlanOf(s, P).reserve;
    assert.deepStrictEqual(reserve && [reserve.stationId, reserve.minerals], ["stA", stock]);
    const logistics = { ...SVC.logistics, mineralSurplusThreshold: 0, mineralConvoyMinLoad: 1, minLoadVolume: 1,
      maxDispatchesPerReview: 2 };
    const out = planLogistics(s, { frontTargets: [], affordable: { resourceUnits: 10000, reserveUnits: 1000 } },
      { ...P, logistics }, { intents: [], reserve: [reserve] }, createHullLedger(s, P), null).intents
      .filter((i) => i.type === "CONVOY_DISPATCH")
      .map((i) => [i.purpose, i.sourceStationId, i.destStationId,
        Object.fromEntries(i.items.map((x) => [x.itemKey, x.quantity]))]);
    assert.deepStrictEqual(out, [["CONSTRUCTION", "stS", "site1", { "type:34": kit }],
      ["MINERALS_TO_FACTORY", "stS", "stA", Object.fromEntries(Object.keys(want).filter((k) => want[k] > 0)
        .map((k) => [k, k === "type:34" ? want[k] - kit : want[k]]))]]);
  });

  test("CL11 a titan fee above the full day room: balance >= fee -> PRODUCE titan "
    + "ladder:true with LADDER_OVER_ROOM:titan; balance < fee -> no ladder PRODUCE, no reserve (the cruiser gets the "
    + "minerals), LADDER_FEE_UNREACHABLE:titan", () => {
    const W = titanWorld();
    const capFull = Math.floor((W.daily * W.T.productionRoomSharePermille) / 1000);
    assert.ok(capFull < W.fee, `${capFull} >= ${W.fee}`);
    const rich = decideReview(W.snapOf(W.full, 10 * W.fee), paramsOf(ON, { treasury: W.T }));
    assert.strictEqual(rich.outcome, "REVIEWED", JSON.stringify(rich.notes));
    assert.deepStrictEqual(brief(rich)[0], [0, "stA", TITAN, 1, true], JSON.stringify(rich.notes));
    assert.ok(rich.notes.includes(`LADDER_OVER_ROOM:${TITAN}`), rich.notes.join());
    assert.ok(!rich.notes.some((n) => n.startsWith("LADDER_WAR_ROOM_SHORT:")), rich.notes.join());

    for (const minerals of [W.full, W.halfTitan]) {
      const poor = decideReview(W.snapOf(minerals, W.fee - 1), paramsOf(ON, { treasury: W.T }));
      assert.strictEqual(poor.outcome, "REVIEWED", JSON.stringify(poor.notes));
      assert.ok(poor.notes.includes(`LADDER_FEE_UNREACHABLE:${TITAN}`), poor.notes.join());
      assert.ok(!poor.notes.some((n) => /^LADDER_(PRODUCE|SAVING|WAR_ROOM_SHORT|FEE_SHORT):/.test(n)),
        poor.notes.join());
      assert.ok(!produces(poor).some((i) => i.ladder === true));
      assert.ok(produces(poor).some((i) => i.stationId === "stA" && i.hullGroup === CRUISER),
        JSON.stringify(brief(poor)));
    }
    const offHalf = decideReview(W.snapOf(W.halfTitan, W.fee - 1),
      paramsOf({ ...ON, ladderOverRoomEnabled: false }, { treasury: W.T }));
    assert.deepStrictEqual(brief(offHalf), [], offHalf.notes.join());
  });

  test("CL12 capFull >= fee (an empire budget): decideReview deepStrictEqual with the flag on "
    + "and off, also with a used-up day room (LADDER_WAR_ROOM_SHORT)", () => {
    const W = titanWorld(20);
    const capFull = Math.floor((W.daily * W.T.productionRoomSharePermille) / 1000);
    assert.ok(capFull >= W.fee, `${capFull} < ${W.fee}`);
    const on = paramsOf(ON, { treasury: W.T });
    const off = paramsOf({ ...ON, ladderOverRoomEnabled: false }, { treasury: W.T });
    const fresh = W.snapOf(W.full, 10 * W.fee);
    assert.deepStrictEqual(decideReview(fresh, on), decideReview(fresh, off));
    assert.deepStrictEqual(brief(decideReview(fresh, on))[0], [0, "stA", TITAN, 1, true]);
    const spent = W.snapOf(W.full, 10 * W.fee, { warSpend: 0, productionFees: W.daily, tradeOut: 0, losses: 0 });
    const d = decideReview(spent, on);
    assert.deepStrictEqual(d, decideReview(spent, off));
    assert.ok(d.notes.includes(`LADDER_WAR_ROOM_SHORT:${TITAN}`), d.notes.join());
  });

  test("CL13 flag off on the CL11 snapshot = before byte for byte: LADDER_WAR_ROOM_SHORT:titan "
    + "and the reserve (the same decision as the params without the new key)", () => {
    const W = titanWorld();
    const s = () => W.snapOf(W.full, 10 * W.fee);
    const off = paramsOf({ ...ON, ladderOverRoomEnabled: false }, { treasury: W.T });
    const { ladderOverRoomEnabled, ...noKey } = off.production;
    assert.strictEqual(ladderOverRoomEnabled, false);
    const d = decideReview(s(), off);
    assert.deepStrictEqual(d, decideReview(s(), { ...off, production: noKey }));
    assert.ok(d.notes.includes(`LADDER_WAR_ROOM_SHORT:${TITAN}`), d.notes.join());
    assert.ok(!d.notes.some((n) => n.startsWith("LADDER_OVER_ROOM:") || n.startsWith("LADDER_FEE_UNREACHABLE:")));
    assert.ok(!produces(d).some((i) => i.ladder === true));
  });
};

const TITAN = "titan";
function titanWorld(budgetFees = 1) {
  const base = serviceOf({ EVEJS_LNE_TREASURY_ENABLED: "1", EVEJS_LNE_TREASURY_PRESSURE_ENABLED: "1",
    EVEJS_LNE_TREASURY_WAR_ROOM_ROLLING_ENABLED: "1" }).params.treasury;
  assert.ok(base && base.pressureEnabled === true && base.warRoomRollingEnabled === true, JSON.stringify(base));
  const valueByGroup = { [TITAN]: 1e12, [CRUISER]: 10000000 };
  const fee = feeOf(1, valueByGroup[TITAN], base.productionFeePermille);
  const daily = fee * budgetFees;
  const T = { ...base, savingsDrawPermillePerDay: 0, baseIncomeIskPerDayEmpire: daily };
  const hulls = { [CRUISER]: 7, carrier: 2, dreadnought: 2, force_auxiliary: 1, supercarrier: 1 };
  const full = sum(recipes[TITAN].minerals, recipes[CRUISER].minerals);
  const halfTitan = half(recipes[TITAN].minerals);
  const snapOf = (minerals, balanceIsk, today = null) => {
    const s = snap([station("stA", SAMINER, { hulls, minerals: { ...minerals } })]);
    s.treasury = { mode: "ready", seeded: true, kind: "empire", initialIsk: 0, balanceIsk, paidUntil: AT,
      accountMode: "NORMAL", valueByGroup, today, yesterday: null };
    return s;
  };
  return { T, fee, daily, full, halfTitan, snapOf };
}
