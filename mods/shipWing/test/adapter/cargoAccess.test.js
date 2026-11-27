"use strict";

const assert = require("node:assert");
const path = require("node:path");
const { createCargoAccess, createCargoAccessFromGame } = require("../../lib/adapter/cargoAccess");
const { resolveConfig } = require("../../config");

const MOD_DIR = path.join(__dirname, "..", "..");
const OWNER = 90000001;
const STRANGER = 90000009;
const HOST = 1000000400;
const SYSTEM = 30000142;
const BARGE = 501;
const HAULER = 502;
const FOREIGN = 503;
const ORE = 1230;
const MODULE = 3651;
const ORE_HOLD = 134;
const CARGO = 5;
const FLEET = 155;
const SHIP_HANGAR = 90;

function config(extra = {}) {
  return { ...resolveConfig({ modDir: MOD_DIR, env: { EVEJS_SHIPWING_ENABLED: "1" } }).config,
    cargoPanelEnabled: true, ...extra };
}

function stack(itemID, locationID, flagID, typeID, qty, extra = {}) {
  return { itemID, ownerID: OWNER, typeID, categoryID: typeID === ORE ? 25 : 7, locationID, flagID, singleton: 0,
    stacksize: qty, quantity: qty, volume: typeID === ORE ? 10 : 5, itemName: typeID === ORE ? "Veldspar" : "Gyro",
    ...extra };
}

function world() {
  const w = { emits: [], moves: [], failMove: false, nextId: 9000 };
  const ship = (itemID, extra) => ({ itemID, ownerID: OWNER, typeID: 22544, categoryID: 6, singleton: 1,
    locationID: HOST, flagID: SHIP_HANGAR, itemName: `Ship ${itemID}`, volume: 1000, ...extra });
  w.items = new Map([
    [HOST, ship(HOST, { locationID: SYSTEM, flagID: 0, itemName: "Orca" })],
    [BARGE, ship(BARGE, { itemName: "Hulk A" })], [HAULER, ship(HAULER, { itemName: "Miasmos" })],
    [FOREIGN, ship(FOREIGN, { ownerID: STRANGER })],
    [601, stack(601, BARGE, ORE_HOLD, ORE, 300)],
    [602, stack(602, HOST, CARGO, MODULE, 2)],
    [603, stack(603, HOST, FLEET, ORE, 50, { ownerID: STRANGER })],
  ]);
  w.rs = new Map([[HOST, { oreHold: 1000, cargoCapacity: 100, fleet: 2000 }],
    [BARGE, { oreHold: 3500, cargoCapacity: 50, fleet: 0 }], [HAULER, { oreHold: 0, cargoCapacity: 2000, fleet: 0 }]]);
  const list = (owner, loc, flag) => [...w.items.values()].filter((i) => i.locationID === loc
    && (owner === null || i.ownerID === owner) && (flag === null || i.flagID === flag)).map((i) => ({ ...i }));
  const deps = {
    findItemById: (id) => (w.items.has(id) ? { ...w.items.get(id) } : null),
    listContainerItems: list,
    buildShipResourceState: (_owner, item) => ({ ...w.rs.get(item.itemID), cargoCapacity:
      w.rs.get(item.itemID).cargoCapacity }),
    getShipHoldCapacityByFlag: (rs, flag) => (flag === ORE_HOLD ? rs.oreHold : 0),
    isItemTypeAllowedInHoldFlag: (typeID, flag) => flag === ORE_HOLD && typeID === ORE,
    getFleetHangarCapacity: (rs) => rs.fleet,
    moveItemToLocation(itemId, loc, flag, quantity) {
      w.moves.push([itemId, loc, flag, quantity]);
      if (w.failMove) return { success: false, errorMsg: "WRITE_ERROR" };
      const item = w.items.get(itemId);
      const qty = quantity === null ? item.stacksize : quantity;
      if (qty > item.stacksize) return { success: false, errorMsg: "INSUFFICIENT_ITEMS" };
      if (qty === item.stacksize) {
        w.items.set(itemId, { ...item, locationID: loc, flagID: flag });
      } else {
        w.items.set(itemId, { ...item, stacksize: item.stacksize - qty, quantity: item.stacksize - qty });
        w.nextId += 1;
        w.items.set(w.nextId, { ...item, itemID: w.nextId, locationID: loc, flagID: flag, stacksize: qty,
          quantity: qty });
      }
      return { success: true, data: { quantity: qty, changes: [{ itemId, loc, flag }] } };
    },
    MINING_FLAGS: [ORE_HOLD, 135, 136],
    CARGO_HOLD: CARGO, FLEET_HANGAR: FLEET, SHIP_HANGAR,
    emit: (owner, changes) => w.emits.push([owner, changes.length]),
  };
  w.access = createCargoAccess({ deps, config: config() });
  w.deps = deps;
  w.total = (typeID) => [...w.items.values()].filter((i) => i.typeID === typeID && i.ownerID === OWNER)
    .reduce((sum, i) => sum + i.stacksize, 0);
  w.at = (loc, flag) => [...w.items.values()].filter((i) => i.locationID === loc && i.flagID === flag
    && i.ownerID === OWNER).reduce((sum, i) => sum + i.stacksize, 0);
  return w;
}

