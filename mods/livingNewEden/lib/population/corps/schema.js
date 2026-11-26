"use strict";

const CORPS_TABLE = "world_npc_corps";

const FOCUS_NAMES = Object.freeze(["MINING", "TRADE", "PVE", "EXPLORE"]);
const CORP_STATE_NAMES = Object.freeze(["ACTIVE", "DISSOLVED"]);

function codes(names) {
  return Object.freeze(Object.fromEntries(names.map((n, i) => [n, i + 1])));
}
const FOCUS = codes(FOCUS_NAMES);
const CORP_STATE = codes(CORP_STATE_NAMES);

const CORP_NAME_ID_OFFSET = 1000000;

const NAME_ARCHETYPE_OF_FOCUS = Object.freeze({ [FOCUS.MINING]: "miner", [FOCUS.TRADE]: "hauler", [FOCUS.PVE]: "ratter",
  [FOCUS.EXPLORE]: "explorer" });

const CORP_REC_BYTES = 200;
const EXTRA_ENTRY_BYTES = 8;

const nameOf = (names, code) => (Number.isInteger(code) && code >= 1 && code <= names.length ? names[code - 1] : null);

function corpsSettingsOf(P) {
  const C = P && P.corps && typeof P.corps === "object" ? P.corps : {};
  return Object.freeze({ ...C, enabled: C.enabled === true });
}

const DDL = `
CREATE TABLE world_npc_corps (
  corp_id        INTEGER PRIMARY KEY CHECK (corp_id > 0),
  name           TEXT    NOT NULL COLLATE NOCASE UNIQUE CHECK (length(name) BETWEEN 1 AND 50),
  ticker         TEXT    NOT NULL CHECK (length(ticker) BETWEEN 2 AND 5),
  focus          INTEGER NOT NULL CHECK (focus BETWEEN 1 AND 4),
  state          INTEGER NOT NULL CHECK (state IN (1, 2)),
  home_id        INTEGER NOT NULL CHECK (home_id > 0),
  region_id      INTEGER NOT NULL CHECK (region_id >= 0),
  profile        INTEGER NOT NULL CHECK (profile >= 0),
  ceo_pilot_id   INTEGER NOT NULL CHECK (ceo_pilot_id >= 0),
  members        INTEGER NOT NULL CHECK (members >= 0),
  seq            INTEGER NOT NULL CHECK (seq >= 0),
  founded_at     INTEGER NOT NULL CHECK (founded_at >= 0),
  next_at        INTEGER NOT NULL CHECK (next_at >= 0),
  low_since      INTEGER NOT NULL DEFAULT 0 CHECK (low_since >= 0),
  ended_at       INTEGER NOT NULL DEFAULT 0 CHECK (ended_at >= 0),
  version        INTEGER NOT NULL CHECK (version >= 1)
) STRICT;
ALTER TABLE world_npc_pilots ADD COLUMN corp_id INTEGER NOT NULL DEFAULT 0;
`;

function upPopulationCorps(db) {
  db.exec(DDL);
}

module.exports = { CORPS_TABLE, FOCUS_NAMES, FOCUS, CORP_STATE_NAMES, CORP_STATE, CORP_NAME_ID_OFFSET,
  NAME_ARCHETYPE_OF_FOCUS, CORP_REC_BYTES, EXTRA_ENTRY_BYTES, nameOf, corpsSettingsOf, upPopulationCorps };
