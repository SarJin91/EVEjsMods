"use strict";

const BUILDS_TABLE_NAME = "world_station_builds";
const BUILD_AGGREGATE = "station_build";
const EVENT_BUILD_CREATED = "STATION_BUILD_CREATED";
const EVENT_BUILD_TRANSITION = "STATION_BUILD_TRANSITION";
const EVENT_BUILD_WAIT = "STATION_BUILD_WAIT";
const BUILD_EVENT_TYPE = "STATION_BUILD_STEP";

const SUPPLYING = "SUPPLYING";
const ANCHORING = "ANCHORING";
const COMPLETED = "COMPLETED";
const CANCELLED = "CANCELLED";
const FAILED = "FAILED";
const BUILD_STATES = Object.freeze([SUPPLYING, ANCHORING, COMPLETED, CANCELLED, FAILED]);
const OPEN_BUILD_STATES = Object.freeze([SUPPLYING, ANCHORING]);
const TERMINAL_BUILD_STATES = Object.freeze([COMPLETED, CANCELLED, FAILED]);

const STATION_ORIGIN_BUILT = "built";
const SURPLUS_REASON = "BUILD_SURPLUS";
const ONLINE_REASON = "ANCHORED";

const MAX_ID_LENGTH = 64;
const MAX_KEY_LENGTH = 200;
const MAX_KIT_ID_LENGTH = 32;
const MAX_END_REASON_LENGTH = 32;
const KEY_SUFFIX_RESERVE = 10;

const CONSTRUCTION_RECEIVE_ROWS = 7;
const DELIVER_STEP_FIXED_ROWS = 8;
const constructionReceiveRows = (kitKeys) => CONSTRUCTION_RECEIVE_ROWS + kitKeys;
const constructionDeliverRows = (kitKeys) => DELIVER_STEP_FIXED_ROWS + constructionReceiveRows(kitKeys);

const buildKey = (ik) => `${ik}:build`;
const buildDueKey = (id, phaseSeq, round) => `build:due:${id}:${phaseSeq}:${round}`;
const buildReconcileKey = (id, phaseSeq, round) => `build:rec:${id}:${phaseSeq}:${round}`;
const buildReceiveKey = (id, convoyId) => `build:${id}:recv:${convoyId}`;
const buildAnchorKey = (id) => `build:${id}:anchor`;
const buildSurplusKey = (id) => `build:${id}:surplus`;
const buildOnlineKey = (id) => `build:${id}:online`;
const buildEndKey = (id, phaseSeq) => `build:${id}:t:${phaseSeq}`;
const buildLostKey = (id, convoyId) => `build:${id}:lost:${convoyId}`;

function upStationBuilds(db) {
  db.exec(`CREATE TABLE world_station_builds (
    station_id         TEXT    PRIMARY KEY NOT NULL CHECK (length(station_id) BETWEEN 1 AND 64),
    idempotency_key    TEXT    NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 1 AND 200),
    faction_id         INTEGER NOT NULL CHECK (faction_id > 0),
    system_id          INTEGER NOT NULL CHECK (system_id > 0),
    kit_id             TEXT    NOT NULL CHECK (length(kit_id) BETWEEN 1 AND 32),
    state              TEXT    NOT NULL CHECK (length(state) BETWEEN 1 AND 16),
    phase_seq          INTEGER NOT NULL DEFAULT 0 CHECK (phase_seq >= 0),
    watch_round        INTEGER NOT NULL DEFAULT 0 CHECK (watch_round >= 0),
    required_json      TEXT    NOT NULL CHECK (json_valid(required_json) AND json_type(required_json) = 'object'),
    delivered_json     TEXT    NOT NULL DEFAULT '{}'
                               CHECK (json_valid(delivered_json) AND json_type(delivered_json) = 'object'),
    convoys_delivered  INTEGER NOT NULL DEFAULT 0 CHECK (convoys_delivered >= 0),
    convoys_lost       INTEGER NOT NULL DEFAULT 0 CHECK (convoys_lost >= 0),
    lost_units         INTEGER NOT NULL DEFAULT 0 CHECK (lost_units >= 0),
    surplus_units      INTEGER NOT NULL DEFAULT 0 CHECK (surplus_units >= 0),
    supply_deadline_at INTEGER NOT NULL CHECK (supply_deadline_at >= 0),
    anchor_started_at  INTEGER CHECK (anchor_started_at IS NULL OR anchor_started_at >= 0),
    anchor_until_at    INTEGER CHECK (anchor_until_at IS NULL OR anchor_until_at >= 0),
    ended_at           INTEGER CHECK (ended_at IS NULL OR ended_at >= 0),
    end_reason         TEXT    CHECK (end_reason IS NULL OR length(end_reason) BETWEEN 1 AND 32),
    created_at         INTEGER NOT NULL CHECK (created_at >= 0),
    updated_at         INTEGER NOT NULL CHECK (updated_at >= 0),
    version            INTEGER NOT NULL CHECK (version >= 1)
  ) STRICT;
  CREATE UNIQUE INDEX world_station_builds_open_site ON world_station_builds (faction_id, system_id)
    WHERE state IN ('SUPPLYING','ANCHORING');
  CREATE INDEX world_station_builds_faction ON world_station_builds (faction_id, state, station_id);
  CREATE INDEX world_station_builds_open ON world_station_builds (state, station_id)
    WHERE state IN ('SUPPLYING','ANCHORING');`);
}

module.exports = {
  BUILDS_TABLE_NAME,
  BUILD_AGGREGATE,
  EVENT_BUILD_CREATED,
  EVENT_BUILD_TRANSITION,
  EVENT_BUILD_WAIT,
  BUILD_EVENT_TYPE,
  SUPPLYING,
  ANCHORING,
  COMPLETED,
  CANCELLED,
  FAILED,
  BUILD_STATES,
  OPEN_BUILD_STATES,
  TERMINAL_BUILD_STATES,
  STATION_ORIGIN_BUILT,
  SURPLUS_REASON,
  ONLINE_REASON,
  MAX_ID_LENGTH,
  MAX_KEY_LENGTH,
  MAX_KIT_ID_LENGTH,
  MAX_END_REASON_LENGTH,
  KEY_SUFFIX_RESERVE,
  CONSTRUCTION_RECEIVE_ROWS,
  DELIVER_STEP_FIXED_ROWS,
  constructionReceiveRows,
  constructionDeliverRows,
  buildKey,
  buildDueKey,
  buildReconcileKey,
  buildReceiveKey,
  buildAnchorKey,
  buildSurplusKey,
  buildOnlineKey,
  buildEndKey,
  buildLostKey,
  upStationBuilds,
};
