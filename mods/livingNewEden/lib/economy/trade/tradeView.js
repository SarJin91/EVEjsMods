"use strict";

const S = require("./schema");
const { tierOf } = require("../../strategy/data/tradeTiers");
const { MINERALS_ONLY } = require("./tradeCatalog");
const VIEW_ID = "trade";
const VIEW_ORDER = 60;
const WORK_CLASS = "MAINTENANCE";
const DAY_MS = 86400000;
const FACTIONS_PER_PANEL = 64;
const RECENT_HOURS = 24;
const REGIONS_PER_PANEL = 16;
const LOCAL_STATIONS_PER_PANEL = 64;
const LOCAL_STATION_STATES = Object.freeze(["ONLINE", "ARMOR_REINFORCE", "HULL_REINFORCE"]);
const HULL_KEY_PREFIX = "group:";

const MAX_BOSSES_PER_FACTION = 4;

function call(fn, fallback) {
  try { return fn(); } catch (_err) { return fallback; }
}

function milliToIsk(milli) { return Math.floor(milli / 1000); }

function kindBucketOf(offer) {
  if (offer.itemKind === S.ITEM_KIND_ORE) return "ore";
  if (typeof offer.itemKey === "string" && offer.itemKey.startsWith(HULL_KEY_PREFIX)) return "hull";
  if (offer.itemKind === S.ITEM_KIND_MOON || offer.itemKind === S.ITEM_KIND_PI) return "commodity";
  return "mineral";
}

function walletIsk(isk) { return Math.floor(isk); }

