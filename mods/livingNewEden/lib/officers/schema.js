"use strict";

const SOURCES = Object.freeze({ HUNT: "hunt", SALVAGE: "salvage" });

const REASONS = Object.freeze({
  DISABLED: "DISABLED",
  SOURCE_DISABLED: "SOURCE_DISABLED",
  INVALID_INPUT: "INVALID_INPUT",
  CHANCE_MISS: "CHANCE_MISS",
  NOT_PIRATE: "NOT_PIRATE",
  DUPLICATE: "DUPLICATE",
  LIMIT_SYSTEM: "LIMIT_SYSTEM",
  LIMIT_DAY: "LIMIT_DAY",
  TX_FAILED: "TX_FAILED",
  SEAM_UNAVAILABLE: "SEAM_UNAVAILABLE",
  SCENE_NOT_LOADED: "SCENE_NOT_LOADED",
  NO_SHIP: "NO_SHIP",
  NOT_ELIGIBLE: "NOT_ELIGIBLE",
  RESERVE_REFUSED: "RESERVE_REFUSED",
  SPAWN_FAILED: "SPAWN_FAILED",
});

const STUB_DISABLED = "OFFICER_SPAWNS_DISABLED";
const STUB_STOPPED = "stopped";

const QUIET_REASONS = Object.freeze([REASONS.DISABLED, REASONS.SOURCE_DISABLED, REASONS.CHANCE_MISS, STUB_DISABLED,
  STUB_STOPPED]);

const COUNTER_NAMES = Object.freeze(["attempt", "chanceMiss", "notPirate", "notEligible", "noShip", "sceneNotLoaded",
  "duplicate", "limitSystem", "limitDay", "reserved", "spawned", "spawnFailed", "error", "source.hunt",
  "source.salvage"]);

const AGGREGATE = "lne_officer";
const EVENT = "OFFICER_SPAWN_RESERVED";
const SOURCE_EVENT = "OFFICER_SOURCE_USED";
const KEY_PREFIX = "officer";
const SOURCE_KEY_PART = "src";
const DAY_MS = 86400000;

module.exports = { SOURCES, REASONS, STUB_DISABLED, STUB_STOPPED, QUIET_REASONS, COUNTER_NAMES, AGGREGATE, EVENT, SOURCE_EVENT, KEY_PREFIX, SOURCE_KEY_PART,
  DAY_MS };
