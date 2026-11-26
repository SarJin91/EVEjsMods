"use strict";

const S = require("./schema");

const MARKET_ORPHAN_SEAM_UNAVAILABLE = Object.freeze({ ok: false, reason: "MARKET_ORPHAN_SEAM_UNAVAILABLE" });
const METRIC_SELL_ORPHANS = "trade.marketSellOrphans";

async function runOrphanScan(deps, scanCorporations = false, afterOrderId = "0", corpIndex = 0) {
  const { config, getGovernor } = deps;
  const tradeCfg = config.trade || {};
  const maxOrphansPerPass = Math.max(0, Math.trunc(tradeCfg.maxBuyOrderOrphansPerPass || 2));
  const scanPage = Math.max(8, Math.min(512, Math.trunc(tradeCfg.marketOrphanScanPage || 64)));

  const after = String(afterOrderId || "0");
  const startIndex = Number.isSafeInteger(corpIndex) && corpIndex >= 0 ? corpIndex : 0;
  const deferredResult = Object.freeze({ processed: 0, cleaned: 0, errors: 0, deferred: true, nextCursor: after,
    nextCorpIndex: startIndex });

  const governor = typeof getGovernor === "function" ? getGovernor() : null;
  if (governor && typeof governor.admits === "function" && governor.admits("OPERATIONAL") === false) {
    return deferredResult;
  }
  if (maxOrphansPerPass <= 0) return { ...deferredResult, deferred: false };

  const escrowResult = await scanEscrows(deps, scanPage, after, maxOrphansPerPass);
  if (escrowResult.listFailed) return { ...deferredResult, errors: 1 };
  let processed = escrowResult.processed;
  let cleaned = escrowResult.cleaned;
  let errors = escrowResult.errors;
  let nextCorpIndex = startIndex;

  const left = maxOrphansPerPass - escrowResult.actions;
  if (scanCorporations && left > 0) {
    const corpResult = await scanCorporationOrders(deps, left, startIndex);
    processed += corpResult.processed;
    cleaned += corpResult.cleaned;
    errors += corpResult.errors;
    nextCorpIndex = corpResult.nextCorpIndex;
  }

  return { processed, cleaned, errors, nextCursor: escrowResult.nextCursor, nextCorpIndex };
}

async function scanEscrows(deps, limit, afterOrderId, budget) {
  const { store, offers, adapter, telemetry, logger } = deps;

  const listRes = await adapter.tradeMarketListTaggedEscrows({ limit, afterOrderId });
  if (!listRes || listRes.ok !== true || !Array.isArray(listRes.escrows)) {
    log(logger, `[tradeMarketOrphans] tradeMarketListTaggedEscrows failed: ${listRes && listRes.reason}`);
    metric(telemetry, "trade.seamError", 1);
    return { processed: 0, cleaned: 0, errors: 1, actions: 0, nextCursor: afterOrderId, listFailed: true };
  }

  let processed = 0;
  let cleaned = 0;
  let errors = 0;
  let actions = 0;
  let lastExamined = afterOrderId;
  let stoppedEarly = false;

  for (const escrow of listRes.escrows) {
    if (actions >= budget) { stoppedEarly = true; break; }
    const { orderId, lneOfferId, pendingFill } = escrow;

    const offerRes = store.transaction("trade.market.orphan.find_offer", (db) => offers.getOffer(db, lneOfferId));
    if (!offerRes.ok || !offerRes.value || offerRes.value.ok !== true) {
      log(logger, `[tradeMarketOrphans] offer ${lneOfferId} unreadable (order ${orderId}), deferred: `
        + `${offerRes.reason || (offerRes.value && offerRes.value.reason)}`);
      errors += 1;
      stoppedEarly = true;
      break;
    }
    processed += 1;
    lastExamined = orderId;

    const reason = orphanReason(offerRes.value.offer, orderId);
    if (reason === null) continue;
    if (pendingFill) {
      log(logger, `[tradeMarketOrphans] escrow ${orderId} (offer ${lneOfferId}) has a pending fill, skipped: ${reason}`);
      metric(telemetry, "trade.marketOrphanEscrowBusy", 1);
      continue;
    }
    actions += 1;
    const outcome = escrow.escrowType === "sell"
      ? await processOrphanSellEscrow(deps, escrow, reason)
      : await processOrphanEscrow(deps, orderId, lneOfferId, reason);
    if (outcome === "CLEANED") cleaned += 1;
    else if (outcome === "FAILED") errors += 1;
  }

  const more = listRes.truncated === true || stoppedEarly;
  const nextCursor = more && lastExamined !== "0" ? String(lastExamined) : "0";
  return { processed, cleaned, errors, actions, nextCursor };
}

