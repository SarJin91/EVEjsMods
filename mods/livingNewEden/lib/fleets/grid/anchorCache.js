"use strict";

function createAnchorCache(opts) {
  const maxSystems = Math.max(1, Math.trunc(Number(opts.maxSystems) || 0));
  const ttlMs = Math.max(0, Math.trunc(Number(opts.ttlMs) || 0));
  const clock = opts.clock;
  const entries = new Map();

  function get(systemId) {
    const hit = entries.get(systemId);
    if (!hit) return null;
    entries.delete(systemId);
    if (clock.now() - hit.readAt >= ttlMs) return null;
    entries.set(systemId, hit);
    return hit;
  }

  function set(systemId, entry) {
    entries.delete(systemId);
    entries.set(systemId, entry);
    while (entries.size > maxSystems) entries.delete(entries.keys().next().value);
  }

  return Object.freeze({ get, set, size: () => entries.size, clear: () => entries.clear() });
}

module.exports = { createAnchorCache };
