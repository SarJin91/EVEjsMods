"use strict";

const crypto = require("node:crypto");
const { vec, add, scale, normalize } = require("../util/vec");

const CHARGE_CATEGORY_ID = 8;

const SLOT_ANGLE_RAD = Math.PI * (3 - Math.sqrt(5));

function isObj(value) {
  return value !== null && typeof value === "object";
}

function posInt(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function intOr(value, fallback) {
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : fallback;
}

function defaultIsCharge(item) {
  return intOr(item && item.categoryID, 0) === CHARGE_CATEGORY_ID;
}

function quantityOf(item) {
  const q = intOr(item.quantity, NaN);
  if (Number.isSafeInteger(q) && q > 0) return q;
  const s = intOr(item.stacksize, NaN);
  return Number.isSafeInteger(s) && s > 0 ? s : 1;
}

function fitDigest(fit) {
  const rows = (Array.isArray(fit) ? fit : []).filter(isObj)
    .map((item) => [intOr(item.flagID, 0), intOr(item.typeID, 0), quantityOf(item)]);
  rows.sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]) || (a[2] - b[2]));
  const text = rows.map((r) => r.join(":")).join("|");
  return crypto.createHash("sha1").update(text).digest("hex");
}

function launchSlot(ownerEntity, index, offsetMeters, twinRadius = 0) {
  const owner = isObj(ownerEntity) ? ownerEntity : {};
  const i = Math.max(0, intOr(index, 0));
  const ownerRadius = Math.max(0, Number(owner.radius) || 0);
  const ring = ownerRadius + Math.max(0, Number(offsetMeters) || 0) + Math.max(0, Number(twinRadius) || 0);
  const angle = i * SLOT_ANGLE_RAD;
  const position = add(vec(owner.position), scale({ x: Math.cos(angle), y: 0, z: Math.sin(angle) }, ring));
  return { position, direction: normalize(owner.direction) };
}

function buildTwinSpec(input) {
  const src = isObj(input) ? input : {};
  const ship = src.ship;
  const owner = src.owner;
  if (!isObj(ship) || !posInt(ship.itemID) || !posInt(ship.typeID)) return { ok: false, reason: "BAD_SHIP" };
  if (!isObj(owner) || !posInt(owner.characterId)) return { ok: false, reason: "BAD_SHIP" };
  if (typeof src.allocId !== "function") return { ok: false, reason: "BAD_SHIP" };
  if (!Array.isArray(src.fit)) return { ok: false, reason: "BAD_FIT" };
  for (const item of src.fit) {
    if (!isObj(item) || !posInt(item.itemID) || !posInt(item.typeID)) return { ok: false, reason: "BAD_FIT" };
  }
  const isCharge = typeof src.isCharge === "function" ? src.isCharge : defaultIsCharge;

  const realIds = new Set([ship.itemID, ...src.fit.map((item) => item.itemID)]);
  const used = new Set();
  const alloc = () => {
    let id;
    try {
      id = src.allocId();
    } catch (_err) {
      return null;
    }
    if (!posInt(id) || realIds.has(id) || used.has(id)) return null;
    used.add(id);
    return id;
  };

  const twinEntityId = alloc();
  if (twinEntityId === null) return { ok: false, reason: "BAD_SHIP" };

  const ordered = [...src.fit].sort((a, b) => (intOr(a.flagID, 0) - intOr(b.flagID, 0)) || (a.itemID - b.itemID));
  let charges;
  let modules;
  try {
    charges = ordered.filter((item) => isCharge(item) === true);
    modules = ordered.filter((item) => isCharge(item) !== true);
  } catch (_err) {
    return { ok: false, reason: "BAD_FIT" };
  }

  const syntheticToReal = new Map();
  const moduleBySlot = new Map();
  const fittedItems = [];
  for (const item of modules) {
    const flagID = intOr(item.flagID, 0);
    if (moduleBySlot.has(flagID)) return { ok: false, reason: "BAD_FIT" };
    const itemID = alloc();
    if (itemID === null) return { ok: false, reason: "BAD_FIT" };
    moduleBySlot.set(flagID, itemID);
    syntheticToReal.set(itemID, item.itemID);
    fittedItems.push({
      ...item,
      itemID,
      locationID: twinEntityId,
      moduleState: isObj(item.moduleState) ? { ...item.moduleState } : item.moduleState,
    });
  }

  const nativeCargoItems = [];
  for (const item of charges) {
    const moduleID = moduleBySlot.get(intOr(item.flagID, 0));
    if (moduleID === undefined) return { ok: false, reason: "BAD_FIT" };
    const itemID = alloc();
    if (itemID === null) return { ok: false, reason: "BAD_FIT" };
    syntheticToReal.set(itemID, item.itemID);
    nativeCargoItems.push({ ...item, itemID, locationID: twinEntityId, moduleID });
  }

  const position = vec(src.position);
  const spec = {
    itemID: twinEntityId,
    typeID: ship.typeID,
    groupID: ship.groupID,
    categoryID: ship.categoryID,
    itemName: String(ship.itemName || ship.name || ""),
    ownerID: owner.characterId,
    pilotCharacterID: owner.characterId,
    characterID: 0,
    corporationID: intOr(owner.corporationId, 0),
    allianceID: intOr(owner.allianceId, 0),
    warFactionID: intOr(owner.warFactionId, 0),
    transient: true,
    fittedItems,
    nativeCargoItems,
    skillMap: new Map(src.skillMap instanceof Map ? src.skillMap : []),
    conditionState: isObj(ship.conditionState) ? { ...ship.conditionState } : {},
    position,
    velocity: { x: 0, y: 0, z: 0 },
    direction: normalize(src.direction),
    targetPoint: { ...position },
    mode: "STOP",
    speedFraction: 0,
  };
  return { ok: true, spec, twinEntityId, syntheticToReal, fitDigest: fitDigest(src.fit) };
}

module.exports = { CHARGE_CATEGORY_ID, buildTwinSpec, launchSlot, fitDigest };
