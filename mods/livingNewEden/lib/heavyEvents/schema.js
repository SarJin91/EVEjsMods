"use strict";

const P = require("./power/schema");
const W = require("./world/schema");

const TABLE = "world_heavy_events";

const DDL = `
CREATE TABLE world_heavy_events (
  event_id               TEXT    PRIMARY KEY NOT NULL CHECK (length(event_id) BETWEEN 5 AND 64),
  plan_key               TEXT    NOT NULL UNIQUE CHECK (length(plan_key) BETWEEN 5 AND 96),
  event_type             TEXT    NOT NULL CHECK (length(event_type) BETWEEN 1 AND 16),
  tier                   INTEGER NOT NULL CHECK (tier BETWEEN 1 AND 3),
  system_id              INTEGER NOT NULL CHECK (system_id > 0),
  faction_id             INTEGER NOT NULL CHECK (faction_id > 0),
  beneficiary_faction_id INTEGER CHECK (beneficiary_faction_id IS NULL OR beneficiary_faction_id > 0),
  station_id             TEXT,
  state                  TEXT    NOT NULL CHECK (length(state) BETWEEN 1 AND 16),
  open                   INTEGER NOT NULL CHECK (open IN (0, 1)),
  phase                  INTEGER NOT NULL DEFAULT 0 CHECK (phase >= 0),
  scale_steps            INTEGER NOT NULL DEFAULT 0 CHECK (scale_steps >= 0),
  members_json           TEXT    NOT NULL CHECK (json_valid(members_json)),
  funded                 INTEGER NOT NULL DEFAULT 0 CHECK (funded IN (0, 1)),
  integrity              INTEGER CHECK (integrity IS NULL OR integrity BETWEEN 0 AND 1000),
  seed                   INTEGER NOT NULL CHECK (seed >= 0),
  created_at             INTEGER NOT NULL,
  expires_at             INTEGER NOT NULL,
  due_at                 INTEGER,
  engaged_at             INTEGER,
  ended_at               INTEGER,
  end_reason             TEXT,
  abandons               INTEGER NOT NULL DEFAULT 0 CHECK (abandons >= 0),
  reward_state           TEXT    NOT NULL DEFAULT 'NONE' CHECK (length(reward_state) BETWEEN 1 AND 16),
  reward_attempts        INTEGER NOT NULL DEFAULT 0 CHECK (reward_attempts >= 0),
  cleanup_at             INTEGER,
  site_released          INTEGER NOT NULL DEFAULT 0 CHECK (site_released IN (0, 1)),
  result_json            TEXT    NOT NULL DEFAULT '{}' CHECK (json_valid(result_json)),
  updated_at             INTEGER NOT NULL,
  version                INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1)
) STRICT;
CREATE INDEX world_heavy_events_open_system ON world_heavy_events (open, system_id) WHERE open = 1;
CREATE INDEX world_heavy_events_open_faction ON world_heavy_events (open, faction_id) WHERE open = 1;
CREATE INDEX world_heavy_events_ended ON world_heavy_events (state, ended_at);
`;

function upHeavyEvents(db) {
  db.exec(DDL);
}

function upHeavyEventsPower(db) {
  db.exec(`ALTER TABLE world_heavy_events ADD COLUMN variant TEXT
    CHECK (variant IS NULL OR length(variant) BETWEEN 1 AND 16);
  ALTER TABLE world_heavy_events ADD COLUMN affix TEXT
    CHECK (affix IS NULL OR length(affix) BETWEEN 1 AND 16);
  ALTER TABLE world_heavy_events ADD COLUMN pocket INTEGER NOT NULL DEFAULT 0 CHECK (pocket >= 0);`);
}

const STATE = Object.freeze({
  PLANNED: "PLANNED",
  ENGAGED: "ENGAGED",
  CLEARED: "CLEARED",
  COMPLETED: "COMPLETED",
  FAILED: "FAILED",
  EXPIRED: "EXPIRED",
  CANCELLED: "CANCELLED",
});
const STATES = Object.freeze(Object.values(STATE));
const TERMINAL_STATES = Object.freeze([STATE.COMPLETED, STATE.FAILED, STATE.EXPIRED, STATE.CANCELLED]);
const LIMIT_STATES = Object.freeze([STATE.PLANNED, STATE.ENGAGED, STATE.CLEARED]);

const TYPE = Object.freeze({ REDOUBT: "redoubt", FOUNDRY: "foundry", DEFENSE: "defense" });
const TYPES = Object.freeze(Object.values(TYPE));
const HEAVY_TYPES = TYPES;
const EVENT_TYPES = Object.freeze([...TYPES, ...P.POWER_TYPES]);
const TYPE_SWITCH_KEY = Object.freeze({ redoubt: "redoubtEnabled", foundry: "foundryEnabled",
  defense: "defenseEnabled" });
