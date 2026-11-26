"use strict";

const { FACTION_LABELS: DIRECTOR_LABELS } = require("../data/eventCatalog");
const { FACTION_CATALOG } = require("../../strategy/data/factionCatalog");
const { CAPITAL_HULL_GROUPS } = require("../../fleets/schema");

const SIZE = Object.freeze({ SMALL: "small", MEDIUM: "medium", LARGE: "large" });

const HULL_SIZE = Object.freeze({
  frigate: SIZE.SMALL,
  destroyer: SIZE.SMALL,
  tackle: SIZE.SMALL,
  mining_frigate: SIZE.SMALL,
  cruiser: SIZE.MEDIUM,
  battlecruiser: SIZE.MEDIUM,
  logistics: SIZE.MEDIUM,
  ewar: SIZE.MEDIUM,
  industrial: SIZE.MEDIUM,
  mining_barge: SIZE.MEDIUM,
  exhumer: SIZE.MEDIUM,
  porpoise: SIZE.MEDIUM,
  battleship: SIZE.LARGE,
  capital: SIZE.LARGE,
  orca: SIZE.LARGE,
  rorqual: SIZE.LARGE,
  freighter: SIZE.LARGE,
  jump_freighter: SIZE.LARGE,
  carrier: SIZE.LARGE,
  dreadnought: SIZE.LARGE,
  force_auxiliary: SIZE.LARGE,
  supercarrier: SIZE.LARGE,
  titan: SIZE.LARGE,
});

function sameForAllSizes(id) {
  return Object.freeze({ [SIZE.SMALL]: id, [SIZE.MEDIUM]: id, [SIZE.LARGE]: id });
}

const BELT_NORMAL = Object.freeze({ [SIZE.SMALL]: "loot_belt_normal_small", [SIZE.MEDIUM]: "loot_belt_normal_medium",
  [SIZE.LARGE]: "loot_belt_normal_large" });

const LOOT_TABLES = Object.freeze({
  500010: BELT_NORMAL,
  500011: BELT_NORMAL,
  500012: BELT_NORMAL,
  500019: BELT_NORMAL,
  500020: BELT_NORMAL,
  500025: sameForAllSizes("loot_rogue_drone_belt_normal"),
  500021: Object.freeze({ [SIZE.SMALL]: "loot_sleeper_blue_small", [SIZE.MEDIUM]: "loot_sleeper_blue_medium",
    [SIZE.LARGE]: "loot_sleeper_blue_large" }),
});

const DEFAULT_LOOT_ROW = BELT_NORMAL;
const EMPTY_SET = Object.freeze(new Set());

const LOOT_SOURCE_NPC = Object.freeze({
  500010: Object.freeze({ frigate: 2382, destroyer: 23312, cruiser: 2387, battlecruiser: 23321, battleship: 11932,
    capital: 37465, hauler: 13714 }),
  500011: Object.freeze({ frigate: 2372, destroyer: 22812, cruiser: 10017, battlecruiser: 22822, battleship: 11898,
    capital: 37461, hauler: 13678 }),
  500012: Object.freeze({ frigate: 10275, destroyer: 23245, cruiser: 10281, battlecruiser: 23244, battleship: 11905,
    capital: 37463, hauler: 13690 }),
  500019: Object.freeze({ frigate: 10025, destroyer: 23378, cruiser: 10030, battlecruiser: 23383, battleship: 11913,
    capital: 37467, hauler: 13726 }),
  500020: Object.freeze({ frigate: 2370, destroyer: 23423, cruiser: 2381, battlecruiser: 23438, battleship: 11921,
    capital: 37468, hauler: 13702 }),
  500018: Object.freeze({ frigate: 16019, cruiser: 16027, battleship: 16034 }),
});

const LOOT_SOURCE_BAND = Object.freeze({
  frigate: "frigate", tackle: "frigate", mining_frigate: "frigate", destroyer: "destroyer", cruiser: "cruiser",
  logistics: "cruiser", ewar: "cruiser", battlecruiser: "battlecruiser", battleship: "battleship",
  capital: "battleship", industrial: "hauler", orca: "hauler", porpoise: "hauler", rorqual: "hauler",
  mining_barge: "hauler", exhumer: "hauler", freighter: "hauler", jump_freighter: "hauler",
  carrier: "battleship", dreadnought: "battleship", force_auxiliary: "battleship", supercarrier: "battleship",
  titan: "battleship",
});

const FACTION_LABELS = Object.freeze({
  ...DIRECTOR_LABELS,
  500021: "Sleeper",
  500025: "Rogue Drone",
});

