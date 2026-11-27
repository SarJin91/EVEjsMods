"use strict";

const PERMILLE = 1000;
const SHIP_STATE = Object.freeze({ SPAWNED: "SPAWNED", WARPING: "WARPING", ARRIVED: "ARRIVED", RUNNING: "RUNNING",
  IDLING: "IDLING", MINING: "MINING", JUMPING: "JUMPING", DWELLING: "DWELLING" });
const DESPAWN_REASON = Object.freeze({ ARRIVED: "ARRIVED", EXPIRED: "EXPIRED", STUCK: "STUCK", JUMPED: "JUMPED" });
const SHIP_ROLE = Object.freeze({ HAULER: "HAULER", UNDOCK: "UNDOCK", GATE_IDLE: "GATE_IDLE", MINER: "MINER",
  RATTER: "RATTER", EXPLORER: "EXPLORER" });
const MINER_LEG = Object.freeze({ BELT: "BELT", EXIT: "EXIT" });
const PATROL_LEG = Object.freeze({ PATROL: "PATROL", EXIT: "EXIT" });
const PATROL_ROLES = Object.freeze([SHIP_ROLE.RATTER, SHIP_ROLE.EXPLORER]);
const BELT_LEG = "BELT";
const EXPLORER_LEG = Object.freeze({ SAFE: "SAFE", SITE: "SITE" });
const WARP_MODE = Object.freeze({ ALIGN: "align", IMMEDIATE: "immediate" });
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

function pickRole(rng, nodes, T, counts) {
  const { gates, stations, belts } = listsOf(nodes);
  const undock = T.undockEnabled === true && stations.length > 0 && gates.length > 0;
  const idle = T.gateIdleEnabled === true && gates.length > 0;
  const miner = T.minerEnabled === true && belts.length > 0 && gates.length > 0;
  const ratters = counts && Number.isSafeInteger(counts.RATTER) ? counts.RATTER : 0;
  const ratter = T.ratterEnabled === true && T.civilianHullsEnabled === true && belts.length > 0
    && gates.length > 0 && ratters < T.ratterMaxPerSystem;
  const explorers = counts && Number.isSafeInteger(counts.EXPLORER) ? counts.EXPLORER : 0;
  const explorer = T.explorerEnabled === true && T.civilianHullsEnabled === true && gates.length > 0
    && explorers < T.explorerMaxPerSystem;
  if (!undock && !idle && !miner && !ratter && !explorer) return SHIP_ROLE.HAULER;
  const roll = rng() * PERMILLE;
  const undockShare = undock ? T.undockPermille : 0;
  if (roll < undockShare) return SHIP_ROLE.UNDOCK;
  const idleShare = idle ? T.gateIdlePermille : 0;
  if (roll < undockShare + idleShare) return SHIP_ROLE.GATE_IDLE;
  const minerShare = miner ? T.minerPermille : 0;
  if (miner && roll < undockShare + idleShare + minerShare) return SHIP_ROLE.MINER;
  if (ratter && roll < undockShare + idleShare + minerShare + T.ratterPermille) return SHIP_ROLE.RATTER;
  const ratterShare = ratter ? T.ratterPermille : 0;
  if (explorer && roll < undockShare + idleShare + minerShare + ratterShare + T.explorerPermille) {
    return SHIP_ROLE.EXPLORER;
  }
  return SHIP_ROLE.HAULER;
}

function patrolStartOf(nodes, rng, T, opts) {
  const { gates, stations } = listsOf(nodes);
  if (opts && opts.fixedStartGate) return { kind: "stargate", node: opts.fixedStartGate };
  if (opts && opts.startAtStation === true && stations.length > 0) {
    return { kind: "station", node: stations[indexOf(rng, stations.length)] };
  }
  const starts = [...gates.map((node) => ({ kind: "stargate", node })),
    ...(T.undockEnabled === true ? stations.map((node) => ({ kind: "station", node })) : [])];
  return starts[indexOf(rng, starts.length)];
}

