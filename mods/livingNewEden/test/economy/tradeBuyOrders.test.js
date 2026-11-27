"use strict";

const assert = require("node:assert");
const path = require("node:path");

const config = require("../../config");
const { createJournal } = require("../../lib/persistence/journal");
const { openStore } = require("../../lib/persistence/store");
const { MIGRATIONS } = require("../../lib/persistence/migrations");
const { createBudgetRepository } = require("../../lib/economy/trade/budgetRepository");
const { createOfferRepository } = require("../../lib/economy/trade/offerRepository");
const { createTradeExecutor } = require("../../lib/economy/trade/tradeExecutor");
const { startTrade } = require("../../lib/economy/trade");
const { marketSpendIsk, priceCents, chooseChannel, hullMarketFlag } = require("../../lib/economy/trade/marketRules");
const { buildTradeCatalog } = require("../../lib/economy/trade/tradeCatalog");
const HULL_TYPES = require("../../lib/economy/data/hullTradeTypes");
const HULL_RECIPES = require("../../lib/economy/data/hullRecipes");
const { createFakeTradeAdapter } = require("../_support/fakeTradeAdapter");
const { harness: H } = require("../battle/settlement.test");
const S = require("../../lib/economy/trade/schema");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const DEFAULTS = config.resolveConfig({ modDir: MOD_DIR, env: {} }).config;

const F = 500019;
const CORP = 999999;
const SYSTEM = 30000001;
const TYPE_ID = 34;
const QUANTITY = 1000;
const UNIT_MILLI = 1105;
const ISK_TOTAL = 1105;
const AT = 1000000;
const TTL = 259200000;
const ISSUE_TIMEOUT = 1800000;
let clockNow = AT;
const CLOCK = { now: () => clockNow };
let idCounter = 0;
const IDS = { next: (p) => `${p}_${++idCounter}` };

function insertStation(store, stationId, npcStationId) {
  const r = store.transaction("test.insertStation", (db) => db.prepare(
    "INSERT INTO world_stations (station_id, kind, npc_station_id, type_id, structure_family, system_id,"
    + "  owner_faction_id, owner_corporation_id, state, state_until_at, name, position_json, origin,"
    + "  evejs_item_id, destroyed_at, created_at, updated_at, version)"
    + " VALUES (?, 'npc', ?, 35834, 'Sansha', ?, ?, ?, 'ONLINE', NULL, 'BO Station', '{\"x\":0,\"y\":0,\"z\":0}', 'seed',"
    + "  NULL, NULL, ?, ?, 1)").run(stationId, npcStationId, SYSTEM, F, CORP, AT, AT));
  assert.ok(r.ok, JSON.stringify(r));
}

function makeConfig(trade) {
  return {
    trade: Object.assign({
      enabled: true, contractsEnabled: true, cleanupOnDisable: false, walletAccountKey: 1006,
      contractTtlMs: TTL, executorPollMs: 60000, maxIssuesPerPass: 2, maxPollsPerPass: 16,
      maxClosesPerPass: 4, issueTimeoutMs: ISSUE_TIMEOUT, priceRegionId: 10000002, maxPriceRegions: 8,
      priceRefreshMs: 1800000, maxIntakesPerPass: 2, intakeGraceMs: 600000, maxOrphansPerPass: 2, intakeMaxRetries: 100,
      virtualIssuers: false,
      buyOrdersEnabled: true, buyOrderWalletAccountKey: 1005, buyOrderTtlMs: TTL, buyOrderDurationDays: 7,
      buyOrderMinVolume: 1, maxBuyOrderPollsPerPass: 16, maxBuyOrderClosesPerPass: 4,
      maxBuyOrderOrphansPerPass: 0, maxRefundSweepsPerPass: 0, marketOrphanScanMs: 3600000, marketOrphanScanPage: 64,
    }, trade || {}),
  };
}

function envOf(opened) {
  const journal = createJournal({ clock: CLOCK, maxPayloadBytes: 16384, maxRows: 500 });
  const budgets = createBudgetRepository({ journal, clock: CLOCK });
  const offers = createOfferRepository({ journal, budgets, ids: IDS, clock: CLOCK });
  const tx = (fn) => { const r = opened.store.transaction("test", fn); assert.ok(r.ok, JSON.stringify(r)); return r.value; };
  tx((db) => budgets.fundInTx(db, { factionId: F, units: 100000, paidUntilTo: AT, iskPerUnit: 1000,
    capIsk: 1000000000, at: AT }, "fund:1"));
  return { journal, budgets, offers, tx, adapter: createFakeTradeAdapter({}, { now: CLOCK.now }) };
}

function planned(env, stationId, overrides) {
  const r = env.tx((db) => env.offers.createOfferInTx(db, Object.assign({
    factionId: F, stationId, systemId: SYSTEM, issuerCorporationId: CORP, itemKind: "mineral",
    itemKey: "type:34", typeId: TYPE_ID, quantity: QUANTITY, unitPriceMilli: UNIT_MILLI, iskTotal: ISK_TOTAL,
    refPriceMilli: 1000, capPriceMilli: 1960, priceSource: "bid", expiresAt: clockNow + TTL, at: clockNow,
  }, overrides || {}), `ik:${stationId}:${++idCounter}:offer`));
  assert.ok(r.ok && !r.duplicate, JSON.stringify(r));
  return r.offer.offerId;
}

const stationsFacade = () => ({ getMode: () => "ready" });

