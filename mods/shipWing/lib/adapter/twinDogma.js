"use strict";

function toInt(value, fallback = 0) {
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) ? n : fallback;
}

function twinShipItem(twin, deps) {
  return (twin && deps.buildRuntimeShipItemFromEntity(twin)) || null;
}

function twinModule(twin, moduleID, moduleFlagID) {
  const id = toInt(moduleID, 0);
  const flag = toInt(moduleFlagID, 0);
  const fitted = Array.isArray(twin && twin.fittedItems) ? twin.fittedItems : [];
  return fitted.find((m) => (id > 0 && toInt(m && m.itemID, 0) === id)
    || (flag > 0 && toInt(m && m.flagID, 0) === flag)) || null;
}

function twinCharge(twin, moduleItem) {
  const id = toInt(moduleItem && moduleItem.itemID, 0);
  const cargo = Array.isArray(twin && twin.nativeCargoItems) ? twin.nativeCargoItems : [];
  return id > 0 ? cargo.find((item) => toInt(item && item.moduleID, 0) === id) || null : null;
}

function miningSnapshotInput(twin, ownerCharacterId, moduleItem, effectRecord, nowMs, deps) {
  const shipItem = twinShipItem(twin, deps);
  const resolved = twinModule(twin, moduleItem && moduleItem.itemID, moduleItem && moduleItem.flagID) || moduleItem;
  if (!shipItem || !resolved) return null;
  const chargeItem = twinCharge(twin, resolved);
  return {
    characterID: ownerCharacterId,
    shipItem,
    moduleItem: resolved,
    effectRecord,
    chargeItem,
    fittedItems: Array.isArray(twin.fittedItems) ? twin.fittedItems : [],
    skillMap: twin.skillMap instanceof Map ? twin.skillMap : new Map(),
    activeModuleContexts: [],
    additionalModifierEntries: deps.collectModifierEntriesForItem(twin, resolved, nowMs),
    additionalChargeModifierEntries: chargeItem ? deps.collectModifierEntriesForItem(twin, chargeItem, nowMs) : [],
    additionalLocationModifierSources: deps.getLocationModifierSourcesForSystem(twin.systemID),
  };
}

function crystalBurnedOut(chargeItem, snapshot, deps) {
  if (!chargeItem || !snapshot) return false;
  return Boolean(deps.isCrystalBurnedOut(chargeItem,
    deps.buildCrystalDurabilitySnapshot(snapshot.chargeTypeID, snapshot.chargeAttributes)));
}

module.exports = { twinShipItem, twinModule, twinCharge, miningSnapshotInput, crystalBurnedOut };
