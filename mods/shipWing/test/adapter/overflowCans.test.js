"use strict";

const assert = require("node:assert");
const path = require("node:path");
const { createMiningAccess } = require("../../lib/adapter/miningAccess");
const { createTwinScene } = require("../../lib/adapter/twinScene");
const { sizeHold, holdSpace, holdAdd } = require("../../lib/core/miningTask");
const { resolveConfig } = require("../../config");

const MOD_DIR = path.join(__dirname, "..", "..");
const OWNER = 90000001;
const SYSTEM = 30000142;
const ORE = 1230;
const UNIT = 10;
const NOW = 50000;
const JETCAN = 23;

function config(extra = {}) {
  return { ...resolveConfig({ modDir: MOD_DIR, env: { EVEJS_SHIPWING_ENABLED: "1" } }).config, miningEnabled: true,
    ...extra };
}

function world(opts = {}) {
  const w = { created: [], spawns: [], removed: [], grants: [], canItems: new Map(), spawnFail: false,
    spawnFailAfter: Infinity, entities: new Map() };
  const twin = { itemID: 4200000000000020, position: { x: 1000, y: 0, z: 0 }, direction: { x: 0, y: 2, z: 0 },
    radius: 50 };
  w.entities.set(twin.itemID, twin);
  w.twin = twin;
  w.scene = { systemID: SYSTEM, getEntityByID: (id) => w.entities.get(Number(id)) || null,
    getCurrentSimTimeMs: () => NOW };
  const deps = {
    grantItemsToCharacterLocation(charId, locationId, flagId, entries) {
      w.grants.push({ charId, locationId, flagId, quantity: entries[0].quantity });
      const list = w.canItems.get(locationId) || [];
      list.push({ flagID: flagId, volume: UNIT, stacksize: entries[0].quantity, singleton: 0 });
      w.canItems.set(locationId, list);
      return { success: true, data: { changes: [] } };
    },
    listContainerItems: (_owner, locationId, flagId) => (w.canItems.get(locationId) || [])
      .filter((i) => i.flagID === flagId),
    FLEET_HANGAR: 155,
    overflow: {
      createSpaceItemForCharacter(owner, systemId, type, o) {
        const itemID = 9200000000 + w.created.length;
        w.created.push({ itemID, owner, systemId, typeID: type.typeID, o });
        return { success: true, data: { itemID } };
      },
      removeInventoryItem: (id, o) => w.removed.push([id, o]),
      spawnDynamicInventoryEntity(sceneArg, itemID, o) {
        w.spawns.push([sceneArg, itemID, o]);
        if (w.spawnFail || w.spawns.length > w.spawnFailAfter) return { success: false, errorMsg: "SCENE_NOT_FOUND" };
        const made = w.created.find((c) => c.itemID === itemID);
        w.entities.set(itemID, { itemID, position: made.o.position, radius: 14 });
        return { success: true, data: {} };
      },
      buildChildEntityScopeMetadata: () => ({ scopeTag: "twin" }),
      resolveItemByTypeID: (typeID) => (typeID === JETCAN ? { typeID, capacity: opts.capacity || 27500 } : null),
      JETCAN_TYPE_ID: JETCAN,
      CONTENT_FLAG: 0,
    },
  };
  w.access = createMiningAccess({ deps, scene: createTwinScene(), config: config(opts.config) });
  w.hold = { capacityByFlag: new Map(), items: new Map(), usedM3: 0 };
  sizeHold(w.hold, {});
  w.fill = (quantity) => {
    const space = holdSpace(w.hold, ORE, { flagOf: () => 134, capacityOf: () => 100000 });
    assert.strictEqual(holdAdd(w.hold, space.flag, ORE, quantity, UNIT).ok, true);
  };
  w.jettison = () => w.access.jettison(w.hold, { ownerCharacterId: OWNER, scene: w.scene, twin, nowMs: NOW });
  return w;
}

