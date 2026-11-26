"use strict";

const PATCHED = Symbol.for("evejs.skyhookOrphanFix.patchedGet");
const PLANET_GROUP_ID = 7;

const patchedSnapshots = new WeakSet();

function isPlanetCelestial(celestial) {
  if (!celestial || typeof celestial !== "object") return false;
  return Number(celestial.groupID) === PLANET_GROUP_ID || String(celestial.kind).toLowerCase() === "planet";
}

function createEmptyDefinitionResolver(getCelestial) {
  const cache = new Map();
  function emptyDefinitionFor(planetID) {
    const id = Number(planetID);
    if (!Number.isSafeInteger(id) || id <= 0) return undefined;
    if (cache.has(id)) return cache.get(id);
    const celestial = getCelestial(id);
    if (!isPlanetCelestial(celestial)) return undefined;
    const definition = Object.freeze({
      planetID: id,
      solarSystemID: Number(celestial.solarSystemID || 0) || 0,
      power: 0,
      workforce: 0,
      reagentDefinitions: Object.freeze([]),
    });
    cache.set(id, definition);
    return definition;
  }
  emptyDefinitionFor.cacheSize = () => cache.size;
  return emptyDefinitionFor;
}

function patchSnapshot(snapshot, emptyDefinitionFor, onError = () => {}) {
  if (!snapshot || typeof snapshot !== "object") return { ok: false, reason: "no-snapshot" };
  if (patchedSnapshots.has(snapshot)) return { ok: true, reason: "already-patched" };
  const map = snapshot.planetDefinitionsByPlanetID;
  if (!map || typeof map.get !== "function") return { ok: false, reason: "no-planet-map" };
  if (map.get[PATCHED]) {
    patchedSnapshots.add(snapshot);
    return { ok: true, reason: "already-patched" };
  }

  const vendorGet = map.get;
  let lookupFailures = 0;
  const get = function get(planetID) {
    const value = vendorGet.apply(this, arguments);
    if (value !== undefined) return value;
    if (typeof planetID === "string") {
      const numeric = Number(planetID);
      if (Number.isFinite(numeric)) {
        const real = vendorGet.call(this, numeric);
        if (real !== undefined) return real;
      }
    }
    try {
      return emptyDefinitionFor(planetID);
    } catch (error) {
      lookupFailures += 1;
      if (lookupFailures === 1) onError("empty planet definition lookup failed - vanilla miss", error);
      return undefined;
    }
  };
  Object.defineProperty(get, PATCHED, { value: true });
  Object.defineProperty(map, "get", { value: get, writable: true, configurable: true, enumerable: false });
  patchedSnapshots.add(snapshot);
  return { ok: true };
}

module.exports = {
  PATCHED,
  PLANET_GROUP_ID,
  createEmptyDefinitionResolver,
  isPlanetCelestial,
  patchSnapshot,
};
