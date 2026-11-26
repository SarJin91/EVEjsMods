"use strict";

const { reviewRowBound, reactiveRowBound, blockadeRowsOf, withDepartureRows, advancedStartRows,
  fortressTxRowsOf, battleAnnounceTxRowsOf, transitTxRowsOf, listeningPostTxRowsOf } = require("./reviewRows");
const { sentryFactionParamsOf } = require("./sentryParams");
const { ROWS_PER_DISPATCH, ROWS_PER_LOAD, convoyStepRows, convoyDispatchRows } = require("../economy/schema");

const BOUND_NAMES = Object.freeze(["review", "reactive", "convoyStep", "miningDispatch", "miningLoad"]);

let shippedMaxAdvancedDeltas = null;

function maxAdvancedDeltasOf(catalog, groups) {
  if (!catalog && shippedMaxAdvancedDeltas !== null) return shippedMaxAdvancedDeltas;
  let cat = catalog || null;
  let list = groups || null;
  if (!cat) {
    const DATA = require("../economy/data/commodities");
    const made = require("../economy/extraction/catalog").createCommodityCatalog(DATA);
    cat = made.ok ? made.catalog : null;
    list = Object.keys(DATA.ADVANCED_BILLS || {});
  }
  let max = 0;
  if (cat) {
    for (const g of list || []) {
      const bill = cat.advancedBillOf(g);
      max = Math.max(max, bill.moon.length + bill.pi.length);
    }
  }
  if (!catalog) shippedMaxAdvancedDeltas = max;
  return max;
}

function advancedStartRowsOfConfig(config) {
  const prc = (config && config.production) || {};
  if (prc.advancedInputsEnabled !== true || !Number.isSafeInteger(prc.advancedInputsPermille)
    || prc.advancedInputsPermille <= 0) return 0;
  const stations = (config && config.stations) || {};
  return advancedStartRows(maxAdvancedDeltasOf(), stations.maxDeltasPerChange);
}

function rowBoundsOfConfig(config) {
  const c = config || {};
  const st = withDepartureRows(c.strategy, c);
  const none = { review: null, reactive: null, convoyStep: null, miningDispatch: null, miningLoad: null };
  if (!st) return none;
  const section = (name) => c[name] || {};
  const strategyOn = Boolean(c.modules && c.modules.strategy && c.modules.strategy.enabled === true);
  const mc = section("mining");
  const prc = section("production");
  const uc = section("upkeep");
  const lc = section("logistics");
  const siege = section("siege");
  const stations = section("stations");
  const trade = section("trade");
  const tc = section("tribute");
  const ty = section("treasury");
  const miningOn = mc.enabled === true && strategyOn;
  const productionOn = prc.enabled === true && strategyOn;
  const upkeepOn = uc.enabled === true && strategyOn;
  const logisticsOn = lc.enabled === true && strategyOn;
  const constructionOn = section("construction").enabled === true && stations.enabled === true && strategyOn;
  const reliefOn = siege.enabled === true && siege.reliefEnabled === true && stations.enabled === true && strategyOn;
  const tradeOn = trade.enabled === true && strategyOn;
  const defenseOn = strategyOn && st.defenseEnabled === true;
  const tributeOn = tc.enabled === true && logisticsOn && tc.ratePermille > 0;
  const treasuryOn = ty.enabled === true && strategyOn;
  const relief = reliefOn ? { maxReliefPerReview: siege.maxReliefPerReview } : null;
  const defense = defenseOn ? { maxDefensePerReview: st.maxDefensePerReview } : null;
  const reviewDefense = defenseOn && st.intruderDefenseEnabled === true
    ? { maxDefensePerReview: st.maxDefensePerReview + (st.intruderMaxPerReview || 0) } : defense;
  const K = blockadeRowsOf(st);
  const advancedRows = productionOn ? advancedStartRowsOfConfig(c) : 0;
  const production = productionOn ? (advancedRows > 0 ? { ...prc, advancedStartRows: advancedRows } : prc) : null;
  const review = reviewRowBound(st, miningOn ? mc : null, production, upkeepOn
    ? { maxAbandonsPerReview: uc.maxAbandonsPerReview, maxFactionsPerSystem: section("world").maxFactionsPerSystem,
      deficitReliefEnabled: uc.deficitReliefEnabled === true, maxDisbandsPerReview: uc.maxDisbandsPerReview,
      ...(uc.iskTopUpEnabled === true ? { iskTopUpEnabled: true } : {}) }
    : null, logisticsOn ? lc : null, constructionOn ? c.construction : null, relief,
  tradeOn ? { maxOffersPerReview: trade.maxOffersPerReview, maxCancelsPerReview: trade.maxCancelsPerReview,
    ...(trade.wtsEnabled === true ? { wtsOffersPerReview: trade.wtsOffersPerReview } : {}) } : null,
  reviewDefense, tributeOn ? {} : null, treasuryOn ? { pruneBatch: ty.pruneBatch } : null,
  strategyOn && st.mergeEnabled === true ? { maxMergesPerReview: st.maxMergesPerReview } : null,
  sentryFactionParamsOf(c),
  { swarmEnabled: strategyOn && section("hive").enabled === true && section("hive").swarmEnabled === true });
  const T = fortressTxRowsOf(c) + battleAnnounceTxRowsOf(c) + transitTxRowsOf(c) + listeningPostTxRowsOf(c);
  return {
    review: review + T,
    reactive: strategyOn ? reactiveRowBound(st, relief, defense, 3 * st.reactivePruneBatch) + T : null,
    convoyStep: logisticsOn ? Math.max(convoyStepRows(lc.maxCargoItems), convoyDispatchRows(lc.maxCargoItems)
      + lc.pruneBatch) + K + T : null,
    miningDispatch: miningOn ? ROWS_PER_DISPATCH + K + mc.pruneBatch + T : null,
    miningLoad: miningOn ? ROWS_PER_LOAD + K + T : null,
  };
}

function rowBoundOverflow(bounds, limit) {
  if (!Number.isSafeInteger(limit) || limit < 1) return null;
  for (const name of BOUND_NAMES) {
    const v = bounds[name];
    if (Number.isFinite(v) && v > limit) return `${name}=${v} > persistence.maxRowsPerTransaction=${limit}`;
  }
  return null;
}

module.exports = { rowBoundsOfConfig, rowBoundOverflow, BOUND_NAMES, advancedStartRowsOfConfig, maxAdvancedDeltasOf };
