"use strict";

const PATHS = Object.freeze({
  crimewatch: "services/security/crimewatchState",
  npcRuntime: "space/npc/npcRuntime",
  entityConstants: "space/entityConstants",
  worldData: "space/worldData",
  runtime: "space/runtime",
});
const SPAWN_GROUP_QUERY = "concord_crimewatch_response";
const SPAWN_DISTANCE_METERS = 1000;
const SPAWN_SPREAD_METERS = 12000;
const ANCHOR_NAME = "LNE CONCORD Response";
const ANCHOR_DIRECTION = Object.freeze({ x: 1, y: 0, z: 0 });
const MAX_DETAIL = 120;

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const isPoint = (p) => Boolean(p) && isNum(p.x) && isNum(p.y) && isNum(p.z);
const messageOf = (err) => String((err && err.message) || err).slice(0, MAX_DETAIL);

function exportsOf(requireGame, rel) {
  const r = typeof requireGame === "function" ? requireGame(rel) : null;
  return r && r.ok === true && r.exports && typeof r.exports === "object" ? r.exports : null;
}

function concordResponseDelayMsFrom(requireGame, systemId) {
  if (!isId(systemId)) return { ok: false, reason: "INVALID_INPUT", detail: "systemId" };
  try {
    const crimewatch = exportsOf(requireGame, PATHS.crimewatch);
    const worldData = exportsOf(requireGame, PATHS.worldData);
    if (!crimewatch || typeof crimewatch.getConcordResponseDelayMsForSystem !== "function") {
      return { ok: false, reason: "SEAM_UNAVAILABLE", detail: PATHS.crimewatch };
    }
    if (!worldData || typeof worldData.getSolarSystemByID !== "function") {
      return { ok: false, reason: "SEAM_UNAVAILABLE", detail: PATHS.worldData };
    }
    const system = worldData.getSolarSystemByID(systemId);
    if (!system || typeof system !== "object") return { ok: false, reason: "NO_SYSTEM" };
    const ms = crimewatch.getConcordResponseDelayMsForSystem(system);
    if (!isNum(ms) || ms < 0) return { ok: false, reason: "READ_FAILED", detail: `ms ${String(ms)}` };
    return { ok: true, ms: Math.round(ms) };
  } catch (err) {
    return { ok: false, reason: "READ_FAILED", detail: messageOf(err) };
  }
}

function spawnConcordAgainstFrom(requireGame, systemId, targetIds, anchor) {
  const targets = Array.isArray(targetIds) ? targetIds.filter(isId) : [];
  if (!isId(systemId) || targets.length === 0 || !isPoint(anchor)) return { ok: false, reason: "INVALID_INPUT" };
  try {
    const npcRuntime = exportsOf(requireGame, PATHS.npcRuntime);
    const constants = exportsOf(requireGame, PATHS.entityConstants);
    const runtime = exportsOf(requireGame, PATHS.runtime);
    const entityType = constants && constants.ENTITY_TYPE && typeof constants.ENTITY_TYPE.CONCORD === "string"
      ? constants.ENTITY_TYPE.CONCORD : null;
    if (!npcRuntime || typeof npcRuntime.spawnGroupInSystem !== "function") {
      return { ok: false, reason: "SEAM_UNAVAILABLE", detail: PATHS.npcRuntime };
    }
    if (entityType === null) return { ok: false, reason: "SEAM_UNAVAILABLE", detail: PATHS.entityConstants };
    if (!runtime || typeof runtime.isSolarSystemSceneLoaded !== "function") {
      return { ok: false, reason: "SEAM_UNAVAILABLE", detail: PATHS.runtime };
    }
    if (runtime.isSolarSystemSceneLoaded(systemId) !== true) return { ok: false, reason: "SCENE_NOT_LOADED" };
    const r = npcRuntime.spawnGroupInSystem(systemId, {
      entityType,
      runtimeKind: "nativeCombat",
      spawnGroupQuery: SPAWN_GROUP_QUERY,
      anchorDescriptor: { kind: "coordinates", position: { x: anchor.x, y: anchor.y, z: anchor.z },
        direction: { ...ANCHOR_DIRECTION }, name: ANCHOR_NAME },
      preferredTargetID: targets[0],
      behaviorOverrides: { autoAggro: false, autoActivateWeapons: true, returnToHomeWhenIdle: false,
        leashRangeMeters: 0, allowPodKill: false },
      transient: true,
      spawnDistanceMeters: SPAWN_DISTANCE_METERS,
      spreadMeters: SPAWN_SPREAD_METERS,
    });
    const spawned = r && r.success === true && r.data && Array.isArray(r.data.spawned) ? r.data.spawned : null;
    if (!spawned) {
      return { ok: false, reason: "SPAWN_FAILED", detail: String((r && (r.errorMsg || r.error)) || "no_result")
        .slice(0, MAX_DETAIL) };
    }
    const entityIds = spawned.map((e) => Number(e && e.entity && e.entity.itemID)).filter(isId);
    return entityIds.length > 0 ? { ok: true, entityIds } : { ok: false, reason: "SPAWN_FAILED", detail: "no itemID" };
  } catch (err) {
    return { ok: false, reason: "SPAWN_FAILED", detail: messageOf(err) };
  }
}

module.exports = { PATHS, SPAWN_GROUP_QUERY, SPAWN_DISTANCE_METERS, SPAWN_SPREAD_METERS, ANCHOR_NAME,
  concordResponseDelayMsFrom, spawnConcordAgainstFrom };
