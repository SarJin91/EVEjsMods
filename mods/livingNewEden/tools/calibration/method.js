"use strict";

const { deepFreeze } = require("../strength/method");

const CALIBRATION_METHOD = deepFreeze({
  version: "calib-v1",
  datasetVersion: "killmails-v1",
  calibSeed: 1,

  fetch: {
    totalsUrl: "https://r2z2.zkillboard.com/history/totals.json",
    rawUrl: "https://r2z2.zkillboard.com/history/raw/{day}.json",
    userAgent: "LivingNewEden-calibration/1 (local research, EveJS mod)",
    minIntervalMs: 2000,
    attempts: 3,
    retryPauseMs: 10000,
  },

  dataset: {
    shipCategoryId: 6,
    capsuleGroupId: 29,
    clusterGapSec: 600,
    thirdPartyMaxShare: 0.1,
    unmappedMaxShare: 0.2,
    minKills: 3,
    minShipsPerSide: 2,
    maxBattlesPerDay: 400,
    wormholeSystemMin: 31000000,
    wormholeSystemMax: 31999999,
    nullsecMaxSecurity: 0,
    lowsecBelowSecurity: 0.45,
    classes: {
      smallGangMaxPerSide: 10,
      largeFleetMinTotal: 100,
      dpsEdgeMinRatio: 2,
      logiEdgeMinShare: 0.1,
      logiEdgeMaxOtherShare: 0.02,
      outmatchedMinPowerRatio: 3,
    },
    digits: 4,
  },

  metrics: {
    winMargin: 0.1,
    seedsPerBattle: 20,
    minClassBattles: 10,
    classes: ["all", "smallGang", "largeFleet", "dpsEdge", "logiEdge", "outmatched", "wormhole"],
    weights: { all: 1, other: 0.5 },
    lambdaEfs: 0.5,
    efsScenarios: ["S2", "S3", "S4", "S6", "S7", "S8", "S9", "L1"],
    efsSeeds: 1000,
    l1Id: "L1",
    l1MaxDraw: 0.5,
  },

  search: {
    passes: 3,
    steps: [
      { knobs: ["resolverDpsScale", "resolverEhpScale"], grids: [
        { from: 0.1, to: 1.5, step: 0.05 }, { from: 0.5, to: 3, step: 0.25 }] },
      { knobs: ["resolverMaxRounds"], grids: [{ from: 8, to: 30, step: 2 }] },
      { knobs: ["resolverRetreatLossFraction"], grids: [{ from: 0.2, to: 0.8, step: 0.05 }], efs: false },
      { knobs: ["resolverRepScale"], grids: [{ from: 0.5, to: 2, step: 0.25 }] },
    ],
  },

  guards: {
    trials: 200,
    similarTrials: 1000,
    similarMaxGap: 0.1,
    outnumberMinWin: 0.9,
    outnumberMinEscaped: 0.5,
    scoutMinEscaped: 0.5,
    escortMinAchievedWithLoss: 0.1,
    garrisonMinGain: 0.15,
    delayMinAchieved: 0.5,
    benchBattles: 1000,
    benchSeed: 2026,
  },
});

module.exports = { CALIBRATION_METHOD };
