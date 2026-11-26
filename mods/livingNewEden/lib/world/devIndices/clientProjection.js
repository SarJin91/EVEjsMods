"use strict";

const S = require("./schema");

function scalePoints(points, P, K) {
  const p = Number.isFinite(points) && points > 0 ? points : 0;
  const scaled = Math.floor((p * K.levelWidth) / P.levelWidth);
  return Math.min(Math.max(0, scaled), S.CLIENT_MAX_LEVEL_WIDTHS * K.levelWidth - 1);
}

function projectSystem(levels, vendorIndices, P, K) {
  if (!levels || (!(levels.milPoints > 0) && !(levels.indPoints > 0))) return null;
  const trend = levels.trend || {};
  const out = { ...(vendorIndices && typeof vendorIndices === "object" ? vendorIndices : {}) };
  out[K.militaryAttr] = { points: scalePoints(levels.milPoints, P, K), increasing: trend.mil > 0 };
  out[K.industrialAttr] = { points: scalePoints(levels.indPoints, P, K), increasing: trend.ind > 0 };
  return out;
}

function rankRows(decayedRows) {
  const out = [];
  for (const row of decayedRows || []) {
    const mil = Number.isFinite(row && row.mil) && row.mil > 0 ? row.mil : 0;
    const ind = Number.isFinite(row && row.ind) && row.ind > 0 ? row.ind : 0;
    if (mil + ind > 0) out.push(Object.freeze({ systemId: row.systemId, milPoints: mil, indPoints: ind }));
  }
  out.sort((a, b) => (b.milPoints + b.indPoints) - (a.milPoints + a.indPoints) || a.systemId - b.systemId);
  return Object.freeze(out);
}

function mergeAll(vendorRecords, claimed, ranked, P, K) {
  if (!(P.clientMaxSystems > 0) || !ranked || ranked.length === 0) return null;
  const chosen = new Map();
  for (const r of ranked) {
    if (chosen.size >= P.clientMaxSystems) break;
    if (!claimed || !claimed.has(r.systemId)) chosen.set(r.systemId, r);
  }
  const out = [];
  const seen = new Set();
  for (const rec of Array.isArray(vendorRecords) ? vendorRecords : []) {
    const id = Number(rec && rec.solarSystemID);
    const lne = chosen.get(id);
    if (lne) {
      seen.add(id);
      out.push({ ...rec, militaryPoints: scalePoints(lne.milPoints, P, K),
        industrialPoints: scalePoints(lne.indPoints, P, K) });
    } else {
      out.push(rec);
    }
  }
  for (const [id, lne] of chosen) {
    if (seen.has(id)) continue;
    out.push({ solarSystemID: id, militaryPoints: scalePoints(lne.milPoints, P, K),
      industrialPoints: scalePoints(lne.indPoints, P, K), claimedFor: 0 });
  }
  out.sort((a, b) => Number(a.solarSystemID) - Number(b.solarSystemID));
  return out;
}

module.exports = { scalePoints, projectSystem, rankRows, mergeAll };
