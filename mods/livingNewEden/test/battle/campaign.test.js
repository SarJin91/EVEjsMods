"use strict";

const assert = require("node:assert");

const bench = require("../../tools/benchScheduler");
const { checkBattleInvariants } = require("../../lib/battle/checks");
const { checkBenchInvariants } = require("../../lib/fleets/bench");

const HOUR = 3600000;
const FULL = Object.freeze({ fleets: 20, hours: 48, seed: 5, minBattles: 3 });
const FAST = Object.freeze({ fleets: 4, hours: 12, seed: 5, minBattles: 3 });

module.exports = ({ test, skip, bench: benchCase }) => {
  benchCase("BB1 benchBattles pure 100 + pass 100 -> PASS", async () => {
    const { runBattles } = require("../../tools/benchBattles");
    const r = await runBattles({ battles: 100, mode: "all", seed: 1 });
    assert.strictEqual(r.ok, true, JSON.stringify(r.failures));
  });

  const driver = bench.loadDriver();
  if (!driver.ok) {
    skip("T5 campaign 20 fleets x 48 h", `better-sqlite3 unavailable (${driver.detail})`);
    return;
  }

  test(`T5 campaign ${FAST.fleets} fleets x ${FAST.hours} h, restart in the middle + 1 injected failure: no `
    + "double settlement, invariants PASS", () => runCampaign(FAST));
  benchCase("T5 full campaign 20 fleets x 48 h, restart in the middle + 1 injected failure",
    () => runCampaign(FULL));

  async function runCampaign(size) {
    const opts = { ...bench.DEFAULTS, memory: true, fleets: size.fleets, hours: size.hours, dwellMin: 240,
      roamMaxJumps: 3, seed: size.seed, mapSystems: 12, battles: true, set: {} };
    const config = bench.benchConfig(opts);
    let injected = 0;
    const hooks = { beforeSettle() {
      if (injected === 0) {
        injected += 1;
        throw new Error("injected failure");
      }
    } };
    const env = bench.createEnv(driver, opts, config, { hooks, nowMs: () => 0 });
    try {
      await env.ready;
      const stats = bench.newStats();
      await bench.simulate(env, bench.START_MS + (size.hours / 2) * HOUR, stats);
      env.restart();
      await env.ready;
      await bench.simulate(env, bench.START_MS + size.hours * HOUR, stats);
      assert.strictEqual(injected, 1, "the failure was injected");
      const battles = env.n("SELECT count(*) AS n FROM battle_records");
      assert.ok(battles >= size.minBattles, `battles ${battles}`);
      assert.strictEqual(env.n(`SELECT count(*) AS n FROM (SELECT idempotency_key FROM battle_records GROUP BY 1
        HAVING count(*) > 1)`), 0);
      assert.strictEqual(env.n(`SELECT count(*) AS n FROM (SELECT settlement_key FROM battle_records
        WHERE settlement_key IS NOT NULL GROUP BY 1 HAVING count(*) > 1)`), 0);
      assert.strictEqual(env.n(`SELECT count(*) AS n FROM (SELECT aggregate_id FROM world_event_journal
        WHERE event_type = 'BATTLE_SETTLED' GROUP BY 1 HAVING count(*) > 1)`), 0);
      assert.ok(env.n("SELECT coalesce(max(n), 0) AS n FROM (SELECT count(*) AS n FROM world_wreck_fields "
        + "GROUP BY battle_id)") <= 1);
      const read = env.store.transaction("test.check", (db) => ({ battle: checkBattleInvariants(db),
        fleets: checkBenchInvariants(db, { now: env.clock.now(), catchUpLagMs: config.scheduler.catchUpLagMs }) }));
      assert.ok(read.ok, JSON.stringify(read));
      assert.strictEqual(read.value.battle.pass, true, JSON.stringify(read.value.battle));
      assert.strictEqual(read.value.fleets.pass, true, JSON.stringify(read.value.fleets));
      assert.ok(read.value.battle.completed >= 1, JSON.stringify(read.value.battle));
    } finally {
      env.close();
    }
  }
};
