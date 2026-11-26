"use strict";

const { performance } = require("node:perf_hooks");
const { REPAIR_STATES } = require("./schema");

const METRIC_SEARCH_MS = "stations.repairSearchMs";
const MS_DECIMALS = 100;
const HIVE_NODE_PREFIX = "hive-node:";

const isId = (v) => Number.isSafeInteger(v) && v > 0;

function createRepairLocator(deps) {
  const { repository, limits } = deps;
  const telemetry = deps.telemetry || null;
  const nowMs = typeof deps.nowMs === "function" ? deps.nowMs : () => performance.now();

  function observe(ms) {
    if (!telemetry || typeof telemetry.observe !== "function") return;
    try {
      telemetry.observe(METRIC_SEARCH_MS, Math.round(ms * MS_DECIMALS) / MS_DECIMALS);
    } catch (_err) {
    }
  }

  function graphNow() {
    try {
      const g = deps.getGraph();
      return g && typeof g.getNeighbors === "function" ? g : null;
    } catch (_err) {
      return null;
    }
  }

  function nodesOf(tx, factionId) {
    if (typeof deps.repairNodesOf !== "function") return { ok: true, systems: new Set() };
    const r = deps.repairNodesOf(tx, factionId);
    if (!r || !r.ok) return r || { ok: false, reason: "REPAIR_NODES_FAILED" };
    return { ok: true, systems: r.systems instanceof Set ? r.systems : new Set() };
  }

  function repairSystems(tx, factionId) {
    const r = repository.listStationsOfFaction(tx, factionId, { states: [...REPAIR_STATES] });
    if (!r.ok) return r;
    const systems = new Set(r.records.map((s) => s.systemId));
    const nodes = nodesOf(tx, factionId);
    if (!nodes.ok) return nodes;
    for (const id of nodes.systems) systems.add(id);
    return { ok: true, systems, first: r.records };
  }

  function hasRepairStation(tx, factionId, systemId) {
    if (!isId(factionId) || !isId(systemId)) return { ok: false, reason: "INVALID_INPUT" };
    const r = repository.listStationsInSystem(tx, systemId);
    if (!r.ok) return r;
    const hit = r.records.find((s) => s.ownerFactionId === factionId && REPAIR_STATES.includes(s.state));
    if (hit) return { ok: true, stationId: hit.stationId };
    const nodes = nodesOf(tx, factionId);
    if (!nodes.ok) return nodes;
    return { ok: true, stationId: nodes.systems.has(systemId) ? `${HIVE_NODE_PREFIX}${systemId}` : null };
  }

  function findNearestStations(tx, spec) {
    const t0 = nowMs();
    const factionId = spec && spec.factionId;
    const from = spec && spec.fromSystemId;
    if (!isId(factionId) || !isId(from)) return { ok: false, reason: "INVALID_INPUT" };
    const max = spec.maxCandidates === undefined ? limits.repairMaxCandidates
      : Math.max(1, Math.min(limits.repairMaxCandidates, Math.trunc(Number(spec.maxCandidates) || 1)));
    const read = repairSystems(tx, factionId);
    if (!read.ok) return read;
    if (read.systems.size === 0) return { ok: true, targets: [], visited: 0 };
    const targets = [];
    if (read.systems.has(from)) targets.push(from);
    const graph = graphNow();
    if (!graph) {
      if (targets.length > 0) return { ok: true, targets, visited: 0 };
      return { ok: false, reason: "GRAPH_NOT_READY" };
    }
    const visited = new Set([from]);
    let frontier = [from];
    for (let jump = 1; jump <= limits.repairSearchMaxJumps && frontier.length > 0; jump += 1) {
      if (targets.length >= max) break;
      const room = limits.repairSearchMaxSystems - (visited.size - 1);
      if (room <= 0) break;
      const next = new Set();
      for (const id of frontier) {
        for (const nb of graph.getNeighbors(id) || []) if (!visited.has(nb)) next.add(nb);
      }
      const layer = [...next].sort((a, b) => a - b).slice(0, room);
      if (layer.length === 0) break;
      for (const id of layer) {
        visited.add(id);
        if (read.systems.has(id)) targets.push(id);
      }
      frontier = layer;
    }
    observe(nowMs() - t0);
    return { ok: true, targets: targets.slice(0, max), visited: visited.size - 1 };
  }

  return Object.freeze({ hasRepairStation, findNearestStations, getMode: () => deps.getMode() });
}

module.exports = { createRepairLocator };
