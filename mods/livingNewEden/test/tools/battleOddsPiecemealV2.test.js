"use strict";

const assert = require("node:assert");

const { piecemealByOperationOf, auditOdds } = require("../../tools/battleAudit/odds");

const SYS = 30000001;
const T0 = 1000000;

const op = (fleetIds, extra = {}) => ({ operationId: "op1", operationType: "raid", targetSystemId: SYS, fleetIds,
  plannedAt: T0, completedAt: null, ...extra });
const battle = (id, createdAt, sideAFleetIds, outcome = "B_WIN") => ({ battleId: id, systemId: SYS, createdAt,
  outcome, sideAFleetIds });

module.exports = function register({ test }) {
  test("BOP1 T4 v2: second fleet of the operation STAGED in the target after X1 -> piecemeal", () => {
    const arrivals = new Map([["f1", [{ at: T0 + 100, systemId: SYS }]],
      ["f2", [{ at: T0 + 500, systemId: 30000002 }, { at: T0 + 200000, systemId: SYS }]]]);
    const r = piecemealByOperationOf([battle("b1", T0 + 1000, ["f1"])], [op(["f1", "f2"])], arrivals);
    assert.strictEqual(r.base, 1);
    assert.strictEqual(r.cases, 1);
    assert.strictEqual(r.share, 1);
    assert.deepStrictEqual(r.byType, { raid: { base: 1, cases: 1 } });
    assert.strictEqual(r.firstOutcome.piecemeal.B_WIN, 1);
    assert.strictEqual(r.gapsMs.p50, 199000);
    assert.strictEqual(r.within[600000], 1);
    assert.strictEqual(r.within[60000], 0);
    assert.strictEqual(r.list[0].operationId, "op1");
  });

  test("BOP2 T4 v2: both fleets of the operation in X1 -> not piecemeal", () => {
    const arrivals = new Map([["f1", [{ at: T0 + 100, systemId: SYS }]], ["f2", [{ at: T0 + 900, systemId: SYS }]]]);
    const r = piecemealByOperationOf([battle("b1", T0 + 1000, ["f1", "f2"], "A_WIN")], [op(["f1", "f2"])],
      arrivals);
    assert.strictEqual(r.base, 1);
    assert.strictEqual(r.cases, 0);
    assert.strictEqual(r.firstOutcome.whole.A_WIN, 1);
    assert.strictEqual(r.gapsMs.max, null);
  });

  test("BOP3 T4 v2: second battle of the same fleets 1 ms after X1 (recheck) -> not piecemeal", () => {
    const arrivals = new Map([["f1", [{ at: T0 + 100, systemId: SYS }]], ["f2", [{ at: T0 + 200, systemId: SYS }]]]);
    const battles = [battle("b2", T0 + 61001, ["f1", "f2"]), battle("b1", T0 + 1000, ["f1", "f2"])];
    const r = piecemealByOperationOf(battles, [op(["f1", "f2"])], arrivals);
    assert.strictEqual(r.base, 1);
    assert.strictEqual(r.cases, 0);
    assert.strictEqual(r.firstOutcome.whole.B_WIN, 1);
    const late = piecemealByOperationOf(battles, [op(["f1", "f2"])], arrivals, { since: T0 + 2000 });
    assert.strictEqual(late.base, 0);
  });

  test("BOP4 T4 v2: one fleet -> single outside the base; auditOdds without arrivals -> piecemealV2 null", () => {
    const r = piecemealByOperationOf([battle("b1", T0 + 1000, ["f1"])], [op(["f1"])], new Map());
    assert.strictEqual(r.single, 1);
    assert.strictEqual(r.base, 0);
    assert.strictEqual(r.share, 0);
    const deps = { powerTable: {}, powerPerPoint: 0, grindMin: 6, grindWindowMs: 1, piecemealMs: 1 };
    assert.strictEqual(auditOdds([], { ...deps, operations: [op(["f1"])] }).piecemealV2, null);
    assert.strictEqual(auditOdds([], { ...deps, operations: [op(["f1"])], arrivals: new Map(),
      operationBattles: [battle("b1", T0 + 1000, ["f1"])] }).piecemealV2.single, 1);
  });
};
