"use strict";

const S = require("../schema");

const TRIP_TRANSITIONS = Object.freeze({
  [S.OUTBOUND]: Object.freeze([S.MINING, S.ABORTED]),
  [S.MINING]: Object.freeze([S.RETURNING, S.ABORTED]),
  [S.RETURNING]: Object.freeze([S.RETURNING, S.DELIVERED, S.LOST]),
  [S.DELIVERED]: Object.freeze([]),
  [S.ABORTED]: Object.freeze([]),
  [S.LOST]: Object.freeze([]),
});

const ACTION = Object.freeze({ STALE: "STALE", WAIT: "WAIT", IGNORE: "IGNORE", START_MINING: "START_MINING",
  LOAD: "LOAD", DELIVER: "DELIVER", ABORT: "ABORT", LOSE: "LOSE", RESEEK: "RESEEK", RETRY_LATER: "RETRY_LATER" });

const IN_FLIGHT = Object.freeze(["TRAVELLING", "RETREATING"]);
const DELIVERY_STATES = Object.freeze(["STAGED", "REFITTING", "IDLE"]);

function canTransitionTrip(from, to) {
  if (!S.TRIP_STATES.includes(from) || !S.TRIP_STATES.includes(to)) {
    return { ok: false, reason: "UNKNOWN_STATE", from, to };
  }
  if (!TRIP_TRANSITIONS[from].includes(to)) return { ok: false, reason: "ILLEGAL_TRANSITION", from, to };
  return { ok: true };
}

function waitOf(trip, facts, params, reason) {
  if (facts.trigger === "arrival") return { action: ACTION.IGNORE, reason };
  if (trip.watchRound + 1 > params.maxWatchRounds) {
    return { action: trip.state === S.RETURNING ? ACTION.LOSE : ACTION.ABORT, reason: "TIMEOUT" };
  }
  return { action: ACTION.WAIT, reason };
}

function reseekOf(trip, params, reason) {
  if (trip.watchRound + 1 > params.maxWatchRounds) return { action: ACTION.LOSE, reason: "TIMEOUT" };
  return { action: ACTION.RESEEK, reason };
}

function decideStep(trip, fleet, facts, params) {
  if (!trip || S.TERMINAL_TRIP_STATES.includes(trip.state)) return { action: ACTION.STALE, reason: "TERMINAL" };
  if (facts.stationsMode !== "ready") return { action: ACTION.RETRY_LATER, reason: "STATIONS_NOT_READY" };
  if (!fleet || fleet.state === "DESTROYED") {
    return { action: trip.state === S.RETURNING ? ACTION.LOSE : ACTION.ABORT, reason: "FLEET_DESTROYED" };
  }
  if (fleet.state === "ENGAGED") return waitOf(trip, facts, params, "ENGAGED");
  if (fleet.state === "MATERIALIZED" && fleet.operationId !== null
    && (fleet.operationId === trip.outboundOperationId || fleet.operationId === trip.returnOperationId)) {
    return facts.trigger === "arrival" ? { action: ACTION.IGNORE, reason: "EXPOSED" }
      : { action: ACTION.WAIT, reason: "EXPOSED" };
  }
  const inBelt = fleet.currentSystemId === trip.beltSystemId && fleet.operationId === trip.outboundOperationId;
  if (trip.state === S.OUTBOUND) {
    if (fleet.state === "STAGED" && inBelt) return { action: ACTION.START_MINING };
    if ((fleet.state === "TRAVELLING" || fleet.state === "PLANNED")
      && fleet.operationId === trip.outboundOperationId) return waitOf(trip, facts, params, "IN_FLIGHT");
    return { action: ACTION.ABORT, reason: "DIVERTED" };
  }
  if (trip.state === S.MINING) {
    if (fleet.state !== "STAGED" || !inBelt) return { action: ACTION.ABORT, reason: "NOT_IN_BELT" };
    if (facts.at < trip.miningEndsAt) return waitOf(trip, facts, params, "SHIFT");
    return { action: ACTION.LOAD };
  }
  if (DELIVERY_STATES.includes(fleet.state) && facts.stationHere === true) return { action: ACTION.DELIVER };
  if (IN_FLIGHT.includes(fleet.state) || fleet.state === "PLANNED") return waitOf(trip, facts, params, "IN_FLIGHT");
  if (fleet.state === "STAGED") return reseekOf(trip, params, "HALTED");
  if (fleet.state === "IDLE") {
    if (fleet.refitPending === true) return waitOf(trip, facts, params, "REFIT_SEEK");
    if (facts.trigger === "arrival") return { action: ACTION.IGNORE, reason: "NO_STATION" };
    return reseekOf(trip, params, "NO_STATION");
  }
  return waitOf(trip, facts, params, "REFITTING");
}

module.exports = { TRIP_TRANSITIONS, ACTION, canTransitionTrip, decideStep };
