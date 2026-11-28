"use strict";

const data = require("./data/liveProfiles");
const { factionResolverOf } = require("./huntScene");
const { GATE_EVENT, jumpInOptionsOf, broadcastJumpIn, broadcastJumpOut, broadcastGateEvent } = require("./gateJumpFx");
const { presentBeams, motionOf } = require("./miningBeams");
const explorerSites = require("./explorerSites");
const { queueRotation } = require("./ballUpdates");

const MAX_DETAIL = 120;
const UNDOCK_SELECTION = "first";

const PATHS = Object.freeze({
  runtime: "space/runtime",
  native: "space/npc/nativeNpcService",
  npc: "space/npc/npcService",
  store: "space/npc/nativeNpcStore",
  npcRuntime: "space/npc/npcRuntime",
});
const FUNCTIONS = Object.freeze({
  runtime: Object.freeze(["isSolarSystemSceneLoaded"]),
  native: Object.freeze(["spawnNativeNpcEntityInSystem"]),
  npc: Object.freeze(["destroyNpcControllerByEntityID"]),
  store: Object.freeze(["listNativeControllersForSystem", "getNativeEntity", "upsertNativeEntity"]),
  npcRuntime: Object.freeze(["warpToPoint"]),
});

const UNDOCK_PATHS = Object.freeze({ runtime: "space/runtime", worldData: "space/worldData" });
const UNDOCK_FUNCTIONS = Object.freeze({
  runtime: Object.freeze(["getStationUndockSpawnState"]),
  worldData: Object.freeze(["getStationByID"]),
});

const SEAM_METHODS = Object.freeze(["readNodes", "readPlayers", "spawnCivilian", "warpTo", "readShips", "despawn",
  "listTrafficIds", "dockPointOf"]);

const AGGRO_PATHS = Object.freeze({ npc: "space/npc/npcService" });
const AGGRO_FUNCTIONS = Object.freeze({
  npc: Object.freeze(["getControllerByEntityID", "setBehaviorOverrides"]),
});
const AGGRO_METHODS = Object.freeze(["readThreats", "armPilotTarget", "disarmPilotTarget"]);
const RAT_AGGRO_METHODS = Object.freeze(["armPilotRatTarget", "releaseEngagedRats"]);
const MOTION_PATHS = Object.freeze({ npc: "space/npc/npcService" });
const FX_METHODS = Object.freeze(["presentGateJumpOut", "presentMiningBeams", "presentGateDeparture"]);
const PATROL_METHODS = Object.freeze(["presentPatrolOrbit", "releasePatrolMotion"]);
const EXPLORER_METHODS = Object.freeze(["readExplorerSites"]);
const PATROL_MARKER = "lnePatrol";
const ORBIT_OPTIONS = Object.freeze({ queueHistorySafeContract: true, suppressFreshAcquireReplay: true });
const ALLOW_FRIENDLY_KEY = "allowFriendlyNpcTargets";

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

function arrivalPoseFrom(raw) {
  if (!raw || typeof raw !== "object" || typeof raw.rotate !== "boolean") return null;
  const position = pointOf(raw.position);
  const direction = pointOf(raw.direction);
  if (position === null || direction === null || !(Math.hypot(direction.x, direction.y, direction.z) > 0)) return null;
  return { position, direction, rotate: raw.rotate };
}

function isIdList(list) {
  return Array.isArray(list) && list.every(isPositiveInt);
}

function isTrafficVictim(entity) {
  if (!entity || typeof entity !== "object") return false;
  return String(entity.operatorKind || "").trim() === data.TRAFFIC_OPERATOR_KIND;
}

