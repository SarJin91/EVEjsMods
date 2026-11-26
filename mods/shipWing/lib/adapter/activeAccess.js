"use strict";

const { twinShipItem, twinModule } = require("./twinDogma");
const { cycleOk, cycleFail } = require("../core/cycleSchedule");
const { decide, CAP_STATE } = require("../core/capBalance");
const { EWAR_KIND } = require("./ewarAccess");

const ACCESS_MODULES = Object.freeze({
  passiveDerivedState: "space/runtime/passiveDerivedState",
  activeShipModifiers: "space/runtime/activeShipModifiers",
  liveFittingState: "services/fitting/liveFittingState",
  wormholeEnvironmentRuntime: "services/exploration/wormholes/wormholeEnvironmentRuntime",
  moduleActivationEffectRecord: "space/runtime/moduleActivationEffectRecord",
  liveModuleAttributes: "space/modules/liveModuleAttributes",
  localCycleRuntime: "space/modules/localCycleRuntime",
  moduleRuntimeCallbacks: "space/runtime/moduleRuntimeCallbacks",
  assistanceModuleRuntime: "space/modules/assistanceModuleRuntime",
  propulsionModule: "space/runtime/propulsionModule",
  entityDogmaView: "space/runtime/entityDogmaView",
  combatDestruction: "space/runtime/combatDestruction",
});

const LOCAL_REP_EFFECTS = Object.freeze({
  armorRepair: "armor", fueledArmorRepair: "armor", shieldBoosting: "shield", fueledShieldBoosting: "shield",
  structureRepair: "structure",
});
const REMOTE_FAMILIES = Object.freeze(["remoteArmor", "remoteShield", "remoteHull"]);
const CAP_BOOSTER_EFFECT = "powerBooster";
const SENSOR_BOOSTER_EFFECT = "sensorBoosterActivePercentage";
const REMOTE_CAPACITOR_FAMILY = "remoteCapacitor";
const NOS_EFFECT = "energyNosferatuFalloff";
const UNSUPPORTED_KIND = Object.freeze(["prop", "remoteCapacitor", "assistance", "capBooster", "sensor", "other",
  "ewarOther"]);
const RESONANCE_ATTRIBUTE_NAMES = Object.freeze([
  "shieldEmDamageResonance", "shieldExplosiveDamageResonance", "shieldKineticDamageResonance",
  "shieldThermalDamageResonance", "armorEmDamageResonance", "armorExplosiveDamageResonance",
  "armorKineticDamageResonance", "armorThermalDamageResonance", "emDamageResonance", "explosiveDamageResonance",
  "kineticDamageResonance", "thermalDamageResonance",
]);
const ITEM_MODIFIER = "ItemModifier";

const ACCESS_COUNTER_NAMES = Object.freeze([
  "active.plan.ok", "active.plan.refused.CAP_UNSTABLE", "active.plan.error", "active.plan.noWeaponsData",
  "active.plan.ms",
  ...CAP_STATE.filter((s) => s !== "refused").map((s) => `active.cap.${s}`),
  ...UNSUPPORTED_KIND.map((k) => `active.module.unsupported.${k}`),
  "active.alwaysOn.applied", "active.fx.error",
  ...EWAR_KIND.map((k) => `active.ewar.${k}`),
  "active.cap.nosCredit",
]);

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

function round1(value) {
  return Math.round(num(value) * 10) / 10;
}

function arrayOf(value) {
  return Array.isArray(value) ? value : [];
}

function effectName(record) {
  const raw = isObj(record) ? record.name || record.guid || "" : "";
  return String(raw).trim().replace(/^effects\./i, "");
}

