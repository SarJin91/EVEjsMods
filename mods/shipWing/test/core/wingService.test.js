"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createWingService, COUNTER_NAMES } = require("../../lib/core/wingService");
const { ALL_VERBS } = require("../../lib/core/reasons");
const { createWingStore } = require("../../lib/store/wingStore");
const { transition } = require("../../lib/core/states");
const { refusalText } = require("../../lib/channels/chat");
const { resolveConfig } = require("../../config");
const { slotPoint } = require("../../lib/core/formation");
const { createWingTasks } = require("../../lib/core/wingTasks");
const { refusalText: refusalTextBoard } = require("../../lib/adapter/boardHook");

const CHAR = 90000001;
const OTHER = 90000002;
const HOST = 1000000400;
const SYSTEM = 30000142;
const SCENE_KEY = "system:30000142";
const MOD_DIR = path.join(__dirname, "..", "..");

function config(extra = {}) {
  return { ...resolveConfig({ modDir: MOD_DIR, env: { EVEJS_SHIPWING_ENABLED: "1" } }).config, ...extra };
}

function ship(itemID, extra = {}) {
  return { itemID, typeID: 22544, groupID: 543, categoryID: 6, ownerID: CHAR, singleton: 1, itemName: `Hulk ${itemID}`,
    ...extra };
}

function fakeWorld() {
  const w = {
    calls: [],
    sessions: new Map([[CHAR, { charId: CHAR, space: { systemId: SYSTEM, sceneKey: SCENE_KEY, shipId: HOST } }]]),
    scene: { key: SCENE_KEY, entities: new Map() },
    loaded: true,
    bay: [ship(501), ship(502), ship(503), ship(504, { ownerID: OTHER }), ship(505, { singleton: 0 }),
      ship(506, { typeID: 28606 })],
    distance: new Map(),
    nextId: 4.2e15,
    store: null,
    spawnOk: true,
    activeShip: HOST,
  };
  w.scene.entities.set(HOST, { itemID: HOST, position: { x: 0, y: 0, z: 0 }, direction: { x: 1, y: 0, z: 0 },
    radius: 500, mode: "STOP", pilotCharacterID: CHAR });
  const adapter = {
    findSession: (id) => w.sessions.get(id) || null,
    spaceOf: (s) => s.space,
    sceneOf: () => w.scene,
    isSceneLoaded: (key, scene) => w.loaded && key === SCENE_KEY && scene === w.scene,
    hostEntity: (scene, id) => scene.entities.get(id) || null,
    hostStatus: (_scene, e) => ({ warping: e.mode === "WARP", docking: e.pendingDock === true,
      pilotId: e.pilotCharacterID === undefined ? null : e.pilotCharacterID, cloaked: e.cloaked === true }),
    activeShipId: () => w.activeShip,
    dockedAt: (s) => s.stationid || 0,
    listBayShips: (hostId) => (hostId === HOST ? w.bay : []),
    readFit: (id) => [{ itemID: id * 10, typeID: 17482, flagID: 27, categoryID: 7 }],
    isCharge: (item) => item.categoryID === 8,
    missingSkills: (_c, typeId) => (typeId === 28606 ? [3386] : []),
    skillMap: () => new Map([[3386, { skillLevel: 5 }]]),
    ownerIdentity: () => ({ characterId: CHAR, corporationId: 98000001, allianceId: 0, warFactionId: 0 }),
    allocId: () => {
      w.nextId += 1;
      return w.nextId;
    },
    typeName: () => "Hulk",
    spawn: (scene, systemId, spec) => {
      const rec = w.store.list().find((r) => r.state === "LAUNCHING");
      w.calls.push(["spawn", spec.itemID, rec ? rec.state : null]);
      if (!w.spawnOk) return { ok: false, reason: "TEST" };
      const entity = { itemID: spec.itemID, spec };
      scene.entities.set(spec.itemID, entity);
      return { ok: true, entity };
    },
    follow: (_scene, entity, targetId, range) => {
      w.calls.push(["follow", entity.itemID, targetId, range]);
      return true;
    },
    remove: (scene, id) => {
      const rec = w.store.list().find((r) => r.twinEntityId === id);
      w.calls.push(["remove", id, rec ? rec.state : null]);
      return scene.entities.delete(id);
    },
    entity: (scene, id) => scene.entities.get(id) || null,
    surfaceDistance: (_scene, a) => (w.distance.has(a.itemID) ? w.distance.get(a.itemID) : 1000),
  };
  return { w, adapter };
}

function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shipwing-core-"));
  return { dir, file: path.join(dir, "wings.json") };
}

function setup(opts = {}) {
  const { dir, file } = opts.file ? { dir: null, file: opts.file } : tempFile();
  const { w, adapter } = fakeWorld();
  if (opts.adapterExtra) Object.assign(adapter, opts.adapterExtra(w));
  const store = opts.store || createWingStore({ filePath: file });
  if (!opts.store) store.load();
  w.store = store;
  const clock = { t: 1000000, now() { return this.t; } };
  const svc = createWingService({
    adapter: opts.noAdapter ? null : adapter, store, config: config(opts.config), clock,
    guardsReady: () => opts.guards !== false, lossReady: () => opts.loss !== false,
    derivedReady: () => opts.derived !== false, tickReady: () => opts.tick !== false,
    taskReady: opts.taskReady, taskEngines: opts.taskEngines,
    taskSidecars: opts.taskSidecars, planActive: opts.planActive,
    onOrderAccepted: opts.onOrderAccepted,
    log: opts.log,
    mirrorEngageOn: opts.mirrorEngageOn,
    tasks: opts.tasks, formations: opts.formations, formationReady: opts.formationReady,
    boardReady: opts.boardReady,
    cargo: opts.cargo,
  });
  const changes = [];
  svc.onWingChanged((id) => changes.push(id));
  return { dir, file, w, adapter, store, clock, svc, changes };
}

function cleanup(dir) {
  if (!dir) return;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (_err) {
  }
}

function twinOf(t, shipItemId) {
  return t.store.get(shipItemId).twinEntityId;
}

