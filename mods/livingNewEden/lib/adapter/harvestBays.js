"use strict";

const { timeOrNull } = require("./structures");

const PATHS = Object.freeze({
  itemStore: "services/inventory/itemStore",
  types: "services/inventory/itemTypeRegistry",
  state: "services/structure/structureState",
});

const REQUIRED = Object.freeze({
  itemStore: Object.freeze(["listContainerItems", "findItemById", "consumeInventoryItemQuantityIdempotent",
    "getIdempotentGrantReceipt"]),
  types: Object.freeze(["resolveItemByTypeID"]),
  state: Object.freeze(["getStructureByID"]),
});

const REASONS = Object.freeze({
  UNAVAILABLE: "HARVEST_BAYS_SEAM_UNAVAILABLE",
  SEAM_ERROR: "SEAM_ERROR",
  INVALID_INPUT: "INVALID_INPUT",
  NOT_FOUND: "NOT_FOUND",
  NOT_METENOX: "NOT_METENOX",
  WRONG_ITEM: "WRONG_ITEM",
  ITEM_NOT_FOUND: "ITEM_NOT_FOUND",
  RECEIPT_MISMATCH: "IDEMPOTENCY_RECEIPT_MISMATCH",
});

const CONSUMER = "harvestRaid";
const METENOX_TYPE_ID = 81826;
const FLAG_MOON_MATERIAL_BAY = 186;
const GROUP_MOON_MATERIAL = 427;
const RECEIPT_PREFIX = "lne-hraid:";
const MAX_DETAIL = 120;
const RECEIPT_READ = Object.freeze({ requireDurable: true, reconcileWriteRefusal: true });
const PERMANENT = Object.freeze(["ITEM_NOT_FOUND", "INSUFFICIENT_ITEMS", "IDEMPOTENCY_RECEIPT_MISMATCH", "WRONG_ITEM",
  "INVALID_INPUT", "INVALID_IDEMPOTENCY_KEY", "ITEM_QUANTITY_OUT_OF_RANGE"]);

const isObj = (v) => v !== null && typeof v === "object";
const isId = (v) => Number.isSafeInteger(v) && v > 0;
const num = (v, fallback = 0) => (Number.isFinite(Number(v)) ? Number(v) : fallback);
const detailOf = (err) => String((err && err.message) || err).slice(0, MAX_DETAIL);
const refuse = (reason, detail) => (detail === undefined ? { ok: false, reason } : { ok: false, reason,
  detail: String(detail).slice(0, MAX_DETAIL) });
const refuseTake = (reason, detail) => ({ ...refuse(reason, detail), permanent: PERMANENT.includes(reason) });
const unavailable = (detail) => refuse(REASONS.UNAVAILABLE, detail);

const takeReceiptKey = (raidId, itemId) => `${RECEIPT_PREFIX}${raidId}:${itemId}`;
const fingerprintOf = (spec) => ({ raidId: spec.raidId, itemId: spec.itemId, typeId: spec.typeId, units: spec.units });

function checkSeamsFrom(vendor) {
  try {
    if (!isObj(vendor)) return unavailable("vendor");
    for (const key of Object.keys(PATHS)) {
      const mod = vendor[key];
      if (!isObj(mod)) return unavailable(PATHS[key]);
      for (const name of REQUIRED[key]) if (typeof mod[name] !== "function") return unavailable(`${PATHS[key]}.${name}`);
    }
    return { ok: true };
  } catch (err) {
    return unavailable(detailOf(err));
  }
}

const unitsOf = (row) => (num(row.singleton) === 1 ? 1 : Math.max(0, Math.trunc(num(row.stacksize ?? row.quantity))));

function typeFactsOf(vendor, typeId) {
  const meta = vendor.types.resolveItemByTypeID(typeId);
  return { groupId: isObj(meta) ? Math.trunc(num(meta.groupID)) : 0,
    unitVolume: isObj(meta) ? Math.max(0, num(meta.volume)) : 0 };
}

