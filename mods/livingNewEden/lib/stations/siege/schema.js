"use strict";

const SIEGES_TABLE_NAME = "world_station_sieges";
const TOTALS_TABLE_NAME = "world_siege_totals";
const SIEGE_AGGREGATE = "station_siege";
const EVENT_SIEGE_STARTED = "SIEGE_STARTED";
const EVENT_SIEGE_TRANSITION = "SIEGE_TRANSITION";
const EVENT_SIEGE_WAIT = "SIEGE_WAIT";
const EVENT_SIEGE_WRECK = "SIEGE_WRECK_FIELD";
const EVENT_SIEGE_NATIVE = "SIEGE_NATIVE_DESTROYED";
const END_REASON_NATIVE = "NATIVE_DESTROYED";
const CHECK_EVENT_TYPE = "STATION_SIEGE_CHECK";
const STEP_EVENT_TYPE = "STATION_SIEGE_STEP";

const SHIELD_ASSAULT = "SHIELD_ASSAULT";
const ARMOR_TIMER = "ARMOR_TIMER";
const ARMOR_ASSAULT = "ARMOR_ASSAULT";
const HULL_TIMER = "HULL_TIMER";
const HULL_ASSAULT = "HULL_ASSAULT";
const ANCHOR_ASSAULT = "ANCHOR_ASSAULT";
const REPELLED = "REPELLED";
const DESTROYED = "DESTROYED";
const CAPTURED = "CAPTURED";
const SACKED = "SACKED";
const ABORTED = "ABORTED";
const OPEN_SIEGE_STATES = Object.freeze([SHIELD_ASSAULT, ARMOR_TIMER, ARMOR_ASSAULT, HULL_TIMER, HULL_ASSAULT,
  ANCHOR_ASSAULT]);
const END_SIEGE_STATES = Object.freeze([REPELLED, DESTROYED, CAPTURED, SACKED, ABORTED]);
const SIEGE_STATES = Object.freeze([...OPEN_SIEGE_STATES, ...END_SIEGE_STATES]);

const SIEGE_ROLES = Object.freeze(["invasion", "patrol", "garrison"]);
const HOLD_STATES = Object.freeze(["STAGED", "IDLE", "MATERIALIZED"]);
const READ_FLEET_STATES = Object.freeze(["IDLE", "PLANNED", "STAGED", "REFITTING", "ENGAGED", "MATERIALIZED"]);

const PLAN_VERSION = 1;
const MAX_ID_LENGTH = 64;
const MAX_KEY_LENGTH = 129;
const MAX_END_REASON_LENGTH = 32;
const MAX_PLAN_BYTES = 2048;
const MAX_TOTAL = 1e15;

const SIEGE_END_FIXED_ROWS = 18;
const SIEGE_START_ROWS = 6;
const SIEGE_ROWS_BOUND = 2;
const siegeEndRows = (occupationRows, stockItems) => SIEGE_END_FIXED_ROWS + occupationRows + stockItems;

const arrivalCheckKey = (systemId, fleetId, legSeq) => `siege:chk:${systemId}:arr:${fleetId}:${legSeq}`;
const endCheckKey = (systemId, siegeId) => `siege:chk:${systemId}:end:${siegeId}`;
const startKey = (stationId, siegeNo) => `siege:${stationId}:${siegeNo}:start`;
const stepKey = (siegeId, phaseSeq, round) => `siege:${siegeId}:${phaseSeq}:${round}`;
const nativeKey = (siegeId) => `siege:${siegeId}:native`;

