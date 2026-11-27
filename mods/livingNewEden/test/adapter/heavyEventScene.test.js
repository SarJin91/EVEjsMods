"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const seams = require("../../lib/adapter/heavyEventScene");
const { createNpcSpawn } = require("../../lib/adapter/npcSpawn");
const liveProfiles = require("../../lib/adapter/data/liveProfiles");
const { GAME_MODULES } = require("../../lib/adapter/gameModules");
const killObservation = require("../../lib/adapter/killObservation");

const SERVER_SRC = path.resolve(__dirname, "..", "..", "..", "..", "server", "src");
const SYSTEM = 30002510;
const GURISTAS = 500010;
const BEACON = { x: 1_000_000, y: 0, z: 0 };

function readSource(rel) {
  return fs.readFileSync(path.join(SERVER_SRC, rel), "utf8").replace(/\r\n/g, "\n");
}

function block(src, name) {
  const start = src.indexOf(`\nfunction ${name}(`);
  assert.ok(start >= 0, `function ${name}`);
  const end = src.indexOf("\nfunction ", start + 1);
  return src.slice(start, end < 0 ? src.length : end);
}

const at = (dx) => ({ x: BEACON.x + dx, y: 0, z: 0 });

function fakeGame({ loaded = true, entities = [], noProfile = [], publishThrows = false, destroyFails = [] } = {}) {
  const calls = { spawn: [], publish: [], sceneGet: 0, destroy: [] };
  const byId = new Map(entities.map((e) => [e.itemID, e]));
  let nextId = 9000;
  const scene = {
    dynamicEntities: byId,
    getEntityByID: (id) => byId.get(id) || null,
    broadcastAddBalls: (list) => {
      if (publishThrows) throw new Error("addBalls boom");
      calls.publish.push(list.map((e) => e.itemID));
    },
  };
  const scenes = new Map([[SYSTEM, scene]]);
  const realGet = scenes.get.bind(scenes);
  scenes.get = (k) => { calls.sceneGet += 1; return realGet(k); };
  const mods = {
    "space/runtime": { scenes, isSolarSystemSceneLoaded: (id) => loaded && id === SYSTEM },
    "space/npc/nativeNpcService": {
      spawnNativeNpcEntityInSystem(systemId, options) {
        calls.spawn.push(options);
        nextId += 1;
        const entity = { itemID: nextId, kind: "ship", nativeNpc: true, operatorKind: options.operatorKind,
          position: { ...options.anchorDescriptor.position } };
        byId.set(nextId, entity);
        return { success: true, data: { entity } };
      },
    },
    "space/npc/npcService": {
      setBehaviorOverrides() { return { success: true }; },
      issueManualOrder() { return { success: true }; },
      wakeNpcController() { return { success: true }; },
      destroyNpcControllerByEntityID(id) {
        calls.destroy.push(id);
        if (destroyFails.includes(id)) return { success: false, errorMsg: "DESTROY_REFUSED" };
        byId.delete(id);
        return { success: true };
      },
    },
    "space/npc/pirateHullProfiles": {
      resolveFactionHullProfileID: (key, hullClass) => (noProfile.includes(hullClass) ? null : `${key}_${hullClass}`),
    },
    "space/worldData": { getStargatesForSystem: () => [], getStationsForSystem: () => [],
      getAsteroidBeltsForSystem: () => [] },
  };
  const requireGame = (rel) => (mods[rel] ? { ok: true, exports: mods[rel] } : { ok: false, reason: "missing" });
  const npcSpawn = createNpcSpawn({ requireGame, navyProfiles: {}, invaderProfiles: {}, data: liveProfiles });
  return { calls, mods, scene, byId, requireGame, npcSpawn };
}

