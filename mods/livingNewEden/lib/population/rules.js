"use strict";

const { createRng, deriveSeed } = require("../util/rng");
const { ARCHETYPE, INTENT, STATE, BANDS } = require("./schema");
const { ARCHETYPES } = require("./data/archetypes");
const { ATTRACT_BOOST, KIND_OF_ARCHETYPE, KIND_OF_INTENT } = require("./data/contextWeights");
const { hullPoolOf, routeSafePool } = require("./data/hullPools");
const { hullCountOf } = require("./lifecycle/schema");

const INTENT_TRIES = 3;
const CURRENT_REGION_SHARE = 0.5;
const ACTIVITY_INTENTS = Object.freeze([INTENT.MINE, INTENT.RAT, INTENT.EXPLORE]);

const careerOf = (S) => (S.lifecycle && S.lifecycle.career ? S.lifecycle.career : null);

const archOf = (p, S, table) => {
  const base = ARCHETYPES[p.archetype] || ARCHETYPES[ARCHETYPE.TRADER];
  const C = S ? careerOf(S) : null;
  if (!C || !table || !(p.career >= 1 && p.career <= 4)) return base;
  return C.archOf(ARCHETYPES[p.archetype] ? p.archetype : ARCHETYPE.TRADER, p.career, table.bandOf(p.homeId)) || base;
};

const careerHulls = (S, pool, career) => {
  if (!careerOf(S)) return pool;
  const n = hullCountOf(pool.length, career);
  return n >= pool.length ? pool : pool.slice(0, n);
};
const span = (min, max) => Math.max(0, max - min);

function dwellMs(S, rng) {
  return S.dwellMinMs + Math.floor(rng.nextFloat() * span(S.dwellMinMs, S.dwellMaxMs));
}

const lifeOf = (S) => (S.activeLife && S.activeLife.enabled === true ? S.activeLife : null);

function dockedDwell(S, base) {
  const L = lifeOf(S);
  if (!L) return base;
  return Math.max(L.dockDwellFloorMs, Math.floor((base * L.dockDwellPermille) / 1000));
}

function weightsOf(arch, p, S) {
  const L = lifeOf(S);
  if (!L || !L.weightsByArchetype) return arch.weights;
  return L.weightsByArchetype[ARCHETYPES[p.archetype] ? p.archetype : ARCHETYPE.TRADER] || arch.weights;
}

function hopMs(S, rng) {
  return S.hopMinMs + Math.floor(rng.nextFloat() * span(S.hopMinMs, S.hopMaxMs));
}

function pickWeighted(weights, rng) {
  let total = 0;
  for (const w of weights) total += w > 0 ? w : 0;
  if (!(total > 0)) return -1;
  let r = rng.nextFloat() * total;
  for (let i = 0; i < weights.length; i += 1) {
    const w = weights[i] > 0 ? weights[i] : 0;
    if (r < w) return i;
    r -= w;
  }
  return weights.length - 1;
}

function pickCumulative(cum, total, rng) {
  const r = rng.nextFloat() * total;
  let lo = 0;
  let hi = cum.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] > r) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

const pickOf = (list, rng) => list[Math.floor(rng.nextFloat() * list.length)];

const poolOf = (S, archetype, band) => (S.hulls && S.hulls.enabled === true ? hullPoolOf(archetype, band)
  : (ARCHETYPES[archetype] || ARCHETYPES[ARCHETYPE.TRADER]).hulls);

const safePoolOf = (S, pool, band) => (S.hulls && S.hulls.enabled === true
  ? routeSafePool(pool, band, S.hulls.avoidSecClasses) : pool);

