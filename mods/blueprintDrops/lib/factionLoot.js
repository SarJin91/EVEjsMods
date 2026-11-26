"use strict";

const BANDS = ["frigate", "destroyer", "cruiser", "battlecruiser", "battleship", "capital", "hauler"];
const TIERS = ["normal", "deadspace", "mission", "commander", "overseer", "officer"];
const SIZES = ["small", "medium", "large"];
const SIZE_OF_BAND = Object.freeze({ frigate: "small", destroyer: "small", cruiser: "medium", battlecruiser: "medium",
  hauler: "medium", battleship: "large", capital: "large" });
const RARITIES = ["epic", "rare", "uncommon"];
const VALIDATE_ORDER = ["uncommon", "rare", "epic"];
const RARITY_CATEGORIES = Object.freeze({ uncommon: ["tag", "ammo", "material"], rare: ["module", "deadspace"],
  epic: ["bpcModule", "bpcHull"] });
const CATEGORIES = ["tag", "material", "ammo", "module", "deadspace"];
const POOL_CATEGORIES = [...CATEGORIES, "bpcModule"];
const UNSIZED = ["tag", "material"];
const STACKABLE = ["tag", "ammo", "material"];
const DEADSPACE_TIERS = ["commander", "overseer", "officer"];
const SCALE_KEY = Object.freeze({ uncommon: "factionLootUncommonScale", rare: "factionLootRareScale", epic: "factionLootEpicScale" });
const HULL_SIZES = ["frigate", "cruiser", "battleship", "capital"];
const BAND_RANK = Object.freeze({ frigate: 0, destroyer: 0, cruiser: 1, battlecruiser: 1, hauler: 1, battleship: 2, capital: 3 });
const HULL_BANDS = ["battleship", "capital"];
const BPC_CATEGORIES = ["bpcModule", "bpcHull"];
const COMMON_CATEGORIES = ["ammo", "module", "salvage"];
const COMMON_SIZED = ["ammo", "module"];
const COMMON_STACKABLE = ["ammo", "salvage"];
const HOUR_MS = 3600000;

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const posInt = (v) => Number.isInteger(v) && v > 0;
const isChance = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
const isNonNeg = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0;
const isIntIn = (v, min, max = Infinity) => Number.isInteger(v) && v >= min && v <= max;
const typeIDList = (v) => Array.isArray(v) && v.every(posInt);

function sizedPool(p) {
  if (!isObj(p)) return null;
  for (const s of [...SIZES, "any"]) if (p[s] !== undefined && !typeIDList(p[s])) return null;
  const out = {};
  for (const s of SIZES) out[s] = [...new Set([...(p[s] || []), ...(p.any || [])])];
  return out;
}

