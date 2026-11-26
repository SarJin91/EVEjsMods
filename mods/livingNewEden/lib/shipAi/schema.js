"use strict";

const { PERSONA_PRESETS, DEFAULT_PERSONAS } = require("./data/personaPresets");

const TABLE_NAME = "ship_ai_prefs";
const IDENTITY_KEY_PREFIX = "shipai:";
const COMMAND_NAME = "ai";
const COMMAND_RE = /^!\s*ai(?:\s[\s\S]*)?$/i;
const CHANNELS = Object.freeze(["private", "local"]);
const TRANSPORT_PRIVATE = "xmpp";

const STATE = Object.freeze({ OFF: "off", RUNNING: "running", DISABLED: "disabled", STOPPED: "stopped" });

const METRICS = Object.freeze(["shipAi.requests", "shipAi.failed", "shipAi.tokens", "shipAi.replies",
  "shipAi.rejected", "shipAi.toolCalls", "shipAi.proactive", "shipAi.memoryWrites", "shipAi.requestMs",
  "shipAi.mailSeen", "shipAi.mailDigests", "shipAi.mailSkipped",
  "shipAi.dbReadSlow",
  "shipAi.voiceLines", "shipAi.voiceSessions",
  "shipAi.voiceSynth", "shipAi.voiceSynthMs", "shipAi.voiceFailed",
  "shipAi.thinkingRequests", "shipAi.thinkingEmpty",
  "shipAi.watchReads", "shipAi.watchEvents",
  "shipAi.autostart.invited", "shipAi.autostart.noClient", "shipAi.autostart.roomRefused",
  "shipAi.autostart.voiceLinked", "shipAi.autostart.voiceRefused", "shipAi.autostart.expired",
  "shipAi.panel.reads", "shipAi.panel.writes", "shipAi.panel.actions", "shipAi.panel.refused"]);

const COUNTER_NAMES = Object.freeze(["invites", "roomMessages", "refusedNotPrivate", "denied", "recordsRestored",
  "roomCommands", "roomDenied", "memoryCommands", "renames",
  "personaCommands", "personaChanges", "personaRefused", "personaCustomSkipped"]);

const TURNS_TABLE = "ship_ai_turns";
const METRIC = Object.freeze({ requests: "shipAi.requests", failed: "shipAi.failed", tokens: "shipAi.tokens",
  replies: "shipAi.replies", rejected: "shipAi.rejected", requestMs: "shipAi.requestMs",
  toolCalls: "shipAi.toolCalls",
  memoryWrites: "shipAi.memoryWrites",
  proactive: "shipAi.proactive",
  mailSeen: "shipAi.mailSeen", mailDigests: "shipAi.mailDigests", mailSkipped: "shipAi.mailSkipped",
  dbReadSlow: "shipAi.dbReadSlow",
  voiceLines: "shipAi.voiceLines", voiceSessions: "shipAi.voiceSessions",
  voiceSynth: "shipAi.voiceSynth", voiceSynthMs: "shipAi.voiceSynthMs", voiceFailed: "shipAi.voiceFailed",
  thinkingRequests: "shipAi.thinkingRequests", thinkingEmpty: "shipAi.thinkingEmpty",
  watchReads: "shipAi.watchReads", watchEvents: "shipAi.watchEvents",
  autostartInvited: "shipAi.autostart.invited", autostartNoClient: "shipAi.autostart.noClient",
  autostartRoomRefused: "shipAi.autostart.roomRefused", autostartVoiceLinked: "shipAi.autostart.voiceLinked",
  autostartVoiceRefused: "shipAi.autostart.voiceRefused", autostartExpired: "shipAi.autostart.expired",
  panelReads: "shipAi.panel.reads", panelWrites: "shipAi.panel.writes", panelActions: "shipAi.panel.actions",
  panelRefused: "shipAi.panel.refused" });
const SUMMARIES_TABLE = "ship_ai_summaries";
const FACTS_TABLE = "ship_ai_facts";
const FACT_CATEGORIES = Object.freeze(["name", "nickname", "ship", "goal", "preference", "event", "relation", "other"]);
const FACT_SOURCES = Object.freeze(["player", "model", "game", "mail"]);
const FACT_REJECT_REASONS = Object.freeze(["CATEGORY", "LENGTH", "CHARSET", "BANNED", "INJECTION", "OTHER_PLAYER"]);
const TOOL_MODES = Object.freeze(["off", "text", "native"]);
const LANES = Object.freeze(["chat", "summary", "proactive", "mail"]);
const MAIL_MODES = Object.freeze(["on", "quiet", "off"]);
const STATIC_KINDS = Object.freeze(["TIRED", "SIGNAL_LOST", "DEFLECT", "BUSY", "INVITE_SENT", "HELP", "GREETING",
  "ACK", "OFFLINE",
  "LOW_HP", "SYSTEM_DANGER", "HOSTILES", "DOCK", "UNDOCK", "SHIP_CHANGE", "LOSS_SHIP", "LOSS_POD", "SILENCE",
  "THINKING",
  "SKILL_DONE", "JOB_READY", "ORDER_FILLED", "MISSION_EXPIRING",
  "ALERTS_ON", "ALERTS_OFF", "SCAN_ON", "SCAN_OFF"]);
