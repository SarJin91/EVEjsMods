"use strict";

const S = require("./schema");

const SOV_TRANSITIONS = Object.freeze({
  [S.ANCHORING]: Object.freeze([S.ONLINE, S.DESTROYED, S.ENDED]),
  [S.ONLINE]: Object.freeze([S.DESTROYED, S.ENDED]),
  [S.DESTROYED]: Object.freeze([]),
  [S.ENDED]: Object.freeze([]),
});

function canTransitionSov(from, to) {
  const list = Object.prototype.hasOwnProperty.call(SOV_TRANSITIONS, from) ? SOV_TRANSITIONS[from] : null;
  if (list === null || !S.STATES.includes(to) || !list.includes(to)) {
    return { ok: false, reason: S.CODES.TRANSITION_DENIED, from: String(from), to: String(to) };
  }
  return { ok: true };
}

function listSovEdges() {
  const out = [];
  for (const [from, list] of Object.entries(SOV_TRANSITIONS)) for (const to of list) out.push([from, to]);
  return out;
}

module.exports = { SOV_TRANSITIONS, canTransitionSov, listSovEdges };
