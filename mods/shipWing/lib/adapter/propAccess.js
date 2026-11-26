// port of shipDerivedState.js:326-451 (S3E-F15; command burst: steps 1-5 live in lib/adapter/twinDerived.js applyDerived, called with twin.passiveDerivedState): 1.

"use strict";

const { twinShipItem, twinModule } = require("./twinDogma");
const { cycleOk, cycleFail } = require("../core/cycleSchedule");
const { applyDerived } = require("./twinDerived");

const PROP_MODULES = Object.freeze({
  passiveDerivedState: "space/runtime/passiveDerivedState",
  propulsionModule: "space/runtime/propulsionModule",
  entityDogmaView: "space/runtime/entityDogmaView",
});
const PROP_ACCESS_COUNTER_NAMES = Object.freeze(["prop.fx.error"]);

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

function createPropAccess(input) {
  const deps = input.deps;
  const config = input.config || {};
  const counters = Object.fromEntries(PROP_ACCESS_COUNTER_NAMES.map((name) => [name, 0]));

  function count(name) {
    if (Object.prototype.hasOwnProperty.call(counters, name)) counters[name] += 1;
  }

  function effectOf(effectRecord) {
    const k = deps.constants();
    const id = toInt(effectRecord && effectRecord.effectID, 0);
    if (id > 0 && id === toInt(k.EFFECT_ID_MICROWARPDRIVE, 0)) {
      return { effectName: k.PROPULSION_EFFECT_MICROWARPDRIVE, effectID: id };
    }
    if (id > 0 && id === toInt(k.EFFECT_ID_AFTERBURNER, 0)) {
      return { effectName: k.PROPULSION_EFFECT_AFTERBURNER, effectID: id };
    }
    return null;
  }

  function attrsOf(twin, entry, ownerCharId) {
    try {
      const module = twinModule(twin, entry && entry.moduleId, entry && entry.flagId);
      const stub = module ? twinShipItem(twin, deps) : null;
      const effect = module ? effectOf(entry.effectRecord) : null;
      if (!module || !stub || !effect) return { ok: false, reason: "ERROR" };
      const attrs = deps.getPropulsionModuleRuntimeAttributes(toInt(ownerCharId, 0), module, {
        skillMap: twin.skillMap instanceof Map ? twin.skillMap : new Map(), shipItem: stub,
        fittedItems: Array.isArray(twin.fittedItems) ? twin.fittedItems : [], activeModuleContexts: [],
      });
      if (!isObj(attrs)) return { ok: false, reason: "ERROR" };
      const guid = (deps.constants().PROPULSION_GUID_BY_EFFECT || {})[effect.effectName] || "";
      return { ok: true, state: { ...effect, moduleID: toInt(module.itemID, 0), typeID: toInt(module.typeID, 0),
        guid, durationMs: num(attrs.durationMs), speedFactor: num(attrs.speedFactor),
        speedBoostFactor: num(attrs.speedBoostFactor), massAddition: num(attrs.massAddition),
        signatureRadiusBonus: num(attrs.signatureRadiusBonus) } };
    } catch (_err) {
      return { ok: false, reason: "ERROR" };
    }
  }

  function fx(scene, twin, state, on) {
    if (config.activeFxEnabled !== true || !isObj(state)) return;
    try {
      if (!state.guid || typeof scene.broadcastSpecialFx !== "function") return;
      scene.broadcastSpecialFx(twin.itemID, state.guid, { moduleID: state.moduleID, moduleTypeID: state.typeID,
        start: on, active: on, duration: state.durationMs }, twin);
    } catch (_err) {
      count("prop.fx.error");
    }
  }

  function apply(scene, twin, propState, previous) {
    const retry = config.followRetuneMs;
    try {
      if (!scene || !isObj(twin) || !isObj(twin.passiveDerivedState)) return cycleFail("ERROR", retry);
      const done = applyDerived(scene, twin, twin.passiveDerivedState, propState || null, deps);
      if (!done || done.ok !== true) return cycleFail("ERROR", retry);
      if (propState) fx(scene, twin, propState, true);
      else fx(scene, twin, previous, false);
      return cycleOk(retry, { on: Boolean(propState) });
    } catch (_err) {
      return cycleFail("ERROR", retry);
    }
  }

  return Object.freeze({ attrsOf, apply, stats: () => ({ counters: { ...counters } }) });
}

function depsFromGame(g) {
  const late = (mod, name) => (...args) => g[mod][name](...args);
  return {
    getPropulsionModuleRuntimeAttributes: late("propulsionModule", "getPropulsionModuleRuntimeAttributes"),
    applyPassiveResourceStateToEntity: late("passiveDerivedState", "applyPassiveResourceStateToEntity"),
    applyPropulsionEffectStateToEntity: late("propulsionModule", "applyPropulsionEffectStateToEntity"),
    buildRuntimeShipItemFromEntity: late("entityDogmaView", "buildRuntimeShipItemFromEntity"),
    constants: () => ({
      EFFECT_ID_AFTERBURNER: g.propulsionModule.EFFECT_ID_AFTERBURNER,
      EFFECT_ID_MICROWARPDRIVE: g.propulsionModule.EFFECT_ID_MICROWARPDRIVE,
      PROPULSION_EFFECT_AFTERBURNER: g.propulsionModule.PROPULSION_EFFECT_AFTERBURNER,
      PROPULSION_EFFECT_MICROWARPDRIVE: g.propulsionModule.PROPULSION_EFFECT_MICROWARPDRIVE,
      PROPULSION_GUID_BY_EFFECT: g.propulsionModule.PROPULSION_GUID_BY_EFFECT,
    }),
  };
}

function createPropAccessFromGame(gameAdapter, input) {
  if (!gameAdapter || typeof gameAdapter.isConsumerAvailable !== "function"
    || !gameAdapter.isConsumerAvailable("prop")) {
    return { ok: false, reason: "probe_prop_unavailable" };
  }
  const game = {};
  for (const [key, rel] of Object.entries(PROP_MODULES)) {
    const loaded = gameAdapter.requireGame(rel);
    if (!loaded || !loaded.ok || !isObj(loaded.exports)) {
      return { ok: false, reason: `require_failed:${rel}:${loaded && loaded.reason}` };
    }
    game[key] = loaded.exports;
  }
  return { ok: true, access: createPropAccess({ deps: depsFromGame(game), config: input && input.config }) };
}

module.exports = { PROP_MODULES, PROP_ACCESS_COUNTER_NAMES, createPropAccess, createPropAccessFromGame };
