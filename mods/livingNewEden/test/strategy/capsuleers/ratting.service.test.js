"use strict";

const assert = require("node:assert");
const path = require("node:path");

const config = require("../../../config");
const { createJournal } = require("../../../lib/persistence/journal");
const { createViewRegistry } = require("../../../lib/observer/views");
const { startScheduler } = require("../../../lib/scheduler");
const { startFleets } = require("../../../lib/fleets");
const { buildDefaultServiceDefs } = require("../../../lib/runtime/services");
const { createUnavailableCapsuleers } = require("../../../lib/strategy/capsuleers");
const { createCorpRepository } = require("../../../lib/strategy/capsuleers/corpRepository");
const { createTripRepository } = require("../../../lib/strategy/capsuleers/tripRepository");
const { stepKills } = require("../../../lib/strategy/capsuleers/rattingRules");
const { ratStepDueAt, ratLastAtOf } = require("../../../lib/strategy/capsuleers/tripMachine");
const CS = require("../../../lib/strategy/capsuleers/schema");
const { harness: H } = require("../../battle/settlement.test");

const MOD_DIR = path.resolve(__dirname, "..", "..", "..");
const SANSHA = 500019;
const AMARR = 500003;
const CAPS = 500018;
const S = H.S;
const STATION = 60000100;
const MEMBERS = Object.freeze([90000001, 90000002, 90000003]);
const BASES = Object.freeze([S.L1, S.L2, S.H1, S.N9]);

function testConfig(capsuleers) {
  const cfg = JSON.parse(JSON.stringify(config.resolveConfig({ modDir: MOD_DIR, env: {} }).config));
  if (capsuleers) {
    Object.assign(cfg.capsuleers, { enabled: true, maxCorps: 1, maxFoundingsPerReview: 0, maxFleetBuysPerReview: 0,
      stipendIskPerReview: 0 }, capsuleers);
  }
  cfg.limits.maxVirtualFleets = 16;
  return cfg;
}

