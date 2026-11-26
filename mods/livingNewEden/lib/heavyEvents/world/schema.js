"use strict";

const KIND = Object.freeze({ WARCAMP: "warcamp", HIDEOUT: "hideout", STAGING: "staging", DESERTERS: "deserters",
  SMUGGLING: "smuggling", FRONTDEPOT: "frontdepot", WRECKEDCONVOY: "wreckedconvoy", FLAGWRECK: "flagwreck",
  BREACH: "breach" });
const KINDS = Object.freeze(Object.values(KIND));
const MECHANIC_OF = Object.freeze({ [KIND.WARCAMP]: "muster", [KIND.HIDEOUT]: "hunt", [KIND.STAGING]: "muster",
  [KIND.DESERTERS]: "outpost", [KIND.SMUGGLING]: "convoy", [KIND.FRONTDEPOT]: "cache",
  [KIND.WRECKEDCONVOY]: "cache", [KIND.FLAGWRECK]: "hunt", [KIND.BREACH]: "trail" });
const KIND_WEIGHT_KEY = Object.freeze(Object.fromEntries(KINDS.map((k) => [k, `${k}Weight`])));
const KIND_ROLLS_KEY = Object.freeze(Object.fromEntries(KINDS.map((k) => [k, `${k}Rolls`])));
const KIND_INFLUENCE_KEY = Object.freeze(Object.fromEntries(KINDS.map((k) => [k, `${k}InfluencePoints`])));
const SYNTHETIC_KINDS = Object.freeze([KIND.STAGING, KIND.FLAGWRECK, KIND.BREACH]);
const KIND_TIER_WEIGHTS_KEY = Object.freeze({ [KIND.HIDEOUT]: "hideoutTierWeights",
  [KIND.STAGING]: "stagingTierWeights", [KIND.DESERTERS]: "desertersTierWeights",
  [KIND.SMUGGLING]: "smugglingTierWeights", [KIND.FRONTDEPOT]: "frontdepotTierWeights",
  [KIND.WRECKEDCONVOY]: "wreckedconvoyTierWeights", [KIND.BREACH]: "breachTierWeights" });
const KIND_LP_KEY = Object.freeze({ [KIND.STAGING]: "stagingLpPerTier" });
const KIND_STANDING_KEY = Object.freeze({ [KIND.STAGING]: "stagingStandingMicro" });
const STAGING_INVASION_METHODS = Object.freeze(["listBeachheadsInTx"]);
const DESERTERS_TREASURY_METHODS = Object.freeze(["readUnpaidDaysInDb"]);
const SMUGGLING_STATION_METHODS = Object.freeze(["listStationsInSystem", "getStocks"]);
const FRONTDEPOT_FLEET_METHODS = Object.freeze(["listOperationsByTarget"]);
const WRECKEDCONVOY_LOGISTICS_METHODS = Object.freeze(["listLostInTx"]);
const BREACH_ABYSSAL_METHODS = Object.freeze(["pressureOf"]);
const FLAGWRECK_SALVAGE_METHODS = Object.freeze(["listBoardRows"]);
const FACTION_IDS_MAX = 8;
const OPERATION_TYPES_MAX = 8;
const OPERATION_TYPE_RE = /^[a-z_]{1,24}$/;
const LP_PER_TIER_MAX = 100000;

const TIER_COUNT = 3;
const AFFIX_NONE = "none";

const KEY_PREFIX = "hwa";
const PLAN_KEY_PREFIX = "wa";
const REWARD_KEY_PREFIX = "hwarwd";

const WORLD_REASON_RANK = Object.freeze(["NO_CANDIDATE", "TYPE_OFF", "BAND_OFF", "KIND_OFF", "NO_TRIGGER",
  "NO_STATION", "NO_STOCK", "COOLDOWN", "BUSY", "LIMIT", "SITES_HEADROOM"]);
const WORLD_DEFERRAL = Object.freeze(["GOVERNOR", "SITES"]);
const WORLD_CANCEL_REASONS = Object.freeze(["CANCELLED", "DISABLED", "TYPE_OFF"]);

const WORLD_COUNTER_NAMES = Object.freeze([
  "anomaly.planned",
  ...KINDS.map((k) => `anomaly.planned.${k}`),
  ...KINDS.map((k) => `anomaly.cleared.${k}`),
  ...WORLD_REASON_RANK.map((r) => `anomaly.refused.${r}`),
  ...WORLD_DEFERRAL.map((r) => `anomaly.deferred.${r}`),
  ...WORLD_CANCEL_REASONS.map((r) => `anomaly.cancelled.${r}`),
  "anomaly.reward.placed", "anomaly.reward.skipped", "anomaly.reward.failed",
  "anomaly.lossesTruncated",
  "anomaly.staging.noBeneficiary",
  ...KINDS.map((k) => `anomaly.readRefused.${k}`),
  "anomaly.pocket", "anomaly.escaped", "anomaly.failed.ESCAPED",
]);

