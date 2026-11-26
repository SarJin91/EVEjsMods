// Port with changes of EveJS 261108.1 (AGPL-3.0-only, see CREDITS.md): incursionFocusPlacement.js buildCatalog (an edge only between two systems of the same constellation, region and security band, with the gate both ways; neighbours ascending) and the BFS of selectPlacement (the first

"use strict";

const ROLES = Object.freeze(["hq", "assault", "vanguard", "staging"]);
const SEC_CLASSES = Object.freeze(["highsec", "lowsec", "nullsec"]);

const asc = (a, b) => a - b;
const isId = (v) => Number.isSafeInteger(v) && v > 0;

function neighborsOf(graph, id) {
  const n = graph.getNeighbors(id);
  return Array.isArray(n) ? n : [];
}

function placeAround(graph, targetSystemId, opts) {
  const o = opts || {};
  if (!graph || typeof graph.getSystem !== "function" || typeof graph.getNeighbors !== "function"
    || !Number.isSafeInteger(o.systems) || o.systems < 1 || o.systems > ROLES.length
    || !Number.isSafeInteger(o.minSystems) || o.minSystems < 1) {
    return { ok: false, reason: "INVALID_INPUT" };
  }
  const target = isId(targetSystemId) ? graph.getSystem(targetSystemId) : null;
  if (!target) return { ok: false, reason: "NO_SYSTEM" };
  if (!SEC_CLASSES.includes(target.secClass)) return { ok: false, reason: "NO_CLASS" };
  const same = (id) => {
    const s = graph.getSystem(id);
    return Boolean(s) && s.constellationId === target.constellationId && s.regionId === target.regionId
      && s.secClass === target.secClass;
  };
  const queue = [targetSystemId];
  const visited = new Set(queue);
  const chosen = [];
  for (let i = 0; i < queue.length && chosen.length < o.systems; i += 1) {
    const id = queue[i];
    chosen.push(id);
    for (const other of [...neighborsOf(graph, id)].sort(asc)) {
      if (visited.has(other) || !same(other) || !neighborsOf(graph, other).includes(id)) continue;
      visited.add(other);
      queue.push(other);
    }
  }
  if (chosen.length < o.minSystems) return { ok: false, reason: "TOO_SMALL" };
  return { ok: true, constellationId: target.constellationId, regionId: target.regionId, secClass: target.secClass,
    systems: chosen.map((systemId, i) => ({ systemId, role: ROLES[i] })) };
}

module.exports = { ROLES, SEC_CLASSES, placeAround };
