"use strict";

const assert = require("node:assert");
const {
  WRAPPED, SNAPSHOT_KEYS, MINING_MODULES, createMiningHook, installMiningHookFromGame,
} = require("../../lib/adapter/miningHook");

const OWNER = 90000001;
const CORP = 98000001;
const TWIN = 4200000000000001;
const FOREIGN = 1000000400;
const ROCK = 4100000000000007;
const AIR_ROCK = 4100000000000008;
const HULK = 22544;
const ORCA = 28606;
const ORE = 1230;
const MODULE_ID = 4200000000000002;

function twinEntity() {
  return {
    itemID: TWIN, kind: "ship", typeID: HULK, ownerID: OWNER, pilotCharacterID: OWNER, characterID: 0,
    corporationID: CORP, systemID: 30000142,
    fittedItems: [{ itemID: MODULE_ID, flagID: 27, typeID: 24305, locationID: TWIN }],
    nativeCargoItems: [{ itemID: 4200000000000003, flagID: 27, typeID: 18036, moduleID: MODULE_ID }],
    skillMap: new Map([[3386, { skillLevel: 5 }]]),
  };
}

function emptyRt() {
  return { task: "MINE", hold: { capacityByFlag: new Map(), items: new Map(), usedM3: 0 } };
}

function fakeDeps(log, opts = {}) {
  return {
    buildRuntimeShipItemFromEntity: (e) => ({ itemID: e.itemID, typeID: e.typeID, ownerID: e.ownerID }),
    buildMiningModuleSnapshot: (input) => {
      log.snapshots.push(input);
      return { family: "ore", maxRangeMeters: 10000, miningAmountM3: 50, capNeed: 30, durationMs: 60000,
        durationAttributeID: 73, reactivationDelayMs: 0, maxGroupActive: 0, chargeTypeID: 18036,
        wasteVolumeMultiplier: 0, wasteProbability: 0, critQuantityMultiplier: 0, critChance: 0 };
    },
    isMiningEffectRecord: () => true,
    isMiningSnapshotCompatibleWithState: () => true,
    computeMiningResult: (o) => {
      if (opts.mathThrows) throw new Error("boom");
      const n = Math.floor((o.volume * o.clampFactor / o.unitVolume) * o.efficiency);
      return { normalQuantity: n, criticalHitQuantity: 0, wastedQuantity: 0, rewardedQuantity: n,
        getTotalTransferredQuantity() { return this.normalQuantity + this.criticalHitQuantity; } };
    },
    getMineableState: (_scene, id) => (id === ROCK || id === AIR_ROCK
      ? { yieldTypeID: ORE, yieldKind: "ore", unitVolume: 10, remainingQuantity: 1000 } : null),
    applyMiningDelta: (scene, target, normal, wasted, options) => {
      log.deltas.push({ target, normal, wasted, options });
      return opts.deltaFails ? { success: false, errorMsg: "MINEABLE_NOT_FOUND" } : { success: true, data: {} };
    },
    ensureSceneMiningState: () => ({}),
    getPreferredMiningHoldFlagForType: () => 134,
    getShipHoldCapacityByFlag: (rs, flag) => (flag === 134 ? rs.oreHold : 0),
    recordMiningLedgerEvent: (row) => log.ledger.push(row),
    isAirRock: (e) => Boolean(e && e.air === true),
    canEntitiesInteractLocally: () => true,
    collectModifierEntriesForItem: () => [],
    getLocationModifierSourcesForSystem: () => [],
    buildShipResourceState: (charId, shipItem, o) => {
      log.resource.push({ charId, shipItem, o });
      return { oreHold: opts.holdM3 === undefined ? 100 : opts.holdM3, cargoCapacity: 5 };
    },
    getEffectTypeRecord: (id) => ({ effectID: id }),
    isModuleOnline: () => true,
    isChargeCompatibleWithModule: () => true,
    buildCrystalDurabilitySnapshot: (typeID, attributes) => {
      log.crystal.push({ typeID, attributes });
      return { typeID, hitpoints: 1, crystalsGetDamaged: true };
    },
    isCrystalBurnedOut: (item, snap) => opts.burnedOut === true && snap.typeID === Number(item.typeID),
    CARGO_HOLD: 5,
  };
}