function buildTradeView(deps) {
  const { store, budgets, offers, clock } = deps;
  const getGovernor = typeof deps.getGovernor === "function" ? deps.getGovernor : () => null;
  const names = deps.factionNames instanceof Map ? deps.factionNames : new Map();
  const capIsk = Number.isSafeInteger(deps.capIsk) && deps.capIsk > 0 ? deps.capIsk : 2000000000;
  const target = Number.isSafeInteger(deps.targetOpenContracts) ? deps.targetOpenContracts : 0;
  const tradeCfg = (deps.config && deps.config.trade) || {};
  const maxOpenPerFaction = Number.isSafeInteger(tradeCfg.maxOpenOffersPerFaction) ? tradeCfg.maxOpenOffersPerFaction : 0;
  const factionCapOf = (factions) => (target > 0
    ? Math.min(maxOpenPerFaction, Math.ceil(target / Math.max(1, factions))) : maxOpenPerFaction);
  const tiers = deps.tiers || null;
  const catalog = deps.catalog || MINERALS_ONLY;
  const priceTypeIds = catalog.priceTypeIds;

  function admitted() {
    const governor = call(getGovernor, null);
    return !governor || typeof governor.admits !== "function" || call(() => governor.admits(WORK_CLASS), true) !== false;
  }

  function getData() {
    if (call(() => store.isOpen(), false) !== true) return { available: false, reason: "STORE_CLOSED" };
    if (!admitted()) return { available: false, reason: "GOVERNOR_HOLD" };
    const localApi = typeof deps.getLocalResources === "function" ? call(deps.getLocalResources, null) : null;
    const localRows = [];
    let localTruncated = false;
    const oreOpen = [];
    const oreOpenByStation = new Map();
    const tx = store.transaction("observer.trade", (db) => {
      const read = budgets.listBudgets(db, { limit: FACTIONS_PER_PANEL });
      if (!read.ok) return { available: false, reason: String(read.reason || "TX_FAILED") };
      const st = call(() => deps.getStatus(), {}) || {};

      const factions = [];
      const orphanContracts = [];
      const graph = typeof deps.getGraph === "function" ? call(deps.getGraph, null) : null;
      const contractFactions = [];
      const bySecClass = { highsec: 0, lowsec: 0, nullsec: 0, other: 0 };
      const byRegion = new Map();
      const byTier = [1, 2, 3].map((tier) => ({ tier, open: 0, isk: 0 }));
      const byKind = { mineral: 0, ore: 0, hull: 0, commodity: 0 };
      const execWts = st.executor && st.executor.wts ? st.executor.wts : null;
      const wts = { open: 0, listed: 0, onMarket: 0, sold: 0, returned: 0, lost: 0, proceedsIsk: 0, treasuryIsk: 0, burnedIsk: 0,
        proceedsWait: execWts && Number.isSafeInteger(execWts.proceedsWait) ? execWts.proceedsWait : 0 };
      const stationsSvc = typeof deps.getStations === "function" ? call(deps.getStations, null) : null;
      const stationRepo = stationsSvc && stationsSvc.repository && typeof stationsSvc.repository.listStationsOfFaction
        === "function" ? stationsSvc.repository : null;
      for (const b of read.budgets) {
        const factionId = b.factionId;
        const factionName = names.get(factionId) || factionId;

        if (stationRepo && localApi && !localTruncated) {
          const own = call(() => stationRepo.listStationsOfFaction(db, factionId, { states: LOCAL_STATION_STATES }), null);
          for (const s of own && own.ok ? own.records : []) {
            if (localRows.length >= LOCAL_STATIONS_PER_PANEL) {
              localTruncated = true;
              break;
            }
            localRows.push({ faction: factionName, stationId: s.stationId, name: s.name, systemId: s.systemId });
          }
        }

        const budgetInfo = {
          faction: factionName,
          availableIsk: b.availableIsk,
          reservedIsk: b.reservedIsk,
          capIsk,
          headroomIsk: Math.max(0, capIsk - b.availableIsk - b.reservedIsk),
          fundedUnitsTotal: b.fundedUnitsTotal,
          fundedTotal: b.fundedTotal,
          spentTotal: b.spentTotal,
          releasedTotal: b.releasedTotal,
          lastFundedAt: b.lastFundedAt,
        };

        const openOffers = offers.listOpenOfFaction(db, factionId, 100);
        const offerRows = openOffers.ok ? openOffers.offers.map((o) => ({
          offerId: o.offerId,
          side: o.side,
          stationId: o.stationId,
          itemKey: o.itemKey,
          typeId: o.typeId,
          quantity: o.quantity,
          unitPriceIsk: milliToIsk(o.unitPriceMilli),
          iskTotal: o.iskTotal,
          state: o.state,
          expiresAt: o.expiresAt,
          version: o.version,
          refPriceIsk: milliToIsk(o.refPriceMilli),
          capPriceIsk: o.capPriceMilli ? milliToIsk(o.capPriceMilli) : null,
          priceSource: o.priceSource,
          contractId: o.contractId || null,
          acceptorCharacterId: o.acceptorCharacterId || null,
          assigneeCharacterId: o.assigneeCharacterId || null,
          standingBonusPermille: o.standingBonusPermille || 0,
          deliveredQuantity: o.deliveredQuantity || 0,
          channel: o.channel || "contract",
          marketOrderId: o.marketOrderId || null,
          filledQuantity: o.filledQuantity || 0,
        })) : [];
        if (openOffers.ok) {
          const ft = [0, 0, 0];
          const buyOffers = openOffers.offers.filter((o) => o.side !== S.SIDE_SELL);
          for (const o of openOffers.offers) {
            if (o.side !== S.SIDE_SELL) continue;
            wts.open += 1;
            if (o.state === S.OPEN) wts.listed += 1;
            if (o.channel === S.CHANNEL_MARKET) wts.onMarket += 1;
          }
          if (tiers) {
            for (const o of buyOffers) {
              const t = tierOf(o.iskTotal, tiers);
              ft[t - 1] += 1;
              byTier[t - 1].open += 1;
              byTier[t - 1].isk += o.iskTotal;
            }
          }
          contractFactions.push({ faction: factionName, open: openOffers.offers.length, tiers: ft });
          for (const o of openOffers.offers) {
            if (o.side === S.SIDE_SELL) {
            } else {
              const bucket = kindBucketOf(o);
              byKind[bucket] += 1;
              if (bucket === "ore") {
                oreOpen.push({ systemId: o.systemId, baseTypeId: o.typeId });
                oreOpenByStation.set(o.stationId, (oreOpenByStation.get(o.stationId) || 0) + 1);
              }
            }
            const v = graph && typeof graph.getSystem === "function" ? call(() => graph.getSystem(o.systemId), null) : null;
            const sec = v && Object.prototype.hasOwnProperty.call(bySecClass, v.secClass) ? v.secClass : "other";
            bySecClass[sec] += 1;
            if (v && Number.isSafeInteger(v.regionId)) {
              const name = typeof graph.getRegionName === "function" ? call(() => graph.getRegionName(v.regionId), null) : null;
              const label = name || v.regionId;
              byRegion.set(label, (byRegion.get(label) || 0) + 1);
            }
          }
        }

        const since = clock.now() - RECENT_HOURS * 3600000;
        const recentOffers = offers.listRecent(db, { factionId, since, limit: 50 });
        for (const o of recentOffers.ok ? recentOffers.offers : []) {
          if (o.side !== S.SIDE_SELL) continue;
          if (o.state === S.DELIVERED) wts.sold += 1;
          else if (o.state === S.CANCELLED) wts.returned += 1;
          else if (o.state === S.LOST) wts.lost += 1;
        }
        wts.proceedsIsk += b.wtsProceedsTotal || 0;
        wts.treasuryIsk += b.wtsTreasuryTotal || 0;
        wts.burnedIsk += b.wtsBurnedTotal || 0;
        const recentRows = recentOffers.ok ? recentOffers.offers.map((o) => ({
          offerId: o.offerId,
          side: o.side,
          stationId: o.stationId,
          itemKey: o.itemKey,
          typeId: o.typeId,
          quantity: o.quantity,
          unitPriceIsk: milliToIsk(o.unitPriceMilli),
          iskTotal: o.iskTotal,
          state: o.state,
          endReason: o.endReason,
          endedAt: o.endedAt,
        })) : [];

        const sumReserved = offers.sumOpenReserved(db, factionId);
        const sumOpenIsk = sumReserved.ok ? sumReserved.total : 0;
        const mismatch = b.reservedIsk !== sumOpenIsk;

        const issuingOffers = openOffers.ok ? openOffers.offers.filter((o) => o.state === S.ISSUING) : [];
        const sumIssuingIsk = issuingOffers.reduce((acc, o) => acc + o.iskTotal, 0);
        const walletMismatch = b.reservedIsk !== sumOpenIsk || b.reservedIsk !== sumIssuingIsk;

        const priceCache = deps.getPriceCache ? deps.getPriceCache() : null;
        const priceCacheStatus = priceCache ? priceCache.getStatus() : { entries: 0, source: "none", newestAt: null };
        const priceCachePrices = {};
        if (priceCache) {
          for (const typeId of priceTypeIds) {
            const refs = priceCache.peek(typeId, clock.now());
            if (refs) priceCachePrices[`type:${typeId}`] = refs;
          }
        }

        const suppliers = typeof deps.getSuppliers === "function" ? call(() => deps.getSuppliers(factionId), []) : [];
        const supplierRows = (Array.isArray(suppliers) ? suppliers : []).map((s) => ({
          characterId: s.characterId,
          standingMilli: s.standingMilli,
          bonusPermille: s.bonusPermille,
          rejectedAt: s.rejectedAt || null,
        }));

        const listTaggedRes = offers.listTaggedContracts ? offers.listTaggedContracts(db, { factionId, limit: 20 }) : { ok: true, contracts: [] };
        if (listTaggedRes.ok) {
          for (const c of listTaggedRes.contracts) {
            const offerRes = offers.findByContractId ? offers.findByContractId(db, c.contractId) : { ok: true, offer: null };
            const isOrphan = !offerRes.offer || S.TERMINAL_OFFER_STATES.includes(offerRes.offer.state);
            if (isOrphan && (!offerRes.offer || offerRes.offer.state !== S.ISSUING)) {
              orphanContracts.push({
                contractId: c.contractId,
                offerId: c.offerId,
                reward: c.reward,
              });
            }
          }
        }

        let issuerRows = [];
        const getVC = deps.getVirtualCorps;
        if (typeof getVC === "function") {
          const vc = getVC();
          if (vc && typeof vc.listTradeIssuers === "function" && typeof vc.nameOf === "function") {
            const issuersRes = vc.listTradeIssuers(factionId);
            if (issuersRes && issuersRes.ok && issuersRes.issuers) {
              for (const iss of issuersRes.issuers.slice(0, MAX_BOSSES_PER_FACTION)) {
                let transitBalance = null;
                const adapter = deps.adapter;
                if (adapter && typeof adapter.tradeReadCharacterWallet === "function") {
                  const walletRes = adapter.tradeReadCharacterWallet(iss.characterId);
                  if (walletRes && walletRes.ok && walletRes.balanceIsk !== null) {
                    transitBalance = walletIsk(walletRes.balanceIsk);
                  }
                }
                let openCount = 0;
                if (offers.countOpenByIssuer) {
                  const countsRes = offers.countOpenByIssuer(db, factionId);
                  if (countsRes.ok) openCount = countsRes.counts.get(iss.characterId) || 0;
                }
                issuerRows.push({
                  slot: iss.slot,
                  corporation: vc.nameOf(iss.corporationId) || String(iss.corporationId),
                  characterId: iss.characterId,
                  openOffers: openCount,
                  transitBalanceIsk: transitBalance,
                });
              }
            }
          }
        }

        const row = {
          ...budgetInfo,
          offers: offerRows,
          recentOffers: recentRows,
          reservedMismatch: mismatch,
          walletMismatch,
          priceCache: { ...priceCacheStatus, prices: priceCachePrices },
          privateOffers: { suppliers: supplierRows },
          virtualIssuers: issuerRows,
        };
        const war = typeof deps.readWarPricing === "function" ? call(() => deps.readWarPricing(factionId), null) : null;
        if (war && war.ok && war.found) row.war = { pressurePermille: war.pressurePermille, at: war.at };
        factions.push(row);
      }

      let marketRefundBalances = [];
      let marketLastSweep = null;
      let marketOrphans = 0;
      const adapter = deps.adapter;
      if (adapter && typeof adapter.tradeReadWallet === "function") {
        const marketCorpsRes = offers.listMarketCorporations ? offers.listMarketCorporations(db) : { ok: true, corporationIds: [] };
        if (marketCorpsRes.ok && marketCorpsRes.corporationIds) {
          for (const corpId of marketCorpsRes.corporationIds) {
            const walletRes = adapter.tradeReadWallet(corpId, deps.config?.trade?.buyOrderWalletAccountKey || 1005);
            if (walletRes && walletRes.ok && walletRes.balanceIsk !== null) {
              marketRefundBalances.push({
                corporationId: corpId,
                balanceIsk: walletIsk(walletRes.balanceIsk),
              });
            }
          }
        }
        const execStatus = st.executor;
        if (execStatus && execStatus.marketOrphanScan) {
          marketLastSweep = execStatus.marketOrphanScan.lastScanAt || null;
        }
        if (st.counters && typeof st.counters.marketOrphans === "number") {
          marketOrphans = st.counters.marketOrphans;
        }
      }

      const privateOffersGate = st.privateOffers || { gate: "off", reason: "disabled" };

      const counted = typeof offers.countOpenAll === "function" ? offers.countOpenAll(db) : null;
      const plans = typeof deps.getPlans === "function" ? call(deps.getPlans, []) : [];
      const contracts = {
        target: target,
        open: counted && counted.ok ? counted.open : null,
        listed: counted && counted.ok ? counted.listed : null,
        tiers,
        byTier: tiers ? byTier : null,
        lotMaxIsk: Number.isSafeInteger(tradeCfg.publicLotMaxIsk) ? tradeCfg.publicLotMaxIsk : null,
        byFaction: contractFactions.map((x) => ({ ...x, cap: factionCapOf(read.budgets.length) })),
        bySecClass,
        byKind,
        byLocality: null,
        wts,
        byRegion: [...byRegion].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
          .slice(0, REGIONS_PER_PANEL),
        plans: (Array.isArray(plans) ? plans : []).map((p) => ({ faction: names.get(p.factionId) || p.factionId,
          at: p.at, tradeReason: p.tradeReason, created: p.created, notes: p.notes })),
      };

      return {
        available: true,
        state: st.state || null,
        lastRefusal: st.lastRefusal || null,
        counters: st.counters || null,
        executor: st.executor || null,
        priceRefresh: (st.executor && st.executor.prices) || null,
        externalPrices: st.externalPrices || null,
        catalog: { ...catalog.summary, efficiencyPermille: Number.isSafeInteger(tradeCfg.oreRefineEfficiencyPermille)
          ? tradeCfg.oreRefineEfficiencyPermille : null },
        standing: st.standing || null,
        privateOffers: { gate: privateOffersGate.gate, reason: privateOffersGate.reason },
        market: {
          refundBalances: marketRefundBalances,
          lastSweepAt: marketLastSweep,
          orphans: marketOrphans,
        },
        contracts,
        factions,
        orphans: orphanContracts,
      };
    });
    if (!tx.ok) return { available: false, reason: String((tx.value && tx.value.reason) || "TX_FAILED") };
    if (tx.value && tx.value.available === true) {
      if (tx.value.contracts) tx.value.contracts.byLocality = byLocalityOf(localApi, oreOpen);
      tx.value.local = buildLocal(localApi, localRows, localTruncated, oreOpenByStation);
    }
    return tx.value;
  }

  function byLocalityOf(localApi, ores) {
    const out = { local: 0, near: 0, unknown: 0 };
    if (ores.length === 0) return out;
    const ids = [...new Set(ores.map((o) => o.systemId))];
    const views = localApi ? call(() => localApi.localResourcesFor(ids, { read: false }), null) : null;
    for (const o of ores) {
      const v = views instanceof Map ? views.get(o.systemId) : null;
      const hit = v && Array.isArray(v.ores) ? v.ores.find((x) => x.baseTypeId === o.baseTypeId) : null;
      if (hit && hit.distance === 0) out.local += 1;
      else if (hit && Number.isSafeInteger(hit.distance) && hit.distance > 0) out.near += 1;
      else out.unknown += 1;
    }
    return out;
  }

  function buildLocal(localApi, rows, truncated, oreOpenByStation) {
    const oreCount = (stationId) => (oreOpenByStation instanceof Map ? oreOpenByStation.get(stationId) || 0 : 0);
    const st = call(() => deps.getStatus(), {}) || {};
    if (!localApi) {
      const off = st.localResources || { state: "off", reason: "off" };
      return { state: off.state || "off", reason: off.reason || null, graphReady: false, jumps: null,
        includeAnomalies: false, cached: 0, warm: null, lastRefusal: null, drift: [], stations: [], truncated: false };
    }
    const views = call(() => localApi.localResourcesFor(rows.map((r) => r.systemId), { read: true }), null);
    const status = call(() => localApi.getStatus(), {}) || {};
    return {
      state: status.state || "off",
      reason: status.reason || null,
      graphReady: status.graphReady === true,
      jumps: Number.isSafeInteger(status.jumps) ? status.jumps : null,
      includeAnomalies: status.includeAnomalies === true,
      cached: Number.isSafeInteger(status.cached) ? status.cached : 0,
      warm: status.warm || null,
      lastRefusal: status.lastRefusal || null,
      drift: Array.isArray(status.drift) ? status.drift : [],
      stations: views instanceof Map ? rows.map((r) => {
        const v = views.get(r.systemId) || null;
        return { faction: r.faction, stationId: r.stationId, name: r.name, systemId: r.systemId,
          beltCount: v ? v.beltCount : null, poolSource: v ? v.poolSource : null, pending: v ? v.pending : true,
          unknownTypeIds: v ? v.unknownTypeIds : 0,
          ores: v ? v.ores.map((o) => ({ baseTypeId: o.baseTypeId, family: o.family, distance: o.distance, source: o.source })) : [],
          ice: v ? v.ice.map((i) => ({ typeId: i.typeId, name: i.name, distance: i.distance })) : [],
          anomaly: v ? v.anomaly : null,
          oreOffersOpen: oreCount(r.stationId) };
      }) : [],
      truncated,
    };
  }

  function cacheKey() {
    if (call(() => store.isOpen(), false) !== true || !admitted()) return null;
    const st = call(() => deps.getStatus(), {}) || {};
    const priceSeq = st.executor && st.executor.prices && Number.isSafeInteger(st.executor.prices.seq) ? st.executor.prices.seq : 0;
    const ext = st.externalPrices || {};
    const extSeq = (Number.isSafeInteger(ext.seq) ? ext.seq : 0) + (Number.isSafeInteger(ext.failed) ? ext.failed : 0);
    const local = st.localResources || {};
    const localSeq = Number.isSafeInteger(local.seq) ? local.seq : 0;
    const wtsWait = st.executor && st.executor.wts && Number.isSafeInteger(st.executor.wts.proceedsWait)
      ? st.executor.wts.proceedsWait : 0;
    return `t${budgets.getChangeCount()}|${st.seq === undefined ? 0 : st.seq}|p${priceSeq}|e${extSeq}`
      + `|${Math.floor(clock.now() / DAY_MS)}|l${localSeq}` + (wtsWait > 0 ? `|w${wtsWait}` : "");
  }

  return { title: "Faction trade", order: VIEW_ORDER, cacheKey, getData };
}

module.exports = { VIEW_ID, buildTradeView, kindBucketOf };