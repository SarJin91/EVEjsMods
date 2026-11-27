"use strict";

const assert = require("node:assert");
const path = require("node:path");

const { planMineralSwap, SWAP_ROWS } = require("../../lib/strategy/ai/mineralSwap");
const { PRODUCTION_START_ROWS } = require("../../lib/strategy/reviewRows");
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
const { createReviewService } = require("../../lib/strategy/reviewService");
const { createRecipeTable, recipeParamsOf } = require("../../lib/economy/production/recipes");
const RECIPES = require("../../lib/economy/data/hullRecipes");
const { k3StaticMap } = require("./fixtures/k3Cluster.fixture");
const { createRng } = require("../../lib/util/rng");
const config = require("../../config");
const { harness: H } = require("../battle/settlement.test");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const HOUR = 3600000;
const AT = 1760000000000;
const AMARR = 500003;
const SANSHA = 500019;
const SAMINER = 30001721;
const TRIT = "type:34";
const PYE = "type:35";
const MEGA = "type:40";
const ON_ENV = { EVEJS_LNE_MINERAL_SWAP_ENABLED: "1" };

function serviceOf(env = {}) {
  const resolved = config.resolveConfig({ modDir: MOD_DIR, env });
  assert.deepStrictEqual(resolved.errors || [], []);
  return createReviewService({ store: {}, journal: {}, strategyRepository: { limits: { maxResourceUnits: 1 } },
    intelRepository: {}, registry: {}, kinds: { list: [], get: () => null }, powerTable: {}, scoring: {},
    scheduler: {}, fleets: {}, clock: { now: () => 0 }, worldSeed: 1, config: resolved.config, hostility: () => true,
    isCampaignOk: () => true, industryCatalog: {} });
}

const DEF = config.resolveConfig({ modDir: MOD_DIR, env: {} }).config;
const OFF = serviceOf().params;
const ON = serviceOf(ON_ENV).params;
const table = createRecipeTable(RECIPES, recipeParamsOf(DEF.production));
const recipes = Object.fromEntries(HULL_GROUPS.map((g) => [g, { minerals: table.lookup(g).minerals }]));
const ROR = recipes.rorqual.minerals;

function caldari(minerals = {}) {
  const m = Object.fromEntries(Object.keys(ROR).map((k) => [k, ROR[k] * 2]));
  Object.assign(m, { [TRIT]: 9062823464, [PYE]: 51305044, [MEGA]: ROR[MEGA] + 1 }, minerals);
  return { faction: { status: "ACTIVE" }, stationsMode: "ready",
    production: { mode: "ready", truncated: false, recipes,
      stations: [{ stationId: "stC", systemId: 30000142, lines: 4, activeJobs: [], minerals: m }] } };
}
const BLOCKED = { hullGroup: "rorqual", stationId: "stC" };

const ANGEL_A = "npc-60012238";
const ANGEL_B = "npc-60013069";
function angel() {
  const m = (t, p, me, i, n, z, mg) => Object.fromEntries([["type:34", t], ["type:35", p], ["type:36", me],
    ["type:37", i], ["type:38", n], ["type:39", z], ["type:40", mg]].filter(([, v]) => v > 0));
  return { faction: { status: "ACTIVE" }, stationsMode: "ready",
    production: { mode: "ready", truncated: false, recipes, stations: [
      { stationId: ANGEL_A, systemId: 30001047, lines: 4, activeJobs: [],
        minerals: m(752675021, 26826, 118416418, 74105442, 89037735, 50610597, 22380490) },
      { stationId: ANGEL_B, systemId: 30001045, lines: 4, activeJobs: [],
        minerals: m(502864200, 205437, 69742332, 46193806, 54191006, 30378481, 13443212) },
      { stationId: "st_mw4uwiov_00bu_b37a", systemId: 30001019, lines: 2, activeJobs: [], minerals: {} },
      { stationId: "npc-60012781", systemId: 30001047, lines: 4, activeJobs: [],
        minerals: m(7726444, 0, 106778, 418, 7219, 2657, 1355) },
    ] } };
}

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

