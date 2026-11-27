"use strict";

const assert = require("node:assert");

const OS = require("../../../lib/world/occupation/schema");
const M = require("../../../lib/world/occupation/machine");
const { harness: X } = require("../sovStructures.test");

const { view, sovOf, tick, PARAMS, AMARR, SANSHA, GURISTAS, HOUR } = X;
const MIN = 60000;
const AT = 7 * HOUR;
const START = 6 * HOUR;
const SAMPLE = 10 * MIN;
const P = Object.freeze({ siegeHoldMs: HOUR, reinforceMs: 2 * HOUR, siegeSampleMs: SAMPLE, pauseWhenObserved: true });
const CLAIM_ID = "psov:30002000:99000001:1700000001";

function claim(o = {}) {
  return { claimId: CLAIM_ID, state: o.state || "HELD", baseState: "HELD", allianceId: 99000001, corpId: 98000001,
    attackerFactionId: o.attacker === undefined ? null : o.attacker, attackStartedAt: o.start === undefined ? null
      : o.start, reinforcedUntil: null, version: 3, observed: o.observed === true, ownerOnline: o.online !== false,
    clock: o.clock || null, hostileTo: () => o.hostile !== false, params: P };
}
const clockOf = (phase, creditedMs, lastSampleAt, version = 2) => ({ phase, phaseKey: START, creditedMs, lastSampleAt,
  version });
const withClaim = (c, o = {}) => ({ ...view(o), playerClaim: c });
const opsOf = (ev) => ev.playerOps.map((x) => x.op);

