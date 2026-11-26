// finished cycle of a twin's mining drone, a port of the yield part of the vendor tickDroneMining (droneRuntime.js:7289-7451, CREDITS.md) without the grant to a ship item.

"use strict";

const { surfaceDistance: vecSurfaceDistance } = require("../util/vec");
const { isSized, sizeHold, holdSpace, holdAdd, holdTake } = require("../core/miningTask");
const { twinModule, twinCharge, miningSnapshotInput, crystalBurnedOut } = require("./twinDogma");
const { pseudoModuleItem } = require("./droneAccess");

const WRAPPED = Symbol.for("shipWing.mining");
const RUNTIME_MODULE = "services/mining/miningRuntime";
const WRAPPED_EXPORTS = Object.freeze({
  resolveMiningActivation: 1,
  prepareMiningCycleBoundary: 0,
  executeMiningCycle: 1,
});

const SNAPSHOT_KEYS = Object.freeze([
  "characterID", "shipItem", "moduleItem", "effectRecord", "chargeItem", "fittedItems", "skillMap",
  "activeModuleContexts", "additionalModifierEntries", "additionalChargeModifierEntries",
  "additionalLocationModifierSources",
]);

const CYCLE_STOP = Object.freeze(["target", "cargo", "range", "module", "mining", "cycle", "charge", "ammo"]);
const ACTIVATE_REFUSAL = Object.freeze([
  "TARGET_REQUIRED", "TARGET_NOT_FOUND", "TARGET_NOT_LOCKED", "UNSUPPORTED_MODULE", "TARGET_INVALID_FOR_MODULE",
  "CHARGE_NOT_COMPATIBLE", "TARGET_OUT_OF_RANGE",
]);
const COUNTER_NAMES = Object.freeze([
  "mining.cycle.ok", "mining.cycle.error", "mining.hook.error", "mining.ledger.error",
  ...CYCLE_STOP.map((reason) => `mining.cycle.stop.${reason}`),
  ...ACTIVATE_REFUSAL.map((code) => `mining.activate.refused.${code}`),
]);

const RANGE_GRACE_METERS = 1;
const TWIN_STOP = Object.freeze({ NO_HOLD: "cargo", UNIT: "target", NO_ROOM: "cargo", NOTHING: "cargo",
  DELTA_REFUSED: "target" });
const DRONE_CYCLE_REFUSAL = Object.freeze(["NO_ROOM", "TARGET", "KIND", "NOT_A_TWIN", "HOOK_UNAVAILABLE", "ERROR"]);
const DRONE_REFUSAL_OF = Object.freeze({ NO_HOLD: "NO_ROOM", NO_ROOM: "NO_ROOM", UNIT: "TARGET",
  CLAMP_ZERO: "TARGET", DELTA_REFUSED: "TARGET" });

function isObj(value) {
  return value !== null && (typeof value === "object" || typeof value === "function");
}

function toInt(value, fallback = 0) {
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) ? n : fallback;
}

