"use strict";

const LIVE_OPERATOR_KIND = "lne";

const LIVE_DUEL_OPERATOR_KIND = "lne-duel";

const PILOT_AGGRO_KINDS = Object.freeze([LIVE_OPERATOR_KIND, LIVE_DUEL_OPERATOR_KIND]);

const VENDOR_RAT_AGGRO_KINDS = Object.freeze(["asteroidBeltRat", "gateRats"]);

const HEAVY_OPERATOR_KIND = "lneHeavyEvent";

const GUARD_BEHAVIOR = Object.freeze({
  autoAggro: true,
  autoAggroTargetClasses: Object.freeze(["player"]),
  returnToHomeWhenIdle: true,
  autoActivateWeapons: true,
});

const TRAFFIC_OPERATOR_KIND = "lneTraffic";

const TRAFFIC_BEHAVIOR = Object.freeze({
  autoAggro: false,
  autoActivateWeapons: false,
  targetPreference: "none",
  proximityAggroRangeMeters: 0,
  returnToHomeWhenIdle: false,
  idleAnchorOrbit: false,
  leashRangeMeters: 0,
});

const BOUNTY_OPERATOR_KIND = "lneBounty";

const BOUNTY_BEHAVIOR = Object.freeze({
  RUNNER: Object.freeze({ autoAggro: false, proximityAggroRangeMeters: 0 }),
  BRAWLER: Object.freeze({ autoAggro: true, autoActivateWeapons: true }),
  KITER: Object.freeze({ autoAggro: true, autoActivateWeapons: true, movementMode: "orbit",
    orbitDistanceMeters: 40000 }),
  AMBUSH: Object.freeze({ autoAggro: false, proximityAggroRangeMeters: 0 }),
  ESCORT: Object.freeze({ autoAggro: true, autoActivateWeapons: true }),
  SMUGGLER: Object.freeze({ autoAggro: false, proximityAggroRangeMeters: 0 }),
  HUNTER: Object.freeze({ autoAggro: false, proximityAggroRangeMeters: 0 }),
});

const SITUATION_OPERATOR_KIND = "lneSituation";

const SITUATION_VICTIM_BEHAVIOR = Object.freeze({
  autoAggro: false,
  autoActivateWeapons: false,
  allowFriendlyNpcTargets: true,
  targetPreference: "none",
  proximityAggroRangeMeters: 0,
  returnToHomeWhenIdle: false,
  idleAnchorOrbit: false,
  leashRangeMeters: 0,
});

const SITUATION_PIRATE_BEHAVIOR = Object.freeze({
  autoAggro: false,
  allowFriendlyNpcTargets: true,
  proximityAggroRangeMeters: 0,
  returnToHomeWhenIdle: false,
  leashRangeMeters: 0,
});

const PIRATE_KEY_BY_FACTION_ID = Object.freeze({
  500010: "guristas",
  500011: "angels",
  500012: "blood",
  500019: "sanshas",
  500020: "serpentis",
  500025: "rogue_drones",
  500021: "sleepers",
});

const HULL_CLASS_BY_GROUP = Object.freeze({
  frigate: "frigate",
  tackle: "frigate",
  ewar: "frigate",
  destroyer: "destroyer",
  cruiser: "cruiser",
  logistics: "cruiser",
  battlecruiser: "battlecruiser",
  battleship: "battleship",
  capital: "battleship",
});

const CAPITAL_LIVE_GROUPS = Object.freeze(["carrier", "dreadnought", "force_auxiliary", "supercarrier", "titan"]);

const CAPITAL_NO_PROFILE_DETAIL = "CAPITAL";

const SPAWN_BEHAVIOR = Object.freeze({
  autoAggro: false,
  autoActivateWeapons: false,
  targetPreference: "none",
});

const COMBAT_BEHAVIOR = Object.freeze({
  autoAggro: true,
  autoActivateWeapons: true,
  allowFriendlyNpcTargets: true,
  targetPreference: "nearestNpc",
  movementMode: "orbit",
  orbitDistanceMeters: 7_500,
  followRangeMeters: 5_000,
  useChasePropulsion: true,
  chasePropulsionActivateDistanceMeters: 16_000,
  chasePropulsionDeactivateDistanceMeters: 10_000,
  aggressionRangeMeters: 180_000,
  returnToHomeWhenIdle: false,
});

const COMBAT_BEHAVIOR_MANUAL = Object.freeze({
  ...COMBAT_BEHAVIOR,
  targetPreference: "preferredTargetOnly",
  allowTargetSwitching: false,
});

const CAPITAL_COMBAT_STRIP = Object.freeze(["useChasePropulsion", "chasePropulsionActivateDistanceMeters",
  "chasePropulsionDeactivateDistanceMeters", "movementMode", "orbitDistanceMeters", "followRangeMeters"]);

