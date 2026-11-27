"use strict";

const assert = require("node:assert");

const { planIntercepts } = require("../../../lib/strategy/ai/intercepts");
const { createOperationKinds } = require("../../../lib/strategy/kinds");
const { OPERATION_KINDS_VERSION, OPERATION_KINDS_V1 } = require("../../../lib/strategy/data/operationKinds");
const { FLEET_ROLES, OPERATION_TYPES, OBJECTIVES } = require("../../../lib/fleets/schema");

const AT = 1760000000000;
const J = 60000;
const OWN_J = 40000;
const LEAD = 10000;
const HOLD = 900000;
const S = (i) => 100 + i;
const TARGET = S(9);

const kinds = (() => {
  const k = createOperationKinds({ version: OPERATION_KINDS_VERSION, kinds: OPERATION_KINDS_V1 },
    { operationTypes: OPERATION_TYPES, objectives: OBJECTIVES, fleetRoles: FLEET_ROLES });
  assert.ok(k.ok, JSON.stringify(k));
  return k.kinds;
})();

const INTERCEPT = Object.freeze({ maxPerSweep: 1, maxJumps: 4, minLeadMs: LEAD, holdMs: HOLD, strengthRatio: 1.2,
  defensiveSharePermille: 1000, maxFleetIds: 6 });
const PARAMS = Object.freeze({ kinds: kinds.list, maxBfsSystems: 2000, intercept: INTERCEPT });

const neighbors = (id) => [id - 1, id + 1].filter((x) => x >= S(0) && x <= S(9));
const own = (except = []) => Array.from({ length: 10 }, (_, i) => i >= 1 && !except.includes(i));

const enemy = (fleetId, strength = 50, extra = {}) => ({ fleetId, legSeq: 2, strength,
  leg: { systems: Array.from({ length: 10 }, (_, i) => S(i)), departAt: AT - 1.5 * J, jumpMs: J }, own: own(),
  ...extra });
const ownFleet = (fleetId, systemId, extra = {}) => ({ fleetId, version: 4, state: "IDLE", fleetRole: "patrol",
  systemId, refitPending: false, strength: 100, operationId: null, jumpMs: OWN_J, ...extra });

function snap(o = {}) {
  return { factionId: 7, at: AT, doctrine: { operationTypes: ["invasion", "defense"] },
    fleets: o.fleets || [ownFleet("f5", S(5))], operations: o.operations || [], operationsTruncated: false,
    neighbors, incoming: [{ operationId: "op_e", factionId: 9, operationType: "invasion", targetSystemId: TARGET,
      fleets: o.enemies || [enemy("e1")] }] };
}

const plan = (s, params = PARAMS, room = 1) => planIntercepts(s, params, new Set(), room);
const summary = (r) => ({ notes: r.notes, intents: r.intents.map((i) => [i.kind, i.target.systemId,
  i.originSystemId, i.fleets.map((x) => x.fleetId), i.dueAt, i.intercept.fleetIds]) });
const fromOf = (i) => AT - 1.5 * J + i * J;

module.exports = ({ test }) => {
  test("XP1 planIntercepts: earliest X with lead, sighting, own space only, strength, cover, budget, dist 0 "
    + "maxFleetIds", () => {
    const got = {};
    const want = {};
    got.base = summary(plan(snap()));
    want.base = { notes: [`INTERCEPT:${S(3)}`], intents: [["intercept_post", S(3), S(5), ["f5"], fromOf(3) + HOLD,
      ["e1"]]] };
    const blind = own([1]);
    got.unseen = summary(plan(snap({ enemies: [enemy("e1", 50, { own: blind })] })));
    want.unseen = { notes: [], intents: [] };
    got.observer = summary(plan(snap({ enemies: [enemy("e1", 50, { own: blind })],
      fleets: [ownFleet("f5", S(5)), ownFleet("g1", S(1), { fleetRole: "garrison", state: "STAGED" })] })));
    want.observer = want.base;
    got.foreign = summary(plan(snap({ enemies: [enemy("e1", 50, { own: own([3]) })] })));
    want.foreign = { notes: [`INTERCEPT:${S(4)}`], intents: [["intercept_post", S(4), S(5), ["f5"],
      fromOf(4) + HOLD, ["e1"]]] };
    got.weak = summary(plan(snap({ enemies: [enemy("e1", 100)] })));
    want.weak = { notes: ["INTERCEPT_NO_FLEET:op_e"], intents: [] };
    const post = { operationId: "op_p", state: "ACTIVE", operationType: "blockade", targetSystemId: S(7) };
    got.covered = summary(plan(snap({ operations: [post] })));
    want.covered = { notes: [], intents: [] };
    got.noBudget = summary(plan(snap(), { ...PARAMS, intercept: { ...INTERCEPT, defensiveSharePermille: 0 } }));
    want.noBudget = { notes: [], intents: [] };
    const busyPost = { operationId: "op_b", state: "ACTIVE", operationType: "blockade", targetSystemId: S(0) };
    got.capped = summary(plan(snap({ operations: [busyPost], fleets: [ownFleet("f5", S(5)),
      ownFleet("b1", S(0), { state: "STAGED", operationId: "op_b" })] }),
    { ...PARAMS, intercept: { ...INTERCEPT, defensiveSharePermille: 500 } }));
    want.capped = { notes: ["INTERCEPT_CAPPED:op_e"], intents: [] };
    got.inPlace = summary(plan(snap({ fleets: [ownFleet("f3", S(3))] })));
    want.inPlace = { notes: [`INTERCEPT:${S(3)}`], intents: [["intercept_post", S(3), S(3), ["f3"],
      fromOf(3) + HOLD, ["e1"]]] };
    got.maxIds = summary(plan(snap({ enemies: [enemy("e3", 30), enemy("e2", 30), enemy("e1", 30)] }),
      { ...PARAMS, intercept: { ...INTERCEPT, maxFleetIds: 2 } }));
    want.maxIds = { notes: [`INTERCEPT:${S(3)}`], intents: [["intercept_post", S(3), S(5), ["f5"], fromOf(3) + HOLD,
      ["e1", "e2"]]] };
    got.gates = [summary(plan(snap(), { ...PARAMS, intercept: null })), summary(plan(snap(), PARAMS, 0))];
    want.gates = [{ notes: [], intents: [] }, { notes: [], intents: [] }];
    assert.deepStrictEqual(got, want);
  });
};
