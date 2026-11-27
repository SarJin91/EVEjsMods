"use strict";

const CIVILIAN_PROFILE_PREFIX = "lne_civ_";

function deepFreeze(value) {
  if (value && typeof value === "object") {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

const CIVILIAN_CORPORATION_ID = 1000129;
const CIVILIAN_FACTION_ID = 500014;
const CIVILIAN_LOADOUT_ID = "retail_empty_npc_entity_loadout";
const CIVILIAN_BEHAVIOR_PROFILE_ID = "npc_passive_idle";

function hull(key, label, shipTypeId, presentationTypeId, roles, weight) {
  return { key, label, shipTypeId, presentationTypeId, loadoutId: CIVILIAN_LOADOUT_ID,
    behaviorProfileId: CIVILIAN_BEHAVIOR_PROFILE_ID, roles, weight };
}

const CIVILIAN_HULLS = deepFreeze([
  hull("venture", "Venture", 32880, 42533, ["MINER", "UNDOCK", "GATE_IDLE"], 4),
  hull("retriever", "Retriever", 17478, 42534, ["MINER", "UNDOCK"], 3),
  hull("skiff", "Skiff", 22546, 42535, ["MINER"], 1),
  hull("bestower", "Bestower", 1944, 42654, ["HAULER", "UNDOCK", "GATE_IDLE"], 3),
  hull("badger", "Badger", 648, 42656, ["HAULER", "UNDOCK", "GATE_IDLE"], 3),
  hull("mammoth", "Mammoth", 652, 42660, ["HAULER", "UNDOCK", "GATE_IDLE"], 2),
  hull("bustard", "Bustard", 12731, 42657, ["HAULER"], 1),
  hull("impel", "Impel", 12753, 42655, ["HAULER"], 1),
  hull("mastodon", "Mastodon", 12747, 42661, ["HAULER"], 1),
  hull("occator", "Occator", 12745, 42659, ["HAULER"], 1),
  hull("astero", "Astero", 33468, 57797, ["UNDOCK", "GATE_IDLE", "EXPLORER"], 1),
  hull("catalyst", "Catalyst", 16240, 25125, ["UNDOCK", "GATE_IDLE", "RATTER"], 2),
  hull("stratios", "Stratios", 33470, 57798, ["UNDOCK", "GATE_IDLE", "EXPLORER"], 1),
  hull("brutix", "Brutix", 16229, 46076, ["UNDOCK", "GATE_IDLE", "RATTER"], 1),
  hull("capsule", "Capsule", 670, 27287, ["POD"], 1),
]);

const PILOT_HULLS = deepFreeze([
  hull("nestor", "Nestor", 33472, 57799, ["PILOT"], 1),
  hull("hurricane", "Hurricane", 24702, 46080, ["PILOT"], 1),
  hull("obelisk", "Obelisk", 20187, 53569, ["PILOT"], 1),
  hull("charon", "Charon", 20185, 53561, ["PILOT"], 1),
]);

const CIVILIAN_HARDWARE_FAMILY = "miningOps";
const CIVILIAN_SECURITY_STATUS = 0;

function civilianProfileId(key) {
  return `${CIVILIAN_PROFILE_PREFIX}${key}`;
}

let withPilotHulls = null;

function civilianDataOf(opts) {
  if (!opts || opts.pilotHulls !== true) return module.exports;
  if (!withPilotHulls) {
    withPilotHulls = Object.freeze({ ...module.exports,
      CIVILIAN_HULLS: Object.freeze([...CIVILIAN_HULLS, ...PILOT_HULLS]) });
  }
  return withPilotHulls;
}

module.exports = {
  CIVILIAN_PROFILE_PREFIX, CIVILIAN_HULLS, CIVILIAN_CORPORATION_ID, CIVILIAN_FACTION_ID, CIVILIAN_LOADOUT_ID,
  CIVILIAN_BEHAVIOR_PROFILE_ID, CIVILIAN_HARDWARE_FAMILY, CIVILIAN_SECURITY_STATUS, civilianProfileId,
  PILOT_HULLS, civilianDataOf,
};
