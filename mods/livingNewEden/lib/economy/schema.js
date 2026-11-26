"use strict";

const EVENT_TYPE = "MINING_TRIP_STEP";
const TRIP_AGGREGATE = "mining_trip";
const EVENT_TRIP_CREATED = "MINING_TRIP_CREATED";
const EVENT_TRIP_TRANSITION = "MINING_TRIP_TRANSITION";
const EVENT_TRIP_WAIT = "MINING_TRIP_WAIT";
const TRIPS_TABLE_NAME = "world_mining_trips";
const TOTALS_TABLE_NAME = "world_mining_totals";

const OUTBOUND = "OUTBOUND";
const MINING = "MINING";
const RETURNING = "RETURNING";
const DELIVERED = "DELIVERED";
const ABORTED = "ABORTED";
const LOST = "LOST";
const TRIP_STATES = Object.freeze([OUTBOUND, MINING, RETURNING, DELIVERED, ABORTED, LOST]);
const OPEN_TRIP_STATES = Object.freeze([OUTBOUND, MINING, RETURNING]);
const OPEN_TRIP_STATES_SQL = "('OUTBOUND','MINING','RETURNING')";
const TERMINAL_TRIP_STATES = Object.freeze([DELIVERED, ABORTED, LOST]);
const MINING_BAD_END_STATES = Object.freeze([ABORTED, LOST]);
const MINING_BAD_END_REASONS = Object.freeze(["DIVERTED", "FLEET_DESTROYED", "NOT_IN_BELT"]);

const MINING_ROLE = "mining";
const MINING_OPERATION_TYPE = "mining";
const OBJECTIVE_MINE = "mine";
const OBJECTIVE_DELIVER = "deliver";
const MINERAL_ITEM_KIND = "mineral";
const DELIVERY_REASON = "MINING_DELIVERY";
const YIELD_SEC_CLASSES = Object.freeze(["highsec", "lowsec", "nullsec"]);

const MAX_ID_LENGTH = 64;
const MAX_KEY_LENGTH = 200;
const MAX_END_REASON_LENGTH = 32;
const MAX_TOTAL = 1e15;
const PERMILLE = 1000;
const MS_PER_HOUR = 3600000;

const ROWS_PER_DISPATCH = 14;
const ROWS_PER_LOAD = 18;
const ROWS_PER_DELIVER = 10;

const nudgeKey = (fleetId, legSeq, state) => `mining:arr:${fleetId}:${legSeq}:${state}`;
const dueKey = (tripId, phaseSeq, round) => `mining:due:${tripId}:${phaseSeq}:${round}`;
const reconcileKey = (tripId, phaseSeq, round) => `mining:rec:${tripId}:${phaseSeq}:${round}`;
const dropKey = (tripId) => `mining:drop:${tripId}`;

