"use strict";

const { hullTargets, rankMobilizationStations, focusOf } = require("./production");
const { bfs } = require("./bfs");
const TRADE_STATES = require("../data/tradeStates");
const { tierOf, tierCapOf, tierTtlOf, tierQuotas, tierCfgOf, mulDivFloor, VOLUME_UNITS_PER_M3 } = require("../data/tradeTiers");
const { expectedYield, portionsFor, primaryOf } = require("../data/oreYield");
const { pairTaken } = require("../data/tradePairs");
const { convoyItemsOf } = require("../data/convoyItems");
const { warQuoteAt } = require("../data/warPricePressure");
const { hullCandidates, planHullOffers } = require("./tradeHulls");
const { sellCandidates, planSellOffers, factionCapOf } = require("./tradeSell");
const { planCommodityBuys, planCommoditySells } = require("./tradeCommodities");

const ACTIVE = "ACTIVE";
const PERMILLE = 1000;
const MINERAL_PREFIX = "mineral/";
const HULL_PREFIX = "hull/group:";
const PURPOSE_MOBILIZATION = "mobilization";
const PURPOSE_STOCKPILE = "stockpile";
const ITEM_KIND_ORE = "ore";

const OPEN_OFFER_STATES = TRADE_STATES.OPEN_OFFER_STATES;

function byId(a, b) { return (a < b ? -1 : a > b ? 1 : 0); }

function lotIskOf(T) {
  return Number.isSafeInteger(T.publicLotMaxIsk) && T.publicLotMaxIsk > 0 ? T.publicLotMaxIsk : Infinity;
}

function isStockpileOffer(o) {
  return typeof o.offerId === "string" && o.offerId.startsWith(`${TRADE_STATES.OFFER_ID_PREFIX_STOCKPILE}_`)
    && !(o.assigneeCharacterId > 0);
}

function planOversizeRecalls(trade, T, at, cancelsLeft, cancelledIds) {
  const intents = [];
  const notes = [];
  const recalledIds = new Set();
  const lot = lotIskOf(T);
  if (lot === Infinity || T.stockpileRecallEnabled !== true || !(cancelsLeft > 0)) {
    return { intents, notes, recalledIds };
  }
  const skip = cancelledIds instanceof Set ? cancelledIds : new Set();
  const oversize = (trade.open || []).filter((o) => isStockpileOffer(o) && o.side !== TRADE_STATES.SIDE_SELL
    && (o.state === TRADE_STATES.PLANNED || o.state === TRADE_STATES.OPEN)
    && o.expiresAt > at && !skip.has(o.offerId) && Number.isSafeInteger(o.iskTotal) && o.iskTotal > lot)
    .sort((a, b) => a.expiresAt - b.expiresAt || byId(a.offerId, b.offerId));
  for (const o of oversize.slice(0, cancelsLeft)) {
    intents.push({ type: "TRADE_CANCEL", offerId: o.offerId, expectedVersion: o.version,
      reason: TRADE_STATES.END_REASON_RECALLED, from: o.state });
    notes.push(`TRADE_STOCKPILE_RECALL_OVERSIZE:${o.itemKey}@${o.stationId}`);
    recalledIds.add(o.offerId);
  }
  return { intents, notes, recalledIds };
}

const PURPOSE_REPRICE = "reprice";
const GAP_SCALE = 1000000;

function planWarReprices(trade, T, at, cancelsLeft, cancelledIds) {
  const intents = [];
  const notes = [];
  const recalledIds = new Set();
  if (T.warPricingEnabled !== true || T.warRepriceEnabled !== true || !trade.warQuotes || !(cancelsLeft > 0)
      || !(T.warRepricePerReview > 0)) {
    return { intents, notes, recalledIds };
  }
  const skip = cancelledIds instanceof Set ? cancelledIds : new Set();
  const gap = Number.isSafeInteger(T.warRepriceGapPermille) ? T.warRepriceGapPermille : PERMILLE;
  const prefix = `${TRADE_STATES.OFFER_ID_PREFIX}_`;
  const rows = [];
  for (const o of trade.open || []) {
    if (typeof o.offerId !== "string" || !o.offerId.startsWith(prefix) || o.assigneeCharacterId > 0
      || o.side === TRADE_STATES.SIDE_SELL) continue;
    if (o.state !== TRADE_STATES.PLANNED && o.state !== TRADE_STATES.OPEN) continue;
    if (!(o.expiresAt > at) || skip.has(o.offerId)) continue;
    if (!Number.isSafeInteger(o.unitPriceMilli) || o.unitPriceMilli <= 0) continue;
    const w = warQuoteAt(trade, o.stationId, o.itemKey);
    if (!w || w.ok !== true || !Number.isSafeInteger(w.warPermille) || !(w.warPermille > 0)
      || !Number.isSafeInteger(w.unitMilli) || w.unitMilli <= 0) continue;
    if (!(o.unitPriceMilli < mulDivFloor(w.unitMilli, PERMILLE - gap, PERMILLE))) continue;
    rows.push({ o, rel: mulDivFloor(w.unitMilli - o.unitPriceMilli, GAP_SCALE, w.unitMilli) });
  }
  rows.sort((a, b) => b.rel - a.rel || byId(a.o.offerId, b.o.offerId));
  for (const { o } of rows.slice(0, Math.min(T.warRepricePerReview, cancelsLeft))) {
    intents.push({ type: "TRADE_CANCEL", offerId: o.offerId, expectedVersion: o.version,
      reason: TRADE_STATES.END_REASON_RECALLED, from: o.state, purpose: PURPOSE_REPRICE });
    notes.push(`TRADE_WAR_REPRICE:${o.itemKey}@${o.stationId}`);
    recalledIds.add(o.offerId);
  }
  return { intents, notes, recalledIds };
}

