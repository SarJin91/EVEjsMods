"use strict";

const S = require("./schema");
const { issueGate } = require("./executorRules");

const BUY_ORDER_DURATIONS = Object.freeze([1, 3, 7, 14, 30, 90]);
const DAY_MS = 86400000;

const isPosId = (v) => Number.isSafeInteger(v) && v > 0;

function priceCents(offer) {
  const milli = offer && Number.isSafeInteger(offer.unitPriceMilli) ? offer.unitPriceMilli : 0;
  return milli > 0 ? Math.floor(milli / 10) : 0;
}

function marketSpendIsk(offer, filled) {
  const quantity = offer && Number.isSafeInteger(offer.quantity) ? offer.quantity : 0;
  const iskTotal = offer && Number.isSafeInteger(offer.iskTotal) ? offer.iskTotal : 0;
  const f = Number.isSafeInteger(filled) ? Math.min(Math.max(filled, 0), quantity) : 0;
  const cents = priceCents(offer) * f;
  return Math.min(iskTotal, Math.ceil(cents / 100));
}

function hullMarketFlag(config) {
  const c = config || {};
  return Boolean(c.trade && c.trade.hullBuyOrdersEnabled === true)
    && !(c.warContracts && c.warContracts.enabled === true);
}

function chooseChannel(offer, station, flags) {
  const f = flags || {};
  const contract = f.contractsEnabled === true ? S.CHANNEL_CONTRACT : null;
  if (!offer) return contract;
  if (offer.side === S.SIDE_SELL) {
    const sellOk = f.sellOrdersEnabled === true && f.marketDown !== true
      && (offer.itemKind === S.ITEM_KIND_MINERAL || offer.itemKind === S.ITEM_KIND_MOON
        || offer.itemKind === S.ITEM_KIND_PI)
      && !isPosId(offer.assigneeCharacterId)
      && !isPosId(offer.issuerCharacterId)
      && Boolean(station) && station.kind === "npc"
      && priceCents(offer) >= 1;
    return sellOk ? S.CHANNEL_MARKET : contract;
  }
  const kindOk = offer.itemKind === S.ITEM_KIND_MINERAL
    || (f.hullBuyOrdersEnabled === true && offer.itemKind === S.ITEM_KIND_HULL)
    || (f.commodityBuyOrdersEnabled === true
      && (offer.itemKind === S.ITEM_KIND_MOON || offer.itemKind === S.ITEM_KIND_PI));
  const marketOk = f.buyOrdersEnabled === true && f.marketReady === true && f.marketDown !== true
    && (offer.side === undefined || offer.side === S.SIDE_BUY)
    && kindOk
    && !isPosId(offer.assigneeCharacterId)
    && !isPosId(offer.issuerCharacterId)
    && Boolean(station) && station.kind === "npc"
    && priceCents(offer) >= 1;
  return marketOk ? S.CHANNEL_MARKET : contract;
}

function marketIssueGate(offer, station, issuer) {
  const gate = issueGate(offer, station, issuer);
  if (gate) return gate;
  return priceCents(offer) >= 1 ? null : "PRICE_TOO_LOW";
}

function buildMarketPlacePayload(offer, station, cfg) {
  const c = cfg || {};
  const minVolume = Math.min(Math.max(1, Math.trunc(Number(c.buyOrderMinVolume) || 1)), offer.quantity);
  return {
    offerId: offer.offerId,
    corporationId: offer.issuerCorporationId,
    accountKey: c.buyOrderWalletAccountKey,
    stationId: station.npcStationId,
    typeId: offer.typeId,
    quantity: offer.quantity,
    priceCents: priceCents(offer),
    durationDays: c.buyOrderDurationDays,
    minVolume,
  };
}

function buildMarketSellPayload(offer, station, cfg) {
  const c = cfg || {};
  return {
    offerId: offer.offerId,
    side: S.SIDE_SELL,
    corporationId: offer.issuerCorporationId,
    accountKey: c.buyOrderWalletAccountKey,
    stationId: station.npcStationId,
    typeId: offer.typeId,
    quantity: offer.quantity,
    priceCents: priceCents(offer),
    durationDays: c.sellOrderDurationDays,
    grantKey: S.grantKey(offer.offerId),
  };
}

function sellProceedsIsk(offer, filled) {
  const quantity = offer && Number.isSafeInteger(offer.quantity) ? offer.quantity : 0;
  const iskTotal = offer && Number.isSafeInteger(offer.iskTotal) ? offer.iskTotal : 0;
  const f = Number.isSafeInteger(filled) ? Math.min(Math.max(filled, 0), quantity) : 0;
  return Math.min(iskTotal, Math.floor((priceCents(offer) * f) / 100));
}

const WAIT = "WAIT";

