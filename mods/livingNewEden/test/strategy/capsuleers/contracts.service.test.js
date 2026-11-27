"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const config = require("../../../config");
const { openStore } = require("../../../lib/persistence/store");
const { MIGRATIONS, LATEST_SCHEMA_VERSION } = require("../../../lib/persistence/migrations");
const { TABLE_POLICY, ACTION } = require("../../../lib/persistence/worldReset");
const { createJournal } = require("../../../lib/persistence/journal");
const { createViewRegistry } = require("../../../lib/observer/views");
const { startScheduler } = require("../../../lib/scheduler");
const { startFleets } = require("../../../lib/fleets");
const { buildDefaultServiceDefs } = require("../../../lib/runtime/services");
const { startTreasury, createUnavailableTreasury } = require("../../../lib/economy/treasury");
const { createTreasuryRepository } = require("../../../lib/economy/treasury/treasuryRepository");
const TS = require("../../../lib/economy/treasury/schema");
const { createUnavailableCapsuleers } = require("../../../lib/strategy/capsuleers");
const { createCorpRepository } = require("../../../lib/strategy/capsuleers/corpRepository");
const { createContractRepository } = require("../../../lib/strategy/capsuleers/contractRepository");
const { planReview } = require("../../../lib/strategy/capsuleers/capsuleerRules");
const { paramsOf } = require("../../../lib/strategy/capsuleers/capsuleerService");
const CS = require("../../../lib/strategy/capsuleers/schema");
const { harness: H } = require("../../battle/settlement.test");

const MOD_DIR = path.resolve(__dirname, "..", "..", "..");
const SANSHA = 500019;
const AMARR = 500003;
const CAPS = 500018;
const S = H.S;
const STATION = 60000100;
const CORP_ID = 98000001;
const MEMBERS = Object.freeze([90000001, 90000002, 90000003]);
const FEE = 120000000;
const TREASURY_ISK = 5e12;
const WALLET = 1000000000;
const CRUISERS = Object.freeze([{ hullGroup: "cruiser", count: 3 }]);

function testConfig(capsuleers) {
  const cfg = JSON.parse(JSON.stringify(config.resolveConfig({ modDir: MOD_DIR, env: {} }).config));
  Object.assign(cfg.capsuleers, { enabled: true, maxCorps: 1, maxFoundingsPerReview: 0, maxFleetBuysPerReview: 0,
    stipendIskPerReview: 0, maxDispatchesPerReview: 0 }, capsuleers || {});
  cfg.treasury.enabled = true;
  cfg.limits.maxVirtualFleets = 16;
  return cfg;
}

function amarrGraph(graph) {
  return Object.freeze({ ...graph, getSystem: (id) => {
    const v = graph.getSystem(id);
    return v && id === S.L2 ? Object.freeze({ ...v, factionId: AMARR }) : v;
  } });
}

