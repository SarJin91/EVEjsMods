"use strict";

const TABLE_NAME = "world_lowsec_camps";

const DDL = `
CREATE TABLE world_lowsec_camps (
  camp_id            TEXT    PRIMARY KEY NOT NULL CHECK (length(camp_id) BETWEEN 1 AND 64),
  idempotency_key    TEXT    NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  faction_id         INTEGER NOT NULL CHECK (faction_id > 0),
  fleet_id           TEXT    NOT NULL,
  operation_id       TEXT    NOT NULL,
  system_id          INTEGER NOT NULL CHECK (system_id > 0),
  state              TEXT    NOT NULL CHECK (state IN ('PLANNED','ACTIVE','ENDED')),
  outcome            TEXT,
  end_reason         TEXT,
  seed               INTEGER NOT NULL CHECK (seed >= 0),
  planned_at         INTEGER NOT NULL CHECK (planned_at >= 0),
  arrive_at          INTEGER NOT NULL CHECK (arrive_at >= planned_at),
  until_at           INTEGER NOT NULL CHECK (until_at > arrive_at),
  active_from        INTEGER,
  step_seq           INTEGER NOT NULL DEFAULT 0 CHECK (step_seq >= 0),
  watch_round        INTEGER NOT NULL DEFAULT 0 CHECK (watch_round >= 0),
  intercepts         INTEGER NOT NULL DEFAULT 0 CHECK (intercepts >= 0),
  last_intercept_at  INTEGER,
  ended_at           INTEGER,
  detail_json        TEXT    CHECK (detail_json IS NULL OR json_valid(detail_json)),
  updated_at         INTEGER NOT NULL CHECK (updated_at >= 0),
  version            INTEGER NOT NULL CHECK (version >= 1),
  CHECK ((state = 'ENDED') = (outcome IS NOT NULL AND ended_at IS NOT NULL)),
  CHECK ((state = 'PLANNED') = (active_from IS NULL))
) STRICT;
CREATE UNIQUE INDEX world_lowsec_camps_open_system ON world_lowsec_camps (system_id)
  WHERE state IN ('PLANNED','ACTIVE');
CREATE UNIQUE INDEX world_lowsec_camps_open_fleet ON world_lowsec_camps (fleet_id)
  WHERE state IN ('PLANNED','ACTIVE');
CREATE INDEX world_lowsec_camps_faction_state ON world_lowsec_camps (faction_id, state);
CREATE INDEX world_lowsec_camps_open_until    ON world_lowsec_camps (state, until_at, camp_id);
CREATE INDEX world_lowsec_camps_ended_at      ON world_lowsec_camps (ended_at) WHERE state = 'ENDED';
`;

function upLowsecCamps(db) {
  db.exec(DDL);
}

const CAMP_STATES = Object.freeze(["PLANNED", "ACTIVE", "ENDED"]);
const OPEN_CAMP_STATES = Object.freeze(["PLANNED", "ACTIVE"]);
const CAMP_OUTCOMES = Object.freeze(["EXPIRED", "BROKEN", "CANCELLED"]);
const END_REASONS = Object.freeze(["EXPIRED", "DESTROYED", "LEFT", "DIVERTED", "FLEET_LOST", "TIMEOUT"]);

const PLAN_EVENT = "LOWSEC_CAMP_PLAN";
const STEP_EVENT = "LOWSEC_CAMP_STEP";
const PLAN_AGGREGATE_ID = "plan";
const CAMP_AGGREGATE = "lowsec_camp";

const planKey = (round) => `lowsec:plan:${round}`;
const campKey = (round, factionId) => `lowsec:plan:${round}:f:${factionId}`;
const stepKey = (campId, seq) => `lowsec:step:${campId}:${seq}`;
const waitKey = (campId, seq, round) => `lowsec:step:${campId}:${seq}:w${round}`;
const recBaseKey = (campId, seq) => `lowsec:rec:${campId}:${seq}`;
const AMBUSH_EVENT = "LOWSEC_AMBUSH";
const ambushKey = (campId, convoyId) => `lowsec:ambush:${campId}:${convoyId}`;
const hitKey = (campId, convoyId) => `${ambushKey(campId, convoyId)}:hit`;

module.exports = {
  TABLE_NAME,
  DDL,
  upLowsecCamps,
  CAMP_STATES,
  OPEN_CAMP_STATES,
  CAMP_OUTCOMES,
  END_REASONS,
  PLAN_EVENT,
  STEP_EVENT,
  PLAN_AGGREGATE_ID,
  CAMP_AGGREGATE,
  planKey,
  campKey,
  stepKey,
  waitKey,
  recBaseKey,
  AMBUSH_EVENT,
  ambushKey,
  hitKey,
};
