"use strict";

const EVEJS_STATE_NAMES = Object.freeze(["ANCHOR_VULNERABLE", "SHIELD_VULNERABLE", "ARMOR_REINFORCE",
  "ARMOR_VULNERABLE", "HULL_REINFORCE", "HULL_VULNERABLE"]);
const EVEJS_UPKEEP_NAMES = Object.freeze(["FULL_POWER"]);

const CONDITION_FULL = Object.freeze({ damage: 0, charge: 1, armorDamage: 0, shieldCharge: 1, incapacitated: false });
const CONDITION_ARMOR_STAGE = Object.freeze({ damage: 0, armorDamage: 0, shieldCharge: 0 });
const CONDITION_HULL_STAGE = Object.freeze({ damage: 0, armorDamage: 1, shieldCharge: 0 });

const OPS = Object.freeze({
  NOOP: "NOOP",
  CREATE: "CREATE",
  UPDATE: "UPDATE",
  DESTROY: "DESTROY",
  REMOVE: "REMOVE",
  RECREATE: "RECREATE",
});
const OP_PRIORITY = Object.freeze({ DESTROY: 0, UPDATE: 1, CREATE: 2, REMOVE: 3 });

const DESIRED_KINDS = Object.freeze({ ABSENT: "absent", DESTROYED: "destroyed", PRESENT: "present",
  UNMAPPED: "unmapped" });

const REMOVE_REASONS = Object.freeze({
  DUPLICATE: "DUPLICATE",
  ORPHAN: "ORPHAN",
  RECREATE: "RECREATE",
  NOT_PROJECTED: "NOT_PROJECTED",
});
const RECREATE_REASON = "TYPE_OR_SYSTEM_MISMATCH";

const SEAM_REASONS = Object.freeze({
  UNAVAILABLE: "STRUCTURES_SEAM_UNAVAILABLE",
  SEAM_ERROR: "SEAM_ERROR",
  TAG_REQUIRED: "TAG_REQUIRED",
  TAG_MISMATCH: "TAG_MISMATCH",
  ALREADY_TAGGED: "ALREADY_TAGGED",
  TYPE_UNKNOWN: "TYPE_UNKNOWN",
  INVALID_INPUT: "INVALID_INPUT",
  NOT_FOUND: "NOT_FOUND",
  DESTROYED: "DESTROYED",
  NOT_EMPTY: "NOT_EMPTY",
  WRITE_FAILED: "WRITE_FAILED",
  FLUSH_FAILED: "FLUSH_FAILED",
});

const TAG_STATION_KEY = "lneStationId";
const TAG_WORLD_KEY = "lneWorld";

const PROJECTION_KEY_PREFIX = "stations:projection:";
const projectionKey = (stationId, evejsItemId) => `${PROJECTION_KEY_PREFIX}${stationId}:${evejsItemId}`;

module.exports = {
  EVEJS_STATE_NAMES,
  EVEJS_UPKEEP_NAMES,
  CONDITION_FULL,
  CONDITION_ARMOR_STAGE,
  CONDITION_HULL_STAGE,
  OPS,
  OP_PRIORITY,
  DESIRED_KINDS,
  REMOVE_REASONS,
  RECREATE_REASON,
  SEAM_REASONS,
  TAG_STATION_KEY,
  TAG_WORLD_KEY,
  PROJECTION_KEY_PREFIX,
  projectionKey,
};
