"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const { createDronePersistCoalesce, fixedUpstream } = require("../lib/dronePersistCoalesce");

const clone = (v) => JSON.parse(JSON.stringify(v));
const ITEM_ID = 990001;
const DRONE_DEPS = Object.freeze({ isDroneEntity: (e) => Boolean(e && e.kind === "drone"), DRONE_COMMAND_MINE: "MINE", STATE_MINING: 2, STATE_APPROACHING: 3 });

function fakeItemStore() {
  const st = { records: new Map(), calls: [] };
  st.records.set(ITEM_ID, { itemID: ITEM_ID, typeID: 10246, ownerID: 140000001, locationID: 30000142, flagID: 0,
    singleton: 1, quantity: null, stacksize: 1, launcherID: 1001, customInfo: "", spaceState: null });
  function updateInventoryItem(itemId, updater) {
    const cur = st.records.get(Number(itemId));
    st.calls.push({ id: Number(itemId), updater });
    if (!cur) return { success: false, errorMsg: "ITEM_NOT_FOUND" };
    const next = clone(typeof updater === "function" ? updater(clone(cur)) : updater);
    st.records.set(Number(itemId), next);
    return { success: true, previousData: clone(cur), data: clone(next) };
  }
  function findItemById(itemId) {
    const r = st.records.get(Number(itemId));
    return r ? clone(r) : null;
  }
  function updateInventoryItemSuccessOnly(itemId, updater) {
    const r = updateInventoryItem(itemId, updater);
    return r.success ? { success: true } : r;
  }
  st.exports = { updateInventoryItem, updateInventoryItemSuccessOnly, findItemById };
  st.original = updateInventoryItem;
  st.originalSuccessOnly = updateInventoryItemSuccessOnly;
  return st;
}

function vec(v) {
  return { x: v.x, y: v.y, z: v.z };
}

function serialize(e) {
  return {
    systemID: e.systemID, position: vec(e.position), velocity: vec(e.velocity), direction: vec(e.direction),
    targetPoint: vec(e.targetPoint || e.position), speedFraction: e.speedFraction, mode: String(e.mode || "STOP"),
    targetEntityID: e.targetEntityID || null, followRange: e.followRange, orbitDistance: e.orbitDistance,
    orbitNormal: vec(e.orbitNormal), orbitSign: e.orbitSign < 0 ? -1 : 1, effectStamp: 0, warpDestination: null,
    ...(e.dungeonSiteInstanceID != null ? { dungeonSiteInstanceID: e.dungeonSiteInstanceID } : {}),
  };
}

function persistUpdater(e) {
  return (currentItem) => ({
    ...currentItem,
    locationID: e.systemID,
    flagID: 0,
    singleton: 1,
    quantity: null,
    stacksize: 1,
    launcherID: e.launcherID || null,
    customInfo: String(currentItem.customInfo || ""),
    spaceState: serialize(e),
  });
}

function drone() {
  return {
    kind: "drone", itemID: ITEM_ID, systemID: 30000142, launcherID: 1001, droneCommand: "MINE", activityState: 2,
    position: { x: 0, y: 0, z: 0 }, velocity: { x: 1, y: 0, z: 0 }, direction: { x: 1, y: 0, z: 0 }, speedFraction: 1,
    mode: "ORBIT", targetEntityID: 5001, followRange: 0, orbitDistance: 500, orbitNormal: { x: 0, y: 1, z: 0 }, orbitSign: 1,
  };
}

