"use strict";

const assert = require("node:assert");
const path = require("node:path");

const { planUpkeep, upkeepRates, shipRoomOf, shipCapOf } = require("../../lib/strategy/ai/upkeep");
const { NOTE_DICTIONARY } = require("../../lib/strategy/activity/notes");
const { createBorderIndex } = require("../../lib/strategy/border");
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
const { buildPowerTable } = require("../../lib/strategy/ai/strength");
const { decideReview } = require("../../lib/strategy/ai");
const { createReviewService } = require("../../lib/strategy/reviewService");
const { k3StaticMap } = require("./fixtures/k3Cluster.fixture");
const config = require("../../config");
const { harness: H } = require("../battle/settlement.test");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const HOUR = 3600000;
const AT = 1760000000000 - (1760000000000 % HOUR) + 1234;
const SANSHA = 500019;
const NEW_KEYS = ["homeSpaceIncomeEnabled", "homeSpaceIncomePermille", "shipCapEnabled", "shipCapMarginPermille",
  "shipCapKinds"];

const UP = Object.freeze({ periodMs: HOUR, maxCatchUpPeriods: 48, incomePerSystem: 3, incomePerStation: 10,
  reservePerStation: 2, maxReserveUnits: 1000, costPerSystem: 1, capturedCostPerSystem: 2, costPerShipPermille: 100,
  offensiveReservePeriods: 24, abandonAfterUnpaidPeriods: 24, maxAbandonsPerReview: 1, tradeIncomeSharePermille: 200,
  hoardCapPeriods: 168, maxResourceUnits: 1000000000, maxUnpaidPeriods: 1000 });
const ON_A = Object.freeze({ ...UP, homeSpaceIncomeEnabled: true, homeSpaceIncomePermille: 250 });

function caldari(o = {}) {
  const captured = Array.from({ length: 126 }, (_v, i) => ({ systemId: 30000001 + i, state: "STABLE",
    detachedSinceAt: null, factorPermille: 1000 }));
  return { factionId: 500001, round: 3, at: AT,
    faction: { status: "ACTIVE", resourceUnits: 0, reserveUnits: 0, version: 2 },
    upkeep: { mode: "ready", paidUntil: AT - (AT % HOUR) - HOUR, unpaidPeriods: 14, controlledCount: 126, captured,
      capturedTruncated: false, liveShips: o.ships === undefined ? 1070 : o.ships, stationCount: 7, tradeReady: false,
      ...(o.home === undefined ? {} : { homeSpaceSystems: o.home }) } };
}

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
const THEATRE = [...registry.getCampaign("k3-stain").systemIds].sort((a, b) => a - b);
const hostility = createHostility();
const PARAMS = Object.freeze({ maxReachJumps: 10, supplyChainJumps: 10, captureRangeFromStationJumps: 5,
  maxAssemblyJumps: 15, maxBfsSystems: 2000, maxTargetCandidates: 40, targetPickTopK: 3, maxOperationsPerReview: 1,
  maxFleetsPerOperation: 4, maxFleetsPerFaction: 12, maxMobilizationsPerReview: 2, mobilizeResourcePerShip: 10,
  mobilizeReservePerShip: 1, attackStrengthRatio: 1.2, intelTtlMs: 6 * HOUR, maxObservationsPerReview: 8,
  reconWindowMs: HOUR / 2, attackWindowMs: 2 * HOUR, operationGraceMs: HOUR, maxHousekeepingPerReview: 4,
  maxRefitRequestsPerReview: 2, kinds: kinds.list, scoring: TARGET_SCORING_V1, powerTable: buildPowerTable(GROUPS),
  frontLimitCap: 2, routeMaxJumps: 40 });

const AMARR = 500003;
const ownerOf = (id) => (THEATRE.indexOf(id) < Math.ceil(THEATRE.length / 2) ? SANSHA : AMARR);

