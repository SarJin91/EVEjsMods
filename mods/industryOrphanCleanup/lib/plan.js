"use strict";

const STATUS = Object.freeze({ READY: 3, DELIVERED: 101, CANCELLED: 102 });
const TERMINAL = new Set([STATUS.DELIVERED, STATUS.CANCELLED]);

function toInt(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function recoveryIntentForMissingItem(job, state) {
  if (!job || job.installationPending === true) return null;
  const jobID = toInt(job.jobID);
  const stateJobID = toInt(state && state.jobID);
  const status = toInt(job.status);
  const links = (lastKey) => Boolean(state && (stateJobID === jobID ||
    (stateJobID === 0 && toInt(state[lastKey]) === jobID)));
  if (status === STATUS.CANCELLED && links("lastCancelledJobID")) return "cancellation";
  if (status === STATUS.DELIVERED && links("lastCompletedJobID")) return "delivery";
  if (status !== STATUS.READY) return null;
  if (toInt(state && state.lastCompletedJobID) === jobID) return "delivery";
  if (stateJobID === jobID) return "delivery";
  if (!state && job.blueprintCopy === true) return "delivery";
  return null;
}

function planRepair({ jobs, states, itemExists, characterOf }) {
  const jobsByBlueprint = new Map();
  for (const job of jobs) {
    const id = toInt(job && job.blueprintID);
    if (!jobsByBlueprint.has(id)) jobsByBlueprint.set(id, []);
    jobsByBlueprint.get(id).push(job);
  }
  const remove = [];
  const skipped = [];
  let warningJobs = 0;
  for (const [blueprintID, state] of states) {
    if (itemExists(blueprintID)) continue;
    const bpJobs = jobsByBlueprint.get(blueprintID) || [];
    const warn = bpJobs.filter((job) => recoveryIntentForMissingItem(job, state) !== null);
    if (warn.length === 0) continue;
    warningJobs += warn.length;
    const entry = {
      blueprintID,
      jobIDs: warn.map((job) => toInt(job.jobID)),
      ownerIDs: [...new Set(warn.map((job) => toInt(job.ownerID)))],
    };
    let reason = null;
    if (toInt(state.jobID) !== 0) reason = "STATE_HAS_ACTIVE_JOB";
    else if (bpJobs.some((job) => !TERMINAL.has(toInt(job.status)) || job.installationPending === true)) reason = "JOB_NOT_TERMINAL";
    else if (entry.ownerIDs.some((ownerID) => {
      const character = characterOf(ownerID);
      return !(character && character.isDeleted === true);
    })) reason = "OWNER_NOT_DELETED_CHARACTER";
    if (reason) skipped.push({ ...entry, reason });
    else remove.push(entry);
  }
  return { remove, skipped, warningJobs };
}

module.exports = {
  STATUS,
  TERMINAL,
  planRepair,
  recoveryIntentForMissingItem,
  toInt,
};
