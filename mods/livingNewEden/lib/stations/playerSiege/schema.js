"use strict";

const TABLE_NAME = "world_player_structure_sieges";
const AGGREGATE = "player_structure_siege";
const EVENT_STARTED = "PSIEGE_STARTED";
const EVENT_TRANSITION = "PSIEGE_TRANSITION";
const EVENT_WAIT = "PSIEGE_WAIT";
const CHECK_EVENT_TYPE = "PLAYER_SIEGE_CHECK";
const STEP_EVENT_TYPE = "PLAYER_SIEGE_STEP";
const SCAN_EVENT_TYPE = "PLAYER_SIEGE_SCAN";
const SCAN_AGGREGATE_ID = "player_siege";

const SHIELD_ASSAULT = "SHIELD_ASSAULT";
const ARMOR_TIMER = "ARMOR_TIMER";
const ARMOR_ASSAULT = "ARMOR_ASSAULT";
const HULL_TIMER = "HULL_TIMER";
const HULL_ASSAULT = "HULL_ASSAULT";
const DESTROYED = "DESTROYED";
const REPELLED = "REPELLED";
const HALTED = "HALTED";
const ABORTED = "ABORTED";
const OPEN_STATES = Object.freeze([SHIELD_ASSAULT, ARMOR_TIMER, ARMOR_ASSAULT, HULL_TIMER, HULL_ASSAULT]);
const END_STATES = Object.freeze([DESTROYED, REPELLED, HALTED, ABORTED]);
const STATES = Object.freeze([...OPEN_STATES, ...END_STATES]);

const V = Object.freeze({
  SHIELD_VULNERABLE: "SHIELD_VULNERABLE",
  ARMOR_REINFORCE: "ARMOR_REINFORCE",
  ARMOR_VULNERABLE: "ARMOR_VULNERABLE",
  HULL_REINFORCE: "HULL_REINFORCE",
  HULL_VULNERABLE: "HULL_VULNERABLE",
});

const STRUCTURE_FAMILY_NAMES = Object.freeze(["citadel", "engineering", "refinery", "flex", "observatory", "sov",
  "stronghold"]);

const MAX_ID_LENGTH = 64;
const MAX_KEY_LENGTH = 129;
const MAX_STATE_LENGTH = 24;
const MAX_FAMILY_LENGTH = 24;
const MAX_VENDOR_STATE_LENGTH = 32;
const MAX_END_REASON_LENGTH = 32;

const START_ROWS = 4;
const END_ROWS = 4;

const arrivalCheckKey = (systemId, fleetId, legSeq) => `psiege:chk:${systemId}:arr:${fleetId}:${legSeq}`;
const scanCheckKey = (systemId, bucket) => `psiege:chk:${systemId}:scan:${bucket}`;
const endCheckKey = (systemId, siegeId) => `psiege:chk:${systemId}:end:${siegeId}`;
const startKey = (structureId, siegeNo) => `psiege:${structureId}:${siegeNo}:start`;
const stepKey = (siegeId, phaseSeq, round) => `psiege:step:${siegeId}:${phaseSeq}:${round}`;
const scanKey = (bucket) => `psiege:scan:${bucket}`;

