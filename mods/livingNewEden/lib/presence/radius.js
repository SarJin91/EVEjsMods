"use strict";

function createRadiusIndex(index) {
  let memo = null;

  function distances(graph, radius) {
    const version = index.getVersion();
    if (memo && memo.graph === graph && memo.version === version && memo.radius === radius) return memo.map;
    const map = new Map();
    let frontier = [];
    for (const id of index.observedSystems()) {
      map.set(id, 0);
      frontier.push(id);
    }
    for (let d = 1; d <= radius && frontier.length > 0; d += 1) {
      const next = [];
      for (const id of frontier) {
        const neighbors = graph.getNeighbors(id) || [];
        for (const n of neighbors) {
          if (map.has(n)) continue;
          map.set(n, d);
          next.push(n);
        }
      }
      frontier = next;
    }
    memo = { graph, version, radius, map };
    return map;
  }

  return Object.freeze({ distances });
}

module.exports = { createRadiusIndex };
