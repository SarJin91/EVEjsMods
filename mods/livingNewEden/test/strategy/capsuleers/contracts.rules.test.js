"use strict";

const assert = require("node:assert");

const { planHires, feeOf, closeOutcomeOf, canTransitionContract } =
  require("../../../lib/strategy/capsuleers/contractRules");
const { decideStep } = require("../../../lib/strategy/capsuleers/tripMachine");
const { planContact } = require("../../../lib/battle/contacts");
const { createHostility } = require("../../../lib/battle/data/hostility");
const { MERC_TEMPLATES, FLEET_TEMPLATES } = require("../../../lib/strategy/data/capsuleers");

const CAPS = 500018;
const AMARR = 500003;
const CALDARI = 500001;
const SANSHA = 500019;
const ANGEL = 500011;
const GURISTAS = 500010;
const isHostile = createHostility();
const CRUISERS = Object.freeze([{ hullGroup: "cruiser", typeId: null, count: 3 }]);
const FEE = 120000000;
const RICH = 1e12;

const PARAMS = Object.freeze({ maxContractsPerCorp: 1, maxContractsPerEmpire: 2, maxContractsPerReview: 4,
  mercMaxContractsPerSystem: 1, mercTargetSecClasses: ["lowsec"], mercTargetsTop: 1, mercMinTreasuryMultiple: 10,
  mercFeeFactorPermille: 1000, mercGuardMs: 14400000 });

function snapOf(over = {}) {
  const vertices = new Map([[1001, { secClass: "lowsec", factionId: AMARR }], [1002, { secClass: "highsec",
    factionId: AMARR }], [1003, { secClass: "lowsec", factionId: CALDARI }]]);
  const kinds = new Map([[AMARR, "empire"], [CALDARI, "empire"], [SANSHA, "pirate"], [ANGEL, "pirate"],
    [GURISTAS, "pirate"]]);
  const base = {
    round: 7,
    corps: [{ corpSlot: 1, state: "ACTIVE", seed: 11 }],
    freeMercs: [{ slot: 1, fleetId: "fleet-a", expectedVersion: 3, composition: CRUISERS }],
    targetsBySlot: new Map([[1, [{ systemId: 1001, jumps: 1 }]]]),
    enemiesBySystem: new Map([[1001, [{ factionId: SANSHA, ships: 4 }]], [1002, [{ factionId: SANSHA, ships: 4 }]],
      [1003, [{ factionId: SANSHA, ships: 2 }]]]),
    vertexOf: (id) => vertices.get(id) || null,
    factionOf: (id) => (kinds.has(id) ? { kind: kinds.get(id) } : null),
    isActive: (id) => kinds.has(id),
    isHostile,
    controllerOf: new Map(),
    accountOf: new Map([[AMARR, { ok: true, mode: "ready", seeded: true, balanceIsk: RICH, accountMode: "NORMAL" }],
      [CALDARI, { ok: true, mode: "ready", seeded: true, balanceIsk: RICH, accountMode: "NORMAL" }]]),
    open: { byCorp: new Map(), byEmployer: new Map(), bySystem: new Map() },
  };
  return { ...base, ...over };
}

const brief = (r) => ({ hires: r.hires.map((h) => [h.fleetId, h.targetSystemId, h.employerFactionId,
  h.enemyFactionId, h.kind, h.feeIsk]), refused: r.refused });
const none = { noTreasury: 0, treasuryLow: 0, austerity: 0 };

