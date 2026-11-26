"use strict";

const { bfs } = require("./bfs");
const { hasJumpFreighter, jfReachOf } = require("./logistics");
const { returnContext } = require("./patrol");
const { DEFENSIVE_TYPES } = require("./borderPosts");

const IDLE = "IDLE";
const PATROL_OPERATION_TYPE = "patrol";
const OBSERVING_STATES = Object.freeze(["IDLE", "PLANNED", "STAGED", "REFITTING", "ENGAGED", "MATERIALIZED"]);
const INTEL_SOURCE = "fleet";
const LOGISTICS_ROLE = "logistics";
const SCOUT_ROLE = "scout";
const PATROL_ROLE = "patrol";
const RETIRE_PURPOSE = "LOGISTICS_RETIRE";
const STRANDED_PURPOSE = "LOGISTICS_STRANDED";
const HULLS_REQUIRED = "required";

function observationOrder(fleets, fronts, theatre, max) {
  const standing = fleets.filter((f) => OBSERVING_STATES.includes(f.state));
  const seen = [...new Set(standing.map((f) => f.systemId))];
  const scouted = new Set(standing.filter((f) => f.fleetRole === SCOUT_ROLE || f.fleetRole === PATROL_ROLE)
    .map((f) => f.systemId));
  const front = new Set(fronts);
  const inTheatre = new Set(theatre);
  const rank = (id) => (front.has(id) ? 0 : (scouted.has(id) ? 1 : (inTheatre.has(id) ? 2 : 3)));
  return seen.sort((a, b) => rank(a) - rank(b) || a - b).slice(0, Math.max(0, max));
}

function observationFronts(operations) {
  return [...new Set((operations || []).filter((op) => op.operationType !== PATROL_OPERATION_TYPE
    && !DEFENSIVE_TYPES.includes(op.operationType)).map((op) => op.targetSystemId))];
}

function planHousekeeping(snapshot, params) {
  const intents = [];
  const closed = [];
  let stuck = 0;
  const members = new Map();
  const ordered = new Map();
  for (const f of snapshot.fleets) {
    if (f.operationId === null) continue;
    members.set(f.operationId, (members.get(f.operationId) || 0) + 1);
    if (["PLANNED", "TRAVELLING", "STAGED", "MATERIALIZED"].includes(f.state)) {
      ordered.set(f.operationId, (ordered.get(f.operationId) || 0) + 1);
    }
  }
  for (const s of snapshot.sightings) {
    let fleets = 0;
    let ships = 0;
    let strength = 0;
    for (const h of s.hostile) {
      fleets += h.fleets;
      ships += h.ships;
      strength += h.strength;
    }
    intents.push({ type: "OBSERVE", systemId: s.systemId, observation: { observedAt: snapshot.at,
      controllerFactionId: s.controllerFactionId, hostileFleets: fleets, hostileShips: ships,
      hostileStrength: strength, hostileStations: s.hostileStations, source: INTEL_SOURCE } });
  }
  if (snapshot.fleetsTruncated !== true) {
    const ops = [...snapshot.operations].sort((a, b) => (a.operationId < b.operationId ? -1 : 1));
    for (const op of ops) {
      const n = members.get(op.operationId) || 0;
      const o = ordered.get(op.operationId) || 0;
      const late = op.dueAt === null || snapshot.at >= op.dueAt + params.operationGraceMs;
      let close = null;
      if (op.state === "PLANNED" && n === 0) close = { from: "PLANNED", to: "CANCELLED", reason: "NO_MEMBERS" };
      else if (op.state === "ACTIVE" && o === 0 && late) {
        close = { from: "ACTIVE", to: "FAILED", reason: "NO_ORDERED_MEMBERS" };
      } else if (op.state === "ACTIVE" && o > 0 && op.dueAt !== null && late) stuck += 1;
      if (close === null || closed.length >= params.maxHousekeepingPerReview) continue;
      closed.push(op.operationId);
      intents.push({ type: "CLOSE_OPERATION", operationId: op.operationId, expectedVersion: op.version,
        from: close.from, to: close.to, result: { closedBy: "strategy", reason: close.reason } });
    }
  }
  const stranded = snapshot.fleets.filter((f) => f.state === IDLE && f.refitPending === true)
    .sort((a, b) => (a.fleetId < b.fleetId ? -1 : 1)).slice(0, Math.max(0, params.maxRefitRequestsPerReview));
  for (const f of stranded) {
    intents.push({ type: "REQUEST_REFIT", fleetId: f.fleetId, expectedVersion: f.version, legSeq: f.legSeq });
  }
  return { intents, closed, stuck };
}