function seedPilot(pilotId, worldSeed, table, S, nowMs) {
  const rng = createRng(deriveSeed(worldSeed, "pop-seed", pilotId));
  const usable = S.bandPermille.map((w, b) => (table.homes[b].total > 0 ? w : 0));
  let b = pickWeighted(usable, rng);
  if (b < 0) b = table.homes.findIndex((h) => h.total > 0);
  if (b < 0) return { ok: false, reason: "NO_HOME" };
  const homes = table.homes[b];
  const homeId = table.systemIds[homes.idx[pickCumulative(homes.cum, homes.total, rng)]];
  const a = pickWeighted(S.archetypePermille, rng);
  const archetype = a >= 0 ? a + 1 : ARCHETYPE.TRADER;
  const pool = poolOf(S, archetype, BANDS[b]);
  const safe = safePoolOf(S, pool, BANDS[b]);
  const shipTypeId = pickOf(safe.length > 0 ? safe : pool, rng);
  return { ok: true, row: { pilotId, systemId: homeId, prevId: 0, destId: 0, homeId, shipTypeId, archetype,
    intent: INTENT.DOCK, state: STATE.DOCKED, seq: 0, sinceAt: nowMs,
    dueAt: nowMs + Math.floor(rng.nextFloat() * S.dwellMaxMs), flags: 0 } };
}

const contextOf = (opts) => (opts && opts.context ? opts.context : null);
const noteOf = (opts, name) => {
  if (opts && typeof opts.note === "function") opts.note(name);
};

const standingOf = (opts, cx) => (cx && opts && opts.standing ? opts.standing : null);

function routeAllowed(st, route, prof, homeId, opts) {
  const out = { friendly: 0 };
  if (st.hostileOnRoute(route, prof, homeId, out) > 0) {
    noteOf(opts, "standing.routeRefused");
    return false;
  }
  if (out.friendly) noteOf(opts, "standing.friendlyPass");
  return true;
}

const minable = (cx, sys) => !cx || sys === null || cx.hasBelts(sys.systemId) !== false;

function feasible(intent, sys, arch, cx) {
  if (intent === INTENT.RESHIP) return sys !== null && sys.stations > 0;
  if (intent === INTENT.MINE && !minable(cx, sys)) return false;
  if (ACTIVITY_INTENTS.includes(intent)) return sys !== null && arch.bands.includes(sys.band);
  return true;
}

function pickSafeStationSystem(list, table, arch, currentId, rng, cx, S, ps) {
  if (!list || list.length === 0) return 0;
  const weightOf = ps ? (id) => ps.st.weightForProfile(id, ps.prof, ps.homeId, S.context.dangerAvoidPermille)
    : (id) => Math.max(0, 1000 - (cx.dangerOf(id) * S.context.dangerAvoidPermille) / 1000);
  let total = 0;
  for (const id of list) {
    if (id === currentId || !arch.bands.includes(table.bandOf(id))) continue;
    total += weightOf(id);
  }
  if (!(total > 0)) return pickStationSystem(list, table, arch, currentId, rng);
  let r = rng.nextFloat() * total;
  let last = 0;
  for (const id of list) {
    if (id === currentId || !arch.bands.includes(table.bandOf(id))) continue;
    const w = weightOf(id);
    if (w <= 0) continue;
    last = id;
    if (r < w) return id;
    r -= w;
  }
  return last;
}

function pickStationSystem(list, table, arch, currentId, rng) {
  if (!list || list.length === 0) return 0;
  let count = 0;
  for (const id of list) if (id !== currentId && arch.bands.includes(table.bandOf(id))) count += 1;
  if (count === 0) return 0;
  let k = Math.floor(rng.nextFloat() * count);
  for (const id of list) {
    if (id === currentId || !arch.bands.includes(table.bandOf(id))) continue;
    if (k === 0) return id;
    k -= 1;
  }
  return 0;
}

function hubOutOfReach(p, table, S) {
  const i = table.indexOf.get(p.systemId);
  const jumps = i === undefined ? -1 : table.hubJumps[i];
  return jumps < 0 || jumps > S.maxTripJumps;
}

