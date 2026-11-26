"use strict";

const { poolKeyOf } = require("./demand");

function isPositiveInt(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function byText(a, b) {
  return a < b ? -1 : (a > b ? 1 : 0);
}

function intOf(value, min) {
  return Math.max(min, Math.floor(Number(value) || 0));
}

function buildCrewRoster(fleetsBySystem, seatsByFleet, s) {
  const perPilot = intOf(s && s.shipsPerPilot, 1);
  const maxCrew = intOf(s && s.maxCrewPerFleet, 0);
  const poolCap = intOf(s && s.maxPilotsPerFactionPerSystem, 0);
  const systemCap = intOf(s && s.maxPilotsPerSystem, 0);
  const seatsOf = seatsByFleet instanceof Map ? seatsByFleet : new Map();
  const bySystem = new Map();
  const under = new Set();
  const seen = new Set();
  let truncated = 0;
  let shortfall = 0;
  const systems = [...(fleetsBySystem instanceof Map ? fleetsBySystem.keys() : [])]
    .filter(isPositiveInt).sort((a, b) => a - b);
  for (const systemId of systems) {
    const pools = new Map();
    for (const f of fleetsBySystem.get(systemId) || []) {
      if (!f || typeof f.fleetId !== "string" || f.fleetId === "" || !isPositiveInt(f.factionId)
        || !Number.isFinite(f.shipCount) || f.shipCount <= 0) continue;
      const corporationId = isPositiveInt(f.corporationId) ? f.corporationId : null;
      const key = poolKeyOf(f.factionId, corporationId);
      const pool = pools.get(key) || { factionId: f.factionId, corporationId, ships: 0, fleets: [] };
      pool.ships += Math.floor(f.shipCount);
      pool.fleets.push(f);
      pools.set(key, pool);
    }
    const ordered = [...pools.values()].sort((a, b) => b.ships - a.ships || a.factionId - b.factionId
      || (a.corporationId || 0) - (b.corporationId || 0));
    const ids = [];
    let room = systemCap;
    for (const pool of ordered) {
      let left = Math.min(poolCap, room);
      pool.fleets.sort((a, b) => byText(a.fleetId, b.fleetId));
      for (const f of pool.fleets) {
        const want = Math.min(Math.ceil(Math.floor(f.shipCount) / perPilot), maxCrew);
        const seats = [...(seatsOf.get(f.fleetId) || [])].sort((a, b) => a.seat - b.seat);
        if (seats.length < want) {
          under.add(f.fleetId);
          shortfall += want - seats.length;
        }
        for (const seat of seats.slice(0, want)) {
          if (!seat || !isPositiveInt(seat.characterId) || seen.has(seat.characterId)) continue;
          if (left <= 0) {
            truncated += 1;
            continue;
          }
          seen.add(seat.characterId);
          ids.push(seat.characterId);
          left -= 1;
          room -= 1;
        }
      }
    }
    if (ids.length > 0) bySystem.set(systemId, ids);
  }
  return { bySystem, underCrewed: [...under].sort(byText), truncated, shortfall };
}

module.exports = { buildCrewRoster };
