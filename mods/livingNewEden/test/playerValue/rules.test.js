"use strict";

const assert = require("node:assert");

const { kindOfStructure, systemValueOf, VALUE_KINDS } = require("../../lib/world/playerValue/rules");
const { premiumExtra } = require("../../lib/strategy/ai/playerValue");
const { scoreCandidate } = require("../../lib/strategy/ai/targeting");
const { planStructureAssault } = require("../../lib/strategy/ai/structureAssault");
const { TARGET_SCORING_V1 } = require("../../lib/strategy/data/targetScoring");
const { createOperationKinds } = require("../../lib/strategy/kinds");
const { OPERATION_KINDS_VERSION, OPERATION_KINDS_V1 } = require("../../lib/strategy/data/operationKinds");
const { FLEET_ROLES, OPERATION_TYPES, OBJECTIVES } = require("../../lib/fleets/schema");
const { SIEGE_ROLES } = require("../../lib/stations/siege/schema");
const { SCHEMA } = require("../../config");

const AT = 1760000000000;
const HOUR = 3600000;
const F = 7;

const weightsOf = () => Object.fromEntries(VALUE_KINDS.map((k) => [k,
  SCHEMA.find((r) => r.key === `playerValue.weight.${k}`).default]));
const S = (o) => ({ typeId: 35832, family: "citadel", size: "STRUCTURE_SIZE_MEDIUM", state: "SHIELD_VULNERABLE",
  trig: false, ...o });

