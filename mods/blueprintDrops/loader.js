"use strict";

const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const { isMainThread } = require("node:worker_threads");
const resonators = require("./lib/resonators");
const factionLoot = require("./lib/factionLoot");
const { shouldRollBlueprint } = require("./lib/lootRoll");
const { isDropPoolBlueprint } = require("./lib/blueprintPool");
const { createSalvageCopiesWrapper } = require("./lib/salvageCopies");

const LOG = "[blueprintDrops]";
const RUNTIME_ROOT = path.resolve(__dirname, "../..");
const SRC = path.join(RUNTIME_ROOT, "server", "src");
const MARKER = "evejsBlueprintDrop";

const loadedConfig = require("./config").loadConfig();
const settings = loadedConfig.settings;
const log = (msg) => console.log(`${LOG} ${msg}`);
for (const line of loadedConfig.warnings) log(`WARN ${line}`);

const TARGETS = {
  npcLoot: path.join(SRC, "space", "npc", "npcLoot.js"),
  nativeNpcStore: path.join(SRC, "space", "npc", "nativeNpcStore.js"),
  wreckService: path.join(SRC, "space", "npc", "nativeNpcWreckService.js"),
  npcData: path.join(SRC, "space", "npc", "npcData.js"),
  salvageCustody: path.join(SRC, "services", "inventory", "salvageItemCustody.js"),
};

let itemTypesCache = null;
function getItemTypes() {
  if (itemTypesCache) return itemTypesCache;
  const { TABLE, readStaticRows } = require(path.join(SRC, "services", "_shared", "referenceData"));
  itemTypesCache = new Map(readStaticRows(TABLE.ITEM_TYPES).map((t) => [t.typeID, t]));
  return itemTypesCache;
}

let pool = null;
function getPool() {
  if (pool) return pool;
  const { resolveDataDir } = require(path.join(SRC, "gameStore", "storeRoot"));
  const file = path.join(resolveDataDir(), "industryBlueprints", "data.json");
  const defs = JSON.parse(fs.readFileSync(file, "utf8")).blueprintDefinitions || [];
  const itemTypes = getItemTypes();
  const maxRunsByType = new Map(defs.map((d) => [d.blueprintTypeID, d.maxProductionLimit || 1]));
  const all = [];
  for (const itemType of itemTypes.values()) {
    if (!isDropPoolBlueprint(itemType)) continue;
    all.push({ itemType, t2: / II Blueprint$/.test(itemType.name || ""), maxRuns: maxRunsByType.get(itemType.typeID) || 10 });
  }
  pool = { all, t1: all.filter((b) => !b.t2), t2: all.filter((b) => b.t2) };
  log(`blueprint pool: ${all.length} (${pool.t1.length} T1/other, ${pool.t2.length} T2)`);
  return pool;
}

const pick = (list) => list[Math.floor(Math.random() * list.length)];
const randInt = (min, max) => min + Math.floor(Math.random() * (max - min + 1));

function chanceFor(lootTable) {
  const id = String(lootTable && lootTable.lootTableID || "");
  if (/_small$/.test(id)) return settings.chanceSmall;
  if (/_medium$/.test(id)) return settings.chanceMedium;
  if (/_large$/.test(id)) return settings.chanceLarge;
  return settings.chanceOther;
}

function rollBlueprint(lootTable) {
  if (!lootTable || Math.random() >= chanceFor(lootTable)) return null;
  const p = getPool();
  const total = settings.copyShare + settings.t1OriginalShare + settings.t2OriginalShare;
  let r = Math.random() * total;
  let kind = "copy";
  if ((r -= settings.copyShare) >= 0) kind = (r -= settings.t1OriginalShare) < 0 ? "t1" : "t2";
  const list = kind === "copy" ? p.all : kind === "t1" ? p.t1 : p.t2;
  if (!list.length) return null;
  const bp = pick(list);
  const entry = { itemType: bp.itemType, typeID: bp.itemType.typeID, name: bp.itemType.name, quantity: 1, singleton: true };
  if (kind === "copy") {
    entry.copySpec = {
      runs: randInt(1, Math.max(1, Math.min(settings.copyMaxRuns, bp.maxRuns))),
      me: randInt(0, settings.copyMaxMaterialEfficiency),
      te: 2 * randInt(0, Math.floor(settings.copyMaxTimeEfficiency / 2)),
    };
  }
  return entry;
}