const NAVY_PASSIVE_BEHAVIOR = Object.freeze({ autoAggro: false, proximityAggroRangeMeters: 0 });
const AMBIENT_ARMED_TARGET_CLASSES = Object.freeze(["player"]);

const AGGRO_CLASSES_NPC = Object.freeze(["npc"]);
const AGGRO_CLASSES_NPC_AND_PLAYER = Object.freeze(["npc", "player"]);
const AGGRO_CLASSES_NONE = Object.freeze([]);
const AGGRO_CLASSES_PLAYER = Object.freeze(["player"]);

const TARGET_MODES = Object.freeze(["manual", "vendor"]);

const PUBLISH_OPTIONS = Object.freeze({ freshAcquire: true, minimumLeadFromCurrentHistory: 2 });

const DESPAWN_OPTIONS = Object.freeze({ broadcast: true, suppressWreck: true });

const NO_LEASH_BEHAVIOR = Object.freeze({ leashRangeMeters: 0 });

const HUNT_SEARCH_BEHAVIOR = Object.freeze({
  ...SPAWN_BEHAVIOR,
  returnToHomeWhenIdle: false,
  idleAnchorOrbit: false,
  allowFriendlyNpcTargets: true,
  ...NO_LEASH_BEHAVIOR,
});

const HUNT_WARP_OPTIONS = Object.freeze({
  forceImmediateStart: true,
  broadcastWarpStartToVisibleSessions: true,
});

const ATTACK_LOCK_ORDER = Object.freeze({ keepLock: true, allowWeapons: true });

const CAPSULE_GROUP_ID = 29;

const OBJECT_KIND_SOURCES = Object.freeze({
  stargate: Object.freeze({ fn: "getStargatesForSystem", idFields: Object.freeze(["itemID"]), groupId: null,
    toSystemField: "destinationSolarSystemID" }),
  station: Object.freeze({ fn: "getStationsForSystem", idFields: Object.freeze(["stationID", "itemID"]),
    groupId: null }),
  asteroidBelt: Object.freeze({ fn: "getAsteroidBeltsForSystem", idFields: Object.freeze(["itemID"]),
    groupId: null }),
  planet: Object.freeze({ fn: "getCelestialsForSystem", idFields: Object.freeze(["itemID"]), groupId: 7 }),
  sun: Object.freeze({ fn: "getCelestialsForSystem", idFields: Object.freeze(["itemID"]), groupId: 6,
    kindAlias: "sun" }),
  anomaly: Object.freeze({ dynamic: "anomalySites", idFields: Object.freeze(["siteID"]), groupId: null }),
});

const RELATION_THRESHOLDS = Object.freeze({
  hostile: Object.freeze({ hostileResponseThreshold: 11, friendlyResponseThreshold: 11 }),
  neutral: Object.freeze({ hostileResponseThreshold: -11, friendlyResponseThreshold: 11 }),
  friendly: Object.freeze({ hostileResponseThreshold: -11, friendlyResponseThreshold: -11 }),
});

module.exports = {
  RELATION_THRESHOLDS,
  LIVE_OPERATOR_KIND,
  LIVE_DUEL_OPERATOR_KIND,
  PILOT_AGGRO_KINDS,
  VENDOR_RAT_AGGRO_KINDS,
  HEAVY_OPERATOR_KIND,
  GUARD_BEHAVIOR,
  TRAFFIC_OPERATOR_KIND,
  TRAFFIC_BEHAVIOR,
  BOUNTY_OPERATOR_KIND,
  BOUNTY_BEHAVIOR,
  SITUATION_OPERATOR_KIND,
  SITUATION_VICTIM_BEHAVIOR,
  SITUATION_PIRATE_BEHAVIOR,
  PIRATE_KEY_BY_FACTION_ID,
  HULL_CLASS_BY_GROUP,
  CAPITAL_LIVE_GROUPS,
  CAPITAL_NO_PROFILE_DETAIL,
  CAPITAL_COMBAT_STRIP,
  SPAWN_BEHAVIOR,
  COMBAT_BEHAVIOR,
  COMBAT_BEHAVIOR_MANUAL,
  NAVY_PASSIVE_BEHAVIOR,
  AMBIENT_ARMED_TARGET_CLASSES,
  AGGRO_CLASSES_NPC,
  AGGRO_CLASSES_NPC_AND_PLAYER,
  AGGRO_CLASSES_NONE,
  AGGRO_CLASSES_PLAYER,
  TARGET_MODES,
  PUBLISH_OPTIONS,
  DESPAWN_OPTIONS,
  NO_LEASH_BEHAVIOR,
  HUNT_SEARCH_BEHAVIOR,
  HUNT_WARP_OPTIONS,
  ATTACK_LOCK_ORDER,
  CAPSULE_GROUP_ID,
  OBJECT_KIND_SOURCES,
};
