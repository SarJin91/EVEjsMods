"use strict";

const assert = require("node:assert");
const path = require("node:path");
const config = require("../../config");
const { createJournal } = require("../../lib/persistence/journal");
const { startTrade } = require("../../lib/economy/trade");
const { createViewRegistry } = require("../../lib/observer/views");
const { startGraph } = require("../../lib/graph");
const { readStaticMapFrom } = require("../../lib/adapter/staticMap");
const { readTradePricesFrom } = require("../../lib/adapter/marketPrices");
const { quote } = require("../../lib/economy/trade/pricing");
const { rawWorld, loadSecurityBand } = require("../graph/fixtures/staticMap.fixture");
const { harness: H } = require("../battle/settlement.test");
const { createFakeTradeAdapter } = require("../_support/fakeTradeAdapter");

const driver = H.loadDriver();
const MOD_DIR = path.join(__dirname, "..", "..");
const DEFAULTS = config.resolveConfig({ modDir: MOD_DIR, env: {} }).config;
const F = 500019;

function realGraphFacade() {
  const queue = [];
  const band = loadSecurityBand();
  const started = startGraph({ config: { graph: { buildWarnMs: 250, routeCacheSize: 16, routeMaxJumps: 40 } },
    adapter: { readStaticMap: () => readStaticMapFrom({ ensureLoaded: () => rawWorld() }, band) },
    logger: { log() {} }, defer: (fn) => { queue.push(fn); return { cancel() {} }; } });
  assert.ok(started.ok, JSON.stringify(started));
  for (const fn of queue.splice(0)) fn();
  assert.strictEqual(started.graph.getGraph().ok, true, "graph ready");
  assert.strictEqual(typeof started.graph.getRegionForSystem, "undefined", "real facade has no getRegionForSystem");
  return started.graph;
}

function priceSeam() {
  const marketDaemon = {
    call: async (method) => (method === "GetOrders" ? { buys: [{ price: 5 }], sells: [{ price: 7 }] } : []),
  };
  const industryPricing = { resolveAdjustedAverageTypePrice: () => 6 };
  return (spec) => readTradePricesFrom(marketDaemon, industryPricing, spec);
}

function switchableSeam() {
  const ctl = { mode: "ok" };
  const marketDaemon = {
    call: async (method, args) => {
      if (ctl.mode === "down") throw new Error("market daemon RPC not ready");
      if (method !== "GetOrders") return [];
      if (ctl.mode === "partial") {
        if (args.type_id === 35) throw new Error("timeout");
        return args.type_id === 34 ? { buys: [{ price: 5 }], sells: [{ price: 7 }] } : { buys: [{ price: 5 }], sells: [] };
      }
      return { buys: [{ price: 5 }], sells: [{ price: 7 }] };
    },
  };
  const industryPricing = { resolveAdjustedAverageTypePrice: () => 6 };
  return { ctl, readTradePrices: (spec) => readTradePricesFrom(marketDaemon, industryPricing, spec) };
}

function boot(opened, adapter, graph, tradeOverrides = {}) {
  const shared = H.sharedOf();
  const views = createViewRegistry();
  const timers = [];
  const journal = createJournal({ clock: shared.clock, maxPayloadBytes: 16384, maxRows: 500 });
  const cfg = { ...DEFAULTS, trade: { ...DEFAULTS.trade, enabled: true, hullOffersEnabled: false, ...tradeOverrides } };
  const started = startTrade({ config: cfg, persistence: { ok: true, store: opened.store, journal },
    clock: shared.clock, ids: shared.ids, views, adapter, logger: { log() {} },
    getStations: () => ({ getMode: () => "ready" }), getGraph: () => graph,
    setTimer: (fn) => { const t = { fn, cancelled: false, cancel() { t.cancelled = true; } }; timers.push(t); return t; } });
  assert.ok(started.ok, JSON.stringify(started));
  assert.strictEqual(started.trade.getMode(), "run");
  const firePass = async () => {
    const t = timers.filter((x) => !x.cancelled).pop();
    assert.ok(t, "executor armed");
    t.cancelled = true;
    await t.fn();
  };
  return { trade: started.trade, view: views.getView("trade"), shared, firePass };
}

