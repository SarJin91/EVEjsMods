"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { decidePatrolStep, PHASES } = require("../../lib/garrisonPatrol/phases");
const huntPhases = require("../../lib/playerHunt/phases");
const S = require("../../lib/playerHunt/schema");

const SERVER_SRC = path.resolve(__dirname, "..", "..", "..", "..", "server", "src");
const PARAMS = Object.freeze({ objectDwellMs: 60000, warpTimeoutMs: 60000, warpStartGraceMs: 6000,
  reacquireGraceMs: 20000, exitGraceMs: 30000, maxLiveMs: 0 });
const OBJECTS = Object.freeze([{ point: { x: 1, y: 0, z: 0 } }, { point: { x: 2, y: 0, z: 0 } },
  { point: { x: 3, y: 0, z: 0 } }]);
const ALIVE = Object.freeze([{ entityId: 1, inWarp: false, position: { x: 0, y: 0, z: 0 } }]);

function entryOf(extra = {}) {
  return { mode: "PATROL", phase: PHASES.PATROL_DWELL, phaseSince: 0, objects: OBJECTS, objectIndex: 0, liveSince: 0,
    absentSince: null, noTargetSince: null, warpSeen: false, spawnConfirmed: true, ...extra };
}
const facts = (now, extra = {}) => ({ now, sceneLoaded: true, ownAlive: ALIVE, hostilesOnGrid: [], present: true,
  ...extra });
const apply = (entry, d) => ({ ...entry, phase: d.phase, phaseSince: d.phaseSince, objectIndex: d.objectIndex,
  absentSince: d.absentSince, noTargetSince: d.noTargetSince, warpSeen: d.warpSeen });

function readSource(rel) {
  return fs.readFileSync(path.join(SERVER_SRC, rel), "utf8").replace(/\r\n/g, "\n");
}

