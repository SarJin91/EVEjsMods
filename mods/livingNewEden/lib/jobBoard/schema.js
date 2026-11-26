"use strict";

const PINS_TABLE = "world_job_board_pins";
const PIN_REF_PREFIX = "fj:";
const REF_MIN = 4;
const REF_MAX = 64;
const MAX_PINS_LISTED = 64;

const DDL = `
CREATE TABLE world_job_board_pins (
  character_id INTEGER NOT NULL CHECK (character_id > 0),
  job_ref      TEXT    NOT NULL CHECK (length(job_ref) BETWEEN 4 AND 64),
  pinned_at    INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  PRIMARY KEY (character_id, job_ref)
) STRICT, WITHOUT ROWID;
CREATE INDEX world_job_board_pins_expiry ON world_job_board_pins (expires_at);
`;

function upJobBoardPins(db) {
  db.exec(DDL);
}

const PREFS_TABLE = "job_board_prefs";

const PREFS_DDL = `
CREATE TABLE job_board_prefs (
  character_id  INTEGER NOT NULL PRIMARY KEY CHECK (character_id > 0),
  open_at_login INTEGER NOT NULL CHECK (open_at_login IN (0, 1)),
  updated_at    INTEGER NOT NULL
) STRICT;
`;

function upJobBoardPrefs(db) {
  db.exec(PREFS_DDL);
}

module.exports = { PINS_TABLE, PIN_REF_PREFIX, REF_MIN, REF_MAX, MAX_PINS_LISTED, upJobBoardPins, PREFS_TABLE,
  upJobBoardPrefs };
