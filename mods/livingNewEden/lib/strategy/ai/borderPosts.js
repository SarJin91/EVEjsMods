"use strict";

const { bfs } = require("./bfs");
const { effectiveIntel, isFresh, ttlOf, intelWithExtra } = require("./targeting");
const { defensiveBudgetOf, DEFENSIVE_TYPES } = require("./defenseBudget");

const IDLE = "IDLE";
const ACTIVE = "ACTIVE";
const BLOCKADE_KIND = "blockade";
const BLOCKADE_TYPE = "blockade";
const DEFENSE_TYPE = "defense";
const OPEN_OPERATION_STATES = Object.freeze(["PLANNED", "ACTIVE"]);

const byFleetId = (a, b) => (a.fleetId < b.fleetId ? -1 : (a.fleetId > b.fleetId ? 1 : 0));

function planBorderPosts(snapshot, supply, params, used, room, opts) {
  const intents = [];
  const notes = [];
  const out = () => ({ intents, notes });
  const P = params && params.borderPosts;
  if (!P || !(room >= 1)) return out();
  if (!snapshot.faction || snapshot.faction.status !== ACTIVE) return out();
  if (snapshot.fleetsTruncated === true || snapshot.operationsTruncated === true) return out();
  const d = snapshot.doctrine;
  if (!d || !Array.isArray(d.operationTypes) || !d.operationTypes.includes(DEFENSE_TYPE)) return out();
  const kind = (params.kinds || []).find((k) => k.kind === BLOCKADE_KIND);
  if (!kind) return out();
  if (!Array.isArray(snapshot.borderLine)) return out();

  const noted = new Set();
  const note = (n) => {
    if (!noted.has(n)) notes.push(n);
    noted.add(n);
  };
  const fleets = snapshot.fleets || [];
  const open = (snapshot.operations || []).filter((op) => OPEN_OPERATION_STATES.includes(op.state));
  const posts = open.filter((op) => op.operationType === BLOCKADE_TYPE);
  if (posts.length >= P.maxPerFaction) return out();
  const { cap, busy } = defensiveBudgetOf(fleets, open, P.defensiveSharePermille);
  if (!(cap > 0)) return out();
  if (busy >= cap) {
    note("BORDER_POST_CAPPED");
    return out();
  }
  const limit = Math.min(room, P.maxPerReview, P.maxPerFaction - posts.length, cap - busy);
  if (!(limit > 0)) return out();

  const at = snapshot.at;
  const intel = effectiveIntel({ ...snapshot, intel: intelWithExtra(snapshot), sightings: snapshot.sightings || [] });
  const fresh = (id) => {
    const seen = intel.get(id);
    return isFresh(seen, at, ttlOf(seen, params)) ? seen : null;
  };
  const isEnemy = (c) => Number.isSafeInteger(c) && typeof snapshot.isHostile === "function"
    && snapshot.isHostile(c) === true
    && (typeof snapshot.isPlaying !== "function" || snapshot.isPlaying(c) === true)
    && !(typeof snapshot.isHive === "function" && snapshot.isHive(c) === true);
  const held = new Set(posts.map((op) => op.targetSystemId));
  const launched = opts && opts.targets instanceof Set ? opts.targets : new Set();
  const classes = new Set(P.secClasses || []);
  const stationed = new Set((snapshot.stations || []).map((s) => s.systemId));

  const candidates = [];
  for (const e of snapshot.borderLine) {
    if (!e || !Number.isSafeInteger(e.systemId) || !classes.has(e.secClass) || held.has(e.systemId)
      || launched.has(e.systemId)) continue;
    let enemyStrength = 0;
    let enemies = 0;
    for (const n of e.neighbours || []) {
      const seen = fresh(n.systemId);
      const strength = seen && seen.hostileStrength > 0 ? seen.hostileStrength : 0;
      const hostile = isEnemy(n.controllerFactionId);
      if (!hostile && strength <= 0) continue;
      enemyStrength += strength;
      if (hostile) enemies += 1;
    }
    if (enemies === 0 && enemyStrength <= 0) continue;
    candidates.push({ systemId: e.systemId, enemyStrength, enemies, station: stationed.has(e.systemId) ? 0 : 1 });
  }
  candidates.sort((a, b) => b.enemyStrength - a.enemyStrength || b.enemies - a.enemies || a.station - b.station
    || a.systemId - b.systemId);

  const roles = new Set(kind.fleetRoles || []);
  const pool = fleets.filter((x) => x.state === IDLE && (x.operationId === null || x.operationId === undefined)
    && x.refitPending !== true && Number.isSafeInteger(x.systemId) && roles.has(x.fleetRole)
    && x.shipCount >= P.minShips).sort(byFleetId);
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
          note("BORDER_POST_NO_IDLE_SINCE");
          continue;
        }
        if (at - x.updatedAt < P.idleMs) continue;
      }
      if (best === null || jumps < best.jumps) best = { fleet: x, jumps };
    }
    if (best === null) continue;
    const x = best.fleet;
    const inPost = fresh(c.systemId);
    if (inPost && inPost.hostileStrength > (x.strength || 0) * P.maxEnemyRatio) {
      note("BORDER_POST_TOO_STRONG");
      continue;
    }
    intents.push({ type: "LAUNCH", kind: BLOCKADE_KIND, target: { kind: "system", systemId: c.systemId, ref: null },
      originSystemId: x.systemId, fleets: [{ fleetId: x.fleetId, expectedVersion: x.version }], mobilize: [],
      dueAt: at + P.windowMs });
    notes.push(`BORDER_POST:${c.systemId}`);
    used.add(x.fleetId);
  }
  return out();
}

module.exports = { planBorderPosts, DEFENSIVE_TYPES };
