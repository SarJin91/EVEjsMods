"use strict";

const TABLE_NAME = "world_sov_reconcile";

const STATE = Object.freeze({
  FOREIGN: "FOREIGN",
});

const FACT_KINDS = Object.freeze([
  "HUB_DESTROYED",
  "PLAYER_CLAIM",
  "CLAIM_LOST",
  "MOD_OTHER",
  "DEFENDED",
]);

const LOSS_KINDS = Object.freeze([
  "HUB_DESTROYED",
  "PLAYER_CLAIM",
]);

const REPROJECT_KINDS = Object.freeze([
  "DEFENDED",
  "CLAIM_LOST",
  "MOD_OTHER",
]);

const CLASSIFY_KINDS = Object.freeze([
  "HUB_DESTROYED",
  "PLAYER_CLAIM",
  "CLAIM_LOST",
  "MOD_OTHER",
  "RESTORED",
]);

const SETTLE_ACTIONS = Object.freeze([
  "LOSS_APPLIED",
  "DROP_ONLY",
  "DEFERRED",
  "SUPERSEDED",
  "REPROJECT",
  "STALE",
  "DEFENDED",
]);

const FACT_AGGREGATE = "sov_native";

const FACT_EVENT_TYPES = Object.freeze([
  "NATIVE_LOSS",
  "REPROJECT",
  "DEFENDED",
]);

const FACT_KEY_PREFIX = "sov:native:";
const FACT_KEY_RANGE_END = "sov:native;";

const MAX_CAMPAIGN_EPOCH_LENGTH = 120;

const HOLD_STATES_FOR_LOSS = Object.freeze(["STABLE", "OCCUPIED", "CONSOLIDATING"]);

const LOG_ACTION_NATIVE_LOSS = "NATIVE_LOSS";
const LOG_ACTION_REPROJECT = "REPROJECT";

const ENTRIES_PER_FACT = 3;

function upSovReconcile(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${TABLE_NAME} (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      fact_key TEXT NOT NULL,
      kind TEXT NOT NULL,
      system_id INTEGER NOT NULL,
      bound_seq INTEGER NOT NULL,
      foreign_at INTEGER NOT NULL,
      alliance_id INTEGER NOT NULL,
      controller_faction_id INTEGER,
      world_row_id INTEGER,
      action TEXT NOT NULL,
      points INTEGER NOT NULL DEFAULT 0,
      at_ms INTEGER NOT NULL,
      until_ms INTEGER,
      meta_json TEXT,
      version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(fact_key)
    );
    CREATE INDEX IF NOT EXISTS idx_${TABLE_NAME}_system_bound ON ${TABLE_NAME}(system_id, bound_seq);
    CREATE INDEX IF NOT EXISTS idx_${TABLE_NAME}_foreign_at ON ${TABLE_NAME}(foreign_at);
    CREATE INDEX IF NOT EXISTS idx_${TABLE_NAME}_alliance ON ${TABLE_NAME}(alliance_id);
  `);
}

module.exports = {
  TABLE_NAME,
  STATE,
  FACT_KINDS,
  LOSS_KINDS,
  REPROJECT_KINDS,
  CLASSIFY_KINDS,
  SETTLE_ACTIONS,
  FACT_AGGREGATE,
  FACT_EVENT_TYPES,
  FACT_KEY_PREFIX,
  FACT_KEY_RANGE_END,
  MAX_CAMPAIGN_EPOCH_LENGTH,
  HOLD_STATES_FOR_LOSS,
  LOG_ACTION_NATIVE_LOSS,
  LOG_ACTION_REPROJECT,
  ENTRIES_PER_FACT,
  upSovReconcile,
};