"use strict";

const { parseRewardCsv } = require("./reward");

const TABLE = "world_arch_chains";
const FRAGMENTS_TABLE = "world_arch_fragments";

const CHAIN_STATE = Object.freeze({ ACTIVE: "ACTIVE", COMPLETED: "COMPLETED", EXPIRED: "EXPIRED", STOLEN: "STOLEN",
  CANCELLED: "CANCELLED" });
const STAGE_STATE = Object.freeze({ REVEALED: "REVEALED", SITE_PENDING: "SITE_PENDING", SITE_ACTIVE: "SITE_ACTIVE",
  FOUND: "FOUND" });
const STAGE_KIND = Object.freeze({ NULL: "NULL", HOSTILE_NULL: "HOSTILE_NULL", WH: "WH" });
const THEME = Object.freeze({ JOVE: "JOVE", DRIFTER: "DRIFTER" });
const START_REFUSAL = Object.freeze(["EXCLUDED", "OWN_ARCH", "FAMILY", "SEC_CLASS", "SYSTEM_UNKNOWN", "ACTIVE_EXISTS",
  "SEASON_LIMIT", "COOLDOWN", "GLOBAL_LIMIT", "NO_PLACE", "NO_TEMPLATE", "GRAPH_NOT_READY"]);
const END_REASON = Object.freeze({ DEADLINE: "DEADLINE", DISABLED: "DISABLED", RELOCATIONS: "RELOCATIONS",
  NO_PLACE: "NO_PLACE", COMPLETED: "COMPLETED", STOLEN: "STOLEN" });
const MAX_REWARD_JSON = 512;
const J_SPACE_MIN = 31000000;
const J_SPACE_MAX = 31999999;

const KIND_HINT = "ARCH_HINT";
const KIND_LORE = "ARCH_LORE";
const CHAIN_ID_PREFIX = "arc:";
const SEASON_KEY_RE = /^[a-z0-9_-]{1,16}$/;
const MAX_CHAIN_ID = 40;
const MAX_OUTCOME_ID = 128;
const MAX_TEMPLATE_ID = 128;
const MAX_STAGE_COUNT = 8;
const VIEW_ID = "archaeology";

const COUNTER_NAMES = Object.freeze(["hacks.seen", "hacks.own", "hacks.queueDropped", "starts.rolled", "starts.hit",
  "starts.duplicate", "starts.refused.EXCLUDED", "starts.refused.OWN_ARCH", "starts.refused.FAMILY",
  "starts.refused.SEC_CLASS", "starts.refused.SYSTEM_UNKNOWN", "starts.refused.ACTIVE_EXISTS",
  "starts.refused.SEASON_LIMIT", "starts.refused.COOLDOWN", "starts.refused.GLOBAL_LIMIT",
  "starts.refused.NO_PLACE", "starts.refused.NO_TEMPLATE", "starts.refused.GRAPH_NOT_READY", "chains.started",
  "chains.ended.EXPIRED", "chains.ended.CANCELLED", "stages.regionReused", "places.worldUnavailable", "mail.queued",
  "mail.skipped", "line.sent", "line.refused", "command.replies", "command.errors", "retention.deleted", "errors",
  "hacks.ownWake", "stages.spawned", "stages.found", "stages.stolen", "stages.relocated", "stages.respawned",
  "stages.lostWin", "stages.noPlace", "stages.templateRefused", "sites.refused.SITES_FULL",
  "sites.refused.SYSTEM_WINDOW_FULL", "sites.refused.OTHER", "presence.unavailable", "lore.template",
  "chains.ended.COMPLETED",
  "chains.ended.STOLEN", "reward.frozen", "reward.typeMissing", "reward.readRefused", "stages.wh", "stages.whFallback",
  "stages.whReplaced",
  "lore.asked", "lore.ai", "lore.ai.delivered", "lore.late", "lore.dayLimit", "lore.refused.OFF",
  "lore.refused.DISABLED", "lore.refused.STOPPED", "lore.refused.BAD_SPEC", "lore.refused.BREAKER_OPEN",
  "lore.refused.RATE_LIMITED", "lore.refused.BUDGET", "lore.refused.TALK_BUDGET", "lore.refused.TALK_IN_FLIGHT",
  "lore.refused.TIMEOUT", "lore.refused.NET_ERROR", "lore.refused.BAD_SHAPE", "lore.refused.EMPTY",
  "lore.refused.FILTER", "lore.refused.LENGTH", "lore.refused.DIGITS", "lore.refused.URL", "lore.refused.MARKUP",
  "lore.refused.OTHER"]);

const ARCHIVE_KEY = "lne_archive";
const ARCHIVE_CONTENT_KEY = `container:${ARCHIVE_KEY}`;
const STAGE_SLOT = 0;
const STAGE_EVENT_ID_RE = /^(arc:[a-z0-9_-]{1,16}:\d{1,15}:\d{1,6}):s(\d{1,2}):r(\d{1,9})$/;

