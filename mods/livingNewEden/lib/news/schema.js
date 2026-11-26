"use strict";

const STATE_TABLE = "lne_news_state";
const FACTS_TABLE = "lne_news_facts";
const EDITIONS_TABLE = "lne_news_editions";
const READERS_TABLE = "lne_news_readers";
const DELIVERIES_TABLE = "lne_news_deliveries";
const DELIVERY_STATE = Object.freeze({ PENDING: "PENDING", SENDING: "SENDING", SENT: "SENT", FAILED: "FAILED",
  LOST: "LOST", EXPIRED: "EXPIRED" });
const OPEN_SQL = "edition_id IS NULL";

const KIND = Object.freeze({
  SYSTEM_CAPTURED: "SYSTEM_CAPTURED",
  ATTACK_REPELLED: "ATTACK_REPELLED",
  SYSTEM_RELEASED: "SYSTEM_RELEASED",
  ATTACK_STARTED: "ATTACK_STARTED",
  SIEGE_STARTED: "SIEGE_STARTED",
  SIEGE_ENDED: "SIEGE_ENDED",
  STRUCTURE_SIEGE_STARTED: "STRUCTURE_SIEGE_STARTED",
  STRUCTURE_SIEGE_ENDED: "STRUCTURE_SIEGE_ENDED",
  PLAYER_SOV_SIEGE: "PLAYER_SOV_SIEGE",
  PLAYER_SOV_REINFORCED: "PLAYER_SOV_REINFORCED",
  PLAYER_SOV_LOST: "PLAYER_SOV_LOST",
  HEAVY_EVENT_STARTED: "HEAVY_EVENT_STARTED",
  BATTLE: "BATTLE",
  CAPITAL_STARTED: "CAPITAL_STARTED",
  CAPITAL_DELIVERED: "CAPITAL_DELIVERED",
  TREASURY_CRISIS: "TREASURY_CRISIS",
  TREASURY_RECOVERED: "TREASURY_RECOVERED",
  INVASION_STARTED: "INVASION_STARTED",
  INVASION_ENDED: "INVASION_ENDED",
  TRUCE_AGREED: "TRUCE_AGREED",
  STATION_RETURNED: "STATION_RETURNED",
  BOUNTY_CLAIMED: "BOUNTY_CLAIMED",
  SITUATION_RESOLVED: "SITUATION_RESOLVED",
  FAME_LEGEND: "FAME_LEGEND",
  FAME_PUBLIC_ENEMY: "FAME_PUBLIC_ENEMY",
  FAME_BOUNTY: "FAME_BOUNTY",
  SEASON_STARTED: "SEASON_STARTED",
  SEASON_STAGE: "SEASON_STAGE",
  SEASON_FINALE: "SEASON_FINALE",
  SEASON_ENDED: "SEASON_ENDED",
  GM_THREAD_STARTED: "GM_THREAD_STARTED",
  GM_THREAD_ENDED: "GM_THREAD_ENDED",
  WORLD_BOSS_EMERGED: "WORLD_BOSS_EMERGED",
  WORLD_BOSS_DEFEATED: "WORLD_BOSS_DEFEATED",
  WORLD_BOSS_SLAIN: "WORLD_BOSS_SLAIN",
  WORLD_BOSS_WITHDREW: "WORLD_BOSS_WITHDREW",
  NATIVE_INCURSION_DEFEATED: "NATIVE_INCURSION_DEFEATED",
  NATIVE_INCURSION_HELD: "NATIVE_INCURSION_HELD",
  FACTION_INCURSION_DEFEATED: "FACTION_INCURSION_DEFEATED",
  FACTION_INCURSION_HELD: "FACTION_INCURSION_HELD",
});
const SEASON_KINDS = Object.freeze([KIND.SEASON_STARTED, KIND.SEASON_STAGE, KIND.SEASON_FINALE, KIND.SEASON_ENDED]);
const GM_KINDS = Object.freeze([KIND.GM_THREAD_STARTED, KIND.GM_THREAD_ENDED]);
const FAME_TIER_KINDS = Object.freeze([KIND.FAME_LEGEND, KIND.FAME_PUBLIC_ENEMY]);
const WORLD_BOSS_KINDS = Object.freeze([KIND.WORLD_BOSS_EMERGED, KIND.WORLD_BOSS_DEFEATED, KIND.WORLD_BOSS_SLAIN,
  KIND.WORLD_BOSS_WITHDREW]);
