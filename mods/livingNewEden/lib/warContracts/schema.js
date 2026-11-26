"use strict";

const TABLE = "world_war_contracts";

const DDL = `
CREATE TABLE world_war_contracts (
  offer_id          TEXT    PRIMARY KEY NOT NULL CHECK (length(offer_id) BETWEEN 4 AND 64),
  faction_id        INTEGER NOT NULL CHECK (faction_id > 0),
  station_id        TEXT    NOT NULL CHECK (length(station_id) BETWEEN 1 AND 64),
  system_id         INTEGER NOT NULL CHECK (system_id > 0),
  item_kind         TEXT    NOT NULL CHECK (length(item_kind) BETWEEN 1 AND 16),
  item_key          TEXT    NOT NULL CHECK (length(item_key) BETWEEN 1 AND 64),
  type_id           INTEGER NOT NULL CHECK (type_id > 0),
  quantity          INTEGER NOT NULL CHECK (quantity >= 1),
  isk_total         INTEGER NOT NULL CHECK (isk_total >= 0),
  state             TEXT    NOT NULL CHECK (length(state) BETWEEN 1 AND 16),
  end_reason        TEXT    CHECK (end_reason IS NULL OR length(end_reason) BETWEEN 1 AND 32),
  character_id      INTEGER CHECK (character_id IS NULL OR character_id > 0),
  lp_corporation_id INTEGER CHECK (lp_corporation_id IS NULL OR lp_corporation_id > 0),
  isk_amount        INTEGER NOT NULL CHECK (isk_amount >= 0),
  lp_amount         INTEGER NOT NULL CHECK (lp_amount >= 0),
  standing_micro    INTEGER NOT NULL CHECK (standing_micro >= 0),
  description       TEXT    NOT NULL CHECK (length(description) BETWEEN 1 AND 120),
  isk_state         TEXT,
  lp_state          TEXT,
  std_state         TEXT,
  payout_state      TEXT,
  attempts          INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at   INTEGER,
  last_error        TEXT    CHECK (last_error IS NULL OR length(last_error) <= 120),
  adopted_at        INTEGER NOT NULL,
  awarded_at        INTEGER,
  ended_at          INTEGER,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  version           INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1)
) STRICT;
CREATE INDEX world_war_contracts_open ON world_war_contracts (faction_id, offer_id) WHERE state = 'OPEN';
CREATE INDEX world_war_contracts_due ON world_war_contracts (next_attempt_at) WHERE payout_state = 'PENDING';
CREATE INDEX world_war_contracts_awards ON world_war_contracts (character_id, awarded_at) WHERE awarded_at IS NOT NULL;
CREATE INDEX world_war_contracts_ended ON world_war_contracts (ended_at) WHERE ended_at IS NOT NULL;
`;

function upWarContracts(db) {
  db.exec(DDL);
}

const STATE = Object.freeze({ OPEN: "OPEN", AWARDED: "AWARDED", CAPPED: "CAPPED", LAPSED: "LAPSED" });
const LEG = Object.freeze({ PENDING: "PENDING", DONE: "DONE", SKIPPED: "SKIPPED", FAILED: "FAILED" });
const PAYOUT = Object.freeze({ PENDING: "PENDING", PAID: "PAID", FAILED: "FAILED" });
const WAR_OFFER_PREFIX = "to_";
const MAX_DESCRIPTION = 120;
const MAX_END_REASON = 32;
const END_REASON_OFFER_GONE = "OFFER_GONE";
const END_REASON_DAILY_CAP = "DAILY_CAP";
const END_REASON_NO_CHARACTER = "NO_CHARACTER_ACCEPTOR";
const DELIVER_REF_LIMIT = 50;
const LIST_OPEN_MAX = 50;

const WAR_PAYOUT_KEY_PREFIX = "wc:";

const payoutKeyOf = (offerId) => `${WAR_PAYOUT_KEY_PREFIX}${offerId}`;

module.exports = {
  TABLE,
  upWarContracts,
  STATE,
  LEG,
  PAYOUT,
  WAR_OFFER_PREFIX,
  MAX_DESCRIPTION,
  MAX_END_REASON,
  END_REASON_OFFER_GONE,
  END_REASON_DAILY_CAP,
  END_REASON_NO_CHARACTER,
  DELIVER_REF_LIMIT,
  LIST_OPEN_MAX,
  WAR_PAYOUT_KEY_PREFIX,
  payoutKeyOf,
};
