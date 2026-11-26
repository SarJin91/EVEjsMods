"use strict";

const WAR_PAIR_TABLE_NAME = "world_war_pairs";
const WAR_PAIR_AGGREGATE = "world_war_pair";
const EVENT_WAR_PAIR_CHANGED = "WAR_PAIR_CHANGED";
const EVENT_WAR_PAIR_TRUCE = "WAR_PAIR_TRUCE";
const STATE_WAR = "WAR";
const STATE_TRUCE = "TRUCE";
const MAX_PAIR_COUNTER = 1000000000;
const MAX_TRUCES_TOTAL = 1000000;
const MAX_KEY_LENGTH = 200;
const WAR_PAIR_ROWS_BOUND = 2;

const warPairKeyOf = (ck) => `${ck}:warpair`;

function upWarPairs(db) {
  db.exec(`CREATE TABLE world_war_pairs (
    faction_lo       INTEGER NOT NULL CHECK (faction_lo > 0),
    faction_hi       INTEGER NOT NULL CHECK (faction_hi > faction_lo),
    state            TEXT    NOT NULL CHECK (state IN ('WAR','TRUCE')),
    series_start_at  INTEGER NOT NULL CHECK (series_start_at >= 0),
    last_battle_at   INTEGER NOT NULL CHECK (last_battle_at >= 0),
    battles          INTEGER NOT NULL DEFAULT 0 CHECK (battles BETWEEN 0 AND 1000000000),
    losses_lo        INTEGER NOT NULL DEFAULT 0 CHECK (losses_lo BETWEEN 0 AND 1000000000),
    losses_hi        INTEGER NOT NULL DEFAULT 0 CHECK (losses_hi BETWEEN 0 AND 1000000000),
    wins_lo          INTEGER NOT NULL DEFAULT 0 CHECK (wins_lo BETWEEN 0 AND 1000000000),
    wins_hi          INTEGER NOT NULL DEFAULT 0 CHECK (wins_hi BETWEEN 0 AND 1000000000),
    truce_until      INTEGER CHECK (truce_until IS NULL OR truce_until >= 0),
    truce_initiator  INTEGER CHECK (truce_initiator IS NULL OR truce_initiator > 0),
    cooldown_until   INTEGER CHECK (cooldown_until IS NULL OR cooldown_until >= 0),
    truces_total     INTEGER NOT NULL DEFAULT 0 CHECK (truces_total BETWEEN 0 AND 1000000),
    updated_at       INTEGER NOT NULL CHECK (updated_at >= 0),
    version          INTEGER NOT NULL CHECK (version >= 1),
    PRIMARY KEY (faction_lo, faction_hi)
  ) STRICT, WITHOUT ROWID;
  CREATE INDEX world_war_pairs_hi ON world_war_pairs (faction_hi, faction_lo);`);
}

module.exports = { WAR_PAIR_TABLE_NAME, WAR_PAIR_AGGREGATE, EVENT_WAR_PAIR_CHANGED, EVENT_WAR_PAIR_TRUCE, STATE_WAR,
  STATE_TRUCE, MAX_PAIR_COUNTER, MAX_TRUCES_TOTAL, MAX_KEY_LENGTH, WAR_PAIR_ROWS_BOUND, warPairKeyOf, upWarPairs };
