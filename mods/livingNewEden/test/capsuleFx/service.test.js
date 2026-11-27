"use strict";

const assert = require("node:assert");

const { createCapsuleFxScene } = require("../../lib/adapter/capsuleFx");
const { startCapsuleFx, createUnavailableCapsuleFx } = require("../../lib/capsuleFx");

const SYS = 30000142;
const SCENE_KEY = `solar-system:${SYS}`;
const AU = 149597870700;

const SETTINGS = Object.freeze({ enabled: true, civilianEnabled: false, ratsEnabled: true, missionRatsEnabled: false,
  lneFleetsEnabled: false, warpDelayMs: 2500, despawnAfterWarpMs: 4000, maxLifetimeMs: 20000, warpDistanceAu: 3,
  spawnOffsetMeters: 300, viewMeters: 300000, maxPerSystem: 6, maxGlobal: 48, maxPending: 64, pendingMaxAgeMs: 3000,
  maxSpawnsPerPass: 8, maxActionsPerPass: 32, pollMs: 250, untargetable: true,
  excludedFactionIds: "500021,500024,500025" });

function makeVendor(opts = {}) {
  const calls = { spawn: [], warp: [], remove: [] };
  let nextId = 3000000000;
  const scene = {
    systemID: SYS, sceneDescriptor: { sceneKey: SCENE_KEY, solarSystemID: SYS }, sessions: new Map(),
    entities: new Map(),
    warpResult: { success: true, queued: true },
    getEntityByID(id) { return this.entities.get(id) || null; },
    getShipEntityForSession(s) { return s.ship || null; },
    removeDynamicEntity(id, options) {
      calls.remove.push([id, options]);
      this.entities.delete(id);
      return { success: true };
    },
    warpDynamicEntityToPoint(entity, point, options) {
      calls.warp.push([entity.itemID, point, options]);
      return this.warpResult;
    },
  };
  const runtime = {
    scenes: new Map([[SCENE_KEY, scene]]),
    getSceneByDescriptor(d) { return this.scenes.get(d.sceneKey) || null; },
    spawnDynamicShip(systemID, spec, options) {
      calls.spawn.push([systemID, spec, options]);
      const entity = { ...spec, kind: "ship", ...options.entityScopeMetadata };
      if (opts.drift === true) entity.npcEntityType = "npc";
      scene.entities.set(entity.itemID, entity);
      return { success: true, data: { entity } };
    },
  };
  const modules = {
    "space/runtime": runtime,
    "space/npc/nativeNpcStore": { allocateEntityID: (o) => ({ success: o && o.transient === true, data: nextId++ }) },
    "space/destiny/identity/interactionScope": {
      buildChildEntityScopeMetadata: (v) => ({ dungeonSiteInstanceID: v.dungeonSiteInstanceID }),
      canEntitiesInteractLocally: () => true,
    },
    "space/FireShow/showIdentity": { isFireShowShip: (e) => Boolean(e && e.kind === "ship" && e.nativeNpc === true
      && e.transient === true && e.npcEntityType === "fireShow") },
  };
  const requireGame = (rel) => (modules[rel] ? { ok: true, exports: modules[rel] } : { ok: false, reason: "missing" });
  return { scene, runtime, calls, seam: createCapsuleFxScene({ requireGame }) };
}

function rig(opts = {}) {
  const vendor = makeVendor(opts);
  let listener = null;
  let removed = 0;
  let now = 1000;
  const lines = [];
  const adapter = {
    getCapsuleFxScene: () => ({ ok: true, seam: vendor.seam }),
    addNpcWreckListener: (fn) => {
      listener = fn;
      return { ok: true, remove: () => { removed += 1; return true; } };
    },
  };
  const started = startCapsuleFx({ config: { capsuleFx: { ...SETTINGS, ...(opts.settings || {}) } },
    adapter, nowMs: () => now, setTimer: () => ({ cancel() {} }), logger: { log: (l) => lines.push(l) } });
  assert.strictEqual(started.ok, true, JSON.stringify(started));
  const player = (x) => vendor.scene.sessions.set(`s${x}`, { ship: { position: { x, y: 0, z: 0 } } });
  const wreckOf = (wreckId, extra = {}) => listener({ wreckId, source: "rats", systemId: SYS, sceneKey: SCENE_KEY,
    sceneDescriptor: { sceneKey: SCENE_KEY, solarSystemID: SYS }, position: { x: 0, y: 0, z: 0 }, radius: 40,
    ownerId: 1000125, corporationId: 1000125, allianceId: null, factionId: 500010,
    victim: { itemID: 41000000 + wreckId, dungeonSiteInstanceID: 77 }, ...extra });
  return { vendor, fx: started.capsuleFx, wreckOf, player, lines, at: (t) => { now = t; },
    removedListeners: () => removed };
}

