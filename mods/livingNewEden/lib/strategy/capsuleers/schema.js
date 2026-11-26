"use strict";

const TABLE_NAME = "world_capsuleer_corps";

const DDL_TABLE = `
CREATE TABLE world_capsuleer_corps (
  corp_slot            INTEGER PRIMARY KEY CHECK (corp_slot > 0),
  faction_id           INTEGER NOT NULL CHECK (faction_id > 0),
  name                 TEXT    NOT NULL CHECK (length(name) BETWEEN 1 AND 50),
  ticker               TEXT    NOT NULL CHECK (length(ticker) BETWEEN 2 AND 5),
  state                TEXT    NOT NULL CHECK (length(state) BETWEEN 1 AND 16),
  reason               TEXT    CHECK (reason IS NULL OR length(reason) BETWEEN 1 AND 64),
  base_system_id       INTEGER NOT NULL CHECK (base_system_id > 0),
  base_station_id      INTEGER NOT NULL CHECK (base_station_id > 0),
  base_station_corp_id INTEGER CHECK (base_station_corp_id IS NULL OR base_station_corp_id > 0),
  race_faction_id      INTEGER NOT NULL CHECK (race_faction_id > 0),
  corporation_id       INTEGER CHECK (corporation_id IS NULL OR corporation_id > 0),
  ceo_character_id     INTEGER CHECK (ceo_character_id IS NULL OR ceo_character_id > 0),
  member_ids_json      TEXT    CHECK (member_ids_json IS NULL OR json_valid(member_ids_json)),
  isk_balance          INTEGER NOT NULL CHECK (isk_balance >= 0),
  fleets_bought        INTEGER NOT NULL CHECK (fleets_bought >= 0),
  seed                 INTEGER NOT NULL CHECK (seed >= 0),
  founded_at           INTEGER NOT NULL CHECK (founded_at >= 0),
  activated_at         INTEGER CHECK (activated_at IS NULL OR activated_at >= 0),
  created_at           INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at           INTEGER NOT NULL CHECK (updated_at >= 0),
  version              INTEGER NOT NULL CHECK (version >= 1)
) STRICT`;
const DDL_BASE_INDEX = "CREATE UNIQUE INDEX world_capsuleer_corps_base ON world_capsuleer_corps (base_system_id)";
const DDL_CORP_INDEX = "CREATE UNIQUE INDEX world_capsuleer_corps_corporation ON world_capsuleer_corps "
  + "(corporation_id) WHERE corporation_id IS NOT NULL";

function upCapsuleerCorps(db) {
  db.exec(DDL_TABLE);
  db.exec(DDL_BASE_INDEX);
  db.exec(DDL_CORP_INDEX);
}

const TRIP_TABLE = "world_capsuleer_trips";
const DDL_TRIPS = `
CREATE TABLE world_capsuleer_trips (
  trip_id               TEXT    PRIMARY KEY NOT NULL CHECK (length(trip_id) BETWEEN 1 AND 64),
  idempotency_key       TEXT    NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  kind                  TEXT    NOT NULL CHECK (length(kind) BETWEEN 1 AND 8),
  corp_slot             INTEGER NOT NULL CHECK (corp_slot > 0),
  fleet_id              TEXT    NOT NULL CHECK (length(fleet_id) BETWEEN 1 AND 64),
  origin_system_id      INTEGER NOT NULL CHECK (origin_system_id > 0),
  base_system_id        INTEGER NOT NULL CHECK (base_system_id > 0),
  target_system_id      INTEGER CHECK (target_system_id IS NULL OR target_system_id > 0),
  outbound_operation_id TEXT    CHECK (outbound_operation_id IS NULL OR length(outbound_operation_id) BETWEEN 1 AND 64),
  return_operation_id   TEXT    CHECK (return_operation_id IS NULL OR length(return_operation_id) BETWEEN 1 AND 64),
  state                 TEXT    NOT NULL CHECK (length(state) BETWEEN 1 AND 16),
  phase_seq             INTEGER NOT NULL CHECK (phase_seq >= 0),
  watch_round           INTEGER NOT NULL CHECK (watch_round >= 0),
  abort_reason          TEXT    CHECK (abort_reason IS NULL OR length(abort_reason) BETWEEN 1 AND 32),
  ratting_started_at    INTEGER CHECK (ratting_started_at IS NULL OR ratting_started_at >= 0),
  ratting_ends_at       INTEGER CHECK (ratting_ends_at IS NULL OR ratting_ends_at >= 0),
  kills                 INTEGER NOT NULL CHECK (kills >= 0),
  isk_earned            INTEGER NOT NULL CHECK (isk_earned >= 0),
  dispatched_at         INTEGER NOT NULL CHECK (dispatched_at >= 0),
  ended_at              INTEGER CHECK (ended_at IS NULL OR ended_at >= 0),
  end_reason            TEXT    CHECK (end_reason IS NULL OR length(end_reason) BETWEEN 1 AND 32),
  created_at            INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at            INTEGER NOT NULL CHECK (updated_at >= 0),
  version               INTEGER NOT NULL CHECK (version >= 1)
) STRICT`;
const OPEN_TRIP_STATES_SQL = "('OUTBOUND','RATTING','RETURNING')";
const DDL_TRIPS_OPEN_FLEET = "CREATE UNIQUE INDEX world_capsuleer_trips_open_fleet ON world_capsuleer_trips "
  + `(fleet_id) WHERE state IN ${OPEN_TRIP_STATES_SQL}`;
