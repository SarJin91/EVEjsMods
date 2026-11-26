"use strict";

const SEED_VERSION = 1;
const SEED_REASON = "SEED_CONTROL";
const SEED_DONE_EVENT = "SEED_CONTROL_DONE";
const SEED_AGGREGATE_TYPE = "world_seed";
const SEED_AGGREGATE_ID = "control";
const ACCEPTED_PIRATE_SOURCES = Object.freeze(["faction_id", "region", "empire_fallback"]);
const SEED_WORK_CLASS = "MAINTENANCE";
const OVERRIDE_SCOPES = Object.freeze(["system", "constellation", "region"]);

function systemSeedKey(systemId) {
  return `world:seed:v${SEED_VERSION}:${systemId}`;
}

function seedDoneKey(scopeTag) {
  return `world:seed:v${SEED_VERSION}:done:${scopeTag}`;
}

module.exports = Object.freeze({
  SEED_VERSION,
  SEED_REASON,
  SEED_DONE_EVENT,
  SEED_AGGREGATE_TYPE,
  SEED_AGGREGATE_ID,
  ACCEPTED_PIRATE_SOURCES,
  SEED_WORK_CLASS,
  OVERRIDE_SCOPES,
  systemSeedKey,
  seedDoneKey,
});