const NATIVE_INCURSION_KINDS = Object.freeze([KIND.NATIVE_INCURSION_DEFEATED, KIND.NATIVE_INCURSION_HELD]);
const FACTION_INCURSION_KINDS = Object.freeze([KIND.FACTION_INCURSION_DEFEATED, KIND.FACTION_INCURSION_HELD]);
const KINDS = Object.freeze(Object.values(KIND));
const WAR_KINDS = Object.freeze([KIND.SYSTEM_CAPTURED, KIND.ATTACK_REPELLED, KIND.SYSTEM_RELEASED,
  KIND.ATTACK_STARTED, KIND.SIEGE_STARTED, KIND.SIEGE_ENDED, KIND.STRUCTURE_SIEGE_STARTED,
  KIND.STRUCTURE_SIEGE_ENDED, KIND.PLAYER_SOV_SIEGE, KIND.PLAYER_SOV_REINFORCED, KIND.PLAYER_SOV_LOST,
  KIND.HEAVY_EVENT_STARTED]);
const EDITION_STATE = Object.freeze({ DRAFTING: "DRAFTING", READY: "READY", PUBLISHED: "PUBLISHED",
  SKIPPED: "SKIPPED" });
const SOURCE = Object.freeze({ FALLBACK: "FALLBACK", AI: "AI" });
const COUNTER_NAMES = Object.freeze(["tailRows", "tailSkippedLag", "warFacts", "warFactsTruncated", "factsInserted",
  "factsMerged", "factsLate", "refMissing", "editionsOpened", "editionsSkipped", "editionsPublished", "fallbacks",
  "deferrals", "errors",
  "aiRequests", "aiAccepted", "aiRejected",
  "readersTouched", "deliveriesQueued", "mailsSent", "mailsFailed", "mailsLost", "mailsExpired", "recipientsTruncated",
  "chatReplies", "chatErrors", "optOuts"]);
const OBSERVE_NAMES = Object.freeze(["passMs", "tailMs"]);
const NEWS_METHODS = Object.freeze(["getStatus", "stop", "runPassNow", "listEditions", "latestHeadline",
  "listRecentFacts"]);
const LANGUAGES = Object.freeze(["en", "pl"]);
const CAPITAL_CLASSES = Object.freeze(["titan", "supercarrier", "dreadnought", "carrier", "force_auxiliary"]);
const MAX_FACT_KEY = 120;
const MAX_DATA_BYTES = 1024;
const MAX_NAME_CHARS = 100;
const DATA_VERSION = 1;
const MS_PER_HOUR = 3600000;
const DEFAULT_AI_PROMPT_CHARS = 8000;

const INT_RULES = Object.freeze([
  ["passIntervalMs", 10000, 3600000], ["cycleHours", 1, 168], ["publishHourUtc", 0, 23],
  ["settleDelayMs", 0, 3600000], ["maxFactsPerEdition", 1, 30], ["minFactsPerEdition", 1, 30],
  ["maxPerKind", 1, 30], ["maxPerSystem", 1, 30], ["battleMinDestroyed", 1, 100000],
  ["maxCandidatesPerEdition", 10, 5000], ["maxFactAgeMs", 3600000, 2592000000], ["maxWarFactsPerCall", 1, 500],
  ["tailScanWindow", 100, 1000000], ["tailMaxRowsPerPass", 1, 5000], ["tailMaxLagRows", 1000, 100000000],
  ["keepEditions", 1, 365], ["factRetentionMs", 3600000, 31536000000], ["pruneBatch", 1, 5000],
  ["observerEditions", 1, 30], ["maxTitleChars", 20, 150],
  ["aiMaxAttempts", 1, 5], ["draftDeadlineMs", 60000, 21600000], ["minBodyChars", 50, 6000],
  ["maxBodyChars", 200, 6000], ["minParagraphs", 1, 20], ["maxParagraphs", 1, 20], ["minCoveredFacts", 0, 30],
]);
const MAIL_INT_RULES = Object.freeze([
  ["readerActiveMs", 3600000, 2592000000], ["readerTouchMs", 60000, 86400000], ["maxRecipientsPerEdition", 1, 500],
  ["maxMailsPerPass", 1, 50], ["maxDeliveryAgeMs", 3600000, 2592000000], ["senderId", 0, 2147483647],
]);

function csvOf(text) {
  return String(text === undefined || text === null ? "" : text).split(",").map((t) => t.trim())
    .filter((t) => t !== "");
}

function isKindList(text) {
  return csvOf(text).every((t) => KINDS.includes(t));
}

function isCapitalClassList(text) {
  return csvOf(text).every((t) => CAPITAL_CLASSES.includes(t));
}

function bad(detail) {
  return { ok: false, reason: "NEWS_INVALID_SETTINGS", detail };
}

