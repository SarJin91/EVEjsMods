"use strict";

const { selectHiveNodes, BFS_REGION_FACTOR } = require("./nodes");
const { bfs } = require("../ai/bfs");

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const EMPTY_FOOTHOLDS = Object.freeze({ ok: true, footholds: Object.freeze([]) });

function messageOf(err) {
  return String((err && err.message) || err).slice(0, 200);
}

function disabledHive() {
  return Object.freeze({
    enabled: false,
    isHive: () => false,
    listNodesInTx: () => EMPTY_FOOTHOLDS,
    repairNodesOf: () => ({ ok: true, systems: new Set() }),
    homeSystemCount: () => 0,
    captureSlowFactorOf: () => 1,
  });
}

function createHive(deps) {
  try {
    const { registry, settings } = deps || {};
    if (!settings || settings.enabled !== true || !registry || typeof registry.listActiveFactions !== "function") {
      return disabledHive();
    }
    const hiveFactions = new Map();
    for (const f of registry.listActiveFactions()) {
      const d = f.doctrineId ? registry.getDoctrine(f.doctrineId) : null;
      if (d && d.hive === true) hiveFactions.set(f.factionId, f);
    }
    if (hiveFactions.size === 0) return disabledHive();
    const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : { log: () => {} };
    const range = settings.nodeCaptureRangeJumps;
    let cachedGraph = null;
    let cache = new Map();

    function graphNow() {
      try {
        const g = typeof deps.getGraph === "function" ? deps.getGraph() : null;
        return g && typeof g.getNeighbors === "function" && typeof g.getSystemsInRegion === "function" ? g : null;
      } catch (_err) {
        return null;
      }
    }

    function compute(graph, entry) {
      const neighbors = (id) => graph.getNeighbors(id);
      const picked = selectHiveNodes({ regionIds: entry.homeRegionIds, hqSystemId: entry.hqSystemId,
        perRegion: settings.nodesPerRegion, systemsInRegion: (id) => graph.getSystemsInRegion(id), neighbors });
      const home = new Set();
      for (const regionId of entry.homeRegionIds) for (const id of graph.getSystemsInRegion(regionId)) home.add(id);
      const covered = picked.nodes.length === 0 ? new Map()
        : bfs(picked.nodes, neighbors, { maxJumps: range, maxSystems: Math.max(1, home.size * BFS_REGION_FACTOR) });
      let uncovered = 0;
      for (const id of home) if (!covered.has(id)) uncovered += 1;
      try {
        logger.log(`strategy: hive ${entry.factionId} nodes=${picked.nodes.length} homeSystems=${picked.homeSystems} `
          + `uncovered=${uncovered} rangeJumps=${range}`);
      } catch (_err) {
      }
      return Object.freeze({ nodes: Object.freeze(picked.nodes), homeSystems: picked.homeSystems });
    }

    function nodesOf(factionId) {
      const entry = hiveFactions.get(factionId);
      if (!entry) return null;
      const graph = graphNow();
      if (!graph) return null;
      if (graph !== cachedGraph) {
        cachedGraph = graph;
        cache = new Map();
      }
      if (!cache.has(factionId)) cache.set(factionId, compute(graph, entry));
      return cache.get(factionId);
    }

    function activeNodes(tx, f) {
      const n = nodesOf(f);
      if (!n || n.nodes.length === 0) return { ok: true, systems: [] };
      const repo = typeof deps.getWorldRepository === "function" ? deps.getWorldRepository() : null;
      if (!repo || typeof repo.getSystems !== "function") return { ok: false, reason: "HIVE_WORLD_UNAVAILABLE" };
      const size = repo.limits && isId(repo.limits.maxBatchReadIds) ? repo.limits.maxBatchReadIds : n.nodes.length;
      const systems = [];
      for (let i = 0; i < n.nodes.length; i += size) {
        const r = repo.getSystems(tx, n.nodes.slice(i, i + size), { includeInfluence: false });
        if (!r || !r.ok) return r || { ok: false, reason: "HIVE_WORLD_READ_FAILED" };
        for (const s of r.systems) if (s.controllerFactionId === f) systems.push(s.systemId);
      }
      return { ok: true, systems: systems.sort((a, b) => a - b) };
    }

    function listNodesInTx(tx, factionId) {
      try {
        const f = Number(factionId);
        if (!hiveFactions.has(f)) return EMPTY_FOOTHOLDS;
        const a = activeNodes(tx, f);
        if (!a.ok) return a;
        return { ok: true, footholds: a.systems.map((systemId) => ({ systemId, jumps: range })) };
      } catch (err) {
        return { ok: false, reason: "HIVE_THREW", detail: messageOf(err) };
      }
    }

    function repairNodesOf(tx, factionId) {
      try {
        const f = Number(factionId);
        if (!hiveFactions.has(f)) return { ok: true, systems: new Set() };
        const a = activeNodes(tx, f);
        return a.ok ? { ok: true, systems: new Set(a.systems) } : a;
      } catch (err) {
        return { ok: false, reason: "HIVE_THREW", detail: messageOf(err) };
      }
    }

    function homeSystemCount(factionId) {
      try {
        const f = factionId === undefined ? hiveFactions.keys().next().value : Number(factionId);
        const n = nodesOf(f);
        return n ? n.homeSystems : 0;
      } catch (_err) {
        return 0;
      }
    }

    return Object.freeze({
      enabled: true,
      isHive: (factionId) => hiveFactions.has(Number(factionId)),
      listNodesInTx,
      repairNodesOf,
      homeSystemCount,
      captureSlowFactorOf: (c, home) => (hiveFactions.has(Number(c)) && Number(c) === Number(home)
        && Number.isSafeInteger(settings.captureSlowFactor) && settings.captureSlowFactor > 1
        ? settings.captureSlowFactor : 1),
    });
  } catch (_err) {
    return disabledHive();
  }
}

module.exports = { createHive };
