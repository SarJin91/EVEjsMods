"use strict";

function isPositiveInt(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function poolKeyOf(factionId, corporationId) {
  return `${factionId}:${corporationId || 0}`;
}

function buildDemand(fleetsBySystem, s) {
  const perPilot = Math.max(1, Math.floor(Number(s && s.shipsPerPilot) || 1));
  const cap = Math.max(0, Math.floor(Number(s && s.maxPilotsPerFactionPerSystem) || 0));
  const out = [];
  const systems = [...(fleetsBySystem instanceof Map ? fleetsBySystem.keys() : [])]
    .filter(isPositiveInt).sort((a, b) => a - b);
  for (const systemId of systems) {
    const byKey = new Map();
    for (const f of fleetsBySystem.get(systemId) || []) {
      if (!f || !isPositiveInt(f.factionId) || !Number.isFinite(f.shipCount) || f.shipCount <= 0) continue;
      const corporationId = isPositiveInt(f.corporationId) ? f.corporationId : null;
      const poolKey = poolKeyOf(f.factionId, corporationId);
      const pool = byKey.get(poolKey) || { poolKey, factionId: f.factionId, corporationId, ships: 0, wanted: 0 };
      pool.ships += Math.floor(f.shipCount);
      byKey.set(poolKey, pool);
    }
    const pools = [...byKey.values()];
    for (const p of pools) p.wanted = Math.min(Math.ceil(p.ships / perPilot), cap);
    pools.sort((a, b) => b.ships - a.ships || a.factionId - b.factionId
      || (a.corporationId || 0) - (b.corporationId || 0));
    out.push({ systemId, pools });
  }
  return out;
}

module.exports = { buildDemand, poolKeyOf };
