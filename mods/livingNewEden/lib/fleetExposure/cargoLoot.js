"use strict";

const MINERAL_TYPE_MIN = 34;
const MINERAL_TYPE_MAX = 40;
const MINERAL_UNITS_PER_M3 = 100;
const PERMILLE = 1000;
const MINERAL_RE = /^mineral\/type:(\d+)$/;
const HULL_PREFIX = "hull/";

const isQty = (v) => Number.isSafeInteger(v) && v > 0;

function planCarrierLoot(cargo, carriersAtLoad, params) {
  const share = params && params.sharePermille;
  const maxM3 = params && params.maxM3PerCarrier;
  if (!Number.isSafeInteger(share) || share < 0 || share > PERMILLE || !Number.isSafeInteger(maxM3) || maxM3 < 1) {
    return { ok: false, reason: "INVALID_INPUT" };
  }
  if (!cargo || typeof cargo !== "object" || Array.isArray(cargo) || !isQty(carriersAtLoad)) {
    return { ok: false, reason: "NO_CARGO" };
  }
  let hullKeysSkipped = 0;
  const minerals = [];
  for (const key of Object.keys(cargo)) {
    if (key.startsWith(HULL_PREFIX)) {
      hullKeysSkipped += 1;
      continue;
    }
    const m = MINERAL_RE.exec(key);
    if (!m) continue;
    const typeId = Number(m[1]);
    if (typeId < MINERAL_TYPE_MIN || typeId > MINERAL_TYPE_MAX || !isQty(cargo[key])) continue;
    const perCarrier = BigInt(cargo[key]) / BigInt(carriersAtLoad);
    minerals.push({ typeId, loot: (perCarrier * BigInt(share)) / BigInt(PERMILLE) });
  }
  minerals.sort((a, b) => a.typeId - b.typeId);
  const sum = minerals.reduce((n, x) => n + x.loot, 0n);
  const cap = BigInt(maxM3) * BigInt(MINERAL_UNITS_PER_M3);
  const items = [];
  let units = 0;
  for (const x of minerals) {
    const q = Number(sum > cap ? (x.loot * cap) / sum : x.loot);
    if (q <= 0) continue;
    items.push({ typeId: x.typeId, quantity: q });
    units += q;
  }
  if (items.length === 0) return { ok: false, reason: "NO_MINERALS", hullKeysSkipped };
  return { ok: true, items, units, hullKeysSkipped };
}

module.exports = { planCarrierLoot, MINERAL_TYPE_MIN, MINERAL_TYPE_MAX, MINERAL_UNITS_PER_M3 };