function executorOf(opened, env, cfg, extra) {
  const x = extra || {};
  return createTradeExecutor({
    store: opened.store, journal: x.journal || env.journal, offers: env.offers, budgets: env.budgets,
    adapter: env.adapter, priceCache: { put() {}, peek() { return null; } }, config: cfg, clock: CLOCK,
    mode: x.mode || "run", getStations: stationsFacade, getGovernor: () => ({ admits: () => true }),
    factionNames: new Map([[F, "Sansha"]]), telemetry: x.telemetry || null, logger: { log() {} },
    market: x.market || { ready: true, reason: null },
  });
}

const offerOf = (env, offerId) => env.tx((db) => env.offers.getOffer(db, offerId)).offer;
const budgetOf = (env) => env.tx((db) => env.budgets.getBudget(db, F)).budget;
const counter = () => {
  const counts = {};
  return { counts, count(name, v) { counts[name] = (counts[name] || 0) + v; }, observe() {} };
};
const marketCalls = (adapter) => Object.keys(adapter._calls).filter((k) => k.startsWith("tradeMarket")
  || k === "checkTradeMarketSeams");

function orderLog(adapter) {
  const seq = [];
  for (const name of ["tradeMarketDetachEscrow", "tradeMarketCancel", "tradeMarketPlace", "tradeMarketFind"]) {
    const real = adapter[name];
    adapter[name] = function wrapped(...args) { seq.push(name); return real.apply(adapter, args); };
  }
  return seq;
}

async function toOpenMarket(opened, env, cfg, stationId) {
  const offerId = planned(env, stationId);
  const ex = executorOf(opened, env, cfg);
  const res = await ex.runPass();
  assert.strictEqual(res.errors, 0, JSON.stringify(res));
  const o = offerOf(env, offerId);
  assert.deepStrictEqual([o.state, o.channel], [S.OPEN, S.CHANNEL_MARKET], JSON.stringify(o));
  return { offerId, orderId: o.marketOrderId, executor: ex };
}

