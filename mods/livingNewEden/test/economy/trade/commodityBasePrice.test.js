"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const config = require("../../../config");
const { basePriceRefs } = require("../../../lib/economy/trade/priceMerge");
const { buildTradeCatalog } = require("../../../lib/economy/trade/tradeCatalog");
const { readTradePricesFrom } = require("../../../lib/adapter/marketPrices");
const { createExternalPrices } = require("../../../lib/economy/trade/externalPrices");
const { createOfferRepository } = require("../../../lib/economy/trade/offerRepository");
const { createBudgetRepository } = require("../../../lib/economy/trade/budgetRepository");
const { createTradeExecutor } = require("../../../lib/economy/trade/tradeExecutor");
const { createTradeService } = require("../../../lib/economy/trade/tradeService");
const { createJournal } = require("../../../lib/persistence/journal");
const { createFakeTradeAdapter } = require("../../_support/fakeTradeAdapter");
const { harness: H } = require("../../battle/settlement.test");
const { findCompose, readCompose } = require("../../config/composeKeys.test");

const MOD_DIR = path.resolve(__dirname, "..", "..", "..");
const DEFAULTS = config.resolveConfig({ modDir: MOD_DIR, env: {} }).config;
const F = 500019;
const MOON = 16633;
const PI = 2312;
const BASE_ISK = 1000;
const REJECTED = { code: "MARKET_DAEMON_RPC_REJECTED" };
const CONNECT = { code: "MARKET_DAEMON_CONNECT_FAILED" };

const catalog = buildTradeCatalog({
  commodities: { take: [{ typeId: PI, kind: "pi" }, { typeId: MOON, kind: "moon" }], truncated: [] },
  commodityFacts: { ok: true, facts: new Map([PI, MOON].map((id) => [id, { typeId: id, name: `T${id}`, volume: 0.05,
    portionSize: 1 }])) },
  commodityOffersEnabled: true,
});

function priceReader(fail = {}, own = null) {
  const ownSells = (t) => (own && own.sells[t] !== undefined ? [{ order_id: own.orderId, price: own.sells[t] }] : []);
  const daemon = {
    call: async (method, args) => {
      if (method === "GetRegionBest") {
        if (fail.region) throw fail.region;
        return own && own.regionBest
          ? Object.entries(own.sells).map(([t, p]) => ({ type_id: Number(t), best_ask_price: p })) : [];
      }
      if (fail[args.type_id]) throw fail[args.type_id];
      if (args.type_id === MOON || args.type_id === PI || args.type_id === 35) {
        return { buys: [], sells: ownSells(args.type_id) };
      }
      return { buys: [{ price: 5 }], sells: [{ price: 7 }, ...ownSells(args.type_id)] };
    },
  };
  const pricing = { resolveAdjustedAverageTypePrice: (t) => (t === MOON || t === PI ? BASE_ISK : 6) };
  return (spec) => readTradePricesFrom(daemon, pricing, spec);
}

function tradeCfg(over = {}) {
  return { ...DEFAULTS.trade, enabled: true, commodityOffersEnabled: true, commodityBasePriceEnabled: true,
    wtsEnabled: true, buyOrdersEnabled: false, marketSellOrdersEnabled: false, ...over };
}

async function pass(opened, shared, { over = {}, fail = {}, snap = null, own = null, runs = 1 } = {}) {
  const journal = createJournal({ clock: shared.clock, maxPayloadBytes: 16384, maxRows: 500 });
  const budgets = createBudgetRepository({ journal, clock: shared.clock });
  const repo = createOfferRepository({ journal, budgets, ids: shared.ids, clock: shared.clock, catalog });
  const offers = own ? { ...repo, listOpenMarketOrderIds: () => ({ ok: true, orderIds: [String(own.orderId)] }) } : repo;
  const cfg = { trade: tradeCfg(over) };
  const service = createTradeService({ budgets, offers, config: cfg, clock: shared.clock, catalog, telemetry: null,
    logger: { log() {} }, sellSeamsOk: () => true,
    getExtraction: () => ({ readNeeds: () => ({ ok: true, needs: [], stations: [] }) }) });
  const counts = {};
  const telemetry = { count: (n, v) => { counts[n] = (counts[n] || 0) + v; } };
  const externalPrices = snap === null ? null : { maybeRefresh: () => ({ started: false, reason: "NOT_DUE" }),
    consumeChanged: () => false, peekSnapshot: () => ({ fetchedAt: shared.clock.now(), prices: snap }) };
  const executor = createTradeExecutor({ store: opened.store, journal, offers, budgets,
    adapter: { ...createFakeTradeAdapter(), readTradePrices: priceReader(fail, own) },
    priceCache: service.getPriceCache(), config: cfg, clock: shared.clock, mode: "run", catalog, externalPrices,
    getStations: () => ({ getMode: () => "ready", getStatus: () => ({ mode: "ready" }), getStation: () => null,
      listStationsInSystem: () => [] }),
    getGovernor: () => ({ admits: () => true }), factionNames: new Map([[F, "Sansha"]]), telemetry,
    logger: { log() {} } });
  const asks = [];
  for (let i = 0; i < runs; i += 1) {
    shared.clock.advance(i === 0 ? 10000 : cfg.trade.priceRefreshMs);
    await executor.runPass();
    const e = service.getPriceCache().peek(MOON, shared.clock.now());
    asks.push(e ? e.askMilli : null);
  }
  executor.stop();
  const now = shared.clock.now();
  const cache = service.getPriceCache();
  return { st: executor.getStatus().prices, peek: (t) => cache.peek(t, now), cache, service, counts, now, asks };
}

