"use strict";

const { createPriceCache } = require("./priceCache");
const { createStationAskCache } = require("./stationAskCache");
const { quote, quoteSell, quoteCommoditySell, PERMILLE } = require("./pricing");
const { tiersFromConfig, bonusFor, standingMilliOf } = require("./standingTiers");
const S = require("./schema");
const { quoteOre } = require("./orePricing");
const { MINERALS_ONLY } = require("./tradeCatalog");
const { SCHEMA } = require("../../../config");
const { warPriceParams } = require("../../strategy/data/warPricePressure");

const COUNTER_NAMES = Object.freeze([
  "funded", "fundedUnits", "fundedIsk", "fundCapped", "fundRefused", "notReady",
  "offerCreated", "offerCancelled", "offerRefused", "reservedIsk", "releasedIsk",
  "quoteNoPrice", "quoteCapped",
  "privateOffers", "privateNoGain", "privateCooldown", "standingReadFailed", "suppliersSeen",
  "stockpileOffers",
  "tierOffers1", "tierOffers2", "tierOffers3",
  "oreQuoteNoPrice", "oreRefineCapped",
  "oreOffers", "localFiltered",
  "stockpileRecalls",
  "hullOffers",
  "wtsOffers", "wtsStockLost",
  "wtsNoPrice", "wtsRecalls",
  "warQuotes", "warOffers",
  "warRepriced",
  "stationAskReads", "stationAskFailed", "stationAskUnread", "warStationCapped",
  "commodityQuoteNoPrice", "commoditySellNoPrice", "commodityNeedsRefused", "commodityOffers",
]);
const METRIC_ORE_OFFERS = "trade.oreOffers";
const METRIC_LOCAL_FILTERED = "trade.localFiltered";
const METRIC_STOCKPILE_RECALLS = "trade.stockpileRecalls";
const METRIC_HULL_OFFERS = "trade.hullOffers";
const METRIC_WTS_OFFERS = "trade.wtsOffers";
const METRIC_WTS_STOCK_LOST = "trade.wtsStockLost";
const METRIC_WTS_NO_PRICE = "trade.wtsNoPrice";
const METRIC_WTS_RECALLS = "trade.wtsRecalls";
const METRIC_WAR_QUOTES = "trade.warQuotes";
const METRIC_WAR_OFFERS = "trade.warOffers";
const METRIC_WAR_REPRICED = "trade.warRepriced";
const METRIC_STATION_ASK_READS = "trade.stationAskReads";
const METRIC_STATION_ASK_FAILED = "trade.stationAskFailed";
const METRIC_STATION_ASK_UNREAD = "trade.stationAskUnread";
const METRIC_WAR_STATION_CAPPED = "trade.warStationCapped";
const METRIC_BY_COUNTER = Object.freeze({ oreOffers: METRIC_ORE_OFFERS, localFiltered: METRIC_LOCAL_FILTERED,
  stockpileRecalls: METRIC_STOCKPILE_RECALLS, hullOffers: METRIC_HULL_OFFERS, wtsOffers: METRIC_WTS_OFFERS,
  wtsStockLost: METRIC_WTS_STOCK_LOST, wtsNoPrice: METRIC_WTS_NO_PRICE, wtsRecalls: METRIC_WTS_RECALLS,
  warQuotes: METRIC_WAR_QUOTES, warOffers: METRIC_WAR_OFFERS, warRepriced: METRIC_WAR_REPRICED,
  stationAskReads: METRIC_STATION_ASK_READS, stationAskFailed: METRIC_STATION_ASK_FAILED,
  stationAskUnread: METRIC_STATION_ASK_UNREAD, warStationCapped: METRIC_WAR_STATION_CAPPED });
const READY = "ready";
const schemaDefault = (key) => {
  const row = SCHEMA.find((r) => r.key === key);
  return row ? row.default : undefined;
};
const DEFAULT_MAX_DELTAS = schemaDefault("stations.maxDeltasPerChange");
const DEFAULT_MAX_PER_READ = schemaDefault("trade.localResourcesMaxSystemsPerRead");
const GALAXY_FACTIONS_LIMIT = 64;

