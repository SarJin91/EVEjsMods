// Port of executeFighterOffensiveCycle and syncFighterOffensiveMovement of EveJS 261028.1 (see CREDITS.md).

"use strict";

const { PROFILE_PREFIX } = require("./data/capitalLiveProfiles");
const plan = require("./fighterStrikePlan");

const WRAPPED = Symbol.for("livingNewEden.capitalFighterStrike");
const METHOD = "syncNpcSupercarrierSystems";
const CONTROLLER_ORBIT_METERS = 1500;
const RANGE_SLACK_METERS = 1;
const RANGE_REASON = "lne-capital-fighter";
const COUNTER_KEYS = Object.freeze(["strikes", "hits", "kills", "skipped", "errors"]);
const TOOL_FUNCTIONS = Object.freeze(["resolveFighterAbilitySnapshot", "getFighterOrbitDistance",
  "resolveMissileAppliedDamage", "hasDamageableHealth", "getSceneSurfaceDistance", "isWarping",
  "canEntitiesInteractLocally", "listControlledNpcFighters", "gateProbe"]);
const INTEROP_FUNCTIONS = Object.freeze(["resolveTurretShot", "getCombatMessageHitQuality", "getAppliedDamageAmount",
  "notifyWeaponDamageMessages", "applyWeaponDamageToTarget", "noteKillmailDamage", "recordKillmailFromDestruction"]);

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const isObject = (value) => Boolean(value) && typeof value === "object";

function toInt(value, fallback) {
  const n = Math.trunc(Number(value));
  return Number.isSafeInteger(n) ? n : fallback;
}

let current = null;
const counters = { strikes: 0, hits: 0, kills: 0, skipped: 0, errors: 0 };
let gate = "pending";
let fighterStates = new WeakMap();
let controllerStates = new WeakMap();

function checkTools(read) {
  if (!read || read.ok !== true || !isObject(read.tools)) return { ok: false, reason: "SEAM_MISSING" };
  const tools = read.tools;
  for (const name of TOOL_FUNCTIONS) if (typeof tools[name] !== "function") return { ok: false, reason: "SEAM_MISSING" };
  if (!isObject(tools.droneInterop)) return { ok: false, reason: "SEAM_MISSING" };
  for (const name of INTEROP_FUNCTIONS) {
    if (typeof tools.droneInterop[name] !== "function") return { ok: false, reason: "SEAM_MISSING" };
  }
  return { ok: true, tools };
}

function pseudoModuleItemOf(fighter, slotID) {
  return {
    itemID: toInt(fighter.itemID, 0),
    typeID: toInt(fighter.typeID, 0),
    groupID: toInt(fighter.groupID, 0),
    flagID: Math.max(0, toInt(slotID, 0)),
    locationID: toInt(fighter.itemID, 0),
    singleton: 1,
    quantity: 1,
    stacksize: 1,
    itemName: String(fighter.itemName || "Fighter"),
    moduleState: { isOnline: true, isActive: true },
  };
}

function combatSourceOf(fighter) {
  return { ...fighter, session: null, characterID: null, pilotCharacterID: null };
}

function fighterStateOf(fighter) {
  let s = fighterStates.get(fighter);
  if (!s) {
    s = { nextCycleAtMs: 0, permille: 0, order: null, orderTargetId: 0, inert: false };
    fighterStates.set(fighter, s);
  }
  return s;
}

function controllerStateOf(controller) {
  let s = controllerStates.get(controller);
  if (!s) {
    s = { nextDueAtMs: 0, targetId: 0, hadTarget: false, noClass: false };
    controllerStates.set(controller, s);
  }
  return s;
}

const BALL_MODE = Object.freeze({ follow: "FOLLOW", orbit: "ORBIT", home: "ORBIT" });

function stillExecuting(fighter, fstate, kind, targetId) {
  return fstate.order === kind && fstate.orderTargetId === targetId
    && String(fighter.mode).toUpperCase() === BALL_MODE[kind] && toInt(fighter.targetEntityID, 0) === targetId;
}

function order(scene, fighter, fstate, kind, targetId, distance) {
  if (stillExecuting(fighter, fstate, kind, targetId)) return;
  if (kind === "follow") scene.followShipEntity(fighter, targetId, distance, { broadcast: true });
  else scene.orbitShipEntity(fighter, targetId, distance, { broadcast: true });
  fstate.order = kind;
  fstate.orderTargetId = targetId;
}

