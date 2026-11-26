"use strict";

const CYCLES_TABLE = "world_gm_cycles";
const THREADS_TABLE = "world_gm_threads";
const ACTIVITY_TABLE = "world_gm_activity";

const STATE_CYCLE = Object.freeze({ DRAFTING: "DRAFTING", STARTED: "STARTED", SKIPPED: "SKIPPED" });
const STATE_THREAD = Object.freeze({ ACTIVE: "ACTIVE", ENDED: "ENDED", CANCELLED: "CANCELLED" });
const STEP_STATE = Object.freeze({ PENDING: "PENDING", RUNNING: "RUNNING" });
const STEP_RESULT = Object.freeze({ DONE: "DONE", FAILED: "FAILED", SKIPPED: "SKIPPED" });
const OUTCOME = Object.freeze({ WON: "WON", LOST: "LOST", NEUTRAL: "NEUTRAL", EXPIRED: "EXPIRED" });
const SOURCES = Object.freeze({ AI: "ai", TEMPLATE: "template" });

const ARC_KEYS = Object.freeze(["DEFECTOR", "MUTINY", "SMUGGLER_CACHE", "WAR_RUMOUR"]);
const RESERVED_KINDS = Object.freeze(["NEWS", "NOTICE", "SITE", "WAIT"]);

const VALIDATOR_REASONS = Object.freeze(["TOO_LARGE", "NOT_JSON", "UNKNOWN_KEY", "BAD_VERSION", "ARC_UNKNOWN",
  "ARC_COOLDOWN", "FACTION_UNKNOWN", "ACTOR_UNKNOWN", "PLACE_UNKNOWN", "PLACE_SEC", "PLACE_COOLDOWN", "STEPS_COUNT",
  "STEP_KIND", "STEP_PARAMS", "STEP_LIMIT", "TOO_LONG"]);

const REASON = Object.freeze({ OPEN_LIMIT: "OPEN_LIMIT", NO_TEMPLATE: "NO_TEMPLATE", FALLBACK_OFF: "FALLBACK_OFF",
  NO_PLACE: "NO_PLACE", NO_FACTION: "NO_FACTION", NO_ARC: "NO_ARC", KIND_GONE: "KIND_GONE", THROW: "THROW",
  DISABLED: "DISABLED", DEADLINE: "DEADLINE", PLAN_TOO_LARGE: "PLAN_TOO_LARGE", HANDLE_TOO_LARGE: "HANDLE_TOO_LARGE" });

const TEXT_FIELDS = Object.freeze(["title", "hook", "notice", "won", "lost"]);
const TEXT_MAX = Object.freeze({ title: 60, hook: 200, notice: 200, won: 200, lost: 200 });

const SKIP_CODES = Object.freeze(["OPEN_LIMIT", "NO_TEMPLATE", "FALLBACK_OFF", "NO_PLACE", "NO_FACTION", "NO_ARC",
  "REJECTED", "GOVERNOR", "CAS", "DUPLICATE", "NO_GRAPH"]);

const AI_REFUSALS = Object.freeze(["OFF", "DISABLED", "STOPPED", "BAD_SPEC", "BREAKER_OPEN", "RATE_LIMITED", "BUDGET",
  "PLOT_BUDGET", "PLOT_IN_FLIGHT", "ABORTED", "PROMPT_TOO_LARGE", "OTHER"]);
const AI_PERMANENT_REFUSALS = Object.freeze(["OFF", "DISABLED", "STOPPED", "BAD_SPEC", "PROMPT_TOO_LARGE"]);

const COUNTER_NAMES = Object.freeze(["passes", "cycles", "drafted",
  "ai.requested", "ai.accepted", "ai.failed", ...AI_REFUSALS.map((r) => `ai.refused.${r}`),
  ...SKIP_CODES.map((c) => `skipped.${c}`),
  ...VALIDATOR_REASONS.map((r) => `rejected.${r}`),
  ...TEXT_FIELDS.map((f) => `textFallback.${f}`),
  "threads.started.ai", "threads.started.template",
  ...Object.values(OUTCOME).map((o) => `threads.ended.${o}`), "threads.cancelled",
  ...Object.values(STEP_RESULT).map((s) => `steps.${s}`), "steps.RETRY", "steps.kindGone",
  "drained", "retained", "errors", "activity.samples"]);

const AGGREGATE = "gm_thread";
const EVENT_STARTED = "GM_THREAD_STARTED";
const EVENT_STEP_DONE = "GM_STEP_DONE";
const EVENT_ENDED = "GM_THREAD_ENDED";

const NOTICE_KIND = "GM_STORY";
const VIEW_ID = "game-master";
const PANEL_ORDER = 71;
const OWNER = "gameMaster";
const MS_PER_HOUR = 3600000;
const MAX_PARAMS_BYTES = 512;
const MAX_HANDLE_BYTES = 512;
const MAX_REASON_LENGTH = 48;
const MAX_PLAN_BYTES = 8000;

const METRICS = Object.freeze({ passMs: "gameMaster.passMs", open: "gameMaster.threads.open",
  aiMs: "gameMaster.aiMs" });

function threadIdOf(cycleAt) {
  return `gmt:${cycleAt}`;
}

function stepKeyOf(threadId, stepNo) {
  return `gm:${threadId}:${stepNo}`;
}

function parseArcsCsv(value) {
  if (typeof value !== "string") return null;
  const parts = value.split(",").map((p) => p.trim()).filter((p) => p !== "");
  if (parts.length === 0 || parts.some((p) => !ARC_KEYS.includes(p)) || new Set(parts).size !== parts.length) {
    return null;
  }
  return Object.freeze([...parts].sort());
}