function paramsOf(svc, production = {}) {
  return { maxReachJumps: 10, supplyChainJumps: 10, captureRangeFromStationJumps: 5,
    maxAssemblyJumps: 15, maxBfsSystems: 2000, maxTargetCandidates: 40, targetPickTopK: 3, maxOperationsPerReview: 1,
    maxFleetsPerOperation: 4, maxFleetsPerFaction: 12, maxMobilizationsPerReview: 2, mobilizeResourcePerShip: 10,
    mobilizeReservePerShip: 1, attackStrengthRatio: 1.2, intelTtlMs: 6 * HOUR, maxObservationsPerReview: 8,
    reconWindowMs: HOUR / 2, attackWindowMs: 2 * HOUR, operationGraceMs: HOUR, maxHousekeepingPerReview: 4,
    maxRefitRequestsPerReview: 2, kinds: kinds.list, scoring: TARGET_SCORING_V1, powerTable: buildPowerTable(GROUPS),
    frontLimitCap: 2, routeMaxJumps: 40, maxCapturedSystemsPerFaction: 24, captureRequiresAdjacency: true,
    defense: { enabled: true, maxPerReview: 1 }, maxThreatsRead: 32, maxLostHomeRead: 32,
    production: { ...svc.production, mobilizationStations: 1, ...production }, industry: svc.industry,
    mineralSwap: svc.mineralSwap };
}
const miner = (fleetId, home) => ({ fleetId, version: 1, state: "IDLE", fleetRole: "mining", systemId: THEATRE[0],
  homeSystemId: home, refitPending: false, shipCount: 3, strength: 1, operationId: null, legSeq: 0,
  composition: [{ hullGroup: "mining_frigate", typeId: null, count: 3 }] });

