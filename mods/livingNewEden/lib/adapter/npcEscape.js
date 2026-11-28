"use strict";

const profiles = require("./data/liveProfiles");
const { noteNativeWreckLoss } = require("./liveLossHook");
const CREWED = new Set([
  profiles.LIVE_OPERATOR_KIND, profiles.LIVE_DUEL_OPERATOR_KIND, profiles.TRAFFIC_OPERATOR_KIND,
  profiles.BOUNTY_OPERATOR_KIND, profiles.SITUATION_OPERATOR_KIND,
  profiles.HEAVY_OPERATOR_KIND, "lneMiningWave", "lneOfficer",
]);
const CAPSULE_TYPE = 670;
const CAPSULE_GROUP = 29;
const ESCAPE_DISTANCE = 149597870700;
const REACTION_MS = 2400;
const WARP_RETRY_MS = 2000;
const ESCAPE_DEADLINE_MS = 60000;
const MAX_CAPSULES_PER_SCENE = 32;
const MAX_DEATHS = 4096;
const trafficDeaths = new Set();
const deathKey = (systemId, entityId) => `${systemId}:${entityId}`;

function takeTrafficDeath(systemId, entityId) {
  return trafficDeaths.delete(deathKey(systemId, entityId));
}

function recordTrafficDeath(systemId, entityId) {
  trafficDeaths.add(deathKey(systemId, entityId));
  if (trafficDeaths.size > MAX_DEATHS) trafficDeaths.delete(trafficDeaths.values().next().value);
}

function installEscape(wrecks, loadGame, logger) {
  const destroy = wrecks.destroyNativeNpcEntityWithWreck;
  const handled = new WeakSet();
  const activeByScene = new WeakMap();

  function launchCapsule(scene, systemId, ship, position, direction) {
    if ((activeByScene.get(scene) || 0) >= MAX_CAPSULES_PER_SCENE) return;
    const { buildRuntimeShipEntity } = loadGame("space/runtime/shipEntity");
    const { buildChildEntityScopeMetadata } = loadGame("space/destiny/identity/interactionScope");
    const id = loadGame("space/npc/nativeNpcStore").allocateEntityID({ transient: true });
    if (!id.success) return;

    const origin = { ...position, x: position.x + (Number(ship.radius) || 0) + 250 };
    const angle = Math.random() * Math.PI * 2;
    const destination = { x: origin.x + Math.cos(angle) * ESCAPE_DISTANCE, y: origin.y,
      z: origin.z + Math.sin(angle) * ESCAPE_DISTANCE };
    const pod = buildRuntimeShipEntity({
      itemID: id.data, typeID: CAPSULE_TYPE, groupID: CAPSULE_GROUP, categoryID: 6,
      itemName: "Capsule", ownerID: ship.ownerID, corporationID: ship.corporationID,
      spaceState: { position: origin, direction, mode: "STOP" },
    }, Number(systemId));
    Object.assign(pod, buildChildEntityScopeMetadata(ship), { transient: true });
    if (!scene.spawnDynamicEntity(pod, { broadcast: true }).success) return;
    activeByScene.set(scene, (activeByScene.get(scene) || 0) + 1);

    const deadline = Date.now() + ESCAPE_DEADLINE_MS;
    let enteredWarp = false;
    let cleanupDone = false;
    function cleanup() {
      if (cleanupDone) return;
      cleanupDone = true;
      activeByScene.set(scene, (activeByScene.get(scene) || 1) - 1);
      try {
        if (scene.getEntityByID(pod.itemID) === pod) {
          scene.removeDynamicEntity(pod.itemID, { allowSessionOwned: false });
        }
      } catch (error) {
        logger.logError("npcEscape: capsule cleanup failed", error);
      }
    }
    function escapeStep() {
      try {
        if (scene.getEntityByID(pod.itemID) !== pod || Date.now() >= deadline + ESCAPE_DEADLINE_MS * 2) {
          cleanup();
          return;
        }
        if (pod.mode === "WARP" || pod.warpState) {
          enteredWarp = true;
        } else if (enteredWarp || Date.now() >= deadline ||
            Math.hypot(pod.position.x - destination.x, pod.position.y - destination.y,
              pod.position.z - destination.z) < 100000) {
          cleanup();
          return;
        } else if (!pod.pendingWarp) {
          // The regular departure path publishes alignment and the warp FX to grid viewers.
          scene.warpDynamicEntityToPoint(pod.itemID, destination, {
            forceImmediateStart: false,
            broadcastWarpStartToVisibleSessions: true,
          });
        }
        setTimeout(escapeStep, WARP_RETRY_MS).unref();
      } catch (error) {
        logger.logError("npcEscape: capsule warp failed", error);
        cleanup();
      }
    }
    setTimeout(escapeStep, REACTION_MS + Math.floor(Math.random() * 1300)).unref();
  }

  wrecks.destroyNativeNpcEntityWithWreck = function destroyWithEscape(systemId, ship, options) {
    const crewed = ship?.kind === "ship" && !ship.session && CREWED.has(ship.operatorKind) &&
      Number(ship.groupID) !== CAPSULE_GROUP;
    const position = crewed && ship.position ? { ...ship.position } : null;
    const direction = crewed && ship.direction ? { ...ship.direction } : { x: 1, y: 0, z: 0 };
    let scene = null;
    let wasPresent = false;
    if (crewed && !handled.has(ship)) {
      try {
        const runtime = loadGame("space/runtime");
        const descriptor = options?.sceneDescriptor || ship.sceneDescriptor;
        scene = options?.scene || (descriptor && runtime.getSceneByDescriptor?.(descriptor))
          || runtime.scenes.get(Number(systemId));
        wasPresent = scene?.getEntityByID(ship.itemID) === ship;
      } catch (error) {
        logger.logError("npcEscape: destruction scene lookup failed", error);
      }
    }
    const result = destroy.apply(this, arguments);
    if (ship?.kind !== "ship" || handled.has(ship)) return result;
    if (result?.success && result.data?.wreck) noteNativeWreckLoss(ship, result, options);
    if (!crewed) return result;

    try {
      const stillPresent = scene?.getEntityByID(ship.itemID) === ship;
      // The hull can already be gone when the vendor fails to publish its wreck.
      if (stillPresent || (!result?.success && !wasPresent)) return result;
      handled.add(ship);
      if (ship.operatorKind === profiles.TRAFFIC_OPERATOR_KIND) recordTrafficDeath(systemId, ship.itemID);
      if (scene && position && [position.x, position.y, position.z].every(Number.isFinite)) {
        launchCapsule(scene, systemId, ship, position, direction);
      }
    } catch (error) {
      logger.logError("npcEscape: capsule launch failed", error);
    }
    return result;
  };
}


function installTrafficCrimewatch(crimewatch) {
  // Use the native NPC authority policy for civilian ships. The combat and
  // sentry callers still receive the actual target, with its normal ship group.
  for (const name of ["evaluateOffensiveAggression", "recordHighSecCriminalAggression"]) {
    const original = crimewatch[name];
    crimewatch[name] = function protectCivilianTraffic(scene, attacker, target, ...args) {
      if (target?.kind === "ship" && target.operatorKind === profiles.TRAFFIC_OPERATOR_KIND &&
          Number(target.ownerID) > 0 && Number(target.ownerID) < 90000000) {
        return original.call(this, scene, attacker, { ...target, groupID: 15 }, ...args);
      }
      return original.apply(this, arguments);
    };
  }
}

module.exports = { installEscape, installTrafficCrimewatch, takeTrafficDeath };
