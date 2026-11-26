"use strict";

const TABLE = "world_seasons";
const SCORES_TABLE = "world_season_scores";
const REWARDS_TABLE = "world_season_rewards";

const STATE = Object.freeze({ PLANNED: "PLANNED", ACTIVE: "ACTIVE", FINALE: "FINALE", ARCHIVED: "ARCHIVED",
  RESET_PENDING: "RESET_PENDING", RESET_DONE: "RESET_DONE", INTERRUPTED: "INTERRUPTED" });
const OPEN_STATES = Object.freeze([STATE.PLANNED, STATE.ACTIVE, STATE.FINALE, STATE.RESET_PENDING, STATE.RESET_DONE,
  STATE.INTERRUPTED]);
const DEFERRED_STATES = Object.freeze([STATE.RESET_PENDING, STATE.RESET_DONE, STATE.INTERRUPTED]);
const OUTCOME = Object.freeze({ WON: "WON", LOST: "LOST", DRAW: "DRAW" });
const CLOSE_REASON = Object.freeze({ FINISHED: "FINISHED" });

const EVENT_STEP = "SEASON_STEP";
const EVENT_SCORE = "SEASON_SCORE";
const SCORE_AGGREGATE_ID = "seasons";

const AGGREGATE = "season";
const JOURNAL = Object.freeze({ STARTED: "SEASON_STARTED", STAGE: "SEASON_STAGE", FINALE: "SEASON_FINALE",
  ENDED: "SEASON_ENDED" });
const RNG_STREAM = "season";

const MAX_CRISIS_JSON = 1024;
const MAX_PARAMS_JSON = 512;
const RESET_MODES = Object.freeze(["none", "offline"]);

const INT_RULES = Object.freeze([
  ["durationMs", 3600000, 10368000000], ["stageCount", 2, 6], ["firstStartDelayMs", 0, 604800000],
  ["breakMs", 0, 2592000000], ["planRetryMs", 60000, 86400000], ["scoreIntervalMs", 10000, 3600000],
  ["journalBatch", 16, 2048], ["journalPagesPerPass", 1, 32], ["maxCrisisRegions", 1, 10],
  ["invasionSpawnPoints", 0, 10000], ["invasionRepelPoints", 0, 10000], ["battlePoints", 0, 10000],
  ["winRatioPermille", 100, 10000], ["stepRecoveryMax", 0, 16],
  ["killPoints", 0, 1000], ["heavyDefensePoints", 0, 1000], ["maxPendingKeys", 64, 16384], ["flushMaxRows", 8, 512],
  ["payoutBatch", 8, 512], ["maxScoreRowsPerSeason", 100, 100000], ["maxRankedPlayers", 1, 500],
  ["minPointsForReward", 0, 1000000], ["tier1MaxRank", 1, 500], ["tier2MaxRank", 1, 500], ["tier3MaxRank", 1, 500],
  ["tier1Isk", 0, 10000000000], ["tier2Isk", 0, 10000000000], ["tier3Isk", 0, 10000000000],
  ["tier4Isk", 0, 10000000000], ["tier1ItemTypeId", 0, 100000000], ["tier2ItemTypeId", 0, 100000000],
  ["tier3ItemTypeId", 0, 100000000], ["tier4ItemTypeId", 0, 100000000], ["tier1ItemQty", 1, 1000],
  ["tier2ItemQty", 1, 1000], ["tier3ItemQty", 1, 1000], ["tier4ItemQty", 1, 1000], ["wonBonusPermille", 1000, 5000],
  ["maxIskPerSeason", 0, 100000000000], ["rewardFallbackStationId", 0, 2147483647], ["payoutPassMs", 1000, 600000],
  ["payoutMaxPerPass", 1, 64], ["payoutMaxAttempts", 1, 100], ["payoutRetryBaseMs", 1000, 3600000],
  ["payoutRetryMaxMs", 1000, 86400000], ["pruneEveryMs", 60000, 86400000], ["prunePerRun", 1, 5000],
  ["scoreRetentionMs", 0, 62208000000],
  ["invasionBiasPermille", 1000, 5000],
]);
const BOOL_KEYS = Object.freeze(["payOnInterrupt", "mailEnabled", "commandEnabled", "viewEnabled", "hintEnabled",
  "invasionBiasEnabled"]);
const VIEW_ID = "seasons";
const LAYER_ID = "layer-season";
const VIEW_ORDER = 72;
const LAYER_ORDER = 24;

const TIER = Object.freeze({ CHAMPION: "CHAMPION", HERO: "HERO", VETERAN: "VETERAN", PARTICIPANT: "PARTICIPANT" });
const TIERS = Object.freeze([TIER.CHAMPION, TIER.HERO, TIER.VETERAN, TIER.PARTICIPANT]);
const LEG = Object.freeze({ PENDING: "PENDING", SENDING: "SENDING", DONE: "DONE", FAILED: "FAILED",
  SKIPPED: "SKIPPED" });
