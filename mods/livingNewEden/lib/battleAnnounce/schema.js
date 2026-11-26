"use strict";

const TABLE = "battle_announcements";
const RECIPIENTS_TABLE = "battle_announcement_recipients";
const STATE = Object.freeze({ OPEN: "OPEN", CLOSED: "CLOSED" });
const OUTCOME = Object.freeze({ SETTLED: "SETTLED", ABORTED: "ABORTED", INTERCEPTED: "INTERCEPTED",
  CANCELLED: "CANCELLED", NO_FIGHT: "NO_FIGHT", NO_CONTACT: "NO_CONTACT", EXPIRED: "EXPIRED" });
const KIND_ETA = "BATTLE_ETA";
const KIND_END = "BATTLE_END";
const ANNOUNCE_EVENT = "BATTLE_ANNOUNCE";
const CHECK_EVENT = "BATTLE_ANNOUNCE_CHECK";
const MAX_OPERATION_ID = 64;
const MAX_OPERATION_TYPE = 32;
const MAX_BATTLE_ID = 64;

const announceKeyOf = (operationId) => `bann:eta:${operationId}`;
const checkKeyOf = (operationId, round) => `bann:chk:${operationId}:${round}`;
const noticeKeyOf = (operationId, part) => `bann:${operationId}:${part}`;

const DDL = `
CREATE TABLE battle_announcements (
  operation_id        TEXT    PRIMARY KEY NOT NULL CHECK (length(operation_id) BETWEEN 1 AND 64),
  operation_type      TEXT    NOT NULL CHECK (length(operation_type) BETWEEN 1 AND 32),
  faction_id          INTEGER NOT NULL CHECK (faction_id > 0),
  defender_faction_id INTEGER CHECK (defender_faction_id IS NULL OR defender_faction_id > 0),
  target_system_id    INTEGER NOT NULL CHECK (target_system_id > 0),
  eta_at              INTEGER NOT NULL CHECK (eta_at >= 0),
  announced_at        INTEGER NOT NULL CHECK (announced_at >= 0),
  state               TEXT    NOT NULL CHECK (state IN ('OPEN','CLOSED')),
  outcome             TEXT    CHECK (outcome IS NULL OR length(outcome) BETWEEN 1 AND 16),
  battle_id           TEXT    CHECK (battle_id IS NULL OR length(battle_id) BETWEEN 1 AND 64),
  check_round         INTEGER NOT NULL CHECK (check_round >= 0),
  recipients          INTEGER NOT NULL CHECK (recipients >= 1),
  end_mailed          INTEGER NOT NULL DEFAULT 0 CHECK (end_mailed IN (0, 1)),
  closed_at           INTEGER CHECK (closed_at IS NULL OR closed_at >= 0),
  version             INTEGER NOT NULL CHECK (version >= 1),
  CHECK ((state = 'OPEN') = (closed_at IS NULL))
) STRICT;
CREATE INDEX battle_announcements_open   ON battle_announcements (target_system_id) WHERE state = 'OPEN';
CREATE INDEX battle_announcements_closed ON battle_announcements (closed_at) WHERE state = 'CLOSED';

CREATE TABLE battle_announcement_recipients (
  operation_id     TEXT    NOT NULL REFERENCES battle_announcements (operation_id),
  character_id     INTEGER NOT NULL CHECK (character_id > 0),
  target_system_id INTEGER NOT NULL CHECK (target_system_id > 0),
  announced_at     INTEGER NOT NULL CHECK (announced_at >= 0),
  PRIMARY KEY (operation_id, character_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX battle_announcement_recipients_char ON battle_announcement_recipients (character_id, announced_at);
`;

function upBattleAnnouncements(db) {
  db.exec(DDL);
}

module.exports = { TABLE, RECIPIENTS_TABLE, STATE, OUTCOME, KIND_ETA, KIND_END, ANNOUNCE_EVENT, CHECK_EVENT,
  MAX_OPERATION_ID, MAX_OPERATION_TYPE, MAX_BATTLE_ID, announceKeyOf, checkKeyOf, noticeKeyOf, upBattleAnnouncements };