const chainIdOf = (seasonKey, characterId, chainNo) => `${CHAIN_ID_PREFIX}${seasonKey}:${characterId}:${chainNo}`;
const stageEventIdOf = (chainId, stageNo, spawnNo) => `${chainId}:s${stageNo}:r${spawnNo}`;

function parseStageEventId(eventId) {
  const m = typeof eventId === "string" ? STAGE_EVENT_ID_RE.exec(eventId) : null;
  return m ? { chainId: m[1], stageNo: Number(m[2]), spawnNo: Number(m[3]) } : null;
}
const isSeasonKey = (v) => typeof v === "string" && SEASON_KEY_RE.test(v);

function archaeologySettingsOf(config) {
  const P = config && config.archaeology;
  if (!P || typeof P !== "object") return null;
  const secClasses = String(P.startSecClasses || "").split(",").map((s) => s.trim()).filter((s) => s !== "");
  const rewardOf = (text) => {
    const r = parseRewardCsv(typeof text === "string" ? text : "");
    return r.ok ? r.entries : Object.freeze([]);
  };
  return Object.freeze({ ...P, stageCountMax: Math.max(P.stageCountMin, P.stageCountMax),
    maxJumps: Math.max(P.minJumps, P.maxJumps), startSecClassSet: new Set(secClasses),
    finalReward: Object.freeze({ [THEME.JOVE]: rewardOf(P.finalRewardJoveCsv),
      [THEME.DRIFTER]: rewardOf(P.finalRewardDrifterCsv) }) });
}

const DDL = `
CREATE TABLE world_arch_chains (
  chain_id              TEXT PRIMARY KEY,
  character_id          INTEGER NOT NULL,
  season_key            TEXT NOT NULL,
  chain_no              INTEGER NOT NULL,
  origin_instance_id    INTEGER NOT NULL,
  origin_outcome_id     TEXT NOT NULL,
  origin_system_id      INTEGER NOT NULL,
  theme                 TEXT NOT NULL,
  seed                  INTEGER NOT NULL,
  stage_count           INTEGER NOT NULL,
  stage_no              INTEGER NOT NULL,
  state                 TEXT NOT NULL,
  stage_state           TEXT NOT NULL,
  stage_kind            TEXT NOT NULL,
  stage_system_id       INTEGER NOT NULL,
  stage_entry_system_id INTEGER,
  stage_region_id       INTEGER NOT NULL,
  stage_template_id     TEXT NOT NULL,
  stage_faction_id      INTEGER NOT NULL,
  stage_spawn_no        INTEGER NOT NULL DEFAULT 0,
  stage_relocations     INTEGER NOT NULL DEFAULT 0,
  stage_due_at          INTEGER,
  visited_regions       TEXT NOT NULL,
  reward_json           TEXT,
  next_check_at         INTEGER NOT NULL,
  deadline_at           INTEGER NOT NULL,
  end_reason            TEXT,
  version               INTEGER NOT NULL DEFAULT 1,
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL,
  ended_at              INTEGER
);
CREATE UNIQUE INDEX uq_arch_chains_no ON world_arch_chains(character_id, season_key, chain_no);
CREATE UNIQUE INDEX uq_arch_chains_origin ON world_arch_chains(origin_instance_id, origin_outcome_id);
CREATE UNIQUE INDEX uq_arch_chains_active ON world_arch_chains(character_id) WHERE state = 'ACTIVE';
CREATE INDEX idx_arch_chains_due ON world_arch_chains(state, next_check_at);
CREATE INDEX idx_arch_chains_ended ON world_arch_chains(ended_at) WHERE ended_at IS NOT NULL;
CREATE TABLE world_arch_fragments (
  chain_id      TEXT NOT NULL,
  stage_no      INTEGER NOT NULL,
  system_id     INTEGER NOT NULL,
  region_id     INTEGER NOT NULL,
  lore_source   TEXT NOT NULL,
  lore_text     TEXT,
  hint_text     TEXT,
  lore_attempts INTEGER NOT NULL DEFAULT 0,
  found_at      INTEGER NOT NULL,
  delivered_at  INTEGER,
  PRIMARY KEY (chain_id, stage_no)
);
CREATE INDEX idx_arch_fragments_found ON world_arch_fragments(found_at);
`;

function upArchaeology(db) {
  db.exec(DDL);
}

module.exports = { TABLE, FRAGMENTS_TABLE, CHAIN_STATE, STAGE_STATE, STAGE_KIND, THEME, START_REFUSAL, END_REASON,
  MAX_REWARD_JSON, J_SPACE_MIN, J_SPACE_MAX,
  KIND_HINT, KIND_LORE, CHAIN_ID_PREFIX, SEASON_KEY_RE, MAX_CHAIN_ID, MAX_OUTCOME_ID, MAX_TEMPLATE_ID, MAX_STAGE_COUNT,
  VIEW_ID, COUNTER_NAMES, ARCHIVE_KEY, ARCHIVE_CONTENT_KEY, STAGE_SLOT, chainIdOf, stageEventIdOf, parseStageEventId,
  isSeasonKey, archaeologySettingsOf, upArchaeology };
