"use strict";

const assert = require("node:assert");

const S = require("../../../lib/world/playerSov/schema");
const { canTransitionPlayerSov, listPlayerSovEdges } = require("../../../lib/world/playerSov/machine");
const { planMirror } = require("../../../lib/world/playerSov/mirror");
const { createPlayerSovRepository } = require("../../../lib/world/playerSov/repository");
const { harness: H } = require("../../battle/settlement.test");

const SYS = 30004000;
const A = 99000001;
const B = 99000002;
const CORP = 98000001;
const HUB = 1700000001;

const liveRow = (o) => ({ claimId: S.claimIdOf(o.systemId || SYS, o.allianceId || A, o.hubItemId || HUB),
  systemId: o.systemId || SYS, allianceId: o.allianceId || A, corpId: CORP, hubItemId: o.hubItemId || HUB,
  state: o.state, baseState: o.baseState || o.state, version: 1 });

module.exports = ({ test, skip }) => {
  test("PS1 machine: every edge of the brief table allowed, LOST -> HELD, HELD -> RETAKING and wrong end reasons "
    + "refused with PLAYER_SOV_TRANSITION_DENIED", () => {
    const E = S.END_REASON;
    const expected = [
      ["CAPTURING", "HELD", null], ["CAPTURING", "LOST", E.NATIVE_GONE], ["CAPTURING", "LOST", E.OWNER_CHANGED],
      ["HELD", "LOST", E.NATIVE_GONE], ["HELD", "LOST", E.OWNER_CHANGED],
      ["SIEGED", "LOST", E.NATIVE_GONE], ["SIEGED", "LOST", E.OWNER_CHANGED],
      ["REINFORCED", "LOST", E.NATIVE_GONE], ["REINFORCED", "LOST", E.OWNER_CHANGED],
      ["CAPTURING", "SIEGED", null], ["HELD", "SIEGED", null], ["SIEGED", "REINFORCED", null],
      ["REINFORCED", "RETAKING", null], ["SIEGED", "CAPTURING", null], ["SIEGED", "HELD", null],
      ["REINFORCED", "CAPTURING", null], ["REINFORCED", "HELD", null],
      ["RETAKING", "LOST", E.RETAKEN], ["RETAKING", "LOST", E.OWNER_CHANGED],
    ];
    for (const [from, to, reason] of expected) {
      assert.deepStrictEqual(canTransitionPlayerSov(from, to, reason), { ok: true }, `${from}->${to} ${reason}`);
    }
    const key = (e) => e.join("|");
    assert.deepStrictEqual(listPlayerSovEdges().map(key).sort(), expected.map(key).sort());
    for (const [from, to, reason] of [["LOST", "HELD", null], ["HELD", "RETAKING", null],
      ["HELD", "LOST", E.RETAKEN], ["RETAKING", "LOST", E.NATIVE_GONE], ["HELD", "LOST", null]]) {
      assert.deepStrictEqual(canTransitionPlayerSov(from, to, reason),
        { ok: false, reason: "PLAYER_SOV_TRANSITION_DENIED", from, to }, `${from}->${to} ${reason}`);
    }
  });

  test("PS2 planMirror: virtual claim skipped (live row -> OWNER_CHANGED), neutral player hub -> INSERT CAPTURING, "
    + "claim -> PROMOTE, nothing -> NATIVE_GONE, another alliance -> OWNER_CHANGED + INSERT HELD, RETAKING without "
    + "claim -> RETAKEN, second pass on the applied state -> []", () => {
    const at = 1000;
    const neutral = (systemId, allianceId) => ({ systemId, allianceId: null, corpId: null, hubItemId: null,
      neutralHub: { itemId: HUB, allianceId, corpId: CORP }, virtualClaim: false });
    const claim = (systemId, allianceId) => ({ systemId, allianceId, corpId: CORP, hubItemId: HUB, neutralHub: null,
      virtualClaim: false });
    const virtual = (systemId) => ({ systemId, allianceId: null, corpId: null, hubItemId: null, neutralHub: null,
      virtualClaim: true });
    const vendor = [virtual(1), neutral(2, A), claim(3, A), claim(5, B), virtual(7), neutral(8, A)];
    const live = new Map([
      [3, liveRow({ systemId: 3, state: "CAPTURING" })],
      [4, liveRow({ systemId: 4, state: "HELD" })],
      [5, liveRow({ systemId: 5, state: "HELD" })],
      [6, liveRow({ systemId: 6, state: "RETAKING", baseState: "HELD" })],
      [7, liveRow({ systemId: 7, state: "HELD" })],
      [8, liveRow({ systemId: 8, state: "RETAKING", baseState: "CAPTURING" })],
    ]);
    const plan = planMirror(vendor, live, at).map((a) => [a.kind, a.systemId, a.state || a.reason || null]);
    assert.deepStrictEqual(plan, [
      ["INSERT", 2, "CAPTURING"],
      ["PROMOTE", 3, null],
      ["END", 4, "NATIVE_GONE"],
      ["END", 5, "OWNER_CHANGED"], ["INSERT", 5, "HELD"],
      ["END", 6, "RETAKEN"],
      ["END", 7, "OWNER_CHANGED"],
    ]);
    const ins = planMirror(vendor, live, at).find((a) => a.kind === "INSERT" && a.systemId === 5);
    assert.strictEqual(ins.claimId, S.claimIdOf(5, B, HUB));
    const applied = new Map([
      [2, liveRow({ systemId: 2, state: "CAPTURING" })],
      [3, liveRow({ systemId: 3, state: "HELD" })],
      [5, liveRow({ systemId: 5, allianceId: B, state: "HELD" })],
      [8, liveRow({ systemId: 8, state: "RETAKING", baseState: "CAPTURING" })],
    ]);
    assert.deepStrictEqual(planMirror(vendor, applied, at + 1), []);
    const sieged = new Map([[3, liveRow({ systemId: 3, state: "SIEGED", baseState: "CAPTURING" })]]);
    assert.deepStrictEqual(planMirror([claim(3, A)], sieged, at).map((a) => [a.kind, a.baseState]),
      [["SET_BASE", "HELD"]]);
  });

  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  needsDriver("PS3 repository on a migrated store: insert CAPTURING, a second live row of the system -> DUPLICATE, "
    + "PROMOTE by CAS, the old version -> VERSION_CONFLICT, LOST + prune after retention", () => H.withStore(driver,
    async (reopen) => {
    const { store } = reopen();
    const repo = createPlayerSovRepository();
    const tx = (fn) => {
      const r = store.transaction("test", fn);
      assert.ok(r.ok, JSON.stringify(r));
      return r.value;
    };
    const first = tx((db) => repo.insertClaim(db, { systemId: SYS, allianceId: A, corpId: CORP, hubItemId: HUB,
      origin: "MIRROR", state: "CAPTURING", at: 100 }));
    assert.strictEqual(first.ok, true, JSON.stringify(first));
    assert.strictEqual(first.claim.claimId, `psov:${SYS}:${A}:${HUB}`);
    assert.deepStrictEqual([first.claim.state, first.claim.baseState, first.claim.heldSinceAt, first.claim.version],
      ["CAPTURING", "CAPTURING", null, 1]);
    const dup = tx((db) => repo.insertClaim(db, { systemId: SYS, allianceId: B, corpId: CORP, hubItemId: HUB + 1,
      origin: "GATE", state: "CAPTURING", at: 101 }));
    assert.strictEqual(dup.reason, "DUPLICATE");
    const held = tx((db) => repo.transition(db, { claim: first.claim, to: "HELD", at: 200 }));
    assert.deepStrictEqual([held.ok, held.claim.state, held.claim.baseState, held.claim.heldSinceAt, held.claim.version],
      [true, "HELD", "HELD", 200, 2]);
    const stale = tx((db) => repo.transition(db, { claim: first.claim, to: "HELD", at: 201 }));
    assert.strictEqual(stale.reason, "VERSION_CONFLICT");
    const lost = tx((db) => repo.transition(db, { claim: held.claim, to: "LOST", reason: "NATIVE_GONE", at: 300 }));
    assert.deepStrictEqual([lost.claim.state, lost.claim.endReason, lost.claim.endedAt], ["LOST", "NATIVE_GONE", 300]);
    assert.deepStrictEqual(tx((db) => repo.getLiveInSystem(db, SYS)), { ok: true, claim: null });
    const back = tx((db) => repo.insertClaim(db, { systemId: SYS, allianceId: A, corpId: CORP, hubItemId: HUB,
      origin: "MIRROR", state: "HELD", at: 350 }));
    assert.deepStrictEqual([back.ok, back.replacedLost, back.claim.state, back.claim.endReason, back.claim.version],
      [true, true, "HELD", null, 1]);
    assert.strictEqual(tx((db) => repo.insertClaim(db, { systemId: SYS, allianceId: A, corpId: CORP, hubItemId: HUB,
      origin: "GATE", state: "CAPTURING", at: 351 })).reason, "DUPLICATE");
    assert.deepStrictEqual(planMirror([{ systemId: SYS, allianceId: A, corpId: CORP, hubItemId: HUB, neutralHub: null,
      virtualClaim: false }], new Map([[SYS, back.claim]]), 352), []);
    tx((db) => repo.transition(db, { claim: back.claim, to: "LOST", reason: "NATIVE_GONE", at: 400 }));
    assert.deepStrictEqual(tx((db) => repo.pruneTerminal(db, 400, 10)), { ok: true, pruned: 0 });
    assert.deepStrictEqual(tx((db) => repo.pruneTerminal(db, 401, 10)), { ok: true, pruned: 1 });
  }));
};
