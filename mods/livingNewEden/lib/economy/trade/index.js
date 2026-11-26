"use strict";

const { isModuleEnabled, contractLimitNotes } = require("../../../config");
const { createBudgetRepository } = require("./budgetRepository");
const { createOfferRepository } = require("./offerRepository");
const { createTradeService } = require("./tradeService");
const { createTradeExecutor } = require("./tradeExecutor");
const { createStationAskDrain } = require("./stationAskCache");
const { sellSeamsOk } = require("./sellSteps");
const { validateBuyOrderConfig } = require("./marketRules");
const { createDeliveryStanding } = require("./deliveryStanding");
const S = require("./schema");
const { VIEW_ID, buildTradeView } = require("./tradeView");
const { tierCfgOf } = require("../../strategy/data/tradeTiers");
const path = require("node:path");
const { isInside } = require("../../util/paths");
const { createExternalPrices } = require("./externalPrices");
const { createLocalResources } = require("./localResources");
const ORE_TYPES_DATA = require("../data/oreTypes");
const HULL_TRADE_TYPES_DATA = require("../data/hullTradeTypes");
const HULL_RECIPES_DATA = require("../data/hullRecipes");
const { buildTradeCatalog, oreCandidates, commodityCandidates } = require("./tradeCatalog");
const COMMODITIES_DATA = require("../data/commodities");
const FACTS_CHUNK = 64;
const { performance } = require("node:perf_hooks");
const { defaultSetTimer } = require("../../presence/poller");
const { createSegmentMeter } = require("../../telemetry/segmentMeter");

const LOCAL_WARM_TX = "trade.localWarm";

const EXTERNAL_PRICES_DIR = "trade";
const EXTERNAL_PRICES_FILE = "external-prices.json";

function messageOf(err) {
  return String((err && err.message) || err);
}

function swallow(fn) {
  try { fn(); } catch (_err) {}
}

function createUnavailableTrade(reason, detail) {
  const off = Object.freeze({ ready: false, reason: "TRADE_OFF", headroomIsk: 0 });
  const status = Object.freeze({ state: "off", reason: String(reason) });
  const emptyReview = Object.freeze({ ok: true, trade: { mode: "off", budget: null } });
  const refuse = () => Object.freeze({ ok: false, reason: String(reason), ...(detail ? { detail: String(detail) } : {}) });
  return Object.freeze({
    getMode: () => "off",
    tradeReady: () => off,
    fundFromUpkeepInTx: refuse,
    fundFromTreasuryInTx: refuse,
    readBudget: refuse,
    readForReview: () => emptyReview,
    planOfferInTx: refuse,
    cancelOfferInTx: refuse,
    getPriceCache: () => null,
    localResourcesFor: () => null,
    notePlan() {},
    getPlans: () => [],
    readWarPricing: refuse,
    count() {},
    noteRefusal() {},
    getStatus: () => status,
    stop() {},
    nudge() {},
    checkTradeSeams: () => ({ ok: false, reason: "TRADE_SEAM_UNAVAILABLE", missing: ["service_off"] }),
  });
}

function universeGraphOf(getGraph) {
  if (typeof getGraph !== "function") return null;
  try {
    const facade = getGraph();
    const r = facade && typeof facade.getGraph === "function" ? facade.getGraph() : null;
    return r && r.ok === true && r.graph ? r.graph : null;
  } catch (_err) {
    return null;
  }
}

