"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { MODULE_NAMES, resolveConfig } = require("../../config");
const { createManualClock } = require("../../lib/util/clock");
const { findServerSrcOnDisk, GAMESTORE_SEARCH_MAX_DEPTH } = require("../../lib/adapter/locator");
const { resolveSqliteDriver } = require("../../lib/adapter/sqliteDriver");
const { dependentsDisabled } = require("../../lib/persistence");
const {
  SERVICES_SHUTDOWN_HOOK_NAME, buildDefaultServiceDefs, createServiceRegistry,
} = require("../../lib/runtime/services");
const { bootHarness, okConfig, nextTurn } = require("../loader/loader.test.js");

const MOD_DIR = path.resolve(__dirname, "..", "..");

function spyLogger() {
  const lines = [];
  const errors = [];
  return { lines, errors, log: (m) => lines.push(m), logError: (m) => errors.push(m), debug: () => {} };
}

function plainConfig() {
  return {
    enabled: true, dataDir: path.join(os.tmpdir(), "lne-never-written"), telemetry: { intervalSeconds: 5 },
    testing: {}, modules: Object.fromEntries(MODULE_NAMES.map((n) => [n, { enabled: true }])),
  };
}

function fakeAdapter({ report = {}, disabled = {}, hooks = [], driver = null, ownerLost = true } = {}) {
  return {
    hooks,
    getProbeReport: () => report,
    getDisabledModules: () => disabled,
    loadSqliteDriver: () => driver,
    registerShutdownHook(name, fn) {
      hooks.push([name, fn]);
      return { ok: true, unregister() {} };
    },
    onPersistenceOwnerLost: () => (ownerLost ? { ok: true, unsubscribe() {} } : { ok: false, reason: "x" }),
  };
}

function fakeTelemetry(order) {
  return {
    hooks: {},
    stop: () => order.push("telemetry"),
    getStatus: () => ({ tick: "waiting", gc: "ok" }),
    getSnapshot: () => ({ status: {}, capture: { path: "/x/latest.json" } }),
  };
}

