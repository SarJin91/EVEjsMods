"use strict";

const { mulDivFloor } = require("../data/tradeTiers");
const { pairTaken } = require("../data/tradePairs");
const TRADE_STATES = require("../data/tradeStates");
const { factionCapOf, planSellOffers, ceilDiv } = require("./tradeSell");

const PERMILLE = 1000;
const SIDE_SELL = TRADE_STATES.SIDE_SELL;
const KIND_NPC = "npc";

const posInt = (v) => (Number.isSafeInteger(v) && v > 0 ? v : 0);
const byId = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const hasOwn = (o, k) => Boolean(o) && Object.prototype.hasOwnProperty.call(o, k);

function planCommodityBuys(args) {
  const { trade, T, at, newOffers, state, intents, notes } = args;
  const commodity = trade.commodity;
  const volCap = typeof args.volCap === "function" ? args.volCap : () => T.maxQuantityPerOffer;
  const lotIsk = typeof args.lotIsk === "number" && args.lotIsk > 0 ? args.lotIsk : Infinity;
  const needs = Array.isArray(commodity.needs) ? commodity.needs : [];
  const upwell = Number.isSafeInteger(commodity.noDonorStations) ? commodity.noDonorStations
    : new Set(needs.filter((n) => n.kind !== KIND_NPC).map((n) => n.stationId)).size;
  if (upwell > 0) notes.push(`TRADE_COMMODITY_UPWELL:${upwell}`);
  const perReview = posInt(T.commodityOffersPerReview);
  const { factionCap } = factionCapOf(trade, T);
  const quotes = commodity.quotes || {};
  const kinds = commodity.kinds || {};
  const noPrice = new Set();
  let used = 0;
  for (const n of needs) {
    if (n.kind !== KIND_NPC) continue;
    const stationInfo = trade.stations.find((s) => s.stationId === n.stationId && s.kind === KIND_NPC);
    if (!stationInfo) continue;
    if (state.offersCreated >= T.maxOffersPerReview || used >= perReview
      || state.openFactionCount >= factionCap || !(state.budgetLeft > 0)) {
      notes.push("TRADE_COMMODITY_LIMIT");
      break;
    }
    const { stationId, itemKey, typeId } = n;
    if (pairTaken(trade.open, newOffers, stationId, itemKey)) {
      notes.push(`TRADE_OFFER_EXISTS:${itemKey}@${stationId}`);
      continue;
    }
    const stationOpen = state.openPerStation.get(stationId) || 0;
    if (stationOpen + 1 + T.wtsStationSlotHeadroom > T.maxOpenOffersPerStation) {
      notes.push(`TRADE_STATION_LIMIT:${stationId}`);
      continue;
    }
    const q = hasOwn(quotes, itemKey) ? quotes[itemKey] : null;
    if (!q || q.ok !== true || !posInt(q.unitMilli) || !hasOwn(kinds, itemKey)) {
      if (!noPrice.has(itemKey)) {
        noPrice.add(itemKey);
        notes.push(`TRADE_COMMODITY_NO_PRICE:${itemKey}`);
      }
      continue;
    }
    const iskCap = Math.min(T.maxIskPerOffer, lotIsk, state.budgetLeft);
    const quantity = Math.min(n.need, T.maxQuantityPerOffer, volCap(itemKey), mulDivFloor(iskCap, PERMILLE, q.unitMilli));
    const iskTotal = quantity >= 1 ? ceilDiv(quantity * q.unitMilli, PERMILLE) : 0;
    if (quantity < 1 || !Number.isSafeInteger(iskTotal) || iskTotal < T.minIskPerOffer) {
      notes.push(`TRADE_OFFER_SMALL:${itemKey}`);
      continue;
    }
    const offer = {
      type: "TRADE_OFFER",
      slot: state.offersCreated,
      stationId,
      systemId: stationInfo.systemId,
      issuerCorporationId: stationInfo.ownerCorporationId,
      itemKind: kinds[itemKey],
      itemKey,
      typeId,
      quantity,
      unitPriceMilli: q.unitMilli,
      iskTotal,
      refPriceMilli: q.refMilli,
      capPriceMilli: q.capMilli,
      priceSource: q.source,
      expiresAt: at + T.offerTtlMs,
    };
    state.budgetLeft -= iskTotal;
    state.openFactionCount += 1;
    state.openPerStation.set(stationId, stationOpen + 1);
    state.offersCreated += 1;
    used += 1;
    intents.push(offer);
    newOffers.push(offer);
    notes.push(`TRADE_COMMODITY_BUY:${itemKey}@${stationId}`);
  }
  return { used };
}

