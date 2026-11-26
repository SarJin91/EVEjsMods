"use strict";

const TABLE_NAME = "world_salvage_anomalies";
const AGGREGATE = "salvage_anomaly";
const EVENT_CLAIMED = "SALVAGE_ANOMALY_CLAIMED";

const STATE = Object.freeze({
  SITE_PENDING: "SITE_PENDING",
  PLACING: "PLACING",
  PLACED: "PLACED",
  ENDING: "ENDING",
  ENDED: "ENDED",
});

const LIVE_STATES = Object.freeze([STATE.SITE_PENDING, STATE.PLACING, STATE.PLACED, STATE.ENDING]);

const END_REASON = Object.freeze({
  FIELD_GONE: "FIELD_GONE",
  SITE_GONE: "SITE_GONE",
  CLEARED: "CLEARED",
  LOOTED: "LOOTED",
});

const ANOMALY_ID_PREFIX = "salv:";
const ANOMALY_ID_HASH_CHARS = 32;
const MAX_JSON_LENGTH = 8192;
const MAX_PLAN_ROW_CHARS = 80;
const PLAN_ROWS_CAP = Math.floor(MAX_JSON_LENGTH / MAX_PLAN_ROW_CHARS);

const CLAIM_BASE_ROWS = 3;
const TAKE_ROWS_PER_FIELD = 2;

function fieldCapOf(maxFieldsPerAnomaly, maxRowsPerTransaction) {
  const byRows = Number.isSafeInteger(maxRowsPerTransaction)
    ? Math.floor((maxRowsPerTransaction - CLAIM_BASE_ROWS) / TAKE_ROWS_PER_FIELD) : maxFieldsPerAnomaly;
  return Math.max(1, Math.min(maxFieldsPerAnomaly, byRows));
}

function claimKeyOf(fieldId) {
  return `${ANOMALY_ID_PREFIX}${fieldId}:claim`;
}

function takeKeyOf(fieldId) {
  return `${ANOMALY_ID_PREFIX}${fieldId}:take`;
}

function upSalvageAnomalies(db) {
  db.exec(`CREATE TABLE world_salvage_anomalies (
    anomaly_id       TEXT    PRIMARY KEY NOT NULL CHECK (length(anomaly_id) BETWEEN 6 AND 64),
    field_id         TEXT    NOT NULL UNIQUE CHECK (length(field_id) BETWEEN 1 AND 80),
    system_id        INTEGER NOT NULL CHECK (system_id > 0),
    state            TEXT    NOT NULL CHECK (length(state) BETWEEN 1 AND 16),
    end_reason       TEXT    CHECK (end_reason IS NULL OR length(end_reason) BETWEEN 1 AND 16),
    haul_salvage     INTEGER NOT NULL CHECK (haul_salvage >= 0),
    haul_loot        INTEGER NOT NULL CHECK (haul_loot >= 0),
    seed             INTEGER NOT NULL CHECK (seed >= 0),
    plan_json        TEXT    NOT NULL CHECK (json_valid(plan_json) AND json_type(plan_json) = 'array'
                                             AND length(plan_json) <= 8192),
    placed_json      TEXT    NOT NULL DEFAULT '[]' CHECK (json_valid(placed_json)
                                             AND json_type(placed_json) = 'array' AND length(placed_json) <= 8192),
    wrecks_planned   INTEGER NOT NULL CHECK (wrecks_planned >= 0),
    wrecks_placed    INTEGER NOT NULL DEFAULT 0 CHECK (wrecks_placed >= 0),
    wrecks_remaining INTEGER NOT NULL DEFAULT 0 CHECK (wrecks_remaining >= 0),
    expires_at       INTEGER NOT NULL CHECK (expires_at >= 0),
    next_at          INTEGER NOT NULL CHECK (next_at >= 0),
    created_at       INTEGER NOT NULL CHECK (created_at >= 0),
    updated_at       INTEGER NOT NULL CHECK (updated_at >= 0),
    ended_at         INTEGER CHECK (ended_at IS NULL OR ended_at >= 0),
    version          INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1)
  ) STRICT;
  CREATE INDEX world_salvage_anomalies_due ON world_salvage_anomalies (state, next_at)
    WHERE state <> 'ENDED';
  CREATE INDEX world_salvage_anomalies_system ON world_salvage_anomalies (system_id, state);`);
}

module.exports = {
  TABLE_NAME,
  AGGREGATE,
  EVENT_CLAIMED,
  STATE,
  LIVE_STATES,
  END_REASON,
  ANOMALY_ID_PREFIX,
  ANOMALY_ID_HASH_CHARS,
  MAX_JSON_LENGTH,
  MAX_PLAN_ROW_CHARS,
  PLAN_ROWS_CAP,
  CLAIM_BASE_ROWS,
  TAKE_ROWS_PER_FIELD,
  fieldCapOf,
  claimKeyOf,
  takeKeyOf,
  upSalvageAnomalies,
};