function move(scene, fighter, fstate, target, snapshot, nowMs, tools) {
  const distance = Number(tools.getSceneSurfaceDistance(scene, fighter, target, { nowMs, reason: RANGE_REASON }));
  if (tools.isWarping(target)) return distance;
  const orbit = Number(tools.getFighterOrbitDistance(fighter)) || 0;
  const range = Math.max(0, Number(snapshot.rangeMeters) || 0);
  const falloff = Math.max(0, Number(snapshot.falloffMeters) || 0);
  const attackRange = Math.max(orbit, range);
  const chaseRange = attackRange + falloff;
  const targetId = toInt(target.itemID, 0);
  if (distance > chaseRange + RANGE_SLACK_METERS) order(scene, fighter, fstate, "follow", targetId, attackRange);
  else order(scene, fighter, fstate, "orbit", targetId, orbit);
  return distance;
}

function fire(scene, fighter, target, snapshot, permille, slotID, nowMs, tools) {
  const interop = tools.droneInterop;
  const rawShotDamage = plan.scaleDamageVector(snapshot.rawShotDamage, permille);
  const moduleItem = pseudoModuleItemOf(fighter, slotID);
  const source = combatSourceOf(fighter);
  const weaponSnapshot = { ...snapshot, rawShotDamage, moduleTypeID: moduleItem.typeID };
  if (snapshot.effectGuid) {
    scene.broadcastSpecialFx(fighter.itemID, snapshot.effectGuid, {
      moduleID: moduleItem.itemID,
      moduleTypeID: moduleItem.typeID,
      targetID: target.itemID,
      isOffensive: true,
      start: true,
      active: false,
      duration: Math.max(1, toInt(snapshot.durationMs, 1)),
      repeat: 1,
    }, fighter);
  }
  let shotDamage = null;
  let hitQuality = 0;
  let weaponResult = null;
  if (snapshot.offensiveKind === "turret") {
    const shot = interop.resolveTurretShot({
      attackerEntity: fighter,
      targetEntity: target,
      weaponSnapshot: {
        rawShotDamage,
        trackingSpeed: snapshot.trackingSpeed,
        optimalSigRadius: snapshot.optimalSigRadius,
        optimalRange: snapshot.rangeMeters,
        falloff: snapshot.falloffMeters,
      },
    });
    shotDamage = shot && shot.shotDamage ? shot.shotDamage : null;
    hitQuality = interop.getCombatMessageHitQuality(shot);
    if (shot && shot.hit === true) {
      weaponResult = interop.applyWeaponDamageToTarget(scene, source, target, shot.shotDamage, nowMs);
    }
  } else {
    const applied = tools.resolveMissileAppliedDamage({
      rawShotDamage,
      explosionRadius: snapshot.explosionRadius,
      explosionVelocity: snapshot.explosionVelocity,
      damageReductionFactor: snapshot.damageReductionFactor,
      damageReductionSensitivity: snapshot.damageReductionSensitivity,
    }, target);
    shotDamage = applied && applied.appliedDamage ? applied.appliedDamage : null;
    hitQuality = plan.sumDamage(shotDamage) > 0 ? 4 : 0;
    if (plan.sumDamage(shotDamage) > 0) {
      weaponResult = interop.applyWeaponDamageToTarget(scene, source, target, shotDamage, nowMs);
    }
  }
  const damageResult = weaponResult && weaponResult.damageResult ? weaponResult.damageResult : null;
  const destroyResult = weaponResult && weaponResult.destroyResult ? weaponResult.destroyResult : null;
  const amount = Number(interop.getAppliedDamageAmount(damageResult)) || 0;
  if (amount > 0) {
    interop.noteKillmailDamage(source, target, amount, { whenMs: nowMs, weaponSnapshot, moduleItem, chargeItem: null });
  }
  const killed = Boolean(destroyResult) && destroyResult.success === true;
  if (killed) {
    interop.recordKillmailFromDestruction(target, destroyResult, {
      attackerEntity: source,
      victimSession: weaponResult && weaponResult.victimSession,
      whenMs: nowMs,
      weaponSnapshot,
      moduleItem,
      chargeItem: null,
    });
  }
  interop.notifyWeaponDamageMessages(source, target, moduleItem, shotDamage, amount, hitQuality);
  return { hit: amount > 0, killed };
}

