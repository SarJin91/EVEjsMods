"use strict";

const assert = require("node:assert");

const { planCapsuleerPursuit } = require("../../../lib/strategy/ai/capsuleerPursuit");
const { decideReview } = require("../../../lib/strategy/ai");
const { buildPowerTable, strengthOf } = require("../../../lib/strategy/ai/strength");
const { createOperationKinds } = require("../../../lib/strategy/kinds");
const { OPERATION_KINDS_VERSION, OPERATION_KINDS_V1 } = require("../../../lib/strategy/data/operationKinds");
const { TARGET_SCORING_V1 } = require("../../../lib/strategy/data/targetScoring");
const { FLEET_ROLES, OPERATION_TYPES, OBJECTIVES } = require("../../../lib/fleets/schema");
const { GROUPS } = require("../../../lib/battle/data/strengthCatalog");
const { describeNote } = require("../../../lib/strategy/activity/notes");

const AT = 1760000000000;
const HOUR = 3600000;
const F = 7;
const HOSTILE = 9;

const kinds = (() => {
  const k = createOperationKinds({ version: OPERATION_KINDS_VERSION, kinds: OPERATION_KINDS_V1 },
    { operationTypes: OPERATION_TYPES, objectives: OBJECTIVES, fleetRoles: FLEET_ROLES });
  assert.ok(k.ok, JSON.stringify(k));
  return k.kinds;
})();
const POWER = buildPowerTable(GROUPS);
const PURSUIT = Object.freeze({ maxPerReview: 1, maxJumps: 6, minShipRatioPermille: 1500, windowMs: HOUR,
  readLimit: 64, maxFleetsScanned: 32 });
const RAID = Object.freeze({ maxPerReview: 1, windowMs: HOUR, maxJumps: 5, minShips: 3, minShipRatioPermille: 1000,
  minShiftLeftMs: HOUR / 2, highsec: false, maxFleetsScanned: 12 });

const PARAMS = Object.freeze({ maxReachJumps: 10, supplyChainJumps: 10, captureRangeFromStationJumps: 5,
  maxAssemblyJumps: 8, maxBfsSystems: 2000, mobilizeFallbackJumps: 0, mobilizeFallbackMaxSystems: 2000,
  maxTargetCandidates: 40, targetPickTopK: 1, maxOperationsPerReview: 2, maxFleetsPerOperation: 4,
  maxFleetsPerFaction: 12, maxMobilizationsPerReview: 3, mobilizeResourcePerShip: 10, mobilizeReservePerShip: 1,
  attackStrengthRatio: 1.2, intelTtlMs: 6 * HOUR, maxObservationsPerReview: 8, reconWindowMs: HOUR / 2,
  attackWindowMs: 2 * HOUR, operationGraceMs: HOUR, maxHousekeepingPerReview: 4, maxRefitRequestsPerReview: 2,
  returnAfterIdleMs: HOUR / 2, returnWindowMs: 2 * HOUR, maxReturnsPerReview: 3,
  returnFleetRoles: [...kinds.get("return").fleetRoles],
  kinds: kinds.list, scoring: TARGET_SCORING_V1, powerTable: POWER, frontLimitCap: 2, routeMaxJumps: 40,
  capsuleerPursuit: PURSUIT });

const comp = (count) => [{ hullGroup: "cruiser", typeId: null, count }];
function patrol(fleetId, systemId, ships) {
  return { fleetId, version: 2, state: "IDLE", fleetRole: "patrol", systemId, refitPending: false, shipCount: ships,
    strength: strengthOf(comp(ships), POWER), operationId: null, legSeq: 0, homeSystemId: 20,
    updatedAt: AT - 2 * HOUR, composition: comp(ships) };
}
const caps = (systemId, ships, fleetId = `c${systemId}`) => ({ systemId, fleetId, ships });

