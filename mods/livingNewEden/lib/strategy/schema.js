"use strict";

const FACTIONS_TABLE_NAME = "world_factions";
const FACTION_AGGREGATE = "world_faction";
const FACTION_STATUSES = Object.freeze(["ACTIVE", "DORMANT", "ELIMINATED"]);
const INITIAL_FACTION_STATUS = "ACTIVE";
const EVENT_FACTION_CREATED = "FACTION_CREATED";
const EVENT_FACTION_CHANGED = "FACTION_CHANGED";
const MAX_STATUS_LENGTH = 32;
const MAX_DOCTRINE_ID_LENGTH = 64;
const MAX_UNITS_DDL = 1000000000000;
const MAX_FRONT_LIMIT = 16;
const MAX_KEY_LENGTH = 129;
const MAX_REASON_LENGTH = 64;
const INTEL_TABLE_NAME = "world_faction_intel";
const INTEL_AGGREGATE = "world_faction_intel";
const EVENT_INTEL_OBSERVED = "INTEL_OBSERVED";
const MAX_INTEL_STRENGTH = 1000000000000;
const MAX_INTEL_SOURCE_LENGTH = 16;
const BATTLE_INTEL_ROWS_BOUND = 5;
const EVENT_STRATEGY_INTENT = "STRATEGY_INTENT";
const MAX_UNPAID_PERIODS = 1e6;
const MAX_UPKEEP_TOTAL = 1e15;
const RECON_LOSS_TABLE_NAME = "world_faction_recon_losses";
const RECON_LOSS_AGGREGATE = "world_faction_recon_loss";
const EVENT_RECON_LOSS = "RECON_LOSS_RECORDED";
const RECON_LOSS_ROLES = Object.freeze(["scout"]);
const MAX_RECON_LOSSES = 1000;
const RECON_LOSS_ROWS_BOUND = 6;
const PLAYER_ACTIVITY_TABLE_NAME = "world_faction_player_activity";
const MAX_PLAYER_ACTIVITY_KILLS = 1000;

function upWorldFactions(db) {
  db.exec(`CREATE TABLE world_factions (
    faction_id        INTEGER PRIMARY KEY NOT NULL CHECK (faction_id > 0),
    status            TEXT    NOT NULL CHECK (length(status) BETWEEN 1 AND 32),
    home_system_id    INTEGER CHECK (home_system_id IS NULL OR home_system_id > 0),
    doctrine_id       TEXT    NOT NULL CHECK (length(doctrine_id) BETWEEN 1 AND 64),
    resource_units    INTEGER NOT NULL CHECK (resource_units BETWEEN 0 AND 1000000000000),
    reserve_units     INTEGER NOT NULL CHECK (reserve_units BETWEEN 0 AND 1000000000000),
    front_limit       INTEGER NOT NULL CHECK (front_limit BETWEEN 0 AND 16),
    registry_version  INTEGER NOT NULL CHECK (registry_version >= 1),
    last_review_at    INTEGER CHECK (last_review_at IS NULL OR last_review_at >= 0),
    created_at        INTEGER NOT NULL CHECK (created_at >= 0),
    updated_at        INTEGER NOT NULL CHECK (updated_at >= 0),
    version           INTEGER NOT NULL CHECK (version >= 1)
  ) STRICT;`);
}

function upFactionIntel(db) {
  db.exec(`CREATE TABLE world_faction_intel (
    faction_id            INTEGER NOT NULL CHECK (faction_id > 0),
    system_id             INTEGER NOT NULL CHECK (system_id > 0),
    observed_at           INTEGER NOT NULL CHECK (observed_at >= 0),
    controller_faction_id INTEGER CHECK (controller_faction_id IS NULL OR controller_faction_id > 0),
    hostile_fleets        INTEGER NOT NULL CHECK (hostile_fleets >= 0),
    hostile_ships         INTEGER NOT NULL CHECK (hostile_ships >= 0),
    hostile_strength      INTEGER NOT NULL CHECK (hostile_strength BETWEEN 0 AND 1000000000000),
    hostile_stations      INTEGER NOT NULL CHECK (hostile_stations >= 0),
    source                TEXT    NOT NULL CHECK (length(source) BETWEEN 1 AND 16),
    updated_at            INTEGER NOT NULL CHECK (updated_at >= 0),
    version               INTEGER NOT NULL CHECK (version >= 1),
    PRIMARY KEY (faction_id, system_id)
  ) STRICT, WITHOUT ROWID;`);
}

function upFactionUpkeep(db) {
  db.exec(`ALTER TABLE world_factions ADD COLUMN upkeep_paid_until INTEGER
    CHECK (upkeep_paid_until IS NULL OR upkeep_paid_until >= 0);
  ALTER TABLE world_factions ADD COLUMN upkeep_unpaid_periods INTEGER NOT NULL DEFAULT 0
    CHECK (upkeep_unpaid_periods BETWEEN 0 AND 1000 * 1000);
  ALTER TABLE world_factions ADD COLUMN income_total INTEGER NOT NULL DEFAULT 0
    CHECK (income_total BETWEEN 0 AND 1000000000000000);
  ALTER TABLE world_factions ADD COLUMN upkeep_total INTEGER NOT NULL DEFAULT 0
    CHECK (upkeep_total BETWEEN 0 AND 1000000000000000);
  ALTER TABLE world_factions ADD COLUMN upkeep_unpaid_total INTEGER NOT NULL DEFAULT 0
    CHECK (upkeep_unpaid_total BETWEEN 0 AND 1000000000000000);
  ALTER TABLE world_factions ADD COLUMN trade_funded_total INTEGER NOT NULL DEFAULT 0
    CHECK (trade_funded_total BETWEEN 0 AND 1000000000000000);`);
}

