"use strict";

const assert = require("node:assert");

const { chooseNextOperation } = require("../../../lib/strategy/ai/operations");
const { evaluateSupplyAndFronts } = require("../../../lib/strategy/ai/supply");
const { chooseTargetSystem, scoreCandidate, candidateFacts, usableKinds, effectiveIntel } =
  require("../../../lib/strategy/ai/targeting");
const { buildPowerTable, strengthOf } = require("../../../lib/strategy/ai/strength");
const { createOperationKinds } = require("../../../lib/strategy/kinds");
const { OPERATION_KINDS_VERSION, OPERATION_KINDS_V1 } = require("../../../lib/strategy/data/operationKinds");
const { TARGET_SCORING_V1 } = require("../../../lib/strategy/data/targetScoring");
const { FLEET_ROLES, OPERATION_TYPES, OBJECTIVES } = require("../../../lib/fleets/schema");
const { GROUPS } = require("../../../lib/battle/data/strengthCatalog");
const { createRng } = require("../../../lib/util/rng");

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

const PARAMS = Object.freeze({ maxReachJumps: 10, supplyChainJumps: 10, captureRangeFromStationJumps: 5,
  maxAssemblyJumps: 5, maxBfsSystems: 2000, mobilizeFallbackJumps: 0, mobilizeFallbackMaxSystems: 2000,
  maxTargetCandidates: 40, targetPickTopK: 1, maxOperationsPerReview: 2, maxFleetsPerOperation: 4,
  maxFleetsPerFaction: 32, maxMobilizationsPerReview: 3, mobilizeResourcePerShip: 10, mobilizeReservePerShip: 1,
  attackStrengthRatio: 1.2, intelTtlMs: 6 * HOUR, reconWindowMs: HOUR / 2, attackWindowMs: 2 * HOUR,
  kinds: kinds.list, scoring: TARGET_SCORING_V1, powerTable: POWER, frontLimitCap: 6, routeMaxJumps: 40,
  claimFrontGraceMs: 0, maxScoutsPerFaction: 4, maxRaidFronts: 2 });
const OFF = Object.freeze({ reconUnblockEnabled: false, raidFrontLimitEnabled: false,
  hostilePremiumCaptureOnly: false });

const row = (systemId, controllerFactionId) => ({ systemId, controllerFactionId, occupationState: "STABLE",
  controllerGarrison: 0, hostileStations: 0, observed: false, ownInfluence: 0 });
const intelOf = (systemId, controllerFactionId) => ({ systemId, observedAt: AT - HOUR, hostileFleets: 0,
  hostileShips: 0, hostileStrength: 0, hostileStations: 0, controllerFactionId });
const fleet = (fleetId, systemId, fleetRole = "invasion", state = "IDLE") => ({ fleetId, version: 2, state, fleetRole,
  systemId, refitPending: false, shipCount: 6, strength: strengthOf(WING, POWER), operationId: null, legSeq: 0,
  homeSystemId: BASE, updatedAt: AT - HOUR });
const raidOp = (operationId, targetSystemId) => ({ operationId, state: "ACTIVE", operationType: "raid",
  targetSystemId });

function snap(o) {
  return { v: 1, factionId: F, round: 3, at: AT, seed: 11,
    faction: { status: "ACTIVE", homeSystemId: BASE, resourceUnits: 100000, reserveUnits: 10000, frontLimit: 6 },
    entry: { maxActiveFronts: 6, homeRegionIds: [] },
    doctrine: { doctrineId: "sf", canOccupy: true, reachJumps: 10, operationTypes: ["recon", "invasion", "raid"],
      templates: { scout: [{ hullGroup: "frigate", count: 1 }], invasion: WING,
        patrol: [{ hullGroup: "cruiser", count: 2 }] } },
    theatre: o.theatre, expansion: [], raidTargets: [],
    border: { mode: "off", reach: null, captures: false, candidates: [], rejected: 0 },
    neighbors: (id) => [id - 1, id + 1].filter((x) => x >= 1 && x <= 40), regionOf: () => null,
    isHostile: (x) => x === HOSTILE,
    stationsMode: "ready", stations: [{ systemId: BASE, stationId: "st20" }], captureAnchors: [BASE],
    systems: [row(BASE, F), ...o.systems], fleets: o.fleets, fleetsTruncated: false,
    operations: o.ops || [], operationsTruncated: false, intel: o.intel || [], sightings: [], occupations: [],
    territory: [], territoryTruncated: false, capturedIds: [], footholds: [] };
}

