"use strict";

const assert = require("node:assert");

const { auditOdds, bucketOf } = require("../../tools/battleAudit/odds");

const POWER_TABLE = Object.freeze({ frigate: 100 });
const HOUR = 3600000;
const FA = 500010;
const FB = 500002;

function side(factionId, count) {
  return { factionId, fleets: [{ fleetId: `f${factionId}`, composition: [{ hullGroup: "frigate", count }] }] };
}

function row(n, opts = {}) {
  return { battleId: `b${n}`, systemId: opts.systemId || 30000001, objective: opts.objective || "capture",
    input: { sideA: side(FA, opts.a || 10), sideB: side(FB, opts.b || 10), garrison: opts.garrison || null },
    result: { outcome: opts.outcome || "B_WIN" }, createdAt: opts.createdAt || 0, settledAt: opts.settledAt || 0,
    factionA: FA };
}

function deps(extra = {}) {
  return { powerTable: POWER_TABLE, powerPerPoint: Math.sqrt(10 * 2000), grindMin: 6, grindWindowMs: 24 * HOUR,
    piecemealMs: 2 * HOUR, ganks: null, ...extra };
}

module.exports = ({ test }) => {
  test("BOA1 battleOddsAudit: ratio of two compositions, bucket and outcome per objective", () => {
    const out = auditOdds([row(1, { a: 12, b: 10, outcome: "A_WIN", objective: "destroy" })], deps());
    const got = out.buckets.find((b) => b.battles > 0);
    assert.deepStrictEqual({ bucket: got.bucket, a: got.counts.A_WIN, obj: got.byObjective.destroy.counts.A_WIN,
      total: out.totals.battles, ganks: out.ganks, edge: [bucketOf(499), bucketOf(500), bucketOf(2000)] },
    { bucket: "1200-1499", a: 1, obj: 1, total: 1, ganks: null, edge: ["<500", "500-799", ">=2000"] });
  });

  test("BOA2 battleOddsAudit: grinder = 6 B_WIN in 24 h, 5 = none", () => {
    const six = [0, 1, 2, 3, 4, 5].map((i) => row(i, { settledAt: i * HOUR, createdAt: i * HOUR }));
    const five = six.slice(0, 5);
    const g6 = auditOdds(six, deps()).grinders;
    const g5 = auditOdds(five, deps()).grinders;
    assert.deepStrictEqual({ six: g6.map((g) => [g.factionId, g.systemId, g.maxInWindow]), five: g5.length },
      { six: [[FA, 30000001, 6]], five: 0 });
  });

  test("BOA3 battleOddsAudit: garrison B legacy vs resolver gives another bucket", () => {
    const out = auditOdds([row(1, { a: 10, b: 5, garrison: { side: "B", factionId: FB, strength: 2 } })], deps());
    const legacy = out.garrison.legacy.find((b) => b.battles > 0);
    const resolver = out.garrison.resolver.find((b) => b.battles > 0);
    assert.deepStrictEqual({ n: out.garrison.battles, legacy: legacy.bucket, resolver: resolver.bucket,
      bWin: resolver.counts.B_WIN }, { n: 1, legacy: "1500-1999", resolver: "1200-1499", bWin: 1 });
  });

  test("BOA4 battleOddsAudit: second battle of faction A <= 2 h after settledAt = 1 piecemeal case", () => {
    const rows = [row(1, { createdAt: 0, settledAt: HOUR }), row(2, { createdAt: 2 * HOUR, settledAt: 3 * HOUR }),
      row(3, { createdAt: 6 * HOUR, settledAt: 7 * HOUR })];
    const p = auditOdds(rows, deps()).piecemeal;
    assert.deepStrictEqual({ base: p.base, cases: p.cases, pair: p.list.map((c) => [c.battleId, c.nextBattleId]) },
      { base: 3, cases: 1, pair: [["b1", "b2"]] });
  });

  test("BOA5: T6 interceptions at blockade posts of side B (window, system, faction), T7 "
    + "invasion / raid battles in / outside the target; no blockade operation = no data", () => {
    const POST = 30000002;
    const TARGET = 30000009;
    const op = (factionId, targetSystemId, plannedAt, dueAt, operationType) => ({ factionId, targetSystemId,
      operationType, plannedAt, dueAt, completedAt: null });
    const rows = [row(1, { systemId: POST, a: 5, b: 10, outcome: "B_WIN", createdAt: HOUR }),
      row(2, { systemId: POST, outcome: "A_WIN", createdAt: 3 * HOUR }),
      row(3, { systemId: TARGET, outcome: "A_WIN", createdAt: HOUR }),
      row(4, { systemId: 30000001, outcome: "B_WIN", createdAt: 5 * HOUR })];
    const out = auditOdds(rows, deps({ blockades: [op(FB, POST, 0, 2 * HOUR, "blockade"),
      op(FA, POST, 0, 9 * HOUR, "blockade")],
    attacks: [op(FA, TARGET, 0, 2 * HOUR, "invasion"), op(FA, TARGET, 4 * HOUR, 6 * HOUR, "raid"),
      op(FB, TARGET, 0, 9 * HOUR, "invasion")] }));
    const t6 = out.interceptions;
    assert.deepStrictEqual([t6.operations, t6.battles, t6.counts.B_WIN, t6.buckets.find((b) => b.battles > 0).bucket],
      [2, 1, 1, "500-799"]);
    assert.deepStrictEqual([out.attacks.operations, out.attacks.inTarget, out.attacks.outside,
      out.attacks.list.map((g) => [g.factionId, g.targetSystemId, g.operations, g.inTarget, g.outside])],
    [3, 1, 2, [[FA, TARGET, 2, 1, 2], [FB, TARGET, 1, 0, 0]]]);
    const none = auditOdds(rows, deps({ blockades: [], attacks: null }));
    assert.deepStrictEqual([none.interceptions, none.attacks, auditOdds(rows, deps()).interceptions],
      [null, null, null]);
  });

  test("BOA6: T8 gank battles with / without an escort of side B (window, system, faction) "
    + "no escort operation = no data", () => {
    const BELT = 30000003;
    const OTHER_BELT = 30000004;
    const op = (factionId, targetSystemId, plannedAt, dueAt) => ({ factionId, targetSystemId, plannedAt, dueAt,
      completedAt: null });
    const ganks = [op(FA, BELT, 0, 10 * HOUR), op(FA, OTHER_BELT, 0, 10 * HOUR)];
    const rows = [row(1, { systemId: BELT, objective: "destroy", outcome: "B_WIN", createdAt: HOUR }),
      row(2, { systemId: BELT, objective: "destroy", outcome: "A_WIN", createdAt: 5 * HOUR }),
      row(3, { systemId: OTHER_BELT, objective: "destroy", outcome: "A_WIN", createdAt: HOUR }),
      row(4, { systemId: BELT, objective: "destroy", outcome: "DRAW", createdAt: 2 * HOUR }),
      row(5, { systemId: BELT, objective: "destroy", outcome: "B_WIN", createdAt: 11 * HOUR })];
    const escorts = [op(FB, BELT, 0, 3 * HOUR), op(FA, OTHER_BELT, 0, 10 * HOUR)];
    const t8 = auditOdds(rows, deps({ ganks, escorts })).escorts;
    assert.deepStrictEqual([t8.operations, t8.withEscort.battles, t8.withEscort.counts.B_WIN,
      t8.withEscort.counts.DRAW, t8.withoutEscort.battles, t8.withoutEscort.counts.A_WIN],
    [2, 2, 1, 1, 2, 2]);
    assert.deepStrictEqual([auditOdds(rows, deps({ ganks, escorts: [] })).escorts,
      auditOdds(rows, deps({ ganks })).escorts], [null, null]);
  });
};
