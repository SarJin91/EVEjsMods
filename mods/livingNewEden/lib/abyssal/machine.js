"use strict";

const { STATE } = require("./schema");

const EVENT = Object.freeze({ POLL: "POLL", EXITED: "EXITED", LOST: "LOST" });
const FINAL = Object.freeze([STATE.EXITED, STATE.FAILED, STATE.LOST]);
const FAILED_OUTCOMES = Object.freeze(["failed_entry_readiness", "failed_room_activation", "failed_timeout",
  "failed_ship_destroyed", "abandoned_or_recovered", "admin_aborted", "cluster_shutdown_returned"]);

function mapVendorOutcome(text) {
  if (text === "completed") return STATE.COMPLETED;
  if (text === "exited") return STATE.EXITED;
  if (typeof text === "string" && FAILED_OUTCOMES.includes(text)) return STATE.FAILED;
  return STATE.ACTIVE;
}

const isFinal = (state) => FINAL.includes(state);

function nextState(current, event) {
  const kind = event && event.kind;
  if (kind !== EVENT.POLL && kind !== EVENT.EXITED && kind !== EVENT.LOST) return { ok: false, reason: "BAD_EVENT" };
  let to;
  if (current === null || current === undefined) {
    if (kind === EVENT.LOST) return { ok: false, reason: "NO_ROW" };
    to = kind === EVENT.EXITED ? STATE.EXITED : mapVendorOutcome(event.outcome);
  } else if (isFinal(current)) {
    if (current === STATE.LOST && kind === EVENT.EXITED) to = STATE.EXITED;
    else return { ok: false, reason: "FINISHED" };
  } else if (kind === EVENT.EXITED) {
    to = STATE.EXITED;
  } else if (kind === EVENT.LOST) {
    to = STATE.LOST;
  } else {
    const mapped = mapVendorOutcome(event.outcome);
    to = current === STATE.COMPLETED && mapped === STATE.ACTIVE ? STATE.COMPLETED : mapped;
  }
  return { ok: true, state: to, final: isFinal(to) };
}

module.exports = { EVENT, FINAL, FAILED_OUTCOMES, mapVendorOutcome, nextState, isFinal };