function fakeWing(rt, opts = {}) {
  const wing = {
    twinCalls: 0,
    liveTwinCount: () => (opts.empty ? 0 : 1),
    twinOf(entity) {
      wing.twinCalls += 1;
      if (opts.throws) throw new Error("boom");
      return entity && entity.itemID === TWIN ? { shipItemId: 501, ownerCharacterId: OWNER, twinEntityId: TWIN } : null;
    },
    twinTaskContext: (entity) => (entity && entity.itemID === TWIN ? rt : null),
  };
  return wing;
}

function fakeRuntime(calls) {
  const make = (name) => function vendorExport(...args) {
    calls.push({ name, self: this, args });
    return { vendor: name };
  };
  return {
    resolveMiningActivation: make("resolveMiningActivation"),
    prepareMiningCycleBoundary: make("prepareMiningCycleBoundary"),
    executeMiningCycle: make("executeMiningCycle"),
    isMiningSnapshotCompatibleWithState: () => true,
  };
}

function fakeScene(entities) {
  const byId = new Map(entities.map((e) => [e.itemID, e]));
  return { systemID: 30000142, getEntityByID: (id) => byId.get(id) || null,
    getTargetsForEntity: () => [ROCK, AIR_ROCK], getEntitySurfaceDistance: () => 100,
    getCurrentSimTimeMs: () => 5000 };
}

function setup(opts = {}) {
  const log = { snapshots: [], deltas: [], ledger: [], resource: [], crystal: [] };
  const calls = [];
  const runtime = fakeRuntime(calls);
  const rt = emptyRt();
  const wing = fakeWing(rt, opts);
  const hook = createMiningHook({ miningRuntime: runtime, deps: fakeDeps(log, opts), wing,
    config: { miningLedgerEnabled: true } });
  const installed = hook.install();
  const twin = twinEntity();
  const scene = fakeScene([twin, { itemID: ROCK, kind: "asteroid" }, { itemID: AIR_ROCK, air: true }]);
  return { log, calls, runtime, rt, wing, hook, installed, twin, scene };
}

const EFFECT = () => ({ moduleID: MODULE_ID, moduleFlagID: 27, effectID: 6728, targetID: ROCK, miningEffect: true });

