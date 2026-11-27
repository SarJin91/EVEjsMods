"use strict";

const assert = require("node:assert");
const path = require("node:path");

const { decideReview, decideReactive } = require("../../lib/strategy/ai");
const { planHiveBrood, hiveFleetTarget } = require("../../lib/strategy/ai/hive");
const { planPatrols } = require("../../lib/strategy/ai/patrol");
const { planMerges } = require("../../lib/strategy/ai/merge");
const { markClaimHolders } = require("../../lib/strategy/ai/claimHold");
const { planMinerRaids } = require("../../lib/strategy/ai/minerRaids");
const { evaluateSupplyAndFronts } = require("../../lib/strategy/ai/supply");
const { buildPowerTable, strengthOf } = require("../../lib/strategy/ai/strength");
const { createOperationKinds } = require("../../lib/strategy/kinds");
const { OPERATION_KINDS_VERSION, OPERATION_KINDS_V1 } = require("../../lib/strategy/data/operationKinds");
const { DOCTRINES_V1 } = require("../../lib/strategy/data/doctrines");
const { TARGET_SCORING_V1 } = require("../../lib/strategy/data/targetScoring");
const { FLEET_ROLES, OPERATION_TYPES, OBJECTIVES } = require("../../lib/fleets/schema");
const { GROUPS } = require("../../lib/battle/data/strengthCatalog");
const M = require("../../lib/world/occupation/machine");
const { createHostility } = require("../../lib/battle/data/hostility");
const { buildUniverseGraph } = require("../../lib/graph/universeGraph");
const { createRouteFinder } = require("../../lib/graph/routes");
const { k3StaticMap, system } = require("./fixtures/k3Cluster.fixture");
const { resolveConfig } = require("../../config");
const { createManualClock } = require("../../lib/util/clock");
const { createRng } = require("../../lib/util/rng");
const { createIdGenerator } = require("../../lib/util/ids");
const { harness: H } = require("../battle/settlement.test");
const { harness: R } = require("./review.test");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const AT = 1760000000000;
const HOUR = 3600000;
const HIVE = 500025;
const HOSTILE = 9;
const SANSHA = 500019;

const kinds = (() => {
  const k = createOperationKinds({ version: OPERATION_KINDS_VERSION, kinds: OPERATION_KINDS_V1 },
    { operationTypes: OPERATION_TYPES, objectives: OBJECTIVES, fleetRoles: FLEET_ROLES });
  assert.ok(k.ok, JSON.stringify(k));
  return k.kinds;
})();
const POWER = buildPowerTable(GROUPS);
const BIG = [{ hullGroup: "cruiser", typeId: null, count: 4 }];
const C = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_DATA_ROOT: "x" } }).config;
const D = DOCTRINES_V1.find((x) => x.doctrineId === "rogue-hive-v1");
const DOCTRINE = Object.freeze({ doctrineId: D.doctrineId, canOccupy: D.canOccupy, expandsBeyondTheatre: false,
  operationTypes: [...D.operationTypes], reachJumps: D.reachJumps, templates: D.templates, ownSpace: null,
  borderReachKey: null, borderTargets: false, borderCaptures: false, captureTargets: [...D.captureTargets],
  targetSecClasses: [...D.targetSecClasses], returnToBase: D.returnToBase, confinedToBelt: false,
  buildsStations: false, capturesStations: false, consolidates: D.consolidates, hullsRequired: false,
  fieldsHunters: false, hunterTemplate: [], hunterComposition: [], hoardCapped: true, raidsBeyondTheatre: true,
  hive: true });
const HIVE_P = Object.freeze({ maxFleets: 20, fleetsPerNode: 4, maxFrontsPerAttacker: 1, assumedGarrisonFleets: 2,
  captureSlowFactor: 3 });