const ALERT_MODES = Object.freeze(["on", "off"]);
const REPLY_REJECT_REASONS = Object.freeze(["EMPTY", "LINK", "CHARSET", "BANNED", "SEXUAL", "META", "LENGTH"]);
const LANGUAGE_CODES = Object.freeze(["en", "pl"]);
const PROFANITY_LEVELS = Object.freeze(["off", "mild", "full"]);
const MODEL_RE = /^[A-Za-z0-9._:/-]{1,128}$/;
const MODEL_INTEGER_KEYS = Object.freeze(["temperatureMilli", "topPMilli", "maxTokens", "timeoutMs",
  "maxResponseBytes", "maxRequestsPerMinute", "maxInFlight", "dailyTokenBudget", "perCharacterDailyTokens",
  "summaryLanePermille", "proactiveLanePermille", "breakerFailures", "breakerCooldownMs", "breakerMaxCooldownMs",
  "historyTurns", "historyMaxChars", "turnsKeep", "contextMaxChars", "contextCacheMs", "maxUserChars",
  "maxPendingChars", "maxLineChars", "maxLinesPerReply", "minIntervalMs", "pumpIntervalMs", "sharedKeyMaxRpm",
  "toolMaxRounds", "toolCallsPerRound", "toolResultMaxChars", "toolBudgetMs", "toolCacheMs", "toolMaxRows",
  "threatMaxJumps",
  "summaryEveryTurns", "summaryMaxChars", "summaryMaxTokens", "maxFactsPerCharacter", "factsInPrompt",
  "factsMaxChars", "factMaxChars", "factTtlDays", "playerFactTtlDays", "renameCooldownMs", "forgetConfirmMs",
  "proactivePollMs", "lowHpPermille", "lowHpCooldownMs", "proactiveKindCooldownMs", "proactiveMinIntervalMs",
  "silenceMs", "eventsKeep",
  "portraitMaxBytes", "portraitBootBatch",
  "mailDigestWindowMs", "mailMinIntervalMs", "mailLoginDelayMs", "mailPollMs", "mailRescanMs", "mailMaxPerDigest",
  "mailOfflineDigestMax", "mailMaxBodyChars", "mailMaxTitleChars", "mailPlayersPerPass", "mailLanePermille",
  "mailFactsPerDigest", "mailFactMaxImportance", "mailFactTtlDays",
  "dbReadSlowMs", "dbReadAsyncTimeoutMs", "walletSumWindowMs",
  "thinkingMaxTokens", "thinkingTimeoutMs", "thinkingNoticeMs",
  "proactiveToolMaxRounds", "backgroundMaxRequestsPerMinute",
  "watchPollMs", "watchReadsPerPass", "watchPassBudgetMs", "watchLoginDelayMs", "watchLookbackMs", "watchRescanMs",
  "skillWatchMs", "missionWarnMs", "watchMaxPending", "watchMaxPerLine", "watchPendingMaxAgeMs",
  "marketWatchMs",
  "personaCustomMaxChars",
  "calloutGridRangeMeters", "calloutScanMax", "calloutInvaderCacheMs", "calloutSystemCooldownMs",
  "calloutGridCooldownMs", "calloutAttackCooldownMs", "calloutMinGapMs", "calloutGrowthMin", "calloutClearMs",
  "calloutClosingMeters", "calloutMaxChars", "calloutMaxNameChars",
  "calloutInboundMax",
  "calloutWaveCooldownMs",
  "dscanMaxEntries",
  "calloutScanLookupMax",
  "calloutScanCooldownMs",
  "dscanIntervalMs", "dscanPollMs", "dscanLoginDelayMs", "dscanScansPerPass", "dscanPassBudgetMs", "dscanMaxPlayers",
  "dscanRefusedBackoffMs", "dscanSeenTtlMs", "dscanSeenMax", "dscanMaxPilotsChecked",
  "wingHpWarnPct", "wingHpCriticalPct", "wingHpThresholdRefreshMs", "wingHpRearmPct", "wingHpLayerCooldownMs",
  "wingHpMinGapMs", "wingHpMaxPerLine", "wingHpPendingMaxAgeMs", "wingHpMaxChars", "wingHpMaxNameChars",
  "wingHpScanMax", "wingHpCopiesMax",
  "wingHpCarryMs", "wingHpStatsLogMs",
  "capLowPermille", "capLowRearmPermille", "capLowCooldownMs", "dockRepairPermille", "triggerQueueMax",
  "triggerPendingMaxAgeMs",
  "miningCooldownMs", "siteClearedScanMax", "killCooldownMs", "navyKillCooldownMs",
  "bountyMinIsk", "iskInMinIsk", "walletRescanMs", "walletCursorSlackMs", "missionObjectivePollMs",
  "welcomeMinOfflineMs", "welcomeSeenWriteMs", "welcomeMaxWaitMs",
  "worldNewsRadiusJumps", "worldNewsSystemCooldownMs", "worldNewsCooldownMs", "worldHereCooldownMs",
  "worldHereScanMs", "worldHereSeenMax",
  "abyssalScanMs", "abyssalSeenMax", "abyssalFinishedLookbackMs", "abyssalFinishedLimit"]);
