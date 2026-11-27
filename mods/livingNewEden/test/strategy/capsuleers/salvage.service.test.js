"use strict";

const assert = require("node:assert");
const path = require("node:path");

const config = require("../../../config");
const { createJournal } = require("../../../lib/persistence/journal");
const { LATEST_SCHEMA_VERSION } = require("../../../lib/persistence/migrations");
const { createWreckRepository } = require("../../../lib/world/wreckRepository");
const { createSalvageRepository } = require("../../../lib/world/salvageRepository");
const { effectivePool, claimShare } = require("../../../lib/world/wreckPool");
const { salvageTimes } = require("../../../lib/fleets/salvageOps");
const { createRattingService } = require("../../../lib/strategy/capsuleers/rattingService");
const { createTripRepository } = require("../../../lib/strategy/capsuleers/tripRepository");
const { createCorpRepository } = require("../../../lib/strategy/capsuleers/corpRepository");
const { hireCapOf } = require("../../../lib/strategy/capsuleers/capsuleerService");
const CS = require("../../../lib/strategy/capsuleers/schema");
const { harness: H } = require("../../battle/settlement.test");
const { harness: R } = require("./ratting.service.test");

const MOD_DIR = path.resolve(__dirname, "..", "..", "..");
const S = H.S;
const DAY = 86400000;
const WALLET = 1000000000;

function boot(opened, shared, capsuleers, opts = {}) {
  const journal = createJournal({ clock: shared.clock, maxPayloadBytes: 16384, maxRows: 500 });
  const wreckRepo = createWreckRepository({ journal });
  const salvageRepo = createSalvageRepository({ journal });
  const ctx = { wrecks: { repository: wreckRepo, effectivePool } };
  if (opts.salvage !== false) ctx.salvage = { repository: salvageRepo };
  const env = R.boot(opened, shared, R.testConfig({ salvageEnabled: true, ...capsuleers }), { ctx });
  env.addField = (fieldId, systemId, extra = {}) => {
    const at = shared.clock.now();
    const field = { fieldId, battleId: null, source: "structure", systemId, environment: "nullsec", outcome: null,
      winnerFactionId: R.CAPS, shipsLost: 6, composition: [[R.CAPS, "cruiser", 17715, 2], [R.SANSHA, "frigate", 0, 4]],
      salvageUnits: 12, lootUnits: 10, decayFloorPpm: 500000, createdAt: at - 1000, expiresAt: at + 3 * DAY, ...extra };
    const r = env.tx((db) => wreckRepo.insertInTx(db, field, `test:field:${fieldId}`));
    assert.ok(r.ok, JSON.stringify(r));
  };
  env.addJob = (fieldId, factionId, state) => {
    const at = shared.clock.now();
    const job = state === "FAILED"
      ? { fieldId, factionId, systemId: S.N0, homeStationId: null, homeSystemId: null, jumps: 0, state,
        endReason: "NO_HOME", travelMs: 0, recoveryMs: 0, nextAt: null, at }
      : { fieldId, factionId, systemId: S.N0, homeStationId: "st-1", homeSystemId: S.L1, jumps: 1, state,
        endReason: null, travelMs: 1000, recoveryMs: 1000, nextAt: at + 1000, at };
    const r = env.tx((db) => salvageRepo.insertJobInTx(db, job, `test:job:${fieldId}`));
    assert.ok(r.ok, JSON.stringify(r));
  };
  env.field = (fieldId) => env.tx((db) => wreckRepo.get(db, fieldId)).field;
  env.wreckRepo = wreckRepo;
  env.trips = () => env.q("SELECT * FROM world_capsuleer_trips ORDER BY created_at, trip_id");
  env.review = () => {
    const P = env.cfg.capsuleers.reviewPeriodMs;
    return env.drive((Math.floor(shared.clock.now() / P) + 1) * P);
  };
  return env;
}

function deliverAs(env, key, idempotencyKey) {
  const row = env.q("SELECT * FROM world_scheduled_events WHERE idempotency_key = ?", key)[0];
  const ev = { eventId: `${row.event_id}-x`, eventType: row.event_type, aggregateId: row.aggregate_id,
    dueAt: row.due_at, payload: JSON.parse(row.payload), idempotencyKey, attempts: 0 };
  const res = env.handlers[CS.STEP_EVENT](ev, {});
  assert.ok(res.ok, JSON.stringify(res));
  const v = env.tx((db) => res.effect(db, ev));
  res.onCommitted(v);
  return v;
}