const origin = (r, t) => { const e = r.peek(t); return e ? e.origin : null; };

module.exports = ({ test, skip }) => {
  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  test("CBP1 basePriceRefs: base x permille, null / 0 base, local ask, above maxUnitPriceMilli -> null", () => {
    const P = { askPermille: 1200, maxUnitPriceMilli: 1e12 };
    assert.deepStrictEqual(basePriceRefs({ bidMilli: null, askMilli: null, baseMilli: 1000 }, P),
      { bidMilli: null, askMilli: 1200, baseMilli: 1000, origin: "base" });
    assert.strictEqual(basePriceRefs({ bidMilli: null, askMilli: null, baseMilli: 1001 }, P).askMilli, 1202, "ceil");
    assert.strictEqual(basePriceRefs({ bidMilli: null, askMilli: null, baseMilli: null }, P), null);
    assert.strictEqual(basePriceRefs({ bidMilli: null, askMilli: null, baseMilli: 0 }, P), null);
    assert.strictEqual(basePriceRefs({ bidMilli: null, askMilli: 900, baseMilli: 1000 }, P), null, "local ask");
    assert.strictEqual(basePriceRefs(null, P), null);
    assert.strictEqual(basePriceRefs({ bidMilli: null, askMilli: null, baseMilli: 1000 },
      { askPermille: 1200, maxUnitPriceMilli: 1199 }), null, "above maxUnitPriceMilli");
  });

  needsDriver("CBP2 refreshPrices: commodities without an ask get base entries (flag on), quotes buy < WTS; flag off "
    + "or commodity off = as before", () => H.withStore(driver, async (reopen) => {
    const opened = reopen();
    const shared = H.sharedOf();
    const on = await pass(opened, shared);
    assert.strictEqual(on.st.lastBase, 2, JSON.stringify(on.st));
    assert.strictEqual(on.st.lastBaseMissing, 0);
    assert.strictEqual(on.st.lastNoAsk, 1, "mineral 35 without an ask");
    assert.strictEqual(on.st.lastRefusal, null);
    for (const t of [MOON, PI]) {
      assert.deepStrictEqual(on.peek(t), { bidMilli: null, askMilli: 1200000, baseMilli: 1000000, origin: "base" });
    }
    assert.strictEqual(on.counts["trade.priceMergedBase"], 2);
    const r = opened.store.transaction("cbp2.review", (db) => on.service.readForReview(db, F,
      { stations: [], at: on.now, limit: 10 }));
    assert.ok(r.ok && r.value.ok, JSON.stringify(r));
    const c = r.value.trade.commodity;
    assert.ok(c && c.ok, JSON.stringify(c));
    for (const key of [`type:${MOON}`, `type:${PI}`]) {
      const q = c.quotes[key];
      const s = c.sellQuotes[key];
      assert.ok(q && q.ok && s && s.ok, JSON.stringify(c));
      assert.deepStrictEqual([q.source, q.unitMilli, q.capped], ["base", 1100000, false]);
      assert.deepStrictEqual([s.source, s.refMilli, s.unitMilli], ["ask", 1200000, 1176000]);
      assert.ok(q.unitMilli < s.unitMilli, "faction buys below its WTS price");
    }
    const sc = on.service.getStatus().counters;
    assert.deepStrictEqual([sc.commodityQuoteNoPrice, sc.commoditySellNoPrice], [0, 0]);

    for (const over of [{ commodityBasePriceEnabled: false }, { commodityOffersEnabled: false }]) {
      const off = await pass(opened, shared, { over });
      assert.deepStrictEqual([off.peek(MOON), off.peek(PI)], [null, null], JSON.stringify(over));
      assert.strictEqual(off.st.lastNoAsk, 3, "35 + 2 commodities as before");
      assert.ok(!("lastBase" in off.st) && !("lastBaseMissing" in off.st), JSON.stringify(off.st));
      assert.strictEqual(off.counts["trade.priceMergedBase"], undefined);
    }
  }));

  needsDriver("CBP3 per type cleanness: REJECTED type without entry, other commodity base / external, flag off "
    + "abort no base, mineral never base", () => H.withStore(driver, async (reopen) => {
    const opened = reopen();
    const shared = H.sharedOf();
    const read = await priceReader({ [MOON]: REJECTED })({ typeIds: [...catalog.priceTypeIds],
      refRegionId: 10000002, regionIds: [10000002], maxRegions: 8 });
    assert.deepStrictEqual([read.ok, read.errors, read.aborted, read.failedTypeIds, read.regionErrors],
      [true, 1, null, [MOON], 0]);

    const a = await pass(opened, shared, { fail: { [MOON]: REJECTED } });
    assert.strictEqual(a.peek(MOON), null, "failed type: unknown ask, no entry");
    assert.strictEqual(origin(a, PI), "base");
    assert.strictEqual(a.peek(35), null, "mineral without an ask never base");
    assert.deepStrictEqual([a.st.lastBase, a.st.lastReadErrors], [1, 1]);

    const snap = new Map([[PI, { bidMilli: 900000, askMilli: 1100000 }]]);
    const b = await pass(opened, shared, { fail: { [MOON]: REJECTED }, snap });
    assert.strictEqual(origin(b, PI), "external", "clean type: Jita entry despite errors > 0");
    assert.strictEqual(b.peek(MOON), null);
    const bOff = await pass(opened, shared, { fail: { [MOON]: REJECTED }, snap, over: { commodityBasePriceEnabled: false } });
    assert.strictEqual(bOff.peek(PI), null, "flag off: (errors > 0 -> no Jita-only entry)");

    const c = await pass(opened, shared, { fail: { region: CONNECT } });
    assert.deepStrictEqual([c.peek(MOON), c.peek(PI), c.st.lastBase], [null, null, 0]);
    assert.strictEqual(c.st.lastReadAborted, "MARKET_DAEMON_CONNECT_FAILED");
  }));

  needsDriver("CBP4 order: Jita before base; Jita refused by DEVIATION -> base", () => H.withStore(driver,
    async (reopen) => {
      const opened = reopen();
      const shared = H.sharedOf();
      const ext = await pass(opened, shared, { snap: new Map([[MOON, { bidMilli: 900000, askMilli: 1100000 }]]) });
      assert.deepStrictEqual(ext.peek(MOON), { bidMilli: 900000, askMilli: 1100000, baseMilli: 1000000,
        origin: "external" });
      assert.strictEqual(origin(ext, PI), "base");
      assert.deepStrictEqual([ext.st.lastExternal, ext.st.lastBase], [1, 1]);
      const dev = await pass(opened, shared, { snap: new Map([[MOON, { bidMilli: 50000000, askMilli: 60000000 }]]) });
      assert.strictEqual(origin(dev, MOON), "base");
      assert.deepStrictEqual([dev.st.lastExternalRejected, dev.st.lastBase], [1, 2]);
    }));

  needsDriver("CBP6 own sell orders: 2 refreshes with the faction's own moon sell order (GetOrders and "
    + "GetRegionBest) keep the base ask; mineral own sells and flag off as before", () => H.withStore(driver,
    async (reopen) => {
      const opened = reopen();
      const shared = H.sharedOf();
      const sells = { [MOON]: 1176, 34: 6 };
      for (const regionBest of [false, true]) {
        const r = await pass(opened, shared, { own: { orderId: 9001, sells, regionBest }, runs: 2 });
        assert.deepStrictEqual(r.asks, [1200000, 1200000], `regionBest=${regionBest}: ask unchanged`);
        assert.strictEqual(origin(r, MOON), "base");
        assert.strictEqual(r.st.refreshed, 2);
        assert.strictEqual(r.peek(34).askMilli, 6000, "mineral: own sell still the ask (unchanged)");
      }
      const off = await pass(opened, shared, { own: { orderId: 9001, sells, regionBest: false }, runs: 2,
        over: { commodityBasePriceEnabled: false } });
      assert.deepStrictEqual(off.asks, [1176000, 1176000], "flag off: sells as before");
    }));

  test("CBP5 externalPrices.load: file without a required type -> fetch now; without requiredTypeIds -> NOT_DUE; W286",
    () => {
      const NOW = 10000000;
      const text = JSON.stringify({ schemaVersion: 1, source: "fuzzwork", stationId: 60003760, fetchedAt: NOW - 1000,
        prices: { 34: { bidMilli: 4000, askMilli: 5000 } } });
      const fakeFs = { statSync: () => ({ size: text.length }), readFileSync: () => text };
      const logs = [];
      const make = (extra) => createExternalPrices({ config: { trade: { externalPriceEnabled: true } },
        clock: { now: () => NOW }, filePath: "/x/external-prices.json", typeIds: [34, MOON], fs: fakeFs,
        logger: { log: (l) => logs.push(l) },
        adapter: { fetchExternalPrices: () => new Promise(() => {}) }, ...extra });
      const req = make({ requiredTypeIds: [MOON] });
      req.load(NOW);
      assert.strictEqual(req.getStatus().coverageMissing, 1);
      assert.ok(logs.some((l) => /snapshot lacks 1 commodity types - fetch now/.test(l)), logs.join("\n"));
      assert.deepStrictEqual(req.maybeRefresh(NOW), { started: true });
      req.stop();
      const plain = make({});
      plain.load(NOW);
      assert.ok(!("coverageMissing" in plain.getStatus()));
      assert.deepStrictEqual(plain.maybeRefresh(NOW), { started: false, reason: "NOT_DUE" });
      plain.stop();

      const resolve = (e) => config.resolveConfig({ modDir: MOD_DIR, env: e });
      const w286 = (e) => resolve(e).warnings.some((w) => /\(W286\)$/.test(w));
      const on = { EVEJS_LNE_TRADE_ENABLED: "1", EVEJS_LNE_TRADE_COMMODITY_OFFERS_ENABLED: "1" };
      assert.strictEqual(resolve(on).config.modules.strategy.enabled, true, "strategy on by default");
      assert.strictEqual(w286({}), false, "commodities off = no W286");
      assert.strictEqual(w286(on), true, "defaults: 135 x 512 > 65536");
      assert.strictEqual(w286({ ...on, EVEJS_LNE_TRADE_EXTERNAL_PRICE_MAX_RESPONSE_BYTES: "262144" }), false);
      assert.strictEqual(w286({ ...on, EVEJS_LNE_TRADE_EXTERNAL_PRICE_ENABLED: "0" }), false);
      const w287 = (e) => resolve(e).warnings.some((w) => /price spiral.*\(W287\)$/.test(w));
      const sells = { ...on, EVEJS_LNE_TRADE_WTS_ENABLED: "1", EVEJS_LNE_TRADE_MARKET_SELL_ORDERS_ENABLED: "1" };
      const baseOff = { ...sells, EVEJS_LNE_TRADE_COMMODITY_BASE_PRICE_ENABLED: "0" };
      assert.strictEqual(w287(baseOff), true, "flag off + commodity sell orders = W287");
      assert.strictEqual(w287(sells), false, "base price on (default) = no W287");
      assert.strictEqual(w287({ ...baseOff, EVEJS_LNE_TRADE_MARKET_SELL_ORDERS_ENABLED: "0" }), false, "no sell orders");
      assert.strictEqual(w287({ ...baseOff, EVEJS_LNE_TRADE_COMMODITY_OFFERS_ENABLED: "0" }), false, "no commodities");
      const d = DEFAULTS.trade;
      assert.deepStrictEqual([d.commodityBasePriceEnabled, d.commodityBasePriceAskPermille], [true, 1200]);
    });

  const composeFile = findCompose();
  if (!composeFile) {
    skip("CBP5 compose keys", "compose.yaml not found above the mod (Docker image)");
  } else {
    test("CBP5 compose: the 3 keys have ${NAME:-} lines (empty = mod default)", () => {
      const text = fs.readFileSync(composeFile, "utf8");
      const { env } = readCompose(composeFile);
      const keys = ["trade.commodityBasePriceEnabled", "trade.commodityBasePriceAskPermille",
        "trade.externalPriceMaxResponseBytes"];
      const rows = config.SCHEMA.filter((row) => keys.includes(row.key));
      assert.strictEqual(rows.length, 3);
      for (const row of rows) {
        assert.ok(Object.prototype.hasOwnProperty.call(env, row.env), `missing ${row.env}`);
        assert.ok(text.includes(`${row.env}: \${${row.env}:-}`), `no \${${row.env}:-} line`);
      }
    });
  }
};
