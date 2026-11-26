"use strict";

const UNAVAILABLE = "SENTRY_FACTION_UNAVAILABLE";
const SCENE_LOADED = "SENTRY_SCENE_LOADED";
const MAX_DETAIL = 120;
const FLAG_SPACE = 0;
const FLAG_CHARGES = 27;
const LASER_GROUP = 430;
const PERMILLE = 1000;
const PERMANENT_GRANT = Object.freeze(["IDEMPOTENCY_RECEIPT_MISMATCH", "ITEM_TYPE_NOT_FOUND",
  "ITEM_QUANTITY_OUT_OF_RANGE", "INVALID_GRANT_DESTINATION", "INVALID_IDEMPOTENCY_KEY", "OWNER_NOT_FOUND"]);

const FACTION_PATHS = Object.freeze({
  itemStore: "services/inventory/itemStore",
  inventory: "services/starbase/starbaseInventoryRuntime",
  types: "services/inventory/itemTypeRegistry",
  fitting: "services/fitting/liveFittingState",
  runtime: "space/runtime",
});
const FACTION_REQUIRED = Object.freeze({
  itemStore: Object.freeze(["findItemById", "grantItemToOwnerLocationIdempotent", "getIdempotentGrantReceipt",
    "updateInventoryItem", "listContainerItems"]),
  inventory: Object.freeze(["getBatteryAmmoCapacity"]),
  types: Object.freeze(["resolveItemByTypeID"]),
  fitting: Object.freeze(["isChargeCompatibleWithModule"]),
  runtime: Object.freeze(["isSolarSystemSceneLoaded", "spawnDynamicInventoryEntity"]),
});

const isObj = (v) => v !== null && typeof v === "object";
const isId = (v) => Number.isSafeInteger(v) && v > 0;
const num = (v, fallback = 0) => (Number.isFinite(Number(v)) ? Number(v) : fallback);
const detailOf = (err) => String((err && err.message) || err).slice(0, MAX_DETAIL);
const refuse = (reason, permanent, detail) => (detail === undefined ? { ok: false, reason, permanent }
  : { ok: false, reason, permanent, detail: String(detail).slice(0, MAX_DETAIL) });

const DEPLOY_PREFIX = "lne-sentry:";
const AMMO_PREFIX = "lne-sentry-ammo:";
const deployReceipt = (sentryId) => `${DEPLOY_PREFIX}${sentryId}`;
const ammoReceipt = (sentryId, n) => `${AMMO_PREFIX}${sentryId}:${n}`;

function checkFactionFrom(vendor) {
  try {
    if (!isObj(vendor)) return refuse(UNAVAILABLE, false, "vendor");
    for (const key of Object.keys(FACTION_REQUIRED)) {
      const mod = vendor[key];
      if (!isObj(mod) && typeof mod !== "function") return refuse(UNAVAILABLE, false, FACTION_PATHS[key]);
      for (const name of FACTION_REQUIRED[key]) {
        if (typeof mod[name] !== "function") return refuse(UNAVAILABLE, false, `${FACTION_PATHS[key]}.${name}`);
      }
    }
    return { ok: true };
  } catch (err) {
    return refuse(UNAVAILABLE, false, detailOf(err));
  }
}

function grantedIds(r) {
  const d = isObj(r) && isObj(r.data) ? r.data : {};
  if (Array.isArray(d.itemIDs) && d.itemIDs.length > 0) return d.itemIDs.map((v) => Math.trunc(num(v))).filter(isId);
  return (Array.isArray(d.items) ? d.items : []).map((i) => Math.trunc(num(i && i.itemID))).filter(isId);
}

function grantRefusal(r) {
  const reason = String((r && r.errorMsg) || "GRANT_FAILED");
  return refuse(reason, PERMANENT_GRANT.includes(reason), r && r.ambiguous === true ? "ambiguous" : undefined);
}

const unitsOf = (row) => (num(row.singleton) === 1 ? 1 : Math.max(0, Math.trunc(num(row.stacksize ?? row.quantity))));

function capacityUnitsOf(vendor, item, chargeTypeId) {
  if (Math.trunc(num(item.groupID)) === LASER_GROUP) return 1;
  const capacity = num(vendor.inventory.getBatteryAmmoCapacity(item, FLAG_CHARGES));
  const meta = vendor.types.resolveItemByTypeID(chargeTypeId);
  const volume = isObj(meta) ? num(meta.volume) : 0;
  return capacity > 0 && volume > 0 ? Math.floor(capacity / volume + 1e-9) : 0;
}

