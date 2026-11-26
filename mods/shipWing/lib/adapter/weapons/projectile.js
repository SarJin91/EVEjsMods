"use strict";

const { cycleOk, cycleFail } = require("../../core/cycleSchedule");
const { twinWeaponSnapshot } = require("./snapshot");

const BREACHER_FAMILY = "breacherPodLauncher";
const BOMB_FAMILY = "bombLauncher";
const BREACHER_FAILED_CODES = Object.freeze(["BREACHER_SPAWN_FAILED", "BREACHER_TARGET_LOST", "AMMO_UPDATE_FAILED",
  "OTHER"]);
const BOMB_REFUSAL_CODES = Object.freeze(["NO_AMMO", "UNSUPPORTED_BOMB", "INVALID_BOMB_SCENE", "BOMB_IN_EMPIRE_SPACE",
  "CANNOT_ACTIVATE_IN_WARP", "BOMB_SHIP_TOO_SLOW", "OTHER"]);
const BOMB_FAILED_CODES = Object.freeze(["BOMB_SPAWN_FAILED", "AMMO_UPDATE_FAILED", "OTHER"]);
const PROJECTILE_COUNTER_NAMES = Object.freeze([
  "combat.breacher.launched",
  ...BREACHER_FAILED_CODES.map((code) => `combat.breacher.launchFailed.${code}`),
  "combat.bomb.launched", "combat.bomb.aimMiss", "combat.bomb.blast.hit", "combat.bomb.blast.skipped",
  ...BOMB_REFUSAL_CODES.map((code) => `combat.bomb.refused.${code}`),
  ...BOMB_FAILED_CODES.map((code) => `combat.bomb.launchFailed.${code}`),
]);
const MS_PER_S = 1000;
const RAD_PER_DEG = Math.PI / 180;

function toInt(value, fallback = 0) {
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) ? n : fallback;
}

function codeOf(result, codes) {
  const code = String((result && result.errorMsg) || "OTHER");
  return codes.includes(code) ? code : "OTHER";
}

function durationOf(snapshot) {
  return Number.isFinite(snapshot.durationMs) && snapshot.durationMs > 0 ? snapshot.durationMs : null;
}

function countingConsume(charge, ammoLeft) {
  const left = Number(ammoLeft);
  const have = Number.isFinite(left) ? Math.floor(left)
    : Math.max(0, toInt(charge && (charge.quantity ?? charge.stacksize), 0));
  return () => ({ success: true, data: { nextQuantity: Math.max(0, have - 1) } });
}

function createBreacherHandler(env) {
  const { deps, config, twinScene, count, skip } = env;

  function range(twin, _weapon, resolved) {
    const snapshot = twinWeaponSnapshot(deps, twin, resolved.module, resolved.charge);
    if (!snapshot) return { ok: false, reason: "NO_SNAPSHOT" };
    return { ok: true, optimalM: Math.max(0, Number(snapshot.approxRange) || 0), falloffM: 0 };
  }

  function targetRefused(target, snapshot) {
    if (typeof deps.isBreacherPodTarget !== "function") return false;
    try {
      return deps.isBreacherPodTarget(target, snapshot.targetTypeListID) === false;
    } catch (_err) {
      return false;
    }
  }

  function fire(scene, twin, _weapon, target, simMs, opts) {
    const { module, charge } = opts;
    if (!charge) return skip("NO_AMMO", null);
    const snapshot = twinWeaponSnapshot(deps, twin, module, charge);
    if (!snapshot) return skip("NO_SNAPSHOT", null);
    if (snapshot.family !== BREACHER_FAMILY || deps.isValidBreacherSnapshot(snapshot) !== true) {
      return skip("UNSUPPORTED_FAMILY", durationOf(snapshot));
    }
    if (targetRefused(target, snapshot)) return skip("BREACHER_TARGET_INVALID", config.combatReacquireMs);
    const approxRange = Math.max(0, Number(snapshot.approxRange) || 0);
    if (twinScene.surfaceDistance(scene, twin, target) > approxRange) {
      return skip("OUT_OF_RANGE", config.combatReacquireMs);
    }
    const callbacks = { ...deps.buildBombRuntimeCallbacks(scene),
      consumeLoadedCharge: countingConsume(charge, opts.ammoLeft) };
    const out = deps.stageBreacherLaunch({ scene, attacker: twin, target, snapshot, moduleItem: module,
      chargeItem: charge, nowMs: simMs, callbacks });
    if (!out || out.success !== true) {
      count(`combat.breacher.launchFailed.${codeOf(out, BREACHER_FAILED_CODES)}`);
      return cycleFail("LAUNCH_FAILED", config.combatReacquireMs);
    }
    count("combat.breacher.launched");
    return cycleOk(snapshot.durationMs, { hit: false, applied: 0, destroyed: false,
      chargeItemId: toInt(charge.itemID, 0), chargeMode: "stack", chargesUsed: 1 });
  }

  return Object.freeze({
    id: "breacher",
    consumer: "combatBreacher",
    configKey: "combatBreacherEnabled",
    steers: true,
    needsLock: true,
    match: (_module, _charge, family) => family === BREACHER_FAMILY,
    needsAmmo: () => true,
    range,
    fire,
  });
}

