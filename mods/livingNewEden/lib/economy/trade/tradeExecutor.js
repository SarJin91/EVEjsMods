"use strict";

const { defaultSetTimer } = require("../../presence/poller");
const { parseHubSystemIds } = require("../../highsecLife/schema");
const S = require("./schema");
const { closeWanted, buildIssuePayload, fundIskOf, abortAllowed, planIntake, contractTtlOf, issuerOf, issuerOfPayload, stationGate, npcIssuerGate, pickIssuer } = require("./executorRules");
const { transitionKey, issueOutboxKey, walletCommandId, contractTag, EVENT_OUTBOX_ISSUE, intakeOutboxKey, voidKey, deliverKey } = require("./schema");
const { stepAccepted, stepIntake } = require("./intake");
const { tierCfgOf } = require("../../strategy/data/tradeTiers");
const { runOrphanScan, characterSeamsOk: characterSeamsOkOf } = require("./orphans");
const { runOrphanScan: runMarketOrphanScan } = require("./marketOrphans");
const { runRefundSweep } = require("./refundSweep");
const { StandingRollback } = require("./deliveryStanding");
const { mergePriceRefs, basePriceRefs } = require("./priceMerge");
const { MINERALS_ONLY } = require("./tradeCatalog");
const { stepIssueSell, stepReturn, stepPollSell, stepProceeds, loseProceeds } = require("./sellSteps");
const { buildSellIssuePayload } = require("./executorRules");
const { METRIC_WTS_STOCK_LOST, METRIC_CONTRACT_LIMIT, TREASURY_NOT_READY } = require("./sellSteps");
const { SCHEMA } = require("../../../config");
const { chooseChannel, hullMarketFlag, marketIssueGate, buildMarketPlacePayload, buildMarketSellPayload,
  validateSellOrderConfig } = require("./marketRules");
const { createMarketSteps } = require("./marketExecutor");

const WTS_TTL_ROW = SCHEMA.find((r) => r.key === "trade.wtsTtlMs");
function cfgInt(tradeCfg, name) {
  const row = SCHEMA.find((r) => r.key === `trade.${name}`);
  const v = Number.isSafeInteger(tradeCfg[name]) ? tradeCfg[name] : row.default;
  return Math.min(row.max, Math.max(row.min, v));
}

const STATE = Object.freeze({ IDLE: "idle", RUNNING: "running", STOPPED: "stopped" });
const GOVERNOR_CLASS = "OPERATIONAL";

const TRADE_SEAM_UNAVAILABLE = Object.freeze({ ok: false, reason: "TRADE_SEAM_UNAVAILABLE" });
const INTAKE_RETRIES_EXHAUSTED = "INTAKE_RETRIES_EXHAUSTED";

class ExhaustRollback extends Error {
  constructor(refusal) {
    super(String((refusal && refusal.reason) || "EXHAUST_ROLLBACK"));
    this.refusal = refusal;
  }
}

class IssuingRollback extends Error {
  constructor(refusal) {
    super(String((refusal && refusal.reason) || "ISSUING_ROLLBACK"));
    this.refusal = refusal;
  }
}
const issuingRefusal = (txRes) => (txRes && txRes.error instanceof IssuingRollback
  ? (txRes.error.refusal || {}) : (txRes && txRes.value) || { reason: txRes && txRes.reason });

function metric(telemetry, name, value) {
  if (!telemetry || typeof telemetry.count !== "function") return;
  try { telemetry.count(name, value); } catch (_err) {}
}
function hist(telemetry, name, value) {
  if (!telemetry || typeof telemetry.observe !== "function") return;
  try { telemetry.observe(name, value); } catch (_err) {}
}
function log(logger, ...args) {
  if (logger && typeof logger.log === "function") logger.log(...args);
}

function toPositiveInteger(value, fallback = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  const truncated = Math.trunc(numeric);
  return truncated > 0 ? truncated : fallback;
}

