"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const ns = require("../../lib/adapter/npcSpawn");
const liveProfiles = require("../../lib/adapter/data/liveProfiles");
const { NAVY_PROFILES_BY_FACTION_ID, HULL_CLASSES } = require("../../lib/adapter/empireNavyCatalog");
const { CAPSULEER_LIVE_PROFILES } = require("../../lib/adapter/data/capsuleerLiveProfiles");
const { INVADER_LIVE_PROFILES } = require("../../lib/adapter/data/invaderLiveProfiles");
const { INDUSTRY_LIVE_PROFILES } = require("../../lib/adapter/data/industryLiveProfiles");
const { GAME_MODULES } = require("../../lib/adapter/gameModules");
const { probeModules } = require("../../lib/adapter/probe");
const { createAdapter } = require("../../lib/adapter");
const { HULL_GROUPS, INDUSTRY_HULL_GROUPS } = require("../../lib/fleets/schema");
const { FACTION_CATALOG } = require("../../lib/strategy/data/factionCatalog");

const SERVER_SRC = path.resolve(__dirname, "..", "..", "..", "..", "server", "src");
const MOD_DIR = path.resolve(__dirname, "..", "..");
const SYSTEM = 30000142;
const MAT = "materialization";

function readSource(rel) {
  return fs.readFileSync(path.join(SERVER_SRC, rel), "utf8").replace(/\r\n/g, "\n");
}

function functionBody(source, name) {
  const start = source.indexOf(`\nfunction ${name}(`);
  assert.ok(start >= 0, `function ${name} not found`);
  const next = source.indexOf("\nfunction ", start + 1);
  return source.slice(start, next === -1 ? undefined : next);
}

function exportBlock(source) {
  const start = source.search(/^module\.exports = \{/m);
  assert.ok(start >= 0, "module.exports block");
  const rest = source.slice(start);
  return rest.slice(0, rest.search(/^\};/m));
}

function makeVendor({ sceneLoaded = true, gates = [{ itemID: 50000300 }, { itemID: 50000100 }], stations = [],
  belts = [] } = {}) {
  const calls = [];
  const entities = new Map();
  const controllers = new Set();
  let nextId = 9000001;
  const scene = {
    getEntityByID(id) { return entities.get(id) || null; },
    broadcastAddBalls(list, excluded, options) {
      calls.push(["broadcastAddBalls", list.map((e) => e.itemID), excluded, options]);
    },
  };
  const runtime = Object.create({
    isSolarSystemSceneLoaded(id) { calls.push(["isSolarSystemSceneLoaded", id]); return this.scenes.has(id); },
    ensureScene(id) { calls.push(["ensureScene", id]); return scene; },
  });
  runtime.scenes = new Map(sceneLoaded ? [[SYSTEM, scene]] : []);
  const notFound = () => ({ success: false, errorMsg: "NPC_NOT_FOUND" });
  const vendor = {
    calls,
    entities,
    scene,
    runtime,
    spawnResult: null,
    hullNull: new Set(),
    native: {
      spawnNativeNpcEntityInSystem(systemId, options) {
        calls.push(["spawnNativeNpcEntityInSystem", systemId, options]);
        if (vendor.spawnResult) return vendor.spawnResult();
        const entity = { itemID: nextId };
        nextId += 1;
        entities.set(entity.itemID, entity);
        controllers.add(entity.itemID);
        return { success: true, data: { entity, controller: { entityID: entity.itemID } } };
      },
    },
    hulls: {
      resolveFactionHullProfileID(key, hullClass, options) {
        calls.push(["resolveFactionHullProfileID", key, hullClass, options]);
        if (vendor.hullNull.has(`${key}:${hullClass}`)) return null;
        let h = 0;
        for (const ch of String(options.seed)) h = ((h * 31) + ch.charCodeAt(0)) % 997;
        return `${key}_${hullClass}_${h % 3}`;
      },
    },
    npc: {
      setBehaviorOverrides(id, overrides) {
        calls.push(["setBehaviorOverrides", id, overrides]);
        return controllers.has(id) ? { success: true, data: {} } : notFound();
      },
      issueManualOrder(id, order) {
        calls.push(["issueManualOrder", id, order]);
        return controllers.has(id) ? { success: true, data: {} } : notFound();
      },
      wakeNpcController(id, whenMs) {
        calls.push(["wakeNpcController", id, whenMs]);
        return controllers.has(id) ? { success: true, data: {} } : notFound();
      },
      destroyNpcControllerByEntityID(id, options) {
        calls.push(["destroyNpcControllerByEntityID", id, options]);
        if (!controllers.has(id)) return notFound();
        controllers.delete(id);
        entities.delete(id);
        return { success: true, data: {} };
      },
    },
    worldData: {
      getStargatesForSystem: () => gates.map((g) => ({ ...g })),
      getStationsForSystem: () => stations.map((s) => ({ ...s })),
      getAsteroidBeltsForSystem: () => belts.map((b) => ({ ...b })),
    },
  };
  const byPath = {
    [ns.MODULE_PATHS.native]: vendor.native,
    [ns.MODULE_PATHS.hulls]: vendor.hulls,
    [ns.MODULE_PATHS.npc]: vendor.npc,
    [ns.MODULE_PATHS.runtime]: runtime,
    [ns.MODULE_PATHS.worldData]: vendor.worldData,
  };
  vendor.requireGame = (rel) => (byPath[rel] ? { ok: true, exports: byPath[rel] } : { ok: false, reason: "file_not_found" });
  vendor.seam = ns.createNpcSpawn({ requireGame: vendor.requireGame, navyProfiles: NAVY_PROFILES_BY_FACTION_ID,
    data: liveProfiles });
  return vendor;
}

function spawnN(v, n) {
  const ids = [];
  for (let i = 0; i < n; i += 1) {
    const r = v.seam.spawnShip(SYSTEM, { profileId: "p", anchorDescriptor: { kind: "stargate", itemID: 1 } });
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    ids.push(r.entityId);
  }
  return ids;
}