function upMiningTrips(db) {
  db.exec(`CREATE TABLE world_mining_trips (
    trip_id               TEXT    PRIMARY KEY NOT NULL CHECK (length(trip_id) BETWEEN 1 AND 64),
    idempotency_key       TEXT    NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 1 AND 200),
    faction_id            INTEGER NOT NULL CHECK (faction_id > 0),
    fleet_id              TEXT    NOT NULL REFERENCES virtual_fleets (fleet_id),
    outbound_operation_id TEXT    REFERENCES world_operations (operation_id),
    return_operation_id   TEXT    REFERENCES world_operations (operation_id),
    origin_system_id      INTEGER NOT NULL CHECK (origin_system_id > 0),
    belt_system_id        INTEGER NOT NULL CHECK (belt_system_id > 0),
    return_system_id      INTEGER CHECK (return_system_id IS NULL OR return_system_id > 0),
    delivered_station_id  TEXT    CHECK (delivered_station_id IS NULL OR length(delivered_station_id) BETWEEN 1 AND 64),
    state                 TEXT    NOT NULL CHECK (length(state) BETWEEN 1 AND 16),
    phase_seq             INTEGER NOT NULL DEFAULT 0 CHECK (phase_seq >= 0),
    watch_round           INTEGER NOT NULL DEFAULT 0 CHECK (watch_round >= 0),
    sec_class             TEXT    NOT NULL CHECK (length(sec_class) BETWEEN 1 AND 16),
    richness_permille     INTEGER NOT NULL CHECK (richness_permille BETWEEN 0 AND 1000),
    ships_at_load         INTEGER CHECK (ships_at_load IS NULL OR ships_at_load >= 1),
    cargo_json            TEXT    CHECK (cargo_json IS NULL OR json_type(cargo_json) = 'object'),
    delivered_json        TEXT    CHECK (delivered_json IS NULL OR json_type(delivered_json) = 'object'),
    lost_units            INTEGER NOT NULL DEFAULT 0 CHECK (lost_units >= 0),
    dispatched_at         INTEGER NOT NULL CHECK (dispatched_at >= 0),
    mining_started_at     INTEGER CHECK (mining_started_at IS NULL OR mining_started_at >= 0),
    mining_ends_at        INTEGER CHECK (mining_ends_at IS NULL OR mining_ends_at >= 0),
    loaded_at             INTEGER CHECK (loaded_at IS NULL OR loaded_at >= 0),
    ended_at              INTEGER CHECK (ended_at IS NULL OR ended_at >= 0),
    end_reason            TEXT    CHECK (end_reason IS NULL OR length(end_reason) BETWEEN 1 AND 32),
    created_at            INTEGER NOT NULL CHECK (created_at >= 0),
    updated_at            INTEGER NOT NULL CHECK (updated_at >= 0),
    version               INTEGER NOT NULL CHECK (version >= 1)
  ) STRICT;
  CREATE UNIQUE INDEX world_mining_trips_open_fleet ON world_mining_trips (fleet_id)
    WHERE state IN ${OPEN_TRIP_STATES_SQL};
  CREATE INDEX world_mining_trips_faction ON world_mining_trips (faction_id, state, trip_id);
  CREATE INDEX world_mining_trips_open_belt ON world_mining_trips (belt_system_id)
    WHERE state IN ('OUTBOUND','MINING','RETURNING');
  CREATE INDEX world_mining_trips_ended ON world_mining_trips (faction_id, ended_at) WHERE ended_at IS NOT NULL;
  CREATE TABLE world_mining_totals (
    faction_id          INTEGER PRIMARY KEY NOT NULL CHECK (faction_id > 0),
    trips_started       INTEGER NOT NULL DEFAULT 0 CHECK (trips_started BETWEEN 0 AND 1000000000000000),
    trips_delivered     INTEGER NOT NULL DEFAULT 0 CHECK (trips_delivered BETWEEN 0 AND 1000000000000000),
    trips_aborted       INTEGER NOT NULL DEFAULT 0 CHECK (trips_aborted BETWEEN 0 AND 1000000000000000),
    trips_lost          INTEGER NOT NULL DEFAULT 0 CHECK (trips_lost BETWEEN 0 AND 1000000000000000),
    ore_units           INTEGER NOT NULL DEFAULT 0 CHECK (ore_units BETWEEN 0 AND 1000000000000000),
    mineral_units       INTEGER NOT NULL DEFAULT 0 CHECK (mineral_units BETWEEN 0 AND 1000000000000000),
    lost_mineral_units  INTEGER NOT NULL DEFAULT 0 CHECK (lost_mineral_units BETWEEN 0 AND 1000000000000000),
    updated_at          INTEGER NOT NULL CHECK (updated_at >= 0),
    version             INTEGER NOT NULL CHECK (version >= 1)
  ) STRICT, WITHOUT ROWID;`);
}

const PRODUCTION_EVENT_TYPE = "PRODUCTION_JOB_COMPLETE";
const JOB_AGGREGATE = "production_job";
const EVENT_JOB_CREATED = "PRODUCTION_JOB_CREATED";
const EVENT_JOB_TRANSITION = "PRODUCTION_JOB_TRANSITION";
const EVENT_JOB_WAIT = "PRODUCTION_JOB_WAIT";
const JOBS_TABLE_NAME = "world_production_jobs";
const PRODUCTION_TOTALS_TABLE_NAME = "world_production_totals";
const JOB_ACTIVE = "ACTIVE";
const JOB_DELIVERED = "DELIVERED";
const JOB_LOST = "LOST";
const JOB_STATES = Object.freeze([JOB_ACTIVE, JOB_DELIVERED, JOB_LOST]);
const HULL_ITEM_KIND = "hull";
const PRODUCTION_REASON = "PRODUCTION";
const PRODUCTION_DELIVERY_REASON = "PRODUCTION_DELIVERY";
const MAX_RUNS = 1000;
const MAX_HULL_GROUP_LENGTH = 32;
const MAX_ITEM_KEY_LENGTH = 48;
const ROWS_PER_START = 13;
const ROWS_PER_COMPLETE = 9;

