"use strict";

const EVENT_TYPE_ROLL = "INVASION_ROLL";
const EVENT_TYPE_STEP = "INVASION_STEP";

const STATE_ACTIVE = "ACTIVE";
const STATE_WITHDRAWING = "WITHDRAWING";
const STATE_ENDED = "ENDED";
const OPEN_STATES = Object.freeze([STATE_ACTIVE, STATE_WITHDRAWING]);

const END_REASON_BEACHHEAD_LOST = "BEACHHEAD_LOST";
const END_REASON_WITHDRAWN = "WITHDRAWN";
const END_REASON_WITHDRAW_TIMEOUT = "WITHDRAW_TIMEOUT";

const MAX_INVASION_ID_LENGTH = 64;
const MAX_IDEMPOTENCY_KEY_LENGTH = 129;
const MAX_PROFILE_ID_LENGTH = 64;
const MAX_FLEET_IDS_JSON_LENGTH = 2048;
const MAX_PLAN_JSON_LENGTH = 4096;
const MAX_END_REASON_LENGTH = 32;

const SPAWN_FIXED_ROWS = 11;
const FLEET_CREATE_ROWS = 2;
const STEP_FIXED_ROWS = 1;
const WITHDRAW_FIXED_ROWS = 2;
const MAX_PACKAGE_FLEETS = 8;
const spawnRollRows = (occupationRows) => SPAWN_FIXED_ROWS + FLEET_CREATE_ROWS * MAX_PACKAGE_FLEETS + occupationRows;
const EVENT_TYPE_CONDUIT_ROLL = "INVASION_CONDUIT_ROLL";
const CONDUIT_ROUND_BASE = 1000000000;
const CONDUIT_ID_PREFIX = "inv-c-";
const CONDUIT_TREASURY_ROWS = 3;
const FLEET_DISBAND_ROWS = 2;
const conduitSpawnRows = (occupationRows, poolFleets) => spawnRollRows(occupationRows) + CONDUIT_TREASURY_ROWS
  + FLEET_DISBAND_ROWS * poolFleets;
const HOLD_STATES = Object.freeze(["IDLE", "PLANNED", "STAGED", "REFITTING", "ENGAGED", "MATERIALIZED"]);

function invasionId(round) {
  return `inv-${round}`;
}

function rollKey(round) {
  return `invasion:roll:${round}`;
}

function conduitInvasionId(round) {
  return `${CONDUIT_ID_PREFIX}${round}`;
}

function conduitRollKey(round) {
  return `invasion:conduit:roll:${round}`;
}

function isConduitInvasionId(invasionId) {
  return typeof invasionId === "string" && invasionId.startsWith(CONDUIT_ID_PREFIX);
}

function spawnKey(invasionId) {
  return `invasion:${invasionId}:spawn`;
}

function fleetKey(invasionId, index) {
  return `invasion:${invasionId}:fleet:${index}`;
}

function occKey(invasionId) {
  return `invasion:${invasionId}:occ`;
}

function contactKey(systemId, invasionId) {
  return `contact:${systemId}:inv:${invasionId}`;
}

function endKey(invasionId) {
  return `invasion:${invasionId}:end`;
}

function stepKey(invasionId, seq, intervalMs, bucket) {
  return `invasion:${invasionId}:${seq}:t:${intervalMs}:${bucket}`;
}

function withdrawKey(invasionId) {
  return `invasion:${invasionId}:withdraw`;
}

function withdrawRoundKey(invasionId, round) {
  return `invasion:${invasionId}:w:${round}`;
}

function withdrawDisbandKey(invasionId, round, fleetId) {
  return `invasion:${invasionId}:w:${round}:disband:${fleetId}`;
}

function withdrawAbandonKey(invasionId, round, systemId) {
  return `invasion:${invasionId}:w:${round}:abandon:${systemId}`;
}

function withdrawEndKey(invasionId) {
  return `invasion:${invasionId}:end`;
}

function isEndReason(value) {
  return value === END_REASON_BEACHHEAD_LOST || value === END_REASON_WITHDRAWN || value === END_REASON_WITHDRAW_TIMEOUT;
}

const AGGREGATE_INVASION = "invasion";
const AGGREGATE_ROLL = "invasion_roll";

const JOURNAL_EVENT_ENDED = "INVASION_ENDED";
const JOURNAL_EVENT_WITHDRAWING = "INVASION_WITHDRAWING";
function transitionEventType(to) {
  if (to === STATE_ENDED) return JOURNAL_EVENT_ENDED;
  if (to === STATE_WITHDRAWING) return JOURNAL_EVENT_WITHDRAWING;
  return null;
}

