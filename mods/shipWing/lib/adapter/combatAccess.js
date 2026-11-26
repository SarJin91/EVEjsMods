"use strict";

const { twinModule, twinCharge } = require("./twinDogma");
const { isAllowedTarget, TARGET_REFUSAL } = require("../core/targetPolicy");
const { cycleFail } = require("../core/cycleSchedule");
const { AMMO_RECEIPT_PREFIX, AMMO_RECEIPT_OPERATION } = require("../core/combatTask");
const { createWeaponRegistry } = require("./weapons/registry");
const { createTurretHandler } = require("./weapons/turret");
const { createMissileHandler, MISSILE_COUNTER_NAMES } = require("./weapons/missile");
const { createPrecursorHandler, PRECURSOR_COUNTER_NAMES } = require("./weapons/precursor");
const { createVortonHandler, VORTON_COUNTER_NAMES } = require("./weapons/vorton");
const { createAreaHandler, AREA_COUNTER_NAMES } = require("./weapons/area");
const { createBreacherHandler, createBombHandler, PROJECTILE_COUNTER_NAMES } = require("./weapons/projectile");

const ACCESS_MODULES = Object.freeze({
  weaponSnapshot: "space/runtime/weaponSnapshot",
  targetDamageApplication: "space/runtime/targetDamageApplication",
  killmailTracker: "space/combat/killmailTracker",
  weaponDogma: "space/combat/weaponDogma",
  precursorTurrets: "space/combat/precursorTurrets",
  damage: "space/combat/damage",
  combatDestruction: "space/runtime/combatDestruction",
  combatDamageMessages: "space/runtime/combatDamageMessages",
  entityDogmaView: "space/runtime/entityDogmaView",
  wormholeEnvironmentRuntime: "services/exploration/wormholes/wormholeEnvironmentRuntime",
  crystalDurability: "services/dogma/crystalDurability",
  liveFittingState: "services/fitting/liveFittingState",
  itemStore: "services/inventory/itemStore",
  interactionScope: "space/destiny/identity/interactionScope",
});
const VORTON_MODULES = Object.freeze({
  vortonProjectors: "space/combat/vortonProjectors",
  moduleSpecialFx: "space/runtime/moduleSpecialFx",
});
const AREA_MODULES = Object.freeze({
  smartbombRuntime: "space/modules/smartbombRuntime",
  pointDefenseRuntime: "space/modules/pointDefenseRuntime",
  moduleRuntimeCallbacks: "space/runtime/moduleRuntimeCallbacks",
  moduleActivationEffectRecord: "space/runtime/moduleActivationEffectRecord",
  systemSecurity: "services/security/systemSecurity",
  moduleSpecialFx: "space/runtime/moduleSpecialFx",
});
const BREACHER_MODULES = Object.freeze({
  breacherPods: "space/combat/breacherPods",
  moduleRuntimeCallbacks: "space/runtime/moduleRuntimeCallbacks",
});
const BOMB_MODULES = Object.freeze({
  bombRuntime: "space/modules/bombRuntime",
  moduleRuntimeCallbacks: "space/runtime/moduleRuntimeCallbacks",
});
const CONSUMER_MODULES = Object.freeze({ combatVorton: VORTON_MODULES, combatArea: AREA_MODULES,
  combatBreacher: BREACHER_MODULES, combatBomb: BOMB_MODULES });

const SKIP_REASONS = Object.freeze(["NO_AMMO", "NO_SNAPSHOT", "UNSUPPORTED_FAMILY", "TARGET_GONE", "OUT_OF_RANGE",
  "HIGHSEC", "BYSTANDER", "NO_TARGETS", "VENDOR_REFUSED", "BREACHER_TARGET_INVALID"]);
const UNSUPPORTED_IDS = Object.freeze(["defender", "superweapon", "precursor", "vorton", "missile", "area",
  "breacher", "bomb", "OTHER"]);
const PROJECTILE_IDS = Object.freeze({ breacherPodLauncher: "breacher", bombLauncher: "bomb" });
const MISSILE_FAMILIES = Object.freeze(["missileLauncher", "festivalLauncher"]);

