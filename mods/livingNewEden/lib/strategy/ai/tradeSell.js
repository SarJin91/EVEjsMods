"use strict";

const TRADE_STATES = require("../data/tradeStates");
const { mulDivFloor } = require("../data/tradeTiers");
const { pairTaken } = require("../data/tradePairs");

const PERMILLE = 1000;
const GROUP_PREFIX = "group:";
const HULL_GROUP_PREFIX = "hull/group:";
const MINERAL_PREFIX = "mineral/";
const TYPE_PREFIX = "type:";
const ITEM_KIND_MINERAL = "mineral";
const ITEM_KIND_HULL = "hull";
const PRICE_SOURCE_ASK = "ask";
const OPEN_OFFER_STATES = TRADE_STATES.OPEN_OFFER_STATES;
const SIDE_SELL = TRADE_STATES.SIDE_SELL;
const WTS_OFFER_NOTE = "TRADE_WTS_OFFER:";

const posInt = (v) => (Number.isSafeInteger(v) && v > 0 ? v : 0);
const byId = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function ceilDiv(a, b) {
  return Math.floor(a / b) + (a % b === 0 ? 0 : 1);
}

function factionCapOf(trade, T) {
  const galaxy = trade.galaxy && Number.isSafeInteger(trade.galaxy.open) && Number.isSafeInteger(trade.galaxy.factions)
    ? trade.galaxy : null;
  const targetOn = T.targetOpenContracts > 0 && galaxy !== null;
  const reserve = Number.isSafeInteger(T.warReservedOffersPerFaction) ? T.warReservedOffersPerFaction : 0;
  const factionCap = Math.min(targetOn
    ? Math.min(T.maxOpenOffersPerFaction, Math.ceil(T.targetOpenContracts / Math.max(1, galaxy.factions)))
    : T.maxOpenOffersPerFaction, Math.max(0, T.maxOpenOffersPerFaction - reserve));
  return { factionCap, targetOn, galaxy };
}

function mineralOf(key) {
  if (typeof key !== "string") return null;
  const k = key.startsWith(MINERAL_PREFIX) ? key.slice(MINERAL_PREFIX.length) : key;
  if (!k.startsWith(TYPE_PREFIX)) return null;
  const t = Number(k.slice(TYPE_PREFIX.length));
  return Number.isSafeInteger(t) && TRADE_STATES.MINERAL_TYPE_IDS.includes(t) ? t : null;
}

function groupOfItem(item) {
  if (!item || item.itemKind !== ITEM_KIND_HULL || typeof item.itemKey !== "string") return null;
  if (item.itemKey.startsWith(HULL_GROUP_PREFIX)) return item.itemKey.slice(HULL_GROUP_PREFIX.length);
  if (item.itemKey.startsWith(GROUP_PREFIX)) return item.itemKey.slice(GROUP_PREFIX.length);
  return null;
}

function wtsParamsOk(T) {
  return posInt(T.wtsOffersPerReview) > 0 && Number.isSafeInteger(T.wtsMaxOpenPerFaction)
    && Number.isSafeInteger(T.wtsStationSlotHeadroom) && T.wtsStationSlotHeadroom >= 0
    && posInt(T.wtsMaxIskPerOffer) > 0 && posInt(T.wtsTtlMs) > 0;
}

