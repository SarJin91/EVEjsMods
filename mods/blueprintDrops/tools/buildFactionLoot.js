"use strict";

const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");

const SDE_BUILD = "3396210";
const DEFAULT_SDE = path.resolve(__dirname, "../../..", "_local", "sde", `eve-online-static-data-${SDE_BUILD}-jsonl`);
const OUT = path.resolve(__dirname, "..", "data", "factionLoot.json");
const CAT = Object.freeze({ SHIP: 6, MODULE: 7, CHARGE: 8, BLUEPRINT: 9, NPC: 11 });
const META = Object.freeze({ FACTION: 4, DEADSPACE: 6 });
const CHARGE_SIZE_ATTRIBUTE = "chargeSize";
const CHARGE_SIZES = Object.freeze({ 1: "small", 2: "medium", 3: "large" });
const CRIMINAL_TAGS_GROUP = 370;
const EMPIRE_INSIGNIA_GROUP = 409;
const ROGUE_DRONE_COMPONENTS_GROUP = 886;

const FACTIONS = Object.freeze({
  500010: { key: "guristas", items: ["Dread Guristas ", "Guristas "], deadspace: ["Pith"], tagGroup: CRIMINAL_TAGS_GROUP, tags: ["Guristas ", "Dread Guristas "] },
  500011: { key: "angel", items: ["Domination ", "Angel "], ammo: ["Arch Angel "], deadspace: ["Gist"], tagGroup: CRIMINAL_TAGS_GROUP, tags: ["Angel ", "Domination "] },
  500012: { key: "blood_raider", items: ["Dark Blood ", "Blood "], deadspace: ["Corp"], tagGroup: CRIMINAL_TAGS_GROUP, tags: ["Blood ", "Dark Blood "] },
  500019: { key: "sansha", items: ["True Sansha ", "Sansha "], ammo: ["True Sanshas ", "Sanshas "], deadspace: ["Cent"], tagGroup: CRIMINAL_TAGS_GROUP, tags: ["Sansha ", "True Sansha "] },
  500020: { key: "serpentis", items: ["Shadow Serpentis ", "Serpentis "], ammo: ["Shadow "], deadspace: ["Core"], tagGroup: CRIMINAL_TAGS_GROUP, tags: ["Serpentis ", "Shadow Serpentis "] },
  500025: { key: "rogue_drones", materialGroups: [ROGUE_DRONE_COMPONENTS_GROUP] },
  500001: { key: "caldari", items: ["Caldari Navy "], tagGroup: EMPIRE_INSIGNIA_GROUP, tags: ["Caldari Navy "] },
  500002: { key: "minmatar", items: ["Republic Fleet "], tagGroup: EMPIRE_INSIGNIA_GROUP, tags: ["Republic Fleet "] },
  500003: { key: "amarr", items: ["Imperial Navy "], tagGroup: EMPIRE_INSIGNIA_GROUP, tags: ["Imperial Navy "] },
  500004: { key: "gallente", items: ["Federation Navy "], tagGroup: EMPIRE_INSIGNIA_GROUP, tags: ["Federation Navy "] },
  500007: { key: "ammatar", items: ["Ammatar Navy "], tagGroup: EMPIRE_INSIGNIA_GROUP, tags: ["Ammatar "] },
  500008: { key: "khanid", items: ["Khanid Navy "], tagGroup: EMPIRE_INSIGNIA_GROUP, tags: ["Khanid "] },
  500015: { key: "thukker", items: ["Thukker "] },
  500016: { key: "sisters", items: ["Sisters "] },
  500018: { key: "mordu", items: ["Mordu "] },
  500021: { key: "sleepers" },
  500024: { key: "drifters", materialTypes: [34575], materialExcludes: /\b(sequence|index)\b|^element (control data|containment vessel)$/i },
  500026: { key: "triglavian", materialTypes: [48121, 48112] },
  500027: { key: "edencom", items: ["EDENCOM "] },
});
const MATERIAL_NAME_EXCLUDES = /mutaplasmid/i;
const MATERIAL_SKIP_CATEGORIES = [CAT.SHIP, CAT.MODULE, CAT.CHARGE, CAT.BLUEPRINT, CAT.NPC];
const TYPE_BAND_FACTIONS = Object.freeze([500007, 500008, 500015, 500016, 500018, 500021, 500024, 500026, 500027]);
const MASS_BANDS = [[2e6, "frigate"], [2e7, "cruiser"], [2e8, "battleship"]];
const SMALL_CRAFT_TYPE_TOKEN = /\b(interceptors?|drones?)\b/i;
const SMALL_CRAFT_GROUP_TOKEN = /\bscouts?\b/i;

