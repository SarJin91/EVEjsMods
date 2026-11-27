"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const config = require("../../config");
const { createJournal } = require("../../lib/persistence/journal");
const { openStore } = require("../../lib/persistence/store");
const { LATEST_SCHEMA_VERSION, MIGRATIONS } = require("../../lib/persistence/migrations");
const { createBudgetRepository } = require("../../lib/economy/trade/budgetRepository");
const { createTradeService } = require("../../lib/economy/trade/tradeService");
const { startTrade, createUnavailableTrade } = require("../../lib/economy/trade");
const { OPEN_OFFER_STATES } = require("../../lib/economy/trade/schema");
const { createViewRegistry } = require("../../lib/observer/views");
const { harness: H } = require("../battle/settlement.test");
const { createFakeTradeAdapter } = require("../_support/fakeTradeAdapter");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const DEFAULTS = config.resolveConfig({ modDir: MOD_DIR, env: {} }).config;
const F = 500019;
const SMALL = Object.freeze({ trade: { enabled: true, iskPerResourceUnit: 1000, iskBudgetCap: 5000 } });

function bootBudget(opened, shared, cfg = SMALL) {
  const journal = createJournal({ clock: shared.clock, maxPayloadBytes: 16384, maxRows: 500 });
  const budgets = createBudgetRepository({ journal, clock: shared.clock });
  const service = createTradeService({ budgets, config: cfg, clock: shared.clock });
  const tx = (fn) => {
    const r = opened.store.transaction("test", fn);
    assert.ok(r.ok, JSON.stringify(r));
    return r.value;
  };
  return { journal, budgets, service, tx };
}

