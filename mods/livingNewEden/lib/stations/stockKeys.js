"use strict";

const { HULL_GROUPS } = require("../fleets/schema");

const HULL_ITEM_KIND = "hull";
const groupKey = (hullGroup) => `group:${hullGroup}`;

function hullDeltas(composition, sign) {
  const bad = { ok: false, reason: "INVALID_COMPOSITION" };
  if (!Array.isArray(composition) || composition.length === 0 || (sign !== -1 && sign !== 1)) return bad;
  const sums = new Map();
  for (const e of composition) {
    if (!e || !HULL_GROUPS.includes(e.hullGroup) || !Number.isSafeInteger(e.count) || e.count < 1) return bad;
    sums.set(e.hullGroup, (sums.get(e.hullGroup) || 0) + e.count);
  }
  const deltas = [...sums.keys()].sort().map((g) => ({ itemKind: HULL_ITEM_KIND, itemKey: groupKey(g),
    delta: sign * sums.get(g) }));
  return { ok: true, deltas };
}

module.exports = { hullDeltas, groupKey, HULL_ITEM_KIND };
