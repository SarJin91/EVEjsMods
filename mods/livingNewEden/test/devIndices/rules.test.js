"use strict";

const assert = require("node:assert");

const R = require("../../lib/world/devIndices/rules");
const F = require("./fixture");

module.exports = ({ test }) => {
  const P = F.settingsFor();
  const step = R.msPerPointOf(1000, P);
  const base = (over) => Object.freeze({ ...R.emptyRow(1, F.T0), version: 1, ...over });

  test("DI1 rules: levels, whole-step decay, gap cap, contested decay, clamp, capture loss, applyDelta, trend", () => {
    assert.deepStrictEqual([0, 999, 1000, 2999, 6000, 7000].map((p) => R.levelOf(p, P)), [0, 0, 1, 2, 5, 5]);
    assert.strictEqual(step, 720000, "5 points per hour = one point per 12 min");

    const row = base({ mil: 100, ind: 50, trade: 10 });
    const twice = R.decayRow(R.decayRow(row, F.T0 + 7 * F.MIN, P), F.T0 + 14 * F.MIN, P);
    const once = R.decayRow(row, F.T0 + 14 * F.MIN, P);
    assert.deepStrictEqual(twice, once);
    assert.deepStrictEqual([once.mil, once.ind, once.trade, once.anchorAt], [99, 49, 9, F.T0 + step]);
    assert.strictEqual(R.decayRow(row, F.T0 + 7 * F.MIN, P), row, "no whole step = the same row");
    assert.strictEqual(R.decayRow(row, F.T0 - 1, P), row, "now before the anchor = unchanged");

    const long = R.decayRow(base({ mil: 1000 }), F.T0 + 48 * F.HOUR, P);
    assert.deepStrictEqual([long.mil, long.anchorAt], [880, F.T0 + 48 * F.HOUR]);
    assert.strictEqual(R.decayRow(base({ mil: 100, decayPermille: 3000 }), F.T0 + 12 * F.MIN, P).mil, 97);
    assert.deepStrictEqual([R.decayPermilleOf("CONTESTED", P), R.decayPermilleOf("OCCUPIED", P),
      R.decayPermilleOf("STABLE", P), R.decayPermilleOf(null, P)], [3000, 3000, 1000, 1000]);
    const zero = R.decayRow(base({ mil: 2 }), F.T0 + F.HOUR + 5, P);
    assert.deepStrictEqual([zero.mil, zero.ind, zero.trade, zero.anchorAt], [0, 0, 0, F.T0 + F.HOUR + 5]);

    const held = base({ mil: 1000, ind: 1000, trade: 1000, controllerFactionId: 500001 });
    const same = R.captureLoss(held, { controllerFactionId: 500001, occupationState: "STABLE" }, P);
    assert.deepStrictEqual([same.lost, same.row], [false, held]);
    const taken = R.captureLoss(held, { controllerFactionId: 500002, occupationState: "CONSOLIDATING" }, P);
    assert.deepStrictEqual([taken.lost, taken.row.mil, taken.row.ind, taken.row.trade, taken.row.controllerFactionId,
      taken.row.decayPermille], [true, 500, 700, 500, 500002, 3000]);
    assert.strictEqual(R.captureLoss(taken.row, { controllerFactionId: 500002, occupationState: "CONSOLIDATING" }, P)
      .lost, false, "the loss happens once");
    const lostToNone = R.captureLoss(held, { controllerFactionId: null, occupationState: "STABLE" }, P);
    assert.deepStrictEqual([lostToNone.lost, lostToNone.row.mil, lostToNone.row.controllerFactionId], [true, 500, null]);
    const fresh = R.captureLoss(base({ mil: 1000 }), { controllerFactionId: 500003, occupationState: "STABLE" }, P);
    assert.deepStrictEqual([fresh.lost, fresh.row.mil, fresh.row.controllerFactionId], [false, 1000, 500003]);

    const top = R.applyDelta(base({ mil: 5990, trade: 5 }), 1, { mil: 40, trade: -30 }, F.T0 + 1, P);
    assert.deepStrictEqual([top.mil, top.trade, top.milTrend, top.indTrend, top.tradeTrend, top.lastInputAt],
      [6000, 0, 1, 0, -1, F.T0 + 1]);
    assert.strictEqual(R.applyDelta(null, 7, {}, F.T0, P), null);
    assert.strictEqual(R.applyDelta(null, 7, { trade: -10 }, F.T0, P), null, "nothing to keep below 0");
    const born = R.applyDelta(null, 7, { mil: 40 }, F.T0, P);
    assert.deepStrictEqual([born.systemId, born.mil, born.version, born.anchorAt, born.milTrend], [7, 40, 0, F.T0, 1]);
    assert.deepStrictEqual(R.trendOf(top, F.T0 + 2, P), { mil: 1, ind: 0, trade: -1 });
    assert.deepStrictEqual(R.trendOf(top, F.T0 + 1 + P.trendWindowMs, P), { mil: 0, ind: 0, trade: 0 });
  });

  test("DI2 fold: battle W / L / D / U / no controller / both sides; kills capped per hour, a new hour resets", () => {
    const fold = (sides, controller) => R.foldBattle({ systemId: 1, sides: sides.map(([factionId, result]) => ({
      factionId, result })) }, controller, P);
    assert.deepStrictEqual(fold([[1, "W"], [2, "L"]], 1), { mil: 40 });
    assert.deepStrictEqual(fold([[1, "L"], [2, "W"]], 1), { mil: -60, trade: -30 });
    assert.deepStrictEqual(fold([[1, "D"], [2, "D"]], 1), {});
    assert.deepStrictEqual(fold([[1, "U"], [2, "U"]], 1), {});
    assert.deepStrictEqual(fold([[1, "W"], [2, "L"]], null), { trade: -10 }, "no controller");
    assert.deepStrictEqual(fold([[1, "W"], [2, "L"]], 3), { trade: -10 }, "the controller did not fight");
    assert.deepStrictEqual(fold([[1, "W"], [1, "L"]], 1), { mil: -60, trade: -30 }, "both sides -> L");

    const Q = { ...P, killPointsCapPerHour: 10 };
    const hour = Math.floor(F.T0 / F.HOUR) * F.HOUR;
    let w = { at: 0, points: 0 };
    const deltas = [];
    for (let i = 0; i < 4; i += 1) {
      const k = R.foldKill({ killAt: hour + i * F.MIN }, w, Q);
      deltas.push([k.delta, k.capped]);
      w = k.window;
    }
    assert.deepStrictEqual(deltas, [[4, false], [4, false], [2, true], [0, true]]);
    assert.deepStrictEqual(w, { at: hour, points: 10 });
    const older = R.foldKill({ killAt: hour - F.MIN }, w, Q);
    assert.deepStrictEqual([older.delta, older.window], [0, { at: hour, points: 10 }], "an older kill: same window");
    const next = R.foldKill({ killAt: hour + F.HOUR }, w, Q);
    assert.deepStrictEqual([next.delta, next.window, next.capped], [4, { at: hour + F.HOUR, points: 4 }, false]);
  });
};
