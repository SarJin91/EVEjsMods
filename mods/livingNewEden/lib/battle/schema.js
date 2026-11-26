"use strict";

const BATTLES_TABLE_NAME = "battle_records";
const PARTICIPANTS_TABLE_NAME = "battle_participants";
const LOSSES_TABLE_NAME = "battle_losses";

const BATTLE_STATES = Object.freeze(["PENDING", "CLAIMED", "RESOLVING", "LIVE", "SETTLING", "COMPLETED", "FAILED",
  "QUARANTINED"]);
const INITIAL_BATTLE_STATE = "PENDING";
const OPEN_BATTLE_STATES = Object.freeze(["PENDING", "CLAIMED", "RESOLVING", "LIVE", "SETTLING"]);
const TERMINAL_BATTLE_STATES = Object.freeze(["COMPLETED", "FAILED", "QUARANTINED"]);
const BATTLE_MODES = Object.freeze(["VIRTUAL", "LIVE_EVEJS", "EFS_TEST"]);

const ENVIRONMENTS = Object.freeze(["highsec", "lowsec", "nullsec", "wormhole", "other"]);
const BATTLE_OBJECTIVES = Object.freeze(["destroy", "defend", "delay", "capture", "escort"]);
const OUTCOMES = Object.freeze(["A_WIN", "B_WIN", "DRAW", "BOTH_RETREAT"]);
const RESOLVER_VERSIONS = Object.freeze(["internal-v1", "efs-adapter"]);
const SIDES = Object.freeze(["A", "B"]);
const CONTRACT_VERSION = 1;

const MAX_ENUM_LENGTH = 16;
const MAX_HOLD_REASON_LENGTH = 32;
const MAX_KEY_LENGTH = 200;
const MAX_CREATE_KEY_LENGTH = 150;

function upBattles(db) {
  db.exec(`CREATE TABLE battle_records (
    battle_id        TEXT    PRIMARY KEY NOT NULL CHECK (length(battle_id) BETWEEN 1 AND 64),
    idempotency_key  TEXT    NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 1 AND 200),
    system_id        INTEGER NOT NULL CHECK (system_id > 0),
    environment      TEXT    NOT NULL CHECK (length(environment) BETWEEN 1 AND 16),
    objective        TEXT    NOT NULL CHECK (length(objective) BETWEEN 1 AND 16),
    mode             TEXT    CHECK (mode IS NULL OR length(mode) BETWEEN 1 AND 16),
    state            TEXT    NOT NULL CHECK (length(state) BETWEEN 1 AND 16),
    resolver_version TEXT    NOT NULL CHECK (length(resolver_version) BETWEEN 1 AND 32),
    input_hash       TEXT    NOT NULL CHECK (length(input_hash) = 64),
    seed             INTEGER NOT NULL CHECK (seed BETWEEN 0 AND 4294967295),
    input_json       TEXT    NOT NULL CHECK (json_valid(input_json)),
    fleet_ids        TEXT    NOT NULL CHECK (json_valid(fleet_ids) AND json_type(fleet_ids) = 'array'),
    result_json      TEXT    CHECK (result_json IS NULL OR json_valid(result_json)),
    hold_reason      TEXT    CHECK (hold_reason IS NULL OR length(hold_reason) BETWEEN 1 AND 32),
    error_json       TEXT    CHECK (error_json IS NULL OR json_valid(error_json)),
    settlement_key   TEXT    UNIQUE CHECK (settlement_key IS NULL OR length(settlement_key) BETWEEN 1 AND 200),
    claim_seq        INTEGER NOT NULL CHECK (claim_seq >= 0),
    created_at       INTEGER NOT NULL CHECK (created_at >= 0),
    updated_at       INTEGER NOT NULL CHECK (updated_at >= 0),
    settled_at       INTEGER CHECK (settled_at IS NULL OR settled_at >= 0),
    version          INTEGER NOT NULL CHECK (version >= 1)
  ) STRICT;
  CREATE INDEX battle_records_state  ON battle_records (state, battle_id);
  CREATE INDEX battle_records_system ON battle_records (system_id, state);

  CREATE TABLE battle_participants (
    battle_id  TEXT    NOT NULL REFERENCES battle_records (battle_id),
    fleet_id   TEXT    NOT NULL REFERENCES virtual_fleets (fleet_id),
    side       TEXT    NOT NULL CHECK (side IN ('A','B')),
    faction_id INTEGER NOT NULL CHECK (faction_id > 0),
    PRIMARY KEY (battle_id, fleet_id)
  ) STRICT, WITHOUT ROWID;
  CREATE INDEX battle_participants_fleet ON battle_participants (fleet_id, battle_id);

  CREATE TABLE battle_losses (
    battle_id  TEXT    NOT NULL REFERENCES battle_records (battle_id),
    fleet_id   TEXT    NOT NULL REFERENCES virtual_fleets (fleet_id),
    faction_id INTEGER NOT NULL CHECK (faction_id > 0),
    hull_group TEXT    NOT NULL CHECK (length(hull_group) BETWEEN 1 AND 32),
    type_id    INTEGER NOT NULL CHECK (type_id >= 0),
    count      INTEGER NOT NULL CHECK (count >= 1),
    PRIMARY KEY (battle_id, fleet_id, hull_group, type_id)
  ) STRICT, WITHOUT ROWID;`);
}

