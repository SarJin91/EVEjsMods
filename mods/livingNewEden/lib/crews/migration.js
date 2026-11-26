"use strict";

const DDL = `
CREATE TABLE world_fleet_crews (
  fleet_id        TEXT    PRIMARY KEY NOT NULL,
  faction_id      INTEGER NOT NULL CHECK (faction_id > 0),
  corporation_id  INTEGER CHECK (corporation_id IS NULL OR corporation_id > 0),
  composition_sig TEXT    NOT NULL,
  wanted          INTEGER NOT NULL CHECK (wanted >= 0),
  seated          INTEGER NOT NULL CHECK (seated >= 0),
  last_seen_at    INTEGER CHECK (last_seen_at IS NULL OR last_seen_at >= 0),
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  version         INTEGER NOT NULL CHECK (version >= 1)
) STRICT;
CREATE INDEX world_fleet_crews_reclaim ON world_fleet_crews (faction_id, last_seen_at, fleet_id);
CREATE TABLE world_fleet_crew_seats (
  fleet_id     TEXT    NOT NULL,
  seat         INTEGER NOT NULL CHECK (seat >= 0),
  character_id INTEGER NOT NULL UNIQUE CHECK (character_id > 0),
  hull_group   TEXT    NOT NULL,
  type_id      INTEGER CHECK (type_id IS NULL OR type_id > 0),
  joined_at    INTEGER NOT NULL,
  PRIMARY KEY (fleet_id, seat)
) STRICT;
CREATE TABLE world_crew_pilots (
  character_id   INTEGER PRIMARY KEY NOT NULL CHECK (character_id > 0),
  losses         INTEGER NOT NULL CHECK (losses >= 0),
  cooldown_until INTEGER NOT NULL CHECK (cooldown_until >= 0),
  last_fleet_id  TEXT,
  updated_at     INTEGER NOT NULL
) STRICT;
`;

function upCrews(db) {
  db.exec(DDL);
}

module.exports = { upCrews };