function permilleOf(fstate, snapshot, klass, deps) {
  if (fstate.permille > 0) return { ok: true, permille: fstate.permille };
  const scaled = plan.squadronScalePermille({
    rowDps: deps.rowDps(klass.typeId, klass.cls),
    dpsPermille: deps.params.dpsPermille,
    tubes: deps.tubes(klass.cls),
    totalRawDamage: snapshot.totalRawDamage,
    durationMs: snapshot.durationMs,
    scaleMaxPermille: deps.params.scaleMaxPermille,
  });
  if (scaled.ok) fstate.permille = scaled.permille;
  return scaled;
}

function resolveGate(tools, deps) {
  if (gate !== "pending") return gate;
  let answer;
  try {
    answer = tools.gateProbe();
  } catch (_err) {
    answer = null;
  }
  gate = answer === false ? "ok" : (answer === true ? "fixed" : "unknown");
  if (typeof deps.onGate === "function") deps.onGate(gate);
  return gate;
}

function recallToController(scene, entity, cstate, tools) {
  cstate.hadTarget = false;
  cstate.targetId = 0;
  cstate.nextDueAtMs = 0;
  const controllerId = toInt(entity.itemID, 0);
  for (const fighter of tools.listControlledNpcFighters(scene, controllerId)) {
    const fstate = fighterStateOf(fighter);
    if (stillExecuting(fighter, fstate, "home", controllerId)) continue;
    scene.orbitShipEntity(fighter, controllerId, CONTROLLER_ORBIT_METERS, { broadcast: true });
    fstate.order = "home";
    fstate.orderTargetId = controllerId;
  }
}

