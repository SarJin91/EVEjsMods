"use strict";

const { createRng, deriveSeed } = require("../util/rng");

const RNG_STREAM_LOOT = "loot";
const RNG_STREAM_OFFICER_LOOT = "officerLoot";

function planBountyLoot(seed, level, smuggler, data) {
  const list = data && Array.isArray(data.CONTRABAND) ? data.CONTRABAND : [];
  const base = data && data.LEVEL_LOOT_ROLLS ? data.LEVEL_LOOT_ROLLS[level] : undefined;
  if (list.length === 0 || !Number.isSafeInteger(base) || base <= 0 || !Number.isSafeInteger(seed)) return [];
  const rolls = base * (smuggler === 1 || smuggler === true ? data.SMUGGLER_MULTIPLIER : 1);
  const rng = createRng(deriveSeed(seed >>> 0, RNG_STREAM_LOOT));
  const byType = new Map();
  for (let i = 0; i < rolls; i += 1) {
    const e = list[rng.nextInt(0, list.length - 1)];
    const quantity = rng.nextInt(e.min, e.max) * level;
    byType.set(e.typeId, (byType.get(e.typeId) || 0) + quantity);
  }
  return [...byType].sort((a, b) => a[0] - b[0]).map(([typeId, quantity]) => ({ typeId, quantity }));
}

function officerLootSeedOf(seed) {
  return deriveSeed(seed >>> 0, RNG_STREAM_OFFICER_LOOT);
}

module.exports = { planBountyLoot, officerLootSeedOf, RNG_STREAM_LOOT };
