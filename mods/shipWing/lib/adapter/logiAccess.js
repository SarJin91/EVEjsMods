"use strict";

const { twinShipItem, twinModule } = require("./twinDogma");
const { cycleOk, cycleFail } = require("../core/cycleSchedule");
const { CYCLE_REASON } = require("../core/logiPolicy");

const LOGI_MODULES = Object.freeze({
  assistanceModuleRuntime: "space/modules/assistanceModuleRuntime",
  moduleRuntimeCallbacks: "space/runtime/moduleRuntimeCallbacks",
  entityDogmaView: "space/runtime/entityDogmaView",
  interactionScope: "space/destiny/identity/interactionScope",
});
const LOGI_ACCESS_COUNTER_NAMES = Object.freeze(["logi.fx.error", "logi.access.error"]);

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
  return CYCLE_REASON.includes(msg) ? msg : "OTHER";
}

function createLogiAccess(input) {
  const deps = input.deps;
  const config = input.config || {};
  const collectBurst = typeof input.collectBurst === "function" ? input.collectBurst : null;
  const counters = Object.fromEntries(LOGI_ACCESS_COUNTER_NAMES.map((name) => [name, 0]));

  function count(name) {
    if (Object.prototype.hasOwnProperty.call(counters, name)) counters[name] += 1;
  }

  function callbacksFor(scene, twin, isAllowed, extra = {}) {
    const allowed = typeof isAllowed === "function" ? isAllowed : () => false;
    return {
      ...deps.buildAssistanceModuleRuntimeCallbacks(scene),
      isEntityLockedTarget: (source, targetId) => source === twin && allowed(toInt(targetId, 0)) === true,
      getEntityRuntimeModuleItem: () => null,
      getEntityRuntimeLoadedCharge: () => null,
      ...extra,
    };
  }

  function resolve(scene, twin, entry, targetId, simMs, callbacks, withBurst = false) {
    const module = twinModule(twin, entry && entry.moduleId, entry && entry.flagId);
    const stub = module ? twinShipItem(twin, deps) : null;
    if (!module || !stub) return { module: null, out: null };
    const out = deps.resolveAssistanceModuleActivation({
      scene, entity: twin, moduleItem: module, effectRecord: entry.effectRecord, chargeItem: null, shipItem: stub,
      skillMap: twin.skillMap instanceof Map ? twin.skillMap : new Map(),
      fittedItems: Array.isArray(twin.fittedItems) ? twin.fittedItems : [], activeModuleContexts: [],
      ...(withBurst && collectBurst ? { additionalDirectModifierEntries: collectBurst(twin, module, simMs) } : {}),
      options: { targetID: toInt(targetId, 0), nowMs: simMs }, callbacks,
    });
    return { module, out };
  }

  function rangeOf(scene, twin, entry, targetId, _ownerCharId) {
    try {
      const callbacks = callbacksFor(scene, twin, () => true, { getEntitySurfaceDistance: () => 0 });
      const { out } = resolve(scene, twin, entry, targetId, 0, callbacks);
      if (!out || out.matched !== true || out.success !== true || !isObj(out.data)) {
        return { ok: false, reason: out ? reasonOf(out) : "ERROR" };
      }
      const patch = isObj(out.data.effectStatePatch) ? out.data.effectStatePatch : {};
      return { ok: true, optimalM: Math.max(0, num(patch.assistanceMaxRangeMeters)),
        falloffM: Math.max(0, num(patch.assistanceFalloffMeters)) };
    } catch (_err) {
      count("logi.access.error");
      return { ok: false, reason: "ERROR" };
    }
  }

  function fx(scene, twin, module, effectRecord, targetId, durationMs) {
    if (config.activeFxEnabled !== true) return;
    try {
      const guid = isObj(effectRecord) && typeof effectRecord.guid === "string" ? effectRecord.guid : "";
      if (!guid || !scene || typeof scene.broadcastSpecialFx !== "function") return;
      scene.broadcastSpecialFx(twin.itemID, guid, { moduleID: toInt(module.itemID, 0),
        moduleTypeID: toInt(module.typeID, 0), targetID: toInt(targetId, 0), start: true, active: false,
        duration: durationMs }, twin);
    } catch (_err) {
      count("logi.fx.error");
    }
  }

  function startCycle(scene, twin, entry, targetId, _ownerCharId, simMs, isAllowed) {
    const retry = config.logiRetargetMs;
    try {
      const callbacks = callbacksFor(scene, twin, isAllowed);
      const { module, out } = resolve(scene, twin, entry, targetId, simMs, callbacks, true);
      if (!module) return cycleFail("ERROR", retry);
      if (!out || out.matched !== true) return cycleFail("UNSUPPORTED_MODULE", retry);
      if (out.success !== true || !isObj(out.data)) return cycleFail(reasonOf(out), retry);
      const runtimeAttrs = isObj(out.data.runtimeAttrs) ? out.data.runtimeAttrs : {};
      const durationMs = num(runtimeAttrs.durationMs);
      if (!(durationMs > 0)) return cycleFail("ERROR", retry);
      const effectState = { moduleID: toInt(module.itemID, 0), moduleFlagID: toInt(module.flagID, 0),
        typeID: toInt(module.typeID, 0), targetID: toInt(targetId, 0), startedAtMs: simMs, ...runtimeAttrs,
        ...(isObj(out.data.effectStatePatch) ? out.data.effectStatePatch : {}) };
      fx(scene, twin, module, entry.effectRecord, targetId, durationMs);
      return cycleOk(durationMs, { effectState });
    } catch (_err) {
      count("logi.access.error");
      return cycleFail("ERROR", retry);
    }
  }

  function finishCycle(scene, twin, effectState, simMs, isAllowed) {
    try {
      if (!isObj(effectState)) return { ok: false, reason: "ERROR" };
      const out = deps.executeAssistanceModuleCycle({ scene, session: null, entity: twin, effectState, nowMs: simMs,
        isActivationPass: false, callbacks: callbacksFor(scene, twin, isAllowed) });
      if (!out || out.success !== true) return { ok: false, reason: reasonOf(out) };
      const data = isObj(out.data) ? out.data : {};
      return { ok: true, appliedAmount: Math.max(0, num(data.appliedAmount)) };
    } catch (_err) {
      count("logi.access.error");
      return { ok: false, reason: "ERROR" };
    }
  }

  function canInteract(twin, entity) {
    try {
      return deps.canEntitiesInteractLocally(twin, entity) === true;
    } catch (_err) {
      count("logi.access.error");
      return false;
    }
  }

  return Object.freeze({ rangeOf, startCycle, finishCycle, canInteract,
    stats: () => ({ counters: { ...counters } }) });
}