const DDL_TRIPS_STATE = "CREATE INDEX world_capsuleer_trips_state ON world_capsuleer_trips (state, trip_id)";
const DDL_TRIPS_TARGET = "CREATE INDEX world_capsuleer_trips_target ON world_capsuleer_trips (target_system_id) "
  + "WHERE state IN ('OUTBOUND','RATTING')";
const DDL_TRIPS_ENDED = "CREATE INDEX world_capsuleer_trips_ended ON world_capsuleer_trips (ended_at, trip_id) "
  + "WHERE ended_at IS NOT NULL";

function upCapsuleerTrips(db) {
  db.exec(DDL_TRIPS);
  db.exec(DDL_TRIPS_OPEN_FLEET);
  db.exec(DDL_TRIPS_STATE);
  db.exec(DDL_TRIPS_TARGET);
  db.exec(DDL_TRIPS_ENDED);
}

const DDL_TRIPS_WAIT = "ALTER TABLE world_capsuleer_trips ADD COLUMN wait_round INTEGER NOT NULL DEFAULT 0 "
  + "CHECK (wait_round >= 0)";

function upCapsuleerTripWait(db) {
  db.exec(DDL_TRIPS_WAIT);
}

const CONTRACT_TABLE = "world_capsuleer_contracts";
const DDL_CONTRACTS = `
CREATE TABLE world_capsuleer_contracts (
  contract_id          TEXT    PRIMARY KEY NOT NULL CHECK (length(contract_id) BETWEEN 1 AND 64),
  idempotency_key      TEXT    NOT NULL UNIQUE CHECK (length(idempotency_key) BETWEEN 1 AND 200),
  corp_slot            INTEGER NOT NULL CHECK (corp_slot > 0),
  fleet_id             TEXT    NOT NULL CHECK (length(fleet_id) BETWEEN 1 AND 64),
  trip_id              TEXT    NOT NULL CHECK (length(trip_id) BETWEEN 1 AND 64),
  employer_faction_id  INTEGER NOT NULL CHECK (employer_faction_id > 0),
  enemy_faction_id     INTEGER NOT NULL CHECK (enemy_faction_id > 0),
  target_system_id     INTEGER NOT NULL CHECK (target_system_id > 0),
  kind                 TEXT    NOT NULL CHECK (length(kind) BETWEEN 1 AND 8),
  state                TEXT    NOT NULL CHECK (length(state) BETWEEN 1 AND 16),
  fee_isk              INTEGER NOT NULL CHECK (fee_isk BETWEEN 1 AND 1000000000000000),
  paid_isk             INTEGER NOT NULL CHECK (paid_isk BETWEEN 0 AND 1000000000000000),
  refunded_isk         INTEGER NOT NULL CHECK (refunded_isk BETWEEN 0 AND 1000000000000000),
  guard_ms             INTEGER NOT NULL CHECK (guard_ms > 0),
  signed_at            INTEGER NOT NULL CHECK (signed_at >= 0),
  on_station_at        INTEGER CHECK (on_station_at IS NULL OR on_station_at >= 0),
  ended_at             INTEGER CHECK (ended_at IS NULL OR ended_at >= 0),
  end_reason           TEXT    CHECK (end_reason IS NULL OR length(end_reason) BETWEEN 1 AND 32),
  created_at           INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at           INTEGER NOT NULL CHECK (updated_at >= 0),
  version              INTEGER NOT NULL CHECK (version >= 1)
) STRICT`;
const OPEN_CONTRACT_STATES_SQL = "('DISPATCHED','ON_STATION')";
const DDL_CONTRACTS_OPEN_FLEET = "CREATE UNIQUE INDEX world_capsuleer_contracts_open_fleet ON "
  + `world_capsuleer_contracts (fleet_id) WHERE state IN ${OPEN_CONTRACT_STATES_SQL}`;
