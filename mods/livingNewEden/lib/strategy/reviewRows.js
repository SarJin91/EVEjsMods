"use strict";

const MINING_DISPATCH_ROWS = 14;
const PRODUCTION_START_ROWS = 13;
const PRODUCTION_START_MINERALS = 7;
const STOCK_CHANGE_FIXED_ROWS = 2;
const MAX_GROUPS_PER_TAKE = 18;
const HULL_TAKE_ROWS = MAX_GROUPS_PER_TAKE + 2;
const CONVOY_DISPATCH_BASE_ROWS = 18;
const RELEASE_ROWS = 5;
const UPKEEP_ROWS = 3;
const UPKEEP_ABANDON_ROWS = 2;
const UPKEEP_TRADE_ROWS = 3;
const UNIT_PURCHASE_ROWS = 5;
const REPLENISH_FLEET_ROWS = 2;
const REPLENISH_FACTION_ROWS = 2;
const BUILD_PLAN_ROWS = 5;
const SENTRY_BUILD_ROWS = 7;
const TRADE_OFFER_ROWS = 4;
const TRADE_CANCEL_ROWS = 4;
const WTS_EXTRA_ROWS = 2;
const TRIM_PLAN_ROWS = 3;
const TRIM_SYSTEM_ROWS = 4;
const TRIBUTE_MARKER_ROWS = 1;
const HIVE_SWARM_MARKER_ROWS = 1;
const TREASURY_BASE_ROWS = 8;

const ROWS = Object.freeze({ touch: 2, done: 2, observe: 3, close: 3, refit: 5, launchWrapper: 1, mobilize: 4,
  operation: 2, joinPerFleet: 2, planPerFleet: 3, activation: 2, signal: 12, standaloneMobilize: 5, territoryMark: 3 });
const DISBAND_FLEET_ROWS = 2;
const UPGRADE_FLEET_ROWS = 2;
const UPGRADE_ROWS = ROWS.launchWrapper + HULL_TAKE_ROWS + UPGRADE_FLEET_ROWS;
const RETURN_ROWS = ROWS.launchWrapper + ROWS.operation + ROWS.joinPerFleet + ROWS.planPerFleet + ROWS.activation;
const RETIRE_ROWS = Math.max(ROWS.launchWrapper + DISBAND_FLEET_ROWS + HULL_TAKE_ROWS, RETURN_ROWS);
const MERGE_ROWS = ROWS.launchWrapper + DISBAND_FLEET_ROWS + REPLENISH_FLEET_ROWS;
const GARRISON_RELEASE_ROWS = 3;
const UPKEEP_DISBAND_ROWS = ROWS.launchWrapper + DISBAND_FLEET_ROWS + HULL_TAKE_ROWS;

function blockadeRowsOf(s) {
  const blockade = s && s.blockadeEnabled === true && Number.isSafeInteger(s.blockadeMaxCrossingsPerLeg)
    && s.blockadeMaxCrossingsPerLeg > 0 ? s.blockadeMaxCrossingsPerLeg : 0;
  const extra = s && Number.isSafeInteger(s.departureExtraRows) && s.departureExtraRows > 0 ? s.departureExtraRows : 0;
  return blockade + extra;
}

function gridCrossingRowsOf(config) {
  const g = config && config.grid;
  return g && g.enabled === true && g.movesEnabled === true && g.defense && g.defense.enabled === true
    && g.crossings && g.crossings.enabled === true ? 1 : 0;
}

function blockadeGateOnOf(config) {
  const g = config && config.grid;
  return Boolean(g && g.enabled === true && g.movesEnabled === true && g.crossings
    && g.crossings.blockadeGateEnabled === true);
}

function blockadeGateRowsOf(config) {
  const s = config && config.strategy;
  return blockadeGateOnOf(config) && s && s.blockadeEnabled === true && Number.isSafeInteger(s.blockadeMaxCrossingsPerLeg)
    && s.blockadeMaxCrossingsPerLeg > 0 ? s.blockadeMaxCrossingsPerLeg : 0;
}