const consumeKey = (jobId) => `prod:${jobId}:consume`;
const consumeChunkKey = (jobId, i) => `prod:${jobId}:consume:${i}`;
const deliverKey = (jobId) => `prod:${jobId}:deliver`;
const jobDueKey = (jobId, round) => `prod:due:${jobId}:${round}`;
const jobReconcileKey = (jobId, round) => `prod:rec:${jobId}:${round}`;

function upProductionJobs(db) {
  db.exec(`CREATE TABLE world_production_jobs (
    job_id           TEXT    PRIMARY KEY NOT NULL CHECK (length(job_id) BETWEEN 1 AND 64),
    idempotency_key  TEXT    NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 1 AND 200),
    faction_id       INTEGER NOT NULL CHECK (faction_id > 0),
    station_id       TEXT    NOT NULL REFERENCES world_stations (station_id),
    system_id        INTEGER NOT NULL CHECK (system_id > 0),
    hull_group       TEXT    NOT NULL CHECK (length(hull_group) BETWEEN 1 AND 32),
    item_key         TEXT    NOT NULL CHECK (length(item_key) BETWEEN 1 AND 48),
    runs             INTEGER NOT NULL CHECK (runs BETWEEN 1 AND 1000),
    recipes_version  INTEGER NOT NULL CHECK (recipes_version >= 1),
    consumed_json    TEXT    NOT NULL CHECK (json_valid(consumed_json)),
    run_ms           INTEGER NOT NULL CHECK (run_ms >= 1),
    started_at       INTEGER NOT NULL CHECK (started_at >= 0),
    due_at           INTEGER NOT NULL CHECK (due_at >= 0),
    state            TEXT    NOT NULL CHECK (length(state) BETWEEN 1 AND 16),
    wait_round       INTEGER NOT NULL DEFAULT 0 CHECK (wait_round >= 0),
    ended_at         INTEGER CHECK (ended_at IS NULL OR ended_at >= 0),
    end_reason       TEXT    CHECK (end_reason IS NULL OR length(end_reason) BETWEEN 1 AND 32),
    created_at       INTEGER NOT NULL CHECK (created_at >= 0),
    updated_at       INTEGER NOT NULL CHECK (updated_at >= 0),
    version          INTEGER NOT NULL CHECK (version >= 1)
  ) STRICT;
  CREATE INDEX world_production_jobs_station_active ON world_production_jobs (station_id, job_id)
    WHERE state = 'ACTIVE';
  CREATE INDEX world_production_jobs_faction ON world_production_jobs (faction_id, state, job_id);
  CREATE INDEX world_production_jobs_ended ON world_production_jobs (faction_id, ended_at) WHERE ended_at IS NOT NULL;
  CREATE TABLE world_production_totals (
    faction_id         INTEGER PRIMARY KEY NOT NULL CHECK (faction_id > 0),
    jobs_started       INTEGER NOT NULL DEFAULT 0 CHECK (jobs_started BETWEEN 0 AND 1000000000000000),
    jobs_delivered     INTEGER NOT NULL DEFAULT 0 CHECK (jobs_delivered BETWEEN 0 AND 1000000000000000),
    jobs_lost          INTEGER NOT NULL DEFAULT 0 CHECK (jobs_lost BETWEEN 0 AND 1000000000000000),
    hulls_started      INTEGER NOT NULL DEFAULT 0 CHECK (hulls_started BETWEEN 0 AND 1000000000000000),
    hulls_delivered    INTEGER NOT NULL DEFAULT 0 CHECK (hulls_delivered BETWEEN 0 AND 1000000000000000),
    hulls_lost         INTEGER NOT NULL DEFAULT 0 CHECK (hulls_lost BETWEEN 0 AND 1000000000000000),
    minerals_consumed  INTEGER NOT NULL DEFAULT 0 CHECK (minerals_consumed BETWEEN 0 AND 1000000000000000),
    updated_at         INTEGER NOT NULL CHECK (updated_at >= 0),
    version            INTEGER NOT NULL CHECK (version >= 1)
  ) STRICT, WITHOUT ROWID;`);
}

