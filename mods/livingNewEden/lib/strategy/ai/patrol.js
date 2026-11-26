"use strict";

const { bfs } = require("./bfs");
const { effectiveIntel, isFresh, ttlOf, describe } = require("./targeting");
const { gateOn, cooledOf } = require("./attackLossGate");
const { gateOn: transitGateOn, riskOf, skippedByRisk } = require("./transitRiskGate");

const IDLE = "IDLE";
const ACTIVE = "ACTIVE";
const STABLE = "STABLE";
const PATROL_KIND = "patrol";
const PICKET_KIND = "picket";
const PATROL_OPERATION_TYPE = "patrol";
const GARRISON_ROLE = "garrison";
const SCOUT_ROLE = "scout";
const PATROL_ROLE = "patrol";
const GARRISON_RETURN = "GARRISON_RETURN";
const OPEN_OPERATION_STATES = Object.freeze(["PLANNED", "ACTIVE"]);
const MOVING_STATES = Object.freeze(["TRAVELLING", "RETREATING"]);
const EMPTY_MAP = new Map();
const EMPTY_SET = new Set();

const PICKET_OBJECTIVE = "scout";

const byFleetId = (a, b) => (a.fleetId < b.fleetId ? -1 : (a.fleetId > b.fleetId ? 1 : 0));

function isPicketOperation(op) {
  return Boolean(op) && op.operationType === PATROL_OPERATION_TYPE && op.objective === PICKET_OBJECTIVE;
}

function garrisonSystemOf(x, openOps, posts) {
  const op = x.operationId !== null ? openOps.get(x.operationId) : undefined;
  if (!op) return x.systemId;
  return op.operationType === PATROL_OPERATION_TYPE && posts.has(op.originSystemId) ? op.originSystemId
    : op.targetSystemId;
}

function returnPostsOf(systemId, snapshot, params, ctx) {
  if (ctx.posts.has(systemId) || ctx.claims.has(systemId) || ctx.homes.has(systemId)) return null;
  const dist = bfs([systemId], snapshot.neighbors, { maxJumps: params.maxAssemblyJumps,
    maxSystems: params.maxBfsSystems });
  const posts = [...ctx.posts].filter((id) => dist.has(id)).sort((a, b) => dist.get(a) - dist.get(b) || a - b);
  if (posts.length === 0 || dist.get(posts[0]) > params.patrol.garrisonMaxJumps) return null;
  return { posts, dist };
}

function returnTargetOf(r, count, P) {
  const short = r.posts.find((id) => (count.get(id) || 0) < P.garrisonFleetsTarget);
  return short !== undefined ? short : r.posts.find((id) => (count.get(id) || 0) < P.maxGarrisonsPerPost);
}

function returnContext(snapshot, supply) {
  const territory = Array.isArray(snapshot.territory) && snapshot.territoryTruncated !== true
    ? snapshot.territory.map((t) => t.systemId) : [];
  const own = (snapshot.occupations || []).filter((o) => o.occupier === snapshot.factionId && o.state !== STABLE);
  const claims = new Set(own.map((o) => o.systemId));
  const homeClaims = new Set(own.filter((o) => o.homeOwn === true).map((o) => o.systemId));
  const home = snapshot.faction ? snapshot.faction.homeSystemId : null;
  const homes = new Set([...((supply && supply.stationSystems) || []),
    ...(snapshot.stations || []).map((s) => s.systemId), ...(Number.isSafeInteger(home) ? [home] : [])]);
  return { posts: new Set(territory), claims, homeClaims, homes };
}