function strikeForController(scene, entity, controller, behaviorProfile, targetEntity, nowMs, deps) {
  const profileId = controller && controller.profileID;
  if (typeof profileId !== "string" || !profileId.startsWith(PROFILE_PREFIX)) return { ok: false, reason: "NOT_LNE" };
  if (gate === "fixed" || gate === "unknown") return { ok: false, reason: "GATE_FIXED" };
  if (!isObject(scene) || !isObject(entity) || !Number.isFinite(nowMs)) return { ok: false, reason: "SEAM_MISSING" };
  const cstate = controllerStateOf(controller);
  const targetId = isObject(targetEntity) ? toInt(targetEntity.itemID, 0) : 0;
  if (targetId <= 0 && !cstate.hadTarget) return { ok: false, reason: "NO_TARGET" };
  if (targetId > 0 && targetId === cstate.targetId && nowMs < cstate.nextDueAtMs) return { ok: false, reason: "NOT_DUE" };
  if (cstate.noClass) return { ok: false, reason: "NO_CLASS" };

  const read = checkTools(deps.tools());
  if (!read.ok) return read;
  const tools = read.tools;
  if (resolveGate(tools, deps) !== "ok") return { ok: false, reason: "GATE_FIXED" };
  if (targetId <= 0) {
    recallToController(scene, entity, cstate, tools);
    return { ok: false, reason: "NO_TARGET" };
  }

  const indexRead = deps.classIndex();
  const klass = plan.classOfProfile(profileId, indexRead && indexRead.ok === true ? indexRead.index : null);
  if (!klass.ok) {
    cstate.noClass = true;
    counters.skipped += 1;
    return { ok: false, reason: "NO_CLASS" };
  }

  const out = { ok: true, strikes: 0, hits: 0, kills: 0, skipped: 0 };
  cstate.hadTarget = true;
  cstate.targetId = targetId;
  const slotID = toInt(behaviorProfile && behaviorProfile.capitalFighterAbilitySlotID, 0);
  let nextDue = Infinity;
  const targetAlive = tools.hasDamageableHealth(targetEntity) === true;
  for (const fighter of tools.listControlledNpcFighters(scene, toInt(entity.itemID, 0))) {
    const fstate = fighterStateOf(fighter);
    if (fstate.inert) continue;
    const snapshot = slotID >= 0 ? tools.resolveFighterAbilitySnapshot(fighter, entity, slotID) : null;
    if (!plan.isStrikeKind(snapshot)) {
      if (isObject(snapshot)) fstate.inert = true;
      out.skipped += 1;
      continue;
    }
    if (!targetAlive || tools.canEntitiesInteractLocally(fighter, targetEntity) !== true) {
      out.skipped += 1;
      nextDue = Math.min(nextDue, nowMs);
      continue;
    }
    const distance = move(scene, fighter, fstate, targetEntity, snapshot, nowMs, tools);
    const rangeGate = Math.max(0, Number(snapshot.rangeMeters) || 0) + Math.max(0, Number(snapshot.falloffMeters) || 0);
    if (rangeGate > 0 && !(distance <= rangeGate + RANGE_SLACK_METERS)) {
      nextDue = Math.min(nextDue, nowMs);
      continue;
    }
    if (!plan.nextCycleDue(fstate, nowMs)) {
      nextDue = Math.min(nextDue, fstate.nextCycleAtMs);
      continue;
    }
    const scaled = permilleOf(fstate, snapshot, klass, deps);
    if (!scaled.ok) {
      fstate.inert = true;
      out.skipped += 1;
      continue;
    }
    fstate.nextCycleAtMs = nowMs + Math.max(1, toInt(snapshot.durationMs, 1));
    nextDue = Math.min(nextDue, fstate.nextCycleAtMs);
    out.strikes += 1;
    const shot = fire(scene, fighter, targetEntity, snapshot, scaled.permille, slotID, nowMs, tools);
    if (shot.hit) out.hits += 1;
    if (shot.killed) {
      out.kills += 1;
      nextDue = nowMs;
      break;
    }
  }
  cstate.nextDueAtMs = Number.isFinite(nextDue) ? nextDue : nowMs;
  counters.strikes += out.strikes;
  counters.hits += out.hits;
  counters.kills += out.kills;
  counters.skipped += out.skipped;
  return out;
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
  const wrapper = function livingNewEdenCapitalFighterStrike(scene, entity, controller, behaviorProfile, targetEntity,
    options) {
    const result = original.apply(this, arguments);
    const profileId = controller && controller.profileID;
    if (typeof profileId !== "string" || !profileId.startsWith(PROFILE_PREFIX)) return result;
    const before = { ...counters };
    try {
      strikeForController(scene, entity, controller, behaviorProfile, targetEntity, nowOf(scene, options), state.deps);
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

function install(directorExports, opts) {
  if (!isObject(directorExports) || !hasOwn(directorExports, METHOD)
    || typeof directorExports[METHOD] !== "function") {
    return { ok: false, reason: "BAD_EXPORTS" };
  }
  if (!isObject(opts) || opts.enabled !== true) return { ok: false, reason: "DISABLED" };
  const deps = isObject(opts.deps) ? opts.deps : null;
  if (!deps || typeof deps.tools !== "function" || typeof deps.classIndex !== "function"
    || typeof deps.rowDps !== "function" || typeof deps.tubes !== "function") {
    return { ok: false, reason: "BAD_EXPORTS" };
  }
  if (typeof opts.gateProbe === "function") {
    let answer;
    try {
      answer = opts.gateProbe();
    } catch (_err) {
      answer = null;
    }
    if (answer === true) {
      gate = "fixed";
      return { ok: false, reason: "GATE_FIXED" };
    }
    if (answer !== false) {
      gate = "unknown";
      return { ok: false, reason: "GATE_UNKNOWN" };
    }
    gate = "ok";
  }
  const existing = directorExports[METHOD];
  if (existing[WRAPPED] === true) {
    return { ok: true, alreadyInstalled: true };
  }
  const state = {
    deps: { ...deps, params: { ...opts.params }, onGate: opts.onGate },
    onCounts: opts.onCounts,
    onError: opts.onError,
  };
  const wrapper = makeWrapper(existing, state);
  try {
    directorExports[METHOD] = wrapper;
  } catch (_err) {
    return { ok: false, reason: "NOT_WRITABLE" };
  }
  if (directorExports[METHOD] !== wrapper) return { ok: false, reason: "NOT_WRITABLE" };
  current = state;
  return { ok: true, alreadyInstalled: false };
}

function stats() {
  return { installed: current !== null, gate, ...counters };
}

function _resetForTest() {
  current = null;
  gate = "pending";
  for (const key of COUNTER_KEYS) counters[key] = 0;
  fighterStates = new WeakMap();
  controllerStates = new WeakMap();
}

module.exports = {
  WRAPPED,
  METHOD,
  CONTROLLER_ORBIT_METERS,
  TOOL_FUNCTIONS,
  INTEROP_FUNCTIONS,
  install,
  strikeForController,
  stats,
  _resetForTest,
};
