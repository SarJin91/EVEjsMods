"use strict";

const SALVAGE_JOB_TABLE_NAME = "salvage_jobs";
const SALVAGE_JOB_AGGREGATE = "salvage_job";
const JOB_ID_PREFIX = "sj:";

const SALVAGE_JOB_OUTBOUND = "OUTBOUND";
const SALVAGE_JOB_RECOVERING = "RECOVERING";
const SALVAGE_JOB_RETURNING = "RETURNING";
const SALVAGE_JOB_DELIVERY_PENDING = "DELIVERY_PENDING";
const SALVAGE_JOB_DELIVERED = "DELIVERED";
const SALVAGE_JOB_EXHAUSTED = "EXHAUSTED";
const SALVAGE_JOB_FAILED = "FAILED";

const SALVAGE_JOB_STATES = Object.freeze([SALVAGE_JOB_OUTBOUND, SALVAGE_JOB_RECOVERING, SALVAGE_JOB_RETURNING,
  SALVAGE_JOB_DELIVERY_PENDING, SALVAGE_JOB_DELIVERED, SALVAGE_JOB_EXHAUSTED, SALVAGE_JOB_FAILED]);
const SALVAGE_ACTIVE_STATES = Object.freeze([SALVAGE_JOB_OUTBOUND, SALVAGE_JOB_RECOVERING, SALVAGE_JOB_RETURNING,
  SALVAGE_JOB_DELIVERY_PENDING]);
const SALVAGE_TERMINAL_STATES = Object.freeze([SALVAGE_JOB_DELIVERED, SALVAGE_JOB_EXHAUSTED, SALVAGE_JOB_FAILED]);

const SALVAGE_TRANSITIONS = Object.freeze({
  [SALVAGE_JOB_OUTBOUND]: Object.freeze([SALVAGE_JOB_RECOVERING, SALVAGE_JOB_EXHAUSTED]),
  [SALVAGE_JOB_RECOVERING]: Object.freeze([SALVAGE_JOB_RETURNING, SALVAGE_JOB_EXHAUSTED]),
  [SALVAGE_JOB_RETURNING]: Object.freeze([SALVAGE_JOB_DELIVERY_PENDING]),
  [SALVAGE_JOB_DELIVERY_PENDING]: Object.freeze([SALVAGE_JOB_DELIVERED, SALVAGE_JOB_FAILED]),
  [SALVAGE_JOB_DELIVERED]: Object.freeze([]),
  [SALVAGE_JOB_EXHAUSTED]: Object.freeze([]),
  [SALVAGE_JOB_FAILED]: Object.freeze([]),
});

const SALVAGE_END_REASONS = Object.freeze(["DELIVERED", "FIELD_GONE", "EMPTY", "NO_HOME", "HOME_LOST",
  "STOCK_FULL", "TOO_LATE", "REFUSED"]);

const MAX_JOB_ID_LENGTH = 84;
const MAX_FIELD_ID_LENGTH = 80;
const MAX_STATION_ID_LENGTH = 64;
const MAX_ENUM_LENGTH = 16;
const MAX_UNITS = 1000000000;

