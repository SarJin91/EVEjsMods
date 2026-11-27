"use strict";

const assert = require("node:assert");
const path = require("node:path");

const { createJournal } = require("../../lib/persistence/journal");
const { createBudgetRepository } = require("../../lib/economy/trade/budgetRepository");
const { createOfferRepository } = require("../../lib/economy/trade/offerRepository");
const { createTradeExecutor } = require("../../lib/economy/trade/tradeExecutor");
const { runRefundSweep } = require("../../lib/economy/trade/refundSweep");
const { marketSpendIsk } = require("../../lib/economy/trade/marketRules");
const { createFakeTradeAdapter } = require("../_support/fakeTradeAdapter");
const FLAG_HANGAR = 4;
const FLAG_CORP_DELIVERIES = 62;
const { harness: H } = require("../battle/settlement.test");
const S = require("../../lib/economy/trade/schema");

const MOD_DIR = path.resolve(__dirname, "..", "..");

const F = 500019;
const CORP = 999999;
const OTHER_CORP = 888888;
const SYSTEM = 30000001;
const TYPE_ID = 34;
const QUANTITY = 1000;
const AT = 1000000;
const SCAN_MS = 3600000;
let clockNow = AT;
const CLOCK = { now: function() { return clockNow; } };
let idCounter = 0;
const IDS = { next: function(p) { return p + "_" + (++idCounter); } };

function insertStation(store, stationId, npcStationId) {
  const r = store.transaction("test.insertStation", function(db) {
    return db.prepare(
      "INSERT INTO world_stations (station_id, kind, npc_station_id, type_id, structure_family, system_id," +
      "  owner_faction_id, owner_corporation_id, state, state_until_at, name, position_json, origin," +
      "  evejs_item_id, destroyed_at, created_at, updated_at, version)" +
      " VALUES (?, 'npc', ?, 35834, 'Sansha', ?, ?, ?, 'ONLINE', NULL, 'MI Station', '{\"x\":0,\"y\":0,\"z\":0}', 'seed'," +
      "  NULL, NULL, ?, ?, 1)"
    ).run(stationId, npcStationId, SYSTEM, F, CORP, AT, AT);
  });
  assert.ok(r.ok, JSON.stringify(r));
}

function makeConfig(trade, extra) {
  trade = trade || {};
  extra = extra || {};
  return {
    trade: Object.assign({
      enabled: true, contractsEnabled: true, cleanupOnDisable: false, walletAccountKey: 1006,
      contractTtlMs: 259200000, executorPollMs: 60000, maxIssuesPerPass: 2, maxPollsPerPass: 16,
      maxClosesPerPass: 4, issueTimeoutMs: 1800000, priceRegionId: 10000002, maxPriceRegions: 8,
      priceRefreshMs: 1800000, maxIntakesPerPass: 2, intakeGraceMs: 600000, maxOrphansPerPass: 2,
      intakeMaxRetries: 100,
      buyOrdersEnabled: true,
      buyOrderWalletAccountKey: 1005,
      buyOrderTtlMs: 259200000,
      buyOrderDurationDays: 7,
      buyOrderMinVolume: 1,
      maxBuyOrderPollsPerPass: 16,
      maxBuyOrderClosesPerPass: 4,
      maxBuyOrderOrphansPerPass: 2,
      maxRefundSweepsPerPass: 2,
      marketOrphanScanMs: SCAN_MS,
      marketOrphanScanPage: 64,
    }, trade),
    ...extra,
  };
}

function servicesOf(opened) {
  const journal = createJournal({ clock: CLOCK, maxPayloadBytes: 16384, maxRows: 500 });
  const budgets = createBudgetRepository({ journal, clock: CLOCK });
  const offers = createOfferRepository({ journal, budgets, ids: IDS, clock: CLOCK });
  const tx = function(fn) { const r = opened.store.transaction("test", fn); assert.ok(r.ok, JSON.stringify(r)); return r.value; };
  return { journal: journal, budgets: budgets, offers: offers, tx: tx };
}

function setup(opened) {
  const env = servicesOf(opened);
  env.tx(function(db) {
    return env.budgets.fundInTx(db, { factionId: F, units: 100000, paidUntilTo: AT, iskPerUnit: 1000,
      capIsk: 1000000000, at: AT }, "fund:1");
  });
  return env;
}

function createOffer(tx, offers, offerId, stationId, overrides) {
  overrides = overrides || {};
  const spec = Object.assign({
    offerId: offerId, factionId: F, stationId: stationId, systemId: SYSTEM, issuerCorporationId: CORP, itemKind: "mineral",
    itemKey: "type:34", typeId: TYPE_ID, quantity: QUANTITY, unitPriceMilli: 1100, iskTotal: QUANTITY * 1100,
    refPriceMilli: 1000, capPriceMilli: 1960, priceSource: "bid", state: "PLANNED", stateSeq: 0, endReason: null,
    contractId: null, acceptorCharacterId: null, deliveredQuantity: 0, createdAt: AT, expiresAt: AT + 259200000,
    updatedAt: AT, endedAt: null, version: 1, at: AT,
    channel: "market",
  }, overrides);
  const r = tx(function(db) {
    return offers.createOfferInTx(db, spec, "ik:" + offerId + ":offer:" + offerId + ":" + stationId);
  });
  assert.ok(r.ok && !r.duplicate, "create offer " + offerId + ": " + JSON.stringify(r));
  return r.offer;
}

function step(tx, offers, offerId, from, to, version, patch, reason) {
  const r = tx(function(db) {
    return offers.transitionOfferInTx(db, Object.assign({ offerId: offerId, expectedVersion: version, from: from, to: to, reason: reason || "",
      at: AT + version * 1000 }, patch ? { patch: patch } : {}), S.transitionKey(offerId, version, to));
  });
  assert.ok(r.ok, JSON.stringify(r));
  return r.offer;
}

function toIssuing(tx, offers, seed, stationId, marketOrderId) {
  const offerId = createOffer(tx, offers, seed, stationId).offerId;
  step(tx, offers, offerId, S.PLANNED, S.ISSUING, 1, { expiresAt: AT + 259200000 });
  return offerId;
}

function toOpen(tx, offers, seed, stationId, marketOrderId) {
  const offerId = toIssuing(tx, offers, seed, stationId, marketOrderId);
  if (marketOrderId) {
    step(tx, offers, offerId, S.ISSUING, S.OPEN, 2, { marketOrderId: marketOrderId });
  } else {
    tx(function(db) { return db.prepare("UPDATE world_trade_offers SET channel = 'contract' WHERE offer_id = ?").run(offerId); });
    step(tx, offers, offerId, S.ISSUING, S.OPEN, 2, { contractId: 1000 + idCounter });
  }
  return offerId;
}

function toAccepted(tx, offers, seed, stationId, marketOrderId, filledQuantity) {
  const offerId = toOpen(tx, offers, seed, stationId, marketOrderId);
  step(tx, offers, offerId, S.OPEN, S.ACCEPTED, 3, marketOrderId
    ? { filledQuantity: filledQuantity, acceptorCharacterId: null } : { acceptorCharacterId: null });
  return offerId;
}

function toDelivered(tx, offers, seed, stationId, marketOrderId, filledQuantity) {
  const offerId = toAccepted(tx, offers, seed, stationId, marketOrderId, filledQuantity);
  step(tx, offers, offerId, S.ACCEPTED, S.INTAKE, 4, {});
  step(tx, offers, offerId, S.INTAKE, S.DELIVERED, 5, {}, "DELIVERED");
  return offerId;
}

function stationsFacade() {
  return Object.freeze({
    getMode: function() { return "ready"; },
    getStatus: function() { return { mode: "ready" }; },
    getStation: function() { return null; },
    listStationsInSystem: function() { return []; },
  });
}

