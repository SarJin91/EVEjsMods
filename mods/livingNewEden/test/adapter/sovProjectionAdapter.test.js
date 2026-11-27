"use strict";

const assert = require("node:assert");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");

const { findServerSrcOnDisk, GAMESTORE_SEARCH_MAX_DEPTH } = require("../../lib/adapter/locator");
const { resolveSqliteDriver } = require("../../lib/adapter/sqliteDriver");
const { MIGRATIONS } = require("../../lib/persistence/migrations");
const { openStore } = require("../../lib/persistence/store");
const { seedDbFile } = require("../_support/dbTemplate");
const { createAdapter } = require("../../lib/adapter");

const MOD_DIR = path.resolve(__dirname, "..", "..");

function loadDriver() {
  const found = findServerSrcOnDisk(MOD_DIR, GAMESTORE_SEARCH_MAX_DEPTH, fs.existsSync);
  if (!found.ok) return { ok: false, detail: found.reason };
  return resolveSqliteDriver(found.srcDir);
}

function withStore(fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lne-sovadapter-"));
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
  return {
    counters,
    count: (name, n = 1) => {
      counters.set(name, (counters.get(name) || 0) + n);
      return true;
    },
    getCounter: (name) => counters.get(name) || 0,
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
    modules: { sovProjection: { enabled: true }, world: { enabled: true }, virtualCorps: { enabled: true } },
    world: {
      sovProjection: {
        invaderFactionIds: "500021,500026,500029",
        reinforceOnLoss: false,
        syncBatchSize: 500,
        syncSliceMs: 4,
      },
      maxFactionsPerSystem: 10,
    },
    limits: {
      maxSovWritesPerWindow: 8,
      sovWriteWindowMs: 300000,
    },
    get: (key) => key.split(".").reduce((o, k) => o?.[k], this),
  };
}

