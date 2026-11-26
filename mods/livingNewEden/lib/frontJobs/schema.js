"use strict";

const JOBS_TABLE = "world_front_jobs";
const PROGRESS_TABLE = "world_front_job_progress";
const PAYOUTS_TABLE = "world_front_job_payouts";

const DDL = `
CREATE TABLE world_front_jobs (
  job_id            TEXT    PRIMARY KEY NOT NULL CHECK (length(job_id) BETWEEN 8 AND 96),
  day               INTEGER NOT NULL CHECK (day >= 0),
  slot              INTEGER NOT NULL CHECK (slot >= 0),
  kind              TEXT    NOT NULL CHECK (length(kind) BETWEEN 1 AND 16),
  state             TEXT    NOT NULL CHECK (length(state) BETWEEN 1 AND 16),
  issuer_faction_id INTEGER NOT NULL CHECK (issuer_faction_id > 0),
  target_faction_id INTEGER CHECK (target_faction_id IS NULL OR target_faction_id > 0),
  system_id         INTEGER NOT NULL CHECK (system_id > 0),
  region_id         INTEGER,
  target_count      INTEGER NOT NULL CHECK (target_count >= 1),
  ref               TEXT,
  isk_amount        INTEGER NOT NULL CHECK (isk_amount >= 0),
  lp_amount         INTEGER NOT NULL CHECK (lp_amount >= 0),
  lp_corporation_id INTEGER,
  standing_micro    INTEGER NOT NULL CHECK (standing_micro >= 0),
  max_completions   INTEGER NOT NULL CHECK (max_completions >= 1),
  completions       INTEGER NOT NULL DEFAULT 0 CHECK (completions >= 0),
  description       TEXT    NOT NULL CHECK (length(description) BETWEEN 1 AND 120),
  created_at        INTEGER NOT NULL,
  expires_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  version           INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  UNIQUE (day, slot)
) STRICT;
CREATE INDEX world_front_jobs_open ON world_front_jobs (kind, system_id) WHERE state = 'OPEN';
CREATE INDEX world_front_jobs_expiry ON world_front_jobs (expires_at) WHERE state = 'OPEN';
CREATE INDEX world_front_jobs_created ON world_front_jobs (created_at);

CREATE TABLE world_front_job_progress (
  job_id       TEXT    NOT NULL,
  character_id INTEGER NOT NULL CHECK (character_id > 0),
  progress     INTEGER NOT NULL CHECK (progress >= 0),
  state        TEXT    NOT NULL CHECK (length(state) BETWEEN 1 AND 16),
  first_at     INTEGER NOT NULL,
  last_at      INTEGER NOT NULL,
  done_at      INTEGER,
  PRIMARY KEY (job_id, character_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX world_front_job_progress_done ON world_front_job_progress (character_id, done_at) WHERE state = 'DONE';

CREATE TABLE world_front_job_payouts (
  payout_key        TEXT    PRIMARY KEY,
  job_id            TEXT    NOT NULL,
  character_id      INTEGER NOT NULL,
  issuer_faction_id INTEGER NOT NULL,
  system_id         INTEGER NOT NULL,
  lp_corporation_id INTEGER,
  isk_amount        INTEGER NOT NULL CHECK (isk_amount >= 0),
  lp_amount         INTEGER NOT NULL CHECK (lp_amount >= 0),
  standing_micro    INTEGER NOT NULL CHECK (standing_micro >= 0),
  description       TEXT    NOT NULL,
  isk_state         TEXT    NOT NULL,
  lp_state          TEXT    NOT NULL,
  std_state         TEXT    NOT NULL,
  state             TEXT    NOT NULL,
  attempts          INTEGER NOT NULL DEFAULT 0,
  next_attempt_at   INTEGER NOT NULL,
  last_error        TEXT,
  planned_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
) STRICT;
CREATE INDEX world_front_job_payouts_due ON world_front_job_payouts (next_attempt_at) WHERE state = 'PENDING';
CREATE INDEX world_front_job_payouts_closed ON world_front_job_payouts (updated_at) WHERE state <> 'PENDING';
`;

function upFrontJobs(db) {
  db.exec(DDL);
}

const KIND = Object.freeze({ KILL: "KILL", CLEAR: "CLEAR", DELIVER: "DELIVER", SCAN: "SCAN", ESCORT: "ESCORT" });
const KINDS = Object.freeze(Object.values(KIND));
const JOB_STATE = Object.freeze({ OPEN: "OPEN", FILLED: "FILLED", EXPIRED: "EXPIRED" });
const PROGRESS_STATE = Object.freeze({ ACTIVE: "ACTIVE", DONE: "DONE" });
const LEG_STATE = Object.freeze({ PENDING: "PENDING", DONE: "DONE", SKIPPED: "SKIPPED", FAILED: "FAILED" });
const ROW_STATE = Object.freeze({ PENDING: "PENDING", PAID: "PAID", FAILED: "FAILED" });
const MAX_DESCRIPTION = 120;
const JOB_KEY_PREFIX = "fj";

const jobIdOf = (day, slot, createdAtMs) => `${JOB_KEY_PREFIX}:${day}:${slot}:${createdAtMs}`;
const payoutKeyOf = (jobId, characterId) => `${jobId}:${characterId}`;

module.exports = {
  JOBS_TABLE,
  PROGRESS_TABLE,
  PAYOUTS_TABLE,
  upFrontJobs,
  KIND,
  KINDS,
  JOB_STATE,
  PROGRESS_STATE,
  LEG_STATE,
  ROW_STATE,
  MAX_DESCRIPTION,
  JOB_KEY_PREFIX,
  jobIdOf,
  payoutKeyOf,
};
