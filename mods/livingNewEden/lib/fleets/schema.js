"use strict";

const FLEETS_TABLE_NAME = "virtual_fleets";
const OPERATIONS_TABLE_NAME = "world_operations";
const FLEET_INDEXES = Object.freeze({
  system: "virtual_fleets_system",
  faction: "virtual_fleets_faction",
  factionLive: "virtual_fleets_faction_live",
  state: "virtual_fleets_state",
  operation: "virtual_fleets_operation",
});
const OPERATION_INDEXES = Object.freeze({
  faction: "world_operations_faction",
  target: "world_operations_target",
  state: "world_operations_state",
});

const FLEET_STATES = Object.freeze(["IDLE", "PLANNED", "TRAVELLING", "STAGED", "ENGAGED", "RETREATING",
  "REFITTING", "DESTROYED", "MATERIALIZED"]);
const INITIAL_FLEET_STATE = "IDLE";
const DESTROYED_STATE = "DESTROYED";

const OPERATION_STATES = Object.freeze(["PLANNED", "ACTIVE", "COMPLETED", "FAILED", "CANCELLED"]);
const INITIAL_OPERATION_STATE = "PLANNED";
const TERMINAL_OPERATION_STATES = Object.freeze(["COMPLETED", "FAILED", "CANCELLED"]);
const OPEN_OPERATION_STATES = Object.freeze(["PLANNED", "ACTIVE"]);
const ORDERED_FLEET_STATES = Object.freeze(["PLANNED", "TRAVELLING", "STAGED"]);
const ASSIGNABLE_FLEET_STATES = Object.freeze(["IDLE", "STAGED"]);

const FLEET_ROLES = Object.freeze(["invasion", "garrison", "logistics", "scout", "patrol", "wormhole", "reserve",
  "mining", "hunter", "capsuleer", "mercenary"]);
const OPERATION_TYPES = Object.freeze(["invasion", "defense", "reinforce", "patrol", "recon", "logistics", "raid",
  "expedition", "mining", "return", "salvage", "intercept", "camp", "ratting", "gank", "pursuit", "blockade",
  "escort", "structure_assault", "counter", "harvest_raid"]);
const OBJECTIVES = Object.freeze(["capture", "hold", "destroy", "scout", "deliver", "patrol", "liberate", "raid",
  "mine", "expedition", "return", "salvage", "rat"]);
const HULL_GROUPS_V1 = Object.freeze(["frigate", "destroyer", "cruiser", "battlecruiser", "battleship", "logistics",
  "ewar", "tackle", "industrial", "capital"]);
const INDUSTRY_HULL_GROUPS = Object.freeze(["mining_frigate", "mining_barge", "exhumer", "porpoise", "orca",
  "rorqual", "freighter", "jump_freighter"]);
const CAPITAL_HULL_GROUPS = Object.freeze(["carrier", "dreadnought", "force_auxiliary", "supercarrier", "titan"]);
const HULL_GROUPS = Object.freeze([...HULL_GROUPS_V1, ...INDUSTRY_HULL_GROUPS, ...CAPITAL_HULL_GROUPS]);
const NO_HULL_GROUPS_TOKEN = "none";

function parseHullGroupList(text) {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  if (trimmed === NO_HULL_GROUPS_TOKEN) return [];
  const out = [];
  for (const raw of trimmed.split(",")) {
    const name = raw.trim();
    if (name === "" || !HULL_GROUPS.includes(name) || out.includes(name)) return null;
    out.push(name);
  }
  return out;
}

function parseOperationTypeList(text) {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  if (trimmed === NO_HULL_GROUPS_TOKEN) return Object.freeze([]);
  const out = [];
  for (const raw of trimmed.split(",")) {
    const name = raw.trim();
    if (name === "" || !OPERATION_TYPES.includes(name) || out.includes(name)) return null;
    out.push(name);
  }
  return Object.freeze(out);
}

function parseFleetRoleList(text) {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  if (trimmed === NO_HULL_GROUPS_TOKEN) return Object.freeze([]);
  const out = [];
  for (const raw of trimmed.split(",")) {
    const name = raw.trim();
    if (name === "" || !FLEET_ROLES.includes(name) || out.includes(name)) return null;
    out.push(name);
  }
  return Object.freeze(out);
}

const SUPPLY_MIN = 0;
const SUPPLY_MAX = 100;
const DEFAULT_SUPPLY_STATE = SUPPLY_MAX;
const MAX_ID_LENGTH = 64;
const MAX_ENUM_LENGTH = 32;

