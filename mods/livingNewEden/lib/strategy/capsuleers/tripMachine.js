"use strict";

const S = require("./schema");

const TRIP_TRANSITIONS = Object.freeze({
  [S.OUTBOUND]: Object.freeze([S.RATTING, S.RETURNING, S.ABORTED, S.LOST]),
  [S.RATTING]: Object.freeze([S.RETURNING, S.LOST]),
  [S.RETURNING]: Object.freeze([S.RETURNING, S.DOCKED, S.ABORTED, S.LOST]),
  [S.DOCKED]: Object.freeze([]),
  [S.ABORTED]: Object.freeze([]),
  [S.LOST]: Object.freeze([]),
});

const ACTION = Object.freeze({ STALE: "STALE", IGNORE: "IGNORE", WAIT: "WAIT", START_RATTING: "START_RATTING",
  RAT: "RAT", RETURN: "RETURN", DOCK: "DOCK", RESEEK: "RESEEK", END: "END", LOSE: "LOSE", GUARD: "GUARD",
  COLLECT: "COLLECT" });

const IN_FLIGHT = Object.freeze(["TRAVELLING", "RETREATING", "PLANNED"]);
const AT_REST = Object.freeze(["STAGED", "IDLE"]);

function canTransitionTrip(from, to) {
  if (!S.TRIP_STATES.includes(from) || !S.TRIP_STATES.includes(to)) {
    return { ok: false, reason: "UNKNOWN_STATE", from, to };
  }
  if (!TRIP_TRANSITIONS[from].includes(to)) return { ok: false, reason: "ILLEGAL_TRANSITION", from, to };
  return { ok: true };
}

function waitOf(trip, facts, params, reason) {
  if (facts.trigger === "arrival") return { action: ACTION.IGNORE, reason };
  if ((trip.waitRound || 0) + 1 > params.maxWatchRounds) {
    return { action: trip.state === S.RATTING ? ACTION.RETURN : ACTION.END, reason: "TIMEOUT" };
  }
  return { action: ACTION.WAIT, reason };
}

function reseekOf(trip, params, reason) {
  if (trip.watchRound + 1 > params.maxWatchRounds) return { action: ACTION.END, reason: "TIMEOUT" };
  return { action: ACTION.RESEEK, reason };
}

function targetCheck(facts) {
  if (facts.hostiles === true) return { action: ACTION.RETURN, reason: "HOSTILES" };
  if (facts.controlled === null || facts.controlled === undefined) {
    return { action: ACTION.RETURN, reason: "WORLD_UNAVAILABLE" };
  }
  if (facts.controlled !== true) return { action: ACTION.RETURN, reason: "CONTROL_LOST" };
  return null;
}

function salvageCheck(facts, outbound) {
  if (facts.hostiles === true) return { action: ACTION.RETURN, reason: "HOSTILES" };
  if (facts.fieldAlive === null || facts.fieldAlive === undefined) {
    return { action: ACTION.RETURN, reason: "WRECKS_UNAVAILABLE" };
  }
  if (facts.fieldAlive !== true) return { action: ACTION.RETURN, reason: "FIELD_GONE" };
  if (outbound && facts.tooLate === true) return { action: ACTION.RETURN, reason: "TOO_LATE" };
  return null;
}

function mercStep(trip, fleet, facts, params) {
  const withOutbound = trip.outboundOperationId !== null && fleet.operationId === trip.outboundOperationId;
  const inSystem = withOutbound && trip.targetSystemId !== null && fleet.currentSystemId === trip.targetSystemId;
  if (trip.state === S.OUTBOUND) {
    if (inSystem && (fleet.state === "ENGAGED" || fleet.state === "STAGED")) return { action: ACTION.START_RATTING };
    return null;
  }
  if (trip.state === S.RATTING) {
    if (fleet.state === "ENGAGED") return waitOf(trip, facts, params, "ENGAGED");
    if (!(inSystem && fleet.state === "STAGED")) return { action: ACTION.RETURN, reason: "DIVERTED" };
    if (facts.trigger === "arrival") return { action: ACTION.IGNORE, reason: "ON_STATION" };
    return { action: ACTION.GUARD };
  }
  return null;
}

function decideStep(trip, fleet, facts, params) {
  if (!trip || S.TERMINAL_TRIP_STATES.includes(trip.state)) return { action: ACTION.STALE, reason: "TERMINAL" };
  if (!fleet || fleet.state === "DESTROYED") return { action: ACTION.LOSE, reason: "FLEET_DESTROYED" };
  if (trip.kind === S.MERC_TRIP_KIND) {
    const m = mercStep(trip, fleet, facts, params);
    if (m) return m;
  }
  if (fleet.state === "ENGAGED") return waitOf(trip, facts, params, "ENGAGED");
  const withOutbound = trip.outboundOperationId !== null && fleet.operationId === trip.outboundOperationId;
  const inTarget = fleet.state === "STAGED" && withOutbound && trip.targetSystemId !== null
    && fleet.currentSystemId === trip.targetSystemId;
  const atBase = AT_REST.includes(fleet.state) && fleet.currentSystemId === trip.baseSystemId;
  const salvage = trip.kind === S.SALVAGE_TRIP_KIND;
  if (trip.state === S.OUTBOUND) {
    if (inTarget) {
      return (salvage ? salvageCheck(facts, true) : targetCheck(facts)) || { action: ACTION.START_RATTING };
    }
    if ((fleet.state === "TRAVELLING" || fleet.state === "PLANNED") && withOutbound) {
      return waitOf(trip, facts, params, "IN_FLIGHT");
    }
    if (atBase) return { action: ACTION.END, reason: "DIVERTED" };
    return { action: ACTION.RETURN, reason: "DIVERTED" };
  }
  if (trip.state === S.RATTING) {
    if (!inTarget) return { action: ACTION.RETURN, reason: "DIVERTED" };
    if (facts.trigger === "arrival") return { action: ACTION.IGNORE, reason: "RATTING" };
    if (salvage) return salvageCheck(facts, false) || { action: ACTION.COLLECT };
    return targetCheck(facts) || { action: ACTION.RAT };
  }
  if (atBase) return { action: ACTION.DOCK };
  if (IN_FLIGHT.includes(fleet.state)) return waitOf(trip, facts, params, "IN_FLIGHT");
  if (AT_REST.includes(fleet.state)) {
    if (fleet.state === "IDLE" && facts.trigger === "arrival") return { action: ACTION.IGNORE, reason: "NOT_HOME" };
    return reseekOf(trip, params, "NOT_HOME");
  }
  return waitOf(trip, facts, params, fleet.state);
}

const isTimeValue = (v) => Number.isSafeInteger(v) && v >= 0;

function ratStepDueAt(trip, lastAt, params) {
  const ends = isTimeValue(trip.rattingEndsAt) ? trip.rattingEndsAt : lastAt;
  if (trip.kind === S.SALVAGE_TRIP_KIND) return ends;
  return Math.min(lastAt + (trip.kind === S.MERC_TRIP_KIND ? params.mercStepMs : params.rattingStepMs), ends);
}

function ratLastAtOf(trip) {
  if (!trip || trip.state !== S.RATTING) return null;
  const v = trip.watchRound === 0 ? trip.rattingStartedAt : trip.updatedAt;
  return isTimeValue(v) ? v : null;
}

module.exports = { TRIP_TRANSITIONS, ACTION, canTransitionTrip, decideStep, ratStepDueAt, ratLastAtOf };
