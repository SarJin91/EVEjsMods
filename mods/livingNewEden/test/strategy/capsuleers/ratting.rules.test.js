"use strict";

const assert = require("node:assert");

const { planDispatches, planSweeps, hostilesPresent, stepKills, bountyOf } =
  require("../../../lib/strategy/capsuleers/rattingRules");
const { decideStep } = require("../../../lib/strategy/capsuleers/tripMachine");
const { createHostility } = require("../../../lib/battle/data/hostility");

const CAPS = 500018;
const SANSHA = 500019;
const CORP_ID = 98000001;
const BASE = 100;
const PARAMS = Object.freeze({ rattingEnabled: true, maxDispatchesPerReview: 8, maxHomeDispatchesPerReview: 8,
  rattingMaxFleetsPerSystem: 1, rattingTargetsTop: 4 });

const fleet = (fleetId, over = {}) => ({ fleetId, factionId: CAPS, corporationId: CORP_ID, fleetRole: "capsuleer",
  state: "IDLE", currentSystemId: BASE, refitPending: false, version: 3, ...over });

function snapOf(over = {}) {
  return { corps: [{ corpSlot: 1, state: "ACTIVE", corporationId: CORP_ID, baseSystemId: BASE, seed: 7 },
    { corpSlot: 2, state: "FOUNDING", corporationId: null, baseSystemId: 101, seed: 8 }],
  fleets: [fleet("f-a"), fleet("f-b", { currentSystemId: 200 }), fleet("f-c"), fleet("f-d", { state: "STAGED" }),
    fleet("f-e", { refitPending: true }), fleet("f-f", { fleetRole: "patrol" }),
    fleet("f-h", { corporationId: 98000009 })],
  fleetsTruncated: false, openTripFleetIds: new Set(["f-c"]), openByTarget: new Map([[300, 1]]),
  targetsBySlot: new Map([[1, [{ systemId: 300, jumps: 1 }, { systemId: 301, jumps: 2 }]]]), round: 12, ...over };
}

const trip = (state, over = {}) => ({ tripId: "ct_1", state, kind: "rat", baseSystemId: BASE, targetSystemId: 300,
  outboundOperationId: "op_out", returnOperationId: null, watchRound: 0, abortReason: null, ...over });
const facts = (over = {}) => ({ at: 1000, trigger: "due", hostiles: false, controlled: true, ...over });

