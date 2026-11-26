"use strict";

const BATTLES_TABLE = "kb_battles";
const SIDES_TABLE = "kb_battle_sides";
const TOTALS_TABLE = "kb_faction_totals";
const PRICES_TABLE = "kb_type_prices";
const CURSOR_TABLE = "kb_cursor";
const TABLE_NAMES = Object.freeze([BATTLES_TABLE, SIDES_TABLE, TOTALS_TABLE, PRICES_TABLE, CURSOR_TABLE]);

const PRICE_BASIS = "base-v1";
const SIDE_RESULTS = Object.freeze(["W", "L", "D", "U"]);
const CURSOR_SOURCES = Object.freeze(["battles", "kills"]);
const CURSOR_STATE_RUNNING = "RUNNING";
const MAX_TEXT_KEY_LENGTH = 64;
const MAX_ENUM_LENGTH = 16;
const MAX_NAME_LENGTH = 64;
const MAX_ISK_TOTAL = 1e15;

const WORK_CLASS = "MAINTENANCE";

const KILLS_TABLE = "kb_kills";
const KILL_CHARS_TABLE = "kb_kill_chars";
const CHAR_TOTALS_TABLE = "kb_char_totals";
const NAMES_TABLE = "kb_names";
const KILL_TABLE_NAMES = Object.freeze([KILLS_TABLE, KILL_CHARS_TABLE, CHAR_TOTALS_TABLE, NAMES_TABLE]);
const CURSOR_STATE_REWOUND = "VENDOR_REWOUND";
const CURSOR_STATE_RESETTING = "RESETTING";
const CURSOR_STATES = Object.freeze([CURSOR_STATE_RUNNING, CURSOR_STATE_REWOUND, CURSOR_STATE_RESETTING]);
const KILL_CLASSES = Object.freeze(["PVP", "PVE"]);
const KILL_ROLES = Object.freeze(["V", "A", "F"]);
const NAME_KINDS = Object.freeze(["char", "corp", "alliance"]);
const PLAYER_OWNER_MIN_ID = 2000000;
const PENDING_BACKOFF_PASSES = 4;

