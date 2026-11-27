"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const seams = require("../../lib/adapter/highsecTrafficScene");
const { createNpcSpawn } = require("../../lib/adapter/npcSpawn");
const liveProfiles = require("../../lib/adapter/data/liveProfiles");
const { TRAFFIC_HAULER_PROFILES, TRAFFIC_VENDOR_POOL_ID } = require("../../lib/adapter/data/trafficProfiles");
const { GAME_MODULES } = require("../../lib/adapter/gameModules");
const { npcSetupTables } = require("../_support/setupTables");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const SERVER_SRC = path.join(REPO_ROOT, "server", "src");
const SYSTEM = 30000144;
const GATE = { kind: "stargate", itemID: 50001, radius: 15000, position: { x: 1e9, y: 0, z: 0 } };

function readSource(rel) {
  return fs.readFileSync(path.join(SERVER_SRC, rel), "utf8").replace(/\r\n/g, "\n");
}

function block(src, name) {
  const start = src.indexOf(`\nfunction ${name}(`);
  assert.ok(start >= 0, `function ${name}`);
  const end = src.indexOf("\nfunction ", start + 1);
  return src.slice(start, end < 0 ? src.length : end);
}

function fakeGame({ loaded = true, statics = [], dynamics = [], controllers = [], bountyOf = () => 10000,
  storeWrite = true } = {}) {
  const calls = { spawn: [], publish: [], sceneGet: 0, destroy: [], storeWrites: [] };
  const records = new Map();
  const byId = new Map(dynamics.map((e) => [e.itemID, e]));
  const staticById = new Map(statics.map((e) => [e.itemID, e]));
  let nextId = 9000;
  const scene = {
    staticEntities: statics,
    dynamicEntities: byId,
    getEntityByID: (id) => byId.get(id) || staticById.get(id) || null,
    broadcastAddBalls: (list) => calls.publish.push(list.map((e) => e.itemID)),
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
        const bounty = bountyOf(options.profileQuery);
        const entity = { itemID: nextId, kind: "ship", nativeNpc: true, operatorKind: options.operatorKind,
          position: { x: 0, y: 0, z: 0 }, bounty };
        byId.set(nextId, entity);
        records.set(nextId, { entityID: nextId, transient: true, operatorKind: options.operatorKind, bounty });
        return { success: true, data: { entity } };
      },
    },
    "space/npc/npcService": {
      setBehaviorOverrides() { return { success: true }; },
      issueManualOrder() { return { success: true }; },
      wakeNpcController() { return { success: true }; },
      destroyNpcControllerByEntityID(id) {
        calls.destroy.push(id);
        byId.delete(id);
        return { success: true };
      },
    },
    "space/npc/nativeNpcStore": {
      listNativeControllersForSystem: (id) => (id === SYSTEM ? controllers : []),
      getNativeEntity: (id) => (records.has(id) ? { ...records.get(id) } : null),
      upsertNativeEntity(record, options) {
        calls.storeWrites.push({ id: record.entityID, bounty: record.bounty, options });
        if (!storeWrite) return { success: false, errorMsg: "WRITE_DENIED" };
        records.set(record.entityID, { ...record });
        return { success: true };
      },
    },
    "space/npc/npcRuntime": { warpToPoint: () => ({ success: true }) },
    "space/npc/pirateHullProfiles": { resolveFactionHullProfileID: () => null },
    "space/worldData": { getStargatesForSystem: () => [], getStationsForSystem: () => [],
      getAsteroidBeltsForSystem: () => [] },
  };
  const requireGame = (rel) => (mods[rel] ? { ok: true, exports: mods[rel] } : { ok: false, reason: "missing" });
  const npcSpawn = createNpcSpawn({ requireGame, navyProfiles: {}, invaderProfiles: {}, data: liveProfiles });
  return { calls, mods, scene, byId, records, requireGame, npcSpawn };
}