const FACTION_RULES = [
  [/\b(angel|domination)\b/i, 500011],
  [/\bblood raiders?\b/i, 500012],
  [/\bguristas\b/i, 500010],
  [/\bsansha('?s)?\b/i, 500019],
  [/\bserpentis\b/i, 500020],
  [/\bmordu/i, 500018],
  [/\brogue drones?\b/i, 500025],
  [/\bconcord\b/i, 500006],
  [/\bkhanid\b/i, 500008],
  [/\bthukker\b/i, 500015],
  [/\bammatar\b/i, 500007],
  [/\bsisters\b/i, 500016],
  [/\bsleepers?\b/i, 500021],
  [/\bdrifters?\b/i, 500024],
  [/\bseeker\b/i, 500024],
  [/\btriglavian\b/i, 500026],
  [/\bedencom\b/i, 500027],
  [/\bamarr\b/i, 500003],
  [/\bcaldari\b/i, 500001],
  [/\bgallente\b/i, 500004],
  [/\bminmatar\b/i, 500002],
];
const BAND_RULES = [
  [/battle ?cruiser/i, "battlecruiser"],
  [/battleship/i, "battleship"],
  [/destroyer/i, "destroyer"],
  [/frigate/i, "frigate"],
  [/cruiser/i, "cruiser"],
  [/dreadnought|titan|carrier|capital|force auxiliary/i, "capital"],
  [/hauler|industrial|transport|freighter|mining barge/i, "hauler"],
];
const NO_BAND = /\b(other|sentry|sentries|sentinel|structures?|tower|bunker|swarm|drones?|capsules?|billboard|cloud|containers?|stargate|station)\b/i;
const BAND_OVERRIDES = Object.freeze({ 553: "battleship", 559: "battleship", 564: "battleship", 569: "battleship", 574: "battleship",
  1174: "battleship" });

const SHIP_GROUP_BANDS = Object.freeze({
  Frigate: "frigate", Corvette: "frigate", "Assault Frigate": "frigate", "Covert Ops": "frigate", Interceptor: "frigate",
  "Stealth Bomber": "frigate", "Electronic Attack Ship": "frigate", "Expedition Frigate": "frigate",
  "Logistics Frigate": "frigate", "Prototype Exploration Ship": "frigate",
  Destroyer: "destroyer", Interdictor: "destroyer", "Tactical Destroyer": "destroyer", "Command Destroyer": "destroyer",
  Cruiser: "cruiser", "Heavy Assault Cruiser": "cruiser", Logistics: "cruiser", "Force Recon Ship": "cruiser",
  "Combat Recon Ship": "cruiser", "Heavy Interdiction Cruiser": "cruiser", "Strategic Cruiser": "cruiser",
  "Flag Cruiser": "cruiser",
  "Combat Battlecruiser": "battlecruiser", "Attack Battlecruiser": "battlecruiser", "Command Ship": "battlecruiser",
  Battleship: "battleship", "Elite Battleship": "battleship", "Black Ops": "battleship", Marauder: "battleship",
  Titan: "capital", Dreadnought: "capital", "Lancer Dreadnought": "capital", Carrier: "capital", Supercarrier: "capital",
  "Force Auxiliary": "capital", "Capital Industrial Ship": "capital", "Command Carrier": "capital",
  Hauler: "hauler", "Deep Space Transport": "hauler", "Blockade Runner": "hauler", Freighter: "hauler",
  "Jump Freighter": "hauler", "Mining Barge": "hauler", Exhumer: "hauler", "Industrial Command Ship": "hauler",
  "Expedition Command Ship": "hauler",
});
const SHIP_GROUP_NO_BAND = Object.freeze(["Capsule", "Shuttle", "Citizen Ships", "Special Edition Yachts"]);

const NAME_EXCLUDES = ["Capital", "XL", "X-Large", "10000MN", "50000MN", "Dual 1000mm",
  "Quad 3500mm", "Triple 2500mm", "25000mm", "Siege", "Heavy Warp "];
const GROUP_EXCLUDES = ["Warp Disrupt Field Generator"];
const TURRET_GROUPS = ["Energy Weapon", "Hybrid Weapon", "Projectile Weapon", "Precursor Weapon", "Vorton Projector"];
const MISSILE_GROUP = /missile|rocket|torpedo/i;
const MISSILE_SIZES = [
  [/\bxl\b|capital|rapid torpedo/i, null],
  [/rapid light/i, "medium"],
  [/rapid heavy/i, "large"],
  [/heavy assault/i, "medium"],
  [/light|rocket/i, "small"],
  [/heavy/i, "medium"],
  [/cruise|torpedo/i, "large"],
];
const NAME_SIZES = [
  [/\b(small|micro|1MN|5MN|100mm|200mm)\b/i, "small"],
  [/\b(medium|10MN|50MN|400mm)\b/i, "medium"],
  [/\b(large|100MN|500MN|800mm|1600mm|heavy|bastion)\b/i, "large"],
];
const SIZE_KEYS = ["small", "medium", "large", "any"];
const HULL_OF_BAND = Object.freeze({ frigate: "frigate", destroyer: "frigate", cruiser: "cruiser", battlecruiser: "cruiser",
  battleship: "battleship", capital: "capital" });
const HULL_KEYS = ["frigate", "cruiser", "battleship", "capital"];

const META_T1 = 1;
const COMMON_AMMO_GROUPS = ["projectile ammo", "hybrid charge", "frequency crystal", "light missile", "heavy missile",
  "cruise missile", "rocket", "torpedo", "heavy assault missile"];
const COMMON_MODULE_GROUPS = ["energy weapon", "hybrid weapon", "projectile weapon", "missile launcher light",
  "missile launcher rapid light", "missile launcher heavy", "missile launcher heavy assault", "missile launcher cruise",
  "missile launcher rocket", "missile launcher torpedo", "armor repair unit", "armor plate", "armor hardener",
  "armor coating", "energized armor membrane", "shield booster", "shield extender", "shield hardener",
  "shield resistance amplifier", "capacitor recharger", "capacitor battery", "capacitor booster",
  "capacitor power relay", "capacitor flux coil", "shield power relay", "shield flux coil", "propulsion module"];
const COMMON_SALVAGE_GROUPS = ["salvaged materials"];
const COMMON_SALVAGE_NAMES = /^metal scraps$/i;
const COMMON_NAME_EXCLUDES = /skill|skin|blueprint|plex|extractor|injector|biomass/i;

function commonCategoryOf(row, group) {
  if (row.metaGroupID !== undefined && row.metaGroupID !== null && row.metaGroupID !== META_T1) return null;
  const name = en(row);
  if (COMMON_NAME_EXCLUDES.test(name)) return null;
  const g = String(group.name || "").toLowerCase();
  if (group.categoryID === CAT.CHARGE && COMMON_AMMO_GROUPS.includes(g)) return "ammo";
  if (group.categoryID === CAT.MODULE && COMMON_MODULE_GROUPS.includes(g)) return "module";
  if (COMMON_SALVAGE_GROUPS.includes(g) || COMMON_SALVAGE_NAMES.test(name)) return "salvage";
  return null;
}

const en = (row) => (row && row.name && typeof row.name === "object" ? row.name.en : row && row.name) || "";

function classifyNpcGroup(name, groupID) {
  const faction = FACTION_RULES.find(([re]) => re.test(name));
  const tier = /\bofficer\b/i.test(name) ? "officer"
    : /\boverseer\b/i.test(name) ? "overseer"
      : /\bcommander\b/i.test(name) ? "commander"
        : /^deadspace /i.test(name) ? "deadspace"
          : /^(mission|storyline) /i.test(name) ? "mission" : "normal";
  let band = BAND_OVERRIDES[groupID] || null;
  if (!band && !NO_BAND.test(name.replace(/\brogue drones?\b/ig, ""))) {
    const hit = BAND_RULES.find(([re]) => re.test(name));
    band = hit ? hit[1] : null;
  }
  return { factionID: faction ? faction[1] : null, band, tier };
}

function sizeOf(type, groupName, chargeSize) {
  if (NAME_EXCLUDES.some((x) => type.name.includes(x))) return null;
  if (GROUP_EXCLUDES.includes(groupName)) return null;
  if (chargeSize === 4) return null;
  const dogmaSized = type.categoryID === CAT.CHARGE || TURRET_GROUPS.includes(groupName);
  if (dogmaSized && CHARGE_SIZES[chargeSize]) return CHARGE_SIZES[chargeSize];
  if (MISSILE_GROUP.test(groupName)) {
    const hit = MISSILE_SIZES.find(([re]) => re.test(groupName));
    return hit ? hit[1] : "any";
  }
  const hit = NAME_SIZES.find(([re]) => re.test(type.name));
  return hit ? hit[1] : "any";
}

async function eachLine(file, fn) {
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) if (line.trim()) fn(JSON.parse(line));
}

const startsWithAny = (name, prefixes) => (prefixes || []).some((p) => name.startsWith(p));

async function build(sdeDir) {
  const groups = new Map();
  await eachLine(path.join(sdeDir, "groups.jsonl"), (r) => groups.set(r._key, { categoryID: r.categoryID, name: en(r) }));
  let chargeSizeID = null;
  await eachLine(path.join(sdeDir, "dogmaAttributes.jsonl"), (r) => { if (r.name === CHARGE_SIZE_ATTRIBUTE) chargeSizeID = r._key; });
  if (!Number.isInteger(chargeSizeID)) throw new Error(`dogma attribute ${CHARGE_SIZE_ATTRIBUTE} not found`);
  const factionNames = new Map();
  await eachLine(path.join(sdeDir, "factions.jsonl"), (r) => factionNames.set(r._key, en(r)));

  const wanted = new Set([CRIMINAL_TAGS_GROUP, EMPIRE_INSIGNIA_GROUP, ROGUE_DRONE_COMPONENTS_GROUP]);
  const candidates = [];
  const commons = [];
  const blueprintTypes = new Set();
  const factionHulls = new Map();
  const materialTypeIDs = new Set(Object.values(FACTIONS).flatMap((f) => f.materialTypes || []));
  const materialTypeGroup = new Map();
  const typesByGroup = new Map();
  const npcClass = new Map();
  for (const [groupID, g] of groups) if (g.categoryID === CAT.NPC) npcClass.set(groupID, classifyNpcGroup(g.name, groupID));
  const typeBandGroups = new Set([...npcClass].filter(([, c]) => c.band === null && TYPE_BAND_FACTIONS.includes(c.factionID)).map(([id]) => id));
  const npcTypes = [];
  const hullNames = [];
  await eachLine(path.join(sdeDir, "types.jsonl"), (r) => {
    if (typeBandGroups.has(r.groupID)) npcTypes.push({ typeID: r._key, name: en(r), mass: Number(r.mass) || 0, groupID: r.groupID });
    if (materialTypeIDs.has(r._key)) materialTypeGroup.set(r._key, r.groupID);
    if (r.published !== true) return;
    const g = groups.get(r.groupID);
    if (!g) return;
    if (!MATERIAL_SKIP_CATEGORIES.includes(g.categoryID) && !MATERIAL_NAME_EXCLUDES.test(en(r))) {
      if (!typesByGroup.has(r.groupID)) typesByGroup.set(r.groupID, []);
      typesByGroup.get(r.groupID).push({ typeID: r._key, name: en(r) });
    }
    if (g.categoryID === CAT.SHIP && SHIP_GROUP_BANDS[g.name]) hullNames.push({ name: en(r), band: SHIP_GROUP_BANDS[g.name] });
    if (g.categoryID === CAT.BLUEPRINT) { blueprintTypes.add(r._key); return; }
    if (g.categoryID === CAT.SHIP && r.metaGroupID === META.FACTION && FACTIONS[r.factionID]) {
      factionHulls.set(r._key, { factionID: r.factionID, groupName: g.name, name: en(r) });
    }
    const common = commonCategoryOf(r, g);
    if (common) commons.push({ typeID: r._key, name: en(r), groupID: r.groupID, categoryID: g.categoryID, common });
    const isItem = (g.categoryID === CAT.MODULE || g.categoryID === CAT.CHARGE) && (r.metaGroupID === META.FACTION || r.metaGroupID === META.DEADSPACE);
    if (!isItem && !wanted.has(r.groupID)) return;
    candidates.push({ typeID: r._key, name: en(r), groupID: r.groupID, categoryID: g.categoryID, metaGroupID: r.metaGroupID });
  });
  const needDogma = new Set([...candidates, ...commons].filter((c) => c.categoryID === CAT.MODULE || c.categoryID === CAT.CHARGE).map((c) => c.typeID));
  const chargeSizes = new Map();
  await eachLine(path.join(sdeDir, "typeDogma.jsonl"), (r) => {
    if (!needDogma.has(r._key)) return;
    const a = (r.dogmaAttributes || []).find((x) => x.attributeID === chargeSizeID);
    if (a) chargeSizes.set(r._key, Math.round(a.value));
  });
  candidates.sort((a, b) => a.typeID - b.typeID);
  commons.sort((a, b) => a.typeID - b.typeID);

  const report = { chargeSizeAttributeID: chargeSizeID, pools: {}, any: [], unknownShipGroups: [], common: null };
  const commonPools = { ammo: {}, module: {}, salvage: [] };
  for (const c of commons) {
    if (c.common === "salvage") { commonPools.salvage.push(c.typeID); continue; }
    if (TURRET_GROUPS.includes(groups.get(c.groupID).name) && !chargeSizes.has(c.typeID)) continue;
    const size = sizeOf(c, groups.get(c.groupID).name, chargeSizes.get(c.typeID));
    if (!size) continue;
    (commonPools[c.common][size] = commonPools[c.common][size] || []).push(c.typeID);
  }
  const common = {};
  for (const cat of ["ammo", "module"]) {
    common[cat] = {};
    for (const s of SIZE_KEYS) if (commonPools[cat][s]) common[cat][s] = [...new Set(commonPools[cat][s])];
  }
  common.salvage = [...new Set(commonPools.salvage)];
  report.common = Object.fromEntries(Object.entries(common).map(([cat, v]) => [cat,
    Array.isArray(v) ? v.length : Object.fromEntries(Object.entries(v).map(([s, ids]) => [s, ids.length]))]));
  const factions = {};
  for (const [id, f] of Object.entries(FACTIONS)) {
    const pools = {};
    const addSized = (cat, c) => {
      const size = sizeOf(c, groups.get(c.groupID).name, chargeSizes.get(c.typeID));
      if (!size) return;
      pools[cat] = pools[cat] || {};
      pools[cat][size] = pools[cat][size] || [];
      pools[cat][size].push(c.typeID);
      if (size === "any") report.any.push(`${f.key}/${cat}: ${c.typeID} ${c.name}`);
    };
    for (const c of candidates) {
      if (f.tagGroup && c.groupID === f.tagGroup && startsWithAny(c.name, f.tags)) (pools.tag = pools.tag || []).push(c.typeID);
      else if (f.materialGroups && f.materialGroups.includes(c.groupID)) (pools.material = pools.material || []).push(c.typeID);
      else if (c.metaGroupID === META.FACTION && startsWithAny(c.name, f.items)) {
        addSized(c.categoryID === CAT.CHARGE ? "ammo" : "module", c);
      } else if (c.metaGroupID === META.FACTION && c.categoryID === CAT.CHARGE && startsWithAny(c.name, f.ammo)) {
        addSized("ammo", c);
      } else if (c.metaGroupID === META.DEADSPACE && c.categoryID === CAT.MODULE && startsWithAny(c.name, f.deadspace)) {
        addSized("deadspace", c);
      }
    }
    for (const typeID of f.materialTypes || []) {
      const ids = (typesByGroup.get(materialTypeGroup.get(typeID)) || [])
        .filter((t) => !(f.materialExcludes && f.materialExcludes.test(t.name))).map((t) => t.typeID);
      if (ids.length) pools.material = [...(pools.material || []), ...ids];
    }
    const ordered = {};
    for (const cat of ["tag", "material", "ammo", "module", "deadspace"]) {
      if (!pools[cat]) continue;
      if (Array.isArray(pools[cat])) ordered[cat] = [...new Set(pools[cat])].sort((a, b) => a - b);
      else {
        ordered[cat] = {};
        for (const s of SIZE_KEYS) if (pools[cat][s]) ordered[cat][s] = [...new Set(pools[cat][s])].sort((a, b) => a - b);
      }
    }
    const label = factionNames.get(Number(id)) || f.key;
    factions[id] = { key: f.key, label, pools: ordered };
    const counts = {};
    for (const [cat, v] of Object.entries(ordered)) {
      counts[cat] = Array.isArray(v) ? v.length : Object.fromEntries(Object.entries(v).map(([s, ids]) => [s, ids.length]));
    }
    report.pools[`${id} ${f.key}`] = counts;
  }

  const productIndex = new Map();
  for (const [id, f] of Object.entries(factions)) {
    for (const cat of ["module", "ammo", "deadspace"]) {
      for (const [size, ids] of Object.entries(f.pools[cat] || {})) {
        for (const typeID of ids) {
          if (!productIndex.has(typeID)) productIndex.set(typeID, []);
          productIndex.get(typeID).push({ factionID: id, cat, size });
        }
      }
    }
  }
  const bpc = {};
  for (const id of Object.keys(factions)) bpc[id] = { bpcModule: {}, bpcHull: {}, deadspace: 0 };
  const bpcMaxRuns = {};
  report.bpcExcludedHulls = [];
  await eachLine(path.join(sdeDir, "blueprints.jsonl"), (r) => {
    const products = r.activities && r.activities.manufacturing && r.activities.manufacturing.products;
    const productID = products && products[0] && products[0].typeID;
    if (!blueprintTypes.has(r._key) || !productID) return;
    let used = false;
    for (const hit of productIndex.get(productID) || []) {
      if (hit.cat === "deadspace") { bpc[hit.factionID].deadspace += 1; continue; }
      (bpc[hit.factionID].bpcModule[hit.size] = bpc[hit.factionID].bpcModule[hit.size] || []).push(r._key);
      used = true;
    }
    const hull = factionHulls.get(productID);
    if (hull) {
      const size = HULL_OF_BAND[SHIP_GROUP_BANDS[hull.groupName]];
      if (!size) report.bpcExcludedHulls.push(`${hull.factionID}: ${r._key} (${hull.name}, ${hull.groupName})`);
      else {
        (bpc[hull.factionID].bpcHull[size] = bpc[hull.factionID].bpcHull[size] || []).push(r._key);
        used = true;
      }
    }
    if (used) bpcMaxRuns[r._key] = Math.max(1, Number(r.maxProductionLimit) || 1);
  });
  report.bpc = {};
  for (const [id, f] of Object.entries(factions)) {
    const b = bpc[id];
    for (const [cat, keys] of [["bpcModule", SIZE_KEYS], ["bpcHull", HULL_KEYS]]) {
      const ordered = {};
      for (const s of keys) if (b[cat][s]) ordered[s] = [...new Set(b[cat][s])].sort((x, y) => x - y);
      if (Object.keys(ordered).length) f.pools[cat] = ordered;
    }
    const count = (p) => Object.values(p || {}).reduce((n, ids) => n + ids.length, 0);
    report.bpc[`${id} ${f.key}`] = { bpcModule: count(f.pools.bpcModule), bpcHull: count(f.pools.bpcHull), deadspace: b.deadspace };
  }
  const sortedMaxRuns = Object.fromEntries(Object.entries(bpcMaxRuns).sort((a, b) => Number(a[0]) - Number(b[0])));

  report.skippedFactions = [];
  for (const [id, f] of Object.entries(factions)) {
    if (Object.keys(f.pools).length) continue;
    report.skippedFactions.push(`skip ${f.key}: no items`);
    delete factions[id];
  }

  const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const hullMatchers = [...new Map(hullNames.map((h) => [h.name, h.band])).entries()]
    .sort((a, b) => b[0].length - a[0].length || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([name, band]) => ({ re: new RegExp(`(^|[^A-Za-z0-9])${escapeRe(name)}($|[^A-Za-z0-9])`, "i"), band }));
  const npcTypeBands = {};
  report.npcTypeBands = { 1: 0, 2: 0, 3: 0, null: 0 };
  report.npcTypeBandsByMass = [];
  for (const t of npcTypes.sort((a, b) => a.typeID - b.typeID)) {
    const groupName = (groups.get(t.groupID) || {}).name || "";
    const token = BAND_RULES.find(([re]) => re.test(t.name))
      || (SMALL_CRAFT_TYPE_TOKEN.test(t.name) || SMALL_CRAFT_GROUP_TOKEN.test(groupName) ? [null, "frigate"] : null);
    const hull = token ? null : hullMatchers.find((m) => m.re.test(t.name));
    const byMass = token || hull || !(t.mass > 0) ? null : (MASS_BANDS.find(([max]) => t.mass < max) || [0, "capital"])[1];
    const band = token ? token[1] : hull ? hull.band : byMass;
    report.npcTypeBands[token ? 1 : hull ? 2 : byMass ? 3 : "null"] += 1;
    if (byMass) report.npcTypeBandsByMass.push(`${t.typeID} ${t.name} (group ${t.groupID}, ${t.mass} kg) -> ${byMass}`);
    if (band) npcTypeBands[t.typeID] = band;
  }

  const npcGroups = [];
  const shipGroups = [];
  for (const [groupID, g] of [...groups.entries()].sort((a, b) => a[0] - b[0])) {
    if (g.categoryID === CAT.NPC) npcGroups.push({ groupID, ...npcClass.get(groupID), name: g.name });
    else if (g.categoryID === CAT.SHIP) {
      if (SHIP_GROUP_BANDS[g.name]) shipGroups.push({ groupID, band: SHIP_GROUP_BANDS[g.name] });
      else if (!SHIP_GROUP_NO_BAND.includes(g.name)) report.unknownShipGroups.push(`${groupID} ${g.name}`);
    }
  }

  const factionAliases = {};
  const aliasIDs = [...Object.keys(FACTIONS).map(Number), ...new Set(FACTION_RULES.map(([, id]) => id))];
  for (const id of [...new Set(aliasIDs)].sort((a, b) => a - b)) {
    const names = [factionNames.get(id), FACTIONS[id] && FACTIONS[id].key.replace(/_/g, " ")];
    for (const n of names) if (n) factionAliases[n.toLowerCase()] = id;
  }
  for (const [n, id] of Object.entries({ guristas: 500010, angel: 500011, "blood raiders": 500012, sansha: 500019,
    "rogue drone": 500025, concord: 500006 })) factionAliases[n] = id;
  const sortedAliases = Object.fromEntries(Object.entries(factionAliases).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)));

  const hint = new RegExp(`\\b(${Object.values(FACTIONS).map((f) => f.key.split("_")[0].replace(/s$/, "")).join("|")})`, "i");
  report.groupsWithoutFaction = npcGroups.filter((g) => g.factionID === null && hint.test(g.name)).map((g) => `${g.groupID} ${g.name}`);

  const data = { schemaVersion: 1, sdeBuild: SDE_BUILD, chargeSizeAttributeID: chargeSizeID, factions, common, npcGroups, npcTypeBands, shipGroups, factionAliases: sortedAliases, bpcMaxRuns: sortedMaxRuns };
  report.npcGroups = npcGroups.length;
  report.npcGroupsWithBand = npcGroups.filter((g) => g.band).length;
  report.shipGroups = shipGroups.length;
  return { data, report };
}

