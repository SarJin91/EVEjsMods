"use strict";

const TABLES = Object.freeze({ SYSTEMS: "world_system_dev", CURSORS: "world_dev_cursors",
  INVESTMENTS: "world_dev_investments" });
const SOURCES = Object.freeze(["kb_battles", "kb_kills", "mining", "production", "convoys", "trade"]);
const KB_SOURCES = Object.freeze({ BATTLES: "kb_battles", KILLS: "kb_kills" });
const ECONOMY_SOURCES = Object.freeze(["mining", "production", "convoys", "trade"]);
const INVEST_DAY_MS = 86400000;
const INVEST_ID_PREFIX = "di";
const INVEST_COMMAND_PREFIX = "lne:dev:";
const INVEST_KEY_PREFIX = "dev:inv:";
const INVEST_DESCRIPTION = "LNE development investment";
const MAX_INVEST_ISK = 1000000000000;
const KINDS = Object.freeze(["mil", "ind", "trade"]);
const INVEST_STATES = Object.freeze({ PENDING: "PENDING", APPLIED: "APPLIED", REFUSED: "REFUSED" });
const CONTESTED_STATES = Object.freeze(["CONTESTED", "INVASION", "OCCUPIED", "CONSOLIDATING"]);
const METHODS = Object.freeze(["getMode", "getStatus", "levelsOf", "listTop", "effectsOf", "stop"]);
const NO_EFFECTS = Object.freeze({ garrisonPoints: 0, wtsDiscountPermille: 0, sites: false });
const GM_HINT_KEY = "devIndices";
const GM_HINT_MAX_LINES = 3;
const GM_HINT_MAX_CHARS = 160;
const GM_HINT_BUFFER = 8;
const MODES = Object.freeze({ OFF: "off", WARMING: "warming", ON: "on", STOPPED: "stopped" });

const VIEW_ID = "dev-indices";
const VIEW_ORDER = 74;
const LAYER_ID = "layer-dev";
const LAYER_ORDER = 7;

const MAX_LEVEL = 5;
const CLIENT_MAX_LEVEL_WIDTHS = MAX_LEVEL + 1;
const MAX_POINTS_CAP = 1000000;
const MAX_ISK_TOTAL = 1000000000000000;
const NEUTRAL_DECAY_PERMILLE = 1000;
const SEC_CLASS_CHOICES = Object.freeze(["highsec", "lowsec", "nullsec", "wormhole", "other"]);

function parseSecClasses(value) {
  if (typeof value !== "string") return null;
  const parts = value.split(",").map((p) => p.trim()).filter((p) => p !== "");
  if (parts.length === 0 || parts.some((p) => !SEC_CLASS_CHOICES.includes(p)) || new Set(parts).size !== parts.length) {
    return null;
  }
  return Object.freeze(parts);
}

