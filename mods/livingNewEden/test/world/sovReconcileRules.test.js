"use strict";

const assert = require("node:assert");
const { createFakeSovNative } = require("../_support/fakeSovNative");
const {
  classifyForeign,
  listDefended,
  planSettlement,
  factKey,
  defendedKey,
} = require("../../lib/world/sovReconcile/rules");
const { HOLD_STATES_FOR_LOSS } = require("../../lib/world/sovReconcile/schema");
const { HELD_STATES } = require("../../lib/world/occupation/schema");

module.exports = ({ test }) => {
  const fake = createFakeSovNative();

  function makeOutcome(overrides = {}) {
    return {
      targetId: 30000001,
      campaignEpoch: "epoch-1",
      defenderAllianceId: 99000001,
      result: "attacker",
      completedAtMs: 1000,
      systemId: 30000001,
      ...overrides,
    };
  }

  function makeRow(overrides = {}) {
    return {
      allianceId: 99000001,
      boundSeq: 5,
      boundAt: 500,
      foreignAt: 2000,
      factionId: 500001,
      kind: "HUB_DESTROYED",
      claim: null,
      ...overrides,
    };
  }

  test("TA1 classifyForeign: attacker outcome priority over claim", () => {
    const outcomes = [makeOutcome({ completedAtMs: 1500, result: "attacker" })];
    const row = makeRow({ claim: { allianceId: 99000001 } });
    const res = classifyForeign(row, outcomes, () => false);
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.kind, "HUB_DESTROYED");
    assert.strictEqual(res.foreignAt, 2000);
    assert.ok(res.attackerOutcome);
  });

  test("TA1 classifyForeign: newest attacker outcome wins", () => {
    const outcomes = [
      makeOutcome({ completedAtMs: 1000, result: "attacker" }),
      makeOutcome({ completedAtMs: 2000, result: "attacker" }),
    ];
    const row = makeRow({ claim: { allianceId: 99000001 } });
    const res = classifyForeign(row, outcomes, () => false);
    assert.strictEqual(res.kind, "HUB_DESTROYED");
    assert.strictEqual(res.foreignAt, 2000);
  });

  test("TA1 classifyForeign: no attacker outcome, claim null -> CLAIM_LOST", () => {
    const outcomes = [makeOutcome({ result: "defender" })];
    const row = makeRow({ claim: null });
    const res = classifyForeign(row, outcomes, () => false);
    assert.strictEqual(res.kind, "CLAIM_LOST");
    assert.strictEqual(res.foreignAt, row.foreignAt);
  });

  test("TA1 classifyForeign: claim matches alliance -> RESTORED", () => {
    const outcomes = [makeOutcome({ result: "defender" })];
    const row = makeRow({ claim: { allianceId: 99000001 } });
    const res = classifyForeign(row, outcomes, () => false);
    assert.strictEqual(res.kind, "RESTORED");
  });

  test("TA1 classifyForeign: claim different alliance, isModAlliance throws -> PLAYER_CLAIM", () => {
    const outcomes = [makeOutcome({ result: "defender" })];
    const row = makeRow({ claim: { allianceId: 88000001 } });
    const res = classifyForeign(row, outcomes, () => { throw new Error("boom"); });
    assert.strictEqual(res.kind, "PLAYER_CLAIM");
  });

  test("TA1 classifyForeign: claim different alliance, isModAlliance true -> MOD_OTHER", () => {
    const outcomes = [makeOutcome({ result: "defender" })];
    const row = makeRow({ claim: { allianceId: 88000001 } });
    const res = classifyForeign(row, outcomes, (id) => id === 88000001);
    assert.strictEqual(res.kind, "MOD_OTHER");
  });

  test("TA1 classifyForeign: attacker outcome before boundAt is ignored (reset case)", () => {
    const outcomes = [makeOutcome({ completedAtMs: 400, result: "attacker" })];
    const row = makeRow({ claim: { allianceId: 99000001 } });
    const res = classifyForeign(row, outcomes, () => false);
    assert.strictEqual(res.kind, "RESTORED");
  });

  test("TA1 classifyForeign: ROW_INCOMPLETE for missing allianceId", () => {
    const row = makeRow({ allianceId: 0 });
    const res = classifyForeign(row, [], () => false);
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.reason, "ROW_INCOMPLETE");
  });

  test("TA1 classifyForeign: ROW_INCOMPLETE for missing boundSeq", () => {
    const row = makeRow({ boundSeq: -1 });
    const res = classifyForeign(row, [], () => false);
    assert.strictEqual(res.reason, "ROW_INCOMPLETE");
  });

  test("TA1 classifyForeign: ROW_INCOMPLETE for missing boundAt", () => {
    const row = makeRow({ boundAt: 0 });
    const res = classifyForeign(row, [], () => false);
    assert.strictEqual(res.reason, "ROW_INCOMPLETE");
  });

  test("TA1 classifyForeign: ROW_INCOMPLETE for missing foreignAt", () => {
    const row = makeRow({ foreignAt: 0 });
    const res = classifyForeign(row, [], () => false);
    assert.strictEqual(res.reason, "ROW_INCOMPLETE");
  });

  test("TA1 classifyForeign: INVALID_INPUT when isModAlliance not a function", () => {
    const row = makeRow({ claim: { allianceId: 88000001 } });
    const res = classifyForeign(row, [], "not a function");
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.reason, "INVALID_INPUT");
  });

  test("TA2 planSettlement: HOLD_STATES_FOR_LOSS matches occupation/schema HELD_STATES + STABLE", () => {
    assert.deepStrictEqual(HOLD_STATES_FOR_LOSS, ["STABLE", ...HELD_STATES]);
  });

  test("TA2 planSettlement: STALE when logRow null", () => {
    const row = makeRow({ kind: "HUB_DESTROYED" });
    const res = planSettlement({ row, logRow: null, world: { controllerFactionId: 500001, occupationState: "OCCUPIED" }, now: 3000, maxDeferMs: 86400000, hubLossInfluencePoints: 10 });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.action, "STALE");
  });

  test("TA2 planSettlement: STALE when lastSeq !== boundSeq", () => {
    const row = makeRow({ kind: "HUB_DESTROYED", boundSeq: 5 });
    const logRow = { boundSeq: 4, allianceId: 99000001 };
    const res = planSettlement({ row, logRow, world: { controllerFactionId: 500001, occupationState: "OCCUPIED" }, now: 3000, maxDeferMs: 86400000, hubLossInfluencePoints: 10 });
    assert.strictEqual(res.action, "STALE");
  });

  test("TA2 planSettlement: STALE when lastAlliance !== allianceId", () => {
    const row = makeRow({ kind: "HUB_DESTROYED", allianceId: 99000001 });
    const logRow = { boundSeq: 5, allianceId: 88000001 };
    const res = planSettlement({ row, logRow, world: { controllerFactionId: 500001, occupationState: "OCCUPIED" }, now: 3000, maxDeferMs: 86400000, hubLossInfluencePoints: 10 });
    assert.strictEqual(res.action, "STALE");
  });

  test("TA2 planSettlement: REPROJECT for DEFENDED kind", () => {
    const row = makeRow({ kind: "DEFENDED" });
    const logRow = { boundSeq: 5, allianceId: 99000001 };
    const res = planSettlement({ row, logRow, world: { controllerFactionId: 500001, occupationState: "OCCUPIED" }, now: 3000, maxDeferMs: 86400000, hubLossInfluencePoints: 10 });
    assert.strictEqual(res.action, "REPROJECT");
  });

  test("TA2 planSettlement: SUPERSEDED when world is null", () => {
    const row = makeRow({ kind: "HUB_DESTROYED" });
    const logRow = { boundSeq: 5, allianceId: 99000001 };
    const res = planSettlement({ row, logRow, world: null, now: 3000, maxDeferMs: 86400000, hubLossInfluencePoints: 10 });
    assert.strictEqual(res.action, "SUPERSEDED");
  });

  test("TA2 planSettlement: SUPERSEDED when controller !== factionId", () => {
    const row = makeRow({ kind: "HUB_DESTROYED", factionId: 500001 });
    const logRow = { boundSeq: 5, allianceId: 99000001 };
    const res = planSettlement({ row, logRow, world: { controllerFactionId: 500002, occupationState: "OCCUPIED" }, now: 3000, maxDeferMs: 86400000, hubLossInfluencePoints: 10 });
    assert.strictEqual(res.action, "SUPERSEDED");
  });

  test("TA2 planSettlement: LOSS_APPLIED for HOLD_STATES (STABLE, OCCUPIED, CONSOLIDATING)", () => {
    for (const state of ["STABLE", "OCCUPIED", "CONSOLIDATING"]) {
      const row = makeRow({ kind: "HUB_DESTROYED" });
      const logRow = { boundSeq: 5, allianceId: 99000001 };
      const res = planSettlement({ row, logRow, world: { controllerFactionId: 500001, occupationState: state }, now: 3000, maxDeferMs: 86400000, hubLossInfluencePoints: 10 });
      assert.strictEqual(res.action, "LOSS_APPLIED", `state=${state}`);
      assert.strictEqual(res.points, 10);
    }
  });

  test("TA2 planSettlement: DEFERRED before deadline for non-hold state", () => {
    const row = makeRow({ kind: "HUB_DESTROYED", foreignAt: 2000 });
    const logRow = { boundSeq: 5, allianceId: 99000001 };
    const res = planSettlement({ row, logRow, world: { controllerFactionId: 500001, occupationState: "CONTESTED" }, now: 3000, maxDeferMs: 86400000, hubLossInfluencePoints: 10 });
    assert.strictEqual(res.action, "DEFERRED");
    assert.strictEqual(res.until, 2000 + 86400000);
  });

  test("TA2 planSettlement: DROP_ONLY after deadline for non-hold state", () => {
    const row = makeRow({ kind: "HUB_DESTROYED", foreignAt: 2000 });
    const logRow = { boundSeq: 5, allianceId: 99000001 };
    const res = planSettlement({ row, logRow, world: { controllerFactionId: 500001, occupationState: "CONTESTED" }, now: 2000 + 86400000 + 1, maxDeferMs: 86400000, hubLossInfluencePoints: 10 });
    assert.strictEqual(res.action, "DROP_ONLY");
  });

  test("TA2 planSettlement: points = 0 allowed", () => {
    const row = makeRow({ kind: "HUB_DESTROYED" });
    const logRow = { boundSeq: 5, allianceId: 99000001 };
    const res = planSettlement({ row, logRow, world: { controllerFactionId: 500001, occupationState: "OCCUPIED" }, now: 3000, maxDeferMs: 86400000, hubLossInfluencePoints: 0 });
    assert.strictEqual(res.action, "LOSS_APPLIED");
    assert.strictEqual(res.points, 0);
  });

  test("TA2 planSettlement: at uses foreignAt when no outcome", () => {
    const row = makeRow({ kind: "HUB_DESTROYED", foreignAt: 2000 });
    const logRow = { boundSeq: 5, allianceId: 99000001 };
    const res = planSettlement({ row, logRow, world: { controllerFactionId: 500001, occupationState: "OCCUPIED" }, now: 3000, maxDeferMs: 86400000, hubLossInfluencePoints: 10 });
    assert.strictEqual(res.at, 2000);
  });

  test("TA2 planSettlement: INVALID_INPUT for RESTORED kind", () => {
    const row = makeRow({ kind: "RESTORED" });
    const logRow = { boundSeq: 5, allianceId: 99000001 };
    const res = planSettlement({ row, logRow, world: { controllerFactionId: 500001, occupationState: "OCCUPIED" }, now: 3000, maxDeferMs: 86400000, hubLossInfluencePoints: 10 });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.reason, "INVALID_INPUT");
  });

  test("TA3 listDefended: filters defender outcomes for alliance at/after boundAt, returns new frozen array", () => {
    const outcomes = [
      makeOutcome({ completedAtMs: 1000, result: "defender" }),
      makeOutcome({ completedAtMs: 2000, result: "defender" }),
      makeOutcome({ completedAtMs: 3000, result: "attacker" }),
      makeOutcome({ completedAtMs: 4000, result: "defender", defenderAllianceId: 88000001 }),
    ];
    const frozen = Object.freeze([...outcomes]);
    const res = listDefended({ allianceId: 99000001, boundAt: 1500, outcomes: frozen });
    assert.strictEqual(res.length, 1);
    assert.strictEqual(res[0].completedAtMs, 2000);
    assert.ok(Object.isFrozen(res));
    assert.strictEqual(outcomes.length, 4);
  });

  test("TA3 factKey: builds correct key format", () => {
    const res = factKey(30000001, 5, 2000, "HUB_DESTROYED");
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.key, "sov:native:30000001:5:2000:HUB_DESTROYED");
  });

  test("TA3 factKey: different foreignAt = different key", () => {
    const k1 = factKey(30000001, 5, 2000, "HUB_DESTROYED");
    const k2 = factKey(30000001, 5, 2001, "HUB_DESTROYED");
    assert.notStrictEqual(k1.key, k2.key);
  });

  test("TA3 factKey: foreignAt = 0 -> INVALID_INPUT", () => {
    const res = factKey(30000001, 5, 0, "HUB_DESTROYED");
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.reason, "INVALID_INPUT");
  });

  test("TA3 factKey: invalid kind -> INVALID_KIND", () => {
    const res = factKey(30000001, 5, 2000, "INVALID_KIND");
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.reason, "INVALID_KIND");
  });

  test("TA3 defendedKey: limit 120 chars -> INVALID_RECEIPT", () => {
    const res = defendedKey(30000001, "epoch-1");
    assert.deepStrictEqual(res, { ok: true, key: "sov:native:30000001:camp:epoch-1" });
    assert.deepStrictEqual(defendedKey(30000001, "e".repeat(121)), { ok: false, reason: "INVALID_RECEIPT" });
  });
};