function boot(opened, shared, cfg) {
  const lines = [];
  const logger = { log: (l) => lines.push(l) };
  const store = opened.store;
  const journal = createJournal({ clock: shared.clock, maxPayloadBytes: cfg.persistence.journalMaxPayloadBytes,
    maxRows: 500 });
  const persistence = { ok: true, store, journal, worldSeed: opened.worldSeed, filePath: "test.sqlite" };
  const sr = startScheduler({ config: cfg, persistence: { ok: true, store }, clock: shared.clock, ids: shared.ids,
    logger, nowMs: () => 0 });
  assert.ok(sr.ok, JSON.stringify(sr));
  const g = amarrGraph(shared.graph);
  const graph = { getGraph: () => ({ ok: true, graph: g }) };
  const fr = startFleets({ config: cfg, persistence, clock: shared.clock, ids: shared.ids, scheduler: sr.scheduler,
    graph, presence: null, views: createViewRegistry(), logger });
  assert.ok(fr.ok, JSON.stringify(fr));
  const tr = startTreasury({ config: cfg, persistence, clock: shared.clock });
  assert.ok(tr.ok, JSON.stringify(tr));
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
  const env = { store, tx, lines, handlers, shared, cfg, fleets: fr.fleets, journal, controllers: new Map([[S.N0,
    SANSHA]]) };
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
    getSystems: (db, ids) => ({ ok: true, systems: ids.filter((id) => env.controllers.has(id)).map((id) => ({
      systemId: id, controllerFactionId: env.controllers.get(id) })), missing: ids.filter((id) =>
      !env.controllers.has(id)) }) } };
  const adapter = { listNpcStationsInSystem: () => ({ ok: true, stations: [] }) };
  const ctx = { config: cfg, persistence, scheduler, fleets: fr.fleets, strategy, virtualCorps, graph, world,
    adapter, views: createViewRegistry(), clock: shared.clock, ids: shared.ids, telemetry: null, liberation: null,
    treasury: tr.treasury };
  const seeded = tx((db) => createTreasuryRepository({ journal, clock: shared.clock }).seedInTx(db, { factionId: AMARR,
    kind: "empire", initialIsk: TREASURY_ISK, at: shared.clock.now() }, TS.seedKey(AMARR)));
  assert.ok(seeded.ok, JSON.stringify(seeded));
  const def = buildDefaultServiceDefs({}).find((d) => d.name === "capsuleers");
  env.started = def.start(ctx, { logger });
  assert.deepStrictEqual(env.started, { ok: true }, lines.join("\n"));
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
  env.contract = () => env.q("SELECT * FROM world_capsuleer_contracts ORDER BY created_at, contract_id").slice(-1)[0];
  env.fleet = (id) => env.q("SELECT * FROM virtual_fleets WHERE fleet_id = ?", id)[0];
  env.op = (id) => env.q("SELECT * FROM world_operations WHERE operation_id = ?", id)[0];
  env.corp = () => env.q("SELECT * FROM world_capsuleer_corps WHERE corp_slot = 1")[0];
  env.treasury = () => env.q("SELECT * FROM world_faction_treasury WHERE faction_id = ?", AMARR)[0];
  env.day = () => env.q("SELECT * FROM world_faction_treasury_days WHERE faction_id = ? ORDER BY day DESC", AMARR)[0];
  env.counters = () => env.ctx.capsuleers.getStatus().counters;
  env.firstRound = () => Math.floor(shared.clock.now() / cfg.capsuleers.reviewPeriodMs) + 1;
  return env;
}

function seedCorp(env, wallet) {
  const corps = createCorpRepository();
  env.tx((db) => {
    const c = corps.createCorp(db, { slot: 1, factionId: CAPS, name: "Corp 1", ticker: "CP1", baseSystemId: S.L1,
      baseStationId: STATION, baseStationCorpId: null, raceFactionId: 500001, iskBalance: wallet, seed: 12,
      at: env.shared.clock.now() });
    assert.ok(c.ok, JSON.stringify(c));
    const a = corps.activate(db, { slot: 1, expectedVersion: 1, corporationId: CORP_ID, ceoCharacterId: MEMBERS[0],
      memberIds: MEMBERS.slice(), name: "Corp 1", ticker: "CP1", at: env.shared.clock.now() });
    assert.ok(a.ok, JSON.stringify(a));
    return a;
  });
}

function newFleet(env, tag, factionId, systemId, fleetRole, composition, corporationId) {
  const r = env.fleets.createFleet({ factionId, currentSystemId: systemId, homeSystemId: systemId, fleetRole,
    ...(corporationId ? { corporationId } : {}), composition: composition.map((e) => ({ ...e })) }, `test:${tag}`);
  assert.ok(r.ok, JSON.stringify(r));
  return r.fleetId;
}

function scene(env, wallet = WALLET) {
  seedCorp(env, wallet);
  const fleetId = newFleet(env, "merc", CAPS, S.L1, "mercenary", CRUISERS, CORP_ID);
  newFleet(env, "patrol", SANSHA, S.L2, "patrol", [{ hullGroup: "frigate", count: 2 }]);
  return fleetId;
}

function redeliver(env, type, key, before) {
  const row = env.q("SELECT * FROM world_scheduled_events WHERE idempotency_key = ?", key)[0];
  const ev = { eventId: row.event_id, eventType: row.event_type, aggregateId: row.aggregate_id, dueAt: row.due_at,
    payload: JSON.parse(row.payload), idempotencyKey: row.idempotency_key, attempts: 0 };
  const res = env.handlers[type](ev, { anchorAt: ev.dueAt });
  assert.ok(res.ok, JSON.stringify(res));
  if (before) before();
  const v = env.tx((db) => res.effect(db, ev));
  res.onCommitted(v);
  return v;
}
const step = (env, trip, round) => redeliver(env, CS.STEP_EVENT, CS.stepKey(trip.trip_id, trip.phase_seq, round));

