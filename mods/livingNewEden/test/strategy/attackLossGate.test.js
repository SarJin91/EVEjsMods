"use strict";

const assert = require("node:assert");

const { chooseNextOperation } = require("../../lib/strategy/ai/operations");
const { planGarrisonReinforce } = require("../../lib/strategy/ai/garrison");
const { planMinerRaids } = require("../../lib/strategy/ai/minerRaids");
const { planPatrols } = require("../../lib/strategy/ai/patrol");
const { cooledOf, lossesOf, raisedRequired } = require("../../lib/strategy/ai/attackLossGate");
const { evaluateSupplyAndFronts } = require("../../lib/strategy/ai/supply");
const { buildPowerTable, strengthOf } = require("../../lib/strategy/ai/strength");
const { createOperationKinds } = require("../../lib/strategy/kinds");
const { OPERATION_KINDS_VERSION, OPERATION_KINDS_V1 } = require("../../lib/strategy/data/operationKinds");
const { TARGET_SCORING_V1 } = require("../../lib/strategy/data/targetScoring");
const { FLEET_ROLES, OPERATION_TYPES, OBJECTIVES } = require("../../lib/fleets/schema");
const { GROUPS } = require("../../lib/battle/data/strengthCatalog");
const { createRng } = require("../../lib/util/rng");

const AT = 1760000000000;
const HOUR = 3600000;
const F = 7;
const HOSTILE = 9;
const BASE = 20;

const kinds = (() => {
  const k = createOperationKinds({ version: OPERATION_KINDS_VERSION, kinds: OPERATION_KINDS_V1 },
    { operationTypes: OPERATION_TYPES, objectives: OBJECTIVES, fleetRoles: FLEET_ROLES });
  assert.ok(k.ok, JSON.stringify(k));
  return k.kinds;
})();
const POWER = buildPowerTable(GROUPS);
const WING = [{ hullGroup: "cruiser", typeId: null, count: 6 }];
const ONE = [{ hullGroup: "frigate", typeId: null, count: 1 }];
const GARRISON = [{ hullGroup: "cruiser", count: 4 }, { hullGroup: "battlecruiser", count: 2 }];
const GATE = Object.freeze({ stepPermille: 250, maxMultiplier: 4 });

const PARAMS = Object.freeze({ maxReachJumps: 10, supplyChainJumps: 10, captureRangeFromStationJumps: 5,
  maxAssemblyJumps: 5, maxBfsSystems: 2000, mobilizeFallbackJumps: 0, mobilizeFallbackMaxSystems: 2000,
  maxTargetCandidates: 40, targetPickTopK: 1, maxOperationsPerReview: 1, maxFleetsPerOperation: 4,
  maxFleetsPerFaction: 32, maxMobilizationsPerReview: 3, mobilizeResourcePerShip: 10, mobilizeReservePerShip: 1,
  attackStrengthRatio: 1.2, intelTtlMs: 6 * HOUR, reconWindowMs: HOUR / 2, attackWindowMs: 2 * HOUR,
  patrolWindowMs: HOUR, kinds: kinds.list, scoring: TARGET_SCORING_V1, powerTable: POWER, frontLimitCap: 6,
  routeMaxJumps: 40, claimFrontGraceMs: 0, reconUnblockEnabled: false, raidFrontLimitEnabled: false,
  hostilePremiumCaptureOnly: false });

const row = (systemId, controllerFactionId) => ({ systemId, controllerFactionId, occupationState: "STABLE",
  controllerGarrison: 0, hostileStations: 0, observed: false, ownInfluence: 0 });
const intelOf = (systemId, hostileStrength = 0) => ({ systemId, observedAt: AT - HOUR, hostileFleets: 0,
  hostileShips: 0, hostileStrength, hostileStations: 0, controllerFactionId: null });
const fleet = (fleetId, systemId, fleetRole, composition = WING, extra = {}) => ({ fleetId, version: 2, state: "IDLE",
  fleetRole, systemId, refitPending: false, shipCount: composition.reduce((s, e) => s + e.count, 0),
  strength: strengthOf(composition, POWER), operationId: null, legSeq: 0, homeSystemId: BASE,
  updatedAt: AT - 2 * HOUR, ...extra });
const losses = (entries) => new Map(entries.map(([id, n, until]) => [id, { losses: n, cooldownUntil: until }]));

