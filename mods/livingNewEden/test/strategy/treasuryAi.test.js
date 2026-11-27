"use strict";

const assert = require("node:assert");

const { buildUniverseGraph } = require("../../lib/graph/universeGraph");
const { createRouteFinder } = require("../../lib/graph/routes");
const { HULL_GROUPS, FLEET_ROLES, OPERATION_TYPES, OBJECTIVES } = require("../../lib/fleets/schema");
const { createHostility } = require("../../lib/battle/data/hostility");
const { GROUPS } = require("../../lib/battle/data/strengthCatalog");
const { REGISTRY_DATA_V1, createFactionRegistry } = require("../../lib/strategy/registry");
const { createOperationKinds } = require("../../lib/strategy/kinds");
const { OPERATION_KINDS_VERSION, OPERATION_KINDS_V1 } = require("../../lib/strategy/data/operationKinds");
const { TARGET_SCORING_V1 } = require("../../lib/strategy/data/targetScoring");
const { buildPowerTable, strengthOf } = require("../../lib/strategy/ai/strength");
const { decideReview } = require("../../lib/strategy/ai");
const { projectTreasury, austerityParams, createFeeLedger, ladderFeeReachOf, feeOf } =
  require("../../lib/strategy/ai/treasury");
const { createHullValueTable } = require("../../lib/economy/treasury/hullValues");
const { createRecipeTable, recipeParamsOf } = require("../../lib/economy/production/recipes");
const { REF_PRICE_MILLI, HULL_VALUE_FACTOR_PERMILLE } = require("../../lib/economy/data/mineralRefPrices");
const { treasuryParamsOf } = require("../../lib/strategy/reviewService");
const RECIPES = require("../../lib/economy/data/hullRecipes");
const { k3StaticMap } = require("./fixtures/k3Cluster.fixture");
const config = require("../../config");

const MOD_DIR = require("node:path").resolve(__dirname, "..", "..");
const AMARR = 500003;
const SANSHA = 500019;
const SAMINER = 30001721;
const A_DZA8 = 30001954;
const AT = 1760000000000;
const HOUR = 3600000;

const graph = (() => {
  const built = buildUniverseGraph(k3StaticMap());
  assert.ok(built.ok);
  return Object.freeze({ ...built.graph, ...createRouteFinder(built.graph, { cacheSize: 16, maxJumps: 40 }).publicApi });
})();
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
const POWER = buildPowerTable(GROUPS);
const THEATRE = [...registry.getCampaign("k3-stain").systemIds].sort((a, b) => a - b);
const hostility = createHostility();
const COMP = Object.freeze([{ hullGroup: "cruiser", typeId: null, count: 4 }]);

const TREASURY = treasuryParamsOf(config.resolveConfig({ modDir: MOD_DIR,
  env: { EVEJS_LNE_TREASURY_ENABLED: "1" } }).config);
const VALUES = (() => {
  const c = config.resolveConfig({ modDir: MOD_DIR, env: {} }).config;
  return createHullValueTable(createRecipeTable(RECIPES, recipeParamsOf(c.production)), REF_PRICE_MILLI,
    HULL_VALUE_FACTOR_PERMILLE).all();
})();
const PROD = Object.freeze({ maxJobsPerReview: 8, maxRunsPerJob: 2, maxActiveJobsPerFaction: 64, targetStockFleets: 4,
  mobilizeHulls: "legacy", miningNeedsHulls: false, mobilizationStations: 1, hullGroups: [...HULL_GROUPS] });
const PARAMS = Object.freeze({ maxReachJumps: 10, supplyChainJumps: 10, captureRangeFromStationJumps: 5,
  maxAssemblyJumps: 15, maxBfsSystems: 2000, maxTargetCandidates: 40, targetPickTopK: 3, maxOperationsPerReview: 1,
  maxFleetsPerOperation: 4, maxFleetsPerFaction: 12, maxMobilizationsPerReview: 2, mobilizeResourcePerShip: 10,
  mobilizeReservePerShip: 1, attackStrengthRatio: 1.2, intelTtlMs: 6 * HOUR, maxObservationsPerReview: 8,
  reconWindowMs: HOUR / 2, attackWindowMs: 2 * HOUR, operationGraceMs: HOUR, maxHousekeepingPerReview: 4,
  maxRefitRequestsPerReview: 2, kinds: kinds.list, scoring: TARGET_SCORING_V1, powerTable: POWER, frontLimitCap: 2,
  routeMaxJumps: 40, maxCapturedSystemsPerFaction: 24, captureRequiresAdjacency: true,
  defense: { enabled: true, maxPerReview: 1 }, maxThreatsRead: 32, maxLostHomeRead: 32, production: PROD,
  treasury: TREASURY });