module.exports = ({ test, skip }) => {
  test("TB0 config trade.* (defaults P1/P2/P6, warnings), unavailable stub, start gates", () => {
    assert.deepStrictEqual([DEFAULTS.trade.enabled, DEFAULTS.trade.iskPerResourceUnit, DEFAULTS.trade.iskBudgetCap],
      [true, 50000, 50000000000]);
    const on = config.resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_TRADE_ENABLED: "1",
      EVEJS_LNE_UPKEEP_ENABLED: "0" } });
    assert.ok(on.warnings.some((w) => w.startsWith("trade.enabled with upkeep.enabled=false")), on.warnings.join("\n"));
    assert.ok(!config.resolveConfig({ modDir: MOD_DIR, env: {} }).warnings.some((w) => w.startsWith("trade.")));
    const stub = createUnavailableTrade("TRADE_DISABLED", "disabled_by_config");
    assert.deepStrictEqual([stub.getMode(), stub.tradeReady({}, F, { npcStations: 3 }),
      stub.fundFromUpkeepInTx({}, { factionId: F, units: 1, paidUntilTo: 0 }, "k").reason],
    ["off", { ready: false, reason: "TRADE_OFF", headroomIsk: 0 }, "TRADE_DISABLED"]);
    const noStations = { ...DEFAULTS, trade: { ...DEFAULTS.trade, enabled: true },
      stations: { ...DEFAULTS.stations, enabled: false } };
    assert.deepStrictEqual(startTrade({ config: noStations }), { ok: false, reason: "disabled_by_config" });
    const withStations = { ...DEFAULTS, trade: { ...DEFAULTS.trade, enabled: true } };
    assert.deepStrictEqual(startTrade({ config: withStations, persistence: null }), { ok: false, reason: "dependency_disabled:persistence" });
  });

  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  needsDriver("TB1 migration 20 from zero (STRICT, indexes, open-state literal) and 19 -> 20", () => H.withStore(
    driver, async (reopen) => {
      const opened = reopen();
      assert.ok(LATEST_SCHEMA_VERSION >= 20);
      assert.deepStrictEqual([opened.schemaVersion, MIGRATIONS[19].name], [LATEST_SCHEMA_VERSION, "world_trade"]);
      const master = opened.store.transaction("t", (db) => db.prepare(`SELECT type, name, sql FROM sqlite_master
        WHERE tbl_name IN ('world_trade_budgets', 'world_trade_offers') ORDER BY type, name`).all()).value;
      const tables = master.filter((m) => m.type === "table");
      assert.deepStrictEqual(tables.map((m) => m.name), ["world_trade_budgets", "world_trade_offers"]);
      for (const t of tables) assert.ok(/\)\s*STRICT$/.test(t.sql), t.name);
      assert.deepStrictEqual(master.filter((m) => m.type === "index" && m.sql).map((m) => m.name),
        ["world_trade_offers_contract", "world_trade_offers_ended", "world_trade_offers_faction_open",
          "world_trade_offers_issuer_open", "world_trade_offers_market", "world_trade_offers_market_order",
          "world_trade_offers_station_item_open", "world_trade_offers_supplier"]);
      for (const name of ["world_trade_offers_faction_open", "world_trade_offers_station_item_open"]) {
        const sql = master.find((m) => m.name === name).sql;
        const literal = /state IN \(([^)]*)\)/.exec(sql)[1].split(",").map((s) => s.trim().replace(/'/g, ""));
        assert.deepStrictEqual(literal, [...OPEN_OFFER_STATES], name);
      }

      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lne-m20-"));
      const file = path.join(tmp, "world.sqlite");
      const open = (migrations) => {
        const o = openStore({ filePath: file, openDatabase: (f) => new driver.Database(f), exclusiveLock: true,
          busyTimeoutMs: 0, maxRowsPerTransaction: 500, maxWriteMsPerPass: 5, randomSeed: () => 1, migrations });
        assert.ok(o.ok, JSON.stringify(o));
        return o;
      };
      const stores = [];
      try {
        const old = open(MIGRATIONS.slice(0, 19));
        old.store.close("upgrade");
        const up = open(MIGRATIONS.slice(0, 20));
        stores.push(up.store);
        assert.deepStrictEqual([up.schemaVersion, up.applied], [20, 1]);
        const n = up.store.transaction("t", (db) => [
          db.prepare("SELECT count(*) AS n FROM world_trade_budgets").get().n,
          db.prepare("SELECT count(*) AS n FROM world_trade_offers").get().n]).value;
        assert.deepStrictEqual(n, [0, 0]);
      } finally {
        for (const s of stores) s.close("test");
        fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      }
    }, { fresh: true }));

  needsDriver("TB2/TB3 budget: insert v1, update v2, cut to the cap, full = 0 units, duplicate key "
    + "BUDGET_NEGATIVE, bad input; tradeReady TRADE_OFF / NO_NPC_STATION / BUDGET_FULL / ready", () => H.withStore(
    driver, async (reopen) => {
      const shared = H.sharedOf();
      const env = bootBudget(reopen(), shared);
      const { budgets, service, tx } = env;
      const fund = (units, key) => tx((db) => service.fundFromUpkeepInTx(db, { factionId: F, units,
        paidUntilTo: 3600000 }, key));
      const row = () => tx((db) => budgets.getBudget(db, F)).budget;

      assert.deepStrictEqual(tx((db) => service.tradeReady(db, F, { npcStations: 1 })),
        { ready: true, reason: null, headroomIsk: 5000 });
      assert.strictEqual(tx((db) => service.tradeReady(db, F, { npcStations: 0 })).reason, "NO_NPC_STATION");

      assert.deepStrictEqual(fund(2, "u:1:trade"), { ok: true, fundedUnits: 2, fundedIsk: 2000, capped: false });
      assert.deepStrictEqual([row().availableIsk, row().reservedIsk, row().fundedUnitsTotal, row().version],
        [2000, 0, 2, 1]);
      assert.deepStrictEqual(fund(1, "u:2:trade"), { ok: true, fundedUnits: 1, fundedIsk: 1000, capped: false });
      assert.strictEqual(row().version, 2);
      assert.deepStrictEqual(fund(5, "u:3:trade"), { ok: true, fundedUnits: 2, fundedIsk: 2000, capped: true });
      const full = row();
      assert.deepStrictEqual([full.availableIsk + full.reservedIsk, full.fundedTotal, full.version], [5000, 5000, 3]);
      assert.deepStrictEqual(fund(4, "u:4:trade"), { ok: true, fundedUnits: 0, fundedIsk: 0, capped: true });
      assert.strictEqual(row().version, 3);
      assert.deepStrictEqual(tx((db) => service.tradeReady(db, F, { npcStations: 2 })),
        { ready: false, reason: "BUDGET_FULL", headroomIsk: 0 });
      assert.deepStrictEqual(fund(2, "u:1:trade"), { ok: false, reason: "NESTED_KEY_REUSED", detail: "u:1:trade" });
      assert.strictEqual(fund(9, "u:1:trade").reason, "IDEMPOTENCY_CONFLICT", "another payload under the key");

      assert.deepStrictEqual(tx((db) => budgets.adjustInDb(db, F, { availableDelta: -6000, reservedDelta: 6000 },
        shared.clock.now())), { ok: false, reason: "BUDGET_NEGATIVE", detail: String(F) });
      assert.strictEqual(row().version, 3);
      const moved = tx((db) => budgets.adjustInDb(db, F, { availableDelta: -1000, reservedDelta: 1000 },
        shared.clock.now()));
      assert.deepStrictEqual([moved.ok, moved.budget.availableIsk, moved.budget.reservedIsk, moved.budget.version],
        [true, 4000, 1000, 4]);
      assert.strictEqual(tx((db) => budgets.adjustInDb(db, 500001, { availableDelta: 1, reservedDelta: 0 }, 0)).reason,
        "NO_BUDGET");

      assert.strictEqual(fund(-1, "u:5:trade").reason, "TRADE_INVALID_INPUT");
      assert.strictEqual(tx((db) => budgets.adjustInDb(db, F, { availableDelta: 0.5, reservedDelta: 0 }, 0)).reason,
        "TRADE_INVALID_INPUT");
      assert.strictEqual(budgets.getBudget(null, F).reason, "TX_REQUIRED");

      service.stop();
      assert.deepStrictEqual(tx((db) => service.tradeReady(db, F, { npcStations: 1 })),
        { ready: false, reason: "TRADE_OFF", headroomIsk: 0 });
      assert.strictEqual(service.getMode(), "off");
    }));

  needsDriver("TB5 panel trade: budgets per faction with the cap / headroom; closed store -> available:false",
    () => H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const opened = reopen();
      const views = createViewRegistry();
      const cfg = { ...DEFAULTS, trade: { ...DEFAULTS.trade, enabled: true } };
      const journal = createJournal({ clock: shared.clock, maxPayloadBytes: 16384, maxRows: 500 });
      const adapter = createFakeTradeAdapter();
      const started = startTrade({ config: cfg, persistence: { ok: true, store: opened.store, journal },
        clock: shared.clock, ids: shared.ids, views, adapter });
      assert.ok(started.ok, JSON.stringify(started));
      const trade = started.trade;
      const r = opened.store.transaction("test", (db) => trade.fundFromUpkeepInTx(db, { factionId: F, units: 64,
        paidUntilTo: 0 }, "tb5:trade"));
      assert.ok(r.ok && r.value.ok, JSON.stringify(r));
      trade.count("funded");
      const view = views.getView("trade");
      const data = view.getData();
      assert.strictEqual(data.available, true, JSON.stringify(data));
      const fac = data.factions[0];
      assert.strictEqual(fac.faction, F);
      assert.strictEqual(fac.availableIsk, 64 * 50000);
      assert.strictEqual(fac.reservedIsk, 0);
      assert.strictEqual(fac.capIsk, 50000000000);
      assert.strictEqual(fac.headroomIsk, 50000000000 - 64 * 50000);
      assert.strictEqual(fac.fundedUnitsTotal, 64);
      assert.strictEqual(fac.fundedTotal, 64 * 50000);
      assert.strictEqual(fac.spentTotal, 0);
      assert.strictEqual(fac.releasedTotal, 0);
      assert.strictEqual(fac.lastFundedAt, shared.clock.now());
      assert.deepStrictEqual(fac.offers, []);
      assert.deepStrictEqual(fac.recentOffers, []);
      assert.strictEqual(fac.reservedMismatch, false);
      assert.deepStrictEqual(fac.priceCache, { entries: 0, source: "none", newestAt: null, prices: {} });
      assert.strictEqual(data.counters.funded, 1);
      assert.ok(typeof view.cacheKey() === "string");
      opened.store.close("tb5");
      assert.deepStrictEqual(view.getData(), { available: false, reason: "STORE_CLOSED" });
      trade.stop();
      assert.strictEqual(views.getView("trade"), null, "unregistered at stop");
    }));

  needsDriver("Standing handler cleanup: inner catch (executor.start throws via setTradeNudge) -> TRADE_START_FAILED, handler unregistered, deliveryStanding stopped", () => H.withStore(
    driver, async (reopen) => {
      const shared = H.sharedOf();
      const views = createViewRegistry();
      const journal = createJournal({ clock: shared.clock, maxPayloadBytes: 16384, maxRows: 500 });
      const adapter = createFakeTradeAdapter();
      const opened = reopen();

      const cfg = {
        ...DEFAULTS,
        trade: { ...DEFAULTS.trade, enabled: true, standingGrantEnabled: true },
        modules: { ...DEFAULTS.modules, strategy: { enabled: true } },
        stations: { ...DEFAULTS.stations, enabled: true },
        scheduler: { ...DEFAULTS.scheduler, enabled: true, maxAttempts: 3, retryBaseMs: 100, retryMaxMs: 1000, maxOpenEvents: 1000, maxPayloadBytes: 16384, intervalMs: 1000, claimBatchSize: 10, catchUpLagMs: 5000, sliceMs: 50 },
      };

      const { startScheduler } = require("../../lib/scheduler");
      const startedScheduler = startScheduler({
        config: cfg, persistence: { ok: true, store: opened.store, journal }, clock: shared.clock, ids: shared.ids,
        logger: { log: () => {} }
      });
      assert.ok(startedScheduler.ok, JSON.stringify(startedScheduler));
      const realScheduler = startedScheduler.scheduler;

      let unregisterCalls = 0;
      const trackingScheduler = {
        enqueue: (...args) => realScheduler.enqueue(...args),
        enqueueMany: (...args) => realScheduler.enqueueMany(...args),
        claimDue: (...args) => realScheduler.claimDue(...args),
        complete: (...args) => realScheduler.complete(...args),
        retryOrQuarantine: (...args) => realScheduler.retryOrQuarantine(...args),
        findByKey: (...args) => realScheduler.findByKey(...args),
        purgeDone: (...args) => realScheduler.purgeDone(...args),
        getStatus: (...args) => realScheduler.getStatus(...args),
        stop: (...args) => realScheduler.stop(...args),
        runPass: (...args) => realScheduler.runPass(...args),
        startPasses: (...args) => realScheduler.startPasses(...args),
        registerHandler: (eventType, fn, opts) => {
          const result = realScheduler.registerHandler(eventType, fn, opts);
          if (result && result.ok && typeof result.unregister === "function") {
            const originalUnregister = result.unregister;
            return {
              ok: true,
              unregister: () => {
                unregisterCalls += 1;
                return originalUnregister();
              }
            };
          }
          return result;
        }
      };

      const throwingNudgeAdapter = {
        ...adapter,
        checkTradeSeams() { return { ok: true }; },
        checkStandingWrite() { return { ok: true }; },
        applyStandingGrant() { return { ok: true }; },
        readCharacterStanding() { return { ok: true, standing: 0 }; },
        checkStandingRead() { return { ok: true }; },
        setTradeNudge() { throw new Error("SET_NUDGE_THROW"); },
        installTradeHooks() { return { ok: true }; },
        uninstallTradeHooks() { return { ok: true }; },
      };

      const started = require("../../lib/economy/trade").startTrade({
        config: cfg,
        persistence: { ok: true, store: opened.store, journal },
        clock: shared.clock,
        ids: shared.ids,
        views,
        adapter: throwingNudgeAdapter,
        scheduler: trackingScheduler,
        setTimer: () => ({ cancel() {}, hasRef: () => false }),
      });

      assert.strictEqual(started.ok, false);
      assert.strictEqual(started.reason, "TRADE_START_FAILED");
      assert.ok(started.detail.includes("SET_NUDGE_THROW"), started.detail);
      assert.strictEqual(unregisterCalls, 1, "standing handler unregister should be called exactly once in inner catch");
    }));

  needsDriver("NOTE-2b standing handler cleanup: inner catch (executor.start throws via installTradeHooks) -> TRADE_START_FAILED, handler unregistered, deliveryStanding stopped", () => H.withStore(
    driver, async (reopen) => {
      const shared = H.sharedOf();
      const views = createViewRegistry();
      const journal = createJournal({ clock: shared.clock, maxPayloadBytes: 16384, maxRows: 500 });
      const adapter = createFakeTradeAdapter();
      const opened = reopen();

      const cfg = {
        ...DEFAULTS,
        trade: { ...DEFAULTS.trade, enabled: true, standingGrantEnabled: true },
        modules: { ...DEFAULTS.modules, strategy: { enabled: true } },
        stations: { ...DEFAULTS.stations, enabled: true },
        scheduler: { ...DEFAULTS.scheduler, enabled: true, maxAttempts: 3, retryBaseMs: 100, retryMaxMs: 1000, maxOpenEvents: 1000, maxPayloadBytes: 16384, intervalMs: 1000, claimBatchSize: 10, catchUpLagMs: 5000, sliceMs: 50 },
      };

      const { startScheduler } = require("../../lib/scheduler");
      const startedScheduler = startScheduler({
        config: cfg, persistence: { ok: true, store: opened.store, journal }, clock: shared.clock, ids: shared.ids,
        logger: { log: () => {} }
      });
      assert.ok(startedScheduler.ok, JSON.stringify(startedScheduler));
      const realScheduler = startedScheduler.scheduler;

      let unregisterCalls = 0;
      const trackingScheduler = {
        enqueue: (...args) => realScheduler.enqueue(...args),
        enqueueMany: (...args) => realScheduler.enqueueMany(...args),
        claimDue: (...args) => realScheduler.claimDue(...args),
        complete: (...args) => realScheduler.complete(...args),
        retryOrQuarantine: (...args) => realScheduler.retryOrQuarantine(...args),
        findByKey: (...args) => realScheduler.findByKey(...args),
        purgeDone: (...args) => realScheduler.purgeDone(...args),
        getStatus: (...args) => realScheduler.getStatus(...args),
        stop: (...args) => realScheduler.stop(...args),
        runPass: (...args) => realScheduler.runPass(...args),
        startPasses: (...args) => realScheduler.startPasses(...args),
        registerHandler: (eventType, fn, opts) => {
          const result = realScheduler.registerHandler(eventType, fn, opts);
          if (result && result.ok && typeof result.unregister === "function") {
            const originalUnregister = result.unregister;
            return {
              ok: true,
              unregister: () => {
                unregisterCalls += 1;
                return originalUnregister();
              }
            };
          }
          return result;
        }
      };

      const throwingHookAdapter = {
        ...adapter,
        checkTradeSeams() { return { ok: true }; },
        checkStandingWrite() { return { ok: true }; },
        applyStandingGrant() { return { ok: true }; },
        readCharacterStanding() { return { ok: true, standing: 0 }; },
        checkStandingRead() { return { ok: true }; },
        setTradeNudge() { return { ok: true }; },
        installTradeHooks() { throw new Error("INSTALL_HOOKS_THROW"); },
        uninstallTradeHooks() { return { ok: true }; },
      };

      const started = require("../../lib/economy/trade").startTrade({
        config: cfg,
        persistence: { ok: true, store: opened.store, journal },
        clock: shared.clock,
        ids: shared.ids,
        views,
        adapter: throwingHookAdapter,
        scheduler: trackingScheduler,
        setTimer: () => ({ cancel() {}, hasRef: () => false }),
      });

      assert.strictEqual(started.ok, false);
      assert.strictEqual(started.reason, "TRADE_START_FAILED");
      assert.ok(started.detail.includes("INSTALL_HOOKS_THROW"), started.detail);
      assert.strictEqual(unregisterCalls, 1, "standing handler unregister should be called exactly once in inner catch (executor.start)");
    }));

  needsDriver("NOTE-2d standing handler cleanup: outer catch (views.registerView throws) -> TRADE_START_FAILED, handler unregistered, deliveryStanding stopped", () => H.withStore(
    driver, async (reopen) => {
      const shared = H.sharedOf();
      const journal = createJournal({ clock: shared.clock, maxPayloadBytes: 16384, maxRows: 500 });
      const adapter = createFakeTradeAdapter();
      const opened = reopen();

      const cfg = {
        ...DEFAULTS,
        trade: { ...DEFAULTS.trade, enabled: true, standingGrantEnabled: true },
        modules: { ...DEFAULTS.modules, strategy: { enabled: true } },
        stations: { ...DEFAULTS.stations, enabled: true },
        scheduler: { ...DEFAULTS.scheduler, enabled: true, maxAttempts: 3, retryBaseMs: 100, retryMaxMs: 1000, maxOpenEvents: 1000, maxPayloadBytes: 16384, intervalMs: 1000, claimBatchSize: 10, catchUpLagMs: 5000, sliceMs: 50 },
      };

      const { startScheduler } = require("../../lib/scheduler");
      const startedScheduler = startScheduler({
        config: cfg, persistence: { ok: true, store: opened.store, journal }, clock: shared.clock, ids: shared.ids,
        logger: { log: () => {} }
      });
      assert.ok(startedScheduler.ok, JSON.stringify(startedScheduler));
      const realScheduler = startedScheduler.scheduler;

      let unregisterCalls = 0;
      const trackingScheduler = {
        enqueue: (...args) => realScheduler.enqueue(...args),
        enqueueMany: (...args) => realScheduler.enqueueMany(...args),
        claimDue: (...args) => realScheduler.claimDue(...args),
        complete: (...args) => realScheduler.complete(...args),
        retryOrQuarantine: (...args) => realScheduler.retryOrQuarantine(...args),
        findByKey: (...args) => realScheduler.findByKey(...args),
        purgeDone: (...args) => realScheduler.purgeDone(...args),
        getStatus: (...args) => realScheduler.getStatus(...args),
        stop: (...args) => realScheduler.stop(...args),
        runPass: (...args) => realScheduler.runPass(...args),
        startPasses: (...args) => realScheduler.startPasses(...args),
        registerHandler: (eventType, fn, opts) => {
          const result = realScheduler.registerHandler(eventType, fn, opts);
          if (result && result.ok && typeof result.unregister === "function") {
            const originalUnregister = result.unregister;
            return {
              ok: true,
              unregister: () => {
                unregisterCalls += 1;
                return originalUnregister();
              }
            };
          }
          return result;
        }
      };

      const throwingViews = {
        registerView() { throw new Error("REGISTER_VIEW_THROW"); },
        getView() { return null; },
        listViews() { return []; },
        listMapLayers() { return []; },
      };

      const workingAdapter = {
        ...adapter,
        checkTradeSeams() { return { ok: true }; },
        checkStandingWrite() { return { ok: true }; },
        applyStandingGrant() { return { ok: true }; },
        readCharacterStanding() { return { ok: true, standing: 0 }; },
        checkStandingRead() { return { ok: true }; },
        setTradeNudge() { return { ok: true }; },
        installTradeHooks() { return { ok: true }; },
        uninstallTradeHooks() { return { ok: true }; },
      };

      const started = require("../../lib/economy/trade").startTrade({
        config: cfg,
        persistence: { ok: true, store: opened.store, journal },
        clock: shared.clock,
        ids: shared.ids,
        views: throwingViews,
        adapter: workingAdapter,
        scheduler: trackingScheduler,
        setTimer: () => ({ cancel() {}, hasRef: () => false }),
      });

      assert.strictEqual(started.ok, false);
      assert.strictEqual(started.reason, "TRADE_START_FAILED");
      assert.ok(started.detail.includes("REGISTER_VIEW_THROW"), started.detail);
      assert.strictEqual(unregisterCalls, 1, "standing handler unregister should be called exactly once in outer catch");
    }));

};
