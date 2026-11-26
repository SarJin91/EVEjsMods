"use strict";

const CONTACTABLE_STATES = Object.freeze(["IDLE", "PLANNED", "STAGED", "REFITTING"]);

const EVASIVE_ROLES = Object.freeze(["hunter", "capsuleer"]);
const TRIP_FIGHTABLE_ROLES = Object.freeze(["capsuleer"]);

const OBJECTIVE_MAP = Object.freeze({ capture: "capture", liberate: "capture", hold: "defend", destroy: "destroy",
  raid: "destroy", patrol: "destroy", scout: "delay", deliver: "escort", mine: "defend", return: "escort",
  salvage: "escort", rat: "defend" });
const DEFAULT_OBJECTIVE = "destroy";

const ASSEMBLY_OPERATION_TYPES = Object.freeze(["invasion", "raid", "counter"]);
const DECLINE_OPERATION_TYPES = Object.freeze(["invasion", "raid", "gank", "reinforce", "patrol", "counter"]);

const CONTACT_ROWS_BOUND = 4;
const RESOLUTION_ROWS = 4;
const CONTACT_CHECK_ROWS = 2;

const selfTestFleet = (fleetId, factionId) => Object.freeze({ fleetId, factionId, fleetRole: "patrol",
  doctrineId: null, supplyState: 100,
  composition: Object.freeze([Object.freeze({ hullGroup: "frigate", typeId: null, count: 1 })]) });

const SELF_TEST_INPUT = Object.freeze({
  v: 1, battleId: "battle_selftest_0001_0001", seed: 1, systemId: 30000001, environment: "nullsec",
  sideA: Object.freeze({ factionId: 500001, fleets: Object.freeze([selfTestFleet("selftest-a", 500001)]) }),
  sideB: Object.freeze({ factionId: 500002, fleets: Object.freeze([selfTestFleet("selftest-b", 500002)]) }),
  objective: "destroy", garrison: null, resolverVersion: "internal-v1", maxResolutionMs: 50,
});

module.exports = { CONTACTABLE_STATES, OBJECTIVE_MAP, DEFAULT_OBJECTIVE, CONTACT_ROWS_BOUND, RESOLUTION_ROWS,
  CONTACT_CHECK_ROWS, SELF_TEST_INPUT, EVASIVE_ROLES, TRIP_FIGHTABLE_ROLES, ASSEMBLY_OPERATION_TYPES, DECLINE_OPERATION_TYPES };
