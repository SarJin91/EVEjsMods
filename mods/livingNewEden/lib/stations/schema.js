"use strict";

const STATIONS_TABLE_NAME = "world_stations";
const STOCK_TABLE_NAME = "world_station_stock";
const STATION_AGGREGATE = "world_station";
const EVENT_STATION_CREATED = "STATION_CREATED";
const EVENT_STATION_TRANSITION = "STATION_TRANSITION";
const EVENT_STATION_STOCK_CHANGED = "STATION_STOCK_CHANGED";
const EVENT_STATION_CAPTURED = "STATION_CAPTURED";
const EVENT_STATION_PROJECTED = "STATION_PROJECTED";
const EVENT_STATION_REASSIGNED = "STATION_REASSIGNED";

const STATION_STATES = Object.freeze(["ONLINE", "ARMOR_REINFORCE", "HULL_REINFORCE", "DESTROYED", "ANCHORING"]);
const INITIAL_STATION_STATE = "ONLINE";
const ANCHORING_STATE = "ANCHORING";
const CREATE_STATES = Object.freeze(["ONLINE", "ANCHORING"]);
const DESTROYED_STATION_STATE = "DESTROYED";
const REINFORCE_STATES = Object.freeze(["ARMOR_REINFORCE", "HULL_REINFORCE"]);
const REPAIR_STATES = Object.freeze(["ONLINE"]);
const STATION_KINDS = Object.freeze(["npc", "upwell"]);
const STATION_ORIGINS = Object.freeze(["seed", "built"]);
const ITEM_KINDS = Object.freeze(["mineral", "hull", "supply", "moon", "pi"]);

const MAX_STATION_ID_LENGTH = 64;
const MAX_FAMILY_LENGTH = 32;
const MAX_NAME_LENGTH = 100;
const MAX_ITEM_KEY_LENGTH = 48;
const MAX_QUANTITY_DDL = 1000000000000;
const MAX_KEY_LENGTH = 129;
const MAX_REASON_LENGTH = 64;

function upStations(db) {
  db.exec(`CREATE TABLE world_stations (
    station_id           TEXT    PRIMARY KEY NOT NULL CHECK (length(station_id) BETWEEN 1 AND 64),
    kind                 TEXT    NOT NULL CHECK (length(kind) BETWEEN 1 AND 16),
    npc_station_id       INTEGER CHECK (npc_station_id IS NULL OR npc_station_id > 0),
    type_id              INTEGER CHECK (type_id IS NULL OR type_id > 0),
    structure_family     TEXT    CHECK (structure_family IS NULL OR length(structure_family) BETWEEN 1 AND 32),
    system_id            INTEGER NOT NULL CHECK (system_id > 0),
    owner_faction_id     INTEGER NOT NULL CHECK (owner_faction_id > 0),
    owner_corporation_id INTEGER NOT NULL CHECK (owner_corporation_id > 0),
    state                TEXT    NOT NULL CHECK (length(state) BETWEEN 1 AND 32),
    state_until_at       INTEGER CHECK (state_until_at IS NULL OR state_until_at >= 0),
    name                 TEXT    CHECK (name IS NULL OR length(name) BETWEEN 1 AND 100),
    position_json        TEXT    CHECK (position_json IS NULL OR json_valid(position_json)),
    origin               TEXT    NOT NULL CHECK (length(origin) BETWEEN 1 AND 16),
    evejs_item_id        INTEGER CHECK (evejs_item_id IS NULL OR evejs_item_id > 0),
    destroyed_at         INTEGER CHECK (destroyed_at IS NULL OR destroyed_at >= 0),
    created_at           INTEGER NOT NULL CHECK (created_at >= 0),
    updated_at           INTEGER NOT NULL CHECK (updated_at >= 0),
    version              INTEGER NOT NULL CHECK (version >= 1)
  ) STRICT;
  CREATE UNIQUE INDEX world_stations_npc ON world_stations (npc_station_id) WHERE npc_station_id IS NOT NULL;
  CREATE INDEX world_stations_system ON world_stations (system_id, station_id);
  CREATE INDEX world_stations_owner ON world_stations (owner_faction_id, state, system_id);
  CREATE TABLE world_station_stock (
    station_id  TEXT    NOT NULL REFERENCES world_stations (station_id),
    item_kind   TEXT    NOT NULL CHECK (length(item_kind) BETWEEN 1 AND 16),
    item_key    TEXT    NOT NULL CHECK (length(item_key) BETWEEN 1 AND 48),
    quantity    INTEGER NOT NULL CHECK (quantity BETWEEN 1 AND 1000000000000),
    updated_at  INTEGER NOT NULL CHECK (updated_at >= 0),
    PRIMARY KEY (station_id, item_kind, item_key)
  ) STRICT, WITHOUT ROWID;`);
}

module.exports = {
  STATIONS_TABLE_NAME,
  STOCK_TABLE_NAME,
  STATION_AGGREGATE,
  EVENT_STATION_CREATED,
  EVENT_STATION_TRANSITION,
  EVENT_STATION_STOCK_CHANGED,
  EVENT_STATION_CAPTURED,
  EVENT_STATION_PROJECTED,
  EVENT_STATION_REASSIGNED,
  STATION_STATES,
  INITIAL_STATION_STATE,
  ANCHORING_STATE,
  CREATE_STATES,
  DESTROYED_STATION_STATE,
  REINFORCE_STATES,
  REPAIR_STATES,
  STATION_KINDS,
  STATION_ORIGINS,
  ITEM_KINDS,
  MAX_STATION_ID_LENGTH,
  MAX_FAMILY_LENGTH,
  MAX_NAME_LENGTH,
  MAX_ITEM_KEY_LENGTH,
  MAX_QUANTITY_DDL,
  MAX_KEY_LENGTH,
  MAX_REASON_LENGTH,
  upStations,
};
