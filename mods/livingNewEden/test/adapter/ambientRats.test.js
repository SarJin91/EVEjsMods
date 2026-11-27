"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const seams = require("../../lib/adapter/ambientRats");
const schema = require("../../lib/ambientRats/schema");
const { GAME_MODULES } = require("../../lib/adapter/gameModules");
const { NAVY_PROFILES_BY_FACTION_ID } = require("../../lib/adapter/empireNavyCatalog");
const { NAVY_PASSIVE_BEHAVIOR } = require("../../lib/adapter/data/liveProfiles");
const { observeKill } = require("../../lib/adapter/killObservation");

const SERVER_SRC = path.resolve(__dirname, "..", "..", "..", "..", "server", "src");
const SYSTEM = 30002510;
const GATE = 50001001;
const STATION = 60001001;
const PLANET = 40001001;
const AMARR = 500003;

function readSource(rel) {
  return fs.readFileSync(path.join(SERVER_SRC, rel), "utf8").replace(/\r\n/g, "\n");
}

function block(src, name) {
  const start = src.indexOf(`\nfunction ${name}(`);
  assert.ok(start >= 0, `function ${name}`);
  const end = src.indexOf("\nfunction ", start + 1);
  return src.slice(start, end < 0 ? src.length : end);
}

function exportsBlock(src) {
  const start = src.lastIndexOf("\nmodule.exports = {");
  assert.ok(start >= 0, "module.exports");
  return src.slice(start);
}

function fakeGame({ loaded = true, planDefs, storeIds = [] } = {}) {
  const calls = { plan: [], spawn: [], sceneGet: 0, store: 0, overrides: [] };
  const controllers = new Map([[900, { entityID: 900, behaviorOverrides: { ...NAVY_PASSIVE_BEHAVIOR } }]]);
  const statics = [
    { itemID: GATE, kind: "stargate", itemName: "Stargate (X)", position: { x: 1, y: 0, z: 0 } },
    { itemID: STATION, kind: "station", position: { x: 2, y: 0, z: 0 } },
    { itemID: PLANET, kind: "planet", itemName: "Planet (X)", radius: 6000000, position: { x: 3, y: 0, z: 0 },
      direction: { x: 0, y: 1, z: 0 } },
    { itemID: 40001002, kind: "asteroidBelt", position: { x: 4, y: 0, z: 0 } },
  ];
  const dynamics = new Map([
    [900, { itemID: 900, nativeNpc: true, operatorKind: "lneAmbient", position: { x: 9, y: 9, z: 9 } }],
    [901, { itemID: 901, nativeNpc: true, operatorKind: "asteroidBeltRat", position: { x: 5, y: 6, z: 7 } }],
    [902, { itemID: 902, nativeNpc: false, position: { x: 0, y: 0, z: 0 } }],
  ]);
  const byId = new Map([...statics, ...dynamics.values()].map((e) => [e.itemID, e]));
  const scene = { staticEntities: statics, dynamicEntities: dynamics, getEntityByID: (id) => byId.get(id) || null };
  const scenes = new Map([[SYSTEM, scene]]);
  const realGet = scenes.get.bind(scenes);
  scenes.get = (id) => { calls.sceneGet += 1; return realGet(id); };
  const defs = planDefs || [{ profile: { profileID: "guristas_frigate", name: "Pithi frigate" } },
    { profile: { profileID: "guristas_cruiser", name: "Pith cruiser" } }];
  const modules = {
    "space/runtime": { isSolarSystemSceneLoaded: (id) => loaded && id === SYSTEM, scenes },
    "space/npc/beltRatRuntime": {
      resolveSecurityProfile: () => ({ band: "nullsec", eligible: true }),
      buildBeltRatSpawnPlan: (systemId, options) => {
        calls.plan.push([systemId, options]);
        return { success: true, data: { definitions: defs, selectionID: "belt_rat:x:nullsec" } };
      },
    },
    "space/npc/nativeNpcStore": {
      getNativeController: (id) => { calls.store += 1; return storeIds.includes(id) ? { entityID: id } : null; },
      listNativeControllersForSystem: () => [{ entityID: 903, operatorKind: "lneAmbient" },
        { entityID: 904, operatorKind: "asteroidBeltRat" }],
    },
    "space/npc/npcData": { buildNpcDefinition: (id) => ({ profile: { profileID: id } }) },
    "space/npc/nativeNpcService": { spawnNativeDefinitionsInContext: () => ({ success: false }) },
    "space/npc/npcService": {
      getControllerByEntityID: (id) => controllers.get(id) || null,
      setBehaviorOverrides: (id, overrides) => {
        calls.overrides.push([id, overrides]);
        const c = controllers.get(id);
        if (!c) return { success: false, errorMsg: "NPC_NOT_FOUND" };
        c.behaviorOverrides = { ...overrides };
        c.nextThinkAtMs = 0;
        return { success: true, data: c };
      },
    },
  };
  const requireGame = (rel) => (modules[rel] ? { ok: true, exports: modules[rel] } : { ok: false, reason: "missing" });
  const tools = { ok: true, buildNpcDefinition: modules["space/npc/npcData"].buildNpcDefinition,
    spawnNativeDefinitionsInContext: (...args) => {
      calls.spawn.push(args);
      const list = args[1].data.definitions;
      return { success: true, data: { spawned: list.map((d, i) => ({ entity: { itemID: 7000 + i }, definition: d })) } };
    } };
  const seam = seams.createAmbientRatSeam({ requireGame, getSpawnTools: () => tools });
  return { seam, calls, requireGame, scene, controllers };
}