function planRecalls(trade, T, at, candidates, cancelsLeft, opts) {
  const intents = [];
  const notes = [];
  const hullCands = opts && Array.isArray(opts.hullCandidates) ? opts.hullCandidates : [];
  if (T.stockpileRecallEnabled !== true || !(cancelsLeft > 0) || candidates.length + hullCands.length === 0) {
    return { intents, notes };
  }
  const permille = Number.isSafeInteger(T.stockpileRecallMinNeedPermille) ? T.stockpileRecallMinNeedPermille : PERMILLE;
  const cancelled = opts && opts.cancelledIds instanceof Set ? opts.cancelledIds : new Set();
  const slots = Boolean(opts);
  const recalled = new Set();
  let left = cancelsLeft;
  const worth = (cand, x) => {
    if (x.side === TRADE_STATES.SIDE_SELL) return true;
    const q = trade.quotes[cand.itemKey];
    if (!q || !q.ok) return false;
    const needIsk = mulDivFloor(cand.need, q.unitMilli, PERMILLE);
    const iskTotal = Number.isSafeInteger(x.iskTotal) && x.iskTotal > 0 ? x.iskTotal : 0;
    return needIsk >= Math.max(T.minIskPerOffer, mulDivFloor(iskTotal, permille, PERMILLE));
  };
  const isSell = (x) => x.side === TRADE_STATES.SIDE_SELL;
  const recallable = (x) => (isStockpileOffer(x) || isSell(x))
    && (x.state === TRADE_STATES.PLANNED || x.state === TRADE_STATES.OPEN)
    && x.expiresAt > at && !recalled.has(x.offerId) && !cancelled.has(x.offerId);
  const recall = (x, note) => {
    const intent = { type: "TRADE_CANCEL", offerId: x.offerId, expectedVersion: x.version,
      reason: TRADE_STATES.END_REASON_RECALLED, from: x.state };
    if (isSell(x)) intent.side = TRADE_STATES.SIDE_SELL;
    intents.push(intent);
    notes.push(isSell(x) ? `TRADE_WTS_RECALL:${x.itemKey}@${x.stationId}` : note);
    recalled.add(x.offerId);
    left -= 1;
  };
  const openAt = new Map();
  const step1At = new Map();
  for (const o of trade.open) {
    openAt.set(o.stationId, (openAt.get(o.stationId) || 0) + 1);
    if (cancelled.has(o.offerId)) step1At.set(o.stationId, (step1At.get(o.stationId) || 0) + 1);
  }
  const recalledAt = new Map();
  const usedAt = new Map();
  const maxFree = Number.isSafeInteger(T.maxOffersPerReview) ? T.maxOffersPerReview : 0;
  const maxHull = Math.min(maxFree, Number.isSafeInteger(T.hullOffersPerReview) ? T.hullOffersPerReview : 0);
  let freeSeen = 0;
  let hullSeen = 0;
  const pairsSeen = new Set();
  for (const cand of [...candidates, ...hullCands]) {
    if (left <= 0) break;
    const s = cand.stationId;
    const x = trade.open.find((o) => o.stationId === s && o.itemKey === cand.itemKey
      && OPEN_OFFER_STATES.includes(o.state) && !cancelled.has(o.offerId));
    if (x) {
      if ((cand.kind !== "hull" || isSell(x)) && recallable(x) && worth(cand, x)) {
        recall(x, `TRADE_STOCKPILE_RECALL:${cand.itemKey}@${s}`);
      }
      continue;
    }
    if (!slots) continue;
    const isHull = cand.kind === "hull";
    const pairKey = `${s}|${cand.itemKey}`;
    if (pairsSeen.has(pairKey) || freeSeen >= maxFree || (isHull && hullSeen >= maxHull)) continue;
    pairsSeen.add(pairKey);
    freeSeen += 1;
    if (isHull) hullSeen += 1;
    usedAt.set(s, (usedAt.get(s) || 0) + 1);
    const free = T.maxOpenOffersPerStation - (openAt.get(s) || 0) + (step1At.get(s) || 0) + (recalledAt.get(s) || 0);
    if (usedAt.get(s) <= free) continue;
    const pick = trade.open.filter((o) => o.stationId === s && recallable(o))
      .sort((a, b) => a.expiresAt - b.expiresAt || byId(a.offerId, b.offerId))[0];
    if (!pick || !worth(cand, pick)) continue;
    recall(pick, `TRADE_STOCKPILE_RECALL_SLOT:${pick.itemKey}@${s}`);
    recalledAt.set(s, (recalledAt.get(s) || 0) + 1);
  }
  return { intents, notes };
}