function chargesOf(vendor, itemId) {
  const rows = vendor.itemStore.listContainerItems(null, itemId, FLAG_CHARGES);
  return (Array.isArray(rows) ? rows : []).filter(isObj).reduce((n, row) => n + unitsOf(row), 0);
}

function checkFactionAmmoFrom(vendor, pairs) {
  const check = checkFactionFrom(vendor);
  if (!check.ok) return check;
  try {
    const incompatible = [];
    for (const p of Array.isArray(pairs) ? pairs : []) {
      if (!isObj(p) || vendor.fitting.isChargeCompatibleWithModule(p.typeId, p.chargeTypeId) !== true) {
        incompatible.push(isObj(p) ? p.typeId : 0);
      }
    }
    return { ok: true, incompatible };
  } catch (err) {
    return refuse("SEAM_ERROR", false, detailOf(err));
  }
}

function deployFactionSentryFrom(vendor, spec) {
  const s = isObj(spec) ? spec : {};
  const pos = isObj(s.position) ? { x: num(s.position.x), y: num(s.position.y), z: num(s.position.z) } : null;
  if (typeof s.sentryId !== "string" || s.sentryId === "" || !isId(s.ownerCorpId) || !isId(s.systemId)
    || !isId(s.typeId) || pos === null) return refuse("INVALID_INPUT", true);
  const check = checkFactionFrom(vendor);
  if (!check.ok) return check;
  try {
    const S = vendor.itemStore;
    const g = S.grantItemToOwnerLocationIdempotent(s.ownerCorpId, s.systemId, FLAG_SPACE, s.typeId, 1,
      { receiptKey: deployReceipt(s.sentryId), singleton: 1 });
    if (!isObj(g) || g.success !== true) return grantRefusal(g);
    const itemId = grantedIds(g)[0];
    if (!isId(itemId)) return refuse("GRANT_NO_ITEM", true);
    const duplicate = g.duplicate === true;
    const u = S.updateInventoryItem(itemId, (cur) => ({ ...cur, ownerID: s.ownerCorpId, locationID: s.systemId,
      flagID: FLAG_SPACE, singleton: 1,
      spaceState: { ...(isObj(cur.spaceState) ? cur.spaceState : {}), systemID: s.systemId, position: pos,
        velocity: { x: 0, y: 0, z: 0 }, direction: { x: 1, y: 0, z: 0 }, mode: "STOP", corporationID: s.ownerCorpId,
        anchorState: "anchored", isAnchored: true, onlineState: "online", online: 1 } }));
    if (!isObj(u) || u.success !== true) {
      const reason = String((u && u.errorMsg) || "ITEM_UPDATE_FAILED");
      return refuse(reason, reason === "ITEM_NOT_FOUND" || reason === "INVALID_ITEM_STATE");
    }
    let ammoUnits = 0;
    if (isObj(s.ammo) && isId(s.ammo.typeId) && isId(s.ammo.units)) {
      const item = S.findItemById(itemId);
      const cap = isObj(item) ? capacityUnitsOf(vendor, item, s.ammo.typeId) : 0;
      const units = Math.min(s.ammo.units, cap);
      if (units > 0) {
        const a = S.grantItemToOwnerLocationIdempotent(s.ownerCorpId, itemId, FLAG_CHARGES, s.ammo.typeId, units,
          { receiptKey: ammoReceipt(s.sentryId, 0) });
        if (!isObj(a) || a.success !== true) return grantRefusal(a);
        ammoUnits = units;
      }
    }
    let spawned = false;
    let spawnFailed = false;
    if (vendor.runtime.isSolarSystemSceneLoaded(s.systemId) === true) {
      const sp = vendor.runtime.spawnDynamicInventoryEntity(s.systemId, itemId, { broadcast: true });
      spawned = isObj(sp) && sp.success === true;
      spawnFailed = !spawned;
    }
    return { ok: true, itemId, duplicate, ammoUnits, spawned, spawnFailed };
  } catch (err) {
    return refuse("SEAM_ERROR", false, detailOf(err));
  }
}

function readAmmoFrom(vendor, itemId, chargeTypeId) {
  if (!isId(itemId) || !isId(chargeTypeId)) return refuse("INVALID_INPUT", true);
  const check = checkFactionFrom(vendor);
  if (!check.ok) return check;
  try {
    const item = vendor.itemStore.findItemById(itemId);
    if (!isObj(item)) return refuse("NOT_FOUND", true);
    return { ok: true, units: chargesOf(vendor, itemId), capacityUnits: capacityUnitsOf(vendor, item, chargeTypeId) };
  } catch (err) {
    return refuse("SEAM_ERROR", false, detailOf(err));
  }
}

