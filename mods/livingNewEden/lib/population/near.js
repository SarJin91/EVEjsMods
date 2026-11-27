"use strict";

const { createRng, deriveSeed } = require("../util/rng");
const { pickName } = require("../names");
const S_ = require("./schema");

const { TIER, TIER_NAMES, SUBSTATE, STATE, FLAG_NEAR, SUBSTATE_SHIFT, SUBSTATE_MASK, PREWARM_MASK } = S_;
const NAME_STYLES = Object.freeze(["caldari", "minmatar", "amarr", "gallente"]);
const GENDERS = Object.freeze(["Male", "Female"]);
const ARRIVALS_DEFAULT_LIMIT = 50;
const EMPTY = Object.freeze([]);
const RING_ARRIVE = 1;
const RING_DEPART = 2;
const ARRIVE_ONLY = Object.freeze([RING_ARRIVE]);
const BOTH_KINDS = Object.freeze([RING_ARRIVE, RING_DEPART]);

function safeCall(fn, fallback = null) {
  try {
    return fn();
  } catch (_err) {
    return fallback;
  }
}

function substateOf(p, nowMs, S) {
  if (p.state === STATE.DOCKED) return p.dueAt - nowMs <= S.hopMinMs ? SUBSTATE.UNDOCKING : SUBSTATE.DOCKED;
  if (p.state === STATE.TRAVEL) return SUBSTATE.AT_GATE;
  return SUBSTATE.IN_SPACE;
}

function displayNameOf(worldSeed, pilotId) {
  const rng = createRng(deriveSeed(worldSeed, "pop-name", pilotId));
  const style = NAME_STYLES[Math.floor(rng.nextFloat() * NAME_STYLES.length)];
  const gender = GENDERS[Math.floor(rng.nextFloat() * GENDERS.length)];
  const r = pickName({ worldSeed, entityKey: `pop:${pilotId}`, style, nicknames: false, gender,
    isTaken: () => false, maxAttempts: 1 });
  return r.ok ? r.name : null;
}

