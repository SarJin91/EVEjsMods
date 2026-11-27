"use strict";

const { isWingCopyShape } = require("./shipAiWing");
const { TRAFFIC_OPERATOR_KIND } = require("./data/liveProfiles");

const CONSUMER = "capsuleFx";
const PATHS = Object.freeze({
  runtime: "space/runtime",
  store: "space/npc/nativeNpcStore",
  scope: "space/destiny/identity/interactionScope",
  identity: "space/FireShow/showIdentity",
  dungeon: "services/dungeon/dungeonRuntime",
});
const FUNCTIONS = Object.freeze({
  runtime: Object.freeze(["spawnDynamicShip", "getSceneByDescriptor"]),
  store: Object.freeze(["allocateEntityID"]),
  scope: Object.freeze(["buildChildEntityScopeMetadata", "canEntitiesInteractLocally"]),
  identity: Object.freeze(["isFireShowShip"]),
});
const CAPSULE = Object.freeze({ typeID: 670, groupID: 29, categoryID: 6, itemName: "Capsule" });
const SHOW_ENTITY_TYPE = "fireShow";
const SENTRY_GROUP_ID = 383;
const NPC_CORPORATION_RANGE = Object.freeze({ min: 1000000, max: 2000000 });
const LNE_OPERATOR_PREFIX = "lne";
const MISSION_SITE_KIND = "mission";
// The vendor's career lesson blast destroys every native NPC ship scoped to the site with a real wreck.
const CAREER_LESSON_DUNGEON_IDS = new Set([4169, 4170, 4171, 4172, 9417, 9418, 9419, 4191, 4173,
  4174, 4072, 4102, 4103, 4104, 9412, 9413, 9414, 4178]);
const SOURCES = Object.freeze({ CIVILIAN: "civilian", RATS: "rats", RATS_MISSION: "ratsMission",
  LNE_FLEETS: "lneFleets" });
const MAX_DETAIL = 120;

const isObj = (v) => Boolean(v) && typeof v === "object";
const positiveInt = (v) => {
  const n = Number(v);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};

function messageOf(err) {
  return String((err && err.message) || err).slice(0, MAX_DETAIL);
}

function detailOf(result, fallback) {
  return String((result && result.errorMsg) || fallback).slice(0, MAX_DETAIL);
}

function pointOf(value) {
  if (!isObj(value)) return null;
  const x = Number(value.x);
  const y = Number(value.y);
  const z = Number(value.z);
  return Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z) ? { x, y, z } : null;
}

function lower(value) {
  return String(value ?? "").trim().toLowerCase();
}

function isExcludedShape(entity) {
  if (entity.session || entity.nativeNpc !== true || isWingCopyShape(entity)) return true;
  if (entity.empireSentry === true || entity.lneCapsuleFx === true) return true;
  const groupId = positiveInt(entity.groupID);
  if (groupId === CAPSULE.groupID || groupId === SENTRY_GROUP_ID) return true;
  const npcType = lower(entity.npcEntityType);
  return npcType === "concord" || npcType === lower(SHOW_ENTITY_TYPE);
}

function wreckIdOf(destroyResult) {
  if (!isObj(destroyResult) || destroyResult.success !== true || destroyResult.duplicate === true) return null;
  const data = isObj(destroyResult.data) ? destroyResult.data : null;
  const wreck = data && isObj(data.wreck) ? data.wreck : null;
  return wreck ? positiveInt(wreck.wreckID) : null;
}

function ownerOf(entity) {
  const corporationId = positiveInt(entity.corporationID);
  if (corporationId !== null) return { ownerId: corporationId, corporationId };
  const owner = positiveInt(entity.ownerID);
  if (owner !== null && owner >= NPC_CORPORATION_RANGE.min && owner < NPC_CORPORATION_RANGE.max) {
    return { ownerId: owner, corporationId: null };
  }
  return null;
}

function sourceOf(entity, isMissionInstance) {
  const kind = String(entity.operatorKind || "").trim();
  if (kind === TRAFFIC_OPERATOR_KIND) return SOURCES.CIVILIAN;
  if (kind.startsWith(LNE_OPERATOR_PREFIX)) return SOURCES.LNE_FLEETS;
  const instanceId = positiveInt(entity.dungeonSiteInstanceID);
  if (instanceId !== null && typeof isMissionInstance === "function") {
    try {
      if (isMissionInstance(instanceId) === true) return SOURCES.RATS_MISSION;
    } catch (_err) {
    }
  }
  return SOURCES.RATS;
}

