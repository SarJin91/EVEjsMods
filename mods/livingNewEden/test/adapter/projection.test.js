"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");

const { wrapPirateFactionKey, projectFactionKey, WRAPPED } = require("../../lib/adapter/projection");
const { findServerSrcOnDisk } = require("../../lib/adapter/locator");
const { buildHooks, installModuleHook } = require("../../loader");
const { isMetricName } = require("../../lib/telemetry/registry");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const SERVER_SEARCH_MAX_DEPTH = 5;
const SANSHA = 500019;
const SERPENTIS = 500020;
const AMARR = 500003;
const CALDARI = 500001;
const BLOOD = 500012;
const TABLE = Object.freeze({ [SANSHA]: "sanshas" });

const SYS_A = 30000101;
const SYS_B = 30000102;
const SYS_C = 30000103;
const SYSTEMS = Object.freeze({
  [SYS_A]: { solarSystemID: SYS_A, factionID: SERPENTIS, regionID: 0 },
  [SYS_B]: { solarSystemID: SYS_B, factionID: CALDARI, regionID: 0 },
  [SYS_C]: { solarSystemID: SYS_C, factionID: BLOOD, regionID: 0 },
});
const CONTROLLERS = new Map([[SYS_A, SANSHA], [SYS_B, AMARR]]);

function findSrcDir() {
  const found = findServerSrcOnDisk(MOD_DIR, SERVER_SEARCH_MAX_DEPTH, fs.existsSync);
  return found.ok ? found.srcDir : null;
}

function spyLogger() {
  const lines = { log: [], error: [], debug: [] };
  return { lines, log: (m) => lines.log.push(m), logError: (m) => lines.error.push(m),
    debug: (m) => lines.debug.push(m) };
}

function okConfig(world = {}, worldModule = {}) {
  return { ok: true, sources: {}, warnings: [], errors: [], config: { enabled: true, debug: false,
    modules: { world: { enabled: true, ...worldModule } }, world: { projectionEnabled: true, ...world } } };
}

function fakeWorld() {
  return { getController: (id) => ({ ok: true, controllerFactionId: CONTROLLERS.has(id) ? CONTROLLERS.get(id) : null }) };
}

function fakeModule(file, exports) {
  const m = new Module(file);
  m.filename = file;
  m.loaded = true;
  m.exports = exports;
  return m;
}

function withRealChain(src, { order, config = okConfig(), world = fakeWorld(), telemetry = null }, fn) {
  const at = (...p) => require.resolve(path.join(src, ...p));
  const fakes = new Map([
    [at("config"), {}],
    [at("utils", "logger"), { info() {}, warn() {}, error() {}, debug() {}, log() {} }],
    [at("space", "worldData"), { getSolarSystemByID: (id) => SYSTEMS[id] || null }],
    [at("space", "npc", "npcData"), {}],
    [at("space", "npc", "npcHullDamageability"), {}],
    [at("space", "entityConstants"), { ENTITY_TYPE: {} }],
  ]);
  const policyFile = at("space", "npc", "pirateFactionPolicy");
  const beltFile = at("space", "npc", "beltRatRuntime");
  const reals = [at("common", "numbers"), policyFile, beltFile];
  const touched = [...fakes.keys(), ...reals];
  const previous = new Map(touched.map((key) => [key, require.cache[key]]));
  const originalLoad = Module._load;
  const logger = spyLogger();
  const ctx = { logger, loadConfig: () => config, world, telemetry,
    state: { configResult: null, projection: null, projectionFailureLogged: false } };
  try {
    for (const [file, exports] of fakes) require.cache[file] = fakeModule(file, exports);
    for (const file of reals) delete require.cache[file];
    installModuleHook(Module, buildHooks(ctx).filter((h) => h.name === "pirateFactionProjection"), logger);
    let policy;
    let belt;
    if (order === "belt") {
      belt = require(beltFile);
      policy = require(policyFile);
    } else {
      policy = require(policyFile);
      belt = require(beltFile);
    }
    return fn({ policy, belt, ctx, logger });
  } finally {
    Module._load = originalLoad;
    for (const key of touched) {
      delete require.cache[key];
      if (previous.get(key)) require.cache[key] = previous.get(key);
    }
  }
}