function loadData(json) {
  const bad = (detail) => ({ ok: false, reason: "BAD_DATA", detail });
  try {
    if (!isObj(json) || json.schemaVersion !== 1) return bad("schemaVersion must be 1");
    if (!isObj(json.factions) || !Array.isArray(json.npcGroups) || !Array.isArray(json.shipGroups)) {
      return bad("factions/npcGroups/shipGroups missing");
    }
    let common = null;
    if (json.common !== undefined) {
      if (!isObj(json.common)) return bad("common");
      common = {};
      for (const cat of COMMON_SIZED) {
        if (json.common[cat] === undefined) continue;
        common[cat] = sizedPool(json.common[cat]);
        if (!common[cat]) return bad(`common pool ${cat}`);
      }
      if (json.common.salvage !== undefined) {
        if (!typeIDList(json.common.salvage)) return bad("common pool salvage");
        common.salvage = [...new Set(json.common.salvage)];
      }
    }
    const factions = new Map();
    for (const [key, row] of Object.entries(json.factions)) {
      const factionID = Number(key);
      if (!posInt(factionID) || !isObj(row) || !isObj(row.pools)) return bad(`faction ${key}`);
      const pools = {};
      for (const cat of POOL_CATEGORIES) {
        const p = row.pools[cat];
        if (p === undefined) continue;
        if (UNSIZED.includes(cat)) {
          if (!typeIDList(p)) return bad(`faction ${key} pool ${cat}`);
          pools[cat] = [...new Set(p)];
          continue;
        }
        pools[cat] = sizedPool(p);
        if (!pools[cat]) return bad(`faction ${key} pool ${cat}`);
      }
      const hull = row.pools.bpcHull;
      if (hull !== undefined) {
        if (!isObj(hull) || !Object.entries(hull).every(([s, ids]) => HULL_SIZES.includes(s) && typeIDList(ids))) {
          return bad(`faction ${key} pool bpcHull`);
        }
        pools.bpcHull = Object.fromEntries(HULL_SIZES.map((s) => [s, [...new Set(hull[s] || [])]]));
      }
      factions.set(factionID, { factionID, key: String(row.key || key), label: String(row.label || row.key || key), pools });
    }
    const npcGroups = new Map();
    for (const row of json.npcGroups) {
      if (!isObj(row) || !posInt(row.groupID)) return bad("npc group without groupID");
      if (npcGroups.has(row.groupID)) return bad(`duplicate npc group ${row.groupID}`);
      if (row.factionID !== null && !posInt(row.factionID)) return bad(`npc group ${row.groupID}: factionID`);
      if ((row.band !== null && !BANDS.includes(row.band)) || !TIERS.includes(row.tier)) return bad(`npc group ${row.groupID}: band/tier`);
      npcGroups.set(row.groupID, { groupID: row.groupID, factionID: row.factionID, band: row.band, tier: row.tier });
    }
    const shipGroups = new Map();
    for (const row of json.shipGroups) {
      if (!isObj(row) || !posInt(row.groupID) || !BANDS.includes(row.band)) return bad("ship group");
      if (shipGroups.has(row.groupID) || npcGroups.has(row.groupID)) return bad(`duplicate ship group ${row.groupID}`);
      shipGroups.set(row.groupID, row.band);
    }
    const aliases = new Map();
    for (const [name, id] of Object.entries(isObj(json.factionAliases) ? json.factionAliases : {})) {
      if (!posInt(id)) return bad(`alias ${name}`);
      aliases.set(name.toLowerCase(), id);
    }
    const bpcMaxRuns = new Map();
    for (const [id, runs] of Object.entries(isObj(json.bpcMaxRuns) ? json.bpcMaxRuns : {})) {
      if (!posInt(Number(id)) || !posInt(runs)) return bad(`bpcMaxRuns ${id}`);
      bpcMaxRuns.set(Number(id), runs);
    }
    const npcTypeBands = new Map();
    for (const [id, band] of Object.entries(isObj(json.npcTypeBands) ? json.npcTypeBands : {})) {
      if (!posInt(Number(id)) || !BANDS.includes(band)) return bad(`npcTypeBands ${id}`);
      npcTypeBands.set(Number(id), band);
    }
    return { ok: true, data: { factions, common, npcGroups, npcTypeBands, shipGroups, aliases, bpcMaxRuns } };
  } catch (error) {
    return bad(String(error && error.message || error));
  }
}

function checkTypes(data, hasType) {
  const missing = new Set();
  let types = 0;
  const factions = new Map();
  const keep = (ids) => ids.filter((id) => (hasType(id) ? true : (missing.add(id), false)));
  const keepPools = (src) => {
    const pools = {};
    for (const [cat, p] of Object.entries(src)) {
      if (Array.isArray(p)) pools[cat] = keep(p);
      else pools[cat] = Object.fromEntries(Object.entries(p).map(([s, ids]) => [s, keep(ids)]));
    }
    return pools;
  };
  const countTypes = (pools) => {
    const seen = new Set();
    for (const p of Object.values(pools)) for (const ids of Array.isArray(p) ? [p] : Object.values(p)) for (const x of ids) seen.add(x);
    return seen.size;
  };
  for (const [id, f] of data.factions) factions.set(id, { ...f, pools: keepPools(f.pools) });
  for (const f of factions.values()) types += countTypes(f.pools);
  const common = data.common ? keepPools(data.common) : null;
  if (common) types += countTypes(common);
  return { data: { ...data, factions, common }, types, missing: [...missing].sort((a, b) => a - b) };
}

function resolveFactionLootFlag(settings, env) {
  const raw = String(env && env.EVEJS_BPDROPS_FACTION_LOOT_ENABLED || "").trim().toLowerCase();
  if (raw === "1" || raw === "true") return true;
  if (raw === "0" || raw === "false") return false;
  return !!(settings && settings.factionLootEnabled === true);
}

