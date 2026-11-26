"use strict";

const STATE_IDLE = "IDLE";
const STATE_STAGED = "STAGED";

const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const isPoint = (p) => Boolean(p) && isNum(p.x) && isNum(p.y) && isNum(p.z);
const isId = (v) => Number.isSafeInteger(v) && v > 0;
const listOf = (v) => (Array.isArray(v) ? v : []);

function distSqOf(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return (dx * dx) + (dy * dy) + (dz * dz);
}

function ownerOf(s) {
  if (!s || typeof s !== "object") return null;
  if (isId(s.controllerFactionId)) return s.controllerFactionId;
  if (isId(s.sdeFactionId)) return s.sdeFactionId;
  return null;
}

function arrivalGateOf(gates, position, matchMeters) {
  if (!isPoint(position) || !isNum(matchMeters) || matchMeters < 0) return null;
  const limitSq = matchMeters * matchMeters;
  let best = null;
  let bestSq = Infinity;
  for (const g of listOf(gates)) {
    if (!g || !Number.isSafeInteger(g.itemId) || !isPoint(g.position)) continue;
    const d = distSqOf(g.position, position);
    if (d > limitSq) continue;
    if (d < bestSq || (d === bestSq && g.itemId < best.itemId)) {
      best = g;
      bestSq = d;
    }
  }
  return best;
}

function exitGateOf(gates, ship, matchMeters) {
  if (!ship || typeof ship !== "object" || ship.cloaked === true || ship.capsule === true) return null;
  if (isId(ship.warpTargetEntityId)) {
    for (const g of listOf(gates)) {
      if (g && g.itemId === ship.warpTargetEntityId && Number.isSafeInteger(g.itemId) && isPoint(g.position)) return g;
    }
  }
  return isPoint(ship.warpTarget) ? arrivalGateOf(gates, ship.warpTarget, matchMeters) : null;
}

function kindOfSafe(fn, factionId) {
  try {
    const kind = typeof fn === "function" ? fn(factionId) : null;
    return typeof kind === "string" && kind !== "" ? kind : null;
  } catch (_err) {
    return null;
  }
}

function pickDefenseFleets(fleets, operationsById, o) {
  if (!Array.isArray(fleets) || !o || !isId(o.ownerFactionId)) return [];
  const roles = listOf(o.roles);
  const kinds = listOf(o.kinds);
  const unstageTypes = listOf(o.unstageOperationTypes);
  const excluded = listOf(o.excludedFactions);
  const ops = operationsById instanceof Map ? operationsById : new Map();
  if (excluded.includes(o.ownerFactionId)) return [];
  const kind = kindOfSafe(o.factionKindOf, o.ownerFactionId);
  if (kind === null || !kinds.includes(kind)) return [];
  const out = [];
  for (const f of fleets) {
    if (!f || f.factionId !== o.ownerFactionId || !roles.includes(f.fleetRole) || f.refitPending === true) continue;
    if (!Number.isSafeInteger(f.shipCount) || f.shipCount < 1) continue;
    const noOperation = f.operationId === null || f.operationId === undefined;
    if (f.state === STATE_IDLE && noOperation) {
      out.push({ fleet: f, unstage: false });
    } else if (f.state === STATE_STAGED && !noOperation) {
      const op = ops.get(f.operationId);
      if (op && typeof op.operationType === "string" && unstageTypes.includes(op.operationType)) {
        out.push({ fleet: f, unstage: true });
      }
    }
  }
  return out.sort((a, b) => (b.fleet.shipCount - a.fleet.shipCount)
    || (a.fleet.fleetId < b.fleet.fleetId ? -1 : a.fleet.fleetId > b.fleet.fleetId ? 1 : 0));
}

function neighboursOf(gates, targetSystemId) {
  const out = new Set();
  for (const g of listOf(gates)) {
    if (g && isId(g.toSystemId) && g.toSystemId !== targetSystemId) out.add(g.toSystemId);
  }
  return [...out].sort((a, b) => a - b);
}

function gateTowards(gates, fromSystemId) {
  let best = null;
  for (const g of listOf(gates)) {
    if (!g || g.toSystemId !== fromSystemId || !Number.isSafeInteger(g.itemId)) continue;
    if (best === null || g.itemId < best.itemId) best = g;
  }
  return best;
}

function hasCapitalSafe(fn, fleet) {
  try {
    return typeof fn === "function" && fn(fleet) === true;
  } catch (_err) {
    return true;
  }
}

function pickReinforcements(gates, targetSystemId, bySystem, o) {
  if (!o || !isId(o.ownerFactionId) || !(bySystem instanceof Map)) return [];
  const keep = Number.isSafeInteger(o.keepPerSystem) && o.keepPerSystem > 0 ? o.keepPerSystem : 0;
  const busy = o.busy instanceof Set ? o.busy : new Set();
  const out = [];
  for (const fromSystemId of neighboursOf(gates, targetSystemId)) {
    const gate = gateTowards(gates, fromSystemId);
    if (gate === null) continue;
    const pool = pickDefenseFleets(listOf(bySystem.get(fromSystemId)), new Map(), {
      ownerFactionId: o.ownerFactionId,
      roles: o.roles,
      kinds: o.kinds,
      unstageOperationTypes: [],
      excludedFactions: o.excludedFactions,
      factionKindOf: o.factionKindOf,
    });
    let free = pool.length - keep;
    for (const p of pool) {
      if (free <= 0) break;
      if (busy.has(p.fleet.fleetId) || hasCapitalSafe(o.hasCapital, p.fleet)) continue;
      out.push({ fleet: p.fleet, fromSystemId, gate });
      free -= 1;
    }
  }
  return out.sort((a, b) => (b.fleet.shipCount - a.fleet.shipCount)
    || (a.fleet.fleetId < b.fleet.fleetId ? -1 : a.fleet.fleetId > b.fleet.fleetId ? 1 : 0)
    || (a.fromSystemId - b.fromSystemId));
}

module.exports = { ownerOf, arrivalGateOf, exitGateOf, pickDefenseFleets, neighboursOf, gateTowards,
  pickReinforcements };
