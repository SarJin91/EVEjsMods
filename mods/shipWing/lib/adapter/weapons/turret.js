"use strict";

const { crystalBurnedOut } = require("../twinDogma");
const { cycleOk } = require("../../core/cycleSchedule");
const { twinWeaponSnapshot } = require("./snapshot");

function toInt(value, fallback = 0) {
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) ? n : fallback;
}

function createTurretShot(env) {
  const { deps, config, count } = env;

  function crystalOut(snapshot, charge) {
    return snapshot.chargeMode === "crystal" && Boolean(charge) && crystalBurnedOut(charge, {
      chargeTypeID: toInt(charge.typeID, 0), chargeAttributes: deps.getTypeDogmaAttributes(toInt(charge.typeID, 0)),
    }, deps);
  }

  function broadcastFx(scene, twin, module, charge, target, snapshot, family, extra) {
    if (config.combatFxEnabled !== true || typeof scene.broadcastSpecialFx !== "function") return;
    try {
      const guid = (typeof snapshot.effectGUID === "string" && snapshot.effectGUID)
        || deps.resolveWeaponSpecialFxGUID({ family, moduleItem: module, chargeItem: charge }) || "";
      if (!guid) return;
      scene.broadcastSpecialFx(twin.itemID, guid, {
        moduleID: toInt(module.itemID, 0),
        moduleTypeID: toInt(module.typeID, 0),
        targetID: toInt(target.itemID, 0),
        chargeTypeID: toInt(charge && charge.typeID, 0),
        start: true,
        active: false,
        duration: snapshot.durationMs,
        ...(extra || {}),
      }, twin);
    } catch (_err) {
      count("combat.fx.error");
    }
  }

  function shoot(scene, twin, module, charge, target, snapshot, simMs) {
    const shotResult = deps.resolveTurretShotWithConfiguredAdditive({ attackerEntity: twin, targetEntity: target,
      weaponSnapshot: snapshot });
    count("combat.volley.fired");
    const hit = Boolean(shotResult && shotResult.hit);
    count(hit ? "combat.volley.hit" : "combat.volley.miss");
    let applied = 0;
    let destroyed = false;
    if (hit && deps.hasDamageableHealth(target)) {
      const weaponDamageResult = deps.applyWeaponDamageToTarget(scene, twin, target, shotResult.shotDamage, simMs,
        { fabricatorDamageKind: null, incursionWeaponKind: "turret" }) || {};
      const destroyResult = weaponDamageResult.destroyResult;
      applied = Number(deps.getAppliedDamageAmount(weaponDamageResult.damageResult)) || 0;
      const tracker = deps.killmailTracker;
      if (applied > 0) {
        tracker.noteDamage(twin, target, applied, { whenMs: simMs, weaponSnapshot: snapshot, moduleItem: module,
          chargeItem: charge });
      }
      if (destroyResult && destroyResult.success) {
        destroyed = true;
        count("combat.volley.kill");
        tracker.enqueueKillmailFromDestruction(target, destroyResult, { attackerEntity: twin,
          victimSession: weaponDamageResult.victimSession, whenMs: simMs, weaponSnapshot: snapshot,
          moduleItem: module, chargeItem: charge });
      }
    }
    return { hit, applied, destroyed };
  }

  return Object.freeze({ crystalOut, broadcastFx, shoot });
}

function createTurretHandler(env) {
  const { deps, skip } = env;
  const turretShot = createTurretShot(env);

  function supportedFamily(family) {
    return Boolean(family) && deps.isTurretCycleWeaponFamily(family) === true
      && deps.isVortonWeaponFamily(family) !== true && deps.isPrecursorTurretFamily(family) !== true;
  }

  function range(twin, _weapon, resolved) {
    const snapshot = twinWeaponSnapshot(deps, twin, resolved.module, resolved.charge);
    if (!snapshot) return { ok: false, reason: "NO_SNAPSHOT" };
    return { ok: true, optimalM: Math.max(0, Number(snapshot.optimalRange) || 0),
      falloffM: Math.max(0, Number(snapshot.falloff) || 0) };
  }

  function fire(scene, twin, _weapon, target, simMs, opts) {
    const { module, charge, family } = opts;
    if (!charge && deps.isChargeOptionalTurretWeapon(module, charge) !== true) return skip("NO_AMMO", null);
    const snapshot = twinWeaponSnapshot(deps, twin, module, charge);
    if (!snapshot) return skip("NO_SNAPSHOT", null);
    const durationMs = Number.isFinite(snapshot.durationMs) && snapshot.durationMs > 0 ? snapshot.durationMs : null;
    if (!supportedFamily(snapshot.family)) return skip("UNSUPPORTED_FAMILY", durationMs);
    if (turretShot.crystalOut(snapshot, charge)) return skip("NO_AMMO", durationMs);
    turretShot.broadcastFx(scene, twin, module, charge, target, snapshot, family, null);
    const { hit, applied, destroyed } = turretShot.shoot(scene, twin, module, charge, target, snapshot, simMs);
    return cycleOk(snapshot.durationMs, { hit, applied, destroyed, chargeItemId: toInt(charge && charge.itemID, 0),
      chargeMode: String(snapshot.chargeMode || "") });
  }

  return Object.freeze({
    id: "turret",
    consumer: "combat",
    configKey: null,
    steers: true,
    needsLock: true,
    match: (_module, _charge, family) => supportedFamily(family),
    needsAmmo: (module, charge) => deps.isChargeOptionalTurretWeapon(module, charge) !== true,
    range,
    fire,
  });
}

module.exports = { createTurretHandler, createTurretShot };
