"use strict";

const { FLEET_STATES, OPERATION_STATES } = require("./schema");

function freezeTable(entries) {
  const table = {};
  for (const [from, to] of entries) table[from] = Object.freeze([...to]);
  return Object.freeze(table);
}

const FLEET_TRANSITIONS = freezeTable([
  ["IDLE", ["PLANNED", "ENGAGED", "REFITTING", "RETREATING", "DESTROYED", "MATERIALIZED"]],
  ["PLANNED", ["TRAVELLING", "STAGED", "IDLE", "ENGAGED"]],
  ["TRAVELLING", ["TRAVELLING", "STAGED", "RETREATING", "ENGAGED"]],
  ["STAGED", ["PLANNED", "IDLE", "RETREATING", "ENGAGED", "MATERIALIZED"]],
  ["ENGAGED", ["IDLE", "STAGED", "REFITTING", "RETREATING", "DESTROYED"]],
  ["RETREATING", ["RETREATING", "REFITTING", "ENGAGED", "IDLE"]],
  ["REFITTING", ["IDLE", "ENGAGED", "MATERIALIZED"]],
  ["DESTROYED", []],
  ["MATERIALIZED", ["IDLE", "STAGED", "REFITTING"]],
]);

const OPERATION_TRANSITIONS = freezeTable([
  ["PLANNED", ["ACTIVE", "CANCELLED"]],
  ["ACTIVE", ["COMPLETED", "FAILED", "CANCELLED"]],
  ["COMPLETED", []],
  ["FAILED", []],
  ["CANCELLED", []],
]);

const ENTRY_CLEARED_FIELDS = Object.freeze({
  IDLE: Object.freeze(["operationId", "targetSystemId", "route", "routeGraphVersion", "nextActionAt"]),
  DESTROYED: Object.freeze(["targetSystemId", "route", "routeGraphVersion", "nextActionAt"]),
});

const STATES_WITH_OPERATION = Object.freeze(["PLANNED", "TRAVELLING", "STAGED"]);
const STATES_IN_FLIGHT = Object.freeze(["TRAVELLING", "RETREATING"]);
const STATES_WITH_DEADLINE = Object.freeze(["REFITTING"]);

function check(table, known, from, to) {
  if (!known.includes(from)) return { ok: false, reason: "UNKNOWN_STATE", state: from };
  if (!known.includes(to)) return { ok: false, reason: "UNKNOWN_STATE", state: to };
  if (!table[from].includes(to)) return { ok: false, reason: "ILLEGAL_TRANSITION", from, to };
  return { ok: true };
}

function canTransitionFleet(from, to) {
  return check(FLEET_TRANSITIONS, FLEET_STATES, from, to);
}

function canTransitionOperation(from, to) {
  return check(OPERATION_TRANSITIONS, OPERATION_STATES, from, to);
}

function listEdges(table) {
  const out = [];
  for (const [from, list] of Object.entries(table)) for (const to of list) out.push([from, to]);
  return out;
}

const listFleetEdges = () => listEdges(FLEET_TRANSITIONS);
const listOperationEdges = () => listEdges(OPERATION_TRANSITIONS);

function clearedOnEntry(state) {
  return ENTRY_CLEARED_FIELDS[state] || [];
}

function checkFleetInvariants(record) {
  const { state } = record;
  const fail = (field) => ({ ok: false, reason: "FLEET_INVARIANT", field, state });
  if (STATES_WITH_OPERATION.includes(state) && record.operationId === null) return fail("operationId");
  if (STATES_IN_FLIGHT.includes(state)) {
    if (record.route === null) return fail("route");
    if (record.targetSystemId === null) return fail("targetSystemId");
    if (record.nextActionAt === null) return fail("nextActionAt");
  }
  if (STATES_WITH_DEADLINE.includes(state) && record.nextActionAt === null) return fail("nextActionAt");
  if ((record.shipCount === 0) !== (state === "DESTROYED")) return fail("shipCount");
  return { ok: true };
}

module.exports = {
  FLEET_TRANSITIONS,
  OPERATION_TRANSITIONS,
  ENTRY_CLEARED_FIELDS,
  canTransitionFleet,
  canTransitionOperation,
  listFleetEdges,
  listOperationEdges,
  clearedOnEntry,
  checkFleetInvariants,
};
