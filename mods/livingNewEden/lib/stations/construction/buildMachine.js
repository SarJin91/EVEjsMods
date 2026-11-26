"use strict";

const S = require("./schema");

const STATION_ANCHORING = "ANCHORING";
const STATION_ONLINE = "ONLINE";
const STATION_DESTROYED = "DESTROYED";

const BUILD_TRANSITIONS = Object.freeze({
  [S.SUPPLYING]: Object.freeze([S.SUPPLYING, S.ANCHORING, S.CANCELLED]),
  [S.ANCHORING]: Object.freeze([S.COMPLETED, S.FAILED]),
  [S.COMPLETED]: Object.freeze([]),
  [S.CANCELLED]: Object.freeze([]),
  [S.FAILED]: Object.freeze([]),
});

const ACTION = Object.freeze({ STALE: "STALE", RETRY_LATER: "RETRY_LATER", WAIT: "WAIT", REARM: "REARM",
  CANCEL: "CANCEL", COMPLETE: "COMPLETE", FAIL: "FAIL" });

const ACTION_EDGES = Object.freeze({
  [ACTION.STALE]: null,
  [ACTION.RETRY_LATER]: null,
  [ACTION.WAIT]: null,
  [ACTION.REARM]: null,
  [ACTION.CANCEL]: Object.freeze([S.SUPPLYING, S.CANCELLED]),
  [ACTION.COMPLETE]: Object.freeze([S.ANCHORING, S.COMPLETED]),
  [ACTION.FAIL]: Object.freeze([S.ANCHORING, S.FAILED]),
});

function canTransitionBuild(from, to) {
  if (!S.BUILD_STATES.includes(from) || !S.BUILD_STATES.includes(to)) {
    return { ok: false, reason: "UNKNOWN_STATE", from, to };
  }
  if (!BUILD_TRANSITIONS[from].includes(to)) return { ok: false, reason: "ILLEGAL_TRANSITION", from, to };
  return { ok: true };
}

function decideBuildStep(build, station, facts, params) {
  if (!build || S.TERMINAL_BUILD_STATES.includes(build.state)) return { action: ACTION.STALE, reason: "TERMINAL" };
  if (facts.stationsMode !== "ready") return { action: ACTION.RETRY_LATER, reason: "STATIONS_NOT_READY" };
  const at = facts.at;
  if (build.state === S.SUPPLYING) {
    if (at >= build.supplyDeadlineAt) return { action: ACTION.CANCEL, reason: "TIMEOUT" };
    const site = facts.site || { good: false, reason: "SITE_UNKNOWN" };
    if (site.good !== true) return { action: ACTION.CANCEL, reason: site.reason || "SITE_INVALID" };
    return { action: ACTION.WAIT, dueAt: Math.min(build.supplyDeadlineAt, at + params.recheckMs) };
  }
  if (!station || station.state === STATION_DESTROYED) return { action: ACTION.FAIL, reason: "DESTROYED" };
  if (station.state === STATION_ANCHORING) {
    if (at >= build.anchorUntilAt) return { action: ACTION.COMPLETE, reason: "ONLINE", stationEdge: true };
    return { action: ACTION.REARM, dueAt: build.anchorUntilAt };
  }
  if (station.state === STATION_ONLINE) return { action: ACTION.COMPLETE, reason: "ONLINE", stationEdge: false };
  return { action: ACTION.FAIL, reason: `STATE_${station.state}` };
}

module.exports = { BUILD_TRANSITIONS, ACTION, ACTION_EDGES, canTransitionBuild, decideBuildStep };
