"use strict";

const assert = require("node:assert");

const D = require("../../lib/garrisonPatrol/defense");
const GS = require("../../lib/garrisonPatrol/schema");
const { decidePatrolStep, PHASES } = require("../../lib/garrisonPatrol/phases");

const OWNER = 500019;
const OTHER = 500010;
const pos = (x, y = 0, z = 0) => ({ x, y, z });

module.exports = ({ test }) => {
  test("GDF1 gate defense T1: pickDefenseFleets filters and orders, arrivalGateOf nearest within the radius, ownerOf "
    + "controller > SDE > null, parseKindList", () => {
    const fleet = (fleetId, extra) => ({ fleetId, factionId: OWNER, fleetRole: "garrison", state: "IDLE",
      operationId: null, refitPending: false, shipCount: 3, ...extra });
    const fleets = [
      fleet("f-other", { factionId: OTHER }),
      fleet("f-role", { fleetRole: "logistics" }),
      fleet("f-refit", { refitPending: true }),
      fleet("f-raid", { state: "STAGED", operationId: "op-raid" }),
      fleet("f-idle-op", { operationId: "op-patrol" }),
      fleet("f-empty", { shipCount: 0 }),
      fleet("f-b", { shipCount: 3 }),
      fleet("f-a", { shipCount: 3, fleetRole: "patrol" }),
      fleet("f-big", { shipCount: 8, fleetRole: "hunter" }),
      fleet("f-staged", { state: "STAGED", operationId: "op-patrol", shipCount: 5 }),
      fleet("f-travel", { state: "TRAVELLING" }),
    ];
    const ops = new Map([["op-raid", { operationType: "raid" }], ["op-patrol", { operationType: "patrol" }]]);
    const o = { ownerFactionId: OWNER, roles: ["garrison", "patrol", "invasion", "hunter"], kinds: ["pirate"],
      unstageOperationTypes: ["patrol", "reinforce"], excludedFactions: [], factionKindOf: () => "pirate" };
    const picked = D.pickDefenseFleets(fleets, ops, o);
    assert.deepStrictEqual(picked.map((p) => [p.fleet.fleetId, p.unstage]),
      [["f-big", false], ["f-staged", true], ["f-a", false], ["f-b", false]]);
    assert.deepStrictEqual(D.pickDefenseFleets(fleets, ops, { ...o, unstageOperationTypes: [] })
      .map((p) => p.fleet.fleetId), ["f-big", "f-a", "f-b"], "none -> never unstage");
    assert.deepStrictEqual(D.pickDefenseFleets(fleets, ops, { ...o, kinds: ["empire"] }), [], "kind not listed");
    assert.deepStrictEqual(D.pickDefenseFleets(fleets, ops, { ...o, excludedFactions: [OWNER] }), [], "excluded");
    assert.deepStrictEqual(D.pickDefenseFleets(fleets, ops, { ...o, factionKindOf: () => {
      throw new Error("x");
    } }), [], "a throwing kind lookup -> nothing");
    assert.deepStrictEqual(D.pickDefenseFleets(null, ops, o), []);

    const gates = [{ itemId: 9, position: pos(10000) }, { itemId: 7, position: pos(-10000) },
      { itemId: 5, position: pos(40000) }, { itemId: 3.5, position: pos(0) }, { itemId: 4 }];
    assert.strictEqual(D.arrivalGateOf(gates, pos(0), 50000).itemId, 7, "tie -> the smaller itemId");
    assert.strictEqual(D.arrivalGateOf(gates, pos(37000), 50000).itemId, 5, "nearest");
    assert.strictEqual(D.arrivalGateOf(gates, pos(400000), 50000), null, "outside the radius");
    assert.strictEqual(D.arrivalGateOf(gates, null, 50000), null);

    assert.strictEqual(D.ownerOf({ controllerFactionId: OTHER, sdeFactionId: OWNER }), OTHER);
    assert.strictEqual(D.ownerOf({ controllerFactionId: null, sdeFactionId: OWNER }), OWNER);
    assert.strictEqual(D.ownerOf({ controllerFactionId: undefined, sdeFactionId: null }), null);
    assert.strictEqual(D.ownerOf(null), null);

    assert.deepStrictEqual(GS.parseKindList(" pirate,empire "), ["pirate", "empire"]);
    for (const bad of ["", "pirate,pirate", "pirate,,empire", "dragon", null]) {
      assert.strictEqual(GS.parseKindList(bad), null, String(bad));
    }
  });

  test("GDX2: exitGateOf id before point, point within the radius, cloaked / capsule "
    + "null; decidePatrolStep CAMP_HOLD + relocateTo -> CAMP_WARP + warp, landed -> CAMP_HOLD, targets -> ENGAGED "
    + "(pending relocation cancelled), a bad point -> cancelled", () => {
    const gates = [{ itemId: 50000002, position: pos(1e6) }, { itemId: 50000009, position: pos(9e6) },
      { itemId: "x", position: pos(0) }];
    const near2 = pos(1e6 + 50000);
    assert.strictEqual(D.exitGateOf(gates, { warpTarget: near2, warpTargetEntityId: 50000009 }, 100000).itemId,
      50000009, "the id wins over a nearer point");
    assert.strictEqual(D.exitGateOf(gates, { warpTarget: near2, warpTargetEntityId: 777 }, 100000).itemId, 50000002);
    assert.strictEqual(D.exitGateOf(gates, { warpTarget: near2, warpTargetEntityId: null }, 10000), null, "radius");
    assert.strictEqual(D.exitGateOf(gates, { warpTarget: null, warpTargetEntityId: null }, 100000), null);
    assert.strictEqual(D.exitGateOf(gates, { warpTargetEntityId: 50000009, cloaked: true }, 100000), null);
    assert.strictEqual(D.exitGateOf(gates, { warpTargetEntityId: 50000009, capsule: true }, 100000), null);
    assert.strictEqual(D.exitGateOf(null, null, 100000), null);
    assert.strictEqual(GS.TRIGGER_EXIT, "exit");

    const params = { objectDwellMs: 60000, warpTimeoutMs: 60000, warpStartGraceMs: 6000, reacquireGraceMs: 20000,
      exitGraceMs: 30000, maxLiveMs: 0 };
    const ship = (inWarp) => [{ entityId: 1, inWarp, position: pos(0) }];
    const facts = (now, extra) => ({ now, sceneLoaded: true, ownAlive: ship(false), hostilesOnGrid: [], present: true,
      ...extra });
    const to = { itemId: 50000009, point: pos(9e6 - 15000) };
    const hold = { mode: "GATE_CAMP", phase: PHASES.CAMP_HOLD, phaseSince: 0, objects: [{ point: to.point }],
      objectIndex: 0, liveSince: 0, absentSince: null, noTargetSince: null, warpSeen: false, spawnConfirmed: true,
      relocateTo: to };
    const d1 = decidePatrolStep(hold, facts(1000), params);
    assert.deepStrictEqual([d1.phase, d1.phaseSince, d1.relocateTo, d1.relocated, d1.relocateCancelled, d1.actions],
      [PHASES.CAMP_WARP, 1000, null, 50000009, false, [{ type: "warp", point: to.point, objectIndex: 0 }]]);
    const warping = { ...hold, phase: d1.phase, phaseSince: d1.phaseSince, relocateTo: null, warpSeen: false };
    const d2 = decidePatrolStep(warping, facts(2000, { ownAlive: ship(true) }), params);
    assert.deepStrictEqual([d2.phase, d2.warpSeen, d2.warpEnd], [PHASES.CAMP_WARP, true, null]);
    const d3 = decidePatrolStep({ ...warping, warpSeen: true }, facts(3000), params);
    assert.deepStrictEqual([d3.phase, d3.warpEnd, d3.actions], [PHASES.CAMP_HOLD, "landed", []]);
    const d4 = decidePatrolStep(warping, facts(2000, { hostilesOnGrid: [9001] }), params);
    assert.deepStrictEqual([d4.phase, d4.relocateCancelled, d4.actions[0].type], [PHASES.ENGAGED, false, "attack"]);
    const d5 = decidePatrolStep(hold, facts(1000, { hostilesOnGrid: [9001] }), params);
    assert.deepStrictEqual([d5.phase, d5.relocateTo, d5.relocateCancelled], [PHASES.ENGAGED, null, true]);
    const d6 = decidePatrolStep({ ...hold, relocateTo: { itemId: 50000009, point: null } }, facts(1000), params);
    assert.deepStrictEqual([d6.phase, d6.relocateTo, d6.relocateCancelled, d6.actions],
      [PHASES.CAMP_HOLD, null, true, []]);
    const d7 = decidePatrolStep({ ...hold, relocateTo: undefined }, facts(1000), params);
    assert.deepStrictEqual([d7.phase, d7.relocateTo, d7.relocated, d7.relocateCancelled],
      [PHASES.CAMP_HOLD, null, null, false]);
  });
};