function readMetenoxBayFrom(vendor, structureId, opts) {
  const maxLines = opts && opts.maxLines;
  if (!isId(structureId)) return refuse(REASONS.INVALID_INPUT, "structureId");
  if (!Number.isSafeInteger(maxLines) || maxLines < 0) return refuse(REASONS.INVALID_INPUT, "maxLines");
  const check = checkSeamsFrom(vendor);
  if (!check.ok) return check;
  try {
    const row = vendor.state.getStructureByID(structureId, { refresh: false });
    if (!isObj(row)) return refuse(REASONS.NOT_FOUND);
    const typeId = Math.trunc(num(row.typeID));
    if (typeId !== METENOX_TYPE_ID) return refuse(REASONS.NOT_METENOX, String(typeId));
    const structure = Object.freeze({ structureId, systemId: Math.trunc(num(row.solarSystemID)), typeId,
      ownerCorpId: Math.trunc(num(row.ownerCorpID)), destroyed: timeOrNull(row.destroyedAt) !== null });
    if (maxLines === 0) return { ok: true, structure, lines: [], truncated: false };
    const rows = vendor.itemStore.listContainerItems(null, structureId, FLAG_MOON_MATERIAL_BAY);
    const lines = [];
    for (const item of Array.isArray(rows) ? rows : []) {
      if (!isObj(item)) continue;
      const itemId = Math.trunc(num(item.itemID));
      const itemTypeId = Math.trunc(num(item.typeID));
      if (!isId(itemId) || !isId(itemTypeId)) continue;
      const facts = typeFactsOf(vendor, itemTypeId);
      lines.push(Object.freeze({ itemId, typeId: itemTypeId, units: unitsOf(item), unitVolume: facts.unitVolume,
        flagId: Math.trunc(num(item.flagID)), groupId: facts.groupId, ownerId: Math.trunc(num(item.ownerID)) }));
    }
    lines.sort((a, b) => a.itemId - b.itemId);
    const truncated = lines.length > maxLines;
    return { ok: true, structure, lines: truncated ? lines.slice(0, maxLines) : lines, truncated };
  } catch (err) {
    return refuse(REASONS.SEAM_ERROR, detailOf(err));
  }
}

function validTake(s) {
  return isObj(s) && typeof s.raidId === "string" && s.raidId !== "" && isId(s.itemId) && isId(s.typeId)
    && isId(s.units) && isId(s.structureId) && isId(s.ownerCorpId);
}

function takeMetenoxLineFrom(vendor, spec) {
  if (!validTake(spec)) return refuseTake(REASONS.INVALID_INPUT, "spec");
  const check = checkSeamsFrom(vendor);
  if (!check.ok) return { ...check, permanent: false };
  try {
    const I = vendor.itemStore;
    const receiptKey = takeReceiptKey(spec.raidId, spec.itemId);
    const fingerprint = fingerprintOf(spec);
    const volumeM3 = spec.units * typeFactsOf(vendor, spec.typeId).unitVolume;
    const prior = I.getIdempotentGrantReceipt(receiptKey, RECEIPT_READ);
    if (!isObj(prior) || prior.success !== true) {
      return refuseTake(String((prior && prior.errorMsg) || "RECEIPT_READ_FAILED"),
        prior && prior.ambiguous === true ? "ambiguous" : undefined);
    }
    if (prior.found === true) {
      const fp = isObj(prior.data) ? prior.data.fingerprint : null;
      if (!isObj(fp) || fp.raidId !== fingerprint.raidId || fp.itemId !== fingerprint.itemId
        || fp.typeId !== fingerprint.typeId || fp.units !== fingerprint.units) {
        return refuseTake(REASONS.RECEIPT_MISMATCH);
      }
      return { ok: true, units: spec.units, duplicate: true, volumeM3 };
    }
    const item = I.findItemById(spec.itemId);
    if (!isObj(item)) return refuseTake(REASONS.ITEM_NOT_FOUND);
    const groupId = typeFactsOf(vendor, Math.trunc(num(item.typeID))).groupId;
    if (Math.trunc(num(item.locationID)) !== spec.structureId || Math.trunc(num(item.flagID)) !== FLAG_MOON_MATERIAL_BAY
      || Math.trunc(num(item.ownerID)) !== spec.ownerCorpId || Math.trunc(num(item.typeID)) !== spec.typeId
      || groupId !== GROUP_MOON_MATERIAL) {
      return refuseTake(REASONS.WRONG_ITEM);
    }
    const r = I.consumeInventoryItemQuantityIdempotent(spec.itemId, spec.units, { receiptKey, fingerprint });
    if (!isObj(r) || r.success !== true) {
      return refuseTake(String((r && r.errorMsg) || "CONSUME_FAILED"), r && r.ambiguous === true ? "ambiguous"
        : undefined);
    }
    return { ok: true, units: spec.units, duplicate: r.duplicate === true, volumeM3 };
  } catch (err) {
    return refuseTake(REASONS.SEAM_ERROR, detailOf(err));
  }
}

