"use strict";

const assert = require("node:assert");

const { decideRetreat, pickExitObject } = require("../../lib/playerHunt/exit");
const { decideHuntStep, PHASES } = require("../../lib/playerHunt/phases");

const T0 = 1000000;
const pos = (x) => ({ x, y: 0, z: 0 });
const P = Object.freeze({ objectDwellMs: 30000, warpTimeoutMs: 60000, reacquireGraceMs: 20000, exitGraceMs: 30000,
  maxDurationMs: 1200000, maxObjectsPerHunt: 3 });
const ON = Object.freeze({ ...P, exitEnabled: true, retreatEnabled: true, retreatLossPermille: 500,
  retreatOutnumberPermille: 2000 });
const OFF = Object.freeze({ ...ON, exitEnabled: false, retreatEnabled: false });
const OBJECTS = Object.freeze([{ kind: "stargate", itemId: 1, position: pos(0) },
  { kind: "station", itemId: 2, position: pos(1e7) }, { kind: "planet", itemId: 3, position: pos(2e7) }]);
const EXIT = pos(5e9);
const SHIPS3 = Object.freeze([{ entityId: 11, inWarp: false }, { entityId: 12, inWarp: false },
  { entityId: 13, inWarp: false }]);

function entry(extra = {}) {
  return { phase: PHASES.SWEEP_DWELL, phaseSince: T0, objects: OBJECTS, objectIndex: 0, visited: 1, liveSince: T0,
    quarryAbsentSince: null, noTargetSince: null, spawnConfirmed: true, ...extra };
}

function facts(now, extra = {}) {
  return { now, sceneLoaded: true, quarry: { state: "space", ship: { capsule: false } }, ownAlive: SHIPS3,
    hostilesOnGrid: [], members: 3, watched: true, exitPoint: EXIT, ...extra };
}

function legacy(d) {
  assert.deepStrictEqual([d.exitReason, d.exitPursuitTarget], [null, null]);
  const { exitReason, exitPursuitTarget, ...rest } = d;
  return rest;
}

