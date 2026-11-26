"use strict";

const STATE = Object.freeze({ QUIET: "QUIET", DUE: "DUE", EXHAUSTED: "EXHAUSTED" });
const OUTCOME = Object.freeze({ SPAWNED: "spawned", DEFERRED: "deferred", REFUSED: "refused" });
const DEFERRAL = Object.freeze(["BELT_BUSY", "SYSTEM_LIMIT", "GOVERNOR", "RATE_LIMIT"]);
const REFUSAL = Object.freeze(["HIGHSEC_OFF", "BAND_INELIGIBLE", "EXHAUSTED", "NO_SESSION", "DOCKED", "NO_SHIP",
  "NOT_AT_BELT", "SCENE_NOT_LOADED", "VENDOR_RATS_OFF", "SPAWN_FAILED", "SEAM_UNAVAILABLE", "READ_FAILED"]);
const SPECIAL_KINDS = Object.freeze(["officer", "commander", "hauler"]);
const BANDS = Object.freeze(["highsec", "lowsec", "nullsec"]);
const ANOMALY_YIELD_KIND = "ore";
const WORK_CLASS = "OPERATIONAL";
const MINUTE_MS = 60000;
const METRIC_FLUSH_MS = "world.miningEncounters.flushMs";
const HAULER_COUNTERS = Object.freeze(["tracked", "warpOut", "gone", "failed", "dropped"]);
const COUNTER_NAMES = Object.freeze(["noise", "due", "wave",
  ...SPECIAL_KINDS.map((kind) => `special.${kind}`),
  "degraded",
  ...DEFERRAL.map((reason) => `deferred.${reason}`),
  ...REFUSAL.map((reason) => `refused.${reason}`),
  "capped", "chanceMiss", "evicted", "hookError",
  ...HAULER_COUNTERS.map((name) => `hauler.${name}`)]);

module.exports = { STATE, OUTCOME, DEFERRAL, REFUSAL, SPECIAL_KINDS, BANDS, ANOMALY_YIELD_KIND, WORK_CLASS, MINUTE_MS, METRIC_FLUSH_MS,
  COUNTER_NAMES };
