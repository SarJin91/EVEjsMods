"use strict";

const { surfaceDistance: vecSurfaceDistance } = require("../util/vec");

const APPROACH_OPTIONS = Object.freeze({ queueHistorySafeContract: true, suppressFreshAcquireReplay: true });
const ORBIT_REACQUIRE_MIN_M = 5000;
const ORBIT_REACQUIRE_RATIO = 0.5;
const ORBIT_SETTLE_MIN_M = 1000;
const ORBIT_SETTLE_RATIO = 0.2;
const FOLLOW_RANGE_MATCH_M = 1;

function toInt(value, fallback = 0) {
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) ? n : fallback;
}

function toNum(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function pseudoSession(twin) {
  return {
    characterID: 0,
    corporationID: toInt(twin && twin.corporationID, 0),
    allianceID: toInt(twin && twin.allianceID, 0),
    _space: { systemID: toInt(twin && twin.systemID, 0), shipID: toInt(twin && twin.itemID, 0) },
  };
}

function createTwinScene() {
  function simNow(scene) {
    return scene && typeof scene.getCurrentSimTimeMs === "function" ? toNum(scene.getCurrentSimTimeMs(), Date.now())
      : Date.now();
  }

  function entity(scene, id) {
    return (scene && toInt(id, 0) > 0 && scene.getEntityByID(toInt(id, 0))) || null;
  }

  function surfaceDistance(scene, a, b) {
    if (!a || !b) return Infinity;
    if (scene && typeof scene.getEntitySurfaceDistance === "function") {
      const d = Number(scene.getEntitySurfaceDistance(a, b));
      return Number.isFinite(d) ? Math.max(0, d) : Infinity;
    }
    return vecSurfaceDistance(a.position, a.radius, b.position, b.radius);
  }

  function targetsOf(scene, ent) {
    if (!scene || !ent || typeof scene.getTargetsForEntity !== "function") return [];
    const out = scene.getTargetsForEntity(ent);
    return Array.isArray(out) ? out.map((id) => toInt(id, 0)).filter((id) => id > 0) : [];
  }

  function freeLocks(scene, twin, keep) {
    let freed = 0;
    for (const id of targetsOf(scene, twin)) {
      if (keep.has(id)) continue;
      if (scene.removeLockedTarget(twin, id, { notifySelf: false, notifyTarget: false, reason: null })) freed += 1;
    }
    for (const pending of scene.getSortedPendingTargetLocks(twin) || []) {
      const id = toInt(pending && pending.targetID, 0);
      if (id <= 0 || keep.has(id)) continue;
      if (scene.cancelPendingTargetLock(twin, id, { notifySelf: false })) freed += 1;
    }
    return freed;
  }

  function lock(scene, twin, target, opts = {}) {
    if (!scene || !twin || !target) return { ok: false, reason: "TARGET_NOT_FOUND" };
    const targetId = toInt(target.itemID, 0);
    const keep = new Set([targetId, ...(Array.isArray(opts.keepIds) ? opts.keepIds.map((id) => toInt(id, 0)) : [])]);
    freeLocks(scene, twin, keep);
    if (targetsOf(scene, twin).includes(targetId)) return { ok: true };
    const nowMs = simNow(scene);
    let result = scene.finalizeTargetLock(twin, target, { nowMs });
    if (result && result.success !== true && result.errorMsg === "TARGET_LOCK_LIMIT_REACHED") {
      freeLocks(scene, twin, new Set([targetId]));
      result = scene.finalizeTargetLock(twin, target, { nowMs });
    }
    if (result && result.success === true) return { ok: true };
    return { ok: false, reason: String((result && result.errorMsg) || "TARGET_LOCK_FAILED") };
  }

  function approach(scene, twin, targetId, distanceM) {
    const target = entity(scene, targetId);
    if (!target || !twin) return false;
    const orbit = Math.max(0, toNum(distanceM, 0));
    const surface = surfaceDistance(scene, twin, target);
    const sameTarget = toInt(twin.targetEntityID, 0) === toInt(target.itemID, 0);
    const inBand = twin.mode === "FOLLOW" && sameTarget
      && Math.abs(toNum(twin.followRange, 0) - orbit) <= FOLLOW_RANGE_MATCH_M;
    const reacquire = orbit + Math.max(ORBIT_REACQUIRE_MIN_M, orbit * ORBIT_REACQUIRE_RATIO);
    const settle = orbit + Math.max(ORBIT_SETTLE_MIN_M, orbit * ORBIT_SETTLE_RATIO);
    const follow = surface > reacquire || (inBand && surface > settle);
    const out = follow
      ? scene.followShipEntity(twin, target.itemID, orbit, APPROACH_OPTIONS)
      : scene.orbitShipEntity(twin, target.itemID, orbit, APPROACH_OPTIONS);
    return out === true;
  }

  function orbit(scene, twin, targetId, distanceM) {
    const target = entity(scene, targetId);
    if (!target || !twin) return false;
    return scene.orbitShipEntity(twin, target.itemID, Math.max(0, toNum(distanceM, 0)), APPROACH_OPTIONS) === true;
  }

  function followHost(scene, twin, hostId, rangeM) {
    if (!scene || !twin) return false;
    return scene.followShipEntity(twin, toInt(hostId, 0), Math.max(0, toNum(rangeM, 0))) === true;
  }

  function stop(scene, twin) {
    if (!scene || !twin) return false;
    return Boolean(scene.stopShipEntity(twin));
  }

  function activate(scene, twin, moduleItem, effectName, targetId) {
    if (!scene || !twin || !moduleItem) return { ok: false, reason: "SHIP_NOT_FOUND" };
    const result = scene.activateGenericModule(pseudoSession(twin), moduleItem, effectName,
      { targetID: toInt(targetId, 0) });
    if (result && result.success === true) return { ok: true };
    return { ok: false, reason: String((result && result.errorMsg) || "OTHER") };
  }

  function deactivate(scene, twin, moduleId, reason) {
    if (!scene || !twin) return false;
    const result = scene.deactivateGenericModule(pseudoSession(twin), toInt(moduleId, 0),
      { reason: String(reason || "manual") });
    return Boolean(result && result.success === true);
  }

  function activeEffect(twin, moduleId) {
    const effects = twin && twin.activeModuleEffects;
    if (!(effects instanceof Map)) return null;
    const state = effects.get(toInt(moduleId, 0));
    return state ? { targetID: toInt(state.targetID, 0) } : null;
  }

  function lockRange(scene, twin) {
    if (!scene || !twin || typeof scene.getEntityTargetingStats !== "function") return 0;
    const stats = scene.getEntityTargetingStats(twin);
    return Math.max(0, toNum(stats && stats.maxTargetRange, 0));
  }

  return Object.freeze({
    simNow, entity, surfaceDistance, lock, approach, orbit, followHost, stop, activate, deactivate, activeEffect,
    targetsOf, lockRange,
  });
}

module.exports = { createTwinScene, pseudoSession };
