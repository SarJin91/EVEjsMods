"use strict";

const CAPSULEERS_VERSION = 2;
const CAPSULEER_FACTION_ID = 500018;
const MAX_SLOTS = 64;
const MAX_MEMBERS = 10;
const MAX_CLAIMS_PER_CORP = 8;
const NAME_SEED = 46801;
const NAME_PREFIXES = Object.freeze(["Crimson", "Iron", "Silent", "Void", "Black", "Azure", "Stellar", "Hollow",
  "Rogue", "Obsidian", "Frozen", "Scarlet", "Golden", "Shadow", "Vanguard", "Nova", "Ember", "Onyx"]);
const NAME_SUFFIXES = Object.freeze(["Syndicate", "Collective", "Industries", "Brotherhood", "Ventures", "Consortium",
  "Armada", "Reavers", "Wardens", "Outfitters"]);
const CORP_DESCRIPTION = "Independent capsuleer corporation";
const RACE_SOURCE_FACTION_IDS = Object.freeze([500001, 500002, 500003, 500004]);
const SECURITY_RATING = 2;
const BASE_SEC_CLASSES = Object.freeze(["lowsec", "nullsec"]);

const FLEET_TEMPLATES = Object.freeze([
  Object.freeze({ templateId: "ratter-bs", costIsk: 300000000, weight: 2,
    composition: Object.freeze([Object.freeze({ hullGroup: "battleship", typeId: null, count: 1 })]) }),
  Object.freeze({ templateId: "ratter-bc", costIsk: 90000000, weight: 2,
    composition: Object.freeze([Object.freeze({ hullGroup: "battlecruiser", typeId: null, count: 1 })]) }),
  Object.freeze({ templateId: "ratter-cruisers", costIsk: 120000000, weight: 1,
    composition: Object.freeze([Object.freeze({ hullGroup: "cruiser", typeId: null, count: 2 })]) }),
]);

const MERC_TEMPLATES = Object.freeze([
  Object.freeze({ templateId: "merc-cruisers", costIsk: 200000000, weight: 2,
    composition: Object.freeze([Object.freeze({ hullGroup: "cruiser", typeId: null, count: 3 })]) }),
  Object.freeze({ templateId: "merc-bc", costIsk: 250000000, weight: 2,
    composition: Object.freeze([Object.freeze({ hullGroup: "battlecruiser", typeId: null, count: 2 })]) }),
  Object.freeze({ templateId: "merc-bs", costIsk: 700000000, weight: 1,
    composition: Object.freeze([Object.freeze({ hullGroup: "battleship", typeId: null, count: 2 })]) }),
]);
const MERC_FEE_BY_HULL = Object.freeze({ frigate: 10000000, destroyer: 15000000, cruiser: 40000000,
  battlecruiser: 80000000, battleship: 150000000 });
const MERC_FEE_DEFAULT = 40000000;

function parseSecClassList(text) {
  if (typeof text !== "string") return null;
  const parts = text.split(",").map((p) => p.trim());
  if (parts.length === 0 || parts.some((p) => !BASE_SEC_CLASSES.includes(p))) return null;
  if (new Set(parts).size !== parts.length) return null;
  return parts;
}

module.exports = {
  CAPSULEERS_VERSION,
  CAPSULEER_FACTION_ID,
  MAX_SLOTS,
  MAX_MEMBERS,
  MAX_CLAIMS_PER_CORP,
  NAME_SEED,
  NAME_PREFIXES,
  NAME_SUFFIXES,
  CORP_DESCRIPTION,
  RACE_SOURCE_FACTION_IDS,
  SECURITY_RATING,
  BASE_SEC_CLASSES,
  FLEET_TEMPLATES,
  MERC_TEMPLATES,
  MERC_FEE_BY_HULL,
  MERC_FEE_DEFAULT,
  parseSecClassList,
};
