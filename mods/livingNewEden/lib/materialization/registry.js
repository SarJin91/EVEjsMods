"use strict";

const ENTRY_STATES = Object.freeze(["SPAWNING", "LIVE"]);

function trimFifo(map, max) {
  let removed = 0;
  while (map.size > max) {
    map.delete(map.keys().next().value);
    removed += 1;
  }
  return removed;
}

function createRegistry(limits) {
  const entries = new Map();
  const revertPending = new Map();
  const failedBattles = new Map();
  const strays = new Map();

  function addSpawning(spec) {
    const entry = { battleId: spec.battleId, systemId: spec.systemId, claimSeq: spec.claimSeq, version: spec.version,
      reservationId: spec.reservationId, state: "SPAWNING", sideA: [], sideB: [], spawned: [], targetOf: new Map(),
      liveSince: null, exitSince: null, exitReason: null, exitCause: null, despawned: false,
      structure: spec.structure || null, structureDestroyed: false,
      factionOf: new Map(),
      reserve: { A: [], B: [] }, quota: { A: 0, B: 0 }, anchor: null, anchorRadiusMeters: 0, owners: new Map(),
      lastWaveAt: null, waveBlockedUntil: 0 };
    entries.set(entry.battleId, entry);
    return entry;
  }

  function ownedEntityIds(exceptBattleId) {
    const out = new Set();
    for (const e of entries.values()) {
      if (e.battleId === exceptBattleId) continue;
      for (const s of e.spawned) out.add(s.entityId);
    }
    return out;
  }

  function setFailed(battleId, systemId, retryAt, reason) {
    failedBattles.delete(battleId);
    failedBattles.set(battleId, { systemId, retryAt, reason: String(reason) });
    trimFifo(failedBattles, limits.maxFailedBattlesRemembered);
  }

  function failedCountInSystem(systemId) {
    let n = 0;
    for (const f of failedBattles.values()) if (f.systemId === systemId) n += 1;
    return n;
  }

  function addStray(entityId, systemId) {
    if (strays.has(entityId)) return 0;
    strays.set(entityId, { systemId, attempts: 0 });
    return trimFifo(strays, limits.maxStrayShipsRemembered);
  }

  function liveSideOf(entityId) {
    const id = Number(entityId);
    if (!Number.isSafeInteger(id) || id <= 0) return { ok: false, reason: "NOT_LIVE" };
    for (const e of entries.values()) {
      if (e.state !== "LIVE" || e.despawned) continue;
      for (const [side, ids] of [["A", e.sideA], ["B", e.sideB]]) {
        if (!ids.some((x) => Number(x) === id)) continue;
        return { ok: true, battleId: e.battleId, side, allyIds: ids.filter((x) => Number(x) !== id) };
      }
    }
    return { ok: false, reason: "NOT_LIVE" };
  }

  return Object.freeze({
    addSpawning,
    liveSideOf,
    get: (battleId) => entries.get(battleId) || null,
    has: (battleId) => entries.has(battleId),
    remove: (battleId) => entries.delete(battleId),
    list: () => [...entries.values()],
    ownedEntityIds,
    addRevertPending(battleId, p) {
      revertPending.set(battleId, { systemId: p.systemId, claimSeq: p.claimSeq, reason: String(p.reason),
        attempts: p.attempts || 0 });
    },
    revertPendingList: () => [...revertPending.entries()].map(([battleId, p]) => ({ battleId, ...p })),
    getRevertPending: (battleId) => revertPending.get(battleId) || null,
    removeRevertPending: (battleId) => revertPending.delete(battleId),
    setFailed,
    getFailed: (battleId) => failedBattles.get(battleId) || null,
    isFailedBlocked(battleId, now) {
      const f = failedBattles.get(battleId);
      return Boolean(f && f.retryAt > now);
    },
    failedCountInSystem,
    failedList: () => [...failedBattles.entries()].map(([battleId, f]) => ({ battleId, ...f })),
    addStray,
    strayList: () => [...strays.entries()].map(([entityId, s]) => ({ entityId, ...s })),
    getStray: (entityId) => strays.get(entityId) || null,
    removeStray: (entityId) => strays.delete(entityId),
    sizes: () => ({ entries: entries.size, revertPending: revertPending.size, failedBattles: failedBattles.size,
      strays: strays.size }),
  });
}

module.exports = { createRegistry, ENTRY_STATES };
