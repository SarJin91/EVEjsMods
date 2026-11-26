"use strict";

const { MS_PER_HOUR, OWNER, OUTCOME } = require("../schema");

const PARAM_KEYS = Object.freeze(["hours"]);
const WAIT_MAX_PER_THREAD = 2;

function createWaitStep(S) {
  const maxHours = S.waitMaxHours;
  return Object.freeze({
    type: "WAIT",
    owner: OWNER,
    version: 1,
    promptHint: "WAIT: a pause of 1 to max hours before the next step (param hours)",
    maxPerThread: WAIT_MAX_PER_THREAD,
    duration: Object.freeze({ minMs: MS_PER_HOUR, maxMs: maxHours * MS_PER_HOUR }),
    validate(params) {
      if (Object.keys(params).some((k) => !PARAM_KEYS.includes(k))) return { ok: false, reason: "UNKNOWN_PARAM" };
      if (!Number.isFinite(params.hours)) return { ok: false, reason: "HOURS" };
      const hours = Math.min(maxHours, Math.max(1, Math.round(params.hours)));
      return { ok: true, params: { hours } };
    },
    startInTx(_tx, s) {
      const dueAt = s.now + s.params.hours * MS_PER_HOUR;
      return { ok: true, handle: { dueAt }, dueAt };
    },
    pollInTx(_tx, s) {
      const dueAt = s.handle && Number.isSafeInteger(s.handle.dueAt) ? s.handle.dueAt : s.now;
      return s.now >= dueAt ? { state: "DONE", outcome: OUTCOME.NEUTRAL } : { state: "RUNNING", dueAt };
    },
    cancelInTx() {
      return { ok: true };
    },
  });
}

module.exports = { createWaitStep, WAIT_MAX_PER_THREAD };