function planPrivateOffers(trade, T, at, candidates, newPrivateOffers) {
  const intents = [];
  const notes = [];

  if (!trade.suppliers || trade.suppliers.length === 0) return { intents, notes, openPrivateCount: 0, budgetUsed: 0 };
  if (!trade.privateQuotes || Object.keys(trade.privateQuotes).length === 0) return { intents, notes, openPrivateCount: 0, budgetUsed: 0 };
  if (!T.maxPrivateOffersPerReview || !T.maxOpenPrivateOffersPerFaction || !T.maxOpenPrivateOffersPerCharacter) return { intents, notes, openPrivateCount: 0, budgetUsed: 0 };
  if (!T.privateOfferTtlMs) return { intents, notes, openPrivateCount: 0, budgetUsed: 0 };

  let openPrivateF = 0;
  const openPrivatePerCharacter = new Map();
  for (const offer of trade.open) {
    if (offer.assigneeCharacterId) {
      openPrivateF++;
      const c = offer.assigneeCharacterId;
      openPrivatePerCharacter.set(c, (openPrivatePerCharacter.get(c) || 0) + 1);
    }
  }

  for (const offer of newPrivateOffers) {
    if (offer.assigneeCharacterId) {
      openPrivateF++;
      const c = offer.assigneeCharacterId;
      openPrivatePerCharacter.set(c, (openPrivatePerCharacter.get(c) || 0) + 1);
    }
  }

  const privLeftFaction = Math.max(0, T.maxOpenPrivateOffersPerFaction - openPrivateF);
  let privLeft = Math.min(T.maxPrivateOffersPerReview, privLeftFaction);
  if (privLeft <= 0) {
    return { intents, notes, openPrivateCount: openPrivateF, budgetUsed: 0 };
  }

  let budgetLeft = trade.budget ? trade.budget.availableIsk : 0;
  let budgetUsed = 0;

  const openPerStation = new Map();
  for (const offer of trade.open) {
    openPerStation.set(offer.stationId, (openPerStation.get(offer.stationId) || 0) + 1);
  }
  for (const offer of newPrivateOffers) {
    openPerStation.set(offer.stationId, (openPerStation.get(offer.stationId) || 0) + 1);
  }

  let offersCreated = 0;
  const newPrivatePerCharacter = new Map();
  const volCap = volCapOf(trade, T);

  for (const supplier of trade.suppliers) {
    if (privLeft <= 0) break;
    if (offersCreated >= T.maxOffersPerReview) break;

    const { characterId, bonusPermille, rejectedAt } = supplier;

    if (T.privateRejectCooldownMs > 0 && rejectedAt !== undefined && at - rejectedAt < T.privateRejectCooldownMs) {
      notes.push(`TRADE_PRIVATE_COOLDOWN:${characterId}`);
      continue;
    }

    const existingForChar = openPrivatePerCharacter.get(characterId) || 0;
    const newForChar = newPrivatePerCharacter.get(characterId) || 0;
    if (existingForChar + newForChar >= T.maxOpenPrivateOffersPerCharacter) {
      continue;
    }

    let supplierMatched = false;
    for (const cand of candidates) {
      const { stationId, typeId, need, itemKey, station } = cand;

      if (pairTaken(trade.open, newPrivateOffers, stationId, itemKey)) {
        continue;
      }

      if (openPrivateF >= T.maxOpenOffersPerFaction) {
        break;
      }

      const stationOpen = openPerStation.get(stationId) || 0;
      if (stationOpen >= T.maxOpenOffersPerStation) {
        continue;
      }

      const pq = trade.privateQuotes[bonusPermille]?.[itemKey];
      const q = trade.quotes[itemKey];
      if (!pq || !pq.ok) continue;
      if (!q || !q.ok) continue;
      if (pq.unitMilli <= q.unitMilli) {
        notes.push(`TRADE_PRIVATE_NO_GAIN:${typeId}`);
        continue;
      }

      const unitMilli = pq.unitMilli;
      const iskLimit = Math.min(T.maxIskPerOffer, budgetLeft);
      if (iskLimit < T.minIskPerOffer) {
        notes.push(`TRADE_BUDGET_SHORT:${itemKey}`);
        continue;
      }

      const maxQty = Math.min(need, T.maxQuantityPerOffer, volCap(itemKey), Math.floor((iskLimit * PERMILLE) / unitMilli));
      if (maxQty < 1) {
        notes.push(`TRADE_OFFER_SMALL:${itemKey}`);
        continue;
      }

      const iskTotal = Math.floor((maxQty * unitMilli) / PERMILLE);
      if (iskTotal < T.minIskPerOffer) {
        notes.push(`TRADE_OFFER_SMALL:${itemKey}`);
        continue;
      }

      const stationInfo = trade.stations.find((s) => s.stationId === stationId);
      if (!stationInfo || stationInfo.kind !== "npc") {
        notes.push(`TRADE_NO_NPC_STATION:${stationId}`);
        continue;
      }

      budgetLeft -= iskTotal;
      budgetUsed += iskTotal;
      openPrivateF++;
      openPerStation.set(stationId, stationOpen + 1);
      offersCreated++;
      privLeft--;

      newPrivatePerCharacter.set(characterId, newForChar + 1);

      const privateOffer = {
        type: "TRADE_OFFER",
        stationId,
        systemId: station.systemId,
        issuerCorporationId: stationInfo.ownerCorporationId,
        itemKind: "mineral",
        itemKey,
        typeId,
        quantity: maxQty,
        unitPriceMilli: unitMilli,
        iskTotal,
        refPriceMilli: pq.refMilli,
        capPriceMilli: pq.capMilli,
        priceSource: pq.source,
        expiresAt: at + T.privateOfferTtlMs,
        assigneeCharacterId: characterId,
        standingBonusPermille: bonusPermille,
      };

      intents.push(privateOffer);
      newPrivateOffers.push(privateOffer);

      notes.push(`TRADE_PRIVATE_OFFER:${itemKey}@${stationId}:${characterId}`);

      supplierMatched = true;
      break;
    }
  }

  return { intents, notes, openPrivateCount: openPrivateF, budgetUsed };
}

