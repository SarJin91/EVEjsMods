"use strict";

const assert = require("node:assert");

const { chooseNextOperation } = require("../../lib/strategy/ai/operations");
const { launchValueIsk, expectedLossIsk } = require("../../lib/strategy/ai/attackLossGate");
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
const BASE = 20;
const T = 24;

const kinds = (() => {
  const k = createOperationKinds({ version: OPERATION_KINDS_VERSION, kinds: OPERATION_KINDS_V1 },
    { operationTypes: OPERATION_TYPES, objectives: OBJECTIVES, fleetRoles: FLEET_ROLES });
  assert.ok(k.ok, JSON.stringify(k));
  return k.kinds;
})();
const POWER = buildPowerTable(GROUPS);
const WING = [{ hullGroup: "cruiser", typeId: null, count: 6 }];
const P_WING = strengthOf(WING, POWER);
const VALUE = Object.freeze({ cruiser: 10000000, frigate: 1000000 });
const WAR = Object.freeze({ room: 0, dayBudget: 0, spentToday: 0, captureIsk: 1000000, fitPermille: 300,
  productionCap: 0, valueByGroup: VALUE });
const GATE = Object.freeze({ stepPermille: 250, maxMultiplier: 4 });
const ISK_GATE = Object.freeze({ sharePermille: 330, maxRoomPermille: 500 });

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
const intelOf = (systemId, hostileStrength) => ({ systemId, observedAt: AT - HOUR, hostileFleets: 0,
  hostileShips: 0, hostileStrength, hostileStations: 0, controllerFactionId: null });
const fleet = (fleetId, systemId) => ({ fleetId, version: 2, state: "IDLE", fleetRole: "invasion", systemId,
  refitPending: false, shipCount: 6, strength: P_WING, operationId: null, legSeq: 0, homeSystemId: BASE,
  composition: WING, updatedAt: AT - 2 * HOUR });

function snap(hostile, losses) {
  return { v: 1, factionId: F, round: 3, at: AT, seed: 11,
    faction: { status: "ACTIVE", homeSystemId: BASE, resourceUnits: 100000, reserveUnits: 10000, frontLimit: 6,
      version: 1 },
    entry: { maxActiveFronts: 6, allies: [], homeRegionIds: [] },
    doctrine: { doctrineId: "ig", canOccupy: true, reachJumps: 30, returnToBase: false,
      operationTypes: ["recon", "invasion", "raid"],
      templates: { scout: [{ hullGroup: "frigate", count: 1 }], invasion: WING } },
    theatre: [T], expansion: [], raidTargets: [],
    border: { mode: "off", reach: null, captures: false, candidates: [], rejected: 0 },
    neighbors: (id) => [id - 1, id + 1].filter((x) => x >= 1 && x <= 40), regionOf: () => null,
    isHostile: () => false,
    stationsMode: "ready", stations: [{ systemId: BASE, stationId: "st20" }], captureAnchors: [BASE],
    systems: [row(BASE, F), row(T, null)], fleets: [fleet("inv1", BASE)], fleetsTruncated: false,
    operations: [], operationsTruncated: false, intel: [intelOf(T, hostile)], sightings: [], occupations: [],
    territory: [], territoryTruncated: false, capturedIds: [], footholds: [],
    attackLosses: new Map(losses > 0 ? [[T, { losses, cooldownUntil: 0 }]] : []) };
}

function ops(s, params, isk) {
  const supply = evaluateSupplyAndFronts(s, params);
  const withWar = isk === null ? supply
    : { ...supply, affordable: { ...supply.affordable, isk }, war: WAR };
  return chooseNextOperation(s, withWar, params, createRng(5), null);
}
const gated = (iskGate) => ({ ...PARAMS, attackLoss: { ...GATE, iskGate } });
const forT = (out) => out.intents.filter((i) => (i.type === "LAUNCH" && i.target.systemId === T)
  || i.type === "MOBILIZE");

const HOSTILE_TWO = Math.ceil(P_WING / 1.2) + 1;
const WING_VALUE = 78000000;

module.exports = ({ test }) => {
  test("IG1 costly attack + small war room -> ATTACK_LOSS_ISK_GATE once, no LAUNCH / MOBILIZE for T", () => {
    assert.strictEqual(launchValueIsk([WING, WING], WAR), 2 * WING_VALUE);
    assert.strictEqual(expectedLossIsk(2 * WING_VALUE, 0, { ...GATE, iskGate: ISK_GATE }), 51480000);
    const s = snap(HOSTILE_TWO, 0);
    const out = ops(s, gated(ISK_GATE), 100000000);
    assert.deepStrictEqual(forT(out), [], JSON.stringify(out));
    assert.deepStrictEqual(out.notes.filter((n) => n === "ATTACK_LOSS_ISK_GATE"), ["ATTACK_LOSS_ISK_GATE"]);
    assert.ok(!out.notes.includes("INSUFFICIENT_FORCE"), JSON.stringify(out.notes));
    assert.ok(out.intents.every((i) => i.warIsk === undefined), "nothing spent of the war room");
  });

  test("IG2 the same attack with a large war room -> the LAUNCH of the run without the gate", () => {
    const s = snap(HOSTILE_TWO, 0);
    const open = ops(s, gated(ISK_GATE), 1000000000);
    const without = ops(s, gated(null), 1000000000);
    assert.deepStrictEqual(open, without);
    const l = open.intents.find((i) => i.type === "LAUNCH");
    assert.ok(l && l.target.systemId === T && l.fleets.length === 1 && l.mobilize.length === 1, JSON.stringify(open));
    assert.ok(!open.notes.includes("ATTACK_LOSS_ISK_GATE"));
  });

  test("IG3 losses 2 raise the share 330 -> 495 permille: a room passing at 0 closes the attack at 2", () => {
    const A = { ...GATE, iskGate: ISK_GATE };
    assert.deepStrictEqual([expectedLossIsk(1000, 0, A), expectedLossIsk(1000, 2, A), expectedLossIsk(1000, 9, A)],
      [330, 495, 660]);
    const at0 = ops(snap(0, 0), gated(ISK_GATE), 60000000);
    assert.ok(at0.intents.some((i) => i.type === "LAUNCH" && i.target.systemId === T), JSON.stringify(at0));
    const at2 = ops(snap(0, 2), gated(ISK_GATE), 60000000);
    assert.deepStrictEqual(forT(at2), [], JSON.stringify(at2));
    assert.ok(at2.notes.includes("ATTACK_LOSS_ISK_GATE"), JSON.stringify(at2.notes));
  });

  test("IG4 iskGate null and budget.isk null = the result without params.attackLoss (deepStrictEqual)", () => {
    const s = snap(HOSTILE_TWO, 0);
    const base = ops(s, PARAMS, 100000000);
    assert.ok(base.intents.some((i) => i.type === "LAUNCH" && i.mobilize.length === 1), JSON.stringify(base));
    assert.deepStrictEqual(ops(s, gated(null), 100000000), base);
    const noWar = ops(s, PARAMS, null);
    assert.deepStrictEqual(ops(s, gated(ISK_GATE), null), noWar);
  });
};
