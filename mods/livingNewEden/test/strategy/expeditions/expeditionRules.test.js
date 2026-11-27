"use strict";

const assert = require("node:assert");

const { planExpeditions, decideExpeditionStep } = require("../../../lib/strategy/expeditions/expeditionRules");

const SANSHA = 500019;
const GURISTAS = 500010;
const SYS = Object.freeze({ K0: 1, K1: 2, K2: 3, J1: 31000001, J2: 31000002, J3: 31000003 });
const SEC = new Map([[SYS.K0, "nullsec"], [SYS.K1, "lowsec"], [SYS.K2, "nullsec"], [SYS.J1, "wormhole"],
  [SYS.J2, "wormhole"], [SYS.J3, "wormhole"]]);
const GATES = new Map([[SYS.K0, [SYS.K1]], [SYS.K1, [SYS.K0, SYS.K2]], [SYS.K2, [SYS.K1]], [SYS.J1, []],
  [SYS.J2, []], [SYS.J3, []]]);
const AT = 1760000000000;
const JUMP_MS = 60000;
const PARAMS = Object.freeze({ maxActiveExpeditions: 3, maxActiveExpeditionsPerFaction: 1, maxExpeditionsPerPlan: 2,
  entryMaxJumps: 5, maxBfsSystems: 100, candidateTopN: 1, expeditionMinMs: 3600000, expeditionMaxMs: 14400000,
  returnMarginMs: 1800000 });
const edge = (pairKey, from, to, expiresAt = 0) => ({ pairKey, fromSystemId: from, toSystemId: to, expiresAt,
  createdAt: 0 });
const EDGES = Object.freeze([edge("1@1", SYS.J1, SYS.K1), edge("2@1", SYS.K0, SYS.J2), edge("3@1", SYS.J1, SYS.J3),
  edge("4@1", SYS.K0, SYS.K2)]);

function fleet(id, o = {}) {
  return { fleetId: id, version: 1, systemId: SYS.K0, state: "IDLE", fleetRole: "patrol", refitPending: false,
    operationId: null, composition: [{ hullGroup: "cruiser", count: 4 }], jumpMs: JUMP_MS, ...o };
}

function input(o = {}) {
  return { at: AT, round: 7, worldSeed: 42, openTotal: 0, occupiedSystems: new Set(), edges: EDGES,
    factions: [{ factionId: SANSHA, openCount: 0, fleets: [fleet("fleet_a")] }],
    getSystem: (id) => (SEC.has(id) ? { secClass: SEC.get(id), regionId: 1 } : null),
    neighbors: (id) => GATES.get(id) || [], ...o };
}

const targets = (r) => r.plans.map((p) => [p.factionId, p.fleetId, p.systemId, p.entryPairKey, p.jumps]);

