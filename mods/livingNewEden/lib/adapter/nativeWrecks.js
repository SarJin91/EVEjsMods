// The mod writes the wreck record itself (shape ported from :932-1000) in the scope of its own dungeon site (dungeonMaterializedSiteContent, dungeonSiteID, dungeonSiteInstanceID), so the vendor rebuilds the wrecks when the site materializes and frees them when the site ends.

"use strict";

const { isOwnSummary, validateSiteKey, ACTIVE_STATES } = require("./dungeonSites");
const { buildRewardLootTable, isFactionRewardName } = require("./rewardLoot");
const { flushTableThen } = require("./gameStoreFlush");

const MAX_DETAIL = 120;

const LOOT_RIGHTS_SNAPSHOT_VERSION = 1;

const WRECK_GROUP_NAME = "wreck";

const WRECK_CONDITION_STATE = Object.freeze({
  damage: 0,
  charge: 1,
  armorDamage: 0,
  shieldCharge: 0,
  incapacitated: false,
});

const DEFAULT_DIRECTION = Object.freeze({ x: 1, y: 0, z: 0 });

const FIXED_ITEMS_MAX = 8;
const FIXED_ITEM_MAX_QUANTITY = 1000000;

const { WRECK_ANOMALY: TAG_ANOMALY, WRECK_SLOT: TAG_SLOT } = require("./vendorTagFields");

const FACADE_METHODS = Object.freeze(["listOwn", "getOwn", "place", "remove", "flush", "checkLootTables",
  "checkWreckNames", "readGrid"]);

const MODULE_PATHS = Object.freeze({
  store: "space/npc/nativeNpcStore",
  wreckService: "space/npc/nativeNpcWreckService",
  wreckUtils: "space/wreckUtils",
  npcData: "space/npc/npcData",
  npcLoot: "space/npc/npcLoot",
  itemStore: "services/inventory/itemStore",
  typeRegistry: "services/inventory/itemTypeRegistry",
  runtime: "space/runtime",
  dungeonRuntime: "services/dungeon/dungeonRuntime",
});
const GAME_STORE_PATH = "gameStore/index";

const REQUIRED_FUNCTIONS = Object.freeze({
  store: Object.freeze(["allocateWreckID", "allocateWreckItemID", "upsertNativeWreck", "upsertNativeWreckItem",
    "listNativeWrecks", "listNativeWreckItemsForWreck", "removeNativeWreckCascade"]),
  wreckService: Object.freeze(["spawnNativeWreck", "destroyNativeWreck"]),
  wreckUtils: Object.freeze(["resolveEntityWreckType", "resolveShipWreckType"]),
  npcData: Object.freeze(["getNpcLootTable"]),
  npcLoot: Object.freeze(["rollNpcLootEntries"]),
  itemStore: Object.freeze(["getItemMetadata"]),
  typeRegistry: Object.freeze(["resolveItemByTypeID", "resolveItemByName"]),
  runtime: Object.freeze(["isSolarSystemSceneLoaded"]),
  dungeonRuntime: Object.freeze(["findInstanceBySiteKey"]),
});

function messageOf(err) {
  return String((err && err.message) || err).slice(0, MAX_DETAIL);
}

function detailOf(value) {
  return String(value === undefined || value === null ? "" : value).slice(0, MAX_DETAIL);
}

function fail(reason, detail, vendorWrites) {
  const out = { ok: false, reason };
  if (detail !== undefined) out.detail = detailOf(detail);
  if (vendorWrites !== undefined) out.vendorWrites = vendorWrites;
  return out;
}

function toPositiveInt(value, fallback = 0) {
  const numeric = Math.trunc(Number(value) || 0);
  return numeric > 0 ? numeric : fallback;
}

function toFiniteNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function cloneValue(value) {
  return JSON.parse(JSON.stringify(value));
}

// Port of the vendor normalizeWreckSingleton (nativeNpcWreckService.js:256-259, EveJS 261028): 2 = blueprint copy.
function normalizeWreckSingleton(value) {
  if (Number(value) === 2) return 2;
  return value === true || Number(value) === 1;
}

function isVec3(v) {
  return Boolean(v) && typeof v === "object"
    && Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
}

function isWreckType(itemType) {
  return Boolean(itemType) && toPositiveInt(itemType.typeID, 0) > 0
    && String(itemType.groupName || "").trim().toLowerCase() === WRECK_GROUP_NAME;
}

