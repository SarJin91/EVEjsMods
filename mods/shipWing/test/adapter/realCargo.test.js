"use strict";

const assert = require("node:assert");
const path = require("node:path");
const { createMiningAccess } = require("../../lib/adapter/miningAccess");
const { createTwinScene } = require("../../lib/adapter/twinScene");
const { sizeHold, holdSpace, holdAdd } = require("../../lib/core/miningTask");
const { resolveConfig } = require("../../config");

const MOD_DIR = path.join(__dirname, "..", "..");
const OWNER = 90000001;
const STRANGER = 90000009;
const HOST = 1000000400;
const SYSTEM = 30000142;
const OWN = 501;
const STORE = 502;
const ORE = 1230;
const UNIT = 10;
const ORE_HOLD = 134;
const CARGO = 5;
const SHIP_HANGAR = 90;

function config(extra = {}) {
  return { ...resolveConfig({ modDir: MOD_DIR, env: { EVEJS_SHIPWING_ENABLED: "1" } }).config, miningEnabled: true,
    miningRealCargoEnabled: true, ...extra };
}

function bayItem(itemID, extra = {}) {
  return { itemID, ownerID: OWNER, categoryID: 6, singleton: 1, locationID: HOST, flagID: SHIP_HANGAR, ...extra };
}

function world(opts = {}) {
  const w = { grants: [], emits: [], contents: new Map(), throwOnGrant: false, failGrant: false };
  w.items = new Map([[HOST, { itemID: HOST, ownerID: OWNER, categoryID: 6, locationID: SYSTEM, flagID: 0 }],
    [OWN, bayItem(OWN)], [STORE, bayItem(STORE)]]);
  w.rs = new Map([[OWN, { oreHold: 50, cargoCapacity: 0 }], [STORE, { oreHold: 0, cargoCapacity: 1000 }]]);
  const deps = {
    findItemById: (id) => w.items.get(id) || null,
    buildShipResourceState: (_owner, item) => ({ ...w.rs.get(item.itemID) }),
    getPreferredMiningHoldFlagForType: (rs) => (rs.oreHold > 0 ? ORE_HOLD : null),
    getShipHoldCapacityByFlag: (rs, flag) => (flag === ORE_HOLD ? rs.oreHold : 0),
    isItemTypeAllowedInHoldFlag: (_t, flag) => flag === ORE_HOLD,
    grantItemsToCharacterLocation(charId, locationId, flagId, entries) {
      w.grants.push([charId, locationId, flagId, entries[0].itemType, entries[0].quantity]);
      if (w.throwOnGrant) throw new Error("TEST_THROW");
      if (w.failGrant) return { success: false, errorMsg: "TEST" };
      const key = `${locationId}:${flagId}`;
      w.contents.set(key, [...(w.contents.get(key) || []),
        { volume: UNIT, stacksize: entries[0].quantity, singleton: 0 }]);
      return { success: true, data: { changes: [{ locationId, flagId }] } };
    },
    listContainerItems: (_o, locationId, flagId) => w.contents.get(`${locationId}:${flagId}`) || [],
    FLEET_HANGAR: 155,
    SHIP_HANGAR,
    CARGO_HOLD: CARGO,
    emit: (owner, changes) => w.emits.push([owner, changes.length]),
  };
  w.access = createMiningAccess({ deps, scene: createTwinScene(), config: config(opts.config) });
  w.hold = { capacityByFlag: new Map(), items: new Map(), usedM3: 0 };
  sizeHold(w.hold, {});
  w.fill = (quantity) => {
    const space = holdSpace(w.hold, ORE, { flagOf: () => ORE_HOLD, capacityOf: () => 100000 });
    assert.strictEqual(holdAdd(w.hold, space.flag, ORE, quantity, UNIT).ok, true);
  };
  w.deposit = (store = 0) => w.access.deposit(w.hold, { ownerCharacterId: OWNER, hostShipId: HOST, shipItemId: OWN,
    storeShipItemId: store });
  return w;
}

