"use strict";

const { surfaceDistance: vecSurfaceDistance } = require("../util/vec");

const LIVE_MODULES = Object.freeze({
  runtime: "space/runtime",
  identity: "space/runtime/runtimeEntityIdentity",
  itemStore: "services/inventory/itemStore",
  fitting: "services/fitting/liveFittingState",
  skills: "services/skills/skillState",
  types: "services/inventory/itemTypeRegistry",
  sessions: "services/chat/sessionRegistry",
});

const LOSS_MODULES = Object.freeze({
  deathOutcome: "services/killmail/deathOutcomeResolver",
  custody: "services/inventory/deathItemCustody",
  characterState: "services/character/characterState",
  worldData: "space/worldData",
});

const FORMATION_MODULE = "space/runtime/destinyMovementEngine";

const BOARD_MODULES = Object.freeze({
  shipService: "services/ship/shipService",
  eject: "services/ship/ejectRuntime",
  death: "services/ship/breacherPodDeathRuntime",
  destruction: "space/runtime/combatDestruction",
});
const BOARD_SCOPE_MODULES = Object.freeze({
  scope: "space/destiny/identity/interactionScope",
  tags: "space/runtime/entityScopeTags",
});
const BOARD_ABYSSAL_ACTION = "board_space_ship";
const BOARD_PURSUIT_MODULE = "services/security/shipPursuit";
const BOARD_PURSUIT_OPERATION = "board";
const BOARD_PURSUIT_REFUSAL = Object.freeze({
  CONCORD_PURSUIT_ACTIVE: "CONCORD_PURSUIT",
  FACTION_POLICE_PURSUIT_ACTIVE: "FACTION_POLICE_PURSUIT",
});
const BOARD_SERVER_MODULE = "space/transitions";

const BOARD_GHOST_MODULE = "space/destiny/stream/actions";

const SHIP_CATEGORY_ID = 6;
const LOSS_KEY_PREFIX = "wing-loss:";

function toPosInt(value) {
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
}

