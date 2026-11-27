"use strict";

const assert = require("node:assert");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");

const { findServerSrcOnDisk, GAMESTORE_SEARCH_MAX_DEPTH } = require("../../../lib/adapter/locator");
const { resolveSqliteDriver } = require("../../../lib/adapter/sqliteDriver");
const { MIGRATIONS } = require("../../../lib/persistence/migrations");
const { openStore } = require("../../../lib/persistence/store");
const { seedDbFile } = require("../../_support/dbTemplate");
const { startSovProjection, stopSovProjection, createUnavailableSovProjection, createSovProjectionFacade } = require("../../../lib/world/sovProjection");
const { createOccupationService } = require("../../../lib/world/occupation/occupationService");
const { createSovBudgetFromConfig, SovWriteBudget } = require("../../../lib/world/sovProjection/budget");
const { onControllerChanged } = require("../../../lib/world/sovProjection/listener");
const { syncAll } = require("../../../lib/world/sovProjection/sync");
const { getLog } = require("../../../lib/world/sovProjection/repository");
const { createJournal } = require("../../../lib/persistence/journal");
const { createWorldStateRepository } = require("../../../lib/world/worldStateRepository");
const { createAdapter } = require("../../../lib/adapter");
const { planReset } = require("../../../lib/persistence/worldReset");

const MOD_DIR = path.resolve(__dirname, "..", "..", "..");

function loadDriver() {
  const found = findServerSrcOnDisk(MOD_DIR, GAMESTORE_SEARCH_MAX_DEPTH, fs.existsSync);
  if (!found.ok) return { ok: false, detail: found.reason };
  return resolveSqliteDriver(found.srcDir);
}