module.exports = ({ test }) => {
  test("RC1 the hold into the ore hold of the twin's real ship in the host's SMB: one grant, holdTake "
    + "at once, one emit; a second deposit without new ore -> EMPTY, no second grant", () => {
    const w = world();
    w.fill(4);
    const out = w.deposit();
    assert.deepStrictEqual([out.ok, out.movedM3, out.leftM3, out.ownM3, out.storeM3, out.grantFailed, out.grantThrew,
      out.storeInvalid], [true, 40, 0, 40, 0, 0, 0, false]);
    assert.deepStrictEqual(w.grants, [[OWNER, OWN, ORE_HOLD, ORE, 4]]);
    assert.deepStrictEqual([w.hold.usedM3, w.hold.items.size], [0, 0]);
    assert.deepStrictEqual(w.emits, [[OWNER, 1]]);
    const again = w.deposit();
    assert.deepStrictEqual([again.ok, again.reason, again.movedM3, w.grants.length, w.emits.length],
      [false, "EMPTY", 0, 1, 1], "nothing doubled");
    const bare = createMiningAccess({ deps: { FLEET_HANGAR: 155 }, scene: createTwinScene(), config: config() });
    w.fill(1);
    const off = bare.deposit(w.hold, { ownerCharacterId: OWNER, hostShipId: HOST, shipItemId: OWN });
    assert.deepStrictEqual([off.ok, off.reason, off.movedM3, off.leftM3], [false, "DISABLED", 0, 10],
      "no flag constants -> DISABLED");
  });

  test("RC2 own ship full -> the hauler (cargo 5); both full -> the rest stays (leftM3 > 0); a ship outside "
    + "the host's SMB or of another pilot -> TARGET_INVALID, no grant; a bad hauler -> storeInvalid; a throwing grant "
    + "-> holdTake anyway + grantThrew (a loss, never a double)", () => {
    const w = world();
    w.fill(10);
    const out = w.deposit(STORE);
    assert.deepStrictEqual(w.grants, [[OWNER, OWN, ORE_HOLD, ORE, 5], [OWNER, STORE, CARGO, ORE, 5]]);
    assert.deepStrictEqual([out.ok, out.ownM3, out.storeM3, out.leftM3], [true, 50, 50, 0]);
    assert.deepStrictEqual(w.emits, [[OWNER, 2]], "one emit for both ships");

    const full = world();
    full.rs.set(STORE, { oreHold: 0, cargoCapacity: 20 });
    full.fill(10);
    const part = full.deposit(STORE);
    assert.deepStrictEqual([part.ok, part.movedM3, part.leftM3, full.hold.items.get(ORE)], [true, 70, 30, 3]);

    for (const bad of [{ locationID: SYSTEM, flagID: 0 }, { ownerID: STRANGER }, { flagID: CARGO },
      { singleton: 0 }, { categoryID: 18 }]) {
      const v = world();
      v.items.set(OWN, bayItem(OWN, bad));
      v.fill(2);
      const refused = v.deposit();
      assert.deepStrictEqual([refused.ok, refused.reason, v.grants.length, v.hold.usedM3],
        [false, "TARGET_INVALID", 0, 20], JSON.stringify(bad));
    }
    const s = world();
    s.items.set(STORE, bayItem(STORE, { ownerID: STRANGER }));
    s.rs.set(OWN, { oreHold: 10, cargoCapacity: 0 });
    s.fill(3);
    const badStore = s.deposit(STORE);
    assert.deepStrictEqual([badStore.ok, badStore.storeInvalid, badStore.ownM3, badStore.leftM3,
      s.grants.every((g) => g[1] === OWN)], [true, true, 10, 20, true]);

    const t = world();
    t.throwOnGrant = true;
    t.fill(2);
    const threw = t.deposit();
    assert.deepStrictEqual([threw.ok, threw.grantThrew, threw.movedM3, t.hold.usedM3, t.grants.length],
      [true, 1, 0, 0, 1], "the ore left the hold, nothing counted as moved");
    t.fill(2);
    t.throwOnGrant = false;
    t.failGrant = true;
    const failed = t.deposit();
    assert.deepStrictEqual([failed.ok, failed.grantFailed, t.hold.usedM3], [true, 1, 20], "success:false keeps it");
  });
};