const COMBAT_COUNTER_NAMES = Object.freeze([
  "combat.volley.fired", "combat.volley.hit", "combat.volley.miss", "combat.volley.kill", "combat.volley.error",
  ...SKIP_REASONS.map((r) => `combat.volley.skip.${r}`),
  "combat.fx.error",
  ...TARGET_REFUSAL.map((r) => `combat.target.refused.${r}`),
  "combat.target.structure",
  "combat.ammo.receipts.pruned", "combat.ammo.receipts.pruneFailed",
  ...UNSUPPORTED_IDS.map((id) => `combat.weapons.unsupported.${id}`),
  ...MISSILE_COUNTER_NAMES,
  ...PRECURSOR_COUNTER_NAMES,
  ...VORTON_COUNTER_NAMES,
  ...AREA_COUNTER_NAMES,
  ...PROJECTILE_COUNTER_NAMES,
  "combat.auto.scan.truncated", "combat.auto.scan.error",
]);

function toInt(value, fallback = 0) {
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) ? n : fallback;
}

function isObj(value) {
  return value !== null && typeof value === "object";
}

function createCombatAccess(input) {
  const deps = input.deps;
  const twinScene = input.scene;
  const config = input.config || {};
  const isConsumerAvailable = typeof input.isConsumerAvailable === "function" ? input.isConsumerAvailable
    : () => true;
  const counters = Object.fromEntries(COMBAT_COUNTER_NAMES.map((name) => [name, 0]));

  function count(name) {
    if (Object.prototype.hasOwnProperty.call(counters, name)) counters[name] += 1;
  }

  function skip(reason, retryMs) {
    count(`combat.volley.skip.${reason}`);
    return cycleFail(reason, retryMs);
  }

  const env = { deps, config, twinScene, count, skip, targetAllowed, npcAllowed };
  const registry = createWeaponRegistry({
    handlers: [createTurretHandler(env), createMissileHandler(env), createPrecursorHandler(env),
      createVortonHandler(env), createAreaHandler(env), createBreacherHandler(env), createBombHandler(env)],
    isEnabled: (handler) => (handler.configKey === null || config[handler.configKey] === true)
      && isConsumerAvailable(handler.consumer) === true,
    classify: unsupportedOf,
  });

  function unsupportedOf(module, charge, family) {
    if (!family) return null;
    const name = String(family);
    if (deps.isVortonWeaponFamily(name) === true) return "vorton";
    if (deps.isPrecursorTurretFamily(name) === true) return "precursor";
    if (Object.prototype.hasOwnProperty.call(PROJECTILE_IDS, name)) return PROJECTILE_IDS[name];
    if (MISSILE_FAMILIES.includes(name)) {
      let isDefender = false;
      try {
        isDefender = deps.isDefenderMissileWeaponSnapshot({ moduleGroupID: toInt(module && module.groupID, 0),
          chargeGroupID: toInt(charge && charge.groupID, 0) }) === true;
      } catch (_err) {
        isDefender = false;
      }
      return isDefender ? "defender" : "missile";
    }
    return "OTHER";
  }

  function listWeapons(twin, opts = {}) {
    const fitted = Array.isArray(twin && twin.fittedItems) ? twin.fittedItems : [];
    const out = [];
    for (const module of fitted) {
      if (!module || toInt(module.itemID, 0) <= 0 || !deps.isModuleOnline(module)) continue;
      const charge = twinCharge(twin, module);
      const family = deps.resolveWeaponFamily(module, charge);
      const handler = registry.handlerFor(module, charge, family);
      if (!handler) {
        const id = opts && opts.countUnsupported === true ? registry.unsupportedId(module, charge, family) : null;
        if (id) count(`combat.weapons.unsupported.${UNSUPPORTED_IDS.includes(id) ? id : "OTHER"}`);
        continue;
      }
      const weapon = { moduleId: toInt(module.itemID, 0), flagId: toInt(module.flagID, 0), family: String(family),
        kind: handler.id, steers: handler.steers === true, needsLock: handler.needsLock === true,
        needsAmmo: handler.needsAmmo(module, charge) === true,
        chargeItemId: toInt(charge && charge.itemID, 0), chargeQuantity: chargeQuantity(charge) };
      if (handler.keepsMoving === true) weapon.keepsMoving = true;
      if (typeof handler.createState === "function") weapon.state = handler.createState(module, charge, family);
      out.push(weapon);
    }
    return out.sort((a, b) => a.flagId - b.flagId || a.moduleId - b.moduleId);
  }

  function weaponKinds() {
    return registry.kinds();
  }

  function chargeQuantity(charge) {
    if (!charge) return 0;
    const q = toInt(charge.quantity, NaN);
    return Math.max(0, Number.isFinite(q) ? q : toInt(charge.stacksize, 0));
  }

  function weaponRange(twin, weapon) {
    try {
      const module = twinModule(twin, weapon && weapon.moduleId, weapon && weapon.flagId);
      if (!module) return { ok: false, reason: "NO_SNAPSHOT" };
      const charge = twinCharge(twin, module);
      const handler = registry.handlerFor(module, charge, deps.resolveWeaponFamily(module, charge));
      if (!handler) return { ok: false, reason: "UNSUPPORTED_FAMILY" };
      return handler.range(twin, weapon, { module, charge });
    } catch (_err) {
      count("combat.volley.error");
      return { ok: false, reason: "ERROR" };
    }
  }

  function targetGone(scene, target) {
    if (!target || toInt(target.itemID, 0) <= 0) return true;
    if (!scene || typeof scene.getEntityByID !== "function" || scene.getEntityByID(toInt(target.itemID, 0)) !== target) {
      return true;
    }
    return deps.isRuntimeEntityDestroyingOrDestroyed(target) === true;
  }

  function volley(scene, twin, weapon, target, simMs, opts) {
    if (targetGone(scene, target)) return skip("TARGET_GONE", null);
    const module = twinModule(twin, weapon && weapon.moduleId, weapon && weapon.flagId);
    if (!module) return skip("NO_SNAPSHOT", null);
    const charge = twinCharge(twin, module);
    const family = deps.resolveWeaponFamily(module, charge);
    const handler = registry.handlerFor(module, charge, family);
    if (!handler) return skip("UNSUPPORTED_FAMILY", null);
    const ammoLeft = opts && Number.isFinite(Number(opts.ammoLeft)) ? Number(opts.ammoLeft) : Infinity;
    const host = opts && isObj(opts.host) ? opts.host : null;
    return handler.fire(scene, twin, weapon, target, simMs, { ammoLeft, module, charge, family, host });
  }

  function fireVolley(scene, twin, weapon, target, simMs, opts) {
    try {
      return volley(scene, twin, weapon, target, simMs, opts);
    } catch (_err) {
      count("combat.volley.error");
      return cycleFail("ERROR", null);
    }
  }

  function evaluateTarget(scene, twin, host, target, ignoreHost = false, allowStructures = false) {
    try {
      const id = toInt(target && target.itemID, 0);
      const inScene = Boolean(scene && id > 0 && typeof scene.getEntityByID === "function"
        && scene.getEntityByID(id) === target);
      let hostDistanceM = inScene && host ? twinScene.surfaceDistance(scene, host, target) : Infinity;
      if (ignoreHost === true) hostDistanceM = 0;
      return isAllowedTarget(target, {
        twin, host, config, sameScene: inScene,
        hostDistanceM,
        destroying: Boolean(target) && deps.isRuntimeEntityDestroyingOrDestroyed(target) === true,
        interacts: inScene && isObj(twin) && deps.canEntitiesInteractLocally(twin, target) === true,
        allowStructures: allowStructures === true,
        damageable: allowStructures === true && config.combatAllowNpcStructureTargets === true && Boolean(target)
          && target.kind !== "ship" && deps.hasDamageableHealth(target) === true,
      });
    } catch (_err) {
      return { ok: false, reason: "NO_TARGET" };
    }
  }

  function checkTarget(scene, twin, host, target) {
    const result = evaluateTarget(scene, twin, host, target, false, true);
    if (!result.ok) count(`combat.target.refused.${result.reason}`);
    else if (target.kind !== "ship") count("combat.target.structure");
    return result;
  }

  function targetAllowed(scene, twin, host, entity) {
    return evaluateTarget(scene, twin, host, entity, false, false).ok === true;
  }

  function npcAllowed(scene, twin, entity) {
    return evaluateTarget(scene, twin, null, entity, true, false).ok === true;
  }

  function hostWeaponTargets(host) {
    const effects = host && host.activeModuleEffects;
    if (!(effects instanceof Map)) return [];
    const ids = new Set();
    for (const state of effects.values()) {
      if (!state || !String(state.weaponFamily || "").trim()) continue;
      const id = toInt(state.targetID, 0);
      if (id > 0) ids.add(id);
    }
    return [...ids].sort((a, b) => a - b);
  }

  function threatsOf(scene, entity) {
    if (!scene || !entity || typeof scene.getTargetersForEntity !== "function") return [];
    const out = scene.getTargetersForEntity(entity);
    return Array.isArray(out) ? out.map((id) => toInt(id, 0)).filter((id) => id > 0).sort((a, b) => a - b) : [];
  }

  function autoAvailable() {
    try {
      return isConsumerAvailable("combatAuto") === true;
    } catch (_err) {
      return false;
    }
  }

  function autoCandidates(scene, twin, host, opts) {
    if (!autoAvailable()) return { ok: false, reason: "UNAVAILABLE" };
    if (!isObj(host)) return { ok: false, reason: "NO_HOST" };
    try {
      if (!scene || !(scene.dynamicEntities instanceof Map)) {
        count("combat.auto.scan.error");
        return { ok: false, reason: "NO_SCENE" };
      }
      const rangeM = Number(opts && opts.rangeM);
      const maxEntities = Math.max(0, toInt(opts && opts.maxEntities, 0));
      const candidates = [];
      let scanned = 0;
      let truncated = false;
      for (const entity of scene.dynamicEntities.values()) {
        if (scanned >= maxEntities) {
          truncated = true;
          break;
        }
        scanned += 1;
        if (!isObj(entity) || entity === twin || entity === host) continue;
        if (entity.kind !== "ship" || entity.nativeNpc !== true) continue;
        const id = toInt(entity.itemID, 0);
        if (id <= 0) continue;
        const hostDistanceM = Number(twinScene.surfaceDistance(scene, host, entity));
        if (!Number.isFinite(hostDistanceM) || !(hostDistanceM <= rangeM)) continue;
        if (evaluateTarget(scene, twin, host, entity).ok !== true) continue;
        candidates.push({ id, hostDistanceM });
      }
      if (truncated) count("combat.auto.scan.truncated");
      return { ok: true, candidates, scanned, truncated };
    } catch (_err) {
      count("combat.auto.scan.error");
      return { ok: false, reason: "ERROR" };
    }
  }

  function isGone(scene, entity) {
    try {
      return targetGone(scene, entity);
    } catch (_err) {
      return true;
    }
  }

  function consumeAmmo(realItemId, quantity, options) {
    try {
      const out = deps.consumeInventoryItemQuantityIdempotent(toInt(realItemId, 0), toInt(quantity, 0), {
        receiptKey: options && options.receiptKey, fingerprint: options && options.fingerprint,
      });
      if (out && out.success === true) {
        const changes = out.data && Array.isArray(out.data.changes) ? out.data.changes : [];
        return { ok: true, duplicate: out.duplicate === true, changes };
      }
      return { ok: false, reason: String((out && out.errorMsg) || "WRITE_FAILED") };
    } catch (_err) {
      return { ok: false, reason: "ERROR" };
    }
  }

  function pruneAmmoReceipts(isDead, maxRemove) {
    const cap = Math.max(0, toInt(maxRemove, 0));
    if (typeof isDead !== "function" || cap <= 0) return { ok: false, reason: "INVALID_PRUNE_INPUT" };
    let taken = 0;
    let left = false;
    try {
      const out = deps.pruneIdempotentGrantReceipts((receipt) => {
        if (left || !isObj(receipt) || receipt.operation !== AMMO_RECEIPT_OPERATION) return false;
        if (typeof receipt.receiptKey !== "string" || !receipt.receiptKey.startsWith(AMMO_RECEIPT_PREFIX)) return false;
        if (isDead(receipt) !== true) return false;
        if (taken >= cap) {
          left = true;
          return false;
        }
        taken += 1;
        return true;
      });
      if (out && out.success === true) {
        const removed = Math.max(0, toInt(out.removed, 0));
        counters["combat.ammo.receipts.pruned"] += removed;
        return { ok: true, removed, capped: left };
      }
      count("combat.ammo.receipts.pruneFailed");
      return { ok: false, reason: String((out && out.errorMsg) || "PRUNE_FAILED") };
    } catch (_err) {
      count("combat.ammo.receipts.pruneFailed");
      return { ok: false, reason: "ERROR" };
    }
  }

  function stats() {
    return { counters: { ...counters } };
  }

  return Object.freeze({
    listWeapons, fireVolley, checkTarget, hostWeaponTargets, threatsOf, stats, weaponRange, isGone, consumeAmmo,
    pruneAmmoReceipts, weaponKinds, autoAvailable, autoCandidates,
  });
}

