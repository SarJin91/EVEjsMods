"use strict";

const assert = require("node:assert");

const { harness: H } = require("./invasions.test");
const S = require("../../lib/world/invasions/schema");
const R = require("../../lib/world/invasions/invasionRepository");
const { planConduit } = require("../../lib/world/invasions/conduit");
const { deriveSeed, createRng } = require("../../lib/util/rng");

const TRIG = 500026;
const HQ = 30002797;
const GARRISON = [{ hullGroup: "cruiser", count: 4 }, { hullGroup: "battleship", count: 2 }];
const BASE_ENV = Object.freeze({ EVEJS_LNE_INVASIONS_ENABLED: "true", EVEJS_LNE_INVASIONS_ROLL_INTERVAL_MS: "3600000",
  EVEJS_LNE_INVASIONS_CHANCE_PERMILLE: "0",
  EVEJS_LNE_INVASIONS_AVOID_CAMPAIGN_THEATRES: "false" });
const ON_ENV = Object.freeze({ ...BASE_ENV, EVEJS_LNE_INVADER_ECONOMY_ENABLED: "1",
  EVEJS_LNE_INVADER_ECONOMY_HOME_POOL_ENABLED: "1", EVEJS_LNE_INVADER_ECONOMY_CONDUIT_ENABLED: "1",
  EVEJS_LNE_INVADER_ECONOMY_TRIGLAVIAN_CONDUIT_CHANCE_PERMILLE: "1000" });

function fakeTreasury(state) {
  const row = (db, f) => db.prepare("SELECT balance, mode FROM test_treasury WHERE faction_id = ?").get(f);
  return {
    readMercAccountInDb(db, f) {
      const r = row(db, f);
      if (!r) return { ok: true, mode: "ready", seeded: false, balanceIsk: 0, accountMode: "NORMAL" };
      return { ok: true, mode: "ready", seeded: true,
        balanceIsk: state.readBalance === null ? Number(r.balance) : state.readBalance, accountMode: r.mode };
    },
    chargeWarSpendInTx(db, spec, key) {
      const r = row(db, spec.factionId);
      if (!r) return { ok: false, reason: "NO_TREASURY" };
      if (db.prepare("SELECT 1 AS x FROM test_treasury_keys WHERE k = ?").get(key)) {
        return { ok: true, duplicate: true, balanceIsk: Number(r.balance) };
      }
      if (Number(r.balance) < spec.isk) return { ok: false, reason: "TREASURY_INSUFFICIENT" };
      db.prepare("UPDATE test_treasury SET balance = balance - ? WHERE faction_id = ?").run(spec.isk, spec.factionId);
      db.prepare("INSERT INTO test_treasury_keys (k) VALUES (?)").run(key);
      return { ok: true, duplicate: false, balanceIsk: Number(r.balance) - spec.isk };
    },
  };
}

function setBalance(env, balance) {
  H.tx(env.storeResult, (db) => {
    db.exec(`CREATE TABLE IF NOT EXISTS test_treasury (faction_id INTEGER PRIMARY KEY, balance INTEGER, mode TEXT);
      CREATE TABLE IF NOT EXISTS test_treasury_keys (k TEXT PRIMARY KEY);`);
    db.prepare("INSERT OR REPLACE INTO test_treasury (faction_id, balance, mode) VALUES (?, ?, 'NORMAL')").run(TRIG,
      balance);
    return { ok: true };
  });
}
const balanceOf = (env) => H.tx(env.storeResult, (db) => Number(db.prepare(
  "SELECT balance FROM test_treasury WHERE faction_id = ?").get(TRIG).balance));
const charges = (env) => H.tx(env.storeResult, (db) => db.prepare("SELECT count(*) AS n FROM test_treasury_keys").get().n);

function poolFleets(env, n, tag) {
  const ids = [];
  for (let i = 0; i < n; i += 1) {
    const r = H.tx(env.storeResult, (db) => env.fleets.repository.createFleet(db, { factionId: TRIG,
      corporationId: env.strategy.registry.corporationFor(TRIG, "garrison"), currentSystemId: HQ, homeSystemId: HQ,
      fleetRole: "garrison", doctrineId: "triglavian-invader-v1", composition: GARRISON }, `test:pool:${tag}:${i}`));
    assert.ok(r.ok, JSON.stringify(r));
    ids.push(r.fleetId);
  }
  return ids;
}
const statesOf = (env, ids) => H.tx(env.storeResult, (db) => env.fleets.repository.getFleets(db, ids)).fleets
  .map((f) => f.state);

