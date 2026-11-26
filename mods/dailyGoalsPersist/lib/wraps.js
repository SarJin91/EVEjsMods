"use strict";

const WRAPPED = Symbol.for("evejs.dailyGoalsPersist.wrapped");
const DAILY_GOALS_TABLE = "dailyGoals";

function markWrapped(fn) {
  Object.defineProperty(fn, WRAPPED, { value: true });
  return fn;
}

function isRootPath(pth) {
  return String(pth || "/").split("/").filter(Boolean).length === 0;
}

function sameIdentity(left, right) {
  return String(left) === String(right);
}

function wrapStoreWrite(storeExports, { state, stats, onError }) {
  const previous = storeExports && storeExports.write;
  if (typeof previous !== "function") return { ok: false, reason: "missing-method" };
  if (previous[WRAPPED]) return { ok: false, reason: "already-wrapped" };

  const wrapped = function write(table, pth, data, options) {
    if (state.inert || table !== DAILY_GOALS_TABLE) return previous.apply(this, arguments);
    let forcedArguments = null;
    try {
      const plain = options === undefined || (options !== null && typeof options === "object");
      if (plain && isRootPath(pth)) {
        const given = options || {};
        if (given.transient !== true && given.force !== true) {
          forcedArguments = Array.prototype.slice.call(arguments);
          forcedArguments[3] = { ...given, force: true };
        }
      }
    } catch (error) {
      forcedArguments = null;
      onError("write wrap bookkeeping failed - vanilla write", error);
    }
    if (!forcedArguments) return previous.apply(this, arguments);
    stats.forcedWrites += 1;
    return previous.apply(this, forcedArguments);
  };
  storeExports.write = markWrapped(wrapped);
  return { ok: true };
}

function wrapRedeem(stateExports, { state, redeemLog, onError }) {
  const previousRedeem = stateExports && stateExports.redeemGoal;
  const previousClaim = stateExports && stateExports.claimMonthlyMilestone;
  if (typeof previousRedeem !== "function" || typeof previousClaim !== "function") {
    return { ok: false, reason: "missing-method" };
  }
  if (previousRedeem[WRAPPED] || previousClaim[WRAPPED]) return { ok: false, reason: "already-wrapped" };

  let lastDailyFailure = null;

  const redeemGoal = function redeemGoal(characterID, uuid) {
    lastDailyFailure = null;
    const result = previousRedeem.apply(this, arguments);
    if (state.inert) return result;
    try {
      if (result && result.success === false) {
        lastDailyFailure = { characterID, uuid, errorMsg: result.errorMsg };
      }
    } catch (error) {
      onError("redeem wrap bookkeeping failed - ignored", error);
    }
    return result;
  };

  const claimMonthlyMilestone = function claimMonthlyMilestone(characterID, uuid) {
    const daily = lastDailyFailure;
    lastDailyFailure = null;
    const result = previousClaim.apply(this, arguments);
    if (state.inert || !daily) return result;
    try {
      if (
        result &&
        result.success === false &&
        sameIdentity(daily.characterID, characterID) &&
        sameIdentity(daily.uuid, uuid)
      ) {
        redeemLog.report({
          characterID,
          uuid,
          dailyError: daily.errorMsg,
          monthlyError: result.errorMsg,
        });
      }
    } catch (error) {
      onError("redeem 404 log failed - ignored", error);
    }
    return result;
  };

  stateExports.redeemGoal = markWrapped(redeemGoal);
  stateExports.claimMonthlyMilestone = markWrapped(claimMonthlyMilestone);
  return { ok: true };
}

module.exports = {
  DAILY_GOALS_TABLE,
  WRAPPED,
  isRootPath,
  wrapRedeem,
  wrapStoreWrite,
};