const MODEL_POSITIVE_KEYS = Object.freeze(["maxTokens", "timeoutMs", "maxResponseBytes", "maxInFlight",
  "breakerFailures", "historyMaxChars", "turnsKeep", "contextMaxChars", "maxUserChars", "maxPendingChars",
  "maxLineChars", "maxLinesPerReply", "pumpIntervalMs", "toolCallsPerRound", "toolResultMaxChars", "toolMaxRows",
  "summaryEveryTurns", "summaryMaxChars", "summaryMaxTokens", "maxFactsPerCharacter", "factMaxChars", "factTtlDays",
  "playerFactTtlDays", "forgetConfirmMs", "proactivePollMs", "eventsKeep", "portraitMaxBytes", "portraitBootBatch",
  "mailPollMs", "mailMaxPerDigest", "mailOfflineDigestMax", "mailMaxBodyChars", "mailMaxTitleChars",
  "mailPlayersPerPass", "mailFactMaxImportance", "mailFactTtlDays", "dbReadSlowMs", "dbReadAsyncTimeoutMs",
  "walletSumWindowMs", "thinkingMaxTokens", "thinkingTimeoutMs", "watchPollMs", "watchReadsPerPass",
  "watchPassBudgetMs", "watchRescanMs", "skillWatchMs", "missionWarnMs", "watchMaxPending", "watchMaxPerLine",
  "watchPendingMaxAgeMs", "marketWatchMs", "personaCustomMaxChars", "calloutGridRangeMeters", "calloutScanMax",
  "calloutGrowthMin", "calloutClosingMeters", "calloutMaxChars", "calloutMaxNameChars", "calloutInboundMax",
  "dscanMaxEntries", "calloutScanLookupMax", "dscanIntervalMs", "dscanPollMs", "dscanScansPerPass",
  "dscanPassBudgetMs", "dscanMaxPlayers", "dscanRefusedBackoffMs", "dscanSeenTtlMs", "dscanSeenMax",
  "dscanMaxPilotsChecked", "wingHpWarnPct", "wingHpCriticalPct", "wingHpThresholdRefreshMs", "wingHpMaxPerLine",
  "wingHpPendingMaxAgeMs", "wingHpMaxChars", "wingHpMaxNameChars", "wingHpScanMax", "wingHpCopiesMax",
  "capLowPermille", "capLowRearmPermille", "dockRepairPermille", "triggerQueueMax", "triggerPendingMaxAgeMs",
  "siteClearedScanMax", "walletRescanMs", "missionObjectivePollMs", "welcomeMinOfflineMs", "welcomeSeenWriteMs",
  "welcomeMaxWaitMs", "worldHereScanMs", "worldHereSeenMax", "abyssalScanMs", "abyssalSeenMax",
  "abyssalFinishedLookbackMs", "abyssalFinishedLimit"]);
const WING_HP_SOURCES = Object.freeze(["shipWing", "config"]);
const WING_HP_DEFAULT_MARKS = Object.freeze({ warnPct: 90, criticalPct: 50 });
const REASONING_EFFORTS = Object.freeze(["", "low", "medium", "high"]);
const THINKING_BOOLEAN_KEYS = Object.freeze(["thinkingChat", "thinkingProactive", "thinkingToolRounds",
  "thinkingRetryEmpty",
  "proactiveToolsEnabled", "dangerBriefEnabled"]);

const PORTRAIT_DIR = "shipAi";
const PORTRAIT_STATUS = Object.freeze(["off", "default", "bad_file", "too_large", "stored", "unchanged", "failed"]);

const EVENTS_TABLE = "ship_ai_events";
const EVENT_KINDS = Object.freeze(["LOSS_SHIP", "LOSS_POD", "SYSTEM_DANGER", "REGION_ENTER", "DOCK", "UNDOCK",
  "SHIP_CHANGE", "LOW_HP", "HOSTILES",
  "SKILL_DONE", "JOB_READY", "ORDER_FILLED", "MISSION_EXPIRING",
  "CRIMINAL", "SUSPECT", "CRIME_CLEAR", "CAP_LOW", "SEC_STATUS_DROP", "DOCK_DAMAGED", "MINING_CARGO_FULL",
  "MINING_CRYSTAL", "SITE_CLEARED", "NAVY_KILL", "NOTABLE_KILL", "BOUNTY_PAID", "ISK_IN", "SKILL_QUEUE_EMPTY",
  "MISSION_OBJECTIVE", "WELCOME_BACK", "WORLD_NEWS", "BATTLE_HERE", "EVENT_HERE"]);
const MUTE_KINDS = Object.freeze(["LOW_HP", "WING_LOSS", "WING_HP", "SYSTEM_DANGER", "MISSION_EXPIRING", "SHIP_CHANGE",
  "SKILL_DONE", "JOB_READY", "ORDER_FILLED", "UNDOCK", "DOCK", "SILENCE", "CRIMINAL", "SUSPECT", "CAP_LOW", "NAVY_KILL",
  "SEC_STATUS_DROP", "BATTLE_HERE", "MISSION_OBJECTIVE", "WORLD_NEWS", "MINING_CARGO_FULL", "NOTABLE_KILL",
  "SITE_CLEARED", "EVENT_HERE", "MINING_CRYSTAL", "SKILL_QUEUE_EMPTY", "BOUNTY_PAID", "ISK_IN", "DOCK_DAMAGED",
  "CRIME_CLEAR", "REGION_ENTER", "WELCOME_BACK",
  "ABYSSAL"]);
const RAM_TRIGGER_KINDS = Object.freeze(["ABYSSAL"]);
const CAP_LOW_DEFAULT_PAIR = Object.freeze({ lowPermille: 150, rearmPermille: 400 });
const MUTED_KINDS_MAX_CHARS = 1024;
const WATCH_KINDS = Object.freeze(["SKILL_DONE", "JOB_READY", "ORDER_FILLED", "MISSION_EXPIRING",
  "BOUNTY_PAID", "ISK_IN", "SKILL_QUEUE_EMPTY", "MISSION_OBJECTIVE"]);
const { WELCOME_DEFAULT_PAIR } = require("./data/triggers");
const CAPSULE_TYPE_IDS = Object.freeze([670, 33328]);
const EVENT_PAYLOAD_MAX_CHARS = 300;