const DATA_FILE = path.join(__dirname, "data", "pirateNpcGroups.json");

function loadResonatorData() {
  try {
    return resonators.loadData(JSON.parse(fs.readFileSync(DATA_FILE, "utf8")));
  } catch (error) {
    return { ok: false, reason: "BAD_DATA", detail: error.message };
  }
}

const resonatorData = settings.resonatorsEnabled ? loadResonatorData() : null;
let resonatorState = null;
const counters = { drops: 0, units: 0, components: 0, byFaction: {} };

function getResonatorState() {
  if (resonatorState) return resonatorState;
  const off = (reason, detail) => {
    log(`resonators off: ${reason}${detail ? ` (${detail})` : ""}`);
    return { on: false };
  };
  try {
    if (!settings.resonatorsEnabled) resonatorState = { on: false };
    else if (!resonatorData || !resonatorData.ok) resonatorState = off("BAD_DATA", resonatorData && resonatorData.detail);
    else {
      const valid = resonators.validateSettings(settings);
      if (!valid.ok) resonatorState = off(valid.reason, valid.detail);
      else {
        const itemTypes = getItemTypes();
        const types = resonators.checkTypes(resonatorData.data, (id) => itemTypes.has(id));
        if (!types.ok) resonatorState = off(types.reason, types.detail);
        else {
          if (!types.componentsOk) log(`resonator components off: MISSING_TYPE (${types.missingComponents.join(",")})`);
          const soe = resonatorData.data.factions.get(resonators.SOE_FACTION_ID);
          resonatorState = { on: true, data: resonatorData.data, itemTypes, componentsOk: types.componentsOk, soeTypeID: soe ? soe.resonatorTypeID : null,
            resonatorIDs: new Set([...resonatorData.data.factions.values()].map((f) => f.resonatorTypeID)) };
        }
      }
    }
  } catch (error) {
    resonatorState = off("INIT_FAILED", error.message);
  }
  return resonatorState;
}

function appendResonators(entries, options) {
  const source = options && options.source;
  if (!source || !Array.isArray(entries) || (!source.profileID && !source.npcTypeID)) return;
  const state = getResonatorState();
  if (!state.on) return;
  const out = resonators.buildWreckEntries(source, {
    ...state, getProfile: (id) => require(TARGETS.npcData).getNpcProfile(id), settings, rng: Math.random,
  });
  const { resolved, rolled } = out;
  if (!resolved || !rolled.length) return;
  const faction = state.data.factions.get(resolved.factionID);
  const label = faction ? faction.label : String(resolved.factionID);
  for (const entry of out.entries) {
    entries.push(entry);
    const { typeID, quantity } = entry;
    if (state.resonatorIDs.has(typeID)) counters.units += quantity;
    else counters.components += quantity;
  }
  counters.drops += 1;
  counters.byFaction[label] = (counters.byFaction[label] || 0) + 1;
  if (settings.resonatorLogDrops) {
    log(`resonators: ${rolled.map((r) => `${r.quantity}x ${r.typeID}`).join(", ")} [${label} ${resolved.band}/${resolved.tier} via ${resolved.via}, npc ${source.npcTypeID}]`);
  }
  if (settings.resonatorSummaryEvery > 0 && counters.drops % settings.resonatorSummaryEvery === 0) {
    log(`resonators: drops=${counters.drops} units=${counters.units} byFaction=${JSON.stringify(counters.byFaction)} components=${counters.components}`);
  }
}

const FACTION_LOOT_FILE = path.join(__dirname, "data", "factionLoot.json");

function loadFactionLootData() {
  try {
    return factionLoot.loadData(JSON.parse(fs.readFileSync(FACTION_LOOT_FILE, "utf8")));
  } catch (error) {
    return { ok: false, reason: "BAD_DATA", detail: error.message };
  }
}

const factionLootData = settings.factionLootEnabled ? loadFactionLootData() : null;
let factionLootState = null;
let factionLootSeq = 0;
const flCounters = { rolls: 0, drops: 0, fillerDrops: 0, byRarity: {}, byFaction: {}, capped: 0, skipped: {} };