function validateSettings(s) {
  const bad = (detail) => ({ ok: false, reason: "BAD_CONFIG", detail });
  if (!isObj(s)) return bad("settings missing");
  if (typeof s.factionLootEnabled !== "boolean") return bad("factionLootEnabled");
  for (const key of ["factionLootUncommonScale", "factionLootRareScale", "factionLootEpicScale"]) if (!isNonNeg(s[key])) return bad(key);
  if (!isIntIn(s.factionLootMaxEntriesPerWreck, 0, 6)) return bad("factionLootMaxEntriesPerWreck");
  if (!isIntIn(s.factionLootRareCapPerHour, 0)) return bad("factionLootRareCapPerHour");
  if (!isIntIn(s.factionLootEpicCapPerHour, 0)) return bad("factionLootEpicCapPerHour");
  if (typeof s.factionLootLog !== "boolean") return bad("factionLootLog");
  if (!isIntIn(s.factionLootSummaryEvery, 0)) return bad("factionLootSummaryEvery");
  if (typeof s.factionLootSeedSalt !== "string") return bad("factionLootSeedSalt");
  if (!isObj(s.factionLootTierChance)) return bad("factionLootTierChance");
  for (const tier of TIERS) {
    const row = s.factionLootTierChance[tier];
    if (!isObj(row)) return bad(`factionLootTierChance.${tier}`);
    for (const r of VALIDATE_ORDER) if (!isChance(row[r])) return bad(`factionLootTierChance.${tier}.${r}`);
  }
  if (!isObj(s.factionLootBandScale)) return bad("factionLootBandScale");
  for (const band of BANDS) if (!isNonNeg(s.factionLootBandScale[band])) return bad(`factionLootBandScale.${band}`);
  if (!isObj(s.factionLootCategoryWeights)) return bad("factionLootCategoryWeights");
  if (!isObj(s.factionLootBpcRuns)) return bad("factionLootBpcRuns");
  for (const cat of BPC_CATEGORIES) {
    const q = s.factionLootBpcRuns[cat];
    if (!Array.isArray(q) || q.length !== 2 || !isIntIn(q[0], 1) || !isIntIn(q[1], q[0])) return bad(`factionLootBpcRuns.${cat}`);
  }
  for (const r of VALIDATE_ORDER) {
    const row = s.factionLootCategoryWeights[r];
    if (!isObj(row)) return bad(`factionLootCategoryWeights.${r}`);
    for (const cat of RARITY_CATEGORIES[r]) if (!isNonNeg(row[cat])) return bad(`factionLootCategoryWeights.${r}.${cat}`);
  }
  if (typeof s.factionLootFillerEnabled !== "boolean") return bad("factionLootFillerEnabled");
  if (typeof s.factionLootFillerTierQuantity !== "boolean") return bad("factionLootFillerTierQuantity");
  if (!isIntIn(s.factionLootFillerMaxEntries, 0, 6)) return bad("factionLootFillerMaxEntries");
  const fe = s.factionLootFillerEntries;
  if (!Array.isArray(fe) || fe.length !== 2 || !isIntIn(fe[0], 0, 6) || !isIntIn(fe[1], fe[0], 6)) return bad("factionLootFillerEntries");
  const ex = s.factionLootFillerExcludeTables;
  if (!Array.isArray(ex) || !ex.every((x) => typeof x === "string")) return bad("factionLootFillerExcludeTables");
  const cw = s.factionLootCategoryWeights.common;
  if (!isObj(cw)) return bad("factionLootCategoryWeights.common");
  for (const cat of COMMON_CATEGORIES) if (!isNonNeg(cw[cat])) return bad(`factionLootCategoryWeights.common.${cat}`);
  if (!isObj(s.factionLootQuantity)) return bad("factionLootQuantity");
  for (const cat of [...CATEGORIES, "salvage"]) {
    const q = s.factionLootQuantity[cat];
    if (!Array.isArray(q) || q.length !== 2 || !isIntIn(q[0], 1) || !isIntIn(q[1], q[0])) return bad(`factionLootQuantity.${cat}`);
  }
  if (!isObj(s.factionLootTierQuantityMultiplier)) return bad("factionLootTierQuantityMultiplier");
  for (const tier of TIERS) if (!isIntIn(s.factionLootTierQuantityMultiplier[tier], 1)) return bad(`factionLootTierQuantityMultiplier.${tier}`);
  if (!typeIDList(s.factionLootSkipFactionIDs)) return bad("factionLootSkipFactionIDs");
  const st = s.factionLootSkipTables;
  if (!Array.isArray(st) || !st.every((x) => typeof x === "string")) return bad("factionLootSkipTables");
  return { ok: true };
}

