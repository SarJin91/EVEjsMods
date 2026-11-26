"use strict";

const { SEC_CLASSES } = require("../graph/universeGraph");

const STATE_TABLE_NAME = "world_system_state";
const INFLUENCE_TABLE_NAME = "world_system_influence";
const INFLUENCE_FACTION_INDEX = "world_system_influence_faction";

const OCCUPATION_STATES = Object.freeze(["STABLE", "RECON", "CONTESTED", "INVASION", "OCCUPIED", "CONSOLIDATING"]);
const DEFAULT_OCCUPATION_STATE = "STABLE";
const SECURITY_CLASSES = SEC_CLASSES;

const SCORE_MIN = 0;
const SCORE_MAX = 100;
const DEFAULT_THREAT_LEVEL = 0;

function isOccupationState(value) {
  return typeof value === "string" && OCCUPATION_STATES.includes(value);
}

function isSecurityClass(value) {
  return typeof value === "string" && SECURITY_CLASSES.includes(value);
}

function upWorldState(db) {
  db.exec(`CREATE TABLE world_system_state (
    system_id               INTEGER PRIMARY KEY NOT NULL CHECK (system_id > 0),
    security_class          TEXT    NOT NULL CHECK (length(security_class) BETWEEN 1 AND 32),
    controller_faction_id   INTEGER CHECK (controller_faction_id IS NULL OR controller_faction_id > 0),
    occupation_state        TEXT    NOT NULL CHECK (length(occupation_state) BETWEEN 1 AND 32),
    threat_level            REAL    NOT NULL CHECK (threat_level BETWEEN 0 AND 100),
    last_state_change_at    INTEGER NOT NULL CHECK (last_state_change_at >= 0),
    next_strategy_review_at INTEGER CHECK (next_strategy_review_at IS NULL OR next_strategy_review_at >= 0),
    updated_at              INTEGER NOT NULL CHECK (updated_at >= 0),
    version                 INTEGER NOT NULL CHECK (version >= 1)
  ) STRICT;

  CREATE TABLE world_system_influence (
    system_id         INTEGER NOT NULL REFERENCES world_system_state (system_id),
    faction_id        INTEGER NOT NULL CHECK (faction_id > 0),
    influence_score   REAL    NOT NULL CHECK (influence_score BETWEEN 0 AND 100),
    garrison_strength INTEGER NOT NULL CHECK (garrison_strength >= 0),
    local_supply      INTEGER NOT NULL CHECK (local_supply >= 0),
    supply_capacity   INTEGER NOT NULL CHECK (supply_capacity >= 0),
    last_updated_at   INTEGER NOT NULL CHECK (last_updated_at >= 0),
    version           INTEGER NOT NULL CHECK (version >= 1),
    PRIMARY KEY (system_id, faction_id)
  ) STRICT, WITHOUT ROWID;

  CREATE INDEX world_system_influence_faction ON world_system_influence (faction_id, system_id);`);
}

module.exports = {
  STATE_TABLE_NAME,
  INFLUENCE_TABLE_NAME,
  INFLUENCE_FACTION_INDEX,
  OCCUPATION_STATES,
  DEFAULT_OCCUPATION_STATE,
  SECURITY_CLASSES,
  SCORE_MIN,
  SCORE_MAX,
  DEFAULT_THREAT_LEVEL,
  isOccupationState,
  isSecurityClass,
  upWorldState,
};