function setup(cfg = {}) {
  const lines = [];
  const clock = { t: 0 };
  const timers = [];
  const c = createDronePersistCoalesce({
    config: { dronePersistCoalesceMs: 5000, dronePersistCoalesceMaxItems: 256, ...cfg },
    log: (l) => lines.push(l), now: () => clock.t,
    setTimer: (fn, ms) => { const h = { fn, ms }; timers.push(h); return h; }, clearTimer: () => {},
  });
  const store = fakeItemStore();
  const hooks = new Map();
  const game = { down: false, registerShutdownHook: (n, fn) => hooks.set(n, fn), isShutdownInProgress: () => game.down };
  assert.strictEqual(c.setItemStoreDeps(store.exports), true);
  assert.strictEqual(c.setDroneDeps(DRONE_DEPS), true);
  assert.strictEqual(c.setStoreDeps(game), true);
  store.exports.updateInventoryItem = c.wrapUpdate(store.exports.updateInventoryItem);
  store.exports.updateInventoryItemSuccessOnly = c.wrapUpdate(store.exports.updateInventoryItemSuccessOnly, "successOnly");
  const d = drone();
  const scene = { getEntityByID: (id) => (Number(id) === d.itemID ? d : null) };
  const results = [];
  const tickScene = c.wrapTickScope(function tickScene(sc) {
    void sc;
    results.push(store.exports.updateInventoryItemSuccessOnly(d.itemID, persistUpdater(d)));
  });
  return { c, store, d, scene, tickScene, results, clock, timers, hooks, game, lines };
}