function toNextConduit(env) {
  const I = env.invasionsConfig.invasions.rollIntervalMs;
  const phi = deriveSeed(env.storeResult.worldSeed || 0, "invasions", "conduit-phase") % I;
  const round = Math.floor((env.clock.now() - phi) / I) + 1;
  env.clock.set(round * I + phi);
  return round;
}
const eventsOf = (env, type) => H.tx(env.storeResult, (db) => db.prepare(`SELECT idempotency_key AS k, state, outcome
  FROM world_scheduled_events WHERE event_type = ? ORDER BY due_at`).all(type));
const invasionOf = (env, id) => H.tx(env.storeResult, (db) => R.getInvasion(db, id)).invasion;
const stopAll = (env) => ["invasions", "occupation", "strategy", "battle", "scheduler"].forEach((k) => env[k].stop("test"));

async function passes(env, n = 6) {
  for (let i = 0; i < n; i += 1) await env.scheduler.runPass();
}

function boot(reopen, envVars, overrides = {}) {
  const env = H.bootFull(reopen(), H.configOf(envVars), overrides);
  H.seedK3Systems(env.repo, env.storeResult, "SEED_K3");
  return env;
}

function openConduits(env, rounds, systems) {
  rounds.forEach((round, i) => {
    const r = H.tx(env.storeResult, (db) => R.insertInvasionInTx(db, { invasionId: S.conduitInvasionId(round),
      idempotencyKey: S.spawnKey(S.conduitInvasionId(round)), rollRound: S.CONDUIT_ROUND_BASE + round,
      factionId: TRIG, profileId: "triglavian-conduit-v1", beachheadSystemId: systems[i], captureRangeJumps: 0,
      fleetIds: [], plan: { v: 1, conduit: true }, startedAt: env.clock.now(), withdrawAt: null }));
    assert.ok(r.ok, JSON.stringify(r));
  });
}

