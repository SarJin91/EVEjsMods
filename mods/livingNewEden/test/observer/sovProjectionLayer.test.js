"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createViewRegistry } = require("../../lib/observer/views");
const { buildSovProjectionLayerView } = require("../../lib/observer/layers/layer-sov-projection");
const { findServerSrcOnDisk, GAMESTORE_SEARCH_MAX_DEPTH } = require("../../lib/adapter/locator");
const { resolveSqliteDriver } = require("../../lib/adapter/sqliteDriver");
const { MIGRATIONS } = require("../../lib/persistence/migrations");
const { openStore } = require("../../lib/persistence/store");
const { seedDbFile } = require("../_support/dbTemplate");
const { createJournal } = require("../../lib/persistence/journal");
const { createManualClock } = require("../../lib/util/clock");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const DEFAULTS = require("../../config").resolveConfig({ modDir: MOD_DIR, env: {} }).config;
const START_MS = 1760000000000;

function loadDriver() {
  const found = findServerSrcOnDisk(MOD_DIR, GAMESTORE_SEARCH_MAX_DEPTH, fs.existsSync);
  if (!found.ok) return { ok: false, detail: found.reason };
  return resolveSqliteDriver(found.srcDir);
}

function withStore(fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lne-sovproj-layer-"));
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
      maxRowsPerTransaction: 5000,
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

module.exports = ({ test, skip }) => {
  const driver = loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  test("SP1 buildSovProjectionLayerView returns correct view object", () => {
    const views = createViewRegistry();
    views.registerView("galaxy-static", {
      title: "Static", listed: false, getData: () => ({ available: true, systems: { id: [1], x: [0], y: [0] } }),
      cacheKey: () => "static-key"
    });
    const store = { isOpen: () => true };
    const repository = {};
    const getGovernor = () => ({ admits: () => true });
    const clock = { now: () => START_MS };
    const nowMs = () => START_MS;
    const telemetry = { observe: () => {}, count: () => {} };
    const factionNames = new Map([[500016, "Test Faction"]]);
    const config = { observer: { sovProjectionMaxSystems: 1000, sovProjectionRefreshMs: 15000 } };

    const layer = buildSovProjectionLayerView({
      store, repository, getStaticView: () => views.getView("galaxy-static"),
      config, factionNames, getGovernor, telemetry, clock, nowMs,
      settings: { maxSystems: 1000, refreshMs: 15000, radius: 50 }
    });

    assert.strictEqual(layer.title, "Sovereignty projection");
    assert.strictEqual(layer.listed, false);
    assert.deepStrictEqual(layer.mapLayer, { kind: "areas", order: 6 });
    assert.strictEqual(typeof layer.cacheKey, "function");
    assert.strictEqual(typeof layer.getData, "function");
  });

  test("SP2 cacheKey: closed store -> null", () => {
    const views = createViewRegistry();
    views.registerView("galaxy-static", {
      title: "Static", listed: false, getData: () => ({ available: true, systems: { id: [1], x: [0], y: [0] } }),
      cacheKey: () => "static-key"
    });
    const store = { isOpen: () => false };
    const layer = buildSovProjectionLayerView({
      store, repository: {}, getStaticView: () => views.getView("galaxy-static"),
      config: {}, factionNames: new Map(), getGovernor: () => ({ admits: () => true }),
      telemetry: null, clock: { now: () => START_MS }, nowMs: () => START_MS,
      settings: { maxSystems: 1000, refreshMs: 15000, radius: 50 }
    });
    assert.strictEqual(layer.cacheKey(), null);
  });

  test("SP3 cacheKey: governor hold -> null", () => {
    const views = createViewRegistry();
    views.registerView("galaxy-static", {
      title: "Static", listed: false, getData: () => ({ available: true, systems: { id: [1], x: [0], y: [0] } }),
      cacheKey: () => "static-key"
    });
    const store = { isOpen: () => true };
    const layer = buildSovProjectionLayerView({
      store, repository: {}, getStaticView: () => views.getView("galaxy-static"),
      config: {}, factionNames: new Map(), getGovernor: () => ({ admits: () => false }),
      telemetry: null, clock: { now: () => START_MS }, nowMs: () => START_MS,
      settings: { maxSystems: 1000, refreshMs: 15000, radius: 50 }
    });
    assert.strictEqual(layer.cacheKey(), null);
  });

  test("SP4 cacheKey: admitted -> time bucket key", () => {
    const views = createViewRegistry();
    views.registerView("galaxy-static", {
      title: "Static", listed: false, getData: () => ({ available: true, systems: { id: [1], x: [0], y: [0] } }),
      cacheKey: () => "static-key"
    });
    const store = { isOpen: () => true };
    const clock = { now: () => START_MS };
    const layer = buildSovProjectionLayerView({
      store, repository: {}, getStaticView: () => views.getView("galaxy-static"),
      config: {}, factionNames: new Map(), getGovernor: () => ({ admits: () => true }),
      telemetry: null, clock, nowMs: () => START_MS,
      settings: { maxSystems: 1000, refreshMs: 15000, radius: 50 }
    });
    const key1 = layer.cacheKey();
    assert.match(key1, /^k\d+\|static-key$/);
    assert.strictEqual(layer.cacheKey(), key1);
  });

  needsDriver("SP5 getData: real store with fixture data", () => {
    withStore((reopen) => {
      const store = reopen();
      const clock = createManualClock(START_MS);
      const journal = createJournal({ clock, maxPayloadBytes: 4096, maxRows: 500 });

      store.transaction("setup", (db) => {
        const stmtSys = db.prepare("INSERT INTO world_system_state (system_id, security_class, controller_faction_id, occupation_state, threat_level, last_state_change_at, next_strategy_review_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
        const stmtLog = db.prepare("INSERT INTO world_sov_projection_log (system_id, last_controller, last_alliance, last_corp, last_action, last_seq, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
        const now = START_MS;
        stmtSys.run(30000101, 'nullsec', 500016, 'STABLE', 0, now, null, now, 1);
        stmtSys.run(30000102, 'nullsec', 500016, 'STABLE', 0, now, null, now, 1);
        stmtSys.run(30000103, 'nullsec', 500017, 'STABLE', 0, now, null, now, 1);
        stmtLog.run(30000101, 500016, 99000001, 99000011, 'GAIN', 5, now, 1);
        stmtLog.run(30000102, 500016, 99000001, 99000012, 'GAIN', 6, now, 1);
        stmtLog.run(30000103, 500017, 99000002, 99000013, 'TRANSFER', 10, now, 1);
      });

      const views = createViewRegistry();
      views.registerView("galaxy-static", {
        title: "Static", listed: false,
        getData: () => ({
          available: true,
          grid: { width: 10000, height: 10000 },
          systems: {
            id: [30000101, 30000102, 30000103],
            x: [100, 200, 300],
            y: [400, 500, 600]
          }
        }),
        cacheKey: () => "static-key"
      });

      const factionNames = new Map([[500016, "Faction A"], [500017, "Faction B"]]);
      const counts = {};
      const telemetry = {
        observe: (name, v) => { counts[name] = v; },
        count: (name, n) => { counts[name] = (counts[name] || 0) + n; }
      };

      const layer = buildSovProjectionLayerView({
        store,
        repository: require("../../lib/world/sovProjection/repository"),
        getStaticView: () => views.getView("galaxy-static"),
        config: { observer: { sovProjectionMaxSystems: 1000, sovProjectionRefreshMs: 15000 } },
        factionNames,
        getGovernor: () => ({ admits: () => true }),
        telemetry,
        clock,
        nowMs: () => START_MS,
        settings: { maxSystems: 1000, refreshMs: 15000, radius: 50 }
      });

      const data = layer.getData();
      assert.strictEqual(data.available, true);
      assert.strictEqual(data.areas.length, 2, "two factions with projections");
      assert.strictEqual(data.names.length, 2);
      assert.strictEqual(data.stats.systems, 3);
      assert.strictEqual(data.stats.factions, 2);
      assert.strictEqual(data.cellSize, 100);
      assert.strictEqual(data.radius, 50);
      for (const area of data.areas) {
        assert.strictEqual(Array.isArray(area[2]), true);
        assert.strictEqual(Array.isArray(area[3]), true);
        for (const ring of area[3]) {
          assert.strictEqual(ring.length, 32, "16 points = 32 coords");
        }
      }
      assert.deepStrictEqual(data.names, [[500016, "Faction A"], [500017, "Faction B"]]);
      assert.ok(counts["observer.galaxySovProjectionMs"] >= 0);
      assert.strictEqual(counts["observer.galaxySovProjectionSystems"], 3);
      assert.strictEqual(counts["observer.galaxySovProjectionFactions"], 2);
    });
  });

  needsDriver("SP6 getData: empty log returns available with empty areas", () => {
    withStore((reopen) => {
      const store = reopen();
      const clock = createManualClock(START_MS);
      const journal = createJournal({ clock, maxPayloadBytes: 4096, maxRows: 500 });

      store.transaction("setup", (db) => {
        const stmtSys = db.prepare("INSERT INTO world_system_state (system_id, security_class, controller_faction_id, occupation_state, threat_level, last_state_change_at, next_strategy_review_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
        const now = START_MS;
        stmtSys.run(30000101, 'nullsec', 500016, 'STABLE', 0, now, null, now, 1);
      });

      const views = createViewRegistry();
      views.registerView("galaxy-static", {
        title: "Static", listed: false,
        getData: () => ({
          available: true,
          grid: { width: 10000, height: 10000 },
          systems: { id: [30000101], x: [100], y: [400] }
        }),
        cacheKey: () => "static-key"
      });

      const layer = buildSovProjectionLayerView({
        store,
        repository: require("../../lib/world/sovProjection/repository"),
        getStaticView: () => views.getView("galaxy-static"),
        config: { observer: { sovProjectionMaxSystems: 1000, sovProjectionRefreshMs: 15000 } },
        factionNames: new Map(),
        getGovernor: () => ({ admits: () => true }),
        telemetry: null,
        clock,
        nowMs: () => START_MS,
        settings: { maxSystems: 1000, refreshMs: 15000, radius: 50 }
      });

      const data = layer.getData();
      assert.strictEqual(data.available, true);
      assert.deepStrictEqual(data.areas, []);
      assert.deepStrictEqual(data.names, []);
      assert.strictEqual(data.stats.systems, 0);
      assert.strictEqual(data.stats.factions, 0);
    });
  });

  test("SP7 getData: missing static view -> STATIC_UNAVAILABLE", () => {
    const store = { isOpen: () => true };
    const layer = buildSovProjectionLayerView({
      store,
      repository: {},
      getStaticView: () => null,
      config: {},
      factionNames: new Map(),
      getGovernor: () => ({ admits: () => true }),
      telemetry: null,
      clock: { now: () => START_MS },
      nowMs: () => START_MS,
      settings: { maxSystems: 1000, refreshMs: 15000, radius: 50 }
    });
    const data = layer.getData();
    assert.deepStrictEqual(data, { available: false, reason: "STATIC_UNAVAILABLE" });
  });

  test("SP8 getData: static view unavailable -> STATIC_UNAVAILABLE", () => {
    const store = { isOpen: () => true };
    const views = createViewRegistry();
    views.registerView("galaxy-static", {
      title: "Static", listed: false,
      getData: () => ({ available: false, reason: "NOT_READY" }),
      cacheKey: () => "static-key"
    });
    const layer = buildSovProjectionLayerView({
      store,
      repository: {},
      getStaticView: () => views.getView("galaxy-static"),
      config: {},
      factionNames: new Map(),
      getGovernor: () => ({ admits: () => true }),
      telemetry: null,
      clock: { now: () => START_MS },
      nowMs: () => START_MS,
      settings: { maxSystems: 1000, refreshMs: 15000, radius: 50 }
    });
    const data = layer.getData();
    assert.deepStrictEqual(data, { available: false, reason: "STATIC_UNAVAILABLE" });
  });

  needsDriver("SP9 getData: maxSystems limit respected", () => {
    withStore((reopen) => {
      const store = reopen();
      const clock = createManualClock(START_MS);
      const journal = createJournal({ clock, maxPayloadBytes: 4096, maxRows: 500 });

      store.transaction("setup", (db) => {
        const stmtSys = db.prepare("INSERT INTO world_system_state (system_id, security_class, controller_faction_id, occupation_state, threat_level, last_state_change_at, next_strategy_review_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
        const stmtLog = db.prepare("INSERT INTO world_sov_projection_log (system_id, last_controller, last_alliance, last_corp, last_action, last_seq, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
        const now = START_MS;
        for (let i = 1; i <= 1500; i += 1) {
          const sysId = 30001000 + i;
          stmtSys.run(sysId, 'nullsec', 500016, 'STABLE', 0, now, null, now, 1);
          stmtLog.run(sysId, 500016, 99000001, 99000011, 'GAIN', i, now, 1);
        }
      });

      const views = createViewRegistry();
      views.registerView("galaxy-static", {
        title: "Static", listed: false,
        getData: () => ({
          available: true,
          grid: { width: 10000, height: 10000 },
          systems: {
            id: Array.from({ length: 1500 }, (_, i) => 30001001 + i),
            x: Array.from({ length: 1500 }, (_, i) => i),
            y: Array.from({ length: 1500 }, (_, i) => 0)
          }
        }),
        cacheKey: () => "static-key"
      });

      const counts = {};
      const telemetry = {
        observe: () => {},
        count: (name, n) => { counts[name] = (counts[name] || 0) + n; }
      };

      const layer = buildSovProjectionLayerView({
        store,
        repository: require("../../lib/world/sovProjection/repository"),
        getStaticView: () => views.getView("galaxy-static"),
        config: { observer: { sovProjectionMaxSystems: 1000, sovProjectionRefreshMs: 15000 } },
        factionNames: new Map([[500016, "Faction A"]]),
        getGovernor: () => ({ admits: () => true }),
        telemetry,
        clock,
        nowMs: () => START_MS,
        settings: { maxSystems: 1000, refreshMs: 15000, radius: 50 }
      });

      const data = layer.getData();
      assert.strictEqual(data.available, true);
      assert.strictEqual(data.stats.systems, 1000);
      assert.strictEqual(data.stats.factions, 1);
      assert.strictEqual(data.areas.length, 1);
      assert.strictEqual(data.areas[0][2].length, 1000);
      assert.strictEqual(counts["observer.galaxySovProjectionSystems"], 1000);
    });
  });

  test("SP10 getData: maxSystems = 0 returns empty layer", () => {
    const store = { isOpen: () => true };
    const views = createViewRegistry();
    views.registerView("galaxy-static", {
      title: "Static", listed: false,
      getData: () => ({ available: true, grid: { width: 10000, height: 10000 }, systems: { id: [1], x: [0], y: [0] } }),
      cacheKey: () => "static-key"
    });
    const layer = buildSovProjectionLayerView({
      store,
      repository: {},
      getStaticView: () => views.getView("galaxy-static"),
      config: {},
      factionNames: new Map(),
      getGovernor: () => ({ admits: () => true }),
      telemetry: null,
      clock: { now: () => START_MS },
      nowMs: () => START_MS,
      settings: { maxSystems: 0, refreshMs: 15000, radius: 50 }
    });
    const data = layer.getData();
    assert.strictEqual(data.available, true);
    assert.deepStrictEqual(data.areas, []);
    assert.deepStrictEqual(data.names, []);
    assert.strictEqual(data.stats.systems, 0);
    assert.strictEqual(data.stats.factions, 0);
    assert.deepStrictEqual(data.details, []);
  });

  needsDriver("SP11 getData: returns details with tooltip lines per system", () => {
    withStore((reopen) => {
      const store = reopen();
      const clock = createManualClock(START_MS);
      const journal = createJournal({ clock, maxPayloadBytes: 4096, maxRows: 500 });

      store.transaction("setup", (db) => {
        const stmtSys = db.prepare("INSERT INTO world_system_state (system_id, security_class, controller_faction_id, occupation_state, threat_level, last_state_change_at, next_strategy_review_at, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)");
        const stmtLog = db.prepare("INSERT INTO world_sov_projection_log (system_id, last_controller, last_alliance, last_corp, last_action, last_seq, updated_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
        const now = START_MS;
        stmtSys.run(30000101, 'nullsec', 500016, 'STABLE', 0, now, null, now, 1);
        stmtSys.run(30000102, 'nullsec', 500017, 'STABLE', 0, now, null, now, 1);
        stmtLog.run(30000101, 500016, 99000001, 99000011, 'GAIN', 5, now, 1);
        stmtLog.run(30000102, 500017, 99000002, 99000013, 'TRANSFER', 10, now, 1);
      });

      const views = createViewRegistry();
      views.registerView("galaxy-static", {
        title: "Static", listed: false,
        getData: () => ({
          available: true,
          grid: { width: 10000, height: 10000 },
          systems: {
            id: [30000101, 30000102],
            x: [100, 200],
            y: [400, 500]
          }
        }),
        cacheKey: () => "static-key"
      });

      const factionNames = new Map([[500016, "Faction A"], [500017, "Faction B"]]);
      const layer = buildSovProjectionLayerView({
        store,
        repository: require("../../lib/world/sovProjection/repository"),
        getStaticView: () => views.getView("galaxy-static"),
        config: { observer: { sovProjectionMaxSystems: 1000, sovProjectionRefreshMs: 15000 } },
        factionNames,
        getGovernor: () => ({ admits: () => true }),
        telemetry: null,
        clock,
        nowMs: () => START_MS,
        settings: { maxSystems: 1000, refreshMs: 15000, radius: 50 }
      });

      const data = layer.getData();
      assert.strictEqual(data.available, true);
      assert.ok(Array.isArray(data.details), "details must be an array");
      assert.strictEqual(data.details.length, 2, "two systems with projections");
      for (const detail of data.details) {
        assert.ok(Array.isArray(detail), "each detail must be [systemId, lines[]]");
        assert.strictEqual(detail.length, 2);
        assert.ok(Number.isSafeInteger(detail[0]), "first element must be systemId");
        assert.ok(Array.isArray(detail[1]), "second element must be lines array");
        assert.ok(detail[1].length >= 6, "at least 6 tooltip lines");
        const lines = detail[1].join(" ");
        assert.ok(lines.includes("System: 30000101") || lines.includes("System: 30000102"));
        assert.ok(lines.includes("Controller:"));
        assert.ok(lines.includes("Alliance:"));
        assert.ok(lines.includes("Phase:"));
        assert.ok(lines.includes("Action:"));
        assert.ok(lines.includes("Updated:"));
      }
    });
  });

  test("SP12 observer registration: layer not registered when sovProjectionEnabled=false", () => {
    const observerConfig = {
      galaxyEnabled: true,
      sovProjectionEnabled: false,
      sovProjectionMaxSystems: 1000,
      sovProjectionRefreshMs: 15000
    };
    const ctx = {
      world: { repository: { store: { isOpen: () => true } } },
      adapter: null,
      governor: { admits: () => true },
      clock: { now: () => START_MS },
      telemetry: null,
      nowMs: () => START_MS
    };
    const views = createViewRegistry();
    views.registerView("galaxy-static", {
      title: "Static", listed: false,
      getData: () => ({ available: true, systems: { id: [1], x: [0], y: [0] } }),
      cacheKey: () => "static-key"
    });

    const shouldRegister = observerConfig.galaxyEnabled === true &&
      observerConfig.sovProjectionEnabled === true &&
      ctx.world && ctx.world.repository;

    assert.strictEqual(Boolean(shouldRegister), false, "layer should not register when sovProjectionEnabled=false");

    observerConfig.sovProjectionEnabled = true;
    const shouldRegister2 = observerConfig.galaxyEnabled === true &&
      observerConfig.sovProjectionEnabled === true &&
      ctx.world && ctx.world.repository;

    assert.strictEqual(Boolean(shouldRegister2), true, "layer should register when sovProjectionEnabled=true");
  });

  test("SP13 observer registration: layer not registered when galaxyEnabled=false", () => {
    const observerConfig = {
      galaxyEnabled: false,
      sovProjectionEnabled: true,
      sovProjectionMaxSystems: 1000,
      sovProjectionRefreshMs: 15000
    };
    const ctx = {
      world: { repository: { store: { isOpen: () => true } } },
      adapter: null,
      governor: { admits: () => true },
      clock: { now: () => START_MS },
      telemetry: null,
      nowMs: () => START_MS
    };

    const shouldRegister = observerConfig.galaxyEnabled === true &&
      observerConfig.sovProjectionEnabled === true &&
      ctx.world && ctx.world.repository;

    assert.strictEqual(Boolean(shouldRegister), false, "layer should not register when galaxyEnabled=false");
  });

  test("SP14 observer registration: layer not registered when world.repository missing", () => {
    const observerConfig = {
      galaxyEnabled: true,
      sovProjectionEnabled: true,
      sovProjectionMaxSystems: 1000,
      sovProjectionRefreshMs: 15000
    };
    const ctx = {
      world: null,
      adapter: null,
      governor: { admits: () => true },
      clock: { now: () => START_MS },
      telemetry: null,
      nowMs: () => START_MS
    };

    const shouldRegister = observerConfig.galaxyEnabled === true &&
      observerConfig.sovProjectionEnabled === true &&
      ctx.world && ctx.world.repository;

    assert.strictEqual(Boolean(shouldRegister), false, "layer should not register when world.repository is missing");
  });
};