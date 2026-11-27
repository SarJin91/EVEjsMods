"use strict";

process.env.EVEJS_SKYHOOKFIX_NO_INSTALL = "1";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const Module = require("node:module");

const modDir = path.resolve(__dirname, "..");
const runtimeRoot = path.resolve(modDir, "../..");
const loader = require(path.join(modDir, "loader.js"));
const configModule = require(path.join(modDir, "config.js"));
const viability = require(path.join(modDir, "lib", "viability.js"));
const patch = require(path.join(modDir, "lib", "patch.js"));

const SOV_FILE = path.join(runtimeRoot, "server", "src", "services", "sovereignty", "sovStaticData.js");
const WORLD_FILE = path.join(runtimeRoot, "server", "src", "space", "worldData.js");
const HARVEST_FILE = path.join(runtimeRoot, "server", "src", "services", "sovereignty", "skyhookHarvest.js");

const onlyAt = process.argv.indexOf("--only");
const only = onlyAt < 0 ? null : String(process.argv[onlyAt + 1] || "").split(",").filter(Boolean);

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

const HISEC_PLANET = Object.freeze({ itemID: 40242000, groupID: 7, kind: "planet", solarSystemID: 30003830 });
const MOON = Object.freeze({ itemID: 40242001, groupID: 8, kind: "moon", solarSystemID: 30003830 });

function fakeCelestials(id) {
  return [HISEC_PLANET, MOON].find((entry) => entry.itemID === id) || null;
}

function makeSnapshot() {
  const sovDefinition = { planetID: 40000002, solarSystemID: 30000001, power: 3, workforce: 4, reagentDefinitions: [{ reagentTypeID: 81143 }] };
  const planetDefinitionsByPlanetID = new Map([[40000002, sovDefinition]]);
  return {
    sovDefinition,
    snapshot: {
      planetDefinitions: [sovDefinition],
      planetDefinitionsByPlanetID,
      planetDefinitionsVersion: { major: 24, minor: 1, patch: 0 },
      planetsBySolarSystemID: new Map([[30000001, [40000002]]]),
    },
  };
}

function makeRuntime(extra = {}) {
  const lines = [];
  const errors = [];
  const runtime = loader._testing.createRuntime({
    runtimeRoot,
    logFn: (message) => lines.push(message),
    logErrorFn: (message) => errors.push(message),
    ...extra,
  });
  return { runtime, lines, errors };
}

function withHook(runtime, root, fn) {
  const savedLoad = Module._load;
  try {
    const hookState = loader._testing.installModuleHook(runtime, root, () => {});
    return fn(hookState);
  } finally {
    Module._load = savedLoad;
  }
}

function dropRealSov() {
  delete require.cache[SOV_FILE];
}

test("T1 patch: non-sov planet -> empty definition, non-planet -> undefined, sov planet -> vendor object", () => {
  const { snapshot, sovDefinition } = makeSnapshot();
  const resolver = patch.createEmptyDefinitionResolver(fakeCelestials);
  assert.deepStrictEqual(patch.patchSnapshot(snapshot, resolver), { ok: true });
  const map = snapshot.planetDefinitionsByPlanetID;
  const empty = map.get(HISEC_PLANET.itemID);
  assert.deepStrictEqual(empty, {
    planetID: HISEC_PLANET.itemID,
    solarSystemID: HISEC_PLANET.solarSystemID,
    power: 0,
    workforce: 0,
    reagentDefinitions: [],
  });
  assert.strictEqual(Object.isFrozen(empty), true);
  assert.strictEqual(map.get(String(HISEC_PLANET.itemID)), empty, "Number() key, cached object");
  assert.strictEqual(map.get(MOON.itemID), undefined);
  assert.strictEqual(map.get(99), undefined);
  assert.strictEqual(map.get(0), undefined);
  assert.strictEqual(map.get(40000002), sovDefinition);
  assert.strictEqual(map.get("40000002"), sovDefinition);
  assert.strictEqual(map.get("x"), undefined);
  assert.strictEqual(resolver.cacheSize(), 1, "misses are not cached");
});

test("T1b patch: a Symbol key does not throw out of map.get; the guarded lookup counts one failure", () => {
  const { snapshot } = makeSnapshot();
  const resolver = patch.createEmptyDefinitionResolver(fakeCelestials);
  const failures = [];
  assert.deepStrictEqual(patch.patchSnapshot(snapshot, resolver, (message) => failures.push(message)), { ok: true });
  const map = snapshot.planetDefinitionsByPlanetID;
  assert.strictEqual(map.get(Symbol("planet")), undefined);
  assert.strictEqual(map.get(Symbol("planet")), undefined);
  assert.strictEqual(failures.length, 1, "onError once (first failure only)");
  assert.strictEqual(map.get("40000002"), snapshot.planetDefinitions[0], "string key still finds the vendor row");
});