function sansha(kind) {
  const entry = registry.getFaction(SANSHA);
  const doctrine = registry.getDoctrine(entry.doctrineId);
  const ids = [...new Set(THEATRE)].sort((a, b) => a - b);
  return {
    v: 1, factionId: SANSHA, round: 7, at: AT, seed: 12345,
    faction: { status: "ACTIVE", homeSystemId: entry.hqSystemId, doctrineId: doctrine.doctrineId,
      resourceUnits: 20000, reserveUnits: 300, frontLimit: 1, version: 3 },
    entry: { kind: kind || entry.kind, maxActiveFronts: entry.maxActiveFronts, allies: [...entry.allies],
      homeRegionIds: [...entry.homeRegionIds], ownerCorporationId: entry.ownerCorporationId },
    doctrine: { doctrineId: doctrine.doctrineId, canOccupy: doctrine.canOccupy,
      operationTypes: [...doctrine.operationTypes], reachJumps: doctrine.reachJumps, templates: doctrine.templates },
    theatre: THEATRE,
    neighbors: (id) => graph.getNeighbors(id),
    regionOf: (id) => (graph.getSystem(id) ? graph.getSystem(id).regionId : null),
    isHostile: (x) => x !== SANSHA && !entry.allies.includes(x) && hostility(SANSHA, x),
    stationsMode: "ready", stations: [{ systemId: THEATRE[0], stationId: "st0" }],
    systems: ids.map((systemId) => ({ systemId, controllerFactionId: ownerOf(systemId), occupationState: "STABLE",
      controllerGarrison: 0, hostileStations: 0, observed: false })),
    fleets: [], fleetsTruncated: false, operations: [], operationsTruncated: false, sightings: [],
    intel: ids.filter((id) => ownerOf(id) === AMARR).map((systemId) => ({ systemId, observedAt: AT - HOUR,
      hostileFleets: 0, hostileShips: 0, hostileStrength: 0, hostileStations: 0, controllerFactionId: AMARR })),
    upkeep: { mode: "ready", paidUntil: AT - (AT % HOUR), unpaidPeriods: 0, controlledCount: 0, captured: [],
      capturedTruncated: false, liveShips: 0, stationCount: 1, tradeReady: false },
  };
}
const mobilizedShips = (d) => d.intents.flatMap((i) => (i.type === "MOBILIZE" ? [i] : i.type === "LAUNCH"
  ? (i.mobilize || []) : [])).reduce((n, m) => n + (m.composition || []).reduce((x, e) => x + e.count, 0), 0);

