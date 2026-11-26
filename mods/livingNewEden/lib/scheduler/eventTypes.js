"use strict";

const { WORK_CLASS, WORK_CLASS_ORDER } = require("../telemetry/loadGovernor");

const MIN_PRIORITY = 1;
const MAX_PRIORITY = WORK_CLASS_ORDER.length;

const ROWS = [
  ["BATTLE_RESOLUTION", 1, "battle", false, "finished fights"],
  ["BATTLE_LIVE_RECOVER", 1, "battle", false, "LIVE_EVEJS battle of a previous boot: revert or exit"],
  ["CONVOY_DELIVERY", 1, "convoy", false, "deliveries; every step of a convoy"],
  ["FLEET_ARRIVAL", 3, "fleet", false, "fleet arrivals"],
  ["BATTLE_CONTACT_CHECK", 3, "world_system", false, "contact check after an arrival / a settlement (a fact)"],
  ["FLEET_OPERATION_COMPLETE", 3, "operation", false, "end of a fleet operation"],
  ["FLEET_REFIT_COMPLETE", 3, "fleet", false, "repair deadline of a fleet"],
  ["FLEET_REFIT_SEEK", 4, "fleet", false, "search for a repair station"],
  ["FLEET_GRID_ARRIVAL", 3, "fleet", false, "grid in-system move end of a fleet"],
  ["GRID_DEFENSE_ALERT", 3, "world_system", false, "grid alert of a garrison: SEEN / LOCATE of an intruder"],
  ["GRID_DEFENSE_STEP", 3, "fleet", false, "grid step of a defender: POST / ARRIVED / LOCATE / RETURN"],
  ["FLEET_GRID_CROSSING", 3, "fleet", false, "grid gate check of a fleet in transit"],
  ["OCCUPATION_PHASE_CHANGE", 3, "world_system", false, "occupation phase change"],
  ["LIBERATION_CHECK", 3, "world_system", false, "the influence of the controller stayed below the threshold"],
  ["SUPPLY_RECHECK", 3, "faction", true, "periodic check; may raise it to 1 if resource use moves here"],
  ["WORMHOLE_EXPIRE", 3, "wormhole", false, "changes the routes of fleets on the way"],
  ["FACTION_STRATEGY_REVIEW", 4, "faction", true, "full strategy review of a faction"],
  ["FACTION_REACTIVE_REVIEW", 4, "faction", true, "light review between full reviews "
    + "(defense, relief); legacy: drained SUPERSEDED"],
  ["FACTION_REACTIVE_SWEEP", 4, "strategy", true, "one reactive round of every "
    + "active faction"],
  ["STRATEGY_TERRITORY_TRIM", 4, "faction", false, "one batch of abandons of the seeded territory trim"],
  ["BENCH_FLEET_ROAM", 4, "fleet", true, "test traffic (testing.benchFleets)"],
  ["SITE_REFRESH", 5, "director", true, "one global Event Director pulse (boot reconcile pulse)"],
  ["BATTLE_RECONCILE", 5, "battle", false, "once after each start: open battles without an event"],
  ["WRECK_FIELD_EXPIRE", 5, "wreck_field", false, "TTL of a wreck field (a fact, late is invisible)"],
  ["MINING_TRIP_STEP", 3, "mining_trip", false, "mining trip deadline / arrival nudge"],
  ["PRODUCTION_JOB_COMPLETE", 3, "production_job", false, "hull production job end"],
  ["STANDING_GRANT", 3, "character", false, "standing plus for fighting pirates (outbox to EveJS)"],
  ["STANDINGS_PRUNE", 5, "standings", true, "retention of grant receipts and rows"],
  ["RETENTION_PASS", 5, "retention", true, "one batch of retention of DONE rows"],
  ["TRADE_STANDING_GRANT", 3, "character", false, "standing plus for a faction trade delivery (outbox to EveJS)"],
  ["SALVAGE_PULSE", 5, "salvage", true, "periodic pulse: new salvage jobs for the wreck fields of winners"],
  ["SALVAGE_JOB_ADVANCE", 3, "salvage_job", false, "phase deadline of a salvage job (arrival, recovery end "
    + "return)"],
  ["SALVAGE_DELIVERY", 3, "salvage_job", false, "the haul of a salvage job into the home station stock"],
  ["STATION_BUILD_STEP", 3, "station_build", false, "supply recheck / anchoring end of a station build"],
  ["STATION_SIEGE_CHECK", 3, "world_system", false, "siege start check after an arrival / a siege end"],
  ["STATION_SIEGE_STEP", 3, "station_siege", false, "phase / reinforce timer deadline of a siege"],
  ["INVASION_ROLL", 4, "invasion_roll", true, "roll for a new invasion"],
  ["INVASION_STEP", 3, "invasion", false, "step check of an open invasion foothold"],
  ["INVASION_CONDUIT_ROLL", 4, "invasion_roll", true,
    "roll for a conduit spawn of an invader (own slots, day cap, treasury cost)"],
  ["CANCELLED_REJECTED", 3, "trade_offer", false, "private contract rejected and cancelled"],
  ["HUNT_SCAN", 3, "world_system", false, "hunter scan after an arrival"],
  ["HUNT_PIN_EXPIRE", 3, "hunt_pin", false, "end of a hunter pin"],
  ["LOWSEC_CAMP_PLAN", 4, "lowsec", true, "periodic plan of lowsec camps"],
  ["LOWSEC_CAMP_STEP", 3, "lowsec_camp", false, "camp deadline: activation / keep / end"],
  ["LOWSEC_AMBUSH", 3, "lowsec_camp", false, "interception of a convoy crossing a camp system"],
  ["WH_EXPEDITION_PLAN", 4, "wh_expedition", true, "periodic plan of wormhole expeditions"],
  ["WH_EXPEDITION_STEP", 3, "wh_expedition", false,
    "expedition deadline: activate / keep / evacuate / cut off / end"],
  ["CAPSULEER_CORP_REVIEW", 4, "capsuleers", true, "periodic review of capsuleer corporations"],
  ["CAPSULEER_TRIP_STEP", 3, "capsuleer_trip", false, "capsuleer ratting trip deadline / arrival nudge"],
  ["BLOCKADE_INTERCEPT", 3, "blockade", false,
    "interception of a fleet crossing a blockade system"],
  ["BLOCKADE_POSITION", 3, "blockade", false, "grid move of a blockade to the gate of a crossing"],
  ["FORTRESS_CHECKPOINT", 3, "fortress", false,
    "checkpoint of a fleet crossing a fortress system (fixed defense battle)"],
  ["TRANSIT_CHECKPOINT", 3, "transit", false,
    "checkpoint of a fleet crossing a hostile controlled system "
      + "(HALT: contact or picket battle)"],
  ["LISTENING_POST_SIGHTING", 3, "listening_post", false,
    "a fleet entering a system watched by a player listening post (sighting row)"],
  ["PLAYER_SIEGE_CHECK", 3, "world_system", false,
    "siege start check of a player structure (arrival / scan / end)"],
  ["PLAYER_SIEGE_STEP", 3, "player_structure_siege", false,
    "phase deadline of a player structure siege"],
  ["PLAYER_SIEGE_SCAN", 4, "player_siege", true,
    "periodic scan of the systems with player structures"],
  ["HRAID_CHECK", 3, "world_system", false,
    "raid start check of a player Metenox after an arrival"],
  ["HRAID_STEP", 3, "harvest_raid", false,
    "online-time sample / transition of a raid on a player harvester"],
  ["HRAID_SETTLE", 1, "harvest_raid", false,
    "the single settlement of a raid (vendor takes with receipts)"],
  ["SENTRY_RECONCILE", 4, "sentries", true, "periodic reconcile of sentries with the vendor items"],
  ["SENTRY_DEPLOY", 3, "sentry", false, "deploy of a faction sentry after its build time"],
  ["SENTRY_ATTRITION", 3, "world_system", false, "attrition round of sentries under hostile fleets"],
  ["SENTRY_BATTLE_DAMAGE", 3, "battle", false, "damage projection from battle settlement to vendor items"],
  ["SOV_STRUCTURE_STEP", 3, "sov_structure", false,
    "end of the anchoring of a sovereignty structure"],
  ["SOV_STRUCTURE_RECONCILE", 4, "sov_structures", true,
    "level backstop of sovereignty structures (control, heal, adopt "
    + "prune), one phase per event"],
  ["WORLD_BASTION_RECONCILE", 4, "world_bastions", true,
    "periodic restore of NPC sov bastions to their static faction, one page per event"],
  ["BATTLE_ANNOUNCE", 4, "operation", false, "ETA mail of an attack operation"],
  ["BATTLE_ANNOUNCE_CHECK", 5, "operation", false,
    "outcome check of an announced attack"],
  ["SEASON_STEP", 4, "season", false, "one transition of the open season"],
  ["SEASON_SCORE", 4, "season", true,
    "world meter of the season from the journal; plans the next season"],
  ["EXTRACTION_PULSE", 5, "extraction", true,
    "periodic pulse of the moon / PI yield of the factions into their stations"],
];

