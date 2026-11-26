"use strict";

const { round6 } = require("../core/miningTask");

const SHIP_CATEGORY_ID = 6;

const ACCESS_MODULES = Object.freeze({
  itemStore: "services/inventory/itemStore",
  liveFittingState: "services/fitting/liveFittingState",
  miningInventory: "services/mining/miningInventory",
  fleetHangarInventory: "services/inventory/fleetHangarInventory",
});

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

function refuse(reason, detail) {
  return detail === undefined ? { ok: false, reason } : { ok: false, reason, detail };
}

function createCargoAccess(input) {
  const deps = input.deps;
  const config = input.config || {};
  const miningFlags = (Array.isArray(deps.MINING_FLAGS) ? deps.MINING_FLAGS : []).map((f) => toInt(f, 0))
    .filter((f) => f > 0 && f !== deps.CARGO_HOLD && f !== deps.FLEET_HANGAR);

  function find(id) {
    if (!(id > 0)) return null;
    try {
      const item = deps.findItemById(id);
      return isObj(item) ? item : null;
    } catch (_err) {
      return null;
    }
  }

  function hostOf(owner, hostShipId) {
    const host = owner > 0 ? find(hostShipId) : null;
    if (!host || toInt(host.ownerID, 0) !== owner || toInt(host.categoryID, 0) !== SHIP_CATEGORY_ID) return null;
    return host;
  }

  function isBayShip(item, owner, hostShipId) {
    return isObj(item) && toInt(item.ownerID, 0) === owner && toInt(item.categoryID, 0) === SHIP_CATEGORY_ID
      && toInt(item.singleton, 0) === 1 && toInt(item.locationID, 0) === hostShipId
      && toInt(item.flagID, -1) === deps.SHIP_HANGAR;
  }

  function placeOf(id, owner, host) {
    const hostShipId = toInt(host.itemID, 0);
    if (id === hostShipId) return { item: host, isHost: true };
    const item = find(id);
    return isBayShip(item, owner, hostShipId) ? { item, isHost: false } : null;
  }

  function resourceOf(owner, item) {
    try {
      return deps.buildShipResourceState(owner, item);
    } catch (_err) {
      return null;
    }
  }

  function holdsOf(rs, isHost) {
    const out = [];
    for (const flag of miningFlags) {
      const capacity = toNum(deps.getShipHoldCapacityByFlag(rs, flag), 0);
      if (capacity > 0) out.push({ flag, kind: "mining", capacity });
    }
    out.push({ flag: deps.CARGO_HOLD, kind: "cargo", capacity: toNum(rs && rs.cargoCapacity, 0) });
    if (isHost) {
      const capacity = toNum(deps.getFleetHangarCapacity(rs), 0);
      if (capacity > 0) out.push({ flag: deps.FLEET_HANGAR, kind: "fleet", capacity });
    }
    return out;
  }

  function unitsOf(item) {
    return toInt(item.singleton, 0) === 1 ? 1 : Math.max(0, toInt(item.stacksize ?? item.quantity, 0));
  }

  function contents(locationId, flag) {
    try {
      const list = deps.listContainerItems(null, locationId, flag);
      return Array.isArray(list) ? list.filter(isObj) : [];
    } catch (_err) {
      return [];
    }
  }

  function unitVolumeOf(item) {
    if (typeof deps.getInventoryItemUnitVolume === "function") {
      try {
        const v = Number(deps.getInventoryItemUnitVolume(item));
        if (Number.isFinite(v)) return Math.max(0, v);
      } catch (_err) {
      }
    }
    return Math.max(0, toNum(item.volume, 0));
  }

  function usedOf(list) {
    let used = 0;
    for (const item of list) used += unitVolumeOf(item) * unitsOf(item);
    return round6(used);
  }

  function nameOf(item) {
    return typeof item.itemName === "string" && item.itemName !== "" ? item.itemName : `type ${toInt(item.typeID, 0)}`;
  }

  function listBayCargo(ownerCharacterId, hostShipId, firstShipItemId) {
    const owner = toInt(ownerCharacterId, 0);
    const host = hostOf(owner, toInt(hostShipId, 0));
    if (!host) return refuse("HOST_INVALID");
    const hostId = toInt(host.itemID, 0);
    let bay = [];
    try {
      bay = (deps.listContainerItems(owner, hostId, deps.SHIP_HANGAR) || [])
        .filter((item) => isBayShip(item, owner, hostId))
        .sort((a, b) => toInt(a.itemID, 0) - toInt(b.itemID, 0));
    } catch (_err) {
      bay = [];
    }
    let room = Math.max(1, toInt(config.cargoListMaxRows, 1));
    let truncated = 0;
    const ships = [];
    const places = [[host, true], ...bay.map((s) => [s, false])];
    const first = toInt(firstShipItemId, 0);
    const ordered = first > 0 ? [...places].sort((a, b) => Number(toInt(b[0].itemID, 0) === first)
      - Number(toInt(a[0].itemID, 0) === first)) : places;
    for (const [item, isHost] of ordered) {
      const shipItemId = toInt(item.itemID, 0);
      const rs = resourceOf(owner, item);
      const holds = [];
      let shipTruncated = 0;
      for (const hold of rs ? holdsOf(rs, isHost) : []) {
        const list = contents(shipItemId, hold.flag);
        const mine = list.filter((i) => toInt(i.ownerID, 0) === owner)
          .sort((a, b) => toInt(a.itemID, 0) - toInt(b.itemID, 0));
        if (!(hold.capacity > 0) && mine.length === 0) continue;
        const items = [];
        for (const i of mine) {
          if (room <= 0) {
            truncated += 1;
            shipTruncated += 1;
            continue;
          }
          room -= 1;
          const qty = unitsOf(i);
          items.push({ itemId: toInt(i.itemID, 0), typeId: toInt(i.typeID, 0), name: nameOf(i), qty,
            m3: round6(unitVolumeOf(i) * qty) });
        }
        holds.push({ flag: hold.flag, kind: hold.kind, capacityM3: round6(hold.capacity), usedM3: usedOf(list),
          items });
      }
      ships.push({ shipItemId, typeId: toInt(item.typeID, 0), name: nameOf(item), host: isHost, holds,
        truncated: shipTruncated });
    }
    if (ordered !== places) {
      const at = new Map(places.map(([item], i) => [toInt(item.itemID, 0), i]));
      ships.sort((a, b) => at.get(a.shipItemId) - at.get(b.shipItemId));
    }
    return { ok: true, hostShipId: hostId, ships, truncated };
  }

  function targetFlags(rs, isHost, typeID, toFlag) {
    const holds = holdsOf(rs, isHost);
    const takes = (hold) => hold.kind !== "mining" || deps.isItemTypeAllowedInHoldFlag(typeID, hold.flag) === true;
    if (toFlag === null || toFlag === undefined) {
      const list = holds.filter((h) => h.capacity > 0 && takes(h));
      return list.length > 0 ? { ok: true, holds: list } : refuse("TYPE_NOT_ALLOWED");
    }
    const hold = holds.find((h) => h.flag === toInt(toFlag, 0) && h.capacity > 0);
    if (!hold) return refuse("FLAG_INVALID");
    return takes(hold) ? { ok: true, holds: [hold] } : refuse("TYPE_NOT_ALLOWED");
  }

  function moveStep(itemId, toId, flag, quantity) {
    let moved;
    try {
      moved = deps.moveItemToLocation(itemId, toId, flag, quantity);
    } catch (err) {
      return refuse("MOVE_FAILED", String((err && err.message) || err));
    }
    if (!isObj(moved) || moved.success !== true) {
      return refuse("MOVE_FAILED", String((moved && moved.errorMsg) || "unknown"));
    }
    return { ok: true, changes: isObj(moved.data) && Array.isArray(moved.data.changes) ? moved.data.changes : [] };
  }

  function emitChanges(owner, changes) {
    if (changes.length === 0 || typeof deps.emit !== "function") return;
    try {
      deps.emit(owner, changes);
    } catch (_err) {
    }
  }

  function moveCargo(opts) {
    const o = isObj(opts) ? opts : {};
    const owner = toInt(o.ownerCharacterId, 0);
    const host = hostOf(owner, toInt(o.hostShipId, 0));
    if (!host) return refuse("HOST_INVALID");
    const itemId = toInt(o.itemId, 0);
    const item = find(itemId);
    if (!item) return refuse("ITEM_NOT_FOUND");
    if (toInt(item.ownerID, 0) !== owner) return refuse("NOT_OWNER");
    if (toInt(item.categoryID, 0) === SHIP_CATEGORY_ID) return refuse("ITEM_INVALID");
    const source = placeOf(toInt(item.locationID, 0), owner, host);
    const sourceRs = source ? resourceOf(owner, source.item) : null;
    const sourceFlag = toInt(item.flagID, -1);
    if (!source || !sourceRs || !holdsOf(sourceRs, source.isHost).some((h) => h.flag === sourceFlag)) {
      return refuse("SOURCE_INVALID");
    }
    const toId = toInt(o.toLocationId, 0);
    const target = placeOf(toId, owner, host);
    const targetRs = target ? resourceOf(owner, target.item) : null;
    if (!target || !targetRs) return refuse("TARGET_INVALID");
    const locked = typeof o.isLocked === "function" ? o.isLocked : () => false;
    try {
      if (locked(toInt(source.item.itemID, 0)) === true || locked(toId) === true) return refuse("LOST_UNSETTLED");
    } catch (_err) {
      return refuse("LOST_UNSETTLED");
    }
    const typeID = toInt(item.typeID, 0);
    const flags = targetFlags(targetRs, target.isHost, typeID, o.toFlag);
    if (!flags.ok) return flags;
    const sameHold = toId === toInt(item.locationID, 0);
    const holds = flags.holds.filter((h) => !(sameHold && h.flag === sourceFlag));
    if (holds.length === 0) return refuse("SAME_HOLD");
    const available = unitsOf(item);
    const wanted = o.quantity === null || o.quantity === undefined ? available : toInt(o.quantity, 0);
    if (!(wanted >= 1) || wanted > available || (toInt(item.singleton, 0) === 1 && wanted !== 1)) {
      return refuse("QUANTITY_INVALID");
    }
    const unit = unitVolumeOf(item);
    const changes = [];
    const used = [];
    let left = wanted;
    let atSource = available;
    let failure = null;
    for (const hold of holds) {
      if (left <= 0) break;
      const free = hold.capacity - usedOf(contents(toId, hold.flag));
      const fit = unit > 0 ? Math.floor(round6(free / unit)) : left;
      const qty = Math.min(left, fit);
      if (!(qty > 0)) continue;
      const step = moveStep(itemId, toId, hold.flag, qty === atSource ? null : qty);
      if (!step.ok) {
        failure = step;
        break;
      }
      left -= qty;
      atSource -= qty;
      used.push(hold.flag);
      changes.push(...step.changes);
    }
    emitChanges(owner, changes);
    const movedQty = wanted - left;
    if (movedQty <= 0) return failure || refuse("NO_ROOM");
    const out = { ok: true, itemId, typeId: typeID, name: nameOf(item), movedQty, movedM3: round6(movedQty * unit),
      leftQty: left, flags: used, changes };
    if (failure) {
      out.stopReason = failure.reason;
      out.stopDetail = failure.detail;
    }
    return out;
  }

  function unloadForStow(opts) {
    const o = isObj(opts) ? opts : {};
    if (typeof deps.validateBayContents !== "function") return refuse("UNAVAILABLE");
    const owner = toInt(o.ownerCharacterId, 0);
    const host = hostOf(owner, toInt(o.hostShipId, 0));
    if (!host) return refuse("HOST_INVALID");
    const hostId = toInt(host.itemID, 0);
    const shipItemId = toInt(o.shipItemId, 0);
    const ship = shipItemId !== hostId ? find(shipItemId) : null;
    if (!ship || toInt(ship.ownerID, 0) !== owner || toInt(ship.categoryID, 0) !== SHIP_CATEGORY_ID
      || toInt(ship.singleton, 0) !== 1 || toInt(ship.flagID, -1) !== 0
      || toInt(ship.locationID, 0) !== toInt(host.locationID, -1)) {
      return refuse("SHIP_INVALID");
    }
    const name = nameOf(ship);
    const fail = (reason, extra) => ({ ok: false, name, reason, ...(extra || {}) });
    let all;
    let verdict;
    try {
      const list = deps.listContainerItems(null, shipItemId);
      all = Array.isArray(list) ? list.filter(isObj) : [];
      verdict = deps.validateBayContents(all);
    } catch (err) {
      return fail("VALIDATE_FAILED", { detail: String((err && err.message) || err) });
    }
    if (isObj(verdict) && verdict.success === true) return { ok: true, name, movedStacks: 0, movedM3: 0, changes: [] };
    if (!isObj(verdict) || !Array.isArray(verdict.rejectedItemIDs)) return fail("VALIDATE_FAILED");
    const ids = new Set(verdict.rejectedItemIDs.map((id) => toInt(id, 0)));
    const rejected = all.filter((item) => ids.has(toInt(item.itemID, 0)))
      .sort((a, b) => toInt(a.itemID, 0) - toInt(b.itemID, 0));
    if (rejected.length === 0) return fail("VALIDATE_FAILED", { detail: "no_rejected_item" });
    const locked = typeof o.isLocked === "function" ? o.isLocked : () => false;
    try {
      if (locked(shipItemId) === true || locked(hostId) === true) return fail("LOST_UNSETTLED");
    } catch (_err) {
      return fail("LOST_UNSETTLED");
    }
    const maxStacks = Math.max(1, toInt(o.maxStacks, 1));
    if (rejected.length > maxStacks) return fail("TOO_MANY", { detail: String(maxStacks) });
    const shipRs = resourceOf(owner, ship);
    const hostRs = resourceOf(owner, host);
    if (!shipRs) return fail("SHIP_INVALID");
    if (!hostRs) return fail("HOST_INVALID");
    const sourceFlags = new Set(holdsOf(shipRs, false).map((h) => h.flag));
    for (const item of rejected) {
      const flag = toInt(item.flagID, -1);
      if (toInt(item.ownerID, 0) !== owner || toInt(item.categoryID, 0) === SHIP_CATEGORY_ID
        || !sourceFlags.has(flag)) {
        return fail("UNMOVABLE", { detail: `${toInt(item.itemID, 0)}:${flag}` });
      }
    }
    const targets = holdsOf(hostRs, true).filter((h) => h.kind !== "cargo" && h.capacity > 0);
    const freeAtStart = new Map(targets.map((h) => [h.flag,
      Math.max(0, round6(h.capacity - usedOf(contents(hostId, h.flag))))]));
    const free = new Map(freeAtStart);
    const steps = [];
    const usable = new Set();
    let neededM3 = 0;
    let short = false;
    for (const item of rejected) {
      const itemId = toInt(item.itemID, 0);
      const typeID = toInt(item.typeID, 0);
      const unit = unitVolumeOf(item);
      let left = unitsOf(item);
      let atSource = left;
      neededM3 += unit * left;
      for (const hold of targets) {
        if (hold.kind === "mining" && deps.isItemTypeAllowedInHoldFlag(typeID, hold.flag) !== true) continue;
        usable.add(hold.flag);
        if (left <= 0) continue;
        const room = free.get(hold.flag);
        const fit = unit > 0 ? Math.floor(round6(room / unit)) : left;
        const qty = Math.min(left, fit);
        if (!(qty > 0)) continue;
        steps.push({ itemId, flag: hold.flag, quantity: qty === atSource ? null : qty, m3: unit * qty });
        free.set(hold.flag, round6(room - unit * qty));
        left -= qty;
        atSource -= qty;
      }
      if (left > 0) short = true;
    }
    if (short) {
      let freeM3 = 0;
      for (const flag of usable) freeM3 += freeAtStart.get(flag);
      return fail("NO_ROOM", { neededM3: round6(neededM3), freeM3: round6(freeM3) });
    }
    const changes = [];
    const moved = new Set();
    let movedM3 = 0;
    let failure = null;
    for (const step of steps) {
      const done = moveStep(step.itemId, hostId, step.flag, step.quantity);
      if (!done.ok) {
        failure = done;
        break;
      }
      moved.add(step.itemId);
      movedM3 += step.m3;
      changes.push(...done.changes);
    }
    emitChanges(owner, changes);
    if (failure) {
      return fail("MOVE_FAILED", { detail: failure.detail, movedStacks: moved.size, movedM3: round6(movedM3) });
    }
    return { ok: true, name, movedStacks: moved.size, movedM3: round6(movedM3), changes };
  }

  return Object.freeze({ listBayCargo, moveCargo, unloadForStow });
}

