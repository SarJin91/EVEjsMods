"use strict";

const { cycleOk } = require("../../core/cycleSchedule");
const { twinWeaponSnapshot } = require("./snapshot");
const { createTurretShot } = require("./turret");

const VORTON_COUNTER_NAMES = Object.freeze(["combat.vorton.arc.hit", "combat.vorton.arc.miss",
  "combat.vorton.arc.kill", "combat.vorton.arc.error"]);
const ARC_DAMAGE_OPTIONS = Object.freeze({ fabricatorDamageKind: "vorton" });

function toInt(value, fallback = 0) {
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) ? n : fallback;
}

function createVortonHandler(env) {
  const { deps, config, twinScene, count, skip, targetAllowed } = env;
  const turretShot = createTurretShot(env);

  function vortonFamily(family) {
    return Boolean(family) && deps.isVortonWeaponFamily(family) === true;
  }

  function range(twin, _weapon, resolved) {
    const snapshot = twinWeaponSnapshot(deps, twin, resolved.module, resolved.charge);
    if (!snapshot) return { ok: false, reason: "NO_SNAPSHOT" };
    return { ok: true, optimalM: Math.max(0, Number(snapshot.optimalRange) || 0), falloffM: 0 };
  }

  function arcTargets(scene, twin, host, target, snapshot) {
    if (config.combatVortonArcsEnabled !== true || !host) return [];
    try {
      if (!scene || !(scene.dynamicEntities instanceof Map)) {
        count("combat.vorton.arc.error");
        return [];
      }
      const pool = scene.dynamicEntities;
      const candidates = [];
      for (const entity of pool.values()) {
        if (!entity || entity === target || entity === twin || entity.kind !== "ship") continue;
        if (deps.hasDamageableHealth(entity) !== true) continue;
        if (targetAllowed(scene, twin, host, entity) !== true) continue;
        candidates.push(entity);
      }
      if (candidates.length === 0) return [];
      const links = deps.selectVortonArcTargets({ attackerEntity: twin, primaryTargetEntity: target,
        candidateEntities: candidates, weaponSnapshot: snapshot });
      const offered = new Set(candidates);
      return (Array.isArray(links) ? links : []).map((link) => link && link.entity)
        .filter((entity) => offered.delete(entity));
    } catch (_err) {
      count("combat.vorton.arc.error");
      return [];
    }
  }

  function broadcastFx(scene, twin, module, charge, target, snapshot, family, arcs) {
    if (config.combatFxEnabled !== true || typeof deps.broadcastVortonCycleSpecialFx !== "function") return;
    try {
      const guid = (typeof snapshot.effectGUID === "string" && snapshot.effectGUID)
        || deps.resolveWeaponSpecialFxGUID({ family, moduleItem: module, chargeItem: charge }) || "";
      if (!guid) return;
      deps.broadcastVortonCycleSpecialFx(scene, twin, {
        weaponFamily: String(snapshot.family),
        moduleID: toInt(module.itemID, 0),
        typeID: toInt(module.typeID, 0),
        targetID: toInt(target.itemID, 0),
        chargeTypeID: toInt(charge && charge.typeID, 0),
        durationMs: snapshot.durationMs,
        guid,
        vortonArcTargetIDs: arcs.map((entity) => toInt(entity.itemID, 0)),
      });
    } catch (_err) {
      count("combat.fx.error");
    }
  }

  function strike(scene, twin, module, charge, victim, shotDamage, snapshot, simMs) {
    const weaponDamageResult = deps.applyWeaponDamageToTarget(scene, twin, victim, shotDamage, simMs,
      { ...ARC_DAMAGE_OPTIONS }) || {};
    const destroyResult = weaponDamageResult.destroyResult;
    const applied = Number(deps.getAppliedDamageAmount(weaponDamageResult.damageResult)) || 0;
    const tracker = deps.killmailTracker;
    if (applied > 0) {
      tracker.noteDamage(twin, victim, applied, { whenMs: simMs, weaponSnapshot: snapshot, moduleItem: module,
        chargeItem: charge });
    }
    let destroyed = false;
    if (destroyResult && destroyResult.success) {
      destroyed = true;
      tracker.enqueueKillmailFromDestruction(victim, destroyResult, { attackerEntity: twin,
        victimSession: weaponDamageResult.victimSession, whenMs: simMs, weaponSnapshot: snapshot,
        moduleItem: module, chargeItem: charge });
    }
    return { applied, destroyed };
  }

  function arc(scene, twin, module, charge, victim, snapshot, simMs) {
    try {
      const arcShot = deps.resolveVortonArcShot({ targetEntity: victim, weaponSnapshot: snapshot });
      if (!arcShot || arcShot.hit !== true) {
        count("combat.vorton.arc.miss");
        return;
      }
      count("combat.vorton.arc.hit");
      if (strike(scene, twin, module, charge, victim, arcShot.shotDamage, snapshot, simMs).destroyed) {
        count("combat.vorton.arc.kill");
      }
    } catch (_err) {
      count("combat.vorton.arc.error");
    }
  }

  function fire(scene, twin, _weapon, target, simMs, opts) {
    const { module, charge, family } = opts;
    if (!charge && deps.isChargeOptionalTurretWeapon(module, charge) !== true) return skip("NO_AMMO", null);
    const snapshot = twinWeaponSnapshot(deps, twin, module, charge);
    if (!snapshot) return skip("NO_SNAPSHOT", null);
    const durationMs = Number.isFinite(snapshot.durationMs) && snapshot.durationMs > 0 ? snapshot.durationMs : null;
    if (!vortonFamily(snapshot.family)) return skip("UNSUPPORTED_FAMILY", durationMs);
    if (turretShot.crystalOut(snapshot, charge)) return skip("NO_AMMO", durationMs);
    const optimal = Math.max(0, Number(snapshot.optimalRange) || 0);
    if (twinScene.surfaceDistance(scene, twin, target) > optimal) return skip("OUT_OF_RANGE", config.combatReacquireMs);
    const shot = deps.resolveVortonShot({ attackerEntity: twin, targetEntity: target, weaponSnapshot: snapshot });
    count("combat.volley.fired");
    const hit = Boolean(shot && shot.hit);
    count(hit ? "combat.volley.hit" : "combat.volley.miss");
    const host = opts && opts.host ? opts.host : null;
    const arcs = hit ? arcTargets(scene, twin, host, target, snapshot) : [];
    broadcastFx(scene, twin, module, charge, target, snapshot, family, arcs);
    let applied = 0;
    let destroyed = false;
    if (hit && deps.hasDamageableHealth(target)) {
      ({ applied, destroyed } = strike(scene, twin, module, charge, target, shot.shotDamage, snapshot, simMs));
      if (destroyed) count("combat.volley.kill");
    }
    for (const victim of arcs) arc(scene, twin, module, charge, victim, snapshot, simMs);
    return cycleOk(snapshot.durationMs, { hit, applied, destroyed, chargeItemId: toInt(charge && charge.itemID, 0),
      chargeMode: String(snapshot.chargeMode || "") });
  }

  return Object.freeze({
    id: "vorton",
    consumer: "combatVorton",
    configKey: "combatVortonEnabled",
    steers: true,
    needsLock: true,
    match: (_module, _charge, family) => vortonFamily(family),
    needsAmmo: (module, charge) => deps.isChargeOptionalTurretWeapon(module, charge) !== true,
    range,
    fire,
  });
}

module.exports = { createVortonHandler, VORTON_COUNTER_NAMES };