function devIndicesSettingsOf(config) {
  const D = config && config.devIndices;
  if (!D || typeof D !== "object") return { ok: false, reason: "INVALID_SETTINGS", detail: "devIndices" };
  const secClasses = parseSecClasses(D.secClassesCsv);
  if (!secClasses) return { ok: false, reason: "INVALID_SETTINGS", detail: "secClassesCsv" };
  const kb = (config && config.killboard) || {};
  const chat = (config && config.frontChat) || {};
  return { ok: true, settings: Object.freeze({
    enabled: D.enabled === true,
    secClasses,
    maxPoints: D.maxPoints,
    levelWidth: D.levelWidth,
    decayPointsPerHour: D.decayPointsPerHour,
    contestedDecayPermille: D.contestedDecayPermille,
    maxDecayGapMs: D.maxDecayGapMs,
    captureLossMilPermille: D.captureLossMilPermille,
    captureLossIndPermille: D.captureLossIndPermille,
    captureLossTradePermille: D.captureLossTradePermille,
    trendWindowMs: D.trendWindowMs,
    sweepIntervalMs: D.sweepIntervalMs,
    sourcePageRows: D.sourcePageRows,
    maxSystemsPerPass: D.maxSystemsPerPass,
    refreshRowsPerPass: D.refreshRowsPerPass,
    refreshMinAgeMs: D.refreshMinAgeMs,
    maxTrackedSystems: D.maxTrackedSystems,
    indexPageRows: D.indexPageRows,
    bootstrapLookbackMs: D.bootstrapLookbackMs,
    battleWinMilPoints: D.battleWinMilPoints,
    battleLossMilPoints: D.battleLossMilPoints,
    battleLossTradePoints: D.battleLossTradePoints,
    battleNearbyTradePoints: D.battleNearbyTradePoints,
    ratKillMilPoints: D.ratKillMilPoints,
    killPointsCapPerHour: D.killPointsCapPerHour,
    commandEnabled: D.commandEnabled === true,
    commandCooldownMs: D.commandCooldownMs,
    observerLayerEnabled: D.observerLayerEnabled === true,
    layerMinLevel: D.layerMinLevel,
    layerMaxItems: D.layerMaxItems,
    panelTopRows: D.panelTopRows,
    sourceLagMs: D.sourceLagMs,
    miningTripIndPoints: D.miningTripIndPoints,
    productionJobIndPoints: D.productionJobIndPoints,
    convoyTradePoints: D.convoyTradePoints,
    tradeDeliveryIskPerPoint: D.tradeDeliveryIskPerPoint,
    tradeDeliveryMaxPoints: D.tradeDeliveryMaxPoints,
    tradeDeliveryIndPoints: D.tradeDeliveryIndPoints,
    investEnabled: D.investEnabled === true,
    investIskPerPoint: D.investIskPerPoint,
    investMinIsk: D.investMinIsk,
    investMaxIskPerCommand: D.investMaxIskPerCommand,
    investMaxIskPerCharacterPerDay: D.investMaxIskPerCharacterPerDay,
    investMaxPointsPerSystemPerDay: D.investMaxPointsPerSystemPerDay,
    investConfirmMs: D.investConfirmMs,
    investRetryMs: D.investRetryMs,
    investRetryMaxMs: D.investRetryMaxMs,
    investPassRows: D.investPassRows,
    investRetentionMs: D.investRetentionMs,
    investPruneBatch: D.investPruneBatch,
    garrisonEnabled: D.garrisonEnabled === true,
    garrisonPointsPerLevel: D.garrisonPointsPerLevel,
    tradeDiscountEnabled: D.tradeDiscountEnabled === true,
    tradeDiscountPermillePerLevel: D.tradeDiscountPermillePerLevel,
    tradeDiscountMaxPermille: D.tradeDiscountMaxPermille,
    gmHintEnabled: D.gmHintEnabled === true,
    anomaliesEnabled: D.anomaliesEnabled === true,
    anomalyMinLevel: D.anomalyMinLevel,
    anomalyMaxOpen: D.anomalyMaxOpen,
    anomalyCandidateRows: D.anomalyCandidateRows,
    anomalyOreWeight: D.anomalyOreWeight,
    anomalyRatsWeight: D.anomalyRatsWeight,
    anomalyOreDurationMs: D.anomalyOreDurationMs,
    anomalyRatsDurationMs: D.anomalyRatsDurationMs,
    anomalyCooldownMs: D.anomalyCooldownMs,
    anomalyAftermathMs: D.anomalyAftermathMs,
    stationsEnabled: D.stationsEnabled === true,
    stationMinLevelSum: D.stationMinLevelSum,
    stationMaxOpenPerFaction: D.stationMaxOpenPerFaction,
    clientIndicesEnabled: D.clientIndicesEnabled === true,
    clientMaxSystems: D.clientMaxSystems,
    killmailsEnabled: kb.enabled === true && kb.killmailsEnabled === true,
    maxReplyChars: Number.isSafeInteger(chat.maxReplyChars) ? chat.maxReplyChars : 1000,
  }) };
}

function rowBoundOf(P) {
  return Math.max(P.maxSystemsPerPass + SOURCES.length + 1, P.refreshRowsPerPass + 1,
    Number.isSafeInteger(P.investPruneBatch) ? P.investPruneBatch : 0);
}

