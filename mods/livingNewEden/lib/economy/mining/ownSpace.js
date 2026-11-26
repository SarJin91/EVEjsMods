"use strict";

const isId = (v) => Number.isSafeInteger(v) && v > 0;

function projectedController(row, vertex) {
  if (row) return row.controllerFactionId === undefined ? null : row.controllerFactionId;
  return vertex && isId(vertex.factionId) ? vertex.factionId : null;
}

function ownSpaceSystems(input) {
  if (!input || !isId(input.factionId) || typeof input.getSystem !== "function"
    || typeof input.neighbors !== "function") return [];
  const maxSystems = Number.isSafeInteger(input.maxSystems) ? Math.max(0, input.maxSystems) : 0;
  const maxJumps = Number.isSafeInteger(input.maxJumps) ? Math.max(0, input.maxJumps) : 0;
  const sources = [...new Set((input.fromSystemIds || []).filter(isId))].sort((a, b) => a - b);
  const visited = new Set();
  let frontier = [];
  for (const id of sources) {
    if (visited.size >= maxSystems) break;
    visited.add(id);
    frontier.push(id);
  }
  for (let depth = 1; depth <= maxJumps && frontier.length > 0 && visited.size < maxSystems; depth += 1) {
    const next = [];
    for (const id of frontier) {
      const list = input.neighbors(id);
      for (const nb of Array.isArray(list) ? list : []) {
        if (visited.size >= maxSystems) break;
        if (!isId(nb) || visited.has(nb)) continue;
        visited.add(nb);
        next.push(nb);
      }
    }
    frontier = next.sort((a, b) => a - b);
  }
  return [...visited].filter((id) => {
    const v = input.getSystem(id);
    return Boolean(v) && v.factionId === input.factionId;
  }).sort((a, b) => a - b);
}

module.exports = { projectedController, ownSpaceSystems };