let copyStateFn;
function lazyCopyState() {
  if (copyStateFn !== undefined) return copyStateFn;
  try {
    const fn = require(path.join(SRC, "services", "inventory", "blueprintRewardState")).buildBlueprintCopyState;
    copyStateFn = typeof fn === "function" ? fn : null;
  } catch (_error) {
    copyStateFn = null;
  }
  if (!copyStateFn) log("faction loot epic off (NO_COPY_STATE)");
  return copyStateFn;
}
function buildCopyState(spec) {
  const fn = lazyCopyState();
  if (!fn) throw new Error("NO_COPY_STATE");
  return fn(spec);
}

function getFactionLootState() {
  if (factionLootState) return factionLootState;
  const off = (reason, detail) => {
    log(`faction loot: off (${reason}${detail ? `: ${detail}` : ""})`);
    return { on: false };
  };
  try {
    if (!settings.factionLootEnabled) factionLootState = { on: false };
    else if (!factionLootData || !factionLootData.ok) factionLootState = off("BAD_DATA", factionLootData && factionLootData.detail);
    else {
      const valid = factionLoot.validateSettings(settings);
      if (!valid.ok) factionLootState = off(valid.reason, valid.detail);
      else {
        const itemTypes = getItemTypes();
        const checked = factionLoot.checkTypes(factionLootData.data, (id) => itemTypes.has(id));
        log(`faction loot: on (${checked.data.factions.size} factions, types=${checked.types}, missing=${checked.missing.length})`);
        factionLootState = { on: true, data: checked.data, itemTypes,
          caps: factionLoot.createRateCaps({ rare: settings.factionLootRareCapPerHour, epic: settings.factionLootEpicCapPerHour }) };
      }
    }
  } catch (error) {
    factionLootState = off("INIT_FAILED", error.message);
  }
  return factionLootState;
}

function appendFactionLoot(entries, lootTable, options, vendorEntryCount) {
  if (!settings.factionLootEnabled || !Array.isArray(entries)) return;
  const state = getFactionLootState();
  if (!state.on) return;
  const source = (options && options.source) || {};
  const extra = options && options.extraRoll === true;
  const npcTypeID = Number(source.npcTypeID) || 0;
  const resolved = !extra && npcTypeID > 0 ? factionLoot.resolveSource(source, { data: state.data,
    getProfile: (id) => require(TARGETS.npcData).getNpcProfile(id),
    getType: (id) => state.itemTypes.get(id) || null }) : null;
  const nowMs = Date.now();
  factionLootSeq += 1;
  const own = !(options && typeof options.random === "function");
  const seed = `${settings.factionLootSeedSalt}|${npcTypeID}|${source.profileID || ""}|${factionLootSeq}|${nowMs}`;
  const rng = own ? factionLoot.createSeededRng(seed) : options.random;
  const out = factionLoot.rollFactionLoot({ lootTable, options, vendorEntries: entries, vendorEntryCount },
    { settings, data: state.data, resolved, rng, nowMs, caps: state.caps, getItemType: (id) => state.itemTypes.get(id) || null,
      buildCopyState: copyStateFn === null ? undefined : buildCopyState });
  flCounters.rolls += 1;
  if (!out.ok || out.reason !== "ROLLED") {
    flCounters.skipped[out.reason] = (flCounters.skipped[out.reason] || 0) + 1;
    if (!out.ok) log(`faction loot roll failed: ${out.reason} (${out.detail})`);
    return;
  }
  flCounters.capped += out.capped.length;
  for (const reason of out.skipped || []) flCounters.skipped[reason] = (flCounters.skipped[reason] || 0) + 1;
  if (!out.entries.length) return;
  for (const entry of out.entries) entries.push(entry);
  const faction = state.data.factions.get(resolved.factionID);
  const label = faction ? faction.key : resolved.factionID === null ? "none" : String(resolved.factionID);
  const factionDrop = out.drops.some((d) => d.rarity !== "common");
  if (factionDrop) {
    flCounters.drops += 1;
    flCounters.byFaction[label] = (flCounters.byFaction[label] || 0) + 1;
  } else flCounters.fillerDrops += 1;
  for (const d of out.drops) flCounters.byRarity[d.rarity] = (flCounters.byRarity[d.rarity] || 0) + 1;
  if (settings.factionLootLog) {
    const epic = out.drops.find((d) => d.rarity === "epic");
    const epicEntry = epic && out.entries.find((e) => e.typeID === epic.typeID);
    log(`faction loot: ${out.drops.map((d) => `${d.rarity} ${d.category} ${d.quantity}x ${d.typeID}`).join(", ")} `
      + `${epic ? `epic=${epicEntry ? epicEntry.name : epic.typeID} runs=${epic.runs} ` : ""}`
      + `[${label} ${resolved.band}/${resolved.tier} via ${resolved.via}, npc ${npcTypeID}, seed ${own ? seed : "options.random"}]`);
  }
  if (factionDrop && settings.factionLootSummaryEvery > 0 && flCounters.drops % settings.factionLootSummaryEvery === 0) {
    log(`faction loot: rolls=${flCounters.rolls} drops=${flCounters.drops} filler=${flCounters.fillerDrops} byRarity=${JSON.stringify(flCounters.byRarity)} `
      + `byFaction=${JSON.stringify(flCounters.byFaction)} capped=${flCounters.capped} skipped=${JSON.stringify(flCounters.skipped)}`);
  }
}

