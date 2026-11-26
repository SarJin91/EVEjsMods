"use strict";

const CARGO = require("../data/cargoVolumes");
const S = require("./schema");

const MAX_CATALOG_TYPES = 192;
const MAX_ORE_BASES = 24;
const VOLUME_UNITS_PER_M3 = CARGO.VOLUME_UNITS_PER_M3;

const MINERAL_KEYS = Object.freeze(CARGO.MINERAL_TYPE_IDS.map((t) => `type:${t}`));
const HULL_GROUPS = Object.freeze(["frigate", "destroyer", "cruiser", "battlecruiser", "battleship", "logistics",
  "ewar", "tackle"]);
const HULL_RACES = Object.freeze([1, 2, 4, 8]);
const EMPTY_HULLS = Object.freeze({});

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const keyOf = (typeId) => `type:${typeId}`;

function oreCandidates(oreTypes) {
  if (!oreTypes || typeof oreTypes !== "object" || !Array.isArray(oreTypes.BASE_TYPE_IDS)
    || !oreTypes.ORE_TYPES || typeof oreTypes.ORE_TYPES !== "object") return null;
  const names = oreTypes.FAMILY_BY_BASE && typeof oreTypes.FAMILY_BY_BASE === "object" ? oreTypes.FAMILY_BY_BASE : {};
  const ids = [...new Set(oreTypes.BASE_TYPE_IDS.filter(isId))];
  const named = ids.filter((id) => typeof names[id] === "string").sort((a, b) => a - b);
  const unnamed = ids.filter((id) => typeof names[id] !== "string").sort((a, b) => a - b);
  const all = [...named, ...unnamed];
  return { take: all.slice(0, MAX_ORE_BASES), truncated: all.slice(MAX_ORE_BASES) };
}

function commodityCandidates(data, max) {
  if (!data || typeof data !== "object" || !isPlainMap(data.MOON_MATERIAL_TIER) || !isPlainMap(data.PI_TIER)) {
    return null;
  }
  const limit = Number.isSafeInteger(max) && max > 0 ? max : 0;
  const kinds = new Map();
  for (const k of Object.keys(data.MOON_MATERIAL_TIER)) {
    const id = Number(k);
    if (isId(id)) kinds.set(id, S.ITEM_KIND_MOON);
  }
  for (const [k, tier] of Object.entries(data.PI_TIER)) {
    const id = Number(k);
    if (isId(id) && Number.isSafeInteger(tier) && tier >= 1 && !kinds.has(id)) kinds.set(id, S.ITEM_KIND_PI);
  }
  const all = [...kinds.keys()].sort((a, b) => a - b).map((typeId) => Object.freeze({ typeId, kind: kinds.get(typeId) }));
  return { take: all.slice(0, limit), truncated: all.slice(limit).map((c) => c.typeId) };
}

function commodityEntryOf(candidate, fact) {
  if (!fact || typeof fact.volume !== "number" || !Number.isFinite(fact.volume) || fact.volume <= 0) return null;
  const volumeUnits = Math.round(fact.volume * VOLUME_UNITS_PER_M3);
  if (!Number.isSafeInteger(volumeUnits) || volumeUnits < 1) return null;
  return Object.freeze({
    itemKind: candidate.kind,
    itemKey: keyOf(candidate.typeId),
    typeId: candidate.typeId,
    name: typeof fact.name === "string" ? fact.name : null,
    volumeUnits,
    portionSize: 1,
  });
}

function mineralPairsOf(minerals) {
  if (!minerals || typeof minerals !== "object") return null;
  const pairs = [];
  for (const key of MINERAL_KEYS) {
    const q = minerals[key];
    if (q === undefined) continue;
    if (!Number.isSafeInteger(q) || q < 0) return null;
    if (q > 0) pairs.push(Object.freeze([key, q]));
  }
  if (Object.keys(minerals).some((k) => !MINERAL_KEYS.includes(k))) return null;
  pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return pairs.length > 0 ? pairs : null;
}

function oreEntryOf(baseTypeId, ore, fact, family) {
  if (!ore || ore.grade !== 1) return null;
  const minerals = mineralPairsOf(ore.minerals);
  if (minerals === null || !fact) return null;
  if (!Number.isSafeInteger(fact.portionSize) || fact.portionSize < 1) return null;
  if (typeof fact.volume !== "number" || !Number.isFinite(fact.volume) || fact.volume <= 0) return null;
  const volumeUnits = Math.round(fact.volume * VOLUME_UNITS_PER_M3);
  if (!Number.isSafeInteger(volumeUnits) || volumeUnits < 1) return null;
  return Object.freeze({
    itemKind: S.ITEM_KIND_ORE,
    itemKey: keyOf(baseTypeId),
    typeId: baseTypeId,
    family: typeof family === "string" ? family : null,
    name: typeof fact.name === "string" ? fact.name : null,
    volumeUnits,
    portionSize: fact.portionSize,
    minerals: Object.freeze(minerals),
  });
}

