"use strict";

const { distance: vecDistance } = require("../util/vec");
const { isSized, holdTake, round6 } = require("../core/miningTask");
const { miningSnapshotInput } = require("./twinDogma");
const { createOverflowCans } = require("./overflowCans");
const { createRealCargo } = require("./realCargo");

const SHIP_CATEGORY_ID = 6;

const ACCESS_MODULES = Object.freeze({
  miningRuntimeState: "services/mining/miningRuntimeState",
  miningDogma: "services/mining/miningDogma",
  miningInventory: "services/mining/miningInventory",
  airMiningSettlement: "services/mining/airMiningSettlement",
  interactionScope: "space/destiny/identity/interactionScope",
  liveFittingState: "services/fitting/liveFittingState",
  fleetHangarInventory: "services/inventory/fleetHangarInventory",
  itemStore: "services/inventory/itemStore",
  entityDogmaView: "space/runtime/entityDogmaView",
  commandBurstRuntime: "space/modules/commandBurstRuntime",
  wormholeEnvironmentRuntime: "services/exploration/wormholes/wormholeEnvironmentRuntime",
});

const OVERFLOW_MODULES = Object.freeze({
  spaceRuntime: "space/runtime",
  cargoLootAuthority: "services/inventory/cargoLootAuthority",
  itemTypeRegistry: "services/inventory/itemTypeRegistry",
});

function toInt(value, fallback = 0) {
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) ? n : fallback;
}