module.exports = ({ test, skip }) => {
  test("P1 projection decision + wrap: pirate controller -> key, else the original bit in bit; outcomes; noop", () => {
    const calls = [];
    const original = function vendor() {
      calls.push({ self: this, args: [...arguments], length: arguments.length });
      return "vendor";
    };
    const read = new Map([[1, { ok: true, controllerFactionId: SANSHA }], [2, { ok: true, controllerFactionId: null }],
      [3, { ok: true, controllerFactionId: AMARR }], [4, { ok: false, reason: "WORLD_UNAVAILABLE" }],
      [6, { ok: false, reason: "TX_ACTIVE" }]]);
    const outcomes = [];
    const wrap = wrapPirateFactionKey(original, {
      pirateKeyByFactionId: TABLE,
      readController: (id) => { if (id === 5) throw new Error("boom"); return read.get(id); },
      onOutcome: (o, r) => outcomes.push(`${o}:${r}`),
    });
    assert.strictEqual(wrap.ok, true);
    const fn = wrap.wrapped;
    assert.strictEqual(fn[WRAPPED], true);

    assert.strictEqual(fn(1), "sanshas");
    assert.strictEqual(calls.length, 0, "original not called for a pirate controller");

    const self = { tag: "this" };
    for (const id of [2, 3, 4, 5, 6]) assert.strictEqual(fn.call(self, id), "vendor", String(id));
    assert.strictEqual(fn.call(self, 1, { factionKey: "angels" }), "vendor", "explicit override");
    assert.strictEqual(fn.call(self, "abc"), "vendor", "bad id");
    assert.strictEqual(calls.length, 7);
    for (const c of calls) assert.strictEqual(c.self, self, "same this");
    assert.deepStrictEqual(calls.map((c) => c.length), [1, 1, 1, 1, 1, 2, 1], "same arguments.length (bit in bit)");
    assert.deepStrictEqual(calls[5].args, [1, { factionKey: "angels" }]);
    assert.deepStrictEqual(outcomes, ["projected:CONTROLLER_PIRATE", "vendor:NO_CONTROLLER", "vendor:NOT_PIRATE",
      "vendor:READ_WORLD_UNAVAILABLE", "failed:FAILED", "failed:READ_TX_ACTIVE", "vendor:EXPLICIT_OVERRIDE",
      "vendor:BAD_SYSTEM_ID"]);

    const loud = wrapPirateFactionKey(original, { pirateKeyByFactionId: TABLE,
      readController: () => ({ ok: true, controllerFactionId: SANSHA }), onOutcome: () => { throw new Error("x"); } });
    assert.strictEqual(loud.wrapped(9), "sanshas", "a throwing onOutcome does not change the result");

    const again = wrapPirateFactionKey(fn, { pirateKeyByFactionId: TABLE, readController: () => null });
    assert.deepStrictEqual([again.ok, again.wrapped, again.noop], [true, fn, true]);
    assert.deepStrictEqual(wrapPirateFactionKey(original, { pirateKeyByFactionId: null, readController: () => null }),
      { ok: false, reason: "PIRATE_TABLE_INVALID" });
    assert.strictEqual(wrapPirateFactionKey(null, {}).reason, "NOT_A_FUNCTION");
    assert.strictEqual(wrapPirateFactionKey(original, { pirateKeyByFactionId: TABLE }).reason,
      "READ_CONTROLLER_NOT_A_FUNCTION");
    assert.deepStrictEqual(projectFactionKey(7, undefined,
      { pirateKeyByFactionId: TABLE, readController: () => ({ ok: true, controllerFactionId: SANSHA }) }),
    { key: "sanshas", reason: "CONTROLLER_PIRATE" });
  });

  const src = findSrcDir();
  const p3 = "P3 projection on the real require chain: belt rat binding IS the wrap (both load orders), keys";
  const p4 = "P4 projection real chain: flag off / world off -> no wrap; throwing read -> vendor, counter, one line";
  if (!src) {
    skip(p3, "EveJS server/src not found above the mod");
    skip(p4, "EveJS server/src not found above the mod");
    return;
  }

  test(p3, () => {
    for (const order of ["belt", "policy"]) {
      withRealChain(src, { order }, ({ policy, belt, ctx }) => {
        assert.strictEqual(belt.resolvePirateFactionKeyForSystem, policy.resolvePirateFactionKeyForSystem,
          `${order}: beltRatRuntime's destructured binding (:22 = :342 = :1356) is the policy export`);
        assert.strictEqual(policy.resolvePirateFactionKeyForSystem[WRAPPED], true, `${order}: wrapped`);
        assert.strictEqual(ctx.state.projection, "wrapped");
        const vendor = (id) => policy.resolvePirateFactionForSystem(id, { allowSpecialSpaceEmpireFallback: true })
          .factionKey;
        assert.strictEqual(vendor(SYS_A), "serpentis", "fixture: the vendor alone says serpentis");
        assert.strictEqual(belt.resolvePirateFactionKeyForSystem(SYS_A), "sanshas", `${order}: mod controller wins`);
        assert.strictEqual(belt.resolvePirateFactionKeyForSystem(SYS_B), vendor(SYS_B), `${order}: empire -> vendor`);
        assert.strictEqual(belt.resolvePirateFactionKeyForSystem(SYS_C), vendor(SYS_C), `${order}: no row -> vendor`);
      });
    }
  });

  test(p4, () => {
    for (const [label, config] of [["projectionEnabled=false", okConfig({ projectionEnabled: false })],
      ["modules.world.enabled=false", okConfig({}, { enabled: false })]]) {
      withRealChain(src, { order: "belt", config }, ({ policy, belt, ctx }) => {
        assert.strictEqual(policy.resolvePirateFactionKeyForSystem[WRAPPED], undefined, `${label}: no wrap`);
        assert.strictEqual(belt.resolvePirateFactionKeyForSystem(SYS_A), "serpentis", `${label}: vendor key`);
        assert.strictEqual(ctx.state.projection, "disabled", label);
      });
    }
    const counts = [];
    const telemetry = { hooks: { onCount: (name, n) => counts.push([name, n]) } };
    const world = { getController: () => { throw new Error("db gone"); } };
    withRealChain(src, { order: "belt", world, telemetry }, ({ belt, logger }) => {
      assert.strictEqual(belt.resolvePirateFactionKeyForSystem(SYS_A), "serpentis");
      assert.strictEqual(belt.resolvePirateFactionKeyForSystem(SYS_A), "serpentis");
      assert.deepStrictEqual(counts, [["world.projection.failed", 1], ["world.projection.failed", 1]]);
      assert.ok(counts.every(([name]) => isMetricName(name)), JSON.stringify(counts));
      assert.strictEqual(logger.lines.log.filter((l) => l.includes("controller read failed")).length, 1,
        logger.lines.log.join("\n"));
    });
  });
};
