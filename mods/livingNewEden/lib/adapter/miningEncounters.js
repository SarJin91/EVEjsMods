// Ported from EveJS 261028.1 (CREDITS.md): countActiveBeltRatGroups (space/npc/beltRatRuntime.js:574-611) - the dynamic entity scan only (the vendor's per-belt state is internal); one pass counts the belt and the system.

"use strict";

const { admitOrPass } = require("./sceneNpcBudget");

const MARK = Symbol.for("livingNewEden.miningEncountersLedger");
const MAX_DETAIL = 120;
const SPECIAL_NOT_ELIGIBLE = "SPECIAL_SPAWN_NOT_ELIGIBLE";
const FALL_THROUGH = Object.freeze([SPECIAL_NOT_ELIGIBLE, "SPECIAL_SPAWN_POOL_NOT_FOUND"]);
const WAVE_OPERATOR_KIND = "lneMiningWave";
const WAVE_SITE_PREFIX = "lne_mining_wave";
const WAVE_ANCHOR_KIND = "ship";
const WAVE_SPREAD_METERS = 8000;
const WAVE_FORMATION_SPACING_METERS = 1250;
const BUSY_RADIUS_FACTOR = 2;

const PATHS = Object.freeze({
  belt: "space/npc/beltRatRuntime",
  runtime: "space/runtime",
  config: "config/index",
  ledger: "services/mining/miningLedgerState",
  npc: "space/npc/npcService",
});
const BELT_FUNCTIONS = Object.freeze(["maybeSpawnForSessionArrival", "resolveSecurityProfile",
  "findNearestBeltForEntity"]);
const NPC_FUNCTIONS = Object.freeze(["issueManualOrder", "wakeNpcController", "getControllerByEntityID"]);
const WARP_OFF_ORDER = "warpOff";
const HAULER_KIND = "hauler";

function toPositiveInt(value) {
  const n = Math.trunc(Number(value));
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
}

function messageOf(err) {
  return String((err && err.message) || err).slice(0, MAX_DETAIL);
}

function positionOf(entity) {
  const p = entity && entity.position;
  if (!p) return null;
  const x = Number(p.x);
  const y = Number(p.y);
  const z = Number(p.z);
  return Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z) ? { x, y, z } : null;
}

function spawnedEntityIds(spawned) {
  return (Array.isArray(spawned) ? spawned : []).map((entry) => toPositiveInt(entry && entry.entity
    && entry.entity.itemID)).filter((id) => id > 0);
}

function withHaulerIds(result, kind, spawned) {
  return kind === HAULER_KIND ? { ...result, entityIds: spawnedEntityIds(spawned) } : result;
}

function wrapLedgerForEncounters(originalFn, deps) {
  if (typeof originalFn !== "function") return { ok: false, reason: "NOT_A_FUNCTION" };
  if (originalFn[MARK] === true) return { ok: true, wrapped: originalFn, noop: true };
  const getSink = deps && deps.getSink;
  if (typeof getSink !== "function") return { ok: false, reason: "SINK_NOT_A_FUNCTION" };
  const onError = deps && typeof deps.onError === "function" ? deps.onError : null;

  function notify(payload) {
    try {
      const sink = getSink();
      if (!sink || typeof sink.onLedgerEvent !== "function") return;
      const p = payload && typeof payload === "object" ? payload : {};
      sink.onLedgerEvent({ characterId: toPositiveInt(p.characterID), systemId: toPositiveInt(p.solarSystemID),
        yieldKind: String(p.yieldKind || "").trim().toLowerCase() });
    } catch (err) {
      if (!onError) return;
      try {
        onError(err);
      } catch (_err) {
      }
    }
  }

  const wrapped = function recordMiningLedgerEventWithEncounters(...args) {
    const result = originalFn.apply(this, args);
    if (result && result.success === true) notify(args[0]);
    return result;
  };
  Object.defineProperty(wrapped, MARK, { value: true });
  return { ok: true, wrapped };
}