function checkModsFrom(mods) {
  if (!mods || typeof mods !== "object") return fail("SEAM_UNAVAILABLE", "mods");
  for (const key of Object.keys(REQUIRED_FUNCTIONS)) {
    const exportsObject = mods[key];
    if (!exportsObject || (typeof exportsObject !== "object" && typeof exportsObject !== "function")) {
      return fail("SEAM_UNAVAILABLE", `${key}_missing`);
    }
    for (const name of REQUIRED_FUNCTIONS[key]) {
      if (typeof exportsObject[name] !== "function") return fail("SEAM_UNAVAILABLE", `${key}.${name}_missing`);
    }
  }
  const table = mods.store.TABLE;
  if (!table || typeof table.WRECKS !== "string" || typeof table.WRECK_ITEMS !== "string") {
    return fail("SEAM_UNAVAILABLE", "store.TABLE_missing");
  }
  const flags = mods.itemStore.ITEM_FLAGS;
  if (!flags || !Number.isSafeInteger(flags.HANGAR)) return fail("SEAM_UNAVAILABLE", "itemStore.ITEM_FLAGS_missing");
  return { ok: true };
}

function loadModsFrom(load) {
  try {
    const mods = {};
    for (const key of Object.keys(MODULE_PATHS)) {
      const loaded = load(MODULE_PATHS[key]);
      if (!loaded || loaded.ok !== true) {
        return fail("SEAM_UNAVAILABLE", `${MODULE_PATHS[key]}_${(loaded && loaded.reason) || "load_failed"}`);
      }
      mods[key] = loaded.exports;
    }
    const gameStore = load(GAME_STORE_PATH);
    mods.gameStore = gameStore && gameStore.ok === true && gameStore.exports
      && typeof gameStore.exports.flushTableSync === "function" ? gameStore.exports : null;
    const checked = checkModsFrom(mods);
    return checked.ok ? { ok: true, mods } : checked;
  } catch (err) {
    return fail("SEAM_UNAVAILABLE", messageOf(err));
  }
}

function isSceneLoaded(mods, systemId) {
  const runtime = mods.runtime;
  return Boolean(runtime) && typeof runtime.isSolarSystemSceneLoaded === "function"
    && runtime.isSolarSystemSceneLoaded(systemId) === true;
}

// Shape ported from nativeNpcWreckService.js:932-1000; no sceneKey/sceneKind (the record belongs to the solar system scene, nativeRecordSceneOwnership.js:20-38).
function buildWreckRecord(wreckId, spec, wreckType, site, lootTableId) {
  const offset = spec.offset;
  const position = {
    x: site.position.x + offset.x,
    y: site.position.y + offset.y,
    z: site.position.z + offset.z,
  };
  const length = Math.sqrt((offset.x * offset.x) + (offset.y * offset.y) + (offset.z * offset.z));
  const direction = length > 0
    ? { x: offset.x / length, y: offset.y / length, z: offset.z / length }
    : { ...DEFAULT_DIRECTION };
  return {
    wreckID: wreckId,
    systemID: spec.systemId,
    locationID: spec.systemId,
    lootTableID: lootTableId !== undefined ? lootTableId : (spec.lootTableId || null),
    typeID: toPositiveInt(wreckType.typeID, 0),
    groupID: toPositiveInt(wreckType.groupID, 0),
    categoryID: toPositiveInt(wreckType.categoryID, 0),
    itemName: String(wreckType.name || "Wreck"),
    sourceTypeID: spec.shipTypeId,
    ownerID: spec.ownerId,
    corporationID: spec.ownerId,
    allianceID: 0,
    warFactionID: 0,
    securityStatus: 0,
    lootRightCorpID: spec.ownerId,
    lootRightsSnapshotVersion: LOOT_RIGHTS_SNAPSHOT_VERSION,
    lootRightFleetID: null,
    lootAbandoned: false,
    position,
    velocity: { x: 0, y: 0, z: 0 },
    direction,
    targetPoint: { ...position },
    mode: "STOP",
    speedFraction: 0,
    radius: 0,
    createdAtMs: spec.nowMs,
    expiresAtMs: spec.expiresAtMs,
    transient: false,
    dungeonMaterializedSiteContent: true,
    dungeonSiteID: site.siteId,
    dungeonSiteInstanceID: site.instanceId,
    [TAG_ANOMALY]: spec.anomalyId,
    [TAG_SLOT]: spec.slot,
    conditionState: { ...WRECK_CONDITION_STATE },
  };
}

