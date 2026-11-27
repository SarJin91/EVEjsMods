"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { createTradeExecutor } = require("../../../lib/economy/trade/tradeExecutor");
const { createAdapter } = require("../../../lib/adapter");
const TM = require("../../../lib/adapter/tradeMarket");
const { chooseChannel, validateSellOrderConfig, sellProceedsIsk, classifyMarketPoll } =
  require("../../../lib/economy/trade/marketRules");
const { sellLabelOf, planReturn, planReturnOwnFirst } = require("../../../lib/economy/trade/executorRules");
const { kindBucketOf } = require("../../../lib/economy/trade/tradeView");
const { commoditySellCandidates } = require("../../../lib/strategy/ai/tradeCommodities");
const S = require("../../../lib/economy/trade/schema");
const { UNKNOWN } = require("../../../lib/names/fallback");
const { createFakeTradeAdapter } = require("../../_support/fakeTradeAdapter");
const { harness: H } = require("../../battle/settlement.test");
const { harness: W } = require("../tradeSellEscrow.test");

const F = H.FACTION_A;
const CORP = W.CORP;
const NPC_A = 60000000 + "a".charCodeAt(0);
const DAY = 86400000;
const SRC = path.resolve(__dirname, "..", "..", "..", "..", "..", "server", "src");

const vendorText = (rel) => fs.readFileSync(path.join(SRC, rel), "utf8").replace(/\r\n/g, "\n");
function bodyOf(text, header) {
  const start = text.indexOf(header);
  assert.ok(start >= 0, `vendor: ${header} missing`);
  const end = text.indexOf("\n}\n", start);
  return text.slice(start, end < 0 ? text.length : end + 3);
}
function inOrder(text, needles, label) {
  let at = -1;
  for (const n of needles) {
    const i = text.indexOf(n, at + 1);
    assert.ok(i > at, `${label}: "${n}" missing or out of order`);
    at = i;
  }
}

function fakeAdapter(shared) {
  const fake = createFakeTradeAdapter({}, { now: () => shared.clock.now() });
  fake.tradeReadIssuer = (corporationId) => Promise.resolve({ ok: true,
    issuer: { corporationId, ceoId: 3019001, isNpc: true, hasRuntime: true } });
  return fake;
}

function makeExec(env, shared, fake, over = {}) {
  const trade = { ...W.DEFAULTS.trade, enabled: true, contractsEnabled: true, wtsEnabled: true, virtualIssuers: false,
    externalPriceEnabled: false, maxBuyOrderOrphansPerPass: 0, maxRefundSweepsPerPass: 0, maxIssuesPerPass: 8,
    maxIntakesPerPass: 8, marketSellOrdersEnabled: true, iskBudgetCap: 1e9, ...over };
  return createTradeExecutor({
    store: env.store, journal: env.journal, offers: env.offers, budgets: env.budgets,
    getStations: () => env.stations, adapter: fake,
    priceCache: { put() {}, peek() { return null; }, getStatus() { return { entries: 0 }; } },
    config: { trade }, clock: shared.clock, mode: "run",
    getGovernor: () => ({ admits: () => true }), factionNames: new Map([[F, "Sansha"]]), logger: { log() {} },
  });
}

async function boot(reopen, shared) {
  const env = await W.boot(reopen(), shared, { wtsEnabled: true });
  W.addStation(env, "npc-a", F);
  const r = env.tx((db) => env.budgets.fundIskInTx(db, { factionId: F, isk: 1000, capIsk: 1e12, at: env.at }, "mso:fund"));
  assert.ok(r.ok, JSON.stringify(r));
  return env;
}

function plannedSell(env, typeId, q, tag) {
  W.seed(env, "npc-a", `type:${typeId}`, q, tag);
  const r = W.create(env, W.sellSpec(env, "npc-a", `type:${typeId}`, q), `mso:${tag}`);
  assert.ok(r.ok && !r.duplicate, JSON.stringify(r));
  return r.offer.offerId;
}

function picture(env, fake, offerId, typeId) {
  const records = [...fake._state.escrows.values()].filter((r) => r.escrowType === "sell" && r.lneOfferId === offerId);
  const asks = [...fake._state.marketOrders.values()].filter((o) => !o.bid && o.state === "open" && o.ownerId === CORP
    && o.typeId === typeId);
  const offer = W.offerOf(env, offerId);
  const escrowUnits = records.length === 1
    ? fake._escrowStacksOf(records[0].orderId).reduce((n, s) => n + s.quantity, 0) : -1;
  const stockOut = env.tx((db) => env.journal.findByKey(db, S.stockOutKey(offerId))).found === true;
  return { state: offer.state, channel: offer.channel, records: records.map((r) => r.escrowState), asks: asks.length,
    grant: fake._grantReceipts.has(S.grantKey(offerId)), stockOut, escrowUnits,
    orderMatches: records.length === 1 && offer.marketOrderId === records[0].orderId };
}

