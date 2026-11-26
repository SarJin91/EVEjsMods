"use strict";

const S = require("../schema");

const CONVOY_TRANSITIONS = Object.freeze({
  [S.CONVOY_TO_SOURCE]: Object.freeze([S.CONVOY_IN_TRANSIT, S.CONVOY_ABORTED]),
  [S.CONVOY_IN_TRANSIT]: Object.freeze([S.CONVOY_IN_TRANSIT, S.CONVOY_DELIVERED, S.CONVOY_LOST]),
  [S.CONVOY_DELIVERED]: Object.freeze([]),
  [S.CONVOY_ABORTED]: Object.freeze([]),
  [S.CONVOY_LOST]: Object.freeze([]),
});

const ACTION = Object.freeze({ STALE: "STALE", WAIT: "WAIT", IGNORE: "IGNORE", LOAD: "LOAD", DELIVER: "DELIVER",
  REDIRECT: "REDIRECT", RESEEK: "RESEEK", ABORT: "ABORT", LOSE: "LOSE", RETRY_LATER: "RETRY_LATER" });

const ACTION_EDGES = Object.freeze({
  [ACTION.STALE]: null,
  [ACTION.WAIT]: null,
  [ACTION.IGNORE]: null,
  [ACTION.RETRY_LATER]: null,
  [ACTION.LOAD]: Object.freeze([S.CONVOY_TO_SOURCE, S.CONVOY_IN_TRANSIT]),
  [ACTION.DELIVER]: Object.freeze([S.CONVOY_IN_TRANSIT, S.CONVOY_DELIVERED]),
  [ACTION.REDIRECT]: Object.freeze([S.CONVOY_IN_TRANSIT, S.CONVOY_IN_TRANSIT]),
  [ACTION.RESEEK]: Object.freeze([S.CONVOY_IN_TRANSIT, S.CONVOY_IN_TRANSIT]),
  [ACTION.ABORT]: Object.freeze([S.CONVOY_TO_SOURCE, S.CONVOY_ABORTED]),
  [ACTION.LOSE]: Object.freeze([S.CONVOY_IN_TRANSIT, S.CONVOY_LOST]),
});

const IN_FLIGHT = Object.freeze(["TRAVELLING", "RETREATING"]);
const DELIVERY_STATES = Object.freeze(["STAGED", "REFITTING", "IDLE"]);

function canTransitionConvoy(from, to) {
  if (!S.CONVOY_STATES.includes(from) || !S.CONVOY_STATES.includes(to)) {
    return { ok: false, reason: "UNKNOWN_STATE", from, to };
  }
  if (!CONVOY_TRANSITIONS[from].includes(to)) return { ok: false, reason: "ILLEGAL_TRANSITION", from, to };
  return { ok: true };
}

const endOf = (convoy) => (convoy.state === S.CONVOY_IN_TRANSIT ? ACTION.LOSE : ACTION.ABORT);

function waitOf(convoy, facts, params, reason) {
  if (facts.trigger === "arrival") return { action: ACTION.IGNORE, reason };
  if (convoy.watchRound + 1 > params.maxWatchRounds) return { action: endOf(convoy), reason: "TIMEOUT" };
  return { action: ACTION.WAIT, reason };
}

function replanOf(convoy, params, action, reason) {
  if (convoy.watchRound + 1 > params.maxWatchRounds) return { action: ACTION.LOSE, reason: "TIMEOUT" };
  return { action, reason };
}

function decideConvoyStep(convoy, fleet, facts, params) {
  if (!convoy || S.CONVOY_TERMINAL_STATES.includes(convoy.state)) return { action: ACTION.STALE, reason: "TERMINAL" };
  if (facts.stationsMode !== "ready") return { action: ACTION.RETRY_LATER, reason: "STATIONS_NOT_READY" };
  if (!fleet || fleet.state === "DESTROYED") return { action: endOf(convoy), reason: "FLEET_DESTROYED" };
  if (fleet.state === "ENGAGED") {
    return facts.trigger === "arrival" ? { action: ACTION.IGNORE, reason: "ENGAGED" }
      : { action: ACTION.WAIT, reason: "ENGAGED" };
  }
  if (fleet.state === "MATERIALIZED" && fleet.operationId !== null && fleet.operationId === convoy.operationId) {
    return facts.trigger === "arrival" ? { action: ACTION.IGNORE, reason: "EXPOSED" }
      : { action: ACTION.WAIT, reason: "EXPOSED" };
  }
  if (!(facts.carriers > 0)) return { action: endOf(convoy), reason: "CARRIERS_LOST" };
  const ours = fleet.operationId !== null && fleet.operationId === convoy.operationId;
  if (convoy.state === S.CONVOY_TO_SOURCE) {
    if (facts.sourceOk !== true) return { action: ACTION.ABORT, reason: "SOURCE_LOST" };
    const atSource = fleet.currentSystemId === convoy.sourceSystemId;
    if (atSource && ((fleet.state === "STAGED" && ours) || (fleet.state === "IDLE" && fleet.refitPending !== true))) {
      return { action: ACTION.LOAD };
    }
    if ((fleet.state === "TRAVELLING" || fleet.state === "PLANNED") && ours) {
      return waitOf(convoy, facts, params, "IN_FLIGHT");
    }
    return { action: ACTION.ABORT, reason: "DIVERTED" };
  }
  const atDest = fleet.currentSystemId === convoy.destSystemId;
  if (atDest && DELIVERY_STATES.includes(fleet.state) && facts.destOk === true) return { action: ACTION.DELIVER };
  if (IN_FLIGHT.includes(fleet.state) || fleet.state === "PLANNED") return waitOf(convoy, facts, params, "IN_FLIGHT");
  if (fleet.state === "REFITTING") return waitOf(convoy, facts, params, "REFITTING");
  if (fleet.state === "IDLE" && fleet.refitPending === true) return waitOf(convoy, facts, params, "REFIT_SEEK");
  if (facts.destOk !== true) return replanOf(convoy, params, ACTION.REDIRECT, "DEST_LOST");
  if (fleet.state === "IDLE" && facts.trigger === "arrival") return { action: ACTION.IGNORE, reason: "HALTED" };
  return replanOf(convoy, params, ACTION.RESEEK, "HALTED");
}

module.exports = { CONVOY_TRANSITIONS, ACTION, ACTION_EDGES, canTransitionConvoy, decideConvoyStep };
