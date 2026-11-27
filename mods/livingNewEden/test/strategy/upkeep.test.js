"use strict";

const assert = require("node:assert");

const { planUpkeep, upkeepRates } = require("../../lib/strategy/ai/upkeep");
const { createRng } = require("../../lib/util/rng");

const HOUR = 3600000;
const AT = 1760000000000 - (1760000000000 % HOUR) + 1234;
const UP = Object.freeze({ periodMs: HOUR, maxCatchUpPeriods: 48, incomePerSystem: 3, incomePerStation: 10,
  reservePerStation: 1, maxReserveUnits: 1000, costPerSystem: 1, capturedCostPerSystem: 4, costPerShipPermille: 100,
  offensiveReservePeriods: 24, abandonAfterUnpaidPeriods: 24, maxAbandonsPerReview: 1, tradeIncomeSharePermille: 200,
  maxResourceUnits: 1000000000 });
const PARAMS = Object.freeze({ upkeep: UP });

function snap(o = {}) {
  return {
    factionId: 500019, round: 3, at: o.at === undefined ? AT : o.at,
    faction: { status: "ACTIVE", resourceUnits: o.res === undefined ? 1000 : o.res,
      reserveUnits: o.reserve === undefined ? 10 : o.reserve, version: 2 },
    upkeep: { mode: o.mode || "ready", paidUntil: o.paidUntil === undefined ? AT - (AT % HOUR) - HOUR : o.paidUntil,
      unpaidPeriods: o.unpaid || 0, controlledCount: o.n === undefined ? 10 : o.n, captured: o.captured || [],
      capturedTruncated: o.truncated === true, liveShips: o.ships || 0, stationCount: o.stations === undefined ? 2
        : o.stations, tradeReady: o.trade === true },
  };
}
const cap = (systemId, extra = {}) => ({ systemId, state: "STABLE", detachedSinceAt: null, factorPermille: 1000,
  ...extra });

