"use strict";

process.env.HOTPATH_NO_INSTALL = "1";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const Module = require("module");

const { loadConfig, DEFAULTS } = require("../config");
const { createRecorder, wrapTimed, wrapProperty } = require("../lib/slowCalls");
const loader = require("../loader");
const { POINTS, CACHE_MGR_HANDLERS, targetOf, createState, patchTarget, installHook, sweepModuleCache, probeMessage, install } = loader;

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

const config = loadConfig({ env: { HOTPATH_SOV_CAPTURE_OWNED_ECHO_SKIP: "0", HOTPATH_CYNO_BROADCAST_SESSION_FILTER: "0" },
  settingsPath: path.join(__dirname, "missing.json") });

function manualClock(msList) {
  const values = msList.map((ms) => BigInt(Math.round(ms * 1e6)));
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)];
}

function capture() {
  const lines = [];
  return { lines, log: (line) => lines.push(line) };
}

function src(rel) {
  return fs.readFileSync(path.join(SERVER_SRC, rel), "utf8");
}

function listJs(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) listJs(full, out);
    else if (entry.name.endsWith(".js")) out.push(full);
  }
  return out;
}

test("C1 config: defaults, env overrides, an invalid value falls back to the default", () => {
  assert.strictEqual(config.enabled, true);
  assert.strictEqual(config.slowCallMs, DEFAULTS.slowCallMs);
  for (const point of POINTS) assert.strictEqual(config[point.flag], true, point.flag);
  const c = loadConfig({
    env: { HOTPATH_SLOW_CALL_MS: "500", HOTPATH_MEASURE_ENSURE_SCENE: "0", HOTPATH_STATS_MINUTES: "abc" },
    settingsPath: path.join(__dirname, "missing.json"),
  });
  assert.strictEqual(c.slowCallMs, 500);
  assert.strictEqual(c.measureEnsureScene, false);
  assert.strictEqual(c.statsLogMinutes, DEFAULTS.statsLogMinutes);
  assert.deepStrictEqual(
    [config.sceneRetention, config.sceneRetentionPinDocked, config.sceneRetentionPinDockedMaxMinutes, config.sceneRetentionPinRecent,
      config.sceneRetentionRecentMinutes, config.sceneRetentionMaxPinnedPerCharacter, config.sceneRetentionMaxPinnedTotal,
      config.sceneRetentionRssCeilingMb],
    [false, true, 120, false, 10, 4, 16, 0]);
  const r = loadConfig({
    env: { HOTPATH_SCENE_RETENTION: "1", HOTPATH_SCENE_RETENTION_MAX_TOTAL: "3", HOTPATH_SCENE_RETENTION_PIN_RECENT: "on",
      HOTPATH_SCENE_RETENTION_DOCKED_MAX_MINUTES: "0", HOTPATH_SCENE_RETENTION_RSS_CEILING_MB: "-5" },
    settingsPath: path.join(__dirname, "missing.json"),
  });
  assert.deepStrictEqual([r.sceneRetention, r.sceneRetentionMaxPinnedTotal, r.sceneRetentionPinRecent, r.sceneRetentionPinDockedMaxMinutes,
    r.sceneRetentionRssCeilingMb], [true, 3, true, 0, 0]);
});

test("D1 wrapper: same this, arguments, result and exception as the original", () => {
  const out = capture();
  const recorder = createRecorder({ slowCallMs: 0 }, out.log);
  const value = { a: 1 };
  const holder = {
    k: 7,
    ok(x, y) { return { self: this, args: [x, y], value }; },
    bad() { const e = new Error("vendor boom"); e.code = "X"; throw e; },
  };
  assert.strictEqual(wrapProperty(holder, "ok", recorder, { name: "ok" }), true);
  assert.strictEqual(wrapProperty(holder, "bad", recorder, { name: "bad" }), true);
  const r = holder.ok(1, "b");
  assert.strictEqual(r.self, holder);
  assert.deepStrictEqual(r.args, [1, "b"]);
  assert.strictEqual(r.value, value);
  let caught = null;
  try { holder.bad(); } catch (error) { caught = error; }
  assert.ok(caught && caught.message === "vendor boom" && caught.code === "X", "same exception");
  assert.ok(out.lines.some((l) => l.startsWith("slow bad ") && l.endsWith(" threw")));
  const wrapped = wrapTimed(() => 42, recorder, { name: "ctx", context: () => { throw new Error("ctx"); } });
  assert.strictEqual(wrapped(), 42);
  assert.strictEqual(recorder.errors, 1);
  const first = holder.ok;
  wrapProperty(holder, "ok", recorder, { name: "ok" });
  assert.strictEqual(holder.ok, first);
});

test("D2 line only when time >= slowCallMs; stats n/sum/max", () => {
  const out = capture();
  const recorder = createRecorder({ slowCallMs: 100 }, out.log, { now: manualClock([0, 99, 1000, 1100, 2000, 2350]) });
  const fn = wrapTimed(() => 1, recorder, { name: "x", context: () => "ctx=1" });
  fn(); fn(); fn();
  assert.deepStrictEqual(out.lines, ["slow x 100.0ms ctx=1", "slow x 350.0ms ctx=1"]);
  const stats = recorder.drainStatsLines();
  assert.deepStrictEqual(stats, ["stats x n=3 sumMs=549.0 maxMs=350.0"]);
  assert.deepStrictEqual(recorder.drainStatsLines(), [], "stats window reset");
});

test("listInstancesByLifecycle: no line, stats per state with max length", () => {
  const out = capture();
  const recorder = createRecorder({ slowCallMs: 0 }, out.log);
  const state = createState(config, recorder);
  const exp = { listInstancesByLifecycle: (s) => (s === "active" ? [1, 2, 3] : []) };
  patchTarget("dungeonRuntime", exp, state);
  exp.listInstancesByLifecycle("active");
  exp.listInstancesByLifecycle("seeded");
  exp.listInstancesByLifecycle("active");
  exp.listInstancesByLifecycle("active", { full: true });
  exp.listInstancesByLifecycle("active", { full: false });
  assert.deepStrictEqual(out.lines, []);
  const lc = recorder.snapshot().lifecycle;
  assert.strictEqual(lc.get("active").n, 3);
  assert.strictEqual(lc.get("active").maxLength, 3);
  assert.strictEqual(lc.get("active/full").n, 1);
  assert.strictEqual(lc.get("seeded").maxLength, 0);
  assert.ok(recorder.drainStatsLines().some((l) => l.startsWith("stats dungeonRuntime.listInstancesByLifecycle[active/full] n=1 ")));
});

test("Context: GetMultiLocationsEx call number and ID count; ensureScene new=true", () => {
  const out = capture();
  const recorder = createRecorder({ slowCallMs: 0 }, out.log);
  const state = createState(config, recorder);
  class ConfigService { Handle_GetMultiLocationsEx() { return "rows"; } }
  patchTarget("configService", ConfigService, state);
  const svc = new ConfigService();
  assert.strictEqual(svc.Handle_GetMultiLocationsEx([[1, 2, 3]], null), "rows");
  svc.Handle_GetMultiLocationsEx([{ type: "list", items: [9] }], null);
  assert.ok(out.lines[0].includes("call=1 ids=3"), out.lines[0]);
  assert.ok(out.lines[1].includes("call=2 ids=1"), out.lines[1]);
  class SpaceRuntime {
    constructor() { this.scenes = new Map(); }
    ensureScene(id) { if (!this.scenes.has(id)) this.scenes.set(id, { id }); return this.scenes.get(id); }
    collectEmptySolarSystems() { return { collectedSystemIDs: [1], retainedSystemIDs: [], attemptedSystemIDs: [1] }; }
    prepareUniverseSitesForPlayerEntry(id) { return { success: true, prepared: true, systemID: id }; }
  }
  const singleton = new SpaceRuntime();
  const runtimeExports = {};
  Object.setPrototypeOf(runtimeExports, Object.getPrototypeOf(singleton));
  Object.assign(runtimeExports, singleton);
  patchTarget("spaceRuntime", runtimeExports, state);
  singleton.ensureScene(30000142);
  singleton.ensureScene(30000142);
  assert.ok(out.lines[2].includes("system=30000142 new=true"), out.lines[2]);
  assert.ok(out.lines[3].includes("new=false"), out.lines[3]);
  singleton.collectEmptySolarSystems(0);
  assert.ok(out.lines[4].includes("collected=1 retained=0 attempted=1"), out.lines[4]);
  assert.ok(state.patched.has("SpaceRuntime.prepareUniverseSitesForPlayerEntry"));
});

