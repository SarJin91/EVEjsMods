"use strict";

const DEFAULTS = Object.freeze({
  enabled: true,
  chanceSmall: 0.04,
  chanceMedium: 0.08,
  chanceLarge: 0.16,
  chanceOther: 0.06,
  copyShare: 0.65,
  t1OriginalShare: 0.25,
  t2OriginalShare: 0.10,
  copyMaxRuns: 10,
  copyMaxMaterialEfficiency: 10,
  copyMaxTimeEfficiency: 20,
  log: true,
  salvageCopyFix: true,
  resonatorsEnabled: false,
  resonatorChance: { frigate: 0.10, destroyer: 0.12, cruiser: 0.15, battlecruiser: 0.18, battleship: 0.25, capital: 0.50, hauler: 0 },
  resonatorQuantity: { frigate: [1, 3], destroyer: [1, 4], cruiser: [2, 6], battlecruiser: [3, 8], battleship: [4, 12], capital: [40, 80], hauler: [0, 0] },
  resonatorEliteChance: 0.50,
  resonatorEliteQuantityMultiplier: 3,
  resonatorComponentsEnabled: true,
  componentChance: 0.30,
  componentAipsPerResonator: 0.5,
  componentLsbuPerResonator: 0.25,
  componentCtrChance: { battleship: 0.05, capital: 1 },
  componentCtrEliteChance: 0.25,
  soeFromAllPirates: true,
  soeChanceMultiplier: 0.25,
  resonatorLogDrops: false,
  resonatorSummaryEvery: 50,
  factionLootEnabled: false,
  factionLootUncommonScale: 1,
  factionLootRareScale: 1,
  factionLootEpicScale: 1,
  factionLootMaxEntriesPerWreck: 3,
  factionLootRareCapPerHour: 120,
  factionLootEpicCapPerHour: 12,
  factionLootLog: false,
  factionLootSummaryEvery: 100,
  factionLootSeedSalt: "factionLoot",
  factionLootTierChance: {
    normal: { uncommon: 0.05, rare: 0.003, epic: 0.0002 },
    deadspace: { uncommon: 0.08, rare: 0.006, epic: 0.0005 },
    mission: { uncommon: 0.04, rare: 0.002, epic: 0.0001 },
    commander: { uncommon: 0.40, rare: 0.04, epic: 0.004 },
    overseer: { uncommon: 0.50, rare: 0.06, epic: 0.008 },
    officer: { uncommon: 0.60, rare: 0.08, epic: 0.015 },
  },
  factionLootBandScale: { frigate: 1, destroyer: 1.2, cruiser: 1.5, battlecruiser: 2, battleship: 3, capital: 6, hauler: 0.5 },
  factionLootCategoryWeights: { uncommon: { tag: 5, ammo: 4, material: 3 }, rare: { module: 4, deadspace: 1 },
    epic: { bpcModule: 4, bpcHull: 1 }, common: { ammo: 5, module: 3, salvage: 3 } },
  factionLootBpcRuns: { bpcModule: [1, 3], bpcHull: [1, 1] },
  factionLootQuantity: { tag: [1, 2], ammo: [10, 40], material: [1, 4], module: [1, 1], deadspace: [1, 1], salvage: [1, 5] },
  factionLootTierQuantityMultiplier: { normal: 1, deadspace: 1, mission: 1, commander: 2, overseer: 3, officer: 3 },
  factionLootSkipFactionIDs: [500006],
  factionLootFillerEnabled: true,
  factionLootFillerMaxEntries: 3,
  factionLootFillerEntries: [1, 3],
  factionLootFillerTierQuantity: false,
  factionLootSkipTables: ["parity_abyssal_entities_pending_loot"],
  factionLootFillerExcludeTables: ["parity_abyssal_entities_pending_loot", "parity_law_enforcement_entities_pending_loot",
    "parity_zero_damage_target_shell_entities_pending_loot", "parity_destructible_sentry_guns_pending_loot"],
});

const NESTED_KEYS = Object.freeze(["resonatorChance", "resonatorQuantity", "componentCtrChance",
  "factionLootTierChance", "factionLootBandScale", "factionLootCategoryWeights", "factionLootBpcRuns", "factionLootQuantity",
  "factionLootTierQuantityMultiplier", "factionLootSkipFactionIDs", "factionLootFillerEntries", "factionLootFillerExcludeTables",
  "factionLootSkipTables"]);

function mergeSettings(file) {
  const own = file && typeof file === "object" && !Array.isArray(file) ? file : {};
  const merged = { ...DEFAULTS, ...own };
  for (const key of NESTED_KEYS) {
    const value = own[key];
    if (Array.isArray(DEFAULTS[key])) {
      merged[key] = Array.isArray(value) ? [...value] : value === undefined ? [...DEFAULTS[key]] : value;
      continue;
    }
    merged[key] = isPlainObject(value) ? deepMerge(DEFAULTS[key], value) : value === undefined ? deepMerge(DEFAULTS[key], {}) : value;
  }
  return merged;
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function deepMerge(base, over) {
  const out = {};
  for (const [k, v] of Object.entries(base)) out[k] = isPlainObject(v) ? deepMerge(v, {}) : Array.isArray(v) ? [...v] : v;
  for (const [k, v] of Object.entries(over)) {
    out[k] = isPlainObject(v) && isPlainObject(out[k]) ? deepMerge(out[k], v) : Array.isArray(v) ? [...v] : v;
  }
  return out;
}

module.exports = { DEFAULTS, NESTED_KEYS, mergeSettings };