function toNum(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function isObj(value) {
  return value !== null && typeof value === "object";
}

function familyOfYield(yieldKind) {
  return yieldKind === "gas" || yieldKind === "ice" ? yieldKind : "ore";
}

function createMiningAccess(input) {
  const deps = input.deps;
  const twinScene = input.scene;
  const config = input.config || {};
  const fleetHangar = deps.FLEET_HANGAR;
  const overflow = isObj(deps.overflow) ? createOverflowCans({
    deps: { ...deps.overflow, grantItemsToCharacterLocation: deps.grantItemsToCharacterLocation },
    config,
    distance: (scene, a, b) => twinScene.surfaceDistance(scene, a, b),
    usedVolume: (locationId, flag) => usedVolume(locationId, flag),
  }) : null;
  const realCargo = Number.isInteger(deps.SHIP_HANGAR) && Number.isInteger(deps.CARGO_HOLD) ? createRealCargo({
    deps, config, usedVolume: (locationId, flag) => usedVolume(locationId, flag),
  }) : null;

  function miningModules(twin) {
    const fitted = Array.isArray(twin && twin.fittedItems) ? twin.fittedItems : [];
    const out = [];
    for (const module of fitted) {
      if (!module || !deps.isModuleOnline(module)) continue;
      const records = deps.getTypeEffectRecords(toInt(module.typeID, 0)) || [];
      const effectRecord = records.find((r) => deps.isMiningEffectRecord(r, module)) || null;
      if (!effectRecord || !effectRecord.name) continue;
      out.push({ module, effectName: String(effectRecord.name), effectRecord,
        family: deps.resolveMiningFamily(module, effectRecord) });
    }
    return out.sort((a, b) => toInt(a.module.itemID, 0) - toInt(b.module.itemID, 0));
  }

  function rockState(scene, rockId) {
    const id = toInt(rockId, 0);
    if (!scene || id <= 0) return null;
    deps.ensureSceneMiningState(scene);
    const state = deps.getMineableState(scene, id);
    if (!state) return null;
    return { remaining: toNum(state.remainingQuantity, 0), yieldTypeID: toInt(state.yieldTypeID, 0),
      yieldKind: String(state.yieldKind || ""), unitVolume: toNum(state.unitVolume, 0) };
  }

  function rockFits(scene, twin, ent, families) {
    if (!ent || !deps.isMineableStaticEntity(ent) || ent.airMiningTargetable === false || deps.isAirRock(ent)) {
      return null;
    }
    if (twin && !deps.canEntitiesInteractLocally(twin, ent)) return null;
    const state = rockState(scene, ent.itemID);
    if (!state || !(state.remaining > 0)) return null;
    if (families instanceof Set && !families.has(familyOfYield(state.yieldKind))) return null;
    return state;
  }

  function isRock(scene, rockId) {
    const ent = twinScene.entity(scene, rockId);
    return Boolean(ent && deps.isMineableStaticEntity(ent));
  }

  function checkTarget(scene, twin, rockId, families) {
    return rockFits(scene, twin, twinScene.entity(scene, rockId), families) ? { ok: true }
      : { ok: false, reason: "TARGET_INVALID" };
  }

  function candidates(scene, host) {
    if (typeof scene.getStaticEntitiesInBubble === "function"
      && typeof scene.getGridBubbleIDForPosition === "function") {
      const bubbleID = host && host.position ? scene.getGridBubbleIDForPosition(host.position) : null;
      if (bubbleID === null || bubbleID === undefined) return [];
      const list = scene.getStaticEntitiesInBubble(bubbleID) || [];
      return list.filter((e) => e && e.staticVisibilityScope === "bubble");
    }
    return Array.isArray(scene.staticEntities) ? scene.staticEntities
      : [...(scene.staticEntities || [])];
  }

  function hostReachM(ent, hostPos) {
    return Math.max(0, vecDistance(ent.position, hostPos) - Math.max(0, toNum(ent.radius, 0)));
  }

  function pickRock(scene, opts) {
    const { twin, host } = opts;
    const families = opts.families instanceof Set ? opts.families : null;
    const hostPos = host && host.position;
    const rangeM = Math.max(0, toNum(opts.rangeM, 0));
    const ownerRangeM = opts.ownerRangeM === undefined ? rangeM : Math.max(0, toNum(opts.ownerRangeM, 0));
    for (const id of Array.isArray(opts.ownerTargets) ? opts.ownerTargets : []) {
      const ent = twinScene.entity(scene, id);
      const distanceM = hostPos && ent ? hostReachM(ent, hostPos) : 0;
      if (hostPos && !(distanceM <= ownerRangeM)) continue;
      if (rockFits(scene, twin, ent, families)) return { rockId: toInt(ent.itemID, 0), distanceM, ordered: true };
    }
    if (!scene || !hostPos) return null;
    deps.ensureSceneMiningState(scene);
    const claims = opts.claims instanceof Map ? opts.claims : new Map();
    const penaltyM = Math.max(0, toNum(opts.penaltyM, 0));
    let best = null;
    for (const ent of candidates(scene, host)) {
      const id = toInt(ent && ent.itemID, 0);
      if (id <= 0) continue;
      const distanceM = hostReachM(ent, hostPos);
      if (!(distanceM <= rangeM)) continue;
      if (!rockFits(scene, twin, ent, families)) continue;
      const score = distanceM + toInt(claims.get(id), 0) * penaltyM;
      if (!best || score < best.score || (score === best.score && id < best.rockId)) {
        best = { rockId: id, distanceM, score };
      }
    }
    return best ? { rockId: best.rockId, distanceM: best.distanceM } : null;
  }

  function rockDistanceM(scene, host, rockId) {
    const hostPos = host && host.position;
    if (!hostPos) return { ok: false, reason: "NO_HOST" };
    const ent = twinScene.entity(scene, rockId);
    if (!ent || !ent.position) return { ok: false, reason: "NO_ROCK" };
    return { ok: true, distanceM: hostReachM(ent, hostPos) };
  }

  function workRangeM(scene, twin, ownerCharacterId, modules) {
    const buffer = Math.max(0, toNum(config.miningRangeBufferMeters, 0));
    const nowMs = twinScene.simNow(scene);
    let miningRange = Infinity;
    for (const m of Array.isArray(modules) ? modules : []) {
      const input = miningSnapshotInput(twin, ownerCharacterId, m.module, m.effectRecord, nowMs, deps);
      const snapshot = input ? deps.buildMiningModuleSnapshot(input) : null;
      const range = Math.max(0, toNum(snapshot && snapshot.maxRangeMeters, 0) - buffer);
      if (range < miningRange) miningRange = range;
    }
    if (!Number.isFinite(miningRange)) miningRange = 0;
    const lockRange = Math.max(0, twinScene.lockRange(scene, twin) - buffer);
    if (lockRange <= 0) return miningRange;
    if (miningRange <= 0) return lockRange;
    return Math.min(miningRange, lockRange);
  }

  function holdFill(hold) {
    if (!isSized(hold)) return { pct: 0, freeForType: () => Infinity };
    let capacity = 0;
    for (const value of hold.capacityByFlag.values()) capacity += Math.max(0, toNum(value, 0));
    const pct = capacity > 0 ? (toNum(hold.usedM3, 0) / capacity) * 100 : 0;
    return {
      pct,
      freeForType(typeID) {
        const flag = hold.flagByType.get(toInt(typeID, 0));
        if (flag === undefined) return Infinity;
        if (!(flag > 0)) return 0;
        const cap = toNum(hold.capacityByFlag.get(flag), 0);
        return Math.max(0, round6(cap - toNum(hold.usedByFlag.get(flag), 0)));
      },
    };
  }

  function usedVolume(hostShipId, flag) {
    let used = 0;
    for (const item of deps.listContainerItems(null, hostShipId, flag) || []) {
      if (!item) continue;
      const units = toInt(item.singleton, 0) === 1 ? 1 : Math.max(0, toInt(item.stacksize ?? item.quantity, 0));
      used += Math.max(0, toNum(item.volume, 0)) * units;
    }
    return used;
  }

  function unload(hold, opts) {
    const owner = toInt(opts && opts.ownerCharacterId, 0);
    const hostShipId = toInt(opts && opts.hostShipId, 0);
    const systemId = toInt(opts && opts.systemId, 0);
    const left = () => (isSized(hold) ? toNum(hold.usedM3, 0) : 0);
    if (!isSized(hold) || hold.items.size === 0) {
      return { ok: true, movedM3: 0, leftM3: left(), changes: [], grantFailed: 0 };
    }
    const host = hostShipId > 0 ? deps.findItemById(hostShipId) : null;
    if (owner <= 0 || systemId <= 0 || !isObj(host) || toInt(host.ownerID, 0) !== owner
      || toInt(host.categoryID, 0) !== SHIP_CATEGORY_ID || toInt(host.locationID, 0) !== systemId) {
      return { ok: false, reason: "HOST_INVALID", movedM3: 0, leftM3: left(), grantFailed: 0 };
    }
    const hostRS = deps.buildShipResourceState(owner, host);
    const changes = [];
    let moved = 0;
    let grantFailed = 0;
    for (const typeID of [...hold.items.keys()].sort((a, b) => a - b)) {
      const unit = toNum(hold.unitM3ByType.get(typeID), 0);
      const holdFlag = hold.flagByType.get(typeID);
      if (!(unit > 0) || !(holdFlag > 0)) continue;
      const flags = [];
      const preferred = toInt(deps.getPreferredMiningHoldFlagForType(hostRS, typeID), 0);
      if (preferred > 0 && deps.isItemTypeAllowedInHoldFlag(typeID, preferred)) flags.push(preferred);
      flags.push(fleetHangar);
      for (const flag of flags) {
        const have = hold.items.get(typeID) || 0;
        if (have <= 0) break;
        const capacity = flag === fleetHangar ? toNum(deps.getFleetHangarCapacity(hostRS), 0)
          : toNum(deps.getShipHoldCapacityByFlag(hostRS, flag), 0);
        const free = capacity - usedVolume(hostShipId, flag);
        const qty = Math.min(have, Math.floor(round6(free / unit)));
        if (!(qty > 0)) continue;
        const granted = deps.grantItemsToCharacterLocation(owner, hostShipId, flag,
          [{ itemType: typeID, quantity: qty }]);
        if (!isObj(granted) || granted.success !== true) {
          grantFailed += 1;
          break;
        }
        const taken = holdTake(hold, holdFlag, typeID, qty, unit);
        moved = round6(moved + (taken.ok ? taken.m3 : 0));
        if (isObj(granted.data) && Array.isArray(granted.data.changes)) changes.push(...granted.data.changes);
      }
    }
    if (changes.length > 0 && typeof deps.emit === "function") {
      try {
        deps.emit(owner, changes);
      } catch (_err) {
      }
    }
    if (grantFailed > 0) return { ok: false, reason: "GRANT_FAILED", movedM3: moved, leftM3: left(), grantFailed };
    return { ok: true, movedM3: moved, leftM3: left(), changes, grantFailed };
  }

  function jettison(hold, opts) {
    if (!overflow) {
      return { ok: false, reason: "DISABLED", movedM3: 0, leftM3: isSized(hold) ? toNum(hold.usedM3, 0) : 0,
        created: false };
    }
    return overflow.jettison(hold, opts);
  }

  function deposit(hold, opts) {
    if (!realCargo) {
      return { ok: false, reason: "DISABLED", movedM3: 0, leftM3: isSized(hold) ? toNum(hold.usedM3, 0) : 0,
        storeInvalid: false };
    }
    return realCargo.deposit(hold, opts);
  }

  return Object.freeze({
    miningModules, rockState, isRock, checkTarget, pickRock, rockDistanceM, workRangeM, holdFill, unload, jettison,
    deposit,
  });
}

function depsFromGame(g, emit) {
  const late = (mod, name) => (...args) => g[mod][name](...args);
  return {
    isMineableStaticEntity: late("miningRuntimeState", "isMineableStaticEntity"),
    getMineableState: late("miningRuntimeState", "getMineableState"),
    ensureSceneMiningState: late("miningRuntimeState", "ensureSceneMiningState"),
    isAirRock: late("airMiningSettlement", "isAirRock"),
    canEntitiesInteractLocally: late("interactionScope", "canEntitiesInteractLocally"),
    resolveMiningFamily: late("miningDogma", "resolveMiningFamily"),
    isMiningEffectRecord: late("miningDogma", "isMiningEffectRecord"),
    buildMiningModuleSnapshot: late("miningDogma", "buildMiningModuleSnapshot"),
    getTypeEffectRecords: late("liveFittingState", "getTypeEffectRecords"),
    isModuleOnline: late("liveFittingState", "isModuleOnline"),
    buildShipResourceState: late("liveFittingState", "buildShipResourceState"),
    getPreferredMiningHoldFlagForType: late("miningInventory", "getPreferredMiningHoldFlagForType"),
    getShipHoldCapacityByFlag: late("miningInventory", "getShipHoldCapacityByFlag"),
    isItemTypeAllowedInHoldFlag: late("miningInventory", "isItemTypeAllowedInHoldFlag"),
    getFleetHangarCapacity: late("fleetHangarInventory", "getFleetHangarCapacity"),
    grantItemsToCharacterLocation: late("itemStore", "grantItemsToCharacterLocation"),
    listContainerItems: late("itemStore", "listContainerItems"),
    findItemById: late("itemStore", "findItemById"),
    buildRuntimeShipItemFromEntity: late("entityDogmaView", "buildRuntimeShipItemFromEntity"),
    collectModifierEntriesForItem: late("commandBurstRuntime", "collectModifierEntriesForItem"),
    getLocationModifierSourcesForSystem: late("wormholeEnvironmentRuntime", "getLocationModifierSourcesForSystem"),
    FLEET_HANGAR: g.itemStore.ITEM_FLAGS.FLEET_HANGAR,
    SHIP_HANGAR: g.itemStore.ITEM_FLAGS.SHIP_HANGAR,
    CARGO_HOLD: g.itemStore.ITEM_FLAGS.CARGO_HOLD,
    emit,
    overflow: g.overflow ? overflowDepsFromGame(g, late) : undefined,
  };
}

function overflowDepsFromGame(g, late) {
  return {
    createSpaceItemForCharacter: late("itemStore", "createSpaceItemForCharacter"),
    removeInventoryItem: late("itemStore", "removeInventoryItem"),
    spawnDynamicInventoryEntity: (...args) => g.spaceRuntime.spawnDynamicInventoryEntity(...args),
    buildChildEntityScopeMetadata: late("interactionScope", "buildChildEntityScopeMetadata"),
    resolveItemByTypeID: late("itemTypeRegistry", "resolveItemByTypeID"),
    JETCAN_TYPE_ID: g.cargoLootAuthority.DISPOSABLE_JETCAN_TYPE_ID,
    CONTENT_FLAG: g.cargoLootAuthority.SPACE_CONTAINER_FLAG_ID,
  };
}

function loadOverflowModules(gameAdapter, config, game) {
  if (!config || config.miningOverflowCanEnabled !== true) return { ok: false, reason: "off" };
  if (gameAdapter.isConsumerAvailable("miningOverflow") !== true) {
    return { ok: false, reason: "probe_miningOverflow_unavailable" };
  }
  const loaded = {};
  for (const [key, rel] of Object.entries(OVERFLOW_MODULES)) {
    const out = gameAdapter.requireGame(rel);
    if (!out || !out.ok || !isObj(out.exports)) {
      return { ok: false, reason: `require_failed:${rel}:${out && out.reason}` };
    }
    loaded[key] = out.exports;
  }
  const typeId = loaded.cargoLootAuthority.DISPOSABLE_JETCAN_TYPE_ID;
  const flag = loaded.cargoLootAuthority.SPACE_CONTAINER_FLAG_ID;
  if (!Number.isInteger(typeId) || typeId <= 0 || !Number.isInteger(flag) || flag < 0) {
    return { ok: false, reason: "no_jetcan_constants" };
  }
  Object.assign(game, loaded, { overflow: true });
  return { ok: true };
}

function createMiningAccessFromGame(gameAdapter, input) {
  if (!gameAdapter || typeof gameAdapter.isConsumerAvailable !== "function"
    || !gameAdapter.isConsumerAvailable("mining")) {
    return { ok: false, reason: "probe_mining_unavailable" };
  }
  if (!gameAdapter.isConsumerAvailable("twinControl")) return { ok: false, reason: "probe_twinControl_unavailable" };
  const game = {};
  for (const [key, rel] of Object.entries(ACCESS_MODULES)) {
    const loaded = gameAdapter.requireGame(rel);
    if (!loaded || !loaded.ok || !isObj(loaded.exports)) {
      return { ok: false, reason: `require_failed:${rel}:${loaded && loaded.reason}` };
    }
    game[key] = loaded.exports;
  }
  const flags = game.itemStore.ITEM_FLAGS;
  if (!isObj(flags) || !Number.isInteger(flags.FLEET_HANGAR)) return { ok: false, reason: "no_fleet_hangar_flag" };
  const overflow = loadOverflowModules(gameAdapter, input && input.config, game);
  const access = createMiningAccess({ deps: depsFromGame(game, input && input.emit), scene: input && input.scene,
    config: input && input.config });
  const realCargoReady = Number.isInteger(flags.SHIP_HANGAR) && Number.isInteger(flags.CARGO_HOLD);
  return { ok: true, access, overflowReason: overflow.ok ? null : overflow.reason, realCargoReady };
}

module.exports = {
  ACCESS_MODULES, OVERFLOW_MODULES, SHIP_CATEGORY_ID, familyOfYield, createMiningAccess, createMiningAccessFromGame,
};
