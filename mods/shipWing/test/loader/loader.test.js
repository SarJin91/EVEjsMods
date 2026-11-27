"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const loader = require("../../loader");
const { loadConfig } = require("../../config");
const { WRAPPED } = require("../../lib/adapter/bootWrap");
const { DELIVERY_KEY } = require("../../lib/adapter/clientDelivery");
const { sha256 } = require("../../lib/adapter/handshakeHook");

const FAKE_HANDSHAKE = "function buildTidiSignedFunc(clientId, options = {}) { return clientId; }\n"
  + "const x = [buildTidiSignedFunc(this.clientId, { accountRole: this.accountRole }), 0];\n";
const FAKE_HANDSHAKE_HASH = sha256(FAKE_HANDSHAKE);

function fakeHandshakeDeps() {
  const root = path.join(path.sep, "srv");
  return {
    root,
    readFile: (file) => (file === path.join(root, "server", "src", "network", "tcp", "handshake.js")
      ? FAKE_HANDSHAKE : fs.readFileSync(file, "utf8")),
  };
}

const BOOTSTRAP = path.join(path.sep, "srv", "server", "bootstrap.js");
const INDEX = { filename: path.join(path.sep, "srv", "server", "index.js") };

function bootstrapFixture(calls) {
  const world = { database: { _processRole: "world" } };
  const promise = Promise.resolve(world);
  return {
    exports: {
      bootWorld(options) {
        calls.push(options);
        return promise;
      },
      PRODUCTION_STAGES: { tcp: true },
    },
    promise,
  };
}

function fakeModuleApi(modules) {
  return {
    _cache: {},
    prototype: { _compile() {} },
    _load(request) {
      return modules[request];
    },
    _resolveFilename(request) {
      return request;
    },
  };
}

function fakeLogger() {
  const lines = [];
  return { lines, log: (m) => lines.push(m), logError: (m) => lines.push(`ERR ${m}`), debug: () => {}, setDebug() {} };
}

function emptyModDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "shipwing-mod-"));
}

function lneLikeWrap(exportsObject, seen) {
  const found = exportsObject.bootWorld;
  function livingNewEdenBootWorld() {
    const result = found.apply(this, arguments);
    result.then(() => seen.push("lne"));
    return result;
  }
  for (const symbol of Object.getOwnPropertySymbols(found)) livingNewEdenBootWorld[symbol] = found[symbol];
  exportsObject.bootWorld = livingNewEdenBootWorld;
}

