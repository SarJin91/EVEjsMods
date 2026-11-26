"use strict";

const { deriveSeed, deterministicUnit } = require("../util/rng");
const { sweepOrder } = require("../playerHunt/policy");

const PERMILLE = 1000;
const SUN_KIND = "sun";
const MODE_PATROL = "PATROL";
const MODE_CAMP = "GATE_CAMP";
const X_AXIS = Object.freeze({ x: 1, y: 0, z: 0 });

const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const isPoint = (p) => Boolean(p) && isNum(p.x) && isNum(p.y) && isNum(p.z);
const seedOf = (v) => (Number.isSafeInteger(v) ? v >>> 0 : 0);
const byFleetId = (a, b) => (a.fleetId < b.fleetId ? -1 : a.fleetId > b.fleetId ? 1 : 0);

const unit = (seed, ...parts) => deterministicUnit(deriveSeed(seedOf(seed), ...parts));

function pickPatrolFleets(fleets, o) {
  if (!Array.isArray(fleets) || !o) return [];
  const roles = Array.isArray(o.roles) ? o.roles : [];
  const excluded = Array.isArray(o.excludedFactions) ? o.excludedFactions : [];
  const hasKind = (factionId) => {
    try {
      const kind = typeof o.factionKindOf === "function" ? o.factionKindOf(factionId) : null;
      return typeof kind === "string" && kind !== "";
    } catch (_err) {
      return false;
    }
  };
  return fleets.filter((f) => f && f.state === "IDLE" && (f.operationId === null || f.operationId === undefined)
    && f.refitPending !== true && roles.includes(f.fleetRole) && Number.isSafeInteger(f.shipCount)
    && f.shipCount >= 1 && !excluded.includes(f.factionId) && hasKind(f.factionId)).sort(byFleetId);
}

function chooseMode({ fleetSeed, kind, gates, campsInSystem } = {}, { campPermille, maxCampsPerSystem } = {}) {
  if (!Array.isArray(gates) || gates.length === 0) return MODE_PATROL;
  const max = Number.isSafeInteger(maxCampsPerSystem) && maxCampsPerSystem > 0 ? maxCampsPerSystem : 0;
  const camps = Number.isSafeInteger(campsInSystem) && campsInSystem > 0 ? campsInSystem : 0;
  if (camps >= max) return MODE_PATROL;
  const permille = campPermille && typeof kind === "string"
    && Object.prototype.hasOwnProperty.call(campPermille, kind) && Number.isSafeInteger(campPermille[kind])
    ? campPermille[kind] : 0;
  const roll = Math.floor(unit(fleetSeed, "mode", 0) * PERMILLE);
  return roll < permille ? MODE_CAMP : MODE_PATROL;
}

function distSqOf(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return (dx * dx) + (dy * dy) + (dz * dz);
}

function borderPool(sorted, c) {
  const here = c && c.here ? c.here : { secClass: null, factionId: null };
  const border = sorted.filter((g) => {
    if (!Number.isSafeInteger(g.toSystemId) || typeof c.systemOf !== "function") return false;
    let info = null;
    try {
      info = c.systemOf(g.toSystemId);
    } catch (_err) {
      info = null;
    }
    if (!info) return false;
    const herFaction = info.factionId === undefined ? null : info.factionId;
    const hereFaction = here.factionId === undefined ? null : here.factionId;
    return info.secClass !== here.secClass || herFaction !== hereFaction;
  });
  return border.length > 0 ? border : sorted;
}

function pickCampGate(gates, c, fleetSeed) {
  if (!Array.isArray(gates)) return null;
  const sorted = gates.filter((g) => g && Number.isSafeInteger(g.itemId) && isPoint(g.position))
    .sort((a, b) => a.itemId - b.itemId);
  if (sorted.length === 0) return null;
  const seed = seedOf(fleetSeed);
  const conf = c || {};
  if (conf.policy === "random") return sorted[seed % sorted.length];
  if (conf.policy === "arrival" && isPoint(conf.triggerPos)) {
    const r = isNum(conf.gridRadiusMeters) && conf.gridRadiusMeters > 0 ? conf.gridRadiusMeters : 0;
    let best = null;
    let bestD = Infinity;
    for (const g of sorted) {
      const d = distSqOf(g.position, conf.triggerPos);
      if (d <= r * r && d < bestD) {
        best = g;
        bestD = d;
      }
    }
    if (best !== null) return best;
  }
  const pool = borderPool(sorted, conf);
  return pool[seed % pool.length];
}

function patrolRoute(objects, kinds, rowSeed) {
  if (!Array.isArray(objects) || !Array.isArray(kinds)) return [];
  const valid = objects.filter((o) => o && kinds.includes(o.kind) && Number.isSafeInteger(o.itemId));
  const byKey = new Map();
  for (const o of valid) {
    const key = `${o.kind}:${o.itemId}`;
    if (!byKey.has(key)) byKey.set(key, o);
  }
  let head = null;
  if (kinds[0] === SUN_KIND) {
    for (const o of valid) {
      if (o.kind === SUN_KIND && (head === null || o.itemId < head.itemId)) head = o;
    }
  }
  const rest = head === null ? valid : valid.filter((o) => o !== head);
  const ordered = sweepOrder(rest, kinds, seedOf(rowSeed)).map((o) => byKey.get(`${o.kind}:${o.itemId}`));
  return head === null ? ordered : [head, ...ordered];
}

function along(pos, dir, distance) {
  return { x: pos.x + (dir.x * distance), y: pos.y + (dir.y * distance), z: pos.z + (dir.z * distance) };
}

function directionOf(v, sign) {
  const len = Math.sqrt((v.x * v.x) + (v.y * v.y) + (v.z * v.z));
  if (!(len > 0) || !isNum(len)) return X_AXIS;
  return { x: (sign * v.x) / len, y: (sign * v.y) / len, z: (sign * v.z) / len };
}

function standoffPoint(object, clearanceMeters) {
  if (!object || !isPoint(object.position)) return null;
  const radius = isNum(object.radius) && object.radius > 0 ? object.radius : 0;
  const clearance = isNum(clearanceMeters) && clearanceMeters > 0 ? clearanceMeters : 0;
  return along(object.position, directionOf(object.position, 1), radius + clearance);
}

function campPoint(gate, standoffMeters) {
  if (!gate || !isPoint(gate.position)) return null;
  const d = isNum(standoffMeters) && standoffMeters > 0 ? standoffMeters : 0;
  return along(gate.position, directionOf(gate.position, -1), d);
}

function rotateToNearest(route, position) {
  if (!Array.isArray(route)) return [];
  if (!isPoint(position)) return [...route];
  let best = -1;
  let bestD = Infinity;
  for (let i = 0; i < route.length; i += 1) {
    const o = route[i];
    const p = o && isPoint(o.point) ? o.point : o && isPoint(o.position) ? o.position : null;
    if (p === null) continue;
    const dx = p.x - position.x;
    const dy = p.y - position.y;
    const dz = p.z - position.z;
    const d = (dx * dx) + (dy * dy) + (dz * dz);
    if (d < bestD) {
      best = i;
      bestD = d;
    }
  }
  if (best <= 0) return [...route];
  return [...route.slice(best), ...route.slice(0, best)];
}

module.exports = { pickPatrolFleets, chooseMode, pickCampGate, patrolRoute, standoffPoint, campPoint,
  rotateToNearest };
