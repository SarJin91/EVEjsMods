"use strict";

const assert = require("node:assert");

const { gateWin, rollStart, checkLimits } = require("../../lib/archaeology/startPolicy");

const ALLOWED = new Set(["lowsec", "nullsec"]);
const win = (extra = {}) => ({ instanceId: 7001, systemId: 30000001, siteFamily: "relic", siteKind: "signature",
  own: false, lneEventId: null, excluded: false, characterId: 90000001, outcomeId: "o-1", atMs: 1, ...extra });

module.exports = ({ test }) => {
  test("A2 archaeology startPolicy: gateWin refusals in order, rollStart seeded (0 / 1000 permille), checkLimits "
    + "order", () => {
    const gate = (w, secClass = "nullsec") => gateWin(w, { secClass, allowedSecClasses: ALLOWED });
    assert.deepStrictEqual(gate(win()), { ok: true });
    assert.deepStrictEqual(gate(win({ siteFamily: "data" }), "lowsec"), { ok: true });
    assert.strictEqual(gate(win({ excluded: true, own: true, lneEventId: "arc:s0:1:1", siteFamily: "combat" }), null)
      .reason, "EXCLUDED");
    assert.strictEqual(gate(win({ own: true, lneEventId: "arc:s0:1:1", siteFamily: "combat" }), null).reason,
      "OWN_ARCH");
    assert.deepStrictEqual(gate(win({ own: true, lneEventId: "esc:1:2" })), { ok: true }, "an own non-archive site");
    assert.strictEqual(gate(win({ siteFamily: "combat" }), null).reason, "FAMILY");
    assert.strictEqual(gate(win(), null).reason, "SYSTEM_UNKNOWN");
    assert.strictEqual(gate(win(), "highsec").reason, "SEC_CLASS");

    const r1 = rollStart(42, win(), 100);
    assert.deepStrictEqual(rollStart(42, win(), 100), r1);
    assert.notStrictEqual(rollStart(42, win({ outcomeId: "o-2" }), 100).seed, r1.seed);
    let hits = 0;
    for (let i = 0; i < 200; i += 1) {
      const w = win({ instanceId: 8000 + i });
      assert.strictEqual(rollStart(42, w, 0).hit, false);
      assert.strictEqual(rollStart(42, w, 1000).hit, true);
      if (rollStart(42, w, 100).hit) hits += 1;
    }
    assert.ok(hits >= 5 && hits <= 40, `100 permille of 200: ${hits}`);

    const S = { chainsPerCharacterPerSeason: 1, restartCooldownMs: 1000, maxActiveChains: 2 };
    const counts = (x = {}) => ({ hasActive: false, seasonCount: 0, lastEndedAt: null, activeTotal: 0, ...x });
    assert.deepStrictEqual(checkLimits(counts(), S, 5000), { ok: true });
    assert.strictEqual(checkLimits(counts({ hasActive: true, seasonCount: 9, lastEndedAt: 4999, activeTotal: 9 }), S,
      5000).reason, "ACTIVE_EXISTS");
    assert.strictEqual(checkLimits(counts({ seasonCount: 1, lastEndedAt: 4999, activeTotal: 9 }), S, 5000).reason,
      "SEASON_LIMIT");
    assert.strictEqual(checkLimits(counts({ lastEndedAt: 4999, activeTotal: 9 }), { ...S,
      chainsPerCharacterPerSeason: 2 }, 5000).reason, "COOLDOWN");
    assert.deepStrictEqual(checkLimits(counts({ lastEndedAt: 4000 }), S, 5000), { ok: true }, "cooldown passed");
    assert.strictEqual(checkLimits(counts({ activeTotal: 2 }), S, 5000).reason, "GLOBAL_LIMIT");
  });
};