function commoditySellCandidates({ trade, T, stationsData }) {
  const candidates = [];
  const notes = [];
  const commodity = trade.commodity;
  const kinds = commodity.kinds || {};
  const reserveOf = commodity.reserve || {};
  const enforced = commodity.enforced || {};
  const demandOn = enforced.fuel === true || enforced.advanced === true;
  const needAt = Array.isArray(commodity.shortKeys) ? new Set(commodity.shortKeys)
    : new Set((Array.isArray(commodity.needs) ? commodity.needs : [])
      .filter((n) => n.need > 0).map((n) => `${n.stationId}|${n.itemKey}`));
  const floatPermille = Number.isSafeInteger(T.commodityFloatPermille) ? T.commodityFloatPermille : 0;
  const minUnits = posInt(T.commodityMinSellUnits) || 1;
  const data = Array.isArray(stationsData) ? stationsData : [];
  const npc = trade.stations.filter((s) => s.kind === KIND_NPC).sort((a, b) => byId(a.stationId, b.stationId));
  for (const stationInfo of npc) {
    const st = data.find((x) => x.stationId === stationInfo.stationId);
    const stock = st && st.commodities && typeof st.commodities === "object" ? st.commodities : null;
    if (stock === null) continue;
    const keys = Object.keys(stock).filter((k) => hasOwn(kinds, k) && posInt(stock[k]) > 0).sort(byId);
    if (keys.length === 0) continue;
    if (demandOn && !hasOwn(reserveOf, stationInfo.stationId)) {
      notes.push(`TRADE_COMMODITY_NO_RESERVE:${stationInfo.stationId}`);
      continue;
    }
    const reserve = reserveOf[stationInfo.stationId] || {};
    for (const itemKey of keys) {
      if (needAt.has(`${stationInfo.stationId}|${itemKey}`)) continue;
      const have = stock[itemKey];
      const surplus = Math.max(0, have - posInt(reserve[itemKey]));
      const float = Math.floor((have * floatPermille) / PERMILLE);
      const qty = Math.max(surplus, float);
      if (qty < minUnits) continue;
      candidates.push({ stationId: stationInfo.stationId, stationInfo, itemKind: kinds[itemKey], itemKey,
        typeId: Number(itemKey.slice("type:".length)), surplus: qty });
    }
  }
  return { candidates, notes };
}

function planCommoditySells(args) {
  const { trade, T, newOffers, notes } = args;
  const commodity = trade.commodity;
  if (!commodity || !commodity.sellQuotes) return { maxNew: 0 };
  const sells = newOffers.filter((o) => o.side === SIDE_SELL).length;
  const maxNew = Math.min(posInt(T.commodityOffersPerReview) - posInt(args.usedBuys),
    posInt(T.wtsOffersPerReview) - sells);
  if (maxNew <= 0) return { maxNew: 0 };
  const sc = commoditySellCandidates({ trade, T, stationsData: args.stationsData });
  notes.push(...sc.notes);
  planSellOffers({ trade, T, at: args.at, candidates: sc.candidates, newOffers, state: args.state,
    intents: args.intents, notes, volCap: args.volCap, quotes: commodity.sellQuotes, maxNew });
  return { maxNew };
}

module.exports = { planCommodityBuys, commoditySellCandidates, planCommoditySells };