module.exports = ({ test, skip }) => {
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  needsDriver("PR1 real graph facade: one pass fills the price cache, panel shows it, quote type:34 ok",
    () => H.withStore(driver, async (reopen) => {
      const opened = reopen();
      const adapter = { ...createFakeTradeAdapter(), readTradePrices: priceSeam() };
      const { trade, view, shared, firePass } = boot(opened, adapter, realGraphFacade());
      const keyBefore = view.cacheKey();
      await firePass();

      const st = trade.getStatus().executor.prices;
      assert.strictEqual(st.refreshed, 1, JSON.stringify(st));
      assert.strictEqual(st.failed, 0, JSON.stringify(st));
      assert.strictEqual(st.lastRefusal, null);
      assert.strictEqual(st.lastStored, 7, "all mineral types stored");
      assert.strictEqual(trade.getPriceCache().getStatus().entries, 7);
      assert.deepStrictEqual(trade.getPriceCache().peek(34, shared.clock.now()),
        { bidMilli: 5000, askMilli: 7000, baseMilli: 6000, origin: "local" });

      assert.notStrictEqual(view.cacheKey(), keyBefore, "price refresh invalidates the panel");
      const data = view.getData();
      assert.strictEqual(data.available, true, JSON.stringify(data));
      assert.ok(data.executor && data.executor.state === "running", "panel executor status");
      assert.strictEqual(data.priceRefresh.lastRefreshAt, shared.clock.now());

      const q = opened.store.transaction("test.review", (db) => trade.readForReview(db, F,
        { stations: [], at: shared.clock.now(), limit: 10 }));
      assert.ok(q.ok && q.value.ok, JSON.stringify(q));
      assert.strictEqual(q.value.trade.quotes["type:34"].ok, true, JSON.stringify(q.value.trade.quotes));
      assert.strictEqual(trade.getStatus().counters.quoteNoPrice, 0);
      trade.stop();
    }));

  needsDriver("PR2 refused refresh: reason in executor status and panel, cache empty",
    () => H.withStore(driver, async (reopen) => {
      const opened = reopen();
      const refusing = { ...createFakeTradeAdapter(), readTradePrices: () => ({ ok: false, reason: "SEAM_UNAVAILABLE",
        detail: "marketDaemonClient" }) };
      const a = boot(opened, refusing, realGraphFacade());
      await a.firePass();
      const st = a.trade.getStatus().executor.prices;
      assert.strictEqual(st.lastRefusal, "SEAM_UNAVAILABLE");
      assert.strictEqual(st.lastRefusalDetail, "marketDaemonClient");
      assert.deepStrictEqual(st.failuresByReason, { SEAM_UNAVAILABLE: 1 });
      assert.strictEqual(a.trade.getPriceCache().getStatus().entries, 0);
      const data = a.view.getData();
      assert.strictEqual(data.priceRefresh.lastRefusal, "SEAM_UNAVAILABLE");
      a.trade.stop();

      const b = boot(opened, createFakeTradeAdapter(), realGraphFacade());
      await b.firePass();
      assert.deepStrictEqual(b.trade.getStatus().executor.prices.failuresByReason, { PRICE_SEAM_MISSING: 1 });
      b.trade.stop();
    }));

  needsDriver("PR3 daemon throws on every call -> MARKET_UNREACHABLE, cache kept, retry after priceRetryMs",
    () => H.withStore(driver, async (reopen) => {
      const opened = reopen();
      const seam = switchableSeam();
      const RETRY = 120000;
      const { trade, shared, firePass } = boot(opened, { ...createFakeTradeAdapter(), readTradePrices: seam.readTradePrices },
        realGraphFacade(), { priceRetryMs: RETRY, priceRefreshMs: 1800000 });
      const t0 = shared.clock.now();
      await firePass();
      const good = trade.getPriceCache().peek(34, t0);
      assert.ok(good && good.askMilli === 7000, "first refresh stored");

      seam.ctl.mode = "down";
      shared.clock.advance(1800000);
      await firePass();
      let st = trade.getStatus().executor.prices;
      assert.strictEqual(st.lastRefusal, "MARKET_UNREACHABLE", JSON.stringify(st));
      assert.strictEqual(st.refreshed, 1);
      assert.strictEqual(st.nextAttemptAt, shared.clock.now() + RETRY, "retry after priceRetryMs");
      assert.deepStrictEqual(trade.getPriceCache().getStatus().newestAt, t0, "cache not overwritten");
      assert.deepStrictEqual(trade.getPriceCache().peek(34, shared.clock.now()), good);

      const seq = st.seq;
      shared.clock.advance(RETRY - 1);
      await firePass();
      assert.strictEqual(trade.getStatus().executor.prices.seq, seq, "no attempt before priceRetryMs");
      seam.ctl.mode = "ok";
      shared.clock.advance(1);
      await firePass();
      st = trade.getStatus().executor.prices;
      assert.strictEqual(st.seq, seq + 1);
      assert.strictEqual(st.lastRefusal, null);
      assert.strictEqual(st.refreshed, 2);
      assert.strictEqual(st.nextAttemptAt, shared.clock.now() + 1800000, "after success: priceRefreshMs");
      trade.stop();
    }));

  needsDriver("PR4 partial read: types without ask not stored, others stored, read errors reported",
    () => H.withStore(driver, async (reopen) => {
      const opened = reopen();
      const seam = switchableSeam();
      seam.ctl.mode = "partial";
      const { trade, shared, firePass } = boot(opened, { ...createFakeTradeAdapter(), readTradePrices: seam.readTradePrices },
        realGraphFacade());
      await firePass();
      const st = trade.getStatus().executor.prices;
      assert.strictEqual(st.lastRefusal, null, JSON.stringify(st));
      assert.strictEqual(st.lastStored, 1);
      assert.strictEqual(st.lastNoAsk, 6);
      assert.strictEqual(st.lastReadErrors, 1);
      assert.strictEqual(trade.getPriceCache().getStatus().entries, 1);
      assert.strictEqual(trade.getPriceCache().peek(35, shared.clock.now()), null, "failed type not stored base-only");
      assert.strictEqual(trade.getPriceCache().peek(36, shared.clock.now()), null, "bid-only type not stored");
      trade.stop();
    }));

  test("PR5 quote without a market ask is NO_PRICE; with ask never above the ask cap", () => {
    const p = { premiumPermille: 1100, askCapPermille: 980, maxUnitPriceMilli: 1e12 };
    assert.deepStrictEqual(quote({ bidMilli: null, askMilli: null, baseMilli: 9000 }, p), { ok: false, reason: "NO_PRICE" });
    assert.deepStrictEqual(quote({ bidMilli: 5000, askMilli: null, baseMilli: 9000 }, p), { ok: false, reason: "NO_PRICE" });
    assert.deepStrictEqual(quote({ bidMilli: 5000, askMilli: 0, baseMilli: 9000 }, p), { ok: false, reason: "NO_PRICE" });
    const q = quote({ bidMilli: null, askMilli: 7000, baseMilli: 9000 }, p);
    assert.ok(q.ok && q.unitMilli === 6860 && q.capped === true && q.source === "base", JSON.stringify(q));
  });
};
