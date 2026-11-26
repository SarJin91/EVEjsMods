"use strict";

const { twinShipItem, twinModule } = require("./twinDogma");
const { cycleOk, cycleFail } = require("../core/cycleSchedule");

const EWAR_MODULES = Object.freeze({
  hostileModuleRuntime: "space/modules/hostileModuleRuntime",
  moduleRuntimeCallbacks: "space/runtime/moduleRuntimeCallbacks",
  entityDogmaView: "space/runtime/entityDogmaView",
});

const EWAR_FAMILY_KIND = Object.freeze({ energyNosferatu: "nos", energyNeutralizer: "neut",
  stasisWebifier: "web", warpScrambler: "scram", warpDisruptor: "disrupt" });
const EWAR_KIND = Object.freeze(["nos", "neut", "web", "scram", "disrupt"]);
const EWAR_REASON = Object.freeze(["TARGET_REQUIRED", "TARGET_NOT_FOUND", "TARGET_NOT_LOCKED",
  "TARGET_OUT_OF_RANGE", "UNSUPPORTED_MODULE", "OTHER", "ERROR"]);
const VENDOR_REASON = Object.freeze(EWAR_REASON.filter((r) => r !== "OTHER" && r !== "ERROR"));
const ENERGY_KINDS = Object.freeze(["nos", "neut"]);
const EWAR_ACCESS_COUNTER_NAMES = Object.freeze(["ewar.access.error", "ewar.fx.error", "ewar.release.ok",
  "ewar.release.error", "ewar.release.targetGone", "ewar.orphan.released"]);

function toInt(value, fallback = 0) {
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) ? n : fallback;
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function isObj(value) {
  return value !== null && typeof value === "object";
}

function reasonOf(result) {
  const msg = isObj(result) && typeof result.errorMsg === "string" ? result.errorMsg : "";
  return VENDOR_REASON.includes(msg) ? msg : "OTHER";
}

function kindOfState(effectState) {
  const family = isObj(effectState) ? String(effectState.hostileFamily || "") : "";
  return Object.prototype.hasOwnProperty.call(EWAR_FAMILY_KIND, family) ? EWAR_FAMILY_KIND[family] : null;
}