function upSieges(db) {
  db.exec(`CREATE TABLE world_station_sieges (
    siege_id            TEXT    PRIMARY KEY NOT NULL CHECK (length(siege_id) BETWEEN 1 AND 64),
    idempotency_key     TEXT    NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 1 AND 129),
    station_id          TEXT    NOT NULL REFERENCES world_stations (station_id),
    siege_no            INTEGER NOT NULL CHECK (siege_no >= 1),
    system_id           INTEGER NOT NULL CHECK (system_id > 0),
    owner_faction_id    INTEGER NOT NULL CHECK (owner_faction_id > 0),
    attacker_faction_id INTEGER NOT NULL CHECK (attacker_faction_id > 0 AND attacker_faction_id <> owner_faction_id),
    state               TEXT    NOT NULL CHECK (length(state) BETWEEN 1 AND 24),
    open                INTEGER NOT NULL CHECK (open IN (0, 1)),
    phase_seq           INTEGER NOT NULL CHECK (phase_seq >= 0),
    wait_round          INTEGER NOT NULL CHECK (wait_round >= 0),
    phase_started_at    INTEGER NOT NULL CHECK (phase_started_at >= 0),
    phase_ends_at       INTEGER NOT NULL CHECK (phase_ends_at >= phase_started_at),
    plan_json           TEXT    NOT NULL CHECK (json_valid(plan_json) AND length(plan_json) <= 2048),
    attacker_ships      INTEGER NOT NULL CHECK (attacker_ships >= 0),
    attacker_strength   INTEGER NOT NULL CHECK (attacker_strength >= 0),
    lost_items          INTEGER NOT NULL DEFAULT 0 CHECK (lost_items >= 0),
    lost_units          INTEGER NOT NULL DEFAULT 0 CHECK (lost_units BETWEEN 0 AND 1000000000000000),
    started_at          INTEGER NOT NULL CHECK (started_at >= 0),
    ended_at            INTEGER CHECK (ended_at IS NULL OR ended_at >= 0),
    end_reason          TEXT    CHECK (end_reason IS NULL OR length(end_reason) BETWEEN 1 AND 32),
    created_at          INTEGER NOT NULL CHECK (created_at >= 0),
    updated_at          INTEGER NOT NULL CHECK (updated_at >= 0),
    version             INTEGER NOT NULL CHECK (version >= 1)
  ) STRICT;
  CREATE UNIQUE INDEX world_station_sieges_open ON world_station_sieges (station_id) WHERE open = 1;
  CREATE UNIQUE INDEX world_station_sieges_no ON world_station_sieges (station_id, siege_no);
  CREATE INDEX world_station_sieges_attacker ON world_station_sieges (attacker_faction_id, open, siege_id);
  CREATE INDEX world_station_sieges_owner ON world_station_sieges (owner_faction_id, open, siege_id);
  CREATE INDEX world_station_sieges_system ON world_station_sieges (system_id, open);
  CREATE INDEX world_station_sieges_ended ON world_station_sieges (ended_at) WHERE ended_at IS NOT NULL;
  CREATE TABLE world_siege_totals (
    faction_id        INTEGER PRIMARY KEY NOT NULL CHECK (faction_id > 0),
    started           INTEGER NOT NULL CHECK (started >= 0),
    won               INTEGER NOT NULL CHECK (won >= 0),
    repelled          INTEGER NOT NULL CHECK (repelled >= 0),
    besieged          INTEGER NOT NULL CHECK (besieged >= 0),
    defended          INTEGER NOT NULL CHECK (defended >= 0),
    lost_destroyed    INTEGER NOT NULL CHECK (lost_destroyed >= 0),
    lost_captured     INTEGER NOT NULL CHECK (lost_captured >= 0),
    sacked            INTEGER NOT NULL CHECK (sacked >= 0),
    gained_captured   INTEGER NOT NULL CHECK (gained_captured >= 0),
    stock_units_lost  INTEGER NOT NULL CHECK (stock_units_lost BETWEEN 0 AND 1000000000000000),
    updated_at        INTEGER NOT NULL CHECK (updated_at >= 0),
    version           INTEGER NOT NULL CHECK (version >= 1)
  ) STRICT, WITHOUT ROWID;`);
}

module.exports = {
  SIEGES_TABLE_NAME,
  TOTALS_TABLE_NAME,
  SIEGE_AGGREGATE,
  EVENT_SIEGE_STARTED,
  EVENT_SIEGE_TRANSITION,
  EVENT_SIEGE_WAIT,
  EVENT_SIEGE_WRECK,
  EVENT_SIEGE_NATIVE,
  END_REASON_NATIVE,
  CHECK_EVENT_TYPE,
  STEP_EVENT_TYPE,
  SHIELD_ASSAULT,
  ARMOR_TIMER,
  ARMOR_ASSAULT,
  HULL_TIMER,
  HULL_ASSAULT,
  ANCHOR_ASSAULT,
  REPELLED,
  DESTROYED,
  CAPTURED,
  SACKED,
  ABORTED,
  OPEN_SIEGE_STATES,
  END_SIEGE_STATES,
  SIEGE_STATES,
  SIEGE_ROLES,
  HOLD_STATES,
  READ_FLEET_STATES,
  PLAN_VERSION,
  MAX_ID_LENGTH,
  MAX_KEY_LENGTH,
  MAX_END_REASON_LENGTH,
  MAX_PLAN_BYTES,
  MAX_TOTAL,
  SIEGE_END_FIXED_ROWS,
  SIEGE_START_ROWS,
  SIEGE_ROWS_BOUND,
  siegeEndRows,
  arrivalCheckKey,
  endCheckKey,
  startKey,
  stepKey,
  nativeKey,
  upSieges,
};
