"use strict";

const assert = require("node:assert");

const { planCarrierLoot } = require("../../lib/fleetExposure/cargoLoot");

const CARGO = Object.freeze({ "mineral/type:35": 200000, "hull/group:frigate": 4, "mineral/type:34": 1000000 });

module.exports = ({ test }) => {
  test("CVL1: share per carrier x 500 permille, ascending type ids, cap per carrier in m3 "
    + "hull keys counted, only hulls -> NO_MINERALS, bad input refused", () => {
    assert.deepStrictEqual(planCarrierLoot(CARGO, 2, { sharePermille: 500, maxM3PerCarrier: 5000 }), {
      ok: true, items: [{ typeId: 34, quantity: 250000 }, { typeId: 35, quantity: 50000 }], units: 300000,
      hullKeysSkipped: 1 });
    assert.deepStrictEqual(planCarrierLoot(CARGO, 2, { sharePermille: 500, maxM3PerCarrier: 1000 }), {
      ok: true, items: [{ typeId: 34, quantity: 83333 }, { typeId: 35, quantity: 16666 }], units: 99999,
      hullKeysSkipped: 1 });
    assert.deepStrictEqual(planCarrierLoot({ "hull/group:frigate": 4 }, 2, { sharePermille: 500, maxM3PerCarrier: 5000 }),
      { ok: false, reason: "NO_MINERALS", hullKeysSkipped: 1 });
    assert.strictEqual(planCarrierLoot({ "mineral/type:34": 1 }, 2, { sharePermille: 500, maxM3PerCarrier: 5000 })
      .reason, "NO_MINERALS");
    for (const n of [null, 0, -1, 1.5]) {
      assert.strictEqual(planCarrierLoot(CARGO, n, { sharePermille: 500, maxM3PerCarrier: 5000 }).reason, "NO_CARGO",
        String(n));
    }
    assert.strictEqual(planCarrierLoot(null, 2, { sharePermille: 500, maxM3PerCarrier: 5000 }).reason, "NO_CARGO");
    assert.strictEqual(planCarrierLoot(CARGO, 2, { sharePermille: 1001, maxM3PerCarrier: 5000 }).reason,
      "INVALID_INPUT");
    assert.strictEqual(planCarrierLoot(CARGO, 2, { sharePermille: 500, maxM3PerCarrier: 0 }).reason, "INVALID_INPUT");
  });
};
