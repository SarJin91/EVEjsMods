"use strict";

const PERMILLE = 1000;
const SHIP_STATE = Object.freeze({ SPAWNED: "SPAWNED", WARPING: "WARPING", ARRIVED: "ARRIVED", RUNNING: "RUNNING",
  IDLING: "IDLING", MINING: "MINING" });
const DESPAWN_REASON = Object.freeze({ ARRIVED: "ARRIVED", EXPIRED: "EXPIRED", STUCK: "STUCK", JUMPED: "JUMPED" });
const SHIP_ROLE = Object.freeze({ HAULER: "HAULER", UNDOCK: "UNDOCK", GATE_IDLE: "GATE_IDLE", MINER: "MINER" });
const MINER_LEG = Object.freeze({ BELT: "BELT", EXIT: "EXIT" });
const FULL_TURN = Math.PI * 2;

function indexOf(rng, length) {
  return Math.min(length - 1, Math.max(0, Math.floor(rng() * length)));
}

function trafficCapOf(wanted, T) {
  const n = Number.isFinite(wanted) ? wanted : 0;
  if (n < T.minCivilians || n <= 0) return 0;
  return Math.min(T.maxShipsPerSystem, Math.max(1, Math.ceil(n / T.civiliansPerShip)));
}

function planSpawns(input, T) {
  const out = [];
  let running = Number.isFinite(input && input.globalLive) ? input.globalLive : 0;
  const now = input && Number.isFinite(input.now) ? input.now : 0;
  for (const c of Array.isArray(input && input.candidates) ? input.candidates : []) {
    if (out.length >= T.maxSystemsPerPass) break;
    if (!c || !(c.players > 0) || now < c.nextSpawnAt) continue;
    const room = trafficCapOf(c.wanted, T) - (Number.isFinite(c.live) ? c.live : 0);
    const globalRoom = T.maxShipsGlobal - running;
    const count = Math.min(room, globalRoom, c.wanted >= T.pairCivilians ? 2 : 1);
    if (count <= 0) continue;
    out.push({ systemId: c.systemId, count });
    running += count;
  }
  return out;
}

function pickRoute(nodes, rng, T) {
  const gates = nodes && Array.isArray(nodes.gates) ? nodes.gates : [];
  const stations = nodes && Array.isArray(nodes.stations) ? nodes.stations : [];
  if (gates.length === 0 || (gates.length === 1 && stations.length === 0)) return { ok: false, reason: "NO_ROUTE" };
  const startIdx = indexOf(rng, gates.length);
  const startGate = gates[startIdx];
  const toStation = stations.length > 0 && (gates.length < 2 || rng() * PERMILLE < T.stationTargetPermille);
  if (toStation) {
    const s = stations[indexOf(rng, stations.length)];
    return { ok: true, startGate, target: { kind: "station", itemId: s.itemId, position: s.position, radius: s.radius } };
  }
  const others = gates.filter((_g, i) => i !== startIdx);
  const g = others[indexOf(rng, others.length)];
  return { ok: true, startGate, target: { kind: "stargate", itemId: g.itemId, position: g.position, radius: g.radius } };
}

function listsOf(nodes) {
  return { gates: nodes && Array.isArray(nodes.gates) ? nodes.gates : [],
    stations: nodes && Array.isArray(nodes.stations) ? nodes.stations : [],
    belts: nodes && Array.isArray(nodes.belts) ? nodes.belts : [] };
}

function pickRole(rng, nodes, T) {
  const { gates, stations, belts } = listsOf(nodes);
  const undock = T.undockEnabled === true && stations.length > 0 && gates.length > 0;
  const idle = T.gateIdleEnabled === true && gates.length > 0;
  const miner = T.minerEnabled === true && belts.length > 0 && gates.length > 0;
  if (!undock && !idle && !miner) return SHIP_ROLE.HAULER;
  const roll = rng() * PERMILLE;
  const undockShare = undock ? T.undockPermille : 0;
  if (roll < undockShare) return SHIP_ROLE.UNDOCK;
  const idleShare = idle ? T.gateIdlePermille : 0;
  if (roll < undockShare + idleShare) return SHIP_ROLE.GATE_IDLE;
  if (miner && roll < undockShare + idleShare + T.minerPermille) return SHIP_ROLE.MINER;
  return SHIP_ROLE.HAULER;
}

function pickMinerRoute(nodes, rng, T, opts) {
  const { gates, stations, belts } = listsOf(nodes);
  if (gates.length === 0 || belts.length === 0) return { ok: false, reason: "NO_ROUTE" };
  const fixed = opts && opts.fixedStartGate ? opts.fixedStartGate : null;
  const starts = fixed ? null : [...gates.map((node) => ({ kind: "stargate", node })),
    ...(T.undockEnabled === true ? stations.map((node) => ({ kind: "station", node })) : [])];
  const start = fixed ? { kind: "stargate", node: fixed } : starts[indexOf(rng, starts.length)];
  const belt = belts[indexOf(rng, belts.length)];
  const angle = rng() * FULL_TURN;
  const r = T.minerAsteroidMeters;
  const beltPoint = { x: belt.position.x + Math.cos(angle) * r, y: belt.position.y,
    z: belt.position.z + Math.sin(angle) * r };
  const toStation = stations.length > 0 && rng() * PERMILLE < T.stationTargetPermille;
  const pool = toStation ? stations : gates;
  const e = pool[indexOf(rng, pool.length)];
  const span = T.minerStayMaxMs - T.minerStayMinMs;
  const stayMs = Math.min(T.minerStayMaxMs, T.minerStayMinMs + Math.floor(rng() * (span + 1)));
  return { ok: true, start, belt, beltPoint, stayMs,
    exit: { kind: toStation ? "station" : "stargate", itemId: e.itemId, position: e.position, radius: e.radius } };
}