function newsSettingsOf(config) {
  const n = config && config.news;
  if (!n || typeof n !== "object") return bad("news: missing section");
  if (typeof n.enabled !== "boolean") return bad("news.enabled: boolean");
  const out = { enabled: n.enabled };
  for (const [key, min, max] of INT_RULES) {
    const v = n[key];
    if (!Number.isSafeInteger(v) || v < min || v > max) return bad(`news.${key}: integer ${min}..${max}`);
    out[key] = v;
  }
  if (out.minFactsPerEdition > out.maxFactsPerEdition) return bad("news.minFactsPerEdition: <= maxFactsPerEdition");
  if (typeof n.aiEnabled !== "boolean") return bad("news.aiEnabled: boolean");
  out.aiEnabled = n.aiEnabled;
  out.minBodyChars = Math.min(out.minBodyChars, out.maxBodyChars);
  out.minParagraphs = Math.min(out.minParagraphs, out.maxParagraphs);
  const cm = config.chatterAi && config.chatterAi.newsMaxPromptChars;
  out.aiMaxPromptChars = Number.isSafeInteger(cm) && cm > 0 ? cm : DEFAULT_AI_PROMPT_CHARS;
  const m = n.mail;
  if (!m || typeof m !== "object") return bad("news.mail: missing section");
  if (typeof m.enabled !== "boolean") return bad("news.mail.enabled: boolean");
  const mail = { enabled: m.enabled };
  for (const [key, min, max] of MAIL_INT_RULES) {
    const v = m[key];
    if (!Number.isSafeInteger(v) || v < min || v > max) return bad(`news.mail.${key}: integer ${min}..${max}`);
    mail[key] = v;
  }
  out.mail = Object.freeze(mail);
  if (!n.command || typeof n.command.enabled !== "boolean") return bad("news.command.enabled: boolean");
  out.commandEnabled = n.command.enabled;
  const language = typeof n.language === "string" ? n.language.trim() : null;
  if (language === null || (language !== "" && !LANGUAGES.includes(language))) {
    return bad("news.language: empty, en or pl");
  }
  const chatter = config.chatterAi && typeof config.chatterAi.language === "string" ? config.chatterAi.language : "";
  out.language = language !== "" ? language : (LANGUAGES.includes(chatter) ? chatter : "en");
  if (typeof n.kinds !== "string" || !isKindList(n.kinds)) return bad("news.kinds: empty or a CSV of the news kinds");
  const kinds = csvOf(n.kinds);
  const truceOn = Boolean(config.strategy && config.strategy.truceEnabled === true);
  const stationReturnOn = Boolean(config.world && config.world.npcSovBastionStationReturnEnabled === true);
  const bh = config.bountyHunters;
  const bountyOn = Boolean(bh && bh.enabled === true && bh.liveEnabled === true);
  const sit = config.situations;
  const sitOn = Boolean(sit && sit.enabled === true && sit.newsEnabled === true);
  const seasonsOn = Boolean(config.seasons && config.seasons.enabled === true);
  const gmOn = Boolean(config.gameMaster && config.gameMaster.enabled === true);
  const wb = config.worldBosses;
  const worldBossesOn = Boolean(wb && wb.enabled === true && wb.newsEnabled === true);
  const ni = config.nativeIncursions;
  const nativeIncursionsOn = Boolean(ni && ni.enabled === true && ni.settle && ni.settle.enabled === true
    && ni.newsEnabled === true);
  const fi = config.factionIncursions;
  const fc = fi && fi.consequences;
  const factionIncursionsOn = Boolean(fi && fi.enabled === true && fi.settle && fi.settle.enabled === true
    && fc && fc.enabled === true && fc.newsEnabled === true);
  const fm = config.fame;
  const fameOn = Boolean(fm && fm.enabled === true && fm.newsEnabled === true);
  const fameBountyOn = fameOn && fm.bountyEnabled === true;
  out.kinds = Object.freeze((kinds.length === 0 ? [...KINDS] : [...new Set(kinds)])
    .filter((k) => gmOn || !GM_KINDS.includes(k))
    .filter((k) => fameOn || !FAME_TIER_KINDS.includes(k))
    .filter((k) => fameBountyOn || k !== KIND.FAME_BOUNTY)
    .filter((k) => truceOn || k !== KIND.TRUCE_AGREED)
    .filter((k) => stationReturnOn || k !== KIND.STATION_RETURNED)
    .filter((k) => bountyOn || k !== KIND.BOUNTY_CLAIMED)
    .filter((k) => sitOn || k !== KIND.SITUATION_RESOLVED)
    .filter((k) => seasonsOn || !SEASON_KINDS.includes(k))
    .filter((k) => worldBossesOn || !WORLD_BOSS_KINDS.includes(k))
    .filter((k) => nativeIncursionsOn || !NATIVE_INCURSION_KINDS.includes(k))
    .filter((k) => factionIncursionsOn || !FACTION_INCURSION_KINDS.includes(k)));
  if (typeof n.capitalClasses !== "string" || !isCapitalClassList(n.capitalClasses)) {
    return bad("news.capitalClasses: a CSV of the capital hull groups");
  }
  out.capitalClasses = Object.freeze([...new Set(csvOf(n.capitalClasses))]);
  out.cycleMs = out.cycleHours * MS_PER_HOUR;
  return { ok: true, settings: Object.freeze(out) };
}

