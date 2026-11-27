"use strict";

const assert = require("node:assert");

const { planBossResponse } = require("../../lib/strategy/ai/bossResponse");
const { decideReview } = require("../../lib/strategy/ai");
const { buildPowerTable, strengthOf } = require("../../lib/strategy/ai/strength");
const { createOperationKinds } = require("../../lib/strategy/kinds");
const { OPERATION_KINDS_VERSION, OPERATION_KINDS_V1 } = require("../../lib/strategy/data/operationKinds");
const { TARGET_SCORING_V1 } = require("../../lib/strategy/data/targetScoring");
const { DOCTRINES_V1 } = require("../../lib/strategy/data/doctrines");
const { FLEET_ROLES, OPERATION_TYPES, OBJECTIVES } = require("../../lib/fleets/schema");
const { GROUPS } = require("../../lib/battle/data/strengthCatalog");
const { CATALOG_V1, validateCatalog } = require("../../lib/worldBosses/catalog");
const { createWorldBossService } = require("../../lib/worldBosses/service");
const WF = require("../worldBosses/fixture");

const AT = 1760000000000;
const HOUR = 3600000;
const F = 7;
const DRIFTER = 500024;

const kinds = (() => {
  const k = createOperationKinds({ version: OPERATION_KINDS_VERSION, kinds: OPERATION_KINDS_V1 },
    { operationTypes: OPERATION_TYPES, objectives: OBJECTIVES, fleetRoles: FLEET_ROLES });
  assert.ok(k.ok, JSON.stringify(k));
  return k.kinds;
})();
const POWER = buildPowerTable(GROUPS);
const BR = Object.freeze({ maxPerReview: 1, rangeJumps: 6, strengthPermille: 600, windowMs: 6 * HOUR,
  maxTargetsRead: 4, minLeadMs: HOUR / 2, kinds: Object.freeze(["empire"]) });
const PARAMS = Object.freeze({ maxReachJumps: 10, supplyChainJumps: 10, captureRangeFromStationJumps: 5,
  maxAssemblyJumps: 8, maxBfsSystems: 2000, mobilizeFallbackJumps: 0, mobilizeFallbackMaxSystems: 2000,
  maxTargetCandidates: 40, targetPickTopK: 1, maxOperationsPerReview: 2, maxFleetsPerOperation: 4,
  maxFleetsPerFaction: 12, maxMobilizationsPerReview: 3, mobilizeResourcePerShip: 10, mobilizeReservePerShip: 1,
  attackStrengthRatio: 1.2, intelTtlMs: 6 * HOUR, maxObservationsPerReview: 8, reconWindowMs: HOUR / 2,
  attackWindowMs: 2 * HOUR, operationGraceMs: HOUR, maxHousekeepingPerReview: 4, maxRefitRequestsPerReview: 2,
  returnAfterIdleMs: HOUR / 2, returnWindowMs: 2 * HOUR, maxReturnsPerReview: 3,
  returnFleetRoles: [...kinds.get("return").fleetRoles],
  kinds: kinds.list, scoring: TARGET_SCORING_V1, powerTable: POWER, frontLimitCap: 2, routeMaxJumps: 40,
  siege: null, playerSiege: null, invaderCounter: null, bossResponse: BR });

const cruisers = (count) => [{ hullGroup: "cruiser", typeId: null, count }];

function fleet(fleetId, systemId, count) {
  const composition = cruisers(count);
  return { fleetId, version: 2, state: "IDLE", fleetRole: "invasion", systemId, refitPending: false,
    shipCount: count, strength: strengthOf(composition, POWER), composition, operationId: null, legSeq: 0,
    homeSystemId: 20, updatedAt: AT - 2 * HOUR };
}

const boss = (systemId, count, bossId = `wb${systemId}-1`, departAt = AT + 7 * HOUR) => ({ bossId, factionId: DRIFTER,
  state: "DWELL", systemId, arriveAt: null, departAt, phase: 1, composition: [{ hullGroup: "cruiser", count }] });