function safeSpotOf(from, nodes, rng, T) {
  const { gates, stations, belts } = listsOf(nodes);
  const all = [...gates, ...stations, ...belts];
  if (!from || all.length === 0) return null;
  for (let i = 0; i < T.explorerSafeSpotTries; i += 1) {
    const other = all[indexOf(rng, all.length)].position;
    const spot = { x: (from.x + other.x) / 2, y: (from.y + other.y) / 2 + T.explorerSafeSpotOffsetMeters,
      z: (from.z + other.z) / 2 };
    if (all.every((n) => distance(n.position, spot) >= T.explorerSafeSpotMinMeters)) return Object.freeze(spot);
  }
  return null;
}

function pickExplorerRoute(nodes, rng, T, opts) {
  const { gates, stations } = listsOf(nodes);
  if (gates.length === 0) return { ok: false, reason: "NO_ROUTE" };
  const start = patrolStartOf(nodes, rng, T, opts);
  const safePoint = safeSpotOf(start.node.position, nodes, rng, T);
  const toStation = stations.length > 0 && rng() * PERMILLE < T.stationTargetPermille;
  const exitPool = toStation ? stations : gates;
  const e = exitPool[indexOf(rng, exitPool.length)];
  const k = T.explorerMaxSites;
  const stayMs = T.explorerScanMs * k + k * T.explorerSiteDwellMs + (k + 2) * T.explorerLegMs;
  return { ok: true, start, safePoint, stayMs,
    exit: { kind: toStation ? "station" : "stargate", itemId: e.itemId, position: e.position, radius: e.radius } };
}

function pickSites(sites, rng, T, from) {
  const pool = (Array.isArray(sites) ? sites : []).filter((s) => s && Number.isSafeInteger(s.siteId) && s.position)
    .sort((a, b) => a.siteId - b.siteId);
  const k = Math.min(pool.length, T.explorerMaxSites);
  const legs = [];
  for (let i = 0; i < k; i += 1) {
    const j = i + indexOf(rng, pool.length - i);
    const site = pool[j];
    pool[j] = pool[i];
    pool[i] = site;
    const p = site.position;
    const back = from ? { x: from.x - p.x, y: from.y - p.y, z: from.z - p.z } : { x: 1, y: 0, z: 0 };
    const len = Math.hypot(back.x, back.y, back.z);
    const unit = len > 0 && Number.isFinite(len) ? { x: back.x / len, y: back.y / len, z: back.z / len }
      : { x: 1, y: 0, z: 0 };
    const r = T.explorerSiteOffsetMeters;
    const point = Object.freeze({ x: p.x + unit.x * r, y: p.y + unit.y * r, z: p.z + unit.z * r });
    legs.push(Object.freeze({ kind: EXPLORER_LEG.SITE, targetId: site.siteId, point, dwellMs: T.explorerSiteDwellMs }));
  }
  return legs;
}

