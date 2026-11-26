"use strict";

const { SPECIAL_KINDS } = require("./schema");

const WEIGHT_KEY = Object.freeze({ officer: "specialWeightOfficer", commander: "specialWeightCommander",
  hauler: "specialWeightHauler" });

function nonNegativeInt(value, fallback) {
  return Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

function rollSpecial(waveNumber, S, rng, multiplier) {
  if (waveNumber < S.specialMinWave) return [];
  const chance = Math.min(S.specialChanceMax,
    (S.specialChanceBase + (waveNumber - S.specialMinWave) * S.specialChancePerWave) * multiplier);
  if (!(rng() < chance)) return [];
  const weights = SPECIAL_KINDS.map((kind) => Math.max(0, nonNegativeInt(S[WEIGHT_KEY[kind]], 0)));
  const total = weights.reduce((a, b) => a + b, 0);
  if (total <= 0) return [];
  let pick = rng() * total;
  let index = -1;
  for (let i = 0; i < SPECIAL_KINDS.length; i += 1) {
    if (weights[i] === 0) continue;
    index = i;
    if (pick < weights[i]) break;
    pick -= weights[i];
  }
  return index < 0 ? [] : SPECIAL_KINDS.slice(index);
}

function planWave({ waveNumber, baseMin, baseMax, config, rng, vendorSpecialsEnabled, sizeMultiplier = 1,
  specialChanceMultiplier = 1 }) {
  const S = config;
  const n = Math.max(1, nonNegativeInt(waveNumber, 1));
  const lo = nonNegativeInt(baseMin, 0);
  const hi = Math.max(lo, nonNegativeInt(baseMax, lo));
  const grow = (n - 1) * S.growthPerWave;
  const size = Number.isFinite(sizeMultiplier) && sizeMultiplier > 0 ? sizeMultiplier : 1;
  const scale = (count) => (size === 1 ? count : Math.max(1, Math.round(count * size)));
  const minCount = Math.min(S.maxShipsPerWave, scale(lo + grow));
  const maxCount = Math.min(S.maxShipsPerWave, Math.max(minCount, scale(hi + grow)));
  const special = Number.isFinite(specialChanceMultiplier) && specialChanceMultiplier >= 0
    ? specialChanceMultiplier : 1;
  const specialChain = vendorSpecialsEnabled === true && typeof rng === "function"
    ? rollSpecial(n, S, rng, special) : [];
  return { minCount, maxCount, specialChain };
}

module.exports = { planWave };