function createNearLayer(deps) {
  const { S, worldSeed, pilots, bump } = deps;
  const N = S.near;
  let tiers = new Map();
  let seenVersion = null;
  let refreshes = 0;
  const listeners = new Set();
  const queued = new Uint8Array(pilots.capacity + 1);
  let pending = [];
  let head = 0;
  const ringSize = Math.max(1, N.arrivalRingSize);
  const ringSys = new Int32Array(ringSize);
  const ringPilot = new Int32Array(ringSize);
  const ringFrom = new Int32Array(ringSize);
  const ringAt = new Float64Array(ringSize);
  const ringKind = new Uint8Array(ringSize);
  const departures = deps.departures === true;
  let ringNext = 0;
  let ringCount = 0;
  const activityIntents = new Set(Array.isArray(deps.activityIntents)
    ? deps.activityIntents.filter((c) => Number.isInteger(c) && c > 0) : EMPTY);
  const activityOn = activityIntents.size > 0;
  const activityRingSize = activityOn ? Math.max(1, N.activityRingSize | 0) : 0;
  const actSys = new Int32Array(activityRingSize);
  const actPilot = new Int32Array(activityRingSize);
  const actAt = new Float64Array(activityRingSize);
  const actIntent = new Uint8Array(activityRingSize);
  let actNext = 0;
  let actCount = 0;
  const names = new Map();
  let prewarmedTotal = 0;

  const tierCode = (systemId) => tiers.get(systemId) || TIER.FAR;

  function enqueue(id) {
    if (queued[id]) return;
    queued[id] = 1;
    pending.push(id);
  }

  function clearBits(id) {
    const f = pilots.flagsOf(id);
    if (f & PREWARM_MASK) pilots.setFlags(id, f & ~PREWARM_MASK);
  }

  function emit(change) {
    for (const cb of listeners) safeCall(() => cb(change));
  }

  function refresh() {
    const presence = safeCall(deps.getPresence);
    if (!presence || typeof presence.getVersion !== "function") return false;
    const version = safeCall(() => presence.getVersion(), null);
    if (version === null || version === seenVersion) return false;
    const within = safeCall(() => presence.observedWithin(N.nearJumps), null);
    const observed = safeCall(() => presence.observedSystems(), null);
    if (!within || within.ok !== true || !Array.isArray(within.systems) || !Array.isArray(observed)) return false;
    seenVersion = version;
    refreshes += 1;
    bump("tierRefreshes");
    const next = new Map();
    for (const [id] of within.systems) next.set(id, TIER.NEAR);
    for (const id of observed) next.set(id, TIER.LIVE);
    const changes = [];
    for (const [id, t] of next) {
      const old = tiers.get(id) || TIER.FAR;
      if (old === t) continue;
      changes.push(Object.freeze({ systemId: id, from: TIER_NAMES[old], to: TIER_NAMES[t] }));
      if (old === TIER.FAR) for (const pilotId of pilots.idsIn(id)) enqueue(pilotId);
    }
    for (const [id, old] of tiers) {
      if (next.has(id)) continue;
      changes.push(Object.freeze({ systemId: id, from: TIER_NAMES[old], to: TIER_NAMES[TIER.FAR] }));
      for (const pilotId of pilots.idsIn(id)) clearBits(pilotId);
    }
    tiers = next;
    if (changes.length > 0) emit(Object.freeze({ version, changes: Object.freeze(changes) }));
    return true;
  }

  const identityOf = typeof deps.identityOf === "function" ? deps.identityOf : (id) => id;

  function nameOf(id) {
    const key = identityOf(id);
    if (names.has(key)) {
      const name = names.get(key);
      names.delete(key);
      names.set(key, name);
      return name;
    }
    const name = displayNameOf(worldSeed, key);
    names.set(key, name);
    if (names.size > N.nameCacheSize) names.delete(names.keys().next().value);
    return name;
  }

  function prewarm(p, nowMs) {
    pilots.setFlags(p.pilotId, (p.flags & ~PREWARM_MASK) | FLAG_NEAR | (substateOf(p, nowMs, S) << SUBSTATE_SHIFT));
    nameOf(p.pilotId);
    prewarmedTotal += 1;
    bump("prewarmed");
  }

  function prewarmPass(nowMs) {
    let done = 0;
    while (head < pending.length && done < N.maxPrewarmPerPass) {
      const id = pending[head];
      head += 1;
      queued[id] = 0;
      const p = pilots.get(id);
      if (!p || tierCode(p.systemId) === TIER.FAR || (p.flags & FLAG_NEAR)) continue;
      prewarm(p, nowMs);
      done += 1;
    }
    if (head < pending.length) bump("deferred.PREWARM_BUDGET");
    if (head > 0 && head * 2 >= pending.length) {
      pending = pending.slice(head);
      head = 0;
    }
    return done;
  }

  function recordArrival(systemId, pilotId, fromId, at, kind = RING_ARRIVE) {
    ringSys[ringNext] = systemId;
    ringPilot[ringNext] = pilotId;
    ringFrom[ringNext] = fromId;
    ringAt[ringNext] = at;
    ringKind[ringNext] = kind;
    ringNext = (ringNext + 1) % ringSize;
    if (ringCount < ringSize) ringCount += 1;
  }

  function recordActivity(systemId, pilotId, at, intent) {
    actSys[actNext] = systemId;
    actPilot[actNext] = pilotId;
    actAt[actNext] = at;
    actIntent[actNext] = intent;
    actNext = (actNext + 1) % activityRingSize;
    if (actCount < activityRingSize) actCount += 1;
  }

  function noteActivity(p, id, fromId, jumped, nowMs, fromState, fromIntent) {
    if (jumped || p.systemId !== fromId || p.state !== STATE.ACTIVE || !activityIntents.has(p.intent)) return;
    if (fromState === STATE.DOCKED) {
      recordActivity(p.systemId, id, nowMs, p.intent);
      bump("near.activityEvents");
    } else if (fromState === STATE.ACTIVE && fromIntent !== p.intent) {
      bump("near.activitySkipped");
    }
  }

  function afterCommit(id, fromId, jumped, nowMs, fromState, fromIntent) {
    const p = pilots.get(id);
    if (!p) return;
    const t = tierCode(p.systemId);
    if (t === TIER.FAR) {
      if (p.flags & PREWARM_MASK) pilots.setFlags(id, p.flags & ~PREWARM_MASK);
      return;
    }
    if (jumped && p.systemId !== fromId) recordArrival(p.systemId, id, p.prevId, nowMs);
    else if (departures && !jumped && fromState === STATE.DOCKED && p.state === STATE.TRAVEL && p.systemId === fromId) {
      recordArrival(p.systemId, id, 0, nowMs, RING_DEPART);
    }
    if (activityOn && Number.isInteger(fromIntent)) noteActivity(p, id, fromId, jumped, nowMs, fromState, fromIntent);
    if (p.flags & FLAG_NEAR) {
      pilots.setFlags(id, (p.flags & ~SUBSTATE_MASK) | (substateOf(p, nowMs, S) << SUBSTATE_SHIFT));
    } else {
      enqueue(id);
    }
  }

  function nearestLive(fromId, bands) {
    const graph = safeCall(deps.getGraph);
    const table = safeCall(deps.getTable);
    if (!graph || typeof graph.getNeighbors !== "function" || !table) return 0;
    const seen = new Set([fromId]);
    let frontier = [fromId];
    for (let d = 1; d <= N.nearJumps && frontier.length > 0; d += 1) {
      const next = [];
      for (const id of frontier) {
        for (const n of safeCall(() => graph.getNeighbors(id), null) || EMPTY) {
          if (seen.has(n)) continue;
          seen.add(n);
          next.push(n);
        }
      }
      next.sort((a, b) => a - b);
      for (const id of next) if (tierCode(id) === TIER.LIVE && bands.includes(table.bandOf(id))) return id;
      frontier = next;
    }
    return 0;
  }

  function attract(p, rng, arch) {
    if (tierCode(p.systemId) !== TIER.NEAR) return 0;
    if (!(rng.nextFloat() * 1000 < N.attractPermille)) return 0;
    const live = nearestLive(p.systemId, arch.bands);
    if (live > 0) bump("attracted");
    return live;
  }

  function ringInto(systemId, sinceMs, limit, kinds) {
    const sys = Number(systemId);
    const since = Number.isFinite(Number(sinceMs)) ? Number(sinceMs) : -Infinity;
    const n = Number.isSafeInteger(limit) && limit > 0 ? limit : ARRIVALS_DEFAULT_LIMIT;
    const latest = new Map();
    for (let k = 0; k < ringCount; k += 1) {
      if (ringSys[k] !== sys || !(ringAt[k] > since) || !kinds.includes(ringKind[k])) continue;
      const prev = latest.get(ringPilot[k]);
      if (!prev || ringAt[k] >= prev.at) {
        latest.set(ringPilot[k], { pilotId: ringPilot[k], systemId: sys, fromId: ringFrom[k], at: ringAt[k],
          kind: ringKind[k] });
      }
    }
    return [...latest.values()].sort((a, b) => a.at - b.at || a.pilotId - b.pilotId).slice(0, n);
  }

  function arrivalsInto(systemId, sinceMs, limit) {
    return Object.freeze(ringInto(systemId, sinceMs, limit, ARRIVE_ONLY)
      .map((e) => Object.freeze({ pilotId: e.pilotId, systemId: e.systemId, fromId: e.fromId, at: e.at })));
  }

  function eventsInto(systemId, sinceMs, limit) {
    return Object.freeze(ringInto(systemId, sinceMs, limit, BOTH_KINDS)
      .map((e) => Object.freeze({ pilotId: e.pilotId, systemId: e.systemId, fromId: e.fromId, at: e.at,
        kind: e.kind === RING_DEPART ? "DEPART" : "ARRIVE" })));
  }

  function activitiesInto(systemId, sinceMs, limit) {
    if (!activityOn || actCount === 0) return EMPTY;
    const sys = Number(systemId);
    const since = Number.isFinite(Number(sinceMs)) ? Number(sinceMs) : -Infinity;
    const n = Number.isSafeInteger(limit) && limit > 0 ? limit : ARRIVALS_DEFAULT_LIMIT;
    const latest = new Map();
    for (let k = 0; k < actCount; k += 1) {
      if (actSys[k] !== sys || !(actAt[k] > since)) continue;
      const prev = latest.get(actPilot[k]);
      if (!prev || actAt[k] >= prev.at) {
        latest.set(actPilot[k], Object.freeze({ pilotId: actPilot[k], systemId: sys, at: actAt[k],
          intent: actIntent[k], kind: "ACTIVITY" }));
      }
    }
    if (latest.size === 0) return EMPTY;
    return Object.freeze([...latest.values()].sort((a, b) => a.at - b.at || a.pilotId - b.pilotId).slice(0, n));
  }

  function onTierChange(cb) {
    if (typeof cb !== "function") return { ok: false, reason: "LISTENER_INVALID" };
    listeners.add(cb);
    return { ok: true, unregister: () => listeners.delete(cb) };
  }

  function counts() {
    let near = 0;
    let live = 0;
    let systemsNear = 0;
    let systemsLive = 0;
    for (const [id, t] of tiers) {
      if (t === TIER.LIVE) {
        live += pilots.countIn(id);
        systemsLive += 1;
      } else {
        near += pilots.countIn(id);
        systemsNear += 1;
      }
    }
    return { near, live, systemsNear, systemsLive };
  }

  function status() {
    return Object.freeze({ ...counts(), version: seenVersion, refreshes, pending: pending.length - head,
      prewarmed: prewarmedTotal, arrivals: ringCount, activities: actCount, names: names.size });
  }

  function viewOf(id, flags) {
    if (!(flags & FLAG_NEAR)) return null;
    return Object.freeze({ substate: S_.SUBSTATE_NAMES[(flags & SUBSTATE_MASK) >> SUBSTATE_SHIFT], name: nameOf(id) });
  }

  function approxBytes() {
    const K = S_.MEMORY_ESTIMATE;
    return ringSys.byteLength + ringPilot.byteLength + ringFrom.byteLength + ringAt.byteLength + ringKind.byteLength
      + actSys.byteLength + actPilot.byteLength + actAt.byteLength + actIntent.byteLength
      + queued.byteLength + (pending.length - head) * K.ROUTE_HOP_BYTES + names.size * K.NAME_ENTRY_BYTES
      + tiers.size * K.MAP_ENTRY_BYTES;
  }

  return Object.freeze({ refresh, prewarmPass, afterCommit, attract, arrivalsInto, eventsInto, activitiesInto,
    onTierChange, counts, status, viewOf, tierOf: (systemId) => TIER_NAMES[tierCode(Number(systemId))], tierCode,
    ringSize, activityRingSize, approxBytes });
}

module.exports = { createNearLayer, substateOf, displayNameOf, NAME_STYLES };
