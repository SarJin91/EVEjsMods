"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const hs = require("../../lib/adapter/huntScene");
const ns = require("../../lib/adapter/npcSpawn");
const liveProfiles = require("../../lib/adapter/data/liveProfiles");
const { NAVY_PROFILES_BY_FACTION_ID } = require("../../lib/adapter/empireNavyCatalog");
const { GAME_MODULES } = require("../../lib/adapter/gameModules");
const { probeModules, formatProbeLog } = require("../../lib/adapter/probe");
const { createAdapter } = require("../../lib/adapter");
const { MODULE_NAMES } = require("../../config");

const SERVER_SRC = path.resolve(__dirname, "..", "..", "..", "..", "server", "src");
const MOD_DIR = path.resolve(__dirname, "..", "..");
const SYSTEM = 30000142;
const VENDOR_CALLS = ["warpToPoint", "setBehaviorOverrides", "issueManualOrder", "wakeNpcController",
  "getShipEntityForSession", "sessions.values", "scenes.get", "ensureScene", "getControllerByEntityID"];

function readSource(rel) {
  return fs.readFileSync(path.join(SERVER_SRC, rel), "utf8").replace(/\r\n/g, "\n");
}

function* listJs(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* listJs(p);
    else if (e.name.endsWith(".js")) yield p;
  }
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

const pos = (x) => ({ x, y: 0, z: 0 });

function makeVendor({ sceneLoaded = true } = {}) {
  const calls = [];
  const entities = new Map();
  const shipBySession = new Map();
  const sessions = new Map();
  const present = new Set([7001, 7002, 7003, 7004, 1001, 1003]);
  const controllers = new Map();
  const scene = {
    sessions: { values() { calls.push(["sessions.values"]); return sessions.values(); } },
    getEntityByID(id) { return entities.get(id) || (present.has(id) ? { itemID: id } : null); },
    getShipEntityForSession(session) {
      calls.push(["getShipEntityForSession", session.clientID]);
      return shipBySession.get(session.clientID) || null;
    },
  };
  Object.setPrototypeOf(scene.sessions, Map.prototype);
  const scenes = new Map(sceneLoaded ? [[SYSTEM, scene]] : []);
  const realGet = scenes.get.bind(scenes);
  scenes.get = (id) => { calls.push(["scenes.get", id]); return realGet(id); };
  const runtime = Object.create({
    isSolarSystemSceneLoaded(id) { calls.push(["isSolarSystemSceneLoaded", id]); return scenes.has(id); },
    ensureScene(id) { calls.push(["ensureScene", id]); return scene; },
  });
  runtime.scenes = scenes;
  const refuse = new Map();
  const result = (name, id) => (refuse.get(`${name}:${id}`) || { success: true, data: {} });
  const vendor = {
    calls, entities, shipBySession, sessions, refuse, present, controllers,
    worldData: {
      getStargatesForSystem: () => [{ itemID: 50000002, position: pos(2) }, { itemID: 50000009, position: pos(9) }],
      getStationsForSystem: () => [{ stationID: 60000001, position: pos(1) }, { stationID: 60000003 }],
      getAsteroidBeltsForSystem: () => [{ itemID: 40000005, position: pos(5) }],
      getCelestialsForSystem: () => [{ itemID: 40000001, groupID: 6, position: pos(0) },
        { itemID: 40000002, groupID: 7, position: pos(7) }, { itemID: 40000003, groupID: 8, position: pos(8) },
        { itemID: 40000004, groupID: 7, position: { x: 1, y: "nope", z: 2 } }],
    },
    npc: {
      setBehaviorOverrides(id, o) { calls.push(["setBehaviorOverrides", id, o]); return result("set", id); },
      issueManualOrder(id, o) { calls.push(["issueManualOrder", id, o]); return result("order", id); },
      wakeNpcController(id, w) { calls.push(["wakeNpcController", id, w]); return result("wake", id); },
      getControllerByEntityID(id) { calls.push(["getControllerByEntityID", id]); return controllers.get(id) || null; },
    },
    npcRuntime: {
      warpToPoint(id, point, options) { calls.push(["warpToPoint", id, point, options]); return result("warp", id); },
    },
  };
  const byPath = {
    [hs.MODULE_PATHS.runtime]: runtime,
    [hs.MODULE_PATHS.worldData]: vendor.worldData,
    [hs.MODULE_PATHS.npc]: vendor.npc,
    [hs.MODULE_PATHS.npcRuntime]: vendor.npcRuntime,
  };
  vendor.byPath = byPath;
  vendor.requireGame = (rel) => (byPath[rel] ? { ok: true, exports: byPath[rel] } : { ok: false, reason: "file_not_found" });
  vendor.seam = hs.createHuntScene({ requireGame: vendor.requireGame, data: liveProfiles });
  vendor.vendorCalls = () => calls.filter((c) => VENDOR_CALLS.includes(c[0]));
  return vendor;
}