function createActiveAccess(input) {
  const deps = input.deps;
  const config = input.config || {};
  const collectBurst = typeof input.collectBurst === "function" ? input.collectBurst : null;
  const ewarFamilyOf = typeof input.ewarFamilyOf === "function" ? input.ewarFamilyOf : null;
  const hrNow =typeof input.hrNow === "function" ? input.hrNow : () => Number(process.hrtime.bigint()) / 1e6;
  const counters = Object.fromEntries(ACCESS_COUNTER_NAMES.map((name) => [name, 0]));
  let attributeIds = null;

  function count(name, by = 1) {
    if (Object.prototype.hasOwnProperty.call(counters, name)) counters[name] += by;
  }

  function ids() {
    if (attributeIds === null) {
      const one = (name) => toInt(deps.getAttributeIDByNames(name), 0);
      attributeIds = {
        resonances: new Set(RESONANCE_ATTRIBUTE_NAMES.map(one).filter((id) => id > 0)),
        capacitorNeed: one("capacitorNeed"), duration: one("duration"), speed: one("speed"),
        powerTransfer: one("powerTransferAmount"),
      };
    }
    return attributeIds;
  }

  function isAlwaysOn(effectRecord, module) {
    const mods = arrayOf(effectRecord && effectRecord.modifierInfo).filter(Boolean);
    if (mods.length === 0) return false;
    const res = ids().resonances;
    let onShip = 0;
    let onSelf = 0;
    for (const m of mods) {
      if (String(m.func || "") !== ITEM_MODIFIER || !res.has(toInt(m.modifiedAttributeID, 0))) return false;
      const domain = String(m.domain || "");
      if (domain === "shipID") onShip += 1;
      else if (domain === "itemID") onSelf += 1;
      else return false;
    }
    if (onShip > 0) return true;
    return onSelf > 0 && deps.effectRecordSelfModifiesProjectedAttributes(effectRecord, module) === true;
  }

  function selfModifies(effectRecord) {
    return arrayOf(effectRecord && effectRecord.modifierInfo).some((m) => m && String(m.domain || "") === "itemID"
      && String(m.func || "") === ITEM_MODIFIER);
  }

  function capTransferOn() {
    return config.logiEnabled === true && config.logiCapTransferEnabled === true;
  }

  function classify(module, effectRecord, propIds, propTaken) {
    const name = effectName(effectRecord);
    if (propIds.includes(toInt(effectRecord.effectID, 0))) return propTaken ? "unsupported:prop" : "prop";
    const assistance = deps.resolveAssistanceDefinition(effectRecord);
    if (assistance) {
      const family = String(assistance.family || "");
      if (REMOTE_FAMILIES.includes(family)) return "remote";
      if (family !== REMOTE_CAPACITOR_FAMILY) return "unsupported:assistance";
      return capTransferOn() ? "remoteCapacitor" : "unsupported:remoteCapacitor";
    }
    const fam = ewarFamilyOf ? ewarFamilyOf(effectRecord) : null;
    if (fam === "other") return "unsupported:ewarOther";
    if (fam && EWAR_KIND.includes(fam)) return "ewar";
    if (name === CAP_BOOSTER_EFFECT) return "unsupported:capBooster";
    if (Object.prototype.hasOwnProperty.call(LOCAL_REP_EFFECTS, name)) return "localRep";
    if (isAlwaysOn(effectRecord, module)) return "alwaysOn";
    return name === SENSOR_BOOSTER_EFFECT ? "unsupported:sensor" : "unsupported:other";
  }

  function firstPositive(attrs, attributeIdList) {
    for (const id of attributeIdList) {
      const v = toInt(id, 0) > 0 ? num(attrs[toInt(id, 0)]) : 0;
      if (v > 0) return v;
    }
    return 0;
  }

  function profile(stub, module, effectRecord, skillMap, fitted) {
    const attrs = deps.buildLiveModuleAttributeMap(stub, module, null, skillMap, fitted, [], {}) || {};
    const a = ids();
    return {
      capNeed: firstPositive(attrs, [effectRecord && effectRecord.dischargeAttributeID, a.capacitorNeed]),
      durationMs: firstPositive(attrs, [effectRecord && effectRecord.durationAttributeID, a.duration, a.speed]),
    };
  }

  function isNos(effectRecord) {
    if (effectName(effectRecord).toLowerCase() === NOS_EFFECT.toLowerCase()) return true;
    return ewarFamilyOf !== null && ewarFamilyOf(effectRecord) === "nos";
  }

  function nosIncome(stub, nosModules, skillMap, fitted) {
    const a = ids();
    let income = 0;
    for (const n of nosModules) {
      const attrs = deps.buildLiveModuleAttributeMap(stub, n.module, null, skillMap, fitted, [], {}) || {};
      const amount = firstPositive(attrs, [a.powerTransfer]);
      const durationMs = firstPositive(attrs, [n.effectRecord.durationAttributeID, a.duration, a.speed]);
      income += durationMs > 0 && amount > 0 ? amount / (durationMs / 1000) : 0;
    }
    return income;
  }

  function inputsOf(entityLike, stub, kept, skillMap, fitted) {
    const contexts = kept.map((m) => ({ effectState: { moduleID: m.moduleId, isGeneric: true },
      effectRecord: m.effectRecord, moduleItem: m.module, chargeItem: null }));
    const locationSources = arrayOf(deps.collectEntityWormholeLocationModifierSources(entityLike));
    const entries = [];
    const selfEffects = new Map();
    for (const ctx of contexts) {
      const attrs = deps.resolveActiveShipModifierSourceAttributes(entityLike, ctx, contexts, {
        shipItem: stub, fittedItems: fitted, skillMap, additionalLocationModifierSources: locationSources,
        overloadEffectRecordsByModuleID: new Map(),
      });
      deps.appendDirectModifierEntries(entries, attrs, [ctx.effectRecord], "fittedModule");
      if (selfModifies(ctx.effectRecord)) selfEffects.set(ctx.effectState.moduleID, [ctx.effectRecord]);
    }
    return { entries, selfEffects };
  }

  function alwaysOnInputs(entityLike, stub, ownerCharId, keptAlwaysOnIds, skillMap, fitted) {
    const fit = arrayOf(fitted);
    const hull = stub || twinShipItem(entityLike, deps);
    const kept = [];
    for (const id of arrayOf(keptAlwaysOnIds)) {
      const moduleId = toInt(id, 0);
      const module = moduleId > 0 ? fit.find((m) => isObj(m) && toInt(m.itemID, 0) === moduleId) : null;
      if (!module) continue;
      const effectRecord = deps.resolveDefaultActivationEffect(toInt(module.typeID, 0));
      if (isObj(effectRecord)) kept.push({ moduleId, module, effectRecord });
    }
    return inputsOf(entityLike, hull, kept, skillMap instanceof Map ? skillMap : new Map(), fit);
  }

  function resistState(spec, stub, owner, systemID, keptAlwaysOn, wh, skillMap, fitted) {
    const entityLike = { ...spec, kind: "ship", systemID };
    const { entries, selfEffects } = inputsOf(entityLike, stub, keptAlwaysOn, skillMap, fitted);
    return deps.buildPassiveShipResourceState(owner, stub, {
      fittedItems: fitted, skillMap, additionalAttributeModifierEntries: [...wh, ...entries],
      activeSelfModifierEffectsByItemID: selfEffects,
    }) || null;
  }

  function plan(spec, ctx) {
    const owner = toInt(ctx.ownerCharId, 0);
    const systemID = toInt(ctx.systemID, 0);
    if (!isObj(spec) || owner <= 0) return { ok: false, reason: "ERROR" };
    const stub = twinShipItem({ ...spec, kind: "ship" }, deps);
    if (!stub || toInt(stub.itemID, 0) <= 0) return { ok: false, reason: "ERROR" };
    const fitted = arrayOf(spec.fittedItems);
    const skillMap = spec.skillMap instanceof Map ? spec.skillMap : new Map();
    const weaponList = Array.isArray(ctx.weapons) ? ctx.weapons : null;
    if (weaponList === null) count("active.plan.noWeaponsData");
    const weaponIds = new Set(arrayOf(weaponList).map((w) => toInt(w && w.moduleId, 0)));
    const propIds = arrayOf(deps.propulsionEffectIds()).map((id) => toInt(id, 0)).filter((id) => id > 0);
    const byKind = { weapon: [], prop: [], remote: [], remoteCapacitor: [], localRep: [], alwaysOn: [], ewar: [] };
    const unsupported = {};
    const nosModules = [];
    const ordered =[...fitted].filter(isObj)
      .sort((a, b) => toInt(a.flagID, 0) - toInt(b.flagID, 0) || toInt(a.itemID, 0) - toInt(b.itemID, 0));
    for (const module of ordered) {
      const moduleId = toInt(module.itemID, 0);
      if (moduleId <= 0 || deps.isModuleOnline(module) !== true) continue;
      const effectRecord = deps.resolveDefaultActivationEffect(toInt(module.typeID, 0));
      if (weaponIds.has(moduleId)) {
        byKind.weapon.push({ moduleId, flagId: toInt(module.flagID, 0), module, effectRecord });
        continue;
      }
      if (!isObj(effectRecord)) continue;
      if (isNos(effectRecord)) nosModules.push({ module, effectRecord });
      const kind = classify(module, effectRecord, propIds, byKind.prop.length > 0);
      if (kind.startsWith("unsupported:")) {
        const what = kind.slice("unsupported:".length);
        unsupported[what] = (unsupported[what] || 0) + 1;
        count(`active.module.unsupported.${what}`);
        continue;
      }
      const remoteKind = kind === "remote" || kind === "remoteCapacitor";
      byKind[kind].push({ moduleId, flagId: toInt(module.flagID, 0), typeId: toInt(module.typeID, 0), module,
        effectRecord, layer: kind === "localRep" ? LOCAL_REP_EFFECTS[effectName(effectRecord)] : null,
        family: remoteKind ? String((deps.resolveAssistanceDefinition(effectRecord) || {}).family || "") : null,
        ...(kind === "ewar" ? { ewarKind: ewarFamilyOf(effectRecord) } : {}) });
    }
    const wh = arrayOf(deps.collectShipAttributeModifierEntriesForSystem(systemID));
    const p0 = deps.buildPassiveShipResourceState(owner, stub, { fittedItems: fitted, skillMap,
      additionalAttributeModifierEntries: wh });
    if (!isObj(p0)) return { ok: false, reason: "ERROR" };
    const logiOn = config.logiEnabled === true;
    const running = [...byKind.alwaysOn, ...byKind.localRep];
    if (logiOn) running.push(...byKind.remote, ...byKind.remoteCapacitor);
    if (config.activePropEnabled === true) running.push(...byKind.prop);
    if (ewarFamilyOf) running.push(...byKind.ewar);
    const kindOf = new Map();
    for (const kind of ["alwaysOn", "localRep", "remote", "remoteCapacitor", "prop", "ewar"]) {
      for (const m of byKind[kind]) kindOf.set(m.moduleId, kind);
    }
    const balanced = running.map((m) => ({ id: m.moduleId, kind: kindOf.get(m.moduleId),
      ...profile(stub, m.module, m.effectRecord, skillMap, fitted) }));
    const includeWeapons = config.activeCapIncludeWeapons === true;
    if (includeWeapons) {
      for (const w of byKind.weapon) {
        balanced.push({ id: w.moduleId, kind: "weapon", ...profile(stub, w.module, w.effectRecord, skillMap, fitted) });
      }
    }
    const creditPct = Math.min(100, Math.max(0, num(config.activeCapNosCreditPct)));
    const incomeGJs = creditPct > 0 && nosModules.length > 0
      ? nosIncome(stub, nosModules, skillMap, fitted) * creditPct / 100 : 0;
    const decision = decide({ capacityGJ: p0.capacitorCapacity, rechargeMs: p0.capacitorRechargeRate,
      modules: balanced, policy: config.activeCapUnstablePolicy, stableFactorPct: config.activeCapStableFactorPct,
      includeWeapons, incomeGJs, remoteLast: config.activeCapShedRemoteLast === true });
    if (decision.refused) {
      count("active.plan.refused.CAP_UNSTABLE");
      return { ok: false, reason: "CAP_UNSTABLE" };
    }
    count(`active.cap.${decision.cap}`);
    if (incomeGJs > 0) count("active.cap.nosCredit");
    const kept = (list) => list.filter((m) => decision.kept.has(m.moduleId));
    const keptAlwaysOn = kept(byKind.alwaysOn);
    const keptLocalRep = kept(byKind.localRep);
    let passiveResourceState = null;
    if (keptAlwaysOn.length > 0) {
      passiveResourceState = resistState(spec, stub, owner, systemID, keptAlwaysOn, wh, skillMap, fitted);
      if (!isObj(passiveResourceState)) return { ok: false, reason: "ERROR" };
      count("active.alwaysOn.applied", keptAlwaysOn.length);
    }
    const typeOf = new Map(fitted.filter(isObj).map((m) => [toInt(m.itemID, 0), toInt(m.typeID, 0)]));
    const strip = (m) => ({ moduleId: m.moduleId, flagId: m.flagId, typeId: m.typeId, effectRecord: m.effectRecord,
      layer: m.layer });
    const keptRemote = logiOn ? kept([...byKind.remote, ...byKind.remoteCapacitor]) : [];
    const allRemote = byKind.remote.length + byKind.remoteCapacitor.length;
    const keptEwar = ewarFamilyOf ? kept(byKind.ewar) : [];
    for (const m of keptEwar) count(`active.ewar.${m.ewarKind}`);
    const result = {
      summary: {
        cap: decision.cap, shed: decision.shed.length, shedTypeIds: decision.shed.map((id) => typeOf.get(id) || 0),
        alwaysOn: keptAlwaysOn.length, localRep: keptLocalRep.length, remote: logiOn ? keptRemote.length : allRemote,
        prop: config.activePropEnabled === true && kept(byKind.prop).length > 0,
        ...(logiOn ? { logi: true } : {}),
        ...(ewarFamilyOf ? { ewar: keptEwar.length } : {}),
        ...(incomeGJs > 0 ? { nosCreditGJs: round1(incomeGJs) } : {}),
      },
      classified: { alwaysOn: byKind.alwaysOn.length, localRep: byKind.localRep.length,
        remote: allRemote, prop: byKind.prop.length, weapon: byKind.weapon.length, unsupported,
        ...(ewarFamilyOf ? { ewar: byKind.ewar.length } : {}) },
      peakGJs: decision.peakGJs, drainGJs: decision.drainGJs,
      alwaysOn: keptAlwaysOn.map((m) => m.moduleId),
      localRep: keptLocalRep.map(strip),
      remote: keptRemote.map((m) => ({ ...strip(m), family: m.family })),
      prop: kept(byKind.prop).map(strip),
      ...(ewarFamilyOf ? { ewar: keptEwar.map((m) => ({ ...strip(m), kind: m.ewarKind })) } : {}),
    };
    return { ok: true, plan: result, passiveResourceState };
  }

  function planActive(spec, ctx = {}) {
    const started = hrNow();
    let out;
    try {
      out = plan(spec, ctx || {});
    } catch (_err) {
      out = { ok: false, reason: "ERROR" };
    }
    if (out.ok === true) count("active.plan.ok");
    else if (out.reason !== "CAP_UNSTABLE") count("active.plan.error");
    const tookMs = hrNow() - started;
    if (tookMs > counters["active.plan.ms"]) counters["active.plan.ms"] = tookMs;
    return out;
  }

  function callbacksFor(twin, stub, owner) {
    return {
      ...deps.buildLocalCycleRuntimeCallbacks(owner),
      resolveCharacterID: () => owner,
      getEntityRuntimeShipItem: () => stub,
      getEntityRuntimeFittedItems: () => arrayOf(twin.fittedItems),
      getEntityRuntimeActiveModuleContexts: () => [],
      getEntityRuntimeLoadedCharge: () => null,
      getEntityRuntimeDirectModifierEntriesForItem: collectBurst
        ? (_entity, item, now) => collectBurst(twin, item, now)
        : () => [],
    };
  }

  function fx(scene, twin, module, effectRecord, durationMs) {
    if (config.activeFxEnabled !== true) return;
    try {
      const guid = isObj(effectRecord) && typeof effectRecord.guid === "string" ? effectRecord.guid : "";
      if (!guid || !scene || typeof scene.broadcastSpecialFx !== "function") return;
      scene.broadcastSpecialFx(twin.itemID, guid, { moduleID: toInt(module.itemID, 0),
        moduleTypeID: toInt(module.typeID, 0), start: true, active: false, duration: durationMs }, twin);
    } catch (_err) {
      count("active.fx.error");
    }
  }

  function execute(scene, twin, module, effectState, simMs, activation, owner) {
    const stub = twinShipItem(twin, deps);
    if (!stub) return { success: false, stopReason: "ERROR" };
    return deps.executeLocalCycle({ scene, session: null, entity: twin, moduleItem: module, effectState,
      nowMs: simMs, activation, callbacks: callbacksFor(twin, stub, owner) }) || { success: false };
  }

  function runLocalCycle(scene, twin, entry, ownerCharId, simMs) {
    try {
      const owner = toInt(ownerCharId, 0);
      const module = twinModule(twin, entry && entry.moduleId, entry && entry.flagId);
      const stub = module ? twinShipItem(twin, deps) : null;
      if (!stub || owner <= 0) return cycleFail("ERROR", null);
      const prepared = deps.prepareLocalCycleActivation({ entity: twin, shipItem: stub, moduleItem: module,
        effectRecord: entry.effectRecord, chargeItem: null, callbacks: callbacksFor(twin, stub, owner),
        nowMs: simMs });
      if (!prepared || prepared.matched !== true) return cycleFail("ERROR", null);
      if (prepared.success !== true || !isObj(prepared.cycleState)) {
        return cycleFail(prepared.errorMsg === "NO_AMMO" ? "NO_AMMO" : "ERROR", null);
      }
      const durationMs = num(prepared.cycleState.durationMs);
      if (!(durationMs > 0)) return cycleFail("ERROR", null);
      const timing = prepared.cycleState.applicationTiming === "start" ? "start" : "end";
      const effectState = { moduleID: toInt(module.itemID, 0), moduleFlagID: toInt(module.flagID, 0),
        typeID: toInt(module.typeID, 0), effectName: prepared.cycleState.effectName, startedAtMs: simMs,
        ...prepared.effectStatePatch };
      if (timing === "start") {
        const done = execute(scene, twin, module, effectState, simMs, true, owner);
        if (done.success !== true) return cycleFail("ERROR", null);
      }
      fx(scene, twin, module, entry.effectRecord, durationMs);
      return cycleOk(durationMs, { timing, effectState });
    } catch (_err) {
      return cycleFail("ERROR", null);
    }
  }

  function applyLocalCycle(scene, twin, entry, effectState, simMs, ownerCharId) {
    try {
      const module = twinModule(twin, entry && entry.moduleId, entry && entry.flagId);
      if (!module || !isObj(effectState)) return { ok: false, reason: "ERROR" };
      const done = execute(scene, twin, module, effectState, simMs, false, toInt(ownerCharId, 0));
      return done.success === true ? { ok: true } : { ok: false, reason: "ERROR" };
    } catch (_err) {
      return { ok: false, reason: "ERROR" };
    }
  }

  function isGone(scene, twin) {
    try {
      const id = toInt(twin && twin.itemID, 0);
      if (id <= 0 || !scene || typeof scene.getEntityByID !== "function" || scene.getEntityByID(id) !== twin) {
        return true;
      }
      return deps.isRuntimeEntityDestroyingOrDestroyed(twin) === true;
    } catch (_err) {
      return true;
    }
  }

  return Object.freeze({
    planActive, runLocalCycle, applyLocalCycle, isGone, alwaysOnInputs, stats: () => ({ counters: { ...counters } }),
  });
}

