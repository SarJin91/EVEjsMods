"use strict";

const data = require("./data/liveProfiles");
const situationShips = require("./situationShips");

const MAX_DETAIL = 120;
const DEFAULT_REGISTER_CAP = 256;
const ROLES = Object.freeze(["victim", "pirate"]);
const GRID_KIND_OF = Object.freeze({ belt: "belt", gate: "gate" });

const PATHS = Object.freeze({
  runtime: "space/runtime",
  store: "space/npc/nativeNpcStore",
});
const FUNCTIONS = Object.freeze({
  runtime: Object.freeze(["isSolarSystemSceneLoaded"]),
  store: Object.freeze(["listNativeControllersForSystem"]),
});
const NAME_PATH = "space/worldData";
const NAME_FUNCTION = "getAsteroidBeltsForSystem";

const SEAM_METHODS = Object.freeze(["readAnchors", "readPlayers", "spawnShip", "engage", "attack", "readShips",
  "readAggressors", "warpTo", "despawn", "listSituationIds"]);

function messageOf(err) {
  return String((err && err.message) || err).slice(0, MAX_DETAIL);
}

function isPositiveInt(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function toPositiveInt(value) {
  const n = Math.trunc(Number(value));
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
}

function pointOf(value) {
  if (!value || typeof value !== "object") return null;
  const x = Number(value.x);
  const y = Number(value.y);
  const z = Number(value.z);
  return Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z) ? { x, y, z } : null;
}

function isIdList(list) {
  return Array.isArray(list) && list.every(isPositiveInt);
}

function isSituationEntity(entity) {
  if (!entity || typeof entity !== "object") return false;
  return String(entity.operatorKind || "").trim() === data.SITUATION_OPERATOR_KIND;
}

function checkSituationSceneFrom(requireGame) {
  const missing = [];
  for (const key of Object.keys(PATHS)) {
    let r = null;
    try {
      r = typeof requireGame === "function" ? requireGame(PATHS[key]) : null;
    } catch (_err) {
      r = null;
    }
    if (!r || r.ok !== true || !r.exports) {
      missing.push(PATHS[key]);
      continue;
    }
    for (const name of FUNCTIONS[key]) {
      if (typeof r.exports[name] !== "function") missing.push(`${PATHS[key]}.${name}`);
    }
    if (key === "runtime" && !(r.exports.scenes instanceof Map)) missing.push(`${PATHS.runtime}.scenes`);
  }
  return missing.length === 0 ? { ok: true } : { ok: false, reason: "SEAM_UNAVAILABLE", missing };
}

