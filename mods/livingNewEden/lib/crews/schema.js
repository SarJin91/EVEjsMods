"use strict";

const TABLES = Object.freeze({
  crews: "world_fleet_crews",
  seats: "world_fleet_crew_seats",
  pilots: "world_crew_pilots",
});

const CAUSES = Object.freeze({ BATTLE: "BATTLE", LIVE: "LIVE", SHRINK: "SHRINK", GONE: "GONE", STALE: "STALE",
  RECLAIM: "RECLAIM" });
const LOSS_CAUSES = Object.freeze([CAUSES.BATTLE, CAUSES.LIVE]);
const PRIORITY = Object.freeze({ OBSERVED: "OBSERVED", MATERIALIZE: "MATERIALIZE", BACKGROUND: "BACKGROUND" });
const PROTECTED_FLEET_STATES = Object.freeze(["MATERIALIZED", "ENGAGED"]);

const COUNTER_NAMES = Object.freeze(["passes", "deferrals", "enlisted", "released", "lost", "reclaimed", "stale",
  "shortfall", "truncated", "errors"]);
const GAUGE_NAMES = Object.freeze(["crewedFleets", "seatedPilots"]);
const HISTOGRAM_NAMES = Object.freeze(["passMs"]);
const WORK_CLASS = "MAINTENANCE";
const STATE = Object.freeze({ STARTING: "starting", RUNNING: "running", STOPPED: "stopped" });

const AGGREGATE = "fleet_crew";
const EVENT_LIVE_LOSS = "CREW_LIVE_LOSS";
const EVENT_RECONCILE = "CREW_RECONCILE";
const KEY_PREFIX = "crew:";

const FACADE_METHODS = Object.freeze(["runPassNow", "requestEnlist", "listSeatsInTx", "describe", "summarizeInTx",
  "listPilotStatsInTx", "seatsForMaterializationInTx", "recordLiveLossInTx", "reconcileGuardedInTx", "getStatus", "stop"]);

module.exports = { TABLES, CAUSES, LOSS_CAUSES, PRIORITY, PROTECTED_FLEET_STATES, COUNTER_NAMES, GAUGE_NAMES,
  HISTOGRAM_NAMES, WORK_CLASS, STATE, AGGREGATE, EVENT_LIVE_LOSS, EVENT_RECONCILE, KEY_PREFIX, FACADE_METHODS };