// Port 1:1 of buildNativeWreckItemRecord (nativeNpcWreckService.js:340-373, not exported by the vendor).
function buildWreckItemRecord(mods, wreckRecord, itemType, options = {}) {
  const singleton = normalizeWreckSingleton(options.singleton);
  const quantity = singleton ? 1 : Math.max(1, toPositiveInt(options.quantity, 1));
  const metadata = mods.itemStore.getItemMetadata(itemType && itemType.typeID, itemType && itemType.name);
  const wreckItemIDResult = mods.store.allocateWreckItemID({
    transient: wreckRecord.transient === true,
  });
  if (!wreckItemIDResult.success || !wreckItemIDResult.data) {
    return wreckItemIDResult;
  }

  return {
    success: true,
    data: {
      wreckItemID: wreckItemIDResult.data,
      wreckID: wreckRecord.wreckID,
      ownerID: wreckRecord.ownerID,
      locationID: wreckRecord.wreckID,
      flagID: mods.itemStore.ITEM_FLAGS.HANGAR,
      typeID: toPositiveInt(itemType && itemType.typeID, 0),
      groupID: toPositiveInt(metadata && metadata.groupID, 0),
      categoryID: toPositiveInt(metadata && metadata.categoryID, 0),
      itemName: String(itemType && itemType.name || metadata && metadata.name || "Item"),
      quantity,
      singleton,
      customInfo: "",
      moduleState: options.moduleState ? cloneValue(options.moduleState) : null,
      ...(options.blueprintState ? { blueprintState: cloneValue(options.blueprintState) } : {}),
      sourceKind: String(options.sourceKind || "loot"),
      moduleID: toPositiveInt(options.moduleID, 0),
      volume: toFiniteNumber(metadata && metadata.volume, 0),
      transient: wreckRecord.transient === true,
    },
  };
}

function validatePlaceSpec(spec) {
  if (!spec || typeof spec !== "object") return "spec";
  if (typeof spec.anomalyId !== "string" || spec.anomalyId === "" || spec.anomalyId.trim() !== spec.anomalyId) {
    return "anomalyId";
  }
  if (!Number.isSafeInteger(spec.slot) || spec.slot < 0) return "slot";
  if (!validateSiteKey(spec.siteKey)) return "siteKey";
  if (!Number.isSafeInteger(spec.systemId) || spec.systemId <= 0) return "systemId";
  if (!isVec3(spec.offset)) return "offset";
  if (!Number.isSafeInteger(spec.shipTypeId) || spec.shipTypeId < 0) return "shipTypeId";
  if (typeof spec.hullGroup !== "string" || spec.hullGroup === "") return "hullGroup";
  if (spec.factionName !== null && spec.factionName !== undefined && typeof spec.factionName !== "string") {
    return "factionName";
  }
  if (!Number.isSafeInteger(spec.ownerId) || spec.ownerId <= 0) return "ownerId";
  if (spec.lootTableId !== null && spec.lootTableId !== undefined
    && (typeof spec.lootTableId !== "string" || spec.lootTableId === "")) return "lootTableId";
  const hasRewardLoot = spec.rewardLoot !== undefined && spec.rewardLoot !== null;
  if (hasRewardLoot && typeof spec.lootTableId === "string" && spec.lootTableId !== "") return "lootSource";
  if (hasRewardLoot && (typeof spec.rewardLoot !== "object" || Array.isArray(spec.rewardLoot))) return "rewardLoot";
  if (!Number.isSafeInteger(spec.lootRolls) || spec.lootRolls < 0) return "lootRolls";
  if (spec.lootSourceNpcTypeId !== undefined && spec.lootSourceNpcTypeId !== null
    && (!Number.isSafeInteger(spec.lootSourceNpcTypeId) || spec.lootSourceNpcTypeId < 0)) return "lootSourceNpcTypeId";
  if (!Number.isSafeInteger(spec.nowMs) || spec.nowMs <= 0) return "nowMs";
  if (!Number.isSafeInteger(spec.expiresAtMs) || spec.expiresAtMs <= spec.nowMs) return "expiresAtMs";
  if (spec.fallbackWreckNames !== undefined && spec.fallbackWreckNames !== null
    && (!Array.isArray(spec.fallbackWreckNames)
      || !spec.fallbackWreckNames.every((n) => typeof n === "string" && n !== ""))) return "fallbackWreckNames";
  if (spec.adopt !== undefined && typeof spec.adopt !== "boolean") return "adopt";
  if (spec.fixedItems !== undefined && spec.fixedItems !== null && !validFixedItems(spec.fixedItems)) {
    return "fixedItems";
  }
  return null;
}

