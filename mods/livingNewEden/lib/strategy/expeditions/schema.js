"use strict";

const TABLE_NAME = "world_wh_expeditions";

const DDL = `
CREATE TABLE world_wh_expeditions (
  expedition_id        TEXT    PRIMARY KEY NOT NULL CHECK (length(expedition_id) BETWEEN 1 AND 64),
  idempotency_key      TEXT    NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  faction_id           INTEGER NOT NULL CHECK (faction_id > 0),
  fleet_id             TEXT    NOT NULL,
  operation_id         TEXT    NOT NULL,
  return_operation_id  TEXT,
  hold_operation_id    TEXT,
  origin_system_id     INTEGER NOT NULL CHECK (origin_system_id > 0),
  system_id            INTEGER NOT NULL CHECK (system_id > 0),
  entry_pair_key       TEXT    NOT NULL CHECK (length(entry_pair_key) BETWEEN 3 AND 64),
  state                TEXT    NOT NULL CHECK (state IN ('PLANNED','ACTIVE','EVACUATING','CUT_OFF','ENDED')),
  outcome              TEXT,
  end_reason           TEXT,
  seed                 INTEGER NOT NULL CHECK (seed >= 0),
  planned_at           INTEGER NOT NULL CHECK (planned_at >= 0),
  arrive_at            INTEGER NOT NULL CHECK (arrive_at >= planned_at),
  evacuate_at          INTEGER NOT NULL CHECK (evacuate_at > arrive_at),
  active_from          INTEGER,
  presence_permille    INTEGER NOT NULL DEFAULT 0 CHECK (presence_permille BETWEEN 0 AND 1000),
  cut_off_at           INTEGER,
  decision_at          INTEGER,
  evac_seq             INTEGER NOT NULL DEFAULT 0 CHECK (evac_seq >= 0),
  step_seq             INTEGER NOT NULL DEFAULT 0 CHECK (step_seq >= 0),
  watch_round          INTEGER NOT NULL DEFAULT 0 CHECK (watch_round >= 0),
  ended_at             INTEGER,
  detail_json          TEXT    CHECK (detail_json IS NULL OR json_valid(detail_json)),
  updated_at           INTEGER NOT NULL CHECK (updated_at >= 0),
  version              INTEGER NOT NULL CHECK (version >= 1),
  CHECK ((state = 'ENDED') = (outcome IS NOT NULL AND ended_at IS NOT NULL)),
  CHECK (state <> 'CUT_OFF' OR (cut_off_at IS NOT NULL AND decision_at IS NOT NULL)),
  CHECK (state = 'ACTIVE' OR presence_permille = 0)
) STRICT;
CREATE UNIQUE INDEX world_wh_expeditions_open_system ON world_wh_expeditions (system_id)
  WHERE state IN ('PLANNED','ACTIVE');
CREATE UNIQUE INDEX world_wh_expeditions_open_fleet ON world_wh_expeditions (fleet_id)
  WHERE state <> 'ENDED';
CREATE INDEX world_wh_expeditions_faction_state ON world_wh_expeditions (faction_id, state);
CREATE INDEX world_wh_expeditions_ended_at ON world_wh_expeditions (ended_at) WHERE state = 'ENDED';
`;

function upWhExpeditions(db) {
  db.exec(DDL);
}

const EXPEDITION_STATES = Object.freeze(["PLANNED", "ACTIVE", "EVACUATING", "CUT_OFF", "ENDED"]);
const OPEN_STATES = Object.freeze(["PLANNED", "ACTIVE", "EVACUATING", "CUT_OFF"]);
const OUTCOMES = Object.freeze(["RETURNED", "CANCELLED", "LOST"]);
const END_REASONS = Object.freeze(["RETURNED", "LEFT", "DIVERTED", "CUT_BEFORE_ENTRY", "TIMEOUT", "FLEET_LOST",
  "WRITTEN_OFF"]);

const PLAN_EVENT = "WH_EXPEDITION_PLAN";
const STEP_EVENT = "WH_EXPEDITION_STEP";
const PLAN_AGGREGATE_ID = "plan";
const AGGREGATE = "wh_expedition";

const planKey = (round) => `whexp:plan:${round}`;
const expKey = (round, factionId) => `whexp:plan:${round}:f:${factionId}`;
const stepKey = (expeditionId, seq) => `whexp:step:${expeditionId}:${seq}`;
const waitKey = (expeditionId, seq, round) => `whexp:step:${expeditionId}:${seq}:w${round}`;
const recBaseKey = (expeditionId, seq) => `whexp:rec:${expeditionId}:${seq}`;

module.exports = {
  TABLE_NAME,
  DDL,
  upWhExpeditions,
  EXPEDITION_STATES,
  OPEN_STATES,
  OUTCOMES,
  END_REASONS,
  PLAN_EVENT,
  STEP_EVENT,
  PLAN_AGGREGATE_ID,
  AGGREGATE,
  planKey,
  expKey,
  stepKey,
  waitKey,
  recBaseKey,
};