module.exports = ({ test }) => {
  test("T1 ratting rules: planDispatches, hostilesPresent, stepKills, bountyOf, decideStep", () => {
    const got = {};
    got.plan = planDispatches(snapOf(), PARAMS);
    got.limit = planDispatches(snapOf(), { ...PARAMS, maxDispatchesPerReview: 1 }).map((d) => d.fleetId);
    got.spread = planDispatches(snapOf({ fleets: [fleet("f-a"), fleet("f-g")], openByTarget: new Map() }), PARAMS)
      .map((d) => d.targetSystemId).sort();
    got.truncated = planDispatches(snapOf({ fleetsTruncated: true }), PARAMS);
    got.ratOff = planDispatches(snapOf(), { ...PARAMS, rattingEnabled: false }).map((d) => [d.kind, d.fleetId]);
    got.sameSeed = JSON.stringify(planDispatches(snapOf(), PARAMS)) === JSON.stringify(got.plan);

    const isHostile = createHostility();
    const hp = (fleets, truncated = false) => hostilesPresent(fleets, { selfFactionId: CAPS, isHostile, truncated });
    got.hostiles = [hp([{ factionId: SANSHA, fleetRole: "capsuleer" }, { factionId: SANSHA, fleetRole: "hunter" },
      { factionId: CAPS, fleetRole: "patrol" }, { factionId: 500001, fleetRole: "patrol" }]),
    hp([{ factionId: SANSHA, fleetRole: "patrol" }]), hp([], true)];

    const s = { tripId: "ct_1", phaseSeq: 1, round: 1, systemId: 300, victimFactionId: SANSHA, atMs: 5000,
      characterIds: [11, 12, 13] };
    const kills = stepKills(s, { rattingKillsPerStep: 2 });
    got.kills = kills.map((k) => [k.characterId, k.victimFactionId, k.systemId, k.atMs]);
    got.killIds = [kills.every((k) => Number.isSafeInteger(k.victimId) && k.victimId > 0),
      JSON.stringify(stepKills(s, { rattingKillsPerStep: 2 })) === JSON.stringify(kills),
      kills[0].victimId !== kills[1].victimId];
    got.noMembers = stepKills({ ...s, characterIds: [] }, { rattingKillsPerStep: 2 });

    const bp = { rattingBountyIskPerKill: 10000000, maxIskBalance: 50000000000 };
    got.bounty = [bountyOf(2, 50000000000 - 1, bp), bountyOf(2, 50000000000, bp), bountyOf(2, 0, bp)];

    const P = { maxWatchRounds: 3 };
    const staged = { fleetId: "f-a", state: "STAGED", currentSystemId: 300, operationId: "op_out" };
    got.decide = [
      decideStep(trip("OUTBOUND"), staged, facts({ hostiles: true }), P),
      decideStep(trip("RATTING"), staged, facts({ controlled: false }), P),
      decideStep(trip("RETURNING", { returnOperationId: "op_ret" }), { fleetId: "f-a", state: "STAGED",
        currentSystemId: BASE, operationId: "op_ret" }, facts(), P),
      decideStep(trip("OUTBOUND"), { ...staged, state: "TRAVELLING", currentSystemId: 200 },
        facts({ trigger: "arrival" }), P),
      decideStep(trip("RATTING"), staged, facts({ trigger: "arrival" }), P),
      decideStep(trip("OUTBOUND"), staged, facts(), P),
      decideStep(trip("RATTING"), staged, facts(), P),
    ].map((d) => [d.action, d.reason || null]);

    assert.deepStrictEqual(got, {
      plan: [{ kind: "rat", slot: 1, fleetId: "f-a", expectedVersion: 3, targetSystemId: 301 },
        { kind: "home", slot: 1, fleetId: "f-b", expectedVersion: 3, targetSystemId: null }],
      limit: ["f-a", "f-b"],
      spread: [300, 301],
      truncated: [],
      ratOff: [["home", "f-b"]],
      sameSeed: true,
      hostiles: [false, true, true],
      kills: [[13, SANSHA, 300, 5000], [11, SANSHA, 300, 5000]],
      killIds: [true, true, true],
      noMembers: [],
      bounty: [1, 0, 20000000],
      decide: [["RETURN", "HOSTILES"], ["RETURN", "CONTROL_LOST"], ["DOCK", null], ["IGNORE", "IN_FLIGHT"],
        ["IGNORE", "RATTING"], ["START_RATTING", null], ["RAT", null]],
    });
  });

  test("H1 rules: rat / home limits apart, home rotates (refused routes block nothing), RATTING hostiles -> "
    + "RETURN HOSTILES, the wait limit counts waitRound, planSweeps", () => {
    const got = {};
    const snap = (round) => snapOf({ round, openTripFleetIds: new Set(), openByTarget: new Map(),
      fleets: [fleet("r-1"), fleet("h-1", { currentSystemId: 200 }), fleet("h-2", { currentSystemId: 201 }),
        fleet("h-3", { currentSystemId: 202, fleetRole: "mercenary" }), fleet("m-1", { fleetRole: "mercenary" })] });
    const plan = (round, over) => planDispatches(snap(round), { ...PARAMS, maxDispatchesPerReview: 1,
      maxHomeDispatchesPerReview: 2, ...over }).map((d) => `${d.kind}:${d.fleetId}`);
    got.rounds = [plan(12), plan(13), plan(14)];
    got.noRat = plan(12, { maxDispatchesPerReview: 0 });
    got.noHome = plan(12, { maxHomeDispatchesPerReview: 0 });

    const P = { maxWatchRounds: 12 };
    const staged = { fleetId: "f-a", state: "STAGED", currentSystemId: 300, operationId: "op_out" };
    const engaged = { ...staged, state: "ENGAGED" };
    got.decide = [
      decideStep(trip("RATTING"), staged, facts({ hostiles: true }), P),
      decideStep(trip("RATTING", { watchRound: 40, waitRound: 0 }), engaged, facts(), P),
      decideStep(trip("RATTING", { watchRound: 40, waitRound: 12 }), engaged, facts(), P),
      decideStep(trip("OUTBOUND", { watchRound: 0, waitRound: 12 }), { ...staged, state: "TRAVELLING" }, facts(), P),
    ].map((d) => [d.action, d.reason || null]);

    const sw = (fleetId, over) => fleet(fleetId, { state: "STAGED", operationId: `op-${fleetId}`, ...over });
    const fleets = [sw("s-d"), sw("s-a", { state: "PLANNED", fleetRole: "mercenary" }), sw("s-c"),
      sw("s-e", { operationId: null }), sw("s-f", { state: "IDLE", operationId: null }),
      sw("s-g", { fleetRole: "patrol" }), sw("s-h", { state: "TRAVELLING" }), sw("s-b")];
    const sweeps = (max, truncated = false) => planSweeps(fleets, new Set(["s-c"]),
      { orphanSweepsPerReview: max, truncated });
    got.sweeps = [sweeps(4), sweeps(2).map((s) => s.fleetId), sweeps(4, true), sweeps(0)];

    assert.deepStrictEqual(got, {
      rounds: [["rat:r-1", "home:h-1", "home:h-2"], ["rat:r-1", "home:h-2", "home:h-3"],
        ["rat:r-1", "home:h-3", "home:h-1"]],
      noRat: ["home:h-1", "home:h-2"],
      noHome: ["rat:r-1"],
      decide: [["RETURN", "HOSTILES"], ["WAIT", "ENGAGED"], ["RETURN", "TIMEOUT"], ["END", "TIMEOUT"]],
      sweeps: [[{ fleetId: "s-a", expectedVersion: 3 }, { fleetId: "s-b", expectedVersion: 3 },
        { fleetId: "s-d", expectedVersion: 3 }], ["s-a", "s-b"], [], []],
    });
  });
};
