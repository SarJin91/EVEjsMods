// Port of the repair drones of droneRuntime.js, EveJS 261028.1 (see CREDITS.md).

"use strict";

const { PROFILE_PREFIX } = require("./data/capitalLiveProfiles");
const { FAX_CLASS, FX_GUID_BY_FAMILY } = require("./data/faxRepair");
const plan = require("./faxRepairPlan");

const WRAPPED = Symbol.for("livingNewEden.capitalFaxRepair");
const METHOD = "syncCapitalNpcMovement";
const RANGE_REASON = "lne-fax-repair";
const COUNTER_KEYS = Object.freeze(["cycles", "hp", "idle", "refused", "vendorActive", "errors"]);
const TOOL_FUNCTIONS = Object.freeze(["executeAssistanceModuleCycle", "getNpcAssistanceModules",
  "getSceneSurfaceDistance", "canEntitiesInteractLocally"]);
const INTEROP_FUNCTIONS = Object.freeze(["normalizeShipConditionState", "buildShipHealthTransitionResult",
  "notifyShipHealthAttributesToSession", "broadcastDamageStateChange", "persistDynamicEntity"]);

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const isObject = (value) => Boolean(value) && typeof value === "object";

function toInt(value, fallback) {
  const n = Math.trunc(Number(value));
  return Number.isSafeInteger(n) ? n : fallback;
}

let current = null;
const counters = { cycles: 0, hp: 0, idle: 0, refused: 0, vendorActive: 0, errors: 0 };
let faxStates = new WeakMap();

function checkTools(read) {
  if (!read || read.ok !== true || !isObject(read.tools)) return { ok: false, reason: "SEAM_UNAVAILABLE" };
  const tools = read.tools;
  for (const name of TOOL_FUNCTIONS) if (typeof tools[name] !== "function") return { ok: false, reason: "SEAM_UNAVAILABLE" };
  if (!isObject(tools.droneInterop)) return { ok: false, reason: "SEAM_UNAVAILABLE" };
  for (const name of INTEROP_FUNCTIONS) {
    if (typeof tools.droneInterop[name] !== "function") return { ok: false, reason: "SEAM_UNAVAILABLE" };
  }
  return { ok: true, tools };
}

function faxStateOf(fax) {
  let s = faxStates.get(fax);
  if (!s) {
    s = { nextCycleAtMs: 0 };
    faxStates.set(fax, s);
  }
  return s;
}

function isGone(entity) {
  return entity.destroyed === true || entity.destroying === true || entity.destructionState === "destroyed"
    || entity.destructionState === "destroying";
}

function candidatesOf(scene, fax, allyIds, family, nowMs, rangeMeters, tools) {
  const faxId = toInt(fax.itemID, 0);
  const out = [];
  for (const raw of allyIds) {
    const id = toInt(raw, 0);
    if (id <= 0 || id === faxId) continue;
    const ally = scene.getEntityByID(id);
    if (!isObject(ally) || isGone(ally)) continue;
    const need = plan.needRatio(ally, family);
    if (!(need > 0)) continue;
    if (tools.canEntitiesInteractLocally(fax, ally) !== true) continue;
    const distance = Number(tools.getSceneSurfaceDistance(scene, fax, ally, { nowMs, reason: RANGE_REASON }));
    if (!Number.isFinite(distance) || distance > rangeMeters) continue;
    out.push({ entityId: id, need, distance });
  }
  return out;
}

function broadcastBeam(scene, fax, targetId, family, cycleMs, onError) {
  try {
    scene.broadcastSpecialFx(fax.itemID, FX_GUID_BY_FAMILY[family], {
      moduleID: fax.itemID,
      moduleTypeID: fax.typeID,
      targetID: targetId,
      isOffensive: false,
      start: true,
      active: false,
      duration: cycleMs,
      repeat: 1,
    }, fax);
  } catch (err) {
    counters.errors += 1;
    if (typeof onError === "function") onError(err);
  }
}