function planTerritoryMarks(snapshot, supply, params) {
  if (snapshot.stationsMode !== "ready" || snapshot.territoryTruncated === true) return [];
  const out = [];
  const list = [...(snapshot.territory || [])].sort((a, b) => a.systemId - b.systemId);
  for (const t of list) {
    if (out.length >= Math.max(0, params.maxTerritoryMarksPerReview || 0)) break;
    const detached = !supply.captureReach.has(t.systemId);
    if (detached === (t.detachedSinceAt !== null)) continue;
    out.push({ type: "TERRITORY_MARK", systemId: t.systemId, detached });
  }
  return out;
}

function nearestStation(systemId, stationSystems, snapshot, maxJumps, maxSystems) {
  const list = stationDistances(systemId, stationSystems, snapshot, maxJumps, maxSystems);
  return list.length === 0 ? null : list[0];
}

function stationDistances(systemId, stationSystems, snapshot, maxJumps, maxSystems) {
  const dist = bfs([systemId], snapshot.neighbors, { maxJumps, maxSystems });
  const out = [];
  for (const s of new Set(stationSystems)) {
    const d = dist.get(s);
    if (d !== undefined) out.push({ systemId: s, jumps: d });
  }
  return out.sort((a, b) => a.jumps - b.jumps || a.systemId - b.systemId);
}

function visibleFromStations(fleetSystemId, reach, stations, fromStation, snapshot, maxReach, maxSystems, bfsCap) {
  for (const s of stations) {
    if (s.jumps > reach) continue;
    if (!fromStation.has(s.systemId)) {
      if (fromStation.size >= bfsCap) return "limit";
      fromStation.set(s.systemId, bfs([s.systemId], snapshot.neighbors, { maxJumps: maxReach, maxSystems }));
    }
    const d = fromStation.get(s.systemId).get(fleetSystemId);
    if (d !== undefined && d <= reach) return "visible";
  }
  return "hidden";
}

function nearestStationSystem(systemId, stationSystems, snapshot, params) {
  const near = nearestStation(systemId, stationSystems, snapshot, params.maxAssemblyJumps, params.maxBfsSystems);
  return near === null ? null : near.systemId;
}

function planReturns(snapshot, supply, params, used) {
  const none = { intents: [], notes: [] };
  if (!snapshot.doctrine || snapshot.doctrine.returnToBase !== true) return none;
  if (snapshot.fleetsTruncated === true || snapshot.operationsTruncated === true) return none;
  const hive = snapshot.doctrine.hive === true;
  if (!hive && snapshot.stationsMode !== "ready") return none;
  const stationSystems = hive ? supply.footholdSystems : supply.stationSystems;
  if (!Array.isArray(stationSystems) || stationSystems.length === 0) return none;
  const maxReturns = Math.max(0, params.maxReturnsPerReview || 0);
  if (maxReturns === 0 || !Array.isArray(params.returnFleetRoles)) return none;
  const claims = hive ? returnContext(snapshot, supply).homeClaims : null;
  const notes = new Set();
  const intents = [];
  const candidates = snapshot.fleets.filter((f) => f.state === IDLE && f.operationId === null
    && f.refitPending !== true && params.returnFleetRoles.includes(f.fleetRole) && !used.has(f.fleetId)
    && !stationSystems.includes(f.systemId) && !(claims !== null && claims.has(f.systemId)))
    .sort((a, b) => (a.fleetId < b.fleetId ? -1 : (a.fleetId > b.fleetId ? 1 : 0)));
  for (const f of candidates) {
    if (intents.length >= maxReturns) break;
    if (!Number.isSafeInteger(f.updatedAt)) {
      notes.add("RETURN_NO_IDLE_SINCE");
      continue;
    }
    if (snapshot.at - f.updatedAt < params.returnAfterIdleMs) continue;
    const target = nearestStationSystem(f.systemId, stationSystems, snapshot, params);
    if (target === null) {
      notes.add("RETURN_NO_BASE");
      continue;
    }
    intents.push({ type: "LAUNCH", kind: "return", target: { kind: "system", systemId: target, ref: null },
      originSystemId: f.systemId, fleets: [{ fleetId: f.fleetId, expectedVersion: f.version }], mobilize: [],
      dueAt: snapshot.at + params.returnWindowMs });
    used.add(f.fleetId);
  }
  return { intents, notes: [...notes].sort() };
}