const DDL_CONTRACTS_STATE = "CREATE INDEX world_capsuleer_contracts_state ON world_capsuleer_contracts "
  + "(state, contract_id)";
const DDL_CONTRACTS_EMPLOYER = "CREATE INDEX world_capsuleer_contracts_employer ON world_capsuleer_contracts "
  + "(employer_faction_id, state)";
const DDL_CONTRACTS_ENDED = "CREATE INDEX world_capsuleer_contracts_ended ON world_capsuleer_contracts "
  + "(ended_at, contract_id) WHERE ended_at IS NOT NULL";
const DDL_TRIPS_CONTRACT = "ALTER TABLE world_capsuleer_trips ADD COLUMN contract_id TEXT "
  + "CHECK (contract_id IS NULL OR length(contract_id) BETWEEN 1 AND 64)";

function upCapsuleerContracts(db) {
  db.exec(DDL_CONTRACTS);
  db.exec(DDL_CONTRACTS_OPEN_FLEET);
  db.exec(DDL_CONTRACTS_STATE);
  db.exec(DDL_CONTRACTS_EMPLOYER);
  db.exec(DDL_CONTRACTS_ENDED);
  db.exec(DDL_TRIPS_CONTRACT);
}

const DDL_TRIPS_FIELD = "ALTER TABLE world_capsuleer_trips ADD COLUMN field_id TEXT "
  + "CHECK (field_id IS NULL OR length(field_id) BETWEEN 1 AND 80)";
const DDL_TRIPS_HAUL = "ALTER TABLE world_capsuleer_trips ADD COLUMN haul_units INTEGER NOT NULL DEFAULT 0 "
  + "CHECK (haul_units BETWEEN 0 AND 1000000000)";
const DDL_TRIPS_OPEN_FIELD = "CREATE UNIQUE INDEX world_capsuleer_trips_open_field ON world_capsuleer_trips "
  + "(field_id) WHERE field_id IS NOT NULL AND state IN ('OUTBOUND','RATTING')";

function upCapsuleerTripSalvage(db) {
  db.exec(DDL_TRIPS_FIELD);
  db.exec(DDL_TRIPS_HAUL);
  db.exec(DDL_TRIPS_OPEN_FIELD);
}

const CLAIM_TABLE = "world_capsuleer_claims";
const DDL_CLAIMS = `
CREATE TABLE world_capsuleer_claims (
  claim_id     TEXT    PRIMARY KEY NOT NULL CHECK (length(claim_id) BETWEEN 1 AND 64),
  corp_slot    INTEGER NOT NULL CHECK (corp_slot > 0),
  system_id    INTEGER NOT NULL CHECK (system_id > 0),
  state        TEXT    NOT NULL CHECK (length(state) BETWEEN 1 AND 16),
  claimed_at   INTEGER NOT NULL CHECK (claimed_at >= 0),
  lost_at      INTEGER CHECK (lost_at IS NULL OR lost_at >= 0),
  lost_reason  TEXT    CHECK (lost_reason IS NULL OR length(lost_reason) BETWEEN 1 AND 32),
  created_at   INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at   INTEGER NOT NULL CHECK (updated_at >= 0),
  version      INTEGER NOT NULL CHECK (version >= 1)
) STRICT`;
const DDL_CLAIMS_HELD = "CREATE UNIQUE INDEX world_capsuleer_claims_held ON world_capsuleer_claims (system_id) "
  + "WHERE state = 'HELD'";
