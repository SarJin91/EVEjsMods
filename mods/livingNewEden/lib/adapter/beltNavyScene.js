"use strict";

const { attackLockFields } = require("./attackLock");

const MAX_DETAIL = 120;

const MODULE_PATHS = Object.freeze({
  runtime: "space/runtime",
  npc: "space/npc/npcService",
});

const REQUIRED_FUNCTIONS = Object.freeze({
  runtime: Object.freeze(["isSolarSystemSceneLoaded"]),
  npc: Object.freeze(["issueManualOrder", "wakeNpcController", "getControllerByEntityID"]),
});

const SEAM_METHODS = Object.freeze(["readGroup", "orderGroup"]);

const ORDER_FAILED = "ORDER_FAILED";

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

function toTimeMs(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function pointOf(value) {
  if (!value || typeof value !== "object") return null;
  const x = Number(value.x);
  const y = Number(value.y);
  const z = Number(value.z);
  return Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z) ? { x, y, z } : null;
}

function loadMods(requireGame) {
  const mods = {};
  const missing = [];
  for (const [key, relPath] of Object.entries(MODULE_PATHS)) {
    let loaded;
    try {
      loaded = requireGame(relPath);
    } catch (_err) {
      loaded = null;
    }
    if (!loaded || loaded.ok !== true || !loaded.exports) {
      missing.push(relPath);
      continue;
    }
    mods[key] = loaded.exports;
    for (const name of REQUIRED_FUNCTIONS[key]) {
      if (typeof loaded.exports[name] !== "function") missing.push(`${relPath}.${name}`);
    }
  }
  if (mods.runtime && !(mods.runtime.scenes instanceof Map)) missing.push(`${MODULE_PATHS.runtime}.scenes`);
  return missing.length === 0 ? { ok: true, mods } : { ok: false, reason: "SEAM_UNAVAILABLE", missing };
}

function checkBeltNavySceneFrom(requireGame) {
  const loaded = loadMods(requireGame);
  return loaded.ok ? { ok: true } : loaded;
}

function loadedSceneOf(runtime, systemId) {
  if (runtime.isSolarSystemSceneLoaded(systemId) !== true) return null;
  const scene = runtime.scenes.get(systemId);
  return scene && typeof scene.getEntityByID === "function" ? scene : null;
}

function manualTargetOf(controller) {
  const order = controller && controller.manualOrder;
  return order && order.type === "attack" ? toPositiveInt(order.targetID) : 0;
}

function shipOf(entity, entityId, controller) {
  const position = pointOf(entity && entity.position);
  if (position === null) return null;
  return { entityId, position, manualTargetId: manualTargetOf(controller),
    aggressorEntityId: toPositiveInt(controller && controller.lastAggressorID),
    aggressedAtMs: toTimeMs(controller && controller.lastAggressedAtMs) };
}

function createBeltNavyScene({ requireGame, attackLock }) {
  const readGroup = (systemId, entityIds) => {
    if (!isPositiveInt(systemId) || !Array.isArray(entityIds) || !entityIds.every(isPositiveInt)) {
      return { ok: false, reason: "INVALID_INPUT" };
    }
    try {
      const loaded = loadMods(requireGame);
      if (!loaded.ok) return loaded;
      const scene = loadedSceneOf(loaded.mods.runtime, systemId);
      if (!scene) return { ok: true, ships: [] };
      const ships = [];
      for (const entityId of entityIds) {
        const entity = scene.getEntityByID(entityId);
        if (!entity) continue;
        const ship = shipOf(entity, entityId, loaded.mods.npc.getControllerByEntityID(entityId));
        if (ship) ships.push(ship);
      }
      return { ok: true, ships };
    } catch (err) {
      return { ok: false, reason: "READ_FAILED", detail: messageOf(err) };
    }
  };

  const orderOne = (npc, entityId, targetId) => {
    const order = targetId > 0
      ? { type: "attack", targetID: targetId, allowPodKill: false, ...attackLockFields(attackLock) }
      : { type: "resume" };
    const issued = npc.issueManualOrder(entityId, order);
    return issued && issued.success === true ? npc.wakeNpcController(entityId, 0) : issued;
  };

  const orderGroup = (systemId, orders) => {
    if (!isPositiveInt(systemId) || !Array.isArray(orders) || !orders.every((o) => o && isPositiveInt(o.entityId)
      && (o.targetId === 0 || isPositiveInt(o.targetId)))) {
      return { ok: false, reason: "INVALID_INPUT" };
    }
    try {
      const loaded = loadMods(requireGame);
      if (!loaded.ok) return loaded;
      const scene = loadedSceneOf(loaded.mods.runtime, systemId);
      if (!scene) return { ok: false, reason: "SCENE_NOT_LOADED" };
      const failed = [];
      let detail = null;
      for (const { entityId, targetId } of orders) {
        try {
          const present = scene.getEntityByID(entityId) && (targetId === 0 || scene.getEntityByID(targetId));
          const done = present ? orderOne(loaded.mods.npc, entityId, targetId) : { errorMsg: "ENTITY_NOT_IN_SCENE" };
          if (done && done.success === true) continue;
          if (detail === null) detail = String((done && done.errorMsg) || ORDER_FAILED).slice(0, MAX_DETAIL);
        } catch (err) {
          if (detail === null) detail = messageOf(err);
        }
        failed.push(entityId);
      }
      return detail === null ? { ok: true, failed } : { ok: true, failed, detail };
    } catch (err) {
      return { ok: false, reason: ORDER_FAILED, detail: messageOf(err) };
    }
  };

  return { readGroup, orderGroup };
}

module.exports = { MODULE_PATHS, REQUIRED_FUNCTIONS, SEAM_METHODS, createBeltNavyScene, checkBeltNavySceneFrom };
