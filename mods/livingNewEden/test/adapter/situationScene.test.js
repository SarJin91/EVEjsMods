"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const seams = require("../../lib/adapter/situationScene");
const ships = require("../../lib/adapter/situationShips");
const { createNpcSpawn } = require("../../lib/adapter/npcSpawn");
const liveProfiles = require("../../lib/adapter/data/liveProfiles");
const { GAME_MODULES } = require("../../lib/adapter/gameModules");
const { SCENE_METHODS } = require("../../lib/situations/service");

const REPO_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const SERVER_SRC = path.join(REPO_ROOT, "server", "src");
const SYSTEM = 30000144;
const BELT = { kind: "asteroidBelt", itemID: 40001, radius: 12000, position: { x: 2e9, y: 0, z: 0 } };
const BELT2 = { kind: "asteroidBelt", itemID: 40002, radius: 0, position: { x: 3e9, y: 0, z: 0 } };
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

function fakeGame({ statics = [], dynamics = [], controllers = [] } = {}) {
  const calls = { spawn: [], publish: [], destroy: [] };
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
  const mods = {
    "space/runtime": { scenes: new Map([[SYSTEM, scene]]), isSolarSystemSceneLoaded: (id) => id === SYSTEM },
    "space/npc/nativeNpcService": {
      spawnNativeNpcEntityInSystem(systemId, options) {
        calls.spawn.push(options);
        nextId += 1;
        const entity = { itemID: nextId, kind: "ship", nativeNpc: true, operatorKind: options.operatorKind,
          position: { x: 0, y: 0, z: 0 }, bounty: 15000 };
        byId.set(nextId, entity);
        records.set(nextId, { entityID: nextId, transient: true, operatorKind: options.operatorKind, bounty: 15000 });
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
      upsertNativeEntity(record) {
        records.set(record.entityID, { ...record });
        return { success: true };
      },
    },
    "space/npc/npcRuntime": { warpToPoint: () => ({ success: true }) },
    "space/npc/pirateHullProfiles": { resolveFactionHullProfileID: () => null },
    "space/worldData": { getStargatesForSystem: () => [], getStationsForSystem: () => [],
      getAsteroidBeltsForSystem: (id) => (id === SYSTEM ? [{ itemID: BELT.itemID,
        itemName: "Jita IV - Asteroid Belt 1" }, { itemID: BELT2.itemID }] : []) },
  };
  const requireGame = (rel) => (mods[rel] ? { ok: true, exports: mods[rel] } : { ok: false, reason: "missing" });
  const npcSpawn = createNpcSpawn({ requireGame, navyProfiles: {}, invaderProfiles: {}, data: liveProfiles });
  return { calls, mods, byId, records, requireGame, npcSpawn };
}

module.exports = ({ test }) => {
  test("SI5 spawnShip victim / pirate -> vendor options (lneSituation, allowFriendlyNpcTargets, slimName, bounty 0 "
    + "victim only); readAnchors, listSituationIds; vendor facts of the NPC <-> NPC rule and the whitelist", () => {
    ships.resetSituationShipsForTests();
    try {
      const g = fakeGame({ statics: [BELT2, GATE, BELT], dynamics: [{ itemID: 8001, operatorKind: "lneSituation" }],
        controllers: [{ entityID: 8002, operatorKind: "lneSituation" }, { entityID: 8003, operatorKind: "lneTraffic" }] });
      const seam = seams.createSituationScene({ requireGame: g.requireGame, getNpcSpawn: () => g.npcSpawn,
        getHuntScene: () => null });
      assert.deepStrictEqual(Object.keys(seam).sort(), [...seams.SEAM_METHODS].sort());
      assert.deepStrictEqual([...SCENE_METHODS].sort(), [...seams.SEAM_METHODS].sort(), "service mirror");
      const victim = seam.spawnShip(SYSTEM, { role: "victim", profileId: "ore_mining_venture",
        anchor: { kind: "belt", id: BELT.itemID }, spawnOffsetMeters: 5000, slimName: "Ana Kowal", situationId: "sx-1" });
      assert.strictEqual(victim.ok, true, JSON.stringify(victim));
      const pirate = seam.spawnShip(SYSTEM, { role: "pirate", profileId: "pirate_frigate",
        anchor: { kind: "belt", id: BELT.itemID }, spawnOffsetMeters: 25000, situationId: "sx-1" });
      assert.strictEqual(pirate.ok, true, JSON.stringify(pirate));
      const [v, p] = g.calls.spawn;
      assert.deepStrictEqual([v.operatorKind, p.operatorKind], ["lneSituation", "lneSituation"]);
      assert.deepStrictEqual([v.behaviorOverrides.allowFriendlyNpcTargets, p.behaviorOverrides.allowFriendlyNpcTargets],
        [true, true]);
      assert.deepStrictEqual([v.anchorDescriptor, v.spawnDistanceMeters, p.spawnDistanceMeters],
        [{ kind: "entity", itemID: BELT.itemID }, 17000, 37000]);
      assert.deepStrictEqual([v.slimNameOverride, "slimNameOverride" in p, v.transient, v.broadcast],
        ["Ana Kowal", false, true, false]);
      assert.deepStrictEqual([g.byId.get(victim.entityId).bounty, g.records.get(victim.entityId).bounty], [0, 0]);
      assert.deepStrictEqual([g.byId.get(pirate.entityId).bounty, g.records.get(pirate.entityId).bounty],
        [15000, 15000], "the vendor bounty of a pirate stays");
      assert.deepStrictEqual(g.calls.publish, [[victim.entityId], [pirate.entityId]]);
      assert.deepStrictEqual([ships.situationShipOf(victim.entityId), ships.situationShipOf(pirate.entityId)],
        [{ situationId: "sx-1", role: "victim" }, { situationId: "sx-1", role: "pirate" }]);
      assert.deepStrictEqual(seam.spawnShip(SYSTEM, { role: "boss", profileId: "x", anchor: { kind: "belt", id: 1 },
        spawnOffsetMeters: 0, situationId: "sx-1" }), { ok: false, reason: "INVALID_INPUT" });
      assert.deepStrictEqual(seam.spawnShip(SYSTEM, { role: "victim", profileId: "x", anchor: { kind: "point" },
        spawnOffsetMeters: 0, situationId: "sx-1" }), { ok: false, reason: "ANCHOR_UNSUPPORTED" });
      assert.deepStrictEqual(g.npcSpawn.spawnShip(SYSTEM, { profileId: "x", anchorDescriptor: { kind: "entity",
        itemID: 1 }, purpose: "situation", role: "victim", guard: {} }), { ok: false, reason: "INVALID_INPUT" });
      assert.strictEqual(seam.despawn(SYSTEM, [victim.entityId]).ok, true);
      assert.strictEqual(ships.situationShipOf(victim.entityId), null, "despawn forgets");

      const anchors = seam.readAnchors(SYSTEM);
      assert.deepStrictEqual(anchors, { ok: true, belts: [
        { itemId: BELT.itemID, position: BELT.position, radius: 12000, name: "Jita IV - Asteroid Belt 1" },
        { itemId: BELT2.itemID, position: BELT2.position, radius: 0, name: null }],
      gates: [{ itemId: GATE.itemID, position: GATE.position, radius: 15000, name: null }] });
      assert.deepStrictEqual(seam.readAnchors(30000001), { ok: false, reason: "SCENE_NOT_LOADED" });
      assert.deepStrictEqual(seam.listSituationIds(SYSTEM).ids, [8001, 8002, pirate.entityId]);

      const loop = readSource("space/npc/npcBehaviorLoop.js");
      const rule = block(loop, "isFriendlyCombatTarget");
      assert.strictEqual((rule.match(/behaviorOverrides\.allowFriendlyNpcTargets === true/g) || []).length, 2,
        "both sides need allowFriendlyNpcTargets");
      assert.ok(rule.includes("sourceOperatorKind === targetOperatorKind") && rule.includes("sourceOperatorKind &&"),
        "the same non-empty operatorKind");
      const normalize = block(loop, "normalizeBehaviorOverrides");
      for (const key of new Set([...Object.keys(liveProfiles.SITUATION_VICTIM_BEHAVIOR),
        ...Object.keys(liveProfiles.SITUATION_PIRATE_BEHAVIOR)])) {
        assert.ok(normalize.includes(`"${key}"`) || normalize.includes(`overrides.${key} !== undefined`),
          `${key} on the vendor whitelist`);
      }
      const native = readSource("space/npc/nativeNpcService.js");
      assert.ok(native.includes("entity.operatorKind = entityRecord.operatorKind"), "the entity carries operatorKind");
      assert.ok(native.includes("hasOwnProperty.call(options, \"slimNameOverride\")"), "slimNameOverride option");
      assert.ok(readSource("space/runtime/staticSceneEntity.js").includes("itemName: asteroidBelt.itemName"),
        "the belt record has itemName");
      const sse = readSource("space/runtime/staticSceneEntity.js");
      assert.ok(sse.includes("kind: \"stargate\"") && sse.includes("itemName: stargate.itemName"),
        "the gate entity has kind stargate and itemName");
      const named = fakeGame({ statics: [{ ...GATE, itemName: "  Stargate (Perimeter) " },
        { kind: "stargate", itemID: 50002, radius: 1, position: { x: 1, y: 0, z: 0 }, itemName: "" }] });
      const namedSeam = seams.createSituationScene({ requireGame: named.requireGame, getNpcSpawn: () => named.npcSpawn,
        getHuntScene: () => null });
      assert.deepStrictEqual(namedSeam.readAnchors(SYSTEM).gates.map((x) => [x.itemId, x.name]),
        [[50001, "Stargate (Perimeter)"], [50002, null]], "SC6 gates[].name");
      const consumers = (p, name) => {
        const entry = GAME_MODULES.find((e) => e.path === p && e.symbols.some((s) => s.name === name));
        assert.ok(entry, `${p}.${name}`);
        const sym = entry.symbols.find((s) => s.name === name);
        assert.ok(!sym.wrap && !sym.firstLoad, `${p}.${name} called, never wrapped`);
        return sym.consumers;
      };
      for (const [key, fns] of Object.entries(seams.FUNCTIONS)) {
        for (const fn of fns) assert.ok(consumers(seams.PATHS[key], fn).includes("situations"), `${key}.${fn}`);
      }
      assert.ok(consumers("space/runtime", "scenes").includes("situations"));
      assert.ok(consumers(seams.NAME_PATH, seams.NAME_FUNCTION).includes("situations"));
      const { createAdapter } = require("../../lib/adapter");
      const adapter = createAdapter({ requireGame: g.requireGame });
      assert.strictEqual(typeof adapter.getSituationScene, "function");
    } finally {
      ships.resetSituationShipsForTests();
    }
  });
};