function planTrade(snapshot, params, production, logistics) {
  const intents = [];
  const notes = [];

  if (!snapshot.trade || !params.trade || !params.production) {
    return { intents, notes };
  }
  const trade = snapshot.trade;
  if (trade.mode !== "ready") {
    notes.push("TRADE_OFF");
    return { intents, notes };
  }
  if (snapshot.faction.status !== ACTIVE || snapshot.stationsMode !== "ready") {
    notes.push("TRADE_INACTIVE");
    return { intents, notes };
  }
  if (trade.openTruncated || (snapshot.production && snapshot.production.truncated)) {
    notes.push("TRADE_TRUNCATED");
  }

  const T = params.trade;
  const P = params.production;
  const at = snapshot.at;
  const now = at;

  const cancellations = [];
  for (const offer of trade.open) {
    if (cancellations.length >= T.maxCancelsPerReview) break;
    if (offer.state !== TRADE_STATES.PLANNED) continue;

    let reason = null;
    if (offer.expiresAt <= now) {
      reason = TRADE_STATES.END_REASON_EXPIRED;
    } else {
      const station = trade.stations.find((s) => s.stationId === offer.stationId);
      if (!station || station.ownerCorporationId !== offer.issuerCorporationId) {
        reason = TRADE_STATES.END_REASON_STATION_GONE;
      }
    }
    if (reason) {
      cancellations.push({ offerId: offer.offerId, expectedVersion: offer.version, reason });
    }
  }

  cancellations.sort((a, b) => {
    const oa = trade.open.find((o) => o.offerId === a.offerId);
    const ob = trade.open.find((o) => o.offerId === b.offerId);
    const ea = oa ? oa.expiresAt : 0;
    const eb = ob ? ob.expiresAt : 0;
    return ea - eb || byId(a.offerId, b.offerId);
  });

  for (const c of cancellations.slice(0, T.maxCancelsPerReview)) {
    intents.push({
      type: "TRADE_CANCEL",
      offerId: c.offerId,
      expectedVersion: c.expectedVersion,
      reason: c.reason,
    });
  }

  const cancelsUsed = Math.min(cancellations.length, T.maxCancelsPerReview);
  const cancelledIds = new Set(cancellations.slice(0, T.maxCancelsPerReview).map((c) => c.offerId));
  const oversize = planOversizeRecalls(trade, T, at, Math.max(0, T.maxCancelsPerReview - cancelsUsed), cancelledIds);
  intents.push(...oversize.intents);
  notes.push(...oversize.notes);
  for (const id of oversize.recalledIds) cancelledIds.add(id);

  const reprices = planWarReprices(trade, T, at,
    Math.max(0, T.maxCancelsPerReview - cancelsUsed - oversize.intents.length), cancelledIds);
  intents.push(...reprices.intents);
  notes.push(...reprices.notes);
  for (const id of reprices.recalledIds) cancelledIds.add(id);

  if (trade.mode !== "ready" || snapshot.faction.status !== ACTIVE || snapshot.stationsMode !== "ready") {
    return { intents, notes };
  }

  const desired = hullTargets(snapshot.doctrine, P);
  if (Object.keys(desired).length === 0) {
    return { intents, notes };
  }

  const recipes = snapshot.production?.recipes || {};
  const supply = snapshot.supply;
  const focus = focusOf(snapshot, supply);
  const dist = focus.length > 0 && typeof snapshot.neighbors === "function"
    ? bfs(focus, snapshot.neighbors, { maxJumps: params.maxAssemblyJumps, maxSystems: params.maxBfsSystems })
    : new Map();

  const ranked = rankMobilizationStations(snapshot.production?.stations || [], desired, recipes, dist);
  const validChosen = [];
  let chosenStationIds = new Set();
  if (ranked.length === 0) {
    notes.push("TRADE_NO_MOBILIZATION_STATION");
  } else {
    const chosenCount = Math.max(1, P.mobilizationStations || 1);
    const chosen = ranked.slice(0, chosenCount);
    chosenStationIds = new Set(chosen.map((s) => s.stationId));

    const hasNpc = trade.stations.some((ts) => ts.kind === "npc");
    for (const s of chosen) {
      const stationInfo = trade.stations.find((ts) => ts.stationId === s.stationId);
      if (!stationInfo || stationInfo.kind !== "npc") {
        notes.push(`${hasNpc ? "TRADE_MOBILIZATION_UPWELL" : "TRADE_NO_NPC_STATION"}:${s.stationId}`);
        continue;
      }
      validChosen.push(s);
    }
  }

  const incomingHulls = new Map();
  const incomingMinerals = new Map();

  if (logistics && logistics.intents) {
    for (const intent of logistics.intents) {
      if (intent.type !== "CONVOY_DISPATCH") continue;
      const destStationId = intent.destStationId;
      for (const item of intent.items || []) {
        if (item.itemKind === "hull" && item.itemKey.startsWith("group:")) {
          const g = item.itemKey.slice("group:".length);
          const map = incomingHulls.get(destStationId) || new Map();
          map.set(g, (map.get(g) || 0) + item.quantity);
          incomingHulls.set(destStationId, map);
        } else if (item.itemKind === "mineral") {
          const key = item.itemKey.startsWith("mineral/") ? item.itemKey.slice("mineral/".length) : item.itemKey;
          if (key.startsWith("type:")) {
            const typeId = parseInt(key.slice("type:".length), 10);
            if (Number.isSafeInteger(typeId) && TRADE_STATES.MINERAL_TYPE_IDS.includes(typeId)) {
              const map = incomingMinerals.get(destStationId) || new Map();
              map.set(typeId, (map.get(typeId) || 0) + item.quantity);
              incomingMinerals.set(destStationId, map);
            }
          }
        }
      }
    }
  }

  if (production && production.intents) {
    for (const intent of production.intents) {
      if (intent.type !== "PRODUCE") continue;
      const stationId = intent.stationId;
      const g = intent.hullGroup;
      const map = incomingHulls.get(stationId) || new Map();
      map.set(g, (map.get(g) || 0) + intent.runs);
      incomingHulls.set(stationId, map);
      const recipe = recipes[g];
      if (recipe && recipe.minerals) {
        for (const [mineralKey, qty] of Object.entries(recipe.minerals)) {
          if (mineralKey.startsWith("type:")) {
            const t = parseInt(mineralKey.slice("type:".length), 10);
            if (Number.isSafeInteger(t) && TRADE_STATES.MINERAL_TYPE_IDS.includes(t)) {
              const mineralMap = incomingMinerals.get(stationId) || new Map();
              mineralMap.set(t, (mineralMap.get(t) || 0) - qty * intent.runs);
              incomingMinerals.set(stationId, mineralMap);
            }
          }
        }
      }
    }
  }

  for (const offer of trade.open) {
    if (!OPEN_OFFER_STATES.includes(offer.state) || offer.side === TRADE_STATES.SIDE_SELL) continue;
    const typeId = offer.typeId;
    if (Number.isSafeInteger(typeId) && TRADE_STATES.MINERAL_TYPE_IDS.includes(typeId)) {
      const map = incomingMinerals.get(offer.stationId) || new Map();
      map.set(typeId, (map.get(typeId) || 0) + offer.quantity);
      incomingMinerals.set(offer.stationId, map);
    }
  }
  addOreIncoming(trade, incomingMinerals);

  if (snapshot.logistics && Array.isArray(snapshot.logistics.open)) {
    for (const convoy of snapshot.logistics.open) {
      for (const item of convoyItemsOf(convoy)) {
        if (item.itemKind === "mineral") {
          const key = item.itemKey.startsWith("mineral/") ? item.itemKey.slice("mineral/".length) : item.itemKey;
          if (key.startsWith("type:")) {
            const typeId = parseInt(key.slice("type:".length), 10);
            if (Number.isSafeInteger(typeId) && TRADE_STATES.MINERAL_TYPE_IDS.includes(typeId)) {
              const map = incomingMinerals.get(convoy.destStationId) || new Map();
              map.set(typeId, (map.get(typeId) || 0) + item.quantity);
              incomingMinerals.set(convoy.destStationId, map);
            }
          }
        }
      }
    }
  }

  const otherStationsMinerals = new Map();
  if (snapshot.logistics && snapshot.logistics.mode === "ready") {
    for (const station of snapshot.production?.stations || []) {
      if (chosenStationIds.has(station.stationId)) continue;
      for (const [key, qty] of Object.entries(station.minerals || {})) {
        if (key.startsWith("type:")) {
          const typeId = parseInt(key.slice("type:".length), 10);
          if (Number.isSafeInteger(typeId) && TRADE_STATES.MINERAL_TYPE_IDS.includes(typeId)) {
            otherStationsMinerals.set(typeId, (otherStationsMinerals.get(typeId) || 0) + qty);
          }
        }
      }
    }
  }

  const candidates = [];

  for (let rank = 0; rank < validChosen.length; rank++) {
    const s = validChosen[rank];
    const stationId = s.stationId;
    const stationData = snapshot.production?.stations?.find((st) => st.stationId === stationId);
    if (!stationData) continue;

    const stationStock = { ...stationData.minerals };
    const incMin = incomingMinerals.get(stationId) || new Map();
    for (const [typeId, qty] of incMin) stationStock[`type:${typeId}`] = (stationStock[`type:${typeId}`] || 0) + qty;
    for (const [typeId, qty] of otherStationsMinerals) stationStock[`type:${typeId}`] = (stationStock[`type:${typeId}`] || 0) + qty;

    const stationDeficit = s.deficit || {};
    for (const g of Object.keys(stationDeficit)) {
      const deficit = stationDeficit[g];
      const recipe = recipes[g];
      if (!recipe || !recipe.minerals) continue;
      const incomingHullCount = (incomingHulls.get(stationId)?.get(g) || 0);
      const runsTarget = Math.min(Math.max(0, deficit - incomingHullCount), T.factoryRunsTarget);
      if (runsTarget <= 0) continue;

      for (const [mineralKey, qtyPerRun] of Object.entries(recipe.minerals)) {
        if (!mineralKey.startsWith("type:")) continue;
        const t = parseInt(mineralKey.slice("type:".length), 10);
        if (!Number.isSafeInteger(t) || !TRADE_STATES.MINERAL_TYPE_IDS.includes(t)) continue;
        const required = qtyPerRun * runsTarget;
        const have = Math.max(0, stationStock[`type:${t}`] || 0);
        const need = Math.max(0, required - have);
        if (need > 0) {
          const totalRequired = required;
          const deficitPct = totalRequired > 0 ? Math.floor((need * PERMILLE) / totalRequired) : 0;
          candidates.push({
            station: s,
            stationId,
            typeId: t,
            need,
            deficitPct,
            rank,
            recipe,
            runsTarget,
            itemKey: `type:${t}`,
          });
        }
      }
    }
  }

  candidates.sort((a, b) =>
    b.deficitPct - a.deficitPct ||
    a.rank - b.rank ||
    a.typeId - b.typeId
  );

  const hulls = hullCandidates({ trade, T, P, validChosen, desired, incomingHulls, production,
    stationsData: snapshot.production?.stations || [], logisticsOpen: snapshot.logistics ? snapshot.logistics.open : null,
    logisticsReady: Boolean(snapshot.logistics && snapshot.logistics.mode === "ready"), chosenStationIds,
    hullGroups: P.hullGroups });
  notes.push(...hulls.notes);

  const recalls = planRecalls(trade, T, at, candidates,
    Math.max(0, T.maxCancelsPerReview - cancelsUsed - oversize.intents.length - reprices.intents.length),
    { cancelledIds, hullCandidates: hulls.candidates });
  intents.push(...recalls.intents);
  notes.push(...recalls.notes);

  const newOffers = [];
  let privateBudgetUsed = 0;
  if (candidates.length > 0 && trade.suppliers && trade.suppliers.length > 0 &&
      trade.privateQuotes && Object.keys(trade.privateQuotes).length > 0 &&
      T.maxPrivateOffersPerReview && T.maxOpenPrivateOffersPerFaction && T.maxOpenPrivateOffersPerCharacter &&
      T.privateOfferTtlMs) {
    const privateResult = planPrivateOffers(trade, T, at, candidates, newOffers);
    intents.push(...privateResult.intents);
    notes.push(...privateResult.notes);
    privateBudgetUsed = privateResult.budgetUsed;
  }

  let budgetLeft = trade.budget ? trade.budget.availableIsk - privateBudgetUsed : 0;
  let openFactionCount = trade.open.length;
  openFactionCount += newOffers.length;
  const openPerStation = new Map();
  for (const offer of trade.open) {
    openPerStation.set(offer.stationId, (openPerStation.get(offer.stationId) || 0) + 1);
  }
  for (const offer of newOffers) {
    openPerStation.set(offer.stationId, (openPerStation.get(offer.stationId) || 0) + 1);
  }
  let offersCreated = newOffers.length;
  const tiers = tierStateOf(snapshot, trade, T, newOffers);
  const TC = tiers ? tiers.cfg : null;
  const volCap = tiers ? tiers.volCap : volCapOf(trade, T);

  for (const cand of candidates) {
    if (offersCreated >= T.maxOffersPerReview) break;

    const { stationId, typeId, need, itemKey, station } = cand;

    if (pairTaken(trade.open, newOffers, stationId, itemKey)) {
      notes.push(`TRADE_OFFER_EXISTS:${itemKey}@${stationId}`);
      continue;
    }

    if (openFactionCount >= T.maxOpenOffersPerFaction) {
      notes.push("TRADE_FACTION_LIMIT");
      break;
    }

    const stationOpen = openPerStation.get(stationId) || 0;
    if (stationOpen >= T.maxOpenOffersPerStation) {
      notes.push(`TRADE_STATION_LIMIT:${stationId}`);
      continue;
    }

    const quoteKey = `type:${typeId}`;
    const q = warQuoteAt(trade, stationId, quoteKey);
    if (!q || !q.ok) {
      notes.push(`TRADE_NO_PRICE:${itemKey}`);
      continue;
    }

    const unitMilli = q.unitMilli;
    const iskLimit = TC
      ? Math.min(T.maxIskPerOffer, budgetLeft, tiers.gateIsk, tiers.austerity ? TC.tier2Isk : Infinity)
      : Math.min(T.maxIskPerOffer, budgetLeft);
    if (iskLimit < T.minIskPerOffer) {
      notes.push(`TRADE_BUDGET_SHORT:${itemKey}`);
      continue;
    }

    const maxQty = Math.min(need, T.maxQuantityPerOffer, volCap(itemKey),
      Math.floor((Math.min(iskLimit, lotIskOf(T)) * PERMILLE) / unitMilli));
    if (maxQty < 1) {
      notes.push(`TRADE_OFFER_SMALL:${itemKey}`);
      continue;
    }

    const iskTotal = Math.floor((maxQty * unitMilli) / PERMILLE);
    if (iskTotal < T.minIskPerOffer) {
      notes.push(`TRADE_OFFER_SMALL:${itemKey}`);
      continue;
    }

    const stationInfo = trade.stations.find((s) => s.stationId === stationId);
    if (!stationInfo || stationInfo.kind !== "npc") {
      notes.push(`TRADE_NO_NPC_STATION:${stationId}`);
      continue;
    }

    budgetLeft -= iskTotal;
    openFactionCount++;
    openPerStation.set(stationId, stationOpen + 1);
    offersCreated++;

    const offer = {
      type: "TRADE_OFFER",
      slot: offersCreated - 1,
      stationId,
      systemId: station.systemId,
      issuerCorporationId: stationInfo.ownerCorporationId,
      itemKind: "mineral",
      itemKey,
      typeId,
      quantity: maxQty,
      unitPriceMilli: unitMilli,
      iskTotal,
      refPriceMilli: q.refMilli,
      capPriceMilli: q.capMilli,
      priceSource: q.source,
      expiresAt: at + T.offerTtlMs,
      purpose: PURPOSE_MOBILIZATION,
    };
    if (TC) {
      const cls = tierOf(iskTotal, TC);
      tiers.used[cls - 1] += 1;
      offer.expiresAt = at + tierTtlOf(cls, TC);
      offer.tier = cls;
    }
    if (Number.isSafeInteger(q.warPermille) && q.warPermille > 0) {
      offer.warPermille = q.warPermille;
      notes.push(`TRADE_WAR_PRICE:${itemKey}@${stationId}:${q.warPermille}`);
    }
    if (q.stationCapped === true) {
      offer.stationCapped = true;
      notes.push(`TRADE_WAR_STATION_CAPPED:${itemKey}@${stationId}`);
    }
    intents.push(offer);
    newOffers.push(offer);
  }

  const state = { budgetLeft, openFactionCount, openPerStation, offersCreated };
  planHullOffers({ trade, T, at, candidates: hulls.candidates, newOffers, tiers, state, intents, notes, volCap });

  if (T.stockpileEnabled === true && T.stockpileRuns > 0) {
    planStockpile({ trade, T, at, desired, recipes, stationsData: snapshot.production?.stations || [],
      incomingMinerals, intents, notes, newOffers, tiers, chosenStationIds, state });
  }

  const commodityOn = T.commodityOffersEnabled === true && Boolean(trade.commodity) && trade.commodity.ok === true;
  let usedBuys = 0;
  if (commodityOn) {
    usedBuys = planCommodityBuys({ trade, T, at, newOffers, state, intents, notes, volCap, lotIsk: lotIskOf(T) }).used;
  } else if (T.commodityOffersEnabled === true && trade.commodity) {
    notes.push(`TRADE_COMMODITY_OFF:${trade.commodity.reason}`);
  }

  if (T.wtsEnabled === true && trade.sellQuotes && trade.mode === "ready") {
    const sc = sellCandidates({ trade, T, desired, recipes, stationsData: snapshot.production?.stations || [],
      production, logistics, validChosen, warMinerals: new Set(candidates.map((c) => c.itemKey)),
      warHullGroups: new Set(hulls.candidates.map((c) => c.group)) });
    notes.push(...sc.notes);
    planSellOffers({ trade, T, at, candidates: sc.candidates, newOffers, state, intents, notes, volCap });
  }

  if (commodityOn && T.wtsEnabled === true && trade.commodity.sellQuotes && trade.mode === "ready") {
    planCommoditySells({ trade, T, at, newOffers, state, intents, notes, volCap,
      stationsData: snapshot.production?.stations || [], usedBuys });
  }

  return { intents, notes };
}

