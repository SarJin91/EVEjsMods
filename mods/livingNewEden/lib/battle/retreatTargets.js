"use strict";

const isPositiveInt = (v) => Number.isSafeInteger(v) && v > 0;

function readControllers(tx, worldRepository, ids) {
  const limits = worldRepository.limits;
  const chunk = limits && isPositiveInt(limits.maxBatchReadIds) ? limits.maxBatchReadIds : ids.length;
  const out = new Map();
  for (let i = 0; i < ids.length; i += chunk) {
    const r = worldRepository.getSystems(tx, ids.slice(i, i + chunk));
    if (!r || r.ok !== true) return { ok: false, reason: (r && r.reason) || "WORLD_READ_FAILED", stage: "retreat" };
    for (const s of r.systems) out.set(s.systemId, s.controllerFactionId);
  }
  return { ok: true, controllers: out };
}

function findRetreatTargets(tx, spec) {
  const { graph, worldRepository, systemId, factionId, limits } = spec;
  if (!graph || typeof graph.getNeighbors !== "function") return { ok: false, reason: "GRAPH_NOT_READY" };
  if (!worldRepository || typeof worldRepository.getSystems !== "function") {
    return { ok: true, targets: [], visited: 0 };
  }
  const visited = new Set([systemId]);
  const targets = [];
  let frontier = [systemId];
  for (let jump = 1; jump <= limits.retreatSearchMaxJumps && frontier.length > 0; jump += 1) {
    if (targets.length >= limits.retreatMaxCandidates) break;
    const room = limits.retreatSearchMaxSystems - (visited.size - 1);
    if (room <= 0) break;
    const next = new Set();
    for (const id of frontier) {
      for (const nb of graph.getNeighbors(id) || []) if (!visited.has(nb)) next.add(nb);
    }
    const layer = [...next].sort((a, b) => a - b).slice(0, room);
    for (const id of layer) visited.add(id);
    if (layer.length === 0) break;
    const read = readControllers(tx, worldRepository, layer);
    if (!read.ok) return read;
    for (const id of layer) if (read.controllers.get(id) === factionId) targets.push(id);
    frontier = layer;
  }
  return { ok: true, targets: targets.slice(0, limits.retreatMaxCandidates), visited: visited.size - 1 };
}

module.exports = { findRetreatTargets };