function createEwarAccess(input) {
  const deps = input.deps;
  const config = input.config || {};
  const counters = Object.fromEntries(EWAR_ACCESS_COUNTER_NAMES.map((name) => [name, 0]));
  const applied = new Map();

  function count(name, by = 1) {
    if (Object.prototype.hasOwnProperty.call(counters, name)) counters[name] += by;
  }

  function keyOf(twinId, effectState) {
    return `${toInt(twinId, 0)}:${toInt(isObj(effectState) ? effectState.moduleID : 0, 0)}`;
  }

  function familyOf(effectRecord) {
    try {
      const definition = isObj(effectRecord) ? deps.resolveHostileDefinition(effectRecord) : null;
      if (!isObj(definition)) return null;
      const family = String(definition.family || "");
      return Object.prototype.hasOwnProperty.call(EWAR_FAMILY_KIND, family) ? EWAR_FAMILY_KIND[family] : "other";
    } catch (_err) {
      count("ewar.access.error");
      return null;
    }
  }

  function callbacksFor(scene, twin, isAllowed, extra = {}) {
    const allowed = typeof isAllowed === "function" ? isAllowed : () => false;
    const base = deps.buildHostileModuleRuntimeCallbacks(scene) || {};
    const vendorLocked = typeof base.isEntityLockedTarget === "function" ? base.isEntityLockedTarget : () => false;
    return {
      ...base,
      isEntityLockedTarget: (source, targetId) => source === twin && allowed(toInt(targetId, 0)) === true
        && vendorLocked(source, targetId) === true,
      ...extra,
    };
  }

  function resolve(scene, twin, entry, targetId, simMs, callbacks) {
    const module = twinModule(twin, entry && entry.moduleId, entry && entry.flagId);
    const stub = module ? twinShipItem(twin, deps) : null;
    if (!module || !stub) return { module: null, out: null };
    const out = deps.resolveHostileModuleActivation({
      scene, entity: twin, moduleItem: module, effectRecord: entry.effectRecord, chargeItem: null, shipItem: stub,
      skillMap: twin.skillMap instanceof Map ? twin.skillMap : new Map(),
      fittedItems: Array.isArray(twin.fittedItems) ? twin.fittedItems : [], activeModuleContexts: [],
      options: { targetID: toInt(targetId, 0), nowMs: simMs }, callbacks,
    });
    return { module, out };
  }

  function rangeOf(scene, twin, entry, targetId) {
    try {
      const callbacks = callbacksFor(scene, twin, () => true, {
        isEntityLockedTarget: (source) => source === twin, getEntitySurfaceDistance: () => 0 });
      const { out } = resolve(scene, twin, entry, targetId, 0, callbacks);
      if (!out || out.matched !== true || out.success !== true || !isObj(out.data)) {
        return { ok: false, reason: out ? (out.matched === true ? reasonOf(out) : "UNSUPPORTED_MODULE") : "ERROR" };
      }
      const patch = isObj(out.data.effectStatePatch) ? out.data.effectStatePatch : {};
      return { ok: true, optimalM: Math.max(0, num(patch.hostileMaxRangeMeters)),
        falloffM: Math.max(0, num(patch.hostileFalloffMeters)) };
    } catch (_err) {
      count("ewar.access.error");
      return { ok: false, reason: "ERROR" };
    }
  }

  function fx(scene, twin, effectState, start, durationMs) {
    if (config.activeFxEnabled !== true || !twin) return;
    try {
      const guid = isObj(effectState) && typeof effectState.guid === "string" ? effectState.guid : "";
      if (!guid || !scene || typeof scene.broadcastSpecialFx !== "function") return;
      scene.broadcastSpecialFx(twin.itemID, guid, { moduleID: toInt(effectState.moduleID, 0),
        moduleTypeID: toInt(effectState.typeID, 0), targetID: toInt(effectState.targetID, 0), start,
        active: false, ...(start ? { duration: durationMs } : {}) }, twin);
    } catch (_err) {
      count("ewar.fx.error");
    }
  }

  function refreshTarget(scene, target) {
    try {
      if (isObj(target) && scene && typeof scene.refreshShipEntityDerivedState === "function") {
        scene.refreshShipEntityDerivedState(target, { broadcast: true, notifyTargeting: true });
      }
    } catch (_err) {
      count("ewar.access.error");
    }
  }

  function targetOf(scene, effectState) {
    const id = toInt(isObj(effectState) ? effectState.targetID : 0, 0);
    return id > 0 && scene && typeof scene.getEntityByID === "function" ? scene.getEntityByID(id) || null : null;
  }

  function execute(scene, twin, effectState, simMs, isAllowed) {
    const out = deps.executeHostileModuleCycle({ scene, session: null, entity: twin, effectState, nowMs: simMs,
      callbacks: callbacksFor(scene, twin, isAllowed) });
    if (!out || out.success !== true) return { ok: false, reason: reasonOf(out) };
    const data = isObj(out.data) ? out.data : {};
    if (data.aggregateChanged === true) refreshTarget(scene, isObj(data.targetEntity) ? data.targetEntity
      : targetOf(scene, effectState));
    const kind = kindOfState(effectState);
    const amount = Math.max(0, num(data.appliedAmount));
    return { ok: true, appliedGJ: ENERGY_KINDS.includes(kind) ? amount : 0, nosIdle: kind === "nos" && amount === 0 };
  }

  function release(scene, twin, twinId, effectState, simMs) {
    try {
      const id = toInt(twinId, 0) || toInt(twin && twin.itemID, 0);
      if (!isObj(effectState)) return { ok: true, removed: false };
      const target = targetOf(scene, effectState);
      if (!target) {
        applied.delete(keyOf(id, effectState));
        count("ewar.release.targetGone");
        return { ok: true, removed: false };
      }
      const out = deps.removeHostileModuleState({ targetEntity: target, sourceEntity: twin || { itemID: id },
        effectState, scene, nowMs: simMs });
      applied.delete(keyOf(id, effectState));
      const data = out && out.success === true && isObj(out.data) ? out.data : {};
      if (data.aggregateChanged === true) refreshTarget(scene, target);
      fx(scene, twin, effectState, false, 0);
      const removed = isObj(data.removedRecord);
      if (removed) count("ewar.release.ok");
      return { ok: true, removed };
    } catch (_err) {
      count("ewar.release.error");
      return { ok: false, reason: "ERROR" };
    }
  }

  function startCycle(scene, twin, entry, targetId, simMs, isAllowed) {
    const retry = config.ewarRetryMs;
    try {
      const callbacks = callbacksFor(scene, twin, isAllowed);
      const { module, out } = resolve(scene, twin, entry, targetId, simMs, callbacks);
      if (!module) return cycleFail("ERROR", retry);
      if (!out || out.matched !== true) return cycleFail("UNSUPPORTED_MODULE", retry);
      if (out.success !== true || !isObj(out.data)) return cycleFail(reasonOf(out), retry);
      const runtimeAttrs = isObj(out.data.runtimeAttrs) ? out.data.runtimeAttrs : {};
      const durationMs = num(runtimeAttrs.durationMs);
      if (!(durationMs > 0)) return cycleFail("ERROR", retry);
      const record = isObj(entry.effectRecord) ? entry.effectRecord : {};
      const twinId = toInt(twin.itemID, 0);
      const effectState = { moduleID: toInt(module.itemID, 0), moduleFlagID: toInt(module.flagID, 0),
        typeID: toInt(module.typeID, 0), groupID: toInt(module.groupID, 0), effectID: toInt(record.effectID, 0),
        effectName: String(record.name || ""), guid: typeof record.guid === "string" ? record.guid : "",
        targetID: toInt(targetId, 0), startedAtMs: simMs, ...runtimeAttrs,
        ...(isObj(out.data.effectStatePatch) ? out.data.effectStatePatch : {}) };
      const previous = applied.get(keyOf(twinId, effectState));
      if (previous && previous.targetId !== effectState.targetID) {
        release(scene, twin, twinId, previous.effectState, simMs);
      }
      const done = execute(scene, twin, effectState, simMs, isAllowed);
      if (!done.ok) {
        release(scene, twin, twinId, effectState, simMs);
        return cycleFail(done.reason, retry);
      }
      applied.set(keyOf(twinId, effectState), { twinId, moduleId: effectState.moduleID,
        targetId: effectState.targetID, systemId: toInt(scene && scene.systemID, 0), kind: kindOfState(effectState),
        effectState, sinceSimMs: simMs });
      fx(scene, twin, effectState, true, durationMs);
      return cycleOk(durationMs, { effectState, appliedGJ: done.appliedGJ, nosIdle: done.nosIdle });
    } catch (_err) {
      count("ewar.access.error");
      return cycleFail("ERROR", retry);
    }
  }

  function refreshCycle(scene, twin, effectState, simMs, isAllowed) {
    try {
      if (!isObj(effectState)) return { ok: false, reason: "ERROR" };
      const done = execute(scene, twin, effectState, simMs, isAllowed);
      if (done.ok) return done;
      release(scene, twin, toInt(twin && twin.itemID, 0), effectState, simMs);
      return { ok: false, reason: done.reason };
    } catch (_err) {
      count("ewar.access.error");
      release(scene, twin, toInt(twin && twin.itemID, 0), effectState, simMs);
      return { ok: false, reason: "ERROR" };
    }
  }

  function sweep(scene, simMs) {
    let released = 0;
    try {
      const systemId = toInt(scene && scene.systemID, 0);
      const orphans = [...applied.values()].filter((app) => app.systemId === systemId
        && !isObj(scene.getEntityByID(app.twinId)));
      for (const app of orphans) {
        release(scene, null, app.twinId, app.effectState, simMs);
        released += 1;
      }
    } catch (_err) {
      count("ewar.access.error");
    }
    count("ewar.orphan.released", released);
    return { released };
  }

  return Object.freeze({ familyOf, rangeOf, startCycle, refreshCycle, release, sweep,
    stats: () => ({ counters: { ...counters } }) });
}

