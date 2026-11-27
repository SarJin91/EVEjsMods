"use strict";

const assert = require("node:assert");

const { TRIP_TRANSITIONS, ACTION, canTransitionTrip, decideStep } = require("../../lib/economy/mining/tripMachine");
const { TRIP_STATES } = require("../../lib/economy/schema");

const BELT = 30000205;
const OTHER = 30000206;
const PARAMS = Object.freeze({ maxWatchRounds: 3 });
const trip = (state, extra = {}) => ({ tripId: "mt_1", state, beltSystemId: BELT, outboundOperationId: "op_out",
  returnOperationId: state === "RETURNING" ? "op_back" : null, miningEndsAt: 1000, watchRound: 0, ...extra });
const fleet = (state, extra = {}) => ({ fleetId: "f1", state, currentSystemId: BELT, operationId: "op_out",
  refitPending: false, shipCount: 3, ...extra });
const facts = (extra = {}) => ({ at: 1000, trigger: "due", stationHere: false, stationsMode: "ready", ...extra });
const act = (t, f, x = {}) => decideStep(t, f, facts(x), PARAMS).action;

module.exports = ({ test }) => {
  test("M2 decideStep: states x fleet situations, terminal STALE, nudge IGNORE, TIMEOUT, edges", () => {
    const destroyed = fleet("DESTROYED", { shipCount: 0 });
    const flying = fleet("TRAVELLING");
    const inBelt = fleet("STAGED");
    const elsewhere = fleet("STAGED", { currentSystemId: OTHER });
    const engaged = fleet("ENGAGED");
    const refitting = fleet("REFITTING", { currentSystemId: OTHER, operationId: null });
    const idle = fleet("IDLE", { currentSystemId: OTHER, operationId: null });
    const table = [
      ["OUTBOUND", null, {}, ACTION.ABORT], ["OUTBOUND", destroyed, {}, ACTION.ABORT],
      ["OUTBOUND", flying, {}, ACTION.WAIT], ["OUTBOUND", inBelt, {}, ACTION.START_MINING],
      ["OUTBOUND", elsewhere, {}, ACTION.ABORT], ["OUTBOUND", engaged, {}, ACTION.WAIT],
      ["OUTBOUND", refitting, { stationHere: true }, ACTION.ABORT], ["OUTBOUND", idle, {}, ACTION.ABORT],
      ["MINING", destroyed, {}, ACTION.ABORT], ["MINING", fleet("RETREATING"), {}, ACTION.ABORT],
      ["MINING", inBelt, {}, ACTION.LOAD], ["MINING", inBelt, { at: 999 }, ACTION.WAIT],
      ["MINING", elsewhere, {}, ACTION.ABORT], ["MINING", engaged, {}, ACTION.WAIT],
      ["MINING", refitting, { stationHere: true }, ACTION.ABORT], ["MINING", idle, {}, ACTION.ABORT],
      ["RETURNING", null, {}, ACTION.LOSE], ["RETURNING", destroyed, {}, ACTION.LOSE],
      ["RETURNING", fleet("TRAVELLING", { operationId: "op_back" }), {}, ACTION.WAIT],
      ["RETURNING", fleet("RETREATING"), {}, ACTION.WAIT],
      ["RETURNING", fleet("STAGED", { operationId: "op_back" }), { stationHere: true }, ACTION.DELIVER],
      ["RETURNING", elsewhere, {}, ACTION.RESEEK], ["RETURNING", engaged, {}, ACTION.WAIT],
      ["RETURNING", refitting, { stationHere: true }, ACTION.DELIVER], ["RETURNING", refitting, {}, ACTION.WAIT],
      ["RETURNING", idle, {}, ACTION.RESEEK], ["RETURNING", idle, { stationHere: true }, ACTION.DELIVER],
      ["RETURNING", fleet("IDLE", { operationId: null, refitPending: true }), {}, ACTION.WAIT],
    ];
    for (const [state, f, x, expected] of table) {
      assert.strictEqual(act(trip(state), f, x), expected, `${state} x ${f ? f.state : "null"} ${JSON.stringify(x)}`);
    }
    for (const state of ["DELIVERED", "ABORTED", "LOST"]) assert.strictEqual(act(trip(state), inBelt), ACTION.STALE);
    assert.strictEqual(act(trip("OUTBOUND"), flying, { trigger: "arrival" }), ACTION.IGNORE);
    assert.strictEqual(act(trip("RETURNING"), idle, { trigger: "arrival" }), ACTION.IGNORE);
    assert.deepStrictEqual(decideStep(trip("OUTBOUND", { watchRound: 3 }), flying, facts(), PARAMS),
      { action: ACTION.ABORT, reason: "TIMEOUT" });
    assert.deepStrictEqual(decideStep(trip("RETURNING", { watchRound: 3 }), engaged, facts(), PARAMS),
      { action: ACTION.LOSE, reason: "TIMEOUT" });
    assert.deepStrictEqual(decideStep(trip("RETURNING", { watchRound: 3 }), idle, facts(), PARAMS),
      { action: ACTION.LOSE, reason: "TIMEOUT" });
    assert.strictEqual(act(trip("OUTBOUND", { watchRound: 2 }), flying), ACTION.WAIT);
    assert.deepStrictEqual(decideStep(trip("MINING"), inBelt, facts({ stationsMode: "pending" }), PARAMS),
      { action: ACTION.RETRY_LATER, reason: "STATIONS_NOT_READY" });
    let edges = 0;
    for (const from of TRIP_STATES) {
      for (const to of TRIP_STATES) {
        const r = canTransitionTrip(from, to);
        assert.strictEqual(r.ok, TRIP_TRANSITIONS[from].includes(to), `${from} -> ${to}`);
        if (r.ok) edges += 1;
        else assert.strictEqual(r.reason, "ILLEGAL_TRANSITION");
      }
    }
    assert.strictEqual(edges, 7);
    assert.strictEqual(canTransitionTrip("OUTBOUND", "NOPE").reason, "UNKNOWN_STATE");
  });
};