function gameMasterSettingsOf(config) {
  const S = config && config.gameMaster;
  if (!S || typeof S !== "object") return { ok: false, reason: "INVALID_SETTINGS", detail: "gameMaster" };
  const arcs = parseArcsCsv(S.arcsCsv);
  if (!arcs) return { ok: false, reason: "INVALID_SETTINGS", detail: "arcsCsv" };
  if (S.siteMinHours > S.siteMaxHours) return { ok: false, reason: "INVALID_SETTINGS", detail: "siteMinHours" };
  if (S.activityMidSamples > S.activityHighSamples) {
    return { ok: false, reason: "INVALID_SETTINGS", detail: "activityMidSamples" };
  }
  if (!(S.maxPlanBytes <= MAX_PLAN_BYTES)) return { ok: false, reason: "INVALID_SETTINGS", detail: "maxPlanBytes" };
  return { ok: true, settings: Object.freeze({ ...S, arcs }) };
}

function upGameMaster(db) {
  db.exec(`CREATE TABLE world_gm_cycles (
    cycle_at   INTEGER PRIMARY KEY NOT NULL CHECK (cycle_at >= 0),
    state      TEXT    NOT NULL CHECK (state IN ('DRAFTING', 'STARTED', 'SKIPPED')),
    attempts   INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    source     TEXT    CHECK (source IS NULL OR source IN ('ai', 'template')),
    reason     TEXT    CHECK (reason IS NULL OR length(reason) BETWEEN 1 AND 48),
    thread_id  TEXT    CHECK (thread_id IS NULL OR length(thread_id) BETWEEN 1 AND 40),
    created_at INTEGER NOT NULL CHECK (created_at >= 0),
    updated_at INTEGER NOT NULL CHECK (updated_at >= 0)
  ) STRICT;
  CREATE TABLE world_gm_threads (
    thread_id        TEXT    PRIMARY KEY NOT NULL CHECK (length(thread_id) BETWEEN 1 AND 40),
    cycle_at         INTEGER NOT NULL UNIQUE CHECK (cycle_at >= 0),
    arc              TEXT    NOT NULL CHECK (length(arc) BETWEEN 1 AND 24),
    source           TEXT    NOT NULL CHECK (source IN ('ai', 'template')),
    faction_id       INTEGER NOT NULL CHECK (faction_id > 0),
    actor_faction_id INTEGER CHECK (actor_faction_id IS NULL OR actor_faction_id > 0),
    anchor_system_id INTEGER NOT NULL CHECK (anchor_system_id > 0),
    plan_json        TEXT    NOT NULL CHECK (length(plan_json) BETWEEN 2 AND 8000),
    state            TEXT    NOT NULL CHECK (state IN ('ACTIVE', 'ENDED', 'CANCELLED')),
    outcome          TEXT    CHECK (outcome IS NULL OR outcome IN ('WON', 'LOST', 'NEUTRAL', 'EXPIRED')),
    step_no          INTEGER NOT NULL CHECK (step_no >= 0),
    step_state       TEXT    NOT NULL CHECK (step_state IN ('PENDING', 'RUNNING')),
    step_handle      TEXT    CHECK (step_handle IS NULL OR length(step_handle) <= 512),
    step_due_at      INTEGER NOT NULL CHECK (step_due_at >= 0),
    step_retries     INTEGER NOT NULL DEFAULT 0 CHECK (step_retries >= 0),
    step_results     TEXT    NOT NULL DEFAULT '[]' CHECK (length(step_results) BETWEEN 2 AND 4000),
    deadline_at      INTEGER NOT NULL CHECK (deadline_at >= 0),
    seed             INTEGER NOT NULL CHECK (seed >= 0),
    version          INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    created_at       INTEGER NOT NULL CHECK (created_at >= 0),
    updated_at       INTEGER NOT NULL CHECK (updated_at >= 0),
    ended_at         INTEGER CHECK (ended_at IS NULL OR ended_at >= 0)
  ) STRICT;
  CREATE INDEX idx_gm_threads_due ON world_gm_threads (state, step_due_at);
  CREATE INDEX idx_gm_threads_ended ON world_gm_threads (ended_at) WHERE ended_at IS NOT NULL;
  CREATE TABLE world_gm_activity (
    bucket_at INTEGER NOT NULL CHECK (bucket_at >= 0),
    region_id INTEGER NOT NULL CHECK (region_id > 0),
    samples   INTEGER NOT NULL CHECK (samples >= 0),
    PRIMARY KEY (bucket_at, region_id)
  ) STRICT, WITHOUT ROWID;`);
}

module.exports = { CYCLES_TABLE, THREADS_TABLE, ACTIVITY_TABLE, STATE_CYCLE, STATE_THREAD, STEP_STATE, STEP_RESULT,
  OUTCOME, SOURCES, ARC_KEYS, RESERVED_KINDS, VALIDATOR_REASONS, REASON, TEXT_FIELDS, TEXT_MAX, SKIP_CODES,
  AI_REFUSALS, AI_PERMANENT_REFUSALS, COUNTER_NAMES, AGGREGATE, EVENT_STARTED, EVENT_STEP_DONE, EVENT_ENDED, NOTICE_KIND, VIEW_ID, PANEL_ORDER, OWNER,
  MS_PER_HOUR, MAX_PARAMS_BYTES, MAX_HANDLE_BYTES, MAX_REASON_LENGTH, MAX_PLAN_BYTES, METRICS, threadIdOf, stepKeyOf,
  parseArcsCsv, gameMasterSettingsOf, upGameMaster };