function resolveSource(source, deps) {
  if (!source || !deps || !deps.data) return null;
  const { data } = deps;
  let factionID = null;
  let via = null;
  if (source.profileID && typeof deps.getProfile === "function") {
    const profile = deps.getProfile(source.profileID);
    const pf = Number(profile && profile.factionID) || 0;
    if (pf > 0 && data.factions.has(pf)) { factionID = pf; via = "profile"; }
  }
  const type = typeof deps.getType === "function" ? deps.getType(Number(source.npcTypeID)) : null;
  const groupID = Number(type && type.groupID);
  const npcGroup = data.npcGroups.get(groupID);
  let band = null;
  let tier = "normal";
  if (npcGroup) {
    const typeBand = data.npcTypeBands && data.npcTypeBands.get(Number(source.npcTypeID));
    band = typeBand || npcGroup.band;
    tier = npcGroup.tier;
    if (factionID === null && npcGroup.factionID) { factionID = npcGroup.factionID; via = "group"; }
  } else if (data.shipGroups.has(groupID)) {
    band = data.shipGroups.get(groupID);
    if (factionID === null) via = "shipGroup";
  }
  if (factionID === null && typeof source.factionName === "string") {
    const alias = data.aliases.get(source.factionName.trim().toLowerCase());
    if (alias) { factionID = alias; via = "alias"; }
  }
  if (!npcGroup && !data.shipGroups.has(groupID) && factionID === null) return null;
  return { factionID, band, tier, size: band ? SIZE_OF_BAND[band] : null, via: via || (npcGroup ? "group" : "shipGroup") };
}

