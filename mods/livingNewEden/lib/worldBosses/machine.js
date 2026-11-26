"use strict";

const { createRng, deriveSeed } = require("../util/rng");
const { STATES, MODES, END_REASONS, RNG } = require("./schema");

const HOUR_MS = 3600000;
const PERMILLE = 1000;

const TRANSITIONS = Object.freeze({
  [STATES.DWELL]: Object.freeze([STATES.MOVING, STATES.DEFEATED, STATES.EXPIRED, STATES.CANCELLED]),
  [STATES.MOVING]: Object.freeze([STATES.DWELL, STATES.DEFEATED, STATES.EXPIRED, STATES.CANCELLED]),
  [STATES.DEFEATED]: Object.freeze([]),
  [STATES.EXPIRED]: Object.freeze([]),
  [STATES.CANCELLED]: Object.freeze([]),
});
const MODE_TRANSITIONS = Object.freeze({
  [MODES.VIRTUAL]: Object.freeze([MODES.LIVE]),
  [MODES.LIVE]: Object.freeze([MODES.VIRTUAL]),
});

function canTransition(from, to) {
  return Object.prototype.hasOwnProperty.call(TRANSITIONS, from) && TRANSITIONS[from].includes(to);
}

function phaseUnits(phaseDef) {
  const out = {};
  for (const unit of phaseDef.units) {
    for (let i = 1; i <= unit.count; i += 1) out[`${unit.key}${i}`] = unit.hp;
  }
  return out;
}

function parseUnits(text) {
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch (_err) {
    return {};
  }
}

function unitsAt(row, now, phaseDef, cfg) {
  const units = parseUnits(row.units_json);
  const dt = now - row.hp_at;
  if (!(dt > 0)) return { units, changed: false };
  const max = phaseUnits(phaseDef);
  const permille = Math.max(0, Number(cfg && cfg.regenPermillePerHour) || 0);
  let changed = false;
  const out = {};
  for (const [key, hp] of Object.entries(units)) {
    const cap = max[key];
    if (!(hp > 0) || !(cap > hp)) {
      out[key] = hp;
      continue;
    }
    const gain = Math.floor((cap * permille * dt) / (PERMILLE * HOUR_MS));
    const next = Math.min(cap, hp + gain);
    if (next !== hp) changed = true;
    out[key] = next;
  }
  return { units: out, changed };
}

function bfsFromMany(graph, sources, maxJumps, maxSystems) {
  const dist = new Map();
  let frontier = [];
  for (const id of [...new Set(sources)].sort((a, b) => a - b)) {
    if (dist.size >= maxSystems) break;
    if (graph.getNeighbors(id) === null) continue;
    dist.set(id, 0);
    frontier.push(id);
  }
  for (let d = 1; d <= maxJumps && frontier.length > 0 && dist.size < maxSystems; d += 1) {
    const next = [];
    for (const id of frontier) {
      for (const n of graph.getNeighbors(id) || []) {
        if (dist.has(n)) continue;
        if (dist.size >= maxSystems) break;
        dist.set(n, d);
        next.push(n);
      }
    }
    frontier = next;
  }
  return dist;
}

function isQualified(graph, id, cfg) {
  const sys = graph.getSystem(id);
  if (!sys || !cfg.secClasses.includes(sys.secClass) || cfg.excludedRegionIds.includes(sys.regionId)) return false;
  const n = graph.getNeighbors(id);
  return Array.isArray(n) && n.length > 0;
}

function qualifiedSystems(graph, cfg) {
  const out = [];
  for (const secClass of cfg.secClasses) {
    for (const id of graph.getSystemsBySecClass(secClass)) if (isQualified(graph, id, cfg)) out.push(id);
  }
  return out.sort((a, b) => a - b);
}

const inRegion = (graph, id, regionId) => regionId === undefined || regionId === null
  || (graph.getSystem(id) || {}).regionId === regionId;

function pickSpawnSystem(input, graph, cfg) {
  const seed = input.seed >>> 0;
  const regionId = input.regionId;
  const observed = (Array.isArray(input.observed) ? input.observed : []).filter((id) => graph.getNeighbors(id) !== null);
  const pick = (list) => (list.length > 0 ? { systemId: list[seed % list.length] } : null);
  if (observed.length === 0) {
    return pick(qualifiedSystems(graph, cfg).filter((id) => inRegion(graph, id, regionId)))
      || { systemId: null, reason: "NO_SYSTEM" };
  }
  const dist = bfsFromMany(graph, observed, cfg.spawnMaxJumps, cfg.spawnMaxBfsSystems);
  const inRange = [...dist.entries()].filter(([id, d]) => d >= cfg.spawnMinJumps && d <= cfg.spawnMaxJumps
    && inRegion(graph, id, regionId) && isQualified(graph, id, cfg)).map(([id]) => id).sort((a, b) => a - b);
  const hit = pick(inRange);
  if (hit) return hit;
  if (regionId !== undefined && regionId !== null) {
    const far = qualifiedSystems(graph, cfg).filter((id) => inRegion(graph, id, regionId)
      && !(dist.has(id) && dist.get(id) < cfg.spawnMinJumps));
    const fallback = pick(far);
    if (fallback) return fallback;
  }
  return { systemId: null, reason: "NO_SYSTEM" };
}

function pickGoal(input, graph, cfg) {
  const from = graph.getSystem(input.fromSystemId);
  const fromRegion = from ? from.regionId : null;
  const list = qualifiedSystems(graph, cfg).filter((id) => (graph.getSystem(id) || {}).regionId !== fromRegion);
  if (list.length === 0) return { systemId: input.fromSystemId };
  return { systemId: list[(input.seed >>> 0) % list.length] };
}

