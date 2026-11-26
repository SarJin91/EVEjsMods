"use strict";

const { TIER, OUTCOME } = require("./schema");

const TIER_INDEX = Object.freeze({ [TIER.CHAMPION]: 1, [TIER.HERO]: 2, [TIER.VETERAN]: 3, [TIER.PARTICIPANT]: 4 });

function rankRows(rows) {
  const list = (Array.isArray(rows) ? rows : []).filter((r) => r && Number.isSafeInteger(r.characterId)
    && Number.isSafeInteger(r.points) && Number.isSafeInteger(r.lastAt));
  list.sort((a, b) => (b.points - a.points) || (a.lastAt - b.lastAt) || (a.characterId - b.characterId));
  return list.map((r, i) => ({ ...r, rank: i + 1 }));
}

function tierOf(rank, points, p) {
  if (!Number.isSafeInteger(rank) || rank < 1 || !Number.isSafeInteger(points) || points < p.minPointsForReward) {
    return null;
  }
  if (rank <= p.tier1MaxRank) return TIER.CHAMPION;
  if (rank <= p.tier2MaxRank) return TIER.HERO;
  if (rank <= p.tier3MaxRank) return TIER.VETERAN;
  return TIER.PARTICIPANT;
}

function planRewards(ranked, outcome, p) {
  const rewards = [];
  for (const r of Array.isArray(ranked) ? ranked : []) {
    const tier = tierOf(r.rank, r.points, p);
    if (!tier) continue;
    const n = TIER_INDEX[tier];
    const base = p[`tier${n}Isk`];
    const iskAmount = outcome === OUTCOME.WON ? Math.floor(base * p.wonBonusPermille / 1000) : base;
    const itemTypeId = p[`tier${n}ItemTypeId`];
    rewards.push({ characterId: r.characterId, rank: r.rank, points: r.points, tier, iskAmount, itemTypeId,
      itemQty: itemTypeId > 0 ? p[`tier${n}ItemQty`] : 0 });
  }
  const sum = rewards.reduce((s, r) => s + BigInt(r.iskAmount), 0n);
  const cap = BigInt(p.maxIskPerSeason);
  let scaled = false;
  if (sum > cap) {
    scaled = true;
    for (const r of rewards) r.iskAmount = Number(BigInt(r.iskAmount) * cap / sum);
  }
  const totalIsk = rewards.reduce((s, r) => s + r.iskAmount, 0);
  return { rewards, totalIsk, scaled };
}

module.exports = { rankRows, tierOf, planRewards, TIER_INDEX };
