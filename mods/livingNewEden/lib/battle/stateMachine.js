"use strict";

const { BATTLE_STATES, BATTLE_MODES } = require("./schema");

function freezeTable(entries) {
  const table = {};
  for (const [from, to] of entries) table[from] = Object.freeze([...to]);
  return Object.freeze(table);
}

const BATTLE_TRANSITIONS = freezeTable([
  ["PENDING", ["PENDING", "CLAIMED", "FAILED", "QUARANTINED"]],
  ["CLAIMED", ["CLAIMED", "RESOLVING", "LIVE", "FAILED", "QUARANTINED"]],
  ["RESOLVING", ["SETTLING", "FAILED", "QUARANTINED"]],
  ["LIVE", ["SETTLING", "FAILED", "QUARANTINED"]],
  ["SETTLING", ["COMPLETED", "FAILED", "QUARANTINED"]],
  ["COMPLETED", []],
  ["FAILED", []],
  ["QUARANTINED", []],
]);

const MODE_RULES = Object.freeze({
  RESOLVING: Object.freeze(["VIRTUAL", "EFS_TEST"]),
  LIVE: Object.freeze(["LIVE_EVEJS"]),
});
const CLAIMABLE_STATES = Object.freeze(["PENDING", "CLAIMED"]);

const STATES_WITH_MODE = Object.freeze(["CLAIMED", "RESOLVING", "LIVE", "SETTLING", "COMPLETED"]);
const STATES_WITH_RESULT = Object.freeze(["SETTLING", "COMPLETED"]);
const STATES_WITH_ERROR = Object.freeze(["FAILED", "QUARANTINED"]);

function canTransitionBattle(from, to) {
  if (!BATTLE_STATES.includes(from)) return { ok: false, reason: "UNKNOWN_STATE", state: from };
  if (!BATTLE_STATES.includes(to)) return { ok: false, reason: "UNKNOWN_STATE", state: to };
  if (!BATTLE_TRANSITIONS[from].includes(to)) return { ok: false, reason: "ILLEGAL_TRANSITION", from, to };
  return { ok: true };
}

function checkMode(to, mode) {
  if (mode !== null && !BATTLE_MODES.includes(mode)) return { ok: false, reason: "UNKNOWN_MODE", mode };
  const allowed = MODE_RULES[to];
  if (allowed && !allowed.includes(mode)) return { ok: false, reason: "MODE_MISMATCH", state: to, mode };
  return { ok: true };
}

function listBattleEdges() {
  const out = [];
  for (const [from, list] of Object.entries(BATTLE_TRANSITIONS)) for (const to of list) out.push([from, to]);
  return out;
}

function checkBattleInvariants(record) {
  const { state } = record;
  const fail = (field) => ({ ok: false, reason: "BATTLE_INVARIANT", field, state });
  if (STATES_WITH_MODE.includes(state) && record.mode === null) return fail("mode");
  if (STATES_WITH_RESULT.includes(state) && record.result === null) return fail("result");
  if (state === "COMPLETED" && record.settlementKey === null) return fail("settlementKey");
  if (STATES_WITH_ERROR.includes(state) && record.error === null) return fail("error");
  if (state !== "PENDING" && record.holdReason !== null) return fail("holdReason");
  return { ok: true };
}

module.exports = {
  BATTLE_TRANSITIONS,
  MODE_RULES,
  CLAIMABLE_STATES,
  STATES_WITH_ERROR,
  canTransitionBattle,
  checkMode,
  listBattleEdges,
  checkBattleInvariants,
};
