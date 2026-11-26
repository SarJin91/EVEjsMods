"use strict";

const MAX_DETAIL_LENGTH = 200;
const MAX_NAME_LENGTH = 100;

const isId = (v) => Number.isSafeInteger(v) && v > 0;

function positionOf(p) {
  if (!p || typeof p !== "object") return null;
  const out = { x: Number(p.x), y: Number(p.y), z: Number(p.z) };
  return Number.isFinite(out.x) && Number.isFinite(out.y) && Number.isFinite(out.z) ? out : null;
}

function readNpcStationsFrom(worldData, stationIds) {
  if (!worldData || typeof worldData.getStationByID !== "function") {
    return { ok: false, reason: "WORLD_DATA_DRIFT", detail: "getStationByID" };
  }
  if (!Array.isArray(stationIds) || !stationIds.every(isId)) {
    return { ok: false, reason: "NPC_STATIONS_FAILED", detail: "stationIds" };
  }
  const stations = new Map();
  try {
    for (const id of stationIds) {
      const row = worldData.getStationByID(id);
      if (!row || typeof row !== "object") continue;
      const systemId = Number(row.solarSystemID);
      if (!isId(systemId)) continue;
      const corporationId = Number(row.corporationID);
      const typeId = Number(row.stationTypeID);
      const name = typeof row.stationName === "string" && row.stationName !== ""
        ? row.stationName.slice(0, MAX_NAME_LENGTH) : null;
      stations.set(id, Object.freeze({ stationId: id, systemId,
        corporationId: isId(corporationId) ? corporationId : null, typeId: isId(typeId) ? typeId : null, name,
        position: positionOf(row.position) }));
    }
  } catch (err) {
    return { ok: false, reason: "NPC_STATIONS_FAILED",
      detail: String((err && err.message) || err).slice(0, MAX_DETAIL_LENGTH) };
  }
  return { ok: true, stations };
}

function listNpcStationsInSystemFrom(worldData, systemId) {
  if (!worldData || typeof worldData.getStationsForSystem !== "function") {
    return { ok: false, reason: "WORLD_DATA_DRIFT", detail: "getStationsForSystem" };
  }
  if (!isId(systemId)) return { ok: false, reason: "NPC_STATIONS_FAILED", detail: "systemId" };
  const stations = [];
  try {
    const rows = worldData.getStationsForSystem(systemId);
    if (!Array.isArray(rows)) return { ok: false, reason: "NPC_STATIONS_FAILED", detail: "not an array" };
    for (const row of rows) {
      if (!row || typeof row !== "object") continue;
      const stationId = Number(row.stationID);
      if (!isId(stationId)) continue;
      const corporationId = Number(row.corporationID);
      const name = typeof row.stationName === "string" && row.stationName !== ""
        ? row.stationName.slice(0, MAX_NAME_LENGTH) : null;
      stations.push(Object.freeze({ stationId, corporationId: isId(corporationId) ? corporationId : null, name }));
    }
  } catch (err) {
    return { ok: false, reason: "NPC_STATIONS_FAILED",
      detail: String((err && err.message) || err).slice(0, MAX_DETAIL_LENGTH) };
  }
  stations.sort((a, b) => a.stationId - b.stationId);
  return { ok: true, stations };
}

module.exports = { readNpcStationsFrom, listNpcStationsInSystemFrom };