module.exports = ({ test, skip }) => {
  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  const factsName = "MSO1 vendor facts of the sell order sequence, buyer path, terminal / reconcile / sweep, "
    + "marketItemCustody, startup reconcile, tax default, GetCorporationOrders asks, skill levels of a corporation";
  if (!fs.existsSync(path.join(SRC, "services", "market", "marketProxyService.js"))) {
    skip(factsName, "server/src not found next to the mod");
  } else {
    test(factsName, () => {
      const proxy = vendorText("services/market/marketProxyService.js");
      const entry = bodyOf(proxy, "async function executeSellEntryUnlocked(");
      inOrder(entry, ["debitCharacterWallet(", "\"PlaceOrder\"", "bid: false", "source: \"player\"",
        "MARKET_ESCROW_LOCATION_BASE + normalizePositiveInteger(placedOrder.order_id", "sourceOwnerId:",
        "sourceLocationId:", "sourceFlagId:", "isCorp:", "walletOwnerId:", "accountKey:", "escrowLocationID,",
        "remainingQuantity:", "escrowState: MARKET_ESCROW_STATE_PLACING", "marketItemCustody.transferItem(",
        "expectedSource: escrowSource", "CUSTODY_REASON.MARKET_ESCROW_PLACE", "escrowState: MARKET_ESCROW_STATE_ACTIVE",
        "removeEscrowRecordDurable(placedOrder.order_id)", "\"CancelOrder\"", "CUSTODY_REASON.MARKET_ESCROW_RETURN"],
        "executeSellEntryUnlocked");
      assert.ok(proxy.includes("const MARKET_ESCROW_STATE_PLACING = \"placing\";"));
      assert.ok(proxy.includes("const MARKET_ESCROW_STATE_ACTIVE = \"active\";"));
      assert.ok(bodyOf(proxy, "function upsertSellEscrowRecord(").includes("escrowType: \"sell\""));
      assert.ok(bodyOf(proxy, "function getEscrowState(").includes("return escrowState || MARKET_ESCROW_STATE_ACTIVE;"));
      const buyer = bodyOf(proxy, "async function matchSellOrdersForBuyer(");
      inOrder(buyer, ["source || \"\").toLowerCase() === \"seed\"", "getEscrowRecord(sellOrder", "is missing escrow state",
        "escrowRecord.isCorp", "computeSalesTaxAmount(sellerMarketContext"], "matchSellOrdersForBuyer");
      const items = bodyOf(proxy, "function listEscrowItemsForOrder(");
      assert.ok(items.includes("escrowRecord.sourceOwnerId") && items.includes("ITEM_FLAGS.HANGAR"));
      const saga = bodyOf(proxy, "async function executePlayerSellFillSagaUnlocked(");
      inOrder(saga, ["removeEscrowRecordDurable(saga.orderID)", "...escrowRecord,"], "sell saga");
      const terminal = bodyOf(proxy, "async function applyTerminalOrderEvent(");
      assert.ok(terminal.includes("escrowType !== (isBuyOrder ? \"buy\" : \"sell\")"));
      const dest = bodyOf(proxy, "function resolveEscrowReturnDestination(");
      inOrder(dest, ["sourceOwnerId", "sourceLocationId", "sourceFlagId"], "resolveEscrowReturnDestination");
      const placing = bodyOf(proxy, "async function reconcilePlacingSellEscrowRecords(");
      inOrder(placing, ["escrowedItems.length > 0", "escrowState: MARKET_ESCROW_STATE_ACTIVE", "\"CancelOrder\"",
        "removeEscrowRecordDurable(orderID)"], "reconcilePlacingSellEscrowRecords");
      assert.ok(bodyOf(proxy, "async function sweepStrandedMarketEscrowItems(").includes("if (getEscrowRecord(orderID))"));
      inOrder(bodyOf(proxy, "async function reconcileDurableMarketOrders("), ["reconcilePlacingSellEscrowRecords()",
        "sweepStrandedMarketEscrowItems()"], "reconcileDurableMarketOrders");
      const corpOrders = proxy.slice(proxy.indexOf("async Handle_GetCorporationOrders("),
        proxy.indexOf("async Handle_GetMarketOrderHistory("));
      assert.ok(corpOrders.includes("\"GetCorporationOrders\"") && !/\bbid\b/.test(corpOrders), "no bid filter");

      const custody = vendorText("services/inventory/marketItemCustody.js");
      assert.ok(custody.includes("const MARKET_ESCROW_LOCATION_BASE = 9_200_000_000;"));
      assert.ok(custody.includes("MARKET_ESCROW_LOCATION_BASE + 100_000_000;"));
      const transfer = bodyOf(custody, "function transferItem(");
      inOrder(transfer, ["MARKET_ESCROW_PLACE &&", "isEscrowDestination &&", "Boolean(expectedSource)",
        "MARKET_ESCROW_RETURN && isEscrowSource", "idempotencyKey:"], "transferItem");
      const exportsBlock = custody.slice(custody.lastIndexOf("module.exports = {"));
      for (const name of ["MARKET_ESCROW_LOCATION_BASE,", "getEscrowLocationID,", "transferItem,"]) {
        assert.ok(exportsBlock.includes(name), `marketItemCustody exports ${name}`);
      }
      assert.ok(vendorText("services/scheduler/productionSchedulerRuntime.js").includes("reconcileDurableMarketOrders()"));
      const rules = vendorText("services/market/marketRules.js");
      assert.ok(vendorText("services/market/marketTransactionTax.js")
        .includes("const MARKET_TRANSACTION_TAX_DEFAULT_PERCENT = 7.5;"));
      assert.ok(rules.includes("} = require(path.join(__dirname, \"./marketTransactionTax\"));")
        && rules.includes("let transactionTaxRate = MARKET_TRANSACTION_TAX_DEFAULT_PERCENT / 100.0;"));
      assert.ok(bodyOf(rules, "function getCharacterMarketSkillLevels(")
        .includes("clampSkillLevel(record && record.effectiveSkillLevel)"));
    });
  }

  test("MSO2 rules: chooseChannel sell, validateSellOrderConfig, sellProceedsIsk, classifyMarketPoll by side "
    + "shortKeys, sellLabelOf, kindBucketOf", () => {
    const npc = { kind: "npc" };
    const sell = (over) => ({ side: "sell", itemKind: "mineral", unitPriceMilli: 1100, ...over });
    const flags = (over) => ({ contractsEnabled: true, buyOrdersEnabled: true, marketReady: true, marketDown: false,
      sellOrdersEnabled: true, ...over });
    assert.strictEqual(chooseChannel(sell(), npc, flags({ sellOrdersEnabled: false })), "contract", "flag off");
    assert.strictEqual(chooseChannel({ itemKind: "mineral", unitPriceMilli: 1100 }, npc, flags({ sellOrdersEnabled: false })),
      "market", "buy unchanged");
    for (const kind of ["mineral", "moon", "pi"]) assert.strictEqual(chooseChannel(sell({ itemKind: kind }), npc, flags()), "market");
    assert.strictEqual(chooseChannel(sell(), npc, flags({ buyOrdersEnabled: false, marketReady: false })), "market",
      "sell orders without the buy orders");
    for (const [o, st, f] of [[sell({ itemKind: "hull" }), npc, flags()], [sell({ itemKind: "ore" }), npc, flags()],
      [sell(), { kind: "upwell" }, flags()], [sell({ issuerCharacterId: 9 }), npc, flags()],
      [sell(), npc, flags({ marketDown: true })], [sell({ unitPriceMilli: 9 }), npc, flags()]]) {
      assert.strictEqual(chooseChannel(o, st, f), "contract", JSON.stringify(o));
    }
    const cfg = { buyOrderWalletAccountKey: 1005, walletAccountKey: 1006, wtsTtlMs: 3 * DAY };
    assert.deepStrictEqual(validateSellOrderConfig({ ...cfg, sellOrderDurationDays: 7 }), { ok: true });
    assert.strictEqual(validateSellOrderConfig({ ...cfg, sellOrderDurationDays: 3 }).reason, "SELL_ORDERS_CONFIG_INVALID");
    assert.strictEqual(validateSellOrderConfig({ ...cfg, sellOrderDurationDays: 5 }).reason, "SELL_ORDERS_CONFIG_INVALID");
    const offer = { quantity: 100, iskTotal: 10000, unitPriceMilli: 12340 };
    assert.strictEqual(sellProceedsIsk(offer, 60), 740);
    assert.strictEqual(sellProceedsIsk(offer, 500), 1234, "F > Q -> Q");
    assert.strictEqual(sellProceedsIsk({ ...offer, iskTotal: 700 }, 60), 700, "cap iskTotal");
    const o = { offerId: "o1", side: "sell", quantity: 100, filledQuantity: 0 };
    const rec = (type) => ({ escrowType: type, lneOfferId: "o1", pendingFill: false });
    const open = { missing: false, order: { state: "open", volRemaining: 100 } };
    assert.deepStrictEqual(classifyMarketPoll(o, { ...open, escrow: rec("sell") }, "EXPIRED", false).action, "CLOSE");
    assert.deepStrictEqual(classifyMarketPoll(o, { ...open, escrow: rec("buy") }, "EXPIRED", false).action,
      "CANCEL_THEN_SETTLE", "a buy record of a sell offer is no record");
    assert.deepStrictEqual(classifyMarketPoll({ ...o, side: "buy" }, { ...open, escrow: rec("buy") }, "EXPIRED", false)
      .action, "CLOSE", "buy unchanged");

    const MOON = "type:16634";
    const trade = (commodity) => ({ stations: [{ stationId: "npc-1", kind: "npc" }], commodity: { kinds: { [MOON]: "moon" },
      reserve: { "npc-1": {} }, enforced: { fuel: true, advanced: false }, ...commodity } });
    const T = { commodityFloatPermille: 100, commodityMinSellUnits: 10 };
    const data = [{ stationId: "npc-1", commodities: { [MOON]: 1000 } }];
    const cut = [{ stationId: "npc-2", itemKey: "type:44", need: 5 }];
    assert.strictEqual(commoditySellCandidates({ trade: trade({ needs: cut }), T, stationsData: data }).candidates.length,
      1, "without shortKeys: as before (the cut need hides nothing)");
    assert.strictEqual(commoditySellCandidates({ trade: trade({ needs: cut, shortKeys: ["npc-1|type:16634",
      "npc-2|type:44"] }), T, stationsData: data }).candidates.length, 0, "shortKeys blocks the hidden pair");

    assert.strictEqual(sellLabelOf({ itemKind: "moon", typeId: 16634 }, "Hydrocarbons"), "Hydrocarbons");
    assert.strictEqual(sellLabelOf({ itemKind: "pi", typeId: 2393 }), UNKNOWN.item, "no bare id");
    assert.strictEqual(sellLabelOf({ itemKind: "mineral", typeId: 34 }, "x"), "Tritanium");
    assert.strictEqual(sellLabelOf({ itemKind: "hull", itemKey: "group:cruiser", typeId: 1 }), "cruiser hull");
    assert.deepStrictEqual(["moon", "pi", "mineral", "ore"].map((k) => kindBucketOf({ itemKind: k, itemKey: "type:1" })),
      ["commodity", "commodity", "mineral", "ore"]);
    assert.strictEqual(kindBucketOf({ itemKind: "hull", itemKey: "group:cruiser" }), "hull");
  });

  test("MSO3 sell facade: find -> PlaceOrder -> placing -> transfer (pin, msplace) -> active; active again = no write; "
    + "failed transfer -> remove before CancelOrder, goods back; record present -> ESCROW_PRESENT", async () => {
    let now = 5000000;
    const fake = createFakeTradeAdapter({}, { now: () => now });
    const seq = fake._sellLog;
    const daemon = fake._marketDaemon;
    const realCall = daemon.call;
    daemon.call = (method, params) => { seq.push(["rpc", method]); return realCall.call(daemon, method, params); };
    const grant = (offerId, q) => fake.tradeGrantStock({ ownerKind: "corporation", ownerId: CORP, npcStationId: NPC_A,
      typeId: 34, quantity: q, key: S.grantKey(offerId), flag: "hangar" });
    const g = grant("o1", 100);
    assert.ok(g.ok, JSON.stringify(g));
    assert.deepStrictEqual(fake._hangarStacksOf(CORP, NPC_A).map((s) => [s.quantity, s.flag]), [[100, 4]], "flag 4");
    const spec = { offerId: "o1", side: "sell", corporationId: CORP, accountKey: 1005, stationId: NPC_A, typeId: 34,
      quantity: 100, priceCents: 110, durationDays: 7, grantKey: S.grantKey("o1"), grantItemIds: g.itemIds };
    const placed = await fake.tradeMarketPlaceSell(spec);
    assert.ok(placed.ok, JSON.stringify(placed));
    const orderId = placed.orderId;
    assert.deepStrictEqual(seq.map((e) => e.slice(0, 3)), [["rpc", "GetCorporationOrders"], ["rpc", "PlaceOrder"],
      ["put", orderId, "placing"], ["place", orderId, g.itemIds[0]], ["put", orderId, "active"]]);
    assert.strictEqual(seq[3][4], S.marketSellEscrowKey("o1", orderId, g.itemIds[0]), "msplace key = schema");
    const p = fake._placeParams[0];
    assert.deepStrictEqual([p.owner_id, p.is_corp, p.bid, p.range_value, p.min_volume, p.source, p.price, p.quantity,
      p.duration_days], [CORP, true, false, -1, 1, "player", 1.1, 100, 7]);
    const rec = fake._state.escrows.get(orderId);
    assert.deepStrictEqual([rec.escrowType, rec.escrowState, rec.lneOfferId, rec.ownerId, rec.sourceOwnerId,
      rec.sourceLocationId, rec.sourceFlagId, rec.isCorp, rec.walletOwnerId, rec.accountKey, rec.escrowLocationID,
      rec.remainingQuantity], ["sell", "active", "o1", CORP, CORP, NPC_A, 4, true, CORP, 1005,
      9200000000 + Number(orderId), 100]);
    assert.deepStrictEqual(fake._escrowStacksOf(orderId).map((s) => s.quantity), [100]);

    seq.length = 0;
    const again = await fake.tradeMarketPlaceSell(spec);
    assert.deepStrictEqual(again, { ok: true, orderId, duplicate: true });
    assert.deepStrictEqual(seq.filter((e) => e[0] !== "rpc"), [], "found escrow active: no write");
    assert.deepStrictEqual(fake.tradeMarketReturnSellEscrow({ offerId: "o1", orderId, corporationId: CORP,
      stationId: NPC_A, typeId: 34 }), { ok: false, reason: "ESCROW_PRESENT" });

    fake._addHangarStack(CORP, NPC_A, 880001, 35, 30, 4);
    fake._addHangarStack(CORP, NPC_A, 880002, 35, 20, 4);
    const custody = fake._sellSeams.marketCustody;
    const realTransfer = custody.transferItem;
    let n = 0;
    custody.transferItem = (cmd) => (++n === 2 ? { success: false, errorMsg: "ITEM_CUSTODY_SOURCE_MISMATCH" }
      : realTransfer.call(custody, cmd));
    seq.length = 0;
    const failed = await fake.tradeMarketPlaceSell({ ...spec, offerId: "o2", typeId: 35, quantity: 50,
      grantKey: S.grantKey("o2"), grantItemIds: [880001, 880002] });
    custody.transferItem = realTransfer;
    assert.deepStrictEqual([failed.ok, failed.reason, failed.permanent], [false, "MARKET_ESCROW_FAILED", false]);
    const order2 = seq.find((e) => e[0] === "put")[1];
    inOrder(JSON.stringify(seq), [`["remove","${order2}"]`, "[\"rpc\",\"CancelOrder\"]", `["return","${order2}",880001`],
      "rollback order");
    assert.strictEqual(fake._state.escrows.has(order2), false);
    assert.strictEqual(fake._state.marketOrders.get(order2).state, "cancelled");
    assert.deepStrictEqual(fake._hangarStacksOf(CORP, NPC_A).filter((s) => s.typeId === 35).map((s) => s.quantity)
      .sort(), [20, 30], "goods back in the hangar");
    assert.ok(seq.some((e) => e[0] === "return" && e[4] === S.marketSellReturnKey("o2", order2, 880001)), "mret key");
  });

  needsDriver("MSO4 restart at each issue step -> one record, one ask, one grant, one stock-out, OPEN; startup race "
    + "-> CANCELLED with the stock back once", () => H.withStore(driver, async (reopen) => {
    const shared = H.sharedOf();
    const env = await boot(reopen, shared);
    const fake = fakeAdapter(shared);
    const exec = makeExec(env, shared, fake);
    const Q = 100;
    const expectOpen = (offerId, typeId, label) => assert.deepStrictEqual(picture(env, fake, offerId, typeId),
      { state: "OPEN", channel: "market", records: ["active"], asks: 1, grant: true, stockOut: true, escrowUnits: Q,
        orderMatches: true }, label);
    const scenarios = [
      ["grant", 34, () => fake._crashAfter("tradeGrantStock"), null],
      ["PlaceOrder", 35, () => fake._losePlaceResponse(), null],
      ["placing+reconcile", 36, () => fake._crashTransfer("before"), () => fake._reconcilePlacing()],
      ["placing", 37, () => fake._crashTransfer("before"), null],
      ["transfer+reconcile", 38, () => fake._crashTransfer("after"), () => fake._reconcilePlacing()],
      ["active", 39, () => fake._crashAfter("tradeMarketPlaceSell"), null],
    ];
    for (const [label, typeId, crash, restart] of scenarios) {
      const offerId = plannedSell(env, typeId, Q, label);
      crash();
      await exec.runPass();
      assert.notStrictEqual(W.offerOf(env, offerId).state, "OPEN", `${label}: the crash stops before OPEN`);
      if (restart) restart();
      const res = await makeExec(env, shared, fake).runPass();
      assert.strictEqual(res.errors, 0, `${label} ${JSON.stringify(res)}`);
      expectOpen(offerId, typeId, label);
    }
    const asksOf36 = [...fake._state.marketOrders.values()].filter((o) => !o.bid && o.typeId === 36);
    assert.deepStrictEqual(asksOf36.map((o) => o.state).sort(), ["cancelled", "open"], "reconcile cancelled the first");

    const offerId = plannedSell(env, 40, Q, "race");
    await exec.runPass();
    expectOpen(offerId, 40, "race open");
    const stockBefore = W.stockOf(env, "npc-a", "type:40");
    const orderId = W.offerOf(env, offerId).marketOrderId;
    fake._state.marketOrders.get(orderId).state = "cancelled";
    fake._state.escrows.delete(orderId);
    const r1 = await makeExec(env, shared, fake).runPass();
    assert.strictEqual(r1.errors, 0, JSON.stringify(r1));
    const o = W.offerOf(env, offerId);
    assert.deepStrictEqual([o.state, o.endReason, o.deliveredQuantity], ["CANCELLED", "MARKET_CANCELLED", Q]);
    assert.strictEqual(W.stockOf(env, "npc-a", "type:40"), stockBefore + Q);
    assert.deepStrictEqual(fake._escrowStacksOf(orderId), [], "escrow empty");
    await makeExec(env, shared, fake).runPass();
    assert.strictEqual(W.stockOf(env, "npc-a", "type:40"), stockBefore + Q, "stock back exactly once");
  }));

  needsDriver("MSO5 settlement: partial + TTL -> ACCEPTED 60 + return 40 -> DELIVERED, proceeds, stock +40, replay "
    + "no change; F = 0 expiry -> CANCELLED +Q; full sale -> no return; flag off -> DISABLED; fake facades", () =>
    H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const env = await boot(reopen, shared);
      const fake = fakeAdapter(shared);
      const Q = 100;
      const openSell = async (typeId, tag) => {
        const offerId = plannedSell(env, typeId, Q, tag);
        await makeExec(env, shared, fake).runPass();
        const o = W.offerOf(env, offerId);
        assert.deepStrictEqual([o.state, o.channel], ["OPEN", "market"], JSON.stringify(o));
        return o;
      };
      const proceeds = () => env.tx((db) => env.budgets.getBudget(db, F)).budget.wtsProceedsTotal;

      const a = await openSell(34, "part");
      const stockA = W.stockOf(env, "npc-a", "type:34");
      const before = proceeds();
      assert.ok(fake._fillSell(a.marketOrderId, 60));
      shared.clock.advance(a.expiresAt - shared.clock.now());
      let res = await makeExec(env, shared, fake).runPass();
      assert.strictEqual(res.errors, 0, JSON.stringify(res));
      let o = W.offerOf(env, a.offerId);
      assert.deepStrictEqual([o.state, o.filledQuantity, o.deliveredQuantity], ["DELIVERED", 60, 60]);
      const ret = env.tx((db) => env.journal.findByKey(db, S.returnOutboxKey(a.offerId)));
      assert.deepStrictEqual([ret.entry.state, ret.entry.payload.flag,
        ret.entry.payload.stacks.reduce((n, s) => n + s.quantity, 0)], ["APPLIED", "hangar", 40]);
      const isk = sellProceedsIsk(o, 60);
      assert.strictEqual(isk, 66);
      assert.strictEqual(proceeds(), before + isk);
      assert.strictEqual(W.stockOf(env, "npc-a", "type:34"), stockA + 40);
      assert.strictEqual(fake._state.escrows.has(a.marketOrderId), false, "detached");
      await makeExec(env, shared, fake).runPass();
      assert.deepStrictEqual([proceeds(), W.stockOf(env, "npc-a", "type:34")], [before + isk, stockA + 40], "replay");

      const b = await openSell(35, "zero");
      const stockB = W.stockOf(env, "npc-a", "type:35");
      assert.ok(fake._terminal(b.marketOrderId, "expired"));
      res = await makeExec(env, shared, fake).runPass();
      assert.strictEqual(res.errors, 0, JSON.stringify(res));
      o = W.offerOf(env, b.offerId);
      assert.deepStrictEqual([o.state, o.endReason, o.deliveredQuantity], ["CANCELLED", "MARKET_EXPIRED", Q]);
      assert.strictEqual(W.stockOf(env, "npc-a", "type:35"), stockB + Q);

      const c = await openSell(36, "full");
      const stockC = W.stockOf(env, "npc-a", "type:36");
      assert.ok(fake._fillSell(c.marketOrderId, Q));
      res = await makeExec(env, shared, fake).runPass();
      assert.strictEqual(res.errors, 0, JSON.stringify(res));
      o = W.offerOf(env, c.offerId);
      assert.deepStrictEqual([o.state, o.filledQuantity, o.deliveredQuantity], ["DELIVERED", Q, Q]);
      assert.strictEqual(env.tx((db) => env.journal.findByKey(db, S.returnOutboxKey(c.offerId))).found, false);
      assert.strictEqual(W.stockOf(env, "npc-a", "type:36"), stockC);

      const d = await openSell(37, "off");
      const stockD = W.stockOf(env, "npc-a", "type:37");
      res = await makeExec(env, shared, fake, { marketSellOrdersEnabled: false }).runPass();
      assert.strictEqual(res.errors, 0, JSON.stringify(res));
      o = W.offerOf(env, d.offerId);
      assert.deepStrictEqual([o.state, o.endReason], ["CANCELLED", "DISABLED"]);
      assert.strictEqual(W.stockOf(env, "npc-a", "type:37"), stockD + Q);
      assert.strictEqual(fake._state.marketOrders.get(d.marketOrderId).state, "cancelled");

      const real = createAdapter({ moduleApi: { _cache: {} }, logger: { log() {} } });
      const missing = Object.keys(real).filter((k) => k.startsWith("tradeMarket") && k !== "tradeMarketFillMode"
        && typeof fake[k] !== "function");
      assert.deepStrictEqual(missing, []);
      assert.strictEqual(typeof TM.placeAndAttachSellOrderFrom, "function");
    }));

  needsDriver("MSO6 ACCEPTED market sell, void of the rest fails intakeMaxRetries passes -> DELIVERED "
    + "with the proceeds of F once, no LOST, no stock-back, return markFailed; replay no change", () =>
    H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const env = await boot(reopen, shared);
      const fake = fakeAdapter(shared);
      const counts = new Map();
      const telemetry = { count(name, v) { counts.set(name, (counts.get(name) || 0) + v); } };
      const Q = 100;
      const offerId = plannedSell(env, 34, Q, "abandon");
      await makeExec(env, shared, fake).runPass();
      const a = W.offerOf(env, offerId);
      assert.deepStrictEqual([a.state, a.channel], ["OPEN", "market"], JSON.stringify(a));
      const stock = W.stockOf(env, "npc-a", "type:34");
      const proceeds = () => env.tx((db) => env.budgets.getBudget(db, F)).budget.wtsProceedsTotal;
      const before = proceeds();
      assert.ok(fake._fillSell(a.marketOrderId, 60));
      shared.clock.advance(a.expiresAt - shared.clock.now());

      let voids = 0;
      const realVoid = fake.tradeVoidStack;
      fake.tradeVoidStack = () => { voids += 1; return Promise.resolve({ ok: false, reason: "CUSTODY_FAILED", permanent: false }); };
      const MAX = 3;
      const exec = createTradeExecutor({
        store: env.store, journal: env.journal, offers: env.offers, budgets: env.budgets,
        getStations: () => env.stations, adapter: fake, telemetry,
        priceCache: { put() {}, peek() { return null; }, getStatus() { return { entries: 0 }; } },
        config: { trade: { ...W.DEFAULTS.trade, enabled: true, contractsEnabled: true, wtsEnabled: true,
          virtualIssuers: false, externalPriceEnabled: false, maxBuyOrderOrphansPerPass: 0, maxRefundSweepsPerPass: 0,
          maxIssuesPerPass: 8, maxIntakesPerPass: 8, marketSellOrdersEnabled: true, iskBudgetCap: 1e9,
          intakeMaxRetries: MAX } },
        clock: shared.clock, mode: "run", getGovernor: () => ({ admits: () => true }),
        factionNames: new Map([[F, "Sansha"]]), logger: { log() {} },
      });
      for (let i = 0; i < MAX + 2 && W.offerOf(env, offerId).state !== "DELIVERED"; i += 1) await exec.runPass();
      fake.tradeVoidStack = realVoid;
      const o = W.offerOf(env, offerId);
      assert.deepStrictEqual([o.state, o.filledQuantity, o.deliveredQuantity], ["DELIVERED", 60, 60], JSON.stringify(o));
      assert.strictEqual(voids, MAX, "one failed void per pass, abandon after MAX passes");
      const isk = sellProceedsIsk(o, 60);
      assert.strictEqual(proceeds(), before + isk, "proceeds of F once");
      assert.strictEqual(W.stockOf(env, "npc-a", "type:34"), stock, "no stock-back");
      const ret = env.tx((db) => env.journal.findByKey(db, S.returnOutboxKey(offerId)));
      assert.strictEqual(ret.entry.state, "FAILED");
      assert.strictEqual(counts.get("trade.marketSellReturnAbandoned"), 40);
      assert.strictEqual(counts.get("trade.intakeRetriesExhausted"), 1);
      assert.strictEqual(counts.get("trade.lost") || 0, 0, "no LOST");
      await exec.runPass();
      await makeExec(env, shared, fake).runPass();
      assert.deepStrictEqual([W.offerOf(env, offerId).state, proceeds(), W.stockOf(env, "npc-a", "type:34")],
        ["DELIVERED", before + isk, stock], "replay");
    }));

  needsDriver("MSO7 place rollback with a failed CancelOrder -> ambiguous + rollbackFailed, counter, no "
    + "abort; next pass finds the open ask and repairs it -> OPEN with one record and one ask", () =>
    H.withStore(driver, async (reopen) => {
      const fakeF = createFakeTradeAdapter({}, { now: () => 5000000 });
      const daemonF = fakeF._marketDaemon;
      const realCallF = daemonF.call;
      const failCancel = (d, real) => {
        let left = 1;
        d.call = (method, params) => {
          if (method === "CancelOrder" && left > 0) { left -= 1; return Promise.reject(new Error("cancel boom")); }
          return real.call(d, method, params);
        };
      };
      const g = fakeF.tradeGrantStock({ ownerKind: "corporation", ownerId: CORP, npcStationId: NPC_A, typeId: 34,
        quantity: 50, key: S.grantKey("r1"), flag: "hangar" });
      assert.ok(g.ok, JSON.stringify(g));
      const custodyF = fakeF._sellSeams.marketCustody;
      const realTransferF = custodyF.transferItem;
      custodyF.transferItem = () => ({ success: false, errorMsg: "ITEM_CUSTODY_SOURCE_MISMATCH" });
      failCancel(daemonF, realCallF);
      const spec = { offerId: "r1", side: "sell", corporationId: CORP, accountKey: 1005, stationId: NPC_A, typeId: 34,
        quantity: 50, priceCents: 110, durationDays: 7, grantKey: S.grantKey("r1"), grantItemIds: g.itemIds };
      const res = await fakeF.tradeMarketPlaceSell(spec);
      custodyF.transferItem = realTransferF;
      assert.deepStrictEqual([res.ok, res.ambiguous, res.rollbackFailed], [false, true, "CANCEL"], JSON.stringify(res));
      const openAsks = [...fakeF._state.marketOrders.values()].filter((x) => !x.bid && x.state === "open");
      assert.strictEqual(openAsks.length, 1, "the ask stays open without a record");
      assert.strictEqual(fakeF._state.escrows.size, 0);

      const shared = H.sharedOf();
      const env = await boot(reopen, shared);
      const fake = fakeAdapter(shared);
      const counts = new Map();
      const telemetry = { count(name, v) { counts.set(name, (counts.get(name) || 0) + v); } };
      const custody = fake._sellSeams.marketCustody;
      const realTransfer = custody.transferItem;
      custody.transferItem = () => ({ success: false, errorMsg: "ITEM_CUSTODY_SOURCE_MISMATCH" });
      failCancel(fake._marketDaemon, fake._marketDaemon.call);
      const offerId = plannedSell(env, 35, 100, "rollback");
      const mk = () => createTradeExecutor({
        store: env.store, journal: env.journal, offers: env.offers, budgets: env.budgets,
        getStations: () => env.stations, adapter: fake, telemetry,
        priceCache: { put() {}, peek() { return null; }, getStatus() { return { entries: 0 }; } },
        config: { trade: { ...W.DEFAULTS.trade, enabled: true, contractsEnabled: true, wtsEnabled: true,
          virtualIssuers: false, externalPriceEnabled: false, maxBuyOrderOrphansPerPass: 0, maxRefundSweepsPerPass: 0,
          maxIssuesPerPass: 8, maxIntakesPerPass: 8, marketSellOrdersEnabled: true, iskBudgetCap: 1e9 } },
        clock: shared.clock, mode: "run", getGovernor: () => ({ admits: () => true }),
        factionNames: new Map([[F, "Sansha"]]), logger: { log() {} },
      });
      const exec = mk();
      await exec.runPass();
      custody.transferItem = realTransfer;
      assert.strictEqual(counts.get("trade.marketSellRollbackFailed"), 1);
      assert.strictEqual(W.offerOf(env, offerId).state, "ISSUING", "no abort after an incomplete rollback");
      await exec.runPass();
      assert.deepStrictEqual(picture(env, fake, offerId, 35), { state: "OPEN", channel: "market", records: ["active"],
        asks: 1, grant: true, stockOut: true, escrowUnits: 100, orderMatches: true });
    }));

  needsDriver("MSO8 the return plan takes the stacks of its own escrow return first: an older stack "
    + "of the type in the corporation hangar (left by an earlier offer, its void fails) is not planned -> DELIVERED, "
    + "stock +40, the old stack untouched", () =>
    H.withStore(driver, async (reopen) => {
      const hangar = [{ itemId: 5, quantity: 7 }, { itemId: 9, quantity: 40 }];
      assert.deepStrictEqual(planReturnOwnFirst(40, hangar, []), planReturn(40, hangar));
      assert.deepStrictEqual(planReturnOwnFirst(40, hangar, [9]), { stacks: [{ itemId: 9, quantity: 40 }], planned: 40 });
      assert.deepStrictEqual(planReturnOwnFirst(45, hangar, [9]),
        { stacks: [{ itemId: 9, quantity: 40 }, { itemId: 5, quantity: 5 }], planned: 45 });

      const shared = H.sharedOf();
      const env = await boot(reopen, shared);
      const fake = fakeAdapter(shared);
      const Q = 100;
      const dead = fake.tradeGrantStock({ ownerKind: "corporation", ownerId: CORP, npcStationId: NPC_A, typeId: 34,
        quantity: 7, key: S.grantKey("mso8-dead"), flag: "hangar" });
      assert.ok(dead.ok, JSON.stringify(dead));
      const deadId = dead.itemIds[0];
      const offerId = plannedSell(env, 34, Q, "ownfirst");
      await makeExec(env, shared, fake).runPass();
      const a = W.offerOf(env, offerId);
      assert.deepStrictEqual([a.state, a.channel], ["OPEN", "market"], JSON.stringify(a));
      const stock = W.stockOf(env, "npc-a", "type:34");
      assert.ok(fake._fillSell(a.marketOrderId, 60));
      shared.clock.advance(a.expiresAt - shared.clock.now());

      const voided = [];
      const realVoid = fake.tradeVoidStack;
      fake.tradeVoidStack = (spec) => {
        voided.push(spec.itemId);
        return spec.itemId === deadId ? Promise.resolve({ ok: false, reason: "CUSTODY_FAILED", permanent: false })
          : realVoid.call(fake, spec);
      };
      const res = await makeExec(env, shared, fake).runPass();
      fake.tradeVoidStack = realVoid;
      assert.strictEqual(res.errors, 0, JSON.stringify(res));
      const ret = env.tx((db) => env.journal.findByKey(db, S.returnOutboxKey(offerId)));
      const planIds = ret.entry.payload.stacks.map((s) => s.itemId);
      assert.ok(!planIds.includes(deadId), `plan ${JSON.stringify(ret.entry.payload.stacks)} took the old stack`);
      assert.deepStrictEqual([ret.entry.state, ret.entry.payload.stacks.reduce((n, s) => n + s.quantity, 0)],
        ["APPLIED", 40]);
      assert.ok(!voided.includes(deadId), "no void of the old stack");
      const o = W.offerOf(env, offerId);
      assert.deepStrictEqual([o.state, o.filledQuantity, o.deliveredQuantity], ["DELIVERED", 60, 60], JSON.stringify(o));
      assert.strictEqual(W.stockOf(env, "npc-a", "type:34"), stock + 40);
      const listed = await fake.tradeListDeliveredStacks({ ownerKind: "corporation", ownerId: CORP, corporationId: CORP,
        npcStationId: NPC_A, typeId: 34, flag: "hangar" });
      assert.deepStrictEqual(listed.stacks.filter((s) => s.itemId === deadId).map((s) => s.quantity), [7]);
    }));
};