function buildTypes(rows) {
  const out = {};
  for (const [eventType, priority, aggregateType, periodic, origin] of rows) {
    if (typeof periodic !== "boolean") throw new RangeError(`eventTypes: ${eventType} periodic`);
    if (!Number.isInteger(priority) || priority < MIN_PRIORITY || priority > MAX_PRIORITY) {
      throw new RangeError(`eventTypes: ${eventType} priority ${priority}`);
    }
    const workClass = WORK_CLASS_ORDER[priority - 1];
    if (typeof workClass !== "string" || !Object.prototype.hasOwnProperty.call(WORK_CLASS, workClass)) {
      throw new RangeError(`eventTypes: ${eventType} has no work class`);
    }
    if (Object.prototype.hasOwnProperty.call(out, eventType)) {
      throw new RangeError(`eventTypes: duplicate ${eventType}`);
    }
    out[eventType] = Object.freeze({ eventType, priority, workClass, aggregateType, periodic, origin });
  }
  return Object.freeze(out);
}

const EVENT_TYPES = buildTypes(ROWS);

function getEventType(type) {
  return typeof type === "string" && Object.prototype.hasOwnProperty.call(EVENT_TYPES, type) ? EVENT_TYPES[type] : null;
}

function priorityOfWorkClass(workClass) {
  const index = WORK_CLASS_ORDER.indexOf(workClass);
  return index < 0 ? null : index + 1;
}

module.exports = { EVENT_TYPES, MIN_PRIORITY, MAX_PRIORITY, getEventType, priorityOfWorkClass };
