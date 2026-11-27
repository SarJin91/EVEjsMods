"use strict";

const assert = require("node:assert");
const { createDroneAccess, WING_DRONE_COMMAND, DRONE_ACCESS_COUNTER_NAMES, droneYieldKind,
} = require("../../lib/adapter/droneAccess");
const { createWingAdapterCore } = require("../../lib/adapter/vendor");

const OWNER = 90000001;
const HOST = 1000000400;
const SHIP = 501;
const TWIN = 4200000000000001;
const SYSTEM = 30000142;
const STACK = 7001;
const SPLIT = 9001;
const DRONE_BAY = 87;

function fakeVendor() {
  const v = { calls: [], items: new Map(), spawnFail: false, keys: new Map() };
  v.items.set(SHIP, { itemID: SHIP, typeID: 24700, categoryID: 6, ownerID: OWNER, locationID: HOST, flagID: 90 });
  v.items.set(STACK, { itemID: STACK, typeID: 2488, categoryID: 18, ownerID: OWNER, locationID: SHIP,
    flagID: DRONE_BAY, singleton: 0, stacksize: 3 });
  v.scene = {
    systemID: SYSTEM, sceneDescriptor: null, entities: new Map(),
    getEntityByID(id) {
      return this.entities.get(Number(id)) || null;
    },
    broadcastAddBalls(list) {
      v.calls.push(["addBalls", list.map((e) => e.itemID)]);
    },
  };
  const testing = {
    serializePlayerCompanionScopeMetadata: (e) => (e && e.dungeonSiteInstanceID
      ? { dungeonSiteInstanceID: e.dungeonSiteInstanceID } : {}),
    recallDronesToShipBay(scene, shipRecord, list, flag) {
      v.calls.push(["recall", shipRecord.itemID, list.map((e) => e.itemID), flag]);
      for (const e of list) {
        scene.entities.delete(e.itemID);
        v.items.set(e.itemID, { ...v.items.get(e.itemID), locationID: shipRecord.itemID, flagID: flag });
      }
      return { success: true, data: { droneIDs: list.map((e) => e.itemID) } };
    },
  };
  v.deps = {
    isDroneItemRecord: (item) => Number(item.categoryID) === 18,
    getDroneBandwidthLoad: () => 5,
    resolveDroneOrbitDistance: () => 750,
    resolveDroneMovementProfile: () => ({ cruiseFraction: 0.5, fastSpeedFraction: 1 }),
    testing: () => testing,
    resolveDroneCombatSnapshot: () => ({ durationMs: 2000 }),
    getShipFittingSnapshot: () => ({ shipAttributes: { 352: 5, 1271: 25 } }),
    itemCustody: {
      CUSTODY_REASON: { DRONE_LAUNCH: "drone-launch", DRONE_RECOVER: "drone-recover" },
      custodyRef: {
        shipBay: (ownerID, shipID, flagID) => ({ kind: "ship-bay", ownerID, locationID: shipID, flagID }),
        inSpace: (ownerID, systemID) => ({ kind: "in-space", ownerID, locationID: systemID, flagID: 0 }),
      },
      transfer(cmd) {
        v.calls.push(["transfer", cmd.reason, cmd.idempotencyKey, cmd.from.kind, cmd.to.kind]);
        if (v.keys.has(cmd.idempotencyKey)) return v.keys.get(cmd.idempotencyKey);
        let out;
        if (cmd.reason === "drone-launch") {
          const source = v.items.get(cmd.items.itemID);
          source.stacksize -= 1;
          const launched = { ...source, itemID: SPLIT, stacksize: 1, locationID: cmd.to.locationID, flagID: 0 };
          v.items.set(SPLIT, launched);
          out = { success: true, data: { changes: [{ item: { ...source } }, { item: { ...launched } }] } };
        } else {
          const item = v.items.get(cmd.items.itemID);
          const patch = (cmd.options && cmd.options.destinationItemPatch) || {};
          v.items.set(item.itemID, { ...item, ...patch, locationID: cmd.to.locationID, flagID: cmd.to.flagID });
          out = { success: true, data: { changes: [] } };
        }
        v.keys.set(cmd.idempotencyKey, out);
        return out;
      },
    },
    itemStore: {
      ITEM_FLAGS: { DRONE_BAY },
      findItemById: (id) => v.items.get(Number(id)) || null,
      listContainerItems: (owner, loc, flag) => [...v.items.values()].filter((i) => i.ownerID === owner
        && i.locationID === loc && i.flagID === flag),
      updateInventoryItem(id, fn) {
        v.calls.push(["update", id]);
        const next = fn(v.items.get(id));
        v.items.set(id, next);
        return { success: true, data: next };
      },
    },
    runtime: {
      spawnDynamicInventoryEntity(desc, id, options) {
        v.calls.push(["spawn", desc, id, options.broadcast]);
        if (v.spawnFail) return { success: false, errorMsg: "UNSUPPORTED_DYNAMIC_ITEM" };
        const item = v.items.get(id);
        const entity = { itemID: id, kind: "drone", typeID: item.typeID, ownerID: item.ownerID,
          launcherID: item.launcherID, controllerID: item.launcherID };
        v.scene.entities.set(id, entity);
        return { success: true, data: { entity } };
      },
      droneInterop: {},
    },
  };
  v.twin = { itemID: TWIN, systemID: SYSTEM, position: { x: 1000, y: 0, z: 0 }, direction: { x: 1, y: 0, z: 0 },
    radius: 100, corporationID: 98000001, allianceID: 0, warFactionID: 0, dungeonSiteInstanceID: 77 };
  return v;
}

