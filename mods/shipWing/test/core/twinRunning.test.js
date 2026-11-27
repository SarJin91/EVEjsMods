"use strict";

const assert = require("node:assert");
const { runningOf, ACTIVE_ORDER } = require("../../lib/core/twinRunning");

const RAT = 3000000001;

module.exports = ({ test }) => {
  test("TR1 ATTACK with a target, propOn, localRepOn, repairing, alwaysOn, ewarOn [web, scram, bogus] and "
    + "drones out -> codes in ACTIVE_ORDER without bogus; wait set, no target or a drone-only twin -> no weapons; "
    + "drones out 0 -> no drones; nothing -> []", () => {
    const task = { task: "ATTACK", targetId: RAT, wait: null };
    const active = { propOn: true, localRepOn: true, repairing: "twin", alwaysOn: 2, ewarOn: ["web", "scram", "bogus"] };
    assert.deepStrictEqual(runningOf({ task, active, drones: { out: 2 } }),
      ["weapons", "drones", "prop", "localRep", "remoteRep", "hardeners", "web", "scram"]);
    assert.deepStrictEqual(ACTIVE_ORDER.slice(-5), ["nos", "neut", "web", "scram", "disrupt"]);
    assert.deepStrictEqual(runningOf({ task: { ...task, wait: "NO_TARGET" } }), []);
    assert.deepStrictEqual(runningOf({ task: { ...task, targetId: null } }), []);
    assert.deepStrictEqual(runningOf({ task: { ...task, task: "FOLLOW" } }), []);
    assert.deepStrictEqual(runningOf({ task: { ...task, weaponless: true }, drones: { out: 3 } }), ["drones"]);
    assert.deepStrictEqual(runningOf({ task, drones: { out: 0 } }), ["weapons"]);
    assert.deepStrictEqual(runningOf({ active: { propOn: false, localRepOn: false, repairing: null, alwaysOn: 0 } }),
      []);
    assert.deepStrictEqual([runningOf(null), runningOf({})], [[], []]);
  });
};
