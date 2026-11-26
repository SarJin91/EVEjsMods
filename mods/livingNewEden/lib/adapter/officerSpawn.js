"use strict";

const { admitOrPass } = require("./sceneNpcBudget");

const MAX_DETAIL = 120;
const OPERATOR_KIND = "lneOfficer";
const SITE_PREFIX = "lneOfficer";
const ANCHOR_KIND = "ship";
const OFFICER_KIND = "officer";
const SPREAD_METERS = 0;

const OFFICER_FACTION_KEYS = Object.freeze({
  500010: "guristas", 500011: "angels", 500012: "blood", 500019: "sanshas", 500020: "serpentis",
});

const PATHS = Object.freeze({
  belt: "space/npc/beltRatRuntime",
  runtime: "space/runtime",
});

function toPositiveInt(value) {
  const n = Math.trunc(Number(value));
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
}

function messageOf(err) {
  return String((err && err.message) || err).slice(0, MAX_DETAIL);
}

function factionKeyOf(factionId) {
  const id = toPositiveInt(factionId);
  return id && Object.prototype.hasOwnProperty.call(OFFICER_FACTION_KEYS, id) ? OFFICER_FACTION_KEYS[id] : null;
}

function spawnedEntityIds(spawned) {
  return (Array.isArray(spawned) ? spawned : []).map((entry) => toPositiveInt(entry && entry.entity
    && entry.entity.itemID)).filter((id) => id > 0);
}

