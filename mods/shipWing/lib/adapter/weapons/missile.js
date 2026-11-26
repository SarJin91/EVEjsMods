"use strict";

const { cycleOk, cycleFail } = require("../../core/cycleSchedule");
const { twinWeaponSnapshot } = require("./snapshot");

const LAUNCH_FAILED_CODES = Object.freeze(["TARGET_NOT_FOUND", "TARGET_OUT_OF_RANGE", "MISSILE_SPAWN_FAILED",
  "OTHER"]);
const MISSILE_COUNTER_NAMES = Object.freeze([
  "combat.missile.launched",
  ...LAUNCH_FAILED_CODES.map((code) => `combat.missile.launchFailed.${code}`),
]);
const BREACHER_FAMILY = "breacherPodLauncher";

function toInt(value, fallback = 0) {
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) ? n : fallback;
}

function createMissileHandler(env) {
  const { deps, config, twinScene, count, skip } = env;

  function missileFamily(family) {
    return Boolean(family) && family !== BREACHER_FAMILY && deps.isMissileWeaponFamily(family) === true;
  }

  function defender(module, charge) {
    return deps.isDefenderMissileWeaponSnapshot({ moduleGroupID: toInt(module && module.groupID, 0),
      chargeGroupID: toInt(charge && charge.groupID, 0) }) === true;
  }

  function range(twin, _weapon, resolved) {
    const snapshot = twinWeaponSnapshot(deps, twin, resolved.module, resolved.charge);
    if (!snapshot) return { ok: false, reason: "NO_SNAPSHOT" };
    return { ok: true, optimalM: Math.max(0, Number(snapshot.approxRange) || 0), falloffM: 0 };
  }

  function fire(scene, twin, _weapon, target, simMs, opts) {
    const { module, charge } = opts;
    if (!charge) return skip("NO_AMMO", null);
    const snapshot = twinWeaponSnapshot(deps, twin, module, charge);
    if (!snapshot) return skip("NO_SNAPSHOT", null);
    const durationMs = Number.isFinite(snapshot.durationMs) && snapshot.durationMs > 0 ? snapshot.durationMs : null;
    if (!missileFamily(snapshot.family) || deps.isDefenderMissileWeaponSnapshot(snapshot) === true) {
      return skip("UNSUPPORTED_FAMILY", durationMs);
    }
    const approxRange = Math.max(0, Number(snapshot.approxRange) || 0);
    if (twinScene.surfaceDistance(scene, twin, target) > approxRange) {
      return skip("OUT_OF_RANGE", config.combatReacquireMs);
    }
    const moduleId = toInt(module.itemID, 0);
    const result = scene.launchMissile(twin, toInt(target.itemID, 0), snapshot, {
      launchTimeMs: simMs,
      chargeItem: charge,
      moduleItem: module,
      launchModules: [moduleId],
      skipRangeCheck: true,
    });
    if (!result || result.success !== true || !result.data) {
      const code = LAUNCH_FAILED_CODES.includes(result && result.errorMsg) ? result.errorMsg : "OTHER";
      count(`combat.missile.launchFailed.${code}`);
      return cycleFail("LAUNCH_FAILED", config.combatReacquireMs);
    }
    count("combat.missile.launched");
    return cycleOk(snapshot.durationMs, { hit: false, applied: 0, destroyed: false,
      chargeItemId: toInt(charge.itemID, 0), chargeMode: "stack", chargesUsed: 1 });
  }

  return Object.freeze({
    id: "missile",
    consumer: "combatMissile",
    configKey: "combatMissilesEnabled",
    steers: true,
    needsLock: true,
    match: (module, charge, family) => missileFamily(family) && !defender(module, charge),
    needsAmmo: () => true,
    range,
    fire,
  });
}

module.exports = { createMissileHandler, MISSILE_COUNTER_NAMES, LAUNCH_FAILED_CODES };