function validFixedItems(list) {
  if (!Array.isArray(list) || list.length > FIXED_ITEMS_MAX) return false;
  return list.every((x) => Boolean(x) && typeof x === "object" && !Array.isArray(x)
    && Object.keys(x).every((k) => k === "typeId" || k === "quantity")
    && Number.isSafeInteger(x.typeId) && x.typeId > 0
    && Number.isSafeInteger(x.quantity) && x.quantity > 0 && x.quantity <= FIXED_ITEM_MAX_QUANTITY);
}

function resolveWreckTypeFrom(mods, spec) {
  if (spec.shipTypeId > 0) {
    const entityType = mods.wreckUtils.resolveEntityWreckType({
      nativeNpc: true,
      shipTypeID: spec.shipTypeId,
      factionName: spec.factionName || undefined,
    });
    if (isWreckType(entityType)) return entityType;
    const shipType = mods.wreckUtils.resolveShipWreckType(spec.shipTypeId);
    return isWreckType(shipType) ? shipType : null;
  }
  for (const name of spec.fallbackWreckNames || []) {
    const lookup = mods.typeRegistry.resolveItemByName(name, { exactOnly: true });
    if (lookup && lookup.success === true && isWreckType(lookup.match)) return lookup.match;
  }
  return null;
}

function ownEntryOf(record, anomalyId) {
  if (!record || record[TAG_ANOMALY] !== anomalyId) return null;
  const wreckId = toPositiveInt(record.wreckID, 0);
  if (wreckId <= 0) return null;
  return { slot: Number.isSafeInteger(record[TAG_SLOT]) ? record[TAG_SLOT] : -1, wreckId };
}

function sortOwn(wrecks) {
  return wrecks.sort((a, b) => a.slot - b.slot || a.wreckId - b.wreckId);
}

function hasGetNativeWreck(mods) {
  return typeof mods.store.getNativeWreck === "function";
}

function listOwnWrecksFrom(mods, anomalyId) {
  if (typeof anomalyId !== "string" || anomalyId === "") return fail("READ_FAILED", "anomalyId");
  try {
    const wrecks = [];
    for (const record of mods.store.listNativeWrecks()) {
      const entry = ownEntryOf(record, anomalyId);
      if (entry) wrecks.push(entry);
    }
    return { ok: true, wrecks: sortOwn(wrecks) };
  } catch (err) {
    return fail("READ_FAILED", messageOf(err));
  }
}

function getOwnWrecksFrom(mods, anomalyId, wreckIds) {
  if (typeof anomalyId !== "string" || anomalyId === "") return fail("READ_FAILED", "anomalyId");
  if (!Array.isArray(wreckIds)) return fail("READ_FAILED", "wreckIds");
  const ids = new Set(wreckIds.filter((id) => Number.isSafeInteger(id) && id > 0));
  if (ids.size === 0) return { ok: true, wrecks: [] };
  try {
    const wrecks = [];
    if (hasGetNativeWreck(mods)) {
      for (const id of ids) {
        const entry = ownEntryOf(mods.store.getNativeWreck(id), anomalyId);
        if (entry && entry.wreckId === id) wrecks.push(entry);
      }
    } else {
      for (const record of mods.store.listNativeWrecks()) {
        const entry = ownEntryOf(record, anomalyId);
        if (entry && ids.has(entry.wreckId)) wrecks.push(entry);
      }
    }
    return { ok: true, wrecks: sortOwn(wrecks) };
  } catch (err) {
    return fail("READ_FAILED", messageOf(err));
  }
}

function readWreckRecord(mods, wreckId) {
  if (hasGetNativeWreck(mods)) return mods.store.getNativeWreck(wreckId) || null;
  return mods.store.listNativeWrecks().find((r) => r && toPositiveInt(r.wreckID, 0) === wreckId) || null;
}

function cascadeQuietly(mods, wreckId) {
  try {
    mods.store.removeNativeWreckCascade(wreckId);
  } catch (_err) {
  }
  return 1;
}