function isCareerLessonVictim(entity, isCareerLessonInstance) {
  if (typeof isCareerLessonInstance !== "function") return false;
  const ids = [entity.dungeonSiteInstanceID, entity.dungeonCurrentInstanceID].map(positiveInt)
    .filter((id) => id !== null);
  try {
    return ids.some((id) => isCareerLessonInstance(id) !== false);
  } catch (_err) {
    return true;
  }
}

function sceneDescriptorOf(entity, systemId) {
  const sceneKey = typeof entity.sceneKey === "string" && entity.sceneKey !== "" ? entity.sceneKey : null;
  if (sceneKey === null) return null;
  const out = { sceneKey, solarSystemID: systemId };
  if (typeof entity.sceneKind === "string" && entity.sceneKind !== "") out.sceneKind = entity.sceneKind;
  const instanceId = positiveInt(entity.abyssalRunID);
  if (instanceId !== null) out.instanceID = instanceId;
  return out;
}

function classifyVictim(targetEntity, destroyResult, deps) {
  if (!isObj(targetEntity) || targetEntity.kind !== "ship") return { skip: "notShip" };
  if (isExcludedShape(targetEntity)) return { skip: "excluded" };
  const excluded = deps && deps.excludedFactionIds instanceof Set ? deps.excludedFactionIds : null;
  const factionId = positiveInt(targetEntity.factionID ?? targetEntity.warFactionID);
  if (excluded !== null && factionId !== null && excluded.has(factionId)) return { skip: "excludedFaction" };
  if (isCareerLessonVictim(targetEntity, deps && deps.isCareerLessonInstance)) return { skip: "careerLesson" };
  const wreckId = wreckIdOf(destroyResult);
  if (wreckId === null) return { skip: "noWreck" };
  const owner = ownerOf(targetEntity);
  if (owner === null) return { skip: "noOwner" };
  const systemId = positiveInt(targetEntity.systemID);
  const position = pointOf(targetEntity.position);
  if (systemId === null || position === null) return { skip: "noPlace" };
  const radius = Number(targetEntity.radius);
  const sceneDescriptor = sceneDescriptorOf(targetEntity, systemId);
  return { facts: {
    wreckId,
    source: sourceOf(targetEntity, deps && deps.isMissionInstance),
    systemId,
    sceneKey: sceneDescriptor ? sceneDescriptor.sceneKey : String(systemId),
    sceneDescriptor,
    position,
    radius: Number.isFinite(radius) && radius > 0 ? radius : 0,
    ownerId: owner.ownerId,
    corporationId: owner.corporationId,
    allianceId: positiveInt(targetEntity.allianceID),
    factionId,
    victim: targetEntity,
  } };
}

function victimFactsOf(targetEntity, destroyResult, deps) {
  try {
    const r = classifyVictim(targetEntity, destroyResult, deps);
    return r.facts || null;
  } catch (_err) {
    return null;
  }
}

function readModule(requireGame, key) {
  try {
    const read = typeof requireGame === "function" ? requireGame(PATHS[key]) : null;
    const mod = read && read.ok === true && read.exports ? read.exports : null;
    if (!mod) return null;
    return (FUNCTIONS[key] || []).every((name) => typeof mod[name] === "function") ? mod : null;
  } catch (_err) {
    return null;
  }
}

function checkCapsuleFxSceneFrom(requireGame) {
  const missing = Object.keys(FUNCTIONS).filter((key) => readModule(requireGame, key) === null)
    .map((key) => PATHS[key]);
  return missing.length === 0 ? { ok: true } : { ok: false, reason: "SEAM_UNAVAILABLE", missing };
}

function dungeonRuntimeOf(requireGame) {
  const read = typeof requireGame === "function" ? requireGame(PATHS.dungeon) : null;
  const runtime = read && read.ok === true && read.exports ? read.exports : null;
  return runtime && typeof runtime.getInstanceSummary === "function" ? runtime : null;
}