const FUNDED_TYPES = Object.freeze([TYPE.REDOUBT, TYPE.FOUNDRY]);

const END_REASON = Object.freeze({
  EXPIRED: "EXPIRED",
  CANCELLED: "CANCELLED",
  DISABLED: "DISABLED",
  RESTART: "RESTART",
  ABANDONED: "ABANDONED",
  INTEGRITY: "INTEGRITY",
  TIMEOUT: "TIMEOUT",
  CLEARED: "CLEARED",
  ESCAPED: "ESCAPED",
});
const END_REASONS = Object.freeze(Object.values(END_REASON));

const MEMBER_STATE = Object.freeze({ RESERVED: "RESERVED", DESTROYED: "DESTROYED", UNSPAWNABLE: "UNSPAWNABLE", ESCAPED: "ESCAPED" });
const MEMBER_STATES = Object.freeze(Object.values(MEMBER_STATE));

const REWARD_STATE = Object.freeze({ NONE: "NONE", PENDING: "PENDING", PLACED: "PLACED", SKIPPED: "SKIPPED" });
const REWARD_STATES = Object.freeze(Object.values(REWARD_STATE));

const FIRST_PHASE = 1;
const INTEGRITY_START = 1000;
const NEUTRAL_KIND = "neutral";

const CANDIDATE_REASON_RANK = Object.freeze(["NO_CANDIDATE", "TYPE_OFF", "BAND_OFF", "KIND_OFF", "NO_STATION",
  "NO_MINERALS", "NO_STOCK", "COOLDOWN", "BUSY", "LIMIT"]);

const SECURITY_BANDS = Object.freeze(["highsec", "lowsec", "nullsec"]);
const FACTION_KINDS = Object.freeze(["pirate", "empire", "police", "neutral", "invader", "hive"]);
const TIER_COUNT = 3;

const PLAN_REFUSALS = Object.freeze(["PRESENCE", "STATIONS_NOT_READY", "SHIPS_CAP", "INSUFFICIENT_STOCK",
  "SITES_FULL", "SYSTEM_WINDOW_FULL", "OTHER"]);

const AGGREGATE = "heavy_event";
const EVENT_PLANNED = "HEAVY_EVENT_PLANNED";
const EVENT_TRANSITION = "HEAVY_EVENT_TRANSITION";
const EVENT_LOSSES = "HEAVY_EVENT_LOSSES";
const EVENT_RELEASED = "HEAVY_EVENT_RELEASED";
const EVENT_REWARD = "HEAVY_EVENT_REWARD";
const EVENT_REWARD_ATTEMPT = "HEAVY_EVENT_REWARD_ATTEMPT";
const REWARD_SKIP_REASONS = Object.freeze(["NO_LOSSES", "NO_PROFILE", "LIMIT_DAY", "LIMIT_SYSTEM", "ATTEMPTS",
  "SCENE", "SITE", "DRAIN"]);
const DRAIN_MAX_TYPES = 8;
const OPEN_SCAN_LIMIT = 256;

const DEFERRAL = Object.freeze(["GOVERNOR", "BUDGET", "SCENE", "SITE_READ"]);
const FAIL_REASONS = Object.freeze([END_REASON.INTEGRITY, END_REASON.TIMEOUT]);
const CANCEL_REASONS = Object.freeze([END_REASON.CANCELLED, END_REASON.DISABLED]);

const COUNTER_NAMES = Object.freeze([
  ...TYPES.map((t) => `planned.${t}`),
  "engaged", "phase",
  ...TYPES.map((t) => `cleared.${t}`),
  ...FAIL_REASONS.map((r) => `failed.${r}`),
  "expired",
  ...CANCEL_REASONS.map((r) => `cancelled.${r}`),
  "abandoned", "restartReset", "shipsSpawned", "unspawnable", "hullsFunded", "hullsLost", "hullsReturned",
  "hullsOrphaned", "reward.placed", "reward.skipped", "reward.failed",
  ...CANDIDATE_REASON_RANK.map((r) => `refused.${r}`),
  ...DEFERRAL.map((r) => `deferred.${r}`),
  ...PLAN_REFUSALS.map((r) => `refused.${r}`),
  "pruned", "errors",
  "influenceSkipped",
  ...REWARD_SKIP_REASONS.map((r) => `reward.skipped.${r}`),
  "mineralsDrained", "drain.empty", "drain.refused",
  "payout.planned", "payout.planFailed", "payout.paid", "payout.failed", "payout.retries", "payout.duplicates",
  "payout.keyReused", "payout.seamsMissing", "payout.pruned",
  ...P.POWER_TYPES.map((t) => `planned.${t}`),
  ...P.POWER_TYPES.map((t) => `cleared.${t}`),
  ...P.POWER_COUNTER_NAMES,
  ...PLAN_REFUSALS.map((r) => `power.refused.${r}`),
  ...W.WORLD_COUNTER_NAMES,
  ...PLAN_REFUSALS.filter((r) => !W.WORLD_REASON_RANK.includes(r)).map((r) => `anomaly.refused.${r}`),
  ...P.POWER_REWARD_SKIP_REASONS.map((r) => `anomaly.reward.skipped.${r}`),
  "incursion.pocket", "incursion.escaped", "incursion.failed.ESCAPED", "incursion.deferred.SITES",
]);