const move = (w, extra) => w.access.moveCargo({ ownerCharacterId: OWNER, hostShipId: HOST, quantity: null,
  toFlag: null, ...extra });

const SPACE_SHIP = 504;
const DRONE_BAY = 87;
function stowRig(stacks) {
  const w = world();
  w.items.set(SPACE_SHIP, { itemID: SPACE_SHIP, ownerID: OWNER, typeID: 22544, categoryID: 6, singleton: 1,
    locationID: SYSTEM, flagID: 0, itemName: "Hulk B", volume: 1000 });
  w.rs.set(SPACE_SHIP, { oreHold: 20000, cargoCapacity: 100, fleet: 0 });
  for (const s of stacks) w.items.set(s.itemID, s);
  w.validated = [];
  w.listCalls = [];
  const list = w.deps.listContainerItems;
  w.deps.listContainerItems = (...args) => {
    w.listCalls.push(args);
    return list(args[0], args[1], args.length > 2 ? args[2] : null);
  };
  w.deps.validateBayContents = (contents) => {
    w.validated.push(contents.map((i) => i.itemID));
    const rejected = contents.filter((i) => i.typeID === ORE);
    return rejected.length === 0 ? { success: true }
      : { success: false, errorMsg: "SHIP_MAINTENANCE_BAY_CARGO_RESTRICTED", rejectedItemIDs: rejected.map((i) => i.itemID) };
  };
  w.access = createCargoAccess({ deps: w.deps, config: config() });
  w.unload = (extra) => w.access.unloadForStow({ ownerCharacterId: OWNER, hostShipId: HOST, shipItemId: SPACE_SHIP,
    maxStacks: 50, ...extra });
  return w;
}

