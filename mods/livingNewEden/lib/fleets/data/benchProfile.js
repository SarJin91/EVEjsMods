"use strict";

const BENCH_FACTIONS = Object.freeze([500010, 500011, 500012, 500019, 500020]);

const BENCH_COMPOSITIONS = Object.freeze([
  Object.freeze([Object.freeze({ hullGroup: "frigate", count: 6 }), Object.freeze({ hullGroup: "tackle", count: 2 })]),
  Object.freeze([Object.freeze({ hullGroup: "cruiser", count: 4 }),
    Object.freeze({ hullGroup: "logistics", count: 1 })]),
  Object.freeze([Object.freeze({ hullGroup: "destroyer", count: 3 }), Object.freeze({ hullGroup: "cruiser", count: 2 }),
    Object.freeze({ hullGroup: "frigate", count: 3 })]),
]);

const ROAM_TARGET_TRIES = 4;
const DWELL_SPREAD_MIN = 0.5;
const DWELL_SPREAD_SPAN = 1;
const BENCH_START_SEC_CLASS = "nullsec";

const BENCH_OPERATION = Object.freeze({ operationType: "patrol", objective: "patrol", fleetRole: "patrol",
  doctrineId: "lne-bench" });

module.exports = { BENCH_FACTIONS, BENCH_COMPOSITIONS, ROAM_TARGET_TRIES, DWELL_SPREAD_MIN, DWELL_SPREAD_SPAN,
  BENCH_START_SEC_CLASS, BENCH_OPERATION };
