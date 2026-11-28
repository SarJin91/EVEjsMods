"use strict";

const { followMetersOf } = require("../util/miningBeamPlan");

const CIVILIAN_POOL_ID = 1;

const CIVILIAN_POOL_KEY = "civ";

const CIVILIAN_METRICS = Object.freeze({
  wanted: "highsecLife.civiliansWanted",
  assigned: "highsecLife.civiliansAssigned",
  shortfall: "highsecLife.civiliansShortfall",
});

const CHATTER_METRICS = Object.freeze({
  lines: "highsecLife.chatterLines",
  rumours: "highsecLife.chatterRumours",
  rateLimited: "highsecLife.chatterRateLimited",
  sendFailed: "highsecLife.chatterSendFailed",
  passMs: "highsecLife.chatterPassMs",
  aiLines: "highsecLife.chatterAiLines",
});

const CHATTER_COUNTER_NAMES = Object.freeze(["lines", "rumours", "rateLimited", "deferred", "sendNoSocket",
  "sendNotOccupant", "sendOther", "warRumoursAdded", "battleRumoursAdded", "rumoursRejected", "errors", "aiLines"]);

const RESIDENT_CHATTER_METRICS = Object.freeze({
  lines: "highsecLife.chatterResidentLines",
  hourLimited: "highsecLife.chatterResidentHourLimited",
  fcRumours: "highsecLife.chatterFcRumours",
});

const RESIDENT_CHATTER_COUNTER_NAMES = Object.freeze(["lines", "hourLimited", "rateLimited", "noSpeaker", "noLine",
  "speakersFailed", "sendNoSocket", "sendNotOccupant", "sendOther", "newsReads", "newsFailed", "fcRumoursAdded",
  "aiLines"]);

const TRAFFIC_METRICS = Object.freeze({
  live: "highsecLife.trafficLive",
  spawned: "highsecLife.trafficSpawned",
  despawned: "highsecLife.trafficDespawned",
  passMs: "highsecLife.trafficPassMs",
  pilotShips: "highsecLife.trafficPilotShips",
  pilotDuplicates: "highsecLife.trafficPilotDuplicates",
  maxPerSystem: "highsecLife.trafficMaxPerSystem",
  aggroMs: "highsecLife.trafficAggroMs",
});

const AGGRO_COUNTER_NAMES = Object.freeze(["passes", "systemsRead", "hostileSeen", "friendlySkipped", "armed",
  "attackersOrdered", "disarmed", "noStandings", "failed",
  "liveBattleSkipped", "attackersReleased", "attackersKept", "releaseFailed"]);

const RAT_AGGRO_COUNTER_NAMES = Object.freeze(["orders", "ratsOrdered", "quotaSkipped", "borrowedSkipped",
  "engagedReleased"]);

const TRAFFIC_COUNTER_NAMES = Object.freeze(["passes", "spawned", "arrived", "expired", "stuck", "left", "gone",
  "orphans", "noRoute", "noProfile", "warpFailed", "failed.spawn", "failed.despawn", "failed.read",
  "deferred.GOVERNOR", "deferred.GLOBAL_FULL",
  "undocked", "docked", "gateIdle", "named", "noName",
  "miners", "failed.names",
  "pilotSpawned", "pilotCapRefused", "pilotHullFallback", "pilotNoGate", "pilotBackoff", "pilotKilled",
  "pilotNoLiveProfile", "pilotHullsUnverified", "pilotHullLookRejected",
  "groupMemberSpawned", "groupMembersCapped", "groupMemberNoProfile", "groupMembersReclaimed", "groupMembersDropped",
  "jumpInFx", "jumpOutFx", "jumpFxFailed", "alignWarps", "alignFellBack", "alignTimeouts",
  "visibleWarpFx", "visibleWarpFxCut",
  "miningBeamRefresh", "miningBeamFx", "miningBeamBudgetCut", "miningBeamNoRock", "failed.beams",
  "miningBeamApproachOrders", "miningBeamApproaching", "miningBeamApproachBusy", "miningBeamApproachRefused",
  "miningBeamApproachReleased",
  "fleeTriggered", "fleeWarps", "fleeRetry", "fleeNoTarget", "fleeAlarmed", "fleeAlarmBudgetCut", "fleeAlarmVictims",
  "gateArrivalEvents", "gateDepartureEvents", "gateEventFailed", "gateEventBudgetCut",
  "gateArrivalPoses", "gateArrivalRotations", "gateArrivalPoseFailed", "gateArrivalNoHeading",
  "ratters", "ratterCapped", "ratterBelts", "ratterOrbits", "ratterOrbitRefused", "patrolReleased",
  "explorers", "explorerCapped", "explorerScans", "explorerSites", "explorerNoSite", "explorerSiteGone",
  "explorerNpcBlocked", "explorerReadBudget", "explorerNoSafeSpot", "failed.sites"]);