function upReconLosses(db) {
  db.exec(`CREATE TABLE world_faction_recon_losses (
    faction_id     INTEGER NOT NULL CHECK (faction_id > 0),
    system_id      INTEGER NOT NULL CHECK (system_id > 0),
    losses         INTEGER NOT NULL CHECK (losses BETWEEN 0 AND 1000),
    last_loss_at   INTEGER NOT NULL CHECK (last_loss_at >= 0),
    cooldown_until INTEGER NOT NULL CHECK (cooldown_until >= 0),
    updated_at     INTEGER NOT NULL CHECK (updated_at >= 0),
    version        INTEGER NOT NULL CHECK (version >= 1),
    PRIMARY KEY (faction_id, system_id)
  ) STRICT, WITHOUT ROWID;`);
}

function upPlayerActivity(db) {
  db.exec(`CREATE TABLE world_faction_player_activity (
    faction_id     INTEGER NOT NULL CHECK (faction_id > 0),
    system_id      INTEGER NOT NULL CHECK (system_id > 0),
    kills          INTEGER NOT NULL CHECK (kills BETWEEN 1 AND 1000),
    first_at       INTEGER NOT NULL CHECK (first_at >= 0),
    last_at        INTEGER NOT NULL CHECK (last_at >= 0),
    last_victim_id INTEGER,
    updated_at     INTEGER NOT NULL CHECK (updated_at >= 0),
    version        INTEGER NOT NULL CHECK (version >= 1),
    PRIMARY KEY (faction_id, system_id)
  ) STRICT, WITHOUT ROWID;`);
}

const ATTACK_LOSS_TABLE_NAME = "world_faction_attack_losses";
const ATTACK_LOSS_AGGREGATE = "world_faction_attack_loss";
const EVENT_ATTACK_LOSS = "ATTACK_LOSS_RECORDED";
const MAX_ATTACK_LOSSES = 1000;
const ATTACK_LOSS_OPERATION_TYPES = Object.freeze(["invasion", "raid", "gank", "reinforce", "patrol", "intercept"]);

function upAttackLosses(db) {
  db.exec(`CREATE TABLE world_faction_attack_losses (
    faction_id     INTEGER NOT NULL CHECK (faction_id > 0),
    system_id      INTEGER NOT NULL CHECK (system_id > 0),
    losses         INTEGER NOT NULL CHECK (losses BETWEEN 0 AND 1000),
    last_loss_at   INTEGER NOT NULL CHECK (last_loss_at >= 0),
    cooldown_until INTEGER NOT NULL CHECK (cooldown_until >= 0),
    updated_at     INTEGER NOT NULL CHECK (updated_at >= 0),
    version        INTEGER NOT NULL CHECK (version >= 1),
    PRIMARY KEY (faction_id, system_id)
  ) STRICT, WITHOUT ROWID;`);
}

const HALT_MEMORY_TABLE_NAME = "world_fortress_halt_memory";
const MAX_HALT_MEMORY_HALTS = 1000 * 1000;

function upFortressHaltMemory(db) {
  db.exec(`CREATE TABLE world_fortress_halt_memory (
    system_id    INTEGER NOT NULL CHECK (system_id > 0),
    faction_id   INTEGER NOT NULL CHECK (faction_id > 0),
    halts        INTEGER NOT NULL CHECK (halts BETWEEN 1 AND 1000 * 1000),
    last_halt_at INTEGER NOT NULL CHECK (last_halt_at >= 0),
    until_at     INTEGER NOT NULL CHECK (until_at >= 0),
    updated_at   INTEGER NOT NULL CHECK (updated_at >= 0),
    version      INTEGER NOT NULL CHECK (version >= 1),
    PRIMARY KEY (system_id, faction_id)
  ) STRICT, WITHOUT ROWID;`);
}

module.exports = {
  ATTACK_LOSS_TABLE_NAME,
  ATTACK_LOSS_AGGREGATE,
  EVENT_ATTACK_LOSS,
  MAX_ATTACK_LOSSES,
  ATTACK_LOSS_OPERATION_TYPES,
  upAttackLosses,
  HALT_MEMORY_TABLE_NAME,
  MAX_HALT_MEMORY_HALTS,
  upFortressHaltMemory,
  PLAYER_ACTIVITY_TABLE_NAME,
  MAX_PLAYER_ACTIVITY_KILLS,
  upPlayerActivity,
  RECON_LOSS_TABLE_NAME,
  RECON_LOSS_AGGREGATE,
  EVENT_RECON_LOSS,
  RECON_LOSS_ROLES,
  MAX_RECON_LOSSES,
  RECON_LOSS_ROWS_BOUND,
  upReconLosses,
  MAX_UNPAID_PERIODS,
  MAX_UPKEEP_TOTAL,
  upFactionUpkeep,
  INTEL_TABLE_NAME,
  INTEL_AGGREGATE,
  EVENT_INTEL_OBSERVED,
  MAX_INTEL_STRENGTH,
  MAX_INTEL_SOURCE_LENGTH,
  BATTLE_INTEL_ROWS_BOUND,
  EVENT_STRATEGY_INTENT,
  upFactionIntel,
  FACTIONS_TABLE_NAME,
  FACTION_AGGREGATE,
  FACTION_STATUSES,
  INITIAL_FACTION_STATUS,
  EVENT_FACTION_CREATED,
  EVENT_FACTION_CHANGED,
  MAX_STATUS_LENGTH,
  MAX_DOCTRINE_ID_LENGTH,
  MAX_UNITS_DDL,
  MAX_FRONT_LIMIT,
  MAX_KEY_LENGTH,
  MAX_REASON_LENGTH,
  upWorldFactions,
};
