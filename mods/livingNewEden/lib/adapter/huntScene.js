// Ported from EveJS v0.12.9 (CREDITS.md): the cloak rules of isEntityHiddenFromCombatProbes (services/exploration/probes/probeScanRuntime.js:518-536) and the landing spread of buildMiningWarpLandingPoint (services/mining/miningNpcOperations.js:997-1006).

"use strict";

const dormancyGuard = require("./dormancyGuard");
const { attackLockFields } = require("./attackLock");
const { presentBeams, motionOf } = require("./miningBeams");
const { queueWarpingFx } = require("./ballUpdates");

const MAX_DETAIL = 120;

const MODULE_PATHS = Object.freeze({
  runtime: "space/runtime",
  worldData: "space/worldData",
  npc: "space/npc/npcService",
  npcRuntime: "space/npc/npcRuntime",
});

const FACTION_KILL_PATH = "services/character/factionKillStandingRuntime";

const SIGNATURE_RUNTIME_PATH = "services/exploration/signatures/signatureRuntime";

const ANOMALY_READ_OPTIONS = Object.freeze({ allowTemplateDiscovery: false });

const REQUIRED_FUNCTIONS = Object.freeze({
  runtime: Object.freeze(["isSolarSystemSceneLoaded"]),
  worldData: Object.freeze(["getStargatesForSystem", "getStationsForSystem", "getAsteroidBeltsForSystem",
    "getCelestialsForSystem"]),
  npc: Object.freeze(["setBehaviorOverrides", "issueManualOrder", "wakeNpcController", "getControllerByEntityID"]),
  npcRuntime: Object.freeze(["warpToPoint"]),
});

const SEAM_METHODS = Object.freeze(["listSystemObjects", "readPlayerShips", "readShips", "warpShips", "setSearch",
  "attackTargets", "readAggressors", "explainShips", "armNpcCombat", "presentMiningBeams"]);

const NOT_IN_SCENE = "ENTITY_NOT_IN_SCENE";
const ALIGN_ORDER = "align";
const RESUME_ORDER = "resume";

function messageOf(err) {
  return String((err && err.message) || err).slice(0, MAX_DETAIL);
}