const TRAFFIC_STATE = Object.freeze({ OFF: "off", RUNNING: "running", STOPPED: "stopped" });

const GANK_METRICS = Object.freeze({
  fields: "highsecLife.gankFields",
  passMs: "highsecLife.gankPassMs",
});

const GANK_COUNTER_NAMES = Object.freeze(["passes", "created", "duplicate", "quiet", "tooLate", "notHighsec",
  "noFaction", "failed", "refused.WRECKS", "deferred.GOVERNOR", "rumoursAdded"]);

const GANK_STATE = Object.freeze({ OFF: "off", RUNNING: "running", STOPPED: "stopped" });

const CIVILIAN_OWNER_KIND = "civilian";

const TARGET_REASON = Object.freeze({
  HUB: "HUB",
  NEAR_HUB: "NEAR_HUB",
  STATIONS: "STATIONS",
  BASE: "BASE",
  BAND_OFF: "BAND_OFF",
  NOT_NORMAL_LOCAL: "NOT_NORMAL_LOCAL",
});

const STATE = Object.freeze({ STARTING: "starting", RUNNING: "running", STOPPED: "stopped" });

const COUNTER_NAMES = Object.freeze(["identitiesEnsured", "identitiesLinked", "identitiesRefused",
  "identitiesFailed", "bootFailed",
  "membersRefused", "stationsReadFailed"]);

const BANDS = Object.freeze(["highsec", "lowsec", "nullsec"]);
const HOURS_PER_DAY = 24;
const MAX_NEAR_HUB_STEPS = 8;
const MAX_HUB_IDS = 16;
const MAX_PERMILLE = 1000;
const MAX_CURVE_PERMILLE = 2000;

const EMPIRE_RACE_FACTION_IDS = Object.freeze([500001, 500002, 500003, 500004]);
const SECURITY_RATING_MIN = 0;
const SECURITY_RATING_MAX = 2;

function splitList(value) {
  if (typeof value !== "string") return null;
  const parts = value.split(",").map((p) => p.trim());
  return parts.length > 0 && parts.every((p) => p !== "") ? parts : null;
}

function intList(value, minLength, maxLength, min, max) {
  const parts = splitList(value);
  if (!parts || parts.length < minLength || parts.length > maxLength) return null;
  const out = [];
  for (const p of parts) {
    if (!/^\d+$/.test(p)) return null;
    const n = Number(p);
    if (!Number.isSafeInteger(n) || n < min || n > max) return null;
    out.push(n);
  }
  return Object.freeze(out);
}

function parseBands(value) {
  const parts = splitList(value);
  if (!parts || parts.some((p) => !BANDS.includes(p)) || new Set(parts).size !== parts.length) return null;
  return Object.freeze(parts);
}

function parseNearHubPilots(value) {
  return intList(value, 1, MAX_NEAR_HUB_STEPS, 0, MAX_PERMILLE);
}

function parseHourCurve(value) {
  return intList(value, HOURS_PER_DAY, HOURS_PER_DAY, 0, MAX_CURVE_PERMILLE);
}

function parseHubSystemIds(value) {
  const ids = intList(value, 1, MAX_HUB_IDS, 1, Number.MAX_SAFE_INTEGER);
  return ids && new Set(ids).size === ids.length ? ids : null;
}

const CHATTER_INTS = Object.freeze(["tickMs", "minIntervalMs", "minIntervalFloorMs", "intervalRefCivilians",
  "jitterPermille", "maxLinesPerMinute", "minCivilians", "rumourPermille", "rumourMaxJumps", "rumourMaxAgeMs",
  "rumourRingSize", "rumourMinBattleLosses", "recentLinesPerSystem", "maxLineChars"]);
const CHATTER_POSITIVE = Object.freeze(["tickMs", "minIntervalMs", "minIntervalFloorMs", "intervalRefCivilians",
  "minCivilians", "rumourMaxAgeMs", "rumourRingSize", "maxLineChars"]);

