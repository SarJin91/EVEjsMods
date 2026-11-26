"use strict";

const SEC_CLASSES = Object.freeze(["highsec", "lowsec", "nullsec", "wormhole", "other"]);
const FALLBACK_SEC_CLASS = "other";
const DIR_UP = 1;
const DIR_DOWN = 2;
const DIR_BOTH = DIR_UP | DIR_DOWN;

const EMPTY = Object.freeze([]);

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function ascending(a, b) {
  return a - b;
}

function frozenSorted(values) {
  return Object.freeze([...values].sort(ascending));
}

function pushTo(map, key, value) {
  const list = map.get(key);
  if (list === undefined) map.set(key, [value]);
  else list.push(value);
}

function freezeIndex(map) {
  const out = new Map();
  for (const [key, values] of map) out.set(key, frozenSorted(values));
  return out;
}

function nameIn(names, id) {
  let value = null;
  if (names instanceof Map) value = names.get(id);
  else if (names && typeof names === "object" && Object.prototype.hasOwnProperty.call(names, id)) value = names[id];
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function namesFor(ids, names) {
  const out = new Map();
  for (const id of ids) {
    const name = nameIn(names, id);
    if (name !== null) out.set(id, name);
  }
  return out;
}

function toVertex(system, id) {
  const secClass = SEC_CLASSES.includes(system.secClass) ? system.secClass : FALLBACK_SEC_CLASS;
  return Object.freeze({
    id,
    name: system.name == null ? "" : String(system.name),
    regionId: num(system.regionId),
    constellationId: num(system.constellationId),
    security: num(system.security),
    trueSecurity: num(system.trueSecurity),
    secClass,
    factionId: num(system.factionId),
    position: positionOf(system.position),
  });
}

function positionOf(value) {
  if (!value || typeof value !== "object") return null;
  const { x, y, z } = value;
  if (![x, y, z].every((v) => typeof v === "number" && Number.isFinite(v))) return null;
  return Object.freeze({ x, y, z });
}

function buildUniverseGraph(map) {
  if (!map || !Array.isArray(map.systems) || !Array.isArray(map.gates)) {
    return { ok: false, reason: "SNAPSHOT_INVALID" };
  }
  const byId = new Map();
  let invalidSystems = 0;
  for (const system of map.systems) {
    const id = Number(system && system.id);
    if (!Number.isSafeInteger(id) || id <= 0 || byId.has(id)) {
      invalidSystems += 1;
      continue;
    }
    byId.set(id, toVertex(system, id));
  }
  if (byId.size === 0) return { ok: false, reason: "GRAPH_EMPTY" };

  const pairs = new Map();
  let invalidEdges = 0;
  for (const gate of map.gates) {
    const from = Number(gate && gate.fromSystemId);
    const to = Number(gate && gate.toSystemId);
    if (from === to || !byId.has(from) || !byId.has(to)) {
      invalidEdges += 1;
      continue;
    }
    const low = Math.min(from, to);
    const high = Math.max(from, to);
    const key = `${low}:${high}`;
    pairs.set(key, (pairs.get(key) || 0) | (from === low ? DIR_UP : DIR_DOWN));
  }

  const neighborLists = new Map();
  let oneSidedEdges = 0;
  for (const [key, dirs] of pairs) {
    if (dirs !== DIR_BOTH) oneSidedEdges += 1;
    const sep = key.indexOf(":");
    const low = Number(key.slice(0, sep));
    const high = Number(key.slice(sep + 1));
    pushTo(neighborLists, low, high);
    pushTo(neighborLists, high, low);
  }
  const neighbors = freezeIndex(neighborLists);

  const regionLists = new Map();
  const constellationLists = new Map();
  const secClassLists = new Map(SEC_CLASSES.map((c) => [c, []]));
  const constellationSets = new Map();
  let systemsWithoutPosition = 0;
  for (const vertex of byId.values()) {
    if (vertex.position === null) systemsWithoutPosition += 1;
    pushTo(regionLists, vertex.regionId, vertex.id);
    pushTo(constellationLists, vertex.constellationId, vertex.id);
    secClassLists.get(vertex.secClass).push(vertex.id);
    let set = constellationSets.get(vertex.regionId);
    if (set === undefined) {
      set = new Set();
      constellationSets.set(vertex.regionId, set);
    }
    set.add(vertex.constellationId);
  }
  const systemsByRegion = freezeIndex(regionLists);
  const systemsByConstellation = freezeIndex(constellationLists);
  const systemsBySecClass = freezeIndex(secClassLists);
  const constellationsByRegion = new Map();
  for (const [regionId, set] of constellationSets) constellationsByRegion.set(regionId, frozenSorted(set));
  const systemIds = frozenSorted(byId.keys());
  const regionIds = frozenSorted(systemsByRegion.keys());

  const regionNames = namesFor(regionIds, map.regionNames);
  const constellationIds = frozenSorted(systemsByConstellation.keys());
  const constellationNames = namesFor(constellationIds, map.constellationNames);

  const stats = Object.freeze({
    systems: byId.size,
    edges: pairs.size,
    regions: systemsByRegion.size,
    constellations: systemsByConstellation.size,
    regionsWithoutName: regionIds.length - regionNames.size,
    constellationsWithoutName: constellationIds.length - constellationNames.size,
    invalidSystems,
    invalidEdges,
    oneSidedEdges,
    systemsWithoutPosition,
    bySecClass: Object.freeze(Object.fromEntries(SEC_CLASSES.map((c) => [c, systemsBySecClass.get(c).length]))),
  });

  const lookup = (index, key) => index.get(Number(key)) || EMPTY;
  const graph = Object.freeze({
    hasSystem: (id) => byId.has(Number(id)),
    getSystem: (id) => byId.get(Number(id)) || null,
    getNeighbors(id) {
      const n = Number(id);
      if (!byId.has(n)) return null;
      return neighbors.get(n) || EMPTY;
    },
    getSystemIds: () => systemIds,
    getRegionIds: () => regionIds,
    getSystemsInRegion: (regionId) => lookup(systemsByRegion, regionId),
    getSystemsInConstellation: (constellationId) => lookup(systemsByConstellation, constellationId),
    getConstellationsInRegion: (regionId) => lookup(constellationsByRegion, regionId),
    getSystemsBySecClass: (secClass) => systemsBySecClass.get(String(secClass)) || EMPTY,
    getRegionName: (regionId) => regionNames.get(Number(regionId)) || null,
    getConstellationName: (constellationId) => constellationNames.get(Number(constellationId)) || null,
    stats,
  });
  return { ok: true, graph, stats };
}

module.exports = { SEC_CLASSES, buildUniverseGraph };