function checkHttpsUrl(text) {
  if (typeof text !== "string" || text === "") return false;
  let url;
  try {
    url = new URL(text);
  } catch (_err) {
    return false;
  }
  return url.protocol === "https:" && url.username === "" && url.password === "" && url.search === ""
    && url.hash === "";
}

function shipAiModelSettingsOf(config) {
  const c = config && config.shipAi;
  const bad = (detail) => ({ ok: false, reason: "INVALID_SETTINGS", detail });
  if (!c || typeof c !== "object") return bad("shipAi section");
  if (!checkHttpsUrl(c.baseUrl)) return bad("baseUrl");
  if (typeof c.model !== "string" || !MODEL_RE.test(c.model)) return bad("model");
  if (typeof c.reasoningOff !== "boolean") return bad("reasoningOff");
  if (!LANGUAGE_CODES.includes(c.language)) return bad("language");
  if (!PROFANITY_LEVELS.includes(c.profanity)) return bad("profanity");
  if (!TOOL_MODES.includes(c.toolMode)) return bad("toolMode");
  if (typeof c.memoryEnabled !== "boolean") return bad("memoryEnabled");
  if (typeof c.proactiveEnabled !== "boolean") return bad("proactiveEnabled");
  if (typeof c.portraitEnabled !== "boolean") return bad("portraitEnabled");
  if (typeof c.mailEnabled !== "boolean") return bad("mailEnabled");
  if (typeof c.dbReadEnabled !== "boolean") return bad("dbReadEnabled");
  if (typeof c.dbReadDisabledTools !== "string") return bad("dbReadDisabledTools");
  if (typeof c.watchEnabled !== "boolean") return bad("watchEnabled");
  if (typeof c.watchDisabledKinds !== "string") return bad("watchDisabledKinds");
  if (!DEFAULT_PERSONAS.includes(c.defaultPersona)) return bad("defaultPersona");
  if (typeof c.calloutEnabled !== "boolean") return bad("calloutEnabled");
  if (!Number.isSafeInteger(c.calloutHostileStandingTenths) || c.calloutHostileStandingTenths < -100
    || c.calloutHostileStandingTenths > 0) return bad("calloutHostileStandingTenths");
  if (typeof c.calloutInboundEnabled !== "boolean") return bad("calloutInboundEnabled");
  if (typeof c.dscanAutoEnabled !== "boolean") return bad("dscanAutoEnabled");
  if (typeof c.calloutHostileFactionIds !== "string") return bad("calloutHostileFactionIds");
  if (typeof c.wingHpEnabled !== "boolean") return bad("wingHpEnabled");
  if (typeof c.wingLossLineEnabled !== "boolean") return bad("wingLossLineEnabled");
  if (!WING_HP_SOURCES.includes(c.wingHpThresholdSource)) return bad("wingHpThresholdSource");
  const TRIGGER_BOOLEANS = ["triggersEnabled", "crimeWatchEnabled", "regionLineEnabled", "miningLinesEnabled",
    "siteClearedEnabled", "killLinesEnabled", "walletWatchEnabled", "queueWatchEnabled", "welcomeEnabled",
    "worldNewsEnabled", "worldNewsModel", "battleHereEnabled", "eventHereEnabled",
    "abyssalLinesEnabled"];
  const TRIGGER_STRINGS = ["secStatusThresholds", "triggersDisabledKinds", "notableKillClasses",
    "notableKillNamePatterns", "worldNewsKinds", "abyssalWarnAtMs"];
  for (const key of TRIGGER_BOOLEANS) {
    if (typeof c[key] !== "boolean") return bad(key);
  }
  for (const key of TRIGGER_STRINGS) {
    if (typeof c[key] !== "string") return bad(key);
  }
  const out = { baseUrl: c.baseUrl, model: c.model, reasoningOff: c.reasoningOff, language: c.language,
    profanity: c.profanity, toolMode: c.toolMode, memoryEnabled: c.memoryEnabled,
    proactiveEnabled: c.proactiveEnabled, portraitEnabled: c.portraitEnabled, mailEnabled: c.mailEnabled,
    dbReadEnabled: c.dbReadEnabled, dbReadDisabledTools: c.dbReadDisabledTools, watchEnabled: c.watchEnabled,
    watchDisabledKinds: c.watchDisabledKinds, defaultPersona: c.defaultPersona, calloutEnabled: c.calloutEnabled,
    calloutHostileStandingTenths: c.calloutHostileStandingTenths, calloutInboundEnabled: c.calloutInboundEnabled,
    dscanAutoEnabled: c.dscanAutoEnabled, calloutHostileFactionIds: c.calloutHostileFactionIds,
    wingHpEnabled: c.wingHpEnabled, wingLossLineEnabled: c.wingLossLineEnabled,
    wingHpThresholdSource: c.wingHpThresholdSource, triggersEnabled: c.triggersEnabled,
    crimeWatchEnabled: c.crimeWatchEnabled, regionLineEnabled: c.regionLineEnabled,
    secStatusThresholds: c.secStatusThresholds, triggersDisabledKinds: c.triggersDisabledKinds };
  for (const key of [...TRIGGER_BOOLEANS, ...TRIGGER_STRINGS]) out[key] = c[key];
  for (const key of THINKING_BOOLEAN_KEYS) {
    if (typeof c[key] !== "boolean") return bad(key);
    out[key] = c[key];
  }
  if (!REASONING_EFFORTS.includes(c.reasoningEffort)) return bad("reasoningEffort");
  out.reasoningEffort = c.reasoningEffort;
  for (const key of MODEL_INTEGER_KEYS) {
    const v = c[key];
    if (!Number.isSafeInteger(v) || v < 0) return bad(key);
    if (MODEL_POSITIVE_KEYS.includes(key) && v < 1) return bad(key);
    out[key] = v;
  }
  if (out.breakerCooldownMs > out.breakerMaxCooldownMs) return bad("breakerCooldownMs");
  if (out.mailFactMaxImportance > 5) return bad("mailFactMaxImportance");
  if (out.personaCustomMaxChars > 400) return bad("personaCustomMaxChars");
  if (out.wingHpCriticalPct >= out.wingHpWarnPct) {
    out.wingHpWarnPct = WING_HP_DEFAULT_MARKS.warnPct;
    out.wingHpCriticalPct = WING_HP_DEFAULT_MARKS.criticalPct;
  }
  if (out.capLowRearmPermille <= out.capLowPermille || out.capLowPermille > 1000 || out.capLowRearmPermille > 1000) {
    out.capLowPermille = CAP_LOW_DEFAULT_PAIR.lowPermille;
    out.capLowRearmPermille = CAP_LOW_DEFAULT_PAIR.rearmPermille;
  }
  if (out.welcomeSeenWriteMs >= out.welcomeMinOfflineMs) {
    out.welcomeMinOfflineMs = WELCOME_DEFAULT_PAIR.minOfflineMs;
    out.welcomeSeenWriteMs = WELCOME_DEFAULT_PAIR.seenWriteMs;
  }
  out.backgroundMaxRequestsPerMinute = Math.min(out.backgroundMaxRequestsPerMinute, out.maxRequestsPerMinute);
  return { ok: true, settings: Object.freeze(out) };
}

