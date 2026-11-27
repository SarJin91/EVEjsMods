"use strict";

const assert = require("node:assert");

const { markHqHolders, planHqReturn, HQ_HOLDING, HQ_RETURN } = require("../../lib/strategy/ai/hqGarrison");
const { decideReview } = require("../../lib/strategy/ai");
const { buildPowerTable, strengthOf } = require("../../lib/strategy/ai/strength");
const { createOperationKinds } = require("../../lib/strategy/kinds");
const { OPERATION_KINDS_VERSION, OPERATION_KINDS_V1 } = require("../../lib/strategy/data/operationKinds");
const { TARGET_SCORING_V1 } = require("../../lib/strategy/data/targetScoring");
const { DOCTRINES_V1 } = require("../../lib/strategy/data/doctrines");
const { FLEET_ROLES, OPERATION_TYPES, OBJECTIVES } = require("../../lib/fleets/schema");
const { GROUPS } = require("../../lib/battle/data/strengthCatalog");

const AT = 1760000000000;
const HOUR = 3600000;
const FACTION = 500010;
const HQ = 1;

const kinds = (() => {
  const k = createOperationKinds({ version: OPERATION_KINDS_VERSION, kinds: OPERATION_KINDS_V1 },
    { operationTypes: OPERATION_TYPES, objectives: OBJECTIVES, fleetRoles: FLEET_ROLES });
  assert.ok(k.ok, JSON.stringify(k));
  return k.kinds;
})();
const POWER = buildPowerTable(GROUPS);
const wing = (count) => [{ hullGroup: "cruiser", typeId: null, count }];

const HQ_PARAMS = Object.freeze({ minFleets: 1, roles: Object.freeze(["garrison", "patrol", "invasion"]),
  maxJumps: 10, windowMs: HOUR });
const PARAMS = Object.freeze({ maxReachJumps: 10, supplyChainJumps: 10, captureRangeFromStationJumps: 15,
  maxAssemblyJumps: 15, maxBfsSystems: 2000, mobilizeFallbackJumps: 0, mobilizeFallbackMaxSystems: 2000,
  maxTargetCandidates: 40, targetPickTopK: 1, maxOperationsPerReview: 2, maxFleetsPerOperation: 4,
  maxFleetsPerFaction: 32, maxMobilizationsPerReview: 3, mobilizeResourcePerShip: 10, mobilizeReservePerShip: 1,
  attackStrengthRatio: 1.2, intelTtlMs: 6 * HOUR, maxObservationsPerReview: 12, reconWindowMs: HOUR / 2,
  attackWindowMs: 2 * HOUR, operationGraceMs: HOUR, maxHousekeepingPerReview: 4, maxRefitRequestsPerReview: 2,
  maxReturnsPerReview: 2, kinds: kinds.list, scoring: TARGET_SCORING_V1, powerTable: POWER, frontLimitCap: 6,
  routeMaxJumps: 40, maxCapturedSystemsPerFaction: 150, captureRequiresAdjacency: true, footholdHold: null,
  hqGarrison: null });
const ON = Object.freeze({ ...PARAMS, hqGarrison: HQ_PARAMS });

const fleet = (fleetId, systemId, fleetRole = "invasion", extra = {}) => ({ fleetId, version: 2, state: "IDLE",
  fleetRole, systemId, refitPending: false, shipCount: extra.ships || 6, strength: strengthOf(wing(extra.ships || 6),
    POWER), operationId: null, legSeq: 0, homeSystemId: systemId, updatedAt: AT - HOUR, ...extra });

function snap(fleets, operations = []) {
  const d = DOCTRINES_V1.find((x) => x.doctrineId === "pirate-territorial-v2");
  return { v: 1, factionId: FACTION, round: 3, at: AT, seed: 11,
    faction: { status: "ACTIVE", homeSystemId: HQ, doctrineId: d.doctrineId, resourceUnits: 100000,
      reserveUnits: 10000, frontLimit: 6, version: 1 },
    entry: { kind: "pirate", maxActiveFronts: 1, allies: [], homeRegionIds: [], ownerCorporationId: 1, hqSystemId: HQ },
    doctrine: d, theatre: [], expansion: [], raidTargets: [],
    border: { mode: "off", reach: null, captures: false, candidates: [], rejected: 0 },
    neighbors: (id) => [id - 1, id + 1].filter((x) => x >= 1 && x <= 20), regionOf: () => null,
    isHostile: () => false, stationsMode: "ready", stations: [], captureAnchors: [],
    systems: [], fleets, fleetsTruncated: false, operations, operationsTruncated: false, intel: [], sightings: [],
    occupations: [], territory: [], territoryTruncated: false, capturedIds: [], footholds: [] };
}

