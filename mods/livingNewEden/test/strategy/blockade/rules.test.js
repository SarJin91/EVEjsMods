"use strict";

const assert = require("node:assert");
const path = require("node:path");

const config = require("../../../config");
const { crossingsOfLeg, decideIntercept, STALE_REASONS } = require("../../../lib/strategy/blockade/rules");
const { paramsOf } = require("../../../lib/strategy/blockade/blockadeService");

const MOD_DIR = path.resolve(__dirname, "..", "..", "..");
const DEFAULTS = config.resolveConfig({ modDir: MOD_DIR, env: {} }).config;
const A = 500019;
const B = 500010;
const C = 500001;
const JUMP = 60000;
const T0 = 1000000;
const hostile = (a, b) => a !== b && !((a === B && b === C) || (a === C && b === B));

module.exports = ({ test }) => {
  test("BLK1 blockade rules: crossingsOfLeg filters and order; decideIntercept STALE reasons and a seeded roll", () => {
    const leg = { systems: [10, 11, 12, 13, 14], departAt: T0, jumpMs: JUMP };
    const at = new Map([
      [10, [{ operationId: "op-origin", factionId: B, dueAt: T0 * 10 }]],
      [11, [{ operationId: "op-b11", factionId: B, dueAt: T0 * 10 }, { operationId: "op-c11", factionId: A,
        dueAt: T0 * 10 }]],
      [12, [{ operationId: "op-z12", factionId: B, dueAt: T0 * 10 }, { operationId: "op-a12", factionId: C,
        dueAt: T0 * 10 }, { operationId: "op-old", factionId: B, dueAt: T0 + 2 * JUMP }]],
      [14, [{ operationId: "op-target", factionId: B, dueAt: T0 * 10 }]],
    ]);
    const blockadesAt = (s) => at.get(s) || [];
    const all = crossingsOfLeg(leg, blockadesAt, hostile, { factionId: A, maxSystems: 32, maxCrossings: 8 });
    assert.deepStrictEqual(all, { truncated: false, crossings: [
      { operationId: "op-b11", systemIndex: 1, at: T0 + JUMP },
      { operationId: "op-a12", systemIndex: 2, at: T0 + 2 * JUMP },
      { operationId: "op-z12", systemIndex: 2, at: T0 + 2 * JUMP }] });
    const ally = crossingsOfLeg(leg, blockadesAt, hostile, { factionId: C, maxSystems: 32, maxCrossings: 8 });
    assert.deepStrictEqual(ally.crossings.map((c) => c.operationId), ["op-c11"]);
    const capped = crossingsOfLeg(leg, blockadesAt, hostile, { factionId: A, maxSystems: 32, maxCrossings: 2 });
    assert.deepStrictEqual(capped.crossings.map((c) => c.operationId), ["op-b11", "op-a12"]);
    const short = crossingsOfLeg(leg, blockadesAt, hostile, { factionId: A, maxSystems: 1, maxCrossings: 8 });
    assert.deepStrictEqual([short.truncated, short.crossings.map((c) => c.operationId)], [true, ["op-b11"]]);
    assert.deepStrictEqual(crossingsOfLeg({ systems: [10, 11], departAt: T0, jumpMs: JUMP }, blockadesAt, hostile,
      { factionId: A, maxSystems: 32, maxCrossings: 8 }), { crossings: [], truncated: false });

    const P = paramsOf(DEFAULTS.strategy);
    assert.ok(P, "default params parse");
    assert.deepStrictEqual([...P.interceptOperationTypes],
      ["invasion", "raid", "gank", "defense", "reinforce", "mining", "logistics"]);
    assert.strictEqual(P.interceptChancePermille, 600);
    const route = { v: 1, systems: [10, 11, 12, 13], departAt: T0, jumpMs: JUMP, arriveAt: T0 + 3 * JUMP,
      graphVersion: 1, mode: "travel", observed: false };
    const op = { operationId: "op1", operationType: "blockade", factionId: B, targetSystemId: 12, state: "ACTIVE",
      dueAt: T0 * 10 };
    const post = { fleetId: "fb", state: "STAGED", currentSystemId: 12, operationId: "op1" };
    const target = { fleetId: "fa", factionId: A, state: "TRAVELLING", legSeq: 3, route };
    const p = { operationId: "op1", fleetId: "fa", legSeq: 3, systemIndex: 2, at: T0 + 2 * JUMP };
    const base = { p, operation: op, postFleets: [post], target, targetOperationType: "invasion", hostile: true,
      cooldownUntil: null, worldSeed: 42 };
    const decide = (over, params = P) => decideIntercept({ ...base, ...over }, params);
    const reasons = [
      [{ operation: null }, "OP_NOT_OPEN"],
      [{ operation: { ...op, state: "COMPLETED" } }, "OP_NOT_OPEN"],
      [{ operation: { ...op, operationType: "camp" } }, "OP_NOT_OPEN"],
      [{ operation: { ...op, dueAt: p.at } }, "OP_NOT_OPEN"],
      [{ postFleets: [{ ...post, currentSystemId: 11 }] }, "POST_AWAY"],
      [{ postFleets: [{ ...post, state: "TRAVELLING" }] }, "POST_AWAY"],
      [{ target: null }, "TARGET_GONE"],
      [{ target: { ...target, state: "DESTROYED" } }, "TARGET_GONE"],
      [{ target: { ...target, state: "STAGED" } }, "LEG_MOVED"],
      [{ target: { ...target, legSeq: 4 } }, "LEG_MOVED"],
      [{ target: { ...target, route: { ...route, v: 2, constraints: { wormholes: true },
        wormholeEdges: [[10, 11]] } } }, "LEG_HAS_WORMHOLES"],
      [{ p: { ...p, systemIndex: 1 } }, "NOT_CROSSING"],
      [{ p: { ...p, at: p.at + JUMP } }, "NOT_CROSSING"],
      [{ hostile: false }, "NOT_HOSTILE"],
      [{ targetOperationType: "recon" }, "TYPE_EXCLUDED"],
      [{ targetOperationType: null }, "TYPE_EXCLUDED"],
      [{ cooldownUntil: p.at + 1 }, "ON_COOLDOWN"],
    ];
    for (const [over, reason] of reasons) {
      assert.deepStrictEqual(decide(over), { action: "STALE", reason }, JSON.stringify(over));
    }
    assert.deepStrictEqual([...new Set(reasons.map((r) => r[1]))].sort(), [...STALE_REASONS].sort());
    assert.notStrictEqual(decide({ cooldownUntil: p.at }).action, "STALE");
    assert.notStrictEqual(decide({ targetOperationType: "mining" }).action, "STALE");
    assert.notStrictEqual(decide({ targetOperationType: "logistics" }).action, "STALE");
    const one = decide({});
    assert.deepStrictEqual(decide({}), one, "fixed seed -> same roll");
    assert.ok(one.roll >= 0 && one.roll < 1);
    assert.strictEqual(one.action, one.roll * 1000 >= 600 ? "ESCAPED" : "INTERCEPT");
    assert.notStrictEqual(decide({ worldSeed: 43 }).roll, one.roll, "the roll depends on the world seed");
    assert.strictEqual(decide({}, { ...P, interceptChancePermille: 1000 }).action, "INTERCEPT");
    assert.strictEqual(decide({}, { ...P, interceptChancePermille: 0 }).action, "ESCAPED");
  });
};
