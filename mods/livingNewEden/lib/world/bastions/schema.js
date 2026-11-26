"use strict";

const EVENT_TYPE = "WORLD_BASTION_RECONCILE";
const AGGREGATE_ID = "all";
const PAYLOAD_KEYS = Object.freeze(["after", "bucket"]);
const START_AFTER = "0";
const RESTORE_KEY_PREFIX = "world:bastion:v1:";
const RECONCILE_KEY_PREFIX = "world:bastion:reconcile:";
const FIXED_ROWS = 2;
const RESTORE_BASE_ROWS = 5;
const MAX_DRIFT_LOG_LINES = 5;
const STATION_RETURN_AGGREGATE = "world_bastion_station";
const EVENT_STATION_RETURNED = "BASTION_STATION_RETURNED";
const STATION_RETURN_BASE_ROWS = 6;

const restoreKeyBase = (systemId) => `${RESTORE_KEY_PREFIX}${systemId}`;

const stationReturnKey = (systemId, stationId, version) => `${restoreKeyBase(systemId)}:station:${stationId}:${version}`;

const reconcileKey = (bucket, after) => `${RECONCILE_KEY_PREFIX}${bucket}:${after}`;

module.exports = {
  EVENT_TYPE,
  AGGREGATE_ID,
  PAYLOAD_KEYS,
  START_AFTER,
  RESTORE_KEY_PREFIX,
  RECONCILE_KEY_PREFIX,
  FIXED_ROWS,
  RESTORE_BASE_ROWS,
  MAX_DRIFT_LOG_LINES,
  STATION_RETURN_AGGREGATE,
  EVENT_STATION_RETURNED,
  STATION_RETURN_BASE_ROWS,
  restoreKeyBase,
  stationReturnKey,
  reconcileKey,
};
