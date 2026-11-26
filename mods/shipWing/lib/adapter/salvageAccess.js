"use strict";

const { distance: vecDistance } = require("../util/vec");

const SHIP_CATEGORY_ID = 6;
const MAX_RANGE_ATTRIBUTE_FALLBACK = 54;
const WRECK_KIND = "wreck";

const ACCESS_MODULES = Object.freeze({
  salvagerRuntime: "space/modules/salvagerRuntime",
  moduleActivationEffectRecord: "space/runtime/moduleActivationEffectRecord",
  liveFittingState: "services/fitting/liveFittingState",
  itemStore: "services/inventory/itemStore",
});

const COUNTER_NAMES = Object.freeze([
  "salvage.access.scan", "salvage.access.cargo.hostInvalid", "salvage.access.cargo.error",
]);

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

function round6(value) {
  return Math.round(Number(value) * 1e6) / 1e6;
}

function createSalvageAccess(input) {
  const deps = input.deps;
  const twinScene = input.scene;
  const config = input.config || {};
  const counters = Object.fromEntries(COUNTER_NAMES.map((name) => [name, 0]));
  let scan = null;

  function bump(name) {
    if (Object.prototype.hasOwnProperty.call(counters, name)) counters[name] += 1;
  }

  function salvagerModules(twin) {
    const fitted = Array.isArray(twin && twin.fittedItems) ? twin.fittedItems : [];
    const out = [];
    for (const module of fitted) {
      if (!module || !deps.isModuleOnline(module)) continue;
      const effectRecord = deps.resolveDefaultActivationEffect(toInt(module.typeID, 0));
      if (!effectRecord || !deps.isModuleSalvagingEffectRecord(effectRecord)) continue;
      out.push({ moduleId: toInt(module.itemID, 0), module, effectName: String(effectRecord.name || "salvaging") });
    }
    return out.sort((a, b) => a.moduleId - b.moduleId);
  }

  function workRangeM(scene, twin) {
    const attr = toInt(deps.maxRangeAttributeID, 0) || MAX_RANGE_ATTRIBUTE_FALLBACK;
    let range = Infinity;
    for (const mod of salvagerModules(twin)) {
      const attrs = deps.getTypeAttributeMap(toInt(mod.module.typeID, 0)) || {};
      const value = Math.max(0, toNum(attrs[attr], 0));
      if (value < range) range = value;
    }
    if (!Number.isFinite(range) || range <= 0) return 0;
    const lock = twinScene.lockRange(scene, twin);
    const reach = lock > 0 ? Math.min(range, lock) : range;
    return Math.max(0, reach - Math.max(0, toNum(config.miningRangeBufferMeters, 0)));
  }

  function isWreckLike(ent) {
    return Boolean(ent && (String(ent.kind || "").trim() === WRECK_KIND || ent.nativeNpcWreck === true));
  }

  function isSalvageable(scene, wreckId) {
    const ent = twinScene.entity(scene, wreckId);
    return Boolean(isWreckLike(ent) && deps.isSalvageableTarget(ent));
  }

  function sceneEntities(scene) {
    if (typeof scene.getAllVisibleEntities === "function") return scene.getAllVisibleEntities() || [];
    return [...(Array.isArray(scene.staticEntities) ? scene.staticEntities : []),
      ...(scene.dynamicEntities instanceof Map ? scene.dynamicEntities.values() : [])];
  }

  function wrecksOf(scene) {
    const nowMs = twinScene.simNow(scene);
    if (scan && scan.scene === scene && scan.nowMs === nowMs) return scan.wrecks;
    bump("salvage.access.scan");
    const wrecks = [];
    for (const ent of sceneEntities(scene)) {
      if (!isWreckLike(ent) || toInt(ent.itemID, 0) <= 0) continue;
      if (deps.isSalvageableTarget(ent)) wrecks.push(ent);
    }
    scan = { scene, nowMs, wrecks };
    return wrecks;
  }

  function candidates(scene, host, rangeM) {
    const hostPos = host && host.position;
    if (!scene || !hostPos) return [];
    const limit = Math.max(0, toNum(rangeM, 0));
    const out = [];
    for (const ent of wrecksOf(scene)) {
      const distanceM = vecDistance(ent.position, hostPos);
      if (distanceM <= limit) out.push({ wreckId: toInt(ent.itemID, 0), distanceM });
    }
    return out.sort((a, b) => (a.distanceM - b.distanceM) || (a.wreckId - b.wreckId));
  }

  function wreckDistanceM(scene, a, wreckId) {
    const pos = a && a.position;
    if (!pos) return { ok: false, reason: "NO_HOST" };
    const ent = twinScene.entity(scene, wreckId);
    if (!ent || !ent.position) return { ok: false, reason: "NO_WRECK" };
    return { ok: true, distanceM: vecDistance(ent.position, pos) };
  }

  function usedVolume(ownerCharacterId, hostShipId) {
    let used = 0;
    for (const item of deps.listContainerItems(ownerCharacterId, hostShipId, deps.CARGO_HOLD) || []) {
      if (!item) continue;
      const units = toInt(item.singleton, 0) === 1 ? 1 : Math.max(0, toInt(item.stacksize ?? item.quantity, 0));
      used += Math.max(0, toNum(item.volume, 0)) * units;
    }
    return used;
  }

  function hostCargoFreeM3(ownerCharacterId, hostShipId) {
    try {
      const owner = toInt(ownerCharacterId, 0);
      const id = toInt(hostShipId, 0);
      const host = owner > 0 && id > 0 ? deps.findItemById(id) : null;
      if (!isObj(host) || toInt(host.ownerID, 0) !== owner || toInt(host.categoryID, 0) !== SHIP_CATEGORY_ID) {
        bump("salvage.access.cargo.hostInvalid");
        return { ok: false, reason: "HOST_INVALID" };
      }
      const rs = deps.buildShipResourceState(owner, host);
      const capacity = Math.max(0, toNum(rs && rs.cargoCapacity, 0));
      return { ok: true, freeM3: Math.max(0, round6(capacity - usedVolume(owner, id))) };
    } catch (_err) {
      bump("salvage.access.cargo.error");
      return { ok: false, reason: "ERROR" };
    }
  }

  return Object.freeze({
    salvagerModules, workRangeM, candidates, isSalvageable, wreckDistanceM, hostCargoFreeM3,
    stats: () => ({ counters: { ...counters } }),
  });
}