const LABEL_MAX = 64;
const LABEL_WORDS = Object.freeze({ [KIND.WARCAMP]: "Regroup Camp", [KIND.HIDEOUT]: "Hidden Command Post",
  [KIND.STAGING]: "Invasion Staging", [KIND.DESERTERS]: "Mutineer Flotilla", [KIND.SMUGGLING]: "Smuggling Run",
  [KIND.FRONTDEPOT]: "Forward Supply Cache", [KIND.WRECKEDCONVOY]: "Convoy Wreckage",
  [KIND.FLAGWRECK]: "Fallen Flagship", [KIND.BREACH]: "Abyssal Breach" });

const eventIdOf = (bucket, slot) => `${KEY_PREFIX}:${bucket}:${slot}`;
const planKeyOf = (intervalMs, bucket, slot) => `${PLAN_KEY_PREFIX}:${intervalMs}:${bucket}:${slot}`;
const rewardKeyOf = (day, systemId, eventId) => `${REWARD_KEY_PREFIX}:${day}:${systemId}:${eventId}`;
const rewardDayRangeOf = (day) => ({ from: `${REWARD_KEY_PREFIX}:${day}:`, to: `${REWARD_KEY_PREFIX}:${day};` });

const INT_MAX = 1000000000;
const ROLLS_MAX = 10;

function parseTierInts3(text) {
  if (typeof text !== "string") return null;
  const parts = text.split(",").map((s) => s.trim());
  if (parts.length !== TIER_COUNT || !parts.every((s) => /^[0-9]{1,10}$/.test(s))) return null;
  const out = parts.map(Number);
  return out.every((n) => n <= INT_MAX) ? out : null;
}

function parseThresholds(text) {
  const out = parseTierInts3(text);
  if (!out || !out.every((n, i) => n > 0 && (i === 0 || n >= out[i - 1]))) return null;
  return out;
}

function parseTierWeights(text) {
  const out = parseTierInts3(text);
  return out && out.reduce((a, b) => a + b, 0) > 0 ? out : null;
}

function parseTierRolls(text) {
  const out = parseTierInts3(text);
  return out && out.every((n) => n <= ROLLS_MAX) ? out : null;
}

function parseLpPerTier(text) {
  const out = parseTierInts3(text);
  return out && out.every((n) => n <= LP_PER_TIER_MAX) ? out : null;
}

function parseFactionIdList(text) {
  if (typeof text !== "string") return null;
  const parts = text.split(",").map((s) => s.trim());
  if (parts.length < 1 || parts.length > FACTION_IDS_MAX || !parts.every((s) => /^[1-9][0-9]{0,9}$/.test(s))) {
    return null;
  }
  const out = parts.map(Number);
  return out.every(Number.isSafeInteger) && new Set(out).size === out.length ? out : null;
}

function parseOperationTypes(text) {
  if (typeof text !== "string") return null;
  const parts = text.split(",").map((s) => s.trim());
  if (parts.length < 1 || parts.length > OPERATION_TYPES_MAX || !parts.every((s) => OPERATION_TYPE_RE.test(s))) {
    return null;
  }
  return new Set(parts).size === parts.length ? parts : null;
}

module.exports = {
  KIND,
  KINDS,
  MECHANIC_OF,
  KIND_WEIGHT_KEY,
  KIND_ROLLS_KEY,
  KIND_INFLUENCE_KEY,
  SYNTHETIC_KINDS,
  KIND_TIER_WEIGHTS_KEY,
  KIND_LP_KEY,
  KIND_STANDING_KEY,
  STAGING_INVASION_METHODS,
  DESERTERS_TREASURY_METHODS,
  SMUGGLING_STATION_METHODS,
  FRONTDEPOT_FLEET_METHODS,
  WRECKEDCONVOY_LOGISTICS_METHODS,
  BREACH_ABYSSAL_METHODS,
  FLAGWRECK_SALVAGE_METHODS,
  TIER_COUNT,
  AFFIX_NONE,
  KEY_PREFIX,
  PLAN_KEY_PREFIX,
  REWARD_KEY_PREFIX,
  WORLD_REASON_RANK,
  WORLD_DEFERRAL,
  WORLD_CANCEL_REASONS,
  WORLD_COUNTER_NAMES,
  LABEL_MAX,
  LABEL_WORDS,
  eventIdOf,
  planKeyOf,
  rewardKeyOf,
  rewardDayRangeOf,
  parseTierInts3,
  parseThresholds,
  parseTierWeights,
  parseTierRolls,
  parseLpPerTier,
  parseFactionIdList,
  parseOperationTypes,
};
