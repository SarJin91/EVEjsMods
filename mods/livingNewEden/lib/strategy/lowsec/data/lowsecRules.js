"use strict";

const CAMP_KINDS = Object.freeze(["pirate"]);
const CAMP_ROLES = Object.freeze(["patrol"]);
const CAMP_OPERATION_TYPE = "camp";
const CAMP_OBJECTIVE = "patrol";
const PLAN_SKIP_REASONS = Object.freeze(["LIMIT", "FACTION_LIMIT", "NO_FLEET", "NO_TARGET", "PLAN_REFUSED"]);
const RETRYABLE_REASONS = Object.freeze(["QUEUE_FULL", "ENQUEUE_FAILED", "SCHEDULER_UNAVAILABLE", "GRAPH_NOT_READY",
  "TRAVEL_UNAVAILABLE", "TX_REQUIRED"]);

module.exports = {
  CAMP_KINDS,
  CAMP_ROLES,
  CAMP_OPERATION_TYPE,
  CAMP_OBJECTIVE,
  PLAN_SKIP_REASONS,
  RETRYABLE_REASONS,
};