module.exports = ({ test }) => {
  test("PV1 kindOfStructure + systemValueOf: weights, maxCountPerKind, valueCap/capped, trig vs Ansiblex, "
    + "ANCHORING = 0, unknown kind = 0", () => {
    assert.deepStrictEqual([
      kindOfStructure(S({})), kindOfStructure(S({ size: "STRUCTURE_SIZE_LARGE" })),
      kindOfStructure(S({ size: "STRUCTURE_SIZE_EXTRA_LARGE" })),
      kindOfStructure(S({ family: "engineering", size: "STRUCTURE_SIZE_EXTRA_LARGE" })),
      kindOfStructure(S({ family: "refinery", size: "STRUCTURE_SIZE_LARGE" })),
      kindOfStructure(S({ typeId: 81826, family: "refinery", size: "STRUCTURE_SIZE_FLEX" })),
      kindOfStructure(S({ typeId: 35841, family: "flex", size: "STRUCTURE_SIZE_FLEX" })),
      kindOfStructure(S({ typeId: 35841, family: "flex", size: "STRUCTURE_SIZE_FLEX", trig: true })),
      kindOfStructure(S({ typeId: 37534, family: "flex", size: "STRUCTURE_SIZE_FLEX" })),
      kindOfStructure(S({ state: "ANCHORING" })), kindOfStructure(S({ state: "unanchored" })),
      kindOfStructure(S({ family: "sov", size: "STRUCTURE_SIZE_UNDEFINED" })), kindOfStructure(null),
    ], ["citadelM", "citadelL", "citadelXL", "engineeringXL", "refineryL", "metenox", "ansiblex", "trigBridge",
      "flexOther", null, null, null, null]);
    const W = weightsOf();
    assert.notStrictEqual(W.trigBridge, W.ansiblex, "the trig bridge has its own weight");
    const caps = { maxCountPerKind: 3, valueCap: 120 };
    assert.deepStrictEqual(systemValueOf({ citadelM: 2, metenox: 1, skyhook: 1, sentry: 5, bogus: 9 }, W, caps),
      { value: 55, capped: false });
    assert.deepStrictEqual(systemValueOf({ citadelM: 10 }, W, caps), { value: 30, capped: false });
    assert.deepStrictEqual(systemValueOf({ citadelXL: 3, trigBridge: 1 }, W, caps), { value: 120, capped: true });
    assert.deepStrictEqual(systemValueOf({ ansiblex: 1 }, W, caps).value + 20,
      systemValueOf({ trigBridge: 1 }, W, caps).value);
    assert.deepStrictEqual(systemValueOf({}, W, caps), { value: 0, capped: false });
  });

  test("PV2 scoreCandidate: playerValue null = the score before K2; on: + min(cap, V) claimed, permille unclaimed", () => {
    const snapshot = { factionId: F, systems: [], neighbors: () => [], regionOf: () => null,
      entry: { homeRegionIds: [] }, playerValue: new Map([[30, 500], [31, 40]]) };
    const facts = (playerSov) => ({ enemyStrength: 0, controller: null, hostileController: false, captureAllowed: true,
      sys: null, category: "free", fresh: true, playerKills: 0, playerSov });
    const base = { scoring: TARGET_SCORING_V1, playerSov: { targetPremium: 20, maxSiegesPerFaction: 2 } };
    const before = TARGET_SCORING_V1.base + 2 * TARGET_SCORING_V1.perJump + TARGET_SCORING_V1.free + 20;
    assert.strictEqual(before, 1050);
    assert.strictEqual(scoreCandidate(snapshot, { ...base, playerValue: null }, facts(true), 30, 2), before);
    assert.strictEqual(scoreCandidate(snapshot, base, facts(true), 30, 2), before, "no playerValue key");
    const on = { ...base, playerValue: { unclaimedPermille: 0, valueCap: 120 } };
    assert.strictEqual(scoreCandidate(snapshot, on, facts(true), 30, 2), before + 120, "capped at valueCap");
    assert.strictEqual(scoreCandidate(snapshot, on, facts(true), 31, 2), before + 40);
    const unclaimed = before - 20;
    assert.strictEqual(scoreCandidate(snapshot, on, facts(false), 30, 2), unclaimed);
    const half = { ...base, playerValue: { unclaimedPermille: 500, valueCap: 120 } };
    assert.strictEqual(scoreCandidate(snapshot, half, facts(false), 30, 2), unclaimed + 60);
    assert.strictEqual(scoreCandidate(snapshot, half, facts(false), 31, 2), unclaimed + 20);
    assert.strictEqual(scoreCandidate({ ...snapshot, playerValue: undefined }, on, facts(true), 30, 2), before);
    assert.strictEqual(premiumExtra(undefined, 30, true, on.playerValue), 0);
    assert.strictEqual(premiumExtra(new Map(), 30, true, on.playerValue), 0);
  });

  test("PV3 planStructureAssault: the higher V first; equal V -> systemId order; one LAUNCH, limits unchanged", () => {
    const kinds = createOperationKinds({ version: OPERATION_KINDS_VERSION, kinds: OPERATION_KINDS_V1 },
      { operationTypes: OPERATION_TYPES, objectives: OBJECTIVES, fleetRoles: FLEET_ROLES });
    assert.ok(kinds.ok, JSON.stringify(kinds));
    const composition = [{ hullGroup: "cruiser", typeId: null, count: 2 }];
    const snap = (playerValue) => ({ v: 1, factionId: F, at: AT,
      faction: { status: "ACTIVE", homeSystemId: 20 },
      doctrine: { canOccupy: false, operationTypes: ["recon", "raid", "return", "structure_assault"] },
      neighbors: (id) => [id - 1, id + 1].filter((x) => x >= 1 && x <= 40),
      stations: [{ systemId: 20, stationId: "st20" }], systems: [{ systemId: 20, controllerFactionId: F }],
      territory: [], operations: [], operationsTruncated: false, fleetsTruncated: false,
      fleets: [{ fleetId: "f1", version: 2, state: "IDLE", fleetRole: "invasion", systemId: 20, refitPending: false,
        composition }],
      playerSiege: { mode: "ready", attacking: [], truncated: false,
        targets: [{ systemId: 18, structureId: 502, requiredDps: 100 }, { systemId: 22, structureId: 501,
          requiredDps: 100 }] },
      ...(playerValue === undefined ? {} : { playerValue }) });
    const params = (on) => ({ kinds: kinds.kinds.list, maxAssemblyJumps: 8, maxBfsSystems: 2000,
      maxFleetsPerOperation: 4, attackWindowMs: 2 * HOUR,
      playerSiege: { fleetRoles: SIEGE_ROLES, maxDispatchPerReview: 1, dispatchMaxJumps: 3, dispatchDpsMargin: 1.5,
        groups: { cruiser: { dps: 100, applicationFactor: 1 } } },
      playerValue: on ? { unclaimedPermille: 0, valueCap: 120 } : null });
    const launched = (out) => out.intents.map((i) => [i.type, i.target.systemId]);
    const off = planStructureAssault(snap(new Map([[22, 90]])), params(false), new Set(), 2);
    assert.deepStrictEqual(launched(off), [["LAUNCH", 18]], "flag off: the read order");
    const legacy = planStructureAssault(snap(undefined), params(false), new Set(), 2);
    assert.deepStrictEqual([legacy.intents, legacy.notes], [off.intents, off.notes], "flag off = as before K2");
    const on = planStructureAssault(snap(new Map([[22, 90], [18, 30]])), params(true), new Set(), 2);
    assert.deepStrictEqual(launched(on), [["LAUNCH", 22]]);
    assert.deepStrictEqual(on.notes, ["STRUCTURE_ASSAULT_LAUNCH:22"]);
    const tie = planStructureAssault(snap(new Map([[22, 30], [18, 30]])), params(true), new Set(), 2);
    assert.deepStrictEqual(launched(tie), [["LAUNCH", 18]]);
  });
};
