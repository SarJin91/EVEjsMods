"use strict";

const { sessionOf, inWarpOf } = require("./shipTelemetry");

const FULL_SWEEP_RADIANS = Math.PI * 2;
const MAX_RANGE_REQUEST_METERS = 1e15;
const DIRECTION = Object.freeze([1, 0, 0]);
const ABYSSAL_ERROR_NAME = "MachoWrappedException";

const isObj = (v) => Boolean(v) && typeof v === "object";
const fail = (reason) => ({ ok: false, reason });
const positiveInt = (v) => {
  const n = Math.trunc(Number(v));
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
};
const idOrNull = (v) => {
  const n = positiveInt(v);
  return n > 0 ? n : null;
};
const finite = (v, fallback) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};
const pointOf = (v) => {
  if (!isObj(v)) return null;
  const p = { x: Number(v.x), y: Number(v.y), z: Number(v.z) };
  return Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z) ? p : null;
};

function keyValField(kv, name) {
  if (!(isObj(kv) && isObj(kv.args) && Array.isArray(kv.args.entries))) return null;
  for (const pair of kv.args.entries) {
    if (Array.isArray(pair) && pair[0] === name) return pair[1] === undefined ? null : pair[1];
  }
  return null;
}

function surfaceDistance(ego, entity) {
  const a = pointOf(ego && ego.position);
  const b = pointOf(entity && entity.position);
  if (!a || !b) return null;
  const d = Math.sqrt((b.x - a.x) ** 2 + (b.y - a.y) ** 2 + (b.z - a.z) ** 2);
  return Math.max(0, d - Math.max(0, finite(ego.radius, 0)) - Math.max(0, finite(entity.radius, 0)));
}

function readDirectionalScanFrom(mods, playerId, opts) {
  try {
    const m = mods || {};
    const o = opts || {};
    const range = o.rangeMeters;
    if (!Number.isSafeInteger(playerId) || playerId <= 0 || !Number.isSafeInteger(o.maxEntries) || o.maxEntries <= 0
      || !(range === null || (typeof range === "number" && Number.isFinite(range) && range > 0))) {
      return fail("INVALID_INPUT");
    }
    const found = sessionOf(m.sessionRegistry, playerId);
    if (!found.ok) return found;
    const s = found.session;
    if (s.stationid || s.stationID || s.structureid || s.structureID) return fail("DOCKED");
    const space = isObj(s._space) ? s._space : null;
    const shipId = positiveInt((space && space.shipID) || s.shipID || s.shipid);
    const runtime = m.runtime;
    if (!isObj(runtime) || typeof runtime.getEntity !== "function") return fail("SEAM_UNAVAILABLE");
    const ego = shipId > 0 ? runtime.getEntity(s, shipId) : null;
    if (!isObj(ego)) return fail("NO_SHIP");
    if (inWarpOf(ego)) return fail("IN_WARP");
    const proto = typeof m.scanMgr === "function" && isObj(m.scanMgr.prototype) ? m.scanMgr.prototype : null;
    const registry = m.registry;
    if (!proto || typeof proto.Handle_ConeScan !== "function" || typeof proto._getSystemID !== "function"
      || !(runtime.scenes instanceof Map) || !isObj(registry)
      || typeof registry.getControllerByEntityID !== "function") {
      return fail("SEAM_UNAVAILABLE");
    }
    let raw;
    try {
      raw = proto.Handle_ConeScan.call(Object.create(proto),
        [FULL_SWEEP_RADIANS, range === null ? MAX_RANGE_REQUEST_METERS : range, ...DIRECTION], s);
    } catch (err) {
      return fail(isObj(err) && err.name === ABYSSAL_ERROR_NAME ? "ABYSSAL_BLOCKED" : "SEAM_FAILED");
    }
    if (!Array.isArray(raw)) return fail("SEAM_FAILED");
    const systemId = positiveInt((space && space.systemID) || s.solarsystemid2 || s.solarsystemid);
    const scene = systemId > 0 ? runtime.scenes.get(systemId) : null;
    const getById = isObj(scene) && typeof scene.getEntityByID === "function" ? scene.getEntityByID.bind(scene) : null;
    const resolve = isObj(m.factionKill) && typeof m.factionKill.resolveVictimFactionID === "function"
      ? m.factionKill.resolveVictimFactionID : null;
    const factionOf = (entity) => {
      if (!resolve) return null;
      try {
        return idOrNull(resolve.call(m.factionKill, entity));
      } catch (_err) {
        return null;
      }
    };
    const entries = [];
    let unresolved = 0;
    for (const kv of raw.slice(0, o.maxEntries)) {
      const id = positiveInt(keyValField(kv, "id"));
      const entity = id > 0 && getById ? getById(id) : null;
      if (!isObj(entity)) {
        unresolved += 1;
        continue;
      }
      const kind = typeof entity.kind === "string" ? entity.kind : "";
      const controller = registry.getControllerByEntityID(id);
      const isShip = kind === "ship";
      const isPlayer = isShip && positiveInt(entity.characterID) > 0 && entity.nativeNpc !== true && !controller;
      const order = isObj(controller) && isObj(controller.manualOrder) ? controller.manualOrder : null;
      const targetsMe = isObj(controller) && (positiveInt(controller.currentTargetID) === shipId
        || (order !== null && String(order.type || "").toLowerCase() === "attack"
          && positiveInt(order.targetID) === shipId));
      entries.push({ entityId: id, typeId: positiveInt(keyValField(kv, "typeID")),
        groupId: positiveInt(keyValField(kv, "groupID")), kind, distanceMeters: surfaceDistance(ego, entity), isPlayer,
        characterId: isPlayer ? idOrNull(entity.characterID) : null,
        corporationId: isPlayer ? idOrNull(entity.corporationID) : null,
        allianceId: isPlayer ? idOrNull(entity.allianceID) : null,
        factionId: isShip && !isPlayer ? factionOf(entity) : null, targetsMe: Boolean(targetsMe) });
    }
    return { ok: true, systemId, rangeMeters: range, truncated: raw.length > o.maxEntries, unresolved,
      own: { corporationId: idOrNull(s.corporationID || s.corpid), allianceId: idOrNull(s.allianceID || s.allianceid) },
      entries };
  } catch (_err) {
    return fail("SEAM_UNAVAILABLE");
  }
}

module.exports = { readDirectionalScanFrom, keyValField, FULL_SWEEP_RADIANS, MAX_RANGE_REQUEST_METERS };
