"use strict";

const { add: vecAdd, scale: vecScale, normalize: vecNormalize, vec } = require("../util/vec");
const { isSized, holdTake, round6 } = require("../core/miningTask");

const MAX_CANS_PER_CALL = 2;
const SPAWN_DISTANCE_M = 275;
const SPAWN_MIN_DISTANCE_M = 50;

const OVERFLOW_REFUSAL = Object.freeze([
  "DISABLED", "NOTHING", "NO_SCENE", "CAN_LIMIT", "CAN_TYPE", "CREATE_FAILED", "SPAWN_FAILED", "GRANT_FAILED",
  "CAN_FULL",
]);

function toInt(value, fallback = 0) {
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) ? n : fallback;
}

function toNum(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function isObj(value) {
  return value !== null && typeof value === "object";
}

function sceneKeyOf(scene) {
  const d = scene && scene.sceneDescriptor;
  const key = isObj(d) && d.sceneKey !== undefined && d.sceneKey !== null && d.sceneKey !== "" ? d.sceneKey
    : scene && scene.systemID;
  return String(key);
}

function spawnStateNear(twin) {
  const direction = vecNormalize(twin && twin.direction);
  const distanceM = Math.max(SPAWN_MIN_DISTANCE_M, Math.max(0, toNum(twin && twin.radius, 0)) + SPAWN_DISTANCE_M);
  return {
    position: vecAdd(vec(twin && twin.position), vecScale(direction, distanceM)),
    velocity: { x: 0, y: 0, z: 0 },
    direction,
    mode: "STOP",
    speedFraction: 0,
  };
}

function createOverflowCans(input) {
  const deps = input.deps;
  const config = input.config || {};
  const distance = input.distance;
  const usedVolume = input.usedVolume;
  const byOwner = new Map();

  function left(hold) {
    return isSized(hold) ? toNum(hold.usedM3, 0) : 0;
  }

  function smallestUnit(hold) {
    let unit = Infinity;
    for (const [typeID, qty] of hold.items) {
      const u = toNum(hold.unitM3ByType.get(typeID), 0);
      if (qty > 0 && u > 0 && u < unit) unit = u;
    }
    return unit;
  }

  function liveEntries(owner, scene, key, nowMs) {
    const list = (byOwner.get(owner) || []).filter((e) => {
      if (e.expiresAtMs <= nowMs) return false;
      return e.sceneKey !== key || Boolean(scene.getEntityByID(e.canId));
    });
    if (list.length > 0) byOwner.set(owner, list);
    else byOwner.delete(owner);
    return list;
  }

  function pick(list, scene, key, twin, nowMs, capacity, minUnit) {
    for (const e of list) {
      if (e.sceneKey !== key) continue;
      if (e.expiresAtMs - nowMs < toNum(config.miningOverflowCanMinRemainingMs, 0)) continue;
      const ent = scene.getEntityByID(e.canId);
      if (!ent || !(distance(scene, twin, ent) <= toNum(config.miningTransferRangeMeters, 0))) continue;
      const free = round6(capacity - usedVolume(e.canId, deps.CONTENT_FLAG));
      if (free >= minUnit) return { entry: e, free };
    }
    return null;
  }

  function create(owner, scene, key, twin, nowMs, type) {
    const systemId = toInt(scene.systemID, 0);
    const expiresAtMs = nowMs + toNum(config.miningOverflowCanLifetimeMs, 0);
    let made;
    try {
      made = deps.createSpaceItemForCharacter(owner, systemId, type, {
        ...(deps.buildChildEntityScopeMetadata(twin) || {}),
        ...spawnStateNear(twin),
        createdAtMs: nowMs,
        expiresAtMs,
        launcherID: null,
      });
    } catch (_err) {
      made = null;
    }
    const canId = isObj(made) && made.success === true && isObj(made.data) ? toInt(made.data.itemID, 0) : 0;
    if (canId <= 0) return { ok: false, reason: "CREATE_FAILED" };
    let spawned;
    try {
      spawned = deps.spawnDynamicInventoryEntity(scene.sceneDescriptor || scene.systemID, canId, {
        broadcast: true, broadcastOptions: { freshAcquire: true }, sceneDescriptor: scene.sceneDescriptor || undefined,
      });
    } catch (_err) {
      spawned = null;
    }
    if (!isObj(spawned) || spawned.success !== true) {
      try {
        deps.removeInventoryItem(canId, { removeContents: true });
      } catch (_err) {
      }
      return { ok: false, reason: "SPAWN_FAILED" };
    }
    const entry = { canId, systemId, sceneKey: key, expiresAtMs };
    byOwner.set(owner, [...(byOwner.get(owner) || []), entry]);
    return { ok: true, entry };
  }

  function fill(hold, owner, canId, freeM3) {
    let free = freeM3;
    let moved = 0;
    for (const typeID of [...hold.items.keys()].sort((a, b) => a - b)) {
      const unit = toNum(hold.unitM3ByType.get(typeID), 0);
      const holdFlag = hold.flagByType.get(typeID);
      const have = hold.items.get(typeID) || 0;
      if (!(unit > 0) || !(holdFlag > 0) || have <= 0) continue;
      const qty = Math.min(have, Math.floor(round6(free / unit)));
      if (!(qty > 0)) continue;
      let granted;
      try {
        granted = deps.grantItemsToCharacterLocation(owner, canId, deps.CONTENT_FLAG,
          [{ itemType: typeID, quantity: qty }]);
      } catch (_err) {
        granted = null;
      }
      if (!isObj(granted) || granted.success !== true) return { moved, grantFailed: true };
      const taken = holdTake(hold, holdFlag, typeID, qty, unit);
      const m3 = taken.ok ? taken.m3 : 0;
      moved = round6(moved + m3);
      free = round6(free - m3);
    }
    return { moved, grantFailed: false };
  }

  function jettison(hold, opts) {
    const refuse = (reason, movedM3 = 0, created = false) => ({ ok: false, reason, movedM3, leftM3: left(hold),
      created });
    if (config.miningOverflowCanEnabled !== true) return refuse("DISABLED");
    if (!isSized(hold) || hold.items.size === 0 || !(left(hold) > 0)) return refuse("NOTHING");
    const owner = toInt(opts && opts.ownerCharacterId, 0);
    const scene = opts && opts.scene;
    const twin = opts && opts.twin;
    if (owner <= 0 || !isObj(scene) || typeof scene.getEntityByID !== "function" || !isObj(twin)
      || toInt(scene.systemID, 0) <= 0) return refuse("NO_SCENE");
    const nowMs = toNum(opts.nowMs, 0);
    const key = sceneKeyOf(scene);
    let moved = 0;
    let created = false;
    let canId = 0;
    for (let round = 0; round < MAX_CANS_PER_CALL && hold.items.size > 0; round += 1) {
      const type = deps.resolveItemByTypeID(deps.JETCAN_TYPE_ID);
      const capacity = isObj(type) ? toNum(type.capacity, 0) : 0;
      if (!(capacity > 0)) return refuse("CAN_TYPE", moved, created);
      const list = liveEntries(owner, scene, key, nowMs);
      let found = pick(list, scene, key, twin, nowMs, capacity, smallestUnit(hold));
      if (!found) {
        if (list.length >= toInt(config.miningOverflowMaxCansPerOwner, 0)) {
          return refuse("CAN_LIMIT", moved, created);
        }
        const made = create(owner, scene, key, twin, nowMs, type);
        if (!made.ok) return refuse(made.reason, moved, created);
        created = true;
        found = { entry: made.entry, free: capacity };
      }
      canId = found.entry.canId;
      const out = fill(hold, owner, canId, found.free);
      moved = round6(moved + out.moved);
      if (out.grantFailed) return refuse("GRANT_FAILED", moved, created);
    }
    if (hold.items.size > 0 && left(hold) > 0) return refuse("CAN_FULL", moved, created);
    return { ok: true, movedM3: moved, leftM3: left(hold), canId, created };
  }

  function cansOf(ownerCharacterId) {
    return (byOwner.get(toInt(ownerCharacterId, 0)) || []).map((e) => ({ ...e }));
  }

  return Object.freeze({ jettison, cansOf });
}

module.exports = { OVERFLOW_REFUSAL, MAX_CANS_PER_CALL, sceneKeyOf, spawnStateNear, createOverflowCans };