const recipes = Object.fromEntries(Object.entries(RECIPES.GROUPS).map(([g, r]) => [g, { minerals: r.minerals }]));
const plenty = () => Object.fromEntries(Object.keys(RECIPES.GROUPS).flatMap((g) => Object.keys(RECIPES.GROUPS[g]
  .minerals)).map((k) => [k, 1e12]));

const treasuryOf = (accountMode, extra = {}) => ({ mode: "ready", seeded: true, kind: "empire", initialIsk: 5e12,
  balanceIsk: 4e11, accountMode, paidUntil: AT - HOUR, valueByGroup: VALUES, tradeHeldIsk: 0, tradeEligible: true,
  factionTradeOutToday: 0, galaxyTradeOutToday: 0, ...extra });

function snap(o = {}) {
  const entry = registry.getFaction(AMARR);
  const doctrine = registry.getDoctrine(entry.doctrineId);
  const controllers = new Map(THEATRE.map((id) => [id, SANSHA]));
  const ids = [...new Set([...THEATRE, SAMINER])].sort((a, b) => a - b);
  const s = {
    v: 1, factionId: AMARR, round: 7, at: AT, seed: 12345,
    faction: { status: "ACTIVE", homeSystemId: entry.hqSystemId, doctrineId: doctrine.doctrineId,
      resourceUnits: 20000, reserveUnits: 300, frontLimit: 1, version: 3 },
    entry: { kind: entry.kind, maxActiveFronts: entry.maxActiveFronts, allies: [...entry.allies],
      homeRegionIds: [...entry.homeRegionIds], ownerCorporationId: entry.ownerCorporationId },
    doctrine: { doctrineId: doctrine.doctrineId, canOccupy: doctrine.canOccupy,
      operationTypes: [...doctrine.operationTypes], reachJumps: doctrine.reachJumps, templates: doctrine.templates,
      fieldsDefense: doctrine.fieldsDefense, captureTargets: doctrine.captureTargets },
    theatre: THEATRE,
    neighbors: (id) => graph.getNeighbors(id),
    regionOf: (id) => (graph.getSystem(id) ? graph.getSystem(id).regionId : null),
    isHostile: (x) => x !== AMARR && !entry.allies.includes(x) && hostility(AMARR, x),
    stationsMode: "ready",
    stations: [{ systemId: SAMINER, stationId: "st0" }],
    captureAnchors: [SAMINER],
    systems: ids.map((systemId) => ({ systemId, controllerFactionId: controllers.has(systemId)
      ? controllers.get(systemId) : null, occupationState: "STABLE", controllerGarrison: 0, hostileStations: 0,
    observed: false, homeFactionId: o.lostHome === systemId ? AMARR : null })),
    fleets: o.fleets || [], fleetsTruncated: false, operations: [], operationsTruncated: false,
    intel: [], sightings: [],
    threats: o.threats || { mode: "off", items: [] },
    lostHome: o.lostHome ? { mode: "ready", systemIds: [o.lostHome] } : { mode: "off", systemIds: [] },
    capturedIds: [],
    upkeep: { mode: "off" },
    territoryTruncated: false,
    occupations: [],
    production: { mode: "ready", recipesVersion: 1, recipes, inProduction: {}, activeJobsTotal: 0, truncated: false,
      stations: [{ stationId: "st0", systemId: SAMINER, kind: "npc", lines: 16, activeJobs: [], minerals: plenty(),
        hulls: {} }] },
  };
  if (o.treasury !== undefined) s.treasury = o.treasury;
  return s;
}

const fleet = (fleetId, systemId) => ({ fleetId, version: 1, state: "IDLE", fleetRole: "invasion", systemId,
  refitPending: false, shipCount: 4, strength: strengthOf(COMP, POWER), operationId: null, legSeq: 0,
  homeSystemId: systemId, composition: COMP });
const THREAT = Object.freeze({ mode: "ready", items: [{ systemId: A_DZA8, state: "INVASION", occupier: SANSHA,
  occupierStrength: 1000, phaseDueAt: AT + HOUR }], truncated: false });
const launches = (d) => d.intents.filter((i) => i.type === "LAUNCH");
const produces = (d) => d.intents.filter((i) => i.type === "PRODUCE");
const treasuryIntent = (d) => d.intents.find((i) => i.type === "TREASURY");

