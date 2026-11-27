"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const loader = require("../../loader");
const { evaluateWorldGate } = require("../../lib/runtime/worldGate");

function exportSymbol(name, consumers) {
  return { name, kind: "export", consumers, phase: "test" };
}

const FAKE_ROOT = path.join(path.sep, "x", "server");
const READINESS_FILE = path.join(FAKE_ROOT, "src", "services", "exploration", "wormholes", "wormholeRuntimeState.js");
const GAMESTORE_FILE = path.join(FAKE_ROOT, "src", "gameStore", "index.js");
const PARENT = { filename: path.join(FAKE_ROOT, "index.js") };

function spyLogger() {
  const lines = { log: [], error: [], debug: [] };
  return {
    lines,
    log: (m) => lines.log.push(m),
    logError: (m) => lines.error.push(m),
    debug: (m) => lines.debug.push(m),
  };
}

function fakeModuleApi(modules) {
  const api = {
    _cache: {},
    _load(request) {
      return modules[request];
    },
    _resolveFilename(request) {
      return request === READINESS_FILE.replace(/\.js$/, "") ? READINESS_FILE : request;
    },
  };
  return api;
}

function nextTurn() {
  return new Promise((resolve) => setImmediate(resolve));
}

function okConfig(overrides = {}) {
  return {
    ok: true, config: { enabled: true, debug: false, dataDir: "/x", ...overrides },
    sources: { enabled: "default" }, warnings: [], errors: [],
  };
}

function bootHarness({
  bootWorld, startServices, loadConfig = () => okConfig(), logger = spyLogger(),
  gameModules = [], cached = {}, requireFn = () => ({}), cacheGameStore = true, modules = {},
}) {
  const readinessRequest = READINESS_FILE.replace(/\.js$/, "");
  const bootstrapRequest = path.join(FAKE_ROOT, "bootstrap");
  const bootstrapExports = { bootWorld, PRODUCTION_STAGES: {} };
  const moduleApi = fakeModuleApi({
    ...modules,
    [readinessRequest]: { mutateState() {} },
    [bootstrapRequest]: bootstrapExports,
  });
  if (cacheGameStore) moduleApi._cache[GAMESTORE_FILE] = { exports: { _processRole: "world" } };
  for (const rel of Object.keys(cached)) {
    moduleApi._cache[path.join(FAKE_ROOT, "src", `${rel}.js`)] = { exports: cached[rel] };
  }
  const env = {};
  let configLoads = 0;
  const countedLoad = () => { configLoads += 1; return loadConfig(); };
  const result = loader.install({
    moduleApi, globalObj: {}, env, isMainThread: true, logger, startServices, loadConfig: countedLoad,
    gameModules, requireFn, existsSync: () => true,
  });
  assert.deepStrictEqual(result, { ok: true, reason: null });
  const loadsAfterInstall = configLoads;
  env.EVEJS_GAMESTORE_OWNER_ROLE = "world";
  moduleApi._load(readinessRequest, PARENT);
  const linesAfterReadiness = [...logger.lines.log];
  moduleApi._load(bootstrapRequest, PARENT);
  return { bootstrapExports, logger, loadsAfterInstall, linesAfterReadiness, configLoads: () => configLoads, moduleApi };
}

