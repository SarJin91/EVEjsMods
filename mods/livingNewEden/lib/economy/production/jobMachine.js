"use strict";

const ACTION = Object.freeze({ STALE: "STALE", DELIVER: "DELIVER", WAIT: "WAIT", LOSE: "LOSE" });
const ACTIVE = "ACTIVE";
const ONLINE = "ONLINE";
const DESTROYED = "DESTROYED";

function waitOrTimeout(job, params, reason) {
  if (job.waitRound >= params.maxWaitRounds) return { action: ACTION.LOSE, reason: "TIMEOUT" };
  return { action: ACTION.WAIT, reason };
}

function decideCompletion(job, station, facts, params) {
  if (!job || job.state !== ACTIVE || !facts || facts.round !== job.waitRound) return { action: ACTION.STALE };
  if (!station || station.state === DESTROYED) return { action: ACTION.LOSE, reason: "STATION_LOST" };
  if (station.ownerFactionId !== job.factionId) return { action: ACTION.LOSE, reason: "OWNER_CHANGED" };
  if (station.state !== ONLINE) return waitOrTimeout(job, params, station.state);
  return { action: ACTION.DELIVER };
}

module.exports = { decideCompletion, waitOrTimeout, ACTION };
