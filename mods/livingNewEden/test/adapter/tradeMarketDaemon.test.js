"use strict";

const assert = require("node:assert");

const {
  placeBuyOrderFrom,
  placeAndAttachBuyOrderFrom,
  readBuyOrderFrom,
  cancelBuyOrderFrom,
} = require("../../lib/adapter/tradeMarket");
const { createAdapter } = require("../../lib/adapter");
const { createFakeVendorTags } = require("../_support/fakeVendorTags");

function daemonError(message, { code, requestSent, outcomeUnknown, method } = {}) {
  const err = new Error(message);
  if (code) err.code = code;
  if (method) err.marketDaemonMethod = method;
  if (requestSent !== undefined) err.marketDaemonRequestSent = requestSent === true;
  if (outcomeUnknown !== undefined) err.marketDaemonOutcomeUnknown = outcomeUnknown === true;
  return err;
}
const rejected = (message) => daemonError(message, { code: "MARKET_DAEMON_RPC_REJECTED", requestSent: true, outcomeUnknown: false });
const timedOut = () => daemonError("market daemon RPC request timed out after 5000 ms",
  { code: "MARKET_DAEMON_RPC_TIMEOUT", requestSent: true, outcomeUnknown: true });
const connectFailed = () => daemonError("connect ECONNREFUSED 127.0.0.1:40111",
  { code: "ECONNREFUSED", requestSent: false, outcomeUnknown: false });

function fakeDaemon(handlers) {
  const calls = [];
  return {
    calls,
    async call(method, params) {
      calls.push({ method, params });
      let h = handlers[method];
      if (typeof h === "function") h = h(params, calls.filter((c) => c.method === method).length);
      if (h instanceof Error) throw h;
      if (h === undefined) throw rejected(`unknown method ${method}`);
      return h;
    },
  };
}

function fakeEscrow() {
  const records = new Map();
  return {
    records,
    getEscrowRecord: (id) => records.get(String(id)) || null,
    listEscrowRecords: () => [...records.values()].map((r) => ({ ...r })),
    putEscrowRecordDurable: (r) => { records.set(String(r.orderId), { ...r }); return { success: true }; },
    removeEscrowRecordDurable: (id) => { records.delete(String(id)); return { success: true }; },
  };
}

function vendorOrder(orderId, state, over = {}) {
  return {
    order_id: orderId,
    owner_id: 98000001,
    is_corp: true,
    state,
    row: {
      order_id: orderId, price: 12.5, vol_remaining: 40, vol_entered: 100, type_id: 34, station_id: 60003760,
      bid: true, issued_at: "2026-10-27T10:00:00.000Z", duration_days: 30, ...over,
    },
  };
}

const SPEC = Object.freeze({
  offerId: "offer-1", corporationId: 98000001, accountKey: 1005, stationId: 60003760, typeId: 34,
  quantity: 100, priceCents: 1250, durationDays: 30, minVolume: 1,
});