test("T2 patch: has/size/keys/array/version untouched; a second patch changes nothing", () => {
  const { snapshot } = makeSnapshot();
  const array = snapshot.planetDefinitions;
  const version = snapshot.planetDefinitionsVersion;
  const map = snapshot.planetDefinitionsByPlanetID;
  const resolver = patch.createEmptyDefinitionResolver(fakeCelestials);
  patch.patchSnapshot(snapshot, resolver);
  map.get(HISEC_PLANET.itemID);
  assert.strictEqual(snapshot.planetDefinitionsByPlanetID, map);
  assert.strictEqual(map.has(HISEC_PLANET.itemID), false);
  assert.strictEqual(map.size, 1);
  assert.deepStrictEqual([...map.keys()], [40000002]);
  assert.deepStrictEqual(Object.keys(map), [], "get is not enumerable");
  assert.strictEqual(snapshot.planetDefinitions, array);
  assert.strictEqual(array.length, 1);
  assert.strictEqual(snapshot.planetDefinitionsVersion, version);
  const patchedGet = map.get;
  assert.deepStrictEqual(patch.patchSnapshot(snapshot, resolver), { ok: true, reason: "already-patched" });
  assert.strictEqual(map.get, patchedGet);
  assert.deepStrictEqual(patch.patchSnapshot({ planetDefinitionsByPlanetID: map }, resolver), { ok: true, reason: "already-patched" });
  assert.strictEqual(map.get, patchedGet);
  assert.deepStrictEqual(patch.patchSnapshot(null, resolver), { ok: false, reason: "no-snapshot" });
  assert.deepStrictEqual(patch.patchSnapshot({}, resolver), { ok: false, reason: "no-planet-map" });
});

test("T3 chain: an earlier foreign get patch is called first and its answer wins", () => {
  const { snapshot } = makeSnapshot();
  const map = snapshot.planetDefinitionsByPlanetID;
  const vendorGet = map.get;
  const calls = [];
  const drillDefinition = { planetID: 40242000, reagentDefinitions: [{ reagentTypeID: 1 }] };
  map.get = function get(id) {
    calls.push(id);
    return id === 40242000 ? drillDefinition : vendorGet.call(this, id);
  };
  patch.patchSnapshot(snapshot, patch.createEmptyDefinitionResolver(fakeCelestials));
  assert.strictEqual(map.get(40242000), drillDefinition);
  assert.strictEqual(map.get(MOON.itemID), undefined);
  assert.deepStrictEqual(calls, [40242000, MOON.itemID]);
  const second = makeSnapshot().snapshot;
  const errors = [];
  patch.patchSnapshot(second, patch.createEmptyDefinitionResolver(() => { throw new Error("world not loaded"); }), (m) => errors.push(m));
  assert.strictEqual(second.planetDefinitionsByPlanetID.get(1), undefined);
  assert.strictEqual(second.planetDefinitionsByPlanetID.get(2), undefined);
  assert.strictEqual(errors.length, 1);
});

test("T4 flag off -> no hook, snapshot untouched; invalid value refused; default on", () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "sof-cfg-"));
  assert.strictEqual(configModule.load(empty, {}).enabled, true);
  assert.strictEqual(configModule.load(empty, { EVEJS_SKYHOOKFIX_ENABLED: "false" }).enabled, false);
  assert.strictEqual(configModule.load(empty, { EVEJS_SKYHOOKFIX_ENABLED: "maybe" }).problems.length, 1);
  fs.rmSync(empty, { recursive: true, force: true });
  const savedLoad = Module._load;
  const lines = [];
  const disabled = loader.install({ runtimeRoot, environment: { EVEJS_SKYHOOKFIX_ENABLED: "0" }, logFn: (m) => lines.push(m) });
  assert.strictEqual(disabled.reason, "disabled");
  assert.strictEqual(Module._load, savedLoad);
  assert.deepStrictEqual(lines, [], "disabled is silent");
  assert.strictEqual(globalThis[loader.INSTALL_FLAG], undefined);
  const invalid = loader.install({ runtimeRoot, environment: { EVEJS_SKYHOOKFIX_ENABLED: "maybe" }, logErrorFn: () => {} });
  assert.strictEqual(invalid.reason, "invalid-config");
  assert.strictEqual(Module._load, savedLoad);
});

