"use strict";

process.env.SCENEPERF_NO_INSTALL = "1";

const assert = require("assert");
const path = require("path");

const { loadConfig, DEFAULTS } = require("../config");
const { createAdvanceWrapper, isInertEntity } = require("../lib/inertWrecks");
const { createCachedResolver } = require("../lib/itemNameCache");
const { targetOf, createState, patchExports, installHook, probeMessage } = require("../loader");

const SERVER_SRC = path.resolve(__dirname, "../../../server/src");
const results = [];

function test(name, fn) {
  try {
    fn();
    results.push(["PASS", name]);
  } catch (error) {
    results.push(["FAIL", name, error && error.stack || String(error)]);
  }
}

const config = loadConfig({ env: {}, settingsPath: path.join(__dirname, "missing.json") });

function fakeAdvance(calls) {
  return function advance(scene, entity) {
    calls.push(entity.itemID);
    if (Number(entity._lastMovementAdvancedTickSequence) === scene._activeTickSequence) {
      return { advanced: false, result: { changed: false, movementAlreadyAdvanced: true } };
    }
    entity._lastMovementAdvancedTickSequence = scene._activeTickSequence;
    return { advanced: true, result: { changed: true } };
  };
}
function fakeMark(marked) {
  return function mark(scene, entity) {
    if (!scene || !entity || !(scene._activeTickSequence > 0)) return false;
    marked.push(entity.itemID);
    entity._lastMovementAdvancedTickSequence = scene._activeTickSequence;
    return true;
  };
}

function wreck(id, extra = {}) {
  return { itemID: id, kind: "wreck", mode: "STOP", velocity: { x: 0, y: 0, z: 0 }, ...extra };
}

function sceneOf(entities, seq = 1) {
  return { _activeTickSequence: seq, dynamicEntities: new Map(entities.map((e) => [e.itemID, e])) };
}

function freshStats() {
  return { ticks: 0, skipped: 0, maxSkippedPerTick: 0, errors: 0, lastError: null };
}

test("C1 config: default values", () => {
  assert.strictEqual(config.skipInertWrecks, true);
  assert.deepStrictEqual(config.inertKinds, ["wreck"]);
  assert.strictEqual(config.itemNameCacheMax, DEFAULTS.itemNameCacheMax);
});

test("C2 config: env overrides, an invalid value falls back to the default", () => {
  const c = loadConfig({
    env: { EVEJS_SCENEPERF_SKIP_WRECKS: "0", EVEJS_SCENEPERF_INERT_KINDS: "wreck, Container", EVEJS_SCENEPERF_NAME_CACHE_MAX: "abc" },
    settingsPath: path.join(__dirname, "missing.json"),
  });
  assert.strictEqual(c.skipInertWrecks, false);
  assert.deepStrictEqual(c.inertKinds, ["wreck", "container"]);
  assert.strictEqual(c.itemNameCacheMax, DEFAULTS.itemNameCacheMax);
});

test("W1 isInertEntity: a stopped wreck yes; moving, other kind, non-STOP, with a session — no", () => {
  assert.strictEqual(isInertEntity(wreck(1), config), true);
  assert.strictEqual(isInertEntity(wreck(1, { velocity: undefined }), config), true);
  assert.strictEqual(isInertEntity(wreck(1, { velocity: { x: 5, y: 0, z: 0 } }), config), false);
  assert.strictEqual(isInertEntity(wreck(1, { kind: "ship" }), config), false);
  assert.strictEqual(isInertEntity(wreck(1, { mode: "FOLLOW" }), config), false);
  assert.strictEqual(isInertEntity(wreck(1, { pendingWarp: {} }), config), false);
  assert.strictEqual(isInertEntity(wreck(1, { session: {} }), config), false);
});

test("W2 the first object of a tick marks all stopped wrecks, ships move normally", () => {
  const calls = []; const marked = []; const stats = freshStats();
  const ship = { itemID: 100, kind: "ship", mode: "FOLLOW", velocity: { x: 10, y: 0, z: 0 } };
  const moving = wreck(3, { velocity: { x: 1, y: 0, z: 0 } });
  const scene = sceneOf([ship, wreck(1), wreck(2), moving]);
  const wrapped = createAdvanceWrapper(fakeAdvance(calls), fakeMark(marked), config, stats);
  const results = [...scene.dynamicEntities.values()].map((e) => wrapped(scene, e));
  assert.deepStrictEqual(marked, [1, 2]);
  assert.deepStrictEqual(calls, [100, 1, 2, 3], "original called for every object");
  assert.strictEqual(results[0].advanced, true);
  assert.strictEqual(results[1].result.movementAlreadyAdvanced, true);
  assert.strictEqual(results[3].advanced, true, "a moving wreck is computed normally");
  assert.deepStrictEqual([stats.ticks, stats.skipped, stats.maxSkippedPerTick], [1, 2, 2]);
});