function isMissionInstanceFrom(requireGame) {
  return (instanceId) => {
    const runtime = dungeonRuntimeOf(requireGame);
    if (!runtime) return false;
    const summary = runtime.getInstanceSummary(instanceId);
    return isObj(summary) && lower(summary.siteKind) === MISSION_SITE_KIND;
  };
}

function isCareerLessonInstanceFrom(requireGame) {
  return (instanceId) => {
    const runtime = dungeonRuntimeOf(requireGame);
    if (!runtime) return true;
    const summary = runtime.getInstanceSummary(instanceId);
    if (!isObj(summary)) return false;
    return CAREER_LESSON_DUNGEON_IDS.has(Number(summary.sourceDungeonID));
  };
}

function createCapsuleFxScene(deps) {
  const requireGame = deps && deps.requireGame;
  const mod = (key) => readModule(requireGame, key);

  const sceneOf = (sceneDescriptor, systemId) => {
    const runtime = mod("runtime");
    if (!runtime) return { ok: false, reason: "SEAM_UNAVAILABLE" };
    let scene = sceneDescriptor ? runtime.getSceneByDescriptor(sceneDescriptor) : null;
    if (!scene && positiveInt(systemId) !== null && runtime.scenes instanceof Map) {
      scene = runtime.scenes.get(systemId) || null;
    }
    if (!scene || typeof scene.getEntityByID !== "function") return { ok: false, reason: "SCENE_NOT_LOADED" };
    return { ok: true, scene, runtime };
  };

  function sceneFor(sceneDescriptor, systemId) {
    try {
      const sc = sceneOf(sceneDescriptor, systemId);
      return sc.ok ? sc.scene : null;
    } catch (_err) {
      return null;
    }
  }

  function playerNear(systemId, sceneDescriptor, position, viewMeters, victim) {
    try {
      const center = pointOf(position);
      if (center === null || !(viewMeters > 0)) return { ok: false, reason: "INVALID_INPUT" };
      const scope = mod("scope");
      if (!scope) return { ok: false, reason: "SEAM_UNAVAILABLE" };
      const sc = sceneOf(sceneDescriptor, systemId);
      if (!sc.ok) return sc;
      const scene = sc.scene;
      if (!(scene.sessions instanceof Map) || typeof scene.getShipEntityForSession !== "function") {
        return { ok: false, reason: "SEAM_UNAVAILABLE", detail: "sessions" };
      }
      const limit = viewMeters * viewMeters;
      for (const session of scene.sessions.values()) {
        const ship = scene.getShipEntityForSession(session);
        const at = ship ? pointOf(ship.position) : null;
        if (at === null) continue;
        const dx = at.x - center.x;
        const dy = at.y - center.y;
        const dz = at.z - center.z;
        if (dx * dx + dy * dy + dz * dz > limit) continue;
        if (!victim || scope.canEntitiesInteractLocally(ship, victim) === true) return { ok: true, near: true };
      }
      return { ok: true, near: false };
    } catch (err) {
      return { ok: false, reason: "READ_FAILED", detail: messageOf(err) };
    }
  }

  function dropEntity(scene, entity) {
    try {
      if (scene.getEntityByID(entity.itemID) === entity) {
        scene.removeDynamicEntity(entity.itemID, { allowSessionOwned: false, persistSpaceState: false });
      }
    } catch (_err) {
    }
  }

  function spawn(input) {
    if (!isObj(input) || pointOf(input.position) === null || positiveInt(input.ownerId) === null) {
      return { ok: false, reason: "SPAWN_FAILED", detail: "INVALID_INPUT" };
    }
    const runtime = mod("runtime");
    const store = mod("store");
    const scope = mod("scope");
    const identity = mod("identity");
    if (!runtime || !store || !scope || !identity) return { ok: false, reason: "SEAM_UNAVAILABLE" };
    let sc;
    try {
      sc = sceneOf(input.sceneDescriptor, input.systemId);
    } catch (err) {
      return { ok: false, reason: "SEAM_UNAVAILABLE", detail: messageOf(err) };
    }
    if (!sc.ok) return sc;
    const scene = sc.scene;
    if (typeof scene.removeDynamicEntity !== "function") {
      return { ok: false, reason: "SEAM_UNAVAILABLE", detail: "removeDynamicEntity" };
    }
    let itemID;
    try {
      const allocated = store.allocateEntityID({ transient: true });
      itemID = allocated && allocated.success === true ? positiveInt(allocated.data) : null;
    } catch (err) {
      return { ok: false, reason: "ID_FAILED", detail: messageOf(err) };
    }
    if (itemID === null) return { ok: false, reason: "ID_FAILED" };
    let entity = null;
    try {
      const scopeMetadata = input.victim ? scope.buildChildEntityScopeMetadata(input.victim) : {};
      const direction = pointOf(input.direction) || { x: 1, y: 0, z: 0 };
      const spec = {
        itemID, ...CAPSULE,
        ownerID: input.ownerId,
        corporationID: positiveInt(input.corporationId) || input.ownerId,
        allianceID: positiveInt(input.allianceId) || 0,
        warFactionID: positiveInt(input.factionId) || 0,
        nativeNpc: true, transient: true, npcEntityType: SHOW_ENTITY_TYPE, lneCapsuleFx: true,
        position: pointOf(input.position), direction, mode: "STOP",
      };
      const systemId = positiveInt(scene.systemID) || positiveInt(input.systemId);
      const r = runtime.spawnDynamicShip(systemId, spec, { sceneDescriptor: scene.sceneDescriptor,
        entityScopeMetadata: scopeMetadata, broadcast: false, persistSpaceState: false });
      entity = r && r.success === true && isObj(r.data) && isObj(r.data.entity) ? r.data.entity : null;
      if (entity === null) {
        return { ok: false, reason: "SPAWN_FAILED", detail: detailOf(r, "NO_ENTITY") };
      }
      entity.lneCapsuleFx = true;
      if (input.untargetable !== false) entity.airMiningTargetable = false;
      if (identity.isFireShowShip(entity) !== true) {
        dropEntity(scene, entity);
        return { ok: false, reason: "IDENTITY_DRIFT" };
      }
      return { ok: true, entityId: itemID, entity, scene };
    } catch (err) {
      if (entity !== null) dropEntity(scene, entity);
      return { ok: false, reason: "SPAWN_FAILED", detail: messageOf(err) };
    }
  }

  function warpAway(scene, entity, point) {
    try {
      if (!isObj(scene) || !isObj(entity) || typeof scene.getEntityByID !== "function"
        || scene.getEntityByID(entity.itemID) !== entity) {
        return { ok: false, reason: "GONE" };
      }
      const to = pointOf(point);
      if (to === null || typeof scene.warpDynamicEntityToPoint !== "function") {
        return { ok: false, reason: "WARP_FAILED", detail: to === null ? "INVALID_POINT" : "warpDynamicEntityToPoint" };
      }
      const r = scene.warpDynamicEntityToPoint(entity, to, { ignoreWarpDisruptionField: true });
      if (r && r.success === true) return { ok: true };
      return { ok: false, reason: "WARP_FAILED", detail: detailOf(r, "NO_RESULT") };
    } catch (err) {
      return { ok: false, reason: "WARP_FAILED", detail: messageOf(err) };
    }
  }

  function remove(scene, entity) {
    try {
      if (!isObj(scene) || !isObj(entity) || typeof scene.getEntityByID !== "function"
        || scene.getEntityByID(entity.itemID) !== entity) {
        return { ok: true, removed: false };
      }
      const r = scene.removeDynamicEntity(entity.itemID, { allowSessionOwned: false, persistSpaceState: false });
      if (r && r.success === false) {
        return { ok: false, reason: "REMOVE_FAILED", detail: detailOf(r, "") };
      }
      return { ok: true, removed: true };
    } catch (err) {
      return { ok: false, reason: "REMOVE_FAILED", detail: messageOf(err) };
    }
  }

  return Object.freeze({ playerNear, spawn, warpAway, remove, sceneFor });
}

module.exports = { CONSUMER, PATHS, FUNCTIONS, CAPSULE, SOURCES, NPC_CORPORATION_RANGE, CAREER_LESSON_DUNGEON_IDS,
  classifyVictim, victimFactsOf, checkCapsuleFxSceneFrom, isMissionInstanceFrom, isCareerLessonInstanceFrom,
  createCapsuleFxScene };