function readTakeReceiptFrom(vendor, spec) {
  if (!isObj(spec) || typeof spec.raidId !== "string" || spec.raidId === "" || !isId(spec.itemId)) {
    return refuse(REASONS.INVALID_INPUT, "spec");
  }
  const check = checkSeamsFrom(vendor);
  if (!check.ok) return check;
  try {
    const r = vendor.itemStore.getIdempotentGrantReceipt(takeReceiptKey(spec.raidId, spec.itemId), RECEIPT_READ);
    if (!isObj(r) || r.success !== true) return refuse(String((r && r.errorMsg) || "RECEIPT_READ_FAILED"));
    return { ok: true, found: r.found === true };
  } catch (err) {
    return refuse(REASONS.SEAM_ERROR, detailOf(err));
  }
}

const MAX_TYPE_NAMES = 32;
const MAX_TYPE_NAME_CHARS = 48;

function readTypeNamesFrom(vendor, spec) {
  const ids = isObj(spec) ? spec.typeIds : null;
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > MAX_TYPE_NAMES || !ids.every(isId)
    || new Set(ids).size !== ids.length) return refuse(REASONS.INVALID_INPUT, "typeIds");
  try {
    if (!isObj(vendor) || !isObj(vendor.types) || typeof vendor.types.resolveItemByTypeID !== "function") {
      return unavailable(`${PATHS.types}.resolveItemByTypeID`);
    }
    const names = new Map();
    for (const typeId of ids) {
      const meta = vendor.types.resolveItemByTypeID(typeId);
      if (!isObj(meta) || typeof meta.name !== "string") continue;
      const name = meta.name.replace(/\s+/g, " ").replace(/[^\x20-\x7E]/g, "").trim().slice(0, MAX_TYPE_NAME_CHARS)
        .trim();
      if (name !== "") names.set(typeId, name);
    }
    return { ok: true, names };
  } catch (err) {
    return refuse(REASONS.SEAM_ERROR, detailOf(err));
  }
}

function createHarvestBaySeam(deps) {
  let vendor = null;

  function load() {
    let off = null;
    try {
      off = deps && typeof deps.disabledReason === "function" ? deps.disabledReason(CONSUMER) : null;
    } catch (err) {
      off = detailOf(err);
    }
    if (off) return unavailable(String(off).slice(0, MAX_DETAIL));
    if (vendor !== null) return { ok: true };
    const requireGame = deps && deps.requireGame;
    if (typeof requireGame !== "function") return unavailable("requireGame");
    const loaded = {};
    for (const key of Object.keys(PATHS)) {
      let r;
      try {
        r = requireGame(PATHS[key]);
      } catch (err) {
        return unavailable(`${PATHS[key]}: ${detailOf(err)}`.slice(0, MAX_DETAIL));
      }
      if (!r || r.ok !== true || !isObj(r.exports)) {
        return unavailable(`${PATHS[key]}: ${String((r && r.reason) || "not loaded")}`.slice(0, MAX_DETAIL));
      }
      loaded[key] = r.exports;
    }
    vendor = Object.freeze(loaded);
    return { ok: true };
  }

  const withVendor = (fn, permanentKey) => (...args) => {
    const l = load();
    if (l.ok) return fn(...args);
    return permanentKey ? { ...l, permanent: false } : l;
  };

  return Object.freeze({
    checkSeams: withVendor(() => checkSeamsFrom(vendor)),
    readMetenoxBay: withVendor((structureId, opts) => readMetenoxBayFrom(vendor, structureId, opts)),
    takeMetenoxLine: withVendor((spec) => takeMetenoxLineFrom(vendor, spec), true),
    readTakeReceipt: withVendor((spec) => readTakeReceiptFrom(vendor, spec)),
    readTypeNames: withVendor((spec) => readTypeNamesFrom(vendor, spec)),
  });
}

const SEAM_METHODS = Object.freeze(["checkSeams", "readMetenoxBay", "takeMetenoxLine", "readTakeReceipt",
  "readTypeNames"]);

module.exports = { PATHS, REQUIRED, REASONS, CONSUMER, SEAM_METHODS, METENOX_TYPE_ID, FLAG_MOON_MATERIAL_BAY,
  GROUP_MOON_MATERIAL, MAX_TYPE_NAMES, takeReceiptKey, checkSeamsFrom, readMetenoxBayFrom, takeMetenoxLineFrom,
  readTakeReceiptFrom, readTypeNamesFrom, createHarvestBaySeam };
