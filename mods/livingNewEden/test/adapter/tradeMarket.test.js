"use strict";

const assert = require("node:assert");
const path = require("node:path");

const TM = require("../../lib/adapter/tradeMarket");
const { listDeliveredStacksFrom } = require("../../lib/adapter/tradeContracts");
const { readTradePricesFrom } = require("../../lib/adapter/marketPrices");
const { createAdapter } = require("../../lib/adapter");
const { createFakeVendorTags } = require("../_support/fakeVendorTags");

const CORP = 98000001;
const STATION = 60003760;
const TYPE = 34;
const PAYLOAD = Object.freeze({ offerId: "offer-1", corporationId: CORP, stationId: STATION, typeId: TYPE,
  quantity: 100, priceCents: 1250, durationDays: 30, minVolume: 1 });

function daemonError(message, { code, requestSent, outcomeUnknown } = {}) {
  const err = new Error(message);
  if (code) err.code = code;
  if (requestSent !== undefined) err.marketDaemonRequestSent = requestSent === true;
  if (outcomeUnknown !== undefined) err.marketDaemonOutcomeUnknown = outcomeUnknown === true;
  return err;
}
const rejected = (m) => daemonError(m, { code: "MARKET_DAEMON_RPC_REJECTED", requestSent: true, outcomeUnknown: false });
const timedOut = () => daemonError("market daemon RPC request timed out after 5000 ms",
  { code: "MARKET_DAEMON_RPC_TIMEOUT", requestSent: true, outcomeUnknown: true });

function fakeDaemon(handlers) {
  const calls = [];
  return {
    calls,
    async call(method, params) {
      calls.push({ method, params });
      let h = handlers[method];
      if (typeof h === "function") h = h(params);
      if (h instanceof Error) throw h;
      if (h === undefined) throw rejected(`unknown method ${method}`);
      return h;
    },
  };
}

function fakeEscrow() {
  const records = new Map();
  const writes = { put: 0, remove: 0 };
  return {
    records,
    writes,
    getEscrowRecord: (id) => (records.has(String(id)) ? JSON.parse(JSON.stringify(records.get(String(id)))) : null),
    listEscrowRecords: () => [...records.values()].map((r) => JSON.parse(JSON.stringify(r))),
    putEscrowRecordDurable(rec) {
      writes.put += 1;
      records.set(String(rec.orderId), { ...rec });
      return { success: true, errorMsg: null, flushed: true };
    },
    removeEscrowRecordDurable(id) {
      writes.remove += 1;
      records.delete(String(id));
      return { success: true, errorMsg: null, flushed: true };
    },
  };
}

function ownerOrder(orderId, state, row = {}) {
  return { order_id: orderId, owner_id: CORP, is_corp: true, state,
    row: { order_id: orderId, price: 12.5, vol_remaining: 40, vol_entered: 100, type_id: TYPE, station_id: STATION,
      bid: true, issued_at: "2026-10-30T10:00:00.000Z", duration_days: 30, min_volume: 1, range_value: -1, ...row } };
}

function attachSpec(over = {}) {
  return { orderId: "501", ownerId: CORP, accountKey: 1005, typeId: TYPE, stationId: STATION, priceCents: 1250,
    remainingQuantity: 100, issuedAt: "2026-10-30T10:00:00.000Z", durationDays: 30, lneOfferId: "offer-1",
    at: Date.UTC(2026, 9, 30, 10), ...over };
}

