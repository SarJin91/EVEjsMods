"use strict";

const assert = require("node:assert");
const path = require("node:path");
const {
  createMineEngine, MINE_SUB, ENGINE_COUNTER_NAMES, OVERFLOW_END_REASONS, sizeHold, holdSpace, holdAdd,
} = require("../../lib/core/miningTask");
const { END_REASON } = require("../../lib/core/reasons");
const { createWingTasks } = require("../../lib/core/wingTasks");
const { createMiningAccess, createMiningAccessFromGame } = require("../../lib/adapter/miningAccess");
const { createAdapter } = require("../../lib/adapter/index");
const { GAME_MODULES } = require("../../lib/adapter/gameModules");
const { SCENE_MODULE, installSceneGuardFromGame } = require("../../lib/adapter/sceneGuard");
const { createTwinScene } = require("../../lib/adapter/twinScene");
const { enabledVerbs } = require("../../lib/core/wingService");
const { createChatChannel } = require("../../lib/channels/chat");
const { taskReadyFor } = require("../../loader");
const { resolveConfig } = require("../../config");
const { fixtures } = require("./wingService.test");

const MOD_DIR = path.join(__dirname, "..", "..");
const OWNER = 90000001;
const STRANGER = 90000009;
const HOST = 1000000400;
const SYSTEM = 30000142;
const ORE = 1230;
const UNIT = 10;
const MINER = 17482;
const ORE_HOLD = 134;
const FLEET_HANGAR = 155;

function config(extra = {}) {
  return { ...resolveConfig({ modDir: MOD_DIR, env: { EVEJS_SHIPWING_ENABLED: "1" } }).config, miningEnabled: true,
    ...extra };
}

function at(x, y = 0) {
  return { x, y, z: 0 };
}

function twinEntity(itemID, x = 0) {
  return { itemID, kind: "ship", typeID: 22544, pilotCharacterID: OWNER, characterID: 0, corporationID: 98000001,
    allianceID: 0, systemID: SYSTEM, position: at(x, 100), radius: 50, activeModuleEffects: new Map(),
    fittedItems: [{ itemID: itemID + 1, typeID: MINER, flagID: 27, locationID: itemID }] };
}

function rock(itemID, x, y = 0) {
  return { itemID, kind: "asteroid", staticVisibilityScope: "bubble", position: at(x, y), radius: 100 };
}

function fakeWorld(opts = {}) {
  const w = { calls: [], grants: [], emits: [], states: new Map(), locks: new Map(), hostItems: [], refuse: null,
    lockRefuse: null, grantFail: false, hostRS: { oreHold: 30, fleetHangarCapacity: 50 } };
  const host = { itemID: HOST, position: at(0), radius: 500 };
  w.host = host;
  w.items = new Map([[HOST, { itemID: HOST, ownerID: OWNER, categoryID: 6, locationID: SYSTEM }]]);
  const scene = {
    systemID: SYSTEM,
    entities: new Map([[HOST, host]]),
    getEntityByID: (id) => scene.entities.get(Number(id)) || null,
    getCurrentSimTimeMs: () => 5000,
    getEntitySurfaceDistance: (a, b) => Math.hypot(a.position.x - b.position.x, a.position.y - b.position.y)
      - (a.radius || 0) - (b.radius || 0),
    getTargetsForEntity: (e) => [...(w.locks.get(e.itemID) || [])],
    getSortedPendingTargetLocks: () => [],
    cancelPendingTargetLock: () => false,
    removeLockedTarget: (e, id) => (w.locks.get(e.itemID) || new Set()).delete(id),
    finalizeTargetLock(e, target) {
      w.calls.push(["lock", e.itemID, target.itemID]);
      if (w.lockRefuse) return { success: false, errorMsg: w.lockRefuse };
      if (!w.locks.has(e.itemID)) w.locks.set(e.itemID, new Set());
      w.locks.get(e.itemID).add(target.itemID);
      return { success: true, data: {} };
    },
    followShipEntity(e, targetId, range) {
      w.calls.push(["follow", e.itemID, targetId, range]);
      return true;
    },
    orbitShipEntity(e, targetId, range) {
      w.calls.push(["orbit", e.itemID, targetId, range]);
      e.mode = "ORBIT";
      e.targetEntityID = targetId;
      return true;
    },
    stopShipEntity: () => true,
    activateGenericModule(session, moduleItem, effectName, o) {
      w.calls.push(["activate", session, moduleItem.itemID, effectName, o.targetID]);
      if (w.refuse) return { success: false, errorMsg: w.refuse };
      scene.entities.get(session._space.shipID).activeModuleEffects.set(moduleItem.itemID, { targetID: o.targetID });
      return { success: true, data: {} };
    },
    deactivateGenericModule(session, moduleID) {
      w.calls.push(["deactivate", session._space.shipID, moduleID]);
      return { success: scene.entities.get(session._space.shipID).activeModuleEffects.delete(moduleID) };
    },
    getEntityTargetingStats: () => ({ maxTargetRange: 20000 }),
    getGridBubbleIDForPosition: () => 7,
    getStaticEntitiesInBubble: () => [...scene.entities.values()].filter((e) => e.kind === "asteroid"),
  };
  w.scene = scene;
  w.addRock = (ent, remaining = 1000) => {
    scene.entities.set(ent.itemID, ent);
    w.states.set(ent.itemID, { remainingQuantity: remaining, yieldTypeID: ORE, yieldKind: "ore", unitVolume: UNIT });
  };
  w.deps = {
    isMineableStaticEntity: (e) => Boolean(e && e.kind === "asteroid"),
    getMineableState: (_s, id) => w.states.get(id) || null,
    ensureSceneMiningState: () => ({}),
    isAirRock: (e) => e.air === true,
    canEntitiesInteractLocally: () => true,
    resolveMiningFamily: () => "ore",
    isMiningEffectRecord: (r) => r.name === "miningLaser",
    buildMiningModuleSnapshot: () => ({ maxRangeMeters: 10000 }),
    getTypeEffectRecords: (typeID) => (typeID === MINER ? [{ name: "online" }, { name: "miningLaser" }] : []),
    isModuleOnline: () => true,
    buildShipResourceState: () => w.hostRS,
    getPreferredMiningHoldFlagForType: (rs) => (rs.oreHold > 0 ? ORE_HOLD : null),
    getShipHoldCapacityByFlag: (rs, flag) => (flag === ORE_HOLD ? rs.oreHold : 0),
    isItemTypeAllowedInHoldFlag: (_t, flag) => flag === ORE_HOLD,
    getFleetHangarCapacity: (rs) => rs.fleetHangarCapacity,
    grantItemsToCharacterLocation(charId, locationId, flagId, entries) {
      w.grants.push({ charId, locationId, flagId, entries });
      if (w.grantFail) return { success: false, errorMsg: "TEST" };
      w.hostItems.push({ flagID: flagId, typeID: entries[0].itemType, volume: UNIT, stacksize: entries[0].quantity,
        singleton: 0 });
      return { success: true, data: { changes: [{ item: { flagID: flagId, quantity: entries[0].quantity } }] } };
    },
    listContainerItems: (_owner, locationId, flagId) => (locationId === HOST
      ? w.hostItems.filter((i) => i.flagID === flagId) : []),
    findItemById: (id) => w.items.get(id) || null,
    buildRuntimeShipItemFromEntity: (e) => ({ itemID: e.itemID, typeID: e.typeID }),
    collectModifierEntriesForItem: () => [],
    getLocationModifierSourcesForSystem: () => [],
    FLEET_HANGAR,
    emit: (owner, changes) => w.emits.push([owner, changes.length]),
  };
  const twinScene = createTwinScene();
  const cfg = config(opts.config);
  if (opts.realCargo) {
    w.deps.SHIP_HANGAR = 90;
    w.deps.CARGO_HOLD = 5;
    w.items.set(501, { itemID: 501, ownerID: OWNER, categoryID: 6, singleton: 1, locationID: HOST, flagID: 90 });
  }
  if (opts.overflow) {
    w.cans = [];
    w.deps.overflow = {
      createSpaceItemForCharacter(owner, systemId, type, o) {
        const itemID = 9100000000 + w.cans.length;
        w.cans.push({ itemID, owner, systemId, typeID: type.typeID, position: o.position });
        return { success: true, data: { itemID } };
      },
      removeInventoryItem: () => ({ success: true }),
      spawnDynamicInventoryEntity(_d, itemID) {
        const can = w.cans.find((c) => c.itemID === itemID);
        scene.entities.set(itemID, { itemID, kind: "container", position: can.position, radius: 10 });
        return { success: true, data: {} };
      },
      buildChildEntityScopeMetadata: () => ({}),
      resolveItemByTypeID: (typeID) => ({ typeID, capacity: 27500 }),
      JETCAN_TYPE_ID: 23,
      CONTENT_FLAG: 0,
    };
  }
  const real = createMiningAccess({ deps: w.deps, scene: twinScene, config: cfg });
  w.picks = 0;
  w.unloads = 0;
  w.order = [];
  const access = { ...real,
    pickRock: (...a) => {
      w.picks += 1;
      return real.pickRock(...a);
    },
    unload: (...a) => {
      w.unloads += 1;
      return real.unload(...a);
    },
    deposit: (...a) => {
      w.order.push("deposit");
      return real.deposit(...a);
    },
    jettison: (...a) => {
      w.order.push("jettison");
      return real.jettison(...a);
    } };
  w.blocked = new Set();
  const engine = createMineEngine({ access, scene: twinScene, config: cfg,
    hookReady: () => opts.hookReady !== false, isBlocked: (id) => w.blocked.has(id) });
  w.engine = engine;
  w.access = access;
  w.tasks = createWingTasks({ engines: { mine: engine }, config: cfg });
  w.config = cfg;
  return w;
}