module.exports = ({ test }) => {
  test("T2 install: hook once per process, NO_INSTALL and worker thread leave _load untouched", () => {
    const originalLoad = () => undefined;
    const moduleApi = { _load: originalLoad, _cache: {}, _resolveFilename: (r) => r };
    const globalObj = {};
    const logger = spyLogger();
    const first = loader.install({ moduleApi, globalObj, env: {}, isMainThread: true, logger });
    const wrapped = moduleApi._load;
    const second = loader.install({ moduleApi, globalObj, env: {}, isMainThread: true, logger });
    assert.deepStrictEqual(first, { ok: true, reason: null });
    assert.deepStrictEqual(second, { ok: false, reason: "already_installed" });
    assert.notStrictEqual(wrapped, originalLoad);
    assert.strictEqual(moduleApi._load, wrapped, "second install must not wrap again");

    const quiet = { _load: originalLoad, _cache: {}, _resolveFilename: (r) => r };
    const noInstall = loader.install({
      moduleApi: quiet, globalObj: {}, env: { EVEJS_LNE_NO_INSTALL: "1" }, isMainThread: true, logger,
    });
    assert.deepStrictEqual(noInstall, { ok: false, reason: "no_install_env" });
    assert.strictEqual(quiet._load, originalLoad);
    const worker = loader.install({ moduleApi: quiet, globalObj: {}, env: {}, isMainThread: false, logger });
    assert.deepStrictEqual(worker, { ok: false, reason: "not_main_thread" });
    assert.strictEqual(quiet._load, originalLoad);
  });

  test("T3 world gate: worker, fork, unknown role refused with reason; process.send never gates", () => {
    const base = {
      isMainThread: true, envRole: "world", processRole: "world", hasProcessSend: false, mainFilename: null,
    };
    const cases = [
      [base, null],
      [{ ...base, isMainThread: false }, "not_main_thread"],
      [{ ...base, envRole: "reader", processRole: "reader", hasProcessSend: true }, "env_role_not_world:reader"],
      [{ ...base, processRole: undefined }, "gamestore_role_unknown"],
      [{ ...base, hasProcessSend: true }, null],
    ];
    for (const [input, reason] of cases) {
      const gate = evaluateWorldGate(input);
      assert.strictEqual(gate.ok, reason === null, JSON.stringify(input));
      assert.strictEqual(gate.reason, reason);
      assert.ok(gate.diag && gate.diag.pid === process.pid, "diag present");
    }
  });

  test("T4 boot wrap: readiness starts nothing, bootWorld resolution starts services once", async () => {
    const world = { database: { _processRole: "world" } };
    let starts = 0;
    const { bootstrapExports, logger } = bootHarness({
      bootWorld: async () => world,
      startServices: () => { starts += 1; },
    });
    assert.strictEqual(starts, 0, "readiness alone must not start services");
    assert.strictEqual(logger.lines.log.filter((l) => l.includes("refused")).length, 0, logger.lines.log.join("\n"));
    const p = bootstrapExports.bootWorld();
    assert.strictEqual(await p, world);
    await nextTurn();
    assert.strictEqual(starts, 1);
    await bootstrapExports.bootWorld();
    await nextTurn();
    assert.strictEqual(starts, 1, "second bootWorld must not start again");
  });

  test("T4 errors: rejected bootWorld and throwing startServices are logged, never escape", async () => {
    const unhandled = [];
    const onUnhandled = (reason) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      let starts = 0;
      const rejected = bootHarness({
        bootWorld: async () => { throw new Error("db down"); },
        startServices: () => { starts += 1; },
      });
      const p = rejected.bootstrapExports.bootWorld();
      await assert.rejects(p, /db down/);
      await nextTurn();
      assert.strictEqual(starts, 0);
      const rejectedLog = rejected.logger.lines.log;
      assert.ok(rejectedLog.some((l) => l.includes("boot_rejected")), rejectedLog.join("\n"));

      const throwing = bootHarness({
        bootWorld: async () => ({ database: { _processRole: "world" } }),
        startServices: () => { throw new Error("service boom"); },
      });
      await throwing.bootstrapExports.bootWorld();
      await nextTurn();
      assert.ok(throwing.logger.lines.error.some((l) => l.includes("service start failed")));
      await nextTurn();
      assert.strictEqual(unhandled.length, 0, "no unhandled rejection from the mod");
    } finally {
      process.removeListener("unhandledRejection", onUnhandled);
    }
  });

  test("T4b debt-sweep: the probe report throws -> logged, ctx.state.buildInputs still set (not not_run)", async () => {
    const world = { database: { _processRole: "world" } };
    const logger = spyLogger();
    let armed = false;
    const log = logger.log;
    logger.log = (m) => {
      if (armed && String(m).startsWith("probe ")) throw new Error("probe line boom");
      log(m);
    };
    let seen = null;
    const h = bootHarness({ bootWorld: async () => world, logger,
      startServices: (_world, ctx) => { seen = ctx.state.buildInputs; } });
    armed = true;
    await h.bootstrapExports.bootWorld();
    await nextTurn();
    assert.ok(logger.lines.error.some((l) => l.includes("probe failed")), logger.lines.error.join("\n"));
    assert.deepStrictEqual(seen, { state: "skipped", reason: "disabled_by_config", degraded: false });
    assert.ok(logger.lines.log.some((l) => l.startsWith("buildInputs: ")), logger.lines.log.join("\n"));
  });

  test("C5 loader + config: disabled_by_config, config_invalid, load failure, setDebug, lazy load", async () => {
    const world = { database: { _processRole: "world" } };
    const boot = async (loadConfig, logger) => {
      let starts = 0;
      const h = bootHarness({ bootWorld: async () => world, startServices: () => { starts += 1; }, loadConfig, logger });
      await h.bootstrapExports.bootWorld();
      await nextTurn();
      return { ...h, starts };
    };

    const off = await boot(() => ({ ...okConfig({ enabled: false }), sources: { enabled: "environment" } }));
    assert.strictEqual(off.starts, 0);
    const offLines = off.logger.lines.log.filter((l) => l.includes("disabled_by_config"));
    assert.strictEqual(offLines.length, 1, off.logger.lines.log.join("\n"));
    assert.ok(offLines[0].includes("disabled by config") && offLines[0].includes("environment"), offLines[0]);
    assert.ok(!off.logger.lines.log.some((l) => l.includes("readiness")), "readiness prints no refusal");

    const invalid = await boot(() => ({ ...okConfig({ enabled: false }), ok: false, errors: ["settings.json: bad"] }));
    assert.strictEqual(invalid.starts, 0);
    assert.ok(invalid.logger.lines.log.some((l) => l.includes("config_invalid")), invalid.logger.lines.log.join("\n"));
    assert.ok(invalid.logger.lines.log.includes("config: error - settings.json: bad"));

    const thrown = await boot(() => { throw new Error("boom"); });
    assert.strictEqual(thrown.starts, 0);
    assert.ok(thrown.logger.lines.log.some((l) => l.includes("config_load_failed: boom")), thrown.logger.lines.log.join("\n"));

    const debugCalls = [];
    const debugLogger = { ...spyLogger(), setDebug: (on) => debugCalls.push(on) };
    const dbg = await boot(() => okConfig({ debug: true }), debugLogger);
    assert.strictEqual(dbg.loadsAfterInstall, 0, "config must not load at install");
    assert.strictEqual(dbg.configLoads(), 1, "config loads once, on the first hook");
    assert.deepStrictEqual(debugCalls, [true]);
    assert.strictEqual(dbg.starts, 1);

    const source = fs.readFileSync(path.join(__dirname, "..", "..", "loader.js"), "utf8");
    assert.deepStrictEqual(source.split("\n").filter((l) => / -[a-z$]/.test(l)), [], "' - reason'");
  });

  test("A4 loader: probe runs at boot (not readiness), one summary line, adapter on ctx; diag", async () => {
    const world = { database: { _processRole: "world" } };
    let starts = 0;
    let seenCtx = null;
    const required = [];
    const h = bootHarness({
      bootWorld: async () => world,
      startServices: (_w, ctx) => { starts += 1; seenCtx = ctx; },
      gameModules: [
        { path: "fake/ok", symbols: [exportSymbol("f", ["graph"])] },
        { path: "fake/drift", symbols: [exportSymbol("g", ["events"]), exportSymbol("h", ["events"])] },
      ],
      cached: { "fake/ok": { f() {} } },
      requireFn: (abs) => { required.push(abs); return { h() {} }; },
    });
    assert.deepStrictEqual(h.linesAfterReadiness.filter((l) => l.startsWith("probe")), [], "no probe at readiness");
    await h.bootstrapExports.bootWorld();
    await nextTurn();
    const log = h.logger.lines.log;
    assert.deepStrictEqual(log.filter((l) => l.startsWith("probe failed")), ["probe failed (1 ok, 1 drift, 0 missing)"],
      log.join("\n"));
    assert.deepStrictEqual(log.filter((l) => l.startsWith("probe DRIFT")),
      ["probe DRIFT fake/drift - missing g (affects: events)"]);
    assert.strictEqual(starts, 1);
    assert.strictEqual(seenCtx.adapter.getProbeReport().passed, false);
    assert.strictEqual(seenCtx.adapter.getDisabledModules().events, "drift:fake/drift.g");
    assert.deepStrictEqual(required, [path.join(FAKE_ROOT, "src", "fake", "drift.js")], "only the uncached module");
    assert.ok(h.logger.lines.debug.some((l) => l.includes("outside require.cache: fake/drift")), "R2 debug line");

    const refused = bootHarness({ bootWorld: async () => world, startServices: () => {}, cacheGameStore: false });
    const line = refused.logger.lines.log.find((l) => l.startsWith("readiness gate refused - gamestore_not_cached"));
    assert.ok(line && line.includes("pid="), refused.logger.lines.log.join("\n"));
  });

  test("A5 probe seams: vanilla ok + hook still wraps on the probe's first require; MISSING line",
    async () => {
      const { GAME_MODULES } = require("../../lib/adapter/gameModules");
      const SEAMS = ["space/npc/pirateFactionPolicy", "services/character/factionKillStandingRuntime"];
      const gameModules = GAME_MODULES.filter((e) => SEAMS.includes(e.path));
      assert.deepStrictEqual(gameModules.map((e) => e.path), SEAMS);
      const world = { database: { _processRole: "world" } };
      const file = (rel) => path.join(FAKE_ROOT, "src", `${rel}.js`);
      const adapterParent = { filename: path.join(path.sep, "x", "mods", "livingNewEden", "lib", "adapter", "index.js") };
      const config = { modules: { world: { enabled: true } }, world: { projectionEnabled: true },
        occupation: { enabled: true }, liberation: { enabled: true } };
      const vanillaKey = () => "angels";
      const vanillaLoss = () => null;
      const policy = { resolvePirateFactionForSystem: () => ({ factionKey: "angels" }),
        PIRATE_FACTION_BY_FACTION_ID: Object.freeze({ 500011: "angels" }), resolvePirateFactionKeyForSystem: vanillaKey };
      const standing = { recordNpcFactionStandingLoss: vanillaLoss, resolveVictimFactionID: () => 0,
        DEBOUNCE_WINDOW_MS: 600000 };
      const required = [];
      let h = null;
      let starts = 0;
      h = bootHarness({
        bootWorld: async () => world, startServices: () => { starts += 1; }, gameModules,
        loadConfig: () => okConfig(config),
        modules: { [file(SEAMS[0])]: policy, [file(SEAMS[1])]: standing },
        requireFn: (abs) => { required.push(abs); return h.moduleApi._load(abs, adapterParent); },
      });
      await h.bootstrapExports.bootWorld();
      await nextTurn();
      const log = h.logger.lines.log;
      assert.ok(log.includes("probe passed (2 ok, 0 drift, 0 missing)"), log.join("\n"));
      assert.deepStrictEqual(required, SEAMS.map(file), "both seams load lazily: the probe is their first require");
      assert.notStrictEqual(policy.resolvePirateFactionKeyForSystem, vanillaKey, "projection hook wrapped the export");
      assert.ok(!log.some((l) => l.includes("not wrapped at boot")), "wrapped -> no diagnostic line");
      assert.notStrictEqual(standing.recordNpcFactionStandingLoss, vanillaLoss, "liberation hook wrapped the export");
      for (const name of ["pirateFactionProjection", "npcKillLiberation"]) {
        assert.ok(h.logger.lines.debug.includes(`hook "${name}" applied`), name);
      }
      assert.strictEqual(starts, 1);

      const goneConfig = { ...config, world: { projectionEnabled: true, siteProjectionEnabled: true } };
      const gone = bootHarness({
        bootWorld: async () => world, startServices: () => {}, gameModules, loadConfig: () => okConfig(goneConfig),
        requireFn: (abs) => { throw new Error(`Cannot find module '${abs}'`); },
      });
      await gone.bootstrapExports.bootWorld();
      await nextTurn();
      const lines = gone.logger.lines.log;
      assert.ok(lines.includes("probe failed (0 ok, 0 drift, 2 missing)"), lines.join("\n"));
      const missing = lines.filter((l) => l.startsWith("probe MISSING"));
      assert.strictEqual(missing.length, 2, lines.join("\n"));
      assert.ok(lines.includes("pirateFactionProjection: not wrapped at boot (hook_not_fired) - belt rats use the "
        + "vendor faction"), lines.join("\n"));
      assert.ok(lines.includes("siteFactionProjection: not wrapped at boot (hook_not_fired) - universe sites use the "
        + "vendor faction"), lines.join("\n"));
      assert.ok(missing[0].startsWith("probe MISSING space/npc/pirateFactionPolicy - require_failed: Cannot find module")
        && missing[0].endsWith("(affects: standings, projection)"), missing[0]);
      assert.ok(missing[1].startsWith("probe MISSING services/character/factionKillStandingRuntime - require_failed:")
        && missing[1].endsWith("(affects: liberation, standings, playerActivity, frontJobs, shipAiKills, bounty, "
          + "playerHunt, populationStandingAggro)"),
      missing[1]);
    });

  test("LH2 loader hook liveLossImport: materialization off -> disabled, exports untouched; on -> "
    + "wrapped; the same exports again -> already_installed; no primary function -> refused", () => {
    const REQUEST = path.join(FAKE_ROOT, "src", "space", "combat", "killmailTracker");
    const hookFor = (materialization, loss = true) => {
      const logger = spyLogger();
      const ctx = { state: {}, logger, loadConfig: () => okConfig({ modules: { materialization: { enabled:
        materialization } }, battle: { liveLossImport: { enabled: loss } } }) };
      const h = loader.buildHooks(ctx).find((x) => x.name === "liveLossImport");
      return { ctx, h, logger };
    };
    const vendor = () => ({ recordKillmailFromDestruction: () => "r", enqueueKillmailFromDestruction: () => "e" });
    const results = [];
    const off = vendor();
    const [record, enqueue] = [off.recordKillmailFromDestruction, off.enqueueKillmailFromDestruction];
    const a = hookFor(false);
    assert.strictEqual(a.h.match(REQUEST, off), true);
    a.h.run(off);
    results.push(a.ctx.state.liveLossImport, off.recordKillmailFromDestruction === record
      && off.enqueueKillmailFromDestruction === enqueue);
    const lossOff = hookFor(true, false);
    lossOff.h.run(off);
    results.push(lossOff.ctx.state.liveLossImport, off.recordKillmailFromDestruction === record);

    const on = vendor();
    const onRecord = on.recordKillmailFromDestruction;
    const b = hookFor(true);
    b.h.run(on);
    results.push(b.ctx.state.liveLossImport, on.recordKillmailFromDestruction !== onRecord);
    const again = hookFor(true);
    again.h.run(on);
    results.push(again.ctx.state.liveLossImport);
    const broken = hookFor(true);
    broken.h.run({ enqueueKillmailFromDestruction: () => "e" });
    results.push(broken.ctx.state.liveLossImport, broken.logger.lines.log.join("|"));
    assert.deepStrictEqual(results, ["disabled", true, "disabled", true, "wrapped", true, "already_installed",
      "refused", "liveLossImport wrap refused - PRIMARY_MISSING"]);

    const shipAiHook = (proactiveEnabled) => {
      const ctx = { state: {}, logger: spyLogger(), loadConfig: () => okConfig({ modules: { materialization: {
        enabled: false } }, battle: { liveLossImport: { enabled: false } }, shipAi: { enabled: true,
        proactiveEnabled } }) };
      const exportsObj = vendor();
      const original = exportsObj.recordKillmailFromDestruction;
      loader.buildHooks(ctx).find((x) => x.name === "liveLossImport").run(exportsObj);
      return [ctx.state.liveLossImport, exportsObj.recordKillmailFromDestruction !== original];
    };
    assert.deepStrictEqual(shipAiHook(true), ["wrapped", true]);
    assert.deepStrictEqual(shipAiHook(false), ["disabled", false]);
  });

  test("SM1 loader hook shipAiMail: mailEnabled false -> disabled, export untouched "
    + "shipAi + mail on -> installed; the wrapper passes the arguments and the result of the original, the listener "
    + "gets numbers only, never the copy of the sender, and its throw never reaches the vendor", () => {
    const mailHook = require("../../lib/adapter/shipAiMailHook");
    const REQUEST = path.join(FAKE_ROOT, "src", "services", "mail", "mailNotifications");
    const hookFor = (mailEnabled) => {
      const ctx = { state: {}, logger: spyLogger(), loadConfig: () => okConfig({ shipAi: { enabled: true,
        mailEnabled } }) };
      return { ctx, h: loader.buildHooks(ctx).find((x) => x.name === "shipAiMail") };
    };
    const calls = [];
    const vendor = () => ({ sendMailSentNotification: function vendorSent(...args) {
      calls.push(args);
      return "vendor-result";
    } });
    const off = vendor();
    const original = off.sendMailSentNotification;
    const a = hookFor(false);
    assert.strictEqual(a.h.match(REQUEST, off), true);
    a.h.run(off);
    assert.deepStrictEqual([a.ctx.state.shipAiMail, off.sendMailSentNotification === original], ["disabled", true]);
    const on = vendor();
    const b = hookFor(true);
    b.h.run(on);
    assert.strictEqual(b.ctx.state.shipAiMail, "installed");
    assert.strictEqual(mailHook.isInstalled(), true);
    const seen = [];
    const l1 = mailHook.addListener((facts) => seen.push(facts));
    const l2 = mailHook.addListener(() => { throw new Error("boom"); });
    try {
      const message = { messageID: 41, senderID: 7, title: "secret" };
      assert.strictEqual(on.sendMailSentNotification(9001, message, 0, { x: 1 }), "vendor-result");
      assert.deepStrictEqual(calls[calls.length - 1], [9001, message, 0, { x: 1 }]);
      on.sendMailSentNotification(7, message, 1);
      assert.deepStrictEqual(seen, [{ characterId: 9001, messageId: 41, senderId: 7 }], "copy of the sender skipped");
      assert.ok(mailHook.listenerStats().listenerErrors >= 1);
    } finally {
      l1.remove();
      l2.remove();
    }
    const again = hookFor(true);
    again.h.run(on);
    assert.strictEqual(again.ctx.state.shipAiMail, "already_installed");
    const frozen = Object.freeze(vendor());
    const c = hookFor(true);
    c.h.run(frozen);
    assert.strictEqual(c.ctx.state.shipAiMail, "refused");
  });

  test("T4 loader hook siteFactionProjection: flag off -> export untouched; on -> wrapped "
    + "second run noop; no policy -> refused + one line; world.projectionEnabled=false keeps the policy reference", () => {
    const POLICY_REQUEST = path.join(FAKE_ROOT, "src", "space", "npc", "pirateFactionPolicy");
    const SITE_REQUEST = path.join(FAKE_ROOT, "src", "services", "dungeon", "dungeonSiteSpawnPolicy");
    const { WRAPPED_SITE_PROJECTION } = require("../../lib/adapter/siteProjection");
    const hooksFor = (world) => {
      const logger = spyLogger();
      const ctx = { state: {}, logger, loadConfig: () => okConfig({ modules: { world: { enabled: true } }, world }) };
      const hooks = loader.buildHooks(ctx);
      const by = (name) => hooks.find((x) => x.name === name);
      return { ctx, logger, policyHook: by("pirateFactionProjection"), siteHook: by("siteFactionProjection") };
    };
    const vendorPolicy = () => ({ resolvePirateFactionForSystem: () => ({ factionKey: "guristas" }),
      resolvePirateFactionKeyForSystem: () => "guristas", PIRATE_FACTION_BY_FACTION_ID: Object.freeze({ 500019: "sanshas" }) });
    const original = () => ({});
    const sites = () => ({ buildRuntimeSystemPolicyContext: original });

    const off = hooksFor({ projectionEnabled: true, siteProjectionEnabled: false });
    const offSites = sites();
    assert.strictEqual(off.siteHook.match(SITE_REQUEST, offSites), true);
    assert.strictEqual(off.siteHook.match(SITE_REQUEST, {}), false);
    off.policyHook.run(vendorPolicy());
    off.siteHook.run(offSites);
    assert.strictEqual(off.ctx.state.siteProjection, "disabled");
    assert.strictEqual(offSites.buildRuntimeSystemPolicyContext, original);

    const on = hooksFor({ projectionEnabled: false, siteProjectionEnabled: true });
    const policy = vendorPolicy();
    const vendorKey = policy.resolvePirateFactionKeyForSystem;
    assert.strictEqual(on.policyHook.match(POLICY_REQUEST, policy), true);
    on.policyHook.run(policy);
    assert.strictEqual(on.ctx.state.pirateFactionPolicy, policy);
    assert.strictEqual(on.ctx.state.projection, "disabled");
    assert.strictEqual(policy.resolvePirateFactionKeyForSystem, vendorKey, "belt projection off -> no belt wrap");
    const onSites = sites();
    on.siteHook.run(onSites);
    assert.strictEqual(on.ctx.state.siteProjection, "wrapped");
    const wrapped = onSites.buildRuntimeSystemPolicyContext;
    assert.notStrictEqual(wrapped, original);
    assert.strictEqual(wrapped[WRAPPED_SITE_PROJECTION], true);
    on.siteHook.run(onSites);
    assert.strictEqual(onSites.buildRuntimeSystemPolicyContext, wrapped, "second hook run is a noop");

    const counts = [];
    const reads = [];
    on.ctx.telemetry = { hooks: { onCount: (name, n) => counts.push(`${name}:${n}`) } };
    let answer = { ok: true, controllerFactionId: 500019 };
    on.ctx.world = { getControllerMemo: (id) => { reads.push(`memo:${id}`); return answer; },
      getController: () => { throw new Error("the site path must read through the memo"); } };
    wrapped(30001001, {});
    answer = { ok: false, reason: "TX_FAILED" };
    wrapped(30001001, {});
    wrapped(30001001, {});
    on.ctx.world = { getController: (id) => { reads.push(`get:${id}`); return { ok: true, controllerFactionId: null }; } };
    wrapped(30001001, {});
    assert.deepStrictEqual(reads, ["memo:30001001", "memo:30001001", "memo:30001001", "get:30001001"]);
    assert.deepStrictEqual(counts, ["world.siteProjection.projected:1", "world.siteProjection.failed:1",
      "world.siteProjection.failed:1", "world.siteProjection.vendor:1"]);
    assert.deepStrictEqual(on.logger.lines.log, ["siteFactionProjection: failed (READ_TX_FAILED) - vendor site faction "
      + "used; further failures only counted"]);

    const bare = hooksFor({ siteProjectionEnabled: true });
    const bareSites = sites();
    bare.siteHook.run(bareSites);
    assert.strictEqual(bare.ctx.state.siteProjection, "refused");
    assert.strictEqual(bareSites.buildRuntimeSystemPolicyContext, original);
    assert.deepStrictEqual(bare.logger.lines.log, ["siteFactionProjection wrap refused - PIRATE_POLICY_UNAVAILABLE"]);
  });

  test("DG4 loader hook dormancyGuard: materialization off -> disabled "
    + "export untouched; on -> wrapped, the export is the wrapper", () => {
    const REQUEST = path.join(FAKE_ROOT, "src", "space", "npc", "npcCombatDormancy");
    const guard = require("../../lib/adapter/dormancyGuard");
    const hookFor = (materialization) => {
      const logger = spyLogger();
      const ctx = { state: {}, logger, loadConfig: () => okConfig({ modules: { materialization: { enabled:
        materialization } } }) };
      return { ctx, h: loader.buildHooks(ctx).find((x) => x.name === "dormancyGuard"), logger };
    };
    const original = () => true;
    const exportsObj = { canDematerializeDormantCombatController: original };
    const off = hookFor(false);
    assert.strictEqual(off.h.match(REQUEST, exportsObj), true);
    assert.strictEqual(off.h.match(REQUEST, {}), false);
    off.h.run(exportsObj);
    assert.strictEqual(off.ctx.state.dormancyGuard, "disabled");
    assert.strictEqual(exportsObj.canDematerializeDormantCombatController, original);
    const on = hookFor(true);
    on.h.run(exportsObj);
    assert.strictEqual(on.ctx.state.dormancyGuard, "wrapped");
    assert.notStrictEqual(exportsObj.canDematerializeDormantCombatController, original);
    assert.strictEqual(guard.checkHookInstalled(exportsObj), true);
    assert.ok(on.logger.lines.log.some((l) => l.startsWith("dormancyGuard: wrapped")), on.logger.lines.log.join("|"));
  });
};

Object.assign(module.exports, { bootHarness, okConfig, nextTurn });