module.exports = ({ test }) => {
  test("HS1 listSystemObjects (kind order, planet = group 7, no position skipped) and readPlayerShips", () => {
    const v = makeVendor();
    const listed = v.seam.listSystemObjects(SYSTEM, ["planet", "stargate", "station", "asteroidBelt"]);
    assert.deepStrictEqual(listed, { ok: true, objects: [
      { kind: "planet", itemId: 40000002, position: pos(7) },
      { kind: "stargate", itemId: 50000002, position: pos(2) },
      { kind: "stargate", itemId: 50000009, position: pos(9) },
      { kind: "station", itemId: 60000001, position: pos(1) },
      { kind: "asteroidBelt", itemId: 40000005, position: pos(5) },
    ] });
    assert.deepStrictEqual(v.seam.listSystemObjects(SYSTEM, ["moon"]), { ok: false, reason: "INVALID_INPUT" });
    assert.deepStrictEqual(v.seam.listSystemObjects(SYSTEM, []), { ok: true, objects: [] });
    assert.strictEqual(makeVendor({ sceneLoaded: false }).seam.listSystemObjects(SYSTEM, ["stargate"]).objects.length,
      2);

    const session = (clientID, extra) => ({ clientID, characterID: 90000000 + clientID, _space: { shipID: clientID },
      ...extra });
    v.sessions.set(1, session(1));
    v.sessions.set(2, session(2, { stationid: 60000001 }));
    v.sessions.set(3, session(3));
    v.sessions.set(4, session(4));
    v.sessions.set(5, { clientID: 5, charid: 90000005, _space: { shipID: 5 } });
    v.sessions.set(6, session(6));
    v.shipBySession.set(1, { itemID: 1001, position: pos(10), signatureRadius: 125, groupID: 25 });
    v.shipBySession.set(2, { itemID: 1002, position: pos(20), groupID: 25 });
    v.shipBySession.set(3, { itemID: 1003, position: pos(30), mode: "WARP", effectStamp: 12,
      cloakState: { state: "Active" }, groupID: 25 });
    v.shipBySession.set(4, { itemID: 1004, position: pos(40), signatureRadius: 0, groupID: 29, pendingWarp: {} });
    v.shipBySession.set(5, { itemID: 1005, position: pos(50), isCloaked: 1, groupID: 25 });
    const read = v.seam.readPlayerShips(SYSTEM);
    assert.deepStrictEqual(read, { ok: true, ships: [
      { characterId: 90000001, entityId: 1001, position: pos(10), signatureRadius: 125, inWarp: false,
        aligning: false, cloaked: false, jumpCloaked: false, capsule:false, typeId: null, groupId: 25,
        warpTarget: null, warpTargetEntityId: null },
      { characterId: 90000003, entityId: 1003, position: pos(30), signatureRadius: null, inWarp: true,
        aligning: false, cloaked: true, jumpCloaked: false, capsule:false, typeId: null, groupId: 25,
        warpTarget: null, warpTargetEntityId: null },
      { characterId: 90000004, entityId: 1004, position: pos(40), signatureRadius: null, inWarp: false,
        aligning: false, cloaked: false, jumpCloaked: false, capsule:true, typeId: null, groupId: 29,
        warpTarget: null, warpTargetEntityId: null },
      { characterId: 90000005, entityId: 1005, position: pos(50), signatureRadius: null, inWarp: false,
        aligning: false, cloaked: true, jumpCloaked: false, capsule:false, typeId: null, groupId: 25,
        warpTarget: null, warpTargetEntityId: null },
    ] });
    assert.ok(!v.calls.some((c) => c[0] === "getShipEntityForSession" && c[1] === 2), "docked: no entity read");

    v.entities.set(7001, { itemID: 7001, position: pos(1), warpState: { a: 1 } });
    v.entities.set(7002, { itemID: 7002, position: pos(2) });
    assert.deepStrictEqual(v.seam.readShips(SYSTEM, [7002, 7999, 7001]), { ok: true, ships: [
      { entityId: 7002, position: pos(2), inWarp: false }, { entityId: 7001, position: pos(1), inWarp: true }] });
    assert.deepStrictEqual(makeVendor({ sceneLoaded: false }).seam.readShips(SYSTEM, [7001]), { ok: true, ships: [] });
  });

  test("PHA1 a player in align (mode WARP, effectStamp < 0) is no warp "
    + "(aligning true), active warp (effectStamp >= 0) is; readShips keeps align as warp; readAggressors in align "
    + "-> aggressorInWarp false; vendor facts warpPhase / evolve.warpTo", () => {
    const v = makeVendor();
    const session = (clientID) => ({ clientID, characterID: 90000000 + clientID, _space: { shipID: clientID } });
    for (const id of [1, 2, 3]) v.sessions.set(id, session(id));
    v.shipBySession.set(1, { itemID: 1001, position: pos(1), mode: "WARP", effectStamp: -3, groupID: 25 });
    v.shipBySession.set(2, { itemID: 1002, position: pos(2), mode: "WARP", effectStamp: 7, groupID: 25 });
    v.shipBySession.set(3, { itemID: 1003, position: pos(3), mode: "GOTO", effectStamp: -1, groupID: 25 });
    const flags = v.seam.readPlayerShips(SYSTEM).ships.map((s) => [s.entityId, s.inWarp, s.aligning]);
    assert.deepStrictEqual(flags, [[1001, false, true], [1002, true, false], [1003, false, false]]);
    v.entities.set(7001, { itemID: 7001, position: pos(4), mode: "WARP", effectStamp: -1 });
    assert.strictEqual(v.seam.readShips(SYSTEM, [7001]).ships[0].inWarp, true, "own ships: align = warp");
    v.entities.set(9001, { itemID: 9001, session: { characterID: 90000009 }, position: pos(5), mode: "WARP",
      effectStamp: -1 });
    v.controllers.set(7001, { lastAggressorID: 9001 });
    assert.strictEqual(v.seam.readAggressors(SYSTEM, [7001]).aggressors[0].aggressorInWarp, false);
    const phase = readSource("space/destiny/simulation/warpPhase.js");
    const active = functionBody(phase, "isEntityInActiveWarp");
    assert.ok(active.includes("=== \"WARP\"") && active.includes("effectStamp) >= 0"), "vendor active warp");
    const warpTo = functionBody(readSource("space/destiny/simulation/evolve.js"), "warpTo");
    const stamp = warpTo.indexOf("ball.effectStamp = -1;");
    assert.ok(stamp >= 0 && stamp < warpTo.indexOf("ball.mode = \"WARP\";"), "warpTo: effectStamp -1 before WARP");
  });

  test("HSB1 readShips vendorOrder: attack target of the controller (0 = none / other order), weapons "
    + "off only for autoActivateWeapons false, no controller = no field; vendor facts of the dropped order", () => {
    const v = makeVendor();
    for (const id of [7001, 7002, 7003, 7004]) v.entities.set(id, { itemID: id, position: pos(id) });
    v.controllers.set(7001, { manualOrder: { type: "attack", targetID: 1001, keepLock: true, allowWeapons: null },
      behaviorOverrides: {
      autoActivateWeapons: true } });
    v.controllers.set(7002, { manualOrder: null, behaviorOverrides: { ...liveProfiles.HUNT_SEARCH_BEHAVIOR } });
    v.controllers.set(7003, { manualOrder: { type: "stop", targetID: 0 } });
    const noLeash = { leashMeters: 0, homeDistanceMeters: null, beyondLeash: false };
    assert.deepStrictEqual(v.seam.readShips(SYSTEM, [7001, 7002, 7003, 7004]), { ok: true, ships: [
      { entityId: 7001, position: pos(7001), inWarp: false,
        vendorOrder: { attackTargetId: 1001, weapons: true, keepLock: true, allowWeapons: false, ...noLeash } },
      { entityId: 7002, position: pos(7002), inWarp: false,
        vendorOrder: { attackTargetId: 0, weapons: false, keepLock: false, allowWeapons: false, ...noLeash } },
      { entityId: 7003, position: pos(7003), inWarp: false,
        vendorOrder: { attackTargetId: 0, weapons: true, keepLock: false, allowWeapons: false, ...noLeash } },
      { entityId: 7004, position: pos(7004), inWarp: false }] });
    delete v.byPath[hs.MODULE_PATHS.npc];
    assert.deepStrictEqual(v.seam.readShips(SYSTEM, [7001]), { ok: true, ships: [
      { entityId: 7001, position: pos(7001), inWarp: false }] });
    const loop = readSource("space/npc/npcBehaviorLoop.js");
    const desired = functionBody(loop, "resolveDesiredTarget");
    assert.ok(desired.includes("if (!manualTarget) {\n      controller.manualOrder = null;"),
      "EveJS drops the attack order of a target not in the scene");
    assert.ok(functionBody(loop, "shouldAllowWeapons").includes("behaviorProfile.autoActivateWeapons !== false"));
    assert.strictEqual(liveProfiles.HUNT_SEARCH_BEHAVIOR.autoActivateWeapons, false);
  });

  test("HS2 scene guard: scene not loaded -> SCENE_NOT_LOADED, no vendor call", () => {
    const cold = makeVendor({ sceneLoaded: false });
    const results = [
      cold.seam.warpShips(SYSTEM, [7001, 7002], pos(1), { spreadMeters: 5000 }),
      cold.seam.setSearch(SYSTEM, [7001]),
      cold.seam.attackTargets(SYSTEM, [7001], [1001]),
      cold.seam.readPlayerShips(SYSTEM),
    ];
    for (const r of results) assert.deepStrictEqual(r, { ok: false, reason: "SCENE_NOT_LOADED" });
    assert.deepStrictEqual(cold.vendorCalls(), [], "no warp, no order, no session read, no scene loader");
    assert.strictEqual(cold.calls.filter((c) => c[0] === "isSolarSystemSceneLoaded").length, 4);
    assert.strictEqual(fs.readFileSync(path.join(MOD_DIR, "lib", "adapter", "huntScene.js"), "utf8")
      .includes("ensureScene"), false, "the seam never names the scene loader");
    const v = makeVendor();
    for (const r of [v.seam.warpShips(SYSTEM, [7001], { x: 1 }, {}), v.seam.warpShips(SYSTEM, [0], pos(1), {}),
      v.seam.warpShips(SYSTEM, [7001], pos(1), { spreadMeters: -1 }), v.seam.setSearch(0, [7001]),
      v.seam.attackTargets(SYSTEM, [7001], []), v.seam.readShips(SYSTEM, null), v.seam.readPlayerShips("x")]) {
      assert.deepStrictEqual(r, { ok: false, reason: "INVALID_INPUT" });
    }
    assert.deepStrictEqual(v.calls, []);

    v.refuse.set("order:7002", { success: false, errorMsg: "NPC_NOT_FOUND" });
    assert.deepStrictEqual(v.seam.setSearch(SYSTEM, [7001, 7002, 7003]),
      { ok: true, failed: [7002], detail: "NPC_NOT_FOUND" });
    const searchCalls = v.vendorCalls().filter((c) => c[1] === 7001);
    assert.deepStrictEqual(searchCalls, [["setBehaviorOverrides", 7001, { ...liveProfiles.HUNT_SEARCH_BEHAVIOR }],
      ["issueManualOrder", 7001, { type: "stop" }], ["wakeNpcController", 7001, 0]]);
    assert.ok(!v.calls.some((c) => c[0] === "wakeNpcController" && c[1] === 7002), "refused order: no wake");
    assert.ok(v.calls.some((c) => c[0] === "wakeNpcController" && c[1] === 7003), "the rest goes on");
    v.calls.length = 0;
    assert.deepStrictEqual(v.seam.attackTargets(SYSTEM, [7001, 7003, 7004], [1001, 1003]), { ok: true, failed: [] });
    const orders = v.calls.filter((c) => c[0] === "issueManualOrder").map((c) => [c[1], c[2]]);
    assert.deepStrictEqual(orders, [[7001, { type: "attack", targetID: 1001, allowPodKill: false }],
      [7003, { type: "attack", targetID: 1003, allowPodKill: false }],
      [7004, { type: "attack", targetID: 1001, allowPodKill: false }]]);
    for (const [, , o] of v.calls.filter((c) => c[0] === "setBehaviorOverrides")) {
      assert.deepStrictEqual(o.autoAggroTargetClasses, []);
      assert.strictEqual(o.targetPreference, "preferredTargetOnly");
      assert.strictEqual(o.autoActivateWeapons, true);
      assert.strictEqual(o.returnToHomeWhenIdle, false);
    }
  });

  test("CMN3: attackTargets with capitalIds - a capital gets the manual combat "
    + "overrides without CAPITAL_COMBAT_STRIP, a subcap the full overrides (as without the option); a non-Set -> "
    + "INVALID_INPUT capitalIds, no vendor call", () => {
    const v = makeVendor();
    const full = { ...liveProfiles.COMBAT_BEHAVIOR_MANUAL, leashRangeMeters: 0, autoAggroTargetClasses: [] };
    const stripped = { ...full };
    for (const key of liveProfiles.CAPITAL_COMBAT_STRIP) delete stripped[key];
    assert.strictEqual(Object.keys(full).length - Object.keys(stripped).length, 6);
    assert.deepStrictEqual(v.seam.attackTargets(SYSTEM, [7001, 7003], [1001], { capitalIds: new Set([7003]) }),
      { ok: true, failed: [] });
    const set = () => v.calls.filter((c) => c[0] === "setBehaviorOverrides").map((c) => [c[1], c[2]]);
    assert.deepStrictEqual(set(), [[7001, full], [7003, stripped]]);
    v.calls.length = 0;
    assert.deepStrictEqual(v.seam.attackTargets(SYSTEM, [7001, 7003], [1001]), { ok: true, failed: [] });
    assert.deepStrictEqual(set(), [[7001, full], [7003, full]], "no option: every ship the full overrides");
    v.calls.length = 0;
    assert.deepStrictEqual(v.seam.attackTargets(SYSTEM, [7003], [1001], { capitalIds: [7003] }),
      { ok: false, reason: "INVALID_INPUT", detail: "capitalIds" });
    assert.deepStrictEqual(v.calls, []);
  });

  test("LSH1: attackTargets (subcap and capital) and setSearch "
    + "send leashRangeMeters 0, the LIVE battle profiles carry no leash key; readShips reports leash, home distance "
    + "and beyondLeash; vendor facts of isBeyondLeash", () => {
    const v = makeVendor();
    assert.deepStrictEqual(v.seam.attackTargets(SYSTEM, [7001, 7003], [1001], { capitalIds: new Set([7003]) }),
      { ok: true, failed: [] });
    assert.deepStrictEqual(v.seam.setSearch(SYSTEM, [7001]), { ok: true, failed: [] });
    const sets = v.calls.filter((c) => c[0] === "setBehaviorOverrides");
    assert.strictEqual(sets.length, 3);
    for (const [, id, o] of sets) assert.strictEqual(o.leashRangeMeters, 0, `ship ${id}`);
    assert.strictEqual(liveProfiles.HUNT_SEARCH_BEHAVIOR.leashRangeMeters, 0);
    for (const name of ["COMBAT_BEHAVIOR", "COMBAT_BEHAVIOR_MANUAL", "SPAWN_BEHAVIOR"]) {
      assert.ok(!Object.prototype.hasOwnProperty.call(liveProfiles[name], "leashRangeMeters"), name);
    }
    assert.ok(!liveProfiles.CAPITAL_COMBAT_STRIP.includes("leashRangeMeters"));
    v.entities.set(7005, { itemID: 7005, position: { x: 200_000, y: 0, z: 0 } });
    v.entities.set(7006, { itemID: 7006, position: pos(3) });
    v.controllers.set(7005, { manualOrder: { type: "attack", targetID: 1001 }, behaviorOverrides: {},
      behaviorProfile: { leashRangeMeters: 150_000 }, homePosition: pos(0) });
    v.controllers.set(7006, { manualOrder: null, behaviorOverrides: { leashRangeMeters: 0 },
      behaviorProfile: { leashRangeMeters: 150_000 }, homePosition: pos(0) });
    const ships = v.seam.readShips(SYSTEM, [7005, 7006]).ships;
    assert.deepStrictEqual(ships.map((s) => s.vendorOrder), [
      { attackTargetId: 1001, weapons: true, keepLock: false, allowWeapons: false, leashMeters: 150_000,
        homeDistanceMeters: 200_000, beyondLeash: true },
      { attackTargetId: 0, weapons: true, keepLock: false, allowWeapons: false, leashMeters: 0,
        homeDistanceMeters: 3, beyondLeash: false }]);
    const loop = readSource("space/npc/npcBehaviorLoop.js");
    const leash = functionBody(loop, "isBeyondLeash");
    assert.ok(leash.includes("if (leashRangeMeters <= 0) {\n    return false;"), "0 = no leash");
    assert.ok(leash.includes("distance(entity.position, controller.homePosition) > leashRangeMeters"));
    assert.ok(functionBody(loop, "normalizeBehaviorOverrides").includes("\"leashRangeMeters\","));
  });

  test("HS3 warpShips: one success:false -> failed, the others warp with HUNT_WARP_OPTIONS on a circle", () => {
    const v = makeVendor();
    v.refuse.set("warp:7002", { success: false, errorMsg: "WARP_SCRAMBLED" });
    const center = { x: 1000, y: 50, z: -2000 };
    const r = v.seam.warpShips(SYSTEM, [7001, 7002, 7003, 7004], center, { spreadMeters: 5000 });
    assert.deepStrictEqual(r, { ok: true, warped: 3, failed: [7002], detail: "WARP_SCRAMBLED" });
    const warps = v.calls.filter((c) => c[0] === "warpToPoint");
    assert.deepStrictEqual(warps.map((c) => c[1]), [7001, 7002, 7003, 7004]);
    for (const c of warps) assert.deepStrictEqual(c[3], { forceImmediateStart: true,
      broadcastWarpStartToVisibleSessions: true });
    const near = (a, b) => Math.abs(a - b) < 1e-6;
    const expected = [[6000, -2000], [1000, 3000], [-4000, -2000], [1000, -7000]];
    warps.forEach((c, i) => {
      assert.ok(near(c[2].x, expected[i][0]) && near(c[2].z, expected[i][1]) && c[2].y === 50, JSON.stringify(c[2]));
    });
    v.calls.length = 0;
    v.refuse.clear();
    let first = true;
    const throwing = makeVendor();
    throwing.npcRuntime.warpToPoint = (id) => {
      if (first) { first = false; throw new Error("boom"); }
      throwing.calls.push(["warpToPoint", id]);
      return { success: true };
    };
    assert.deepStrictEqual(throwing.seam.warpShips(SYSTEM, [7001, 7002], center, {}),
      { ok: true, warped: 1, failed: [7001], detail: "boom" });
  });

  test("HS4 vendor facts, GAME_MODULES, DRIFT of playerHunt = log line, adapter surface", () => {
    const npcRuntime = readSource("space/npc/npcRuntime.js");
    assert.match(exportBlock(npcRuntime), /^ {2}warpToPoint,$/m, "npcRuntime exports warpToPoint");
    assert.ok(functionBody(npcRuntime, "resolveNpcContext").includes("spaceRuntime.ensureScene(systemID)"),
      "resolveNpcContext may load the scene -> guard");
    assert.ok(functionBody(npcRuntime, "warpToPoint").includes("resolveNpcContext(entityID)"));
    assert.ok(readSource("space/runtime/solarSystemScene.js").includes("this.sessions = new Map();"));
    assert.match(readSource("space/runtime/scene/dynamicEntities.js"), /^getShipEntityForSession\(session\) \{/m);
    const loop = readSource("space/npc/npcBehaviorLoop.js");
    const normalize = functionBody(loop, "normalizeBehaviorOverrides");
    for (const field of ["returnToHomeWhenIdle", "idleAnchorOrbit", "autoAggro", "autoActivateWeapons"]) {
      assert.ok(normalize.includes(`"${field}",`), field);
    }
    const manual = functionBody(loop, "normalizeManualOrder");
    for (const s of ["attack: \"attack\",", "stop: \"stop\",", "allowPodKill:"]) assert.ok(manual.includes(s), s);
    const warpBegin = functionBody(loop, "beginNpcWarpToPoint");
    assert.ok(warpBegin.includes("forceImmediateStart: true,") && warpBegin.includes(
      "broadcastWarpStartToVisibleSessions: true,"), "HUNT_WARP_OPTIONS as the vendor");
    assert.ok(warpBegin.includes("if (entity.mode === \"WARP\") {"));
    const spaceWrites = [...listJs(path.join(SERVER_SRC, "space"))]
      .filter((f) => /\.(pendingWarp|warpState) = (?!null)/.test(fs.readFileSync(f, "utf8")));
    assert.deepStrictEqual(spaceWrites, [], "a vendor module writes pendingWarp / warpState again");
    assert.ok(loop.includes(`const CAPSULE_GROUP_ID = ${liveProfiles.CAPSULE_GROUP_ID};`));
    assert.match(readSource("space/destiny/visibility/gridBubbles.js"), /^const GRID_BUBBLE_BOX_METERS = 7864320;$/m);
    const probe = functionBody(readSource("services/exploration/probes/probeScanRuntime.js"),
      "isEntityHiddenFromCombatProbes");
    for (const s of ["entity.probeScanVisible === false", "entity.cloaked === true", "entity.cloakState.active === true"]) {
      assert.ok(probe.includes(s), s);
    }
    assert.ok(functionBody(readSource("space/worldData.js"), "getCelestialsForSystem").includes("celestialsBySystem"));

    assert.ok(!MODULE_NAMES.includes("playerHunt"));
    const entryOf = (p) => GAME_MODULES.find((e) => e.path === p);
    const warpSym = entryOf("space/npc/npcRuntime").symbols.find((s) => s.name === "warpToPoint");
    assert.deepStrictEqual([...warpSym.consumers], ["playerHunt", "highsecTraffic", "bountyRevenge"]);
    assert.ok(warpSym.kind === "export" && warpSym.wrap !== true && warpSym.firstLoad !== true);
    assert.ok(entryOf("space/worldData").symbols.find((s) => s.name === "getCelestialsForSystem").consumers
      .includes("playerHunt"));
    for (const [key, fns] of Object.entries(hs.REQUIRED_FUNCTIONS)) {
      for (const fn of fns) assert.ok(entryOf(hs.MODULE_PATHS[key]).symbols.some((s) => s.name === fn), fn);
    }

    const report = probeModules([entryOf("space/npc/npcRuntime")], { load: () => ({ ok: true,
      exports: { warpToEntity() {}, spawnGroupInSystem() {} } }) });
    assert.strictEqual(report.modules[0].status, "DRIFT");
    assert.ok(!Object.prototype.hasOwnProperty.call(report.disabledModules, "materialization"));
    assert.ok(formatProbeLog(report).includes("probe DRIFT space/npc/npcRuntime - missing warpToPoint "
      + "(affects: playerHunt, highsecTraffic, bountyRevenge)"));

    const blind = createAdapter({ moduleApi: { _cache: {} } });
    const seam = blind.getHuntScene();
    assert.strictEqual(blind.getHuntScene(), seam);
    assert.deepStrictEqual(Object.keys(seam), [...hs.SEAM_METHODS]);
    const check = blind.checkHuntScene();
    assert.strictEqual(check.reason, "SEAM_UNAVAILABLE");
    assert.deepStrictEqual(check.missing, Object.values(hs.MODULE_PATHS));
    assert.strictEqual(seam.warpShips(SYSTEM, [1], pos(0), {}).reason, "SEAM_UNAVAILABLE");
    assert.strictEqual(seam.listSystemObjects(SYSTEM, ["stargate"]).reason, "SEAM_UNAVAILABLE");
    assert.deepStrictEqual(hs.checkHuntSceneFrom(makeVendor().requireGame), { ok: true });
  });

  test("HS5 spawnShip behavior \"search\" -> HUNT_SEARCH_BEHAVIOR; absent -> SPAWN_BEHAVIOR", () => {
    const calls = [];
    const runtime = Object.create({ isSolarSystemSceneLoaded: () => true });
    runtime.scenes = new Map();
    const native = { spawnNativeNpcEntityInSystem(id, options) {
      calls.push(options.behaviorOverrides);
      return { success: true, data: { entity: { itemID: 9000001 + calls.length } } };
    } };
    const byPath = { [ns.MODULE_PATHS.runtime]: runtime, [ns.MODULE_PATHS.native]: native };
    const seam = ns.createNpcSpawn({ requireGame: (rel) => (byPath[rel] ? { ok: true, exports: byPath[rel] }
      : { ok: false }), navyProfiles: NAVY_PROFILES_BY_FACTION_ID, data: liveProfiles });
    const spec = { profileId: "p", anchorDescriptor: { kind: "stargate", itemID: 1 } };
    assert.strictEqual(seam.spawnShip(SYSTEM, { ...spec, behavior: "search" }).ok, true);
    assert.strictEqual(seam.spawnShip(SYSTEM, spec).ok, true);
    assert.strictEqual(seam.spawnShip(SYSTEM, { ...spec, behavior: null }).ok, true);
    assert.deepStrictEqual(seam.spawnShip(SYSTEM, { ...spec, behavior: "hunt" }), { ok: false, reason: "INVALID_INPUT" });
    assert.deepStrictEqual(calls, [
      { autoAggro: false, autoActivateWeapons: false, targetPreference: "none", returnToHomeWhenIdle: false,
        idleAnchorOrbit: false, allowFriendlyNpcTargets: true, leashRangeMeters: 0 },
      { ...liveProfiles.SPAWN_BEHAVIOR }, { ...liveProfiles.SPAWN_BEHAVIOR }]);
    assert.ok(Object.isFrozen(liveProfiles.HUNT_SEARCH_BEHAVIOR) && Object.isFrozen(liveProfiles.HUNT_WARP_OPTIONS));
  });

  test("HS6 entity not in the scene -> no vendor call (failed / ENTITY_NOT_IN_SCENE) "
    + "readAggressors reads controller.lastAggressorID; vendor fact of noteIncomingAggression", () => {
    const v = makeVendor();
    assert.deepStrictEqual(v.seam.warpShips(SYSTEM, [7001, 8001], pos(1), {}),
      { ok: true, warped: 1, failed: [8001], detail: "ENTITY_NOT_IN_SCENE" });
    assert.deepStrictEqual(v.seam.setSearch(SYSTEM, [8001, 7002]),
      { ok: true, failed: [8001], detail: "ENTITY_NOT_IN_SCENE" });
    assert.ok(!v.calls.some((c) => c[1] === 8001), "no vendor call with 8001");
    v.calls.length = 0;
    for (const r of [v.seam.warpShips(SYSTEM, [8001], pos(1), {}), v.seam.setSearch(SYSTEM, [8001]),
      v.seam.attackTargets(SYSTEM, [8001], [1001]), v.seam.attackTargets(SYSTEM, [7001], [8002]),
      v.seam.readAggressors(SYSTEM, [8001])]) {
      assert.deepStrictEqual(r, { ok: false, reason: "ENTITY_NOT_IN_SCENE" });
    }
    const ACTS = ["warpToPoint", "setBehaviorOverrides", "issueManualOrder", "wakeNpcController",
      "getControllerByEntityID"];
    assert.deepStrictEqual(v.calls.filter((c) => ACTS.includes(c[0])), [], "every id missing: no vendor call");
    assert.deepStrictEqual(v.seam.attackTargets(SYSTEM, [7001, 7002], [8002, 1003]), { ok: true, failed: [] });
    assert.deepStrictEqual(v.calls.filter((c) => c[0] === "issueManualOrder").map((c) => c[2].targetID), [1003, 1003]);

    v.controllers.set(7001, { lastAggressorID: 1001 });
    v.controllers.set(7002, { lastAggressorID: 0 });
    assert.deepStrictEqual(v.seam.readAggressors(SYSTEM, [7001, 7002, 7003]),
      { ok: true, aggressors: [{ entityId: 7001, aggressorId: 1001, aggressorKind: "other", aggressorFactionId: null,
        aggressorPosition: null, aggressorInWarp: false }] });
    const cold = makeVendor({ sceneLoaded: false });
    assert.deepStrictEqual(cold.seam.readAggressors(SYSTEM, [7001]), { ok: false, reason: "SCENE_NOT_LOADED" });
    assert.deepStrictEqual(cold.vendorCalls(), []);

    const note = functionBody(readSource("space/npc/npcBehaviorLoop.js"), "noteIncomingAggression");
    assert.ok(note.includes("controller.lastAggressorID = normalizedAttackerEntityID;"));
    assert.match(readSource("space/npc/npcRegistry.js"), /^function getControllerByEntityID\(entityID\) \{$/m);
    assert.ok(exportBlock(readSource("space/npc/npcService.js")).includes("  getControllerByEntityID,"));
    const sym = GAME_MODULES.find((e) => e.path === "space/npc/npcService").symbols
      .find((s) => s.name === "getControllerByEntityID");
    assert.deepStrictEqual([...sym.consumers], ["playerHunt", "beltNavyAggro", "ambientRats", "miningEncounters",
      "bounty", "populationStandingAggro"]);
  });

  test("HS7 explainShips: entity in the scene / not, controller / none; no scene -> inScene false "
    + "bad input -> INVALID_INPUT", () => {
    const v = makeVendor();
    v.controllers.set(7001, { lastAggressorID: 0 });
    v.controllers.set(8001, {});
    assert.deepStrictEqual(v.seam.explainShips(SYSTEM, [7001, 7002, 8001, 8002]), { ok: true, ships: [
      { entityId: 7001, inScene: true, controller: true },
      { entityId: 7002, inScene: true, controller: false },
      { entityId: 8001, inScene: false, controller: true },
      { entityId: 8002, inScene: false, controller: false }] });
    const cold = makeVendor({ sceneLoaded: false });
    cold.controllers.set(7001, {});
    assert.deepStrictEqual(cold.seam.explainShips(SYSTEM, [7001]),
      { ok: true, ships: [{ entityId: 7001, inScene: false, controller: true }] });
    assert.ok(!cold.calls.some((c) => c[0] === "ensureScene"), "no scene loaded");
    for (const bad of [[0, [7001]], [SYSTEM, [0]], [SYSTEM, "7001"]]) {
      assert.deepStrictEqual(v.seam.explainShips(...bad), { ok: false, reason: "INVALID_INPUT" });
    }
  });

  test("PN1 readAggressors classifies the aggressor (player / npc + faction + position + warp / other "
    + "gone); the optional faction module missing / throwing / 0 -> aggressorFactionId null, ok:true; vendor facts "
    + "(NPCs fire through the offensive hook) and GAME_MODULES consumer playerHunt", () => {
    const v = makeVendor();
    v.entities.set(1001, { itemID: 1001, session: { characterID: 90000001 }, position: pos(1) });
    v.entities.set(9001, { itemID: 9001, factionID: 500001, position: pos(2), mode: "WARP", effectStamp: 4 });
    v.entities.set(9002, { itemID: 9002, position: pos(3) });
    v.controllers.set(7001, { lastAggressorID: 1001 });
    v.controllers.set(7002, { lastAggressorID: 9001 });
    v.controllers.set(9001, {});
    v.controllers.set(7003, { lastAggressorID: 9002 });
    v.controllers.set(7004, { lastAggressorID: 9003 });
    const withFaction = (fk) => hs.createHuntScene({ data: liveProfiles,
      requireGame: (rel) => (rel === hs.FACTION_KILL_PATH ? fk : v.requireGame(rel)) });
    const read = (fk) => withFaction(fk).readAggressors(SYSTEM, [7001, 7002, 7003, 7004]);
    const rec = (entityId, aggressorId, kind, factionId, position, inWarp) => ({ entityId, aggressorId,
      aggressorKind: kind, aggressorFactionId: factionId, aggressorPosition: position, aggressorInWarp: inWarp });
    const expected = (npcFaction) => ({ ok: true, aggressors: [rec(7001, 1001, "player", null, pos(1), false),
      rec(7002, 9001, "npc", npcFaction, pos(2), true), rec(7003, 9002, "other", null, pos(3), false),
      rec(7004, 9003, "gone", null, null, false)] });
    const seen = [];
    assert.deepStrictEqual(read({ ok: true, exports: { resolveVictimFactionID: (e) => {
      seen.push(e.itemID);
      return e.factionID;
    } } }), expected(500001));
    assert.deepStrictEqual(seen, [9001], "the faction is read for the NPC only");
    for (const fk of [{ ok: false, reason: "file_not_found" }, { ok: true, exports: {} },
      { ok: true, exports: { resolveVictimFactionID: () => { throw new Error("boom"); } } },
      { ok: true, exports: { resolveVictimFactionID: () => 0 } }]) {
      assert.deepStrictEqual(read(fk), expected(null));
    }
    assert.deepStrictEqual(v.seam.readAggressors(SYSTEM, [7002]).aggressors[0].aggressorFactionId, null,
      "makeVendor has no faction module: the seam still works");

    const modules = readSource("space/runtime/scene/modules.js");
    const block = modules.indexOf("offensiveActivation &&\n      targetEntity\n    ) {");
    assert.ok(block >= 0 && modules.slice(block, block + 400).includes("noteNpcIncomingAggression("),
      "the offensive activation hook notes every attacker (no session filter)");
    assert.ok(readSource("space/npc/npcBehaviorLoop.js").includes("scene.activateGenericModule("),
      "NPCs fire through scene.activateGenericModule");
    const standing = readSource("services/character/factionKillStandingRuntime.js");
    assert.ok(exportBlock(standing).includes("  resolveVictimFactionID,"));
    assert.ok(functionBody(standing, "resolveVictimFactionID").includes("victimEntity.factionID"));
    const sym = GAME_MODULES.find((e) => e.path === hs.FACTION_KILL_PATH).symbols
      .find((s) => s.name === "resolveVictimFactionID");
    assert.ok(sym.consumers.includes("playerHunt") && sym.wrap !== true);
    assert.ok(!Object.values(hs.MODULE_PATHS).includes(hs.FACTION_KILL_PATH), "optional: not required by the seam");
  });

  test("PU5 listSystemObjects: a stargate with destinationSolarSystemID > 0 -> toSystemId, without it (or 0) "
    + "no field, other kinds never; vendor fact agentMissionRuntime reads the same field of getStargatesForSystem", () => {
    const v = makeVendor();
    v.worldData.getStargatesForSystem = () => [
      { itemID: 50000002, position: pos(2), destinationSolarSystemID: 30000144 },
      { itemID: 50000009, position: pos(9) },
      { itemID: 50000010, position: pos(10), destinationSolarSystemID: 0 }];
    v.worldData.getStationsForSystem = () => [{ stationID: 60000001, position: pos(1),
      destinationSolarSystemID: 30000144 }];
    assert.deepStrictEqual(v.seam.listSystemObjects(SYSTEM, ["stargate", "station"]), { ok: true, objects: [
      { kind: "stargate", itemId: 50000002, position: pos(2), toSystemId: 30000144 },
      { kind: "stargate", itemId: 50000009, position: pos(9) },
      { kind: "stargate", itemId: 50000010, position: pos(10) },
      { kind: "station", itemId: 60000001, position: pos(1) },
    ] });
    const src = readSource("services/agent/agentMissionRuntime.js");
    assert.ok(src.includes("getStargatesForSystem(") && src.includes("stargate.destinationSolarSystemID"),
      "vendor fact: the stargate record of worldData carries destinationSolarSystemID");
    assert.strictEqual(liveProfiles.OBJECT_KIND_SOURCES.stargate.toSystemField, "destinationSolarSystemID");
  });

  test("SZ4 vendor fact: a ship entity carries typeID and groupID (25 without one) "
    + "readPlayerShips gives typeId / groupId (null when not a positive number)", () => {
    const entity = functionBody(readSource("space/runtime/shipEntity.js"), "buildShipEntityCore");
    assert.ok(entity.includes("    typeID: source.typeID,\n"), "typeID of the ship entity");
    assert.ok(entity.includes("    groupID: toInt(source.groupID, 25),\n"), "groupID of the ship entity, default 25");
    const v = makeVendor();
    v.sessions.set(1, { clientID: 1, characterID: 90000001 });
    v.sessions.set(2, { clientID: 2, characterID: 90000002 });
    v.sessions.set(3, { clientID: 3, characterID: 90000003 });
    v.shipBySession.set(1, { itemID: 1001, position: pos(1), typeID: 587, groupID: 25 });
    v.shipBySession.set(2, { itemID: 1002, position: pos(2), typeID: "670", groupID: 29 });
    v.shipBySession.set(3, { itemID: 1003, position: pos(3), typeID: undefined, groupID: 0 });
    const read = v.seam.readPlayerShips(SYSTEM);
    assert.strictEqual(read.ok, true);
    assert.deepStrictEqual(read.ships.map((s) => [s.characterId, s.typeId, s.groupId, s.capsule]), [
      [90000001, 587, 25, false], [90000002, 670, 29, true], [90000003, null, null, false]]);
  });

  test("HS-A1 kind anomaly: listSystemAnomalySites({allowTemplateDiscovery:false}) "
    + "actualPosition or position[], (0,0,0) and siteID 0 skipped, vendor order + family; static kinds unchanged", () => {
    const v = makeVendor();
    const seen = [];
    v.byPath[hs.SIGNATURE_RUNTIME_PATH] = { listSystemAnomalySites(systemId, options) {
      seen.push([systemId, options]);
      return [
        { siteID: 7101, family: "combat", actualPosition: { x: 10, y: 20, z: 30 }, position: [10, 20, 30] },
        { siteID: 7102, family: "ore", position: [4, 5, 6] },
        { siteID: 7103, family: "combat", actualPosition: { x: 0, y: 0, z: 0 }, position: [0, 0, 0] },
        { siteID: 0, family: "ice", actualPosition: { x: 1, y: 1, z: 1 } },
      ];
    } };
    const r = v.seam.listSystemObjects(SYSTEM, ["stargate", "anomaly"]);
    assert.deepStrictEqual(r, { ok: true, objects: [
      { kind: "stargate", itemId: 50000002, position: pos(2) },
      { kind: "stargate", itemId: 50000009, position: pos(9) },
      { kind: "anomaly", itemId: 7101, position: { x: 10, y: 20, z: 30 }, family: "combat" },
      { kind: "anomaly", itemId: 7102, position: { x: 4, y: 5, z: 6 }, family: "ore" },
    ] });
    assert.deepStrictEqual(seen, [[SYSTEM, { allowTemplateDiscovery: false }]]);
    assert.ok(!("loadScene" in seen[0][1]) && !("materializeScene" in seen[0][1]), "never loads a scene");
    assert.deepStrictEqual(Object.keys(liveProfiles.OBJECT_KIND_SOURCES),
      ["stargate", "station", "asteroidBelt", "planet", "sun", "anomaly"]);
    assert.strictEqual(liveProfiles.OBJECT_KIND_SOURCES.anomaly.dynamic, "anomalySites");
    const entry = GAME_MODULES.find((m) => m.path === hs.SIGNATURE_RUNTIME_PATH);
    assert.ok(entry && entry.symbols.some((s) => s.name === "listSystemAnomalySites" && !s.wrap),
      "signatureRuntime.listSystemAnomalySites in GAME_MODULES, read only");
  });

  test("HS-A2 anomaly source missing / throwing / non-array -> ok, static objects kept "
    + "skipped [anomaly]; [anomaly] alone without worldData is no SEAM_UNAVAILABLE; empty list = no skipped", () => {
    const v = makeVendor();
    const statics = v.seam.listSystemObjects(SYSTEM, ["asteroidBelt"]).objects;
    const missing = v.seam.listSystemObjects(SYSTEM, ["asteroidBelt", "anomaly"]);
    assert.deepStrictEqual(missing, { ok: true, objects: statics, skipped: ["anomaly"] });
    v.byPath[hs.SIGNATURE_RUNTIME_PATH] = { listSystemAnomalySites() { throw new Error("boom"); } };
    assert.deepStrictEqual(v.seam.listSystemObjects(SYSTEM, ["asteroidBelt", "anomaly"]),
      { ok: true, objects: statics, skipped: ["anomaly"] });
    v.byPath[hs.SIGNATURE_RUNTIME_PATH] = { listSystemAnomalySites: () => null };
    assert.deepStrictEqual(v.seam.listSystemObjects(SYSTEM, ["anomaly"]), { ok: true, objects: [], skipped: ["anomaly"] });
    v.byPath[hs.SIGNATURE_RUNTIME_PATH] = { listSystemAnomalySites: () => [] };
    delete v.byPath[hs.MODULE_PATHS.worldData];
    assert.deepStrictEqual(v.seam.listSystemObjects(SYSTEM, ["anomaly"]), { ok: true, objects: [] });
    assert.strictEqual(v.seam.listSystemObjects(SYSTEM, ["stargate", "anomaly"]).reason, "SEAM_UNAVAILABLE");
  });

  test("GDX1: readPlayerShips warpTarget / warpTargetEntityId only in mode WARP; vendor "
    + "facts of warpTo (targetPoint before WARP) and of the stargate warp (targetEntityID = gate itemID)", () => {
    const v = makeVendor();
    const target = { x: 1e10, y: 2, z: -3 };
    for (const id of [1, 2, 3]) v.sessions.set(id, { clientID: id, characterID: 90000000 + id, _space: { shipID: id } });
    v.shipBySession.set(1, { itemID: 1001, position: pos(10), groupID: 25, mode: "WARP", effectStamp: -1,
      targetPoint: { ...target }, warpDestination: { targetEntityID: 50000009 } });
    v.shipBySession.set(2, { itemID: 1002, position: pos(20), groupID: 25, mode: "WARP", effectStamp: 5,
      targetPoint: { ...target } });
    v.shipBySession.set(3, { itemID: 1003, position: pos(30), groupID: 25, mode: "GOTO", targetPoint: { ...target },
      warpDestination: { targetEntityID: 50000009 } });
    const ships = v.seam.readPlayerShips(SYSTEM).ships;
    assert.deepStrictEqual(ships.map((s) => [s.entityId, s.warpTarget, s.warpTargetEntityId]),
      [[1001, target, 50000009], [1002, target, null], [1003, null, null]]);
    assert.notStrictEqual(ships[0].warpTarget, v.shipBySession.get(1).targetPoint, "a copy of the point");
    const warpTo = functionBody(readSource("space/destiny/simulation/evolve.js"), "warpTo");
    const set = warpTo.lastIndexOf("ball.targetPoint = dst;");
    assert.ok(set >= 0 && set < warpTo.indexOf("ball.mode = \"WARP\";"), "warpTo: targetPoint before mode WARP");
    const commands = readSource("space/destiny/commands/warpCommands.js");
    assert.ok(commands.includes("warpTo(entity, request.rawDestination"), "applyWarpOrder warps to rawDestination");
    assert.ok(commands.includes("targetEntityID: request.targetEntityID"), "warpDestination keeps targetEntityID");
    const gate = commands.indexOf("target.kind === \"stargate\"");
    assert.ok(gate >= 0, "stargate branch");
    const id = commands.indexOf("targetEntityID: target.itemID", gate);
    const nextBranch = commands.indexOf("target.kind ===", gate + 1);
    assert.ok(id > gate && (nextBranch === -1 || id < nextBranch), "stargate warp: targetEntityID = gate itemID");
  });

  const replacingOverrides = (v) => {
    v.npc.setBehaviorOverrides = (id, o) => {
      v.calls.push(["setBehaviorOverrides", id, o]);
      const c = v.controllers.get(id);
      if (!c) return { success: false, errorMsg: "NPC_NOT_FOUND" };
      c.behaviorOverrides = { ...o };
      return { success: true, data: c };
    };
  };

  test("HS-ARM1 gem armNpcCombat: empty operatorKind -> lne-duel + flag + protect; lne-duel -> already "
    + "foreign -> failed FOREIGN_OPERATOR untouched; second call = no-op", () => {
    const dormancyGuard = require("../../lib/adapter/dormancyGuard");
    const v = makeVendor();
    replacingOverrides(v);
    v.controllers.set(7001, { operatorKind: "", behaviorOverrides: { autoAggro: false, leashRangeMeters: 0 } });
    v.controllers.set(7002, { operatorKind: "lne-duel", behaviorOverrides: { allowFriendlyNpcTargets: true } });
    v.controllers.set(7003, { operatorKind: "belt", behaviorOverrides: {} });
    try {
      assert.deepStrictEqual(v.seam.armNpcCombat(SYSTEM, [7001, 7002, 7003]),
        { ok: true, armed: 1, already: 1, failed: [7003], detail: "FOREIGN_OPERATOR" });
      assert.strictEqual(v.controllers.get(7001).operatorKind, liveProfiles.LIVE_DUEL_OPERATOR_KIND);
      assert.strictEqual(v.controllers.get(7003).operatorKind, "belt", "never overwritten");
      assert.deepStrictEqual(v.calls.filter((c) => c[0] === "setBehaviorOverrides"),
        [["setBehaviorOverrides", 7001, { autoAggro: false, leashRangeMeters: 0, allowFriendlyNpcTargets: true }]]);
      assert.ok(dormancyGuard.isProtected(7001) && dormancyGuard.isProtected(7002));
      assert.ok(!dormancyGuard.isProtected(7003));
      v.calls.length = 0;
      assert.deepStrictEqual(v.seam.armNpcCombat(SYSTEM, [7001, 7002, 7003]),
        { ok: true, armed: 0, already: 2, failed: [7003], detail: "FOREIGN_OPERATOR" });
      assert.strictEqual(v.calls.filter((c) => c[0] === "setBehaviorOverrides").length, 0);
      assert.ok(!v.calls.some((c) => c[0] === "ensureScene" || c[0] === "issueManualOrder"));
    } finally {
      for (const id of [7001, 7002, 7003]) dormancyGuard.release(id);
    }
  });

  test("HS-ARM2 gem armNpcCombat: no scene -> SCENE_NOT_LOADED and no vendor call; an id outside the scene -> "
    + "failed; a frozen controller -> failed OPERATOR_WRITE_FAILED without a throw", () => {
    const dormancyGuard = require("../../lib/adapter/dormancyGuard");
    const off = makeVendor({ sceneLoaded: false });
    assert.deepStrictEqual(off.seam.armNpcCombat(SYSTEM, [7001]), { ok: false, reason: "SCENE_NOT_LOADED" });
    assert.deepStrictEqual(off.vendorCalls(), []);
    assert.strictEqual(off.seam.armNpcCombat(SYSTEM, []).reason, "INVALID_INPUT");
    const v = makeVendor();
    replacingOverrides(v);
    v.controllers.set(7001, { operatorKind: "", behaviorOverrides: {} });
    v.controllers.set(7004, Object.freeze({ operatorKind: "", behaviorOverrides: Object.freeze({}) }));
    try {
      assert.deepStrictEqual(v.seam.armNpcCombat(SYSTEM, [7001, 9999]),
        { ok: true, armed: 1, already: 0, failed: [9999], detail: "ENTITY_NOT_IN_SCENE" });
      assert.deepStrictEqual(v.seam.armNpcCombat(SYSTEM, [9998]), { ok: false, reason: "ENTITY_NOT_IN_SCENE" });
      v.calls.length = 0;
      assert.deepStrictEqual(v.seam.armNpcCombat(SYSTEM, [7004]),
        { ok: true, armed: 0, already: 0, failed: [7004], detail: "OPERATOR_WRITE_FAILED" });
      assert.strictEqual(v.controllers.get(7004).operatorKind, "");
      assert.strictEqual(v.calls.filter((c) => c[0] === "setBehaviorOverrides").length, 0);
      assert.ok(!dormancyGuard.isProtected(7004));
    } finally {
      for (const id of [7001, 7004]) dormancyGuard.release(id);
    }
  });

  test("HS-ARM3 gem vendor facts: friendship rule (flag on both sides + same operatorKind), the attack order "
    + "goes through isValidCombatTarget -> isFriendlyCombatTarget, any operatorKind -> combat dormancy; profiles", () => {
    const loop = readSource("space/npc/npcBehaviorLoop.js");
    const friendly = functionBody(loop, "isFriendlyCombatTarget");
    assert.ok(friendly.includes("sourceController.behaviorOverrides.allowFriendlyNpcTargets === true"), "source flag");
    assert.ok(friendly.includes("targetController.behaviorOverrides.allowFriendlyNpcTargets === true"), "target flag");
    assert.ok(friendly.includes("sourceOperatorKind &&\n      sourceOperatorKind === targetOperatorKind"),
      "same non-empty operatorKind");
    assert.ok(friendly.includes("getControllerByEntityID("), "the live controller");
    const desired = functionBody(loop, "resolveDesiredTarget");
    const attack = desired.indexOf("manualOrder.type === \"attack\"");
    assert.ok(attack >= 0 && desired.indexOf("isValidCombatTarget(entity, manualTarget", attack) > attack,
      "attack order -> isValidCombatTarget");
    assert.ok(functionBody(loop, "isValidCombatTarget").includes("!isFriendlyCombatTarget(entity, target)"));
    assert.ok(functionBody(loop, "setBehaviorOverrides")
      .includes("controller.behaviorOverrides = normalizeBehaviorOverrides(overrides);"), "replaces the overrides");
    assert.ok(functionBody(loop, "normalizeBehaviorOverrides").includes("\"allowFriendlyNpcTargets\","));
    const dormancy = functionBody(readSource("space/npc/npcCombatDormancy.js"), "isCombatDormantControllerRecord");
    assert.ok(dormancy.includes("operatorKind !== \"\""), "any operatorKind -> dormancy");
    assert.strictEqual(liveProfiles.HUNT_SEARCH_BEHAVIOR.allowFriendlyNpcTargets, true);
    assert.strictEqual(liveProfiles.LIVE_DUEL_OPERATOR_KIND, "lne-duel");
    assert.strictEqual(liveProfiles.LIVE_OPERATOR_KIND, "lne");
    assert.notStrictEqual(liveProfiles.LIVE_DUEL_OPERATOR_KIND, liveProfiles.LIVE_OPERATOR_KIND);
    assert.ok(!Object.prototype.hasOwnProperty.call(liveProfiles.SPAWN_BEHAVIOR, "allowFriendlyNpcTargets"));
  });
};