module.exports = ({ test }) => {
  test("TMD1 readBuyOrder: vendor GetOrder shape mapped (state, ownerId from order level); 'order 7 not found' -> missing", async () => {
    const escrow = fakeEscrow();
    escrow.records.set("7", { orderId: "7", lneOfferId: "offer-1", escrowType: "buy" });
    const ok = await readBuyOrderFrom(fakeDaemon({ GetOrder: vendorOrder("7", "open") }), escrow, "7");
    assert.strictEqual(ok.ok, true);
    assert.strictEqual(ok.missing, false);
    assert.strictEqual(ok.order.state, "open");
    assert.strictEqual(ok.order.ownerId, 98000001);
    assert.strictEqual(ok.order.isCorp, true);
    assert.strictEqual(ok.order.volRemaining, 40);
    assert.strictEqual(ok.order.priceCents, 1250);
    assert.strictEqual(ok.escrow.lneOfferId, "offer-1");

    const missing = await readBuyOrderFrom(fakeDaemon({ GetOrder: rejected("order 7 not found") }), escrow, "7");
    assert.deepStrictEqual(missing, { ok: true, missing: true, order: null, escrow: { escrowType: "buy", ownerId: 0,
      accountKey: null, remainingQuantity: 0, escrowAmount: 0, pendingFill: false, lneOfferId: "offer-1" } });
  });

  test("TMD2 readBuyOrder: other rejection, timeout (outcome unknown), connect failure -> MARKET_UNAVAILABLE, never missing", async () => {
    const escrow = fakeEscrow();
    for (const err of [rejected("order 8 not found"), rejected("boom"), timedOut(), connectFailed()]) {
      const res = await readBuyOrderFrom(fakeDaemon({ GetOrder: err }), escrow, "7");
      assert.strictEqual(res.ok, false, err.message);
      assert.strictEqual(res.reason, "MARKET_UNAVAILABLE", err.message);
    }
  });

  test("TMD3 cancelBuyOrder: success verified by GetOrder; missing; closed order after a rejection; unreadable verify", async () => {
    let d = fakeDaemon({ CancelOrder: { order_id: "7", state: "cancelled" }, GetOrder: vendorOrder("7", "cancelled") });
    assert.deepStrictEqual(await cancelBuyOrderFrom(d, "7"), { ok: true, state: "cancelled" });
    assert.deepStrictEqual(d.calls.map((c) => c.method), ["CancelOrder", "GetOrder"]);
    d = fakeDaemon({ CancelOrder: rejected("order 7 not found"), GetOrder: vendorOrder("7", "open") });
    assert.deepStrictEqual(await cancelBuyOrderFrom(d, "7"), { ok: true, state: "missing" });
    assert.strictEqual(d.calls.length, 1);
    d = fakeDaemon({ CancelOrder: rejected("order 7 is not open"), GetOrder: vendorOrder("7", "expired") });
    assert.deepStrictEqual(await cancelBuyOrderFrom(d, "7"), { ok: true, state: "expired" });
    d = fakeDaemon({ CancelOrder: rejected("refused"), GetOrder: rejected("order 7 not found") });
    assert.deepStrictEqual(await cancelBuyOrderFrom(d, "7"), { ok: true, state: "missing" });
    d = fakeDaemon({ CancelOrder: { state: "cancelled" }, GetOrder: timedOut() });
    assert.deepStrictEqual(await cancelBuyOrderFrom(d, "7"), { ok: true, state: "cancelled", verified: false });
  });

  test("TMD4 cancelBuyOrder: still open -> MARKET_CANCEL_FAILED / MARKET_UNAVAILABLE; both calls down -> MARKET_UNAVAILABLE", async () => {
    let res = await cancelBuyOrderFrom(fakeDaemon({ CancelOrder: rejected("refused"), GetOrder: vendorOrder("7", "open") }), "7");
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.reason, "MARKET_CANCEL_FAILED");
    res = await cancelBuyOrderFrom(fakeDaemon({ CancelOrder: { state: "open" }, GetOrder: vendorOrder("7", "open") }), "7");
    assert.strictEqual(res.reason, "MARKET_CANCEL_FAILED");
    res = await cancelBuyOrderFrom(fakeDaemon({ CancelOrder: timedOut(), GetOrder: vendorOrder("7", "open") }), "7");
    assert.strictEqual(res.reason, "MARKET_UNAVAILABLE");
    res = await cancelBuyOrderFrom(fakeDaemon({ CancelOrder: connectFailed(), GetOrder: connectFailed() }), "7");
    assert.strictEqual(res.reason, "MARKET_UNAVAILABLE");
    res = await cancelBuyOrderFrom(fakeDaemon({ CancelOrder: {}, GetOrder: timedOut() }), "7");
    assert.strictEqual(res.reason, "MARKET_UNAVAILABLE", "no state in the answer and no verify -> not ok");
  });

  test("TMD5 placeBuyOrder: result.order_id; rejection permanent; outcome unknown ambiguous; not sent transient", async () => {
    assert.deepStrictEqual(await placeBuyOrderFrom(fakeDaemon({ PlaceOrder: { order_id: 123 } }), {}), { ok: true, orderId: "123" });
    const rej = await placeBuyOrderFrom(fakeDaemon({ PlaceOrder: rejected("price out of range") }), {});
    assert.strictEqual(rej.ok, false);
    assert.strictEqual(rej.permanent, true);
    assert.strictEqual(rej.ambiguous, false);
    const unk = await placeBuyOrderFrom(fakeDaemon({ PlaceOrder: timedOut() }), {});
    assert.strictEqual(unk.permanent, false);
    assert.strictEqual(unk.ambiguous, true);
    const down = await placeBuyOrderFrom(fakeDaemon({ PlaceOrder: connectFailed() }), {});
    assert.strictEqual(down.reason, "MARKET_UNAVAILABLE");
    assert.strictEqual(down.permanent, false);
    assert.strictEqual(down.ambiguous, false);
    const noId = await placeBuyOrderFrom(fakeDaemon({ PlaceOrder: {} }), {});
    assert.strictEqual(noId.ambiguous, true);
  });

  test("TMD6 tradeMarketPlace (real createAdapter): new order + record with spec fields; rejection and timeout resolve {ok:false}", async () => {
    const path = require("node:path");
    const SRC = path.join(path.sep, "x", "server", "src");
    const escrow = fakeEscrow();
    let placeAnswer = { order_id: 501 };
    const daemon = fakeDaemon({
      GetCorporationOrders: [],
      PlaceOrder: () => placeAnswer,
      GetOrder: vendorOrder("501", "open", { vol_remaining: 100 }),
      CancelOrder: { state: "cancelled" },
    });
    const byAbs = {
      [path.join(SRC, "services/market/marketDaemonClient.js")]: { marketDaemonClient: daemon },
      [path.join(SRC, "services/market/marketEscrowState.js")]: escrow,
    };
    const vendorPut = escrow.putEscrowRecordDurable;
    escrow.putEscrowRecordDurable = (r) => ("lneOfferId" in r ? { success: false, errorMsg: "unknown field" } : vendorPut(r));
    const adapter = createAdapter({ moduleApi: { _cache: {} }, existsSync: () => true, requireFn: (abs) => byAbs[abs] || {} });
    adapter.setServerSrc(SRC);
    adapter.markBooted();
    const noTags = await adapter.tradeMarketPlace(SPEC);
    assert.deepStrictEqual([noTags.reason, noTags.detail], ["SEAM_UNAVAILABLE", "vendorTags"]);
    assert.deepStrictEqual(adapter.setVendorTagStore({}), { ok: false, reason: "INVALID_TAG_STORE" });
    const tags = createFakeVendorTags();
    assert.deepStrictEqual(adapter.setVendorTagStore(tags), { ok: true });

    const ok = await adapter.tradeMarketPlace(SPEC);
    assert.deepStrictEqual(ok, { ok: true, orderId: "501" });
    const rec = escrow.records.get("501");
    assert.strictEqual(rec.ownerId, SPEC.corporationId);
    assert.strictEqual(rec.accountKey, 1005);
    assert.strictEqual(rec.typeId, 34);
    assert.strictEqual(rec.stationId, 60003760);
    assert.strictEqual(rec.price, 12.5);
    assert.strictEqual(rec.remainingQuantity, 100);
    assert.strictEqual("lneOfferId" in rec, false);
    assert.strictEqual(tags.escrows.get("501").offerId, "offer-1");
    tags.escrows.clear();

    escrow.records.clear();
    placeAnswer = rejected("price out of range");
    const rej = await adapter.tradeMarketPlace(SPEC);
    assert.strictEqual(rej.ok, false);
    assert.strictEqual(rej.permanent, true);
    assert.strictEqual(rej.ambiguous, false);

    placeAnswer = timedOut();
    const unk = await adapter.tradeMarketPlace(SPEC);
    assert.strictEqual(unk.ok, false);
    assert.strictEqual(unk.ambiguous, true);
    assert.strictEqual(escrow.records.size, 0);

    const down = await placeAndAttachBuyOrderFrom(fakeDaemon({ GetCorporationOrders: connectFailed() }), escrow, SPEC, 0);
    assert.strictEqual(down.ok, false);
    assert.strictEqual(down.reason, "MARKET_UNAVAILABLE");
    assert.strictEqual(down.permanent, false);
    assert.strictEqual(down.ambiguous, false);
  });
};