module.exports = ({ test, skip }) => {
  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  needsDriver("TBO1 buy order happy path: place, partial fill, TTL close (detach before CancelOrder), budget closed once",
    () => H.withStore(driver, async (reopen) => {
      const opened = reopen();
      clockNow = AT;
      insertStation(opened.store, "bo-1", 60004001);
      const env = envOf(opened);
      const before = budgetOf(env);
      const offerId = planned(env, "bo-1");
      const telemetry = counter();
      const cfg = makeConfig();
      const ex = executorOf(opened, env, cfg, { telemetry });

      clockNow = AT + 10000;
      let res = await ex.runPass();
      assert.strictEqual(res.errors, 0, JSON.stringify(res));
      let o = offerOf(env, offerId);
      assert.deepStrictEqual([o.state, o.channel, o.contractId, o.expiresAt], [S.OPEN, "market", null, AT + 10000 + TTL]);
      assert.strictEqual(env.adapter._daemonCalls.PlaceOrder, 1);
      assert.strictEqual(env.adapter._calls.tradeCreateContract, undefined, "no contract");
      const rec = env.adapter._state.escrows.get(o.marketOrderId);
      assert.deepStrictEqual([rec.lneOfferId, rec.ownerId, rec.walletOwnerId, rec.accountKey, rec.remainingQuantity],
        [offerId, CORP, CORP, 1005, QUANTITY]);
      assert.strictEqual(telemetry.counts["trade.marketPlaced"], 1);
      assert.strictEqual(budgetOf(env).reservedIsk, before.reservedIsk + ISK_TOTAL);

      const orderId = o.marketOrderId;
      env.adapter._fill(orderId, 401);
      clockNow += 60000;
      res = await ex.runPass();
      assert.strictEqual(res.errors, 0, JSON.stringify(res));
      o = offerOf(env, offerId);
      assert.deepStrictEqual([o.state, o.filledQuantity], [S.OPEN, 401]);

      const seq = orderLog(env.adapter);
      clockNow = o.expiresAt;
      res = await ex.runPass();
      assert.strictEqual(res.errors, 0, JSON.stringify(res));
      o = offerOf(env, offerId);
      assert.deepStrictEqual([o.state, o.filledQuantity, o.acceptorCharacterId, o.deliveredQuantity],
        [S.DELIVERED, 401, null, 401]);
      assert.deepStrictEqual(seq.filter((n) => n !== "tradeMarketFind"), ["tradeMarketDetachEscrow", "tradeMarketCancel"],
        "record detached before CancelOrder");
      assert.strictEqual(env.adapter._balance(CORP, 1005), 0, "no escrow refund (record gone before the cancel)");
      const close = env.tx((db) => env.journal.findByKey(db, S.marketCloseOutboxKey(offerId)));
      assert.deepStrictEqual([close.entry.state, close.entry.payload.reason], ["APPLIED", "EXPIRED"]);

      const spent = marketSpendIsk({ unitPriceMilli: UNIT_MILLI, quantity: QUANTITY, iskTotal: ISK_TOTAL }, 401);
      assert.strictEqual(spent, 442);
      const after = budgetOf(env);
      assert.deepStrictEqual([after.spentTotal - before.spentTotal, after.availableIsk - before.availableIsk,
        after.reservedIsk, after.releasedTotal - before.releasedTotal],
      [spent, -spent, before.reservedIsk, ISK_TOTAL - spent]);
      const paidCents = 401 * priceCents({ unitPriceMilli: UNIT_MILLI });
      assert.ok(paidCents <= spent * 100 && spent * 100 < paidCents + 100, `${paidCents} vs ${spent}`);
      assert.deepStrictEqual([telemetry.counts["trade.marketSettled"], telemetry.counts["trade.marketFilledUnits"]], [1, 401]);

      clockNow += 60000;
      await ex.runPass();
      const again = budgetOf(env);
      assert.deepStrictEqual([again.spentTotal, again.availableIsk, again.releasedTotal],
        [after.spentTotal, after.availableIsk, after.releasedTotal], "the settlement never repeats");
      ex.stop();
    }));

  needsDriver("TBO2 restart in the issue: one order and one record per offer; daemon down past the timeout never aborts; outbox failure keeps PLANNED",
    () => H.withStore(driver, async (reopen) => {
      const opened = reopen();
      clockNow = AT;
      for (const [s, n] of [["bo-a", 60004011], ["bo-b", 60004012], ["bo-c", 60004013], ["bo-d", 60004014]]) {
        insertStation(opened.store, s, n);
      }
      const env = envOf(opened);
      const cfg = makeConfig({ maxIssuesPerPass: 1 });
      const ad = env.adapter;

      const a = planned(env, "bo-a");
      ad._marketDown(true);
      clockNow = AT + 1000;
      await executorOf(opened, env, cfg).runPass();
      assert.strictEqual(offerOf(env, a).state, S.ISSUING);
      ad._marketDown(false);
      ad._reset();
      clockNow += 1000;
      await executorOf(opened, env, cfg).runPass();
      const oa = offerOf(env, a);
      assert.strictEqual(oa.state, S.OPEN);
      assert.strictEqual(ad._daemonCalls.PlaceOrder, 1);

      const b = planned(env, "bo-b");
      ad._losePlaceResponse();
      clockNow += 1000;
      await executorOf(opened, env, cfg).runPass();
      assert.strictEqual(offerOf(env, b).state, S.ISSUING);
      assert.strictEqual(ad._daemonCalls.PlaceOrder, 2);
      clockNow += 1000;
      await executorOf(opened, env, cfg).runPass();
      const ob = offerOf(env, b);
      assert.strictEqual(ob.state, S.OPEN);
      assert.strictEqual(ad._daemonCalls.PlaceOrder, 2, "never placed again");

      const c = planned(env, "bo-c");
      ad._marketDown(true);
      clockNow += 1000;
      await executorOf(opened, env, cfg).runPass();
      ad._marketDown(false);
      const mplace = env.tx((db) => env.journal.findByKey(db, S.marketPlaceOutboxKey(c))).entry.payload;
      assert.deepStrictEqual(mplace, { accountKey: 1005, corporationId: CORP, durationDays: 7, minVolume: 1,
        offerId: c, priceCents: 110, quantity: QUANTITY, stationId: 60004013, typeId: TYPE_ID });
      const placed = await ad.tradeMarketPlace(mplace);
      assert.ok(placed.ok, JSON.stringify(placed));
      clockNow += 1000;
      await executorOf(opened, env, cfg).runPass();
      const oc = offerOf(env, c);
      assert.deepStrictEqual([oc.state, oc.marketOrderId], [S.OPEN, placed.orderId]);
      assert.strictEqual(ad._daemonCalls.PlaceOrder, 3);
      for (const offerId of [a, b, c]) {
        const recs = [...ad._state.escrows.values()].filter((r) => r.lneOfferId === offerId);
        const orders = [...ad._state.marketOrders.values()].filter((o) => o.stationId === offerOf(env, offerId).stationId
          || recs.some((r) => r.orderId === o.orderId));
        assert.strictEqual(recs.length, 1, `one record ${offerId}`);
        assert.strictEqual(orders.filter((o) => o.state === "open").length, 1, `one order ${offerId}`);
      }

      const d = planned(env, "bo-d");
      ad._marketDown(true);
      clockNow += 1000;
      await executorOf(opened, env, cfg).runPass();
      clockNow += ISSUE_TIMEOUT + 1;
      const ex = executorOf(opened, env, cfg);
      await ex.runPass();
      assert.strictEqual(offerOf(env, d).state, S.ISSUING, "no abort without a successful find");
      assert.strictEqual(ex.getStatus().market.down, true);
      ad._marketDown(false);
    }));

  needsDriver("TBO2b outbox write refused in PLANNED -> ISSUING: the offer stays PLANNED (version and budget unchanged)",
    () => H.withStore(driver, async (reopen) => {
      const opened = reopen();
      clockNow = AT;
      insertStation(opened.store, "bo-e", 60004015);
      const env = envOf(opened);
      const offerId = planned(env, "bo-e");
      const before = offerOf(env, offerId);
      const refusing = Object.assign({}, env.journal, { enqueueOutbox: () => ({ ok: false, reason: "FORCED" }) });
      const res = await executorOf(opened, env, makeConfig(), { journal: refusing }).runPass();
      assert.ok(res.errors >= 1, JSON.stringify(res));
      const after = offerOf(env, offerId);
      assert.deepStrictEqual([after.state, after.version, after.channel], [S.PLANNED, before.version, "contract"]);
      assert.strictEqual(env.adapter._calls.tradeMarketPlace, undefined);
    }));

  needsDriver("TBO3 vendor terminals: filled, expired with a record, fill saga waits, missing, restart after CancelOrder",
    () => H.withStore(driver, async (reopen) => {
      const opened = reopen();
      clockNow = AT;
      const stations = ["bo-f", "bo-x", "bo-s", "bo-m", "bo-z", "bo-r"];
      stations.forEach((s, i) => insertStation(opened.store, s, 60004021 + i));
      const env = envOf(opened);
      const ad = env.adapter;
      const cfg = makeConfig({ maxIssuesPerPass: 1 });
      const telemetry = counter();
      const pass = async () => {
        clockNow += 1000;
        const res = await executorOf(opened, env, cfg, { telemetry }).runPass();
        assert.strictEqual(res.errors, 0, JSON.stringify(res));
      };

      const f = await toOpenMarket(opened, env, cfg, "bo-f");
      let b0 = budgetOf(env);
      ad._fill(f.orderId, QUANTITY);
      await pass();
      let o = offerOf(env, f.offerId);
      assert.strictEqual(o.filledQuantity, QUANTITY);
      assert.ok([S.ACCEPTED, S.INTAKE, S.DELIVERED].includes(o.state), o.state);
      let b1 = budgetOf(env);
      const full = marketSpendIsk({ unitPriceMilli: UNIT_MILLI, quantity: QUANTITY, iskTotal: ISK_TOTAL }, QUANTITY);
      assert.deepStrictEqual([b1.spentTotal - b0.spentTotal, b1.releasedTotal - b0.releasedTotal, full], [1100, 5, 1100]);

      const x = await toOpenMarket(opened, env, cfg, "bo-x");
      b0 = budgetOf(env);
      ad._state.marketOrders.get(x.orderId).state = "expired";
      await pass();
      o = offerOf(env, x.offerId);
      assert.deepStrictEqual([o.state, o.endReason, ad._state.escrows.has(x.orderId)], [S.CANCELLED, "MARKET_EXPIRED", false]);
      assert.strictEqual(ad._balance(CORP, 1005), 0, "refund division untouched");
      b1 = budgetOf(env);
      assert.deepStrictEqual([b1.releasedTotal - b0.releasedTotal, b1.availableIsk - b0.availableIsk,
        b0.reservedIsk - b1.reservedIsk, b1.spentTotal - b0.spentTotal], [ISK_TOTAL, ISK_TOTAL, ISK_TOTAL, 0]);

      const s = await toOpenMarket(opened, env, cfg, "bo-s");
      ad._state.marketOrders.get(s.orderId).state = "expired";
      ad._setPendingFill(s.orderId, true);
      await pass();
      assert.deepStrictEqual([offerOf(env, s.offerId).state, ad._state.escrows.has(s.orderId)], [S.OPEN, true]);
      ad._setPendingFill(s.orderId, false);
      await pass();
      assert.strictEqual(offerOf(env, s.offerId).endReason, "MARKET_EXPIRED");

      const m = await toOpenMarket(opened, env, cfg, "bo-m");
      ad._fill(m.orderId, 300);
      await pass();
      assert.strictEqual(offerOf(env, m.offerId).filledQuantity, 300);
      ad._forget(m.orderId);
      await pass();
      o = offerOf(env, m.offerId);
      assert.deepStrictEqual([o.filledQuantity, [S.ACCEPTED, S.INTAKE, S.DELIVERED].includes(o.state),
        ad._state.escrows.has(m.orderId)], [300, true, false]);
      assert.strictEqual(telemetry.counts["trade.marketOrderMissing"], 1);
      const z = await toOpenMarket(opened, env, cfg, "bo-z");
      ad._forget(z.orderId);
      await pass();
      assert.deepStrictEqual([offerOf(env, z.offerId).state, offerOf(env, z.offerId).endReason], [S.CANCELLED, "MARKET_MISSING"]);

      const r = await toOpenMarket(opened, env, cfg, "bo-r");
      env.tx((db) => env.journal.enqueueOutbox(db, { key: S.marketCloseOutboxKey(r.offerId),
        aggregate: { type: S.OFFER_AGGREGATE, id: r.offerId }, eventType: S.EVENT_OUTBOX_MARKET_CLOSE,
        payload: { offerId: r.offerId, orderId: r.orderId, reason: "EXPIRED" } }));
      assert.ok(ad.tradeMarketDetachEscrow({ orderId: r.orderId, offerId: r.offerId }).ok);
      assert.ok((await ad.tradeMarketCancel(r.orderId)).ok);
      b0 = budgetOf(env);
      await pass();
      await pass();
      o = offerOf(env, r.offerId);
      assert.deepStrictEqual([o.state, o.endReason], [S.CANCELLED, "EXPIRED"]);
      b1 = budgetOf(env);
      assert.strictEqual(b1.releasedTotal - b0.releasedTotal, ISK_TOTAL, "one settlement");
      const settled = env.tx((db) => db.prepare("SELECT count(*) AS n FROM world_event_journal WHERE idempotency_key LIKE ?")
        .get(`trade:${r.offerId}:s%:CANCELLED`)).n;
      assert.strictEqual(settled, 1);
      assert.strictEqual(ad._balance(CORP, 1005), 0);
    }));

  needsDriver("TBO4 switch-off and channel: flag off = no tradeMarket*; on -> off at OPEN -> DISABLED; private / marketDown -> contract; own bid excluded",
    () => H.withStore(driver, async (reopen) => {
      const opened = reopen();
      clockNow = AT;
      ["bo-o1", "bo-o2", "bo-p", "bo-d1", "bo-d2", "bo-ni"].forEach((s, i) => insertStation(opened.store, s, 60004031 + i));
      const env = envOf(opened);
      const ad = env.adapter;

      const off = makeConfig({ buyOrdersEnabled: false });
      const c = planned(env, "bo-o1");
      clockNow += 1000;
      await executorOf(opened, env, off).runPass();
      assert.deepStrictEqual([offerOf(env, c).state, offerOf(env, c).channel], [S.OPEN, "contract"]);
      assert.deepStrictEqual(marketCalls(ad), []);

      const on = makeConfig();
      const m = await toOpenMarket(opened, env, on, "bo-o2");
      const b0 = budgetOf(env);
      clockNow += 1000;
      await executorOf(opened, env, off).runPass();
      const om = offerOf(env, m.offerId);
      assert.deepStrictEqual([om.state, om.endReason, ad._state.escrows.has(m.orderId),
        ad._state.marketOrders.get(m.orderId).state], [S.CANCELLED, "DISABLED", false, "cancelled"]);
      assert.strictEqual(budgetOf(env).releasedTotal - b0.releasedTotal, ISK_TOTAL);
      assert.strictEqual(ad._calls.tradeMarketPlace, 1, "the flag-off pass placed nothing");

      const p = planned(env, "bo-p", { assigneeCharacterId: 90000001 });
      clockNow += 1000;
      await executorOf(opened, env, on).runPass();
      assert.deepStrictEqual([offerOf(env, p).channel, offerOf(env, p).state], ["contract", S.OPEN]);

      const d1 = planned(env, "bo-d1");
      const d2 = planned(env, "bo-d2");
      ad._marketDown(true);
      clockNow += 1000;
      const ex = executorOf(opened, env, on);
      await ex.runPass();
      const pair = [offerOf(env, d1), offerOf(env, d2)].map((o) => `${o.channel}:${o.state}`).sort();
      assert.deepStrictEqual(pair, ["contract:OPEN", "market:ISSUING"]);
      assert.strictEqual(ex.getStatus().market.down, true);
      ad._marketDown(false);

      clockNow += 1000;
      await executorOf(opened, env, on).runPass();
      const own = [offerOf(env, d1), offerOf(env, d2)].find((o) => o.channel === "market");
      assert.strictEqual(own.state, S.OPEN);
      const specs = [];
      ad.readTradePrices = (spec) => { specs.push(spec); return Promise.resolve({ ok: true, prices: new Map(), errors: 0 }); };
      clockNow += 1000;
      await executorOf(opened, env, on).runPass();
      assert.deepStrictEqual(specs.map((sp) => sp.excludeOrderIds), [[own.marketOrderId]]);

      ad.tradeReadIssuer = () => Promise.resolve({ ok: false, reason: "NO_ISSUER", detail: "record_not_found" });
      const placesBefore = ad._calls.tradeMarketPlace || 0;
      const ni = planned(env, "bo-ni");
      clockNow += 1000;
      await executorOf(opened, env, on).runPass();
      assert.deepStrictEqual([offerOf(env, ni).state, offerOf(env, ni).endReason], [S.CANCELLED, "NO_ISSUER"]);
      assert.strictEqual(ad._calls.tradeMarketPlace || 0, placesBefore, "zero tradeMarketPlace without the issuer record");
    }));

  const HULL_TYPE = HULL_TYPES.RACES["4"].frigate;
  const hullOffer = (over) => ({ side: S.SIDE_BUY, itemKind: S.ITEM_KIND_HULL, itemKey: "group:frigate", typeId: HULL_TYPE,
    unitPriceMilli: 1000000000, assigneeCharacterId: null, issuerCharacterId: null, ...over });
  const mineralOffer = { side: S.SIDE_BUY, itemKind: S.ITEM_KIND_MINERAL, itemKey: "type:34", typeId: TYPE_ID,
    unitPriceMilli: UNIT_MILLI, assigneeCharacterId: null, issuerCharacterId: null };
  const NPC = { kind: "npc" };
  const flagsOf = (over) => ({ buyOrdersEnabled: true, contractsEnabled: true, marketReady: true, marketDown: false,
    hullBuyOrdersEnabled: true, ...over });

  test("HB4 chooseChannel hulls (flag on): NPC public -> market; upwell / assignee / marketDown -> contract; hullMarketFlag", () => {
    assert.strictEqual(chooseChannel(hullOffer(), NPC, flagsOf()), S.CHANNEL_MARKET);
    assert.strictEqual(chooseChannel(hullOffer(), { kind: "upwell" }, flagsOf()), S.CHANNEL_CONTRACT);
    assert.strictEqual(chooseChannel(hullOffer({ assigneeCharacterId: 90000001 }), NPC, flagsOf()), S.CHANNEL_CONTRACT);
    assert.strictEqual(chooseChannel(hullOffer(), NPC, flagsOf({ marketDown: true })), S.CHANNEL_CONTRACT);
    assert.strictEqual(chooseChannel(mineralOffer, NPC, flagsOf()), S.CHANNEL_MARKET);
    assert.strictEqual(chooseChannel(mineralOffer, NPC, flagsOf({ hullBuyOrdersEnabled: false })), S.CHANNEL_MARKET);
    assert.strictEqual(hullMarketFlag({ trade: { hullBuyOrdersEnabled: true } }), true);
    assert.strictEqual(hullMarketFlag({ trade: { hullBuyOrdersEnabled: true }, warContracts: { enabled: true } }), false);
    assert.strictEqual(hullMarketFlag({ trade: {} }), false);
    assert.strictEqual(hullMarketFlag(null), false);
    assert.strictEqual(hullMarketFlag(DEFAULTS), false, "default config: off");
    assert.strictEqual(chooseChannel(hullOffer(), NPC, flagsOf({ hullBuyOrdersEnabled: hullMarketFlag({ trade: {} }) })),
      S.CHANNEL_CONTRACT);
  });

  needsDriver("HB5 hulls flag off bit for bit: contract channel; repository refuses market without allowHullMarket; ore refused; executor wiring",
    () => H.withStore(driver, async (reopen) => {
      for (const off of [{ hullBuyOrdersEnabled: false }, { hullBuyOrdersEnabled: undefined }]) {
        assert.strictEqual(chooseChannel(hullOffer(), NPC, flagsOf(off)), S.CHANNEL_CONTRACT, JSON.stringify(off));
      }
      const opened = reopen();
      clockNow = AT;
      ["hb-r", "hb-o", "hb-m", "hb-w", "hb-f"].forEach((s, i) => insertStation(opened.store, s, 60004201 + i));
      const env = envOf(opened);
      const catalog = buildTradeCatalog({ hullTypes: HULL_TYPES, hullRecipes: HULL_RECIPES, hullOffersEnabled: true });
      const offers = createOfferRepository({ journal: env.journal, budgets: env.budgets, ids: IDS, clock: CLOCK, catalog });
      const hullEnv = { ...env, offers };
      const plannedHull = (stationId) => planned(hullEnv, stationId, { itemKind: "hull", itemKey: "group:frigate",
        typeId: HULL_TYPE, quantity: 2, unitPriceMilli: 1000000000, iskTotal: 2000000, refPriceMilli: 1000000000,
        capPriceMilli: null, purpose: "hull" });
      const toIssuing = (offerId, extra, key) => env.tx((db) => offers.transitionOfferInTx(db, { offerId,
        expectedVersion: 1, from: S.PLANNED, to: S.ISSUING, reason: "", at: clockNow,
        patch: { expiresAt: clockNow + TTL, channel: S.CHANNEL_MARKET }, ...extra }, key));
      const refused = { ok: false, reason: "TRADE_INVALID_INPUT", detail: "channel:market" };

      const run = async (stationId, cfg) => {
        const id = plannedHull(stationId);
        clockNow += 1000;
        const res = await executorOf(opened, hullEnv, cfg).runPass();
        assert.strictEqual(res.errors, 0, JSON.stringify(res));
        const o = offerOf(hullEnv, id);
        return `${o.channel}:${o.state}`;
      };
      assert.strictEqual(await run("hb-m", makeConfig({ hullBuyOrdersEnabled: true })), "market:OPEN");
      assert.strictEqual(await run("hb-w", { ...makeConfig({ hullBuyOrdersEnabled: true }), warContracts: { enabled: true } }),
        "contract:OPEN");
      assert.strictEqual(await run("hb-f", makeConfig()), "contract:OPEN");

      const h = plannedHull("hb-r");
      assert.deepStrictEqual(toIssuing(h, {}, `hb5:${h}:a`), refused);
      assert.deepStrictEqual(toIssuing(h, { allowHullMarket: false }, `hb5:${h}:b`), refused);
      assert.strictEqual(offerOf(hullEnv, h).state, S.PLANNED);
      const ok = toIssuing(h, { allowHullMarket: true }, `hb5:${h}:c`);
      assert.ok(ok.ok, JSON.stringify(ok));
      assert.deepStrictEqual([ok.offer.state, ok.offer.channel], [S.ISSUING, S.CHANNEL_MARKET]);
      const ore = planned(env, "hb-o");
      env.tx((db) => db.prepare("UPDATE world_trade_offers SET item_kind = 'ore' WHERE offer_id = ?").run(ore));
      assert.deepStrictEqual(toIssuing(ore, { allowHullMarket: true }, `hb5:${ore}:a`), refused);
    }));

  needsDriver("TBO6 breaker: 3 consecutive ISSUE_FAILED -> contracts until restart; success resets; 0 = off; config",
    () => H.withStore(driver, async (reopen) => {
      const opened = reopen();
      clockNow = AT;
      const stations = [];
      for (let i = 0; i < 13; i += 1) { stations.push(`bo-t${i}`); insertStation(opened.store, `bo-t${i}`, 60004101 + i); }
      const env = envOf(opened);
      const ad = env.adapter;
      const take = (n) => stations.splice(0, n).map((s) => planned(env, s));
      const states = (ids) => ids.map((id) => { const o = offerOf(env, id); return `${o.channel}:${o.state}:${o.endReason || ""}`; });
      const places = () => ad._calls.tradeMarketPlace || 0;

      ad._rejectPlaceOrder(true);
      const telemetry = counter();
      const a = take(4);
      clockNow += 1000;
      const exA = executorOf(opened, env, makeConfig({ maxIssuesPerPass: 8, maxMarketIssueFailures: 3 }), { telemetry });
      await exA.runPass();
      const sa = states(a);
      assert.deepStrictEqual(sa.filter((s) => s === "market:CANCELLED:ISSUE_FAILED").length, 3, JSON.stringify(sa));
      assert.deepStrictEqual(sa.filter((s) => s === "contract:OPEN:").length, 1, JSON.stringify(sa));
      assert.strictEqual(places(), 3);
      const mA = exA.getStatus().market;
      assert.deepStrictEqual([mA.tripped, mA.issueFailures, mA.maxIssueFailures], [true, 3, 3]);
      assert.strictEqual(telemetry.counts["trade.marketTripped"], 1);

      const exB = executorOf(opened, env, makeConfig({ maxIssuesPerPass: 8, maxMarketIssueFailures: 3 }));
      ad._rejectPlaceOrder(2);
      take(3);
      clockNow += 1000;
      await exB.runPass();
      ad._rejectPlaceOrder(2);
      const b2 = take(2);
      clockNow += 1000;
      await exB.runPass();
      assert.deepStrictEqual(states(b2), ["market:CANCELLED:ISSUE_FAILED", "market:CANCELLED:ISSUE_FAILED"]);
      assert.deepStrictEqual([exB.getStatus().market.tripped, exB.getStatus().market.issueFailures], [false, 2]);

      ad._rejectPlaceOrder(true);
      const exC = executorOf(opened, env, makeConfig({ maxIssuesPerPass: 8, maxMarketIssueFailures: 0 }));
      const c = take(4);
      clockNow += 1000;
      await exC.runPass();
      assert.deepStrictEqual(states(c), Array(4).fill("market:CANCELLED:ISSUE_FAILED"));
      assert.deepStrictEqual([exC.getStatus().market.tripped, exC.getStatus().market.issueFailures], [false, 4]);
      ad._rejectPlaceOrder(false);

      assert.strictEqual(DEFAULTS.trade.maxMarketIssueFailures, 3);
      const envCfg = (v) => config.resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_TRADE_MAX_MARKET_ISSUE_FAILURES: v } });
      assert.strictEqual(envCfg("0").config.trade.maxMarketIssueFailures, 0);
      const over = envCfg("33");
      assert.strictEqual(over.config.trade.maxMarketIssueFailures, 32);
      assert.ok(over.warnings.some((w) => w.includes("maxMarketIssueFailures") || w.includes("MAX_MARKET_ISSUE_FAILURES")),
        JSON.stringify(over.warnings));
    }));

  needsDriver("TBO4b startTrade: contracts off + buy orders on starts the executor; equal divisions -> market off, contract, config warning",
    () => H.withStore(driver, async (reopen) => {
      const opened = reopen();
      const shared = H.sharedOf();
      const boot = (trade) => {
        const timers = [];
        const journal = createJournal({ clock: shared.clock, maxPayloadBytes: 16384, maxRows: 500 });
        const adapter = createFakeTradeAdapter({}, { now: () => shared.clock.now() });
        const cfg = { ...DEFAULTS, trade: { ...DEFAULTS.trade, enabled: true, hullOffersEnabled: false,
          externalPriceEnabled: false, localResourcesEnabled: false, maxBuyOrderOrphansPerPass: 0,
          maxRefundSweepsPerPass: 0, virtualIssuers: false, ...trade } };
        const started = startTrade({ config: cfg, persistence: { ok: true, store: opened.store, journal },
          clock: shared.clock, ids: shared.ids, adapter, logger: { log() {} },
          getStations: () => ({ getMode: () => "ready" }),
          setTimer: (fn) => { const t = { fn, cancelled: false, cancel() { t.cancelled = true; } }; timers.push(t); return t; } });
        assert.ok(started.ok, JSON.stringify(started));
        const firePass = async () => {
          const t = timers.filter((q) => !q.cancelled).pop();
          assert.ok(t, "executor armed");
          t.cancelled = true;
          await t.fn();
        };
        return { trade: started.trade, adapter, firePass };
      };

      const a = boot({ contractsEnabled: false, buyOrdersEnabled: true });
      assert.strictEqual(a.trade.getMode(), "run");
      assert.ok(a.trade.getStatus().executor, "executor runs for the market channel alone");
      assert.deepStrictEqual(a.trade.getStatus().market, { ready: true, reason: null, down: false });
      a.trade.stop();

      const b = boot({ contractsEnabled: true, buyOrdersEnabled: true, walletAccountKey: 1006, buyOrderWalletAccountKey: 1006 });
      const market = b.trade.getStatus().market;
      assert.deepStrictEqual([market.ready, market.reason.split(" ")[0]], [false, "BUY_ORDERS_CONFIG_INVALID"]);
      insertStation(opened.store, "bo-w", 60004041);
      const at = shared.clock.now();
      const tx = (fn) => { const r = opened.store.transaction("t", fn); assert.ok(r.ok, JSON.stringify(r)); return r.value; };
      tx((db) => b.trade.budgets.fundInTx(db, { factionId: F, units: 100000, paidUntilTo: at, iskPerUnit: 1000,
        capIsk: 1000000000, at }, "fund:w"));
      const offerId = tx((db) => b.trade.offers.createOfferInTx(db, { factionId: F, stationId: "bo-w", systemId: SYSTEM,
        issuerCorporationId: CORP, itemKind: "mineral", itemKey: "type:34", typeId: TYPE_ID, quantity: QUANTITY,
        unitPriceMilli: UNIT_MILLI, iskTotal: ISK_TOTAL, refPriceMilli: 1000, capPriceMilli: 1960, priceSource: "bid",
        expiresAt: at + TTL, at }, "ik:w:offer")).offer.offerId;
      await b.firePass();
      const o = tx((db) => b.trade.offers.getOffer(db, offerId)).offer;
      assert.deepStrictEqual([o.channel, o.state], ["contract", S.OPEN]);
      assert.strictEqual(b.adapter._calls.tradeMarketPlace, undefined);
      b.trade.stop();

      const warned = config.resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_TRADE_ENABLED: "1",
        EVEJS_LNE_TRADE_BUY_ORDERS_ENABLED: "1", EVEJS_LNE_TRADE_BUY_ORDER_WALLET_ACCOUNT_KEY: "1006" } }).warnings;
      assert.ok(warned.some((w) => w.includes("BUY_ORDERS_CONFIG_INVALID")), JSON.stringify(warned));
      assert.ok(!DEFAULTS.trade.buyOrdersEnabled && config.resolveConfig({ modDir: MOD_DIR, env: {} }).warnings
        .every((w) => !w.includes("BUY_ORDERS_CONFIG_INVALID")));
    }));

  needsDriver("TBO5 migration 35 world_trade_market: from 34 and from zero, old row = contract / 0, duplicate order id refused",
    async () => {
      const fs = require("node:fs");
      const os = require("node:os");
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lne-m35-"));
      const stores = [];
      const open = (file, migrations) => {
        const o = openStore({ filePath: file, openDatabase: (f) => new driver.Database(f), exclusiveLock: true,
          busyTimeoutMs: 0, maxRowsPerTransaction: 500, maxWriteMsPerPass: 5, randomSeed: () => 1, migrations });
        assert.ok(o.ok, JSON.stringify(o));
        stores.push(o.store);
        return o;
      };
      const run = (store, fn) => { const r = store.transaction("t", fn); assert.ok(r.ok, JSON.stringify(r)); return r.value; };
      const shape = (store) => run(store, (db) => ({
        columns: db.prepare("PRAGMA table_info(world_trade_offers)").all().map((c) => c.name)
          .filter((n) => ["channel", "market_order_id", "filled_quantity"].includes(n)),
        indexes: db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name IN (?, ?) ORDER BY name")
          .all("world_trade_offers_market", "world_trade_offers_market_order").map((r) => r.name),
      }));
      const want = { columns: ["channel", "market_order_id", "filled_quantity"],
        indexes: ["world_trade_offers_market", "world_trade_offers_market_order"] };
      try {
        assert.deepStrictEqual([MIGRATIONS[34].version, MIGRATIONS[34].name], [35, "world_trade_market"]);
        const file = path.join(tmp, "up.sqlite");
        const old = open(file, MIGRATIONS.slice(0, 34));
        assert.strictEqual(old.schemaVersion, 34);
        run(old.store, (db) => db.prepare(`INSERT INTO world_trade_offers (offer_id, faction_id, station_id, system_id,
          issuer_corporation_id, item_kind, item_key, type_id, quantity, unit_price_milli, isk_total, ref_price_milli,
          cap_price_milli, price_source, state, state_seq, created_at, expires_at, updated_at, version)
          VALUES ('to_old', ?, 'st-old', ?, ?, 'mineral', 'type:34', 34, 10, 1000, 10, 1000, NULL, 'bid', 'OPEN', 2,
          1, 2, 1, 3)`).run(F, SYSTEM, CORP));
        old.store.close("upgrade");
        const up = open(file, MIGRATIONS);
        assert.deepStrictEqual(shape(up.store), want);
        assert.deepStrictEqual(run(up.store, (db) => db.prepare(
          "SELECT channel, market_order_id AS m, filled_quantity AS f FROM world_trade_offers WHERE offer_id = 'to_old'").get()),
        { channel: "contract", m: null, f: 0 });
        up.store.close("test");

        const fresh = open(path.join(tmp, "fresh.sqlite"), MIGRATIONS);
        assert.deepStrictEqual(shape(fresh.store), want);
        const journal = createJournal({ clock: CLOCK, maxPayloadBytes: 16384, maxRows: 500 });
        const budgets = createBudgetRepository({ journal, clock: CLOCK });
        const offers = createOfferRepository({ journal, budgets, ids: IDS, clock: CLOCK });
        run(fresh.store, (db) => budgets.fundInTx(db, { factionId: F, units: 100000, paidUntilTo: AT, iskPerUnit: 1000,
          capIsk: 1000000000, at: AT }, "fund:m"));
        const results = ["st-1", "st-2"].map((stationId, i) => {
          const id = run(fresh.store, (db) => offers.createOfferInTx(db, { factionId: F, stationId, systemId: SYSTEM,
            issuerCorporationId: CORP, itemKind: "mineral", itemKey: "type:34", typeId: TYPE_ID, quantity: QUANTITY,
            unitPriceMilli: UNIT_MILLI, iskTotal: ISK_TOTAL, refPriceMilli: 1000, capPriceMilli: 1960, priceSource: "bid",
            expiresAt: AT + TTL, at: AT }, `ik:m:${i}`)).offer.offerId;
          run(fresh.store, (db) => offers.transitionOfferInTx(db, { offerId: id, expectedVersion: 1, from: S.PLANNED,
            to: S.ISSUING, reason: "", at: AT, patch: { expiresAt: AT + TTL, channel: "market" } }, `k:${id}:1`));
          return run(fresh.store, (db) => offers.transitionOfferInTx(db, { offerId: id, expectedVersion: 2, from: S.ISSUING,
            to: S.OPEN, reason: "", at: AT, patch: { marketOrderId: "7000001" } }, `k:${id}:2`));
        });
        assert.deepStrictEqual([results[0].ok, results[1].reason], [true, "MARKET_ORDER_TAKEN"]);
        fresh.store.close("test");
      } finally {
        for (const s of stores) {
          try { s.close("test"); } catch (_err) {}
        }
        fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      }
    });
};
