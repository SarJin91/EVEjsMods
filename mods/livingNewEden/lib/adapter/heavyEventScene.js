"use strict";

const data = require("./data/liveProfiles");
const bossProfiles = require("./data/bossProfiles");

const MAX_DETAIL = 120;

const PATHS = Object.freeze({
  runtime: "space/runtime",
  native: "space/npc/nativeNpcService",
  npc: "space/npc/npcService",
  hulls: "space/npc/pirateHullProfiles",
});
const FUNCTIONS = Object.freeze({
  runtime: Object.freeze(["isSolarSystemSceneLoaded"]),
  native: Object.freeze(["spawnNativeNpcEntityInSystem"]),
  npc: Object.freeze(["destroyNpcControllerByEntityID"]),
  hulls: Object.freeze(["resolveFactionHullProfileID"]),
});

const SEAM_METHODS = Object.freeze(["readGrid", "spawnPhase", "readMembers", "despawn"]);

const GRID_REASONS = Object.freeze(["SCENE_NOT_LOADED", "SEAM_UNAVAILABLE", "INVALID_INPUT"]);

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

function withinRange(a, b, radius) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return dx * dx + dy * dy + dz * dz <= radius * radius;
}

function isPositiveNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isHeavyEventVictim(entity) {
  if (!entity || typeof entity !== "object") return false;
  return String(entity.operatorKind || "").trim() === data.HEAVY_OPERATOR_KIND;
}