module.exports = ({ test }) => {
  test("DA1 launch: bay item -> custody DRONE_LAUNCH (key wing-drone-launch:<ship>:<item>:<twin>:<seq>) -> the "
    + "split row (launcherID = the ship in the SMB, spaceState next to the twin) -> spawn without broadcast -> "
    + "controllerID = the twin, pilot identity, marker -> AddBalls; the same key twice moves nothing again", () => {
    const v = fakeVendor();
    const access = createDroneAccess({ deps: v.deps, config: { droneFxEnabled: true } });
    const out = access.launch(v.scene, v.twin, { ownerCharId: OWNER, shipItemId: SHIP, itemId: STACK,
      launchIndex: 0, seq: 1 });
    assert.deepStrictEqual(out, { ok: true, droneId: SPLIT });
    assert.deepStrictEqual(v.calls.map((c) => c[0]), ["transfer", "update", "spawn", "addBalls"]);
    assert.deepStrictEqual(v.calls[0], ["transfer", "drone-launch", `wing-drone-launch:${SHIP}:${STACK}:${TWIN}:1`,
      "ship-bay", "in-space"]);
    assert.deepStrictEqual(v.calls[2], ["spawn", SYSTEM, SPLIT, false]);
    const row = v.items.get(SPLIT);
    assert.strictEqual(row.launcherID, SHIP, "Never the twin's runtime ID");
    assert.deepStrictEqual([row.singleton, row.quantity, row.stacksize, row.spaceState.mode,
      row.spaceState.dungeonSiteInstanceID], [1, null, 1, "STOP", 77]);
    assert.ok(row.spaceState.position.x > 1100, "in front of the twin");
    const drone = v.scene.entities.get(SPLIT);
    assert.deepStrictEqual([drone.launcherID, drone.controllerID, drone.controllerOwnerID, drone.characterID,
      drone.pilotCharacterID, drone.corporationID, drone.droneCommand, drone.dungeonSiteInstanceID,
      drone.droneHomeOrbitDistance], [SHIP, TWIN, OWNER, OWNER, OWNER, 98000001, WING_DRONE_COMMAND, 77, 750]);
    assert.strictEqual(access.stats().counters["drone.launch.ok"], 1);
    v.calls.length = 0;
    v.scene.entities.delete(SPLIT);
    access.launch(v.scene, v.twin, { ownerCharId: OWNER, shipItemId: SHIP, itemId: STACK, launchIndex: 0, seq: 1 });
    assert.strictEqual(v.items.get(STACK).stacksize, 2, "one drone left the stack, not two");
    v.calls.length = 0;
    assert.deepStrictEqual(access.launch(v.scene, v.twin, { ownerCharId: OWNER, shipItemId: 999, itemId: STACK,
      seq: 2 }), { ok: false, reason: "NOT_IN_BAY" });
    assert.deepStrictEqual(v.calls, []);
    assert.ok(DRONE_ACCESS_COUNTER_NAMES.every((n) => n.startsWith("drone.")));
  });

  test("DA2 a failed spawn after the custody move: custody DRONE_RECOVER back to the drone bay (key "
    + "wing-drone-rollback:<id>:<ship>) -> ROLLED_BACK, drone.launch.rollback; the drone is in the bay again", () => {
    const v = fakeVendor();
    v.spawnFail = true;
    const access = createDroneAccess({ deps: v.deps, config: {} });
    const out = access.launch(v.scene, v.twin, { ownerCharId: OWNER, shipItemId: SHIP, itemId: STACK, seq: 3 });
    assert.deepStrictEqual(out, { ok: false, reason: "ROLLED_BACK" });
    assert.deepStrictEqual(v.calls.map((c) => c[0]), ["transfer", "update", "spawn", "transfer"]);
    assert.deepStrictEqual(v.calls[3], ["transfer", "drone-recover", `wing-drone-rollback:${SPLIT}:${SHIP}`,
      "in-space", "ship-bay"]);
    assert.deepStrictEqual([v.items.get(SPLIT).locationID, v.items.get(SPLIT).flagID], [SHIP, DRONE_BAY]);
    assert.deepStrictEqual([v.items.get(SPLIT).launcherID, v.items.get(SPLIT).spaceState], [null, null]);
    const c = access.stats().counters;
    assert.deepStrictEqual([c["drone.launch.rollback"], c["drone.launch.refused.ROLLED_BACK"], c["drone.launch.ok"]],
      [1, 1, 0]);
    v.spawnFail = false;
    const launched = access.launch(v.scene, v.twin, { ownerCharId: OWNER, shipItemId: SHIP, itemId: STACK, seq: 4 });
    assert.strictEqual(launched.ok, true);
    const drone = v.scene.entities.get(launched.droneId);
    assert.deepStrictEqual(access.recall(v.scene, SHIP, [drone]), { ok: true, ids: [launched.droneId] });
    assert.deepStrictEqual(v.calls[v.calls.length - 1], ["recall", SHIP, [launched.droneId], DRONE_BAY]);
  });

  test("DA3 the twin's drones (controllerID = the twin) are not in controlledDroneIds of the pilot's "
    + "ship (the real live adapter function): the drone return mirror never sees them", () => {
    const v = fakeVendor();
    const access = createDroneAccess({ deps: v.deps, config: {} });
    const launched = access.launch(v.scene, v.twin, { ownerCharId: OWNER, shipItemId: SHIP, itemId: STACK, seq: 5 });
    assert.strictEqual(launched.ok, true);
    const own = { itemID: 8001, kind: "drone", controllerID: HOST };
    const map = new Map([[8001, own], [launched.droneId, v.scene.entities.get(launched.droneId)]]);
    const live = createWingAdapterCore({ runtime: { scenes: new Map() }, identity: {},
      itemStore: { ITEM_FLAGS: { SHIP_HANGAR: 90 } }, fitting: {}, skills: {}, types: {}, sessions: {} });
    assert.deepStrictEqual(live.controlledDroneIds({ dynamicEntities: map }, HOST), [8001]);
    assert.deepStrictEqual(live.controlledDroneIds({ dynamicEntities: map }, TWIN), [launched.droneId]);
  });

  test("DA4 (copy drones) mining kind: droneYieldKind is the vendor name rule (ice harvesting -> ice "
    + "excavator/mining -> ore, else null); bayDrones gives {kind:mining, yieldKind} only with droneMiningEnabled and "
    + "resolveDroneMiningSnapshot present, else other", () => {
    assert.deepStrictEqual(["Mining Drone I", "Ice Harvesting Drone II", "Excavator Mining Drone", "Hobgoblin I", ""]
      .map(droneYieldKind), ["ore", "ice", "ore", null, null]);
    const MINER = 7002;
    const kindsWith = (config, withSnapshot) => {
      const v = fakeVendor();
      v.items.set(MINER, { itemID: MINER, typeID: 10246, categoryID: 18, ownerID: OWNER, locationID: SHIP,
        flagID: DRONE_BAY, singleton: 0, stacksize: 5 });
      v.deps.resolveDroneCombatSnapshot = (item) => (item.typeID === 2488 ? { durationMs: 2000 } : null);
      v.deps.resolveDroneRepairSnapshot = () => null;
      v.deps.resolveItemByTypeID = (id) => ({ name: id === 10246 ? "Mining Drone I" : "Hobgoblin I" });
      if (withSnapshot) {
        v.deps.resolveDroneMiningSnapshot = (item) => (item.typeID === 10246 ? { durationMs: 60000 } : null);
      }
      const read = createDroneAccess({ deps: v.deps, config }).bayDrones(OWNER, SHIP);
      return read.drones.map((d) => [d.itemId, d.kind, d.yieldKind || null]);
    };
    assert.deepStrictEqual(kindsWith({ droneMiningEnabled: true }, true),
      [[STACK, "combat", null], [MINER, "mining", "ore"]]);
    assert.deepStrictEqual(kindsWith({ droneMiningEnabled: false }, true),
      [[STACK, "combat", null], [MINER, "other", null]]);
    assert.deepStrictEqual(kindsWith({ droneMiningEnabled: true }, false),
      [[STACK, "combat", null], [MINER, "other", null]], "no droneMining probe = no mining deps");
  });

  test("DA5 kind salvage only with droneSalvageEnabled and the salvage deps "
    + "salvageCycle runs the vendor cycle with the drone as the entity, the host's callbacks, the locked-target true "
    + "and no salvageRewardLocationID; salvaged / miss / refusals map to the closed set", () => {
    const SALVOR = 7003;
    const WRECK = 4100000000000009;
    const make = (config, withDeps) => {
      const v = fakeVendor();
      v.items.set(SALVOR, { itemID: SALVOR, typeID: 32787, categoryID: 18, ownerID: OWNER, locationID: SHIP,
        flagID: DRONE_BAY, singleton: 0, stacksize: 2 });
      v.deps.resolveDroneCombatSnapshot = (item) => (item.typeID === 2488 ? { durationMs: 2000 } : null);
      v.deps.resolveDroneRepairSnapshot = () => null;
      v.cycles = [];
      v.out = { success: false, stopReason: "target", data: { salvaged: true } };
      if (withDeps) {
        Object.assign(v.deps, {
          resolveDroneSalvageSnapshot: (item) => (item.typeID === 32787 ? { durationMs: 10000, accessBonusPercent: 3,
            maxRangeMeters: 5000, orbitDistanceMeters: 500 } : null),
          isSalvageableTarget: (e) => e.done !== true,
          buildSalvageChanceSnapshot: (_e, bonus) => ({ chancePercent: 40 + bonus }),
          buildSalvagerRuntimeCallbacks: () => ({
            getEntityRuntimeShipItem: (e) => ({ itemID: e.itemID }), resolveSession: (e) => ({ ship: e.itemID }),
            getEntityRuntimeFittedItems: () => [], getEntityRuntimeSkillMap: () => new Map(),
            resolveCharacterID: () => 0, isEntityLockedTarget: () => false, random: () => 0.5 }),
          executeSalvagerCycle: (args) => {
            v.cycles.push(args);
            return v.out;
          },
        });
      }
      v.scene.entities.set(HOST, { itemID: HOST });
      v.scene.entities.set(WRECK, { itemID: WRECK });
      return { v, access: createDroneAccess({ deps: v.deps, config }) };
    };
    const kinds = (a) => a.access.bayDrones(OWNER, SHIP).drones.map((d) => [d.itemId, d.kind]);
    assert.deepStrictEqual(kinds(make({ droneSalvageEnabled: true }, true)), [[STACK, "combat"], [SALVOR, "salvage"]]);
    assert.deepStrictEqual(kinds(make({ droneSalvageEnabled: false }, true)), [[STACK, "combat"], [SALVOR, "other"]]);
    assert.deepStrictEqual(kinds(make({ droneSalvageEnabled: true }, false)), [[STACK, "combat"], [SALVOR, "other"]],
      "no droneSalvage probe = no salvage deps");
    const { v, access } = make({ droneSalvageEnabled: true }, true);
    const drone = { itemID: 8801, typeID: 32787 };
    const snap = access.salvageSnapshot(drone, access.makeProxy({ shipItemId: SHIP, ownerCharId: OWNER })).snapshot;
    const cycle = (wreck = WRECK, host = HOST) => access.salvageCycle(v.scene, v.twin, drone, wreck, OWNER, host,
      50000, snap);
    assert.deepStrictEqual(cycle(), { ok: true, salvaged: true, durationMs: 10000 });
    const args = v.cycles[0];
    assert.strictEqual(args.entity, drone);
    assert.deepStrictEqual(args.effectState, { moduleID: 8801, moduleFlagID: 0, typeID: 32787, targetID: WRECK,
      salvagerRangeMeters: 5000, salvageChancePercent: 43 });
    const cb = args.callbacks;
    assert.ok(!("salvageRewardLocationID" in cb), "the reward goes to the host's cargo");
    assert.deepStrictEqual([cb.isEntityLockedTarget(drone, WRECK), cb.resolveCharacterID(drone),
      cb.getEntityRuntimeShipItem(drone), cb.resolveSession(drone), cb.suppressSalvageMessages, cb.random()],
    [true, OWNER, { itemID: HOST }, { ship: HOST }, true, 0.5]);
    v.out = { success: true, data: { salvaged: false } };
    assert.deepStrictEqual(cycle(), { ok: true, salvaged: false, durationMs: 10000 });
    v.out = { success: false, stopReason: "cargo" };
    assert.deepStrictEqual(cycle(), { ok: false, reason: "CARGO" });
    v.out = { success: false, stopReason: "range" };
    assert.deepStrictEqual(cycle(), { ok: false, reason: "RANGE" });
    assert.deepStrictEqual(cycle(WRECK, 999), { ok: false, reason: "NO_HOST" });
    v.scene.entities.get(WRECK).done = true;
    assert.deepStrictEqual(cycle(), { ok: false, reason: "NO_TARGET" });
    assert.strictEqual(v.cycles.length, 4, "no vendor call without a salvageable wreck or a host");
  });
};