const REWARD_STATE = Object.freeze({ PENDING: "PENDING", DONE: "DONE", FAILED: "FAILED" });
const REWARD_ISK_SOURCE = "lne-seasons";
const rewardDescriptionOf = (no) => `LNE Season ${no} reward`;

const keyOfStart = (no) => `season:${no}:start`;
const keyOfStage = (no, stage) => `season:${no}:stage:${stage}`;
const keyOfFinale = (no) => `season:${no}:finale`;
const keyOfEnd = (no) => `season:${no}:end`;
const keyOfStep = (no, state, stage, retries) => `season:${no}:step:${state}:${stage}`
  + (state === STATE.PLANNED && retries > 0 ? `:r${retries}` : "");
const keyOfStepRecovery = (stepKey, n) => `${stepKey}:q${n}`;
const keyOfScore = (bucket) => `season:score:${bucket}`;
const keyOfReward = (no, characterId) => `season:${no}:${characterId}`;
const keyOfRewardLeg = (no, characterId, leg) => `lne:season:${no}:${characterId}:${leg}`;
const seasonKeyOf = (no) => `s${no}`;

function seasonsSettingsOf(config) {
  const S = config && config.seasons;
  if (!S || typeof S !== "object") return { ok: false, reason: "INVALID_SETTINGS", detail: "seasons" };
  const out = { enabled: S.enabled === true };
  for (const [key, min, max] of INT_RULES) {
    const v = S[key];
    if (!Number.isSafeInteger(v) || v < min || v > max) {
      return { ok: false, reason: "INVALID_SETTINGS", detail: `seasons.${key}` };
    }
    out[key] = v;
  }
  if (!RESET_MODES.includes(S.resetMode)) return { ok: false, reason: "INVALID_SETTINGS", detail: "seasons.resetMode" };
  out.resetMode = S.resetMode;
  for (const key of BOOL_KEYS) out[key] = S[key] === true;
  if (!(out.tier1MaxRank <= out.tier2MaxRank && out.tier2MaxRank <= out.tier3MaxRank
    && out.tier3MaxRank <= out.maxRankedPlayers)) {
    return { ok: false, reason: "INVALID_SETTINGS", detail: "seasons.tier1MaxRank..tier3MaxRank" };
  }
  if (out.payoutRetryBaseMs > out.payoutRetryMaxMs) {
    return { ok: false, reason: "INVALID_SETTINGS", detail: "seasons.payoutRetryBaseMs" };
  }
  return { ok: true, settings: Object.freeze(out) };
}

