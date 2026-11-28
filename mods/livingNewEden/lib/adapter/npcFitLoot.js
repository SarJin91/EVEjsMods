"use strict";

const profiles = require("./data/liveProfiles");

const LIVING_OPERATORS = new Set([
  profiles.LIVE_OPERATOR_KIND, profiles.LIVE_DUEL_OPERATOR_KIND, profiles.TRAFFIC_OPERATOR_KIND,
  profiles.BOUNTY_OPERATOR_KIND, profiles.SITUATION_OPERATOR_KIND, profiles.HEAVY_OPERATOR_KIND,
]);
const CARGO_FLAG = 5;
let activeDeath = null;

function installLootRoll(npcLoot) {
  const roll = npcLoot.rollNpcLootEntries;
  npcLoot.rollNpcLootEntries = function rollWithLivingFit(table, options) {
    const entries = roll.apply(this, arguments);
    const death = activeDeath;
    const source = options?.source;
    if (!death || death.applied || source?.npcTypeID !== death.typeId ||
        source.profileID !== death.profileId) return entries;
    death.applied = true;
    return [...entries, ...death.drops];
  };
}

function snapshot(ship, loadGame) {
  const store = loadGame("space/npc/nativeNpcStore");
  const record = store.getNativeEntity(ship.itemID);
  if (!record || record.transient !== true) return null;
  const { resolveItemByTypeID } = loadGame("services/inventory/itemTypeRegistry");
  const { resolveStackDropCounts } = loadGame("services/killmail/deathOutcomeResolver");
  const death = { typeId: Number(ship.typeID), profileId: record.profileID, drops: [], items: [], applied: false };
  for (const module of store.buildNativeFittedItems(ship.itemID)) {
    const itemType = resolveItemByTypeID(module.typeID);
    if (!itemType || itemType.published === false || ![7, 32].includes(Number(itemType.categoryID)) ||
        !(module.itemID > 0) || !(module.flagID > CARGO_FLAG)) continue;
    const counts = resolveStackDropCounts({ itemID: module.itemID, flag: module.flagID, quantity: 1 },
      `lne-fit:${ship.systemID}:${ship.itemID}`);
    death.items.push({ typeID: module.typeID, flag: module.flagID, singleton: 1, ...counts, contents: [] });
    if (counts.qtyDropped > 0) {
      death.drops.push({ itemType, typeID: module.typeID, name: itemType.name, quantity: 1, singleton: true });
    }
  }
  return death.items.length > 0 ? death : null;
}

function killmailItems(death, wreckItems) {
  const fittedDrops = new Map();
  for (const { typeID } of death.drops) fittedDrops.set(typeID, (fittedDrops.get(typeID) || 0) + 1);
  const items = [...death.items];
  for (const row of wreckItems) {
    const typeID = Number(row.typeID);
    let qtyDropped = Number(row.quantity) || 0;
    const singleton = Number(row.singleton) || 0;
    // Cargo has its own source marker. A fitted drop enters the native loot
    // manifest as a singleton, so account for it only in its original slot.
    if (row.sourceKind === "loot" && singleton === 1 && qtyDropped === 1 && fittedDrops.get(typeID) > 0) {
      fittedDrops.set(typeID, fittedDrops.get(typeID) - 1);
      qtyDropped = 0;
    }
    if (qtyDropped > 0) items.push({ typeID, flag: CARGO_FLAG, singleton,
      qtyDropped, qtyDestroyed: 0, contents: [] });
  }
  return items;
}

function installDestruction(wrecks, loadGame, logger) {
  const destroy = wrecks.destroyNativeNpcEntityWithWreck;
  wrecks.destroyNativeNpcEntityWithWreck = function destroyWithLivingFit(systemId, ship) {
    let death = null;
    if (ship?.kind === "ship" && LIVING_OPERATORS.has(ship.operatorKind)) {
      try {
        death = snapshot(ship, loadGame);
      } catch (error) {
        logger.logError("npcFitLoot: could not read fitted modules", error);
      }
    }
    const parent = activeDeath;
    activeDeath = death;
    try {
      const result = destroy.apply(this, arguments);
      if (death?.applied && result?.success && !result.duplicate && result.data?.wreck &&
          Array.isArray(result.data.wreckItems)) {
        result.data.lootOutcome = { items: killmailItems(death, result.data.wreckItems) };
      }
      return result;
    } finally {
      activeDeath = parent;
    }
  };
}

module.exports = { installLootRoll, installDestruction };
