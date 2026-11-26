"use strict";

const TIER_COUNT = 3;
const PERMILLE = 1000;
const VOLUME_UNITS_PER_M3 = 100;

const TIER_KEYS = Object.freeze(["tier1Isk", "tier2Isk", "tier3Isk", "tier1TtlMs", "tier2TtlMs", "tier3TtlMs",
  "tier2SharePermille", "tier3SharePermille"]);

function tierOf(isk, cfg) {
  if (isk <= cfg.tier1Isk) return 1;
  if (isk <= cfg.tier2Isk) return 2;
  return 3;
}

function tierCapOf(tier, cfg) {
  return tier <= 1 ? cfg.tier1Isk : tier === 2 ? cfg.tier2Isk : cfg.tier3Isk;
}

function tierTtlOf(tier, cfg) {
  return tier <= 1 ? cfg.tier1TtlMs : tier === 2 ? cfg.tier2TtlMs : cfg.tier3TtlMs;
}

function tierQuotas(factionCap, cfg) {
  const cap = Math.max(0, Math.floor(factionCap) || 0);
  const q3 = Math.floor((cap * cfg.tier3SharePermille) / PERMILLE);
  const q2 = Math.floor((cap * cfg.tier2SharePermille) / PERMILLE);
  return [Math.max(0, cap - q2 - q3), q2, q3];
}

function tierCfgOf(tradeCfg) {
  if (!tradeCfg || tradeCfg.tiersEnabled !== true) return null;
  return Object.freeze(Object.fromEntries(TIER_KEYS.map((k) => [k, tradeCfg[k]])));
}

function mulDivFloor(a, b, d) {
  return Math.floor(a / d) * b + Math.floor(((a % d) * b) / d);
}

module.exports = { TIER_COUNT, TIER_KEYS, VOLUME_UNITS_PER_M3, tierOf, tierCapOf, tierTtlOf, tierQuotas, tierCfgOf,
  mulDivFloor };