const CONVOY_EVENT_TYPE = "CONVOY_DELIVERY";
const CONVOY_AGGREGATE = "convoy";
const EVENT_CONVOY_CREATED = "CONVOY_CREATED";
const EVENT_CONVOY_TRANSITION = "CONVOY_TRANSITION";
const EVENT_CONVOY_WAIT = "CONVOY_WAIT";
const CONVOYS_TABLE_NAME = "world_convoys";
const CONVOY_TOTALS_TABLE_NAME = "world_convoy_totals";
const CONVOY_TO_SOURCE = "TO_SOURCE";
const CONVOY_IN_TRANSIT = "IN_TRANSIT";
const CONVOY_DELIVERED = "DELIVERED";
const CONVOY_ABORTED = "ABORTED";
const CONVOY_LOST = "LOST";
const CONVOY_STATES = Object.freeze([CONVOY_TO_SOURCE, CONVOY_IN_TRANSIT, CONVOY_DELIVERED, CONVOY_ABORTED,
  CONVOY_LOST]);
const CONVOY_OPEN_STATES = Object.freeze([CONVOY_TO_SOURCE, CONVOY_IN_TRANSIT]);
const CONVOY_OPEN_STATES_SQL = "('TO_SOURCE','IN_TRANSIT')";
const CONVOY_TERMINAL_STATES = Object.freeze([CONVOY_DELIVERED, CONVOY_ABORTED, CONVOY_LOST]);
const TRIBUTE_PURPOSE = "TRIBUTE";
const CONVOY_PURPOSES = Object.freeze(["HULLS_TO_MOBILIZATION", "MINERALS_TO_FACTORY", "HULLS_TO_FRONT",
  "CONSTRUCTION", TRIBUTE_PURPOSE]);
const TRIBUTE_MARKER_EVENT = "TRIBUTE_PAID";
const TRIBUTE_MARKER_ROWS = 1;
const TRIBUTE_FORFEIT_REASONS = Object.freeze(["SAME_STATION", "DEST_INVALID", "SAME_SYSTEM", "TOO_FAR",
  "UNREACHABLE", "UNKNOWN_SYSTEM", "NO_RETREAT_TARGET"]);
const tributeMarkerKey = (factionId, bucket) => `tribute:${factionId}:${bucket}`;
const LOGISTICS_ROLE = "logistics";
const LOGISTICS_OPERATION_TYPE = "logistics";
const CONVOY_LOAD_REASON = "CONVOY_LOAD";
const CONVOY_DELIVERY_REASON = "CONVOY_DELIVERY";
const MAX_PURPOSE_LENGTH = 32;
const convoyDispatchRows = (maxCargoItems) => 18 + maxCargoItems;
const convoyStepRows = (maxCargoItems) => 20 + maxCargoItems;

const convoyOrphanKey = (fleetId, legSeq) => `convoy:orphan:${fleetId}:${legSeq}`;
const convoyDueKey = (convoyId, phaseSeq, round) => `convoy:due:${convoyId}:${phaseSeq}:${round}`;
const convoyNudgeKey = (fleetId, legSeq, state) => `convoy:arr:${fleetId}:${legSeq}:${state}`;
const convoyReconcileKey = (convoyId, phaseSeq, round) => `convoy:rec:${convoyId}:${phaseSeq}:${round}`;
const convoyLoadKey = (convoyId) => `convoy:${convoyId}:load`;
const convoyDeliverKey = (convoyId) => `convoy:${convoyId}:deliver`;