module.exports = ({ test, skip }) => {
  test("GP2 garrison patrol phases: round route, ENGAGED and reacquire per mode, UNOBSERVED, SPAWN_NOT_VISIBLE", () => {
    assert.strictEqual(typeof huntPhases.warpProgress, "function");
    const src = fs.readFileSync(path.join(__dirname, "..", "..", "lib", "garrisonPatrol", "phases.js"), "utf8");
    assert.ok(src.includes("require(\"../playerHunt/phases\")") && !src.includes("function warpProgress"),
      "warpProgress imported, not copied");

    let e = entryOf();
    assert.deepStrictEqual(decidePatrolStep(e, facts(59999), PARAMS).actions, []);
    let d = decidePatrolStep(e, facts(60000), PARAMS);
    assert.deepStrictEqual([d.phase, d.objectIndex, d.actions], [PHASES.PATROL_WARP, 1,
      [{ type: "warp", point: { x: 2, y: 0, z: 0 }, objectIndex: 1 }]]);
    e = apply(e, d);
    d = decidePatrolStep(e, facts(61000, { ownAlive: [{ ...ALIVE[0], inWarp: true }] }), PARAMS);
    assert.deepStrictEqual([d.phase, d.warpSeen, d.warpEnd], [PHASES.PATROL_WARP, true, null]);
    e = apply(e, d);
    d = decidePatrolStep(e, facts(70000), PARAMS);
    assert.deepStrictEqual([d.phase, d.objectIndex, d.warpEnd, d.end], [PHASES.PATROL_DWELL, 1, "landed", null]);
    d = decidePatrolStep(entryOf({ objectIndex: 2 }), facts(60000), PARAMS);
    assert.strictEqual(d.objectIndex, 0);
    d = decidePatrolStep(entryOf({ objects: [OBJECTS[0]] }), facts(60000), PARAMS);
    assert.deepStrictEqual([d.phase, d.actions], [PHASES.PATROL_DWELL, []]);

    for (const phase of [PHASES.PATROL_DWELL, PHASES.PATROL_WARP, PHASES.CAMP_HOLD]) {
      d = decidePatrolStep(entryOf({ phase }), facts(1000, { hostilesOnGrid: [9001] }), PARAMS);
      assert.deepStrictEqual([d.phase, d.actions], [PHASES.ENGAGED, [{ type: "attack", targets: [9001] }]]);
    }
    const engaged = entryOf({ phase: PHASES.ENGAGED, phaseSince: 1000 });
    d = decidePatrolStep(engaged, facts(2000), PARAMS);
    assert.deepStrictEqual([d.phase, d.noTargetSince, d.actions], [PHASES.ENGAGED, 2000, []]);
    d = decidePatrolStep({ ...engaged, noTargetSince: 2000 }, facts(22000), PARAMS);
    assert.deepStrictEqual([d.phase, d.actions], [PHASES.PATROL_WARP, [{ type: "search" },
      { type: "warp", point: { x: 2, y: 0, z: 0 }, objectIndex: 1 }]]);
    d = decidePatrolStep({ ...engaged, mode: "GATE_CAMP", noTargetSince: 2000 }, facts(22000), PARAMS);
    assert.deepStrictEqual([d.phase, d.actions], [PHASES.CAMP_HOLD, [{ type: "search" }]]);
    d = decidePatrolStep(entryOf({ mode: "GATE_CAMP", phase: PHASES.CAMP_HOLD }), facts(900000), PARAMS);
    assert.deepStrictEqual([d.phase, d.actions, d.end], [PHASES.CAMP_HOLD, [], null]);

    d = decidePatrolStep(entryOf(), facts(1000, { present: false }), PARAMS);
    assert.deepStrictEqual([d.absentSince, d.end], [1000, null]);
    d = decidePatrolStep(entryOf({ absentSince: 1000 }), facts(30999, { present: false }), PARAMS);
    assert.strictEqual(d.end, null);
    d = decidePatrolStep(entryOf({ absentSince: 1000 }), facts(31000, { present: false }), PARAMS);
    assert.deepStrictEqual(d.end, { reason: "UNOBSERVED" });
    assert.ok(S.END_REASONS.includes(d.end.reason));
    assert.strictEqual(decidePatrolStep(entryOf({ absentSince: 1000 }), facts(31000), PARAMS).absentSince, null);

    assert.deepStrictEqual(decidePatrolStep(entryOf(), facts(1, { sceneLoaded: false }), PARAMS).end,
      { reason: "SCENE_GONE" });
    assert.deepStrictEqual(decidePatrolStep(entryOf({ spawnConfirmed: false }), facts(1, { ownAlive: [] }), PARAMS)
      .end, { reason: "SPAWN_NOT_VISIBLE" });
    assert.deepStrictEqual(decidePatrolStep(entryOf(), facts(1, { ownAlive: [] }), PARAMS).end, { reason: "WIPED" });
    assert.deepStrictEqual(decidePatrolStep(entryOf(), facts(5000), { ...PARAMS, maxLiveMs: 5000 }).end,
      { reason: "TIMEOUT" });
  });

  const gp5 = "GP5 garrison patrol vendor facts: sun groupID 6, coordinates / sun anchors, jump cloak, attacker timer";
  if (!fs.existsSync(SERVER_SRC)) skip(gp5, "server/src not found");
  else {
    test(gp5, () => {
      assert.ok(readSource("space/transitions.js").includes("entry.groupID === 6"), "transitions.js sun group 6");
      const anchors = readSource("space/npc/npcAnchors.js");
      for (const line of ["normalizedKind === \"coordinates\"", "normalizedKind === \"sun\""]) {
        assert.ok(anchors.includes(line), `npcAnchors.js: ${line}`);
      }
      const cloak = readSource("space/runtime/shipCloak.js");
      const start = cloak.indexOf("\nfunction applyStargateJumpCloakState(");
      assert.ok(start >= 0, "applyStargateJumpCloakState");
      const next = cloak.indexOf("\nfunction ", start + 1);
      assert.ok(cloak.slice(start, next === -1 ? undefined : next).includes("entity.cloaked = true"),
        "jump cloak sets entity.cloaked");
      const cw = readSource("services/security/crimewatchState.js");
      const parts = cw.split("\nfunction ");
      assert.ok(parts.some((body) => body.includes("attackerCharacterID")
        && body.includes("state.weaponTimerExpiresAtMs = Math.max(")), "crimewatch: attacker weapons timer");
    });
  }
};
