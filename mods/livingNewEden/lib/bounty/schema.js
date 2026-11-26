"use strict";

const TABLE = "world_bounty_targets";

const STATES = Object.freeze({ ROAMING: "ROAMING", LIVE: "LIVE", KILLED: "KILLED", EXPIRED: "EXPIRED" });
const ACTIVE_STATES = Object.freeze([STATES.ROAMING, STATES.LIVE]);
const ENDED_STATES = Object.freeze([STATES.KILLED, STATES.EXPIRED]);

const ARCHETYPES = Object.freeze({ RUNNER: "RUNNER", BRAWLER: "BRAWLER", KITER: "KITER", AMBUSH: "AMBUSH" });

const PAYOUT_STATES = Object.freeze({ NONE: "NONE", PENDING: "PENDING", PAID: "PAID", FAILED: "FAILED" });

const OUTLAW_OWNER_KIND = "outlaw";

const RNG_STREAM_TARGET = "bounty";
const RNG_STREAM_MOVE = "move";
const RNG_STREAM_GANG = "bounty-gang";

const MAX_WANTED_ID_LENGTH = 64;
const MAX_ARCHETYPE_LENGTH = 16;
const MIN_LEVEL = 1;
const MAX_LEVEL = 6;

function wantedIdOf(slot, cycle) {
  return `bnt:${slot}:${cycle}`;
}

function upBountyTargets(db) {
  db.exec(`CREATE TABLE world_bounty_targets (
    wanted_id        TEXT    PRIMARY KEY NOT NULL CHECK (length(wanted_id) BETWEEN 1 AND 64),
    gang_slot        INTEGER NOT NULL CHECK (gang_slot >= 1),
    cycle            INTEGER NOT NULL CHECK (cycle >= 1),
    faction_id       INTEGER NOT NULL CHECK (faction_id > 0),
    character_id     INTEGER NOT NULL CHECK (character_id > 0),
    level            INTEGER NOT NULL CHECK (level BETWEEN 1 AND 6),
    archetype        TEXT    NOT NULL CHECK (length(archetype) BETWEEN 1 AND 16),
    smuggler         INTEGER NOT NULL DEFAULT 0 CHECK (smuggler IN (0, 1)),
    state            TEXT    NOT NULL CHECK (length(state) BETWEEN 1 AND 16),
    system_id        INTEGER NOT NULL CHECK (system_id > 0),
    stay_index       INTEGER NOT NULL DEFAULT 0 CHECK (stay_index >= 0),
    next_move_at     INTEGER NOT NULL CHECK (next_move_at >= 0),
    expires_at       INTEGER NOT NULL CHECK (expires_at >= 0),
    escorts_lost     INTEGER NOT NULL DEFAULT 0 CHECK (escorts_lost >= 0),
    trace_system_id  INTEGER CHECK (trace_system_id IS NULL OR trace_system_id > 0),
    trace_at         INTEGER CHECK (trace_at IS NULL OR trace_at >= 0),
    reward_isk       INTEGER NOT NULL CHECK (reward_isk >= 0),
    seed             INTEGER NOT NULL,
    killed_by        INTEGER CHECK (killed_by IS NULL OR killed_by > 0),
    killed_at        INTEGER CHECK (killed_at IS NULL OR killed_at >= 0),
    payout_state     TEXT    NOT NULL DEFAULT 'NONE' CHECK (length(payout_state) BETWEEN 1 AND 16),
    payout_attempts  INTEGER NOT NULL DEFAULT 0 CHECK (payout_attempts >= 0),
    ended_at         INTEGER CHECK (ended_at IS NULL OR ended_at >= 0),
    created_at       INTEGER NOT NULL CHECK (created_at >= 0),
    updated_at       INTEGER NOT NULL CHECK (updated_at >= 0),
    version          INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    UNIQUE (gang_slot, cycle)
  ) STRICT;
  CREATE INDEX idx_bounty_targets_state ON world_bounty_targets (state, next_move_at);`);
}

const PAYOUTS_TABLE = "world_bounty_payouts";
const PAYOUT_ROW_STATES = Object.freeze({ PENDING: "PENDING", PAID: "PAID", FAILED: "FAILED" });
const PAYOUT_DESCRIPTION = "LNE bounty";
const ISK_SOURCE = "lne-bounty";
const MAX_PAYOUT_KEY_LENGTH = 120;
const BOUNTY_AGGREGATE = "bounty";
const EVENT_BOUNTY_CLAIMED = "BOUNTY_CLAIMED";

function payoutKeyOf(wantedId, createdAt) {
  return `lne:bounty:${wantedId}:${createdAt}`;
}