module.exports = ({ test }) => {
  test("WSV1 launch -> ACTIVE (record before spawn), listWing, listener once; "
    + "return -> tick in range -> removed", () => {
    const t = setup();
    try {
      assert.deepStrictEqual(t.svc.orderCopy(CHAR, 501, "launch"), { ok: true, state: "ACTIVE" });
      assert.deepStrictEqual(t.changes, [CHAR]);
      const spawn = t.w.calls.find((c) => c[0] === "spawn");
      assert.strictEqual(spawn[2], "LAUNCHING", "LAUNCHING written before the spawn");
      const twinId = twinOf(t, 501);
      assert.ok(twinId > 4.2e15 && twinId !== 501);
      assert.strictEqual(t.w.scene.entities.get(twinId).spec.pilotCharacterID, CHAR);
      assert.deepStrictEqual(t.w.calls.find((c) => c[0] === "follow"), ["follow", twinId, HOST, 1500]);
      assert.strictEqual(t.svc.isBlocked(501), true);
      assert.strictEqual(t.svc.blockedCount(), 1);
      assert.strictEqual(JSON.parse(fs.readFileSync(t.file, "utf8")).records[0].state, "ACTIVE");
      const view = t.svc.listWing(CHAR);
      assert.strictEqual(view.hostShipId, HOST);
      assert.strictEqual(view.limit, 2);
      assert.strictEqual(view.deployedCount, 1);
      const byId = new Map(view.ships.map((s) => [s.shipItemId, s]));
      const row = (id) => [byId.get(id).state, byId.get(id).eligible, byId.get(id).refusal];
      assert.deepStrictEqual([...row(501), byId.get(501).entityId], ["ACTIVE", false, "ALREADY_DEPLOYED", twinId]);
      assert.strictEqual(byId.get(501).distanceM, 1000);
      assert.deepStrictEqual(row(502), ["IN_BAY", true, null]);
      assert.strictEqual(byId.get(504).refusal, "NOT_OWNER");
      assert.strictEqual(byId.get(505).refusal, "SHIP_NOT_ASSEMBLED");
      assert.strictEqual(byId.get(506).refusal, "MISSING_SKILLS");
      assert.deepStrictEqual(t.changes, [CHAR], "listWing changes nothing");

      assert.deepStrictEqual(t.svc.orderCopy(CHAR, 501, "return"), { ok: true, state: "RETURNING" });
      assert.deepStrictEqual(t.w.calls[t.w.calls.length - 1], ["follow", twinId, HOST, 0]);
      t.w.distance.set(twinId, 5000);
      t.clock.t += 500;
      assert.deepStrictEqual(t.svc.tick(t.clock.t), { processed: 1, ended: 0 });
      t.w.distance.set(twinId, 2000);
      t.clock.t += 500;
      assert.deepStrictEqual(t.svc.tick(t.clock.t), { processed: 1, ended: 1 });
      assert.deepStrictEqual(t.w.calls.find((c) => c[0] === "remove"), ["remove", twinId, "RETURNING"],
        "the twin is removed while its record still exists");
      assert.strictEqual(t.store.get(501), null);
      assert.strictEqual(t.svc.isBlocked(501), false);
      assert.deepStrictEqual(t.changes, [CHAR, CHAR, CHAR]);
      assert.strictEqual(t.svc.stats().counters["end.RECALL_DONE"], 1);
      assert.deepStrictEqual(JSON.parse(fs.readFileSync(t.file, "utf8")).records, []);
    } finally {
      cleanup(t.dir);
    }
  });

  test("WSV2 idempotency and refusals: ALREADY_DEPLOYED, COOLDOWN, LIMIT, NOT_OWNER, MISSING_SKILLS, "
    + "STORE_WRITE_FAILED (read-only store), GUARDS_UNAVAILABLE, SPAWN_FAILED - nothing spawned on refusal", () => {
    const t = setup();
    try {
      assert.strictEqual(t.svc.orderCopy(CHAR, 501, "launch", { commandId: "c1" }).ok, true);
      assert.deepStrictEqual(t.svc.orderCopy(CHAR, 501, "launch", { commandId: "c1" }),
        { ok: false, reason: "ALREADY_DEPLOYED" });
      assert.strictEqual(t.svc.orderCopy(CHAR, 502, "launch", { commandId: "c1" }).ok, true, "one command, 2 ships");
      assert.deepStrictEqual(t.svc.orderCopy(CHAR, 503, "launch", { commandId: "c2" }),
        { ok: false, reason: "COOLDOWN" });
      t.clock.t += 2000;
      assert.deepStrictEqual(t.svc.orderCopy(CHAR, 503, "launch", { commandId: "c3" }), { ok: false, reason: "LIMIT" });
      assert.deepStrictEqual(t.svc.orderCopy(CHAR, 504, "launch"), { ok: false, reason: "NOT_OWNER" });
      assert.deepStrictEqual(t.svc.orderCopy(CHAR, 999, "launch"), { ok: false, reason: "NOT_IN_SMB" });
      assert.deepStrictEqual(t.svc.orderCopy(CHAR, 501, "mine"), { ok: false, reason: "UNSUPPORTED_VERB" });
      assert.deepStrictEqual(t.svc.orderCopy(OTHER, 501, "return"), { ok: false, reason: "NOT_OWNER" });
      assert.strictEqual(t.svc.orderCopy(CHAR, 501, "return").ok, true);
      assert.deepStrictEqual(t.svc.orderCopy(CHAR, 501, "return"), { ok: false, reason: "NOT_DEPLOYED" }, "2nd return");
      assert.deepStrictEqual(t.svc.orderCopy(CHAR, 503, "return"), { ok: false, reason: "NOT_DEPLOYED" });
      assert.strictEqual(t.w.calls.filter((c) => c[0] === "spawn").length, 2);
      assert.deepStrictEqual(transition("LOST", "RETURN"), { ok: false, reason: "BAD_TRANSITION" });
      assert.deepStrictEqual(transition(null, "LAUNCH"), { ok: true, next: "LAUNCHING" });
    } finally {
      cleanup(t.dir);
    }

    const skills = setup();
    try {
      assert.deepStrictEqual(skills.svc.orderCopy(CHAR, 506, "launch"), { ok: false, reason: "MISSING_SKILLS" });
      assert.deepStrictEqual(skills.svc.orderCopy(CHAR, 505, "launch"), { ok: false, reason: "SHIP_NOT_ASSEMBLED" });
      skills.w.spawnOk = false;
      assert.deepStrictEqual(skills.svc.orderCopy(CHAR, 501, "launch"), { ok: false, reason: "SPAWN_FAILED" });
      assert.strictEqual(skills.store.get(501), null, "failed spawn leaves no record");
      assert.strictEqual(skills.svc.isBlocked(501), false);
      assert.deepStrictEqual(skills.changes, []);
    } finally {
      cleanup(skills.dir);
    }

    const noGuards = setup({ guards: false });
    try {
      assert.deepStrictEqual(noGuards.svc.orderCopy(CHAR, 501, "launch"), { ok: false, reason: "GUARDS_UNAVAILABLE" });
      const shown = noGuards.svc.listWing(CHAR).ships;
      assert.strictEqual(shown.length, 6, "the bay is still listed (R2)");
      assert.ok(shown.every((s) => s.refusal === "GUARDS_UNAVAILABLE" && s.eligible === false));
      assert.deepStrictEqual(noGuards.w.calls, []);
    } finally {
      cleanup(noGuards.dir);
    }
    const disabled = setup({ noAdapter: true });
    try {
      assert.deepStrictEqual(disabled.svc.orderCopy(CHAR, 501, "launch"), { ok: false, reason: "DISABLED" });
      assert.deepStrictEqual(disabled.svc.tick(0), { processed: 0, ended: 0 });
    } finally {
      cleanup(disabled.dir);
    }

    const { dir, file } = tempFile();
    try {
      fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, records: [
        { shipItemId: 777, ownerCharacterId: CHAR, state: "LOST" }] }));
      const before = fs.readFileSync(file);
      let busy = true;
      const flaky = { ...fs,
        readFileSync: (...a) => {
          if (busy) throw Object.assign(new Error("EBUSY"), { code: "EBUSY" });
          return fs.readFileSync(...a);
        },
        renameSync: (...a) => {
          if (busy) throw Object.assign(new Error("EPERM"), { code: "EPERM" });
          return fs.renameSync(...a);
        } };
      const store = createWingStore({ filePath: file, fs: flaky });
      assert.strictEqual(store.load().readOnly, true);
      busy = false;
      const ro = setup({ store, file });
      assert.deepStrictEqual(ro.svc.orderCopy(CHAR, 501, "launch"), { ok: false, reason: "STORE_WRITE_FAILED" });
      assert.deepStrictEqual(ro.w.calls, [], "nothing spawned");
      assert.strictEqual(ro.svc.isBlocked(501), false);
      assert.ok(fs.readFileSync(file).equals(before), "state file bytes unchanged");
    } finally {
      cleanup(dir);
    }
  });

  test("WSV7: no derived-state guard -> launch refused DERIVED_GUARD_UNAVAILABLE (after "
    + "GUARDS_UNAVAILABLE and LOSS_UNAVAILABLE), WingView.refusal and every bay ship carry it, chat has a text; "
    + "nothing spawned", () => {
    const t = setup({ derived: false });
    try {
      assert.deepStrictEqual(t.svc.orderCopy(CHAR, 501, "launch"), { ok: false, reason: "DERIVED_GUARD_UNAVAILABLE" });
      const view = t.svc.listWing(CHAR);
      assert.strictEqual(view.refusal, "DERIVED_GUARD_UNAVAILABLE");
      assert.ok(view.ships.length > 0 && view.ships.every((s) => s.refusal === "DERIVED_GUARD_UNAVAILABLE"
        && s.eligible === false));
      assert.deepStrictEqual(t.w.calls.filter((c) => c[0] === "spawn"), []);
      assert.strictEqual(t.svc.stats().counters["orderCopy.refused.DERIVED_GUARD_UNAVAILABLE"], 1);
      assert.strictEqual(refusalText("DERIVED_GUARD_UNAVAILABLE"),
        "Ship Wing copy protection is not active, nothing launched");
    } finally {
      cleanup(t.dir);
    }
    const noTick = setup({ tick: false });
    try {
      assert.deepStrictEqual(noTick.svc.orderCopy(CHAR, 501, "launch"), { ok: false, reason: "TICK_UNAVAILABLE" });
      assert.strictEqual(noTick.svc.listWing(CHAR).refusal, "TICK_UNAVAILABLE");
      assert.deepStrictEqual(noTick.w.calls.filter((c) => c[0] === "spawn"), []);
      assert.ok(/tick/.test(refusalText("TICK_UNAVAILABLE")), refusalText("TICK_UNAVAILABLE"));
    } finally {
      cleanup(noTick.dir);
    }
    for (const [opts, reason] of [[{ derived: false, loss: false }, "LOSS_UNAVAILABLE"],
      [{ derived: false, guards: false }, "GUARDS_UNAVAILABLE"],
      [{ derived: false, tick: false }, "DERIVED_GUARD_UNAVAILABLE"]]) {
      const o = setup(opts);
      try {
        assert.deepStrictEqual(o.svc.orderCopy(CHAR, 501, "launch"), { ok: false, reason }, "refusal order");
      } finally {
        cleanup(o.dir);
      }
    }
  });

  test("WSV3 forced return per condition (END_REASON), LOST when the twin is gone from a loaded scene, "
    + "restart = new instance on the same file -> bootSweep", () => {
    const cases = [
      ["LOGOFF", (w) => w.sessions.delete(CHAR)],
      ["DOCKED", (w) => { w.sessions.get(CHAR).space = null; }],
      ["JUMPED", (w) => { w.sessions.get(CHAR).space = { ...w.sessions.get(CHAR).space, sceneKey: "system:1" }; }],
      ["HOST_CHANGED", (w) => { w.sessions.get(CHAR).space = { ...w.sessions.get(CHAR).space, shipId: 42 }; }],
      ["HOST_CHANGED", (w) => { w.activeShip = 42; }],
      ["HOST_CHANGED", (w) => { w.scene.entities.get(HOST).pilotCharacterID = 0; }],
      ["HOST_GONE", (w) => w.scene.entities.delete(HOST)],
      ["WARP", (w) => { w.scene.entities.get(HOST).mode = "WARP"; }],
      ["DOCKED", (w) => { w.scene.entities.get(HOST).pendingDock = true; }],
      ["SCENE_GONE", (w) => { w.loaded = false; }],
    ];
    for (const [reason, apply] of cases) {
      const t = setup();
      try {
        assert.strictEqual(t.svc.orderCopy(CHAR, 501, "launch").ok, true);
        const twinId = twinOf(t, 501);
        apply(t.w);
        t.clock.t += 500;
        assert.deepStrictEqual(t.svc.tick(t.clock.t), { processed: 1, ended: 1 }, reason);
        assert.deepStrictEqual(t.w.calls.find((c) => c[0] === "remove"), ["remove", twinId, "ACTIVE"], reason);
        assert.strictEqual(t.store.get(501), null, reason);
        assert.strictEqual(t.svc.isBlocked(501), false, reason);
        assert.strictEqual(t.svc.stats().counters[`end.${reason}`], 1, reason);
      } finally {
        cleanup(t.dir);
      }
    }

    const range = setup();
    try {
      range.svc.orderCopy(CHAR, 501, "launch");
      range.w.distance.set(twinOf(range, 501), 30000);
      range.clock.t += 500;
      assert.strictEqual(range.svc.tick(range.clock.t).ended, 0, "grace");
      range.clock.t += 10000;
      assert.strictEqual(range.svc.tick(range.clock.t).ended, 1);
      assert.strictEqual(range.svc.stats().counters["end.OUT_OF_RANGE"], 1);
    } finally {
      cleanup(range.dir);
    }

    const t = setup();
    try {
      t.svc.orderCopy(CHAR, 501, "launch");
      t.clock.t += 2000;
      t.svc.orderCopy(CHAR, 502, "launch");
      t.w.scene.entities.delete(twinOf(t, 501));
      t.clock.t += 500;
      assert.deepStrictEqual(t.svc.tick(t.clock.t), { processed: 2, ended: 0 });
      assert.strictEqual(t.store.get(501).state, "LOST");
      assert.strictEqual(t.svc.isBlocked(501), true, "LOST stays blocked");
      assert.strictEqual(t.svc.stats().counters.lost, 1);
      assert.strictEqual(t.svc.listWing(CHAR).ships.find((s) => s.shipItemId === 501).refusal, "LOST_UNSETTLED");
      t.clock.t += 2000;
      assert.deepStrictEqual(t.svc.orderCopy(CHAR, 501, "launch"), { ok: false, reason: "LOST_UNSETTLED" });
      assert.strictEqual(t.svc.tick(t.clock.t).processed, 1, "LOST is not ticked");

      const store = createWingStore({ filePath: t.file });
      store.load();
      const again = setup({ store, file: t.file });
      assert.strictEqual(again.svc.blockedCount(), 2, "before the sweep the file is the truth");
      assert.deepStrictEqual(again.svc.bootSweep(), { ok: true, cleared: 1, keptLost: 1, reason: null });
      assert.strictEqual(again.svc.isBlocked(501), true);
      assert.strictEqual(again.svc.isBlocked(502), false);
      assert.deepStrictEqual(again.svc.bootSweep(), { ok: true, cleared: 0, keptLost: 1, reason: null });
      assert.deepStrictEqual(again.svc.tick(again.clock.t), { processed: 0, ended: 0 }, "no twin of another process");
    } finally {
      cleanup(t.dir);
    }
  });

  test("WSV3b ship change: unknown active ship (0) or host pilot (null) keeps the twin; another active ship "
    + "-> HOST_CHANGED with the condition written back once, the twin removed before the record", () => {
    const t = setup();
    try {
      const written = [];
      t.adapter.conditionOf = () => ({ damage: 10, charge: 1, armorDamage: 0, shieldCharge: 1 });
      t.adapter.writeCondition = (id, condition) => {
        written.push([id, condition.damage]);
        return { ok: true, changes: [] };
      };
      assert.strictEqual(t.svc.orderCopy(CHAR, 501, "launch").ok, true);
      t.w.activeShip = 0;
      delete t.w.scene.entities.get(HOST).pilotCharacterID;
      t.clock.t += 500;
      assert.deepStrictEqual(t.svc.tick(t.clock.t), { processed: 1, ended: 0 }, "unknown = no decision");
      t.w.activeShip = 777;
      t.clock.t += 500;
      assert.deepStrictEqual(t.svc.tick(t.clock.t), { processed: 1, ended: 1 });
      assert.deepStrictEqual(written, [[501, 10]]);
      assert.strictEqual(t.store.get(501), null);
      assert.strictEqual(t.svc.isBlocked(501), false);
      assert.strictEqual(t.svc.stats().counters["end.HOST_CHANGED"], 1);
      assert.deepStrictEqual(t.svc.tick(t.clock.t + 500), { processed: 0, ended: 0 }, "ended once");
    } finally {
      cleanup(t.dir);
    }
  });

  test("WSV4: ACTIVE write fails and remove fails -> record and block stay, the tick removes the twin "
    + "(LAUNCH_ABORTED): remove false at the end -> record stays, end.removeRetry, next tick ends it", () => {
    const { dir, file } = tempFile();
    try {
      const real = createWingStore({ filePath: file });
      real.load();
      let failActive = true;
      const flaky = { ...real, put: (r) => (failActive && r.state === "ACTIVE"
        ? { ok: false, reason: "STORE_WRITE_FAILED" } : real.put(r)) };
      const t = setup({ store: flaky, file });
      const realRemove = t.adapter.remove;
      t.adapter.remove = () => false;
      assert.deepStrictEqual(t.svc.orderCopy(CHAR, 501, "launch"), { ok: false, reason: "STORE_WRITE_FAILED" });
      const twinId = t.w.calls.find((c) => c[0] === "spawn")[1];
      assert.ok(t.w.scene.entities.has(twinId), "the twin is still in space");
      assert.strictEqual(t.svc.isBlocked(501), true, "twin => block");
      assert.strictEqual(t.svc.ownsBlocked(CHAR), true);
      assert.strictEqual(real.get(501).state, "LAUNCHING");
      t.adapter.remove = realRemove;
      failActive = false;
      t.clock.t += 500;
      assert.deepStrictEqual(t.svc.tick(t.clock.t), { processed: 1, ended: 1 });
      assert.ok(!t.w.scene.entities.has(twinId));
      assert.strictEqual(real.get(501), null);
      assert.strictEqual(t.svc.isBlocked(501), false);
      assert.strictEqual(t.svc.ownsBlocked(CHAR), false);
      const counters = t.svc.stats().counters;
      assert.deepStrictEqual([counters["end.LAUNCH_ABORTED"], counters["end.removeRetry"]], [1, 1]);
    } finally {
      cleanup(dir);
    }

    const t = setup();
    try {
      assert.strictEqual(t.svc.orderCopy(CHAR, 501, "launch").ok, true);
      const twinId = twinOf(t, 501);
      const realRemove = t.adapter.remove;
      t.adapter.remove = () => false;
      t.w.scene.entities.delete(HOST);
      t.clock.t += 500;
      assert.deepStrictEqual(t.svc.tick(t.clock.t), { processed: 1, ended: 0 });
      assert.strictEqual(t.store.get(501).state, "ACTIVE", "record stays while the twin is in space");
      assert.strictEqual(t.svc.isBlocked(501), true);
      assert.strictEqual(t.svc.stats().counters["end.removeRetry"], 1);
      t.adapter.remove = realRemove;
      t.clock.t += 500;
      assert.deepStrictEqual(t.svc.tick(t.clock.t), { processed: 1, ended: 1 });
      assert.ok(!t.w.scene.entities.has(twinId));
      assert.strictEqual(t.svc.stats().counters["end.HOST_GONE"], 1);
    } finally {
      cleanup(t.dir);
    }
  });

  test("WSV5: spawn puts the twin in the scene, then throws or refuses -> SPAWN_FAILED, record "
    + "LAUNCHING and block stay, the tick removes the twin, then the record (LAUNCH_ABORTED); no twin -> no record",
  () => {
    for (const mode of ["throw", "refuse"]) {
      const t = setup();
      try {
        const realSpawn = t.adapter.spawn;
        t.adapter.spawn = (scene, systemId, spec) => {
          realSpawn(scene, systemId, spec);
          if (mode === "throw") throw new Error("reboxBall threw");
          return { ok: false, reason: "TEST" };
        };
        assert.deepStrictEqual(t.svc.orderCopy(CHAR, 501, "launch"), { ok: false, reason: "SPAWN_FAILED" }, mode);
        const twinId = t.w.calls.find((c) => c[0] === "spawn")[1];
        assert.ok(t.w.scene.entities.has(twinId), `${mode}: the twin is in space`);
        assert.strictEqual(t.svc.isBlocked(501), true, `${mode}twin => block`);
        assert.strictEqual(t.store.get(501).state, "LAUNCHING", mode);
        assert.deepStrictEqual(t.svc.orderCopy(CHAR, 501, "launch"), { ok: false, reason: "ALREADY_DEPLOYED" });
        t.clock.t += 500;
        assert.deepStrictEqual(t.svc.tick(t.clock.t), { processed: 1, ended: 1 }, mode);
        assert.ok(!t.w.scene.entities.has(twinId), `${mode}: removed`);
        assert.strictEqual(t.store.get(501), null, mode);
        assert.strictEqual(t.svc.isBlocked(501), false, mode);
        assert.strictEqual(t.svc.stats().counters["end.LAUNCH_ABORTED"], 1, mode);
        assert.deepStrictEqual(t.changes, [CHAR], `${mode}: listener once, at the end`);
      } finally {
        cleanup(t.dir);
      }
    }

    const t = setup();
    try {
      t.adapter.spawn = () => {
        throw new Error("threw before dynamicEntities.set");
      };
      assert.deepStrictEqual(t.svc.orderCopy(CHAR, 501, "launch"), { ok: false, reason: "SPAWN_FAILED" });
      assert.strictEqual(t.store.get(501), null, "no twin -> no record (today's path)");
      assert.strictEqual(t.svc.isBlocked(501), false);
      assert.deepStrictEqual(t.svc.tick(t.clock.t), { processed: 0, ended: 0 });
    } finally {
      cleanup(t.dir);
    }
  });

  test("WT1 SUPPORTED_VERBS = enabled subset: flags off -> launch/return (hold refused UNSUPPORTED_VERB); "
    + "miningEnabled -> +hold; mine only with its engine; no probe -> no task verb; counters for ALL_VERBS", () => {
    const cases = [
      [{}, () => true, undefined, ["launch", "return"]],
      [{ miningEnabled: true }, () => true, undefined, ["launch", "return", "hold"]],
      [{ miningEnabled: true }, () => false, undefined, ["launch", "return"]],
      [{ miningEnabled: true }, () => true, { mine: { name: "mine" } }, ["launch", "return", "mine", "hold"]],
    ];
    for (const [cfg, taskReady, taskEngines, expected] of cases) {
      const t = setup({ config: cfg, taskReady, taskEngines });
      try {
        assert.deepStrictEqual([...t.svc.SUPPORTED_VERBS], expected, JSON.stringify(cfg));
        if (!expected.includes("hold")) {
          assert.deepStrictEqual(t.svc.orderCopy(CHAR, 501, "hold"), { ok: false, reason: "UNSUPPORTED_VERB" });
        }
      } finally {
        cleanup(t.dir);
      }
    }
    for (const verb of ALL_VERBS) assert.ok(COUNTER_NAMES.includes(`orderCopy.ok.${verb}`), verb);
  });

  test("WT2 FOLLOW -> HOLD -> MINE (engine moves the twin: no follow) -> hold stops it; refusals NOT_OWNER / "
    + "NOT_DEPLOYED (RETURNING); twinOf O(1); RECALL_DONE: beforeEnd before remove, then drop (no context left)", () => {
    const events = [];
    const engine = {
      name: "mine",
      canRun: () => ({ ok: true }),
      start: (_rt, opts) => events.push(["start", opts.targetId]),
      step: () => ({ controlsMovement: true }),
      stop: (_rt, reason) => events.push(["stop", reason]),
      beforeEnd: (_rt, reason) => events.push(["beforeEnd", reason]),
    };
    const t = setup({ config: { miningEnabled: true }, taskReady: () => true, taskEngines: { mine: engine } });
    try {
      assert.strictEqual(t.svc.orderCopy(CHAR, 501, "launch").ok, true);
      const twinId = twinOf(t, 501);
      const row = () => t.svc.listWing(CHAR).ships.find((s) => s.shipItemId === 501);
      assert.deepStrictEqual([row().task, row().holdM3, row().targetId], ["FOLLOW", 0, null]);
      assert.deepStrictEqual(t.svc.twinOf(twinId), { shipItemId: 501, ownerCharacterId: CHAR, twinEntityId: twinId });
      assert.deepStrictEqual(t.svc.twinOf({ itemID: twinId, pilotCharacterID: CHAR }).shipItemId, 501);
      assert.strictEqual(t.svc.twinOf({ itemID: twinId, pilotCharacterID: OTHER }), null);
      assert.strictEqual(t.svc.twinOf(HOST), null);

      assert.deepStrictEqual(t.svc.orderCopy(CHAR, 501, "hold"), { ok: true, state: "ACTIVE", task: "HOLD" });
      assert.deepStrictEqual(t.svc.orderCopy(CHAR, 501, "hold"), { ok: true, state: "ACTIVE", task: "HOLD" });
      assert.strictEqual(row().task, "HOLD");
      assert.deepStrictEqual(t.svc.orderCopy(OTHER, 501, "hold"), { ok: false, reason: "NOT_OWNER" });
      assert.deepStrictEqual(t.svc.orderCopy(CHAR, 502, "hold"), { ok: false, reason: "NOT_DEPLOYED" });

      assert.deepStrictEqual(t.svc.orderCopy(CHAR, 501, "mine", { targetId: 777 }),
        { ok: true, state: "ACTIVE", task: "MINE" });
      assert.strictEqual(row().targetId, 777);
      t.adapter.conditionOf = (e) => e.conditionState || null;
      t.w.scene.entities.get(twinId).conditionState = { shieldCharge: 0.5, armorDamage: 0.25, damage: 0 };
      t.w.bay[1].conditionState = { shieldCharge: 1, armorDamage: 0, damage: 0.1 };
      t.w.scene.entities.set(777, { itemID: 777, typeID: 1230 });
      const ships = new Map(t.svc.listWing(CHAR).ships.map((s) => [s.shipItemId, s]));
      assert.deepStrictEqual([501, 502, 503].map((id) => [ships.get(id).typeName, ships.get(id).hp,
        ships.get(id).targetName]), [["Hulk", [500, 750, 1000], "Hulk"], ["Hulk", [1000, 1000, 900], null],
        ["Hulk", null, null]]);
      const follows = () => t.w.calls.filter((c) => c[0] === "follow").length;
      const before = follows();
      t.clock.t += 5000;
      t.svc.tick(t.clock.t);
      assert.strictEqual(follows(), before, "the MINE engine moves the twin, no follow retune");
      assert.deepStrictEqual(t.svc.orderCopy(CHAR, 501, "hold").task, "HOLD");
      t.svc.tick(t.clock.t);
      assert.strictEqual(follows(), before + 1, "HOLD: the core follows the host at once");
      assert.strictEqual(t.svc.orderCopy(CHAR, 501, "mine").ok, true);

      assert.deepStrictEqual(t.svc.orderCopy(CHAR, 501, "return"), { ok: true, state: "RETURNING" });
      assert.deepStrictEqual(t.svc.orderCopy(CHAR, 501, "hold"), { ok: false, reason: "NOT_DEPLOYED" });
      assert.ok(t.svc.twinTaskContext(twinId), "suspended, kept for beforeEnd");
      t.adapter.remove = ((remove) => (scene, id) => {
        events.push(["remove"]);
        return remove(scene, id);
      })(t.adapter.remove);
      t.w.distance.set(twinId, 100);
      t.clock.t += 500;
      assert.deepStrictEqual(t.svc.tick(t.clock.t), { processed: 1, ended: 1 });
      assert.deepStrictEqual(events, [["start", 777], ["stop", "ORDER"], ["start", null], ["stop", "RETURN"],
        ["beforeEnd", "RECALL_DONE"], ["remove"]], "one stop per task, beforeEnd before the remove");
      assert.strictEqual(t.svc.twinTaskContext({ itemID: twinId }), null);
      assert.strictEqual(t.svc.stats().tasks, 0);
      const c = t.svc.stats().counters;
      assert.strictEqual(c["task.drop.RECALL_DONE"], 1);
      assert.strictEqual(c["orderCopy.ok.hold"], 3);
      assert.strictEqual(c["task.order.ok.mine"], 2);
    } finally {
      cleanup(t.dir);
    }
  });

  test("WT3 drop at LOST and RESTART: no task runtime left (no leak), counters task.drop.LOST / RESTART", () => {
    const t = setup({ config: { miningEnabled: true }, taskReady: () => true });
    try {
      assert.strictEqual(t.svc.orderCopy(CHAR, 501, "launch", { commandId: "c" }).ok, true);
      assert.strictEqual(t.svc.orderCopy(CHAR, 502, "launch", { commandId: "c" }).ok, true);
      const lostTwin = twinOf(t, 501);
      assert.strictEqual(t.svc.orderCopy(CHAR, 501, "hold").ok, true);
      assert.strictEqual(t.svc.stats().tasks, 2);
      assert.strictEqual(t.svc.beginLoss(501, { cause: "DESTROYED" }).ok, true);
      assert.strictEqual(t.svc.twinTaskContext(lostTwin), null);
      assert.strictEqual(t.svc.stats().tasks, 1);
      t.svc.bootSweep();
      const c = t.svc.stats().counters;
      assert.deepStrictEqual([c["task.drop.LOST"], c["task.drop.RESTART"], t.svc.stats().tasks], [1, 1, 0]);
    } finally {
      cleanup(t.dir);
    }
  });

  test("SL3 safe logoff: onOrderAccepted(charId, verb, source) once per accepted orderCopy (launch "
    + "hold, mine, attack, return), never on a refusal; a throw leaves the result as it is (orderAccepted.error); "
    + "deployedCount = LAUNCHING/ACTIVE/RETURNING records of the pilot", () => {
    const engine = (name) => ({ name, canRun: () => ({ ok: true }), start() {}, step: () => ({}), stop() {} });
    const calls = [];
    let throwing = false;
    const t = setup({ config: { miningEnabled: true, combatEnabled: true }, taskReady: () => true,
      taskEngines: { mine: engine("mine"), attack: engine("attack") },
      onOrderAccepted: (charId, verb, source) => {
        calls.push([charId, verb, source]);
        if (throwing) throw new Error("hook");
      } });
    try {
      assert.strictEqual(t.svc.deployedCount(CHAR), 0);
      assert.strictEqual(t.svc.orderCopy(CHAR, 504, "launch").ok, false, "NOT_OWNER");
      assert.strictEqual(t.svc.orderCopy(CHAR, 502, "hold").ok, false, "NOT_DEPLOYED");
      assert.strictEqual(t.svc.orderCopy(CHAR, 501, "warp").ok, false, "UNSUPPORTED_VERB");
      assert.deepStrictEqual(calls, [], "no call on a refusal");

      assert.strictEqual(t.svc.orderCopy(CHAR, 501, "launch", { commandId: "c" }).ok, true);
      assert.strictEqual(t.svc.orderCopy(CHAR, 502, "launch", { commandId: "c", source: "window" }).ok, true);
      assert.strictEqual(t.svc.orderCopy(CHAR, 501, "hold").ok, true);
      assert.strictEqual(t.svc.orderCopy(CHAR, 501, "mine", { targetId: 777 }).ok, true);
      assert.strictEqual(t.svc.orderCopy(CHAR, 501, "mine", { targetId: 777 }).ok, true, "same target: ok, no-op");
      assert.strictEqual(t.svc.orderCopy(CHAR, 502, "attack", { targetId: 888, source: "mirror" }).ok, true);
      assert.strictEqual(t.svc.deployedCount(CHAR), 2);
      assert.strictEqual(t.svc.orderCopy(CHAR, 501, "return").ok, true);
      assert.strictEqual(t.svc.orderCopy(CHAR, 501, "hold").ok, false, "RETURNING: NOT_DEPLOYED");
      assert.deepStrictEqual(calls, [[CHAR, "launch", "chat"], [CHAR, "launch", "window"], [CHAR, "hold", "chat"],
        [CHAR, "mine", "chat"], [CHAR, "mine", "chat"], [CHAR, "attack", "mirror"], [CHAR, "return", "chat"]]);
      assert.strictEqual(t.svc.deployedCount(CHAR), 2, "RETURNING counts");
      assert.strictEqual(t.svc.deployedCount(String(CHAR)), 2);
      assert.strictEqual(t.svc.deployedCount(OTHER), 0);

      throwing = true;
      assert.deepStrictEqual(t.svc.orderCopy(CHAR, 502, "hold"), { ok: true, state: "ACTIVE", task: "HOLD" });
      assert.strictEqual(t.svc.stats().counters["orderAccepted.error"], 1);
      assert.strictEqual(calls.length, 8);
    } finally {
      cleanup(t.dir);
    }
  });

  test("WSV8 (bug-review pkt 2) a loss whose LOST write failed: return and a task order read the "
    + "record through recordOf (LOST from memory) -> NOT_DEPLOYED, the store gets no RETURNING; deployedCount 0", () => {
    const { dir, file } = tempFile();
    try {
      const real = createWingStore({ filePath: file });
      real.load();
      let failLost = false;
      const flaky = { ...real, put: (r) => (failLost && r.state === "LOST"
        ? { ok: false, reason: "STORE_WRITE_FAILED" } : real.put(r)) };
      const t = setup({ store: flaky, file, config: { miningEnabled: true }, taskReady: () => true });
      assert.strictEqual(t.svc.orderCopy(CHAR, 501, "launch").ok, true);
      failLost = true;
      assert.deepStrictEqual(t.svc.beginLoss(501, { cause: "DESTROYED" }), { ok: true, persisted: false });
      failLost = false;
      assert.deepStrictEqual(t.svc.orderCopy(CHAR, 501, "return"), { ok: false, reason: "NOT_DEPLOYED" });
      assert.deepStrictEqual(t.svc.orderCopy(CHAR, 501, "hold"), { ok: false, reason: "NOT_DEPLOYED" });
      assert.strictEqual(real.get(501).state, "ACTIVE", "no RETURNING written over the loss");
      assert.strictEqual(t.svc.deployedCount(CHAR), 0);
      assert.strictEqual(t.svc.listWing(CHAR).deployedCount, 0);
    } finally {
      cleanup(dir);
    }
  });

  test("WSV9 (bug-review pkt 3) the tick drops a lastLaunch entry once commandCooldownMs passed "
    + "COOLDOWN unchanged inside the window", () => {
    const t = setup();
    try {
      assert.strictEqual(t.svc.orderCopy(CHAR, 501, "launch", { commandId: "a" }).ok, true);
      assert.strictEqual(t.svc.stats().cooldowns, 1);
      t.clock.t += config().commandCooldownMs - 1;
      t.svc.tick(t.clock.t);
      assert.strictEqual(t.svc.stats().cooldowns, 1);
      assert.deepStrictEqual(t.svc.orderCopy(CHAR, 502, "launch", { commandId: "b" }),
        { ok: false, reason: "COOLDOWN" });
      t.clock.t += 1;
      t.svc.tick(t.clock.t);
      assert.strictEqual(t.svc.stats().cooldowns, 0, "entry dropped");
      assert.strictEqual(t.svc.orderCopy(CHAR, 502, "launch", { commandId: "b" }).ok, true);
    } finally {
      cleanup(t.dir);
    }
  });

  test("WSV10 (bug-review pkt 4) skillMap throws -> the launch goes on (twin without skills) "
    + "counter launch.noSkills + one log line", () => {
    const lines = [];
    const t = setup({ log: { log: (l) => lines.push(l), debug() {}, logError() {} } });
    try {
      t.adapter.skillMap = () => {
        throw new Error("skills broke");
      };
      assert.deepStrictEqual(t.svc.orderCopy(CHAR, 501, "launch"), { ok: true, state: "ACTIVE" });
      assert.strictEqual(t.w.scene.entities.get(twinOf(t, 501)).spec.skillMap.size, 0);
      assert.strictEqual(t.svc.stats().counters["launch.noSkills"], 1);
      assert.strictEqual(lines.filter((l) => l.includes("501") && l.includes("skill")).length, 1, lines.join("\n"));
    } finally {
      cleanup(t.dir);
    }
  });

  test("WS-engage setMirrorEngage: mirror off -> ENGAGE_UNAVAILABLE and no mirrorEngage in the view "
    + "a foreign pilot -> NOT_OWNER; ok -> listWing mirrorEngage true + listener; a new twin starts with "
    + "commandMirrorEngageCopyDefault", () => {
    let mirrorOn = false;
    const t = setup({ mirrorEngageOn: () => mirrorOn });
    const row = (id) => t.svc.listWing(CHAR).ships.find((s) => s.shipItemId === id);
    try {
      assert.strictEqual(t.svc.orderCopy(CHAR, 501, "launch", { commandId: "a" }).ok, true);
      assert.deepStrictEqual(t.svc.setMirrorEngage(CHAR, 501, true), { ok: false, reason: "ENGAGE_UNAVAILABLE" });
      assert.strictEqual(row(501).mirrorEngage, null, "engage mirror off: no toggle");
      mirrorOn = true;
      assert.strictEqual(row(501).mirrorEngage, false, "copy default off");
      assert.deepStrictEqual(t.svc.setMirrorEngage(OTHER, 501, true), { ok: false, reason: "NOT_OWNER" });
      assert.deepStrictEqual(t.svc.setMirrorEngage(CHAR, 502, true), { ok: false, reason: "NOT_DEPLOYED" });
      const before = t.changes.length;
      assert.deepStrictEqual(t.svc.setMirrorEngage(CHAR, 501, true), { ok: true, state: "ACTIVE", on: true });
      assert.strictEqual(row(501).mirrorEngage, true);
      assert.strictEqual(t.changes.length, before + 1, "onWingChanged");
      assert.strictEqual(row(502).mirrorEngage, null, "a ship in the bay has no toggle");
    } finally {
      cleanup(t.dir);
    }
    const t2 = setup({ config: { commandMirrorEngageCopyDefault: true }, mirrorEngageOn: () => {
      throw new Error("late");
    } });
    try {
      assert.strictEqual(t2.svc.orderCopy(CHAR, 501, "launch", { commandId: "b" }).ok, true);
      assert.deepStrictEqual(t2.svc.setMirrorEngage(CHAR, 501, false), { ok: false, reason: "ENGAGE_UNAVAILABLE" },
        "a throwing dep = off");
    } finally {
      cleanup(t2.dir);
    }
    const t3 = setup({ config: { commandMirrorEngageCopyDefault: true }, mirrorEngageOn: () => true });
    try {
      assert.strictEqual(t3.svc.orderCopy(CHAR, 501, "launch", { commandId: "c" }).ok, true);
      assert.strictEqual(t3.svc.listWing(CHAR).ships.find((s) => s.shipItemId === 501).mirrorEngage, true);
    } finally {
      cleanup(t3.dir);
    }
  });

  test("FM-C1 (formations) formation none (flag on) and formationEnabled=false: the tick calls only "
    + "follow with followRangeMeters, never gotoPoint - the call sequence of today; config defaults", () => {
    const c = config();
    assert.deepStrictEqual([c.formationEnabled, c.formationSpacingMeters, c.formationMaxDistanceMeters,
      c.formationRetuneMs, c.formationRepointMeters, c.formationLeadMs, c.formationWedgeAngleDeg,
      c.formationMaxPilots], [true, 1000, 12000, 1000, 150, 1000, 45, 10000]);
    const bad = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_SHIPWING_ENABLED: "1",
      EVEJS_SHIPWING_FORMATION_WEDGE_ANGLE_DEG: "81" } });
    assert.strictEqual(bad.config.formationWedgeAngleDeg, 45, "out of range keeps the default");
    const run = (extra) => {
      const t = setup({ ...extra, formationReady: () => true, adapterExtra: formationAdapter });
      try {
        assert.strictEqual(t.svc.orderCopy(CHAR, 501, "launch").ok, true);
        for (let i = 0; i < 4; i += 1) {
          t.clock.t += 500;
          t.svc.tick(t.clock.t);
        }
        return { calls: t.w.calls.filter((call) => call[0] !== "spawn"), on: t.svc.formationOn,
          formation: t.svc.formationOf(CHAR), view: t.svc.listWing(CHAR).formation };
      } finally {
        cleanup(t.dir);
      }
    };
    const none = run({});
    const off = run({ config: { formationEnabled: false } });
    const twin = none.calls[0][1];
    const expected = [["follow", twin, HOST, 1500], ["follow", twin, HOST, 1500], ["follow", twin, HOST, 1500]];
    assert.deepStrictEqual(none.calls, expected);
    assert.deepStrictEqual(off.calls.map((call) => call.slice(2)), expected.map((call) => call.slice(2)));
    assert.deepStrictEqual([none.on, none.formation, none.view], [true, "none", "none"]);
    assert.deepStrictEqual([off.on, off.formation, off.view], [false, "none", null]);
  });

  test("FM-C2 (formations) wedge with 2 FOLLOW twins: one gotoPoint each to its own slot; the "
    + "next tick without host motion sends nothing (repointSkipped); a twin whose task steers (MINE) gets no "
    + "gotoPoint and the other keeps index 1; ctx.formation reaches the task; none -> follow at the next tick", () => {
    const seen = [];
    const steering = new Set();
    const tasks = {
      start() {}, drop() {}, suspend() {}, beforeEnd() {}, dropAll() {}, view: () => null, context: () => null,
      supports: () => false, stats: () => ({ tasks: 0, counters: {} }),
      step(record, _runtime, ctx) {
        seen.push([record.shipItemId, ctx.formation]);
        return { controlsMovement: steering.has(record.shipItemId) };
      },
    };
    const t = setup({ formationReady: () => true, adapterExtra: formationAdapter, tasks });
    try {
      assert.deepStrictEqual(t.svc.setFormation(CHAR, "foo"), { ok: false, reason: "FORMATION_INVALID" });
      assert.strictEqual(t.svc.orderCopy(CHAR, 501, "launch", { commandId: "c" }).ok, true);
      assert.strictEqual(t.svc.orderCopy(CHAR, 502, "launch", { commandId: "c" }).ok, true);
      assert.deepStrictEqual(t.svc.setFormation(CHAR, " Wedge "), { ok: true, formation: "wedge", persisted: false });
      t.w.calls.length = 0;
      t.clock.t += 500;
      t.svc.tick(t.clock.t);
      const gotos = t.w.calls.filter((c) => c[0] === "gotoPoint");
      assert.deepStrictEqual(t.w.calls.map((c) => c[0]), ["gotoPoint", "gotoPoint"], "no follow");
      assert.deepStrictEqual(gotos.map((c) => c[1]), [twinOf(t, 501), twinOf(t, 502)]);
      const expectedSlot = (index) => slotPoint({ name: "wedge", index, count: 2, maxRadius: 0, cfg: config(),
        host: { position: { x: 0, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, direction: { x: 1, y: 0, z: 0 } } });
      assert.deepStrictEqual([gotos[0][2], gotos[1][2]], [expectedSlot(0), expectedSlot(1)]);
      assert.deepStrictEqual(seen.slice(-2), [[501, true], [502, true]], "ctx.formation reaches the task");
      t.w.calls.length = 0;
      t.clock.t += 1000;
      t.svc.tick(t.clock.t);
      assert.deepStrictEqual(t.w.calls, []);
      assert.strictEqual(t.svc.stats().counters["formation.repointSkipped"], 2);
      steering.add(501);
      t.w.scene.entities.get(HOST).position = { x: 5000, y: 0, z: 0 };
      t.clock.t += 1000;
      t.svc.tick(t.clock.t);
      const moved = slotPoint({ name: "wedge", index: 1, count: 2, maxRadius: 0, cfg: config(),
        host: { position: { x: 5000, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, direction: { x: 1, y: 0, z: 0 } } });
      assert.deepStrictEqual(t.w.calls, [["gotoPoint", twinOf(t, 502), moved]]);
      t.w.calls.length = 0;
      assert.strictEqual(t.svc.setFormation(CHAR, "none").ok, true);
      t.clock.t += 500;
      t.svc.tick(t.clock.t);
      assert.deepStrictEqual(t.w.calls, [["follow", twinOf(t, 502), HOST, 1500]]);
    } finally {
      cleanup(t.dir);
    }
  });

  test("FM-I1 (formations) a task that steers clears runtime.formationPoint: after it "
    + "gives the twin back, the slot GotoPoint goes out at once although the host stands and the twin is still in "
    + "GOTO", () => {
    let steer = false;
    const tasks = {
      start() {}, drop() {}, suspend() {}, beforeEnd() {}, dropAll() {}, view: () => null, context: () => null,
      supports: () => false, stats: () => ({ tasks: 0, counters: {} }),
      step: () => ({ controlsMovement: steer }),
    };
    const t = setup({ formationReady: () => true, adapterExtra: formationAdapter, tasks });
    try {
      assert.strictEqual(t.svc.orderCopy(CHAR, 501, "launch", { commandId: "c" }).ok, true);
      assert.strictEqual(t.svc.setFormation(CHAR, "line").ok, true);
      t.w.calls.length = 0;
      t.clock.t += 500;
      t.svc.tick(t.clock.t);
      assert.deepStrictEqual(t.w.calls.map((c) => c[0]), ["gotoPoint"]);
      steer = true;
      t.clock.t += 500;
      t.svc.tick(t.clock.t);
      steer = false;
      t.w.calls.length = 0;
      t.clock.t += 1000;
      t.svc.tick(t.clock.t);
      assert.deepStrictEqual(t.w.calls.map((c) => [c[0], c[1]]), [["gotoPoint", twinOf(t, 501)]],
        "no dedup against the point of before the task");
      assert.strictEqual(t.svc.stats().counters["formation.goto"], 2);
    } finally {
      cleanup(t.dir);
    }
  });

  test("FM-R1 (formations) wedge, 2 ACTIVE twins, the host warps: both end WARP, no launch while the host "
    + "warps (wait); out of warp one tick spawns both in the old launchedAtMs order, ACTIVE; slots at the next tick",
  () => {
    const t = setup({ formationReady: () => true, adapterExtra: formationAdapter });
    try {
      assert.strictEqual(t.svc.orderCopy(CHAR, 502, "launch", { commandId: "c" }).ok, true);
      t.clock.t += 100;
      assert.strictEqual(t.svc.orderCopy(CHAR, 501, "launch", { commandId: "c" }).ok, true);
      assert.strictEqual(t.svc.setFormation(CHAR, "wedge").ok, true);
      const slotsOf = () => {
        const byTwin = new Map(t.w.calls.filter((call) => call[0] === "gotoPoint").map((call) => [call[1], call[2]]));
        return [501, 502].map((id) => byTwin.get(twinOf(t, id)));
      };
      t.w.calls.length = 0;
      t.clock.t += 500;
      t.svc.tick(t.clock.t);
      const before = slotsOf();
      assert.ok(before.every(Boolean), "both twins took a slot");
      assert.notDeepStrictEqual(before[0], before[1]);
      const host = t.w.scene.entities.get(HOST);
      host.mode = "WARP";
      t.w.calls.length = 0;
      t.clock.t += 500;
      t.svc.tick(t.clock.t);
      t.clock.t += 5000;
      t.svc.tick(t.clock.t);
      const c = t.svc.stats().counters;
      assert.deepStrictEqual([c["end.WARP"], c["formation.relaunch.noted"], c["formation.relaunch.wait"]], [2, 2, 2]);
      assert.deepStrictEqual([t.store.get(501), t.store.get(502)], [null, null]);
      assert.strictEqual(t.w.calls.filter((call) => call[0] === "spawn").length, 0, "no launch while warping");
      assert.strictEqual(t.svc.stats().relaunchPending, 1);
      host.mode = "STOP";
      t.w.calls.length = 0;
      t.clock.t += 500;
      t.svc.tick(t.clock.t);
      assert.deepStrictEqual(t.w.calls.filter((call) => call[0] === "spawn").map((call) => call[1]),
        [twinOf(t, 502), twinOf(t, 501)], "old launchedAtMs order");
      assert.deepStrictEqual([t.store.get(501).state, t.store.get(502).state], ["ACTIVE", "ACTIVE"]);
      assert.deepStrictEqual([t.svc.stats().relaunchPending, t.svc.stats().counters["formation.relaunch.launched"]],
        [0, 2]);
      assert.strictEqual(t.svc.stats().counters["orderCopy.ok.launch"], 2, "only the two orders of the pilot");
      t.w.calls.length = 0;
      t.clock.t += 500;
      t.svc.tick(t.clock.t);
      assert.deepStrictEqual(t.w.calls.map((call) => call[0]), ["gotoPoint", "gotoPoint"], "the formation takes them");
      assert.deepStrictEqual(slotsOf(), before, "Each ship back in its old slot (same tick, same ms)");
    } finally {
      cleanup(t.dir);
    }
  });

  test("FM-R2 (formations) formation none and formationEnabled=false: end WARP as today, no spawn after "
    + "the warp; a pilot with a formation in another ship -> the intent dropped (dropped.HOST_CHANGED)", () => {
    for (const extra of [{}, { config: { formationEnabled: false } }]) {
      const t = setup({ ...extra, formationReady: () => true, adapterExtra: formationAdapter });
      try {
        assert.strictEqual(t.svc.orderCopy(CHAR, 501, "launch", { commandId: "c" }).ok, true);
        assert.strictEqual(t.svc.orderCopy(CHAR, 502, "launch", { commandId: "c" }).ok, true);
        const host = t.w.scene.entities.get(HOST);
        host.mode = "WARP";
        t.w.calls.length = 0;
        t.clock.t += 500;
        t.svc.tick(t.clock.t);
        host.mode = "STOP";
        for (let i = 0; i < 3; i += 1) {
          t.clock.t += 3000;
          t.svc.tick(t.clock.t);
        }
        const c = t.svc.stats().counters;
        assert.deepStrictEqual([c["end.WARP"], c["formation.relaunch.noted"], t.svc.stats().relaunchPending], [2, 0, 0]);
        assert.strictEqual(t.w.calls.filter((call) => call[0] === "spawn").length, 0, "the twins do not come back");
        assert.deepStrictEqual([t.store.get(501), t.store.get(502)], [null, null]);
      } finally {
        cleanup(t.dir);
      }
    }
    const t = setup({ formationReady: () => true, adapterExtra: formationAdapter });
    try {
      assert.strictEqual(t.svc.setFormation(CHAR, "line").ok, true);
      assert.strictEqual(t.svc.orderCopy(CHAR, 501, "launch").ok, true);
      t.w.scene.entities.get(HOST).mode = "WARP";
      t.clock.t += 2500;
      t.svc.tick(t.clock.t);
      assert.strictEqual(t.svc.stats().relaunchPending, 1);
      t.w.scene.entities.get(HOST).mode = "STOP";
      t.w.activeShip = 777;
      t.w.calls.length = 0;
      t.clock.t += 500;
      t.svc.tick(t.clock.t);
      assert.strictEqual(t.svc.stats().counters["formation.relaunch.dropped.HOST_CHANGED"], 1);
      assert.strictEqual(t.svc.stats().relaunchPending, 0);
      assert.strictEqual(t.w.calls.filter((call) => call[0] === "spawn").length, 0);
    } finally {
      cleanup(t.dir);
    }
  });

  test("FM-R3 (formations) jump: end JUMPED; the host cloaked in the new scene -> wait (waitCloak) "
    + "uncloaked -> spawn in the new scene; no conditions for formationRelaunchTimeoutMs -> timeout, intent gone", () => {
    const NEW_KEY = "system:30000144";
    const jump = (t, cloaked) => {
      const old = t.w.scene.entities.get(HOST);
      const scene = { key: NEW_KEY, entities: new Map([[HOST, { ...old, mode: "STOP", cloaked }]]) };
      t.w.scene = scene;
      t.adapter.isSceneLoaded = (key, s) => t.w.loaded && s === t.w.scene && key === t.w.scene.key;
      t.w.sessions.get(CHAR).space = { systemId: 30000144, sceneKey: NEW_KEY, shipId: HOST };
      return scene;
    };
    const t = setup({ formationReady: () => true, adapterExtra: formationAdapter });
    try {
      assert.strictEqual(t.svc.setFormation(CHAR, "column").ok, true);
      assert.strictEqual(t.svc.orderCopy(CHAR, 501, "launch", { commandId: "c" }).ok, true);
      assert.strictEqual(t.svc.orderCopy(CHAR, 502, "launch", { commandId: "c" }).ok, true);
      const scene = jump(t, true);
      t.w.calls.length = 0;
      t.clock.t += 2500;
      t.svc.tick(t.clock.t);
      const c = t.svc.stats().counters;
      assert.deepStrictEqual([c["end.JUMPED"], c["formation.relaunch.waitCloak"]], [2, 1]);
      assert.strictEqual(t.w.calls.filter((call) => call[0] === "spawn").length, 0, "no spawn beside a cloaked host");
      scene.entities.get(HOST).cloaked = false;
      t.clock.t += 500;
      t.svc.tick(t.clock.t);
      assert.strictEqual(t.w.calls.filter((call) => call[0] === "spawn").length, 2);
      for (const id of [501, 502]) {
        assert.deepStrictEqual([t.store.get(id).state, t.store.get(id).sceneKey], ["ACTIVE", NEW_KEY]);
        assert.ok(scene.entities.has(twinOf(t, id)), "the twin is in the new scene");
      }
    } finally {
      cleanup(t.dir);
    }
    const late = setup({ formationReady: () => true, adapterExtra: formationAdapter });
    try {
      assert.strictEqual(late.svc.setFormation(CHAR, "sphere").ok, true);
      assert.strictEqual(late.svc.orderCopy(CHAR, 501, "launch").ok, true);
      const scene = jump(late, true);
      late.clock.t += 2500;
      late.svc.tick(late.clock.t);
      assert.strictEqual(late.svc.stats().counters["formation.relaunch.waitCloak"], 1);
      late.clock.t += 119999;
      late.svc.tick(late.clock.t);
      assert.strictEqual(late.svc.stats().relaunchPending, 1, "just below the timeout");
      late.clock.t += 1;
      late.svc.tick(late.clock.t);
      assert.deepStrictEqual([late.svc.stats().counters["formation.relaunch.timeout"], late.svc.stats().relaunchPending],
        [1, 0]);
      scene.entities.get(HOST).cloaked = false;
      late.w.calls.length = 0;
      late.clock.t += 500;
      late.svc.tick(late.clock.t);
      assert.strictEqual(late.w.calls.filter((call) => call[0] === "spawn").length, 0, "the intent is gone");
    } finally {
      cleanup(late.dir);
    }
  });

  test("FM-R4 (formations) warp then dock (station in the session), dock in progress or "
    + "logoff: the intent dropped at once, no spawn at the undock / relog; a jump with a tick without space and "
    + "without a dock: end JUMPED, the intent waits, spawn in the new scene", () => {
    const NEW_KEY = "system:30000144";
    const SPACE = { systemId: SYSTEM, sceneKey: SCENE_KEY, shipId: HOST };
    const warped = (t) => {
      assert.strictEqual(t.svc.setFormation(CHAR, "wedge").ok, true);
      assert.strictEqual(t.svc.orderCopy(CHAR, 501, "launch", { commandId: "c" }).ok, true);
      assert.strictEqual(t.svc.orderCopy(CHAR, 502, "launch", { commandId: "c" }).ok, true);
      t.w.scene.entities.get(HOST).mode = "WARP";
      t.clock.t += 2500;
      t.svc.tick(t.clock.t);
      assert.strictEqual(t.svc.stats().relaunchPending, 1);
    };
    const spawns = (t) => t.w.calls.filter((call) => call[0] === "spawn").length;
    const cases = [
      ["DOCKED", (t) => Object.assign(t.w.sessions.get(CHAR), { space: null, stationid: 60003760 }),
        (t) => Object.assign(t.w.sessions.get(CHAR), { space: { ...SPACE }, stationid: null })],
      ["DOCKED", (t) => Object.assign(t.w.scene.entities.get(HOST), { mode: "STOP", pendingDock: true }),
        (t) => Object.assign(t.w.scene.entities.get(HOST), { pendingDock: false })],
      ["LOGOFF", (t) => t.w.sessions.delete(CHAR),
        (t) => t.w.sessions.set(CHAR, { charId: CHAR, space: { ...SPACE } })],
    ];
    for (const [reason, leave, back] of cases) {
      const t = setup({ formationReady: () => true, adapterExtra: formationAdapter });
      try {
        warped(t);
        leave(t);
        t.clock.t += 500;
        t.svc.tick(t.clock.t);
        assert.deepStrictEqual([t.svc.stats().counters[`formation.relaunch.dropped.${reason}`],
          t.svc.stats().relaunchPending], [1, 0], `${reason}: dropped at once`);
        back(t);
        t.w.scene.entities.get(HOST).mode = "STOP";
        t.w.calls.length = 0;
        t.clock.t += 500;
        t.svc.tick(t.clock.t);
        assert.strictEqual(spawns(t), 0, `${reason}: no twin at the undock / relog`);
      } finally {
        cleanup(t.dir);
      }
    }
    const t = setup({ formationReady: () => true, adapterExtra: formationAdapter });
    try {
      assert.strictEqual(t.svc.setFormation(CHAR, "line").ok, true);
      assert.strictEqual(t.svc.orderCopy(CHAR, 501, "launch", { commandId: "c" }).ok, true);
      assert.strictEqual(t.svc.orderCopy(CHAR, 502, "launch", { commandId: "c" }).ok, true);
      t.w.sessions.get(CHAR).space = null;
      t.w.calls.length = 0;
      t.clock.t += 2500;
      t.svc.tick(t.clock.t);
      const c = t.svc.stats().counters;
      assert.deepStrictEqual([c["end.JUMPED"], c["end.DOCKED"] || 0, c["formation.relaunch.wait"]], [2, 0, 1]);
      t.clock.t += 500;
      t.svc.tick(t.clock.t);
      assert.deepStrictEqual([t.svc.stats().relaunchPending, spawns(t)], [1, 0], "still waits, not dropped");
      const scene = { key: NEW_KEY, entities: new Map([[HOST, { ...t.w.scene.entities.get(HOST), mode: "STOP" }]]) };
      t.w.scene = scene;
      t.adapter.isSceneLoaded = (key, s) => t.w.loaded && s === t.w.scene && key === t.w.scene.key;
      t.w.sessions.get(CHAR).space = { systemId: 30000144, sceneKey: NEW_KEY, shipId: HOST };
      t.clock.t += 500;
      t.svc.tick(t.clock.t);
      assert.strictEqual(spawns(t), 2, "the twins come back in the new scene");
      assert.deepStrictEqual([t.store.get(501).sceneKey, t.store.get(502).sceneKey], [NEW_KEY, NEW_KEY]);
    } finally {
      cleanup(t.dir);
    }
  });

  function boardSetup(opts = {}) {
    const t = setup({ ...opts, config: { boardEnabled: true, ...(opts.config || {}) } });
    t.adapter.conditionOf = () => ({ damage: 0.25, charge: 1, armorDamage: 0.5, shieldCharge: 0 });
    t.adapter.writeCondition = (id) => {
      const rec = t.store.get(id);
      t.w.calls.push(["writeCondition", id, rec ? rec.state : null]);
      return { ok: true, changes: [] };
    };
    assert.strictEqual(t.svc.orderCopy(CHAR, 501, "launch", { commandId: "b" }).ok, true);
    assert.strictEqual(t.svc.orderCopy(CHAR, 502, "launch", { commandId: "b" }).ok, true);
    for (const id of [501, 502]) {
      Object.assign(t.w.scene.entities.get(twinOf(t, id)), { position: { x: 3000, y: 0, z: 0 },
        direction: { x: 0, y: 1, z: 0 }, radius: 40 });
      t.w.distance.set(twinOf(t, id), 2000);
    }
    t.w.calls.length = 0;
    return t;
  }

  test("WSV-B1 board happy path: releaseForBoard -> ok with the twin's spot; writeCondition -> remove(twin) -> "
    + "record gone, block free, end.BOARDED; a second board -> NOT_DEPLOYED", () => {
    const t = boardSetup();
    try {
      const twinId = twinOf(t, 501);
      assert.deepStrictEqual(t.svc.boardOwnerOf(twinId), { shipItemId: 501, ownerCharacterId: CHAR, state: "ACTIVE" });
      const out = t.svc.releaseForBoard(CHAR, twinId);
      assert.deepStrictEqual(out, { ok: true, shipItemId: 501, hostShipId: HOST, systemId: SYSTEM,
        twin: { position: { x: 3000, y: 0, z: 0 }, direction: { x: 0, y: 1, z: 0 }, radius: 40 },
        twinEntityId: twinId, droneIds: [] });
      assert.deepStrictEqual(t.w.calls.filter((c) => c[0] === "writeCondition" || c[0] === "remove"),
        [["writeCondition", 501, "ACTIVE"], ["remove", twinId, "ACTIVE"]], "write-back, then remove, then the record");
      assert.strictEqual(t.store.get(501), null);
      assert.strictEqual(t.svc.isBlocked(501), false);
      assert.strictEqual(t.svc.blockedCount(), 1, "only 502 still blocked");
      assert.strictEqual(t.svc.boardOwnerOf(twinId), null);
      const c = t.svc.stats().counters;
      assert.deepStrictEqual([c["end.BOARDED"], c["board.released"]], [1, 1]);
      assert.deepStrictEqual(t.svc.releaseForBoard(CHAR, twinId), { ok: false, reason: "NOT_DEPLOYED" });
      t.clock.t += 3000;
      assert.strictEqual(t.svc.releaseForBoard(CHAR, twinOf(t, 502)).ok, true);
      assert.strictEqual(t.svc.blockedCount(), 0);
    } finally {
      cleanup(t.dir);
    }
  });

  test("WSV-B2 board refusals: TOO_FAR (7000 m), NOT_OWNER, MISSING_SKILLS, COOLDOWN (< 3 s after a board), a LOST "
    + "twin (out of byTwin) -> NOT_DEPLOYED; record and twin untouched, board.refused.<reason> counted", () => {
    const t = boardSetup();
    try {
      const twin502 = twinOf(t, 502);
      const untouched = () => {
        assert.strictEqual(t.store.get(502).state, "ACTIVE");
        assert.ok(t.w.scene.entities.has(twin502));
        assert.strictEqual(t.w.calls.filter((c) => c[0] === "remove" && c[1] === twin502).length, 0);
      };
      t.w.distance.set(twin502, 7000);
      assert.deepStrictEqual(t.svc.releaseForBoard(CHAR, twin502), { ok: false, reason: "TOO_FAR" });
      untouched();
      t.w.distance.set(twin502, 2000);
      assert.deepStrictEqual(t.svc.releaseForBoard(OTHER, twin502), { ok: false, reason: "NOT_OWNER" });
      untouched();
      const skills = t.adapter.missingSkills;
      t.adapter.missingSkills = () => [3386];
      assert.deepStrictEqual(t.svc.releaseForBoard(CHAR, twin502), { ok: false, reason: "MISSING_SKILLS" });
      t.adapter.missingSkills = skills;
      untouched();
      assert.strictEqual(t.svc.releaseForBoard(CHAR, twinOf(t, 501)).ok, true);
      t.clock.t += 2999;
      assert.deepStrictEqual(t.svc.releaseForBoard(CHAR, twin502), { ok: false, reason: "COOLDOWN" });
      untouched();
      assert.strictEqual(t.svc.beginLoss(502, { cause: "DESTROYED" }).ok, true);
      assert.deepStrictEqual(t.svc.releaseForBoard(CHAR, twin502), { ok: false, reason: "NOT_DEPLOYED" });
      assert.strictEqual(t.svc.hasLossRecord(502), true, "the LOST record stays");
      const c = t.svc.stats().counters;
      assert.deepStrictEqual(["TOO_FAR", "NOT_OWNER", "MISSING_SKILLS", "COOLDOWN", "NOT_DEPLOYED"]
        .map((r) => c[`board.refused.${r}`]), [1, 1, 1, 1, 1]);
      assert.strictEqual(c["end.BOARDED"], 1);
    } finally {
      cleanup(t.dir);
    }
  });

  test("WSV-B5 (board-malformed-scope) hostCheck(host) = SCOPE_INVALID -> refused before the end: record "
    + "and twin untouched, board.refused.SCOPE_INVALID, no board.released; hostCheck null -> the board as before", () => {
    const t = boardSetup();
    try {
      const twin501 = twinOf(t, 501);
      const seen = [];
      const refuse = (host) => {
        seen.push(host && host.itemID);
        return "SCOPE_INVALID";
      };
      assert.deepStrictEqual(t.svc.releaseForBoard(CHAR, twin501, { hostCheck: refuse }),
        { ok: false, reason: "SCOPE_INVALID" });
      assert.deepStrictEqual(seen, [HOST], "asked with the host entity");
      assert.strictEqual(t.store.get(501).state, "ACTIVE");
      assert.ok(t.w.scene.entities.has(twin501));
      assert.strictEqual(t.w.calls.filter((c) => c[0] === "remove" || c[0] === "writeCondition").length, 0);
      let c = t.svc.stats().counters;
      assert.deepStrictEqual([c["board.refused.SCOPE_INVALID"], c["board.released"] || 0], [1, 0]);
      assert.strictEqual(t.svc.releaseForBoard(CHAR, twin501, { hostCheck: () => null }).ok, true);
      c = t.svc.stats().counters;
      assert.deepStrictEqual([c["board.released"], c["end.BOARDED"]], [1, 1]);
    } finally {
      cleanup(t.dir);
    }
  });

  test("WSV-B3 the remove of a board fails -> ENDING, the record stays; the next tick finishes "
    + "the end (end.BOARDED), a board meanwhile -> ENDING", () => {
    const t = boardSetup();
    try {
      const twinId = twinOf(t, 501);
      const remove = t.adapter.remove;
      t.adapter.remove = () => false;
      assert.deepStrictEqual(t.svc.releaseForBoard(CHAR, twinId), { ok: false, reason: "ENDING" });
      assert.strictEqual(t.store.get(501).state, "ACTIVE");
      t.clock.t += 5000;
      assert.deepStrictEqual(t.svc.releaseForBoard(CHAR, twinId), { ok: false, reason: "ENDING" });
      t.adapter.remove = remove;
      t.svc.tick(t.clock.t);
      assert.strictEqual(t.store.get(501), null);
      assert.strictEqual(t.w.scene.entities.has(twinId), false);
      const c = t.svc.stats().counters;
      assert.deepStrictEqual([c["end.BOARDED"], c["end.removeRetry"], c["board.released"]], [1, 1, 0]);
      assert.strictEqual(c["board.pendingEnd"], 1, "the end.BOARDED without a board is told apart");
      assert.strictEqual(t.store.get(502).state, "ACTIVE", "the other twin goes on");
    } finally {
      cleanup(t.dir);
    }
  });

  const CAPSULE = 1000000777;
  function eject(t, shipId = CAPSULE, hostRangeM = 300) {
    t.w.scene.entities.set(shipId, { itemID: shipId, position: { x: 100, y: 0, z: 0 }, direction: { x: 1, y: 0, z: 0 },
      radius: 20, mode: "STOP", pilotCharacterID: CHAR });
    t.w.scene.entities.get(HOST).pilotCharacterID = 0;
    t.w.sessions.get(CHAR).space = { ...t.w.sessions.get(CHAR).space, shipId };
    t.w.activeShip = shipId;
    t.w.distance.set(shipId, hostRangeM);
  }
  function orphanSetup() {
    const tasks = createWingTasks({ config: config(), clock: { now: () => 0 } });
    const t = boardSetup({ boardReady: () => true, tasks, config: { boardOrphanEnabled: true } });
    t.tasks = tasks;
    return t;
  }

  test("OR1 orphan window: off (flag or no board hook) -> Eject ends the twins HOST_CHANGED in the next tick; on -> "
    + "they stay ACTIVE, task HOLD, board.orphan.begin once per twin; after boardOrphanGraceMs -> HOST_CHANGED "
    + "(board.orphan.timeout)", () => {
    for (const variant of [{ config: { boardOrphanEnabled: false } },
      { config: { boardOrphanEnabled: true }, boardReady: () => false }]) {
      const t = boardSetup(variant);
      try {
        eject(t);
        t.svc.tick(t.clock.t);
        assert.deepStrictEqual([t.store.get(501), t.store.get(502)], [null, null]);
        const c = t.svc.stats().counters;
        assert.deepStrictEqual([c["end.HOST_CHANGED"], c["board.orphan.begin"]], [2, 0]);
      } finally {
        cleanup(t.dir);
      }
    }
    const t = orphanSetup();
    try {
      eject(t);
      t.svc.tick(t.clock.t);
      assert.deepStrictEqual([t.store.get(501).state, t.store.get(502).state], ["ACTIVE", "ACTIVE"]);
      assert.deepStrictEqual([t.tasks.view(501).task, t.tasks.view(502).task], ["HOLD", "HOLD"]);
      assert.ok(t.w.calls.some((c) => c[0] === "follow" && c[1] === twinOf(t, 501) && c[2] === HOST),
        "the twin keeps to the host");
      t.clock.t += 1000;
      t.svc.tick(t.clock.t);
      assert.strictEqual(t.svc.stats().counters["board.orphan.begin"], 2, "once per twin");
      t.clock.t += config().boardOrphanGraceMs;
      t.svc.tick(t.clock.t);
      assert.deepStrictEqual([t.store.get(501), t.store.get(502)], [null, null]);
      const c = t.svc.stats().counters;
      assert.deepStrictEqual([c["board.orphan.timeout"], c["end.HOST_CHANGED"]], [2, 2]);
    } finally {
      cleanup(t.dir);
    }
  });

  test("OR2 orphan window: the pilot back in the host (active = host, host pilot = owner) -> board.orphan.cleared, "
    + "the twins stay and follow the host; a second Eject opens the window again", () => {
    const t = orphanSetup();
    try {
      eject(t);
      t.svc.tick(t.clock.t);
      t.w.sessions.get(CHAR).space = { ...t.w.sessions.get(CHAR).space, shipId: HOST };
      t.w.activeShip = HOST;
      t.w.scene.entities.get(HOST).pilotCharacterID = CHAR;
      t.clock.t += 1000;
      t.svc.tick(t.clock.t);
      assert.deepStrictEqual([t.store.get(501).state, t.store.get(502).state], ["ACTIVE", "ACTIVE"]);
      assert.strictEqual(t.svc.stats().counters["board.orphan.cleared"], 2);
      t.clock.t += config().boardOrphanGraceMs;
      t.svc.tick(t.clock.t);
      assert.strictEqual(t.store.get(501).state, "ACTIVE");
      eject(t);
      t.svc.tick(t.clock.t);
      const c = t.svc.stats().counters;
      assert.deepStrictEqual([c["board.orphan.begin"], c["board.orphan.timeout"], c["end.HOST_CHANGED"]], [4, 0, 0]);
    } finally {
      cleanup(t.dir);
    }
  });

  test("OR5 orphan window: mine/attack (chat, mirror) -> HOST_EMPTY, no engine start, "
    + "the task stays HOLD; hold goes through; back in the host -> attack starts; recall in the window works", () => {
    const starts = [];
    const engine = (name) => ({ name, canRun: () => ({ ok: true }), start() { starts.push(name); }, step: () => ({}),
      stop() {} });
    const t = boardSetup({ boardReady: () => true, taskReady: () => true,
      taskEngines: { mine: engine("mine"), attack: engine("attack") },
      config: { boardOrphanEnabled: true, miningEnabled: true, combatEnabled: true } });
    const taskOf = (id) => t.svc.listWing(CHAR).ships.find((r) => r.shipItemId === id).task;
    try {
      eject(t);
      t.svc.tick(t.clock.t);
      assert.deepStrictEqual([taskOf(501), taskOf(502)], ["HOLD", "HOLD"]);
      starts.length = 0;
      assert.deepStrictEqual(t.svc.orderCopy(CHAR, 501, "attack", { targetId: 888 }), { ok: false, reason: "HOST_EMPTY" });
      assert.deepStrictEqual(t.svc.orderCopy(CHAR, 502, "mine", { targetId: 777 }), { ok: false, reason: "HOST_EMPTY" });
      assert.deepStrictEqual(t.svc.orderCopy(CHAR, 502, "attack", { targetId: 888, source: "mirror" }),
        { ok: false, reason: "HOST_EMPTY" });
      assert.deepStrictEqual(starts, [], "no refused order reaches an engine");
      assert.deepStrictEqual([taskOf(501), taskOf(502)], ["HOLD", "HOLD"]);
      assert.strictEqual(t.svc.orderCopy(CHAR, 501, "hold").ok, true);
      assert.strictEqual(t.svc.stats().counters["orderCopy.refused.HOST_EMPTY"], 3);
      t.w.sessions.get(CHAR).space = { ...t.w.sessions.get(CHAR).space, shipId: HOST };
      t.w.activeShip = HOST;
      t.w.scene.entities.get(HOST).pilotCharacterID = CHAR;
      t.clock.t += 1000;
      t.svc.tick(t.clock.t);
      assert.strictEqual(t.svc.orderCopy(CHAR, 501, "attack", { targetId: 888 }).ok, true);
      assert.deepStrictEqual([starts, taskOf(501)], [["attack"], "ATTACK"]);
      eject(t);
      t.clock.t += 1000;
      t.svc.tick(t.clock.t);
      assert.strictEqual(t.svc.orderCopy(CHAR, 502, "return").ok, true, "recall stays in the window");
      assert.strictEqual(t.store.get(502).state, "RETURNING");
    } finally {
      cleanup(t.dir);
    }
  });

  test("OR3 board from the capsule: capsule <-> host > boardHostRangeMeters -> HOST_TOO_FAR (twin untouched, text of "
    + "the hook); in range -> boarded; then copy -> copy from the boarded ship (A <-> host 300 m)", () => {
    const t = orphanSetup();
    try {
      eject(t, CAPSULE, 5001);
      t.svc.tick(t.clock.t);
      const twin501 = twinOf(t, 501);
      assert.deepStrictEqual(t.svc.releaseForBoard(CHAR, twin501), { ok: false, reason: "HOST_TOO_FAR" });
      assert.strictEqual(t.store.get(501).state, "ACTIVE");
      assert.ok(t.w.scene.entities.has(twin501));
      assert.strictEqual(refusalTextBoard("HOST_TOO_FAR", config()),
        "Move within 5000 m of the ship that launched the copy.");
      t.w.distance.set(CAPSULE, 3000);
      assert.strictEqual(t.svc.releaseForBoard(CHAR, twin501).ok, true);
      eject(t, 501);
      t.w.scene.entities.delete(CAPSULE);
      t.clock.t += 3000;
      t.svc.tick(t.clock.t);
      assert.strictEqual(t.store.get(502).state, "ACTIVE", "the other twin stays in the window");
      assert.strictEqual(t.svc.releaseForBoard(CHAR, twinOf(t, 502)).ok, true);
      const c = t.svc.stats().counters;
      assert.deepStrictEqual([c["end.BOARDED"], c["board.refused.HOST_TOO_FAR"], c["end.HOST_CHANGED"]], [2, 1, 0]);
    } finally {
      cleanup(t.dir);
    }
  });

  test("OR4 orphan window ends (table): host gone -> HOST_GONE, host taken by another pilot -> HOST_CHANGED, the "
    + "ACTIVE ship warps / docks -> WARP / DOCKED, logoff, jump; a board in that state -> the refusal", () => {
    const capsule = (w) => w.scene.entities.get(CAPSULE);
    const cases = [
      ["HOST_GONE", "HOST_GONE", (w) => { w.scene.entities.delete(HOST); }],
      ["HOST_CHANGED", "HOST_CHANGED", (w) => { w.scene.entities.get(HOST).pilotCharacterID = OTHER; }],
      ["WARP", "OWNER_WARPING", (w) => { capsule(w).mode = "WARP"; }],
      ["DOCKED", "OWNER_WARPING", (w) => { capsule(w).pendingDock = true; }],
      ["LOGOFF", "NOT_IN_SPACE", (w) => { w.sessions.delete(CHAR); }],
      ["JUMPED", "SCENE_NOT_LOADED", (w) => {
        w.sessions.get(CHAR).space = { ...w.sessions.get(CHAR).space, sceneKey: "system:30000144" };
      }],
    ];
    for (const [end, refused, change] of cases) {
      const t = orphanSetup();
      try {
        eject(t);
        t.svc.tick(t.clock.t);
        change(t.w);
        assert.deepStrictEqual(t.svc.releaseForBoard(CHAR, twinOf(t, 501)), { ok: false, reason: refused }, end);
        t.svc.tick(t.clock.t + 1000);
        assert.deepStrictEqual([t.store.get(501), t.store.get(502)], [null, null], end);
        assert.strictEqual(t.svc.stats().counters[`end.${end}`], 2, end);
      } finally {
        cleanup(t.dir);
      }
    }
  });

  test("WSV-CG1 cargo: flag off -> no cargoOn, DISABLED; on: cargoOf "
    + "and moveCargo with the pilot's ship, at most cargoMoveMaxItems stacks (skipped), COOLDOWN per pilot, the LOST "
    + "lock of the core; setCargoStore refuses a ship whose copy flies and cargoStoreOf drops a hauler launched later",
  () => {
    const calls = [];
    const cargo = {
      listBayCargo: (owner, host) => {
        calls.push(["list", owner, host]);
        return { ok: true, hostShipId: host, ships: [], truncated: 0 };
      },
      moveCargo: (o) => {
        calls.push(["move", o.ownerCharacterId, o.hostShipId, o.itemId, o.toLocationId, o.isLocked(o.itemId)]);
        return o.itemId === 9 ? { ok: false, reason: "NO_ROOM" }
          : { ok: true, itemId: o.itemId, typeId: 1230, name: "Veldspar", movedQty: 10, movedM3: 100, leftQty: 0 };
      },
    };
    const off = setup({ cargo });
    try {
      assert.strictEqual(off.svc.cargoOn, false);
      assert.deepStrictEqual(off.svc.cargoOf(CHAR), { ok: false, reason: "DISABLED" });
    } finally {
      cleanup(off.dir);
    }
    const t = setup({ cargo, config: { cargoPanelEnabled: true, cargoMoveMaxItems: 2, cargoMoveMinIntervalMs: 1000,
      miningRealCargoEnabled: true } });
    try {
      assert.strictEqual(t.svc.cargoOn, true);
      assert.strictEqual(t.svc.cargoOf(CHAR).ok, true);
      const items = [{ itemId: 7 }, { itemId: 9 }, { itemId: 8 }];
      const out = t.svc.moveCargo(CHAR, { items, toShipItemId: 501 });
      assert.deepStrictEqual([out.ok, out.movedQty, out.skipped, out.results.map((r) => [r.itemId, r.reason])],
        [true, 10, 1, [[7, null], [9, "NO_ROOM"]]]);
      assert.deepStrictEqual(calls, [["list", CHAR, HOST], ["move", CHAR, HOST, 7, 501, false],
        ["move", CHAR, HOST, 9, 501, false]]);
      assert.strictEqual(t.svc.moveCargo(CHAR, { items, toShipItemId: 501 }).reason, "COOLDOWN");
      t.clock.t += 1000;
      assert.strictEqual(t.svc.moveCargo(CHAR, { items: [{ itemId: 9 }], toShipItemId: 501 }).reason, "NO_ROOM");
      assert.deepStrictEqual([t.svc.stats().counters["cargo.moved"], t.svc.stats().counters["cargo.refused"]], [1, 3]);
      t.w.sessions.get(CHAR).space = null;
      assert.deepStrictEqual(t.svc.cargoOf(CHAR), { ok: false, reason: "NOT_IN_SPACE" });
      t.w.sessions.get(CHAR).space = { systemId: SYSTEM, sceneKey: SCENE_KEY, shipId: HOST };

      assert.strictEqual(t.svc.setCargoStore(CHAR, 502).ok, true);
      assert.strictEqual(t.svc.orderCopy(CHAR, 501, "launch", { commandId: "c" }).ok, true);
      assert.deepStrictEqual(t.svc.setCargoStore(CHAR, 501), { ok: false, reason: "ALREADY_DEPLOYED" });
      assert.strictEqual(t.svc.cargoStoreOf(HOST), 502);
      assert.strictEqual(t.svc.orderCopy(CHAR, 502, "launch", { commandId: "c" }).ok, true);
      assert.strictEqual(t.svc.cargoStoreOf(HOST), 0, "a hauler launched later is no hauler while it flies");
    } finally {
      cleanup(t.dir);
    }
  });

  test("WSV-D1 docked: listWing lists the active ship's bay read-only (IN_BAY, not eligible, NOT_IN_SPACE), "
    + "no host ship in the view, nothing spawned", () => {
    const t = setup();
    try {
      t.w.sessions.set(CHAR, { charId: CHAR, space: null, stationid: 60003979 });
      t.w.activeShip = HOST;
      const view = t.svc.listWing(CHAR);
      assert.strictEqual(view.refusal, "NOT_IN_SPACE");
      assert.strictEqual(view.hostShipId, null);
      assert.deepStrictEqual(view.ships.map((s) => [s.shipItemId, s.state, s.eligible, s.refusal]),
        [501, 502, 503, 504, 505, 506].map((id) => [id, "IN_BAY", false, id === 504 ? "NOT_OWNER" : "NOT_IN_SPACE"]));
      assert.strictEqual(t.w.calls.filter((c) => c[0] === "spawn").length, 0);
      assert.deepStrictEqual(t.changes, []);
    } finally {
      cleanup(t.dir);
    }
  });

  test("WSV-D2 docked: launch and cargo are still refused NOT_IN_SPACE", () => {
    const cargo = {
      listBayCargo: (_owner, host) => ({ ok: true, hostShipId: host, ships: [], truncated: 0 }),
      moveCargo: () => ({ ok: false, reason: "TEST" }),
    };
    const t = setup({ cargo, config: { cargoPanelEnabled: true, miningRealCargoEnabled: true } });
    try {
      t.w.sessions.set(CHAR, { charId: CHAR, space: null, stationid: 60003979 });
      assert.deepStrictEqual(t.svc.orderCopy(CHAR, 501, "launch"), { ok: false, reason: "NOT_IN_SPACE" });
      assert.deepStrictEqual(t.svc.cargoOf(CHAR), { ok: false, reason: "NOT_IN_SPACE" });
      assert.strictEqual(t.w.calls.filter((c) => c[0] === "spawn").length, 0);
      assert.strictEqual(t.store.get(501), null);
    } finally {
      cleanup(t.dir);
    }
  });

  test("WSV-D3 between scenes (no space, no dock): listWing lists no bay, refusal NOT_IN_SPACE", () => {
    const t = setup();
    try {
      t.w.sessions.set(CHAR, { charId: CHAR, space: null });
      const view = t.svc.listWing(CHAR);
      assert.deepStrictEqual([view.refusal, view.hostShipId, view.ships], ["NOT_IN_SPACE", null, []]);
      t.w.sessions.set(CHAR, { charId: CHAR, space: null, stationid: 60003979 });
      t.w.activeShip = 0;
      assert.deepStrictEqual(t.svc.listWing(CHAR).ships, [], "no known active ship lists no bay");
    } finally {
      cleanup(t.dir);
    }
  });

  test("WSV-D4 another owner's ship in the bay shows NOT_OWNER both docked and in space", () => {
    const t = setup();
    try {
      const reasonOf = (view) => view.ships.find((s) => s.shipItemId === 504).refusal;
      assert.strictEqual(reasonOf(t.svc.listWing(CHAR)), "NOT_OWNER");
      t.w.sessions.set(CHAR, { charId: CHAR, space: null, stationid: 60003979 });
      t.w.activeShip = HOST;
      const docked = t.svc.listWing(CHAR);
      assert.strictEqual(reasonOf(docked), "NOT_OWNER");
      assert.strictEqual(docked.ships.find((s) => s.shipItemId === 501).refusal, "NOT_IN_SPACE");
    } finally {
      cleanup(t.dir);
    }
  });
};

function formationAdapter(w) {
  return {
    motionOf: (e) => {
      const position = e.position || (e.spec && e.spec.position);
      if (!position) return null;
      return { position, velocity: e.velocity || { x: 0, y: 0, z: 0 }, direction: e.direction || { x: 0, y: 0, z: 0 },
        radius: 0 };
    },
    gotoPoint: (_scene, entity, point) => {
      w.calls.push(["gotoPoint", entity.itemID, point]);
      entity.mode = "GOTO";
      return true;
    },
  };
}

module.exports.fixtures = { setup, cleanup, twinOf, CHAR, OTHER, HOST, SYSTEM };
