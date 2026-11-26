"use strict";

const { isSized, holdTake, round6 } = require("../core/miningTask");

const SHIP_CATEGORY_ID = 6;

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

function createRealCargo(input) {
  const deps = input.deps;
  const config = input.config || {};
  const usedVolume = input.usedVolume;

  function left(hold) {
    return isSized(hold) ? toNum(hold.usedM3, 0) : 0;
  }

  function bayShip(id, owner, hostShipId) {
    if (!(id > 0)) return null;
    let item;
    try {
      item = deps.findItemById(id);
    } catch (_err) {
      item = null;
    }
    if (!isObj(item) || toInt(item.ownerID, 0) !== owner || toInt(item.categoryID, 0) !== SHIP_CATEGORY_ID
      || toInt(item.singleton, 0) !== 1 || toInt(item.locationID, 0) !== hostShipId
      || toInt(item.flagID, -1) !== deps.SHIP_HANGAR) return null;
    return item;
  }

  function capacityOf(rs, flag) {
    return flag === deps.CARGO_HOLD ? toNum(rs && rs.cargoCapacity, 0)
      : toNum(deps.getShipHoldCapacityByFlag(rs, flag), 0);
  }

  function flagsOf(rs, typeID) {
    const flags = [];
    const preferred = toInt(deps.getPreferredMiningHoldFlagForType(rs, typeID), 0);
    if (preferred > 0 && deps.isItemTypeAllowedInHoldFlag(typeID, preferred)) flags.push(preferred);
    if (config.miningRealCargoUseCargoHold === true && !flags.includes(deps.CARGO_HOLD)) flags.push(deps.CARGO_HOLD);
    return flags;
  }

  function fillTarget(hold, owner, item, out, changes) {
    const id = toInt(item.itemID, 0);
    let rs;
    try {
      rs = deps.buildShipResourceState(owner, item);
    } catch (_err) {
      return 0;
    }
    let moved = 0;
    for (const typeID of [...hold.items.keys()].sort((a, b) => a - b)) {
      const unit = toNum(hold.unitM3ByType.get(typeID), 0);
      const holdFlag = hold.flagByType.get(typeID);
      if (!(unit > 0) || !(holdFlag > 0)) continue;
      let flags;
      try {
        flags = flagsOf(rs, typeID);
      } catch (_err) {
        flags = [];
      }
      for (const flag of flags) {
        const have = hold.items.get(typeID) || 0;
        if (have <= 0) break;
        let free;
        try {
          free = capacityOf(rs, flag) - toNum(usedVolume(id, flag), 0);
        } catch (_err) {
          continue;
        }
        const qty = Math.min(have, Math.floor(round6(free / unit)));
        if (!(qty > 0)) continue;
        let granted;
        try {
          granted = deps.grantItemsToCharacterLocation(owner, id, flag, [{ itemType: typeID, quantity: qty }]);
        } catch (_err) {
          holdTake(hold, holdFlag, typeID, qty, unit);
          out.grantThrew += 1;
          break;
        }
        if (!isObj(granted) || granted.success !== true) {
          out.grantFailed += 1;
          break;
        }
        const taken = holdTake(hold, holdFlag, typeID, qty, unit);
        moved = round6(moved + (taken.ok ? taken.m3 : 0));
        if (isObj(granted.data) && Array.isArray(granted.data.changes)) changes.push(...granted.data.changes);
      }
    }
    return moved;
  }

  function deposit(hold, opts) {
    const owner = toInt(opts && opts.ownerCharacterId, 0);
    const hostShipId = toInt(opts && opts.hostShipId, 0);
    const ownId = toInt(opts && opts.shipItemId, 0);
    const storeId = toInt(opts && opts.storeShipItemId, 0);
    if (!isSized(hold)) return { ok: false, reason: "NOT_SIZED", movedM3: 0, leftM3: 0, storeInvalid: false };
    if (hold.items.size === 0) return { ok: false, reason: "EMPTY", movedM3: 0, leftM3: left(hold), storeInvalid: false };
    const own = owner > 0 && hostShipId > 0 ? bayShip(ownId, owner, hostShipId) : null;
    let store = null;
    let storeInvalid = false;
    if (storeId > 0 && storeId !== ownId) {
      store = owner > 0 && hostShipId > 0 ? bayShip(storeId, owner, hostShipId) : null;
      storeInvalid = store === null;
    }
    if (!own && !store) return { ok: false, reason: "TARGET_INVALID", movedM3: 0, leftM3: left(hold), storeInvalid };
    const out = { grantFailed: 0, grantThrew: 0 };
    const changes = [];
    const ownM3 = own ? fillTarget(hold, owner, own, out, changes) : 0;
    const storeM3 = store && hold.items.size > 0 ? fillTarget(hold, owner, store, out, changes) : 0;
    if (changes.length > 0 && typeof deps.emit === "function") {
      try {
        deps.emit(owner, changes);
      } catch (_err) {
      }
    }
    return { ok: true, movedM3: round6(ownM3 + storeM3), leftM3: left(hold), ownM3, storeM3,
      grantFailed: out.grantFailed, grantThrew: out.grantThrew, storeInvalid };
  }

  return Object.freeze({ deposit });
}

module.exports = { SHIP_CATEGORY_ID, createRealCargo };
