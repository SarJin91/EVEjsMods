"use strict";

const TABLE_NAME = "world_scheduled_events";
const STATE_INDEX = "world_scheduled_events_state";
const LIVE_INDEX = "world_scheduled_events_live";
const LIVE_INDEX_WHERE = "state <> 'DONE'";

const STATE = Object.freeze({
  QUEUED: "QUEUED", CLAIMED: "CLAIMED", DONE: "DONE", RETRY: "RETRY", QUARANTINED: "QUARANTINED",
});
const MAX_ID_LENGTH = 64;
const MAX_KEY_LENGTH = 200;
const MAX_NAME_LENGTH = 64;
const MAX_ERROR_LENGTH = 1000;
const MAX_OUTCOME_LENGTH = 64;
const HASH_LENGTH = 64;
const CLAIM_INTERRUPTED = "CLAIM_INTERRUPTED";

function upScheduledEvents(db) {
  db.exec(`CREATE TABLE world_scheduled_events (
    event_id        TEXT    PRIMARY KEY NOT NULL CHECK (length(event_id) BETWEEN 1 AND 64),
    idempotency_key TEXT    NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 1 AND 200),
    event_type      TEXT    NOT NULL CHECK (length(event_type) BETWEEN 1 AND 64),
    aggregate_type  TEXT    NOT NULL CHECK (length(aggregate_type) BETWEEN 1 AND 64),
    aggregate_id    TEXT    NOT NULL CHECK (length(aggregate_id) BETWEEN 1 AND 200),
    priority        INTEGER NOT NULL CHECK (priority BETWEEN 1 AND 5),
    due_at          INTEGER NOT NULL CHECK (due_at >= 0),
    payload         TEXT    NOT NULL CHECK (json_valid(payload)),
    payload_hash    TEXT    NOT NULL CHECK (length(payload_hash) = 64),
    state           TEXT    NOT NULL CHECK (length(state) BETWEEN 1 AND 16),
    attempts        INTEGER NOT NULL CHECK (attempts >= 0),
    last_error      TEXT    CHECK (last_error IS NULL OR length(last_error) <= 1000),
    outcome         TEXT    CHECK (outcome IS NULL OR length(outcome) BETWEEN 1 AND 64),
    created_at      INTEGER NOT NULL CHECK (created_at >= 0),
    claimed_at      INTEGER CHECK (claimed_at IS NULL OR claimed_at >= 0),
    finished_at     INTEGER CHECK (finished_at IS NULL OR finished_at >= 0),
    version         INTEGER NOT NULL CHECK (version >= 1),
    CHECK (state <> 'CLAIMED' OR claimed_at IS NOT NULL),
    CHECK ((state IN ('DONE', 'QUARANTINED')) = (finished_at IS NOT NULL)),
    CHECK (state <> 'DONE' OR outcome IS NOT NULL),
    CHECK (state <> 'QUARANTINED' OR last_error IS NOT NULL)
  ) STRICT;
  CREATE INDEX world_scheduled_events_state ON world_scheduled_events (state, priority, due_at, event_id);`);
}

function upScheduledEventsLiveIndex(db) {
  db.exec(`DROP INDEX IF EXISTS world_scheduled_events_state;
  CREATE INDEX IF NOT EXISTS world_scheduled_events_live ON world_scheduled_events (priority, due_at, event_id)
    WHERE state <> 'DONE';`);
}

module.exports = {
  TABLE_NAME,
  STATE_INDEX,
  LIVE_INDEX,
  LIVE_INDEX_WHERE,
  upScheduledEventsLiveIndex,
  STATE,
  MAX_ID_LENGTH,
  MAX_KEY_LENGTH,
  MAX_NAME_LENGTH,
  MAX_ERROR_LENGTH,
  MAX_OUTCOME_LENGTH,
  HASH_LENGTH,
  CLAIM_INTERRUPTED,
  upScheduledEvents,
};
