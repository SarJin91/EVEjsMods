"use strict";

const assert = require("node:assert");
const path = require("node:path");

const config = require("../../../config");
const { LATEST_SCHEMA_VERSION } = require("../../../lib/persistence/migrations");
const { TABLE_POLICY, ACTION } = require("../../../lib/persistence/worldReset");
const { createClaimRepository } = require("../../../lib/strategy/capsuleers/claimRepository");
const CS = require("../../../lib/strategy/capsuleers/schema");
const D = require("../../../lib/strategy/data/capsuleers");
const { harness: H } = require("../../battle/settlement.test");
const { harness: R } = require("./ratting.service.test");

const MOD_DIR = path.resolve(__dirname, "..", "..", "..");
const S = H.S;
const WALLET = 1000000000;

function boot(opened, shared, capsuleers, controllers, opts) {
  const env = R.boot(opened, shared, R.testConfig({ claimsEnabled: true, ...capsuleers }), opts);
  env.controllers.clear();
  for (const [id, f] of controllers) env.controllers.set(id, f);
  env.claimRepo = createClaimRepository();
  env.claims = () => env.q("SELECT corp_slot, system_id, state, lost_reason FROM world_capsuleer_claims "
    + "ORDER BY claim_id").map((c) => [c.corp_slot, c.system_id, c.state, c.lost_reason]);
  env.trips = () => env.q("SELECT * FROM world_capsuleer_trips ORDER BY created_at, trip_id");
  env.review = () => {
    const P = env.cfg.capsuleers.reviewPeriodMs;
    return env.drive((Math.floor(shared.clock.now() / P) + 1) * P);
  };
  env.replayReview = (round) => {
    const row = env.q("SELECT * FROM world_scheduled_events WHERE idempotency_key = ?", CS.reviewKey(round))[0];
    const ev = { eventId: row.event_id, eventType: row.event_type, aggregateId: row.aggregate_id, dueAt: row.due_at,
      payload: JSON.parse(row.payload), idempotencyKey: row.idempotency_key, attempts: 0 };
    const res = env.handlers[CS.REVIEW_EVENT](ev, {});
    assert.ok(res.ok, JSON.stringify(res));
    const v = env.tx((db) => res.effect(db, ev));
    res.onCommitted(v);
    return v;
  };
  return env;
}

