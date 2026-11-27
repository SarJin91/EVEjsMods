"use strict";

const REASONS = Object.freeze(["force", "target", "interval"]);

function emptyDay() {
  return { force: 0, target: 0, interval: 0 };
}

function createCheckpointDrive(deps) {
  const d = deps || {};
  let day = emptyDay();
  if (d.state && typeof d.state === "object") {
    for (const r of REASONS) day[r] = Number(d.state[r]) || 0;
  }

  function record(reason) {
    if (REASONS.includes(reason)) day[reason] += 1;
  }

  function afterPass(handle) {
    if (!handle || !handle.checkpointer || !handle.store || typeof handle.store.getWalStatus !== "function") {
      return { ran: false, reason: null };
    }
    let reason;
    try {
      reason = d.decide(handle.store.getWalStatus(), null, d.nowMs(), d.settings);
    } catch (_err) {
      return { ran: false, reason: null };
    }
    if (!REASONS.includes(reason)) return { ran: false, reason: null };
    let r;
    try {
      r = handle.checkpointer.runOnce(reason);
    } catch (_err) {
      r = null;
    }
    if (!r || r.ok !== true) return { ran: false, reason };
    record(reason);
    return { ran: true, reason };
  }

  function takeDay() {
    const out = day;
    day = emptyDay();
    return out;
  }

  function state() {
    return { ...day };
  }

  return Object.freeze({ afterPass, takeDay, record, state });
}

module.exports = { createCheckpointDrive, CHECKPOINT_DRIVE_REASONS: REASONS };
