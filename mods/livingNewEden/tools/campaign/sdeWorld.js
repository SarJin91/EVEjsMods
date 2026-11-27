"use strict";

const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

const SOLAR_SYSTEM_ID_RE = /"solarSystemID": (\d+)/;

function readJsonl(file) {
  const out = [];
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (line.trim() !== "") out.push(JSON.parse(line));
  }
  return out;
}

const toInt = (v, fallback = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
};
const enName = (name, fallback = null) => (name && typeof name.en === "string" && name.en !== "" ? name.en : fallback);
const vector = (v) => (v && typeof v === "object" ? { x: Number(v.x), y: Number(v.y), z: Number(v.z) } : null);
const optionalInt = (v) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? null : Math.trunc(Number(v)));

function eachJsonlLine(file, fn) {
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (line.trim() !== "") fn(JSON.parse(line));
  }
}

const ROMAN = Object.freeze([[1000, "M"], [900, "CM"], [500, "D"], [400, "CD"], [100, "C"], [90, "XC"], [50, "L"],
  [40, "XL"], [10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"]]);

function roman(number) {
  let value = toInt(number, 0);
  if (value <= 0) return "";
  let out = "";
  for (const [n, s] of ROMAN) {
    while (value >= n) {
      out += s;
      value -= n;
    }
  }
  return out;
}

function pushTo(map, id, row) {
  const list = map.get(id);
  if (list) list.push(row);
  else map.set(id, [row]);
}

function sortedBy(map, key) {
  for (const list of map.values()) list.sort((a, b) => a[key] - b[key]);
  return map;
}

function buildStatics(sdeDir, systemById, stargatesRaw, stationsRaw) {
  const sysName = (id) => {
    const s = systemById.get(toInt(id));
    return (s && s.solarSystemName) || "System";
  };
  const fileOf = (name) => path.join(sdeDir, name);
  const celestialsBySystem = new Map();
  const beltsRowsBySystem = new Map();
  const gatesBySystem = new Map();
  const stationsBySystem = new Map();
  const counts = { suns: 0, planets: 0, belts: 0, gates: 0, stations: 0 };
  if (fs.existsSync(fileOf("mapStars.jsonl"))) {
    eachJsonlLine(fileOf("mapStars.jsonl"), (raw) => {
      const solarSystemID = toInt(raw.solarSystemID);
      pushTo(celestialsBySystem, solarSystemID, Object.freeze({ itemID: toInt(raw._key), typeID: toInt(raw.typeID),
        groupID: 6, solarSystemID, orbitID: null, position: Object.freeze({ x: 0, y: 0, z: 0 }),
        itemName: `${sysName(solarSystemID)} - Star`, celestialIndex: null, orbitIndex: null, kind: "sun" }));
      counts.suns += 1;
    });
  }
  const planetNameById = new Map();
  if (fs.existsSync(fileOf("mapPlanets.jsonl"))) {
    eachJsonlLine(fileOf("mapPlanets.jsonl"), (raw) => {
      const solarSystemID = toInt(raw.solarSystemID);
      const itemID = toInt(raw._key);
      const itemName = `${sysName(solarSystemID)} ${roman(raw.celestialIndex) || itemID}`;
      planetNameById.set(itemID, itemName);
      pushTo(celestialsBySystem, solarSystemID, Object.freeze({ itemID, typeID: toInt(raw.typeID), groupID: 7,
        solarSystemID, orbitID: toInt(raw.orbitID, 0) || null, position: vector(raw.position), itemName,
        celestialIndex: optionalInt(raw.celestialIndex), orbitIndex: optionalInt(raw.orbitIndex), kind: "planet" }));
      counts.planets += 1;
    });
  }
  if (fs.existsSync(fileOf("mapAsteroidBelts.jsonl"))) {
    eachJsonlLine(fileOf("mapAsteroidBelts.jsonl"), (raw) => {
      const solarSystemID = toInt(raw.solarSystemID);
      const itemID = toInt(raw._key);
      const orbitID = toInt(raw.orbitID, 0) || null;
      const orbitIndex = optionalInt(raw.orbitIndex);
      const parentName = planetNameById.get(orbitID) || `${sysName(solarSystemID)} ${orbitID || ""}`.trim();
      pushTo(beltsRowsBySystem, solarSystemID, Object.freeze({ itemID, typeID: toInt(raw.typeID), groupID: 9,
        solarSystemID, orbitID, position: vector(raw.position),
        itemName: `${parentName} - Asteroid Belt ${orbitIndex || itemID}`,
        celestialIndex: optionalInt(raw.celestialIndex), orbitIndex, kind: "asteroidBelt" }));
      counts.belts += 1;
    });
  }
  for (const raw of stargatesRaw) {
    const solarSystemID = toInt(raw.solarSystemID);
    const destinationSolarSystemID = toInt(raw.destination && raw.destination.solarSystemID);
    const dest = systemById.get(destinationSolarSystemID);
    pushTo(gatesBySystem, solarSystemID, Object.freeze({ itemID: toInt(raw._key), typeID: toInt(raw.typeID),
      solarSystemID, itemName: `Stargate (${(dest && dest.solarSystemName) || ""})`, position: vector(raw.position),
      destinationID: toInt(raw.destination && raw.destination.stargateID), destinationSolarSystemID }));
    counts.gates += 1;
  }
  for (const raw of stationsRaw) {
    const solarSystemID = toInt(raw.solarSystemID);
    const stationID = toInt(raw._key);
    pushTo(stationsBySystem, solarSystemID, Object.freeze({ stationID, itemID: stationID,
      stationTypeID: toInt(raw.typeID), corporationID: toInt(raw.ownerID), solarSystemID, stationName: null,
      position: vector(raw.position), orbitID: toInt(raw.orbitID, 0) || null }));
    counts.stations += 1;
  }
  sortedBy(celestialsBySystem, "itemID");
  sortedBy(beltsRowsBySystem, "itemID");
  sortedBy(gatesBySystem, "itemID");
  sortedBy(stationsBySystem, "stationID");
  return {
    getters: {
      getStargatesForSystem: (id) => [...(gatesBySystem.get(toInt(id)) || [])],
      getStationsForSystem: (id) => [...(stationsBySystem.get(toInt(id)) || [])],
      getAsteroidBeltsForSystem: (id) => [...(beltsRowsBySystem.get(toInt(id)) || [])],
      getCelestialsForSystem: (id) => [...(celestialsBySystem.get(toInt(id)) || [])],
    },
    counts: Object.freeze(counts),
  };
}

function buildSdeWorld(sdeDir, opts) {
  const withStatics = Boolean(opts && opts.statics === true);
  if (typeof sdeDir !== "string" || !fs.existsSync(path.join(sdeDir, "mapSolarSystems.jsonl"))) {
    return { ok: false, reason: "SDE_UNAVAILABLE", detail: String(sdeDir) };
  }
  try {
    const regions = new Map(readJsonl(path.join(sdeDir, "mapRegions.jsonl")).map((r) => [toInt(r._key), r]));
    const constellations = new Map(readJsonl(path.join(sdeDir, "mapConstellations.jsonl"))
      .map((r) => [toInt(r._key), r]));
    const solarSystems = readJsonl(path.join(sdeDir, "mapSolarSystems.jsonl")).map((raw) => {
      const constellation = constellations.get(toInt(raw.constellationID)) || {};
      const region = regions.get(toInt(raw.regionID)) || {};
      return {
        regionID: toInt(raw.regionID),
        constellationID: toInt(raw.constellationID),
        solarSystemID: toInt(raw._key),
        solarSystemName: enName(raw.name, `System ${raw._key}`),
        position: vector(raw.position),
        security: Number.isFinite(Number(raw.securityStatus)) ? Number(raw.securityStatus) : 0,
        factionID: toInt(raw.factionID, toInt(constellation.factionID, toInt(region.factionID, 0))),
        radius: Number(raw.radius) || 0,
        securityClass: raw.securityClass || "",
      };
    });
    const systemById = new Map(solarSystems.map((s) => [s.solarSystemID, s]));
    const stargatesRaw = readJsonl(path.join(sdeDir, "mapStargates.jsonl"));
    const stationsRaw = readJsonl(path.join(sdeDir, "npcStations.jsonl"));
    const stargates = stargatesRaw.map((raw) => ({
      itemID: toInt(raw._key),
      solarSystemID: toInt(raw.solarSystemID),
      destinationSolarSystemID: toInt(raw.destination && raw.destination.solarSystemID),
    }));
    const stations = stationsRaw.map((raw) => {
      const system = systemById.get(toInt(raw.solarSystemID)) || {};
      return {
        stationID: toInt(raw._key),
        stationTypeID: toInt(raw.typeID),
        corporationID: toInt(raw.ownerID),
        solarSystemID: toInt(raw.solarSystemID),
        constellationID: system.constellationID || 0,
        regionID: system.regionID || 0,
        stationName: null,
        position: vector(raw.position),
      };
    });
    const stationById = new Map(stations.map((s) => [s.stationID, s]));
    const beltsBySystem = new Map();
    let beltCount = 0;
    const beltsFile = path.join(sdeDir, "mapAsteroidBelts.jsonl");
    if (fs.existsSync(beltsFile)) {
      for (const line of fs.readFileSync(beltsFile, "utf8").split(/\r?\n/)) {
        const m = SOLAR_SYSTEM_ID_RE.exec(line);
        if (!m) continue;
        const id = Number(m[1]);
        beltsBySystem.set(id, (beltsBySystem.get(id) || 0) + 1);
        beltCount += 1;
      }
    }
    let sdeBuild = null;
    const buildFile = path.join(sdeDir, "_sde.jsonl");
    if (fs.existsSync(buildFile)) {
      const row = readJsonl(buildFile).find((r) => r._key === "sde");
      if (row && Number.isSafeInteger(row.buildNumber) && row.buildNumber > 0) sdeBuild = row.buildNumber;
    }
    const cache = Object.freeze({ solarSystems, stargates, stations });
    const statics = withStatics ? buildStatics(sdeDir, systemById, stargatesRaw, stationsRaw) : null;
    const worldData = Object.freeze({
      ensureLoaded: () => cache,
      getSolarSystemByID: (id) => systemById.get(toInt(id)) || null,
      getStationByID: (id) => stationById.get(toInt(id)) || null,
      ...(statics ? statics.getters : {}),
    });
    const asteroidData = Object.freeze({
      getBeltsForSystem: (id) => Array.from({ length: beltsBySystem.get(toInt(id)) || 0 }, () => ({})),
    });
    const base = { worldData, asteroidData, sdeBuild, systemCount: solarSystems.length,
      stationCount: stations.length, beltCount };
    return { ok: true, world: Object.freeze(statics ? { ...base, statics: statics.counts } : base) };
  } catch (err) {
    return { ok: false, reason: "SDE_READ_FAILED", detail: String((err && err.message) || err) };
  }
}

function cachedModule(filename, exports) {
  const m = new Module(filename, null);
  m.filename = filename;
  m.exports = exports;
  m.loaded = true;
  return m;
}

function loadPiratePolicy(serverSrc, worldData) {
  try {
    const worldDataPath = require.resolve(path.join(serverSrc, "space", "worldData"));
    const policyPath = require.resolve(path.join(serverSrc, "space", "npc", "pirateFactionPolicy"));
    const saved = { worldData: require.cache[worldDataPath], policy: require.cache[policyPath] };
    delete require.cache[policyPath];
    require.cache[worldDataPath] = cachedModule(worldDataPath, worldData);
    try {
      return { ok: true, policy: require(policyPath) };
    } finally {
      if (saved.worldData) require.cache[worldDataPath] = saved.worldData;
      else delete require.cache[worldDataPath];
      if (saved.policy) require.cache[policyPath] = saved.policy;
      else delete require.cache[policyPath];
    }
  } catch (err) {
    return { ok: false, reason: "PIRATE_POLICY_UNAVAILABLE", detail: String((err && err.message) || err) };
  }
}

function loadSecurityBand(serverSrc) {
  try {
    return { ok: true, band: require(path.join(serverSrc, "space", "runtime", "systemSecurityBand.js")) };
  } catch (err) {
    return { ok: false, reason: "SECURITY_BAND_UNAVAILABLE", detail: String((err && err.message) || err) };
  }
}

module.exports = { buildSdeWorld, loadPiratePolicy, loadSecurityBand, readJsonl };
