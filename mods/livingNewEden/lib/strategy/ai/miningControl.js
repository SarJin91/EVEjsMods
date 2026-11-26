"use strict";

const isId = (v) => Number.isSafeInteger(v) && v > 0;

function ownSpaceAccepts(factionId, vertex, ownSpace, allies) {
  if (!vertex || !ownSpace || !Array.isArray(ownSpace.secClasses) || ownSpace.secClasses.length === 0) return false;
  if (!ownSpace.secClasses.includes(vertex.secClass)) return false;
  const sovereignty = ownSpace.sovereignty || "self";
  if (sovereignty === "any") return true;
  if (vertex.factionId === factionId) return true;
  if (sovereignty === "friendly") return Array.isArray(allies) && isId(vertex.factionId) && allies.includes(vertex.factionId);
  return false;
}

function canMineIn(factionId, row, vertex, ownSpace, allies, opts) {
  if (!isId(factionId)) return false;
  if (row) {
    const occ = row.occupierFactionId;
    if (!(occ === null || occ === undefined || occ === factionId)) return false;
    if (row.controllerFactionId === factionId) return true;
    return Boolean(opts) && opts.ownStationHere === true;
  }
  if (!vertex) return false;
  if (vertex.factionId === factionId) return true;
  return ownSpaceAccepts(factionId, vertex, ownSpace || null, allies || null);
}

function stationExemptionOf(spec) {
  if (!spec || spec.ownStationHere !== true) return false;
  const c = spec.controllerFactionId;
  if (c === null || c === undefined || c === spec.factionId) return true;
  const min = Number.isFinite(spec.minInfluence) ? spec.minInfluence : 0;
  if (!(min > 0)) return true;
  const own = Number.isFinite(spec.ownInfluence) ? spec.ownInfluence : 0;
  return own >= min;
}

module.exports = { canMineIn, ownSpaceAccepts, stationExemptionOf };