let pendingCopies = [];

function patchNpcLoot(exp) {
  const orig = exp.rollNpcLootEntries;
  exp.rollNpcLootEntries = function rollNpcLootEntriesWithBlueprints(lootTable, ...rest) {
    const entries = orig.call(this, lootTable, ...rest);
    const vendorCount = Array.isArray(entries) ? entries.length : null;
    pendingCopies = [];
    try {
      const bp = shouldRollBlueprint(rest[0]) ? rollBlueprint(lootTable) : null;
      if (bp) {
        entries.push(bp);
        if (bp.copySpec) pendingCopies.push({ typeID: bp.typeID, spec: bp.copySpec });
        if (settings.log) log(`drop ${bp.copySpec ? `copy (${bp.copySpec.runs} runs, ME ${bp.copySpec.me}, TE ${bp.copySpec.te})` : "original"}: ${bp.name} [${lootTable.lootTableID}]`);
      }
    } catch (error) {
      log(`roll failed: ${error.message}`);
    }
    try {
      appendResonators(entries, rest[0]);
    } catch (error) {
      log(`resonator roll failed: ${error.message}`);
    }
    try {
      appendFactionLoot(entries, lootTable, rest[0], vendorCount);
    } catch (error) {
      log(`faction loot roll failed: ${error.message}`);
    }
    return entries;
  };
}

function patchNativeNpcStore(exp) {
  const orig = exp.upsertNativeWreckItem;
  exp.upsertNativeWreckItem = function upsertNativeWreckItemWithBlueprintMarker(record, ...rest) {
    if (record && record.sourceKind === "loot" && pendingCopies.length) {
      const i = pendingCopies.findIndex((p) => p.typeID === record.typeID);
      if (i >= 0) {
        record.customInfo = JSON.stringify({ [MARKER]: pendingCopies[i].spec });
        pendingCopies.splice(i, 1);
      }
    }
    return orig.call(this, record, ...rest);
  };
}

function readMarker(record) {
  try {
    const info = JSON.parse(record && record.customInfo || "");
    return info && info[MARKER] || null;
  } catch (_error) {
    return null;
  }
}

function patchWreckService(exp) {
  const orig = exp.transferNativeWreckItemToCharacterLocation;
  exp.transferNativeWreckItemToCharacterLocation = function transferWithBlueprintCopies(options = {}, ...rest) {
    let spec = null;
    let typeID = 0;
    try {
      const nativeNpcStore = require(TARGETS.nativeNpcStore);
      const record = nativeNpcStore.getNativeWreckItem(Number(options.wreckItemID));
      spec = readMarker(record);
      typeID = record && record.typeID;
    } catch (_error) {
      spec = null;
    }
    const result = orig.call(this, options, ...rest);
    if (!spec || !result || result.success !== true) return result;
    try {
      makeCopy(result, typeID, spec);
    } catch (error) {
      log(`could not turn the looted blueprint into a copy: ${error.message}`);
    }
    return result;
  };
}

