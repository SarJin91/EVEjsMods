"use strict";

const { applyDerived } = require("./twinDerived");

const BURST_MODULES = Object.freeze({
  commandBurstRuntime: "space/modules/commandBurstRuntime",
  passiveDerivedState: "space/runtime/passiveDerivedState",
  wormholeEnvironmentRuntime: "services/exploration/wormholes/wormholeEnvironmentRuntime",
  entityDogmaView: "space/runtime/entityDogmaView",
  propulsionModule: "space/runtime/propulsionModule",
});
const BURST_OPTIONAL_MODULES = Object.freeze({
  shipHealthState: "space/runtime/shipHealthState",
});
const BURST_AFFINITY_BASE = 3990000000000000;
const BURST_ACCESS_COUNTER_NAMES = Object.freeze(["burst.collect.error"]);
const VERIFY_RESULT = Object.freeze(["ok", "rrOverride", "mismatch", "unknown"]);

function toInt(value, fallback = 0) {
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) ? n : fallback;
}

function isObj(value) {
  return value !== null && typeof value === "object";
}

function groupIdOf(ownerCharId) {
  const owner = Number(ownerCharId);
  if (!Number.isSafeInteger(owner) || owner <= 0) return 0;
  const gid = BURST_AFFINITY_BASE + owner;
  return Number.isSafeInteger(gid) ? gid : 0;
}

function stamp(entity, gid) {
  try {
    if (!isObj(entity) || !(toInt(gid, 0) > 0)) return { ok: false, reason: "BAD_ENTITY" };
    const current = toInt(entity.commandBurstAffinityGroupID, 0);
    if (entity.commandBurstAffinityExplicit === true) {
      if (current === gid) return { ok: true, wrote: false };
      return { ok: false, reason: "FOREIGN" };
    }
    entity.commandBurstAffinityExplicit = true;
    entity.commandBurstAffinityGroupID = gid;
    return { ok: true, wrote: true };
  } catch (_err) {
    return { ok: false, reason: "BAD_ENTITY" };
  }
}

function clear(entity, gid) {
  try {
    if (!isObj(entity) || !(toInt(gid, 0) > 0)) return false;
    if (toInt(entity.commandBurstAffinityGroupID, 0) !== gid) return false;
    delete entity.commandBurstAffinityExplicit;
    delete entity.commandBurstAffinityGroupID;
    return true;
  } catch (_err) {
    return false;
  }
}

function createBurstAccess(input) {
  const deps = (input && input.deps) || {};
  const counters = Object.fromEntries(BURST_ACCESS_COUNTER_NAMES.map((name) => [name, 0]));

  function verify(host, gid) {
    try {
      if (!isObj(host)) return "unknown";
      if (toInt(host.remoteRepairBurstAffinityGroupID, 0) > 0) return "rrOverride";
      const resolver = typeof deps.affinityResolver === "function" ? deps.affinityResolver() : null;
      if (typeof resolver !== "function") return "unknown";
      return toInt(resolver(host), 0) === gid ? "ok" : "mismatch";
    } catch (_err) {
      return "unknown";
    }
  }

  function collect(twin, item, simMs) {
    try {
      if (!isObj(twin) || !isObj(item)) return [];
      const out = deps.collectModifierEntriesForItem(twin, item, simMs);
      return Array.isArray(out) ? out : [];
    } catch (_err) {
      counters["burst.collect.error"] += 1;
      return [];
    }
  }

  function signature(twin, simMs) {
    const buffs = isObj(twin) ? twin.commandBurstDynamicBuffs : null;
    if (!buffs || !(buffs.size > 0)) return "[]";
    const entries = deps.buildClientDbuffStateEntries(twin, { nowMs: simMs, buildExpiry: () => 0 });
    const values = (Array.isArray(entries) ? entries : []).filter(Array.isArray)
      .map((e) => [toInt(e[0], 0), Array.isArray(e[1]) ? e[1][0] : null]);
    return JSON.stringify(values);
  }

  function rebuild(twin, ownerCharId, alwaysOn, simMs) {
    try {
      if (!isObj(twin)) return { ok: false, reason: "ERROR" };
      const stub = deps.buildRuntimeShipItemFromEntity(twin);
      if (!isObj(stub)) return { ok: false, reason: "ERROR" };
      const wh = deps.collectShipAttributeModifierEntriesForSystem(toInt(twin.systemID, 0));
      const bursts = deps.collectModifierEntriesForItem(twin, stub, simMs);
      const on = isObj(alwaysOn) ? alwaysOn : null;
      const options = {
        fittedItems: Array.isArray(twin.fittedItems) ? twin.fittedItems : [],
        skillMap: twin.skillMap instanceof Map ? twin.skillMap : new Map(),
        additionalAttributeModifierEntries: [...(Array.isArray(wh) ? wh : []),
          ...(on && Array.isArray(on.entries) ? on.entries : []), ...(Array.isArray(bursts) ? bursts : [])],
      };
      if (on && on.selfEffects instanceof Map) options.activeSelfModifierEffectsByItemID = on.selfEffects;
      const state = deps.buildPassiveShipResourceState(toInt(ownerCharId, 0), stub, options);
      return isObj(state) ? { ok: true, state } : { ok: false, reason: "ERROR" };
    } catch (_err) {
      return { ok: false, reason: "ERROR" };
    }
  }

  function applyTwinDerived(scene, twin, passiveState, propState) {
    return applyDerived(scene, twin, passiveState, propState || null, deps);
  }

  return Object.freeze({ groupIdOf, stamp, clear, verify, collect, signature, rebuild,
    applyDerived: applyTwinDerived, stats: () => ({ counters: { ...counters } }) });
}