function distance2(a, b) {
  if (!a || !b) return Infinity;
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz;
}

function chooseNextHop(input, graph, cfg) {
  const neighbors = graph.getNeighbors(input.systemId) || [];
  const qualified = neighbors.filter((id) => isQualified(graph, id, cfg)).sort((a, b) => a - b);
  const visited = new Set(Array.isArray(input.visited) ? input.visited : []);
  let cands = qualified.filter((id) => !visited.has(id));
  if (cands.length === 0) cands = qualified;
  if (cands.length === 0) return { systemId: null, reason: "NO_NEIGHBOR" };
  const rng = createRng(deriveSeed(input.seed >>> 0, RNG.HOP, input.hops));
  const r = rng.nextUint32() % PERMILLE;
  const r2 = rng.nextUint32();
  if (r < cfg.goalBiasPermille) {
    const goal = graph.getSystem(input.goalSystemId);
    const goalPos = goal ? goal.position : null;
    let best = null;
    let bestD = Infinity;
    for (const id of cands) {
      const d = distance2((graph.getSystem(id) || {}).position, goalPos);
      if (d < bestD) {
        best = id;
        bestD = d;
      }
    }
    if (best !== null) return { systemId: best };
  }
  return { systemId: cands[r2 % cands.length] };
}

function decideStep(row, facts, cfg) {
  const now = facts.now;
  if (row.state !== STATES.DWELL && row.state !== STATES.MOVING) return { action: "NOOP" };
  if (now >= row.expiresAt) return { action: "EXPIRE", reason: END_REASONS.LIFETIME };
  if (row.state === STATES.DWELL && row.hops >= cfg.maxHops && now >= row.nextDueAt) {
    return { action: "EXPIRE", reason: END_REASONS.MAX_HOPS };
  }
  if (now < row.nextDueAt) return { action: "NOOP" };
  const waitMax = cfg.clash && Number.isSafeInteger(cfg.clash.moveWaitMaxMs) ? cfg.clash.moveWaitMaxMs : 0;
  if (row.state === STATES.DWELL && facts.openClashes > 0 && now < row.nextDueAt + waitMax) {
    return { action: "NOOP", reason: "WAIT_CLASH" };
  }
  if (row.state === STATES.DWELL) return { action: "DEPART", nextDueAt: now + cfg.hopMs };
  return { action: "ARRIVE", nextDueAt: now + cfg.dwellMs };
}

function decideLive(row, f, cfg) {
  const players = f.sceneLoaded === true && f.gridPlayers > 0 ? f.gridPlayers : 0;
  if (row.mode !== MODES.LIVE) {
    if (row.state !== STATES.DWELL) return { action: "HOLD", reason: "NOT_DWELL" };
    if (players < 1) return { action: "HOLD", reason: "NO_PLAYER" };
    if (f.openClashes > 0) return { action: "HOLD", reason: "OPEN_CLASHES" };
    if (f.governorOk !== true) return { action: "HOLD", reason: "GOVERNOR" };
    if (!(f.pendingUnits > 0)) return { action: "HOLD", reason: "NO_UNITS" };
    if (!(f.room > 0)) return { action: "HOLD", reason: "BUDGET" };
    return { action: "START", count: Math.min(f.room, f.pendingUnits) };
  }
  if (row.state !== STATES.DWELL) return { action: "EXIT", reason: "NOT_DWELL" };
  if (Number.isSafeInteger(row.liveSince) && f.now >= row.liveSince + cfg.maxMs) {
    return { action: "EXIT", reason: "MAX_TIME" };
  }
  if (players < 1) {
    const since = Number.isSafeInteger(f.lastGridSeenAt) ? f.lastGridSeenAt : row.liveSince;
    if (!Number.isSafeInteger(since) || f.now - since >= cfg.abandonGraceMs) {
      return { action: "EXIT", reason: "ABANDONED" };
    }
  }
  if (f.sceneLoaded === true && !(f.alive > 0) && !(f.pendingUnits > 0) && f.skippedUnits > 0) {
    return { action: "EXIT", reason: "UNSPAWNABLE" };
  }
  if (f.sceneLoaded === true && !(f.alive > 0) && !(f.pendingUnits > 0)) {
    return f.lastPhase === true ? { action: "DEFEAT" } : { action: "NEXT_PHASE" };
  }
  if (players > 0 && f.pendingUnits > 0 && f.room > 0) {
    return { action: "WAVE", count: Math.min(f.room, f.pendingUnits) };
  }
  return { action: "HOLD", reason: players < 1 ? "NO_PLAYER" : "WAIT" };
}

function nextWave(phaseDef, units, taken, count) {
  if (!phaseDef || !(count > 0)) return [];
  const regular = [];
  const flagships = [];
  for (const unit of phaseDef.units) {
    for (let n = 1; n <= unit.count; n += 1) {
      const unitKey = `${unit.key}${n}`;
      const hp = units ? Number(units[unitKey]) : 0;
      if (!(hp >= 1) || (taken && taken.has(unitKey))) continue;
      const item = { unitKey, hullGroup: unit.hullGroup, profileId: unit.profileId || null, hp,
        flagship: Boolean(unit.profileId) };
      (item.flagship ? flagships : regular).push(item);
    }
  }
  return [...regular, ...flagships].slice(0, count);
}

module.exports = { TRANSITIONS, MODE_TRANSITIONS, canTransition, unitsAt, phaseUnits, bfsFromMany, isQualified,
  qualifiedSystems, pickSpawnSystem, pickGoal, chooseNextHop, decideStep, decideLive, nextWave };
