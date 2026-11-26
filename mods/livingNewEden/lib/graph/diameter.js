"use strict";

function bfsFrom(graph, sourceId, limit) {
  const dist = new Map([[sourceId, 0]]);
  const queue = [sourceId];
  let maxDist = 0;
  let farthestId = sourceId;
  let overLimit = 0;
  for (let head = 0; head < queue.length; head += 1) {
    const id = queue[head];
    const d = dist.get(id);
    const neighbors = graph.getNeighbors(id) || [];
    for (const next of neighbors) {
      if (dist.has(next)) continue;
      const nd = d + 1;
      dist.set(next, nd);
      queue.push(next);
      if (nd > limit) overLimit += 1;
      if (nd > maxDist) {
        maxDist = nd;
        farthestId = next;
      }
    }
  }
  return { maxDist, farthestId, reached: queue.length - 1, overLimit };
}

function pickSources(graph, count) {
  if (!Number.isSafeInteger(count) || count <= 0) return [];
  const linked = graph.getSystemIds().filter((id) => (graph.getNeighbors(id) || []).length > 0);
  if (linked.length <= count) return [...linked];
  const out = [];
  for (let i = 0; i < count; i += 1) out.push(linked[Math.floor((i * linked.length) / count)]);
  return out;
}

module.exports = { bfsFrom, pickSources };
