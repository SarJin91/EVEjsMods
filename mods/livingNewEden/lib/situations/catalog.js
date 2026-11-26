"use strict";

const { KINDS, ANCHOR_KINDS, PHASES } = require("./schema");

const ORE_FACTION_ID = 500014;

const CATALOG = Object.freeze({
  [KINDS.BELT_RAID]: Object.freeze({
    kind: KINDS.BELT_RAID,
    anchorKind: ANCHOR_KINDS.BELT,
    victimFallbackProfiles: Object.freeze(["ore_mining_venture", "ore_mining_retriever"]),
    standingFactionId: ORE_FACTION_ID,
    boardTitle: "Distress",
    pirates: true,
    startPhase: PHASES.CALLING,
    lines: Object.freeze({ distress: "DISTRESS", thanks: "THANKS", lost: "LOST" }),
  }),
  [KINDS.GATE_AMBUSH]: Object.freeze({
    kind: KINDS.GATE_AMBUSH,
    anchorKind: ANCHOR_KINDS.GATE,
    victimFallbackProfiles: Object.freeze(["ore_mining_bestower_hauler", "ore_mining_badger_hauler",
      "ore_mining_mammoth_hauler", "ore_mining_bustard_hauler"]),
    standingFactionId: ORE_FACTION_ID,
    boardTitle: "Ambush",
    pirates: true,
    startPhase: PHASES.FIGHT,
    lines: Object.freeze({ distress: "DISTRESS_GATE", thanks: "THANKS_GATE", lost: "LOST_GATE" }),
  }),
  [KINDS.STRANDED_POD]: Object.freeze({
    kind: KINDS.STRANDED_POD,
    anchorKind: ANCHOR_KINDS.BELT,
    victimFallbackProfiles: Object.freeze([]),
    standingFactionId: ORE_FACTION_ID,
    boardTitle: "Pod adrift",
    pirates: false,
    startPhase: PHASES.CALLING,
    lines: Object.freeze({ distress: "DISTRESS_POD", thanks: "THANKS_POD", lost: null }),
  }),
});

function kindOf(kind) {
  return Object.prototype.hasOwnProperty.call(CATALOG, kind) ? CATALOG[kind] : null;
}

module.exports = { CATALOG, ORE_FACTION_ID, kindOf };
