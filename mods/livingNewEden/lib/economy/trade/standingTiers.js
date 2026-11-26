"use strict";

const STANDING_MILLI_EPSILON = 1e-9;
const MAX_BONUS_PERMILLE = 1000;

function standingMilliOf(standing) {
  if (typeof standing !== "number" || !Number.isFinite(standing)) return 0;
  return Math.floor(standing * 1000 + STANDING_MILLI_EPSILON);
}

function tiersFromConfig(trade) {
  const rawTiers = [];
  for (let i = 1; i <= 3; i++) {
    const min = trade[`standingThreshold${i}Min`];
    const bonus = trade[`standingThreshold${i}Bonus`];
    if (Number.isFinite(min) && Number.isInteger(bonus)) {
      rawTiers.push({ min, bonusPermille: bonus });
    }
  }

  rawTiers.sort((a, b) => a.min - b.min);

  const filtered = rawTiers.filter((t) => t.bonusPermille > 0);

  for (let i = 0; i < filtered.length; i++) {
    if (filtered[i].bonusPermille > MAX_BONUS_PERMILLE || filtered[i].bonusPermille < 0) {
      return { ok: false, reason: "PRIVATE_TIERS_INVALID" };
    }
  }
  for (let i = 1; i < filtered.length; i++) {
    if (filtered[i].min < filtered[i - 1].min) {
      return { ok: false, reason: "PRIVATE_TIERS_INVALID" };
    }
    if (filtered[i].bonusPermille < filtered[i - 1].bonusPermille) {
      return { ok: false, reason: "PRIVATE_TIERS_INVALID" };
    }
  }

  const tiers = filtered.map((t) => ({
    minMilli: Math.floor(t.min * 1000 + STANDING_MILLI_EPSILON),
    bonusPermille: t.bonusPermille,
  }));

  return { ok: true, tiers };
}

function bonusFor(standingMilli, tiers) {
  if (!Array.isArray(tiers) || tiers.length === 0) return 0;
  if (!Number.isSafeInteger(standingMilli) || standingMilli < 0) return 0;

  for (let i = tiers.length - 1; i >= 0; i--) {
    if (standingMilli >= tiers[i].minMilli) {
      return tiers[i].bonusPermille;
    }
  }
  return 0;
}

function computeStandingBonus(supplierStanding, thresholds) {
  const standingMilli = standingMilliOf(supplierStanding);
  const tiers = thresholds
    .filter((t) => t.bonusPermille > 0)
    .map((t) => ({ minMilli: Math.floor(t.min * 1000 + STANDING_MILLI_EPSILON), bonusPermille: t.bonusPermille }))
    .sort((a, b) => a.minMilli - b.minMilli);
  return bonusFor(standingMilli, tiers);
}

module.exports = {
  standingMilliOf,
  tiersFromConfig,
  bonusFor,
  computeStandingBonus,
  STANDING_MILLI_EPSILON,
  MAX_BONUS_PERMILLE,
};