function destroy(env, fleetId, tag) {
  env.tx((db) => {
    const f = env.fleets.repository.getFleet(db, fleetId).fleet;
    const e = env.fleets.repository.transition(db, { fleetId, expectedVersion: f.version, from: f.state,
      to: "ENGAGED" }, `${tag}:engage`);
    assert.ok(e.ok, JSON.stringify(e));
    const l = env.fleets.repository.applyLosses(db, { fleetId, expectedVersion: e.version,
      losses: f.composition.map((c) => ({ hullGroup: c.hullGroup, typeId: c.typeId, count: c.count })) },
    `${tag}:loss`);
    assert.ok(l.ok && l.destroyed, JSON.stringify(l));
    return l;
  });
}

module.exports = ({ test, skip }) => {
  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  needsDriver("C2 hire: treasury -fee, contract DISPATCHED + merc trip (defense / hold), replay hires nothing "
    + "arrival -> ON_STATION, GUARD steps -> SHIFT_END -> COMPLETED + wallet +fee once, panel; dispatch refused "
    + "(VERSION_CONFLICT) -> fee rolled back, no contract, hireRefused", async () => {
    await H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const env = boot(reopen(), shared, testConfig());
      const C = env.cfg.capsuleers;
      try {
        const fleetId = scene(env);
        const r0 = env.firstRound();
        await env.drive(r0 * C.reviewPeriodMs);
        let trip = env.trip();
        let contract = env.contract();
        const out = env.op(trip.outbound_operation_id);
        assert.deepStrictEqual([trip.kind, trip.state, trip.fleet_id, trip.target_system_id, trip.contract_id,
          out.operation_type, out.objective, out.target_system_id],
        ["merc", "OUTBOUND", fleetId, S.L2, contract.contract_id, "defense", "hold", S.L2]);
        assert.deepStrictEqual([contract.state, contract.kind, contract.employer_faction_id, contract.enemy_faction_id,
          contract.fee_isk, contract.trip_id, contract.paid_isk, contract.guard_ms],
        ["DISPATCHED", "DEFENSE", AMARR, SANSHA, FEE, trip.trip_id, 0, C.mercGuardMs]);
        assert.deepStrictEqual([env.treasury().isk_balance, env.treasury().merc_fee_total, env.day().merc_fees,
          env.counters().hires, env.counters().contractFeeIsk, env.ctx.treasury.getStatus().counters.mercFeeIsk],
        [TREASURY_ISK - FEE, FEE, FEE, 1, FEE, FEE]);
        const again = redeliver(env, CS.REVIEW_EVENT, CS.reviewKey(r0));
        assert.deepStrictEqual([again.hires.length, env.treasury().isk_balance,
          env.n("SELECT count(*) AS n FROM world_capsuleer_contracts")], [0, TREASURY_ISK - FEE, 1]);
        const ta = env.fleet(fleetId).next_action_at;
        await env.drive(ta);
        trip = env.trip();
        contract = env.contract();
        assert.deepStrictEqual([trip.state, trip.ratting_ends_at, contract.state, contract.on_station_at,
          env.counters().contractsOnStation], ["RATTING", ta + C.mercGuardMs, "ON_STATION", ta, 1]);
        await env.drive(ta + C.mercStepMs);
        assert.deepStrictEqual([env.trip().watch_round, env.trip().kills, env.counters().guardSteps], [1, 0, 1]);
        assert.strictEqual(step(env, trip, 0).action, "STALE");
        await env.drive(ta + C.mercGuardMs);
        trip = env.trip();
        contract = env.contract();
        const steps = C.mercGuardMs / C.mercStepMs;
        assert.deepStrictEqual([trip.state, trip.abort_reason, env.op(trip.outbound_operation_id).state,
          contract.state, contract.paid_isk, contract.end_reason, env.corp().isk_balance, env.counters().guardSteps,
          env.counters().contractsCompleted, env.counters().contractPaidIsk],
        ["RETURNING", null, "COMPLETED", "COMPLETED", FEE, "SHIFT_END", WALLET + FEE, steps, 1, FEE]);
        assert.strictEqual(step(env, { ...trip, phase_seq: trip.phase_seq - 1 }, steps - 1).action, "STALE");
        assert.strictEqual(env.corp().isk_balance, WALLET + FEE);
        const view = env.ctx.views.getView("capsuleers").getData();
        assert.deepStrictEqual(view.contracts.map((c) => [c.fleet, c.kind, c.state, c.employer, c.enemy, c.target,
          c.fee, c.paid, c.refunded]), [[fleetId, "DEFENSE", "COMPLETED (SHIFT_END)", AMARR, SANSHA, S.L2, FEE, FEE,
          0]]);
        await env.drive(env.fleet(fleetId).next_action_at);
        assert.strictEqual(env.trip().state, "DOCKED");
        env.controllers.set(S.L2, SANSHA);
        const late = redeliver(env, CS.REVIEW_EVENT, CS.reviewKey(r0));
        assert.deepStrictEqual([late.ok, late.hires.length, env.treasury().isk_balance,
          env.n("SELECT count(*) AS n FROM world_capsuleer_contracts")], [true, 0, TREASURY_ISK - FEE, 1]);
        const repo = createContractRepository({ journal: env.journal, clock: shared.clock });
        const spec = (n) => ({ contractId: `cc_t${n}`, idempotencyKey: `test:c${n}`, slot: 1, fleetId,
          tripId: `ct_t${n}`, employerFactionId: AMARR, enemyFactionId: SANSHA, targetSystemId: S.L2, kind: "RAID", feeIsk: 5,
          guardMs: 60000, signedAt: 0 });
        assert.ok(env.tx((db) => repo.createContract(db, spec(1), "test:c1")).ok);
        const second = env.tx((db) => repo.createContract(db, spec(2), "test:c2"));
        assert.deepStrictEqual([second.ok, second.reason], [false, "CONTRACT_OPEN"]);
      } finally {
        env.stop();
      }
    });

    await H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const env = boot(reopen(), shared, testConfig());
      try {
        const fleetId = scene(env);
        const r0 = env.firstRound();
        shared.clock.set(r0 * env.cfg.capsuleers.reviewPeriodMs);
        const v = redeliver(env, CS.REVIEW_EVENT, CS.reviewKey(r0), () => env.tx((db) => db.prepare(
          "UPDATE virtual_fleets SET version = version + 1 WHERE fleet_id = ?").run(fleetId)));
        assert.deepStrictEqual([v.hires.length, v.hireRefused, v.refusals], [0, 1, ["HIRE_VERSION_CONFLICT"]]);
        assert.deepStrictEqual([env.treasury().isk_balance, env.treasury().merc_fee_total,
          env.n("SELECT count(*) AS n FROM world_capsuleer_contracts"), env.n("SELECT count(*) AS n FROM "
            + "world_capsuleer_trips"), env.n("SELECT count(*) AS n FROM world_operations"), env.counters().hireRefused,
          env.counters().hires], [TREASURY_ISK, 0, 0, 0, 0, 1, 0]);
      } finally {
        env.stop();
      }
    });
  });

  needsDriver("C3 close: LOSE from OUTBOUND -> CANCELLED + refund once; stub treasury -> REFUND_UNAVAILABLE "
    + "without a throw; LOSE on station -> COMPLETED, payout cut at maxIskBalance; safety net closes the contract of "
    + "a terminal trip", async () => {
    await H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const env = boot(reopen(), shared, testConfig());
      try {
        const fleetId = scene(env);
        await env.drive(env.firstRound() * env.cfg.capsuleers.reviewPeriodMs);
        const trip = env.trip();
        destroy(env, fleetId, "c3a");
        const v = step(env, trip, 0);
        const c = env.contract();
        assert.deepStrictEqual([v.action, env.trip().state, c.state, c.refunded_isk, c.paid_isk, c.end_reason,
          env.treasury().isk_balance, env.treasury().merc_refund_total, env.day().merc_refunds],
        ["LOSE", "LOST", "CANCELLED", FEE, 0, "FLEET_DESTROYED", TREASURY_ISK, FEE, FEE]);
        const journal = env.n("SELECT count(*) AS n FROM world_event_journal");
        assert.strictEqual(step(env, trip, 0).action, "STALE");
        assert.deepStrictEqual([env.treasury().isk_balance, env.n("SELECT count(*) AS n FROM world_event_journal"),
          env.counters().contractsCancelled, env.counters().contractRefundIsk,
          env.ctx.treasury.getStatus().counters.mercRefundIsk], [TREASURY_ISK, journal, 1, FEE, FEE]);
      } finally {
        env.stop();
      }
    });

    await H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const env = boot(reopen(), shared, testConfig());
      try {
        const fleetId = scene(env);
        await env.drive(env.firstRound() * env.cfg.capsuleers.reviewPeriodMs);
        const trip = env.trip();
        env.ctx.treasury = createUnavailableTreasury("TREASURY_UNAVAILABLE", "stopped");
        destroy(env, fleetId, "c3b");
        const v = step(env, trip, 0);
        const c = env.contract();
        assert.deepStrictEqual([v.ok, v.action, c.state, c.refunded_isk, c.end_reason, env.treasury().isk_balance,
          env.counters().contractRefundUnavailable], [true, "LOSE", "CANCELLED", 0, "REFUND_UNAVAILABLE",
          TREASURY_ISK - FEE, 1]);
      } finally {
        env.stop();
      }
    });

    await H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const env = boot(reopen(), shared, testConfig({ maxIskBalance: WALLET + 1 }));
      try {
        const fleetId = scene(env);
        await env.drive(env.firstRound() * env.cfg.capsuleers.reviewPeriodMs);
        await env.drive(env.fleet(fleetId).next_action_at);
        const trip = env.trip();
        assert.deepStrictEqual([trip.state, env.contract().state], ["RATTING", "ON_STATION"]);
        destroy(env, fleetId, "c3c");
        const v = step(env, trip, 0);
        const c = env.contract();
        assert.deepStrictEqual([v.action, c.state, c.paid_isk, c.refunded_isk, c.end_reason, env.corp().isk_balance,
          env.treasury().isk_balance, env.counters().contractPayoutCapped],
        ["LOSE", "COMPLETED", 1, 0, "FLEET_DESTROYED", WALLET + 1, TREASURY_ISK - FEE, 1]);
      } finally {
        env.stop();
      }
    });

    await H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const env = boot(reopen(), shared, testConfig());
      try {
        scene(env);
        const r0 = env.firstRound();
        const P = env.cfg.capsuleers.reviewPeriodMs;
        await env.drive(r0 * P);
        const trip = env.trip();
        env.tx((db) => db.prepare("UPDATE world_capsuleer_trips SET state = 'ABORTED', ended_at = ?, end_reason = "
          + "'TEST' WHERE trip_id = ?").run(shared.clock.now(), trip.trip_id));
        await env.drive((r0 + 1) * P);
        const c = env.contract();
        assert.deepStrictEqual([c.state, c.end_reason, c.refunded_isk, env.treasury().isk_balance,
          env.counters().contractsOrphanClosed], ["CANCELLED", "ORPHAN", FEE, TREASURY_ISK, 1]);
      } finally {
        env.stop();
      }
    });
  });

  needsDriver("C4 service: on station, the fleet ENGAGED and released RETREAT -> REFITTING in the base -> "
    + "RETURN DIVERTED, contract COMPLETED with the payout", async () => {
    await H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const env = boot(reopen(), shared, testConfig());
      try {
        const fleetId = scene(env);
        await env.drive(env.firstRound() * env.cfg.capsuleers.reviewPeriodMs);
        await env.drive(env.fleet(fleetId).next_action_at);
        assert.strictEqual(env.contract().state, "ON_STATION");
        const at = shared.clock.now();
        env.tx((db) => {
          const f = env.fleets.repository.getFleet(db, fleetId).fleet;
          const e = env.fleets.repository.transition(db, { fleetId, expectedVersion: f.version, from: "STAGED",
            to: "ENGAGED" }, "c4:engage");
          assert.ok(e.ok, JSON.stringify(e));
          const r = env.fleets.travel.releaseFromBattleInTx(db, { fleetId, expectedVersion: e.version, at,
            disposition: "RETREAT", retreatTargets: [S.L1] }, "c4:release");
          assert.ok(r.ok && r.disposition === "RETREATING", JSON.stringify(r));
          return r;
        });
        await env.drive(env.fleet(fleetId).next_action_at);
        const trip = env.trip();
        const c = env.contract();
        assert.deepStrictEqual([env.fleet(fleetId).state, env.fleet(fleetId).current_system_id, trip.state,
          trip.abort_reason, c.state, c.end_reason, c.paid_isk, env.corp().isk_balance],
        ["REFITTING", S.L1, "RETURNING", "DIVERTED", "COMPLETED", "DIVERTED", FEE, WALLET + FEE]);
      } finally {
        env.stop();
      }
    });
  });

  needsDriver("C5 data: migrations 42 + 43 on a schema 41 file, TABLE_POLICY WIPE, a mercenary buy with a "
    + "running treasury (none without mercBuy: the ratter reserve), facade = stub methods", async () => {
    assert.deepStrictEqual([MIGRATIONS[41].version, MIGRATIONS[41].name, MIGRATIONS[42].version, MIGRATIONS[42].name,
      TABLE_POLICY.world_capsuleer_contracts], [42, "world_capsuleer_contracts", 43, "world_faction_treasury_merc",
      ACTION.WIPE]);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lne-m43-"));
    const file = path.join(tmp, "world.sqlite");
    const stores = [];
    const open = (migrations) => {
      const o = openStore({ filePath: file, openDatabase: (f) => new driver.Database(f), exclusiveLock: true,
        busyTimeoutMs: 0, maxRowsPerTransaction: 500, maxWriteMsPerPass: 5, randomSeed: () => 1, migrations });
      assert.ok(o.ok, JSON.stringify(o));
      stores.push(o.store);
      return o;
    };
    const run = (store, fn) => {
      const r = store.transaction("t", fn);
      assert.ok(r.ok, JSON.stringify(r));
      return r.value;
    };
    if (driver.ok) {
      try {
        const old = open(MIGRATIONS.slice(0, 41));
        assert.strictEqual(old.schemaVersion, 41);
        run(old.store, (db) => {
          db.prepare(`INSERT INTO world_capsuleer_trips (trip_id, idempotency_key, kind, corp_slot, fleet_id,
            origin_system_id, base_system_id, target_system_id, outbound_operation_id, return_operation_id, state,
            phase_seq, watch_round, abort_reason, ratting_started_at, ratting_ends_at, kills, isk_earned, dispatched_at,
            ended_at, end_reason, created_at, updated_at, version) VALUES ('ct_m42', 'k', 'rat', 1, 'fl_1', 1, 1, 2,
            'op_1', NULL, 'OUTBOUND', 0, 0, NULL, NULL, NULL, 0, 0, 5, NULL, NULL, 5, 5, 1)`).run();
          db.prepare(`INSERT INTO world_faction_treasury (faction_id, kind, initial_isk, isk_balance, created_at,
            updated_at, version) VALUES (500003, 'empire', 7, 7, 1, 1, 1)`).run();
          db.prepare(`INSERT INTO world_faction_treasury_days (faction_id, day, balance_end, updated_at)
            VALUES (500003, 3, 7, 1)`).run();
        });
        old.store.close("upgrade");
        const up = open(MIGRATIONS);
        assert.deepStrictEqual([up.schemaVersion, up.applied], [LATEST_SCHEMA_VERSION, LATEST_SCHEMA_VERSION - 41]);
        const got = run(up.store, (db) => ({
          trip: db.prepare("SELECT contract_id FROM world_capsuleer_trips").get().contract_id,
          totals: db.prepare("SELECT merc_fee_total AS f, merc_refund_total AS r FROM world_faction_treasury").get(),
          day: db.prepare("SELECT merc_fees AS f, merc_refunds AS r FROM world_faction_treasury_days").get(),
          master: db.prepare(`SELECT type, name FROM sqlite_master WHERE tbl_name = 'world_capsuleer_contracts'
            ORDER BY type, name`).all().map((x) => `${x.type}:${x.name}`),
          strict: /\)\s*STRICT$/.test(db.prepare(`SELECT sql FROM sqlite_master WHERE name =
            'world_capsuleer_contracts'`).get().sql),
        }));
        assert.deepStrictEqual(got, { trip: null, totals: { f: 0, r: 0 }, day: { f: 0, r: 0 }, master: [
          "index:sqlite_autoindex_world_capsuleer_contracts_1", "index:sqlite_autoindex_world_capsuleer_contracts_2",
          "index:world_capsuleer_contracts_employer", "index:world_capsuleer_contracts_ended",
          "index:world_capsuleer_contracts_open_fleet", "index:world_capsuleer_contracts_state",
          "table:world_capsuleer_contracts"], strict: true });
      } finally {
        for (const s of stores) {
          try {
            s.close("test");
          } catch (_err) {
          }
        }
        fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      }
    }

    const P = paramsOf(testConfig({ maxFleetBuysPerReview: 1 }).capsuleers);
    const corp = { corpSlot: 1, state: "ACTIVE", iskBalance: 5e9, corporationId: CORP_ID, seed: 12,
      memberIds: MEMBERS.slice() };
    const buysOf = (mercBuy) => planReview({ corps: [corp], identities: new Map(),
      fleetsByCorp: new Map([[CORP_ID, 2]]), mercByCorp: new Map(), fleetsTruncated: false, round: 3 }, { ...P, mercBuy }).buys;
    const withMerc = buysOf(true);
    assert.deepStrictEqual([withMerc.length, withMerc[0].fleetRole, /^merc-/.test(withMerc[0].templateId),
      buysOf(false)], [1, "mercenary", true, []]);

    await H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const env = boot(reopen(), shared, testConfig({ maxFleetBuysPerReview: 1 }));
      try {
        seedCorp(env, 5e9);
        newFleet(env, "r1", CAPS, S.L1, "capsuleer", [{ hullGroup: "battleship", count: 1 }], CORP_ID);
        newFleet(env, "r2", CAPS, S.L1, "capsuleer", [{ hullGroup: "battleship", count: 1 }], CORP_ID);
        await env.drive(env.firstRound() * env.cfg.capsuleers.reviewPeriodMs);
        const mercs = env.q("SELECT fleet_role, composition_json FROM virtual_fleets WHERE faction_id = ? AND "
          + "fleet_role = 'mercenary'", CAPS);
        assert.deepStrictEqual([mercs.length, env.counters().mercFleetsBought, env.counters().fleetsBought],
          [1, 1, 1]);
        assert.deepStrictEqual(Object.keys(env.ctx.capsuleers).sort(),
          Object.keys(createUnavailableCapsuleers("TEST")).sort());
        assert.deepStrictEqual([env.ctx.capsuleers.getStatus().contracts, env.ctx.capsuleers.listContracts()], [0, []]);
      } finally {
        env.stop();
      }
    });
  });

  needsDriver("C8: mercenaryEnabled=false -> no merc buy, no hire, treasury unchanged; a contract "
    + "signed with the flag on completes after the switch off; the open contracts of the read hold the empire and "
    + "system limits; a fleet outside its base, a stopped treasury and a fresh TREASURY_LOW give no hire; the guard "
    + "time comes from the contract row", async () => {
    const hireCount = (env) => env.n("SELECT count(*) AS n FROM world_capsuleer_contracts");
    await H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const env = boot(reopen(), shared, testConfig({ mercenaryEnabled: false, maxFleetBuysPerReview: 1 }));
      const P = env.cfg.capsuleers.reviewPeriodMs;
      try {
        seedCorp(env, 5e9);
        newFleet(env, "r1", CAPS, S.L1, "capsuleer", [{ hullGroup: "battleship", count: 1 }], CORP_ID);
        newFleet(env, "r2", CAPS, S.L1, "capsuleer", [{ hullGroup: "battleship", count: 1 }], CORP_ID);
        newFleet(env, "patrol", SANSHA, S.L2, "patrol", [{ hullGroup: "frigate", count: 2 }]);
        const r0 = env.firstRound();
        await env.drive(r0 * P);
        assert.deepStrictEqual([env.n("SELECT count(*) AS n FROM virtual_fleets WHERE faction_id = ? AND fleet_role = "
          + "'mercenary'", CAPS), env.counters().mercFleetsBought], [0, 0]);
        newFleet(env, "merc", CAPS, S.L1, "mercenary", CRUISERS, CORP_ID);
        await env.drive((r0 + 1) * P);
        assert.deepStrictEqual([hireCount(env), env.treasury().isk_balance, env.treasury().merc_fee_total,
          env.counters().hires, env.counters().hireRefused, env.counters().hireNoTreasury], [0, TREASURY_ISK, 0, 0, 0,
          0]);
      } finally {
        env.stop();
      }
    });

    await H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      let env = boot(reopen(), shared, testConfig());
      try {
        const fleetId = scene(env);
        await env.drive(env.firstRound() * env.cfg.capsuleers.reviewPeriodMs);
        assert.strictEqual(env.contract().state, "DISPATCHED");
        env.stop();
        env.store.close("restart");
        env = boot(reopen(), shared, testConfig({ mercenaryEnabled: false }));
        const C = env.cfg.capsuleers;
        const ta = env.fleet(fleetId).next_action_at;
        await env.drive(ta + C.mercGuardMs);
        const c = env.contract();
        assert.deepStrictEqual([hireCount(env), c.state, c.end_reason, c.paid_isk, env.corp().isk_balance,
          env.treasury().isk_balance], [1, "COMPLETED", "SHIFT_END", FEE, WALLET + FEE, TREASURY_ISK - FEE]);
      } finally {
        env.stop();
      }
    });

    for (const limits of [{ maxContractsPerEmpire: 1, mercMaxContractsPerSystem: 2 },
      { maxContractsPerEmpire: 2, mercMaxContractsPerSystem: 1 }]) {
      await H.withStore(driver, async (reopen) => {
        const shared = H.sharedOf();
        const env = boot(reopen(), shared, testConfig({ maxMercenaryFleetsPerCorp: 2, maxContractsPerCorp: 2,
          ...limits }));
        const P = env.cfg.capsuleers.reviewPeriodMs;
        try {
          scene(env);
          newFleet(env, "merc2", CAPS, S.L1, "mercenary", CRUISERS, CORP_ID);
          const r0 = env.firstRound();
          await env.drive(r0 * P);
          assert.strictEqual(hireCount(env), 1, JSON.stringify(limits));
          await env.drive((r0 + 1) * P);
          assert.deepStrictEqual([hireCount(env), env.counters().hires, env.treasury().isk_balance],
            [1, 1, TREASURY_ISK - FEE], JSON.stringify(limits));
        } finally {
          env.stop();
        }
      });
    }

    await H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const env = boot(reopen(), shared, testConfig());
      try {
        seedCorp(env, WALLET);
        newFleet(env, "merc", CAPS, S.L2, "mercenary", CRUISERS, CORP_ID);
        newFleet(env, "patrol", SANSHA, S.L2, "patrol", [{ hullGroup: "frigate", count: 2 }]);
        await env.drive(env.firstRound() * env.cfg.capsuleers.reviewPeriodMs);
        assert.deepStrictEqual([hireCount(env), env.counters().hires, env.counters().hireRefused,
          env.counters().hireNoTreasury, env.treasury().isk_balance], [0, 0, 0, 0, TREASURY_ISK]);
      } finally {
        env.stop();
      }
    });

    await H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const env = boot(reopen(), shared, testConfig());
      try {
        scene(env);
        const stub = createUnavailableTreasury("TREASURY_UNAVAILABLE", "stopped");
        let reads = 0;
        env.ctx.treasury = { ...stub, readMercAccountInDb: (...a) => {
          reads += 1;
          return stub.readMercAccountInDb(...a);
        } };
        await env.drive(env.firstRound() * env.cfg.capsuleers.reviewPeriodMs);
        assert.deepStrictEqual([reads, hireCount(env), env.counters().hireNoTreasury, env.counters().hireRefused],
          [0, 0, 0, 0]);
      } finally {
        env.stop();
      }
    });

    await H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const env = boot(reopen(), shared, testConfig());
      try {
        scene(env);
        const r0 = env.firstRound();
        shared.clock.set(r0 * env.cfg.capsuleers.reviewPeriodMs);
        const low = FEE * 2;
        const v = redeliver(env, CS.REVIEW_EVENT, CS.reviewKey(r0), () => env.tx((db) => db.prepare(
          "UPDATE world_faction_treasury SET isk_balance = ? WHERE faction_id = ?").run(low, AMARR)));
        assert.deepStrictEqual([v.hires.length, v.refusals, hireCount(env), env.treasury().isk_balance,
          env.treasury().merc_fee_total], [0, ["HIRE_TREASURY_LOW"], 0, low, 0]);
      } finally {
        env.stop();
      }
    });

    await H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const env = boot(reopen(), shared, testConfig());
      const C = env.cfg.capsuleers;
      try {
        const fleetId = scene(env);
        await env.drive(env.firstRound() * C.reviewPeriodMs);
        const signed = env.contract().guard_ms;
        C.mercGuardMs = signed * 2;
        const ta = env.fleet(fleetId).next_action_at;
        await env.drive(ta);
        assert.deepStrictEqual([env.trip().state, env.trip().ratting_ends_at], ["RATTING", ta + signed]);
      } finally {
        env.stop();
      }
    });
  });
};
