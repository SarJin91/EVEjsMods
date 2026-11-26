"use strict";

const TYPE = Object.freeze({ OUTPOST: "outpost", CACHE: "cache", TRAIL: "trail", HUNT: "hunt", CONVOY: "convoy",
  MUSTER: "muster" });
const POWER_TYPES = Object.freeze(Object.values(TYPE));
const TYPE_WEIGHT_KEY = Object.freeze(Object.fromEntries(POWER_TYPES.map((t) => [t, `${t}Weight`])));
const TYPE_ROLLS_KEY = Object.freeze(Object.fromEntries(POWER_TYPES.map((t) => [t, `${t}Rolls`])));
const POWER_LIVE_READY = Object.freeze([TYPE.OUTPOST, TYPE.CACHE, TYPE.TRAIL, TYPE.HUNT, TYPE.CONVOY, TYPE.MUSTER]);
const MINERAL_TYPES = Object.freeze([TYPE.CACHE, TYPE.CONVOY]);

const VARIANTS = Object.freeze({
  [TYPE.OUTPOST]: Object.freeze(["brawl", "kite"]),
  [TYPE.CACHE]: Object.freeze(["guard", "sentinel"]),
  [TYPE.TRAIL]: Object.freeze(["courier", "decoy"]),
  [TYPE.HUNT]: Object.freeze(["guarded", "duelist"]),
  [TYPE.CONVOY]: Object.freeze(["light", "armored"]),
  [TYPE.MUSTER]: Object.freeze(["swarm", "line"]),
});

const TIER_COUNT = 2;

const AFFIX = Object.freeze({ NONE: "none", REINFORCED: "reinforced", RICH: "rich", FLEETING: "fleeting" });
const AFFIXES = Object.freeze(Object.values(AFFIX));

const ROLE = Object.freeze({ OBJECTIVE: "objective", HAULER: "hauler" });
const ROLES = Object.freeze(Object.values(ROLE));

const VISIBILITY = Object.freeze({ ANOMALY: "anomaly", SIGNATURE: "signature" });
const SIGNALS = Object.freeze(["weak", "normal", "strong"]);

const POWER_REASON_RANK = Object.freeze(["NO_CANDIDATE", "TYPE_OFF", "BAND_OFF", "KIND_OFF", "NO_STATION",
  "NO_MINERALS", "NO_STOCK", "COOLDOWN", "BUSY", "LIMIT", "SITES_HEADROOM"]);

const POWER_DEFERRAL = Object.freeze(["GOVERNOR", "SITES"]);
const POWER_CANCEL_REASONS = Object.freeze(["CANCELLED", "DISABLED", "TYPE_OFF"]);

const POWER_REWARD_SKIP_REASONS = Object.freeze(["NO_PROFILE", "NO_LOSSES", "ATTEMPTS", "LIMIT_DAY", "LIMIT_SYSTEM", "SITE", "SCENE"]);

const POWER_COUNTER_NAMES = Object.freeze([
  "power.planned",
  ...POWER_REASON_RANK.map((r) => `power.refused.${r}`),
  ...POWER_DEFERRAL.map((r) => `power.deferred.${r}`),
  ...POWER_CANCEL_REASONS.map((r) => `power.cancelled.${r}`),
  "power.pocket", "power.escaped", "power.failed.ESCAPED",
  ...AFFIXES.map((a) => `power.affix.${a}`),
  "power.reward.placed", "power.reward.skipped", "power.reward.failed",
  ...POWER_REWARD_SKIP_REASONS.map((r) => `power.reward.skipped.${r}`),
]);

const LABEL_MAX = 64;
const LABEL_WORDS = Object.freeze({
  [TYPE.OUTPOST]: "Lookout Nest",
  [TYPE.CACHE]: "Buried Stash",
  [TYPE.TRAIL]: "Courier Trail",
  [TYPE.HUNT]: "Marked Commander",
  [TYPE.CONVOY]: "Supply Drop",
  [TYPE.MUSTER]: "Muster Grounds",
});
const AFFIX_WORDS = Object.freeze({ none: "", reinforced: "Reinforced", rich: "Rich", fleeting: "Fleeting" });

const KEY_PREFIX = "hpw";
const PLAN_KEY_PREFIX = "pw";
const REWARD_KEY_PREFIX = "hpwrwd";

const eventIdOf = (bucket, slot) => `${KEY_PREFIX}:${bucket}:${slot}`;
const planKeyOf = (intervalMs, bucket, slot) => `${PLAN_KEY_PREFIX}:${intervalMs}:${bucket}:${slot}`;
const pocketKeyOf = (eventId, pocket) => `${eventId}:pocket:${pocket}`;
const escapeKeyOf = (eventId, phase) => `${eventId}:escape:${phase}`;
const rewardKeyOf = (day, systemId, eventId) => `${REWARD_KEY_PREFIX}:${day}:${systemId}:${eventId}`;
const rewardDayRangeOf = (day) => ({ from: `${REWARD_KEY_PREFIX}:${day}:`, to: `${REWARD_KEY_PREFIX}:${day};` });

const isPowerType = (type) => POWER_TYPES.includes(type);

const drainKeyOf = (eventId) => `${eventId}:drain`;

function parseIntList(text, count, max) {
  if (typeof text !== "string") return null;
  const parts = text.split(",").map((s) => s.trim());
  if (parts.length !== count || !parts.every((s) => /^[0-9]{1,9}$/.test(s))) return null;
  const out = parts.map(Number);
  return out.every((n) => n <= max) ? out : null;
}

const WEIGHT_MAX = 1000000;
const ROLLS_MAX = 10;
const sumPositive = (list) => (list && list.reduce((a, b) => a + b, 0) > 0 ? list : null);

const parseTierWeights = (text) => sumPositive(parseIntList(text, TIER_COUNT, WEIGHT_MAX));
const parseAffixWeights = (text) => sumPositive(parseIntList(text, AFFIXES.length, WEIGHT_MAX));
const parseTierRolls = (text) => parseIntList(text, TIER_COUNT, ROLLS_MAX);

module.exports = {
  TYPE,
  POWER_TYPES,
  POWER_LIVE_READY,
  TYPE_WEIGHT_KEY,
  TYPE_ROLLS_KEY,
  MINERAL_TYPES,
  VARIANTS,
  TIER_COUNT,
  AFFIX,
  AFFIXES,
  ROLE,
  ROLES,
  VISIBILITY,
  SIGNALS,
  POWER_REASON_RANK,
  POWER_DEFERRAL,
  POWER_CANCEL_REASONS,
  POWER_REWARD_SKIP_REASONS,
  POWER_COUNTER_NAMES,
  LABEL_MAX,
  LABEL_WORDS,
  AFFIX_WORDS,
  KEY_PREFIX,
  PLAN_KEY_PREFIX,
  REWARD_KEY_PREFIX,
  eventIdOf,
  planKeyOf,
  pocketKeyOf,
  escapeKeyOf,
  rewardKeyOf,
  rewardDayRangeOf,
  drainKeyOf,
  isPowerType,
  parseTierWeights,
  parseAffixWeights,
  parseTierRolls,
};