const DEFAULT_LABEL = "Battle";
const LABEL_SUFFIX = " Wreckage";

const WRECK_FACTION_NAMES = Object.freeze({
  500021: "Sleeper",
});

const HULL_CLASS = Object.freeze({
  frigate: "Frigate", tackle: "Frigate", mining_frigate: "Frigate", destroyer: "Destroyer",
  cruiser: "Cruiser", logistics: "Cruiser", ewar: "Cruiser", battlecruiser: "Battlecruiser", battleship: "Battleship",
  industrial: "Hauler", orca: "Hauler", porpoise: "Hauler", rorqual: "Hauler", mining_barge: "Mining Barge",
  exhumer: "Mining Barge", freighter: "Freighter", jump_freighter: "Freighter", capital: "Dreadnought",
  carrier: "Carrier", dreadnought: "Dreadnought", force_auxiliary: "Dreadnought", supercarrier: "Supercarrier",
  titan: "Titan",
});

const RACE_WRECK_PREFIX = Object.freeze({
  500001: "Caldari", 500002: "Minmatar", 500003: "Amarr", 500004: "Gallente",
  500007: "Amarr", 500008: "Amarr", 500015: "Minmatar",
});

const RACE_HULL_CLASSES = Object.freeze(["Frigate", "Destroyer", "Cruiser", "Battlecruiser", "Hauler",
  "Mining Barge", "Freighter", "Dreadnought"]);

const PIRATE_SIZE_WRECK = Object.freeze({
  500010: "Guristas", 500011: "Angel", 500012: "Blood", 500019: "Sanshas",
  500020: "Serpentis", 500025: "Rogue", 500021: "Sleeper",
});
const PIRATE_SIZE_SUFFIX = Object.freeze({ 500021: " Basic Wreck" });
const DEFAULT_SIZE_SUFFIX = " Wreck";
const SIZE_WORD = Object.freeze({ small: "Small", medium: "Medium", large: "Large" });

const PIRATE_CAPITAL_WRECK = Object.freeze({
  500010: "Guristas Dreadnought Wreck", 500011: "Angel Dreadnought Wreck",
  500012: "Blood Dreadnought Wreck", 500019: "Sansha Dreadnought Wreck", 500020: "Serpentis Dreadnought Wreck",
  500025: "Rogue Carrier Wreck",
});
const CAPITAL_GROUP = "capital";
const CAPITAL_WRECK_GROUPS = Object.freeze([CAPITAL_GROUP, ...CAPITAL_HULL_GROUPS]);

const HULL_WRECK = Object.freeze({ rorqual: Object.freeze(["ORE Rorqual Wreck"]) });

const ORE_FACTION_ID = 500014;
const ORE_FREIGHTER_WRECK = "ORE Freighter Wreck";
const ORE_FREIGHTER_GROUPS = Object.freeze(["freighter", "jump_freighter"]);

const GENERIC_WRECK = Object.freeze({
  small: Object.freeze(["Frigate Wreck", "Mission Generic Small Wreck", "Wreck"]),
  medium: Object.freeze(["Cruiser Wreck", "Mission Generic Medium Wreck", "Wreck"]),
  large: Object.freeze(["Battleship Wreck", "Mission Generic Large Wreck", "Wreck"]),
});

const FALLBACK_OWNER_CORPORATION_ID = 1000137;

const CATALOG_BY_ID = new Map(FACTION_CATALOG.map((f) => [f.factionId, f]));

function sizeOf(hullGroup) {
  return HULL_SIZE[hullGroup] || SIZE.MEDIUM;
}

function lootTableOf(factionId, hullGroup) {
  const row = LOOT_TABLES[factionId];
  return row ? row[sizeOf(hullGroup)] : null;
}

function resolveLootTable(factionId, hullGroup, opts) {
  const o = opts || {};
  const unusable = o.unusable instanceof Set ? o.unusable : EMPTY_SET;
  const randomAny = o.randomAny instanceof Set ? o.randomAny : EMPTY_SET;
  const fallbackId = typeof o.fallbackId === "string" && o.fallbackId !== "" ? o.fallbackId : null;
  const row = lootTableOf(factionId, hullGroup);
  if (o.sizedDefault !== true) return row && !unusable.has(row) ? row : fallbackId;
  if (row && !unusable.has(row)) return row;
  const sized = DEFAULT_LOOT_ROW[sizeOf(hullGroup)];
  if (sized && !unusable.has(sized)) return sized;
  if (fallbackId && !unusable.has(fallbackId) && !randomAny.has(fallbackId)) return fallbackId;
  return null;
}