function upConvoys(db) {
  db.exec(`CREATE TABLE world_convoys (
    convoy_id            TEXT    PRIMARY KEY NOT NULL CHECK (length(convoy_id) BETWEEN 1 AND 64),
    idempotency_key      TEXT    NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 1 AND 200),
    faction_id           INTEGER NOT NULL CHECK (faction_id > 0),
    fleet_id             TEXT    NOT NULL REFERENCES virtual_fleets (fleet_id),
    operation_id         TEXT    REFERENCES world_operations (operation_id),
    purpose              TEXT    NOT NULL CHECK (length(purpose) BETWEEN 1 AND 32),
    source_station_id    TEXT    NOT NULL CHECK (length(source_station_id) BETWEEN 1 AND 64),
    source_system_id     INTEGER NOT NULL CHECK (source_system_id > 0),
    dest_station_id      TEXT    NOT NULL CHECK (length(dest_station_id) BETWEEN 1 AND 64),
    dest_system_id       INTEGER NOT NULL CHECK (dest_system_id > 0),
    delivered_station_id TEXT    CHECK (delivered_station_id IS NULL OR length(delivered_station_id) BETWEEN 1 AND 64),
    state                TEXT    NOT NULL CHECK (length(state) BETWEEN 1 AND 16),
    phase_seq            INTEGER NOT NULL DEFAULT 0 CHECK (phase_seq >= 0),
    watch_round          INTEGER NOT NULL DEFAULT 0 CHECK (watch_round >= 0),
    plan_json            TEXT    NOT NULL CHECK (json_valid(plan_json) AND json_type(plan_json) = 'object'),
    cargo_json           TEXT    CHECK (cargo_json IS NULL OR json_type(cargo_json) = 'object'),
    carriers_at_load     INTEGER CHECK (carriers_at_load IS NULL OR carriers_at_load >= 1),
    delivered_json       TEXT    CHECK (delivered_json IS NULL OR json_type(delivered_json) = 'object'),
    lost_units           INTEGER NOT NULL DEFAULT 0 CHECK (lost_units >= 0),
    cargo_volume         INTEGER NOT NULL DEFAULT 0 CHECK (cargo_volume >= 0),
    dispatched_at        INTEGER NOT NULL CHECK (dispatched_at >= 0),
    loaded_at            INTEGER CHECK (loaded_at IS NULL OR loaded_at >= 0),
    ended_at             INTEGER CHECK (ended_at IS NULL OR ended_at >= 0),
    end_reason           TEXT    CHECK (end_reason IS NULL OR length(end_reason) BETWEEN 1 AND 32),
    created_at           INTEGER NOT NULL CHECK (created_at >= 0),
    updated_at           INTEGER NOT NULL CHECK (updated_at >= 0),
    version              INTEGER NOT NULL CHECK (version >= 1)
  ) STRICT;
  CREATE UNIQUE INDEX world_convoys_open_fleet ON world_convoys (fleet_id)
    WHERE state IN ${CONVOY_OPEN_STATES_SQL};
  CREATE INDEX world_convoys_faction ON world_convoys (faction_id, state, convoy_id);
  CREATE INDEX world_convoys_open_dest ON world_convoys (dest_station_id, convoy_id)
    WHERE state IN ('TO_SOURCE','IN_TRANSIT');
  CREATE INDEX world_convoys_open_source ON world_convoys (source_station_id, convoy_id)
    WHERE state IN ('TO_SOURCE','IN_TRANSIT');
  CREATE INDEX world_convoys_ended ON world_convoys (faction_id, ended_at) WHERE ended_at IS NOT NULL;
  CREATE TABLE world_convoy_totals (
    faction_id         INTEGER PRIMARY KEY NOT NULL CHECK (faction_id > 0),
    convoys_started    INTEGER NOT NULL DEFAULT 0 CHECK (convoys_started BETWEEN 0 AND 1000000000000000),
    convoys_delivered  INTEGER NOT NULL DEFAULT 0 CHECK (convoys_delivered BETWEEN 0 AND 1000000000000000),
    convoys_aborted    INTEGER NOT NULL DEFAULT 0 CHECK (convoys_aborted BETWEEN 0 AND 1000000000000000),
    convoys_lost       INTEGER NOT NULL DEFAULT 0 CHECK (convoys_lost BETWEEN 0 AND 1000000000000000),
    units_loaded       INTEGER NOT NULL DEFAULT 0 CHECK (units_loaded BETWEEN 0 AND 1000000000000000),
    units_delivered    INTEGER NOT NULL DEFAULT 0 CHECK (units_delivered BETWEEN 0 AND 1000000000000000),
    units_lost         INTEGER NOT NULL DEFAULT 0 CHECK (units_lost BETWEEN 0 AND 1000000000000000),
    updated_at         INTEGER NOT NULL CHECK (updated_at >= 0),
    version            INTEGER NOT NULL CHECK (version >= 1)
  ) STRICT, WITHOUT ROWID;`);
}

