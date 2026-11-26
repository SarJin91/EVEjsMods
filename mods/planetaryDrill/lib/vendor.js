"use strict";

const path = require("node:path");

const MODULES = Object.freeze({
  orbital: "server/src/services/planet/planetOrbitalState.js",
  itemStore: "server/src/services/inventory/itemStore.js",
  worldData: "server/src/space/worldData.js",
  planetStatic: "server/src/services/planet/planetStaticData.js",
  planetRuntime: "server/src/services/planet/planetRuntimeStore.js",
  sovModern: "server/src/services/sovereignty/sovModernState.js",
});

const REQUIRED = Object.freeze({
  orbital: Object.freeze(["getDeployedSkyhookRevision", "readState"]),
  itemStore: Object.freeze(["findItemById"]),
  worldData: Object.freeze(["getCelestialByID"]),
  planetStatic: Object.freeze(["getPlanetResourceTypeIDs"]),
  planetRuntime: Object.freeze([]),
  sovModern: Object.freeze(["invalidateSovereigntyModernStateCache"]),
});

function toInt(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.trunc(number) : fallback;
}

function planetMetaOf(planet) {
  const position = planet.position && typeof planet.position === "object" ? planet.position : {};
  return {
    planetID: Number(planet.itemID) || 0,
    solarSystemID: Number(planet.solarSystemID) || 0,
    typeID: Number(planet.typeID) || 0,
    celestialIndex: Number(planet.celestialIndex) || 0,
    radius: Number(planet.radius) || 0,
    position: { x: Number(position.x) || 0, y: Number(position.y) || 0, z: Number(position.z) || 0 },
    security: Number(planet.security),
    itemName: planet.itemName || "",
  };
}

function createVendor({ runtimeRoot, load = require, worldData = () => null, launchRuntime = () => null }) {
  const loaded = {};

  function moduleOf(name) {
    if (name === "worldData") {
      const seen = worldData();
      if (seen) return seen;
    }
    if (!loaded[name]) {
      const exports = load(path.join(runtimeRoot, ...MODULES[name].split("/")));
      const complete = REQUIRED[name].every((symbol) => exports && typeof exports[symbol] === "function") &&
        (name !== "planetRuntime" || (exports._testing && typeof exports._testing.buildResourceRecord === "function"));
      if (complete) loaded[name] = exports;
      else return null;
    }
    return loaded[name];
  }

  function ready() {
    return Object.keys(MODULES).every((name) => moduleOf(name) !== null);
  }

  return {
    ready,
    getRevision: () => moduleOf("orbital").getDeployedSkyhookRevision(),
    readOrbitalState: () => moduleOf("orbital").readState(),
    findItem: (id) => moduleOf("itemStore").findItemById(id),
    getCelestial: (id) => moduleOf("worldData").getCelestialByID(id),
    resourceTypeIDs: (planet) => moduleOf("planetStatic").getPlanetResourceTypeIDs(Number(planet.typeID) || 0),
    qualities: (planet, resourceTypeIDs) => {
      const record = moduleOf("planetRuntime")._testing.buildResourceRecord(planetMetaOf(planet), resourceTypeIDs);
      return (record && record.qualitiesByTypeID) || {};
    },
    invalidate: () => moduleOf("sovModern").invalidateSovereigntyModernStateCache(),

    launchReady,
    updateItemType: (itemID, typeID) => {
      const store = launchModuleOf("itemStore");
      if (!store) return { ok: false, reason: "NOT_READY" };
      const result = store.updateInventoryItem(Number(itemID), (current) => ({ ...current, typeID: Number(typeID) }));
      if (!result || !result.success) return { ok: false, reason: (result && result.errorMsg) || "NO_RESULT" };
      return { ok: true, item: result.data, previous: result.previousData };
    },
    syncItem: (session, item, previous) => {
      const characterState = launchModuleOf("characterState");
      if (!characterState || !session || !item) return false;
      characterState.syncInventoryItemForSession(session, item, previous || {}, { emitCfgLocation: true });
      return true;
    },
    normalizeLaunchRequests: (raw) => {
      const exports = launchRuntime();
      const testing = exports && exports._testing;
      if (!testing || typeof testing.normalizeLaunchRequests !== "function") return [];
      return testing.normalizeLaunchRequests(raw);
    },
    dataRoot: () => launchModuleOf("dataRoot").resolveDataRoot(),
    nearestPlanetID: (session) => {
      const exports = launchRuntime();
      const testing = exports && exports._testing;
      const orbital = moduleOf("orbital");
      if (!testing || typeof testing.buildOrbitalSpawnState !== "function" ||
          !orbital || typeof orbital.findNearestPlanetID !== "function") {
        return null;
      }
      const systemID = toInt(session && session._space && session._space.systemID,
        toInt(session && (session.solarsystemid2 || session.solarsystemid), 0));
      if (!systemID) return 0;
      const spawnState = testing.buildOrbitalSpawnState(session, systemID);
      return toInt(orbital.findNearestPlanetID(systemID, spawnState && spawnState.position), 0);
    },
  };

  function launchModuleOf(name) {
    if (name === "itemStore") {
      const store = moduleOf("itemStore");
      return store && typeof store.updateInventoryItem === "function" ? store : null;
    }
    if (!loaded[name]) {
      const exports = load(path.join(runtimeRoot, ...LAUNCH_MODULES[name].split("/")));
      if (!LAUNCH_REQUIRED[name].every((symbol) => exports && typeof exports[symbol] === "function")) return null;
      loaded[name] = exports;
    }
    return loaded[name];
  }

  function launchReady() {
    const exports = launchRuntime();
    return Boolean(exports && exports._testing && typeof exports._testing.normalizeLaunchRequests === "function") &&
      moduleOf("orbital") !== null && launchModuleOf("itemStore") !== null && launchModuleOf("dataRoot") !== null;
  }
}

const LAUNCH_MODULES = Object.freeze({
  characterState: "server/src/services/character/characterState.js",
  dataRoot: "server/src/config/dataRoot.js",
});

const LAUNCH_REQUIRED = Object.freeze({
  characterState: Object.freeze(["syncInventoryItemForSession"]),
  dataRoot: Object.freeze(["resolveDataRoot"]),
});

module.exports = {
  LAUNCH_MODULES,
  LAUNCH_REQUIRED,
  MODULES,
  REQUIRED,
  createVendor,
  planetMetaOf,
};