function oreYieldOf(trade, itemKey) {
  const table = trade.oreYields;
  if (!table || typeof table !== "object" || typeof itemKey !== "string"
    || !Object.prototype.hasOwnProperty.call(table, itemKey)) return null;
  const y = table[itemKey];
  return y && Number.isSafeInteger(y.portionSize) && y.portionSize >= 1 && Array.isArray(y.minerals) ? y : null;
}

function yieldOfMineral(y, k) {
  for (const pair of y.minerals) if (pair[0] === k) return pair[1];
  return 0;
}

function addOreIncoming(trade, incomingMinerals) {
  const eff = trade.oreRefineEfficiencyPermille;
  for (const offer of trade.open) {
    if (!OPEN_OFFER_STATES.includes(offer.state) || offer.side === TRADE_STATES.SIDE_SELL) continue;
    const y = oreYieldOf(trade, offer.itemKey);
    if (!y || offer.typeId !== Number(offer.itemKey.slice(5)) || !Number.isSafeInteger(offer.quantity)) continue;
    const portions = Math.floor(offer.quantity / y.portionSize);
    for (const [k, qty] of expectedYield(portions, y.minerals, eff)) {
      const t = Number(k.slice(5));
      if (!k.startsWith("type:") || !TRADE_STATES.MINERAL_TYPE_IDS.includes(t)) continue;
      const map = incomingMinerals.get(offer.stationId) || new Map();
      map.set(t, (map.get(t) || 0) + qty);
      incomingMinerals.set(offer.stationId, map);
    }
  }
}

