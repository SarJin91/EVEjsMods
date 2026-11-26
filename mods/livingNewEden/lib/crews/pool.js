"use strict";

function positiveInt(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function buildCrewPool(candidates, maxPoolCharacters, version) {
  const byCorp = new Map();
  const byFaction = new Map();
  const info = new Map();
  const list = Array.isArray(candidates) ? candidates.slice(0, Math.max(0, maxPoolCharacters | 0)) : [];
  for (const c of list) {
    if (!c || !positiveInt(c.characterId) || info.has(c.characterId)) continue;
    const corporationId = positiveInt(c.corporationId) ? c.corporationId : null;
    const allianceId = positiveInt(c.allianceId) ? c.allianceId : null;
    info.set(c.characterId, Object.freeze({ name: typeof c.name === "string" && c.name ? c.name : null,
      corporationId, allianceId, ownerKind: String(c.ownerKind), ownerId: Number(c.ownerId) }));
    if (corporationId !== null) {
      if (!byCorp.has(corporationId)) byCorp.set(corporationId, []);
      byCorp.get(corporationId).push(c.characterId);
    }
    if (c.ownerKind === "faction" && positiveInt(c.ownerId)) {
      if (!byFaction.has(c.ownerId)) byFaction.set(c.ownerId, []);
      byFaction.get(c.ownerId).push(c.characterId);
    }
  }
  for (const map of [byCorp, byFaction]) {
    for (const [key, ids] of map) map.set(key, Object.freeze(ids.sort((a, b) => a - b)));
  }
  const v = Number.isSafeInteger(version) && version > 0 ? version : 0;
  return { version: v, ready: v > 0, byCorp, byFaction, info };
}

function emptyCrewPool() {
  return buildCrewPool([], 0, 0);
}

module.exports = { buildCrewPool, emptyCrewPool };