function orphanReason(offer, orderId) {
  if (!offer) return "NO_OFFER";
  if (S.TERMINAL_OFFER_STATES.includes(offer.state)) return `OFFER_${offer.state}`;
  if (offer.channel !== S.CHANNEL_MARKET) return "CHANNEL_MISMATCH";
  if (offer.state === S.ISSUING) return null;
  if (offer.marketOrderId !== orderId) return "ORDER_ID_MISMATCH";
  return null;
}

async function processOrphanEscrow(deps, orderId, lneOfferId, reason) {
  const { adapter, telemetry, logger } = deps;

  const detachRes = await adapter.tradeMarketDetachEscrow({ orderId, offerId: lneOfferId });
  if (!detachRes || detachRes.ok !== true) {
    if (detachRes && detachRes.reason === "ESCROW_BUSY") {
      log(logger, `[tradeMarketOrphans] escrow ${orderId} busy during detach: ${reason}`);
      metric(telemetry, "trade.marketOrphanEscrowBusy", 1);
      return "BUSY";
    }
    log(logger, `[tradeMarketOrphans] tradeMarketDetachEscrow failed for ${orderId}: ${detachRes && detachRes.reason}`);
    metric(telemetry, "trade.seamError", 1);
    return "FAILED";
  }

  const cancelRes = await adapter.tradeMarketCancel(orderId);
  if (!cancelRes || cancelRes.ok !== true) {
    log(logger, `[tradeMarketOrphans] tradeMarketCancel failed for ${orderId}: ${cancelRes && cancelRes.reason}`);
    metric(telemetry, "trade.seamError", 1);
    return "FAILED";
  }

  metric(telemetry, "trade.marketOrphans", 1);
  log(logger, `[tradeMarketOrphans] cleaned orphan escrow ${orderId} (offer ${lneOfferId}): ${reason}, order cancelled`);
  return "CLEANED";
}

async function processOrphanSellEscrow(deps, escrow, reason) {
  const { adapter, telemetry, logger } = deps;
  const { orderId, lneOfferId, ownerId, stationId, typeId } = escrow;
  const detachRes = await adapter.tradeMarketDetachEscrow({ orderId, offerId: lneOfferId, escrowType: "sell" });
  if (!detachRes || detachRes.ok !== true) {
    if (detachRes && detachRes.reason === "ESCROW_BUSY") {
      metric(telemetry, "trade.marketOrphanEscrowBusy", 1);
      return "BUSY";
    }
    log(logger, `[tradeMarketOrphans] sell detach failed for ${orderId}: ${detachRes && detachRes.reason}`);
    metric(telemetry, "trade.seamError", 1);
    return "FAILED";
  }
  const cancelRes = await adapter.tradeMarketCancel(orderId);
  if (!cancelRes || cancelRes.ok !== true) {
    log(logger, `[tradeMarketOrphans] tradeMarketCancel failed for sell ${orderId}: ${cancelRes && cancelRes.reason}`);
    metric(telemetry, "trade.seamError", 1);
    return "FAILED";
  }
  const ret = typeof adapter.tradeMarketReturnSellEscrow === "function"
    ? await adapter.tradeMarketReturnSellEscrow({ offerId: lneOfferId, orderId, corporationId: ownerId, stationId, typeId })
    : null;
  if (!ret || ret.ok !== true) {
    log(logger, `[tradeMarketOrphans] sell ${orderId}: escrow return failed ${ret && ret.reason}`);
    metric(telemetry, "trade.seamError", 1);
    return "FAILED";
  }
  for (const st of ret.stacks || []) {
    const v = await adapter.tradeVoidStack({ ownerKind: S.ISSUER_KIND_CORPORATION, ownerId, corporationId: ownerId,
      npcStationId: stationId, itemId: st.itemId, quantity: st.quantity, key: S.marketOrphanVoidKey(orderId, st.itemId),
      flag: "hangar" });
    if (!v || v.ok !== true) {
      log(logger, `[tradeMarketOrphans] sell ${orderId}: void of item ${st.itemId} failed ${v && v.reason}`);
      metric(telemetry, "trade.seamError", 1);
      return "FAILED";
    }
  }
  metric(telemetry, METRIC_SELL_ORPHANS, 1);
  log(logger, `[tradeMarketOrphans] cleaned orphan sell escrow ${orderId} (offer ${lneOfferId}): ${reason}, `
    + `order cancelled, ${ret.units} units voided`);
  return "CLEANED";
}