module.exports = ({ test }) => {
  test("TM1 buildBuyOrderCall stable params, invalid payload; attachBuyEscrow fields, PRESENT, ESCROW_FOREIGN", () => {
    const a = TM.buildBuyOrderCall(PAYLOAD);
    const b = TM.buildBuyOrderCall({ ...PAYLOAD });
    assert.strictEqual(JSON.stringify(a), JSON.stringify(b));
    assert.deepStrictEqual(a.params, { owner_id: CORP, is_corp: true, station_id: STATION, type_id: TYPE, price: 12.5,
      quantity: 100, min_volume: 1, duration_days: 30, range_value: -1, bid: true, source: "player" });
    const meta = TM.stationMetadataFrom({ stationID: STATION, solarSystemID: 30000142, constellationID: 20000020,
      regionID: 10000002, stationName: "Jita IV - Moon 4", security: 0.9 }, STATION);
    const withMeta = TM.buildBuyOrderCall(PAYLOAD, meta);
    assert.deepStrictEqual(Object.keys(withMeta.params).slice(2, 4), ["station_id", "station_metadata"]);
    assert.strictEqual(withMeta.params.station_metadata.region_id, 10000002);
    assert.strictEqual(TM.stationMetadataFrom({ stationID: STATION, isStructure: true }, STATION), undefined);
    for (const bad of [null, { ...PAYLOAD, corporationId: 0 }, { ...PAYLOAD, priceCents: 0 }, { ...PAYLOAD, priceCents: 1.5 },
      { ...PAYLOAD, minVolume: 0 }, { ...PAYLOAD, minVolume: 101 }, { ...PAYLOAD, quantity: -1 }]) {
      assert.strictEqual(TM.buildBuyOrderCall(bad).reason, "MARKET_CALL_INVALID", JSON.stringify(bad));
    }

    const escrow = fakeEscrow();
    assert.deepStrictEqual(TM.attachBuyEscrowFrom(escrow, attachSpec()), { ok: true, outcome: "WRITTEN" });
    assert.deepStrictEqual(escrow.records.get("501"), { orderId: "501", ownerId: CORP, isCorp: true, walletOwnerId: CORP,
      accountKey: 1005, escrowType: "buy", typeId: TYPE, stationId: STATION, price: 12.5, remainingQuantity: 100,
      escrowAmount: 1250, issuedAt: "2026-10-30T10:00:00.000Z", durationDays: 30, fillAttemptSequence: 0,
      pendingFill: null, createdAt: "2026-10-30T10:00:00.000Z", updatedAt: "2026-10-30T10:00:00.000Z",
      lneOfferId: "offer-1" });
    assert.deepStrictEqual(TM.attachBuyEscrowFrom(escrow, attachSpec()), { ok: true, outcome: "PRESENT" });
    assert.strictEqual(escrow.writes.put, 1, "a retry writes nothing");
    escrow.records.set("502", { orderId: "502", ownerId: 90000001, escrowType: "buy" });
    assert.strictEqual(TM.attachBuyEscrowFrom(escrow, attachSpec({ orderId: "502" })).reason, "ESCROW_FOREIGN");
    assert.strictEqual(TM.attachBuyEscrowFrom(escrow, attachSpec({ priceCents: 0 })).reason, "MARKET_CALL_INVALID");
    const failing = { ...fakeEscrow(), putEscrowRecordDurable: () => ({ success: false, errorMsg: "FLUSH_ERROR" }) };
    assert.strictEqual(TM.attachBuyEscrowFrom(failing, attachSpec()).reason, "ESCROW_WRITE_FAILED");
  });

  test("TM2 detachBuyEscrow BUSY/FOREIGN/ABSENT/REMOVED (sync); listTaggedEscrows pages by BigInt cursor", () => {
    const escrow = fakeEscrow();
    const base = { escrowType: "buy", ownerId: CORP, lneOfferId: "offer-1", pendingFill: null };
    escrow.records.set("10", { ...base, orderId: "10", pendingFill: { orderID: "10" } });
    assert.strictEqual(TM.detachBuyEscrowFrom(escrow, { orderId: "10", offerId: "offer-1" }).reason, "ESCROW_BUSY");
    escrow.records.set("11", { ...base, orderId: "11" });
    escrow.records.set("12", { ...base, orderId: "12", lneOfferId: null, pendingFill: { orderID: "12", crossingOrderID: "11" } });
    const busy = TM.detachBuyEscrowFrom(escrow, { orderId: "11", offerId: "offer-1" });
    assert.ok(!(busy instanceof Promise), "detach is synchronous");
    assert.strictEqual(busy.reason, "ESCROW_BUSY");
    escrow.records.delete("12");
    assert.strictEqual(TM.detachBuyEscrowFrom(escrow, { orderId: "11", offerId: "offer-2" }).reason, "ESCROW_FOREIGN");
    escrow.records.set("13", { ...base, orderId: "13", lneOfferId: undefined });
    assert.strictEqual(TM.detachBuyEscrowFrom(escrow, { orderId: "13", offerId: "offer-1" }).reason, "ESCROW_FOREIGN");
    assert.deepStrictEqual(TM.detachBuyEscrowFrom(escrow, { orderId: "99", offerId: "offer-1" }), { ok: true, outcome: "ABSENT" });
    assert.strictEqual(escrow.writes.remove, 0, "no refusal removes");
    assert.deepStrictEqual(TM.detachBuyEscrowFrom(escrow, { orderId: "11", offerId: "offer-1" }), { ok: true, outcome: "REMOVED" });
    assert.strictEqual(escrow.writes.remove, 1);

    const list = fakeEscrow();
    for (const id of ["10", "9", "100"]) list.records.set(id, { ...base, orderId: id, lneOfferId: `o-${id}` });
    list.records.set("50", { ...base, orderId: "50", lneOfferId: null });
    const seen = [];
    let after = "0";
    for (let page = 0; page < 5; page += 1) {
      const res = TM.listTaggedEscrowsFrom(list, { limit: 1, afterOrderId: after });
      assert.strictEqual(res.ok, true);
      if (res.escrows.length === 0) break;
      seen.push(res.escrows[0].orderId);
      after = res.escrows[0].orderId;
      assert.strictEqual(res.truncated, seen.length < 3, `page ${page}`);
    }
    assert.deepStrictEqual(seen, ["9", "10", "100"], "BigInt order, no repeats");
    assert.strictEqual(TM.listTaggedEscrowsFrom(list, { limit: 1, afterOrderId: "x" }).reason, "MARKET_CALL_INVALID");
    assert.strictEqual(TM.listTaggedEscrowsFrom(list, { limit: 0 }).reason, "MARKET_CALL_INVALID");
  });

  test("TM3 daemon: readBuyOrder mapping / missing, PlaceOrder ambiguous / permanent, cancel after a throw; nothing rejects", async () => {
    const escrow = fakeEscrow();
    escrow.records.set("7", { orderId: "7", escrowType: "buy", ownerId: CORP, accountKey: 1005, remainingQuantity: 40,
      escrowAmount: 500, pendingFill: { orderID: "7" }, lneOfferId: "offer-1" });
    const read = await TM.readBuyOrderFrom(fakeDaemon({ GetOrder: ownerOrder("7", "expired") }), escrow, "7");
    assert.deepStrictEqual(read.order, { state: "expired", volRemaining: 40, volEntered: 100, priceCents: 1250,
      issuedAt: "2026-10-30T10:00:00.000Z", durationDays: 30, stationId: STATION, typeId: TYPE, ownerId: CORP,
      isCorp: true, bid: true, source: "player" });
    assert.deepStrictEqual(read.escrow, { escrowType: "buy", ownerId: CORP, accountKey: 1005, remainingQuantity: 40,
      escrowAmount: 500, pendingFill: true, lneOfferId: "offer-1" });
    const missing = await TM.readBuyOrderFrom(fakeDaemon({ GetOrder: rejected("order 7 not found") }), escrow, "7");
    assert.deepStrictEqual([missing.ok, missing.missing, missing.order], [true, true, null]);

    const params = TM.buildBuyOrderCall(PAYLOAD).params;
    assert.deepStrictEqual(await TM.placeBuyOrderFrom(fakeDaemon({ PlaceOrder: { order_id: 4242 } }), params),
      { ok: true, orderId: "4242" });
    const amb = await TM.placeBuyOrderFrom(fakeDaemon({ PlaceOrder: timedOut() }), params);
    assert.deepStrictEqual([amb.ok, amb.ambiguous, amb.permanent], [false, true, false]);
    const perm = await TM.placeBuyOrderFrom(fakeDaemon({ PlaceOrder: rejected("invalid price") }), params);
    assert.deepStrictEqual([perm.ok, perm.permanent, perm.ambiguous], [false, true, false]);

    const cancel = await TM.cancelBuyOrderFrom(fakeDaemon({ CancelOrder: timedOut(), GetOrder: ownerOrder("7", "cancelled") }), "7");
    assert.deepStrictEqual(cancel, { ok: true, state: "cancelled" });

    const broken = { call() { throw new Error("boom"); } };
    const results = await Promise.all([
      TM.placeBuyOrderFrom(broken, params), TM.readBuyOrderFrom(broken, escrow, "7"), TM.cancelBuyOrderFrom(broken, "7"),
      TM.findBuyOrderFrom(broken, fakeEscrow(), { ...PAYLOAD, corporationId: CORP }),
      TM.listCorpBuyOrdersFrom(broken, escrow, CORP), TM.placeAndAttachBuyOrderFrom(broken, fakeEscrow(), PAYLOAD, 0),
    ]);
    for (const r of results) assert.strictEqual(r.ok, false, JSON.stringify(r));
  });

  test("TM4 findBuyOrder: escrow first, daemon order without record, seed / foreign record skipped, duplicates", async () => {
    const spec = { corporationId: CORP, offerId: "offer-1", stationId: STATION, typeId: TYPE, quantity: 100, priceCents: 1250 };
    const escrow = fakeEscrow();
    escrow.records.set("900", { orderId: "900", escrowType: "buy", lneOfferId: "offer-1" });
    const viaEscrow = await TM.findBuyOrderFrom(fakeDaemon({}), escrow, spec);
    assert.deepStrictEqual(viaEscrow, { ok: true, found: "escrow", orderId: "900", duplicates: 0, extraOrderIds: [] });

    const orders = [
      ownerOrder("30", "open"), ownerOrder("20", "open"),
      ownerOrder("10", "open", { source: "seed" }),
      ownerOrder("4000000000000000001", "open"),
      ownerOrder("15", "open"),
      ownerOrder("16", "open", { price: 12.51 }),
      ownerOrder("17", "filled"),
    ];
    const book = fakeEscrow();
    book.records.set("15", { orderId: "15", escrowType: "buy", ownerId: 90000001 });
    const daemon = fakeDaemon({ GetCorporationOrders: orders });
    const found = await TM.findBuyOrderFrom(daemon, book, spec);
    assert.deepStrictEqual(found, { ok: true, found: "daemon", orderId: "20", duplicates: 1, extraOrderIds: ["30"] });
    assert.deepStrictEqual(daemon.calls[0], { method: "GetCorporationOrders", params: { owner_id: CORP, is_corp: true } });
    const none = await TM.findBuyOrderFrom(fakeDaemon({ GetCorporationOrders: [ownerOrder("10", "open", { source: "seed" })] }), book, spec);
    assert.deepStrictEqual(none, { ok: true, found: null, duplicates: 0, extraOrderIds: [] });
    const down = await TM.findBuyOrderFrom(fakeDaemon({ GetCorporationOrders: timedOut() }), book, spec);
    assert.strictEqual(down.reason, "MARKET_UNAVAILABLE");
  });

  test("TM5 24a extensions (flag, excludeOrderIds) and the createAdapter facade tradeMarket*", async () => {
    const calls = [];
    const itemStore = { ITEM_FLAGS: { HANGAR: 4, CORP_DELIVERIES: 62 },
      listContainerItems: (...args) => { calls.push(args); return []; } };
    assert.strictEqual(listDeliveredStacksFrom(itemStore, { npcStationId: STATION, typeId: TYPE, corporationId: CORP, flag: "hangar" }).ok, true);
    assert.strictEqual(listDeliveredStacksFrom(itemStore, { npcStationId: STATION, typeId: TYPE, corporationId: CORP }).ok, true);
    assert.deepStrictEqual(calls, [[CORP, STATION, 4, [TYPE]], [CORP, STATION, 62, [TYPE]]]);
    const invalid = listDeliveredStacksFrom(itemStore, { npcStationId: STATION, typeId: TYPE, corporationId: CORP, flag: "cargo" });
    assert.deepStrictEqual([invalid.reason, invalid.permanent, calls.length], ["TRADE_FLAG_INVALID", true, 2]);

    const pricesDaemon = fakeDaemon({ GetRegionBest: [], GetOrders: { buys: [{ order_id: 501, price: 20 }, { order_id: 502, price: 15 }], sells: [] } });
    const pricing = { resolveAdjustedAverageTypePrice: () => 10 };
    const spec = { typeIds: [TYPE], refRegionId: 10000002, regionIds: [], maxRegions: 1 };
    const plain = await readTradePricesFrom(pricesDaemon, pricing, spec);
    assert.strictEqual(plain.prices.get(TYPE).bidMilli, 20000, "without the field: as before");
    const own = await readTradePricesFrom(pricesDaemon, pricing, { ...spec, excludeOrderIds: ["501"] });
    assert.strictEqual(own.prices.get(TYPE).bidMilli, 15000, "own bid left out");

    const SRC = path.join(path.sep, "x", "server", "src");
    const escrow = fakeEscrow();
    const daemon = fakeDaemon({ GetCorporationOrders: [] });
    const byAbs = {
      [path.join(SRC, "services/market/marketDaemonClient.js")]: { marketDaemonClient: daemon },
      [path.join(SRC, "services/market/marketEscrowState.js")]: escrow,
      [path.join(SRC, "services/market/marketRules.js")]: { isAllowedDuration: (d) => [0, 1, 3, 7, 14, 30, 90].includes(d) },
      [path.join(SRC, "services/inventory/itemStore.js")]: itemStore,
    };
    const adapter = createAdapter({ moduleApi: { _cache: {} }, existsSync: () => true, requireFn: (abs) => byAbs[abs] || {} });
    const names = ["checkTradeMarketSeams", "tradeMarketPlace", "tradeMarketRead", "tradeMarketFind", "tradeMarketAttachEscrow",
      "tradeMarketDetachEscrow", "tradeMarketCancel", "tradeMarketListCorpOrders", "tradeMarketListTaggedEscrows",
      "tradeMarketDurationAllowed"];
    for (const n of names) assert.strictEqual(typeof adapter[n], "function", n);
    adapter.setServerSrc(SRC);
    const early = await adapter.tradeMarketRead("7");
    assert.strictEqual(early.reason, "SEAM_UNAVAILABLE", "before markBooted: resolved refusal");
    adapter.markBooted();
    adapter.setVendorTagStore(createFakeVendorTags());
    assert.deepStrictEqual(adapter.checkTradeMarketSeams(), { ok: true });
    assert.deepStrictEqual([adapter.tradeMarketDurationAllowed(7), adapter.tradeMarketDurationAllowed(0),
      adapter.tradeMarketDurationAllowed(5)], [true, false, false]);
    assert.deepStrictEqual(adapter.tradeMarketListTaggedEscrows({ limit: 8 }), { ok: true, escrows: [], truncated: false });
    delete escrow.listEscrowRecords;
    const miss = adapter.checkTradeMarketSeams();
    assert.deepStrictEqual([miss.reason, miss.missing], ["TRADE_MARKET_SEAM_UNAVAILABLE", ["services/market/marketEscrowState.listEscrowRecords"]]);
  });
};