function sellCandidates(args) {
  const { trade, T, desired, recipes } = args;
  const candidates = [];
  const notes = [];
  const stationsData = Array.isArray(args.stationsData) ? args.stationsData : [];
  const chosen = new Set((Array.isArray(args.validChosen) ? args.validChosen : []).map((s) => s.stationId));
  const warMinerals = args.warMinerals instanceof Set ? args.warMinerals : new Set();
  const warHullGroups = args.warHullGroups instanceof Set ? args.warHullGroups : new Set();
  const npc = trade.stations.filter((s) => s.kind === "npc" && !chosen.has(s.stationId))
    .sort((a, b) => byId(a.stationId, b.stationId));
  if (npc.length === 0) return { candidates, notes };
  const dataOf = (stationId) => stationsData.find((st) => st.stationId === stationId) || null;

  const outMinerals = new Map();
  const outHulls = new Map();
  const outHullsTotal = new Map();
  const addOut = (map, s, k, n) => {
    if (!(n > 0)) return;
    const m = map.get(s) || new Map();
    m.set(k, (m.get(k) || 0) + n);
    map.set(s, m);
  };
  for (const intent of args.production && Array.isArray(args.production.intents) ? args.production.intents : []) {
    if (intent.type !== "PRODUCE") continue;
    const recipe = recipes[intent.hullGroup];
    for (const [k, qty] of Object.entries(recipe && recipe.minerals ? recipe.minerals : {})) {
      const t = mineralOf(k);
      if (t !== null) addOut(outMinerals, intent.stationId, t, qty * intent.runs);
    }
  }
  for (const x of args.production && Array.isArray(args.production.reserve) ? args.production.reserve : []) {
    if (!x || x.ladder !== true) continue;
    for (const [k, qty] of Object.entries(x.minerals || {})) {
      const t = mineralOf(k);
      if (t !== null) addOut(outMinerals, x.stationId, t, qty);
    }
  }
  for (const intent of args.logistics && Array.isArray(args.logistics.intents) ? args.logistics.intents : []) {
    if (intent.type !== "CONVOY_DISPATCH") continue;
    for (const item of intent.items || []) {
      const g = groupOfItem(item);
      if (g !== null) {
        addOut(outHulls, intent.sourceStationId, g, item.quantity);
        outHullsTotal.set(g, (outHullsTotal.get(g) || 0) + (item.quantity > 0 ? item.quantity : 0));
        continue;
      }
      const t = item && item.itemKind === ITEM_KIND_MINERAL ? mineralOf(item.itemKey) : null;
      if (t !== null) addOut(outMinerals, intent.sourceStationId, t, item.quantity);
    }
  }

  const runs = posInt(T.wtsMineralSurplusRuns);
  const groups = Object.keys(desired).filter((g) => recipes[g] && recipes[g].minerals);
  if (runs > 0 && groups.length > 0) {
    for (const stationInfo of npc) {
      const data = dataOf(stationInfo.stationId);
      if (!data) continue;
      const out = outMinerals.get(stationInfo.stationId) || new Map();
      for (const t of TRADE_STATES.MINERAL_TYPE_IDS) {
        const itemKey = `${TYPE_PREFIX}${t}`;
        if (warMinerals.has(itemKey)) continue;
        let perRun = 0;
        for (const g of groups) {
          const v = recipes[g].minerals[itemKey];
          if (Number.isSafeInteger(v) && v > perRun) perRun = v;
        }
        const stock = (data.minerals || {})[itemKey] || 0;
        const surplus = stock - (out.get(t) || 0) - perRun * runs;
        if (surplus > 0 && Number.isSafeInteger(surplus)) {
          candidates.push({ stationId: stationInfo.stationId, stationInfo, itemKind: ITEM_KIND_MINERAL, itemKey,
            typeId: t, surplus });
        }
      }
    }
  }

  const permille = posInt(T.wtsHullSurplusPermille);
  const hulls = trade.hulls && typeof trade.hulls === "object" ? trade.hulls : null;
  if (permille > 0 && hulls !== null && posInt(T.hullMaxPerOffer) > 0) {
    for (const g of Object.keys(hulls).sort()) {
      const h = hulls[g];
      if (!h || !posInt(h.typeId) || warHullGroups.has(g)) continue;
      let total = 0;
      for (const st of stationsData) total += posInt((st.hulls || {})[g]);
      const keepTotal = ceilDiv(posInt(desired[g]) * permille, PERMILLE);
      const factionSurplus = total - keepTotal - (outHullsTotal.get(g) || 0);
      if (factionSurplus <= 0) continue;
      let best = null;
      let bestHave = 0;
      for (const stationInfo of npc) {
        const data = dataOf(stationInfo.stationId);
        const have = data ? posInt((data.hulls || {})[g]) - ((outHulls.get(stationInfo.stationId) || new Map()).get(g) || 0) : 0;
        if (have > bestHave) {
          best = stationInfo;
          bestHave = have;
        }
      }
      if (best === null) continue;
      const surplus = Math.min(bestHave, factionSurplus, T.hullMaxPerOffer);
      if (surplus > 0) {
        candidates.push({ stationId: best.stationId, stationInfo: best, itemKind: ITEM_KIND_HULL,
          itemKey: `${GROUP_PREFIX}${g}`, typeId: h.typeId, surplus });
      }
    }
  }
  return { candidates, notes };
}

