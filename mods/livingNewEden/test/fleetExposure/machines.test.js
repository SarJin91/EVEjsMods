"use strict";

const assert = require("node:assert");

const { decideConvoyStep, ACTION: CONVOY_ACTION } = require("../../lib/economy/logistics/convoyMachine");
const { decideStep, ACTION: TRIP_ACTION } = require("../../lib/economy/mining/tripMachine");
const { planHousekeeping } = require("../../lib/strategy/ai/housekeeping");

const PARAMS = Object.freeze({ maxWatchRounds: 12 });
const HK = Object.freeze({ operationGraceMs: 60000, maxHousekeepingPerReview: 8, maxRefitRequestsPerReview: 0 });

const fleetOf = (o) => ({ fleetId: "f1", state: "MATERIALIZED", currentSystemId: 2, operationId: "op1",
  refitPending: false, nextActionAt: null, ...o });

module.exports = ({ test }) => {
  test("FEX5 MATERIALIZED with the operation: convoy WAIT/IGNORE EXPOSED, mining MINING WAIT EXPOSED "
    + "housekeeping keeps the exposed operation, a hunt lock without operation unchanged", () => {
    const convoy = { state: "IN_TRANSIT", sourceSystemId: 1, destSystemId: 3, operationId: "op1", watchRound: 0 };
    const facts = (trigger) => ({ at: 1, trigger, sourceOk: true, destOk: true, stationHereId: null,
      stationsMode: "ready", carriers: 2 });
    const toSource = { ...convoy, state: "TO_SOURCE" };
    const out = {
      due: decideConvoyStep(convoy, fleetOf(), facts("due"), PARAMS),
      arrival: decideConvoyStep(convoy, fleetOf(), facts("arrival"), PARAMS),
      reconcile: decideConvoyStep(convoy, fleetOf(), facts("reconcile"), PARAMS),
      toSource: decideConvoyStep(toSource, fleetOf(), facts("due"), PARAMS),
      lateRound: decideConvoyStep({ ...convoy, watchRound: 99 }, fleetOf(), facts("due"), PARAMS),
    };
    assert.deepStrictEqual(out, {
      due: { action: CONVOY_ACTION.WAIT, reason: "EXPOSED" },
      arrival: { action: CONVOY_ACTION.IGNORE, reason: "EXPOSED" },
      reconcile: { action: CONVOY_ACTION.WAIT, reason: "EXPOSED" },
      toSource: { action: CONVOY_ACTION.WAIT, reason: "EXPOSED" },
      lateRound: { action: CONVOY_ACTION.WAIT, reason: "EXPOSED" },
    });

    const trip = { state: "MINING", beltSystemId: 2, outboundOperationId: "op1", returnOperationId: null,
      miningEndsAt: 1000, watchRound: 0 };
    const tf = (at, trigger = "due") => ({ at, trigger, stationHere: false, stationsMode: "ready" });
    assert.deepStrictEqual([decideStep(trip, fleetOf(), tf(10), PARAMS), decideStep(trip, fleetOf(), tf(2000), PARAMS),
      decideStep(trip, fleetOf(), tf(10, "arrival"), PARAMS)], [{ action: TRIP_ACTION.WAIT, reason: "EXPOSED" },
      { action: TRIP_ACTION.WAIT, reason: "EXPOSED" }, { action: TRIP_ACTION.IGNORE, reason: "EXPOSED" }]);
    assert.strictEqual(decideStep(trip, fleetOf({ state: "STAGED" }), tf(2000), PARAMS).action, TRIP_ACTION.LOAD);

    const op = (operationId) => ({ operationId, state: "ACTIVE", dueAt: null, version: 3 });
    const snapshot = { at: 5000000, fleetsTruncated: false, sightings: [],
      operations: [op("op1"), op("op2")],
      fleets: [fleetOf({ fleetId: "f1", operationId: "op1" }),
        fleetOf({ fleetId: "f2", operationId: null })] };
    const plan = planHousekeeping(snapshot, HK);
    assert.deepStrictEqual(plan.closed, ["op2"], JSON.stringify(plan.intents));
    assert.deepStrictEqual(plan.intents.filter((i) => i.type === "CLOSE_OPERATION").map((i) => [i.operationId,
      i.result.reason]), [["op2", "NO_ORDERED_MEMBERS"]]);
  });
};