function toNum(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function familyFits(snapshot, state) {
  if (!snapshot || !state) return false;
  if (snapshot.family === "gas") return state.yieldKind === "gas";
  if (snapshot.family === "ice") return state.yieldKind === "ice";
  return state.yieldKind === "ore";
}

function ledgerObserver(scene, target) {
  const t = target || {};
  const s = scene || {};
  const ids = [t.observerItemID, t.observerID, t.structureID, t.ownerStructureID, t.sourceStructureID,
    t.moonMiningStructureID, s.observerItemID, s.observerID, s.structureID];
  const names = [t.observerItemName, t.observerName, t.structureName, t.ownerStructureName, t.sourceStructureName,
    s.observerItemName, s.observerName, s.structureName];
  const id = ids.map((v) => toInt(v, 0)).find((v) => v > 0) || 0;
  const name = names.find((v) => typeof v === "string" && v.trim());
  return { observerItemID: id, observerItemName: name ? name.trim() : "" };
}

function createMiningHook(input) {
  const target = input && input.miningRuntime;
  const deps = (input && input.deps) || {};
  const wing = input && input.wing;
  const config = (input && input.config) || {};
  const counters = Object.fromEntries(COUNTER_NAMES.map((name) => [name, 0]));
  const originals = new Map();
  const wrappers = new Map();
  let active = false;
  let installed = false;

  function bump(name) {
    if (Object.prototype.hasOwnProperty.call(counters, name)) counters[name] += 1;
  }

  function stop(reason) {
    bump(`mining.cycle.stop.${reason}`);
    return { success: false, stopReason: reason };
  }

  function refuseActivation(code, data) {
    bump(`mining.activate.refused.${code}`);
    const out = { matched: true, success: false, errorMsg: code };
    if (data !== undefined) out.data = data;
    return out;
  }

  function twinFor(entity) {
    try {
      if (!entity || typeof entity !== "object" || wing.liveTwinCount() === 0) return null;
      return wing.twinOf(entity) || null;
    } catch (_err) {
      bump("mining.hook.error");
      return null;
    }
  }

  function sceneNow(scene) {
    return scene && typeof scene.getCurrentSimTimeMs === "function" ? scene.getCurrentSimTimeMs() : Date.now();
  }

  function distanceOf(scene, a, b) {
    if (scene && typeof scene.getEntitySurfaceDistance === "function") {
      return toNum(scene.getEntitySurfaceDistance(a, b), Infinity);
    }
    return vecSurfaceDistance(a && a.position, a && a.radius, b && b.position, b && b.radius);
  }

  function buildSnapshot(twinEntity, owner, moduleItem, effectRecord, nowMs) {
    const input = miningSnapshotInput(twinEntity, owner.ownerCharacterId, moduleItem, effectRecord, nowMs, deps);
    return input ? deps.buildMiningModuleSnapshot(input) : null;
  }

  function holdResolve() {
    return {
      flagOf: (rs, typeID) => toInt(deps.getPreferredMiningHoldFlagForType(rs, typeID), 0) || deps.CARGO_HOLD,
      capacityOf: (rs, flag) => (flag === deps.CARGO_HOLD
        ? toNum(rs && rs.cargoCapacity, 0) : toNum(deps.getShipHoldCapacityByFlag(rs, flag), 0)),
    };
  }

  function holdOf(twinEntity, owner) {
    const rt = wing.twinTaskContext(twinEntity);
    if (!rt || !rt.hold || typeof rt.hold !== "object") return null;
    if (!isSized(rt.hold)) {
      const shipItem = deps.buildRuntimeShipItemFromEntity(twinEntity);
      const resourceState = deps.buildShipResourceState(owner.ownerCharacterId, shipItem, {
        fittedItems: Array.isArray(twinEntity.fittedItems) ? twinEntity.fittedItems : [],
        skillMap: twinEntity.skillMap instanceof Map ? twinEntity.skillMap : new Map(),
      });
      sizeHold(rt.hold, resourceState);
    }
    return rt.hold;
  }

  function twinPrepare(owner, entity, effectState, cycleBoundaryMs) {
    if (!effectState) return stop("module");
    const moduleItem = twinModule(entity, effectState.moduleID, effectState.moduleFlagID);
    if (!moduleItem || !deps.isModuleOnline(moduleItem)) return stop("module");
    const effectRecord = deps.getEffectTypeRecord(toInt(effectState.effectID, 0));
    const snapshot = buildSnapshot(entity, owner, moduleItem, effectRecord, cycleBoundaryMs);
    if (!snapshot) return stop("module");
    return { success: true, data: { moduleItem, snapshot, cycleBoundaryMs } };
  }

  function twinActivation(owner, scene, entity, moduleItem, effectRecord, options) {
    if (!deps.isMiningEffectRecord(effectRecord, moduleItem)) return { matched: false };
    deps.ensureSceneMiningState(scene);
    const targetID = toInt(options && options.targetID, 0);
    if (targetID <= 0) return refuseActivation("TARGET_REQUIRED");
    const targetEntity = scene.getEntityByID(targetID);
    const state = deps.getMineableState(scene, targetID);
    if (!targetEntity || targetEntity.airMiningTargetable === false || deps.isAirRock(targetEntity) || !state
      || state.remainingQuantity <= 0 || !deps.canEntitiesInteractLocally(entity, targetEntity)) {
      return refuseActivation("TARGET_NOT_FOUND");
    }
    const locked = typeof scene.getTargetsForEntity === "function" ? scene.getTargetsForEntity(entity) : [];
    if (!Array.isArray(locked) || !locked.includes(targetID)) return refuseActivation("TARGET_NOT_LOCKED");
    const nowMs = sceneNow(scene);
    const snapshot = buildSnapshot(entity, owner, moduleItem, effectRecord, nowMs);
    if (!snapshot) return refuseActivation("UNSUPPORTED_MODULE");
    if (!familyFits(snapshot, state)) return refuseActivation("TARGET_INVALID_FOR_MODULE");
    const resolved = twinModule(entity, moduleItem && moduleItem.itemID, moduleItem && moduleItem.flagID)
      || moduleItem;
    const chargeItem = twinCharge(entity, resolved);
    if (chargeItem && !(deps.isChargeCompatibleWithModule(resolved.typeID, chargeItem.typeID)
      && deps.isMiningSnapshotCompatibleWithState(snapshot, state))) {
      return refuseActivation("CHARGE_NOT_COMPATIBLE");
    }
    const actual = distanceOf(scene, entity, targetEntity);
    const rangeDecision = { desiredRange: snapshot.maxRangeMeters, actualDistance: actual,
      graceMeters: RANGE_GRACE_METERS, sampledAtSimTimeMs: nowMs };
    if (actual > snapshot.maxRangeMeters + RANGE_GRACE_METERS) {
      return refuseActivation("TARGET_OUT_OF_RANGE", { rangeDecision });
    }
    return {
      matched: true,
      success: true,
      data: {
        targetEntity,
        mineableState: state,
        runtimeAttrs: {
          capNeed: snapshot.capNeed,
          durationMs: snapshot.durationMs,
          durationAttributeID: snapshot.durationAttributeID,
          reactivationDelayMs: snapshot.reactivationDelayMs,
          maxGroupActive: snapshot.maxGroupActive,
          weaponFamily: null,
          miningSnapshot: snapshot,
        },
      },
    };
  }

  function settleYield(o) {
    const { scene, twin, owner, rock, state, efficiency } = o;
    const hold = holdOf(twin, owner);
    if (!hold) return { ok: false, code: "NO_HOLD" };
    const unitVolume = toNum(state.unitVolume, 0);
    if (!(unitVolume > 0)) return { ok: false, code: "UNIT" };
    const space = holdSpace(hold, toInt(state.yieldTypeID, 0), holdResolve());
    if (space.freeM3 <= 0) return { ok: false, code: "NO_ROOM" };
    const maxQuantity = Math.max(0, Math.floor(space.freeM3 / unitVolume));
    if (maxQuantity <= 0) return { ok: false, code: "NO_ROOM" };

    const miningVolume = Math.max(0, toNum(o.volume, 0));
    const effectiveVolume = miningVolume * efficiency;
    const clampFactor = Math.min(1, (state.remainingQuantity * unitVolume) / effectiveVolume,
      (maxQuantity * unitVolume) / effectiveVolume);
    if (!(clampFactor > 0)) return { ok: false, code: "CLAMP_ZERO" };
    const result = deps.computeMiningResult({
      clampFactor,
      volume: miningVolume,
      unitVolume,
      asteroidQuantity: state.remainingQuantity,
      wasteVolumeMultiplier: o.wasteVolumeMultiplier,
      wasteProbability: o.wasteProbability,
      critQuantityMultiplier: o.critQuantityMultiplier,
      critProbability: o.critProbability,
      efficiency,
    });
    result.normalQuantity = Math.min(result.normalQuantity, maxQuantity);
    result.criticalHitQuantity = Math.max(0, Math.min(result.criticalHitQuantity,
      Math.max(0, maxQuantity - result.normalQuantity)));
    result.criticalHitVolume = result.criticalHitQuantity * unitVolume;
    const transferred = result.getTotalTransferredQuantity();
    if (transferred <= 0 && result.wastedQuantity <= 0) return { ok: false, code: "NOTHING" };

    const typeID = toInt(state.yieldTypeID, 0);
    if (transferred > 0) {
      const added = holdAdd(hold, space.flag, typeID, transferred, unitVolume);
      if (!added.ok) return { ok: false, code: "NO_ROOM" };
    }
    const deltaOptions = {
      broadcast: true,
      nowMs: o.nowMs,
      sourceEntity: twin,
      moduleItem: o.moduleItem,
      quantityAdded: transferred,
      amountWasted: result.wastedQuantity,
      ...(o.droneDelta || { amountCritBonus: result.criticalHitQuantity, hasRewards: result.rewardedQuantity > 0 }),
    };
    let delta;
    try {
      delta = deps.applyMiningDelta(scene, rock, result.normalQuantity, result.wastedQuantity, deltaOptions);
    } catch (err) {
      if (transferred > 0) holdTake(hold, space.flag, typeID, transferred, unitVolume);
      throw err;
    }
    if (!delta || !delta.success) {
      if (transferred > 0) holdTake(hold, space.flag, typeID, transferred, unitVolume);
      return { ok: false, code: "DELTA_REFUSED" };
    }

    if (config.miningLedgerEnabled !== false) {
      try {
        const observer = ledgerObserver(scene, rock);
        deps.recordMiningLedgerEvent({
          characterID: owner.ownerCharacterId,
          corporationID: toInt(twin.corporationID, 0),
          solarSystemID: toInt(scene.systemID || scene.solarSystemID, toInt(twin.systemID, 0)),
          typeID,
          quantity: transferred,
          quantityWasted: result.wastedQuantity,
          quantityCritical: result.criticalHitQuantity,
          shipTypeID: toInt(twin.typeID, 0),
          moduleTypeID: o.ledgerModuleTypeID,
          observerItemID: observer.observerItemID,
          observerItemName: observer.observerItemName,
          yieldKind: state.yieldKind,
          eventDateMs: o.nowMs,
        });
      } catch (_err) {
        bump("mining.ledger.error");
      }
    }
    return { ok: true, typeID, transferred, unitVolume, result, delta };
  }

  function twinCycle(owner, scene, entity, effectState, cycleBoundaryMs, options) {
    const opts = options && typeof options === "object" ? options : {};
    if (!scene || !effectState) return stop("module");
    const efficiency = Math.min(1, Math.max(0, toNum(opts.efficiency, 1)));
    if (efficiency <= 0) return stop("cycle");

    const targetID = toInt(effectState.targetID, 0);
    const targetEntity = scene.getEntityByID(targetID);
    if (targetEntity && deps.isAirRock(targetEntity)) return stop("target");
    const state = deps.getMineableState(scene, targetID);
    if (!targetEntity || targetEntity.airMiningTargetable === false || !state || state.remainingQuantity <= 0
      || !deps.canEntitiesInteractLocally(entity, targetEntity)) {
      return stop("target");
    }
    const locked = typeof scene.getTargetsForEntity === "function" ? scene.getTargetsForEntity(entity) : [];
    if (!Array.isArray(locked) || !locked.includes(targetID)) return stop("target");

    const prepared = opts.preparedCycle;
    const cycle = prepared && prepared.moduleItem && prepared.snapshot
      && toInt(prepared.moduleItem.itemID, 0) === toInt(effectState.moduleID, 0)
      && toNum(prepared.cycleBoundaryMs, NaN) === toNum(cycleBoundaryMs, NaN)
      ? { success: true, data: prepared }
      : twinPrepare(owner, entity, effectState, cycleBoundaryMs);
    if (!cycle.success || !cycle.data) return cycle.stopReason ? { success: false, stopReason: cycle.stopReason }
      : stop("module");
    const { moduleItem, snapshot } = cycle.data;
    if (!moduleItem || !deps.isModuleOnline(moduleItem)) return stop("module");
    if (!snapshot || !familyFits(snapshot, state)) return stop("module");

    if (distanceOf(scene, entity, targetEntity) > snapshot.maxRangeMeters + RANGE_GRACE_METERS) return stop("range");
    const chargeItem = twinCharge(entity, moduleItem);
    if (chargeItem && !(deps.isChargeCompatibleWithModule(moduleItem.typeID, chargeItem.typeID)
      && deps.isMiningSnapshotCompatibleWithState(snapshot, state))) {
      return stop("charge");
    }
    if (chargeItem && crystalBurnedOut(chargeItem, snapshot, deps)) return stop("ammo");
    effectState.chargeTypeID = snapshot.chargeTypeID;

    const settled = settleYield({
      scene, twin: entity, owner, rock: targetEntity, state,
      volume: snapshot.miningAmountM3, efficiency,
      wasteVolumeMultiplier: snapshot.wasteVolumeMultiplier, wasteProbability: snapshot.wasteProbability,
      critQuantityMultiplier: snapshot.critQuantityMultiplier, critProbability: snapshot.critChance,
      nowMs: cycleBoundaryMs, moduleItem, droneDelta: null, ledgerModuleTypeID: toInt(moduleItem.typeID, 0),
    });
    if (!settled.ok) {
      if (settled.code === "CLAMP_ZERO") return stop(state.remainingQuantity <= 0 ? "target" : "cargo");
      return stop(TWIN_STOP[settled.code]);
    }
    const { typeID, transferred, result, delta } = settled;

    bump("mining.cycle.ok");
    return {
      success: true,
      data: {
        targetID,
        yieldTypeID: typeID,
        transferredQuantity: transferred,
        normalQuantity: result.normalQuantity,
        criticalHitQuantity: result.criticalHitQuantity,
        wastedQuantity: result.wastedQuantity,
        efficiency,
        partialCycle: opts.partialCycle === true,
        crystalResult: { success: true, data: { damaged: false, burnedOut: false } },
        stopReason: null,
        depleted: Boolean(delta.data && delta.data.depleted),
        nextCycleRuntimeAttrs: {
          capNeed: snapshot.capNeed,
          durationMs: snapshot.durationMs,
          durationAttributeID: snapshot.durationAttributeID,
        },
      },
    };
  }

  function droneRockState(scene, rockId) {
    deps.ensureSceneMiningState(scene);
    const rock = scene.getEntityByID(rockId);
    if (!rock || rock.airMiningTargetable === false || deps.isAirRock(rock)) return null;
    const state = deps.getMineableState(scene, rockId);
    if (!state || !(toNum(state.remainingQuantity, 0) > 0)) return null;
    return { rock, state };
  }

  function droneRock(scene, rockId) {
    if (!active) return { ok: false, reason: "HOOK_UNAVAILABLE" };
    try {
      const id = toInt(rockId, 0);
      const found = id > 0 && scene ? droneRockState(scene, id) : null;
      if (!found) return { ok: false, reason: "TARGET" };
      return { ok: true, yieldKind: String(found.state.yieldKind || "").trim().toLowerCase(),
        remaining: toNum(found.state.remainingQuantity, 0) };
    } catch (_err) {
      return { ok: false, reason: "ERROR" };
    }
  }

  function droneCycle(scene, twin, drone, input, rockId, simMs) {
    if (!active) return { ok: false, reason: "HOOK_UNAVAILABLE" };
    try {
      const owner = twinFor(twin);
      if (!owner) return { ok: false, reason: "NOT_A_TWIN" };
      const id = toInt(rockId, 0);
      const found = id > 0 && scene && drone ? droneRockState(scene, id) : null;
      if (!found || !deps.canEntitiesInteractLocally(drone, found.rock)) return { ok: false, reason: "TARGET" };
      const { rock, state } = found;
      const snapshot = input && input.snapshot;
      if (!snapshot || typeof snapshot !== "object") return { ok: false, reason: "ERROR" };
      if (String((input && input.yieldKind) || "") !== String(state.yieldKind || "").trim().toLowerCase()) {
        return { ok: false, reason: "KIND" };
      }
      const moduleItem = pseudoModuleItem(drone);
      const settled = settleYield({
        scene, twin, owner, rock, state,
        volume: snapshot.miningAmountM3, efficiency: 1,
        wasteVolumeMultiplier: toNum(snapshot.wasteVolumeMultiplier, 0),
        wasteProbability: toNum(snapshot.wasteProbability, 0),
        critQuantityMultiplier: 0, critProbability: 0,
        nowMs: simMs, moduleItem,
        droneDelta: { sourceDroneID: moduleItem.itemID, moduleItemID: moduleItem.itemID,
          moduleTypeID: moduleItem.typeID, moduleGroupID: moduleItem.groupID },
        ledgerModuleTypeID: moduleItem.typeID,
      });
      const typeId = toInt(state.yieldTypeID, 0);
      if (!settled.ok) {
        if (settled.code === "NOTHING") {
          return { ok: true, typeId, quantity: 0, wasted: 0, volumeM3: 0, depleted: false };
        }
        if (settled.code === "CLAMP_ZERO") {
          return { ok: false, reason: state.remainingQuantity <= 0 ? "TARGET" : "NO_ROOM" };
        }
        return { ok: false, reason: DRONE_REFUSAL_OF[settled.code] || "ERROR" };
      }
      return { ok: true, typeId, quantity: settled.transferred, wasted: settled.result.wastedQuantity,
        volumeM3: settled.transferred * settled.unitVolume,
        depleted: Boolean(settled.delta.data && settled.delta.data.depleted === true) };
    } catch (_err) {
      return { ok: false, reason: "ERROR" };
    }
  }

  const TWIN_PATH = {
    resolveMiningActivation(owner, args) {
      try {
        return twinActivation(owner, args[0], args[1], args[2], args[3], args[4]);
      } catch (_err) {
        bump("mining.cycle.error");
        return { matched: true, success: false, errorMsg: "UNSUPPORTED_MODULE" };
      }
    },
    prepareMiningCycleBoundary(owner, args) {
      try {
        return twinPrepare(owner, args[0], args[1], args[2]);
      } catch (_err) {
        bump("mining.cycle.error");
        return { success: false, stopReason: "mining" };
      }
    },
    executeMiningCycle(owner, args) {
      try {
        return twinCycle(owner, args[0], args[1], args[2], args[3], args[4]);
      } catch (_err) {
        bump("mining.cycle.error");
        return { success: false, stopReason: "mining" };
      }
    },
  };

  function makeWrapper(name, base) {
    const entityAt = WRAPPED_EXPORTS[name];
    const twinPath = TWIN_PATH[name];
    const wrapper = function shipWingMining() {
      if (!active) return base.apply(this, arguments);
      const owner = twinFor(arguments[entityAt]);
      if (!owner) return base.apply(this, arguments);
      return twinPath(owner, arguments);
    };
    for (const symbol of Object.getOwnPropertySymbols(base)) {
      if (symbol !== WRAPPED) wrapper[symbol] = base[symbol];
    }
    wrapper[WRAPPED] = true;
    return wrapper;
  }

  function install() {
    const names = Object.keys(WRAPPED_EXPORTS);
    if (!isObj(target) || names.some((name) => typeof target[name] !== "function") || !wing
      || typeof wing.twinOf !== "function" || typeof wing.liveTwinCount !== "function"
      || typeof wing.twinTaskContext !== "function") {
      return { ok: false, reason: "MINING_SEAM_UNAVAILABLE" };
    }
    if (installed || names.some((name) => target[name][WRAPPED] === true)) {
      return { ok: false, reason: "MINING_ALREADY_INSTALLED" };
    }
    const wrapped = [];
    for (const name of names) {
      const base = target[name];
      const wrapper = makeWrapper(name, base);
      try {
        target[name] = wrapper;
      } catch (_err) {
      }
      if (target[name] !== wrapper) {
        for (const done of wrapped) {
          if (target[done] === wrappers.get(done)) target[done] = originals.get(done);
        }
        return { ok: false, reason: "MINING_INSTALL_FAILED" };
      }
      originals.set(name, base);
      wrappers.set(name, wrapper);
      wrapped.push(name);
    }
    installed = true;
    active = true;
    return { ok: true, wrapped };
  }

  function uninstall() {
    active = false;
    for (const [name, wrapper] of wrappers) {
      if (target[name] === wrapper) target[name] = originals.get(name);
    }
    installed = false;
  }

  return Object.freeze({
    install,
    uninstall,
    isActive: () => active,
    stats: () => ({ counters: { ...counters } }),
    droneRock,
    droneCycle,
  });
}

function installMiningHook(input) {
  const hook = createMiningHook(input);
  const out = hook.install();
  return out.ok ? { ...out, hook } : out;
}

const MINING_MODULES = Object.freeze({
  miningRuntime: RUNTIME_MODULE,
  entityDogmaView: "space/runtime/entityDogmaView",
  miningDogma: "services/mining/miningDogma",
  miningMath: "services/mining/miningMath",
  miningRuntimeState: "services/mining/miningRuntimeState",
  miningInventory: "services/mining/miningInventory",
  miningLedgerState: "services/mining/miningLedgerState",
  airMiningSettlement: "services/mining/airMiningSettlement",
  interactionScope: "space/destiny/identity/interactionScope",
  commandBurstRuntime: "space/modules/commandBurstRuntime",
  wormholeEnvironmentRuntime: "services/exploration/wormholes/wormholeEnvironmentRuntime",
  liveFittingState: "services/fitting/liveFittingState",
  itemStore: "services/inventory/itemStore",
  crystalDurability: "services/dogma/crystalDurability",
});

function depsFromGame(g) {
  const late = (mod, name) => (...args) => g[mod][name](...args);
  return {
    buildRuntimeShipItemFromEntity: late("entityDogmaView", "buildRuntimeShipItemFromEntity"),
    buildMiningModuleSnapshot: late("miningDogma", "buildMiningModuleSnapshot"),
    isMiningEffectRecord: late("miningDogma", "isMiningEffectRecord"),
    isMiningSnapshotCompatibleWithState: late("miningRuntime", "isMiningSnapshotCompatibleWithState"),
    computeMiningResult: late("miningMath", "computeMiningResult"),
    getMineableState: late("miningRuntimeState", "getMineableState"),
    applyMiningDelta: late("miningRuntimeState", "applyMiningDelta"),
    ensureSceneMiningState: late("miningRuntimeState", "ensureSceneMiningState"),
    getPreferredMiningHoldFlagForType: late("miningInventory", "getPreferredMiningHoldFlagForType"),
    getShipHoldCapacityByFlag: late("miningInventory", "getShipHoldCapacityByFlag"),
    recordMiningLedgerEvent: late("miningLedgerState", "recordMiningLedgerEvent"),
    isAirRock: late("airMiningSettlement", "isAirRock"),
    canEntitiesInteractLocally: late("interactionScope", "canEntitiesInteractLocally"),
    collectModifierEntriesForItem: late("commandBurstRuntime", "collectModifierEntriesForItem"),
    getLocationModifierSourcesForSystem: late("wormholeEnvironmentRuntime", "getLocationModifierSourcesForSystem"),
    buildShipResourceState: late("liveFittingState", "buildShipResourceState"),
    getEffectTypeRecord: late("liveFittingState", "getEffectTypeRecord"),
    isModuleOnline: late("liveFittingState", "isModuleOnline"),
    isChargeCompatibleWithModule: late("liveFittingState", "isChargeCompatibleWithModule"),
    isCrystalBurnedOut: late("crystalDurability", "isCrystalBurnedOut"),
    buildCrystalDurabilitySnapshot: late("crystalDurability", "buildCrystalDurabilitySnapshot"),
    CARGO_HOLD: g.itemStore.ITEM_FLAGS.CARGO_HOLD,
  };
}

function installMiningHookFromGame(gameAdapter, input) {
  if (!gameAdapter || typeof gameAdapter.isConsumerAvailable !== "function"
    || !gameAdapter.isConsumerAvailable("mining")) {
    return { ok: false, reason: "probe_mining_unavailable" };
  }
  const game = {};
  for (const [key, rel] of Object.entries(MINING_MODULES)) {
    const loaded = gameAdapter.requireGame(rel);
    if (!loaded || !loaded.ok || !isObj(loaded.exports)) {
      return { ok: false, reason: `require_failed:${rel}:${loaded && loaded.reason}` };
    }
    game[key] = loaded.exports;
  }
  const flags = game.itemStore.ITEM_FLAGS;
  if (!isObj(flags) || !Number.isInteger(flags.CARGO_HOLD)) return { ok: false, reason: "no_cargo_hold_flag" };
  return installMiningHook({ miningRuntime: game.miningRuntime, deps: depsFromGame(game),
    wing: input && input.wing, config: input && input.config });
}

module.exports = {
  WRAPPED, RUNTIME_MODULE, WRAPPED_EXPORTS, SNAPSHOT_KEYS, CYCLE_STOP, ACTIVATE_REFUSAL, COUNTER_NAMES,
  DRONE_CYCLE_REFUSAL, MINING_MODULES, createMiningHook, installMiningHook, installMiningHookFromGame,
};