function removeRecord(mods, record, wreckId, systemId) {
  if (!isSceneLoaded(mods, toPositiveInt(record.systemID, systemId))) return mods.store.removeNativeWreckCascade(wreckId);
  const result = mods.wreckService.destroyNativeWreck(wreckId, { broadcast: true });
  if (result && (result.success === true || result.errorMsg === "WRECK_NOT_FOUND")
    && typeof mods.store.forgetTag === "function") {
    try {
      mods.store.forgetTag(wreckId);
    } catch (_err) {
    }
  }
  return result;
}

function placeWreckFrom(mods, spec) {
  const invalid = validatePlaceSpec(spec);
  if (invalid) return fail("SPEC_INVALID", invalid, 0);
  const built = spec.rewardLoot ? buildRewardLootTable(spec.rewardLoot) : null;
  if (built && !built.ok) return fail("SPEC_INVALID", "rewardLoot", 0);
  const checked = checkModsFrom(mods);
  if (!checked.ok) return fail(checked.reason, checked.detail, 0);

  let vendorWrites = 0;
  let wreckId = 0;
  try {
    const fixed = [];
    for (const entry of spec.fixedItems || []) {
      const itemType = mods.typeRegistry.resolveItemByTypeID(entry.typeId);
      if (!itemType || toPositiveInt(itemType.typeID, 0) !== entry.typeId) {
        return fail("SPEC_INVALID", "fixedItems", 0);
      }
      fixed.push({ itemType, quantity: entry.quantity });
    }

    const summary = mods.dungeonRuntime.findInstanceBySiteKey(spec.siteKey);
    if (!summary) return fail("SITE_NOT_ACTIVE", "missing", 0);
    if (!isOwnSummary(summary, spec.siteKey)) return fail("SITE_NOT_ACTIVE", "foreign", 0);
    const lifecycleState = String(summary.lifecycleState || "").toLowerCase();
    if (!ACTIVE_STATES.has(lifecycleState)) return fail("SITE_NOT_ACTIVE", lifecycleState || "state", 0);
    const siteId = toPositiveInt(summary.metadata && summary.metadata.siteID, 0);
    if (siteId <= 0) return fail("SITE_NOT_ACTIVE", "siteID", 0);
    const instanceId = toPositiveInt(summary.instanceID, 0);
    if (instanceId <= 0) return fail("SITE_NOT_ACTIVE", "instanceID", 0);
    if (toPositiveInt(summary.solarSystemID, 0) !== spec.systemId) return fail("SITE_NOT_ACTIVE", "system", 0);
    if (!isVec3(summary.position)) return fail("SITE_NOT_ACTIVE", "position", 0);

    for (const record of spec.adopt === false ? [] : mods.store.listNativeWrecks()) {
      if (!record || record[TAG_ANOMALY] !== spec.anomalyId || record[TAG_SLOT] !== spec.slot) continue;
      const adoptedId = toPositiveInt(record.wreckID, 0);
      if (toPositiveInt(record.dungeonSiteInstanceID, 0) === instanceId) {
        return {
          ok: true,
          adopted: true,
          wreckId: adoptedId,
          items: mods.store.listNativeWreckItemsForWreck(adoptedId).length,
          factionItems: 0,
          spawned: false,
          vendorWrites: 0,
        };
      }
      if (adoptedId > 0) {
        vendorWrites += 1;
        const stale = removeRecord(mods, record, adoptedId, spec.systemId);
        if (!stale || stale.success !== true) {
          return fail("WRITE_FAILED", (stale && stale.errorMsg) || "stale wreck", vendorWrites);
        }
      }
    }

    const wreckType = resolveWreckTypeFrom(mods, spec);
    if (!wreckType) {
      return fail("WRECK_TYPE_NOT_FOUND", spec.shipTypeId > 0 ? `ship ${spec.shipTypeId}` : spec.hullGroup,
        vendorWrites);
    }

    const idResult = mods.store.allocateWreckID({ transient: false });
    if (!idResult || idResult.success !== true || !toPositiveInt(idResult.data, 0)) {
      return fail("WRITE_FAILED", (idResult && idResult.errorMsg) || "allocateWreckID", vendorWrites);
    }
    const allocatedId = toPositiveInt(idResult.data, 0);
    const record = buildWreckRecord(allocatedId, spec, wreckType,
      { siteId, instanceId, position: summary.position }, built ? built.table.lootTableID : (spec.lootTableId || null));
    vendorWrites += 1;
    const written = mods.store.upsertNativeWreck(record, { transient: false });
    if (!written || written.success !== true) {
      return fail("WRITE_FAILED", (written && written.errorMsg) || "upsertNativeWreck", vendorWrites);
    }
    wreckId = allocatedId;

    let items = 0;
    let factionItems = 0;
    const lootTable = built ? built.table
      : (spec.lootTableId && spec.lootRolls > 0 ? mods.npcData.getNpcLootTable(spec.lootTableId) : null);
    for (let roll = 0; lootTable && roll < spec.lootRolls; roll += 1) {
      let entries;
      if (roll > 0) entries = mods.npcLoot.rollNpcLootEntries(lootTable, { extraRoll: true });
      else if (spec.lootSourceNpcTypeId > 0) {
        entries = mods.npcLoot.rollNpcLootEntries(lootTable, { source: { npcTypeID: spec.lootSourceNpcTypeId } });
      } else entries = mods.npcLoot.rollNpcLootEntries(lootTable);
      for (const entry of Array.isArray(entries) ? entries : []) {
        const copyCount = entry && Number(entry.singleton) === 2 ? Math.max(1, toPositiveInt(entry.quantity, 1)) : 1;
        for (let index = 0; index < copyCount; index += 1) {
          const itemResult = buildWreckItemRecord(mods, record, entry && entry.itemType, {
            quantity: entry && entry.quantity,
            singleton: entry && entry.singleton,
            blueprintState: entry && ((entry.blueprintStates && entry.blueprintStates[index]) || entry.blueprintState),
            sourceKind: "loot",
          });
          if (!itemResult || itemResult.success !== true || !itemResult.data) {
            vendorWrites += cascadeQuietly(mods, wreckId);
            return fail("WRITE_FAILED", (itemResult && itemResult.errorMsg) || "allocateWreckItemID", vendorWrites);
          }
          vendorWrites += 1;
          const itemWrite = mods.store.upsertNativeWreckItem(itemResult.data, { transient: false });
          if (!itemWrite || itemWrite.success !== true) {
            vendorWrites += cascadeQuietly(mods, wreckId);
            return fail("WRITE_FAILED", (itemWrite && itemWrite.errorMsg) || "upsertNativeWreckItem", vendorWrites);
          }
          items += 1;
          const itemName = (entry && entry.name) || (entry && entry.itemType && entry.itemType.name);
          if (built && isFactionRewardName(itemName, spec.rewardLoot)) factionItems += 1;
        }
      }
    }

    for (const entry of fixed) {
      const itemResult = buildWreckItemRecord(mods, record, entry.itemType, { quantity: entry.quantity,
        singleton: false, sourceKind: "loot" });
      if (!itemResult || itemResult.success !== true || !itemResult.data) {
        vendorWrites += cascadeQuietly(mods, wreckId);
        return fail("WRITE_FAILED", (itemResult && itemResult.errorMsg) || "allocateWreckItemID", vendorWrites);
      }
      vendorWrites += 1;
      const itemWrite = mods.store.upsertNativeWreckItem(itemResult.data, { transient: false });
      if (!itemWrite || itemWrite.success !== true) {
        vendorWrites += cascadeQuietly(mods, wreckId);
        return fail("WRITE_FAILED", (itemWrite && itemWrite.errorMsg) || "upsertNativeWreckItem", vendorWrites);
      }
      items += 1;
    }

    let spawned = false;
    if (isSceneLoaded(mods, spec.systemId)) {
      vendorWrites += 1;
      try {
        const spawn = mods.wreckService.spawnNativeWreck(spec.systemId, wreckId, { broadcast: true });
        spawned = Boolean(spawn && spawn.success === true);
      } catch (_err) {
        spawned = false;
      }
    }
    return { ok: true, adopted: false, wreckId, items, factionItems, spawned, vendorWrites };
  } catch (err) {
    if (wreckId > 0) vendorWrites += cascadeQuietly(mods, wreckId);
    return fail("WRITE_FAILED", messageOf(err), vendorWrites);
  }
}

