"use strict";

const BLUEPRINT_CATEGORY_ID = 9;

function toPositiveInt(value, fallback = 0) {
  const numeric = Math.trunc(Number(value));
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : fallback;
}

function copyKind(record, readMarker) {
  if (!record) return null;
  if (Number(record.singleton) === 2) return "native";
  if (record.singleton === true && toPositiveInt(record.categoryID) === BLUEPRINT_CATEGORY_ID &&
      typeof readMarker === "function" && readMarker(record)) return "marker";
  return null;
}

function resolveCopyState(kind, record, itemType, wreckID, bp, readMarker) {
  const type = { ...(itemType || {}), typeID: toPositiveInt(record.typeID), name: String(record.itemName || ""), categoryID: BLUEPRINT_CATEGORY_ID };
  const source = { kind: "native-wreck", seed: `native-wreck-blueprint:${wreckID}:${toPositiveInt(record.wreckItemID)}:salvage` };
  try {
    if (kind === "marker") {
      const spec = readMarker(record) || {};
      return bp.buildBlueprintCopyState({ runsRemaining: spec.runs, materialEfficiency: spec.me, timeEfficiency: spec.te });
    }
    return bp.resolveBlueprintLootCopyState(type, record.blueprintState || record, source);
  } catch (_error) {
    return bp.resolveBlueprintLootCopyState(type, {}, source);
  }
}

// Port of the vendor loop (salvageItemCustody.js:40-118) with copies.
function transferWithCopies(wreckRecord, containerID, fallbackOwnerID, contents, deps) {
  const wreckID = toPositiveInt(wreckRecord && wreckRecord.wreckID);
  const changes = [];
  const removedSourceRecords = [];
  const copyItemIDs = [];
  const fail = (errorMsg) => {
    for (const itemID of copyItemIDs) {
      try { deps.industry.removeBlueprintState(itemID); } catch (_error) {}
    }
    return { success: false, errorMsg: errorMsg || "LOOT_TRANSFER_FAILED", changes, removedSourceRecords };
  };
  try {
    for (const itemRecord of contents) {
      const kind = copyKind(itemRecord, deps.readMarker);
      const typeID = toPositiveInt(itemRecord && itemRecord.typeID);
      const itemType = deps.resolveItemByTypeID(typeID) || { typeID, name: String(itemRecord && itemRecord.itemName || "Item") };
      const state = kind ? resolveCopyState(kind, itemRecord, itemType, wreckID, deps.blueprintRewardState, deps.readMarker) : null;
      const singleton = state ? 2 : (itemRecord && itemRecord.singleton === true) || kind ? 1 : 0;
      const quantity = singleton ? 1 : Math.max(1, toPositiveInt(itemRecord && itemRecord.quantity, 1));
      const ownerID = toPositiveInt((itemRecord && itemRecord.ownerID) || fallbackOwnerID);
      let grant;
      try {
        grant = deps.itemStore.grantItemsToOwnerLocation(ownerID, containerID, deps.itemStore.ITEM_FLAGS.HANGAR, [{
          itemType,
          quantity,
          options: {
            singleton,
            itemName: String(itemRecord && itemRecord.itemName || itemType.name || "Item"),
            customInfo: String(itemRecord && itemRecord.customInfo || ""),
            moduleState: itemRecord && itemRecord.moduleState ? JSON.parse(JSON.stringify(itemRecord.moduleState)) : undefined,
          },
        }]);
      } catch (error) {
        return fail(String(error && error.message || "").trim() || "LOOT_TRANSFER_FAILED");
      }
      if (!grant || !grant.success || !grant.data) return fail(grant && grant.errorMsg);
      changes.push(...(grant.data.changes || []));
      if (state) {
        const items = Array.isArray(grant.data.items) ? grant.data.items : [];
        copyItemIDs.push(...items.map((item) => toPositiveInt(item && item.itemID)).filter(Boolean));
        const written = deps.blueprintRewardState.ensureGrantedBlueprintCopyState(items, state);
        if (!written || written.success !== true) return fail(written && written.errorMsg || "BLUEPRINT_COPY_STATE_FAILED");
      }
    }
    for (const itemRecord of contents) {
      let removed;
      try {
        removed = deps.nativeNpcStore.removeNativeWreckItem(toPositiveInt(itemRecord && itemRecord.wreckItemID));
      } catch (error) {
        return fail(String(error && error.message || "").trim() || "LOOT_TRANSFER_FAILED");
      }
      if (!removed || removed.success !== true) return fail(removed && removed.errorMsg);
      removedSourceRecords.push(JSON.parse(JSON.stringify(itemRecord)));
    }
  } catch (error) {
    return fail(String(error && error.message || "").trim() || "LOOT_TRANSFER_FAILED");
  }
  return { success: true, changes, removedSourceRecords, copies: copyItemIDs.length };
}

function createSalvageCopiesWrapper(orig, getDeps, onCopies = null) {
  return function transferNativeWreckLootToContainerWithCopies(wreckRecord, containerID, fallbackOwnerID = 0) {
    let deps = null;
    let contents = null;
    try {
      deps = getDeps();
      contents = deps.nativeNpcStore.listNativeWreckItemsForWreck(toPositiveInt(wreckRecord && wreckRecord.wreckID));
    } catch (_error) {
      contents = null;
    }
    if (!Array.isArray(contents) || !contents.some((record) => copyKind(record, deps.readMarker))) {
      return orig.apply(this, arguments);
    }
    const result = transferWithCopies(wreckRecord, containerID, fallbackOwnerID, contents, deps);
    if (result.success && typeof onCopies === "function") {
      try { onCopies(result.copies, toPositiveInt(wreckRecord && wreckRecord.wreckID)); } catch (_error) {}
    }
    if (result.success) delete result.copies;
    return result;
  };
}

module.exports = { copyKind, transferWithCopies, createSalvageCopiesWrapper };
