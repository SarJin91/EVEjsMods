"use strict";

const assert = require("node:assert");
const { createWingAdapterCore, createLiveAdapter, registerShutdown, characterIdOf, LIVE_MODULES, slimModuleTuples,
  pinSlimModules } = require("../../lib/adapter/vendor");

const SCENE_KEY = "system:30000142";

function fakeGame() {
  const calls = [];
  const scene = {
    sceneKey: SCENE_KEY, sceneDescriptor: { sceneKey: SCENE_KEY, locationID: 30000142 },
    entities: new Map([[1000000400, { itemID: 1000000400, mode: "WARP", pendingDock: null }]]),
    getEntityByID(id) {
      return this.entities.get(id) || null;
    },
    getCurrentSimTimeMs: () => 777,
    followShipEntity(entity, targetId, range, options) {
      calls.push(["follow", entity.itemID, targetId, range, options]);
      return true;
    },
    removeDynamicEntity(id, options) {
      calls.push(["remove", id, options]);
      if (this.keep) return { success: false, errorMsg: "TEST" };
      return { success: this.entities.delete(id) };
    },
    getEntitySurfaceDistance: () => Infinity,
  };
  const runtime = {
    scenes: new Map([[SCENE_KEY, scene]]),
    getSceneForSession: (s) => (s && s._space ? scene : null),
    ensureScene: () => assert.fail("ensureScene must not be reached"),
    spawnDynamicShip(systemId, spec, options) {
      calls.push(["spawn", systemId, spec, options]);
      if (options.sceneDescriptor !== scene.sceneDescriptor) this.ensureScene();
      const entity = { itemID: spec.itemID };
      scene.entities.set(spec.itemID, entity);
      return { success: true, data: { entity } };
    },
  };
  const game = {
    runtime,
    identity: { allocateRuntimeEntityID: (preferred) => (preferred === undefined ? 4200000000000001 : -1) },
    itemStore: { ITEM_FLAGS: { SHIP_HANGAR: 90 }, listContainerItems: (o, l, f) => [{ o, l, f }] },
    fitting: { listFittedItemsForLocation: (id) => [{ id }], isFittedChargeItem: (i) => i.categoryID === 8,
      getMissingRequiredSkills: () => [] },
    skills: { getCachedCharacterSkillMap: () => new Map() },
    types: { resolveItemByTypeID: (t) => (t === 22544 ? { name: "Hulk" } : null) },
    sessions: { findSessionByCharacterID: (c) => (c === 90000001 ? { characterID: c } : null) },
  };
  return { calls, scene, runtime, game };
}