test("W3 next tick: wrecks marked again, once per tick", () => {
  const calls = []; const marked = []; const stats = freshStats();
  const scene = sceneOf([wreck(1), wreck(2)], 7);
  const wrapped = createAdvanceWrapper(fakeAdvance(calls), fakeMark(marked), config, stats);
  wrapped(scene, scene.dynamicEntities.get(1));
  wrapped(scene, scene.dynamicEntities.get(2));
  scene._activeTickSequence = 8;
  wrapped(scene, scene.dynamicEntities.get(1));
  assert.deepStrictEqual(marked, [1, 2, 1, 2]);
  assert.strictEqual(stats.ticks, 2);
});

test("W4 no active tick (seq 0): nothing is marked", () => {
  const marked = []; const stats = freshStats();
  const scene = sceneOf([wreck(1)], 0);
  const wrapped = createAdvanceWrapper(fakeAdvance([]), fakeMark(marked), config, stats);
  wrapped(scene, scene.dynamicEntities.get(1));
  assert.deepStrictEqual(marked, []);
});

test("W5 an error while marking does not block the original", () => {
  const calls = []; const stats = freshStats();
  const scene = sceneOf([wreck(1)]);
  const wrapped = createAdvanceWrapper(fakeAdvance(calls), () => { throw new Error("boom"); }, config, stats);
  const r = wrapped(scene, scene.dynamicEntities.get(1));
  assert.strictEqual(r.advanced, true);
  assert.deepStrictEqual(calls, [1]);
  assert.strictEqual(stats.errors, 1);
});

test("N1 name cache: the second call comes from the cache, the result is a copy", () => {
  let n = 0; const stats = { hits: 0, misses: 0, clears: 0 };
  const original = (q) => { n += 1; return { success: false, errorMsg: "NOT_FOUND", suggestions: [q] }; };
  const cached = createCachedResolver(original, config, stats);
  const a = cached("Foo Wreck");
  a.suggestions.push("mut");
  const b = cached("Foo Wreck");
  assert.strictEqual(n, 1);
  assert.deepStrictEqual(b.suggestions, ["Foo Wreck"]);
  assert.deepStrictEqual([stats.hits, stats.misses], [1, 1]);
  cached("Foo Wreck", { limit: 3 });
  assert.strictEqual(n, 2, "other options = another entry");
});

test("N2 name cache cleared after exceeding the limit", () => {
  const stats = { hits: 0, misses: 0, clears: 0 };
  const cached = createCachedResolver((q) => ({ success: true, q }), { ...config, itemNameCacheMax: 2 }, stats);
  cached("a"); cached("b"); cached("c");
  assert.strictEqual(stats.clears, 1);
});

test("L1 targetOf recognizes only server/src files", () => {
  assert.strictEqual(targetOf("/app/server/src/space/runtime/destinyMovementEngine.js"), "engine");
  assert.strictEqual(targetOf("C:\\EveJS\\server\\src\\services\\inventory\\itemTypeRegistry.js"), "registry");
  assert.strictEqual(targetOf("/app/mods/x/space/runtime/destinyMovementEngine.js"), null);
});

test("L2 patchExports is idempotent; missing markEntity… = DRIFT, no replacement", () => {
  const state = createState(config);
  const exp = { advanceEntityForActiveSceneTick() {}, markEntityMovementAdvancedForActiveTick() {} };
  patchExports("engine", exp, state);
  const first = exp.advanceEntityForActiveSceneTick;
  patchExports("engine", exp, state);
  assert.strictEqual(exp.advanceEntityForActiveSceneTick, first);
  assert.strictEqual(first.__scenePerfFix, true);
  const state2 = createState(config);
  const orig = function advanceEntityForActiveSceneTick() {};
  const exp2 = { advanceEntityForActiveSceneTick: orig };
  patchExports("engine", exp2, state2);
  assert.strictEqual(exp2.advanceEntityForActiveSceneTick, orig);
  assert.deepStrictEqual(state2.drift, ["destinyMovementEngine.markEntityMovementAdvancedForActiveTick"]);
});

