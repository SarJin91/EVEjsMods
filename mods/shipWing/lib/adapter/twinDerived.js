// port of shipDerivedState.js:326-451 without a session: 1.

"use strict";

const PRIME_FIELDS = Object.freeze(["inertia", "mass", "maxVelocity"]);
const HP_RATIO_EPSILON = 1e-9;

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function isObj(value) {
  return value !== null && typeof value === "object";
}

function primeOf(source) {
  const out = {};
  for (const field of PRIME_FIELDS) out[field] = num(source && source[field]);
  return out;
}

function hpOf(twin) {
  const cs = isObj(twin && twin.conditionState) ? twin.conditionState : {};
  return { shieldCharge: num(cs.shieldCharge), armorDamage: num(cs.armorDamage) };
}

function applyDerived(scene, twin, passiveState, propState, deps) {
  try {
    if (!scene || !isObj(twin) || !isObj(passiveState) || !isObj(deps)) return { ok: false, reason: "ERROR" };
    const before = primeOf(twin);
    const hpBefore = hpOf(twin);
    const derived = scene.movementChangesWait(twin) ? Object.create(twin) : twin;
    deps.applyPassiveResourceStateToEntity(derived, passiveState, { recalculateSpeedFraction: false });
    if (propState) deps.applyPropulsionEffectStateToEntity(derived, propState);
    const motion = scene.captureShipMotion(derived);
    if (derived !== twin) scene.adoptDerivedShipState(twin, derived);
    const hpAfter = hpOf(twin);
    const hpChanged = Math.abs(hpAfter.shieldCharge - hpBefore.shieldCharge) > HP_RATIO_EPSILON
      || Math.abs(hpAfter.armorDamage - hpBefore.armorDamage) > HP_RATIO_EPSILON;
    if (hpChanged && typeof deps.broadcastDamageStateChange === "function") {
      deps.broadcastDamageStateChange(scene, twin);
    }
    const queued = derived !== twin && scene.queueShipMotionChange(twin, motion,
      (motionBefore) => scene.broadcastShipPrimeUpdates(twin, { previousState: primeOf(motionBefore) }));
    if (!queued) {
      if (derived === twin) scene.dropPendingShipMotion(twin);
      scene.broadcastShipPrimeUpdates(twin, { previousState: before });
    }
    return { ok: true, hpChanged };
  } catch (_err) {
    return { ok: false, reason: "ERROR" };
  }
}

module.exports = { PRIME_FIELDS, HP_RATIO_EPSILON, applyDerived };