function record(shipItemId, twinId) {
  return { shipItemId, ownerCharacterId: OWNER, hostShipId: HOST, twinEntityId: twinId, state: "ACTIVE" };
}

function deploy(w, shipItemId, twin, targetId = null) {
  w.scene.entities.set(twin.itemID, twin);
  const rec = record(shipItemId, twin.itemID);
  w.tasks.start(rec);
  const out = w.tasks.order(rec, null, "mine", { targetId, twin, scene: w.scene, record: rec });
  assert.deepStrictEqual(out, { ok: true, task: "MINE" });
  return rec;
}

function step(w, rec, twin, nowMs) {
  return w.tasks.step(rec, null, { twin, host: w.host, nowMs, scene: w.scene });
}

function fillHold(rt, quantity, capM3 = 1000) {
  sizeHold(rt.hold, {});
  const space = holdSpace(rt.hold, ORE, { flagOf: () => ORE_HOLD, capacityOf: () => capM3 });
  assert.strictEqual(holdAdd(rt.hold, space.flag, ORE, quantity, UNIT).ok, true);
}

function stubEngine(opts = {}) {
  const log = { unloads: [], events: opts.events || [] };
  const access = {
    miningModules: (twin) => (opts.noModule && opts.noModule.has(twin.itemID) ? []
      : [{ module: { itemID: 1 }, effectName: "miningLaser", effectRecord: {}, family: "ore" }]),
    checkTarget: (_s, _t, id) => (id === 999 ? { ok: false, reason: "TARGET_INVALID" } : { ok: true }),
    pickRock: () => null,
    rockDistanceM: () => ({ ok: false, reason: "NO_HOST" }),
    rockState: () => null,
    workRangeM: () => 9500,
    holdFill: () => ({ pct: 0, freeForType: () => Infinity }),
    unload(hold, o) {
      log.unloads.push(o);
      log.events.push("unload");
      const qty = hold.items.get(ORE) || 0;
      require("../../lib/core/miningTask").holdTake(hold, hold.flagByType.get(ORE), ORE, qty, UNIT);
      return { ok: true, movedM3: qty * UNIT, leftM3: hold.usedM3, changes: [], grantFailed: 0 };
    },
  };
  const scene = { simNow: () => 0, entity: () => null, surfaceDistance: () => Infinity, lock: () => ({ ok: true }),
    approach: () => true, followHost: () => true, stop: () => true, activate: () => ({ ok: true }),
    deactivate: () => true, activeEffect: () => null, targetsOf: () => [], lockRange: () => 0 };
  const holder = { svc: null };
  const engine = createMineEngine({ access, scene, config: config(opts.config),
    hookReady: () => opts.hookReady !== false, isBlocked: (id) => Boolean(holder.svc && holder.svc.isBlocked(id)) });
  return { engine, log, holder };
}