function amarr(extra = {}) {
  const entry = registry.getFaction(AMARR);
  const doctrine = registry.getDoctrine(entry.doctrineId);
  const ids = [...new Set([...THEATRE, SAMINER, NEXT])].sort((a, b) => a - b);
  const minerals = {};
  for (const g of ["mining_barge", "cruiser"]) {
    for (const k of Object.keys(recipes[g].minerals)) minerals[k] = (minerals[k] || 0) + recipes[g].minerals[k];
  }
  Object.assign(minerals, extra);
  const stations = [{ stationId: "stA", systemId: SAMINER, kind: "npc", lines: 4, activeJobs: [], minerals,
    hulls: { porpoise: 1 } }];
  return {
    v: 1, factionId: AMARR, round: 7, at: AT, seed: 12345,
    faction: { status: "ACTIVE", homeSystemId: entry.hqSystemId, doctrineId: doctrine.doctrineId,
      resourceUnits: 20000, reserveUnits: 300, frontLimit: 1, version: 3 },
    entry: { kind: entry.kind, maxActiveFronts: entry.maxActiveFronts, allies: [...entry.allies],
      homeRegionIds: [...entry.homeRegionIds], ownerCorporationId: entry.ownerCorporationId },
    doctrine: { doctrineId: doctrine.doctrineId, canOccupy: doctrine.canOccupy,
      operationTypes: [...doctrine.operationTypes], reachJumps: doctrine.reachJumps,
      templates: { invasion: [{ hullGroup: "cruiser", count: 4 }], mining: [{ hullGroup: "mining_frigate", count: 3 }] },
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
    fleets: [miner("m1", SAMINER)], fleetsTruncated: false, operations: [], operationsTruncated: false, intel: [],
    sightings: [], threats: { mode: "off", items: [] }, lostHome: { mode: "off", systemIds: [] }, capturedIds: [],
    upkeep: { mode: "off" }, territoryTruncated: false, occupations: [],
    production: { mode: "ready", recipesVersion: table.version, recipes, inProduction: {},
      activeJobsTotal: 0, truncated: false, stations },
  };
}

module.exports = ({ test, skip }) => {
  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  test("S1 Caldari rorqual: Pye binding (Megacyte small, 1 run) -> take = the Pye of one run, give = ceil(take "
    + "x 18960 x 1000 / (3780 x 800)) Trit (BigInt), note MINERAL_SWAP:Pyerite", () => {
    const P = ON.mineralSwap;
    assert.deepStrictEqual([P.spreadPermille, P.pricesMilli[TRIT], P.pricesMilli[PYE]], [200, 3780, 18960]);
    const out = planMineralSwap(caldari(), { intents: [] }, BLOCKED, [], P, 4);
    const take = ROR[PYE] - 51305044;
    const give = (BigInt(take) * 18960n * 1000n + 3780n * 800n - 1n) / (3780n * 800n);
    assert.deepStrictEqual([take, Number(give)], [96504956, 605070756]);
    assert.deepStrictEqual(out, { intents: [{ type: "MINERAL_SWAP", stationId: "stC", systemId: 30000142,
      hullGroup: "rorqual", give: { itemKey: TRIT, quantity: 605070756 }, take: { itemKey: PYE, quantity: take },
      priceVersion: P.priceVersion }], notes: ["MINERAL_SWAP:Pyerite"] });
    const fromNote = planMineralSwap(caldari(), { intents: [] }, null,
      ["PRODUCTION_NO_MINERALS:rorqual", "PRODUCTION_NO_MINERALS:rorqual"], P, 4);
    assert.deepStrictEqual(fromNote, out);
  });

  test("S2 every mineral below minSourceUnits -> no intent, note MINERAL_SWAP_NO_SOURCE:rorqual", () => {
    const out = planMineralSwap(caldari({ [TRIT]: 999999999 }), { intents: [] }, BLOCKED, [],
      { ...ON.mineralSwap, minSourceUnits: 1000000000 }, 4);
    assert.deepStrictEqual(out, { intents: [], notes: ["MINERAL_SWAP_NO_SOURCE:rorqual"] });
  });

  test("S6 Angel of [6] (A Trit 752 m Pye 26 826, B 502 m Pye 205 437, C upwell empty, D 7.7 m): 1 bn "
    + "-> no intent, MINERAL_SWAP_NO_SOURCE:cruiser; default 20 m -> one swap on A, take = the Pye of one cruiser run",
  () => {
    assert.strictEqual(DEF.mineralSwap.minSourceUnits, 20000000);
    assert.strictEqual(ON.mineralSwap.minSourceUnits, 20000000);
    const pyeCruiser = recipes.cruiser.minerals[PYE];
    assert.strictEqual(pyeCruiser - 26826, 153174);
    const out1 = planMineralSwap(angel(), { intents: [] }, null, ["PRODUCTION_NO_MINERALS:cruiser"],
      { ...ON.mineralSwap, minSourceUnits: 1000000000 }, 4);
    assert.deepStrictEqual(out1, { intents: [], notes: ["MINERAL_SWAP_NO_SOURCE:cruiser"] });
    const out = planMineralSwap(angel(), { intents: [] }, null, ["PRODUCTION_NO_MINERALS:cruiser"], ON.mineralSwap, 4);
    assert.strictEqual(out.intents.length, 1, JSON.stringify(out));
    const x = out.intents[0];
    assert.deepStrictEqual([x.type, x.stationId, x.hullGroup, x.give.itemKey, x.take.itemKey, x.take.quantity],
      ["MINERAL_SWAP", ANGEL_A, "cruiser", "type:39", PYE, 153174]);
    assert.deepStrictEqual(out.notes, ["MINERAL_SWAP:Pyerite"]);
  });

  test("S7 battlecruiser blocked on A and B: ladderStationId A -> the swap on B; absent -> on A; A the only "
    + "source station and the ladder one -> on A (fallback)", () => {
    const notes = ["PRODUCTION_NO_MINERALS:battlecruiser"];
    const P = ON.mineralSwap;
    const at = (snap, produced) => planMineralSwap(snap, produced, null, notes, P, 4).intents.map((i) => i.stationId);
    assert.deepStrictEqual(at(angel(), { intents: [], ladderStationId: ANGEL_A }), [ANGEL_B]);
    assert.deepStrictEqual(at(angel(), { intents: [] }), [ANGEL_A]);
    assert.deepStrictEqual(at(angel(), { intents: [], ladderStationId: null }), [ANGEL_A]);
    const noB = angel();
    noB.production.stations = noB.production.stations.filter((s) => s.stationId !== ANGEL_B);
    assert.deepStrictEqual(at(noB, { intents: [], ladderStationId: ANGEL_A }), [ANGEL_A]);
  });

  needsDriver("S3 swapInTx on the real store: Trit -1000 / Pye +200 (counter mineralSwaps 1); give above the "
    + "stock -> INSUFFICIENT_STOCK, stock unchanged; a reused `${ik}:swap` -> NESTED_KEY_REUSED",
  () => H.withStore(driver, async (reopen) => {
    const R = require("./review.test").harness;
    const { createManualClock } = require("../../lib/util/clock");
    const { createIdGenerator } = require("../../lib/util/ids");
    const clock = createManualClock(R.START_MS);
    const shared = { clock, ids: createIdGenerator({ clock, rng: createRng(23) }), graph: R.graphOf(),
      controllers: new Map(R.THEATRE.map((id) => [id, R.SANSHA])) };
    const holder = { env: null, station: null, systemId: null, give: 0, preseed: false };
    const deltasOf = (give) => [{ itemKind: "mineral", itemKey: TRIT, delta: -give },
      { itemKind: "mineral", itemKey: PYE, delta: 200 }];
    const hooks = { beforeEffect: (d) => {
      if (d.factionId !== R.AMARR || holder.give === 0) return d;
      const list = d.intents.filter((i) => i.type !== "MINERAL_SWAP");
      const at = list.findIndex((i) => i.type === "FACTION_TOUCH");
      const index = at < 0 ? list.length : at;
      list.splice(index, 0, { type: "MINERAL_SWAP", stationId: holder.station, systemId: holder.systemId,
        hullGroup: "rorqual", give: { itemKey: TRIT, quantity: holder.give }, take: { itemKey: PYE, quantity: 200 },
        priceVersion: 1 });
      if (holder.preseed) {
        holder.preseed = false;
        const key = `strategy:review:${d.factionId}:${d.round}:${index}:MINERAL_SWAP:swap`;
        assert.ok(holder.env.tx((db) => holder.env.stations.repository.applyStockChange(db, { stationId: holder.station,
          key, reason: "MINERAL_SWAP", at: clock.now(), deltas: deltasOf(holder.give) })).ok);
      }
      d.intents = list;
      return d;
    } };
    const env = await R.bootAll(reopen(), shared, { ...ON_ENV, EVEJS_LNE_STRATEGY_MAX_REVIEWS_PER_PASS: "8",
      EVEJS_LNE_UPKEEP_ENABLED: "0" }, { hooks });
    holder.env = env;
    const row = env.q("SELECT station_id, system_id FROM world_stations WHERE owner_faction_id = ? AND state = 'ONLINE' "
      + "ORDER BY station_id", R.AMARR)[0];
    Object.assign(holder, { station: row.station_id, systemId: row.system_id });
    assert.ok(env.tx((db) => env.stations.repository.applyStockChange(db, { stationId: holder.station, key: "s3:seed",
      reason: "TEST", at: clock.now(), deltas: [{ itemKind: "mineral", itemKey: TRIT, delta: 5000 }] })).ok);
    const qty = (k) => (env.q("SELECT quantity FROM world_station_stock WHERE station_id = ? AND item_key = ?",
      holder.station, k)[0] || { quantity: 0 }).quantity;
    const status = () => env.strategy.getStatus().ai.review;

    holder.give = 1000;
    await R.passesAt(env, shared, R.START_MS + R.I);
    assert.deepStrictEqual([qty(TRIT), qty(PYE), status().counters.mineralSwaps], [4000, 200, 1]);

    holder.give = 1000000;
    await R.passesAt(env, shared, R.START_MS + 2 * R.I);
    assert.deepStrictEqual([qty(TRIT), qty(PYE), status().counters.mineralSwaps], [4000, 200, 1]);
    assert.strictEqual(status().lastRefusal, "MINERAL_SWAP:INSUFFICIENT_STOCK");

    Object.assign(holder, { give: 500, preseed: true });
    await R.passesAt(env, shared, R.START_MS + 3 * R.I);
    assert.deepStrictEqual([qty(TRIT), qty(PYE), status().counters.mineralSwaps], [3500, 400, 1]);
    assert.strictEqual(status().lastRefusal, "MINERAL_SWAP:NESTED_KEY_REUSED");
    env.strategy.stop("test");
  }));

  test("S4 slotsLeft 0 -> nothing; decideReview: the swap right after the last PRODUCE (barge blocked), none "
    + "when the PRODUCE take maxJobsPerReview; SWAP_ROWS 5 <= 1 + PRODUCTION_START_ROWS", () => {
    assert.deepStrictEqual(planMineralSwap(caldari(), { intents: [] }, BLOCKED, [], ON.mineralSwap, 0),
      { intents: [], notes: [] });
    assert.ok(SWAP_ROWS === 5 && SWAP_ROWS <= 1 + PRODUCTION_START_ROWS, `${SWAP_ROWS} ${PRODUCTION_START_ROWS}`);
    const s = amarr({ [TRIT]: 2000000000 });
    const on = decideReview(s, paramsOf(ON));
    assert.strictEqual(on.outcome, "REVIEWED", JSON.stringify(on.notes));
    const types = on.intents.map((i) => i.type);
    const swap = types.indexOf("MINERAL_SWAP");
    assert.ok(swap > 0 && types.lastIndexOf("PRODUCE") === swap - 1, JSON.stringify(types));
    const x = on.intents[swap];
    assert.deepStrictEqual([x.stationId, x.hullGroup, x.give.itemKey], ["stA", "mining_barge", TRIT],
      JSON.stringify(x));
    assert.ok(on.notes.some((n) => n.startsWith("MINERAL_SWAP:")), JSON.stringify(on.notes));
    const produce = types.filter((t) => t === "PRODUCE").length;
    const full = decideReview(amarr({ [TRIT]: 2000000000 }), paramsOf(ON, { maxJobsPerReview: produce }));
    assert.ok(!full.intents.some((i) => i.type === "MINERAL_SWAP"), JSON.stringify(full.intents.map((i) => i.type)));
  });

  test("S5 flag off: params.mineralSwap null (also on with production off); decideReview deepStrictEqual with "
    + "the params without the key", () => {
    assert.strictEqual(OFF.mineralSwap, null);
    assert.strictEqual(serviceOf({ ...ON_ENV, EVEJS_LNE_PRODUCTION_ENABLED: "0" }).params.mineralSwap, null);
    const P = paramsOf(OFF);
    const { mineralSwap: _drop, ...without } = P;
    const s = () => amarr({ [TRIT]: 2000000000 });
    const off = decideReview(s(), P);
    assert.strictEqual(off.outcome, "REVIEWED", JSON.stringify(off.notes));
    assert.deepStrictEqual(off, decideReview(s(), without));
    assert.ok(!off.intents.some((i) => i.type === "MINERAL_SWAP"));
  });
};