function boot(opened, shared, cfg, opts = {}) {
  const lines = [];
  const logger = { log: (l) => lines.push(l) };
  const store = opened.store;
  const journal = createJournal({ clock: shared.clock, maxPayloadBytes: cfg.persistence.journalMaxPayloadBytes,
    maxRows: 500 });
  const persistence = { ok: true, store, journal, worldSeed: opened.worldSeed, filePath: "test.sqlite" };
  const sr = startScheduler({ config: cfg, persistence: { ok: true, store }, clock: shared.clock, ids: shared.ids,
    logger, nowMs: () => 0 });
  assert.ok(sr.ok, JSON.stringify(sr));
  const graph = { getGraph: () => ({ ok: true, graph: shared.graph }) };
  const fr = startFleets({ config: cfg, persistence, clock: shared.clock, ids: shared.ids, scheduler: sr.scheduler,
    graph, presence: null, views: createViewRegistry(), logger });
  assert.ok(fr.ok, JSON.stringify(fr));
  const handlers = {};
  const scheduler = { ...sr.scheduler, registerHandler: (type, fn, o) => {
    handlers[type] = fn;
    return sr.scheduler.registerHandler(type, fn, o);
  } };
  const tx = (fn) => {
    const r = store.transaction("test", fn);
    assert.ok(r.ok, JSON.stringify(r));
    return r.value;
  };
  const env = { store, tx, lines, handlers, shared, cfg, fleets: fr.fleets, journal, kills: [],
    controllers: new Map([[S.N0, SANSHA]]) };
  env.q = (sql, ...args) => tx((db) => db.prepare(sql).all(...args));
  env.n = (sql, ...args) => env.q(sql, ...args)[0].n;
  const virtualCorps = { getOwnerIdentity: () => ({ ok: true, state: "PENDING" }),
    ensureOwnerIdentity: () => ({ ok: true, queued: true }), getMapVersion: () => 1 };
  const kinds = new Map([[AMARR, "empire"], [SANSHA, "pirate"]]);
  const strategy = { registry: { listActiveFactions: () => [...kinds].map(([factionId, kind]) => ({ factionId, kind })),
    getFaction: (id) => (kinds.has(id) ? { factionId: id, kind: kinds.get(id) } : null),
    isActive: (id) => kinds.has(id) }, getStatus: () => ({ state: "running" }) };
  const world = { repository: { limits: { maxBatchReadIds: 2 },
    listControlledByFaction: (db, factionId) => ({ ok: true, nextAfterSystemId: null, systems: [...env.controllers]
      .filter(([, f]) => f === factionId).map(([systemId]) => ({ systemId })) }),
    getSystems: (db, ids) => {
      assert.strictEqual(db.inTransaction, true);
      assert.ok(ids.length <= 2, "chunked by maxBatchReadIds");
      return { ok: true, systems: ids.filter((id) => env.controllers.has(id)).map((id) => ({ systemId: id,
        controllerFactionId: env.controllers.get(id) })), missing: ids.filter((id) => !env.controllers.has(id)) };
    } } };
  const adapter = { listNpcStationsInSystem: (systemId) => ({ ok: true, stations: systemId === S.L1
    ? [{ stationId: STATION, corporationId: null, name: "Base" }] : [] }) };
  const seen = new Set();
  const liberation = { onNpcKill: (k) => {
    env.kills.push({ ...k, inTx: store.isInTransaction() });
    const key = `${k.systemId}:${k.characterId}:${k.victimFactionId}:${k.atMs}:${k.victimId}`;
    const dup = seen.has(key);
    seen.add(key);
    return { ok: true, outcome: dup ? "DUPLICATE" : "APPLIED" };
  } };
  const ctx = { config: cfg, persistence, scheduler, fleets: fr.fleets, strategy, virtualCorps, graph, world,
    adapter, views: createViewRegistry(), clock: shared.clock, ids: shared.ids, telemetry: null,
    liberation: opts.noLiberation ? null : liberation, ...(opts.ctx || {}) };
  const def = buildDefaultServiceDefs({}).find((d) => d.name === "capsuleers");
  env.started = def.start(ctx, { logger });
  if (!env.started.ok) def.onUnavailable(ctx, env.started.reason);
  env.ctx = ctx;
  env.stop = () => {
    if (ctx.capsuleers) ctx.capsuleers.stop("test");
    fr.fleets.stop("test");
    sr.scheduler.stop("test");
  };
  env.drive = async (untilMs) => {
    for (let i = 0; i < 20000; i += 1) {
      const r = await sr.scheduler.runPass();
      assert.ok(r.ok, JSON.stringify(r));
      const now = shared.clock.now();
      if (!r.skipped && r.jobs > 0) continue;
      if (now >= untilMs) return;
      const next = sr.scheduler.getStatus().nextDueAt;
      shared.clock.set(Math.min(untilMs, next === null || next <= now ? now + cfg.scheduler.intervalMs : next));
    }
    throw new Error("drive: no end");
  };
  env.trip = () => env.q("SELECT * FROM world_capsuleer_trips ORDER BY created_at, trip_id").slice(-1)[0];
  env.fleet = (id) => env.q("SELECT * FROM virtual_fleets WHERE fleet_id = ?", id)[0];
  env.op = (id) => env.q("SELECT * FROM world_operations WHERE operation_id = ?", id)[0];
  env.corp = (slot = 1) => env.q("SELECT * FROM world_capsuleer_corps WHERE corp_slot = ?", slot)[0];
  env.counters = () => env.ctx.capsuleers.getStatus().counters;
  return env;
}

function seed(opened, shared, slots, wallet) {
  const corps = createCorpRepository();
  const run = (fn) => {
    const r = opened.store.transaction("seed", fn);
    assert.ok(r.ok && (!r.value || r.value.ok !== false), JSON.stringify(r));
    return r.value;
  };
  for (const slot of slots) {
    run((db) => {
      const c = corps.createCorp(db, { slot, factionId: CAPS, name: `Corp ${slot}`, ticker: `CP${slot}`,
        baseSystemId: BASES[slot - 1], baseStationId: STATION + slot, baseStationCorpId: null, raceFactionId: 500001,
        iskBalance: wallet, seed: 11 + slot, at: shared.clock.now() });
      if (!c.ok) return c;
      return corps.activate(db, { slot, expectedVersion: 1, corporationId: 98000000 + slot,
        ceoCharacterId: MEMBERS[0], memberIds: slot === 1 ? MEMBERS.slice() : [], name: `Corp ${slot}`,
        ticker: `CP${slot}`, at: shared.clock.now() });
    });
  }
}

