"use strict";

function sym(name, kind, consumer, extra = {}) {
  return Object.freeze({ name, kind, consumer, ...extra });
}

function mod(path, symbols) {
  return Object.freeze({ path, symbols: Object.freeze(symbols) });
}

const SHIP_SERVICE_GUARDED = Object.freeze([
  "Handle_LaunchFromContainer", "Handle_BoardStoredShip", "Handle_Board", "Handle_StoreVessel",
  "Handle_FitShips", "Handle_AssembleShip", "Handle_ActivateShip",
]);
const INV_BROKER_GUARDED = Object.freeze([
  "Handle_Add", "Handle_MultiAdd", "Handle_MultiMerge", "Handle_StackAll", "Handle_TrashItems",
  "Handle_FitFitting", "Handle_DestroyFitting", "Handle_DeliverToCorpHangar",
]);

const GAME_MODULES = Object.freeze([
  mod("../bootstrap", [
    sym("bootWorld", "export", "core", { firstLoad: true, wrap: true }),
    sym("PRODUCTION_STAGES", "export", "core", { valueType: "object" }),
  ]),
  mod("services/exploration/wormholes/wormholeRuntimeState", [
    sym("mutateState", "export", "core", { firstLoad: true }),
  ]),
  mod("space/runtime", [
    sym("spawnDynamicShip", "prototypeMethod", "spawn"),
    sym("getSceneForSession", "prototypeMethod", "spawn"),
    sym("isSolarSystemSceneLoaded", "prototypeMethod", "spawn"),
    sym("ensureScene", "prototypeMethod", "spawn"),
    sym("scenes", "property", "spawn"),
  ]),
  mod("space/runtime/runtimeEntityIdentity", [
    sym("allocateRuntimeEntityID", "export", "spawn"),
  ]),
  mod("space/runtime/scene/pilotCommands", [
    sym("followShipEntity", "export", "spawn"),
  ]),
  mod("space/runtime/scene/dynamicEntities", [
    sym("removeDynamicEntity", "export", "spawn"),
    sym("spawnDynamicEntity", "export", "spawn"),
  ]),
  mod("services/inventory/itemStore", [
    sym("ITEM_FLAGS", "export", "spawn", { valueType: "object" }),
    sym("listContainerItems", "export", "spawn"),
    sym("findItemById", "export", "spawn"),
    sym("updateShipItem", "export", "loss"),
    sym("normalizeShipConditionState", "export", "loss"),
  ]),
  mod("space/shipDestruction", [
    sym("destroyShipEntityWithWreck", "export", "loss", { wrap: true }),
  ]),
  mod("services/killmail/deathOutcomeResolver", [
    sym("resolveLocationDeathOutcome", "export", "loss"),
  ]),
  mod("services/inventory/deathItemCustody", [
    sym("destroyItem", "export", "loss"),
  ]),
  mod("services/character/characterState", [
    sym("getActiveShipRecord", "export", "loss"),
    sym("emitItemsChangedBatchForSession", "export", "loss"),
  ]),
  mod("space/worldData", [
    sym("getSolarSystemByID", "export", "loss"),
  ]),
  mod("services/fitting/liveFittingState", [
    sym("listFittedItemsForLocation", "export", "spawn"),
    sym("isFittedModuleItem", "export", "spawn"),
    sym("isFittedChargeItem", "export", "spawn"),
    sym("getMissingRequiredSkills", "export", "spawn"),
  ]),
  mod("services/skills/skillState", [
    sym("getCachedCharacterSkillMap", "export", "spawn"),
  ]),
  mod("services/inventory/itemTypeRegistry", [
    sym("resolveItemByTypeID", "export", "spawn"),
  ]),
  mod("services/chat/sessionRegistry", [
    sym("findSessionByCharacterID", "export", "spawn"),
  ]),
  mod("services/ship/shipService", SHIP_SERVICE_GUARDED
    .map((name) => sym(name, "classPrototypeMethod", "guards", { wrap: true }))),
  mod("services/inventory/invBrokerService", [
    ...INV_BROKER_GUARDED.map((name) => sym(name, "classPrototypeMethod", "guards", { wrap: true })),
    sym("_getBoundContext", "classPrototypeMethod", "guards"),
  ]),
  mod("_secondary/chat/chatRuntime", [
    sym("broadcastLocalMessage", "export", "chat", { wrap: true }),
  ]),
  mod("common/machoErrors", [
    sym("throwWrappedUserError", "export", "guards"),
  ]),
  mod("services/baseService", [
    sym("callMethod", "classPrototypeMethod", "clientWindow"),
  ]),
  mod("services/serviceManager", [
    sym("register", "classPrototypeMethod", "clientWindow"),
    sym("lookup", "classPrototypeMethod", "clientWindow"),
  ]),
  mod("space/runtime/solarSystemScene", [
    sym("refreshShipEntityDerivedState", "exportClassPrototypeMethod", "tasks",
      { exportName: "SolarSystemScene", wrap: true }),
    ...["finalizeTargetLock", "getTargetsForEntity", "orbitShipEntity", "followShipEntity", "stopShipEntity",
      "activateGenericModule", "deactivateGenericModule", "getCurrentSimTimeMs",
      "removeLockedTarget", "cancelPendingTargetLock", "getSortedPendingTargetLocks", "getEntityTargetingStats",
      "getGridBubbleIDForPosition", "getStaticEntitiesInBubble",
      "getEntityByID"]
      .map((name) => sym(name, "exportClassPrototypeMethod", "twinControl", { exportName: "SolarSystemScene" })),
    sym("getEntitySurfaceDistance", "exportClassPrototypeMethod", "twinControl",
      { exportName: "SolarSystemScene", optional: true }),
  ]),
  mod("space/runtime/solarSystemScene", [
    sym("getEntityByID", "exportClassPrototypeMethod", "spawn", { exportName: "SolarSystemScene" }),
    sym("getEntitySurfaceDistance", "exportClassPrototypeMethod", "spawn",
      { exportName: "SolarSystemScene", optional: true }),
    sym("broadcastSlimItemChanges", "exportClassPrototypeMethod", "spawn",
      { exportName: "SolarSystemScene", optional: true }),
    sym("getEntityByID", "exportClassPrototypeMethod", "mining", { exportName: "SolarSystemScene" }),
    sym("getEntitySurfaceDistance", "exportClassPrototypeMethod", "mining",
      { exportName: "SolarSystemScene", optional: true }),
  ]),
  mod("services/mining/miningRuntime", [
    ...["resolveMiningActivation", "prepareMiningCycleBoundary", "executeMiningCycle"]
      .map((name) => sym(name, "export", "mining", { wrap: true })),
    sym("isMiningSnapshotCompatibleWithState", "export", "mining"),
  ]),
  mod("space/runtime/entityDogmaView", [
    sym("buildRuntimeShipItemFromEntity", "export", "mining"),
  ]),
  mod("services/mining/miningDogma", [
    sym("buildMiningModuleSnapshot", "export", "mining"),
    sym("isMiningEffectRecord", "export", "mining"),
    sym("resolveMiningFamily", "export", "mining"),
  ]),
  mod("services/mining/miningMath", [
    sym("computeMiningResult", "export", "mining"),
  ]),
  mod("services/mining/miningRuntimeState", [
    sym("getMineableState", "export", "mining"),
    sym("applyMiningDelta", "export", "mining"),
    sym("ensureSceneMiningState", "export", "mining"),
    sym("isMineableStaticEntity", "export", "mining"),
  ]),
  mod("services/mining/miningInventory", [
    sym("getPreferredMiningHoldFlagForType", "export", "mining"),
    sym("getShipHoldCapacityByFlag", "export", "mining"),
    sym("isItemTypeAllowedInHoldFlag", "export", "mining"),
  ]),
  mod("services/mining/miningLedgerState", [
    sym("recordMiningLedgerEvent", "export", "mining"),
  ]),
  mod("services/mining/airMiningSettlement", [
    sym("isAirRock", "export", "mining"),
  ]),
  mod("space/destiny/identity/interactionScope", [
    sym("canEntitiesInteractLocally", "export", "mining"),
  ]),
  mod("space/modules/commandBurstRuntime", [
    sym("collectModifierEntriesForItem", "export", "mining"),
  ]),
  mod("services/exploration/wormholes/wormholeEnvironmentRuntime", [
    sym("getLocationModifierSourcesForSystem", "export", "mining"),
  ]),
  mod("services/fitting/liveFittingState", [
    ...["buildShipResourceState", "getEffectTypeRecord", "isModuleOnline", "isChargeCompatibleWithModule",
      "getTypeEffectRecords"]
      .map((name) => sym(name, "export", "mining")),
  ]),
  mod("services/inventory/itemStore", [
    sym("ITEM_FLAGS", "export", "mining", { valueType: "object" }),
    ...["grantItemsToCharacterLocation", "listContainerItems", "findItemById"]
      .map((name) => sym(name, "export", "mining")),
  ]),
  mod("services/inventory/fleetHangarInventory", [
    sym("getFleetHangarCapacity", "export", "mining"),
  ]),
  mod("services/dogma/crystalDurability", [
    sym("isCrystalBurnedOut", "export", "mining"),
    sym("buildCrystalDurabilitySnapshot", "export", "mining"),
  ]),
  mod("space/runtime/weaponSnapshot", [
    sym("buildWeaponSnapshotForEntity", "export", "combat"),
  ]),
  mod("space/combat/laserTurrets", [
    sym("resolveTurretShot", "export", "combat"),
  ]),
  mod("space/runtime/targetDamageApplication", [
    sym("applyWeaponDamageToTarget", "export", "combat"),
  ]),
  mod("space/combat/killmailTracker", [
    sym("noteDamage", "export", "combat"),
    sym("enqueueKillmailFromDestruction", "export", "combat"),
  ]),
  mod("space/runtime/combatDamageMessages", [
    sym("getAppliedDamageAmount", "export", "combat"),
  ]),
  mod("space/combat/weaponDogma", [
    ...["resolveWeaponFamily", "isTurretCycleWeaponFamily", "isVortonWeaponFamily", "isChargeOptionalTurretWeapon",
      "resolveWeaponSpecialFxGUID"].map((name) => sym(name, "export", "combat")),
  ]),
  mod("space/combat/precursorTurrets", [
    sym("isPrecursorTurretFamily", "export", "combat"),
  ]),
  mod("space/combat/damage", [
    sym("hasDamageableHealth", "export", "combat"),
  ]),
  mod("space/runtime/combatDestruction", [
    sym("isRuntimeEntityDestroyingOrDestroyed", "export", "combat"),
  ]),
  mod("space/runtime/entityDogmaView", [
    sym("buildRuntimeShipItemFromEntity", "export", "combat"),
  ]),
  mod("services/exploration/wormholes/wormholeEnvironmentRuntime", [
    sym("getLocationModifierSourcesForSystem", "export", "combat"),
  ]),
  mod("services/dogma/crystalDurability", [
    sym("isCrystalBurnedOut", "export", "combat"),
    sym("buildCrystalDurabilitySnapshot", "export", "combat"),
  ]),
  mod("services/fitting/liveFittingState", [
    sym("getTypeDogmaAttributes", "export", "combat"),
    sym("isModuleOnline", "export", "combat"),
  ]),
  mod("services/inventory/itemStore", [
    sym("consumeInventoryItemQuantityIdempotent", "export", "combat"),
    sym("pruneIdempotentGrantReceipts", "export", "combat"),
  ]),
  mod("space/runtime/solarSystemScene", [
    ...["broadcastSpecialFx", "getTargetersForEntity"]
      .map((name) => sym(name, "exportClassPrototypeMethod", "combat", { exportName: "SolarSystemScene",
        optional: true })),
    sym("getEntityByID", "exportClassPrototypeMethod", "combat", { exportName: "SolarSystemScene" }),
  ]),
  mod("space/destiny/identity/interactionScope", [
    sym("canEntitiesInteractLocally", "export", "combat"),
  ]),
  mod("space/runtime/solarSystemScene", [
    sym("launchMissile", "exportClassPrototypeMethod", "combatMissile", { exportName: "SolarSystemScene" }),
  ]),
  mod("space/combat/weaponDogma", [
    sym("isMissileWeaponFamily", "export", "combatMissile"),
    sym("isDefenderMissileWeaponSnapshot", "export", "combatMissile"),
  ]),
  mod("space/combat/precursorTurrets", [
    ...["synchronizePrecursorTurretEffectState", "advancePrecursorTurretSpool", "resetPrecursorTurretSpool",
      "applyPrecursorTurretSpoolToSnapshot", "buildPrecursorTurretGraphicInfo"]
      .map((name) => sym(name, "export", "combatPrecursor")),
  ]),
  mod("space/combat/vortonProjectors", [
    ...["resolveVortonShot", "resolveVortonArcShot", "selectVortonArcTargets"]
      .map((name) => sym(name, "export", "combatVorton")),
  ]),
  mod("space/runtime/moduleSpecialFx", [
    sym("broadcastVortonCycleSpecialFx", "export", "combatVorton", { optional: true }),
  ]),
  mod("space/runtime/solarSystemScene", [
    sym("dynamicEntities", "exportClassInstanceField", "combatVorton", { exportName: "SolarSystemScene" }),
    sym("dynamicEntities", "exportClassInstanceField", "combatAuto", { exportName: "SolarSystemScene" }),
  ]),
  mod("space/modules/smartbombRuntime", [
    ...["isSmartbombEffect", "resolveSmartbombActivation", "executeSmartbombCycle"]
      .map((name) => sym(name, "export", "combatArea")),
  ]),
  mod("space/modules/pointDefenseRuntime", [
    ...["isPointDefenseEffect", "resolvePointDefenseActivation", "executePointDefenseCycle"]
      .map((name) => sym(name, "export", "combatArea")),
  ]),
  mod("space/runtime/moduleRuntimeCallbacks", [
    sym("buildSmartbombRuntimeCallbacks", "export", "combatArea"),
    sym("buildPointDefenseRuntimeCallbacks", "export", "combatArea"),
  ]),
  mod("space/runtime/moduleActivationEffectRecord", [
    sym("resolveDefaultActivationEffect", "export", "combatArea"),
  ]),
  mod("services/security/systemSecurity", [
    sym("isHighSecuritySystem", "export", "combatArea"),
  ]),
  mod("space/runtime/moduleSpecialFx", [
    sym("buildGenericModuleSpecialFxGraphicInfo", "export", "combatArea", { optional: true }),
  ]),
  mod("space/combat/breacherPods", [
    sym("stageLaunch", "export", "combatBreacher"),
    sym("validSnapshot", "export", "combatBreacher"),
    sym("isBreacherPodTarget", "export", "combatBreacher", { optional: true }),
  ]),
  mod("space/runtime/moduleRuntimeCallbacks", [
    sym("buildBombRuntimeCallbacks", "export", "combatBreacher"),
  ]),
  mod("space/modules/bombRuntime", [
    ...["isBombLauncher", "resolveBombLauncherActivation", "executeBombLaunchCycle"]
      .map((name) => sym(name, "export", "combatBomb")),
  ]),
  mod("space/runtime/moduleRuntimeCallbacks", [
    sym("buildBombRuntimeCallbacks", "export", "combatBomb"),
  ]),
  mod("services/drone/entityService", [
    ...["Handle_CmdEngage", "Handle_CmdMineRepeatedly", "Handle_CmdReturnBay", "Handle_CmdReturnHome"]
      .map((name) => sym(name, "classPrototypeMethod", "mirror", { wrap: true })),
  ]),
  mod("services/fighter/fighterMgrService", [
    ...["Handle_CmdActivateAbilitySlots", "Handle_RecallFightersToTubes"]
      .map((name) => sym(name, "classPrototypeMethod", "mirror", { wrap: true })),
  ]),
  mod("space/runtime/solarSystemScene", [
    sym("dynamicEntities", "exportClassInstanceField", "mirror", { exportName: "SolarSystemScene", optional: true }),
  ]),
  mod("space/runtime/passiveDerivedState", [
    sym("buildPassiveShipResourceState", "export", "active"),
  ]),
  mod("space/runtime/activeShipModifiers", [
    ...["resolveActiveShipModifierSourceAttributes", "collectEntityWormholeLocationModifierSources",
      "effectRecordSelfModifiesProjectedAttributes"].map((name) => sym(name, "export", "active")),
  ]),
  mod("services/fitting/liveFittingState", [
    ...["appendDirectModifierEntries", "getAttributeIDByNames", "isModuleOnline"]
      .map((name) => sym(name, "export", "active")),
  ]),
  mod("services/exploration/wormholes/wormholeEnvironmentRuntime", [
    sym("collectShipAttributeModifierEntriesForSystem", "export", "active"),
  ]),
  mod("space/runtime/moduleActivationEffectRecord", [
    sym("resolveDefaultActivationEffect", "export", "active"),
  ]),
  mod("space/modules/liveModuleAttributes", [
    sym("buildLiveModuleAttributeMap", "export", "active"),
  ]),
  mod("space/modules/localCycleRuntime", [
    sym("prepareLocalCycleActivation", "export", "active"),
    sym("executeLocalCycle", "export", "active"),
  ]),
  mod("space/runtime/moduleRuntimeCallbacks", [
    sym("buildLocalCycleRuntimeCallbacks", "export", "active"),
  ]),
  mod("space/modules/assistanceModuleRuntime", [
    sym("resolveAssistanceDefinition", "export", "active"),
  ]),
  mod("space/runtime/propulsionModule", [
    sym("EFFECT_ID_AFTERBURNER", "export", "active", { valueType: "number" }),
    sym("EFFECT_ID_MICROWARPDRIVE", "export", "active", { valueType: "number" }),
    sym("getPropulsionModuleRuntimeAttributes", "export", "active"),
  ]),
  mod("space/runtime/entityDogmaView", [
    sym("buildRuntimeShipItemFromEntity", "export", "active"),
  ]),
  mod("space/runtime/combatDestruction", [
    sym("isRuntimeEntityDestroyingOrDestroyed", "export", "active"),
  ]),
  mod("space/runtime/solarSystemScene", [
    sym("broadcastSpecialFx", "exportClassPrototypeMethod", "active", { exportName: "SolarSystemScene",
      optional: true }),
    sym("getEntityByID", "exportClassPrototypeMethod", "active", { exportName: "SolarSystemScene" }),
  ]),
  mod("space/modules/assistanceModuleRuntime", [
    sym("resolveAssistanceModuleActivation", "export", "logi"),
    sym("executeAssistanceModuleCycle", "export", "logi"),
  ]),
  mod("space/runtime/moduleRuntimeCallbacks", [
    sym("buildAssistanceModuleRuntimeCallbacks", "export", "logi"),
  ]),
  mod("space/runtime/entityDogmaView", [
    sym("buildRuntimeShipItemFromEntity", "export", "logi"),
  ]),
  mod("space/destiny/identity/interactionScope", [
    sym("canEntitiesInteractLocally", "export", "logi"),
  ]),
  mod("space/runtime/solarSystemScene", [
    sym("broadcastSpecialFx", "exportClassPrototypeMethod", "logi", { exportName: "SolarSystemScene",
      optional: true }),
  ]),
  mod("space/runtime/solarSystemScene", [
    ...["movementChangesWait", "captureShipMotion", "adoptDerivedShipState", "queueShipMotionChange",
      "dropPendingShipMotion", "broadcastShipPrimeUpdates"]
      .map((name) => sym(name, "exportClassPrototypeMethod", "prop", { exportName: "SolarSystemScene" })),
    sym("broadcastSpecialFx", "exportClassPrototypeMethod", "prop", { exportName: "SolarSystemScene",
      optional: true }),
  ]),
  mod("space/runtime/passiveDerivedState", [
    sym("applyPassiveResourceStateToEntity", "export", "prop"),
  ]),
  mod("space/runtime/propulsionModule", [
    sym("applyPropulsionEffectStateToEntity", "export", "prop"),
    sym("PROPULSION_EFFECT_AFTERBURNER", "export", "prop", { valueType: "string" }),
    sym("PROPULSION_EFFECT_MICROWARPDRIVE", "export", "prop", { valueType: "string" }),
    sym("PROPULSION_GUID_BY_EFFECT", "export", "prop", { valueType: "object" }),
  ]),
  mod("services/ship/safeLogoffRuntime", [
    sym("prepareStart", "export", "safeLogoff", { wrap: true }),
    sym("abort", "export", "safeLogoff"),
    sym("collectFailedConditions", "export", "safeLogoff"),
    sym("LABELS", "export", "safeLogoff", { valueType: "object" }),
  ]),
  mod("space/modules/commandBurstRuntime", [
    sym("collectModifierEntriesForItem", "export", "burst"),
    sym("_testing", "export", "burst", { valueType: "object", optional: true }),
    sym("buildClientDbuffStateEntries", "export", "burst"),
  ]),
  mod("space/runtime/passiveDerivedState", [
    sym("buildPassiveShipResourceState", "export", "burst"),
    sym("applyPassiveResourceStateToEntity", "export", "burst"),
  ]),
  mod("services/exploration/wormholes/wormholeEnvironmentRuntime", [
    sym("collectShipAttributeModifierEntriesForSystem", "export", "burst"),
  ]),
  mod("space/runtime/entityDogmaView", [
    sym("buildRuntimeShipItemFromEntity", "export", "burst"),
  ]),
  mod("space/runtime/propulsionModule", [
    sym("applyPropulsionEffectStateToEntity", "export", "burst"),
  ]),
  mod("space/runtime/solarSystemScene", [
    ...["movementChangesWait", "captureShipMotion", "adoptDerivedShipState", "queueShipMotionChange",
      "dropPendingShipMotion", "broadcastShipPrimeUpdates"]
      .map((name) => sym(name, "exportClassPrototypeMethod", "burst", { exportName: "SolarSystemScene" })),
  ]),
  mod("space/runtime/shipHealthState", [
    sym("broadcastDamageStateChange", "export", "burst", { optional: true }),
  ]),
  mod("services/drone/droneRuntime", [
    ...["isDroneEntity", "getDroneBandwidthLoad", "resolveDroneOrbitDistance", "resolveDroneMovementProfile"]
      .map((name) => sym(name, "export", "drones")),
    sym("_testing", "export", "drones", { valueType: "object" }),
  ]),
  mod("services/drone/droneDogma", [
    sym("resolveDroneCombatSnapshot", "export", "drones"),
    sym("resolveDroneRepairSnapshot", "export", "drones"),
  ]),
  mod("space/modules/assistanceModuleRuntime", [
    sym("executeAssistanceModuleCycle", "export", "drones"),
  ]),
  mod("space/destiny/identity/interactionScope", [
    sym("canEntitiesInteractLocally", "export", "drones"),
  ]),
  mod("services/fighter/fighterInventory", [
    sym("isDroneItemRecord", "export", "drones"),
  ]),
  mod("services/inventory/itemCustody", [
    sym("transfer", "export", "drones"),
    sym("custodyRef", "export", "drones", { valueType: "object" }),
    sym("CUSTODY_REASON", "export", "drones", { valueType: "object" }),
  ]),
  mod("services/inventory/itemStore", [
    sym("ITEM_FLAGS", "export", "drones", { valueType: "object" }),
    ...["updateInventoryItem", "listContainerItems", "findItemById"].map((name) => sym(name, "export", "drones")),
  ]),
  mod("space/runtime", [
    sym("spawnDynamicInventoryEntity", "prototypeMethod", "drones"),
    sym("droneInterop", "property", "drones"),
  ]),
  mod("_secondary/fitting/fittingRuntime", [
    sym("getShipFittingSnapshot", "export", "drones"),
  ]),
  mod("space/runtime/solarSystemScene", [
    sym("broadcastAddBalls", "exportClassPrototypeMethod", "drones", { exportName: "SolarSystemScene" }),
  ]),
  mod("services/drone/droneDogma", [
    sym("resolveDroneMiningSnapshot", "export", "droneMining"),
  ]),
  mod("services/inventory/itemTypeRegistry", [
    sym("resolveItemByTypeID", "export", "droneMining"),
  ]),
  mod("space/npc/npcBehaviorLoop", [
    sym("tickScene", "export", "npcAggro", { firstLoad: true, wrap: true }),
    sym("tickControllersByEntityID", "export", "npcAggro", { firstLoad: true, wrap: true }),
    sym("__testing", "export", "npcAggro", { valueType: "object" }),
  ]),
  mod("space/runtime/solarSystemScene", ["activateGenericModule", "deactivateGenericModule", "launchMissile"]
    .map((name) => sym(name, "exportClassPrototypeMethod", "npcAggro", { exportName: "SolarSystemScene", wrap: true }))),
  mod("space/runtime/destinyMovementEngine", [
    sym("dispatchGotoPointEntity", "export", "formation"),
  ]),
  mod("space/modules/salvagerRuntime", [
    sym("resolveSalvagerActivation", "export", "salvage", { wrap: true }),
    sym("executeSalvagerCycle", "export", "salvage", { wrap: true }),
    sym("isSalvageableTarget", "export", "salvage"),
    sym("isModuleSalvagingEffectRecord", "export", "salvage"),
  ]),
  mod("space/runtime/moduleCycleBoundarySnapshot", [
    sym("resolveSalvagerCycleRuntimeSnapshot", "export", "salvage", { firstLoad: true, wrap: true }),
  ]),
  mod("space/runtime/moduleActivationEffectRecord", [
    sym("resolveDefaultActivationEffect", "export", "salvage"),
  ]),
  mod("space/runtime/entityDogmaView", [
    sym("buildRuntimeShipItemFromEntity", "export", "salvage"),
  ]),
  mod("services/fitting/liveFittingState", [
    ...["buildShipResourceState", "isModuleOnline", "getTypeAttributeMap", "getAttributeIDByNames"]
      .map((name) => sym(name, "export", "salvage")),
  ]),
  mod("services/inventory/itemStore", [
    sym("ITEM_FLAGS", "export", "salvage", { valueType: "object" }),
    ...["listContainerItems", "findItemById"].map((name) => sym(name, "export", "salvage")),
  ]),
  mod("space/runtime/solarSystemScene", [
    sym("getAllVisibleEntities", "exportClassPrototypeMethod", "salvage", { exportName: "SolarSystemScene" }),
  ]),
  mod("services/drone/droneDogma", [
    sym("resolveDroneSalvageSnapshot", "export", "droneSalvage"),
  ]),
  mod("space/modules/salvagerRuntime", ["executeSalvagerCycle", "buildSalvageChanceSnapshot", "isSalvageableTarget"]
    .map((name) => sym(name, "export", "droneSalvage"))),
  mod("space/runtime/moduleRuntimeCallbacks", [
    sym("buildSalvagerRuntimeCallbacks", "export", "droneSalvage"),
  ]),
  mod("services/ship/shipService", [
    sym("Handle_Board", "classPrototypeMethod", "board", { wrap: true }),
    sym("_testing", "property", "board"),
  ]),
  mod("services/ship/ejectRuntime", [
    sym("launchShipFromMaintenanceContainer", "export", "board"),
  ]),
  mod("services/ship/breacherPodDeathRuntime", [
    sym("isShipDeathPending", "export", "board"),
  ]),
  mod("space/runtime/combatDestruction", [
    sym("isRuntimeEntityDestroyingOrDestroyed", "export", "board"),
  ]),
  mod("common/machoErrors", [
    sym("throwWrappedUserError", "export", "board"),
  ]),
  mod("space/destiny/identity/interactionScope", ["resolveEntityInteractionScope", "buildChildEntityScopeMetadata"]
    .map((name) => sym(name, "export", "board"))),
  mod("space/runtime/entityScopeTags", ["applyRuntimeEntityScopeMetadata", "clearPlayerShipGenericDungeonScope"]
    .map((name) => sym(name, "export", "board"))),
  mod("services/security/shipPursuit", [
    sym("getShipChangePursuitError", "export", "board", { optional: true }),
  ]),
  mod("space/transitions", [
    sym("boardSpaceShip", "export", "boardServer"),
  ]),
  mod("space/runtime/solarSystemScene", ["getKnownGridBubbleIDForSession", "queueCharacterHistory"]
    .map((name) => sym(name, "exportClassPrototypeMethod", "boardGhost", { exportName: "SolarSystemScene" }))),
  mod("space/destiny/stream/actions", [
    sym("buildRemoveBallsPayload", "export", "boardGhost"),
  ]),
  mod("services/ship/ejectRuntime", [
    sym("scoopShipIntoActiveShipMaintenanceBay", "export", "boardStow"),
  ]),
  mod("services/ship/shipService", [
    sym("Handle_ScoopToSMA", "classPrototypeMethod", "scoopReturn", { wrap: true }),
  ]),
  mod("services/inventory/itemStore", [
    ...["createSpaceItemForCharacter", "grantItemsToCharacterLocation", "removeInventoryItem", "listContainerItems"]
      .map((name) => sym(name, "export", "miningOverflow")),
  ]),
  mod("space/runtime", [
    sym("spawnDynamicInventoryEntity", "prototypeMethod", "miningOverflow"),
  ]),
  mod("space/destiny/identity/interactionScope", [
    sym("buildChildEntityScopeMetadata", "export", "miningOverflow"),
  ]),
  mod("services/inventory/cargoLootAuthority", [
    sym("DISPOSABLE_JETCAN_TYPE_ID", "export", "miningOverflow", { valueType: "number" }),
    sym("SPACE_CONTAINER_FLAG_ID", "export", "miningOverflow", { valueType: "number" }),
  ]),
  mod("services/inventory/itemTypeRegistry", [
    sym("resolveItemByTypeID", "export", "miningOverflow"),
  ]),
  mod("services/inventory/itemStore", [
    sym("ITEM_FLAGS", "export", "cargo", { valueType: "object" }),
    ...["moveItemToLocation", "listContainerItems", "findItemById"].map((name) => sym(name, "export", "cargo")),
  ]),
  mod("services/fitting/liveFittingState", [
    sym("buildShipResourceState", "export", "cargo"),
  ]),
  mod("services/mining/miningInventory", [
    sym("MINING_SHIP_BAY_FLAGS", "export", "cargo", { valueType: "object" }),
    ...["getShipHoldCapacityByFlag", "isItemTypeAllowedInHoldFlag"].map((name) => sym(name, "export", "cargo")),
  ]),
  mod("services/inventory/fleetHangarInventory", [
    sym("getFleetHangarCapacity", "export", "cargo"),
  ]),
  mod("services/inventory/shipMaintenanceBayInventory", [
    sym("validateShipMaintenanceBayContents", "export", "boardCargo"),
  ]),
  mod("space/modules/hostileModuleRuntime", [
    ...["resolveHostileDefinition", "resolveHostileModuleActivation", "executeHostileModuleCycle",
      "removeHostileModuleState"].map((name) => sym(name, "export", "ewar")),
  ]),
  mod("space/runtime/moduleRuntimeCallbacks", [
    sym("buildHostileModuleRuntimeCallbacks", "export", "ewar"),
  ]),
  mod("space/runtime/entityDogmaView", [
    sym("buildRuntimeShipItemFromEntity", "export", "ewar"),
  ]),
  mod("space/runtime/solarSystemScene", [
    sym("getEntityByID", "exportClassPrototypeMethod", "ewar", { exportName: "SolarSystemScene" }),
    sym("refreshShipEntityDerivedState", "exportClassPrototypeMethod", "ewar", { exportName: "SolarSystemScene" }),
    sym("broadcastSpecialFx", "exportClassPrototypeMethod", "ewar", { exportName: "SolarSystemScene",
      optional: true }),
  ]),
]);

module.exports = { GAME_MODULES, SHIP_SERVICE_GUARDED, INV_BROKER_GUARDED };