module.exports = ({ test }) => {
  test("ME1 SEEK picks the least distance+claims (2 twins -> 2 rocks at equal distance); APPROACH -> LOCK -> MINING "
    + "(pseudo-session characterID 0); rock depleted -> SEEK; hold >= unloadAtPercent or no room for the ore -> "
    + "UNLOAD_TRAVEL -> UNLOAD", () => {
    const w = fakeWorld();
    w.addRock(rock(5001, 12000));
    w.addRock(rock(5002, -12000));
    const t1 = twinEntity(4200000000000010);
    const t2 = twinEntity(4200000000000020);
    const r1 = deploy(w, 501, t1);
    const r2 = deploy(w, 502, t2);
    const rt1 = w.tasks.context(501);
    const rt2 = w.tasks.context(502);
    assert.deepStrictEqual([rt1.sub, w.tasks.view(501).sub], ["SEEK", "SEEK"]);
    step(w, r1, t1, 1000);
    step(w, r2, t2, 1000);
    assert.deepStrictEqual([rt1.sub, rt1.mine.rockId, rt2.sub, rt2.mine.rockId],
      ["APPROACH", 5001, "APPROACH", 5002], "equal distance: the claim penalty sends the 2nd twin elsewhere");

    step(w, r1, t1, 1500);
    step(w, r1, t1, 2000);
    assert.deepStrictEqual(w.calls.filter((c) => c[0] === "orbit" || c[0] === "follow"),
      [["orbit", t1.itemID, 5001, 9000]], "one approach per target");
    t1.position = at(4000, 100);
    step(w, r1, t1, 2500);
    assert.strictEqual(rt1.sub, "LOCK");
    step(w, r1, t1, 3000);
    assert.strictEqual(rt1.sub, "MINING");
    const act = w.calls.find((c) => c[0] === "activate");
    assert.deepStrictEqual([act[1].characterID, act[1]._space.shipID, act[2], act[3], act[4]],
      [0, t1.itemID, t1.itemID + 1, "miningLaser", 5001], "Pseudo-session, mining effect, rock");
    const before = w.calls.length;
    step(w, r1, t1, 3500);
    assert.strictEqual(w.calls.length, before, "an active effect on the rock: nothing to do");

    w.states.get(5001).remainingQuantity = 0;
    step(w, r1, t1, 4000);
    assert.deepStrictEqual([rt1.sub, t1.activeModuleEffects.size], ["SEEK", 0]);
    assert.ok(w.calls.some((c) => c[0] === "deactivate" && c[1] === t1.itemID));

    w.addRock(rock(5003, 3000));
    step(w, r1, t1, 5000);
    assert.deepStrictEqual([rt1.sub, rt1.mine.rockId], ["APPROACH", 5003]);
    step(w, r1, t1, 5500);
    step(w, r1, t1, 6000);
    assert.strictEqual(rt1.sub, "MINING");

    fillHold(rt1, 9, 95);
    step(w, r1, t1, 6500);
    assert.strictEqual(rt1.sub, "UNLOAD_TRAVEL");
    assert.deepStrictEqual(w.calls[w.calls.length - 1], ["follow", t1.itemID, HOST, 1250], "transfer range / 2");
    assert.strictEqual(t1.activeModuleEffects.size, 0, "modules off before the trip");
    step(w, r1, t1, 7000);
    assert.strictEqual(rt1.sub, "UNLOAD_TRAVEL", "still 3350 m from the host");
    w.hostRS = { oreHold: 1000, fleetHangarCapacity: 1000 };
    t1.position = at(1000, 100);
    step(w, r1, t1, 7500);
    assert.deepStrictEqual([rt1.sub, rt1.hold.usedM3, w.grants.length], ["SEEK", 0, 1], "all in the Ore Hold");
    assert.strictEqual(w.engine.stats().counters["mining.unload.ok"], 1);

    t2.position = at(-4000, 100);
    step(w, r2, t2, 8000);
    step(w, r2, t2, 8500);
    assert.strictEqual(rt2.sub, "MINING");
    fillHold(rt2, 95, 1000);
    step(w, r2, t2, 9000);
    assert.strictEqual(rt2.sub, "UNLOAD_TRAVEL", "95 % >= miningUnloadAtPercent with room left");
    assert.deepStrictEqual(MINE_SUB, ["SEEK", "APPROACH", "LOCK", "MINING", "UNLOAD_TRAVEL", "UNLOAD", "FULL"]);
  });

  test("ME2 unload: Ore Hold then Fleet Hangar (capacity of getFleetHangarCapacity), never flag 5/90 nor another "
    + "ship, room = capacity - items there; host full -> FULL with the rest in the twin; blocked or foreign host -> "
    + "nothing granted; beforeEnd(RECALL_DONE) twice -> the ore granted once", () => {
    const w = fakeWorld();
    const twin = twinEntity(4200000000000010);
    const rec = deploy(w, 501, twin);
    const rt = w.tasks.context(501);
    w.hostItems.push({ flagID: ORE_HOLD, typeID: 34, volume: 0.01, stacksize: 1000, singleton: 0 });
    fillHold(rt, 10);
    rt.sub = "UNLOAD";
    twin.position = at(1000, 100);
    step(w, rec, twin, 1000);
    assert.deepStrictEqual(w.grants.map((g) => [g.charId, g.locationId, g.flagId, g.entries[0].quantity]),
      [[OWNER, HOST, ORE_HOLD, 2], [OWNER, HOST, FLEET_HANGAR, 5]]);
    assert.deepStrictEqual([rt.sub, rt.hold.items.get(ORE), rt.hold.usedM3], ["FULL", 3, 30]);
    assert.deepStrictEqual(w.emits, [[OWNER, 2]], "one emit of the changes to the owner");
    let c = w.engine.stats().counters;
    assert.deepStrictEqual([c["mining.full"], c["mining.unload.partial"]], [1, 1]);
    step(w, rec, twin, 2000);
    assert.strictEqual(w.grants.length, 2, "FULL waits miningFullRetryMs");
    w.hostRS = { oreHold: 30, fleetHangarCapacity: 80 };
    step(w, rec, twin, 1000 + w.config.miningFullRetryMs);
    assert.deepStrictEqual([w.grants.length, w.grants[2].flagId, rt.sub, rt.hold.usedM3], [3, FLEET_HANGAR, "SEEK", 0]);

    fillHold(rt, 4);
    w.hostRS = { oreHold: 30, fleetHangarCapacity: 1000 };
    w.tasks.beforeEnd(rec, { scene: w.scene }, "RECALL_DONE");
    w.tasks.beforeEnd(rec, { scene: w.scene }, "RECALL_DONE");
    assert.deepStrictEqual([w.grants.length, w.grants[3].entries[0].quantity, rt.hold.usedM3], [4, 4, 0],
      "granted once, the hold is empty for the repeat");
    const again = w.access.unload(rt.hold, { ownerCharacterId: OWNER, hostShipId: HOST, systemId: SYSTEM });
    assert.deepStrictEqual([again.ok, again.movedM3, w.grants.length], [true, 0, 4], "the access itself: idempotent");
    fillHold(rt, 1);
    w.tasks.beforeEnd(rec, { scene: w.scene }, "LOGOFF");
    assert.strictEqual(w.unloads, 4, "no unload at another end (2 steps + 1 beforeEnd + 1 direct)");

    w.blocked.add(HOST);
    w.tasks.beforeEnd(rec, { scene: w.scene }, "RECALL_DONE");
    w.blocked.clear();
    w.items.set(HOST, { itemID: HOST, ownerID: STRANGER, categoryID: 6, locationID: SYSTEM });
    w.tasks.beforeEnd(rec, { scene: w.scene }, "RECALL_DONE");
    w.items.set(HOST, { itemID: HOST, ownerID: OWNER, categoryID: 6, locationID: 60003760 });
    w.tasks.beforeEnd(rec, { scene: w.scene }, "RECALL_DONE");
    assert.strictEqual(w.grants.length, 4);
    c = w.engine.stats().counters;
    assert.strictEqual(c["mining.unload.hostInvalid"], 3);
    assert.ok(w.grants.every((g) => g.locationId === HOST && g.flagId !== 5 && g.flagId !== 90));

    w.items.set(HOST, { itemID: HOST, ownerID: OWNER, categoryID: 6, locationID: SYSTEM });
    w.hostRS = { oreHold: 1000, fleetHangarCapacity: 1000 };
    w.grantFail = true;
    w.tasks.beforeEnd(rec, { scene: w.scene }, "RECALL_DONE");
    assert.deepStrictEqual([rt.hold.usedM3, w.engine.stats().counters["mining.unload.grantFailed"]], [10, 1]);

    w.grantFail = false;
    assert.strictEqual(w.tasks.order(rec, null, "hold", { scene: w.scene, record: rec }).ok, true);
    w.tasks.beforeEnd(rec, { scene: w.scene }, "RECALL_DONE");
    assert.deepStrictEqual([rt.task, rt.hold.usedM3, w.grants.length], ["HOLD", 0, 6], "5 = 4 granted + 1 failed");
    w.tasks.drop(501, "RECALL_DONE");
    assert.deepStrictEqual([w.engine.stats().counters["mining.oreLostM3"], w.engine.stats().claims], [0, 0]);
  });

  test("ME-B1 (board) beforeEnd(BOARDED) unloads the virtual hold to the host as RECALL_DONE", () => {
    const w = fakeWorld();
    const twin = twinEntity(4200000000000011);
    const rec = deploy(w, 501, twin);
    const rt = w.tasks.context(501);
    w.hostRS = { oreHold: 30, fleetHangarCapacity: 1000 };
    fillHold(rt, 4);
    w.tasks.beforeEnd(rec, { scene: w.scene }, "BOARDED");
    assert.deepStrictEqual([w.grants.every((g) => g.locationId === HOST),
      w.grants.reduce((n, g) => n + g.entries[0].quantity, 0), rt.hold.usedM3], [true, 4, 0]);
  });

  test("ME-OF1 host full + overflow on -> the rest into the pilot's jetcan, SEEK, mining.overflow.ok, no "
    + "mining.full; overflow off -> FULL as before", () => {
    for (const enabled of [true, false]) {
      const w = fakeWorld({ overflow: true, config: { miningOverflowCanEnabled: enabled } });
      const twin = twinEntity(4200000000000012);
      const rec = deploy(w, 501, twin);
      const rt = w.tasks.context(501);
      w.hostRS = { oreHold: 0, fleetHangarCapacity: 0 };
      fillHold(rt, 10);
      rt.sub = "UNLOAD";
      step(w, rec, twin, 1000);
      const c = w.engine.stats().counters;
      if (enabled) {
        assert.deepStrictEqual([rt.sub, rt.hold.usedM3, w.cans.length, w.cans[0].owner], ["SEEK", 0, 1, OWNER]);
        const can = w.grants.find((g) => g.locationId === w.cans[0].itemID);
        assert.deepStrictEqual([can.charId, can.flagId, can.entries[0].quantity], [OWNER, 0, 10]);
        assert.deepStrictEqual([c["mining.overflow.ok"], c["mining.overflow.canNew"], c["mining.overflow.m3"],
          c["mining.full"]], [1, 1, 100, 0]);
      } else {
        assert.deepStrictEqual([rt.sub, rt.hold.usedM3, w.cans.length, c["mining.full"], c["mining.overflow.ok"]],
          ["FULL", 100, 0, 1, 0]);
      }
    }
  });

  test("ME-OF2 beforeEnd(WARP) with ore -> one jettison, mining.oreLostM3 0; RESTART -> no jettison, the ore "
    + "lost as before; OVERFLOW_END_REASONS is a part of END_REASON", () => {
    const w = fakeWorld({ overflow: true });
    const twin = twinEntity(4200000000000013);
    const rec = deploy(w, 501, twin);
    const rt = w.tasks.context(501);
    fillHold(rt, 4);
    w.tasks.beforeEnd(rec, { scene: w.scene }, "WARP");
    w.tasks.beforeEnd(rec, { scene: w.scene }, "WARP");
    w.tasks.drop(501, "WARP");
    let c = w.engine.stats().counters;
    assert.deepStrictEqual([w.cans.length, w.grants.length, rt.hold.usedM3, c["mining.overflow.onEnd"],
      c["mining.oreLostM3"]], [1, 1, 0, 1, 0]);

    const w2 = fakeWorld({ overflow: true });
    const twin2 = twinEntity(4200000000000014);
    const rec2 = deploy(w2, 502, twin2);
    fillHold(w2.tasks.context(502), 4);
    w2.tasks.beforeEnd(rec2, { scene: w2.scene }, "RESTART");
    w2.tasks.drop(502, "RESTART");
    c = w2.engine.stats().counters;
    assert.deepStrictEqual([w2.cans.length, c["mining.overflow.onEnd"], c["mining.oreLostM3"]], [0, 0, 40]);
    assert.ok(OVERFLOW_END_REASONS.every((r) => END_REASON.includes(r)));
    for (const r of ["RESTART", "SCENE_GONE", "TWIN_GONE", "LAUNCH_ABORTED", "RECALL_DONE", "BOARDED"]) {
      assert.ok(!OVERFLOW_END_REASONS.includes(r), r);
    }
  });

  test("ME-RC1 flag off -> no deposit call; flag on: FULL whose hold the "
    + "deposit emptied -> SEEK, the ore in the real ship 501, the next deposit after miningRealCargoIntervalMs; "
    + "beforeEnd(WARP) deposits before the jetcan", () => {
    const off = fakeWorld({ realCargo: true, overflow: true });
    const offTwin = twinEntity(4200000000000015);
    const offRec = deploy(off, 501, offTwin);
    const offRt = off.tasks.context(501);
    fillHold(offRt, 4);
    offRt.sub = "FULL";
    offRt.nextActionAtMs = 1e9;
    step(off, offRec, offTwin, 1000);
    off.tasks.beforeEnd(offRec, { scene: off.scene }, "WARP");
    assert.deepStrictEqual(off.order, ["jettison"], "flag off: no deposit, the jetcan as before");

    const w = fakeWorld({ realCargo: true, config: { miningRealCargoEnabled: true } });
    w.hostRS = { oreHold: 1000, fleetHangarCapacity: 0 };
    const twin = twinEntity(4200000000000016);
    const rec = deploy(w, 501, twin);
    const rt = w.tasks.context(501);
    fillHold(rt, 4);
    rt.sub = "FULL";
    rt.nextActionAtMs = 1e9;
    step(w, rec, twin, 1000);
    assert.deepStrictEqual([rt.sub, rt.hold.usedM3, w.grants.map((g) => [g.locationId, g.flagId,
      g.entries[0].quantity])], ["SEEK", 0, [[501, ORE_HOLD, 4]]]);
    let c = w.engine.stats().counters;
    assert.deepStrictEqual([c["mining.real.deposit"], c["mining.real.m3"], c["mining.real.own"], c["mining.full"]],
      [1, 40, 40, 0]);
    fillHold(rt, 1);
    step(w, rec, twin, 2000);
    assert.strictEqual(w.order.length, 1, "the interval holds the next deposit");
    step(w, rec, twin, 1000 + w.config.miningRealCargoIntervalMs);
    assert.deepStrictEqual([w.order.length, rt.hold.usedM3], [2, 0]);
    w.hostRS = { oreHold: 0, fleetHangarCapacity: 0 };
    fillHold(rt, 1);
    step(w, rec, twin, 1000 + 2 * w.config.miningRealCargoIntervalMs);
    assert.deepStrictEqual([w.order.length, w.engine.stats().counters["mining.real.deposit"]], [3, 2]);

    const e = fakeWorld({ realCargo: true, overflow: true, config: { miningRealCargoEnabled: true } });
    const eTwin = twinEntity(4200000000000017);
    const eRec = deploy(e, 501, eTwin);
    fillHold(e.tasks.context(501), 4);
    e.tasks.beforeEnd(eRec, { scene: e.scene }, "WARP");
    assert.deepStrictEqual(e.order, ["deposit", "jettison"]);
    assert.deepStrictEqual(e.grants.map((g) => [g.locationId === 501, g.entries[0].quantity]), [[true, 3], [false, 1]]);
    c = e.engine.stats().counters;
    assert.deepStrictEqual([c["mining.real.onEnd"], c["mining.real.partial"], c["mining.overflow.onEnd"]], [1, 1, 1]);
  });

  test("ME3 core: RECALL_DONE -> unload before the condition write-back and the remove, a retried end unloads once; "
    + "LOGOFF and a loss in RETURNING -> no unload, mining.oreLostM3 counted once each", () => {
    const events = [];
    const stub = stubEngine({ events, config: { maxWingPerPilot: 3 } });
    const t = fixtures.setup({ config: { miningEnabled: true, maxWingPerPilot: 3 }, taskReady: () => true,
      taskEngines: { mine: stub.engine } });
    stub.holder.svc = t.svc;
    t.w.scene.systemID = fixtures.SYSTEM;
    try {
      for (const id of [501, 502, 503]) {
        assert.strictEqual(t.svc.orderCopy(fixtures.CHAR, id, "launch", { commandId: "c" }).ok, true);
        assert.strictEqual(t.svc.orderCopy(fixtures.CHAR, id, "mine").ok, true);
        const rt = t.svc.twinTaskContext({ itemID: fixtures.twinOf(t, id) });
        fillHold(rt, 4);
      }
      t.adapter.conditionOf = () => {
        events.push("condition");
        return null;
      };
      const remove = t.adapter.remove;
      const twin501 = fixtures.twinOf(t, 501);
      let failOnce = true;
      t.adapter.remove = (scene, id) => {
        events.push("remove");
        if (id === twin501 && failOnce) {
          failOnce = false;
          return false;
        }
        return remove(scene, id);
      };
      assert.strictEqual(t.svc.orderCopy(fixtures.CHAR, 501, "return").ok, true);
      t.w.distance.set(twin501, 100);
      t.clock.t += 500;
      t.svc.tick(t.clock.t);
      t.clock.t += 500;
      t.svc.tick(t.clock.t);
      assert.deepStrictEqual(events, ["unload", "condition", "remove", "remove"],
        "unload -> condition -> remove (failed, end.removeRetry) -> retried end: no second unload, remove");
      assert.strictEqual(t.svc.stats().counters["end.removeRetry"], 1);
      assert.deepStrictEqual(stub.log.unloads[0], { ownerCharacterId: fixtures.CHAR, hostShipId: fixtures.HOST,
        systemId: fixtures.SYSTEM });
      assert.strictEqual(t.store.get(501), null, "ended after the retry");
      let c = t.svc.stats().counters;
      assert.strictEqual(c["mining.oreLostM3"] || 0, 0, "everything unloaded: nothing lost");

      assert.strictEqual(t.svc.orderCopy(fixtures.CHAR, 502, "return").ok, true);
      assert.strictEqual(t.svc.beginLoss(502, { cause: "DESTROYED" }).ok, true);
      c = t.svc.stats().counters;
      assert.strictEqual(c["mining.oreLostM3"], 40);

      t.w.sessions.delete(fixtures.CHAR);
      t.clock.t += 500;
      t.svc.tick(t.clock.t);
      t.svc.tick(t.clock.t + 500);
      c = t.svc.stats().counters;
      assert.deepStrictEqual([c["mining.oreLostM3"], stub.log.unloads.length, c["end.LOGOFF"]], [80, 1, 1]);
    } finally {
      fixtures.cleanup(t.dir);
    }
  });

  test("ME4 refusals of mine: NOT_OWNER before TASK_UNAVAILABLE (no hook); no twin entity -> TASK_UNAVAILABLE; "
    + "NO_MINING_MODULE; TARGET_INVALID; `!wing mine` over 2 twins (one without a module) -> 1 done, 1 refused; "
    + "taskReady(mine) needs the `mining` probe", () => {
    const off = stubEngine({ hookReady: false });
    const t1 = fixtures.setup({ config: { miningEnabled: true }, taskReady: () => true,
      taskEngines: { mine: off.engine } });
    try {
      assert.ok(t1.svc.SUPPORTED_VERBS.includes("mine"), "the verb is there, the hook is late");
      assert.strictEqual(t1.svc.orderCopy(fixtures.CHAR, 501, "launch").ok, true);
      assert.deepStrictEqual(t1.svc.orderCopy(fixtures.OTHER, 501, "mine"), { ok: false, reason: "NOT_OWNER" });
      assert.deepStrictEqual(t1.svc.orderCopy(fixtures.CHAR, 501, "mine"), { ok: false, reason: "TASK_UNAVAILABLE" });
    } finally {
      fixtures.cleanup(t1.dir);
    }

    const holder = { noModule: new Set() };
    const on = stubEngine({ noModule: holder.noModule });
    const t = fixtures.setup({ config: { miningEnabled: true }, taskReady: () => true,
      taskEngines: { mine: on.engine } });
    try {
      assert.strictEqual(t.svc.orderCopy(fixtures.CHAR, 501, "launch", { commandId: "c" }).ok, true);
      assert.strictEqual(t.svc.orderCopy(fixtures.CHAR, 502, "launch", { commandId: "c" }).ok, true);
      holder.noModule.add(fixtures.twinOf(t, 501));
      assert.deepStrictEqual(t.svc.orderCopy(fixtures.CHAR, 501, "mine"), { ok: false, reason: "NO_MINING_MODULE" });
      assert.deepStrictEqual(t.svc.orderCopy(fixtures.CHAR, 502, "mine", { targetId: 999 }),
        { ok: false, reason: "TARGET_INVALID" });
      const gone = fixtures.twinOf(t, 502);
      const kept = t.w.scene.entities.get(gone);
      t.w.scene.entities.delete(gone);
      assert.deepStrictEqual(t.svc.orderCopy(fixtures.CHAR, 502, "mine"), { ok: false, reason: "TASK_UNAVAILABLE" });
      t.w.scene.entities.set(gone, kept);

      const chat = createChatChannel({ core: t.svc, trigger: "!wing", characterIdOf: () => fixtures.CHAR });
      const line = chat.handle({}, "!wing mine");
      assert.strictEqual(line, "Ship Wing: mining Hulk 502; not mining: Hulk 501 (no mining module online).");
      assert.match(chat.handle({}, "!wing status"), /Hulk 502 \[out \d+ m, mining \(seek\)\]/);
      assert.match(chat.handle({}, "!wing help"), /!wing mine \[name\]/);
    } finally {
      fixtures.cleanup(t.dir);
    }

    const probe = (names) => ({ isConsumerAvailable: (n) => names.includes(n) });
    const ready = taskReadyFor(probe(["tasks"]));
    assert.deepStrictEqual([ready("hold"), ready("mine"), ready("attack")], [true, false, false]);
    assert.strictEqual(taskReadyFor(probe(["tasks", "mining"]))("mine"), false, "Mine needs twinControl");
    assert.strictEqual(taskReadyFor(probe(["tasks", "twinControl", "mining"]))("mine"), true);
    const tasksWithMine = { supports: () => true };
    assert.deepStrictEqual(enabledVerbs(config(), ready, tasksWithMine), ["launch", "return", "hold"]);
  });

  test("ME5 budget: 10 twins in SEEK in one tick -> pickRock at most miningMaxSeeksPerTick times; the next tick "
    + "seeks again", () => {
    const w = fakeWorld();
    const pairs = [];
    for (let i = 0; i < 10; i += 1) {
      const twin = twinEntity(4200000000000100 + i * 10);
      pairs.push([deploy(w, 600 + i, twin), twin]);
    }
    for (const [rec, twin] of pairs) step(w, rec, twin, 1000);
    assert.strictEqual(w.picks, w.config.miningMaxSeeksPerTick);
    for (const [rec, twin] of pairs) step(w, rec, twin, 1500);
    assert.strictEqual(w.picks, 2 * w.config.miningMaxSeeksPerTick);
    assert.strictEqual(w.engine.stats().counters["mining.seek.none"], 2 * w.config.miningMaxSeeksPerTick,
      "no rock: SEEK again after miningSeekRetryMs");
    const hookNames = require("../../lib/adapter/miningHook").COUNTER_NAMES;
    const taskNames = require("../../lib/core/wingTasks").COUNTER_NAMES;
    assert.deepStrictEqual(ENGINE_COUNTER_NAMES.filter((n) => hookNames.includes(n) || taskNames.includes(n)), []);
  });

  test("ME7 far rock: an owner target out of range is skipped and a nearby rock picked "
    + "a stale rt.targetId is cleared once; host leaves during APPROACH -> SEEK; an explicit far target -> "
    + "TARGET_INVALID; in range unchanged", () => {
    const w = fakeWorld();
    const range = w.config.miningSearchRangeMeters;
    w.addRock(rock(5101, 181000));
    w.addRock(rock(5102, 3000));
    const twin = twinEntity(4200000000000010);
    w.host.position = at(180000);
    const rec = deploy(w, 501, twin, 5101);
    const rt = w.tasks.context(501);
    assert.strictEqual(rt.targetId, 5101);
    w.host.position = at(0);
    w.locks.set(HOST, new Set([5101]));
    const families = new Set(["ore"]);
    assert.deepStrictEqual(w.access.pickRock(w.scene, { twin, host: w.host, ownerTargets: [5101], rangeM: range,
      families }), { rockId: 5102, distanceM: 2900 }, "Owner target out of range skipped (to the rock surface)");
    step(w, rec, twin, 1000);
    assert.deepStrictEqual([rt.targetId, rt.sub, rt.mine.rockId], [null, "APPROACH", 5102], "owner target out of range");
    assert.strictEqual(w.engine.stats().counters["mining.seek.ownerTargetOutOfRange"], 1);
    w.states.get(5102).remainingQuantity = 0;
    step(w, rec, twin, 1500);
    step(w, rec, twin, 2000);
    assert.strictEqual(w.engine.stats().counters["mining.seek.ownerTargetOutOfRange"], 1, "cleared once");
    assert.notStrictEqual(rt.mine.rockId, 5101, "the far rock never comes back");

    const v = fakeWorld();
    const limit = v.config.miningSearchRangeMeters + v.config.miningTransferRangeMeters;
    v.addRock(rock(5201, 12000));
    const t2 = twinEntity(4200000000000020);
    const r2 = deploy(v, 502, t2);
    const rt2 = v.tasks.context(502);
    step(v, r2, t2, 1000);
    assert.deepStrictEqual([rt2.sub, rt2.mine.rockId], ["APPROACH", 5201]);
    v.host.position = at(12000 - limit);
    step(v, r2, t2, 1500);
    assert.strictEqual(rt2.sub, "APPROACH", "in range: unchanged, one approach order");
    assert.strictEqual(v.calls.filter((c) => c[0] === "orbit").length, 1);
    v.host.position = at(12000 - limit - 1000);
    step(v, r2, t2, 2000);
    assert.deepStrictEqual([rt2.sub, rt2.mine.rockId, v.engine.stats().claims], ["SEEK", null, 0]);
    assert.strictEqual(v.engine.stats().counters["mining.approach.hostLeft"], 1);

    const x = fakeWorld();
    x.addRock(rock(5301, x.config.miningOrderRangeMeters + 5000));
    x.addRock(rock(5302, x.config.miningOrderRangeMeters - 1000));
    const t3 = twinEntity(4200000000000030);
    x.scene.entities.set(t3.itemID, t3);
    const r3 = record(503, t3.itemID);
    x.tasks.start(r3);
    assert.deepStrictEqual(x.tasks.order(r3, null, "mine", { targetId: 5301, twin: t3, scene: x.scene, record: r3 }),
      { ok: false, reason: "TARGET_INVALID" });
    assert.deepStrictEqual(x.tasks.order(r3, null, "mine", { targetId: 5302, twin: t3, scene: x.scene, record: r3 }),
      { ok: true, task: "MINE" });
  });

  test("ME8 orbit the rock: MINING orbits the rock at workRangeM - buffer (surface) "
    + "whether the twin started in range or far; one order per rock, again only after ORBIT on it was lost; a new rock "
    + "-> orbit on the new rock", () => {
    let w = fakeWorld();
    const moves = (twinId) => w.calls.filter((c) => (c[0] === "orbit" || c[0] === "follow") && c[1] === twinId);
    w.addRock(rock(5401, 3000));
    const t1 = twinEntity(4200000000000010);
    const r1 = deploy(w, 501, t1);
    const rt1 = w.tasks.context(501);
    for (const ms of [1000, 1500, 2000]) step(w, r1, t1, ms);
    assert.strictEqual(rt1.sub, "MINING");
    const orbitM = rt1.mine.workRangeM - w.config.miningRangeBufferMeters;
    assert.ok(orbitM > 0 && orbitM < rt1.mine.workRangeM, "orbit (surface, vendor adds both radii) inside work range");
    assert.deepStrictEqual(moves(t1.itemID), [["orbit", t1.itemID, 5401, orbitM]]);
    for (const ms of [2500, 3000, 4000, 9000]) step(w, r1, t1, ms);
    assert.strictEqual(moves(t1.itemID).length, 1, "no new order every tick");
    t1.mode = "FOLLOW";
    step(w, r1, t1, 9500);
    step(w, r1, t1, 10000);
    assert.deepStrictEqual(moves(t1.itemID).slice(1), [["orbit", t1.itemID, 5401, orbitM]], "lost ORBIT -> once more");

    w = fakeWorld();
    w.addRock(rock(5402, 14800));
    const t2 = twinEntity(4200000000000020);
    const r2 = deploy(w, 502, t2);
    const rt2 = w.tasks.context(502);
    step(w, r2, t2, 1000);
    step(w, r2, t2, 1500);
    assert.deepStrictEqual([rt2.mine.rockId, moves(t2.itemID)], [5402, [["follow", t2.itemID, 5402, orbitM]]]);
    t2.position = at(6000, 100);
    for (const ms of [2000, 2500, 3000]) step(w, r2, t2, ms);
    assert.strictEqual(rt2.sub, "MINING");
    assert.deepStrictEqual(moves(t2.itemID).slice(1), [["orbit", t2.itemID, 5402, orbitM]]);

    w.states.get(5402).remainingQuantity = 0;
    w.addRock(rock(5403, 9000));
    for (const ms of [3500, 4000, 4500, 5000]) step(w, r2, t2, ms);
    assert.deepStrictEqual([rt2.sub, rt2.mine.rockId], ["MINING", 5403]);
    assert.deepStrictEqual(moves(t2.itemID).slice(2), [["orbit", t2.itemID, 5403, orbitM]]);
    assert.strictEqual(t2.targetEntityID, 5403);
  });

  test("ME9 order range: a rock of the order 18 km away -> ok + APPROACH (leash anchor = "
    + "the rock, kept while the host is within order + transfer range); the same rock without an order is skipped; "
    + "a rock 181 km away -> TARGET_INVALID", () => {
    const w = fakeWorld();
    assert.ok(w.config.miningOrderRangeMeters > 18000 && w.config.miningSearchRangeMeters < 18000, "defaults");
    w.addRock(rock(5501, 18000));
    const t1 = twinEntity(4200000000000010);
    const r1 = deploy(w, 501, t1, 5501);
    const rt1 = w.tasks.context(501);
    assert.deepStrictEqual(step(w, r1, t1, 1000), { controlsMovement: true, leashAnchorId: 5501 });
    assert.deepStrictEqual([rt1.targetId, rt1.sub, rt1.mine.rockId], [5501, "APPROACH", 5501]);
    const limit = w.config.miningOrderRangeMeters + w.config.miningTransferRangeMeters;
    w.host.position = at(18000 - limit + 1000);
    assert.deepStrictEqual(step(w, r1, t1, 1500), { controlsMovement: true, leashAnchorId: 5501 });
    assert.strictEqual(rt1.sub, "APPROACH");
    w.host.position = at(18000 - limit - 1000);
    assert.deepStrictEqual(step(w, r1, t1, 2000), { controlsMovement: true }, "no anchor in SEEK");
    assert.deepStrictEqual([rt1.sub, w.engine.stats().counters["mining.approach.hostLeft"]], ["SEEK", 1]);

    const u = fakeWorld();
    u.addRock(rock(5551, 18000));
    const t4 = twinEntity(4200000000000040, 9000);
    const r4 = deploy(u, 504, t4, 5551);
    const rt4 = u.tasks.context(504);
    for (const ms of [1000, 1500, 2000]) step(u, r4, t4, ms);
    assert.strictEqual(rt4.sub, "MINING");
    u.host.position = at(18000 - limit + 1000);
    assert.deepStrictEqual(step(u, r4, t4, 2500), { controlsMovement: true, leashAnchorId: 5551 });
    assert.strictEqual(rt4.sub, "MINING", "within the limit: mining on");
    u.host.position = at(18000 - limit - 1000);
    assert.deepStrictEqual(step(u, r4, t4, 3000), { controlsMovement: true }, "no anchor after the host left");
    assert.deepStrictEqual([rt4.sub, rt4.mine.rockId, rt4.targetId], ["SEEK", null, null]);
    assert.strictEqual(u.engine.stats().counters["mining.mine.hostLeft"], 1);

    const v = fakeWorld();
    v.addRock(rock(5601, 18000));
    const t2 = twinEntity(4200000000000020);
    const r2 = deploy(v, 502, t2);
    assert.deepStrictEqual(step(v, r2, t2, 1000), { controlsMovement: true });
    assert.deepStrictEqual([v.tasks.context(502).sub, v.engine.stats().counters["mining.seek.none"]], ["SEEK", 1]);

    const x = fakeWorld();
    x.addRock(rock(5701, 181000));
    const t3 = twinEntity(4200000000000030);
    x.scene.entities.set(t3.itemID, t3);
    const r3 = record(503, t3.itemID);
    x.tasks.start(r3);
    assert.deepStrictEqual(x.tasks.order(r3, null, "mine", { targetId: 5701, twin: t3, scene: x.scene, record: r3 }),
      { ok: false, reason: "TARGET_INVALID" });
  });

  test("ME11 gas cloud of a dungeon (Helix Nebula, radius 20 km): a twin with a gas scoop picks the "
    + "cloud 1.6 km from the host's centre to its surface (centre 21.6 km > miningSearchRangeMeters) -> APPROACH, "
    + "no mining.seek.none; hostNear keeps it during APPROACH", () => {
    const GAS_SCOOP = 25266;
    const GAS = 28698;
    const CLOUD = 5801;
    const w = fakeWorld();
    w.deps.isMineableStaticEntity = (e) => Boolean(e && (e.kind === "asteroid" || e.kind === "gasCloud"));
    w.deps.getTypeEffectRecords = (typeID) => (typeID === GAS_SCOOP ? [{ name: "online" }, { name: "miningClouds" }]
      : []);
    w.deps.isMiningEffectRecord = (r) => r.name === "miningLaser" || r.name === "miningClouds";
    w.deps.resolveMiningFamily = (_m, r) => (r && r.name === "miningClouds" ? "gas" : "ore");
    w.scene.getStaticEntitiesInBubble = () => [...w.scene.entities.values()]
      .filter((e) => e.kind === "asteroid" || e.kind === "gasCloud");
    const cloud = { itemID: CLOUD, kind: "gasCloud", staticVisibilityScope: "bubble", position: at(21600),
      radius: 20000 };
    w.scene.entities.set(CLOUD, cloud);
    w.states.set(CLOUD, { remainingQuantity: 2000, yieldTypeID: GAS, yieldKind: "gas", unitVolume: 10 });
    assert.ok(21600 > w.config.miningSearchRangeMeters, "the centre is beyond the search range");
    const twin = { ...twinEntity(4200000000000110),
      fittedItems: [{ itemID: 4200000000000111, typeID: GAS_SCOOP, flagID: 27, locationID: 4200000000000110 }] };
    assert.deepStrictEqual(w.access.miningModules(twin).map((m) => [m.effectName, m.family]), [["miningClouds", "gas"]]);
    assert.deepStrictEqual(w.access.pickRock(w.scene, { twin, host: w.host, ownerTargets: [],
      rangeM: w.config.miningSearchRangeMeters, families: new Set(["gas"]) }), { rockId: CLOUD, distanceM: 1600 });
    const rec = deploy(w, 511, twin);
    const rt = w.tasks.context(511);
    step(w, rec, twin, 1000);
    assert.deepStrictEqual([rt.sub, rt.mine.rockId, rt.lastRefusal], ["APPROACH", CLOUD, null]);
    assert.strictEqual(w.engine.stats().counters["mining.seek.none"] || 0, 0);
    step(w, rec, twin, 1500);
    assert.notStrictEqual(rt.sub, "SEEK", "the host is next to the cloud: no mining.approach.hostLeft");
    assert.strictEqual(w.engine.stats().counters["mining.approach.hostLeft"] || 0, 0);
  });

  test("ME10 leash: a twin 30 km from the host but near the leash anchor of its task stays "
    + "ACTIVE past outOfRangeGraceMs; once the task names no anchor the old leash ends it (OUT_OF_RANGE)", () => {
    const ROCK = 7001;
    let anchor = ROCK;
    const engine = { name: "mine", canRun: () => ({ ok: true }), start(rt) { rt.sub = "APPROACH"; }, stop() {},
      dispose() {}, step: () => (anchor ? { controlsMovement: true, leashAnchorId: anchor } : { controlsMovement: true }) };
    const t = fixtures.setup({ config: { miningEnabled: true }, taskReady: () => true, taskEngines: { mine: engine } });
    try {
      assert.strictEqual(t.svc.orderCopy(fixtures.CHAR, 501, "launch").ok, true);
      assert.strictEqual(t.svc.orderCopy(fixtures.CHAR, 501, "mine").ok, true);
      const twinId = fixtures.twinOf(t, 501);
      t.w.scene.entities.set(ROCK, { itemID: ROCK });
      t.adapter.surfaceDistance = (_s, a, b) => {
        if (a.itemID !== twinId) return 1000;
        return b && b.itemID === ROCK ? 5000 : 30000;
      };
      const grace = config().outOfRangeGraceMs;
      for (let i = 0; i < 4; i += 1) {
        t.clock.t += grace;
        assert.strictEqual(t.svc.tick(t.clock.t).ended, 0, `near the anchor, tick ${i}`);
      }
      anchor = null;
      for (let i = 0; i < 2; i += 1) {
        t.clock.t += 500;
        assert.strictEqual(t.svc.tick(t.clock.t).ended, 0, "grace");
      }
      t.clock.t += grace;
      assert.strictEqual(t.svc.tick(t.clock.t).ended, 1);
      assert.strictEqual(t.svc.stats().counters["end.OUT_OF_RANGE"], 1);
    } finally {
      fixtures.cleanup(t.dir);
    }
  });

  test("ME6: real DRIFT probe on SolarSystemScene - DRIFT of one twin-steering method "
    + "-> guard installed, launch and hold work, mine not in SUPPORTED_VERBS (UNSUPPORTED_VERB), no mining access; "
    + "DRIFT of refreshShipEntityDerivedState -> no guard, launch DERIVED_GUARD_UNAVAILABLE", () => {
    const sceneEntry = GAME_MODULES.find((entry) => entry.path === SCENE_MODULE);
    const SRC = path.join(MOD_DIR, "fake-server-src");
    const gameFor = (drifted) => {
      function SolarSystemScene() {}
      for (const s of sceneEntry.symbols) {
        if (s.name !== drifted) SolarSystemScene.prototype[s.name] = function vendor() { return { success: true }; };
      }
      const cache = { [path.join(SRC, `${SCENE_MODULE}.js`)]: { exports: { SolarSystemScene } } };
      const adapter = createAdapter({ moduleApi: { _cache: cache }, gameModules: [sceneEntry] });
      assert.strictEqual(adapter.setServerSrc(SRC).ok, true);
      adapter.runProbe();
      return adapter;
    };
    const run = (drifted) => {
      const adapter = gameFor(drifted);
      const opts = { config: { miningEnabled: true }, taskReady: taskReadyFor(adapter),
        taskEngines: { mine: stubEngine().engine }, derived: false };
      const t = fixtures.setup(opts);
      const installed = installSceneGuardFromGame(adapter, { wing: t.svc });
      opts.derived = installed.ok;
      return { adapter, t, installed };
    };

    const steer = run("finalizeTargetLock");
    try {
      assert.deepStrictEqual([steer.adapter.isConsumerAvailable("tasks"),
        steer.adapter.isConsumerAvailable("twinControl")], [true, false]);
      assert.strictEqual(steer.adapter.getReport().disabled.twinControl,
        `drift:${SCENE_MODULE}.finalizeTargetLock`);
      assert.strictEqual(steer.installed.ok, true, "the derived-state guard does not need twinControl");
      assert.deepStrictEqual(steer.t.svc.SUPPORTED_VERBS, ["launch", "return", "hold"]);
      assert.deepStrictEqual(steer.t.svc.orderCopy(fixtures.CHAR, 501, "launch"), { ok: true, state: "ACTIVE" });
      assert.strictEqual(steer.t.svc.orderCopy(fixtures.CHAR, 501, "hold").ok, true);
      assert.deepStrictEqual(steer.t.svc.orderCopy(fixtures.CHAR, 501, "mine"),
        { ok: false, reason: "UNSUPPORTED_VERB" });
      assert.deepStrictEqual(createMiningAccessFromGame(steer.adapter, { scene: createTwinScene() }),
        { ok: false, reason: "probe_twinControl_unavailable" });
    } finally {
      fixtures.cleanup(steer.t.dir);
    }

    const derived = run("refreshShipEntityDerivedState");
    try {
      assert.deepStrictEqual([derived.adapter.isConsumerAvailable("tasks"),
        derived.adapter.isConsumerAvailable("twinControl")], [false, true]);
      assert.deepStrictEqual(derived.installed, { ok: false, reason: "probe_tasks_unavailable" });
      assert.deepStrictEqual(derived.t.svc.orderCopy(fixtures.CHAR, 501, "launch"),
        { ok: false, reason: "DERIVED_GUARD_UNAVAILABLE" });
      assert.ok(!derived.t.svc.SUPPORTED_VERBS.includes("hold") && !derived.t.svc.SUPPORTED_VERBS.includes("mine"));
    } finally {
      fixtures.cleanup(derived.t.dir);
    }
  });

  test("FM-M1 (formations) MINE in a formation: a slot in reach -> no approach/orbit "
    + "controlsMovement false, LOCK/MINING once the twin is in its slot; the slot out of reach -> the orbit of the "
    + "rock, controlsMovement true; back to the slot only past the hysteresis; formation false = the calls of today",
  () => {
    const w = fakeWorld();
    w.addRock(rock(5001, 12000));
    const t1 = twinEntity(4200000000000010);
    const r1 = deploy(w, 501, t1);
    const rt = w.tasks.context(501);
    let slot = at(4000, 100);
    const fstep = (nowMs) => w.tasks.step(r1, null, { twin: t1, host: w.host, nowMs, scene: w.scene, formation: true,
      formationSlot: () => slot });
    const moving = () => w.calls.filter((c) => c[0] === "orbit" || c[0] === "follow");
    const c = () => w.engine.stats().counters;
    assert.deepStrictEqual(fstep(1000), { controlsMovement: false }, "the rock picked, its slot in reach");
    assert.deepStrictEqual([rt.sub, c()["mining.formation.fromSlot"]], ["APPROACH", 1]);
    assert.deepStrictEqual(fstep(1500), { controlsMovement: false });
    assert.deepStrictEqual([rt.sub, moving()], ["APPROACH", []], "11850 m from the rock: waits, no approach");
    t1.position = at(4000, 100);
    fstep(2000);
    assert.deepStrictEqual(fstep(2500), { controlsMovement: false });
    assert.deepStrictEqual([rt.sub, t1.activeModuleEffects.size, moving()], ["MINING", 1, []], "mines from the slot");

    slot = at(-2000, 100);
    assert.deepStrictEqual(fstep(3000), { controlsMovement: true });
    assert.deepStrictEqual([moving(), c()["mining.formation.toRock"]], [[["orbit", t1.itemID, 5001, 9000]], 1]);
    slot = at(3500, 100);
    assert.deepStrictEqual(fstep(3500), { controlsMovement: true });
    slot = at(4500, 100);
    assert.deepStrictEqual(fstep(4000), { controlsMovement: false });
    assert.deepStrictEqual([moving().length, c()["mining.formation.fromSlot"], rt.sub], [1, 2, "MINING"]);

    w.states.get(5001).remainingQuantity = 0;
    assert.deepStrictEqual(fstep(4500), { controlsMovement: false });
    assert.deepStrictEqual(fstep(5000 + w.config.miningSeekRetryMs), { controlsMovement: false });
    assert.deepStrictEqual([rt.sub, moving().length], ["SEEK", 1]);

    const run = (extra) => {
      const v = fakeWorld();
      v.addRock(rock(5001, 12000));
      const t = twinEntity(4200000000000010);
      const r = deploy(v, 501, t);
      const out = [];
      for (const [nowMs, x] of [[1000, 0], [1500, 0], [2000, 4000], [2500, 4000], [3000, 4000]]) {
        t.position = at(x, 100);
        out.push(v.tasks.step(r, null, { twin: t, host: v.host, nowMs, scene: v.scene, ...extra }));
      }
      return { out, calls: v.calls, sub: v.tasks.context(501).sub };
    };
    const today = run({});
    assert.deepStrictEqual(run({ formation: false, formationSlot: null }), today);
    assert.ok(today.calls.some((x) => x[0] === "orbit") && today.out.every((o) => o.controlsMovement === true));
  });
};