module.exports = ({ test }) => {
  test("CFS1 spawn, warp, remove: show identity, untargetable, inherited scope, warp then despawn", () => {
    const r = rig();
    r.player(100000);
    r.wreckOf(1);
    r.fx.runPass();
    assert.strictEqual(r.vendor.calls.spawn.length, 1);
    const [systemId, spec, options] = r.vendor.calls.spawn[0];
    assert.strictEqual(systemId, SYS);
    assert.deepStrictEqual([spec.typeID, spec.groupID, spec.nativeNpc, spec.transient, spec.npcEntityType,
      spec.ownerID, spec.pilotCharacterID, spec.characterID], [670, 29, true, true, "fireShow", 1000125, undefined,
      undefined]);
    assert.deepStrictEqual(options, { sceneDescriptor: r.vendor.scene.sceneDescriptor,
      entityScopeMetadata: { dungeonSiteInstanceID: 77 }, broadcast: false, persistSpaceState: false });
    const entity = r.vendor.scene.entities.get(spec.itemID);
    assert.deepStrictEqual([entity.airMiningTargetable, entity.lneCapsuleFx, entity.dungeonSiteInstanceID],
      [false, true, 77]);
    r.at(3499);
    r.fx.runPass();
    assert.strictEqual(r.vendor.calls.warp.length, 0);
    r.at(3500);
    r.fx.runPass();
    assert.strictEqual(r.vendor.calls.warp.length, 1);
    const [, point, warpOptions] = r.vendor.calls.warp[0];
    assert.deepStrictEqual(warpOptions, { ignoreWarpDisruptionField: true });
    const au = Math.hypot(point.x - spec.position.x, point.y - spec.position.y, point.z - spec.position.z) / AU;
    assert.ok(Math.abs(au - 3) < 1e-9, `${au} AU`);
    r.at(7499);
    r.fx.runPass();
    assert.strictEqual(r.vendor.calls.remove.length, 0);
    r.at(7500);
    r.fx.runPass();
    assert.deepStrictEqual(r.vendor.calls.remove, [[spec.itemID, { allowSessionOwned: false,
      persistSpaceState: false }]]);
    const st = r.fx.getStatus();
    assert.deepStrictEqual([st.active, st.counters.spawned, st.counters.warped, st.counters.removed,
      st.counters.removedLifetime], [0, 1, 1, 1, 0]);
    r.fx.stop();
  });

  test("CFS2 spawn, warp, remove: no player in view, refused warp waits for maxLifetime, stop removes all", () => {
    const r = rig();
    r.player(400000);
    r.wreckOf(1);
    r.fx.runPass();
    assert.deepStrictEqual([r.vendor.calls.spawn.length, r.fx.getStatus().counters.noPlayer], [0, 1]);
    r.wreckOf(1);
    assert.strictEqual(r.fx.getStatus().counters.queued, 2, "released wreck can queue again");
    r.vendor.scene.sessions.clear();
    r.player(1000);
    r.fx.runPass();
    r.wreckOf(2);
    r.fx.runPass();
    assert.strictEqual(r.vendor.calls.spawn.length, 2);
    r.vendor.scene.warpResult = { success: false, errorMsg: "WARP_DISTANCE_TOO_CLOSE" };
    r.at(3500);
    r.fx.runPass();
    r.at(4000);
    r.fx.runPass();
    assert.deepStrictEqual([r.vendor.calls.warp.length, r.fx.getStatus().counters.warpFailed], [2, 2]);
    r.at(20999);
    r.fx.runPass();
    assert.strictEqual(r.vendor.calls.remove.length, 0);
    r.at(21000);
    r.fx.runPass();
    assert.deepStrictEqual([r.vendor.calls.remove.length, r.fx.getStatus().counters.removedLifetime], [2, 2]);
    r.wreckOf(3);
    r.wreckOf(4);
    r.fx.runPass();
    assert.strictEqual(r.fx.getStatus().active, 2);
    r.fx.stop();
    assert.deepStrictEqual([r.vendor.calls.remove.length, r.vendor.scene.entities.size, r.removedListeners(),
      r.fx.getStatus().counters.removedStop, r.fx.getStatus().state], [4, 0, 1, 2, "stopped"]);
    r.wreckOf(5);
    assert.strictEqual(r.fx.runPass().ok, false);
  });

  test("CFS3 spawn, warp, remove: identity drift removes the entity and stops further spawns", () => {
    const r = rig({ drift: true });
    r.player(1000);
    r.wreckOf(1);
    r.wreckOf(2);
    r.fx.runPass();
    const st = r.fx.getStatus();
    assert.deepStrictEqual([r.vendor.calls.spawn.length, r.vendor.scene.entities.size, st.counters.identityDrift,
      st.state, st.pending], [1, 0, 1, "tripped", 0]);
    r.wreckOf(3);
    r.fx.runPass();
    assert.strictEqual(r.vendor.calls.spawn.length, 1);
    assert.ok(r.lines.some((l) => l.includes("identity drift")), r.lines.join("\n"));
    r.fx.stop();
    assert.deepStrictEqual(startCapsuleFx({ config: { capsuleFx: { ...SETTINGS, enabled: false } } }),
      { ok: false, reason: "disabled_by_config" });
    assert.strictEqual(createUnavailableCapsuleFx("x").getStatus().state, "unavailable");
  });

  test("CFS4 remove: an entity already gone from the scene counts as entityGone, not removed", () => {
    const r = rig();
    r.player(1000);
    r.wreckOf(1);
    r.fx.runPass();
    r.at(3500);
    r.fx.runPass();
    const [, spec] = r.vendor.calls.spawn[0];
    r.vendor.scene.entities.delete(spec.itemID);
    r.at(7500);
    r.fx.runPass();
    const st = r.fx.getStatus();
    assert.deepStrictEqual([st.active, r.vendor.calls.remove.length, st.counters.entityGone, st.counters.removed,
      st.counters.removedLifetime], [0, 0, 1, 0, 0]);
    r.fx.stop();
  });
};
