"use strict";

const { bfs } = require("./bfs");
const { expansionSet, borderSet, raidSet } = require("./targeting");
const { nearestStation } = require("./housekeeping");

const STRANDED_ROLES = Object.freeze(["invasion", "patrol"]);
const STRANDED_PURPOSE = "COMBAT_STRANDED";
const STRANDED_REASON = "STRANDED";
const IDLE = "IDLE";
const ACTIVE = "ACTIVE";
const READY = "ready";
const HULLS_REQUIRED = "required";

const byFleetId = (a, b) => (a.fleetId < b.fleetId ? -1 : (a.fleetId > b.fleetId ? 1 : 0));

function targetStarts(snapshot, supply) {
  const reach = supply.reach instanceof Map ? supply.reach : new Map();
  const captureReach = supply.captureReach instanceof Map ? supply.captureReach : new Map();
  const out = new Set();
  for (const id of snapshot.theatre || []) if (reach.has(id)) out.add(id);
  for (const id of expansionSet(snapshot)) if (captureReach.has(id)) out.add(id);
  for (const id of borderSet(snapshot)) if (reach.has(id)) out.add(id);
  for (const id of raidSet(snapshot)) if (reach.has(id)) out.add(id);
  const lost = (snapshot.lostHome && Array.isArray(snapshot.lostHome.systemIds)) ? snapshot.lostHome.systemIds : [];
  for (const id of lost) if (reach.has(id) || captureReach.has(id)) out.add(id);
  return [...out].sort((a, b) => a - b);
}

function planStrandedFleets(snapshot, supply, params, used) {
  const none = { intents: [], notes: [] };
  const P = params.stranded;
  if (!P || !(P.maxPerReview > 0) || params.returnKindEnabled === false) return none;
  if (!snapshot.faction || snapshot.faction.status !== ACTIVE || snapshot.stationsMode !== READY) return none;
  if (snapshot.fleetsTruncated === true || snapshot.operationsTruncated === true) return none;
  if (!supply || supply.homeOnly === true) return none;
  const stationSystems = Array.isArray(supply.stationSystems) ? supply.stationSystems : [];
  if (stationSystems.length === 0) return none;
  const at = snapshot.at;
  const notes = new Set();
  const candidates = [];
  const pool = (snapshot.fleets || []).filter((f) => f.state === IDLE && f.operationId === null
    && f.refitPending !== true && STRANDED_ROLES.includes(f.fleetRole) && !used.has(f.fleetId)).sort(byFleetId);
  for (const f of pool) {
    if (!Number.isSafeInteger(f.updatedAt)) {
      notes.add("STRANDED_NO_IDLE_SINCE");
      continue;
    }
    const inStation = stationSystems.includes(f.systemId);
    if (at - f.updatedAt < (inStation ? P.disbandIdleMs : P.idleMs)) continue;
    candidates.push({ f, inStation });
  }
  if (candidates.length === 0) return { intents: [], notes: [...notes].sort() };
  const starts = targetStarts(snapshot, supply);
  if (starts.length === 0) {
    notes.add("STRANDED_NO_TARGETS");
    return { intents: [], notes: [...notes].sort() };
  }
  const zone = bfs(starts, snapshot.neighbors, { maxJumps: params.maxAssemblyJumps, maxSystems: P.maxBfsSystems });
  if (zone.size >= P.maxBfsSystems) {
    notes.add("STRANDED_BFS_LIMIT");
    return { intents: [], notes: [...notes].sort() };
  }
  const pr = params.production;
  const returnHulls = Boolean(pr) && pr.mobilizeHulls === HULLS_REQUIRED && Boolean(snapshot.production)
    && snapshot.production.mode === READY && Boolean(snapshot.doctrine) && snapshot.doctrine.hullsRequired !== false;
  const stations = Array.isArray(snapshot.stations) ? snapshot.stations : [];
  const intents = [];
  let searches = 0;
  for (const { f, inStation } of candidates) {
    if (zone.has(f.systemId)) continue;
    if (intents.length >= P.maxPerReview) {
      notes.add("STRANDED_LIMIT");
      break;
    }
    if (inStation) {
      const here = stations.find((s) => s.systemId === f.systemId);
      if (!here) continue;
      intents.push({ type: "DISBAND", fleetId: f.fleetId, expectedVersion: f.version, systemId: f.systemId,
        stationId: here.stationId, reason: STRANDED_REASON, returnHulls, fleetRole: f.fleetRole });
      notes.add("STRANDED_DISBAND");
      used.add(f.fleetId);
      continue;
    }
    if (searches >= P.maxSearches) {
      notes.add("STRANDED_SEARCH_LIMIT");
      continue;
    }
    searches += 1;
    const near = nearestStation(f.systemId, stationSystems, snapshot, P.returnMaxJumps, params.maxBfsSystems);
    if (near === null) {
      notes.add("STRANDED_NO_BASE");
      continue;
    }
    intents.push({ type: "LAUNCH", kind: "return", target: { kind: "system", systemId: near.systemId, ref: null },
      originSystemId: f.systemId, fleets: [{ fleetId: f.fleetId, expectedVersion: f.version }], mobilize: [],
      dueAt: at + params.returnWindowMs, purpose: STRANDED_PURPOSE });
    notes.add("STRANDED_RETURN");
    used.add(f.fleetId);
  }
  return { intents, notes: [...notes].sort() };
}

module.exports = { planStrandedFleets, STRANDED_ROLES, STRANDED_PURPOSE, STRANDED_REASON };