function cloakValue(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

function isObj(value) {
  return value !== null && typeof value === "object";
}

function slimModuleTuples(fittedItems) {
  const out = [];
  for (const item of Array.isArray(fittedItems) ? fittedItems : []) {
    if (!isObj(item)) continue;
    const tuple = [toPosInt(item.itemID), toPosInt(item.typeID), toPosInt(item.flagID)];
    if (tuple.every((n) => n > 0)) out.push(tuple);
  }
  return out.sort((a, b) => (a[2] - b[2]) || (a[0] - b[0]));
}

function pinSlimModules(entity, fittedItems) {
  if (!isObj(entity)) return 0;
  const tuples = slimModuleTuples(fittedItems);
  if (tuples.length === 0) return 0;
  const descriptor = Object.getOwnPropertyDescriptor(entity, "modules");
  if (descriptor && descriptor.configurable === false) return 0;
  Object.defineProperty(entity, "modules", {
    get: () => tuples.map((t) => [...t]),
    set: () => {},
    enumerable: true,
    configurable: true,
  });
  return tuples.length;
}

function characterIdOf(session) {
  if (!isObj(session)) return 0;
  return toPosInt(session.characterID) || toPosInt(session.charid);
}

function createWingAdapterCore(game, hooks = {}) {
  const afterSpawn = isObj(hooks) && typeof hooks.afterSpawn === "function" ? hooks.afterSpawn : null;
  const { runtime, identity, itemStore, fitting, skills, types, sessions } = game;
  const loss = isObj(game.loss) ? game.loss : null;
  const movement = isObj(game.movement) && typeof game.movement.dispatchGotoPointEntity === "function"
    ? game.movement : null;
  const board = isObj(game.board) ? game.board : null;
  const shipHangarFlag = itemStore.ITEM_FLAGS.SHIP_HANGAR;

  function loadedScene(sceneKey, scene) {
    return isObj(scene) && typeof sceneKey === "string" && sceneKey !== "" && runtime.scenes.get(sceneKey) === scene;
  }

  function pursuitRefusal(session, shipId) {
    if (!board || typeof board.pursuit !== "function" || toPosInt(shipId) === 0) return null;
    try {
      const scene = runtime.getSceneForSession(session);
      const ship = isObj(scene) ? scene.getEntityByID(toPosInt(shipId)) : null;
      if (!isObj(ship)) return null;
      const error = board.pursuit(scene, ship, BOARD_PURSUIT_OPERATION);
      const code = isObj(error) ? error.errorMsg : null;
      return Object.prototype.hasOwnProperty.call(BOARD_PURSUIT_REFUSAL, code) ? BOARD_PURSUIT_REFUSAL[code] : null;
    } catch (_err) {
      return null;
    }
  }

  function hullState(item, ownerCharacterId) {
    if (!isObj(item)) return "GONE";
    if (toPosInt(item.ownerID) !== ownerCharacterId) return "OWNER_CHANGED";
    const active = loss.characterState.getActiveShipRecord(ownerCharacterId);
    if (isObj(active) && toPosInt(active.itemID) === toPosInt(item.itemID)) return "IN_USE";
    if (loss.worldData.getSolarSystemByID(item.locationID)) return "IN_USE";
    const quantity = Number(item.stacksize ?? item.quantity ?? 1);
    if (Number(item.singleton) !== 1 && quantity > 1) return "IN_USE";
    return "OK";
  }

  function changesOf(result) {
    return isObj(result) && isObj(result.data) && Array.isArray(result.data.changes) ? result.data.changes : [];
  }

  const core = {
    lossAvailable: () => loss !== null,
    lossHull({ shipItemId, ownerCharacterId }) {
      if (!loss) return null;
      const item = itemStore.findItemById(shipItemId);
      if (hullState(item, ownerCharacterId) !== "OK") return null;
      if (toPosInt(item.categoryID) !== SHIP_CATEGORY_ID || Number(item.singleton) !== 1) return null;
      return item;
    },
    settleShipLoss({ shipItemId, ownerCharacterId, wreckId }) {
      if (!loss) return { ok: false, reason: "SETTLE_FAILED", detail: "no_loss_modules" };
      const item = itemStore.findItemById(shipItemId);
      const state = hullState(item, ownerCharacterId);
      if (state === "GONE") return { ok: true, outcome: "HULL_ALREADY_GONE", changes: [] };
      if (state === "OWNER_CHANGED") return { ok: true, outcome: "OWNER_CHANGED", changes: [] };
      if (state === "IN_USE") return { ok: false, reason: "HULL_IN_USE" };
      const seed = `${LOSS_KEY_PREFIX}${shipItemId}`;
      const wreck = toPosInt(wreckId) > 0 && itemStore.findItemById(wreckId) ? toPosInt(wreckId) : 0;
      let outcome;
      try {
        outcome = loss.deathOutcome.resolveLocationDeathOutcome(shipItemId, wreck > 0
          ? { rootLootLocationID: wreck, seed }
          : { forceAllDestroyed: true, seed });
      } catch (err) {
        return { ok: false, reason: "SETTLE_FAILED", detail: String((err && err.message) || err) };
      }
      if (!isObj(outcome) || outcome.success !== true) return { ok: false, reason: "SETTLE_FAILED", detail: "outcome" };
      const data = isObj(outcome.data) ? outcome.data : {};
      const changes = [...(Array.isArray(data.movedChanges) ? data.movedChanges : []),
        ...(Array.isArray(data.destroyChanges) ? data.destroyChanges : [])];
      const hull = itemStore.findItemById(shipItemId);
      if (hull) {
        const destroyed = loss.custody.destroyItem({ item: hull, idempotencyKey: seed, removeContents: true });
        if (!isObj(destroyed) || destroyed.success !== true) {
          return { ok: false, reason: "SETTLE_FAILED", detail: String((destroyed && destroyed.errorMsg) || "destroy") };
        }
        changes.push(...changesOf(destroyed));
        if (itemStore.findItemById(shipItemId)) {
          return { ok: false, reason: "SETTLE_FAILED", detail: "hull_still_there" };
        }
      }
      return { ok: true, outcome: "HULL_DESTROYED", changes };
    },
    conditionOf(entity) {
      const c = isObj(entity) && isObj(entity.conditionState) ? entity.conditionState : null;
      if (!c) return null;
      const out = {};
      for (const key of ["damage", "charge", "armorDamage", "shieldCharge"]) {
        const n = Number(c[key]);
        if (!Number.isFinite(n)) return null;
        out[key] = n;
      }
      const structureHP = Number(entity.structureHP);
      if (Number.isFinite(structureHP) && structureHP > 0) out.structureHP = structureHP;
      return out;
    },
    writeCondition(shipItemId, condition) {
      if (!loss) return { ok: false, reason: "NO_LOSS_MODULES" };
      const basisHP = Number(condition.structureHP);
      const result = itemStore.updateShipItem(shipItemId, (current) => ({
        ...current,
        conditionState: itemStore.normalizeShipConditionState({
          ...(isObj(current.conditionState) ? current.conditionState : {}),
          damage: condition.damage, charge: condition.charge,
          armorDamage: condition.armorDamage, shieldCharge: condition.shieldCharge,
        }),
        structureDamageBasisHP: condition.damage > 0 && Number.isFinite(basisHP) && basisHP > 0 ? basisHP : null,
      }));
      if (!isObj(result) || result.success !== true) {
        return { ok: false, reason: String((result && result.errorMsg) || "UPDATE_FAILED") };
      }
      return { ok: true, changes: [{ item: result.data, previousData: result.previousData || {} }] };
    },
    emitItemChanges(session, changes) {
      if (!loss || !Array.isArray(changes) || changes.length === 0) return 0;
      return loss.characterState.emitItemsChangedBatchForSession(session, changes, { idType: "charid" }) === false
        ? 0 : changes.length;
    },
    customNotify(session, text) {
      if (!isObj(session) || typeof session.sendNotification !== "function" || typeof text !== "string"
        || text === "") return false;
      try {
        return session.sendNotification("OnRemoteMessage", "clientID", ["CustomNotify", {
          type: "dict", entries: [["notify", { type: "wstring", value: text }]],
        }]) !== false;
      } catch (_err) {
        return false;
      }
    },
    findSession: (charId) => sessions.findSessionByCharacterID(charId) || null,
    characterIdOf,
    spaceOf(session) {
      const space = isObj(session) ? session._space : null;
      if (!isObj(space)) return null;
      const sceneKey = typeof space.sceneKey === "string" ? space.sceneKey : "";
      const systemId = toPosInt(space.systemID);
      const shipId = toPosInt(space.shipID);
      if (sceneKey === "" || systemId === 0 || shipId === 0) return null;
      return { systemId, sceneKey, shipId };
    },
    dockedAt(session) {
      if (!isObj(session)) return 0;
      const structureId = toPosInt(session.structureid ?? session.structureID ?? session.structureId);
      return structureId || toPosInt(session.stationid ?? session.stationID ?? session.stationId);
    },
    sceneOf: (session) => runtime.getSceneForSession(session) || null,
    isSceneLoaded: (sceneKey, scene) => loadedScene(sceneKey, scene),
    hostEntity: (scene, id) => scene.getEntityByID(id) || null,
    hostStatus: (_scene, entity) => ({ warping: entity.mode === "WARP", docking: Boolean(entity.pendingDock),
      pilotId: entity.pilotCharacterID === undefined && entity.characterID === undefined ? null
        : toPosInt(entity.pilotCharacterID ?? entity.characterID),
      cloaked: cloakValue(entity.isCloaked ?? entity.cloakMode ?? entity.cloaked) > 0 }),
    activeShipId(charId) {
      if (!loss) return 0;
      const active = loss.characterState.getActiveShipRecord(charId);
      return isObj(active) ? toPosInt(active.itemID) : 0;
    },
    listBayShips: (hostShipId) => itemStore.listContainerItems(null, hostShipId, shipHangarFlag),
    readFit: (shipItemId) => fitting.listFittedItemsForLocation(shipItemId),
    isCharge: (item) => fitting.isFittedChargeItem(item) === true,
    missingSkills: (charId, typeId) => fitting.getMissingRequiredSkills(charId, typeId),
    skillMap: (charId) => skills.getCachedCharacterSkillMap(charId),
    ownerIdentity: (session) => ({
      characterId: characterIdOf(session),
      corporationId: toPosInt(session.corporationID),
      allianceId: toPosInt(session.allianceID),
      warFactionId: toPosInt(session.warFactionID),
    }),
    allocId: () => identity.allocateRuntimeEntityID(),
    typeName(typeId) {
      const type = types.resolveItemByTypeID(typeId);
      return type && type.name ? String(type.name) : "";
    },
    spawn(scene, systemId, spec) {
      if (!isObj(scene) || !loadedScene(scene.sceneKey, scene)) return { ok: false, reason: "SCENE_NOT_LOADED" };
      const result = runtime.spawnDynamicShip(systemId, spec, { sceneDescriptor: scene.sceneDescriptor });
      const entity = isObj(result) && result.success === true && isObj(result.data) ? result.data.entity : null;
      if (isObj(entity)) {
        if (afterSpawn) {
          try {
            afterSpawn(entity);
          } catch (_err) {
          }
        }
        let modulesShown = false;
        try {
          const pinned = pinSlimModules(entity, spec && spec.fittedItems);
          if (pinned > 0 && typeof scene.broadcastSlimItemChanges === "function") {
            modulesShown = scene.broadcastSlimItemChanges([entity]) > 0;
          }
        } catch (_err) {
          modulesShown = false;
        }
        return { ok: true, entity, modulesShown };
      }
      return { ok: false, reason: String((isObj(result) && result.errorMsg) || "SPAWN_FAILED") };
    },
    follow: (scene, entity, targetId, rangeM) => scene.followShipEntity(entity, targetId, rangeM) === true,
    remove(scene, entityId, _nowMs) {
      if (scene.getEntityByID(entityId)) {
        const options = typeof scene.getCurrentSimTimeMs === "function" ? { nowMs: scene.getCurrentSimTimeMs() } : {};
        scene.removeDynamicEntity(entityId, options);
      }
      return !scene.getEntityByID(entityId);
    },
    entity: (scene, id) => scene.getEntityByID(id) || null,
    controlledDroneIds(scene, shipId) {
      const ship = toPosInt(shipId);
      const map = isObj(scene) ? scene.dynamicEntities : null;
      if (ship === 0 || !(map instanceof Map)) return null;
      const out = [];
      for (const [key, e] of map) {
        if (isObj(e) && e.kind === "drone" && toPosInt(e.controllerID) === ship && toPosInt(key) > 0) {
          out.push(toPosInt(key));
        }
      }
      return out;
    },
    surfaceDistance(scene, a, b) {
      if (typeof scene.getEntitySurfaceDistance === "function") {
        const d = Number(scene.getEntitySurfaceDistance(a, b));
        return Number.isFinite(d) ? Math.max(0, d) : Infinity;
      }
      return vecSurfaceDistance(a.position, a.radius, b.position, b.radius);
    },
    motionOf(entity) {
      if (!isObj(entity) || !finiteVec(entity.position)) return null;
      const radius = Number(entity.radius);
      return { position: copyVec(entity.position), velocity: finiteVec(entity.velocity) ? copyVec(entity.velocity)
        : zeroVec(), direction: finiteVec(entity.direction) ? copyVec(entity.direction) : zeroVec(),
      radius: Number.isFinite(radius) && radius > 0 ? radius : 0 };
    },
  };
  if (board) {
    core.boardVendorRefusal = (session) => {
      if (board.abyssal(session, BOARD_ABYSSAL_ACTION) != null) return "ABYSSAL";
      const shipId = isObj(session) ? ((isObj(session._space) && session._space.shipID) || session.shipID) : null;
      if (board.death.isShipDeathPending(shipId) === true) return "SHIP_DEATH_PENDING";
      return pursuitRefusal(session, shipId);
    };
    core.isDestroying = (entity) => isObj(entity)
      && board.destruction.isRuntimeEntityDestroyingOrDestroyed(entity) === true;
    core.launchFromBay = (session, hostShipId, shipItemId, anchor) => {
      const result = board.eject.launchShipFromMaintenanceContainer(session, hostShipId, shipItemId,
        { launchAnchorEntity: anchor });
      if (isObj(result) && result.success === true) {
        return { ok: true, entity: isObj(result.data) && isObj(result.data.entity) ? result.data.entity : null };
      }
      return { ok: false, reason: String((isObj(result) && result.errorMsg) || "LAUNCH_FAILED") };
    };
    if (isObj(board.launchScope)) {
      const { scope, tags } = board.launchScope;
      core.launchScopeRefusal = (host, anchor) => {
        if (scope.resolveEntityInteractionScope(host).valid !== true) return "HOST";
        const hull = { kind: "ship" };
        tags.applyRuntimeEntityScopeMetadata(hull, scope.buildChildEntityScopeMetadata(anchor));
        tags.clearPlayerShipGenericDungeonScope(hull, { playerOwned: true });
        return scope.resolveEntityInteractionScope(hull).valid === true ? null : "HULL";
      };
    }
    if (isObj(game.boardServer)) {
      const transitions = game.boardServer;
      core.boardFromServer = (session, shipItemId) => {
        const result = transitions.boardSpaceShip(session, shipItemId, { abandonCurrentHull: true });
        if (isObj(result) && result.success === true) return { ok: true };
        return { ok: false, reason: String((isObj(result) && result.errorMsg) || "BOARD_FAILED") };
      };
    }
    if (isObj(game.boardGhost)) {
      const actions = game.boardGhost;
      core.knownBubbleOf = (scene, session) => {
        try {
          const id = scene.getKnownGridBubbleIDForSession(session);
          return id === undefined ? null : id;
        } catch (_err) {
          return null;
        }
      };
      core.resendRemoveBalls = (scene, session, ids) => {
        const list = (Array.isArray(ids) ? ids : []).map(toPosInt).filter((n) => n > 0);
        if (list.length === 0) return false;
        const stamp = scene.queueCharacterHistory(session, [{ payload: actions.buildRemoveBallsPayload(list) }]);
        return stamp !== null && stamp !== undefined;
      };
    }
    if (isObj(game.boardStow)) {
      const eject = game.boardStow;
      core.stowToActiveBay = (session, shipItemId) => {
        const result = eject.scoopShipIntoActiveShipMaintenanceBay(session, shipItemId);
        if (isObj(result) && result.success === true) return { ok: true };
        return { ok: false, reason: String((isObj(result) && result.errorMsg) || "STOW_FAILED") };
      };
    }
  }
  if (movement) {
    core.gotoPoint = (scene, entity, point) => {
      if (!isObj(scene) || !isObj(entity) || !finiteVec(point)) return false;
      return movement.dispatchGotoPointEntity(scene, entity, copyVec(point), {}) === true;
    };
  }
  return core;
}

function finiteVec(v) {
  return isObj(v) && Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
}

function copyVec(v) {
  return { x: v.x, y: v.y, z: v.z };
}

function zeroVec() {
  return { x: 0, y: 0, z: 0 };
}

function createLiveAdapter(adapter, hooks = {}) {
  if (!adapter || typeof adapter.isConsumerAvailable !== "function" || !adapter.isConsumerAvailable("spawn")) {
    return { ok: false, reason: "probe_spawn_unavailable" };
  }
  const game = {};
  for (const [key, rel] of Object.entries(LIVE_MODULES)) {
    const loaded = adapter.requireGame(rel);
    if (!loaded || !loaded.ok) return { ok: false, reason: `require_failed:${rel}:${loaded && loaded.reason}` };
    game[key] = loaded.exports;
  }
  const flags = game.itemStore && game.itemStore.ITEM_FLAGS;
  if (!isObj(flags) || !Number.isInteger(flags.SHIP_HANGAR)) return { ok: false, reason: "no_ship_hangar_flag" };
  if (!isObj(game.runtime) || !game.runtime.scenes || typeof game.runtime.scenes.get !== "function") {
    return { ok: false, reason: "no_runtime_scenes" };
  }
  let lossReason = null;
  if (adapter.isConsumerAvailable("loss")) {
    const lossGame = {};
    for (const [key, rel] of Object.entries(LOSS_MODULES)) {
      const loaded = adapter.requireGame(rel);
      if (!loaded || !loaded.ok) {
        lossReason = `require_failed:${rel}:${loaded && loaded.reason}`;
        break;
      }
      lossGame[key] = loaded.exports;
    }
    if (lossReason === null) game.loss = lossGame;
  } else {
    lossReason = "probe_loss_unavailable";
  }
  let formationReason = null;
  if (adapter.isConsumerAvailable("formation")) {
    const loaded = adapter.requireGame(FORMATION_MODULE);
    if (loaded && loaded.ok && isObj(loaded.exports) && typeof loaded.exports.dispatchGotoPointEntity === "function") {
      game.movement = loaded.exports;
    } else {
      formationReason = `require_failed:${FORMATION_MODULE}:${(loaded && loaded.reason) || "no_function"}`;
    }
  } else {
    formationReason = "probe_formation_unavailable";
  }
  let boardReason = null;
  if (adapter.isConsumerAvailable("board")) {
    const loaded = {};
    for (const [key, rel] of Object.entries(BOARD_MODULES)) {
      const r = adapter.requireGame(rel);
      if (!r || !r.ok) {
        boardReason = `require_failed:${rel}:${r && r.reason}`;
        break;
      }
      loaded[key] = r.exports;
    }
    if (boardReason === null) {
      const picked = boardGameOf(loaded);
      if (picked.ok) game.board = picked.board;
      else boardReason = picked.reason;
    }
    if (boardReason === null) {
      const scopeLoaded = {};
      for (const [key, rel] of Object.entries(BOARD_SCOPE_MODULES)) {
        const r = adapter.requireGame(rel);
        if (r && r.ok && isObj(r.exports)) scopeLoaded[key] = r.exports;
      }
      if (isBoardScopeGame(scopeLoaded)) game.board.launchScope = scopeLoaded;
      const pursuit = adapter.requireGame(BOARD_PURSUIT_MODULE);
      if (pursuit && pursuit.ok && isObj(pursuit.exports)
        && typeof pursuit.exports.getShipChangePursuitError === "function") {
        game.board.pursuit = pursuit.exports.getShipChangePursuitError;
      }
    }
  } else {
    boardReason = "probe_board_unavailable";
  }
  let boardServerReason = null;
  if (boardReason !== null) boardServerReason = "board_unavailable";
  else if (!adapter.isConsumerAvailable("boardServer")) boardServerReason = "probe_boardServer_unavailable";
  else {
    const loaded = adapter.requireGame(BOARD_SERVER_MODULE);
    if (loaded && loaded.ok && isObj(loaded.exports) && typeof loaded.exports.boardSpaceShip === "function") {
      game.boardServer = loaded.exports;
    } else {
      boardServerReason = `require_failed:${BOARD_SERVER_MODULE}:${(loaded && loaded.reason) || "no_function"}`;
    }
  }
  let boardGhostReason = null;
  if (boardReason !== null) boardGhostReason = "board_unavailable";
  else if (!adapter.isConsumerAvailable("boardGhost")) boardGhostReason = "probe_boardGhost_unavailable";
  else {
    const loaded = adapter.requireGame(BOARD_GHOST_MODULE);
    if (loaded && loaded.ok && isObj(loaded.exports) && typeof loaded.exports.buildRemoveBallsPayload === "function") {
      game.boardGhost = loaded.exports;
    } else {
      boardGhostReason = `require_failed:${BOARD_GHOST_MODULE}:${(loaded && loaded.reason) || "no_function"}`;
    }
  }
  let boardStowReason = null;
  if (boardReason !== null) boardStowReason = "board_unavailable";
  else if (!adapter.isConsumerAvailable("boardStow")) boardStowReason = "probe_boardStow_unavailable";
  else if (typeof game.board.eject.scoopShipIntoActiveShipMaintenanceBay !== "function") {
    boardStowReason = "no_scoopShipIntoActiveShipMaintenanceBay";
  } else {
    game.boardStow = game.board.eject;
  }
  const scoopReturnReason = boardReason !== null ? "board_unavailable"
    : (adapter.isConsumerAvailable("scoopReturn") ? null : "probe_scoopReturn_unavailable");
  return { ok: true, adapter: createWingAdapterCore(game, hooks), lossReason, formationReason, boardReason,
    boardServerReason, boardGhostReason, boardStowReason, scoopReturnReason };
}

function boardGameOf(loaded) {
  const src = isObj(loaded) ? loaded : {};
  const testing = typeof src.shipService === "function" || isObj(src.shipService) ? src.shipService._testing : null;
  if (!isObj(testing) || typeof testing.getActiveAbyssalShipSwapRestriction !== "function") {
    return { ok: false, reason: "no_abyssal_check" };
  }
  for (const [key, fn] of [["eject", "launchShipFromMaintenanceContainer"], ["death", "isShipDeathPending"],
    ["destruction", "isRuntimeEntityDestroyingOrDestroyed"]]) {
    if (!isObj(src[key]) || typeof src[key][fn] !== "function") return { ok: false, reason: `no_${fn}` };
  }
  return { ok: true, board: {
    abyssal: (session, action) => testing.getActiveAbyssalShipSwapRestriction(session, action),
    eject: src.eject, death: src.death, destruction: src.destruction,
  } };
}

function isBoardScopeGame(loaded) {
  const src = isObj(loaded) ? loaded : {};
  return isObj(src.scope) && isObj(src.tags)
    && ["resolveEntityInteractionScope", "buildChildEntityScopeMetadata"]
      .every((k) => typeof src.scope[k] === "function")
    && ["applyRuntimeEntityScopeMetadata", "clearPlayerShipGenericDungeonScope"]
      .every((k) => typeof src.tags[k] === "function");
}

function registerShutdown(gameStoreExports, name, handler) {
  if (!isObj(gameStoreExports) || typeof gameStoreExports.registerShutdownHook !== "function") {
    return { ok: false, reason: "SHUTDOWN_HOOK_UNAVAILABLE" };
  }
  try {
    const unregister = gameStoreExports.registerShutdownHook(name, handler);
    return { ok: true, unregister: typeof unregister === "function" ? unregister : () => {} };
  } catch (err) {
    return { ok: false, reason: "SHUTDOWN_HOOK_REJECTED", detail: String((err && err.message) || err) };
  }
}

module.exports = {
  LIVE_MODULES, LOSS_MODULES, FORMATION_MODULE, characterIdOf, createWingAdapterCore, createLiveAdapter, registerShutdown,
  slimModuleTuples, pinSlimModules, BOARD_MODULES, boardGameOf, BOARD_SERVER_MODULE, BOARD_GHOST_MODULE,
  BOARD_SCOPE_MODULES, isBoardScopeGame,
};