function upKillboardBattles(db) {
  db.exec(`CREATE TABLE kb_battles (
    battle_no          INTEGER PRIMARY KEY AUTOINCREMENT,
    battle_id          TEXT    NOT NULL UNIQUE CHECK (length(battle_id) BETWEEN 1 AND 64),
    settled_at         INTEGER NOT NULL CHECK (settled_at >= 0),
    created_at         INTEGER NOT NULL CHECK (created_at >= 0),
    system_id          INTEGER NOT NULL CHECK (system_id > 0),
    mode               TEXT    NOT NULL CHECK (length(mode) BETWEEN 1 AND 16),
    environment        TEXT    NOT NULL CHECK (length(environment) BETWEEN 1 AND 16),
    objective          TEXT    NOT NULL CHECK (length(objective) BETWEEN 1 AND 16),
    outcome            TEXT    CHECK (outcome IS NULL OR length(outcome) BETWEEN 1 AND 16),
    a_faction_id       INTEGER CHECK (a_faction_id IS NULL OR a_faction_id > 0),
    b_faction_id       INTEGER CHECK (b_faction_id IS NULL OR b_faction_id > 0),
    a_fleets           INTEGER NOT NULL CHECK (a_fleets >= 0),
    b_fleets           INTEGER NOT NULL CHECK (b_fleets >= 0),
    a_ships_lost       INTEGER NOT NULL CHECK (a_ships_lost >= 0),
    b_ships_lost       INTEGER NOT NULL CHECK (b_ships_lost >= 0),
    a_isk_lost         INTEGER NOT NULL CHECK (a_isk_lost >= 0),
    b_isk_lost         INTEGER NOT NULL CHECK (b_isk_lost >= 0),
    unpriced_ships     INTEGER NOT NULL CHECK (unpriced_ships >= 0),
    structure_type_id  INTEGER CHECK (structure_type_id IS NULL OR structure_type_id > 0),
    structure_destroyed INTEGER CHECK (structure_destroyed IS NULL OR structure_destroyed IN (0, 1)),
    duration_sec       INTEGER CHECK (duration_sec IS NULL OR duration_sec >= 0),
    price_basis        TEXT    NOT NULL CHECK (length(price_basis) BETWEEN 1 AND 16),
    ingested_at        INTEGER NOT NULL CHECK (ingested_at >= 0)
  ) STRICT;
  CREATE INDEX kb_battles_system ON kb_battles (system_id, battle_no);

  CREATE TABLE kb_battle_sides (
    battle_no   INTEGER NOT NULL,
    faction_id  INTEGER NOT NULL CHECK (faction_id > 0),
    side        TEXT    NOT NULL CHECK (side IN ('A','B')),
    fleets      INTEGER NOT NULL CHECK (fleets >= 0),
    ships_lost  INTEGER NOT NULL CHECK (ships_lost >= 0),
    isk_lost    INTEGER NOT NULL CHECK (isk_lost >= 0),
    result      TEXT    NOT NULL CHECK (result IN ('W','L','D','U')),
    PRIMARY KEY (battle_no, faction_id, side)
  ) STRICT, WITHOUT ROWID;
  CREATE INDEX kb_battle_sides_faction ON kb_battle_sides (faction_id, battle_no);

  CREATE TABLE kb_faction_totals (
    faction_id      INTEGER PRIMARY KEY CHECK (faction_id > 0),
    battles         INTEGER NOT NULL CHECK (battles >= 0),
    wins            INTEGER NOT NULL CHECK (wins >= 0),
    losses          INTEGER NOT NULL CHECK (losses >= 0),
    draws           INTEGER NOT NULL CHECK (draws >= 0),
    undecided       INTEGER NOT NULL CHECK (undecided >= 0),
    ships_lost      INTEGER NOT NULL CHECK (ships_lost >= 0),
    ships_killed    INTEGER NOT NULL CHECK (ships_killed >= 0),
    isk_lost        INTEGER NOT NULL CHECK (isk_lost >= 0),
    isk_killed      INTEGER NOT NULL CHECK (isk_killed >= 0),
    first_battle_no INTEGER NOT NULL CHECK (first_battle_no >= 1),
    last_battle_no  INTEGER NOT NULL CHECK (last_battle_no >= 1),
    updated_at      INTEGER NOT NULL CHECK (updated_at >= 0),
    version         INTEGER NOT NULL CHECK (version >= 1)
  ) STRICT;

  CREATE TABLE kb_type_prices (
    type_id    INTEGER PRIMARY KEY CHECK (type_id > 0),
    isk        INTEGER CHECK (isk IS NULL OR isk >= 0),
    name       TEXT    CHECK (name IS NULL OR length(name) BETWEEN 1 AND 64),
    basis      TEXT    NOT NULL CHECK (length(basis) BETWEEN 1 AND 16),
    priced_at  INTEGER NOT NULL CHECK (priced_at >= 0)
  ) STRICT;

  CREATE TABLE kb_cursor (
    source      TEXT    PRIMARY KEY NOT NULL CHECK (source IN ('battles','kills')),
    at_ms       INTEGER NOT NULL CHECK (at_ms >= 0),
    key_text    TEXT    NOT NULL CHECK (length(key_text) <= 64),
    key_int     INTEGER NOT NULL CHECK (key_int >= 0),
    rows        INTEGER NOT NULL CHECK (rows >= 0),
    state       TEXT    NOT NULL CHECK (length(state) BETWEEN 1 AND 16),
    updated_at  INTEGER NOT NULL CHECK (updated_at >= 0),
    version     INTEGER NOT NULL CHECK (version >= 1)
  ) STRICT;`);
}