function removeWreckFrom(mods, anomalyId, wreckId, systemId) {
  if (typeof anomalyId !== "string" || anomalyId === "") return fail("WRITE_FAILED", "anomalyId");
  if (!Number.isSafeInteger(wreckId) || wreckId <= 0) return fail("WRITE_FAILED", "wreckId");
  if (!Number.isSafeInteger(systemId) || systemId <= 0) return fail("WRITE_FAILED", "systemId");
  const checked = checkModsFrom(mods);
  if (!checked.ok) return fail("WRITE_FAILED", checked.detail);
  try {
    const record = readWreckRecord(mods, wreckId);
    if (!record) return { ok: true, gone: true, vendorWrites: 0 };
    if (record[TAG_ANOMALY] !== anomalyId) return fail("FOREIGN", `wreck ${wreckId}`);
    const result = removeRecord(mods, record, wreckId, systemId);
    if (result && result.success === true) return { ok: true, gone: false, vendorWrites: 1 };
    if (result && result.errorMsg === "WRECK_NOT_FOUND") return { ok: true, gone: true, vendorWrites: 1 };
    return fail("WRITE_FAILED", (result && result.errorMsg) || "remove");
  } catch (err) {
    return fail("WRITE_FAILED", messageOf(err));
  }
}

function flushWrecksFrom(mods) {
  const gameStore = mods && mods.gameStore;
  const table = mods && mods.store && mods.store.TABLE;
  if (!gameStore || typeof gameStore.flushTableSync !== "function" || !table) return { ok: true, durable: null };
  const lost = () => ({ ok: true, durable: false });
  try {
    return flushTableThen(gameStore, table.WRECKS, (wrecks) => flushTableThen(gameStore, table.WRECK_ITEMS,
      (items) => ({ ok: true, durable: Boolean(wrecks && wrecks.success === true && items && items.success === true) }),
      lost), lost);
  } catch (_err) {
    return { ok: true, durable: false };
  }
}