function chatterSettingsOf(config) {
  const C = config && config.highsecLife && config.highsecLife.chatter;
  if (!C || typeof C !== "object") return { ok: false, reason: "INVALID_SETTINGS", detail: "chatter" };
  for (const k of CHATTER_INTS) {
    if (!Number.isSafeInteger(C[k]) || C[k] < 0) return { ok: false, reason: "INVALID_SETTINGS", detail: `chatter.${k}` };
  }
  for (const k of CHATTER_POSITIVE) {
    if (C[k] <= 0) return { ok: false, reason: "INVALID_SETTINGS", detail: `chatter.${k}` };
  }
  for (const k of ["enabled", "hubRumoursAnyDistance"]) {
    if (typeof C[k] !== "boolean") return { ok: false, reason: "INVALID_SETTINGS", detail: `chatter.${k}` };
  }
  const settings = { enabled: C.enabled, hubRumoursAnyDistance: C.hubRumoursAnyDistance };
  for (const k of CHATTER_INTS) settings[k] = C[k];
  settings.jitterPermille = Math.min(C.jitterPermille, MAX_PERMILLE);
  settings.rumourPermille = Math.min(C.rumourPermille, MAX_PERMILLE);
  return { ok: true, settings: Object.freeze(settings) };
}

const FREE_CHATTER_INTS = Object.freeze(["maxLinesPerSystemPerHour", "minResidents", "newsPollMs", "newsReadLimit",
  "rumourMinYieldIsk", "rumourMinCrewLost"]);
const FREE_CHATTER_POSITIVE = Object.freeze(["minResidents", "newsPollMs", "newsReadLimit", "rumourMinCrewLost"]);

function freeChatterSettingsOf(config) {
  const F = config && config.freeCorps && config.freeCorps.chatter;
  if (!F || typeof F !== "object") return { ok: false, reason: "INVALID_SETTINGS", detail: "freeCorps.chatter" };
  if (F.enabled !== true) return { ok: false, reason: "INVALID_SETTINGS", detail: "freeCorps.chatter.enabled" };
  for (const k of FREE_CHATTER_INTS) {
    if (!Number.isSafeInteger(F[k]) || F[k] < 0) {
      return { ok: false, reason: "INVALID_SETTINGS", detail: `freeCorps.chatter.${k}` };
    }
  }
  for (const k of FREE_CHATTER_POSITIVE) {
    if (F[k] <= 0) return { ok: false, reason: "INVALID_SETTINGS", detail: `freeCorps.chatter.${k}` };
  }
  const settings = { enabled: true };
  for (const k of FREE_CHATTER_INTS) settings[k] = F[k];
  return { ok: true, settings: Object.freeze(settings) };
}

const TRAFFIC_INTS = Object.freeze(["pollMs", "spawnIntervalMs", "maxLifetimeMs", "maxShipsPerSystem", "maxShipsGlobal",
  "civiliansPerShip", "pairCivilians", "minCivilians", "maxSystemsPerPass", "departDelayMs", "spawnOffsetMeters",
  "landingOffsetMeters", "arrivalMeters", "dockDelayMs", "exitGraceMs", "stationTargetPermille", "maxWarpAttempts",
  "undockPermille", "undockRunMeters", "gateIdlePermille", "gateIdleMinMs", "gateIdleMaxMs",
  "minerPermille", "minerStayMinMs", "minerStayMaxMs", "minerAsteroidMeters", "gateJumpInDurationMs",
  "gateJumpOutDespawnMs", "alignTimeoutMs", "miningBeamViewMeters", "miningBeamRockMeters", "miningBeamRefreshMs",
  "miningBeamMaxFxPerPass", "fleeWindowMs", "fleeRetryMs", "fleeMinMeters", "gateControllerEventMaxPerPass",
  "miningBeamStartMeters", "miningBeamApproachMeters", "miningBeamRetryMs",
  "ratterPermille", "ratterMaxPerSystem", "ratterBeltsMin", "ratterBeltsMax", "ratterDwellMinMs", "ratterDwellMaxMs",
  "ratterLandingMeters", "ratterOrbitMeters", "ratterOrbitSpeedPermille", "ratterLegMs",
  "explorerPermille", "explorerMaxPerSystem", "explorerMaxSites", "explorerScanMs", "explorerSiteDwellMs",
  "explorerSiteOffsetMeters", "explorerNpcClearMeters", "explorerSafeSpotOffsetMeters", "explorerSafeSpotMinMeters",
  "explorerSafeSpotTries", "explorerSiteReadsPerPass", "explorerLegMs", "fleeAlarmMeters", "fleeAlarmMaxPerPass",
  "visibleWarpMaxFxPerPass", "gateArrivalTurnMinDeg", "gateArrivalTurnMaxDeg"]);
