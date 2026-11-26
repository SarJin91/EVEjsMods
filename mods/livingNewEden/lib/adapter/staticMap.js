"use strict";

const { SYSTEM_ID_SPACES, SEC_CLASS_BY_BAND } = require("./staticMapData");

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function inSpace(id, space) {
  return id >= space.min && id <= space.max;
}

function messageOf(err) {
  return String((err && err.message) || err);
}

function classifySystem(row, band) {
  const id = num(row && row.solarSystemID);
  if (inSpace(id, SYSTEM_ID_SPACES.wormhole)) return "wormhole";
  if (!inSpace(id, SYSTEM_ID_SPACES.known)) return "other";
  const secClass = SEC_CLASS_BY_BAND[band.getSystemSecurityClass(row)];
  return secClass === undefined ? "other" : secClass;
}

function toPosition(value) {
  if (!value || typeof value !== "object") return null;
  const { x, y, z } = value;
  if (![x, y, z].every((v) => typeof v === "number" && Number.isFinite(v))) return null;
  return Object.freeze({ x, y, z });
}

function toSystem(row, band) {
  return {
    id: num(row && row.solarSystemID),
    name: row && row.solarSystemName != null ? String(row.solarSystemName) : "",
    regionId: num(row && row.regionID),
    constellationId: num(row && row.constellationID),
    security: num(band.getSolarSystemPseudoSecurity(row)),
    trueSecurity: num(row && row.security),
    secClass: classifySystem(row, band),
    factionId: num(row && row.factionID),
    position: toPosition(row && row.position),
  };
}

function nameOf(value) {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function collectNames(stations, primary = null) {
  const regionNames = new Map(primary && primary.regions instanceof Map ? primary.regions : []);
  const constellationNames = new Map(primary && primary.constellations instanceof Map ? primary.constellations : []);
  for (const row of Array.isArray(stations) ? stations : []) {
    const regionId = num(row && row.regionID);
    const regionName = nameOf(row && row.regionName);
    if (regionId > 0 && regionName !== null && !regionNames.has(regionId)) regionNames.set(regionId, regionName);
    const constellationId = num(row && row.constellationID);
    const constellationName = nameOf(row && row.constellationName);
    if (constellationId > 0 && constellationName !== null && !constellationNames.has(constellationId)) {
      constellationNames.set(constellationId, constellationName);
    }
  }
  return { regionNames, constellationNames };
}

function toGate(row) {
  return {
    gateId: num(row && row.itemID),
    fromSystemId: num(row && row.solarSystemID),
    toSystemId: num(row && row.destinationSolarSystemID),
  };
}

function readStaticMapFrom(worldData, band, options = {}) {
  if (!worldData || typeof worldData.ensureLoaded !== "function") {
    return { ok: false, reason: "STATIC_SHAPE_DRIFT", detail: "worldData.ensureLoaded" };
  }
  if (!band || typeof band.getSystemSecurityClass !== "function"
    || typeof band.getSolarSystemPseudoSecurity !== "function") {
    return { ok: false, reason: "STATIC_SHAPE_DRIFT", detail: "systemSecurityBand" };
  }
  let cache;
  try {
    cache = worldData.ensureLoaded();
  } catch (err) {
    return { ok: false, reason: "STATIC_READ_FAILED", detail: messageOf(err) };
  }
  const solarSystems = cache && cache.solarSystems;
  const stargates = cache && cache.stargates;
  if (!Array.isArray(solarSystems)) return { ok: false, reason: "STATIC_SHAPE_DRIFT", detail: "solarSystems" };
  if (!Array.isArray(stargates)) return { ok: false, reason: "STATIC_SHAPE_DRIFT", detail: "stargates" };
  if (solarSystems.length === 0) return { ok: false, reason: "STATIC_TABLE_EMPTY", detail: "solarSystems" };
  if (stargates.length === 0) return { ok: false, reason: "STATIC_TABLE_EMPTY", detail: "stargates" };
  try {
    const systems = solarSystems.map((row) => toSystem(row, band));
    const gates = stargates.map(toGate);
    if (!gates.some((gate) => gate.toSystemId > 0)) {
      return { ok: false, reason: "STATIC_SHAPE_DRIFT", detail: "stargates.destinationSolarSystemID" };
    }
    const mapNames = options && options.mapNames;
    const primary = mapNames && mapNames.ok === true ? mapNames : null;
    const { regionNames, constellationNames } = collectNames(cache.stations, primary);
    const namesWarning = mapNames && mapNames.ok === false
      ? { reason: String(mapNames.reason), detail: mapNames.detail ? String(mapNames.detail) : null } : null;
    return { ok: true, map: { systems, gates, regionNames, constellationNames,
      nameSource: primary ? `mapNames(${primary.source})+stations` : "stations", namesWarning,
      source: "worldData" } };
  } catch (err) {
    return { ok: false, reason: "STATIC_READ_FAILED", detail: messageOf(err) };
  }
}

module.exports = { classifySystem, collectNames, readStaticMapFrom, toPosition };