const DDL_CLAIMS_CORP = "CREATE INDEX world_capsuleer_claims_corp ON world_capsuleer_claims (corp_slot, state)";
const DDL_CLAIMS_LOST = "CREATE INDEX world_capsuleer_claims_lost ON world_capsuleer_claims (lost_at, claim_id) "
  + "WHERE lost_at IS NOT NULL";

function upCapsuleerClaims(db) {
  db.exec(DDL_CLAIMS);
  db.exec(DDL_CLAIMS_HELD);
  db.exec(DDL_CLAIMS_CORP);
  db.exec(DDL_CLAIMS_LOST);
}

const OUTBOUND = "OUTBOUND";
const RATTING = "RATTING";
const RETURNING = "RETURNING";
const DOCKED = "DOCKED";
const ABORTED = "ABORTED";
const LOST = "LOST";
const TRIP_STATES = Object.freeze([OUTBOUND, RATTING, RETURNING, DOCKED, ABORTED, LOST]);
const OPEN_TRIP_STATES = Object.freeze([OUTBOUND, RATTING, RETURNING]);
const TERMINAL_TRIP_STATES = Object.freeze([DOCKED, ABORTED, LOST]);
const MERC_TRIP_KIND = "merc";
const SALVAGE_TRIP_KIND = "salvage";
const TRIP_KINDS = Object.freeze(["rat", "home", MERC_TRIP_KIND, SALVAGE_TRIP_KIND]);
const SALVAGE_OPERATION_TYPE = "salvage";
const OBJECTIVE_SALVAGE = "salvage";
const MAX_FIELD_ID_LENGTH = 80;
const MAX_HAUL_UNITS = 1000000000;
const TRIP_AGGREGATE = "capsuleer_trip";
const EVENT_TRIP_CREATED = "CAPSULEER_TRIP_CREATED";
const EVENT_TRIP_TRANSITION = "CAPSULEER_TRIP_TRANSITION";
const EVENT_TRIP_STEP_DONE = "CAPSULEER_TRIP_STEP_DONE";
const EVENT_TRIP_WAIT = "CAPSULEER_TRIP_WAIT";
const STEP_EVENT = "CAPSULEER_TRIP_STEP";
const RATTING_OPERATION_TYPE = "ratting";
const OBJECTIVE_RAT = "rat";
const RETURN_OPERATION_TYPE = "return";
const OBJECTIVE_RETURN = "return";
const MAX_ID_LENGTH = 64;
const MAX_KEY_LENGTH = 200;
const MAX_REASON_LENGTH = 32;
const RECONCILE_PREFIX = "capsuleers:trip:rec:";

const CORP_STATES = Object.freeze(["FOUNDING", "ACTIVE", "REFUSED"]);

const REVIEW_EVENT = "CAPSULEER_CORP_REVIEW";
const REVIEW_AGGREGATE_ID = "review";
const CORP_AGGREGATE = "capsuleer_corp";
const EVENT_FOUNDED = "CAPSULEER_CORP_FOUNDED";
const EVENT_TRANSITION = "CAPSULEER_CORP_TRANSITION";
const EVENT_WALLET = "CAPSULEER_CORP_WALLET";