function createMiningEncounterSeam(deps) {
  const requireGame = deps && deps.requireGame;
  const getSpawnTools = deps && deps.getSpawnTools;
  const admit = admitOrPass(deps && deps.admit);
  let waveSeq = 0;

  function load(key) {
    if (typeof requireGame !== "function") return null;
    const read = requireGame(PATHS[key]);
    return read && read.ok === true && read.exports ? read.exports : null;
  }

  function beltModule() {
    const belt = load("belt");
    return belt && BELT_FUNCTIONS.every((name) => typeof belt[name] === "function") ? belt : null;
  }

  function runtimeModule() {
    const runtime = load("runtime");
    return runtime && typeof runtime.isSolarSystemSceneLoaded === "function" && runtime.scenes instanceof Map
      ? runtime : null;
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

  // Port of countActiveBeltRatGroups (beltRatRuntime.js:574-611), entity scan, belt and system in one pass.
  function countGroups(scene, operatorKind, beltId) {
    const onBelt = new Set();
    const inSystem = new Set();
    const entities = scene.dynamicEntities instanceof Map ? scene.dynamicEntities.values() : [];
    for (const entity of entities) {
      if (!entity || entity.nativeNpc !== true) continue;
      if (String(entity.operatorKind || "").trim() !== operatorKind) continue;
      const anchorId = toPositiveInt(entity.anchorID);
      const groupKey = String(entity.spawnSiteID || entity.spawnGroupInstanceID || entity.itemID);
      inSystem.add(`${anchorId}:${groupKey}`);
      if (anchorId === beltId) onBelt.add(groupKey);
    }
    return { groupsOnBelt: onBelt.size, groupsInSystem: inSystem.size };
  }

  function countWaveGroups(scene, center, radiusMeters) {
    const near = new Set();
    const inSystem = new Set();
    const r2 = radiusMeters * radiusMeters;
    const entities = scene.dynamicEntities instanceof Map ? scene.dynamicEntities.values() : [];
    for (const entity of entities) {
      if (!entity || entity.nativeNpc !== true) continue;
      if (String(entity.operatorKind || "").trim() !== WAVE_OPERATOR_KIND) continue;
      const groupKey = String(entity.spawnSiteID || entity.itemID);
      inSystem.add(groupKey);
      const p = positionOf(entity);
      if (!p || !center) continue;
      const dx = p.x - center.x;
      const dy = p.y - center.y;
      const dz = p.z - center.z;
      if (dx * dx + dy * dy + dz * dz <= r2) near.add(groupKey);
    }
    return { near: near.size, inSystem: inSystem.size };
  }

  function anomalyDistance(anomaly) {
    const d = Number(anomaly && anomaly.distanceMeters);
    return Number.isFinite(d) && d > 0 ? d : 0;
  }

  function bandOf(systemId) {
    try {
      const belt = beltModule();
      if (!belt) return { ok: false, reason: "SEAM_UNAVAILABLE" };
      const profile = belt.resolveSecurityProfile(systemId);
      if (!profile || typeof profile.band !== "string") return { ok: false, reason: "READ_FAILED" };
      const security = Number(profile.securityStatus);
      return { ok: true, band: profile.band, eligible: profile.eligible === true,
        baseMin: toPositiveInt(profile.minCount), baseMax: toPositiveInt(profile.maxCount),
        security: Number.isFinite(security) ? security : null };
    } catch (err) {
      return { ok: false, reason: "READ_FAILED", detail: messageOf(err) };
    }
  }

  function locate(input) {
    try {
      const characterId = toPositiveInt(input && input.characterId);
      const systemId = toPositiveInt(input && input.systemId);
      if (!characterId || !systemId) return { ok: false, reason: "READ_FAILED", detail: "INVALID_INPUT" };
      const belt = beltModule();
      const runtime = runtimeModule();
      if (!belt || !runtime) return { ok: false, reason: "SEAM_UNAVAILABLE" };
      const sc = sceneOf(runtime, systemId);
      if (!sc.ok) return sc;
      const pilot = findPilot(sc.scene, characterId);
      if (!pilot.ok) return pilot;
      const beltEntity = belt.findNearestBeltForEntity(sc.scene, pilot.ship);
      const beltId = toPositiveInt(beltEntity && beltEntity.itemID);
      const distance = anomalyDistance(input.anomaly);
      if (!beltId && !distance) return { ok: false, reason: "NOT_AT_BELT" };
      const counts = countGroups(sc.scene, String(belt.OPERATOR_KIND || ""), beltId);
      const waves = countWaveGroups(sc.scene, positionOf(pilot.ship), distance * BUSY_RADIUS_FACTOR);
      const shipId = toPositiveInt(pilot.ship.itemID);
      const groupsInSystem = counts.groupsInSystem + waves.inSystem;
      if (!beltId) {
        return { ok: true, beltId: null, anchor: WAVE_ANCHOR_KIND, shipId, groupsOnBelt: waves.near, groupsInSystem };
      }
      return { ok: true, beltId, shipId, groupsOnBelt: counts.groupsOnBelt, groupsInSystem };
    } catch (err) {
      return { ok: false, reason: "READ_FAILED", detail: messageOf(err) };
    }
  }

  function spawnWave(input) {
    try {
      if (input && input.anchor === WAVE_ANCHOR_KIND) return spawnAtShip(input);
      const characterId = toPositiveInt(input && input.characterId);
      const systemId = toPositiveInt(input && input.systemId);
      const beltId = toPositiveInt(input && input.beltId);
      if (!characterId || !systemId || !beltId) return { ok: false, reason: "SPAWN_FAILED", detail: "INVALID_INPUT" };
      const belt = beltModule();
      const runtime = runtimeModule();
      if (!belt || !runtime) return { ok: false, reason: "SEAM_UNAVAILABLE" };
      const sc = sceneOf(runtime, systemId);
      if (!sc.ok) return sc;
      const pilot = findPilot(sc.scene, characterId);
      if (!pilot.ok) return { ok: false, reason: pilot.reason === "NO_SESSION" ? "NO_SHIP" : pilot.reason };
      if (!sc.scene.getEntityByID(beltId)) return { ok: false, reason: "BELT_GONE" };
      const chain = Array.isArray(input.specialChain) ? input.specialChain.filter((k) => typeof k === "string") : [];
      const base = { forceSpawn: true, targetEntityID: beltId, skipSpecialSpawns: true,
        minCount: input.minCount, maxCount: input.maxCount, preferredTargetID: toPositiveInt(pilot.ship.itemID),
        ...(Number.isFinite(input.nowMs) ? { nowMs: input.nowMs } : {}) };
      const kinds = [...chain, "normal"];
      const gate = admit(systemId, toPositiveInt(input.maxCount) || 1, "miningEncounters");
      if (gate.ok !== true) return gate;
      for (let i = 0; i < kinds.length; i += 1) {
        const kind = kinds[i];
        const options = kind === "normal" ? { ...base } : { ...base, forceSpecialSpawnKind: kind };
        const res = belt.maybeSpawnForSessionArrival(sc.scene, pilot.session, pilot.ship, options);
        if (kind !== "normal" && res && FALL_THROUGH.includes(res.reason)) continue;
        if (!res || res.success !== true || res.spawned !== true) {
          return { ok: false, reason: "SPAWN_FAILED", detail: String((res && res.reason) || "NO_RESULT").slice(0,
            MAX_DETAIL) };
        }
        const data = res.data || {};
        const ships = Array.isArray(data.spawned) ? data.spawned.length : toPositiveInt(data.requestedAmount);
        return withHaulerIds({ ok: true, kind, ships, degraded: i > 0 }, kind, data.spawned);
      }
      return { ok: false, reason: "SPAWN_FAILED", detail: "CHAIN_EXHAUSTED" };
    } catch (err) {
      return { ok: false, reason: "SPAWN_FAILED", detail: messageOf(err) };
    }
  }

  function spawnAtShip(input) {
    const characterId = toPositiveInt(input.characterId);
    const systemId = toPositiveInt(input.systemId);
    const distance = anomalyDistance({ distanceMeters: input.spawnDistanceMeters });
    if (!characterId || !systemId || !distance) return { ok: false, reason: "SPAWN_FAILED", detail: "INVALID_INPUT" };
    const belt = beltModule();
    const runtime = runtimeModule();
    const tools = typeof getSpawnTools === "function" ? getSpawnTools() : null;
    if (!belt || !runtime || typeof belt.buildBeltRatSpawnPlan !== "function" || !tools || tools.ok !== true
      || typeof tools.spawnNativeDefinitionsInContext !== "function") {
      return { ok: false, reason: "SEAM_UNAVAILABLE", detail: (tools && tools.reason) || "" };
    }
    const sc = sceneOf(runtime, systemId);
    if (!sc.ok) return sc;
    const pilot = findPilot(sc.scene, characterId);
    if (!pilot.ok) return { ok: false, reason: pilot.reason === "NO_SESSION" ? "NO_SHIP" : pilot.reason };
    const chain = Array.isArray(input.specialChain) ? input.specialChain.filter((k) => typeof k === "string") : [];
    const kinds = [...chain, "normal"];
    let plan = null;
    let index = 0;
    for (; index < kinds.length; index += 1) {
      const kind = kinds[index];
      const options = { skipSpecialSpawns: true, minCount: input.minCount, maxCount: input.maxCount,
        ...(kind === "normal" ? {} : { forceSpecialSpawnKind: kind }) };
      plan = belt.buildBeltRatSpawnPlan(systemId, options);
      if (kind !== "normal" && plan && FALL_THROUGH.includes(plan.errorMsg)) continue;
      break;
    }
    const data = plan && plan.success === true && plan.data ? plan.data : null;
    if (!data || !Array.isArray(data.definitions) || data.definitions.length === 0) {
      return { ok: false, reason: "SPAWN_FAILED", detail: String((plan && plan.errorMsg) || "NO_PLAN").slice(0,
        MAX_DETAIL) };
    }
    const gate = admit(systemId, data.definitions.length, "miningEncounters");
    if (gate.ok !== true) return gate;
    const ship = pilot.ship;
    const shipId = toPositiveInt(ship.itemID);
    waveSeq += 1;
    const spawnSiteID = `${WAVE_SITE_PREFIX}:${characterId}:${waveSeq}`;
    const selectionID = `${WAVE_SITE_PREFIX}:${String(data.selectionID || "")}`;
    const selectionName = String(data.selectionName || selectionID);
    const anchorName = String(ship.itemName || ship.slimName || WAVE_ANCHOR_KIND);
    const context = { systemID: systemId, scene: sc.scene, anchorEntity: ship, preferredTargetID: shipId,
      anchorKind: WAVE_ANCHOR_KIND, anchorLabel: anchorName };
    const selection = { success: true, data: { selectionKind: WAVE_OPERATOR_KIND, selectionID, selectionName,
      definitions: data.definitions } };
    const res = tools.spawnNativeDefinitionsInContext(context, selection, {
      entityType: "npc", transient: true, broadcast: false, deferGroupBehaviorTick: true, preferredTargetID: shipId,
      spawnDistanceMeters: distance, spreadMeters: WAVE_SPREAD_METERS,
      formationSpacingMeters: WAVE_FORMATION_SPACING_METERS, selectionKind: WAVE_OPERATOR_KIND, selectionID,
      selectionName, operatorKind: WAVE_OPERATOR_KIND, anchorKind: WAVE_ANCHOR_KIND, anchorID: shipId, anchorName,
      spawnSiteID,
    });
    const spawned = res && res.success === true && res.data && Array.isArray(res.data.spawned) ? res.data.spawned : [];
    if (spawned.length === 0) {
      return { ok: false, reason: "SPAWN_FAILED", detail: String((res && res.errorMsg) || "NO_RESULT").slice(0,
        MAX_DETAIL) };
    }
    const kind = kinds[Math.min(index, kinds.length - 1)];
    return withHaulerIds({ ok: true, kind, ships: spawned.length, degraded: index > 0 }, kind, spawned);
  }

  function npcModule() {
    const npc = load("npc");
    return npc && NPC_FUNCTIONS.every((name) => typeof npc[name] === "function") ? npc : null;
  }

  function warpOutOne(scene, npc, entityId, from, rangeMeters, force) {
    try {
      const entity = scene.getEntityByID(entityId);
      if (!entity) return { entityId, state: "gone" };
      const controller = npc.getControllerByEntityID(entityId);
      if (!controller) return { entityId, state: "gone" };
      const order = controller.manualOrder;
      if (order && order.type === WARP_OFF_ORDER) return { entityId, state: "leaving" };
      const p = positionOf(entity);
      const far = !from || !p || Math.hypot(p.x - from.x, p.y - from.y, p.z - from.z) >= rangeMeters;
      if (!force && !far) return { entityId, state: "staying" };
      const issued = npc.issueManualOrder(entityId, { type: WARP_OFF_ORDER, awayFromPosition: from });
      const woke = issued && issued.success === true ? npc.wakeNpcController(entityId, 0) : issued;
      if (woke && woke.success === true) return { entityId, state: "ordered" };
      const detail = String((woke && woke.errorMsg) || "ORDER_FAILED").slice(0, MAX_DETAIL);
      return { entityId, state: "failed", detail };
    } catch (err) {
      return { entityId, state: "failed", detail: messageOf(err) };
    }
  }

  function warpOutHaulers(input) {
    try {
      const systemId = toPositiveInt(input && input.systemId);
      const characterId = toPositiveInt(input && input.characterId);
      const ids = Array.isArray(input && input.entityIds) ? input.entityIds.map(toPositiveInt).filter((id) => id > 0)
        : [];
      const rangeMeters = Number(input && input.rangeMeters);
      if (!systemId || ids.length === 0 || !(rangeMeters > 0)) {
        return { ok: false, reason: "READ_FAILED", detail: "INVALID_INPUT" };
      }
      const runtime = runtimeModule();
      const npc = npcModule();
      if (!runtime || !npc) return { ok: false, reason: "SEAM_UNAVAILABLE" };
      if (runtime.isSolarSystemSceneLoaded(systemId) !== true) return { ok: false, reason: "SCENE_NOT_LOADED" };
      const scene = runtime.scenes.get(systemId);
      if (!scene || typeof scene.getEntityByID !== "function") return { ok: false, reason: "SCENE_NOT_LOADED" };
      const pilot = characterId && scene.sessions instanceof Map && typeof scene.getShipEntityForSession === "function"
        ? findPilot(scene, characterId) : { ok: false };
      const from = pilot.ok ? positionOf(pilot.ship) : null;
      return { ok: true, ships: ids.map((id) => warpOutOne(scene, npc, id, from, rangeMeters, input.force === true)) };
    } catch (err) {
      return { ok: false, reason: "READ_FAILED", detail: messageOf(err) };
    }
  }

  function readVendorBeltFlags() {
    try {
      const cfg = load("config");
      if (!cfg) return { ok: false, reason: "SEAM_UNAVAILABLE" };
      return { ok: true, ratsEnabled: cfg.asteroidBeltNpcRatsEnabled === true,
        specialsEnabled: cfg.asteroidBeltNpcRatSpecialsEnabled === true };
    } catch (err) {
      return { ok: false, reason: "READ_FAILED", detail: messageOf(err) };
    }
  }

  return Object.freeze({ bandOf, locate, spawnWave, readVendorBeltFlags, warpOutHaulers });
}

function checkMiningEncounterSeamsFrom(requireGame) {
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
  if (belt) {
    for (const name of BELT_FUNCTIONS) if (typeof belt[name] !== "function") missing.push(`${PATHS.belt}.${name}`);
    if (typeof belt.OPERATOR_KIND !== "string") missing.push(`${PATHS.belt}.OPERATOR_KIND`);
  }
  const runtime = read("runtime");
  if (runtime && (typeof runtime.isSolarSystemSceneLoaded !== "function" || !(runtime.scenes instanceof Map))) {
    missing.push(`${PATHS.runtime}.isSolarSystemSceneLoaded/scenes`);
  }
  read("config");
  const ledger = read("ledger");
  if (ledger && typeof ledger.recordMiningLedgerEvent !== "function") {
    missing.push(`${PATHS.ledger}.recordMiningLedgerEvent`);
  }
  return missing.length === 0 ? { ok: true } : { ok: false, reason: "SEAM_UNAVAILABLE", missing };
}

module.exports = { MARK, PATHS, WAVE_OPERATOR_KIND, WAVE_SITE_PREFIX, wrapLedgerForEncounters,
  createMiningEncounterSeam, checkMiningEncounterSeamsFrom };