function nonNegativeIntOf(value) {
  const numeric = Math.trunc(Number(value) || 0);
  return numeric >= 0 ? numeric : -1;
}

function hasRows(value) {
  return Array.isArray(value) && value.length > 0;
}

function isAlwaysEmptyLootTable(table) {
  if (!table || typeof table !== "object") return false;
  if (String(table.baseRuleID || table.baseLootTableID || "").trim() !== "") return false;
  if (String(table.mode || "").trim().toLowerCase() === "rule" || Array.isArray(table.selectors)) return false;
  if (hasRows(table.entries) || hasRows(table.guaranteedEntries) || hasRows(table.requiredDrops)) return false;
  return table.disableRandomLoot === true
    || (nonNegativeIntOf(table.minEntries) === 0 && nonNegativeIntOf(table.maxEntries) === 0);
}

function isRandomAnyLootTable(table) {
  if (!table || typeof table !== "object" || table.emptyRule === true) return false;
  if (String(table.baseRuleID || table.baseLootTableID || "").trim() !== "") return false;
  if (String(table.mode || "").trim().toLowerCase() === "rule" || Array.isArray(table.selectors)) return false;
  if (hasRows(table.entries) || hasRows(table.guaranteedEntries)) return false;
  if (table.disableRandomLoot === true) return false;
  return !(nonNegativeIntOf(table.minEntries) === 0 && nonNegativeIntOf(table.maxEntries) === 0);
}

function checkLootTablesFrom(mods, ids) {
  try {
    const getTable = mods && mods.npcData && mods.npcData.getNpcLootTable;
    if (typeof getTable !== "function") return fail("CHECK_FAILED", "getNpcLootTable_missing");
    const missing = [];
    const randomAny = [];
    for (const id of Array.isArray(ids) ? ids : []) {
      if (typeof id !== "string" || id === "") continue;
      const table = mods.npcData.getNpcLootTable(id);
      if (!table || table.emptyRule === true || isAlwaysEmptyLootTable(table)) missing.push(id);
      else if (isRandomAnyLootTable(table)) randomAny.push(id);
    }
    return { ok: true, missing, randomAny };
  } catch (err) {
    return fail("CHECK_FAILED", messageOf(err));
  }
}

function checkWreckNamesFrom(mods, names) {
  try {
    const registry = mods && mods.typeRegistry;
    if (!registry || typeof registry.resolveItemByName !== "function") {
      return fail("CHECK_FAILED", "resolveItemByName_missing");
    }
    const missing = [];
    for (const name of Array.isArray(names) ? names : []) {
      if (typeof name !== "string" || name === "") continue;
      const lookup = registry.resolveItemByName(name, { exactOnly: true });
      if (!lookup || lookup.success !== true || !isWreckType(lookup.match)) missing.push(name);
    }
    return { ok: true, missing };
  } catch (err) {
    return fail("CHECK_FAILED", messageOf(err));
  }
}