module.exports = ({ test, skip }) => {
  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  needsDriver("IC1 flag off: no conduit chain at bootstrap, a queued conduit roll ends DONE without a successor; the "
    + "main roll decision is the same with the conduit flag on", async () => {
    const decisions = [];
    for (const vars of [{ ...BASE_ENV, EVEJS_LNE_INVASIONS_CHANCE_PERMILLE: "1000" },
      { ...ON_ENV, EVEJS_LNE_INVASIONS_CHANCE_PERMILLE: "1000",
        EVEJS_LNE_INVADER_ECONOMY_TRIGLAVIAN_CONDUIT_CHANCE_PERMILLE: "0" }]) await H.withStore(driver, async (reopen) => {
      const env = boot(reopen, vars);
      const on = vars.EVEJS_LNE_INVADER_ECONOMY_CONDUIT_ENABLED === "1";
      assert.strictEqual(eventsOf(env, S.EVENT_TYPE_CONDUIT_ROLL).length, on ? 1 : 0, "conduit chain only with the flag");
      const I = env.invasionsConfig.invasions.rollIntervalMs;
      const phi = deriveSeed(env.storeResult.worldSeed || 0, "invasions", "phase") % I;
      env.clock.set((Math.floor((env.clock.now() - phi) / I) + 1) * I + phi);
      await passes(env);
      decisions.push(env.invasions.getStatus().lastDecision);
      if (!on) {
        assert.deepStrictEqual(Object.keys(env.invasions.getStatus()).sort(),
          ["counters", "lastDecision", "lastRefusal", "state"]);
        assert.ok(!Object.keys(env.invasions.getStatus().counters).some((k) => k.startsWith("conduit.")));
        const q = env.scheduler.enqueue(S.EVENT_TYPE_CONDUIT_ROLL, "conduit", env.clock.now(), { round: 5 },
          S.conduitRollKey(5));
        assert.ok(q.ok, JSON.stringify(q));
        await passes(env);
        assert.deepStrictEqual(eventsOf(env, S.EVENT_TYPE_CONDUIT_ROLL), [{ k: S.conduitRollKey(5), state: "DONE",
          outcome: "OFF" }], "DONE, no successor");
        assert.strictEqual(H.tx(env.storeResult, (db) => env.journal.findByKey(db, S.conduitRollKey(5))).found, false);
      }
      stopAll(env);
    });
    assert.strictEqual(decisions[0].outcome, "SPAWN");
    assert.deepStrictEqual(decisions[1], decisions[0], "main roll unchanged by the conduit flag");
  });

  needsDriver("IC3 conduit spawn: balance - cost, 3 pool fleets DISBANDED, package 5 + bonus 3 in the beachhead, row "
    + "inv-c-<round> with roll_round >= 1e9, plan.conduit, withdrawal 48 h, next conduit roll", () => H.withStore(driver,
    async (reopen) => {
      const state = { readBalance: null };
      const env = boot(reopen, ON_ENV, { getTreasury: () => fakeTreasury(state) });
      setBalance(env, 2.5e11);
      const pool = poolFleets(env, 3, "a");
      const round = toNextConduit(env);
      await passes(env);
      const st = env.invasions.getStatus();
      assert.strictEqual(st.lastConduitDecision.outcome, "SPAWN", JSON.stringify(st.lastConduitDecision));
      assert.deepStrictEqual([st.counters["conduit.rolls"], st.counters["conduit.spawned"]], [1, 1]);
      assert.deepStrictEqual([st.lastConduitDecision.bonusFleets, st.lastConduitDecision.iskCost], [3, 5e10]);
      assert.strictEqual(balanceOf(env), 2.5e11 - 5e10);
      assert.deepStrictEqual(statesOf(env, pool), ["DESTROYED", "DESTROYED", "DESTROYED"]);
      const row = invasionOf(env, S.conduitInvasionId(round));
      assert.ok(row && row.open === 1, "open conduit invasion");
      assert.strictEqual(row.roll_round, S.CONDUIT_ROUND_BASE + round);
      assert.strictEqual(row.idempotency_key, `invasion:inv-c-${round}:spawn`);
      assert.deepStrictEqual([JSON.parse(row.plan_json).conduit, JSON.parse(row.plan_json).bonusFleets], [true, 3]);
      assert.strictEqual(row.withdraw_at - row.started_at, 172800000);
      const fleetIds = JSON.parse(row.fleet_ids_json);
      assert.strictEqual(fleetIds.length, 8);
      const fl = H.tx(env.storeResult, (db) => env.fleets.repository.getFleets(db, fleetIds)).fleets;
      assert.ok(fl.every((f) => f.currentSystemId === row.beachhead_system_id && f.factionId === TRIG));
      assert.strictEqual(fl.filter((f) => f.fleetRole === "invasion").length, 2 + 3, "package 2 + bonus 3");
      assert.ok(eventsOf(env, S.EVENT_TYPE_CONDUIT_ROLL).some((e) => e.k === S.conduitRollKey(round + 1)
        && e.state === "QUEUED"), "next conduit roll queued");
      stopAll(env);
    }));

  needsDriver("IC4 replay of the round = no second charge; TREASURY_INSUFFICIENT -> spawnRefused, pool intact; refusal "
    + "after the charge and the DISBAND -> both rolled back, next roll chained", () => H.withStore(driver,
    async (reopen) => {
      const state = { readBalance: null, failOcc: false };
      const wrapOccupation = (or) => ({ ...or, signalInTx: (...a) => (state.failOcc
        ? { ok: false, reason: "TEST_REFUSED" } : or.signalInTx(...a)) });
      const env = boot(reopen, ON_ENV, { getTreasury: () => fakeTreasury(state), wrapOccupation });
      setBalance(env, 2.5e11);
      poolFleets(env, 3, "a");
      const round = toNextConduit(env);
      await passes(env);
      assert.strictEqual(env.invasions.getStatus().counters["conduit.spawned"], 1);
      assert.ok(env.scheduler.enqueue(S.EVENT_TYPE_CONDUIT_ROLL, "conduit", env.clock.now(), { round },
        "test:replay").ok);
      await passes(env);
      assert.deepStrictEqual([charges(env), balanceOf(env), env.invasions.getStatus().counters["conduit.spawned"]],
        [1, 2e11, 1]);
      setBalance(env, 1e9);
      state.readBalance = 1e12;
      const pool2 = poolFleets(env, 3, "b");
      const round2 = toNextConduit(env);
      await passes(env);
      let st = env.invasions.getStatus();
      assert.strictEqual(st.counters["conduit.spawnRefused"], 1, JSON.stringify(st.lastConduitDecision));
      assert.ok(/TREASURY_INSUFFICIENT/.test(st.lastRefusal), st.lastRefusal);
      assert.deepStrictEqual(statesOf(env, pool2), ["IDLE", "IDLE", "IDLE"]);
      assert.strictEqual(invasionOf(env, S.conduitInvasionId(round2)), null);
      setBalance(env, 2.5e11);
      state.readBalance = null;
      state.failOcc = true;
      const round3 = toNextConduit(env);
      await passes(env);
      st = env.invasions.getStatus();
      assert.strictEqual(st.lastConduitDecision.round, round3);
      assert.strictEqual(st.counters["conduit.spawnRefused"], 2);
      assert.deepStrictEqual([balanceOf(env), charges(env)], [2.5e11, 1], "charge rolled back");
      assert.deepStrictEqual(statesOf(env, pool2), ["IDLE", "IDLE", "IDLE"], "DISBAND rolled back");
      assert.strictEqual(invasionOf(env, S.conduitInvasionId(round3)), null);
      assert.strictEqual(H.tx(env.storeResult, (db) => env.journal.findByKey(db, S.conduitRollKey(round3))).found, true);
      assert.ok(eventsOf(env, S.EVENT_TYPE_CONDUIT_ROLL).some((e) => e.k === S.conduitRollKey(round3 + 1)));
      stopAll(env);
    }));

  needsDriver("IC5 two open inv-c- + a free global slot -> the main roll still SPAWNs (flag off: NO_ROOM); a third "
    + "conduit = NO_ROOM; the day cap = DAY_CAP", async () => {
    const outcomes = [];
    for (const vars of [BASE_ENV, ON_ENV]) await H.withStore(driver, async (reopen) => {
      const env = boot(reopen, { ...vars, EVEJS_LNE_INVASIONS_CHANCE_PERMILLE: "1000",
        EVEJS_LNE_INVASIONS_MAX_ACTIVE: "2", EVEJS_LNE_INVADER_ECONOMY_TRIGLAVIAN_CONDUIT_CHANCE_PERMILLE: "0" });
      openConduits(env, [11, 12], [30001867, 30001869]);
      const I = env.invasionsConfig.invasions.rollIntervalMs;
      const phi = deriveSeed(env.storeResult.worldSeed || 0, "invasions", "phase") % I;
      env.clock.set((Math.floor((env.clock.now() - phi) / I) + 1) * I + phi);
      await passes(env);
      outcomes.push(env.invasions.getStatus().lastDecision.outcome);
      stopAll(env);
    });
    assert.deepStrictEqual(outcomes, ["NO_ROOM", "SPAWN"], "conduits outside the main slots only with the flag");
    assert.strictEqual(S.CONDUIT_ID_PREFIX, "inv-c-");
    const C = { conduitChancePermille: 1000, conduitMaxActive: 2, conduitMaxSpawnsPerDay: 2, conduitIskPerSpawn: 2e10,
      conduitReserveIsk: 2e11, conduitPoolFleetsPerSpawn: 3, conduitBonusFleetsMax: 3, conduitIskPerBonusFleet: 1e10,
      target: { weightFree: 1, weightActive: 1, weightControlled: 1 } };
    const snap = { round: 3, factionId: TRIG, profileId: "triglavian-conduit-v1", captureRangeJumps: 1,
      packageFleets: 5, maxPackageFleets: 8, conduitOpen: 0, spawnedToday: 0, balanceIsk: 3e11, accountMode: "NORMAL",
      poolFleets: [{ fleetId: "p3" }, { fleetId: "p1" }, { fleetId: "p2" }], poolTruncated: false, stationsReady: true,
      sampled: [{ systemId: 9, row: { occupationState: "STABLE", controllerFactionId: null }, category: "free" }] };
    const rng = () => createRng(deriveSeed(1, "invasions", "conduit", 3));
    const spawn = planConduit(snap, C, rng());
    assert.deepStrictEqual([spawn.outcome, spawn.targetSystemId, spawn.poolFleetIds, spawn.bonusFleets],
      ["SPAWN", 9, ["p1", "p2", "p3"], 3]);
    assert.strictEqual(planConduit({ ...snap, conduitOpen: 2 }, C, rng()).outcome, "NO_ROOM");
    assert.strictEqual(planConduit({ ...snap, spawnedToday: 2 }, C, rng()).outcome, "DAY_CAP");
    assert.strictEqual(planConduit({ ...snap, accountMode: "AUSTERITY" }, C, rng()).outcome, "NO_SURPLUS");
    assert.strictEqual(planConduit({ ...snap, poolFleets: [{ fleetId: "p1" }] }, C, rng()).outcome, "NO_POOL");
    const sovC = { ...C, target: { ...C.target, requireSovCheck: true } };
    const unknown = { ...snap, sampled: [{ ...snap.sampled[0], claimed: null }] };
    assert.strictEqual(planConduit(unknown, sovC, rng()).outcome, "NO_TARGET", "claimed null skipped");
    const known = { ...snap, sampled: [{ ...snap.sampled[0], claimed: false }] };
    assert.strictEqual(planConduit(known, sovC, rng()).outcome, "SPAWN", "claimed false kept");
  });

  needsDriver("IC6: strategy.hqGarrisonEnabled=1 -> the conduit DISBANDs 3 of 4 pool fleets, the strongest (the "
    + "HQ holder of markHqHolders) stays IDLE, with the smallest and with the largest fleetId; 3 pool fleets "
    + "-> NO_POOL, all IDLE", async () => {
    const vars = { ...ON_ENV, EVEJS_LNE_STRATEGY_HQ_GARRISON_ENABLED: "1" };
    const strongFleet = (env, tag) => {
      const r = H.tx(env.storeResult, (db) => env.fleets.repository.createFleet(db, { factionId: TRIG,
        corporationId: env.strategy.registry.corporationFor(TRIG, "garrison"), currentSystemId: HQ, homeSystemId: HQ,
        fleetRole: "garrison", doctrineId: "triglavian-invader-v1",
        composition: [{ hullGroup: "cruiser", count: 4 }, { hullGroup: "battleship", count: 4 }] }, tag));
      assert.ok(r.ok, JSON.stringify(r));
      return r;
    };
    for (const strongFirst of [true, false]) {
      await H.withStore(driver, async (reopen) => {
        const env = boot(reopen, vars, { getTreasury: () => fakeTreasury({ readBalance: null }) });
        setBalance(env, 2.5e11);
        const before = strongFirst ? strongFleet(env, "test:pool:strong") : null;
        const pool = poolFleets(env, 3, "a");
        const strong = before || strongFleet(env, "test:pool:strong");
        assert.ok(pool.every((id) => (strongFirst ? strong.fleetId < id : strong.fleetId > id)),
          JSON.stringify([strong.fleetId, pool]));
        toNextConduit(env);
        await passes(env);
        const st = env.invasions.getStatus();
        assert.strictEqual(st.lastConduitDecision.outcome, "SPAWN", JSON.stringify(st.lastConduitDecision));
        const byId = new Map(H.tx(env.storeResult, (db) => env.fleets.repository
          .getFleets(db, [...pool, strong.fleetId])).fleets.map((f) => [f.fleetId, f.state]));
        assert.deepStrictEqual([...pool, strong.fleetId].map((id) => byId.get(id)),
          ["DESTROYED", "DESTROYED", "DESTROYED", "IDLE"], `strongFirst=${strongFirst}`);
        stopAll(env);
      });
    }
    await H.withStore(driver, async (reopen) => {
      const env = boot(reopen, vars, { getTreasury: () => fakeTreasury({ readBalance: null }) });
      setBalance(env, 2.5e11);
      const pool = poolFleets(env, 3, "a");
      toNextConduit(env);
      await passes(env);
      assert.strictEqual(env.invasions.getStatus().lastConduitDecision.outcome, "NO_POOL");
      assert.deepStrictEqual(statesOf(env, pool), ["IDLE", "IDLE", "IDLE"]);
      stopAll(env);
    });
  });
};
