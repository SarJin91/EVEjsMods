"use strict";

const assert = require("node:assert");

const { rankRows, tierOf, planRewards } = require("../../lib/seasons/ranking");
const { titleOf } = require("../../lib/seasons/data/titles");
const F = require("./fixture");

module.exports = ({ test }) => {
  test("R3 ranking: ties by last_at then id; minPointsForReward; WON bonus; scaled to maxIskPerSeason", () => {
    const P = F.settingsOf({ maxRankedPlayers: 10, minPointsForReward: 10, tier1MaxRank: 1, tier2MaxRank: 2,
      tier3MaxRank: 3, tier1Isk: 100, tier2Isk: 50, tier3Isk: 20, tier4Isk: 7, wonBonusPermille: 1500,
      maxIskPerSeason: 1000000, tier1ItemTypeId: 34, tier1ItemQty: 3 });
    const ranked = rankRows([{ characterId: 9, points: 50, lastAt: 200 }, { characterId: 5, points: 50, lastAt: 200 },
      { characterId: 4, points: 50, lastAt: 100 }, { characterId: 2, points: 30, lastAt: 5 },
      { characterId: 3, points: 12, lastAt: 1 }, { characterId: 1, points: 9, lastAt: 1 }]);
    assert.deepStrictEqual(ranked.map((r) => [r.characterId, r.rank]), [[4, 1], [5, 2], [9, 3], [2, 4], [3, 5], [1, 6]]);
    assert.deepStrictEqual([tierOf(1, 50, P), tierOf(2, 50, P), tierOf(3, 50, P), tierOf(4, 30, P), tierOf(6, 9, P)],
      ["CHAMPION", "HERO", "VETERAN", "PARTICIPANT", null]);

    const lost = planRewards(ranked, "LOST", P);
    assert.deepStrictEqual(lost.rewards.map((r) => [r.characterId, r.tier, r.iskAmount, r.itemTypeId, r.itemQty]),
      [[4, "CHAMPION", 100, 34, 3], [5, "HERO", 50, 0, 0], [9, "VETERAN", 20, 0, 0], [2, "PARTICIPANT", 7, 0, 0],
        [3, "PARTICIPANT", 7, 0, 0]], "points below minPointsForReward = no reward");
    assert.deepStrictEqual([lost.totalIsk, lost.scaled], [184, false]);
    const won = planRewards(ranked, "WON", P);
    assert.deepStrictEqual(won.rewards.map((r) => r.iskAmount), [150, 75, 30, 10, 10]);

    const capped = planRewards(ranked, "WON", { ...P, maxIskPerSeason: 100 });
    assert.strictEqual(capped.scaled, true);
    assert.ok(capped.totalIsk <= 100, String(capped.totalIsk));
    assert.deepStrictEqual(capped.rewards.map((r) => r.iskAmount), [54, 27, 10, 3, 3]);
    assert.deepStrictEqual(planRewards(ranked, "WON", { ...P, maxIskPerSeason: 0 }).rewards.map((r) => r.iskAmount),
      [0, 0, 0, 0, 0]);
    assert.deepStrictEqual([titleOf("CHAMPION", 3, "en"), titleOf("HERO", 3, "pl"), titleOf("NOPE", 3, "en")],
      ["Season 3 Champion", "Bohater sezonu 3", null]);
  });
};