function upSalvageJobs(db) {
  db.exec(`CREATE TABLE salvage_jobs (
    job_id           TEXT    PRIMARY KEY NOT NULL CHECK (length(job_id) BETWEEN 1 AND 84),
    field_id         TEXT    NOT NULL UNIQUE REFERENCES world_wreck_fields (field_id)
                             CHECK (length(field_id) BETWEEN 1 AND 80),
    faction_id       INTEGER NOT NULL CHECK (faction_id > 0),
    system_id        INTEGER NOT NULL CHECK (system_id > 0),
    home_station_id  TEXT    CHECK (home_station_id IS NULL OR length(home_station_id) BETWEEN 1 AND 64),
    home_system_id   INTEGER CHECK (home_system_id IS NULL OR home_system_id > 0),
    jumps            INTEGER NOT NULL CHECK (jumps >= 0),
    fleet_id         TEXT    CHECK (fleet_id IS NULL OR length(fleet_id) BETWEEN 1 AND 64),
    state            TEXT    NOT NULL CHECK (length(state) BETWEEN 1 AND 16),
    end_reason       TEXT    CHECK (end_reason IS NULL OR length(end_reason) BETWEEN 1 AND 16),
    phase_seq        INTEGER NOT NULL CHECK (phase_seq >= 0),
    travel_ms        INTEGER NOT NULL CHECK (travel_ms >= 0),
    recovery_ms      INTEGER NOT NULL CHECK (recovery_ms >= 0),
    next_at          INTEGER CHECK (next_at IS NULL OR next_at >= 0),
    outbound_at      INTEGER NOT NULL CHECK (outbound_at >= 0),
    recovering_at    INTEGER CHECK (recovering_at IS NULL OR recovering_at >= 0),
    returning_at     INTEGER CHECK (returning_at IS NULL OR returning_at >= 0),
    delivery_at      INTEGER CHECK (delivery_at IS NULL OR delivery_at >= 0),
    completed_at     INTEGER CHECK (completed_at IS NULL OR completed_at >= 0),
    salvage_units    INTEGER NOT NULL DEFAULT 0 CHECK (salvage_units BETWEEN 0 AND 1000000000),
    loot_units       INTEGER NOT NULL DEFAULT 0 CHECK (loot_units BETWEEN 0 AND 1000000000),
    created_at       INTEGER NOT NULL CHECK (created_at >= 0),
    updated_at       INTEGER NOT NULL CHECK (updated_at >= 0),
    version          INTEGER NOT NULL CHECK (version >= 1)
  ) STRICT;
  CREATE INDEX salvage_jobs_state ON salvage_jobs (state, next_at, job_id);
  CREATE INDEX salvage_jobs_faction ON salvage_jobs (faction_id, state, job_id);`);
}

const jobIdOf = (fieldId) => `${JOB_ID_PREFIX}${fieldId}`;
const jobKey = (fieldId) => `salvage:${fieldId}:job`;
const phaseKey = (jobId, phaseSeq) => `salvage:${jobId}:p${phaseSeq}`;
const collectKey = (jobId) => `salvage:${jobId}:collect`;
const deliverKey = (jobId) => `salvage:${jobId}:deliver`;
const dueKey = (jobId, phaseSeq) => `salvage:${jobId}:due:${phaseSeq}`;
const reconcileKey = (jobId, phaseSeq) => `salvage:rec:${jobId}:${phaseSeq}`;
const pulseKey = (intervalMs, bucket) => `salvage:pulse:${intervalMs}:${bucket}`;

module.exports = {
  SALVAGE_JOB_TABLE_NAME,
  SALVAGE_JOB_AGGREGATE,
  JOB_ID_PREFIX,
  SALVAGE_JOB_OUTBOUND,
  SALVAGE_JOB_RECOVERING,
  SALVAGE_JOB_RETURNING,
  SALVAGE_JOB_DELIVERY_PENDING,
  SALVAGE_JOB_DELIVERED,
  SALVAGE_JOB_EXHAUSTED,
  SALVAGE_JOB_FAILED,
  SALVAGE_JOB_STATES,
  SALVAGE_ACTIVE_STATES,
  SALVAGE_TERMINAL_STATES,
  SALVAGE_TRANSITIONS,
  SALVAGE_END_REASONS,
  MAX_JOB_ID_LENGTH,
  MAX_FIELD_ID_LENGTH,
  MAX_STATION_ID_LENGTH,
  MAX_ENUM_LENGTH,
  MAX_UNITS,
  upSalvageJobs,
  jobIdOf,
  jobKey,
  phaseKey,
  collectKey,
  deliverKey,
  dueKey,
  reconcileKey,
  pulseKey,
};