async function newFleet(env, tag, factionId, systemId, fleetRole, corporationId) {
  const r = env.fleets.createFleet({ factionId, currentSystemId: systemId, homeSystemId: systemId, fleetRole,
    ...(corporationId ? { corporationId } : {}), composition: [{ hullGroup: "cruiser", count: 2 }] }, `test:${tag}`);
  assert.ok(r.ok, JSON.stringify(r));
  return r.fleetId;
}

function redeliver(env, key) {
  const row = env.q("SELECT * FROM world_scheduled_events WHERE idempotency_key = ?", key)[0];
  const ev = { eventId: row.event_id, eventType: row.event_type, aggregateId: row.aggregate_id, dueAt: row.due_at,
    payload: JSON.parse(row.payload), idempotencyKey: row.idempotency_key, attempts: 0 };
  const res = env.handlers[CS.STEP_EVENT](ev, {});
  assert.ok(res.ok, JSON.stringify(res));
  const v = env.tx((db) => res.effect(db, ev));
  res.onCommitted(v);
  return { state: row.state, v };
}

module.exports = ({ test, skip }) => {
  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  needsDriver("T2 ratting trip: dispatch -> RATTING -> kills after commit + bounty, redelivered step STALE "
    + "without a second report, SHIFT_END -> RETURNING (return op) -> DOCKED, bounty cut at maxIskBalance",
  async () => {
    await H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const opened = reopen();
      const wallet = 1000000000;
      const probe = testConfig({}).capsuleers;
      const bounty = probe.rattingBountyIskPerKill;
      const env = boot(opened, shared, testConfig({ maxIskBalance: wallet + 7 * bounty + 1 }));
      const C = env.cfg.capsuleers;
      try {
        seed(opened, shared, [1], wallet);
        const fleetId = await newFleet(env, "caps", CAPS, S.L1, "capsuleer", 98000001);
        assert.deepStrictEqual(env.started, { ok: true }, env.lines.join("\n"));
        const P = C.reviewPeriodMs;
        const t0 = (Math.floor(shared.clock.now() / P) + 1) * P;
        await env.drive(t0);
        let trip = env.trip();
        const out = env.op(trip.outbound_operation_id);
        assert.deepStrictEqual([trip.kind, trip.state, trip.fleet_id, trip.target_system_id, trip.base_system_id,
          out.operation_type, out.objective, env.counters().dispatched],
        ["rat", "OUTBOUND", fleetId, S.N0, S.L1, "ratting", "rat", 1]);
        const ta = env.fleet(fleetId).next_action_at;
        await env.drive(ta);
        trip = env.trip();
        assert.deepStrictEqual([trip.state, trip.ratting_started_at, trip.ratting_ends_at, env.kills.length],
          ["RATTING", ta, ta + C.rattingShiftMs, 0]);
        const at1 = ta + C.rattingStepMs;
        await env.drive(at1);
        const expected = stepKills({ tripId: trip.trip_id, phaseSeq: trip.phase_seq, round: 0, systemId: S.N0,
          victimFactionId: SANSHA, atMs: at1, characterIds: MEMBERS.slice() }, C);
        assert.deepStrictEqual(env.kills, expected.map((k) => ({ ...k, virtual: true, inTx: false })));
        assert.deepStrictEqual(env.kills.map((k) => k.characterId), [MEMBERS[0], MEMBERS[1]]);
        assert.deepStrictEqual([env.corp().isk_balance, env.trip().kills, env.trip().isk_earned],
          [wallet + 2 * bounty, 2, 2 * bounty]);
        const again = redeliver(env, CS.stepKey(trip.trip_id, trip.phase_seq, 0));
        assert.deepStrictEqual([again.state, again.v.action, env.kills.length, env.corp().isk_balance],
          ["DONE", "STALE", 2, wallet + 2 * bounty]);
        await env.drive(ta + C.rattingShiftMs);
        trip = env.trip();
        const ret = env.op(trip.return_operation_id);
        assert.deepStrictEqual([trip.state, trip.abort_reason, trip.kills, trip.isk_earned, ret.operation_type,
          ret.objective, ret.target_system_id, env.op(trip.outbound_operation_id).state],
        ["RETURNING", null, 8, 7 * bounty + 1, "return", "return", S.L1, "COMPLETED"]);
        assert.deepStrictEqual([env.corp().isk_balance, env.kills.length, env.kills.every((k) => !k.inTx)],
          [C.maxIskBalance, 8, true]);
        await env.drive(env.fleet(fleetId).next_action_at);
        trip = env.trip();
        const f = env.fleet(fleetId);
        assert.deepStrictEqual([trip.state, trip.end_reason, f.state, f.current_system_id, f.operation_id,
          env.op(trip.outbound_operation_id).state, env.op(trip.return_operation_id).state],
        ["DOCKED", "DOCKED", "IDLE", S.L1, null, "COMPLETED", "COMPLETED"]);
        const st = env.counters();
        assert.deepStrictEqual([st.ratStarts, st.steps, st.kills, st.killsApplied, st.bountyIsk, st.docked,
          st.tripStale], [1, 4, 8, 8, 7 * bounty + 1, 1, 2]);
        const view = env.ctx.views.getView("capsuleers").getData();
        assert.deepStrictEqual(view.trips.map((t) => [t.fleet, t.state, t.kills]), [[fleetId, "DOCKED", 8]]);
      } finally {
        env.stop();
      }
    });
  });

  needsDriver("T3 hostiles in the target before the arrival -> RETURNING HOSTILES without kills, docked -> "
    + "ABORTED HOSTILES", async () => {
    await H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const opened = reopen();
      const env = boot(opened, shared, testConfig({}));
      try {
        seed(opened, shared, [1], 1000000000);
        const fleetId = await newFleet(env, "caps", CAPS, S.L1, "capsuleer", 98000001);
        const P = env.cfg.capsuleers.reviewPeriodMs;
        await env.drive((Math.floor(shared.clock.now() / P) + 1) * P);
        assert.strictEqual(env.trip().state, "OUTBOUND");
        await newFleet(env, "patrol", SANSHA, S.N0, "patrol");
        await env.drive(env.fleet(fleetId).next_action_at);
        let trip = env.trip();
        assert.deepStrictEqual([trip.state, trip.abort_reason, trip.kills, trip.ratting_started_at, env.kills.length,
          env.op(trip.outbound_operation_id).state], ["RETURNING", "HOSTILES", 0, null, 0, "FAILED"]);
        await env.drive(env.fleet(fleetId).next_action_at);
        trip = env.trip();
        assert.deepStrictEqual([trip.state, trip.end_reason, trip.abort_reason, env.fleet(fleetId).state,
          env.counters().abortHostiles, env.counters().aborted, env.kills.length],
        ["ABORTED", "HOSTILES", "HOSTILES", "IDLE", 1, 1, 0]);
      } finally {
        env.stop();
      }
    });
  });

  needsDriver("T4 restart reconcile (one event per open trip, second start none), liberation missing -> "
    + "killsUnreported and the trip goes on, capsuleers.enabled=false -> no trip step", async () => {
    await H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      let opened = reopen();
      const trips = createTripRepository({ journal: createJournal({ clock: shared.clock, maxPayloadBytes: 16384,
        maxRows: 500 }), clock: shared.clock });
      const at = shared.clock.now();
      const r = opened.store.transaction("seed", (db) => {
        const mk = (n, kind, state) => {
          const tripId = shared.ids.next("ct");
          const c = trips.createTrip(db, { tripId, idempotencyKey: `test:${n}`, kind, slot: 1, fleetId: `fleet-${n}`,
            originSystemId: S.L1, baseSystemId: S.L1, targetSystemId: kind === "rat" ? S.N0 : null,
            outboundOperationId: kind === "rat" ? `op-${n}` : null, returnOperationId: kind === "rat" ? null
              : `op-${n}`, state, dispatchedAt: at }, `test:${n}:trip`);
          assert.ok(c.ok, JSON.stringify(c));
          return tripId;
        };
        mk(1, "rat", "OUTBOUND");
        const t2 = mk(2, "rat", "OUTBOUND");
        mk(3, "home", "RETURNING");
        const m = trips.transitionTrip(db, { tripId: t2, expectedVersion: 1, from: "OUTBOUND", to: "RATTING",
          patch: { phaseSeq: 1, watchRound: 0, rattingStartedAt: at, rattingEndsAt: at + 1 } }, "test:2:start");
        assert.ok(m.ok, JSON.stringify(m));
        return { ok: true };
      });
      assert.ok(r.ok, JSON.stringify(r));
      const recCount = (env) => env.n("SELECT count(*) AS n FROM world_scheduled_events WHERE idempotency_key LIKE "
        + "'capsuleers:trip:rec:%'");
      let env = boot(opened, shared, testConfig({}));
      assert.deepStrictEqual([recCount(env), env.counters().tripsReconciled], [3, 3]);
      env.stop();
      opened.store.close("test");
      opened = reopen();
      env = boot(opened, shared, testConfig({}));
      assert.deepStrictEqual([recCount(env), env.counters().tripsReconciled], [3, 0]);
      env.stop();
    });

    await H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const opened = reopen();
      const env = boot(opened, shared, testConfig({}), { noLiberation: true });
      try {
        seed(opened, shared, [1], 1000000000);
        const fleetId = await newFleet(env, "caps", CAPS, S.L1, "capsuleer", 98000001);
        const C = env.cfg.capsuleers;
        await env.drive((Math.floor(shared.clock.now() / C.reviewPeriodMs) + 1) * C.reviewPeriodMs);
        const ta = env.fleet(fleetId).next_action_at;
        await env.drive(ta + C.rattingStepMs);
        const trip = env.trip();
        const next = env.q("SELECT state FROM world_scheduled_events WHERE idempotency_key = ?",
          CS.stepKey(trip.trip_id, trip.phase_seq, 1))[0];
        assert.deepStrictEqual([trip.state, trip.kills, env.counters().killsUnreported, next && next.state],
          ["RATTING", 2, 2, "QUEUED"]);
      } finally {
        env.stop();
      }
    });

    await H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const opened = reopen();
      const env = boot(opened, shared, testConfig());
      try {
        await newFleet(env, "caps", CAPS, S.L1, "capsuleer", 98000001);
        await env.drive(shared.clock.now() + 2 * env.cfg.capsuleers.reviewPeriodMs);
        assert.deepStrictEqual([env.started.reason, env.n("SELECT count(*) AS n FROM world_scheduled_events WHERE "
          + "event_type = ?", CS.STEP_EVENT), env.n("SELECT count(*) AS n FROM world_capsuleer_trips")],
        ["disabled_by_config", 0, 0]);
      } finally {
        env.stop();
      }
    });
  });

  test("R4 ratStepDueAt salvage/merc/rat/clamp to ends/no ends, ratLastAtOf watchRound 0/>0/not RATTING",
    () => {
      const P = { rattingStepMs: 100, mercStepMs: 30 };
      assert.deepStrictEqual([
        ratStepDueAt({ kind: "salvage", rattingEndsAt: 900 }, 10, P),
        ratStepDueAt({ kind: "merc", rattingEndsAt: 900 }, 10, P),
        ratStepDueAt({ kind: "rat", rattingEndsAt: 900 }, 10, P),
        ratStepDueAt({ kind: "rat", rattingEndsAt: 50 }, 10, P),
        ratStepDueAt({ kind: "merc", rattingEndsAt: null }, 10, P)], [900, 40, 110, 50, 10]);
      const t = { state: "RATTING", watchRound: 0, rattingStartedAt: 5, updatedAt: 70 };
      assert.deepStrictEqual([ratLastAtOf(t), ratLastAtOf({ ...t, watchRound: 2 }),
        ratLastAtOf({ ...t, state: "OUTBOUND" }), ratLastAtOf({ ...t, rattingStartedAt: null }), ratLastAtOf(null)],
      [5, 70, null, null, null]);
    });

  needsDriver("R1-R3 reconcile in RATTING: salvage due at rattingEndsAt, rat watchRound 0 at "
    + "rattingStartedAt + step, watchRound > 0 at updatedAt + step, past term -> now; second start no entry, the "
    + "reconciled step pays once", async () => {
    await H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const opened = reopen();
      const step = testConfig({}).capsuleers.rattingStepMs;
      const trips = createTripRepository({ journal: createJournal({ clock: shared.clock, maxPayloadBytes: 16384,
        maxRows: 500 }), clock: shared.clock });
      const at0 = shared.clock.now();
      const T = at0 + 2 * step;
      const ids = {};
      const run = (fn) => {
        const r = opened.store.transaction("seed", fn);
        assert.ok(r.ok && r.value.ok !== false, JSON.stringify(r));
      };
      const mk = (db, n, kind, started, ends) => {
        const tripId = shared.ids.next("ct");
        const c = trips.createTrip(db, { tripId, idempotencyKey: `test:${n}`, kind, slot: 1, fleetId: `fleet-${n}`,
          originSystemId: S.L1, baseSystemId: S.L1, targetSystemId: S.N0, outboundOperationId: `op-${n}`,
          returnOperationId: null, state: "OUTBOUND", dispatchedAt: at0,
          ...(kind === "salvage" ? { fieldId: `field-${n}` } : {}) }, `test:${n}:trip`);
        assert.ok(c.ok, JSON.stringify(c));
        const m = trips.transitionTrip(db, { tripId, expectedVersion: 1, from: "OUTBOUND", to: "RATTING",
          patch: { phaseSeq: 1, watchRound: 0, rattingStartedAt: started, rattingEndsAt: ends } }, `test:${n}:start`);
        assert.ok(m.ok, JSON.stringify(m));
        ids[n] = tripId;
        return { ok: true };
      };
      shared.clock.set(T - 500);
      run((db) => {
        mk(db, "salvage", "salvage", T, T + 10 * step);
        mk(db, "rat0", "rat", T - 1000, T + 10 * step);
        mk(db, "past", "rat", at0, at0 + 5 * step);
        mk(db, "rat1", "rat", T - 2000, T + 10 * step);
        return trips.stepTrip(db, { tripId: ids.rat1, expectedVersion: 2, watchRound: 1, kills: 0, iskEarned: 0 },
          "test:rat1:step");
      });
      shared.clock.set(T);
      const recs = (env) => new Map(env.q("SELECT aggregate_id, due_at FROM world_scheduled_events WHERE "
        + "idempotency_key LIKE 'capsuleers:trip:rec:%'").map((e) => [e.aggregate_id, e.due_at]));
      let env = boot(opened, shared, testConfig({ mercStepMs: 600000 }));
      const got = recs(env);
      assert.deepStrictEqual([got.get(ids.salvage), got.get(ids.rat0), got.get(ids.rat1), got.get(ids.past), got.size],
        [T + 10 * step, T - 1000 + step, T - 500 + step, T, 4]);
      env.stop();
      env = boot(opened, shared, testConfig({}));
      assert.deepStrictEqual([recs(env).size, env.counters().tripsReconciled], [4, 0]);
      env.stop();
    });

    await H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const opened = reopen();
      const wallet = 1000000000;
      let env = boot(opened, shared, testConfig({}));
      const C = env.cfg.capsuleers;
      try {
        seed(opened, shared, [1], wallet);
        const fleetId = await newFleet(env, "caps", CAPS, S.L1, "capsuleer", 98000001);
        await env.drive((Math.floor(shared.clock.now() / C.reviewPeriodMs) + 1) * C.reviewPeriodMs);
        const ta = env.fleet(fleetId).next_action_at;
        await env.drive(ta + C.rattingStepMs);
        const trip = env.trip();
        assert.deepStrictEqual([trip.state, trip.watch_round, trip.kills], ["RATTING", 1, 2]);
        const lost = CS.stepKey(trip.trip_id, trip.phase_seq, 1);
        env.stop();
        env.tx((db) => db.prepare("DELETE FROM world_scheduled_events WHERE idempotency_key = ?").run(lost));
        const now = trip.updated_at + 2 * C.rattingStepMs;
        shared.clock.set(now);
        env = boot(opened, shared, testConfig({}));
        const rec = env.q("SELECT due_at FROM world_scheduled_events WHERE idempotency_key LIKE "
          + "'capsuleers:trip:rec:%'");
        assert.deepStrictEqual(rec.map((e) => e.due_at), [now]);
        const isk0 = env.corp().isk_balance;
        await env.drive(now);
        const bounty = C.rattingBountyIskPerKill;
        assert.deepStrictEqual([env.trip().watch_round, env.trip().kills, env.corp().isk_balance - isk0],
          [2, 4, 2 * bounty]);
        env.stop();
        env = boot(opened, shared, testConfig({}));
        assert.deepStrictEqual([env.counters().tripsReconciled, env.trip().kills], [0, 4]);
      } finally {
        env.stop();
      }
    });
  });

  needsDriver("H2: TIMEOUT of a flying fleet -> it lands STAGED on the outbound operation, the next "
    + "review sweeps it (IDLE, operation FAILED), the one after sends it home; RESEEK of a fleet STAGED on the "
    + "outbound operation closes it and plans the return", async () => {
    await H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const opened = reopen();
      const env = boot(opened, shared, testConfig({ tripMaxWatchRounds: 1 }));
      try {
        seed(opened, shared, [1], 1000000000);
        const fleetId = await newFleet(env, "caps", CAPS, S.L1, "capsuleer", 98000001);
        const P = env.cfg.capsuleers.reviewPeriodMs;
        await env.drive((Math.floor(shared.clock.now() / P) + 1) * P);
        const trip = env.trip();
        const outOp = trip.outbound_operation_id;
        const w = redeliver(env, CS.stepKey(trip.trip_id, 0, 0));
        assert.deepStrictEqual([w.v.action, env.trip().wait_round, env.trip().watch_round], ["WAIT", 1, 1]);
        const e = redeliver(env, CS.stepKey(trip.trip_id, 0, 1));
        assert.deepStrictEqual([e.v.action, e.v.reason, env.trip().state, env.trip().wait_round,
          env.fleet(fleetId).state, env.op(outOp).state], ["END", "TIMEOUT", "ABORTED", 0, "TRAVELLING", "ACTIVE"]);
        await env.drive(env.fleet(fleetId).next_action_at);
        let f = env.fleet(fleetId);
        assert.deepStrictEqual([f.state, f.current_system_id, f.operation_id], ["STAGED", S.N0, outOp]);
        const setFaction = (factionId) => env.tx((db) => db.prepare("UPDATE world_operations SET faction_id = ? "
          + "WHERE operation_id = ?").run(factionId, outOp));
        setFaction(AMARR);
        let r = Math.floor(shared.clock.now() / P) + 1;
        await env.drive(r * P);
        assert.deepStrictEqual([env.fleet(fleetId).state, env.op(outOp).state, env.counters().orphansReleased],
          ["STAGED", "ACTIVE", 0]);
        setFaction(CAPS);
        r += 1;
        await env.drive(r * P);
        f = env.fleet(fleetId);
        assert.deepStrictEqual([f.state, f.operation_id, env.op(outOp).state,
          JSON.parse(env.op(outOp).result_json).reason, env.counters().orphansReleased,
          env.n("SELECT count(*) AS n FROM world_capsuleer_trips")], ["IDLE", null, "FAILED", "ORPHAN", 1, 1]);
        await env.drive((r + 1) * P);
        const home = env.trip();
        assert.deepStrictEqual([home.kind, home.state, home.fleet_id, env.counters().homingDispatched,
          env.counters().orphansReleased], ["home", "RETURNING", fleetId, 1, 1]);
      } finally {
        env.stop();
      }
    });

    await H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const opened = reopen();
      const env = boot(opened, shared, testConfig({}));
      try {
        seed(opened, shared, [1], 1000000000);
        const fleetId = await newFleet(env, "caps", CAPS, S.L1, "capsuleer", 98000001);
        const P = env.cfg.capsuleers.reviewPeriodMs;
        await env.drive((Math.floor(shared.clock.now() / P) + 1) * P);
        await env.drive(env.fleet(fleetId).next_action_at);
        let trip = env.trip();
        const outOp = trip.outbound_operation_id;
        assert.deepStrictEqual([trip.state, env.fleet(fleetId).state, env.fleet(fleetId).operation_id],
          ["RATTING", "STAGED", outOp]);
        const trips = createTripRepository({ journal: env.journal, clock: shared.clock });
        const phase = trip.phase_seq + 1;
        env.tx((db) => {
          const m = trips.transitionTrip(db, { tripId: trip.trip_id, expectedVersion: trip.version, from: "RATTING",
            to: "RETURNING", patch: { phaseSeq: phase, watchRound: 0, returnOperationId: null } }, "test:h2:ret");
          assert.ok(m.ok, JSON.stringify(m));
          return m;
        });
        const at = shared.clock.now();
        const q = env.ctx.scheduler.enqueue(CS.STEP_EVENT, trip.trip_id, at, { tripId: trip.trip_id, phaseSeq: phase,
          round: 0 }, CS.stepKey(trip.trip_id, phase, 0));
        assert.ok(q.ok, JSON.stringify(q));
        await env.drive(at);
        trip = env.trip();
        const f = env.fleet(fleetId);
        const active = env.q("SELECT operation_id FROM world_operations WHERE faction_id = ? AND state = 'ACTIVE'", CAPS)
          .map((o) => o.operation_id);
        assert.deepStrictEqual([env.counters().reseeks, env.op(outOp).state, trip.state, f.state, f.operation_id,
          env.op(trip.return_operation_id).objective, active],
        [1, "FAILED", "RETURNING", "TRAVELLING", trip.return_operation_id, "return", [trip.return_operation_id]]);
      } finally {
        env.stop();
      }
    });
  });

  needsDriver("H3: a pirate patrol after START_RATTING -> the next step RETURN HOSTILES without kills "
    + "and without onNpcKill; the review picks no target with a hostile patrol", async () => {
    await H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const opened = reopen();
      const env = boot(opened, shared, testConfig({}));
      try {
        seed(opened, shared, [1], 1000000000);
        const fleetId = await newFleet(env, "caps", CAPS, S.L1, "capsuleer", 98000001);
        const C = env.cfg.capsuleers;
        await env.drive((Math.floor(shared.clock.now() / C.reviewPeriodMs) + 1) * C.reviewPeriodMs);
        const ta = env.fleet(fleetId).next_action_at;
        await env.drive(ta);
        assert.strictEqual(env.trip().state, "RATTING");
        await newFleet(env, "patrol", SANSHA, S.N0, "patrol");
        await env.drive(ta + C.rattingStepMs);
        const trip = env.trip();
        assert.deepStrictEqual([trip.state, trip.abort_reason, trip.kills, env.kills.length, env.counters().steps,
          env.counters().abortHostiles, env.op(trip.outbound_operation_id).state],
        ["RETURNING", "HOSTILES", 0, 0, 0, 1, "FAILED"]);
      } finally {
        env.stop();
      }
    });

    await H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const opened = reopen();
      const env = boot(opened, shared, testConfig({}));
      try {
        seed(opened, shared, [1], 1000000000);
        await newFleet(env, "caps", CAPS, S.L1, "capsuleer", 98000001);
        await newFleet(env, "patrol", SANSHA, S.N0, "patrol");
        const P = env.cfg.capsuleers.reviewPeriodMs;
        await env.drive((Math.floor(shared.clock.now() / P) + 1) * P);
        assert.deepStrictEqual([env.n("SELECT count(*) AS n FROM world_capsuleer_trips"), env.counters().reviews,
          env.counters().dispatched], [0, 1, 0]);
      } finally {
        env.stop();
      }
    });
  });

  needsDriver("T5 05a slots above maxCorps get the stipend + panel, APPLY_FAILED founding -> "
    + "applyFailed (noBase unchanged), facade methods = stub methods", async () => {
    await H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const opened = reopen();
      const env = boot(opened, shared, testConfig({ maxCorps: 2, maxFoundingsPerReview: 1,
        stipendIskPerReview: 5000000 }));
      try {
        seed(opened, shared, [1, 2, 3, 4], 1000000);
        const P = env.cfg.capsuleers.reviewPeriodMs;
        await env.drive((Math.floor(shared.clock.now() / P) + 1) * P);
        const wallets = env.q("SELECT corp_slot, isk_balance FROM world_capsuleer_corps ORDER BY corp_slot")
          .map((c) => [c.corp_slot, c.isk_balance]);
        const view = env.ctx.views.getView("capsuleers").getData();
        assert.deepStrictEqual([wallets, view.rows.map((r) => r.slot), env.counters().founded],
          [[[1, 6000000], [2, 6000000], [3, 6000000], [4, 6000000]], [1, 2, 3, 4], 0]);
        assert.deepStrictEqual(Object.keys(env.ctx.capsuleers).sort(),
          Object.keys(createUnavailableCapsuleers("TEST")).sort());
      } finally {
        env.stop();
      }
    });

    await H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const opened = reopen();
      const env = boot(opened, shared, testConfig({ maxFoundingsPerReview: 1 }));
      try {
        env.tx((db) => db.exec("CREATE TRIGGER test_no_corp BEFORE INSERT ON world_capsuleer_corps "
          + "BEGIN SELECT RAISE(ABORT, 'forced'); END"));
        const P = env.cfg.capsuleers.reviewPeriodMs;
        await env.drive((Math.floor(shared.clock.now() / P) + 1) * P);
        const st = env.ctx.capsuleers.getStatus();
        assert.deepStrictEqual([st.counters.applyFailed, st.counters.noBase, st.counters.founded,
          env.n("SELECT count(*) AS n FROM world_capsuleer_corps"), /APPLY_FAILED/.test(String(st.lastRefusal))],
        [1, 0, 0, 0, true]);
      } finally {
        env.stop();
      }
    });
  });
};

Object.assign(module.exports, { harness: Object.freeze({ boot, seed, newFleet, redeliver, testConfig, CAPS, SANSHA,
  AMARR, MEMBERS, BASES }) });
