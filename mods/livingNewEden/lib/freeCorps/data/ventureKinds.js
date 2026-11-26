"use strict";

const VENTURE_KINDS = Object.freeze(["MINE", "HAUL", "RAT", "EXPLORE", "BUILD", "RUN", "EXPLORE_WH", "HUNT",
  "WH_HOME", "WH_RAID", "WH_HAUL"]);

const kind = (needs, riskPermille, yieldKey, homeAllowed, extra) => Object.freeze({ needs, riskPermille, yieldKey,
  homeAllowed, ...(extra || {}) });

const KIND_DATA = Object.freeze({
  MINE: kind("belts", 1000, "mine", true),
  HAUL: kind("station", 800, "haul", false),
  RAT: kind("belts", 1500, "rat", true),
  EXPLORE: kind("none", 1200, "explore", false),
  BUILD: kind("home", 0, null, true),
  RUN: kind("station", 700, "run", true),
  EXPLORE_WH: kind("wormhole", 1200, null, true, { yieldFrom: "wormholes" }),
  HUNT: kind("hunt", 0, null, true, { yieldFrom: "hunting" }),
  WH_HOME: kind("whCorp", 0, null, true),
  WH_RAID: kind("whCorp", 0, null, true),
  WH_HAUL: kind("whCorp", 0, null, true),
});

const w = (pairs) => Object.freeze(pairs.map((p) => Object.freeze(p)));

const ARCHETYPE_KINDS = Object.freeze({
  miner: w([["MINE", 80], ["HAUL", 20]]),
  hauler: w([["HAUL", 85], ["MINE", 15]]),
  ratter: w([["RAT", 85], ["EXPLORE", 15]]),
  explorer: w([["EXPLORE", 85], ["RAT", 15]]),
  industrialist: w([["BUILD", 70], ["HAUL", 30]]),
  missioner: w([["RUN", 85], ["HAUL", 15]]),
  hunter: w([["HUNT", 100]]),
  structure: w([["RAT", 60], ["MINE", 40]]),
});

const WH_ARCHETYPE_KINDS = Object.freeze({ explorer: Object.freeze(["EXPLORE_WH"]) });

module.exports = { VENTURE_KINDS, KIND_DATA, ARCHETYPE_KINDS, WH_ARCHETYPE_KINDS };
