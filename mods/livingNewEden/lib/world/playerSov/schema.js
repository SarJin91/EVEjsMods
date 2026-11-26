"use strict";

const TABLE_NAME = "world_player_sov";

const CAPTURING = "CAPTURING";
const HELD = "HELD";
const SIEGED = "SIEGED";
const REINFORCED = "REINFORCED";
const RETAKING = "RETAKING";
const LOST = "LOST";
const STATES = Object.freeze([CAPTURING, HELD, SIEGED, REINFORCED, RETAKING, LOST]);
const LIVE_STATES = Object.freeze([CAPTURING, HELD, SIEGED, REINFORCED, RETAKING]);
const BASE_STATES = Object.freeze([CAPTURING, HELD]);
const ATTACK_STATES = Object.freeze([SIEGED, REINFORCED, RETAKING]);
const LIVE_SQL = "('CAPTURING','HELD','SIEGED','REINFORCED','RETAKING')";

const ORIGIN = Object.freeze({ GATE: "GATE", MIRROR: "MIRROR" });
const ORIGINS = Object.freeze(Object.values(ORIGIN));

const END_REASON = Object.freeze({ RETAKEN: "RETAKEN", NATIVE_GONE: "NATIVE_GONE", OWNER_CHANGED: "OWNER_CHANGED" });
const END_REASONS = Object.freeze(Object.values(END_REASON));

const ACTION = Object.freeze({ INSERT: "INSERT", PROMOTE: "PROMOTE", SET_BASE: "SET_BASE", END: "END" });

const CODES = Object.freeze({
  TRANSITION_DENIED: "PLAYER_SOV_TRANSITION_DENIED",
  DUPLICATE: "DUPLICATE",
  VERSION_CONFLICT: "VERSION_CONFLICT",
  SQL_FAILED: "PLAYER_SOV_SQL_FAILED",
  UNAVAILABLE: "PLAYER_SOV_UNAVAILABLE",
});

const HUB_TYPE_ID = 32458;

const LIVE_GAUGE = "world.playerSov.live";
const SCAN_HISTOGRAM = "world.playerSov.scanMs";

const MAX_ID_LENGTH = 64;

const claimIdOf = (systemId, allianceId, hubItemId) => `psov:${systemId}:${allianceId}:${hubItemId}`;

function upPlayerSov(db) {
  db.exec(`CREATE TABLE world_player_sov (
    claim_id            TEXT    PRIMARY KEY CHECK (length(claim_id) BETWEEN 1 AND 64),
    system_id           INTEGER NOT NULL CHECK (system_id > 0),
    alliance_id         INTEGER NOT NULL CHECK (alliance_id > 0),
    corp_id             INTEGER NOT NULL CHECK (corp_id > 0),
    hub_item_id         INTEGER NOT NULL CHECK (hub_item_id > 0),
    origin              TEXT    NOT NULL CHECK (origin IN ('GATE','MIRROR')),
    state               TEXT    NOT NULL CHECK (state IN ('CAPTURING','HELD','SIEGED','REINFORCED','RETAKING','LOST')),
    base_state          TEXT    NOT NULL CHECK (base_state IN ('CAPTURING','HELD')),
    end_reason          TEXT    CHECK (end_reason IS NULL OR end_reason IN ('RETAKEN','NATIVE_GONE','OWNER_CHANGED')),
    attacker_faction_id INTEGER,
    attack_started_at   INTEGER,
    reinforced_until    INTEGER,
    retake_attempts     INTEGER NOT NULL DEFAULT 0 CHECK (retake_attempts >= 0),
    first_seen_at       INTEGER NOT NULL,
    held_since_at       INTEGER,
    ended_at            INTEGER,
    version             INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    created_at          INTEGER NOT NULL,
    updated_at          INTEGER NOT NULL,
    CHECK ((state = 'LOST') = (end_reason IS NOT NULL)),
    CHECK (state <> 'REINFORCED' OR reinforced_until IS NOT NULL),
    CHECK (state NOT IN ('SIEGED','REINFORCED','RETAKING') OR attacker_faction_id IS NOT NULL)
  ) STRICT;
  CREATE UNIQUE INDEX ux_player_sov_live_system ON world_player_sov (system_id)
    WHERE state IN ('CAPTURING','HELD','SIEGED','REINFORCED','RETAKING');
  CREATE INDEX ix_player_sov_live_alliance ON world_player_sov (alliance_id)
    WHERE state IN ('CAPTURING','HELD','SIEGED','REINFORCED','RETAKING');
  CREATE INDEX ix_player_sov_attacker ON world_player_sov (attacker_faction_id, state)
    WHERE state IN ('SIEGED','REINFORCED','RETAKING');
  CREATE INDEX ix_player_sov_lost ON world_player_sov (updated_at)
    WHERE state = 'LOST';`);
}

module.exports = {
  TABLE_NAME,
  CAPTURING,
  HELD,
  SIEGED,
  REINFORCED,
  RETAKING,
  LOST,
  STATES,
  LIVE_STATES,
  BASE_STATES,
  ATTACK_STATES,
  LIVE_SQL,
  ORIGIN,
  ORIGINS,
  END_REASON,
  END_REASONS,
  ACTION,
  CODES,
  HUB_TYPE_ID,
  LIVE_GAUGE,
  SCAN_HISTOGRAM,
  MAX_ID_LENGTH,
  claimIdOf,
  upPlayerSov,
};