function classifyMarketPoll(offer, read, closeReason, hasCloseOutbox) {
  const quantity = Number.isSafeInteger(offer.quantity) ? offer.quantity : 0;
  const recorded = Number.isSafeInteger(offer.filledQuantity) ? offer.filledQuantity : 0;
  const r = read || {};
  const recordType = offer.side === S.SIDE_SELL ? "sell" : "buy";
  const escrow = r.escrow && r.escrow.escrowType === recordType && r.escrow.lneOfferId === offer.offerId
    ? r.escrow : null;
  const saga = Boolean(escrow && escrow.pendingFill === true);

  if (r.missing === true || !r.order) {
    if (saga) return { action: WAIT, filled: recorded, reason: null };
    return { action: escrow ? "DETACH_THEN_SETTLE" : "SETTLE", filled: recorded, reason: S.END_REASON_MARKET_MISSING };
  }

  const remaining = Number.isSafeInteger(r.order.volRemaining) ? r.order.volRemaining : quantity;
  const filled = Math.min(Math.max(quantity - remaining, 0), quantity);
  const state = r.order.state;

  if (state === "filled") {
    if (saga) return { action: WAIT, filled: quantity, reason: null };
    return { action: escrow ? "DETACH_THEN_SETTLE" : "SETTLE", filled: quantity, reason: null };
  }
  if (state === "cancelled" || state === "expired") {
    if (saga) return { action: WAIT, filled, reason: null };
    return { action: escrow ? "DETACH_THEN_SETTLE" : "SETTLE", filled,
      reason: state === "expired" ? S.END_REASON_MARKET_EXPIRED : S.END_REASON_MARKET_CANCELLED };
  }
  if (state !== "open") return { action: WAIT, filled: recorded, reason: null };

  if (filled > recorded) return { action: "RECORD_FILL", filled, reason: null };
  if (saga) return { action: WAIT, filled, reason: null };
  if (escrow) {
    return closeReason || hasCloseOutbox === true ? { action: "CLOSE", filled, reason: closeReason }
      : { action: WAIT, filled, reason: null };
  }
  return { action: "CANCEL_THEN_SETTLE", filled, reason: hasCloseOutbox ? null : S.END_REASON_MARKET_CANCELLED,
    anomaly: hasCloseOutbox !== true };
}

function validateBuyOrderConfig(tradeCfg) {
  const c = tradeCfg || {};
  const bad = (detail) => ({ ok: false, reason: "BUY_ORDERS_CONFIG_INVALID", detail });
  if (!Number.isSafeInteger(c.buyOrderWalletAccountKey)) return bad("buyOrderWalletAccountKey");
  if (c.buyOrderWalletAccountKey === c.walletAccountKey) return bad("buyOrderWalletAccountKey === walletAccountKey");
  if (!BUY_ORDER_DURATIONS.includes(c.buyOrderDurationDays)) return bad(`buyOrderDurationDays not in ${BUY_ORDER_DURATIONS.join(",")}`);
  if (!Number.isSafeInteger(c.buyOrderTtlMs) || c.buyOrderTtlMs <= 0) return bad("buyOrderTtlMs");
  if (c.buyOrderDurationDays * DAY_MS < c.buyOrderTtlMs + DAY_MS) return bad("buyOrderDurationDays shorter than buyOrderTtlMs + 1 day");
  return { ok: true };
}

function validateSellOrderConfig(tradeCfg) {
  const c = tradeCfg || {};
  const bad = (detail) => ({ ok: false, reason: "SELL_ORDERS_CONFIG_INVALID", detail });
  if (!Number.isSafeInteger(c.buyOrderWalletAccountKey)) return bad("buyOrderWalletAccountKey");
  if (c.buyOrderWalletAccountKey === c.walletAccountKey) return bad("buyOrderWalletAccountKey === walletAccountKey");
  if (!BUY_ORDER_DURATIONS.includes(c.sellOrderDurationDays)) return bad(`sellOrderDurationDays not in ${BUY_ORDER_DURATIONS.join(",")}`);
  if (!Number.isSafeInteger(c.wtsTtlMs) || c.wtsTtlMs <= 0) return bad("wtsTtlMs");
  if (c.sellOrderDurationDays * DAY_MS < c.wtsTtlMs + DAY_MS) return bad("sellOrderDurationDays shorter than wtsTtlMs + 1 day");
  return { ok: true };
}

module.exports = {
  BUY_ORDER_DURATIONS,
  priceCents,
  marketSpendIsk,
  hullMarketFlag,
  chooseChannel,
  marketIssueGate,
  buildMarketPlacePayload,
  buildMarketSellPayload,
  sellProceedsIsk,
  classifyMarketPoll,
  validateBuyOrderConfig,
  validateSellOrderConfig,
};