function localCandidatesOf(a) {
  const { trade, stationInfo, stationId, mineralCands, local, ore, newOffers, notes } = a;
  const L = trade.localOre[stationId];
  const asTiers1 = { skip: false, own: mineralCands, filtered: 0 };
  if (L && typeof L === "object" && L.unknown === true) return asTiers1;
  if (!L || typeof L !== "object" || L.pending === true || !Array.isArray(L.ores) || !Array.isArray(L.minerals)) {
    if (!local) return asTiers1;
    notes.push(`TRADE_LOCAL_PENDING:${stationId}`);
    return { skip: true };
  }
  if (L.ores.length === 0 && L.minerals.length === 0) {
    if (!local) return asTiers1;
    notes.push(`TRADE_LOCAL_NONE:${stationId}`);
    return { skip: true };
  }
  const primaryByOre = new Map();
  const P = new Set();
  if (ore) {
    for (const o of L.ores) {
      const q = trade.quotes[o.itemKey];
      const y = oreYieldOf(trade, o.itemKey);
      if (!q || !q.ok || !y) continue;
      const p = primaryOf(y.minerals, trade.quotes);
      if (p === null) continue;
      primaryByOre.set(o.itemKey, p);
      P.add(p);
    }
  }
  const oreCands = [];
  for (const c of mineralCands) {
    if (!P.has(c.itemKey)) continue;
    if (pairTaken(trade.open, newOffers, stationId, c.itemKey)) continue;
    const o = L.ores.find((x) => primaryByOre.get(x.itemKey) === c.itemKey
      && !pairTaken(trade.open, newOffers, stationId, x.itemKey));
    if (!o) continue;
    oreCands.push({ stationInfo, stationId, typeId: o.baseTypeId, need: c.need, deficitPct: c.deficitPct,
      itemKey: o.itemKey, kind: "ore", primary: c.itemKey });
  }
  const minerals = new Set(L.minerals);
  let filtered = 0;
  const kept = [];
  for (const c of mineralCands) {
    if (local && !minerals.has(c.itemKey)) {
      filtered += 1;
      continue;
    }
    if (ore && P.has(c.itemKey)) continue;
    kept.push(c);
  }
  return { skip: false, own: [...oreCands, ...kept], filtered };
}