module.exports = ({ test }) => {
  test("R1 playerGate decision table: null/LOST pass, FRIENDLY, RETAKING, BUSY, ATTACK (also for an exempt kind), "
    + "siege samples with offline / observed pause and the 2 x siegeSampleMs cap, REINFORCE, REINFORCED wait, offline "
    + "with a full clock, RETAKE; finish wakes the chain at siegeSampleMs", () => {
    const lost = M.evaluate(withClaim(claim({ state: "LOST" })), tick, PARAMS);
    assert.deepStrictEqual([lost.to, lost.playerOps], [OS.OCCUPIED, []]);
    const stop = (c) => {
      const ev = M.evaluate(withClaim(c), tick, PARAMS);
      assert.strictEqual(ev.to, null, JSON.stringify(ev));
      return ev;
    };
    assert.ok(stop(claim({ hostile: false })).notes.includes("PLAYER_SOV_FRIENDLY"));
    const retaking = stop(claim({ state: "RETAKING", attacker: SANSHA, start: START }));
    assert.deepStrictEqual([retaking.notes.includes("PLAYER_SOV_RETAKING"), retaking.playerOps], [true, []]);
    assert.ok(stop(claim({ state: "SIEGED", attacker: GURISTAS, start: START })).notes.includes("PLAYER_SOV_BUSY"));

    const attack = stop(claim());
    assert.deepStrictEqual(attack.playerOps, [{ op: "P_ATTACK", claimId: CLAIM_ID, factionId: SANSHA, version: 3 }]);
    assert.deepStrictEqual([attack.notes.includes("PLAYER_SOV_SIEGE_STARTED"), attack.next], [true,
      { dueAt: (Math.floor(AT / SAMPLE) + 1) * SAMPLE, bucket: Math.floor(AT / SAMPLE) + 1, interval: SAMPLE }]);
    assert.deepStrictEqual(attack.sovOps, []);
    const exempt = M.evaluate({ ...view({ sov: sovOf([], (f) => f !== SANSHA) }), playerClaim: claim() }, tick, PARAMS);
    assert.deepStrictEqual([exempt.to, opsOf(exempt)], [null, ["P_ATTACK"]]);

    const sieged = (o) => stop(claim({ state: "SIEGED", attacker: SANSHA, start: START, ...o }));
    const run = sieged({ clock: clockOf("SIEGED", 10 * MIN, AT - 10 * MIN) });
    assert.deepStrictEqual(run.playerOps, [{ op: "P_SAMPLE", claimId: CLAIM_ID, phase: "SIEGED", phaseKey: START,
      creditedMs: 20 * MIN, sampledAt: AT, expectVersion: 2 }]);
    assert.ok(run.notes.includes("PLAYER_SOV_SIEGE"));
    const offline = sieged({ online: false, clock: clockOf("SIEGED", 10 * MIN, AT - 10 * MIN) });
    assert.deepStrictEqual([offline.playerOps[0].creditedMs, offline.notes.includes("PLAYER_SOV_PAUSED_OFFLINE")],
      [10 * MIN, true]);
    const observed = sieged({ observed: true, clock: clockOf("SIEGED", 10 * MIN, AT - 10 * MIN) });
    assert.deepStrictEqual([observed.playerOps[0].creditedMs, observed.notes.includes("PLAYER_SOV_SIEGE_OBSERVED")],
      [10 * MIN, true]);
    const capped = sieged({ clock: clockOf("SIEGED", 0, AT - 5 * HOUR) });
    assert.strictEqual(capped.playerOps[0].creditedMs, 2 * SAMPLE);
    const other = sieged({ clock: { ...clockOf("SIEGED", 50 * MIN, AT - MIN), phaseKey: START - 1 } });
    assert.deepStrictEqual([other.playerOps[0].creditedMs, other.playerOps[0].expectVersion], [0, null]);
    assert.strictEqual(other.next.interval, SAMPLE);

    const reinforce = sieged({ clock: clockOf("SIEGED", 55 * MIN, AT - 10 * MIN) });
    assert.deepStrictEqual(opsOf(reinforce), ["P_SAMPLE", "P_REINFORCE"]);
    assert.deepStrictEqual([reinforce.playerOps[1].until, reinforce.notes.includes("PLAYER_SOV_REINFORCED")],
      [AT + 2 * HOUR, true]);

    const reinforced = (o) => stop(claim({ state: "REINFORCED", attacker: SANSHA, start: START, ...o }));
    const wait = reinforced({ clock: clockOf("REINFORCED", 30 * MIN, AT - 10 * MIN) });
    assert.deepStrictEqual([opsOf(wait), wait.notes.includes("PLAYER_SOV_REINFORCED_WAIT")], [["P_SAMPLE"], true]);
    const full = reinforced({ online: false, clock: clockOf("REINFORCED", 2 * HOUR, AT - 10 * MIN) });
    assert.deepStrictEqual([opsOf(full), full.notes.includes("PLAYER_SOV_PAUSED_OFFLINE")], [["P_SAMPLE"], true]);
    const seen = reinforced({ observed: true, clock: clockOf("REINFORCED", 2 * HOUR, AT - 10 * MIN) });
    assert.deepStrictEqual([opsOf(seen), seen.notes.includes("PLAYER_SOV_REINFORCED_OBSERVED")], [["P_SAMPLE"], true]);
    const retake = reinforced({ clock: clockOf("REINFORCED", 2 * HOUR - 5 * MIN, AT - 10 * MIN) });
    assert.deepStrictEqual(opsOf(retake), ["P_SAMPLE", "P_RETAKE"]);
    assert.deepStrictEqual([retake.playerOps[1].factionId, retake.notes.includes("PLAYER_SOV_RETAKING"),
      retake.next.interval], [SANSHA, true, PARAMS.evalIntervalMs]);
  });

  test("R2 follow-up: the pretender lost INVASION -> P_LIFT (SIEGED and REINFORCED), RETAKING without LIFT, still "
    + "INVASION of the attacker -> no LIFT; view.playerClaim null = the evaluation without the field", () => {
    const lostField = (c) => M.evaluate({ ...view({ presence: { [AMARR]: 100 } }), playerClaim: c }, tick, PARAMS);
    for (const state of ["SIEGED", "REINFORCED"]) {
      const ev = lostField(claim({ state, attacker: SANSHA, start: START }));
      assert.strictEqual(ev.to, OS.CONTESTED, JSON.stringify(ev));
      assert.deepStrictEqual(ev.playerOps, [{ op: "P_LIFT", claimId: CLAIM_ID, version: 3 }], state);
    }
    assert.deepStrictEqual(lostField(claim({ state: "RETAKING", attacker: SANSHA, start: START })).playerOps, []);
    const early = M.evaluate({ ...view({ at: 3 * HOUR }), playerClaim: claim({ state: "SIEGED", attacker: SANSHA,
      start: START }) }, tick, PARAMS);
    assert.deepStrictEqual([early.to, early.playerOps], [null, []]);
    assert.deepStrictEqual(M.evaluate({ ...view(), playerClaim: null }, tick, PARAMS), M.evaluate(view(), tick, PARAMS));
    assert.deepStrictEqual(M.evaluate(view(), tick, PARAMS).playerOps, []);
  });
};