async function scanCorporationOrders(deps, budget, startIndex) {
  const { store, offers, adapter, telemetry, logger } = deps;
  const sellOrdersOn = Boolean(deps.config && deps.config.trade && deps.config.trade.marketSellOrdersEnabled === true);

  const corpRes = store.transaction("trade.market.orphan.list_corps", (db) => offers.listMarketCorporations(db));
  if (!corpRes.ok || !corpRes.value || corpRes.value.ok !== true) {
    log(logger, `[tradeMarketOrphans] listMarketCorporations failed: ${corpRes.reason || (corpRes.value && corpRes.value.reason)}`);
    return { processed: 0, cleaned: 0, errors: 1, nextCorpIndex: startIndex };
  }
  const corporationIds = corpRes.value.corporationIds;
  if (corporationIds.length === 0) return { processed: 0, cleaned: 0, errors: 0, nextCorpIndex: 0 };

  let index = startIndex % corporationIds.length;
  let processed = 0;
  let cleaned = 0;
  let errors = 0;
  let actions = 0;

  for (let visited = 0; visited < budget && visited < corporationIds.length && actions < budget; visited += 1) {
    const corpId = corporationIds[index];
    index = (index + 1) % corporationIds.length;

    const listRes = await adapter.tradeMarketListCorpOrders(corpId);
    if (!listRes || listRes.ok !== true || !Array.isArray(listRes.orders)) {
      log(logger, `[tradeMarketOrphans] tradeMarketListCorpOrders failed for corp ${corpId}: ${listRes && listRes.reason}`);
      metric(telemetry, "trade.seamError", 1);
      errors += 1;
      continue;
    }

    for (const order of listRes.orders) {
      if (actions >= budget) break;
      if (order.bid === false && !sellOrdersOn) continue;
      processed += 1;
      const { orderId, stationId, typeId, hasEscrow } = order;
      if (hasEscrow) continue;

      const guardRes = store.transaction("trade.market.orphan.order_guard", (db) => offers.marketOrderGuard(db,
        { corporationId: corpId, npcStationId: stationId, typeId, orderId: String(orderId) }));
      if (!guardRes.ok || !guardRes.value || guardRes.value.ok !== true) {
        log(logger, `[tradeMarketOrphans] order ${orderId} (corp ${corpId}) guard unreadable, skipped`);
        errors += 1;
        continue;
      }
      if (guardRes.value.liveOffer || guardRes.value.issuing) continue;

      actions += 1;
      const cancelRes = await adapter.tradeMarketCancel(String(orderId));
      if (!cancelRes || cancelRes.ok !== true) {
        log(logger, `[tradeMarketOrphans] tradeMarketCancel failed for order ${orderId} (corp ${corpId}): ${cancelRes && cancelRes.reason}`);
        metric(telemetry, "trade.seamError", 1);
        errors += 1;
        continue;
      }
      metric(telemetry, "trade.marketOrphans", 1);
      log(logger, `[tradeMarketOrphans] cleaned orphan order ${orderId} (corp ${corpId}): no record, no live offer`);
      cleaned += 1;
    }
  }

  return { processed, cleaned, errors, nextCorpIndex: index };
}

function metric(telemetry, name, value) {
  if (!telemetry || typeof telemetry.count !== "function") return;
  try { telemetry.count(name, value); } catch (_err) {}
}

function log(logger, ...args) {
  if (logger && typeof logger.log === "function") logger.log(...args);
}

module.exports = {
  runOrphanScan,
  scanEscrows,
  scanCorporationOrders,
  MARKET_ORPHAN_SEAM_UNAVAILABLE,
};
