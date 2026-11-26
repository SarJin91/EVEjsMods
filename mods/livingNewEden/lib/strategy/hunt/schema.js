"use strict";

const TABLE_NAME = "world_hunt_pins";

const DDL = `
CREATE TABLE ${TABLE_NAME} (
  pin_id                 TEXT    PRIMARY KEY NOT NULL,
  idempotency_key        TEXT    NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  faction_id             INTEGER NOT NULL CHECK (faction_id > 0),
  hunter_fleet_id        TEXT    NOT NULL,
  system_id              INTEGER NOT NULL CHECK (system_id > 0),
  target_kind            TEXT    NOT NULL CHECK (target_kind IN ('fleet', 'character')),
  target_fleet_id        TEXT,
  target_character_id    INTEGER,
  target_faction_id      INTEGER,
  strike_operation_id    TEXT,
  strike_fleet_id        TEXT,
  pinned_at              INTEGER NOT NULL CHECK (pinned_at >= 0),
  until_at               INTEGER NOT NULL CHECK (until_at > pinned_at),
  pin_ms                 INTEGER NOT NULL CHECK (pin_ms >= 0),
  state                  TEXT    NOT NULL CHECK (state IN ('ACTIVE', 'CLOSED')),
  outcome                TEXT,
  closed_at              INTEGER,
  detail_json            TEXT,
  updated_at             INTEGER NOT NULL CHECK (updated_at >= 0),
  version                INTEGER NOT NULL CHECK (version >= 1),
  CHECK ((target_kind = 'fleet') = (target_fleet_id IS NOT NULL AND target_character_id IS NULL)),
  CHECK ((target_kind = 'character') = (target_character_id IS NOT NULL AND target_fleet_id IS NULL)),
  CHECK ((state = 'CLOSED') = (outcome IS NOT NULL AND closed_at IS NOT NULL))
) STRICT;

CREATE UNIQUE INDEX ${TABLE_NAME}_active_target_fleet ON ${TABLE_NAME} (target_fleet_id) WHERE state = 'ACTIVE' AND target_fleet_id IS NOT NULL;
CREATE UNIQUE INDEX ${TABLE_NAME}_active_hunter ON ${TABLE_NAME} (hunter_fleet_id) WHERE state = 'ACTIVE';
CREATE INDEX ${TABLE_NAME}_faction_state ON ${TABLE_NAME} (faction_id, state);
CREATE INDEX ${TABLE_NAME}_system_state ON ${TABLE_NAME} (system_id, state);
CREATE INDEX ${TABLE_NAME}_expiry ON ${TABLE_NAME} (state, until_at, pin_id);
CREATE INDEX ${TABLE_NAME}_closed_at ON ${TABLE_NAME} (closed_at) WHERE state = 'CLOSED';
`;

function upHuntPins(db) {
  db.exec(DDL);
}

const PIN_STATES = Object.freeze(["ACTIVE", "CLOSED"]);
const PIN_OUTCOMES = Object.freeze(["STRUCK", "ESCAPED", "BROKEN", "CANCELLED"]);
const TARGET_KINDS = Object.freeze(["fleet", "character"]);

module.exports = {
  TABLE_NAME,
  DDL,
  upHuntPins,
  PIN_STATES,
  PIN_OUTCOMES,
  TARGET_KINDS,
};