function upDevIndices(db) {
  db.exec(`CREATE TABLE world_system_dev (
    system_id             INTEGER PRIMARY KEY CHECK (system_id > 0),
    mil_points            INTEGER NOT NULL CHECK (mil_points BETWEEN 0 AND 1000000),
    ind_points            INTEGER NOT NULL CHECK (ind_points BETWEEN 0 AND 1000000),
    trade_points          INTEGER NOT NULL CHECK (trade_points BETWEEN 0 AND 1000000),
    mil_trend             INTEGER NOT NULL CHECK (mil_trend IN (-1, 0, 1)),
    ind_trend             INTEGER NOT NULL CHECK (ind_trend IN (-1, 0, 1)),
    trade_trend           INTEGER NOT NULL CHECK (trade_trend IN (-1, 0, 1)),
    controller_faction_id INTEGER CHECK (controller_faction_id IS NULL OR controller_faction_id > 0),
    decay_permille        INTEGER NOT NULL CHECK (decay_permille BETWEEN 1 AND 10000),
    anchor_at             INTEGER NOT NULL CHECK (anchor_at >= 0),
    last_input_at         INTEGER CHECK (last_input_at IS NULL OR last_input_at >= 0),
    kill_window_at        INTEGER NOT NULL CHECK (kill_window_at >= 0),
    kill_window_points    INTEGER NOT NULL CHECK (kill_window_points >= 0),
    invested_isk_total    INTEGER NOT NULL CHECK (invested_isk_total BETWEEN 0 AND 1000000000000000),
    created_at            INTEGER NOT NULL CHECK (created_at >= 0),
    updated_at            INTEGER NOT NULL CHECK (updated_at >= 0),
    version               INTEGER NOT NULL CHECK (version >= 1)
  ) STRICT;
  CREATE INDEX world_system_dev_anchor ON world_system_dev (anchor_at, system_id);
  CREATE TABLE world_dev_cursors (
    source     TEXT    PRIMARY KEY NOT NULL CHECK (source IN ('kb_battles', 'kb_kills', 'mining', 'production',
                 'convoys', 'trade')),
    after_at   INTEGER NOT NULL CHECK (after_at >= 0),
    after_no   INTEGER NOT NULL CHECK (after_no >= 0),
    after_key  TEXT    NOT NULL CHECK (length(after_key) <= 64),
    facts      INTEGER NOT NULL CHECK (facts >= 0),
    updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
    version    INTEGER NOT NULL CHECK (version >= 1)
  ) STRICT;
  CREATE TABLE world_dev_investments (
    invest_id       TEXT    PRIMARY KEY NOT NULL CHECK (length(invest_id) BETWEEN 1 AND 32),
    idempotency_key TEXT    NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 1 AND 80),
    character_id    INTEGER NOT NULL CHECK (character_id > 0),
    system_id       INTEGER NOT NULL CHECK (system_id > 0),
    index_kind      TEXT    NOT NULL CHECK (index_kind IN ('mil', 'ind', 'trade')),
    amount_isk      INTEGER NOT NULL CHECK (amount_isk BETWEEN 1 AND 1000000000000),
    points          INTEGER NOT NULL CHECK (points >= 0),
    state           TEXT    NOT NULL CHECK (state IN ('PENDING', 'APPLIED', 'REFUSED')),
    end_reason      TEXT    CHECK (end_reason IS NULL OR length(end_reason) <= 32),
    attempts        INTEGER NOT NULL CHECK (attempts >= 0),
    next_attempt_at INTEGER CHECK (next_attempt_at IS NULL OR next_attempt_at >= 0),
    created_at      INTEGER NOT NULL CHECK (created_at >= 0),
    updated_at      INTEGER NOT NULL CHECK (updated_at >= 0),
    version         INTEGER NOT NULL CHECK (version >= 1)
  ) STRICT;
  CREATE INDEX world_dev_investments_due ON world_dev_investments (next_attempt_at) WHERE state = 'PENDING';
  CREATE INDEX world_dev_investments_character ON world_dev_investments (character_id, created_at);
  CREATE INDEX world_dev_investments_system ON world_dev_investments (system_id, created_at);
  CREATE INDEX world_dev_investments_state ON world_dev_investments (state, updated_at);`);
}

module.exports = { TABLES, SOURCES, KB_SOURCES, ECONOMY_SOURCES, INVEST_DAY_MS, INVEST_ID_PREFIX, INVEST_COMMAND_PREFIX,
  INVEST_KEY_PREFIX, INVEST_DESCRIPTION, MAX_INVEST_ISK, KINDS, INVEST_STATES, CONTESTED_STATES, METHODS, MODES, VIEW_ID,
  VIEW_ORDER, LAYER_ID, LAYER_ORDER, MAX_LEVEL, CLIENT_MAX_LEVEL_WIDTHS, MAX_POINTS_CAP, MAX_ISK_TOTAL, NEUTRAL_DECAY_PERMILLE,
  SEC_CLASS_CHOICES, NO_EFFECTS, GM_HINT_KEY, GM_HINT_MAX_LINES, GM_HINT_MAX_CHARS, GM_HINT_BUFFER, parseSecClasses,
  devIndicesSettingsOf, rowBoundOf, upDevIndices };