const PARAMS = Object.freeze({ maxReachJumps: C.strategy.maxReachJumps, supplyChainJumps: 10,
  captureRangeFromStationJumps: 5, maxAssemblyJumps: C.strategy.maxAssemblyJumps, maxBfsSystems: 2000,
  mobilizeFallbackJumps: 0, mobilizeFallbackMaxSystems: 2000, maxTargetCandidates: 40, targetPickTopK: 1,
  maxOperationsPerReview: 3, maxFleetsPerOperation: 4, maxFleetsPerFaction: 40, maxMobilizationsPerReview: 3,
  mobilizeResourcePerShip: 10, mobilizeReservePerShip: 1, attackStrengthRatio: 1.2, intelTtlMs: 6 * HOUR,
  maxObservationsPerReview: 8, reconWindowMs: HOUR / 2, attackWindowMs: 2 * HOUR, operationGraceMs: HOUR,
  maxHousekeepingPerReview: 4, maxRefitRequestsPerReview: 2, returnAfterIdleMs: HOUR / 2, returnWindowMs: 2 * HOUR,
  maxReturnsPerReview: 3, returnFleetRoles: [...kinds.get("return").fleetRoles], kinds: kinds.list,
  scoring: TARGET_SCORING_V1, powerTable: POWER, frontLimitCap: 3, routeMaxJumps: 40,
  defense: { enabled: true, maxPerReview: 2 },
  patrol: { windowMs: HOUR, idleMs: C.strategy.patrolIdleMs, minShips: 1, garrisonMaxJumps: 4, scoutMaxJumps: 4,
    maxGarrisonsPerPost: 2, maxOpenPickets: 0, scoutReserve: 0, roleMaxJumps: C.strategy.patrolRoleMaxJumps,
    roleMaxEnemyRatio: 1, garrisonFleetsTarget: 1 },
  merge: { roles: ["patrol"], maxPerReview: 2, maxShipsPerFleet: 100 },
  hive: HIVE_P });

const row = (systemId, controllerFactionId, extra = {}) => ({ systemId, controllerFactionId, occupationState: "STABLE",
  ownInfluence: 0, occupierFactionId: null, homeFactionId: null, controllerGarrison: 0, hostileStations: 0,
  liveStations: 0, ownLiveStations: 0, observed: false, ...extra });
const fleet = (fleetId, systemId, extra = {}) => ({ fleetId, version: 2, state: "IDLE", fleetRole: "patrol", systemId,
  refitPending: false, shipCount: 4, strength: strengthOf(BIG, POWER), operationId: null, legSeq: 0,
  homeSystemId: systemId, composition: BIG, updatedAt: AT - 2 * HOUR, ...extra });
const intel = (systemId) => ({ systemId, observedAt: AT - HOUR, hostileFleets: 1, hostileShips: 1, hostileStrength: 1,
  hostileStations: 0, controllerFactionId: HOSTILE, source: "fleet" });
const OFF = Object.freeze({ mode: "off", truncated: false, items: [] });

function snap(o = {}) {
  return { v: 1, factionId: HIVE, round: 3, at: AT, seed: 11,
    faction: { status: o.status || "ACTIVE", homeSystemId: 20, doctrineId: DOCTRINE.doctrineId,
      resourceUnits: o.resources === undefined ? 100000 : o.resources,
      reserveUnits: o.resources === undefined ? 10000 : o.resources, frontLimit: 3, version: 1 },
    entry: { kind: "hive", maxActiveFronts: 3, allies: [], homeRegionIds: [], ownerCorporationId: 1 },
    doctrine: o.doctrine || DOCTRINE, hive: { homeSystems: 10 },
    theatre: [], expansion: [], raidTargets: o.raidTargets || [],
    neighbors: (id) => [id - 1, id + 1].filter((x) => x >= 1 && x <= 40), regionOf: () => null,
    isHostile: (x) => x === HOSTILE, isPlaying: () => true,
    stationsMode: "ready", stations: [], captureAnchors: [],
    systems: o.systems || [row(20, HIVE), row(30, HIVE)],
    fleets: o.fleets || [], fleetsTruncated: o.fleetsTruncated === true, operations: o.operations || [],
    operationsTruncated: false, intel: o.intel || [], sightings: [], occupations: o.occupations || [],
    territory: [], territoryTruncated: false,
    footholds: (o.nodes || [20, 30]).map((systemId) => ({ systemId, jumps: 10 })),
    upkeep: o.upkeep || { mode: "ready", paidUntil: null, unpaidPeriods: 0, controlledCount: 10, captured: [],
      capturedTruncated: false, liveShips: 0, stationCount: 2, tradeReady: false, tradeReason: null },
    capturedIds: [], threats: o.threats || OFF,
    lostHome: o.lostHome || { mode: "off", truncated: false, afterSystemId: 0, nextAfterSystemId: 0, systemIds: [] },
    huntReady: false };
}