function fortressTxRowsOf(config) {
  const f = config && config.fortress;
  if (!f || f.checkpointEnabled !== true) return 0;
  return Number.isSafeInteger(f.maxCheckpointsPerTransaction) && f.maxCheckpointsPerTransaction > 0
    ? f.maxCheckpointsPerTransaction : 1;
}

function battleAnnounceTxRowsOf(config) {
  const b = config && config.battleAnnounce;
  if (!b || b.enabled !== true) return 0;
  return Number.isSafeInteger(b.maxAnnouncementsPerTransaction) && b.maxAnnouncementsPerTransaction > 0
    ? b.maxAnnouncementsPerTransaction : 1;
}

function transitTxRowsOf(config) {
  const t = config && config.transit;
  if (!t || t.enabled !== true || t.mode !== "on") return 0;
  return Number.isSafeInteger(t.maxCheckpointsPerTransaction) && t.maxCheckpointsPerTransaction > 0
    ? t.maxCheckpointsPerTransaction : 1;
}

function listeningPostTxRowsOf(config) {
  const l = config && config.listeningPost;
  if (!l || l.enabled !== true) return 0;
  return Number.isSafeInteger(l.maxEnqueuesPerTransaction) && l.maxEnqueuesPerTransaction > 0
    ? l.maxEnqueuesPerTransaction : 1;
}

function withDepartureRows(strategy, config) {
  const gateRows = blockadeGateRowsOf(config);
  const extra = gridCrossingRowsOf(config) + gateRows;
  if (!(extra > 0) || !strategy) return strategy;
  return { ...strategy, departureExtraRows: extra, ...(gateRows > 0 ? { blockadeGateOn: true } : {}) };
}

function borderPostScanPageOf(s) {
  if (!s || s.blockadeEnabled !== true) return 0;
  const a = Number.isSafeInteger(s.borderPostScanMaxFleets) ? s.borderPostScanMaxFleets : 0;
  const b = Number.isSafeInteger(s.blockadeActivationScanMaxFleets) ? s.blockadeActivationScanMaxFleets : 0;
  return Math.max(0, Math.min(a, b));
}

function borderPostScanRowsOf(s) {
  const page = borderPostScanPageOf(s);
  return s && s.blockadeGateOn === true && page > 0 ? 2 * page + 1 : page;
}

function borderPostRows(blockadeRows, scanRows) {
  return ROWS.launchWrapper + ROWS.operation + ROWS.joinPerFleet + ROWS.planPerFleet + blockadeRows + ROWS.activation
    + scanRows;
}

function advancedStartRows(maxAdvancedDeltas, maxDeltasPerChange) {
  if (!Number.isSafeInteger(maxAdvancedDeltas) || maxAdvancedDeltas <= 0) return 0;
  const per = Number.isSafeInteger(maxDeltasPerChange) && maxDeltasPerChange > 0 ? maxDeltasPerChange
    : Number.MAX_SAFE_INTEGER;
  const chunks = Math.ceil((PRODUCTION_START_MINERALS + maxAdvancedDeltas) / per);
  return maxAdvancedDeltas + STOCK_CHANGE_FIXED_ROWS * (chunks - 1);
}

