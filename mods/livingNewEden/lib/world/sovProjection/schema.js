"use strict";

const TABLE_NAME = "world_sov_projection_log";

const AGGREGATE = "world_system";

const EVENT_TYPE = "SOV_PROJECTION";

const ACTION = Object.freeze({
  GAIN: "GAIN",
  LOSS: "LOSS",
  TRANSFER: "TRANSFER",
  REINFORCE: "REINFORCE",
  SYNC: "SYNC",
});

const CLAIM_ACTIONS = Object.freeze([ACTION.GAIN, ACTION.TRANSFER, ACTION.REINFORCE, ACTION.SYNC]);

const MAX_ACTION_LENGTH = 32;
const MAX_LOG_IDS = 2000;

const IDEMPOTENCY_PREFIX = "sov:proj:";

function idempotencyKey(systemId, phaseSeq, action, logVersion) {
  return `${IDEMPOTENCY_PREFIX}${systemId}:${phaseSeq}:${action}:${logVersion}`;
}

function upSovProjectionLog(db) {
  db.exec(`CREATE TABLE ${TABLE_NAME} (
    system_id       INTEGER PRIMARY KEY NOT NULL CHECK (system_id > 0),
    last_controller INTEGER CHECK (last_controller IS NULL OR last_controller > 0),
    last_alliance   INTEGER CHECK (last_alliance IS NULL OR last_alliance > 0),
    last_corp       INTEGER CHECK (last_corp IS NULL OR last_corp > 0),
    last_action     TEXT    NOT NULL CHECK (length(last_action) BETWEEN 1 AND ${MAX_ACTION_LENGTH}),
    last_seq        INTEGER NOT NULL CHECK (last_seq >= 0),
    updated_at      INTEGER NOT NULL CHECK (updated_at >= 0),
    version         INTEGER NOT NULL CHECK (version >= 1)
  ) STRICT, WITHOUT ROWID;`);
}

module.exports = {
  TABLE_NAME,
  AGGREGATE,
  EVENT_TYPE,
  ACTION,
  CLAIM_ACTIONS,
  MAX_ACTION_LENGTH,
  MAX_LOG_IDS,
  IDEMPOTENCY_PREFIX,
  idempotencyKey,
  upSovProjectionLog,
};