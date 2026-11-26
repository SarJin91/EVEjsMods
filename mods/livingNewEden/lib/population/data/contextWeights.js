"use strict";

const { ARCHETYPE, INTENT } = require("../schema");

const DANGER = Object.freeze({
  PIRATE_CONTROLLER: 1000,
  OPEN_BATTLE: 1000,
  INVASION: 700,
  CONTESTED: 600,
  RECON: 300,
  OCCUPIED: 400,
  HOSTILE_CONTROLLER: 1000,
});

const ATTRACT = Object.freeze({ RAT: 0, EXPLORE: 1, MINE: 2 });
const ATTRACT_KINDS = 3;
const WRECK_ATTRACT = ATTRACT.EXPLORE;
const ATTRACT_BOOST = 2;

function attractOfEvent(eventType) {
  const type = String(eventType || "");
  if (type.startsWith("rich_vein_")) return ATTRACT.MINE;
  if (type === "battle_relics") return ATTRACT.EXPLORE;
  return ATTRACT.RAT;
}

const KIND_OF_ARCHETYPE = Object.freeze({ [ARCHETYPE.RATTER]: ATTRACT.RAT, [ARCHETYPE.EXPLORER]: ATTRACT.EXPLORE,
  [ARCHETYPE.MINER]: ATTRACT.MINE });
const KIND_OF_INTENT = Object.freeze({ [INTENT.RAT]: ATTRACT.RAT, [INTENT.EXPLORE]: ATTRACT.EXPLORE,
  [INTENT.MINE]: ATTRACT.MINE });

module.exports = { DANGER, ATTRACT, ATTRACT_KINDS, WRECK_ATTRACT, ATTRACT_BOOST, attractOfEvent, KIND_OF_ARCHETYPE,
  KIND_OF_INTENT };