module.exports = ({ test, skip }) => {
  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  needsDriver("CSV3 salvage trip: field of 500018 (FAILED NO_HOME) -> salvage dispatch -> START (recoveryMs) "
    + "-> COLLECT (pool taken, haul = effective pool) -> STALE redelivery / reconcile -> DOCK paid", async () => {
    await H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const opened = reopen();
      const env = boot(opened, shared, {});
      const C = env.cfg.capsuleers;
      try {
        R.seed(opened, shared, [1], WALLET);
        const fleetId = await R.newFleet(env, "caps", R.CAPS, S.L1, "capsuleer", 98000001);
        env.addField("wf-1", S.N0);
        env.addJob("wf-1", R.CAPS, "FAILED");
        assert.deepStrictEqual(env.started, { ok: true }, env.lines.join("\n"));
        await env.review();
        let trip = env.trip();
        const out = env.op(trip.outbound_operation_id);
        assert.deepStrictEqual([env.trips().length, trip.kind, trip.state, trip.field_id, trip.target_system_id,
          out.operation_type, out.objective, env.counters().salvageDispatched, env.counters().dispatched,
          env.counters().dispatchRefused], [1, "salvage", "OUTBOUND", "wf-1", S.N0, "salvage", "salvage", 1, 0, 0]);
        const ta = env.fleet(fleetId).next_action_at;
        await env.drive(ta);
        trip = env.trip();
        const rec = salvageTimes(env.cfg.salvage, { jumps: 0, shipsLost: 6 }).recoveryMs;
        assert.deepStrictEqual([trip.state, trip.ratting_started_at, trip.ratting_ends_at, env.counters().salvageStarts,
          env.counters().ratStarts], ["RATTING", ta, ta + rec, 1, 0]);
        const before = env.field("wf-1");
        const total = effectivePool(before, ta + rec).total;
        const share = claimShare(before, ta + rec, env.cfg.salvage.claimPermille);
        const pool = { total: share.haul.salvage + share.haul.loot };
        const collectKey = CS.stepKey(trip.trip_id, trip.phase_seq, 0);
        await env.drive(ta + rec);
        trip = env.trip();
        let field = env.field("wf-1");
        assert.ok(total > 0 && total <= 22 && pool.total > 0 && pool.total < total, JSON.stringify([total, pool]));
        assert.deepStrictEqual([trip.state, trip.abort_reason, trip.haul_units, field.salvagedSalvageUnits,
          field.salvagedLootUnits, field.version, env.op(trip.outbound_operation_id).state,
          env.op(trip.return_operation_id).operation_type, env.counters().salvageCollected,
          env.counters().salvageUnits, effectivePool(field, ta + rec).total],
        ["RETURNING", null, pool.total, share.salvaged.salvageUnits, share.salvaged.lootUnits, before.version + 1,
          "COMPLETED", "return", 1, pool.total, total - pool.total]);
        assert.deepStrictEqual([share.salvaged.salvageUnits, share.salvaged.lootUnits], [6, 5]);
        const again = R.redeliver(env, collectKey);
        const rv = deliverAs(env, collectKey, CS.reconcileKey(trip.trip_id, trip.phase_seq - 1, 0));
        field = env.field("wf-1");
        assert.deepStrictEqual([again.state, again.v.action, rv.action, field.version, env.corp().isk_balance,
          env.counters().salvageCollected], ["DONE", "STALE", "STALE", before.version + 1, WALLET, 1]);
        await env.drive(env.fleet(fleetId).next_action_at);
        trip = env.trip();
        const paid = pool.total * C.salvageIskPerUnit;
        assert.deepStrictEqual([trip.state, trip.end_reason, trip.isk_earned, env.corp().isk_balance,
          env.fleet(fleetId).state, env.counters().salvageIsk, env.counters().salvageUnitsLost],
        ["DOCKED", "DOCKED", paid, WALLET + paid, "IDLE", paid, 0]);
        const view = env.ctx.views.getView("capsuleers").getData();
        assert.deepStrictEqual(view.trips.map((t) => [t.kind, t.state, t.haul, t.isk]),
          [["salvage", "DOCKED", pool.total, paid]]);
      } finally {
        env.stop();
      }
    });
  });

  needsDriver("CSV4 the pool is never taken twice: faction fields skipped, one trip per field (FIELD_TAKEN) "
    + "a field taken by an anomaly -> EMPTY / ABORTED, hostiles on the field -> RETURN HOSTILES", async () => {
    await H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const opened = reopen();
      const env = boot(opened, shared, {});
      try {
        R.seed(opened, shared, [1], WALLET);
        await R.newFleet(env, "caps", R.CAPS, S.L1, "capsuleer", 98000001);
        env.addField("wf-a", S.N0, { winnerFactionId: R.AMARR });
        env.addJob("wf-a", R.AMARR, "OUTBOUND");
        env.addField("wf-b", S.L2, { winnerFactionId: R.AMARR });
        await env.review();
        assert.deepStrictEqual([env.trips().map((t) => t.kind), env.counters().salvageDispatched],
          [["rat"], 0]);
      } finally {
        env.stop();
      }
    });

    await H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const opened = reopen();
      const env = boot(opened, shared, { maxDispatchesPerReview: 1 });
      try {
        R.seed(opened, shared, [1], WALLET);
        await R.newFleet(env, "caps1", R.CAPS, S.L1, "capsuleer", 98000001);
        await R.newFleet(env, "caps2", R.CAPS, S.L1, "capsuleer", 98000001);
        env.addField("wf-1", S.N0);
        await env.review();
        assert.deepStrictEqual([env.trips().map((t) => t.kind).sort(), env.counters().dispatched,
          env.counters().salvageDispatched], [["rat", "salvage"], 1, 1]);
      } finally {
        env.stop();
      }
    });

    await H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const opened = reopen();
      const env = boot(opened, shared, { maxCorps: 2, maxSalvageDispatchesPerReview: 2, rattingEnabled: false });
      try {
        R.seed(opened, shared, [1, 2], WALLET);
        await R.newFleet(env, "caps1", R.CAPS, S.L1, "capsuleer", 98000001);
        const second = await R.newFleet(env, "caps2", R.CAPS, S.L2, "capsuleer", 98000002);
        env.addField("wf-1", S.N0);
        await env.review();
        assert.deepStrictEqual(env.trips().map((t) => [t.kind, t.corp_slot, t.field_id]), [["salvage", 1, "wf-1"]]);
        const ratting = createRattingService({ store: env.store, journal: env.journal,
          trips: createTripRepository({ journal: env.journal, clock: shared.clock }), corps: createCorpRepository(),
          fleets: { repository: env.fleets.repository, travel: env.fleets.travel }, scheduler: env.ctx.scheduler,
          getWorld: () => null, getRegistry: () => null, clock: shared.clock, ids: shared.ids, config: env.cfg,
          getWrecks: () => env.ctx.wrecks });
        const count = () => [env.n("SELECT count(*) AS n FROM world_operations"),
          env.n("SELECT count(*) AS n FROM world_capsuleer_trips")];
        const rows = count();
        const version = env.fleet(second).version;
        const r = env.tx((db) => ratting.dispatchInTx(db, { kind: "salvage", slot: 2, fleetId: second,
          expectedVersion: version, baseSystemId: S.L2, targetSystemId: S.N0, at: shared.clock.now(),
          fieldId: "wf-1" }, "test:csv4b:dispatch"));
        assert.deepStrictEqual([r.ok, r.reason, count(), env.fleet(second).state], [false, "FIELD_TAKEN", rows, "IDLE"]);
      } finally {
        env.stop();
      }
    });

    await H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const opened = reopen();
      const env = boot(opened, shared, {});
      try {
        R.seed(opened, shared, [1], WALLET);
        const fleetId = await R.newFleet(env, "caps", R.CAPS, S.L1, "capsuleer", 98000001);
        env.addField("wf-1", S.L2, { winnerFactionId: null });
        await env.review();
        await env.drive(env.fleet(fleetId).next_action_at);
        const trip = env.trip();
        assert.deepStrictEqual([trip.kind, trip.state, trip.target_system_id], ["salvage", "RATTING", S.L2]);
        const v0 = env.field("wf-1").version;
        const claimed = env.tx((db) => env.wreckRepo.claimForAnomalyInTx(db, { fieldId: "wf-1", expectedVersion: v0,
          at: shared.clock.now() }, "test:csv4c:take"));
        assert.ok(claimed.ok, JSON.stringify(claimed));
        const taken = env.field("wf-1");
        await env.drive(trip.ratting_ends_at);
        assert.deepStrictEqual([env.trip().state, env.trip().abort_reason, env.trip().haul_units],
          ["RETURNING", "EMPTY", 0]);
        await env.drive(env.fleet(fleetId).next_action_at);
        assert.deepStrictEqual([env.trip().state, env.trip().end_reason, env.field("wf-1"), env.corp().isk_balance,
          env.counters().salvageEmpty, env.counters().salvageCollected, env.counters().salvageIsk],
        ["ABORTED", "EMPTY", taken, WALLET, 1, 0, 0]);
      } finally {
        env.stop();
      }
    });

    await H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const opened = reopen();
      const env = boot(opened, shared, {});
      try {
        R.seed(opened, shared, [1], WALLET);
        const fleetId = await R.newFleet(env, "caps", R.CAPS, S.L1, "capsuleer", 98000001);
        env.addField("wf-1", S.N0);
        await env.review();
        await env.drive(env.fleet(fleetId).next_action_at);
        const trip = env.trip();
        assert.strictEqual(trip.state, "RATTING");
        const before = env.field("wf-1");
        await R.newFleet(env, "patrol", R.SANSHA, S.N0, "patrol");
        await env.drive(trip.ratting_ends_at);
        assert.deepStrictEqual([env.trip().state, env.trip().abort_reason, env.trip().haul_units, env.field("wf-1"),
          env.counters().abortHostiles, env.counters().salvageCollected], ["RETURNING", "HOSTILES", 0, before, 1, 0]);
      } finally {
        env.stop();
      }
    });
  });

  needsDriver("CSV5 salvageEnabled=false -> rat as before; migration 44; config rows + wrecks warning; K6 "
    + "hireCapOf", async () => {
    await H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const opened = reopen();
      const env = boot(opened, shared, { salvageEnabled: false });
      try {
        R.seed(opened, shared, [1], WALLET);
        await R.newFleet(env, "caps", R.CAPS, S.L1, "capsuleer", 98000001);
        env.addField("wf-1", S.N0);
        env.addJob("wf-1", R.CAPS, "FAILED");
        await env.review();
        const cols = env.q("PRAGMA table_info(world_capsuleer_trips)").map((c) => c.name);
        const idx = env.q("PRAGMA index_list(world_capsuleer_trips)").map((i) => i.name);
        assert.deepStrictEqual([env.trips().map((t) => [t.kind, t.field_id]), env.counters().salvageDispatched,
          env.counters().dispatched, cols.includes("field_id"), cols.includes("haul_units"),
          idx.includes("world_capsuleer_trips_open_field"), LATEST_SCHEMA_VERSION >= 44],
        [[["rat", null]], 0, 1, true, true, true, true]);
      } finally {
        env.stop();
      }
    });

    const rows = new Map(config.SCHEMA.map((r) => [r.key, r]));
    const spec = (k) => {
      const r = rows.get(`capsuleers.${k}`);
      return r ? [r.default, r.min === undefined ? null : r.min, r.max === undefined ? null : r.max] : null;
    };
    assert.deepStrictEqual(["salvageEnabled", "maxSalvageDispatchesPerReview", "salvageMaxJumps",
      "salvageScanMaxSystems", "salvageFieldsPerSystem", "salvageIskPerUnit"].map(spec),
    [[false, null, null], [1, 0, 8], [4, 1, 10], [200, 10, 5000], [3, 1, 16], [2000000, 0, 1000000000]]);
    const warned = (env) => config.resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_CAPSULEERS_ENABLED: "true",
      EVEJS_LNE_CAPSULEERS_SALVAGE_ENABLED: "true", ...env } }).warnings
      .includes("capsuleers.salvageEnabled without wrecks.enabled - no capsuleer salvage");
    assert.deepStrictEqual([warned({ EVEJS_LNE_WRECKS_ENABLED: "false" }), warned({})], [true, false]);
    assert.deepStrictEqual([hireCapOf({ maxContractsPerCorp: 1, maxMercenaryFleetsPerCorp: 2 }),
      hireCapOf({ maxContractsPerCorp: 3, maxMercenaryFleetsPerCorp: 1 }),
      hireCapOf({ maxContractsPerCorp: 0, maxMercenaryFleetsPerCorp: 0 })], [128, 192, 64]);
  });

  needsDriver("CSV6 hostiles in the field system, a field in the base (jumps 0) and a "
    + "field of an open trip get no salvage dispatch; COLLECT runs at ratting_ends_at, not before", async () => {
    await H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const opened = reopen();
      const env = boot(opened, shared, {});
      try {
        R.seed(opened, shared, [1], WALLET);
        await R.newFleet(env, "caps", R.CAPS, S.L1, "capsuleer", 98000001);
        await R.newFleet(env, "patrol", R.SANSHA, S.N0, "patrol");
        env.addField("wf-1", S.N0);
        env.addField("wf-base", S.L1, { winnerFactionId: null });
        await env.review();
        assert.deepStrictEqual([env.trips().length, env.counters().salvageDispatched, env.counters().dispatchRefused],
          [0, 0, 0]);
      } finally {
        env.stop();
      }
    });

    await H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const opened = reopen();
      const env = boot(opened, shared, { rattingEnabled: false });
      try {
        R.seed(opened, shared, [1], WALLET);
        const fleetId = await R.newFleet(env, "caps1", R.CAPS, S.L1, "capsuleer", 98000001);
        env.addField("wf-1", S.N0);
        await env.review();
        await R.newFleet(env, "caps2", R.CAPS, S.L1, "capsuleer", 98000001);
        const round = env.ctx.capsuleers.getStatus().lastRound + 1;
        const ev = { eventId: "test-csv6", eventType: CS.REVIEW_EVENT, aggregateId: CS.REVIEW_AGGREGATE_ID,
          dueAt: shared.clock.now(), payload: { round }, idempotencyKey: CS.reviewKey(round), attempts: 0 };
        const res = env.handlers[CS.REVIEW_EVENT](ev, {});
        assert.ok(res.ok, JSON.stringify(res));
        res.onCommitted(env.tx((db) => res.effect(db, ev)));
        assert.deepStrictEqual([env.trips().map((t) => [t.kind, t.fleet_id]), env.counters().salvageDispatched,
          env.counters().dispatchRefused], [[["salvage", fleetId]], 1, 0]);
        await env.drive(env.fleet(fleetId).next_action_at);
        const ends = env.trip().ratting_ends_at;
        const collectKey = CS.stepKey(env.trip().trip_id, env.trip().phase_seq, 0);
        const due = env.q("SELECT due_at FROM world_scheduled_events WHERE idempotency_key = ?", collectKey)[0].due_at;
        await env.drive(ends - 1);
        const before = [env.trip().state, env.trip().haul_units];
        await env.drive(ends);
        assert.deepStrictEqual([due, before, env.trip().state, env.trip().haul_units > 0],
          [ends, ["RATTING", 0], "RETURNING", true]);
      } finally {
        env.stop();
      }
    });
  });

  needsDriver("CSV7 DOCK pays up to maxIskBalance, an inactive corporation gets nothing "
    + "(unitsLost), a destroyed fleet loses the haul, salvageIskPerUnit=0 is no full wallet", async () => {
    const scene = async (capsuleers, beforeDock) => {
      let out = null;
      await H.withStore(driver, async (reopen) => {
        const shared = H.sharedOf();
        const opened = reopen();
        const env = boot(opened, shared, { rattingEnabled: false, ...capsuleers });
        try {
          R.seed(opened, shared, [1], WALLET);
          const fleetId = await R.newFleet(env, "caps", R.CAPS, S.L1, "capsuleer", 98000001);
          env.addField("wf-1", S.N0);
          await env.review();
          await env.drive(env.fleet(fleetId).next_action_at);
          await env.drive(env.trip().ratting_ends_at);
          const haul = env.trip().haul_units;
          assert.deepStrictEqual([env.trip().state, haul > 0], ["RETURNING", true]);
          const home = env.fleet(fleetId).next_action_at + env.cfg.capsuleers.tripWatchGraceMs + 1;
          beforeDock(env, fleetId);
          await env.drive(home);
          const c = env.counters();
          out = { haul, state: env.trip().state, isk: env.corp().isk_balance, earned: env.trip().isk_earned,
            salvageIsk: c.salvageIsk, unitsLost: c.salvageUnitsLost, walletFull: c.walletFull,
            price: env.cfg.capsuleers.salvageIskPerUnit };
        } finally {
          env.stop();
        }
      });
      return out;
    };
    const room = 5;
    const ceiling = await scene({ maxIskBalance: WALLET + room }, () => {});
    const inactive = await scene({}, (env) => env.tx((db) => db.prepare("UPDATE world_capsuleer_corps SET state = "
      + "'REFUSED', reason = 'TEST'").run()));
    const destroyed = await scene({}, (env, fleetId) => env.tx((db) => db.prepare("UPDATE virtual_fleets SET state = "
      + "'DESTROYED' WHERE fleet_id = ?").run(fleetId)));
    const free = await scene({ salvageIskPerUnit: 0 }, () => {});
    const empty = await scene({}, (env) => env.tx((db) => db.prepare("UPDATE world_capsuleer_trips SET haul_units = 0")
      .run()));
    assert.deepStrictEqual([
      [ceiling.state, ceiling.isk, ceiling.earned, ceiling.salvageIsk, ceiling.unitsLost],
      [inactive.state, inactive.isk, inactive.salvageIsk, inactive.unitsLost, inactive.walletFull],
      [destroyed.state, destroyed.isk, destroyed.unitsLost],
      [free.state, free.isk, free.unitsLost, free.walletFull],
      [empty.state, empty.isk, empty.unitsLost, empty.walletFull, empty.price > 0],
    ], [
      ["DOCKED", WALLET + room, room, room, 0],
      ["DOCKED", WALLET, 0, inactive.haul, 0],
      ["LOST", WALLET, destroyed.haul],
      ["DOCKED", WALLET, free.haul, 0],
      ["DOCKED", WALLET, 0, 0, true],
    ]);
  });
  needsDriver("CSV8: a field left by (DELIVERED, rest > 0) -> COLLECT takes claimShare of the rest, the "
    + "field keeps a pool; a 1-unit field -> no trip, the unit stays, later reviews send no empty trip", async () => {
    await H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const opened = reopen();
      const env = boot(opened, shared, { rattingEnabled: false });
      try {
        R.seed(opened, shared, [1], WALLET);
        const fleetId = await R.newFleet(env, "caps", R.CAPS, S.L1, "capsuleer", 98000001);
        env.addField("wf-1", S.N0);
        const f0 = env.field("wf-1");
        const m611 = env.tx((db) => env.wreckRepo.recordSalvageInTx(db, { fieldId: "wf-1", expectedVersion: f0.version,
          salvageUnits: 6, lootUnits: 5, at: shared.clock.now() }, "test:m611"));
        assert.ok(m611.ok, JSON.stringify(m611));
        env.addJob("wf-1", R.CAPS, "FAILED");
        env.tx((db) => db.prepare("UPDATE salvage_jobs SET state = 'DELIVERED', end_reason = NULL").run());
        await env.review();
        await env.drive(env.fleet(fleetId).next_action_at);
        const ends = env.trip().ratting_ends_at;
        const before = env.field("wf-1");
        const share = claimShare(before, ends, env.cfg.salvage.claimPermille);
        await env.drive(ends);
        const field = env.field("wf-1");
        assert.deepStrictEqual([env.trip().state, env.trip().haul_units, field.salvagedSalvageUnits,
          field.salvagedLootUnits, effectivePool(field, ends).total > 0],
        ["RETURNING", share.haul.salvage + share.haul.loot, 9, 7, true]);
      } finally {
        env.stop();
      }
    });
    await H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const opened = reopen();
      const env = boot(opened, shared, { rattingEnabled: false });
      try {
        R.seed(opened, shared, [1], WALLET);
        await R.newFleet(env, "caps", R.CAPS, S.L1, "capsuleer", 98000001);
        env.addField("wf-1", S.N0, { salvageUnits: 1, lootUnits: 0 });
        env.addJob("wf-1", R.CAPS, "FAILED");
        await env.review();
        await env.review();
        const field = env.field("wf-1");
        assert.deepStrictEqual([env.trips().length, env.counters().salvageDispatched, field.salvagedSalvageUnits,
          effectivePool(field, shared.clock.now()).total], [0, 0, 0, 1]);
      } finally {
        env.stop();
      }
    });
  });
};