function pickDestination(p, sys, table, S, rng, arch, opts, ps) {
  if (opts && typeof opts.attract === "function") {
    const live = opts.attract(p, rng, arch);
    if (live > 0 && live !== p.systemId) return live;
  }
  const cx = contextOf(opts);
  const kind = cx ? KIND_OF_ARCHETYPE[p.archetype] : undefined;
  if (kind !== undefined && S.context.attractPermille > 0 && rng.nextFloat() * 1000 < S.context.attractPermille) {
    const dest = pickStationSystem(cx.attractList(kind, sys ? sys.regionId : 0), table, arch, p.systemId, rng);
    if (dest !== 0) {
      noteOf(opts, "context.attractedDest");
      return dest;
    }
  }
  const pick = cx ? (list) => pickSafeStationSystem(list, table, arch, p.systemId, rng, cx, S, ps)
    : (list) => pickStationSystem(list, table, arch, p.systemId, rng);
  if (rng.nextFloat() * 1000 < S.hubPermille) {
    if (lifeOf(S) && hubOutOfReach(p, table, S)) {
      noteOf(opts, "activeLife.hubSkipped");
    } else {
      const hub = pick(table.hubIds);
      if (hub !== 0) return hub;
    }
  }
  const home = table.sys(p.homeId);
  const regionId = rng.nextFloat() < CURRENT_REGION_SHARE || !home ? (sys ? sys.regionId : 0) : home.regionId;
  const dest = pick(table.stationSystemsByRegion.get(regionId));
  if (dest !== 0) return dest;
  return p.homeId !== p.systemId ? p.homeId : 0;
}

function activityOf(arch, sys, rng, cx) {
  const weightOf = (i) => {
    if (!cx) return arch.weights[i - 1];
    if (i === INTENT.MINE && !minable(cx, sys)) return 0;
    return sys && cx.attracts(sys.systemId, KIND_OF_INTENT[i]) ? arch.weights[i - 1] * ATTRACT_BOOST
      : arch.weights[i - 1];
  };
  const weights = ACTIVITY_INTENTS.map((i) => (sys && arch.bands.includes(sys.band) ? weightOf(i) : 0));
  const k = rng ? pickWeighted(weights, rng) : -1;
  if (k >= 0) return ACTIVITY_INTENTS[k];
  let best = INTENT.EXPLORE;
  let bestW = 0;
  for (const i of ACTIVITY_INTENTS) {
    if (weightOf(i) > bestW) {
      best = i;
      bestW = weightOf(i);
    }
  }
  return best;
}

function hasActivityIn(arch, sys, cx) {
  if (!arch.bands.includes(sys.band)) return false;
  return ACTIVITY_INTENTS.some((i) => arch.weights[i - 1] > 0 && (i !== INTENT.MINE || minable(cx, sys)));
}

function dwellInPlace(p, table, S, rng, nowMs, opts) {
  const sys = table.sys(p.systemId);
  if (!sys) {
    return { next: { systemId: p.homeId, prevId: 0, destId: 0, intent: INTENT.DOCK, state: STATE.DOCKED,
      dueAt: nowMs + dockedDwell(S, dwellMs(S, rng)) } };
  }
  const docked = sys.stations > 0;
  if (docked && lifeOf(S)) {
    const arch = archOf(p, S, table);
    const cx = contextOf(opts);
    if (hasActivityIn(arch, sys, cx)) {
      noteOf(opts, "activeLife.noRouteInSpace");
      const intent = activityOf(arch, sys, rng, cx);
      return { next: { destId: 0, intent, state: STATE.ACTIVE, dueAt: nowMs + dwellMs(S, rng) } };
    }
    return { next: { destId: 0, intent: INTENT.DOCK, state: STATE.DOCKED,
      dueAt: nowMs + dockedDwell(S, dwellMs(S, rng)) } };
  }
  return { next: { destId: 0,
    intent: docked ? INTENT.DOCK : activityOf(archOf(p, S, table), sys, null, contextOf(opts)),
    state: docked ? STATE.DOCKED : STATE.ACTIVE, dueAt: nowMs + dwellMs(S, rng) } };
}

