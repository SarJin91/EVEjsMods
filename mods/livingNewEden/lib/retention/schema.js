"use strict";

const EVENT_TYPE = "RETENTION_PASS";
const AGGREGATE_ID = "retention";
const KEY_PREFIX = "retention:pass:";
const KEY_RANGE_END = "retention:pass;";

function passKey(intervalMs, bucket) {
  return `${KEY_PREFIX}${intervalMs}:${bucket}`;
}

function rangeEndOf(prefix) {
  const i = typeof prefix === "string" ? prefix.lastIndexOf(":") : -1;
  if (i < 0) throw new TypeError(`retention: prefix without ":" (${String(prefix)})`);
  return `${prefix.slice(0, i)};${prefix.slice(i + 1)}`;
}

const DENY_PREFIXES = Object.freeze(["lne:", "strategy:react:", "sov:native:", "trade:", "stations:seed:",
  "strategy:faction:seed:", "treasury:seed:", "battle:", "tribute:", "invasion"]);

const COUNTER_NAMES = Object.freeze(["passes", "scanned", "candidates", "deletedEvents", "deletedJournal",
  "skippedYoung", "skippedPattern", "skippedState", "skippedGuard", "truncated", "sweeps", "refused"]);

module.exports = { EVENT_TYPE, AGGREGATE_ID, KEY_PREFIX, KEY_RANGE_END, passKey, rangeEndOf, DENY_PREFIXES,
  COUNTER_NAMES };
