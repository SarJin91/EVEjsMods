"use strict";

const { STATION_STATES } = require("./schema");

const STATION_TRANSITIONS = Object.freeze({
  ANCHORING: Object.freeze(["ONLINE", "DESTROYED"]),
  ONLINE: Object.freeze(["ARMOR_REINFORCE"]),
  ARMOR_REINFORCE: Object.freeze(["ONLINE", "HULL_REINFORCE"]),
  HULL_REINFORCE: Object.freeze(["ONLINE", "DESTROYED"]),
  DESTROYED: Object.freeze([]),
});

function canTransitionStation(from, to) {
  if (!STATION_STATES.includes(from)) return { ok: false, reason: "UNKNOWN_STATE", state: from };
  if (!STATION_STATES.includes(to)) return { ok: false, reason: "UNKNOWN_STATE", state: to };
  if (!STATION_TRANSITIONS[from].includes(to)) return { ok: false, reason: "TRANSITION_NOT_ALLOWED", from, to };
  return { ok: true };
}

function listStationEdges() {
  const out = [];
  for (const [from, list] of Object.entries(STATION_TRANSITIONS)) for (const to of list) out.push([from, to]);
  return out;
}

module.exports = { STATION_TRANSITIONS, canTransitionStation, listStationEdges };
