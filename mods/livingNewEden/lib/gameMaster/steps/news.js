"use strict";

const { OWNER, OUTCOME } = require("../schema");

function createNewsStep() {
  return Object.freeze({
    type: "NEWS",
    owner: OWNER,
    version: 1,
    promptHint: "NEWS: the galactic news report the story (no param)",
    maxPerThread: 1,
    duration: Object.freeze({ minMs: 0, maxMs: 0 }),
    validate(params) {
      return Object.keys(params).length === 0 ? { ok: true, params: {} } : { ok: false, reason: "UNKNOWN_PARAM" };
    },
    startInTx(_tx, s) {
      return { ok: true, handle: {}, dueAt: s.now };
    },
    pollInTx() {
      return { state: "DONE", outcome: OUTCOME.NEUTRAL };
    },
    cancelInTx() {
      return { ok: true };
    },
  });
}

module.exports = { createNewsStep };