function snap(o = {}) {
  const row = (systemId, controllerFactionId) => ({ systemId, controllerFactionId, occupationState: "STABLE",
    controllerGarrison: 0, hostileStations: 0, observed: false });
  return { v: 1, factionId: F, round: 3, at: AT, seed: 11,
    faction: { status: "ACTIVE", homeSystemId: 20, doctrineId: "br", resourceUnits: 100000, reserveUnits: 10000,
      frontLimit: 1, version: 1 },
    entry: { kind: "empire", maxActiveFronts: 1, allies: [], homeRegionIds: [], ownerCorporationId: 1 },
    doctrine: { doctrineId: "br", canOccupy: false, reachJumps: 30, returnToBase: true,
      operationTypes: ["recon", "return", "counter"],
      templates: { scout: [{ hullGroup: "frigate", count: 1 }], patrol: [{ hullGroup: "cruiser", count: 2 }] } },
    theatre: [], expansion: [],
    neighbors: (id) => [id - 1, id + 1].filter((x) => x >= 1 && x <= 40), regionOf: () => null,
    isHostile: (x) => x === DRIFTER,
    stationsMode: "ready", stations: [{ systemId: 20, stationId: "st20" }],
    systems: [row(20, F)],
    fleets: o.fleets || [], fleetsTruncated: false, operations: [], operationsTruncated: false,
    intel: [], sightings: [], occupations: [], territory: [], territoryTruncated: false,
    siege: { mode: "off", attacking: [], defending: [], truncated: false },
    ...(o.bosses === null ? {} : { worldBosses: { mode: "ready", truncated: false, items: o.bosses || [] } }) };
}

const plan = (s, room = 2) => planBossResponse(s, PARAMS, new Set(), room, undefined);
const launches = (r) => r.intents.filter((i) => i.type === "LAUNCH");

