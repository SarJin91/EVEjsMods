"use strict";

const TABLE = "world_events";
const PULSE_EVENT = "SITE_REFRESH";
const PULSE_AGGREGATE_ID = "director";
const CLEANUP_REASONS = Object.freeze(["EVENT_END", "EVENT_CANCELLED"]);

const MAX_EVENT_ID_LENGTH = 64;
const MAX_PLAN_KEY_LENGTH = 128;
const MAX_EVENT_TYPE_LENGTH = 32;
const MAX_CAMPAIGN_ID_LENGTH = 64;
const MAX_CAUSE_LENGTH = 32;
const MAX_LABEL_LENGTH = 64;
const MAX_SPAWN_BUDGET = 8;
const MAX_JSON_LENGTH = 2048;
const MAX_RESULT_REFERENCE_LENGTH = 32;

function pulseKey(intervalMs, bucket) {
  return `events:pulse:${intervalMs}:${bucket}`;
}

function bootKey(intervalMs, round) {
  return `events:boot:${intervalMs}:${round}`;
}

function nudgeKey(intervalMs, nudgeMs, slot) {
  return `events:nudge:${intervalMs}:${nudgeMs}:${slot}`;
}

const CLEARED_REASON = "EVENT_CLEARED";

function clearedKey(eventId) {
  return `event:${eventId}:cleared`;
}

function upWorldEvents(db) {
  db.exec(`CREATE TABLE world_events (
    event_id         TEXT PRIMARY KEY CHECK (length(event_id) BETWEEN 1 AND 64),
    plan_key         TEXT NOT NULL UNIQUE CHECK (length(plan_key) BETWEEN 1 AND 128),
    event_type       TEXT NOT NULL CHECK (length(event_type) BETWEEN 1 AND 32),
    catalog_version  INTEGER NOT NULL CHECK (catalog_version >= 1),
    system_id        INTEGER NOT NULL CHECK (system_id > 0),
    faction_id       INTEGER NOT NULL CHECK (faction_id > 0),
    campaign_id      TEXT CHECK (campaign_id IS NULL OR length(campaign_id) BETWEEN 1 AND 64),
    cause            TEXT NOT NULL CHECK (length(cause) BETWEEN 1 AND 32),
    template_id      TEXT NOT NULL,
    template_ids     TEXT NOT NULL,
    label            TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 64),
    state            TEXT NOT NULL CHECK (length(state) BETWEEN 1 AND 16),
    spawn_budget     INTEGER NOT NULL CHECK (spawn_budget BETWEEN 1 AND 8),
    sites_created    INTEGER NOT NULL DEFAULT 0 CHECK (sites_created >= 0),
    created_at       INTEGER NOT NULL CHECK (created_at >= 0),
    due_at           INTEGER NOT NULL CHECK (due_at >= 0),
    expires_at       INTEGER NOT NULL CHECK (expires_at >= 0),
    ended_at         INTEGER CHECK (ended_at IS NULL OR ended_at >= 0),
    seed             INTEGER NOT NULL CHECK (seed BETWEEN 0 AND 4294967295),
    reason_json      TEXT NOT NULL CHECK (length(reason_json) <= 2048),
    result_reference TEXT CHECK (result_reference IS NULL OR length(result_reference) BETWEEN 1 AND 32),
    result_json      TEXT CHECK (result_json IS NULL OR length(result_json) <= 2048),
    cleanup_pending  TEXT CHECK (cleanup_pending IS NULL OR cleanup_pending IN ('EVENT_END', 'EVENT_CANCELLED')),
    updated_at       INTEGER NOT NULL CHECK (updated_at >= 0),
    version          INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1)
  ) STRICT;
  CREATE INDEX world_events_open    ON world_events (due_at) WHERE state IN ('PLANNED', 'ACTIVE', 'COMPLETING');
  CREATE INDEX world_events_created ON world_events (created_at);
  CREATE INDEX world_events_system  ON world_events (system_id, created_at);
  CREATE INDEX world_events_ended   ON world_events (ended_at) WHERE ended_at IS NOT NULL;
  CREATE INDEX world_events_cleanup ON world_events (ended_at) WHERE cleanup_pending IS NOT NULL;`);
}

module.exports = {
  TABLE,
  PULSE_EVENT,
  PULSE_AGGREGATE_ID,
  CLEANUP_REASONS,
  MAX_EVENT_ID_LENGTH,
  MAX_PLAN_KEY_LENGTH,
  MAX_EVENT_TYPE_LENGTH,
  MAX_CAMPAIGN_ID_LENGTH,
  MAX_CAUSE_LENGTH,
  MAX_LABEL_LENGTH,
  MAX_SPAWN_BUDGET,
  MAX_JSON_LENGTH,
  MAX_RESULT_REFERENCE_LENGTH,
  pulseKey,
  bootKey,
  nudgeKey,
  CLEARED_REASON,
  clearedKey,
  upWorldEvents,
};