function run(s, params) {
  const supply = evaluateSupplyAndFronts(s, params);
  return chooseNextOperation(s, supply, params, createRng(5), null);
}
const launches = (out) => out.intents.filter((i) => i.type === "LAUNCH")
  .map((i) => [i.kind, i.target.systemId, i.mobilize.map((m) => m.role)]);

const sceneT1 = () => snap({ theatre: [22], systems: [row(22, null)],
  fleets: Array.from({ length: 32 }, (_, i) => fleet(`w${String(i).padStart(2, "0")}`, 1)) });
const sceneT2 = () => snap({ theatre: [21, 24], systems: [row(21, null), row(24, null)], intel: [intelOf(24, null)],
  fleets: [fleet("inv1", BASE), ...["s1", "s2", "s3", "s4"].map((id) => fleet(id, 35, "scout", "ACTIVE"))] });
const sceneT3 = () => snap({ theatre: [13, 24], systems: [row(13, HOSTILE), row(24, null)],
  intel: [intelOf(13, HOSTILE), intelOf(24, null)], fleets: [fleet("inv1", BASE)],
  ops: [raidOp("op1", 30), raidOp("op2", 31)] });
const T2_PARAMS = { ...PARAMS, maxFleetsPerFaction: 5 };
const T3_PARAMS = { ...PARAMS, maxAssemblyJumps: 10, maxOperationsPerReview: 1 };

