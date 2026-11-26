"use strict";

const { cycleOk } = require("../../core/cycleSchedule");
const { twinWeaponSnapshot } = require("./snapshot");
const { createTurretShot } = require("./turret");

const PRECURSOR_COUNTER_NAMES = Object.freeze(["combat.precursor.spoolReset"]);

function toInt(value, fallback = 0) {
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) ? n : fallback;
}

function createPrecursorHandler(env) {
  const { deps, config, twinScene, count, skip } = env;
  const turretShot = createTurretShot(env);

  function precursorFamily(family) {
    return Boolean(family) && deps.isPrecursorTurretFamily(family) === true;
  }

  function createState(module, _charge, family) {
    return { weaponFamily: String(family), moduleID: toInt(module && module.itemID, 0), targetID: 0,
      lastFireSimMs: null };
  }

  function stateOf(weapon, module, family) {
    if (weapon && weapon.state !== null && typeof weapon.state === "object") return weapon.state;
    return createState(module, null, family);
  }

  function range(twin, _weapon, resolved) {
    const snapshot = twinWeaponSnapshot(deps, twin, resolved.module, resolved.charge);
    if (!snapshot) return { ok: false, reason: "NO_SNAPSHOT" };
    return { ok: true, optimalM: Math.max(0, Number(snapshot.optimalRange) || 0), falloffM: 0 };
  }

  function fire(scene, twin, weapon, target, simMs, opts) {
    const { module, charge, family } = opts;
    if (!charge && deps.isChargeOptionalTurretWeapon(module, charge) !== true) return skip("NO_AMMO", null);
    const snapshot = twinWeaponSnapshot(deps, twin, module, charge);
    if (!snapshot) return skip("NO_SNAPSHOT", null);
    const durationMs = Number.isFinite(snapshot.durationMs) && snapshot.durationMs > 0 ? snapshot.durationMs : null;
    if (!precursorFamily(snapshot.family)) return skip("UNSUPPORTED_FAMILY", durationMs);
    if (turretShot.crystalOut(snapshot, charge)) return skip("NO_AMMO", durationMs);
    const state = stateOf(weapon, module, snapshot.family);
    const last = state.lastFireSimMs;
    const keepCycles = Math.max(0, toInt(config.combatPrecursorSpoolKeepCycles, 0));
    if (durationMs !== null && Number.isFinite(last) && simMs - last > (1 + keepCycles) * durationMs) {
      deps.resetPrecursorTurretSpool(state);
      count("combat.precursor.spoolReset");
      state.lastFireSimMs = null;
    }
    state.targetID = toInt(target.itemID, 0);
    deps.synchronizePrecursorTurretEffectState(state, snapshot, simMs);
    const optimal = Math.max(0, Number(snapshot.optimalRange) || 0);
    if (twinScene.surfaceDistance(scene, twin, target) > optimal) {
      deps.resetPrecursorTurretSpool(state);
      if (Number.isFinite(state.lastFireSimMs)) count("combat.precursor.spoolReset");
      state.lastFireSimMs = null;
      return skip("OUT_OF_RANGE", config.combatReacquireMs);
    }
    const presented = deps.applyPrecursorTurretSpoolToSnapshot(snapshot, state) || snapshot;
    let graphicInfo = null;
    if (config.combatFxEnabled === true) {
      try {
        graphicInfo = deps.buildPrecursorTurretGraphicInfo(state);
      } catch (_err) {
        count("combat.fx.error");
      }
    }
    turretShot.broadcastFx(scene, twin, module, charge, target, presented, family,
      graphicInfo ? { graphicInfo } : null);
    const { hit, applied, destroyed } = turretShot.shoot(scene, twin, module, charge, target, presented, simMs);
    deps.advancePrecursorTurretSpool(state, snapshot, simMs);
    state.lastFireSimMs = simMs;
    return cycleOk(snapshot.durationMs, { hit, applied, destroyed, chargeItemId: toInt(charge && charge.itemID, 0),
      chargeMode: String(snapshot.chargeMode || "") });
  }

  return Object.freeze({
    id: "precursor",
    consumer: "combatPrecursor",
    configKey: "combatPrecursorEnabled",
    steers: true,
    needsLock: true,
    match: (_module, _charge, family) => precursorFamily(family),
    needsAmmo: (module, charge) => deps.isChargeOptionalTurretWeapon(module, charge) !== true,
    createState,
    range,
    fire,
  });
}

module.exports = { createPrecursorHandler, PRECURSOR_COUNTER_NAMES };
