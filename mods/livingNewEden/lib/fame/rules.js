"use strict";

const { TIER } = require("./schema");

const BOUNTY_LEVEL_MIN = 2;
const HALF = 2;

function effectiveHysteresis(p) {
  return Math.max(0, Math.min(p.hysteresis, p.legendMin / HALF, -p.enemyMax / HALF));
}

function tierOf(standing, prevTier, p) {
  if (typeof standing !== "number" || !Number.isFinite(standing)) return TIER.NONE;
  if (standing <= p.enemyMax) return TIER.PUBLIC_ENEMY;
  if (standing >= p.legendMin) return TIER.LEGEND;
  if (prevTier === TIER.PUBLIC_ENEMY && standing <= p.enemyMax + p.hysteresis) return TIER.PUBLIC_ENEMY;
  if (prevTier === TIER.LEGEND && standing >= p.legendMin - p.hysteresis) return TIER.LEGEND;
  return TIER.NONE;
}

function changeOf(prev, next) {
  if (prev === undefined || prev === next) return { announce: false };
  return { announce: next === TIER.LEGEND || next === TIER.PUBLIC_ENEMY };
}

function bountyLevelOf(standing, p) {
  const raw = p.bountyLevelStep > 0 ? p.bountyLevelBase + Math.floor((p.enemyMax - standing) / p.bountyLevelStep)
    : p.bountyLevelBase;
  return Math.max(BOUNTY_LEVEL_MIN, Math.min(p.bountyMaxLevel, Number.isFinite(raw) ? raw : BOUNTY_LEVEL_MIN));
}

module.exports = { effectiveHysteresis, tierOf, changeOf, bountyLevelOf };
