"use strict";

const MAX_DETAIL_LENGTH = 200;
const MAX_PLANET_TYPES_PER_CALL = 16;
const GROUP_PLANET = 7;
const GROUP_MOON = 8;

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const detailOf = (err) => String((err && err.message) || err).slice(0, MAX_DETAIL_LENGTH);

function isMoonRow(row) {
  return Number(row.groupID) === GROUP_MOON || row.kind === "moon";
}

function isPlanetRow(row) {
  return row.kind === "planet" || row.groupName === "Planet" || Number(row.groupID) === GROUP_PLANET;
}

function readSystemCelestialsFrom(worldData, systemIds, opts) {
  const refuse = (detail) => ({ ok: false, reason: "CELESTIALS_UNAVAILABLE", detail });
  try {
    if (!worldData || typeof worldData.getCelestialsForSystem !== "function") return refuse("getCelestialsForSystem");
    if (!Array.isArray(systemIds) || !systemIds.every(isId)) return refuse("systemIds");
    const maxSystems = opts && Number.isSafeInteger(opts.maxSystems) && opts.maxSystems >= 0 ? opts.maxSystems : 0;
    const unique = [...new Set(systemIds)];
    const ids = unique.slice(0, maxSystems);
    const systems = new Map();
    for (const systemId of ids) {
      const rows = worldData.getCelestialsForSystem(systemId);
      const moons = new Set();
      const planets = new Map();
      for (const row of Array.isArray(rows) ? rows : []) {
        if (!row || typeof row !== "object") continue;
        const itemId = Number(row.itemID);
        if (!isId(itemId)) continue;
        if (isMoonRow(row)) {
          moons.add(itemId);
        } else if (isPlanetRow(row)) {
          const typeId = Number(row.typeID);
          if (isId(typeId)) planets.set(itemId, typeId);
        }
      }
      systems.set(systemId, {
        moons: [...moons].sort((a, b) => a - b),
        planets: [...planets].sort((a, b) => a[0] - b[0]).map(([planetId, typeId]) => ({ planetId, typeId })),
      });
    }
    return { ok: true, systems, truncated: unique.length > ids.length };
  } catch (err) {
    return refuse(detailOf(err));
  }
}

function readPlanetResourcesFrom(planetStaticData, planetTypeIds) {
  const refuse = (detail) => ({ ok: false, reason: "PLANET_DATA_UNAVAILABLE", detail });
  try {
    if (!planetStaticData || typeof planetStaticData.getPlanetResourceTypeIDs !== "function") {
      return refuse("getPlanetResourceTypeIDs");
    }
    if (!Array.isArray(planetTypeIds) || !planetTypeIds.every(isId)) return refuse("planetTypeIds");
    const unique = [...new Set(planetTypeIds)].sort((a, b) => a - b);
    if (unique.length > MAX_PLANET_TYPES_PER_CALL) return refuse(`more than ${MAX_PLANET_TYPES_PER_CALL} planet types`);
    const byType = new Map();
    for (const typeId of unique) {
      const list = planetStaticData.getPlanetResourceTypeIDs(typeId);
      const p0 = new Set();
      for (const v of Array.isArray(list) ? list : []) {
        const id = Number(v);
        if (isId(id)) p0.add(id);
      }
      byType.set(typeId, [...p0].sort((a, b) => a - b));
    }
    return { ok: true, byType };
  } catch (err) {
    return refuse(detailOf(err));
  }
}

module.exports = { readSystemCelestialsFrom, readPlanetResourcesFrom, MAX_PLANET_TYPES_PER_CALL };