module.exports = ({ test }) => {
  test("T1: 32 far invasion fleets, no scout - flag on: LAUNCH recon with MOBILIZE scout, no FLEET_LIMIT "
    + "flag off: FLEET_LIMIT, no intent", () => {
    const on = run(sceneT1(), { ...PARAMS, reconUnblockEnabled: true });
    assert.deepStrictEqual(launches(on), [["recon", 22, ["scout"]]], JSON.stringify(on));
    assert.ok(!on.notes.includes("FLEET_LIMIT"), JSON.stringify(on.notes));
    const off = run(sceneT1(), { ...PARAMS, ...OFF });
    assert.deepStrictEqual([off.intents, off.notes], [[], ["FLEET_LIMIT"]]);
  });

  test("T2: 4 live scouts - flag on: SCOUT_LIMIT once, the target skipped, LAUNCH invasion on the next "
    + "flag off (scouts counted, fleet cap 5): FLEET_LIMIT and break, no LAUNCH", () => {
    const on = run(sceneT2(), { ...T2_PARAMS, reconUnblockEnabled: true });
    assert.deepStrictEqual(launches(on), [["invasion", 24, []]], JSON.stringify(on));
    assert.deepStrictEqual(on.notes.filter((n) => n === "SCOUT_LIMIT"), ["SCOUT_LIMIT"]);
    assert.ok(!on.notes.includes("FLEET_LIMIT"), JSON.stringify(on.notes));
    const off = run(sceneT2(), { ...T2_PARAMS, ...OFF });
    assert.deepStrictEqual([launches(off), off.notes], [[], ["FLEET_LIMIT"]]);
  });

  test("T3: 2 open raids, maxRaidFronts 2 - flag on: raidFrontTargets [30,31], LAUNCH invasion on the free "
    + "target and RAID_FRONT_LIMIT; flag off: LAUNCH raid on the hostile target", () => {
    const P = { ...T3_PARAMS, raidFrontLimitEnabled: true };
    assert.deepStrictEqual(evaluateSupplyAndFronts(sceneT3(), P).raidFrontTargets, [30, 31]);
    assert.strictEqual("raidFrontTargets" in evaluateSupplyAndFronts(sceneT3(), T3_PARAMS), false);
    const on = run(sceneT3(), P);
    assert.deepStrictEqual(launches(on), [["invasion", 24, []]], JSON.stringify(on));
    assert.deepStrictEqual(on.notes, ["RAID_FRONT_LIMIT"]);
    const off = run(sceneT3(), { ...T3_PARAMS, ...OFF });
    assert.deepStrictEqual(launches(off), [["raid", 13, []]], JSON.stringify(off));
    const one = sceneT3();
    one.operations = [raidOp("op1", 30)];
    assert.deepStrictEqual(launches(run(one, P)), [["raid", 13, []]]);
  });

  test("T4: premium 0 for a hostile raid-only target, 350 for a capturable one, hive -100 in both modes "
    + "chooseTargetSystem picks the free neighbour; flag off = v8", () => {
    const s = snap({ theatre: [17, 21, 25], systems: [row(17, HOSTILE), row(21, HOSTILE), row(25, null), row(26, F)],
      intel: [intelOf(17, HOSTILE), intelOf(21, HOSTILE), intelOf(25, null)], fleets: [] });
    const base = { ...PARAMS, captureRequiresAdjacency: true };
    const premiumOnly = { ...Object.fromEntries(Object.keys(TARGET_SCORING_V1).map((k) => [k, 0])),
      strengthUnit: 1000, hostileControlled: TARGET_SCORING_V1.hostileControlled,
      hiveControlled: TARGET_SCORING_V1.hiveControlled };
    const premium = (P, id, override = {}) => {
      const supply = evaluateSupplyAndFronts(s, P);
      const facts = candidateFacts(s, P, supply, usableKinds(s, P), effectiveIntel(s), id, false);
      return scoreCandidate(s, { ...P, scoring: premiumOnly }, { ...facts, ...override }, id, 0);
    };
    const on = { ...base, hostilePremiumCaptureOnly: true };
    assert.deepStrictEqual([premium(on, 17), premium(on, 21), premium(on, 17, { hive: true })], [0, 350, -100]);
    assert.deepStrictEqual([premium(base, 17), premium(base, 21), premium(base, 17, { hive: true })],
      [350, 350, -100]);
    const pick = (P) => {
      const out = chooseTargetSystem(s, { ...evaluateSupplyAndFronts(s, P), frontTargets: [21] }, P, createRng(5));
      return [out.systemId, out.score];
    };
    assert.deepStrictEqual(pick(base), [17, 1170]);
    assert.deepStrictEqual(pick(on), [25, 930]);
  });

  test("T5 flags absent = flags explicitly off: chooseNextOperation deepStrictEqual on the T1-T3 snapshots", () => {
    for (const [scene, P] of [[sceneT1, PARAMS], [sceneT2, T2_PARAMS], [sceneT3, T3_PARAMS]]) {
      const bare = { ...P };
      delete bare.maxScoutsPerFaction;
      delete bare.maxRaidFronts;
      assert.deepStrictEqual(run(scene(), bare), run(scene(), { ...P, ...OFF }));
    }
  });

  test("T6: hostile raid-only (no adjacency) gets 0 hostile premium, free neighbour wins; flag off = v9 legacy", () => {
    const s = snap({ theatre: [17, 21, 25], systems: [row(17, HOSTILE), row(21, HOSTILE), row(25, null), row(26, F)],
      intel: [intelOf(17, HOSTILE), intelOf(21, HOSTILE), intelOf(25, null)], fleets: [] });
    const base = { ...PARAMS, captureRequiresAdjacency: true };
    const premiumOnly = { ...Object.fromEntries(Object.keys(TARGET_SCORING_V1).map((k) => [k, 0])),
      strengthUnit: 1000, hostileControlled: TARGET_SCORING_V1.hostileControlled,
      hiveControlled: TARGET_SCORING_V1.hiveControlled };
    const premium = (P, id, override = {}) => {
      const supply = evaluateSupplyAndFronts(s, P);
      const facts = candidateFacts(s, P, supply, usableKinds(s, P), effectiveIntel(s), id, false);
      return scoreCandidate(s, { ...P, scoring: premiumOnly }, { ...facts, ...override }, id, 0);
    };
    const on = { ...base, hostilePremiumCaptureOnly: true };
    assert.deepStrictEqual(premium(on, 17), 0);
    assert.deepStrictEqual(premium(on, 21), 350);
    assert.deepStrictEqual(premium(on, 25), 0);
    assert.deepStrictEqual(premium(base, 17), 350);
    assert.deepStrictEqual(premium(base, 21), 350);
    assert.deepStrictEqual(premium(base, 25), 0);
    const pick = (P) => {
      const out = chooseTargetSystem(s, { ...evaluateSupplyAndFronts(s, P), frontTargets: [21] }, P, createRng(5));
      return [out.systemId, out.score];
    };
    assert.deepStrictEqual(pick(base), [17, 1170]);
    assert.deepStrictEqual(pick(on), [25, 930]);
  });

  test("T7: hive controller always gets hiveControlled (-100), captureBlock does not affect it", () => {
    const s = snap({ theatre: [17], systems: [row(17, HOSTILE)],
      intel: [intelOf(17, HOSTILE)], fleets: [] });
    const base = { ...PARAMS, captureRequiresAdjacency: true };
    const premiumOnly = { ...Object.fromEntries(Object.keys(TARGET_SCORING_V1).map((k) => [k, 0])),
      strengthUnit: 1000, hostileControlled: TARGET_SCORING_V1.hostileControlled,
      hiveControlled: TARGET_SCORING_V1.hiveControlled };
    const premium = (P, id, override = {}) => {
      const supply = evaluateSupplyAndFronts(s, P);
      const facts = candidateFacts(s, P, supply, usableKinds(s, P), effectiveIntel(s), id, false);
      return scoreCandidate(s, { ...P, scoring: premiumOnly }, { ...facts, ...override }, id, 0);
    };
    const on = { ...base, hostilePremiumCaptureOnly: true };
    assert.deepStrictEqual(premium(on, 17, { hive: true }), -100);
    assert.deepStrictEqual(premium(base, 17, { hive: true }), -100);
    assert.deepStrictEqual(premium(on, 17), 0);
    assert.deepStrictEqual(premium(base, 17), 350);
  });

  const sceneSC = () => snap({ theatre: [22, 25], systems: [row(22, null), row(25, null)], fleets: [] });
  const runSC = (P, pool) => {
    const s = sceneSC();
    const supply = evaluateSupplyAndFronts(s, P);
    const broke = { ...supply, affordable: { ...supply.affordable, resourceUnits: 0, reserveUnits: 0 },
      ...(pool ? { scoutAffordable: pool } : {}) };
    return chooseNextOperation(s, broke, P, createRng(5), null);
  };
  const scoutCosts = (out) => out.intents.flatMap((i) => (i.type === "LAUNCH" ? i.mobilize : []))
    .map((m) => [m.role, m.cost.resourceUnits, m.cost.reserveUnits]);

  test("SC2: budget 0, pool {40,4}, flag on: both stale targets get MOBILIZE scout + LAUNCH recon (10/1 each "
    + "from the pool), UPKEEP_SHIP_CAP_SCOUT once; pool {15,4}: one scout, then INSUFFICIENT_RESOURCES", () => {
    const P = { ...PARAMS, reconUnblockEnabled: true };
    const on = runSC(P, { resourceUnits: 40, reserveUnits: 4 });
    assert.deepStrictEqual(launches(on), [["recon", 22, ["scout"]], ["recon", 25, ["scout"]]], JSON.stringify(on));
    assert.deepStrictEqual(scoutCosts(on), [["scout", 10, 1], ["scout", 10, 1]]);
    assert.deepStrictEqual(on.notes.filter((n) => n === "UPKEEP_SHIP_CAP_SCOUT"), ["UPKEEP_SHIP_CAP_SCOUT"]);
    assert.ok(!on.notes.includes("INSUFFICIENT_RESOURCES"), JSON.stringify(on.notes));
    const small = runSC(P, { resourceUnits: 15, reserveUnits: 4 });
    assert.deepStrictEqual(launches(small), [["recon", 22, ["scout"]]], JSON.stringify(small));
    assert.ok(small.notes.includes("INSUFFICIENT_RESOURCES"), JSON.stringify(small.notes));
  });

  test("SC3 regression: flag off or no pool -> INSUFFICIENT_RESOURCES as before, no intent, no scout note", () => {
    const off = runSC({ ...PARAMS, ...OFF }, { resourceUnits: 40, reserveUnits: 4 });
    assert.deepStrictEqual([off.intents, off.notes], [[], ["INSUFFICIENT_RESOURCES"]]);
    const noPool = runSC({ ...PARAMS, reconUnblockEnabled: true }, null);
    assert.deepStrictEqual(noPool.intents, []);
    assert.ok(noPool.notes.includes("INSUFFICIENT_RESOURCES") && !noPool.notes.includes("UPKEEP_SHIP_CAP_SCOUT"),
      JSON.stringify(noPool.notes));
  });
};