function snap(o = {}) {
  const row = (systemId, controllerFactionId, homeFactionId = null) => ({ systemId, controllerFactionId,
    homeFactionId, occupationState: "STABLE", controllerGarrison: 0, hostileStations: 0, observed: false });
  const s = { v: 1, factionId: F, round: 3, at: AT, seed: 11,
    faction: { status: "ACTIVE", homeSystemId: 20, doctrineId: "cp", resourceUnits: 100000,
      reserveUnits: 10000, frontLimit: 1, version: 1 },
    entry: { kind: "pirate", maxActiveFronts: 1, allies: [], homeRegionIds: [], ownerCorporationId: 1 },
    doctrine: { doctrineId: "cp", canOccupy: false, reachJumps: 30, returnToBase: true,
      operationTypes: ["recon", "raid", "return"],
      templates: { scout: [{ hullGroup: "frigate", count: 1 }], patrol: [{ hullGroup: "cruiser", count: 2 }] } },
    theatre: [14], expansion: [],
    neighbors: (id) => [id - 1, id + 1].filter((x) => x >= 1 && x <= 40), regionOf: () => null,
    isHostile: (x) => x === HOSTILE,
    stationsMode: "ready", stations: [{ systemId: 20, stationId: "st20" }],
    systems: [row(14, HOSTILE), row(18, F, F), row(20, F, F), row(22, F), row(26, HOSTILE)],
    fleets: o.fleets || [patrol("p20", 20, 6)], fleetsTruncated: false, operations: [],
    operationsTruncated: false, intel: [], sightings: [], occupations: [], territory: [], territoryTruncated: false };
  if (o.capsuleerTargets !== null) {
    s.capsuleerTargets = o.capsuleerTargets || { targets: [caps(18, 3)], truncated: false };
  }
  if (o.minerTargets) s.minerTargets = o.minerTargets;
  return s;
}

const plan = (s, o = {}) => planCapsuleerPursuit(s, {}, { ...PARAMS, ...(o.params || {}) },
  o.used || new Set(), o.room === undefined ? 2 : o.room, o.opts);
const pursuits = (d) => d.intents.filter((i) => i.type === "LAUNCH" && i.purpose === "CAPSULEER_PURSUIT");
const ganks = (d) => d.intents.filter((i) => i.type === "LAUNCH" && i.kind === "gank" && !i.purpose);