function marketReadiness(wanted, adapter, tradeCfg) {
  if (!wanted) return Object.freeze({ ready: false, reason: tradeCfg.buyOrdersEnabled === true ? "mode" : "disabled" });
  try {
    const seams = adapter && typeof adapter.checkTradeMarketSeams === "function" ? adapter.checkTradeMarketSeams() : null;
    if (!seams || seams.ok !== true) {
      const missing = seams && Array.isArray(seams.missing) ? ` ${seams.missing.join(",")}` : "";
      return Object.freeze({ ready: false, reason: `${(seams && seams.reason) || "TRADE_MARKET_SEAM_UNAVAILABLE"}${missing}` });
    }
    const cfg = validateBuyOrderConfig(tradeCfg);
    if (!cfg.ok) return Object.freeze({ ready: false, reason: `${cfg.reason} ${cfg.detail}` });
    if (typeof adapter.tradeMarketDurationAllowed !== "function"
      || adapter.tradeMarketDurationAllowed(tradeCfg.buyOrderDurationDays) !== true) {
      return Object.freeze({ ready: false, reason: "BUY_ORDER_DURATION_NOT_ALLOWED" });
    }
    return Object.freeze({ ready: true, reason: null });
  } catch (err) {
    return Object.freeze({ ready: false, reason: `MARKET_CHECK_THREW ${messageOf(err)}` });
  }
}

function readFactionNames(adapter) {
  if (!adapter || typeof adapter.readFactionNames !== "function") return new Map();
  try {
    const r = adapter.readFactionNames();
    return r && r.ok && r.names instanceof Map ? r.names : new Map();
  } catch (_err) {
    return new Map();
  }
}

function buildCatalog(adapter, tradeCfg, logger) {
  const candidates = oreCandidates(ORE_TYPES_DATA);
  let factsRead = null;
  if (candidates !== null && candidates.take.length > 0 && adapter && typeof adapter.readItemTypeFacts === "function") {
    try {
      factsRead = adapter.readItemTypeFacts(candidates.take);
    } catch (err) {
      factsRead = { ok: false, reason: "ITEM_TYPES_FAILED", detail: messageOf(err) };
    }
    if (!factsRead || typeof factsRead !== "object") factsRead = { ok: false, reason: "ITEM_TYPES_FAILED" };
  }
  const commodityOffersEnabled = tradeCfg.commodityOffersEnabled === true;
  const commodities = commodityOffersEnabled
    ? commodityCandidates(COMMODITIES_DATA, tradeCfg.maxCommodityTypes) : null;
  const commodityFacts = commodities === null ? null : commodities.take.length === 0 ? { ok: true, facts: new Map() }
    : readFactsInChunks(adapter, commodities.take.map((c) => c.typeId));
  const catalog = buildTradeCatalog({ oreTypes: ORE_TYPES_DATA, factsRead,
    oreOffersEnabled: tradeCfg.oreOffersEnabled !== false,
    hullTypes: HULL_TRADE_TYPES_DATA, hullRecipes: HULL_RECIPES_DATA,
    hullOffersEnabled: tradeCfg.hullOffersEnabled !== false,
    commodities, commodityFacts, commodityOffersEnabled });
  const s = catalog.summary;
  logger.log(`trade: catalog minerals=${s.minerals} ores=${s.ores} state=${s.oreState}`
    + `${s.oreReason ? ` reason=${s.oreReason}` : ""}${s.missing.length > 0 ? ` missing=${s.missing.join(",")}` : ""}`
    + `${s.truncated.length > 0 ? ` truncated=${s.truncated.length}` : ""}`
    + ` hulls=${s.hulls} hullState=${s.hullState}`
    + `${s.hullFallbacks.length > 0 ? ` hullFallbacks=${s.hullFallbacks.length}` : ""}`
    + `${s.hullTruncated.length > 0 ? ` hullTruncated=${s.hullTruncated.length}` : ""}`
    + ` commodities=${s.commodities} commodityState=${s.commodityState}`
    + `${s.commodityMissing.length > 0 ? ` commodityMissing=${s.commodityMissing.length}` : ""}`
    + `${s.commodityTruncated.length > 0 ? ` commodityTruncated=${s.commodityTruncated.length}` : ""}`);
  return catalog;
}