module.exports = {
  CONVOY_EVENT_TYPE,
  CONVOY_AGGREGATE,
  EVENT_CONVOY_CREATED,
  EVENT_CONVOY_TRANSITION,
  EVENT_CONVOY_WAIT,
  CONVOYS_TABLE_NAME,
  CONVOY_TOTALS_TABLE_NAME,
  CONVOY_TO_SOURCE,
  CONVOY_IN_TRANSIT,
  CONVOY_DELIVERED,
  CONVOY_ABORTED,
  CONVOY_LOST,
  CONVOY_STATES,
  CONVOY_OPEN_STATES,
  CONVOY_OPEN_STATES_SQL,
  CONVOY_TERMINAL_STATES,
  CONVOY_PURPOSES,
  TRIBUTE_PURPOSE,
  TRIBUTE_MARKER_EVENT,
  TRIBUTE_MARKER_ROWS,
  TRIBUTE_FORFEIT_REASONS,
  tributeMarkerKey,
  LOGISTICS_ROLE,
  LOGISTICS_OPERATION_TYPE,
  CONVOY_LOAD_REASON,
  CONVOY_DELIVERY_REASON,
  MAX_PURPOSE_LENGTH,
  convoyDispatchRows,
  convoyStepRows,
  convoyOrphanKey,
  convoyDueKey,
  convoyNudgeKey,
  convoyReconcileKey,
  convoyLoadKey,
  convoyDeliverKey,
  upConvoys,
  PRODUCTION_EVENT_TYPE,
  JOB_AGGREGATE,
  EVENT_JOB_CREATED,
  EVENT_JOB_TRANSITION,
  EVENT_JOB_WAIT,
  JOBS_TABLE_NAME,
  PRODUCTION_TOTALS_TABLE_NAME,
  JOB_ACTIVE,
  JOB_DELIVERED,
  JOB_LOST,
  JOB_STATES,
  HULL_ITEM_KIND,
  PRODUCTION_REASON,
  PRODUCTION_DELIVERY_REASON,
  MAX_RUNS,
  MAX_HULL_GROUP_LENGTH,
  MAX_ITEM_KEY_LENGTH,
  ROWS_PER_START,
  ROWS_PER_COMPLETE,
  consumeKey,
  consumeChunkKey,
  deliverKey,
  jobDueKey,
  jobReconcileKey,
  upProductionJobs,
  EVENT_TYPE,
  TRIP_AGGREGATE,
  EVENT_TRIP_CREATED,
  EVENT_TRIP_TRANSITION,
  EVENT_TRIP_WAIT,
  TRIPS_TABLE_NAME,
  TOTALS_TABLE_NAME,
  OUTBOUND,
  MINING,
  RETURNING,
  DELIVERED,
  ABORTED,
  LOST,
  TRIP_STATES,
  OPEN_TRIP_STATES,
  OPEN_TRIP_STATES_SQL,
  TERMINAL_TRIP_STATES,
  MINING_BAD_END_STATES,
  MINING_BAD_END_REASONS,
  MINING_ROLE,
  MINING_OPERATION_TYPE,
  OBJECTIVE_MINE,
  OBJECTIVE_DELIVER,
  MINERAL_ITEM_KIND,
  DELIVERY_REASON,
  YIELD_SEC_CLASSES,
  MAX_ID_LENGTH,
  MAX_KEY_LENGTH,
  MAX_END_REASON_LENGTH,
  MAX_TOTAL,
  PERMILLE,
  MS_PER_HOUR,
  ROWS_PER_DISPATCH,
  ROWS_PER_LOAD,
  ROWS_PER_DELIVER,
  nudgeKey,
  dueKey,
  reconcileKey,
  dropKey,
  upMiningTrips,
};
