"use strict";

const TABLE_NAME = "world_harvest_raids";
const AGGREGATE = "harvest_raid";
const EVENT_WARNED = "HRAID_WARNED";
const EVENT_TRANSITION = "HRAID_TRANSITION";
const EVENT_SETTLED = "HRAID_SETTLED";
const CHECK_EVENT_TYPE = "HRAID_CHECK";
const STEP_EVENT_TYPE = "HRAID_STEP";
const SETTLE_EVENT_TYPE = "HRAID_SETTLE";
const OPERATION_TYPE = "harvest_raid";

const METENOX_TYPE_ID = 81826;
const MOON_MATERIAL_BAY_FLAG = 186;
const MOON_MATERIAL_GROUP = 427;
const PERMILLE = 1000;
const MAX_LOSS_PERMILLE = 500;
const SKYHOOK_TYPE_ID = 81080;
const SKYHOOK_RAID_WINDOW_MS = 3600000;
const MAX_THEFT_IDS = 8;

const KIND_METENOX = "metenox";
const KIND_SKYHOOK = "skyhook";
const TARGET_KINDS = Object.freeze([KIND_METENOX, KIND_SKYHOOK]);

const WARNED = "WARNED";
const RAIDING = "RAIDING";
const SETTLING = "SETTLING";
const SETTLED = "SETTLED";
const REPELLED = "REPELLED";
const ABORTED = "ABORTED";
const EXPIRED = "EXPIRED";
const OPEN_STATES = Object.freeze([WARNED, RAIDING, SETTLING]);
const END_STATES = Object.freeze([SETTLED, REPELLED, ABORTED, EXPIRED]);
const STATES = Object.freeze([...OPEN_STATES, ...END_STATES]);

const MAX_ID_LENGTH = 64;
const MAX_JSON_LENGTH = 8192;
const MAX_END_REASON_LENGTH = 32;

const START_ROWS = 4;
const END_ROWS = 4;

const raidIdOf = (targetKind, targetId, at) => `hr:${targetKind}:${targetId}:${at}`;
const arrivalCheckKey = (systemId, fleetId, legSeq) => `hraid:chk:${systemId}:arr:${fleetId}:${legSeq}`;
const startKey = (raidId) => `hraid:start:${raidId}`;
const stepKey = (raidId, phaseSeq, round) => `hraid:step:${raidId}:${phaseSeq}:${round}`;
const transitionKey = (raidId, phaseSeq) => `hraid:tr:${raidId}:${phaseSeq}`;
const settleKey = (raidId) => `hraid:settle:${raidId}`;

function upHarvestRaids(db) {
  db.exec(`CREATE TABLE world_harvest_raids (
    raid_id             TEXT    PRIMARY KEY NOT NULL CHECK (length(raid_id) BETWEEN 1 AND 64),
    target_kind         TEXT    NOT NULL CHECK (target_kind IN ('metenox', 'skyhook')),
    target_id           INTEGER NOT NULL CHECK (target_id > 0),
    system_id           INTEGER NOT NULL CHECK (system_id > 0),
    owner_corp_id       INTEGER NOT NULL CHECK (owner_corp_id > 0),
    attacker_faction_id INTEGER NOT NULL CHECK (attacker_faction_id > 0),
    operation_id        TEXT    CHECK (operation_id IS NULL OR length(operation_id) BETWEEN 1 AND 64),
    state               TEXT    NOT NULL CHECK (state IN ('WARNED','RAIDING','SETTLING','SETTLED','REPELLED',
                                                         'ABORTED','EXPIRED')),
    open                INTEGER NOT NULL CHECK (open IN (0, 1)),
    phase_seq           INTEGER NOT NULL DEFAULT 0 CHECK (phase_seq >= 0),
    credited_ms         INTEGER NOT NULL DEFAULT 0 CHECK (credited_ms >= 0),
    last_sample_at      INTEGER NOT NULL CHECK (last_sample_at >= 0),
    started_at          INTEGER NOT NULL CHECK (started_at >= 0),
    wall_deadline_at    INTEGER NOT NULL CHECK (wall_deadline_at >= 0),
    plan_json           TEXT    CHECK (plan_json IS NULL OR length(plan_json) <= 8192),
    loss_json           TEXT    CHECK (loss_json IS NULL OR length(loss_json) <= 8192),
    end_reason          TEXT    CHECK (end_reason IS NULL OR length(end_reason) BETWEEN 1 AND 32),
    ended_at            INTEGER CHECK (ended_at IS NULL OR ended_at >= 0),
    created_at          INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    version             INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    CHECK ((open = 1) = (state IN ('WARNED','RAIDING','SETTLING')))
  ) STRICT;
  CREATE UNIQUE INDEX world_harvest_raids_open_target ON world_harvest_raids (target_kind, target_id) WHERE open = 1;
  CREATE INDEX world_harvest_raids_target ON world_harvest_raids (target_kind, target_id, ended_at);
  CREATE INDEX world_harvest_raids_owner  ON world_harvest_raids (owner_corp_id, started_at);
  CREATE INDEX world_harvest_raids_faction ON world_harvest_raids (attacker_faction_id, open);
  CREATE INDEX world_harvest_raids_ended  ON world_harvest_raids (open, ended_at);`);
}

module.exports = {
  TABLE_NAME,
  AGGREGATE,
  EVENT_WARNED,
  EVENT_TRANSITION,
  EVENT_SETTLED,
  CHECK_EVENT_TYPE,
  STEP_EVENT_TYPE,
  SETTLE_EVENT_TYPE,
  OPERATION_TYPE,
  METENOX_TYPE_ID,
  MOON_MATERIAL_BAY_FLAG,
  MOON_MATERIAL_GROUP,
  PERMILLE,
  MAX_LOSS_PERMILLE,
  SKYHOOK_TYPE_ID,
  SKYHOOK_RAID_WINDOW_MS,
  MAX_THEFT_IDS,
  KIND_METENOX,
  KIND_SKYHOOK,
  TARGET_KINDS,
  WARNED,
  RAIDING,
  SETTLING,
  SETTLED,
  REPELLED,
  ABORTED,
  EXPIRED,
  OPEN_STATES,
  END_STATES,
  STATES,
  MAX_ID_LENGTH,
  MAX_JSON_LENGTH,
  MAX_END_REASON_LENGTH,
  START_ROWS,
  END_ROWS,
  raidIdOf,
  arrivalCheckKey,
  startKey,
  stepKey,
  transitionKey,
  settleKey,
  upHarvestRaids,
};