function depsFromGame(g) {
  const late = (mod, name) => (...args) => g[mod][name](...args);
  return {
    resolveAssistanceModuleActivation: late("assistanceModuleRuntime", "resolveAssistanceModuleActivation"),
    executeAssistanceModuleCycle: late("assistanceModuleRuntime", "executeAssistanceModuleCycle"),
    buildAssistanceModuleRuntimeCallbacks: late("moduleRuntimeCallbacks", "buildAssistanceModuleRuntimeCallbacks"),
    buildRuntimeShipItemFromEntity: late("entityDogmaView", "buildRuntimeShipItemFromEntity"),
    canEntitiesInteractLocally: late("interactionScope", "canEntitiesInteractLocally"),
  };
}

function createLogiAccessFromGame(gameAdapter, input) {
  if (!gameAdapter || typeof gameAdapter.isConsumerAvailable !== "function"
    || !gameAdapter.isConsumerAvailable("logi")) {
    return { ok: false, reason: "probe_logi_unavailable" };
  }
  const game = {};
  for (const [key, rel] of Object.entries(LOGI_MODULES)) {
    const loaded = gameAdapter.requireGame(rel);
    if (!loaded || !loaded.ok || !isObj(loaded.exports)) {
      return { ok: false, reason: `require_failed:${rel}:${loaded && loaded.reason}` };
    }
    game[key] = loaded.exports;
  }
  return { ok: true, access: createLogiAccess({ deps: depsFromGame(game), config: input && input.config,
    collectBurst: input && input.collectBurst }) };
}

module.exports = { LOGI_MODULES, CYCLE_REASON, LOGI_ACCESS_COUNTER_NAMES, createLogiAccess, createLogiAccessFromGame };