module.exports = ({ test }) => {
  test("WBC4 planBossResponse: LAUNCH only at >= the threshold, <= 1 per review, decideReview carries it; no field = "
    + "nothing; bossTargetsOf: MOVING -> next_system_id", () => {
    const weak = plan(snap({ fleets: [fleet("c1", 20, 3)], bosses: [boss(24, 6)] }));
    assert.deepStrictEqual([launches(weak).length, weak.notes], [0, ["BOSS_RESPONSE_INSUFFICIENT:24"]]);
    const fleets = [fleet("c1", 20, 3), fleet("c2", 21, 2), fleet("c3", 19, 9)];
    const s = snap({ fleets, bosses: [boss(26, 6), boss(24, 6)] });
    const r = plan(s);
    assert.deepStrictEqual(launches(r).map((i) => [i.kind, i.target, i.mobilize.length, i.dueAt]),
      [["boss_response", { kind: "system", systemId: 24, ref: "wb24-1" }, 0, AT + 6 * HOUR]], "one per review");
    assert.deepStrictEqual(r.fleetIds, ["c2", "c1"]);
    assert.deepStrictEqual(r.notes, ["BOSS_RESPONSE_LAUNCH:24"]);
    const d = decideReview(s, PARAMS);
    assert.strictEqual(d.outcome, "REVIEWED", JSON.stringify(d));
    assert.ok(d.intents.some((i) => i.type === "LAUNCH" && i.kind === "boss_response" && i.target.systemId === 24),
      JSON.stringify(d.intents.map((i) => [i.type, i.kind])));
    assert.deepStrictEqual(plan(snap({ fleets, bosses: null })), { intents: [], notes: [], fleetIds: [] });
    assert.deepStrictEqual(planBossResponse(s, { ...PARAMS, bossResponse: null }, new Set(), 2),
      { intents: [], notes: [], fleetIds: [] });

    const units = JSON.stringify({ cruiser1: 40000, cruiser2: 0, cruiser3: 5, cruiser4: 1, cruiser5: 0, cruiser6: 9,
      strike1: 0, strike2: 7, strike3: 0, strike4: 0 });
    const row = (bossId, state, systemId, nextSystemId) => ({ bossId, kind: "drifter_swarm", factionId: DRIFTER,
      state, mode: "VIRTUAL", phase: 1, unitsJson: units, systemId, nextSystemId, nextDueAt: AT + HOUR });
    const repo = { listOpenInTx: () => ({ ok: true, rows: [row("a", "MOVING", 5, 6), row("b", "DWELL", 7, null),
      row("c", "MOVING", 6, 30)] }) };
    const svc = createWorldBossService({ store: {}, journal: {}, repo, worldSeed: 1, settings: WF.settingsFor(),
      kinds: validateCatalog(CATALOG_V1).kinds, getGraph: () => null });
    const t = svc.bossTargetsOf({}, [6, 7], 4);
    assert.deepStrictEqual(t, { ok: true, truncated: false, items: [
      { bossId: "a", kind: "drifter_swarm", factionId: DRIFTER, state: "MOVING", systemId: 6, arriveAt: AT + HOUR,
        departAt: AT + HOUR + WF.settingsFor().dwellMs, phase: 1, composition: [{ hullGroup: "cruiser", count: 5 }] },
      { bossId: "b", kind: "drifter_swarm", factionId: DRIFTER, state: "DWELL", systemId: 7, arriveAt: null,
        departAt: AT + HOUR, phase: 1, composition: [{ hullGroup: "cruiser", count: 5 }] }] });
    assert.deepStrictEqual(svc.bossTargetsOf({}, [6, 7], 1).truncated, true);
  });

  test("N1 () the real pirate doctrine serpentis-territorial-v2 -> LAUNCH boss_response, no "
    + "BOSS_RESPONSE_NO_KIND", () => {
    const serpentis = DOCTRINES_V1.find((d) => d.doctrineId === "serpentis-territorial-v2");
    assert.ok(serpentis.operationTypes.includes("counter"));
    const s = snap({ fleets: [fleet("c1", 20, 9)], bosses: [boss(24, 6)] });
    const r = plan({ ...s, entry: { ...s.entry, kind: "pirate" }, doctrine: { ...s.doctrine,
      doctrineId: serpentis.doctrineId, operationTypes: [...serpentis.operationTypes] } });
    assert.deepStrictEqual(launches(r).map((i) => [i.kind, i.target.systemId]), [["boss_response", 24]]);
    assert.ok(!r.notes.includes("BOSS_RESPONSE_NO_KIND"), JSON.stringify(r.notes));
  });

  test("N3 () dueAt = min(window, departAt), ref = bossId; LATE under minLeadMs; covered "
    + "per system", () => {
    const fleets = [fleet("c1", 20, 9)];
    const a = plan(snap({ fleets, bosses: [boss(24, 6, "wbA", AT + 2 * HOUR)] }));
    assert.deepStrictEqual(launches(a).map((i) => [i.target, i.dueAt]),
      [[{ kind: "system", systemId: 24, ref: "wbA" }, AT + 2 * HOUR]]);
    for (const departAt of [AT + HOUR / 2 - 1, null]) {
      const b = plan(snap({ fleets, bosses: [boss(24, 6, "wbB", departAt)] }));
      assert.deepStrictEqual([launches(b).length, b.notes], [0, ["BOSS_RESPONSE_LATE:24"]], String(departAt));
    }
    assert.strictEqual(launches(plan(snap({ fleets, bosses: [boss(24, 6, "wbB", AT + HOUR / 2)] }))).length, 1);
    const open = [{ operationId: "o1", state: "ACTIVE", operationType: "counter", targetSystemId: 23 }];
    const y = plan({ ...snap({ fleets, bosses: [boss(24, 6)] }), operations: open });
    assert.deepStrictEqual(launches(y).map((i) => i.target.systemId), [24]);
    const x = plan({ ...snap({ fleets, bosses: [boss(23, 6)] }), operations: open });
    assert.deepStrictEqual([launches(x).length, x.notes], [0, []]);
  });
};