module.exports = ({ test }) => {
  test("ER1 planExpeditions: candidates, exclusions, lifetime, limits, determinism", () => {
    const got = {};
    const a = planExpeditions(input(), PARAMS);
    got.a = [targets(a), a.plans[0].etaMs, a.skips];
    got.aTop3 = planExpeditions(input(), { ...PARAMS, candidateTopN: 3 }).plans.map((p) => p.systemId)
      .filter((s) => ![SYS.J1, SYS.J2].includes(s));
    got.a0 = targets(planExpeditions(input({ edges: [EDGES[0], EDGES[2], EDGES[3]] }), { ...PARAMS,
      entryMaxJumps: 0 }));
    got.a0k1 = targets(planExpeditions(input({ factions: [{ factionId: SANSHA, openCount: 0,
      fleets: [fleet("fleet_a", { systemId: SYS.K1 })] }] }), { ...PARAMS, entryMaxJumps: 0 }));
    got.b = targets(planExpeditions(input({ occupiedSystems: new Set([SYS.J2]) }), PARAMS));
    const bad = [fleet("f1", { composition: [{ hullGroup: "capital", count: 1 }] }), fleet("f2", { systemId: SYS.J1 }),
      fleet("f3", { refitPending: true }), fleet("f4", { operationId: "op_x" }), fleet("f5", { fleetRole: "invasion" }),
      fleet("f6", { state: "STAGED" })];
    got.bNoFleet = planExpeditions(input({ factions: [{ factionId: SANSHA, openCount: 0, fleets: bad }] }), PARAMS)
      .skips;
    got.bBoth = planExpeditions(input({ occupiedSystems: [SYS.J1, SYS.J2] }), PARAMS).skips;
    const eta = JUMP_MS;
    const short = AT + eta + PARAMS.returnMarginMs + PARAMS.expeditionMinMs - 1;
    got.cShort = planExpeditions(input({ edges: [edge("2@1", SYS.K0, SYS.J2, short)] }), PARAMS).skips;
    const fits = short + 1 + 1000;
    const c = planExpeditions(input({ edges: [edge("2@1", SYS.K0, SYS.J2, fits)] }),
      { ...PARAMS, expeditionMinMs: 3600000, expeditionMaxMs: 3600000 * 4 }).plans[0];
    got.cCut = [c.evacuateAt, c.evacuateAt - (AT + c.etaMs) >= PARAMS.expeditionMinMs];
    const c0 = planExpeditions(input(), { ...PARAMS, expeditionMaxMs: PARAMS.expeditionMinMs }).plans[0];
    got.c0 = c0.evacuateAt - (AT + c0.etaMs);
    const two = [{ factionId: GURISTAS, openCount: 0, fleets: [fleet("fleet_g")] },
      { factionId: SANSHA, openCount: 0, fleets: [fleet("fleet_s")] }];
    got.dGlobal = planExpeditions(input({ factions: two, openTotal: 3 }), PARAMS).skips;
    got.dFaction = planExpeditions(input({ factions: [{ factionId: SANSHA, openCount: 1,
      fleets: [fleet("fleet_s")] }] }), PARAMS).skips;
    const perPlan = planExpeditions(input({ factions: two }), { ...PARAMS, maxExpeditionsPerPlan: 1 });
    got.dPerPlan = [targets(perPlan), perPlan.skips];
    const both = planExpeditions(input({ factions: two }), PARAMS);
    got.dBoth = [both.plans.map((p) => p.systemId).sort(), new Set(both.plans.map((p) => p.systemId)).size];
    got.dGlobal2 = planExpeditions(input({ factions: two, openTotal: 2 }), PARAMS).skips;
    const wide = { ...PARAMS, candidateTopN: 3 };
    const e1 = planExpeditions(input(), wide);
    const e2 = planExpeditions(input(), wide);
    const e3 = planExpeditions(input({ round: 8 }), wide);
    got.e = [JSON.stringify(e1) === JSON.stringify(e2), e1.plans[0].seed !== e3.plans[0].seed];

    assert.deepStrictEqual(got, {
      a: [[[SANSHA, "fleet_a", SYS.J2, "2@1", 1]], JUMP_MS, {}],
      aTop3: [],
      a0: [],
      a0k1: [[SANSHA, "fleet_a", SYS.J1, "1@1", 1]],
      b: [[SANSHA, "fleet_a", SYS.J1, "1@1", 2]],
      bNoFleet: { NO_FLEET: 1 },
      bBoth: { NO_TARGET: 1 },
      cShort: { EXPIRES_TOO_SOON: 1 },
      cCut: [fits - PARAMS.returnMarginMs, true],
      c0: PARAMS.expeditionMinMs,
      dGlobal: { LIMIT: 2 },
      dFaction: { FACTION_LIMIT: 1 },
      dPerPlan: [[[GURISTAS, "fleet_g", SYS.J2, "2@1", 1]], { LIMIT: 1 }],
      dBoth: [[SYS.J1, SYS.J2], 2],
      dGlobal2: { LIMIT: 1 },
      e: [true, true],
    });
  });

  test("ER2 /c decideExpeditionStep: the b and c rows of the machine table (one case per row) + STALE",
    () => {
    const P = { stepIntervalMs: 600000, stepRecheckMs: 120000, maxWatchRounds: 3, presenceGainPermille: 100,
      cutOffRecheckMs: 900000, cutOffDecisionMs: 86400000 };
    const at = AT + 1000000;
    const J = SYS.J1;
    const exp = (o = {}) => ({ expeditionId: "wx_1", state: "PLANNED", operationId: "op_e", systemId: J,
      originSystemId: SYS.K0, evacuateAt: AT + 4000000, presencePermille: 0, stepSeq: 2, watchRound: 0,
      decisionAt: null, ...o });
    const fl = (o = {}) => ({ fleetId: "f", state: "STAGED", currentSystemId: J, operationId: "op_e",
      nextActionAt: at + 500000, ...o });
    const cutExp = (o) => exp({ state: "CUT_OFF", holdOperationId: "op_h", ...o });
    const held = (o = {}) => fl({ state: "PLANNED", operationId: "op_h", ...o });
    const isJSpace = (id) => id >= SYS.J1;
    const route = { targetSystemId: SYS.K0 };
    const run = (e, f, facts = {}) => decideExpeditionStep(e, f, { at, isJSpace, routeOut: null, ...facts }, P);
    const keep = Math.min(at + P.stepIntervalMs, AT + 4000000);
    const cut = Math.min(at + P.cutOffRecheckMs, at + P.cutOffDecisionMs);
    const rows = [
      ["STALE seq", run(exp(), fl(), { stepSeq: 1, round: 0 }), { action: "STALE" }],
      ["STALE round", run(exp(), fl(), { stepSeq: 2, round: 1 }), { action: "STALE" }],
      ["STALE ended", run(exp({ state: "ENDED" }), fl()), { action: "STALE" }],
      ["P gone", run(exp(), null), { action: "END", outcome: "LOST", reason: "FLEET_LOST" }],
      ["P destroyed", run(exp(), fl({ state: "DESTROYED" })), { action: "END", outcome: "LOST", reason: "FLEET_LOST" }],
      ["P flying", run(exp(), fl({ state: "TRAVELLING" })), { action: "WAIT", nextAt: at + 500000 }],
      ["P pending ours", run(exp(), fl({ state: "PLANNED" })), { action: "WAIT", nextAt: at + P.stepRecheckMs }],
      ["P pending timeout", run(exp({ watchRound: 3 }), fl({ state: "PLANNED" })),
        { action: "END", outcome: "CANCELLED", reason: "TIMEOUT" }],
      ["P pending foreign", run(exp(), fl({ state: "PLANNED", operationId: "op_x" })),
        { action: "END", outcome: "CANCELLED", reason: "DIVERTED" }],
      ["P activate", run(exp(), fl()), { action: "ACTIVATE", nextAt: keep, presence: 100 }],
      ["P activate engaged", run(exp(), fl({ state: "ENGAGED" })), { action: "ACTIVATE", nextAt: keep,
        presence: 100 }],
      ["P inJ parked route", run(exp(), fl({ currentSystemId: SYS.J2 }), { routeOut: route }),
        { action: "EVACUATE", reason: "HALTED" }],
      ["P inJ parked no route", run(exp(), fl({ currentSystemId: SYS.J2, state: "IDLE" })),
        { action: "CUT_OFF", reason: "HALTED", nextAt: cut, hold: true }],
      ["P inJ busy", run(exp(), fl({ currentSystemId: SYS.J2, state: "REFITTING" })),
        { action: "WAIT", nextAt: at + P.stepRecheckMs }],
      ["P k-space staged ours", run(exp(), fl({ currentSystemId: SYS.K0 })),
        { action: "END", outcome: "CANCELLED", reason: "CUT_BEFORE_ENTRY" }],
      ["P k-space idle", run(exp(), fl({ currentSystemId: SYS.K0, state: "IDLE", operationId: null })),
        { action: "END", outcome: "CANCELLED", reason: "DIVERTED" }],
      ["A gone", run(exp({ state: "ACTIVE" }), null), { action: "END", outcome: "LOST", reason: "FLEET_LOST" }],
      ["A flying", run(exp({ state: "ACTIVE" }), fl({ state: "RETREATING" })), { action: "WAIT", nextAt: at + 500000 }],
      ["A left", run(exp({ state: "ACTIVE" }), fl({ currentSystemId: SYS.K0 })),
        { action: "END", outcome: "RETURNED", reason: "LEFT" }],
      ["A busy", run(exp({ state: "ACTIVE" }), fl({ state: "ENGAGED" }), { routeOut: route }),
        { action: "WAIT", nextAt: at + P.stepRecheckMs }],
      ["A pending", run(exp({ state: "ACTIVE" }), fl({ state: "PLANNED" }), { routeOut: route }),
        { action: "WAIT", nextAt: at + P.stepRecheckMs }],
      ["A link lost", run(exp({ state: "ACTIVE", presencePermille: 300 }), fl()),
        { action: "CUT_OFF", reason: "LINK_LOST", nextAt: cut, hold: true }],
      ["A link lost not parked", run(exp({ state: "ACTIVE" }), fl({ state: "MATERIALIZED" })),
        { action: "CUT_OFF", reason: "LINK_LOST", nextAt: cut, hold: false }],
      ["A due", run(exp({ state: "ACTIVE", evacuateAt: at }), fl(), { routeOut: route }),
        { action: "EVACUATE", reason: "DUE" }],
      ["A idle", run(exp({ state: "ACTIVE" }), fl({ state: "IDLE", operationId: null }), { routeOut: route }),
        { action: "EVACUATE", reason: "DISRUPTED" }],
      ["A elsewhere", run(exp({ state: "ACTIVE" }), fl({ currentSystemId: SYS.J2 }), { routeOut: route }),
        { action: "EVACUATE", reason: "DISRUPTED" }],
      ["A foreign op", run(exp({ state: "ACTIVE" }), fl({ operationId: "op_x" }), { routeOut: route }),
        { action: "EVACUATE", reason: "DISRUPTED" }],
      ["A keep", run(exp({ state: "ACTIVE", presencePermille: 950 }), fl(), { routeOut: route }),
        { action: "KEEP", nextAt: keep, presence: 1000 }],
      ["E gone", run(exp({ state: "EVACUATING" }), null), { action: "END", outcome: "LOST", reason: "FLEET_LOST" }],
      ["E flying", run(exp({ state: "EVACUATING" }), fl({ state: "TRAVELLING", nextActionAt: at + 1 })),
        { action: "WAIT", nextAt: at + P.stepRecheckMs }],
      ["E returned", run(exp({ state: "EVACUATING" }), fl({ currentSystemId: SYS.K0 })),
        { action: "END", outcome: "RETURNED", reason: "RETURNED" }],
      ["E halted route", run(exp({ state: "EVACUATING" }), fl(), { routeOut: route }),
        { action: "EVACUATE", reason: "HALTED" }],
      ["E halted no route", run(exp({ state: "EVACUATING" }), fl()),
        { action: "CUT_OFF", reason: "HALTED", nextAt: cut, hold: true }],
      ["E busy", run(exp({ state: "EVACUATING" }), fl({ state: "PLANNED" })),
        { action: "WAIT", nextAt: at + P.stepRecheckMs }],
      ["C gone", run(exp({ state: "CUT_OFF", decisionAt: at + 5 }), null),
        { action: "END", outcome: "LOST", reason: "FLEET_LOST" }],
      ["C flying", run(exp({ state: "CUT_OFF", decisionAt: at + 5 }), fl({ state: "TRAVELLING" })),
        { action: "WAIT", nextAt: at + 500000 }],
      ["C returned", run(exp({ state: "CUT_OFF", decisionAt: at + 5 }), fl({ currentSystemId: SYS.K0 })),
        { action: "END", outcome: "RETURNED", reason: "RETURNED" }],
      ["C recovered", run(exp({ state: "CUT_OFF", decisionAt: at + 5 }), fl({ state: "IDLE" }), { routeOut: route }),
        { action: "EVACUATE", reason: "RECOVERED", unhold: false }],
      ["C held recovered", run(cutExp({ decisionAt: at }), held(), { routeOut: route }),
        { action: "EVACUATE", reason: "RECOVERED", unhold: true }],
      ["C write-off held", run(cutExp({ decisionAt: at }), held()),
        { action: "WRITE_OFF", outcome: "LOST", reason: "WRITTEN_OFF", unhold: true }],
      ["C write-off idle", run(cutExp({ decisionAt: at - 1 }), fl({ state: "IDLE", operationId: null })),
        { action: "WRITE_OFF", outcome: "LOST", reason: "WRITTEN_OFF", unhold: false }],
      ["C hold before decision", run(cutExp({ decisionAt: at + 5000 }), fl({ state: "IDLE", operationId: null })),
        { action: "HOLD", nextAt: at + 5000 }],
      ["C hold far decision", run(cutExp({ decisionAt: at + 99999999 }), fl()),
        { action: "HOLD", nextAt: at + P.cutOffRecheckMs }],
      ["C hold staged past decision", run(cutExp({ decisionAt: at }), fl()), { action: "HOLD", nextAt: at }],
      ["C held wait before decision", run(cutExp({ decisionAt: at + 5000 }), held()),
        { action: "WAIT", nextAt: at + 5000 }],
      ["C held wait far decision", run(cutExp({ decisionAt: at + 99999999 }), held()),
        { action: "WAIT", nextAt: at + P.cutOffRecheckMs }],
      ["C busy past decision", run(cutExp({ decisionAt: at }), fl({ state: "ENGAGED" })),
        { action: "WAIT", nextAt: at + P.cutOffRecheckMs }],
      ["C pending foreign past decision", run(cutExp({ decisionAt: at }), held({ operationId: "op_x" })),
        { action: "WAIT", nextAt: at + P.cutOffRecheckMs }],
      ["E halted no route kept decision", run(exp({ state: "EVACUATING", decisionAt: at + 5000 }), fl()),
        { action: "CUT_OFF", reason: "HALTED", nextAt: at + 5000, hold: true }],
      ["A link lost decision passed", run(exp({ state: "ACTIVE", decisionAt: at - 10 }), fl()),
        { action: "CUT_OFF", reason: "LINK_LOST", nextAt: at, hold: true }],
    ];
    const bad = rows.filter(([, got, want]) => JSON.stringify(got) !== JSON.stringify(want))
      .map(([name, got, want]) => `${name}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
    assert.deepStrictEqual(bad, []);
  });
};