function podRespawn(p, S, rng, nowMs, table) {
  const homeBand = table && S.hulls && S.hulls.enabled === true ? table.bandOf(p.homeId) : null;
  const hulls = safePoolOf(S, careerHulls(S, poolOf(S, p.archetype, homeBand), p.career), homeBand);
  const others = hulls.filter((h) => h !== p.shipTypeId);
  const shipTypeId = hulls.length === 0 ? p.shipTypeId : pickOf(others.length > 0 ? others : hulls, rng);
  return { next: { systemId: p.homeId, prevId: 0, destId: 0, shipTypeId,
    intent: INTENT.RESHIP, state: STATE.DOCKED, dueAt: nowMs + dockedDwell(S, S.dwellMinMs) } };
}

function killed(p, S, nowMs) {
  return { next: { destId: 0, state: STATE.POD, dueAt: nowMs + S.live.cloneDelayMs } };
}

function rollIntent(p, table, S, rng, findRoute, nowMs, opts) {
  const arch = archOf(p, S, table);
  const sys = table.sys(p.systemId);
  const cx = contextOf(opts);
  const docked = sys !== null && sys.stations > 0;
  if (cx && p.state === STATE.DOCKED && docked) {
    const stay = ((1000 - cx.hourPermille(nowMs)) * S.context.hourWeightPermille) / 1000;
    if (stay > 0 && rng.nextFloat() * 1000 < stay) {
      noteOf(opts, "context.stayedDocked");
      return { ok: true, next: { intent: INTENT.DOCK, state: STATE.DOCKED, destId: 0,
        dueAt: nowMs + dockedDwell(S, dwellMs(S, rng)) } };
    }
  }
  let intent = INTENT.DOCK;
  const st = standingOf(opts, cx);
  const ps = st ? { st, prof: st.profileOf(p.pilotId), homeId: p.homeId } : null;
  const danger = ps ? st.dangerForProfile(p.systemId, ps.prof, p.homeId) : cx ? cx.dangerOf(p.systemId) : 0;
  const retreat = cx ? (danger * S.context.dangerRetreatPermille) / 1000 : 0;
  const retreating = retreat > 0 && rng.nextFloat() * 1000 < retreat;
  if (retreating) noteOf(opts, "context.retreats");
  for (let t = 0; t < INTENT_TRIES && !retreating; t += 1) {
    const k = pickWeighted(weightsOf(arch, p, S), rng);
    if (k >= 0 && feasible(k + 1, sys, arch, cx)) {
      intent = k + 1;
      break;
    }
  }
  const C = careerOf(S);
  const hulls = intent !== INTENT.RESHIP ? null : S.hulls && S.hulls.enabled === true
    ? safePoolOf(S, careerHulls(S, hullPoolOf(p.archetype, table.bandOf(p.homeId)), p.career), table.bandOf(p.systemId))
    : careerHulls(S, arch.hulls, p.career);
  if (intent === INTENT.RESHIP && cx && !C) {
    const tier = Math.min(hulls.length - 1, Math.floor(p.seq / S.context.reshipTierEverySeq));
    const others = hulls.slice(0, tier + 1).filter((h) => h !== p.shipTypeId);
    const shipTypeId = others.length > 0 ? pickOf(others, rng) : p.shipTypeId;
    return { ok: true, next: { shipTypeId, intent, state: STATE.DOCKED, destId: 0,
      dueAt: nowMs + dockedDwell(S, S.dwellMinMs) } };
  }
  if (intent === INTENT.RESHIP) {
    const others = hulls.filter((h) => h !== p.shipTypeId);
    const shipTypeId = others.length > 0 ? pickOf(others, rng) : p.shipTypeId;
    return { ok: true, next: { shipTypeId, intent, state: STATE.DOCKED, destId: 0,
      dueAt: nowMs + dockedDwell(S, S.dwellMinMs) } };
  }
  if (intent === INTENT.DOCK && sys !== null && sys.stations > 0) {
    return { ok: true, next: { intent, state: STATE.DOCKED, destId: 0, dueAt: nowMs + dockedDwell(S, dwellMs(S, rng)) } };
  }
  if (ACTIVITY_INTENTS.includes(intent)) {
    return { ok: true, next: { intent, state: STATE.ACTIVE, destId: 0, dueAt: nowMs + dwellMs(S, rng) } };
  }
  const destId = intent === INTENT.DOCK ? (p.homeId !== p.systemId ? p.homeId : 0)
    : pickDestination(p, sys, table, S, rng, arch, opts, ps);
  if (!destId) return { ok: false, reason: "NO_ROUTE" };
  if (ps && ps.st.weightForProfile(destId, ps.prof, p.homeId, 0) === 0) {
    noteOf(opts, "standing.routeRefused");
    return { ok: false, reason: "NO_ROUTE" };
  }
  const r = findRoute(p.systemId, destId);
  if (!r || r.ok !== true) return { ok: false, reason: r && r.reason === "ROUTE_BUDGET" ? "ROUTE_BUDGET" : "NO_ROUTE" };
  if (!r.route || r.route.length < 2 || r.route.length - 1 > S.maxTripJumps) return { ok: false, reason: "NO_ROUTE" };
  if (ps && !routeAllowed(st, r.route, ps.prof, p.homeId, opts)) return { ok: false, reason: "NO_ROUTE" };
  return { ok: true, route: r.route,
    next: { intent, state: STATE.TRAVEL, destId, dueAt: nowMs + hopMs(S, rng) } };
}