function snap(o) {
  return { v: 1, factionId: F, round: 3, at: AT, seed: 11,
    faction: { status: "ACTIVE", homeSystemId: BASE, resourceUnits: 100000, reserveUnits: 10000, frontLimit: 6,
      version: 1 },
    entry: { maxActiveFronts: 6, allies: [], homeRegionIds: [] },
    doctrine: { doctrineId: "al", canOccupy: true, reachJumps: 30, returnToBase: false,
      operationTypes: o.operationTypes || ["recon", "invasion", "raid"],
      templates: { scout: [{ hullGroup: "frigate", count: 1 }], invasion: WING,
        patrol: [{ hullGroup: "cruiser", count: 2 }], garrison: GARRISON } },
    theatre: o.theatre || [], expansion: [], raidTargets: [],
    border: { mode: "off", reach: null, captures: false, candidates: [], rejected: 0 },
    neighbors: (id) => [id - 1, id + 1].filter((x) => x >= 1 && x <= 40), regionOf: () => null,
    isHostile: (x) => x === HOSTILE,
    stationsMode: "ready", stations: [{ systemId: BASE, stationId: "st20" }], captureAnchors: [BASE],
    systems: [row(BASE, F), ...(o.systems || [])], fleets: o.fleets || [], fleetsTruncated: false,
    operations: [], operationsTruncated: false, intel: o.intel || [], sightings: [], occupations: [],
    territory: (o.posts || []).map((systemId) => ({ systemId, detachedSinceAt: null })), territoryTruncated: false,
    capturedIds: [], footholds: [],
    ...(o.minerTargets ? { minerTargets: o.minerTargets } : {}),
    ...(o.attackLosses ? { attackLosses: o.attackLosses } : {}) };
}

const ops = (s, params) => chooseNextOperation(s, evaluateSupplyAndFronts(s, params), params, createRng(5), null);
const launches = (out) => out.intents.filter((i) => i.type === "LAUNCH")
  .map((i) => [i.target.systemId, i.fleets.length, i.mobilize.length]);

const garScene = (attackLosses) => snap({ posts: [22, 25, 18], operationTypes: ["recon", "raid", "reinforce"],
  systems: [row(22, F), row(25, F), row(18, F)],
  fleets: [fleet("g22", 22, "garrison", ONE), fleet("g18", 18, "garrison", GARRISON)],
  intel: [{ ...intelOf(25, 50), hostileFleets: 1, hostileShips: 3, controllerFactionId: F }], attackLosses });
const gar = (s, params) => planGarrisonReinforce({ snapshot: s, supply: { stationSystems: [BASE] },
  params: { ...params, garrison: { maxPerReview: 2 } }, ledger: null, slots: { operations: 2, mobilizations: 3 },
  budget: { resourceUnits: 1e6, reserveUnits: 1e6 } });

const RAID = Object.freeze({ maxPerReview: 1, windowMs: HOUR, maxJumps: 5, minShips: 3, minShipRatioPermille: 1000,
  minShiftLeftMs: HOUR / 2, highsec: false, maxFleetsScanned: 12 });
const miner = (systemId) => ({ tripId: `t${systemId}`, factionId: HOSTILE, fleetId: `m${systemId}`, systemId,
  secClass: "lowsec", miningEndsAt: AT + 2 * HOUR, ships: 3 });
const mrScene = (attackLosses) => snap({ operationTypes: ["recon", "raid", "return"],
  fleets: [fleet("r20", BASE, "patrol")], minerTargets: { targets: [miner(18), miner(24)], truncated: false },
  attackLosses });
const mr = (s, params) => planMinerRaids(s, { stationSystems: [BASE], reach: new Map([[18, 2], [24, 4]]),
  frontTargets: [] }, { ...params, minerRaid: RAID }, new Set(), 2);

const PATROL = Object.freeze({ windowMs: HOUR, idleMs: HOUR / 2, minShips: 6, garrisonMaxJumps: 2, scoutMaxJumps: 5,
  maxGarrisonsPerPost: 3, garrisonFleetsTarget: 2, maxOpenPickets: 0, roleMaxJumps: 6, roleMaxEnemyRatio: 1.5 });
const ptScene = (attackLosses) => snap({ operationTypes: ["recon", "raid", "patrol", "return"],
  systems: [row(21, null), row(24, null), row(26, HOSTILE)], fleets: [fleet("p1", BASE, "patrol")], attackLosses });
const pt = (s, params) => planPatrols(s, { stationSystems: [BASE], reach: new Map([[21, 1], [24, 4], [26, 6]]),
  frontTargets: [] }, { ...params, patrol: PATROL }, new Set(), 2);
const targets = (r) => r.intents.map((i) => i.target.systemId);

