"use strict";

const assert = require("node:assert");

const D = require("../../lib/garrisonPatrol/defense");

const OWNER = 500019;
const OTHER = 500010;
const T = 30001990;
const N1 = 30001991;
const N2 = 30001992;
const N3 = 30001993;

module.exports = ({ test }) => {
  test("R1 reinforce: neighbours from the toSystemId of the gates (no target, no duplicate); the pool drops a foreign "
    + "faction, invasion, IDLE with an operation, busy, capital; keep 1 (one fleet -> nothing, two -> one); order "
    + "shipCount desc, fleetId asc; gate = the target gate towards the source", () => {
    const gates = [
      { kind: "stargate", itemId: 503, toSystemId: N1 },
      { kind: "stargate", itemId: 501, toSystemId: N1 },
      { kind: "stargate", itemId: 502, toSystemId: N2 },
      { kind: "stargate", itemId: 504, toSystemId: T },
      { kind: "stargate", itemId: 505, toSystemId: N3 },
      { kind: "stargate", itemId: 506 },
    ];
    assert.deepStrictEqual(D.neighboursOf(gates, T), [N1, N2, N3]);
    const fleet = (fleetId, extra) => ({ fleetId, factionId: OWNER, fleetRole: "garrison", state: "IDLE",
      operationId: null, refitPending: false, shipCount: 3, ...extra });
    const bySystem = new Map([
      [N1, [fleet("f-n1b"), fleet("f-n1a", { shipCount: 5 }), fleet("f-foreign", { factionId: OTHER }),
        fleet("f-inv", { fleetRole: "invasion" }), fleet("f-op", { operationId: "op-1" })]],
      [N2, [fleet("f-n2", { shipCount: 9 })]],
      [N3, [fleet("f-n3busy", { shipCount: 8 }), fleet("f-n3cap", { shipCount: 7 }), fleet("f-n3c", { fleetRole: "patrol",
        shipCount: 5 })]],
    ]);
    const o = { ownerFactionId: OWNER, roles: ["garrison", "patrol"], kinds: ["pirate"], excludedFactions: [],
      factionKindOf: (id) => (id === OWNER ? "pirate" : "empire"), keepPerSystem: 1, busy: new Set(["f-n3busy"]),
      hasCapital: (f) => f.fleetId === "f-n3cap" };
    const got = D.pickReinforcements(gates, T, bySystem, o);
    assert.deepStrictEqual(got.map((c) => [c.fleet.fleetId, c.fromSystemId, c.gate.itemId]),
      [["f-n1a", N1, 501], ["f-n3c", N3, 505]]);
    const tie = new Map([[N1, [fleet("f-b"), fleet("f-a"), fleet("f-c")]]]);
    assert.deepStrictEqual(D.pickReinforcements(gates, T, tie, { ...o, keepPerSystem: 0, busy: new Set() })
      .map((c) => c.fleet.fleetId), ["f-a", "f-b", "f-c"]);
    assert.deepStrictEqual(D.pickReinforcements(gates, T, bySystem, { ...o, kinds: ["empire"] }), []);
    assert.deepStrictEqual(D.pickReinforcements(null, T, null, null), []);
    assert.deepStrictEqual(D.pickReinforcements(gates, T, bySystem, { ...o, hasCapital: () => { throw new Error("x"); } }),
      [], "a throwing hasCapital = capital");
  });
};