const TRAFFIC_POSITIVE = Object.freeze(["pollMs", "spawnIntervalMs", "maxLifetimeMs", "civiliansPerShip",
  "maxSystemsPerPass", "arrivalMeters", "maxWarpAttempts", "gateJumpInDurationMs", "gateJumpOutDespawnMs",
  "alignTimeoutMs", "miningBeamViewMeters", "miningBeamRockMeters", "miningBeamRefreshMs", "fleeWindowMs",
  "fleeRetryMs", "miningBeamStartMeters", "miningBeamApproachMeters", "miningBeamRetryMs",
  "ratterBeltsMin", "ratterBeltsMax", "ratterDwellMinMs", "ratterOrbitMeters", "ratterOrbitSpeedPermille",
  "ratterLegMs", "explorerMaxSites", "explorerScanMs", "explorerSiteDwellMs", "explorerNpcClearMeters",
  "explorerSafeSpotTries", "explorerLegMs", "fleeAlarmMeters"]);
const TRAFFIC_BOOLEANS = Object.freeze(["undockEnabled", "dockToPointEnabled", "gateIdleEnabled", "namesEnabled",
  "minerEnabled", "gateJumpFxEnabled", "alignBeforeWarpEnabled", "miningBeamsEnabled", "fleeEnabled",
  "gateControllerEventsEnabled", "miningBeamApproachEnabled", "ratterEnabled", "explorerEnabled", "fleeAlarmEnabled",
  "visibleWarpEnabled", "gateArrivalPoseEnabled", "ratterCombatEnabled"]);
const NO_ACTIVITY_INTENTS = Object.freeze([]);
const EXPLORER_FAMILIES = Object.freeze(["data", "relic"]);

function parseExplorerFamilies(value) {
  const parts = splitList(value);
  if (!parts || parts.some((p) => !EXPLORER_FAMILIES.includes(p)) || new Set(parts).size !== parts.length) return null;
  return Object.freeze(parts);
}

function trafficActivityIntentsOf(config) {
  const H = config && typeof config === "object" ? config.highsecLife : null;
  const T = H && typeof H === "object" ? H.traffic : null;
  if (!T || typeof T !== "object" || H.enabled !== true || T.enabled !== true || H.civilianHullsEnabled !== true) {
    return NO_ACTIVITY_INTENTS;
  }
  const out = [];
  if (T.ratterEnabled === true) out.push("RAT");
  if (T.explorerEnabled === true) out.push("EXPLORE");
  return out.length > 0 ? Object.freeze(out) : NO_ACTIVITY_INTENTS;
}