function upInvasions(db) {
  db.exec(`CREATE TABLE world_invasions (
    invasion_id         TEXT    PRIMARY KEY NOT NULL CHECK (length(invasion_id) BETWEEN 1 AND ${MAX_INVASION_ID_LENGTH}),
    idempotency_key     TEXT    NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 1 AND ${MAX_IDEMPOTENCY_KEY_LENGTH}),
    roll_round          INTEGER NOT NULL UNIQUE CHECK (roll_round >= 0),
    faction_id          INTEGER NOT NULL CHECK (faction_id > 0),
    profile_id          TEXT    NOT NULL CHECK (length(profile_id) BETWEEN 1 AND ${MAX_PROFILE_ID_LENGTH}),
    beachhead_system_id INTEGER NOT NULL CHECK (beachhead_system_id > 0),
    capture_range_jumps INTEGER NOT NULL CHECK (capture_range_jumps BETWEEN 0 AND 40),
    state               TEXT    NOT NULL CHECK (length(state) BETWEEN 1 AND 24),
    open                INTEGER NOT NULL CHECK (open IN (0, 1)),
    step_seq            INTEGER NOT NULL CHECK (step_seq >= 0),
    withdraw_round      INTEGER NOT NULL DEFAULT 0 CHECK (withdraw_round >= 0),
    fleet_ids_json      TEXT    NOT NULL CHECK (json_valid(fleet_ids_json) AND length(fleet_ids_json) <= ${MAX_FLEET_IDS_JSON_LENGTH}),
    plan_json           TEXT    NOT NULL CHECK (json_valid(plan_json) AND length(plan_json) <= ${MAX_PLAN_JSON_LENGTH}),
    started_at          INTEGER NOT NULL CHECK (started_at >= 0),
    withdraw_at         INTEGER CHECK (withdraw_at IS NULL OR withdraw_at >= started_at),
    ended_at            INTEGER CHECK (ended_at IS NULL OR ended_at >= started_at),
    end_reason          TEXT    CHECK (end_reason IS NULL OR length(end_reason) BETWEEN 1 AND ${MAX_END_REASON_LENGTH}),
    created_at          INTEGER NOT NULL CHECK (created_at >= 0),
    updated_at          INTEGER NOT NULL CHECK (updated_at >= 0),
    version             INTEGER NOT NULL CHECK (version >= 1)
  ) STRICT;

  CREATE UNIQUE INDEX world_invasions_open_system ON world_invasions (beachhead_system_id) WHERE open = 1;
  CREATE INDEX world_invasions_faction_open ON world_invasions (faction_id, open, invasion_id);
  CREATE INDEX world_invasions_open ON world_invasions (open, invasion_id);
  CREATE INDEX world_invasions_ended ON world_invasions (ended_at) WHERE ended_at IS NOT NULL;

  CREATE TABLE world_invasion_totals (
    faction_id  INTEGER PRIMARY KEY NOT NULL CHECK (faction_id > 0),
    started     INTEGER NOT NULL CHECK (started >= 0),
    collapsed   INTEGER NOT NULL CHECK (collapsed >= 0),
    withdrawn   INTEGER NOT NULL CHECK (withdrawn >= 0),
    updated_at  INTEGER NOT NULL CHECK (updated_at >= 0),
    version     INTEGER NOT NULL CHECK (version >= 1)
  ) STRICT, WITHOUT ROWID;`);
}

module.exports = {
  EVENT_TYPE_ROLL,
  EVENT_TYPE_STEP,
  STATE_ACTIVE,
  STATE_WITHDRAWING,
  STATE_ENDED,
  OPEN_STATES,
  END_REASON_BEACHHEAD_LOST,
  END_REASON_WITHDRAWN,
  END_REASON_WITHDRAW_TIMEOUT,
  MAX_INVASION_ID_LENGTH,
  MAX_IDEMPOTENCY_KEY_LENGTH,
  MAX_PROFILE_ID_LENGTH,
  MAX_FLEET_IDS_JSON_LENGTH,
  MAX_PLAN_JSON_LENGTH,
  MAX_END_REASON_LENGTH,
  SPAWN_FIXED_ROWS,
  FLEET_CREATE_ROWS,
  STEP_FIXED_ROWS,
  WITHDRAW_FIXED_ROWS,
  MAX_PACKAGE_FLEETS,
  spawnRollRows,
  EVENT_TYPE_CONDUIT_ROLL,
  CONDUIT_ROUND_BASE,
  CONDUIT_ID_PREFIX,
  CONDUIT_TREASURY_ROWS,
  FLEET_DISBAND_ROWS,
  conduitSpawnRows,
  HOLD_STATES,
  invasionId,
  rollKey,
  conduitInvasionId,
  conduitRollKey,
  isConduitInvasionId,
  spawnKey,
  fleetKey,
  occKey,
  contactKey,
  endKey,
  stepKey,
  withdrawKey,
  withdrawRoundKey,
  withdrawDisbandKey,
  withdrawAbandonKey,
  withdrawEndKey,
  isEndReason,
  AGGREGATE_INVASION,
  AGGREGATE_ROLL,
  JOURNAL_EVENT_ENDED,
  JOURNAL_EVENT_WITHDRAWING,
  transitionEventType,
  upInvasions,
};