module.exports = ({ test }) => {
  test("T1 capsuleer STAGED in the home system + idle patrol (6) 2 jumps away -> LAUNCH gank CAPSULEER_PURSUIT, "
    + "note CAPSULEER_PURSUIT:<T>, the fleet joins used; deterministic", () => {
    const used = new Set();
    const r = plan(snap(), { used });
    assert.deepStrictEqual(r.intents, [{ type: "LAUNCH", kind: "gank",
      target: { kind: "system", systemId: 18, ref: null }, originSystemId: 20,
      fleets: [{ fleetId: "p20", expectedVersion: 2 }], mobilize: [], dueAt: AT + HOUR,
      purpose: "CAPSULEER_PURSUIT" }]);
    assert.deepStrictEqual([r.notes, r.seen], [["CAPSULEER_PURSUIT:18"], 1]);
    assert.ok(used.has("p20"));
    assert.deepStrictEqual(plan(snap()), plan(snap()));
  });

  test("T2 capsuleer in a system the faction does not control -> no intent, seen 0", () => {
    const r = plan(snap({ capsuleerTargets: { targets: [caps(26, 1)], truncated: false } }));
    assert.deepStrictEqual(r, { intents: [], notes: [], seen: 0 });
  });

  test("T3 the only fleet in range too weak -> CAPSULEER_PURSUIT_TOO_WEAK; room 0 -> CAPSULEER_PURSUIT_NO_ROOM", () => {
    const weak = plan(snap({ capsuleerTargets: { targets: [caps(18, 5)], truncated: false } }));
    assert.deepStrictEqual([weak.intents, weak.notes], [[], ["CAPSULEER_PURSUIT_TOO_WEAK"]]);
    const noRoom = plan(snap(), { room: 0 });
    assert.deepStrictEqual([noRoom.intents, noRoom.notes, noRoom.seen], [[], ["CAPSULEER_PURSUIT_NO_ROOM"], 1]);
    for (const n of ["CAPSULEER_PURSUIT", "CAPSULEER_PURSUIT_NO_FLEET", "CAPSULEER_PURSUIT_TOO_WEAK",
      "CAPSULEER_PURSUIT_NO_ROOM", "CAPSULEER_PURSUIT_TARGETS_TRUNCATED"]) {
      assert.strictEqual(describeNote(n).known, true, n);
    }
  });

  test("T4 home system (1 ship) and an own non-home system (5 ships), maxPerReview 1 -> the home system", () => {
    const r = plan(snap({ fleets: [patrol("p20", 20, 10)],
      capsuleerTargets: { targets: [caps(22, 5), caps(18, 1)], truncated: false } }));
    assert.deepStrictEqual([r.intents.map((i) => i.target.systemId), r.seen], [[18], 2]);
  });

  test("JCR3: skipForeignBastions on -> no pursuit in an own controlled system with a "
    + "foreign NPC bastion (note CAPSULEER_PURSUIT_FOREIGN_BASTION), the other target taken; flag off -> as before", () => {
    const two = { targets: [caps(18, 3), caps(22, 3)], truncated: false };
    const owners = new Map([[18, 500016]]);
    const on = { capsuleerPursuit: { ...PURSUIT, skipForeignBastions: true } };
    const r = plan({ ...snap({ capsuleerTargets: two }), bastionOwners: owners }, { params: on });
    assert.deepStrictEqual([pursuits(r).map((i) => i.target.systemId), r.notes, r.seen],
      [[22], ["CAPSULEER_PURSUIT_FOREIGN_BASTION", "CAPSULEER_PURSUIT:22"], 2]);
    const off = plan({ ...snap({ capsuleerTargets: two }), bastionOwners: owners });
    assert.deepStrictEqual([pursuits(off).map((i) => i.target.systemId), off.notes], [[18], ["CAPSULEER_PURSUIT:18"]]);
    const all = plan({ ...snap(), bastionOwners: owners }, { params: on });
    assert.deepStrictEqual(all, { intents: [], notes: ["CAPSULEER_PURSUIT_FOREIGN_BASTION"], seen: 1 });
    assert.strictEqual(describeNote("CAPSULEER_PURSUIT_FOREIGN_BASTION").known, true);
  });

  test("JCR2: an own bastion is never excluded from the pursuit", () => {
    const r = plan({ ...snap(), bastionOwners: new Map([[18, F]]) },
      { params: { capsuleerPursuit: { ...PURSUIT, skipForeignBastions: true } } });
    assert.deepStrictEqual([pursuits(r).map((i) => i.target.systemId), r.notes], [[18], ["CAPSULEER_PURSUIT:18"]]);
  });

  test("T5 flag off -> decideReview identical without the key and the field; the miner raids get the same fleets and "
    + "room; flag on -> the pursuit LAUNCH and capsuleerPursuitsSeen", () => {
    const miners = { targets: [{ tripId: "t24", factionId: HOSTILE, fleetId: "m24", systemId: 24, secClass: "lowsec",
      miningEndsAt: AT + 2 * HOUR, ships: 3 }], truncated: false };
    const fleets = [patrol("p20", 20, 6), patrol("p21", 21, 6)];
    const { capsuleerPursuit: _c, ...noKey } = PARAMS;
    const withRaid = { ...PARAMS, minerRaid: RAID };
    const off = decideReview(snap({ fleets, minerTargets: miners }), { ...withRaid, capsuleerPursuit: null });
    assert.strictEqual(off.outcome, "REVIEWED", JSON.stringify(off.reason));
    assert.deepStrictEqual(off, decideReview(snap({ fleets, minerTargets: miners, capsuleerTargets: null }),
      { ...noKey, minerRaid: RAID }));
    assert.ok(!("capsuleerPursuitsSeen" in off) && pursuits(off).length === 0
      && !off.notes.some((n) => n.startsWith("CAPSULEER_PURSUIT")), JSON.stringify(off.notes));
    assert.deepStrictEqual(ganks(off).map((i) => i.fleets[0].fleetId), ["p20"], JSON.stringify(off.intents));

    const on = decideReview(snap({ fleets, minerTargets: miners }), withRaid);
    assert.deepStrictEqual([pursuits(on).map((i) => [i.target.systemId, i.fleets[0].fleetId]),
      on.capsuleerPursuitsSeen], [[[18, "p20"]], 1], JSON.stringify(on.notes));
    assert.deepStrictEqual(ganks(on), [], JSON.stringify(on.intents));
    const wide = decideReview(snap({ fleets, minerTargets: miners }), { ...withRaid, maxOperationsPerReview: 3 });
    assert.deepStrictEqual([pursuits(wide).map((i) => i.fleets[0].fleetId), ganks(wide).map((i) => i.fleets[0].fleetId)],
      [["p20"], ["p21"]], JSON.stringify(wide.intents));
  });
};