module.exports = ({ test }) => {
  test("TA3 faction-isk-economy-2 AUSTERITY in decideReview: no offensive LAUNCH (canOpenFront false), defense "
    + "LAUNCH stays, PRODUCE <= 4, industry 2 -> 1, tradeWantIsk 0; lost home in reach -> LAUNCH on it", () => {
    const base = { fleets: [fleet("f1", SAMINER), fleet("f2", SAMINER)], threats: THREAT };
    const normal = decideReview(snap({ ...base, treasury: treasuryOf("NORMAL") }), PARAMS);
    const poor = decideReview(snap({ ...base, treasury: treasuryOf("AUSTERITY") }), PARAMS);
    assert.deepStrictEqual([normal.outcome, poor.outcome], ["REVIEWED", "REVIEWED"], `${normal.reason} ${poor.reason}`);
    assert.ok(launches(normal).some((l) => l.kind !== "defense"), JSON.stringify(normal.notes));
    assert.ok(produces(normal).length > 4, `normal jobs ${produces(normal).length}`);
    assert.ok(treasuryIntent(normal).tradeWantIsk > 0);
    assert.strictEqual(normal.supply.canOpenFront, true);

    assert.strictEqual(poor.supply.canOpenFront, false);
    assert.deepStrictEqual(launches(poor).map((l) => [l.kind, l.target.systemId]), [["defense", A_DZA8]],
      JSON.stringify(poor.notes));
    assert.strictEqual(poor.intents.filter((i) => i.type === "MOBILIZE").length, 0, "no offensive mobilization");
    const jobs = produces(poor).length;
    assert.ok(jobs >= 1 && jobs <= Math.max(1, Math.floor(8 * 0.5)), `austerity jobs ${jobs}`);
    assert.strictEqual(treasuryIntent(poor).tradeWantIsk, 0);
    assert.ok(poor.notes.includes("TREASURY_AUSTERITY"), JSON.stringify(poor.notes));
    const proj = projectTreasury(snap({ treasury: treasuryOf("AUSTERITY") }), PARAMS);
    const withIndustry = { ...PARAMS, industry: { maxIndustryJobsPerReview: 2 } };
    assert.deepStrictEqual([austerityParams(withIndustry, proj).industry.maxIndustryJobsPerReview,
      austerityParams({ ...PARAMS, industry: { maxIndustryJobsPerReview: 1 } }, proj).industry.maxIndustryJobsPerReview,
      austerityParams({ ...PARAMS, industry: { maxIndustryJobsPerReview: 0 } }, proj).industry.maxIndustryJobsPerReview,
      austerityParams(withIndustry, proj).production.maxJobsPerReview], [1, 1, 0, 4]);
    const normalProj = projectTreasury(snap({ treasury: treasuryOf("NORMAL") }), PARAMS);
    assert.strictEqual(austerityParams(withIndustry, normalProj), withIndustry);

    const home = decideReview(snap({ fleets: base.fleets, lostHome: A_DZA8, treasury: treasuryOf("AUSTERITY") }),
      PARAMS);
    assert.deepStrictEqual(launches(home).map((l) => l.target.systemId), [A_DZA8], JSON.stringify(home.notes));
  });

  test("TA4a faction-isk-economy-2 fee ledger: projected 0 -> one PRODUCE at 1 run (minJobsWhenBroke), the rest "
    + "out (TREASURY_FEE_BROKE once); a partial balance cuts the runs; one ledger for production and industry", () => {
    const cruiser = feeOf(1, VALUES.cruiser, 100);
    const battleship = feeOf(1, VALUES.battleship, 100);
    assert.ok(cruiser > 0 && battleship > cruiser);
    const produce = (hullGroup, runs) => ({ type: "PRODUCE", stationId: "st0", hullGroup, runs });
    const plan = { intents: [produce("cruiser", 3), produce("battleship", 1), produce("frigate", 2)], notes: ["X"] };
    const broke = projectTreasury(snap({ treasury: treasuryOf("AUSTERITY", { balanceIsk: 0, paidUntil: AT }) }),
      PARAMS);
    assert.strictEqual(broke.projectedIsk, 0);
    const ledger = createFeeLedger(broke);
    const a = ledger.cap(plan);
    assert.deepStrictEqual(a.intents.map((i) => [i.hullGroup, i.runs]), [["cruiser", 1]]);
    assert.deepStrictEqual(a.notes, ["X", "TREASURY_FEE_BROKE"]);
    const b = ledger.cap({ intents: [produce("industrial", 1)], notes: [] });
    assert.deepStrictEqual([b.intents, b.notes], [[], []]);

    const part = createFeeLedger({ ...broke, projectedIsk: Math.floor(2.5 * cruiser) }).cap(plan);
    assert.deepStrictEqual(part.intents.map((i) => [i.hullGroup, i.runs]).slice(0, 1), [["cruiser", 2]]);
    assert.ok(part.notes.includes("TREASURY_FEE_CUT:cruiser") && !part.intents.some((i) => i.hullGroup === "battleship"),
      JSON.stringify(part));
    const rich = createFeeLedger({ ...broke, projectedIsk: 1e15 }).cap(plan);
    assert.deepStrictEqual(rich, plan);
    assert.strictEqual(createFeeLedger(null).cap(plan), plan);
  });

  test("TA4b: balance 5e12, war room 0 -> TREASURY_WAR_ROOM_FEE_CAP (no TREASURY_FEE_BROKE) "
    + "ladder LADDER_WAR_ROOM_SHORT; balance 0 without a war cap -> TREASURY_FEE_BROKE; intents as with the old min",
  () => {
    const produce = (hullGroup, runs) => ({ type: "PRODUCE", stationId: "st0", hullGroup, runs });
    const plan = { intents: [produce("cruiser", 3), produce("battleship", 1), produce("frigate", 2)], notes: ["X"] };
    const base = projectTreasury(snap({ treasury: treasuryOf("AUSTERITY", { balanceIsk: 0, paidUntil: AT }) }),
      PARAMS);
    const rich = { ...base, projectedIsk: 5e12 };
    const cruiser = feeOf(1, VALUES.cruiser, 100);
    const old = (proj, cap) => createFeeLedger({ ...proj, projectedIsk: Math.min(proj.projectedIsk, cap) });
    for (const cap of [0, Math.floor(2.5 * cruiser)]) {
      const now = createFeeLedger(rich, cap).cap(plan);
      const before = old(rich, cap).cap(plan);
      assert.deepStrictEqual(now.intents, before.intents, `cap ${cap}`);
      assert.ok(!now.notes.includes("TREASURY_FEE_BROKE"), now.notes.join());
      assert.ok(now.notes.includes("TREASURY_WAR_ROOM_FEE_CAP"), now.notes.join());
      assert.strictEqual(now.notes.filter((n) => n === "TREASURY_WAR_ROOM_FEE_CAP").length, 1);
      assert.ok(before.notes.includes("TREASURY_FEE_BROKE"), before.notes.join());
    }
    const ladder = { ...produce("carrier", 1), ladder: true };
    const lad = createFeeLedger({ ...rich, valueByGroup: { ...rich.valueByGroup, carrier: 1e9 } }, 0)
      .cap({ intents: [ladder], notes: [] });
    assert.deepStrictEqual([lad.intents, lad.notes], [[], ["LADDER_WAR_ROOM_SHORT:carrier"]]);
    for (const cap of [null, 1e15]) {
      const poor = createFeeLedger(base, cap).cap(plan);
      assert.deepStrictEqual(poor.intents, old(base, cap === null ? Infinity : cap).cap(plan).intents);
      assert.deepStrictEqual(poor.notes, ["X", "TREASURY_FEE_BROKE"]);
    }
  });

  test("TA4c: capOverRoom pays a ladder PRODUCE from the balance past the war room "
    + "(used() + fee, room -> 0: the next subcap via minJobsWhenBroke), passes a non-ladder intent, a balance below "
    + "the fee -> LADDER_FEE_UNREACHABLE; ladderFeeReachOf ROOM / BALANCE / UNREACHABLE / null", () => {
    const base = projectTreasury(snap({ treasury: treasuryOf("AUSTERITY", { balanceIsk: 0, paidUntil: AT }) }),
      PARAMS);
    const proj = { ...base, projectedIsk: 5e12, valueByGroup: { ...base.valueByGroup, titan: 1e12 } };
    const fee = feeOf(1, 1e12, proj.feePermille);
    const cruiser = feeOf(1, VALUES.cruiser, proj.feePermille);
    assert.ok(fee > 0 && cruiser > 0 && proj.minJobsWhenBroke >= 1);
    const titan = { type: "PRODUCE", stationId: "st0", hullGroup: "titan", runs: 1, ladder: true };
    const sub = { type: "PRODUCE", stationId: "st0", hullGroup: "cruiser", runs: 1 };
    const ledger = createFeeLedger(proj, Math.floor(fee / 2));
    const over = ledger.capOverRoom({ intents: [sub, titan], notes: ["X"] });
    assert.deepStrictEqual(over, { intents: [sub, titan], notes: ["X", "LADDER_OVER_ROOM:titan"] });
    assert.strictEqual(ledger.used(), fee);
    const next = ledger.cap({ intents: [{ ...sub, runs: 3 }, { ...sub, hullGroup: "battleship" }], notes: [] });
    assert.deepStrictEqual(next.intents.map((i) => [i.hullGroup, i.runs]), [["cruiser", 1]]);
    assert.deepStrictEqual(next.notes, ["TREASURY_WAR_ROOM_FEE_CAP"]);
    assert.strictEqual(ledger.used(), fee + cruiser);

    const poor = createFeeLedger({ ...proj, projectedIsk: fee - 1 }, 0);
    assert.deepStrictEqual(poor.capOverRoom({ intents: [titan], notes: [] }),
      { intents: [], notes: ["LADDER_FEE_UNREACHABLE:titan"] });
    assert.strictEqual(poor.used(), 0);
    assert.strictEqual(createFeeLedger(null).capOverRoom(over), over);

    const T = { productionRoomSharePermille: 500 };
    assert.deepStrictEqual([ladderFeeReachOf(proj, { dayBudget: 2 * fee }, "titan", T),
      ladderFeeReachOf(proj, { dayBudget: fee }, "titan", T),
      ladderFeeReachOf({ ...proj, projectedIsk: fee - 1 }, { dayBudget: fee }, "titan", T),
      ladderFeeReachOf(proj, null, "titan", T), ladderFeeReachOf(null, { dayBudget: fee }, "titan", T),
      ladderFeeReachOf(proj, { dayBudget: fee }, "unknown_group", T)],
    ["ROOM", "BALANCE", "UNREACHABLE", null, null, null]);
  });

  test("TA4d: a ladder fee from the balance keeps the AUSTERITY entry floor: "
    + "projectedIsk = fee + F - 1 -> UNREACHABLE / LADDER_FEE_UNREACHABLE, fee + F -> BALANCE / LADDER_OVER_ROOM; "
    + "projectTreasury austerityEnterIsk = initialIsk x austerityEnterPermille / 1000", () => {
    const base = projectTreasury(snap({ treasury: treasuryOf("AUSTERITY", { balanceIsk: 0, paidUntil: AT }) }),
      PARAMS);
    assert.ok(TREASURY.austerityEnterPermille > 0, "austerityEnterPermille in params.treasury");
    assert.strictEqual(base.austerityEnterIsk, Math.floor((5e12 * TREASURY.austerityEnterPermille) / 1000));
    const F = 1e9;
    const proj = { ...base, austerityEnterIsk: F, valueByGroup: { ...base.valueByGroup, titan: 1e12 } };
    const fee = feeOf(1, 1e12, proj.feePermille);
    assert.ok(fee > 0);
    const titan = { type: "PRODUCE", stationId: "st0", hullGroup: "titan", runs: 1, ladder: true };
    const T = { productionRoomSharePermille: 500 };
    const war = { dayBudget: fee };
    assert.deepStrictEqual([ladderFeeReachOf({ ...proj, projectedIsk: fee + F - 1 }, war, "titan", T),
      ladderFeeReachOf({ ...proj, projectedIsk: fee + F }, war, "titan", T)], ["UNREACHABLE", "BALANCE"]);

    const short = createFeeLedger({ ...proj, projectedIsk: fee + F - 1 }, 0);
    assert.deepStrictEqual(short.capOverRoom({ intents: [titan], notes: [] }),
      { intents: [], notes: ["LADDER_FEE_UNREACHABLE:titan"] });
    assert.strictEqual(short.used(), 0);
    const enough = createFeeLedger({ ...proj, projectedIsk: fee + F }, 0);
    assert.deepStrictEqual(enough.capOverRoom({ intents: [titan], notes: [] }),
      { intents: [titan], notes: ["LADDER_OVER_ROOM:titan"] });
    assert.strictEqual(enough.used(), fee);
  });

  test("TA5a faction-isk-economy-2 treasury off -> decideReview deepStrictEqual with the snapshot without treasury",
    () => {
      const base = { fleets: [fleet("f1", SAMINER), fleet("f2", SAMINER)], threats: THREAT };
      const off = { ...PARAMS, treasury: null };
      const plain = decideReview(snap(base), off);
      assert.strictEqual(plain.outcome, "REVIEWED");
      assert.deepStrictEqual(decideReview(snap({ ...base, treasury: treasuryOf("AUSTERITY") }), off), plain);
      assert.deepStrictEqual(decideReview(snap({ ...base, treasury: { mode: "off" } }), PARAMS), plain);
    });
};
