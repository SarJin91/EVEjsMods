"use strict";

const MINERAL_MIN = 34;
const MINERAL_MAX = 40;
const EPSILON = 1e-9;

const byNum = (a, b) => a - b;
const isId = (v) => Number.isSafeInteger(v) && v > 0;

function rounded(map) {
  const out = {};
  for (const id of [...map.keys()].sort(byNum)) {
    const n = Math.ceil(map.get(id) - EPSILON);
    if (n >= 1) out[`type:${id}`] = n;
  }
  return out;
}

function buildAdvancedBills(inputs) {
  const { blueprints, reactions, moonMaterialTier, piTier, fuelBlocks, maxDepth } = inputs;
  const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, String(k));
  const skipped = new Set();
  const usedReactions = new Map();
  const bills = {};
  for (const [group, repId] of [...inputs.representatives].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
    const bp = isId(repId) ? blueprints.get(repId) : null;
    if (!bp || !Array.isArray(bp.materials)) {
      return { ok: false, reason: "ADVANCED_NO_REPRESENTATIVE", detail: `${group}:${repId}` };
    }
    const moon = new Map();
    const pi = new Map();
    const add = (map, id, v) => map.set(id, (map.get(id) || 0) + v);
    const expand = (typeId, qty, depth, path) => {
      if (hasOwn(moonMaterialTier, typeId)) return add(moon, typeId, qty);
      if (hasOwn(piTier, typeId) && piTier[String(typeId)] >= 1) return add(pi, typeId, qty);
      if (hasOwn(fuelBlocks, typeId)) {
        const block = fuelBlocks[String(typeId)];
        for (const p of Object.keys(block.pi).map(Number).sort(byNum)) {
          add(pi, p, (qty * block.pi[String(p)]) / block.batch);
        }
        return undefined;
      }
      if (typeId >= MINERAL_MIN && typeId <= MINERAL_MAX) return undefined;
      if (depth > maxDepth || path.has(typeId)) {
        skipped.add(typeId);
        return undefined;
      }
      let source = blueprints.get(typeId);
      if (!source) {
        source = reactions.get(typeId);
        if (source) usedReactions.set(typeId, source);
      }
      if (!source || !isId(source.productQuantity) || !Array.isArray(source.materials)) {
        skipped.add(typeId);
        return undefined;
      }
      const runs = qty / source.productQuantity;
      const next = new Set(path);
      next.add(typeId);
      for (const m of [...source.materials].sort((a, b) => a.typeId - b.typeId)) {
        if (isId(m.typeId) && m.quantity > 0) expand(m.typeId, m.quantity * runs, depth + 1, next);
      }
      return undefined;
    };
    const start = new Set([repId]);
    for (const m of [...bp.materials].sort((a, b) => a.typeId - b.typeId)) {
      if (isId(m.typeId) && m.quantity > 0) expand(m.typeId, m.quantity, 1, start);
    }
    bills[group] = { moon: rounded(moon), pi: rounded(pi) };
  }
  const used = [...usedReactions.entries()].sort((a, b) => a[0] - b[0]).map(([id, r]) => [id, r.blueprintTypeId,
    r.productQuantity, [...r.materials].sort((a, b) => a.typeId - b.typeId).map((m) => [m.typeId, m.quantity])]);
  return { ok: true, bills, skipped: [...skipped].sort(byNum), usedReactions: used };
}

module.exports = { buildAdvancedBills, MINERAL_MIN, MINERAL_MAX };