module.exports = ({ test }) => {
  test("MH1 twin snapshot: vendor keys (S2-F6), characterID = owner, hull = the twin's (not the host Orca), "
    + "skillMap/fittedItems = the twin's objects, chargeItem = crystal of nativeCargoItems by moduleID; activation "
    + "and prepare never reach the vendor", () => {
    const t = setup();
    assert.deepStrictEqual(t.installed.wrapped, ["resolveMiningActivation", "prepareMiningCycleBoundary",
      "executeMiningCycle"]);
    const prepared = t.runtime.prepareMiningCycleBoundary(t.twin, EFFECT(), 1000);
    assert.strictEqual(prepared.success, true);
    assert.strictEqual(prepared.data.moduleItem, t.twin.fittedItems[0]);
    const input = t.log.snapshots[0];
    assert.deepStrictEqual(Object.keys(input), [...SNAPSHOT_KEYS]);
    assert.strictEqual(input.characterID, OWNER);
    assert.strictEqual(input.shipItem.typeID, HULK);
    assert.notStrictEqual(input.shipItem.typeID, ORCA);
    assert.strictEqual(input.skillMap, t.twin.skillMap);
    assert.strictEqual(input.fittedItems, t.twin.fittedItems);
    assert.strictEqual(input.chargeItem, t.twin.nativeCargoItems[0]);
    assert.deepStrictEqual(input.activeModuleContexts, []);

    const act = t.runtime.resolveMiningActivation(t.scene, t.twin, t.twin.fittedItems[0], { effectID: 6728 },
      { targetID: ROCK });
    assert.deepStrictEqual([act.matched, act.success, act.data.runtimeAttrs.durationMs], [true, true, 60000]);
    const refused = t.runtime.resolveMiningActivation(t.scene, t.twin, t.twin.fittedItems[0], { effectID: 6728 },
      { targetID: AIR_ROCK });
    assert.deepStrictEqual([refused.success, refused.errorMsg], [false, "TARGET_NOT_FOUND"]);
    assert.strictEqual(t.calls.length, 0, "vendor not called for a twin");
  });

  test("MH2 ore into the virtual hold (sized once: owner + twin hull + fit + skills), clipped to the free room; "
    + "full -> cargo; refused applyMiningDelta takes the ore back -> target; AIR rock -> target; ledger row", () => {
    const t = setup({ holdM3: 70 });
    const first = t.runtime.executeMiningCycle(t.scene, t.twin, EFFECT(), 1000, {});
    assert.strictEqual(first.success, true);
    assert.deepStrictEqual([first.data.transferredQuantity, first.data.stopReason, first.data.depleted],
      [5, null, false]);
    assert.deepStrictEqual(first.data.nextCycleRuntimeAttrs, { capNeed: 30, durationMs: 60000,
      durationAttributeID: 73 });
    assert.deepStrictEqual(first.data.crystalResult, { success: true, data: { damaged: false, burnedOut: false } });
    assert.strictEqual(t.log.resource.length, 1);
    assert.deepStrictEqual([t.log.resource[0].charId, t.log.resource[0].shipItem.typeID], [OWNER, HULK]);
    assert.strictEqual(t.log.resource[0].o.skillMap, t.twin.skillMap);
    assert.deepStrictEqual([t.rt.hold.items.get(ORE), t.rt.hold.usedM3], [5, 50]);
    assert.strictEqual(t.log.deltas[0].options.sourceEntity, t.twin);
    assert.deepStrictEqual([t.log.ledger[0].characterID, t.log.ledger[0].corporationID, t.log.ledger[0].quantity],
      [OWNER, CORP, 5]);

    const clipped = t.runtime.executeMiningCycle(t.scene, t.twin, EFFECT(), 2000, {});
    assert.strictEqual(clipped.data.transferredQuantity, 2, "20 m3 free / 10 m3 per unit");
    assert.deepStrictEqual([t.rt.hold.items.get(ORE), t.rt.hold.usedM3], [7, 70]);
    assert.deepStrictEqual(t.runtime.executeMiningCycle(t.scene, t.twin, EFFECT(), 3000, {}),
      { success: false, stopReason: "cargo" });
    assert.strictEqual(t.log.resource.length, 1, "hold sized once per task runtime");

    const failing = setup({ deltaFails: true });
    assert.deepStrictEqual(failing.runtime.executeMiningCycle(failing.scene, failing.twin, EFFECT(), 1000, {}),
      { success: false, stopReason: "target" });
    assert.deepStrictEqual([failing.rt.hold.items.size, failing.rt.hold.usedM3, failing.log.ledger.length], [0, 0, 0]);

    const air = setup();
    assert.deepStrictEqual(air.runtime.executeMiningCycle(air.scene, air.twin, { ...EFFECT(), targetID: AIR_ROCK },
      1000, {}), { success: false, stopReason: "target" });
    assert.strictEqual(air.log.deltas.length, 0);
    assert.strictEqual(air.hook.stats().counters["mining.cycle.stop.target"], 1);

    const burned = setup({ burnedOut: true });
    assert.deepStrictEqual(burned.runtime.executeMiningCycle(burned.scene, burned.twin, EFFECT(), 1000, {}),
      { success: false, stopReason: "ammo" });
    assert.deepStrictEqual([burned.log.deltas.length, burned.rt.hold.usedM3], [0, 0]);
    assert.strictEqual(burned.log.crystal[0].typeID, 18036, "durability snapshot of snapshot.chargeTypeID");
    assert.strictEqual(burned.hook.stats().counters["mining.cycle.stop.ammo"], 1);
    assert.strictEqual(t.hook.stats().counters["mining.cycle.stop.ammo"], 0, "a sound crystal mines");
  });

  test("MH3 non-twin and zero twins -> the vendor once with the same this/args and its result; twin cycle throw -> "
    + "{success:false, stopReason:mining} + mining.cycle.error; second install refused MINING_ALREADY_INSTALLED "
    + "chain over a foreign wrap",
  () => {
    const t = setup();
    const self = { tag: "caller" };
    const foreign = { itemID: FOREIGN, kind: "ship" };
    const args = [t.scene, foreign, EFFECT(), 1000, { efficiency: 1 }];
    const out = t.runtime.executeMiningCycle.apply(self, args);
    assert.deepStrictEqual(out, { vendor: "executeMiningCycle" });
    assert.strictEqual(t.calls.length, 1);
    assert.strictEqual(t.calls[0].self, self);
    assert.deepStrictEqual(t.calls[0].args, args);
    assert.strictEqual(t.calls[0].args[1], foreign);

    const empty = setup({ empty: true });
    empty.runtime.prepareMiningCycleBoundary(empty.twin, EFFECT(), 1000);
    assert.deepStrictEqual([empty.calls.length, empty.wing.twinCalls], [1, 0], "fast path: no twin lookup");

    const broken = setup({ mathThrows: true });
    assert.deepStrictEqual(broken.runtime.executeMiningCycle(broken.scene, broken.twin, EFFECT(), 1000, {}),
      { success: false, stopReason: "mining" });
    assert.strictEqual(broken.hook.stats().counters["mining.cycle.error"], 1);
    assert.deepStrictEqual([broken.rt.hold.usedM3, broken.calls.length], [0, 0]);

    const failOpen = setup({ throws: true });
    failOpen.runtime.executeMiningCycle(failOpen.scene, failOpen.twin, EFFECT(), 1000, {});
    assert.deepStrictEqual([failOpen.calls.length, failOpen.hook.stats().counters["mining.hook.error"]], [1, 1]);

    const calls = [];
    const runtime = fakeRuntime(calls);
    const vendor = runtime.executeMiningCycle;
    let below = 0;
    const mark = Symbol.for("otherMod.mark");
    runtime.executeMiningCycle = function otherMod(...a) {
      below += 1;
      return vendor.apply(this, a);
    };
    runtime.executeMiningCycle[mark] = true;
    const rt = emptyRt();
    const log = { snapshots: [], deltas: [], ledger: [], resource: [], crystal: [] };
    const firstHook = createMiningHook({ miningRuntime: runtime, deps: fakeDeps(log), wing: fakeWing(rt) });
    const first = firstHook.install();
    const ours = runtime.executeMiningCycle;
    assert.deepStrictEqual([first.ok, ours[WRAPPED], ours[mark]], [true, true, true]);
    assert.deepStrictEqual(firstHook.install(), { ok: false, reason: "MINING_ALREADY_INSTALLED" });
    const again = createMiningHook({ miningRuntime: runtime, deps: fakeDeps(log), wing: fakeWing(rt) }).install();
    assert.deepStrictEqual(again, { ok: false, reason: "MINING_ALREADY_INSTALLED" });
    assert.strictEqual(runtime.executeMiningCycle, ours, "no second layer");
    runtime.executeMiningCycle(fakeScene([]), { itemID: FOREIGN, kind: "ship" }, EFFECT(), 1, {});
    const twin = twinEntity();
    runtime.executeMiningCycle(fakeScene([twin, { itemID: ROCK }]), twin, EFFECT(), 1, {});
    assert.deepStrictEqual([below, calls.length], [1, 1], "foreign once through the chain, twin never");
  });

  test("MH4 loader entry: probe `mining` off -> probe_mining_unavailable; a module that does not load -> "
    + "require_failed; all loaded -> three wraps on the module object", () => {
    const rt = emptyRt();
    const wing = fakeWing(rt);
    const runtime = fakeRuntime([]);
    const exportsOf = (rel) => {
      if (rel === MINING_MODULES.miningRuntime) return runtime;
      if (rel === MINING_MODULES.itemStore) return { ITEM_FLAGS: { CARGO_HOLD: 5 } };
      return {};
    };
    const game = (available, failRel) => ({
      isConsumerAvailable: (name) => available && name === "mining",
      requireGame: (rel) => (rel === failRel
        ? { ok: false, reason: "not_booted" } : { ok: true, exports: exportsOf(rel) }),
    });
    assert.deepStrictEqual(installMiningHookFromGame(game(false), { wing }),
      { ok: false, reason: "probe_mining_unavailable" });
    assert.deepStrictEqual(installMiningHookFromGame(game(true, MINING_MODULES.miningLedgerState), { wing }),
      { ok: false, reason: "require_failed:services/mining/miningLedgerState:not_booted" });
    const ok = installMiningHookFromGame(game(true), { wing, config: {} });
    assert.deepStrictEqual([ok.ok, ok.wrapped.length], [true, 3]);
    assert.strictEqual(runtime.executeMiningCycle[WRAPPED], true);
  });

  test("MH5 (copy drones) droneCycle: the drone ore into the twin's virtual hold through the twin's "
    + "settlement (delta with sourceDroneID and the drone type, ledger with the drone type and the twin hull); a full "
    + "hold -> NO_ROOM without a delta; a refused delta -> TARGET and the ore out again; an ice drone on ore -> KIND",
  () => {
    const DRONE_TYPE = 10246;
    const drone = { itemID: 9100, typeID: DRONE_TYPE, groupID: 101, itemName: "Mining Drone I" };
    const input = (yieldKind) => ({ snapshot: { miningAmountM3: 50, wasteVolumeMultiplier: 0, wasteProbability: 0 },
      yieldKind });
    const t = setup();
    assert.deepStrictEqual(t.hook.droneRock(t.scene, ROCK), { ok: true, yieldKind: "ore", remaining: 1000 });
    assert.deepStrictEqual(t.hook.droneCycle(t.scene, t.twin, drone, input("ore"), ROCK, 7000),
      { ok: true, typeId: ORE, quantity: 5, wasted: 0, volumeM3: 50, depleted: false });
    assert.deepStrictEqual([t.rt.hold.items.get(ORE), t.rt.hold.usedM3], [5, 50]);
    const opts = t.log.deltas[0].options;
    assert.deepStrictEqual([opts.sourceDroneID, opts.moduleTypeID, opts.moduleItemID, opts.sourceEntity, opts.nowMs,
      opts.moduleItem.typeID], [9100, DRONE_TYPE, 9100, t.twin, 7000, DRONE_TYPE]);
    assert.deepStrictEqual([t.log.ledger[0].moduleTypeID, t.log.ledger[0].shipTypeID, t.log.ledger[0].characterID,
      t.log.ledger[0].quantity], [DRONE_TYPE, HULK, OWNER, 5]);
    assert.deepStrictEqual(t.hook.droneCycle(t.scene, t.twin, drone, input("ice"), ROCK, 8000),
      { ok: false, reason: "KIND" });
    assert.strictEqual(t.log.deltas.length, 1, "KIND touches nothing");

    const full = setup({ holdM3: 0 });
    assert.deepStrictEqual(full.hook.droneCycle(full.scene, full.twin, drone, input("ore"), ROCK, 7000),
      { ok: false, reason: "NO_ROOM" });
    assert.strictEqual(full.log.deltas.length, 0);

    const refused = setup({ deltaFails: true });
    assert.deepStrictEqual(refused.hook.droneCycle(refused.scene, refused.twin, drone, input("ore"), ROCK, 7000),
      { ok: false, reason: "TARGET" });
    assert.deepStrictEqual([refused.rt.hold.items.size, refused.rt.hold.usedM3, refused.log.ledger.length], [0, 0, 0]);
  });
};