module.exports = ({ test }) => {
  test("OC1 empty registry -> a new can (offset spot, expiresAtMs = now + lifetime, owner = pilot), the ore granted to "
    + "flag 0, the hold empty, created:true; the second call -> the same can", () => {
    const w = world();
    w.fill(100);
    const out = w.jettison();
    const canId = w.created[0].itemID;
    assert.deepStrictEqual(out, { ok: true, movedM3: 1000, leftM3: 0, canId, created: true });
    const c = w.created[0];
    assert.deepStrictEqual([c.owner, c.systemId, c.typeID, c.o.scopeTag, c.o.launcherID, c.o.mode],
      [OWNER, SYSTEM, JETCAN, "twin", null, "STOP"]);
    assert.deepStrictEqual(c.o.position, { x: 1000, y: 325, z: 0 }, "twin + direction x max(50, radius + 275)");
    assert.deepStrictEqual([c.o.createdAtMs, c.o.expiresAtMs], [NOW, NOW + 7200000]);
    assert.deepStrictEqual(w.spawns[0], [SYSTEM, canId, { broadcast: true, broadcastOptions: { freshAcquire: true },
      sceneDescriptor: undefined }]);
    assert.deepStrictEqual(w.grants, [{ charId: OWNER, locationId: canId, flagId: 0, quantity: 100 }]);
    assert.deepStrictEqual([w.hold.usedM3, w.hold.items.size], [0, 0]);
    w.fill(5);
    const again = w.jettison();
    assert.deepStrictEqual([again.ok, again.canId, again.created, w.created.length, w.grants[1].quantity],
      [true, canId, false, 1, 5]);
  });

  test("OC2 limit reached with full cans -> CAN_LIMIT, the hold untouched; a second can within one call; spawn "
    + "failed -> removeInventoryItem, SPAWN_FAILED, the hold untouched", () => {
    const w = world({ capacity: 1000, config: { miningOverflowMaxCansPerOwner: 2 } });
    w.fill(150);
    const two = w.jettison();
    assert.deepStrictEqual([two.ok, two.movedM3, w.created.length], [true, 1500, 2]);
    w.fill(60);
    const limited = w.jettison();
    assert.deepStrictEqual([limited.ok, limited.reason, limited.movedM3, w.hold.usedM3, w.created.length],
      [false, "CAN_LIMIT", 500, 100, 2]);
    const refused = w.jettison();
    assert.deepStrictEqual([refused.ok, refused.reason, refused.movedM3, refused.leftM3, w.created.length],
      [false, "CAN_LIMIT", 0, 100, 2]);

    const f = world();
    f.spawnFail = true;
    f.fill(10);
    const failed = f.jettison();
    assert.deepStrictEqual([failed.ok, failed.reason, failed.leftM3, f.hold.usedM3, f.grants.length],
      [false, "SPAWN_FAILED", 100, 100, 0]);
    assert.deepStrictEqual(f.removed, [[f.created[0].itemID, { removeContents: true }]]);
    assert.strictEqual(f.created.length, 1, "the can was created, then removed");
  });

  test("OC4 debt-sweep: round 0 fills a can, round 1 spawn fails -> SPAWN_FAILED with movedM3 > 0, the rest in the "
    + "hold", () => {
    const w = world({ capacity: 1000 });
    w.spawnFailAfter = 1;
    w.fill(150);
    const out = w.jettison();
    assert.deepStrictEqual([out.ok, out.reason, out.movedM3, out.leftM3, out.created, w.hold.usedM3, w.created.length],
      [false, "SPAWN_FAILED", 1000, 500, true, 500, 2]);
    assert.deepStrictEqual(w.removed, [[w.created[1].itemID, { removeContents: true }]]);
  });

  test("OC3 the real facade of createMiningAccess has jettison; without the overflow deps -> DISABLED, nothing "
    + "moved", () => {
    const w = world();
    assert.deepStrictEqual(Object.keys(w.access).sort(), ["checkTarget", "deposit", "holdFill", "isRock", "jettison",
      "miningModules", "pickRock", "rockDistanceM", "rockState", "unload", "workRangeM"]);
    const bare = createMiningAccess({ deps: { FLEET_HANGAR: 155 }, scene: createTwinScene(), config: config() });
    w.fill(3);
    const out = bare.jettison(w.hold, { ownerCharacterId: OWNER, scene: w.scene, twin: w.twin, nowMs: NOW });
    assert.deepStrictEqual([out.ok, out.reason, out.movedM3, out.leftM3], [false, "DISABLED", 0, 30]);
  });
};