function planPatrols(snapshot, supply, params, used, room, opts) {
  const intents = [];
  const notes = [];
  const out = () => ({ intents, notes });
  const P = params && params.patrol;
  if (!P || !(room > 0)) return out();
  if (!snapshot.faction || snapshot.faction.status !== ACTIVE) return out();
  if (snapshot.fleetsTruncated === true || snapshot.operationsTruncated === true) return out();
  const d = snapshot.doctrine;
  if (!d || !Array.isArray(d.operationTypes) || !d.operationTypes.includes(PATROL_OPERATION_TYPE)) return out();
  const kinds = params.kinds || [];
  const patrolKind = kinds.find((k) => k.kind === PATROL_KIND);
  const picketKind = kinds.find((k) => k.kind === PICKET_KIND);
  if (!patrolKind || !picketKind) return out();

  const f = snapshot.factionId;
  const fleets = snapshot.fleets || [];
  const operations = snapshot.operations || [];
  const open = operations.filter((op) => OPEN_OPERATION_STATES.includes(op.state));
  const openOps = new Map(open.map((op) => [op.operationId, op]));
  const launched = opts && opts.targets instanceof Set ? opts.targets : new Set();
  const opTargets = new Set([...open.map((op) => op.targetSystemId), ...launched]);
  const intel = effectiveIntel({ ...snapshot, intel: snapshot.intel || [], sightings: snapshot.sightings || [] });
  const taken = new Set();
  const noted = new Set();
  const note = (n) => {
    if (!noted.has(n)) notes.push(n);
    noted.add(n);
  };
  const idleOf = (x) => x.state === IDLE && x.operationId === null && x.refitPending !== true && !used.has(x.fleetId)
    && Number.isSafeInteger(x.systemId);
  const restedOf = (x) => {
    if (!Number.isSafeInteger(x.updatedAt)) {
      note("PATROL_NO_IDLE_SINCE");
      return false;
    }
    return snapshot.at - x.updatedAt >= P.idleMs;
  };
  const oldest = (ids) => ids.sort((a, b) => {
    const ia = intel.get(a);
    const ib = intel.get(b);
    const oa = ia ? ia.observedAt : -Infinity;
    const ob = ib ? ib.observedAt : -Infinity;
    return oa === ob ? a - b : (oa < ob ? -1 : 1);
  })[0];
  const launch = (x, kind, target, extra) => {
    intents.push({ type: "LAUNCH", kind: kind.kind, target: { kind: "system", systemId: target, ref: null },
      originSystemId: x.systemId, fleets: [{ fleetId: x.fleetId, expectedVersion: x.version }], mobilize: [],
      dueAt: snapshot.at + P.windowMs, ...extra });
    notes.push(`PATROL:${target}`);
    used.add(x.fleetId);
  };
  const full = () => intents.length >= room;

  const ctx = returnContext(snapshot, supply);
  const posts = ctx.posts;
  const sent = opts && opts.dispatched instanceof Map ? opts.dispatched : EMPTY_MAP;
  const count = new Map();
  for (const x of fleets) {
    if (x.fleetRole !== GARRISON_ROLE) continue;
    const at = sent.has(x.fleetId) ? sent.get(x.fleetId) : garrisonSystemOf(x, openOps, posts);
    count.set(at, (count.get(at) || 0) + 1);
  }
  const garrisons = posts.size > 0 ? fleets.filter((x) => x.fleetRole === GARRISON_ROLE && idleOf(x)).sort(byFleetId)
    : [];
  const sysOf = new Map((snapshot.systems || []).map((s) => [s.systemId, s]));
  const reach = supply && supply.reach instanceof Map ? supply.reach : new Map();
  const fronts = new Set((supply && supply.frontTargets) || []);
  const standing = new Set(fleets.filter((x) => !MOVING_STATES.includes(x.state)).map((x) => x.systemId));
  const lossCooled = gateOn(snapshot, params) ? cooledOf(snapshot) : EMPTY_SET;
  const transitGate = transitGateOn(snapshot, params);
  const sortieTargetOf = (x, ids) => {
    if (!transitGate) return oldest(ids);
    const pool = [...ids];
    oldest(pool);
    for (const t of pool) {
      const r = riskOf(snapshot, x.systemId, t, { fleetRole: x.fleetRole, shipCount: x.shipCount,
        operationType: patrolKind.operationType });
      if (!skippedByRisk(r, params.transitRisk)) return t;
      note("TRANSIT_RISK_SKIP");
    }
    return undefined;
  };

  for (const x of garrisons) {
    if (full()) return out();
    const r = returnPostsOf(x.systemId, snapshot, params, ctx);
    if (r === null) {
      if (!posts.has(x.systemId) && !ctx.claims.has(x.systemId) && !ctx.homes.has(x.systemId)) {
        note("PATROL_OUT_OF_RANGE");
      }
      continue;
    }
    const target = returnTargetOf(r, count, P);
    if (target === undefined) {
      note("PATROL_POSTS_FULL");
      continue;
    }
    count.set(target, (count.get(target) || 0) + 1);
    launch(x, patrolKind, target, { purpose: GARRISON_RETURN });
  }

  const hive = d.hive === true;
  if (P.roleMaxJumps > 0 && (d.returnToBase !== true || hive) && d.confinedToBelt !== true) {
    const isEnemy = (c) => typeof snapshot.isHostile === "function" && snapshot.isHostile(c) === true
      && (typeof snapshot.isPlaying !== "function" || snapshot.isPlaying(c) === true)
      && !(typeof snapshot.isHive === "function" && snapshot.isHive(c) === true);
    const roleOpts = { maxJumps: P.roleMaxJumps, maxSystems: params.maxBfsSystems };
    for (const x of fleets.filter((y) => y.fleetRole === PATROL_ROLE && idleOf(y)).sort(byFleetId)) {
      if (full()) return out();
      if (hive && ctx.homeClaims.has(x.systemId)) continue;
      if (!restedOf(x)) continue;
      const dist = bfs([x.systemId], snapshot.neighbors, roleOpts);
      const ranked = [[], [], []];
      for (const id of dist.keys()) {
        if (dist.get(id) === 0 || !reach.has(id) || fronts.has(id) || opTargets.has(id) || taken.has(id)
          || standing.has(id) || lossCooled.has(id)) continue;
        const s = sysOf.get(id);
        if (!s || s.hostileStations > 0) continue;
        const c = s.controllerFactionId;
        const rank = c === null ? 1 : (c === f ? 2 : (isEnemy(c) ? 0 : -1));
        if (rank < 0 || (hive && rank > 0)) continue;
        if (P.hostileNeedsFreshIntel === true && rank === 0) {
          const facts = describe(snapshot, params, intel, id);
          if (!facts.fresh) {
            note("PATROL_HOSTILE_UNKNOWN");
            continue;
          }
          if (facts.enemyStrength > (x.strength || 0) * P.roleMaxEnemyRatio) continue;
          ranked[0].push(id);
          continue;
        }
        const seen = intel.get(id);
        if (isFresh(seen, snapshot.at, ttlOf(seen, params))
          && seen.hostileStrength > (x.strength || 0) * P.roleMaxEnemyRatio) continue;
        ranked[rank].push(id);
      }
      const ids = ranked.find((group) => group.length > 0);
      if (!ids) {
        note("PATROL_NO_TARGET");
        continue;
      }
      const target = sortieTargetOf(x, ids);
      if (target === undefined) {
        note("PATROL_NO_TARGET");
        continue;
      }
      taken.add(target);
      launch(x, patrolKind, target, {});
    }
  }

  const sortieOpts = { maxJumps: P.garrisonMaxJumps, maxSystems: params.maxBfsSystems };
  for (const x of garrisons) {
    if (full()) return out();
    if (!posts.has(x.systemId) || used.has(x.fleetId)) continue;
    if (!(x.shipCount >= P.minShips) || !restedOf(x)) continue;
    const dist = bfs([x.systemId], snapshot.neighbors, sortieOpts);
    const ids = [...dist.keys()].filter((id) => {
      if (dist.get(id) === 0 || posts.has(id) || ctx.homes.has(id) || ctx.claims.has(id) || opTargets.has(id)
        || taken.has(id) || lossCooled.has(id)) return false;
      const s = sysOf.get(id);
      return Boolean(s) && (s.controllerFactionId === f || s.controllerFactionId === null);
    });
    const target = ids.length === 0 ? undefined : sortieTargetOf(x, ids);
    if (target === undefined) {
      note("PATROL_NO_TARGET");
      continue;
    }
    taken.add(target);
    launch(x, patrolKind, target, {});
  }

  if (P.maxOpenPickets === 0) return out();
  const scoutOpts = { maxJumps: P.scoutMaxJumps, maxSystems: params.maxBfsSystems };
  const scouts = fleets.filter((y) => y.fleetRole === SCOUT_ROLE && idleOf(y)).sort(byFleetId);
  const byOpen = Number.isSafeInteger(P.maxOpenPickets)
    ? P.maxOpenPickets - open.filter(isPicketOperation).length : Infinity;
  const byReserve = Number.isSafeInteger(P.scoutReserve) ? scouts.length - P.scoutReserve : Infinity;
  const allowed = Math.max(0, Math.min(byOpen, byReserve));
  const capNote = byOpen <= byReserve ? "PATROL_PICKET_CAP" : "PATROL_SCOUT_RESERVE";
  let pickets = 0;
  const cooldown = new Set(snapshot.reconCooldowns || []);
  for (const x of scouts) {
    if (full()) return out();
    if (!restedOf(x)) continue;
    if (pickets >= allowed) {
      note(capNote);
      continue;
    }
    const dist = bfs([x.systemId], snapshot.neighbors, scoutOpts);
    const ids = [...dist.keys()].filter((id) => dist.get(id) > 0 && reach.has(id) && !standing.has(id)
      && !fronts.has(id) && !taken.has(id) && !launched.has(id) && !isFresh(intel.get(id), snapshot.at, ttlOf(intel.get(id), params))
      && !cooldown.has(id));
    if (ids.length === 0) {
      note("PATROL_NO_TARGET");
      continue;
    }
    const target = oldest(ids);
    taken.add(target);
    launch(x, picketKind, target, {});
    pickets += 1;
  }
  return out();
}

module.exports = { planPatrols, isPicketOperation, garrisonSystemOf, returnPostsOf, returnTargetOf, returnContext, PATROL_KIND, PICKET_KIND,
  GARRISON_RETURN };
