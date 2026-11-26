"use strict";

const S = require("./schema");
const OCC = require("../occupation/schema");

function decideStep(view, params) {
  const { invasion, payloadSeq, holders, holdersTruncated, at, liveFleets, beachhead } = view;
  const { holdMinFleets, checkIntervalMs, withdrawRetryMs, withdrawMaxRounds } = params;

  if (invasion.state === S.STATE_ENDED || payloadSeq !== invasion.stepSeq) {
    return { action: "STALE" };
  }

  if (invasion.state === S.STATE_ACTIVE) {
    if (invasion.withdrawAt !== null && invasion.withdrawAt !== undefined && at >= invasion.withdrawAt) {
      return { action: "WITHDRAW", next: { dueAt: at } };
    }
    if (holdersTruncated) {
      return { action: "HOLD", next: { dueAt: at + checkIntervalMs } };
    }
    if (holders < holdMinFleets) {
      return { action: "COLLAPSE", reason: S.END_REASON_BEACHHEAD_LOST };
    }
    return { action: "HOLD", next: { dueAt: at + checkIntervalMs } };
  }

  if (invasion.state === S.STATE_WITHDRAWING) {
    const currentRound = invasion.withdrawRound || 0;

    const disband = liveFleets.filter((f) =>
      f.state === "IDLE" && f.operationId === null && f.systemId !== null && f.systemId !== undefined
    );

    const abandon = [];
    const keep = [];
    const controlled = beachhead.controller === invasion.factionId && beachhead.capturedAt !== null
      && OCC.OCCUPATION_STATES.includes(beachhead.occupationState);
    if (controlled && view.beachheadSystemId) {
      if (view.keepsConquest === true && beachhead.occupationState === OCC.STABLE) keep.push(view.beachheadSystemId);
      else abandon.push(view.beachheadSystemId);
    }

    const rest = liveFleets.filter((f) => !disband.some((d) => d.fleetId === f.fleetId));

    if (rest.length === 0) {
      return { action: "END_WITHDRAWN", disband, abandon, keep };
    }

    if (currentRound + 1 >= withdrawMaxRounds) {
      return { action: "END_TIMEOUT", disband, abandon, keep, leftover: rest.length };
    }

    return { action: "WITHDRAW_ROUND", disband, abandon, keep, next: { dueAt: at + withdrawRetryMs } };
  }

  return { action: "STALE" };
}

function settleRound(decision, refused, round, params, at) {
  if (decision.action === "WITHDRAW_ROUND") return { action: "WITHDRAW_ROUND", next: decision.next };
  if (decision.action === "END_TIMEOUT") return { action: "END_TIMEOUT", leftover: (decision.leftover || 0) + refused };
  if (refused === 0) return { action: "END_WITHDRAWN" };
  if (round + 1 >= params.withdrawMaxRounds) return { action: "END_TIMEOUT", leftover: refused };
  return { action: "WITHDRAW_ROUND", next: { dueAt: at + params.withdrawRetryMs } };
}

function effectiveWithdrawAt(withdrawAt, startedAt, afterMs) {
  if (withdrawAt !== null && withdrawAt !== undefined) return withdrawAt;
  if (Number.isSafeInteger(afterMs) && afterMs > 0 && Number.isSafeInteger(startedAt)) return startedAt + afterMs;
  return null;
}

module.exports = { decideStep, settleRound, effectiveWithdrawAt };