function upKillboardKills(db) {
  db.exec(`CREATE TABLE kb_kills (
    kill_id                INTEGER PRIMARY KEY CHECK (kill_id > 0),
    kill_at                INTEGER NOT NULL CHECK (kill_at >= 0),
    system_id              INTEGER CHECK (system_id IS NULL OR system_id > 0),
    victim_character_id    INTEGER CHECK (victim_character_id IS NULL OR victim_character_id > 0),
    victim_corporation_id  INTEGER CHECK (victim_corporation_id IS NULL OR victim_corporation_id > 0),
    victim_alliance_id     INTEGER CHECK (victim_alliance_id IS NULL OR victim_alliance_id > 0),
    victim_faction_id      INTEGER CHECK (victim_faction_id IS NULL OR victim_faction_id > 0),
    ship_type_id           INTEGER CHECK (ship_type_id IS NULL OR ship_type_id > 0),
    isk_lost               INTEGER NOT NULL CHECK (isk_lost >= 0),
    final_character_id     INTEGER CHECK (final_character_id IS NULL OR final_character_id > 0),
    final_corporation_id   INTEGER CHECK (final_corporation_id IS NULL OR final_corporation_id > 0),
    attacker_count         INTEGER NOT NULL CHECK (attacker_count >= 0),
    attackers_json         TEXT    NOT NULL CHECK (json_valid(attackers_json) AND json_type(attackers_json) = 'array'),
    class                  TEXT    NOT NULL CHECK (class IN ('PVP','PVE')),
    ingested_at            INTEGER NOT NULL CHECK (ingested_at >= 0)
  ) STRICT;
  CREATE INDEX kb_kills_system ON kb_kills (system_id, kill_at);

  CREATE TABLE kb_kill_chars (
    character_id INTEGER NOT NULL CHECK (character_id > 0),
    kill_id      INTEGER NOT NULL CHECK (kill_id > 0),
    role         TEXT    NOT NULL CHECK (role IN ('V','A','F')),
    PRIMARY KEY (character_id, kill_id)
  ) STRICT, WITHOUT ROWID;
  CREATE INDEX kb_kill_chars_kill ON kb_kill_chars (kill_id);

  CREATE TABLE kb_char_totals (
    character_id  INTEGER PRIMARY KEY CHECK (character_id > 0),
    kills         INTEGER NOT NULL CHECK (kills >= 0),
    losses        INTEGER NOT NULL CHECK (losses >= 0),
    isk_killed    INTEGER NOT NULL CHECK (isk_killed >= 0),
    isk_lost      INTEGER NOT NULL CHECK (isk_lost >= 0),
    first_kill_id INTEGER NOT NULL CHECK (first_kill_id > 0),
    last_kill_id  INTEGER NOT NULL CHECK (last_kill_id > 0),
    updated_at    INTEGER NOT NULL CHECK (updated_at >= 0),
    version       INTEGER NOT NULL CHECK (version >= 1)
  ) STRICT;

  CREATE TABLE kb_names (
    kind       TEXT    NOT NULL CHECK (kind IN ('char','corp','alliance')),
    id         INTEGER NOT NULL CHECK (id > 0),
    name       TEXT    NOT NULL CHECK (length(name) BETWEEN 1 AND 64),
    updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
    PRIMARY KEY (kind, id)
  ) STRICT, WITHOUT ROWID;`);
}

module.exports = {
  BATTLES_TABLE,
  SIDES_TABLE,
  TOTALS_TABLE,
  PRICES_TABLE,
  CURSOR_TABLE,
  TABLE_NAMES,
  PRICE_BASIS,
  SIDE_RESULTS,
  CURSOR_SOURCES,
  CURSOR_STATE_RUNNING,
  MAX_TEXT_KEY_LENGTH,
  MAX_ENUM_LENGTH,
  MAX_NAME_LENGTH,
  MAX_ISK_TOTAL,
  WORK_CLASS,
  upKillboardBattles,
  KILLS_TABLE,
  KILL_CHARS_TABLE,
  CHAR_TOTALS_TABLE,
  NAMES_TABLE,
  KILL_TABLE_NAMES,
  CURSOR_STATE_REWOUND,
  CURSOR_STATE_RESETTING,
  CURSOR_STATES,
  KILL_CLASSES,
  KILL_ROLES,
  NAME_KINDS,
  PLAYER_OWNER_MIN_ID,
  PENDING_BACKOFF_PASSES,
  upKillboardKills,
};