function planSellOffers(args) {
  const { trade, T, at, candidates, newOffers, state, intents, notes } = args;
  if (!wtsParamsOk(T) || !Array.isArray(candidates) || candidates.length === 0) return;
  const sellQuotes = (args.quotes !== undefined ? args.quotes : trade.sellQuotes) || {};
  const maxNew = args.maxNew !== undefined ? args.maxNew : T.wtsOffersPerReview;
  const buyUnitMax = trade.buyUnitMax || {};
  const volCap = typeof args.volCap === "function" ? args.volCap : () => T.maxQuantityPerOffer;

  const buyMax = new Map();
  for (const o of newOffers) {
    if (o.side !== SIDE_SELL && Number.isSafeInteger(o.unitPriceMilli) && !(buyMax.get(o.typeId) >= o.unitPriceMilli)) {
      buyMax.set(o.typeId, o.unitPriceMilli);
    }
  }
  const discounts = trade.devWtsDiscounts instanceof Map ? trade.devWtsDiscounts : null;
  const baseOf = (c, q) => {
    const d = discounts && c.stationInfo ? posInt(discounts.get(c.stationInfo.systemId)) : 0;
    return d > 0 ? q.unitMilli - Math.floor((q.unitMilli * Math.min(PERMILLE, d)) / PERMILLE) : q.unitMilli;
  };
  const unitOf = (c, q) => Math.max(baseOf(c, q), Math.max(posInt(buyUnitMax[c.typeId]), buyMax.get(c.typeId) || 0) + 1);

  const priced = [];
  const noPrice = new Set();
  for (const c of [...candidates].sort((a, b) => byId(a.stationId, b.stationId) || byId(a.itemKey, b.itemKey))) {
    const q = Object.prototype.hasOwnProperty.call(sellQuotes, c.itemKey) ? sellQuotes[c.itemKey] : null;
    if (!q || q.ok !== true || !posInt(q.unitMilli)) {
      if (!noPrice.has(c.itemKey)) {
        noPrice.add(c.itemKey);
        notes.push(`TRADE_WTS_NO_PRICE:${c.itemKey}`);
      }
      continue;
    }
    const unit = unitOf(c, q);
    priced.push({ c, q, unit, value: c.surplus * unit });
  }
  priced.sort((a, b) => b.value - a.value || byId(a.c.stationId, b.c.stationId) || byId(a.c.itemKey, b.c.itemKey));

  const { factionCap, targetOn, galaxy } = factionCapOf(trade, T);
  let galaxyLeft = targetOn ? T.targetOpenContracts - galaxy.open - state.offersCreated : Infinity;
  let openSell = trade.open.filter((o) => o.side === SIDE_SELL && OPEN_OFFER_STATES.includes(o.state)).length
    + newOffers.filter((o) => o.side === SIDE_SELL).length;
  let wts = 0;
  for (const { c, q, unit } of priced) {
    if (state.offersCreated >= T.maxOffersPerReview || wts >= maxNew
      || openSell >= T.wtsMaxOpenPerFaction || state.openFactionCount >= factionCap || galaxyLeft <= 0) {
      notes.push("TRADE_WTS_LIMIT");
      break;
    }
    const { stationId, stationInfo, itemKey, typeId } = c;
    if (pairTaken(trade.open, newOffers, stationId, itemKey)) continue;
    const stationOpen = state.openPerStation.get(stationId) || 0;
    if (stationOpen + 1 + T.wtsStationSlotHeadroom > T.maxOpenOffersPerStation) {
      notes.push(`TRADE_STATION_LIMIT:${stationId}`);
      continue;
    }
    let quantity = Math.min(c.surplus, T.maxQuantityPerOffer, volCap(itemKey),
      mulDivFloor(T.wtsMaxIskPerOffer, PERMILLE, unit));
    if (c.itemKind === ITEM_KIND_HULL) quantity = Math.min(quantity, T.hullMaxPerOffer);
    const iskTotal = quantity >= 1 ? ceilDiv(quantity * unit, PERMILLE) : 0;
    if (quantity < 1 || !Number.isSafeInteger(iskTotal) || iskTotal < T.minIskPerOffer) {
      notes.push(`TRADE_OFFER_SMALL:${itemKey}`);
      continue;
    }
    const offer = {
      type: "TRADE_OFFER",
      side: SIDE_SELL,
      slot: state.offersCreated,
      stationId,
      systemId: stationInfo.systemId,
      issuerCorporationId: stationInfo.ownerCorporationId,
      itemKind: c.itemKind,
      itemKey,
      typeId,
      quantity,
      unitPriceMilli: unit,
      iskTotal,
      refPriceMilli: q.refMilli,
      capPriceMilli: null,
      priceSource: PRICE_SOURCE_ASK,
      expiresAt: at + T.wtsTtlMs,
    };
    state.openFactionCount += 1;
    state.openPerStation.set(stationId, stationOpen + 1);
    state.offersCreated += 1;
    galaxyLeft -= 1;
    openSell += 1;
    wts += 1;
    intents.push(offer);
    newOffers.push(offer);
    notes.push(`TRADE_WTS_OFFER:${itemKey}@${stationId}`);
  }
}

function deferSells(trade, mobilizes) {
  const all = Array.isArray(trade.intents) ? trade.intents : [];
  const isSell = (i) => i.type === "TRADE_OFFER" && i.side === SIDE_SELL;
  if (!all.some(isSell)) return { intents: all, sells: [], notes: trade.notes };
  const sources = new Set();
  for (const m of Array.isArray(mobilizes) ? mobilizes : []) {
    if (m && m.stationId !== null && m.stationId !== undefined && Array.isArray(m.hulls)
      && m.hulls.some((h) => h && h.count > 0)) sources.add(m.stationId);
  }
  const sells = [];
  const dropped = new Set();
  for (const i of all) {
    if (!isSell(i)) continue;
    if (i.itemKind === ITEM_KIND_HULL && sources.has(i.stationId)) dropped.add(`${i.itemKey}@${i.stationId}`);
    else sells.push(i);
  }
  const notes = dropped.size === 0 ? trade.notes : [
    ...trade.notes.filter((n) => !(n.startsWith(WTS_OFFER_NOTE) && dropped.has(n.slice(WTS_OFFER_NOTE.length)))),
    ...[...dropped].map((k) => `TRADE_WTS_WAR_SOURCE:${k}`)];
  return { intents: all.filter((i) => !isSell(i)), sells, notes };
}

module.exports = { sellCandidates, planSellOffers, factionCapOf, wtsParamsOk, ceilDiv, deferSells, PRICE_SOURCE_ASK };