const isPlainMap = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);

function hullEntriesOf(hullTypes, hullRecipes, usedTypeIds, enabled) {
  const groups = hullRecipes && isPlainMap(hullRecipes.GROUPS) ? hullRecipes.GROUPS : null;
  if (groups === null) return { entries: [], state: "no_recipes", fallbacks: [], truncated: [] };
  const table = hullTypes && isPlainMap(hullTypes.RACES) && isPlainMap(hullTypes.FACTION_RACE) ? hullTypes : null;
  const repOf = (g) => (isPlainMap(groups[g]) && isId(groups[g].representativeTypeId)
    ? groups[g].representativeTypeId : null);
  const used = new Set(usedTypeIds);
  const entries = [];
  const fallbacks = [];
  const truncated = [];
  for (const group of HULL_GROUPS) {
    const volumeUnits = CARGO.HULL_VOLUMES[group];
    if (!Number.isSafeInteger(volumeUnits) || volumeUnits < 1) continue;
    for (const raceId of table === null ? [null] : HULL_RACES) {
      const row = raceId === null ? null : table.RACES[String(raceId)];
      let typeId = isPlainMap(row) && isId(row[group]) ? row[group] : null;
      if (typeId === null) {
        typeId = repOf(group);
        if (typeId === null) continue;
        if (raceId !== null) fallbacks.push(`${raceId}:${group}`);
      }
      if (!used.has(typeId)) {
        if (used.size >= MAX_CATALOG_TYPES) {
          truncated.push(typeId);
          continue;
        }
        used.add(typeId);
      }
      entries.push(Object.freeze({ itemKind: S.ITEM_KIND_HULL, itemKey: `group:${group}`, typeId, group, raceId,
        volumeUnits }));
    }
  }
  const state = table === null ? "fallback" : enabled ? "on" : "off";
  return { entries, state, fallbacks, truncated };
}