test("R1 real itemTypeRegistry: replaced and the same result as the original", () => {
  const registry = require(path.join(SERVER_SRC, "services/inventory/itemTypeRegistry.js"));
  const original = registry.resolveItemByName;
  const expectedHit = original("Tritanium");
  const expectedMiss = original("Zzqx Nonexistent Wreck");
  const state = createState(config);
  patchExports("registry", registry, state);
  try {
    assert.strictEqual(state.patched.registry, true);
    assert.deepStrictEqual(registry.resolveItemByName("Tritanium"), expectedHit);
    assert.deepStrictEqual(registry.resolveItemByName("Zzqx Nonexistent Wreck"), expectedMiss);
    assert.deepStrictEqual(registry.resolveItemByName("Zzqx Nonexistent Wreck"), expectedMiss);
    assert.strictEqual(state.nameStats.hits, 1);
  } finally {
    registry.resolveItemByName = original;
  }
});

test("R2 real destinyMovementEngine 261028.1: wreck part inactive, probe without DRIFT", () => {
  const fs = require("fs");
  const engine = require(path.join(SERVER_SRC, "space/runtime/destinyMovementEngine.js"));
  assert.strictEqual(typeof engine.advanceEntityForActiveSceneTick, "undefined");
  assert.strictEqual(typeof engine.markEntityMovementAdvancedForActiveTick, "undefined");
  assert.strictEqual(fs.existsSync(path.join(SERVER_SRC, "space/destiny/simulation/nativeSubwarp.js")), false);
  const evolveEngine = require(path.join(SERVER_SRC, "space/destiny/simulation/evolve.js"));
  assert.strictEqual(typeof evolveEngine.evolve, "function", "Evolve computes movement for the whole scene");
  const tick = fs.readFileSync(path.join(SERVER_SRC, "space/runtime/scene/tick.js"), "utf8");
  assert.ok(!tick.includes("advanceEntityForActiveSceneTick"), "tick.js does not call movement per object");
  const before = Object.keys(engine).map((k) => [k, engine[k]]);
  const state = createState(config);
  state.gameSeen = true;
  state.patched.registry = true;
  assert.strictEqual(patchExports("engine", engine, state), true);
  assert.strictEqual(patchExports("engine", engine, state), true);
  assert.deepStrictEqual(Object.keys(engine).map((k) => [k, engine[k]]), before, "exports unchanged");
  assert.strictEqual(state.obsolete.engine, true);
  assert.deepStrictEqual(state.drift, []);
  assert.ok(/^probe: passed/.test(probeMessage(state)), probeMessage(state));
});

test("R3 only one function or empty exports: still DRIFT / retry", () => {
  const onlyMark = createState(config);
  onlyMark.gameSeen = true;
  assert.strictEqual(patchExports("engine", { markEntityMovementAdvancedForActiveTick() {}, other() {} }, onlyMark), false);
  assert.strictEqual(onlyMark.obsolete.engine, false);
  assert.ok(probeMessage(onlyMark).includes("destinyMovementEngine.advanceEntityForActiveSceneTick"));
  const empty = createState(config);
  assert.strictEqual(patchExports("engine", {}, empty), false, "require cycle: exports still empty");
  assert.strictEqual(empty.obsolete.engine, false);
});

test("P1 process without game modules (helper): probe is silent; game process without symbols: DRIFT", () => {
  const helper = createState(config);
  assert.strictEqual(probeMessage(helper), null, "no DRIFT in a helper process");
  const game = createState(config);
  game.gameSeen = true;
  const message = probeMessage(game);
  assert.ok(/^DRIFT: /.test(message), message);
  assert.ok(message.includes("destinyMovementEngine.advanceEntityForActiveSceneTick"));
  assert.ok(message.includes("itemTypeRegistry.resolveItemByName"));
  game.patched = { engine: true, registry: true };
  assert.strictEqual(probeMessage(game), "probe: passed");
});

test("P2 hook recognizes the game process by a require from server/src/space/", () => {
  const Module = require("module");
  const saved = Module._load;
  const state = createState(config);
  try {
    installHook(state);
    Module._load("node:path", { filename: "/app/server/src/edge/chat/chatEdgeProcess.worker.js" }, false);
    Module._load("node:path", { filename: "/app/mods/x/space/a.js" }, false);
    assert.strictEqual(state.gameSeen, false, "helper process");
    assert.strictEqual(probeMessage(state), null);
    Module._load("node:path", { filename: "C:\\EveJS\\server\\src\\space\\runtime\\scene\\tick.js" }, false);
    assert.strictEqual(state.gameSeen, true, "game process");
    assert.ok(/^DRIFT: /.test(probeMessage(state)));
  } finally {
    Module._load = saved;
  }
});

let failed = 0;
for (const [status, name, detail] of results) {
  console.log(`${status} ${name}`);
  if (status === "FAIL") {
    failed += 1;
    console.log(detail);
  }
}
console.log(`\n${results.length - failed}/${results.length} PASS`);
process.exitCode = failed > 0 ? 1 : 0;