module.exports = ({ test }) => {
  test("C1 planHires: employer = SDE faction, hostility filters, DEFENSE / RAID, secClass, limits "
    + "accounts with refusal counters, local balance, seeded determinism, feeOf 120 mln", () => {
    const got = {};
    const run = (name, over, params = PARAMS) => {
      got[name] = brief(planHires(snapOf(over), params));
    };
    run("base", {});
    run("inactiveEmpire", { isActive: (id) => id !== AMARR });
    run("empireFriendly", { isHostile: (a, b) => !(a === AMARR && b === SANSHA) && isHostile(a, b) });
    run("pirateFriendlyToCaps", { isHostile: (a, b) => !(a === CAPS && b === SANSHA) && isHostile(a, b) });
    run("ctrlEmpire", { controllerOf: new Map([[1001, AMARR]]) });
    run("ctrlPirate", { controllerOf: new Map([[1001, GURISTAS]]) });
    run("ctrlOtherEmpire", { controllerOf: new Map([[1001, CALDARI]]) });
    run("highsec", { targetsBySlot: new Map([[1, [{ systemId: 1002, jumps: 1 }]]]) });
    run("bySystem", { open: { byCorp: new Map(), byEmployer: new Map(), bySystem: new Map([[1001, 1]]) } });
    run("byEmployer", { open: { byCorp: new Map(), byEmployer: new Map([[AMARR, 2]]), bySystem: new Map() } });
    run("byCorp", { open: { byCorp: new Map([[1, 1]]), byEmployer: new Map(), bySystem: new Map() } });
    run("review0", {}, { ...PARAMS, maxContractsPerReview: 0 });
    run("off", { accountOf: new Map([[AMARR, { ok: true, mode: "off" }]]) });
    run("notSeeded", { accountOf: new Map([[AMARR, { ok: true, mode: "ready", seeded: false, balanceIsk: 0,
      accountMode: "NORMAL" }]]) });
    run("austerity", { accountOf: new Map([[AMARR, { ok: true, mode: "ready", seeded: true, balanceIsk: RICH,
      accountMode: "AUSTERITY" }]]) });
    run("low", { accountOf: new Map([[AMARR, { ok: true, mode: "ready", seeded: true, balanceIsk: 10 * FEE - 1,
      accountMode: "NORMAL" }]]) });
    const two = { corps: [{ corpSlot: 1, state: "ACTIVE", seed: 11 }, { corpSlot: 2, state: "ACTIVE", seed: 12 }],
      freeMercs: [{ slot: 1, fleetId: "fleet-a", expectedVersion: 3, composition: CRUISERS },
        { slot: 2, fleetId: "fleet-b", expectedVersion: 1, composition: CRUISERS }],
      targetsBySlot: new Map([[1, [{ systemId: 1001, jumps: 1 }]], [2, [{ systemId: 1004, jumps: 2 }]]]),
      enemiesBySystem: new Map([[1001, [{ factionId: SANSHA, ships: 4 }]], [1004, [{ factionId: SANSHA, ships: 1 },
        { factionId: GURISTAS, ships: 1 }]]]),
      vertexOf: (id) => (id === 1001 || id === 1004 ? { secClass: "lowsec", factionId: AMARR } : null) };
    run("localBalance", { ...two, accountOf: new Map([[AMARR, { ok: true, mode: "ready", seeded: true,
      balanceIsk: 10 * FEE + FEE - 1, accountMode: "NORMAL" }]]) });
    run("twoRich", two);
    run("review1", two, { ...PARAMS, maxContractsPerReview: 1 });

    const hireA = ["fleet-a", 1001, AMARR, SANSHA];
    assert.deepStrictEqual(got, {
      base: { hires: [[...hireA, "DEFENSE", FEE]], refused: none },
      inactiveEmpire: { hires: [], refused: none },
      empireFriendly: { hires: [], refused: none },
      pirateFriendlyToCaps: { hires: [], refused: none },
      ctrlEmpire: { hires: [[...hireA, "DEFENSE", FEE]], refused: none },
      ctrlPirate: { hires: [[...hireA, "RAID", FEE]], refused: none },
      ctrlOtherEmpire: { hires: [], refused: none },
      highsec: { hires: [], refused: none },
      bySystem: { hires: [], refused: none },
      byEmployer: { hires: [], refused: none },
      byCorp: { hires: [], refused: none },
      review0: { hires: [], refused: none },
      off: { hires: [], refused: { ...none, noTreasury: 1 } },
      notSeeded: { hires: [], refused: { ...none, noTreasury: 1 } },
      austerity: { hires: [], refused: { ...none, austerity: 1 } },
      low: { hires: [], refused: { ...none, treasuryLow: 1 } },
      localBalance: { hires: [[...hireA, "DEFENSE", FEE]], refused: { ...none, treasuryLow: 1 } },
      twoRich: { hires: [[...hireA, "DEFENSE", FEE], ["fleet-b", 1004, AMARR, GURISTAS, "DEFENSE", FEE]],
        refused: none },
      review1: { hires: [[...hireA, "DEFENSE", FEE]], refused: none },
    });

    const wide = { targetsBySlot: new Map([[1, [{ systemId: 1001, jumps: 1 }, { systemId: 1003, jumps: 2 }]]]) };
    const p4 = { ...PARAMS, mercTargetsTop: 4 };
    const a = planHires(snapOf(wide), p4);
    assert.deepStrictEqual(planHires(snapOf(wide), p4), a);
    assert.deepStrictEqual([a.hires.length, a.hires[0].guardMs, a.hires[0].expectedVersion], [1, 14400000, 3]);
    assert.ok([1001, 1003].includes(a.hires[0].targetSystemId));

    assert.deepStrictEqual([feeOf(CRUISERS, PARAMS), feeOf([{ hullGroup: "logistics", count: 2 }], PARAMS),
      feeOf(CRUISERS, { mercFeeFactorPermille: 1 }), feeOf([], PARAMS)], [FEE, 80000000, 120000, 1]);
    assert.deepStrictEqual([closeOutcomeOf({ state: "ON_STATION" }), closeOutcomeOf({ state: "DISPATCHED" }),
      closeOutcomeOf({ state: "COMPLETED" }), closeOutcomeOf(null)], [{ to: "COMPLETED" }, { to: "CANCELLED" }, null,
      null]);
    assert.deepStrictEqual([canTransitionContract("DISPATCHED", "COMPLETED").reason,
      canTransitionContract("ON_STATION", "CANCELLED").reason, canTransitionContract("DISPATCHED", "ON_STATION").ok],
    ["ILLEGAL_TRANSITION", "ILLEGAL_TRANSITION", true]);
    const ids = new Set(FLEET_TEMPLATES.map((t) => t.templateId));
    assert.deepStrictEqual(MERC_TEMPLATES.filter((t) => ids.has(t.templateId)), []);
  });

  test("C4 rules: a mercenary fleet of 500018 fights a pirate (contact), a ratter alone does not "
    + "decideStep of a merc trip (ENGAGED in the target -> START_RATTING also from a nudge, GUARD without targetCheck)",
  () => {
    const fl = (fleetId, factionId, fleetRole) => ({ fleetId, factionId, fleetRole, shipCount: 2, version: 1,
      operationId: null, composition: [{ hullGroup: "cruiser", typeId: null, count: 2 }] });
    const limits = { maxFleetsPerSide: 8, maxSettlementRows: 450 };
    const merc = planContact({ fleets: [fl("m1", CAPS, "mercenary"), fl("p1", SANSHA, "patrol")],
      triggerFleetId: "m1", isHostile, cooldowns: new Map(), at: 0, limits });
    const rat = planContact({ fleets: [fl("c1", CAPS, "capsuleer"), fl("p1", SANSHA, "patrol")],
      triggerFleetId: "p1", isHostile, cooldowns: new Map(), at: 0, limits });
    assert.deepStrictEqual([merc.contact && merc.contact.sideA.factionId, merc.contact && merc.contact.sideB.factionId,
      rat.contact, rat.reason], [CAPS, SANSHA, null, "NO_HOSTILES"]);

    const trip = (state) => ({ kind: "merc", state, baseSystemId: 1, targetSystemId: 9, outboundOperationId: "op-out",
      watchRound: 0, waitRound: 0, abortReason: null });
    const fleet = (state, systemId = 9) => ({ state, operationId: "op-out", currentSystemId: systemId });
    const facts = (trigger, hostiles = false) => ({ at: 0, trigger, hostiles, controlled: null });
    const params = { maxWatchRounds: 3 };
    const rows = [
      ["OUTBOUND", "ENGAGED", 9, "due", false],
      ["OUTBOUND", "ENGAGED", 9, "arrival", false],
      ["OUTBOUND", "STAGED", 9, "arrival", true],
      ["OUTBOUND", "ENGAGED", 5, "due", false],
      ["OUTBOUND", "TRAVELLING", 5, "due", false],
      ["RATTING", "ENGAGED", 9, "due", false],
      ["RATTING", "ENGAGED", 9, "arrival", false],
      ["RATTING", "STAGED", 9, "due", true],
      ["RATTING", "STAGED", 9, "arrival", false],
      ["RATTING", "REFITTING", 1, "arrival", false],
    ].map(([ts, fs, sys, trigger, hostiles]) => {
      const d = decideStep(trip(ts), fleet(fs, sys), facts(trigger, hostiles), params);
      return `${ts}/${fs}@${sys}/${trigger}${hostiles ? "+h" : ""} -> ${d.action}${d.reason ? ` ${d.reason}` : ""}`;
    });
    assert.deepStrictEqual(rows, [
      "OUTBOUND/ENGAGED@9/due -> START_RATTING",
      "OUTBOUND/ENGAGED@9/arrival -> START_RATTING",
      "OUTBOUND/STAGED@9/arrival+h -> START_RATTING",
      "OUTBOUND/ENGAGED@5/due -> WAIT ENGAGED",
      "OUTBOUND/TRAVELLING@5/due -> WAIT IN_FLIGHT",
      "RATTING/ENGAGED@9/due -> WAIT ENGAGED",
      "RATTING/ENGAGED@9/arrival -> IGNORE ENGAGED",
      "RATTING/STAGED@9/due+h -> GUARD",
      "RATTING/STAGED@9/arrival -> IGNORE ON_STATION",
      "RATTING/REFITTING@1/arrival -> RETURN DIVERTED",
    ]);
    assert.deepStrictEqual([decideStep({ ...trip("OUTBOUND"), kind: "rat" }, fleet("ENGAGED"), facts("due"), params)
      .action, decideStep({ ...trip("RATTING"), kind: "rat" }, fleet("STAGED"), facts("due", true), params).reason],
    ["WAIT", "HOSTILES"]);
  });
};
