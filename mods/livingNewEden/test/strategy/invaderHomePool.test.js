"use strict";

const assert = require("node:assert");
const path = require("node:path");

const config = require("../../config");
const { decideReview } = require("../../lib/strategy/ai");
const { planMerges } = require("../../lib/strategy/ai/merge");
const { markHomePool, HOME_POOL } = require("../../lib/strategy/ai/invaderEconomy");
const { buildPowerTable, strengthOf } = require("../../lib/strategy/ai/strength");
const { createOperationKinds } = require("../../lib/strategy/kinds");
const { OPERATION_KINDS_VERSION, OPERATION_KINDS_V1 } = require("../../lib/strategy/data/operationKinds");
const { TARGET_SCORING_V1 } = require("../../lib/strategy/data/targetScoring");
const { DOCTRINES_V1 } = require("../../lib/strategy/data/doctrines");
const { FLEET_ROLES, OPERATION_TYPES, OBJECTIVES } = require("../../lib/fleets/schema");
const { GROUPS } = require("../../lib/battle/data/strengthCatalog");
const { describeNote } = require("../../lib/strategy/activity/notes");
const { invaderEconomyParamsOf } = require("../../lib/strategy/reviewService");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const AT = 1760000000000;
const HOUR = 3600000;
const TRIG = 500026;
const HQ = 1;

const kinds = (() => {
  const k = createOperationKinds({ version: OPERATION_KINDS_VERSION, kinds: OPERATION_KINDS_V1 },
    { operationTypes: OPERATION_TYPES, objectives: OBJECTIVES, fleetRoles: FLEET_ROLES });
  assert.ok(k.ok, JSON.stringify(k));
  return k.kinds;
})();
const POWER = buildPowerTable(GROUPS);
const GARRISON = [{ hullGroup: "cruiser", typeId: null, count: 4 }, { hullGroup: "battleship", typeId: null, count: 2 }];

const PARAMS = Object.freeze({ maxReachJumps: 10, supplyChainJumps: 10, captureRangeFromStationJumps: 15,
  maxAssemblyJumps: 15, maxBfsSystems: 2000, mobilizeFallbackJumps: 0, mobilizeFallbackMaxSystems: 2000,
  maxTargetCandidates: 40, targetPickTopK: 1, maxOperationsPerReview: 2, maxFleetsPerOperation: 4,
  maxFleetsPerFaction: 32, maxMobilizationsPerReview: 3, mobilizeResourcePerShip: 10, mobilizeReservePerShip: 1,
  attackStrengthRatio: 1.2, intelTtlMs: 6 * HOUR, maxObservationsPerReview: 12, reconWindowMs: HOUR / 2,
  attackWindowMs: 2 * HOUR, operationGraceMs: HOUR, maxHousekeepingPerReview: 4, maxRefitRequestsPerReview: 2,
  maxReturnsPerReview: 2, kinds: kinds.list, scoring: TARGET_SCORING_V1, powerTable: POWER, frontLimitCap: 6,
  routeMaxJumps: 40, maxCapturedSystemsPerFaction: 150, captureRequiresAdjacency: true, footholdHold: null,
  hqGarrison: null,
  merge: Object.freeze({ roles: Object.freeze(["garrison"]), maxPerReview: 2, maxShipsPerFleet: 100 }) });

const pool = (fleetId, extra = {}) => ({ fleetId, version: 2, state: "IDLE", fleetRole: "garrison", systemId: HQ,
  refitPending: false, shipCount: 6, strength: strengthOf(GARRISON, POWER), operationId: null, legSeq: 0,
  homeSystemId: HQ, composition: GARRISON, updatedAt: AT - HOUR, ...extra });

function snap(fleets) {
  const d = DOCTRINES_V1.find((x) => x.doctrineId === "triglavian-invader-v1");
  return { v: 1, factionId: TRIG, round: 3, at: AT, seed: 11,
    faction: { status: "ACTIVE", homeSystemId: HQ, doctrineId: d.doctrineId, resourceUnits: 100000,
      reserveUnits: 10000, frontLimit: 1, version: 1 },
    entry: { kind: "invader", maxActiveFronts: 1, allies: [], homeRegionIds: [], ownerCorporationId: 1, hqSystemId: HQ },
    doctrine: d, theatre: [], expansion: [], raidTargets: [],
    border: { mode: "off", reach: null, captures: false, candidates: [], rejected: 0 },
    neighbors: (id) => [id - 1, id + 1].filter((x) => x >= 1 && x <= 20), regionOf: () => null,
    isHostile: () => false, stationsMode: "ready", stations: [], captureAnchors: [],
    systems: [], fleets, fleetsTruncated: false, operations: [], operationsTruncated: false, intel: [], sightings: [],
    occupations: [], territory: [], territoryTruncated: false, capturedIds: [], footholds: [] };
}

