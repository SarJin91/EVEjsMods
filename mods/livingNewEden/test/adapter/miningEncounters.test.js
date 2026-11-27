"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const seams = require("../../lib/adapter/miningEncounters");
const { GAME_MODULES } = require("../../lib/adapter/gameModules");

const SERVER_SRC = path.resolve(__dirname, "..", "..", "..", "..", "server", "src");
const SYSTEM = 30002510;
const CHAR = 90000123;
const BELT = 40160001;
const SHIP = 140000001;

function readSource(rel) {
  return fs.readFileSync(path.join(SERVER_SRC, rel), "utf8").replace(/\r\n/g, "\n");
}

function fakeGame({ docked = false, belt = BELT, groups = [], spawn, plan } = {}) {
  const calls = [];
  const plans = [];
  const session = { characterID: CHAR, ...(docked ? { stationid: 60000001 } : {}) };
  const ship = { itemID: SHIP, position: { x: 0, y: 0, z: 0 } };
  const beltEntity = { itemID: BELT, kind: "asteroidBelt" };
  const dynamicEntities = new Map(groups.map((g, i) => [500 + i, { itemID: 500 + i, nativeNpc: true,
    operatorKind: "asteroidBeltRat", ...g }]));
  const scene = { sessions: new Map([[1, session]]), dynamicEntities,
    getShipEntityForSession: (s) => (s === session ? ship : null),
    getEntityByID: (id) => (id === BELT ? beltEntity : null) };
  const modules = {
    "space/runtime": { isSolarSystemSceneLoaded: (id) => id === SYSTEM, scenes: new Map([[SYSTEM, scene]]) },
    "space/npc/beltRatRuntime": {
      OPERATOR_KIND: "asteroidBeltRat",
      resolveSecurityProfile: () => ({ band: "lowsec", minCount: 2, maxCount: 4, securityStatus: 0.3, eligible: true }),
      findNearestBeltForEntity: () => (belt ? beltEntity : null),
      maybeSpawnForSessionArrival: (...args) => {
        calls.push(args);
        return spawn ? spawn(args[3]) : { success: true, spawned: true, data: { spawned: [{}, {}] } };
      },
      buildBeltRatSpawnPlan: (systemId, options) => {
        plans.push([systemId, options]);
        return plan ? plan(options) : { success: true, data: { selectionID: "belt_rat:guristas:lowsec",
          selectionName: "x", definitions: Array.from({ length: options.minCount }, (_, i) => ({ i })) } };
      },
    },
    "config/index": { asteroidBeltNpcRatsEnabled: true, asteroidBeltNpcRatSpecialsEnabled: false },
    "services/mining/miningLedgerState": { recordMiningLedgerEvent: () => ({ success: true }) },
  };
  const requireGame = (rel) => (modules[rel] ? { ok: true, exports: modules[rel] } : { ok: false, reason: "missing" });
  const spawns = [];
  const getSpawnTools = () => ({ ok: true, spawnNativeDefinitionsInContext: (context, selection, options) => {
    spawns.push({ context, selection, options });
    return { success: true, data: { spawned: selection.data.definitions.map(() => ({})) } };
  } });
  return { calls, plans, spawns, requireGame, getSpawnTools, session, ship };
}