function depsFromGame(g) {
  const late = (mod, name) => (...args) => g[mod][name](...args);
  return {
    collectModifierEntriesForItem: (...args) => g.commandBurstRuntime.collectModifierEntriesForItem(...args),
    buildClientDbuffStateEntries: late("commandBurstRuntime", "buildClientDbuffStateEntries"),
    buildPassiveShipResourceState: late("passiveDerivedState", "buildPassiveShipResourceState"),
    applyPassiveResourceStateToEntity: late("passiveDerivedState", "applyPassiveResourceStateToEntity"),
    collectShipAttributeModifierEntriesForSystem:
      late("wormholeEnvironmentRuntime", "collectShipAttributeModifierEntriesForSystem"),
    buildRuntimeShipItemFromEntity: late("entityDogmaView", "buildRuntimeShipItemFromEntity"),
    applyPropulsionEffectStateToEntity: late("propulsionModule", "applyPropulsionEffectStateToEntity"),
    broadcastDamageStateChange: (...args) => {
      const health = g.shipHealthState;
      if (isObj(health) && typeof health.broadcastDamageStateChange === "function") {
        health.broadcastDamageStateChange(...args);
      }
    },
    affinityResolver: () => {
      const testing = g.commandBurstRuntime._testing;
      return isObj(testing) && typeof testing.resolveBurstAffinityGroupID === "function"
        ? testing.resolveBurstAffinityGroupID : null;
    },
  };
}

function createBurstAccessFromGame(gameAdapter) {
  if (!gameAdapter || typeof gameAdapter.isConsumerAvailable !== "function"
    || !gameAdapter.isConsumerAvailable("burst")) {
    return { ok: false, reason: "probe_burst_unavailable" };
  }
  const game = {};
  for (const [key, rel] of Object.entries(BURST_MODULES)) {
    const loaded = gameAdapter.requireGame(rel);
    if (!loaded || !loaded.ok || !isObj(loaded.exports)) {
      return { ok: false, reason: `require_failed:${rel}:${loaded && loaded.reason}` };
    }
    game[key] = loaded.exports;
  }
  for (const [key, rel] of Object.entries(BURST_OPTIONAL_MODULES)) {
    const loaded = gameAdapter.requireGame(rel);
    game[key] = loaded && loaded.ok && isObj(loaded.exports) ? loaded.exports : null;
  }
  return { ok: true, access: createBurstAccess({ deps: depsFromGame(game) }) };
}

module.exports = {
  BURST_MODULES, BURST_OPTIONAL_MODULES, BURST_AFFINITY_BASE, BURST_ACCESS_COUNTER_NAMES, VERIFY_RESULT, groupIdOf, stamp, clear,
  createBurstAccess, createBurstAccessFromGame,
};