function tierStateOf(snapshot, trade, T, newOffers) {
  const cfg = T.tiersEnabled === true ? tierCfgOf(T) : null;
  if (!cfg) return null;
  const budget = trade.budget;
  const held = budget ? budget.availableIsk + budget.reservedIsk : 0;
  const gateIsk = mulDivFloor(Math.max(0, held), T.tierMaxBudgetSharePermille, PERMILLE);
  const tr = snapshot.treasury;
  const austerity = Boolean(tr && tr.mode === "ready" && tr.accountMode === "AUSTERITY");
  const used = [0, 0, 0];
  for (const o of trade.open) if (o.side !== TRADE_STATES.SIDE_SELL) used[tierOf(o.iskTotal, cfg) - 1] += 1;
  for (const o of newOffers) used[tierOf(o.iskTotal, cfg) - 1] += 1;
  return { cfg, gateIsk, austerity, used, volCap: volCapOf(trade, T), austerityNoted: false, fullNoted: false };
}

function volCapOf(trade, T) {
  const volumes = trade.volumes || null;
  const maxM3 = Number.isSafeInteger(T.maxOfferVolumeM3) && T.maxOfferVolumeM3 > 0 ? T.maxOfferVolumeM3 : null;
  return (itemKey) => {
    const v = volumes ? volumes[itemKey] : undefined;
    return maxM3 !== null && Number.isSafeInteger(v) && v > 0
      ? Math.floor((maxM3 * VOLUME_UNITS_PER_M3) / v) : T.maxQuantityPerOffer;
  };
}

function planStockpile(args) {
  const { trade, T, at, desired, recipes, stationsData, incomingMinerals, intents, notes, newOffers, state } = args;
  const tiers = args.tiers || null;
  const TC = tiers ? tiers.cfg : null;
  const volCap = tiers ? tiers.volCap : volCapOf(trade, T);
  const chosenStationIds = args.chosenStationIds instanceof Set ? args.chosenStationIds : new Set();
  const groups = Object.keys(desired).filter((g) => recipes[g] && recipes[g].minerals);
  if (groups.length === 0) {
    notes.push("TRADE_STOCKPILE_NO_RECIPE");
    return;
  }
  const perRun = new Map();
  for (const t of TRADE_STATES.MINERAL_TYPE_IDS) {
    let max = 0;
    for (const g of groups) {
      const v = recipes[g].minerals[`type:${t}`];
      if (Number.isSafeInteger(v) && v > max) max = v;
    }
    perRun.set(t, max);
  }

  const hasLocal = trade.localOre !== null && trade.localOre !== undefined && typeof trade.localOre === "object";
  const local = T.stockpileLocalOnly === true && hasLocal;
  const ore = T.oreOffersEnabled === true && hasLocal && trade.oreYields !== null && trade.oreYields !== undefined;
  let filtered = 0;
  const pushFiltered = () => { if (filtered > 0) notes.push(`TRADE_LOCAL_FILTERED:${filtered}`); };
  const needLeft = new Map();

  const candidates = [];
  const npcStations = trade.stations.filter((s) => s.kind === "npc")
    .sort((a, b) => byId(a.stationId, b.stationId));
  for (const stationInfo of npcStations) {
    const stationId = stationInfo.stationId;
    const stationData = stationsData.find((st) => st.stationId === stationId);
    if (!stationData) continue;
    const minerals = stationData.minerals || {};
    const inc = incomingMinerals.get(stationId) || new Map();
    let own = [];
    for (const t of TRADE_STATES.MINERAL_TYPE_IDS) {
      const target = perRun.get(t) * T.stockpileRuns;
      if (!(target > 0)) continue;
      const have = Math.max(0, (minerals[`type:${t}`] || 0) + (inc.get(t) || 0));
      const need = target - have;
      if (need <= 0) continue;
      own.push({ stationInfo, stationId, typeId: t, need, deficitPct: Math.floor((need * PERMILLE) / target),
        itemKey: `type:${t}` });
    }
    own.sort((a, b) => b.deficitPct - a.deficitPct || a.typeId - b.typeId);
    needLeft.set(stationId, new Map(own.map((c) => [c.itemKey, c.need])));
    if (local || ore) {
      const lc = localCandidatesOf({ trade, stationInfo, stationId, mineralCands: own, local, ore, newOffers, notes });
      if (lc.skip) continue;
      own = lc.own;
      filtered += lc.filtered;
    }
    own.forEach((c, r) => candidates.push({ ...c, r }));
  }
  if (candidates.length === 0) {
    notes.push("TRADE_STOCKPILE_FULL");
    pushFiltered();
    return;
  }
  candidates.sort((a, b) => a.r - b.r || b.deficitPct - a.deficitPct || byId(a.stationId, b.stationId)
    || a.typeId - b.typeId);

  const { factionCap, targetOn, galaxy } = factionCapOf(trade, T);
  let galaxyLeft = targetOn ? T.targetOpenContracts - galaxy.open - state.offersCreated : Infinity;
  const budget = trade.budget;
  const floorIsk = budget
    ? Math.floor(((budget.availableIsk + budget.reservedIsk) * T.stockpileFreeFloorPermille) / PERMILLE) : 0;
  const quota = TC ? tierQuotas(factionCap, TC) : null;

  for (const cand of candidates) {
    if (state.offersCreated >= T.maxOffersPerReview) break;
    if (state.openFactionCount >= factionCap || galaxyLeft <= 0) {
      notes.push("TRADE_TARGET_REACHED");
      break;
    }
    const { stationInfo, stationId, typeId, itemKey } = cand;
    if (pairTaken(trade.open, newOffers, stationId, itemKey)) continue;
    const left = needLeft.get(stationId);
    const isOre = cand.kind === "ore";
    const y = isOre ? oreYieldOf(trade, itemKey) : null;
    if (isOre && !y) continue;
    const leftK = left && left.has(isOre ? cand.primary : itemKey) ? left.get(isOre ? cand.primary : itemKey) : cand.need;
    let need = Math.min(cand.need, leftK);
    if (need <= 0) continue;
    const unit = isOre ? y.portionSize : 1;
    if (isOre) {
      need = portionsFor(need, yieldOfMineral(y, cand.primary), trade.oreRefineEfficiencyPermille) * y.portionSize;
      if (!(need > 0) || !Number.isSafeInteger(need)) {
        notes.push(`TRADE_OFFER_SMALL:${itemKey}`);
        continue;
      }
    }
    const stationOpen = state.openPerStation.get(stationId) || 0;
    if (stationOpen >= T.maxOpenOffersPerStation) {
      notes.push(`TRADE_STATION_LIMIT:${stationId}`);
      continue;
    }
    const q = trade.quotes[itemKey];
    if (!q || !q.ok) {
      notes.push(`TRADE_NO_PRICE:${itemKey}`);
      continue;
    }
    let quantity;
    let iskTotal;
    let cls = 0;
    if (TC) {
      const sized = sizeTieredOffer({ T, TC, tiers, quota, q, need, itemKey, stationId, chosenStationIds,
        roomIsk: Math.min(T.maxIskPerOffer, tiers.gateIsk, state.budgetLeft - floorIsk), notes, unit,
        lotIsk: lotIskOf(T) });
      if (sized.stop) break;
      if (!sized.ok) continue;
      ({ quantity, iskTotal, cls } = sized);
    } else {
      const iskLimit = Math.min(T.stockpileMaxIskPerOffer, T.maxIskPerOffer, state.budgetLeft - floorIsk);
      if (iskLimit < T.minIskPerOffer) {
        notes.push("TRADE_STOCKPILE_FLOOR");
        break;
      }
      quantity = Math.min(need, T.maxQuantityPerOffer, volCap(itemKey),
        Math.floor((Math.min(iskLimit, lotIskOf(T)) * PERMILLE) / q.unitMilli));
      if (unit > 1) quantity = Math.floor(quantity / unit) * unit;
      iskTotal = Math.floor((quantity * q.unitMilli) / PERMILLE);
      if (quantity < 1 || iskTotal < T.minIskPerOffer) {
        notes.push(`TRADE_OFFER_SMALL:${itemKey}`);
        continue;
      }
    }
    if (stationInfo.kind !== "npc") {
      notes.push(`TRADE_NO_NPC_STATION:${stationId}`);
      continue;
    }
    const offer = {
      type: "TRADE_OFFER",
      slot: state.offersCreated,
      stationId,
      systemId: stationInfo.systemId,
      issuerCorporationId: stationInfo.ownerCorporationId,
      itemKind: isOre ? ITEM_KIND_ORE : "mineral",
      itemKey,
      typeId,
      quantity,
      unitPriceMilli: q.unitMilli,
      iskTotal,
      refPriceMilli: q.refMilli,
      capPriceMilli: q.capMilli,
      priceSource: q.source,
      expiresAt: at + (TC ? tierTtlOf(cls, TC) : T.offerTtlMs),
      purpose: PURPOSE_STOCKPILE,
    };
    if (TC) {
      offer.tier = cls;
      tiers.used[cls - 1] += 1;
    }
    state.budgetLeft -= iskTotal;
    state.openFactionCount += 1;
    state.openPerStation.set(stationId, stationOpen + 1);
    state.offersCreated += 1;
    galaxyLeft -= 1;
    intents.push(offer);
    newOffers.push(offer);
    if (isOre) {
      for (const [k, got] of expectedYield(quantity / y.portionSize, y.minerals, trade.oreRefineEfficiencyPermille)) {
        if (left && left.has(k)) left.set(k, left.get(k) - got);
      }
      notes.push(`TRADE_ORE_OFFER:${itemKey}@${stationId}`);
    } else {
      notes.push(`TRADE_STOCKPILE_OFFER:${itemKey}@${stationId}`);
    }
  }
  pushFiltered();
}

