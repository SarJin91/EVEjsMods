"use strict";

const assert = require("node:assert");
const { planCamps, decideCampStep, crossingStartsOf,
  routeWeightOf } = require("../../../lib/strategy/lowsec/campRules");
const { buildLeg, validateLegShape } = require("../../../lib/fleets/travel");
const { deriveSeed } = require("../../../lib/util/rng");

const SYS = new Map([[1, ["nullsec", 10]], [2, ["lowsec", 10]], [3, ["lowsec", 10]], [4, ["lowsec", 99]],
  [5, ["lowsec", 10]], [6, ["highsec", 10]], [9, ["highsec", 10]], [7, ["lowsec", 10]]]);
const EDGES = new Map([[1, [2, 5, 6]], [2, [1, 3, 9]], [3, [2, 4]], [4, [3]], [5, [1]], [6, [1]], [9, [2]], [7, []]]);
const PARAMS = Object.freeze({ maxActiveCamps: 6, maxActiveCampsPerFaction: 2, maxCampsPerPlan: 2, campMaxJumps: 6,
  maxBfsSystems: 500, campChoiceTopN: 1, campMinMs: 900000, campMaxMs: 5400000, campRoles: ["patrol"],
  excludedRegionIds: [99] });

const fleet = (fleetId, systemId, extra = {}) => ({ fleetId, version: 3, systemId, fleetRole: "patrol",
  refitPending: false, ...extra });

function input(over = {}) {
  return { at: 1000, round: 7, worldSeed: 42, factions: [{ factionId: 500019, open: 0 }], openTotal: 0,
    occupiedSystems: new Set(), fleetsByFaction: new Map([[500019, [fleet("f-b", 1), fleet("f-a", 1)]]]),
    neighbors: (id) => EDGES.get(id) || null,
    getSystem: (id) => (SYS.has(id) ? { secClass: SYS.get(id)[0], regionId: SYS.get(id)[1] } : null), ...over };
}

