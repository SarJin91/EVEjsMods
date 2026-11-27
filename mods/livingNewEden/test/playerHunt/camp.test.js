"use strict";

const assert = require("node:assert");

const { decideHuntStep, PHASES } = require("../../lib/playerHunt/phases");
const { pickCampStation } = require("../../lib/playerHunt/exit");
const { decidePursuit, stateInSystem } = require("../../lib/playerHunt/pursuit");

const T0 = 1000000;
const pos = (x) => ({ x, y: 0, z: 0 });
const P = Object.freeze({ objectDwellMs: 30000, warpTimeoutMs: 60000, reacquireGraceMs: 20000, exitGraceMs: 30000,
  maxDurationMs: 1200000, maxObjectsPerHunt: 3, dockCampEnabled: true, dockCampMs: 120000 });
const OBJECTS = Object.freeze([{ kind: "stargate", itemId: 1, position: pos(0) },
  { kind: "station", itemId: 2, position: pos(1e7) }, { kind: "planet", itemId: 3, position: pos(2e7) }]);
const STATION = pos(1e7);
const SHIPS = Object.freeze([{ entityId: 11, inWarp: false, position: pos(0) }]);
const ABSENT = Object.freeze({ state: "absent", ship: null });

function entry(extra = {}) {
  return { phase: PHASES.SWEEP_DWELL, phaseSince: T0, objects: OBJECTS, objectIndex: 0, visited: 1, liveSince: T0,
    quarryAbsentSince: null, noTargetSince: null, spawnConfirmed: true, ...extra };
}

function facts(now, extra = {}) {
  return { now, sceneLoaded: true, quarry: ABSENT, ownAlive: SHIPS, hostilesOnGrid: [], members: 1,
    quarryDocked: true, campPoint: STATION, ...extra };
}

module.exports = ({ test }) => {
  test("PC1 CAMP: docked quarry -> search + warp to the station, no exitGraceMs in the camp "
    + "dockCampMs -> TARGET_DOCKED (EXITING with a watcher), undock on grid -> ENGAGED, in space off grid -> search, "
    + "not docked -> TARGET_GONE, flag off = TARGET_GONE; pickCampStation; stateInSystem; CHAIN_COOLDOWN", () => {
    let d = decideHuntStep(entry(), facts(T0 + 1000), P);
    assert.deepStrictEqual([d.phase, d.phaseSince, d.end, d.quarryAbsentSince], [PHASES.CAMP, T0 + 1000, null,
      T0 + 1000]);
    assert.deepStrictEqual(d.actions, [{ type: "search" }, { type: "warp", point: STATION }]);
    const camp = entry({ phase: PHASES.CAMP, phaseSince: T0 + 1000, quarryAbsentSince: T0 + 1000 });
    const later = T0 + 1000 + P.exitGraceMs + 1;
    d = decideHuntStep(camp, facts(later, { campPoint: null }), P);
    assert.deepStrictEqual([d.phase, d.end, d.actions], [PHASES.CAMP, null, []], "no exitGraceMs in the camp");
    const over = T0 + 1000 + P.dockCampMs;
    d = decideHuntStep(camp, facts(over, { campPoint: null }), P);
    assert.deepStrictEqual(d.end, { reason: "TARGET_DOCKED" });
    d = decideHuntStep(camp, facts(over, { campPoint: null, watched: true, exitPoint: pos(5e9) }),
      { ...P, exitEnabled: true });
    assert.deepStrictEqual([d.phase, d.exitReason, d.end], [PHASES.EXITING, "TARGET_DOCKED", null]);
    const quarry = { state: "space", ship: { capsule: false, inWarp: true, position: pos(1e7) } };
    d = decideHuntStep(camp, facts(T0 + 5000, { quarry, quarryDocked: false, hostilesOnGrid: [77] }), P);
    assert.deepStrictEqual([d.phase, d.actions], [PHASES.ENGAGED, [{ type: "attack", targets: [77] }]]);
    d = decideHuntStep(camp, facts(T0 + 5000, { quarry, quarryDocked: false }), P);
    assert.deepStrictEqual([d.phase, d.actions.map((a) => a.type)], [PHASES.SWEEP_WARP, ["search", "warp"]]);
    d = decideHuntStep(camp, facts(later, { quarryDocked: false, campPoint: null }), P);
    assert.deepStrictEqual(d.end, { reason: "TARGET_GONE" });
    const gone = entry({ quarryAbsentSince: T0 });
    d = decideHuntStep(gone, facts(T0 + P.exitGraceMs), { ...P, dockCampEnabled: false });
    assert.deepStrictEqual(d.end, { reason: "TARGET_GONE" });
    d = decideHuntStep(gone, facts(T0 + P.exitGraceMs, { campPoint: null }), P);
    assert.deepStrictEqual(d.end, { reason: "TARGET_GONE" });

    const objs = [{ kind: "station", itemId: 9, position: pos(1000) },
      { kind: "station", itemId: 4, position: pos(-1000) },
      { kind: "stargate", itemId: 1, position: pos(10) }, { kind: "station", itemId: 5, position: pos(5e6) }];
    assert.deepStrictEqual(pickCampStation(objs, pos(0), 250000), { itemId: 4, position: pos(-1000) }, "tie: itemId");
    assert.strictEqual(pickCampStation(objs, pos(1e9), 250000), null, "out of range");
    assert.strictEqual(pickCampStation(objs, null, 250000), null, "no position");

    const presence = { getSystemPresence: (id) => (id === 30000142 ? { characters: [{ characterId: 7,
      state: "docked" }] } : { characters: [] }) };
    assert.strictEqual(stateInSystem(presence, 30000142, 7), "docked");
    assert.strictEqual(stateInSystem(presence, 30000144, 7), null);
    assert.strictEqual(stateInSystem({ getSystemPresence: () => { throw new Error("x"); } }, 30000142, 7), null);

    const PP = { pursuitEnabled: true, pursuitRequireContact: true, pursuitMaxHops: 3, pursuitMaxActive: 2,
      pursuitMaxJumps: 1 };
    const input = { fromSystemId: 1, located: { systemId: 2, state: "space" }, contact: true, hops: 3,
      activePursuits: 0, route: { ok: true, jumps: 1 } };
    assert.strictEqual(decidePursuit({ ...input, chainCooldown: true }, PP).reason, "CHAIN_COOLDOWN",
      "before HOPS_EXHAUSTED");
    assert.strictEqual(decidePursuit({ ...input, contact: false, chainCooldown: true }, PP).reason, "NO_CONTACT");
    assert.strictEqual(decidePursuit(input, PP).reason, "HOPS_EXHAUSTED", "no field = no change");
    assert.deepStrictEqual(decidePursuit({ ...input, hops: 0 }, PP), { pursue: true, targetSystemId: 2, jumps: 1 });
  });
};