test("T5 vendor facts: every seam token of the real EveJS files exactly once", () => {
  const report = viability.inspect(runtimeRoot);
  assert.strictEqual(report.ok, true, JSON.stringify(report.reports.filter((entry) => !entry.ok)));
  const consumers = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules") walk(full);
      } else if (entry.name.endsWith(".js")) {
        const source = fs.readFileSync(full, "utf8").replace(/\r\n/gu, "\n");
        if (!source.includes("planetDefinitionsByPlanetID")) continue;
        for (const match of source.matchAll(/planetDefinitionsByPlanetID([^\n]{0,8})/gu)) {
          consumers.push(`${path.relative(runtimeRoot, full).replace(/\\/gu, "/")}${match[1].slice(0, 5)}`);
        }
      }
    }
  };
  walk(path.join(runtimeRoot, "server", "src", "services"));
  walk(path.join(runtimeRoot, "server", "src", "_secondary"));
  const reads = consumers.filter((entry) => !/sovStatic(Data|Authority)\.js/u.test(entry));
  assert.deepStrictEqual(
    reads.map((entry) => entry.replace(/^.*\.js/u, "")).filter((tail) => tail !== ".get(" && tail !== ";"),
    [],
    `non-get uses of the planet map: ${JSON.stringify(reads)}`,
  );
  const broken = viability.inspect(runtimeRoot, [{ key: "x", file: "server/src/space/worldData.js", required: ["no such token"] }]);
  assert.strictEqual(broken.ok, false);
  assert.match(broken.reports[0].reason, /count 0, expected 1/u);
});

test("T6 real vendor: hook wraps sovStaticData.getSovereigntyStaticSnapshot, non-sov planet gets the empty definition", () => {
  dropRealSov();
  const { runtime, lines, errors } = makeRuntime();
  withHook(runtime, runtimeRoot, (hookState) => {
    const sov = require(SOV_FILE);
    const world = require(WORLD_FILE);
    assert.strictEqual(hookState.pending.size, 0, JSON.stringify(errors));
    assert.strictEqual(sov.getSovereigntyStaticSnapshot[loader.WRAPPED], true);
    const savedLookup = world.getCelestialByID;
    world.getCelestialByID = (id) => fakeCelestials(Number(id));
    try {
      const snapshot = sov.getSovereigntyStaticSnapshot();
      assert.strictEqual(sov.getSovereigntyStaticSnapshot(), snapshot, "memoised identity kept (ensureLoaded)");
      const map = snapshot.planetDefinitionsByPlanetID;
      const listBefore = snapshot.planetDefinitions.length;
      const versionBefore = JSON.stringify(snapshot.planetDefinitionsVersion);
      const sizeBefore = map.size;
      const sovDefinition = { planetID: 40000002, solarSystemID: 30000001, power: 1, workforce: 2, reagentDefinitions: [] };
      Map.prototype.set.call(map, 40000002, sovDefinition);
      assert.strictEqual(map.get(40000002), sovDefinition, "sov-null planet: vendor object unchanged");
      const empty = map.get(HISEC_PLANET.itemID);
      assert.strictEqual(empty.solarSystemID, HISEC_PLANET.solarSystemID, "readDeployedSkyhookOrbitals solarSystemID check");
      assert.deepStrictEqual(empty.reagentDefinitions, []);
      assert.strictEqual(map.get(MOON.itemID), undefined);
      assert.strictEqual(map.has(HISEC_PLANET.itemID), false);
      assert.strictEqual(map.size, sizeBefore + 1);
      Map.prototype.delete.call(map, 40000002);
      assert.strictEqual(snapshot.planetDefinitions.length, listBefore);
      assert.strictEqual(JSON.stringify(snapshot.planetDefinitionsVersion), versionBefore);
      assert.strictEqual(runtime.stats.snapshotsPatched, 1);
      const wrappedFn = sov.getSovereigntyStaticSnapshot;
      const again = makeRuntime();
      again.runtime.applyWorld(world);
      assert.deepStrictEqual(again.runtime.applySov(sov), { ok: true });
      assert.strictEqual(sov.getSovereigntyStaticSnapshot, wrappedFn);
      assert.deepStrictEqual(runtime.applySov(sov), { ok: true });
      assert.strictEqual(sov.getSovereigntyStaticSnapshot, wrappedFn);
    } finally {
      world.getCelestialByID = savedLookup;
    }
  });
  assert.deepStrictEqual(errors, []);
  assert.strictEqual(lines.filter((line) => /active - wrapped/u.test(line)).length, 1);
  dropRealSov();
});