function isPositiveInt(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function toPositiveInt(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

function toInt(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

function isIdList(value) {
  return Array.isArray(value) && value.every(isPositiveInt);
}

function pointOf(value) {
  if (!value || typeof value !== "object") return null;
  const x = Number(value.x);
  const y = Number(value.y);
  const z = Number(value.z);
  return Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z) ? { x, y, z } : null;
}

function leashOf(controller, position) {
  const overrides = controller.behaviorOverrides && typeof controller.behaviorOverrides === "object"
    ? controller.behaviorOverrides : {};
  const profile = controller.behaviorProfile && typeof controller.behaviorProfile === "object"
    ? controller.behaviorProfile : {};
  const raw = Number(overrides.leashRangeMeters !== undefined ? overrides.leashRangeMeters : profile.leashRangeMeters);
  const leashMeters = Number.isFinite(raw) && raw > 0 ? raw : 0;
  const home = pointOf(controller.homePosition);
  const exact = home === null ? null
    : Math.hypot(position.x - home.x, position.y - home.y, position.z - home.z);
  return { leashMeters, homeDistanceMeters: exact === null ? null : Math.round(exact),
    beyondLeash: leashMeters > 0 && exact !== null && exact > leashMeters };
}

function loadOne(requireGame, key) {
  const relPath = MODULE_PATHS[key];
  const loaded = requireGame(relPath);
  if (!loaded || loaded.ok !== true || !loaded.exports) return { ok: false, missing: [relPath] };
  const exportsObject = loaded.exports;
  const missing = REQUIRED_FUNCTIONS[key]
    .filter((name) => typeof exportsObject[name] !== "function")
    .map((name) => `${relPath}.${name}`);
  if (key === "runtime" && !(exportsObject.scenes instanceof Map)) missing.push(`${relPath}.scenes`);
  return missing.length === 0 ? { ok: true, exports: exportsObject } : { ok: false, missing };
}

function loadMods(requireGame, keys) {
  const mods = {};
  const missing = [];
  for (const key of keys) {
    let one;
    try {
      one = loadOne(requireGame, key);
    } catch (_err) {
      one = { ok: false, missing: [MODULE_PATHS[key]] };
    }
    if (one.ok) mods[key] = one.exports;
    else missing.push(...one.missing);
  }
  return missing.length === 0 ? { ok: true, mods } : { ok: false, reason: "SEAM_UNAVAILABLE", missing };
}

function factionResolverOf(requireGame) {
  let mod = null;
  try {
    const loaded = requireGame(FACTION_KILL_PATH);
    if (loaded && loaded.ok === true && loaded.exports
      && typeof loaded.exports.resolveVictimFactionID === "function") mod = loaded.exports;
  } catch (_err) {
    mod = null;
  }
  return (entity) => {
    if (mod === null) return null;
    try {
      const id = toPositiveInt(mod.resolveVictimFactionID(entity));
      return id > 0 ? id : null;
    } catch (_err) {
      return null;
    }
  };
}

function sitePositionOf(site) {
  let position = pointOf(site.actualPosition);
  if (position === null && Array.isArray(site.position) && site.position.length >= 3) {
    position = pointOf({ x: site.position[0], y: site.position[1], z: site.position[2] });
  }
  if (position === null || (position.x === 0 && position.y === 0 && position.z === 0)) return null;
  return position;
}

function readAnomalyObjects(requireGame, systemId, kind, source) {
  try {
    const loaded = requireGame(SIGNATURE_RUNTIME_PATH);
    const mod = loaded && loaded.ok === true ? loaded.exports : null;
    if (!mod || typeof mod.listSystemAnomalySites !== "function") return { ok: false };
    const sites = mod.listSystemAnomalySites(systemId, { ...ANOMALY_READ_OPTIONS });
    if (!Array.isArray(sites)) return { ok: false };
    const objects = [];
    for (const site of sites) {
      if (!site || typeof site !== "object") continue;
      const itemId = idOf(site, source.idFields);
      const position = sitePositionOf(site);
      if (itemId === 0 || position === null) continue;
      objects.push({ kind, itemId, position, family: String(site.family || "unknown") });
    }
    return { ok: true, objects };
  } catch (_err) {
    return { ok: false };
  }
}

function checkHuntSceneFrom(requireGame) {
  const loaded = loadMods(requireGame, Object.keys(MODULE_PATHS));
  return loaded.ok ? { ok: true } : loaded;
}

function sceneLoadedIn(runtime, systemId) {
  return runtime.isSolarSystemSceneLoaded(systemId) === true;
}

function sceneOf(runtime, systemId) {
  const scene = runtime.scenes.get(systemId);
  return scene && typeof scene.getEntityByID === "function" ? scene : null;
}

function splitInScene(runtime, systemId, entityIds) {
  const scene = sceneOf(runtime, systemId);
  if (!scene) return { ok: false, reason: "SCENE_NOT_LOADED" };
  const missing = entityIds.filter((id) => !scene.getEntityByID(id));
  if (entityIds.length > 0 && missing.length === entityIds.length) return { ok: false, reason: NOT_IN_SCENE };
  return { ok: true, missing };
}

// Port of isEntityHiddenFromCombatProbes (probeScanRuntime.js:518-536).
function isCloaked(entity) {
  if (!entity || entity.probeScanVisible === false || entity.cloaked === true) return true;
  if (toInt(entity.isCloaked) > 0 || toInt(entity.cloakMode) > 0) return true;
  if (typeof entity.cloakState === "number") return toInt(entity.cloakState) > 0;
  if (entity.cloakState && typeof entity.cloakState === "object") {
    return entity.cloakState.active === true
      || String(entity.cloakState.state || "").trim().toLowerCase() === "active"
      || toInt(entity.cloakState.mode) > 0;
  }
  return false;
}

function isInWarp(entity) {
  return entity.mode === "WARP" || Boolean(entity.pendingWarp) || Boolean(entity.warpState);
}

function isWarpMode(entity) {
  return Boolean(entity) && String(entity.mode || "").trim().toUpperCase() === "WARP";
}

function isInActiveWarp(entity) {
  return isWarpMode(entity) && Number(entity.effectStamp) >= 0;
}

function isAligningToWarp(entity) {
  return isWarpMode(entity) && !(Number(entity.effectStamp) >= 0);
}

// Port of buildMiningWarpLandingPoint (miningNpcOperations.js:997-1006): point i of n on a circle in the x/z plane.
function landingPoint(center, index, total, radiusMeters) {
  const angle = ((Math.PI * 2) / Math.max(1, total)) * Math.max(0, index);
  return {
    x: center.x + (Math.cos(angle) * radiusMeters),
    y: center.y,
    z: center.z + (Math.sin(angle) * radiusMeters),
  };
}

function idOf(record, idFields) {
  for (const field of idFields) {
    const id = toPositiveInt(record && record[field]);
    if (id > 0) return id;
  }
  return 0;
}

function createHuntScene({ requireGame, data, attackLock }) {
  const load = (keys) => loadMods(requireGame, keys);
  const kindNames = Object.keys(data.OBJECT_KIND_SOURCES);

  const listSystemObjects = (systemId, kinds) => {
    if (!isPositiveInt(systemId) || !Array.isArray(kinds) || !kinds.every((k) => kindNames.includes(k))) {
      return { ok: false, reason: "INVALID_INPUT" };
    }
    try {
      const needsWorldData = kinds.some((k) => !data.OBJECT_KIND_SOURCES[k].dynamic);
      let worldData = null;
      if (needsWorldData) {
        const loaded = load(["worldData"]);
        if (!loaded.ok) return loaded;
        worldData = loaded.mods.worldData;
      }
      const objects = [];
      const skipped = [];
      for (const kind of kinds) {
        const source = data.OBJECT_KIND_SOURCES[kind];
        if (source.dynamic) {
          const read = readAnomalyObjects(requireGame, systemId, kind, source);
          if (read.ok) objects.push(...read.objects);
          else if (!skipped.includes(kind)) skipped.push(kind);
          continue;
        }
        const records = worldData[source.fn](systemId);
        for (const record of Array.isArray(records) ? records : []) {
          const groupOk = source.groupId === null || Number(record && record.groupID) === source.groupId
            || (Boolean(source.kindAlias) && Boolean(record) && String(record.kind) === source.kindAlias);
          if (!groupOk) continue;
          const itemId = idOf(record, source.idFields);
          const position = pointOf(record && record.position);
          if (itemId === 0 || position === null) continue;
          const toSystemId = source.toSystemField ? Number(record[source.toSystemField]) : 0;
          const object = isPositiveInt(toSystemId) ? { kind, itemId, position, toSystemId } : { kind, itemId, position };
          const radius = Number(record.radius);
          if (Number.isFinite(radius) && radius > 0) object.radius = radius;
          objects.push(object);
        }
      }
      return skipped.length > 0 ? { ok: true, objects, skipped } : { ok: true, objects };
    } catch (err) {
      return { ok: false, reason: "READ_FAILED", detail: messageOf(err) };
    }
  };

  const readPlayerShips = (systemId) => {
    if (!isPositiveInt(systemId)) return { ok: false, reason: "INVALID_INPUT" };
    try {
      const loaded = load(["runtime"]);
      if (!loaded.ok) return loaded;
      const runtime = loaded.mods.runtime;
      if (!sceneLoadedIn(runtime, systemId)) return { ok: false, reason: "SCENE_NOT_LOADED" };
      const scene = sceneOf(runtime, systemId);
      if (!scene) return { ok: false, reason: "SCENE_NOT_LOADED" };
      if (!(scene.sessions instanceof Map) || typeof scene.getShipEntityForSession !== "function") {
        return { ok: false, reason: "SEAM_UNAVAILABLE", missing: ["scene.sessions/getShipEntityForSession"] };
      }
      const ships = [];
      for (const session of scene.sessions.values()) {
        if (!session) continue;
        const characterId = toPositiveInt(session.characterID || session.charid);
        if (characterId === 0) continue;
        if (toPositiveInt(session.stationid || session.stationID) > 0
          || toPositiveInt(session.structureid || session.structureID) > 0) continue;
        const entity = scene.getShipEntityForSession(session);
        const entityId = toPositiveInt(entity && entity.itemID);
        const position = pointOf(entity && entity.position);
        if (entityId === 0 || position === null) continue;
        const signature = Number(entity.signatureRadius);
        ships.push({
          characterId,
          entityId,
          position,
          signatureRadius: Number.isFinite(signature) && signature > 0 ? signature : null,
          inWarp: isInActiveWarp(entity),
          aligning: isAligningToWarp(entity),
          cloaked: isCloaked(entity),
          jumpCloaked: entity.stargateJumpCloak === true && isCloaked(entity),
          capsule: toInt(entity.groupID) === data.CAPSULE_GROUP_ID,
          typeId: toPositiveInt(entity.typeID) || null,
          groupId: toPositiveInt(entity.groupID) || null,
          warpTarget: isWarpMode(entity) ? pointOf(entity.targetPoint) : null,
          warpTargetEntityId: isWarpMode(entity) && entity.warpDestination
            && typeof entity.warpDestination === "object"
            ? (toPositiveInt(entity.warpDestination.targetEntityID) || null) : null,
        });
      }
      return { ok: true, ships };
    } catch (err) {
      return { ok: false, reason: "READ_FAILED", detail: messageOf(err) };
    }
  };

  const readShips = (systemId, entityIds) => {
    if (!isPositiveInt(systemId) || !isIdList(entityIds)) return { ok: false, reason: "INVALID_INPUT" };
    try {
      const loaded = load(["runtime"]);
      if (!loaded.ok) return loaded;
      const scene = sceneOf(loaded.mods.runtime, systemId);
      if (!scene) return { ok: true, ships: [] };
      const npcLoaded = load(["npc"]);
      const npc = npcLoaded.ok ? npcLoaded.mods.npc : null;
      const ships = [];
      for (const entityId of entityIds) {
        const entity = scene.getEntityByID(entityId);
        const position = pointOf(entity && entity.position);
        if (!entity || position === null) continue;
        const ship = { entityId, position, inWarp: isInWarp(entity) };
        const controller = npc ? npc.getControllerByEntityID(entityId) : null;
        if (controller && typeof controller === "object") {
          const order = controller.manualOrder;
          const attack = order && typeof order === "object" && String(order.type || "").toLowerCase() === "attack";
          const overrides = controller.behaviorOverrides;
          ship.vendorOrder = { attackTargetId: attack ? toPositiveInt(order.targetID) : 0,
            weapons: !(overrides && typeof overrides === "object" && overrides.autoActivateWeapons === false),
            keepLock: Boolean(attack) && order.keepLock === true,
            allowWeapons: Boolean(attack) && order.allowWeapons === true,
            ...leashOf(controller, position) };
        }
        ships.push(ship);
      }
      return { ok: true, ships };
    } catch (err) {
      return { ok: false, reason: "READ_FAILED", detail: messageOf(err) };
    }
  };

  const optionalFlag = (value) => value === undefined || typeof value === "boolean";

  const resumeOrder = (npc, entityId) => {
    try {
      const r = npc.issueManualOrder(entityId, { type: RESUME_ORDER });
      return Boolean(r && r.success === true);
    } catch (_err) {
      return false;
    }
  };

  const alignedWarp = (scene, npc, entityId, landing) => {
    let aligned = false;
    try {
      const entity = scene.getEntityByID(entityId);
      const from = pointOf(entity && entity.position);
      if (entity && from !== null && typeof scene.warpDynamicEntityToPoint === "function") {
        const direction = { x: landing.x - from.x, y: landing.y - from.y, z: landing.z - from.z };
        const issued = npc.issueManualOrder(entityId, { type: ALIGN_ORDER, direction });
        if (issued && issued.success === true) npc.wakeNpcController(entityId, 0);
        const warp = issued && issued.success === true ? scene.warpDynamicEntityToPoint(entity, landing) : null;
        aligned = Boolean(warp && warp.success === true);
      }
    } catch (_err) {
      aligned = false;
    }
    if (!aligned) resumeOrder(npc, entityId);
    return aligned;
  };

  const warpShips = (systemId, entityIds, point, options = {}) => {
    const center = pointOf(point);
    const spread = options && options.spreadMeters !== undefined ? Number(options.spreadMeters) : 0;
    const align = options ? options.align : undefined;
    const clearAlignOrder = options ? options.clearAlignOrder : undefined;
    const warpFx = options ? options.warpFx : undefined;
    if (!isPositiveInt(systemId) || !isIdList(entityIds) || center === null
      || !Number.isFinite(spread) || spread < 0 || !optionalFlag(align) || !optionalFlag(clearAlignOrder)
      || !optionalFlag(warpFx) || (align === true && clearAlignOrder === true)) {
      return { ok: false, reason: "INVALID_INPUT" };
    }
    const withOrders = align === true || clearAlignOrder === true;
    try {
      const loaded = load(withOrders ? ["runtime", "npcRuntime", "npc"] : ["runtime", "npcRuntime"]);
      if (!loaded.ok) return loaded;
      if (!sceneLoadedIn(loaded.mods.runtime, systemId)) return { ok: false, reason: "SCENE_NOT_LOADED" };
      const inScene = splitInScene(loaded.mods.runtime, systemId, entityIds);
      if (!inScene.ok) return inScene;
      const npcRuntime = loaded.mods.npcRuntime;
      const npc = withOrders ? loaded.mods.npc : null;
      const scene = align === true || warpFx === true ? sceneOf(loaded.mods.runtime, systemId) : null;
      let warped = 0;
      let aligned = 0;
      let fellBack = 0;
      let fxSent = 0;
      const failed = [...inScene.missing];
      let detail = inScene.missing.length > 0 ? NOT_IN_SCENE : null;
      for (let i = 0; i < entityIds.length; i += 1) {
        const entityId = entityIds[i];
        if (inScene.missing.includes(entityId)) continue;
        const landing = landingPoint(center, i, entityIds.length, spread);
        if (align === true) {
          if (alignedWarp(scene, npc, entityId, landing)) {
            warped += 1;
            aligned += 1;
            continue;
          }
        } else if (clearAlignOrder === true) {
          resumeOrder(npc, entityId);
        }
        try {
          const result = npcRuntime.warpToPoint(entityId, landing, { ...data.HUNT_WARP_OPTIONS });
          if (result && result.success === true) {
            warped += 1;
            if (align === true) fellBack += 1;
            if (warpFx === true) {
              const fx = queueWarpingFx(requireGame, scene, entityId);
              if (fx.ok === true && fx.sent === true) fxSent += 1;
            }
            continue;
          }
          if (detail === null) detail = String((result && result.errorMsg) || "WARP_FAILED").slice(0, MAX_DETAIL);
        } catch (err) {
          if (detail === null) detail = messageOf(err);
        }
        failed.push(entityId);
      }
      const out = align === true ? { ok: true, warped, failed, aligned, fellBack } : { ok: true, warped, failed };
      if (warpFx === true) out.warpFx = fxSent;
      if (detail !== null) out.detail = detail;
      return out;
    } catch (err) {
      return { ok: false, reason: "WARP_FAILED", detail: messageOf(err) };
    }
  };

  const orderEach = (systemId, entityIds, overridesOf, orderOf) => {
    const loaded = load(["runtime", "npc"]);
    if (!loaded.ok) return loaded;
    if (!sceneLoadedIn(loaded.mods.runtime, systemId)) return { ok: false, reason: "SCENE_NOT_LOADED" };
    const inScene = splitInScene(loaded.mods.runtime, systemId, entityIds);
    if (!inScene.ok) return inScene;
    const npc = loaded.mods.npc;
    const failed = [...inScene.missing];
    let detail = inScene.missing.length > 0 ? NOT_IN_SCENE : null;
    for (let i = 0; i < entityIds.length; i += 1) {
      const entityId = entityIds[i];
      if (inScene.missing.includes(entityId)) continue;
      try {
        const set = npc.setBehaviorOverrides(entityId, overridesOf(entityId));
        const order = set && set.success === true ? npc.issueManualOrder(entityId, orderOf(i)) : set;
        const wake = order && order.success === true ? npc.wakeNpcController(entityId, 0) : order;
        if (wake && wake.success === true) continue;
        if (detail === null) detail = String((wake && wake.errorMsg) || "ORDER_FAILED").slice(0, MAX_DETAIL);
      } catch (err) {
        if (detail === null) detail = messageOf(err);
      }
      failed.push(entityId);
    }
    return detail === null ? { ok: true, failed } : { ok: true, failed, detail };
  };

  const setSearch = (systemId, entityIds) => {
    if (!isPositiveInt(systemId) || !isIdList(entityIds)) return { ok: false, reason: "INVALID_INPUT" };
    try {
      return orderEach(systemId, entityIds, () => ({ ...data.HUNT_SEARCH_BEHAVIOR }), () => ({ type: "stop" }));
    } catch (err) {
      return { ok: false, reason: "ORDER_FAILED", detail: messageOf(err) };
    }
  };

  const attackTargets = (systemId, entityIds, targetIds, options) => {
    if (!isPositiveInt(systemId) || !isIdList(entityIds) || !isIdList(targetIds) || targetIds.length === 0) {
      return { ok: false, reason: "INVALID_INPUT" };
    }
    const capitalIds = options && options.capitalIds !== undefined && options.capitalIds !== null
      ? options.capitalIds : null;
    if (capitalIds !== null && !(capitalIds instanceof Set)) {
      return { ok: false, reason: "INVALID_INPUT", detail: "capitalIds" };
    }
    const overridesOf = (entityId) => {
      const o = { ...data.COMBAT_BEHAVIOR_MANUAL, ...data.NO_LEASH_BEHAVIOR,
        autoAggroTargetClasses: [...data.AGGRO_CLASSES_NONE] };
      if (capitalIds !== null && capitalIds.has(entityId)) for (const key of data.CAPITAL_COMBAT_STRIP) delete o[key];
      return o;
    };
    try {
      const loaded = load(["runtime"]);
      if (!loaded.ok) return loaded;
      if (!sceneLoadedIn(loaded.mods.runtime, systemId)) return { ok: false, reason: "SCENE_NOT_LOADED" };
      const inScene = splitInScene(loaded.mods.runtime, systemId, targetIds);
      if (!inScene.ok) return inScene;
      const targets = targetIds.filter((id) => !inScene.missing.includes(id));
      const lock = attackLockFields(attackLock);
      return orderEach(systemId, entityIds, overridesOf,
        (i) => ({ type: "attack", targetID: targets[i % targets.length], allowPodKill: false, ...lock }));
    } catch (err) {
      return { ok: false, reason: "ORDER_FAILED", detail: messageOf(err) };
    }
  };

  const readAggressors = (systemId, entityIds) => {
    if (!isPositiveInt(systemId) || !isIdList(entityIds)) return { ok: false, reason: "INVALID_INPUT" };
    try {
      const loaded = load(["runtime", "npc"]);
      if (!loaded.ok) return loaded;
      if (!sceneLoadedIn(loaded.mods.runtime, systemId)) return { ok: false, reason: "SCENE_NOT_LOADED" };
      const inScene = splitInScene(loaded.mods.runtime, systemId, entityIds);
      if (!inScene.ok) return inScene;
      const scene = sceneOf(loaded.mods.runtime, systemId);
      let factionOf;
      const aggressors = [];
      for (const entityId of entityIds) {
        if (inScene.missing.includes(entityId)) continue;
        const controller = loaded.mods.npc.getControllerByEntityID(entityId);
        const aggressorId = toPositiveInt(controller && controller.lastAggressorID);
        if (aggressorId <= 0) continue;
        const entity = scene.getEntityByID(aggressorId);
        if (!entity) {
          aggressors.push({ entityId, aggressorId, aggressorKind: "gone", aggressorFactionId: null,
            aggressorPosition: null, aggressorInWarp: false });
          continue;
        }
        let kind = "other";
        if (entity.session) kind = "player";
        else if (loaded.mods.npc.getControllerByEntityID(aggressorId)) kind = "npc";
        let factionId = null;
        if (kind === "npc") {
          if (factionOf === undefined) factionOf = factionResolverOf(requireGame);
          factionId = factionOf(entity);
        }
        aggressors.push({ entityId, aggressorId, aggressorKind: kind, aggressorFactionId: factionId,
          aggressorPosition: pointOf(entity.position), aggressorInWarp: isInActiveWarp(entity) });
      }
      return { ok: true, aggressors };
    } catch (err) {
      return { ok: false, reason: "READ_FAILED", detail: messageOf(err) };
    }
  };

  const explainShips = (systemId, entityIds) => {
    if (!isPositiveInt(systemId) || !isIdList(entityIds)) return { ok: false, reason: "INVALID_INPUT" };
    try {
      const loaded = load(["runtime", "npc"]);
      if (!loaded.ok) return loaded;
      const scene = sceneOf(loaded.mods.runtime, systemId);
      const ships = entityIds.map((entityId) => ({
        entityId,
        inScene: Boolean(scene && scene.getEntityByID(entityId)),
        controller: Boolean(loaded.mods.npc.getControllerByEntityID(entityId)),
      }));
      return { ok: true, ships };
    } catch (err) {
      return { ok: false, reason: "READ_FAILED", detail: messageOf(err) };
    }
  };

  const armNpcCombat = (systemId, entityIds) => {
    const kind = data.LIVE_DUEL_OPERATOR_KIND;
    if (!isPositiveInt(systemId) || !isIdList(entityIds) || entityIds.length === 0
      || typeof kind !== "string" || kind === "") {
      return { ok: false, reason: "INVALID_INPUT" };
    }
    try {
      const loaded = load(["runtime", "npc"]);
      if (!loaded.ok) return loaded;
      if (!sceneLoadedIn(loaded.mods.runtime, systemId)) return { ok: false, reason: "SCENE_NOT_LOADED" };
      const inScene = splitInScene(loaded.mods.runtime, systemId, entityIds);
      if (!inScene.ok) return inScene;
      const npc = loaded.mods.npc;
      const failed = [...inScene.missing];
      let detail = inScene.missing.length > 0 ? NOT_IN_SCENE : null;
      let armed = 0;
      let already = 0;
      const fail = (entityId, why) => {
        failed.push(entityId);
        if (detail === null) detail = String(why).slice(0, MAX_DETAIL);
      };
      for (const entityId of entityIds) {
        if (inScene.missing.includes(entityId)) continue;
        try {
          const controller = npc.getControllerByEntityID(entityId);
          if (!controller || typeof controller !== "object") {
            fail(entityId, "NPC_NOT_FOUND");
            continue;
          }
          const current = String(controller.operatorKind || "").trim();
          if (current !== "" && current !== kind) {
            fail(entityId, "FOREIGN_OPERATOR");
            continue;
          }
          if (current === "" && Object.isFrozen(controller)) {
            fail(entityId, "OPERATOR_WRITE_FAILED");
            continue;
          }
          const overrides = controller.behaviorOverrides && typeof controller.behaviorOverrides === "object"
            ? controller.behaviorOverrides : {};
          if (overrides.allowFriendlyNpcTargets !== true) {
            const set = npc.setBehaviorOverrides(entityId, { ...overrides, allowFriendlyNpcTargets: true });
            if (!set || set.success !== true) {
              fail(entityId, (set && set.errorMsg) || "OVERRIDES_FAILED");
              continue;
            }
          }
          if (current === "") {
            try {
              controller.operatorKind = kind;
            } catch (_err) {
            }
            if (controller.operatorKind !== kind) {
              fail(entityId, "OPERATOR_WRITE_FAILED");
              continue;
            }
          }
          dormancyGuard.protect(entityId);
          if (current === "") armed += 1;
          else already += 1;
        } catch (err) {
          fail(entityId, messageOf(err));
        }
      }
      return detail === null ? { ok: true, armed, already, failed } : { ok: true, armed, already, failed, detail };
    } catch (err) {
      return { ok: false, reason: "ARM_FAILED", detail: messageOf(err) };
    }
  };

  const presentMiningBeams = (systemId, req) => {
    if (!isPositiveInt(systemId)) return { ok: false, reason: "INVALID_INPUT" };
    try {
      const loaded = load(["runtime"]);
      if (!loaded.ok) return loaded;
      if (!sceneLoadedIn(loaded.mods.runtime, systemId)) return { ok: false, reason: "SCENE_NOT_LOADED" };
      const scene = sceneOf(loaded.mods.runtime, systemId);
      if (!scene) return { ok: false, reason: "SCENE_NOT_LOADED" };
      const npcLoaded = req && req.approach ? load(["npc"]) : null;
      return presentBeams(scene, req, npcLoaded && npcLoaded.ok ? motionOf(npcLoaded.mods.npc) : null);
    } catch (err) {
      return { ok: false, reason: "FX_FAILED", detail: messageOf(err) };
    }
  };

  return { listSystemObjects, readPlayerShips, readShips, warpShips, setSearch, attackTargets, readAggressors,
    explainShips, armNpcCombat, presentMiningBeams };
}

module.exports = { MODULE_PATHS, FACTION_KILL_PATH, SIGNATURE_RUNTIME_PATH, REQUIRED_FUNCTIONS, SEAM_METHODS, createHuntScene, checkHuntSceneFrom,
  factionResolverOf };