function reviewRowBound(s, m, p, u, l, c, r, t, d, tr, ty, mg, sf, hv) {
  const hulls = p && p.mobilizeHulls === "required" ? HULL_TAKE_ROWS : 0;
  const F = s.maxFleetsPerOperation;
  const B = blockadeRowsOf(s);
  const launch = ROWS.launchWrapper + ROWS.operation + ROWS.joinPerFleet * F + (ROWS.planPerFleet + B) * F
    + ROWS.activation + ROWS.signal;
  const retire = Math.max(ROWS.launchWrapper + DISBAND_FLEET_ROWS + HULL_TAKE_ROWS, RETURN_ROWS + B);
  const combatMobilize = Math.max(ROWS.mobilize, ROWS.standaloneMobilize) + hulls;
  const startRows = PRODUCTION_START_ROWS + (p && Number.isSafeInteger(p.advancedStartRows) && p.advancedStartRows > 0
    ? p.advancedStartRows : 0);
  return ROWS.touch + ROWS.done + ROWS.observe * s.maxObservationsPerReview + ROWS.close * s.maxHousekeepingPerReview
    + ROWS.refit * s.maxRefitRequestsPerReview + s.maxOperationsPerReview * launch
    + combatMobilize * s.maxMobilizationsPerReview
    + ROWS.territoryMark * (s.maxTerritoryMarksPerReview || 0)
    + (RETURN_ROWS + B) * (s.maxReturnsPerReview || 0)
    + (m ? m.maxDispatchesPerReview * (ROWS.launchWrapper + MINING_DISPATCH_ROWS + B + m.pruneBatch)
      + (ROWS.standaloneMobilize + hulls) * m.maxMobilizationsPerReview
      + RELEASE_ROWS * (m.maxReleasesPerReview || 0) : 0)
    + (p ? p.maxJobsPerReview * (ROWS.launchWrapper + startRows + p.pruneBatch) : 0)
    + (p && p.industryEnabled === true ? (p.maxIndustryJobsPerReview || 0)
      * (ROWS.launchWrapper + startRows + p.pruneBatch) : 0)
    + (hulls > 0 ? UPGRADE_ROWS * (s.maxUpgradesPerReview || 0) : 0)
    + (u ? UPKEEP_ROWS + Math.max(u.maxAbandonsPerReview * (UPKEEP_ABANDON_ROWS + u.maxFactionsPerSystem),
      u.deficitReliefEnabled === true ? (u.maxDisbandsPerReview || 0) * UPKEEP_DISBAND_ROWS : 0) + UPKEEP_TRADE_ROWS
      + (u.iskTopUpEnabled === true ? UNIT_PURCHASE_ROWS : 0)
      : 0)
    + (l ? l.maxDispatchesPerReview * (ROWS.launchWrapper + CONVOY_DISPATCH_BASE_ROWS + B + l.maxCargoItems
      + l.pruneBatch)
      + (ROWS.standaloneMobilize + (l.needsHulls === true ? hulls : 0)) * l.maxMobilizationsPerReview
      + (l.replenishEnabled === true ? (l.maxReplenishPerReview || 0) * (ROWS.launchWrapper + HULL_TAKE_ROWS
        + REPLENISH_FLEET_ROWS + REPLENISH_FACTION_ROWS) : 0)
      + (l.replenishEnabled === true && l.replenishReturnEnabled === true
        ? (l.maxReplenishReturnsPerReview || 0) * (RETURN_ROWS + B) : 0)
      + (l.retireEnabled === true || l.strandedReturnEnabled === true ? (l.maxRetiresPerReview || 0) * retire
        : 0) : 0)
    + Math.max(c ? BUILD_PLAN_ROWS * c.maxBuildsPerReview : 0, sf ? SENTRY_BUILD_ROWS * (sf.maxBuildsPerReview || 0) : 0)
    + (r ? r.maxReliefPerReview * reliefRows(F, B) : 0)
    + (t ? t.maxOffersPerReview * TRADE_OFFER_ROWS + t.maxCancelsPerReview * TRADE_CANCEL_ROWS : 0)
    + (t && Number.isSafeInteger(t.wtsOffersPerReview)
      ? WTS_EXTRA_ROWS * (t.wtsOffersPerReview + t.maxCancelsPerReview) : 0)
    + (s.territoryTrimEnabled === true ? TRIM_PLAN_ROWS : 0)
    + (d ? d.maxDefensePerReview * reliefRows(F, B) : 0)
    + (tr ? TRIBUTE_MARKER_ROWS : 0)
    + (hv && hv.swarmEnabled === true ? HIVE_SWARM_MARKER_ROWS : 0)
    + (ty ? TREASURY_BASE_ROWS + (ty.pruneBatch || 0) : 0)
    + (mg ? MERGE_ROWS * (mg.maxMergesPerReview || 0) : 0)
    + (s.garrisonReleaseEnabled === true ? GARRISON_RELEASE_ROWS * (s.maxGarrisonReleasesPerReview || 0) : 0)
    + (s.strandedReturnEnabled === true ? (s.maxStrandedPerReview || 0) * retire : 0)
    + (s.borderPostsEnabled === true ? Math.min(s.borderPostsMaxPerReview || 0, s.maxOperationsPerReview)
      * Math.max(0, borderPostRows(B, borderPostScanRowsOf(s)) - launch) : 0);
}