function depsFromGame(g) {
  const late = (mod, name) => (...args) => g[mod][name](...args);
  return {
    resolveDefaultActivationEffect: late("moduleActivationEffectRecord", "resolveDefaultActivationEffect"),
    resolveAssistanceDefinition: late("assistanceModuleRuntime", "resolveAssistanceDefinition"),
    propulsionEffectIds: () => [g.propulsionModule.EFFECT_ID_AFTERBURNER, g.propulsionModule.EFFECT_ID_MICROWARPDRIVE],
    getAttributeIDByNames: late("liveFittingState", "getAttributeIDByNames"),
    isModuleOnline: late("liveFittingState", "isModuleOnline"),
    appendDirectModifierEntries: late("liveFittingState", "appendDirectModifierEntries"),
    buildPassiveShipResourceState: late("passiveDerivedState", "buildPassiveShipResourceState"),
    resolveActiveShipModifierSourceAttributes: late("activeShipModifiers", "resolveActiveShipModifierSourceAttributes"),
    collectEntityWormholeLocationModifierSources:
      late("activeShipModifiers", "collectEntityWormholeLocationModifierSources"),
    effectRecordSelfModifiesProjectedAttributes:
      late("activeShipModifiers", "effectRecordSelfModifiesProjectedAttributes"),
    collectShipAttributeModifierEntriesForSystem:
      late("wormholeEnvironmentRuntime", "collectShipAttributeModifierEntriesForSystem"),
    buildLiveModuleAttributeMap: late("liveModuleAttributes", "buildLiveModuleAttributeMap"),
    prepareLocalCycleActivation: late("localCycleRuntime", "prepareLocalCycleActivation"),
    executeLocalCycle: late("localCycleRuntime", "executeLocalCycle"),
    buildLocalCycleRuntimeCallbacks: late("moduleRuntimeCallbacks", "buildLocalCycleRuntimeCallbacks"),
    buildRuntimeShipItemFromEntity: late("entityDogmaView", "buildRuntimeShipItemFromEntity"),
    isRuntimeEntityDestroyingOrDestroyed: late("combatDestruction", "isRuntimeEntityDestroyingOrDestroyed"),
  };
}

function createActiveAccessFromGame(gameAdapter, input) {
  if (!gameAdapter || typeof gameAdapter.isConsumerAvailable !== "function"
    || !gameAdapter.isConsumerAvailable("active")) {
    return { ok: false, reason: "probe_active_unavailable" };
  }
  const game = {};
  for (const [key, rel] of Object.entries(ACCESS_MODULES)) {
    const loaded = gameAdapter.requireGame(rel);
    if (!loaded || !loaded.ok || !isObj(loaded.exports)) {
      return { ok: false, reason: `require_failed:${rel}:${loaded && loaded.reason}` };
    }
    game[key] = loaded.exports;
  }
  return { ok: true, access: createActiveAccess({ deps: depsFromGame(game), config: input && input.config,
    collectBurst: input && input.collectBurst, ewarFamilyOf: input && input.ewarFamilyOf }) };
}

module.exports = {
  ACCESS_MODULES, ACCESS_COUNTER_NAMES, LOCAL_REP_EFFECTS, UNSUPPORTED_KIND, RESONANCE_ATTRIBUTE_NAMES,
  createActiveAccess, createActiveAccessFromGame,
};