function planLogisticsRetire(snapshot, supply, params, used) {
  const none = { intents: [], notes: [] };
  const P = params.logistics;
  if (!P || (P.retireEnabled !== true && P.strandedReturnEnabled !== true)) return none;
  const max = Math.max(0, P.maxRetiresPerReview || 0);
  const lg = snapshot.logistics;
  if (max === 0 || !lg || lg.mode !== "ready" || lg.truncated === true) return none;
  if (snapshot.stationsMode !== "ready") return none;
  if (snapshot.fleetsTruncated === true || snapshot.operationsTruncated === true) return none;
  const carriers = lg.carriers || {};
  const busy = new Set(lg.busyFleetIds || []);
  const byFleetId = (a, b) => (a.fleetId < b.fleetId ? -1 : (a.fleetId > b.fleetId ? 1 : 0));
  const free = (f) => f.fleetRole === LOGISTICS_ROLE && Number.isSafeInteger(carriers[f.fleetId]) && f.state === IDLE
    && f.refitPending !== true && f.operationId === null && !busy.has(f.fleetId) && !used.has(f.fleetId);
  const stationSystems = supply.stationSystems || [];
  const candidates = P.retireEnabled !== true ? []
    : snapshot.fleets.filter((f) => free(f) && carriers[f.fleetId] === 0).sort(byFleetId);
  const strandedList = P.strandedReturnEnabled !== true ? []
    : snapshot.fleets.filter((f) => free(f) && carriers[f.fleetId] > 0 && !stationSystems.includes(f.systemId))
      .sort(byFleetId);
  if (candidates.length === 0 && strandedList.length === 0) return none;
  const stations = snapshot.stations || [];
  const pr = params.production;
  const returnHulls = P.needsHulls === true && Boolean(pr) && pr.mobilizeHulls === HULLS_REQUIRED
    && pr.logisticsNeedsHulls === true && Boolean(snapshot.production) && snapshot.production.mode === "ready"
    && snapshot.doctrine && snapshot.doctrine.hullsRequired !== false;
  const notes = new Set();
  if (candidates.length > 0) notes.add("LOGISTICS_RETIRE");
  const intents = [];
  for (const f of candidates) {
    if (intents.length >= max) {
      notes.add("LOGISTICS_RETIRE_LIMIT");
      break;
    }
    const here = stations.find((s) => s.systemId === f.systemId);
    const disband = (stationId, reason, hulls) => ({ type: "DISBAND", fleetId: f.fleetId, expectedVersion: f.version,
      systemId: f.systemId, stationId, reason, returnHulls: hulls });
    if (here) {
      intents.push(disband(here.stationId, "NO_CARRIERS", returnHulls));
    } else {
      const target = params.returnKindEnabled === false ? null
        : nearestStationSystem(f.systemId, stationSystems, snapshot, params);
      if (target === null) {
        notes.add("LOGISTICS_RETIRE_NO_BASE");
        intents.push(disband(null, "NO_BASE", false));
      } else {
        intents.push({ type: "LAUNCH", kind: "return", target: { kind: "system", systemId: target, ref: null },
          originSystemId: f.systemId, fleets: [{ fleetId: f.fleetId, expectedVersion: f.version }], mobilize: [],
          dueAt: snapshot.at + params.returnWindowMs, purpose: RETIRE_PURPOSE });
      }
    }
    used.add(f.fleetId);
  }
  const fromStations = P.strandedFromStationsEnabled === true;
  const bfsCap = Math.max(1, P.strandedMaxStationBfs || 1);
  const maxReach = strandedList.some(hasJumpFreighter) ? jfReachOf(P) : P.maxConvoyJumps;
  const fromStation = new Map();
  for (const f of strandedList) {
    const reach = hasJumpFreighter(f) ? jfReachOf(P) : P.maxConvoyJumps;
    const depth = Number.isSafeInteger(P.strandedReturnMaxJumps) ? Math.max(P.strandedReturnMaxJumps, reach) : reach;
    const found = stationDistances(f.systemId, stationSystems, snapshot, depth, params.maxBfsSystems);
    const near = found.length === 0 ? null : found[0];
    if (near !== null && near.jumps <= reach) {
      if (!fromStations) continue;
      const seen = visibleFromStations(f.systemId, reach, found, fromStation, snapshot, maxReach,
        params.maxBfsSystems, bfsCap);
      if (seen === "visible") continue;
      if (seen === "limit") {
        notes.add("LOGISTICS_STRANDED_BFS_LIMIT");
        continue;
      }
    }
    if (intents.length >= max) {
      notes.add("LOGISTICS_STRANDED_LIMIT");
      break;
    }
    let target = null;
    if (params.returnKindEnabled !== false) {
      if (near !== null) target = near.systemId;
      else if (stationSystems.includes(f.homeSystemId)) target = f.homeSystemId;
    }
    if (target === null) {
      notes.add("LOGISTICS_STRANDED_NO_BASE");
      continue;
    }
    intents.push({ type: "LAUNCH", kind: "return", target: { kind: "system", systemId: target, ref: null },
      originSystemId: f.systemId, fleets: [{ fleetId: f.fleetId, expectedVersion: f.version }], mobilize: [],
      dueAt: snapshot.at + params.returnWindowMs, purpose: STRANDED_PURPOSE });
    notes.add("LOGISTICS_STRANDED_RETURN");
    used.add(f.fleetId);
  }
  return { intents, notes: [...notes].sort() };
}

module.exports = { planHousekeeping, planTerritoryMarks, observationOrder, observationFronts, planReturns, planLogisticsRetire,
  nearestStationSystem, nearestStation, stationDistances, visibleFromStations, OBSERVING_STATES, INTEL_SOURCE, RETIRE_PURPOSE, STRANDED_PURPOSE };