function checkHeavyEventSceneFrom(requireGame) {
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

function createHeavyEventScene(deps) {
  const requireGame = deps && deps.requireGame;
  const getNpcSpawn = deps && deps.getNpcSpawn;
  const getHuntScene = deps && deps.getHuntScene;

  const runtimeModule = () => {
    if (typeof requireGame !== "function") return null;
    const read = requireGame(PATHS.runtime);
    const runtime = read && read.ok === true && read.exports ? read.exports : null;
    return runtime && typeof runtime.isSolarSystemSceneLoaded === "function" && runtime.scenes instanceof Map
      ? runtime : null;
  };

  const sceneOf = (systemId) => {
    const runtime = runtimeModule();
    if (!runtime) return { ok: false, reason: "SEAM_UNAVAILABLE" };
    if (runtime.isSolarSystemSceneLoaded(systemId) !== true) return { ok: false, reason: "SCENE_NOT_LOADED" };
    const scene = runtime.scenes.get(systemId);
    if (!scene || typeof scene.getEntityByID !== "function") return { ok: false, reason: "SCENE_NOT_LOADED" };
    return { ok: true, scene };
  };

  const readGrid = (systemId, point, radiusM) => {
    const center = pointOf(point);
    if (!isPositiveInt(systemId) || center === null || !isPositiveNumber(radiusM)) {
      return { ok: false, reason: "INVALID_INPUT" };
    }
    try {
      const sc = sceneOf(systemId);
      if (!sc.ok) return sc;
      const hunt = typeof getHuntScene === "function" ? getHuntScene() : null;
      if (!hunt || typeof hunt.readPlayerShips !== "function") return { ok: false, reason: "SEAM_UNAVAILABLE" };
      const read = hunt.readPlayerShips(systemId);
      if (!read || read.ok !== true || !Array.isArray(read.ships)) {
        const reason = read && GRID_REASONS.includes(read.reason) ? read.reason : "READ_FAILED";
        return { ok: false, reason };
      }
      const present = new Set();
      const players = [];
      for (const ship of read.ships) {
        const characterId = toPositiveInt(ship && ship.characterId);
        if (!characterId) continue;
        present.add(characterId);
        const position = pointOf(ship.position);
        if (ship.capsule === true || position === null || !withinRange(position, center, radiusM)) continue;
        players.push({ characterId, entityId: toPositiveInt(ship.entityId) });
      }
      let copies = 0;
      const dynamics = sc.scene.dynamicEntities instanceof Map ? sc.scene.dynamicEntities.values() : [];
      for (const entity of dynamics) {
        if (!entity || entity.kind !== "ship" || entity.session || entity.nativeNpc === true) continue;
        if (!present.has(toPositiveInt(entity.pilotCharacterID))) continue;
        const position = pointOf(entity.position);
        if (position !== null && withinRange(position, center, radiusM)) copies += 1;
      }
      return { ok: true, players, copies };
    } catch (err) {
      return { ok: false, reason: "READ_FAILED", detail: messageOf(err) };
    }
  };

  const classChain = (hullGroup, substitute) => {
    const chain = [hullGroup];
    const table = substitute && typeof substitute === "object" ? substitute : {};
    let current = hullGroup;
    while (Object.prototype.hasOwnProperty.call(table, current)) {
      const next = table[current];
      if (typeof next !== "string" || next === "" || chain.includes(next)) break;
      chain.push(next);
      current = next;
    }
    return chain;
  };

  const validPhase = (input) => {
    if (!input || typeof input !== "object") return null;
    const eventId = typeof input.eventId === "string" ? input.eventId.trim() : "";
    const anchor = pointOf(input.anchorPoint);
    const ownerId = input.ownerId === undefined || input.ownerId === null ? null : input.ownerId;
    const members = Array.isArray(input.members) ? input.members : null;
    if (!eventId || !isPositiveInt(input.factionId) || anchor === null || !members || members.length === 0
      || !isPositiveNumber(input.spawnDistanceM) || !isPositiveNumber(input.aggroRangeM)
      || !isPositiveNumber(input.leashRangeM) || (ownerId !== null && !isPositiveInt(ownerId))) return null;
    for (const m of members) {
      if (!m || typeof m.memberKey !== "string" || m.memberKey === "" || typeof m.hullGroup !== "string"
        || m.hullGroup === "") return null;
    }
    return { eventId, anchor, ownerId, members };
  };

  const spawnPhase = (systemId, input) => {
    const spec = validPhase(input);
    if (!isPositiveInt(systemId) || spec === null) return { ok: false, reason: "INVALID_INPUT" };
    const spawned = [];
    let spawn = null;
    try {
      spawn = typeof getNpcSpawn === "function" ? getNpcSpawn() : null;
      if (!spawn || typeof spawn.spawnShip !== "function" || typeof spawn.resolveProfiles !== "function"
        || typeof spawn.publish !== "function") return { ok: false, reason: "SEAM_UNAVAILABLE" };
      const sc = sceneOf(systemId);
      if (!sc.ok) return sc;
      if (typeof spawn.admitScene === "function") {
        const gate = spawn.admitScene(systemId, spec.members.length, "heavyEvents");
        if (gate && gate.ok === false) return { ok: false, reason: gate.reason, count: gate.count, cap: gate.cap };
      }
      const unspawnable = [];
      for (const member of spec.members) {
        let profile = null;
        let reason = "NO_PROFILE";
        const named = member.profileId !== undefined && member.profileId !== null;
        if (named && bossProfiles.BOSS_PROFILE_IDS.includes(member.profileId)) {
          profile = { profileId: member.profileId, hullGroup: member.hullGroup };
        }
        for (const hullGroup of named ? [] : classChain(member.hullGroup, input.substitute)) {
          const r = spawn.resolveProfiles([{ memberKey: member.memberKey, factionId: input.factionId, hullGroup }],
            { seedPrefix: spec.eventId, invaders: true, industry: true });
          if (r && r.ok === true && Array.isArray(r.profiles) && typeof r.profiles[0] === "string") {
            profile = { profileId: r.profiles[0], hullGroup };
            break;
          }
          reason = String((r && r.reason) || "NO_PROFILE");
          if (reason !== "NO_PROFILE") break;
        }
        if (profile === null) {
          unspawnable.push({ memberKey: member.memberKey, reason });
          continue;
        }
        const capital = Array.isArray(data.CAPITAL_LIVE_GROUPS) && data.CAPITAL_LIVE_GROUPS.includes(profile.hullGroup);
        const shot = spawn.spawnShip(systemId, {
          profileId: profile.profileId,
          anchorDescriptor: { kind: "coordinates", position: { ...spec.anchor } },
          spawnDistanceMeters: input.spawnDistanceM,
          purpose: "heavyEvent",
          guard: { proximityAggroRangeMeters: input.aggroRangeM, leashRangeMeters: input.leashRangeM,
            ...(capital ? { capital: true } : {}) },
          ownerId: spec.ownerId,
        });
        if (shot && shot.ok === true && isPositiveInt(shot.entityId)) {
          spawned.push({ memberKey: member.memberKey, entityId: shot.entityId, hullGroup: profile.hullGroup });
        } else {
          unspawnable.push({ memberKey: member.memberKey, reason: String((shot && shot.reason) || "SPAWN_FAILED") });
        }
      }
      if (spawned.length > 0) {
        const ids = spawned.map((s) => s.entityId);
        const pub = spawn.publish(systemId, ids);
        if (!pub || pub.ok !== true) return refuseSpawned(spawn, systemId, spawned, "PUBLISH_FAILED");
        if (!(pub.published >= ids.length)) return refuseSpawned(spawn, systemId, spawned, "PUBLISH_PARTIAL");
      }
      return { ok: true, spawned, unspawnable };
    } catch (err) {
      return refuseSpawned(spawn, systemId, spawned, messageOf(err));
    }
  };

  const refuseSpawned = (spawn, systemId, spawned, detail) => {
    const ids = spawned.map((s) => s.entityId);
    let leftover = ids;
    if (ids.length > 0 && spawn && typeof spawn.despawn === "function") {
      try {
        const r = spawn.despawn(systemId, ids);
        if (r && r.ok === true) leftover = [];
        else if (r && Array.isArray(r.failed)) leftover = r.failed.slice();
      } catch (_) {
        leftover = ids;
      }
    }
    return { ok: false, reason: "SPAWN_FAILED", detail: String(detail).slice(0, MAX_DETAIL), spawned, leftover };
  };

  const readMembers = (systemId, entityIds) => {
    if (!isPositiveInt(systemId) || !Array.isArray(entityIds)) return { ok: false, reason: "INVALID_INPUT" };
    try {
      const sc = sceneOf(systemId);
      if (!sc.ok) return sc;
      const live = [];
      const gone = [];
      for (const raw of entityIds) {
        const entityId = toPositiveInt(raw);
        if (!entityId) continue;
        const entity = sc.scene.getEntityByID(entityId);
        if (entity) live.push({ entityId, position: pointOf(entity.position) });
        else gone.push(entityId);
      }
      return { ok: true, live, gone };
    } catch (err) {
      return { ok: false, reason: "READ_FAILED", detail: messageOf(err) };
    }
  };

  const despawn = (systemId, entityIds) => {
    if (!isPositiveInt(systemId) || !Array.isArray(entityIds)) return { ok: false, reason: "INVALID_INPUT" };
    try {
      const spawn = typeof getNpcSpawn === "function" ? getNpcSpawn() : null;
      if (!spawn || typeof spawn.despawn !== "function") return { ok: false, reason: "SEAM_UNAVAILABLE" };
      const ids = entityIds.map(toPositiveInt).filter((id) => id > 0);
      if (ids.length === 0) return { ok: true, removed: 0, missing: 0 };
      const r = spawn.despawn(systemId, ids);
      if (!r || r.ok !== true) {
        return { ok: false, reason: String((r && r.reason) || "DESPAWN_FAILED"),
          removed: Number(r && r.removed) || 0, missing: Number(r && r.missing) || 0,
          failed: r && Array.isArray(r.failed) ? r.failed.slice() : ids,
          ...(r && r.detail ? { detail: String(r.detail).slice(0, MAX_DETAIL) } : {}) };
      }
      return { ok: true, removed: Number(r.removed) || 0, missing: Number(r.missing) || 0 };
    } catch (err) {
      return { ok: false, reason: "DESPAWN_FAILED", detail: messageOf(err) };
    }
  };

  return Object.freeze({ readGrid, spawnPhase, readMembers, despawn });
}

module.exports = { PATHS, FUNCTIONS, SEAM_METHODS, isHeavyEventVictim, createHeavyEventScene,
  checkHeavyEventSceneFrom };