function depsFromGame(g) {
  const late = (mod, name) => (...args) => g[mod][name](...args);
  const optional = (mod, name) => (isObj(g[mod]) && typeof g[mod][name] === "function" ? late(mod, name)
    : undefined);
  return {
    get broadcastVortonCycleSpecialFx() {
      return optional("moduleSpecialFx", "broadcastVortonCycleSpecialFx");
    },
    get buildGenericModuleSpecialFxGraphicInfo() {
      return optional("moduleSpecialFx", "buildGenericModuleSpecialFxGraphicInfo");
    },
    get isBreacherPodTarget() {
      return optional("breacherPods", "isBreacherPodTarget");
    },
    buildWeaponSnapshotForEntity: late("weaponSnapshot", "buildWeaponSnapshotForEntity"),
    resolveTurretShotWithConfiguredAdditive: late("weaponSnapshot", "resolveTurretShotWithConfiguredAdditive"),
    applyWeaponDamageToTarget: late("targetDamageApplication", "applyWeaponDamageToTarget"),
    killmailTracker: g.killmailTracker,
    getAppliedDamageAmount: late("combatDamageMessages", "getAppliedDamageAmount"),
    resolveWeaponFamily: late("weaponDogma", "resolveWeaponFamily"),
    isTurretCycleWeaponFamily: late("weaponDogma", "isTurretCycleWeaponFamily"),
    isVortonWeaponFamily: late("weaponDogma", "isVortonWeaponFamily"),
    isChargeOptionalTurretWeapon: late("weaponDogma", "isChargeOptionalTurretWeapon"),
    resolveWeaponSpecialFxGUID: late("weaponDogma", "resolveWeaponSpecialFxGUID"),
    isPrecursorTurretFamily: late("precursorTurrets", "isPrecursorTurretFamily"),
    isMissileWeaponFamily: late("weaponDogma", "isMissileWeaponFamily"),
    isDefenderMissileWeaponSnapshot: late("weaponDogma", "isDefenderMissileWeaponSnapshot"),
    synchronizePrecursorTurretEffectState: late("precursorTurrets", "synchronizePrecursorTurretEffectState"),
    advancePrecursorTurretSpool: late("precursorTurrets", "advancePrecursorTurretSpool"),
    resetPrecursorTurretSpool: late("precursorTurrets", "resetPrecursorTurretSpool"),
    applyPrecursorTurretSpoolToSnapshot: late("precursorTurrets", "applyPrecursorTurretSpoolToSnapshot"),
    buildPrecursorTurretGraphicInfo: late("precursorTurrets", "buildPrecursorTurretGraphicInfo"),
    resolveVortonShot: late("vortonProjectors", "resolveVortonShot"),
    resolveVortonArcShot: late("vortonProjectors", "resolveVortonArcShot"),
    selectVortonArcTargets: late("vortonProjectors", "selectVortonArcTargets"),
    isSmartbombEffect: late("smartbombRuntime", "isSmartbombEffect"),
    resolveSmartbombActivation: late("smartbombRuntime", "resolveSmartbombActivation"),
    executeSmartbombCycle: late("smartbombRuntime", "executeSmartbombCycle"),
    isPointDefenseEffect: late("pointDefenseRuntime", "isPointDefenseEffect"),
    resolvePointDefenseActivation: late("pointDefenseRuntime", "resolvePointDefenseActivation"),
    executePointDefenseCycle: late("pointDefenseRuntime", "executePointDefenseCycle"),
    buildSmartbombRuntimeCallbacks: late("moduleRuntimeCallbacks", "buildSmartbombRuntimeCallbacks"),
    buildPointDefenseRuntimeCallbacks: late("moduleRuntimeCallbacks", "buildPointDefenseRuntimeCallbacks"),
    resolveDefaultActivationEffect: late("moduleActivationEffectRecord", "resolveDefaultActivationEffect"),
    isHighSecuritySystem: late("systemSecurity", "isHighSecuritySystem"),
    stageBreacherLaunch: late("breacherPods", "stageLaunch"),
    isValidBreacherSnapshot: late("breacherPods", "validSnapshot"),
    isBombLauncher: late("bombRuntime", "isBombLauncher"),
    resolveBombLauncherActivation: late("bombRuntime", "resolveBombLauncherActivation"),
    executeBombLaunchCycle: late("bombRuntime", "executeBombLaunchCycle"),
    buildBombRuntimeCallbacks: late("moduleRuntimeCallbacks", "buildBombRuntimeCallbacks"),
    hasDamageableHealth: late("damage", "hasDamageableHealth"),
    isRuntimeEntityDestroyingOrDestroyed: late("combatDestruction", "isRuntimeEntityDestroyingOrDestroyed"),
    buildRuntimeShipItemFromEntity: late("entityDogmaView", "buildRuntimeShipItemFromEntity"),
    getLocationModifierSourcesForSystem: late("wormholeEnvironmentRuntime", "getLocationModifierSourcesForSystem"),
    isCrystalBurnedOut: late("crystalDurability", "isCrystalBurnedOut"),
    buildCrystalDurabilitySnapshot: late("crystalDurability", "buildCrystalDurabilitySnapshot"),
    getTypeDogmaAttributes: late("liveFittingState", "getTypeDogmaAttributes"),
    isModuleOnline: late("liveFittingState", "isModuleOnline"),
    consumeInventoryItemQuantityIdempotent: late("itemStore", "consumeInventoryItemQuantityIdempotent"),
    pruneIdempotentGrantReceipts: late("itemStore", "pruneIdempotentGrantReceipts"),
    canEntitiesInteractLocally: late("interactionScope", "canEntitiesInteractLocally"),
  };
}

