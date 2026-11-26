"use strict";

const S = require("./schema");
const { closeWanted, abortAllowed, sellGrantGate, planReturnOwnFirst } = require("./executorRules");
const { classifyMarketPoll, sellProceedsIsk } = require("./marketRules");
const { abortSell, settleProceedsTx, treasuryContextOf, SellRollback, TREASURY_NOT_READY } = require("./sellSteps");

const METRIC_PLACED = "trade.marketPlaced";
const METRIC_PLACE_RETRY = "trade.marketPlaceRetry";
const METRIC_CLOSED = "trade.marketClosed";
const METRIC_SETTLED = "trade.marketSettled";
const METRIC_FILLED_UNITS = "trade.marketFilledUnits";
const METRIC_UNAVAILABLE = "trade.marketUnavailable";
const METRIC_MISSING = "trade.marketOrderMissing";
const METRIC_SEAM_ERROR = "trade.seamError";
const METRIC_TRIPPED = "trade.marketTripped";
const METRIC_SELL_PLACED = "trade.marketSellPlaced";
const METRIC_SELL_SETTLED = "trade.marketSellSettled";
const METRIC_SELL_SOLD_UNITS = "trade.marketSellSoldUnits";
const METRIC_SELL_RETURNED_UNITS = "trade.marketSellReturnedUnits";
const METRIC_SELL_ESCROW_MOVED = "trade.marketSellEscrowMoved";
const METRIC_WTS_PROCEEDS_ISK = "trade.wtsProceedsIsk";
const METRIC_WTS_PROCEEDS_TREASURY = "trade.wtsProceedsTreasury";
const METRIC_WTS_PROCEEDS_BURNED = "trade.wtsProceedsBurned";
const METRIC_WTS_PROCEEDS_WAIT = "trade.wtsProceedsWait";
const METRIC_WTS_STOCK_LOST = "trade.wtsStockLost";
const METRIC_WTS_GRANT_FAILED = "trade.wtsGrantFailed";
const METRIC_SELL_RETURN_ABANDONED = "trade.marketSellReturnAbandoned";
const METRIC_SELL_ROLLBACK_FAILED = "trade.marketSellRollbackFailed";

class MarketRollback extends Error {
  constructor(refusal) {
    super(String((refusal && refusal.reason) || "MARKET_ROLLBACK"));
    this.refusal = refusal;
  }
}

function refusalOf(txRes) {
  if (txRes && txRes.error instanceof MarketRollback) return txRes.error.refusal || { reason: "MARKET_ROLLBACK" };
  return { reason: String((txRes && txRes.reason) || "TX_FAILED") };
}

function metric(telemetry, name, value) {
  if (!telemetry || typeof telemetry.count !== "function") return;
  try { telemetry.count(name, value); } catch (_err) {}
}