module.exports = function heavyEventSceneTests({ test }) {
  test("HES1 vendor facts: coordinates anchor, guard whitelist, operatorKind, ShipWing copy markers, consumers", () => {
    const anchors = readSource("space/npc/npcAnchors.js");
    const resolve = block(anchors, "resolveAnchors");
    assert.ok(resolve.includes("normalizedKind === \"coordinates\""), "coordinates descriptor");
    assert.ok(resolve.includes("anchors: [buildVirtualAnchor(descriptor)]"), "virtual anchor of the descriptor");
    assert.ok(block(anchors, "buildVirtualAnchor").includes("cloneVector(descriptor.position)"), "position used");
    assert.ok(block(anchors, "resolveSpawnDistance").includes("options.spawnDistanceMeters"), "spawnDistanceMeters");
    const normalize = block(readSource("space/npc/npcBehaviorLoop.js"), "normalizeBehaviorOverrides");
    for (const field of ["autoAggro", "autoActivateWeapons", "returnToHomeWhenIdle", "proximityAggroRangeMeters",
      "leashRangeMeters"]) {
      assert.ok(normalize.includes(`"${field}",`), `whitelist ${field}`);
    }
    assert.ok(normalize.includes("overrides.autoAggroTargetClasses !== undefined"), "autoAggroTargetClasses");
    for (const key of Object.keys(liveProfiles.GUARD_BEHAVIOR)) {
      assert.ok(normalize.includes(key), `GUARD_BEHAVIOR.${key} known to the vendor`);
      assert.ok(!liveProfiles.CAPITAL_COMBAT_STRIP.includes(key), `${key} not stripped`);
    }
    const native = readSource("space/npc/nativeNpcService.js");
    assert.ok(block(native, "spawnNativeNpcEntityInSystem").includes("...options,"), "options passed on");
    assert.ok(native.includes("operatorKind: String(options.operatorKind || \"\").trim() || null"), "operatorKind");
    const core = block(readSource("space/runtime/shipEntity.js"), "buildShipEntityCore");
    for (const text of ["kind: \"ship\"", "nativeNpc: source && source.nativeNpc === true",
      "session: options.session || null", "source.pilotCharacterID"]) {
      assert.ok(core.includes(text), text);
    }
    const consumers = (p, name) => {
      const entry = GAME_MODULES.find((e) => e.path === p && e.symbols.some((s) => s.name === name));
      assert.ok(entry, `${p}.${name}`);
      return entry.symbols.find((s) => s.name === name).consumers;
    };
    for (const [key, fns] of Object.entries(seams.FUNCTIONS)) {
      for (const fn of fns) assert.ok(consumers(seams.PATHS[key], fn).includes("heavyEvents"), `${key}.${fn}`);
    }
    assert.ok(consumers("space/runtime", "scenes").includes("heavyEvents"));
  });

  test("HES2 spawnPhase: substitution, unspawnable, one publish, guard options; spawnShip purpose refusals", () => {
    const g = fakeGame({ noProfile: ["battleship"] });
    const seam = seams.createHeavyEventScene({ requireGame: g.requireGame, getNpcSpawn: () => g.npcSpawn,
      getHuntScene: () => null });
    const res = seam.spawnPhase(SYSTEM, { eventId: "hev:1:0", factionId: GURISTAS, anchorPoint: BEACON,
      members: [{ memberKey: "p0:0", hullGroup: "battleship" }, { memberKey: "p0:1", hullGroup: "cruiser" },
        { memberKey: "p0:2", hullGroup: "industrial" }],
      spawnDistanceM: 30000, aggroRangeM: 100000, leashRangeM: 150000, ownerId: null,
      substitute: { dreadnought: "battleship", battleship: "battlecruiser", battlecruiser: "cruiser" } });
    assert.strictEqual(res.ok, true, JSON.stringify(res));
    assert.deepStrictEqual(res.spawned.map((s) => [s.memberKey, s.hullGroup]),
      [["p0:0", "battlecruiser"], ["p0:1", "cruiser"]]);
    assert.deepStrictEqual(res.unspawnable, [{ memberKey: "p0:2", reason: "NO_PROFILE" }]);
    assert.deepStrictEqual(g.calls.publish, [res.spawned.map((s) => s.entityId)], "one publish of the phase");
    const opts = g.calls.spawn[0];
    assert.deepStrictEqual(opts.anchorDescriptor, { kind: "coordinates", position: BEACON });
    assert.deepStrictEqual([opts.profileQuery, opts.spawnDistanceMeters, opts.operatorKind, opts.transient,
      opts.broadcast], ["guristas_battlecruiser", 30000, "lneHeavyEvent", true, false]);
    assert.deepStrictEqual(opts.behaviorOverrides, { autoAggro: true, autoAggroTargetClasses: ["player"],
      returnToHomeWhenIdle: true, autoActivateWeapons: true, proximityAggroRangeMeters: 100000,
      leashRangeMeters: 150000, aggressionRangeMeters: 100000 }, "aggressionRangeMeters = the guard range");
    assert.ok(!Object.prototype.hasOwnProperty.call(opts, "ownerIDOverride"));
    const base = { profileId: "guristas_cruiser", anchorDescriptor: { kind: "coordinates", position: BEACON },
      purpose: "heavyEvent", guard: { proximityAggroRangeMeters: 1, leashRangeMeters: 2 } };
    for (const bad of [{ keepMaterialized: false }, { behavior: "search" }, { purpose: "other" }, { guard: null },
      { guard: { proximityAggroRangeMeters: -1, leashRangeMeters: 2 } }]) {
      assert.strictEqual(g.npcSpawn.spawnShip(SYSTEM, { ...base, ...bad }).reason, "INVALID_INPUT",
        JSON.stringify(bad));
    }
    assert.strictEqual(g.calls.spawn.length, 2, "no vendor call for a refused spec");
    const gone = seam.despawn(SYSTEM, res.spawned.map((s) => s.entityId));
    assert.deepStrictEqual([gone.ok, gone.removed, g.calls.destroy.length], [true, 2, 2]);
  });

  test("HES3 readGrid: players in radius without capsules, copies of present owners only", () => {
    const ship = (itemID, pilot, dx, extra = {}) => ({ itemID, kind: "ship", pilotCharacterID: pilot, session: null,
      nativeNpc: false, position: at(dx), ...extra });
    const g = fakeGame({ entities: [ship(1, 11, 5000), ship(2, 12, 9000), ship(3, 99, 1000),
      ship(4, 0, 1000, { nativeNpc: true }), ship(5, 11, 1000, { session: { characterID: 11 } }),
      ship(6, 11, 900000)] });
    let reads = 0;
    const hunt = { readPlayerShips: () => {
      reads += 1;
      return { ok: true, ships: [
        { characterId: 11, entityId: 101, position: at(10000), capsule: false },
        { characterId: 12, entityId: 102, position: at(500000), capsule: false },
        { characterId: 13, entityId: 103, position: at(1000), capsule: true }] };
    } };
    const seam = seams.createHeavyEventScene({ requireGame: g.requireGame, getNpcSpawn: () => g.npcSpawn,
      getHuntScene: () => hunt });
    assert.deepStrictEqual(seam.readGrid(SYSTEM, BEACON, 150000),
      { ok: true, players: [{ characterId: 11, entityId: 101 }], copies: 2 });
    const cold = fakeGame({ loaded: false });
    const coldSeam = seams.createHeavyEventScene({ requireGame: cold.requireGame, getNpcSpawn: () => cold.npcSpawn,
      getHuntScene: () => hunt });
    assert.deepStrictEqual(coldSeam.readGrid(SYSTEM, BEACON, 150000), { ok: false, reason: "SCENE_NOT_LOADED" });
    assert.deepStrictEqual([reads, cold.calls.sceneGet], [1, 0], "no read without a loaded scene");
    assert.strictEqual(seam.readGrid(SYSTEM, { x: 1 }, 150000).reason, "INVALID_INPUT");
  });

  test("HES4 readMembers: no scene = refusal (never gone); loaded scene live / gone", () => {
    const g = fakeGame({ entities: [{ itemID: 7, kind: "ship", position: at(0) }] });
    const seam = seams.createHeavyEventScene({ requireGame: g.requireGame, getNpcSpawn: () => g.npcSpawn,
      getHuntScene: () => null });
    assert.deepStrictEqual(seam.readMembers(SYSTEM, [7, 8]),
      { ok: true, live: [{ entityId: 7, position: at(0) }], gone: [8] });
    const cold = fakeGame({ loaded: false });
    const coldSeam = seams.createHeavyEventScene({ requireGame: cold.requireGame, getNpcSpawn: () => cold.npcSpawn,
      getHuntScene: () => null });
    assert.deepStrictEqual(coldSeam.readMembers(SYSTEM, [7, 8]), { ok: false, reason: "SCENE_NOT_LOADED" });
    assert.strictEqual(cold.calls.sceneGet, 0);
    assert.strictEqual(coldSeam.spawnPhase(SYSTEM, { eventId: "e", factionId: GURISTAS, anchorPoint: BEACON,
      members: [{ memberKey: "k", hullGroup: "cruiser" }], spawnDistanceM: 1, aggroRangeM: 1, leashRangeM: 1 }).reason,
    "SCENE_NOT_LOADED");
    assert.strictEqual(cold.calls.spawn.length, 0);
  });

  test("HES6: failed publish / throw refuses the phase, created ships despawned, despawn keeps failed", () => {
    const input = { eventId: "hev:2:0", factionId: GURISTAS, anchorPoint: BEACON,
      members: [{ memberKey: "a", hullGroup: "cruiser" }, { memberKey: "b", hullGroup: "cruiser" }],
      spawnDistanceM: 30000, aggroRangeM: 100000, leashRangeM: 150000 };
    const g = fakeGame({ publishThrows: true, destroyFails: [9002] });
    const seam = seams.createHeavyEventScene({ requireGame: g.requireGame, getNpcSpawn: () => g.npcSpawn,
      getHuntScene: () => null });
    const res = seam.spawnPhase(SYSTEM, input);
    assert.deepStrictEqual([res.ok, res.reason, res.detail, res.spawned.map((s) => s.entityId), res.leftover],
      [false, "SPAWN_FAILED", "PUBLISH_FAILED", [9001, 9002], [9002]], JSON.stringify(res));
    assert.deepStrictEqual(g.calls.destroy, [9001, 9002], "every created ship goes back through despawn");
    assert.deepStrictEqual([g.byId.has(9001), g.byId.has(9002)], [false, true]);
    const again = seam.despawn(SYSTEM, [9002]);
    assert.deepStrictEqual([again.ok, again.reason, again.removed, again.missing, again.failed],
      [false, "DESPAWN_FAILED", 0, 0, [9002]], "The not removed ids stay visible to the caller");

    const t = fakeGame();
    let shots = 0;
    const throwing = { ...t.npcSpawn, spawnShip: (...args) => {
      shots += 1;
      if (shots === 2) throw new Error("spawn boom");
      return t.npcSpawn.spawnShip(...args);
    } };
    const tSeam = seams.createHeavyEventScene({ requireGame: t.requireGame, getNpcSpawn: () => throwing,
      getHuntScene: () => null });
    const thrown = tSeam.spawnPhase(SYSTEM, input);
    assert.deepStrictEqual([thrown.reason, thrown.detail, thrown.spawned.map((s) => s.entityId), thrown.leftover,
      t.calls.destroy, t.calls.publish], ["SPAWN_FAILED", "spawn boom", [9001], [], [9001], []],
    "The ids created before the throw are returned and cleaned up");
  });

  test("HES5 kill filter lneHeavyEvent (counter, wrap default) and the facade on the real createAdapter", () => {
    const seen = [];
    const listener = () => ({ onNpcKill: (k) => { seen.push(k.victimId); return { ok: true }; } });
    const before = killObservation.killObservationCounters().heavyEventVictimSkipped;
    const wrap = killObservation.wrapNpcKillStandingLoss(() => ({ applied: true }), {
      resolveVictimFactionID: () => GURISTAS, getLiberation: listener, getStandings: () => null,
      getPlayerActivity: () => null, getFrontJobs: () => null, isNavyVictim: () => false });
    assert.strictEqual(wrap.ok, true);
    const options = { nowMs: 5, systemID: SYSTEM };
    assert.deepStrictEqual(wrap.wrapped({ operatorKind: " lneHeavyEvent ", itemID: 1 }, 7, options), { applied: true });
    wrap.wrapped({ operatorKind: "lne", itemID: 2 }, 7, options);
    assert.deepStrictEqual(seen, [2], "a LIVE battle ship still reaches the listeners");
    assert.strictEqual(killObservation.killObservationCounters().heavyEventVictimSkipped, before + 1);
    assert.deepStrictEqual(killObservation.observeKill({ applied: true }, { operatorKind: "lneHeavyEvent" }, 7, options,
      { isHeavyEventVictim: seams.isHeavyEventVictim }), { skipped: "HEAVY_EVENT" });

    const { createAdapter } = require("../../lib/adapter");
    const blind = createAdapter({ moduleApi: { _cache: {} } });
    assert.deepStrictEqual([blind.getHeavyEventScene().ok, blind.getHeavyEventScene().reason],
      [false, "SEAM_UNAVAILABLE"]);
    assert.strictEqual(blind.checkHeavyEventSeams().ok, false);
    const g = fakeGame();
    const fakeSrc = path.join(path.sep, "fake-evejs", "src");
    const cache = {};
    for (const rel of Object.values(seams.PATHS)) cache[path.join(fakeSrc, `${rel}.js`)] = { exports: g.mods[rel] };
    const adapter = createAdapter({ moduleApi: { _cache: cache } });
    assert.strictEqual(adapter.setServerSrc(fakeSrc).ok, true);
    assert.deepStrictEqual(adapter.checkHeavyEventSeams(), { ok: true });
    const tools = adapter.getHeavyEventScene();
    assert.strictEqual(tools.ok, true);
    assert.deepStrictEqual(Object.keys(tools.seam), [...seams.SEAM_METHODS]);
    assert.strictEqual(adapter.getHeavyEventScene().seam, tools.seam, "one seam per adapter");
    assert.deepStrictEqual(tools.seam.readMembers(SYSTEM, [5]), { ok: true, live: [], gone: [5] });
  });
};
