"use strict";

function idOf(value) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
}

function callOr(graph, name, arg, fallback) {
  if (typeof graph[name] !== "function") return fallback;
  try {
    const out = graph[name](arg);
    return out === undefined ? fallback : out;
  } catch (_err) {
    return fallback;
  }
}

function modeOf(graph, systemIds, usable) {
  const counts = new Map();
  for (const raw of Array.isArray(systemIds) ? systemIds : []) {
    const vertex = callOr(graph, "getSystem", raw, null);
    const factionId = idOf(vertex && vertex.factionId);
    if (!usable(factionId)) continue;
    counts.set(factionId, (counts.get(factionId) || 0) + 1);
  }
  let best = 0;
  let bestCount = 0;
  for (const [factionId, count] of counts) {
    if (count > bestCount || (count === bestCount && factionId < best)) {
      best = factionId;
      bestCount = count;
    }
  }
  return best;
}

function resolveEmpireFaction(graph, systemId, excludedIds) {
  const g = graph && typeof graph === "object" ? graph : {};
  const excluded = new Set((Array.isArray(excludedIds) ? excludedIds : []).map(Number));
  const usable = (factionId) => factionId > 0 && !excluded.has(factionId);
  const vertex = callOr(g, "getSystem", systemId, null);
  if (!vertex || typeof vertex !== "object") return { ok: false, reason: "NO_SYSTEM" };
  const own = idOf(vertex.factionId);
  if (usable(own)) return { ok: true, factionId: own, source: "system" };
  const constellationId = idOf(vertex.constellationId);
  if (constellationId > 0) {
    const fromConstellation = modeOf(g, callOr(g, "getSystemsInConstellation", constellationId, []), usable);
    if (fromConstellation > 0) return { ok: true, factionId: fromConstellation, source: "constellation" };
  }
  const regionId = idOf(vertex.regionId);
  if (regionId > 0) {
    const fromRegion = modeOf(g, callOr(g, "getSystemsInRegion", regionId, []), usable);
    if (fromRegion > 0) return { ok: true, factionId: fromRegion, source: "region" };
  }
  return { ok: false, reason: "NO_FACTION" };
}

module.exports = { resolveEmpireFaction };