module.exports = ({ test }) => {
  test("ARS1 vendor facts: plan, faction key, spawner options, dormancy, transient IDs, surface distance; GAME_MODULES", () => {
    const belt = readSource("space/npc/beltRatRuntime.js");
    assert.match(exportsBlock(belt), /\n {2}buildBeltRatSpawnPlan,\n/, "buildBeltRatSpawnPlan exported");
    const plan = block(belt, "buildBeltRatSpawnPlan");
    assert.match(plan, /resolveConcretePirateFactionKey\(systemID, options\)/, "options reach the faction key");
    assert.match(plan, /resolveSpawnCount\(securityProfile, options\)/, "options reach the count");
    assert.match(block(belt, "buildSpecialBeltRatSpawnPlan"), /rollSpecialSpawnKind\([\s\S]*?options,\n {2}\)/);
    assert.match(block(belt, "rollSpecialSpawnKind"), /if \(options\.skipSpecialSpawns === true \|\|/);
    assert.match(block(belt, "resolveSpawnCount"), /toInt\(options\.minCount,[\s\S]*toInt\(options\.maxCount,/);
    assert.match(block(belt, "random"), /typeof options\.random === "function"/);
    const policy = readSource("space/npc/pirateFactionPolicy.js");
    assert.match(block(policy, "resolvePirateFactionForSystem"),
      /normalizeExplicitFactionKey\(options\.factionKey\);\n {2}if \(explicitFactionKey\)/, "explicit factionKey wins");
    const service = readSource("space/npc/nativeNpcService.js");
    const ctx = block(service, "spawnNativeNpcEntityInContext");
    assert.match(ctx, /operatorKind: String\(options\.operatorKind \|\| ""\)/);
    assert.match(ctx, /selectionID: String\(options\.selectionID \|\| ""\)/);
    assert.match(block(service, "spawnNativeDefinitionsInContext"), /\.\.\.options,[\s\S]*selectionID: String\(options\.selectionID/);
    assert.match(block(readSource("space/npc/npcCombatDormancy.js"), "isCombatDormantControllerRecord"),
      /runtimeKind === "nativeCombat"[\s\S]*operatorKind !== ""/);
    const store = readSource("space/npc/nativeNpcStore.js");
    assert.match(store, /Transient IDs restart at the fixed\n\/\/ upper-half base below on every process and are never written back to the\n\/\/ store/);
    assert.match(block(store, "allocateID"), /if \(options\.transient === true\) \{/);
    assert.match(block(readSource("space/npc/npcAnchors.js"), "resolveSpawnDistance"),
      /toFiniteNumber\(options\.distanceFromSurfaceMeters, 0\)/);

    const consumers = (p, name) => {
      const entry = GAME_MODULES.find((m) => m.path === p);
      const s = entry && entry.symbols.find((x) => x.name === name);
      assert.ok(s, `${p}.${name}`);
      assert.ok(!s.wrap && !s.firstLoad || name === "resolveSecurityProfile", `${name}: no wrap`);
      return s.consumers;
    };
    for (const [p, name] of [["space/npc/beltRatRuntime", "buildBeltRatSpawnPlan"],
      ["space/npc/beltRatRuntime", "resolveSecurityProfile"], ["space/npc/nativeNpcService", "spawnNativeDefinitionsInContext"],
      ["space/npc/npcData", "buildNpcDefinition"], ["space/npc/nativeNpcStore", "getNativeController"],
      ["space/npc/nativeNpcStore", "listNativeControllersForSystem"]]) {
      assert.ok(consumers(p, name).includes("ambientRats"), `${name} consumer ambientRats`);
    }
  });

  test("ARS2 spawnGroup: pirate options 1:1, navy definitions, NAVY_FAILED on an unknown hull", () => {
    assert.deepStrictEqual([seams.OPERATOR_KIND, seams.SELECTION_PREFIX, seams.NAVY_TEMPLATE_FACTION_KEY],
      [schema.OPERATOR_KIND, schema.SELECTION_PREFIX, schema.NAVY_TEMPLATE_FACTION_KEY], "mirrors of the schema");
    const random = () => 0.5;
    const input = { systemId: SYSTEM, anchorId: GATE, factionId: 500010, source: { type: "pirate", factionKey: "guristas" },
      minCount: 2, maxCount: 5, distanceFromSurfaceMeters: 20000, groupKey: "amb:1:1", random };
    const g = fakeGame();
    const res = g.seam.spawnGroup(input);
    assert.deepStrictEqual(res, { ok: true, entityIds: [7000, 7001], hulls: ["frigate", "cruiser"] });
    assert.deepStrictEqual(g.calls.plan, [[SYSTEM, { factionKey: "guristas", skipSpecialSpawns: true, minCount: 2,
      maxCount: 5, random }]]);
    const [context, selection, options] = g.calls.spawn[0];
    const { anchorEntity, ...rest } = context;
    assert.deepStrictEqual(rest, { systemID: SYSTEM, scene: g.scene, preferredTargetID: 0,
      anchorKind: "stargate", anchorLabel: "Stargate (X)" });
    assert.notStrictEqual(anchorEntity, g.scene.getEntityByID(GATE), "synthetic anchor, see AR-G");
    assert.strictEqual(selection.data.selectionID, "lne_ambient:500010:amb:1:1");
    assert.deepStrictEqual(options, { entityType: "npc", transient: true, operatorKind: "lneAmbient",
      selectionID: "lne_ambient:500010:amb:1:1", preferredTargetID: 0, behaviorOverrides: { ...NAVY_PASSIVE_BEHAVIOR },
      spawnDistanceMeters: 3000, spreadMeters: 2000, formationSpacingMeters: 2000, anchorKind: "stargate",
      anchorID: GATE, anchorName: "Stargate (X)", spawnSiteID: "amb:1:1", deferGroupBehaviorTick: true });
    assert.ok(!("ownerIDOverride" in options) && !("allowFriendlyNpcTargets" in options));
    assert.deepStrictEqual(g.seam.spawnGroup({ ...input, anchorId: 123 }), { ok: false, reason: "ANCHOR_GONE" });

    const navy = g.seam.spawnGroup({ ...input, factionId: AMARR, source: { type: "navy" } });
    assert.strictEqual(navy.ok, true);
    assert.strictEqual(g.calls.plan[1][1].factionKey, "guristas", "template key for the hull classes");
    const prof = NAVY_PROFILES_BY_FACTION_ID[String(AMARR)];
    assert.deepStrictEqual(g.calls.spawn[1][1].data.definitions.map((d) => d.profile.profileID),
      [prof.frigate, prof.cruiser], "navy definitions, not pirates");

    const bad = fakeGame({ planDefs: [{ profile: { name: "Pithi titan" } }] });
    const refused = bad.seam.spawnGroup({ ...input, factionId: AMARR, source: { type: "navy" } });
    assert.deepStrictEqual([refused.ok, refused.reason, refused.detail], [false, "NAVY_FAILED", "HULL_UNKNOWN"]);
    assert.strictEqual(bad.calls.spawn.length, 0, "never a pirate group for an empire");
    assert.strictEqual(g.seam.spawnGroup({ ...input, factionId: 500007, source: { type: "navy" } }).reason, "NAVY_FAILED");
  });

  test("ARS3 classifyIds and snapshot; an effect capsule is no blocker; no scene = store only", () => {
    const g = fakeGame({ storeIds: [903] });
    g.scene.dynamicEntities.set(906, { itemID: 906, nativeNpc: true, transient: true, lneCapsuleFx: true,
      position: { x: 8, y: 8, z: 8 } });
    assert.deepStrictEqual(g.seam.classifyIds(SYSTEM, [900, 903, 905]), { ok: true, live: [900], dormant: [903],
      gone: [905] });
    const snap = g.seam.snapshot(SYSTEM, { anchorKinds: "stargate,station" });
    assert.deepStrictEqual(snap, { ok: true,
      anchors: [{ itemId: GATE, kind: "stargate", position: { x: 1, y: 0, z: 0 } },
        { itemId: STATION, kind: "station", position: { x: 2, y: 0, z: 0 } }],
      blockers: [{ x: 5, y: 6, z: 7 }], ambientIds: [900, 903] });

    const cold = fakeGame({ loaded: false, storeIds: [903] });
    assert.deepStrictEqual(cold.seam.classifyIds(SYSTEM, [900, 903]), { ok: true, live: [], dormant: [903],
      gone: [900] });
    assert.strictEqual(cold.calls.sceneGet, 0, "no scene read without a loaded scene");
    assert.deepStrictEqual(cold.seam.snapshot(SYSTEM, { anchorKinds: "stargate" }), { ok: false,
      reason: "SCENE_NOT_LOADED" });
    assert.strictEqual(cold.seam.spawnGroup({ systemId: SYSTEM, anchorId: GATE, factionId: 500010,
      source: { type: "pirate", factionKey: "guristas" }, minCount: 1, maxCount: 2, distanceFromSurfaceMeters: 20000,
      groupKey: "k" }).reason, "SCENE_NOT_LOADED");
    assert.deepStrictEqual([cold.calls.sceneGet, cold.calls.plan.length], [0, 0]);
  });

  test("ARS4 observeKill: an ambient victim reaches no listener, an ordinary victim as before", () => {
    const seen = [];
    const listener = (name) => () => ({ onNpcKill: (k) => { seen.push([name, k.victimId]); return { ok: true }; } });
    const deps = { resolveVictimFactionID: () => 500010, getLiberation: listener("liberation"),
      getStandings: listener("standings"), getPlayerActivity: listener("playerActivity"),
      getFrontJobs: listener("frontJobs"), isNavyVictim: () => false, isAmbientVictim: seams.isAmbientVictim };
    const options = { nowMs: 5, systemID: SYSTEM };
    assert.deepStrictEqual(observeKill({ applied: true }, { operatorKind: " lneAmbient ", itemID: 1 }, 7, options, deps),
      { skipped: "AMBIENT" });
    assert.deepStrictEqual(observeKill({ applied: true }, { selectionID: "lne_ambient:500010:amb:1:1", itemID: 2 }, 7,
      options, deps), { skipped: "AMBIENT" });
    assert.deepStrictEqual(seen, [], "no listener for the ambient");
    const ok = observeKill({ applied: true }, { selectionID: "belt_rat:guristas:nullsec", itemID: 3 }, 7, options, deps);
    assert.deepStrictEqual(Object.keys(ok.results), ["liberation", "standings", "playerActivity", "frontJobs"]);
    assert.deepStrictEqual(seen.map((s) => s[1]), [3, 3, 3, 3]);
  });

  test("ARS5 facade on the real createAdapter: getAmbientRatTools / checkAmbientRatSeams", () => {
    const { createAdapter } = require("../../lib/adapter");
    const adapter = createAdapter({ moduleApi: { _cache: {} } });
    assert.strictEqual(typeof adapter.getAmbientRatTools, "function");
    assert.strictEqual(typeof adapter.checkAmbientRatSeams, "function");
    const tools = adapter.getAmbientRatTools();
    assert.deepStrictEqual([tools.ok, tools.reason], [false, "SEAM_UNAVAILABLE"], "server src unknown");
    assert.strictEqual(adapter.checkAmbientRatSeams().ok, false);
    const g = fakeGame();
    assert.deepStrictEqual(seams.checkAmbientRatSeamsFrom(g.requireGame), { ok: true });
    assert.deepStrictEqual(Object.keys(g.seam).sort(), ["bandOf", "classifyIds", "setAggro", "snapshot", "spawnGroup"]);
  });

  test("AR-G spawnGroup: synthetic anchor at radius + distance, radius 0, spawnDistanceMeters, anchorID kept", () => {
    const g = fakeGame();
    const draws = [0.75, 0.25];
    let i = 0;
    const random = () => draws[i++ % draws.length];
    const res = g.seam.spawnGroup({ systemId: SYSTEM, anchorId: PLANET, factionId: 500010,
      source: { type: "pirate", factionKey: "guristas" }, minCount: 2, maxCount: 5, distanceFromSurfaceMeters: 20000,
      groupKey: "amb:1:2", random });
    assert.strictEqual(res.ok, true, JSON.stringify(res));
    const [context, , options] = g.calls.spawn[0];
    const planet = g.scene.getEntityByID(PLANET);
    const a = context.anchorEntity;
    const d = Math.hypot(a.position.x - planet.position.x, a.position.y - planet.position.y,
      a.position.z - planet.position.z);
    assert.ok(Math.abs(d - (6000000 + 20000)) < 1e-3, `centre at radius + distance (${d})`);
    assert.deepStrictEqual([a.itemID, a.kind, a.itemName, a.radius, a.direction],
      [PLANET, "planet", "Planet (X)", 0, planet.direction]);
    assert.deepStrictEqual(planet.position, { x: 3, y: 0, z: 0 }, "scene entity not mutated");
    assert.strictEqual(options.spawnDistanceMeters, 3000);
    assert.ok(!("distanceFromSurfaceMeters" in options));
    assert.strictEqual(options.anchorID, PLANET);
  });

  test("AR-S setAggro: armed overrides exact, idempotent, disarm restores passive, missing, no scene load", () => {
    const g = fakeGame();
    const R = 150000;
    const armedOverrides = { autoAggro: false, proximityAggroRangeMeters: R, proximityAggroTargetClasses: ["player"] };
    assert.deepStrictEqual(g.seam.setAggro(SYSTEM, [900], true, R), { ok: true, changed: 1, missing: 0 });
    assert.deepStrictEqual(g.calls.overrides, [[900, armedOverrides]]);
    assert.deepStrictEqual(g.seam.setAggro(SYSTEM, [900], true, R), { ok: true, changed: 0, missing: 0 }, "idempotent");
    assert.deepStrictEqual(g.seam.setAggro(SYSTEM, [900], false, R), { ok: true, changed: 1, missing: 0 });
    assert.deepStrictEqual(g.controllers.get(900).behaviorOverrides, { ...NAVY_PASSIVE_BEHAVIOR });
    assert.deepStrictEqual(g.seam.setAggro(SYSTEM, [900], false, R), { ok: true, changed: 0, missing: 0 });
    assert.deepStrictEqual(g.seam.setAggro(SYSTEM, [905], true, R), { ok: true, changed: 0, missing: 1 }, "no controller");
    assert.strictEqual(g.seam.setAggro(SYSTEM, [900], true, 0).reason, "INVALID_INPUT");
    assert.strictEqual(g.calls.overrides.length, 2);
    const cold = fakeGame({ loaded: false });
    assert.deepStrictEqual(cold.seam.setAggro(SYSTEM, [900], true, R), { ok: false, reason: "SCENE_NOT_LOADED" });
    assert.deepStrictEqual([cold.calls.sceneGet, cold.calls.overrides.length], [0, 0]);
  });

  test("AR-V vendor facts: proximity aggro whitelist and gate, spawnDistanceMeters first, setBehaviorOverrides", () => {
    const loop = readSource("space/npc/npcBehaviorLoop.js");
    const normalize = block(loop, "normalizeBehaviorOverrides");
    assert.ok(normalize.includes("\"proximityAggroRangeMeters\","), "numeric whitelist");
    assert.ok(normalize.includes("overrides.proximityAggroTargetClasses !== undefined"), "target classes");
    assert.match(loop, /if \(behaviorProfile\.autoAggro === false\) \{[\s\S]*?if \(proximityAggroRangeMeters <= 0\) \{/,
      "proximity only under autoAggro false");
    const anchors = readSource("space/npc/npcAnchors.js");
    assert.match(block(anchors, "resolveSpawnDistance"),
      /options\.spawnDistanceMeters[\s\S]*options\.distanceFromSurfaceMeters/, "explicit distance first");
    assert.ok(block(anchors, "buildOffsetSpawnState").includes("buildRandomUnitVector()"), "direction per ship");
    assert.match(exportsBlock(readSource("space/npc/npcService.js")), /\n {2}setBehaviorOverrides,\n/);
    const npc = GAME_MODULES.find((m) => m.path === "space/npc/npcService");
    for (const name of ["setBehaviorOverrides", "getControllerByEntityID"]) {
      const s = npc.symbols.find((x) => x.name === name);
      assert.ok(s.consumers.includes("ambientRats") && !s.wrap && !s.firstLoad, name);
    }
  });

  test("AR-HS vendor gate CONCORD NPC aggro flag: schema key + default false, the gate rule; "
    + "readConcordGateNpcAggro on a fake requireGame; GAME_MODULES consumer; method on the real adapter", () => {
    const KEY = "npcDefaultConcordGateAutoAggroNpcsEnabled";
    const lines = readSource("config/schema/npc.js").split("\n");
    const at = lines.findIndex((l) => l.trim() === `"key": "${KEY}",`);
    assert.ok(at >= 0, "schema key");
    assert.strictEqual(lines[at + 1].trim(), "\"defaultValue\": false,");
    const gate = block(readSource("space/npc/npcDefaultConcordRules.js"), "buildGateBehaviorOverrides");
    assert.ok(gate.includes(`config.${KEY} === true`), "gate rule");
    assert.ok(gate.includes("autoAggroTargetClasses: [ENTITY_TYPE.NPC]"), "NPC target class");
    assert.strictEqual(seams.CONCORD_GATE_AGGRO_KEY, KEY);

    const read = (rg) => seams.readConcordGateNpcAggroFrom(rg);
    const cfg = (exportsObj) => (rel) => (rel === "config/index" ? { ok: true, exports: exportsObj }
      : { ok: false, reason: "UNKNOWN" });
    assert.deepStrictEqual(read(cfg({ [KEY]: true })), { ok: true, enabled: true });
    assert.deepStrictEqual(read(cfg({ [KEY]: false })), { ok: true, enabled: false });
    assert.strictEqual(read(cfg({})).reason, "READ_FAILED");
    assert.strictEqual(read(cfg({ [KEY]: "false" })).reason, "READ_FAILED");
    assert.strictEqual(read(() => ({ ok: false, reason: "MODULE_NOT_FOUND" })).reason, "SEAM_UNAVAILABLE");
    assert.strictEqual(read(null).reason, "SEAM_UNAVAILABLE");
    const throwing = { get [KEY]() { throw new Error("boom"); } };
    assert.strictEqual(read(cfg(throwing)).reason, "READ_FAILED");
    assert.strictEqual(read(() => { throw new Error("boom"); }).reason, "READ_FAILED");

    const config = GAME_MODULES.find((m) => m.path === "config/index");
    const s = config.symbols.find((x) => x.name === KEY);
    assert.ok(s && s.kind === "property" && s.consumers.includes("ambientRatsHighsec") && !s.wrap && !s.firstLoad);
    const { createAdapter } = require("../../lib/adapter");
    const adapter = createAdapter({ moduleApi: { _cache: {} } });
    assert.strictEqual(typeof adapter.readConcordGateNpcAggro, "function");
    assert.strictEqual(adapter.readConcordGateNpcAggro().ok, false, "server src unknown: structured refusal");
  });
};
