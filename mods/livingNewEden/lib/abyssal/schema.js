"use strict";

const TABLE_NAME = "lne_abyssal_runs";
const STATE = Object.freeze({ ACTIVE: "ACTIVE", COMPLETED: "COMPLETED", EXITED: "EXITED", FAILED: "FAILED",
  LOST: "LOST" });
const STATES = Object.freeze(Object.values(STATE));
const OPEN_STATES = Object.freeze([STATE.ACTIVE, STATE.COMPLETED]);
const OPEN_SQL = "finished_at_ms IS NULL";
const FINISHED_SQL = "finished_at_ms IS NOT NULL";
const MAX_PARTICIPANTS = 3;
const MAX_LIST_ROWS_DEFAULT = 5000;

function upAbyssalRuns(db) {
  db.exec(`CREATE TABLE lne_abyssal_runs (
    instance_id        INTEGER NOT NULL,
    activated_at_ms    INTEGER NOT NULL,
    owner_character_id INTEGER NOT NULL,
    source_system_id   INTEGER NOT NULL,
    host_location_id   INTEGER NOT NULL,
    tier               INTEGER NOT NULL,
    weather            TEXT,
    ship_class         TEXT,
    participants_json  TEXT NOT NULL,
    room_index         INTEGER NOT NULL,
    pockets_completed  INTEGER NOT NULL,
    expires_at_ms      INTEGER NOT NULL,
    state              TEXT NOT NULL,
    vendor_outcome     TEXT,
    first_seen_ms      INTEGER NOT NULL,
    last_seen_ms       INTEGER NOT NULL,
    finished_at_ms     INTEGER,
    version            INTEGER NOT NULL CHECK (version >= 1),
    PRIMARY KEY (instance_id, activated_at_ms)
  ) STRICT;
  CREATE INDEX lne_abyssal_runs_open ON lne_abyssal_runs (last_seen_ms) WHERE finished_at_ms IS NULL;
  CREATE INDEX lne_abyssal_runs_finished ON lne_abyssal_runs (finished_at_ms) WHERE finished_at_ms IS NOT NULL;`);
}

module.exports = { TABLE_NAME, STATE, STATES, OPEN_STATES, OPEN_SQL, FINISHED_SQL, MAX_PARTICIPANTS,
  MAX_LIST_ROWS_DEFAULT, upAbyssalRuns };
