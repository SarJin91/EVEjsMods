"use strict";

const { bfs } = require("./bfs");
const { effectiveIntel, isFresh, ttlOf, intelWithExtra } = require("./targeting");
const { liveCombatFleets } = require("./operations");
const { DEFENSIVE_TYPES } = require("./borderPosts");

const IDLE = "IDLE";
const ACTIVE = "ACTIVE";
const MINING = "MINING";
const ESCORT_KIND = "escort";
const ESCORT_TYPE = "escort";
const DEFENSE_TYPE = "defense";
const PERMILLE = 1000;
const OPEN_OPERATION_STATES = Object.freeze(["PLANNED", "ACTIVE"]);

const byFleetId = (a, b) => (a.fleetId < b.fleetId ? -1 : (a.fleetId > b.fleetId ? 1 : 0));
const hasOperation = (x) => x.operationId !== null && x.operationId !== undefined;

function planMinerEscorts(snapshot, supply, params, used, room, opts) {
  const intents = [];
  const notes = [];
  const out = () => ({ intents, notes });
  const P = params && params.minerEscort;
  if (!P || !(room >= 1)) return out();
  if (!snapshot.faction || snapshot.faction.status !== ACTIVE) return out();
  if (snapshot.fleetsTruncated === true || snapshot.operationsTruncated === true) return out();
  const d = snapshot.doctrine;
  if (!d || d.hive === true) return out();
  if (!Array.isArray(d.operationTypes) || !d.operationTypes.includes(DEFENSE_TYPE)) return out();
  const kind = (params.kinds || []).find((k) => k.kind === ESCORT_KIND);
  if (!kind) return out();
  const trips = snapshot.mining && snapshot.mining.openTrips;
  if (!Array.isArray(trips)) return out();

  const noted = new Set();
  const note = (n) => {
    if (!noted.has(n)) notes.push(n);
    noted.add(n);
  };
  const fleets = snapshot.fleets || [];
  const open = (snapshot.operations || []).filter((op) => OPEN_OPERATION_STATES.includes(op.state));
  const escorts = open.filter((op) => op.operationType === ESCORT_TYPE);
  if (escorts.length >= P.maxPerFaction) return out();
  const cap = Math.floor(liveCombatFleets(fleets) * P.defensiveSharePermille / PERMILLE);
  if (!(cap > 0)) return out();
  const defensiveOps = open.filter((op) => DEFENSIVE_TYPES.includes(op.operationType));
  const defensive = new Set(defensiveOps.map((op) => op.operationId));
  const extraBusy = opts && Number.isSafeInteger(opts.busy) && opts.busy > 0 ? opts.busy : 0;
  const busy = fleets.filter((x) => hasOperation(x) && defensive.has(x.operationId)).length + extraBusy;
  if (busy >= cap) {
    note("MINER_ESCORT_CAPPED");
    return out();
  }
  const limit = Math.min(room, P.maxPerReview, P.maxPerFaction - escorts.length, cap - busy);
  if (!(limit > 0)) return out();

  const at = snapshot.at;
  const intel = effectiveIntel({ ...snapshot, intel: intelWithExtra(snapshot), sightings: snapshot.sightings || [] });
  const fresh = (id) => {
    const seen = intel.get(id);
    return isFresh(seen, at, ttlOf(seen, params)) ? seen : null;
  };
  const held = new Set(defensiveOps.map((op) => op.targetSystemId));
  const launched = opts && opts.targets instanceof Set ? opts.targets : new Set();
  const classes = new Set(P.secClasses || []);
  const line = new Set((Array.isArray(snapshot.borderLine) ? snapshot.borderLine : [])
    .map((e) => e && e.systemId));
  const shipsOf = new Map(fleets.map((x) => [x.fleetId, Number.isSafeInteger(x.shipCount) ? x.shipCount : 0]));

  const belts = new Map();
  for (const t of trips) {
    if (!t || t.state !== MINING || !Number.isSafeInteger(t.systemId) || !classes.has(t.secClass)) continue;
    if (!Number.isSafeInteger(t.miningEndsAt) || t.miningEndsAt - at < P.minShiftLeftMs) continue;
    if (held.has(t.systemId) || launched.has(t.systemId)) continue;
    const b = belts.get(t.systemId) || { systemId: t.systemId, endsAt: t.miningEndsAt, ships: 0 };
    b.endsAt = Math.max(b.endsAt, t.miningEndsAt);
    b.ships += shipsOf.get(t.fleetId) || 0;
    belts.set(t.systemId, b);
  }
  const threatOpts = { maxJumps: Math.max(0, P.threatJumps), maxSystems: params.maxBfsSystems };
  const candidates = [];
  for (const b of belts.values()) {
    let threat = 0;
    for (const id of bfs([b.systemId], snapshot.neighbors, threatOpts).keys()) {
      const seen = fresh(id);
      if (seen && seen.hostileStrength > 0) threat += seen.hostileStrength;
    }
    const onLine = line.has(b.systemId);
    if (!onLine && !(threat > 0)) continue;
    candidates.push({ ...b, threat, onLine: onLine ? 0 : 1 });
  }
  candidates.sort((a, b) => b.threat - a.threat || a.onLine - b.onLine || b.ships - a.ships || a.systemId - b.systemId);

  const roles = new Set(kind.fleetRoles || []);
  const pool = fleets.filter((x) => x.state === IDLE && !hasOperation(x) && x.refitPending !== true
    && Number.isSafeInteger(x.systemId) && roles.has(x.fleetRole) && x.shipCount >= P.minShips).sort(byFleetId);
  const bfsOpts = { maxJumps: Math.max(0, P.maxJumps), maxSystems: params.maxBfsSystems };
  for (const c of candidates) {
    if (intents.length >= limit) break;
    const dist = bfs([c.systemId], snapshot.neighbors, bfsOpts);
    let best = null;
    for (const x of pool) {
      if (used.has(x.fleetId) || !dist.has(x.systemId)) continue;
      const jumps = dist.get(x.systemId);
      if (jumps > 0) {
        if (!Number.isSafeInteger(x.updatedAt)) {
          note("MINER_ESCORT_NO_IDLE_SINCE");
          continue;
        }
        if (at - x.updatedAt < P.idleMs) continue;
      }
      if (best === null || jumps < best.jumps) best = { fleet: x, jumps };
    }
    if (best === null) continue;
    const x = best.fleet;
    const inBelt = fresh(c.systemId);
    if (inBelt && inBelt.hostileStrength > (x.strength || 0) * P.maxEnemyRatio) {
      note("MINER_ESCORT_TOO_STRONG");
      continue;
    }
    intents.push({ type: "LAUNCH", kind: ESCORT_KIND, target: { kind: "system", systemId: c.systemId, ref: null },
      originSystemId: x.systemId, fleets: [{ fleetId: x.fleetId, expectedVersion: x.version }], mobilize: [],
      dueAt: Math.min(c.endsAt, at + P.windowMs) });
    notes.push(`MINER_ESCORT:${c.systemId}`);
    used.add(x.fleetId);
  }
  return out();
}

module.exports = { planMinerEscorts, ESCORT_KIND };