const VOICE_ENGINES = Object.freeze(["browser", "piper"]);
const VOICE_INTEGER_RANGES = Object.freeze({ voiceLinkTtlMs: [60000, 3600000], voiceLinkCooldownMs: [0, 600000],
  voiceSessionTtlMs: [600000, 86400000], voiceMaxSessions: [1, 16], voicePollMs: [500, 10000],
  voiceListenerIdleMs: [3000, 120000], voiceQueueMax: [1, 32], voiceLineTtlMs: [10000, 600000],
  voiceMaxLineChars: [40, 2000], voiceMaxPartChars: [40, 400], voiceRateMilli: [500, 2000],
  voicePitchMilli: [500, 2000],
  voicePiperTimeoutMs: [1000, 60000], voicePiperMaxBytes: [65536, 8388608], voicePiperMaxInFlight: [1, 4],
  voiceLengthScaleMilli: [500, 2000], voiceCacheMaxBytes: [0, 67108864], voiceDailyChars: [0, 10000000],
  voiceBreakerFailures: [1, 20], voiceBreakerCooldownMs: [1000, 3600000],
  voiceChoiceCooldownMs: [0, 60000], voiceTestCooldownMs: [0, 60000], voiceTestTimeoutMs: [1000, 4500],
  voicePiperListTimeoutMs: [500, 4500], voicePiperVoicesTtlMs: [10000, 3600000],
  voicePiperListMaxBytes: [16384, 2097152], voicePiperMaxVoices: [1, 64],
  panelCooldownMs: [0, 60000] });
const VOICE_NAME_MAX_CHARS = 64;
const VOICE_BOOLEAN_KEYS = Object.freeze(["voiceEnabled", "voiceAllowRemote", "voiceShowText", "voiceRadioFilter",
  "voiceFallbackBrowser", "voicePickerEnabled", "panelEnabled"]);
const PIPER_VOICE_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const PIPER_URL_MAX_CHARS = 512;

function shipAiVoiceSettingsOf(config) {
  const c = config && config.shipAi;
  const bad = (detail) => ({ ok: false, reason: "INVALID_SETTINGS", detail });
  if (!c || typeof c !== "object") return bad("shipAi section");
  const out = {};
  for (const key of VOICE_BOOLEAN_KEYS) {
    if (typeof c[key] !== "boolean") return bad(key);
    out[key] = c[key];
  }
  if (!VOICE_ENGINES.includes(c.voiceEngine)) return bad("voiceEngine");
  out.voiceEngine = c.voiceEngine;
  if (typeof c.voiceName !== "string" || c.voiceName.length > VOICE_NAME_MAX_CHARS
    || /[\u0000-\u001f\u007f]/.test(c.voiceName)) return bad("voiceName");
  out.voiceName = c.voiceName;
  if (typeof c.voicePiperUrl !== "string" || c.voicePiperUrl.length > PIPER_URL_MAX_CHARS
    || /[\u0000-\u001f\u007f]/.test(c.voicePiperUrl)) return bad("voicePiperUrl");
  out.voicePiperUrl = c.voicePiperUrl;
  for (const key of ["voicePiperVoicePl", "voicePiperVoiceEn"]) {
    if (typeof c[key] !== "string" || (c[key] !== "" && !PIPER_VOICE_RE.test(c[key]))) return bad(key);
    out[key] = c[key];
  }
  for (const [key, [min, max]] of Object.entries(VOICE_INTEGER_RANGES)) {
    const v = c[key];
    if (!Number.isSafeInteger(v) || v < min || v > max) return bad(key);
    out[key] = v;
  }
  return { ok: true, settings: Object.freeze(out) };
}

function apiKeyOf(config) {
  const own = config && config.shipAi && typeof config.shipAi.apiKey === "string" ? config.shipAi.apiKey.trim() : "";
  const chatter = config && config.chatterAi && typeof config.chatterAi.apiKey === "string"
    ? config.chatterAi.apiKey.trim() : "";
  const key = own !== "" ? own : chatter;
  return { key, shared: key !== "" && key === chatter };
}

