"use strict";

const TIER = Object.freeze({ NONE: "NONE", LEGEND: "LEGEND", PUBLIC_ENEMY: "PUBLIC_ENEMY" });
const AGGREGATE = "player_fame";
const EVENT_TIER_CHANGED = "FAME_TIER_CHANGED";
const NOTICE_KIND = "FAME";
const RNG_STREAM_LOCAL = "fv-fame";
const KEY_PREFIX = "fame:";
const TIER_KEY_PREFIX = "fame:tier:";
const PAYLOAD_VERSION = 1;
const LOCAL_CONTEXT_OF_TIER = Object.freeze({ LEGEND: "FAME_LEGEND", PUBLIC_ENEMY: "FAME_ENEMY" });
const FACTION_FALLBACK = "A faction";
const MAIL_TEMPLATES = Object.freeze({
  LEGEND: "{faction} now speaks of you as a legend. Their pilots will know your name.",
  PUBLIC_ENEMY: "{faction} has declared you a public enemy. Expect a cold welcome in their space.",
});

const FAME_COUNTER_NAMES = Object.freeze(["passes", "deferredGovernor", "noRegistry", "pairsRead", "readFailed",
  "announced", "announceDuplicate", "announceFailed", "noticesQueued", "noticesFailed", "pairsEvicted", "cacheHit",
  "cacheMiss", "errors", "dockDenied", "dockFailOpen", "marketModified", "marketFailOpen", "marketNoStation",
  "readBudgetShort",
  "bountyPosted", "bountyDuplicate", "bountyWaitOpen", "bountyWaitDelay", "bountyWaitSecClass", "bountyWaitNotInSpace",
  "bountyNoGang", "bountyGangNotReady", "bountyFailed", "bountyNoticesQueued", "bountyNoticesFailed"]);

const fameWantedIdOf = (characterId, factionId, period) => `fame:${characterId}:${factionId}:${period}`;
const bountyNoticeKeyOf = (characterId, factionId, period) => `fame:bnty:${characterId}:${factionId}:${period}`;
const BOUNTY_MAIL_TEMPLATE = "{faction} has put a price on your head. Hunters are on their way.";

const DOCK_DENY_TEMPLATE = "{faction} security refuses docking to a declared public enemy.";
const DOCK_FACTION_FALLBACK = "Station";

const INTEGER_KEYS = Object.freeze(["reviewEveryMs", "reviewMaxPlayers", "reviewMaxReadsPerPass",
  "reviewMaxAnnouncesPerPass", "reviewMaxPairs", "announcePeriodMs", "cacheTtlMs", "cacheMaxEntries",
  "localRecognizePermille", "localRecognizeCooldownMs", "localMaxCandidates", "maxSurchargePermille",
  "bountyDelayAfterTierMs", "bountyCooldownMs", "bountyDelayMs", "bountyWindowMs", "bountyLevelBase", "bountyMaxLevel",
  "bountyChecksPerPass",
  "bountyHighsecConcordExtraMs", "bountyHighsecConcordFallbackMs", "bountyHighsecConcordKillMs",
  "bountyHighsecConcordLeaveMs", "bountyHighsecMaxLive"]);
const SIGNED_INTEGER_KEYS = Object.freeze(["legendTaxPermille", "enemyTaxPermille", "legendBrokerPermille",
  "enemyBrokerPermille"]);
const NUMBER_KEYS = Object.freeze(["legendMin", "enemyMax", "hysteresis", "bountyLevelStep",
  "bountyHighsecMinSecurity", "bountyHighsecMaxSecurity"]);
const BOOLEAN_KEYS = Object.freeze(["enabled", "localEnabled", "noticesEnabled", "dockDenyEnabled", "marketTaxEnabled",
  "marketBrokerEnabled", "bountyEnabled", "newsEnabled", "bountyHighsecEnabled", "bountyHighsecConcordSpawnEnabled"]);

const tierKeyOf = (characterId, factionId, tier, period) => `${TIER_KEY_PREFIX}${characterId}:${factionId}:${tier}:${period}`;

const isFameWantedId = (s) => typeof s === "string" && s.startsWith(KEY_PREFIX);

function fameSettingsOf(config) {
  const F = config && typeof config === "object" ? config.fame : null;
  if (!F || typeof F !== "object") return { ok: false, reason: "INVALID_SETTINGS", detail: "fame" };
  for (const k of BOOLEAN_KEYS) {
    if (typeof F[k] !== "boolean") return { ok: false, reason: "INVALID_SETTINGS", detail: k };
  }
  for (const k of INTEGER_KEYS) {
    if (!Number.isSafeInteger(F[k]) || F[k] < 0) return { ok: false, reason: "INVALID_SETTINGS", detail: k };
  }
  for (const k of SIGNED_INTEGER_KEYS) {
    if (!Number.isSafeInteger(F[k])) return { ok: false, reason: "INVALID_SETTINGS", detail: k };
  }
  for (const k of NUMBER_KEYS) {
    if (typeof F[k] !== "number" || !Number.isFinite(F[k])) return { ok: false, reason: "INVALID_SETTINGS", detail: k };
  }
  if (!(F.legendMin > 0)) return { ok: false, reason: "INVALID_SETTINGS", detail: "legendMin" };
  if (!(F.enemyMax < 0)) return { ok: false, reason: "INVALID_SETTINGS", detail: "enemyMax" };
  if (F.hysteresis < 0) return { ok: false, reason: "INVALID_SETTINGS", detail: "hysteresis" };
  if (F.announcePeriodMs <= 0 || F.reviewEveryMs <= 0 || F.reviewMaxPlayers <= 0 || F.reviewMaxReadsPerPass <= 0
    || F.reviewMaxAnnouncesPerPass <= 0 || F.reviewMaxPairs <= 0 || F.cacheMaxEntries <= 0
    || F.localMaxCandidates <= 0 || F.bountyCooldownMs <= 0 || F.bountyChecksPerPass <= 0
    || !(F.bountyLevelStep > 0)) {
    return { ok: false, reason: "INVALID_SETTINGS", detail: "zero limit" };
  }
  return { ok: true, settings: Object.freeze({ ...F }) };
}

module.exports = { TIER, AGGREGATE, EVENT_TIER_CHANGED, NOTICE_KIND, RNG_STREAM_LOCAL, KEY_PREFIX, TIER_KEY_PREFIX,
  PAYLOAD_VERSION, LOCAL_CONTEXT_OF_TIER, FACTION_FALLBACK, MAIL_TEMPLATES, FAME_COUNTER_NAMES, DOCK_DENY_TEMPLATE,
  DOCK_FACTION_FALLBACK, tierKeyOf, isFameWantedId, fameSettingsOf, fameWantedIdOf, bountyNoticeKeyOf,
  BOUNTY_MAIL_TEMPLATE };
