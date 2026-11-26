"use strict";

const { bfs } = require("../ai/bfs");

const BFS_REGION_FACTOR = 4;

const isId = (v) => Number.isSafeInteger(v) && v > 0;

function listOf(fn, id) {
  try {
    const v = fn(id);
    return Array.isArray(v) ? v : [];
  } catch (_err) {
    return [];
  }
}

function pickRegion(regionId, input, neighborsOf) {
  const systems = [...new Set(listOf(input.systemsInRegion, regionId).filter(isId))].sort((a, b) => a - b);
  if (systems.length === 0) return { nodes: [], size: 0 };
  const degree = new Map(systems.map((id) => [id, listOf(neighborsOf, id).length]));
  const candidates = systems.filter((id) => degree.get(id) > 0);
  const nodes = [];
  if (systems.includes(input.hqSystemId)) nodes.push(input.hqSystemId);
  else if (candidates.length > 0) {
    nodes.push([...candidates].sort((a, b) => degree.get(b) - degree.get(a) || a - b)[0]);
  }
  if (nodes.length === 0) return { nodes, size: systems.length };
  const maxSystems = systems.length * BFS_REGION_FACTOR;
  const best = new Map();
  const relax = (from) => {
    const dist = bfs([from], neighborsOf, { maxJumps: maxSystems, maxSystems });
    for (const id of candidates) {
      const d = dist.has(id) ? dist.get(id) : Infinity;
      if (!best.has(id) || d < best.get(id)) best.set(id, d);
    }
  };
  relax(nodes[0]);
  while (nodes.length < input.perRegion) {
    const left = candidates.filter((id) => !nodes.includes(id));
    if (left.length === 0) break;
    left.sort((a, b) => {
      const da = best.get(a);
      const db = best.get(b);
      if (da !== db) return da < db ? 1 : -1;
      return degree.get(b) - degree.get(a) || a - b;
    });
    nodes.push(left[0]);
    relax(left[0]);
  }
  return { nodes, size: systems.length };
}

function selectHiveNodes(input) {
  try {
    if (!input || !Array.isArray(input.regionIds) || typeof input.systemsInRegion !== "function"
      || typeof input.neighbors !== "function" || !Number.isSafeInteger(input.perRegion) || input.perRegion < 1) {
      return { nodes: [], homeSystems: 0 };
    }
    const neighborsOf = (id) => listOf(input.neighbors, id);
    const out = new Set();
    let homeSystems = 0;
    for (const regionId of [...new Set(input.regionIds.filter(isId))].sort((a, b) => a - b)) {
      const r = pickRegion(regionId, input, neighborsOf);
      homeSystems += r.size;
      for (const id of r.nodes) out.add(id);
    }
    return { nodes: [...out].sort((a, b) => a - b), homeSystems };
  } catch (_err) {
    return { nodes: [], homeSystems: 0 };
  }
}

module.exports = { selectHiveNodes, BFS_REGION_FACTOR };