function fakeStarters(order, persistence) {
  const calls = { telemetry: 0, persistence: 0, governor: 0, graph: 0, world: 0, presence: 0, scheduler: 0,
    fleets: 0, wormholes: 0, wrecks: 0, occupation: 0, liberation: 0, standings: 0, battle: 0, strategy: 0, stations: 0,
    mining: 0,
    production: 0, logistics: 0, construction: 0, trade: 0, siege: 0, salvage: 0, virtualCorps: 0, invasions: 0, sovProjection: 0, structures: 0, sites: 0, events: 0, salvageAnomaly: 0, materialization: 0, observer: 0 };
  return {
    calls,
    startWorld: () => {
      calls.world += 1;
      return { ok: true, world: { stop: () => order.push("world") } };
    },
    startPresence: () => {
      calls.presence += 1;
      return { ok: true, presence: { stop: () => order.push("presence") } };
    },
    startScheduler: () => {
      calls.scheduler += 1;
      return { ok: true, scheduler: { stop: () => order.push("scheduler"),
        getStatus: () => ({ open: 0, recovered: { retried: 0, quarantined: 0 }, rebuildMs: 0 }) } };
    },
    startFleets: () => {
      calls.fleets += 1;
      return { ok: true, fleets: { stop: () => order.push("fleets"), countByState: () => ({ ok: true, active: 0 }) } };
    },
    startWrecks: () => {
      calls.wrecks += 1;
      return { ok: true, wrecks: { stop: () => order.push("wrecks"), countActive: () => ({ ok: true, count: 0 }) } };
    },
    startOccupation: () => {
      calls.occupation += 1;
      return { ok: true, occupation: { stop: () => order.push("occupation"),
        getStatus: () => ({ state: "ready", counters: { bootstrapEnqueued: 0, bootstrapDuplicates: 0 } }) } };
    },
    startLiberation: () => {
      calls.liberation += 1;
      return { ok: true, liberation: { stop: () => order.push("liberation"), onNpcKill: () => ({ ok: false }),
        getStatus: () => ({ state: "ready", view: false }) } };
    },
    startStandings: () => {
      calls.standings += 1;
      return { ok: true, standings: { stop: () => order.push("standings"), onNpcKill: () => ({ ok: false }),
        getStatus: () => ({ state: "ready" }) } };
    },
    startBattle: () => {
      calls.battle += 1;
      return { ok: true, battle: { stop: () => order.push("battle") } };
    },
    startStrategy: () => {
      calls.strategy += 1;
      return { ok: true, strategy: { stop: () => order.push("strategy") } };
    },
    startStations: () => {
      calls.stations += 1;
      return { ok: true, stations: { stop: () => order.push("stations"), getMode: () => "off" } };
    },
    startMining: () => {
      calls.mining += 1;
      return { ok: true, mining: { stop: () => order.push("mining"), getMode: () => "off" } };
    },
    startProduction: () => {
      calls.production += 1;
      return { ok: true, production: { stop: () => order.push("production"), getMode: () => "off" } };
    },
    startLogistics: () => {
      calls.logistics += 1;
      return { ok: true, logistics: { stop: () => order.push("logistics"), getMode: () => "off" } };
    },
    startConstruction: () => {
      calls.construction += 1;
      return { ok: true, construction: { stop: () => order.push("construction"), getMode: () => "off" } };
    },
    startTrade: () => {
      calls.trade += 1;
      return { ok: true, trade: { stop: () => order.push("trade"), getMode: () => "off" } };
    },
    startSiege: () => {
      calls.siege += 1;
      return { ok: true, siege: { stop: () => order.push("siege"), getMode: () => "off" } };
    },
    startSalvage: () => {
      calls.salvage += 1;
      return { ok: true, salvage: { stop: () => order.push("salvage") } };
    },
    startVirtualCorps: () => {
      calls.virtualCorps += 1;
      return { ok: true, virtualCorps: { stop: () => order.push("virtualCorps") } };
    },
    startInvasions: () => {
      calls.invasions += 1;
      return { ok: true, invasions: { stop: () => order.push("invasions"), getMode: () => "off" } };
    },
    startSovProjection: () => {
      calls.sovProjection += 1;
      return { ok: true, sovProjection: { stop: () => order.push("sovProjection") } };
    },
    startStructures: () => {
      calls.structures += 1;
      return { ok: true, structures: { stop: () => order.push("structures") } };
    },
    startSites: () => {
      calls.sites += 1;
      return { ok: true, sites: { stop: () => order.push("sites") } };
    },
    startEvents: () => {
      calls.events += 1;
      return { ok: true, events: { stop: () => order.push("events") } };
    },
    startWormholes: () => {
      calls.wormholes += 1;
      return { ok: true, wormholes: { stop: () => order.push("wormholes") } };
    },
    startSalvageAnomaly: () => {
      calls.salvageAnomaly += 1;
      return { ok: true, salvageAnomaly: { stop: () => order.push("salvageAnomaly") } };
    },
    startMaterialization: () => {
      calls.materialization += 1;
      return { ok: true, materialization: { stop: () => order.push("materialization") } };
    },
    startGraph: () => {
      calls.graph += 1;
      return { ok: true, graph: { stop: () => order.push("graph") } };
    },
    startObserver: () => {
      calls.observer += 1;
      return { ok: true, observer: { stop: () => order.push("observer") } };
    },
    startTelemetry: () => { calls.telemetry += 1; return { ok: true, telemetry: fakeTelemetry(order) }; },
    startPersistence: (deps) => { calls.persistence += 1; return persistence(deps); },
    startGovernor: () => {
      calls.governor += 1;
      return { ok: true, governor: { stop: () => order.push("governor") } };
    },
  };
}

function fakeProcess() {
  const listeners = [];
  return {
    listeners,
    once(event, fn) { listeners.push({ event, fn }); },
    removeListener(event, fn) {
      const i = listeners.findIndex((l) => l.event === event && l.fn === fn);
      if (i >= 0) listeners.splice(i, 1);
    },
  };
}

function loadDriver() {
  const found = findServerSrcOnDisk(MOD_DIR, GAMESTORE_SEARCH_MAX_DEPTH, fs.existsSync);
  if (!found.ok) return { ok: false, detail: found.reason };
  return resolveSqliteDriver(found.srcDir);
}