function upNewsTables(db) {
  db.exec(`CREATE TABLE lne_news_state (
    id              INTEGER PRIMARY KEY CHECK (id = 1),
    journal_cursor  INTEGER NOT NULL CHECK (journal_cursor >= 0),
    updated_at      INTEGER NOT NULL
  ) STRICT;
  CREATE TABLE lne_news_facts (
    fact_key    TEXT PRIMARY KEY CHECK (length(fact_key) BETWEEN 1 AND 120),
    kind        TEXT NOT NULL,
    at          INTEGER NOT NULL,
    system_id   INTEGER,
    weight      INTEGER NOT NULL,
    data_json   TEXT NOT NULL CHECK (length(data_json) <= 1024),
    merges      INTEGER NOT NULL DEFAULT 1 CHECK (merges >= 1),
    edition_id  TEXT,
    selected    INTEGER NOT NULL DEFAULT 0 CHECK (selected IN (0, 1)),
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX idx_lne_news_facts_open ON lne_news_facts (at) WHERE edition_id IS NULL;
  CREATE INDEX idx_lne_news_facts_edition ON lne_news_facts (edition_id, selected, weight DESC);
  CREATE TABLE lne_news_editions (
    edition_id      TEXT PRIMARY KEY,
    boundary_at     INTEGER NOT NULL UNIQUE,
    seq             INTEGER NOT NULL CHECK (seq >= 1),
    state           TEXT NOT NULL CHECK (state IN ('DRAFTING', 'READY', 'PUBLISHED', 'SKIPPED')),
    source          TEXT CHECK (source IN ('FALLBACK', 'AI')),
    language        TEXT NOT NULL,
    fallback_title  TEXT NOT NULL,
    fallback_body   TEXT NOT NULL,
    title           TEXT,
    body            TEXT,
    fact_count      INTEGER NOT NULL CHECK (fact_count >= 0),
    ai_attempts     INTEGER NOT NULL DEFAULT 0,
    ai_reason       TEXT,
    tokens          INTEGER NOT NULL DEFAULT 0,
    recipients      INTEGER NOT NULL DEFAULT 0,
    created_at      INTEGER NOT NULL,
    ready_at        INTEGER,
    published_at    INTEGER,
    version         INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1)
  ) STRICT;
  CREATE INDEX idx_lne_news_editions_state ON lne_news_editions (state, boundary_at);`);
}

function upNewsMail(db) {
  db.exec(`CREATE TABLE lne_news_readers (
    character_id   INTEGER PRIMARY KEY CHECK (character_id > 0),
    first_seen_at  INTEGER NOT NULL,
    last_seen_at   INTEGER NOT NULL,
    opted_out      INTEGER NOT NULL DEFAULT 0 CHECK (opted_out IN (0, 1)),
    updated_at     INTEGER NOT NULL
  ) STRICT;
  CREATE INDEX idx_lne_news_readers_active ON lne_news_readers (opted_out, last_seen_at);
  CREATE TABLE lne_news_deliveries (
    edition_id    TEXT NOT NULL,
    character_id  INTEGER NOT NULL CHECK (character_id > 0),
    state         TEXT NOT NULL CHECK (state IN ('PENDING', 'SENDING', 'SENT', 'FAILED', 'LOST', 'EXPIRED')),
    sender_id     INTEGER,
    sent_date     TEXT,
    title         TEXT,
    message_id    INTEGER,
    error         TEXT,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL,
    PRIMARY KEY (edition_id, character_id)
  ) STRICT;
  CREATE INDEX idx_lne_news_deliveries_state ON lne_news_deliveries (state, created_at);`);
}

module.exports = { STATE_TABLE, FACTS_TABLE, EDITIONS_TABLE, READERS_TABLE, DELIVERIES_TABLE, DELIVERY_STATE, OPEN_SQL,
  KIND, KINDS, WAR_KINDS, EDITION_STATE, SOURCE, COUNTER_NAMES, OBSERVE_NAMES, NEWS_METHODS, LANGUAGES, CAPITAL_CLASSES,
  MAX_FACT_KEY, MAX_DATA_BYTES, MAX_NAME_CHARS, DATA_VERSION, MS_PER_HOUR, csvOf, isKindList, isCapitalClassList,
  newsSettingsOf, upNewsTables, upNewsMail };