module.exports = ({ test }) => {
  test("V1 spawn only into the loaded scene, options = {sceneDescriptor} (no persistSpaceState, no session); "
    + "follow/remove go to the scene; readers map the vendor shapes", () => {
    const { calls, scene, runtime, game } = fakeGame();
    const a = createWingAdapterCore(game);
    const spec = { itemID: 4200000000000001, pilotCharacterID: 90000001, transient: true };
    const stale = { ...scene, sceneKey: SCENE_KEY };
    assert.deepStrictEqual(a.spawn(stale, 30000142, spec), { ok: false, reason: "SCENE_NOT_LOADED" });
    runtime.scenes.delete(SCENE_KEY);
    assert.deepStrictEqual(a.spawn(scene, 30000142, spec), { ok: false, reason: "SCENE_NOT_LOADED" });
    assert.strictEqual(calls.length, 0, "spawnDynamicShip never called for a scene that is not loaded");
    runtime.scenes.set(SCENE_KEY, scene);
    const spawned = a.spawn(scene, 30000142, spec);
    assert.strictEqual(spawned.ok, true);
    assert.deepStrictEqual(calls[0][3], { sceneDescriptor: scene.sceneDescriptor });
    assert.ok(!("persistSpaceState" in calls[0][2]) && !("persistSpaceState" in calls[0][3]));
    assert.strictEqual(a.follow(scene, spawned.entity, 1000000400, 1500), true);
    assert.deepStrictEqual(calls[1].slice(0, 4), ["follow", spec.itemID, 1000000400, 1500]);
    scene.keep = true;
    assert.strictEqual(a.remove(scene, spec.itemID, 1), false, "still in the scene -> false");
    scene.keep = false;
    assert.strictEqual(a.remove(scene, spec.itemID, 1), true);
    assert.deepStrictEqual(calls[3], ["remove", spec.itemID, { nowMs: 777 }], "scene time, not the mod clock");
    assert.strictEqual(a.remove(scene, spec.itemID, 1), true, "already gone");
    assert.strictEqual(calls.length, 4, "no remove call for a missing entity");

    assert.strictEqual(a.isSceneLoaded(SCENE_KEY, scene), true);
    assert.strictEqual(a.isSceneLoaded(SCENE_KEY, stale), false);
    const session = { characterID: 90000001, corporationID: 98000001,
      _space: { systemID: 30000142, sceneKey: SCENE_KEY, shipID: 1000000400 } };
    assert.deepStrictEqual(a.spaceOf(session), { systemId: 30000142, sceneKey: SCENE_KEY, shipId: 1000000400 });
    assert.strictEqual(a.spaceOf({ characterID: 1 }), null, "docked");
    assert.deepStrictEqual([a.dockedAt(session), a.dockedAt({ stationid: null, stationID: 60003760 }),
      a.dockedAt({ structureid: 1035466617946, stationid: 60003760 }), a.dockedAt({ stationid: "x" }), a.dockedAt(null)],
    [0, 60003760, 1035466617946, 0, 0]);
    assert.strictEqual(a.sceneOf(session), scene);
    assert.deepStrictEqual(a.hostStatus(scene, a.hostEntity(scene, 1000000400)),
      { warping: true, docking: false, pilotId: null, cloaked: false }, "no pilot fields = unknown");
    assert.deepStrictEqual(a.listBayShips(1000000400), [{ o: null, l: 1000000400, f: 90 }]);
    assert.deepStrictEqual(a.ownerIdentity(session),
      { characterId: 90000001, corporationId: 98000001, allianceId: 0, warFactionId: 0 });
    assert.strictEqual(a.allocId(), 4200000000000001, "allocateRuntimeEntityID() without an argument");
    assert.strictEqual(a.typeName(22544), "Hulk");
    assert.strictEqual(a.surfaceDistance(scene, {}, {}), Infinity);
    assert.strictEqual(a.findSession(90000001).characterID, 90000001);
    assert.strictEqual(characterIdOf({ charid: "90000002" }), 90000002);
    assert.strictEqual(characterIdOf(null), 0);
  });

  test("V3: spawn pins the twin's slim modules to its own fit (the vendor's reassignment is ignored, every read "
    + "a copy, charges and bad rows out, flag then ID order) and sends one OnSlimItemChange of the twin; no "
    + "broadcastSlimItemChanges / empty fit = launch still ok.: hostStatus.pilotId, activeShipId", () => {
    const { scene, game } = fakeGame();
    const slim = [];
    scene.broadcastSlimItemChanges = (entities) => {
      slim.push(entities.map((e) => [e.itemID, e.modules]));
      return entities.length;
    };
    const a = createWingAdapterCore(game);
    const fittedItems = [{ itemID: 4200000000000003, typeID: 17482, flagID: 28 },
      { itemID: 4200000000000002, typeID: 17482, flagID: 27 }, { itemID: 0, typeID: 1, flagID: 29 }, null];
    const spawned = a.spawn(scene, 30000142, { itemID: 4200000000000001, pilotCharacterID: 90000001, fittedItems });
    assert.strictEqual(spawned.ok, true);
    assert.strictEqual(spawned.modulesShown, true);
    const tuples = [[4200000000000002, 17482, 27], [4200000000000003, 17482, 28]];
    assert.deepStrictEqual(slim, [[[4200000000000001, tuples]]], "one OnSlimItemChange with the twin's turrets");
    spawned.entity.modules = [];
    assert.deepStrictEqual(spawned.entity.modules, tuples);
    spawned.entity.modules.pop();
    assert.deepStrictEqual(spawned.entity.modules, tuples, "a read is a copy");
    assert.ok(Object.keys(spawned.entity).includes("modules"), "enumerable like the vendor field");
    assert.deepStrictEqual(slimModuleTuples([{ itemID: 5, typeID: 6, flagID: 0 }]), []);
    delete scene.broadcastSlimItemChanges;
    const bare = a.spawn(scene, 30000142, { itemID: 4200000000000009, pilotCharacterID: 90000001, fittedItems });
    assert.deepStrictEqual([bare.ok, bare.modulesShown, bare.entity.modules], [true, false, tuples]);
    const empty = a.spawn(scene, 30000142, { itemID: 4200000000000010, pilotCharacterID: 90000001, fittedItems: [] });
    assert.deepStrictEqual([empty.ok, empty.modulesShown, empty.entity.modules], [true, false, undefined]);

    assert.strictEqual(a.hostStatus(scene, { pilotCharacterID: 0, characterID: 0 }).pilotId, 0, "pilot left");
    assert.strictEqual(a.hostStatus(scene, { pilotCharacterID: 90000001 }).pilotId, 90000001);
    assert.deepStrictEqual([{ cloakMode: 1 }, { cloaked: true }, { isCloaked: "2" }, { isCloaked: 0, cloakMode: 1 },
      { cloaked: "x" }, {}].map((e) => a.hostStatus(scene, e).cloaked), [true, true, true, false, false, false]);
    assert.strictEqual(a.activeShipId(90000001), 0, "no loss modules = unknown");
    const withLoss = createWingAdapterCore({ ...game, loss: { characterState: { getActiveShipRecord: (c) =>
      (c === 90000001 ? { itemID: 1000000400 } : null) } } });
    assert.deepStrictEqual([withLoss.activeShipId(90000001), withLoss.activeShipId(5)], [1000000400, 0]);
    assert.strictEqual(pinSlimModules(Object.defineProperty({}, "modules", { value: [], configurable: false }),
      fittedItems), 0, "a non-configurable field stays");
  });

  test("V2 createLiveAdapter needs the spawn probe and every module; registerShutdown on gameStore", () => {
    const { game } = fakeGame();
    assert.deepStrictEqual(createLiveAdapter({ isConsumerAvailable: () => false }),
      { ok: false, reason: "probe_spawn_unavailable" });
    const byPath = Object.fromEntries(Object.entries(LIVE_MODULES).map(([key, rel]) => [rel, game[key]]));
    const adapter = { isConsumerAvailable: (c) => c === "spawn",
      requireGame: (rel) => (byPath[rel] ? { ok: true, exports: byPath[rel] } : { ok: false, reason: "x" }) };
    const live = createLiveAdapter(adapter);
    assert.strictEqual(live.ok, true);
    assert.strictEqual(typeof live.adapter.spawn, "function");
    delete byPath["services/skills/skillState"];
    assert.strictEqual(createLiveAdapter(adapter).reason, "require_failed:services/skills/skillState:x");

    const hooks = new Map();
    const gameStore = { registerShutdownHook(name, fn) {
      if (hooks.has(name)) throw new Error(`shutdown hook already registered: ${name}`);
      hooks.set(name, fn);
      return () => hooks.delete(name);
    } };
    const first = registerShutdown(gameStore, "shipWing", () => "stopped");
    assert.strictEqual(first.ok, true);
    assert.strictEqual(hooks.get("shipWing")(), "stopped");
    assert.strictEqual(registerShutdown(gameStore, "shipWing", () => {}).reason, "SHUTDOWN_HOOK_REJECTED");
    assert.deepStrictEqual(registerShutdown({}, "shipWing", () => {}),
      { ok: false, reason: "SHUTDOWN_HOOK_UNAVAILABLE" });
  });

  test("V4 board pursuit: boardVendorRefusal asks getShipChangePursuitError(scene, current ship, \"board\") and maps "
    + "CONCORD / faction police to CONCORD_PURSUIT / FACTION_POLICE_PURSUIT; without the export (optional DRIFT) "
    + "the board consumer stays on and the check is inert; a throwing check is inert", () => {
    const { game, scene } = fakeGame();
    const SHIP = 1000000400;
    const pursuitCalls = [];
    let verdict = null;
    const pursuitModule = { getShipChangePursuitError(s, ship, operation) {
      pursuitCalls.push([s, ship && ship.itemID, operation]);
      if (verdict === "throw") throw new Error("pursuit read failed");
      return verdict;
    } };
    const byPath = Object.fromEntries(Object.entries(LIVE_MODULES).map(([key, rel]) => [rel, game[key]]));
    Object.assign(byPath, {
      "services/ship/shipService": { _testing: { getActiveAbyssalShipSwapRestriction: () => null } },
      "services/ship/ejectRuntime": { launchShipFromMaintenanceContainer: () => ({ success: true }) },
      "services/ship/breacherPodDeathRuntime": { isShipDeathPending: () => false },
      "space/runtime/combatDestruction": { isRuntimeEntityDestroyingOrDestroyed: () => false },
      "services/security/shipPursuit": pursuitModule,
    });
    const adapter = { isConsumerAvailable: (c) => c === "spawn" || c === "board",
      requireGame: (rel) => (byPath[rel] ? { ok: true, exports: byPath[rel] } : { ok: false, reason: "x" }) };
    const session = { characterID: 90000001, _space: { shipID: SHIP } };

    const live = createLiveAdapter(adapter);
    assert.strictEqual(live.boardReason, null);
    const refusal = live.adapter.boardVendorRefusal;
    assert.strictEqual(refusal(session), null);
    assert.deepStrictEqual(pursuitCalls, [[scene, SHIP, "board"]]);
    verdict = { success: false, errorMsg: "CONCORD_PURSUIT_ACTIVE" };
    assert.strictEqual(refusal(session), "CONCORD_PURSUIT");
    verdict = { success: false, errorMsg: "FACTION_POLICE_PURSUIT_ACTIVE" };
    assert.strictEqual(refusal(session), "FACTION_POLICE_PURSUIT");
    verdict = { success: false, errorMsg: "SOMETHING_NEW" };
    assert.strictEqual(refusal(session), null);
    verdict = "throw";
    assert.strictEqual(refusal(session), null);
    verdict = { success: false, errorMsg: "CONCORD_PURSUIT_ACTIVE" };
    assert.strictEqual(refusal({ characterID: 90000001 }), null, "no scene -> no check");

    delete byPath["services/security/shipPursuit"];
    const drift = createLiveAdapter(adapter);
    assert.strictEqual(drift.boardReason, null, "board stays on without the pursuit export");
    pursuitCalls.length = 0;
    assert.strictEqual(drift.adapter.boardVendorRefusal(session), null);
    assert.deepStrictEqual(pursuitCalls, []);

    const { GAME_MODULES } = require("../../lib/adapter/gameModules");
    const { probeModules } = require("../../lib/adapter/index");
    const rows = GAME_MODULES.filter((m) => m.path === "services/security/shipPursuit");
    assert.strictEqual(rows.length, 1);
    const probe = probeModules(rows, () => ({ ok: true, exports: {} }));
    assert.strictEqual(probe.modules[0].status, "DRIFT");
    assert.deepStrictEqual(probe.modules[0].affects, ["board (optional)"]);
    assert.deepStrictEqual(probe.disabled, {}, "a missing pursuit export does not disable board");
  });
};