function readFactsInChunks(adapter, typeIds) {
  if (!adapter || typeof adapter.readItemTypeFacts !== "function") return null;
  const facts = new Map();
  for (let i = 0; i < typeIds.length; i += FACTS_CHUNK) {
    let r;
    try {
      r = adapter.readItemTypeFacts(typeIds.slice(i, i + FACTS_CHUNK));
    } catch (err) {
      return { ok: false, reason: "ITEM_TYPES_FAILED", detail: messageOf(err) };
    }
    if (!r || r.ok !== true || !(r.facts instanceof Map)) {
      return { ok: false, reason: String((r && r.reason) || "ITEM_TYPES_FAILED") };
    }
    for (const [typeId, fact] of r.facts) facts.set(typeId, fact);
  }
  return { ok: true, facts };
}

function startTrade(deps) {
  let deliveryStanding = null;
  let standingUnregister = null;
  let standingStopped = false;
  let standingReason = null;
  let externalPrices = null;
  let localRes = null;

  try {
    const { config, persistence, clock, ids, adapter, getStations } = deps || {};

    const tradeCfg = config.trade || {};
    const tradeEnabled = config.trade && config.trade.enabled === true;
    const stationsEnabled = config.stations && config.stations.enabled === true;
    const strategyEnabled = isModuleEnabled(config, "strategy");
    const contractsEnabled = tradeCfg.contractsEnabled !== false;
    const cleanupOnDisable = tradeCfg.cleanupOnDisable === true;
    const buyOrdersEnabled = tradeCfg.buyOrdersEnabled === true;

    if (!strategyEnabled) {
      return { ok: true, trade: createUnavailableTrade("TRADE_DISABLED", "strategy_disabled") };
    }

    let mode;
    let needsExecutor = false;

    if (!tradeEnabled) {
      if (cleanupOnDisable) {
        if (!persistence || persistence.ok !== true || !persistence.store || !persistence.journal) {
          return { ok: false, reason: "dependency_disabled:persistence" };
        }
        if (!clock || typeof clock.now !== "function") return { ok: false, reason: "TRADE_START_FAILED", detail: "clock" };
        mode = "cleanup";
        needsExecutor = true;
      } else {
        const hasPersistence = persistence && typeof persistence === "object" && persistence.ok === true && persistence.store && persistence.journal;
        if (!hasPersistence) {
          return { ok: false, reason: "disabled_by_config" };
        }
        if (!clock || typeof clock.now !== "function") return { ok: false, reason: "TRADE_START_FAILED", detail: "clock" };
        return { ok: true, trade: createUnavailableTrade("TRADE_OFF", "disabled_by_config") };
      }
    } else {
      if (!stationsEnabled) {
        return { ok: false, reason: "disabled_by_config" };
      }

      if (!persistence || persistence.ok !== true || !persistence.store || !persistence.journal) {
        return { ok: false, reason: "dependency_disabled:persistence" };
      }
      if (!clock || typeof clock.now !== "function") return { ok: false, reason: "TRADE_START_FAILED", detail: "clock" };

      if (!contractsEnabled && !buyOrdersEnabled) {
        mode = "run-no-contracts";
      } else {
        mode = "run";
        needsExecutor = true;
      }
    }

    if (!ids || typeof ids.next !== "function") return { ok: false, reason: "TRADE_START_FAILED", detail: "ids" };
    const effectiveIds = ids;
    const logger = deps.logger && typeof deps.logger.log === "function" ? deps.logger : { log() {} };
    const store = persistence.store;

    const catalog = buildCatalog(adapter, tradeCfg, logger);
    if (mode === "run" && contractsEnabled) {
      for (const note of contractLimitNotes(config).trade) logger.log(`trade: ${note}`);
    }

    const budgets = createBudgetRepository({ journal: persistence.journal, clock });
    const getStockRepository = () => {
      const st = typeof getStations === "function" ? getStations() : null;
      const mode = st && typeof st.getMode === "function" ? st.getMode() : "off";
      return mode === "ready" && st.repository ? st.repository : null;
    };
    const offers = createOfferRepository({ journal: persistence.journal, budgets, ids: effectiveIds, clock, catalog,
      getStockRepository });

    let readStanding = null;
    let privateOffersGate = "off";
    let privateOffersReason = "disabled";
    const privateOffersEnabled = config.trade && config.trade.privateOffersEnabled === true;
    const tradeModeIsRun = mode === "run";
    if (privateOffersEnabled && tradeModeIsRun && adapter) {
      if (typeof adapter.readCharacterStanding === "function" && typeof adapter.checkStandingRead === "function") {
        const checkRead = adapter.checkStandingRead();
        if (checkRead && checkRead.ok === true) {
          readStanding = adapter.readCharacterStanding;
          privateOffersGate = "on";
          const { tiersFromConfig } = require("./standingTiers");
          const tiersResult = tiersFromConfig(config.trade);
          const feeRes = typeof adapter.tradePrivateContractFee === "function" ? adapter.tradePrivateContractFee() : null;
          if (!tiersResult.ok) {
            privateOffersGate = "off";
            privateOffersReason = "tiers_invalid";
            logger.log(`trade: private offers off - ${tiersResult.reason}`);
          } else if (!feeRes || feeRes.ok !== true) {
            privateOffersGate = "off";
            privateOffersReason = "fee_unknown";
            readStanding = null;
            logger.log(`trade: private offers off - fee_unknown ${feeRes ? `${feeRes.reason || ""} ${feeRes.detail || ""}`.trim() : "seam missing"}`);
          } else {
            privateOffersReason = "ok";
            logger.log(`trade: private offers on tiers=${JSON.stringify(tiersResult.tiers.map(t => `${t.minMilli}:${t.bonusPermille}`).join(","))}`);
          }
        } else {
          privateOffersReason = "seam_unavailable";
          logger.log(`trade: private offers off - standing read seam unavailable`);
        }
      } else {
        privateOffersReason = "adapter_missing";
        logger.log(`trade: private offers off - adapter missing readCharacterStanding/checkStandingRead`);
      }
    } else if (privateOffersEnabled) {
      if (!tradeModeIsRun) privateOffersReason = "mode_not_run";
      else if (!adapter) privateOffersReason = "no_adapter";
      logger.log(`trade: private offers off - ${privateOffersReason}`);
    }

    const service = createTradeService({ budgets, offers, config, clock, telemetry: deps.telemetry || null, logger, readStanding,
      catalog, oreTypes: ORE_TYPES_DATA, getLocalResources: () => localRes,
      getExtraction: typeof deps.getExtraction === "function" ? deps.getExtraction : null,
      sellSeamsOk: () => mode === "run" && sellSeamsOk(adapter) });
    const priceCache = service.getPriceCache();
    const factionNames = readFactionNames(adapter);

    if (needsExecutor) {
      if (!adapter || typeof adapter.checkTradeSeams !== "function") {
        logger.log("trade: adapter missing checkTradeSeams");
        return { ok: false, reason: "TRADE_SEAM_UNAVAILABLE", detail: { ok: false, reason: "TRADE_SEAM_UNAVAILABLE", missing: ["checkTradeSeams"] } };
      }
      const seamCheck = adapter.checkTradeSeams();
      if (!seamCheck.ok) {
        logger.log(`trade: seams unavailable - ${seamCheck.reason} ${seamCheck.missing?.join(", ") || ""}`);
        return { ok: false, reason: "TRADE_SEAM_UNAVAILABLE", detail: seamCheck };
      }
    }

    const standingEnabled = config.trade && config.trade.standingGrantEnabled === true;
    const hasScheduler = deps.scheduler && typeof deps.scheduler.registerHandler === "function" && typeof deps.scheduler.enqueue === "function";
    const hasStandingSeam = adapter && typeof adapter.applyStandingGrant === "function" && typeof adapter.checkStandingWrite === "function";
    let standingWriteOk = false;
    if (hasStandingSeam) {
      const writeCheck = adapter.checkStandingWrite();
      standingWriteOk = writeCheck && writeCheck.ok === true;
    }
    let standingReadOk = false;
    if (standingEnabled && adapter && typeof adapter.readCharacterStanding === "function"
      && typeof adapter.checkStandingRead === "function") {
      const readCheck = adapter.checkStandingRead();
      standingReadOk = Boolean(readCheck && readCheck.ok === true);
    }

    const maxRowsConfig = config.persistence && config.persistence.maxRowsPerTransaction;

    if (standingEnabled && needsExecutor && hasScheduler && standingWriteOk && standingReadOk) {
      const maxRows = maxRowsConfig || 1000;
      deliveryStanding = createDeliveryStanding({
        journal: persistence.journal,
        scheduler: deps.scheduler,
        adapter,
        clock,
        config,
        maxRows,
        factionNames,
        getNotices: typeof deps.getNotices === "function" ? deps.getNotices : () => null,
        telemetry: deps.telemetry || null,
        logger,
      });
      try {
        const reg = deps.scheduler.registerHandler(S.EVENT_STANDING_GRANT, deliveryStanding.handler, {
          maxPerPass: tradeCfg.standingMaxGrantsPerPass || 10,
        });
        if (reg && reg.ok) {
          standingUnregister = reg.unregister;
          logger.log(`trade: delivery standing on per01=${tradeCfg.standingIskPer01} growth=${tradeCfg.standingGrowthPermille}`
            + ` day=${tradeCfg.standingDailyCap} window=${tradeCfg.standingWindowCap}/${tradeCfg.standingWindowDays}`
            + ` ceil=${tradeCfg.standingCeiling}`);
        } else {
          standingReason = `REGISTER_FAILED:${(reg && reg.reason) || "no_result"}`;
          deliveryStanding.stop();
          deliveryStanding = null;
        }
      } catch (err) {
        standingReason = `REGISTER_EXCEPTION:${messageOf(err)}`;
        deliveryStanding?.stop();
        deliveryStanding = null;
      }
    } else if (standingEnabled) {
      if (!hasScheduler) standingReason = "SCHEDULER_UNAVAILABLE";
      else if (!standingWriteOk) standingReason = "STANDING_SEAM_UNAVAILABLE";
      else if (!standingReadOk) standingReason = "STANDING_READ_UNAVAILABLE";
      else standingReason = "DISABLED";
      logger.log(`trade: delivery standing off - ${standingReason}`);
    }

    let externalStub = Object.freeze({ state: "off", reason: "disabled" });
    if (tradeCfg.externalPriceEnabled === true) {
      if (mode !== "run") {
        externalStub = Object.freeze({ state: "off", reason: "mode_not_run" });
      } else if (!adapter || typeof adapter.fetchExternalPrices !== "function") {
        externalStub = Object.freeze({ state: "off", reason: "no_seam" });
      } else {
        const dir = typeof config.dataDir === "string" && config.dataDir !== ""
          ? path.join(config.dataDir, EXTERNAL_PRICES_DIR) : null;
        const inModDir = dir !== null && typeof deps.modDir === "string" && deps.modDir !== ""
          && isInside(deps.modDir, dir);
        const filePath = dir !== null && !inModDir ? path.join(dir, EXTERNAL_PRICES_FILE) : null;
        const commodityKinds = catalog.commodityKinds || {};
        const requiredTypeIds = tradeCfg.commodityOffersEnabled === true && tradeCfg.commodityBasePriceEnabled === true
          ? catalog.priceTypeIds.filter((t) => Object.prototype.hasOwnProperty.call(commodityKinds, `type:${t}`)) : [];
        externalPrices = createExternalPrices({ adapter, config, clock, filePath, typeIds: catalog.priceTypeIds,
          telemetry: deps.telemetry || null, logger, ...(requiredTypeIds.length > 0 ? { requiredTypeIds } : {}) });
        externalPrices.load(clock.now());
        logger.log(`trade: external prices on (fuzzwork station=${config.trade.externalPriceStationId}`
          + ` file=${filePath === null ? (inModDir ? "in_mod_dir" : "no_data_dir") : filePath})`);
      }
      if (externalPrices === null) logger.log(`trade: external prices off - ${externalStub.reason}`);
    }

    let localStub;
    if (tradeCfg.localResourcesEnabled === false) localStub = Object.freeze({ state: "off", reason: "disabled" });
    else if (mode !== "run" && mode !== "run-no-contracts") localStub = Object.freeze({ state: "off", reason: "mode_cleanup" });
    else if (!adapter || typeof adapter.readLocalResources !== "function") {
      localStub = Object.freeze({ state: "off", reason: "no_seam" });
    } else {
      localStub = null;
      localRes = createLocalResources({ readLocalResources: (ids, families) => adapter.readLocalResources(ids, families),
        oreTypes: ORE_TYPES_DATA, getGraph: () => universeGraphOf(deps.getGraph), config, clock,
        telemetry: deps.telemetry || null, logger });
    }
    let localWarm = Object.freeze({ state: localRes ? "pending" : "skipped", reason: localRes ? null : "off" });
    const localStatus = () => (localRes ? Object.freeze({ ...localRes.getStatus(), warm: localWarm }) : localStub);
    const localApi = () => (localRes ? { localResourcesFor: localRes.localResourcesFor, getStatus: localStatus } : null);
    const localDrain = () => {
      if (!localRes) return;
      const ids = service.takePendingLocal();
      if (ids.length > 0) localRes.localResourcesFor(ids, { read: true });
    };
    const stationAskDrainOf = (ad) => createStationAskDrain({ T: tradeCfg, cache: service.getStationAskCache(),
      readStationAsks: ad && typeof ad.readStationAsks === "function" ? (spec) => ad.readStationAsks(spec) : null,
      clock, count: (name, n) => service.count(name, n) });

    const market = marketReadiness(needsExecutor && mode === "run" && buyOrdersEnabled, adapter, tradeCfg);
    if (buyOrdersEnabled) logger.log(`trade: buy orders ${market.ready ? "on" : `off - ${market.reason}`}`);

    let executor = null;
    const getVirtualCorps = deps.getVirtualCorps || (() => null);
    if (needsExecutor && adapter && budgets && offers && priceCache) {
      const telemetry = deps.telemetry || null;
      const meter = createSegmentMeter({
        nowMs: () => performance.now(),
        onSegment: (label, at, ms) => {
          if (!telemetry || typeof telemetry.noteOp !== "function") return;
          try {
            telemetry.noteOp("trade", label, at, ms);
          } catch (_err) {
          }
        },
      });
      const metered = meter.wrapFacade(adapter);
      executor = createTradeExecutor({
        store,
        journal: persistence.journal,
        offers,
        budgets,
        getStations: getStations || (() => null),
        adapter: metered,
        priceCache,
        config,
        clock,
        mode: mode === "run" ? "run" : "cleanup",
        getGovernor: deps.getGovernor,
        factionNames,
        telemetry: deps.telemetry || null,
        logger,
        deliveryStanding,
        getVirtualCorps,
        getRegistry: typeof deps.getRegistry === "function" ? deps.getRegistry : null,
        getTreasury: typeof deps.getTreasury === "function" ? deps.getTreasury : null,
        externalPrices,
        catalog,
        localDrain,
        stationAskDrain: stationAskDrainOf(metered),
        market,
        setTimer: meter.wrapTimer(typeof deps.setTimer === "function" ? deps.setTimer : defaultSetTimer),
      });
    }

    let hookInstalled = false;
    let hookReason = null;
    let hooksTouched = false;

    let viewHandle = null;
    const fullStatus = () => {
      const base = service.getStatus();
      const execStatus = executor ? executor.getStatus() : null;
      const standingStatus = deliveryStanding ? deliveryStanding.getStatus() : { state: standingReason || "disabled" };
      return Object.freeze({ ...base, view: viewHandle !== null, executor: execStatus, mode,
        acceptHook: hookInstalled ? "installed" : (hookReason || "off"),
        standing: standingStatus,
        privateOffers: { gate: privateOffersGate, reason: privateOffersReason },
        externalPrices: externalPrices ? externalPrices.getStatus() : externalStub,
        localResources: localStatus(),
        stationAsks: service.getStationAskCache().getStatus(),
        catalog: catalog.summary,
        market: Object.freeze({ ready: market.ready, reason: market.reason,
          down: Boolean(execStatus && execStatus.market && execStatus.market.down) }) });
    };
    const views = deps.views;
    if (views && typeof views.registerView === "function") {
      const r = views.registerView(VIEW_ID, buildTradeView({ store, budgets, offers, clock, getStatus: fullStatus,
        getGovernor: deps.getGovernor, getSuppliers: service.getSuppliers, getPriceCache: service.getPriceCache,
        factionNames, capIsk: config.trade.iskBudgetCap, getVirtualCorps, adapter, config,
        getPlans: service.getPlans, targetOpenContracts: config.trade.targetOpenContracts,
        readWarPricing: service.readWarPricing,
        tiers: tierCfgOf(config.trade),
        getGraph: () => universeGraphOf(deps.getGraph),
        getStations: getStations || (() => null), getLocalResources: localApi,
        catalog }));
      if (r && r.ok) viewHandle = r;
      else logger.log(`trade: view ${VIEW_ID} not registered - ${(r && r.reason) || "no result"}`);
    }

    if (executor) {
      try {
        executor.start();
        if (mode === "run") {
          if (typeof adapter.setTradeNudge === "function" && typeof adapter.installTradeHooks === "function"
            && typeof adapter.uninstallTradeHooks === "function") {
            hooksTouched = true;
            const set = adapter.setTradeNudge(executor.nudge);
            const hook = set && set.ok ? adapter.installTradeHooks() : set;
            hookInstalled = Boolean(hook && hook.ok);
            hookReason = hookInstalled ? null : String((hook && hook.reason) || "no result");
          } else {
            hookReason = "adapter_without_hooks";
          }
          if (!hookInstalled) logger.log(`trade: contract accept hook not installed - ${hookReason} (poll only)`);
        }
      } catch (err) {
        if (hooksTouched) swallow(() => adapter.uninstallTradeHooks());
        swallow(() => { if (externalPrices) externalPrices.stop(); });
        swallow(() => { if (localRes) localRes.stop(); });
        const ex = executor;
        swallow(() => ex.stop());
        swallow(() => { if (!service.isStopped()) service.stop(); });
        if (viewHandle) { const handle = viewHandle; viewHandle = null; swallow(() => handle.unregister()); }
        swallow(() => { if (deliveryStanding) deliveryStanding.stop(); });
        swallow(() => { if (standingUnregister) standingUnregister(); });
        deliveryStanding = null;
        standingUnregister = null;
        return { ok: false, reason: "TRADE_START_FAILED", detail: messageOf(err) };
      }
    }

    if (localRes) {
      const warmMax = tradeCfg.localResourcesWarmMaxSystems;
      const svc = localRes;
      const live = () => localRes === svc && svc.getStatus().state === "ready";
      if (warmMax === 0) {
        localWarm = Object.freeze({ state: "skipped", reason: "warm_max_0" });
      } else {
        Promise.resolve()
          .then(() => {
            const stations = typeof getStations === "function" ? getStations() : null;
            if (!stations || typeof stations.whenReady !== "function") return null;
            return Promise.resolve(stations.whenReady()).then(() => stations);
          })
          .then((stations) => {
            if (!live()) return;
            const repo = stations ? stations.repository : null;
            if (!repo || typeof repo.listLiveStations !== "function") {
              localWarm = Object.freeze({ state: "skipped", reason: "no_stations" });
              return;
            }
            const maxStations = config.stations && Number.isSafeInteger(config.stations.maxStations)
              ? config.stations.maxStations : undefined;
            const tx = store.transaction(LOCAL_WARM_TX,
              (db) => repo.listLiveStations(db, maxStations === undefined ? {} : { limit: maxStations }));
            if (!tx || !tx.ok || !tx.value || tx.value.ok !== true) {
              const reason = (tx && tx.value && tx.value.reason) || (tx && tx.reason) || "TX_FAILED";
              localWarm = Object.freeze({ state: "failed", reason: String(reason) });
              return;
            }
            const r = svc.warm(tx.value.records.map((s) => s.systemId));
            localWarm = Object.freeze({ state: r.ok ? "done" : "failed", reason: r.ok ? null : r.reason,
              systems: r.requested, read: r.read, truncated: r.truncated || tx.value.truncated === true, ms: r.ms });
            logger.log(`trade: local resources warm-up ${localWarm.state} systems=${r.requested} read=${r.read}`
              + ` ms=${r.ms}${r.ok ? "" : ` reason=${r.reason}`}`);
          })
          .catch((err) => {
            localWarm = Object.freeze({ state: "failed", reason: messageOf(err) });
          });
      }
    }

    const facade = {
      getMode: () => mode,
      tradeReady: service.tradeReady,
      fundFromUpkeepInTx: service.fundFromUpkeepInTx,
      fundFromTreasuryInTx: service.fundFromTreasuryInTx,
      readBudget: service.readBudget,
      readForReview: service.readForReview,
      planOfferInTx: service.planOfferInTx,
      cancelOfferInTx: service.cancelOfferInTx,
      getPriceCache: service.getPriceCache,
      localResourcesFor: (systemIds, opts) => (localRes ? localRes.localResourcesFor(systemIds, opts) : null),
      getSuppliers: service.getSuppliers,
      notePlan: service.notePlan,
      getPlans: service.getPlans,
      readWarPricing: service.readWarPricing,
      count: service.count,
      noteRefusal: service.noteRefusal,
      budgets,
      offers,
      getStatus: fullStatus,
      nudge: () => { if (executor) executor.nudge(); },
      checkTradeSeams: () => adapter && typeof adapter.checkTradeSeams === "function"
        ? adapter.checkTradeSeams()
        : { ok: false, reason: "TRADE_SEAM_UNAVAILABLE", missing: ["no_adapter"] },
      stop() {
        if (hooksTouched) {
          hooksTouched = false;
          hookInstalled = false;
          hookReason = "stopped";
          swallow(() => adapter.uninstallTradeHooks());
        }
        if (externalPrices) swallow(() => externalPrices.stop());
        if (localRes) swallow(() => localRes.stop());
        if (executor) {
          executor.stop();
          executor = null;
        }
        if (deliveryStanding) {
          deliveryStanding.stop();
          if (standingUnregister) {
            swallow(() => standingUnregister());
            standingUnregister = null;
          }
          deliveryStanding = null;
        }
        if (service && !service.isStopped()) service.stop();
        if (viewHandle) {
          const handle = viewHandle;
          viewHandle = null;
          swallow(() => handle.unregister());
        }
      },
    };
    return { ok: true, trade: Object.freeze(facade) };
  } catch (err) {
    swallow(() => { if (externalPrices) externalPrices.stop(); });
    externalPrices = null;
    swallow(() => { if (localRes) localRes.stop(); });
    localRes = null;
    swallow(() => { if (deliveryStanding) deliveryStanding.stop(); });
    swallow(() => { if (standingUnregister) standingUnregister(); });
    deliveryStanding = null;
    standingUnregister = null;
    return { ok: false, reason: "TRADE_START_FAILED", detail: messageOf(err) };
  }
}

module.exports = { startTrade, createUnavailableTrade, buildCatalog };