function upPlayerSieges(db) {
  db.exec(`CREATE TABLE world_player_structure_sieges (
    siege_id            TEXT    PRIMARY KEY NOT NULL CHECK (length(siege_id) BETWEEN 1 AND 64),
    idempotency_key     TEXT    NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 1 AND 129),
    structure_id        INTEGER NOT NULL CHECK (structure_id > 0),
    siege_no            INTEGER NOT NULL CHECK (siege_no >= 1),
    system_id           INTEGER NOT NULL CHECK (system_id > 0),
    structure_type_id   INTEGER NOT NULL CHECK (structure_type_id > 0),
    structure_family    TEXT    NOT NULL CHECK (length(structure_family) BETWEEN 1 AND 24),
    owner_corp_id       INTEGER NOT NULL CHECK (owner_corp_id > 0),
    owner_alliance_id   INTEGER CHECK (owner_alliance_id IS NULL OR owner_alliance_id > 0),
    attacker_faction_id INTEGER NOT NULL CHECK (attacker_faction_id > 0),
    state               TEXT    NOT NULL CHECK (length(state) BETWEEN 1 AND 24),
    open                INTEGER NOT NULL CHECK (open IN (0, 1)),
    phase_seq           INTEGER NOT NULL CHECK (phase_seq >= 0),
    wait_round          INTEGER NOT NULL CHECK (wait_round >= 0),
    phase_started_at    INTEGER NOT NULL CHECK (phase_started_at >= 0),
    phase_ends_at       INTEGER NOT NULL CHECK (phase_ends_at >= phase_started_at),
    vendor_state        TEXT    CHECK (vendor_state IS NULL OR length(vendor_state) BETWEEN 1 AND 32),
    vendor_ends_at      INTEGER CHECK (vendor_ends_at IS NULL OR vendor_ends_at >= 0),
    attacker_ships      INTEGER NOT NULL CHECK (attacker_ships >= 0),
    attacker_strength   INTEGER NOT NULL CHECK (attacker_strength >= 0),
    hits                INTEGER NOT NULL DEFAULT 0 CHECK (hits >= 0),
    started_at          INTEGER NOT NULL CHECK (started_at >= 0),
    ended_at            INTEGER CHECK (ended_at IS NULL OR ended_at >= 0),
    end_reason          TEXT    CHECK (end_reason IS NULL OR length(end_reason) BETWEEN 1 AND 32),
    created_at          INTEGER NOT NULL CHECK (created_at >= 0),
    updated_at          INTEGER NOT NULL CHECK (updated_at >= 0),
    version             INTEGER NOT NULL CHECK (version >= 1)
  ) STRICT;
  CREATE UNIQUE INDEX world_player_structure_sieges_open ON world_player_structure_sieges (structure_id) WHERE open = 1;
  CREATE UNIQUE INDEX world_player_structure_sieges_no ON world_player_structure_sieges (structure_id, siege_no);
  CREATE INDEX world_player_structure_sieges_attacker ON world_player_structure_sieges (attacker_faction_id, open,
    siege_id);
  CREATE INDEX world_player_structure_sieges_owner ON world_player_structure_sieges (owner_corp_id, open);
  CREATE INDEX world_player_structure_sieges_system ON world_player_structure_sieges (system_id, open);
  CREATE INDEX world_player_structure_sieges_ended ON world_player_structure_sieges (ended_at)
    WHERE ended_at IS NOT NULL;`);
}

module.exports = {
  TABLE_NAME,
  AGGREGATE,
  EVENT_STARTED,
  EVENT_TRANSITION,
  EVENT_WAIT,
  CHECK_EVENT_TYPE,
  STEP_EVENT_TYPE,
  SCAN_EVENT_TYPE,
  SCAN_AGGREGATE_ID,
  SHIELD_ASSAULT,
  ARMOR_TIMER,
  ARMOR_ASSAULT,
  HULL_TIMER,
  HULL_ASSAULT,
  DESTROYED,
  REPELLED,
  HALTED,
  ABORTED,
  OPEN_STATES,
  END_STATES,
  STATES,
  V,
  STRUCTURE_FAMILY_NAMES,
  MAX_ID_LENGTH,
  MAX_KEY_LENGTH,
  MAX_STATE_LENGTH,
  MAX_FAMILY_LENGTH,
  MAX_VENDOR_STATE_LENGTH,
  MAX_END_REASON_LENGTH,
  START_ROWS,
  END_ROWS,
  arrivalCheckKey,
  scanCheckKey,
  endCheckKey,
  startKey,
  stepKey,
  scanKey,
  upPlayerSieges,
};