function depsFromGame(g, emit) {
  const late = (mod, name) => (...args) => g[mod][name](...args);
  return {
    findItemById: late("itemStore", "findItemById"),
    listContainerItems: late("itemStore", "listContainerItems"),
    moveItemToLocation: late("itemStore", "moveItemToLocation"),
    getInventoryItemUnitVolume: late("itemStore", "getInventoryItemUnitVolume"),
    buildShipResourceState: late("liveFittingState", "buildShipResourceState"),
    getShipHoldCapacityByFlag: late("miningInventory", "getShipHoldCapacityByFlag"),
    isItemTypeAllowedInHoldFlag: late("miningInventory", "isItemTypeAllowedInHoldFlag"),
    getFleetHangarCapacity: late("fleetHangarInventory", "getFleetHangarCapacity"),
    MINING_FLAGS: [...g.miningInventory.MINING_SHIP_BAY_FLAGS],
    CARGO_HOLD: g.itemStore.ITEM_FLAGS.CARGO_HOLD,
    FLEET_HANGAR: g.itemStore.ITEM_FLAGS.FLEET_HANGAR,
    SHIP_HANGAR: g.itemStore.ITEM_FLAGS.SHIP_HANGAR,
    emit,
  };
}

function createCargoAccessFromGame(gameAdapter, input) {
  const config = (input && input.config) || {};
  if (config.cargoPanelEnabled !== true) return { ok: false, reason: "off" };
  if (!gameAdapter || typeof gameAdapter.isConsumerAvailable !== "function"
    || gameAdapter.isConsumerAvailable("cargo") !== true) {
    return { ok: false, reason: "probe_cargo_unavailable" };
  }
  const loaded = loadGame(gameAdapter, ACCESS_MODULES);
  if (!loaded.ok) return loaded;
  return { ok: true, access: createCargoAccess({ deps: depsFromGame(loaded.game, input && input.emit), config }) };
}