function buildTradeCatalog(spec) {
  const s = spec || {};
  const oreOffersEnabled = s.oreOffersEnabled === true;
  const hullOffersEnabled = s.hullOffersEnabled === true;
  const minerals = CARGO.MINERAL_TYPE_IDS.map((typeId) => Object.freeze({
    itemKind: S.ITEM_KIND_MINERAL, itemKey: keyOf(typeId), typeId, volumeUnits: CARGO.MINERAL_VOLUME,
  }));
  const ores = [];
  const missing = [];
  let truncated = [];
  let oreState;
  let oreReason = null;
  const candidates = oreCandidates(s.oreTypes || null);
  if (candidates === null) {
    oreState = "no_ore_types";
  } else if (s.factsRead === null || s.factsRead === undefined) {
    oreState = "no_seam";
    truncated = candidates.truncated;
  } else if (s.factsRead.ok !== true || !(s.factsRead.facts instanceof Map)) {
    oreState = "facts_refused";
    oreReason = String((s.factsRead && s.factsRead.reason) || "FACTS_SHAPE").slice(0, 64);
    truncated = candidates.truncated;
  } else {
    truncated = candidates.truncated;
    const room = MAX_CATALOG_TYPES - minerals.length;
    for (const base of candidates.take) {
      const entry = ores.length < room
        ? oreEntryOf(base, s.oreTypes.ORE_TYPES[base], s.factsRead.facts.get(base) || null,
          (s.oreTypes.FAMILY_BY_BASE || {})[base])
        : null;
      if (entry) ores.push(entry);
      else missing.push(base);
    }
    missing.sort((a, b) => a - b);
    oreState = oreOffersEnabled ? "on" : "off";
  }

  const hull = hullEntriesOf(s.hullTypes || null, s.hullRecipes || null,
    [...minerals, ...ores].map((e) => e.typeId), hullOffersEnabled);
  const hulls = hull.entries;
  const tableFactionRace = hull.state === "on" || hull.state === "off" ? s.hullTypes.FACTION_RACE : null;
  const factionRace = s.hullTypes && isPlainMap(s.hullTypes.FACTION_RACE) ? s.hullTypes.FACTION_RACE : null;

  const commodityOffersEnabled = s.commodityOffersEnabled === true;
  const commodities = [];
  const commodityMissing = [];
  let commodityTruncated = [];
  let commodityState = "off";
  if (commodityOffersEnabled && s.commodities && Array.isArray(s.commodities.take)) {
    commodityTruncated = Array.isArray(s.commodities.truncated) ? [...s.commodities.truncated] : [];
    const facts = s.commodityFacts;
    if (facts === null || facts === undefined) {
      commodityState = "no_seam";
    } else if (facts.ok !== true || !(facts.facts instanceof Map)) {
      commodityState = "facts_refused";
    } else {
      commodityState = "on";
      const used = new Set([...minerals, ...ores, ...hulls].map((e) => e.typeId));
      const room = Math.max(0, MAX_CATALOG_TYPES - used.size);
      for (const c of s.commodities.take) {
        if (used.has(c.typeId)) continue;
        if (commodities.length >= room) {
          commodityTruncated.push(c.typeId);
          continue;
        }
        const entry = commodityEntryOf(c, facts.facts.get(c.typeId) || null);
        if (entry) commodities.push(entry);
        else commodityMissing.push(c.typeId);
      }
    }
  }
  const commodityKinds = Object.freeze(Object.fromEntries(commodities.map((e) => [e.itemKey, e.itemKind])));

  const entries = Object.freeze([...minerals, ...ores, ...hulls, ...commodities]);
  const byKey = new Map([...minerals, ...ores, ...commodities].map((e) => [e.itemKey, e]));
  const priced = [...minerals, ...(oreOffersEnabled ? ores : []), ...(hullOffersEnabled ? hulls : []),
    ...commodities];
  const priceTypeIds = Object.freeze([...new Set(priced.map((e) => e.typeId))]);
  const volumes = Object.freeze(Object.fromEntries(priced.map((e) => [e.itemKey, e.volumeUnits])));
  const summary = Object.freeze({
    minerals: minerals.length,
    ores: ores.length,
    oreOffersEnabled,
    oreState,
    oreReason,
    missing: Object.freeze(missing),
    truncated: Object.freeze([...truncated]),
    hulls: hulls.length,
    hullOffersEnabled,
    hullState: hull.state,
    hullFallbacks: Object.freeze(hull.fallbacks),
    hullTruncated: Object.freeze(hull.truncated),
    commodities: commodities.length,
    commodityState,
    commodityMissing: Object.freeze(commodityMissing.sort((a, b) => a - b)),
    commodityTruncated: Object.freeze(commodityTruncated),
  });

  const hullCache = new Map();
  function hullsFor(factionId) {
    if (!hullOffersEnabled || !isId(factionId) || hulls.length === 0) return EMPTY_HULLS;
    if (hullCache.has(factionId)) return hullCache.get(factionId);
    if (factionRace === null || !isId(factionRace[String(factionId)])) return EMPTY_HULLS;
    const raceId = tableFactionRace !== null ? tableFactionRace[String(factionId)] : null;
    const out = {};
    for (const e of hulls) if (e.raceId === raceId) out[e.group] = e;
    const frozen = Object.freeze(out);
    hullCache.set(factionId, frozen);
    return frozen;
  }

  return Object.freeze({
    entries,
    get: (itemKey) => (typeof itemKey === "string" && byKey.has(itemKey) ? byKey.get(itemKey) : null),
    oreOffersEnabled,
    hullOffersEnabled,
    priceTypeIds,
    volumes,
    offerable(itemKind, itemKey, typeId) {
      if (itemKind === S.ITEM_KIND_MINERAL) return true;
      if (itemKind === S.ITEM_KIND_MOON || itemKind === S.ITEM_KIND_PI) {
        const c = commodityOffersEnabled && typeof itemKey === "string" ? byKey.get(itemKey) : undefined;
        return Boolean(c && c.itemKind === itemKind && c.typeId === typeId);
      }
      if (itemKind === S.ITEM_KIND_HULL) {
        return hullOffersEnabled && typeof itemKey === "string"
          && hulls.some((e) => e.itemKey === itemKey && e.typeId === typeId);
      }
      if (itemKind !== S.ITEM_KIND_ORE || !oreOffersEnabled) return false;
      const e = typeof itemKey === "string" ? byKey.get(itemKey) : undefined;
      return Boolean(e && e.itemKind === S.ITEM_KIND_ORE && e.typeId === typeId);
    },
    hullsFor,
    hullsAvailable: hullOffersEnabled && hulls.length > 0 && factionRace !== null,
    commodityOffersEnabled,
    commodityKinds,
    summary,
  });
}

const MINERALS_ONLY = buildTradeCatalog({});

module.exports = { buildTradeCatalog, oreCandidates, commodityCandidates, MINERALS_ONLY, MAX_CATALOG_TYPES, MAX_ORE_BASES, HULL_GROUPS,
  HULL_RACES };