function trafficSettingsOf(config) {
  const T = config && config.highsecLife && config.highsecLife.traffic;
  if (!T || typeof T !== "object") return { ok: false, reason: "INVALID_SETTINGS", detail: "traffic" };
  if (typeof T.enabled !== "boolean") return { ok: false, reason: "INVALID_SETTINGS", detail: "traffic.enabled" };
  for (const k of TRAFFIC_INTS) {
    if (!Number.isSafeInteger(T[k]) || T[k] < 0) return { ok: false, reason: "INVALID_SETTINGS", detail: `traffic.${k}` };
  }
  for (const k of TRAFFIC_POSITIVE) {
    if (T[k] <= 0) return { ok: false, reason: "INVALID_SETTINGS", detail: `traffic.${k}` };
  }
  const bands = parseBands(T.bands);
  if (!bands) return { ok: false, reason: "INVALID_SETTINGS", detail: "traffic.bands" };
  const explorerFamilies = parseExplorerFamilies(T.explorerFamilies);
  if (!explorerFamilies) return { ok: false, reason: "INVALID_SETTINGS", detail: "traffic.explorerFamilies" };
  for (const k of TRAFFIC_BOOLEANS) {
    if (typeof T[k] !== "boolean") return { ok: false, reason: "INVALID_SETTINGS", detail: `traffic.${k}` };
  }
  if (T.gateIdleMinMs > T.gateIdleMaxMs) {
    return { ok: false, reason: "INVALID_SETTINGS", detail: "traffic.gateIdleMinMs>gateIdleMaxMs" };
  }
  if (T.minerStayMinMs > T.minerStayMaxMs) {
    return { ok: false, reason: "INVALID_SETTINGS", detail: "traffic.minerStayMinMs>minerStayMaxMs" };
  }
  if (T.ratterBeltsMin > T.ratterBeltsMax) {
    return { ok: false, reason: "INVALID_SETTINGS", detail: "traffic.ratterBeltsMin>ratterBeltsMax" };
  }
  if (T.ratterDwellMinMs > T.ratterDwellMaxMs) {
    return { ok: false, reason: "INVALID_SETTINGS", detail: "traffic.ratterDwellMinMs>ratterDwellMaxMs" };
  }
  if (T.gateArrivalTurnMinDeg > T.gateArrivalTurnMaxDeg) {
    return { ok: false, reason: "INVALID_SETTINGS", detail: "traffic.gateArrivalTurnMinDeg>gateArrivalTurnMaxDeg" };
  }
  const hulls = config.highsecLife.civilianHullsEnabled;
  if (hulls !== undefined && typeof hulls !== "boolean") {
    return { ok: false, reason: "INVALID_SETTINGS", detail: "highsecLife.civilianHullsEnabled" };
  }
  const settings = { enabled: T.enabled, bands, explorerFamilies };
  for (const k of TRAFFIC_INTS) settings[k] = T[k];
  for (const k of TRAFFIC_BOOLEANS) settings[k] = T[k];
  settings.civilianHullsEnabled = hulls === true;
  settings.stationTargetPermille = Math.min(T.stationTargetPermille, MAX_PERMILLE);
  settings.undockPermille = Math.min(T.undockPermille, MAX_PERMILLE);
  settings.gateIdlePermille = Math.min(T.gateIdlePermille, MAX_PERMILLE);
  settings.minerPermille = Math.min(T.minerPermille, MAX_PERMILLE);
  settings.ratterPermille = Math.min(T.ratterPermille, MAX_PERMILLE);
  settings.ratterOrbitSpeedPermille = Math.min(T.ratterOrbitSpeedPermille, MAX_PERMILLE);
  settings.explorerPermille = Math.min(T.explorerPermille, MAX_PERMILLE);
  settings.miningBeamApproachMeters = followMetersOf(T.miningBeamApproachMeters, T.miningBeamStartMeters);
  return { ok: true, settings: Object.freeze(settings) };
}

function parseGankSystemIds(value) {
  const ids = intList(value, 1, MAX_HUB_IDS, 1, Number.MAX_SAFE_INTEGER);
  return ids && new Set(ids).size === ids.length ? Object.freeze([...ids].sort((a, b) => a - b)) : null;
}

const GANK_INTS = Object.freeze(["pollMs", "bucketMs", "chancePermille", "freighterPermille", "gankersFreighterMin",
  "gankersFreighterMax", "gankersHaulerMin", "gankersHaulerMax", "fieldTtlMs", "maxPerPass"]);
const GANK_POSITIVE = Object.freeze(["pollMs", "bucketMs", "fieldTtlMs", "maxPerPass"]);
const GANK_RANGES = Object.freeze([["gankersFreighterMin", "gankersFreighterMax"],
  ["gankersHaulerMin", "gankersHaulerMax"]]);

function gankSettingsOf(config) {
  const G = config && config.highsecLife && config.highsecLife.gank;
  if (!G || typeof G !== "object") return { ok: false, reason: "INVALID_SETTINGS", detail: "gank" };
  if (typeof G.enabled !== "boolean") return { ok: false, reason: "INVALID_SETTINGS", detail: "gank.enabled" };
  const systemIds = parseGankSystemIds(G.systemIds);
  if (!systemIds) return { ok: false, reason: "INVALID_SETTINGS", detail: "gank.systemIds" };
  for (const k of GANK_INTS) {
    if (!Number.isSafeInteger(G[k]) || G[k] < 0) return { ok: false, reason: "INVALID_SETTINGS", detail: `gank.${k}` };
  }
  for (const k of GANK_POSITIVE) {
    if (G[k] <= 0) return { ok: false, reason: "INVALID_SETTINGS", detail: `gank.${k}` };
  }
  for (const [lo, hi] of GANK_RANGES) {
    if (G[lo] > G[hi]) return { ok: false, reason: "INVALID_SETTINGS", detail: `gank.${lo}>${hi}` };
  }
  const settings = { enabled: G.enabled, systemIds };
  for (const k of GANK_INTS) settings[k] = G[k];
  settings.chancePermille = Math.min(G.chancePermille, MAX_PERMILLE);
  settings.freighterPermille = Math.min(G.freighterPermille, MAX_PERMILLE);
  return { ok: true, settings: Object.freeze(settings) };
}