function trimBatchRows(systems, maxFactionsPerSystem) {
  return 1 + systems * (TRIM_SYSTEM_ROWS + maxFactionsPerSystem);
}

function reliefRows(fleetsPerOperation, blockadeRows = 0) {
  return ROWS.launchWrapper + ROWS.operation
    + (ROWS.joinPerFleet + ROWS.planPerFleet + blockadeRows) * fleetsPerOperation + ROWS.activation;
}

function reactiveRowBound(s, r, d, pruneBatch) {
  const intents = (r ? r.maxReliefPerReview : 0) + (d ? d.maxDefensePerReview : 0)
    + (s.interceptEnabled === true ? (s.interceptMaxPerSweep || 0) : 0);
  return ROWS.done + 1 + pruneBatch + intents * reactiveIntentRowsOf(s);
}

function interceptRows(blockadeRows, fleetIds) {
  return ROWS.launchWrapper + ROWS.operation + ROWS.joinPerFleet + ROWS.planPerFleet + blockadeRows + ROWS.activation
    + fleetIds;
}

function reactiveIntentRowsOf(s) {
  const F = s.maxFleetsPerOperation;
  const B = blockadeRowsOf(s);
  const scan = s.blockadeGateOn === true ? 2 * F : F;
  return Math.max(reliefRows(F, B), s.interceptEnabled === true ? interceptRows(B, scan) : 0);
}

module.exports = { reviewRowBound, reactiveRowBound, REVIEW_ROWS: ROWS, MINING_DISPATCH_ROWS, PRODUCTION_START_ROWS, HULL_TAKE_ROWS,
  PRODUCTION_START_MINERALS, STOCK_CHANGE_FIXED_ROWS, advancedStartRows,
  RELEASE_ROWS, UPKEEP_ROWS, UPKEEP_ABANDON_ROWS, UPKEEP_TRADE_ROWS, UNIT_PURCHASE_ROWS, CONVOY_DISPATCH_BASE_ROWS, BUILD_PLAN_ROWS,
  RETIRE_ROWS, RETURN_ROWS, reliefRows, TRADE_OFFER_ROWS, TRADE_CANCEL_ROWS, WTS_EXTRA_ROWS, UPGRADE_ROWS, TRIM_PLAN_ROWS, trimBatchRows,
  TRIBUTE_MARKER_ROWS, HIVE_SWARM_MARKER_ROWS, TREASURY_BASE_ROWS, MERGE_ROWS, SENTRY_BUILD_ROWS, GARRISON_RELEASE_ROWS, UPKEEP_DISBAND_ROWS,
  MAX_GROUPS_PER_TAKE, blockadeRowsOf,
  gridCrossingRowsOf, fortressTxRowsOf, battleAnnounceTxRowsOf, transitTxRowsOf, listeningPostTxRowsOf, withDepartureRows, blockadeGateOnOf, blockadeGateRowsOf,
  borderPostRows, borderPostScanRowsOf, borderPostScanPageOf, interceptRows, reactiveIntentRowsOf };