function makeCopy(result, typeID, spec) {
  const itemStore = require(path.join(SRC, "services", "inventory", "itemStore"));
  const industry = require(path.join(SRC, "services", "industry", "industryRuntimeState"));
  const changes = (result.data && result.data.destinationChanges) || [];
  const change = changes.find((c) => c && c.item && c.item.typeID === typeID);
  if (!change) return;
  const itemID = change.item.itemID;
  const updated = itemStore.updateInventoryItem(itemID, (item) => ({ ...item, singleton: 2, quantity: -2, stacksize: 1 }));
  if (!updated.success) throw new Error(updated.errorMsg);
  const state = industry.initializeBlueprintState(itemID, {
    typeID, original: false, runsRemaining: spec.runs, materialEfficiency: spec.me, timeEfficiency: spec.te, jobID: null,
  });
  if (!state.success) throw new Error(state.errorMsg);
  change.item = updated.data;
  if (settings.log) log(`looted copy itemID=${itemID} typeID=${typeID} runs=${spec.runs} ME=${spec.me} TE=${spec.te}`);
}

function patchSalvageCustody(exp) {
  const orig = exp.transferNativeWreckLootToContainer;
  if (typeof orig !== "function") throw new Error("transferNativeWreckLootToContainer missing");
  exp.transferNativeWreckLootToContainer = createSalvageCopiesWrapper(orig, () => {
    const itemStore = require(path.join(SRC, "services", "inventory", "itemStore"));
    return {
      nativeNpcStore: require(TARGETS.nativeNpcStore),
      itemStore: { ITEM_FLAGS: itemStore.ITEM_FLAGS, grantItemsToOwnerLocation: itemStore.grantItemsToOwnerLocation },
      resolveItemByTypeID: require(path.join(SRC, "services", "inventory", "itemTypeRegistry")).resolveItemByTypeID,
      blueprintRewardState: require(path.join(SRC, "services", "inventory", "blueprintRewardState")),
      industry: require(path.join(SRC, "services", "industry", "industryRuntimeState")),
      readMarker,
    };
  }, (copies, wreckID) => {
    if (settings.log) log(`salvaged wreck ${wreckID}: ${copies} blueprint cop${copies === 1 ? "y" : "ies"} kept as copies in the loot container`);
  });
}

const DROP_PATCHERS = [
  [path.normalize(TARGETS.npcLoot), patchNpcLoot],
  [path.normalize(TARGETS.nativeNpcStore), patchNativeNpcStore],
  [path.normalize(TARGETS.wreckService), patchWreckService],
];
const PATCHERS = new Map([
  ...(settings.enabled ? DROP_PATCHERS : []),
  ...(settings.salvageCopyFix ? [[path.normalize(TARGETS.salvageCustody), patchSalvageCustody]] : []),
]);

function install() {
  if (global.__blueprintDropsInstalled) return;
  global.__blueprintDropsInstalled = true;
  const patched = new Set();
  const origLoad = Module._load;
  Module._load = function blueprintDropsLoad(request, parent, isMain) {
    const exp = origLoad.apply(this, arguments);
    if (patched.size < PATCHERS.size) {
      let filename = null;
      try { filename = path.normalize(Module._resolveFilename(request, parent, isMain)); } catch (_error) {}
      const patcher = filename && PATCHERS.get(filename);
      if (patcher && !patched.has(filename)) {
        patched.add(filename);
        try {
          patcher(exp);
          log(`hooked ${path.basename(filename)}`);
        } catch (error) {
          log(`could not hook ${path.basename(filename)}: ${error.message}`);
        }
      }
    }
    return exp;
  };
  log(`salvage copy fix: ${settings.salvageCopyFix ? "on" : "off"}`);
  if (!settings.enabled) {
    log("drops off (enabled: false)");
    return;
  }
  log(`active - chance per wreck: small ${settings.chanceSmall * 100}%, medium ${settings.chanceMedium * 100}%, large ${settings.chanceLarge * 100}%, other ${settings.chanceOther * 100}%`);
  const rep = resonators.startupReport(settings, resonatorData);
  if (rep.forceOff) resonatorState = { on: false };
  log(rep.line);
  const flRep = factionLoot.startupReport(settings, factionLootData);
  if (flRep.forceOff) factionLootState = { on: false };
  log(flRep.line);
}

global.__blueprintDropsGetPool = getPool;
if (isMainThread && (settings.enabled || settings.salvageCopyFix)) install();
