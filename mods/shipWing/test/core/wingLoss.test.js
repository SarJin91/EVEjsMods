"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createWingService } = require("../../lib/core/wingService");
const { createWingStore } = require("../../lib/store/wingStore");
const { createWingAdapterCore } = require("../../lib/adapter/vendor");
const { resolveConfig } = require("../../config");
const { createSceneGuard } = require("../../lib/adapter/sceneGuard");

const CHAR = 90000001;
const OTHER = 90000002;
const HOST = 1000000400;
const SYSTEM = 30000142;
const SCENE_KEY = "system:30000142";
const MOD_DIR = path.join(__dirname, "..", "..");

function config(extra = {}) {
  return { ...resolveConfig({ modDir: MOD_DIR, env: { EVEJS_SHIPWING_ENABLED: "1" } }).config, ...extra };
}

function ship(itemID) {
  return { itemID, typeID: 22544, groupID: 543, categoryID: 6, ownerID: CHAR, singleton: 1, itemName: `Hulk ${itemID}`,
    conditionState: { damage: 0, charge: 1, armorDamage: 0, shieldCharge: 1 } };
}

function fakeWorld() {
  const w = {
    calls: [],
    sessions: new Map([[CHAR, { space: { systemId: SYSTEM, sceneKey: SCENE_KEY, shipId: HOST } }]]),
    scene: { entities: new Map() },
    loaded: true,
    bay: [ship(501), ship(502)],
    distance: new Map(),
    nextId: 4.2e15,
    settle: () => ({ ok: true, outcome: "HULL_DESTROYED", changes: [{ item: { itemID: 501 } }] }),
    write: () => ({ ok: true, changes: [{ item: { itemID: 501 } }] }),
    entityThrows: false,
  };
  w.scene.entities.set(HOST, { itemID: HOST, mode: "STOP", position: { x: 0, y: 0, z: 0 },
    direction: { x: 1, y: 0, z: 0 }, radius: 500 });
  const adapter = {
    findSession: (id) => w.sessions.get(id) || null,
    spaceOf: (s) => s.space,
    sceneOf: () => w.scene,
    isSceneLoaded: (key, scene) => w.loaded && key === SCENE_KEY && scene === w.scene,
    hostEntity: (scene, id) => scene.entities.get(id) || null,
    hostStatus: () => ({ warping: false, docking: false }),
    listBayShips: (hostId) => (hostId === HOST ? w.bay : []),
    readFit: () => [],
    missingSkills: () => [],
    skillMap: () => new Map(),
    ownerIdentity: () => ({ characterId: CHAR, corporationId: 98000001, allianceId: 0, warFactionId: 0 }),
    allocId: () => {
      w.nextId += 1;
      return w.nextId;
    },
    typeName: () => "Hulk",
    spawn: (scene, _systemId, spec) => {
      const entity = { itemID: spec.itemID, kind: "ship", pilotCharacterID: spec.pilotCharacterID,
        conditionState: { damage: 0.25, charge: 0.5, armorDamage: 0.75, shieldCharge: 0.1 } };
      scene.entities.set(spec.itemID, entity);
      return { ok: true, entity };
    },
    follow: () => true,
    remove: (scene, id) => {
      w.calls.push(["remove", id]);
      if (w.entityThrows) throw new Error("getEntityByID threw");
      if (w.removeFails) return false;
      return scene.entities.delete(id) || !scene.entities.has(id);
    },
    entity: (scene, id) => {
      if (w.entityThrows) throw new Error("entity threw");
      return scene.entities.get(id) || null;
    },
    surfaceDistance: (_scene, a) => (w.distance.has(a.itemID) ? w.distance.get(a.itemID) : 1000),
    settleShipLoss: (args) => {
      w.calls.push(["settle", args.shipItemId, args.wreckId]);
      return w.settle(args);
    },
    conditionOf: (entity) => ({ ...entity.conditionState }),
    writeCondition: (id, condition) => {
      w.calls.push(["writeCondition", id, condition]);
      return w.write(id, condition);
    },
    emitItemChanges: (_session, changes) => {
      w.calls.push(["emit", changes.length]);
      return changes.length;
    },
  };
  return { w, adapter };
}