function executorOf(opened, env, cfg, extra) {
  extra = extra || {};
  return createTradeExecutor({
    store: opened.store,
    journal: env.journal,
    offers: extra.offers || env.offers,
    budgets: env.budgets,
    adapter: env.adapter,
    priceCache: { put: function() {}, peek: function() { return null; } },
    config: cfg,
    clock: CLOCK,
    mode: "run",
    getStations: stationsFacade,
    getGovernor: function() { return { admits: function() { return true; } }; },
    factionNames: new Map([[F, "Sansha"]]),
    telemetry: extra.telemetry || null,
    logger: extra.logger || { log: function() {} },
    setTimer: extra.setTimer,
    getGraph: function() { return { getRegionForSystem: function() { return 10000002; } }; },
  });
}

function spy(adapter, name) {
  const calls = [];
  const real = adapter[name];
  adapter[name] = function(arg) { calls.push(arg); return real.apply(adapter, arguments); };
  return calls;
}

function sweepCalls(walletCalls) {
  return walletCalls.filter(function(s) { return String(s.commandId).startsWith("lne:trade:msweep:"); })
    .map(function(s) { return [s.commandId, s.deltaIsk]; });
}

function sweepRows(store) {
  const r = store.transaction("test.sweepRows", function(db) {
    return db.prepare("SELECT idempotency_key AS key, state, error, payload FROM world_event_journal" +
      " WHERE idempotency_key LIKE 'trade:msweep:%' ORDER BY journal_id").all()
      .map(function(row) { return { key: row.key, state: row.state, error: row.error, amountIsk: JSON.parse(row.payload).amountIsk }; });
  });
  assert.ok(r.ok, JSON.stringify(r));
  return r.value;
}

function counter() {
  const counts = {};
  return { counts: counts, count: function(name, v) { counts[name] = (counts[name] || 0) + v; } };
}

const KEY = function(n) { return "trade:msweep:" + CORP + ":" + n; };
const CMD = function(n) { return "lne:trade:msweep:" + CORP + ":" + n; };