const serialize = (data) => `${JSON.stringify(data, null, 1)}\n`;

async function main(argv) {
  const sdeArg = argv.indexOf("--sde");
  const sdeDir = sdeArg >= 0 ? argv[sdeArg + 1] : DEFAULT_SDE;
  const check = argv.includes("--check");
  const { data, report } = await build(sdeDir);
  const text = serialize(data);
  console.log(`chargeSize attribute ID: ${report.chargeSizeAttributeID}`);
  for (const [f, counts] of Object.entries(report.pools)) console.log(`pool ${f}: ${JSON.stringify(counts)}`);
  console.log(`common (T1 filler): ${JSON.stringify(report.common)}`);
  for (const [f, counts] of Object.entries(report.bpc)) console.log(`bpc ${f}: ${JSON.stringify(counts)}`);
  if (report.bpcExcludedHulls.length) console.log(`bpcHull without a hull size (not mapped): ${report.bpcExcludedHulls.join("; ")}`);
  for (const line of report.skippedFactions) console.log(line);
  console.log(`npcGroups: ${report.npcGroups} (with band ${report.npcGroupsWithBand}), shipGroups: ${report.shipGroups}`);
  console.log(`npcTypeBands by rule (1 name token, 2 hull name, 3 mass, null none): ${JSON.stringify(report.npcTypeBands)}`);
  for (const line of report.npcTypeBandsByMass) console.log(`  mass ${line}`);
  console.log(`npc groups with a faction name and factionID null: ${report.groupsWithoutFaction.length ? report.groupsWithoutFaction.join("; ") : "none"}`);
  if (report.unknownShipGroups.length) console.log(`ship groups without band (not mapped): ${report.unknownShipGroups.join("; ")}`);
  console.log(`size "any" (check manually): ${report.any.length}`);
  for (const line of report.any) console.log(`  any ${line}`);
  if (check) {
    let current = null;
    try { current = fs.readFileSync(OUT, "utf8").replace(/\r\n/g, "\n"); } catch (_error) { current = null; }
    if (current !== text) {
      console.log(`CHECK FAILED: ${OUT} differs from the SDE build ${SDE_BUILD} (run without --check to rebuild)`);
      return 1;
    }
    console.log(`CHECK OK: ${OUT} matches the SDE`);
    return 0;
  }
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, text);
  console.log(`wrote ${OUT} (${Buffer.byteLength(text)} bytes)`);
  return 0;
}

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error) => {
    console.error(`buildFactionLoot failed: ${error && error.stack || error}`);
    process.exitCode = 2;
  });
}

module.exports = { build, classifyNpcGroup, sizeOf, serialize, FACTIONS, FACTION_RULES, BAND_OVERRIDES, SHIP_GROUP_BANDS };