function register(ctx) {
  const { test, config, loader, SERVER_SRC } = ctx;
  const { createState, patchTarget, probeMessage, checkDroneDrift, DRONE_POINTS } = loader;

  test("J1 drones: 60 MINING ticks = 2 real writes (first + interval 5 s), deferred result {success:true}, flush = movement from the last tick", () => {
    const s = setup();
    for (let i = 0; i < 60; i += 1) {
      s.clock.t = i * 100;
      s.d.position = { x: i, y: 0, z: 0 };
      s.d.targetPoint = { x: i + 1, y: 0, z: 0 };
      s.tickScene(s.scene, s.clock.t);
    }
    assert.strictEqual(s.store.calls.length, 2, "first + interval");
    assert.strictEqual(s.results.filter((r) => r.coalesced === true && r.success === true).length, 58);
    assert.deepStrictEqual([s.results[0], s.results[50]], [{ success: true }, { success: true }], "real writes return the vendor result");
    assert.strictEqual(s.store.records.get(ITEM_ID).spaceState.position.x, 50, "interval write at t=5000");
    const snap = s.c.statsSnapshot();
    assert.deepStrictEqual([snap.intercepted, snap.coalesced, snap.realFirst, snap.realInterval, snap.realChanged, snap.pending], [60, 58, 1, 1, 0, 1]);
    assert.ok(s.c.status().hookRegistered && s.hooks.has("hotPathPerf.dronePersist") && s.timers.length >= 1);
    assert.deepStrictEqual(s.c.flushAll("timer"), { ok: true, written: 1, dropped: 0 });
    const rec = s.store.records.get(ITEM_ID);
    assert.deepStrictEqual([rec.spaceState.position.x, rec.spaceState.targetPoint.x, rec.spaceState.mode], [59, 60, "ORBIT"]);
    assert.strictEqual(s.c.flushAll("timer").written, 0, "flush is idempotent");
    const q = setup();
    assert.ok(q.store.exports.updateInventoryItem(ITEM_ID, (x) => x).data);
    assert.strictEqual(q.c.status().tracked, 0);
    const t = setup();
    t.tickScene(t.scene, 0);
    t.clock.t = 100;
    t.d.position = { x: 7, y: 0, z: 0 };
    t.tickScene(t.scene, 100);
    t.clock.t = 5000;
    t.timers[0].fn();
    assert.strictEqual(t.store.records.get(ITEM_ID).spaceState.position.x, 7);
    assert.strictEqual(t.c.statsSnapshot().flushes.timer, 1);
    t.clock.t = 20000;
    t.timers[t.timers.length - 1].fn();
    assert.strictEqual(t.c.status().tracked, 0, "entry without movement cleaned up after 2× the window");
    assert.ok(/^stats dronePersistCoalesce state=ready tracked=0 pending=0 intercepted=2 coalesced=1 real=first:1,interval:0,changed:0 flushes=timer:1,foreign:0,dispose:0,shutdown:0,limit:0 dropped=cas:0,notFound:0,shutdown:0 writeErrors=0 flushMaxMs=\d+ maxAgeMs=\d+$/
      .test(t.c.drainStatsLines()[0]));
  });

  test("J2 drones: a change of mode / launcherID / range / activityState=IDLE = real write in the same call", () => {
    const changes = [
      (d) => { d.mode = "FOLLOW"; },
      (d) => { d.launcherID = 1002; },
      (d) => { d.dungeonSiteInstanceID = 777; },
      (d) => { d.targetEntityID = 5002; },
      (d) => { d.activityState = 0; },
      (d) => { d.droneCommand = null; },
    ];
    for (const [i, change] of changes.entries()) {
      const s = setup();
      s.tickScene(s.scene, 0);
      s.clock.t = 100;
      s.d.position = { x: 3, y: 0, z: 0 };
      s.tickScene(s.scene, 100);
      assert.strictEqual(s.store.calls.length, 1, `odroczone #${i}`);
      s.clock.t = 200;
      s.d.position = { x: 4, y: 0, z: 0 };
      change(s.d);
      s.tickScene(s.scene, 200);
      const rec = s.store.records.get(ITEM_ID);
      assert.strictEqual(rec.spaceState.position.x, 4, `immediate write #${i}`);
      assert.deepStrictEqual(s.results[2], { success: true }, `vendor result #${i}`);
    }
    const e = setup();
    e.tickScene(e.scene, 0);
    e.clock.t = 100;
    let boom = false;
    const thrower = (cur) => { if (boom) throw new Error("own boom"); return persistUpdater(e.d)(cur); };
    boom = true;
    const wrappedTick = e.c.wrapTickScope(function tickScene() { return e.store.exports.updateInventoryItem(ITEM_ID, thrower); });
    assert.throws(() => wrappedTick(e.scene, 100), /own boom/, "updater exception propagates as in the vendor");
    assert.strictEqual(e.c.status().state, "disabled:error");
    assert.ok(e.lines.some((l) => l.startsWith("WARN dronePersistCoalesce disabled: error (own boom")));
  });

  test("J3 drones: a foreign write of this itemID = movement patch first, then the foreign one; the entry is removed", () => {
    const s = setup();
    s.tickScene(s.scene, 0);
    s.clock.t = 100;
    s.d.position = { x: 9, y: 0, z: 0 };
    s.tickScene(s.scene, 100);
    assert.strictEqual(s.c.status().pending, 1);
    const foreign = (cur) => ({ ...cur, flagID: 87, locationID: 1001 });
    const r = s.store.exports.updateInventoryItem(ITEM_ID, foreign);
    assert.ok(r.success && r.data && r.data.flagID === 87);
    const order = s.store.calls.slice(1).map((c) => (c.updater === foreign ? "foreign" : "motion"));
    assert.deepStrictEqual(order, ["motion", "foreign"]);
    const rec = s.store.records.get(ITEM_ID);
    assert.deepStrictEqual([rec.spaceState.position.x, rec.flagID], [9, 87]);
    assert.strictEqual(s.c.status().tracked, 0);
    assert.strictEqual(s.c.statsSnapshot().flushes.foreign, 1);
    const h = setup();
    h.tickScene(h.scene, 0);
    h.clock.t = 100;
    h.d.position = { x: 5, y: 0, z: 0 };
    h.tickScene(h.scene, 100);
    h.game.down = true;
    h.hooks.get("hotPathPerf.dronePersist")();
    assert.strictEqual(h.store.records.get(ITEM_ID).spaceState.position.x, 5);
    h.clock.t = 200;
    h.d.position = { x: 6, y: 0, z: 0 };
    h.tickScene(h.scene, 200);
    assert.deepStrictEqual(h.c.flushAll("dispose"), { ok: true, written: 0, dropped: 1 });
    assert.strictEqual(h.c.statsSnapshot().droppedShutdown, 1);
  });

  test("J4 drones: CAS — record changed bypassing the wrapper = no write, dropped.cas; dispose flushes before the original", () => {
    const s = setup();
    s.tickScene(s.scene, 0);
    s.clock.t = 100;
    s.d.position = { x: 2, y: 0, z: 0 };
    s.tickScene(s.scene, 100);
    s.store.records.get(ITEM_ID).flagID = 87;
    const calls = s.store.calls.length;
    assert.deepStrictEqual(s.c.flushAll("dispose"), { ok: true, written: 0, dropped: 1 });
    assert.strictEqual(s.store.calls.length, calls, "no write");
    assert.strictEqual(s.c.statsSnapshot().droppedCas, 1);
    assert.strictEqual(s.store.records.get(ITEM_ID).flagID, 87);
    const f = setup();
    f.tickScene(f.scene, 0);
    f.clock.t = 100;
    f.d.position = { x: 8, y: 0, z: 0 };
    f.tickScene(f.scene, 100);
    let seen = null;
    const dispose = f.c.wrapFlushPoint(function disposeScene() { seen = f.store.records.get(ITEM_ID).spaceState.position.x; return 42; }, "dispose");
    assert.strictEqual(dispose(), 42);
    assert.strictEqual(seen, 8);
    assert.strictEqual(f.c.statsSnapshot().flushes.dispose, 1);
  });

  test("J5 drones: loader (7 points, order itemStore→droneRuntime, flag false, drift, probe); vendor checkpoints motion itself = obsolete", () => {
    const quiet = Object.fromEntries(loader.POINTS.map((p) => [p.flag, false]));
    const base = { ...config, ...quiet, prewarmLocations: false };
    class FakeRuntime { disposeScene() { return "disposed"; } }
    const mk = () => {
      const store = fakeItemStore();
      return {
        store,
        game: { registerShutdownHook() {}, isShutdownInProgress: () => false },
        droneRt: { ...DRONE_DEPS, tickScene() {} },
        rt: Object.create(FakeRuntime.prototype),
      };
    };
    const on = createState({ ...base, dronePersistCoalesce: true }, null, { log: () => {} });
    const v = mk();
    patchTarget("itemStore", v.store.exports, on);
    patchTarget("gameStore", v.game, on);
    patchTarget("droneRuntime", v.droneRt, on);
    patchTarget("spaceRuntime", v.rt, on);
    for (const p of DRONE_POINTS) assert.ok(on.patched.has(p.symbol), p.symbol);
    assert.strictEqual(DRONE_POINTS.length, 7);
    assert.strictEqual(v.store.exports.updateInventoryItem.__hotPathPerfOriginal, v.store.original);
    assert.strictEqual(v.store.exports.updateInventoryItemSuccessOnly.__hotPathPerfOriginal, v.store.originalSuccessOnly);
    assert.strictEqual(v.store.exports.updateInventoryItemSuccessOnly.name, "updateInventoryItemSuccessOnly");
    assert.ok(v.droneRt.tickScene.__hotPathPerfDrone && FakeRuntime.prototype.disposeScene.__hotPathPerfDrone);
    assert.strictEqual(v.rt.disposeScene(), "disposed");
    on.gameSeen = true;
    assert.strictEqual(checkDroneDrift(on), false);
    assert.ok(/^probe: passed \(7 /.test(probeMessage(on)), probeMessage(on));
    assert.strictEqual(on.drone.status().state, "ready");
    assert.ok(on.requestPattern.test("../inventory/itemStore") && on.requestPattern.test("../services/drone/droneRuntime"));
    assert.strictEqual(loader.targetOf("/app/server/src/services/drone/droneRuntime.js"), "droneRuntime");
    assert.ok(loader.GAME_TARGETS.has("droneRuntime"));
    delete FakeRuntime.prototype.disposeScene;

    const ord = createState({ ...base, dronePersistCoalesce: true }, null, { log: () => {} });
    const o = mk();
    patchTarget("droneRuntime", o.droneRt, ord);
    patchTarget("itemStore", o.store.exports, ord);
    assert.strictEqual(ord.drone.status().state, "disabled:order");
    assert.strictEqual(o.store.exports.updateInventoryItem, o.store.original);
    assert.strictEqual(o.store.exports.updateInventoryItemSuccessOnly, o.store.originalSuccessOnly);
    const ord3 = createState({ ...base, dronePersistCoalesce: true }, null, { log: () => {} });
    const o3 = mk();
    delete o3.store.exports.updateInventoryItemSuccessOnly;
    patchTarget("itemStore", o3.store.exports, ord3);
    patchTarget("droneRuntime", o3.droneRt, ord3);
    assert.strictEqual(ord3.drone.status().state, "disabled:order");
    const ord2 = createState({ ...base, dronePersistCoalesce: true }, null, { log: () => {} });
    const o2 = mk();
    const inner = o2.store.exports.updateInventoryItem;
    o2.store.exports.updateInventoryItem = function otherMod() { return inner.apply(this, arguments); };
    patchTarget("itemStore", o2.store.exports, ord2);
    assert.strictEqual(ord2.drone.status().state, "disabled:order");

    const off = createState(base, null);
    const f = mk();
    patchTarget("itemStore", f.store.exports, off);
    patchTarget("droneRuntime", f.droneRt, off);
    assert.strictEqual(off.drone, null);
    assert.strictEqual(f.store.exports.updateInventoryItem, f.store.original);
    assert.strictEqual(f.droneRt.tickScene.__hotPathPerfDrone, undefined);
    assert.strictEqual(config.dronePersistCoalesce, false, "mod default false");

    const dr = createState({ ...base, dronePersistCoalesce: true }, null, { log: () => {} });
    const dv = mk();
    patchTarget("itemStore", dv.store.exports, dr);
    patchTarget("gameStore", dv.game, dr);
    patchTarget("droneRuntime", dv.droneRt, dr);
    dr.gameSeen = true;
    assert.strictEqual(checkDroneDrift(dr), true);
    const msg = probeMessage(dr);
    assert.ok(msg.startsWith("DRIFT: SpaceRuntime.disposeScene#droneFlush") && msg.endsWith("; dronePersistCoalesce disabled: drift"), msg);

    if (!fs.existsSync(SERVER_SRC)) return;
    const read = (rel) => fs.readFileSync(path.join(SERVER_SRC, rel), "utf8").replace(/\r\n/g, "\n");
    const text = read("services/drone/droneRuntime.js");
    assert.ok(/const \{[^}]*\n  updateInventoryItem,\n  updateInventoryItemSuccessOnly,\n\} = require\(path\.join\(__dirname, "\.\.\/inventory\/itemStore"\)\);/.test(text), "destructuring");
    const bodyOf = (name) => {
      const start = text.indexOf(`\nfunction ${name}(`);
      return start < 0 ? "" : text.slice(start, text.indexOf("\n}\n", start));
    };
    const mining = bodyOf("tickDroneMining");
    assert.ok(mining.length > 0 && !/persist(DroneEntityState|AndNotifyDroneState)\(/.test(mining), "mining tick does not persist");
    assert.strictEqual(mining.split("notifyDroneStateChange(droneEntity, beforeState);").length - 1, 2, "mining tick only notifies");
    assert.ok(text.includes("\nconst DRONE_MOTION_CHECKPOINT_INTERVAL_MS = 2000;\n"));
    const persist = bodyOf("persistDroneEntityState");
    assert.ok(persist.includes("droneMotionCheckpoints.set(entity, {\n      dueAt: getMonotonicTimeMs() + DRONE_MOTION_CHECKPOINT_INTERVAL_MS,"), "a real write arms the next checkpoint");
    const checkpoint = bodyOf("checkpointDroneMotion");
    assert.ok(checkpoint.includes("!DRONE_IMMEDIATE_PERSIST_FIELDS.some((field, index) => entity[field] !== checkpoint.fields[index])"), "non-motion change = write at once");
    assert.ok(checkpoint.includes("if (!force && now < checkpoint.dueAt) {\n      return null;\n    }"), "motion waits for the interval");
    assert.ok(bodyOf("tickScene").includes("\n      checkpointDroneMotion(scene, droneEntity, checkpointTime);\n"), "tick checkpoints every drone");
    assert.ok(bodyOf("flushSceneDroneMotion").includes("checkpointDroneMotion(scene, entity, now, true)"), "flush forces");
    assert.ok(read("space/runtime/spaceRuntime/sceneDisposal.js").includes("require(\"../../../services/drone/droneRuntime\").flushSceneDroneMotion([scene]);"), "flush on dispose");
    assert.ok(read("space/runtime.js").includes("require(\"../services/drone/droneRuntime\").flushSceneDroneMotion(runtimeSingleton.scenes.values());"), "flush on stop");
    assert.strictEqual(fixedUpstream(text), true);
    assert.strictEqual(fixedUpstream(""), false);
    const legacy = text.slice(0, text.indexOf(mining)) +
      mining.replace("notifyDroneStateChange(droneEntity, beforeState);", "persistAndNotifyDroneState(droneEntity, beforeState);") +
      text.slice(text.indexOf(mining) + mining.length);
    assert.strictEqual(fixedUpstream(legacy), false, "a mining tick that persists = not fixed");

    const lines = [];
    const ob = createState({ ...base, dronePersistCoalesce: true }, null, { log: (l) => lines.push(l) });
    const ov = mk();
    patchTarget("itemStore", ov.store.exports, ob, path.join(SERVER_SRC, "services", "inventory", "itemStore.js"));
    patchTarget("gameStore", ov.game, ob, path.join(SERVER_SRC, "gameStore", "index.js"));
    patchTarget("droneRuntime", ov.droneRt, ob, path.join(SERVER_SRC, "services", "drone", "droneRuntime.js"));
    assert.strictEqual(ob.drone.status().state, "disabled:obsolete");
    assert.strictEqual(ov.store.exports.updateInventoryItem, ov.store.original);
    assert.strictEqual(ov.store.exports.updateInventoryItemSuccessOnly, ov.store.originalSuccessOnly);
    assert.strictEqual(ov.droneRt.tickScene.__hotPathPerfDrone, undefined);
    assert.deepStrictEqual(lines.filter((l) => l.includes("dronePersistCoalesce")),
      ["WARN dronePersistCoalesce disabled: obsolete (EveJS checkpoints it itself: droneRuntime.checkpointDroneMotion)"]);
    ob.gameSeen = true;
    assert.strictEqual(checkDroneDrift(ob), false);
    const obProbe = probeMessage(ob);
    assert.ok(!/DRIFT/.test(obProbe) && obProbe.endsWith("; dronePersistCoalesce disabled: obsolete"), obProbe);

    for (const name of ["isDroneEntity", "DRONE_COMMAND_MINE", "STATE_MINING", "STATE_APPROACHING", "tickScene"]) {
      assert.ok(text.includes(`\n  ${name},\n`), `export ${name}`);
    }
    assert.ok(read("space/runtime/scene/tick.js").includes("droneRuntime.tickScene(this, now)"));
    assert.ok(read("space/runtime/spaceRuntime/sceneDisposal.js").includes("\ndisposeScene(sceneDescriptor, options = {}) {"));
    const items = read("services/inventory/itemStore.js");
    assert.ok(items.includes("function updateInventoryItem(itemId, updater, resultMode = null) {") && items.includes("\n  updateInventoryItem,\n") &&
      items.includes("\n  updateInventoryItemSuccessOnly,\n") && items.includes("\n  findItemById,\n"));
    assert.ok(items.includes("function updateInventoryItemSuccessOnly(itemId, updater) {\n  return updateInventoryItem(itemId, updater, INVENTORY_UPDATE_SUCCESS_ONLY);\n}"));
    assert.ok(/if \(resultMode === INVENTORY_UPDATE_SUCCESS_ONLY\) \{[\s\S]{0,200}return \{ success: true \};/.test(items));
    assert.ok(/^function findItemById\(itemId\) \{[\s\S]{0,250}return entry \? cloneValue\(entry\) : null;/m.test(items), "findItemById = clone of the index entry");
  });
}

module.exports = { register };