const PILOT_EXIT = Object.freeze({ GATE: "GATE", STATION: "STATION", NONE: "NONE" });
const GONE = "GONE";

function planPilot(cand, nodes, rng, T) {
  const { gates, stations } = listsOf(nodes);
  if (!cand || gates.length === 0) return { ok: false, reason: "NO_ROUTE" };
  const gateTo = (systemId) => (systemId > 0 ? gates.find((g) => g.toSystemId === systemId) || null : null);
  const targetOf = (kind, n) => ({ kind, itemId: n.itemId, position: n.position, radius: n.radius });
  const arrival = gateTo(cand.fromSystemId);
  if (cand.role === SHIP_ROLE.MINER) {
    const route = pickMinerRoute(nodes, rng, T, arrival ? { fixedStartGate: arrival } : undefined);
    return route.ok ? { ok: true, role: SHIP_ROLE.MINER, miner: route } : { ok: false, reason: "NO_ROUTE" };
  }
  if (cand.role === SHIP_ROLE.UNDOCK) {
    if (stations.length === 0) return { ok: false, reason: "NO_ROUTE" };
    const exit = gateTo(cand.toSystemId);
    if (!exit) return { ok: false, reason: "NO_GATE" };
    const station = stations[indexOf(rng, stations.length)];
    return { ok: true, role: SHIP_ROLE.UNDOCK, start: { kind: "station", node: station },
      target: targetOf("stargate", exit) };
  }
  const startGate = arrival || gates[indexOf(rng, gates.length)];
  if (cand.exit === PILOT_EXIT.STATION) {
    if (stations.length === 0) return { ok: false, reason: "NO_ROUTE" };
    const s = stations[indexOf(rng, stations.length)];
    return { ok: true, role: SHIP_ROLE.HAULER, start: { kind: "stargate", node: startGate },
      target: targetOf("station", s) };
  }
  const exit = gateTo(cand.toSystemId);
  if (!exit) return { ok: false, reason: "NO_GATE" };
  return { ok: true, role: SHIP_ROLE.HAULER, start: { kind: "stargate", node: startGate },
    target: targetOf("stargate", exit) };
}

function outcomeOf(ship, reason) {
  if (reason === DESPAWN_REASON.ARRIVED) {
    if (ship && ship.exit === PILOT_EXIT.GATE) return "JUMPED";
    return ship && ship.exit === PILOT_EXIT.STATION ? "DOCKED" : "LEFT";
  }
  if (reason === DESPAWN_REASON.EXPIRED || reason === DESPAWN_REASON.STUCK) return reason;
  if (reason === GONE) return "KILLED";
  return "LEFT";
}

function civilianProfilesByRole(civ) {
  const hulls = civ && Array.isArray(civ.CIVILIAN_HULLS) && typeof civ.civilianProfileId === "function"
    ? civ.CIVILIAN_HULLS : [];
  const out = {};
  for (const role of Object.values(SHIP_ROLE)) {
    out[role] = Object.freeze(hulls.filter((h) => h && Array.isArray(h.roles) && h.roles.includes(role))
      .map((h) => Object.freeze({ profileId: civ.civilianProfileId(h.key), weight: h.weight,
        shipTypeId: h.shipTypeId })));
  }
  return Object.freeze(out);
}

function pilotHullProfilesOf(civ) {
  const hulls = civ && Array.isArray(civ.CIVILIAN_HULLS) && typeof civ.civilianProfileId === "function"
    ? civ.CIVILIAN_HULLS : [];
  const out = new Map();
  for (const h of hulls) {
    if (!h || !Array.isArray(h.roles) || h.roles.includes("POD") || !Number.isSafeInteger(h.shipTypeId)
      || !Number.isSafeInteger(h.presentationTypeId) || out.has(h.shipTypeId)) continue;
    out.set(h.shipTypeId, Object.freeze({ profileId: civ.civilianProfileId(h.key), shipTypeId: h.shipTypeId,
      presentationTypeId: h.presentationTypeId }));
  }
  return out;
}

const NPC_CATEGORY_ID = 11;

function verifyPilotHulls(entries, looks) {
  const verified = new Map();
  const rejected = [];
  for (const [shipTypeId, e] of entries) {
    const hull = looks && looks.get(e.shipTypeId);
    const look = looks && looks.get(e.presentationTypeId);
    const ok = Boolean(hull && look) && look.categoryID === NPC_CATEGORY_ID && Number.isSafeInteger(hull.graphicID)
      && hull.graphicID > 0 && look.graphicID === hull.graphicID;
    if (ok) verified.set(shipTypeId, e);
    else rejected.push(shipTypeId);
  }
  rejected.sort((a, b) => a - b);
  return { verified, rejected };
}

