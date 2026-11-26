"use strict";

const TARGET_SCORING_VERSION = 10;

const TARGET_SCORING_V1 = Object.freeze({
  base: 1000,
  strengthUnit: 1000,
  perJump: -60,
  free: 150,
  hostileControlled: 350,
  hiveControlled: -100,
  adjacentOwn: 80,
  hostileStation: 50,
  homeRegion: 50,
  unknownIntel: -40,
  strengthPer1000: -10,
  strengthPenaltyCap: -600,
  playerObserved: 0,
  playerActivityPerKill: -40,
  playerActivityCap: -400,
  homeReclaim: 300,
  hostileEconomyPer1000: 20,
});

module.exports = { TARGET_SCORING_VERSION, TARGET_SCORING_V1 };