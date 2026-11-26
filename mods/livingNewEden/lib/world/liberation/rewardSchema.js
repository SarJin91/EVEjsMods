"use strict";

const CONTRIBUTIONS_TABLE = "world_liberation_contributions";
const PAYOUTS_TABLE = "world_liberation_payouts";

const DDL = `
CREATE TABLE world_liberation_contributions (
  system_id             INTEGER NOT NULL CHECK (system_id > 0),
  controller_faction_id INTEGER NOT NULL CHECK (controller_faction_id > 0),
  character_id          INTEGER NOT NULL CHECK (character_id > 0),
  kills                 INTEGER NOT NULL CHECK (kills >= 1),
  first_at              INTEGER NOT NULL,
  last_at               INTEGER NOT NULL,
  PRIMARY KEY (system_id, controller_faction_id, character_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX world_liberation_contributions_last ON world_liberation_contributions (last_at);

CREATE TABLE world_liberation_payouts (
  payout_key             TEXT    PRIMARY KEY,
  liberation_key         TEXT    NOT NULL,
  system_id              INTEGER NOT NULL,
  character_id           INTEGER NOT NULL,
  controller_faction_id  INTEGER NOT NULL,
  beneficiary_faction_id INTEGER,
  lp_corporation_id      INTEGER,
  kills                  INTEGER NOT NULL,
  isk_amount             INTEGER NOT NULL CHECK (isk_amount >= 0),
  lp_amount              INTEGER NOT NULL CHECK (lp_amount >= 0),
  description            TEXT    NOT NULL,
  isk_state              TEXT    NOT NULL,
  lp_state               TEXT    NOT NULL,
  state                  TEXT    NOT NULL,
  attempts               INTEGER NOT NULL DEFAULT 0,
  next_attempt_at        INTEGER NOT NULL,
  last_error             TEXT,
  planned_at             INTEGER NOT NULL,
  updated_at             INTEGER NOT NULL
) STRICT;
CREATE INDEX world_liberation_payouts_due ON world_liberation_payouts (next_attempt_at) WHERE state = 'PENDING';
CREATE INDEX world_liberation_payouts_system ON world_liberation_payouts (system_id, planned_at);
CREATE INDEX world_liberation_payouts_closed ON world_liberation_payouts (updated_at) WHERE state <> 'PENDING';
`;

function upLiberationRewards(db) {
  db.exec(DDL);
}

const KEY_PREFIX = "libpay";
const AGGREGATE_TYPE = "liberation_reward";
const LIBERATION_REWARD = "LIBERATION_REWARD";
const LEG_STATE = Object.freeze({ PENDING: "PENDING", DONE: "DONE", SKIPPED: "SKIPPED", FAILED: "FAILED" });
const ROW_STATE = Object.freeze({ PENDING: "PENDING", PAID: "PAID", FAILED: "FAILED" });
const MAX_DESCRIPTION = 120;

const LP_CORP_BY_FACTION = Object.freeze({
  500001: 1000035,
  500002: 1000051,
  500003: 1000084,
  500004: 1000120,
  500006: 1000137,
});

const libpayKey = (systemId, phaseSeq, atMs) => `${KEY_PREFIX}:${systemId}:${phaseSeq}:${atMs}`;
const payoutKeyOf = (liberationKey, characterId) => `${liberationKey}:${characterId}`;
const descriptionOf = (systemName, systemId) =>
  `Living New Eden: liberation of ${systemName || systemId}`.slice(0, MAX_DESCRIPTION);

module.exports = {
  CONTRIBUTIONS_TABLE,
  PAYOUTS_TABLE,
  upLiberationRewards,
  KEY_PREFIX,
  AGGREGATE_TYPE,
  LIBERATION_REWARD,
  LEG_STATE,
  ROW_STATE,
  MAX_DESCRIPTION,
  LP_CORP_BY_FACTION,
  libpayKey,
  payoutKeyOf,
  descriptionOf,
};