module.exports = ({ test, skip }) => {
  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  test("U1 Caldari fixture: flag off income 448 / cost 485 / shortfall 37 / unpaid 15 (pinned); flag on with "
    + "316 home systems at 250 permille: income 527, shortfall 0, unpaidPeriodsTo 0, delta +42", () => {
    const off = planUpkeep(caldari({ home: 316 }), null, { upkeep: UP }).intents[0];
    assert.deepStrictEqual([off.income, off.cost, off.income - off.cost, off.shortfall, off.unpaidPeriodsTo],
      [448, 485, -37, 37, 15]);
    assert.strictEqual(upkeepRates(caldari(), { upkeep: UP }).homeIncome, undefined, "off: no homeIncome field");
    const plan = planUpkeep(caldari({ home: 316 }), null, { upkeep: ON_A });
    const on = plan.intents[0];
    assert.deepStrictEqual([on.income, on.cost, on.shortfall, on.unpaidPeriodsTo, on.delta], [527, 485, 0, 0, 42]);
    assert.deepStrictEqual([plan.rates.homeIncome, plan.unpaidPeriods, plan.shipRoom], [79, 0, undefined]);
    assert.deepStrictEqual(planUpkeep(caldari(), null, { upkeep: ON_A }), planUpkeep(caldari(), null, { upkeep: UP }));
  });

  test("U2 shipRoomOf: A on, margin 100: allowance 96 -> maxShips 960, room 0 at 1070 ships, 60 at 900 "
    + "costPerShipPermille 0 -> null, truncated -> 0; planUpkeep.shipRoom only with shipCapEnabled", () => {
    const P = { ...ON_A, shipCapMarginPermille: 100 };
    const roomOf = (ships, p = P, truncated = false) => {
      const s = caldari({ ships, home: 316 });
      return shipRoomOf(s.upkeep, upkeepRates(s, { upkeep: p }), p, truncated);
    };
    assert.deepStrictEqual([roomOf(1070), roomOf(900), roomOf(960), roomOf(959)], [0, 60, 0, 1]);
    assert.strictEqual(roomOf(900, { ...P, costPerShipPermille: 0 }), null);
    assert.strictEqual(roomOf(900, P, true), 0);
    const cap = { ...P, shipCapEnabled: true };
    assert.strictEqual(planUpkeep(caldari({ ships: 900, home: 316 }), null, { upkeep: cap }).shipRoom, 60);
    const truncated = { ...caldari({ ships: 900, home: 316 }), fleetsTruncated: true };
    assert.strictEqual(planUpkeep(truncated, null, { upkeep: cap }).shipRoom, 0);
  });

  test("U3 decideReview with the ship cap: room 2 -> <= 2 mobilized ships + UPKEEP_SHIP_CAP (off mobilizes "
    + "more); kind invader with the same fixture is not cut", () => {
    const up = { ...UP, costPerShipPermille: 5000, shipCapMarginPermille: 0, shipCapKinds: "empire,pirate,neutral" };
    const off = decideReview(sansha(), { ...PARAMS, upkeep: up });
    const on = decideReview(sansha(), { ...PARAMS, upkeep: { ...up, shipCapEnabled: true } });
    assert.ok(mobilizedShips(off) > 2, `off mobilizes ${mobilizedShips(off)}: ${JSON.stringify(off.notes)}`);
    assert.ok(!off.notes.includes("UPKEEP_SHIP_CAP"));
    assert.ok(mobilizedShips(on) <= 2, `${mobilizedShips(on)}: ${JSON.stringify(on.intents.map((i) => i.type))}`);
    assert.ok(on.notes.includes("UPKEEP_SHIP_CAP"), JSON.stringify(on.notes));
    assert.strictEqual(on.upkeep.shipRoom, 2);
    assert.strictEqual(off.upkeep.shipRoom, undefined, "off: no shipRoom in the panel");
    const invOff = decideReview(sansha("invader"), { ...PARAMS, upkeep: up });
    const invOn = decideReview(sansha("invader"), { ...PARAMS, upkeep: { ...up, shipCapEnabled: true } });
    assert.deepStrictEqual(invOn.intents, invOff.intents, "invader not cut");
    assert.ok(!invOn.notes.includes("UPKEEP_SHIP_CAP"));
  });

  test("U6 kind empire: ship cap without homeSpaceIncomeEnabled = no cut (pirate in U3 stays capped) "
    + "with it capped + UPKEEP_SHIP_CAP; config warns on B without A, not with A or B off", () => {
    const up = { ...UP, costPerShipPermille: 5000, shipCapMarginPermille: 0, shipCapKinds: "empire,pirate,neutral" };
    const off = decideReview(sansha("empire"), { ...PARAMS, upkeep: up });
    const noA = decideReview(sansha("empire"), { ...PARAMS, upkeep: { ...up, shipCapEnabled: true } });
    assert.ok(mobilizedShips(off) > 2, JSON.stringify(off.notes));
    assert.deepStrictEqual(noA.intents, off.intents, "empire not cut without A");
    assert.ok(!noA.notes.includes("UPKEEP_SHIP_CAP"));
    const withA = decideReview(sansha("empire"), { ...PARAMS,
      upkeep: { ...up, shipCapEnabled: true, homeSpaceIncomeEnabled: true } });
    assert.ok(mobilizedShips(withA) <= 2, `${mobilizedShips(withA)}`);
    assert.ok(withA.notes.includes("UPKEEP_SHIP_CAP"), JSON.stringify(withA.notes));
    const warned = (env) => config.resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_UPKEEP_ENABLED: "1", ...env } })
      .warnings.filter((w) => w.startsWith("upkeep.shipCapEnabled without upkeep.homeSpaceIncomeEnabled")).length;
    assert.deepStrictEqual([warned({ EVEJS_LNE_UPKEEP_SHIP_CAP_ENABLED: "1" }),
      warned({ EVEJS_LNE_UPKEEP_SHIP_CAP_ENABLED: "1", EVEJS_LNE_UPKEEP_HOME_SPACE_INCOME_ENABLED: "1" }),
      warned({ EVEJS_LNE_UPKEEP_HOME_SPACE_INCOME_ENABLED: "1" }), warned({})], [1, 0, 0, 0]);
  });

  test("SC1 shipCapOf: capped, n 4, perShip 10/1 -> scoutRoom {40, 4}; n 0 -> the result of before (no "
    + "field); not capped -> no field", () => {
    const P = (n, on = true) => ({ upkeep: { shipCapEnabled: on, shipCapKinds: "empire,pirate,neutral",
      ...(n === undefined ? {} : { shipCapScoutShips: n }) }, mobilizeResourcePerShip: 10, mobilizeReservePerShip: 1 });
    const s = { entry: { kind: "pirate" } };
    const aff = { resourceUnits: 1000, reserveUnits: 100, isk: null };
    const capped = shipCapOf(s, { shipRoom: 0 }, aff, P(4));
    assert.deepStrictEqual(capped.scoutRoom, { resourceUnits: 40, reserveUnits: 4 });
    assert.deepStrictEqual([capped.capped, capped.affordable.resourceUnits, capped.affordable.reserveUnits], [true, 0, 0]);
    const before = shipCapOf(s, { shipRoom: 0 }, aff, P(undefined));
    assert.deepStrictEqual(shipCapOf(s, { shipRoom: 0 }, aff, P(0)), before);
    assert.strictEqual("scoutRoom" in before, false);
    assert.strictEqual("scoutRoom" in shipCapOf(s, { shipRoom: 200 }, aff, P(4)), false);
    assert.strictEqual("scoutRoom" in shipCapOf(s, { shipRoom: 0 }, aff, P(4, false)), false);
    assert.deepStrictEqual(shipCapOf(s, { shipRoom: 0 }, { resourceUnits: 15, reserveUnits: 2, isk: null }, P(4))
      .scoutRoom, { resourceUnits: 15, reserveUnits: 2 });
  });

  test("SC4 decideReview with the cap at room 0, pool 4, recon flag on, no intel: LAUNCH recon with a "
    + "scout from the pool, UPKEEP_SHIP_CAP_SCOUT, no other MOBILIZE (afterNext floored, nothing negative); flag off "
    + "= the decision without the key", () => {
    const up = { ...UP, costPerShipPermille: 5000, shipCapMarginPermille: 0, shipCapKinds: "empire,pirate,neutral",
      shipCapEnabled: true };
    const s = () => {
      const x = sansha();
      return { ...x, intel: [], upkeep: { ...x.upkeep, liveShips: 2 } };
    };
    const P = { ...PARAMS, maxScoutsPerFaction: 4 };
    const on = decideReview(s(), { ...P, reconUnblockEnabled: true, upkeep: { ...up, shipCapScoutShips: 4 } });
    assert.strictEqual(on.upkeep.shipRoom, 0);
    const mobs = on.intents.flatMap((i) => (i.type === "MOBILIZE" ? [i] : i.type === "LAUNCH" ? (i.mobilize || []) : []));
    assert.ok(on.intents.some((i) => i.type === "LAUNCH" && i.kind === "recon"), JSON.stringify(on.notes));
    assert.ok(mobs.length > 0 && mobs.every((m) => m.role === "scout"), JSON.stringify(mobs));
    assert.ok(mobs.reduce((n, m) => n + m.cost.resourceUnits, 0) <= 40);
    assert.ok(on.notes.includes("UPKEEP_SHIP_CAP_SCOUT") && on.notes.includes("UPKEEP_SHIP_CAP"),
      JSON.stringify(on.notes));
    const off = decideReview(s(), { ...P, reconUnblockEnabled: false, upkeep: { ...up, shipCapScoutShips: 4 } });
    assert.deepStrictEqual(off, decideReview(s(), { ...P, reconUnblockEnabled: false, upkeep: up }));
    assert.ok(!off.notes.includes("UPKEEP_SHIP_CAP_SCOUT"));
  });

  test("SC5 note UPKEEP_SHIP_CAP_SCOUT in the dictionary; config upkeep.shipCapScoutShips in SCHEMA (default "
    + "0, clamp 0..32), warning only with > 0 and strategy.reconUnblockEnabled off", () => {
    assert.ok(NOTE_DICTIONARY.UPKEEP_SHIP_CAP_SCOUT && NOTE_DICTIONARY.UPKEEP_SHIP_CAP_SCOUT.text.length > 0);
    const row = config.SCHEMA.find((r) => r.key === "upkeep.shipCapScoutShips");
    assert.deepStrictEqual([row.default, row.min, row.max, row.env], [0, 0, 32, "EVEJS_LNE_UPKEEP_SHIP_CAP_SCOUT_SHIPS"]);
    const res = (env) => config.resolveConfig({ modDir: MOD_DIR, env });
    assert.strictEqual(res({}).config.upkeep.shipCapScoutShips, 0);
    assert.strictEqual(res({ EVEJS_LNE_UPKEEP_SHIP_CAP_SCOUT_SHIPS: "99" }).config.upkeep.shipCapScoutShips, 32);
    const warned = (env) => res(env).warnings.filter((w) => w.startsWith("upkeep.shipCapScoutShips=")).length;
    assert.deepStrictEqual([warned({ EVEJS_LNE_UPKEEP_SHIP_CAP_SCOUT_SHIPS: "4" }),
      warned({ EVEJS_LNE_UPKEEP_SHIP_CAP_SCOUT_SHIPS: "4", EVEJS_LNE_STRATEGY_RECON_UNBLOCK_ENABLED: "1" }),
      warned({})], [1, 0, 0]);
  });

  test("U4 homeSpaceCountOf: 3 highsec + 1 lowsec of f, an allied highsec and a nullsec of f -> 4 (friendly "
    + "ownSpace counts own only); cached (2 class reads); no ownSpace -> 0; no graph -> GRAPH_NOT_READY", () => {
    const F = 1;
    const ALLY = 2;
    const sys = { 1: ["highsec", F], 2: ["highsec", F], 3: ["highsec", F], 4: ["lowsec", F], 5: ["highsec", ALLY],
      6: ["nullsec", F] };
    let calls = 0;
    const g = { getSystemsBySecClass: (c) => {
      calls += 1;
      return Object.keys(sys).map(Number).filter((id) => sys[id][0] === c);
    }, getSystem: (id) => (sys[id] ? { systemId: id, secClass: sys[id][0], factionId: sys[id][1] } : null),
    getNeighbors: () => [] };
    const doctrines = { own: { ownSpace: { secClasses: ["highsec", "lowsec"], sovereignty: "friendly" } },
      none: { ownSpace: null } };
    const entries = { [F]: { doctrineId: "own", homeRegionIds: [] }, 3: { doctrineId: "none", homeRegionIds: [] } };
    const reg = { getFaction: (f) => entries[f] || null, isActive: () => true, getDoctrine: (d) => doctrines[d] };
    const index = createBorderIndex({ registry: reg, getGraph: () => g, settings: {}, hostility: () => false });
    assert.deepStrictEqual({ ...index.homeSpaceCountOf(F) }, { ok: true, count: 4 });
    assert.deepStrictEqual({ ...index.homeSpaceCountOf(F) }, { ok: true, count: 4 });
    assert.strictEqual(calls, 2, "second read from the cache");
    assert.deepStrictEqual({ ...index.homeSpaceCountOf(3) }, { ok: true, count: 0 });
    assert.deepStrictEqual({ ...index.homeSpaceCountOf(99) }, { ok: true, count: 0 });
    assert.deepStrictEqual({ ...createBorderIndex({ registry: reg, getGraph: () => null, settings: {} })
      .homeSpaceCountOf(F) }, { ok: false, reason: "GRAPH_NOT_READY" });
  });

  needsDriver("U5 params.upkeep of resolveConfig holds the 5 new keys; readUpkeep with flag A gives "
    + "snapshot.upkeep.homeSpaceSystems through the real border facade (startStrategy, migrated store)",
  () => H.withStore(driver, async (reopen) => {
    const resolved = config.resolveConfig({ modDir: MOD_DIR, env: {} });
    assert.deepStrictEqual(resolved.errors || [], []);
    const svc = createReviewService({ store: {}, journal: {}, strategyRepository: { limits: { maxResourceUnits: 1 } },
      intelRepository: {}, registry: {}, kinds: { list: [], get: () => null }, powerTable: {}, scoring: {},
      scheduler: {}, fleets: {}, clock: { now: () => 0 }, worldSeed: 1, config: resolved.config, hostility: () => true,
      isCampaignOk: () => true, industryCatalog: {} });
    assert.deepStrictEqual(NEW_KEYS.map((k) => svc.params.upkeep[k]), [false, 250, false, 100,
      "empire,pirate,neutral"]);

    const R = require("./review.test").harness;
    const { createManualClock } = require("../../lib/util/clock");
    const { createIdGenerator } = require("../../lib/util/ids");
    const clock = createManualClock(R.START_MS);
    const controllers = new Map(R.THEATRE.map((id) => [id, R.SANSHA]));
    const shared = { clock, ids: createIdGenerator({ clock, rng: createRng(61) }), graph: R.graphOf(), controllers };
    const seen = new Map();
    const second = new Map();
    let phase = 1;
    const hooks = { beforeEffect: (d, s) => {
      const into = phase === 1 ? seen : second;
      if (!into.has(s.factionId)) into.set(s.factionId, s.upkeep);
      return d;
    } };
    const e = await R.bootAll(reopen(), shared, { EVEJS_LNE_STRATEGY_CAMPAIGNS: "none",
      EVEJS_LNE_STRATEGY_MAX_REVIEWS_PER_PASS: "8", EVEJS_LNE_UPKEEP_HOME_SPACE_INCOME_ENABLED: "1" },
    { world: R.upkeepWorld(controllers, new Map()), hooks });
    await R.passesAt(e, shared, R.START_MS + R.I);
    const unavailable = () => e.strategy.getStatus().ai.review.counters.homeSpaceUnavailable;
    assert.strictEqual(unavailable(), 0);
    assert.ok(!Object.prototype.hasOwnProperty.call(svc.params.mining, "homeSpaceUnavailable"));
    const graphBefore = shared.graph;
    shared.graph = Object.freeze({ ...graphBefore, getSystemsBySecClass: () => {
      throw new Error("Probe");
    } });
    phase = 2;
    await R.passesAt(e, shared, R.START_MS + 2 * R.I);
    shared.graph = graphBefore;
    e.strategy.stop("test");
    assert.ok(second.has(R.AMARR), JSON.stringify([...second.keys()]));
    assert.strictEqual(second.get(R.AMARR).homeSpaceSystems, 0, "refused -> fallback 0");
    assert.strictEqual(unavailable(), [...second.keys()].filter((f) => registry.getDoctrine(
      registry.getFaction(f).doctrineId).ownSpace).length);
    const own = (f) => {
      const space = registry.getDoctrine(registry.getFaction(f).doctrineId).ownSpace;
      return [...new Set(space.secClasses)].flatMap((c) => shared.graph.getSystemsBySecClass(c) || [])
        .filter((id) => (shared.graph.getSystem(id) || {}).factionId === f).length;
    };
    assert.ok(seen.has(R.AMARR) && seen.has(R.SANSHA), JSON.stringify([...seen.keys()]));
    assert.ok(own(R.AMARR) > 0, "k3 graph has Amarr home space");
    assert.deepStrictEqual([seen.get(R.AMARR).homeSpaceSystems, seen.get(R.SANSHA).homeSpaceSystems],
      [own(R.AMARR), 0]);
  }));
};
