"use strict";

const assert = require("node:assert");

const S = require("../../lib/world/salvageSchema");
const { harness: H } = require("../battle/settlement.test");
const { harness: SV } = require("../economy/salvageScheduler.test");

const COMP_A = Object.freeze([{ hullGroup: "cruiser", count: 2 }, { hullGroup: "frigate", typeId: 587, count: 3 }]);
const COMP_B = Object.freeze([{ hullGroup: "frigate", count: 2 }]);

module.exports = ({ test, skip }) => {
  const driver = H.loadDriver();
  if (!driver.ok) {
    skip("SV5 e2e", `better-sqlite3 unavailable (${driver.detail})`);
    return;
  }

  test("SV5 e2e: settlement -> field of the winner -> pulse -> outbound -> recovering -> returning -> delivered "
    + "a restart after every phase (lost event -> reconcile, stations not ready -> retry), credit once", () =>
    H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      let env = await SV.boot(reopen(), shared);
      const t0 = shared.clock.now();
      SV.addStation(env, "st-a", H.S.N0, H.FACTION_A, t0);
      const a = H.newFleet(env, "e2e:a", H.FACTION_A, COMP_A);
      const b = H.newFleet(env, "e2e:b", H.FACTION_B, COMP_B);
      const battle = H.battleOfFleets(env, "e2e", [a], [b], { systemId: H.S.N5 });
      const result = H.resultFor(battle.input, "A_WIN", { [b]: (e) => ({ d: e.count, e: 0 }),
        [a]: (e) => (e.hullGroup === "cruiser" ? { d: 1, e: 0 } : { d: 0, e: 0 }) });
      const settlement = env.makeSettlement({ consequences: [env.wrecks.consequence] });
      const settled = H.settleIn(env, settlement, battle, result);
      assert.deepStrictEqual(settled.consequences, { applied: ["wrecks"], refused: [] }, JSON.stringify(settled));
      const fieldId = `wf:${battle.battleId}`;
      const id = S.jobIdOf(fieldId);
      const restart = async (opts) => {
        env.salvage.stop("restart");
        env.wrecks.stop("restart");
        env.store.close("restart");
        env = await SV.boot(reopen(), shared, opts);
        assert.strictEqual(env.started.ok, true, JSON.stringify(env.started));
      };

      const t1 = SV.firstPulseAt(shared, env.cfg.salvage.pulseIntervalMs);
      await SV.settleAt(env, shared, t1);
      assert.deepStrictEqual([SV.jobOf(env, fieldId).state, SV.jobOf(env, fieldId).faction_id], ["OUTBOUND",
        H.FACTION_A]);
      await restart();

      await SV.settleAt(env, shared, t1 + SV.TRAVEL_1);
      const rec = SV.jobOf(env, fieldId);
      assert.deepStrictEqual([rec.state, rec.phase_seq], ["RECOVERING", 2]);
      env.tx((db) => db.prepare("DELETE FROM world_scheduled_events WHERE idempotency_key = ?")
        .run(S.dueKey(id, 2)));
      await restart();
      assert.deepStrictEqual(H.eventOf(env, `${S.reconcileKey(id, 2)}:0`), { state: "QUEUED", due_at: rec.next_at });
      assert.strictEqual(env.salvage.getStatus().counters.reconciled, 1);

      await SV.settleAt(env, shared, rec.next_at);
      const ret = SV.jobOf(env, fieldId);
      assert.deepStrictEqual([ret.state, ret.salvage_units > 0, SV.fieldOf(env, fieldId).salvagedSalvageUnits],
        ["RETURNING", true, 3]);
      await restart({ noStations: true });

      await SV.settleAt(env, shared, ret.next_at);
      assert.strictEqual(SV.jobOf(env, fieldId).state, "DELIVERY_PENDING");
      assert.strictEqual(H.eventOf(env, S.dueKey(id, 4)).state, "RETRY");
      assert.deepStrictEqual(SV.stockOf(env, "st-a"), {});
      await restart();
      assert.strictEqual(env.salvage.getStatus().counters.reconciled, 0, "an open RETRY needs no reconcile");

      await SV.settleAt(env, shared, ret.next_at + 60000);
      const done = SV.jobOf(env, fieldId);
      assert.deepStrictEqual([done.state, done.end_reason], ["DELIVERED", "DELIVERED"]);
      const credited = { "supply/unit:loot": ret.loot_units, "supply/unit:salvage": ret.salvage_units };
      assert.deepStrictEqual(SV.stockOf(env, "st-a"), credited);
      await restart();
      await SV.settleAt(env, shared, ret.next_at + 600000);
      assert.deepStrictEqual(SV.stockOf(env, "st-a"), credited);
      assert.strictEqual(H.n(env, "SELECT count(*) AS n FROM salvage_jobs"), 1, "one job per field");
      env.salvage.stop("test");
    }));
};