function depsFromGame(g) {
  const late = (mod, name) => (...args) => g[mod][name](...args);
  const attr = typeof g.liveFittingState.getAttributeIDByNames === "function"
    ? toInt(g.liveFittingState.getAttributeIDByNames("maxRange"), 0) : 0;
  return {
    isSalvageableTarget: late("salvagerRuntime", "isSalvageableTarget"),
    isModuleSalvagingEffectRecord: late("salvagerRuntime", "isModuleSalvagingEffectRecord"),
    resolveDefaultActivationEffect: late("moduleActivationEffectRecord", "resolveDefaultActivationEffect"),
    isModuleOnline: late("liveFittingState", "isModuleOnline"),
    getTypeAttributeMap: late("liveFittingState", "getTypeAttributeMap"),
    maxRangeAttributeID: attr || MAX_RANGE_ATTRIBUTE_FALLBACK,
    buildShipResourceState: late("liveFittingState", "buildShipResourceState"),
    listContainerItems: late("itemStore", "listContainerItems"),
    findItemById: late("itemStore", "findItemById"),
    CARGO_HOLD: g.itemStore.ITEM_FLAGS.CARGO_HOLD,
  };
}

function createSalvageAccessFromGame(gameAdapter, input) {
  if (!gameAdapter || typeof gameAdapter.isConsumerAvailable !== "function"
    || !gameAdapter.isConsumerAvailable("salvage")) {
    return { ok: false, reason: "probe_salvage_unavailable" };
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
  if (!isObj(flags) || !Number.isInteger(flags.CARGO_HOLD)) return { ok: false, reason: "no_cargo_hold_flag" };
  return { ok: true, access: createSalvageAccess({ deps: depsFromGame(game), scene: input && input.scene,
    config: input && input.config }) };
}

module.exports = { ACCESS_MODULES, COUNTER_NAMES, SHIP_CATEGORY_ID, createSalvageAccess, createSalvageAccessFromGame };