function depsFromGame(g) {
  const late = (mod, name) => (...args) => g[mod][name](...args);
  return {
    resolveHostileDefinition: late("hostileModuleRuntime", "resolveHostileDefinition"),
    resolveHostileModuleActivation: late("hostileModuleRuntime", "resolveHostileModuleActivation"),
    executeHostileModuleCycle: late("hostileModuleRuntime", "executeHostileModuleCycle"),
    removeHostileModuleState: late("hostileModuleRuntime", "removeHostileModuleState"),
    buildHostileModuleRuntimeCallbacks: late("moduleRuntimeCallbacks", "buildHostileModuleRuntimeCallbacks"),
    buildRuntimeShipItemFromEntity: late("entityDogmaView", "buildRuntimeShipItemFromEntity"),
  };
}

function createEwarAccessFromGame(gameAdapter, input) {
  if (!gameAdapter || typeof gameAdapter.isConsumerAvailable !== "function"
    || !gameAdapter.isConsumerAvailable("ewar")) {
    return { ok: false, reason: "probe_ewar_unavailable" };
  }
  const game = {};
  for (const [key, rel] of Object.entries(EWAR_MODULES)) {
    const loaded = gameAdapter.requireGame(rel);
    if (!loaded || !loaded.ok || !isObj(loaded.exports)) {
      return { ok: false, reason: `require_failed:${rel}:${loaded && loaded.reason}` };
    }
    game[key] = loaded.exports;
  }
  return { ok: true, access: createEwarAccess({ deps: depsFromGame(game), config: input && input.config }) };
}

module.exports = {
  EWAR_MODULES, EWAR_FAMILY_KIND, EWAR_KIND, EWAR_REASON, EWAR_ACCESS_COUNTER_NAMES, createEwarAccess,
  createEwarAccessFromGame,
};
