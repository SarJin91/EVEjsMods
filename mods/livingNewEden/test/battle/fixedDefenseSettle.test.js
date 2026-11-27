"use strict";

const assert = require("node:assert");

const { startBattle } = require("../../lib/battle");
const { harness: H } = require("./settlement.test");
const { harness: C } = require("./contacts.test");

const SENTRY_EHP = 500000;
const KEY = "sattr:30000005:1:battle";

const sentry = (i) => ({ sentryId: `sentry_${String(i).padStart(2, "0")}`, itemId: 990000000 + i, typeId: 340501,
  ownerKind: "player", ownerId: 90000001, hp: SENTRY_EHP, ehp: SENTRY_EHP, dps: 67.7, signature: 6000, designSig: 125 });

const observedPresence = Object.freeze({ getStatus: () => ({ available: true, stale: false }),
  isObserved: () => true, distanceToObserved: () => ({ ok: true, distance: 0 }) });

function spy(name, seen) {
  return Object.freeze({ name, apply(_tx, settled) {
    seen.push([name, settled.battleId]);
    return { ok: true };
  } });
}

module.exports = ({ test, skip }) => {
  const driver = H.loadDriver();
  if (!driver.ok) {
    skip("FD-S1 sentry battle facade -> resolution -> settlement", `better-sqlite3 unavailable (${driver.detail})`);
    return;
  }

  test("FD-S1 sentry battle: facade -> BATTLE_RESOLUTION -> COMPLETED VIRTUAL, losses once, retreat, settled."
    + "fixedDefenses to `sentries`, occupation/siege/intel skipped, same key = duplicate, LIVE_UNSUPPORTED", async () => {
    const env = C.createEnv(driver, { presence: observedPresence });
    try {
      const cfg = JSON.parse(JSON.stringify(env.cfg));
      cfg.siege.enabled = true;
      cfg.modules.strategy.enabled = true;
      cfg.sentries.enabled = true;
      cfg.sentries.battle = { enabled: true };
      const seen = [];
      const sentrySettled = [];
      env.battle.stop("test");
      const br = startBattle({ ...env.battleDeps, config: cfg,
        occupation: { consequence: spy("occupation", seen), getStatus: () => ({ state: "ready" }) },
        getSiege: () => ({ consequence: spy("siege", seen) }),
        getStrategy: () => ({ intelConsequence: spy("intel", seen) }),
        getSentries: () => ({ battleConsequence: { name: "sentries", apply(_tx, settled) {
          sentrySettled.push(settled);
          return { ok: true };
        } } }) });
      assert.ok(br.ok, JSON.stringify(br));
      env.battle = br.battle;
      const names = br.battle.getStatus().consequences;
      assert.ok(["occupation", "siege", "intel"].every((n) => names.includes(n)) && names[names.length - 1] === "sentries",
        JSON.stringify(names));

      const S = H.S;
      const fleetId = env.newFleet("fd", C.SANSHA, S.N5, [{ hullGroup: "cruiser", count: 10 }]);
      const at = env.clock.now();
      const spec = { systemId: S.N5, at, sideA: { factionId: C.SANSHA, fleets: [{ fleetId,
        expectedVersion: env.fleet(fleetId).version }] },
        fixedDefenses: { attackerRetreatLossPermille: 300, entries: [6, 5, 4, 3, 2, 1].map(sentry) },
        grid: { kind: "station", id: 60001001 } };
      const badKey = env.store.transaction("test.fd", (db) => env.battle.createFixedDefenseBattleInTx(db,
        { ...spec, gridKey: "station:60001001" }, KEY));
      assert.deepStrictEqual([badKey.value.ok, badKey.value.reason, badKey.value.permanent], [false, "INPUT_INVALID",
        true]);
      const create = () => {
        const r = env.store.transaction("test.fd", (db) => env.battle.createFixedDefenseBattleInTx(db, spec, KEY));
        assert.ok(r.ok, JSON.stringify(r));
        return r.value;
      };
      const first = create();
      assert.strictEqual(first.ok, true, JSON.stringify(first));
      assert.strictEqual(first.duplicate, false);
      const again = create();
      assert.deepStrictEqual(again, { ok: true, duplicate: true, battleId: first.battleId });
      const battleId = first.battleId;
      const rows = env.battles();
      assert.strictEqual(rows.length, 1);
      assert.deepStrictEqual([rows[0].state, rows[0].hold_reason, rows[0].objective, rows[0].environment],
        ["PENDING", "LIVE_UNSUPPORTED", "destroy", env.graph.getSystem(S.N5).secClass]);
      assert.deepStrictEqual([rows[0].grid_kind, rows[0].grid_id], ["station", 60001001]);
      assert.strictEqual(env.fleet(fleetId).state, "ENGAGED");
      assert.strictEqual(env.event(`battle:${battleId}:resolve:0`).due_at, at + cfg.battle.engageDelayMs);
      assert.deepStrictEqual(env.q("SELECT fleet_id, side FROM battle_participants WHERE battle_id = ?", battleId)
        .map((p) => [p.fleet_id, p.side]), [[fleetId, "A"]]);
      assert.strictEqual(env.telemetry.counts["battle.fixedDefenseCreated"], 1);

      await env.drive(at + cfg.battle.engageDelayMs);
      const done = env.battles()[0];
      assert.deepStrictEqual([done.state, done.mode], ["COMPLETED", "VIRTUAL"]);
      assert.strictEqual(JSON.parse(done.result_json).outcome, "B_WIN");
      assert.ok(!env.telemetry.counts["battle.resolution.held"], JSON.stringify(env.telemetry.counts));
      assert.ok(env.telemetry.counts["battle.resolution.unsupportedVirtual"] >= 1);
      assert.strictEqual(env.n("SELECT count(*) AS n FROM world_event_journal WHERE event_type = 'BATTLE_SETTLED' "
        + "AND aggregate_id = ?", battleId), 1);

      const fleet = env.fleet(fleetId);
      const lostRows = env.q("SELECT fleet_id, count FROM battle_losses WHERE battle_id = ?", battleId);
      const lost = lostRows.reduce((n, r) => n + r.count, 0);
      assert.ok(lostRows.every((r) => r.fleet_id === fleetId), JSON.stringify(lostRows));
      assert.strictEqual(fleet.shipCount, 10 - lost);
      assert.ok(["RETREATING", "REFITTING"].includes(fleet.state), fleet.state);

      assert.deepStrictEqual(seen, []);
      assert.strictEqual(env.telemetry.counts["battle.consequenceFixedDefenseSkipped"], 3);
      assert.strictEqual(sentrySettled.length, 1);
      const fd = sentrySettled[0].fixedDefenses;
      const outcome = JSON.parse(done.result_json).fixedDefenseOutcome;
      assert.deepStrictEqual(fd, [1, 2, 3, 4, 5, 6].map(sentry).map((e, i) => ({ sentryId: e.sentryId,
        itemId: e.itemId, hp: e.hp, ehp: e.ehp, damage: outcome[i].damage, destroyed: outcome[i].destroyed })));
      assert.ok(fd.some((e) => e.damage > 0), JSON.stringify(fd));
      assert.strictEqual(sentrySettled[0].winnerFactionId, null);
    } finally {
      env.close();
    }
  });
};