function pickRatterRoute(nodes, rng, T, opts) {
  const { gates, stations, belts } = listsOf(nodes);
  if (gates.length === 0 || belts.length === 0) return { ok: false, reason: "NO_ROUTE" };
  const start = patrolStartOf(nodes, rng, T, opts);
  const pool = belts.slice().sort((a, b) => a.itemId - b.itemId);
  const span = Math.max(0, T.ratterBeltsMax - T.ratterBeltsMin);
  const k = Math.max(1, Math.min(pool.length, T.ratterBeltsMin + Math.floor(rng() * (span + 1))));
  const dwellSpan = Math.max(0, T.ratterDwellMaxMs - T.ratterDwellMinMs);
  const r = T.ratterLandingMeters;
  const legs = [];
  let stayMs = 0;
  for (let i = 0; i < k; i += 1) {
    const j = i + indexOf(rng, pool.length - i);
    const belt = pool[j];
    pool[j] = pool[i];
    pool[i] = belt;
    const angle = rng() * FULL_TURN;
    const point = Object.freeze({ x: belt.position.x + Math.cos(angle) * r, y: belt.position.y,
      z: belt.position.z + Math.sin(angle) * r });
    const dwellMs = Math.min(T.ratterDwellMaxMs, T.ratterDwellMinMs + Math.floor(rng() * (dwellSpan + 1)));
    legs.push(Object.freeze({ kind: BELT_LEG, targetId: belt.itemId, point, dwellMs }));
    stayMs += dwellMs;
  }
  stayMs += k * T.ratterLegMs;
  const toStation = stations.length > 0 && rng() * PERMILLE < T.stationTargetPermille;
  const exitPool = toStation ? stations : gates;
  const e = exitPool[indexOf(rng, exitPool.length)];
  return { ok: true, start, legs: Object.freeze(legs), stayMs,
    exit: { kind: toStation ? "station" : "stargate", itemId: e.itemId, position: e.position, radius: e.radius } };
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
  if (cand.role === SHIP_ROLE.RATTER) {
    if (T.ratterEnabled !== true || T.civilianHullsEnabled !== true) return { ok: false, reason: "NO_ROUTE" };
    const opts = arrival ? { fixedStartGate: arrival } : cand.fromSystemId > 0 ? undefined : { startAtStation: true };
    const route = pickRatterRoute(nodes, rng, T, opts);
    return route.ok ? { ok: true, role: SHIP_ROLE.RATTER, patrol: route } : { ok: false, reason: "NO_ROUTE" };
  }
  if (cand.role === SHIP_ROLE.EXPLORER) {
    if (T.explorerEnabled !== true || T.civilianHullsEnabled !== true) return { ok: false, reason: "NO_ROUTE" };
    const opts = arrival ? { fixedStartGate: arrival } : cand.fromSystemId > 0 ? undefined : { startAtStation: true };
    const route = pickExplorerRoute(nodes, rng, T, opts);
    return route.ok ? { ok: true, role: SHIP_ROLE.EXPLORER, explore: route } : { ok: false, reason: "NO_ROUTE" };
  }
  if (cand.role === SHIP_ROLE.UNDOCK) {
    if (stations.length === 0) return { ok: false, reason: "NO_ROUTE" };
    const exit = gateTo(cand.toSystemId);
    if (!exit) return { ok: false, reason: "NO_GATE" };
    const station = stations[indexOf(rng, stations.length)];
    return { ok: true, role: SHIP_ROLE.UNDOCK, start: { kind: "station", node: station },
      target: targetOf("stargate", exit) };
  }
  if (cand.role !== SHIP_ROLE.HAULER) return { ok: false, reason: "NO_ROUTE" };
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

const MIN_HEADING_METERS = 1;
const DEG_TO_RAD = Math.PI / 180;

function finitePoint(p) {
  return Boolean(p) && typeof p === "object" && [p.x, p.y, p.z].every((v) => typeof v === "number"
    && Number.isFinite(v));
}

function arrivalPoseOf(gate, facePoint, distanceMeters, rng, T) {
  const min = T ? T.gateArrivalTurnMinDeg : NaN;
  const max = T ? T.gateArrivalTurnMaxDeg : NaN;
  if (!gate || !finitePoint(gate.position) || !finitePoint(facePoint) || typeof rng !== "function"
    || typeof distanceMeters !== "number" || !Number.isFinite(distanceMeters) || distanceMeters < 0
    || !Number.isFinite(min) || !Number.isFinite(max) || min > max) {
    return { ok: false, reason: "INVALID_INPUT" };
  }
  const az = rng() * FULL_TURN;
  const turn = (min + rng() * (max - min)) * DEG_TO_RAD;
  const sign = rng() < 0.5 ? -1 : 1;
  const g = gate.position;
  const position = { x: g.x + Math.cos(az) * distanceMeters, y: g.y, z: g.z + Math.sin(az) * distanceMeters };
  const hx = facePoint.x - position.x;
  const hz = facePoint.z - position.z;
  if (!(Math.hypot(hx, hz) >= MIN_HEADING_METERS)) return { ok: false, reason: "NO_HEADING" };
  const yaw = Math.atan2(hx, hz) + sign * turn;
  return { ok: true, position: Object.freeze(position),
    direction: Object.freeze({ x: Math.sin(yaw), y: 0, z: Math.cos(yaw) }) };
}

function isExpired(ship, now, T) {
  const staying = ship.role === SHIP_ROLE.MINER || PATROL_ROLES.includes(ship.role);
  const extraMs = staying && Number.isFinite(ship.stayMs) && ship.stayMs > 0 ? ship.stayMs : 0;
  return now >= ship.spawnedAt + T.maxLifetimeMs + extraMs;
}

function stepShip(ship, seen, now, T) {
  if (ship.state === SHIP_STATE.JUMPING) {
    if (Number.isFinite(ship.jumpOutAt) && now < ship.jumpOutAt + T.gateJumpOutDespawnMs) return { kind: "none" };
    return { kind: "despawn",
      reason: ship.jumpReason === DESPAWN_REASON.JUMPED ? DESPAWN_REASON.JUMPED : DESPAWN_REASON.ARRIVED };
  }
  if (ship.state === SHIP_STATE.IDLING && Number.isFinite(ship.idleUntil) && now >= ship.idleUntil) {
    if (T.gateJumpFxEnabled === true && Number.isSafeInteger(ship.startGateId) && ship.startGateId > 0) {
      return { kind: "jumpOut", gateId: ship.startGateId, reason: DESPAWN_REASON.JUMPED };
    }
    return { kind: "despawn", reason: DESPAWN_REASON.JUMPED };
  }
  if (isExpired(ship, now, T)) return { kind: "despawn", reason: DESPAWN_REASON.EXPIRED };
  if (!seen || seen.live !== true) return { kind: "none" };
  if (ship.state === SHIP_STATE.SPAWNED && ship.role === SHIP_ROLE.UNDOCK) return { kind: "run" };
  if (ship.state === SHIP_STATE.SPAWNED || ship.state === SHIP_STATE.RUNNING) {
    if (seen.inWarp === true) return { kind: "adoptWarp" };
    if (ship.warpAttempts >= T.maxWarpAttempts) return { kind: "despawn", reason: DESPAWN_REASON.STUCK };
    if (now < ship.spawnedAt + T.departDelayMs) return { kind: "none" };
    return ship.role === SHIP_ROLE.EXPLORER && !ship.targetPoint ? { kind: "dwell" } : { kind: "warp" };
  }
  if (ship.state === SHIP_STATE.MINING) {
    if (ship.warpAttempts >= T.maxWarpAttempts) return { kind: "despawn", reason: DESPAWN_REASON.STUCK };
    return Number.isFinite(ship.mineUntil) && now >= ship.mineUntil ? { kind: "leave" } : { kind: "none" };
  }
  if (ship.state === SHIP_STATE.DWELLING) {
    if (ship.warpAttempts >= T.maxWarpAttempts) return { kind: "despawn", reason: DESPAWN_REASON.STUCK };
    if (!Number.isFinite(ship.dwellUntil) || now < ship.dwellUntil) return { kind: "none" };
    if (ship.role === SHIP_ROLE.EXPLORER && ship.leg !== PATROL_LEG.EXIT) return { kind: "explore" };
    const legCount = Array.isArray(ship.legs) ? ship.legs.length : 0;
    return ship.leg !== PATROL_LEG.EXIT && ship.legIndex + 1 < legCount ? { kind: "nextLeg" } : { kind: "leave" };
  }
  if (ship.state === SHIP_STATE.WARPING) {
    if (seen.inWarp !== true && seen.position && distance(seen.position, ship.targetPoint) <= T.arrivalMeters) {
      if (ship.role === SHIP_ROLE.MINER && ship.leg === MINER_LEG.BELT) return { kind: "mine" };
      if (PATROL_ROLES.includes(ship.role) && ship.leg === PATROL_LEG.PATROL) return { kind: "dwell" };
      return { kind: "arrived" };
    }
    if (ship.warpMode === WARP_MODE.ALIGN && seen.inWarp !== true && Number.isFinite(ship.warpAt)
      && now >= ship.warpAt + T.alignTimeoutMs) {
      return { kind: "warp", immediate: true };
    }
    return { kind: "none" };
  }
  if (ship.state === SHIP_STATE.ARRIVED && Number.isFinite(ship.arrivedAt) && now >= ship.arrivedAt + T.dockDelayMs) {
    return { kind: "despawn", reason: DESPAWN_REASON.ARRIVED };
  }
  return { kind: "none" };
}

module.exports = { SHIP_STATE, DESPAWN_REASON, SHIP_ROLE, MINER_LEG, PATROL_LEG, PATROL_ROLES, EXPLORER_LEG, WARP_MODE,
  trafficCapOf, planSpawns, pickRoute, pickProfile, landingPointOf, isExpired, stepShip, pickRole, pickUndockRoute,
  pickIdleGate, pickMinerRoute, pickRatterRoute, safeSpotOf, pickExplorerRoute, pickSites, civilianProfilesByRole,
  PILOT_EXIT, GONE, planPilot, outcomeOf, pilotHullProfilesOf, verifyPilotHulls, arrivalPoseOf };
