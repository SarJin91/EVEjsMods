"use strict";

const { twinShipItem } = require("../twinDogma");

function twinWeaponSnapshot(deps, twin, module, charge) {
  if (!module) return null;
  const shipItem = twinShipItem(twin, deps);
  if (!shipItem) return null;
  const snapshot = deps.buildWeaponSnapshotForEntity(twin, module, charge, {
    shipItem,
    fittedItems: twin.fittedItems,
    skillMap: twin.skillMap,
    activeModuleContexts: [],
    additionalLocationModifierSources: deps.getLocationModifierSourcesForSystem(twin.systemID),
  });
  return snapshot !== null && typeof snapshot === "object" ? snapshot : null;
}

module.exports = { twinWeaponSnapshot };