function aimAngleDeg(twin, target) {
  const d = twin && twin.direction;
  const p = twin && twin.position;
  const q = target && target.position;
  if (!d || !p || !q) return null;
  const v = { x: Number(q.x) - Number(p.x), y: Number(q.y) - Number(p.y), z: Number(q.z) - Number(p.z) };
  const dl = Math.hypot(Number(d.x), Number(d.y), Number(d.z));
  const vl = Math.hypot(v.x, v.y, v.z);
  if (!(dl > 0) || !(vl > 0)) return null;
  const dot = (Number(d.x) * v.x + Number(d.y) * v.y + Number(d.z) * v.z) / (dl * vl);
  return Math.acos(Math.min(1, Math.max(-1, dot))) / RAD_PER_DEG;
}

function flightRangeOf(snapshot) {
  const v = Number(snapshot && snapshot.maxVelocity);
  const t = Number(snapshot && snapshot.flightTimeMs);
  if (!(v > 0) || !(t > 0)) return null;
  return (v * t) / MS_PER_S;
}

function createBombHandler(env) {
  const { deps, config, twinScene, count, skip } = env;

  function blastFilter(scene, twin) {
    return (_attacker, target) => {
      let ok = false;
      try {
        ok = env.npcAllowed(scene, twin, target) === true;
      } catch (_err) {
        ok = false;
      }
      count(ok ? "combat.bomb.blast.hit" : "combat.bomb.blast.skipped");
      return { success: ok };
    };
  }

  function range(twin, _weapon, resolved) {
    const meters = flightRangeOf(twinWeaponSnapshot(deps, twin, resolved.module, resolved.charge));
    if (meters === null) return { ok: false, reason: "NO_SNAPSHOT" };
    return { ok: true, optimalM: meters, falloffM: 0 };
  }

  function fire(scene, twin, _weapon, target, simMs, opts) {
    const { module, charge } = opts;
    const retryMs = config.combatReacquireMs;
    if (!charge) return skip("NO_AMMO", null);
    const snapshot = twinWeaponSnapshot(deps, twin, module, charge);
    if (!snapshot) return skip("NO_SNAPSHOT", null);
    if (snapshot.family !== BOMB_FAMILY || deps.isBombLauncher(module) !== true) {
      return skip("UNSUPPORTED_FAMILY", durationOf(snapshot));
    }
    const flightM = flightRangeOf(snapshot);
    if (flightM === null) return skip("NO_SNAPSHOT", null);
    if (twinScene.surfaceDistance(scene, twin, target) > flightM) return skip("OUT_OF_RANGE", retryMs);
    const angle = aimAngleDeg(twin, target);
    if (angle === null || angle > config.combatBombMaxAngleDeg) {
      count("combat.bomb.aimMiss");
      return skip("OUT_OF_RANGE", retryMs);
    }
    const activation = deps.resolveBombLauncherActivation({ scene, entity: twin, moduleItem: module, chargeItem: charge,
      snapshot });
    if (!activation || activation.success !== true || !activation.data) {
      count(`combat.bomb.refused.${codeOf(activation, BOMB_REFUSAL_CODES)}`);
      return skip("VENDOR_REFUSED", retryMs);
    }
    const callbacks = { ...deps.buildBombRuntimeCallbacks(scene),
      consumeLoadedCharge: countingConsume(charge, opts.ammoLeft),
      recordLaunch: () => {},
      recordAggression: blastFilter(scene, twin),
      hasCurrentSourceOwner: () => true };
    const out = deps.executeBombLaunchCycle({ scene, entity: twin, moduleItem: module, chargeItem: charge,
      effectState: { bombSnapshot: activation.data.snapshot }, nowMs: simMs, callbacks });
    if (!out || out.success !== true) {
      count(`combat.bomb.launchFailed.${codeOf(out, BOMB_FAILED_CODES)}`);
      return cycleFail("LAUNCH_FAILED", retryMs);
    }
    count("combat.bomb.launched");
    return cycleOk(snapshot.durationMs, { hit: false, applied: 0, destroyed: false,
      chargeItemId: toInt(charge.itemID, 0), chargeMode: "stack", chargesUsed: 1 });
  }

  return Object.freeze({
    id: "bomb",
    consumer: "combatBomb",
    configKey: "combatBombsEnabled",
    steers: false,
    needsLock: false,
    keepsMoving: true,
    match: (_module, _charge, family) => family === BOMB_FAMILY,
    needsAmmo: () => true,
    range,
    fire,
  });
}

module.exports = { createBreacherHandler, createBombHandler, PROJECTILE_COUNTER_NAMES, BREACHER_FAILED_CODES,
  BOMB_REFUSAL_CODES, BOMB_FAILED_CODES };