function createMarketSteps(deps) {
  const { store, journal, offers, adapter, config, clock, mode, lastPermanent } = deps;
  const telemetry = deps.telemetry || null;
  const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : { log() {} };
  const noteEscrowClone = typeof deps.noteEscrowClone === "function" ? deps.noteEscrowClone : () => {};
  const tradeCfg = (config && config.trade) || {};
  const buyOrdersEnabled = tradeCfg.buyOrdersEnabled === true;
  const sellOrdersFlag = tradeCfg.marketSellOrdersEnabled === true && tradeCfg.wtsEnabled === true;
  const issueTimeoutMs = tradeCfg.issueTimeoutMs;
  const log = (msg) => logger.log(`[tradeExecutor] ${msg}`);

  const maxIssueFailures = Number.isSafeInteger(tradeCfg.maxMarketIssueFailures) ? tradeCfg.maxMarketIssueFailures : 3;
  let issueFailures = 0;
  let tripped = false;
  function noteIssueFailure(res) {
    if (!res || res.action !== "aborted") return res;
    issueFailures += 1;
    if (!tripped && maxIssueFailures > 0 && issueFailures >= maxIssueFailures) {
      tripped = true;
      metric(telemetry, METRIC_TRIPPED, 1);
      log(`market channel tripped after ${issueFailures} consecutive ISSUE_FAILED aborts - new offers go to contracts until restart`);
    }
    return res;
  }
  function noteIssueSuccess() { issueFailures = 0; }

  let marketDown = false;
  const noteDaemon = (res) => {
    if (res && res.ok === true) { marketDown = false; return; }
    if (res && res.reason === "MARKET_UNAVAILABLE") {
      marketDown = true;
      metric(telemetry, METRIC_UNAVAILABLE, 1);
    }
  };

  function readOfferAndEntry(offerId, key) {
    const r = store.transaction("trade.market.read", (db) => {
      const o = offers.getOffer(db, offerId);
      if (!o || o.ok !== true) throw new MarketRollback(o || { reason: "OFFER_READ_FAILED" });
      const f = journal.findByKey(db, key);
      if (!f || f.ok !== true) throw new MarketRollback(f || { reason: "JOURNAL_READ_FAILED" });
      return { offer: o.offer, entry: f.found ? f.entry : null };
    });
    return r.ok ? { ok: true, offer: r.value.offer, entry: r.value.entry } : { ok: false, ...refusalOf(r) };
  }

  function openTx(cur, journalId, orderId) {
    const r = store.transaction("trade.market_open", (db) => {
      const t = offers.transitionOfferInTx(db, {
        offerId: cur.offerId, expectedVersion: cur.version, from: S.ISSUING, to: S.OPEN, reason: "",
        at: clock.now(), patch: { marketOrderId: orderId },
      }, S.transitionKey(cur.offerId, cur.stateSeq + 1, S.OPEN));
      if (!t.ok) throw new MarketRollback(t);
      const m = journal.markApplied(db, journalId);
      if (!m.ok) throw new MarketRollback(m);
      return { ok: true };
    });
    if (!r.ok) return { action: "error", reason: refusalOf(r).reason };
    lastPermanent.delete(cur.offerId);
    metric(telemetry, METRIC_PLACED, 1);
    return { action: "opened", orderId };
  }

  function abortTx(cur, journalId, reason) {
    const r = store.transaction("trade.market_abort", (db) => {
      const t = offers.transitionOfferInTx(db, {
        offerId: cur.offerId, expectedVersion: cur.version, from: S.ISSUING, to: S.CANCELLED, reason, at: clock.now(),
      }, S.transitionKey(cur.offerId, cur.stateSeq + 1, S.CANCELLED));
      if (!t.ok) throw new MarketRollback(t);
      const m = journal.markFailed(db, journalId, `aborted:${reason}`);
      if (!m.ok) throw new MarketRollback(m);
      return { ok: true };
    });
    if (!r.ok) return { action: "error", reason: refusalOf(r).reason };
    lastPermanent.delete(cur.offerId);
    return { action: "aborted", reason };
  }

  async function issueMarket(offer, station) {
    const read = readOfferAndEntry(offer.offerId, S.marketPlaceOutboxKey(offer.offerId));
    if (!read.ok) return { action: "error", reason: read.reason };
    const cur = read.offer;
    if (!cur || cur.state !== S.ISSUING || cur.channel !== S.CHANNEL_MARKET) return { action: "error", reason: "STALE" };
    if (!read.entry) return { action: "error", reason: "NO_OUTBOX" };
    if (cur.side === S.SIDE_SELL) return issueMarketSell(cur, read.entry, station);
    const p = read.entry.payload;
    const journalId = read.entry.journalId;
    const now = clock.now();

    const disabled = mode === "cleanup" || !buyOrdersEnabled;
    const stationGone = closeWanted(cur, station, now, "run") === S.END_REASON_STATION_GONE;
    const timedOut = abortAllowed(null, cur, now, issueTimeoutMs, lastPermanent.get(cur.offerId) === true);
    if (disabled || stationGone || timedOut) {
      const f = await adapter.tradeMarketFind({ corporationId: p.corporationId, offerId: cur.offerId,
        stationId: p.stationId, typeId: p.typeId, quantity: p.quantity, priceCents: p.priceCents });
      noteEscrowClone();
      noteDaemon(f);
      if (!f || f.ok !== true) return { action: "retry", reason: (f && f.reason) || "FIND_FAILED" };
      if (f.found === "escrow") {
        if (f.duplicates > 0) log(`market offer ${cur.offerId}: ${f.duplicates} extra tagged escrow records`);
        return openTx(cur, journalId, f.orderId);
      }
      if (f.found === "daemon" && disabled) {
        for (const orderId of [f.orderId, ...(f.extraOrderIds || [])]) {
          const c = await adapter.tradeMarketCancel(orderId);
          noteDaemon(c);
          if (!c || c.ok !== true) return { action: "retry", reason: (c && c.reason) || "CANCEL_FAILED" };
        }
        return abortTx(cur, journalId, S.END_REASON_DISABLED);
      }
      if (f.found === null) {
        const reason = disabled ? S.END_REASON_DISABLED
          : (stationGone ? S.END_REASON_STATION_GONE : S.END_REASON_ISSUE_FAILED);
        const ab = abortTx(cur, journalId, reason);
        return reason === S.END_REASON_ISSUE_FAILED ? noteIssueFailure(ab) : ab;
      }
    }

    const pl = await adapter.tradeMarketPlace(p);
    noteEscrowClone();
    if (pl && pl.ok === true) {
      marketDown = false;
      noteIssueSuccess();
      return openTx(cur, journalId, pl.orderId);
    }
    noteDaemon(pl);
    const reason = (pl && pl.reason) || "PLACE_FAILED";
    if (pl && pl.permanent === true) {
      lastPermanent.set(cur.offerId, true);
      log(`market offer ${cur.offerId}: place refused for good (${reason} ${pl.detail || ""})`);
      return noteIssueFailure(abortTx(cur, journalId, S.END_REASON_ISSUE_FAILED));
    }
    if (pl && pl.ambiguous === true) {
      metric(telemetry, METRIC_PLACE_RETRY, 1);
      return { action: "retry", reason };
    }
    if (reason === "MARKET_ATTACH_FAILED") {
      log(`market offer ${cur.offerId}: escrow record refused (${pl.detail || ""}), order cancelled`);
      metric(telemetry, METRIC_SEAM_ERROR, 1);
    }
    return { action: "retry", reason };
  }

  function closeIntentTx(cur, reason) {
    const r = store.transaction("trade.market_close_intent", (db) => {
      const e = journal.enqueueOutbox(db, {
        key: S.marketCloseOutboxKey(cur.offerId),
        aggregate: { type: S.OFFER_AGGREGATE, id: cur.offerId },
        eventType: S.EVENT_OUTBOX_MARKET_CLOSE,
        payload: { offerId: cur.offerId, orderId: cur.marketOrderId, reason },
      });
      if (!e.ok) throw new MarketRollback(e);
      return { ok: true };
    });
    return r.ok ? { ok: true } : { ok: false, ...refusalOf(r) };
  }

  function fillTx(cur, filled) {
    const r = store.transaction("trade.market_fill", (db) => {
      const f = offers.recordFillInTx(db, { offerId: cur.offerId, expectedVersion: cur.version, filled, at: clock.now() },
        S.fillKey(cur.offerId, filled));
      if (!f.ok || !f.offer) throw new MarketRollback(f.ok ? { reason: "OFFER_GONE" } : f);
      return f.offer;
    });
    return r.ok ? { ok: true, offer: r.value } : { ok: false, ...refusalOf(r) };
  }

  function settleTx(offerId, filled, vendorReason) {
    const closeKey = S.marketCloseOutboxKey(offerId);
    const r = store.transaction("trade.market_settle", (db) => {
      const o = offers.getOffer(db, offerId);
      if (!o || o.ok !== true) throw new MarketRollback(o || { reason: "OFFER_READ_FAILED" });
      const cur = o.offer;
      if (!cur || cur.state !== S.OPEN) return { stale: true };
      const f = journal.findByKey(db, closeKey);
      if (!f || f.ok !== true) throw new MarketRollback(f || { reason: "JOURNAL_READ_FAILED" });
      const closeReason = f.found && f.entry.payload && typeof f.entry.payload.reason === "string"
        ? f.entry.payload.reason : null;
      const accepted = filled > 0;
      const to = accepted ? S.ACCEPTED : S.CANCELLED;
      const reason = accepted ? "" : (closeReason || vendorReason || S.END_REASON_MARKET_CANCELLED);
      const t = offers.transitionOfferInTx(db, {
        offerId, expectedVersion: cur.version, from: S.OPEN, to, reason, at: clock.now(),
        ...(accepted ? { patch: { filledQuantity: filled, acceptorCharacterId: null } } : {}),
      }, S.transitionKey(offerId, cur.stateSeq + 1, to));
      if (!t.ok) throw new MarketRollback(t);
      if (f.found && f.entry.state === "PENDING") {
        const m = journal.markApplied(db, f.entry.journalId);
        if (!m.ok) throw new MarketRollback(m);
      }
      return { accepted, reason, closedByMod: f.found };
    });
    if (!r.ok) return { action: "error", reason: refusalOf(r).reason };
    if (r.value.stale) return { action: "retry", reason: "STALE" };
    if (r.value.accepted) {
      metric(telemetry, METRIC_SETTLED, 1);
      metric(telemetry, METRIC_FILLED_UNITS, filled);
      return { action: "accepted", filled };
    }
    metric(telemetry, METRIC_CLOSED, 1);
    return { action: "closed", reason: r.value.reason };
  }

  function hasCloseOutbox(offerId) {
    const r = store.transaction("trade.market.read_close", (db) => journal.findByKey(db, S.marketCloseOutboxKey(offerId)));
    if (!r.ok || !r.value || r.value.ok !== true) return null;
    return r.value.found === true;
  }

  function detach(cur) {
    const d = cur.side === S.SIDE_SELL
      ? adapter.tradeMarketDetachEscrow({ orderId: cur.marketOrderId, offerId: cur.offerId, escrowType: "sell" })
      : adapter.tradeMarketDetachEscrow({ orderId: cur.marketOrderId, offerId: cur.offerId });
    noteEscrowClone();
    return d;
  }

  function settle(cur, filled, vendorReason) {
    return cur.side === S.SIDE_SELL ? settleSell(cur, filled, vendorReason) : settleTx(cur.offerId, filled, vendorReason);
  }

  function sellSeamsReady() {
    if (!adapter || typeof adapter.tradeMarketSellSeams !== "function" || typeof adapter.tradeMarketPlaceSell !== "function"
      || typeof adapter.tradeMarketFindSell !== "function" || typeof adapter.tradeMarketReturnSellEscrow !== "function") {
      return false;
    }
    try {
      const r = adapter.tradeMarketSellSeams();
      return Boolean(r && r.ok === true);
    } catch (_err) {
      return false;
    }
  }

  function stockOutFound(offerId) {
    const r = store.transaction("trade.market.read_stock_out", (db) => journal.findByKey(db, S.stockOutKey(offerId)));
    if (!r.ok || !r.value || r.value.ok !== true) return null;
    return r.value.found === true;
  }

  async function issueMarketSell(cur, entry, station) {
    const p = entry.payload || {};
    const journalId = entry.journalId;
    const now = clock.now();
    if (!sellSeamsReady()) {
      log(`market sell offer ${cur.offerId}: sell order seams unavailable, the offer waits`);
      return { action: "error", reason: "SELL_MARKET_SEAMS_UNAVAILABLE" };
    }
    const abortDeps = { store, journal, offers, adapter, config, clock, telemetry, logger, lastPermanent };
    const abortOpts = { issueKey: S.marketPlaceOutboxKey(cur.offerId), stackFlag: "hangar" };
    const abort = async (reason) => {
      const r = await abortSell(abortDeps, cur, reason, abortOpts);
      if (!r || r.action !== "aborted") return { action: (r && r.action) || "error", reason: (r && r.reason) || "ABORT_FAILED" };
      return { action: "aborted", reason };
    };

    const disabled = mode === "cleanup" || !sellOrdersFlag;
    const stationGone = closeWanted(cur, station, now, "run") === S.END_REASON_STATION_GONE;
    const timedOut = abortAllowed(null, cur, now, issueTimeoutMs, lastPermanent.get(cur.offerId) === true);
    if (disabled || stationGone || timedOut) {
      const f = await adapter.tradeMarketFindSell({ corporationId: p.corporationId, offerId: cur.offerId,
        stationId: p.stationId, typeId: p.typeId, quantity: p.quantity, priceCents: p.priceCents });
      noteEscrowClone();
      noteDaemon(f);
      if (!f || f.ok !== true) return { action: "retry", reason: (f && f.reason) || "FIND_FAILED" };
      if (f.found === "escrow") {
        if (f.duplicates > 0) log(`market sell offer ${cur.offerId}: ${f.duplicates} extra tagged escrow records`);
        return openTx(cur, journalId, f.orderId);
      }
      if (f.found === "daemon" && disabled) {
        for (const orderId of [f.orderId, ...(f.extraOrderIds || [])]) {
          const c = await adapter.tradeMarketCancel(orderId);
          noteDaemon(c);
          if (!c || c.ok !== true) return { action: "retry", reason: (c && c.reason) || "CANCEL_FAILED" };
        }
        return abort(S.END_REASON_DISABLED);
      }
      if (f.found === null) {
        const reason = disabled ? S.END_REASON_DISABLED
          : (stationGone ? S.END_REASON_STATION_GONE : S.END_REASON_ISSUE_FAILED);
        const ab = await abort(reason);
        return reason === S.END_REASON_ISSUE_FAILED ? noteIssueFailure(ab) : ab;
      }
    }

    const stock = stockOutFound(cur.offerId);
    if (stock === null) return { action: "error", reason: "JOURNAL_READ_FAILED" };
    const gate = sellGrantGate(cur, stock);
    if (gate !== null) return { action: "error", reason: gate };

    const grant = await adapter.tradeGrantStock({ ownerKind: S.ISSUER_KIND_CORPORATION, ownerId: p.corporationId,
      npcStationId: p.stationId, typeId: p.typeId, quantity: p.quantity, key: p.grantKey, flag: "hangar" });
    if (!grant || grant.ok !== true) {
      metric(telemetry, METRIC_WTS_GRANT_FAILED, 1);
      if (grant && grant.permanent === true && grant.ambiguous !== true) lastPermanent.set(cur.offerId, true);
      log(`market sell offer ${cur.offerId}: grant failed ${(grant && (grant.detail || grant.reason)) || "no_result"}`);
      return { action: "retry", reason: (grant && grant.reason) || "GRANT_FAILED" };
    }

    const pl = await adapter.tradeMarketPlaceSell({ ...p, grantItemIds: grant.itemIds });
    noteEscrowClone();
    if (pl && pl.ok === true) {
      marketDown = false;
      noteIssueSuccess();
      if (pl.escrowBeyondLimit === true) {
        log(`market sell offer ${cur.offerId}: escrow location of order ${pl.orderId} past the vendor sweep range`);
      }
      metric(telemetry, METRIC_SELL_PLACED, 1);
      return openTx(cur, journalId, pl.orderId);
    }
    noteDaemon(pl);
    const reason = (pl && pl.reason) || "PLACE_FAILED";
    if (pl && typeof pl.rollbackFailed === "string") {
      metric(telemetry, METRIC_SELL_ROLLBACK_FAILED, 1);
      log(`market sell offer ${cur.offerId}: place rollback incomplete (${pl.rollbackFailed} ${pl.detail || ""})`);
    }
    if (pl && pl.permanent === true && pl.ambiguous !== true) {
      lastPermanent.set(cur.offerId, true);
      log(`market sell offer ${cur.offerId}: place refused for good (${reason} ${pl.detail || ""})`);
    } else if (pl && pl.ambiguous === true) {
      metric(telemetry, METRIC_PLACE_RETRY, 1);
    }
    return { action: "retry", reason };
  }

  async function settleSell(cur, filled, vendorReason) {
    const read = readOfferAndEntry(cur.offerId, S.marketPlaceOutboxKey(cur.offerId));
    if (!read.ok) return { action: "error", reason: read.reason };
    if (!read.entry) return { action: "error", reason: "NO_OUTBOX" };
    const p = read.entry.payload || {};
    const ret = adapter.tradeMarketReturnSellEscrow({ offerId: cur.offerId, orderId: cur.marketOrderId,
      corporationId: p.corporationId, stationId: p.stationId, typeId: p.typeId });
    noteEscrowClone();
    if (!ret || ret.ok !== true) return { action: "retry", reason: (ret && ret.reason) || "RETURN_FAILED" };
    if (ret.units > 0) metric(telemetry, METRIC_SELL_ESCROW_MOVED, ret.units);
    const ownIds = (Array.isArray(ret.stacks) ? ret.stacks : []).map((s) => s && s.itemId);
    const listed = await adapter.tradeListDeliveredStacks({ ownerKind: S.ISSUER_KIND_CORPORATION,
      ownerId: p.corporationId, corporationId: p.corporationId, npcStationId: p.stationId, typeId: p.typeId,
      flag: "hangar" });
    if (!listed || listed.ok !== true) return { action: "retry", reason: (listed && listed.reason) || "LIST_FAILED" };

    const closeKey = S.marketCloseOutboxKey(cur.offerId);
    const r = store.transaction("trade.market_settle_sell", (db) => {
      const o = offers.getOffer(db, cur.offerId);
      if (!o || o.ok !== true) throw new MarketRollback(o || { reason: "OFFER_READ_FAILED" });
      const fresh = o.offer;
      if (!fresh || fresh.state !== S.OPEN) return { stale: true };
      const f = journal.findByKey(db, closeKey);
      if (!f || f.ok !== true) throw new MarketRollback(f || { reason: "JOURNAL_READ_FAILED" });
      const closeReason = f.found && f.entry.payload && typeof f.entry.payload.reason === "string"
        ? f.entry.payload.reason : null;
      const F = Math.min(Math.max(filled, 0), fresh.quantity);
      const accepted = F > 0;
      const to = accepted ? S.ACCEPTED : S.INTAKE;
      const endReason = closeReason || vendorReason || S.END_REASON_MARKET_CANCELLED;
      const t = offers.transitionOfferInTx(db, {
        offerId: fresh.offerId, expectedVersion: fresh.version, from: S.OPEN, to, reason: "", at: clock.now(),
        ...(accepted ? { patch: { filledQuantity: F, acceptorCharacterId: null } } : {}),
      }, S.transitionKey(fresh.offerId, fresh.stateSeq + 1, to));
      if (!t.ok) throw new MarketRollback(t);
      const rest = fresh.quantity - F;
      if (rest > 0) {
        const plan = planReturnOwnFirst(rest, listed.stacks || [], ownIds);
        const e = journal.enqueueOutbox(db, {
          key: S.returnOutboxKey(fresh.offerId),
          aggregate: { type: S.OFFER_AGGREGATE, id: fresh.offerId },
          eventType: S.EVENT_OUTBOX_RETURN,
          payload: { offerId: fresh.offerId, npcStationId: p.stationId, ownerKind: S.ISSUER_KIND_CORPORATION,
            ownerId: p.corporationId, corporationId: p.corporationId, typeId: p.typeId, stacks: plan.stacks,
            reason: endReason, flag: "hangar" },
        });
        if (!e.ok) throw new MarketRollback(e);
      }
      if (f.found && f.entry.state === "PENDING") {
        const m = journal.markApplied(db, f.entry.journalId);
        if (!m.ok) throw new MarketRollback(m);
      }
      return { accepted, F, reason: endReason };
    });
    if (!r.ok) return { action: "error", reason: refusalOf(r).reason };
    if (r.value.stale) return { action: "retry", reason: "STALE" };
    metric(telemetry, METRIC_SELL_SETTLED, 1);
    if (r.value.accepted) {
      metric(telemetry, METRIC_SELL_SOLD_UNITS, r.value.F);
      return { action: "accepted", filled: r.value.F };
    }
    return { action: "closed", reason: r.value.reason };
  }

  async function stepMarketSellProceeds(sdeps, offer, opts) {
    const abandon = Boolean(opts && opts.abandonReturn === true);
    const read = store.transaction("trade.market.read_sell_return",
      (db) => journal.findByKey(db, S.returnOutboxKey(offer.offerId)));
    if (!read.ok || !read.value || read.value.ok !== true) return { action: "ERROR", reason: "JOURNAL_READ_FAILED" };
    const entry = read.value.found ? read.value.entry : null;
    const plan = entry && entry.state === "PENDING" ? entry.payload || {} : null;
    const planStacks = plan && Array.isArray(plan.stacks) ? plan.stacks : [];
    let voided = 0;
    for (const stack of abandon ? [] : planStacks) {
      const res = await adapter.tradeVoidStack({ ownerKind: S.ISSUER_KIND_CORPORATION, ownerId: plan.ownerId,
        corporationId: plan.corporationId, npcStationId: plan.npcStationId, itemId: stack.itemId,
        quantity: stack.quantity, key: S.voidKey(offer.offerId, stack.itemId), flag: "hangar" });
      if (!res || !res.ok) {
        if (res && res.reason === "ITEM_MISSING" && res.permanent === true) continue;
        if (!res || res.ambiguous === true || res.permanent === false) {
          return { action: "RETRY", reason: (res && res.reason) || "VOID_FAILED" };
        }
        log(`market sell ${offer.offerId}: void failed item ${stack.itemId}: ${res.reason}`);
        metric(telemetry, METRIC_SEAM_ERROR, 1);
        return { action: "ERROR", reason: res.reason };
      }
      voided += stack.quantity;
    }

    const tctx = treasuryContextOf(sdeps);
    const at = clock.now();
    const tx = store.transaction("trade.market_sell_proceeds", (db) => {
      const o = offers.getOffer(db, offer.offerId);
      if (!o || o.ok !== true) throw new SellRollback(o || { reason: "OFFER_READ_FAILED" });
      const cur = o.offer;
      if (!cur || cur.state !== S.ACCEPTED) return { outcome: "STALE" };
      const F = Number.isSafeInteger(cur.filledQuantity) ? cur.filledQuantity : 0;
      const split = settleProceedsTx(db, sdeps, cur, sellProceedsIsk(cur, F), at, tctx);
      const t = offers.transitionOfferInTx(db, {
        offerId: cur.offerId, expectedVersion: cur.version, from: S.ACCEPTED, to: S.DELIVERED, reason: S.DELIVERED, at,
        patch: { deliveredQuantity: F }, stockBackQuantity: voided,
      }, S.transitionKey(cur.offerId, cur.stateSeq + 1, S.DELIVERED));
      if (!t.ok) throw new SellRollback(t);
      if (plan !== null) {
        const m = abandon ? journal.markFailed(db, entry.journalId, "abandoned:INTAKE_RETRIES_EXHAUSTED")
          : journal.markApplied(db, entry.journalId);
        if (!m.ok) throw new SellRollback(m);
      }
      return { outcome: S.DELIVERED, ...split, stockBack: t.stockBack || null };
    });
    if (!tx.ok) {
      const refusal = tx.error instanceof SellRollback ? tx.error.refusal : null;
      const why = String((refusal && refusal.reason) || tx.reason || "TX_FAILED");
      if (why === TREASURY_NOT_READY || why === "STATIONS_NOT_READY") {
        if (why === TREASURY_NOT_READY) metric(telemetry, METRIC_WTS_PROCEEDS_WAIT, 1);
        return { action: "WAIT", reason: why };
      }
      log(`market sell ${offer.offerId}: proceeds failed ${why}`);
      metric(telemetry, METRIC_SEAM_ERROR, 1);
      return { action: "ERROR", reason: why };
    }
    const out = tx.value;
    if (out.outcome === "STALE") return { action: "STALE", reason: "STALE" };
    if (out.creditedIsk > 0) metric(telemetry, METRIC_WTS_PROCEEDS_ISK, out.creditedIsk);
    if (out.treasuryIsk > 0) metric(telemetry, METRIC_WTS_PROCEEDS_TREASURY, out.treasuryIsk);
    if (out.burnedIsk > 0) metric(telemetry, METRIC_WTS_PROCEEDS_BURNED, out.burnedIsk);
    if (out.stockBack && out.stockBack.credited > 0) metric(telemetry, METRIC_SELL_RETURNED_UNITS, out.stockBack.credited);
    if (out.stockBack && out.stockBack.lost > 0) metric(telemetry, METRIC_WTS_STOCK_LOST, out.stockBack.lost);
    if (abandon && plan !== null) {
      const lostUnits = planStacks.reduce((n, st) => n + (Number.isSafeInteger(st && st.quantity) ? st.quantity : 0), 0);
      if (lostUnits > 0) metric(telemetry, METRIC_SELL_RETURN_ABANDONED, lostUnits);
      log(`market sell ${offer.offerId}: return of ${lostUnits} units given up after failed voids - proceeds credited, `
        + "the rest is lost (INTAKE_RETRIES_EXHAUSTED)");
    }
    return { action: "DELIVERED", creditedIsk: out.creditedIsk };
  }

  async function cancelThenSettle(cur, closeReason) {
    const c = await adapter.tradeMarketCancel(cur.marketOrderId);
    noteDaemon(c);
    if (!c || c.ok !== true) return { action: "retry", reason: (c && c.reason) || "CANCEL_FAILED" };
    const again = await adapter.tradeMarketRead(cur.marketOrderId);
    noteDaemon(again);
    if (!again || again.ok !== true) return { action: "retry", reason: (again && again.reason) || "READ_FAILED" };
    const k = classifyMarketPoll(cur, again, closeReason, true);
    if (k.action === "SETTLE") return settle(cur, k.filled, k.reason);
    if (k.action === "DETACH_THEN_SETTLE") {
      const d = detach(cur);
      if (!d || d.ok !== true) return { action: "retry", reason: (d && d.reason) || "DETACH_FAILED" };
      return settle(cur, k.filled, k.reason);
    }
    return { action: "retry", reason: k.action };
  }

  async function pollMarket(offer, station, canClose) {
    if (typeof offer.marketOrderId !== "string" || offer.marketOrderId === "") return { action: "error", reason: "NO_ORDER_ID" };
    const now = clock.now();
    const channelOn = offer.side === S.SIDE_SELL ? sellOrdersFlag : buyOrdersEnabled;
    const closeReason = closeWanted(offer, station, now, mode) || (channelOn ? null : S.END_REASON_DISABLED);
    const read = await adapter.tradeMarketRead(offer.marketOrderId);
    noteDaemon(read);
    if (!read || read.ok !== true) return { action: "retry", reason: (read && read.reason) || "READ_FAILED" };
    const closeOutbox = hasCloseOutbox(offer.offerId);
    if (closeOutbox === null) return { action: "error", reason: "JOURNAL_READ_FAILED" };

    let cur = offer;
    let k = classifyMarketPoll(cur, read, closeReason, closeOutbox);
    if (k.action === "RECORD_FILL") {
      const f = fillTx(cur, k.filled);
      if (!f.ok) return { action: "error", reason: f.reason };
      cur = f.offer;
      k = classifyMarketPoll(cur, read, closeReason, closeOutbox);
    }

    if (read.missing === true && k.action !== "WAIT") {
      metric(telemetry, METRIC_MISSING, 1);
      log(`market offer ${cur.offerId}: order ${cur.marketOrderId} missing in the daemon, settled with F=${k.filled}`);
    }

    switch (k.action) {
      case "SETTLE":
        return settle(cur, k.filled, k.reason);
      case "DETACH_THEN_SETTLE": {
        const d = detach(cur);
        if (!d || d.ok !== true) return { action: "retry", reason: (d && d.reason) || "DETACH_FAILED" };
        return settle(cur, k.filled, k.reason);
      }
      case "CLOSE": {
        if (!canClose) return { action: "retry", reason: "CLOSE_BUDGET" };
        if (!closeOutbox) {
          const intent = closeIntentTx(cur, k.reason);
          if (!intent.ok) return { action: "error", reason: intent.reason, closeStarted: true };
        }
        const d = detach(cur);
        if (!d || d.ok !== true) {
          if (d && d.reason !== "ESCROW_BUSY") log(`market offer ${cur.offerId}: detach refused ${d.reason}`);
          return { action: d && d.reason === "ESCROW_BUSY" ? "retry" : "error", reason: (d && d.reason) || "DETACH_FAILED",
            closeStarted: true };
        }
        return { ...(await cancelThenSettle(cur, k.reason)), closeStarted: true };
      }
      case "CANCEL_THEN_SETTLE": {
        if (!canClose) return { action: "retry", reason: "CLOSE_BUDGET" };
        if (k.anomaly) {
          log(`market offer ${cur.offerId}: open order ${cur.marketOrderId} without the escrow record - cancelled`);
          const intent = closeIntentTx(cur, S.END_REASON_MARKET_CANCELLED);
          if (!intent.ok) return { action: "error", reason: intent.reason, closeStarted: true };
        }
        return { ...(await cancelThenSettle(cur, closeReason)), closeStarted: true };
      }
      default:
        return { action: "retry", reason: k.reason || "WAIT" };
    }
  }

  return Object.freeze({
    issueMarket,
    pollMarket,
    stepMarketSellProceeds,
    isDown: () => marketDown,
    isTripped: () => tripped,
    issueFailures: () => issueFailures,
    maxIssueFailures: () => maxIssueFailures,
  });
}

module.exports = { createMarketSteps, MarketRollback };
