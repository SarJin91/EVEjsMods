"use strict";

const TERRITORY_CLASSES = Object.freeze(["highsec", "lowsec", "nullsec"]);

const isId = (v) => Number.isSafeInteger(v) && v > 0;

function buildTerritory(p) {
  if (!p || !Array.isArray(p.systems) || !(p.factionOfSystem instanceof Map) || !Array.isArray(p.usableFactionIds)
    || !(p.excludedRegionIds instanceof Set)) {
    return { ok: false, reason: "INVALID_INPUT" };
  }
  const usable = [...new Set(p.usableFactionIds.filter(isId))];
  if (usable.length === 0) return { ok: false, reason: "NO_FACTIONS" };
  const lists = new Map(usable.map((f) => [f, { highsec: [], lowsec: [], nullsec: [] }]));
  const factionOf = new Map();
  for (const s of p.systems) {
    if (!s || !isId(s.systemId) || !TERRITORY_CLASSES.includes(s.secClass) || !Number.isSafeInteger(s.regionId)
      || s.regionId < 0 || p.excludedRegionIds.has(s.regionId) || factionOf.has(s.systemId) || s.gated !== true) {
      continue;
    }
    const vendor = p.factionOfSystem.get(s.systemId);
    const factionId = lists.has(vendor) ? vendor : usable[s.regionId % usable.length];
    factionOf.set(s.systemId, factionId);
    lists.get(factionId)[s.secClass].push(s.systemId);
  }
  if (factionOf.size === 0) return { ok: false, reason: "NO_FACTIONS" };
  for (const l of lists.values()) {
    for (const c of TERRITORY_CLASSES) l[c].sort((a, b) => a - b);
  }
  return { ok: true, factionOf, lists };
}

function territorySizes(lists) {
  const out = new Map();
  for (const [f, l] of lists || []) out.set(f, l.lowsec.length + l.nullsec.length);
  return out;
}

function allocateGangFactions(sizes, factionIds, maxGangs) {
  const out = [];
  if (!(sizes instanceof Map) || !Array.isArray(factionIds) || !Number.isSafeInteger(maxGangs)) return out;
  const given = new Map();
  for (let g = 0; g < maxGangs; g += 1) {
    let best = null;
    let bestSize = 0;
    let bestGiven = 0;
    for (const f of factionIds) {
      const size = sizes.get(f);
      if (!Number.isSafeInteger(size) || size <= 0) continue;
      const n = given.get(f) || 0;
      if (best === null || size * (bestGiven + 1) > bestSize * (n + 1)) {
        best = f;
        bestSize = size;
        bestGiven = n;
      }
    }
    if (best === null) break;
    given.set(best, bestGiven + 1);
    out.push(best);
  }
  return out;
}

function levelOrder(level, maxLevel) {
  const out = [];
  if (!Number.isSafeInteger(level) || !Number.isSafeInteger(maxLevel) || level < 1 || level > maxLevel) return out;
  out.push(level);
  for (let d = 1; d < maxLevel; d += 1) {
    if (level - d >= 1) out.push(level - d);
    if (level + d <= maxLevel) out.push(level + d);
  }
  return out;
}

module.exports = { buildTerritory, territorySizes, allocateGangFactions, levelOrder, TERRITORY_CLASSES };