function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shipwing-loss-"));
  return { dir, file: path.join(dir, "wings.json") };
}

function cleanup(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (_err) {
  }
}

function setup(opts = {}) {
  const { dir, file } = opts.file ? { dir: null, file: opts.file } : tempFile();
  const world = opts.world || fakeWorld();
  const store = createWingStore({ filePath: file });
  store.load();
  const clock = opts.clock || { t: 1000000, now() { return this.t; } };
  const svc = createWingService({ adapter: world.adapter, store, config: config(opts.config), clock,
    guardsReady: () => true, lossReady: () => opts.loss !== false, derivedReady: () => true, tickReady: () => true,
    log: opts.log });
  const changes = [];
  svc.onWingChanged((id) => changes.push(id));
  return { dir, file, w: world.w, adapter: world.adapter, store, clock, svc, changes };
}

function onDisk(file, id) {
  const rec = JSON.parse(fs.readFileSync(file, "utf8")).records.find((r) => r.shipItemId === id);
  return rec || null;
}

function calls(t, kind) {
  return t.w.calls.filter((c) => c[0] === kind);
}

module.exports = ({ test }) => {
  test("LS1 loss exactly once: beginLoss writes LOST before the vendor, settleLoss 1x -> SETTLED (not blocked), "
    + "repeats are no-ops, PURGE after lossRecordRetentionMs; LAUNCHING aborted -> LOST "
    + "no loss hook -> LOSS_UNAVAILABLE", () => {
    const t = setup();
    try {
      assert.deepStrictEqual(t.svc.orderCopy(CHAR, 501, "launch"), { ok: true, state: "ACTIVE" });
      const twinId = t.store.get(501).twinEntityId;
      assert.strictEqual(t.svc.liveTwinCount(), 1);
      const twin = t.w.scene.entities.get(twinId);
      assert.strictEqual(t.svc.claimTwin({ ...twin, pilotCharacterID: OTHER }), null, "pilot must be the owner");
      assert.strictEqual(t.svc.claimTwin({ ...twin, nativeNpc: true }), null);
      assert.strictEqual(t.svc.claimTwin({ itemID: HOST, kind: "ship", pilotCharacterID: CHAR }), null);
      const claim = t.svc.claimTwin(twin);
      assert.deepStrictEqual(claim, { shipItemId: 501, ownerCharacterId: CHAR, twinEntityId: twinId });

      assert.strictEqual(t.svc.hasLossRecord(501), false, "ACTIVE is not a loss (drones)");
      assert.deepStrictEqual(t.svc.beginLoss(501, { cause: "DESTROYED" }), { ok: true, persisted: true });
      assert.strictEqual(t.svc.hasLossRecord(501), true, "LOST -> the boot reclaim skips the ship");
      const lost = onDisk(t.file, 501);
      assert.deepStrictEqual([lost.state, lost.lossCause, lost.twinEntityId], ["LOST", "DESTROYED", twinId],
        "LOST on disk before the vendor runs");
      assert.strictEqual(t.svc.liveTwinCount(), 0, "out of byTwin");
      assert.strictEqual(t.svc.claimTwin(twin), null);
      assert.strictEqual(t.svc.isBlocked(501), true);

      assert.deepStrictEqual(t.svc.settleLoss(501, { wreckId: 9001, vendorChanges: [{ item: { itemID: 5011 } }] }),
        { ok: true, outcome: "HULL_DESTROYED" });
      assert.deepStrictEqual(calls(t, "settle"), [["settle", 501, 9001]]);
      assert.deepStrictEqual(calls(t, "emit"), [["emit", 2]], "vendor changes + hull change to the owner");
      assert.strictEqual(t.store.get(501).state, "SETTLED");
      assert.strictEqual(t.store.get(501).settleOutcome, "HULL_DESTROYED");
      assert.strictEqual(t.svc.isBlocked(501), false, "SETTLED does not block");
      assert.strictEqual(t.svc.hasLossRecord(501), true, "SETTLED is a loss too");
      assert.strictEqual(t.svc.ownsBlocked(CHAR), false);
      t.w.bay =t.w.bay.filter((s) => s.itemID !== 501);
      assert.ok(!t.svc.listWing(CHAR).ships.some((s) => s.shipItemId === 501), "SETTLED is not in listWing");

      assert.deepStrictEqual(t.svc.beginLoss(501, { cause: "DESTROYED" }), { ok: false, reason: "NOT_FLYING" });
      assert.deepStrictEqual(t.svc.settleLoss(501, { wreckId: 9001 }), { ok: false, reason: "NOT_LOST" });
      assert.strictEqual(calls(t, "settle").length, 1, "still one settlement");
      const counters = t.svc.stats().counters;
      assert.deepStrictEqual([counters["loss.destroyed"], counters["loss.settled.HULL_DESTROYED"]], [1, 1]);

      t.clock.t += 29999;
      t.svc.tick(t.clock.t);
      assert.strictEqual(t.store.get(501).state, "SETTLED", "kept for lossRecordRetentionMs (F35)");
      t.clock.t += 1;
      t.svc.tick(t.clock.t);
      assert.strictEqual(t.store.get(501), null, "PURGE");
      assert.strictEqual(onDisk(t.file, 501), null);
      assert.strictEqual(t.svc.stats().counters["loss.purged"], 1);
    } finally {
      cleanup(t.dir);
    }

    const a = setup();
    try {
      const realSpawn = a.adapter.spawn;
      a.adapter.spawn = (scene, systemId, spec) => {
        realSpawn(scene, systemId, spec);
        throw new Error("reboxBall threw");
      };
      assert.deepStrictEqual(a.svc.orderCopy(CHAR, 501, "launch"), { ok: false, reason: "SPAWN_FAILED" });
      const twin = [...a.w.scene.entities.values()].find((e) => e.itemID !== HOST);
      assert.strictEqual(a.store.get(501).state, "LAUNCHING");
      assert.ok(a.svc.claimTwin(twin), "an aborted twin is claimable (byTwin)");
      assert.strictEqual(a.svc.beginLoss(501, { cause: "DESTROYED" }).ok, true);
      assert.strictEqual(a.store.get(501).state, "LOST", "an aborted twin that dies is a loss");
    } finally {
      cleanup(a.dir);
    }

    const noHook = setup({ loss: false });
    try {
      assert.deepStrictEqual(noHook.svc.orderCopy(CHAR, 501, "launch"), { ok: false, reason: "LOSS_UNAVAILABLE" });
      assert.ok(noHook.svc.listWing(CHAR).ships.every((s) => s.refusal === "LOSS_UNAVAILABLE"));
    } finally {
      cleanup(noHook.dir);
    }
  });

  test("LS2 restart during a loss: LOST on disk (no wreck) + hull with 3 modules -> new instance -> settlePending "
    + "destroys everything once (forceAllDestroyed, key wing-loss:501); 3rd instance = 0 calls; SETTLED + hull back "
    + "-> destroyed again -> PURGE; v1 file migrates", () => {
    const items = new Map();
    const log = [];
    const putHull = () => {
      items.set(501, { itemID: 501, ownerID: CHAR, locationID: HOST, flagID: 90, categoryID: 6, singleton: 1 });
      for (const id of [5011, 5012, 5013]) items.set(id, { itemID: id, ownerID: CHAR, locationID: 501, flagID: 27 });
    };
    const game = {
      runtime: { scenes: new Map() }, identity: {}, fitting: {}, skills: {}, types: {}, sessions: {},
      itemStore: { ITEM_FLAGS: { SHIP_HANGAR: 90 }, findItemById: (id) => items.get(id) || null },
      loss: {
        deathOutcome: { resolveLocationDeathOutcome: (loc, opts) => {
          log.push(["resolve", loc, opts]);
          const destroyChanges = [];
          for (const [id, it] of [...items]) {
            if (it.locationID === loc) {
              items.delete(id);
              destroyChanges.push({ item: it, removed: true });
            }
          }
          return { success: true, data: { items: [], movedChanges: [], destroyChanges } };
        } },
        custody: { destroyItem: (cmd) => {
          log.push(["destroy", cmd.item.itemID, cmd.idempotencyKey, cmd.removeContents]);
          items.delete(cmd.item.itemID);
          return { success: true, data: { changes: [{ item: cmd.item, removed: true }] } };
        } },
        characterState: { getActiveShipRecord: () => ({ itemID: HOST }), emitItemsChangedBatchForSession: () => true },
        worldData: { getSolarSystemByID: (id) => (id === SYSTEM ? { solarSystemID: id } : null) },
      },
    };
    const vendorCore = createWingAdapterCore(game);
    const worldWithVendor = () => {
      const world = fakeWorld();
      world.adapter.settleShipLoss = vendorCore.settleShipLoss;
      world.adapter.findSession = () => null;
      return world;
    };
    const lostRecord = { shipItemId: 501, ownerCharacterId: CHAR, hostShipId: HOST, systemId: SYSTEM,
      sceneKey: SCENE_KEY, shipTypeId: 22544, twinEntityId: 4.2e15 + 1, state: "LOST", version: 3, fitDigest: "x",
      launchedAtMs: 1, stateChangedAtMs: 2, reason: null };
    const { dir, file } = tempFile();
    try {
      putHull();
      fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, records: [lostRecord] }));
      const t = setup({ file, world: worldWithVendor() });
      assert.strictEqual(t.store.get(501).wreckId, 0, "migrated: loss fields present");
      assert.deepStrictEqual(t.svc.bootSweep(), { ok: true, cleared: 0, keptLost: 1, reason: null });
      assert.strictEqual(t.svc.isBlocked(501), true);
      assert.deepStrictEqual(t.svc.settlePending(), { settled: 1, purged: 0, failed: 0 });
      assert.deepStrictEqual(log, [
        ["resolve", 501, { forceAllDestroyed: true, seed: "wing-loss:501" }],
        ["destroy", 501, "wing-loss:501", true],
      ]);
      assert.strictEqual(items.size, 0, "hull and 3 modules gone, nothing in a wreck (none existed)");
      assert.strictEqual(onDisk(file, 501).state, "SETTLED");
      assert.strictEqual(JSON.parse(fs.readFileSync(file, "utf8")).schemaVersion, 2);

      const third = setup({ file, world: worldWithVendor() });
      third.svc.bootSweep();
      assert.deepStrictEqual(third.svc.settlePending(), { settled: 0, purged: 1, failed: 0 });
      assert.strictEqual(log.length, 2, "3rd instance: no resolve, no destroy");
      assert.strictEqual(onDisk(file, 501), null);

      putHull();
      fs.writeFileSync(file, JSON.stringify({ schemaVersion: 2, records: [{ ...lostRecord, state: "SETTLED",
        settleOutcome: "HULL_DESTROYED", settledAtMs: 5 }] }));
      const back = setup({ file, world: worldWithVendor() });
      back.svc.bootSweep();
      assert.strictEqual(back.svc.isBlocked(501), false);
      assert.deepStrictEqual(back.svc.settlePending(), { settled: 0, purged: 1, failed: 0 });
      assert.deepStrictEqual(log.slice(2).map((e) => e[0]), ["resolve", "destroy"]);
      assert.strictEqual(items.size, 0);
      assert.strictEqual(onDisk(file, 501), null);
    } finally {
      cleanup(dir);
    }
  });

  test("LS3 MISSING (twin gone without the hook) -> LOST + settled in the same tick; HULL_IN_USE -> retry after "
    + "lossSettleRetryMs x attempts, stuck after lossSettleMaxAttempts; OWNER_CHANGED; SCENE_GONE ends without loss; "
    + "lossOnMissingTwin=false -> TWIN_GONE; entity throws -> block stays", () => {
    const t = setup();
    try {
      t.svc.orderCopy(CHAR, 501, "launch");
      t.w.scene.entities.delete(t.store.get(501).twinEntityId);
      t.clock.t += 500;
      t.svc.tick(t.clock.t);
      assert.deepStrictEqual(calls(t, "settle"), [["settle", 501, 0]], "no wreck");
      assert.deepStrictEqual([t.store.get(501).state, t.store.get(501).lossCause], ["SETTLED", "MISSING"]);
      assert.strictEqual(t.svc.stats().counters["loss.missing"], 1);
    } finally {
      cleanup(t.dir);
    }

    const r = setup({ config: { lossSettleMaxAttempts: 3 } });
    try {
      r.w.settle = () => ({ ok: false, reason: "HULL_IN_USE" });
      r.svc.orderCopy(CHAR, 501, "launch");
      r.w.scene.entities.delete(r.store.get(501).twinEntityId);
      r.svc.tick(r.clock.t);
      assert.strictEqual(calls(r, "settle").length, 1);
      assert.deepStrictEqual([r.store.get(501).state, r.store.get(501).settleAttempts], ["LOST", 1]);
      r.clock.t += 4999;
      r.svc.tick(r.clock.t);
      assert.strictEqual(calls(r, "settle").length, 1, "not before lossSettleRetryMs x 1");
      r.clock.t += 1;
      r.svc.tick(r.clock.t);
      assert.strictEqual(calls(r, "settle").length, 2);
      r.clock.t += 10000;
      r.svc.tick(r.clock.t);
      assert.strictEqual(calls(r, "settle").length, 3);
      const c = r.svc.stats().counters;
      assert.deepStrictEqual([c["loss.settleStuck"], c["loss.hullInUse"], c["loss.settleFailed"]], [1, 3, 3]);
      r.clock.t += 3600000;
      r.svc.tick(r.clock.t);
      assert.strictEqual(calls(r, "settle").length, 3, "stuck: waits for the next start");
      assert.strictEqual(r.svc.isBlocked(501), true, "the block stays");
      r.w.settle = () => ({ ok: true, outcome: "OWNER_CHANGED", changes: [] });
      assert.deepStrictEqual(r.svc.settlePending(), { settled: 1, purged: 0, failed: 0 }, "next start");
      assert.strictEqual(r.store.get(501).settleOutcome, "OWNER_CHANGED");
      assert.strictEqual(r.svc.stats().counters["loss.settled.OWNER_CHANGED"], 1);
    } finally {
      cleanup(r.dir);
    }

    const s = setup();
    try {
      s.svc.orderCopy(CHAR, 501, "launch");
      s.w.loaded = false;
      s.svc.tick(s.clock.t);
      assert.strictEqual(s.store.get(501), null);
      assert.strictEqual(s.svc.stats().counters["end.SCENE_GONE"], 1);
      assert.deepStrictEqual(calls(s, "settle"), [], "SCENE_GONE is no loss");
    } finally {
      cleanup(s.dir);
    }

    const g = setup({ config: { lossOnMissingTwin: false } });
    try {
      g.svc.orderCopy(CHAR, 501, "launch");
      g.w.scene.entities.delete(g.store.get(501).twinEntityId);
      g.svc.tick(g.clock.t);
      assert.strictEqual(g.store.get(501), null, "the ship is given back");
      assert.strictEqual(g.svc.isBlocked(501), false);
      assert.strictEqual(g.svc.stats().counters["end.TWIN_GONE"], 1);
      assert.deepStrictEqual(calls(g, "settle"), []);
    } finally {
      cleanup(g.dir);
    }

    const e = setup();
    try {
      e.adapter.spawn = () => {
        throw new Error("spawn threw");
      };
      e.w.entityThrows = true;
      assert.deepStrictEqual(e.svc.orderCopy(CHAR, 501, "launch"), { ok: false, reason: "SPAWN_FAILED" });
      assert.strictEqual(e.svc.isBlocked(501), true, "Entity threw -> fail-closed, block stays");
      e.svc.tick(e.clock.t);
      assert.strictEqual(e.store.get(501).state, "LAUNCHING", "the tick keeps it while entity throws");
      e.w.entityThrows = false;
      e.svc.tick(e.clock.t);
      assert.strictEqual(e.store.get(501), null, "entity answers: no twin -> LAUNCH_ABORTED");
      assert.ok(e.svc.stats().counters["entity.error"] >= 2);
    } finally {
      cleanup(e.dir);
    }
  });

  test("LS5: the vendor fails after beginLoss and the twin stays in the scene -> the tick "
    + "removes it (remove retried, LOST and the block kept meanwhile), then settles once; hook sweep removes at once; "
    + "a 2nd destruction before the sweep is taken (no vendor)", () => {
    const t = setup();
    try {
      t.svc.orderCopy(CHAR, 501, "launch");
      const twinId = t.store.get(501).twinEntityId;
      const twin = t.w.scene.entities.get(twinId);
      assert.strictEqual(t.svc.beginLoss(501, { cause: "DESTROYED" }).ok, true);
      t.w.removeFails = true;
      t.svc.tick(t.clock.t);
      assert.ok(t.w.scene.entities.has(twinId), "remove refused");
      assert.deepStrictEqual([t.store.get(501).state, t.svc.isBlocked(501)], ["LOST", true], "twin => block");
      assert.deepStrictEqual(calls(t, "settle"), [], "not settled while the twin is in space");
      assert.strictEqual(t.svc.stats().counters["loss.strayRetry"], 1);
      t.w.removeFails = false;
      t.svc.tick(t.clock.t);
      assert.ok(!t.w.scene.entities.has(twinId), "no orphaned twin");
      assert.deepStrictEqual(calls(t, "settle"), [["settle", 501, 0]]);
      assert.strictEqual(t.store.get(501).state, "SETTLED");
      t.svc.tick(t.clock.t);
      assert.strictEqual(calls(t, "remove").length, 2, "no further remove");
      assert.strictEqual(calls(t, "settle").length, 1, "one settlement");
      assert.strictEqual(t.svc.claimTwin(twin), null, "never claimed twice");
      assert.strictEqual(t.svc.stats().counters["loss.strayRemoved"], 1);
    } finally {
      cleanup(t.dir);
    }

    const h = setup();
    try {
      h.svc.orderCopy(CHAR, 501, "launch");
      const twinId = h.store.get(501).twinEntityId;
      const twin = h.w.scene.entities.get(twinId);
      h.svc.beginLoss(501, { cause: "DESTROYED" });
      assert.strictEqual(h.svc.takeLossTwin(twin), true, "destroyed again before the sweep: taken");
      assert.ok(!h.w.scene.entities.has(twinId), "and removed");
      assert.strictEqual(h.svc.takeLossTwin(twin), false);
      assert.deepStrictEqual(h.svc.sweepLossTwin(501), { pending: false }, "idempotent");
      assert.strictEqual(calls(h, "remove").length, 1);
    } finally {
      cleanup(h.dir);
    }
  });

  test("LS7: the twin of a loss (lossTwins, vendor failed) stays protected by the derived-state "
    + "guard until sweepLossTwin; twinOf (mining hook) does not see it; the old pair liveTwinCount/twinOf did not", () => {
    const t = setup();
    try {
      const calls = [];
      const proto = {
        refreshShipEntityDerivedState(entityOrID) {
          calls.push(entityOrID);
          return { success: true, data: { maxVelocity: 1 } };
        },
      };
      const oldProto = { refreshShipEntityDerivedState: proto.refreshShipEntityDerivedState };
      assert.deepStrictEqual(createSceneGuard({ proto, wing: t.svc }).install(), { ok: true });
      const oldView = { liveTwinCount: t.svc.liveTwinCount, twinOf: t.svc.twinOf,
        noteDerivedGuard: t.svc.noteDerivedGuard };
      assert.deepStrictEqual(createSceneGuard({ proto: oldProto, wing: oldView }).install(), { ok: true });
      t.svc.orderCopy(CHAR, 501, "launch");
      const twinId = t.store.get(501).twinEntityId;
      const twin = t.w.scene.entities.get(twinId);
      assert.strictEqual(proto.refreshShipEntityDerivedState(twin).data.shipWingSkipped, true, "ACTIVE twin");
      assert.strictEqual(t.svc.beginLoss(501, { cause: "DESTROYED" }).ok, true);
      assert.ok(t.w.scene.entities.has(twinId));
      assert.deepStrictEqual([t.svc.liveTwinCount(), t.svc.derivedTwinCount()], [0, 1]);
      assert.strictEqual(t.svc.twinOf(twin), null, "the mining hook does not see a lost twin");
      assert.deepStrictEqual(t.svc.derivedTwinOf(twin), { shipItemId: 501, ownerCharacterId: CHAR, twinEntityId: twinId });
      assert.strictEqual(t.svc.derivedTwinOf({ itemID: twinId, pilotCharacterID: OTHER }), null, "other pilot");
      assert.strictEqual(oldProto.refreshShipEntityDerivedState(twin).data.maxVelocity, 1, "old pair: rebuilt (bug)");
      assert.strictEqual(proto.refreshShipEntityDerivedState(twin).data.shipWingSkipped, true, "lost twin protected");
      assert.strictEqual(proto.refreshShipEntityDerivedState(twinId).data.shipWingSkipped, true, "by ID too");
      assert.strictEqual(calls.length, 1, "only the control called the original");
      assert.deepStrictEqual(t.svc.sweepLossTwin(501), { pending: false });
      assert.strictEqual(t.svc.derivedTwinCount(), 0);
      assert.strictEqual(proto.refreshShipEntityDerivedState(twin).data.maxVelocity, 1, "after the sweep: original");
    } finally {
      cleanup(t.dir);
    }
  });

  test("LS6: at start each stuck LOST logs one line with shipItemId and reason; a SETTLED "
    + "recheck failure logs one line too", () => {
    const { dir, file } = tempFile();
    try {
      const base = { ownerCharacterId: CHAR, hostShipId: HOST, systemId: SYSTEM, sceneKey: SCENE_KEY,
        shipTypeId: 22544, twinEntityId: 4.2e15 + 1, version: 3, fitDigest: "x", launchedAtMs: 1,
        stateChangedAtMs: 2, reason: null, lossCause: "DESTROYED", lossAtMs: 2, wreckId: 0, settledAtMs: 0,
        settleOutcome: null };
      fs.writeFileSync(file, JSON.stringify({ schemaVersion: 2, records: [
        { ...base, shipItemId: 501, state: "LOST", settleAttempts: 20, nextSettleAtMs: Number.MAX_SAFE_INTEGER },
        { ...base, shipItemId: 502, state: "SETTLED", settleAttempts: 0, nextSettleAtMs: 0, settledAtMs: 5,
          settleOutcome: "HULL_DESTROYED" },
      ] }));
      const lines = [];
      const log = { log: (m) => lines.push(m), debug() {}, logError() {} };
      const t = setup({ file, log });
      t.w.settle = () => ({ ok: false, reason: "HULL_IN_USE" });
      t.svc.bootSweep();
      assert.deepStrictEqual(t.svc.settlePending(), { settled: 0, purged: 0, failed: 2 });
      const stuck = lines.filter((m) => m.startsWith("LOSS NOT SETTLED at start"));
      assert.strictEqual(stuck.length, 1, lines.join("\n"));
      assert.ok(stuck[0].includes("wing 501") && stuck[0].includes("HULL_IN_USE"), stuck[0]);
      const recheck = lines.filter((m) => m.startsWith("LOSS RECHECK FAILED at start"));
      assert.strictEqual(recheck.length, 1);
      assert.ok(recheck[0].includes("wing 502") && recheck[0].includes("HULL_IN_USE"), recheck[0]);
      assert.strictEqual(t.svc.isBlocked(501), true, "the block stays");
      t.clock.t += 3600000;
      t.svc.tick(t.clock.t);
      assert.strictEqual(lines.filter((m) => m.startsWith("LOSS NOT SETTLED")).length, 1, "no line from the tick");
    } finally {
      cleanup(dir);
    }
  });

  test("LS4 condition written back before the twin is removed (RECALL_DONE), values from the entity, heat of the hull "
    + "kept (vendor accessor); SCENE_GONE no write; a failed write does not block the end", () => {
    const t = setup();
    try {
      t.svc.orderCopy(CHAR, 501, "launch");
      const twinId = t.store.get(501).twinEntityId;
      t.svc.orderCopy(CHAR, 501, "return");
      t.svc.tick(t.clock.t);
      const order = t.w.calls.filter((c) => c[0] === "writeCondition" || c[0] === "remove").map((c) => c[0]);
      assert.deepStrictEqual(order, ["writeCondition", "remove"]);
      assert.deepStrictEqual(calls(t, "writeCondition")[0],
        ["writeCondition", 501, { damage: 0.25, charge: 0.5, armorDamage: 0.75, shieldCharge: 0.1 }]);
      assert.ok(!t.w.scene.entities.has(twinId));
      assert.strictEqual(t.svc.stats().counters["condition.written"], 1);
    } finally {
      cleanup(t.dir);
    }

    const s = setup();
    try {
      s.svc.orderCopy(CHAR, 501, "launch");
      s.w.loaded = false;
      s.svc.tick(s.clock.t);
      assert.deepStrictEqual(calls(s, "writeCondition"), []);
    } finally {
      cleanup(s.dir);
    }

    const f = setup();
    try {
      f.w.write = () => ({ ok: false, reason: "SHIP_NOT_FOUND" });
      f.svc.orderCopy(CHAR, 501, "launch");
      f.w.sessions.delete(CHAR);
      assert.deepStrictEqual(f.svc.tick(f.clock.t), { processed: 1, ended: 1 });
      assert.strictEqual(f.store.get(501), null);
      assert.strictEqual(f.svc.stats().counters["condition.writeFailed"], 1);
    } finally {
      cleanup(f.dir);
    }

    let stored = { itemID: 501, categoryID: 6, conditionState: { damage: 0, charge: 1, armorDamage: 0, shieldCharge: 1,
      incapacitated: false, heat: { hi: 0.4 } } };
    const core = createWingAdapterCore({
      runtime: { scenes: new Map() }, identity: {}, fitting: {}, skills: {}, types: {}, sessions: {},
      itemStore: { ITEM_FLAGS: { SHIP_HANGAR: 90 },
        normalizeShipConditionState: (c) => ({ ...c }),
        updateShipItem: (id, updater) => {
          const previousData = stored;
          stored = updater(stored);
          return { success: true, previousData, data: stored };
        } },
      loss: { deathOutcome: {}, custody: {}, characterState: {}, worldData: {} },
    });
    const written = core.writeCondition(501, core.conditionOf({ conditionState:
      { damage: 0.25, charge: 0.5, armorDamage: 0.75, shieldCharge: 0.1, heat: { hi: 9 } } }));
    assert.strictEqual(written.ok, true);
    assert.deepStrictEqual(stored.conditionState, { damage: 0.25, charge: 0.5, armorDamage: 0.75, shieldCharge: 0.1,
      incapacitated: false, heat: { hi: 0.4 } });
    assert.strictEqual(written.changes[0].item, stored);
    assert.strictEqual(stored.structureDamageBasisHP, null);
    const damaged = core.writeCondition(501, core.conditionOf({ structureHP: 4200, conditionState:
      { damage: 0.25, charge: 0.5, armorDamage: 0.75, shieldCharge: 0.1 } }));
    assert.strictEqual(damaged.ok, true);
    assert.strictEqual(stored.structureDamageBasisHP, 4200);
    core.writeCondition(501, core.conditionOf({ structureHP: 4200, conditionState:
      { damage: 0, charge: 1, armorDamage: 0, shieldCharge: 1 } }));
    assert.strictEqual(stored.structureDamageBasisHP, null);
  });
};