function checkHighsecTrafficSceneFrom(requireGame) {
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

function createHighsecTrafficScene(deps) {
  const requireGame = deps && deps.requireGame;
  const getNpcSpawn = deps && deps.getNpcSpawn;
  const getHuntScene = deps && deps.getHuntScene;

  const moduleOf = (key) => {
    if (typeof requireGame !== "function") return null;
    const read = requireGame(PATHS[key]);
    const mod = read && read.ok === true && read.exports ? read.exports : null;
    return mod && FUNCTIONS[key].every((name) => typeof mod[name] === "function") ? mod : null;
  };

  const runtimeModule = () => {
    const runtime = moduleOf("runtime");
    return runtime && runtime.scenes instanceof Map ? runtime : null;
  };

  const sceneOf = (systemId) => {
    const runtime = runtimeModule();
    if (!runtime) return { ok: false, reason: "SEAM_UNAVAILABLE" };
    if (runtime.isSolarSystemSceneLoaded(systemId) !== true) return { ok: false, reason: "SCENE_NOT_LOADED" };
    const scene = runtime.scenes.get(systemId);
    if (!scene || typeof scene.getEntityByID !== "function") return { ok: false, reason: "SCENE_NOT_LOADED" };
    return { ok: true, scene };
  };

  const facade = (getter, names) => {
    const f = typeof getter === "function" ? getter() : null;
    return f && names.every((name) => typeof f[name] === "function") ? f : null;
  };

  let undockSeq = 0;

  const undockModuleOf = (key) => {
    if (typeof requireGame !== "function") return null;
    const read = requireGame(UNDOCK_PATHS[key]);
    const mod = read && read.ok === true && read.exports ? read.exports : null;
    return mod && UNDOCK_FUNCTIONS[key].every((name) => typeof mod[name] === "function") ? mod : null;
  };

  const undockStateOf = (systemId, stationId, selectionKey, shipTypeId) => {
    try {
      const runtime = undockModuleOf("runtime");
      const worldData = undockModuleOf("worldData");
      if (!runtime || !worldData) return { ok: false, reason: "SEAM_UNAVAILABLE" };
      const station = worldData.getStationByID(stationId);
      if (!station || typeof station !== "object" || toPositiveInt(station.solarSystemID) !== systemId) {
        return { ok: false, reason: "NO_STATION" };
      }
      const state = runtime.getStationUndockSpawnState(station, {
        ...(shipTypeId !== undefined ? { shipTypeID: shipTypeId } : {}), selectionStrategy: UNDOCK_SELECTION,
        ...(selectionKey !== undefined ? { selectionKey } : {}) });
      const point = pointOf(state && state.position);
      const direction = pointOf(state && state.direction);
      if (point === null || direction === null) return { ok: false, reason: "READ_FAILED", detail: "NO_UNDOCK_STATE" };
      return { ok: true, point, direction };
    } catch (err) {
      return { ok: false, reason: "READ_FAILED", detail: messageOf(err) };
    }
  };

  const dockPointOf = (systemId, stationId) => {
    if (!isPositiveInt(systemId) || !isPositiveInt(stationId)) return { ok: false, reason: "INVALID_INPUT" };
    return undockStateOf(systemId, stationId, undefined, undefined);
  };

  const readNodes = (systemId) => {
    if (!isPositiveInt(systemId)) return { ok: false, reason: "INVALID_INPUT" };
    try {
      const sc = sceneOf(systemId);
      if (!sc.ok) return sc;
      const lists = { stargate: [], station: [], asteroidBelt: [] };
      const statics = Array.isArray(sc.scene.staticEntities) ? sc.scene.staticEntities : [];
      for (const entity of statics) {
        const kind = entity ? String(entity.kind || "").trim() : "";
        if (!Object.prototype.hasOwnProperty.call(lists, kind)) continue;
        const itemId = toPositiveInt(entity.itemID);
        const position = pointOf(entity.position);
        if (!itemId || position === null) continue;
        const radius = Number(entity.radius);
        const toSystemId = kind === "stargate" ? toPositiveInt(entity.destinationSolarSystemID) : 0;
        lists[kind].push({ itemId, position, radius: Number.isFinite(radius) && radius >= 0 ? radius : 0,
          ...(toSystemId > 0 ? { toSystemId } : {}) });
      }
      for (const list of Object.values(lists)) list.sort((a, b) => a.itemId - b.itemId);
      return { ok: true, gates: lists.stargate, stations: lists.station, belts: lists.asteroidBelt };
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

  const spawnCivilian = (systemId, spec) => {
    const profileId = spec && typeof spec.profileId === "string" ? spec.profileId.trim() : "";
    const given = (value) => value !== undefined && value !== null;
    const gateId = spec ? spec.gateId : undefined;
    const stationId = spec ? spec.stationId : undefined;
    const undockRaw = spec ? spec.undock : undefined;
    const undock = undockRaw === true;
    const run = spec ? spec.undockRunMeters : undefined;
    const slimName = spec && given(spec.slimName) ? spec.slimName : null;
    const offset = spec ? spec.spawnOffsetMeters : NaN;
    const shipTypeId = spec && given(spec.shipTypeId) ? spec.shipTypeId : undefined;
    const jumpInMs = spec && given(spec.jumpInMs) ? spec.jumpInMs : undefined;
    const gateEventsRaw = spec ? spec.gateEvents : undefined;
    const poseRaw = spec ? spec.arrivalPose : undefined;
    const pose = given(poseRaw) ? arrivalPoseFrom(poseRaw) : null;
    if (!isPositiveInt(systemId) || profileId === ""
      || (given(poseRaw) && (pose === null || !given(gateId) || undock))
      || (jumpInMs !== undefined && (!isPositiveInt(jumpInMs) || !given(gateId)))
      || (given(gateEventsRaw) && (typeof gateEventsRaw !== "boolean" || jumpInMs === undefined))
      || (shipTypeId !== undefined && (!undock || !isPositiveInt(shipTypeId)))
      || given(gateId) === given(stationId)
      || (given(gateId) && !isPositiveInt(gateId)) || (given(stationId) && !isPositiveInt(stationId))
      || (given(undockRaw) && typeof undockRaw !== "boolean") || (undock && !given(stationId))
      || (undock && (typeof run !== "number" || !Number.isFinite(run) || run < 0))
      || (slimName !== null && typeof slimName !== "string")
      || typeof offset !== "number" || !Number.isFinite(offset) || offset < 0) {
      return { ok: false, reason: "INVALID_INPUT" };
    }
    let spawn = null;
    let entityId = 0;
    try {
      spawn = facade(getNpcSpawn, ["pickGridAnchor", "spawnShip", "publish", "despawn"]);
      if (!spawn) return { ok: false, reason: "SEAM_UNAVAILABLE" };
      const sc = sceneOf(systemId);
      if (!sc.ok) return sc;
      let spawnState = null;
      if (undock) {
        undockSeq += 1;
        const u = undockStateOf(systemId, stationId, undockSeq, shipTypeId);
        if (!u.ok) {
          return { ok: false, reason: "NO_UNDOCK_POINT", detail: `${u.reason}${u.detail ? ` ${u.detail}` : ""}`
            .slice(0, MAX_DETAIL) };
        }
        spawnState = { position: u.point, direction: u.direction,
          targetPoint: { x: u.point.x + u.direction.x * run, y: u.point.y + u.direction.y * run,
            z: u.point.z + u.direction.z * run },
          mode: "GOTO", speedFraction: 1 };
      }
      if (pose !== null) {
        spawnState = { position: pose.position, direction: pose.direction, targetPoint: pose.position, mode: "STOP",
          speedFraction: 0 };
      }
      const grid = given(gateId) ? { kind: "gate", id: gateId } : { kind: "station", id: stationId };
      const anchor = spawn.pickGridAnchor(systemId, grid);
      if (!anchor || anchor.ok !== true || !anchor.anchorDescriptor) {
        const reason = anchor && ["SCENE_NOT_LOADED", "SEAM_UNAVAILABLE"].includes(anchor.reason) ? anchor.reason
          : "GRID_ANCHOR_UNKNOWN";
        return { ok: false, reason };
      }
      const radius = Number.isFinite(anchor.radiusMeters) && anchor.radiusMeters >= 0 ? anchor.radiusMeters : 0;
      const shot = spawn.spawnShip(systemId, { profileId, anchorDescriptor: anchor.anchorDescriptor,
        spawnDistanceMeters: radius + offset, purpose: "traffic",
        ...(spawnState !== null ? { spawnState } : {}), ...(slimName !== null ? { slimName } : {}) });
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
      let posed = {};
      if (pose !== null) {
        const rot = pose.rotate ? queueRotation(requireGame, sc.scene, entityId, pose.direction) : null;
        posed = { posed: true, rotated: rot !== null && rot.ok === true && rot.sent === true };
      }
      if (jumpInMs === undefined) return { ok: true, entityId, ...posed };
      const fx = broadcastJumpIn(sc.scene, entityId, jumpInOptionsOf(requireGame, jumpInMs));
      const jumpIn = fx.ok === true && fx.sent === true;
      if (gateEventsRaw !== true) return { ok: true, entityId, jumpIn, ...posed };
      const ev = broadcastGateEvent(sc.scene, gateId, entityId, GATE_EVENT.ARRIVAL);
      return { ok: true, entityId, jumpIn, arrival: ev.ok === true && ev.sent === true, ...posed };
    } catch (err) {
      return spawn ? refuseSpawned(spawn, systemId, entityId, messageOf(err))
        : { ok: false, reason: "SPAWN_FAILED", detail: messageOf(err) };
    }
  };

  const warpTo = (systemId, entityId, point, opts) => {
    const target = pointOf(point);
    const align = opts ? opts.align : undefined;
    const clearAlignOrder = opts ? opts.clearAlignOrder : undefined;
    const warpFx = opts ? opts.warpFx : undefined;
    const flagOk = (value) => value === undefined || typeof value === "boolean";
    if (!isPositiveInt(systemId) || !isPositiveInt(entityId) || target === null
      || (opts !== undefined && (!opts || typeof opts !== "object")) || !flagOk(align) || !flagOk(clearAlignOrder)
      || !flagOk(warpFx) || (align === true && clearAlignOrder === true)) {
      return { ok: false, reason: "INVALID_INPUT" };
    }
    try {
      const hunt = facade(getHuntScene, ["warpShips"]);
      if (!hunt) return { ok: false, reason: "SEAM_UNAVAILABLE" };
      const r = hunt.warpShips(systemId, [entityId], target, { spreadMeters: 0,
        ...(align === true ? { align: true } : {}), ...(clearAlignOrder === true ? { clearAlignOrder: true } : {}),
        ...(warpFx === true ? { warpFx: true } : {}) });
      if (!r || r.ok !== true) {
        return { ok: false, reason: String((r && r.reason) || "WARP_FAILED"),
          ...(r && r.detail ? { detail: String(r.detail).slice(0, MAX_DETAIL) } : {}) };
      }
      const warped = Number(r.warped) >= 1;
      const out = align === true ? { ok: true, warped, aligned: Number(r.aligned) >= 1 } : { ok: true, warped };
      if (warpFx === true) out.warpFx = Number(r.warpFx) >= 1;
      if (r.detail) out.detail = String(r.detail).slice(0, MAX_DETAIL);
      return out;
    } catch (err) {
      return { ok: false, reason: "WARP_FAILED", detail: messageOf(err) };
    }
  };

  const playerAggressedAtOf = (npc, scene, entityId) => {
    if (!npc) return 0;
    try {
      const controller = npc.getControllerByEntityID(entityId);
      const aggressorId = controller && typeof controller === "object" ? toPositiveInt(controller.lastAggressorID) : 0;
      if (!aggressorId) return 0;
      const aggressor = scene.getEntityByID(aggressorId);
      if (!aggressor || typeof aggressor !== "object") return 0;
      if (!aggressor.session) {
        const controllerId = toPositiveInt(aggressor.controllerID);
        const owner = controllerId ? scene.getEntityByID(controllerId) : null;
        if (!owner || typeof owner !== "object" || !owner.session) return 0;
      }
      const at = Number(controller.lastAggressedAtMs);
      return Number.isFinite(at) && at > 0 ? at : 0;
    } catch (_err) {
      return 0;
    }
  };

  const readShips = (systemId, entityIds, opts) => {
    const aggressionRaw = opts && typeof opts === "object" ? opts.aggression : undefined;
    if (!isPositiveInt(systemId) || !isIdList(entityIds)
      || (opts !== undefined && (!opts || typeof opts !== "object"))
      || (aggressionRaw !== undefined && typeof aggressionRaw !== "boolean")) {
      return { ok: false, reason: "INVALID_INPUT" };
    }
    const aggression = aggressionRaw === true;
    try {
      const hunt = facade(getHuntScene, ["readShips"]);
      if (!hunt) return { ok: false, reason: "SEAM_UNAVAILABLE" };
      const sc = sceneOf(systemId);
      if (!sc.ok && sc.reason === "SCENE_NOT_LOADED") return { ok: true, sceneLoaded: false };
      if (!sc.ok) return sc;
      const r = hunt.readShips(systemId, entityIds);
      if (!r || r.ok !== true || !Array.isArray(r.ships)) {
        return { ok: false, reason: (r && r.reason === "SEAM_UNAVAILABLE") ? "SEAM_UNAVAILABLE" : "READ_FAILED" };
      }
      let npc = null;
      if (aggression) {
        try {
          npc = aggroNpcOf();
        } catch (_err) {
          npc = null;
        }
      }
      const live = [];
      const seen = new Set();
      for (const ship of r.ships) {
        const entityId = toPositiveInt(ship && ship.entityId);
        const position = pointOf(ship && ship.position);
        if (!entityId || position === null || seen.has(entityId)) continue;
        seen.add(entityId);
        live.push(aggression ? { entityId, position, inWarp: ship.inWarp === true,
          playerAggressedAt: playerAggressedAtOf(npc, sc.scene, entityId) }
          : { entityId, position, inWarp: ship.inWarp === true });
      }
      return { ok: true, sceneLoaded: true, live, gone: entityIds.filter((id) => !seen.has(id)) };
    } catch (err) {
      return { ok: false, reason: "READ_FAILED", detail: messageOf(err) };
    }
  };

  const despawn = (systemId, entityIds) => {
    if (!isPositiveInt(systemId) || !isIdList(entityIds)) return { ok: false, reason: "INVALID_INPUT" };
    try {
      const spawn = facade(getNpcSpawn, ["despawn"]);
      if (!spawn) return { ok: false, reason: "SEAM_UNAVAILABLE" };
      if (entityIds.length === 0) return { ok: true, removed: 0, missing: 0 };
      const r = spawn.despawn(systemId, entityIds);
      return r && typeof r === "object" ? r : { ok: false, reason: "DESPAWN_FAILED" };
    } catch (err) {
      return { ok: false, reason: "DESPAWN_FAILED", detail: messageOf(err) };
    }
  };

  const listTrafficIds = (systemId) => {
    if (!isPositiveInt(systemId)) return { ok: false, reason: "INVALID_INPUT" };
    try {
      const store = moduleOf("store");
      if (!store) return { ok: false, reason: "SEAM_UNAVAILABLE" };
      const sc = sceneOf(systemId);
      if (!sc.ok) return sc;
      const ids = new Set();
      const dynamics = sc.scene.dynamicEntities instanceof Map ? sc.scene.dynamicEntities.values() : [];
      for (const entity of dynamics) {
        if (!isTrafficVictim(entity)) continue;
        const itemId = toPositiveInt(entity.itemID);
        if (itemId) ids.add(itemId);
      }
      const controllers = store.listNativeControllersForSystem(systemId);
      for (const controller of Array.isArray(controllers) ? controllers : []) {
        if (!isTrafficVictim(controller)) continue;
        const entityId = toPositiveInt(controller.entityID);
        if (entityId) ids.add(entityId);
      }
      return { ok: true, ids: [...ids].sort((a, b) => a - b) };
    } catch (err) {
      return { ok: false, reason: "READ_FAILED", detail: messageOf(err) };
    }
  };

  const aggroNpcOf = () => {
    if (typeof requireGame !== "function") return null;
    const read = requireGame(AGGRO_PATHS.npc);
    const mod = read && read.ok === true && read.exports ? read.exports : null;
    return mod && AGGRO_FUNCTIONS.npc.every((name) => typeof mod[name] === "function") ? mod : null;
  };

  const kindOf = (record) => (record && typeof record === "object" ? String(record.operatorKind || "").trim() : "");
  const overridesOf = (controller) => (controller.behaviorOverrides && typeof controller.behaviorOverrides === "object"
    ? controller.behaviorOverrides : {});
  const distanceOf = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
  const hasAttackOrder = (controller) => {
    const order = controller.manualOrder;
    return Boolean(order && typeof order === "object" && order.type === "attack" && toPositiveInt(order.targetID) > 0);
  };
  const isIdleRat = (entity, controller, kind) => data.VENDOR_RAT_AGGRO_KINDS.includes(kind) && kindOf(entity) === kind
    && String(controller.runtimeKind || "").trim() === "nativeCombat"
    && (controller.manualOrder === null || controller.manualOrder === undefined)
    && toPositiveInt(controller.currentTargetID) === 0;
  const leashOf = (controller) => {
    const overrides = overridesOf(controller);
    const profile = controller.behaviorProfile && typeof controller.behaviorProfile === "object"
      ? controller.behaviorProfile : {};
    const meters = Number(overrides.leashRangeMeters !== undefined ? overrides.leashRangeMeters
      : profile.leashRangeMeters);
    const valid = Number.isFinite(meters) && meters > 0;
    return { meters: valid ? meters : 0, home: valid ? pointOf(controller.homePosition) : null };
  };
  const isRatCandidate = (entity, controller, kind) => Boolean(entity && typeof entity === "object"
    && entity.nativeNpc === true && entity.capitalNpc !== true
    && String(entity.mode || "").trim().toUpperCase() !== "WARP"
    && controller && typeof controller === "object" && kindOf(controller) === kind
    && isIdleRat(entity, controller, kind));
  const copyOf = (value) => {
    if (value === null || typeof value !== "object") return value;
    try {
      return structuredClone(value);
    } catch (_err) {
      return Array.isArray(value) ? [...value] : { ...value };
    }
  };
  const snapshotOf = (entityId, controller) => ({ entityId, overrides: copyOf(overridesOf(controller)),
    order: controller.manualOrder && typeof controller.manualOrder === "object" ? copyOf(controller.manualOrder) : null });
  const isBorrowedList = (list) => Array.isArray(list) && list.every((b) => b && typeof b === "object"
    && isPositiveInt(b.entityId) && b.overrides && typeof b.overrides === "object");
  const ratOverridesOf = (controller, b) => {
    const next = { ...overridesOf(controller) };
    if (Object.prototype.hasOwnProperty.call(b.overrides, ALLOW_FRIENDLY_KEY)) {
      next[ALLOW_FRIENDLY_KEY] = b.overrides[ALLOW_FRIENDLY_KEY];
    } else {
      delete next[ALLOW_FRIENDLY_KEY];
    }
    return next;
  };

  const releaseAttackers = (npc, pilotShipId, borrowed, pilotGone, force) => {
    const out = { released: 0, kept: 0, releaseFailed: 0 };
    for (const b of borrowed) {
      try {
        const controller = npc.getControllerByEntityID(b.entityId);
        if (!controller || typeof controller !== "object") {
          out.kept += 1;
          continue;
        }
        const order = controller.manualOrder;
        const onPilot = hasAttackOrder(controller) && toPositiveInt(order.targetID) === pilotShipId;
        const orphan = pilotGone && (order === null || order === undefined);
        if (!force && !onPilot && !orphan) {
          out.kept += 1;
          continue;
        }
        const issue = typeof npc.issueManualOrder === "function" ? npc.issueManualOrder : null;
        let ok = true;
        if (onPilot) ok = Boolean(issue) && ok && (issue(b.entityId, { type: "stop" }) || {}).success === true;
        const set = npc.setBehaviorOverrides(b.entityId, b.rat === true ? ratOverridesOf(controller, b)
          : copyOf(b.overrides));
        ok = ok && Boolean(set && set.success === true);
        if (onPilot || orphan) {
          ok = ok && Boolean(issue)
            && (issue(b.entityId, b.order ? copyOf(b.order) : { type: "resume" }) || {}).success === true;
        }
        if (b.rat === true && toPositiveInt(controller.preferredTargetID) === pilotShipId) {
          const want = toPositiveInt(b.preferredTargetID);
          try {
            controller.preferredTargetID = want;
          } catch (_err) {
          }
          ok = ok && toPositiveInt(controller.preferredTargetID) === want;
        }
        if (ok) out.released += 1;
        else out.releaseFailed += 1;
      } catch (_err) {
        out.releaseFailed += 1;
      }
    }
    return out;
  };

  const readThreats = (systemId, pilotShipIds, opts) => {
    const range = opts ? opts.rangeMeters : NaN;
    const maxCandidates = opts ? opts.maxCandidates : NaN;
    const excludeOf = opts && opts.excludeOf !== undefined && opts.excludeOf !== null ? opts.excludeOf : null;
    const vendorRatsRaw = opts ? opts.vendorRats : undefined;
    const vendorRats = vendorRatsRaw === true;
    if (!isPositiveInt(systemId) || !isIdList(pilotShipIds) || pilotShipIds.length === 0
      || typeof range !== "number" || !Number.isFinite(range) || range <= 0 || !isPositiveInt(maxCandidates)
      || (excludeOf !== null && typeof excludeOf !== "function")
      || (vendorRatsRaw !== undefined && typeof vendorRatsRaw !== "boolean")) {
      return { ok: false, reason: "INVALID_INPUT" };
    }
    const isExcluded = (entityId) => {
      try {
        return excludeOf(entityId) === true;
      } catch (_err) {
        return true;
      }
    };
    let excluded = 0;
    try {
      const npc = aggroNpcOf();
      if (!npc) return { ok: false, reason: "SEAM_UNAVAILABLE" };
      const sc = sceneOf(systemId);
      if (!sc.ok) return sc;
      const pilots = [];
      const pilotIds = new Set();
      for (const id of pilotShipIds) {
        if (pilotIds.has(id)) continue;
        const entity = sc.scene.getEntityByID(id);
        const position = entity ? pointOf(entity.position) : null;
        if (!isTrafficVictim(entity) || position === null) continue;
        pilotIds.add(id);
        const controller = npc.getControllerByEntityID(id);
        const kind = kindOf(controller);
        pilots.push({ id, position, armedKind: controller && kind !== data.TRAFFIC_OPERATOR_KIND ? kind : null });
      }
      if (pilots.length === 0) return { ok: true, threats: [], ...(excludeOf !== null ? { excluded: 0 } : {}) };
      const found = [];
      const dynamics = sc.scene.dynamicEntities instanceof Map ? sc.scene.dynamicEntities.values() : [];
      for (const entity of dynamics) {
        if (!entity || entity.nativeNpc !== true || entity.capitalNpc === true) continue;
        if (String(entity.mode || "").trim().toUpperCase() === "WARP") continue;
        if (isTrafficVictim(entity)) continue;
        const entityId = toPositiveInt(entity.itemID);
        const position = pointOf(entity.position);
        if (!entityId || position === null || pilotIds.has(entityId)) continue;
        if (!pilots.some((p) => distanceOf(p.position, position) <= range)) continue;
        const controller = npc.getControllerByEntityID(entityId);
        if (!controller || typeof controller !== "object") continue;
        const kind = kindOf(controller);
        const rat = vendorRats && isIdleRat(entity, controller, kind);
        if (!rat && (!data.PILOT_AGGRO_KINDS.includes(kind) || hasAttackOrder(controller))) continue;
        if (excludeOf !== null && isExcluded(entityId)) {
          excluded += 1;
          continue;
        }
        found.push(rat ? { entityId, kind, position, entity, leash: leashOf(controller) }
          : { entityId, kind, position, entity });
      }
      found.sort((a, b) => a.entityId - b.entityId);
      const factionOf = found.length > 0 ? factionResolverOf(requireGame) : null;
      const candidates = [];
      for (const c of found.slice(0, maxCandidates)) {
        const factionId = factionOf(c.entity);
        if (factionId === null) continue;
        candidates.push(c.leash ? { entityId: c.entityId, kind: c.kind, factionId, position: c.position, leash: c.leash }
          : { entityId: c.entityId, kind: c.kind, factionId, position: c.position });
      }
      const threats = pilots.map((p) => {
        const attackers = [];
        for (const c of candidates) {
          const d = distanceOf(p.position, c.position);
          if (d > range) continue;
          if (c.leash) {
            if (c.leash.home !== null && distanceOf(p.position, c.leash.home) > c.leash.meters) continue;
            attackers.push({ entityId: c.entityId, kind: c.kind, factionId: c.factionId, distanceMeters: Math.round(d),
              vendor: true });
          } else {
            attackers.push({ entityId: c.entityId, kind: c.kind, factionId: c.factionId, distanceMeters: Math.round(d) });
          }
        }
        attackers.sort((a, b) => a.distanceMeters - b.distanceMeters || a.entityId - b.entityId);
        return { pilotShipId: p.id, armedKind: p.armedKind, attackers };
      });
      return { ok: true, threats, ...(excludeOf !== null ? { excluded } : {}) };
    } catch (err) {
      return { ok: false, reason: "READ_FAILED", detail: messageOf(err) };
    }
  };

  const armPilotController = (npc, controller, pilotShipId, current, kind) => {
    if (current !== kind && Object.isFrozen(controller)) return { ok: false, reason: "OPERATOR_WRITE_FAILED" };
    const before = overridesOf(controller);
    const set = npc.setBehaviorOverrides(pilotShipId, { ...before, [ALLOW_FRIENDLY_KEY]: true });
    if (!set || set.success !== true) {
      return { ok: false, reason: "OPERATOR_WRITE_FAILED",
        detail: String((set && set.errorMsg) || "OVERRIDES_FAILED").slice(0, MAX_DETAIL) };
    }
    if (current !== kind) {
      try {
        controller.operatorKind = kind;
      } catch (_err) {
      }
      if (controller.operatorKind !== kind) {
        npc.setBehaviorOverrides(pilotShipId, { ...before });
        return { ok: false, reason: "OPERATOR_WRITE_FAILED" };
      }
    }
    return null;
  };

  const armPilotTarget = (systemId, pilotShipId, attackerIds, kind) => {
    if (!isPositiveInt(systemId) || !isPositiveInt(pilotShipId) || !isIdList(attackerIds) || attackerIds.length === 0
      || attackerIds.includes(pilotShipId) || new Set(attackerIds).size !== attackerIds.length
      || typeof kind !== "string" || !data.PILOT_AGGRO_KINDS.includes(kind)) {
      return { ok: false, reason: "INVALID_INPUT" };
    }
    try {
      const npc = aggroNpcOf();
      const hunt = facade(getHuntScene, ["attackTargets"]);
      if (!npc || !hunt) return { ok: false, reason: "SEAM_UNAVAILABLE" };
      const sc = sceneOf(systemId);
      if (!sc.ok) return sc;
      if (!isTrafficVictim(sc.scene.getEntityByID(pilotShipId))) return { ok: false, reason: "NOT_PILOT" };
      const controller = npc.getControllerByEntityID(pilotShipId);
      if (!controller || typeof controller !== "object") {
        return { ok: false, reason: "NOT_PILOT", detail: "NPC_NOT_FOUND" };
      }
      const current = kindOf(controller);
      if (current !== data.TRAFFIC_OPERATOR_KIND && current !== kind) return { ok: false, reason: "PILOT_BUSY" };
      for (const id of attackerIds) {
        if (kindOf(npc.getControllerByEntityID(id)) !== kind) {
          return { ok: false, reason: "FOREIGN_ATTACKER", detail: String(id) };
        }
      }
      const pilotRefused = armPilotController(npc, controller, pilotShipId, current, kind);
      if (pilotRefused !== null) return pilotRefused;
      const snapshots = attackerIds.map((id) => snapshotOf(id, npc.getControllerByEntityID(id)));
      const r = hunt.attackTargets(systemId, [...attackerIds], [pilotShipId]);
      const failed = r && r.ok === true && Array.isArray(r.failed) ? r.failed.filter(isPositiveInt) : null;
      if (failed === null || failed.length >= attackerIds.length) {
        releaseAttackers(npc, pilotShipId, snapshots, false, true);
        const d = disarmPilotTarget(systemId, pilotShipId);
        const why = [r && (r.detail || r.reason), d && d.ok !== true ? `disarm ${d.reason}` : null]
          .filter(Boolean).join("; ");
        return { ok: false, reason: "ATTACK_FAILED", ...(why ? { detail: why.slice(0, MAX_DETAIL) } : {}) };
      }
      if (failed.length > 0) {
        releaseAttackers(npc, pilotShipId, snapshots.filter((s) => failed.includes(s.entityId)), false, true);
      }
      return { ok: true, kind, ordered: attackerIds.length - failed.length, failed,
        borrowed: snapshots.filter((s) => !failed.includes(s.entityId)) };
    } catch (err) {
      return { ok: false, reason: "OPERATOR_WRITE_FAILED", detail: messageOf(err) };
    }
  };

  function disarmPilotTarget(systemId, pilotShipId, borrowed) {
    const withBorrowed = borrowed !== undefined && borrowed !== null;
    if (!isPositiveInt(systemId) || !isPositiveInt(pilotShipId) || (withBorrowed && !isBorrowedList(borrowed))) {
      return { ok: false, reason: "INVALID_INPUT" };
    }
    try {
      const npc = aggroNpcOf();
      if (!npc) return { ok: false, reason: "SEAM_UNAVAILABLE" };
      const sc = sceneOf(systemId);
      if (!sc.ok) return sc;
      const entity = sc.scene.getEntityByID(pilotShipId);
      const rel = withBorrowed ? releaseAttackers(npc, pilotShipId, borrowed, !entity, false) : null;
      const done = (restored) => (rel ? { ok: true, restored, ...rel } : { ok: true, restored });
      if (!entity) return done(false);
      if (!isTrafficVictim(entity)) return { ok: false, reason: "NOT_PILOT" };
      const controller = npc.getControllerByEntityID(pilotShipId);
      if (!controller || typeof controller !== "object") return done(false);
      if (kindOf(controller) !== data.TRAFFIC_OPERATOR_KIND) {
        try {
          controller.operatorKind = data.TRAFFIC_OPERATOR_KIND;
        } catch (_err) {
        }
        if (controller.operatorKind !== data.TRAFFIC_OPERATOR_KIND) return { ok: false, reason: "RESTORE_FAILED" };
      }
      const current = overridesOf(controller);
      if (Object.prototype.hasOwnProperty.call(current, ALLOW_FRIENDLY_KEY)) {
        const rest = { ...current };
        delete rest[ALLOW_FRIENDLY_KEY];
        const set = npc.setBehaviorOverrides(pilotShipId, rest);
        if (!set || set.success !== true) {
          return { ok: false, reason: "RESTORE_FAILED",
            detail: String((set && set.errorMsg) || "OVERRIDES_FAILED").slice(0, MAX_DETAIL) };
        }
      }
      return done(true);
    } catch (err) {
      return { ok: false, reason: "RESTORE_FAILED", detail: messageOf(err) };
    }
  }

  const armPilotRatTarget = (systemId, pilotShipId, ratIds, kind) => {
    if (!isPositiveInt(systemId) || !isPositiveInt(pilotShipId) || !isIdList(ratIds) || ratIds.length === 0
      || ratIds.includes(pilotShipId) || new Set(ratIds).size !== ratIds.length
      || typeof kind !== "string" || !data.VENDOR_RAT_AGGRO_KINDS.includes(kind)) {
      return { ok: false, reason: "INVALID_INPUT" };
    }
    try {
      const npc = aggroNpcOf();
      if (!npc || typeof npc.issueManualOrder !== "function") return { ok: false, reason: "SEAM_UNAVAILABLE" };
      const sc = sceneOf(systemId);
      if (!sc.ok) return sc;
      if (!isTrafficVictim(sc.scene.getEntityByID(pilotShipId))) return { ok: false, reason: "NOT_PILOT" };
      const controller = npc.getControllerByEntityID(pilotShipId);
      if (!controller || typeof controller !== "object") {
        return { ok: false, reason: "NOT_PILOT", detail: "NPC_NOT_FOUND" };
      }
      const current = kindOf(controller);
      if (current !== data.TRAFFIC_OPERATOR_KIND && current !== kind) return { ok: false, reason: "PILOT_BUSY" };
      for (const id of ratIds) {
        if (!isRatCandidate(sc.scene.getEntityByID(id), npc.getControllerByEntityID(id), kind)) {
          return { ok: false, reason: "RAT_NOT_IDLE", detail: String(id) };
        }
      }
      const pilotRefused = armPilotController(npc, controller, pilotShipId, current, kind);
      if (pilotRefused !== null) return pilotRefused;
      const borrowed = [];
      const failed = [];
      for (const id of ratIds) {
        let snap = null;
        try {
          const rat = npc.getControllerByEntityID(id);
          const overrides = overridesOf(rat);
          snap = { entityId: id, overrides: copyOf(overrides), order: null,
            preferredTargetID: toPositiveInt(rat.preferredTargetID), lastAggressedAtMs: Number(rat.lastAggressedAtMs) || 0,
            rat: true };
          const set = npc.setBehaviorOverrides(id, { ...overrides, [ALLOW_FRIENDLY_KEY]: true });
          const ordered = Boolean(set && set.success === true) && (npc.issueManualOrder(id,
            { type: "attack", targetID: pilotShipId, allowPodKill: false }) || {}).success === true;
          if (!ordered) throw new Error("RAT_ORDER_REFUSED");
          borrowed.push(snap);
          try {
            if (typeof npc.wakeNpcController === "function") npc.wakeNpcController(id, 0);
          } catch (_err) {
          }
        } catch (_err) {
          failed.push(id);
          if (snap !== null) releaseAttackers(npc, pilotShipId, [snap], false, true);
        }
      }
      if (failed.length >= ratIds.length) {
        const d = disarmPilotTarget(systemId, pilotShipId);
        const why = ["RAT_ORDER_REFUSED", d && d.ok !== true ? `disarm ${d.reason}` : null].filter(Boolean).join("; ");
        return { ok: false, reason: "ATTACK_FAILED", detail: why.slice(0, MAX_DETAIL) };
      }
      return { ok: true, kind, ordered: borrowed.length, failed, borrowed };
    } catch (err) {
      return { ok: false, reason: "OPERATOR_WRITE_FAILED", detail: messageOf(err) };
    }
  };

  const releaseEngagedRats = (systemId, pilotShipId, borrowed) => {
    if (!isPositiveInt(systemId) || !isPositiveInt(pilotShipId) || !isBorrowedList(borrowed)) {
      return { ok: false, reason: "INVALID_INPUT" };
    }
    try {
      const npc = aggroNpcOf();
      if (!npc) return { ok: false, reason: "SEAM_UNAVAILABLE" };
      const sc = sceneOf(systemId);
      if (!sc.ok) return sc;
      const keep = [];
      let released = 0;
      for (const b of borrowed) {
        let c = null;
        try {
          c = npc.getControllerByEntityID(b.entityId);
        } catch (_err) {
          c = null;
        }
        if (!c || typeof c !== "object") continue;
        const engaged = b.rat === true && (Number(c.lastAggressedAtMs) || 0) !== (Number(b.lastAggressedAtMs) || 0)
          && hasAttackOrder(c) && toPositiveInt(c.manualOrder.targetID) === pilotShipId;
        if (engaged && releaseAttackers(npc, pilotShipId, [b], false, false).released === 1) {
          released += 1;
          continue;
        }
        keep.push(b);
      }
      return { ok: true, released, keep };
    } catch (err) {
      return { ok: false, reason: "READ_FAILED", detail: messageOf(err) };
    }
  };

  const presentGateJumpOut = (systemId, entityId, gateId) => {
    if (!isPositiveInt(systemId) || !isPositiveInt(entityId) || !isPositiveInt(gateId)) {
      return { ok: false, reason: "INVALID_INPUT" };
    }
    try {
      const sc = sceneOf(systemId);
      if (!sc.ok) return sc;
      return broadcastJumpOut(sc.scene, entityId, gateId);
    } catch (err) {
      return { ok: false, reason: "FX_FAILED", detail: messageOf(err) };
    }
  };

  const presentGateDeparture = (systemId, entityId, gateId) => {
    if (!isPositiveInt(systemId) || !isPositiveInt(entityId) || !isPositiveInt(gateId)) {
      return { ok: false, reason: "INVALID_INPUT" };
    }
    try {
      const sc = sceneOf(systemId);
      if (!sc.ok) return sc;
      return broadcastGateEvent(sc.scene, gateId, entityId, GATE_EVENT.DEPARTURE);
    } catch (err) {
      return { ok: false, reason: "FX_FAILED", detail: messageOf(err) };
    }
  };

  const motionNpcOf = () => {
    if (typeof requireGame !== "function") return null;
    const read = requireGame(MOTION_PATHS.npc);
    return motionOf(read && read.ok === true && read.exports ? read.exports : null);
  };

  const presentMiningBeams = (systemId, req) => {
    if (!isPositiveInt(systemId)) return { ok: false, reason: "INVALID_INPUT" };
    try {
      const sc = sceneOf(systemId);
      if (!sc.ok) return sc;
      return presentBeams(sc.scene, req, req && req.approach ? motionNpcOf() : null);
    } catch (err) {
      return { ok: false, reason: "FX_FAILED", detail: messageOf(err) };
    }
  };

  const patrolMotionOf = () => {
    if (typeof requireGame !== "function") return null;
    const read = requireGame(MOTION_PATHS.npc);
    return motionOf(read && read.ok === true && read.exports ? read.exports : null, PATROL_MARKER);
  };

  const validOrbit = (opts) => Boolean(opts) && typeof opts === "object" && Number.isFinite(opts.meters)
    && opts.meters > 0 && Number.isFinite(opts.speedFraction) && opts.speedFraction > 0 && opts.speedFraction <= 1;

  const presentPatrolOrbit = (systemId, entityId, targetId, opts) => {
    if (!isPositiveInt(systemId) || !isPositiveInt(entityId) || !isPositiveInt(targetId) || !validOrbit(opts)) {
      return { ok: false, reason: "INVALID_INPUT" };
    }
    let motion = null;
    try {
      const sc = sceneOf(systemId);
      if (!sc.ok) return sc;
      const scene = sc.scene;
      motion = typeof scene.orbitShipEntity === "function" ? patrolMotionOf() : null;
      if (!motion) return { ok: false, reason: "SEAM_UNAVAILABLE" };
      const ship = scene.getEntityByID(entityId);
      if (!ship || !scene.getEntityByID(targetId)) return { ok: true, orbiting: false, reason: "FAILED" };
      const scripted = motion.script(entityId);
      if (scripted.ok !== true) return { ok: true, orbiting: false, reason: scripted.reason };
      const accepted = scene.orbitShipEntity(ship, targetId, opts.meters,
        { speedFraction: opts.speedFraction, ...ORBIT_OPTIONS }) === true;
      if (accepted) return { ok: true, orbiting: true };
      motion.release(entityId);
      return { ok: true, orbiting: false, reason: "REFUSED" };
    } catch (_err) {
      if (motion) motion.release(entityId);
      return { ok: true, orbiting: false, reason: "FAILED" };
    }
  };

  const releasePatrolMotion = (systemId, entityId) => {
    if (!isPositiveInt(systemId) || !isPositiveInt(entityId)) return { ok: false, reason: "INVALID_INPUT" };
    try {
      const motion = patrolMotionOf();
      if (!motion) return { ok: false, reason: "SEAM_UNAVAILABLE" };
      return { ok: true, released: motion.release(entityId) };
    } catch (err) {
      return { ok: false, reason: "FX_FAILED", detail: messageOf(err) };
    }
  };

  const closeExplorerSite = (systemId, siteId, now) => {
    if (!isPositiveInt(systemId)) return false;
    const sc = sceneOf(systemId);
    if (!sc.ok) return false;
    const signatures = requireGame(explorerSites.SIGNATURE_RUNTIME_PATH)?.exports;
    const dungeon = requireGame("services/dungeon/dungeonRuntime")?.exports;
    const occupied = requireGame("services/dungeon/dungeonUniverseSiteService")?.exports?._testing?.anyPlayerShipPresentAtSite;
    return explorerSites.closePublicSite(signatures, dungeon, occupied, sc.scene, systemId, siteId, now);
  };

  const readExplorerSites = (systemId, opts) => {
    if (!isPositiveInt(systemId)) return { ok: false, reason: "INVALID_INPUT" };
    try {
      const sc = sceneOf(systemId);
      if (!sc.ok) return sc;
      const read = requireGame(explorerSites.SIGNATURE_RUNTIME_PATH);
      return explorerSites.readExplorerSites(read && read.ok === true ? read.exports : null, sc.scene, systemId, opts);
    } catch (err) {
      return { ok: false, reason: "READ_FAILED", detail: messageOf(err) };
    }
  };

  return Object.freeze({ readNodes, readPlayers, spawnCivilian, warpTo, readShips, despawn, listTrafficIds,
    dockPointOf, readThreats, armPilotTarget, disarmPilotTarget, armPilotRatTarget, releaseEngagedRats,
    presentGateJumpOut, presentMiningBeams, presentGateDeparture, presentPatrolOrbit, releasePatrolMotion, closeExplorerSite,
    readExplorerSites });
}

module.exports = { PATHS, FUNCTIONS, UNDOCK_PATHS, UNDOCK_FUNCTIONS, SEAM_METHODS, AGGRO_PATHS, AGGRO_FUNCTIONS,
  AGGRO_METHODS, RAT_AGGRO_METHODS, FX_METHODS, PATROL_METHODS, EXPLORER_METHODS, isTrafficVictim,
  createHighsecTrafficScene,
  checkHighsecTrafficSceneFrom };