function lootSourceNpcTypeOf(factionId, hullGroup) {
  const row = LOOT_SOURCE_NPC[factionId];
  const typeId = row ? row[LOOT_SOURCE_BAND[hullGroup]] : undefined;
  return Number.isSafeInteger(typeId) && typeId > 0 ? typeId : 0;
}

function ownerCorporationOf(factionId) {
  const entry = CATALOG_BY_ID.get(factionId);
  const corp = entry && entry.corporationId;
  return Number.isSafeInteger(corp) && corp > 0 ? corp : FALLBACK_OWNER_CORPORATION_ID;
}

function wreckFactionNameOf(factionId) {
  if (WRECK_FACTION_NAMES[factionId]) return WRECK_FACTION_NAMES[factionId];
  const entry = CATALOG_BY_ID.get(factionId);
  return entry && typeof entry.name === "string" ? entry.name : null;
}

function siteLabelOf(factionId) {
  return `${FACTION_LABELS[factionId] || DEFAULT_LABEL}${LABEL_SUFFIX}`;
}

function hasOwn(obj, key) {
  return key !== null && key !== undefined && Object.prototype.hasOwnProperty.call(obj, key);
}

function fallbackWreckNamesOf(hullGroup, factionId) {
  const size = sizeOf(hullGroup);
  const out = [];
  const add = (name) => { if (typeof name === "string" && !out.includes(name)) out.push(name); };
  if (hasOwn(HULL_WRECK, hullGroup)) for (const name of HULL_WRECK[hullGroup]) add(name);
  if (CAPITAL_WRECK_GROUPS.includes(hullGroup) && hasOwn(PIRATE_CAPITAL_WRECK, factionId)) {
    add(PIRATE_CAPITAL_WRECK[factionId]);
  }
  if (hasOwn(PIRATE_SIZE_WRECK, factionId)) {
    const suffix = hasOwn(PIRATE_SIZE_SUFFIX, factionId) ? PIRATE_SIZE_SUFFIX[factionId] : DEFAULT_SIZE_SUFFIX;
    add(`${PIRATE_SIZE_WRECK[factionId]} ${SIZE_WORD[size]}${suffix}`);
  }
  if (factionId === ORE_FACTION_ID && ORE_FREIGHTER_GROUPS.includes(hullGroup)) add(ORE_FREIGHTER_WRECK);
  const hullClass = hasOwn(HULL_CLASS, hullGroup) ? HULL_CLASS[hullGroup] : null;
  if (hasOwn(RACE_WRECK_PREFIX, factionId) && hullClass && RACE_HULL_CLASSES.includes(hullClass)) {
    add(`${RACE_WRECK_PREFIX[factionId]} ${hullClass} Wreck`);
  }
  for (const name of GENERIC_WRECK[size]) add(name);
  return out;
}

function fallbackFactionIds() {
  const ids = new Set([ORE_FACTION_ID]);
  for (const table of [RACE_WRECK_PREFIX, PIRATE_SIZE_WRECK, PIRATE_CAPITAL_WRECK]) {
    for (const key of Object.keys(table)) ids.add(Number(key));
  }
  return [null, ...[...ids].sort((a, b) => a - b)];
}

function allLootTableIds() {
  const ids = new Set();
  for (const row of Object.values(LOOT_TABLES)) for (const id of Object.values(row)) ids.add(id);
  return [...ids].sort();
}

function allFallbackWreckNames() {
  const names = new Set();
  for (const hullGroup of Object.keys(HULL_SIZE)) {
    for (const factionId of fallbackFactionIds()) {
      for (const name of fallbackWreckNamesOf(hullGroup, factionId)) names.add(name);
    }
  }
  return [...names].sort();
}

module.exports = {
  SIZE,
  HULL_SIZE,
  LOOT_TABLES,
  DEFAULT_LOOT_ROW,
  LOOT_SOURCE_NPC,
  LOOT_SOURCE_BAND,
  FACTION_LABELS,
  WRECK_FACTION_NAMES,
  HULL_CLASS,
  RACE_WRECK_PREFIX,
  PIRATE_SIZE_WRECK,
  GENERIC_WRECK,
  FALLBACK_OWNER_CORPORATION_ID,
  sizeOf,
  lootTableOf,
  resolveLootTable,
  lootSourceNpcTypeOf,
  ownerCorporationOf,
  wreckFactionNameOf,
  siteLabelOf,
  fallbackWreckNamesOf,
  allLootTableIds,
  allFallbackWreckNames,
};