function createTradeExecutor(deps) {
  const {
    store, journal, offers, budgets, getStations, adapter,
    priceCache, config, clock, mode, getGovernor,
    factionNames, telemetry = null, logger = { log() {} }, setTimer = defaultSetTimer,
    deliveryStanding = null,
    getVirtualCorps = null,
    getRegistry = null,
    externalPrices = null,
    localDrain = null,
    stationAskDrain = null,
    getTreasury = null,
    market = null,
  } = deps;
  const marketReady = Boolean(market && market.ready === true);
  const marketReason = market && typeof market.reason === "string" ? market.reason : (marketReady ? null : "not_configured");
  const catalog = deps.catalog || MINERALS_ONLY;
  const oreMissSeen = new Set();

  if (!store || !journal || !offers || !budgets || !config || !clock) {
    throw new TypeError("tradeExecutor: missing required deps");
  }

  const tradeCfg = config.trade || {};
  const tierCfg = tierCfgOf(tradeCfg);
  const executorPollMs = Math.max(10000, Math.trunc(tradeCfg.executorPollMs || 60000));
  const maxIssuesPerPass = Math.max(0, Math.trunc(tradeCfg.maxIssuesPerPass || 2));
  const maxPollsPerPass = Math.max(1, Math.trunc(tradeCfg.maxPollsPerPass || 16));
  const maxClosesPerPass = Math.max(0, Math.trunc(tradeCfg.maxClosesPerPass || 4));
  const issueTimeoutMs = Math.max(1, Math.trunc(tradeCfg.issueTimeoutMs || 1800000));
  const priceRefreshMs = Math.max(60000, Math.trunc(tradeCfg.priceRefreshMs || 1800000));
  const priceRetryMs = Math.max(10000, Math.trunc(tradeCfg.priceRetryMs || 120000));
  const maxPriceRegions = Math.max(1, Math.trunc(tradeCfg.maxPriceRegions || 8));
  const priceRegionId = Math.trunc(tradeCfg.priceRegionId || 10000002);
  const externalPriceMaxRatio = Math.max(2, Math.trunc(tradeCfg.externalPriceMaxRatio || 10));
  const contractsEnabled = tradeCfg.contractsEnabled !== false;
  const cleanupOnDisable = tradeCfg.cleanupOnDisable === true;
  const virtualIssuersEnabled = tradeCfg.virtualIssuers !== false;
  const maxIntakesPerPass = Math.max(1, Math.trunc(tradeCfg.maxIntakesPerPass || 2));
  const intakeGraceMs = Math.max(0, Math.trunc(tradeCfg.intakeGraceMs || 600000));
  const maxOrphansPerPass = Math.max(1, Math.trunc(tradeCfg.maxOrphansPerPass || 2));
  const intakeMaxRetries = Math.max(1, Math.trunc(tradeCfg.intakeMaxRetries || 10));
  const maxBuyOrderOrphansPerPass = cfgInt(tradeCfg, "maxBuyOrderOrphansPerPass");
  const marketOrphanScanMs = Math.max(60000, Math.trunc(tradeCfg.marketOrphanScanMs || 3600000));
  const maxRefundSweepsPerPass = cfgInt(tradeCfg, "maxRefundSweepsPerPass");
  const buyOrderWalletAccountKey = Math.trunc(tradeCfg.buyOrderWalletAccountKey || 1005);
  const walletAccountKey = Math.trunc(tradeCfg.walletAccountKey || 1000);
  const buyOrdersEnabled = tradeCfg.buyOrdersEnabled === true;
  const hullBuyOrdersEnabled = hullMarketFlag(config);
  const commodityBuyOrdersEnabled = tradeCfg.commodityOffersEnabled === true
    && tradeCfg.commodityBuyOrdersEnabled === true;
  const commodityBaseOn = tradeCfg.commodityOffersEnabled === true && tradeCfg.commodityBasePriceEnabled === true;
  const commodityBaseAskPermille = Math.trunc(tradeCfg.commodityBasePriceAskPermille || 1200);
  const maxUnitPriceMilli = Math.trunc(tradeCfg.maxUnitPriceMilli || 1000000000000);
  const commodityTypeIds = commodityBaseOn ? Object.freeze((catalog.priceTypeIds || [])
    .filter((t) => Object.prototype.hasOwnProperty.call(catalog.commodityKinds || {}, `type:${t}`))) : [];
  const buyOrderTtlMs = cfgInt(tradeCfg, "buyOrderTtlMs");
  const maxBuyOrderPollsPerPass = cfgInt(tradeCfg, "maxBuyOrderPollsPerPass");
  const maxBuyOrderClosesPerPass = cfgInt(tradeCfg, "maxBuyOrderClosesPerPass");
  const wtsEnabled = tradeCfg.wtsEnabled === true;
  const sellHubSystems = tradeCfg.marketSellHubRoutingEnabled === true
    ? new Set(parseHubSystemIds(config.highsecLife?.hubSystemIds) || []) : null;
  const wtsTtlMs = Math.max(WTS_TTL_ROW.min, Math.trunc(tradeCfg.wtsTtlMs || WTS_TTL_ROW.default));
  const isSell = (offer) => Boolean(offer) && offer.side === S.SIDE_SELL;
  const sellGateSeen = new Set();
  const typeNameOf = (offer) => {
    const entry = catalog && typeof catalog.get === "function" ? catalog.get(offer.itemKey) : null;
    return entry && typeof entry.name === "string" ? entry.name : null;
  };
  const sellOrdersEnabled = (() => {
    if (tradeCfg.marketSellOrdersEnabled !== true || !wtsEnabled || mode !== "run") return false;
    let reason = null;
    try {
      const cfg = validateSellOrderConfig(tradeCfg);
      const seams = adapter && typeof adapter.checkTradeMarketSeams === "function" ? adapter.checkTradeMarketSeams() : null;
      const sell = adapter && typeof adapter.tradeMarketSellSeams === "function" ? adapter.tradeMarketSellSeams() : null;
      if (!cfg.ok) reason = `${cfg.reason} ${cfg.detail}`;
      else if (!seams || seams.ok !== true) reason = "TRADE_MARKET_SEAM_UNAVAILABLE";
      else if (!sell || sell.ok !== true) reason = `SELL_MARKET_SEAMS_UNAVAILABLE ${(sell && sell.detail) || ""}`;
      else if (typeof adapter.tradeMarketDurationAllowed !== "function"
        || adapter.tradeMarketDurationAllowed(tradeCfg.sellOrderDurationDays) !== true) reason = "SELL_ORDER_DURATION_NOT_ALLOWED";
    } catch (err) {
      reason = `SELL_CHECK_THREW ${err && err.message}`;
    }
    log(logger, `trade: sell orders ${reason === null ? "on" : `off - ${reason}`}`);
    return reason === null;
  })();

  let state = STATE.IDLE;
  let timer = null;
  let runningPass = false;
  let passes = 0;
  const priceStatus = {
    seq: 0, refreshed: 0, failed: 0, failuresByReason: {}, lastAttemptAt: null, lastRefreshAt: null, nextAttemptAt: 0,
    lastStored: 0, lastRejected: 0, lastNoAsk: 0, lastReadErrors: 0, lastRefusal: null, lastRefusalDetail: null,
    lastRefusalAt: null,
    lastExternal: 0, lastExternalRejected: 0, lastLocalRefusal: null, lastReadAborted: null,
    ...(commodityBaseOn ? { lastBase: 0, lastBaseMissing: 0 } : {}),
  };
  let pollCursor = "";
  const lastPermanent = new Map();
  let orphanScanDone = false;
  let acceptedCursor = "";
  let intakeCursor = "";
  let orphanCursor = 0;
  const intakeFailures = new Map();
  let wtsProceedsWait = 0;
  let marketOrphanScanDone = false;
  let marketOrphanCursor = "0";
  let lastMarketOrphanScanAt = 0;
  let marketOrphanCorpIndex = 0;
  const sweepState = { corpIndex: 0, blockedLogged: false };
  let escrowClonedThisPass = false;
  const marketSteps = createMarketSteps({ store, journal, offers, adapter, config, clock, telemetry, logger, mode,
    lastPermanent, noteEscrowClone: () => { escrowClonedThisPass = true; } });
  const isMarket = (offer) => Boolean(offer) && offer.channel === S.CHANNEL_MARKET;
  const sweepMaxRows = (store && store.limits && Number.isSafeInteger(store.limits.maxRowsPerTransaction)
    && store.limits.maxRowsPerTransaction > 0) ? store.limits.maxRowsPerTransaction : 500;

  function noteWalletResult(res, offerId, leg) {
    if (!res || res.ok !== true || res.fingerprintMismatch !== true) return;
    metric(telemetry, "trade.walletKeyCollision", 1);
    log(logger, `[tradeExecutor] wallet key collision (fingerprintMismatch) offer ${offerId} leg ${leg}`);
  }

  function walletLeg(iss, offerId, leg, deltaIsk) {
    return adapter.tradeAdjustWallet({
      ownerKind: iss.kind,
      ownerId: iss.ownerId,
      corporationId: iss.corporationId,
      accountKey: iss.accountKey,
      deltaIsk,
      commandId: walletCommandId(offerId, leg),
      description: `lne-trade ${leg} ${offerId}`,
    });
  }

  async function deleteCeoOf(iss) {
    if (iss.kind === S.ISSUER_KIND_CHARACTER) return iss.characterId;
    return (await readIssuer(iss.corporationId))?.ceoId || 0;
  }

  const characterSeamsOk = () => characterSeamsOkOf(adapter);

  async function chooseIssuer(offer, now, passCounts) {
    if (!virtualIssuersEnabled) {
      metric(telemetry, "trade.issuerFallback", 1);
      return { kind: "npc", reason: "OFF" };
    }
    const seams = adapter && typeof adapter.tradeVirtualIssuerSeams === "function"
      ? adapter.tradeVirtualIssuerSeams()
      : { ok: false };
    if (!seams || !seams.ok) {
      metric(telemetry, "trade.issuerFallback", 1);
      return { kind: "npc", reason: "FACADE" };
    }
    if (!getVirtualCorps) return { kind: "npc", reason: "FACADE" };
    const vc = getVirtualCorps();
    if (!vc) return { kind: "npc", reason: "FACADE" };
    const res = vc.listTradeIssuers(offer.factionId);
    if (!res || !res.ok) {
      metric(telemetry, "trade.issuerFallback", 1);
      return { kind: "npc", reason: "FACADE" };
    }
    if (res.ready !== true) {
      const age = now - (Number.isSafeInteger(offer.createdAt) ? offer.createdAt : now);
      if (age < issueTimeoutMs) {
        metric(telemetry, "trade.issuerWait", 1);
        return { wait: true };
      }
      metric(telemetry, "trade.issuerFallback", 1);
      return { kind: "npc", reason: "NOT_READY_TIMEOUT" };
    }
    const candidates = res.issuers || [];
    if (candidates.length === 0) {
      metric(telemetry, "trade.issuerFallback", 1);
      return { kind: "npc", reason: "NO_ISSUERS" };
    }
    const mergedCounts = new Map(countsByFaction.get(offer.factionId) || new Map());
    for (const [cid, n] of passCounts) mergedCounts.set(cid, (mergedCounts.get(cid) || 0) + n);
    const sorted = pickIssuer(candidates, mergedCounts);
    for (const c of sorted) {
      let exists = { ok: true, exists: true };
      if (adapter && typeof adapter.tradeReadCharacter === "function") {
        try {
          const res = await adapter.tradeReadCharacter(c.characterId);
          exists = res && res.ok && res.exists ? { ok: true, exists: true } : { ok: true, exists: false };
        } catch (_err) {
          exists = { ok: true, exists: true };
        }
      }
      if (exists.exists) {
        metric(telemetry, "trade.issuerVirtual", 1);
        return { kind: "character", characterId: c.characterId, corporationId: c.corporationId, slot: c.slot };
      }
    }
    metric(telemetry, "trade.issuerFallback", 1);
    return { kind: "npc", reason: "NO_CHARACTER" };
  }

  let countsByFaction = new Map();

  function cancelTimer() {
    if (timer === null) return;
    const h = timer; timer = null;
    try { h.cancel(); } catch (_err) {}
  }

  let rerun = false;

  function arm(ms) {
    if (state !== STATE.RUNNING) return;
    cancelTimer();
    const delay = Math.max(0, Number.isFinite(ms) ? ms : executorPollMs);
    try {
      timer = setTimer(fire, delay);
    } catch (_err) { timer = null; }
  }

  async function fire() {
    timer = null;
    if (state !== STATE.RUNNING) return;
    if (runningPass) {
      rerun = true;
      return;
    }
    rerun = false;
    runningPass = true;
    try {
      await runPass();
    } catch (_err) {
    } finally {
      runningPass = false;
      const again = rerun;
      rerun = false;
      if (state === STATE.RUNNING) arm(again ? 0 : executorPollMs);
    }
  }

  async function runPass() {
    if (state === STATE.STOPPED) {
      return { ok: true, skipped: "STOPPED", issued: 0, opened: 0, accepted: 0, closed: 0, aborted: 0, retried: 0, errors: 0 };
    }

    const startMs = clock.now();
    passes += 1;
    escrowClonedThisPass = false;

    const governor = typeof getGovernor === "function" ? getGovernor() : null;
    if (governor && typeof governor.admits === "function" && governor.admits(GOVERNOR_CLASS) === false) {
      metric(telemetry, "trade.passDeferred", 1);
      return { ok: true, skipped: "GOVERNOR", issued: 0, opened: 0, accepted: 0, closed: 0, aborted: 0, retried: 0, errors: 0 };
    }

    const stationsModule = getStations();
    if (stationsModule && typeof stationsModule.getMode === "function" && stationsModule.getMode() !== "ready") {
      return { ok: true, issued: 0, opened: 0, accepted: 0, closed: 0, aborted: 0, retried: 0, errors: 0 };
    }

    let issued = 0, opened = 0, accepted = 0, closed = 0, aborted = 0, retried = 0, errors = 0;

    try {
      if (mode === "run") {
        const now = clock.now();
        if (externalPrices) {
          try {
            externalPrices.maybeRefresh(now);
            if (externalPrices.consumeChanged()) priceStatus.nextAttemptAt = 0;
          } catch (_err) {}
        }
        if (typeof localDrain === "function") {
          try { localDrain(); } catch (_err) {}
        }
        if (now >= priceStatus.nextAttemptAt) {
          let refreshed = false;
          try {
            refreshed = (await refreshPrices(now)).ok === true;
          } catch (_err) {
            metric(telemetry, "trade.priceRefreshFailed", 1);
            errors += 1;
          }
          priceStatus.nextAttemptAt = now + (refreshed ? priceRefreshMs : priceRetryMs);
        }
        if (typeof stationAskDrain === "function") {
          try {
            await stationAskDrain(now);
          } catch (_err) {
            metric(telemetry, "trade.stationAskFailed", 1);
          }
        }
      }

      const readResult = offers.readForExecutor(store, {
        maxIssuesPerPass, maxPollsPerPass, pollCursor,
      });
      if (!readResult.ok) {
        log(logger, `[tradeExecutor] read failed: ${readResult.reason}`);
        return { ok: true, issued: 0, opened: 0, accepted: 0, closed: 0, aborted: 0, retried: 0, errors: 1 };
      }

      const { issuingOffers, plannedOffers, openOffers, stations, newCursor } = readResult.value;
      pollCursor = newCursor;

      for (const offer of issuingOffers) {
        if (state === STATE.STOPPED) break;
        try {
          if (isMarket(offer)) {
            const r = await marketSteps.issueMarket(offer, stations.get(offer.stationId));
            if (r.action === "opened") { opened += 1; issued += 1; metric(telemetry, "trade.issued", 1); }
            else if (r.action === "aborted") {
              aborted += 1; metric(telemetry, "trade.issueAborted", 1);
              if (mode === "cleanup") closed += 1;
            }
            else if (r.action === "retry") { retried += 1; metric(telemetry, "trade.issueRetry", 1); }
            else if (r.action === "error") {
              log(logger, `[tradeExecutor] ISSUING market offer ${offer.offerId}: ${r.reason}`);
              errors += 1; metric(telemetry, "trade.seamError", 1);
            }
            continue;
          }
          if (mode === "cleanup" && cleanupOnDisable) {
            const r = await issueStep(offer, stations.get(offer.stationId), offer.issuerCorporationId);
            if (r.action === "aborted") { aborted += 1; metric(telemetry, "trade.issueAborted", 1); closed += 1; }
            else if (r.action === "opened") { opened += 1; issued += 1; metric(telemetry, "trade.issued", 1); }
            else if (r.action === "retry") { retried += 1; metric(telemetry, "trade.issueRetry", 1); }
            else if (r.action === "error") { errors += 1; metric(telemetry, "trade.seamError", 1); }
            continue;
          }
          const r = await issueStep(offer, stations.get(offer.stationId), offer.issuerCorporationId);
          if (r.action === "opened") { opened += 1; issued += 1; metric(telemetry, "trade.issued", 1); }
          else if (r.action === "retry") { retried += 1; metric(telemetry, "trade.issueRetry", 1); }
          else if (r.action === "aborted") { aborted += 1; metric(telemetry, "trade.issueAborted", 1); }
          else if (r.action === "error") { errors += 1; metric(telemetry, "trade.seamError", 1); }
        } catch (err) {
          log(logger, `[tradeExecutor] ISSUING offer ${offer.offerId} error: ${err.message}`);
          errors += 1;
          metric(telemetry, "trade.seamError", 1);
        }
      }

      countsByFaction = new Map();
      const factionsInPlanned = [...new Set(plannedOffers.map(o => o.factionId))];
      for (const fid of factionsInPlanned) {
        const countsRes = offers.countOpenByIssuer(store, fid);
        if (countsRes.ok) countsByFaction.set(fid, countsRes.counts);
      }
      const passCounts = new Map();
      let privateFee;
      const privateFeeOf = () => {
        if (privateFee === undefined) privateFee = resolvePrivateFee();
        return privateFee;
      };

      for (const offer of plannedOffers) {
        if (state === STATE.STOPPED) break;
        try {
          if (mode === "cleanup" && cleanupOnDisable) {
            await transitionToCancelled(offer, "DISABLED", "cleanup");
            closed += 1;
            metric(telemetry, "trade.closed", 1);
            continue;
          }
          if (mode === "cleanup") {
            continue;
          }
          const station = stations.get(offer.stationId);
          const channel = chooseChannel(offer, station, { buyOrdersEnabled, contractsEnabled, marketReady,
            marketDown: marketSteps.isDown() || marketSteps.isTripped(), hullBuyOrdersEnabled,
            commodityBuyOrdersEnabled, sellOrdersEnabled, sellHubSystems });
          if (channel === null) {
            continue;
          }
          if (channel === S.CHANNEL_MARKET) {
            const r = await planMarket(offer, station);
            if (r.action === "opened") { opened += 1; issued += 1; metric(telemetry, "trade.issued", 1); }
            else if (r.action === "retry") { retried += 1; metric(telemetry, "trade.issueRetry", 1); }
            else if (r.action === "aborted") { aborted += 1; metric(telemetry, "trade.issueAborted", 1); }
            else if (r.action === "closed") { closed += 1; metric(telemetry, "trade.closed", 1); }
            else if (r.action === "error") {
              log(logger, `[tradeExecutor] PLANNED market offer ${offer.offerId}: ${r.reason}`);
              errors += 1; metric(telemetry, "trade.seamError", 1);
            }
            continue;
          }
          const sell = isSell(offer);
          if (sell && !wtsEnabled) {
            await transitionToCancelled(offer, S.END_REASON_DISABLED, "wtsDisabled");
            closed += 1;
            metric(telemetry, "trade.closed", 1);
            continue;
          }

          const stationGateRes = stationGate(station, offer.issuerCorporationId);
          if (stationGateRes) {
            await transitionToCancelled(offer, stationGateRes, "stationGate");
            closed += 1;
            metric(telemetry, "trade.closed", 1);
            continue;
          }

          const isPrivate = !sell && Number.isSafeInteger(offer.assigneeCharacterId) && offer.assigneeCharacterId > 0;
          const feeIsk = isPrivate ? privateFeeOf() : null;
          if (isPrivate && feeIsk === null) {
            metric(telemetry, "trade.privateFeeUnavailable", 1);
            continue;
          }
          const privateBrokerFeeIsk = feeIsk === null ? undefined : feeIsk;

          const now = clock.now();
          const choice = await chooseIssuer(offer, now, passCounts);
          if (choice.wait) {
            continue;
          }
          if (choice.kind === "npc") {
            const issuer = await readIssuer(offer.issuerCorporationId);
            const npcGate = npcIssuerGate(issuer);
            if (npcGate) {
              await transitionToCancelled(offer, npcGate, "npcIssuerGate");
              closed += 1;
              metric(telemetry, "trade.closed", 1);
              continue;
            }
            const ttlMs = sell ? wtsTtlMs : contractTtlOf(offer, tradeCfg.contractTtlMs, tradeCfg.privateOfferTtlMs, tierCfg);
            const expiresAt = now + ttlMs;
            const transKey = transitionKey(offer.offerId, offer.stateSeq + 1, S.ISSUING);
            const payload = sell
              ? buildSellIssuePayload({ ...offer, expiresAt }, station, issuer,
                { accountKey: tradeCfg.walletAccountKey, wtsTtlMs },
                factionNames.get(offer.factionId) || null, typeNameOf(offer))
              : buildIssuePayload(
                { ...offer, factionId: offer.factionId, typeId: offer.typeId, quantity: offer.quantity, rewardIsk: offer.iskTotal, expiresAt, assigneeCharacterId: offer.assigneeCharacterId },
                station, issuer,
                { accountKey: tradeCfg.walletAccountKey, contractTtlMs: tradeCfg.contractTtlMs, privateOfferTtlMs: tradeCfg.privateOfferTtlMs, tiers: tierCfg, privateBrokerFeeIsk },
                factionNames.get(offer.factionId) || null
              );
            const outboxKey = issueOutboxKey(offer.offerId);

            const txRes = store.transaction("trade.planned_issuing", (db) => {
              const transRes = offers.transitionOfferInTx(db, {
                offerId: offer.offerId,
                expectedVersion: offer.version,
                from: S.PLANNED,
                to: S.ISSUING,
                reason: "",
                at: now,
                patch: { expiresAt },
              }, transKey);
              if (!transRes.ok) return transRes;

              const outboxRes = journal.enqueueOutbox(db, {
                key: outboxKey,
                aggregate: { type: S.OFFER_AGGREGATE, id: offer.offerId },
                eventType: EVENT_OUTBOX_ISSUE,
                payload,
              });
              if (!outboxRes.ok) throw new IssuingRollback(outboxRes);

              return { ok: true };
            });
            if (!txRes.ok || !txRes.value.ok) {
              const refusal = issuingRefusal(txRes);
              log(logger, `[tradeExecutor] PLANNED->ISSUING+outbox failed: ${refusal.reason} ${refusal.detail || ''}`);
              errors += 1;
              metric(telemetry, "trade.seamError", 1);
              continue;
            }

            const r = await issueStep({ ...offer, state: S.ISSUING, stateSeq: offer.stateSeq + 1, expiresAt }, station, offer.issuerCorporationId);
            if (r.action === "opened") { opened += 1; issued += 1; metric(telemetry, "trade.issued", 1); }
            else if (r.action === "retry") { retried += 1; metric(telemetry, "trade.issueRetry", 1); }
            else if (r.action === "aborted") { aborted += 1; metric(telemetry, "trade.issueAborted", 1); }
            else if (r.action === "error") { errors += 1; metric(telemetry, "trade.seamError", 1); }
          } else {
            const { characterId, corporationId, slot: _slot } = choice;
            const ttlMs = sell ? wtsTtlMs : contractTtlOf(offer, tradeCfg.contractTtlMs, tradeCfg.privateOfferTtlMs, tierCfg);
            const expiresAt = now + ttlMs;
            const transKey = transitionKey(offer.offerId, offer.stateSeq + 1, S.ISSUING);
            const payload = sell
              ? buildSellIssuePayload({ ...offer, expiresAt, issuerCharacterId: characterId, issuerCharacterCorpId: corporationId },
                station, null, { accountKey: tradeCfg.walletAccountKey, wtsTtlMs },
                factionNames.get(offer.factionId) || null, typeNameOf(offer))
              : buildIssuePayload(
                { ...offer, factionId: offer.factionId, typeId: offer.typeId, quantity: offer.quantity, rewardIsk: offer.iskTotal, expiresAt, assigneeCharacterId: offer.assigneeCharacterId, issuerCharacterId: characterId, issuerCharacterCorpId: corporationId },
                station, null,
                { accountKey: tradeCfg.walletAccountKey, contractTtlMs: tradeCfg.contractTtlMs, privateOfferTtlMs: tradeCfg.privateOfferTtlMs, tiers: tierCfg, privateBrokerFeeIsk },
                factionNames.get(offer.factionId) || null
              );
            const outboxKey = issueOutboxKey(offer.offerId);

            const txRes = store.transaction("trade.planned_issuing", (db) => {
              const transRes = offers.transitionOfferInTx(db, {
                offerId: offer.offerId,
                expectedVersion: offer.version,
                from: S.PLANNED,
                to: S.ISSUING,
                reason: "",
                at: now,
                patch: { expiresAt, issuerCharacterId: characterId, issuerCharacterCorpId: corporationId },
              }, transKey);
              if (!transRes.ok) return transRes;

              const outboxRes = journal.enqueueOutbox(db, {
                key: outboxKey,
                aggregate: { type: S.OFFER_AGGREGATE, id: offer.offerId },
                eventType: EVENT_OUTBOX_ISSUE,
                payload,
              });
              if (!outboxRes.ok) throw new IssuingRollback(outboxRes);

              return { ok: true };
            });
            if (!txRes.ok || !txRes.value.ok) {
              const refusal = issuingRefusal(txRes);
              log(logger, `[tradeExecutor] PLANNED->ISSUING+outbox failed: ${refusal.reason} ${refusal.detail || ''}`);
              errors += 1;
              metric(telemetry, "trade.seamError", 1);
              continue;
            }

            passCounts.set(characterId, (passCounts.get(characterId) || 0) + 1);

            const r = await issueStep({ ...offer, state: S.ISSUING, stateSeq: offer.stateSeq + 1, expiresAt, issuerCharacterId: characterId, issuerCharacterCorpId: corporationId }, station, corporationId);
            if (r.action === "opened") { opened += 1; issued += 1; metric(telemetry, "trade.issued", 1); }
            else if (r.action === "retry") { retried += 1; metric(telemetry, "trade.issueRetry", 1); }
            else if (r.action === "aborted") { aborted += 1; metric(telemetry, "trade.issueAborted", 1); }
            else if (r.action === "error") { errors += 1; metric(telemetry, "trade.seamError", 1); }
          }
        } catch (err) {
          log(logger, `[tradeExecutor] PLANNED offer ${offer.offerId} error: ${err.message}`);
          errors += 1;
          metric(telemetry, "trade.seamError", 1);
        }
      }

      let closesThisPass = 0;
      let marketPolls = 0;
      let marketCloses = 0;
      for (const offer of openOffers) {
        if (state === STATE.STOPPED) break;
        if (isMarket(offer)) {
          if (mode === "cleanup" && !cleanupOnDisable) continue;
          if (marketPolls >= maxBuyOrderPollsPerPass) continue;
          marketPolls += 1;
          try {
            const r = await marketSteps.pollMarket(offer, stations.get(offer.stationId),
              marketCloses < maxBuyOrderClosesPerPass);
            if (r.closeStarted) marketCloses += 1;
            if (r.action === "accepted") { accepted += 1; metric(telemetry, "trade.accepted", 1); }
            else if (r.action === "closed") { closed += 1; metric(telemetry, "trade.closed", 1); }
            else if (r.action === "retry") retried += 1;
            else if (r.action === "error") {
              log(logger, `[tradeExecutor] OPEN market offer ${offer.offerId}: ${r.reason}`);
              errors += 1; metric(telemetry, "trade.seamError", 1);
            }
          } catch (err) {
            log(logger, `[tradeExecutor] OPEN market offer ${offer.offerId} error: ${err.message}`);
            errors += 1;
            metric(telemetry, "trade.seamError", 1);
          }
          continue;
        }
        if (closesThisPass >= maxClosesPerPass) continue;
        try {
          const station = stations.get(offer.stationId);
          if (isSell(offer)) {
            if (mode === "cleanup" && !cleanupOnDisable) continue;
            const r = await stepPollSell(sellDeps(), offer, station);
            if (r.action === "accepted") accepted += 1;
            else if (r.action === "closed") { closed += 1; closesThisPass += 1; metric(telemetry, "trade.closed", 1); }
            else if (r.action === "retry") retried += 1;
            else if (r.action === "error") { errors += 1; metric(telemetry, "trade.seamError", 1); }
            continue;
          }
          if (mode === "cleanup" && cleanupOnDisable) {
            const r = await stepPoll(offer, station);
            if (r.action === "closed") { closed += 1; closesThisPass += 1; metric(telemetry, "trade.closed", 1); }
            else if (r.action === "accepted") { accepted += 1; metric(telemetry, "trade.accepted", 1); }
            else if (r.action === "error") { errors += 1; metric(telemetry, "trade.seamError", 1); }
            continue;
          }
          if (mode === "cleanup") {
            continue;
          }
          const r = await stepPoll(offer, station);
          if (r.action === "accepted") { accepted += 1; metric(telemetry, "trade.accepted", 1); }
          else if (r.action === "closed") { closed += 1; closesThisPass += 1; metric(telemetry, "trade.closed", 1); }
          else if (r.action === "retry") { retried += 1; }
          else if (r.action === "error") { errors += 1; metric(telemetry, "trade.seamError", 1); }
        } catch (err) {
          log(logger, `[tradeExecutor] OPEN offer ${offer.offerId} error: ${err.message}`);
          errors += 1;
          metric(telemetry, "trade.seamError", 1);
        }
      }

      let intakesThisPass = 0;

      if (mode === "run" || mode === "cleanup") {
        const { offers: acceptedOffers, stations: acceptedStations } = await readAcceptedOffersWithStations(store, offers, acceptedCursor, maxIntakesPerPass, mode !== "run");
        for (const offer of acceptedOffers) {
          if (state === STATE.STOPPED) break;
          if (intakesThisPass >= maxIntakesPerPass) break;
          if (isSell(offer)) {
            let failed = false;
            try {
              const r = isMarket(offer) ? await marketSteps.stepMarketSellProceeds(sellDeps(), offer)
                : await stepProceeds(sellDeps(), offer);
              if (r.action === "DELIVERED") intakesThisPass += 1;
              else if (r.action === "RETRY") failed = true;
              else if (r.action === "ERROR") errors += 1;
              else if (r.action === "WAIT" && r.reason === TREASURY_NOT_READY) {
                wtsProceedsWait = Math.min(Number.MAX_SAFE_INTEGER, wtsProceedsWait + 1);
              }
            } catch (err) {
              log(logger, `[tradeExecutor] ACCEPTED sell offer ${offer.offerId} error: ${err.message}`);
              failed = true;
              errors += 1;
              metric(telemetry, "trade.seamError", 1);
            }
            if (!failed) { intakeFailures.delete(offer.offerId); continue; }
            const n = (intakeFailures.get(offer.offerId) || 0) + 1;
            if (n < intakeMaxRetries) { intakeFailures.set(offer.offerId, n); continue; }
            intakeFailures.delete(offer.offerId);
            if (isMarket(offer)) {
              try {
                const g = await marketSteps.stepMarketSellProceeds(sellDeps(), offer, { abandonReturn: true });
                if (g.action === "DELIVERED") { intakesThisPass += 1; metric(telemetry, "trade.intakeRetriesExhausted", 1); }
                else {
                  if (g.action === "ERROR") errors += 1;
                  if (g.action !== "STALE") intakeFailures.set(offer.offerId, intakeMaxRetries - 1);
                }
              } catch (err) {
                log(logger, `[tradeExecutor] ACCEPTED sell offer ${offer.offerId} abandon error: ${err.message}`);
                intakeFailures.set(offer.offerId, intakeMaxRetries - 1);
                errors += 1;
                metric(telemetry, "trade.seamError", 1);
              }
              continue;
            }
            const lost = loseProceeds(sellDeps(), offer.offerId, INTAKE_RETRIES_EXHAUSTED);
            if (lost.action === "LOST") metric(telemetry, "trade.intakeRetriesExhausted", 1);
            else if (lost.action === "ERROR") errors += 1;
            continue;
          }
          if (mode !== "run") continue;
          try {
            const station = acceptedStations.get(offer.stationId);
            const r = await stepAccepted({ store, journal, offers, adapter, config, clock, telemetry, logger, catalog,
              oreMissSeen }, offer, station);
            if (r.action === "PLAN") {
              intakesThisPass += 1;
              metric(telemetry, "trade.accepted", 1);
            } else if (r.action === "WAIT") {
            } else if (r.action === "LOST") {
            } else if (r.action === "ERROR") {
              errors += 1;
            }
          } catch (err) {
            log(logger, `[tradeExecutor] ACCEPTED offer ${offer.offerId} error: ${err.message}`);
            errors += 1;
            metric(telemetry, "trade.seamError", 1);
          }
        }
        if (acceptedOffers.length > 0) {
          acceptedCursor = acceptedOffers[acceptedOffers.length - 1].offerId;
        } else {
          acceptedCursor = "";
        }
      }

      if ((mode === "run" || mode === "cleanup") && intakesThisPass < maxIntakesPerPass) {
        const intakeOffers = await readIntakeOffers(store, intakeCursor, maxIntakesPerPass - intakesThisPass);
        if (intakeOffers.length > 0) intakeCursor = intakeOffers[intakeOffers.length - 1].offerId;
        else intakeCursor = "";
        for (const offer of intakeOffers) {
          if (state === STATE.STOPPED) break;
          if (intakesThisPass >= maxIntakesPerPass) break;
          if (mode !== "run" && !isSell(offer)) continue;
          let failed = false;
          try {
            if (isSell(offer)) {
              const r = await stepReturn({ store, journal, offers, adapter, clock, telemetry, logger }, offer);
              if (r.action === "RETURNED") intakesThisPass += 1;
              else if (r.action === "RETRY") failed = true;
              else if (r.action === "ERROR") { failed = true; errors += 1; }
            } else {
              const r = await stepIntake({ store, journal, offers, adapter, config, clock, telemetry, logger, catalog },
                offer);
              if (r.action === "DELIVERED") {
                intakesThisPass += 1;
              } else if (r.action === "RETRY") {
                failed = true;
              } else if (r.action === "ERROR") {
                failed = true;
                errors += 1;
              }
            }
          } catch (err) {
            log(logger, `[tradeExecutor] INTAKE offer ${offer.offerId} error: ${err.message}`);
            failed = true;
            errors += 1;
            metric(telemetry, "trade.seamError", 1);
          }
          if (!failed) { intakeFailures.delete(offer.offerId); continue; }
          const n = (intakeFailures.get(offer.offerId) || 0) + 1;
          if (n < intakeMaxRetries) { intakeFailures.set(offer.offerId, n); continue; }
          intakeFailures.delete(offer.offerId);
          const ex = exhaustIntake(offer.offerId, isSell(offer));
          if (ex.ok && ex.outcome === "LOST") {
            log(logger, `[tradeExecutor] INTAKE ${offer.offerId}: ${n} failed passes - LOST INTAKE_RETRIES_EXHAUSTED`);
            metric(telemetry, "trade.intakeRetriesExhausted", 1);
            metric(telemetry, "trade.lost", 1);
          } else if (!ex.ok) {
            log(logger, `[tradeExecutor] INTAKE ${offer.offerId}: exhaust failed - ${ex.reason}`);
            errors += 1;
          }
        }
      }

      const scanAdmits = new Map();
      const getScanGovernor = typeof getGovernor === "function" ? () => {
        const g = getGovernor();
        if (!g || typeof g.admits !== "function") return g;
        return {
          admits: (cls) => {
            if (!scanAdmits.has(cls)) scanAdmits.set(cls, g.admits(cls));
            return scanAdmits.get(cls);
          },
        };
      } : null;

      if ((mode === "run" || mode === "cleanup") && getStations) {
        try {
          const orphanRes = await runOrphanScan({ store, journal, offers, adapter, config, clock, telemetry, logger, getStations, getRegistry, getGovernor: getScanGovernor, isStopped: () => state === STATE.STOPPED }, !orphanScanDone, orphanCursor);
          orphanCursor = Number.isSafeInteger(orphanRes.nextCursor) && orphanRes.nextCursor > 0 ? orphanRes.nextCursor : 0;
          if (orphanRes.deferred !== true) orphanScanDone = true;
          if (orphanRes.errors > 0) {
            errors += orphanRes.errors;
          }
        } catch (err) {
          log(logger, `[tradeExecutor] orphan scan error: ${err.message}`);
          errors += 1;
          metric(telemetry, "trade.seamError", 1);
        }
      }

      if ((mode === "run" || mode === "cleanup") && maxBuyOrderOrphansPerPass > 0 && !escrowClonedThisPass) {
        try {
          const now = clock.now();
          const cycleStart = !marketOrphanScanDone || (now - lastMarketOrphanScanAt >= marketOrphanScanMs);
          const continuing = marketOrphanCursor !== "0";
          if (cycleStart || continuing) {
            const marketOrphanRes = await runMarketOrphanScan(
              { store, offers, adapter, config, telemetry, logger, getGovernor: getScanGovernor },
              cycleStart,
              marketOrphanCursor,
              marketOrphanCorpIndex
            );
            marketOrphanCursor = marketOrphanRes.nextCursor || "0";
            marketOrphanCorpIndex = marketOrphanRes.nextCorpIndex || 0;
            if (cycleStart && marketOrphanRes.deferred !== true) {
              marketOrphanScanDone = true;
              lastMarketOrphanScanAt = now;
            }
            if (marketOrphanRes.errors > 0) {
              errors += marketOrphanRes.errors;
            }
          }
        } catch (err) {
          log(logger, `[tradeExecutor] market orphan scan error: ${err.message}`);
          errors += 1;
          metric(telemetry, "trade.seamError", 1);
        }
      }

      if ((mode === "run" || mode === "cleanup") && maxRefundSweepsPerPass > 0) {
        try {
          const sweepRes = await runRefundSweep(
            { store, journal, adapter, config, telemetry, logger, offers, sweepState },
            maxRefundSweepsPerPass,
            sweepMaxRows
          );
          if (sweepRes.errors > 0) {
            errors += sweepRes.errors;
          }
        } catch (err) {
          log(logger, `[tradeExecutor] refund sweep error: ${err.message}`);
          errors += 1;
          metric(telemetry, "trade.seamError", 1);
        }
      }

    } catch (err) {
      log(logger, `[tradeExecutor] pass error: ${err.message}`);
      errors += 1;
      metric(telemetry, "trade.seamError", 1);
    }

    const duration = clock.now() - startMs;
    hist(telemetry, "trade.executorPassMs", duration);
    return { ok: true, issued, opened, accepted, closed, aborted, retried, errors };
  }

  function sellDeps() {
    return { store, journal, offers, budgets, adapter, config, clock, telemetry, logger, mode, lastPermanent,
      gateSeen: sellGateSeen, getTreasury, walletLeg, noteWalletResult, deliveryStanding };
  }
  function issueStep(offer, station, issuerCorporationId) {
    if (isSell(offer)) return stepIssueSell(sellDeps(), offer);
    return stepIssue(offer, station, issuerCorporationId);
  }

  async function planMarket(offer, station) {
    const issuer = await readIssuer(offer.issuerCorporationId);
    const gate = marketIssueGate(offer, station, issuer);
    if (gate) {
      await transitionToCancelled(offer, gate, "marketGate");
      return { action: "closed", reason: gate };
    }
    const now = clock.now();
    const sell = isSell(offer);
    const expiresAt = now + (sell ? wtsTtlMs : buyOrderTtlMs);
    const payload = sell ? buildMarketSellPayload(offer, station, tradeCfg) : buildMarketPlacePayload(offer, station, tradeCfg);
    const txRes = store.transaction("trade.planned_issuing", (db) => {
      const transRes = offers.transitionOfferInTx(db, {
        offerId: offer.offerId, expectedVersion: offer.version, from: S.PLANNED, to: S.ISSUING, reason: "", at: now,
        patch: { expiresAt, channel: S.CHANNEL_MARKET },
        allowHullMarket: offer.itemKind === S.ITEM_KIND_HULL && hullBuyOrdersEnabled,
        allowCommodityMarket: (offer.itemKind === S.ITEM_KIND_MOON || offer.itemKind === S.ITEM_KIND_PI)
          && commodityBuyOrdersEnabled,
        allowSellMarket: sell && sellOrdersEnabled,
      }, transitionKey(offer.offerId, offer.stateSeq + 1, S.ISSUING));
      if (!transRes.ok) throw new IssuingRollback(transRes);
      const outboxRes = journal.enqueueOutbox(db, {
        key: S.marketPlaceOutboxKey(offer.offerId),
        aggregate: { type: S.OFFER_AGGREGATE, id: offer.offerId },
        eventType: S.EVENT_OUTBOX_MARKET_PLACE,
        payload,
      });
      if (!outboxRes.ok) throw new IssuingRollback(outboxRes);
      return { ok: true };
    });
    if (!txRes.ok) {
      const refusal = issuingRefusal(txRes);
      return { action: "error", reason: `PLANNED_ISSUING:${refusal.reason}` };
    }
    return marketSteps.issueMarket(offer, station);
  }

  function resolvePrivateFee() {
    if (!adapter || typeof adapter.tradePrivateContractFee !== "function") return null;
    let res;
    try { res = adapter.tradePrivateContractFee(); } catch (_err) { return null; }
    return res && res.ok === true && Number.isSafeInteger(res.feeIsk) && res.feeIsk >= 0 ? res.feeIsk : null;
  }

  function noteFeeCharged(value) {
    if (!value || !Number.isSafeInteger(value.feeChargedIsk)) return;
    if (value.feeChargedIsk > 0) {
      metric(telemetry, "trade.privateFeeCharged", 1);
      metric(telemetry, "trade.privateFeeIsk", value.feeChargedIsk);
    }
    if (Number.isSafeInteger(value.feeShortIsk) && value.feeShortIsk > 0) metric(telemetry, "trade.privateFeeShort", 1);
  }

  async function stepIssue(offer, station, issuerCorporationId) {
    const currentOffer = store.transaction("trade.issue.read_offer", (db) => {
      return offers.getOffer(db, offer.offerId);
    });
    if (!currentOffer.ok || !currentOffer.value?.offer) {
      return { action: "error", reason: "OFFER_NOT_FOUND" };
    }
    const currentOfferData = currentOffer.value.offer;

    const outboxKey = issueOutboxKey(currentOfferData.offerId);
    const foundOutbox = store.transaction("trade.issue.read_outbox", (db) => {
      return journal.findByKey(db, outboxKey);
    });
    if (!foundOutbox.ok || !foundOutbox.value?.found) {
      return { action: "error", reason: "NO_OUTBOX" };
    }
    const payload = foundOutbox.value.entry.payload;
    const journalId = foundOutbox.value.entry.journalId;
    const now = clock.now();
    const iss = issuerOfPayload(payload, tradeCfg.walletAccountKey);
    const openFeeSpec = Number.isSafeInteger(payload.brokerFeeIsk) && payload.brokerFeeIsk > 0
      ? { feeIsk: payload.brokerFeeIsk } : {};
    if (iss.kind === S.ISSUER_KIND_CHARACTER && !characterSeamsOk()) {
      log(logger, `[tradeExecutor] character issuer seams unavailable, offer ${currentOfferData.offerId} waits`);
      return { action: "retry" };
    }

    const findRes = await adapter.tradeFindContract({ ownerKind: iss.kind, ownerId: iss.ownerId, offerId: currentOfferData.offerId });
    if (!findRes.ok) return { action: "error", reason: findRes.reason };

    const abort = abortAllowed(findRes, currentOfferData, now, tradeCfg.issueTimeoutMs, lastPermanent.get(currentOfferData.offerId) === true);
    if ((mode === "cleanup" && findRes.found === null) || abort) {
      const reason = mode === "cleanup" ? "DISABLED" : "ISSUE_FAILED";
      const fundRes = await walletLeg(iss, currentOfferData.offerId, "fund", fundIskOf(payload));
      noteWalletResult(fundRes, currentOfferData.offerId, "fund");
      if (!fundRes.ok) {
        if (fundRes.permanent) {
          const abortTx = store.transaction("trade.issue.abort", (db) => {
            const transRes = offers.transitionOfferInTx(db, {
              offerId: currentOfferData.offerId,
              expectedVersion: currentOfferData.version,
              from: S.ISSUING,
              to: S.CANCELLED,
              reason,
              at: now,
            }, transitionKey(currentOfferData.offerId, currentOfferData.stateSeq + 1, S.CANCELLED));
            if (!transRes.ok) return transRes;
            const markRes = journal.markFailed(db, journalId, `aborted:${reason}`);
            if (!markRes.ok) return markRes;
            return { ok: true };
          });
          if (abortTx.ok) {
            lastPermanent.delete(currentOfferData.offerId);
            return { action: "aborted", reason };
          }
          return { action: "error", reason: abortTx.value?.reason || abortTx.reason };
        }
        return { action: "retry" };
      }
      const defundRes = await walletLeg(iss, currentOfferData.offerId, "defund", -fundIskOf(payload));
      noteWalletResult(defundRes, currentOfferData.offerId, "defund");
      if (!defundRes.ok && defundRes.reason === "INSUFFICIENT_FUNDS") {
        metric(telemetry, "trade.defundShort", 1);
      }
      const abortTx = store.transaction("trade.issue.abort", (db) => {
        const transRes = offers.transitionOfferInTx(db, {
          offerId: currentOfferData.offerId,
          expectedVersion: currentOfferData.version,
          from: S.ISSUING,
          to: S.CANCELLED,
          reason,
          at: now,
        }, transitionKey(currentOfferData.offerId, currentOfferData.stateSeq + 1, S.CANCELLED));
        if (!transRes.ok) return transRes;
        const markRes = journal.markFailed(db, journalId, `aborted:${reason}`);
        if (!markRes.ok) return markRes;
        return { ok: true };
      });
      if (abortTx.ok) {
        lastPermanent.delete(currentOfferData.offerId);
        return { action: "aborted", reason };
      }
      return { action: "error", reason: abortTx.value?.reason || abortTx.reason };
    }

    if (findRes.found === "record") {
      const contractId = findRes.contractId;
      const txRes = store.transaction("trade.issuing_open", (db) => {
        const transRes = offers.transitionOfferInTx(db, {
          offerId: currentOfferData.offerId,
          expectedVersion: currentOfferData.version,
          from: S.ISSUING,
          to: S.OPEN,
          reason: "",
          at: now,
          patch: { contractId },
          ...openFeeSpec,
        }, transitionKey(currentOfferData.offerId, currentOfferData.stateSeq + 1, S.OPEN));
        if (!transRes.ok) return transRes;
        const markRes = journal.markApplied(db, journalId);
        if (!markRes.ok) return markRes;
        return { ok: true, offer: transRes.offer, feeChargedIsk: transRes.feeChargedIsk, feeShortIsk: transRes.feeShortIsk };
      });
      if (txRes.ok && txRes.value.ok) {
        noteFeeCharged(txRes.value);
        if (findRes.duplicates > 0) log(logger, `[tradeExecutor] duplicate contracts for ${currentOfferData.offerId}: ${findRes.duplicates}`);
        return { action: "opened", contractId };
      }
      return { action: "error", reason: txRes.value?.reason || txRes.reason };
    }

    if (findRes.found === "pending") {
      return { action: "retry" };
    }

    if (mode === "cleanup") return { action: "retry" };

    const fundRes = await walletLeg(iss, currentOfferData.offerId, "fund", fundIskOf(payload));
    noteWalletResult(fundRes, currentOfferData.offerId, "fund");
    if (!fundRes.ok) {
      if (fundRes.permanent) {
        const abortTx = store.transaction("trade.issue.abort", (db) => {
          const transRes = offers.transitionOfferInTx(db, {
            offerId: currentOfferData.offerId,
            expectedVersion: currentOfferData.version,
            from: S.ISSUING,
            to: S.CANCELLED,
            reason: "ISSUE_FAILED",
            at: now,
          }, transitionKey(currentOfferData.offerId, currentOfferData.stateSeq + 1, S.CANCELLED));
          if (!transRes.ok) return transRes;
          const markRes = journal.markFailed(db, journalId, `aborted:fund_${fundRes.reason}`);
          if (!markRes.ok) return markRes;
          return { ok: true };
        });
        if (abortTx.ok) {
          return { action: "aborted", reason: fundRes.reason };
        }
        return { action: "error", reason: abortTx.value?.reason || abortTx.reason };
      }
      return { action: "retry" };
    }

    const createRes = await adapter.tradeCreateContract(payload);
    if (!createRes.ok) {
      if (createRes.rejected === true) {
        metric(telemetry, "trade.createRejected", 1);
        log(logger, `[tradeExecutor] create rejected offer ${currentOfferData.offerId}: ${createRes.detail || ""}`);
      }
      if (createRes.reason === "CONTRACT_LIMIT") metric(telemetry, METRIC_CONTRACT_LIMIT, 1);
      if (createRes.permanent) {
        lastPermanent.set(currentOfferData.offerId, true);
        const abort2 = abortAllowed(null, currentOfferData, now, tradeCfg.issueTimeoutMs, true);
        if (abort2) {
          const defundRes = await walletLeg(iss, currentOfferData.offerId, "defund", -fundIskOf(payload));
          noteWalletResult(defundRes, currentOfferData.offerId, "defund");
          if (!defundRes.ok && defundRes.reason === "INSUFFICIENT_FUNDS") {
            metric(telemetry, "trade.defundShort", 1);
          }
          const abortTx = store.transaction("trade.issue.abort", (db) => {
            const transRes = offers.transitionOfferInTx(db, {
              offerId: currentOfferData.offerId,
              expectedVersion: currentOfferData.version,
              from: S.ISSUING,
              to: S.CANCELLED,
              reason: "ISSUE_FAILED",
              at: now,
            }, transitionKey(currentOfferData.offerId, currentOfferData.stateSeq + 1, S.CANCELLED));
            if (!transRes.ok) return transRes;
            const markRes = journal.markFailed(db, journalId, `aborted:create_${createRes.reason}`);
            if (!markRes.ok) return markRes;
            return { ok: true };
          });
          if (abortTx.ok) {
            lastPermanent.delete(currentOfferData.offerId);
            return { action: "aborted", reason: createRes.reason };
          }
          return { action: "error", reason: abortTx.value?.reason || abortTx.reason };
        }
        return { action: "retry" };
      }
      return { action: "retry" };
    }

    const contractId = createRes.contractId;
    if (!Number.isSafeInteger(contractId) || contractId <= 0) {
      metric(telemetry, "trade.createRejected", 1);
      log(logger, `[tradeExecutor] create returned no contractId for offer ${currentOfferData.offerId}`);
      return { action: "retry" };
    }
    const txRes = store.transaction("trade.issuing_open", (db) => {
      const transRes = offers.transitionOfferInTx(db, {
        offerId: currentOfferData.offerId,
        expectedVersion: currentOfferData.version,
        from: S.ISSUING,
        to: S.OPEN,
        reason: "",
        at: now,
        patch: { contractId },
        ...openFeeSpec,
      }, transitionKey(currentOfferData.offerId, currentOfferData.stateSeq + 1, S.OPEN));
      if (!transRes.ok) return transRes;
      const markRes = journal.markApplied(db, journalId);
      if (!markRes.ok) return markRes;
      return { ok: true, offer: transRes.offer, feeChargedIsk: transRes.feeChargedIsk, feeShortIsk: transRes.feeShortIsk };
    });
    if (txRes.ok && txRes.value?.ok) {
      noteFeeCharged(txRes.value);
      if (createRes.duplicate) log(logger, `[tradeExecutor] duplicate contracts for ${currentOfferData.offerId}`);
      return { action: "opened", contractId };
    }
    return { action: "error", reason: txRes.value?.reason || txRes.reason };
  }

  async function stepPoll(offer, station) {
    const readRes = await adapter.tradeReadContract(offer.contractId);
    if (!readRes.ok) return { action: "error", reason: readRes.reason };

    const contract = readRes.contract;
    if (!contract) {
      await transitionToCancelled(offer, "CONTRACT_MISSING", "poll:missing");
      return { action: "closed", reason: "CONTRACT_MISSING" };
    }

    if (contract.status === "FINISHED") {
      const acceptorId = contract.acceptorKind === "character" ? contract.acceptorId : null;
      const at = clock.now();
      let decision = null;
      const txRes = store.transaction("trade.open_accepted", (db) => {
        const transRes = offers.transitionOfferInTx(db, {
          offerId: offer.offerId,
          expectedVersion: offer.version,
          from: S.OPEN,
          to: S.ACCEPTED,
          reason: "",
          at,
          patch: { acceptorCharacterId: acceptorId },
        }, transitionKey(offer.offerId, offer.stateSeq + 1, S.ACCEPTED));
        if (!transRes.ok) return transRes;
        if (transRes.duplicate !== true && deliveryStanding !== null) {
          const d = deliveryStanding.decideInTx(db, transRes.offer, at);
          if (d.ok !== true) throw new StandingRollback(d);
          decision = d;
        }
        return { ok: true, offer: transRes.offer };
      });
      if (txRes.ok && txRes.value.ok) {
        deliveryStanding?.noteCommitted(decision);
        return { action: "accepted" };
      }
      if (txRes.error instanceof StandingRollback) {
        deliveryStanding?.noteWriteFailed(txRes.error.refusal);
        return { action: "error", reason: "STANDING_WRITE_FAILED", detail: txRes.error.refusal?.detail };
      }
      return { action: "error", reason: txRes.value?.reason || txRes.reason };
    }

    const iss = issuerOf(offer, tradeCfg.walletAccountKey);
    const walletBlocked = iss.kind === S.ISSUER_KIND_CHARACTER && !characterSeamsOk();

    if (contract.status === "REJECTED") {
      if (walletBlocked) return { action: "retry" };
      const ceoId = await deleteCeoOf(iss);
      const delRes = await adapter.tradeDeleteContract({
        contractId: offer.contractId,
        ceoId,
        corporationId: iss.corporationId,
      });
      if (!delRes.ok) {
        if (delRes.pending) return { action: "retry" };
        return { action: "error", reason: delRes.reason };
      }
      const defundRes = await walletLeg(iss, offer.offerId, "defund", -offer.iskTotal);
      noteWalletResult(defundRes, offer.offerId, "defund");
      if (!defundRes.ok && defundRes.reason === "INSUFFICIENT_FUNDS") metric(telemetry, "trade.defundShort", 1);
      await transitionToCancelled(offer, S.END_REASON_REJECTED, "poll:rejected");
      metric(telemetry, "trade.privateRejected", 1);
      return { action: "closed", reason: S.END_REASON_REJECTED };
    }

    if (contract.status === "DELETED") {
      if (walletBlocked) return { action: "retry" };
      const defundRes = await walletLeg(iss, offer.offerId, "defund", -offer.iskTotal);
      noteWalletResult(defundRes, offer.offerId, "defund");
      if (!defundRes.ok && defundRes.reason === "INSUFFICIENT_FUNDS") metric(telemetry, "trade.defundShort", 1);

      const closeReason = closeWanted(offer, station, clock.now(), mode) || "DELETED_EXTERNALLY";
      await transitionToCancelled(offer, closeReason, "poll:deleted");
      return { action: "closed", reason: closeReason };
    }

    if (contract.status === "OUTSTANDING" && contract.pendingKind) {
      return { action: "retry" };
    }

    if (contract.status === "OUTSTANDING") {
      const closeReason = closeWanted(offer, station, clock.now(), mode);
      if (closeReason) {
        if (walletBlocked) return { action: "retry" };
        const delRes = await adapter.tradeDeleteContract({
          contractId: offer.contractId,
          ceoId: await deleteCeoOf(iss),
          corporationId: iss.corporationId,
        });
        if (!delRes.ok) {
          if (delRes.pending) return { action: "retry" };
          return { action: "error", reason: delRes.reason };
        }
        const defundRes = await walletLeg(iss, offer.offerId, "defund", -offer.iskTotal);
        noteWalletResult(defundRes, offer.offerId, "defund");
        if (!defundRes.ok && defundRes.reason === "INSUFFICIENT_FUNDS") metric(telemetry, "trade.defundShort", 1);

        await transitionToCancelled(offer, closeReason, "poll:closeWanted");
        return { action: "closed", reason: closeReason };
      }
      return { action: "retry" };
    }

    const closeReason = closeWanted(offer, station, clock.now(), mode) || "DELETED_EXTERNALLY";
    await transitionToCancelled(offer, closeReason, "poll:other");
    return { action: "closed", reason: closeReason };
  }

  async function transitionToCancelled(offer, reason, context) {
    const txRes = store.transaction(`trade.cancel_${context}`, (db) => {
      return offers.transitionOfferInTx(db, {
        offerId: offer.offerId,
        expectedVersion: offer.version,
        from: offer.state,
        to: S.CANCELLED,
        reason,
        at: clock.now(),
      }, transitionKey(offer.offerId, offer.stateSeq + 1, S.CANCELLED));
    });
    if (!txRes.ok || !txRes.value.ok) {
      log(logger, `[tradeExecutor] cancel failed: ${txRes.value?.reason || txRes.reason}`);
      return;
    }
    const stockBack = txRes.value.stockBack;
    if (stockBack && stockBack.lost > 0) metric(telemetry, METRIC_WTS_STOCK_LOST, stockBack.lost);
  }

  async function readIssuer(corporationId) {
    const res = await adapter.tradeReadIssuer(corporationId);
    if (!res.ok || !res.issuer) return null;
    return res.issuer;
  }

  async function readAcceptedOffers(store, offersRepo, afterOfferId, limit, sellOnly = false) {
    const txRes = store.transaction("trade.executor.read_accepted", (db) => {
      const stmt = db.prepare(sellOnly
        ? "SELECT * FROM world_trade_offers WHERE state = ? AND offer_id > ? AND side = 'sell' ORDER BY offer_id LIMIT ?"
        : "SELECT * FROM world_trade_offers WHERE state = ? AND offer_id > ? ORDER BY offer_id LIMIT ?"
      );
      const rows = stmt.all(S.ACCEPTED, afterOfferId || "", limit);
      const acceptedOffers = rows.map(row => {
        return {
          offerId: row.offer_id,
          factionId: row.faction_id,
          stationId: row.station_id,
          systemId: row.system_id,
          issuerCorporationId: row.issuer_corporation_id,
          itemKind: row.item_kind,
          itemKey: row.item_key,
          typeId: row.type_id,
          quantity: row.quantity,
          unitPriceMilli: row.unit_price_milli,
          iskTotal: row.isk_total,
          refPriceMilli: row.ref_price_milli,
          capPriceMilli: row.cap_price_milli,
          priceSource: row.price_source,
          state: row.state,
          stateSeq: row.state_seq,
          endReason: row.end_reason,
          contractId: row.contract_id,
          acceptorCharacterId: row.acceptor_character_id,
          deliveredQuantity: row.delivered_quantity,
          createdAt: row.created_at,
          expiresAt: row.expires_at,
          updatedAt: row.updated_at,
          endedAt: row.ended_at,
          version: row.version,
          issuerCharacterId: row.issuer_character_id ?? null,
          issuerCharacterCorpId: row.issuer_character_corp_id ?? null,
          channel: row.channel || "contract",
          marketOrderId: row.market_order_id ?? null,
          filledQuantity: row.filled_quantity ?? 0,
          side: row.side || S.SIDE_BUY,
        };
      });
      return acceptedOffers;
    });
    if (!txRes.ok) {
      log(logger, `[tradeExecutor] readAcceptedOffers failed: ${txRes.reason}`);
      return [];
    }
    return txRes.value;
  }

  async function readAcceptedStations(store, offerIds) {
    if (!offerIds || offerIds.length === 0) return new Map();
    const txRes = store.transaction("trade.executor.read_accepted_stations", (db) => {
      const placeholders = offerIds.map(() => "?").join(",");
      const stmt = db.prepare(
        "SELECT station_id, system_id, kind, state, npc_station_id, owner_corporation_id, destroyed_at FROM world_stations WHERE station_id IN (" + placeholders + ")"
      );
      const rows = stmt.all(...offerIds);
      const stations = new Map();
      for (const r of rows) {
        const npcStationId = r.npc_station_id ? Number(r.npc_station_id) : null;
        stations.set(r.station_id, {
          stationId: npcStationId,
          systemId: r.system_id,
          kind: r.kind,
          online: r.state === "ONLINE",
          npcStationId,
          ownerCorporationId: r.owner_corporation_id,
          destroyed: r.destroyed_at !== null,
        });
      }
      return stations;
    });
    if (!txRes.ok) {
      log(logger, `[tradeExecutor] readAcceptedStations failed: ${txRes.reason}`);
      return new Map();
    }
    return txRes.value;
  }

  async function readAcceptedOffersWithStations(store, offersRepo, afterOfferId, limit, sellOnly = false) {
    const offers = await readAcceptedOffers(store, offersRepo, afterOfferId, limit, sellOnly);
    if (offers.length === 0) return { offers: [], stations: new Map() };
    const stationIds = [...new Set(offers.map(o => o.stationId))];
    const stations = await readAcceptedStations(store, stationIds);
    return { offers, stations };
  }

  function exhaustIntake(offerId, sell = false) {
    const txRes = store.transaction("trade.intake.exhausted", (db) => {
      const curRes = offers.getOffer(db, offerId);
      if (!curRes || curRes.ok !== true) throw new ExhaustRollback(curRes || { reason: "OFFER_READ_FAILED" });
      const current = curRes.offer;
      if (!current || current.state !== S.INTAKE) return { outcome: "STALE" };
      const found = journal.findByKey(db, sell ? S.returnOutboxKey(offerId) : intakeOutboxKey(offerId));
      if (found && found.ok && found.found && found.entry && found.entry.state === "PENDING") {
        const markRes = journal.markFailed(db, found.entry.journalId, `lost:${INTAKE_RETRIES_EXHAUSTED}`);
        if (!markRes.ok) throw new ExhaustRollback(markRes);
      }
      const trRes = offers.transitionOfferInTx(db, {
        offerId,
        expectedVersion: current.version,
        from: S.INTAKE,
        to: S.LOST,
        reason: INTAKE_RETRIES_EXHAUSTED,
        at: clock.now(),
      }, transitionKey(offerId, current.stateSeq + 1, S.LOST));
      if (!trRes || !trRes.ok) throw new ExhaustRollback(trRes || { reason: "TRANSITION_FAILED" });
      return { outcome: "LOST", quantity: current.quantity };
    });
    if (!txRes.ok) {
      const refusal = txRes.error instanceof ExhaustRollback ? txRes.error.refusal : null;
      return { ok: false, reason: String((refusal && refusal.reason) || txRes.reason || "TX_FAILED") };
    }
    if (sell && txRes.value.outcome === "LOST" && txRes.value.quantity > 0) {
      metric(telemetry, METRIC_WTS_STOCK_LOST, txRes.value.quantity);
    }
    return { ok: true, outcome: txRes.value.outcome };
  }

  async function readIntakeOffers(store, afterOfferId, limit) {
    const txRes = store.transaction("trade.executor.read_intake", (db) => {
      const after = afterOfferId || "";
      const rows = db.prepare(
        "SELECT * FROM world_trade_offers WHERE state = ? AND offer_id > ? ORDER BY offer_id LIMIT ?"
      ).all(S.INTAKE, after, limit);
      if (rows.length < limit && after !== "") {
        const head = db.prepare(
          "SELECT * FROM world_trade_offers WHERE state = ? AND offer_id <= ? ORDER BY offer_id LIMIT ?"
        ).all(S.INTAKE, after, limit - rows.length);
        rows.push(...head);
      }
      return rows.map(row => ({
        offerId: row.offer_id,
        factionId: row.faction_id,
        stationId: row.station_id,
        systemId: row.system_id,
        issuerCorporationId: row.issuer_corporation_id,
        itemKind: row.item_kind,
        itemKey: row.item_key,
        typeId: row.type_id,
        quantity: row.quantity,
        unitPriceMilli: row.unit_price_milli,
        iskTotal: row.isk_total,
        refPriceMilli: row.ref_price_milli,
        capPriceMilli: row.cap_price_milli,
        priceSource: row.price_source,
        state: row.state,
        stateSeq: row.state_seq,
        endReason: row.end_reason,
        contractId: row.contract_id,
        acceptorCharacterId: row.acceptor_character_id,
        deliveredQuantity: row.delivered_quantity,
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        updatedAt: row.updated_at,
        endedAt: row.ended_at,
        version: row.version,
        issuerCharacterId: row.issuer_character_id ?? null,
        issuerCharacterCorpId: row.issuer_character_corp_id ?? null,
        channel: row.channel || "contract",
        marketOrderId: row.market_order_id ?? null,
        filledQuantity: row.filled_quantity ?? 0,
        side: row.side || S.SIDE_BUY,
      }));
    });
    if (!txRes.ok) {
      log(logger, `[tradeExecutor] readIntakeOffers failed: ${txRes.reason}`);
      return [];
    }
    return txRes.value;
  }

  function priceFailure(now, reason, detail) {
    priceStatus.failed += 1;
    priceStatus.failuresByReason[reason] = (priceStatus.failuresByReason[reason] || 0) + 1;
    const changed = priceStatus.lastRefusal !== reason;
    priceStatus.lastRefusal = reason;
    priceStatus.lastRefusalDetail = detail === undefined || detail === null ? null : String(detail).slice(0, 200);
    priceStatus.lastRefusalAt = now;
    metric(telemetry, "trade.priceRefreshFailed", 1);
    if (changed) log(logger, `[tradeExecutor] price refresh failed: ${reason}${priceStatus.lastRefusalDetail ? ` ${priceStatus.lastRefusalDetail}` : ""}`);
    return { ok: false, reason };
  }

  async function readLocalPrices() {
    if (!adapter || typeof adapter.readTradePrices !== "function") return { ok: false, reason: "PRICE_SEAM_MISSING" };
    const regionIds = [priceRegionId].slice(0, maxPriceRegions);
    const own = store.transaction("trade.executor.own_orders", (db) => offers.listOpenMarketOrderIds(db, sweepMaxRows));
    const excludeOrderIds = own.ok && own.value && own.value.ok === true ? own.value.orderIds : [];
    let priceRes;
    try {
      priceRes = await adapter.readTradePrices({
        typeIds: [...catalog.priceTypeIds], refRegionId: priceRegionId, regionIds, maxRegions: maxPriceRegions,
        ...(excludeOrderIds.length > 0 ? { excludeOrderIds } : {}),
        ...(commodityBaseOn && excludeOrderIds.length > 0 && commodityTypeIds.length > 0
          ? { excludeSellTypeIds: commodityTypeIds } : {}),
      });
    } catch (err) {
      return { ok: false, reason: "PRICE_READ_THREW", detail: (err && err.message) || err };
    }
    if (!priceRes || priceRes.ok !== true || !(priceRes.prices instanceof Map)) {
      return { ok: false, reason: String((priceRes && priceRes.reason) || "PRICE_READ_FAILED"),
        detail: priceRes && priceRes.detail };
    }
    return { ok: true, prices: priceRes.prices,
      errors: Number.isSafeInteger(priceRes.errors) ? priceRes.errors : 0,
      aborted: typeof priceRes.aborted === "string" ? priceRes.aborted : null,
      failedTypeIds: Array.isArray(priceRes.failedTypeIds) ? priceRes.failedTypeIds : null,
      regionErrors: Number.isSafeInteger(priceRes.regionErrors) ? priceRes.regionErrors : null };
  }

  async function refreshPrices(now) {
    priceStatus.seq += 1;
    priceStatus.lastAttemptAt = now;
    let snap = null;
    if (externalPrices) {
      try { snap = externalPrices.peekSnapshot(now); } catch (_err) { snap = null; }
    }
    const seamMissing = !adapter || typeof adapter.readTradePrices !== "function";
    if (seamMissing && snap === null) return priceFailure(now, "PRICE_SEAM_MISSING");
    if (!priceCache || typeof priceCache.put !== "function") return priceFailure(now, "PRICE_CACHE_MISSING");
    const local = await readLocalPrices();
    priceStatus.lastLocalRefusal = null;
    if (!local.ok) {
      if (snap === null) return priceFailure(now, local.reason, local.detail);
      priceStatus.lastLocalRefusal = local.detail ? `${local.reason} ${String(local.detail).slice(0, 200)}` : local.reason;
    }
    const localPrices = local.ok ? local.prices : new Map();
    priceStatus.lastReadAborted = local.ok ? local.aborted : null;
    const readErrors = local.ok ? local.errors : 0;
    const typeIds = [...localPrices.keys()];
    if (snap !== null) {
      for (const typeId of catalog.priceTypeIds) if (!localPrices.has(typeId)) typeIds.push(typeId);
    }
    let stored = 0;
    let rejected = 0;
    let noAsk = 0;
    let external = 0;
    let externalRejected = 0;
    const localClean = local.ok && readErrors === 0 && local.aborted === null;
    const mergeParams = { maxRatio: externalPriceMaxRatio, localClean,
      askCapIncludesExternal: tradeCfg.askCapIncludesExternal === true };
    const commodityKinds = catalog.commodityKinds || {};
    const isCommodity = (t) => commodityBaseOn && Object.prototype.hasOwnProperty.call(commodityKinds, `type:${t}`);
    const perType = local.ok && Array.isArray(local.failedTypeIds) && Number.isSafeInteger(local.regionErrors);
    const failed = new Set(perType ? local.failedTypeIds : []);
    const typeClean = (t) => (perType
      ? local.aborted === null && local.regionErrors === 0 && !failed.has(t) : localClean);
    let base = 0;
    let baseMissing = 0;
    for (const typeId of typeIds) {
      const extEntry = snap !== null ? (snap.prices.get(typeId) || null) : null;
      const commodity = isCommodity(typeId);
      const params = commodity ? { ...mergeParams, localClean: typeClean(typeId) } : mergeParams;
      const localEntry = localPrices.get(typeId) || null;
      const merged = mergePriceRefs(localEntry, extEntry, params);
      if (merged.extRejected === "DEVIATION") externalRejected += 1;
      let refs = merged.refs;
      if (refs === null && commodity && params.localClean === true) {
        refs = basePriceRefs(localEntry, { askPermille: commodityBaseAskPermille, maxUnitPriceMilli });
        if (refs === null) baseMissing += 1;
      }
      if (refs === null) { noAsk += 1; continue; }
      const put = priceCache.put(typeId, refs, now);
      if (put && put.ok === false) rejected += 1;
      else {
        stored += 1;
        if (refs.origin === "external") external += 1;
        else if (refs.origin === "base") base += 1;
      }
    }
    if (commodityBaseOn) {
      priceStatus.lastBase = base;
      priceStatus.lastBaseMissing = baseMissing;
      if (base > 0) metric(telemetry, "trade.priceMergedBase", base);
    }
    priceStatus.lastNoAsk = noAsk;
    priceStatus.lastReadErrors = readErrors;
    priceStatus.lastExternal = external;
    priceStatus.lastExternalRejected = externalRejected;
    if (externalRejected > 0) metric(telemetry, "trade.externalPriceTypeRejected", externalRejected);
    if (external > 0) metric(telemetry, "trade.priceMergedExternal", external);
    if (stored === 0) {
      if (!local.ok) return priceFailure(now, local.reason, local.detail);
      const detail = `prices=${localPrices.size} noAsk=${noAsk} rejected=${rejected} errors=${readErrors}`;
      if (readErrors > 0) return priceFailure(now, "MARKET_UNREACHABLE", detail);
      return priceFailure(now, rejected > 0 ? "PRICE_NONE_STORED" : "MARKET_NO_ASK", detail);
    }
    priceStatus.refreshed += 1;
    priceStatus.lastRefreshAt = now;
    priceStatus.lastStored = stored;
    priceStatus.lastRejected = rejected;
    if (priceStatus.lastRefusal !== null) log(logger, `[tradeExecutor] price refresh ok again: ${stored} types`);
    priceStatus.lastRefusal = null;
    priceStatus.lastRefusalDetail = null;
    metric(telemetry, "trade.priceRefresh", 1);
    return { ok: true, stored, rejected };
  }

  function start() {
    if (state !== STATE.IDLE) return { ok: false, reason: state === STATE.STOPPED ? "stopped" : "already_started" };
    state = STATE.RUNNING;
    arm(executorPollMs);
    return { ok: true };
  }

  function stop(reason) {
    if (state === STATE.STOPPED) return;
    state = STATE.STOPPED;
    cancelTimer();
  }

  function nudge() {
    if (state !== STATE.RUNNING) return;
    if (runningPass) { rerun = true; return; }
    arm(0);
  }

  function getStatus() {
    return Object.freeze({
      state,
      passes,
      runningPass,
      mode,
      pollCursor,
      config: {
        executorPollMs, maxIssuesPerPass, maxPollsPerPass, maxClosesPerPass,
        issueTimeoutMs, priceRefreshMs, priceRetryMs, contractsEnabled,
        externalPriceEnabled: tradeCfg.externalPriceEnabled === true,
      },
      prices: Object.freeze({ ...priceStatus, failuresByReason: Object.freeze({ ...priceStatus.failuresByReason }) }),
      orphanScan: {
        done: orphanScanDone,
        cursor: orphanCursor,
      },
      marketOrphanScan: {
        done: marketOrphanScanDone,
        cursor: marketOrphanCursor,
        corpIndex: marketOrphanCorpIndex,
        lastScanAt: lastMarketOrphanScanAt,
        maxPerPass: maxBuyOrderOrphansPerPass,
        scanIntervalMs: marketOrphanScanMs,
      },
      refundSweep: {
        maxPerPass: maxRefundSweepsPerPass,
        buyOrderWalletAccountKey,
        walletAccountKey,
        blocked: buyOrderWalletAccountKey === Math.trunc((tradeCfg.walletAccountKey || 1000)),
        corpIndex: sweepState.corpIndex,
      },
      wts: Object.freeze({ proceedsWait: wtsProceedsWait }),
      market: Object.freeze({ enabled: buyOrdersEnabled, ready: marketReady, reason: marketReason,
        down: marketSteps.isDown(), maxPollsPerPass: maxBuyOrderPollsPerPass, maxClosesPerPass: maxBuyOrderClosesPerPass,
        tripped: marketSteps.isTripped(), issueFailures: marketSteps.issueFailures(),
        maxIssueFailures: marketSteps.maxIssueFailures() }),
    });
  }

  return Object.freeze({ start, stop, nudge, runPass, getStatus });
}

module.exports = { createTradeExecutor, TRADE_SEAM_UNAVAILABLE };