const LIVE_MEMBERS_TABLE_NAME = "battle_live_members";
const LIVE_MEMBER_STATES = Object.freeze(["PLANNED", "SPAWNED", "DESTROYED", "RESERVE"]);
const MAX_LIVE_MEMBERS_PER_BATTLE = 256;
const MAX_PROFILE_ID_LENGTH = 64;
const GARRISON_FLEET_ID = "garrison";
const MAX_GARRISON_PROXIES = 64;

function upLiveMembers(db) {
  db.exec(`CREATE TABLE battle_live_members (
    battle_id   TEXT    NOT NULL,
    member_key  TEXT    NOT NULL,
    claim_seq   INTEGER NOT NULL,
    fleet_id    TEXT    NOT NULL,
    side        TEXT    NOT NULL,
    faction_id  INTEGER NOT NULL,
    hull_group  TEXT    NOT NULL,
    type_id     INTEGER NOT NULL,
    ordinal     INTEGER NOT NULL,
    profile_id  TEXT    NOT NULL,
    state       TEXT    NOT NULL,
    entity_id   INTEGER,
    boot_at     INTEGER,
    updated_at  INTEGER NOT NULL,
    version     INTEGER NOT NULL,
    PRIMARY KEY (battle_id, member_key)
  ) STRICT;
  CREATE UNIQUE INDEX battle_live_members_entity ON battle_live_members (boot_at, entity_id)
    WHERE entity_id IS NOT NULL;`);
}

function upBattleGrid(db) {
  db.exec(`ALTER TABLE battle_records ADD COLUMN grid_kind TEXT
    CHECK (grid_kind IS NULL OR length(grid_kind) BETWEEN 1 AND 16);
  ALTER TABLE battle_records ADD COLUMN grid_id INTEGER CHECK (grid_id IS NULL OR grid_id > 0);`);
}

function upBattleRecordsSettled(db) {
  db.exec("CREATE INDEX battle_records_settled ON battle_records (settled_at) WHERE settled_at IS NOT NULL;");
}

module.exports = {
  upBattleGrid,
  upBattleRecordsSettled,
  LIVE_MEMBERS_TABLE_NAME,
  LIVE_MEMBER_STATES,
  MAX_LIVE_MEMBERS_PER_BATTLE,
  MAX_PROFILE_ID_LENGTH,
  GARRISON_FLEET_ID,
  MAX_GARRISON_PROXIES,
  upLiveMembers,
  BATTLES_TABLE_NAME,
  PARTICIPANTS_TABLE_NAME,
  LOSSES_TABLE_NAME,
  BATTLE_STATES,
  INITIAL_BATTLE_STATE,
  OPEN_BATTLE_STATES,
  TERMINAL_BATTLE_STATES,
  BATTLE_MODES,
  ENVIRONMENTS,
  BATTLE_OBJECTIVES,
  OUTCOMES,
  RESOLVER_VERSIONS,
  SIDES,
  CONTRACT_VERSION,
  MAX_ENUM_LENGTH,
  MAX_HOLD_REASON_LENGTH,
  MAX_KEY_LENGTH,
  MAX_CREATE_KEY_LENGTH,
  upBattles,
};