const resolve = (env) => {
  const r = config.resolveConfig({ modDir: MOD_DIR, env });
  assert.ok(r.ok, JSON.stringify(r.errors));
  return r.config;
};
const typesOf = (d) => d.intents.map((i) => i.type);

module.exports = ({ test }) => {
  test("IC2 home pool: off = the review as before (merge of the HQ garrisons); on: 8 fleets -> FULL, no MOBILIZE, no "
    + "MERGE; 2 fleets -> MOBILIZE garrison HOME_POOL in the HQ, note INVADER_HOME_POOL:3", () => {
    const off = invaderEconomyParamsOf(resolve({ EVEJS_LNE_INVADER_ECONOMY_ENABLED: "1" }), TRIG);
    assert.ok(off && !("homePool" in off), "homePoolEnabled off: E of");
    const cfgOn = resolve({ EVEJS_LNE_INVADER_ECONOMY_ENABLED: "1", EVEJS_LNE_INVADER_ECONOMY_HOME_POOL_ENABLED: "1" });
    const on = invaderEconomyParamsOf(cfgOn, TRIG, HQ);
    assert.deepStrictEqual({ ...on.homePool }, { maxFleets: 8, mobilizationsPerReview: 1, hqSystemId: HQ });
    assert.deepStrictEqual({ ...invaderEconomyParamsOf(cfgOn, 500029).homePool }, { maxFleets: 0,
      mobilizationsPerReview: 0, hqSystemId: null }, "Deathless: no pool");

    const eight = snap(Array.from({ length: 8 }, (_, i) => pool(`g${i}`)));
    const base = decideReview(eight, PARAMS);
    assert.strictEqual(base.outcome, "REVIEWED", base.reason);
    const { invaderYield, ...offRest } = decideReview(eight, { ...PARAMS, invaderEconomy: off });
    assert.deepStrictEqual(offRest, base, "homePool off: the decision of before");
    assert.deepStrictEqual(invaderYield, { iskDaily: 0, unitsPerPeriod: 0 });
    assert.ok(typesOf(base).includes("MERGE"), "without the pool the HQ garrisons are merged");

    const full = decideReview(eight, { ...PARAMS, invaderEconomy: on });
    assert.ok(full.notes.includes("INVADER_HOME_POOL_FULL"), JSON.stringify(full.notes));
    assert.ok(!typesOf(full).includes("MOBILIZE") && !typesOf(full).includes("MERGE"), JSON.stringify(typesOf(full)));
    const pseudo = new Map();
    markHomePool(eight, on, pseudo);
    assert.strictEqual([...pseudo.values()].filter((v) => v === HOME_POOL).length, 8);
    const rest = { ...eight, fleets: eight.fleets.map((x) => ({ ...x, state: pseudo.get(x.fleetId) })) };
    assert.deepStrictEqual(planMerges(rest, PARAMS, new Set()).intents, [], "HOME_POOL is never merged");

    const two = decideReview(snap([pool("g0"), pool("g1"), pool("x", { homeSystemId: 7 })]),
      { ...PARAMS, invaderEconomy: on });
    const mob = two.intents.filter((i) => i.type === "MOBILIZE");
    assert.deepStrictEqual(mob.map((i) => [i.role, i.systemId, i.homeSystemId, i.stationId, i.purpose, i.cost]),
      [["garrison", HQ, HQ, null, HOME_POOL, { resourceUnits: 60, reserveUnits: 6 }]]);
    assert.ok(two.notes.includes("INVADER_HOME_POOL:3"), JSON.stringify(two.notes));
    assert.ok(!typesOf(two).includes("MERGE"), "a garrison with another home is not in the pool, nor merged alone");
    for (const n of ["INVADER_HOME_POOL:3", "INVADER_HOME_POOL_FULL"]) assert.ok(describeNote(n).known, n);
  });
};
