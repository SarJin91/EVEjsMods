"use strict";

const VENDOR_RANGE_LY = 5;
const VENDOR_MAX_MASS_KG = 1480000000;
const OZONE_MIN = 50;
const OZONE_PER_KG_LY = 0.000003;
const RANGE_EPSILON_LY = 0.000001;
const MARKER_KEY = "lneTrigBridge";
const MARKER_VERSION = 1;
const REFUSAL_REASONS = Object.freeze(["RANGE", "COOLDOWN", "NO_POSITION"]);
const MS_PER_SECOND = 1000;

const isPositiveInt = (v) => Number.isSafeInteger(v) && v > 0;
const isFiniteNumber = (v) => typeof v === "number" && Number.isFinite(v);

function isTrigMarker(structureRow) {
  const flags = structureRow && typeof structureRow === "object" ? structureRow.devFlags : null;
  const m = flags && typeof flags === "object" ? flags[MARKER_KEY] : null;
  if (!m || typeof m !== "object" || Array.isArray(m)) return false;
  return m.v === MARKER_VERSION && isFiniteNumber(m.installedAt) && m.installedAt >= 0
    && isPositiveInt(m.installedBy) && isPositiveInt(m.coreTypeId);
}

function effectiveLy(realLy, fuelLyPermille, vendorRangeLy) {
  if (!isFiniteNumber(realLy) || realLy <= 0 || !isFiniteNumber(fuelLyPermille) || fuelLyPermille <= 0) return 0;
  const cap = isFiniteNumber(vendorRangeLy) && vendorRangeLy > 0 ? vendorRangeLy : VENDOR_RANGE_LY;
  return Math.min(realLy * fuelLyPermille / 1000, cap);
}

function scaledDestinationPosition(srcPos, dstPos, realLy, effLy) {
  const f = isFiniteNumber(realLy) && realLy > 0 && isFiniteNumber(effLy) && effLy >= 0 ? effLy / realLy : 1;
  return {
    x: srcPos.x + (dstPos.x - srcPos.x) * f,
    y: srcPos.y + (dstPos.y - srcPos.y) * f,
    z: srcPos.z + (dstPos.z - srcPos.z) * f,
  };
}

function effectiveMassKg(realMassKg) {
  if (!isFiniteNumber(realMassKg) || realMassKg <= 0) return 0;
  return Math.min(realMassKg, VENDOR_MAX_MASS_KG);
}

function estimateOzone(shipMassKg, ly) {
  const mass = isFiniteNumber(shipMassKg) ? Math.max(0, shipMassKg) : 0;
  const dist = isFiniteNumber(ly) ? Math.max(0, ly) : 0;
  return Math.max(OZONE_MIN, Math.ceil((mass * dist * OZONE_PER_KG_LY) + OZONE_MIN));
}

function decideJump(input) {
  const { realLy, lastJumpAt, now, cfg } = input || {};
  if (!cfg || typeof cfg !== "object") return { ok: false, reason: "NO_POSITION", detail: "no config" };
  if (!isFiniteNumber(realLy) || realLy <= 0) return { ok: false, reason: "NO_POSITION" };
  if (realLy > cfg.maxRangeLy + RANGE_EPSILON_LY) {
    return { ok: false, reason: "RANGE", detail: `${realLy.toFixed(2)} LY > ${cfg.maxRangeLy} LY` };
  }
  if (isFiniteNumber(lastJumpAt) && isFiniteNumber(now) && now - lastJumpAt < cfg.jumpCooldownMs) {
    return { ok: false, reason: "COOLDOWN", detail: String(Math.max(0, cfg.jumpCooldownMs - (now - lastJumpAt))) };
  }
  return { ok: true, effLy: effectiveLy(realLy, cfg.fuelLyPermille, VENDOR_RANGE_LY) };
}

function refusalMessage(reason, detail) {
  if (reason === "COOLDOWN") {
    const s = Math.max(1, Math.ceil(Number(detail) / MS_PER_SECOND) || 1);
    return `The Triglavian conduit is still recharging for you (${s} s).`;
  }
  return "That Triglavian bridge connection is beyond its maximum range.";
}

function validateConfig(raw) {
  if (!raw || typeof raw !== "object") return { ok: false, reason: "CONFIG_MISSING" };
  const cfg = Object.freeze({
    enabled: raw.enabled === true,
    maxRangeLy: raw.maxRangeLy,
    fuelLyPermille: raw.fuelLyPermille,
    jumpCooldownMs: raw.jumpCooldownMs,
    maxPairsPerAlliance: raw.maxPairsPerAlliance,
    coreTypeId: raw.coreTypeId,
    requireRole: raw.requireRole === true,
    statusMail: raw.statusMail === true,
    debugCommand: raw.debugCommand === true,
    presentationTypeId: raw.presentationTypeId,
    listMax: raw.listMax,
  });
  const warnings = [];
  const longest = cfg.maxRangeLy * cfg.fuelLyPermille / 1000;
  if (longest > VENDOR_RANGE_LY) {
    warnings.push(`W126 trigBridge.maxRangeLy x fuelLyPermille / 1000 = ${longest} LY > ${VENDOR_RANGE_LY} LY - the `
      + `effective distance is cut to ${VENDOR_RANGE_LY} LY (longer pairs pay as ${VENDOR_RANGE_LY} LY)`);
  }
  return { ok: true, cfg, warnings };
}

module.exports = { VENDOR_RANGE_LY, VENDOR_MAX_MASS_KG, MARKER_KEY, MARKER_VERSION, REFUSAL_REASONS, isTrigMarker,
  effectiveLy, scaledDestinationPosition, effectiveMassKg, estimateOzone, decideJump, refusalMessage, validateConfig };