function upSeasons(db) {
  db.exec(`CREATE TABLE world_seasons (
    season_no         INTEGER PRIMARY KEY CHECK (season_no >= 1),
    state             TEXT    NOT NULL CHECK (length(state) BETWEEN 1 AND 16),
    open              INTEGER NOT NULL CHECK (open IN (0, 1)),
    crisis_kind       TEXT    NOT NULL CHECK (length(crisis_kind) BETWEEN 3 AND 24),
    crisis_owner      TEXT    NOT NULL CHECK (length(crisis_owner) BETWEEN 1 AND 32),
    crisis_version    INTEGER NOT NULL CHECK (crisis_version >= 1),
    crisis_json       TEXT    NOT NULL CHECK (json_valid(crisis_json) AND length(crisis_json) <= 1024),
    seed              INTEGER NOT NULL CHECK (seed BETWEEN 0 AND 4294967295),
    starts_at         INTEGER NOT NULL CHECK (starts_at >= 0),
    ends_at           INTEGER NOT NULL CHECK (ends_at > starts_at),
    stage             INTEGER NOT NULL CHECK (stage >= 0),
    stage_count       INTEGER NOT NULL CHECK (stage_count BETWEEN 2 AND 6),
    stage_due_at      INTEGER NOT NULL CHECK (stage_due_at >= 0),
    meter_defense     INTEGER NOT NULL DEFAULT 0 CHECK (meter_defense >= 0),
    meter_crisis      INTEGER NOT NULL DEFAULT 0 CHECK (meter_crisis >= 0),
    outcome           TEXT    CHECK (outcome IS NULL OR length(outcome) BETWEEN 1 AND 8),
    close_reason      TEXT    CHECK (close_reason IS NULL OR length(close_reason) BETWEEN 1 AND 16),
    closed_at         INTEGER CHECK (closed_at IS NULL OR closed_at >= 0),
    reset_at          INTEGER CHECK (reset_at IS NULL OR reset_at >= 0),
    journal_cursor    INTEGER NOT NULL DEFAULT 0 CHECK (journal_cursor >= 0),
    payout_cursor_at  INTEGER NOT NULL DEFAULT 0 CHECK (payout_cursor_at >= 0),
    payout_cursor_key TEXT    NOT NULL DEFAULT '' CHECK (length(payout_cursor_key) <= 128),
    planned_retries   INTEGER NOT NULL DEFAULT 0 CHECK (planned_retries >= 0),
    created_at        INTEGER NOT NULL CHECK (created_at >= 0),
    updated_at        INTEGER NOT NULL CHECK (updated_at >= 0),
    version           INTEGER NOT NULL CHECK (version >= 1)
  ) STRICT;
  CREATE UNIQUE INDEX world_seasons_one_open ON world_seasons (open) WHERE open = 1;
  CREATE TABLE world_season_scores (
    season_no    INTEGER NOT NULL CHECK (season_no >= 1),
    character_id INTEGER NOT NULL CHECK (character_id > 0),
    points       INTEGER NOT NULL CHECK (points >= 0),
    kills        INTEGER NOT NULL CHECK (kills >= 0),
    defenses     INTEGER NOT NULL CHECK (defenses >= 0),
    last_at      INTEGER NOT NULL CHECK (last_at >= 0),
    version      INTEGER NOT NULL CHECK (version >= 1),
    PRIMARY KEY (season_no, character_id)
  ) STRICT, WITHOUT ROWID;
  CREATE INDEX world_season_scores_rank ON world_season_scores (season_no, points DESC, last_at, character_id);
  CREATE TABLE world_season_rewards (
    reward_key      TEXT    PRIMARY KEY NOT NULL CHECK (length(reward_key) BETWEEN 1 AND 64),
    season_no       INTEGER NOT NULL CHECK (season_no >= 1),
    character_id    INTEGER NOT NULL CHECK (character_id > 0),
    rank            INTEGER NOT NULL CHECK (rank >= 1),
    points          INTEGER NOT NULL CHECK (points >= 0),
    tier            TEXT    NOT NULL CHECK (tier IN ('CHAMPION', 'HERO', 'VETERAN', 'PARTICIPANT')),
    outcome         TEXT    NOT NULL CHECK (outcome IN ('WON', 'LOST', 'DRAW')),
    isk_amount      INTEGER NOT NULL CHECK (isk_amount >= 0),
    item_type_id    INTEGER NOT NULL CHECK (item_type_id >= 0),
    item_qty        INTEGER NOT NULL CHECK (item_qty >= 0),
    station_id      INTEGER,
    isk_state       TEXT    NOT NULL CHECK (length(isk_state) BETWEEN 1 AND 16),
    item_state      TEXT    NOT NULL CHECK (length(item_state) BETWEEN 1 AND 16),
    mail_state      TEXT    NOT NULL CHECK (length(mail_state) BETWEEN 1 AND 16),
    state           TEXT    NOT NULL CHECK (length(state) BETWEEN 1 AND 16),
    attempts        INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    next_attempt_at INTEGER NOT NULL CHECK (next_attempt_at >= 0),
    last_error      TEXT    CHECK (last_error IS NULL OR length(last_error) <= 160),
    mail_sender_id  INTEGER CHECK (mail_sender_id IS NULL OR mail_sender_id > 0),
    mail_sent_date  TEXT    CHECK (mail_sent_date IS NULL OR length(mail_sent_date) <= 32),
    mail_message_id INTEGER,
    planned_at      INTEGER NOT NULL CHECK (planned_at >= 0),
    updated_at      INTEGER NOT NULL CHECK (updated_at >= 0),
    version         INTEGER NOT NULL CHECK (version >= 1)
  ) STRICT;
  CREATE INDEX world_season_rewards_due ON world_season_rewards (next_attempt_at) WHERE state = 'PENDING';
  CREATE INDEX world_season_rewards_char ON world_season_rewards (character_id, season_no);
  CREATE INDEX world_heavy_event_payouts_planned ON world_heavy_event_payouts (planned_at, payout_key);`);
}

module.exports = { TABLE, SCORES_TABLE, REWARDS_TABLE, STATE, OPEN_STATES, DEFERRED_STATES, OUTCOME, CLOSE_REASON,
  EVENT_STEP, EVENT_SCORE, SCORE_AGGREGATE_ID, AGGREGATE, JOURNAL, RNG_STREAM, MAX_CRISIS_JSON, MAX_PARAMS_JSON,
  RESET_MODES, INT_RULES, keyOfStart, keyOfStage, keyOfFinale, keyOfEnd, keyOfStep, keyOfStepRecovery, keyOfScore, seasonKeyOf,
  seasonsSettingsOf, upSeasons, BOOL_KEYS, TIER, TIERS, LEG, REWARD_STATE, REWARD_ISK_SOURCE, rewardDescriptionOf,
  keyOfReward, keyOfRewardLeg, VIEW_ID, LAYER_ID, VIEW_ORDER, LAYER_ORDER };