test("T7 empty reagents: the real harvest settles nothing; refusals pinned by T5 tokens", () => {
  const { settleSkyhookHarvest } = require(HARVEST_FILE);
  const empty = patch.createEmptyDefinitionResolver(fakeCelestials)(HISEC_PLANET.itemID);
  const record = {
    active: true,
    destroyed: false,
    reagentDefinitions: empty.reagentDefinitions.map((entry) => ({ ...entry })),
    reagentSimulations: (empty.reagentDefinitions || []).map(() => ({})),
  };
  assert.strictEqual(settleSkyhookHarvest(record, Date.now() + 86400000), record);
  assert.deepStrictEqual(record.reagentSimulations, []);
  assert.strictEqual(record.reagentDefinitions[0], undefined);
  assert.strictEqual(record.reagentSimulations.some((row) => row.unsecuredStock > 0), false);
  assert.strictEqual((record.reagentDefinitions || []).length > 0, false);
});

test("T8 DRIFT: missing export or missing worldData lookup -> inert, export untouched", () => {
  const missing = makeRuntime({ inspect: () => ({ ok: true, reports: [] }) });
  assert.deepStrictEqual(missing.runtime.applySov({}), { ok: false, reason: "pending" });
  assert.deepStrictEqual(missing.runtime.applySov({ buildSovereigntyStaticSnapshot() {} }), { ok: false, reason: "drift" });
  assert.match(missing.errors[0], /^DRIFT sovStaticData\.getSovereigntyStaticSnapshot - mod inert/u);
  assert.deepStrictEqual(missing.runtime.applySov({ getSovereigntyStaticSnapshot() {} }), { ok: false, reason: "inert" });

  const noWorld = makeRuntime({ inspect: () => ({ ok: true, reports: [] }) });
  noWorld.runtime.applyWorld({ getCelestials() {} });
  const exports = { getSovereigntyStaticSnapshot: () => makeSnapshot().snapshot };
  const original = exports.getSovereigntyStaticSnapshot;
  assert.deepStrictEqual(noWorld.runtime.applySov(exports), { ok: false, reason: "drift" });
  assert.strictEqual(exports.getSovereigntyStaticSnapshot, original);
  assert.match(noWorld.errors[0], /DRIFT worldData\.getCelestialByID/u);

  const badProbe = makeRuntime({ inspect: () => ({ ok: false, reports: [{ key: "sovModernState", ok: false, reason: "seam count 0" }] }) });
  badProbe.runtime.applyWorld({ getCelestialByID: fakeCelestials });
  assert.deepStrictEqual(badProbe.runtime.applySov(exports), { ok: false, reason: "drift" });
  assert.strictEqual(exports.getSovereigntyStaticSnapshot, original);
  assert.deepStrictEqual(badProbe.errors.slice(0, 1), ["DRIFT sovModernState: seam count 0"]);

  const frozen = makeRuntime({ inspect: () => ({ ok: true, reports: [] }) });
  frozen.runtime.applyWorld({ getCelestialByID: fakeCelestials });
  const snap = makeSnapshot().snapshot;
  Object.freeze(snap.planetDefinitionsByPlanetID);
  const frozenExports = { getSovereigntyStaticSnapshot: () => snap };
  frozen.runtime.applySov(frozenExports);
  assert.strictEqual(frozenExports.getSovereigntyStaticSnapshot(), snap);
  assert.strictEqual(frozenExports.getSovereigntyStaticSnapshot(), snap);
  assert.strictEqual(frozen.runtime.stats.patchFailures, 2);
  assert.strictEqual(frozen.errors.filter((m) => /snapshot patch failed/u.test(m)).length, 1);
});

test("T9 deployment: entrypoint requires the loader in both blocks, after moonOreAnomalies, before livingNewEden", () => {
  const entrypoint = fs.readFileSync(path.join(runtimeRoot, "docker", "entrypoint.sh"), "utf8");
  const line = "--require /app/mods/skyhookOrphanFix/loader.js";
  assert.strictEqual(entrypoint.split(line).length - 1, 2);
  const blocks = entrypoint.split("exec node").slice(1);
  assert.strictEqual(blocks.length, 2);
  for (const block of blocks) {
    const at = block.indexOf(line);
    assert.ok(at > block.indexOf("--require /app/mods/moonOreAnomalies/loader.js"));
    assert.ok(block.indexOf("--require /app/mods/moonOreAnomalies/loader.js") >= 0);
    assert.ok(at < block.indexOf("--require /app/mods/livingNewEden/loader.js"));
  }
});

let passed = 0;
let failed = 0;
const selected = tests.filter((entry) => !only || only.some((fragment) => entry.name.includes(fragment)));
for (const entry of selected) {
  try {
    entry.fn();
    passed += 1;
    console.log(`PASS ${entry.name}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL ${entry.name}`);
    console.log(error && error.stack ? error.stack : error);
  }
}
console.log(`${passed}/${selected.length} PASS`);
process.exitCode = failed > 0 ? 1 : 0;
