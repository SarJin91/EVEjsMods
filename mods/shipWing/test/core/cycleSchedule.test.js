"use strict";

const assert = require("node:assert");
const {
  createEntry, isDue, advance, pause, applyCycleResult, cycleOk, cycleFail, createTickBudget,
} = require("../../lib/core/cycleSchedule");

module.exports = ({ test }) => {
  test("CB4 cycleSchedule: due/advance without drift (+= durationMs), a backlog of more than one cycle resets to "
    + "simMs, pause after a failed CycleResult; tick budget: limit, deferred, reset at a new nowMs", () => {
    const e = createEntry(77, "volley");
    assert.deepStrictEqual(e, { id: 77, kind: "volley", nextAtSimMs: 0, applyAtSimMs: null, targetId: null,
      lastReason: null });
    assert.strictEqual(isDue(e, 0), true, "a new entry is due at once");

    advance(e, 1000, 100000);
    assert.strictEqual(e.nextAtSimMs, 101000);
    assert.strictEqual(isDue(e, 100999), false);
    assert.strictEqual(isDue(e, 101000), true);
    advance(e, 1000, 101400);
    assert.strictEqual(e.nextAtSimMs, 102000);
    advance(e, 1000, 103000);
    assert.strictEqual(e.nextAtSimMs, 103000);
    assert.strictEqual(isDue(e, 103000), true);
    advance(e, 1000, 105500);
    assert.strictEqual(e.nextAtSimMs, 106500);
    assert.strictEqual(e.lastReason, null);

    pause(e, 2000, 106500, "NO_AMMO");
    assert.strictEqual(e.nextAtSimMs, 108500);
    assert.strictEqual(e.lastReason, "NO_AMMO");

    assert.deepStrictEqual(cycleOk(3000, { hit: true }), { ok: true, durationMs: 3000, data: { hit: true } });
    assert.deepStrictEqual(cycleFail("NO_SNAPSHOT", null), { ok: false, reason: "NO_SNAPSHOT", retryMs: null });
    applyCycleResult(e, cycleOk(3000, {}), 108500, 2000);
    assert.strictEqual(e.nextAtSimMs, 111500);
    assert.strictEqual(e.lastReason, null, "an ok cycle clears the last reason");
    applyCycleResult(e, cycleFail("TARGET_GONE", 4000), 111500, 2000);
    assert.strictEqual(e.nextAtSimMs, 115500);
    applyCycleResult(e, cycleFail("ERROR", null), 115500, 2000);
    assert.strictEqual(e.nextAtSimMs, 117500, "retryMs null -> the caller's fallback (combatReacquireMs)");
    assert.strictEqual(e.lastReason, "ERROR");
    applyCycleResult(e, null, 117500, 2000);
    assert.strictEqual(e.lastReason, "ERROR", "no result = an error, paused by the fallback");
    assert.strictEqual(e.nextAtSimMs, 119500);

    const budget = createTickBudget(2);
    assert.deepStrictEqual([budget.take(500), budget.take(500), budget.take(500), budget.take(500)],
      [true, true, false, false]);
    assert.strictEqual(budget.used, 2);
    assert.strictEqual(budget.deferred, 2);
    assert.strictEqual(budget.take(1000), true, "a new tick (nowMs) resets the budget");
    assert.strictEqual(budget.used, 1);
    assert.strictEqual(budget.deferred, 0);
    assert.strictEqual(createTickBudget(0).take(1), false, "limit 0 lets nothing through");
  });
};