module.exports = ({ test }) => {
  test("MEA1 vendor facts: ledger export not called inside, wave options of beltRatRuntime, GAME_MODULES consumers",
    () => {
      const ledger = readSource("services/mining/miningLedgerState.js");
      assert.match(ledger, /^function recordMiningLedgerEvent\(/m, "definer");
      assert.match(ledger, /^ {2}recordMiningLedgerEvent,$/m, "exported");
      assert.strictEqual(ledger.split("recordMiningLedgerEvent(").length - 1, 1, "only the definition, no inner call");
      const belt = readSource("space/npc/beltRatRuntime.js");
      for (const fact of ["options.forceSpawn", "options.minCount", "options.forceSpecialSpawnKind",
        "\"SPECIAL_SPAWN_NOT_ELIGIBLE\"", "options.targetEntityID", "options.skipSpecialSpawns === true"]) {
        assert.ok(belt.includes(fact), fact);
      }
      const consumers = (p, name) => (GAME_MODULES.find((e) => e.path === p) || { symbols: [] }).symbols
        .find((s) => s.name === name && s.consumers.includes("miningEncounters"));
      const wrap = consumers("services/mining/miningLedgerState", "recordMiningLedgerEvent");
      assert.deepStrictEqual([wrap.kind, wrap.wrap, wrap.firstLoad], ["export", true, undefined]);
      for (const name of ["maybeSpawnForSessionArrival", "resolveSecurityProfile", "findNearestBeltForEntity",
        "OPERATOR_KIND"]) assert.ok(consumers("space/npc/beltRatRuntime", name), name);
      assert.strictEqual(consumers("space/npc/beltRatRuntime", "OPERATOR_KIND").kind, "property");
    });

  test("MEA2 ledger wrap: this/args/result kept, sink only on success, sink throw counted, second wrap noop", () => {
    const seen = [];
    let errors = 0;
    let sinkThrows = false;
    const sink = { onLedgerEvent: (e) => { if (sinkThrows) throw new Error("boom"); seen.push(e); } };
    const original = function original(payload) {
      return { success: payload.ok === true, self: this, payload };
    };
    const w = seams.wrapLedgerForEncounters(original, { getSink: () => sink, onError: () => { errors += 1; } });
    assert.strictEqual(w.ok, true);
    const self = { tag: 1 };
    const p = { ok: true, characterID: CHAR, solarSystemID: SYSTEM, eventDateMs: 5, yieldKind: "Ore " };
    const r = w.wrapped.call(self, p);
    assert.deepStrictEqual([r.success, r.self, r.payload], [true, self, p], "result of the original unchanged");
    w.wrapped.call(self, { ok: false, characterID: CHAR, solarSystemID: SYSTEM });
    assert.deepStrictEqual(seen, [{ characterId: CHAR, systemId: SYSTEM, yieldKind: "ore" }],
      "sink once, success only, yieldKind normalised");
    sinkThrows = true;
    assert.strictEqual(w.wrapped.call(self, p).success, true, "a sink throw never reaches the vendor");
    assert.strictEqual(errors, 1);
    assert.deepStrictEqual(seams.wrapLedgerForEncounters(w.wrapped, { getSink: () => sink }),
      { ok: true, wrapped: w.wrapped, noop: true });
    assert.strictEqual(seams.wrapLedgerForEncounters(null, { getSink: () => sink }).reason, "NOT_A_FUNCTION");
    assert.strictEqual(seams.wrapLedgerForEncounters(original, {}).reason, "SINK_NOT_A_FUNCTION");
  });

  test("MEA3 spawnWave: officer not eligible -> commander spawned (degraded), options of the vendor call", () => {
    const g = fakeGame({ spawn: (o) => (o.forceSpecialSpawnKind === "officer"
      ? { success: false, spawned: false, reason: "SPECIAL_SPAWN_NOT_ELIGIBLE" }
      : { success: true, spawned: true, data: { spawned: [{}] } }) });
    const seam = seams.createMiningEncounterSeam({ requireGame: g.requireGame });
    const res = seam.spawnWave({ characterId: CHAR, systemId: SYSTEM, beltId: BELT, minCount: 3, maxCount: 5,
      specialChain: ["officer", "commander", "hauler"], nowMs: 1000 });
    assert.deepStrictEqual(res, { ok: true, kind: "commander", ships: 1, degraded: true });
    assert.strictEqual(g.calls.length, 2, "stops at the first spawn");
    const [scene, session, ship, options] = g.calls[1];
    assert.ok(scene && session === g.session && ship === g.ship);
    assert.deepStrictEqual(options, { forceSpawn: true, targetEntityID: BELT, skipSpecialSpawns: true, minCount: 3,
      maxCount: 5, preferredTargetID: SHIP, nowMs: 1000, forceSpecialSpawnKind: "commander" });
    const plain = fakeGame();
    const normal = seams.createMiningEncounterSeam({ requireGame: plain.requireGame }).spawnWave({ characterId: CHAR,
      systemId: SYSTEM, beltId: BELT, minCount: 2, maxCount: 2, specialChain: [] });
    assert.deepStrictEqual(normal, { ok: true, kind: "normal", ships: 2, degraded: false });
    assert.strictEqual("forceSpecialSpawnKind" in plain.calls[0][3], false);
  });

  test("MEA4 locate: DOCKED, NOT_AT_BELT, one rat group on the belt and one elsewhere; bandOf and vendor flags", () => {
    const docked = seams.createMiningEncounterSeam({ requireGame: fakeGame({ docked: true }).requireGame });
    assert.strictEqual(docked.locate({ characterId: CHAR, systemId: SYSTEM }).reason, "DOCKED");
    const off = seams.createMiningEncounterSeam({ requireGame: fakeGame({ belt: null }).requireGame });
    assert.strictEqual(off.locate({ characterId: CHAR, systemId: SYSTEM }).reason, "NOT_AT_BELT");
    assert.strictEqual(off.locate({ characterId: CHAR, systemId: SYSTEM + 1 }).reason, "SCENE_NOT_LOADED");
    const g = fakeGame({ groups: [{ anchorID: BELT, spawnSiteID: "a" }, { anchorID: BELT, spawnSiteID: "a" },
      { anchorID: BELT + 1, spawnSiteID: "b" }] });
    const seam = seams.createMiningEncounterSeam({ requireGame: g.requireGame });
    assert.deepStrictEqual(seam.locate({ characterId: CHAR, systemId: SYSTEM }),
      { ok: true, beltId: BELT, shipId: SHIP, groupsOnBelt: 1, groupsInSystem: 2 });
    assert.deepStrictEqual(seam.bandOf(SYSTEM),
      { ok: true, band: "lowsec", eligible: true, baseMin: 2, baseMax: 4, security: 0.3 });
    assert.deepStrictEqual(seam.readVendorBeltFlags(), { ok: true, ratsEnabled: true, specialsEnabled: false });
    assert.deepStrictEqual(seams.checkMiningEncounterSeamsFrom(g.requireGame), { ok: true });
  });

  test("MEA5 facade on the real createAdapter: getMiningEncounterTools / checkMiningEncounterSeams", () => {
    const { createAdapter } = require("../../lib/adapter");
    const adapter = createAdapter({ moduleApi: { _cache: {} } });
    assert.strictEqual(typeof adapter.getMiningEncounterTools, "function");
    assert.strictEqual(typeof adapter.checkMiningEncounterSeams, "function");
    const tools = adapter.getMiningEncounterTools();
    assert.deepStrictEqual([tools.ok, tools.reason], [false, "SEAM_UNAVAILABLE"], "server src unknown");
    assert.strictEqual(adapter.checkMiningEncounterSeams().ok, false);
  });

  test("MEA6 anomaly spawnWave: plan via buildBeltRatSpawnPlan with min/max + chain, spawn at the ship, own markers",
    () => {
      const g = fakeGame({ belt: null, plan: (o) => (o.forceSpecialSpawnKind === "officer"
        ? { success: false, errorMsg: "SPECIAL_SPAWN_NOT_ELIGIBLE" }
        : { success: true, data: { selectionID: "belt_rat:guristas:lowsec:commander", selectionName: "c",
          definitions: [{ a: 1 }] } }) });
      const seam = seams.createMiningEncounterSeam({ requireGame: g.requireGame, getSpawnTools: g.getSpawnTools });
      const res = seam.spawnWave({ characterId: CHAR, systemId: SYSTEM, beltId: null, anchor: "ship",
        spawnDistanceMeters: 20000, minCount: 3, maxCount: 5, specialChain: ["officer", "commander"], nowMs: 1 });
      assert.deepStrictEqual(res, { ok: true, kind: "commander", ships: 1, degraded: true });
      assert.deepStrictEqual(g.plans, [[SYSTEM, { skipSpecialSpawns: true, minCount: 3, maxCount: 5,
        forceSpecialSpawnKind: "officer" }], [SYSTEM, { skipSpecialSpawns: true, minCount: 3, maxCount: 5,
        forceSpecialSpawnKind: "commander" }]], "no factionKey: the faction comes from the LNE projection");
      assert.strictEqual(g.calls.length, 0, "never the vendor belt entry (no belt state, no belt navy)");
      assert.strictEqual(g.spawns.length, 1);
      const { context, selection, options } = g.spawns[0];
      assert.ok(context.anchorEntity === g.ship && context.preferredTargetID === SHIP && context.anchorKind === "ship");
      assert.strictEqual(context.scene.instanceID, undefined, "solar system scene, no dungeon instance");
      assert.strictEqual(selection.data.selectionKind, "lneMiningWave");
      assert.deepStrictEqual([options.transient, options.preferredTargetID, options.operatorKind, options.selectionKind,
        options.anchorID, options.spawnDistanceMeters, options.selectionID],
      [true, SHIP, "lneMiningWave", "lneMiningWave", SHIP, 20000, "lne_mining_wave:belt_rat:guristas:lowsec:commander"]);
      assert.ok(options.spawnSiteID.startsWith(`lne_mining_wave:${CHAR}:`), options.spawnSiteID);
      const plain = fakeGame({ belt: null });
      const normal = seams.createMiningEncounterSeam({ requireGame: plain.requireGame,
        getSpawnTools: plain.getSpawnTools }).spawnWave({ characterId: CHAR, systemId: SYSTEM, anchor: "ship",
        spawnDistanceMeters: 20000, minCount: 2, maxCount: 4, specialChain: [] });
      assert.deepStrictEqual(normal, { ok: true, kind: "normal", ships: 2, degraded: false });
      assert.strictEqual("forceSpecialSpawnKind" in plain.plans[0][1], false);
    });

  test("MEA7 anomaly locate: flag off (no anomaly input) = NOT_AT_BELT, on = ship anchor; busy within 2x distance",
    () => {
      const groups = [
        { operatorKind: "lneMiningWave", spawnSiteID: "lne_mining_wave:1:1", position: { x: 39000, y: 0, z: 0 } },
        { operatorKind: "lneMiningWave", spawnSiteID: "lne_mining_wave:1:1", position: { x: 41000, y: 0, z: 0 } },
        { operatorKind: "lneMiningWave", spawnSiteID: "lne_mining_wave:2:1", position: { x: 90000, y: 0, z: 0 } },
        { anchorID: BELT + 1, spawnSiteID: "b" },
      ];
      const seam = seams.createMiningEncounterSeam({ requireGame: fakeGame({ belt: null, groups }).requireGame });
      assert.strictEqual(seam.locate({ characterId: CHAR, systemId: SYSTEM }).reason, "NOT_AT_BELT");
      assert.deepStrictEqual(seam.locate({ characterId: CHAR, systemId: SYSTEM, anomaly: { distanceMeters: 20000 } }),
        { ok: true, beltId: null, anchor: "ship", shipId: SHIP, groupsOnBelt: 1, groupsInSystem: 3 });
      const far = seam.locate({ characterId: CHAR, systemId: SYSTEM, anomaly: { distanceMeters: 10000 } });
      assert.deepStrictEqual([far.groupsOnBelt, far.groupsInSystem], [0, 3], "nothing within 20 km");
      const onBelt = seams.createMiningEncounterSeam({ requireGame: fakeGame({ groups }).requireGame })
        .locate({ characterId: CHAR, systemId: SYSTEM, anomaly: { distanceMeters: 20000 } });
      assert.deepStrictEqual([onBelt.beltId, onBelt.anchor, onBelt.groupsOnBelt], [BELT, undefined, 0],
        "a belt keeps the path");
    });

  test("MEA8 vendor facts and GAME_MODULES: buildBeltRatSpawnPlan export, spawner options, consumer miningEncounters",
    () => {
      const belt = readSource("space/npc/beltRatRuntime.js");
      assert.match(belt, /^function buildBeltRatSpawnPlan\(systemID, options = \{\}\)/m);
      assert.match(belt, /^ {2}buildBeltRatSpawnPlan,$/m);
      assert.ok(belt.includes("const factionKey = resolveConcretePirateFactionKey(systemID, options);"));
      const anchors = readSource("space/npc/npcAnchors.js");
      assert.ok(anchors.includes("toFiniteNumber(options.spawnDistanceMeters, 0)"), "explicit spawn distance");
      const native = readSource("space/npc/nativeNpcService.js");
      for (const fact of ["context && context.anchorEntity", "operatorKind: String(options.operatorKind",
        "spawnSiteID: String(options.spawnSiteID"]) assert.ok(native.includes(fact), fact);
      const consumers = (p, name) => (GAME_MODULES.find((e) => e.path === p) || { symbols: [] }).symbols
        .find((s) => s.name === name && s.consumers.includes("miningEncounters"));
      assert.ok(consumers("space/npc/beltRatRuntime", "buildBeltRatSpawnPlan"));
      assert.ok(consumers("space/npc/nativeNpcService", "spawnNativeDefinitionsInContext"));
    });

  test("MEA9 config keys and the service: anomaly input only with anomalyEnabled, ship anchor passed to spawnWave",
    () => {
      const { resolveConfig } = require("../../config");
      const { startMiningEncounters } = require("../../lib/miningEncounters/index");
      const modDir = path.resolve(__dirname, "..", "..");
      const base = resolveConfig({ modDir, env: {} }).config.miningEncounters;
      assert.deepStrictEqual([base.anomalyEnabled, base.anomalySpawnDistanceMeters], [false, 20000]);
      const clamped = resolveConfig({ modDir, env: { EVEJS_LNE_MINING_ENCOUNTERS_ANOMALY_SPAWN_DISTANCE_METERS: "1" } });
      assert.strictEqual(clamped.config.miningEncounters.anomalySpawnDistanceMeters, 5000);
      const run = (anomalyEnabled, yieldKind = "ore") => {
        const seen = { locate: [], spawn: [] };
        const seam = {
          bandOf: () => ({ ok: true, band: "lowsec", eligible: true, baseMin: 2, baseMax: 3, security: 0.3 }),
          locate: (a) => { seen.locate.push(a); return a.anomaly ? { ok: true, beltId: null, anchor: "ship",
            shipId: SHIP, groupsOnBelt: 0, groupsInSystem: 0 } : { ok: false, reason: "NOT_AT_BELT" }; },
          spawnWave: (a) => { seen.spawn.push(a); return { ok: true, kind: "normal", ships: 2, degraded: false }; },
          readVendorBeltFlags: () => ({ ok: true, ratsEnabled: true, specialsEnabled: false }),
        };
        const S = { ...base, enabled: true, threshold: 1, anomalyEnabled };
        const enc = startMiningEncounters({ config: { miningEncounters: S }, clock: { now: () => 1e7 }, seam,
          rng: () => 0, defer: () => {} }).encounters;
        enc.onLedgerEvent({ characterId: CHAR, systemId: SYSTEM, yieldKind });
        enc.flushNow();
        return seen;
      };
      const off = run(false);
      assert.deepStrictEqual([off.locate.length, "anomaly" in off.locate[0], off.spawn.length], [1, false, 0]);
      const on = run(true);
      assert.deepStrictEqual(on.locate[0].anomaly, { distanceMeters: 20000 });
      assert.deepStrictEqual([on.spawn[0].beltId, on.spawn[0].anchor, on.spawn[0].spawnDistanceMeters],
        [null, "ship", 20000]);
      for (const kind of ["gas", "ice", ""]) {
        const r = run(true, kind);
        assert.deepStrictEqual([r.locate.length, "anomaly" in r.locate[0], r.spawn.length], [1, false, 0], kind);
      }
    });

  test("MEA10 hauler wave: entityIds of spawnWave, warpOutHaulers states and refusals, warpOff vendor facts", () => {
    const anomaly = fakeGame({ belt: null });
    anomaly.getSpawnTools = () => ({ ok: true, spawnNativeDefinitionsInContext: () => ({ success: true,
      data: { spawned: [{ entity: { itemID: 701 } }, { entity: { itemID: 702 } }, {}] } }) });
    const res = seams.createMiningEncounterSeam({ requireGame: anomaly.requireGame, getSpawnTools: anomaly.getSpawnTools })
      .spawnWave({ characterId: CHAR, systemId: SYSTEM, anchor: "ship", spawnDistanceMeters: 20000, minCount: 2,
        maxCount: 2, specialChain: ["hauler"] });
    assert.deepStrictEqual(res, { ok: true, kind: "hauler", ships: 3, degraded: false, entityIds: [701, 702] });
    const belt = fakeGame({ spawn: () => ({ success: true, spawned: true, data: { spawned: [{ entity: { itemID: 9 } }] } }) });
    assert.deepStrictEqual(seams.createMiningEncounterSeam({ requireGame: belt.requireGame }).spawnWave({
      characterId: CHAR, systemId: SYSTEM, beltId: BELT, minCount: 1, maxCount: 1, specialChain: ["hauler"] }),
    { ok: true, kind: "hauler", ships: 1, degraded: false, entityIds: [9] });

    const g = fakeGame();
    const scene = g.requireGame("space/runtime").exports.scenes.get(SYSTEM);
    const ents = new Map([[801, { itemID: 801, position: { x: 160000, y: 0, z: 0 } }],
      [802, { itemID: 802, position: { x: 50000, y: 0, z: 0 } }], [804, { itemID: 804, position: { x: 1, y: 0, z: 0 } }]]);
    scene.getEntityByID = (id) => ents.get(id) || null;
    const orders = [];
    let refuse = false;
    const npc = {
      getControllerByEntityID: (id) => (ents.has(id) ? { manualOrder: id === 804 ? { type: "warpOff" } : null } : null),
      issueManualOrder: (id, order) => { orders.push([id, order]); return refuse ? { success: false, errorMsg: "NPC_NOT_FOUND" }
        : { success: true }; },
      wakeNpcController: () => ({ success: true }),
    };
    const requireGame = (rel) => (rel === "space/npc/npcService" ? { ok: true, exports: npc } : g.requireGame(rel));
    const seam = seams.createMiningEncounterSeam({ requireGame });
    const input = { systemId: SYSTEM, characterId: CHAR, entityIds: [801, 802, 803, 804], rangeMeters: 150000 };
    assert.deepStrictEqual(seam.warpOutHaulers(input), { ok: true, ships: [{ entityId: 801, state: "ordered" },
      { entityId: 802, state: "staying" }, { entityId: 803, state: "gone" }, { entityId: 804, state: "leaving" }] });
    assert.deepStrictEqual(orders, [[801, { type: "warpOff", awayFromPosition: { x: 0, y: 0, z: 0 } }]],
      "away from the miner's ship");
    assert.deepStrictEqual(seam.warpOutHaulers({ ...input, entityIds: [802], force: true }).ships,
      [{ entityId: 802, state: "ordered" }], "force: whatever the distance");
    g.session.stationid = 60000001;
    orders.length = 0;
    assert.strictEqual(seam.warpOutHaulers({ ...input, entityIds: [802] }).ships[0].state, "ordered", "miner docked");
    assert.strictEqual(orders[0][1].awayFromPosition, null);
    refuse = true;
    assert.deepStrictEqual(seam.warpOutHaulers({ ...input, entityIds: [802] }).ships,
      [{ entityId: 802, state: "failed", detail: "NPC_NOT_FOUND" }]);
    assert.strictEqual(seam.warpOutHaulers({ ...input, systemId: SYSTEM + 1 }).reason, "SCENE_NOT_LOADED");
    assert.strictEqual(seam.warpOutHaulers({ ...input, entityIds: [] }).reason, "READ_FAILED");
    assert.strictEqual(seams.createMiningEncounterSeam({ requireGame: g.requireGame }).warpOutHaulers(input).reason,
      "SEAM_UNAVAILABLE", "no npcService");

    const loop = readSource("space/npc/npcBehaviorLoop.js");
    for (const fact of ["if (manualOrder && manualOrder.type === \"warpOff\") {", "const from = order && order.awayFromPosition;",
      "getNativeNpcService().destroyNativeNpcController(controller, { scene });\n      return \"removed\";"]) {
      assert.ok(loop.includes(fact), fact);
    }
    assert.match(readSource("space/npc/npcService.js"), /^ {2}issueManualOrder,$/m);
    const consumers = (p, name) => (GAME_MODULES.find((e) => e.path === p) || { symbols: [] }).symbols
      .find((s) => s.name === name && s.consumers.includes("miningEncounters"));
    for (const name of ["issueManualOrder", "wakeNpcController", "getControllerByEntityID"]) {
      assert.ok(consumers("space/npc/npcService", name), name);
    }
  });

  test("MEA11 SPECIAL_SPAWN_POOL_NOT_FOUND falls through the chain on the belt and the anomaly path; vendor facts",
    () => {
      const g = fakeGame({ spawn: (o) => (o.forceSpecialSpawnKind === "officer"
        ? { success: false, reason: "SPECIAL_SPAWN_POOL_NOT_FOUND" }
        : { success: true, spawned: true, data: { spawned: [{}, {}] } }) });
      const res = seams.createMiningEncounterSeam({ requireGame: g.requireGame }).spawnWave({ characterId: CHAR,
        systemId: SYSTEM, beltId: BELT, minCount: 2, maxCount: 3, specialChain: ["officer", "commander", "hauler"] });
      assert.deepStrictEqual(res, { ok: true, kind: "commander", ships: 2, degraded: true });
      assert.deepStrictEqual(g.calls.map((c) => c[3].forceSpecialSpawnKind), ["officer", "commander"]);

      const anomaly = (errorMsg) => {
        const a = fakeGame({ belt: null, plan: (o) => (o.forceSpecialSpawnKind === "officer"
          ? { success: false, errorMsg }
          : { success: true, data: { selectionID: "s", selectionName: "c", definitions: [{ a: 1 }] } }) });
        const r = seams.createMiningEncounterSeam({ requireGame: a.requireGame, getSpawnTools: a.getSpawnTools })
          .spawnWave({ characterId: CHAR, systemId: SYSTEM, anchor: "ship", spawnDistanceMeters: 20000, minCount: 2,
            maxCount: 3, specialChain: ["officer", "commander"] });
        return { r, kinds: a.plans.map((p) => p[1].forceSpecialSpawnKind) };
      };
      const pool = anomaly("SPECIAL_SPAWN_POOL_NOT_FOUND");
      assert.deepStrictEqual(pool.r, { ok: true, kind: "commander", ships: 1, degraded: true });
      assert.deepStrictEqual(pool.kinds, ["officer", "commander"]);
      for (const errorMsg of ["SPECIAL_NPC_DEFINITION_INCOMPLETE", "SECURITY_BAND_NOT_ELIGIBLE"]) {
        const other = anomaly(errorMsg);
        assert.deepStrictEqual([other.r.ok, other.r.reason, other.r.detail, other.kinds],
          [false, "SPAWN_FAILED", errorMsg, ["officer"]], errorMsg);
      }

      const belt = readSource("space/npc/beltRatRuntime.js");
      assert.ok(belt.includes("\"SPECIAL_SPAWN_POOL_NOT_FOUND\""), "vendor refusal string");
      const officers = belt.match(/const OFFICER_POOL_QUERY_BY_FACTION = Object\.freeze\(\{([^}]*)\}\);/);
      assert.ok(officers, "officer pool table");
      assert.ok(/\bguristas:/.test(officers[1]), "table parsed");
      assert.strictEqual(/\brogue_drones\b/.test(officers[1]), false, "no rogue_drones officer pool");
    });
};