module.exports = ({ test }) => {
  test("L1 enabled=false (default) -> no Module._load hook, no INSTALL_FLAG, bootWorld not wrapped", () => {
    const modDir = emptyModDir();
    try {
      const calls = [];
      const fixture = bootstrapFixture(calls);
      const moduleApi = fakeModuleApi({ [BOOTSTRAP]: fixture.exports });
      const originalLoad = moduleApi._load;
      const globalObj = {};
      const result = loader.install({
        env: {}, moduleApi, globalObj, isMainThread: true, logger: fakeLogger(),
        loadConfig: () => loadConfig({ env: {}, modDir }),
      });
      assert.deepStrictEqual(result, { ok: false, reason: "disabled_by_config" });
      assert.strictEqual(moduleApi._load, originalLoad, "Module._load untouched");
      assert.ok(!(loader.INSTALL_FLAG in globalObj), "no INSTALL_FLAG");
      const loaded = moduleApi._load(BOOTSTRAP, INDEX);
      assert.strictEqual(loaded.bootWorld[WRAPPED], undefined, "bootWorld not wrapped");
    } finally {
      fs.rmSync(modDir, { recursive: true, force: true });
    }
  });

  test("L2 enabled=true + bootstrap fixture -> chained wrap with an LNE-like wrap, onBooted once", async () => {
    const modDir = emptyModDir();
    try {
      const calls = [];
      const seen = [];
      const fixture = bootstrapFixture(calls);
      const moduleApi = fakeModuleApi({ [BOOTSTRAP]: fixture.exports });
      const logger = fakeLogger();
      const globalObj = {};
      const env = { EVEJS_SHIPWING_ENABLED: "1", EVEJS_GAMESTORE_OWNER_ROLE: "world", EVEJS_DATA_ROOT: modDir };
      let started = 0;
      const result = loader.install({
        env, moduleApi, globalObj, isMainThread: true, logger,
        loadConfig: () => loadConfig({ env, modDir }),
        startServices: () => { started += 1; },
      });
      assert.strictEqual(result.ok, true);
      assert.strictEqual(globalObj[loader.INSTALL_FLAG], true);
      const innerLoad = moduleApi._load;
      moduleApi._load = function lneHook(request, parent) {
        const exportsObject = innerLoad.call(this, request, parent);
        if (request === BOOTSTRAP) lneLikeWrap(exportsObject, seen);
        return exportsObject;
      };
      const loaded = moduleApi._load(BOOTSTRAP, INDEX);
      assert.strictEqual(loaded.bootWorld[WRAPPED], true, "our mark kept through the outer wrap");
      const returned = loaded.bootWorld({ appName: "test" });
      assert.strictEqual(returned, fixture.promise, "the original promise object comes back");
      await returned;
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepStrictEqual(calls, [{ appName: "test" }], "original called once with its arguments");
      assert.deepStrictEqual(seen, ["lne"]);
      assert.strictEqual(started, 1);
      assert.ok(logger.lines.includes("bootSweep cleared=0 keptLost=0"), logger.lines.join("\n"));
      assert.ok(logger.lines.some((l) => l.startsWith("probe failed")), "probe line logged");
      await loaded.bootWorld({ appName: "again" });
      await new Promise((resolve) => setImmediate(resolve));
      assert.strictEqual(started, 1);
      const second = loader.install({ env, moduleApi, globalObj, isMainThread: true, logger,
        loadConfig: () => loadConfig({ env, modDir }) });
      assert.deepStrictEqual(second, { ok: false, reason: "already_installed" });
    } finally {
      fs.rmSync(modDir, { recursive: true, force: true });
    }
  });

  test("L3 config_invalid -> no store, no services; default services without the guards probe -> "
    + "core up, guards NOT installed (fail-closed)", async () => {
    const modDir = emptyModDir();
    try {
      fs.writeFileSync(path.join(modDir, "settings.json"), "{ nope");
      const env = { EVEJS_SHIPWING_ENABLED: "1", EVEJS_GAMESTORE_OWNER_ROLE: "world", EVEJS_DATA_ROOT: modDir };
      const fixture = bootstrapFixture([]);
      const moduleApi = fakeModuleApi({ [BOOTSTRAP]: fixture.exports });
      const logger = fakeLogger();
      let started = 0;
      const result = loader.install({ env, moduleApi, globalObj: {}, isMainThread: true, logger,
        loadConfig: () => loadConfig({ env, modDir }), startServices: () => { started += 1; } });
      assert.strictEqual(result.ok, true);
      await moduleApi._load(BOOTSTRAP, INDEX).bootWorld({});
      await new Promise((resolve) => setImmediate(resolve));
      assert.strictEqual(started, 0);
      assert.strictEqual(result.ctx.store, null, "state file never opened");
      assert.ok(logger.lines.includes("boot: not starting - config_invalid (1 error(s))"), logger.lines.join("\n"));
      assert.ok(!logger.lines.some((l) => l.startsWith("bootSweep")));
    } finally {
      fs.rmSync(modDir, { recursive: true, force: true });
    }

    const okDir = emptyModDir();
    try {
      const env = { EVEJS_SHIPWING_ENABLED: "1", EVEJS_GAMESTORE_OWNER_ROLE: "world", EVEJS_DATA_ROOT: okDir };
      const fixture = bootstrapFixture([]);
      const moduleApi = fakeModuleApi({ [BOOTSTRAP]: fixture.exports });
      const logger = fakeLogger();
      const timers = { set: 0, cleared: 0, setInterval() {
        timers.set += 1;
        return { unref() {} };
      }, clearInterval() {
        timers.cleared += 1;
      } };
      const result = loader.install({ env, moduleApi, globalObj: {}, isMainThread: true, logger, timers,
        loadConfig: () => loadConfig({ env, modDir: okDir }) });
      await moduleApi._load(BOOTSTRAP, INDEX).bootWorld({});
      await new Promise((resolve) => setImmediate(resolve));
      const ctx = result.ctx;
      const has = (prefix) => assert.ok(logger.lines.some((l) => l.startsWith(prefix)),
        `${prefix}\n${logger.lines.join("\n")}`);
      has("live adapter NOT available - probe_spawn_unavailable");
      has("guards NOT installed - probe_guards_unavailable");
      has("chat NOT installed - probe_chat_unavailable");
      has("loss hook NOT installed - probe_loss_unavailable; launch refused (LOSS_UNAVAILABLE)");
      assert.strictEqual(ctx.state.lossReady, false);
      has("shutdown hook not registered - SHUTDOWN_HOOK_UNAVAILABLE");
      assert.strictEqual(ctx.state.guardsReady, false);
      assert.deepStrictEqual(ctx.wing.orderCopy(90000001, 1000000501, "launch"), { ok: false, reason: "DISABLED" });
      assert.ok(logger.lines.some((l) => l.startsWith("ready v") && l.includes("blocked=0")), logger.lines.join("\n"));
      assert.strictEqual(timers.set, 2, "tick + telemetry timers");
      assert.strictEqual(ctx.stop("test"), true);
      assert.strictEqual(ctx.stop("test"), false);
      assert.strictEqual(timers.cleared, 2);
      has("telemetry records=0 live=0");
      has("stopped (test)");
    } finally {
      fs.rmSync(okDir, { recursive: true, force: true });
    }
  });

  test("L5 clientWindowEnabled=false -> Module.prototype._compile untouched, no client window start "
    + "(ready clientWindow=off); on -> _compile hook (hook:HOOKED), delivery not ready without the service; "
    + "on without the clientWindow probe -> NOT installed, the rest of the mod runs", async () => {
    for (const windowOn of [false, true]) {
      const dir = emptyModDir();
      try {
        const env = { EVEJS_SHIPWING_ENABLED: "1", EVEJS_GAMESTORE_OWNER_ROLE: "world", EVEJS_DATA_ROOT: dir,
          EVEJS_SHIPWING_CLIENT_WINDOW_ENABLED: windowOn ? "1" : "0",
          EVEJS_SHIPWING_CLIENT_WINDOW_HANDSHAKE_HASHES: FAKE_HANDSHAKE_HASH };
        const fixture = bootstrapFixture([]);
        const moduleApi = fakeModuleApi({ [BOOTSTRAP]: fixture.exports });
        const originalCompile = moduleApi.prototype._compile;
        const logger = fakeLogger();
        const timers = { setInterval: () => ({ unref() {} }), clearInterval() {} };
        const globalObj = {};
        const result = loader.install({ env, moduleApi, globalObj, isMainThread: true, logger, timers,
          loadConfig: () => loadConfig({ env, modDir: dir }), handshakeDeps: fakeHandshakeDeps() });
        assert.strictEqual(moduleApi.prototype._compile === originalCompile, !windowOn);
        assert.strictEqual(globalObj[DELIVERY_KEY] !== undefined, windowOn);
        await moduleApi._load(BOOTSTRAP, INDEX).bootWorld({});
        await new Promise((resolve) => setImmediate(resolve));
        const ready = logger.lines.find((l) => l.startsWith("ready v")) || "";
        assert.strictEqual(result.ctx.clientWindow, null, "no service registered");
        if (windowOn) {
          assert.ok(ready.endsWith("clientWindow=hook:HOOKED service:probe_clientWindow_unavailable "
            + "tasks=probe_tasks_unavailable twinControl=probe_twinControl_unavailable mining=off combat=off "
            + "mirror=off active=off safeLogoff=off logi=off prop=off weapons=off burst=off drones=off aggro=off "
            + "autoTarget=off droneMining=off formation=probe_formation_unavailable salvage=off board=off boardOrphan=off"), ready);
          assert.strictEqual(globalObj[DELIVERY_KEY].isReady(), false, "no service -> no client code");
          assert.ok(logger.lines.includes("client window NOT installed - probe_clientWindow_unavailable"),
            logger.lines.join("\n"));
        } else {
          assert.ok(ready.endsWith("clientWindow=off tasks=probe_tasks_unavailable "
            + "twinControl=probe_twinControl_unavailable mining=off combat=off mirror=off active=off safeLogoff=off "
            + "logi=off prop=off weapons=off burst=off drones=off aggro=off autoTarget=off droneMining=off formation=probe_formation_unavailable salvage=off board=off boardOrphan=off"),
          ready);
          assert.ok(!logger.lines.some((l) => l.startsWith("safe logoff")), "both flags off: no hook, no line");
          assert.strictEqual(result.ctx.safeLogoffHook, null);
          assert.ok(logger.lines.includes("twin control NOT available - probe_twinControl_unavailable; "
            + "no enabled verb affected"), logger.lines.join("\n"));
          assert.strictEqual(result.ctx.combatAccess, null);
          assert.ok(logger.lines.includes("derived-state guard NOT installed - probe_tasks_unavailable; task verbs off, "
            + "launch refused (DERIVED_GUARD_UNAVAILABLE)"), logger.lines.join("\n"));
          assert.strictEqual(result.ctx.state.derivedReady, false);
          assert.ok(!logger.lines.some((l) => l.startsWith("client window")), logger.lines.join("\n"));
        }
        assert.ok(logger.lines.includes("bootSweep cleared=0 keptLost=0"));
        assert.strictEqual(result.ctx.stop("test"), true);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  test("L5b clientWindow probe ok + service registered (service:ok) -> delivery "
    + "isReady() true; stop -> false", async () => {
    const adapterIndex = require("../../lib/adapter/index");
    const clientService = require("../../lib/adapter/clientService");
    const originalCreate = adapterIndex.createAdapter;
    const originalInstall = clientService.installClientServiceFromGame;
    const dir = emptyModDir();
    adapterIndex.createAdapter = (deps) => {
      const adapter = originalCreate(deps);
      const base = adapter.isConsumerAvailable;
      adapter.isConsumerAvailable = (name) => name === "clientWindow" || base(name);
      return adapter;
    };
    let installs = 0;
    clientService.installClientServiceFromGame = () => {
      installs += 1;
      return { ok: true, service: {} };
    };
    try {
      const env = { EVEJS_SHIPWING_ENABLED: "1", EVEJS_GAMESTORE_OWNER_ROLE: "world", EVEJS_DATA_ROOT: dir,
        EVEJS_SHIPWING_CLIENT_WINDOW_ENABLED: "1", EVEJS_SHIPWING_CLIENT_WINDOW_HANDSHAKE_HASHES: FAKE_HANDSHAKE_HASH };
      const moduleApi = fakeModuleApi({ [BOOTSTRAP]: bootstrapFixture([]).exports });
      const logger = fakeLogger();
      const globalObj = {};
      const result = loader.install({ env, moduleApi, globalObj, isMainThread: true, logger,
        timers: { setInterval: () => ({ unref() {} }), clearInterval() {} },
        loadConfig: () => loadConfig({ env, modDir: dir }), handshakeDeps: fakeHandshakeDeps() });
      assert.strictEqual(globalObj[DELIVERY_KEY].isReady(), false, "not ready before the service");
      await moduleApi._load(BOOTSTRAP, INDEX).bootWorld({});
      await new Promise((resolve) => setImmediate(resolve));
      const ready = logger.lines.find((l) => l.startsWith("ready v")) || "";
      assert.ok(ready.includes("clientWindow=hook:HOOKED service:ok"), ready);
      assert.strictEqual(installs, 1);
      assert.strictEqual(globalObj[DELIVERY_KEY].isReady(), true, "service:ok -> setReady(true)");
      assert.strictEqual(result.ctx.stop("test"), true);
      assert.strictEqual(globalObj[DELIVERY_KEY].isReady(), false, "stop -> setReady(false)");
    } finally {
      adapterIndex.createAdapter = originalCreate;
      clientService.installClientServiceFromGame = originalInstall;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("L-UP1 (command panel) service:ok -> Symbol.for(evejs.shipWing.uiPrefs.v1) on globalObj "
    + "set -> get; stop removes the key and writes wingUiPrefs.json", async () => {
    const adapterIndex = require("../../lib/adapter/index");
    const clientService = require("../../lib/adapter/clientService");
    const originalCreate = adapterIndex.createAdapter;
    const originalInstall = clientService.installClientServiceFromGame;
    const dir = emptyModDir();
    adapterIndex.createAdapter = (deps) => {
      const adapter = originalCreate(deps);
      const base = adapter.isConsumerAvailable;
      adapter.isConsumerAvailable = (name) => name === "clientWindow" || base(name);
      return adapter;
    };
    clientService.installClientServiceFromGame = () => ({ ok: true, service: {} });
    const KEY = Symbol.for("evejs.shipWing.uiPrefs.v1");
    try {
      const env = { EVEJS_SHIPWING_ENABLED: "1", EVEJS_GAMESTORE_OWNER_ROLE: "world", EVEJS_DATA_ROOT: dir,
        EVEJS_SHIPWING_CLIENT_WINDOW_ENABLED: "1", EVEJS_SHIPWING_CLIENT_WINDOW_HANDSHAKE_HASHES: FAKE_HANDSHAKE_HASH };
      const moduleApi = fakeModuleApi({ [BOOTSTRAP]: bootstrapFixture([]).exports });
      const globalObj = {};
      const result = loader.install({ env, moduleApi, globalObj, isMainThread: true, logger: fakeLogger(),
        timers: { setInterval: () => ({ unref() {} }), clearInterval() {} },
        loadConfig: () => loadConfig({ env, modDir: dir }), handshakeDeps: fakeHandshakeDeps() });
      assert.strictEqual(globalObj[KEY], undefined, "no API before the window");
      await moduleApi._load(BOOTSTRAP, INDEX).bootWorld({});
      await new Promise((resolve) => setImmediate(resolve));
      const api = globalObj[KEY];
      assert.ok(api && api.version === 1 && typeof api.open === "function", "API published");
      assert.deepStrictEqual(api.set(90000001, true), { ok: true, openAtLogin: true, persisted: true });
      assert.deepStrictEqual(api.get(90000001), { ok: true, openAtLogin: true });
      assert.deepStrictEqual(api.open(90000001), { ok: false, reason: "CLIENT_NOT_READY" });
      assert.strictEqual(result.ctx.stop("test"), true);
      assert.strictEqual(KEY in globalObj, false, "stop removes the key");
      assert.deepStrictEqual(api.get(90000001), { ok: false, reason: "WINDOW_OFF" });
      const file = path.join(dir, "mods", "shipWing", "wingUiPrefs.json");
      assert.deepStrictEqual(JSON.parse(fs.readFileSync(file, "utf8")).pilots, { 90000001: { openAtLogin: true } });
    } finally {
      adapterIndex.createAdapter = originalCreate;
      clientService.installClientServiceFromGame = originalInstall;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("L6 miningEnabled+combatEnabled without probes: the twin-control line names the verbs "
    + "really off (mine, attack), combat access NOT available -> ready combat=probe_combat_unavailable; "
    + "combat telemetry only from the access", async () => {
    const dir = emptyModDir();
    try {
      const env = { EVEJS_SHIPWING_ENABLED: "1", EVEJS_GAMESTORE_OWNER_ROLE: "world", EVEJS_DATA_ROOT: dir,
        EVEJS_SHIPWING_MINING_ENABLED: "1", EVEJS_SHIPWING_COMBAT_ENABLED: "1",
        EVEJS_SHIPWING_COMMAND_MIRROR_ENABLED: "1", EVEJS_SHIPWING_ACTIVE_MODULES_ENABLED: "1",
        EVEJS_SHIPWING_SAFE_LOGOFF_ABORT_ON_ORDER: "1", EVEJS_SHIPWING_LOGI_ENABLED: "1",
        EVEJS_SHIPWING_ACTIVE_PROP_ENABLED: "1", EVEJS_SHIPWING_BURST_ENABLED: "1",
        EVEJS_SHIPWING_DRONES_ENABLED: "1" };
      const fixture = bootstrapFixture([]);
      const moduleApi = fakeModuleApi({ [BOOTSTRAP]: fixture.exports });
      const logger = fakeLogger();
      const timers = { setInterval: () => ({ unref() {} }), clearInterval() {} };
      const result = loader.install({ env, moduleApi, globalObj: {}, isMainThread: true, logger, timers,
        loadConfig: () => loadConfig({ env, modDir: dir }) });
      await moduleApi._load(BOOTSTRAP, INDEX).bootWorld({});
      await new Promise((resolve) => setImmediate(resolve));
      const lines = logger.lines.join("\n");
      assert.ok(logger.lines.includes("twin control NOT available - probe_twinControl_unavailable; mine, attack off"),
        lines);
      assert.ok(logger.lines.includes("combat access NOT available - probe_combat_unavailable; attack off"), lines);
      const ready = logger.lines.find((l) => l.startsWith("ready v")) || "";
      assert.ok(ready.endsWith(" combat=probe_combat_unavailable mirror=probe_mirror_unavailable "
        + "active=probe_active_twinControl_unavailable safeLogoff=probe_safeLogoff_unavailable "
        + "logi=probe_active_twinControl_unavailable prop=probe_active_twinControl_unavailable "
        + "weapons=probe_combat_unavailable burst=probe_burst_unavailable drones=probe_drones_unavailable aggro=off "
        + "autoTarget=off droneMining=off formation=probe_formation_unavailable salvage=off board=off boardOrphan=off"), ready);
      assert.ok(logger.lines.includes("copy drones NOT available - probe_drones_unavailable; twins launch no drones"),
        lines);
      assert.strictEqual(result.ctx.drones, null);
      assert.ok(logger.lines.includes("command burst NOT available - probe_burst_unavailable; twins get no command "
        + "bursts"), lines);
      assert.strictEqual(result.ctx.burst, null);
      assert.ok(logger.lines.includes("safe logoff hook NOT installed - probe_safeLogoff_unavailable; safe logoff "
        + "unchanged"), lines);
      assert.strictEqual(result.ctx.safeLogoffHook, null);
      assert.ok(logger.lines.includes("active modules NOT available - probe_active_twinControl_unavailable; twins fly "
        + "without active modules"), lines);
      assert.ok(logger.lines.includes("command mirror NOT installed - probe_mirror_unavailable; mirror off"), lines);
      assert.strictEqual(result.ctx.commandMirror, null);
      assert.strictEqual(result.ctx.combatAccess, null);
      assert.ok(!result.ctx.wing.SUPPORTED_VERBS.includes("attack"), "no combat probe -> no attack engine");
      assert.strictEqual(result.ctx.stop("test"), true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("L7 a start step that throws (guards, chat; tick driver) -> one ERR line and a "
    + "start.error.<step> counter, the next steps run: ready line, shutdown hook registered once", async () => {
    const guards = require("../../lib/adapter/guards");
    const chatHook = require("../../lib/adapter/chatHook");
    const tickDriver = require("../../lib/core/tickDriver");
    const vendor = require("../../lib/adapter/vendor");
    const saved = [guards.installGuardsFromGame, chatHook.installChatFromGame, tickDriver.createTickDriver,
      vendor.createLiveAdapter];
    const boom = () => {
      throw new Error("boom");
    };
    try {
      for (const variant of ["guards+chat", "tick"]) {
        const dir = emptyModDir();
        try {
          guards.installGuardsFromGame = variant === "guards+chat" ? boom : saved[0];
          chatHook.installChatFromGame = variant === "guards+chat" ? boom : saved[1];
          tickDriver.createTickDriver = variant === "tick" ? boom : saved[2];
          vendor.createLiveAdapter = variant === "tick" ? () => ({ ok: true, adapter: {} }) : saved[3];
          const env = { EVEJS_SHIPWING_ENABLED: "1", EVEJS_GAMESTORE_OWNER_ROLE: "world", EVEJS_DATA_ROOT: dir };
          let hooks = 0;
          const world = { database: { _processRole: "world", registerShutdownHook: () => {
            hooks += 1;
          } } };
          const moduleApi = fakeModuleApi({ [BOOTSTRAP]: { bootWorld: () => Promise.resolve(world),
            PRODUCTION_STAGES: { tcp: true } } });
          const logger = fakeLogger();
          const result = loader.install({ env, moduleApi, globalObj: {}, isMainThread: true, logger,
            timers: { setInterval: () => ({ unref() {} }), clearInterval() {} },
            loadConfig: () => loadConfig({ env, modDir: dir }) });
          await moduleApi._load(BOOTSTRAP, INDEX).bootWorld({});
          await new Promise((resolve) => setImmediate(resolve));
          const lines = logger.lines.join("\n");
          const ready = logger.lines.find((l) => l.startsWith("ready v")) || "";
          assert.ok(ready.includes(" clientWindow=off "), lines);
          assert.ok(!lines.includes("mod not running"), lines);
          assert.strictEqual(hooks, 1, "shutdown hook registered once");
          const ctx = result.ctx;
          if (variant === "guards+chat") {
            assert.ok(logger.lines.includes("ERR guards failed - launch refused (GUARDS_UNAVAILABLE)"), lines);
            assert.ok(logger.lines.includes("ERR chat failed - no chat orders"), lines);
            assert.deepStrictEqual([ctx.state.guardsReady, ctx.chat], [false, null]);
            assert.ok(ready.includes(" guards=false ") && ready.includes(" chat=false "), ready);
            assert.strictEqual(ctx.state.tickReady, true, "tick driver started -> tickReady");
            assert.strictEqual(ctx.stop("test"), true);
            const last = logger.lines.find((l) => l.startsWith("telemetry ") && l.endsWith("(shutdown)")) || "";
            assert.ok(last.includes("start.error.chat=1 start.error.guards=1"), lines);
          } else {
            assert.ok(logger.lines.includes("ERR tick driver failed - launch refused (TICK_UNAVAILABLE)"), lines);
            assert.strictEqual(ctx.driver, null);
            assert.deepStrictEqual(ctx.state.startErrors, { "start.error.tick": 1 });
            Object.assign(ctx.state, { guardsReady: true, lossReady: true, derivedReady: true });
            assert.deepStrictEqual(ctx.wing.orderCopy(90000001, 1000000501, "launch"),
              { ok: false, reason: "TICK_UNAVAILABLE" });
            assert.strictEqual(ctx.stop("test"), true);
            assert.ok(logger.lines.includes("stopped (test)"), lines);
          }
        } finally {
          fs.rmSync(dir, { recursive: true, force: true });
        }
      }
    } finally {
      [guards.installGuardsFromGame, chatHook.installChatFromGame, tickDriver.createTickDriver,
        vendor.createLiveAdapter] = saved;
    }
  });

  test("L8 driver.start() refused ({ok:false}) -> tickReady false, launch refused "
    + "TICK_UNAVAILABLE; no ERR line (the start did not throw)", async () => {
    const tickDriver = require("../../lib/core/tickDriver");
    const vendor = require("../../lib/adapter/vendor");
    const saved = [tickDriver.createTickDriver, vendor.createLiveAdapter];
    const dir = emptyModDir();
    try {
      tickDriver.createTickDriver = () => ({ start: () => ({ ok: false, reason: "stopped" }), stop: () => true,
        isRunning: () => false, stats: () => ({ ticks: 0, errors: 0 }) });
      vendor.createLiveAdapter = () => ({ ok: true, adapter: {} });
      const env = { EVEJS_SHIPWING_ENABLED: "1", EVEJS_GAMESTORE_OWNER_ROLE: "world", EVEJS_DATA_ROOT: dir };
      const moduleApi = fakeModuleApi({ [BOOTSTRAP]: bootstrapFixture([]).exports });
      const logger = fakeLogger();
      const result = loader.install({ env, moduleApi, globalObj: {}, isMainThread: true, logger,
        timers: { setInterval: () => ({ unref() {} }), clearInterval() {} },
        loadConfig: () => loadConfig({ env, modDir: dir }) });
      await moduleApi._load(BOOTSTRAP, INDEX).bootWorld({});
      await new Promise((resolve) => setImmediate(resolve));
      const ctx = result.ctx;
      assert.strictEqual(ctx.state.tickReady, false);
      assert.ok(!logger.lines.some((l) => l.startsWith("ERR tick")), logger.lines.join("\n"));
      Object.assign(ctx.state, { guardsReady: true, lossReady: true, derivedReady: true });
      assert.deepStrictEqual(ctx.wing.orderCopy(90000001, 1000000501, "launch"),
        { ok: false, reason: "TICK_UNAVAILABLE" });
      assert.strictEqual(ctx.stop("test"), true);
    } finally {
      [tickDriver.createTickDriver, vendor.createLiveAdapter] = saved;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("L9 (command burst, review) a stop step that throws (chat) -> one ERR line and "
    + "burst.clearAll still runs (own try); a throwing clearAll -> its own ERR line", async () => {
    const vendor = require("../../lib/adapter/vendor");
    const saved = vendor.createLiveAdapter;
    const dir = emptyModDir();
    try {
      vendor.createLiveAdapter = () => ({ ok: true, adapter: {} });
      const env = { EVEJS_SHIPWING_ENABLED: "1", EVEJS_GAMESTORE_OWNER_ROLE: "world", EVEJS_DATA_ROOT: dir };
      const boot = async () => {
        const moduleApi = fakeModuleApi({ [BOOTSTRAP]: bootstrapFixture([]).exports });
        const logger = fakeLogger();
        const result = loader.install({ env, moduleApi, globalObj: {}, isMainThread: true, logger,
          timers: { setInterval: () => ({ unref() {} }), clearInterval() {} },
          loadConfig: () => loadConfig({ env, modDir: dir }) });
        await moduleApi._load(BOOTSTRAP, INDEX).bootWorld({});
        await new Promise((resolve) => setImmediate(resolve));
        return { ctx: result.ctx, logger };
      };
      const a = await boot();
      let cleared = 0;
      a.ctx.chat = { uninstall: () => {
        throw new Error("boom");
      } };
      a.ctx.burst = { clearAll: () => {
        cleared += 1;
      } };
      assert.strictEqual(a.ctx.stop("test"), true);
      assert.strictEqual(cleared, 1, "clearAll ran after the failed step");
      assert.ok(a.logger.lines.includes("ERR stop failed (test)"), a.logger.lines.join("\n"));
      if (a.ctx.wing) a.ctx.wing.stop();

      const b = await boot();
      b.ctx.burst = { clearAll: () => {
        throw new Error("boom");
      } };
      assert.strictEqual(b.ctx.stop("test"), true);
      assert.ok(b.logger.lines.includes("stopped (test)") && b.logger.lines.includes("ERR burst clear failed (test)"),
        b.logger.lines.join("\n"));
    } finally {
      vendor.createLiveAdapter = saved;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("L4 off by a broken settings.json or a bad enabled value -> one 'not enabled' line, no hook "
    + "off on purpose -> silent", () => {
    const cases = [
      ["{ nope", /^not enabled - config error: settings\.json: not valid JSON/],
      [JSON.stringify({ enabled: "maybe" }), /^not enabled - config warning: settings\.json: enabled must be/],
      [JSON.stringify({ enabled: false }), null],
    ];
    for (const [text, expected] of cases) {
      const modDir = emptyModDir();
      try {
        fs.writeFileSync(path.join(modDir, "settings.json"), text);
        const moduleApi = fakeModuleApi({});
        const originalLoad = moduleApi._load;
        const logger = fakeLogger();
        const result = loader.install({ env: {}, moduleApi, globalObj: {}, isMainThread: true, logger,
          loadConfig: () => loadConfig({ env: {}, modDir }) });
        assert.deepStrictEqual(result, { ok: false, reason: "disabled_by_config" });
        assert.strictEqual(moduleApi._load, originalLoad);
        if (expected === null) assert.deepStrictEqual(logger.lines, []);
        else assert.ok(logger.lines.length === 1 && expected.test(logger.lines[0]), logger.lines.join("\n"));
      } finally {
        fs.rmSync(modDir, { recursive: true, force: true });
      }
    }
  });

  test("L10 (npc aggro test 5) config: default false, env 1 -> true, warning without enabled "
    + "buildHooks 2 hooks without the flag, 3 with it; the FIRST_LOAD hook wraps npcBehaviorLoop; a DRIFT of "
    + "`npcAggro` -> ready ends with aggro=probe_npcAggro_unavailable, the rest of the mod as without the flag",
  async () => {
    const { WRAPPED: AGGRO_WRAPPED } = require("../../lib/adapter/npcAggro");
    const dir = emptyModDir();
    try {
      assert.strictEqual(loadConfig({ env: {}, modDir: dir }).config.npcAggroEnabled, false);
      const alone = loadConfig({ env: { EVEJS_SHIPWING_NPC_AGGRO_ENABLED: "1" }, modDir: dir });
      assert.strictEqual(alone.config.npcAggroEnabled, true);
      assert.ok(alone.warnings.includes("npcAggroEnabled has no effect while enabled is off"), alone.warnings);
      const on = { EVEJS_SHIPWING_ENABLED: "1", EVEJS_SHIPWING_NPC_AGGRO_ENABLED: "1" };
      assert.ok(loadConfig({ env: on, modDir: dir }).warnings
        .includes("npcAggroEnabled without combatEnabled - twins cannot fire back"));

      const ctxOf = (flag) => ({ npcAggro: flag ? {} : null,
        configResult: { config: { npcAggroEnabled: flag } }, state: {} });
      assert.deepStrictEqual(loader.buildHooks(ctxOf(false)).map((h) => h.name), ["gameRuntimeReady", "bootWorld"]);
      assert.deepStrictEqual(loader.buildHooks(ctxOf(true)).map((h) => h.name),
        ["gameRuntimeReady", "bootWorld", "npcAggro"]);

      for (const flag of [false, true]) {
        const env = { EVEJS_SHIPWING_ENABLED: "1", EVEJS_GAMESTORE_OWNER_ROLE: "world", EVEJS_DATA_ROOT: dir,
          EVEJS_SHIPWING_NPC_AGGRO_ENABLED: flag ? "1" : "0" };
        const npcPath = path.join(path.sep, "srv", "server", "src", "space", "npc", "npcBehaviorLoop");
        const behavior = { tickScene: () => "scene", tickControllersByEntityID: () => "ids",
          __testing: { resolveCombatActorClass: () => null } };
        const moduleApi = fakeModuleApi({ [BOOTSTRAP]: bootstrapFixture([]).exports, [npcPath]: behavior });
        const logger = fakeLogger();
        const result = loader.install({ env, moduleApi, globalObj: {}, isMainThread: true, logger,
          timers: { setInterval: () => ({ unref() {} }), clearInterval() {} },
          loadConfig: () => loadConfig({ env, modDir: dir }) });
        assert.strictEqual(result.ctx.npcAggro !== null, flag, "controller only with the flag");
        moduleApi._load(npcPath, INDEX);
        assert.strictEqual(behavior.tickScene[AGGRO_WRAPPED] === true, flag, "wrapped only with the flag");
        assert.strictEqual(behavior.tickScene(), "scene", "a wrapper before activate passes through");
        await moduleApi._load(BOOTSTRAP, INDEX).bootWorld({});
        await new Promise((resolve) => setImmediate(resolve));
        const ready = logger.lines.find((l) => l.startsWith("ready v")) || "";
        assert.ok(ready.endsWith(`burst=off drones=off aggro=${flag ? "probe_npcAggro_unavailable" : "off"} `
          + "autoTarget=off droneMining=off formation=probe_formation_unavailable salvage=off board=off boardOrphan=off"), ready);
        assert.strictEqual(logger.lines.includes("npc aggro NOT available - probe_npcAggro_unavailable; NPCs ignore "
          + "twins"), flag, logger.lines.join("\n"));
        assert.ok(ready.includes(" tasks=probe_tasks_unavailable "), "the rest as without the flag");
        assert.strictEqual(result.ctx.stop("test"), true);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("L-SV1 salvageEnabled without probes: no engine, no hook, ready ends with "
    + "salvage=probe_tasks_unavailable; the twin-control line names salvage", async () => {
    const dir = emptyModDir();
    try {
      const env = { EVEJS_SHIPWING_ENABLED: "1", EVEJS_GAMESTORE_OWNER_ROLE: "world", EVEJS_DATA_ROOT: dir,
        EVEJS_SHIPWING_SALVAGE_ENABLED: "1" };
      const moduleApi = fakeModuleApi({ [BOOTSTRAP]: bootstrapFixture([]).exports });
      const logger = fakeLogger();
      const result = loader.install({ env, moduleApi, globalObj: {}, isMainThread: true, logger,
        timers: { setInterval: () => ({ unref() {} }), clearInterval() {} },
        loadConfig: () => loadConfig({ env, modDir: dir }) });
      await moduleApi._load(BOOTSTRAP, INDEX).bootWorld({});
      await new Promise((resolve) => setImmediate(resolve));
      const ready = logger.lines.find((l) => l.startsWith("ready v")) || "";
      assert.ok(ready.endsWith(" formation=probe_formation_unavailable salvage=probe_tasks_unavailable board=off boardOrphan=off"),
        ready);
      assert.ok(logger.lines.includes("salvage engine NOT created - probe_tasks_unavailable; salvage off"),
        logger.lines.join("\n"));
      assert.ok(logger.lines.includes("twin control NOT available - probe_twinControl_unavailable; salvage off"),
        logger.lines.join("\n"));
      assert.strictEqual(result.ctx.salvageHook, null, "no hook without the engine");
      assert.strictEqual(result.ctx.stop("test"), true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("L-SV2 (round 2) buildHooks adds the FIRST_LOAD hook salvageBoundary only with salvageEnabled "
    + "it matches moduleCycleBoundarySnapshot by either separator and wraps the export (state.salvageBoundary ok)",
  () => {
    const { BOUNDARY_EXPORT, BOUNDARY_WRAPPED } = require("../../lib/adapter/salvageHook");
    const ctxOf = (flag) => ({ npcAggro: null, salvageHook: null,
      configResult: { config: { enabled: true, salvageEnabled: flag } }, state: {} });
    assert.deepStrictEqual(loader.buildHooks(ctxOf(false)).map((h) => h.name), ["gameRuntimeReady", "bootWorld"]);
    const ctx = ctxOf(true);
    const hooks = loader.buildHooks(ctx);
    assert.deepStrictEqual(hooks.map((h) => h.name), ["gameRuntimeReady", "bootWorld", "salvageBoundary"]);
    // eslint-disable-next-line no-unused-vars
    const exportsObj = { [BOUNDARY_EXPORT]: (scene, entity, moduleItem, effectState, nowMs) => "vendor" };
    const hook = hooks[2];
    assert.ok(hook.match("./runtime/moduleCycleBoundarySnapshot", exportsObj));
    assert.ok(hook.match("..\\moduleCycleBoundarySnapshot", exportsObj));
    assert.ok(!hook.match("../moduleCycleBoundarySnapshotX", exportsObj));
    hook.run(exportsObj);
    assert.deepStrictEqual(ctx.state.salvageBoundary, { ok: true });
    assert.strictEqual(exportsObj[BOUNDARY_EXPORT][BOUNDARY_WRAPPED], true);
    assert.strictEqual(exportsObj[BOUNDARY_EXPORT]({}, {}, null, {}, 1), "vendor", "no hook yet: 1:1");
  });

  test("L11 autoTarget=: off with the flag off, without the combat access or the attack engine; a DRIFT of "
    + "`combatAuto` -> probe_combatAuto_unavailable + one log line; else ok", () => {
    const run = (flag, combat, engine, probe) => {
      const lines = [];
      const ctx = { config: { combatAutoTargetEnabled: flag }, logger: { log: (l) => lines.push(l) },
        adapter: { isConsumerAvailable: (name) => name !== "combatAuto" || probe } };
      return [loader.autoTargetStatus(ctx, combat, engine), lines.length];
    };
    assert.deepStrictEqual([run(false, "ok", {}, true), run(true, "probe_combat_unavailable", null, true),
      run(true, "ok", null, true), run(true, "ok", {}, false), run(true, "ok", {}, true)],
    [["off", 0], ["off", 0], ["off", 0], ["probe_combatAuto_unavailable", 1], ["ok", 0]]);
  });

  test("L-LIVE (LNE settings) default start registers the live entry, stop removes it; a failed "
    + "start leaves no entry", async () => {
    const LIVE = Symbol.for("evejs.modSettings.live");
    const wingService = require("../../lib/core/wingService");
    const originalWing = wingService.createWingService;
    const boot = async (globalObj, dir) => {
      const env = { EVEJS_SHIPWING_ENABLED: "1", EVEJS_GAMESTORE_OWNER_ROLE: "world", EVEJS_DATA_ROOT: dir };
      const moduleApi = fakeModuleApi({ [BOOTSTRAP]: bootstrapFixture([]).exports });
      const logger = fakeLogger();
      const result = loader.install({ env, moduleApi, globalObj, isMainThread: true, logger,
        timers: { setInterval: () => ({ unref() {} }), clearInterval() {} },
        loadConfig: () => loadConfig({ env, modDir: dir }) });
      await moduleApi._load(BOOTSTRAP, INDEX).bootWorld({});
      await new Promise((resolve) => setImmediate(resolve));
      return { result, logger };
    };
    const dir = emptyModDir();
    const dir2 = emptyModDir();
    try {
      const g = {};
      const { result } = await boot(g, dir);
      assert.ok(g[LIVE] instanceof Map && g[LIVE].has("shipWing"), "start registers");
      assert.strictEqual(g[LIVE].get("shipWing"), result.ctx.liveEntry);
      result.ctx.stop("test");
      assert.strictEqual(g[LIVE].has("shipWing"), false, "stop removes");

      wingService.createWingService = () => { throw new Error("core boom"); };
      const g2 = {};
      const failed = await boot(g2, dir2);
      assert.ok(failed.logger.lines.some((l) => l.startsWith("ERR service start failed")), failed.logger.lines.join("\n"));
      assert.strictEqual(g2[LIVE] instanceof Map && g2[LIVE].has("shipWing"), false, "no entry after a failed start");
      assert.strictEqual(failed.result.ctx.liveEntry, null);
    } finally {
      wingService.createWingService = originalWing;
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(dir2, { recursive: true, force: true });
    }
  });

  test("L-B1 (board) boardEnabled=false -> Handle_Board without the board mark (guards only) "
    + "ready board=off; true -> the board wrap inside the guard (GUARDED outside), ready ends with board=ok", async () => {
    const adapterIndex = require("../../lib/adapter/index");
    const vendor = require("../../lib/adapter/vendor");
    const { GUARDED } = require("../../lib/adapter/guards");
    const { BOARD_HOOKED } = require("../../lib/adapter/boardHook");
    const originalCreate = adapterIndex.createAdapter;
    const originalLive = vendor.createLiveAdapter;
    const run = async (flag, orphan = false) => {
      class ShipServiceFixture {
        Handle_Board() {
          return "vendor";
        }
      }
      class InvBrokerFixture {
        Handle_Add() {
          return "add";
        }
      }
      const games = { "services/ship/shipService": ShipServiceFixture,
        "services/inventory/invBrokerService": InvBrokerFixture,
        "common/machoErrors": { throwWrappedUserError: () => { throw new Error("user error"); } } };
      adapterIndex.createAdapter = (deps) => {
        const adapter = originalCreate(deps);
        const base = adapter.isConsumerAvailable;
        const baseRequire = adapter.requireGame;
        adapter.isConsumerAvailable = (name) => name === "board" || name === "guards" || base(name);
        adapter.requireGame = (rel) => (games[rel] ? { ok: true, exports: games[rel] } : baseRequire(rel));
        return adapter;
      };
      vendor.createLiveAdapter = () => ({ ok: true, lossReason: "probe_loss_unavailable", boardReason: null,
        formationReason: "probe_formation_unavailable",
        adapter: { boardVendorRefusal: () => null, launchFromBay: () => ({ ok: true }), sceneOf: () => null,
          hostEntity: () => null, isDestroying: () => false } });
      const dir = emptyModDir();
      try {
        const env = { EVEJS_SHIPWING_ENABLED: "1", EVEJS_GAMESTORE_OWNER_ROLE: "world", EVEJS_DATA_ROOT: dir,
          EVEJS_SHIPWING_BOARD_ENABLED: flag ? "1" : "0", EVEJS_SHIPWING_BOARD_ORPHAN_ENABLED: orphan ? "1" : "0" };
        const moduleApi = fakeModuleApi({ [BOOTSTRAP]: bootstrapFixture([]).exports });
        const logger = fakeLogger();
        const result = loader.install({ env, moduleApi, globalObj: {}, isMainThread: true, logger,
          timers: { setInterval: () => ({ unref() {} }), clearInterval() {} },
          loadConfig: () => loadConfig({ env, modDir: dir }) });
        await moduleApi._load(BOOTSTRAP, INDEX).bootWorld({});
        await new Promise((resolve) => setImmediate(resolve));
        const handler = ShipServiceFixture.prototype.Handle_Board;
        const ready = logger.lines.find((l) => l.startsWith("ready v")) || "";
        result.ctx.stop("test");
        return { handler, ready };
      } finally {
        adapterIndex.createAdapter = originalCreate;
        vendor.createLiveAdapter = originalLive;
        fs.rmSync(dir, { recursive: true, force: true });
      }
    };
    const off = await run(false);
    assert.deepStrictEqual([off.handler[GUARDED], off.handler[BOARD_HOOKED]], [true, undefined]);
    assert.ok(off.ready.endsWith(" board=off boardOrphan=off"), off.ready);
    const on = await run(true);
    assert.deepStrictEqual([on.handler[GUARDED], on.handler[BOARD_HOOKED], on.handler.name],
      [true, true, "shipWingGuard"], "the guard outside, the board mark copied from the wrap inside");
    assert.ok(on.ready.endsWith(" board=ok boardOrphan=off"), on.ready);
    assert.strictEqual(on.handler.call(new (class {})(), [1], {}, null), "vendor", "the chain ends at the vendor");
    assert.ok((await run(true, true)).ready.endsWith(" board=ok boardOrphan=ok"));
    assert.ok((await run(false, true)).ready.endsWith(" board=off boardOrphan=off"));
  });

  test("ET5 ewarEnabled off -> the ready line as before, no `ewar` sidecar, the plan "
    + "without ewarFamilyOf; on (fake probe) -> ends ` ewar=ok`, the sidecar right after `active`, ewarFamilyOf "
    + "given; DRIFT of `ewar` -> one NOT available line, ` ewar=probe_ewar_unavailable`", async () => {
    const adapterIndex = require("../../lib/adapter/index");
    const combatAccess = require("../../lib/adapter/combatAccess");
    const activeAccess = require("../../lib/adapter/activeAccess");
    const ewarAccess = require("../../lib/adapter/ewarAccess");
    const wingService = require("../../lib/core/wingService");
    const saved = [adapterIndex.createAdapter, combatAccess.createCombatAccessFromGame,
      activeAccess.createActiveAccessFromGame, ewarAccess.createEwarAccessFromGame, wingService.createWingService];
    const run = async (flag, probe = true) => {
      const seen = { activeInput: null, sidecars: null };
      const probes = ["active", "twinControl", "combat", ...(probe ? ["ewar"] : [])];
      adapterIndex.createAdapter = (deps) => {
        const adapter = saved[0](deps);
        const base = adapter.isConsumerAvailable;
        adapter.isConsumerAvailable = (name) => probes.includes(name) || base(name);
        return adapter;
      };
      combatAccess.createCombatAccessFromGame = () => ({ ok: true, access: { targetAllowed: () => true,
        stats: () => ({ counters: {} }), weaponKinds: () => ["turret"] } });
      activeAccess.createActiveAccessFromGame = (_adapter, input) => {
        seen.activeInput = input;
        return { ok: true, access: { planActive: () => ({ ok: false, reason: "ERROR" }), stats: () => ({}) } };
      };
      ewarAccess.createEwarAccessFromGame = () => ({ ok: true, access: { familyOf: () => null,
        stats: () => ({ counters: {} }) } });
      wingService.createWingService = (deps) => {
        seen.sidecars = (deps.taskSidecars || []).map((s) => s.name);
        return saved[4](deps);
      };
      const dir = emptyModDir();
      try {
        const env = { EVEJS_SHIPWING_ENABLED: "1", EVEJS_GAMESTORE_OWNER_ROLE: "world", EVEJS_DATA_ROOT: dir,
          EVEJS_SHIPWING_ACTIVE_MODULES_ENABLED: "1", EVEJS_SHIPWING_COMBAT_ENABLED: "1",
          EVEJS_SHIPWING_EWAR_ENABLED: flag ? "1" : "0" };
        const moduleApi = fakeModuleApi({ [BOOTSTRAP]: bootstrapFixture([]).exports });
        const logger = fakeLogger();
        const result = loader.install({ env, moduleApi, globalObj: {}, isMainThread: true, logger,
          timers: { setInterval: () => ({ unref() {} }), clearInterval() {} },
          loadConfig: () => loadConfig({ env, modDir: dir }) });
        await moduleApi._load(BOOTSTRAP, INDEX).bootWorld({});
        await new Promise((resolve) => setImmediate(resolve));
        const ready = logger.lines.find((l) => l.startsWith("ready v")) || "";
        result.ctx.stop("test");
        return { ...seen, ready, lines: logger.lines };
      } finally {
        [adapterIndex.createAdapter, combatAccess.createCombatAccessFromGame, activeAccess.createActiveAccessFromGame,
          ewarAccess.createEwarAccessFromGame, wingService.createWingService] = saved;
        fs.rmSync(dir, { recursive: true, force: true });
      }
    };
    const off = await run(false);
    assert.ok(off.ready.endsWith(" board=off boardOrphan=off"), off.ready);
    assert.ok(!off.ready.includes("ewar="), off.ready);
    assert.deepStrictEqual([off.sidecars, "ewarFamilyOf" in off.activeInput, off.activeInput.config.ewarEnabled],
      [["active"], false, false]);
    const on = await run(true);
    assert.ok(on.ready.endsWith(" board=off boardOrphan=off ewar=ok"), on.ready);
    assert.deepStrictEqual([on.sidecars, typeof on.activeInput.ewarFamilyOf, on.activeInput.config.ewarEnabled],
      [["active", "ewar"], "function", true]);
    const drift = await run(true, false);
    assert.ok(drift.ready.endsWith(" ewar=probe_ewar_unavailable"), drift.ready);
    assert.ok(drift.lines.includes("EWAR NOT available - probe_ewar_unavailable; twins use no EWAR"),
      drift.lines.join("\n"));
    assert.deepStrictEqual([drift.sidecars, "ewarFamilyOf" in drift.activeInput], [["active"], false]);
  });
};
