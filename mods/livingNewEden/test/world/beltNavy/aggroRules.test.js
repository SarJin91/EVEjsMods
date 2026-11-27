"use strict";

const assert = require("node:assert");

const { planGroup } = require("../../../lib/world/beltNavy/aggroRules");

const P = Object.freeze({ hostileBelowStanding: 0, aggroRangeMeters: 150000, groupTtlMs: 1800000 });
const AT = 5000000;
const HOSTILE = 11;
const FRIEND = 12;
const FAR = 13;
const standings = { [HOSTILE]: -0.5, [FRIEND]: 3, [FAR]: -5 };
const standingOf = (c) => standings[c];

const group = (over = {}) => ({ spawnedAt: AT - 1000, provoked: new Set(), seenAggressedAt: new Map(), ...over });
const ship = (entityId, over = {}) => ({ entityId, position: { x: 0, y: 0, z: 0 }, manualTargetId: 0,
  aggressorEntityId: 0, aggressedAtMs: 0, ...over });
const player = (characterId, x, over = {}) => ({ characterId, entityId: characterId * 100,
  position: { x, y: 0, z: 0 }, ...over });

module.exports = ({ test }) => {
  test("BNA1 hostile and friendly pilot on one belt: orders only on the hostile, distance order, kept target", () => {
    const players = [player(FRIEND, 1000), player(HOSTILE, 2000), player(FAR, 200000)];
    const plan = planGroup(group(), { ships: [ship(1), ship(2)], players }, standingOf, P, AT);
    assert.deepStrictEqual(plan.orders, [{ entityId: 1, targetId: HOSTILE * 100 }, { entityId: 2, targetId: HOSTILE * 100 }],
      "the friend is closer and the far hostile is out of range");
    assert.deepStrictEqual([plan.attacks, plan.seen, plan.expire], [[], [], false]);

    const second = player(14, 3000);
    const hostile2 = (c) => (c === 14 ? -1 : standingOf(c));
    const rotated = planGroup(group(), { ships: [ship(1), ship(2, { manualTargetId: HOSTILE * 100 }), ship(3)],
      players: [second, player(HOSTILE, 2000)] }, hostile2, P, AT);
    assert.deepStrictEqual(rotated.orders, [{ entityId: 1, targetId: HOSTILE * 100 }, { entityId: 3, targetId: HOSTILE * 100 }],
      "ship 2 keeps its hostile target, the others get hostile[i % n] by distance");

    const friendTarget = planGroup(group(), { ships: [ship(1, { manualTargetId: FRIEND * 100 })],
      players: [player(FRIEND, 1000), player(HOSTILE, 2000)] }, standingOf, P, AT);
    assert.deepStrictEqual(friendTarget.orders, [{ entityId: 1, targetId: HOSTILE * 100 }], "a target no longer hostile");

    const tie = planGroup(group(), { ships: [ship(1)], players: [player(16, 1000), player(15, 1000)] }, () => -1, P, AT);
    assert.deepStrictEqual(tie.orders, [{ entityId: 1, targetId: 1500 }], "a distance tie goes by character id");
  });

  test("BNA2 a new aggressedAtMs provokes once, the whole group answers, the same stamp and other aggressors do nothing", () => {
    const players = [player(FRIEND, 1000)];
    const hit = { aggressorEntityId: FRIEND * 100, aggressedAtMs: 777 };
    const before = group();
    const plan = planGroup(before, { ships: [ship(1, hit), ship(2, hit), ship(3)], players }, standingOf, P, AT);
    assert.deepStrictEqual(plan.attacks, [FRIEND], "one entry per player");
    assert.deepStrictEqual(plan.seen, [[1, 777], [2, 777]]);
    assert.deepStrictEqual(plan.orders.map((o) => o.targetId), [FRIEND * 100, FRIEND * 100, FRIEND * 100], "the whole group");
    assert.strictEqual(before.provoked.size, 0, "the plan does not touch the group");

    const again = group({ provoked: new Set([FRIEND]), seenAggressedAt: new Map([[1, 777], [2, 777]]) });
    const repeat = planGroup(again, { ships: [ship(1, { ...hit, manualTargetId: FRIEND * 100 })], players }, standingOf, P, AT);
    assert.deepStrictEqual([repeat.attacks, repeat.seen, repeat.orders], [[], [], []], "provoked stays, no new attack");

    const newShot = planGroup(again, { ships: [ship(1, { ...hit, aggressedAtMs: 778 })], players }, standingOf, P, AT);
    assert.deepStrictEqual([newShot.attacks, newShot.seen], [[FRIEND], [[1, 778]]]);

    const drone = planGroup(group(), { ships: [ship(1, { aggressorEntityId: 987654, aggressedAtMs: 5 })], players },
      standingOf, P, AT);
    assert.deepStrictEqual([drone.attacks, drone.seen, drone.orders], [[], [], []], "a drone or NPC is no player");

    const provokedFar = planGroup(group({ provoked: new Set([FRIEND]) }), { ships: [ship(1, { manualTargetId: FRIEND * 100 })],
      players: [player(FRIEND, 200000)] }, standingOf, P, AT);
    assert.deepStrictEqual(provokedFar.orders, [{ entityId: 1, targetId: 0 }], "a provoked pilot out of range ends the chase");
  });

  test("BNA3 no hostile: resume, TTL only with nobody in range, also for a sleeping group", () => {
    const old = group({ spawnedAt: AT - P.groupTtlMs });
    const resume = planGroup(group(), { ships: [ship(1, { manualTargetId: 55 }), ship(2)], players: [player(FRIEND, 1000)] },
      standingOf, P, AT);
    assert.deepStrictEqual(resume.orders, [{ entityId: 1, targetId: 0 }]);
    assert.strictEqual(planGroup(old, { ships: [ship(1)], players: [player(FRIEND, 1000)] }, standingOf, P, AT).expire, false,
      "a pilot in range keeps it");
    assert.strictEqual(planGroup(old, { ships: [ship(1)], players: [player(FRIEND, 200000)] }, standingOf, P, AT).expire, true);
    assert.strictEqual(planGroup(group({ spawnedAt: AT - P.groupTtlMs + 1 }), { ships: [ship(1)], players: [] }, standingOf,
      P, AT).expire, false, "one ms before the TTL");
    assert.strictEqual(planGroup(old, { ships: [], players: [player(FRIEND, 1000)] }, standingOf, P, AT).expire, true,
      "a sleeping group has no point, so nobody is in range");
  });

  test("BNA4 capsule and cloaked are no target but keep the group, an unreadable standing is not hostile", () => {
    const old = group({ spawnedAt: AT - P.groupTtlMs });
    const pod = planGroup(old, { ships: [ship(1)], players: [player(HOSTILE, 1000, { capsule: true })] }, standingOf, P, AT);
    assert.deepStrictEqual([pod.orders, pod.expire], [[], false]);
    const cloaked = planGroup(old, { ships: [ship(1)], players: [player(HOSTILE, 1000, { cloaked: true })] }, standingOf, P, AT);
    assert.deepStrictEqual([cloaked.orders, cloaked.expire], [[], false]);
    const unreadable = planGroup(group(), { ships: [ship(1)], players: [player(HOSTILE, 1000)] }, () => NaN, P, AT);
    assert.deepStrictEqual(unreadable.orders, []);
    const neutral = planGroup(group(), { ships: [ship(1)], players: [player(HOSTILE, 1000)] }, () => 0, P, AT);
    assert.deepStrictEqual(neutral.orders, [], "strictly below the threshold");
  });
};