function createOfficerSpawnSeam(deps) {
  const requireGame = deps && deps.requireGame;
  const getSpawnTools = deps && deps.getSpawnTools;
  const admit = admitOrPass(deps && deps.admit);
  let seq = 0;

  function load(key) {
    if (typeof requireGame !== "function") return null;
    const read = requireGame(PATHS[key]);
    return read && read.ok === true && read.exports ? read.exports : null;
  }

  function sceneOf(runtime, systemId) {
    if (runtime.isSolarSystemSceneLoaded(systemId) !== true) return { ok: false, reason: "SCENE_NOT_LOADED" };
    const scene = runtime.scenes.get(systemId);
    if (!scene || typeof scene.getEntityByID !== "function") return { ok: false, reason: "SCENE_NOT_LOADED" };
    if (!(scene.sessions instanceof Map) || typeof scene.getShipEntityForSession !== "function") {
      return { ok: false, reason: "SEAM_UNAVAILABLE", detail: "scene.sessions/getShipEntityForSession" };
    }
    return { ok: true, scene };
  }

  function findPilot(scene, characterId) {
    let session = null;
    for (const s of scene.sessions.values()) {
      if (s && toPositiveInt(s.characterID || s.charid) === characterId) {
        session = s;
        break;
      }
    }
    if (!session) return { ok: false, reason: "NO_SESSION" };
    if (toPositiveInt(session.stationid || session.stationID) > 0
      || toPositiveInt(session.structureid || session.structureID) > 0) return { ok: false, reason: "DOCKED" };
    const ship = scene.getShipEntityForSession(session);
    if (!ship || toPositiveInt(ship.itemID) === 0 || !ship.position) return { ok: false, reason: "NO_SHIP" };
    return { ok: true, session, ship };
  }

  function validInput(input) {
    if (!input || typeof input !== "object") return null;
    const systemId = toPositiveInt(input.systemId);
    const characterId = toPositiveInt(input.characterId);
    const distance = Number(input.distanceMeters);
    const factionKey = input.factionKey === null || input.factionKey === undefined ? null : input.factionKey;
    if (!systemId || !characterId || !(Number.isFinite(distance) && distance > 0)) return null;
    if (factionKey !== null && (typeof factionKey !== "string" || factionKey.length === 0)) return null;
    if (typeof input.reserve !== "function") return null;
    return { systemId, characterId, distance, factionKey, reserve: input.reserve };
  }

  function spawnOfficer(input) {
    let reserved = false;
    try {
      const i = validInput(input);
      if (!i) return { ok: false, reason: "INVALID_INPUT" };
      const belt = load("belt");
      const runtime = load("runtime");
      const tools = typeof getSpawnTools === "function" ? getSpawnTools() : null;
      if (!belt || typeof belt.buildBeltRatSpawnPlan !== "function" || !runtime
        || typeof runtime.isSolarSystemSceneLoaded !== "function" || !(runtime.scenes instanceof Map)
        || !tools || tools.ok !== true || typeof tools.spawnNativeDefinitionsInContext !== "function") {
        return { ok: false, reason: "SEAM_UNAVAILABLE", detail: String((tools && tools.reason) || "") };
      }
      const sc = sceneOf(runtime, i.systemId);
      if (!sc.ok) return sc;
      const pilot = findPilot(sc.scene, i.characterId);
      if (!pilot.ok) return { ok: false, reason: "NO_SHIP", detail: pilot.reason };
      const plan = belt.buildBeltRatSpawnPlan(i.systemId, { skipSpecialSpawns: true,
        forceSpecialSpawnKind: OFFICER_KIND, ...(i.factionKey ? { factionKey: i.factionKey } : {}) });
      const data = plan && plan.success === true && plan.data ? plan.data : null;
      if (!data || data.specialSpawnKind !== OFFICER_KIND || !Array.isArray(data.definitions)
        || data.definitions.length === 0) {
        return { ok: false, reason: "NOT_ELIGIBLE", detail: String((plan && plan.errorMsg) || "NO_PLAN")
          .slice(0, MAX_DETAIL) };
      }
      const gate = admit(i.systemId, data.definitions.length, "officerSpawn");
      if (gate.ok !== true) return gate;
      const r = i.reserve();
      reserved = true;
      if (!r || r.ok !== true) {
        return { ok: false, reason: "RESERVE_REFUSED", detail: String((r && r.reason) || "NO_RESULT")
          .slice(0, MAX_DETAIL) };
      }
      const ship = pilot.ship;
      const shipId = toPositiveInt(ship.itemID);
      seq += 1;
      const spawnSiteID = `${SITE_PREFIX}:${i.characterId}:${seq}`;
      const selectionID = `${SITE_PREFIX}:${String(data.selectionID || "")}`;
      const selectionName = String(data.selectionName || selectionID);
      const anchorName = String(ship.itemName || ship.slimName || ANCHOR_KIND);
      const context = { systemID: i.systemId, scene: sc.scene, anchorEntity: ship, preferredTargetID: shipId,
        anchorKind: ANCHOR_KIND, anchorLabel: anchorName };
      const selection = { success: true, data: { selectionKind: OPERATOR_KIND, selectionID, selectionName,
        definitions: data.definitions } };
      const res = tools.spawnNativeDefinitionsInContext(context, selection, {
        entityType: "npc", transient: true, broadcast: false, deferGroupBehaviorTick: true, preferredTargetID: shipId,
        spawnDistanceMeters: i.distance, spreadMeters: SPREAD_METERS, selectionKind: OPERATOR_KIND, selectionID,
        selectionName, operatorKind: OPERATOR_KIND, anchorKind: ANCHOR_KIND, anchorID: shipId, anchorName,
        spawnSiteID,
      });
      const spawned = res && res.success === true && res.data && Array.isArray(res.data.spawned) ? res.data.spawned
        : [];
      if (spawned.length === 0) {
        return { ok: false, reason: "SPAWN_FAILED", detail: String((res && res.errorMsg) || "NO_RESULT")
          .slice(0, MAX_DETAIL) };
      }
      return { ok: true, entityIds: spawnedEntityIds(spawned),
        profileIds: (Array.isArray(data.profileIDs) ? data.profileIDs : []).map(String),
        factionKey: String(data.factionKey || i.factionKey || "") };
    } catch (err) {
      return { ok: false, reason: reserved ? "SPAWN_FAILED" : "SEAM_UNAVAILABLE", detail: messageOf(err) };
    }
  }

  return Object.freeze({ factionKeyOf, spawnOfficer });
}

function checkOfficerSpawnSeamsFrom(requireGame) {
  const missing = [];
  const read = (key) => {
    const r = typeof requireGame === "function" ? requireGame(PATHS[key]) : null;
    if (!r || r.ok !== true || !r.exports) {
      missing.push(PATHS[key]);
      return null;
    }
    return r.exports;
  };
  const belt = read("belt");
  if (belt && typeof belt.buildBeltRatSpawnPlan !== "function") missing.push(`${PATHS.belt}.buildBeltRatSpawnPlan`);
  const runtime = read("runtime");
  if (runtime && (typeof runtime.isSolarSystemSceneLoaded !== "function" || !(runtime.scenes instanceof Map))) {
    missing.push(`${PATHS.runtime}.isSolarSystemSceneLoaded/scenes`);
  }
  return missing.length === 0 ? { ok: true } : { ok: false, reason: "SEAM_UNAVAILABLE", missing };
}

module.exports = { OPERATOR_KIND, SITE_PREFIX, OFFICER_FACTION_KEYS, PATHS, factionKeyOf, createOfficerSpawnSeam,
  checkOfficerSpawnSeamsFrom };
