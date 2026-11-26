"use strict";

const { REPAIR_FAMILY_BY_TYPE, DEFAULT_FAMILY } = require("./data/faxRepair");

const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);
const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

const PERMILLE = 1000;
const MS_PER_SECOND = 1000;
const TIE_EPSILON = 0.000001;

function round6(value) {
  return Math.round(value * 1e6) / 1e6;
}

function finiteOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp01(value) {
  return Math.min(1, Math.max(0, value));
}

function familyOfType(typeId) {
  const key = String(Math.trunc(Number(typeId)));
  return hasOwn(REPAIR_FAMILY_BY_TYPE, key) ? REPAIR_FAMILY_BY_TYPE[key] : DEFAULT_FAMILY;
}

function rowRemoteRepOf(typeId, catalog) {
  if (!isObject(catalog)) return 0;
  const types = isObject(catalog.TYPES) ? catalog.TYPES : {};
  const rows = isObject(catalog.CAPITAL_STRENGTH_ROWS) ? catalog.CAPITAL_STRENGTH_ROWS : {};
  const key = String(typeId);
  const row = hasOwn(types, key) ? types[key] : (hasOwn(rows, "force_auxiliary") ? rows.force_auxiliary : null);
  const value = Number(row && row.remoteRepPerSec);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function repairAmountPerCycle(p) {
  if (!isObject(p)) return { ok: false, reason: "NO_ROW" };
  const cycleMs = Number(p.cycleMs);
  if (!Number.isFinite(cycleMs) || cycleMs <= 0) return { ok: false, reason: "BAD_CYCLE" };
  const rep = Number(p.remoteRepPerSec);
  const permille = Number(p.permille);
  if (!Number.isFinite(rep) || rep <= 0 || !Number.isFinite(permille) || permille <= 0) {
    return { ok: false, reason: "NO_ROW" };
  }
  return { ok: true, amount: round6((((rep * permille) / PERMILLE) * cycleMs) / MS_PER_SECOND) };
}

function needRatio(entity, family) {
  if (!isObject(entity) || entity.kind !== "ship") return 0;
  const condition = isObject(entity.conditionState) ? entity.conditionState : {};
  if (family === "remoteShield") return 1 - clamp01(finiteOr(condition.shieldCharge, 1));
  if (family === "remoteArmor") return clamp01(finiteOr(condition.armorDamage, 0));
  return 0;
}

function pickRepairTarget(candidates) {
  if (!Array.isArray(candidates)) return null;
  let best = null;
  for (const c of candidates) {
    if (!isObject(c)) continue;
    if (!best || c.need > best.need + TIE_EPSILON
      || (Math.abs(c.need - best.need) <= TIE_EPSILON
        && (c.distance < best.distance - TIE_EPSILON
          || (Math.abs(c.distance - best.distance) <= TIE_EPSILON && c.entityId < best.entityId)))) {
      best = c;
    }
  }
  return best;
}

function buildEffectState(p) {
  const amount = Math.max(0, finiteOr(p.amount, 0));
  return {
    moduleID: Math.trunc(finiteOr(p.faxId, 0)),
    targetID: Math.trunc(finiteOr(p.targetId, 0)),
    assistanceModuleEffect: true,
    assistanceFamily: p.family,
    assistanceJammingType: p.family,
    assistanceMaxRangeMeters: Math.max(0, finiteOr(p.rangeMeters, 0)),
    assistanceFalloffMeters: 0,
    assistanceShieldBonusAmount: p.family === "remoteShield" ? amount : 0,
    assistanceArmorRepairAmount: p.family === "remoteArmor" ? amount : 0,
    assistanceHullRepairAmount: 0,
  };
}

module.exports = {
  familyOfType,
  rowRemoteRepOf,
  repairAmountPerCycle,
  needRatio,
  pickRepairTarget,
  buildEffectState,
};