function arrive(p, systemId, prevId, table, S, rng, nowMs, opts) {
  const sys = table.sys(systemId);
  const docked = sys !== null && sys.stations > 0;
  const intent = docked ? INTENT.DOCK : activityOf(archOf(p, S, table), sys, rng, contextOf(opts));
  const base = rng ? dwellMs(S, rng) : S.dwellMinMs;
  return { systemId, prevId, destId: 0, intent, state: docked ? STATE.DOCKED : STATE.ACTIVE,
    dueAt: nowMs + (docked ? dockedDwell(S, base) : base) };
}

function hop(p, rs, nowMs, S, rng, table, opts) {
  const at = rs.at + 1;
  const systemId = rs.route[at];
  if (systemId === p.destId || at >= rs.route.length - 1) {
    return { next: arrive(p, systemId, p.systemId, table, S, rng, nowMs, opts), at, arrived: true };
  }
  return { next: { systemId, prevId: p.systemId, dueAt: nowMs + hopMs(S, rng) }, at, arrived: false };
}

function fastForward(p, rs, nowMs, S, table, opts) {
  const hops = Math.max(1, Math.floor((nowMs - p.sinceAt) / S.hopMeanMs));
  if (!rs || !rs.route || rs.route[rs.at] !== p.systemId) {
    return { next: arrive(p, p.destId, p.systemId, table, S, null, nowMs, opts), hops, at: 0, arrived: true };
  }
  const last = rs.route.length - 1;
  const at = Math.min(last, rs.at + hops);
  const systemId = rs.route[at];
  const prevId = rs.route[at - 1];
  if (at >= last || systemId === p.destId) {
    return { next: arrive(p, systemId, prevId, table, S, null, nowMs, opts), hops: at - rs.at, at, arrived: true };
  }
  return { next: { systemId, prevId, dueAt: nowMs + S.hopMinMs }, hops: at - rs.at, at, arrived: false };
}

module.exports = { BANDS, seedPilot, rollIntent, hop, fastForward, dwellInPlace, podRespawn, killed, dwellMs, hopMs,
  pickWeighted, dockedDwell, weightsOf, routeAllowed,
  pickCumulative, poolOf, safePoolOf,
  archOf, careerHulls };