function sharedKeyRpmCheck(config, settings) {
  const C = config && config.chatterAi;
  const chatterOn = Boolean(C && C.enabled === true);
  const chatterRpm = chatterOn && Number.isSafeInteger(C.maxRequestsPerMinute) ? C.maxRequestsPerMinute : 0;
  const sum = chatterRpm + settings.maxRequestsPerMinute;
  const keys = apiKeyOf(config);
  return { warn: chatterOn && keys.shared && sum > settings.sharedKeyMaxRpm, sum, limit: settings.sharedKeyMaxRpm };
}

function backgroundRpmClamped(config, settings) {
  const raw = config && config.shipAi ? config.shipAi.backgroundMaxRequestsPerMinute : null;
  return Number.isSafeInteger(raw) && Boolean(settings) && raw > settings.backgroundMaxRequestsPerMinute;
}

const AI_TYPE_ID = 1373;
const AI_GENDER = 0;
const MAX_NAME_CHARS = 37;
const MAX_BIO_CHARS = 1000;

const isId = (v) => Number.isSafeInteger(v) && v > 0;

function identityKeyOf(playerId) {
  return `${IDENTITY_KEY_PREFIX}${playerId}`;
}

function parseAllowlist(csv) {
  if (typeof csv !== "string") return { ok: false, reason: "INVALID_SETTINGS", detail: "allowCharacterIds" };
  const text = csv.trim();
  if (text === "") return { ok: true, all: false, ids: Object.freeze(new Set()) };
  if (text === "*") return { ok: true, all: true, ids: Object.freeze(new Set()) };
  const ids = new Set();
  for (const part of text.split(",")) {
    const token = part.trim();
    const n = /^\d{1,15}$/.test(token) ? Number(token) : 0;
    if (!isId(n)) return { ok: false, reason: "INVALID_SETTINGS", detail: `allowCharacterIds: ${token.slice(0, 20)}` };
    ids.add(n);
  }
  return { ok: true, all: false, ids: Object.freeze(ids) };
}

function isAllowed(allow, characterId) {
  return Boolean(allow) && (allow.all === true || (allow.ids instanceof Set && allow.ids.has(characterId)));
}

function shipAiSettingsOf(config) {
  const c = config && config.shipAi;
  if (!c || typeof c !== "object") return { ok: false, reason: "INVALID_SETTINGS", detail: "shipAi section" };
  const bad = (detail) => ({ ok: false, reason: "INVALID_SETTINGS", detail });
  if (typeof c.enabled !== "boolean") return bad("enabled");
  if (!CHANNELS.includes(c.channel)) return bad("channel");
  const allow = parseAllowlist(c.allowCharacterIds);
  if (!allow.ok) return allow;
  const name = typeof c.defaultName === "string" ? c.defaultName.trim() : "";
  if (name === "" || name.length > MAX_NAME_CHARS) return bad("defaultName");
  if (typeof c.bio !== "string" || c.bio.length > MAX_BIO_CHARS) return bad("bio");
  for (const key of ["corporationId", "maxIdentities", "xmppMaxBatchBytes"]) {
    if (!isId(c[key])) return bad(key);
  }
  if (!Number.isSafeInteger(c.minIntervalMs) || c.minIntervalMs < 0) return bad("minIntervalMs");
  return { ok: true, settings: Object.freeze({ enabled: c.enabled, channel: c.channel, allow,
    defaultName: name, bio: c.bio, corporationId: c.corporationId, maxIdentities: c.maxIdentities,
    minIntervalMs: c.minIntervalMs, xmppMaxBatchBytes: c.xmppMaxBatchBytes }) };
}

function upShipAiPrefs(db) {
  db.exec(`CREATE TABLE ship_ai_prefs (
    player_character_id INTEGER PRIMARY KEY CHECK (player_character_id > 0),
    ai_character_id     INTEGER NOT NULL UNIQUE CHECK (ai_character_id > 0),
    ai_name             TEXT    NOT NULL CHECK (length(ai_name) >= 1),
    language            TEXT    NULL,
    quiet               INTEGER NOT NULL DEFAULT 0 CHECK (quiet IN (0, 1)),
    portrait_sha        TEXT    NULL,
    created_at          INTEGER NOT NULL CHECK (created_at >= 0),
    updated_at          INTEGER NOT NULL CHECK (updated_at >= 0),
    last_proactive_at   INTEGER NULL,
    version             INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1)
  );`);
}

function upShipAiTurns(db) {
  db.exec(`CREATE TABLE ship_ai_turns (
    player_character_id INTEGER NOT NULL CHECK (player_character_id > 0),
    seq                 INTEGER NOT NULL CHECK (seq >= 1),
    role                TEXT    NOT NULL CHECK (role IN ('user', 'assistant')),
    text                TEXT    NOT NULL,
    created_at          INTEGER NOT NULL CHECK (created_at >= 0),
    PRIMARY KEY (player_character_id, seq)
  );`);
}