function sizeTieredOffer(a) {
  const { T, TC, tiers, quota, q, need, itemKey, stationId, chosenStationIds, roomIsk, notes } = a;
  const unit = Number.isSafeInteger(a.unit) && a.unit > 1 ? a.unit : 1;
  const lotQ = Number.isSafeInteger(a.lotIsk) && a.lotIsk > 0 ? mulDivFloor(a.lotIsk, PERMILLE, q.unitMilli) : Infinity;
  const needQ = Math.floor(Math.min(need, T.maxQuantityPerOffer, tiers.volCap(itemKey), lotQ) / unit) * unit;
  const needIsk = mulDivFloor(needQ, q.unitMilli, PERMILLE);
  if (needIsk < T.tierMinOfferIsk) {
    notes.push(`TRADE_TIER_NEED_SMALL:${itemKey}`);
    return { ok: false, stop: false };
  }
  if (roomIsk < T.tierMinOfferIsk) {
    notes.push("TRADE_STOCKPILE_FLOOR");
    return { ok: false, stop: true };
  }
  const top = chosenStationIds.has(stationId) ? 1 : (tiers.austerity ? 2 : 3);
  if (tiers.austerity && tierOf(needIsk, TC) === 3 && !tiers.austerityNoted) {
    tiers.austerityNoted = true;
    notes.push("TRADE_TIER_AUSTERITY");
  }
  let tier = Math.min(tierOf(needIsk, TC), top);
  while (tier >= 1 && tiers.used[tier - 1] >= quota[tier - 1]) tier -= 1;
  if (tier < 1) return tierFull(tiers, notes);
  const offerIsk = Math.min(needIsk, tierCapOf(tier, TC), roomIsk);
  const quantity = Math.floor(Math.min(needQ, mulDivFloor(offerIsk, PERMILLE, q.unitMilli)) / unit) * unit;
  const iskTotal = mulDivFloor(quantity, q.unitMilli, PERMILLE);
  if (quantity < 1 || iskTotal < T.tierMinOfferIsk) {
    notes.push(`TRADE_OFFER_SMALL:${itemKey}`);
    return { ok: false, stop: false };
  }
  const cls = tierOf(iskTotal, TC);
  if (tiers.used[cls - 1] >= quota[cls - 1]) return tierFull(tiers, notes);
  return { ok: true, quantity, iskTotal, cls };
}

function tierFull(tiers, notes) {
  if (!tiers.fullNoted) {
    tiers.fullNoted = true;
    notes.push("TRADE_TIER_FULL");
  }
  return { ok: false, stop: false };
}

module.exports = { planTrade, pairTaken, planPrivateOffers, planRecalls, planOversizeRecalls, planWarReprices,
  isStockpileOffer,
  tierStateOf, OPEN_OFFER_STATES };