module.exports = ({ test }) => {
  test("HC1 hoard ceiling (pure): hoardCapped, 10 periods x income 100 -> credit up to 1000 (note "
    + "UPKEEP_HOARD_CAP), above it no credit and no confiscation, a loss still charged; off = the old formula", () => {
    const s = (res, ships, doctrine) => ({ ...snap({ res, n: 0, stations: 10, ships }),
      ...(doctrine === undefined ? {} : { doctrine }) });
    const on = { upkeep: { ...UP, hoardCapPeriods: 10 } };
    const capped = { hoardCapped: true };
    const got = (r) => [r.intents[0].delta, r.notes.includes("UPKEEP_HOARD_CAP"), r.intents[0].shortfall,
      r.intents[0].unpaidPeriodsTo, r.intents[0].reserveDelta];
    const plain = planUpkeep(s(1200, 1300), null, PARAMS);
    const cases = {
      a: got(planUpkeep(s(950, 200, capped), null, on)),
      b: got(planUpkeep(s(1200, 200, capped), null, on)),
      c: got(planUpkeep(s(1200, 1300, capped), null, on)),
      cPlain: got(plain),
      dOff: planUpkeep(s(950, 200, { hoardCapped: false }), null, on),
      dZero: planUpkeep(s(950, 200, capped), null, { upkeep: { ...UP, hoardCapPeriods: 0 } }),
      dNone: planUpkeep(s(950, 200), null, on),
    };
    const old = planUpkeep(s(950, 200), null, PARAMS);
    assert.deepStrictEqual({ a: cases.a, b: cases.b, c: cases.c, cPlain: cases.cPlain, dOff: cases.dOff,
      dZero: cases.dZero, dNone: cases.dNone }, { a: [50, true, 0, 0, old.intents[0].reserveDelta],
      b: [0, true, 0, 0, old.intents[0].reserveDelta], c: [-30, false, 0, 0, old.intents[0].reserveDelta],
      cPlain: [-30, false, 0, 0, old.intents[0].reserveDelta], dOff: old, dZero: old, dNone: old });
    assert.strictEqual(old.intents[0].delta, 80, "net +80 without the ceiling");
  });

  test("U1b trade share only from the surplus: balance +1/period, res 0, catch-up 48 -> budget <= "
    + "profit after cost, no shortfall / unpaid / abandon caused by the trade", () => {
    const s = (trade) => snap({ trade, res: 0, reserve: 0, n: 10, stations: 1, ships: 250, captured: [cap(1)],
      paidUntil: AT - (AT % HOUR) - 48 * HOUR });
    const off = planUpkeep(s(false), null, PARAMS).intents[0];
    const on = planUpkeep(s(true), null, PARAMS).intents[0];
    assert.deepStrictEqual([off.income, off.cost, off.charged, off.delta, off.shortfall], [40, 39, 48, 48, 0]);
    assert.ok(on.tradeUnits <= on.income - on.cost, JSON.stringify(on));
    assert.ok(on.tradeUnits * on.charged <= off.delta, "budget <= profit after cost");
    assert.deepStrictEqual([on.tradeUnits, on.delta, on.shortfall, on.unpaidPeriodsTo, on.abandon], [1, 0, 0, 0, []]);
    assert.strictEqual(on.delta + on.tradeUnits * on.charged, off.delta, "units only split, never created");
    assert.strictEqual(upkeepRates(snap({ trade: true, ships: 1000, n: 10, stations: 1 }), PARAMS).tradeUnits, 0);
  });

  test("U1 upkeep (pure): rates grow with systems / factor / captured, anchor, catch-up ceiling, abandon order "
    + "fuzz 300 never negative", () => {
    const base = upkeepRates(snap({ ships: 30 }), PARAMS);
    assert.deepStrictEqual(base, { income: 50, cost: 13, reserveIncome: 2, tradeUnits: 0 });
    const more = upkeepRates(snap({ ships: 30, n: 11 }), PARAMS);
    assert.ok(more.cost > base.cost && more.income > base.income);
    const captured = upkeepRates(snap({ ships: 30, n: 11, captured: [cap(1)] }), PARAMS);
    assert.strictEqual(captured.cost, more.cost + UP.capturedCostPerSystem);
    const cut = upkeepRates(snap({ ships: 30, n: 11, captured: [cap(1, { detachedSinceAt: 5, factorPermille: 1500 })] }),
      PARAMS);
    const cutMore = upkeepRates(snap({ ships: 30, n: 11, captured: [cap(1, { detachedSinceAt: 5,
      factorPermille: 4000 })] }), PARAMS);
    assert.ok(cut.cost >= captured.cost && cutMore.cost > cut.cost, `${captured.cost} ${cut.cost} ${cutMore.cost}`);
    assert.strictEqual(cut.income, captured.income - UP.incomePerSystem, "a detached system gives no income");
    assert.strictEqual(upkeepRates(snap({ trade: true }), PARAMS).tradeUnits, 10, "20 % of 50");
    assert.strictEqual(upkeepRates(snap({ mode: "off" }), PARAMS), null);

    assert.deepStrictEqual(planUpkeep(snap(), null, { upkeep: null }).intents, []);
    assert.deepStrictEqual(planUpkeep(snap({ mode: "off" }), null, PARAMS).intents, []);
    const anchor = planUpkeep(snap({ paidUntil: null }), null, PARAMS);
    assert.deepStrictEqual([anchor.intents[0].periods, anchor.intents[0].paidUntilTo, anchor.intents[0].delta,
      anchor.projected.resourceUnits], [0, AT - (AT % HOUR), 0, 1000]);
    assert.deepStrictEqual(planUpkeep(snap({ paidUntil: AT - (AT % HOUR) }), null, PARAMS).intents, [], "0 periods");
    assert.deepStrictEqual(planUpkeep(snap({ paidUntil: AT + HOUR }), null, PARAMS).intents, [], "negative periods");

    const one = planUpkeep(snap(), null, PARAMS).intents[0];
    assert.deepStrictEqual([one.periods, one.charged, one.delta, one.reserveDelta, one.shortfall, one.unpaidPeriodsTo],
      [1, 1, 40, 2, 0, 0]);
    const long = planUpkeep(snap({ paidUntil: AT - (AT % HOUR) - 100 * HOUR }), null, PARAMS);
    assert.deepStrictEqual([long.intents[0].charged, long.intents[0].paidUntilTo, long.notes.includes(
      "UPKEEP_FORGIVEN:52")], [48, AT - (AT % HOUR), true]);

    const poor = { upkeep: { ...UP, incomePerSystem: 0, incomePerStation: 0, abandonAfterUnpaidPeriods: 2,
      maxAbandonsPerReview: 3 } };
    const list = [cap(10), cap(30), cap(20, { detachedSinceAt: 1, factorPermille: 1500 }),
      cap(15, { detachedSinceAt: 1, factorPermille: 2000 }), cap(40, { state: "CONTESTED" })];
    const broke = planUpkeep(snap({ res: 5, n: 12, captured: list, unpaid: 1 }), null, poor);
    const u = broke.intents[0];
    assert.deepStrictEqual([u.delta, u.unpaidPeriodsTo, u.abandon, broke.projected.resourceUnits,
      broke.offensiveAllowed], [-5, 2, [15, 20, 30], 0, false]);
    assert.ok(u.shortfall > 0);
    assert.deepStrictEqual(planUpkeep(snap({ res: 5, n: 12, captured: list, unpaid: 1, truncated: true }), null, poor)
      .intents[0].abandon, [], "a truncated captured list never abandons");
    assert.strictEqual(planUpkeep(snap({ res: 400 }), null, PARAMS).offensiveAllowed, true);
    assert.strictEqual(planUpkeep(snap({ res: 400, n: 40, ships: 400 }), null, PARAMS).offensiveAllowed, false);

    const rng = createRng(604);
    for (let i = 0; i < 300; i += 1) {
      const n = rng.nextInt(0, 400);
      const caps = [];
      for (let k = 0; k < rng.nextInt(0, 6); k += 1) {
        caps.push(cap(1000 + k, { state: rng.pick(["STABLE", "OCCUPIED", "CONSOLIDATING", "CONTESTED"]),
          detachedSinceAt: rng.chance(0.5) ? 1 : null, factorPermille: rng.nextInt(1000, 4000) }));
      }
      const p = { upkeep: { ...UP, incomePerSystem: rng.nextInt(0, 5), incomePerStation: rng.nextInt(0, 20),
        costPerSystem: rng.nextInt(0, 5), capturedCostPerSystem: rng.nextInt(0, 8), maxCatchUpPeriods: rng.nextInt(1, 60),
        maxReserveUnits: rng.nextInt(0, 2000), maxResourceUnits: rng.nextInt(1, 5000000) } };
      const res = rng.nextInt(0, Math.min(p.upkeep.maxResourceUnits, 100000));
      const reserve = rng.nextInt(0, 3000);
      const s = snap({ res, reserve, n, captured: caps, ships: rng.nextInt(0, 2000), stations: rng.nextInt(0, 6),
        unpaid: rng.nextInt(0, 30), trade: rng.chance(0.3),
        paidUntil: rng.chance(0.1) ? null : AT - rng.nextInt(-3, 200) * HOUR });
      const r = planUpkeep(s, null, p);
      assert.ok(r.projected.resourceUnits >= 0 && r.projected.reserveUnits >= 0, `#${i} ${JSON.stringify(r)}`);
      assert.ok(r.projected.resourceUnits <= Math.max(res, p.upkeep.maxResourceUnits), `#${i} cap`);
      for (const x of r.intents) {
        assert.ok(x.delta >= -res && x.reserveDelta >= 0 && x.shortfall >= 0 && x.charged <= p.upkeep.maxCatchUpPeriods,
          `#${i} ${JSON.stringify(x)}`);
        assert.ok(x.abandon.length <= p.upkeep.maxAbandonsPerReview);
      }
    }
  });
};
