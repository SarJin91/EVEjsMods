"use strict";

const TREASURY_TABLE_NAME = "world_faction_treasury";
const DAYS_TABLE_NAME = "world_faction_treasury_days";
const AGGREGATE = "faction_treasury";
const EVENT_SEEDED = "TREASURY_SEEDED";
const EVENT_SETTLED = "TREASURY_SETTLED";
const MODE_NORMAL = "NORMAL";
const MODE_AUSTERITY = "AUSTERITY";
const DAY_MS = 86400000;
const MAX_ISK = 1e15;
const TREASURY_ROWS = 10;
const TREASURY_LOSS_ROWS_BOUND = 11;
const KINDS = Object.freeze(["empire", "police", "pirate", "invader", "neutral"]);
const DAY_SUM_COLUMNS = Object.freeze(["trade_out"]);
const MAX_DAYS_READ = 32;

const seedKey = (factionId) => `treasury:seed:v1:${factionId}`;
const dayOf = (at) => Math.floor(at / DAY_MS);

function upTreasury(db) {
  db.exec(`CREATE TABLE world_faction_treasury (
  faction_id            INTEGER PRIMARY KEY NOT NULL CHECK (faction_id > 0),
  kind                  TEXT    NOT NULL CHECK (length(kind) BETWEEN 1 AND 16),
  initial_isk           INTEGER NOT NULL CHECK (initial_isk BETWEEN 0 AND 1000000000000000),
  isk_balance           INTEGER NOT NULL CHECK (isk_balance BETWEEN 0 AND 1000000000000000),
  mode                  TEXT    NOT NULL DEFAULT 'NORMAL' CHECK (length(mode) BETWEEN 1 AND 16),
  paid_until            INTEGER CHECK (paid_until IS NULL OR paid_until >= 0),
  mode_changed_at       INTEGER CHECK (mode_changed_at IS NULL OR mode_changed_at >= 0),
  income_total          INTEGER NOT NULL DEFAULT 0 CHECK (income_total BETWEEN 0 AND 1000000000000000),
  fleet_upkeep_total    INTEGER NOT NULL DEFAULT 0 CHECK (fleet_upkeep_total BETWEEN 0 AND 1000000000000000),
  production_fee_total  INTEGER NOT NULL DEFAULT 0 CHECK (production_fee_total BETWEEN 0 AND 1000000000000000),
  loss_total            INTEGER NOT NULL DEFAULT 0 CHECK (loss_total BETWEEN 0 AND 1000000000000000),
  loss_value_total      INTEGER NOT NULL DEFAULT 0 CHECK (loss_value_total BETWEEN 0 AND 1000000000000000),
  ships_lost_total      INTEGER NOT NULL DEFAULT 0 CHECK (ships_lost_total BETWEEN 0 AND 1000000000000000),
  trade_out_total       INTEGER NOT NULL DEFAULT 0 CHECK (trade_out_total BETWEEN 0 AND 1000000000000000),
  trade_in_total        INTEGER NOT NULL DEFAULT 0 CHECK (trade_in_total BETWEEN 0 AND 1000000000000000),
  unpaid_total          INTEGER NOT NULL DEFAULT 0 CHECK (unpaid_total BETWEEN 0 AND 1000000000000000),
  created_at            INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at            INTEGER NOT NULL CHECK (updated_at >= 0),
  version               INTEGER NOT NULL CHECK (version >= 1)
) STRICT;
CREATE TABLE world_faction_treasury_days (
  faction_id       INTEGER NOT NULL CHECK (faction_id > 0),
  day              INTEGER NOT NULL CHECK (day >= 0),
  income           INTEGER NOT NULL DEFAULT 0 CHECK (income >= 0),
  fleet_upkeep     INTEGER NOT NULL DEFAULT 0 CHECK (fleet_upkeep >= 0),
  production_fees  INTEGER NOT NULL DEFAULT 0 CHECK (production_fees >= 0),
  losses           INTEGER NOT NULL DEFAULT 0 CHECK (losses >= 0),
  loss_value       INTEGER NOT NULL DEFAULT 0 CHECK (loss_value >= 0),
  ships_lost       INTEGER NOT NULL DEFAULT 0 CHECK (ships_lost >= 0),
  trade_out        INTEGER NOT NULL DEFAULT 0 CHECK (trade_out >= 0),
  trade_in         INTEGER NOT NULL DEFAULT 0 CHECK (trade_in >= 0),
  unpaid           INTEGER NOT NULL DEFAULT 0 CHECK (unpaid >= 0),
  balance_end      INTEGER NOT NULL CHECK (balance_end >= 0),
  updated_at       INTEGER NOT NULL CHECK (updated_at >= 0),
  PRIMARY KEY (faction_id, day)
) STRICT;
CREATE INDEX world_faction_treasury_days_day ON world_faction_treasury_days (day);`);
}

const DDL_MERC = Object.freeze([
  "ALTER TABLE world_faction_treasury ADD COLUMN merc_fee_total INTEGER NOT NULL DEFAULT 0 "
    + "CHECK (merc_fee_total BETWEEN 0 AND 1000000000000000)",
  "ALTER TABLE world_faction_treasury ADD COLUMN merc_refund_total INTEGER NOT NULL DEFAULT 0 "
    + "CHECK (merc_refund_total BETWEEN 0 AND 1000000000000000)",
  "ALTER TABLE world_faction_treasury_days ADD COLUMN merc_fees INTEGER NOT NULL DEFAULT 0 CHECK (merc_fees >= 0)",
  "ALTER TABLE world_faction_treasury_days ADD COLUMN merc_refunds INTEGER NOT NULL DEFAULT 0 "
    + "CHECK (merc_refunds >= 0)",
]);

function upTreasuryMerc(db) {
  for (const sql of DDL_MERC) db.exec(sql);
}

const DDL_PRESSURE = Object.freeze([
  "ALTER TABLE world_faction_treasury ADD COLUMN admin_total INTEGER NOT NULL DEFAULT 0 "
    + "CHECK (admin_total BETWEEN 0 AND 1000000000000000)",
  "ALTER TABLE world_faction_treasury ADD COLUMN war_spend_total INTEGER NOT NULL DEFAULT 0 "
    + "CHECK (war_spend_total BETWEEN 0 AND 1000000000000000)",
  "ALTER TABLE world_faction_treasury_days ADD COLUMN admin INTEGER NOT NULL DEFAULT 0 CHECK (admin >= 0)",
  "ALTER TABLE world_faction_treasury_days ADD COLUMN war_spend INTEGER NOT NULL DEFAULT 0 CHECK (war_spend >= 0)",
]);

function upTreasuryPressure(db) {
  for (const sql of DDL_PRESSURE) db.exec(sql);
}

module.exports = {
  TREASURY_TABLE_NAME,
  DAYS_TABLE_NAME,
  AGGREGATE,
  EVENT_SEEDED,
  EVENT_SETTLED,
  MODE_NORMAL,
  MODE_AUSTERITY,
  DAY_MS,
  MAX_ISK,
  TREASURY_ROWS,
  TREASURY_LOSS_ROWS_BOUND,
  KINDS,
  DAY_SUM_COLUMNS,
  MAX_DAYS_READ,
  seedKey,
  dayOf,
  upTreasury,
  upTreasuryMerc,
  upTreasuryPressure,
};
