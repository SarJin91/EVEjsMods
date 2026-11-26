"use strict";

const EXPEDITION_KINDS = Object.freeze(["pirate"]);
const EXPEDITION_ROLES = Object.freeze(["patrol"]);
const EXCLUDED_HULL_GROUPS = Object.freeze(["capital", "carrier", "dreadnought", "force_auxiliary", "supercarrier",
  "titan"]);
const OPERATION_TYPE = "expedition";
const OBJECTIVE_OUT = "expedition";
const OBJECTIVE_RETURN = "return";
const OBJECTIVE_HOLD = "hold";
const KSPACE_CLASSES = Object.freeze(["highsec", "lowsec", "nullsec"]);
const JSPACE_CLASS = "wormhole";
const PLAN_SKIP_REASONS = Object.freeze(["LIMIT", "FACTION_LIMIT", "NO_FLEET", "NO_TARGET", "EXPIRES_TOO_SOON",
  "NOT_SYNCED", "TOO_MASSIVE", "PLAN_REFUSED"]);
const RETRYABLE_REASONS = Object.freeze(["QUEUE_FULL", "ENQUEUE_FAILED", "SCHEDULER_UNAVAILABLE", "GRAPH_NOT_READY",
  "TRAVEL_UNAVAILABLE", "TX_REQUIRED"]);
const EVAC_ROUTE_REFUSALS = Object.freeze(["UNREACHABLE", "TOO_FAR", "SAME_SYSTEM", "WORMHOLE_CLOSES_EN_ROUTE",
  "WORMHOLE_NOT_YET_OPEN", "UNKNOWN_SYSTEM"]);

module.exports = {
  EXPEDITION_KINDS,
  EXPEDITION_ROLES,
  EXCLUDED_HULL_GROUPS,
  OPERATION_TYPE,
  OBJECTIVE_OUT,
  OBJECTIVE_RETURN,
  OBJECTIVE_HOLD,
  KSPACE_CLASSES,
  JSPACE_CLASS,
  PLAN_SKIP_REASONS,
  RETRYABLE_REASONS,
  EVAC_ROUTE_REFUSALS,
};