module.exports = function(_ref) {
  var test = _ref.test;
  var driver = H.loadDriver();

  test("TS3.1 market orphan: record of a DELIVERED offer -> detach + cancel once (stations facade, no getAll)", function() {
    return H.withStore(driver, async function(reopen) {
      const opened = reopen();
      insertStation(opened.store, "mi-st-1", 60004001);
      const env = setup(opened);
      const adapter = createFakeTradeAdapter();
      env.adapter = adapter;
      const detaches = spy(adapter, "tradeMarketDetachEscrow");
      const cancels = spy(adapter, "tradeMarketCancel");
      const telemetry = counter();
      const executor = executorOf(opened, env, makeConfig({ maxRefundSweepsPerPass: 0 }), { telemetry });

      const offerId = toDelivered(env.tx, env.offers, "ts3-1", "mi-st-1", "1001", 600);
      adapter._addEscrow("1001", offerId, CORP, 60004001, TYPE_ID, 110000, 400);

      clockNow = AT + 10000;
      let res = await executor.runPass();
      assert.ok(res.ok, JSON.stringify(res));
      assert.strictEqual(res.errors, 0);
      assert.ok(!adapter._state.escrows.has("1001"), "record detached");
      assert.deepStrictEqual(detaches, [{ orderId: "1001", offerId }]);
      assert.deepStrictEqual(cancels, ["1001"]);
      assert.strictEqual(telemetry.counts["trade.marketOrphans"], 1);

      clockNow += 10000;
      res = await executor.runPass();
      assert.strictEqual(res.errors, 0);
      assert.strictEqual(cancels.length, 1, "cancelled once");
      executor.stop();
    });
  });

  test("TS3.2 market orphan: record of a DELIVERED offer with a fill saga -> untouched", function() {
    return H.withStore(driver, async function(reopen) {
      const opened = reopen();
      insertStation(opened.store, "mi-st-1", 60004001);
      const env = setup(opened);
      const adapter = createFakeTradeAdapter();
      env.adapter = adapter;
      const detaches = spy(adapter, "tradeMarketDetachEscrow");
      const cancels = spy(adapter, "tradeMarketCancel");
      const executor = executorOf(opened, env, makeConfig({ maxRefundSweepsPerPass: 0 }));

      const offerId = toDelivered(env.tx, env.offers, "ts3-2", "mi-st-1", "1002", 600);
      adapter._addEscrow("1002", offerId, CORP, 60004001, TYPE_ID, 110000, 400, { orderID: "1002" });

      clockNow = AT + 10000;
      const res = await executor.runPass();
      assert.ok(res.ok, JSON.stringify(res));
      assert.strictEqual(res.errors, 0);
      assert.ok(adapter._state.escrows.get("1002").pendingFill, "saga record kept");
      assert.deepStrictEqual([detaches.length, cancels.length], [0, 0]);
      executor.stop();
    });
  });

  test("TS3.3 market orphan: record of an ISSUING offer -> untouched", function() {
    return H.withStore(driver, async function(reopen) {
      const opened = reopen();
      insertStation(opened.store, "mi-st-1", 60004001);
      const env = setup(opened);
      const adapter = createFakeTradeAdapter();
      env.adapter = adapter;
      const cancels = spy(adapter, "tradeMarketCancel");
      const detaches = spy(adapter, "tradeMarketDetachEscrow");

      const offerId = toIssuing(env.tx, env.offers, "ts3-3", "mi-st-1", null);
      adapter._addEscrow("1003", offerId, CORP, 60004001, TYPE_ID, 110000, 1000);
      adapter._addCorpOrder(CORP, "1004", 60004001, TYPE_ID, 1000);

      clockNow = AT + 10000;
      const { runOrphanScan } = require("../../lib/economy/trade/marketOrphans");
      const scan = await runOrphanScan({ store: opened.store, offers: env.offers, adapter, config: makeConfig(),
        telemetry: null, logger: { log: function() {} }, getGovernor: null }, true, "0", 0);
      assert.deepStrictEqual([scan.cleaned, scan.errors], [0, 0], JSON.stringify(scan));
      assert.ok(adapter._state.escrows.has("1003"), "record of the ISSUING offer kept");
      assert.deepStrictEqual([cancels, detaches], [[], []]);
    });
  });

  test("TS3.4 market orphan: order without record and without offer -> cancel; foreign corporation never listed", function() {
    return H.withStore(driver, async function(reopen) {
      const opened = reopen();
      insertStation(opened.store, "mi-st-1", 60004001);
      const env = setup(opened);
      const adapter = createFakeTradeAdapter();
      env.adapter = adapter;
      const cancels = spy(adapter, "tradeMarketCancel");
      const listed = spy(adapter, "tradeMarketListCorpOrders");
      const executor = executorOf(opened, env, makeConfig({ maxRefundSweepsPerPass: 0 }));

      toDelivered(env.tx, env.offers, "ts3-4", "mi-st-1", "2000", 600);
      adapter._addCorpOrder(CORP, "2001", 60004001, TYPE_ID, 500);
      adapter._addCorpOrder(OTHER_CORP, "2002", 60004001, TYPE_ID, 500);

      clockNow = AT + 10000;
      const res = await executor.runPass();
      assert.ok(res.ok, JSON.stringify(res));
      assert.strictEqual(res.errors, 0);
      assert.deepStrictEqual(cancels, ["2001"]);
      assert.deepStrictEqual(listed, [CORP], "only the market corporations are listed");
      executor.stop();
    });
  });

  test("TS3.5 market orphan: order of a live (ACCEPTED / OPEN) offer whose record is gone -> untouched", function() {
    return H.withStore(driver, async function(reopen) {
      const opened = reopen();
      insertStation(opened.store, "mi-st-1", 60004001);
      insertStation(opened.store, "mi-st-2", 60004002);
      const env = setup(opened);
      const adapter = createFakeTradeAdapter();
      env.adapter = adapter;
      const cancels = spy(adapter, "tradeMarketCancel");
      const executor = executorOf(opened, env, makeConfig({ maxRefundSweepsPerPass: 0 }));

      const acceptedId = toAccepted(env.tx, env.offers, "ts3-5a", "mi-st-1", "1005", 100);
      adapter._addCorpOrder(CORP, "1005", 60004001, TYPE_ID, 800);

      clockNow = AT + 10000;
      const res = await executor.runPass();
      assert.ok(res.ok, JSON.stringify(res));
      assert.strictEqual(res.errors, 0);
      const live = env.tx((db) => env.offers.getOffer(db, acceptedId)).offer;
      assert.ok(S.OPEN_OFFER_STATES.includes(live.state), live.state);
      assert.deepStrictEqual(cancels, [], "an order of a live offer is never cancelled");
      executor.stop();

      toOpen(env.tx, env.offers, "ts3-5b", "mi-st-2", "1006");
      adapter._addCorpOrder(CORP, "1006", 60004002, TYPE_ID, 800);
      const { runOrphanScan } = require("../../lib/economy/trade/marketOrphans");
      const scan = await runOrphanScan({ store: opened.store, offers: env.offers, adapter, config: makeConfig(),
        telemetry: null, logger: { log: function() {} }, getGovernor: null }, true, "0", 0);
      assert.deepStrictEqual([scan.cleaned, scan.errors, cancels.length], [0, 0, 0], JSON.stringify(scan));
    });
  });

  test("TS3.6 market orphan: cursor - 3 records, budget 2 -> all visited; escrow list and corp RPC once per cycle", function() {
    return H.withStore(driver, async function(reopen) {
      const opened = reopen();
      insertStation(opened.store, "mi-st-1", 60004001);
      const env = setup(opened);
      const adapter = createFakeTradeAdapter();
      env.adapter = adapter;
      const lists = spy(adapter, "tradeMarketListTaggedEscrows");
      const corpLists = spy(adapter, "tradeMarketListCorpOrders");
      const executor = executorOf(opened, env, makeConfig({ marketOrphanScanPage: 8, maxBuyOrderOrphansPerPass: 2,
        maxRefundSweepsPerPass: 0 }));

      const ids = ["3001", "3002", "3003"].map(function(orderId, i) {
        const offerId = toDelivered(env.tx, env.offers, "ts3-6" + i, "mi-st-1", orderId, 600);
        adapter._addEscrow(orderId, offerId, CORP, 60004001, TYPE_ID, 110000, 400);
        return offerId;
      });
      assert.strictEqual(ids.length, 3);

      clockNow = AT + 10000;
      await executor.runPass();
      assert.deepStrictEqual([...adapter._state.escrows.keys()], ["3003"], "pass 1: budget 2");
      clockNow += 60000;
      await executor.runPass();
      assert.strictEqual(adapter._state.escrows.size, 0, "pass 2: cursor continues");
      clockNow += 60000;
      await executor.runPass();
      assert.deepStrictEqual(lists.map(function(s) { return s.afterOrderId; }), ["0", "3002"],
        "pass 3: no escrow clone before marketOrphanScanMs");
      assert.strictEqual(corpLists.length, 0, "budget used up by part (a) in pass 1");

      clockNow += SCAN_MS;
      await executor.runPass();
      assert.strictEqual(lists.length, 3, "new cycle after marketOrphanScanMs");
      assert.deepStrictEqual(corpLists, [CORP], "part (b) once per cycle");
      executor.stop();
    });
  });

  test("TS3.7 market orphan: offer read error is not an orphan", function() {
    return H.withStore(driver, async function(reopen) {
      const opened = reopen();
      insertStation(opened.store, "mi-st-1", 60004001);
      const env = setup(opened);
      const adapter = createFakeTradeAdapter();
      env.adapter = adapter;
      const detaches = spy(adapter, "tradeMarketDetachEscrow");
      const offerId = toOpen(env.tx, env.offers, "ts3-7", "mi-st-1", "4001");
      adapter._addEscrow("4001", offerId, CORP, 60004001, TYPE_ID, 110000, 400);
      const failing = Object.assign({}, env.offers, {
        getOffer: function(tx, id) { return id === offerId ? { ok: false, reason: "TRADE_INVALID_INPUT" } : env.offers.getOffer(tx, id); },
      });
      const executor = executorOf(opened, env, makeConfig({ maxRefundSweepsPerPass: 0 }), { offers: failing });

      clockNow = AT + 10000;
      const res = await executor.runPass();
      assert.ok(res.errors >= 1, JSON.stringify(res));
      assert.deepStrictEqual(detaches, [], "no detach on a read error");
      assert.ok(adapter._state.escrows.has("4001"));
      executor.stop();
    });
  });

  test("TS4.1 new config keys present in SCHEMA and .env.example", function() {
    const config = require("../../config");
    const resolved = config.resolveConfig({ modDir: MOD_DIR, env: {} });
    const cfg = resolved.config;
    assert.ok(cfg.trade.hasOwnProperty("maxBuyOrderOrphansPerPass"), "maxBuyOrderOrphansPerPass");
    assert.ok(cfg.trade.hasOwnProperty("maxRefundSweepsPerPass"), "maxRefundSweepsPerPass");
    assert.ok(cfg.trade.hasOwnProperty("marketOrphanScanMs"), "marketOrphanScanMs");
    assert.ok(cfg.trade.hasOwnProperty("marketOrphanScanPage"), "marketOrphanScanPage");
    assert.ok(cfg.trade.hasOwnProperty("buyOrdersEnabled"), "buyOrdersEnabled");
    assert.ok(cfg.trade.hasOwnProperty("buyOrderWalletAccountKey"), "buyOrderWalletAccountKey");
    assert.strictEqual(cfg.trade.maxBuyOrderOrphansPerPass, 2);
    assert.strictEqual(cfg.trade.maxRefundSweepsPerPass, 2);
    assert.strictEqual(cfg.trade.marketOrphanScanMs, 3600000);
    assert.strictEqual(cfg.trade.marketOrphanScanPage, 64);
    assert.strictEqual(cfg.trade.buyOrdersEnabled, false);
    assert.strictEqual(cfg.trade.buyOrderWalletAccountKey, 1005);
  });

  test("TS4.2 buyOrdersEnabled = false -> sweep and intake work, zero tradeMarketPlace", function() {
    return H.withStore(driver, async function(reopen) {
      const opened = reopen();
      insertStation(opened.store, "mi-st-1", 60004001);
      const env = setup(opened);
      const cfg = makeConfig({ buyOrdersEnabled: false });
      const adapter = createFakeTradeAdapter();
      env.adapter = adapter;
      const executor = executorOf(opened, env, cfg);

      const offerId = toOpen(env.tx, env.offers, "ts4-2", "mi-st-1", "1005");
      adapter._addEscrow("1005", offerId, CORP, 60004001, TYPE_ID, 110000, 800);

      clockNow = AT + 10000;
      const res = await executor.runPass();
      assert.ok(res.ok, JSON.stringify(res));
      assert.strictEqual(res.errors, 0);

      assert.strictEqual(adapter._state.marketPlaceCalls || 0, 0, "tradeMarketPlace not called when buyOrdersEnabled=false");

      executor.stop();
    });
  });

  test("TS4.3 panel shows channel and refund division balance", function() {
    return H.withStore(driver, async function(reopen) {
      const opened = reopen();
      insertStation(opened.store, "mi-st-1", 60004001);
      const env = setup(opened);
      const cfg = makeConfig();
      const adapter = createFakeTradeAdapter();
      env.adapter = adapter;

      const offerId = toOpen(env.tx, env.offers, "ts4-3", "mi-st-1", "2001");
      adapter._addEscrow("2001", offerId, CORP, 60004001, TYPE_ID, 110000, 800);

      adapter._state.wallets.set(CORP, { 1005: 1234567 });

      const { buildTradeView } = require("../../lib/economy/trade/tradeView");
      const view = buildTradeView({
        store: opened.store,
        budgets: env.budgets,
        offers: env.offers,
        clock: CLOCK,
        getStatus: () => ({ state: "running", executor: { marketOrphanScan: { lastScanAt: clockNow } } }),
        getGovernor: () => ({ admits: () => true }),
        factionNames: new Map([[F, "Sansha"]]),
        capIsk: 2000000000,
        adapter: adapter,
        config: cfg,
        getPriceCache: () => ({ put: () => {}, peek: () => null, getStatus: () => ({ entries: 0, source: "none", newestAt: null }) }),
      });

      const data = view.getData();
      assert.ok(data.available);
      assert.ok(Array.isArray(data.factions));
      assert.ok(data.factions.length > 0);
      const faction = data.factions[0];
      assert.ok(faction.offers.length > 0);
      const offer = faction.offers[0];
      assert.ok(offer.hasOwnProperty("channel"));
      assert.ok(offer.hasOwnProperty("marketOrderId"));
      assert.ok(offer.hasOwnProperty("filledQuantity"));
      assert.strictEqual(offer.channel, "market");
      assert.strictEqual(offer.marketOrderId, "2001");

      assert.ok(data.hasOwnProperty("market"));
      assert.ok(Array.isArray(data.market.refundBalances));
      const refundBal = data.market.refundBalances.find((b) => b.corporationId === CORP);
      assert.ok(refundBal, "refund balance for corp");
      assert.ok(typeof refundBal.balanceIsk === "number");
    });
  });

  test("TS4.5 panel shows iskTotal and wallet balances in ISK (no milli scaling)", function() {
    return H.withStore(driver, async function(reopen) {
      const opened = reopen();
      insertStation(opened.store, "mi-st-1", 60004001);
      insertStation(opened.store, "mi-st-2", 60004002);
      const env = setup(opened);
      const adapter = createFakeTradeAdapter();
      const open = createOffer(env.tx, env.offers, "ts4-5-open", "mi-st-1", { unitPriceMilli: 1100000, iskTotal: 1100000 });
      step(env.tx, env.offers, open.offerId, S.PLANNED, S.ISSUING, 1, { expiresAt: AT + 259200000 });
      step(env.tx, env.offers, open.offerId, S.ISSUING, S.OPEN, 2, { marketOrderId: "2005" });
      const done = toDelivered(env.tx, env.offers, "ts4-5-done", "mi-st-2", "2006", QUANTITY);
      adapter._state.wallets.set(CORP, { 1005: 1234567.89 });
      adapter._state.wallets.set(90000001, { 1000: 7654321.5 });
      const { buildTradeView } = require("../../lib/economy/trade/tradeView");
      const view = buildTradeView({
        store: opened.store, budgets: env.budgets, offers: env.offers, clock: { now: () => AT + 86400000 },
        getStatus: () => ({ state: "running", executor: {} }),
        getGovernor: () => ({ admits: () => true }),
        factionNames: new Map([[F, "Sansha"]]), capIsk: 2000000000, adapter: adapter, config: makeConfig(),
        getVirtualCorps: () => ({
          listTradeIssuers: () => ({ ok: true, issuers: [{ slot: 0, corporationId: 98000001, characterId: 90000001 }] }),
          nameOf: () => "Boss Corp",
        }),
      });
      const faction = view.getData().factions[0];
      const row = faction.offers.find((o) => o.offerId === open.offerId);
      assert.ok(row, "open offer row");
      assert.strictEqual(row.iskTotal, 1100000);
      assert.strictEqual(row.unitPriceIsk, 1100);
      const recent = faction.recentOffers.find((o) => o.offerId === done);
      assert.ok(recent, "recent offer row");
      assert.strictEqual(recent.iskTotal, QUANTITY * 1100);
      assert.strictEqual(faction.virtualIssuers[0].transitBalanceIsk, 7654321);
      const refund = view.getData().market.refundBalances.find((b) => b.corporationId === CORP);
      assert.strictEqual(refund.balanceIsk, 1234567);
    });
  });

  test("TS4.4 reset report counts tradeMarketOrdersOpen", function() {
    return H.withStore(driver, async function(reopen) {
      const opened = reopen();
      insertStation(opened.store, "mi-st-1", 60004001);
      insertStation(opened.store, "mi-st-2", 60004002);
      const env = setup(opened);

      const issuingId = toIssuing(env.tx, env.offers, "ts4-4a", "mi-st-1", null);
      const openId = toOpen(env.tx, env.offers, "ts4-4b", "mi-st-2", "3001");

      const offering = env.tx((db) => env.offers.getOffer(db, issuingId)).offer;
      const offerOpen = env.tx((db) => env.offers.getOffer(db, openId)).offer;
      assert.strictEqual(offering.state, "ISSUING");
      assert.strictEqual(offerOpen.state, "OPEN");
      assert.strictEqual(offerOpen.marketOrderId, "3001");
      assert.strictEqual(offerOpen.channel, "market");

      const { planReset } = require("../../lib/persistence/worldReset");
      const planResult = opened.store.transaction("test.plan", (db) => planReset(db));
      assert.ok(planResult.ok, JSON.stringify(planResult));
      const plan = planResult.value;
      assert.ok(typeof plan.game.tradeMarketOrdersOpen === "number");
      assert.strictEqual(plan.game.tradeMarketOrdersOpen, 1, "one market order open (OPEN with market_order_id)");

      const { applyReset } = require("../../lib/persistence/worldReset");
      const NOW = clockNow;
      const resetResult = opened.store.transaction("test.apply", (db) => applyReset(db, plan, { now: NOW }));
      assert.ok(resetResult.ok, JSON.stringify(resetResult));

      const planResult2 = opened.store.transaction("test.plan2", (db) => planReset(db));
      assert.ok(planResult2.ok);
      const plan2 = planResult2.value;
      assert.strictEqual(plan2.game.tradeMarketOrdersOpen, 0, "after reset, no market orders open");
    });
  });

  test("TS1.1 market intake: filledQuantity < quantity, flag 4 used, excess remains", function() {
    return H.withStore(driver, async function(reopen) {
      const opened = reopen();
      insertStation(opened.store, "mi-st-1", 60004001);
      const env = setup(opened);
      const cfg = makeConfig({ intakeGraceMs: 600000 });
      const adapter = createFakeTradeAdapter();
      env.adapter = adapter;
      const executor = executorOf(opened, env, cfg);

      const offerId = toAccepted(env.tx, env.offers, "ts1-1", "mi-st-1", "ord-1001", 60);
      adapter._addHangarStack(CORP, 60004001, 1001, TYPE_ID, 40, FLAG_HANGAR);
      adapter._addHangarStack(CORP, 60004001, 1002, TYPE_ID, 30, FLAG_HANGAR);
      adapter._addHangarStack(CORP, 60004001, 1003, TYPE_ID, 50, FLAG_CORP_DELIVERIES);

      clockNow = AT + 10000;
      const res = await executor.runPass();
      assert.ok(res.ok, JSON.stringify(res));
      assert.strictEqual(res.errors, 0);

      clockNow += 10000;
      const res2 = await executor.runPass();
      assert.ok(res2.ok, JSON.stringify(res2));
      assert.strictEqual(res2.errors, 0);

      const offer = env.tx((db) => env.offers.getOffer(db, offerId)).offer;
      assert.strictEqual(offer.state, S.DELIVERED);
      assert.strictEqual(offer.deliveredQuantity, 60, "deliveredQuantity should be filledQuantity (60)");

      const flag4Stacks = adapter._state.hangarStacks.get(CORP)?.get(60004001);
      if (flag4Stacks) {
        assert.ok(!flag4Stacks.has(1001), "stack 1001 (40) should be voided");
        assert.strictEqual(flag4Stacks.get(1002)?.quantity, 10, "stack 1002 should have 10 remaining (30 - 20)");
        assert.strictEqual(flag4Stacks.get(1003)?.quantity, 50, "stack 1003 (flag 62) should be untouched");
      }
      const flag62Stacks = adapter._state.hangarStacks.get(CORP)?.get(60004001);
      if (flag62Stacks) {
        assert.strictEqual(flag62Stacks.get(1003)?.quantity, 50, "flag 62 stack should be untouched");
      }
      executor.stop();
    });
  });

  test("TS1.2 market intake: restart after first stack -> total delivered exactly once", function() {
    return H.withStore(driver, async function(reopen) {
      const opened = reopen();
      insertStation(opened.store, "mi-st-1", 60004001);
      const env = setup(opened);
      const cfg = makeConfig({ intakeGraceMs: 600000 });
      const adapter = createFakeTradeAdapter();
      env.adapter = adapter;
      const executor = executorOf(opened, env, cfg);

      const offerId = toAccepted(env.tx, env.offers, "ts1-2", "mi-st-1", "ord-1002", 60);
      adapter._addHangarStack(CORP, 60004001, 1001, TYPE_ID, 30, FLAG_HANGAR);
      adapter._addHangarStack(CORP, 60004001, 1002, TYPE_ID, 40, FLAG_HANGAR);

      clockNow = AT + 10000;
      let res = await executor.runPass();
      assert.ok(res.ok);
      assert.strictEqual(res.errors, 0);

      clockNow += 10000;
      const executor2 = executorOf(opened, env, cfg);
      res = await executor2.runPass();
      assert.ok(res.ok, JSON.stringify(res));
      assert.strictEqual(res.errors, 0);

      const offer = env.tx((db) => env.offers.getOffer(db, offerId)).offer;
      assert.strictEqual(offer.state, S.DELIVERED);
      assert.strictEqual(offer.deliveredQuantity, 60, "total delivered should be exactly 60 (filledQuantity)");

      const flag4Stacks = adapter._state.hangarStacks.get(CORP)?.get(60004001);
      if (flag4Stacks) {
        assert.ok(!flag4Stacks.has(1001), "first stack voided");
        assert.strictEqual(flag4Stacks.get(1002)?.quantity, 10, "second stack should have 10 remaining");
      }
      executor2.stop();
    });
  });

  test("TS1.3 contract intake: uses flag 62 (CORP_DELIVERIES), no flag in payload", function() {
    return H.withStore(driver, async function(reopen) {
      const opened = reopen();
      insertStation(opened.store, "mi-st-1", 60004001);
      const env = setup(opened);
      const cfg = makeConfig({ intakeGraceMs: 600000 });
      const adapter = createFakeTradeAdapter();
      env.adapter = adapter;
      const executor = executorOf(opened, env, cfg);

      const offerId = toAccepted(env.tx, env.offers, "ts1-3", "mi-st-1", null, 70);
      env.tx((db) => db.prepare("UPDATE world_trade_offers SET channel = ?, quantity = ? WHERE offer_id = ?").run("contract", 70, offerId));
      adapter._addHangarStack(CORP, 60004001, 1001, TYPE_ID, 40, FLAG_CORP_DELIVERIES);
      adapter._addHangarStack(CORP, 60004001, 1002, TYPE_ID, 30, FLAG_CORP_DELIVERIES);
      adapter._addHangarStack(CORP, 60004001, 1003, TYPE_ID, 50, FLAG_HANGAR);

      clockNow = AT + 10000;
      let res = await executor.runPass();
      assert.ok(res.ok, JSON.stringify(res));
      assert.strictEqual(res.errors, 0);

      clockNow += 10000;
      res = await executor.runPass();
      assert.ok(res.ok, JSON.stringify(res));
      assert.strictEqual(res.errors, 0);

      const offer = env.tx((db) => env.offers.getOffer(db, offerId)).offer;
      assert.strictEqual(offer.state, S.DELIVERED);
      assert.strictEqual(offer.deliveredQuantity, 70);

      const flag62Stacks = adapter._state.hangarStacks.get(CORP)?.get(60004001);
      if (flag62Stacks) {
        assert.ok(!flag62Stacks.has(1001), "flag 62 stack 1001 voided");
        assert.ok(!flag62Stacks.has(1002), "flag 62 stack 1002 voided");
        assert.strictEqual(flag62Stacks.get(1003)?.quantity, 50, "flag 4 stack 1003 untouched");
      }
      executor.stop();
    });
  });

  const NPC_CORP = 1000123;
  const VENDOR_VOID = { ok: true, mode: "VENDOR_VOID", npcCorpMin: 1000000, npcCorpMax: 2000000 };
  function acceptedNpc(env, seed, filled) {
    const offerId = createOffer(env.tx, env.offers, seed, "mi-st-1", { issuerCorporationId: NPC_CORP }).offerId;
    step(env.tx, env.offers, offerId, S.PLANNED, S.ISSUING, 1, { expiresAt: AT + 259200000 });
    step(env.tx, env.offers, offerId, S.ISSUING, S.OPEN, 2, { marketOrderId: "ord-" + seed });
    step(env.tx, env.offers, offerId, S.OPEN, S.ACCEPTED, 3, { filledQuantity: filled, acceptorCharacterId: null });
    return offerId;
  }
  function stockOf(store) {
    const r = store.transaction("test.stock", function(db) {
      const row = db.prepare("SELECT quantity FROM world_station_stock WHERE station_id = 'mi-st-1' AND item_kind = 'mineral'" +
        " AND item_key = 'type:34'").get();
      return row ? row.quantity : 0;
    });
    assert.ok(r.ok, JSON.stringify(r));
    return r.value;
  }
  function offerOf(env, offerId) { return env.tx((db) => env.offers.getOffer(db, offerId)).offer; }

  test("TS1.4 market intake vendor void: F=600 credited without stacks, budget spends S, no LOST after the grace", function() {
    return H.withStore(driver, async function(reopen) {
      const opened = reopen();
      insertStation(opened.store, "mi-st-1", 60004001);
      const env = setup(opened);
      const adapter = createFakeTradeAdapter({}, { marketFillMode: VENDOR_VOID });
      env.adapter = adapter;
      const lists = spy(adapter, "tradeListDeliveredStacks");
      const voids = spy(adapter, "tradeVoidStack");
      const telemetry = counter();
      const cfg = makeConfig({ intakeGraceMs: 600000 });
      const executor = executorOf(opened, env, cfg, { telemetry });
      const offerId = acceptedNpc(env, "ts1-4", 600);
      const spent = marketSpendIsk({ unitPriceMilli: 1100, quantity: QUANTITY, iskTotal: QUANTITY * 1100 }, 600);
      assert.strictEqual(spent, Math.ceil(110 * 600 / 100));

      clockNow = AT + 3000 + cfg.trade.intakeGraceMs + 1;
      const res = await executor.runPass();
      assert.strictEqual(res.errors, 0, JSON.stringify(res));

      const offer = offerOf(env, offerId);
      assert.strictEqual(offer.state, S.DELIVERED);
      assert.strictEqual(offer.deliveredQuantity, 600);
      assert.strictEqual(stockOf(opened.store), 600);
      assert.deepStrictEqual([lists.length, voids.length], [0, 0]);
      const budget = env.tx((db) => env.budgets.getBudget(db, F)).budget;
      assert.deepStrictEqual([budget.spentTotal, budget.reservedIsk, budget.releasedTotal],
        [spent, 0, QUANTITY * 1100 - spent]);
      assert.deepStrictEqual([telemetry.counts["trade.marketVendorVoidIntake"], telemetry.counts["trade.marketFillRuleDrift"],
        telemetry.counts["trade.lost"]], [1, undefined, undefined]);
      executor.stop();
    });
  });

  test("TS1.5 market intake vendor void: restart between INTAKE and deliver -> stock +600 exactly once, then STALE", function() {
    return H.withStore(driver, async function(reopen) {
      let opened = reopen();
      insertStation(opened.store, "mi-st-1", 60004001);
      let env = setup(opened);
      const adapter = createFakeTradeAdapter({}, { marketFillMode: VENDOR_VOID });
      env.adapter = adapter;
      const cfg = makeConfig({ intakeGraceMs: 600000 });
      const { stepAccepted, stepIntake } = require("../../lib/economy/trade/intake");
      const offerId = acceptedNpc(env, "ts1-5", 600);
      clockNow = AT + 10000;
      const planned = await stepAccepted({ store: opened.store, journal: env.journal, offers: env.offers, adapter,
        config: cfg, clock: CLOCK, telemetry: null, logger: null }, offerOf(env, offerId), { stationId: 60004001 });
      assert.deepStrictEqual(planned, { action: "PLAN", plan: { action: "PLAN", stacks: [], short: 0 }, short: 0,
        vendorVoid: true });
      assert.strictEqual(offerOf(env, offerId).state, S.INTAKE);
      assert.strictEqual(stockOf(opened.store), 0);

      opened.store.close("restart");
      opened = reopen();
      env = servicesOf(opened);
      env.adapter = createFakeTradeAdapter({}, { marketFillMode: { ok: false, reason: "MARKET_FILL_RULE_DRIFT", detail: "rule" } });
      const executor = executorOf(opened, env, cfg);
      clockNow += 10000;
      let res = await executor.runPass();
      assert.strictEqual(res.errors, 0, JSON.stringify(res));
      assert.strictEqual(offerOf(env, offerId).state, S.DELIVERED);
      assert.strictEqual(stockOf(opened.store), 600);
      const again = await stepIntake({ store: opened.store, journal: env.journal, offers: env.offers, adapter: env.adapter,
        config: cfg, clock: CLOCK, telemetry: null, logger: null }, Object.assign({}, offerOf(env, offerId), { state: S.INTAKE }));
      assert.strictEqual(again.action, "STALE");
      clockNow += 10000;
      res = await executor.runPass();
      assert.strictEqual(res.errors, 0, JSON.stringify(res));
      assert.strictEqual(stockOf(opened.store), 600, "credited once");
      executor.stop();
    });
  });

  test("TS1.6 market intake fill-rule drift: stack path (flag 4) as TS1.1 + trade.marketFillRuleDrift", function() {
    return H.withStore(driver, async function(reopen) {
      const opened = reopen();
      insertStation(opened.store, "mi-st-1", 60004001);
      const env = setup(opened);
      const adapter = createFakeTradeAdapter({}, { marketFillMode: { ok: false, reason: "MARKET_FILL_RULE_DRIFT", detail: "rule" } });
      env.adapter = adapter;
      const telemetry = counter();
      const executor = executorOf(opened, env, makeConfig({ intakeGraceMs: 600000 }), { telemetry });
      const offerId = acceptedNpc(env, "ts1-6", 60);
      adapter._addHangarStack(NPC_CORP, 60004001, 1001, TYPE_ID, 40, FLAG_HANGAR);
      adapter._addHangarStack(NPC_CORP, 60004001, 1002, TYPE_ID, 30, FLAG_HANGAR);
      clockNow = AT + 10000;
      let res = await executor.runPass();
      assert.strictEqual(res.errors, 0, JSON.stringify(res));
      clockNow += 10000;
      res = await executor.runPass();
      assert.strictEqual(res.errors, 0, JSON.stringify(res));
      const offer = offerOf(env, offerId);
      assert.deepStrictEqual([offer.state, offer.deliveredQuantity], [S.DELIVERED, 60]);
      const stacks = adapter._state.hangarStacks.get(NPC_CORP).get(60004001);
      assert.ok(!stacks.has(1001), "stack 1001 voided");
      assert.strictEqual(stacks.get(1002).quantity, 10);
      assert.strictEqual(stockOf(opened.store), 60);
      assert.deepStrictEqual([telemetry.counts["trade.marketFillRuleDrift"], telemetry.counts["trade.marketVendorVoidIntake"]],
        [1, undefined]);
      executor.stop();
    });
  });

  test("TS1.7 market intake fill-rule drift: repeated WAIT passes of one offer count the drift once", function() {
    return H.withStore(driver, async function(reopen) {
      const opened = reopen();
      insertStation(opened.store, "mi-st-1", 60004001);
      const env = setup(opened);
      const adapter = createFakeTradeAdapter({}, { marketFillMode: { ok: false, reason: "MARKET_FILL_RULE_DRIFT", detail: "rule" } });
      env.adapter = adapter;
      const telemetry = counter();
      const executor = executorOf(opened, env, makeConfig({ intakeGraceMs: 600000 }), { telemetry });
      const offerId = acceptedNpc(env, "ts1-7", 60);
      for (let i = 0; i < 3; i += 1) {
        clockNow = AT + 10000 * (i + 1);
        const res = await executor.runPass();
        assert.strictEqual(res.errors, 0, JSON.stringify(res));
      }
      assert.strictEqual(offerOf(env, offerId).state, S.ACCEPTED);
      assert.strictEqual(telemetry.counts["trade.marketFillRuleDrift"], 1);
      executor.stop();
    });
  });

  test("HB6 market intake of a hull (vendor void): F=3 to the hull stock, trade.hullsDelivered 3, no stacks, then STALE", function() {
    return H.withStore(driver, async function(reopen) {
      const { buildTradeCatalog } = require("../../lib/economy/trade/tradeCatalog");
      const HULL_TYPES = require("../../lib/economy/data/hullTradeTypes");
      const HULL_RECIPES = require("../../lib/economy/data/hullRecipes");
      const { stepIntake } = require("../../lib/economy/trade/intake");
      const opened = reopen();
      insertStation(opened.store, "mi-st-1", 60004001);
      const env = setup(opened);
      const catalog = buildTradeCatalog({ hullTypes: HULL_TYPES, hullRecipes: HULL_RECIPES, hullOffersEnabled: true });
      env.offers = createOfferRepository({ journal: env.journal, budgets: env.budgets, ids: IDS, clock: CLOCK, catalog });
      const adapter = createFakeTradeAdapter({}, { marketFillMode: VENDOR_VOID });
      env.adapter = adapter;
      const lists = spy(adapter, "tradeListDeliveredStacks");
      const voids = spy(adapter, "tradeVoidStack");
      const telemetry = counter();
      const cfg = makeConfig({ intakeGraceMs: 600000 });
      const executor = executorOf(opened, env, cfg, { telemetry });

      const offerId = createOffer(env.tx, env.offers, "hb6", "mi-st-1", { issuerCorporationId: NPC_CORP, itemKind: "hull",
        itemKey: "group:frigate", typeId: HULL_TYPES.RACES["4"].frigate, quantity: 4, unitPriceMilli: 1000000000,
        iskTotal: 4000000, refPriceMilli: 1000000000, capPriceMilli: null, channel: undefined, purpose: "hull" }).offerId;
      const issuing = env.tx(function(db) {
        return env.offers.transitionOfferInTx(db, { offerId: offerId, expectedVersion: 1, from: S.PLANNED, to: S.ISSUING,
          reason: "", at: AT + 1000, patch: { expiresAt: AT + 259200000, channel: "market" }, allowHullMarket: true },
        S.transitionKey(offerId, 1, S.ISSUING));
      });
      assert.ok(issuing.ok, JSON.stringify(issuing));
      step(env.tx, env.offers, offerId, S.ISSUING, S.OPEN, 2, { marketOrderId: "ord-hb6" });
      step(env.tx, env.offers, offerId, S.OPEN, S.ACCEPTED, 3, { filledQuantity: 3, acceptorCharacterId: null });

      clockNow = AT + 10000;
      const res = await executor.runPass();
      assert.strictEqual(res.errors, 0, JSON.stringify(res));
      const hullStock = function() {
        const r = opened.store.transaction("test.hullStock", function(db) {
          const row = db.prepare("SELECT quantity FROM world_station_stock WHERE station_id = 'mi-st-1' AND item_kind = 'hull'" +
            " AND item_key = 'group:frigate'").get();
          return row ? row.quantity : 0;
        });
        assert.ok(r.ok, JSON.stringify(r));
        return r.value;
      };
      const offer = offerOf(env, offerId);
      assert.deepStrictEqual([offer.state, offer.deliveredQuantity, offer.channel], [S.DELIVERED, 3, "market"]);
      assert.strictEqual(hullStock(), 3);
      assert.deepStrictEqual([lists.length, voids.length], [0, 0]);
      assert.deepStrictEqual([telemetry.counts["trade.hullsDelivered"], telemetry.counts["trade.marketVendorVoidIntake"]], [3, 1]);

      const again = await stepIntake({ store: opened.store, journal: env.journal, offers: env.offers, adapter,
        config: cfg, clock: CLOCK, telemetry, logger: null }, Object.assign({}, offerOf(env, offerId), { state: S.INTAKE }));
      assert.strictEqual(again.action, "STALE");
      assert.strictEqual(hullStock(), 3, "credited once");
      assert.strictEqual(telemetry.counts["trade.hullsDelivered"], 3);
      executor.stop();
    });
  });

  function sweepWorld(opened, adapter, seed) {
    insertStation(opened.store, "mi-st-1", 60004001);
    const env = setup(opened);
    env.adapter = adapter;
    toDelivered(env.tx, env.offers, seed, "mi-st-1", "9" + seed.length, 600);
    return env;
  }

  test("TS2.1 refund sweep: balance 1234.56 -> debit 1234 under :0, remainder 0.56, entry APPLIED", function() {
    return H.withStore(driver, async function(reopen) {
      const opened = reopen();
      const adapter = createFakeTradeAdapter();
      const env = sweepWorld(opened, adapter, "ts2-1");
      const wallet = spy(adapter, "tradeAdjustWallet");
      const telemetry = counter();
      const executor = executorOf(opened, env, makeConfig(), { telemetry });
      adapter._state.wallets.set(CORP, { 1005: 1234.56 });

      clockNow = AT + 10000;
      const res = await executor.runPass();
      assert.strictEqual(res.errors, 0, JSON.stringify(res));
      assert.deepStrictEqual(sweepCalls(wallet), [[CMD(0), -1234]]);
      assert.strictEqual(wallet[0].accountKey, 1005);
      assert.ok(Math.abs(adapter._balance(CORP, 1005) - 0.56) < 1e-9);
      assert.deepStrictEqual(sweepRows(opened.store), [{ key: KEY(0), state: "APPLIED", error: null, amountIsk: 1234 }]);
      assert.deepStrictEqual([telemetry.counts["trade.marketRefundSweeps"], telemetry.counts["trade.marketRefundSweptIsk"]],
        [1, 1234]);

      clockNow += 60000;
      await executor.runPass();
      assert.strictEqual(sweepCalls(wallet).length, 1, "remainder < 1 ISK: no further call");
      executor.stop();
    });
  });

  test("TS2.2 refund sweep: crash after the debit, before markApplied -> restart replays :0 once (receipt), next refund under :1", function() {
    return H.withStore(driver, async function(reopen) {
      let opened = reopen();
      const adapter = createFakeTradeAdapter();
      let env = sweepWorld(opened, adapter, "ts2-2");
      const wallet = spy(adapter, "tradeAdjustWallet");
      const real = adapter.tradeAdjustWallet;
      let crash = true;
      adapter.tradeAdjustWallet = async function(spec) {
        const r = await real(spec);
        if (crash) { crash = false; throw new Error("process killed"); }
        return r;
      };
      adapter._state.wallets.set(CORP, { 1005: 1234.56 });

      clockNow = AT + 10000;
      let executor = executorOf(opened, env, makeConfig());
      let res = await executor.runPass();
      assert.strictEqual(res.errors, 1);
      assert.deepStrictEqual(sweepRows(opened.store), [{ key: KEY(0), state: "PENDING", error: null, amountIsk: 1234 }]);
      executor.stop();

      opened.store.close("restart");
      opened = reopen();
      env = servicesOf(opened);
      env.adapter = adapter;
      adapter._state.wallets.get(CORP)[1005] += 1300;
      const telemetry = counter();
      executor = executorOf(opened, env, makeConfig(), { telemetry });

      clockNow += 60000;
      res = await executor.runPass();
      assert.strictEqual(res.errors, 0, JSON.stringify(res));
      assert.deepStrictEqual(sweepRows(opened.store), [{ key: KEY(0), state: "APPLIED", error: null, amountIsk: 1234 }]);
      clockNow += 60000;
      res = await executor.runPass();
      assert.strictEqual(res.errors, 0, JSON.stringify(res));
      assert.deepStrictEqual(sweepRows(opened.store), [
        { key: KEY(0), state: "APPLIED", error: null, amountIsk: 1234 },
        { key: KEY(1), state: "APPLIED", error: null, amountIsk: 1300 },
      ]);
      assert.deepStrictEqual(sweepCalls(wallet), [[CMD(0), -1234], [CMD(0), -1234], [CMD(1), -1300]]);
      assert.ok(Math.abs(adapter._balance(CORP, 1005) - 0.56) < 1e-9, "1234 + 1300 taken once each");
      assert.deepStrictEqual([telemetry.counts["trade.marketRefundSweeps"], telemetry.counts["trade.marketRefundSweptIsk"]],
        [2, 2534]);
      executor.stop();
    });
  });

  test("TS2.2b refund sweep (TS-replay): crash after the debit, no new refund -> the resumed PENDING entry is a receipt replay, APPLIED, never debits twice", function() {
    return H.withStore(driver, async function(reopen) {
      let opened = reopen();
      const adapter = createFakeTradeAdapter();
      let env = sweepWorld(opened, adapter, "ts2-2b");
      const wallet = spy(adapter, "tradeAdjustWallet");
      const real = adapter.tradeAdjustWallet;
      let crash = true;
      adapter.tradeAdjustWallet = async function(spec) {
        const r = await real(spec);
        if (crash) { crash = false; throw new Error("process killed"); }
        return r;
      };
      adapter._state.wallets.set(CORP, { 1005: 1234.56 });

      clockNow = AT + 10000;
      let executor = executorOf(opened, env, makeConfig());
      await executor.runPass();
      executor.stop();
      opened.store.close("restart");
      opened = reopen();
      env = servicesOf(opened);
      env.adapter = adapter;
      adapter._state.wallets.get(CORP)[1005] = 0;
      const telemetry = counter();
      executor = executorOf(opened, env, makeConfig(), { telemetry });

      clockNow += 60000;
      await executor.runPass();
      clockNow += 60000;
      await executor.runPass();
      assert.deepStrictEqual(sweepRows(opened.store), [{ key: KEY(0), state: "APPLIED", error: null, amountIsk: 1234 }]);
      assert.deepStrictEqual(sweepCalls(wallet), [[CMD(0), -1234], [CMD(0), -1234]]);
      assert.strictEqual(adapter._balance(CORP, 1005), 0);
      assert.strictEqual(telemetry.counts["trade.marketSweepFailed"], undefined, "no false SHORT");
      executor.stop();
    });
  });

  test("TS2.3 refund sweep: INSUFFICIENT_FUNDS -> :0 FAILED SHORT, next pass :1 with the new balance", function() {
    return H.withStore(driver, async function(reopen) {
      const opened = reopen();
      const adapter = createFakeTradeAdapter();
      const env = sweepWorld(opened, adapter, "ts2-3");
      const real = adapter.tradeAdjustWallet;
      let shortOnce = true;
      adapter.tradeAdjustWallet = function(spec) {
        if (shortOnce) { shortOnce = false; return Promise.resolve({ ok: false, reason: "INSUFFICIENT_FUNDS", permanent: true }); }
        return real(spec);
      };
      const wallet = spy(adapter, "tradeAdjustWallet");
      const telemetry = counter();
      const executor = executorOf(opened, env, makeConfig(), { telemetry });
      adapter._state.wallets.set(CORP, { 1005: 100 });

      clockNow = AT + 10000;
      let res = await executor.runPass();
      assert.strictEqual(res.errors, 0, JSON.stringify(res));
      assert.deepStrictEqual(sweepRows(opened.store), [{ key: KEY(0), state: "FAILED", error: "SHORT", amountIsk: 100 }]);
      assert.strictEqual(adapter._balance(CORP, 1005), 100, "nothing taken");
      assert.strictEqual(telemetry.counts["trade.marketSweepFailed"], 1);
      assert.strictEqual(telemetry.counts["trade.marketRefundSweeps"], undefined, "no success counted");

      adapter._state.wallets.get(CORP)[1005] += 30;
      clockNow += 60000;
      res = await executor.runPass();
      assert.strictEqual(res.errors, 0, JSON.stringify(res));
      assert.deepStrictEqual(sweepRows(opened.store), [
        { key: KEY(0), state: "FAILED", error: "SHORT", amountIsk: 100 },
        { key: KEY(1), state: "APPLIED", error: null, amountIsk: 130 },
      ]);
      assert.deepStrictEqual(sweepCalls(wallet), [[CMD(0), -100], [CMD(1), -130]]);
      assert.strictEqual(adapter._balance(CORP, 1005), 0);
      executor.stop();
    });
  });

  test("TS2.4 refund sweep: balance < 1 -> zero wallet calls, no entry", function() {
    return H.withStore(driver, async function(reopen) {
      const opened = reopen();
      const adapter = createFakeTradeAdapter();
      const env = sweepWorld(opened, adapter, "ts2-4");
      const wallet = spy(adapter, "tradeAdjustWallet");
      const executor = executorOf(opened, env, makeConfig());
      adapter._state.wallets.set(CORP, { 1005: 0.99 });

      clockNow = AT + 10000;
      const res = await executor.runPass();
      assert.strictEqual(res.errors, 0, JSON.stringify(res));
      assert.deepStrictEqual(sweepCalls(wallet), []);
      assert.deepStrictEqual(sweepRows(opened.store), []);
      executor.stop();
    });
  });

  test("TS2.5 refund sweep: equal divisions -> zero lne:trade:msweep: calls, blocked logged once", function() {
    return H.withStore(driver, async function(reopen) {
      const opened = reopen();
      const adapter = createFakeTradeAdapter();
      const env = sweepWorld(opened, adapter, "ts2-5");
      const wallet = spy(adapter, "tradeAdjustWallet");
      const lines = [];
      const executor = executorOf(opened, env, makeConfig({ buyOrderWalletAccountKey: 1005, walletAccountKey: 1005 }),
        { logger: { log: function(line) { lines.push(String(line)); } } });
      adapter._state.wallets.set(CORP, { 1005: 10000 });

      clockNow = AT + 10000;
      await executor.runPass();
      clockNow += 60000;
      await executor.runPass();
      assert.deepStrictEqual(sweepCalls(wallet), []);
      assert.strictEqual(adapter._balance(CORP, 1005), 10000);
      assert.strictEqual(lines.filter(function(l) { return l.includes("refund sweep blocked"); }).length, 1);
      executor.stop();
    });
  });

  test("TS2.6 refund sweep: three refunds 100/50/70 -> :0 :1 :2 each taken exactly once", function() {
    return H.withStore(driver, async function(reopen) {
      const opened = reopen();
      const adapter = createFakeTradeAdapter();
      const env = sweepWorld(opened, adapter, "ts2-6");
      const wallet = spy(adapter, "tradeAdjustWallet");
      const executor = executorOf(opened, env, makeConfig());
      adapter._state.wallets.set(CORP, { 1005: 0 });

      clockNow = AT + 10000;
      for (const refund of [100, 50, 70]) {
        adapter._state.wallets.get(CORP)[1005] += refund;
        clockNow += 60000;
        const res = await executor.runPass();
        assert.strictEqual(res.errors, 0, JSON.stringify(res));
      }
      assert.deepStrictEqual(sweepCalls(wallet), [[CMD(0), -100], [CMD(1), -50], [CMD(2), -70]]);
      assert.deepStrictEqual(sweepRows(opened.store).map(function(r) { return [r.key, r.state, r.amountIsk]; }),
        [[KEY(0), "APPLIED", 100], [KEY(1), "APPLIED", 50], [KEY(2), "APPLIED", 70]]);
      assert.strictEqual(adapter._balance(CORP, 1005), 0, "sum of refunds - sum of sweeps < 1 ISK");
      executor.stop();
    });
  });

  test("TS2.7 refund sweep: keys n >= 10 - 11 sweeps, then a transient failure resumes :11 (not :2 / :12)", function() {
    return H.withStore(driver, async function(reopen) {
      const opened = reopen();
      const adapter = createFakeTradeAdapter();
      const env = sweepWorld(opened, adapter, "ts2-7");
      const real = adapter.tradeAdjustWallet;
      let transient = false;
      adapter.tradeAdjustWallet = function(spec) {
        if (transient) { transient = false; return Promise.resolve({ ok: false, reason: "WALLET_FAILED", permanent: false }); }
        return real(spec);
      };
      const wallet = spy(adapter, "tradeAdjustWallet");
      const deps = { store: opened.store, journal: env.journal, adapter, config: makeConfig(), telemetry: null,
        logger: { log: function() {} }, offers: env.offers, sweepState: { corpIndex: 0, blockedLogged: false } };
      adapter._state.wallets.set(CORP, { 1005: 0 });

      for (let i = 0; i < 11; i++) {
        adapter._state.wallets.get(CORP)[1005] += 10 + i;
        clockNow += 1000;
        const r = await runRefundSweep(deps, 2, 500);
        assert.deepStrictEqual([r.swept, r.errors], [1, 0], "sweep " + i);
      }
      adapter._state.wallets.get(CORP)[1005] += 99;
      transient = true;
      let r = await runRefundSweep(deps, 2, 500);
      assert.strictEqual(r.swept, 0);
      adapter._state.wallets.get(CORP)[1005] += 1;
      r = await runRefundSweep(deps, 2, 500);
      assert.strictEqual(r.swept, 1);

      const rows = sweepRows(opened.store);
      assert.strictEqual(rows.length, 12);
      assert.deepStrictEqual(rows[11], { key: KEY(11), state: "APPLIED", error: null, amountIsk: 99 });
      assert.ok(rows.every(function(row) { return row.state === "APPLIED"; }));
      const calls = sweepCalls(wallet);
      assert.deepStrictEqual(calls.slice(-2), [[CMD(11), -99], [CMD(11), -99]]);
      assert.strictEqual(new Set(calls.map(function(c) { return c[0]; })).size, 12);
      assert.strictEqual(adapter._balance(CORP, 1005), 1, "the refund after the freeze waits for :12");
    });
  });

};
