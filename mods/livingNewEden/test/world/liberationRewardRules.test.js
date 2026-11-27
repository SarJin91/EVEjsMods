"use strict";

const assert = require("node:assert");

const { planShares, resolveRewardIssuer, rewardRowsBound } = require("../../lib/world/liberation/rewardRules");
const { LP_CORP_BY_FACTION } = require("../../lib/world/liberation/rewardSchema");
const { STANDINGS_DATA_V1 } = require("../../lib/world/standings/data/standingsData");

const DATA = Object.freeze({ eligible: STANDINGS_DATA_V1.eligibleBeneficiaries,
  rivalByPirate: STANDINGS_DATA_V1.rivalByPirate, lpCorpByFaction: LP_CORP_BY_FACTION });
const GURISTAS = 500010;
const ROGUE_DRONES = 500025;
const CALDARI = 500001;
const GALLENTE = 500004;
const AMARR = 500003;

module.exports = ({ test }) => {
  test("RW1 planShares: min kills, kills DESC + characterId ASC, floor, maxRecipients, isk 0 + lp 0 left out, overflow",
    () => {
      const rows = [{ characterId: 9, kills: 2 }, { characterId: 8, kills: 3 }, { characterId: 7, kills: 8 },
        { characterId: 5, kills: 3 }];
      const r = planShares(rows, { iskPool: 20000000, lpPool: 4000, minKills: 3, maxRecipients: 16 });
      assert.deepStrictEqual(r, { ok: true, shares: [
        { characterId: 7, kills: 8, isk: 11428571, lp: 2285 },
        { characterId: 5, kills: 3, isk: 4285714, lp: 857 },
        { characterId: 8, kills: 3, isk: 4285714, lp: 857 }] });
      const two = planShares(rows, { iskPool: 11, lpPool: 0, minKills: 3, maxRecipients: 2 });
      assert.deepStrictEqual(two.shares.map((s) => [s.characterId, s.isk, s.lp]), [[7, 8, 0], [5, 3, 0]]);
      const tiny = planShares([{ characterId: 1, kills: 10 }, { characterId: 2, kills: 1 }],
        { iskPool: 5, lpPool: 0, minKills: 1, maxRecipients: 4 });
      assert.deepStrictEqual(tiny.shares.map((s) => s.characterId), [1]);
      assert.deepStrictEqual(planShares(rows, { iskPool: 1, lpPool: 1, minKills: 50, maxRecipients: 4 }),
        { ok: true, shares: [] });
      assert.deepStrictEqual(planShares([{ characterId: 1, kills: 4096 }],
        { iskPool: Number.MAX_SAFE_INTEGER, lpPool: 0, minKills: 1, maxRecipients: 1 }),
      { ok: false, reason: "REWARD_OVERFLOW" });
      assert.strictEqual(planShares([{ characterId: 0, kills: 1 }],
        { iskPool: 1, lpPool: 1, minKills: 1, maxRecipients: 1 }).reason, "REWARD_INVALID_INPUT");
      assert.strictEqual(rewardRowsBound(16, 32), 49);
    });

  test("RW2 resolveRewardIssuer: HOME -> SDE -> RIVAL -> NONE, only eligible and never the controller", () => {
    const pirate = { controllerFactionId: GURISTAS, homeFactionId: null };
    assert.deepStrictEqual(resolveRewardIssuer({ ...pirate, homeFactionId: GALLENTE }, { factionId: AMARR }, DATA),
      { factionId: GALLENTE, source: "HOME", lpCorporationId: 1000120 });
    assert.deepStrictEqual(resolveRewardIssuer(pirate, { factionId: AMARR }, DATA),
      { factionId: AMARR, source: "SDE", lpCorporationId: 1000084 });
    assert.deepStrictEqual(resolveRewardIssuer({ ...pirate, homeFactionId: ROGUE_DRONES }, { factionId: GURISTAS },
      DATA), { factionId: CALDARI, source: "RIVAL", lpCorporationId: 1000035 });
    assert.deepStrictEqual(resolveRewardIssuer(pirate, null, DATA),
      { factionId: CALDARI, source: "RIVAL", lpCorporationId: 1000035 });
    assert.strictEqual(resolveRewardIssuer({ controllerFactionId: ROGUE_DRONES, homeFactionId: null }, null, DATA)
      .source, "NONE");
    assert.deepStrictEqual(resolveRewardIssuer({ controllerFactionId: AMARR, homeFactionId: AMARR },
      { factionId: AMARR }, DATA), { factionId: null, source: "NONE", lpCorporationId: null });
  });
};
