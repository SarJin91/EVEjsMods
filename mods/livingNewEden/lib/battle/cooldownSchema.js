"use strict";

const COOLDOWN_TABLE_NAME = "battle_contact_cooldowns";
const COOLDOWN_EVENT = "BATTLE_COOLDOWN";

function upBattleCooldowns(db) {
  db.exec(`CREATE TABLE battle_contact_cooldowns (
    system_id  INTEGER NOT NULL CHECK (system_id > 0),
    faction_lo INTEGER NOT NULL CHECK (faction_lo > 0),
    faction_hi INTEGER NOT NULL CHECK (faction_hi > faction_lo),
    until_at   INTEGER NOT NULL CHECK (until_at >= 0),
    battle_id  TEXT    NOT NULL CHECK (length(battle_id) BETWEEN 1 AND 64),
    updated_at INTEGER NOT NULL CHECK (updated_at >= 0),
    PRIMARY KEY (system_id, faction_lo, faction_hi)
  ) STRICT, WITHOUT ROWID;`);
}

module.exports = { COOLDOWN_TABLE_NAME, COOLDOWN_EVENT, upBattleCooldowns };
