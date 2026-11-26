"use strict";

const TABLE_NAME = "lne_local_contacts";
const ADDING = "ADDING";
const OWNED = "OWNED";
const REMOVING = "REMOVING";
const RELEASED = "RELEASED";
const STATES = Object.freeze([ADDING, OWNED, REMOVING, RELEASED]);
const DELETE_ROW = "DELETE_ROW";
const LEVELS = Object.freeze(["alliance", "corporation"]);
const RELEASE_REASONS = Object.freeze({ MANUAL_EDIT: "MANUAL_EDIT", MANUAL_DELETE: "MANUAL_DELETE" });
const RELATIONSHIP_OF = Object.freeze({ hostile: -10, friendly: 10 });
const LIVE_SQL = "state <> 'RELEASED'";
const COUNTER_NAMES = Object.freeze(["set", "removed", "confirmed", "released", "skippedManual", "conflicts",
  "unknownStanding", "deferred", "failed"]);
const WORK_CLASS = "MAINTENANCE";
const MODE = Object.freeze({ FULL: "full", CLEANUP: "cleanup", SEAM_UNAVAILABLE: "seam_unavailable",
  STOPPED: "stopped" });

function upLocalContacts(db) {
  db.exec(`CREATE TABLE lne_local_contacts (
    character_id   INTEGER NOT NULL CHECK (character_id > 0),
    contact_id     INTEGER NOT NULL CHECK (contact_id > 0),
    faction_id     INTEGER NOT NULL CHECK (faction_id > 0),
    level          TEXT    NOT NULL CHECK (level IN ('alliance', 'corporation')),
    state          TEXT    NOT NULL CHECK (state IN ('ADDING', 'OWNED', 'REMOVING', 'RELEASED')),
    written_rel    INTEGER NOT NULL CHECK (written_rel IN (-10, 10)),
    prev_rel       INTEGER NULL     CHECK (prev_rel IS NULL OR prev_rel IN (-10, 10)),
    changed_at     INTEGER NOT NULL CHECK (changed_at >= 0),
    release_reason TEXT    NULL     CHECK (release_reason IS NULL OR release_reason IN ('MANUAL_EDIT', 'MANUAL_DELETE')),
    version        INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    PRIMARY KEY (character_id, contact_id)
  ) WITHOUT ROWID;
  CREATE INDEX lne_local_contacts_live ON lne_local_contacts (state, character_id) WHERE state <> 'RELEASED';`);
}

module.exports = { TABLE_NAME, ADDING, OWNED, REMOVING, RELEASED, STATES, DELETE_ROW, LEVELS, RELEASE_REASONS,
  RELATIONSHIP_OF, LIVE_SQL, COUNTER_NAMES, WORK_CLASS, MODE, upLocalContacts };
