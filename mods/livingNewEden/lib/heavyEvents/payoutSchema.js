"use strict";

const PAYOUTS_TABLE = "world_heavy_event_payouts";

const DDL = `
CREATE TABLE world_heavy_event_payouts (
  payout_key        TEXT    PRIMARY KEY,
  event_id          TEXT    NOT NULL,
  character_id      INTEGER NOT NULL,
  issuer_faction_id INTEGER NOT NULL,
  system_id         INTEGER NOT NULL,
  lp_corporation_id INTEGER,
  isk_amount        INTEGER NOT NULL CHECK (isk_amount >= 0),
  lp_amount         INTEGER NOT NULL CHECK (lp_amount >= 0),
  standing_micro    INTEGER NOT NULL CHECK (standing_micro >= 0),
  description       TEXT    NOT NULL,
  isk_state         TEXT    NOT NULL,
  lp_state          TEXT    NOT NULL,
  std_state         TEXT    NOT NULL,
  state             TEXT    NOT NULL,
  attempts          INTEGER NOT NULL DEFAULT 0,
  next_attempt_at   INTEGER NOT NULL,
  last_error        TEXT,
  planned_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
) STRICT;
CREATE INDEX world_heavy_event_payouts_due ON world_heavy_event_payouts (next_attempt_at) WHERE state = 'PENDING';
CREATE INDEX world_heavy_event_payouts_closed ON world_heavy_event_payouts (updated_at) WHERE state <> 'PENDING';
`;

function upHeavyEventPayouts(db) {
  db.exec(DDL);
}

const LEG_STATE = Object.freeze({ PENDING: "PENDING", DONE: "DONE", SKIPPED: "SKIPPED", FAILED: "FAILED" });
const ROW_STATE = Object.freeze({ PENDING: "PENDING", PAID: "PAID", FAILED: "FAILED" });

const STANDING_REASON = "HEAVY_EVENT_DEFENSE";
const WORLD_STANDING_REASON = "EVENT_ANOMALY";
const STANDING_DATA = Object.freeze({
  eventTypeId: 486,
  msgByReason: Object.freeze({ [STANDING_REASON]: "Outpost defense (Living New Eden)",
    [WORLD_STANDING_REASON]: "Event anomaly (Living New Eden)" }),
});
const ISK_SOURCE = "lne-heavyevents";
const DESCRIPTION = "Living New Eden: outpost defense";
const WORLD_DESCRIPTION = "Living New Eden: event anomaly";

const REWARD_EVENT_PREFIXES = Object.freeze(["nincursion:reward:", "finc:reward:"]);
const REWARD_DESCRIPTION = "Living New Eden: incursion defense";
const MAX_REWARD_CHARACTERS = 256;

const payoutKeyOf = (eventId, characterId) => `${eventId}:${characterId}`;

module.exports = {
  PAYOUTS_TABLE,
  upHeavyEventPayouts,
  LEG_STATE,
  ROW_STATE,
  STANDING_REASON,
  WORLD_STANDING_REASON,
  STANDING_DATA,
  ISK_SOURCE,
  DESCRIPTION,
  WORLD_DESCRIPTION,
  REWARD_EVENT_PREFIXES,
  REWARD_DESCRIPTION,
  MAX_REWARD_CHARACTERS,
  payoutKeyOf,
};