module.exports = ({ test, skip }) => {
  const driver = loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  needsDriver("sovProjectionAdapter: readSovState returns claim and claimable", async () => {
    await withStore(async (reopen) => {
      const store = reopen();
      const clock = createMockClock();
      const logger = createMockLogger();
      const telemetry = createMockTelemetry();
      const config = createMockConfig();

      const virtualCorpsData = new Map([
        [99000001, { ok: true, isVirtualAlliance: true }],
        [500001, { ok: true, isVirtualAlliance: false }],
      ]);
      const isVirtualAlliance = (id) => (virtualCorpsData.get(id) || {}).isVirtualAlliance === true;

      const mockSovState = {
        getSystemSovClaim: async (systemId) => {
          if (systemId === 30000101) return { allianceID: 99000001, corporationID: 99000011 };
          if (systemId === 30000102) return { allianceID: 500001, corporationID: 500002 };
          return null;
        },
      };
      const mockSovSystemRules = {
        isSovereigntyClaimableSolarSystem: async (systemId) => systemId !== 30000103,
      };
      const mockSovGmState = {
        anchorSovereigntyHub: async () => ({ success: true }),
        loseSystemSovereignty: async () => ({ success: true }),
        reinforceSystemHub: async () => ({ success: true }),
      };

      const adapter = createAdapter({});
      adapter.setServerSrc("/fake/src");
      adapter.markBooted();

      adapter.requireGame = (relPath) => {
        if (relPath === "services/sovereignty/sovState") return { ok: true, exports: mockSovState };
        if (relPath === "services/sovereignty/sovSystemRules") return { ok: true, exports: mockSovSystemRules };
        if (relPath === "services/sovereignty/sovGmState") return { ok: true, exports: mockSovGmState };
        if (relPath === "gameStore/index") return { ok: true, exports: { flushTableSync: async () => ({ success: true }) } };
        return { ok: false, reason: "not_mocked" };
      };

      const sovProjection = adapter.getSovProjection({
        requireGame: adapter.requireGame,
        isVirtualAlliance,
        telemetry,
        config,
        clock,
        logger,
      });

      const result1 = await sovProjection.readSovState(30000101);
      assert.strictEqual(result1.ok, true);
      assert.ok(result1.claim !== null);
      assert.strictEqual(result1.claim.allianceID, 99000001);
      assert.strictEqual(result1.claim.isVirtualAlliance, true);
      assert.strictEqual(result1.claimable, true);

      const result2 = await sovProjection.readSovState(30000102);
      assert.strictEqual(result2.ok, true);
      assert.ok(result2.claim !== null);
      assert.strictEqual(result2.claim.allianceID, 500001);
      assert.strictEqual(result2.claim.isVirtualAlliance, false);
      assert.strictEqual(result2.claimable, true);

      const result3 = await sovProjection.readSovState(30000103);
      assert.strictEqual(result3.ok, true);
      assert.strictEqual(result3.claim, null);
      assert.strictEqual(result3.claimable, false);

      const result4 = await sovProjection.readSovState(30000104);
      assert.strictEqual(result4.ok, true);
      assert.strictEqual(result4.claim, null);
      assert.strictEqual(result4.claimable, true);
    });
  });

  needsDriver("sovProjectionAdapter: projectSovCall GAIN calls anchorSovereigntyHub and flushes", async () => {
    await withStore(async (reopen) => {
      const store = reopen();
      const clock = createMockClock();
      const logger = createMockLogger();
      const telemetry = createMockTelemetry();
      const config = createMockConfig();

      const virtualCorpsData = new Map([
        [99000001, { ok: true, isVirtualAlliance: true }],
      ]);
      const isVirtualAlliance = (id) => (virtualCorpsData.get(id) || {}).isVirtualAlliance === true;

      let anchorCalled = false;
      let flushCalled = false;
      const mockSovState = { getSystemSovClaim: async () => null };
      const mockSovSystemRules = { isSovereigntyClaimableSolarSystem: async () => true };
      const mockSovGmState = {
        anchorSovereigntyHub: async (systemId, allianceId, corpId) => {
          anchorCalled = true;
          assert.strictEqual(systemId, 30000101);
          assert.strictEqual(allianceId, 99000001);
          assert.strictEqual(corpId, 99000011);
          return { success: true };
        },
        loseSystemSovereignty: async () => ({ success: true }),
        reinforceSystemHub: async () => ({ success: true }),
      };

      const adapter = createAdapter({});
      adapter.setServerSrc("/fake/src");
      adapter.markBooted();
      adapter.requireGame = (relPath) => {
        if (relPath === "services/sovereignty/sovState") return { ok: true, exports: mockSovState };
        if (relPath === "services/sovereignty/sovSystemRules") return { ok: true, exports: mockSovSystemRules };
        if (relPath === "services/sovereignty/sovGmState") return { ok: true, exports: mockSovGmState };
        if (relPath === "gameStore/index") return { ok: true, exports: { flushTableSync: async (table) => { flushCalled = true; assert.strictEqual(table, "sovereignty"); return { success: true }; } } };
        return { ok: false, reason: "not_mocked" };
      };

      const sovProjection = adapter.getSovProjection({
        requireGame: adapter.requireGame,
        isVirtualAlliance,
        telemetry,
        config,
        clock,
        logger,
      });

      const result = await sovProjection.projectSovCall(30000101, "GAIN", 99000001, 99000011);
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.action, "GAIN");
      assert.strictEqual(anchorCalled, true);
      assert.strictEqual(flushCalled, true);
      assert.strictEqual(telemetry.getCounter("sovProjection.gain"), 1);
    });
  });

  needsDriver("sovProjectionAdapter: projectSovCall GAIN rejects if player claim appears before anchor", async () => {
    await withStore(async (reopen) => {
      const store = reopen();
      const clock = createMockClock();
      const logger = createMockLogger();
      const telemetry = createMockTelemetry();
      const config = createMockConfig();

      const virtualCorpsData = new Map([
        [99000001, { ok: true, isVirtualAlliance: true }],
      ]);
      const isVirtualAlliance = (id) => (virtualCorpsData.get(id) || {}).isVirtualAlliance === true;

      const mockSovState = {
        getSystemSovClaim: async (systemId) => {
          if (systemId === 30000101) return { allianceID: 500001, corporationID: 500002 };
          return null;
        },
      };
      const mockSovSystemRules = { isSovereigntyClaimableSolarSystem: async () => true };
      const mockSovGmState = {
        anchorSovereigntyHub: async () => { throw new Error("should not be called"); },
        loseSystemSovereignty: async () => ({ success: true }),
        reinforceSystemHub: async () => ({ success: true }),
      };

      const adapter = createAdapter({});
      adapter.setServerSrc("/fake/src");
      adapter.markBooted();
      adapter.requireGame = (relPath) => {
        if (relPath === "services/sovereignty/sovState") return { ok: true, exports: mockSovState };
        if (relPath === "services/sovereignty/sovSystemRules") return { ok: true, exports: mockSovSystemRules };
        if (relPath === "services/sovereignty/sovGmState") return { ok: true, exports: mockSovGmState };
        if (relPath === "gameStore/index") return { ok: true, exports: { flushTableSync: async () => ({ success: true }) } };
        return { ok: false, reason: "not_mocked" };
      };

      const sovProjection = adapter.getSovProjection({
        requireGame: adapter.requireGame,
        isVirtualAlliance,
        telemetry,
        config,
        clock,
        logger,
      });

      const result = await sovProjection.projectSovCall(30000101, "GAIN", 99000001, 99000011);
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.reason, "PLAYER_CLAIM_PROTECTED");
      assert.strictEqual(result.permanent, false);
    });
  });

  needsDriver("sovProjectionAdapter: projectSovCall LOSS calls loseSystemSovereignty", async () => {
    await withStore(async (reopen) => {
      const store = reopen();
      const clock = createMockClock();
      const logger = createMockLogger();
      const telemetry = createMockTelemetry();
      const config = createMockConfig();

      const virtualCorpsData = new Map([
        [99000001, { ok: true, isVirtualAlliance: true }],
      ]);
      const isVirtualAlliance = (id) => (virtualCorpsData.get(id) || {}).isVirtualAlliance === true;

      let loseCalled = false;
      const mockSovState = { getSystemSovClaim: async () => ({ allianceID: 99000001, corporationID: 99000011 }) };
      const mockSovSystemRules = { isSovereigntyClaimableSolarSystem: async () => true };
      const mockSovGmState = {
        anchorSovereigntyHub: async () => ({ success: true }),
        loseSystemSovereignty: async (systemId) => {
          loseCalled = true;
          assert.strictEqual(systemId, 30000101);
          return { success: true };
        },
        reinforceSystemHub: async () => ({ success: true }),
      };

      const adapter = createAdapter({});
      adapter.setServerSrc("/fake/src");
      adapter.markBooted();
      adapter.requireGame = (relPath) => {
        if (relPath === "services/sovereignty/sovState") return { ok: true, exports: mockSovState };
        if (relPath === "services/sovereignty/sovSystemRules") return { ok: true, exports: mockSovSystemRules };
        if (relPath === "services/sovereignty/sovGmState") return { ok: true, exports: mockSovGmState };
        if (relPath === "gameStore/index") return { ok: true, exports: { flushTableSync: async () => ({ success: true }) } };
        return { ok: false, reason: "not_mocked" };
      };

      const sovProjection = adapter.getSovProjection({
        requireGame: adapter.requireGame,
        isVirtualAlliance,
        telemetry,
        config,
        clock,
        logger,
      });

      const result = await sovProjection.projectSovCall(30000101, "LOSS", 99000001, 99000011);
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.action, "LOSS");
      assert.strictEqual(loseCalled, true);
      assert.strictEqual(telemetry.getCounter("sovProjection.loss"), 1);
    });
  });

  needsDriver("sovProjectionAdapter: projectSovCall TRANSFER calls loseSystemSovereignty with nextAllianceID/nextCorporationID", async () => {
    await withStore(async (reopen) => {
      const store = reopen();
      const clock = createMockClock();
      const logger = createMockLogger();
      const telemetry = createMockTelemetry();
      const config = createMockConfig();

      const virtualCorpsData = new Map([
        [99000001, { ok: true, isVirtualAlliance: true }],
        [99000002, { ok: true, isVirtualAlliance: true }],
      ]);
      const isVirtualAlliance = (id) => (virtualCorpsData.get(id) || {}).isVirtualAlliance === true;

      let transferCalled = false;
      let transferArgs = null;
      const mockSovState = { getSystemSovClaim: async () => ({ allianceID: 99000001, corporationID: 99000011 }) };
      const mockSovSystemRules = { isSovereigntyClaimableSolarSystem: async () => true };
      const mockSovGmState = {
        anchorSovereigntyHub: async () => ({ success: true }),
        loseSystemSovereignty: async (systemId, nextAllianceId, nextCorpId) => {
          transferCalled = true;
          transferArgs = { systemId, nextAllianceId, nextCorpId };
          return { success: true };
        },
        reinforceSystemHub: async () => ({ success: true }),
      };

      const adapter = createAdapter({});
      adapter.setServerSrc("/fake/src");
      adapter.markBooted();
      adapter.requireGame = (relPath) => {
        if (relPath === "services/sovereignty/sovState") return { ok: true, exports: mockSovState };
        if (relPath === "services/sovereignty/sovSystemRules") return { ok: true, exports: mockSovSystemRules };
        if (relPath === "services/sovereignty/sovGmState") return { ok: true, exports: mockSovGmState };
        if (relPath === "gameStore/index") return { ok: true, exports: { flushTableSync: async () => ({ success: true }) } };
        return { ok: false, reason: "not_mocked" };
      };

      const sovProjection = adapter.getSovProjection({
        requireGame: adapter.requireGame,
        isVirtualAlliance,
        telemetry,
        config,
        clock,
        logger,
      });

      const result = await sovProjection.projectSovCall(30000101, "TRANSFER", 99000002, 99000012);
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.action, "TRANSFER");
      assert.strictEqual(transferCalled, true);
      assert.strictEqual(transferArgs.systemId, 30000101);
      assert.strictEqual(transferArgs.nextAllianceId, 99000002);
      assert.strictEqual(transferArgs.nextCorpId, 99000012);
      assert.strictEqual(telemetry.getCounter("sovProjection.transfer"), 1);
    });
  });

  needsDriver("sovProjectionAdapter: projectSovCall REINFORCE calls reinforceSystemHub", async () => {
    await withStore(async (reopen) => {
      const store = reopen();
      const clock = createMockClock();
      const logger = createMockLogger();
      const telemetry = createMockTelemetry();
      const config = createMockConfig();

      const virtualCorpsData = new Map([
        [99000001, { ok: true, isVirtualAlliance: true }],
      ]);
      const isVirtualAlliance = (id) => (virtualCorpsData.get(id) || {}).isVirtualAlliance === true;

      let reinforceCalled = false;
      const mockSovState = { getSystemSovClaim: async () => ({ allianceID: 99000001, corporationID: 99000011 }) };
      const mockSovSystemRules = { isSovereigntyClaimableSolarSystem: async () => true };
      const mockSovGmState = {
        anchorSovereigntyHub: async () => ({ success: true }),
        loseSystemSovereignty: async () => ({ success: true }),
        reinforceSystemHub: async (systemId) => {
          reinforceCalled = true;
          assert.strictEqual(systemId, 30000101);
          return { success: true };
        },
      };

      const adapter = createAdapter({});
      adapter.setServerSrc("/fake/src");
      adapter.markBooted();
      adapter.requireGame = (relPath) => {
        if (relPath === "services/sovereignty/sovState") return { ok: true, exports: mockSovState };
        if (relPath === "services/sovereignty/sovSystemRules") return { ok: true, exports: mockSovSystemRules };
        if (relPath === "services/sovereignty/sovGmState") return { ok: true, exports: mockSovGmState };
        if (relPath === "gameStore/index") return { ok: true, exports: { flushTableSync: async () => ({ success: true }) } };
        return { ok: false, reason: "not_mocked" };
      };

      const sovProjection = adapter.getSovProjection({
        requireGame: adapter.requireGame,
        isVirtualAlliance,
        telemetry,
        config,
        clock,
        logger,
      });

      const result = await sovProjection.projectSovCall(30000101, "REINFORCE", 99000001, 99000011);
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.action, "REINFORCE");
      assert.strictEqual(reinforceCalled, true);
      assert.strictEqual(telemetry.getCounter("sovProjection.reinforce"), 1);
    });
  });

  needsDriver("sovProjectionAdapter: vendor error shape {success: false, errorMsg} returns structural error", async () => {
    await withStore(async (reopen) => {
      const store = reopen();
      const clock = createMockClock();
      const logger = createMockLogger();
      const telemetry = createMockTelemetry();
      const config = createMockConfig();

      const virtualCorpsData = new Map([
        [99000001, { ok: true, isVirtualAlliance: true }],
      ]);
      const isVirtualAlliance = (id) => (virtualCorpsData.get(id) || {}).isVirtualAlliance === true;

      const mockSovState = { getSystemSovClaim: async () => null };
      const mockSovSystemRules = { isSovereigntyClaimableSolarSystem: async () => true };
      const mockSovGmState = {
        anchorSovereigntyHub: async () => ({ success: false, errorMsg: "allianceID already exists" }),
        loseSystemSovereignty: async () => ({ success: true }),
        reinforceSystemHub: async () => ({ success: true }),
      };

      const adapter = createAdapter({});
      adapter.setServerSrc("/fake/src");
      adapter.markBooted();
      adapter.requireGame = (relPath) => {
        if (relPath === "services/sovereignty/sovState") return { ok: true, exports: mockSovState };
        if (relPath === "services/sovereignty/sovSystemRules") return { ok: true, exports: mockSovSystemRules };
        if (relPath === "services/sovereignty/sovGmState") return { ok: true, exports: mockSovGmState };
        if (relPath === "gameStore/index") return { ok: true, exports: { flushTableSync: async () => ({ success: true }) } };
        return { ok: false, reason: "not_mocked" };
      };

      const sovProjection = adapter.getSovProjection({
        requireGame: adapter.requireGame,
        isVirtualAlliance,
        telemetry,
        config,
        clock,
        logger,
      });

      const result = await sovProjection.projectSovCall(30000101, "GAIN", 99000001, 99000011);
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.reason, "allianceID already exists");
      assert.strictEqual(result.permanent, true);
    });
  });

  needsDriver("sovProjectionAdapter: flushTableSync failure logged but call succeeds", async () => {
    await withStore(async (reopen) => {
      const store = reopen();
      const clock = createMockClock();
      const logger = createMockLogger();
      const telemetry = createMockTelemetry();
      const config = createMockConfig();

      const virtualCorpsData = new Map([
        [99000001, { ok: true, isVirtualAlliance: true }],
      ]);
      const isVirtualAlliance = (id) => (virtualCorpsData.get(id) || {}).isVirtualAlliance === true;

      const mockSovState = { getSystemSovClaim: async () => null };
      const mockSovSystemRules = { isSovereigntyClaimableSolarSystem: async () => true };
      const mockSovGmState = {
        anchorSovereigntyHub: async () => ({ success: true }),
        loseSystemSovereignty: async () => ({ success: true }),
        reinforceSystemHub: async () => ({ success: true }),
      };

      const adapter = createAdapter({});
      adapter.setServerSrc("/fake/src");
      adapter.markBooted();
      adapter.requireGame = (relPath) => {
        if (relPath === "services/sovereignty/sovState") return { ok: true, exports: mockSovState };
        if (relPath === "services/sovereignty/sovSystemRules") return { ok: true, exports: mockSovSystemRules };
        if (relPath === "services/sovereignty/sovGmState") return { ok: true, exports: mockSovGmState };
        if (relPath === "gameStore/index") return { ok: true, exports: { flushTableSync: async () => { throw new Error("flush failed"); } } };
        return { ok: false, reason: "not_mocked" };
      };

      const sovProjection = adapter.getSovProjection({
        requireGame: adapter.requireGame,
        isVirtualAlliance,
        telemetry,
        config,
        clock,
        logger,
      });

      const result = await sovProjection.projectSovCall(30000101, "GAIN", 99000001, 99000011);
      assert.strictEqual(result.ok, true);
      assert.ok(logger.logs.some(l => l.includes("sovereignty flush threw")));
    });
  });

  test("sovProjectionAdapter: flushTableDurable is awaited, success:false and a rejection are logged, the call "
    + "succeeds", async () => {
    const run = async (durable) => {
      const logger = createMockLogger();
      const calls = [];
      const mockSovGmState = { anchorSovereigntyHub: async () => ({ success: true }) };
      const gameStore = {
        flushTableSync: () => {
          calls.push("sync");
          return { success: true };
        },
        flushTableDurable: (table) => {
          calls.push(`durable:${table}`);
          return durable();
        },
      };
      const adapter = createAdapter({});
      adapter.setServerSrc("/fake/src");
      adapter.markBooted();
      adapter.requireGame = (relPath) => {
        if (relPath === "services/sovereignty/sovState") return { ok: true, exports: { getSystemSovClaim: async () => null } };
        if (relPath === "services/sovereignty/sovSystemRules") {
          return { ok: true, exports: { isSovereigntyClaimableSolarSystem: async () => true } };
        }
        if (relPath === "services/sovereignty/sovGmState") return { ok: true, exports: mockSovGmState };
        if (relPath === "gameStore/index") return { ok: true, exports: gameStore };
        return { ok: false, reason: "not_mocked" };
      };
      const sovProjection = adapter.getSovProjection({ requireGame: adapter.requireGame,
        isVirtualAlliance: () => true, telemetry: createMockTelemetry(), config: createMockConfig(),
        clock: createMockClock(), logger });
      const result = await sovProjection.projectSovCall(30000101, "GAIN", 99000001, 99000011);
      return [result.ok, calls, logger.logs.filter((l) => l.includes("sovereignty flush"))];
    };
    assert.deepStrictEqual(await run(async () => ({ success: true })), [true, ["durable:sovereignty"], []]);
    assert.deepStrictEqual(await run(async () => ({ success: false, errorMsg: "FLUSH_ERROR" })),
      [true, ["durable:sovereignty"], ["WARN: [sovProjection] sovereignty flush returned failure: FLUSH_ERROR"]]);
    assert.deepStrictEqual(await run(() => Promise.reject(new Error("worker gone"))),
      [true, ["durable:sovereignty"], ["WARN: [sovProjection] sovereignty flush threw: worker gone"]]);
  });

  needsDriver("sovProjectionAdapter: isVirtualAlliance injected from virtualCorps", async () => {
    await withStore(async (reopen) => {
      const store = reopen();
      const clock = createMockClock();
      const logger = createMockLogger();
      const telemetry = createMockTelemetry();
      const config = createMockConfig();

      const virtualCorpsData = new Map([
        [99000001, { ok: true, isVirtualAlliance: true }],
        [99000002, { ok: true, isVirtualAlliance: true }],
        [500001, { ok: true, isVirtualAlliance: false }],
      ]);
      const isVirtualAlliance = (id) => (virtualCorpsData.get(id) || {}).isVirtualAlliance === true;

      const mockSovState = {
        getSystemSovClaim: async (systemId) => {
          if (systemId === 30000101) return { allianceID: 99000001, corporationID: 99000011 };
          if (systemId === 30000102) return { allianceID: 500001, corporationID: 500002 };
          return null;
        },
      };
      const mockSovSystemRules = { isSovereigntyClaimableSolarSystem: async () => true };
      const mockSovGmState = {
        anchorSovereigntyHub: async () => ({ success: true }),
        loseSystemSovereignty: async () => ({ success: true }),
        reinforceSystemHub: async () => ({ success: true }),
      };

      const adapter = createAdapter({});
      adapter.setServerSrc("/fake/src");
      adapter.markBooted();
      adapter.requireGame = (relPath) => {
        if (relPath === "services/sovereignty/sovState") return { ok: true, exports: mockSovState };
        if (relPath === "services/sovereignty/sovSystemRules") return { ok: true, exports: mockSovSystemRules };
        if (relPath === "services/sovereignty/sovGmState") return { ok: true, exports: mockSovGmState };
        if (relPath === "gameStore/index") return { ok: true, exports: { flushTableSync: async () => ({ success: true }) } };
        return { ok: false, reason: "not_mocked" };
      };

      const sovProjection = adapter.getSovProjection({
        requireGame: adapter.requireGame,
        isVirtualAlliance,
        telemetry,
        config,
        clock,
        logger,
      });

      const result1 = await sovProjection.readSovState(30000101);
      assert.strictEqual(result1.claim.isVirtualAlliance, true);

      const result2 = await sovProjection.readSovState(30000102);
      assert.strictEqual(result2.claim.isVirtualAlliance, false);
    });
  });

  needsDriver("sovProjectionAdapter: projectSovCall on non-claimable system returns skipped", async () => {
    await withStore(async (reopen) => {
      const store = reopen();
      const clock = createMockClock();
      const logger = createMockLogger();
      const telemetry = createMockTelemetry();
      const config = createMockConfig();

      const virtualCorpsData = new Map([
        [99000001, { ok: true, isVirtualAlliance: true }],
      ]);
      const isVirtualAlliance = (id) => (virtualCorpsData.get(id) || {}).isVirtualAlliance === true;

      const mockSovState = { getSystemSovClaim: async () => null };
      const mockSovSystemRules = { isSovereigntyClaimableSolarSystem: async () => false };
      const mockSovGmState = {
        anchorSovereigntyHub: async () => { throw new Error("should not be called"); },
        loseSystemSovereignty: async () => ({ success: true }),
        reinforceSystemHub: async () => ({ success: true }),
      };

      const adapter = createAdapter({});
      adapter.setServerSrc("/fake/src");
      adapter.markBooted();
      adapter.requireGame = (relPath) => {
        if (relPath === "services/sovereignty/sovState") return { ok: true, exports: mockSovState };
        if (relPath === "services/sovereignty/sovSystemRules") return { ok: true, exports: mockSovSystemRules };
        if (relPath === "services/sovereignty/sovGmState") return { ok: true, exports: mockSovGmState };
        if (relPath === "gameStore/index") return { ok: true, exports: { flushTableSync: async () => ({ success: true }) } };
        return { ok: false, reason: "not_mocked" };
      };

      const sovProjection = adapter.getSovProjection({
        requireGame: adapter.requireGame,
        isVirtualAlliance,
        telemetry,
        config,
        clock,
        logger,
      });

      const result = await sovProjection.projectSovCall(30000101, "GAIN", 99000001, 99000011);
      assert.strictEqual(result.ok, true);
      assert.strictEqual(result.action, "NONE");
      assert.strictEqual(result.reason, "NOT_CLAIMABLE");
      assert.strictEqual(result.skipped, true);
    });
  });

  needsDriver("sovProjectionAdapter: unknown action returns error", async () => {
    await withStore(async (reopen) => {
      const store = reopen();
      const clock = createMockClock();
      const logger = createMockLogger();
      const telemetry = createMockTelemetry();
      const config = createMockConfig();

      const virtualCorpsData = new Map();
      const isVirtualAlliance = () => false;

      const mockSovState = { getSystemSovClaim: async () => null };
      const mockSovSystemRules = { isSovereigntyClaimableSolarSystem: async () => true };
      const mockSovGmState = {
        anchorSovereigntyHub: async () => ({ success: true }),
        loseSystemSovereignty: async () => ({ success: true }),
        reinforceSystemHub: async () => ({ success: true }),
      };

      const adapter = createAdapter({});
      adapter.setServerSrc("/fake/src");
      adapter.markBooted();
      adapter.requireGame = (relPath) => {
        if (relPath === "services/sovereignty/sovState") return { ok: true, exports: mockSovState };
        if (relPath === "services/sovereignty/sovSystemRules") return { ok: true, exports: mockSovSystemRules };
        if (relPath === "services/sovereignty/sovGmState") return { ok: true, exports: mockSovGmState };
        if (relPath === "gameStore/index") return { ok: true, exports: { flushTableSync: async () => ({ success: true }) } };
        return { ok: false, reason: "not_mocked" };
      };

      const sovProjection = adapter.getSovProjection({
        requireGame: adapter.requireGame,
        isVirtualAlliance,
        telemetry,
        config,
        clock,
        logger,
      });

      const result = await sovProjection.projectSovCall(30000101, "UNKNOWN", 99000001, 99000011);
      assert.strictEqual(result.ok, false);
      assert.ok(result.reason.includes("UNKNOWN_ACTION"));
    });
  });

  needsDriver("sovProjectionAdapter: returned object only has projectSovCall and readSovState", async () => {
    await withStore(async (reopen) => {
      const store = reopen();
      const clock = createMockClock();
      const logger = createMockLogger();
      const telemetry = createMockTelemetry();
      const config = createMockConfig();

      const virtualCorpsData = new Map();
      const isVirtualAlliance = () => false;

      const mockSovState = { getSystemSovClaim: async () => null };
      const mockSovSystemRules = { isSovereigntyClaimableSolarSystem: async () => true };
      const mockSovGmState = {
        anchorSovereigntyHub: async () => ({ success: true }),
        loseSystemSovereignty: async () => ({ success: true }),
        reinforceSystemHub: async () => ({ success: true }),
      };

      const adapter = createAdapter({});
      adapter.setServerSrc("/fake/src");
      adapter.markBooted();
      adapter.requireGame = (relPath) => {
        if (relPath === "services/sovereignty/sovState") return { ok: true, exports: mockSovState };
        if (relPath === "services/sovereignty/sovSystemRules") return { ok: true, exports: mockSovSystemRules };
        if (relPath === "services/sovereignty/sovGmState") return { ok: true, exports: mockSovGmState };
        if (relPath === "gameStore/index") return { ok: true, exports: { flushTableSync: async () => ({ success: true }) } };
        return { ok: false, reason: "not_mocked" };
      };

      const sovProjection = adapter.getSovProjection({
        requireGame: adapter.requireGame,
        isVirtualAlliance,
        telemetry,
        config,
        clock,
        logger,
      });

      const keys = Object.keys(sovProjection).sort();
      assert.deepStrictEqual(keys, ["projectSovCall", "readSovState"]);
      assert.strictEqual(typeof sovProjection.projectSovCall, "function");
      assert.strictEqual(typeof sovProjection.readSovState, "function");
    });
  });
};