function upBountyPayouts(db) {
  db.exec(`CREATE TABLE world_bounty_payouts (
    payout_key    TEXT    PRIMARY KEY NOT NULL CHECK (length(payout_key) BETWEEN 1 AND 120),
    wanted_id     TEXT    NOT NULL CHECK (length(wanted_id) BETWEEN 1 AND 64),
    character_id  INTEGER NOT NULL CHECK (character_id > 0),
    system_id     INTEGER NOT NULL CHECK (system_id > 0),
    amount_isk    INTEGER NOT NULL CHECK (amount_isk >= 0),
    state         TEXT    NOT NULL CHECK (length(state) BETWEEN 1 AND 16),
    attempts      INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    last_reason   TEXT,
    created_at    INTEGER NOT NULL CHECK (created_at >= 0),
    updated_at    INTEGER NOT NULL CHECK (updated_at >= 0),
    settled_at    INTEGER CHECK (settled_at IS NULL OR settled_at >= 0),
    version       INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1)
  ) STRICT;
  CREATE INDEX idx_bounty_payouts_pending ON world_bounty_payouts (state, updated_at);`);
}

function upBountyPayoutRetry(db) {
  db.exec(`ALTER TABLE world_bounty_payouts ADD COLUMN next_attempt_at INTEGER NOT NULL DEFAULT 0
    CHECK (next_attempt_at >= 0);
  CREATE INDEX idx_bounty_payouts_due ON world_bounty_payouts (state, next_attempt_at);`);
}

const REVENGE_TABLE = "world_bounty_revenge";
const REVENGE_STATES = Object.freeze({ WAITING: "WAITING", LIVE: "LIVE", DONE: "DONE", EXPIRED: "EXPIRED" });
const REVENGE_OPEN_STATES = Object.freeze([REVENGE_STATES.WAITING, REVENGE_STATES.LIVE]);
const REVENGE_AGGREGATE = "bounty_revenge";
const EVENT_REVENGE_SWORN = "BOUNTY_REVENGE_SWORN";
const RNG_STREAM_REVENGE = "bounty-revenge";
const RNG_STREAM_FAME = "fameBounty";
const MAX_REVENGE_ID_LENGTH = 72;

function revengeIdOf(wantedId) {
  return `rev:${wantedId}`;
}

function revengeJournalKeyOf(wantedId) {
  return `bnty:rev:${wantedId}`;
}

function upBountyRevenge(db) {
  db.exec(`CREATE TABLE world_bounty_revenge (
    revenge_id        TEXT    PRIMARY KEY NOT NULL CHECK (length(revenge_id) BETWEEN 1 AND 72),
    wanted_id         TEXT    NOT NULL UNIQUE CHECK (length(wanted_id) BETWEEN 1 AND 64),
    character_id      INTEGER NOT NULL CHECK (character_id > 0),
    faction_id        INTEGER NOT NULL CHECK (faction_id > 0),
    gang_id           INTEGER NOT NULL CHECK (gang_id >= 1),
    boss_character_id INTEGER NOT NULL CHECK (boss_character_id > 0),
    target_level      INTEGER NOT NULL CHECK (target_level BETWEEN 1 AND 6),
    hunter_level      INTEGER NOT NULL CHECK (hunter_level BETWEEN 1 AND 6),
    kill_system_id    INTEGER NOT NULL CHECK (kill_system_id > 0),
    state             TEXT    NOT NULL CHECK (length(state) BETWEEN 1 AND 16),
    system_id         INTEGER CHECK (system_id IS NULL OR system_id > 0),
    commander_id      INTEGER CHECK (commander_id IS NULL OR commander_id > 0),
    attempts          INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    due_at            INTEGER NOT NULL CHECK (due_at >= 0),
    expires_at        INTEGER NOT NULL CHECK (expires_at >= 0),
    end_reason        TEXT,
    seed              INTEGER NOT NULL,
    killed_at         INTEGER NOT NULL CHECK (killed_at >= 0),
    live_at           INTEGER CHECK (live_at IS NULL OR live_at >= 0),
    ended_at          INTEGER CHECK (ended_at IS NULL OR ended_at >= 0),
    created_at        INTEGER NOT NULL CHECK (created_at >= 0),
    updated_at        INTEGER NOT NULL CHECK (updated_at >= 0),
    version           INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1)
  ) STRICT;
  CREATE INDEX idx_bounty_revenge_state ON world_bounty_revenge (state, due_at);
  CREATE INDEX idx_bounty_revenge_character ON world_bounty_revenge (character_id, state);`);
}

module.exports = { TABLE, STATES, ACTIVE_STATES, ENDED_STATES, ARCHETYPES, PAYOUT_STATES, OUTLAW_OWNER_KIND,
  RNG_STREAM_TARGET, RNG_STREAM_MOVE, RNG_STREAM_GANG, MAX_WANTED_ID_LENGTH, MAX_ARCHETYPE_LENGTH, MIN_LEVEL,
  MAX_LEVEL, wantedIdOf, upBountyTargets, PAYOUTS_TABLE, PAYOUT_ROW_STATES, PAYOUT_DESCRIPTION, ISK_SOURCE,
  MAX_PAYOUT_KEY_LENGTH, BOUNTY_AGGREGATE, EVENT_BOUNTY_CLAIMED, payoutKeyOf, upBountyPayouts, upBountyPayoutRetry,
  REVENGE_TABLE, REVENGE_STATES, REVENGE_OPEN_STATES, REVENGE_AGGREGATE, EVENT_REVENGE_SWORN, RNG_STREAM_REVENGE,
  MAX_REVENGE_ID_LENGTH, revengeIdOf, revengeJournalKeyOf, upBountyRevenge, RNG_STREAM_FAME };