function createCombatAccessFromGame(gameAdapter, input) {
  if (!gameAdapter || typeof gameAdapter.isConsumerAvailable !== "function"
    || !gameAdapter.isConsumerAvailable("combat")) {
    return { ok: false, reason: "probe_combat_unavailable" };
  }
  const game = {};
  for (const [key, rel] of Object.entries(ACCESS_MODULES)) {
    const loaded = gameAdapter.requireGame(rel);
    if (!loaded || !loaded.ok || !isObj(loaded.exports)) {
      return { ok: false, reason: `require_failed:${rel}:${loaded && loaded.reason}` };
    }
    game[key] = loaded.exports;
  }
  const loadedConsumers = new Set();
  for (const [consumer, modules] of Object.entries(CONSUMER_MODULES)) {
    if (gameAdapter.isConsumerAvailable(consumer) !== true) continue;
    const part = {};
    let ok = true;
    for (const [key, rel] of Object.entries(modules)) {
      if (isObj(game[key])) {
        part[key] = game[key];
        continue;
      }
      const loaded = gameAdapter.requireGame(rel);
      if (!loaded || !loaded.ok || !isObj(loaded.exports)) {
        ok = false;
        break;
      }
      part[key] = loaded.exports;
    }
    if (!ok) continue;
    Object.assign(game, part);
    loadedConsumers.add(consumer);
  }
  return { ok: true, access: createCombatAccess({ deps: depsFromGame(game), scene: input && input.scene,
    config: input && input.config,
    isConsumerAvailable: (name) => (!Object.prototype.hasOwnProperty.call(CONSUMER_MODULES, name)
      || loadedConsumers.has(name)) && gameAdapter.isConsumerAvailable(name) === true }) };
}

module.exports = {
  ACCESS_MODULES, VORTON_MODULES, AREA_MODULES, BREACHER_MODULES, BOMB_MODULES, COMBAT_COUNTER_NAMES, UNSUPPORTED_IDS, createCombatAccess,
  createCombatAccessFromGame,
};