module.exports = ({ test }) => {
  test("HQ1: garrison and invasion IDLE in the HQ, minFleets 1 -> the garrison is pinned (HQ_HOLD)", () => {
    const s = snap([fleet("i1", HQ, "invasion", { ships: 9 }), fleet("g1", HQ, "garrison", { ships: 3 })]);
    const pseudo = new Map();
    assert.deepStrictEqual(markHqHolders(s, ON, pseudo), ["HQ_HOLD"]);
    assert.deepStrictEqual([...pseudo], [["g1", HQ_HOLDING]]);
    const held = new Map([["i1", "SIEGING"]]);
    assert.deepStrictEqual(markHqHolders(s, ON, held), []);
    assert.deepStrictEqual([...held], [["i1", "SIEGING"]]);
  });

  test("HQ2: empty HQ -> LAUNCH patrol HQ_RETURN of the free fleet 3 jumps away, not the foothold holder, not "
    + "the fleet 12 jumps away; no candidate -> HQ_UNHELD", () => {
    const near = fleet("n1", 4);
    const fleets = [fleet("fh", 2, "invasion", { state: "FOOTHOLD_HOLDING" }), near, fleet("far", 13)];
    const used = new Set();
    const r = planHqReturn(snap(fleets), ON, used, 1);
    assert.deepStrictEqual(r.intents, [{ type: "LAUNCH", kind: "patrol",
      target: { kind: "system", systemId: HQ, ref: null }, originSystemId: 4,
      fleets: [{ fleetId: "n1", expectedVersion: 2 }], mobilize: [], dueAt: AT + HOUR, purpose: HQ_RETURN }]);
    assert.deepStrictEqual(r.notes, [`HQ_RETURN:${HQ}`]);
    assert.deepStrictEqual([...used], ["n1"]);
    const none = planHqReturn(snap(fleets.filter((x) => x !== near)), ON, new Set(), 1);
    assert.deepStrictEqual(none, { intents: [], notes: ["HQ_UNHELD"] });
    const deathless = DOCTRINES_V1.find((x) => x.doctrineId === "deathless-invader-v1");
    assert.ok(!deathless.operationTypes.includes("patrol"), JSON.stringify(deathless.operationTypes));
    const inv = planHqReturn({ ...snap(fleets), doctrine: deathless,
      entry: { ...snap(fleets).entry, kind: "invader" } }, ON, new Set(), 1);
    assert.deepStrictEqual(inv.intents.map((i) => [i.purpose, i.fleets[0].fleetId]), [[HQ_RETURN, "n1"]]);
  });

  test("HQ3: a fleet PLANNED to the HQ counts -> no new LAUNCH, no HQ_UNHELD", () => {
    const s = snap([fleet("p1", 6, "invasion", { state: "PLANNED", operationId: "op1" }), fleet("n1", 4)],
      [{ operationId: "op1", state: "PLANNED", targetSystemId: HQ, operationType: "patrol" }]);
    assert.deepStrictEqual(planHqReturn(s, ON, new Set(), 1), { intents: [], notes: [] });
  });

  test("HQ4: params.hqGarrison null -> decideReview as without the module; on -> HQ_RETURN", () => {
    const s = snap([fleet("n1", 4), fleet("n2", 5)]);
    const { hqGarrison: _drop, ...bare } = PARAMS;
    const off = decideReview(s, PARAMS);
    assert.strictEqual(off.outcome, "REVIEWED", off.reason);
    assert.deepStrictEqual(off, decideReview(s, bare));
    assert.ok(!off.notes.some((n) => n.startsWith("HQ_")), JSON.stringify(off.notes));
    assert.ok(!off.intents.some((i) => i.purpose === HQ_RETURN), JSON.stringify(off.intents));
    const on = decideReview(s, ON);
    assert.strictEqual(on.outcome, "REVIEWED", on.reason);
    const hq = on.intents.filter((i) => i.purpose === HQ_RETURN);
    assert.deepStrictEqual(hq.map((i) => [i.target.systemId, i.fleets[0].fleetId]), [[HQ, "n1"]],
      JSON.stringify(on.intents));
    assert.ok(on.notes.includes(`HQ_RETURN:${HQ}`), JSON.stringify(on.notes));
  });
};