function pickUndockRoute(nodes, rng) {
  const { gates, stations } = listsOf(nodes);
  if (gates.length === 0 || stations.length === 0) return { ok: false, reason: "NO_ROUTE" };
  const station = stations[indexOf(rng, stations.length)];
  const g = gates[indexOf(rng, gates.length)];
  return { ok: true, station, target: { kind: "stargate", itemId: g.itemId, position: g.position, radius: g.radius } };
}

function pickIdleGate(nodes, rng, T) {
  const { gates } = listsOf(nodes);
  if (gates.length === 0) return { ok: false, reason: "NO_ROUTE" };
  const gate = gates[indexOf(rng, gates.length)];
  const span = T.gateIdleMaxMs - T.gateIdleMinMs;
  const idleMs = Math.min(T.gateIdleMaxMs, T.gateIdleMinMs + Math.floor(rng() * (span + 1)));
  return { ok: true, gate, idleMs };
}

function pickProfile(profiles, rng) {
  const list = (Array.isArray(profiles) ? profiles : []).filter((p) => p && typeof p.profileId === "string"
    && p.profileId !== "" && Number.isFinite(p.weight) && p.weight > 0);
  const total = list.reduce((sum, p) => sum + p.weight, 0);
  if (!(total > 0)) return null;
  let roll = rng() * total;
  for (const p of list) {
    roll -= p.weight;
    if (roll < 0) return p.profileId;
  }
  return list[list.length - 1].profileId;
}

function landingPointOf(fromPosition, target, T) {
  const p = target.position;
  const dx = p.x - fromPosition.x;
  const dy = p.y - fromPosition.y;
  const dz = p.z - fromPosition.z;
  const len = Math.hypot(dx, dy, dz);
  const unit = len > 0 && Number.isFinite(len) ? { x: dx / len, y: dy / len, z: dz / len } : { x: 1, y: 0, z: 0 };
  const radius = Number.isFinite(target.radius) && target.radius > 0 ? target.radius : 0;
  const back = radius + T.landingOffsetMeters;
  return { x: p.x - unit.x * back, y: p.y - unit.y * back, z: p.z - unit.z * back };
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

function stepShip(ship, seen, now, T) {
  if (ship.state === SHIP_STATE.IDLING && Number.isFinite(ship.idleUntil) && now >= ship.idleUntil) {
    return { kind: "despawn", reason: DESPAWN_REASON.JUMPED };
  }
  const extraMs = ship.role === SHIP_ROLE.MINER && Number.isFinite(ship.stayMs) && ship.stayMs > 0 ? ship.stayMs : 0;
  if (now >= ship.spawnedAt + T.maxLifetimeMs + extraMs) return { kind: "despawn", reason: DESPAWN_REASON.EXPIRED };
  if (!seen || seen.live !== true) return { kind: "none" };
  if (ship.state === SHIP_STATE.SPAWNED && ship.role === SHIP_ROLE.UNDOCK) return { kind: "run" };
  if (ship.state === SHIP_STATE.SPAWNED || ship.state === SHIP_STATE.RUNNING) {
    if (ship.warpAttempts >= T.maxWarpAttempts) return { kind: "despawn", reason: DESPAWN_REASON.STUCK };
    return now >= ship.spawnedAt + T.departDelayMs ? { kind: "warp" } : { kind: "none" };
  }
  if (ship.state === SHIP_STATE.MINING) {
    if (ship.warpAttempts >= T.maxWarpAttempts) return { kind: "despawn", reason: DESPAWN_REASON.STUCK };
    return Number.isFinite(ship.mineUntil) && now >= ship.mineUntil ? { kind: "leave" } : { kind: "none" };
  }
  if (ship.state === SHIP_STATE.WARPING) {
    if (seen.inWarp !== true && seen.position && distance(seen.position, ship.targetPoint) <= T.arrivalMeters) {
      return ship.role === SHIP_ROLE.MINER && ship.leg === MINER_LEG.BELT ? { kind: "mine" } : { kind: "arrived" };
    }
    return { kind: "none" };
  }
  if (ship.state === SHIP_STATE.ARRIVED && Number.isFinite(ship.arrivedAt) && now >= ship.arrivedAt + T.dockDelayMs) {
    return { kind: "despawn", reason: DESPAWN_REASON.ARRIVED };
  }
  return { kind: "none" };
}

module.exports = { SHIP_STATE, DESPAWN_REASON, SHIP_ROLE, MINER_LEG, trafficCapOf, planSpawns, pickRoute, pickProfile,
  landingPointOf, stepShip, pickRole, pickUndockRoute, pickIdleGate, pickMinerRoute, civilianProfilesByRole,
  PILOT_EXIT, GONE, planPilot, outcomeOf, pilotHullProfilesOf, verifyPilotHulls };
