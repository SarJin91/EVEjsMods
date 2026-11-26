"use strict";

const MAX_NAME_LENGTH = 64;
const MAX_DETAIL_LENGTH = 200;
const GETTERS = Object.freeze(["getSolarSystemByID", "getCelestialsForSystem", "getAsteroidBeltsForSystem",
  "getStationsForSystem", "getStargatesForSystem"]);
const GROUP_KIND = Object.freeze({ 6: "sun", 7: "planet", 8: "moon" });
const CELESTIAL_KINDS = Object.freeze(["sun", "planet", "moon"]);
const KIND_ORDER = Object.freeze({ sun: 0, planet: 1, gate: 2, station: 3, belt: 4, moon: 5 });

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const finite = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

function nameOf(v) {
  return typeof v === "string" && v !== "" ? v.slice(0, MAX_NAME_LENGTH) : null;
}

function rawPosition(row) {
  const p = row.position && typeof row.position === "object" ? row.position : row;
  return { x: finite(p.x), y: finite(p.y), z: finite(p.z) };
}

function celestialKind(row) {
  if (CELESTIAL_KINDS.includes(row.kind)) return row.kind;
  return GROUP_KIND[Number(row.groupID)] || null;
}

function listOf(worldData, name, systemId) {
  const rows = worldData[name](systemId);
  return Array.isArray(rows) ? rows.filter((r) => r && typeof r === "object") : [];
}

const dist2 = (a, b) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2;

function nearestPlanet(raw, planets) {
  let best = null;
  let bestD = Infinity;
  for (const p of planets) {
    const d = dist2(raw, p.raw);
    if (d < bestD || (d === bestD && best !== null && p.itemId < best.itemId)) {
      best = p;
      bestD = d;
    }
  }
  return best ? best.itemId : null;
}

function compareObjects(a, b) {
  return KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.order - b.order || a.itemId - b.itemId;
}

function readSystemInteriorFrom(worldData, systemId, opts) {
  const maxObjects = opts && opts.maxObjects;
  if (!isId(systemId)) return { ok: false, reason: "INVALID_INPUT", detail: "systemId" };
  if (!Number.isSafeInteger(maxObjects) || maxObjects < 1) {
    return { ok: false, reason: "INVALID_INPUT", detail: "maxObjects" };
  }
  if (!worldData || typeof worldData !== "object") return { ok: false, reason: "WORLD_DATA_DRIFT", detail: "worldData" };
  for (const g of GETTERS) {
    if (typeof worldData[g] !== "function") return { ok: false, reason: "WORLD_DATA_DRIFT", detail: g };
  }
  let system;
  let celestials;
  let belts;
  let stations;
  let gates;
  try {
    system = worldData.getSolarSystemByID(systemId);
    if (system === null || system === undefined) return { ok: false, reason: "SYSTEM_UNKNOWN" };
    celestials = listOf(worldData, "getCelestialsForSystem", systemId);
    belts = listOf(worldData, "getAsteroidBeltsForSystem", systemId);
    stations = listOf(worldData, "getStationsForSystem", systemId);
    gates = listOf(worldData, "getStargatesForSystem", systemId);
  } catch (err) {
    return { ok: false, reason: "WORLD_DATA_DRIFT",
      detail: String((err && err.message) || err).slice(0, MAX_DETAIL_LENGTH) };
  }

  const sunRow = celestials.find((r) => celestialKind(r) === "sun");
  const origin = sunRow ? rawPosition(sunRow) : { x: 0, y: 0, z: 0 };
  const items = [];
  const seen = new Set();
  const push = (row, kind, itemId, name, extra) => {
    if (!isId(itemId) || seen.has(itemId)) return null;
    seen.add(itemId);
    const raw = rawPosition(row);
    const typeId = Number(row.typeID);
    const item = { itemId, kind, name: nameOf(name), typeId: isId(typeId) ? typeId : null,
      x: raw.x - origin.x, y: -(raw.z - origin.z), parentId: null, toSystemId: null,
      raw, orbitId: Number(row.orbitID), order: 0, ...extra };
    items.push(item);
    return item;
  };
  for (const r of celestials) {
    const kind = celestialKind(r);
    if (!kind) continue;
    const idx = Number(r.celestialIndex);
    push(r, kind, Number(r.itemID), r.itemName, { order: kind === "planet" && Number.isFinite(idx) ? idx : 0 });
  }
  for (const r of belts) push(r, "belt", Number(r.itemID), r.itemName);
  for (const r of stations) push(r, "station", Number(r.stationID), r.stationName);
  for (const r of gates) {
    const to = Number(r.destinationSolarSystemID);
    push(r, "gate", Number(r.itemID), r.itemName, { toSystemId: isId(to) ? to : null });
  }

  const planets = items.filter((o) => o.kind === "planet");
  const planetIds = new Set(planets.map((p) => p.itemId));
  for (const o of items) {
    if (o.kind === "moon" || o.kind === "belt") {
      o.parentId = planetIds.has(o.orbitId) ? o.orbitId : nearestPlanet(o.raw, planets);
    } else if (o.kind === "station") {
      o.parentId = seen.has(o.orbitId) && o.orbitId !== o.itemId ? o.orbitId : null;
    }
  }
  items.sort(compareObjects);
  const truncated = items.length > maxObjects;
  const objects = items.slice(0, maxObjects).map((o) => Object.freeze({ itemId: o.itemId, kind: o.kind,
    name: o.name, typeId: o.typeId, x: o.x, y: o.y, parentId: o.parentId, toSystemId: o.toSystemId }));
  return { ok: true, system: { id: systemId, name: nameOf(system.solarSystemName), origin }, objects, truncated };
}

module.exports = { readSystemInteriorFrom, MAX_NAME_LENGTH };