function upShipAiMemory(db) {
  db.exec(`CREATE TABLE ship_ai_summaries (
    player_character_id INTEGER PRIMARY KEY CHECK (player_character_id > 0),
    version             INTEGER NOT NULL CHECK (version >= 1),
    text                TEXT    NOT NULL,
    covers_through_seq  INTEGER NOT NULL CHECK (covers_through_seq >= 0),
    updated_at          INTEGER NOT NULL CHECK (updated_at >= 0)
  );
  CREATE TABLE ship_ai_facts (
    fact_id             INTEGER PRIMARY KEY AUTOINCREMENT,
    player_character_id INTEGER NOT NULL CHECK (player_character_id > 0),
    category            TEXT    NOT NULL CHECK (category IN ('name', 'nickname', 'ship', 'goal', 'preference',
                          'event', 'relation', 'other')),
    content             TEXT    NOT NULL CHECK (length(content) >= 1),
    norm_key            TEXT    NOT NULL,
    importance          INTEGER NOT NULL CHECK (importance BETWEEN 1 AND 5),
    source              TEXT    NOT NULL CHECK (source IN ('player', 'model', 'game', 'mail')),
    created_at          INTEGER NOT NULL CHECK (created_at >= 0),
    last_used_at        INTEGER NOT NULL CHECK (last_used_at >= 0),
    expires_at          INTEGER NOT NULL CHECK (expires_at >= 0),
    UNIQUE (player_character_id, norm_key)
  );
  CREATE INDEX ship_ai_facts_expiry ON ship_ai_facts (player_character_id, expires_at);`);
}

function upShipAiEvents(db) {
  db.exec(`CREATE TABLE ship_ai_events (
    player_character_id INTEGER NOT NULL CHECK (player_character_id > 0),
    event_key           TEXT    NOT NULL CHECK (length(event_key) >= 1),
    kind                TEXT    NOT NULL CHECK (kind IN ('LOSS_SHIP', 'LOSS_POD', 'SYSTEM_DANGER', 'REGION_ENTER',
                          'DOCK', 'UNDOCK', 'SHIP_CHANGE', 'LOW_HP', 'HOSTILES')),
    payload             TEXT    NOT NULL,
    occurred_at         INTEGER NOT NULL CHECK (occurred_at >= 0),
    mentioned_at        INTEGER NULL,
    PRIMARY KEY (player_character_id, event_key)
  );
  CREATE INDEX ship_ai_events_recent ON ship_ai_events (player_character_id, occurred_at);`);
}

function upShipAiPrefsMail(db) {
  db.exec(`ALTER TABLE ship_ai_prefs ADD COLUMN mail_mode TEXT NOT NULL DEFAULT 'on'
    CHECK (mail_mode IN ('on', 'quiet', 'off'));
  ALTER TABLE ship_ai_prefs ADD COLUMN mail_seen_id INTEGER NULL CHECK (mail_seen_id IS NULL OR mail_seen_id >= 0);`);
}

function upShipAiEventsWatchKinds(db) {
  db.exec(`CREATE TABLE ship_ai_events_v89 (
    player_character_id INTEGER NOT NULL CHECK (player_character_id > 0),
    event_key           TEXT    NOT NULL CHECK (length(event_key) >= 1),
    kind                TEXT    NOT NULL CHECK (kind IN ('LOSS_SHIP', 'LOSS_POD', 'SYSTEM_DANGER', 'REGION_ENTER',
                          'DOCK', 'UNDOCK', 'SHIP_CHANGE', 'LOW_HP', 'HOSTILES', 'SKILL_DONE', 'JOB_READY',
                          'ORDER_FILLED', 'MISSION_EXPIRING')),
    payload             TEXT    NOT NULL,
    occurred_at         INTEGER NOT NULL CHECK (occurred_at >= 0),
    mentioned_at        INTEGER NULL,
    PRIMARY KEY (player_character_id, event_key)
  );
  INSERT INTO ship_ai_events_v89 (player_character_id, event_key, kind, payload, occurred_at, mentioned_at)
    SELECT player_character_id, event_key, kind, payload, occurred_at, mentioned_at FROM ship_ai_events;
  DROP TABLE ship_ai_events;
  ALTER TABLE ship_ai_events_v89 RENAME TO ship_ai_events;
  CREATE INDEX ship_ai_events_recent ON ship_ai_events (player_character_id, occurred_at);`);
}

function upShipAiPrefsPersona(db) {
  db.exec(`ALTER TABLE ship_ai_prefs ADD COLUMN persona_preset TEXT NULL
    CHECK (persona_preset IS NULL OR length(persona_preset) BETWEEN 1 AND 24);
  ALTER TABLE ship_ai_prefs ADD COLUMN persona_custom TEXT NULL
    CHECK (persona_custom IS NULL OR length(persona_custom) BETWEEN 1 AND 400);`);
}

function upShipAiPrefsAlerts(db) {
  db.exec(`ALTER TABLE ship_ai_prefs ADD COLUMN callout_mode TEXT NOT NULL DEFAULT 'on'
    CHECK (callout_mode IN ('on', 'off'));
  ALTER TABLE ship_ai_prefs ADD COLUMN dscan_mode TEXT NOT NULL DEFAULT 'on'
    CHECK (dscan_mode IN ('on', 'off'));`);
}

