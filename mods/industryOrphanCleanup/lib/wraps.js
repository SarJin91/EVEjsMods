"use strict";

const { planRepair, toInt } = require("./plan");

const WRAPPED = Symbol.for("evejs.industryOrphanCleanup.wrapped");
const JOBS_TABLE = "industryJobs";

function markWrapped(fn) {
  Object.defineProperty(fn, WRAPPED, { value: true });
  return fn;
}

function depsReady(deps) {
  return Boolean(
    deps &&
      deps.industry &&
      typeof deps.industry.getBlueprintState === "function" &&
      typeof deps.industry.removeBlueprintState === "function" &&
      deps.items &&
      typeof deps.items.findItemById === "function" &&
      deps.store &&
      typeof deps.store.read === "function",
  );
}

function cleanupAfterDelete(characterID, deps) {
  if (!depsReady(deps)) return { ok: false, removed: [], skipped: [], reason: "deps-missing" };
  const ownerID = toInt(characterID);
  const read = deps.store.read(JOBS_TABLE, "/");
  if (!read || read.success !== true) return { ok: false, removed: [], skipped: [], reason: "jobs-unreadable" };
  const allJobs = Object.values((read.data || {}).jobs || {}).filter((job) => job && typeof job === "object");
  const candidates = new Set(
    allJobs.filter((job) => toInt(job.ownerID) === ownerID).map((job) => toInt(job.blueprintID)).filter((id) => id > 0),
  );
  const states = new Map();
  for (const blueprintID of candidates) {
    const state = deps.industry.getBlueprintState(blueprintID);
    if (state) states.set(blueprintID, state);
  }
  if (states.size === 0) return { ok: true, removed: [], skipped: [] };
  const plan = planRepair({
    jobs: allJobs.filter((job) => states.has(toInt(job.blueprintID))),
    states,
    itemExists: (id) => Boolean(deps.items.findItemById(id)),
    characterOf: (id) => (id === ownerID ? { isDeleted: true } : null),
  });
  const removed = [];
  const skipped = plan.skipped.map((entry) => ({ blueprintID: entry.blueprintID, reason: entry.reason }));
  for (const entry of plan.remove) {
    if (deps.industry.removeBlueprintState(entry.blueprintID)) removed.push(entry.blueprintID);
    else skipped.push({ blueprintID: entry.blueprintID, reason: "REMOVE_FAILED" });
  }
  return { ok: true, removed, skipped };
}

function wrapDeleteCharacter(exports, { state, stats, deps, config, logFn, onError }) {
  const previous = exports && exports.deleteCharacter;
  if (typeof previous !== "function") return { ok: false, reason: "missing-method" };
  if (previous[WRAPPED]) return { ok: false, reason: "already-wrapped" };

  const wrapped = function deleteCharacter(characterID, accountID) {
    const result = previous.apply(this, arguments);
    if (state.inert || !(result && result.success === true)) return result;
    try {
      stats.deletes += 1;
      const outcome = cleanupAfterDelete(characterID, deps);
      if (!outcome.ok) {
        if (outcome.reason === "deps-missing") stats.skippedDeps += 1;
        else {
          stats.errors += 1;
          onError(`cleanup for char ${characterID} skipped: ${outcome.reason}`);
        }
        return result;
      }
      stats.cleanups += 1;
      stats.removed += outcome.removed.length;
      stats.skipped += outcome.skipped.length;
      if (config.log && (outcome.removed.length > 0 || outcome.skipped.length > 0)) {
        const skippedText = outcome.skipped.map((entry) => `${entry.blueprintID}:${entry.reason}`).join(",");
        logFn(
          `removed ${outcome.removed.length} state records for char ${characterID} (bp=${outcome.removed.join(",")})` +
            (outcome.skipped.length > 0 ? ` skipped ${outcome.skipped.length} (${skippedText})` : ""),
        );
      }
    } catch (error) {
      stats.errors += 1;
      onError(`cleanup for char ${characterID} failed - deletion result kept`, error);
    }
    return result;
  };
  exports.deleteCharacter = markWrapped(wrapped);
  return { ok: true };
}

module.exports = {
  JOBS_TABLE,
  WRAPPED,
  cleanupAfterDelete,
  depsReady,
  wrapDeleteCharacter,
};
