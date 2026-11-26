"use strict";

const R = require("./rules");
const S = require("./schema");

const MINUTE_MS = 60000;
const MAX_TOP_LIMIT = 100;

function createMemoryIndex(deps) {
  const { P, clock } = deps;
  const secClassOf = typeof deps.secClassOf === "function" ? deps.secClassOf : () => null;
  const rows = new Map();
  let warm = false;
  let version = 0;
  let topCache = { key: null, results: new Map() };

  function loadPage(list) {
    let dropped = 0;
    for (const row of Array.isArray(list) ? list : []) {
      if (!rows.has(row.systemId) && rows.size >= P.maxTrackedSystems) {
        dropped += 1;
        continue;
      }
      rows.set(row.systemId, row);
    }
    version += 1;
    return dropped;
  }

  function markWarm() {
    warm = true;
    version += 1;
  }

  function put(row) {
    rows.set(row.systemId, row);
    version += 1;
  }

  function remove(systemId) {
    if (rows.delete(systemId)) version += 1;
  }

  const decayedOf = (row, now) => R.decayRow(row, now, P);

  function levelsOf(systemId) {
    if (!warm) return null;
    const now = clock.now();
    const raw = rows.get(systemId);
    const row = raw ? decayedOf(raw, now) : null;
    const pts = (k) => (row ? row[k] : 0);
    return Object.freeze({ mil: R.levelOf(pts("mil"), P), ind: R.levelOf(pts("ind"), P),
      trade: R.levelOf(pts("trade"), P), milPoints: pts("mil"), indPoints: pts("ind"), tradePoints: pts("trade"),
      trend: Object.freeze(R.trendOf(row, now, P)), controllerFactionId: row ? row.controllerFactionId : null });
  }

  function listTop(kind, opts) {
    if (!warm || !S.KINDS.includes(kind)) return Object.freeze([]);
    const o = opts || {};
    const minLevel = Number.isSafeInteger(o.minLevel) ? o.minLevel : 1;
    const limit = Math.min(MAX_TOP_LIMIT, Math.max(1, Number.isSafeInteger(o.limit) ? o.limit : 10));
    const secClasses = Array.isArray(o.secClasses) ? o.secClasses : null;
    const now = clock.now();
    const cacheKey = `${version}:${Math.floor(now / MINUTE_MS)}`;
    if (topCache.key !== cacheKey) topCache = { key: cacheKey, results: new Map() };
    const argKey = `${kind}:${minLevel}:${limit}:${secClasses ? secClasses.join(",") : "*"}`;
    const hit = topCache.results.get(argKey);
    if (hit) return hit;
    const out = [];
    for (const raw of rows.values()) {
      const row = decayedOf(raw, now);
      const level = R.levelOf(row[kind], P);
      if (level < minLevel || row[kind] <= 0) continue;
      if (secClasses && !secClasses.includes(secClassOf(row.systemId))) continue;
      out.push(Object.freeze({ systemId: row.systemId, level, points: row[kind] }));
    }
    out.sort((a, b) => b.points - a.points || a.systemId - b.systemId);
    const result = Object.freeze(out.slice(0, limit));
    topCache.results.set(argKey, result);
    return result;
  }

  function decayedRows(now) {
    return [...rows.values()].map((r) => decayedOf(r, now));
  }

  return Object.freeze({ loadPage, markWarm, isWarm: () => warm, put, remove, get: (id) => rows.get(id) || null,
    has: (id) => rows.has(id), levelsOf, listTop, decayedRows, size: () => rows.size, version: () => version });
}

module.exports = { createMemoryIndex };