const reviewKey = (round) => `capsuleers:review:${round}`;
const foundKey = (slot) => `capsuleers:corp:${slot}:found`;
const activateKey = (slot) => `capsuleers:corp:${slot}:activate`;
const refuseKey = (slot) => `capsuleers:corp:${slot}:refuse`;
const stipendKey = (round, slot) => `capsuleers:review:${round}:corp:${slot}:stipend`;
const buyKey = (round, slot) => `capsuleers:review:${round}:corp:${slot}:buy`;
const dispatchKey = (round, fleetId) => `capsuleers:review:${round}:fleet:${fleetId}:dispatch`;
const stepKey = (tripId, phaseSeq, round) => `capsuleers:trip:${tripId}:${phaseSeq}:${round}`;
const nudgeKey = (fleetId, legSeq, state) => `capsuleers:trip:nudge:${fleetId}:${legSeq}:${state}`;
const reconcileKey = (tripId, phaseSeq, round) => `${RECONCILE_PREFIX}${tripId}:${phaseSeq}:${round}`;
const sweepKey = (round, fleetId) => `capsuleers:review:${round}:fleet:${fleetId}:sweep`;
const membersKey = (round, slot) => `capsuleers:review:${round}:corp:${slot}:members`;
const EVENT_CORP_MEMBERS = "CAPSULEER_CORP_MEMBERS";
const hireKey = (round, fleetId) => `capsuleers:review:${round}:fleet:${fleetId}:hire`;
const contractCloseKey = (round, contractId) => `capsuleers:review:${round}:contract:${contractId}:close`;
const EVENT_CORP_HIRE = "CAPSULEER_CORP_HIRE";
const CONTRACT_AGGREGATE = "capsuleer_contract";
const EVENT_CONTRACT_CREATED = "CAPSULEER_CONTRACT_CREATED";
const EVENT_CONTRACT_TRANSITION = "CAPSULEER_CONTRACT_TRANSITION";
const claimKey = (round, slot) => `capsuleers:review:${round}:corp:${slot}:claim`;
const claimLoseKey = (round, claimId) => `capsuleers:review:${round}:claim:${claimId}:lose`;
const claimIdOf = (slot, systemId, round) => `cl:${slot}:${systemId}:${round}`;
const CLAIM_AGGREGATE = "capsuleer_claim";
const EVENT_CLAIM_CREATED = "CAPSULEER_CLAIM_CREATED";
const EVENT_CLAIM_LOST = "CAPSULEER_CLAIM_LOST";

module.exports = {
  CLAIM_TABLE,
  upCapsuleerClaims,
  claimKey,
  claimLoseKey,
  claimIdOf,
  CLAIM_AGGREGATE,
  EVENT_CLAIM_CREATED,
  EVENT_CLAIM_LOST,
  upCapsuleerTripSalvage,
  SALVAGE_TRIP_KIND,
  SALVAGE_OPERATION_TYPE,
  OBJECTIVE_SALVAGE,
  MAX_FIELD_ID_LENGTH,
  MAX_HAUL_UNITS,
  CONTRACT_TABLE,
  upCapsuleerContracts,
  MERC_TRIP_KIND,
  hireKey,
  contractCloseKey,
  EVENT_CORP_HIRE,
  CONTRACT_AGGREGATE,
  EVENT_CONTRACT_CREATED,
  EVENT_CONTRACT_TRANSITION,
  TABLE_NAME,
  upCapsuleerCorps,
  TRIP_TABLE,
  upCapsuleerTrips,
  upCapsuleerTripWait,
  sweepKey,
  membersKey,
  EVENT_CORP_MEMBERS,
  OUTBOUND,
  RATTING,
  RETURNING,
  DOCKED,
  ABORTED,
  LOST,
  TRIP_STATES,
  OPEN_TRIP_STATES,
  OPEN_TRIP_STATES_SQL,
  OPEN_CONTRACT_STATES_SQL,
  TERMINAL_TRIP_STATES,
  TRIP_KINDS,
  TRIP_AGGREGATE,
  EVENT_TRIP_CREATED,
  EVENT_TRIP_TRANSITION,
  EVENT_TRIP_STEP_DONE,
  EVENT_TRIP_WAIT,
  STEP_EVENT,
  RATTING_OPERATION_TYPE,
  OBJECTIVE_RAT,
  RETURN_OPERATION_TYPE,
  OBJECTIVE_RETURN,
  MAX_ID_LENGTH,
  MAX_KEY_LENGTH,
  MAX_REASON_LENGTH,
  RECONCILE_PREFIX,
  dispatchKey,
  stepKey,
  nudgeKey,
  reconcileKey,
  CORP_STATES,
  REVIEW_EVENT,
  REVIEW_AGGREGATE_ID,
  CORP_AGGREGATE,
  EVENT_FOUNDED,
  EVENT_TRANSITION,
  EVENT_WALLET,
  reviewKey,
  foundKey,
  activateKey,
  refuseKey,
  stipendKey,
  buyKey,
};