function isPlayerShip(entity) {
  if (!entity || entity.kind !== "ship" || !entity.position) return false;
  return toPositiveInt(entity.charID, 0) > 0 || toPositiveInt(entity.characterID, 0) > 0;
}

function readGridFrom(mods, systemId, wreckIds, center, rangeM) {
  if (!Number.isSafeInteger(systemId) || systemId <= 0) return fail("READ_FAILED", "systemId");
  if (!Array.isArray(wreckIds)) return fail("READ_FAILED", "wreckIds");
  if (center !== null && !isVec3(center)) return fail("READ_FAILED", "center");
  if (typeof rangeM !== "number" || !Number.isFinite(rangeM) || rangeM < 0) return fail("READ_FAILED", "rangeM");
  try {
    if (!isSceneLoaded(mods, systemId)) return { ok: true, sceneLoaded: false };
    const scenes = mods.runtime.scenes;
    const scene = scenes && typeof scenes.get === "function" ? scenes.get(systemId) : null;
    if (!scene || typeof scene.getEntityByID !== "function") return { ok: true, sceneLoaded: false };
    const wrecks = [];
    for (const id of wreckIds) {
      if (!Number.isSafeInteger(id) || id <= 0) continue;
      const entity = scene.getEntityByID(id);
      wrecks.push({ wreckId: id, inScene: Boolean(entity), isEmpty: entity ? entity.isEmpty === true : null });
    }
    let playerOnGrid = false;
    let playerCharacterId = null;
    if (center !== null && scene.dynamicEntities && typeof scene.dynamicEntities.values === "function") {
      const rangeSq = rangeM * rangeM;
      for (const entity of scene.dynamicEntities.values()) {
        if (!isPlayerShip(entity)) continue;
        const dx = toFiniteNumber(entity.position.x) - center.x;
        const dy = toFiniteNumber(entity.position.y) - center.y;
        const dz = toFiniteNumber(entity.position.z) - center.z;
        if (dx * dx + dy * dy + dz * dz <= rangeSq) {
          playerOnGrid = true;
          playerCharacterId = toPositiveInt(entity.charID, 0) || toPositiveInt(entity.characterID, 0) || null;
          break;
        }
      }
    }
    return { ok: true, sceneLoaded: true, playerOnGrid, playerCharacterId, wrecks };
  } catch (err) {
    return fail("READ_FAILED", messageOf(err));
  }
}

function createNativeWrecksFacade(mods) {
  return {
    ok: true,
    listOwn: (anomalyId) => listOwnWrecksFrom(mods, anomalyId),
    getOwn: (anomalyId, wreckIds) => getOwnWrecksFrom(mods, anomalyId, wreckIds),
    place: (spec) => placeWreckFrom(mods, spec),
    remove: (anomalyId, wreckId, systemId) => removeWreckFrom(mods, anomalyId, wreckId, systemId),
    flush: () => flushWrecksFrom(mods),
    checkLootTables: (ids) => checkLootTablesFrom(mods, ids),
    checkWreckNames: (names) => checkWreckNamesFrom(mods, names),
    readGrid: (systemId, wreckIds, center, rangeM) => readGridFrom(mods, systemId, wreckIds, center, rangeM),
  };
}

module.exports = {
  LOOT_RIGHTS_SNAPSHOT_VERSION,
  WRECK_CONDITION_STATE,
  TAG_ANOMALY,
  TAG_SLOT,
  FIXED_ITEMS_MAX,
  FIXED_ITEM_MAX_QUANTITY,
  FACADE_METHODS,
  MODULE_PATHS,
  GAME_STORE_PATH,
  REQUIRED_FUNCTIONS,
  checkModsFrom,
  loadModsFrom,
  buildWreckRecord,
  buildWreckItemRecord,
  validatePlaceSpec,
  listOwnWrecksFrom,
  getOwnWrecksFrom,
  placeWreckFrom,
  removeWreckFrom,
  flushWrecksFrom,
  checkLootTablesFrom,
  isRandomAnyLootTable,
  checkWreckNamesFrom,
  readGridFrom,
  createNativeWrecksFacade,
};
