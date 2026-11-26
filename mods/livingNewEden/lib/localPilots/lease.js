"use strict";

function fmix32(value) {
  let h = value >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

function leaseCharacters(input) {
  const poolIds = Array.isArray(input && input.poolIds) ? input.poolIds : [];
  const demand = Array.isArray(input && input.demand) ? input.demand : [];
  const previous = input && input.previous instanceof Map ? input.previous : new Map();
  const taken = input && input.taken instanceof Set ? input.taken : new Set();
  const n = poolIds.length;
  const indexOf = new Map();
  for (let i = 0; i < n; i += 1) if (!indexOf.has(poolIds[i])) indexOf.set(poolIds[i], i);
  const used = new Uint8Array(n);
  for (const id of taken) {
    const i = indexOf.get(id);
    if (i !== undefined) used[i] = 1;
  }
  const leases = new Map();
  const rest = [];
  for (const sys of demand) {
    for (const pilotId of sys.pilotIds) {
      if (leases.has(pilotId)) continue;
      const i = indexOf.get(previous.get(pilotId));
      if (i !== undefined && used[i] === 0) {
        used[i] = 1;
        leases.set(pilotId, poolIds[i]);
      } else {
        rest.push(pilotId);
      }
    }
  }
  let shortfall = 0;
  for (const pilotId of rest) {
    if (leases.has(pilotId)) continue;
    let picked = -1;
    if (n > 0) {
      const start = fmix32(pilotId) % n;
      for (let k = 0; k < n; k += 1) {
        const i = (start + k) % n;
        if (used[i] === 0) {
          picked = i;
          break;
        }
      }
    }
    if (picked < 0) {
      shortfall += 1;
      continue;
    }
    used[picked] = 1;
    leases.set(pilotId, poolIds[picked]);
  }
  const bySystem = new Map();
  const placed = new Set();
  for (const sys of demand) {
    const ids = [];
    for (const pilotId of sys.pilotIds) {
      const characterId = leases.get(pilotId);
      if (characterId === undefined || placed.has(pilotId)) continue;
      placed.add(pilotId);
      ids.push(characterId);
    }
    if (ids.length > 0) bySystem.set(sys.systemId, ids);
  }
  return { bySystem, leases, assigned: leases.size, shortfall };
}

module.exports = { leaseCharacters, fmix32 };
