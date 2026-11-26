"use strict";

const VISITS_TABLE = "world_fleet_grid_visits";
const VIA = Object.freeze({ GATE: "GATE", WORMHOLE: "WORMHOLE", NONE: "NONE" });
const ANCHOR_KINDS = Object.freeze(["gate", "station", "structure", "pos", "sun", "belt", "system"]);
const PURPOSE = Object.freeze({ WORK: "WORK", SIEGE: "SIEGE", POST: "POST", PURSUIT: "PURSUIT", RETURN: "RETURN" });
const UNCAPPED_PURPOSES = Object.freeze([PURPOSE.POST, PURPOSE.PURSUIT, PURPOSE.RETURN]);

const DDL = `
CREATE TABLE ${VISITS_TABLE} (
  fleet_id             TEXT    PRIMARY KEY NOT NULL CHECK (length(fleet_id) BETWEEN 1 AND 64),
  system_id            INTEGER NOT NULL CHECK (system_id > 0),
  leg_seq              INTEGER NOT NULL CHECK (leg_seq >= 0),
  arrived_at           INTEGER NOT NULL CHECK (arrived_at >= 0),
  entered_via          TEXT    NOT NULL CHECK (entered_via IN ('GATE', 'WORMHOLE', 'NONE')),
  entry_from_system_id INTEGER CHECK (entry_from_system_id IS NULL OR entry_from_system_id > 0),
  move_seq             INTEGER NOT NULL DEFAULT 0 CHECK (move_seq >= 0),
  at_kind              TEXT    CHECK (at_kind IS NULL OR length(at_kind) BETWEEN 1 AND 16),
  at_id                INTEGER CHECK (at_id IS NULL OR at_id > 0),
  to_kind              TEXT    CHECK (to_kind IS NULL OR length(to_kind) BETWEEN 1 AND 16),
  to_id                INTEGER CHECK (to_id IS NULL OR to_id > 0),
  depart_at            INTEGER CHECK (depart_at IS NULL OR depart_at >= 0),
  arrive_at            INTEGER CHECK (arrive_at IS NULL OR arrive_at >= 0),
  purpose              TEXT    CHECK (purpose IS NULL OR length(purpose) BETWEEN 1 AND 16),
  target_fleet_id      TEXT    CHECK (target_fleet_id IS NULL OR length(target_fleet_id) BETWEEN 1 AND 64),
  attempts             INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  updated_at           INTEGER NOT NULL CHECK (updated_at >= 0),
  version              INTEGER NOT NULL CHECK (version >= 1),
  CHECK ((at_kind IS NULL) = (at_id IS NULL)),
  CHECK ((to_kind IS NULL) = (to_id IS NULL)),
  CHECK ((to_kind IS NULL) = (depart_at IS NULL) AND (to_kind IS NULL) = (arrive_at IS NULL)),
  CHECK (arrive_at IS NULL OR arrive_at >= depart_at),
  CHECK ((entered_via = 'GATE') = (entry_from_system_id IS NOT NULL) OR entered_via = 'WORMHOLE')
) STRICT;
CREATE INDEX ${VISITS_TABLE}_system ON ${VISITS_TABLE} (system_id, fleet_id);
`;

function upFleetGridVisits(db) {
  db.exec(DDL);
}

module.exports = { VISITS_TABLE, VIA, ANCHOR_KINDS, PURPOSE, UNCAPPED_PURPOSES, upFleetGridVisits };
