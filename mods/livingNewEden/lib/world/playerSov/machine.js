"use strict";

const S = require("./schema");

const GONE = Object.freeze([S.END_REASON.NATIVE_GONE, S.END_REASON.OWNER_CHANGED]);
const RETAKE_END = Object.freeze([S.END_REASON.RETAKEN, S.END_REASON.OWNER_CHANGED]);

const PLAYER_SOV_TRANSITIONS = Object.freeze({
  [S.CAPTURING]: Object.freeze({ [S.HELD]: null, [S.LOST]: GONE, [S.SIEGED]: null }),
  [S.HELD]: Object.freeze({ [S.LOST]: GONE, [S.SIEGED]: null }),
  [S.SIEGED]: Object.freeze({ [S.REINFORCED]: null, [S.CAPTURING]: null, [S.HELD]: null, [S.LOST]: GONE }),
  [S.REINFORCED]: Object.freeze({ [S.RETAKING]: null, [S.CAPTURING]: null, [S.HELD]: null, [S.LOST]: GONE }),
  [S.RETAKING]: Object.freeze({ [S.LOST]: RETAKE_END }),
  [S.LOST]: Object.freeze({}),
});

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

function canTransitionPlayerSov(from, to, reason = null) {
  const denied = { ok: false, reason: S.CODES.TRANSITION_DENIED, from: String(from), to: String(to) };
  if (typeof from !== "string" || !hasOwn(PLAYER_SOV_TRANSITIONS, from)) return denied;
  const edges = PLAYER_SOV_TRANSITIONS[from];
  if (typeof to !== "string" || !hasOwn(edges, to)) return denied;
  const reasons = edges[to];
  if (reasons === null) return reason === null || reason === undefined ? { ok: true } : denied;
  return reasons.includes(reason) ? { ok: true } : denied;
}

function listPlayerSovEdges() {
  const out = [];
  for (const [from, edges] of Object.entries(PLAYER_SOV_TRANSITIONS)) {
    for (const [to, reasons] of Object.entries(edges)) {
      if (reasons === null) out.push([from, to, null]);
      else for (const r of reasons) out.push([from, to, r]);
    }
  }
  return out;
}

module.exports = { PLAYER_SOV_TRANSITIONS, canTransitionPlayerSov, listPlayerSovEdges };