module.exports = ({ test, skip }) => {
  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  needsDriver("CL2 claims: review -> HELD, replayed round writes nothing, two corps one system -> one HELD "
    + "(CLAIM_TAKEN + partial UNIQUE), controller -> LOST CONTROLLER, fleets destroyed -> LOST NO_FLEET", async () => {
    await H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const opened = reopen();
      const env = boot(opened, shared, { maxCorps: 2, maxClaimsPerReview: 2, rattingEnabled: false },
        [[S.N0, null]]);
      try {
        R.seed(opened, shared, [1, 2], WALLET);
        await R.newFleet(env, "caps1", R.CAPS, S.L1, "capsuleer", 98000001);
        await R.newFleet(env, "caps2", R.CAPS, S.L2, "capsuleer", 98000002);
        assert.deepStrictEqual(env.started, { ok: true }, env.lines.join("\n"));
        await env.review();
        const round = env.ctx.capsuleers.getStatus().lastRound;
        const journalRows = () => env.n("SELECT count(*) AS n FROM world_event_journal WHERE idempotency_key LIKE ?",
          "capsuleers:review:%:claim");
        assert.deepStrictEqual([env.claims(), env.counters().claimsCreated, journalRows()],
          [[[1, S.N0, "HELD", null]], 1, 1]);
        env.replayReview(round);
        const at = shared.clock.now();
        const taken = env.tx((db) => env.claimRepo.createClaimInDb(db, { claimId: "cl:2:x", slot: 2, systemId: S.N0,
          at }));
        const raw = env.store.transaction("test", (db) => db.prepare("INSERT INTO world_capsuleer_claims (claim_id, "
          + "corp_slot, system_id, state, claimed_at, created_at, updated_at, version) VALUES ('cl:2:y', 2, ?, 'HELD', "
          + "?, ?, ?, 1)").run(S.N0, at, at, at));
        const unique = raw.ok ? null : String((raw.error && raw.error.code) || raw.code);
        assert.deepStrictEqual([env.claims(), journalRows(), taken.ok, taken.reason, unique],
          [[[1, S.N0, "HELD", null]], 1, false, "CLAIM_TAKEN", "SQLITE_CONSTRAINT_UNIQUE"]);
        env.controllers.set(S.N0, R.SANSHA);
        await env.review();
        assert.deepStrictEqual([env.claims(), env.counters().claimsLost, env.counters().claimsLostController],
          [[[1, S.N0, "LOST", "CONTROLLER"]], 1, 1]);
        const row = env.q("SELECT claim_id, version, lost_at FROM world_capsuleer_claims")[0];
        const lostAt = row.lost_at;
        const again = env.tx((db) => env.claimRepo.loseClaimInDb(db, { claimId: row.claim_id,
          expectedVersion: row.version, reason: "NO_FLEET", at: shared.clock.now() }));
        assert.deepStrictEqual([again.ok, again.reason], [false, "STATE_CHANGED"]);
        assert.deepStrictEqual(env.ctx.views.getView("capsuleers").getData().claims,
          [{ slot: 1, system: S.N0, state: "LOST (CONTROLLER)", since: lostAt }]);
      } finally {
        env.stop();
      }
    });

    await H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const opened = reopen();
      const env = boot(opened, shared, { rattingEnabled: false }, [[S.N0, null]]);
      try {
        R.seed(opened, shared, [1], WALLET);
        const fleetId = await R.newFleet(env, "caps1", R.CAPS, S.L1, "capsuleer", 98000001);
        await env.review();
        assert.deepStrictEqual(env.claims(), [[1, S.N0, "HELD", null]]);
        const version = env.fleet(fleetId).version;
        const d = env.tx((db) => env.fleets.repository.disband(db, { fleetId, expectedVersion: version,
          systemId: S.L1, fleetRole: "capsuleer" }, "test:cl2:disband"));
        assert.ok(d.ok, JSON.stringify(d));
        await env.review();
        assert.deepStrictEqual([env.claims(), env.counters().claimsLostNoFleet],
          [[[1, S.N0, "LOST", "NO_FLEET"]], 1]);
      } finally {
        env.stop();
      }
    });

    await H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const opened = reopen();
      const env = boot(opened, shared, {}, []);
      try {
        R.seed(opened, shared, [1], WALLET);
        await R.newFleet(env, "caps1", R.CAPS, S.L1, "capsuleer", 98000001);
        const c = env.tx((db) => env.claimRepo.createClaimInDb(db, { claimId: "cl:1:n5:0", slot: 1, systemId: S.N5,
          at: shared.clock.now() }));
        assert.ok(c.ok, JSON.stringify(c));
        await env.review();
        assert.deepStrictEqual([env.claims(), env.trips().length], [[[1, S.N5, "LOST", "NO_ROW"]], 0]);
      } finally {
        env.stop();
      }
    });
  });

  needsDriver("CL3 ratting in a claim: rat trip to the held claim, RAT pays k x floor(perKill x 500 / 1000) "
    + "without onNpcKill, the claim lost before the next step -> RETURN CONTROL_LOST", async () => {
    await H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const opened = reopen();
      const env = boot(opened, shared, {}, [[S.N0, null]]);
      const C = env.cfg.capsuleers;
      try {
        R.seed(opened, shared, [1], WALLET);
        const fleetId = await R.newFleet(env, "caps1", R.CAPS, S.L1, "capsuleer", 98000001);
        await env.review();
        assert.deepStrictEqual([env.claims(), env.trips().length], [[[1, S.N0, "HELD", null]], 0]);
        await env.review();
        let trip = env.trip();
        assert.deepStrictEqual([env.trips().length, trip.kind, trip.state, trip.target_system_id],
          [1, "rat", "OUTBOUND", S.N0]);
        const ta = env.fleet(fleetId).next_action_at;
        await env.drive(ta);
        trip = env.trip();
        assert.deepStrictEqual([trip.state, trip.ratting_started_at], ["RATTING", ta]);
        await env.drive(ta + C.rattingStepMs);
        const per = Math.floor(C.rattingBountyIskPerKill * C.claimBountyPermille / 1000);
        const k = C.rattingKillsPerStep;
        trip = env.trip();
        assert.deepStrictEqual([env.corp().isk_balance, trip.kills, trip.isk_earned, env.kills.length,
          env.counters().claimRatSteps, env.counters().steps, env.counters().kills],
        [WALLET + k * per, k, k * per, 0, 1, 1, 0]);
        const wallet = env.q("SELECT payload FROM world_event_journal WHERE idempotency_key LIKE ?",
          "capsuleers:trip:%:wallet").map((r) => JSON.parse(r.payload).kind);
        assert.deepStrictEqual(wallet, ["claimBounty"]);
        env.tx((db) => db.prepare("UPDATE world_capsuleer_claims SET state = 'LOST', lost_at = ?, "
          + "lost_reason = 'NO_FLEET', version = version + 1").run(shared.clock.now()));
        const nextKey = CS.stepKey(trip.trip_id, trip.phase_seq, trip.watch_round);
        shared.clock.set(env.q("SELECT due_at FROM world_scheduled_events WHERE idempotency_key = ?", nextKey)[0].due_at);
        const lost = R.redeliver(env, nextKey);
        assert.deepStrictEqual([lost.v.action, lost.v.reason], ["RETURN", "CONTROL_LOST"], JSON.stringify(lost));
        trip = env.trip();
        assert.deepStrictEqual([trip.state, trip.abort_reason, env.corp().isk_balance, env.kills.length,
          env.counters().abortControlLost], ["RETURNING", "CONTROL_LOST", WALLET + k * per, 0, 1]);
      } finally {
        env.stop();
      }
    });
  });

  needsDriver("CL4 claimsEnabled=false: no claim, rat target as without claims, HELD frozen; migration 45, TABLE_POLICY "
    + "SCHEMA rows, claimMaxJumps warning", async () => {
    await H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const opened = reopen();
      const env = boot(opened, shared, { claimsEnabled: false }, [[S.N0, R.SANSHA], [S.N5, null]]);
      try {
        R.seed(opened, shared, [1], WALLET);
        await R.newFleet(env, "caps1", R.CAPS, S.L1, "capsuleer", 98000001);
        await env.review();
        assert.deepStrictEqual([env.claims(), env.trips().map((t) => [t.kind, t.target_system_id]),
          env.counters().claimsCreated], [[], [["rat", S.N0]], 0]);
      } finally {
        env.stop();
      }
    });

    await H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const opened = reopen();
      const env = boot(opened, shared, { claimsEnabled: false }, [[S.N0, null]]);
      try {
        R.seed(opened, shared, [1], WALLET);
        await R.newFleet(env, "caps1", R.CAPS, S.L1, "capsuleer", 98000001);
        for (const [claimId, systemId] of [["cl:1:held:0", S.N0], ["cl:1:held:1", S.N5]]) {
          const c = env.tx((db) => env.claimRepo.createClaimInDb(db, { claimId, slot: 1, systemId,
            at: shared.clock.now() }));
          assert.ok(c.ok, JSON.stringify(c));
        }
        await env.review();
        assert.deepStrictEqual([env.claims(), env.trips().length],
          [[[1, S.N0, "HELD", null], [1, S.N5, "HELD", null]], 0]);
        const cols = env.q("PRAGMA table_info(world_capsuleer_claims)").map((x) => x.name);
        const idx = env.q("PRAGMA index_list(world_capsuleer_claims)").map((x) => x.name).filter((n) => !n
          .startsWith("sqlite_")).sort();
        assert.deepStrictEqual([LATEST_SCHEMA_VERSION >= 45, cols.length, idx, TABLE_POLICY.world_capsuleer_claims],
          [true, 10, ["world_capsuleer_claims_corp", "world_capsuleer_claims_held", "world_capsuleer_claims_lost"],
            ACTION.WIPE]);
      } finally {
        env.stop();
      }
    });

    const rows = new Map(config.SCHEMA.map((r) => [r.key, r]));
    const spec = (k) => {
      const r = rows.get(`capsuleers.${k}`);
      return r ? [r.default, r.min === undefined ? null : r.min, r.max === undefined ? null : r.max] : null;
    };
    assert.deepStrictEqual(["claimsEnabled", "maxClaimsPerCorp", "maxClaimsPerReview", "claimMaxJumps",
      "claimScanMaxSystems", "claimBountyPermille"].map(spec),
    [[false, null, null], [2, 0, 8], [1, 0, 4], [3, 1, 10], [200, 10, 5000], [500, 0, 1000]]);
    const warned = (env) => config.resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_CAPSULEERS_ENABLED: "true",
      EVEJS_LNE_CAPSULEERS_CLAIMS_ENABLED: "true", ...env } }).warnings
      .some((w) => w.startsWith("capsuleers.claimMaxJumps="));
    assert.deepStrictEqual([warned({ EVEJS_LNE_CAPSULEERS_CLAIM_MAX_JUMPS: "6" }), warned({}),
      warned({ EVEJS_LNE_CAPSULEERS_CLAIM_MAX_JUMPS: "6", EVEJS_LNE_CAPSULEERS_CLAIMS_ENABLED: "false" })],
    [true, false, false]);
  });

  needsDriver("CL5 SWEEP claims: replay with a second free candidate settles (M27), claim of another slot "
    + "flag off -> CONTROL_LOST, hostile claim no target, LOST pruned, no graph no NO_FLEET, claimRefused, lowered "
    + "maxClaimsPerCorp checks every HELD, cut fleet-range search no false NO_FLEET", async () => {
    const got = {};
    const scene = async (capsuleers, controllers, fn, opts) => {
      await H.withStore(driver, async (reopen) => {
        const shared = H.sharedOf();
        const opened = reopen();
        const env = boot(opened, shared, capsuleers, controllers, opts);
        try {
          R.seed(opened, shared, [1], WALLET);
          const fleetId = await R.newFleet(env, "caps1", R.CAPS, S.L1, "capsuleer", 98000001);
          await fn(env, shared, fleetId);
        } finally {
          env.stop();
        }
      });
    };
    const claimAt = (env, shared, claimId, systemId) => {
      const c = env.tx((db) => env.claimRepo.createClaimInDb(db, { claimId, slot: 1, systemId,
        at: shared.clock.now() }));
      assert.ok(c.ok, JSON.stringify(c));
    };
    const journalRows = (env) => env.n("SELECT count(*) AS n FROM world_event_journal WHERE idempotency_key LIKE ?",
      "capsuleers:review:%:claim");

    await scene({ maxClaimsPerCorp: 2, maxClaimsPerReview: 1, rattingEnabled: false }, [[S.N0, null], [S.N5, null]],
      async (env) => {
        await env.review();
        const v = env.replayReview(env.ctx.capsuleers.getStatus().lastRound);
        got.replay = [v.ok, env.claims(), journalRows(env)];
      });

    const ratIn = (change) => async (env, shared, fleetId) => {
      await env.review();
      await env.review();
      await env.drive(env.fleet(fleetId).next_action_at);
      const trip = env.trip();
      assert.deepStrictEqual([trip.kind, trip.state, trip.target_system_id], ["rat", "RATTING", S.N0]);
      change(env);
      const key = CS.stepKey(trip.trip_id, trip.phase_seq, trip.watch_round);
      shared.clock.set(env.q("SELECT due_at FROM world_scheduled_events WHERE idempotency_key = ?", key)[0].due_at);
      const r = R.redeliver(env, key);
      return [r.v.action, r.v.reason || null, env.corp().isk_balance > WALLET];
    };
    for (const [name, change] of [["control", () => {}],
      ["otherSlot", (env) => env.tx((db) => db.prepare("UPDATE world_capsuleer_claims SET corp_slot = 2").run())],
      ["flagOff", (env) => { env.cfg.capsuleers.claimsEnabled = false; }]]) {
      await scene({}, [[S.N0, null]], async (env, shared, fleetId) => {
        got[name] = await ratIn(change)(env, shared, fleetId);
      });
    }

    await scene({}, [[S.N0, null]], async (env, shared) => {
      await R.newFleet(env, "patrol", R.SANSHA, S.N0, "patrol");
      claimAt(env, shared, "cl:1:n0:0", S.N0);
      await env.review();
      got.hostile = [env.claims(), env.trips().length];
    });

    await scene({ tripRetentionMs: 1000, rattingEnabled: false }, [[S.N0, null]], async (env, shared) => {
      claimAt(env, shared, "cl:1:old:0", S.N5);
      const l = env.tx((db) => env.claimRepo.loseClaimInDb(db, { claimId: "cl:1:old:0", expectedVersion: 1,
        reason: "NO_ROW", at: shared.clock.now() }));
      assert.ok(l.ok, JSON.stringify(l));
      await env.review();
      got.pruned = env.claims();
    });

    await scene({ rattingEnabled: false }, [[S.N0, null]], async (env, shared) => {
      claimAt(env, shared, "cl:1:n0:0", S.N0);
      await env.review();
      got.noGraph = [env.claims(), env.counters().claimsLost];
    }, { ctx: { graph: { getGraph: () => null } } });

    await scene({ rattingEnabled: false }, [[S.N0, null]], async (env, shared) => {
      const P = env.cfg.capsuleers.reviewPeriodMs;
      const round = Math.floor(shared.clock.now() / P) + 1;
      const ev = { eventId: "test-cl5", eventType: CS.REVIEW_EVENT, aggregateId: CS.REVIEW_AGGREGATE_ID,
        dueAt: shared.clock.now(), payload: { round }, idempotencyKey: CS.reviewKey(round), attempts: 0 };
      const res = env.handlers[CS.REVIEW_EVENT](ev, {});
      assert.ok(res.ok, JSON.stringify(res));
      const t = env.tx((db) => env.claimRepo.createClaimInDb(db, { claimId: "cl:2:race", slot: 2, systemId: S.N0,
        at: shared.clock.now() }));
      assert.ok(t.ok, JSON.stringify(t));
      res.onCommitted(env.tx((db) => res.effect(db, ev)));
      got.refused = [env.counters().claimRefused, env.counters().claimsCreated, env.claims()];
    });

    await scene({ maxClaimsPerCorp: 0, rattingEnabled: false }, [], async (env, shared) => {
      for (let i = 0; i <= D.MAX_SLOTS; i += 1) claimAt(env, shared, `cl:1:x:${String(i).padStart(2, "0")}`, 31000000 + i);
      await env.review();
      got.lowered = [env.claims().filter((c) => c[2] === "HELD").length, env.counters().claimsLost];
    });
    const maxRow = config.SCHEMA.find((r) => r.key === "capsuleers.maxClaimsPerCorp");

    await scene({ claimScanMaxSystems: 2, rattingEnabled: false }, [[S.N0, null]], async (env, shared, fleetId) => {
      await env.review();
      await env.review();
      const held = env.claims();
      const version = env.fleet(fleetId).version;
      const d = env.tx((db) => env.fleets.repository.disband(db, { fleetId, expectedVersion: version,
        systemId: S.L1, fleetRole: "capsuleer" }, "test:cl5:disband"));
      assert.ok(d.ok, JSON.stringify(d));
      await env.review();
      got.cut = [held, env.claims(), env.counters().claimsLostNoFleet];
    });

    assert.deepStrictEqual(got, {
      replay: [true, [[1, S.N0, "HELD", null]], 1],
      control: ["RAT", null, true],
      otherSlot: ["RETURN", "CONTROL_LOST", false],
      flagOff: ["RETURN", "CONTROL_LOST", false],
      hostile: [[[1, S.N0, "HELD", null]], 0],
      pruned: [[1, S.N0, "HELD", null]],
      noGraph: [[[1, S.N0, "HELD", null]], 0],
      refused: [1, 0, [[2, S.N0, "HELD", null]]],
      lowered: [0, D.MAX_SLOTS + 1],
      cut: [[[1, S.N0, "HELD", null]], [[1, S.N0, "LOST", "NO_FLEET"]], 1],
    });
    assert.strictEqual(D.MAX_CLAIMS_PER_CORP, maxRow.max);
  });
};