module.exports = ({ test, skip }) => {
  test("HTS1 readNodes: stargate / station statics with radius, ids ascending; listTrafficIds joins scene and store",
    () => {
      const g = fakeGame({
        statics: [
          { kind: "station", itemID: 60000002, radius: 30000, position: { x: 5, y: 0, z: 0 } },
          { kind: "stargate", itemID: 50002, radius: "bad", position: { x: 1, y: 2, z: 3 } },
          GATE,
          { kind: "planet", itemID: 40001, radius: 6e6, position: { x: 0, y: 0, z: 0 } },
          { kind: "asteroidBelt", itemID: 40002, radius: 15000, position: { x: 7, y: 0, z: 0 } },
          { kind: "stargate", itemID: 50003, radius: 10, position: null },
        ],
        dynamics: [{ itemID: 801, kind: "ship", operatorKind: "lneTraffic" },
          { itemID: 802, kind: "ship", operatorKind: "lneAmbient" }],
        controllers: [{ entityID: 803, operatorKind: " lneTraffic " }, { entityID: 801, operatorKind: "lneTraffic" },
          { entityID: 804, operatorKind: "lne" }],
      });
      const seam = seams.createHighsecTrafficScene({ requireGame: g.requireGame, getNpcSpawn: () => g.npcSpawn,
        getHuntScene: () => null });
      assert.deepStrictEqual(Object.keys(seam), [...seams.SEAM_METHODS, ...seams.AGGRO_METHODS,
        ...seams.RAT_AGGRO_METHODS, ...seams.FX_METHODS, ...seams.PATROL_METHODS, ...seams.EXPLORER_METHODS]);
      assert.deepStrictEqual(seam.readNodes(SYSTEM), { ok: true,
        gates: [{ itemId: 50001, position: GATE.position, radius: 15000 },
          { itemId: 50002, position: { x: 1, y: 2, z: 3 }, radius: 0 }],
        stations: [{ itemId: 60000002, position: { x: 5, y: 0, z: 0 }, radius: 30000 }],
        belts: [{ itemId: 40002, position: { x: 7, y: 0, z: 0 }, radius: 15000 }] });
      assert.deepStrictEqual(seam.listTrafficIds(SYSTEM), { ok: true, ids: [801, 803] });
      assert.strictEqual(seam.readNodes(0).reason, "INVALID_INPUT");
      const cold = fakeGame({ loaded: false, statics: [GATE] });
      const coldSeam = seams.createHighsecTrafficScene({ requireGame: cold.requireGame,
        getNpcSpawn: () => cold.npcSpawn, getHuntScene: () => null });
      assert.deepStrictEqual(coldSeam.readNodes(SYSTEM), { ok: false, reason: "SCENE_NOT_LOADED" });
      assert.deepStrictEqual(coldSeam.listTrafficIds(SYSTEM), { ok: false, reason: "SCENE_NOT_LOADED" });
      assert.strictEqual(cold.calls.sceneGet, 0, "no scenes.get without a loaded scene");
      assert.deepStrictEqual(seams.createHighsecTrafficScene({ requireGame: () => ({ ok: false }) }).readNodes(SYSTEM),
        { ok: false, reason: "SEAM_UNAVAILABLE" });
    });

  test("HTS2 spawnCivilian: gate anchor, distance = radius + offset, lneTraffic + TRAFFIC_BEHAVIOR, one publish; "
    + "spawnShip traffic refusals; facade on the real createAdapter", () => {
    const g = fakeGame({ statics: [GATE] });
    const seam = seams.createHighsecTrafficScene({ requireGame: g.requireGame, getNpcSpawn: () => g.npcSpawn,
      getHuntScene: () => null });
    const r = seam.spawnCivilian(SYSTEM, { profileId: "ore_mining_badger_hauler", gateId: GATE.itemID,
      spawnOffsetMeters: 3000 });
    assert.deepStrictEqual(r, { ok: true, entityId: 9001 });
    const opts = g.calls.spawn[0];
    assert.deepStrictEqual([opts.profileQuery, opts.anchorDescriptor, opts.spawnDistanceMeters, opts.operatorKind,
      opts.transient, opts.broadcast], ["ore_mining_badger_hauler", { kind: "entity", itemID: GATE.itemID }, 18000,
      "lneTraffic", true, false]);
    assert.deepStrictEqual(opts.behaviorOverrides, { ...liveProfiles.TRAFFIC_BEHAVIOR });
    assert.notStrictEqual(opts.behaviorOverrides, liveProfiles.TRAFFIC_BEHAVIOR, "a copy for the vendor");
    assert.deepStrictEqual(g.calls.publish, [[9001]], "one publish");
    assert.deepStrictEqual([g.byId.get(9001).bounty, g.records.get(9001).bounty], [0, 0], "hauler bounty 0");
    assert.deepStrictEqual(g.calls.storeWrites[0].options, { transient: true });
    const denied = fakeGame({ statics: [GATE], storeWrite: false });
    const deniedSeam = seams.createHighsecTrafficScene({ requireGame: denied.requireGame,
      getNpcSpawn: () => denied.npcSpawn, getHuntScene: () => null });
    const refused = deniedSeam.spawnCivilian(SYSTEM, { profileId: "ore_mining_badger_hauler", gateId: GATE.itemID,
      spawnOffsetMeters: 3000 });
    assert.strictEqual(refused.ok, false);
    assert.match(String(refused.detail), /BOUNTY_NOT_ZEROED:WRITE_DENIED/);
    assert.deepStrictEqual([denied.calls.destroy, denied.calls.publish], [[9001], []], "fail closed: despawned");
    assert.strictEqual(seam.spawnCivilian(SYSTEM, { profileId: "x", gateId: 77, spawnOffsetMeters: 0 }).reason,
      "GRID_ANCHOR_UNKNOWN");
    const base = { profileId: "ore_mining_badger_hauler", anchorDescriptor: { kind: "entity", itemID: GATE.itemID },
      purpose: "traffic" };
    for (const bad of [{ guard: { proximityAggroRangeMeters: 1, leashRangeMeters: 2 } }, { guard: null },
      { behavior: "search" }, { keepMaterialized: false }, { purpose: "other" }]) {
      assert.strictEqual(g.npcSpawn.spawnShip(SYSTEM, { ...base, ...bad }).reason, "INVALID_INPUT", JSON.stringify(bad));
    }
    assert.strictEqual(g.npcSpawn.spawnShip(SYSTEM, { ...base, purpose: "heavyEvent" }).reason, "INVALID_INPUT",
      "heavyEvent still needs its guard");
    assert.strictEqual(g.calls.spawn.length, 1, "no vendor call for a refused spec");

    const { createAdapter } = require("../../lib/adapter");
    const blind = createAdapter({ moduleApi: { _cache: {} } });
    assert.deepStrictEqual([blind.getHighsecTrafficScene().ok, blind.getHighsecTrafficScene().reason],
      [false, "SEAM_UNAVAILABLE"]);
    const fakeSrc = path.join(path.sep, "fake-evejs", "src");
    const cache = {};
    for (const rel of Object.values(seams.PATHS)) cache[path.join(fakeSrc, `${rel}.js`)] = { exports: g.mods[rel] };
    const adapter = createAdapter({ moduleApi: { _cache: cache } });
    assert.strictEqual(adapter.setServerSrc(fakeSrc).ok, true);
    assert.deepStrictEqual(adapter.checkHighsecTrafficScene(), { ok: true });
    const tools = adapter.getHighsecTrafficScene();
    assert.strictEqual(tools.ok, true);
    assert.strictEqual(adapter.getHighsecTrafficScene().seam, tools.seam, "one seam per adapter");
    assert.deepStrictEqual(tools.seam.listTrafficIds(SYSTEM), { ok: true, ids: [9001] });
  });

  const hts3 = "HTS3 vendor facts: pool = TRAFFIC_HAULER_PROFILES, effective entity bounty 0 / passive / empty loot, behaviour "
    + "whitelist, operatorKind on the entity, consumers highsecTraffic";
  const setup = npcSetupTables();
  if (!setup.ok) skip(hts3, setup.reason);
  else {
    test(hts3, () => {
      const json = (table) => setup.tables[table];
      const pool = json("npcSpawnPools").spawnPools.find((p) => p.spawnPoolID === TRAFFIC_VENDOR_POOL_ID);
      assert.ok(pool, TRAFFIC_VENDOR_POOL_ID);
      assert.deepStrictEqual(pool.entries.map((e) => ({ profileId: e.profileID, weight: e.weight })),
        TRAFFIC_HAULER_PROFILES.map((p) => ({ ...p })));
      const profiles = new Map(json("npcProfiles").profiles.map((p) => [p.profileID, p]));
      const loot = new Map(json("npcLootTables").lootTables.map((t) => [t.lootTableID, t]));
      for (const { profileId } of TRAFFIC_HAULER_PROFILES) {
        const p = profiles.get(profileId);
        assert.ok(p, profileId);
        assert.strictEqual(p.behaviorProfileID, "npc_passive_idle", profileId);
        const table = loot.get(p.lootTableID);
        assert.ok(table, `${profileId} loot ${p.lootTableID}`);
        assert.deepStrictEqual([table.mode, table.entries, table.selectors], ["rule", [], []], p.lootTableID);
      }
      const presentation = require(path.join(SERVER_SRC, "space", "npc", "npcPresentation.js"));
      const vendorBounty = (profileId) => presentation.buildNpcEntityIdentity({ profile: profiles.get(profileId) })
        .bounty;
      const g = fakeGame({ statics: [GATE], bountyOf: vendorBounty });
      const seam = seams.createHighsecTrafficScene({ requireGame: g.requireGame, getNpcSpawn: () => g.npcSpawn,
        getHuntScene: () => null });
      for (const { profileId } of TRAFFIC_HAULER_PROFILES) {
        assert.ok(vendorBounty(profileId) > 0, `${profileId}: the vendor fallback bounty (why we zero it)`);
        const r = seam.spawnCivilian(SYSTEM, { profileId, gateId: GATE.itemID, spawnOffsetMeters: 3000 });
        assert.strictEqual(r.ok, true, profileId);
        assert.deepStrictEqual([g.byId.get(r.entityId).bounty, g.records.get(r.entityId).bounty], [0, 0], profileId);
      }
      const service = readSource("space/npc/nativeNpcService.js");
      assert.ok(service.includes("entity.bounty = entityRecord.bounty;"), "the rebuilt entity reads the store bounty");
      assert.ok(readSource("space/runtime/combatDestruction.js")
        .includes("!(toFiniteNumber(targetEntity.bounty, 0) > 0)"), "the vendor pays only entity bounty > 0");
      assert.ok(block(readSource("space/npc/npcPresentation.js"), "resolveNpcEntityBounty")
        .includes("resolveHullSizeBountyFallback"), "profile bounty 0 falls back (the fact behind)");
      const normalize = block(readSource("space/npc/npcBehaviorLoop.js"), "normalizeBehaviorOverrides");
      for (const key of Object.keys(liveProfiles.TRAFFIC_BEHAVIOR)) {
        assert.ok(normalize.includes(`"${key}"`) || normalize.includes(`overrides.${key} !== undefined`),
          `TRAFFIC_BEHAVIOR.${key} on the vendor whitelist`);
      }
      assert.ok(readSource("space/npc/nativeNpcService.js").includes("entity.operatorKind = entityRecord.operatorKind"),
        "the entity carries operatorKind (kill filter)");
      const consumers = (p, name) => {
        const entry = GAME_MODULES.find((e) => e.path === p && e.symbols.some((s) => s.name === name));
        assert.ok(entry, `${p}.${name}`);
        const sym = entry.symbols.find((s) => s.name === name);
        assert.ok(!sym.wrap && !sym.firstLoad, `${p}.${name} called, never wrapped`);
        return sym.consumers;
      };
      for (const [key, fns] of Object.entries(seams.FUNCTIONS)) {
        for (const fn of fns) assert.ok(consumers(seams.PATHS[key], fn).includes("highsecTraffic"), `${key}.${fn}`);
      }
      assert.ok(consumers("space/runtime", "scenes").includes("highsecTraffic"));
    });
  }

  test("TRV4 spawnCivilian undock: spawnStateOverride from the stub getStationUndockSpawnState (GOTO run), "
    + "slimNameOverride, bad station NO_UNDOCK_POINT, dockPointOf, refusals; vendor facts of the 4 symbols", () => {
    const STATION = { kind: "station", itemID: 60000002, radius: 30000, position: { x: 5e6, y: 0, z: 0 } };
    const g = fakeGame({ statics: [GATE, STATION] });
    const asked = [];
    g.mods["space/runtime"].getStationUndockSpawnState = (station, opts) => {
      asked.push([station.stationID, { ...opts }]);
      return { position: { x: 5020000, y: 0, z: 0 }, direction: { x: 0, y: 1, z: 0 } };
    };
    g.mods["space/worldData"].getStationByID = (id) => (id === STATION.itemID
      ? { stationID: id, solarSystemID: SYSTEM } : null);
    const seam = seams.createHighsecTrafficScene({ requireGame: g.requireGame, getNpcSpawn: () => g.npcSpawn,
      getHuntScene: () => null });
    const undock = { profileId: "ore_mining_badger_hauler", stationId: STATION.itemID, undock: true,
      undockRunMeters: 6000, spawnOffsetMeters: 3000 };
    assert.deepStrictEqual(seam.spawnCivilian(SYSTEM, { ...undock, slimName: "Aura Kessa" }), { ok: true, entityId: 9001 });
    const opts = g.calls.spawn[0];
    assert.deepStrictEqual(opts.spawnStateOverride, { position: { x: 5020000, y: 0, z: 0 },
      direction: { x: 0, y: 1, z: 0 }, targetPoint: { x: 5020000, y: 6000, z: 0 }, mode: "GOTO", speedFraction: 1 });
    assert.deepStrictEqual([opts.slimNameOverride, opts.anchorDescriptor, opts.operatorKind],
      ["Aura Kessa", { kind: "entity", itemID: STATION.itemID }, "lneTraffic"]);
    assert.deepStrictEqual(asked, [[STATION.itemID, { selectionStrategy: "first", selectionKey: 1 }]]);
    assert.deepStrictEqual(seam.dockPointOf(SYSTEM, STATION.itemID), { ok: true, point: { x: 5020000, y: 0, z: 0 },
      direction: { x: 0, y: 1, z: 0 } });
    const bad = seam.spawnCivilian(SYSTEM, { ...undock, stationId: 60009999 });
    assert.deepStrictEqual([bad.ok, bad.reason, g.calls.spawn.length], [false, "NO_UNDOCK_POINT", 1]);
    assert.deepStrictEqual(seam.dockPointOf(SYSTEM, 60009999), { ok: false, reason: "NO_STATION" });
    asked.length = 0;
    assert.strictEqual(seam.spawnCivilian(SYSTEM, { ...undock, shipTypeId: 648 }).ok, true);
    assert.deepStrictEqual(asked, [[STATION.itemID, { shipTypeID: 648, selectionStrategy: "first", selectionKey: 3 }]]);
    g.calls.spawn.pop();
    for (const spec of [{ ...undock, shipTypeId: 0 }, { profileId: "x", gateId: GATE.itemID, spawnOffsetMeters: 0,
      shipTypeId: 648 }]) {
      assert.strictEqual(seam.spawnCivilian(SYSTEM, spec).reason, "INVALID_INPUT", JSON.stringify(spec));
    }
    assert.ok(block(readSource("space/runtime/stationDockingGeometry.js"), "getStationUndockSpawnState")
      .includes("shipTypeID: options.shipTypeID"), "vendor locator takes shipTypeID");
    assert.strictEqual(seam.spawnCivilian(SYSTEM, { profileId: "ore_mining_badger_hauler", gateId: GATE.itemID,
      spawnOffsetMeters: 3000 }).ok, true);
    const plain = g.calls.spawn[1];
    assert.deepStrictEqual(["spawnStateOverride" in plain, "slimNameOverride" in plain], [false, false]);
    for (const spec of [{ ...undock, gateId: GATE.itemID }, { ...undock, stationId: undefined, gateId: GATE.itemID },
      { ...undock, undockRunMeters: undefined }, { ...undock, undock: "yes" }, { ...undock, slimName: 7 }]) {
      assert.strictEqual(seam.spawnCivilian(SYSTEM, spec).reason, "INVALID_INPUT", JSON.stringify(spec));
    }
    const base = { profileId: "ore_mining_badger_hauler", anchorDescriptor: { kind: "entity", itemID: GATE.itemID },
      purpose: "traffic" };
    const okState = { position: { x: 1, y: 2, z: 3 }, direction: { x: 1, y: 0, z: 0 }, targetPoint: { x: 9, y: 2, z: 3 },
      mode: "GOTO", speedFraction: 1 };
    for (const bad2 of [{ spawnState: { ...okState, mode: "WARP" } }, { spawnState: { ...okState, speedFraction: 2 } },
      { spawnState: { ...okState, position: { x: NaN, y: 0, z: 0 } } }, { spawnState: "x" }, { slimName: "<b>x</b>" },
      { slimName: "ab" }]) {
      assert.strictEqual(g.npcSpawn.spawnShip(SYSTEM, { ...base, ...bad2 }).reason, "INVALID_INPUT", JSON.stringify(bad2));
    }
    assert.strictEqual(g.calls.spawn.length, 2, "no vendor call for a refused spec");

    const docking = readSource("space/runtime/spaceRuntime/docking.js");
    assert.ok(docking.includes("getStationUndockSpawnState(station, options = {}) {")
      && docking.includes("return getStationUndockSpawnState(station, options);"), "docking.js mixin method");
    const geometry = block(readSource("space/runtime/stationDockingGeometry.js"), "getStationUndockSpawnState");
    assert.ok(geometry.includes("stationLocatorGeometry.buildStationUndockSpawnState(station, {")
      && geometry.includes("selectionStrategy: options.selectionStrategy"), "station undock geometry");
    const locator = block(readSource("services/station/stationLocatorGeometry.js"), "buildStationUndockSpawnState");
    assert.ok(locator.includes("direction: geometry.undockDirection")
      && locator.includes("position: geometry.undockPosition"), "the undock state has position and direction");
    const anchors = block(readSource("space/npc/npcAnchors.js"), "buildSpawnStateForDefinition");
    assert.ok(anchors.includes("options && options.spawnStateOverride")
      && anchors.includes("mode: String(explicitSpawnState.mode")
      && anchors.includes("speedFraction: toFiniteNumber(explicitSpawnState.speedFraction"), "spawnStateOverride read");
    const native = readSource("space/npc/nativeNpcService.js");
    assert.ok(native.includes("Object.prototype.hasOwnProperty.call(options, \"slimNameOverride\")")
      && native.includes("String(options.slimNameOverride || \"\")"), "slimNameOverride read");
    assert.match(readSource("space/worldData.js"), /function getStationByID\(stationID\) \{/);
    assert.ok(readSource("space/transitions.js").includes(
      "selectionStrategy: dockable.kind === \"structure\" ? \"random\" : \"first\""), "player undock: first");
    for (const [p, name] of [["space/runtime", "getStationUndockSpawnState"], ["space/worldData", "getStationByID"]]) {
      const entry = GAME_MODULES.find((e) => e.path === p && e.symbols.some((s) => s.name === name));
      const sym = entry && entry.symbols.find((s) => s.name === name);
      assert.ok(sym && sym.consumers.includes("highsecTraffic") && !sym.wrap && !sym.firstLoad, `${p}.${name}`);
    }
  });
};
