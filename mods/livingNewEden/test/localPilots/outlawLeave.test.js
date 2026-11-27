"use strict";

const assert = require("node:assert");

const LP = require("./localPilots.test").harness;
const seamModule = require("../../lib/adapter/localPilots");
const { createUnavailableLocalPilots } = require("../../lib/localPilots");

const S = 30000142;
const BOSS = 92000002;

module.exports = ({ test }) => {
  test("OL1 boss in Local -> KILLED -> nudge -> next pass removes it from Local (repush, relog); counters; stub", () => {
    try {
      const w = LP.world();
      w.records.set(BOSS, { corporationID: 98000001, allianceID: 0 });
      const residents = new Map([[S, [BOSS]]]);
      const bounty = { getStatus: () => ({ state: "running" }),
        residentsFor: () => ({ ok: true, bySystem: new Map(residents) }) };
      const clock = { t: 0, now() { return this.t; } };
      const env = LP.boot({ world: w, presenceState: { observed: [S] }, clock, bounty, bountyConfig: { enabled: true },
        fleets: new Map([[S, [LP.fleet(LP.FACTION, null, 2)]]]) });
      const live = () => env.timers.filter((t) => !t.cancelled);
      assert.strictEqual(live().length, 1, "the start nudge");
      live()[0].fn();
      assert.ok(env.vendor.localOf(S).includes(BOSS), "the boss is in Local");
      const repushBefore = env.vendor.log.repush.length;

      residents.clear();
      clock.t = 2000;
      assert.deepStrictEqual(env.lp.nudge(), { ok: true });
      const pending = live();
      assert.strictEqual(pending.length, 1);
      assert.strictEqual(pending[0].ms, 1000, "nudgeDelayMs, not refreshMs");
      assert.ok(env.vendor.localOf(S).includes(BOSS), "nothing changes before the pass");
      clock.t = 3000;
      pending[0].fn();
      const last = env.vendor.log.setRoster[env.vendor.log.setRoster.length - 1];
      assert.strictEqual(last[0], S);
      assert.ok(!last[1].includes(BOSS), JSON.stringify(last));
      assert.ok(env.vendor.log.repush.slice(repushBefore).includes(S), "the system is repushed");
      assert.ok(!env.vendor.localOf(S).includes(BOSS), "a fresh membership list (relog) has no boss");
      const st = env.lp.getStatus();
      assert.deepStrictEqual([st.outlawsLeft, st.nudges], [1, 1]);
      assert.strictEqual(st.lastPass.outlaws, 0, "no boss shown");
      env.lp.runPassNow();
      assert.strictEqual(env.lp.getStatus().outlawsLeft, 1);

      env.lp.stop();
      assert.deepStrictEqual(env.lp.nudge(), { ok: false, reason: "NOT_RUNNING" });
      assert.deepStrictEqual(createUnavailableLocalPilots("off").nudge(), { ok: false, reason: "NOT_RUNNING" });
    } finally {
      seamModule._resetForTest();
    }
  });
};