function loadGame(gameAdapter, modules) {
  const game = {};
  for (const [key, rel] of Object.entries(modules)) {
    const loaded = gameAdapter.requireGame(rel);
    if (!loaded || !loaded.ok || !isObj(loaded.exports)) {
      return { ok: false, reason: `require_failed:${rel}:${loaded && loaded.reason}` };
    }
    game[key] = loaded.exports;
  }
  const flags = game.itemStore.ITEM_FLAGS;
  if (!isObj(flags) || ![flags.CARGO_HOLD, flags.FLEET_HANGAR, flags.SHIP_HANGAR].every(Number.isInteger)
    || !Array.isArray(game.miningInventory.MINING_SHIP_BAY_FLAGS)) {
    return { ok: false, reason: "no_flag_constants" };
  }
  return { ok: true, game };
}

const STOW_CARGO_MODULES = Object.freeze({
  ...ACCESS_MODULES,
  bayInventory: "services/inventory/shipMaintenanceBayInventory",
});

function createStowCargoFromGame(gameAdapter, input) {
  const config = (input && input.config) || {};
  if (config.boardBackCargoUnloadEnabled !== true) return { ok: false, reason: "off" };
  const probe = (name) => gameAdapter && typeof gameAdapter.isConsumerAvailable === "function"
    && gameAdapter.isConsumerAvailable(name) === true;
  if (!probe("cargo")) return { ok: false, reason: "probe_cargo_unavailable" };
  if (!probe("boardCargo")) return { ok: false, reason: "probe_boardCargo_unavailable" };
  const loaded = loadGame(gameAdapter, STOW_CARGO_MODULES);
  if (!loaded.ok) return loaded;
  const bay = loaded.game.bayInventory;
  if (typeof bay.validateShipMaintenanceBayContents !== "function") {
    return { ok: false, reason: "no_validateShipMaintenanceBayContents" };
  }
  const deps = depsFromGame(loaded.game, input && input.emit);
  deps.validateBayContents = (contents) => bay.validateShipMaintenanceBayContents(contents);
  return { ok: true, access: createCargoAccess({ deps, config }) };
}

module.exports = { ACCESS_MODULES, STOW_CARGO_MODULES, SHIP_CATEGORY_ID, createCargoAccess,
  createCargoAccessFromGame, createStowCargoFromGame };