function topUpAmmoFrom(vendor, spec) {
  const s = isObj(spec) ? spec : {};
  if (typeof s.sentryId !== "string" || s.sentryId === "" || !Number.isSafeInteger(s.n) || s.n < 0
    || !isId(s.ownerCorpId) || !isId(s.itemId) || !isId(s.systemId) || !isObj(s.ammo) || !isId(s.ammo.typeId)
    || !Number.isSafeInteger(s.belowPermille)) return refuse("INVALID_INPUT", true);
  const check = checkFactionFrom(vendor);
  if (!check.ok) return check;
  try {
    const S = vendor.itemStore;
    const key = ammoReceipt(s.sentryId, s.n);
    const prior = S.getIdempotentGrantReceipt(key, { requireDurable: true });
    if (!isObj(prior) || prior.success !== true) return refuse(String((prior && prior.errorMsg) || "RECEIPT_READ_FAILED"),
      false);
    if (prior.found === true || isObj(prior.data)) return { ok: true, granted: 0, duplicate: true };
    if (vendor.runtime.isSolarSystemSceneLoaded(s.systemId) === true) return refuse(SCENE_LOADED, false);
    const item = S.findItemById(s.itemId);
    if (!isObj(item)) return refuse("NOT_FOUND", true);
    const cap = capacityUnitsOf(vendor, item, s.ammo.typeId);
    const have = chargesOf(vendor, s.itemId);
    if (cap <= 0 || have * PERMILLE >= cap * s.belowPermille || have >= cap) return { ok: true, skipped: "FULL" };
    const a = S.grantItemToOwnerLocationIdempotent(s.ownerCorpId, s.itemId, FLAG_CHARGES, s.ammo.typeId, cap - have,
      { receiptKey: key });
    if (!isObj(a) || a.success !== true) return grantRefusal(a);
    return { ok: true, granted: cap - have, duplicate: a.duplicate === true };
  } catch (err) {
    return refuse("SEAM_ERROR", false, detailOf(err));
  }
}

function sentryIdOfReceipt(key) {
  if (typeof key !== "string") return null;
  if (key.startsWith(DEPLOY_PREFIX)) return key.length > DEPLOY_PREFIX.length ? key.slice(DEPLOY_PREFIX.length) : null;
  if (!key.startsWith(AMMO_PREFIX)) return null;
  const rest = key.slice(AMMO_PREFIX.length);
  const cut = rest.lastIndexOf(":");
  return cut > 0 && /^\d+$/.test(rest.slice(cut + 1)) ? rest.slice(0, cut) : null;
}

function pruneReceiptsFrom(vendor, isDead, maxRemove) {
  if (typeof isDead !== "function" || !isId(maxRemove)) return refuse("INVALID_INPUT", true);
  const check = checkFactionFrom(vendor);
  if (!check.ok) return check;
  try {
    const S = vendor.itemStore;
    if (typeof S.pruneIdempotentGrantReceipts !== "function") {
      return refuse(UNAVAILABLE, false, `${FACTION_PATHS.itemStore}.pruneIdempotentGrantReceipts`);
    }
    const verdicts = new Map();
    let taken = 0;
    let capped = false;
    const out = S.pruneIdempotentGrantReceipts((receipt) => {
      const id = sentryIdOfReceipt(isObj(receipt) ? receipt.receiptKey : null);
      if (id === null || capped) return false;
      if (!verdicts.has(id)) verdicts.set(id, isDead(id) === true);
      if (verdicts.get(id) !== true) return false;
      if (taken >= maxRemove) {
        capped = true;
        return false;
      }
      taken += 1;
      return true;
    });
    if (!isObj(out) || out.success !== true) return refuse(String((out && out.errorMsg) || "PRUNE_FAILED"), false);
    return { ok: true, removed: Math.max(0, Math.trunc(num(out.removed))), capped };
  } catch (err) {
    return refuse("SEAM_ERROR", false, detailOf(err));
  }
}

module.exports = {
  UNAVAILABLE,
  FACTION_PATHS,
  FACTION_REQUIRED,
  FLAG_CHARGES,
  SCENE_LOADED,
  deployReceipt,
  ammoReceipt,
  checkFactionFrom,
  checkFactionAmmoFrom,
  deployFactionSentryFrom,
  readAmmoFrom,
  topUpAmmoFrom,
  sentryIdOfReceipt,
  pruneReceiptsFrom,
};
