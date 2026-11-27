"use strict";

const assert = require("node:assert");

const { planSeason, stageBounds, stageAt, nextDueOf } = require("../../lib/seasons/timeline");
const { STATE } = require("../../lib/seasons/schema");

module.exports = ({ test }) => {
  test("S1 stageAt before the start, in stage 1, after a stop over 3 boundaries, after the end; nextDueOf per state",
    () => {
      const plan = planSeason({ now: 600, durationMs: 4000, stageCount: 4, startDelayMs: 400 });
      assert.deepStrictEqual(plan, { startsAt: 1000, endsAt: 5000, stageCount: 4, stageDueAt: 2000 });
      const row = { startsAt: 1000, endsAt: 5000, stageCount: 4 };
      assert.deepStrictEqual(stageBounds(row), [2000, 3000, 4000]);
      assert.deepStrictEqual(stageAt(row, 999), { phase: "BEFORE", stage: 0, final: false, nextAt: 1000 });
      assert.deepStrictEqual(stageAt(row, 1000), { phase: "STAGE", stage: 0, final: false, nextAt: 2000 });
      assert.deepStrictEqual(stageAt(row, 2500), { phase: "STAGE", stage: 1, final: false, nextAt: 3000 });
      const jumped = stageAt(row, 4500);
      assert.deepStrictEqual(jumped, { phase: "STAGE", stage: 3, final: true, nextAt: 5000 });
      assert.strictEqual(jumped.stage - 0 - 1, 2);
      assert.deepStrictEqual(stageAt(row, 5000), { phase: "END", stage: 3, final: true, nextAt: 5000 });
      assert.deepStrictEqual(stageBounds({ startsAt: 0, endsAt: 10, stageCount: 2 }), [5]);

      const base = { startsAt: 1000, endsAt: 5000, stageDueAt: 3000 };
      assert.strictEqual(nextDueOf({ ...base, state: STATE.PLANNED }), 1000);
      assert.strictEqual(nextDueOf({ ...base, state: STATE.ACTIVE }), 3000);
      assert.strictEqual(nextDueOf({ ...base, state: STATE.FINALE }), 5000);
      for (const s of [STATE.ARCHIVED, STATE.RESET_PENDING, STATE.RESET_DONE, STATE.INTERRUPTED]) {
        assert.strictEqual(nextDueOf({ ...base, state: s }), null, s);
      }
      assert.strictEqual(nextDueOf(null), null);
    });
};
