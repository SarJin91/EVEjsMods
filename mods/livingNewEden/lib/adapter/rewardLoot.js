"use strict";

const REWARD_TABLE_PREFIX = "lne_reward_";

const ID_PATTERN = /^[a-z0-9_]{3,48}$/;
const SIZE_BANDS = Object.freeze(["small", "medium", "large"]);

const LIMITS = Object.freeze({
  maxItemPrefixes: 4,
  maxDeadspacePrefixes: 4,
  maxWeight: 1000,
  minEntries: 1,
  maxEntries: 6,
});

const FILLER = Object.freeze({ ammo: 40, module: 15, utility: 15, trash: 15 });

// Quantity ranges (port of lootRebalance commanderTable, lootRebalance.js:106-127).
const QUANTITY = Object.freeze({
  fillerAmmo: Object.freeze({ min: 30, max: 100 }),
  factionAmmo: Object.freeze({ min: 10, max: 40 }),
  trash: Object.freeze({ min: 1, max: 5 }),
});

// Port of tools/lootRebalance/lootRebalance.js:71-72 (capital, XL and other wrong-size names).
const NAME_EXCLUDES = Object.freeze(["Capital", "XL", "X-Large", "10000MN", "50000MN", "Dual 1000mm",
  "Quad 3500mm", "Triple 2500mm", "25000mm", "Siege"]);

// Port of tools/lootRebalance/lootRebalance.js:187-195 (guns of another size the vendor size bands let through).
const SIZE_NAME_EXCLUDES = Object.freeze({
  small: Object.freeze(["Dual 150mm", "Quad ", "Rapid Light", "200mm 'Scout' Accelerator", "200mm Carbide",
    "200mm Compressed", "200mm Prototype Gauss", "200mm Railgun"]),
  medium: Object.freeze(["250mm Light", "350mm", "425mm 'Popper'", "425mm 'Scout' Accelerator", "425mm Carbide",
    "425mm Compressed", "425mm Prototype Gauss", "425mm Railgun", "800mm", "1200mm", "Dual 250mm", "Dual 425mm",
    "Dual Afocal Heavy", "Dual Anode Heavy", "Dual Heavy", "Dual Modal Heavy", "Dual Modulated Heavy",
    "Heavy Capacitor Booster", "Heavy 'Brave'", "Heavy F-RX"]),
  large: Object.freeze(["650mm Artillery", "650mm Medium", "720mm", "Quad ", "X-Large"]),
});

function invalid(detail) {
  return { ok: false, reason: "REWARD_LOOT_INVALID", detail };
}

function isPrefixList(value, min, max) {
  return Array.isArray(value) && value.length >= min && value.length <= max
    && value.every((p) => typeof p === "string" && p.trim() !== "");
}

function isWeight(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= LIMITS.maxWeight;
}

function isEntryCount(value) {
  return Number.isSafeInteger(value) && value >= LIMITS.minEntries && value <= LIMITS.maxEntries;
}

function invalidField(spec) {
  if (!spec || typeof spec !== "object" || Array.isArray(spec)) return "spec";
  if (typeof spec.id !== "string" || !ID_PATTERN.test(spec.id)) return "id";
  if (!SIZE_BANDS.includes(spec.sizeBand)) return "sizeBand";
  if (!isPrefixList(spec.itemPrefixes, 1, LIMITS.maxItemPrefixes)) return "itemPrefixes";
  if (!isPrefixList(spec.deadspacePrefixes, 0, LIMITS.maxDeadspacePrefixes)) return "deadspacePrefixes";
  for (const field of ["factionAmmoWeight", "factionModuleWeight", "deadspaceModuleWeight"]) {
    if (!isWeight(spec[field])) return field;
  }
  if (!isEntryCount(spec.minEntries)) return "minEntries";
  if (!isEntryCount(spec.maxEntries) || spec.maxEntries < spec.minEntries) return "maxEntries";
  return null;
}

// Port of lootRebalance withSizeExcludes (lootRebalance.js:198-202): own excludes first, no duplicates.
function withSizeExcludes(selector) {
  if ((selector.kind !== "module" && selector.kind !== "utility") || !SIZE_NAME_EXCLUDES[selector.sizeBand]) {
    return selector;
  }
  const own = Array.isArray(selector.nameExcludes) ? selector.nameExcludes : [];
  return {
    ...selector,
    nameExcludes: [...own, ...SIZE_NAME_EXCLUDES[selector.sizeBand].filter((n) => !own.includes(n))],
  };
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) deepFreeze(value[key]);
  }
  return value;
}

function buildRewardLootTable(spec) {
  const bad = invalidField(spec);
  if (bad) return invalid(bad);
  const size = spec.sizeBand;
  const itemPrefixes = [...spec.itemPrefixes];
  const deadspacePrefixes = [...spec.deadspacePrefixes];
  const candidates = [
    { kind: "ammo", tier: "low", sizeBand: size, weight: FILLER.ammo,
      quantityMin: QUANTITY.fillerAmmo.min, quantityMax: QUANTITY.fillerAmmo.max },
    { kind: "module", tier: "low", sizeBand: size, weight: FILLER.module },
    { kind: "utility", tier: "low", sizeBand: size, weight: FILLER.utility },
    { kind: "trash", tier: "low", weight: FILLER.trash, quantityMin: QUANTITY.trash.min, quantityMax: QUANTITY.trash.max },
    { kind: "ammo", grade: "faction", sizeBand: size, nameIncludes: itemPrefixes, nameExcludes: [...NAME_EXCLUDES],
      weight: spec.factionAmmoWeight, quantityMin: QUANTITY.factionAmmo.min, quantityMax: QUANTITY.factionAmmo.max },
    { kind: "module", grade: "faction", sizeBand: size, nameIncludes: itemPrefixes, nameExcludes: [...NAME_EXCLUDES],
      weight: spec.factionModuleWeight },
  ];
  if (deadspacePrefixes.length > 0) {
    candidates.push({ kind: "module", grade: "deadspace", sizeBand: size, nameIncludes: deadspacePrefixes,
      nameExcludes: [...NAME_EXCLUDES], weight: spec.deadspaceModuleWeight });
  }
  const selectors = candidates.filter((s) => s.weight > 0).map(withSizeExcludes);
  return {
    ok: true,
    table: deepFreeze({
      lootTableID: `${REWARD_TABLE_PREFIX}${spec.id}`,
      name: `LNE reward ${spec.id}`,
      mode: "rule",
      minEntries: spec.minEntries,
      maxEntries: spec.maxEntries,
      emptyChance: 0,
      allowDuplicates: false,
      selectors,
    }),
  };
}

function isFactionRewardName(name, spec) {
  if (typeof name !== "string" || name === "" || !spec || typeof spec !== "object") return false;
  const lower = name.toLowerCase();
  const prefixes = [
    ...(Array.isArray(spec.itemPrefixes) ? spec.itemPrefixes : []),
    ...(Array.isArray(spec.deadspacePrefixes) ? spec.deadspacePrefixes : []),
  ];
  return prefixes.some((p) => typeof p === "string" && p.trim() !== "" && lower.includes(p.trim().toLowerCase()));
}

module.exports = {
  REWARD_TABLE_PREFIX,
  FILLER,
  NAME_EXCLUDES,
  SIZE_NAME_EXCLUDES,
  LIMITS,
  buildRewardLootTable,
  isFactionRewardName,
};