test("D3 vendor facts 261108.1: symbols exist, called through the object/this, no destructuring", () => {
  const universe = src("services/dungeon/dungeonUniverseRuntime.js");
  assert.ok(/^function getUniversePersistentLifecycleBoundary\(/m.test(universe));
  assert.ok(/^\s+getUniversePersistentLifecycleBoundary,$/m.test(universe), "eksport");
  assert.ok(src("services/dungeon/globalSiteSchedulerRuntime.js").includes("dungeonUniverseRuntime.getUniversePersistentLifecycleBoundary("));
  const dungeon = src("services/dungeon/dungeonRuntime.js");
  assert.ok(/^function listInstancesByLifecycle\(/m.test(dungeon));
  assert.ok(/^\s+listInstancesByLifecycle,$/m.test(dungeon), "eksport");
  const cacheMgr = src("services/dungeon/dungeonInstanceCacheMgrService.js");
  assert.ok(/^class DungeonInstanceCacheMgrService extends/m.test(cacheMgr));
  assert.ok(/^module\.exports = DungeonInstanceCacheMgrService;/m.test(cacheMgr));
  assert.ok(cacheMgr.includes("dungeonRuntime.listInstancesByLifecycle("));
  for (const method of CACHE_MGR_HANDLERS) assert.ok(new RegExp(`^  ${method}\\((_args, session)?\\) \\{`, "m").test(cacheMgr), method);
  const configService = src("services/config/configService.js");
  assert.ok(/^  Handle_GetMultiLocationsEx\(args, session\) \{/m.test(configService));
  assert.ok(/^module\.exports = ConfigService;/m.test(configService));
  const runtime = src("space/runtime.js");
  assert.ok(runtime.includes("Object.setPrototypeOf(runtimeExports, Object.getPrototypeOf(runtimeSingleton));"));
  assert.ok(runtime.includes("Object.defineProperty(SpaceRuntime.prototype, methodName"));
  assert.ok(/^ensureScene\(systemID, options = \{\}\) \{/m.test(src("space/runtime/spaceRuntime/sceneRegistry.js")));
  assert.ok(/^prepareUniverseSitesForPlayerEntry\(systemID, options = \{\}\) \{/m.test(src("space/runtime/spaceRuntime/universeSites.js")));
  assert.ok(/^collectEmptySolarSystems\(/m.test(src("space/runtime/spaceRuntime/sceneDisposal.js")));
  assert.ok(src("space/runtime/spaceRuntime/tick.js").includes("this.collectEmptySolarSystems("));
  assert.ok(src("services/exploration/wormholes/wormholeRuntime.js").includes("const result = runLifecycleMaintenanceSlice();"));
  const names = [...new Set(POINTS.map((p) => p.property))];
  const patterns = names.map((n) => [n, new RegExp(`\\{[^{}]*\\b${n}\\b[^{}]*\\}\\s*=[^=>]`)]);
  const offenders = [];
  for (const file of listJs(SERVER_SRC)) {
    const text = fs.readFileSync(file, "utf8");
    for (const [n, re] of patterns) if (text.includes(n) && re.test(text)) offenders.push(`${n} @ ${path.relative(SERVER_SRC, file)}`);
  }
  assert.deepStrictEqual(offenders, [], "destructuring of a wrapped symbol");
});

function withFakeLoadChain(order, fn) {
  const savedLoad = Module._load;
  const savedResolve = Module._resolveFilename;
  const fakeFile = "/app/server/src/services/dungeon/dungeonRuntime.js";
  const exportsObject = { listInstancesByLifecycle: () => [{ instanceID: 1 }, { instanceID: 2 }] };
  const recorder = createRecorder({ slowCallMs: 0 }, () => {});
  const state = createState(config, recorder);
  function installMoonLike() {
    const previous = Module._load;
    Module._load = function moonLike(request) {
      const result = previous.apply(this, arguments);
      if (request.includes("dungeonRuntime") && !result.__moon) {
        const original = result.listInstancesByLifecycle;
        result.listInstancesByLifecycle = function moonPresentationReader() {
          return original.apply(this, arguments).map((i) => ({ ...i, label: "moon" }));
        };
        result.__moon = true;
      }
      return result;
    };
  }
  try {
    Module._resolveFilename = function fakeResolve(request) {
      return request.includes("dungeonRuntime") ? fakeFile : savedResolve.apply(Module, arguments);
    };
    Module._load = function base(request) { return request.includes("dungeonRuntime") ? exportsObject : savedLoad.apply(this, arguments); };
    if (order === "hotPathFirst") { installHook(state); installMoonLike(); } else { installMoonLike(); installHook(state); }
    const loaded = Module._load("./dungeonRuntime", { filename: "/app/server/src/services/dungeon/dungeonUniverseRuntime.js" }, false);
    Module._load("./dungeonRuntime", { filename: "/app/server/src/services/dungeon/dungeonInstanceCacheMgrService.js" }, false);
    fn(loaded, state, recorder);
  } finally {
    Module._load = savedLoad;
    Module._resolveFilename = savedResolve;
  }
}

test("D4 order with a moonOreAnomalies-style overlay: the overlay works, measurement counts (both orders)", () => {
  for (const order of ["hotPathFirst", "moonFirst"]) {
    withFakeLoadChain(order, (loaded, state, recorder) => {
      const list = loaded.listInstancesByLifecycle("active");
      assert.deepStrictEqual(list.map((i) => i.label), ["moon", "moon"], `${order}: outer overlay works`);
      assert.ok(state.patched.has("dungeonRuntime.listInstancesByLifecycle"), order);
      const lc = recorder.snapshot().lifecycle.get("active");
      assert.strictEqual(lc.n, 1, `${order}: one call, no double wrap`);
      assert.strictEqual(lc.maxLength, 2);
      if (order === "hotPathFirst") {
        assert.ok(!loaded.listInstancesByLifecycle.__hotPathPerf, "our wrapper sits under the overlay");
      }
    });
  }
});

test("Target loaded by another mod's transform (no previousLoad): wrapped at the next require, before the probe", () => {
  const savedLoad = Module._load;
  const fakeFile = "/app/server/src/services/dungeon/dungeonUniverseRuntime.js";
  const parent = { filename: "/app/server/src/services/dungeon/globalSiteSchedulerRuntime.js" };
  const state = createState(config, createRecorder({ slowCallMs: 0 }, () => {}));
  assert.ok(!Module._cache[fakeFile]);
  try {
    Module._load = function base(request) { return request.includes("dungeonRuntime") ? {} : savedLoad.apply(this, arguments); };
    installHook(state);
    const inner = Module._load;
    Module._load = function transformLike(request) {
      if (typeof request !== "string" || !request.includes("dungeonUniverseRuntime")) return inner.apply(this, arguments);
      const cached = Module._cache[fakeFile];
      if (cached) return cached.exports;
      const instance = { filename: fakeFile, loaded: false, exports: {} };
      Module._cache[fakeFile] = instance;
      Module._load("./dungeonRuntime", { filename: fakeFile }, false);
      instance.exports.getUniversePersistentLifecycleBoundary = () => ({ boundaryAtMs: 5 });
      instance.loaded = true;
      return instance.exports;
    };
    const exp = Module._load("./dungeonUniverseRuntime", parent, false);
    assert.ok(!state.patched.has("dungeonUniverseRuntime.getUniversePersistentLifecycleBoundary"), "not yet during compilation");
    Module._load("node:path", parent, false);
    assert.ok(state.patched.has("dungeonUniverseRuntime.getUniversePersistentLifecycleBoundary"), "wrapped without the probe");
    assert.ok(exp.getUniversePersistentLifecycleBoundary.__hotPathPerf);
    assert.deepStrictEqual(exp.getUniversePersistentLifecycleBoundary(), { boundaryAtMs: 5 });
    assert.strictEqual(Module._load("./dungeonUniverseRuntime", parent, false), exp);
    assert.ok(!state.pendingCacheTargets.has("dungeonUniverse"), "target checked once, no repeated reads");
    assert.strictEqual(state.gameSeen, true);
  } finally {
    Module._load = savedLoad;
    delete Module._cache[fakeFile];
  }
  const win = loader.serverSrcRootOf("C:\\EveJS\\server\\src\\space\\runtime.js");
  assert.deepStrictEqual(win, { root: "C:\\EveJS\\server\\src", sep: "\\" });
  assert.strictEqual(loader.serverSrcRootOf("/app/mods/x/loader.js"), null);
});

test("D5 process without game modules: no probe; game process: DRIFT only for missing symbols", () => {
  const recorder = createRecorder(config, () => {});
  const helper = createState(config, recorder);
  const savedLoad = Module._load;
  try {
    installHook(helper);
    Module._load("node:path", { filename: "/app/server/src/edge/chat/chatEdgeProcess.worker.js" }, false);
    assert.strictEqual(helper.gameSeen, false);
    assert.strictEqual(probeMessage(helper), null, "helper process stays silent");
    Module._load("node:path", { filename: "C:\\EveJS\\server\\src\\space\\runtime\\scene\\tick.js" }, false);
    assert.strictEqual(helper.gameSeen, true);
  } finally {
    Module._load = savedLoad;
  }
  const game = createState(config, recorder);
  game.gameSeen = true;
  class Partial { Handle_GetCombatAnomalyInstances() { return 1; } }
  assert.strictEqual(patchTarget("cacheMgr", Partial, game), 1);
  assert.strictEqual(new Partial().Handle_GetCombatAnomalyInstances(), 1);
  const message = probeMessage(game);
  assert.ok(/^DRIFT: /.test(message), message);
  assert.ok(message.includes("DungeonInstanceCacheMgrService.Handle_GetSignatureInstances"));
  assert.ok(!message.includes("Handle_GetCombatAnomalyInstances,"), "a wrapped symbol is not in DRIFT");
  for (const point of [...POINTS, ...loader.PREWARM_POINTS]) game.patched.add(point.symbol);
  assert.ok(/^probe: passed/.test(probeMessage(game)));
});

test("Probe wraps a target from the require cache (cycle on first load)", () => {
  const state = createState(config, createRecorder(config, () => {}));
  const exp = { getUniversePersistentLifecycleBoundary: () => null };
  const cache = { "/app/server/src/services/dungeon/dungeonUniverseRuntime.js": { loaded: true, exports: exp } };
  assert.strictEqual(sweepModuleCache(state, cache), 1);
  assert.ok(exp.getUniversePersistentLifecycleBoundary.__hotPathPerf);
});

test("Wallet authority helper with career/template/retention: infrastructure targets wrapped, but the mod is silent", () => {
  const c = loadConfig({
    env: { HOTPATH_CAREER_ABYSSAL_READ: "1", HOTPATH_TEMPLATE_READONLY: "1", HOTPATH_SCENE_RETENTION: "1", HOTPATH_DUNGEON_INDEX: "1" },
    settingsPath: path.join(__dirname, "missing.json"),
  });
  assert.strictEqual(c.careerAbyssalRead, true);
  const helper = createState(c, createRecorder(c, () => {}));
  const worker = { filename: path.join(SERVER_SRC, "services", "account", "walletAuthorityProcess.worker.js") };
  const walletState = { filename: path.join(SERVER_SRC, "services", "account", "walletState.js") };
  const gameStoreFile = path.join(SERVER_SRC, "gameStore", "index.js");
  const savedLoad = Module._load;
  const loaded = [];
  try {
    Module._load = function base(request) {
      if (typeof request === "string" && request.startsWith(SERVER_SRC)) {
        loaded.push(request);
        return { readPersisted() { return null; }, loadExistingTableObject() { return null; }, getSessions() { return []; } };
      }
      return savedLoad.apply(this, arguments);
    };
    installHook(helper);
    Module._load(path.join(SERVER_SRC, "gameStore"), worker, false);
    Module._load(path.join(SERVER_SRC, "services", "chat", "sessionRegistry"), walletState, false);
    Module._load(path.join(SERVER_SRC, "gameStore", "sqliteStore"), { filename: gameStoreFile }, false);
    assert.strictEqual(loaded.length, 3);
    assert.ok(helper.patched.has("gameStore.readPersisted#gate"), "gameStore target recognized and wrapped");
    assert.ok(helper.patched.has("sqliteStore.loadExistingTableObject#serve"), "sqliteStore target recognized and wrapped");
    const cacheEntry = path.join(SERVER_SRC, "gameStore", "sqliteStore.js");
    assert.strictEqual(loader.patchFromCache(helper, worker, { [cacheEntry]: { loaded: true, exports: {} } }) >= 0, true);
    assert.strictEqual(helper.gameSeen, false, "infrastructure targets do not set gameSeen");
    assert.strictEqual(probeMessage(helper), null, "helper is silent: no DRIFT/probe");
    assert.strictEqual(loader.checkIndexDrift(helper), false, "no WARN dungeonIndex disabled: drift");
    assert.ok(!helper.index.status().disabledReason);
    assert.strictEqual(loader.checkCareerDrift(helper), false);
    assert.strictEqual(loader.checkTemplateDrift(helper), false);
    assert.ok(/if \(!state\.gameSeen\) return;/.test(fs.readFileSync(path.join(__dirname, "..", "loader.js"), "utf8")));
    for (const key of ["gameStore", "sqliteStore", "sessionRegistry", "vendorConfig", "configService", "careerAbyssal", "dungeonAuthority"]) {
      assert.ok(!loader.GAME_TARGETS.has(key), key);
    }
    Module._load("node:path", { filename: path.join(SERVER_SRC, "space", "runtime.js") }, false);
    assert.strictEqual(helper.gameSeen, true);
  } finally {
    Module._load = savedLoad;
  }
});

test("K1 kill switch HOTPATH_NO_INSTALL=1 and enabled=false: wraps nothing", () => {
  const saved = Module._load;
  assert.strictEqual(install({ env: { HOTPATH_NO_INSTALL: "1" } }), null);
  assert.strictEqual(install({ env: {}, config: { ...config, enabled: false } }), null);
  assert.strictEqual(Module._load, saved, "hook not installed");
  assert.strictEqual(loader.installedState, null);
  assert.strictEqual(globalThis[loader.INSTALL_FLAG], undefined);
  const off = createState({ ...config, measureCacheMgrHandlers: false }, createRecorder(config, () => {}));
  class Svc { Handle_GetCombatAnomalyInstances() {} }
  const original = Svc.prototype.Handle_GetCombatAnomalyInstances;
  patchTarget("cacheMgr", Svc, off);
  assert.strictEqual(Svc.prototype.Handle_GetCombatAnomalyInstances, original, "point flag off = not wrapped");
});

test("L1 targetOf recognizes only server/src files", () => {
  assert.strictEqual(targetOf("/app/server/src/space/runtime.js"), "spaceRuntime");
  assert.strictEqual(targetOf("C:\\EveJS\\server\\src\\services\\dungeon\\dungeonRuntime.js"), "dungeonRuntime");
  assert.strictEqual(targetOf("/app/server/src/space/runtime/spaceRuntime/tick.js"), null);
  assert.strictEqual(targetOf("/app/mods/x/services/config/configService.js"), null);
});

const { createDungeonActiveIndex, buildSummary, SUMMARY_FIELDS } = require("../lib/dungeonActiveIndex");

const indexConfig = Object.freeze({ ...config, dungeonIndex: true });

function rec(id, lifecycleState, up = false, extra = {}) {
  return {
    instanceID: id, templateID: `t${id}`, solarSystemID: 30000000 + id, siteKey: `k${id}`,
    lifecycleState, lifecycleReason: null, instanceScope: "shared", siteFamily: "ore", siteKind: "anomaly",
    siteOrigin: null, source: null, sourceDungeonID: null, archetypeID: null, factionID: null, difficulty: null,
    entryObjectTypeID: null, dungeonNameID: 100 + id, position: { x: id, y: 0, z: 0 }, ownership: {},
    timers: { expiresAtMs: 1000 + id }, roomStatesByKey: { a: {} }, gateStatesByKey: {},
    objectiveState: { completedObjectiveIDs: [1] }, runtimeFlags: { universePersistent: up, universeSeeded: up },
    metadata: { label: `L${id}` }, spawnState: null, ...extra,
  };
}

function stateOf(records) {
  const instancesByID = {};
  for (const r of records) instancesByID[String(r.instanceID)] = r;
  return { instancesByID };
}

function fakeVendor(records) {
  const v = { current: stateOf(records), calls: 0, last: null, tamper: false };
  const isUP = (r) => Boolean(r && r.runtimeFlags && r.runtimeFlags.universePersistent === true && r.runtimeFlags.universeSeeded === true);
  v.stateModule = {
    loadState: () => v.current,
    resolveInstanceSpawnFamilyKey: (r) => String(r.metadata && r.metadata.spawnFamilyKey || r.siteFamily || "").toLowerCase(),
    isUniversePersistentInstance: isUP,
  };
  const deps = { resolveSpawnFamilyKey: v.stateModule.resolveInstanceSpawnFamilyKey };
  v.group = (group) => Object.values(v.current.instancesByID)
    .filter((r) => (group === "terminal" ? !["seeded", "active", "paused"].includes(r.lifecycleState) && isUP(r) : r.lifecycleState === group))
    .sort((a, b) => a.instanceID - b.instanceID)
    .map((r) => JSON.parse(JSON.stringify(buildSummary(r, deps))))
    .map((s) => (v.tamper ? { ...s, metadata: { ...s.metadata, label: "tampered" } } : s));
  v.runtime = {
    listInstancesByLifecycle: function listInstancesByLifecycle(lifecycleState, options = {}) {
      v.calls += 1;
      v.last = v.group(String(lifecycleState).toLowerCase()).map((s) => (options.full === true ? { ...s, full: true } : s));
      return v.last;
    },
    listUniversePersistentTerminalInstances: function listUniversePersistentTerminalInstances(options = {}) {
      v.calls += 1;
      v.last = v.group("terminal").map((s) => (options.full === true ? { ...s, full: true } : s));
      return v.last;
    },
  };
  return v;
}

function sixRecords() {
  return [rec(12, "active"), rec(3, "active", true), rec(7, "seeded"), rec(5, "paused", true), rec(9, "despawned", true), rec(11, "completed")];
}

const ids = (list) => list.map((s) => s.instanceID);
const json = (value) => JSON.stringify(value);

test("I1 index: build, change of 1 record, created/removed/terminal without emit, new identity, no refresh", () => {
  const out = capture();
  const v = fakeVendor(sixRecords());
  const index = createDungeonActiveIndex({ config: indexConfig, log: out.log });
  assert.strictEqual(index.listLifecycle("active").reason, "NOT_READY");
  assert.strictEqual(index.setDeps(v.stateModule), true);
  for (const g of ["seeded", "active", "paused"]) assert.strictEqual(json(index.listLifecycle(g).list), json(v.group(g)), g);
  assert.strictEqual(json(index.listTerminal().list), json(v.group("terminal")));
  assert.deepStrictEqual(ids(index.listLifecycle("active").list), [3, 12]);
  assert.ok(Object.isFrozen(index.listLifecycle("active").list[0]));
  const before = index.listLifecycle("active").list;
  index.drainStatsLines();
  const recs = Object.values(v.current.instancesByID);
  v.current = stateOf(recs.map((r) => (r.instanceID === 12 ? { ...r, metadata: { label: "changed" } } : r)));
  const after = index.listLifecycle("active").list;
  assert.strictEqual(index.statsSnapshot().changedMax, 1);
  assert.strictEqual(after[0], before[0], "an untouched summary is the same object");
  assert.notStrictEqual(after[1], before[1]);
  assert.strictEqual(after[1].metadata.label, "changed");
  const cur = Object.values(v.current.instancesByID);
  v.current = stateOf([
    ...cur.filter((r) => ![3, 12, 7].includes(r.instanceID)),
    { ...cur.find((r) => r.instanceID === 3), lifecycleState: "despawned" },
    { ...cur.find((r) => r.instanceID === 12), lifecycleState: "despawned" },
    rec(1, "active"),
  ]);
  assert.deepStrictEqual(ids(index.listLifecycle("active").list), [1]);
  assert.deepStrictEqual(ids(index.listLifecycle("seeded").list), []);
  assert.deepStrictEqual(ids(index.listTerminal().list), [3, 9]);
  for (const g of ["seeded", "active", "paused"]) assert.strictEqual(json(index.listLifecycle(g).list), json(v.group(g)), g);
  assert.strictEqual(json(index.listTerminal().list), json(v.group("terminal")));
  v.current = JSON.parse(JSON.stringify(v.current));
  for (const g of ["seeded", "active", "paused"]) assert.strictEqual(json(index.listLifecycle(g).list), json(v.group(g)), g);
  assert.strictEqual(json(index.listTerminal().list), json(v.group("terminal")));
  assert.strictEqual(index.status().enabled, true);
  const refreshes = index.statsSnapshot().refreshes;
  index.listLifecycle("active");
  index.listTerminal();
  assert.strictEqual(index.statsSnapshot().refreshes, refreshes);
  assert.deepStrictEqual(out.lines, []);
  assert.ok(/^stats dungeonIndex state=ready entries=seeded:0,active:1,paused:1,terminal:2 served=0 /.test(index.drainStatsLines()[0]));
});

let handlerBody = () => null;
class FakeCacheMgr {
  Handle_GetOreAnomalyInstances() { return handlerBody(); }
  Handle_GetHomefrontSiteInstances() { return handlerBody(); }
}

function indexedSetup(cfg = indexConfig, records = sixRecords()) {
  const out = capture();
  const v = fakeVendor(records);
  const st = createState(cfg, createRecorder({ slowCallMs: 1e9 }, () => {}), { log: out.log });
  class CacheMgr extends FakeCacheMgr {}
  CacheMgr.prototype.Handle_GetOreAnomalyInstances = FakeCacheMgr.prototype.Handle_GetOreAnomalyInstances;
  const universe = { getUniversePersistentLifecycleBoundary: () => handlerBody() };
  patchTarget("dungeonRuntimeState", v.stateModule, st);
  patchTarget("dungeonRuntime", v.runtime, st);
  patchTarget("cacheMgr", CacheMgr, st);
  patchTarget("dungeonUniverse", universe, st);
  const inScope = (fn) => { handlerBody = fn; try { return new CacheMgr().Handle_GetOreAnomalyInstances(); } finally { handlerBody = () => null; } };
  return { out, v, st, index: st.index, universe, inScope, CacheMgr };
}

test("I2 scope and signature: outside the scope the original's object, inside the index; full/options/other state = original; flag off = no wrappers", () => {
  flagOffChecks();
  const { v, st, index, inScope } = indexedSetup();
  assert.ok(st.patched.has("dungeonRuntime.listInstancesByLifecycle#index"));
  assert.ok(st.patched.has("DungeonInstanceCacheMgrService.Handle_GetOreAnomalyInstances#scope"));
  assert.ok(v.runtime.listInstancesByLifecycle.__hotPathPerf, "measurement above the index");
  assert.ok(v.runtime.listInstancesByLifecycle.__hotPathPerf.__hotPathPerfIndex, "index directly on the vendor");
  const outside = v.runtime.listInstancesByLifecycle("active");
  assert.strictEqual(outside, v.last, "outside the scope: same object as the original");
  const calls = v.calls;
  const served = inScope(() => v.runtime.listInstancesByLifecycle("active"));
  assert.strictEqual(v.calls, calls, "inside the scope the vendor is not called");
  assert.strictEqual(json(served), json(v.group("active")));
  assert.ok(Object.isFrozen(served[0]));
  for (const args of [["active", { full: true }], ["active", {}], ["despawned"], ["Active"]]) {
    const r = inScope(() => v.runtime.listInstancesByLifecycle(...args));
    assert.strictEqual(r, v.last, `original for ${json(args)}`);
  }
  const term = inScope(() => v.runtime.listUniversePersistentTerminalInstances());
  assert.notStrictEqual(term, v.last);
  assert.strictEqual(json(term), json(v.group("terminal")));
  const full = inScope(() => v.runtime.listUniversePersistentTerminalInstances({ full: true }));
  assert.strictEqual(full, v.last);
  assert.strictEqual(index.statsSnapshot().served, 2);
});

test("I3 an exception in the scope resets the counter; a nested scope returns to 0", () => {
  const { v, index, inScope, universe } = indexedSetup();
  let caught = null;
  try { inScope(() => { throw new Error("handler boom"); }); } catch (error) { caught = error; }
  assert.ok(caught && caught.message === "handler boom");
  assert.strictEqual(index.status().depth, 0);
  assert.strictEqual(v.runtime.listInstancesByLifecycle("active"), v.last, "after the exception, outside the scope = original");
  let depthInside = -1;
  const nested = inScope(() => {
    handlerBody = () => { depthInside = index.status().depth; return v.runtime.listInstancesByLifecycle("seeded"); };
    return universe.getUniversePersistentLifecycleBoundary();
  });
  assert.strictEqual(depthInside, 2, "handler -> boundary");
  assert.strictEqual(json(nested), json(v.group("seeded")));
  assert.strictEqual(index.status().depth, 0);
});

test("I4 parity: a match serves, a mismatch disables the index; the maxEntries limit disables the index", () => {
  const p = indexedSetup({ ...indexConfig, dungeonIndexParityCheck: true });
  const r1 = p.inScope(() => p.v.runtime.listInstancesByLifecycle("active"));
  assert.notStrictEqual(r1, p.v.last);
  assert.strictEqual(p.index.statsSnapshot().served, 1);
  assert.strictEqual(p.index.statsSnapshot().parityChecks, 1);
  assert.deepStrictEqual(p.out.lines, []);
  p.v.tamper = true;
  const r2 = p.inScope(() => p.v.runtime.listInstancesByLifecycle("active"));
  assert.strictEqual(r2, p.v.last, "mismatch: vendor result");
  assert.strictEqual(p.out.lines.length, 1);
  assert.ok(/^WARN dungeonIndex disabled: parity \(state=active .*keys=metadata\)$/.test(p.out.lines[0]), p.out.lines[0]);
  assert.strictEqual(p.index.status().disabledReason, "parity");
  const calls = p.v.calls;
  const r3 = p.inScope(() => p.v.runtime.listInstancesByLifecycle("active"));
  assert.strictEqual(r3, p.v.last);
  assert.strictEqual(p.v.calls, calls + 1, "after disabling, inside the scope it goes to the original");
  assert.strictEqual(p.index.statsSnapshot().fallbackByReason.get("DISABLED"), 1);
  const l = indexedSetup({ ...indexConfig, dungeonIndexMaxEntries: 3 });
  const r4 = l.inScope(() => l.v.runtime.listInstancesByLifecycle("active"));
  assert.strictEqual(r4, l.v.last);
  assert.strictEqual(l.index.status().disabledReason, "limit");
  assert.ok(/^WARN dungeonIndex disabled: limit/.test(l.out.lines[0]));
  assert.strictEqual(l.index.statsSnapshot().size, 0, "index cleared");
  const rv = fakeVendor(sixRecords());
  const rot = createDungeonActiveIndex({ config: { ...indexConfig, dungeonIndexMaxEntries: 5 }, log: capture().log });
  rot.setDeps(rv.stateModule);
  assert.deepStrictEqual(ids(rot.listLifecycle("active").list), [3, 12]);
  const kept = Object.values(rv.current.instancesByID).filter((r) => ![12, 7].includes(r.instanceID));
  rv.current = stateOf([...kept, rec(20, "active"), rec(21, "seeded")]);
  assert.deepStrictEqual(ids(rot.listLifecycle("active").list), [3, 20]);
  assert.deepStrictEqual(ids(rot.listLifecycle("seeded").list), [21]);
  assert.strictEqual(rot.status().enabled, true, `rotation: ${rot.status().disabledReason}`);
  rv.current = stateOf([...Object.values(rv.current.instancesByID), rec(22, "active")]);
  assert.strictEqual(rot.listLifecycle("active").reason, "LIMIT", "the sixth live entry still disables");
  const ov = fakeVendor([100, 101, 102, 103, 104].map((id) => rec(id, "active")));
  const ord = createDungeonActiveIndex({ config: { ...indexConfig, dungeonIndexMaxEntries: 5 }, log: capture().log });
  ord.setDeps(ov.stateModule);
  assert.strictEqual(ord.listLifecycle("active").list.length, 5);
  ov.current = stateOf([...Object.values(ov.current.instancesByID), ...[1, 2, 3, 4].map((id) => rec(id, "active"))]);
  assert.strictEqual(ord.listLifecycle("active").reason, "LIMIT", "9 live entries with limit 5");
  assert.deepStrictEqual([ord.status().disabledReason, ord.statsSnapshot().size], ["limit", 0]);
});

function withIndexLoadChain(order, fn) {
  const savedLoad = Module._load;
  const savedResolve = Module._resolveFilename;
  const files = {
    state: "/app/server/src/services/dungeon/dungeonRuntimeState.js",
    runtime: "/app/server/src/services/dungeon/dungeonRuntime.js",
  };
  const v = fakeVendor(sixRecords());
  const out = capture();
  const state = createState(indexConfig, createRecorder({ slowCallMs: 1e9 }, () => {}), { log: out.log });
  const present = (s) => (s && s.templateID === "t12"
    ? { ...s, dungeonNameID: null, metadata: { ...(s.metadata || {}), label: "moon" } }
    : s);
  function installMoonLike() {
    const previous = Module._load;
    Module._load = function moonLike(request) {
      const result = previous.apply(this, arguments);
      if (/dungeonRuntime$/.test(request) && !result[MOON_OVERLAY_MARKER]) {
        for (const name of ["listInstancesByLifecycle", "listUniversePersistentTerminalInstances"]) {
          const original = result[name];
          result[name] = function moonPresentationReader() {
            const r = original.apply(this, arguments);
            return Array.isArray(r) ? r.map(present) : present(r);
          };
        }
        Object.defineProperty(result, MOON_OVERLAY_MARKER, { value: true, configurable: true });
      }
      return result;
    };
  }
  try {
    Module._resolveFilename = function fakeResolve(request) {
      if (/dungeonRuntimeState$/.test(request)) return files.state;
      if (/dungeonRuntime$/.test(request)) return files.runtime;
      return savedResolve.apply(Module, arguments);
    };
    Module._load = function base(request) {
      if (/dungeonRuntimeState$/.test(request)) return v.stateModule;
      if (/dungeonRuntime$/.test(request)) return v.runtime;
      return savedLoad.apply(this, arguments);
    };
    if (order === "hotPathFirst") { installHook(state); installMoonLike(); } else { installMoonLike(); installHook(state); }
    Module._load("./dungeonRuntimeState", { filename: files.runtime }, false);
    const loaded = Module._load("./dungeonRuntime", { filename: "/app/server/src/services/dungeon/dungeonUniverseRuntime.js" }, false);
    class CacheMgr extends FakeCacheMgr {}
    CacheMgr.prototype.Handle_GetOreAnomalyInstances = FakeCacheMgr.prototype.Handle_GetOreAnomalyInstances;
    patchTarget("cacheMgr", CacheMgr, state);
    const inScope = (body) => { handlerBody = body; try { return new CacheMgr().Handle_GetOreAnomalyInstances(); } finally { handlerBody = () => null; } };
    fn({ loaded, state, v, out, inScope, vendorWithOverlay: (g) => v.group(g).map(present) });
  } finally {
    Module._load = savedLoad;
    Module._resolveFilename = savedResolve;
  }
}

const { MOON_OVERLAY_MARKER } = loader;

test("I5 moonOre overlay: result with the overlay = vendor with the overlay in both orders; wrong order = order", () => {
  withIndexLoadChain("hotPathFirst", ({ loaded, state, inScope, vendorWithOverlay }) => {
    assert.strictEqual(loaded.listInstancesByLifecycle.name, "moonPresentationReader", "outer overlay");
    const r = inScope(() => loaded.listInstancesByLifecycle("active"));
    assert.strictEqual(json(r), json(vendorWithOverlay("active")));
    assert.ok(r.some((s) => s.metadata.label === "moon"));
    const t = inScope(() => loaded.listUniversePersistentTerminalInstances());
    assert.strictEqual(json(t), json(vendorWithOverlay("terminal")));
    assert.strictEqual(state.index.statsSnapshot().served, 2);
    assert.strictEqual(state.index.status().disabledReason, null);
  });
  withIndexLoadChain("moonFirst", ({ loaded, state, out, inScope, vendorWithOverlay }) => {
    assert.strictEqual(state.index.status().disabledReason, "order");
    assert.ok(out.lines.some((l) => l === "WARN dungeonIndex disabled: order (listInstancesByLifecycle)"), out.lines.join("|"));
    const r = inScope(() => loaded.listInstancesByLifecycle("active"));
    assert.strictEqual(json(r), json(vendorWithOverlay("active")));
    assert.strictEqual(state.index.statsSnapshot().served, 0);
    assert.ok(state.patched.has("dungeonRuntime.listInstancesByLifecycle"), "measurement still works");
    state.gameSeen = true;
    const message = probeMessage(state);
    assert.ok(message.endsWith("; dungeonIndex disabled: order"), message);
    assert.ok(!message.includes("#index"), "index points are not in DRIFT");
  });
});

function functionBody(text, name) {
  const start = text.search(new RegExp(`^function ${name}\\(`, "m"));
  assert.ok(start >= 0, `missing function ${name}`);
  const open = text.indexOf("{", text.indexOf(")", start));
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    if (text[i] === "{") depth += 1;
    else if (text[i] === "}" && --depth === 0) return text.slice(start, i + 1);
  }
  throw new Error(`unclosed function ${name}`);
}

test("F1 vendor facts 261108.1: summary fields, cache identity, readers, consumers only read", () => {
  const norm = (rel) => src(rel).replace(/\r\n/g, "\n");
  const state = norm("services/dungeon/dungeonRuntimeState.js");
  const fields = [...functionBody(state, "buildInstanceSummary").matchAll(/^\s{4}(\w+):/gm)].map((m) => m[1]);
  assert.deepStrictEqual(fields, [...SUMMARY_FIELDS]);
  const assigns = [...state.matchAll(/\bcache\s*=(?!=)\s*([^;\n]+);/g)].map((m) => m[1].trim());
  assert.ok(assigns.length >= 4);
  for (const rhs of assigns) assert.ok(rhs === "null" || /^buildCache\(\w*\)$/.test(rhs), rhs);
  assert.strictEqual((state.match(/\bcache\.[\w$]+\s*=(?!=)/g) || []).length, 0);
  assert.ok(/^function loadState\(\) \{\n  return ensureCache\(\)\.state;\n\}/m.test(state));
  assert.ok(state.includes('const ACTIVE_LIFECYCLE_STATES = new Set(["seeded", "active", "paused"]);'));
  assert.strictEqual(functionBody(state, "buildCache").split(".sort((left, right) => left - right)").length - 1, 2);
  const runtime = norm("services/dungeon/dungeonRuntime.js");
  assert.ok(/^function listInstancesByLifecycle\(/m.test(runtime));
  assert.ok(/^function listUniversePersistentTerminalInstances\(/m.test(runtime));
  assert.ok(runtime.includes("if (options.full !== true) {\n    return summaries;"));
  const consumers = [];
  for (const file of listJs(SERVER_SRC)) {
    const text = fs.readFileSync(file, "utf8");
    if (!text.includes("listInstancesByLifecycle") && !text.includes("listUniversePersistentTerminalInstances")) continue;
    for (const m of text.matchAll(/(function\s+)?\b(listInstancesByLifecycle|listUniversePersistentTerminalInstances)(?:["'`]\])?(?:\.(?:call|apply))?\(([^)]*)\)/g)) {
      if (m[1] || m[3].includes("full: true")) continue;
      consumers.push(`${path.relative(SERVER_SRC, file).replace(/\\/g, "/")}:${m[2]}`);
    }
  }
  assert.deepStrictEqual(consumers.sort(), [
    "services/dungeon/dungeonInstanceCacheMgrService.js:listInstancesByLifecycle",
    "services/dungeon/dungeonUniverseRuntime.js:listInstancesByLifecycle",
    "services/dungeon/dungeonUniverseRuntime.js:listUniversePersistentTerminalInstances",
  ], "new reader consumer without full: true — review it before serving from the index");
  assert.ok(norm("services/dungeon/dungeonUniverseRuntime.js").includes("const entries = dungeonRuntimeState.listUniversePersistentLifecycleEntries({"),
    "boundary reads the vendor scalar projection (upstream removed the clones from this path itself)");
  const universe = norm("services/dungeon/dungeonUniverseRuntime.js");
  const cacheMgr = norm("services/dungeon/dungeonInstanceCacheMgrService.js");
  const bodies = {
    cacheMgr,
    boundary: functionBody(universe, "getUniversePersistentLifecycleBoundary"),
    grid: functionBody(universe, "terminalInstanceStillHoldsItsGrid"),
    ice: functionBody(universe, "listActiveIceAuthorityRuntimeInstances"),
    receipt: functionBody(norm("services/faction/fwOpenRewards.js"), "getReceipt"),
  };
  const writes = [
    /\b(summary|instance)\s*(\.[\w$]+|\[[^\]]+\])+\s*(=(?!=)|\+=|-=|\+\+|--)/g,
    /delete (summary|instance)\b/g,
    /Object\.assign\(\s*(summary|instance)\b/g,
  ];
  for (const [name, body] of Object.entries(bodies)) {
    for (const re of writes) assert.deepStrictEqual(body.match(re) || [], [], `${name} ${re}`);
  }
  for (const method of CACHE_MGR_HANDLERS) assert.ok(new RegExp(`^  ${method}\\((_args, session)?\\) \\{`, "m").test(cacheMgr), method);
  assert.ok(!/\basync\s+Handle_/.test(cacheMgr), "async Handle_");
});

function flagOffChecks() {
  assert.strictEqual(config.dungeonIndex, false);
  assert.strictEqual(config.dungeonIndexParityCheck, false);
  assert.strictEqual(config.dungeonIndexMaxEntries, 100000);
  const c = loadConfig({
    env: { HOTPATH_DUNGEON_INDEX: "1", HOTPATH_DUNGEON_INDEX_PARITY: "true", HOTPATH_DUNGEON_INDEX_MAX_ENTRIES: "50" },
    settingsPath: path.join(__dirname, "missing.json"),
  });
  assert.deepStrictEqual([c.dungeonIndex, c.dungeonIndexParityCheck, c.dungeonIndexMaxEntries], [true, true, 50]);
  const st = createState(config, createRecorder(config, () => {}));
  assert.strictEqual(st.index, null);
  assert.strictEqual(st.expected.size, POINTS.length + loader.PREWARM_POINTS.length, "measurement + pre-warm (default on)");
  assert.ok(!st.pendingCacheTargets.has("dungeonRuntimeState"));
  const v = fakeVendor(sixRecords());
  patchTarget("dungeonRuntimeState", v.stateModule, st);
  patchTarget("dungeonRuntime", v.runtime, st);
  assert.ok(!v.runtime.listInstancesByLifecycle.__hotPathPerf.__hotPathPerfIndex, "measurement directly on the vendor");
  assert.strictEqual(v.runtime.listUniversePersistentTerminalInstances.name, "listUniversePersistentTerminalInstances");
}

const { createSceneRetention, dockedSystemOf, inSpaceSystemOf } = require("../lib/sceneRetention");

const retentionConfig = Object.freeze({ ...config, sceneRetention: true });
const SYS_A = 30002001;
const SYS_B = 30002002;
const BASE_ON = 30000142;

function fakeVendorConfig(alwaysOn = [BASE_ON]) {
  const cfg = { alwaysOnSolarSystemIDs: alwaysOn };
  Object.defineProperty(cfg, "saveConfig", { value() {} });
  return cfg;
}

function fakeSpaceRuntime(cfg) {
  class SpaceRuntime {
    constructor() { this.scenes = new Map(); this.calls = 0; this.seenAlwaysOn = []; this.seenRef = undefined; this.throwNext = null; }
    isSolarSystemSceneLoaded(systemID) { return this.scenes.has(Number(systemID)); }
    collectEmptySolarSystems(wallclockNowMs) {
      this.calls += 1;
      this.seenRef = cfg.alwaysOnSolarSystemIDs;
      const alwaysOn = new Set((Array.isArray(cfg.alwaysOnSolarSystemIDs) ? cfg.alwaysOnSolarSystemIDs : []).map(Number));
      this.seenAlwaysOn = [...alwaysOn];
      if (this.throwNext) { const e = this.throwNext; this.throwNext = null; throw e; }
      const collectedSystemIDs = [];
      for (const scene of [...this.scenes.values()]) {
        if (scene.sessions > 0) { scene._emptySinceWallclockMs = null; continue; }
        if (scene._emptySinceWallclockMs === null) scene._emptySinceWallclockMs = wallclockNowMs;
        if (alwaysOn.has(scene.systemID)) continue;
        if (wallclockNowMs - scene._emptySinceWallclockMs >= 60000) {
          this.scenes.delete(scene.systemID);
          collectedSystemIDs.push(scene.systemID);
        }
      }
      return { collectedSystemIDs };
    }
    addScene(systemID, sessions = 0) { this.scenes.set(systemID, { systemID, sessions, _emptySinceWallclockMs: null }); }
  }
  return new SpaceRuntime();
}

const dockedSession = (charID, systemID) => ({ characterID: charID, stationid: 60000001, stationID: 60000001, structureid: null, solarsystemid2: systemID, solarsystemid: null });
const spaceSession = (charID, systemID) => ({ characterID: charID, stationid: null, structureid: null, solarsystemid2: systemID, solarsystemid: systemID, _space: { systemID } });

function retentionSetup(overrides = {}, options = {}) {
  const out = capture();
  const cfg = fakeVendorConfig();
  const sessions = [];
  const registry = { getCalls: 0, getSessions() { registry.getCalls += 1; return sessions.slice(); } };
  const rt = fakeSpaceRuntime(cfg);
  const retention = createSceneRetention({ config: { ...retentionConfig, ...overrides }, log: out.log, rss: options.rss });
  assert.strictEqual(retention.setSessionRegistry({}), false, "empty exports (require cycle)");
  assert.strictEqual(retention.setSessionRegistry(registry), true);
  assert.strictEqual(retention.setVendorConfig({ alwaysOnSolarSystemIDs: [] }), false, "object without own saveConfig");
  assert.strictEqual(retention.setVendorConfig(cfg), true);
  const proto = Object.getPrototypeOf(rt);
  proto.collectEmptySolarSystems = retention.wrapCollect(proto.collectEmptySolarSystems);
  return { out, cfg, sessions, registry, rt, retention, sweep: (t) => rt.collectEmptySolarSystems(t) };
}

test("R1 pin and unpin: docking pins, logout/minute limit unpins, pinRecent with a window", () => {
  assert.strictEqual(dockedSystemOf(dockedSession(1, SYS_A)), SYS_A);
  assert.strictEqual(dockedSystemOf({ structureID: 1035000000000, solarsystemid2: SYS_B, solarsystemid: SYS_B }), SYS_B);
  assert.strictEqual(dockedSystemOf({ stationid: 60000001, solarsystemid2: null }), 0);
  assert.strictEqual(inSpaceSystemOf(dockedSession(1, SYS_A)), 0);
  assert.strictEqual(inSpaceSystemOf(spaceSession(1, SYS_B)), SYS_B);
  const s = retentionSetup();
  s.rt.addScene(SYS_A); s.rt.addScene(SYS_B);
  s.sessions.push(dockedSession(1, SYS_A));
  s.sweep(0);
  assert.ok(s.rt.seenAlwaysOn.includes(SYS_A));
  assert.deepStrictEqual(s.sweep(61000).collectedSystemIDs, [SYS_B]);
  assert.ok(s.rt.scenes.has(SYS_A));
  assert.deepStrictEqual(s.retention.status().pinnedNow, [SYS_A]);
  s.sessions.length = 0;
  assert.deepStrictEqual(s.sweep(66000).collectedSystemIDs, [SYS_A]);
  assert.strictEqual(s.retention.statsSnapshot().released, 1);
  const m = retentionSetup({ sceneRetentionPinDockedMaxMinutes: 2 });
  m.rt.addScene(SYS_A);
  m.sessions.push(dockedSession(1, SYS_A));
  m.sweep(0);
  assert.deepStrictEqual(m.sweep(120000).collectedSystemIDs, [], "exactly at the boundary still pinned");
  assert.deepStrictEqual(m.sweep(125000).collectedSystemIDs, [SYS_A]);
  const SYS_C = 30002003;
  const SYS_D = 30002004;
  for (const pinRecent of [false, true]) {
    const r = retentionSetup({ sceneRetentionPinRecent: pinRecent, sceneRetentionRecentMinutes: 2 });
    r.rt.addScene(SYS_C, 1);
    r.sessions.push(spaceSession(7, SYS_C));
    r.sweep(0);
    assert.deepStrictEqual(r.retention.status().pinnedNow, [], "the current system is not pinned");
    r.rt.scenes.get(SYS_C).sessions = 0;
    r.rt.addScene(SYS_D, 1);
    r.sessions[0] = spaceSession(7, SYS_D);
    r.sweep(5000);
    const at66 = r.sweep(66000).collectedSystemIDs;
    if (!pinRecent) {
      assert.deepStrictEqual(at66, [SYS_C]);
      assert.strictEqual(r.retention.statsSnapshot().trackedRecentCharacters, 0, "no lastSeen map is created");
      continue;
    }
    assert.deepStrictEqual(at66, [], "C pinned within the recentMinutes window");
    assert.deepStrictEqual(r.retention.status().pinnedNow, [SYS_C]);
    assert.deepStrictEqual(r.sweep(125000).collectedSystemIDs, [SYS_C], "after the window C is collected");
  }
});

test("R2 config restore: same reference, original's exception, missing key, getSessions error = disabled:error", () => {
  const s = retentionSetup();
  s.rt.addScene(SYS_A);
  s.sessions.push(dockedSession(1, SYS_A));
  const before = s.cfg.alwaysOnSolarSystemIDs;
  s.sweep(0);
  assert.deepStrictEqual(s.rt.seenAlwaysOn, [BASE_ON, SYS_A], "during: base + pinned");
  assert.strictEqual(s.cfg.alwaysOnSolarSystemIDs, before, "after: the same reference");
  assert.deepStrictEqual(before, [BASE_ON], "base not mutated");
  const boom = new Error("vendor sweep boom");
  s.rt.throwNext = boom;
  let caught = null;
  try { s.sweep(1000); } catch (error) { caught = error; }
  assert.strictEqual(caught, boom, "same exception");
  assert.strictEqual(s.cfg.alwaysOnSolarSystemIDs, before, "restored after the exception");
  assert.strictEqual(s.retention.status().disabledReason, null, "a vendor exception does not disable retention");
  delete s.cfg.alwaysOnSolarSystemIDs;
  s.sweep(2000);
  assert.deepStrictEqual(s.rt.seenAlwaysOn, [SYS_A]);
  assert.ok(!Object.prototype.hasOwnProperty.call(s.cfg, "alwaysOnSolarSystemIDs"), "key was absent -> stays absent");
  s.cfg.alwaysOnSolarSystemIDs = before;
  s.registry.getSessions = () => { s.registry.getCalls += 1; throw new Error("registry boom"); };
  const calls = s.rt.calls;
  s.sweep(3000);
  assert.strictEqual(s.rt.calls, calls + 1);
  assert.strictEqual(s.rt.seenRef, before, "the original sees an untouched config");
  assert.strictEqual(s.retention.status().disabledReason, "error");
  assert.deepStrictEqual(s.out.lines, ["WARN sceneRetention disabled: error (registry boom)"]);
  const getCalls = s.registry.getCalls;
  s.sweep(4000);
  assert.strictEqual(s.registry.getCalls, getCalls, "after disabling no getSessions");
  assert.strictEqual(s.rt.calls, calls + 2);
  assert.strictEqual(s.out.lines.length, 1);
  assert.ok(s.retention.drainStatsLines()[0].includes("state=disabled:error"));
});

test("R3 limits and order: 16 newest, the base does not count toward the limit, scene not loaded, pinRecent per character, RSS", () => {
  const s = retentionSetup();
  const systems = Array.from({ length: 20 }, (_, i) => 31000001 + i);
  for (const sys of systems) s.rt.addScene(sys, 0);
  s.rt.addScene(BASE_ON, 0);
  systems.forEach((sys, i) => { s.sessions.push(dockedSession(100 + i, sys)); s.sweep(i * 1000); });
  s.sessions.push(dockedSession(500, BASE_ON));
  s.sessions.push(dockedSession(501, 31009999));
  s.sweep(21000);
  const pinned = s.retention.status().pinnedNow;
  assert.deepStrictEqual(pinned, systems.slice(4).reverse(), "16 newest dockedSince");
  assert.ok(!pinned.includes(BASE_ON) && !pinned.includes(31009999));
  assert.strictEqual(s.retention.statsSnapshot().cappedMax, 4);
  const line = s.retention.drainStatsLines()[0];
  assert.ok(/^stats sceneRetention state=on sweeps=21 sweepsWithPins=21 pinnedMax=16 pinnedNow=16 dockedMax=20 recentMax=0 cappedMax=4 released=4 rssSkips=0 computeMaxMs=\d+\.\d errors=0$/.test(line), line);
  const r = retentionSetup({ sceneRetentionPinRecent: true, sceneRetentionPinDocked: false });
  const visited = Array.from({ length: 6 }, (_, i) => 32000001 + i);
  for (const sys of visited) r.rt.addScene(sys, 0);
  r.sessions.push(null);
  visited.forEach((sys, i) => { r.sessions[0] = spaceSession(9, sys); r.sweep(i * 1000); });
  assert.deepStrictEqual(r.retention.status().pinnedNow, [32000005, 32000004, 32000003, 32000002]);
  assert.ok(r.retention.statsSnapshot().trackedRecentCharacters === 1);
  const g = retentionSetup({ sceneRetentionRssCeilingMb: 1000 }, { rss: () => 2000 * 1048576 });
  g.rt.addScene(SYS_A);
  g.sessions.push(dockedSession(1, SYS_A));
  g.sweep(0);
  assert.deepStrictEqual(g.retention.status().pinnedNow, []);
  assert.deepStrictEqual(g.rt.seenAlwaysOn, [BASE_ON]);
  assert.strictEqual(g.retention.statsSnapshot().rssSkips, 1);
  const z = retentionSetup({ sceneRetentionMaxPinnedTotal: 0 });
  z.rt.addScene(SYS_A);
  z.sessions.push(dockedSession(1, SYS_A));
  z.sweep(0);
  assert.deepStrictEqual(z.retention.statsSnapshot().cappedMax, 1);
  assert.deepStrictEqual(z.rt.seenAlwaysOn, [BASE_ON]);
  const f = retentionSetup({ sceneRetentionMaxPinnedTotal: 1.5 });
  for (const sys of [SYS_A, 31000001, 31000002]) {
    f.rt.addScene(sys, 0);
    f.sessions.push(dockedSession(f.sessions.length + 1, sys));
  }
  f.sweep(0);
  assert.strictEqual(f.retention.status().pinnedNow.length, 1);
  assert.strictEqual(f.retention.statsSnapshot().cappedMax, 2);
});

function runtimeExportsOf(rt) {
  const exp = {};
  Object.setPrototypeOf(exp, Object.getPrototypeOf(rt));
  return exp;
}

test("R4 loader: flag off without points, on = measurement above retention through Module._load, probe drift, exact targetOf", () => {
  const off = createState(config, createRecorder(config, () => {}));
  assert.strictEqual(off.retention, null);
  for (const p of loader.RETENTION_POINTS) assert.ok(!off.expected.has(p.symbol), p.symbol);
  assert.ok(!off.pendingCacheTargets.has("sessionRegistry") && !off.pendingCacheTargets.has("vendorConfig"));
  const offRt = fakeSpaceRuntime(fakeVendorConfig());
  const vendorSweep = Object.getPrototypeOf(offRt).collectEmptySolarSystems;
  patchTarget("spaceRuntime", runtimeExportsOf(offRt), off);
  assert.strictEqual(Object.getPrototypeOf(offRt).collectEmptySolarSystems.__hotPathPerf, vendorSweep);
  const out = capture();
  const cfg = fakeVendorConfig();
  const rt = fakeSpaceRuntime(cfg);
  const sessions = [dockedSession(1, SYS_A)];
  const registry = { getSessions: () => sessions.slice() };
  const files = {
    runtime: "/app/server/src/space/runtime.js",
    registry: "/app/server/src/services/chat/sessionRegistry.js",
    config: "/app/server/src/config/index.js",
  };
  const exportsByFile = { [files.runtime]: runtimeExportsOf(rt), [files.registry]: registry, [files.config]: cfg };
  const state = createState(retentionConfig, createRecorder({ slowCallMs: 1e9 }, () => {}), { log: out.log });
  const savedLoad = Module._load;
  const savedResolve = Module._resolveFilename;
  try {
    Module._resolveFilename = function fakeResolve(request) {
      if (/(^|\/)runtime$/.test(request)) return files.runtime;
      if (/sessionRegistry$/.test(request)) return files.registry;
      if (/\/config$/.test(request)) return files.config;
      return savedResolve.apply(Module, arguments);
    };
    Module._load = function base(request, parent, isMain) {
      const file = Module._resolveFilename(request, parent, isMain);
      return exportsByFile[file] || savedLoad.apply(this, arguments);
    };
    installHook(state);
    const parent = { filename: "/app/server/src/space/runtime/startupPreloadPlan.js" };
    Module._load("/app/server/src/config", parent, false);
    Module._load("../../services/chat/sessionRegistry", parent, false);
    Module._load("../runtime", parent, false);
  } finally {
    Module._load = savedLoad;
    Module._resolveFilename = savedResolve;
  }
  for (const p of loader.RETENTION_POINTS) assert.ok(state.patched.has(p.symbol), p.symbol);
  const top = Object.getPrototypeOf(rt).collectEmptySolarSystems;
  assert.ok(top.__hotPathPerf, "measurement on top");
  assert.ok(top.__hotPathPerf.__hotPathPerfRetention, "retention directly under the measurement, on the vendor");
  assert.strictEqual(state.retention.status().depsReady, true);
  rt.addScene(SYS_A);
  rt.collectEmptySolarSystems(0);
  assert.deepStrictEqual(rt.seenAlwaysOn, [BASE_ON, SYS_A]);
  assert.deepStrictEqual(cfg.alwaysOnSolarSystemIDs, [BASE_ON]);
  patchTarget("spaceRuntime", runtimeExportsOf(rt), state);
  assert.strictEqual(Object.getPrototypeOf(rt).collectEmptySolarSystems, top, "idempotence");
  const drift = createState(retentionConfig, createRecorder(config, () => {}), { log: out.log });
  drift.gameSeen = true;
  patchTarget("spaceRuntime", runtimeExportsOf(fakeSpaceRuntime(fakeVendorConfig())), drift);
  assert.strictEqual(loader.checkRetentionDrift(drift), true);
  const message = probeMessage(drift);
  assert.ok(/^DRIFT: /.test(message) && message.includes("sessionRegistry#deps") && message.includes("config#deps"), message);
  assert.ok(message.endsWith("; sceneRetention disabled: drift"), message);
  assert.ok(!message.includes("#retention"), "a wrapped point is not in DRIFT");
  assert.ok(out.lines.includes("WARN sceneRetention disabled: drift (sessionRegistry#deps, config#deps)"), out.lines.join("|"));
  assert.ok(!loader.missingSymbols(drift).some((symbol) => symbol.endsWith("#deps")), "not expected after disabling");
  assert.strictEqual(targetOf("/app/server/src/services/x/config/index.js"), null);
  assert.strictEqual(targetOf("/app/server/src/config/index.js"), "vendorConfig");
  assert.strictEqual(targetOf("C:\\EveJS\\server\\src\\services\\chat\\sessionRegistry.js"), "sessionRegistry");
});

test("R5 vendor facts 261028.1: sweep, always-on, config, sessions, completeness", () => {
  const norm = (rel) => src(rel).replace(/\r\n/g, "\n");
  assert.ok(norm("space/runtime/spaceRuntime/tick.js").includes("this.collectEmptySolarSystems(now)"));
  const disposal = norm("space/runtime/spaceRuntime/sceneDisposal.js");
  const at = (text) => { const i = disposal.indexOf(text); assert.ok(i >= 0, text); return i; };
  assert.ok(at("const alwaysOnSystemIDs = new Set(resolveAlwaysOnSolarSystemIDs());") < at("for (const scene of [...this.scenes.values()])"));
  assert.ok(at("this.noteSolarSystemSceneEmpty(scene, now);") < at("if (alwaysOnSystemIDs.has(systemID))"));
  assert.ok(norm("space/runtime/startupPreloadPlan.js").includes("normalizeStartupSystemIDs(config.alwaysOnSolarSystemIDs)"));
  const registry = norm("space/runtime/spaceRuntime/sceneRegistry.js");
  const method = (name) => {
    const start = registry.search(new RegExp(`^${name}\\(`, "m"));
    assert.ok(start >= 0, name);
    return registry.slice(start, registry.indexOf("\n  },", start));
  };
  assert.ok(method("noteSolarSystemSceneEmpty").includes("scene._emptySinceWallclockMs === null ||"));
  assert.ok(method("isSolarSystemSceneLoaded").includes("this.scenes.has("));
  const manager = norm("config/manager.js");
  assert.ok(manager.includes("const config = {};") && manager.includes("Object.assign(config, state.resolvedConfig)"));
  assert.ok(!manager.includes("Object.freeze(config)"));
  const sessions = norm("services/chat/sessionRegistry.js");
  assert.ok(sessions.includes("function getSessions()") && /^  getSessions,$/m.test(sessions));
  const character = norm("services/character/characterState.js");
  for (const line of ["session.stationid = isDocked ? stationID : null;", "session.structureid = isDocked ? structureID : null;", "session.solarsystemid2 = solarSystemID;"]) {
    assert.ok(character.includes(line), line);
  }
  const readers = [];
  const callers = [];
  for (const file of listJs(SERVER_SRC)) {
    const text = fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");
    const rel = path.relative(SERVER_SRC, file).replace(/\\/g, "/");
    if (text.includes("config.alwaysOnSolarSystemIDs")) readers.push(rel);
    if (!text.includes("collectEmptySolarSystems(")) continue;
    const calls = (text.match(/collectEmptySolarSystems\(/g) || []).length - (text.match(/^collectEmptySolarSystems\(/gm) || []).length;
    if (calls > 0) callers.push(rel);
  }
  assert.deepStrictEqual(readers, ["space/runtime/startupPreloadPlan.js"], "new reader of config.alwaysOnSolarSystemIDs");
  assert.deepStrictEqual(callers.sort(), ["space/runtime.js", "space/runtime/spaceRuntime/tick.js"], "new sweep call");
});

const { createLocationsPrewarm } = require("../lib/locationsPrewarm");
const { PREWARM_POINTS } = loader;
const PREWARM_SYMBOLS = PREWARM_POINTS.map((p) => p.symbol);

function msClock(list) {
  let i = 0;
  return () => list[Math.min(i++, list.length - 1)];
}

function fakeConfigService(calls, order, throws = false) {
  class ConfigService {
    Handle_GetMultiLocationsEx(args, session) {
      calls.push({ thisArg: this, args, session });
      if (order) order.push("handler");
      if (throws) throw new Error("boom");
      return [];
    }
  }
  return ConfigService;
}

function fakeRuntimeExports(order, returned, throws = false) {
  const proto = {
    preloadStartupSolarSystems(options) {
      order.push("preload");
      if (throws) throw new Error("preload boom");
      return returned;
    },
  };
  return { proto, exportsValue: Object.create(proto) };
}

test("P1 vendor facts 261028.1: handler without this, map before the loop, preload in the prototype, before listen, class export", () => {
  const norm = (rel) => src(rel).replace(/\r\n/g, "\n");
  const cfg = norm("services/config/configService.js");
  const start = cfg.indexOf("  Handle_GetMultiLocationsEx(args, session) {");
  assert.ok(start >= 0, "missing Handle_GetMultiLocationsEx(args, session)");
  const end = cfg.indexOf("\n  Handle_", start + 10);
  assert.ok(end > start, "missing the next Handle_ method");
  const body = cfg.slice(start, end);
  const code = body.split("\n").map((line) => line.replace(/\/\/.*$/, "")).join("\n");
  assert.ok(!code.includes("this.") && !code.includes("this["), "handler uses this");
  const mapAt = body.indexOf("getStaticLocationRowsById()");
  const loopAt = body.indexOf("for (const id of requestedIds)");
  assert.ok(mapAt >= 0 && loopAt > mapAt, "getStaticLocationRowsById() before the loop over IDs");
  assert.ok(body.includes("if (rows.length === 0)") && body.includes("return [];"), "empty list = []");
  assert.ok(/^module\.exports = ConfigService;$/m.test(cfg), "eksport = klasa");
  const preload = norm("space/runtime/spaceRuntime/scenePreload.js");
  assert.ok(preload.includes("preloadStartupSolarSystems(options = {})"));
  const runtime = norm("space/runtime.js");
  const tablesAt = runtime.indexOf("const spaceRuntimeMethodTables = [");
  assert.ok(tablesAt >= 0);
  const tables = runtime.slice(tablesAt, runtime.indexOf("];", tablesAt));
  assert.ok(tables.includes('require("./runtime/spaceRuntime/scenePreload")'), "scenePreload in the tables");
  assert.ok(runtime.includes("Object.defineProperty(SpaceRuntime.prototype, methodName"));
  const tcp = norm("network/tcp/index.js");
  const preloadAt = tcp.indexOf("spaceRuntime.preloadStartupSolarSystems(");
  const listenAt = tcp.indexOf("server.listen(");
  assert.ok(preloadAt >= 0 && listenAt > preloadAt, "preload before server.listen");
});

test("P2 pre-warm once, after the original, [[]] and null, same result; bypasses the hotpath-01 measurement", () => {
  const order = [];
  const calls = [];
  const out = capture();
  const prewarm = createLocationsPrewarm({ config, log: out.log, warn: () => assert.fail("warn"), now: msClock([10, 1234.4]) });
  const Cls = fakeConfigService(calls, order);
  assert.strictEqual(prewarm.setConfigService(Cls), true);
  assert.strictEqual(prewarm.setConfigService({}), false);
  const returned = { activationChanges: [] };
  const { proto } = fakeRuntimeExports(order, returned);
  const wrapped = prewarm.wrapPreload(proto.preloadStartupSolarSystems);
  assert.ok(wrapped.__hotPathPerfPrewarm);
  assert.strictEqual(wrapped.call(proto, { broadcast: false }), returned);
  assert.strictEqual(wrapped.call(proto, {}), returned);
  assert.deepStrictEqual(order, ["preload", "handler", "preload"]);
  assert.strictEqual(calls.length, 1);
  assert.deepStrictEqual(calls[0].args, [[]]);
  assert.strictEqual(calls[0].session, null);
  assert.strictEqual(calls[0].thisArg, Cls.prototype);
  assert.deepStrictEqual(out.lines, ["prewarm locations took 1224ms"]);
  assert.ok(/^prewarm locations took \d+ms$/.test(out.lines[0]));
  assert.deepStrictEqual(prewarm.status(), { done: true, ok: true, ms: 1224, reason: null });
  assert.deepStrictEqual(prewarm.runOnce(), { ok: false, reason: "ALREADY_DONE" });
  const calls2 = [];
  const Cls2 = fakeConfigService(calls2, null);
  const recorder = createRecorder({ slowCallMs: 0 }, () => {});
  const name = "ConfigService.Handle_GetMultiLocationsEx";
  assert.ok(wrapProperty(Cls2.prototype, "Handle_GetMultiLocationsEx", recorder, { name, before: () => recorder.nextCount(name) }));
  const p2 = createLocationsPrewarm({ config, log: () => {}, warn: () => assert.fail("warn") });
  p2.setConfigService(Cls2);
  assert.strictEqual(p2.runOnce().ok, true);
  assert.strictEqual(calls2.length, 1);
  assert.strictEqual(recorder.counters.get(name), undefined, "pre-warm does not count as a client call");
  assert.strictEqual(recorder.snapshot().calls.size, 0);
});

test("P3 pre-warm error = WARN, startup continues; missing class = skipped; the original's exception passes without pre-warm", () => {
  const order = [];
  const warns = [];
  const prewarm = createLocationsPrewarm({ config, log: () => assert.fail("log"), warn: (l) => warns.push(l), now: msClock([0, 7]) });
  prewarm.setConfigService(fakeConfigService([], order, true));
  const returned = { ok: 1 };
  const { proto } = fakeRuntimeExports(order, returned);
  assert.strictEqual(prewarm.wrapPreload(proto.preloadStartupSolarSystems).call(proto), returned);
  assert.deepStrictEqual(warns, ["prewarm locations failed after 7ms: boom"]);
  assert.deepStrictEqual(prewarm.status(), { done: true, ok: false, ms: 7, reason: "THREW" });
  const warns2 = [];
  const noCls = createLocationsPrewarm({ config, log: () => assert.fail("log"), warn: (l) => warns2.push(l) });
  const p = fakeRuntimeExports([], returned);
  assert.strictEqual(noCls.wrapPreload(p.proto.preloadStartupSolarSystems).call(p.proto), returned);
  assert.deepStrictEqual(warns2, ["prewarm locations skipped: CONFIG_SERVICE_NOT_LOADED"]);
  assert.strictEqual(noCls.status().reason, "CONFIG_SERVICE_NOT_LOADED");
  const order3 = [];
  const calls3 = [];
  const p3 = createLocationsPrewarm({ config, log: () => {}, warn: () => {} });
  p3.setConfigService(fakeConfigService(calls3, order3));
  const t = fakeRuntimeExports(order3, null, true);
  assert.throws(() => p3.wrapPreload(t.proto.preloadStartupSolarSystems).call(t.proto), /preload boom/);
  assert.strictEqual(calls3.length, 0);
  assert.strictEqual(p3.status().done, false);
});

test("P4 loader: flag off without pre-warm points; on = both in patched, no double wrap; env; enabled=false", () => {
  const off = createState({ ...config, prewarmLocations: false }, createRecorder(config, () => {}));
  assert.strictEqual(off.prewarm, null);
  for (const s of PREWARM_SYMBOLS) assert.ok(!off.expected.has(s), s);
  const offRt = fakeRuntimeExports([], {});
  const originalPreload = offRt.proto.preloadStartupSolarSystems;
  patchTarget("spaceRuntime", offRt.exportsValue, off);
  assert.strictEqual(offRt.proto.preloadStartupSolarSystems, originalPreload, "flag off = untouched");

  const lines = [];
  const on = createState(config, createRecorder({ ...config, slowCallMs: 1e9 }, () => {}), { log: (l) => lines.push(l), warn: () => assert.fail("warn") });
  assert.ok(on.prewarm);
  for (const s of PREWARM_SYMBOLS) assert.ok(on.expected.has(s), s);
  const order = [];
  const calls = [];
  const Cls = fakeConfigService(calls, order);
  patchTarget("configService", Cls, on);
  const rt = fakeRuntimeExports(order, { done: true });
  patchTarget("spaceRuntime", rt.exportsValue, on);
  for (const s of PREWARM_SYMBOLS) assert.ok(on.patched.has(s), s);
  const wrapped = rt.proto.preloadStartupSolarSystems;
  assert.ok(wrapped.__hotPathPerfPrewarm);
  on.patched.delete("SpaceRuntime.preloadStartupSolarSystems#prewarm");
  patchTarget("spaceRuntime", rt.exportsValue, on);
  assert.strictEqual(rt.proto.preloadStartupSolarSystems, wrapped, "a second patchTarget does not wrap again");
  assert.deepStrictEqual(rt.exportsValue.preloadStartupSolarSystems({}), { done: true });
  assert.deepStrictEqual(order, ["preload", "handler"]);
  assert.strictEqual(on.recorder.counters.get("ConfigService.Handle_GetMultiLocationsEx"), undefined, "measurement above the handler skipped");
  assert.ok(Cls.prototype.Handle_GetMultiLocationsEx.__hotPathPerf, "the hotpath-01 measurement still wraps the handler");
  assert.ok(lines.some((l) => /^prewarm locations took \d+ms$/.test(l)), lines.join("|"));

  assert.strictEqual(config.prewarmLocations, true);
  assert.strictEqual(loadConfig({ env: { HOTPATH_PREWARM_LOCATIONS: "0" }, settingsPath: path.join(__dirname, "missing.json") }).prewarmLocations, false);
  assert.strictEqual(install({ env: {}, config: { ...config, enabled: false } }), null);
});

require("./hotpath05").register({ test, src, listJs, capture, config, loader, createRecorder, SERVER_SRC });

require("./hotpath06").register({ test, src, listJs, capture, config, loader, createRecorder, SERVER_SRC });

require("./hotpath07").register({ test, src, listJs, capture, config, loader, createRecorder, SERVER_SRC });

require("./hotpath08").register({ test, src, listJs, capture, config, loader, createRecorder, SERVER_SRC });

require("./hotpath09").register({ test, src, listJs, capture, config, loader, createRecorder, SERVER_SRC });

require("./hotpath10").register({ test, src, listJs, capture, config, loader, createRecorder, SERVER_SRC });

require("./hotpath11").register({ test, src, listJs, capture, config, loader, createRecorder, SERVER_SRC });

require("./hotpath12").register({ test, src, listJs, capture, config, loader, createRecorder, SERVER_SRC });

require("./hotpath13").register({ test, src, listJs, capture, config, loader, createRecorder, SERVER_SRC });

require("./hotpath14").register({ test, src, listJs, capture, config, loader, createRecorder, SERVER_SRC });

require("./hotpath15").register({ test, src, listJs, capture, config, loader, createRecorder, SERVER_SRC });

require("./hotpath16").register({ test, src, listJs, capture, config, loader, createRecorder, SERVER_SRC });

require("./hotpath17").register({ test, src, listJs, capture, config, loader, createRecorder, SERVER_SRC });

require("./hotpath18").register({ test, src, listJs, capture, config, loader, createRecorder, SERVER_SRC });

require("./hotpath19").register({ test, src, listJs, capture, config, loader, createRecorder, SERVER_SRC });

require("./hotpath20").register({ test, src, listJs, capture, config, loader, createRecorder, SERVER_SRC });

require("./hotpathIncursion").register({ test, src, listJs, capture, config, loader, createRecorder, SERVER_SRC });

require("./hotpathBounty").register({ test, src, listJs, capture, config, loader, createRecorder, SERVER_SRC });

require("./hotpathDungeonRead").register({ test, src, listJs, capture, config, loader, createRecorder, SERVER_SRC });

require("./hotpathCareerReprocessing").register({ test, src, listJs, capture, config, loader, createRecorder, SERVER_SRC });

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
