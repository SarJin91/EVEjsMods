"use strict";

const LIMITS = Object.freeze({ RESONANCE_MIN: 0.1, RESONANCE_MAX: 1, SLOT_MAX: 8, RIG_SLOT_MAX: 3 });

const ATTRIBUTE = Object.freeze({
  MASS: 4,
  LOW_SLOTS: 12,
  MED_SLOTS: 13,
  HI_SLOTS: 14,
  MAX_VELOCITY: 37,
  CAPACITY: 38,
  AGILITY: 70,
  LAUNCHER_SLOTS_LEFT: 101,
  TURRET_SLOTS_LEFT: 102,
  RADIUS: 162,
  SIGNATURE_RADIUS: 552,
  WARP_SPEED_MULTIPLIER: 600,
  RIG_SLOTS: 1137,
});

const SLOT_ATTRIBUTE_IDS = Object.freeze([ATTRIBUTE.HI_SLOTS, ATTRIBUTE.MED_SLOTS, ATTRIBUTE.LOW_SLOTS,
  ATTRIBUTE.TURRET_SLOTS_LEFT, ATTRIBUTE.LAUNCHER_SLOTS_LEFT]);

const POSITIVE_FIELDS = Object.freeze(["mass", "volume", "capacity", "radius"]);

function rangeProblem(value, min, max, integer) {
  if (integer && !Number.isInteger(value)) return "must be an integer";
  if (value < min || value > max) return `must be within ${min}-${max}`;
  return null;
}

function checkDogmaOverride(attributeID, value, sourceValue, attributeName = null) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "must be a finite number";
  const source = typeof sourceValue === "number" && Number.isFinite(sourceValue) ? sourceValue : null;
  if (source !== null) {
    if (source >= 0 && value < 0) return `must be >= 0 (source ${source})`;
    if (source < 0 && value > 0) return `must be <= 0 (source ${source})`;
  }
  const id = Number(attributeID);
  const widen = (min, max) => [source === null ? min : Math.min(min, source), source === null ? max : Math.max(max, source)];
  if (typeof attributeName === "string" && attributeName.endsWith("Resonance")) {
    const [min, max] = widen(LIMITS.RESONANCE_MIN, LIMITS.RESONANCE_MAX);
    return rangeProblem(value, min, max, false);
  }
  if (SLOT_ATTRIBUTE_IDS.includes(id)) {
    const [min, max] = widen(0, LIMITS.SLOT_MAX);
    return rangeProblem(value, min, max, true);
  }
  if (id === ATTRIBUTE.RIG_SLOTS) {
    const [min, max] = widen(0, LIMITS.RIG_SLOT_MAX);
    return rangeProblem(value, min, max, true);
  }
  return null;
}

function checkFieldOverride(field, value) {
  if (field === "basePrice") {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? null : "must be a finite number >= 0";
  }
  if (!POSITIVE_FIELDS.includes(field)) return "is not a numeric type field";
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? null : "must be a finite number > 0";
}

module.exports = {
  ATTRIBUTE,
  LIMITS,
  POSITIVE_FIELDS,
  SLOT_ATTRIBUTE_IDS,
  checkDogmaOverride,
  checkFieldOverride,
};
