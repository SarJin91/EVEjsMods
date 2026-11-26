"use strict";

const memoSystems = new WeakMap();
const sizeOf = (memo) => {
  let n = memoSystems.get(memo);
  if (n === undefined) {
    n = 0;
    for (const v of memo.values()) n += v.size;
  }
  return n;
};

function bfs(starts, neighbors, opts) {
  const memo = neighbors && neighbors.bfsMemo instanceof Map && !opts.through
    && Number.isSafeInteger(neighbors.bfsMemoMax) && neighbors.bfsMemoMax > 0 ? neighbors.bfsMemo : null;
  if (!memo) return search(starts, neighbors, opts);
  const startKey = [...new Set(starts)].sort((a, b) => a - b).join(",");
  const key = `${opts.maxJumps}|${Math.max(1, opts.maxSystems)}|${startKey}`;
  const cached = memo.get(key);
  if (cached) return new Map(cached);
  const result = search(starts, neighbors, opts);
  const maxSystems = Number.isSafeInteger(neighbors.bfsMemoMaxSystems) && neighbors.bfsMemoMaxSystems > 0
    ? neighbors.bfsMemoMaxSystems : Infinity;
  let held = sizeOf(memo);
  if (memo.size >= neighbors.bfsMemoMax || held + result.size > maxSystems) {
    memo.clear();
    held = 0;
  }
  if (result.size <= maxSystems) {
    memo.set(key, result);
    held += result.size;
  }
  memoSystems.set(memo, held);
  return new Map(result);
}

function search(starts, neighbors, opts) {
  const out = new Map();
  const maxSystems = Math.max(1, opts.maxSystems);
  for (const id of [...new Set(starts)].sort((a, b) => a - b)) {
    if (out.size >= maxSystems) break;
    out.set(id, 0);
  }
  const through = typeof opts.through === "function" ? opts.through : null;
  let frontier = [...out.keys()];
  for (let jump = 1; jump <= opts.maxJumps && frontier.length > 0 && out.size < maxSystems; jump += 1) {
    const next = new Set();
    for (const id of frontier) {
      if (through && out.get(id) > 0 && !through(id)) continue;
      const list = neighbors(id);
      if (!Array.isArray(list)) continue;
      for (const nb of list) if (!out.has(nb)) next.add(nb);
    }
    const layer = [...next].sort((a, b) => a - b).slice(0, maxSystems - out.size);
    for (const id of layer) out.set(id, jump);
    frontier = layer;
  }
  return out;
}

module.exports = { bfs };
