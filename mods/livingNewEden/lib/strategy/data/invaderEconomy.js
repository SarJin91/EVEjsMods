"use strict";

const INVADER_ECONOMY_VERSION = 1;
const INVADER_ECONOMY_FACTIONS = Object.freeze({ 500026: "triglavian", 500029: "deathless" });
const INVADER_HOME_POOL_KEYS = Object.freeze(["homeFleetsMax", "homeMobilizationsPerReview"]);
const INVADER_CONDUIT_KEYS = Object.freeze(["conduitChancePermille", "conduitMaxActive", "conduitMaxSpawnsPerDay",
  "conduitIskPerSpawn", "conduitReserveIsk", "conduitPoolFleetsPerSpawn", "conduitBonusFleetsMax",
  "conduitIskPerBonusFleet", "conduitWithdrawAfterMs"]);
const INVADER_RAID_KEYS = Object.freeze(["maxActiveFronts", "maxRaidFronts"]);
const INVADER_UNIT_ONLY_FACTIONS = Object.freeze({ 500021: "sleepers" });

module.exports = { INVADER_ECONOMY_VERSION, INVADER_ECONOMY_FACTIONS, INVADER_HOME_POOL_KEYS, INVADER_CONDUIT_KEYS,
  INVADER_RAID_KEYS, INVADER_UNIT_ONLY_FACTIONS };