function withStore(fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lne-sovsvc-"));
  const file = path.join(tmp, "world.sqlite");
  const open = [];
  const driver = loadDriver();
  const reopen = () => {
    seedDbFile(driver, file, { migrations: MIGRATIONS, seed: 1 });
    const opened = openStore({
      filePath: file,
      openDatabase: (f) => new driver.Database(f),
      exclusiveLock: true,
      busyTimeoutMs: 0,
      maxRowsPerTransaction: 500,
      maxWriteMsPerPass: 5,
      randomSeed: () => 1,
      migrations: MIGRATIONS,
    });
    assert.ok(opened.ok, JSON.stringify(opened));
    open.push(opened.store);
    return opened.store;
  };
  try {
    return fn(reopen);
  } finally {
    for (const s of open) s.close("test_cleanup");
    try {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch (_err) {
    }
  }
}

async function withStoreAsync(fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lne-sovsvc-"));
  const open = [];
  const driver = loadDriver();
  const openAt = (file) => {
    seedDbFile(driver, file, { migrations: MIGRATIONS, seed: 1 });
    const opened = openStore({ filePath: file, openDatabase: (f) => new driver.Database(f), exclusiveLock: true,
      busyTimeoutMs: 0, maxRowsPerTransaction: 500, maxWriteMsPerPass: 5, randomSeed: () => 1, migrations: MIGRATIONS });
    assert.ok(opened.ok, JSON.stringify(opened));
    open.push(opened.store);
    return opened.store;
  };
  let n = 0;
  try {
    return await fn(() => openAt(path.join(tmp, `world${(n += 1)}.sqlite`)));
  } finally {
    for (const s of open) s.close("test_cleanup");
    try {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch (_err) {
    }
  }
}

function createMockLogger() {
  const logs = [];
  return {
    logs,
    log: (msg) => logs.push(msg),
    error: (msg) => logs.push(`ERROR: ${msg}`),
    warn: (msg) => logs.push(`WARN: ${msg}`),
  };
}

function createMockTelemetry() {
  const counters = new Map();
  const observes = new Map();
  return {
    counters,
    observes,
    count: (name, n = 1) => {
      counters.set(name, (counters.get(name) || 0) + n);
    },
    observe: (name, value) => {
      const arr = observes.get(name) || [];
      arr.push(value);
      observes.set(name, arr);
    },
    getCounter: (name) => counters.get(name) || 0,
    getObserves: (name) => observes.get(name) || [],
  };
}

function createMockClock(startTime = 1000000) {
  let now = startTime;
  return {
    now: () => now,
    advance: (ms) => { now += ms; },
  };
}

function createMockConfig() {
  return {
    enabled: true,
    modules: { sovProjection: { enabled: true }, world: { enabled: true }, occupation: { enabled: true }, virtualCorps: { enabled: true } },
    world: {
      sovProjection: {
        invaderFactionIds: "500021,500026,500029",
        syncBatchSize: 500,
        syncSliceMs: 4,
        maxSovWritesPerWindow: 8,
        sovWriteWindowMs: 300000,
      },
    },
    limits: {
      maxSovWritesPerWindow: 8,
      sovWriteWindowMs: 300000,
    },
    occupation: {
      enabled: true,
      maxActiveSystems: 1000,
    },
    observer: {
      galaxyEnabled: false,
      sovProjectionEnabled: false,
    },
    get: (key) => key.split(".").reduce((o, k) => o?.[k], this),
  };
}

function mockLogStore(logData, txNames = []) {
  const rowOf = (id) => {
    const log = logData.get(id);
    return log ? { last_alliance: null, last_corp: null, last_action: "GAIN", updated_at: 0, ...log, system_id: id, version: 1 }
      : undefined;
  };
  const mockTx = {
    inTransaction: true,
    prepare: (sql) => ({
      get: (id) => rowOf(typeof id === "bigint" ? Number(id) : id),
      all: (json) => JSON.parse(json).map(rowOf).filter(Boolean),
      run: () => ({ changes: 1 }),
    }),
  };
  return {
    transaction: (name, fn) => {
      txNames.push(name);
      return { ok: true, value: fn(mockTx), rows: 0 };
    },
  };
}

function newJournal(clock) {
  return createJournal({ clock, maxPayloadBytes: 4096, maxRows: 100000 });
}

const SS = 30000142;
const FACTION_A = 500016;
const FACTION_B = 500017;
const IDENTITY = new Map([[FACTION_A, { allianceId: 98000001, corp: 98100001 }],
  [FACTION_B, { allianceId: 98000002, corp: 98100002 }]]);
const PLAYER_ALLIANCE = 99000050;

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

function fakeVendor() {
  const claims = new Map();
  const calls = [];
  let gate = null;
  const sovGmState = {
    anchorSovereigntyHub: (ss, alliance, corp) => {
      calls.push(["anchor", ss, alliance, corp]);
      claims.set(ss, { allianceID: alliance, corporationID: corp });
      return gate ? gate.promise.then(() => ({ success: true })) : { success: true };
    },
    loseSystemSovereignty: (ss, alliance, corp) => {
      calls.push(["lose", ss, alliance, corp]);
      if (alliance) claims.set(ss, { allianceID: alliance, corporationID: corp });
      else claims.delete(ss);
      return { success: true };
    },
    reinforceSystemHub: (ss) => {
      calls.push(["reinforce", ss]);
      return { success: true };
    },
  };
  const modules = {
    "services/sovereignty/sovGmState": sovGmState,
    "services/sovereignty/sovState": { getSystemSovClaim: (ss) => claims.get(ss) || null },
    "services/sovereignty/sovSystemRules": { isSovereigntyClaimableSolarSystem: () => true },
    "gameStore/index": { flushTableSync: () => ({ success: true }) },
  };
  const requireGame = (rel) => (modules[rel] ? { ok: true, exports: modules[rel] } : { ok: false, reason: "not_mocked" });
  return { claims, calls, requireGame, setGate: (g) => { gate = g; } };
}

function bootReal(store, opts = {}) {
  const clock = createMockClock();
  const journal = newJournal(clock);
  const repo = createWorldStateRepository({ journal, clock,
    limits: { maxFactionsPerSystem: 8, maxBatchReadIds: 400, maxListLimit: 500 } });
  const seeded = store.transaction("seed", (db) => repo.applyChange(db, { systemId: SS, expectedVersion: 0,
    reason: "SEED_CONTROL", state: { securityClass: "nullsec", controllerFactionId: opts.controller || FACTION_A },
    influence: [{ factionId: opts.controller || FACTION_A, influenceScore: 60 }] }, `world:seed:v1:${SS}`));
  assert.ok(seeded.ok && seeded.value.ok, JSON.stringify(seeded));
  const unwrap = (r) => (r && r.ok ? r.value : { ok: false, reason: (r && r.reason) || "TX_FAILED" });
  const world = {
    getSystem: (id, o) => unwrap(store.transaction("world.getSystem", (tx) => repo.getSystem(tx, id, o))),
    listSystems: (o) => unwrap(store.transaction("world.listSystems", (tx) => repo.listSystems(tx, o))),
  };
  const vendor = fakeVendor();
  const adapter = createAdapter({});
  adapter.setServerSrc("/fake/src");
  adapter.markBooted();
  adapter.requireGame = vendor.requireGame;
  adapter.getProcessRole = () => "world";
  const ready = deferred();
  const virtualCorps = {
    whenReady: () => ready.promise,
    getFactionIdentity: (f) => {
      const id = IDENTITY.get(f);
      return id ? { ok: true, allianceId: id.allianceId, corporationIds: [id.corp], characterIds: [] }
        : { ok: true, allianceId: 0, corporationIds: [], characterIds: [] };
    },
    isVirtualAlliance: (a) => [...IDENTITY.values()].some((i) => i.allianceId === a),
  };
  const telemetry = createMockTelemetry();
  const logger = createMockLogger();
  const config = createMockConfig();
  const persistence = { ok: true, store: opts.store || store, journal };
  const facade = createSovProjectionFacade({ adapter, budget: createSovBudgetFromConfig(config, clock.now), journal,
    persistence, telemetry, config, clock, logger, world, virtualCorps });
  assert.ok(facade, "facade created");
  const logOf = () => {
    const r = store.transaction("t.getLog", (tx) => getLog(tx, SS));
    return r.value.ok ? r.value.value : null;
  };
  const markerOf = (key) => store.transaction("t.marker", (tx) => journal.findByKey(tx, key)).value;
  const moveController = (factionId) => {
    const cur = world.getSystem(SS, { includeInfluence: false }).system;
    const r = store.transaction("t.move", (db) => repo.applyChange(db, { systemId: SS, expectedVersion: cur.version,
      reason: "TEST_CAPTURED", state: { controllerFactionId: factionId, phaseSeq: cur.phaseSeq + 1 } },
      `t:move:${SS}:${cur.version}`));
    assert.ok(r.ok && r.value.ok, JSON.stringify(r));
  };
  return { clock, journal, repo, world, vendor, adapter, virtualCorps, ready, telemetry, logger, config, persistence,
    facade, logOf, markerOf, moveController };
}

module.exports = ({ test, skip }) => {
  const driver = loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  needsDriver("sovProjection: service start/stop registers listener and waits for virtualCorps", async () => {
    await withStore(async (reopen) => {
      const store = reopen();
      const clock = createMockClock();
      const logger = createMockLogger();
      const telemetry = createMockTelemetry();
      const config = createMockConfig();

      const virtualCorps = {
        whenReady: () => Promise.resolve(),
        getFactionIdentity: (factionId) => Promise.resolve({
          ok: true,
          allianceId: 99000000 + factionId,
          corporationIds: [99000100 + factionId],
        }),
      };

      const projectSovCalls = [];
      const adapter = {
        getProcessRole: () => "world",
        requireGame: (relPath) => {
          if (relPath === "services/sovereignty/sovSystemRules") return { ok: true, exports: { isSovereigntyClaimableSolarSystem: async () => true } };
          if (relPath === "services/sovereignty/sovState") return { ok: true, exports: { getSystemSovClaim: async () => null } };
          if (relPath === "services/sovereignty/sovGmState") return { ok: true, exports: { anchorSovereigntyHub: async () => ({ success: true }), loseSystemSovereignty: async () => ({ success: true }), reinforceSystemHub: async () => ({ success: true }) } };
          if (relPath === "gameStore/index") return { ok: true, exports: { flushTableSync: async () => ({ success: true }), _processRole: "world" } };
          return { ok: false, reason: "not_needed" };
        },
        isVirtualAlliance: (id) => id > 99000000,
        getSovProjection: () => ({
          projectSovCall: async (systemId, action, allianceId, corpId) => {
            projectSovCalls.push({ systemId, action, allianceId, corpId });
            return { ok: true, action, reason: null };
          },
          readSovState: async () => ({ ok: true, claim: null, claimable: true }),
          requireGame: adapter.requireGame,
        }),
      };

      let registeredCallback = null;
      const occupation = {
        registerOnControllerChanged: (cb) => {
          const prev = registeredCallback;
          registeredCallback = cb;
          return prev;
        },
      };

      const world = {
        listSystems: (opts) => ({ systems: [{ systemId: 30000101, controllerFactionId: 500016, occupationState: "OCCUPIED", phaseSeq: 1, capturedAt: 1000 }], nextAfterSystemId: null }),
        getSystem: (systemId) => ({ ok: true, system: { systemId: 30000101, controllerFactionId: 500016, occupationState: "OCCUPIED", phaseSeq: 1, capturedAt: 1000 } }),
      };

      const persistence = { ok: true, store: { ...store, _processRole: "world" }, journal: store };

      const ctx = { config, persistence, adapter, virtualCorps, occupation, world, telemetry, logger, clock, getGovernor: () => null, fail: (reason, detail) => ({ ok: true }) };
      const result = await startSovProjection(ctx);
      assert.ok(result.ok, `start failed: ${result.reason} ${result.detail || ""}`);

      assert.strictEqual(typeof registeredCallback, "function", "listener not registered");

      stopSovProjection(ctx);
      assert.strictEqual(ctx.sovProjection, null, "service not cleaned up");
      assert.ok(logger.logs.some(l => l.includes("[sovProjection] stopped")), "stop not logged");
    });
  });

  needsDriver("sovProjection: listener onControllerChanged calls facade.projectSystem", async () => {
    await withStore(async (reopen) => {
      const store = reopen();
      const logger = createMockLogger();
      const telemetry = createMockTelemetry();

      const projectSystemCalls = [];
      const mockFacade = {
        projectSystem: async (systemId) => {
          projectSystemCalls.push(systemId);
          return { ok: true, action: "GAIN", reason: "CONTROLLER_GAINED", skipped: false };
        },
      };

      const ctx = { sovProjection: mockFacade, logger, telemetry };
      const change = { systemId: 30000101, oldController: 500016, newController: 500017, phaseSeq: 2, occupationState: "OCCUPIED" };

      const result = await onControllerChanged(change, ctx);

      assert.ok(result.ok, `listener failed: ${result.reason}`);
      assert.deepStrictEqual(projectSystemCalls, [30000101], "projectSystem not called with correct systemId");
    });
  });

  needsDriver("sovProjection: syncAll skips ALREADY_SYNCED and PLAYER_CLAIM_PROTECTED", async () => {
    await withStore(async (reopen) => {
      const store = reopen();
      const clock = createMockClock();
      const logger = createMockLogger();
      const telemetry = createMockTelemetry();
      const config = createMockConfig();

      const virtualCorps = {
        getFactionIdentity: (factionId) => Promise.resolve({
          ok: true,
          allianceId: 99000000 + factionId,
          corporationIds: [99000100 + factionId],
        }),
      };

      const projectSovCalls = [];
      const mockSovSystemRules = {
        isSovereigntyClaimableSolarSystem: async (systemId) => systemId !== 30000103,
      };
      const mockSovState = {
        getSystemSovClaim: async (systemId) => {
          if (systemId === 30000101) return { allianceID: 500001, corporationID: 500002 };
          if (systemId === 30000102) return { allianceID: 99000101, corporationID: 99000201 };
          return null;
        },
      };
      const mockSovGmState = {
        anchorSovereigntyHub: async () => ({ success: true }),
        loseSystemSovereignty: async () => ({ success: true }),
        reinforceSystemHub: async () => ({ success: true }),
      };

      const adapter = {
        requireGame: (relPath) => {
          if (relPath === "services/sovereignty/sovSystemRules") return { ok: true, exports: mockSovSystemRules };
          if (relPath === "services/sovereignty/sovState") return { ok: true, exports: mockSovState };
          if (relPath === "services/sovereignty/sovGmState") return { ok: true, exports: mockSovGmState };
          if (relPath === "gameStore/index") return { ok: true, exports: { flushTableSync: async () => ({ success: true }) } };
          return { ok: false, reason: "not_needed" };
        },
        isVirtualAlliance: (id) => id >= 99000000 && id < 99000100,
        getSovProjection: () => ({
          projectSovCall: async (systemId, action, allianceId, corpId) => {
            projectSovCalls.push({ systemId, action, allianceId, corpId });
            return { ok: true, action, reason: null };
          },
          readSovState: async () => ({ ok: true, claim: null, claimable: true }),
          requireGame: adapter.requireGame,
        }),
      };

      const occupation = { registerOnControllerChanged: () => null };

      const systems = [
        { systemId: 30000101, controllerFactionId: 500016, occupationState: "OCCUPIED", phaseSeq: 1, capturedAt: 1000 },
        { systemId: 30000102, controllerFactionId: 500017, occupationState: "OCCUPIED", phaseSeq: 2, capturedAt: 2000 },
        { systemId: 30000103, controllerFactionId: 500018, occupationState: "OCCUPIED", phaseSeq: 1, capturedAt: 3000 },
        { systemId: 30000104, controllerFactionId: 500019, occupationState: "OCCUPIED", phaseSeq: 1, capturedAt: 4000 },
      ];
      let listCalls = 0;
      const world = {
        listSystems: (opts) => {
          listCalls++;
          const after = opts.afterSystemId || 0;
          const limit = opts.limit || 500;
          const filtered = systems.filter(s => s.systemId > after).slice(0, limit);
          return { systems: filtered, nextAfterSystemId: filtered.length === limit ? filtered[filtered.length - 1].systemId : null };
        },
        getSystem: (systemId) => {
          const sys = systems.find(s => s.systemId === systemId);
          return sys ? { ok: true, system: sys } : { ok: false, reason: "NOT_FOUND" };
        },
      };

      const logData = new Map();
      logData.set(30000102, { last_controller: 500017, last_seq: 2 });
      const persistence = { ok: true, journal: store, store: mockLogStore(logData) };

      const projectSystemCalls = [];
      const sovProjection = {
        projectSystem: async (systemId, decision) => {
          projectSystemCalls.push({ systemId, decision });
          return { ok: true, action: decision?.action || "GAIN", reason: null, skipped: false };
        },
        requireGame: (relPath) => {
          if (relPath === "services/sovereignty/sovSystemRules") return { ok: true, exports: mockSovSystemRules };
          if (relPath === "services/sovereignty/sovState") return { ok: true, exports: mockSovState };
          if (relPath === "services/sovereignty/sovGmState") return { ok: true, exports: mockSovGmState };
          if (relPath === "gameStore/index") return { ok: true, exports: { flushTableSync: async () => ({ success: true }) } };
          return { ok: false, reason: "not_needed" };
        },
        isVirtualAlliance: (id) => id >= 99000000,
        readSovState: async () => ({ ok: true, claim: null, claimable: true }),
        budget: {
          getStatus: () => ({ used: 0, limit: 8, windowMs: 300000 }),
          tryConsume: () => ({ ok: true, tokensRemaining: 7, retryAfterMs: null, queued: false }),
        },
      };

      const ctx = { 
        sovProjection,
        world, 
        persistence, 
        virtualCorps, 
        config, 
        telemetry, 
        logger, 
        clock 
      };
      const result = await syncAll(ctx);

      assert.ok(result.ok, `syncAll failed: ${result.reason}`);
      assert.strictEqual(result.processed, 1, "processed count wrong");
      assert.strictEqual(result.skipped, 3, "skipped count wrong");
      assert.strictEqual(projectSystemCalls.length, 1, "projectSystem called for wrong number of systems");
      assert.strictEqual(projectSystemCalls[0].systemId, 30000104, "projectSystem called for wrong system");
      assert.strictEqual(telemetry.getCounter("sovProjection.skipped.player_claim_protected"), 1);
      assert.strictEqual(telemetry.getCounter("sovProjection.skipped.already_synced"), 1);
      assert.strictEqual(telemetry.getCounter("sovProjection.skipped.not_claimable"), 1);
    });
  });

  needsDriver("sovProjection: budget exceeded triggers telemetry (no retry queue)", async () => {
    const clock = createMockClock();
    const budget = createSovBudgetFromConfig({ limits: { maxSovWritesPerWindow: 2, sovWriteWindowMs: 300000 } }, clock.now);

    assert.strictEqual(budget.tryConsume().ok, true);
    assert.strictEqual(budget.tryConsume().ok, true);
    const third = budget.tryConsume();
    assert.strictEqual(third.ok, false, "third consume should fail");
    assert.strictEqual(third.queued, false, "should NOT be queued (no retry queue)");
    const status = budget.getStatus();
    assert.ok(!("retryQueueLength" in status), "getStatus should not have retryQueueLength");

    await withStore(async (reopen) => {
      const store = reopen();
      const logger = createMockLogger();
      const telemetry = createMockTelemetry();
      const config = createMockConfig();
      config.limits.maxSovWritesPerWindow = 2;
      config.limits.sovWriteWindowMs = 300000;

      const projectSystemCalls = [];
      let callCount = 0;
      const mockSovSystemRules = {
        isSovereigntyClaimableSolarSystem: async () => true,
      };
      const mockSovState = {
        getSystemSovClaim: async () => null,
      };
      const mockSovGmState = {
        anchorSovereigntyHub: async () => ({ success: true }),
      };

      const sovProjection = {
        projectSystem: async (systemId, decision) => {
          callCount++;
          projectSystemCalls.push({ systemId, decision });
          if (callCount <= 2) return { ok: true, action: decision?.action || "GAIN", reason: null, skipped: false };
          return { ok: false, skipped: true, deferred: true, reason: "BUDGET_EXCEEDED", permanent: false };
        },
        requireGame: (relPath) => {
          if (relPath === "services/sovereignty/sovSystemRules") return { ok: true, exports: mockSovSystemRules };
          if (relPath === "services/sovereignty/sovState") return { ok: true, exports: mockSovState };
          if (relPath === "services/sovereignty/sovGmState") return { ok: true, exports: mockSovGmState };
          if (relPath === "gameStore/index") return { ok: true, exports: { flushTableSync: async () => ({ success: true }) } };
          return { ok: false, reason: "not_needed" };
        },
        isVirtualAlliance: (id) => id >= 99000000,
        readSovState: async () => ({ ok: true, claim: null, claimable: true }),
        budget: {
          getStatus: () => ({ used: Math.min(callCount, 2), limit: 2, windowMs: 300000 }),
          tryConsume: () => {
            if (callCount < 2) return { ok: true, tokensRemaining: 1, retryAfterMs: null, queued: false };
            return { ok: false, tokensRemaining: 0, retryAfterMs: 300000, queued: false };
          },
        },
      };

      const virtualCorps = {
        getFactionIdentity: (factionId) => Promise.resolve({ ok: true, allianceId: 99000000 + factionId, corporationIds: [99000100 + factionId] }),
      };

      const occupation = { registerOnControllerChanged: () => null };

      const systems = [
        { systemId: 30000101, controllerFactionId: 500016, occupationState: "OCCUPIED", phaseSeq: 1, capturedAt: 1000 },
        { systemId: 30000102, controllerFactionId: 500017, occupationState: "OCCUPIED", phaseSeq: 1, capturedAt: 2000 },
        { systemId: 30000103, controllerFactionId: 500018, occupationState: "OCCUPIED", phaseSeq: 1, capturedAt: 3000 },
      ];
      const world = {
        listSystems: (opts) => ({ systems: systems.filter(s => s.systemId > (opts.afterSystemId || 0)).slice(0, opts.limit || 500), nextAfterSystemId: null }),
        getSystem: (systemId) => {
          const sys = systems.find(s => s.systemId === systemId);
          return sys ? { ok: true, system: sys } : { ok: false, reason: "NOT_FOUND" };
        },
      };

      const persistence = { ok: true, journal: store, store: mockLogStore(new Map()) };

      const ctx = { sovProjection, world, persistence, virtualCorps, config, telemetry, logger, clock };
      const result = await syncAll(ctx);

      assert.ok(result.ok);
      assert.strictEqual(result.processed, 2, "processed should be 2");
      assert.strictEqual(result.deferred, 1, "deferred should be 1 (budget exceeded)");
      assert.strictEqual(result.skipped, 0, "skipped should be 0");
      assert.strictEqual(result.failed, 0, "failed should be 0");
      assert.strictEqual(telemetry.getCounter("sovProjection.budgetExceeded"), 0, "syncAll does not count budgetExceeded");
    });
  });

  needsDriver("sovProjection: crash simulation - journal duplicate key skipped", async () => {
    await withStore(async (reopen) => {
      const store = reopen();
      const clock = createMockClock();
      const logger = createMockLogger();
      const telemetry = createMockTelemetry();
      const config = createMockConfig();

      let callCount = 0;
      const mockSovSystemRules = {
        isSovereigntyClaimableSolarSystem: async () => true,
      };
      const mockSovState = {
        getSystemSovClaim: async () => null,
      };
      const mockSovGmState = {
        anchorSovereigntyHub: async () => ({ success: true }),
      };

      const projectSystemCalls = [];
      const sovProjection = {
        projectSystem: async (systemId, decision) => {
          callCount++;
          projectSystemCalls.push({ systemId, decision });
          if (callCount === 1) return { ok: true, action: decision?.action || "GAIN", reason: null, skipped: false };
          return { ok: false, reason: "ALREADY_SYNCED", permanent: true, skipped: true };
        },
        requireGame: (relPath) => {
          if (relPath === "services/sovereignty/sovSystemRules") return { ok: true, exports: mockSovSystemRules };
          if (relPath === "services/sovereignty/sovState") return { ok: true, exports: mockSovState };
          if (relPath === "services/sovereignty/sovGmState") return { ok: true, exports: mockSovGmState };
          if (relPath === "gameStore/index") return { ok: true, exports: { flushTableSync: async () => ({ success: true }) } };
          return { ok: false, reason: "not_needed" };
        },
        isVirtualAlliance: (id) => id >= 99000000 && id < 99000100,
        readSovState: async () => ({ ok: true, claim: null, claimable: true }),
        budget: {
          getStatus: () => ({ used: 0, limit: 8, windowMs: 300000 }),
          tryConsume: () => ({ ok: true, tokensRemaining: 7, retryAfterMs: null, queued: false }),
        },
      };

      const virtualCorps = {
        getFactionIdentity: (factionId) => Promise.resolve({ ok: true, allianceId: 99000000 + factionId, corporationIds: [99000100 + factionId] }),
      };

      const occupation = { registerOnControllerChanged: () => null };

      const systems = [
        { systemId: 30000101, controllerFactionId: 500016, occupationState: "OCCUPIED", phaseSeq: 1, capturedAt: 1000 },
      ];
      const world = {
        listSystems: (opts) => ({ systems: systems.filter(s => s.systemId > (opts.afterSystemId || 0)).slice(0, opts.limit || 500), nextAfterSystemId: null }),
        getSystem: (systemId) => {
          const sys = systems.find(s => s.systemId === systemId);
          return sys ? { ok: true, system: sys } : { ok: false, reason: "NOT_FOUND" };
        },
      };

      const persistence = { ok: true, journal: store,
        store: mockLogStore(new Map([[30000101, { last_controller: 500016, last_seq: 1 }]])) };

      const ctx = { sovProjection, world, persistence, virtualCorps, config, telemetry, logger, clock };
      const result = await syncAll(ctx);

      assert.ok(result.ok);
      assert.strictEqual(result.processed, 0, "processed should be 0 (already synced)");
      assert.strictEqual(result.skipped, 1, "skipped should be 1");
      assert.strictEqual(telemetry.getCounter("sovProjection.skipped.already_synced"), 1);
    });
  });

  test("sovProjection: budget token bucket refills after window", () => {
    const clock = createMockClock(1000000);
    const budget = new SovWriteBudget({ maxTokens: 2, windowMs: 1000, now: () => clock.now() });

    assert.strictEqual(budget.tryConsume().ok, true);
    assert.strictEqual(budget.tryConsume().ok, true);
    assert.strictEqual(budget.tryConsume().ok, false);
    assert.strictEqual(budget.tryConsume().queued, false, "no retry queue");

    clock.advance(1500);

    assert.strictEqual(budget.tryConsume().ok, true, "should refill after window");
    assert.strictEqual(budget.getStatus().tokens, 1, "1 token remaining after refill and consume");
    assert.ok(!("retryQueueLength" in budget.getStatus()), "getStatus should not have retryQueueLength");
  });

  test("sovProjection: budget has no retry queue (queued always false)", () => {
    const clock = createMockClock();
    const budget = new SovWriteBudget({ maxTokens: 1, windowMs: 300000, now: () => clock.now() });

    budget.tryConsume();

    for (let i = 0; i < 35; i++) {
      const result = budget.tryConsume();
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.queued, false, "queued should always be false (no retry queue)");
    }

    const status = budget.getStatus();
    assert.ok(!("retryQueueLength" in status), "getStatus should not have retryQueueLength");
    assert.ok(!("retryQueue" in status), "getStatus should not have retryQueue");
  });

  test("sovProjection: createUnavailableSovProjection returns proper refusal", () => {
    const svc = createUnavailableSovProjection("disabled_by_config");
    assert.strictEqual(svc.getStatus().state, "unavailable");
    assert.strictEqual(svc.getStatus().reason, "disabled_by_config");
    const startResult = svc.start({});
    assert.strictEqual(startResult.ok, false);
    assert.strictEqual(startResult.reason, "disabled_by_config");
  });

  test("OR-A1 sovProjection.readFactionNames reads { ok, names: Map } from the adapter", () => {
    const { readFactionNames } = require("../../../lib/world/sovProjection");
    const names = new Map([[500001, "Caldari State"], [500021, "Sleepers"]]);
    const got = readFactionNames({ readFactionNames: () => ({ ok: true, names }) });
    assert.strictEqual(got.get(500001), "Caldari State");
    assert.strictEqual(got.get(500021), "Sleepers");
    assert.strictEqual(readFactionNames({ readFactionNames: () => ({ ok: false, reason: "X" }) }).size, 0);
    assert.strictEqual(readFactionNames(null).size, 0);
  });

  test("sovProjection: listener ignores invalid change object", async () => {
    const logger = createMockLogger();
    const telemetry = createMockTelemetry();
    const mockFacade = { projectSystem: async () => ({ ok: true }) };

    const result1 = await onControllerChanged(null, { sovProjection: mockFacade, logger, telemetry });
    assert.strictEqual(result1.ok, false);
    assert.strictEqual(result1.reason, "INVALID_CHANGE");

    const result2 = await onControllerChanged({ systemId: "invalid" }, { sovProjection: mockFacade, logger, telemetry });
    assert.strictEqual(result2.ok, false);
    assert.strictEqual(result2.reason, "INVALID_CHANGE");
  });

  needsDriver("sovProjection: service start fails when not in world process", async () => {
    await withStore(async (reopen) => {
      const store = reopen();
      const clock = createMockClock();
      const logger = createMockLogger();
      const telemetry = createMockTelemetry();
      const config = createMockConfig();

      const virtualCorps = { whenReady: () => Promise.resolve(), getFactionIdentity: () => Promise.resolve({ ok: true, allianceId: 1, corporationIds: [2] }) };
      const adapter = { 
        getProcessRole: () => "char",
        requireGame: () => ({ ok: false, reason: "not_needed" }),
        isVirtualAlliance: () => false,
        getSovProjection: () => ({ projectSovCall: async () => ({ ok: true }), readSovState: async () => ({ ok: true, claim: null, claimable: true }), requireGame: adapter.requireGame }),
      };
      const occupation = { registerOnControllerChanged: () => null };
      const world = { listSystems: () => ({ systems: [], nextAfterSystemId: null }), getSystem: () => ({ ok: false, reason: "NOT_FOUND" }) };
      const persistence = { ok: true, store: { ...store, _processRole: "char" }, journal: store };

      const ctx = { config, persistence, adapter, virtualCorps, occupation, world, telemetry, logger, clock, getGovernor: () => null, fail: (reason, detail) => ({ ok: true }) };
      const result = await startSovProjection(ctx);

      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.reason, "not_world_process");
    });
  });

  needsDriver("sovProjection: projectSystem enforces budget before journal (integration)", async () => {
    await withStoreAsync(async (reopen) => {
      const store = reopen();
      const clock = createMockClock();
      const logger = createMockLogger();
      const telemetry = createMockTelemetry();
      const config = createMockConfig();
      config.limits.maxSovWritesPerWindow = 2;
      config.limits.sovWriteWindowMs = 300000;
      config.world.sovProjection.maxSovWritesPerWindow = 2;
      config.world.sovProjection.sovWriteWindowMs = 300000;

      const projectSovCalls = [];
      const adapter = {
        getProcessRole: () => "world",
        requireGame: (relPath) => {
          if (relPath === "services/sovereignty/sovSystemRules") return { ok: true, exports: { isSovereigntyClaimableSolarSystem: async () => true } };
          if (relPath === "services/sovereignty/sovState") return { ok: true, exports: { getSystemSovClaim: async () => null } };
          if (relPath === "services/sovereignty/sovGmState") return { ok: true, exports: { anchorSovereigntyHub: async () => ({ success: true }), loseSystemSovereignty: async () => ({ success: true }), reinforceSystemHub: async () => ({ success: true }) } };
          if (relPath === "gameStore/index") return { ok: true, exports: { flushTableSync: async () => ({ success: true }), _processRole: "world" } };
          return { ok: false, reason: "not_needed" };
        },
        isVirtualAlliance: (id) => id > 99000000,
        getSovProjection: () => ({
          projectSovCall: async (systemId, action, allianceId, corpId) => {
            projectSovCalls.push({ systemId, action, allianceId, corpId });
            return { ok: true, action, reason: null };
          },
          readSovState: async () => ({ ok: true, claim: null, claimable: true }),
          requireGame: adapter.requireGame,
        }),
      };

      const virtualCorps = {
        whenReady: () => Promise.resolve(),
        getFactionIdentity: (factionId) => Promise.resolve({
          ok: true,
          allianceId: 99000000 + factionId,
          corporationIds: [99000100 + factionId],
        }),
      };

      const occupation = {
        registerOnControllerChanged: (cb) => null,
      };

      const world = {
        listSystems: () => ({ systems: [], nextAfterSystemId: null }),
        getSystem: (systemId) => ({ ok: true, system: { systemId, controllerFactionId: 500016, occupationState: "OCCUPIED", phaseSeq: 1, capturedAt: 1000 } }),
      };

      const journal = newJournal(clock);

      const persistence = { ok: true, store, journal };

      const budget = createSovBudgetFromConfig(config, clock.now);
      const sovProjection = createSovProjectionFacade({
        adapter,
        budget,
        journal,
        persistence,
        telemetry,
        config,
        clock,
        logger,
        world,
        virtualCorps,
      });

      assert.ok(sovProjection, "facade should be created");

      const decision = {
        action: "GAIN",
        allianceId: 9900500016,
        executorCorpId: 9900510016,
        controllerFactionId: 500016,
        phaseSeq: 1,
        skip: false,
      };

      const result1 = await sovProjection.projectSystem(30000101, decision);
      assert.ok(result1.ok, `first call failed: ${result1.reason}`);
      assert.strictEqual(result1.skipped, false);
      assert.strictEqual(projectSovCalls.length, 1, "projectSovCall should be called once");

      const result2 = await sovProjection.projectSystem(30000102, decision);
      assert.ok(result2.ok, `second call failed: ${result2.reason}`);
      assert.strictEqual(result2.skipped, false);
      assert.strictEqual(projectSovCalls.length, 2, "projectSovCall should be called twice");

      const result3 = await sovProjection.projectSystem(30000103, decision);
      assert.ok(!result3.ok, "third call should fail");
      assert.strictEqual(result3.skipped, true, "third call should be skipped");
      assert.strictEqual(result3.reason, "BUDGET_EXCEEDED", "reason should be BUDGET_EXCEEDED");
      assert.strictEqual(projectSovCalls.length, 2, "projectSovCall should NOT be called for third attempt");

      assert.strictEqual(telemetry.getCounter("sovProjection.budgetExceeded"), 1, "budgetExceeded telemetry should be 1");

      const status = budget.getStatus();
      assert.strictEqual(status.tokens, 0, "budget tokens should be 0");
      assert.ok(!("retryQueueLength" in status), "getStatus should not have retryQueueLength");
    });
  });

  needsDriver("sovProjection TP1: GAIN writes vendor once, log GAIN and marker; second call ALREADY_SYNCED", async () => {
    await withStoreAsync(async (reopen) => {
      const store = reopen();
      assert.strictEqual(store.db, undefined, "production store facade has no db");
      const h = bootReal(store);

      const r1 = await h.facade.projectSystem(SS);
      assert.deepStrictEqual([r1.ok, r1.action, r1.skipped], [true, "GAIN", false], JSON.stringify(r1));
      assert.deepStrictEqual(h.vendor.calls, [["anchor", SS, 98000001, 98100001]]);
      const log = h.logOf();
      assert.deepStrictEqual([log.last_action, log.last_controller, log.last_alliance, log.last_corp, log.last_seq,
        log.version, log.updated_at], ["GAIN", FACTION_A, 98000001, 98100001, 0, 1, h.clock.now()]);
      const marker = h.markerOf(`sov:proj:${SS}:0:GAIN:0`);
      assert.ok(marker.found, "journal marker of the projection");
      assert.strictEqual(marker.entry.eventType, "SOV_PROJECTION");

      const r2 = await h.facade.projectSystem(SS);
      assert.deepStrictEqual([r2.ok, r2.skipped, r2.reason], [true, true, "ALREADY_SYNCED"], JSON.stringify(r2));
      assert.strictEqual(h.vendor.calls.length, 1, "no vendor call on the second pass");
    });
  });

  needsDriver("sovProjection TP3: claim of faction B alliance under controller A -> TRANSFER; player claim protected", async () => {
    await withStoreAsync(async (reopen) => {
      const store = reopen();
      const h = bootReal(store);
      h.vendor.claims.set(SS, { allianceID: 98000002, corporationID: 98100002 });
      const r = await h.facade.projectSystem(SS);
      assert.deepStrictEqual([r.ok, r.action], [true, "TRANSFER"], JSON.stringify(r));
      assert.deepStrictEqual(h.vendor.calls, [["lose", SS, 98000001, 98100001]]);
      assert.strictEqual(h.vendor.claims.get(SS).allianceID, 98000001);
      assert.strictEqual(h.logOf().last_action, "TRANSFER");

      const p = bootReal(reopen(), { controller: FACTION_B });
      p.vendor.claims.set(SS, { allianceID: PLAYER_ALLIANCE, corporationID: 99100050 });
      const rp = await p.facade.projectSystem(SS);
      assert.deepStrictEqual([rp.ok, rp.skipped, rp.reason], [true, true, "PLAYER_CLAIM_PROTECTED"], JSON.stringify(rp));
      assert.strictEqual(p.vendor.calls.length, 0);
    });
  });

  needsDriver("sovProjection TP4: crash after the vendor keeps the log; next pass repairs it with SYNC, no vendor", async () => {
    await withStoreAsync(async (reopen) => {
      const store = reopen();
      let crash = true;
      const crashing = { ...store, transaction: (name, fn) => (name === "sovProjection.commit" && crash
        ? store.transaction(name, (db) => {
          fn(db);
          throw new Error("injected crash");
        })
        : store.transaction(name, fn)) };
      const h = bootReal(store, { store: crashing });

      const r1 = await h.facade.projectSystem(SS);
      assert.strictEqual(r1.ok, false, JSON.stringify(r1));
      assert.strictEqual(h.vendor.calls.length, 1, "vendor wrote");
      assert.strictEqual(h.logOf(), null, "log unchanged (rolled back)");
      assert.strictEqual(h.markerOf(`sov:proj:${SS}:0:GAIN:0`).found, false, "marker rolled back");

      crash = false;
      const r2 = await h.facade.projectSystem(SS);
      assert.deepStrictEqual([r2.ok, r2.action, r2.reason], [true, "SYNC", "ALREADY_SYNCED"], JSON.stringify(r2));
      assert.strictEqual(h.vendor.calls.length, 1, "repair without the vendor");
      const log = h.logOf();
      assert.deepStrictEqual([log.last_action, log.last_controller, log.last_alliance, log.last_seq],
        ["SYNC", FACTION_A, 98000001, 0]);
      assert.strictEqual(h.telemetry.getCounter("sovProjection.syncRepair"), 1);

      const r3 = await h.facade.projectSystem(SS);
      assert.deepStrictEqual([r3.ok, r3.skipped, r3.reason], [true, true, "ALREADY_SYNCED"]);
      assert.strictEqual(h.telemetry.getCounter("sovProjection.syncRepair"), 1);
    });
  });

  needsDriver("sovProjection TP5: requestProject IN_FLIGHT while one runs; syncState waiting -> running -> done", async () => {
    await withStoreAsync(async (reopen) => {
      const store = reopen();
      const h = bootReal(store);
      const occupation = { registerOnControllerChanged: () => null };
      const ctx = { config: h.config, persistence: h.persistence, adapter: h.adapter, virtualCorps: h.virtualCorps,
        occupation, world: h.world, telemetry: h.telemetry, logger: h.logger, clock: h.clock,
        getGovernor: () => null, fail: () => {} };
      const started = startSovProjection(ctx);
      assert.ok(started.ok, JSON.stringify(started));
      const svc = ctx.sovProjection;
      assert.strictEqual(svc.getStatus().syncState, "waiting");

      const gate = deferred();
      h.vendor.setGate(gate);
      h.ready.resolve();
      await started.whenReady;
      assert.strictEqual(svc.getStatus().syncState, "running");
      for (let i = 0; i < 50 && !svc.isProjecting(SS); i += 1) await new Promise((r) => setImmediate(r));
      assert.strictEqual(svc.isProjecting(SS), true);
      const second = await svc.requestProject(SS);
      assert.deepStrictEqual([second.ok, second.skipped, second.reason], [true, true, "IN_FLIGHT"]);

      gate.resolve();
      for (let i = 0; i < 50 && svc.getStatus().syncState === "running"; i += 1) {
        await new Promise((r) => setImmediate(r));
      }
      assert.strictEqual(svc.getStatus().syncState, "done");
      assert.strictEqual(svc.isProjecting(SS), false);
      assert.strictEqual(h.logOf().last_action, "GAIN");
      assert.strictEqual(h.vendor.calls.length, 1);
      stopSovProjection(ctx);
    });
  });

  needsDriver("sovProjection: getSovModules retries when requireGame first fails", async () => {
    await withStoreAsync(async (reopen) => {
      const store = reopen();
      const clock = createMockClock();
      const journal = newJournal(clock);
      const repo = createWorldStateRepository({ journal, clock,
        limits: { maxFactionsPerSystem: 8, maxBatchReadIds: 400, maxListLimit: 500 } });
      const seeded = store.transaction("seed", (db) => repo.applyChange(db, { systemId: SS, expectedVersion: 0,
        reason: "SEED_CONTROL", state: { securityClass: "nullsec", controllerFactionId: FACTION_A },
        influence: [{ factionId: FACTION_A, influenceScore: 60 }] }, `world:seed:v1:${SS}`));
      assert.ok(seeded.ok && seeded.value.ok, JSON.stringify(seeded));
      const unwrap = (r) => (r && r.ok ? r.value : { ok: false, reason: (r && r.reason) || "TX_FAILED" });
      const world = {
        getSystem: (id, o) => unwrap(store.transaction("world.getSystem", (tx) => repo.getSystem(tx, id, o))),
        listSystems: (o) => unwrap(store.transaction("world.listSystems", (tx) => repo.listSystems(tx, o))),
      };
      const vendor = fakeVendor();
      const adapter = createAdapter({});
      adapter.setServerSrc("/fake/src");
      adapter.markBooted();
      let callCount = 0;
      const origRequireGame = vendor.requireGame;
      const wrappedRequireGame = (rel) => {
        callCount += 1;
        if (callCount === 1) return { ok: false, reason: "not_booted" };
        return origRequireGame(rel);
      };
      adapter.requireGame = wrappedRequireGame;
      adapter.getProcessRole = () => "world";
      adapter.getSovProjection = () => ({
        projectSovCall: async (systemId, action, allianceId, corpId) => {
          vendor.calls.push([action, systemId, allianceId, corpId]);
          return { ok: true, action, reason: null };
        },
        readSovState: async () => ({ ok: true, claim: null, claimable: true }),
        requireGame: wrappedRequireGame,
      });
      const ready = deferred();
      const virtualCorps = {
        whenReady: () => ready.promise,
        getFactionIdentity: (f) => {
          const id = IDENTITY.get(f);
          return id ? { ok: true, allianceId: id.allianceId, corporationIds: [id.corp], characterIds: [] }
            : { ok: true, allianceId: 0, corporationIds: [], characterIds: [] };
        },
        isVirtualAlliance: (a) => [...IDENTITY.values()].some((i) => i.allianceId === a),
      };
      const telemetry = createMockTelemetry();
      const logger = createMockLogger();
      const config = createMockConfig();
      const persistence = { ok: true, store, journal };
      const facade = createSovProjectionFacade({ adapter, budget: createSovBudgetFromConfig(config, clock.now), journal,
        persistence, telemetry, config, clock, logger, world, virtualCorps });
      assert.ok(facade, "facade created");

      const r1 = await facade.projectSystem(SS);
      assert.strictEqual(r1.ok, false, JSON.stringify(r1));
      assert.ok(r1.reason.includes("PROJECT_SYSTEM_THREW"), "first call should throw from getSovModules");

      const r2 = await facade.projectSystem(SS);
      assert.deepStrictEqual([r2.ok, r2.action, r2.skipped], [true, "GAIN", false], JSON.stringify(r2));
      assert.strictEqual(callCount, 4, `requireGame should be called exactly 4 times (retry), got ${callCount}`);
      assert.strictEqual(vendor.calls.length, 1, "vendor called on second attempt");
    });
  });

  needsDriver("sovProjection NOTE-1a: LOSS repair after crash - vendor lose succeeds, commit fails, next pass writes LOSS no vendor", async () => {
    await withStoreAsync(async (reopen) => {
      const store = reopen();
      let crashOnCommit = false;
      const crashing = { ...store, transaction: (name, fn) =>
        (name === "sovProjection.commit" && crashOnCommit)
          ? store.transaction(name, (db) => { fn(db); throw new Error("injected crash"); })
          : store.transaction(name, fn) };
      const h = bootReal(store, { store: crashing });

      const r1 = await h.facade.projectSystem(SS);
      assert.deepStrictEqual([r1.ok, r1.action, r1.skipped], [true, "GAIN", false], JSON.stringify(r1));
      assert.strictEqual(h.vendor.calls.length, 1, "vendor anchor called");
      assert.deepStrictEqual(h.vendor.calls[0], ["anchor", SS, 98000001, 98100001]);
      assert.strictEqual(h.logOf().last_action, "GAIN");
      const versionAfterGain = h.logOf().version;

      h.moveController(null);

      crashOnCommit = true;
      const r2 = await h.facade.projectSystem(SS);
      assert.strictEqual(r2.ok, false, JSON.stringify(r2));
      assert.strictEqual(h.vendor.calls.length, 2, "vendor lose called");
      assert.deepStrictEqual(h.vendor.calls[1].slice(0, 2), ["lose", SS]);
      assert.strictEqual(h.logOf().last_action, "GAIN", "log unchanged after crash (rolled back)");

      h.vendor.claims.delete(SS);

      crashOnCommit = false;
      const r3 = await h.facade.projectSystem(SS);
      assert.deepStrictEqual([r3.ok, r3.action, r3.reason, r3.skipped], [true, "LOSS", "NO_CLAIM", true], JSON.stringify(r3));
      assert.strictEqual(h.vendor.calls.length, 2, "NO vendor call on repair pass");
      const log = h.logOf();
      assert.deepStrictEqual([log.last_action, log.last_controller, log.last_alliance, log.last_corp],
        ["LOSS", null, null, null], JSON.stringify(log));
      assert.ok(log.version > versionAfterGain, "version should increment");
      assert.strictEqual(h.telemetry.getCounter("sovProjection.lossRepair"), 1, "lossRepair counter = 1");
      assert.strictEqual(h.telemetry.getCounter("sovProjection.syncRepair"), 0, "syncRepair counter = 0");

      const logAfterR3 = h.logOf();
      const r4 = await h.facade.projectSystem(SS);
      assert.deepStrictEqual([r4.ok, r4.skipped], [true, true], JSON.stringify(r4));
      assert.strictEqual(h.logOf().version, logAfterR3.version, "version unchanged on r4");
      assert.strictEqual(h.logOf().last_action, logAfterR3.last_action, "last_action unchanged on r4");
      assert.strictEqual(h.telemetry.getCounter("sovProjection.lossRepair"), 1, "lossRepair still 1 after r4");
      assert.strictEqual(h.telemetry.getCounter("sovProjection.syncRepair"), 0, "syncRepair still 0 after r4");
    });
  });

  needsDriver("sovProjection NOTE-1b: LOSS repair leaves log with LOSS (not counted by planReset)", async () => {
    await withStoreAsync(async (reopen) => {
      const store = reopen();
      const h = bootReal(store);
      await h.facade.projectSystem(SS);
      assert.strictEqual(h.logOf().last_action, "GAIN");

      const planBefore = store.transaction("planReset-read", (db) => planReset(db)).value;
      assert.ok(planBefore.ok, JSON.stringify(planBefore));
      assert.strictEqual(planBefore.game.sovClaimsLogged, 1, "before repair: 1 claim logged (GAIN)");

      let crashOnCommit = true;
      const crashing = { ...store, transaction: (name, fn) =>
        (name === "sovProjection.commit" && crashOnCommit)
          ? store.transaction(name, (db) => { fn(db); throw new Error("injected crash"); })
          : store.transaction(name, fn) };
      const h2 = bootReal(store, { store: crashing });
      h2.moveController(null);
      await h2.facade.projectSystem(SS);
      crashOnCommit = false;
      await h2.facade.projectSystem(SS);

      const log = h2.logOf();
      assert.strictEqual(log.last_action, "LOSS", "log should have LOSS after repair");
      assert.strictEqual(log.last_controller, null);
      assert.strictEqual(log.last_alliance, null);
      assert.strictEqual(log.last_corp, null);

      const planAfter = store.transaction("planReset-read", (db) => planReset(db)).value;
      assert.ok(planAfter.ok, JSON.stringify(planAfter));
      assert.strictEqual(planAfter.game.sovClaimsLogged, 0, "after repair: 0 claims logged (LOSS not in CLAIM_ACTIONS)");

      const { CLAIM_ACTIONS } = require("../../../lib/world/sovProjection/schema");
      assert.ok(!CLAIM_ACTIONS.includes(log.last_action), "LOSS is not a claim action");
    });
  });

  needsDriver("sovProjection NOTE-1c: regression - no log, no claim -> NO_CLAIM, no write", async () => {
    await withStoreAsync(async (reopen) => {
      const store = reopen();
      const h = bootReal(store);
      h.moveController(null);

      const r = await h.facade.projectSystem(SS);
      assert.deepStrictEqual([r.ok, r.skipped, r.reason], [true, true, "NO_CLAIM"], JSON.stringify(r));
      assert.strictEqual(h.vendor.calls.length, 0, "no vendor call");
      assert.strictEqual(h.logOf(), null, "no log written");
      assert.strictEqual(h.telemetry.getCounter("sovProjection.lossRepair"), 0);
      assert.strictEqual(h.telemetry.getCounter("sovProjection.syncRepair"), 0);
    });
  });

  needsDriver("sovProjection: claim read failed -> skip, no vendor, no repair; then virtual claim -> LOSS through vendor", async () => {
    await withStoreAsync(async (reopen) => {
      const store = reopen();
      const h = bootReal(store);

      const now = h.clock.now();
      const seededLog = store.transaction("seed.log", (db) => {
        const { upsertLog } = require("../../../lib/world/sovProjection/repository");
        return upsertLog(db, { systemId: SS, controller: FACTION_A, alliance: 98000001, corp: 98100001,
          action: "GAIN", seq: 0, expectedVersion: 0, now });
      });
      assert.ok(seededLog.ok && seededLog.value.ok, JSON.stringify(seededLog));
      const versionAfterGain = seededLog.value.version;

      h.moveController(null);

      const origRequireGame = h.vendor.requireGame;
      let throwCount = 0;
      const throwingRequireGame = (rel) => {
        if (rel === "services/sovereignty/sovState" && throwCount < 2) {
          throwCount += 1;
          return { ok: true, exports: { getSystemSovClaim: () => { throw new Error("db down"); } } };
        }
        return origRequireGame(rel);
      };
      const throwingAdapter = { ...h.adapter, requireGame: throwingRequireGame };

      const facade = require("../../../lib/world/sovProjection").createSovProjectionFacade({
        adapter: throwingAdapter,
        budget: require("../../../lib/world/sovProjection/budget").createSovBudgetFromConfig(h.config, h.clock.now),
        journal: h.journal,
        persistence: h.persistence,
        telemetry: h.telemetry,
        config: h.config,
        clock: h.clock,
        logger: h.logger,
        world: h.world,
        virtualCorps: h.virtualCorps,
      });
      assert.ok(facade, "facade created");

      const r1 = await facade.projectSystem(SS);
      assert.deepStrictEqual([r1.ok, r1.skipped, r1.reason], [true, true, "CLAIM_READ_FAILED"], JSON.stringify(r1));
      assert.strictEqual(h.vendor.calls.length, 0, "no vendor call on claim read failure");
      assert.strictEqual(h.logOf().version, versionAfterGain, "version unchanged");
      assert.strictEqual(h.logOf().last_action, "GAIN", "log still GAIN");
      assert.strictEqual(h.telemetry.getCounter("sovProjection.claimReadFailed"), 1, "claimReadFailed = 1");
      assert.strictEqual(h.telemetry.getCounter("sovProjection.lossRepair"), 0, "lossRepair = 0");

      const logLinesBeforeR2 = h.logger.logs.length;
      const r2 = await facade.projectSystem(SS);
      assert.deepStrictEqual([r2.ok, r2.skipped, r2.reason], [true, true, "CLAIM_READ_FAILED"], JSON.stringify(r2));
      assert.strictEqual(h.logger.logs.length, logLinesBeforeR2, "only one log line total for two read errors");
      assert.strictEqual(h.telemetry.getCounter("sovProjection.claimReadFailed"), 2, "claimReadFailed = 2");

      const normalAdapter = { ...h.adapter, requireGame: origRequireGame };
      const facade2 = require("../../../lib/world/sovProjection").createSovProjectionFacade({
        adapter: normalAdapter,
        budget: require("../../../lib/world/sovProjection/budget").createSovBudgetFromConfig(h.config, h.clock.now),
        journal: h.journal,
        persistence: h.persistence,
        telemetry: h.telemetry,
        config: h.config,
        clock: h.clock,
        logger: h.logger,
        world: h.world,
        virtualCorps: h.virtualCorps,
      });
      assert.ok(facade2, "facade2 created");
      h.vendor.claims.set(SS, { allianceID: 98000001, corporationID: 98100001 });
      const r3 = await facade2.projectSystem(SS);
      assert.deepStrictEqual([r3.ok, r3.action, r3.skipped, r3.reason], [true, "LOSS", false, null], JSON.stringify(r3));
      assert.strictEqual(h.vendor.calls.length, 1, "one vendor lose call");
      assert.deepStrictEqual(h.vendor.calls[0].slice(0, 2), ["lose", SS], "vendor lose called");
      assert.strictEqual(h.telemetry.getCounter("sovProjection.lossRepair"), 0, "lossRepair still 0 (vendor path, not repair)");
    });
  });
};