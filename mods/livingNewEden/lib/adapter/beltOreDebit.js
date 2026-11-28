"use strict";

const { pickMinerAnchor } = require("../fleetExposure/rules");

// The native generator publishes rocks through addStaticEntity. A detached
// collection lets it initialize one belt without registering a system scene.
function detachedBelt(systemId, belt, asteroidService) {
  const rocks = new Map();
  const scene = {
    systemID: systemId,
    staticEntities: [],
    addStaticEntity(entity) {
      if (rocks.has(entity.itemID)) return false;
      rocks.set(entity.itemID, entity);
      this.staticEntities.push(entity);
      return true;
    },
    getEntityByID(id) {
      return rocks.get(id);
    },
    removeStaticEntity(id) {
      const entity = rocks.get(id);
      if (!entity) return false;
      rocks.delete(id);
      const index = this.staticEntities.indexOf(entity);
      if (index !== -1) this.staticEntities.splice(index, 1);
      return true;
    },
  };
  asteroidService._testing.populateBeltField(scene, belt);
  return scene;
}

function debitBeltOre(requireGame, { systemId, fleetId, worldSeed, oreM3, oreTypeId }) {
  if (!Number.isSafeInteger(oreM3) || oreM3 <= 0) return { ok: false, reason: "INVALID_ORE_VOLUME" };
  const runtime = requireGame("space/runtime").exports;
  const loaded = runtime?.isSolarSystemSceneLoaded(systemId) === true;
  let scene = loaded ? runtime.scenes.get(systemId) : null;
  if (loaded && !scene) return { ok: false, reason: "SCENE_UNAVAILABLE" };

  const asteroidData = requireGame("space/asteroids/asteroidData").exports;
  const mining = requireGame("services/mining/miningRuntimeState").exports;
  if (!asteroidData || typeof asteroidData.getBeltsForSystem !== "function" ||
    !mining || typeof mining.getMineableState !== "function" ||
    typeof mining.ensureSceneMiningState !== "function" || typeof mining.applyMiningDelta !== "function") {
    return { ok: false, reason: "MINING_RUNTIME_UNAVAILABLE" };
  }
  const belts = asteroidData.getBeltsForSystem(systemId)
    .map((belt) => ({ itemId: Number(belt.itemID), belt }))
    .filter(({ itemId }) => Number.isSafeInteger(itemId) && itemId > 0);
  let preferred = pickMinerAnchor(belts, worldSeed, fleetId);
  if (!loaded) {
    if (!preferred) return { ok: false, reason: "NO_BELT" };
    if (requireGame("config/index").exports?.asteroidFieldsEnabled !== true) {
      return { ok: false, reason: "ASTEROID_FIELDS_DISABLED" };
    }
    const asteroidService = requireGame("space/asteroids/asteroidService").exports;
    if (typeof asteroidService?._testing?.populateBeltField !== "function" ||
      typeof mining.readPersistedSystemEntities !== "function" ||
      typeof mining.readPersistedBeltGeneration !== "function") {
      return { ok: false, reason: "BELT_GENERATOR_UNAVAILABLE" };
    }
    // Rows for untouched rocks may be absent. An accepted generation gives
    // the denominator needed to distinguish an empty belt from missing data.
    const states = Object.values(mining.readPersistedSystemEntities(systemId));
    const emptyRocksByBelt = new Map();
    for (const state of states) {
      if (state.remainingQuantity !== 0) continue;
      const beltId = Number(state.beltID);
      emptyRocksByBelt.set(beltId, (emptyRocksByBelt.get(beltId) || 0) + 1);
    }
    const candidates = belts.filter(({ itemId }) => {
      const empty = emptyRocksByBelt.get(itemId) || 0;
      if (empty === 0) return true;
      const generation = mining.readPersistedBeltGeneration(systemId, itemId);
      return !generation?.typeIDs?.length || empty < generation.typeIDs.length;
    });
    preferred = pickMinerAnchor(candidates, worldSeed, fleetId);
    if (!preferred) return { ok: false, reason: "BELTS_DEPLETED" };
    scene = detachedBelt(systemId, preferred.belt, asteroidService);
  }

  const preferredId = preferred?.itemId;
  const rocks = (scene.staticEntities || []).filter((rock) => rock.kind === "asteroid" &&
    !rock.generatedMiningSiteAnchor && (Number(rock.beltID) > 0 ||
      (loaded && rock.dungeonMaterializedMiningRock === true)));
  // Keep the fleet's usual anchor first, then use other loaded belts and active
  // ore anomalies. Never initialize another scene to finish a single load.
  rocks.sort((a, b) => Number(Number(b.beltID) === preferredId) - Number(Number(a.beltID) === preferredId)
    || a.itemID - b.itemID);
  if (rocks.length === 0) return { ok: false, reason: "NO_MINEABLE_ROCKS" };

  const cache = !loaded ? mining.ensureSceneMiningState(scene) : null;
  const resources = [];
  const touchedSites = new Set();
  let remainingM3 = oreM3;
  for (const rock of rocks) {
    const stock = loaded ? mining.getMineableState(scene, rock.itemID) : cache?.byEntityID.get(rock.itemID);
    if (!stock || stock.yieldKind !== "ore" || (oreTypeId !== undefined && stock.yieldTypeID !== oreTypeId) ||
      !Number.isFinite(stock.unitVolume) || stock.unitVolume <= 0) continue;
    const quantity = Math.min(stock.remainingQuantity, Math.floor((remainingM3 + 1e-9) / stock.unitVolume));
    if (!Number.isSafeInteger(quantity) || quantity <= 0) continue;
    const result = mining.applyMiningDelta(scene, rock, quantity, 0);
    if (!result || result.success !== true) continue;
    const removed = stock.remainingQuantity - result.data.state.remainingQuantity;
    if (!(removed > 0)) continue;
    resources.push({ typeId: stock.yieldTypeID, quantity: removed });
    touchedSites.add(Number(rock.beltID) || Number(rock.dungeonSiteInstanceID));
    remainingM3 = Math.max(0, remainingM3 - removed * stock.unitVolume);
    if (remainingM3 < 1e-9) break;
  }
  return { ok: true, beltId: preferredId, siteIds: [...touchedSites], detached: !loaded,
    debitedM3: oreM3 - remainingM3, remainingM3, resources };
}

module.exports = { debitBeltOre };