function createSeededRng(seedString) {
  const str = String(seedString);
  let h = 1779033703 ^ str.length;
  for (let i = 0; i < str.length; i += 1) {
    h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
    h = (h << 13) | (h >>> 19);
  }
  h = Math.imul(h ^ (h >>> 16), 2246822507);
  h = Math.imul(h ^ (h >>> 13), 3266489909);
  let a = (h ^= h >>> 16) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function createRateCaps(caps) {
  const buckets = new Map();
  for (const [rarity, cap] of Object.entries(caps || {})) {
    if (Number.isFinite(cap) && cap > 0) buckets.set(rarity, { cap, tokens: cap, lastMs: null });
  }
  return {
    take(rarity, nowMs) {
      const b = buckets.get(rarity);
      if (!b) return false;
      const now = Number(nowMs) || 0;
      if (b.lastMs !== null && now > b.lastMs) b.tokens = Math.min(b.cap, b.tokens + ((now - b.lastMs) * b.cap) / HOUR_MS);
      if (b.lastMs === null || now > b.lastMs) b.lastMs = now;
      if (b.tokens < 1) return false;
      b.tokens -= 1;
      return true;
    },
  };
}

const randInt = (min, max, rng) => min + Math.min(max - min, Math.floor(rng() * (max - min + 1)));

function poolOf(pools, cat, size) {
  const p = pools[cat];
  if (!p) return [];
  return Array.isArray(p) ? p : (p[size] || []);
}

function pickWeighted(cats, weights, poolFn, used, rng) {
  const options = [];
  for (const cat of cats) {
    const w = weights && weights[cat];
    if (!(w > 0)) continue;
    const free = poolFn(cat).filter((id) => !used.has(id));
    if (free.length) options.push({ cat, w, free });
  }
  if (!options.length) return null;
  const total = options.reduce((sum, o) => sum + o.w, 0);
  let r = rng() * total;
  let pick = options[options.length - 1];
  for (const o of options) { if ((r -= o.w) < 0) { pick = o; break; } }
  return { cat: pick.cat, typeID: pick.free[Math.min(pick.free.length - 1, Math.floor(rng() * pick.free.length))] };
}

function fillerApplies(call, settings, data) {
  if (settings.factionLootFillerEnabled !== true || !data || !data.common) return false;
  const table = call && call.lootTable;
  if (!isObj(table) || !(table.emptyRule === true || table.disableRandomLoot === true)) return false;
  if (call.vendorEntryCount !== 0) return false;
  return !settings.factionLootFillerExcludeTables.includes(String(table.lootTableID));
}

function rollFactionLoot(call, deps) {
  try {
    return rollInner(call, deps || {});
  } catch (error) {
    return { ok: false, reason: "ROLL_FAILED", detail: String(error && error.message || error), entries: [], drops: [], capped: [], skipped: [] };
  }
}

function hullPool(pools, resolved) {
  const p = pools.bpcHull;
  if (!p) return [];
  const all = DEADSPACE_TIERS.includes(resolved.tier);
  if (!all && !HULL_BANDS.includes(resolved.band)) return [];
  const rank = BAND_RANK[resolved.band];
  return HULL_SIZES.filter((s, i) => all || i <= rank).flatMap((s) => p[s] || []);
}

function bpcRuns(cat, typeID, settings, data, rng) {
  const [min, max] = settings.factionLootBpcRuns[cat];
  const ceiling = (data.bpcMaxRuns && data.bpcMaxRuns.get(typeID)) || 1;
  const hi = Math.max(1, Math.min(max, ceiling));
  return randInt(Math.min(min, hi), hi, rng);
}

function rollInner(call, deps) {
  const skipped = [];
  const result = (reason, entries = [], drops = [], capped = []) => ({ ok: true, reason, entries, drops, capped, skipped });
  const { settings, data, resolved, rng } = deps;
  const options = call && call.options;
  if (!settings || settings.factionLootEnabled !== true) return result("OFF");
  if (options && options.extraRoll === true) return result("EXTRA_ROLL");
  const source = (options && options.source) || {};
  if (!(Number(source.npcTypeID) > 0)) return result("NO_SOURCE");
  const tableID = isObj(call.lootTable) ? String(call.lootTable.lootTableID) : null;
  const skipTables = Array.isArray(settings.factionLootSkipTables) ? settings.factionLootSkipTables : [];
  if (tableID !== null && skipTables.includes(tableID)) return result("SKIPPED_TABLE");
  if (!resolved || !resolved.band) return result("UNRESOLVED");
  if (settings.factionLootSkipFactionIDs.includes(resolved.factionID)) return result("SKIPPED_FACTION");
  const size = resolved.size || SIZE_OF_BAND[resolved.band];
  const used = new Set((call.vendorEntries || []).map((e) => Number(e && e.typeID)));
  const entries = [];
  const drops = [];
  const capped = [];
  const getItemType = (id) => (typeof deps.getItemType === "function" ? deps.getItemType(id) : null);
  const quantityOf = (cat, stackable, common = false) => {
    if (!stackable.includes(cat)) return 1;
    const [min, max2] = settings.factionLootQuantity[cat];
    const multiplier = common && settings.factionLootFillerTierQuantity !== true ? 1
      : settings.factionLootTierQuantityMultiplier[resolved.tier];
    return randInt(min, max2, rng) * multiplier;
  };
  const push = (rarity, pick, itemType, quantity) => {
    used.add(pick.typeID);
    entries.push({ itemType, typeID: pick.typeID, name: itemType.name, quantity, singleton: false });
    drops.push({ rarity, category: pick.cat, typeID: pick.typeID, quantity });
  };
  const pushCopy = (pick, itemType, blueprintState) => {
    used.add(pick.typeID);
    entries.push({ itemType, typeID: pick.typeID, name: itemType.name, quantity: 1, singleton: 2, blueprintState });
    drops.push({ rarity: "epic", category: pick.cat, typeID: pick.typeID, quantity: 1, runs: blueprintState.runsRemaining });
  };
  if (fillerApplies(call, settings, data)) {
    const [minN, maxN] = settings.factionLootFillerEntries;
    const n = Math.min(settings.factionLootFillerMaxEntries, randInt(minN, maxN, rng));
    for (let i = 0; i < n; i += 1) {
      const pick = pickWeighted(COMMON_CATEGORIES, settings.factionLootCategoryWeights.common, (cat) => poolOf(data.common, cat, size), used, rng);
      if (!pick) break;
      const itemType = getItemType(pick.typeID);
      if (!itemType) continue;
      push("common", pick, itemType, quantityOf(pick.cat, COMMON_STACKABLE, true));
    }
  }
  const faction = resolved.factionID !== null && data.factions.get(resolved.factionID);
  if (!faction || !Object.keys(faction.pools).length) {
    return entries.length ? result("ROLLED", entries, drops, capped) : result("NO_POOLS");
  }
  const max = settings.factionLootMaxEntriesPerWreck;
  let rolled = 0;
  for (const rarity of RARITIES) {
    if (rolled >= max) break;
    if (rarity === "epic" && typeof deps.buildCopyState !== "function") continue;
    const tierRow = settings.factionLootTierChance[resolved.tier] || {};
    const chance = Math.min(1, tierRow[rarity] * settings.factionLootBandScale[resolved.band] * settings[SCALE_KEY[rarity]]);
    if (!(chance > 0) || rng() >= chance) continue;
    const cats = RARITY_CATEGORIES[rarity].filter((cat) => cat !== "deadspace" || DEADSPACE_TIERS.includes(resolved.tier));
    const poolFn = (cat) => (cat === "bpcHull" ? hullPool(faction.pools, resolved) : poolOf(faction.pools, cat, size));
    const pick = pickWeighted(cats, settings.factionLootCategoryWeights[rarity], poolFn, used, rng);
    if (!pick) continue;
    const itemType = getItemType(pick.typeID);
    if (!itemType) continue;
    let blueprintState = null;
    if (rarity === "epic") {
      const runs = bpcRuns(pick.cat, pick.typeID, settings, data, rng);
      try {
        blueprintState = deps.buildCopyState({ runsRemaining: runs, materialEfficiency: 0, timeEfficiency: 0 });
      } catch (_error) {
        blueprintState = null;
      }
      if (!isObj(blueprintState)) { skipped.push("BPC_STATE"); continue; }
    }
    if (rarity !== "uncommon" && !deps.caps.take(rarity, deps.nowMs)) { capped.push(rarity); continue; }
    if (blueprintState) pushCopy(pick, itemType, blueprintState);
    else push(rarity, pick, itemType, quantityOf(pick.cat, STACKABLE));
    rolled += 1;
  }
  return result("ROLLED", entries, drops, capped);
}

function startupReport(settings, dataResult) {
  try {
    if (!settings || settings.factionLootEnabled !== true) return { line: "faction loot: off (factionLootEnabled: false)", forceOff: false };
    if (!dataResult || !dataResult.ok) {
      return { line: `faction loot: off (BAD_DATA: ${String(dataResult && dataResult.detail || "data missing")})`, forceOff: true };
    }
    const valid = validateSettings(settings);
    if (!valid.ok) return { line: `faction loot: off (BAD_CONFIG: ${valid.detail})`, forceOff: true };
    const d = dataResult.data;
    const count = (p) => (p ? Object.values(p).reduce((n, ids) => n + ids.length, 0) : 0);
    const bpc = [...d.factions.values()].map((f) => `${f.key} ${count(f.pools.bpcModule)}/${count(f.pools.bpcHull)}`).join(", ");
    return { line: `faction loot: on (${d.factions.size} factions, npcGroups=${d.npcGroups.size}, shipGroups=${d.shipGroups.size}, `
      + `rareCap=${settings.factionLootRareCapPerHour}/h, epicCap=${settings.factionLootEpicCapPerHour}/h, `
      + `maxEntries=${settings.factionLootMaxEntriesPerWreck}, `
      + `filler=${settings.factionLootFillerEnabled && d.common ? "on" : "off"}, bpc module/hull: ${bpc}, types checked at the first wreck)`,
    forceOff: false };
  } catch (error) {
    return { line: `faction loot: off (INIT_FAILED: ${String(error && error.message || error)})`, forceOff: true };
  }
}

module.exports = {
  BANDS, TIERS, RARITIES, RARITY_CATEGORIES, SIZE_OF_BAND,
  loadData, checkTypes, validateSettings, resolveFactionLootFlag, resolveSource, rollFactionLoot, createSeededRng, createRateCaps, startupReport,
};