const KEY_PREFIX = "hev";
const PLAN_SLOT = 0;
const REWARD_KEY_PREFIX = "hevrwd";

const eventIdOf = (bucket, slot) => `${KEY_PREFIX}:${bucket}:${slot}`;
const planKeyOf = (intervalMs, bucket, slot) => `${intervalMs}:${bucket}:${slot}`;
const planJournalKeyOf = (eventId) => `${eventId}:plan`;
const fundKeyOf = (eventId) => `${eventId}:fund`;
const returnKeyOf = (eventId) => `${eventId}:return`;
const influenceKeyOf = (eventId) => `${eventId}:influence`;
const drainKeyOf = (eventId) => `${eventId}:drain`;
const releaseKeyOf = (eventId) => `${eventId}:release`;
const transitionKeyOf = (eventId, from, to, phase) => `${eventId}:t:${from}:${to}:${phase}`;
const lossKeyOf = (eventId, phase, n) => `${eventId}:loss:${phase}:${n}`;
const rewardAttemptKeyOf = (eventId, version) => `${eventId}:rwtry:${version}`;
const rewardKeyOf = (day, systemId, eventId) => `${REWARD_KEY_PREFIX}:${day}:${systemId}:${eventId}`;
const rewardDayRangeOf = (day) => ({ from: `${REWARD_KEY_PREFIX}:${day}:`, to: `${REWARD_KEY_PREFIX}:${day};` });

function parseClosedList(text, allowed) {
  if (typeof text !== "string") return null;
  const out = [];
  for (const raw of text.split(",")) {
    const token = raw.trim();
    if (token === "" || !allowed.includes(token) || out.includes(token)) return null;
    out.push(token);
  }
  return out;
}

function parseTierInts(text) {
  if (typeof text !== "string") return null;
  const parts = text.split(",").map((s) => s.trim());
  if (parts.length !== TIER_COUNT || !parts.every((s) => /^[0-9]{1,9}$/.test(s))) return null;
  return parts.map(Number);
}

const parseSecurityBands = (text) => parseClosedList(text, SECURITY_BANDS);
const parseFactionKinds = (text) => parseClosedList(text, FACTION_KINDS);
function parseTierWeights(text) {
  const w = parseTierInts(text);
  return w && w.reduce((a, b) => a + b, 0) > 0 ? w : null;
}
const parseTierRolls = (text) => parseTierInts(text);

module.exports = {
  TABLE,
  upHeavyEvents,
  upHeavyEventsPower,
  HEAVY_TYPES,
  EVENT_TYPES,
  STATE,
  STATES,
  TERMINAL_STATES,
  LIMIT_STATES,
  TYPE,
  TYPES,
  TYPE_SWITCH_KEY,
  FUNDED_TYPES,
  END_REASON,
  END_REASONS,
  MEMBER_STATE,
  MEMBER_STATES,
  REWARD_STATE,
  REWARD_STATES,
  FIRST_PHASE,
  INTEGRITY_START,
  NEUTRAL_KIND,
  CANDIDATE_REASON_RANK,
  SECURITY_BANDS,
  FACTION_KINDS,
  TIER_COUNT,
  DEFERRAL,
  PLAN_REFUSALS,
  AGGREGATE,
  EVENT_PLANNED,
  EVENT_TRANSITION,
  EVENT_LOSSES,
  EVENT_RELEASED,
  EVENT_REWARD,
  EVENT_REWARD_ATTEMPT,
  REWARD_SKIP_REASONS,
  DRAIN_MAX_TYPES,
  OPEN_SCAN_LIMIT,
  COUNTER_NAMES,
  KEY_PREFIX,
  PLAN_SLOT,
  REWARD_KEY_PREFIX,
  eventIdOf,
  planKeyOf,
  planJournalKeyOf,
  fundKeyOf,
  returnKeyOf,
  influenceKeyOf,
  drainKeyOf,
  releaseKeyOf,
  transitionKeyOf,
  lossKeyOf,
  rewardAttemptKeyOf,
  rewardKeyOf,
  rewardDayRangeOf,
  parseSecurityBands,
  parseFactionKinds,
  parseTierWeights,
  parseTierRolls,
};
