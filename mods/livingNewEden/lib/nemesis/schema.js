"use strict";

const TABLE = "world_nemesis";
const STATES = Object.freeze({ ACTIVE: "ACTIVE", HUNTING: "HUNTING", DEFEATED: "DEFEATED", RETIRED: "RETIRED" });
const OPEN_STATES = Object.freeze([STATES.ACTIVE, STATES.HUNTING]);
const ENDED_STATES = Object.freeze([STATES.DEFEATED, STATES.RETIRED]);
const HISTORY_KINDS = Object.freeze({ CREATED: "CREATED", RETURN: "RETURN", WON: "WON", ESCAPED: "ESCAPED",
  DEFEATED: "DEFEATED", MISSED: "MISSED", RETIRED: "RETIRED" });
const CREATE_ON = Object.freeze({ WIN: "WIN", WIN_OR_SURVIVE: "WIN_OR_SURVIVE" });
const NEMESIS_COUNTER_NAMES = Object.freeze(["nemesisCreated", "nemesisSkippedLimit", "nemesisSkippedKnown",
  "nemesisSkippedCommander", "nemesisHookFailed", "nemesisPruned", "nemesisReadCut",
  "nemesisReturnCreated", "nemesisReturnFailed", "nemesisWaitNotDue", "nemesisWaitPlayerGap", "nemesisWaitOpenRevenge",
  "nemesisWaitNotLocated", "nemesisWaitNotInSpace", "nemesisWaitSecClass", "nemesisWaitRegion",
  "nemesisWaitCommanderBusy", "nemesisMemberGone", "nemesisIdle", "nemesisWon", "nemesisEscaped", "nemesisDefeated",
  "nemesisMissed", "nemesisRetired", "nemesisRecovered", "nemesisTrophySeeded", "nemesisTrophySkipped",
  "nemesisRetireFailed",
  "nemesisDoctrine", "nemesisEwarNoProfile", "nemesisKillboardRead", "nemesisKillboardFailed",
  "nemesisLetterQueued", "nemesisLetterLlm", "nemesisLetterTemplate", "nemesisLetterCapped", "nemesisLetterStale",
  "nemesisLetterNoNotices", "nemesisLetterDuplicate", "nemesisLetterFailed", "nemesisReturnLineLlm",
  "nemesisEwarSeamFailed"]);
const LETTER_KINDS = Object.freeze({ CREATED: "CREATED", WON: "WON", DEFEATED: "DEFEATED" });
const LETTER_KIND_RETURN = "RETURN";
const LETTER_NOTICE_KIND = "NEMESIS";
const RNG_STREAM_LETTER = "nemesisLetter";
const LETTER_MIN_CHARS = 20;
const RETURN_REASON_COUNTERS = Object.freeze({ NOT_DUE: "nemesisWaitNotDue", PLAYER_GAP: "nemesisWaitPlayerGap",
  OPEN_REVENGE: "nemesisWaitOpenRevenge", NOT_LOCATED: "nemesisWaitNotLocated", NOT_IN_SPACE: "nemesisWaitNotInSpace",
  SEC_CLASS: "nemesisWaitSecClass", EXCLUDED_REGION: "nemesisWaitRegion", COMMANDER_BUSY: "nemesisWaitCommanderBusy",
  MEMBER_GONE: "nemesisMemberGone", IDLE: "nemesisIdle" });
const ENCOUNTER_COUNTERS = Object.freeze({ WON: "nemesisWon", ESCAPED: "nemesisEscaped", DEFEATED: "nemesisDefeated",
  MISSED: "nemesisMissed", RETIRED: "nemesisRetired" });
const RNG_STREAM_RETURN = "nemesisReturn";
const RNG_STREAM_TROPHY = "nemesisTrophy";
const RNG_STREAM_DOCTRINE = "nemesisDoctrine";
const EVENT_NEMESIS_RETURN = "NEMESIS_RETURN";
const EVENT_NEMESIS_ENCOUNTER = "NEMESIS_ENCOUNTER";
const EVENT_NEMESIS_RETIRED = "NEMESIS_RETIRED";
const MAX_TROPHY_TYPE_IDS = 8;
const RNG_STREAM_NEMESIS = "nemesis";
const MAX_NEMESIS_ID_LENGTH = 48;
const MAX_NAME_LENGTH = 64;
const MIN_RANK = 1;
const MAX_RANK = 10;
const MIN_BASE_LEVEL = 1;
const MAX_BASE_LEVEL = 5;
const NEMESIS_AGGREGATE = "nemesis";
const EVENT_NEMESIS_CREATED = "NEMESIS_CREATED";

function nemesisIdOf(characterId, commanderId) {
  return `nem:${characterId}:${commanderId}`;
}

function encounterKeyOf(revengeId) {
  return `nem:enc:${revengeId}`;
}

function returnKeyOf(nemesisId, n) {
  return `nem:ret:${nemesisId}:${n}`;
}

function retireKeyOf(nemesisId) {
  return `nem:ret:${nemesisId}:end`;
}

function returnWantedIdOf(nemesisId, n) {
  return `${nemesisId}:r${n}`;
}

function letterEventKeyOf(nemesisId, seq) {
  return `nem:${nemesisId}:${seq}`;
}

