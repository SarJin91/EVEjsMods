"use strict";

const { ownSpaceBelt } = require("./ai/border");

const off = (reason) => Object.freeze({ ok: true, mode: "off", reason });
const MAX_DETAIL = 120;

function createBorderIndex(deps) {
  const registry = deps.registry;
  const settings = deps.settings || {};
  const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : { log() {} };
  const cache = new WeakMap();
  const lineCache = new WeakMap();
  const homeCache = new WeakMap();
  const logged = new Set();

  function log(line) {
    try {
      logger.log(line);
    } catch (_err) {
    }
  }

  function compute(graph, f, entry, doctrine) {
    const key = doctrine.borderReachKey;
    const depth = key === null || key === undefined ? undefined : (settings.reach || {})[key];
    if (!Number.isSafeInteger(depth)) return off("BORDER_KEY_UNKNOWN");
    const jumps = Math.max(0, Math.min(depth, settings.routeMaxJumps));
    const r = ownSpaceBelt({ factionId: f, ownSpace: doctrine.ownSpace, homeRegionIds: entry.homeRegionIds,
      systemsOfClass: (c) => graph.getSystemsBySecClass(c), getSystem: (id) => graph.getSystem(id),
      neighbors: (id) => graph.getNeighbors(id), maxJumps: jumps, maxSystems: settings.maxBfsSystems,
      isFriendly: (o) => typeof deps.hostility === "function" && deps.hostility(f, o) === false });
    if (r.mode !== "ready") return off(r.reason);
    return Object.freeze({ ok: true, mode: "ready", reach: r.reach, captures: doctrine.borderCaptures === true, jumps,
      sources: r.sources });
  }

  function beltOf(factionId) {
    try {
      if (settings.enabled !== true) return off("DISABLED");
      const f = Number(factionId);
      const entry = registry && typeof registry.getFaction === "function" ? registry.getFaction(f) : null;
      if (!entry) return off("NOT_IN_REGISTRY");
      if (typeof registry.isActive === "function" && !registry.isActive(f)) return off("INACTIVE");
      const doctrine = registry.getDoctrine(entry.doctrineId);
      if (!doctrine) return off("NO_DOCTRINE");
      if (!doctrine.ownSpace) return off("NO_OWN_SPACE");
      const graph = typeof deps.getGraph === "function" ? deps.getGraph() : null;
      if (!graph) return Object.freeze({ ok: false, reason: "GRAPH_NOT_READY" });
      let byFaction = cache.get(graph);
      if (!byFaction) {
        byFaction = new Map();
        cache.set(graph, byFaction);
      }
      if (byFaction.has(f)) return byFaction.get(f);
      const belt = compute(graph, f, entry, doctrine);
      byFaction.set(f, belt);
      if (belt.mode === "ready" && !logged.has(f)) {
        logged.add(f);
        log(`strategy: ${f} border belt=${belt.reach.size} sources=${belt.sources} jumps=${belt.jumps} `
          + `captures=${belt.captures}`);
      }
      return belt;
    } catch (err) {
      return Object.freeze({ ok: false, reason: "BORDER_FAILED",
        detail: String((err && err.message) || err).slice(0, MAX_DETAIL) });
    }
  }

  function lineOf(factionId) {
    try {
      const f = Number(factionId);
      const entry = registry && typeof registry.getFaction === "function" ? registry.getFaction(f) : null;
      if (!entry) return off("NOT_IN_REGISTRY");
      if (typeof registry.isActive === "function" && !registry.isActive(f)) return off("INACTIVE");
      const doctrine = registry.getDoctrine(entry.doctrineId);
      if (!doctrine) return off("NO_DOCTRINE");
      if (!doctrine.ownSpace) return off("NO_OWN_SPACE");
      const graph = typeof deps.getGraph === "function" ? deps.getGraph() : null;
      if (!graph) return Object.freeze({ ok: false, reason: "GRAPH_NOT_READY" });
      let byFaction = lineCache.get(graph);
      if (!byFaction) {
        byFaction = new Map();
        lineCache.set(graph, byFaction);
      }
      if (byFaction.has(f)) return byFaction.get(f);
      const r = ownSpaceBelt({ factionId: f, ownSpace: doctrine.ownSpace, homeRegionIds: entry.homeRegionIds,
        systemsOfClass: (c) => graph.getSystemsBySecClass(c), getSystem: (id) => graph.getSystem(id),
        neighbors: (id) => graph.getNeighbors(id), maxJumps: 0, maxSystems: settings.maxBfsSystems,
        isFriendly: (o) => typeof deps.hostility === "function" && deps.hostility(f, o) === false });
      const line = r.mode === "ready" ? Object.freeze({ ok: true, mode: "ready", line: r.line }) : off(r.reason);
      byFaction.set(f, line);
      return line;
    } catch (err) {
      return Object.freeze({ ok: false, reason: "BORDER_FAILED",
        detail: String((err && err.message) || err).slice(0, MAX_DETAIL) });
    }
  }

  function homeSpaceCountOf(factionId) {
    try {
      const f = Number(factionId);
      const entry = registry && typeof registry.getFaction === "function" ? registry.getFaction(f) : null;
      const doctrine = entry ? registry.getDoctrine(entry.doctrineId) : null;
      const space = doctrine ? doctrine.ownSpace : null;
      if (!space || !Array.isArray(space.secClasses) || space.secClasses.length === 0) {
        return Object.freeze({ ok: true, count: 0 });
      }
      const graph = typeof deps.getGraph === "function" ? deps.getGraph() : null;
      if (!graph) return Object.freeze({ ok: false, reason: "GRAPH_NOT_READY" });
      let byFaction = homeCache.get(graph);
      if (!byFaction) {
        byFaction = new Map();
        homeCache.set(graph, byFaction);
      }
      if (byFaction.has(f)) return byFaction.get(f);
      const own = new Set();
      for (const c of new Set(space.secClasses)) {
        for (const id of graph.getSystemsBySecClass(c) || []) {
          const v = graph.getSystem(id);
          if (v && v.factionId === f) own.add(id);
        }
      }
      const out = Object.freeze({ ok: true, count: own.size });
      byFaction.set(f, out);
      return out;
    } catch (err) {
      return Object.freeze({ ok: false, reason: "BORDER_FAILED",
        detail: String((err && err.message) || err).slice(0, MAX_DETAIL) });
    }
  }

  return Object.freeze({ beltOf, lineOf, homeSpaceCountOf });
}

module.exports = { createBorderIndex };