function repairForController(scene, entity, controller, nowMs, deps) {
  const profileId = controller && controller.profileID;
  if (typeof profileId !== "string" || !profileId.startsWith(PROFILE_PREFIX)) return { ok: false, reason: "NOT_LNE" };
  const indexRead = deps.classIndex();
  const klass = indexRead && indexRead.ok === true && indexRead.index instanceof Map
    ? indexRead.index.get(profileId) : undefined;
  if (!klass || klass.cls !== FAX_CLASS) return { ok: false, reason: "NOT_FAX" };
  if (!isObject(scene) || !isObject(entity) || !Number.isFinite(nowMs)) return { ok: false, reason: "SEAM_UNAVAILABLE" };

  const fstate = faxStateOf(entity);
  if (nowMs < fstate.nextCycleAtMs) return { ok: false, reason: "NOT_DUE" };
  const params = deps.params;
  fstate.nextCycleAtMs = nowMs + params.cycleMs;

  const read = checkTools(deps.tools());
  if (!read.ok) return read;
  const tools = read.tools;
  const vendorModules = tools.getNpcAssistanceModules(entity);
  if (Array.isArray(vendorModules) && vendorModules.length > 0) {
    counters.vendorActive += 1;
    return { ok: false, reason: "VENDOR_ACTIVE" };
  }

  const faxId = toInt(entity.itemID, 0);
  const side = deps.liveSideOf(faxId);
  if (!side || side.ok !== true || !Array.isArray(side.allyIds)) return { ok: false, reason: "NOT_LIVE" };

  const typeId = toInt(entity.typeID, 0) > 0 ? toInt(entity.typeID, 0) : toInt(klass.typeId, 0);
  const family = plan.familyOfType(typeId);
  const best = plan.pickRepairTarget(candidatesOf(scene, entity, side.allyIds, family, nowMs, params.rangeMeters,
    tools));
  if (!best) {
    counters.idle += 1;
    return { ok: false, reason: "NO_TARGET" };
  }

  const amount = plan.repairAmountPerCycle({ remoteRepPerSec: deps.remoteRep(typeId), permille: params.permille,
    cycleMs: params.cycleMs });
  if (!amount.ok) {
    counters.refused += 1;
    return { ok: false, reason: amount.reason };
  }
  broadcastBeam(scene, entity, best.entityId, family, params.cycleMs, deps.onError);
  const interop = tools.droneInterop;
  const result = tools.executeAssistanceModuleCycle({
    scene,
    session: null,
    entity,
    effectState: plan.buildEffectState({ faxId, targetId: best.entityId, family, amount: amount.amount,
      rangeMeters: params.rangeMeters }),
    nowMs,
    isActivationPass: false,
    callbacks: {
      isEntityLockedTarget: () => true,
      getEntitySurfaceDistance: (source, target) => tools.getSceneSurfaceDistance(scene, source, target,
        { nowMs, reason: RANGE_REASON }),
      normalizeShipConditionState: interop.normalizeShipConditionState,
      buildShipHealthTransitionResult: interop.buildShipHealthTransitionResult,
      notifyShipHealthAttributesToSession: interop.notifyShipHealthAttributesToSession,
      broadcastDamageStateChange: interop.broadcastDamageStateChange,
      persistDynamicEntity: interop.persistDynamicEntity,
    },
  });
  if (!result || result.success !== true) {
    counters.refused += 1;
    return { ok: false, reason: "REFUSED" };
  }
  const applied = Math.round(Number(result.data && result.data.appliedAmount) || 0);
  counters.cycles += 1;
  counters.hp += applied;
  return { ok: true, targetId: best.entityId, applied };
}

function nowOf(scene, options) {
  const fromOptions = Number(options && options.nowMs);
  if (Number.isFinite(fromOptions)) return fromOptions;
  if (scene && typeof scene.getCurrentSimTimeMs === "function") return Number(scene.getCurrentSimTimeMs());
  return NaN;
}

function countDelta(before) {
  const delta = {};
  let any = false;
  for (const key of COUNTER_KEYS) {
    delta[key] = counters[key] - before[key];
    if (delta[key] !== 0) any = true;
  }
  return any ? delta : null;
}

function notify(listener, value) {
  if (typeof listener !== "function") return;
  try {
    listener(value);
  } catch (_err) {
  }
}

function makeWrapper(original, state) {
  const wrapper = function livingNewEdenCapitalFaxRepair(scene, entity, controller, target, movementDirective,
    options) {
    const result = original.apply(this, arguments);
    const profileId = controller && controller.profileID;
    if (typeof profileId !== "string" || !profileId.startsWith(PROFILE_PREFIX)) return result;
    const before = { ...counters };
    try {
      repairForController(scene, entity, controller, nowOf(scene, options), state.deps);
    } catch (err) {
      counters.errors += 1;
      notify(state.onError, err);
    }
    const delta = countDelta(before);
    if (delta) notify(state.onCounts, delta);
    return result;
  };
  Object.defineProperty(wrapper, "name", { value: `livingNewEden_${METHOD}` });
  for (const s of Object.getOwnPropertySymbols(original)) {
    if (s !== WRAPPED) wrapper[s] = original[s];
  }
  wrapper[WRAPPED] = true;
  return wrapper;
}

function install(movementExports, opts) {
  if (!isObject(movementExports) || !hasOwn(movementExports, METHOD)
    || typeof movementExports[METHOD] !== "function") {
    return { ok: false, reason: "BAD_EXPORTS" };
  }
  if (!isObject(opts) || opts.enabled !== true) return { ok: false, reason: "DISABLED" };
  const deps = isObject(opts.deps) ? opts.deps : null;
  if (!deps || typeof deps.tools !== "function" || typeof deps.classIndex !== "function"
    || typeof deps.remoteRep !== "function" || typeof deps.liveSideOf !== "function") {
    return { ok: false, reason: "BAD_EXPORTS" };
  }
  const existing = movementExports[METHOD];
  if (existing[WRAPPED] === true) return { ok: true, alreadyInstalled: true };
  const onError = opts.onError;
  const state = {
    deps: { ...deps, params: { ...opts.params }, onError: (err) => notify(onError, err) },
    onCounts: opts.onCounts,
    onError,
  };
  const wrapper = makeWrapper(existing, state);
  try {
    movementExports[METHOD] = wrapper;
  } catch (_err) {
    return { ok: false, reason: "NOT_WRITABLE" };
  }
  if (movementExports[METHOD] !== wrapper) return { ok: false, reason: "NOT_WRITABLE" };
  current = state;
  return { ok: true, alreadyInstalled: false };
}

function stats() {
  return { installed: current !== null, ...counters };
}

function _resetForTest() {
  current = null;
  for (const key of COUNTER_KEYS) counters[key] = 0;
  faxStates = new WeakMap();
}

module.exports = {
  WRAPPED,
  METHOD,
  TOOL_FUNCTIONS,
  INTEROP_FUNCTIONS,
  install,
  repairForController,
  stats,
  _resetForTest,
};