function withTmp(fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lne-svc-"));
  const cleanup = () => {
    try {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch (_err) {
    }
  };
  try {
    return fn(tmp);
  } finally {
    cleanup();
  }
}

const servicesLines = (logger) => logger.lines.filter((l) => l.startsWith("services: telemetry="));

module.exports = ({ test, skip }) => {
  test("S1 services: persistence throws / DB_LOCKED -> telemetry+governor run, dependents disabled", () => {
    for (const variant of ["throws", "DB_LOCKED"]) {
      const order = [];
      const logger = spyLogger();
      const starters = fakeStarters(order, () => {
        if (variant === "throws") throw new Error("boom");
        return { ok: false, reason: "DB_LOCKED", disabledModules: dependentsDisabled("DB_LOCKED") };
      });
      const defs = buildDefaultServiceDefs(starters);
      const ctx = { config: plainConfig(), adapter: fakeAdapter(), modDir: MOD_DIR, logger };
      const registry = createServiceRegistry({ logger, defs, clock: createManualClock(1000), randomSeed: () => 1 });
      const result = registry.startAll(ctx);
      assert.strictEqual(result.ok, true, variant);
      const byName = Object.fromEntries(result.status.services.map((s) => [s.name, s]));
      assert.strictEqual(byName.telemetry.state, "running");
      assert.strictEqual(byName.governor.state, "running");
      assert.strictEqual(byName.persistence.state, "failed");
      assert.strictEqual(byName.persistence.reason, variant === "throws" ? "SERVICE_START_THREW" : "DB_LOCKED");
      assert.strictEqual(byName.world.state, "disabled");
      assert.strictEqual(byName.world.reason, "dependency_disabled:persistence");
      assert.strictEqual(starters.calls.world, 0);
      assert.deepStrictEqual(ctx.world.getStatus(), { state: "unavailable", reason: "WORLD_UNAVAILABLE" });
      assert.strictEqual(ctx.disabledModules.world, "dependency_disabled:persistence");
      const reason = byName.persistence.reason;
      assert.deepStrictEqual(ctx.persistence.disabledModules, dependentsDisabled(reason), "same map as persistence");
      assert.strictEqual(ctx.streams, null);
      assert.ok(ctx.telemetry && ctx.governor, "telemetry and governor on ctx");
      assert.strictEqual(servicesLines(logger).length, 1, logger.lines.join("\n"));
      assert.ok(servicesLines(logger)[0].includes("persistence=failed:"), servicesLines(logger)[0]);
      assert.strictEqual(logger.errors.length, variant === "throws" ? 1 : 0, logger.errors.join("\n"));
      if (variant === "throws") {
        assert.strictEqual(logger.errors[0], "persistence: start failed - continuing without it");
      }
    }
  });

  test("S2 services: enabled=false -> one disabled_by_config line, no ready, no timer, no file, no hook", async () => {
    const world = { database: { _processRole: "world" } };
    const h = bootHarness({ bootWorld: async () => world,
      loadConfig: () => ({ ...okConfig({ enabled: false }), sources: { enabled: "environment" } }) });
    await h.bootstrapExports.bootWorld();
    await nextTurn();
    const lines = h.logger.lines.log;
    assert.strictEqual(lines.filter((l) => l.includes("disabled_by_config")).length, 1, lines.join("\n"));
    assert.strictEqual(lines.filter((l) => l.includes("ready")).length, 0, lines.join("\n"));

    withTmp((tmp) => {
      const config = resolveConfig({ env: { EVEJS_DATA_ROOT: tmp, EVEJS_LNE_ENABLED: "0" }, modDir: MOD_DIR }).config;
      assert.strictEqual(config.enabled, false);
      const adapter = fakeAdapter();
      const logger = spyLogger();
      const realSetInterval = globalThis.setInterval;
      const realSetTimeout = globalThis.setTimeout;
      let timers = 0;
      let result;
      globalThis.setInterval = (...args) => { timers += 1; return realSetInterval(...args); };
      globalThis.setTimeout = (...args) => { timers += 1; return realSetTimeout(...args); };
      try {
        result = createServiceRegistry({ logger }).startAll({ config, adapter, modDir: MOD_DIR, logger });
      } finally {
        globalThis.setInterval = realSetInterval;
        globalThis.setTimeout = realSetTimeout;
      }
      assert.deepStrictEqual(result, { ok: false, reason: "disabled_by_config" });
      assert.strictEqual(timers, 0);
      assert.ok(!fs.existsSync(config.dataDir) || fs.readdirSync(config.dataDir).length === 0, "dataDir untouched");
      assert.strictEqual(adapter.hooks.length, 0);
      assert.deepStrictEqual(logger.lines, [], "the loader already logged the refusal");
    });
  });

  const driver = loadDriver();
  const s3 = "S3 services: shutdown hook closes the store once, reverse stop order, second stopAll no-op";
  if (!driver.ok) skip(s3, `better-sqlite3 unavailable (${driver.detail})`);
  else {
    test(s3, () => {
      withTmp((tmp) => {
        const order = [];
        let closes = 0;
        const Database = function CountedDatabase(file) {
          const db = new driver.Database(file);
          const close = db.close.bind(db);
          db.close = () => { closes += 1; order.push("persistence"); return close(); };
          return db;
        };
        const config = resolveConfig({ env: { EVEJS_DATA_ROOT: tmp, EVEJS_LNE_TREASURY_ENABLED: "0" },
          modDir: MOD_DIR }).config;
        const hooks = [];
        const adapter = fakeAdapter({ hooks, driver: { ok: true, Database } });
        const processApi = fakeProcess();
        const logger = spyLogger();
        const real = require("../../lib/persistence").startPersistence;
        const starters = { ...fakeStarters(order, () => null), startPersistence: real };
        const registry = createServiceRegistry({ logger, starters, processApi, randomSeed: () => 3 });
        const ctx = { config, adapter, modDir: MOD_DIR, logger };
        const result = registry.startAll(ctx);
        try {
          assert.strictEqual(result.ok, true, logger.lines.join("\n"));
          assert.strictEqual(ctx.persistence.ok, true, logger.lines.join("\n"));
          assert.ok(ctx.streams && ctx.streams.baseSeed === ctx.persistence.worldSeed);
          assert.strictEqual(hooks[0][0], SERVICES_SHUTDOWN_HOOK_NAME, "registry hook first");
          assert.strictEqual(hooks.length, 2);
          for (const [, fn] of hooks) fn("SIGTERM");
          for (const l of processApi.listeners.filter((x) => x.event === "exit")) l.fn();
          assert.deepStrictEqual(registry.stopAll("x"), { ok: true, alreadyStopped: true });
          assert.strictEqual(closes, 1);
          assert.deepStrictEqual(order,
            ["observer", "salvage", "invasions", "siege", "trade", "construction", "logistics", "production", "mining", "stations", "strategy", "battle", "standings",
              "liberation", "occupation", "wrecks", "wormholes", "fleets", "scheduler", "presence", "world", "graph",
              "governor",
              "persistence", "telemetry"]);
          assert.strictEqual(ctx.world.getStatus().state, "unavailable");
          assert.strictEqual(ctx.governor, null);
          assert.strictEqual(ctx.telemetry, null);
          assert.strictEqual(ctx.observer, null);
          assert.ok(logger.lines.includes(
            "services: stopped (shutdown:SIGTERM) observer,chatterAi,npcVoices,loyalty,salvage,invasions,siege,trade,construction,logistics,production,mining,stations,strategy,battle,standings,liberation,occupation,wrecks,wormholes,fleets,scheduler,presence,world,graph,governor,"
              + "persistence,telemetry"),
            logger.lines.join("\n"));
        } finally {
          if (ctx.persistence && ctx.persistence.ok) ctx.persistence.store.close("test_cleanup");
        }
      });
    });
  }

  test("S4 services: no adapter / no report / core drift start nothing; ids differ per process", () => {
    const gates = [
      [null, "adapter_unavailable"],
      [fakeAdapter({ report: null }), "probe_report_missing"],
      [fakeAdapter({ disabled: { core: "drift:../bootstrap.bootWorld" } }), "probe_core_drift"],
    ];
    for (const [adapter, reason] of gates) {
      const order = [];
      const logger = spyLogger();
      const starters = fakeStarters(order, () => ({ ok: true, worldSeed: 7, store: { close() {} } }));
      const ctx = { config: plainConfig(), adapter, modDir: MOD_DIR, logger };
      const result = createServiceRegistry({ logger, starters }).startAll(ctx);
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.reason, reason);
      assert.deepStrictEqual(starters.calls,
        { telemetry: 0, persistence: 0, governor: 0, graph: 0, world: 0, presence: 0, scheduler: 0, fleets: 0,
          wormholes: 0, wrecks: 0, occupation: 0, liberation: 0, standings: 0, battle: 0, strategy: 0, stations: 0,
          mining: 0,
          production: 0, logistics: 0, construction: 0, trade: 0, siege: 0, salvage: 0, virtualCorps: 0, invasions: 0, sovProjection: 0, structures: 0, sites: 0, events: 0, salvageAnomaly: 0, materialization: 0,
          observer: 1 },
        reason);
      const st = createServiceRegistry({ logger: spyLogger(), starters: fakeStarters([], () => null) });
      st.startAll({ config: plainConfig(), adapter, modDir: MOD_DIR });
      assert.strictEqual(st.getStatus().refusal, reason);
      assert.deepStrictEqual(st.getStatus().services.map((s) => s.state),
        ["disabled", "disabled", "disabled", "disabled", "disabled", "disabled", "disabled", "disabled", "disabled",
          "disabled", "disabled", "disabled", "disabled", "disabled", "disabled", "disabled", "disabled",
          "disabled", "disabled", "disabled", "disabled", "disabled", "disabled", "disabled", "disabled",
          "disabled", "disabled", "disabled", "disabled", "disabled", "disabled", "disabled", "disabled",
          "disabled",
          "disabled",
          "disabled",
          "disabled",
          "disabled",
          "disabled",
          "disabled",
          "disabled",
          "disabled",
          "disabled",
          "disabled",
          "disabled",
          "disabled",
          "disabled",
          "disabled",
          "disabled",
          "disabled",
          "disabled",
          "disabled",
          "disabled",
          "disabled",
          "disabled",
          "disabled",
          "disabled",
          "disabled",
          "disabled",
          "disabled",
          "disabled",
          "disabled",
          "disabled",
          "disabled",
          "disabled",
          "disabled",
          "disabled",
          "disabled",
          "disabled",
          "disabled",
          "disabled",
          "disabled",
          "disabled",
          "disabled",
          "disabled",
          "disabled",
          "disabled",
          "disabled",
          "disabled",
          "disabled",
          "disabled",
          "disabled",
          "disabled",
          "disabled",
          "disabled",
          "disabled",
          "disabled",
          "disabled",
          "disabled",
          "disabled",
          "disabled",
          "disabled",
          "disabled",
          "disabled",
          "disabled",
          "disabled",
          "running"], reason);
      const refusals = logger.lines.filter((l) => l.startsWith("services not started - "));
      assert.strictEqual(refusals.length, 1, logger.lines.join("\n"));
      assert.ok(refusals[0].startsWith(`services not started - ${reason}`), refusals[0]);
      assert.deepStrictEqual(logger.lines.slice(1), ["alerts: disabled - disabled_by_config"], logger.lines.join("\n"));
      if (adapter) assert.strictEqual(adapter.hooks.length, 0);
    }

    const clock = createManualClock(1000);
    const firstIds = [];
    for (const seed of [1, 2]) {
      const logger = spyLogger();
      const starters = fakeStarters([], () => ({ ok: true, worldSeed: 7, store: { close() {} } }));
      const registry = createServiceRegistry({ logger, starters, clock, randomSeed: () => seed });
      const ctx = { config: plainConfig(), adapter: fakeAdapter(), modDir: MOD_DIR, logger };
      assert.strictEqual(registry.startAll(ctx).ok, true);
      firstIds.push(ctx.ids.next("fleet"));
      assert.strictEqual(ctx.streams.baseSeed, 7);
      assert.strictEqual(ctx.clock, clock);
      assert.deepStrictEqual(registry.startAll(ctx), { ok: false, reason: "already_started" });
      assert.strictEqual(starters.calls.persistence, 1);
    }
    assert.notStrictEqual(firstIds[0], firstIds[1], firstIds.join(" "));
  });

  test("S7 the strategy start gets the lazy getters: getTrade / getLogistics return ctx.trade "
    + "ctx.logistics of the later services", () => {
    const base = fakeStarters([], () => ({ ok: true, worldSeed: 7, store: { close() {} } }));
    let strategyDeps = null;
    const starters = { ...base, startStrategy: (deps) => {
      strategyDeps = deps;
      return { ok: true, strategy: { stop() {} } };
    } };
    const ctx = { config: plainConfig(), adapter: fakeAdapter(), modDir: MOD_DIR, logger: spyLogger() };
    assert.strictEqual(createServiceRegistry({ logger: spyLogger(), starters }).startAll(ctx).ok, true);
    assert.ok(ctx.trade && ctx.logistics, "later services running");
    assert.strictEqual(strategyDeps.getTrade(), ctx.trade);
    assert.strictEqual(strategyDeps.getLogistics(), ctx.logistics);
  });

  test("LCA3-S1 flags on: the chatterAi definition hands the buckets of both "
    + "catalogues to the real service, highsecLife gets a lazy getChatterAi, a refilled bucket reaches pickLine", async () => {
    const r = resolveConfig({ settings: {}, envFile: {}, modDir: MOD_DIR, env: { EVEJS_LNE_CHATTER_AI_ENABLED: "1",
      EVEJS_LNE_CHATTER_AI_API_KEY: "nvapi-TEST-KEY", EVEJS_LNE_HIGHSEC_LIFE_ENABLED: "1",
      EVEJS_LNE_HIGHSEC_LIFE_CIVILIANS_ENABLED: "1", EVEJS_LNE_HIGHSEC_LIFE_CHATTER_ENABLED: "1",
      EVEJS_LNE_FREE_CORPS_ENABLED: "1", EVEJS_LNE_FREE_CORPS_CHATTER_ENABLED: "1" } });
    assert.strictEqual(r.ok, true);
    const live = [];
    const setTimer = (fn) => {
      const t = { fn, on: true };
      live.push(t);
      return { cancel: () => { t.on = false; }, hasRef: () => false };
    };
    const calls = [];
    const transport = { post: (spec) => new Promise((resolve) => calls.push({ spec, resolve })) };
    const realStart = require("../../lib/chatterAi").startChatterAi;
    let aiDeps = null;
    let hsDeps = null;
    const defs = buildDefaultServiceDefs({
      startChatterAi: (deps) => {
        aiDeps = deps;
        return realStart({ ...deps, setTimer, transport });
      },
      startHighsecLife: (deps) => {
        hsDeps = deps;
        return { ok: false, reason: "TEST_STOP" };
      } });
    const at = (name) => defs.findIndex((d) => d.name === name);
    assert.ok(at("chatterAi") >= 0 && at("chatterAi") < at("highsecLife"), "chatterAi before its reader");
    const ctx = { config: r.config, clock: { now: () => 1700000000000 } };
    const logger = { log() {} };
    assert.deepStrictEqual(defs[at("chatterAi")].start(ctx, { logger }), { ok: true });
    try {
      const hsData = require("../../lib/highsecLife/data/chatterLines");
      const fcData = require("../../lib/freeCorps/data/chatterLines");
      const expected = [...hsData.BACKGROUND_CATEGORIES.map((c) => `hs.bg.${c}`),
        ...Object.keys(hsData.RUMOURS).map((k) => `hs.rumour.${k}`), ...fcData.CONTEXTS.map((c) => `fc.${c}`)];
      assert.deepStrictEqual(aiDeps.buckets.map((b) => b.key).sort(), expected.sort());
      defs[at("highsecLife")].start(ctx, { logger });
      assert.strictEqual(hsDeps.getChatterAi(), ctx.chatterAi, "read lazily from ctx");
      assert.deepStrictEqual(hsDeps.getChatterAi().overlay(), { ok: false, reason: "EMPTY" });
      for (let k = 0; k < 5 && calls.length === 0; k += 1) {
        const t = live.filter((x) => x.on).pop();
        t.on = false;
        t.fn();
      }
      assert.strictEqual(calls.length, 1, "one refill request");
      calls[0].resolve({ ok: true, status: 200, json: { choices: [{ message: { content: ["quiet shift out in the belt "
        + "today", "ore holds filling up nicely this run", "anyone else hauling to the hub later"].join("\n") },
      finish_reason: "stop" }], usage: { total_tokens: 120 } } });
      await new Promise((resolve) => setImmediate(resolve));
      const ov = hsDeps.getChatterAi().overlay();
      assert.strictEqual(ov.ok, true, JSON.stringify(ov));
      const filled = expected.filter((key) => ov.linesOf(key).length > 0);
      assert.ok(filled.length === 1 && filled[0].startsWith("hs.bg."), filled.join(","));
      const { pickLine } = require("../../lib/highsecLife/chatter");
      const C = require("../../lib/highsecLife/schema").chatterSettingsOf(r.config).settings;
      const ai = { permille: ov.permille, linesOf: ov.linesOf };
      const picks = Array.from({ length: 400 }, (_v, slot) => pickLine({ systemId: 30000142, slot, seed: 7,
        speakers: [92000101], lastSpeaker: null, place: { systemName: "Jita", regionName: "The Forge", isHub: true,
          hubJumps: 0 }, rumours: [], recentLineIds: [], C, ai }));
      const aiPicks = picks.filter((p) => p.source === "ai");
      assert.ok(aiPicks.length > 0 && aiPicks.every((p) => p.lineId.startsWith(`ai-${filled[0]}-`)),
        JSON.stringify(aiPicks.slice(0, 2)));
    } finally {
      defs[at("chatterAi")].stop(ctx, "test");
    }
    assert.deepStrictEqual(ctx.chatterAi.overlay(), { ok: false, reason: "DISABLED" }, "stopped");
  });

  test("LM5 the materialization definition hands ownerFactionIds [500018] and a lazy getFleets "
    + "(ctx.fleets) to startMaterialization", () => {
    let seen = null;
    const def = buildDefaultServiceDefs({ startMaterialization: (deps) => {
      seen = deps;
      return { ok: false, reason: "TEST_STOP" };
    } }).find((d) => d.name === "materialization");
    const first = { tag: "first" };
    const ctx = { config: {}, clock: { now: () => 0 }, fleets: first };
    def.start(ctx, { logger: { log() {} } });
    assert.ok(seen, "startMaterialization called");
    assert.deepStrictEqual(seen.ownerFactionIds, [500018]);
    assert.strictEqual(seen.getFleets(), first);
    const second = { tag: "second" };
    ctx.fleets = second;
    assert.strictEqual(seen.getFleets(), second, "read lazily");
    ctx.fleets = undefined;
    assert.strictEqual(seen.getFleets(), null);
  });

  test("CHR5 crews right after eventRewards, before playerHunt and "
    + "fleetExposure; startPlayerHunt gets a lazy getCrews (ctx.crews)", () => {
    let seen = null;
    const defs = buildDefaultServiceDefs({ startPlayerHunt: (deps) => {
      seen = deps;
      return { ok: false, reason: "TEST_STOP" };
    } });
    const at = (name) => defs.findIndex((d) => d.name === name);
    assert.strictEqual(at("crews"), at("eventRewards") + 1, "right after eventRewards");
    assert.ok(at("crews") < at("playerHunt") && at("playerHunt") < at("fleetExposure"),
      `${at("crews")} ${at("playerHunt")} ${at("fleetExposure")}`);
    const ctx = { config: {}, clock: { now: () => 0 } };
    defs[at("playerHunt")].start(ctx, { logger: { log() {} } });
    assert.ok(seen && typeof seen.getCrews === "function", "getCrews handed over");
    assert.strictEqual(seen.getCrews(), null);
    const crews = { tag: "crews" };
    ctx.crews = crews;
    assert.strictEqual(seen.getCrews(), crews, "read lazily");
  });

  test("BNW1 the occupation definition binds ctx.beltNavyRoll: running, disabled stub, stop", () => {
    const score = () => 100;
    const roll = (ctx) => ctx.beltNavyRoll.decide({ systemId: 1, factionId: 2, spawnSiteId: "1:2:1", atMs: 5 });
    const world = { getControlState: () => ({ ok: true,
      system: { controllerFactionId: 2, occupationState: "STABLE" } }) };
    const beltNavy = { shareMin: 0.25, shareMax: 0.75, consolidatingWeight: 0.5, rollBucketMs: 3600000 };
    const baseCtx = () => ({ config: { world: { beltNavy }, occupation: { maxActiveSystems: 1 } }, world,
      clock: { now: () => 0 }, persistence: { ok: true, worldSeed: 9 } });
    const def = buildDefaultServiceDefs({
      startOccupation: () => ({ ok: true, occupation: { effectiveScoreOf: score, getStatus: () => ({}) } }) })
      .find((d) => d.name === "occupation");

    const running = baseCtx();
    assert.deepStrictEqual(def.start(running, { logger: { log() {} } }), { ok: true });
    assert.strictEqual(roll(running).share, 0.75);
    def.stop(running, "test");
    assert.strictEqual(running.beltNavyRoll, null);

    const disabled = baseCtx();
    def.onUnavailable(disabled, "disabled_by_config");
    assert.deepStrictEqual(roll(disabled), { ok: false, reason: "NO_SCORE" });
  });

  test("BNW2 the beltNavy definition: real start sets ctx.beltNavy, a refusal or stop leaves it null", () => {
    const def = buildDefaultServiceDefs({}).find((d) => d.name === "beltNavy");
    const defs = buildDefaultServiceDefs({}).map((d) => d.name);
    assert.strictEqual(defs.indexOf("beltNavy"), defs.indexOf("standings") + 1, "right after standings");
    const logger = { log() {} };
    const seam = { checkBeltNavyScene: () => ({ ok: true }), getBeltNavyScene: () => ({}),
      checkHuntScene: () => ({ ok: true }), getHuntScene: () => ({}), checkNpcSpawn: () => ({ ok: true }),
      getNpcSpawn: () => ({}), readCharacterStanding: () => ({ ok: true, standing: 0 }),
      checkStandingRead: () => ({ ok: true }) };
    const settings = { standingAggroEnabled: true, maxGroups: 1 };
    const ctxOf = (adapter, beltNavy = settings) => ({ config: { world: { beltNavy } }, adapter, clock: { now: () => 0 } });

    const running = ctxOf(seam);
    assert.deepStrictEqual(def.start(running, { logger }), { ok: true });
    assert.strictEqual(running.beltNavy.canAccept(), true);
    const service = running.beltNavy;
    def.stop(running, "test");
    assert.strictEqual(running.beltNavy, null);
    assert.strictEqual(service.canAccept(), false, "stopped");

    const off = ctxOf(seam, { standingAggroEnabled: false });
    assert.deepStrictEqual(def.start(off, { logger }), { ok: false, reason: "disabled_by_config" });
    assert.strictEqual(off.beltNavy, undefined);
    const drift = ctxOf({ ...seam, checkBeltNavyScene: () => ({ ok: false, reason: "SEAM_UNAVAILABLE",
      missing: ["space/npc/npcService.issueManualOrder"] }) });
    assert.deepStrictEqual(def.start(drift, { logger }), { ok: false, reason: "BELT_NAVY_SEAM_UNAVAILABLE",
      detail: "space/npc/npcService.issueManualOrder" });
    assert.strictEqual(def.start(ctxOf(null), { logger }).reason, "BELT_NAVY_SEAM_UNAVAILABLE");
    const leftover = { beltNavy: {} };
    def.onUnavailable(leftover, "dependency_disabled:world");
    assert.strictEqual(leftover.beltNavy, null);
  });

  test("SV2 the siege, invasions and sovProjection definitions hand ctx.views to their starters", () => {
    const seen = {};
    const stop = (name) => (deps) => {
      seen[name] = deps;
      return { ok: false, reason: "TEST_STOP" };
    };
    const defs = buildDefaultServiceDefs({ startSiege: stop("siege"), startInvasions: stop("invasions"),
      startSovProjection: stop("sovProjection") });
    const views = { registerView() {} };
    const adapter = { readFactionNames: () => ({ ok: true, names: new Map() }) };
    for (const name of ["siege", "invasions", "sovProjection"]) {
      const def = defs.find((d) => d.name === name);
      def.start({ config: {}, clock: { now: () => 0 }, views, adapter }, { logger: { log() {} } });
      assert.ok(seen[name], `${name} starter called`);
      assert.strictEqual(seen[name].views, views, `${name} gets ctx.views`);
      assert.strictEqual(seen[name].adapter, adapter, `${name} gets ctx.adapter`);
    }
  });
};