const launches = (d) => d.intents.filter((i) => i.type === "LAUNCH").map((i) => [i.kind, i.target.systemId,
  i.fleets.map((x) => x.fleetId)]);
const mobs = (d) => d.intents.filter((i) => i.type === "MOBILIZE");
const BUDGET = Object.freeze({ resourceUnits: 100000, reserveUnits: 10000 });
const brood = (s, slots = 3, budget = BUDGET, params = PARAMS, mobilized = 0) => planHiveBrood({ snapshot: s, params,
  slots: { mobilizations: slots }, budget, mobilized });

module.exports = ({ test, skip }) => {
  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  test("HA1 planHiveBrood: 24 nodes grow to hive.maxFleets and stop, fewer systems / nodes -> lower target without a "
    + "disband, slots and budget, node order, gates; the offensive mobilizes under hive.maxFleets", () => {
    const P1 = { ...PARAMS, hive: { ...HIVE_P, fleetsPerNode: 1 } };
    assert.deepStrictEqual([hiveFleetTarget(24, 10, 10, P1.hive), hiveFleetTarget(24, 5, 10, P1.hive),
      hiveFleetTarget(10, 10, 10, P1.hive), hiveFleetTarget(24, 99, 10, P1.hive), hiveFleetTarget(24, 10, 0, P1.hive),
      hiveFleetTarget(3, 1, 3, P1.hive)], [20, 12, 10, 20, 0, 1]);

    const nodes = Array.from({ length: 24 }, (_, i) => 100 + i);
    let fleets = [];
    let rounds = 0;
    for (; rounds < 20; rounds += 1) {
      const r = brood(snap({ nodes, fleets }), 3, BUDGET, P1);
      if (r.intents.length === 0) break;
      fleets = fleets.concat(r.intents.map((m, i) => fleet(`r${rounds}-${i}`, m.systemId)));
    }
    assert.deepStrictEqual([rounds, fleets.length], [7, 20]);
    assert.deepStrictEqual(fleets.map((x) => x.homeSystemId), nodes.slice(0, 20));
    const m = brood(snap({ nodes, fleets: [] }), 1, BUDGET, P1).intents[0];
    assert.deepStrictEqual(m, { type: "MOBILIZE", slot: 0, role: "patrol", systemId: 100, homeSystemId: 100,
      composition: D.templates.patrol.map((e) => ({ hullGroup: e.hullGroup, typeId: null, count: e.count })),
      cost: { resourceUnits: 80, reserveUnits: 8 }, stationId: null, hulls: [] });

    for (const s of [snap({ nodes, fleets, upkeep: { ...snap().upkeep, controlledCount: 5 } }),
      snap({ nodes: nodes.slice(0, 10), fleets })]) {
      assert.deepStrictEqual(brood(s, 3, BUDGET, P1), { intents: [], notes: [], cost: { resourceUnits: 0,
        reserveUnits: 0 } });
    }
    assert.deepStrictEqual([brood(snap({ nodes }), 1, BUDGET, P1).intents.length, brood(snap({ nodes }), 0, BUDGET,
      P1).intents.length, brood(snap({ nodes }), 3, BUDGET, P1, 19).intents.length], [1, 0, 1]);
    const poor = brood(snap({ nodes }), 3, { resourceUnits: 120, reserveUnits: 100 }, P1);
    assert.deepStrictEqual([poor.intents.length, poor.notes, poor.cost], [1, ["INSUFFICIENT_RESOURCES"],
      { resourceUnits: 80, reserveUnits: 8 }]);
    const mixed = [fleet("p1", 20), fleet("p2", 20), fleet("p3", 20), fleet("q1", 30), fleet("q2", 30)];
    assert.deepStrictEqual(brood(snap({ fleets: mixed })).intents.map((x) => x.systemId), [30, 20, 30]);

    const empty = { intents: [], notes: [], cost: { resourceUnits: 0, reserveUnits: 0 } };
    for (const [s, params] of [[snap(), { ...PARAMS, hive: null }], [snap({ doctrine: { ...DOCTRINE, hive: false } }),
      PARAMS], [snap({ status: "DORMANT" }), PARAMS],
    [snap({ doctrine: { ...DOCTRINE, templates: { scout: D.templates.scout } } }), PARAMS]]) {
      assert.deepStrictEqual(brood(s, 3, BUDGET, params), empty);
    }
    for (const s of [snap({ fleetsTruncated: true }), snap({ upkeep: { mode: "off" } })]) {
      assert.deepStrictEqual(brood(s), { ...empty, notes: ["HIVE_SKIPPED"] });
    }

    const lost = { systems: [row(20, HIVE), row(30, HIVE), row(17, HOSTILE, { homeFactionId: HIVE })],
      lostHome: { mode: "ready", truncated: false, afterSystemId: 0, nextAfterSystemId: 0, systemIds: [17] },
      intel: [intel(17)], fleets: [fleet("a", 20, { refitPending: true }), fleet("b", 20, { refitPending: true })] };
    const capped = decideReview(snap(lost), { ...PARAMS, hive: { ...HIVE_P, maxFleets: 2 } });
    assert.strictEqual(capped.outcome, "REVIEWED", capped.reason);
    assert.ok(capped.notes.includes("FLEET_LIMIT"), JSON.stringify(capped.notes));
    assert.deepStrictEqual([mobs(capped).length, capped.intents.filter((i) => i.type === "LAUNCH").length], [0, 0]);
    const open = decideReview(snap(lost), PARAMS);
    assert.ok(open.intents.some((i) => i.type === "LAUNCH" && i.kind === "invasion" && i.mobilize.length > 0),
      JSON.stringify(open.intents.map((i) => i.type)));
  });

  test("HA2 decideReview on a hive snapshot: only the allowed intent types, the lost home gets the invasion "
    + "(RECLAIM), a hostile raid target gets a raid, a free one nothing; the pool fills in the nodes", () => {
    const fleets = [fleet("p1", 20), fleet("p2", 20), fleet("p3", 20), fleet("q1", 30), fleet("q2", 30)];
    const systems = [row(20, HIVE), row(30, HIVE), row(14, HOSTILE), row(15, null)];
    const allowed = ["UPKEEP", "MOBILIZE", "LAUNCH", "OBSERVE", "CLOSE_OPERATION", "REQUEST_REFIT", "FACTION_TOUCH"];
    const kindsOk = ["recon", "invasion", "raid", "defense", "patrol", "return"];
    const outside = (d) => d.intents.filter((i) => !allowed.includes(i.type)
      || (i.type === "LAUNCH" && !kindsOk.includes(i.kind)));
    const lostOf = (systemIds) => ({ mode: "ready", truncated: false, afterSystemId: 0, nextAfterSystemId: 0,
      systemIds });
    const home = decideReview(snap({ systems: [...systems, row(17, HOSTILE, { homeFactionId: HIVE })],
      raidTargets: [14, 15], intel: [intel(14), intel(15), intel(17)], fleets, lostHome: lostOf([17]) }), PARAMS);
    assert.strictEqual(PARAMS.maxOperationsPerReview, 3);
    assert.strictEqual(home.outcome, "REVIEWED", home.reason);
    assert.deepStrictEqual(outside(home), []);
    assert.deepStrictEqual(launches(home).filter(([k, t]) => k === "invasion" || t === 17), [["invasion", 17, ["p1"]]],
      JSON.stringify(launches(home)));
    assert.deepStrictEqual(home.notes.filter((n) => n.startsWith("RECLAIM:")), ["RECLAIM:17"],
      JSON.stringify(home.notes));
    assert.ok(!home.intents.some((i) => i.target && i.target.systemId === 15));
    const fronted = decideReview(snap({ systems: [...systems, row(17, HOSTILE, { homeFactionId: HIVE }),
      row(23, HOSTILE, { homeFactionId: HIVE })], intel: [intel(17), intel(23)], fleets,
    operations: [{ operationId: "op17", version: 1, state: "ACTIVE", operationType: "invasion", targetSystemId: 17,
      dueAt: AT + HOUR, members: 1, orderedMembers: 1 }], lostHome: lostOf([17, 23]) }), PARAMS);
    assert.strictEqual(fronted.outcome, "REVIEWED", fronted.reason);
    assert.ok(!fronted.intents.some((i) => i.type === "LAUNCH" && i.target.systemId === 17),
      JSON.stringify(launches(fronted)));
    assert.deepStrictEqual(launches(fronted).filter(([k]) => k === "invasion").map(([, t]) => t), [23],
      JSON.stringify(launches(fronted)));
    assert.deepStrictEqual(fronted.notes.filter((n) => n.startsWith("RECLAIM:")), ["RECLAIM:23"],
      JSON.stringify(fronted.notes));
    const d = decideReview(snap({ systems, raidTargets: [14, 15], intel: [intel(14), intel(15)], fleets }), PARAMS);
    assert.strictEqual(d.outcome, "REVIEWED", d.reason);
    assert.deepStrictEqual(outside(d), []);
    assert.deepStrictEqual(launches(d), [["raid", 14, ["p1"]]], JSON.stringify(d.notes));
    assert.ok(!d.intents.some((i) => i.target && i.target.systemId === 15));
    assert.deepStrictEqual(mobs(d).map((m) => [m.role, m.systemId]), [["patrol", 30], ["patrol", 20], ["patrol", 30]]);
    assert.strictEqual(d.intents.filter((i) => i.type === "MERGE").length, 0);
  });

  test("HA3 planDefense for the hive: a threat 15 jumps from a node -> LAUNCH defense of the node fleet, no "
    + "mobilization, in decideReactive and decideReview; 16 jumps -> DEFENSE_INSUFFICIENT", () => {
    assert.strictEqual(PARAMS.maxAssemblyJumps, 15);
    const threatAt = (systemId) => ({ mode: "ready", truncated: false, items: [{ systemId, state: "INVASION",
      occupier: HOSTILE, occupierStrength: 1, phaseDueAt: AT + HOUR }] });
    const reactiveOf = (x) => ({ v: 1, factionId: HIVE, round: 3, at: AT, doctrine: x.doctrine, fleets: x.fleets,
      operations: [], operationsTruncated: false, occupations: [], threats: x.threats, siege: null,
      neighbors: x.neighbors, reactive: { room: 4 } });
    const s = snap({ nodes: [20], threats: threatAt(35), systems: [row(20, HIVE), row(35, HIVE)],
      fleets: [fleet("p1", 20)] });
    const reacted = decideReactive(reactiveOf(s), PARAMS);
    assert.strictEqual(reacted.outcome, "REACTED", JSON.stringify(reacted));
    assert.deepStrictEqual(reacted.intents.map((i) => [i.type, i.kind, i.target.systemId, i.mobilize.length,
      i.fleets.map((x) => x.fleetId)]), [["LAUNCH", "defense", 35, 0, ["p1"]]]);
    const full = decideReview(s, PARAMS);
    assert.deepStrictEqual(launches(full).filter(([k]) => k === "defense"), [["defense", 35, ["p1"]]]);
    const far = decideReactive(reactiveOf({ ...s, threats: threatAt(36) }), PARAMS);
    assert.deepStrictEqual([far.intents, far.notes], [[], ["DEFENSE_INSUFFICIENT:36"]]);
  });

  test("HA4 machine drawsGarrison false -> reassign [] (absent / true -> the garrison as before); a hive fleet in an "
    + "own CONSOLIDATING claim gets neither return nor patrol, off the claim it does", () => {
    const F = HIVE;
    const view = (drawsGarrison) => ({ systemId: 30002000, state: "OCCUPIED", controller: F, occupier: F,
      previousController: null, sinceAt: 0, seq: 0, evaluatedAt: HOUR, capturedAt: null, detachedSinceAt: null,
      home: F, coreOwner: null, influence: new Map([[F, { score: 70, garrison: 0 }]]),
      presence: new Map([[F, { strength: 500, fleets: [{ fleetId: "f1", version: 1, state: "IDLE",
        fleetRole: "patrol", refitPending: false }] }]]),
      stations: new Map(), inRange: (x) => x === F, isHostile: createHostility(), presenceTruncated: false, at: HOUR,
      consolidates: undefined, rangeKnown: true, ...(drawsGarrison ? { drawsGarrison } : {}) });
    const params = { evalIntervalMs: 900000, idleEvalIntervalMs: 7200000, maxActiveSystems: 64,
      reconTimeoutMs: 2 * HOUR, contestTimeoutMs: 6 * HOUR, invasionHoldMs: 6 * HOUR, occupiedSettleMs: 6 * HOUR,
      consolidateMs: 24 * HOUR, invasionMinScore: 30, occupyMinScore: 60, occupyMaxDefenderScore: 30,
      stableMinScore: 80, stableMaxResidualScore: 20, battleWinPoints: 20, battleLossPoints: 15,
      holdPointsPerHour: 10, stationPointsPerHour: 5, stationBonusCap: 3, decayPointsPerHour: 5,
      requireNoDefenderStations: true, garrisonFleetsTarget: 2, detachedUpkeepStep: 0.5,
      detachedUpkeepPeriodMs: 24 * HOUR, detachedUpkeepMaxFactor: 4, maxFactionsPerSystem: 8, stableBaselineScore: 60,
      stableRecoverPointsPerHour: 1, stableForeignDecayPointsPerHour: 1, stableForeignFloorScore: 0,
      garrisonFromRoles: ["invasion", "patrol", "scout", "reserve"] };
    const tick = { kind: "tick" };
    assert.deepStrictEqual(M.evaluate(view(null), tick, params).reassign.map((x) => x.fleetId), ["f1"]);
    assert.deepStrictEqual(M.evaluate(view(() => true), tick, params).reassign.map((x) => x.fleetId), ["f1"]);
    assert.deepStrictEqual(M.evaluate(view((f) => f !== HIVE), tick, params).reassign, []);

    const claim = [{ systemId: 25, state: "CONSOLIDATING", occupier: HIVE, phaseDueAt: null, homeOwn: true,
      sinceAt: AT - HOUR }];
    const base = { systems: [row(20, HIVE), row(30, HIVE), row(25, HIVE), row(23, HOSTILE)],
      fleets: [fleet("h1", 25, { homeSystemId: 20 })] };
    const held = decideReview(snap({ ...base, occupations: claim }), PARAMS);
    assert.deepStrictEqual(launches(held), [], JSON.stringify(held.notes));
    const free = decideReview(snap(base), PARAMS);
    assert.deepStrictEqual(launches(free), [["return", 20, ["h1"]]], JSON.stringify(free.notes));
    const supplyOf = (x) => evaluateSupplyAndFronts(x, PARAMS);
    const sortie = (occupations) => {
      const x = snap({ ...base, occupations });
      return planPatrols(x, supplyOf(x), PARAMS, new Set(), 3, {}).intents.map((i) => [i.kind, i.target.systemId]);
    };
    assert.deepStrictEqual([sortie(claim), sortie([])], [[], [["patrol", 23]]]);
  });

  test("HA5 sortie of the hive: a rested node fleet -> LAUNCH patrol on a hostile system, a free / own system is no "
    + "target (PATROL_NO_TARGET); idle away from the nodes -> return to the nearest node; planMerges none", () => {
    const d = decideReview(snap({ systems: [row(20, HIVE), row(30, HIVE), row(21, null), row(22, HIVE),
      row(25, HOSTILE)], fleets: [fleet("p1", 20)] }), PARAMS);
    assert.deepStrictEqual(launches(d), [["patrol", 25, ["p1"]]], JSON.stringify(d.notes));
    const quiet = decideReview(snap({ systems: [row(20, HIVE), row(30, HIVE), row(21, null), row(22, HIVE)],
      fleets: [fleet("p1", 20)] }), PARAMS);
    assert.deepStrictEqual(launches(quiet), []);
    assert.ok(quiet.notes.includes("PATROL_NO_TARGET"), JSON.stringify(quiet.notes));
    const back = decideReview(snap({ systems: [row(20, HIVE), row(30, HIVE), row(27, HOSTILE)],
      fleets: [fleet("p1", 27, { homeSystemId: 20, updatedAt: AT - HOUR })] }), PARAMS);
    assert.deepStrictEqual(launches(back), [["return", 30, ["p1"]]], JSON.stringify(back.notes));
    const home = decideReview(snap({ fleets: [fleet("p1", 20, { updatedAt: AT - 60000 })] }), PARAMS);
    assert.deepStrictEqual(launches(home), []);
    const pair = [fleet("q1", 30), fleet("q2", 30)];
    assert.deepStrictEqual([planMerges(snap({ fleets: pair }), PARAMS, new Set()).intents.length,
      planMerges(snap({ fleets: pair, doctrine: { ...DOCTRINE, hive: false } }), PARAMS, new Set()).intents.length],
    [0, 1]);
  });

  test("HA7: a hive fleet idle in a foreign CONTESTED claim (homeOwn false) gets return, neither "
    + "HOLDING nor a sortie; in a claim of its home (homeOwn true) it stays; a doctrine without hive keeps HOLDING", () => {
    const HOLD = { maxMs: 12 * HOUR, states: Object.freeze(["CONTESTED", "INVASION"]), roles: Object.freeze(["patrol"]) };
    const P = { ...PARAMS, claimHold: HOLD };
    const claim = (homeOwn) => [{ systemId: 25, state: "CONTESTED", occupier: HIVE, phaseDueAt: null, homeOwn,
      sinceAt: AT - HOUR }];
    const base = { systems: [row(20, HIVE), row(30, HIVE), row(25, HOSTILE), row(23, HOSTILE)],
      fleets: [fleet("h1", 25, { homeSystemId: 20 })] };
    const foreign = decideReview(snap({ ...base, occupations: claim(false) }), P);
    assert.deepStrictEqual(launches(foreign), [["return", 20, ["h1"]]], JSON.stringify(foreign.notes));
    assert.ok(!foreign.notes.includes("CLAIM_HOLD"), JSON.stringify(foreign.notes));
    const home = decideReview(snap({ ...base, systems: [row(20, HIVE), row(30, HIVE), row(25, HIVE), row(23, HOSTILE)],
      occupations: claim(true) }), P);
    assert.deepStrictEqual(launches(home), [], JSON.stringify(home.notes));
    const mark = (doctrine, homeOwn) => {
      const pseudo = new Map();
      const notes = markClaimHolders(snap({ ...base, doctrine, occupations: claim(homeOwn) }), P, pseudo);
      return [[...pseudo.entries()], notes];
    };
    assert.deepStrictEqual(mark(DOCTRINE, false), [[], []]);
    assert.deepStrictEqual(mark(DOCTRINE, true), [[["h1", "HOLDING"]], ["CLAIM_HOLD"]]);
    assert.deepStrictEqual(mark({ ...DOCTRINE, hive: false }, false), [[["h1", "HOLDING"]], ["CLAIM_HOLD"]]);
  });

  test("HA8: the hive with params.minerRaid and miner targets -> 0 LAUNCH gank (the same "
    + "snapshot without hive ganks); strategy.maxFleetsPerFaction 5 under hive.maxFleets 20 -> pool <= 5", () => {
    const RAID = { maxPerReview: 2, windowMs: HOUR, maxJumps: 5, minShips: 3, minShipRatioPermille: 1000,
      minShiftLeftMs: HOUR / 2, highsec: false, maxFleetsScanned: 12 };
    const mt = { targets: [{ tripId: "t22", factionId: HOSTILE, fleetId: "m22", systemId: 22, secClass: "lowsec",
      miningEndsAt: AT + 2 * HOUR, ships: 3 }], truncated: false };
    const supply = { stationSystems: [], reach: new Map([[20, 0], [21, 1], [22, 2]]), frontTargets: [] };
    const gank = (doctrine) => planMinerRaids({ ...snap({ fleets: [fleet("p1", 20)], doctrine }), minerTargets: mt },
      supply, { ...PARAMS, minerRaid: RAID }, new Set(), 2).intents.filter((i) => i.kind === "gank").length;
    assert.deepStrictEqual([gank(DOCTRINE), gank({ ...DOCTRINE, hive: false })], [0, 1]);

    const capped = brood(snap(), 10, BUDGET, { ...PARAMS, maxFleetsPerFaction: 5 });
    const open = brood(snap(), 10, BUDGET, PARAMS);
    assert.deepStrictEqual([capped.intents.length, open.intents.length], [5, 8]);
  });

  needsDriver("HA6 real store: with hive.enabled the hive snapshot has upkeep.stationCount = "
    + "active nodes and no treasury, Sansha keeps its treasury part", async () => {
    const MAL = [30001051, 30001052, 30001053, 30001054, 30001055];
    const graph = (() => {
      const map = k3StaticMap({ extra: MAL.map((id) => system(id, 10000013, 20000150, "nullsec")) });
      const link = (a, b) => map.gates.push({ fromSystemId: a, toSystemId: b }, { fromSystemId: b, toSystemId: a });
      link(30004932, MAL[0]);
      for (let i = 1; i < MAL.length; i += 1) link(MAL[i - 1], MAL[i]);
      const built = buildUniverseGraph(map);
      assert.ok(built.ok);
      return Object.freeze({ ...built.graph, ...createRouteFinder(built.graph, { cacheSize: 64, maxJumps: 40 })
        .publicApi });
    })();
    await H.withStore(driver, async (reopen) => {
      const clock = createManualClock(R.START_MS);
      const controllers = new Map([...R.THEATRE.map((id) => [id, SANSHA]), ...MAL.map((id) => [id, HIVE])]);
      const shared = { clock, ids: createIdGenerator({ clock, rng: createRng(71) }), graph, controllers };
      const seen = new Map();
      const hooks = { beforeEffect: (d, s) => {
        if (!seen.has(d.factionId)) seen.set(d.factionId, s);
        return d;
      } };
      const e = await R.bootAll(reopen(), shared, { EVEJS_LNE_HIVE_ENABLED: "1", EVEJS_LNE_TREASURY_ENABLED: "1",
        EVEJS_LNE_STRATEGY_CAMPAIGNS: "none", EVEJS_LNE_STRATEGY_ACTIVE_FACTIONS: `${SANSHA},${HIVE}`,
        EVEJS_LNE_STRATEGY_MAX_REVIEWS_PER_PASS: "8" }, { hooks, world: R.upkeepWorld(controllers, new Map()) });
      await R.passesAt(e, shared, R.START_MS + R.I);
      e.strategy.stop("test");
      const hive = seen.get(HIVE);
      const sansha = seen.get(SANSHA);
      assert.ok(hive && sansha, `reviews seen: ${[...seen.keys()]}`);
      const nodes = hive.footholds.map((x) => x.systemId);
      assert.ok(nodes.length >= 2 && nodes.every((id) => MAL.includes(id)), JSON.stringify(nodes));
      assert.deepStrictEqual([hive.upkeep.mode, hive.upkeep.stationCount, hive.upkeep.controlledCount,
        "treasury" in hive, hive.doctrine.hive], ["ready", nodes.length, MAL.length, false, true]);
      assert.deepStrictEqual(["treasury" in sansha, sansha.upkeep.stationCount, sansha.doctrine.hive],
        [true, sansha.stations.length, false]);
    });
  });
};
