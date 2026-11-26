"use strict";

const S = require("./schema");

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const isCount = (v) => Number.isSafeInteger(v) && v >= 0;
const isVolume = (v) => typeof v === "number" && Number.isFinite(v) && v >= 0;

function planMetenoxLoss(input) {
  const p = input || {};
  if (!isCount(p.lossPermille) || p.lossPermille > S.MAX_LOSS_PERMILLE) {
    return { ok: false, reason: "CONFIG_INVALID", detail: "lossPermille" };
  }
  if (!isId(p.maxLossVolumeM3)) return { ok: false, reason: "CONFIG_INVALID", detail: "maxLossVolumeM3" };
  if (!isId(p.maxPlanLines)) return { ok: false, reason: "CONFIG_INVALID", detail: "maxPlanLines" };
  if (!isId(p.ownerCorpId)) return { ok: false, reason: "INVALID_INPUT", detail: "ownerCorpId" };
  if (!Array.isArray(p.lines)) return { ok: false, reason: "INVALID_INPUT", detail: "lines" };
  const eligible = p.lines.filter((l) => l && isId(l.itemId) && isId(l.typeId) && isCount(l.units)
    && isVolume(l.unitVolume) && l.flagId === S.MOON_MATERIAL_BAY_FLAG && l.groupId === S.MOON_MATERIAL_GROUP
    && l.ownerId === p.ownerCorpId);
  const seen = new Set();
  const lines = [];
  for (const l of [...eligible].sort((a, b) => a.itemId - b.itemId)) {
    if (seen.has(l.itemId)) continue;
    seen.add(l.itemId);
    const units = Math.floor((l.units * p.lossPermille) / S.PERMILLE);
    if (units > 0) lines.push({ itemId: l.itemId, typeId: l.typeId, units, unitVolume: l.unitVolume });
  }
  const kept = lines.slice(0, p.maxPlanLines);
  const volumeOf = (list) => list.reduce((sum, l) => sum + l.units * l.unitVolume, 0);
  const total = volumeOf(kept);
  if (total > p.maxLossVolumeM3) {
    const factor = p.maxLossVolumeM3 / total;
    for (const l of kept) l.units = Math.floor(l.units * factor);
    while (volumeOf(kept) > p.maxLossVolumeM3) {
      const big = kept.filter((l) => l.units > 0).sort((a, b) => b.units * b.unitVolume - a.units * a.unitVolume
        || a.itemId - b.itemId)[0];
      if (!big) break;
      big.units -= 1;
    }
  }
  const plan = kept.filter((l) => l.units > 0);
  return { ok: true, plan: plan.map((l) => Object.freeze({ itemId: l.itemId, typeId: l.typeId, units: l.units })),
    volumeM3: volumeOf(plan), eligibleLines: seen.size };
}

function planSkyhookLoss(input) {
  const p = input || {};
  if (!isCount(p.lossPermille) || p.lossPermille > S.MAX_LOSS_PERMILLE) {
    return { ok: false, reason: "CONFIG_INVALID", detail: "lossPermille" };
  }
  if (!isId(p.maxPlanLines)) return { ok: false, reason: "CONFIG_INVALID", detail: "maxPlanLines" };
  if (!Array.isArray(p.unsecured)) return { ok: false, reason: "INVALID_INPUT", detail: "unsecured" };
  const seen = new Set();
  const plan = [];
  const sorted = p.unsecured.filter((l) => l && isId(l.typeId) && isCount(l.units) && isVolume(l.unitVolume))
    .sort((a, b) => a.typeId - b.typeId);
  for (const l of sorted) {
    if (seen.has(l.typeId)) continue;
    seen.add(l.typeId);
    const units = Math.floor((l.units * p.lossPermille) / S.PERMILLE);
    if (units > 0 && plan.length < p.maxPlanLines) {
      plan.push(Object.freeze({ typeId: l.typeId, units, unitVolume: l.unitVolume }));
    }
  }
  return { ok: true, plan, units: plan.reduce((n, l) => n + l.units, 0),
    volumeM3: plan.reduce((sum, l) => sum + l.units * l.unitVolume, 0) };
}

module.exports = { planMetenoxLoss, planSkyhookLoss };
