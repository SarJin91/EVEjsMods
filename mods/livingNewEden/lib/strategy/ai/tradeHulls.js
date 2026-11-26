"use strict";

const TRADE_STATES = require("../data/tradeStates");
const { tierOf, tierCapOf, tierTtlOf, tierQuotas, mulDivFloor } = require("../data/tradeTiers");
const { pairTaken } = require("../data/tradePairs");
const { convoyItemsOf } = require("../data/convoyItems");
const { warQuoteAt } = require("../data/warPricePressure");

const PERMILLE = 1000;
const GROUP_PREFIX = "group:";
const HULL_GROUP_PREFIX = "hull/group:";
const ITEM_KIND_HULL = "hull";
const PURPOSE_HULL = "hull";
const OPEN_OFFER_STATES = TRADE_STATES.OPEN_OFFER_STATES;

const posInt = (v) => (Number.isSafeInteger(v) && v > 0 ? v : 0);

function groupOfItem(item) {
  if (!item || item.itemKind !== ITEM_KIND_HULL || typeof item.itemKey !== "string") return null;
  if (item.itemKey.startsWith(HULL_GROUP_PREFIX)) return item.itemKey.slice(HULL_GROUP_PREFIX.length);
  if (item.itemKey.startsWith(GROUP_PREFIX)) return item.itemKey.slice(GROUP_PREFIX.length);
  return null;
}

function hullsOn(trade, T) {
  return T.hullOffersEnabled === true && posInt(T.hullOffersPerReview) > 0 && posInt(T.hullMaxPerOffer) > 0
    && trade.hulls !== null && trade.hulls !== undefined && typeof trade.hulls === "object";
}

function hullCandidates(args) {
  const { trade, T, validChosen, desired, incomingHulls, production, stationsData, logisticsOpen,
    logisticsReady, chosenStationIds } = args;
  const candidates = [];
  const notes = [];
  if (!hullsOn(trade, T) || !Array.isArray(validChosen) || validChosen.length === 0) return { candidates, notes };
  const hullGroups = Array.isArray(args.hullGroups) ? args.hullGroups : [];
  const chosen = chosenStationIds instanceof Set ? chosenStationIds : new Set();
  const stations = Array.isArray(stationsData) ? stationsData : [];

  const elsewhere = new Map();
  const addElsewhere = (g, n) => { if (posInt(n) > 0) elsewhere.set(g, (elsewhere.get(g) || 0) + n); };
  for (const intent of (production && Array.isArray(production.intents) ? production.intents : [])) {
    if (intent.type === "PRODUCE" && !chosen.has(intent.stationId)) addElsewhere(intent.hullGroup, intent.runs);
  }
  for (const st of stations) {
    if (chosen.has(st.stationId)) continue;
    for (const j of st.activeJobs || []) addElsewhere(j.hullGroup, j.runs);
    if (logisticsReady) for (const [g, n] of Object.entries(st.hulls || {})) addElsewhere(g, n);
  }
  const convoys = new Map();
  for (const convoy of Array.isArray(logisticsOpen) ? logisticsOpen : []) {
    for (const item of convoyItemsOf(convoy)) {
      const g = groupOfItem(item);
      if (g === null || posInt(item.quantity) === 0) continue;
      const key = `${convoy.destStationId}|${g}`;
      convoys.set(key, (convoys.get(key) || 0) + item.quantity);
    }
  }

  let noType = false;
  for (let rank = 0; rank < validChosen.length; rank++) {
    const s = validChosen[rank];
    const deficit = s.deficit || {};
    for (const g of Object.keys(deficit)) {
      if (!(deficit[g] > 0) || !(desired[g] > 0)) continue;
      const h = Object.prototype.hasOwnProperty.call(trade.hulls, g) ? trade.hulls[g] : null;
      if (!h || !Number.isSafeInteger(h.typeId) || h.typeId <= 0) {
        if (Object.keys(trade.hulls).length === 0) noType = true;
        continue;
      }
      const itemKey = `${GROUP_PREFIX}${g}`;
      let openOffers = 0;
      for (const o of trade.open) {
        if (OPEN_OFFER_STATES.includes(o.state) && o.side !== TRADE_STATES.SIDE_SELL && o.stationId === s.stationId
          && o.itemKey === itemKey) {
          openOffers += posInt(o.quantity);
        }
      }
      const inc = incomingHulls instanceof Map && incomingHulls.get(s.stationId)
        ? (incomingHulls.get(s.stationId).get(g) || 0) : 0;
      const pipeline = inc + (convoys.get(`${s.stationId}|${g}`) || 0) + (elsewhere.get(g) || 0) + openOffers;
      const need = deficit[g] - pipeline;
      if (need <= 0) continue;
      candidates.push({ station: s, stationId: s.stationId, group: g, itemKey, typeId: h.typeId, need,
        deficitPct: Math.floor((need * PERMILLE) / desired[g]), rank, kind: ITEM_KIND_HULL });
    }
  }
  if (noType) notes.push("TRADE_HULL_NO_TYPE");
  const gi = (g) => {
    const i = hullGroups.indexOf(g);
    return i === -1 ? hullGroups.length : i;
  };
  candidates.sort((a, b) => b.deficitPct - a.deficitPct || a.rank - b.rank || gi(a.group) - gi(b.group)
    || (a.group < b.group ? -1 : a.group > b.group ? 1 : 0));
  return { candidates, notes };
}