function upShipAiTriggers(db) {
  db.exec(`CREATE TABLE ship_ai_events_v92 (
    player_character_id INTEGER NOT NULL CHECK (player_character_id > 0),
    event_key           TEXT    NOT NULL CHECK (length(event_key) >= 1),
    kind                TEXT    NOT NULL CHECK (kind IN ('LOSS_SHIP', 'LOSS_POD', 'SYSTEM_DANGER', 'REGION_ENTER',
                          'DOCK', 'UNDOCK', 'SHIP_CHANGE', 'LOW_HP', 'HOSTILES', 'SKILL_DONE', 'JOB_READY',
                          'ORDER_FILLED', 'MISSION_EXPIRING', 'CRIMINAL', 'SUSPECT', 'CRIME_CLEAR', 'CAP_LOW',
                          'SEC_STATUS_DROP', 'DOCK_DAMAGED', 'MINING_CARGO_FULL', 'MINING_CRYSTAL', 'SITE_CLEARED',
                          'NAVY_KILL', 'NOTABLE_KILL', 'BOUNTY_PAID', 'ISK_IN', 'SKILL_QUEUE_EMPTY',
                          'MISSION_OBJECTIVE', 'WELCOME_BACK', 'WORLD_NEWS', 'BATTLE_HERE', 'EVENT_HERE')),
    payload             TEXT    NOT NULL,
    occurred_at         INTEGER NOT NULL CHECK (occurred_at >= 0),
    mentioned_at        INTEGER NULL,
    PRIMARY KEY (player_character_id, event_key)
  );
  INSERT INTO ship_ai_events_v92 (player_character_id, event_key, kind, payload, occurred_at, mentioned_at)
    SELECT player_character_id, event_key, kind, payload, occurred_at, mentioned_at FROM ship_ai_events;
  DROP TABLE ship_ai_events;
  ALTER TABLE ship_ai_events_v92 RENAME TO ship_ai_events;
  CREATE INDEX ship_ai_events_recent ON ship_ai_events (player_character_id, occurred_at);
  ALTER TABLE ship_ai_prefs ADD COLUMN muted_kinds TEXT NULL
    CHECK (muted_kinds IS NULL OR (json_valid(muted_kinds) AND length(muted_kinds) <= 1024));
  ALTER TABLE ship_ai_prefs ADD COLUMN last_seen_at INTEGER NULL
    CHECK (last_seen_at IS NULL OR last_seen_at >= 0);`);
}

function upShipAiPrefsVoice(db) {
  db.exec(`ALTER TABLE ship_ai_prefs ADD COLUMN voice_prefs TEXT NULL
    CHECK (voice_prefs IS NULL OR (json_valid(voice_prefs) AND length(voice_prefs) <= 512));`);
}

const AUTOSTART_STEPS = Object.freeze(["room", "voice"]);
const AUTOSTART_INTEGER_RANGES = Object.freeze({ autostartPollMs: [1000, 60000],
  autostartLoginDelayMs: [0, 600000], autostartMaxWaitMs: [10000, 1800000] });
const AUTOSTART_PREFS_MAX_CHARS = 64;

function shipAiAutostartSettingsOf(config) {
  const c = config && config.shipAi;
  const bad = (detail) => ({ ok: false, reason: "INVALID_SETTINGS", detail });
  if (!c || typeof c !== "object") return bad("shipAi section");
  if (typeof c.autostartEnabled !== "boolean") return bad("autostartEnabled");
  const out = { autostartEnabled: c.autostartEnabled };
  for (const [key, [min, max]] of Object.entries(AUTOSTART_INTEGER_RANGES)) {
    const v = c[key];
    if (!Number.isSafeInteger(v) || v < min || v > max) return bad(key);
    out[key] = v;
  }
  if (out.autostartMaxWaitMs < out.autostartLoginDelayMs) return bad("autostartMaxWaitMs");
  return { ok: true, settings: Object.freeze(out) };
}

function upShipAiPrefsAutostart(db) {
  db.exec(`ALTER TABLE ship_ai_prefs ADD COLUMN autostart_prefs TEXT NULL
    CHECK (autostart_prefs IS NULL OR (json_valid(autostart_prefs) AND length(autostart_prefs) <= 64));`);
}

module.exports = { TABLE_NAME, IDENTITY_KEY_PREFIX, COMMAND_NAME, COMMAND_RE, CHANNELS, TRANSPORT_PRIVATE, STATE,
  METRICS, COUNTER_NAMES, AI_TYPE_ID, AI_GENDER, MAX_NAME_CHARS, MAX_BIO_CHARS, identityKeyOf, parseAllowlist,
  isAllowed, shipAiSettingsOf, upShipAiPrefs, TURNS_TABLE, METRIC, LANES, STATIC_KINDS, REPLY_REJECT_REASONS,
  LANGUAGE_CODES, PROFANITY_LEVELS, shipAiModelSettingsOf, apiKeyOf, sharedKeyRpmCheck, upShipAiTurns, TOOL_MODES,
  SUMMARIES_TABLE, FACTS_TABLE, FACT_CATEGORIES, FACT_SOURCES, FACT_REJECT_REASONS, upShipAiMemory, EVENTS_TABLE,
  EVENT_KINDS, CAPSULE_TYPE_IDS, EVENT_PAYLOAD_MAX_CHARS, upShipAiEvents, PORTRAIT_DIR, PORTRAIT_STATUS,
  MAIL_MODES, upShipAiPrefsMail, VOICE_ENGINES, VOICE_INTEGER_RANGES, VOICE_NAME_MAX_CHARS, shipAiVoiceSettingsOf,
  REASONING_EFFORTS, backgroundRpmClamped, WATCH_KINDS, upShipAiEventsWatchKinds, PERSONA_PRESETS, DEFAULT_PERSONAS,
  upShipAiPrefsPersona, ALERT_MODES, upShipAiPrefsAlerts, WING_HP_SOURCES, WING_HP_DEFAULT_MARKS, MUTE_KINDS,
  CAP_LOW_DEFAULT_PAIR, MUTED_KINDS_MAX_CHARS, upShipAiTriggers, WELCOME_DEFAULT_PAIR, upShipAiPrefsVoice,
  AUTOSTART_STEPS, AUTOSTART_INTEGER_RANGES, AUTOSTART_PREFS_MAX_CHARS, shipAiAutostartSettingsOf,
  upShipAiPrefsAutostart, RAM_TRIGGER_KINDS };