function createSituationScene(deps) {
  const requireGame = deps && deps.requireGame;
  const getNpcSpawn = deps && deps.getNpcSpawn;
  const getHuntScene = deps && deps.getHuntScene;

  const moduleOf = (key) => {
    if (typeof requireGame !== "function") return null;
    const read = requireGame(PATHS[key]);
    const mod = read && read.ok === true && read.exports ? read.exports : null;
    return mod && FUNCTIONS[key].every((name) => typeof mod[name] === "function") ? mod : null;
  };

  const sceneOf = (systemId) => {
    const runtime = moduleOf("runtime");
    if (!runtime || !(runtime.scenes instanceof Map)) return { ok: false, reason: "SEAM_UNAVAILABLE" };
    if (runtime.isSolarSystemSceneLoaded(systemId) !== true) return { ok: false, reason: "SCENE_NOT_LOADED" };
    const scene = runtime.scenes.get(systemId);
    if (!scene || typeof scene.getEntityByID !== "function") return { ok: false, reason: "SCENE_NOT_LOADED" };
    return { ok: true, scene };
  };

  const facade = (getter, names) => {
    const f = typeof getter === "function" ? getter() : null;
    return f && names.every((name) => typeof f[name] === "function") ? f : null;
  };

  const beltNamesOf = (systemId) => {
    try {
      const read = typeof requireGame === "function" ? requireGame(NAME_PATH) : null;
      const wd = read && read.ok === true && read.exports ? read.exports : null;
      if (!wd || typeof wd[NAME_FUNCTION] !== "function") return new Map();
      const out = new Map();
      for (const r of wd[NAME_FUNCTION](systemId) || []) {
        const id = toPositiveInt(r && r.itemID);
        if (id && typeof r.itemName === "string" && r.itemName.trim() !== "") out.set(id, r.itemName.trim());
      }
      return out;
    } catch (_err) {
      return new Map();
    }
  };

  const readAnchors = (systemId) => {
    if (!isPositiveInt(systemId)) return { ok: false, reason: "INVALID_INPUT" };
    try {
      const sc = sceneOf(systemId);
      if (!sc.ok) return sc;
      const lists = { asteroidBelt: [], stargate: [] };
      const statics = Array.isArray(sc.scene.staticEntities) ? sc.scene.staticEntities : [];
      for (const entity of statics) {
        const kind = entity ? String(entity.kind || "").trim() : "";
        if (!Object.prototype.hasOwnProperty.call(lists, kind)) continue;
        const itemId = toPositiveInt(entity.itemID);
        const position = pointOf(entity.position);
        if (!itemId || position === null) continue;
        const radius = Number(entity.radius);
        const row = { itemId, position, radius: Number.isFinite(radius) && radius >= 0 ? radius : 0 };
        if (kind === "stargate") {
          row.name = typeof entity.itemName === "string" && entity.itemName.trim() !== "" ? entity.itemName.trim()
            : null;
        }
        lists[kind].push(row);
      }
      for (const list of Object.values(lists)) list.sort((a, b) => a.itemId - b.itemId);
      const names = lists.asteroidBelt.length > 0 ? beltNamesOf(systemId) : new Map();
      const belts = lists.asteroidBelt.map((b) => ({ ...b, name: names.get(b.itemId) || null }));
      return { ok: true, belts, gates: lists.stargate };
    } catch (err) {
      return { ok: false, reason: "READ_FAILED", detail: messageOf(err) };
    }
  };

  const readPlayers = (systemId) => {
    if (!isPositiveInt(systemId)) return { ok: false, reason: "INVALID_INPUT" };
    try {
      const hunt = facade(getHuntScene, ["readPlayerShips"]);
      if (!hunt) return { ok: false, reason: "SEAM_UNAVAILABLE" };
      const r = hunt.readPlayerShips(systemId);
      return r && typeof r === "object" ? r : { ok: false, reason: "READ_FAILED" };
    } catch (err) {
      return { ok: false, reason: "READ_FAILED", detail: messageOf(err) };
    }
  };

  const refuseSpawned = (spawn, systemId, entityId, detail) => {
    let leftover = entityId ? [entityId] : [];
    if (entityId) {
      try {
        const r = spawn.despawn(systemId, [entityId]);
        if (r && r.ok === true) leftover = [];
      } catch (_err) {
        leftover = [entityId];
      }
    }
    return { ok: false, reason: "SPAWN_FAILED", detail: String(detail).slice(0, MAX_DETAIL), leftover };
  };

  const spawnShip = (systemId, spec) => {
    const s = spec && typeof spec === "object" ? spec : {};
    const profileId = typeof s.profileId === "string" ? s.profileId.trim() : "";
    const anchor = s.anchor && typeof s.anchor === "object" ? s.anchor : null;
    const offset = s.spawnOffsetMeters;
    const slimName = s.slimName === undefined || s.slimName === null ? null : s.slimName;
    const cap = s.registerCap === undefined ? DEFAULT_REGISTER_CAP : s.registerCap;
    if (!isPositiveInt(systemId) || !ROLES.includes(s.role) || profileId === "" || !anchor
      || typeof s.situationId !== "string" || s.situationId === ""
      || typeof offset !== "number" || !Number.isFinite(offset) || offset < 0
      || (slimName !== null && typeof slimName !== "string") || !isPositiveInt(cap)) {
      return { ok: false, reason: "INVALID_INPUT" };
    }
    if (!Object.prototype.hasOwnProperty.call(GRID_KIND_OF, anchor.kind)) {
      return { ok: false, reason: "ANCHOR_UNSUPPORTED" };
    }
    if (!isPositiveInt(anchor.id)) return { ok: false, reason: "INVALID_INPUT" };
    let spawn = null;
    let entityId = 0;
    try {
      spawn = facade(getNpcSpawn, ["pickGridAnchor", "spawnShip", "publish", "despawn"]);
      if (!spawn) return { ok: false, reason: "SEAM_UNAVAILABLE" };
      const sc = sceneOf(systemId);
      if (!sc.ok) return sc;
      const grid = spawn.pickGridAnchor(systemId, { kind: GRID_KIND_OF[anchor.kind], id: anchor.id });
      if (!grid || grid.ok !== true || !grid.anchorDescriptor) {
        const reason = grid && ["SCENE_NOT_LOADED", "SEAM_UNAVAILABLE"].includes(grid.reason) ? grid.reason
          : "GRID_ANCHOR_UNKNOWN";
        return { ok: false, reason };
      }
      const radius = Number.isFinite(grid.radiusMeters) && grid.radiusMeters >= 0 ? grid.radiusMeters : 0;
      const shot = spawn.spawnShip(systemId, { profileId, anchorDescriptor: grid.anchorDescriptor,
        spawnDistanceMeters: radius + offset, purpose: "situation", role: s.role,
        ...(slimName !== null ? { slimName } : {}) });
      if (!shot || shot.ok !== true || !isPositiveInt(shot.entityId)) {
        if (shot && shot.reason === "SCENE_NOT_LOADED") return { ok: false, reason: "SCENE_NOT_LOADED" };
        if (shot && shot.reason === "SCENE_NPC_BUDGET") return { ok: false, reason: "SCENE_NPC_BUDGET" };
        return { ok: false, reason: "SPAWN_FAILED",
          detail: String((shot && (shot.detail || shot.reason)) || "SPAWN_FAILED").slice(0, MAX_DETAIL) };
      }
      entityId = shot.entityId;
      const pub = spawn.publish(systemId, [entityId]);
      if (!pub || pub.ok !== true) return refuseSpawned(spawn, systemId, entityId, "PUBLISH_FAILED");
      if (!(pub.published >= 1)) return refuseSpawned(spawn, systemId, entityId, "PUBLISH_PARTIAL");
      situationShips.markSituationShips([entityId], { situationId: s.situationId, role: s.role, cap });
      return { ok: true, entityId };
    } catch (err) {
      return spawn ? refuseSpawned(spawn, systemId, entityId, messageOf(err))
        : { ok: false, reason: "SPAWN_FAILED", detail: messageOf(err) };
    }
  };

  const engage = (systemId, pirateIds, victimIds) => {
    if (!isPositiveInt(systemId) || !isIdList(pirateIds) || !isIdList(victimIds) || pirateIds.length === 0
      || victimIds.length === 0) return { ok: false, reason: "INVALID_INPUT" };
    try {
      const spawn = facade(getNpcSpawn, ["engage"]);
      if (!spawn) return { ok: false, reason: "SEAM_UNAVAILABLE" };
      const r = spawn.engage(systemId, pirateIds, victimIds, { targetMode: "manual", attackersOnly: true });
      return r && typeof r === "object" ? r : { ok: false, reason: "ENGAGE_FAILED" };
    } catch (err) {
      return { ok: false, reason: "ENGAGE_FAILED", detail: messageOf(err) };
    }
  };

  const attack = (systemId, entityId, targetId) => {
    if (!isPositiveInt(systemId) || !isPositiveInt(entityId) || !isPositiveInt(targetId)) {
      return { ok: false, reason: "INVALID_INPUT" };
    }
    try {
      const spawn = facade(getNpcSpawn, ["orderAttack"]);
      if (!spawn) return { ok: false, reason: "SEAM_UNAVAILABLE" };
      const r = spawn.orderAttack(systemId, entityId, targetId);
      return r && typeof r === "object" ? r : { ok: false, reason: "ORDER_FAILED" };
    } catch (err) {
      return { ok: false, reason: "ORDER_FAILED", detail: messageOf(err) };
    }
  };

  const readShips = (systemId, entityIds) => {
    if (!isPositiveInt(systemId) || !isIdList(entityIds)) return { ok: false, reason: "INVALID_INPUT" };
    try {
      const hunt = facade(getHuntScene, ["readShips"]);
      if (!hunt) return { ok: false, reason: "SEAM_UNAVAILABLE" };
      const sc = sceneOf(systemId);
      if (!sc.ok && sc.reason === "SCENE_NOT_LOADED") return { ok: true, sceneLoaded: false };
      if (!sc.ok) return sc;
      if (entityIds.length === 0) return { ok: true, sceneLoaded: true, live: [], gone: [] };
      const r = hunt.readShips(systemId, entityIds);
      if (!r || r.ok !== true || !Array.isArray(r.ships)) {
        return { ok: false, reason: (r && r.reason === "SEAM_UNAVAILABLE") ? "SEAM_UNAVAILABLE" : "READ_FAILED" };
      }
      const live = [];
      const seen = new Set();
      for (const ship of r.ships) {
        const entityId = toPositiveInt(ship && ship.entityId);
        const position = pointOf(ship && ship.position);
        if (!entityId || position === null || seen.has(entityId)) continue;
        seen.add(entityId);
        live.push({ entityId, position, inWarp: ship.inWarp === true });
      }
      return { ok: true, sceneLoaded: true, live, gone: entityIds.filter((id) => !seen.has(id)) };
    } catch (err) {
      return { ok: false, reason: "READ_FAILED", detail: messageOf(err) };
    }
  };

  const readAggressors = (systemId, entityIds) => {
    if (!isPositiveInt(systemId) || !isIdList(entityIds)) return { ok: false, reason: "INVALID_INPUT" };
    try {
      const hunt = facade(getHuntScene, ["readAggressors"]);
      if (!hunt) return { ok: false, reason: "SEAM_UNAVAILABLE" };
      if (entityIds.length === 0) return { ok: true, aggressors: [] };
      const r = hunt.readAggressors(systemId, entityIds);
      return r && typeof r === "object" ? r : { ok: false, reason: "READ_FAILED" };
    } catch (err) {
      return { ok: false, reason: "READ_FAILED", detail: messageOf(err) };
    }
  };

  const warpTo = (systemId, entityIds, point) => {
    const target = pointOf(point);
    if (!isPositiveInt(systemId) || !isIdList(entityIds) || entityIds.length === 0 || target === null) {
      return { ok: false, reason: "INVALID_INPUT" };
    }
    try {
      const hunt = facade(getHuntScene, ["warpShips"]);
      if (!hunt) return { ok: false, reason: "SEAM_UNAVAILABLE" };
      const r = hunt.warpShips(systemId, entityIds, target, { spreadMeters: 0 });
      return r && typeof r === "object" ? r : { ok: false, reason: "WARP_FAILED" };
    } catch (err) {
      return { ok: false, reason: "WARP_FAILED", detail: messageOf(err) };
    }
  };

  const despawn = (systemId, entityIds) => {
    if (!isPositiveInt(systemId) || !isIdList(entityIds)) return { ok: false, reason: "INVALID_INPUT" };
    try {
      const spawn = facade(getNpcSpawn, ["despawn"]);
      if (!spawn) return { ok: false, reason: "SEAM_UNAVAILABLE" };
      if (entityIds.length === 0) return { ok: true, removed: 0, missing: 0 };
      const r = spawn.despawn(systemId, entityIds);
      const failed = new Set(r && Array.isArray(r.failed) ? r.failed : []);
      situationShips.forgetSituationShips(entityIds.filter((id) => !failed.has(id)));
      return r && typeof r === "object" ? r : { ok: false, reason: "DESPAWN_FAILED" };
    } catch (err) {
      return { ok: false, reason: "DESPAWN_FAILED", detail: messageOf(err) };
    }
  };

  const listSituationIds = (systemId) => {
    if (!isPositiveInt(systemId)) return { ok: false, reason: "INVALID_INPUT" };
    try {
      const store = moduleOf("store");
      if (!store) return { ok: false, reason: "SEAM_UNAVAILABLE" };
      const sc = sceneOf(systemId);
      if (!sc.ok) return sc;
      const ids = new Set();
      const dynamics = sc.scene.dynamicEntities instanceof Map ? sc.scene.dynamicEntities.values() : [];
      for (const entity of dynamics) {
        if (!isSituationEntity(entity)) continue;
        const itemId = toPositiveInt(entity.itemID);
        if (itemId) ids.add(itemId);
      }
      const controllers = store.listNativeControllersForSystem(systemId);
      for (const controller of Array.isArray(controllers) ? controllers : []) {
        if (!isSituationEntity(controller)) continue;
        const entityId = toPositiveInt(controller.entityID);
        if (entityId) ids.add(entityId);
      }
      return { ok: true, ids: [...ids].sort((a, b) => a - b) };
    } catch (err) {
      return { ok: false, reason: "READ_FAILED", detail: messageOf(err) };
    }
  };

  return Object.freeze({ readAnchors, readPlayers, spawnShip, engage, attack, readShips, readAggressors, warpTo,
    despawn, listSituationIds });
}

module.exports = { PATHS, FUNCTIONS, NAME_PATH, NAME_FUNCTION, SEAM_METHODS, DEFAULT_REGISTER_CAP, isSituationEntity,
  createSituationScene, checkSituationSceneFrom };
