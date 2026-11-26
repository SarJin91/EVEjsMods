"use strict";

const WRECK_TABLE_NAME = "world_wreck_fields";
const WRECK_AGGREGATE = "wreck_field";
const WRECK_STATES = Object.freeze(["ACTIVE", "EXPIRED"]);
const WRECK_ACTIVE = "ACTIVE";
const WRECK_EXPIRED = "EXPIRED";
const END_REASONS = Object.freeze(["TTL", "EVICTED_SYSTEM", "EVICTED_GLOBAL"]);
const SOURCE_BATTLE = "battle";
const SOURCE_STRUCTURE = "structure";
const SOURCE_GANK = "gank";
const OUTCOME_GANKED = "GANKED";
const GANK_FIELD_PREFIX = "wf:hg:";
const FIELD_ID_PREFIX = "wf:";
const WRECK_ROWS_BOUND = 8;
const SETTLE_RESERVE_EXTRA = 4;
const PPM = 1000000;
const MAX_UNITS = 1000000000;
const MAX_COMPOSITION_BYTES = 16384;
const MAX_FIELD_ID_LENGTH = 80;
const MAX_BATTLE_ID_LENGTH = 64;
const MAX_ENUM_LENGTH = 16;

function upWreckFields(db) {
  db.exec(`CREATE TABLE world_wreck_fields (
    field_id               TEXT    PRIMARY KEY NOT NULL CHECK (length(field_id) BETWEEN 1 AND 80),
    battle_id              TEXT    UNIQUE REFERENCES battle_records (battle_id)
                                   CHECK (battle_id IS NULL OR length(battle_id) BETWEEN 1 AND 64),
    source                 TEXT    NOT NULL CHECK (length(source) BETWEEN 1 AND 16),
    system_id              INTEGER NOT NULL CHECK (system_id > 0),
    environment            TEXT    NOT NULL CHECK (length(environment) BETWEEN 1 AND 16),
    outcome                TEXT    CHECK (outcome IS NULL OR length(outcome) BETWEEN 1 AND 16),
    winner_faction_id      INTEGER CHECK (winner_faction_id IS NULL OR winner_faction_id > 0),
    state                  TEXT    NOT NULL CHECK (length(state) BETWEEN 1 AND 16),
    end_reason             TEXT    CHECK (end_reason IS NULL OR length(end_reason) BETWEEN 1 AND 16),
    ships_lost             INTEGER NOT NULL CHECK (ships_lost >= 1),
    composition_json       TEXT    NOT NULL CHECK (json_valid(composition_json)
                                     AND json_type(composition_json) = 'array' AND length(composition_json) <= 16384),
    salvage_units          INTEGER NOT NULL CHECK (salvage_units BETWEEN 0 AND 1000000000),
    loot_units             INTEGER NOT NULL CHECK (loot_units BETWEEN 0 AND 1000000000),
    salvaged_salvage_units INTEGER NOT NULL DEFAULT 0 CHECK (salvaged_salvage_units BETWEEN 0 AND salvage_units),
    salvaged_loot_units    INTEGER NOT NULL DEFAULT 0 CHECK (salvaged_loot_units BETWEEN 0 AND loot_units),
    decay_floor_ppm        INTEGER NOT NULL CHECK (decay_floor_ppm BETWEEN 0 AND 1000000),
    materialized_at        INTEGER CHECK (materialized_at IS NULL OR materialized_at >= 0),
    created_at             INTEGER NOT NULL CHECK (created_at >= 0),
    expires_at             INTEGER NOT NULL CHECK (expires_at > created_at),
    ended_at               INTEGER CHECK (ended_at IS NULL OR ended_at >= 0),
    updated_at             INTEGER NOT NULL CHECK (updated_at >= 0),
    version                INTEGER NOT NULL CHECK (version >= 1)
  ) STRICT;
  CREATE INDEX world_wreck_fields_system ON world_wreck_fields (state, system_id, expires_at, field_id);
  CREATE INDEX world_wreck_fields_expiry ON world_wreck_fields (state, expires_at, field_id);`);
}

module.exports = {
  WRECK_TABLE_NAME,
  WRECK_AGGREGATE,
  WRECK_STATES,
  WRECK_ACTIVE,
  WRECK_EXPIRED,
  END_REASONS,
  SOURCE_BATTLE,
  SOURCE_STRUCTURE,
  SOURCE_GANK,
  OUTCOME_GANKED,
  GANK_FIELD_PREFIX,
  FIELD_ID_PREFIX,
  WRECK_ROWS_BOUND,
  SETTLE_RESERVE_EXTRA,
  PPM,
  MAX_UNITS,
  MAX_COMPOSITION_BYTES,
  MAX_FIELD_ID_LENGTH,
  MAX_BATTLE_ID_LENGTH,
  MAX_ENUM_LENGTH,
  upWreckFields,
};