module.exports = ({ test }) => {
  test("PX1 decideRetreat (LOSSES on / under the threshold, OUTNUMBERED, 0 = off, flag off) "
    + "pickExitObject (gate to preferToSystemId, farthest, tie by itemId, empty), phases EXITING / landed / WIPED / "
    + "RETREATED, flags off = the result of before", () => {
    const R = { retreatEnabled: true, retreatLossPermille: 500, retreatOutnumberPermille: 2000 };
    assert.deepStrictEqual(decideRetreat({ members: 4, alive: 2, hostiles: 0 }, R), { retreat: true, why: "LOSSES" });
    assert.deepStrictEqual(decideRetreat({ members: 3, alive: 2, hostiles: 0 }, R), { retreat: false });
    assert.deepStrictEqual(decideRetreat({ members: 3, alive: 3, hostiles: 6 }, R),
      { retreat: true, why: "OUTNUMBERED" });
    assert.deepStrictEqual(decideRetreat({ members: 3, alive: 3, hostiles: 5 }, R), { retreat: false });
    assert.deepStrictEqual(decideRetreat({ members: 3, alive: 3, hostiles: 60 }, { ...R, retreatOutnumberPermille: 0 }),
      { retreat: false });
    assert.deepStrictEqual(decideRetreat({ members: 4, alive: 1, hostiles: 9 }, { ...R, retreatEnabled: false }),
      { retreat: false });
    assert.deepStrictEqual(decideRetreat({ members: 3, alive: 1, hostiles: 0, lost: 0 }, R), { retreat: false });
    assert.deepStrictEqual(decideRetreat({ members: 4, alive: 2, hostiles: 0, lost: 2 }, R),
      { retreat: true, why: "LOSSES" });

    const objs = [{ kind: "stargate", itemId: 5, position: pos(0), toSystemId: 77 },
      { kind: "planet", itemId: 1, position: pos(1e12) },
      { kind: "station", itemId: 9, position: pos(-1e10) },
      { kind: "stargate", itemId: 3, position: pos(1e10), toSystemId: 88 }];
    assert.strictEqual(pickExitObject(objs, { preferToSystemId: 77, awayFrom: pos(0) }).itemId, 5);
    assert.deepStrictEqual(pickExitObject(objs, { preferToSystemId: 99, awayFrom: pos(1e10) }),
      { kind: "station", itemId: 9, position: pos(-1e10) }, "farthest; the planet is no exit");
    assert.strictEqual(pickExitObject(objs, { preferToSystemId: null, awayFrom: pos(0) }).itemId, 3, "tie: itemId");
    assert.strictEqual(pickExitObject(objs, { preferToSystemId: null, awayFrom: null }).itemId, 3,
      "no position: stargate first, then itemId");
    assert.strictEqual(pickExitObject([], { preferToSystemId: 77, awayFrom: pos(0) }), null);

    const now = T0 + P.exitGraceMs;
    const gone = facts(now, { quarry: { state: "absent", ship: null } });
    let d = decideHuntStep(entry({ quarryAbsentSince: T0 }), gone, ON);
    assert.deepStrictEqual([d.phase, d.phaseSince, d.end, d.exitReason, d.warpSeen],
      [PHASES.EXITING, now, null, "TARGET_GONE", false]);
    assert.deepStrictEqual(d.actions, [{ type: "search" }, { type: "warp", point: EXIT }]);
    const exiting = entry({ phase: PHASES.EXITING, phaseSince: now, exitReason: "TARGET_GONE", warpSeen: false });
    d = decideHuntStep(exiting, facts(now + 1000, { ownAlive: [{ entityId: 11, inWarp: true }], hostilesOnGrid: [9] }),
      ON);
    assert.deepStrictEqual([d.phase, d.end, d.warpSeen, d.actions], [PHASES.EXITING, null, true, []],
      "in warp: no attack, no end");
    d = decideHuntStep({ ...exiting, warpSeen: true }, facts(now + 2000), ON);
    assert.deepStrictEqual([d.end, d.exitWarp], [{ reason: "TARGET_GONE" }, "landed"]);
    d = decideHuntStep(entry({ quarryAbsentSince: T0 }), { ...gone, watched: false }, ON);
    assert.deepStrictEqual([d.end, d.phase], [{ reason: "TARGET_GONE" }, PHASES.SWEEP_DWELL]);
    d = decideHuntStep(exiting, facts(now + 1000, { ownAlive: [] }), ON);
    assert.deepStrictEqual(d.end, { reason: "WIPED" });
    d = decideHuntStep(entry({ phase: PHASES.ENGAGED }), facts(T0 + 1000, { ownAlive: [SHIPS3[0]],
      hostilesOnGrid: [9] }), ON);
    assert.deepStrictEqual([d.phase, d.exitReason], [PHASES.EXITING, "RETREATED"]);

    d = decideHuntStep(entry({ phase: PHASES.ENGAGED }), facts(T0 + 1000, { ownAlive: [SHIPS3[0]],
      hostilesOnGrid: [9] }), OFF);
    assert.deepStrictEqual(legacy(d), { phase: PHASES.ENGAGED, phaseSince: T0, objectIndex: 0, visited: 1,
      quarryAbsentSince: null, noTargetSince: null, scanCycle: 0, scan: null, actions: [], end: null, warpSeen: false,
      warpEnd: null });
    d = decideHuntStep(entry({ quarryAbsentSince: T0 }), gone, OFF);
    assert.deepStrictEqual(legacy(d), { phase: PHASES.SWEEP_DWELL, phaseSince: T0, objectIndex: 0, visited: 1,
      quarryAbsentSince: T0, noTargetSince: null, scanCycle: 0, scan: null, warpSeen: false, warpEnd: null,
      actions: [{ type: "end", reason: "TARGET_GONE" }], end: { reason: "TARGET_GONE" } });
  });
};
