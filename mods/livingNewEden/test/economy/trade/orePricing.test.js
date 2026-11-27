"use strict";

const assert = require("node:assert");

const { quoteOre, refineOre } = require("../../../lib/economy/trade/orePricing");
const { quote } = require("../../../lib/economy/trade/pricing");

const P = { premiumPermille: 1100, askCapPermille: 980, maxUnitPriceMilli: 1e12, efficiencyPermille: 800 };
const VELD = { portionSize: 100, minerals: [["type:34", 400]] };
const SPOD = { portionSize: 100, minerals: [["type:34", 48000], ["type:37", 1000]] };
const mq = (unitMilli) => quote({ bidMilli: unitMilli, askMilli: unitMilli * 10, baseMilli: null },
  { premiumPermille: 1000, askCapPermille: 980, bonusPermille: 0, maxUnitPriceMilli: 1e12 });

module.exports = ({ test }) => {
  test("OP1 tiers-3a quoteOre cap / NO_PRICE / PRICE_TOO_HIGH and refineOre portions / remainder / headroom", () => {
    const minerals = { "type:34": mq(5000) };
    assert.strictEqual(minerals["type:34"].unitMilli, 5000);
    const high = quoteOre({ bidMilli: 30000, askMilli: 40000, baseMilli: null }, minerals, VELD, P);
    assert.strictEqual(high.ok, true, JSON.stringify(high));
    assert.strictEqual(high.itemKind, "ore");
    assert.strictEqual(high.marketUnitMilli, 33000);
    assert.strictEqual(high.refinedCapMilli, 16000);
    assert.strictEqual(high.unitMilli, 16000);
    assert.strictEqual(high.refineCapped, true);
    assert.ok(high.capMilli <= high.refinedCapMilli);
    assert.strictEqual(high.source, "bid");

    const low = quoteOre({ bidMilli: 10000, askMilli: 40000, baseMilli: null }, minerals, VELD, P);
    assert.strictEqual(low.unitMilli, 11000);
    assert.strictEqual(low.refineCapped, false);
    assert.strictEqual(low.capMilli, 16000, "min(ask cap 39200, refined 16000)");

    assert.deepStrictEqual(quoteOre({ bidMilli: 10000, askMilli: null, baseMilli: 9000 }, minerals, VELD, P),
      { ok: false, reason: "NO_PRICE" });
    assert.deepStrictEqual(quoteOre(null, minerals, VELD, P), { ok: false, reason: "NO_PRICE" });
    assert.deepStrictEqual(quoteOre({ bidMilli: 10000, askMilli: 40000, baseMilli: null }, minerals, SPOD, P),
      { ok: false, reason: "NO_PRICE" }, "type:37 has a yield and no quote");
    const huge = { "type:34": mq(1e12), "type:37": mq(1e12) };
    assert.strictEqual(huge["type:34"].unitMilli, 1e12);
    assert.deepStrictEqual(quoteOre({ bidMilli: 1e11, askMilli: 1e12, baseMilli: null }, huge, SPOD, P),
      { ok: false, reason: "PRICE_TOO_HIGH" });

    const headroom = new Map([["type:34", 1e12]]);
    const base = { portionSize: 100, efficiencyPermille: 800, minerals: VELD.minerals };
    assert.deepStrictEqual(refineOre({ ...base, voided: 250, headroom }),
      { ok: true, portions: 2, remainder: 50, cut: false, deltas: [{ itemKey: "type:34", delta: 640 }] });
    assert.deepStrictEqual(refineOre({ ...base, voided: 350, headroom: new Map([["type:34", 700]]) }),
      { ok: true, portions: 2, remainder: 50, cut: true, deltas: [{ itemKey: "type:34", delta: 640 }] });
    assert.deepStrictEqual(refineOre({ ...base, voided: 50, headroom }),
      { ok: true, portions: 0, remainder: 50, cut: false, deltas: [] });
    assert.strictEqual(refineOre({ ...base, voided: -1, headroom }).reason, "INVALID_INPUT");
  });
};