module.exports = ({ test }) => {
  test("AG1 chooseNextOperation: a target on a cooldown skipped (ATTACK_LOSS_COOLDOWN), 2 losses raise required "
    + "(ATTACK_LOSS_REQUIRED_RAISED, one more MOBILIZE); raisedRequired", () => {
    assert.deepStrictEqual([raisedRequired(10, 0, GATE), raisedRequired(10, 2, GATE), raisedRequired(10, 9, GATE),
      raisedRequired(10, 2, null)], [10, 15, 20, 10]);
    const two = (attackLosses) => snap({ theatre: [21, 24], systems: [row(21, null), row(24, null)],
      intel: [intelOf(21), intelOf(24)], fleets: [fleet("inv1", BASE, "invasion")], attackLosses });
    const off = ops(two(), PARAMS);
    assert.strictEqual(launches(off).length, 1, JSON.stringify(off));
    const first = launches(off)[0][0];
    const other = first === 21 ? 24 : 21;
    const cooled = losses([[first, 3, AT + HOUR]]);
    const on = ops(two(cooled), { ...PARAMS, attackLoss: GATE });
    assert.deepStrictEqual(launches(on).map((l) => l[0]), [other], JSON.stringify(on));
    assert.ok(on.notes.includes("ATTACK_LOSS_COOLDOWN"), JSON.stringify(on.notes));
    assert.deepStrictEqual([...cooledOf({ at: AT, attackLosses: cooled })], [first]);
    assert.deepStrictEqual([...cooledOf({ at: AT + HOUR, attackLosses: cooled })], [], "expired");

    const P = strengthOf(WING, POWER);
    const hostile = Math.floor(P / 1.2) - 1;
    const one = (attackLosses) => snap({ theatre: [24], systems: [row(24, null)], intel: [intelOf(24, hostile)],
      fleets: [fleet("inv1", BASE, "invasion")], attackLosses });
    const base = ops(one(), PARAMS);
    assert.deepStrictEqual(launches(base), [[24, 1, 0]], JSON.stringify(base));
    const raisedMap = losses([[24, 2, 0]]);
    assert.strictEqual(lossesOf({ attackLosses: raisedMap }, 24), 2);
    const raised = ops(one(raisedMap), { ...PARAMS, attackLoss: GATE });
    assert.deepStrictEqual(launches(raised), [[24, 1, 1]], JSON.stringify(raised));
    assert.deepStrictEqual(raised.notes.filter((n) => n.startsWith("ATTACK_LOSS")), ["ATTACK_LOSS_REQUIRED_RAISED"]);
  });

  test("AG2 planGarrisonReinforce: the hot post 25 on a cooldown skipped (note), 22 reinforced", () => {
    const off = gar(garScene(), PARAMS);
    assert.deepStrictEqual(targets(off), [25, 22], JSON.stringify(off.notes));
    const on = gar(garScene(losses([[25, 3, AT + HOUR]])), { ...PARAMS, attackLoss: GATE });
    assert.deepStrictEqual(targets(on), [22]);
    assert.deepStrictEqual(on.notes.filter((n) => n.startsWith("ATTACK_LOSS")), ["ATTACK_LOSS_COOLDOWN"]);
  });

  test("AG3 planMinerRaids / planPatrols (role patrol sortie): the system on a cooldown is no target", () => {
    assert.deepStrictEqual(targets(mr(mrScene(), PARAMS)), [18]);
    assert.deepStrictEqual(targets(mr(mrScene(losses([[18, 3, AT + HOUR]])), { ...PARAMS, attackLoss: GATE })), [24]);
    assert.deepStrictEqual(targets(pt(ptScene(), PARAMS)), [26]);
    assert.deepStrictEqual(targets(pt(ptScene(losses([[26, 3, AT + HOUR]])), { ...PARAMS, attackLoss: GATE })), [21]);
  });

  test("AG4 params.attackLoss absent / null with snapshot.attackLosses = the result without the map", () => {
    const cd = (id) => losses([[id, 5, AT + HOUR]]);
    for (const p of [PARAMS, { ...PARAMS, attackLoss: null }]) {
      const two = (attackLosses) => snap({ theatre: [21, 24], systems: [row(21, null), row(24, null)],
        intel: [intelOf(21), intelOf(24)], fleets: [fleet("inv1", BASE, "invasion")], attackLosses });
      assert.deepStrictEqual(ops(two(cd(21)), p), ops(two(), p));
      assert.deepStrictEqual(ops(two(cd(24)), p), ops(two(), p));
      assert.deepStrictEqual(gar(garScene(cd(25)), p), gar(garScene(), p));
      assert.deepStrictEqual(mr(mrScene(cd(18)), p), mr(mrScene(), p));
      assert.deepStrictEqual(pt(ptScene(cd(26)), p), pt(ptScene(), p));
    }
  });
};

Object.assign(module.exports, { harness: Object.freeze({ snap, row, intelOf, fleet, ops, launches, mrScene, mr,
  pt, targets, PARAMS, PATROL, WING, POWER, BASE, AT }) });