function sizeHullOffer(a) {
  const { T, tiers, quota, q, need, itemKey, budgetLeft, volCap, notes } = a;
  const TC = tiers ? tiers.cfg : null;
  const unit = q.unitMilli;
  const vol = typeof volCap === "function" ? volCap(itemKey) : T.maxQuantityPerOffer;
  const needQ = Math.min(need, T.hullMaxPerOffer, T.maxQuantityPerOffer, vol);
  const iskLimit = TC
    ? Math.min(T.maxIskPerOffer, budgetLeft, tiers.gateIsk, tiers.austerity ? TC.tier2Isk : Infinity)
    : Math.min(T.maxIskPerOffer, budgetLeft);
  let quantity = Math.min(needQ, iskLimit > 0 ? mulDivFloor(iskLimit, PERMILLE, unit) : 0);
  let iskTotal = quantity > 0 ? mulDivFloor(quantity, unit, PERMILLE) : 0;
  let cls = 0;
  if (TC && quantity >= 1) {
    cls = tierOf(iskTotal, TC);
    while (tiers.used[cls - 1] >= quota[cls - 1]) {
      if (cls <= 1) {
        quantity = 0;
        break;
      }
      quantity = mulDivFloor(Math.min(iskTotal, tierCapOf(cls - 1, TC)), PERMILLE, unit);
      if (quantity < 1) break;
      iskTotal = mulDivFloor(quantity, unit, PERMILLE);
      cls = tierOf(iskTotal, TC);
    }
    if (quantity < 1) {
      if (!tiers.fullNoted) {
        tiers.fullNoted = true;
        notes.push("TRADE_TIER_FULL");
      }
      return { ok: false };
    }
  }
  if (quantity < 1 || iskTotal < T.minIskPerOffer) {
    notes.push(`TRADE_OFFER_SMALL:${itemKey}`);
    return { ok: false };
  }
  return { ok: true, quantity, iskTotal, cls, ttlMs: TC ? tierTtlOf(cls, TC) : T.offerTtlMs };
}

function planHullOffers(args) {
  const { trade, T, at, candidates, newOffers, state, intents, notes } = args;
  if (!hullsOn(trade, T) || !Array.isArray(candidates) || candidates.length === 0) return;
  const tiers = args.tiers || null;
  const quota = tiers ? tierQuotas(T.maxOpenOffersPerFaction, tiers.cfg) : null;
  let hullCreated = 0;
  for (const cand of candidates) {
    if (hullCreated >= T.hullOffersPerReview || state.offersCreated >= T.maxOffersPerReview) break;
    const { stationId, itemKey, typeId, need, station } = cand;
    if (pairTaken(trade.open, newOffers, stationId, itemKey)) {
      notes.push(`TRADE_OFFER_EXISTS:${itemKey}@${stationId}`);
      continue;
    }
    if (state.openFactionCount >= T.maxOpenOffersPerFaction) {
      notes.push("TRADE_FACTION_LIMIT");
      break;
    }
    const stationOpen = state.openPerStation.get(stationId) || 0;
    if (stationOpen >= T.maxOpenOffersPerStation) {
      notes.push(`TRADE_STATION_LIMIT:${stationId}`);
      continue;
    }
    const q = warQuoteAt(trade, stationId, itemKey);
    if (!q || !q.ok || !(q.unitMilli > 0)) {
      notes.push(`TRADE_NO_PRICE:${itemKey}`);
      continue;
    }
    const sized = sizeHullOffer({ T, tiers, quota, q, need, itemKey, budgetLeft: state.budgetLeft,
      volCap: args.volCap, notes });
    if (!sized.ok) continue;
    const stationInfo = trade.stations.find((s) => s.stationId === stationId);
    if (!stationInfo || stationInfo.kind !== "npc") {
      notes.push(`TRADE_NO_NPC_STATION:${stationId}`);
      continue;
    }
    const offer = {
      type: "TRADE_OFFER",
      slot: state.offersCreated,
      stationId,
      systemId: station.systemId,
      issuerCorporationId: stationInfo.ownerCorporationId,
      itemKind: ITEM_KIND_HULL,
      itemKey,
      typeId,
      quantity: sized.quantity,
      unitPriceMilli: q.unitMilli,
      iskTotal: sized.iskTotal,
      refPriceMilli: q.refMilli,
      capPriceMilli: q.capMilli,
      priceSource: q.source,
      expiresAt: at + sized.ttlMs,
      purpose: PURPOSE_HULL,
    };
    if (tiers) {
      offer.tier = sized.cls;
      tiers.used[sized.cls - 1] += 1;
    }
    if (Number.isSafeInteger(q.warPermille) && q.warPermille > 0) {
      offer.warPermille = q.warPermille;
      notes.push(`TRADE_WAR_PRICE:${itemKey}@${stationId}:${q.warPermille}`);
    }
    if (q.stationCapped === true) {
      offer.stationCapped = true;
      notes.push(`TRADE_WAR_STATION_CAPPED:${itemKey}@${stationId}`);
    }
    state.budgetLeft -= sized.iskTotal;
    state.openFactionCount += 1;
    state.openPerStation.set(stationId, stationOpen + 1);
    state.offersCreated += 1;
    hullCreated += 1;
    intents.push(offer);
    newOffers.push(offer);
    notes.push(`TRADE_HULL_OFFER:${itemKey}@${stationId}`);
  }
}

module.exports = { hullCandidates, planHullOffers, sizeHullOffer, PURPOSE_HULL };