module.exports = ({ test }) => {
  test("AS1 resolveProfiles: empire navy, seeded pirate profile, NO_PROFILE; liveProfiles data", () => {
    const v = makeVendor();
    const navy = v.seam.resolveProfiles([{ memberKey: "k0", factionId: 500001, hullGroup: "logistics" }],
      { seedPrefix: "p" });
    assert.deepStrictEqual(navy, { ok: true, profiles: ["parity_faction_warfare_entities_75358_state_cruiser"] });
    assert.deepStrictEqual(v.calls, [], "empire profile never asks the vendor");

    const req = [{ memberKey: "k1", factionId: 500010, hullGroup: "tackle" },
      { memberKey: "k2", factionId: 500003, hullGroup: "capital" }];
    const first = v.seam.resolveProfiles(req, { seedPrefix: "p" });
    assert.strictEqual(first.ok, true);
    assert.deepStrictEqual(v.calls[0], ["resolveFactionHullProfileID", "guristas", "frigate", { seed: "p:k1" }]);
    assert.strictEqual(first.profiles.length, 2);
    assert.strictEqual(first.profiles[1], "parity_faction_warfare_entities_75355_imperial_battleship", "order kept");
    assert.deepStrictEqual(v.seam.resolveProfiles(req, { seedPrefix: "p" }), first, "same seed -> same result");

    assert.deepStrictEqual(v.seam.resolveProfiles([{ memberKey: "k", factionId: 500006, hullGroup: "frigate" }],
      { seedPrefix: "p" }), { ok: false, reason: "NO_PROFILE", factionId: 500006, hullGroup: "frigate" });
    assert.deepStrictEqual(v.seam.resolveProfiles([{ memberKey: "k", factionId: 500001, hullGroup: "industrial" }],
      { seedPrefix: "p" }), { ok: false, reason: "NO_PROFILE", factionId: 500001, hullGroup: "industrial" });
    v.hullNull.add("sleepers:battlecruiser");
    assert.deepStrictEqual(v.seam.resolveProfiles([{ memberKey: "k", factionId: 500021, hullGroup: "battlecruiser" }],
      { seedPrefix: "p" }), { ok: false, reason: "NO_PROFILE", factionId: 500021, hullGroup: "battlecruiser" });

    const catalogIds = new Set(FACTION_CATALOG.map((f) => f.factionId));
    for (const id of Object.keys(liveProfiles.PIRATE_KEY_BY_FACTION_ID)) assert.ok(catalogIds.has(Number(id)), id);
    assert.strictEqual(Object.keys(liveProfiles.PIRATE_KEY_BY_FACTION_ID).length, 7);
    for (const [group, cls] of Object.entries(liveProfiles.HULL_CLASS_BY_GROUP)) {
      assert.ok(HULL_GROUPS.includes(group), group);
      assert.ok(HULL_CLASSES.includes(cls), cls);
    }
    for (const group of ["industrial", ...INDUSTRY_HULL_GROUPS]) {
      assert.ok(!Object.prototype.hasOwnProperty.call(liveProfiles.HULL_CLASS_BY_GROUP, group), group);
    }
  });

  test("AS1b resolveProfiles invaders: 500026 / 500024 only with invaders === true", () => {
    const v = makeVendor();
    const seam = ns.createNpcSpawn({ requireGame: v.requireGame, navyProfiles: NAVY_PROFILES_BY_FACTION_ID,
      invaderProfiles: INVADER_LIVE_PROFILES, data: liveProfiles });
    const one = (factionId, hullGroup, extra) => seam.resolveProfiles([{ memberKey: "k", factionId, hullGroup }],
      { seedPrefix: "p", ...extra });
    for (const extra of [{}, { invaders: false }, { invaders: 1 }]) {
      assert.deepStrictEqual(one(500026, "frigate", extra),
        { ok: false, reason: "NO_PROFILE", factionId: 500026, hullGroup: "frigate" });
      assert.deepStrictEqual(one(500024, "battleship", extra),
        { ok: false, reason: "NO_PROFILE", factionId: 500024, hullGroup: "battleship" });
    }
    const on = { invaders: true };
    assert.deepStrictEqual(one(500026, "frigate", on), { ok: true, profiles: ["parity_trig_liminal_damavik"] });
    assert.deepStrictEqual(one(500026, "logistics", on), { ok: true, profiles: ["parity_trig_liminal_vedmak"] });
    assert.deepStrictEqual(one(500024, "capital", on), { ok: true, profiles: ["parity_drifter_battleship"] });
    for (const group of Object.keys(liveProfiles.HULL_CLASS_BY_GROUP)) {
      for (const factionId of [500024, 500026]) {
        const cls = liveProfiles.HULL_CLASS_BY_GROUP[group];
        assert.deepStrictEqual(one(factionId, group, on),
          { ok: true, profiles: [INVADER_LIVE_PROFILES[factionId][cls]] }, `${factionId} ${group}`);
      }
    }
    assert.deepStrictEqual(one(500026, "industrial", on),
      { ok: false, reason: "NO_PROFILE", factionId: 500026, hullGroup: "industrial" });
    for (const factionId of [500006, 500029]) {
      assert.deepStrictEqual(one(factionId, "frigate", on),
        { ok: false, reason: "NO_PROFILE", factionId, hullGroup: "frigate" });
    }
    assert.deepStrictEqual(v.calls, [], "invader / refused profiles never ask the vendor");
    const req = [{ memberKey: "k0", factionId: 500001, hullGroup: "logistics" },
      { memberKey: "k1", factionId: 500010, hullGroup: "tackle" }];
    assert.deepStrictEqual(seam.resolveProfiles(req, { seedPrefix: "p", invaders: true }),
      seam.resolveProfiles(req, { seedPrefix: "p" }));
  });

  test("IP2 resolveProfiles industry: hauler / miner profiles only with industry === true", () => {
    const v = makeVendor();
    const seam = ns.createNpcSpawn({ requireGame: v.requireGame, navyProfiles: NAVY_PROFILES_BY_FACTION_ID,
      invaderProfiles: INVADER_LIVE_PROFILES, industryProfiles: INDUSTRY_LIVE_PROFILES, data: liveProfiles });
    const one = (factionId, hullGroup, extra) => seam.resolveProfiles([{ memberKey: "k", factionId, hullGroup }],
      { seedPrefix: "p", ...extra });
    const on = { industry: true };
    assert.deepStrictEqual(one(500001, "industrial", on), { ok: true, profiles: ["ore_mining_badger_hauler"] });
    assert.deepStrictEqual(one(500010, "freighter", on), { ok: true, profiles: ["parity_guristas_transporter"] });
    assert.deepStrictEqual(one(500003, "mining_barge", on), { ok: true, profiles: ["ore_mining_retriever"] });
    assert.deepStrictEqual(one(500014, "industrial", on), { ok: true, profiles: ["ore_mining_badger_hauler"] },
      "faction outside the table -> DEFAULT_RACE (Badger)");
    assert.deepStrictEqual(one(500021, "industrial", on),
      { ok: false, reason: "NO_PROFILE", factionId: 500021, hullGroup: "industrial" });
    assert.deepStrictEqual(one(500001, "orca", on),
      { ok: false, reason: "NO_PROFILE", factionId: 500001, hullGroup: "orca" });
    for (const extra of [{}, { industry: false }]) {
      assert.deepStrictEqual(one(500001, "industrial", extra),
        { ok: false, reason: "NO_PROFILE", factionId: 500001, hullGroup: "industrial" }, "02c behaviour");
    }
    assert.deepStrictEqual(one(500001, "industrial", { industry: "yes" }), { ok: false, reason: "INVALID_INPUT" });
    assert.deepStrictEqual(v.calls, [], "industry profiles never ask the vendor");
  });

  test("AS2 spawnShip / pickAnchor: scene guard before the vendor, vendor options, SPAWN_FAILED", () => {
    const cold = makeVendor({ sceneLoaded: false });
    const spec = { profileId: "guristas_frigate_1", anchorDescriptor: { kind: "stargate", itemID: 50000100 },
      spawnDistanceMeters: 20000 };
    assert.deepStrictEqual(cold.seam.spawnShip(SYSTEM, spec), { ok: false, reason: "SCENE_NOT_LOADED" });
    assert.deepStrictEqual(cold.seam.pickAnchor(SYSTEM), { ok: false, reason: "SCENE_NOT_LOADED" });
    assert.strictEqual(cold.seam.isSceneLoaded(SYSTEM), false);
    assert.deepStrictEqual(cold.calls.filter((c) => c[0] !== "isSolarSystemSceneLoaded"), [],
      "neither the vendor spawn nor ensureScene is called");
    assert.strictEqual(fs.readFileSync(path.join(MOD_DIR, "lib", "adapter", "npcSpawn.js"), "utf8")
      .includes("ensureScene"), false, "the seam never names the scene loader");

    const v = makeVendor();
    assert.strictEqual(v.seam.isSceneLoaded(SYSTEM), true);
    const r = v.seam.spawnShip(SYSTEM, spec);
    assert.deepStrictEqual(r, { ok: true, entityId: 9000001 });
    const call = v.calls.find((c) => c[0] === "spawnNativeNpcEntityInSystem");
    assert.deepStrictEqual(call, ["spawnNativeNpcEntityInSystem", SYSTEM, {
      profileQuery: "guristas_frigate_1",
      anchorDescriptor: { kind: "stargate", itemID: 50000100 },
      spawnDistanceMeters: 20000,
      transient: true,
      operatorKind: "lne",
      broadcast: false,
      skipInitialBehaviorTick: true,
      behaviorOverrides: { autoAggro: false, autoActivateWeapons: false, targetPreference: "none" },
    }]);
    assert.ok(!v.calls.some((c) => c[0] === "ensureScene"));

    const callsBefore = v.calls.length;
    assert.strictEqual(v.seam.spawnShip(SYSTEM, { ...spec, keepMaterialized: true }).ok, true);
    const keep = v.calls.slice(callsBefore).find((c) => c[0] === "spawnNativeNpcEntityInSystem");
    assert.strictEqual(Object.prototype.hasOwnProperty.call(keep[2], "operatorKind"), false);
    const { operatorKind: _omitted, ...rest } = call[2];
    assert.deepStrictEqual(keep[2], rest);
    for (const off of [false, null]) {
      const at = v.calls.length;
      assert.strictEqual(v.seam.spawnShip(SYSTEM, { ...spec, keepMaterialized: off }).ok, true);
      assert.strictEqual(v.calls.slice(at).find((c) => c[0] === "spawnNativeNpcEntityInSystem")[2].operatorKind, "lne");
    }
    const atBad = v.calls.length;
    assert.deepStrictEqual(v.seam.spawnShip(SYSTEM, { ...spec, keepMaterialized: "yes" }),
      { ok: false, reason: "INVALID_INPUT" });
    assert.strictEqual(v.calls.slice(atBad).some((c) => c[0] === "spawnNativeNpcEntityInSystem"), false);

    v.spawnResult = () => ({ success: false, errorMsg: "ANCHOR_NOT_FOUND" });
    assert.deepStrictEqual(v.seam.spawnShip(SYSTEM, spec), { ok: false, reason: "SPAWN_FAILED",
      detail: "ANCHOR_NOT_FOUND" });
    v.spawnResult = () => { throw new Error("boom"); };
    assert.deepStrictEqual(v.seam.spawnShip(SYSTEM, spec), { ok: false, reason: "SPAWN_FAILED", detail: "boom" });

    assert.deepStrictEqual(v.seam.pickAnchor(SYSTEM),
      { ok: true, anchorDescriptor: { kind: "stargate", itemID: 50000100 } });
    assert.deepStrictEqual(makeVendor({ gates: [], stations: [{ stationID: 60000004 }, { stationID: 60000002 }] })
      .seam.pickAnchor(SYSTEM), { ok: true, anchorDescriptor: { kind: "station", itemID: 60000002 } });
    assert.deepStrictEqual(makeVendor({ gates: [], belts: [{ itemID: 40000007 }] }).seam.pickAnchor(SYSTEM),
      { ok: true, anchorDescriptor: { kind: "asteroidBelt", itemID: 40000007 } });
    assert.deepStrictEqual(makeVendor({ gates: [] }).seam.pickAnchor(SYSTEM), { ok: false, reason: "NO_ANCHOR" });
  });

  test("AS2b pickAnchor prefer station: station -> stargate -> belt; {} = default; bad prefer INVALID_INPUT", () => {
    const both = makeVendor({ stations: [{ stationID: 60000004 }, { stationID: 60000002 }], belts: [{ itemID: 40000007 }] });
    assert.deepStrictEqual(both.seam.pickAnchor(SYSTEM, { prefer: "station" }),
      { ok: true, anchorDescriptor: { kind: "station", itemID: 60000002 } });
    assert.deepStrictEqual(both.seam.pickAnchor(SYSTEM, {}),
      { ok: true, anchorDescriptor: { kind: "stargate", itemID: 50000100 } });
    assert.deepStrictEqual(makeVendor({ belts: [{ itemID: 40000007 }] }).seam.pickAnchor(SYSTEM, { prefer: "station" }),
      { ok: true, anchorDescriptor: { kind: "stargate", itemID: 50000100 } });
    assert.deepStrictEqual(makeVendor({ gates: [], belts: [{ itemID: 40000007 }] })
      .seam.pickAnchor(SYSTEM, { prefer: "station" }), { ok: true, anchorDescriptor: { kind: "asteroidBelt",
      itemID: 40000007 } });
    for (const bad of [{ prefer: "gate" }, { prefer: null }, "station", [1]]) {
      assert.deepStrictEqual(both.seam.pickAnchor(SYSTEM, bad), { ok: false, reason: "INVALID_INPUT" });
    }
  });

  test("AS3 engage / publish / despawn / countAlive", () => {
    const v = makeVendor();
    const sideA = spawnN(v, 3);
    const sideB = spawnN(v, 2);
    v.calls.length = 0;
    assert.deepStrictEqual(v.seam.engage(SYSTEM, sideA, sideB, { aggroPlayers: false, targetMode: "vendor" }),
      { ok: true });
    const orders = v.calls.filter((c) => c[0] === "issueManualOrder").map((c) => [c[1], c[2].type, c[2].targetID]);
    assert.deepStrictEqual(orders, [
      [sideA[0], "attack", sideB[0]], [sideA[1], "attack", sideB[1]], [sideA[2], "attack", sideB[0]],
      [sideB[0], "attack", sideA[0]], [sideB[1], "attack", sideA[1]]]);
    const overrides = v.calls.filter((c) => c[0] === "setBehaviorOverrides");
    assert.strictEqual(overrides.length, 5);
    for (const [, , o] of overrides) {
      assert.strictEqual(o.allowFriendlyNpcTargets, true);
      assert.strictEqual(o.autoAggro, true);
      assert.strictEqual(o.targetPreference, "nearestNpc");
      assert.strictEqual(o.movementMode, "orbit");
      assert.strictEqual(o.returnToHomeWhenIdle, false);
      assert.deepStrictEqual(o.autoAggroTargetClasses, ["npc"]);
    }
    assert.deepStrictEqual(v.calls.filter((c) => c[0] === "wakeNpcController").map((c) => [c[1], c[2]]),
      [...sideA, ...sideB].map((id) => [id, 0]));
    v.calls.length = 0;
    assert.deepStrictEqual(v.seam.engage(SYSTEM, sideA, sideB, { aggroPlayers: true, targetMode: "vendor" }),
      { ok: true });
    assert.deepStrictEqual(v.calls.find((c) => c[0] === "setBehaviorOverrides")[2].autoAggroTargetClasses,
      ["npc", "player"]);

    for (const [opts, classes] of [[{ aggroPlayers: false }, []], [{ aggroPlayers: false, targetMode: "manual" }, []],
      [{ aggroPlayers: true, targetMode: "manual" }, ["player"]]]) {
      v.calls.length = 0;
      assert.deepStrictEqual(v.seam.engage(SYSTEM, sideA, sideB, opts), { ok: true });
      const set = v.calls.filter((c) => c[0] === "setBehaviorOverrides");
      assert.strictEqual(set.length, 5);
      for (const [, , o] of set) {
        assert.ok(Object.prototype.hasOwnProperty.call(o, "autoAggroTargetClasses"));
        assert.deepStrictEqual(o.autoAggroTargetClasses, classes);
        assert.strictEqual(o.targetPreference, "preferredTargetOnly");
        assert.strictEqual(o.allowTargetSwitching, false);
        assert.strictEqual(o.allowFriendlyNpcTargets, true);
        assert.strictEqual(o.autoActivateWeapons, true);
      }
      assert.deepStrictEqual(v.calls.filter((c) => c[0] === "issueManualOrder").map((c) => [c[1], c[2].targetID]),
        [[sideA[0], sideB[0]], [sideA[1], sideB[1]], [sideA[2], sideB[0]], [sideB[0], sideA[0]], [sideB[1], sideA[1]]]);
    }
    assert.ok(Object.isFrozen(liveProfiles.COMBAT_BEHAVIOR_MANUAL));
    assert.deepStrictEqual(v.seam.engage(SYSTEM, sideA, sideB, { targetMode: "auto" }),
      { ok: false, reason: "INVALID_INPUT", detail: "targetMode" });
    assert.strictEqual(v.seam.engage(SYSTEM, [], sideB, {}).reason, "ENGAGE_FAILED");
    assert.deepStrictEqual(v.seam.engage(SYSTEM, [777], sideB, {}),
      { ok: false, reason: "ENGAGE_FAILED", entityId: 777, detail: "NPC_NOT_FOUND" });

    v.calls.length = 0;
    const all = [...sideA, ...sideB];
    assert.deepStrictEqual(v.seam.publish(SYSTEM, all), { ok: true, published: 5, missing: 0 });
    assert.deepStrictEqual(v.calls.filter((c) => c[0] === "broadcastAddBalls"),
      [["broadcastAddBalls", all, null, { freshAcquire: true, minimumLeadFromCurrentHistory: 2 }]]);
    assert.deepStrictEqual(makeVendor({ sceneLoaded: false }).seam.publish(SYSTEM, all),
      { ok: false, reason: "SCENE_NOT_LOADED" });

    assert.strictEqual(v.seam.countAlive(SYSTEM, all), 5);
    assert.deepStrictEqual(v.seam.despawn(SYSTEM, [sideA[0], sideA[1], 424242]),
      { ok: true, removed: 2, missing: 1, purged: 0 });
    assert.deepStrictEqual(v.calls.filter((c) => c[0] === "destroyNpcControllerByEntityID").map((c) => c[2]),
      [{ broadcast: true, suppressWreck: true }, { broadcast: true, suppressWreck: true },
        { broadcast: true, suppressWreck: true }]);
    assert.strictEqual(v.seam.countAlive(SYSTEM, all), 3);
    assert.strictEqual(makeVendor({ sceneLoaded: false }).seam.countAlive(SYSTEM, all), 0);

    assert.deepStrictEqual(v.seam.listAlive(SYSTEM, [sideB[1], sideA[0], sideA[2], 424242]), [sideB[1], sideA[2]]);
    assert.deepStrictEqual(makeVendor({ sceneLoaded: false }).seam.listAlive(SYSTEM, all), []);
    assert.deepStrictEqual(v.seam.listAlive(SYSTEM, null), []);
    v.calls.length = 0;
    assert.deepStrictEqual(v.seam.orderAttack(SYSTEM, sideA[2], sideB[1]), { ok: true });
    assert.deepStrictEqual(v.calls.filter((c) => c[0] !== "isSolarSystemSceneLoaded"),
      [["issueManualOrder", sideA[2], { type: "attack", targetID: sideB[1] }], ["wakeNpcController", sideA[2], 0]]);
    assert.deepStrictEqual(v.seam.orderAttack(SYSTEM, sideA[0], sideB[1]),
      { ok: false, reason: "ORDER_FAILED", detail: "NPC_NOT_FOUND" });
    assert.deepStrictEqual(v.seam.orderAttack(SYSTEM, 0, sideB[1]), { ok: false, reason: "INVALID_INPUT" });
    const coldOrder = makeVendor({ sceneLoaded: false });
    assert.deepStrictEqual(coldOrder.seam.orderAttack(SYSTEM, 1, 2), { ok: false, reason: "SCENE_NOT_LOADED" });
    assert.deepStrictEqual(coldOrder.calls.filter((c) => c[0] !== "isSolarSystemSceneLoaded"), []);
  });

  test("CM1: no capital class in HULL_CLASS_BY_GROUP; flag off (no index / DISABLED "
    + "throw) or a class outside the index -> NO_PROFILE detail CAPITAL for all 5 classes, never a battleship and "
    + "never the vendor; index -> lne_capital_<f>_<cls>; CM2 typeId of the request other than the index -> NO_PROFILE",
  () => {
    const { CAPITAL_HULL_GROUPS } = require("../../lib/fleets/schema");
    const { classTypeOf } = require("../../lib/strategy/data/factionHullClasses");
    assert.deepStrictEqual([...liveProfiles.CAPITAL_LIVE_GROUPS], [...CAPITAL_HULL_GROUPS]);
    for (const cls of CAPITAL_HULL_GROUPS) {
      assert.ok(!Object.prototype.hasOwnProperty.call(liveProfiles.HULL_CLASS_BY_GROUP, cls), cls);
    }
    const FACTIONS = [500001, 500012];
    const indexOf = (classes) => {
      const index = {};
      for (const f of FACTIONS) {
        index[String(f)] = {};
        for (const cls of classes) {
          const typeId = classTypeOf(f, cls);
          if (typeId) index[String(f)][cls] = { profileId: `lne_capital_${f}_${cls}`, typeId };
        }
      }
      return index;
    };
    const seamWith = (v, capitalIndex) => ns.createNpcSpawn({ requireGame: v.requireGame,
      navyProfiles: NAVY_PROFILES_BY_FACTION_ID, invaderProfiles: INVADER_LIVE_PROFILES, data: liveProfiles,
      capitalIndex });
    const one = (seam, factionId, hullGroup, typeId, extra) => seam.resolveProfiles([{ memberKey: "k", factionId,
      hullGroup, ...(typeId === undefined ? {} : { typeId }) }], { seedPrefix: "p", ...extra });
    const refused = (factionId, hullGroup) => ({ ok: false, reason: "NO_PROFILE", factionId, hullGroup,
      detail: "CAPITAL" });
    const v = makeVendor();
    const off = [seamWith(v, undefined), seamWith(v, () => ({ ok: false, reason: "DISABLED" })),
      seamWith(v, () => { throw new Error("boom"); }), seamWith(v, () => ({ ok: true, enabled: true,
        index: indexOf(["dreadnought"]), skipped: [] }))];
    for (const [i, seam] of off.entries()) {
      for (const cls of CAPITAL_HULL_GROUPS) {
        if (i === 3 && cls === "dreadnought") continue;
        for (const f of FACTIONS) {
          for (const extra of [{}, { invaders: true }]) {
            assert.deepStrictEqual(one(seam, f, cls, classTypeOf(f, cls), extra), refused(f, cls), `${i} ${f} ${cls}`);
          }
        }
      }
    }
    const all = { ok: true, enabled: true, index: indexOf([...CAPITAL_HULL_GROUPS]), skipped: [] };
    const on = seamWith(v, () => all);
    for (const f of FACTIONS) {
      for (const cls of CAPITAL_HULL_GROUPS) {
        const typeId = classTypeOf(f, cls);
        if (!typeId) {
          assert.deepStrictEqual(one(on, f, cls, null), refused(f, cls), `${f} ${cls} without a hull`);
          continue;
        }
        for (const t of [typeId, null, undefined]) {
          assert.deepStrictEqual(one(on, f, cls, t), { ok: true, profiles: [`lne_capital_${f}_${cls}`] }, `${f} ${cls}`);
        }
        assert.deepStrictEqual(one(on, f, cls, typeId + 1), refused(f, cls), `${f} ${cls} typeId`);
      }
    }
    let reads = 0;
    const counted = seamWith(v, () => { reads += 1; return all; });
    assert.deepStrictEqual(counted.resolveProfiles([{ memberKey: "a", factionId: 500001, hullGroup: "titan",
      typeId: classTypeOf(500001, "titan") }, { memberKey: "b", factionId: 500001, hullGroup: "logistics", typeId: 1 },
    { memberKey: "c", factionId: 500001, hullGroup: "dreadnought" }], { seedPrefix: "p" }),
    { ok: true, profiles: ["lne_capital_500001_titan", "parity_faction_warfare_entities_75358_state_cruiser",
      "lne_capital_500001_dreadnought"] });
    assert.strictEqual(reads, 1);
    assert.deepStrictEqual(v.calls, [], "a capital never asks the vendor hull pools");
  });

  test("CM4: engage with capitalIds - a capital gets the combat overrides without movement "
    + "and chase keys (manual and vendor mode), a subcap the full overrides; a non-Set capitalIds -> INVALID_INPUT",
  () => {
    const v = makeVendor();
    const [a1, a2, b1] = spawnN(v, 3);
    const strip = ["useChasePropulsion", "chasePropulsionActivateDistanceMeters",
      "chasePropulsionDeactivateDistanceMeters", "movementMode", "orbitDistanceMeters", "followRangeMeters"];
    assert.deepStrictEqual([...liveProfiles.CAPITAL_COMBAT_STRIP], strip);
    for (const targetMode of ["manual", "vendor"]) {
      v.calls.length = 0;
      assert.deepStrictEqual(v.seam.engage(SYSTEM, [a1, a2], [b1], { targetMode, capitalIds: new Set([a2]) }),
        { ok: true });
      const set = new Map(v.calls.filter((c) => c[0] === "setBehaviorOverrides").map((c) => [c[1], c[2]]));
      const base = targetMode === "manual" ? liveProfiles.COMBAT_BEHAVIOR_MANUAL : liveProfiles.COMBAT_BEHAVIOR;
      for (const id of [a1, b1]) {
        for (const key of strip) assert.strictEqual(set.get(id)[key], base[key], `${targetMode} subcap ${key}`);
      }
      for (const key of strip) assert.ok(!Object.prototype.hasOwnProperty.call(set.get(a2), key), `capital ${key}`);
      for (const id of [a1, a2, b1]) {
        assert.ok(!Object.prototype.hasOwnProperty.call(set.get(id), "leashRangeMeters"), `leash ${id}`);
      }
      assert.deepStrictEqual([set.get(a2).autoAggro, set.get(a2).targetPreference, set.get(a2).aggressionRangeMeters],
        [true, base.targetPreference, base.aggressionRangeMeters]);
      assert.deepStrictEqual(v.calls.filter((c) => c[0] === "issueManualOrder").map((c) => [c[1], c[2].targetID]),
        [[a1, b1], [a2, b1], [b1, a1]]);
    }
    assert.deepStrictEqual(v.seam.engage(SYSTEM, [a1], [b1], { capitalIds: [a1] }),
      { ok: false, reason: "INVALID_INPUT", detail: "capitalIds" });
    assert.strictEqual(v.seam.despawn(SYSTEM, [a1, a2, b1]).ok, true);
  });

  test("AV4-T6: engage attackersOnly -> overrides, attack orders and wakes only for sideA "
    + "(targets from sideB, i % n); a non-boolean attackersOnly -> INVALID_INPUT, nothing called", () => {
    const v = makeVendor();
    const [a1, a2, b1] = spawnN(v, 3);
    v.calls.length = 0;
    assert.deepStrictEqual(v.seam.engage(SYSTEM, [a1, a2], [b1], { attackersOnly: true }), { ok: true });
    const touched = (name) => v.calls.filter((c) => c[0] === name).map((c) => c[1]);
    assert.deepStrictEqual({ set: touched("setBehaviorOverrides"), wake: touched("wakeNpcController"),
      orders: v.calls.filter((c) => c[0] === "issueManualOrder").map((c) => [c[1], c[2].targetID]) },
    { set: [a1, a2], wake: [a1, a2], orders: [[a1, b1], [a2, b1]] });
    v.calls.length = 0;
    assert.deepStrictEqual(v.seam.engage(SYSTEM, [a1], [b1], { attackersOnly: "yes" }),
      { ok: false, reason: "INVALID_INPUT", detail: "attackersOnly" });
    assert.strictEqual(v.calls.length, 0);
    assert.strictEqual(v.seam.despawn(SYSTEM, [a1, a2, b1]).ok, true);
  });

  test("AS4 vendor facts, DRIFT probe of materialization, adapter surface", () => {
    const native = readSource("space/npc/nativeNpcService.js");
    const npcService = readSource("space/npc/npcService.js");
    const hulls = readSource("space/npc/pirateHullProfiles.js");
    const loop = readSource("space/npc/npcBehaviorLoop.js");
    const exported = (source, names, file) => {
      const block = exportBlock(source);
      for (const n of names) assert.match(block, new RegExp(`^ {2}${n},$`, "m"), `${file} exports ${n}`);
    };
    exported(native, ["spawnNativeNpcEntityInSystem"], "nativeNpcService");
    exported(hulls, ["resolveFactionHullProfileID"], "pirateHullProfiles");
    exported(npcService, ["setBehaviorOverrides", "issueManualOrder", "wakeNpcController", "noteNpcIncomingAggression",
      "destroyNpcControllerByEntityID", "getControllerByEntityID", "spawnNpcGroupInSystem"], "npcService");

    assert.match(functionBody(npcService, "shouldUseRuntimeOnlyNpcSpawn"),
      /options\.transient === false\) \{\n\s*return false;\n\s*\}\n\s*return true;\n\}/);
    const friendly = functionBody(loop, "isFriendlyCombatTarget");
    assert.ok(friendly.includes("allowFriendlyNpcTargets === true"));
    assert.ok(friendly.includes("sourceOperatorKind === targetOperatorKind"));
    const inContext = functionBody(native, "spawnNativeNpcEntityInContext");
    assert.ok(inContext.includes("options.operatorKind") && inContext.includes("options.transient"));
    assert.ok(functionBody(native, "spawnNativeNpcEntityInSystem").includes("...options,"), "options passed through");
    assert.ok(native.includes("broadcast: warpLanding ? false : options.broadcast !== false"), "broadcast:false honoured");
    assert.ok(native.includes("const warpLanding = options.warpIn === true ?"), "warpLanding only with warpIn:true");
    const autoClasses = functionBody(loop, "resolveAutoAggroTargetClasses");
    assert.ok(autoClasses.includes("Object.prototype.hasOwnProperty.call(behaviorProfile, \"autoAggroTargetClasses\")"));
    assert.ok(autoClasses.indexOf("hasOwnProperty") < autoClasses.indexOf("targetPreference"));
    assert.match(functionBody(loop, "resolveBehaviorTarget"), new RegExp("resolveAutoAggroTargetClasses\\("
      + "behaviorProfile\\);\\n\\s*if \\(autoAggroTargetClasses\\.length === 0\\) \\{\\n\\s*return null;"));
    const desired = functionBody(loop, "resolveDesiredTarget");
    const attackAt = desired.indexOf("manualOrder.type === \"attack\"");
    assert.ok(attackAt > 0 && attackAt < desired.indexOf("resolveBehaviorTarget("), "attack order first");
    assert.ok(desired.includes("controller.manualOrder = null;"), "a dead target clears the order");
    const normalize = functionBody(loop, "normalizeBehaviorOverrides");
    assert.ok(normalize.includes("overrides.autoAggroTargetClasses !== undefined"));
    assert.ok(normalize.includes("\"allowTargetSwitching\","));
    assert.match(functionBody(loop, "resolveNpcTargetSwitchPolicy"),
      /explicit && behaviorProfile\.allowTargetSwitching === true/);
    assert.match(readSource("space/runtime/scene/presentation.js"), /^broadcastAddBalls\(/m);
    assert.match(readSource("space/runtime/scene/dynamicEntities.js"), /^getEntityByID\(/m);
    const dormant = functionBody(readSource("space/npc/npcCombatDormancy.js"), "isCombatDormantControllerRecord");
    assert.ok(dormant.includes("runtimeKind === \"nativeCombat\""));
    assert.ok(dormant.includes("(startupRuleID !== \"\" || operatorKind !== \"\")"));
    assert.ok(readSource("space/runtime/scene/tick.js").includes("syncRelevantStartupControllersForScene(this"));
    const pools = hulls.slice(hulls.indexOf("STANDARD_POOL_QUERY_BY_FACTION = "));
    const poolBlock = pools.slice(0, pools.indexOf("});"));
    for (const key of Object.values(liveProfiles.PIRATE_KEY_BY_FACTION_ID)) {
      assert.match(poolBlock, new RegExp(`^\\s+${key}:`, "m"), key);
    }

    const consumersOf = (p, name) => {
      const entry = GAME_MODULES.find((e) => e.path === p && e.symbols.some((s) => s.name === name));
      assert.ok(entry, `${p}.${name}`);
      return [...entry.symbols.find((s) => s.name === name).consumers];
    };
    for (const [key, fns] of Object.entries(ns.REQUIRED_FUNCTIONS)) {
      for (const fn of fns) assert.ok(consumersOf(ns.MODULE_PATHS[key], fn).includes(MAT), `${key}.${fn}`);
    }
    assert.ok(consumersOf("space/runtime", "scenes").includes(MAT));
    assert.deepStrictEqual(consumersOf("space/runtime", "isSolarSystemSceneLoaded"),
      ["salvageAnomaly", MAT, "sentries", "sentryFaction", "ambientRats", "heavyEvents", "highsecTraffic",
        "shipAiWing", "officerSpawns", "bounty", "trigBridge", "situations", "fameConcord"]);
    for (const [p, name] of [["space/runtime", "ensureScene"], ["space/runtime", "warpDynamicEntityToPoint"],
      ["space/npc/npcService", "spawnNpcGroupInSystem"],
      ["space/npc/npcService", "noteNpcIncomingAggression"],
      ["space/npc/nativeNpcStore", "listNativeControllers"]]) {
      assert.deepStrictEqual(consumersOf(p, name), [], `${p}.${name}`);
    }
    assert.deepStrictEqual(consumersOf("space/npc/nativeNpcStore", "allocateEntityID"), ["capsuleFx"]);
    assert.deepStrictEqual(consumersOf("space/npc/nativeNpcStore", "getNativeEntity"),
      ["highsecTraffic", "convoyCargo", "bounty"]);
    assert.deepStrictEqual(consumersOf("space/npc/nativeNpcStore", "upsertNativeEntity"), ["highsecTraffic"]);
    for (const e of GAME_MODULES) {
      for (const s of e.symbols) {
        if (!s.consumers.includes(MAT) || e.path === "space/combat/killmailTracker") continue;
        assert.ok(s.wrap !== true && s.firstLoad !== true, `${e.path}.${s.name}`);
      }
    }

    const entry = GAME_MODULES.find((e) => e.path === "space/npc/nativeNpcService");
    const report = probeModules([entry],
      { load: () => ({ ok: true, exports: { spawnNativeDefinitionsInContext() {} } }) });
    assert.strictEqual(report.modules[0].status, "DRIFT");
    assert.deepStrictEqual(report.modules[0].missing, ["spawnNativeNpcEntityInSystem"]);
    assert.strictEqual(report.disabledModules[MAT], "drift:space/npc/nativeNpcService.spawnNativeNpcEntityInSystem");
    assert.ok(!Object.prototype.hasOwnProperty.call(report.disabledModules, "empireBelts"));

    const blind = createAdapter({ moduleApi: { _cache: {} } });
    const seam = blind.getNpcSpawn();
    assert.strictEqual(blind.getNpcSpawn(), seam);
    assert.deepStrictEqual(Object.keys(seam), [...ns.SEAM_METHODS]);
    assert.strictEqual(ns.SEAM_METHODS.length, 16, "orderAttack, listAlive: the entity read of gone; "
      + "fleet colors: + setRelation; grid: + pickGridAnchor; + seedCargo; "
      + "markConvoyShips, forgetConvoyShips: + admitScene");
    const check = blind.checkNpcSpawn();
    assert.strictEqual(check.ok, false);
    assert.strictEqual(check.reason, "SEAM_UNAVAILABLE");
    assert.deepStrictEqual(check.missing, Object.values(ns.MODULE_PATHS));
    assert.strictEqual(seam.isSceneLoaded(SYSTEM), false);
    assert.strictEqual(seam.spawnShip(SYSTEM, { profileId: "x", anchorDescriptor: {} }).reason, "SEAM_UNAVAILABLE");
    assert.strictEqual(seam.countAlive(SYSTEM, [1]), 0);
    assert.deepStrictEqual(ns.checkNpcSpawnFrom(makeVendor().requireGame), { ok: true });
  });

  test("DG3: spawnShip protects (not keepMaterialized), despawn purges the "
    + "store record after NPC_NOT_FOUND and releases; a throwing store never fails the despawn", () => {
    const guard = require("../../lib/adapter/dormancyGuard");
    const anchor = { kind: "stargate", itemID: 1 };
    const v = makeVendor();
    const [battleId] = spawnN(v, 1);
    assert.strictEqual(guard.isProtected(battleId), true);
    const hunter = v.seam.spawnShip(SYSTEM, { profileId: "p", anchorDescriptor: anchor, keepMaterialized: true });
    assert.strictEqual(hunter.ok, true);
    assert.strictEqual(guard.isProtected(hunter.entityId), false, "keepMaterialized: not dormancy eligible");

    const cascades = [];
    const records = new Set([battleId]);
    const store = {
      getNativeController: (id) => (records.has(id) ? { entityID: id } : null),
      removeNativeEntityCascade(id) { cascades.push(id); records.delete(id); return { success: true, data: {} }; },
    };
    const withStore = (rel) => (rel === "space/npc/nativeNpcStore" ? { ok: true, exports: store } : v.requireGame(rel));
    const seam = ns.createNpcSpawn({ requireGame: withStore, navyProfiles: NAVY_PROFILES_BY_FACTION_ID,
      data: liveProfiles });
    v.npc.destroyNpcControllerByEntityID = (id) => ({ success: false, errorMsg: "NPC_NOT_FOUND", id });
    assert.deepStrictEqual(seam.despawn(SYSTEM, [battleId]), { ok: true, removed: 0, missing: 1, purged: 1 });
    assert.deepStrictEqual(cascades, [battleId]);
    assert.strictEqual(guard.isProtected(battleId), false);
    assert.deepStrictEqual(seam.despawn(SYSTEM, [battleId]), { ok: true, removed: 0, missing: 1, purged: 0 },
      "idempotent: no record left");
    assert.deepStrictEqual(cascades, [battleId]);

    const [other] = spawnN(v, 1);
    const throwing = (rel) => (rel === "space/npc/nativeNpcStore"
      ? { ok: true, exports: { getNativeController: () => { throw new Error("store down"); },
        removeNativeEntityCascade: () => ({ success: true }) } } : v.requireGame(rel));
    const seam2 = ns.createNpcSpawn({ requireGame: throwing, navyProfiles: NAVY_PROFILES_BY_FACTION_ID,
      data: liveProfiles });
    assert.deepStrictEqual(seam2.despawn(SYSTEM, [other]),
      { ok: true, removed: 0, missing: 1, purged: 0, purgeFailed: "store down" });
    assert.strictEqual(guard.isProtected(other), false);
    assert.deepStrictEqual(ns.checkNpcSpawnFrom(v.requireGame), { ok: true }, "the store is not a required module");
    guard.release(hunter.entityId);
  });

  test("LM3 capsuleer profiles through createAdapter, spawnShip ownerId -> ownerIDOverride", () => {
    const seam = createAdapter({ moduleApi: { _cache: {} } }).getNpcSpawn();
    const groups = ["frigate", "tackle", "destroyer", "cruiser", "logistics", "battlecruiser", "battleship", "capital"];
    const resolved = seam.resolveProfiles(groups.map((g, i) => ({ memberKey: `k${i}`, factionId: 500018,
      hullGroup: g })), { seedPrefix: "b" });
    const P = CAPSULEER_LIVE_PROFILES[500018];
    assert.deepStrictEqual(resolved, { ok: true, profiles: [P.frigate, P.frigate, P.destroyer, P.cruiser, P.cruiser,
      P.battlecruiser, P.battleship, P.battleship] });

    const v = makeVendor();
    const base = { profileId: P.frigate, anchorDescriptor: { kind: "stargate", itemID: 50000100 },
      spawnDistanceMeters: 20000 };
    const optsOf = () => {
      const spawns = v.calls.filter((c) => c[0] === "spawnNativeNpcEntityInSystem");
      return spawns[spawns.length - 1][2];
    };
    const seen = [];
    assert.strictEqual(v.seam.spawnShip(SYSTEM, { ...base, ownerId: 98000001 }).ok, true);
    seen.push(["owner", optsOf().ownerIDOverride]);
    assert.strictEqual(v.seam.spawnShip(SYSTEM, base).ok, true);
    seen.push(["absent", "ownerIDOverride" in optsOf()]);
    assert.strictEqual(v.seam.spawnShip(SYSTEM, { ...base, ownerId: null }).ok, true);
    seen.push(["null", "ownerIDOverride" in optsOf()]);
    const before = v.calls.filter((c) => c[0] === "spawnNativeNpcEntityInSystem").length;
    for (const bad of [0, -1, 1.5, "98000001"]) {
      seen.push([`bad ${JSON.stringify(bad)}`, v.seam.spawnShip(SYSTEM, { ...base, ownerId: bad })]);
    }
    seen.push(["vendor calls after bad", v.calls.filter((c) => c[0] === "spawnNativeNpcEntityInSystem").length
      - before]);
    const invalid = { ok: false, reason: "INVALID_INPUT" };
    assert.deepStrictEqual(seen, [["owner", 98000001], ["absent", false], ["null", false], ["bad 0", invalid],
      ["bad -1", invalid], ["bad 1.5", invalid], ["bad \"98000001\"", invalid], ["vendor calls after bad", 0]]);
  });

  test("GA4 grid pickGridAnchor: entity of the loaded scene -> {kind:\"entity\", itemID} "
    + "radius; unknown / cold scene / bad kind / bad input / throw -> structural refusal", () => {
    const v = makeVendor();
    v.entities.set(50000002, { itemID: 50000002, radius: 2500 });
    v.entities.set(60000003, { itemID: 60000003, radius: Number.NaN });
    v.entities.set(40000004, { itemID: 40000004 });
    const gate = { kind: "gate", id: 50000002 };
    const got = {
      gate: v.seam.pickGridAnchor(SYSTEM, gate),
      nanRadius: v.seam.pickGridAnchor(SYSTEM, { kind: "station", id: 60000003 }),
      noRadius: v.seam.pickGridAnchor(SYSTEM, { kind: "belt", id: 40000004 }),
      unknown: v.seam.pickGridAnchor(SYSTEM, { kind: "structure", id: 1030000000001 }),
      cold: makeVendor({ sceneLoaded: false }).seam.pickGridAnchor(SYSTEM, gate),
      system: v.seam.pickGridAnchor(SYSTEM, { kind: "system", id: 50000002 }),
      beacon: v.seam.pickGridAnchor(SYSTEM, { kind: "beacon", id: 50000002 }),
      badId: [0, -1, 1.5, "50000002", null].map((id) => v.seam.pickGridAnchor(SYSTEM, { kind: "gate", id }).reason),
      badSystem: [0, "30000142", null].map((s) => v.seam.pickGridAnchor(s, gate).reason),
      badGrid: [null, undefined, "gate", { id: 50000002 }].map((g) => v.seam.pickGridAnchor(SYSTEM, g).reason),
    };
    assert.deepStrictEqual(got, {
      gate: { ok: true, anchorDescriptor: { kind: "entity", itemID: 50000002 }, radiusMeters: 2500 },
      nanRadius: { ok: true, anchorDescriptor: { kind: "entity", itemID: 60000003 }, radiusMeters: 0 },
      noRadius: { ok: true, anchorDescriptor: { kind: "entity", itemID: 40000004 }, radiusMeters: 0 },
      unknown: { ok: false, reason: "GRID_ANCHOR_UNKNOWN" },
      cold: { ok: false, reason: "SCENE_NOT_LOADED" },
      system: { ok: false, reason: "GRID_KIND_UNSUPPORTED" },
      beacon: { ok: false, reason: "GRID_KIND_UNSUPPORTED" },
      badId: Array(5).fill("INVALID_INPUT"),
      badSystem: Array(3).fill("INVALID_INPUT"),
      badGrid: Array(4).fill("INVALID_INPUT"),
    });
    assert.ok(!v.calls.some((c) => c[0] === "ensureScene" || c[0] === "spawnNativeNpcEntityInSystem"));
    v.scene.getEntityByID = () => { throw new Error("boom"); };
    assert.deepStrictEqual(v.seam.pickGridAnchor(SYSTEM, gate), { ok: false, reason: "GRID_ANCHOR_UNKNOWN",
      detail: "boom" });
    const bare = makeVendor();
    bare.runtime.scenes.set(SYSTEM, {});
    assert.deepStrictEqual(bare.seam.pickGridAnchor(SYSTEM, gate), { ok: false, reason: "SCENE_NOT_LOADED" });
    const blind = ns.createNpcSpawn({ requireGame: () => ({ ok: false }), navyProfiles: {}, data: liveProfiles });
    assert.strictEqual(blind.pickGridAnchor(SYSTEM, gate).reason, "SEAM_UNAVAILABLE");
  });

  test("GA5 grid vendor facts: anchor kind \"entity\" resolves through scene.getEntityByID (static "
    + "dynamic), explicit spawn distance skips the anchor radius, scene entity itemIDs", () => {
    const anchors = readSource("space/npc/npcAnchors.js");
    assert.ok(anchors.includes("normalizedKind === \"entity\" ||"), "npcAnchors entity kind");
    assert.ok(anchors.includes("const entity = scene.getEntityByID(numericEntityID);"), "npcAnchors getEntityByID");
    assert.ok(functionBody(anchors, "resolveSpawnDistance").includes("if (explicitSpawnDistance > 0) {"),
      "explicit spawnDistanceMeters wins over the anchor radius");
    assert.ok(readSource("space/runtime/scene/dynamicEntities.js").includes("this.staticEntitiesByID.get(entityKey) ||"),
      "getEntityByID covers static entities");
    const statics = readSource("space/runtime/staticSceneEntity.js");
    for (const fact of ["itemID: station.stationID", "itemID: structure.structureID", "itemID: stargate.itemID",
      "itemID: asteroidBelt.itemID", "itemID: celestial.itemID", "const INCLUDE_STARGATES_IN_SCENE = true;"]) {
      assert.ok(statics.includes(fact), `staticSceneEntity: ${fact}`);
    }
    const { KIND_ORDER } = require("../../lib/adapter/gridAnchors");
    assert.deepStrictEqual(Object.keys(KIND_ORDER), ["gate", "station", "structure", "pos", "sun", "belt"]);
  });

  test("CC1 seedCargo: record and options as homefrontWorld (transient) "
    + "INVALID_INPUT, STORE_UNAVAILABLE, NO_STORE_RECORD, a failed second write keeps written; GAME_MODULES consumers",
  () => {
    const v = makeVendor();
    const writes = [];
    let nextCargo = 501;
    let failAt = 0;
    const store = {
      getNativeEntity: (id) => (id === 9000001 ? { entityID: id, ownerID: 1000125, transient: true } : null),
      allocateCargoID(options) { writes.push(["allocateCargoID", { ...options }]); nextCargo += 1; return { success: true, data: nextCargo - 1 }; },
      upsertNativeCargo(record, options) {
        writes.push(["upsertNativeCargo", { ...record }, { ...options }]);
        return failAt > 0 && writes.filter((w) => w[0] === "upsertNativeCargo").length === failAt
          ? { success: false, errorMsg: "WRITE_ERROR" } : { success: true, data: record };
      },
    };
    const registry = { resolveItemByTypeID: (id) => (id === 34 || id === 35
      ? { typeID: id, groupID: 18, categoryID: 4, name: id === 34 ? "Tritanium" : "Pyerite" } : null) };
    const withStore = (on) => (rel) => {
      if (on && rel === "space/npc/nativeNpcStore") return { ok: true, exports: store };
      if (on && rel === "services/inventory/itemTypeRegistry") return { ok: true, exports: registry };
      return v.requireGame(rel);
    };
    const seamOf = (on) => ns.createNpcSpawn({ requireGame: withStore(on), navyProfiles: NAVY_PROFILES_BY_FACTION_ID,
      data: liveProfiles });
    const seam = seamOf(true);
    const items = [{ typeId: 34, quantity: 250000 }, { typeId: 35, quantity: 50000 }];
    assert.deepStrictEqual(seam.seedCargo(9000001, items), { ok: true, written: 2 });
    assert.deepStrictEqual(writes.slice(0, 2), [["allocateCargoID", { transient: true }], ["upsertNativeCargo",
      { cargoID: 501, entityID: 9000001, ownerID: 1000125, moduleID: 0, typeID: 34, groupID: 18, categoryID: 4,
        itemName: "Tritanium", quantity: 250000, singleton: 0, transient: true }, { transient: true }]]);
    for (const bad of [[], [{ typeId: 34, quantity: 0 }], null, new Array(9).fill({ typeId: 34, quantity: 1 })]) {
      assert.deepStrictEqual(seam.seedCargo(9000001, bad), { ok: false, reason: "INVALID_INPUT", written: 0 });
    }
    assert.strictEqual(seam.seedCargo(0, items).reason, "INVALID_INPUT");
    assert.deepStrictEqual(seamOf(false).seedCargo(9000001, items), { ok: false, reason: "STORE_UNAVAILABLE", written: 0 });
    assert.deepStrictEqual(seam.seedCargo(9000002, items), { ok: false, reason: "NO_STORE_RECORD", written: 0 });
    assert.deepStrictEqual(seam.seedCargo(9000001, [{ typeId: 99, quantity: 1 }]),
      { ok: false, reason: "UNKNOWN_TYPE", detail: "99", written: 0 });
    writes.length = 0;
    failAt = 2;
    assert.deepStrictEqual(seam.seedCargo(9000001, items),
      { ok: false, reason: "WRITE_FAILED", detail: "WRITE_ERROR", written: 1 });
    store.allocateCargoID = () => { throw new Error("boom"); };
    assert.deepStrictEqual(seam.seedCargo(9000001, items), { ok: false, reason: "WRITE_FAILED", detail: "boom",
      written: 0 }, "never throws");

    const symOf = (p, name) => GAME_MODULES.find((e) => e.path === p).symbols.find((s) => s.name === name);
    for (const [p, name] of [["space/npc/nativeNpcStore", "allocateCargoID"], ["space/npc/nativeNpcStore",
      "upsertNativeCargo"], ["space/npc/nativeNpcStore", "getNativeEntity"],
    ["services/inventory/itemTypeRegistry", "resolveItemByTypeID"]]) {
      const s = symOf(p, name);
      assert.ok(s.consumers.includes("convoyCargo") && s.wrap !== true && s.firstLoad !== true, `${p}.${name}`);
    }
    assert.ok(!require("../../config").MODULE_NAMES.includes("convoyCargo"));
  });

  test("CC2 vendor facts: the native wreck takes the hold (buildNativeCargoItems, sourceKind "
    + "cargo), the despawn cascade removes it, allocateCargoID / upsertNativeCargo exported", () => {
    const wreck = functionBody(readSource("space/npc/nativeNpcWreckService.js"), "prepareNativeNpcWreckItems");
    assert.ok(wreck.includes("nativeNpcStore.buildNativeCargoItems(entityID)"), "wreck reads the cargo hold");
    assert.ok(wreck.includes("sourceKind: \"cargo\""), "cargo items go to the wreck");
    const storeSrc = readSource("space/npc/nativeNpcStore.js");
    assert.ok(functionBody(storeSrc, "removeNativeEntityCascade").includes("removeNativeCargo(cargoRecord.cargoID)"),
      "the despawn cascade removes the hold");
    assert.ok(functionBody(storeSrc, "buildNativeCargoItems").includes("flagID: toPositiveInt(cargoRecord && "
      + "cargoRecord.flagID, 5)"), "cargo flag 5 by default");
    const exported = exportBlock(storeSrc);
    for (const name of ["allocateCargoID", "upsertNativeCargo", "getNativeEntity"]) {
      assert.match(exported, new RegExp(`^ {2}${name},$`, "m"), name);
    }
    assert.match(functionBody(storeSrc, "allocateCargoID"), /return allocateID\(TABLE\.CARGO, "nextCargoID", options\);/);
    assert.ok(functionBody(readSource("space/npc/nativeNpcService.js"), "destroyNativeNpcController")
      .includes("nativeNpcStore.removeNativeEntityCascade(entityID)"), "destroyNativeNpcController ends in the cascade");
  });
};