function settingsOf(config) {
  const H = config && config.highsecLife;
  if (!H || typeof H !== "object") return { ok: false, reason: "INVALID_SETTINGS", detail: "highsecLife" };
  const bands = parseBands(H.bands);
  if (!bands) return { ok: false, reason: "INVALID_SETTINGS", detail: "bands" };
  const nearHubPilots = parseNearHubPilots(H.nearHubPilots);
  if (!nearHubPilots) return { ok: false, reason: "INVALID_SETTINGS", detail: "nearHubPilots" };
  const hourCurvePermille = parseHourCurve(H.hourCurvePermille);
  if (!hourCurvePermille) return { ok: false, reason: "INVALID_SETTINGS", detail: "hourCurvePermille" };
  const hubSystemIds = parseHubSystemIds(H.hubSystemIds);
  if (!hubSystemIds) return { ok: false, reason: "INVALID_SETTINGS", detail: "hubSystemIds" };
  const ints = ["basePilots", "perStationPilots", "maxStationBonus", "hubPilots", "primeHubPilots", "maxHubJumps",
    "jitterPermille", "maxCiviliansPerSystem", "bucketMs", "churnPermille", "civilianCorps",
    "civilianMembersPerCorp"];
  for (const k of ints) {
    if (!Number.isSafeInteger(H[k]) || H[k] < 0) return { ok: false, reason: "INVALID_SETTINGS", detail: k };
  }
  if (H.bucketMs <= 0) return { ok: false, reason: "INVALID_SETTINGS", detail: "bucketMs" };
  const lp = config.localPilots;
  const localCap = lp && Number.isSafeInteger(lp.maxPilotsPerSystem) && lp.maxPilotsPerSystem >= 0
    ? lp.maxPilotsPerSystem : H.maxCiviliansPerSystem;
  const chatter = chatterSettingsOf(config);
  return { ok: true, settings: Object.freeze({
    chatter: chatter.ok ? chatter.settings : null,
    basePilots: H.basePilots,
    perStationPilots: H.perStationPilots,
    maxStationBonus: H.maxStationBonus,
    hubPilots: H.hubPilots,
    primeHubPilots: H.primeHubPilots,
    nearHubPilots,
    maxHubJumps: H.maxHubJumps,
    jitterPermille: Math.min(H.jitterPermille, MAX_PERMILLE),
    hourCurvePermille,
    maxCiviliansPerSystem: Math.min(H.maxCiviliansPerSystem, localCap),
    hubSystemIds,
    bucketMs: H.bucketMs,
    churnPermille: Math.min(H.churnPermille, MAX_PERMILLE),
    bands,
    civilianCorps: H.civilianCorps,
    civilianMembersPerCorp: H.civilianMembersPerCorp,
  }) };
}

module.exports = {
  CIVILIAN_POOL_ID,
  CIVILIAN_POOL_KEY,
  CIVILIAN_METRICS,
  CHATTER_METRICS,
  CHATTER_COUNTER_NAMES,
  RESIDENT_CHATTER_METRICS,
  RESIDENT_CHATTER_COUNTER_NAMES,
  TRAFFIC_METRICS,
  TRAFFIC_COUNTER_NAMES,
  AGGRO_COUNTER_NAMES,
  RAT_AGGRO_COUNTER_NAMES,
  TRAFFIC_STATE,
  GANK_METRICS,
  GANK_COUNTER_NAMES,
  GANK_STATE,
  CIVILIAN_OWNER_KIND,
  TARGET_REASON,
  STATE,
  COUNTER_NAMES,
  BANDS,
  HOURS_PER_DAY,
  EMPIRE_RACE_FACTION_IDS,
  SECURITY_RATING_MIN,
  SECURITY_RATING_MAX,
  parseBands,
  parseNearHubPilots,
  parseHourCurve,
  parseHubSystemIds,
  parseGankSystemIds,
  parseExplorerFamilies,
  settingsOf,
  chatterSettingsOf,
  freeChatterSettingsOf,
  trafficSettingsOf,
  trafficActivityIntentsOf,
  gankSettingsOf,
};