function parseTrophyTypeIds(text) {
  if (typeof text !== "string") return null;
  const out = [];
  for (const part of text.split(",")) {
    const s = part.trim();
    if (s === "") continue;
    if (!/^[0-9]+$/.test(s)) return null;
    const id = Number(s);
    if (!Number.isSafeInteger(id) || id <= 0 || out.includes(id)) return null;
    out.push(id);
  }
  return out.length <= MAX_TROPHY_TYPE_IDS ? out : null;
}

function upNemesis(db) {
  db.exec(`CREATE TABLE world_nemesis (
    nemesis_id        TEXT PRIMARY KEY NOT NULL CHECK (length(nemesis_id) BETWEEN 1 AND 48),
    character_id      INTEGER NOT NULL CHECK (character_id > 0),
    commander_id      INTEGER NOT NULL CHECK (commander_id > 0),
    faction_id        INTEGER NOT NULL CHECK (faction_id > 0),
    gang_id           INTEGER NOT NULL CHECK (gang_id >= 1),
    name              TEXT CHECK (name IS NULL OR length(name) BETWEEN 1 AND 64),
    rank              INTEGER NOT NULL CHECK (rank BETWEEN 1 AND 10),
    base_level        INTEGER NOT NULL CHECK (base_level BETWEEN 1 AND 5),
    state             TEXT NOT NULL CHECK (state IN ('ACTIVE','HUNTING','DEFEATED','RETIRED')),
    open_revenge_id   TEXT CHECK (open_revenge_id IS NULL OR length(open_revenge_id) BETWEEN 1 AND 72),
    returns           INTEGER NOT NULL DEFAULT 0 CHECK (returns >= 0),
    encounters        INTEGER NOT NULL DEFAULT 0 CHECK (encounters >= 0),
    wins              INTEGER NOT NULL DEFAULT 0 CHECK (wins >= 0),
    escapes           INTEGER NOT NULL DEFAULT 0 CHECK (escapes >= 0),
    missed            INTEGER NOT NULL DEFAULT 0 CHECK (missed >= 0),
    next_return_at    INTEGER NOT NULL CHECK (next_return_at >= 0),
    last_encounter_at INTEGER NOT NULL CHECK (last_encounter_at >= 0),
    origin_revenge_id TEXT NOT NULL CHECK (length(origin_revenge_id) BETWEEN 1 AND 72),
    origin_system_id  INTEGER NOT NULL CHECK (origin_system_id > 0),
    profile_json      TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(profile_json) AND json_type(profile_json) = 'object'),
    history_json      TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(history_json) AND json_type(history_json) = 'array'),
    letter_seq        INTEGER NOT NULL DEFAULT 0 CHECK (letter_seq >= 0),
    letter_sent_seq   INTEGER NOT NULL DEFAULT 0 CHECK (letter_sent_seq >= 0),
    letter_kind       TEXT CHECK (letter_kind IS NULL OR length(letter_kind) BETWEEN 1 AND 16),
    seed              INTEGER NOT NULL,
    end_reason        TEXT CHECK (end_reason IS NULL OR length(end_reason) BETWEEN 1 AND 32),
    created_at        INTEGER NOT NULL CHECK (created_at >= 0),
    updated_at        INTEGER NOT NULL CHECK (updated_at >= 0),
    ended_at          INTEGER CHECK (ended_at IS NULL OR ended_at >= 0),
    version           INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
    UNIQUE (character_id, commander_id)
  ) STRICT;
  CREATE UNIQUE INDEX idx_nemesis_commander_open ON world_nemesis (commander_id) WHERE state IN ('ACTIVE','HUNTING');
  CREATE INDEX idx_nemesis_due ON world_nemesis (state, next_return_at);
  CREATE INDEX idx_nemesis_character ON world_nemesis (character_id, state);
  ALTER TABLE world_bounty_revenge ADD COLUMN nemesis_id TEXT
    CHECK (nemesis_id IS NULL OR length(nemesis_id) BETWEEN 1 AND 48);
  CREATE INDEX idx_bounty_revenge_nemesis ON world_bounty_revenge (nemesis_id);`);
}

module.exports = { TABLE, STATES, OPEN_STATES, ENDED_STATES, HISTORY_KINDS, CREATE_ON, NEMESIS_COUNTER_NAMES,
  RNG_STREAM_NEMESIS, MAX_NEMESIS_ID_LENGTH, MAX_NAME_LENGTH, MIN_RANK, MAX_RANK, MIN_BASE_LEVEL, MAX_BASE_LEVEL,
  NEMESIS_AGGREGATE, EVENT_NEMESIS_CREATED, nemesisIdOf, encounterKeyOf, upNemesis,
  RETURN_REASON_COUNTERS, ENCOUNTER_COUNTERS, RNG_STREAM_RETURN, RNG_STREAM_TROPHY, EVENT_NEMESIS_RETURN,
  EVENT_NEMESIS_ENCOUNTER, EVENT_NEMESIS_RETIRED, MAX_TROPHY_TYPE_IDS, returnKeyOf, retireKeyOf, returnWantedIdOf,
  parseTrophyTypeIds,
  RNG_STREAM_DOCTRINE,
  LETTER_KINDS, LETTER_KIND_RETURN, LETTER_NOTICE_KIND, RNG_STREAM_LETTER, LETTER_MIN_CHARS, letterEventKeyOf };
