"use strict";

const STATES = Object.freeze(["LAUNCHING", "ACTIVE", "RETURNING", "LOST", "SETTLED"]);
const FLYING_STATES = Object.freeze(["LAUNCHING", "ACTIVE", "RETURNING"]);

const NONE = "none";

const EVENTS = Object.freeze([
  "LAUNCH", "SPAWN_OK", "SPAWN_FAILED", "RETURN", "RECALL_DONE", "RECALL_TIMEOUT",
  "FORCED_END", "TWIN_MISSING", "RESTART", "DESTROYED", "SETTLED", "PURGE", "BOARDED",
]);

const TRANSITIONS = Object.freeze({
  [NONE]: Object.freeze({ LAUNCH: "LAUNCHING" }),
  LAUNCHING: Object.freeze({
    SPAWN_OK: "ACTIVE", SPAWN_FAILED: null, FORCED_END: null, RESTART: null, DESTROYED: "LOST",
  }),
  ACTIVE: Object.freeze({
    RETURN: "RETURNING", FORCED_END: null, TWIN_MISSING: "LOST", RESTART: null, DESTROYED: "LOST", BOARDED: null,
  }),
  RETURNING: Object.freeze({
    RECALL_DONE: null, RECALL_TIMEOUT: null, FORCED_END: null, TWIN_MISSING: "LOST", RESTART: null,
    DESTROYED: "LOST", BOARDED: null,
  }),
  LOST: Object.freeze({ RESTART: "LOST", SETTLED: "SETTLED" }),
  SETTLED: Object.freeze({ RESTART: "SETTLED", PURGE: null }),
});

function transition(from, event) {
  const row = TRANSITIONS[from === null || from === undefined ? NONE : from];
  if (!row || typeof event !== "string" || !Object.prototype.hasOwnProperty.call(row, event)) {
    return { ok: false, reason: "BAD_TRANSITION" };
  }
  return { ok: true, next: row[event] };
}

module.exports = { STATES, FLYING_STATES, EVENTS, TRANSITIONS, transition };