module.exports = ({ test }) => {
  test("CG1 list: the host (mining, cargo, Fleet Hangar) and the owner's ships in its "
    + "SMB (never a stranger's ship or a stranger's stack); move: ore of a barge -> the host's ore hold, what fits, "
    + "the rest stays (a part = a new stack), one emit; back by toFlag; nothing doubled or lost; refusals; a failed "
    + "vendor move changes nothing; the loader entry: flag off / probe", () => {
    const w = world();
    const view = w.access.listBayCargo(OWNER, HOST);
    assert.strictEqual(view.ok, true);
    assert.deepStrictEqual(view.ships.map((s) => [s.shipItemId, s.host]), [[HOST, true], [BARGE, false],
      [HAULER, false]], "host first, then the bay ascending; no foreign ship");
    const host = view.ships[0];
    assert.deepStrictEqual(host.holds.map((h) => [h.kind, h.flag, h.capacityM3, h.usedM3, h.items.length]),
      [["mining", ORE_HOLD, 1000, 0, 0], ["cargo", CARGO, 100, 10, 1], ["fleet", FLEET, 2000, 500, 0]],
      "the stranger's ore counts as used, never as a row");
    assert.deepStrictEqual(view.ships[1].holds[0].items, [{ itemId: 601, typeId: ORE, name: "Veldspar", qty: 300,
      m3: 3000 }]);
    assert.deepStrictEqual(w.access.listBayCargo(STRANGER, HOST), { ok: false, reason: "HOST_INVALID" });
    const small = createCargoAccess({ deps: w.deps, config: config({ cargoListMaxRows: 1 }) }).listBayCargo(OWNER, HOST);
    assert.strictEqual(small.truncated, 1);

    const out = move(w, { itemId: 601, toLocationId: HOST });
    assert.deepStrictEqual([out.ok, out.movedQty, out.leftQty, out.flags], [true, 259, 41, [ORE_HOLD, CARGO, FLEET]]);
    assert.deepStrictEqual([w.at(HOST, ORE_HOLD), w.at(HOST, CARGO) - 2, w.at(HOST, FLEET), w.at(BARGE, ORE_HOLD)],
      [100, 9, 150, 41]);
    assert.strictEqual(w.total(ORE), 300, "nothing doubled or lost");
    assert.deepStrictEqual(w.emits, [[OWNER, 3]], "one emit with every change");
    assert.deepStrictEqual(move(w, { itemId: 601, toLocationId: HOST }), { ok: false, reason: "NO_ROOM" });
    const back = move(w, { itemId: 601, toLocationId: HAULER, toFlag: CARGO });
    assert.deepStrictEqual([back.ok, back.movedQty, w.moves[w.moves.length - 1][3], w.items.get(601).locationID],
      [true, 41, null, HAULER]);

    const before = w.moves.length;
    assert.strictEqual(move(w, { itemId: 603, toLocationId: BARGE }).reason, "NOT_OWNER");
    assert.strictEqual(move(w, { itemId: BARGE, toLocationId: HAULER }).reason, "ITEM_INVALID");
    assert.strictEqual(move(w, { itemId: 602, toLocationId: FOREIGN }).reason, "TARGET_INVALID");
    assert.strictEqual(move(w, { itemId: 602, toLocationId: SYSTEM }).reason, "TARGET_INVALID");
    assert.strictEqual(move(w, { itemId: 602, toLocationId: BARGE, toFlag: ORE_HOLD }).reason, "TYPE_NOT_ALLOWED");
    assert.strictEqual(move(w, { itemId: 602, toLocationId: HAULER, toFlag: FLEET }).reason, "FLAG_INVALID");
    assert.strictEqual(move(w, { itemId: 602, toLocationId: HOST, toFlag: CARGO }).reason, "SAME_HOLD");
    assert.strictEqual(move(w, { itemId: 602, toLocationId: BARGE, quantity: 3 }).reason, "QUANTITY_INVALID");
    assert.strictEqual(move(w, { itemId: 602, toLocationId: BARGE, isLocked: (id) => id === BARGE }).reason,
      "LOST_UNSETTLED");
    w.items.set(700, stack(700, 4000, CARGO, MODULE, 1));
    assert.strictEqual(move(w, { itemId: 700, toLocationId: BARGE }).reason, "SOURCE_INVALID");
    w.items.set(701, stack(701, BARGE, 27, MODULE, 1, { singleton: 1 }));
    assert.strictEqual(move(w, { itemId: 701, toLocationId: HOST }).reason, "SOURCE_INVALID");
    assert.strictEqual(w.moves.length, before, "no vendor move for a refusal");

    w.failMove = true;
    const failed = move(w, { itemId: 602, toLocationId: BARGE });
    assert.deepStrictEqual([failed.ok, failed.reason, failed.detail, w.items.get(602).locationID],
      [false, "MOVE_FAILED", "WRITE_ERROR", HOST]);

    const probe = (ok) => ({ isConsumerAvailable: (c) => ok && c === "cargo", requireGame: () => ({ ok: false }) });
    assert.deepStrictEqual(createCargoAccessFromGame(probe(true), { config: config({ cargoPanelEnabled: false }) }),
      { ok: false, reason: "off" });
    assert.deepStrictEqual(createCargoAccessFromGame(probe(false), { config: config() }),
      { ok: false, reason: "probe_cargo_unavailable" });
  });

  test("CG-ST1 unloadForStow: 2 ore stacks of the ship in space -> host ore "
    + "hold, then Fleet Hangar (the first stack splits, a whole rest = null), the ammo stays, the rule got the WHOLE "
    + "content (a list without a flag), one emit, the host's cargo 5 untouched; a second call -> movedStacks 0", () => {
    const w = stowRig([stack(801, SPACE_SHIP, ORE_HOLD, ORE, 150), stack(802, SPACE_SHIP, ORE_HOLD, ORE, 80),
      stack(803, SPACE_SHIP, CARGO, MODULE, 10)]);
    const out = w.unload();
    assert.deepStrictEqual([out.ok, out.name, out.movedStacks, out.movedM3], [true, "Hulk B", 2, 2300]);
    assert.deepStrictEqual(w.moves, [[801, HOST, ORE_HOLD, 100], [801, HOST, FLEET, null], [802, HOST, FLEET, null]]);
    assert.deepStrictEqual([w.at(HOST, ORE_HOLD), w.at(HOST, FLEET), w.at(SPACE_SHIP, ORE_HOLD)], [100, 130, 0]);
    assert.deepStrictEqual([w.at(SPACE_SHIP, CARGO), w.at(HOST, CARGO)], [10, 2], "ammo stays; no cargo 5 of the host");
    assert.deepStrictEqual(w.validated, [[801, 802, 803]]);
    assert.ok(w.listCalls.some((a) => a.length === 2 && a[0] === null && a[1] === SPACE_SHIP), "no flag, as the vendor");
    assert.deepStrictEqual(w.emits, [[OWNER, 3]]);
    assert.strictEqual(w.total(ORE), 300 + 230, "nothing doubled or lost (the barge's 300 + the ship's 230)");
    const again = w.unload();
    assert.deepStrictEqual([again.ok, again.movedStacks, w.moves.length, w.emits.length], [true, 0, 3, 1]);
  });

  test("CG-ST2 refusals without a move: NO_ROOM (needed/free m3), a refused item in the drone "
    + "bay -> UNMOVABLE, maxStacks -> TOO_MANY, the ship in the SMB -> SHIP_INVALID; the 2nd step WRITE_ERROR -> "
    + "MOVE_FAILED, movedStacks 1, the emit with the first only; the loader entry: flag off / probes", () => {
    const big = stowRig([stack(801, SPACE_SHIP, ORE_HOLD, ORE, 900)]);
    const room = big.unload();
    assert.deepStrictEqual([room.ok, room.reason, room.neededM3, room.freeM3], [false, "NO_ROOM", 9000, 2500]);
    assert.deepStrictEqual([big.moves.length, big.at(SPACE_SHIP, ORE_HOLD), big.emits.length], [0, 900, 0]);

    const drone = stowRig([stack(801, SPACE_SHIP, ORE_HOLD, ORE, 10), stack(810, SPACE_SHIP, DRONE_BAY, ORE, 1)]);
    assert.deepStrictEqual(drone.unload(), { ok: false, name: "Hulk B", reason: "UNMOVABLE", detail: "810:87" });
    assert.strictEqual(drone.moves.length, 0);

    const many = stowRig([stack(801, SPACE_SHIP, ORE_HOLD, ORE, 10), stack(802, SPACE_SHIP, ORE_HOLD, ORE, 10)]);
    assert.strictEqual(many.unload({ maxStacks: 1 }).reason, "TOO_MANY");
    assert.strictEqual(many.unload({ shipItemId: BARGE }).reason, "SHIP_INVALID", "a ship in the SMB, not in space");
    assert.strictEqual(many.moves.length, 0);

    const half = stowRig([stack(801, SPACE_SHIP, ORE_HOLD, ORE, 50), stack(802, SPACE_SHIP, ORE_HOLD, ORE, 30)]);
    const real = half.deps.moveItemToLocation;
    half.deps.moveItemToLocation = (...args) => (half.moves.length >= 1
      ? (half.moves.push(args), { success: false, errorMsg: "WRITE_ERROR" }) : real(...args));
    const failed = half.unload();
    assert.deepStrictEqual([failed.ok, failed.reason, failed.detail, failed.movedStacks, failed.movedM3],
      [false, "MOVE_FAILED", "WRITE_ERROR", 1, 500]);
    assert.deepStrictEqual([half.at(HOST, ORE_HOLD), half.at(SPACE_SHIP, ORE_HOLD), half.emits], [50, 30, [[OWNER, 1]]]);

    const { createStowCargoFromGame } = require("../../lib/adapter/cargoAccess");
    const probe = (names) => ({ isConsumerAvailable: (c) => names.includes(c), requireGame: () => ({ ok: false }) });
    assert.deepStrictEqual(createStowCargoFromGame(probe(["cargo", "boardCargo"]), { config: config() }),
      { ok: false, reason: "off" });
    const on = config({ boardBackCargoUnloadEnabled: true, cargoPanelEnabled: false });
    assert.deepStrictEqual(createStowCargoFromGame(probe(["cargo"]), { config: on }),
      { ok: false, reason: "probe_boardCargo_unavailable" });
  });

  test("CG-DS1: a vendor failure after a moved step -> ok with "
    + "stopReason/stopDetail (none when only the room ends): truncated per ship, firstShipItemId takes the row "
    + "budget first, the order stays: the vendor unit volume (a throw = the row's volume); "
    + "unloadForStow isLocked -> LOST_UNSETTLED without a move, a locked ship without blocking cargo -> ok 0", () => {
    const w = world();
    const real = w.deps.moveItemToLocation;
    w.deps.moveItemToLocation = (...args) => (w.moves.length >= 1
      ? (w.moves.push(args), { success: false, errorMsg: "WRITE_ERROR" }) : real(...args));
    const half = move(w, { itemId: 601, toLocationId: HOST });
    assert.deepStrictEqual([half.ok, half.movedQty, half.leftQty, half.stopReason, half.stopDetail],
      [true, 100, 200, "MOVE_FAILED", "WRITE_ERROR"]);
    const room = move(world(), { itemId: 601, toLocationId: HOST });
    assert.deepStrictEqual([room.ok, room.leftQty, "stopReason" in room], [true, 41, false]);

    const rows = createCargoAccess({ deps: world().deps, config: config({ cargoListMaxRows: 1 }) });
    const plain = rows.listBayCargo(OWNER, HOST);
    assert.deepStrictEqual(plain.ships.map((s) => [s.shipItemId, s.truncated]), [[HOST, 0], [BARGE, 1], [HAULER, 0]]);
    const first = rows.listBayCargo(OWNER, HOST, BARGE);
    assert.deepStrictEqual(first.ships.map((s) => [s.shipItemId, s.truncated]), [[HOST, 1], [BARGE, 0], [HAULER, 0]]);
    assert.deepStrictEqual([first.ships[1].holds[0].items.map((i) => i.itemId), first.truncated], [[601], 1]);

    const vol = world();
    vol.deps.getInventoryItemUnitVolume = (item) => (item.typeID === ORE ? 20 : 5);
    const view = vol.access.listBayCargo(OWNER, HOST);
    assert.deepStrictEqual([view.ships[1].holds[0].items[0].m3, view.ships[1].holds[0].usedM3,
      view.ships[0].holds[2].usedM3], [6000, 6000, 1000], "the vendor volume, a stranger's ore too");
    assert.deepStrictEqual([move(vol, { itemId: 601, toLocationId: HAULER, toFlag: CARGO }).movedQty], [100]);
    vol.deps.getInventoryItemUnitVolume = () => {
      throw new Error("drift");
    };
    assert.strictEqual(vol.access.listBayCargo(OWNER, HOST).ships[1].holds[0].items[0].m3, 2000, "the row's volume");

    const lock = stowRig([stack(801, SPACE_SHIP, ORE_HOLD, ORE, 10)]);
    assert.deepStrictEqual(lock.unload({ isLocked: (id) => id === SPACE_SHIP }),
      { ok: false, name: "Hulk B", reason: "LOST_UNSETTLED" });
    assert.strictEqual(lock.unload({ isLocked: (id) => id === HOST }).reason, "LOST_UNSETTLED");
    assert.strictEqual(lock.unload({ isLocked: () => {
      throw new Error("x");
    } }).reason, "LOST_UNSETTLED");
    assert.deepStrictEqual([lock.moves.length, lock.at(SPACE_SHIP, ORE_HOLD)], [0, 10]);
    const clean = stowRig([stack(803, SPACE_SHIP, CARGO, MODULE, 10)]);
    assert.deepStrictEqual([clean.unload({ isLocked: () => true }).ok, clean.moves.length], [true, 0],
      "no blocking cargo = the stow as before, the lock not asked");
  });
};