function metric(telemetry, name, value) {
  if (!telemetry || typeof telemetry.count !== "function") return;
  try { telemetry.count(name, value); } catch (_err) {}
}

function bump(counters, telemetry, name, n = 1) {
  if (!(n > 0) || !Object.prototype.hasOwnProperty.call(counters, name)) return;
  counters[name] = Math.min(Number.MAX_SAFE_INTEGER, counters[name] + n);
  metric(telemetry, METRIC_BY_COUNTER[name] || `trade.${name}`, n);
}

const notReady = (reason, headroomIsk) => ({ ready: false, reason, headroomIsk });

function createTradeService(deps) {
  const { budgets, offers, config, clock, telemetry, readStanding } = deps;
  const catalog = deps.catalog || MINERALS_ONLY;
  const oreTypes = deps.oreTypes || null;
  const T = config.trade;
  const pendingLocal = new Set();
  const maxPendingLocal = Number.isSafeInteger(T.localResourcesMaxSystemsPerRead) && T.localResourcesMaxSystemsPerRead > 0
    ? T.localResourcesMaxSystemsPerRead : DEFAULT_MAX_PER_READ;
  const counters = Object.fromEntries(COUNTER_NAMES.map((n) => [n, 0]));
  let state = READY;
  let lastRefusal = null;
  let seq = 0;

  const suppliersCache = new Map();
  const plans = new Map();
  const lastWar = new Map();

  const priceCache = createPriceCache({ ttlMs: T.priceCacheMs });
  const stationAskCache = createStationAskCache({ ttlMs: T.stationAskCacheMs, maxStations: T.stationAskCacheMaxStations,
    maxPending: T.stationAskCacheMaxStations });

  let standingTiersResult = { ok: true, tiers: [] };
  if (readStanding && typeof readStanding === "function") {
    standingTiersResult = tiersFromConfig(T);
  }

  function tradeReady(db, factionId, opts) {
    if (state !== READY) return notReady("TRADE_OFF", 0);
    const npc = opts && Number.isSafeInteger(opts.npcStations) ? opts.npcStations : 0;
    if (npc < 1) return notReady("NO_NPC_STATION", 0);
    const r = budgets.getBudget(db, factionId);
    if (!r || !r.ok) return notReady("TRADE_OFF", 0);
    const held = r.budget ? r.budget.availableIsk + r.budget.reservedIsk : 0;
    const headroomIsk = Math.max(0, T.iskBudgetCap - held);
    if (headroomIsk < T.iskPerResourceUnit) return notReady("BUDGET_FULL", headroomIsk);
    return { ready: true, reason: null, headroomIsk };
  }

  function fundFromUpkeepInTx(db, intent, key) {
    if (state !== READY) return { ok: false, reason: "TRADE_UNAVAILABLE", detail: "stopped" };
    if (!intent || typeof intent !== "object") return { ok: false, reason: "TRADE_INVALID_INPUT", detail: "intent" };
    const r = budgets.fundInTx(db, {
      factionId: intent.factionId, units: intent.units, paidUntilTo: intent.paidUntilTo,
      iskPerUnit: T.iskPerResourceUnit, capIsk: T.iskBudgetCap,
      at: intent.at === undefined ? clock.now() : intent.at,
    }, key);
    if (!r || !r.ok) return r || { ok: false, reason: "TRADE_FUND_FAILED" };
    if (r.duplicate) return { ok: false, reason: "NESTED_KEY_REUSED", detail: key };
    return { ok: true, fundedUnits: r.fundedUnits, fundedIsk: r.fundedIsk, capped: r.capped };
  }

  function fundFromTreasuryInTx(db, spec, key) {
    if (state !== READY) return { ok: false, reason: "TRADE_UNAVAILABLE", detail: "stopped" };
    if (!spec || typeof spec !== "object") return { ok: false, reason: "TRADE_INVALID_INPUT", detail: "spec" };
    const r = budgets.fundIskInTx(db, { factionId: spec.factionId, isk: spec.isk, capIsk: T.iskBudgetCap,
      at: spec.at }, key);
    if (!r || !r.ok) return r || { ok: false, reason: "TRADE_FUND_FAILED" };
    if (r.duplicate) return { ok: false, reason: "NESTED_KEY_REUSED", detail: key };
    return { ok: true, fundedIsk: r.fundedIsk, capped: r.capped };
  }

  function readForReview(db, factionId, opts) {
    if (state !== READY) return { ok: true, trade: { mode: "off", budget: null } };
    if (!opts || !isId(factionId) || !Array.isArray(opts.stations) || !Number.isSafeInteger(opts.at) || !Number.isSafeInteger(opts.limit)) {
      return { ok: false, reason: "TRADE_INVALID_INPUT", detail: "opts" };
    }
    const stations = opts.stations.filter((s) => s.kind === "npc");
    const budget = budgets.getBudget(db, factionId);
    if (!budget.ok) return budget;
    const budgetData = budget.budget ? { availableIsk: budget.budget.availableIsk, reservedIsk: budget.budget.reservedIsk } : null;
    const open = offers.listOpenOfFaction(db, factionId, opts.limit);
    if (!open.ok) return open;

    const quotes = {};
    let noPriceCount = 0;
    let cappedCount = 0;
    for (const typeId of S.MINERAL_TYPE_IDS) {
      const key = `type:${typeId}`;
      const refs = priceCache.peek(typeId, opts.at);
      if (!refs) {
        noPriceCount++;
        continue;
      }
      const q = quote(refs, {
        premiumPermille: T.premiumPermille,
        askCapPermille: T.askCapPermille,
        bonusPermille: 0,
        maxUnitPriceMilli: T.maxUnitPriceMilli,
      });
      if (q.ok) {
        quotes[key] = q;
        if (q.capped) cappedCount++;
      } else {
        noPriceCount++;
      }
    }
    let hulls = null;
    if (T.hullOffersEnabled === true && typeof catalog.hullsFor === "function" && catalog.hullsAvailable !== false) {
      hulls = {};
      for (const [group, e] of Object.entries(catalog.hullsFor(factionId))) {
        hulls[group] = { typeId: e.typeId, itemKey: e.itemKey };
        const refs = priceCache.peek(e.typeId, opts.at);
        const q = refs ? quote(refs, { premiumPermille: T.premiumPermille, askCapPermille: T.askCapPermille,
          bonusPermille: 0, maxUnitPriceMilli: T.maxUnitPriceMilli }) : null;
        if (!q || !q.ok) {
          noPriceCount++;
          continue;
        }
        quotes[e.itemKey] = q;
        if (q.capped) cappedCount++;
      }
    }
    if (noPriceCount > 0) bump(counters, telemetry, "quoteNoPrice", noPriceCount);
    if (cappedCount > 0) bump(counters, telemetry, "quoteCapped", cappedCount);

    let oreNoPrice = 0;
    let oreCapped = 0;
    for (const typeId of catalog.priceTypeIds) {
      const entry = catalog.get(`type:${typeId}`);
      if (!entry || entry.itemKind !== S.ITEM_KIND_ORE) continue;
      const q = quoteOre(priceCache.peek(typeId, opts.at), quotes, entry, {
        premiumPermille: T.premiumPermille,
        askCapPermille: T.askCapPermille,
        maxUnitPriceMilli: T.maxUnitPriceMilli,
        efficiencyPermille: T.oreRefineEfficiencyPermille,
      });
      if (!q.ok) { oreNoPrice++; continue; }
      quotes[entry.itemKey] = q;
      if (q.refineCapped) oreCapped++;
    }
    if (oreNoPrice > 0) bump(counters, telemetry, "oreQuoteNoPrice", oreNoPrice);
    if (oreCapped > 0) bump(counters, telemetry, "oreRefineCapped", oreCapped);

    const wts = wtsOn() ? sellPricesOf(open.offers, hulls, opts.at) : null;

    const privateOffersEnabled = T.privateOffersEnabled === true && standingTiersResult.ok && readStanding && typeof readStanding === "function";
    let suppliers = [];
    let privateQuotes = {};

    if (privateOffersEnabled) {
      const supplierOpts = {
        since: Math.max(0, opts.at - (T.supplierLookbackMs || 604800000)),
        limit: T.maxSuppliersPerReview || 20,
        cooldownMs: T.privateRejectCooldownMs || 0,
        rejectedSince: Math.max(0, opts.at - (T.privateRejectCooldownMs || 0)),
      };
      const supplierResult = offers.getSuppliersWithRejection(db, factionId, supplierOpts);
      if (!supplierResult.ok) {
        suppliers = [];
      } else {
        bump(counters, telemetry, "suppliersSeen", supplierResult.suppliers.length);

        const enrichedSuppliers = [];
        for (const s of supplierResult.suppliers) {
          const standingResult = readStanding(s.characterId, factionId);
          if (!standingResult.ok) {
            bump(counters, telemetry, "standingReadFailed", 1);
            continue;
          }
          if (!standingResult.found) {
            continue;
          }
          const standingMilli = standingMilliOf(standingResult.standing);
          const bonus = bonusFor(standingMilli, standingTiersResult.tiers);
          if (bonus <= 0) continue;

          const supplierData = {
            characterId: s.characterId,
            standingMilli,
            bonusPermille: bonus,
          };
          if (s.rejectedAt !== null && s.rejectedAt !== undefined) {
            supplierData.rejectedAt = s.rejectedAt;
          }
          enrichedSuppliers.push(supplierData);
        }

        enrichedSuppliers.sort((a, b) =>
          b.bonusPermille - a.bonusPermille ||
          b.standingMilli - a.standingMilli ||
          a.characterId - b.characterId
        );

        suppliers = enrichedSuppliers;

        const uniqueBonuses = [...new Set(suppliers.map((s) => s.bonusPermille))];
        for (const bonus of uniqueBonuses) {
          privateQuotes[bonus] = {};
          for (const typeId of S.MINERAL_TYPE_IDS) {
            const key = `type:${typeId}`;
            const refs = priceCache.peek(typeId, opts.at);
            if (!refs) continue;
            const q = quote(refs, {
              premiumPermille: T.premiumPermille,
              askCapPermille: T.askCapPermille,
              bonusPermille: bonus,
              maxUnitPriceMilli: T.maxUnitPriceMilli,
            });
            if (q.ok) {
              privateQuotes[bonus][key] = q;
            }
          }
        }

        suppliersCache.set(factionId, { suppliers, at: opts.at });
      }
    } else {
      suppliersCache.delete(factionId);
    }

    const trade = {
        mode: "ready",
        localOre: readLocalOre(stations),
        oreYields: oreYieldsOf(),
        oreRefineEfficiencyPermille: T.oreRefineEfficiencyPermille,
        galaxy: readGalaxy(db),
        budget: budgetData,
        open: open.offers.map((o) => {
          const entry = {
            offerId: o.offerId,
            stationId: o.stationId,
            itemKey: o.itemKey,
            typeId: o.typeId,
            quantity: o.quantity,
            state: o.state,
            expiresAt: o.expiresAt,
            version: o.version,
            iskTotal: o.iskTotal,
            issuerCorporationId: o.issuerCorporationId,
            assigneeCharacterId: o.assigneeCharacterId,
          };
          if (o.side === S.SIDE_SELL) entry.side = S.SIDE_SELL;
          return entry;
        }),
        openTruncated: open.truncated,
        stations: stations.map((s) => ({ stationId: s.stationId, systemId: s.systemId, ownerCorporationId: s.ownerCorporationId, kind: s.kind })),
        quotes,
        privateQuotes,
        suppliers,
        volumes: catalog.volumes,
        hulls,
    };
    if (wts !== null) {
      trade.sellQuotes = wts.sellQuotes;
      trade.buyUnitMax = wts.buyUnitMax;
    }
    if (T.warPricingEnabled === true) {
      const pressurePermille = pressureArg(opts.warPressurePermille);
      const warQuotes = warQuotesOf(quotes, hulls, pressurePermille, opts.at);
      const warItems = Object.keys(warQuotes).length;
      trade.warPressurePermille = pressurePermille;
      trade.warQuotes = warQuotes;
      open.offers.forEach((o, i) => { trade.open[i].unitPriceMilli = o.unitPriceMilli; });
      lastWar.set(factionId, Object.freeze({ at: opts.at, pressurePermille, warItems }));
      if (warItems > 0) bump(counters, telemetry, "warQuotes", warItems);
      if (T.warStationAskGuardEnabled === true && warItems > 0) {
        trade.stationWarCaps = stationWarCapsOf(stations, warQuotes, hulls, opts.at);
      }
    }
    if (T.commodityOffersEnabled === true) trade.commodity = readCommodity(db, factionId, opts.at);
    return { ok: true, trade };
  }

  function readCommodity(db, factionId, at) {
    let ex = null;
    try { ex = typeof deps.getExtraction === "function" ? deps.getExtraction() : null; } catch (_err) { ex = null; }
    if (!ex || typeof ex.readNeeds !== "function") {
      bump(counters, telemetry, "commodityNeedsRefused", 1);
      return { ok: false, reason: "EXTRACTION_UNAVAILABLE" };
    }
    let r;
    try { r = ex.readNeeds(db, factionId); } catch (err) { r = { ok: false, reason: `NEEDS_THREW: ${String((err && err.message) || err)}` }; }
    if (!r || r.ok !== true || !Array.isArray(r.needs) || !Array.isArray(r.stations)) {
      bump(counters, telemetry, "commodityNeedsRefused", 1);
      return { ok: false, reason: String((r && r.reason) || "NEEDS_READ_FAILED").slice(0, 64) };
    }
    const isKind = (k) => k === S.ITEM_KIND_MOON || k === S.ITEM_KIND_PI;
    const needs = r.needs.filter((n) => n && isKind(n.itemKind) && isId(n.typeId) && n.need > 0)
      .map((n) => ({ stationId: n.stationId, kind: n.kind, itemKind: n.itemKind, itemKey: `type:${n.typeId}`,
        typeId: n.typeId, need: n.need }));
    const reserve = {};
    for (const s of r.stations) {
      if (!s || typeof s.stationId !== "string") continue;
      const m = {};
      for (const x of Array.isArray(s.reserve) ? s.reserve : []) {
        if (x && isId(x.typeId) && Number.isSafeInteger(x.units) && x.units > 0) m[`type:${x.typeId}`] = x.units;
      }
      reserve[s.stationId] = m;
    }
    const kinds = catalog.commodityKinds || {};
    const quotes = {};
    const sellOn = wtsOn();
    const sellQuotes = sellOn ? {} : null;
    let noPrice = 0;
    let sellNoPrice = 0;
    for (const typeId of catalog.priceTypeIds) {
      const key = `type:${typeId}`;
      if (!Object.prototype.hasOwnProperty.call(kinds, key)) continue;
      const refs = priceCache.peek(typeId, at);
      const q = refs ? quote(refs, { premiumPermille: T.premiumPermille, askCapPermille: T.askCapPermille,
        bonusPermille: 0, maxUnitPriceMilli: T.maxUnitPriceMilli }) : null;
      if (q && q.ok) quotes[key] = q;
      else noPrice += 1;
      if (!sellOn) continue;
      const sq = refs ? quoteCommoditySell(refs, { sellAskPermille: T.commoditySellAskPermille,
        sellBidFloorPermille: T.commoditySellBidFloorPermille, maxUnitPriceMilli: T.maxUnitPriceMilli }) : null;
      if (sq && sq.ok) sellQuotes[key] = sq;
      else sellNoPrice += 1;
    }
    if (noPrice > 0) bump(counters, telemetry, "commodityQuoteNoPrice", noPrice);
    if (sellNoPrice > 0) bump(counters, telemetry, "commoditySellNoPrice", sellNoPrice);
    const en = r.enforced || {};
    const shortKeys = Array.isArray(r.shortKeys) ? r.shortKeys.filter((k) => typeof k === "string") : null;
    const noDonorStations = Number.isSafeInteger(r.noDonorStations) && r.noDonorStations >= 0 ? r.noDonorStations : null;
    return { ok: true, enforced: { fuel: en.fuel === true, advanced: en.advanced === true }, needs, reserve, kinds,
      quotes, sellQuotes, ...(shortKeys !== null ? { shortKeys } : {}), noDonorStations };
  }

  function stationWarCapsOf(stations, warQuotes, hulls, at) {
    const hullType = new Map(Object.values(hulls || {}).map((e) => [e.itemKey, e.typeId]));
    const typeOf = (k) => (hullType.has(k) ? hullType.get(k)
      : k.startsWith("type:") ? Number(k.slice(5)) : null);
    const keys = Object.keys(warQuotes).filter((k) => isId(typeOf(k)));
    const typeIds = [...new Set(keys.map(typeOf))];
    const out = {};
    for (const s of stations) {
      const vendorId = s.npcStationId;
      if (!isId(vendorId)) continue;
      const asks = stationAskCache.peek(vendorId, at);
      if (asks === null) {
        stationAskCache.want(vendorId, typeIds);
        bump(counters, telemetry, "stationAskUnread", 1);
        continue;
      }
      const caps = {};
      const unknown = [];
      for (const k of keys) {
        const t = typeOf(k);
        if (!asks.has(t)) {
          unknown.push(t);
          continue;
        }
        const a = asks.get(t);
        caps[k] = a === null ? null : Math.floor((a * T.warStationAskCapPermille) / PERMILLE);
      }
      if (unknown.length > 0) stationAskCache.want(vendorId, unknown);
      out[String(s.stationId)] = caps;
    }
    return out;
  }

  function pressureArg(v) {
    return Number.isSafeInteger(v) ? Math.min(PERMILLE, Math.max(0, v)) : 0;
  }

  function warQuotesOf(quotes, hulls, pressurePermille, at) {
    const out = {};
    if (pressurePermille <= 0) return out;
    const wp = warPriceParams(pressurePermille, T);
    const add = (itemKey, typeId) => {
      const base = quotes[itemKey];
      const refs = base && base.ok ? priceCache.peek(typeId, at) : null;
      if (!refs) return;
      const q = quote(refs, { premiumPermille: T.premiumPermille, askCapPermille: wp.askCapPermille,
        bonusPermille: wp.bonusPermille, askCapCeilPermille: wp.askCapCeilPermille,
        maxUnitPriceMilli: T.maxUnitPriceMilli });
      if (q.ok && q.unitMilli > base.unitMilli) out[itemKey] = Object.freeze({ ...q, warPermille: pressurePermille });
    };
    for (const typeId of S.MINERAL_TYPE_IDS) add(`type:${typeId}`, typeId);
    for (const e of Object.values(hulls || {})) add(e.itemKey, e.typeId);
    return out;
  }

  function readWarPricing(factionId) {
    const w = lastWar.get(factionId);
    return w ? { ok: true, found: true, at: w.at, pressurePermille: w.pressurePermille, warItems: w.warItems }
      : { ok: true, found: false };
  }

  function wtsOn() {
    if (T.wtsEnabled !== true || typeof deps.sellSeamsOk !== "function") return false;
    try { return deps.sellSeamsOk() === true; } catch (_err) { return false; }
  }

  function sellPricesOf(openOffers, hulls, at) {
    const p = { askPermille: T.wtsAskPermille, bidPermille: T.wtsBidPermille, maxUnitPriceMilli: T.maxUnitPriceMilli };
    const sellQuotes = {};
    let noPrice = 0;
    const add = (itemKey, typeId) => {
      const refs = priceCache.peek(typeId, at);
      const q = refs ? quoteSell(refs, p) : null;
      if (q && q.ok) sellQuotes[itemKey] = q;
      else noPrice += 1;
    };
    for (const typeId of S.MINERAL_TYPE_IDS) add(`type:${typeId}`, typeId);
    for (const [group, e] of Object.entries(hulls || {})) add(`group:${group}`, e.typeId);
    if (noPrice > 0) bump(counters, telemetry, "wtsNoPrice", noPrice);
    const buyUnitMax = {};
    for (const o of openOffers) {
      if (o.side === S.SIDE_SELL || !Number.isSafeInteger(o.unitPriceMilli)) continue;
      if (!(buyUnitMax[o.typeId] >= o.unitPriceMilli)) buyUnitMax[o.typeId] = o.unitPriceMilli;
    }
    return { sellQuotes, buyUnitMax };
  }

  function readLocalOre(npcStations) {
    let api = null;
    try { api = typeof deps.getLocalResources === "function" ? deps.getLocalResources() : null; } catch (_err) { api = null; }
    if (!api || typeof api.localResourcesFor !== "function") return null;
    let views = null;
    try {
      views = api.localResourcesFor(npcStations.map((s) => s.systemId), { read: false });
    } catch (_err) {
      views = null;
    }
    if (!(views instanceof Map)) return null;
    const maxDeltas = deps.config.stations && Number.isSafeInteger(deps.config.stations.maxDeltasPerChange)
      ? deps.config.stations.maxDeltasPerChange : DEFAULT_MAX_DELTAS;
    const out = {};
    for (const s of npcStations) {
      const v = views.get(s.systemId);
      if (!v || typeof v !== "object") {
        out[s.stationId] = { ores: [], minerals: [], pending: true };
        notePendingLocal(s.systemId);
        continue;
      }
      const ores = [];
      const minerals = new Set();
      for (const o of Array.isArray(v.ores) ? v.ores : []) {
        const b = o && o.baseTypeId;
        if (!Number.isSafeInteger(b) || b < 1) continue;
        const itemKey = `type:${b}`;
        for (const k of mineralKeysOf(b)) minerals.add(k);
        const entry = catalog.get(itemKey);
        if (!entry || !catalog.offerable(S.ITEM_KIND_ORE, itemKey, b) || entry.minerals.length > maxDeltas) continue;
        ores.push({ baseTypeId: b, itemKey, distance: o.distance });
      }
      const pending = v.pending === true;
      out[s.stationId] = { ores, minerals: [...minerals].sort(), pending };
      if (v.unknown === true) out[s.stationId].unknown = true;
      if (pending) notePendingLocal(s.systemId);
    }
    return out;
  }

  function mineralKeysOf(baseTypeId) {
    const table = oreTypes && oreTypes.ORE_TYPES && typeof oreTypes.ORE_TYPES === "object" ? oreTypes.ORE_TYPES : null;
    if (table !== null) {
      const row = table[String(baseTypeId)];
      if (!row || !row.minerals || typeof row.minerals !== "object") return [];
      return Object.keys(row.minerals).filter((k) => Number.isSafeInteger(row.minerals[k]) && row.minerals[k] > 0);
    }
    const entry = catalog.get(`type:${baseTypeId}`);
    return entry && entry.itemKind === S.ITEM_KIND_ORE ? entry.minerals.map((p) => p[0]) : [];
  }

  function notePendingLocal(systemId) {
    if (!isId(systemId) || pendingLocal.has(systemId) || pendingLocal.size >= maxPendingLocal) return;
    pendingLocal.add(systemId);
  }

  function takePendingLocal() {
    const ids = [...pendingLocal].sort((a, b) => a - b);
    pendingLocal.clear();
    return ids;
  }

  function oreYieldsOf() {
    const out = {};
    for (const e of catalog.entries) {
      if (e.itemKind !== S.ITEM_KIND_ORE) continue;
      out[e.itemKey] = { portionSize: e.portionSize, minerals: e.minerals.map((p) => [p[0], p[1]]) };
    }
    return out;
  }

  function readGalaxy(db) {
    try {
      const open = offers.countOpenAll(db);
      if (!open || !open.ok) return null;
      const list = budgets.listBudgets(db, { limit: GALAXY_FACTIONS_LIMIT });
      if (!list || !list.ok) return null;
      return { open: open.open, factions: list.budgets.length };
    } catch (_err) {
      return null;
    }
  }

  function notePlan(factionId, plan) {
    if (!isId(factionId) || !plan || typeof plan !== "object") return;
    const created = plan.created || {};
    plans.set(factionId, Object.freeze({
      factionId,
      at: Number.isSafeInteger(plan.at) ? plan.at : null,
      tradeReason: typeof plan.tradeReason === "string" ? plan.tradeReason : null,
      created: Object.freeze({ mobilization: created.mobilization || 0, stockpile: created.stockpile || 0,
        private: created.private || 0 }),
      notes: Object.freeze({ ...(plan.notes || {}) }),
    }));
    seq += 1;
  }

  function getPlans() {
    return [...plans.values()].sort((a, b) => a.factionId - b.factionId);
  }

  function getSuppliers(factionId) {
    const cached = suppliersCache.get(factionId);
    return cached ? cached.suppliers : [];
  }

  function planOfferInTx(db, intent, ik) {
    if (state !== READY) return { ok: false, reason: "TRADE_UNAVAILABLE", detail: "stopped" };
    if (intent && intent.side === S.SIDE_SELL && T.wtsEnabled !== true) return { ok: false, reason: "WTS_DISABLED" };
    const key = `${ik}:offer`;
    return offers.createOfferInTx(db, intent, key);
  }

  function cancelOfferInTx(db, intent, ik) {
    if (state !== READY) return { ok: false, reason: "TRADE_UNAVAILABLE", detail: "stopped" };
    const key = `${ik}:cancel`;
    if (intent.from === S.OPEN) {
      if (intent.reason !== S.END_REASON_RECALLED) return { ok: false, reason: "TRADE_INVALID_INPUT", detail: "from" };
      return offers.recallOfferInTx(db, { offerId: intent.offerId, expectedVersion: intent.expectedVersion,
        at: intent.at }, key);
    }
    if (intent.from !== undefined && intent.from !== S.PLANNED) {
      return { ok: false, reason: "TRADE_INVALID_INPUT", detail: "from" };
    }
    return offers.transitionOfferInTx(db, {
      offerId: intent.offerId,
      expectedVersion: intent.expectedVersion,
      from: S.PLANNED,
      to: S.CANCELLED,
      reason: intent.reason,
      at: intent.at,
    }, key);
  }

  function getPriceCache() {
    return priceCache;
  }

  function getStationAskCache() {
    return stationAskCache;
  }

  return Object.freeze({
    getMode: () => (state === READY ? READY : "off"),
    tradeReady,
    fundFromUpkeepInTx,
    fundFromTreasuryInTx,
    readBudget: (db, factionId) => budgets.getBudget(db, factionId),
    readForReview,
    planOfferInTx,
    cancelOfferInTx,
    getPriceCache,
    getStationAskCache,
    getSuppliers,
    notePlan,
    getPlans,
    readWarPricing,
    takePendingLocal,
    count: (name, n = 1) => bump(counters, telemetry, name, n),
    noteRefusal: (reason) => {
      lastRefusal = String(reason);
      seq += 1;
    },
    getStatus: () => Object.freeze({ state, seq, counters: Object.freeze({ ...counters }), lastRefusal }),
    stop() {
      state = "stopped";
      seq += 1;
    },
    isStopped: () => state === "stopped",
  });
}

function isId(v) { return Number.isSafeInteger(v) && v > 0; }

module.exports = { createTradeService, COUNTER_NAMES };