function upFleets(db) {
  db.exec(`CREATE TABLE world_operations (
    operation_id     TEXT    PRIMARY KEY NOT NULL CHECK (length(operation_id) BETWEEN 1 AND 64),
    idempotency_key  TEXT    NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 1 AND 200),
    operation_type   TEXT    NOT NULL CHECK (length(operation_type) BETWEEN 1 AND 32),
    faction_id       INTEGER NOT NULL CHECK (faction_id > 0),
    origin_system_id INTEGER NOT NULL CHECK (origin_system_id > 0),
    target_system_id INTEGER NOT NULL CHECK (target_system_id > 0),
    fleet_ids        TEXT    NOT NULL CHECK (json_valid(fleet_ids) AND json_type(fleet_ids) = 'array'),
    objective        TEXT    NOT NULL CHECK (length(objective) BETWEEN 1 AND 32),
    state            TEXT    NOT NULL CHECK (length(state) BETWEEN 1 AND 16),
    planned_at       INTEGER NOT NULL CHECK (planned_at >= 0),
    due_at           INTEGER CHECK (due_at IS NULL OR due_at >= 0),
    completed_at     INTEGER CHECK (completed_at IS NULL OR completed_at >= 0),
    seed             INTEGER NOT NULL CHECK (seed BETWEEN 0 AND 4294967295),
    result_json      TEXT    CHECK (result_json IS NULL OR json_valid(result_json)),
    updated_at       INTEGER NOT NULL CHECK (updated_at >= 0),
    version          INTEGER NOT NULL CHECK (version >= 1)
  ) STRICT;
  CREATE INDEX world_operations_faction ON world_operations (faction_id, state, operation_id);
  CREATE INDEX world_operations_target  ON world_operations (target_system_id, state);
  CREATE INDEX world_operations_state   ON world_operations (state, operation_id);

  CREATE TABLE virtual_fleets (
    fleet_id            TEXT    PRIMARY KEY NOT NULL CHECK (length(fleet_id) BETWEEN 1 AND 64),
    faction_id          INTEGER NOT NULL CHECK (faction_id > 0),
    corporation_id      INTEGER CHECK (corporation_id IS NULL OR corporation_id > 0),
    current_system_id   INTEGER NOT NULL CHECK (current_system_id > 0),
    target_system_id    INTEGER CHECK (target_system_id IS NULL OR target_system_id > 0),
    home_system_id      INTEGER CHECK (home_system_id IS NULL OR home_system_id > 0),
    route_json          TEXT    CHECK (route_json IS NULL OR json_valid(route_json)),
    route_graph_version INTEGER CHECK (route_graph_version IS NULL OR route_graph_version >= 1),
    leg_seq             INTEGER NOT NULL CHECK (leg_seq >= 0),
    fleet_role          TEXT    NOT NULL CHECK (length(fleet_role) BETWEEN 1 AND 32),
    doctrine_id         TEXT    CHECK (doctrine_id IS NULL OR length(doctrine_id) BETWEEN 1 AND 64),
    composition_json    TEXT    NOT NULL
                                CHECK (json_valid(composition_json) AND json_type(composition_json) = 'array'),
    ship_count          INTEGER NOT NULL CHECK (ship_count >= 0),
    supply_state        INTEGER NOT NULL CHECK (supply_state BETWEEN 0 AND 100),
    cargo_manifest      TEXT    CHECK (cargo_manifest IS NULL OR json_valid(cargo_manifest)),
    operation_id        TEXT    REFERENCES world_operations (operation_id),
    state               TEXT    NOT NULL CHECK (length(state) BETWEEN 1 AND 16),
    next_action_at      INTEGER CHECK (next_action_at IS NULL OR next_action_at >= 0),
    created_at          INTEGER NOT NULL CHECK (created_at >= 0),
    updated_at          INTEGER NOT NULL CHECK (updated_at >= 0),
    version             INTEGER NOT NULL CHECK (version >= 1)
  ) STRICT;
  CREATE INDEX virtual_fleets_system    ON virtual_fleets (current_system_id, fleet_id);
  CREATE INDEX virtual_fleets_faction   ON virtual_fleets (faction_id, fleet_id);
  CREATE INDEX virtual_fleets_state     ON virtual_fleets (state, fleet_id);
  CREATE INDEX virtual_fleets_operation ON virtual_fleets (operation_id) WHERE operation_id IS NOT NULL;`);
}

function upFleetsRefitPending(db) {
  db.exec(`ALTER TABLE virtual_fleets ADD COLUMN refit_pending INTEGER NOT NULL DEFAULT 0
    CHECK (refit_pending IN (0, 1));`);
}

function upWormholeTransits(db) {
  db.exec(`CREATE TABLE world_wormhole_transits (
    fleet_id       TEXT    NOT NULL,
    leg_seq        INTEGER NOT NULL CHECK (leg_seq >= 0),
    edge_index     INTEGER NOT NULL CHECK (edge_index >= 0),
    pair_key       TEXT    NOT NULL CHECK (length(pair_key) BETWEEN 3 AND 64),
    from_system_id INTEGER NOT NULL,
    to_system_id   INTEGER NOT NULL,
    cross_at       INTEGER NOT NULL,
    expires_at     INTEGER NOT NULL CHECK (expires_at >= 0),
    closed_at      INTEGER,
    PRIMARY KEY (fleet_id, leg_seq, edge_index)
  ) STRICT;
  CREATE INDEX world_wormhole_transits_pair ON world_wormhole_transits (pair_key, cross_at);
  CREATE INDEX world_wormhole_transits_cross ON world_wormhole_transits (cross_at);`);
}

function upFleetsFactionLive(db) {
  db.exec(`CREATE INDEX virtual_fleets_faction_live ON virtual_fleets (faction_id, fleet_id)
    WHERE state <> 'DESTROYED';`);
}

module.exports = {
  upFleetsFactionLive,
  upWormholeTransits,
  upFleetsRefitPending,
  FLEETS_TABLE_NAME,
  OPERATIONS_TABLE_NAME,
  FLEET_INDEXES,
  OPERATION_INDEXES,
  FLEET_STATES,
  INITIAL_FLEET_STATE,
  DESTROYED_STATE,
  OPERATION_STATES,
  INITIAL_OPERATION_STATE,
  TERMINAL_OPERATION_STATES,
  OPEN_OPERATION_STATES,
  ORDERED_FLEET_STATES,
  ASSIGNABLE_FLEET_STATES,
  FLEET_ROLES,
  OPERATION_TYPES,
  OBJECTIVES,
  HULL_GROUPS,
  HULL_GROUPS_V1,
  INDUSTRY_HULL_GROUPS,
  CAPITAL_HULL_GROUPS,
  parseHullGroupList,
  parseFleetRoleList,
  parseOperationTypeList,
  SUPPLY_MIN,
  SUPPLY_MAX,
  DEFAULT_SUPPLY_STATE,
  MAX_ID_LENGTH,
  MAX_ENUM_LENGTH,
  upFleets,
};