module.exports = ({ test }) => {
  test("CR1 planCamps: lowsec only, excluded region / occupied skipped, ranking gate lane -> jumps -> id "
    + "seeded choice, limits LIMIT / FACTION_LIMIT, NO_FLEET", () => {
    const got = [];
    const one = planCamps(input(), PARAMS);
    got.push(["top1", one.camps.map((c) => [c.factionId, c.fleetId, c.systemId, c.jumps, c.rank])]);
    const picked = new Set();
    for (let round = 0; round < 40; round += 1) {
      const r = planCamps(input({ round }), { ...PARAMS, campChoiceTopN: 16 });
      picked.add(r.camps[0].systemId);
    }
    got.push(["candidates", [...picked].sort((a, b) => a - b)]);
    got.push(["occupied", planCamps(input({ occupiedSystems: new Set([2]) }), PARAMS).camps.map((c) => c.systemId)]);
    const a = planCamps(input(), { ...PARAMS, campChoiceTopN: 3 });
    const b = planCamps(input(), { ...PARAMS, campChoiceTopN: 3 });
    const c = planCamps(input({ round: 8 }), { ...PARAMS, campChoiceTopN: 3 });
    got.push(["same", JSON.stringify(a) === JSON.stringify(b)]);
    got.push(["seed", a.camps[0].seed === deriveSeed(42, "lowsec-camp", "500019:7"),
      c.camps[0].seed !== a.camps[0].seed]);
    const d = a.camps[0].durationMs;
    got.push(["duration", d >= PARAMS.campMinMs && d <= PARAMS.campMaxMs && Number.isSafeInteger(d)]);
    const two = [{ factionId: 500019, open: 0 }, { factionId: 500010, open: 0 }];
    const fleets2 = new Map([[500019, [fleet("s1", 1)]], [500010, [fleet("g1", 1)]]]);
    got.push(["global", planCamps(input({ factions: two, fleetsByFaction: fleets2, openTotal: 5 }), PARAMS).skipped]);
    got.push(["perPlan", planCamps(input({ factions: two, fleetsByFaction: fleets2 }),
      { ...PARAMS, maxCampsPerPlan: 1 }).skipped]);
    got.push(["faction", planCamps(input({ factions: [{ factionId: 500019, open: 2 }] }), PARAMS).skipped]);
    got.push(["twoSystems", planCamps(input({ factions: two, fleetsByFaction: fleets2 }), PARAMS).camps
      .map((x) => [x.factionId, x.systemId])]);
    got.push(["noFleet", planCamps(input({ fleetsByFaction: new Map([[500019, [fleet("r", 1, { refitPending: true }),
      fleet("i", 1, { fleetRole: "invasion" })]]]) }), PARAMS).skipped]);
    got.push(["noTarget", planCamps(input({ fleetsByFaction: new Map([[500019, [fleet("x", 7)]]]) }), PARAMS).skipped]);
    assert.deepStrictEqual(got, [
      ["top1", [[500019, "f-a", 2, 1, 0]]],
      ["candidates", [2, 3, 5]],
      ["occupied", [5]],
      ["same", true],
      ["seed", true, true],
      ["duration", true],
      ["global", [{ factionId: 500019, reason: "LIMIT" }]],
      ["perPlan", [{ factionId: 500019, reason: "LIMIT" }]],
      ["faction", [{ factionId: 500019, reason: "FACTION_LIMIT" }]],
      ["twoSystems", [[500010, 2], [500019, 5]]],
      ["noFleet", [{ factionId: 500019, reason: "NO_FLEET" }]],
      ["noTarget", [{ factionId: 500019, reason: "NO_TARGET" }]],
    ]);
  });

  test("LSC4a decideCampStep: PLANNED -> ACTIVATE (STAGED / ENGAGED in the system), WAIT, CANCEL "
    + "TIMEOUT / FLEET_LOST / DIVERTED; ACTIVE -> KEEP (STAGED with op / ENGAGED), EXPIRE, BREAK DESTROYED / LEFT",
  () => {
    const P = { stepIntervalMs: 60000, stepRecheckMs: 30000, maxWatchRounds: 2 };
    const camp = (state, extra = {}) => ({ campId: "lc", state, systemId: 2, operationId: "op1", untilAt: 500000,
      watchRound: 0, stepSeq: 0, ...extra });
    const fl = (state, extra = {}) => ({ state, currentSystemId: 2, operationId: "op1", nextActionAt: null, ...extra });
    const at = 100000;
    const run = (c, f, t = at) => decideCampStep(c, f, { at: t }, P);
    assert.deepStrictEqual([
      run(camp("PLANNED"), fl("STAGED")),
      run(camp("PLANNED"), fl("ENGAGED")),
      run(camp("PLANNED"), fl("TRAVELLING", { currentSystemId: 1, nextActionAt: 150000 })),
      run(camp("PLANNED", { watchRound: 2 }), fl("TRAVELLING", { currentSystemId: 1 })),
      run(camp("PLANNED"), fl("STAGED"), 500000),
      run(camp("PLANNED"), null),
      run(camp("PLANNED"), fl("DESTROYED")),
      run(camp("PLANNED"), fl("STAGED", { operationId: "op2" })),
      run(camp("PLANNED"), fl("STAGED", { currentSystemId: 3 })),
      run(camp("ACTIVE"), fl("STAGED")),
      run(camp("ACTIVE"), fl("ENGAGED", { operationId: null })),
      run(camp("ACTIVE"), fl("STAGED"), 470000),
      run(camp("ACTIVE"), fl("STAGED"), 500000),
      run(camp("ACTIVE"), fl("DESTROYED")),
      run(camp("ACTIVE"), fl("TRAVELLING", { currentSystemId: 3 })),
      run(camp("ACTIVE"), fl("IDLE", { operationId: null })),
      run(camp("ENDED"), fl("STAGED")),
    ], [
      { action: "ACTIVATE", nextAt: 160000 },
      { action: "ACTIVATE", nextAt: 160000 },
      { action: "WAIT", nextAt: 150000 },
      { action: "CANCEL", reason: "TIMEOUT" },
      { action: "CANCEL", reason: "TIMEOUT" },
      { action: "CANCEL", reason: "FLEET_LOST" },
      { action: "CANCEL", reason: "FLEET_LOST" },
      { action: "CANCEL", reason: "DIVERTED" },
      { action: "CANCEL", reason: "DIVERTED" },
      { action: "KEEP", nextAt: 160000 },
      { action: "KEEP", nextAt: 160000 },
      { action: "KEEP", nextAt: 500000 },
      { action: "EXPIRE", reason: "EXPIRED" },
      { action: "BREAK", reason: "DESTROYED" },
      { action: "BREAK", reason: "LEFT" },
      { action: "BREAK", reason: "LEFT" },
      { action: "STALE" },
    ]);
  });

  test("LSF3 crossingStartsOf: future inner crossings only, wormhole leg and a fleet not "
    + "TRAVELLING skipped, list lengths = routeWeightOf", () => {
    const leg = (systems, departAt, extra = {}) => {
      const r = buildLeg({ systems, departAt, jumpMs: 100, graphVersion: 1, mode: "travel", observed: false, ...extra });
      assert.ok(r.ok, JSON.stringify(r));
      return r.leg;
    };
    const wh = leg([1, 2, 3, 4], 1000, { constraints: {}, wormholeEdges: [{ i: 0, pairKey: "2:3", expiresAt: 999999 }] });
    assert.ok(validateLegShape(wh).ok, "the wormhole leg itself is valid");
    const fleets = new Map([
      ["fa", { state: "TRAVELLING", route: leg([1, 2, 3, 4], 1000) }],
      ["fb", { state: "TRAVELLING", route: leg([1, 2, 3, 4], 1050) }],
      ["fw", { state: "TRAVELLING", route: wh }],
      ["fs", { state: "STAGED", route: leg([1, 2, 3, 4], 1000) }],
    ]);
    const convoys = ["fa", "fb", "fw", "fs", "missing"].map((f) => ({ convoyId: `c_${f}`, fleetId: f }));
    const starts = crossingStartsOf(convoys, fleets, 1200);
    const weight = routeWeightOf(convoys, fleets, 1200);
    assert.deepStrictEqual({ starts: [...starts].sort((x, y) => x[0] - y[0]),
      lengths: [...starts].map(([id, l]) => [id, l.length]).sort((x, y) => x[0] - y[0]),
      weight: [...weight].sort((x, y) => x[0] - y[0]), before: [...crossingStartsOf(convoys, fleets, 0)]
        .sort((x, y) => x[0] - y[0]), after: crossingStartsOf(convoys, fleets, 1350).size,
      bad: crossingStartsOf(null, null, 0).size }, {
      starts: [[2, [1150]], [3, [1200, 1250]]],
      lengths: [[2, 1], [3, 2]],
      weight: [[2, 1], [3, 2]],
      before: [[2, [1100, 1150]], [3, [1200, 1250]]],
      after: 0,
      bad: 0,
    });
  });
};
