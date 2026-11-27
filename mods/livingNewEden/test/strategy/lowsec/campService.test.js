"use strict";

const assert = require("node:assert");
const os = require("node:os");
const path = require("node:path");

const config = require("../../../config");
const { createJournal } = require("../../../lib/persistence/journal");
const { MIGRATIONS } = require("../../../lib/persistence/migrations");
const { TABLE_POLICY, ACTION } = require("../../../lib/persistence/worldReset");
const { createViewRegistry } = require("../../../lib/observer/views");
const { startScheduler } = require("../../../lib/scheduler");
const { startFleets } = require("../../../lib/fleets");
const { startStrategy } = require("../../../lib/strategy");
const { jumpMsForComposition } = require("../../../lib/fleets/travel");
const { buildDefaultServiceDefs } = require("../../../lib/runtime/services");
const { REQUIRED, SOFT_ROOTS, startLowsec } = require("../../../lib/strategy/lowsec");
const { createCampRepository } = require("../../../lib/strategy/lowsec/campRepository");
const LS = require("../../../lib/strategy/lowsec/schema");
const { harness: H } = require("../../battle/settlement.test");

const MOD_DIR = path.resolve(__dirname, "..", "..", "..");
const SANSHA = 500019;
const GURISTAS = 500010;
const AMARR = 500003;
const S = H.S;
const COMP = Object.freeze([{ hullGroup: "cruiser", count: 4 }]);

function testConfig(lowsec) {
  const env = lowsec ? {} : { EVEJS_LNE_LOWSEC_ENABLED: "0" };
  const cfg = JSON.parse(JSON.stringify(config.resolveConfig({ modDir: MOD_DIR, env }).config));
  if (lowsec) Object.assign(cfg.lowsec, { enabled: true }, lowsec);
  return cfg;
}

const lowsecDef = () => buildDefaultServiceDefs({}).find((d) => d.name === "lowsec");
const fakeStrategy = () => ({ registry: { listActiveFactions: () => [{ factionId: AMARR, kind: "empire" },
  { factionId: GURISTAS, kind: "pirate" }, { factionId: SANSHA, kind: "pirate" }] },
getStatus: () => ({ state: "running" }) });

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
  const calls = { registerHandler: 0, enqueue: 0 };
  const handlers = {};
  const scheduler = { ...sr.scheduler,
    registerHandler: (type, fn, o) => {
      calls.registerHandler += 1;
      handlers[type] = fn;
      return sr.scheduler.registerHandler(type, fn, o);
    },
    enqueue: (...args) => {
      calls.enqueue += 1;
      return sr.scheduler.enqueue(...args);
    } };
  const fleets = opts.travel ? { ...fr.fleets, travel: { ...fr.fleets.travel, ...opts.travel } } : fr.fleets;
  const ctx = { config: cfg, persistence, scheduler, fleets, strategy: opts.strategy || fakeStrategy(), graph,
    clock: shared.clock, ids: shared.ids, telemetry: null, world: opts.world || null };
  const def = lowsecDef();
  let started = null;
  if (opts.noLowsec !== true) {
    started = def.start(ctx, { logger });
    if (!started.ok) def.onUnavailable(ctx, started.reason);
  }
  const tx = (fn) => {
    const r = store.transaction("test", fn);
    assert.ok(r.ok, JSON.stringify(r));
    return r.value;
  };
  const env = { store, journal, ctx, started, lines, tx, shared, cfg, calls, handlers, scheduler: sr.scheduler,
    fleets: fr.fleets, camps: createCampRepository() };
  env.q = (sql, ...args) => tx((db) => db.prepare(sql).all(...args));
  env.n = (sql, ...args) => env.q(sql, ...args)[0].n;
  env.fleet = (id) => tx((db) => fr.fleets.repository.getFleet(db, id)).fleet;
  env.campRows = () => env.q("SELECT * FROM world_lowsec_camps ORDER BY camp_id");
  env.totals = () => ({ camps: env.n("SELECT count(*) AS n FROM world_lowsec_camps"),
    ops: env.n("SELECT count(*) AS n FROM world_operations"),
    journal: env.n("SELECT count(*) AS n FROM world_event_journal"),
    events: env.n("SELECT count(*) AS n FROM world_scheduled_events") });
  env.stop = () => {
    if (ctx.lowsec) ctx.lowsec.stop("test");
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
  env.planEvent = (round) => {
    const row = env.q("SELECT * FROM world_scheduled_events WHERE idempotency_key = ?", LS.planKey(round))[0];
    return { eventId: row.event_id, eventType: row.event_type, aggregateId: row.aggregate_id, dueAt: row.due_at,
      payload: JSON.parse(row.payload), idempotencyKey: row.idempotency_key };
  };
  env.runPlan = (ev, between) => {
    const res = env.handlers[LS.PLAN_EVENT](ev, { anchorAt: ev.dueAt });
    assert.ok(res.ok, JSON.stringify(res));
    if (between) between();
    const v = tx((db) => res.effect(db, ev));
    res.onCommitted(v);
    return v;
  };
  return env;
}

function newFleet(env, tag, factionId, systemId, fleetRole = "patrol") {
  const r = env.fleets.createFleet({ factionId, currentSystemId: systemId, homeSystemId: systemId, fleetRole,
    composition: COMP }, `test:${tag}`);
  assert.ok(r.ok, JSON.stringify(r));
  return r.fleetId;
}

const planRound = (env) => Math.floor(env.shared.clock.now() / env.cfg.lowsec.planPeriodMs) + 1;

module.exports = ({ test, skip }) => {
  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  needsDriver("LSC1 flag off: stub, no handler / enqueue, no lowsec:% event, no camp row; fleet events of a "
    + "trip equal a run without the module; migration 38 WIPE, 18 keys, 2 warnings", async () => {
      const tripRows = (noLowsec) => H.withStore(driver, async (reopen) => {
        const shared = H.sharedOf();
        const env = boot(reopen(), shared, testConfig(), { noLowsec });
        try {
          const f = newFleet(env, "trip", SANSHA, S.N0);
          const op = env.fleets.createOperation({ operationType: "patrol", factionId: SANSHA, originSystemId: S.N0,
            targetSystemId: S.L2, objective: "patrol", dueAt: shared.clock.now() + 3600000,
            fleets: [{ fleetId: f, expectedVersion: 1 }] }, "test:op");
          assert.ok(op.ok, JSON.stringify(op));
          const p = env.fleets.planTravel({ fleetId: f, targetSystemId: S.L2 }, "test:plan");
          assert.ok(p.ok, JSON.stringify(p));
          await env.drive(shared.clock.now() + 3600000 + 1000);
          const fl = env.fleet(f);
          return { started: env.started, mode: env.ctx.lowsec ? env.ctx.lowsec.getMode() : null,
            reason: env.ctx.lowsec ? env.ctx.lowsec.getStatus().reason : null, calls: { ...env.calls },
            camps: env.n("SELECT count(*) AS n FROM world_lowsec_camps"),
            rows: env.q("SELECT event_type, idempotency_key, due_at, state, outcome FROM world_scheduled_events "
              + "ORDER BY idempotency_key"), fleet: [fl.state, fl.currentSystemId, fl.version, fl.operationId] };
        } finally {
          env.stop();
        }
      });
      assert.strictEqual(config.SCHEMA.find((r) => r.key === "lowsec.enabled").default, true);
      assert.strictEqual(testConfig().lowsec.enabled, false);
      const without = await tripRows(true);
      const off = await tripRows(false);
      assert.deepStrictEqual([off.started.ok, off.started.reason], [false, "disabled_by_config"]);
      assert.deepStrictEqual([off.mode, off.reason], ["off", "LOWSEC_DISABLED"]);
      assert.deepStrictEqual(off.calls, { registerHandler: 0, enqueue: 0 });
      assert.strictEqual(startLowsec({ config: testConfig() }).reason, "disabled_by_config");
      assert.deepStrictEqual(off.rows.filter((r) => r.idempotency_key.startsWith("lowsec:")), []);
      assert.strictEqual(off.camps, 0);
      assert.ok(off.rows.some((r) => r.event_type === "FLEET_ARRIVAL" && r.state === "DONE"), JSON.stringify(off.rows));
      assert.deepStrictEqual(off.rows, without.rows);
      assert.deepStrictEqual(off.fleet, without.fleet);
      assert.deepStrictEqual([MIGRATIONS[37].version, MIGRATIONS[37].name], [38, "world_lowsec_camps"]);
      assert.strictEqual(TABLE_POLICY.world_lowsec_camps, ACTION.WIPE);
      assert.strictEqual(config.SCHEMA.filter((r) => r.key.startsWith("lowsec.")).length, 22);
      const res = config.resolveConfig({ modDir: MOD_DIR, env: { EVEJS_DATA_ROOT: os.tmpdir(),
        EVEJS_LNE_LOWSEC_CAMP_MIN_MS: "600000", EVEJS_LNE_LOWSEC_CAMP_MAX_MS: "300000",
        EVEJS_LNE_LOWSEC_STEP_INTERVAL_MS: "600000" } });
      assert.deepStrictEqual(res.warnings.filter((w) => w.startsWith("lowsec.")).map((w) => w.split(" ")[0]),
        ["lowsec.campMinMs=600000", "lowsec.stepIntervalMs=600000"]);
    });

  needsDriver("LSC2 plan: camp PLANNED, op camp/patrol dueAt = until_at, fleet TRAVELLING, first step at "
    + "arrive_at = at + eta; the replayed plan event -> duplicate, zero new rows", () => H.withStore(driver,
    async (reopen) => {
      const shared = H.sharedOf();
      const env = boot(reopen(), shared, testConfig({}));
      try {
        assert.deepStrictEqual(env.started, { ok: true }, env.lines.join("\n"));
        assert.deepStrictEqual(env.calls.registerHandler, 3, "PLAN, STEP, AMBUSH");
        const f1 = newFleet(env, "s1", SANSHA, S.N0);
        newFleet(env, "s2", SANSHA, S.N0);
        newFleet(env, "amarr", AMARR, S.N0);
        const round = planRound(env);
        const at = round * env.cfg.lowsec.planPeriodMs;
        await env.drive(at);
        const camps = env.campRows();
        assert.strictEqual(camps.length, 1, JSON.stringify(env.ctx.lowsec.getStatus()));
        const c = camps[0];
        assert.deepStrictEqual([c.state, c.faction_id, c.fleet_id, c.planned_at], ["PLANNED", SANSHA, f1, at]);
        assert.ok([S.L1, S.L2].includes(c.system_id), String(c.system_id));
        const op = env.fleets.getOperation(c.operation_id).operation;
        assert.deepStrictEqual([op.operationType, op.objective, op.dueAt, op.targetSystemId, op.state],
          ["camp", "patrol", c.until_at, c.system_id, "ACTIVE"]);
        const fleet = env.fleet(f1);
        assert.deepStrictEqual([fleet.state, fleet.targetSystemId, fleet.operationId],
          ["TRAVELLING", c.system_id, c.operation_id]);
        const detail = JSON.parse(c.detail_json);
        const base = jumpMsForComposition(COMP, { timeFactor: env.cfg.fleets.travelTimeFactor });
        const eta = detail.jumps * Math.max(1, shared.clock.travelDurationMs(base.baseJumpMs, { observed: false }));
        assert.deepStrictEqual([c.arrive_at, fleet.nextActionAt, c.until_at],
          [at + eta, at + eta, at + eta + detail.durationMs]);
        const step = env.q("SELECT due_at, payload, state FROM world_scheduled_events WHERE idempotency_key = ?",
          LS.stepKey(c.camp_id, 0))[0];
        assert.deepStrictEqual([step.due_at, JSON.parse(step.payload), step.state],
          [c.arrive_at, { campId: c.camp_id, stepSeq: 0, round: 0 }, "QUEUED"]);
        assert.strictEqual(env.q("SELECT state FROM world_scheduled_events WHERE idempotency_key = ?",
          LS.planKey(round + 1))[0].state, "QUEUED");
        assert.strictEqual(env.ctx.lowsec.getStatus().counters.campsPlanned, 1);
        const before = env.totals();
        const v = env.runPlan(env.planEvent(round));
        assert.deepStrictEqual([v.created.length, v.duplicates, v.refused], [0, 1, []]);
        assert.deepStrictEqual(env.totals(), before);
      } finally {
        env.stop();
      }
    }));

  needsDriver("LSC3 limits: maxActiveCamps 1 -> 1 camp; perFaction 1 + perPlan 2 -> 1 per faction, next "
    + "round FACTION_LIMIT; until_at <= at does not count; a camp between read and effect -> LIMIT", async () => {
    await H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const env = boot(reopen(), shared, testConfig({ maxActiveCampsPerFaction: 1, maxCampsPerPlan: 2 }));
      try {
        for (const [tag, f] of [["s1", SANSHA], ["s2", SANSHA], ["g1", GURISTAS], ["g2", GURISTAS]]) {
          newFleet(env, tag, f, S.N0);
        }
        const round = planRound(env);
        const at = round * env.cfg.lowsec.planPeriodMs;
        await env.drive(at);
        assert.deepStrictEqual(env.campRows().map((c) => c.faction_id).sort(), [GURISTAS, SANSHA]);
        assert.deepStrictEqual(new Set(env.campRows().map((c) => c.system_id)).size, 2);
        const ev = { ...env.planEvent(round), payload: { round: round + 7 }, idempotencyKey: LS.planKey(round + 7) };
        const v = env.runPlan(ev);
        assert.deepStrictEqual([v.created.length, env.campRows().length], [0, 2]);
        assert.strictEqual(env.ctx.lowsec.getStatus().skipByReason.FACTION_LIMIT, 2);
      } finally {
        env.stop();
      }
    });

    await H.withStore(driver, async (reopen) => {
      const shared2 = H.sharedOf();
      const env2 = boot(reopen(), shared2, testConfig({ maxActiveCamps: 1 }));
      try {
        const round = planRound(env2);
        const at = round * env2.cfg.lowsec.planPeriodMs;
        const dead = env2.tx((db) => env2.camps.createCamp(db, { campId: "lc_dead", factionId: SANSHA,
          fleetId: "fleet_dead", operationId: "op_dead", systemId: S.ISO, seed: 1, plannedAt: at - 3000,
          arriveAt: at - 2000, untilAt: at }, "test:dead"));
        assert.ok(dead.ok, JSON.stringify(dead));
        for (const [tag, f] of [["b-s1", SANSHA], ["b-g1", GURISTAS]]) newFleet(env2, tag, f, S.N0);
        await env2.drive(at);
        const live = env2.campRows().filter((c) => c.camp_id !== "lc_dead");
        assert.deepStrictEqual(live.map((c) => c.faction_id), [GURISTAS]);
        assert.strictEqual(env2.ctx.lowsec.getStatus().skipByReason.LIMIT, 1);
        env2.tx((db) => db.prepare("DELETE FROM world_lowsec_camps WHERE camp_id <> 'lc_dead'").run());
        newFleet(env2, "b-s2", SANSHA, S.N0);
        const opsBefore = env2.n("SELECT count(*) AS n FROM world_operations");
        const ev = { ...env2.planEvent(round), payload: { round: round + 9 }, idempotencyKey: LS.planKey(round + 9) };
        const v = env2.runPlan(ev, () => {
          const w = env2.tx((db) => env2.camps.createCamp(db, { campId: "lc_live", factionId: AMARR,
            fleetId: "fleet_live", operationId: "op_live", systemId: S.ISO + 100, seed: 1, plannedAt: at,
            arriveAt: at, untilAt: at + 3600000 }, "test:live"));
          assert.ok(w.ok, JSON.stringify(w));
        });
        assert.deepStrictEqual([v.created.length, v.refused], [0, ["LIMIT"]]);
        assert.strictEqual(env2.n("SELECT count(*) AS n FROM world_operations"), opsBefore);
      } finally {
        env2.stop();
      }
    });
  });

  needsDriver("LSC4 machine end-to-end: arrival -> ACTIVE, KEEP, until_at -> ENDED/EXPIRED and fleet IDLE "
    + "stale stepSeq -> STALE", () => H.withStore(driver, async (reopen) => {
    const shared = H.sharedOf();
    const env = boot(reopen(), shared, testConfig({ campMinMs: 900000, campMaxMs: 900000 }));
    try {
      const f = newFleet(env, "s1", SANSHA, S.N0);
      const round = planRound(env);
      await env.drive(round * env.cfg.lowsec.planPeriodMs);
      const c0 = env.campRows()[0];
      await env.drive(c0.arrive_at);
      const c1 = env.campRows()[0];
      assert.deepStrictEqual([c1.state, c1.active_from, c1.step_seq, env.fleet(f).state],
        ["ACTIVE", c0.arrive_at, 1, "STAGED"]);
      const res = env.handlers[LS.STEP_EVENT]({ eventType: LS.STEP_EVENT, dueAt: c1.arrive_at,
        payload: { campId: c1.camp_id, stepSeq: 0, round: 0 }, idempotencyKey: "test:stale" });
      assert.deepStrictEqual([res.ok, res.outcome, res.effect], [true, "STALE", undefined]);
      await env.drive(c0.until_at + 1000);
      const c2 = env.campRows()[0];
      assert.deepStrictEqual([c2.state, c2.outcome, c2.end_reason, c2.ended_at], ["ENDED", "EXPIRED", "EXPIRED",
        c0.until_at]);
      assert.ok(c2.step_seq > 2, String(c2.step_seq));
      assert.strictEqual(env.fleet(f).state, "IDLE");
      const st = env.ctx.lowsec.getStatus().counters;
      assert.deepStrictEqual([st.campsPlanned, st.campsActivated, st.campsExpired], [1, 1, 1]);
    } finally {
      env.stop();
    }
  }));

  needsDriver("LSC5 restart: ACTIVE camp without a step -> 1 reconcile step, second start none; a throw "
    + "after createOperation -> no operation, row nor step", async () => {
    const cfg = testConfig({});
    await H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      let env = boot(reopen(), shared, cfg, { noLowsec: true });
      const at = shared.clock.now();
      env.tx((db) => {
        const c = env.camps.createCamp(db, { campId: "lc_r", factionId: SANSHA, fleetId: "fleet_r",
          operationId: "op_r", systemId: S.L1, seed: 1, plannedAt: at - 2000, arriveAt: at - 1000,
          untilAt: at + 3600000 }, "test:r");
        assert.ok(c.ok, JSON.stringify(c));
        const t = env.camps.transitionCamp(db, { campId: "lc_r", expectedVersion: 1, from: "PLANNED", to: "ACTIVE",
          patch: { activeFrom: at - 1000, stepSeq: 3, watchRound: 0 } });
        assert.ok(t.ok, JSON.stringify(t));
      });
      const recRows = (e) => e.q("SELECT idempotency_key, payload, state FROM world_scheduled_events WHERE "
        + "idempotency_key LIKE 'lowsec:rec:%'").map((r) => ({ ...r, payload: JSON.parse(r.payload) }));
      const restart = () => {
        env.stop();
        env.store.close("restart");
        env = boot(reopen(), shared, cfg);
      };
      try {
        restart();
        assert.deepStrictEqual(recRows(env), [{ idempotency_key: `${LS.recBaseKey("lc_r", 3)}:0`,
          payload: { campId: "lc_r", stepSeq: 3, round: 0 }, state: "QUEUED" }]);
        restart();
        assert.strictEqual(recRows(env).length, 1);
      } finally {
        env.stop();
      }
    });

    await H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const env = boot(reopen(), shared, cfg, { travel: { planInTx: () => {
        throw new Error("boom");
      } } });
      try {
        const opsBefore = env.n("SELECT count(*) AS n FROM world_operations");
        const f = newFleet(env, "x1", SANSHA, S.N0);
        const round = planRound(env);
        await env.drive(round * cfg.lowsec.planPeriodMs);
        assert.deepStrictEqual([env.n("SELECT count(*) AS n FROM world_operations"), env.campRows().length,
          env.n("SELECT count(*) AS n FROM world_scheduled_events WHERE event_type = ?", LS.STEP_EVENT)],
        [opsBefore, 0, 0]);
        assert.deepStrictEqual([env.fleet(f).state, env.fleet(f).operationId], ["IDLE", null]);
        assert.strictEqual(env.q("SELECT state FROM world_scheduled_events WHERE idempotency_key = ?",
          LS.planKey(round))[0].state, "DONE");
        const st = env.ctx.lowsec.getStatus();
        assert.ok(String(st.lastRefusal).includes("boom"), JSON.stringify(st));
        assert.strictEqual(st.skipByReason.PLAN_REFUSED, 1);
      } finally {
        env.stop();
      }
    });
  });

  needsDriver("LSC6 REQUIRED paths on the real facades (fleets, scheduler, persistence, strategy registry)",
    () => H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const opened = reopen();
      const cfg = testConfig({});
      const journal = createJournal({ clock: shared.clock, maxPayloadBytes: 16384, maxRows: 500 });
      const st = startStrategy({ config: cfg, persistence: { ok: true, store: opened.store, journal,
        worldSeed: opened.worldSeed }, clock: shared.clock, views: createViewRegistry(), graph: null,
      logger: { log() {} } });
      assert.ok(st.ok, JSON.stringify(st));
      const env = boot(opened, shared, cfg, { strategy: st.strategy });
      try {
        assert.notStrictEqual(env.ctx.strategy.registry, null);
        assert.deepStrictEqual(env.started, { ok: true }, env.lines.join("\n"));
        assert.strictEqual(env.ctx.lowsec.getMode(), "ready");
        const roots = { fleets: env.ctx.fleets, scheduler: env.scheduler, persistence: env.ctx.persistence,
          strategy: env.ctx.strategy, clock: env.ctx.clock, ids: env.ctx.ids };
        for (const p of REQUIRED.filter((x) => !SOFT_ROOTS.includes(x.split(".")[0]))) {
          const v = p.split(".").reduce((o, k) => (o ? o[k] : undefined), roots);
          assert.strictEqual(typeof v, "function", p);
        }
        env.ctx.lowsec.stop("test");
        assert.strictEqual(env.ctx.lowsec.getMode(), "off");
      } finally {
        env.stop();
        st.strategy.stop("test");
      }
    }));

  const deadCamp = (env, f, systemId, at) => env.tx((db) => {
    const r = env.camps.createCamp(db, { campId: "lc_dead", factionId: SANSHA, fleetId: f, operationId: "op_dead",
      systemId, seed: 1, plannedAt: at - 3000, arriveAt: at - 2000, untilAt: at }, "test:dead");
    assert.ok(r.ok, JSON.stringify(r));
  });
  const campsOf = (env) => env.campRows().map((c) => [c.camp_id === "lc_dead" ? "dead" : "new", c.fleet_id,
    c.system_id, c.state, c.end_reason]);

  needsDriver("LSC7: overdue camp on the first fleet -> closed by the plan run and the camp goes to the "
    + "second fleet; reconcile exhausted -> fleet and system of the dead camp excluded, start logs exhausted=1",
  async () => {
    await H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const env = boot(reopen(), shared, testConfig({}));
      try {
        const f1 = newFleet(env, "s1", SANSHA, S.N0);
        const f2 = newFleet(env, "s2", SANSHA, S.N0);
        assert.ok(f1 < f2);
        const at = planRound(env) * env.cfg.lowsec.planPeriodMs;
        deadCamp(env, f1, S.ISO, at);
        await env.drive(at);
        const rows = campsOf(env);
        assert.deepStrictEqual(rows[0], ["dead", f1, S.ISO, "ENDED", "TIMEOUT"], JSON.stringify(rows));
        assert.deepStrictEqual(rows.slice(1).map((r) => [r[1], r[3]]), [[f2, "PLANNED"]], JSON.stringify(rows));
        const st = env.ctx.lowsec.getStatus();
        assert.deepStrictEqual([st.counters.campsPlanned, st.skipByReason.PLAN_REFUSED, st.lastRefusal], [1, 0, null]);
        assert.ok(env.lines.includes("lowsec: plan overdue=1 reconciled=1 exhausted=0 refused=0"),
          env.lines.join("\n"));
      } finally {
        env.stop();
      }
    });

    await H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const cfg = testConfig({ reconcileMaxAttempts: 1 });
      let env = boot(reopen(), shared, cfg);
      try {
        const f1 = newFleet(env, "s1", SANSHA, S.N0);
        const f2 = newFleet(env, "s2", SANSHA, S.N0);
        const at = planRound(env) * cfg.lowsec.planPeriodMs;
        deadCamp(env, f1, S.L2, at);
        const spent = env.scheduler.enqueue(LS.STEP_EVENT, "lc_dead", at - 1000, { campId: "lc_dead", stepSeq: 9,
          round: 0 }, `${LS.recBaseKey("lc_dead", 0)}:0`);
        assert.ok(spent.ok, JSON.stringify(spent));
        await env.drive(at + 2 * cfg.lowsec.planPeriodMs);
        const rows = campsOf(env);
        assert.deepStrictEqual(rows[0], ["dead", f1, S.L2, "PLANNED", null], JSON.stringify(rows));
        assert.deepStrictEqual(rows.slice(1).map((r) => [r[1], r[2]]), [[f2, S.L1]], JSON.stringify(rows));
        const st = env.ctx.lowsec.getStatus();
        assert.deepStrictEqual([st.counters.campsPlanned, st.skipByReason.PLAN_REFUSED], [1, 0], JSON.stringify(st));
        env.stop();
        env.store.close("restart");
        env = boot(reopen(), shared, cfg);
        const line = env.lines.find((l) => l.startsWith("lowsec: running "));
        assert.ok(/ reconciled=0 exhausted=1 refused=0$/.test(line), String(line));
      } finally {
        env.stop();
      }
    });
  });

  test("LSC8: lowsec.reconcileMaxAttempts default 8, env value, clamp 1..64", () => {
    const resolve = (v) => config.resolveConfig({ modDir: MOD_DIR, env: { EVEJS_DATA_ROOT: os.tmpdir(),
      ...(v === undefined ? {} : { EVEJS_LNE_LOWSEC_RECONCILE_MAX_ATTEMPTS: v }) } }).config.lowsec
      .reconcileMaxAttempts;
    assert.deepStrictEqual([resolve(undefined), resolve("3"), resolve("99"), resolve("0")], [8, 3, 64, 1]);
  });

  needsDriver("LSC9 reconcileMaxCamps 1, three overdue camps a<b<c: the first plan reconciles a "
    + "and b (second page), the next plan c (cursor), not b again", () => H.withStore(driver, async (reopen) => {
    const shared = H.sharedOf();
    const env = boot(reopen(), shared, testConfig({ reconcileMaxCamps: 1 }));
    try {
      const round = planRound(env) + 7;
      const at = round * env.cfg.lowsec.planPeriodMs;
      shared.clock.set(at);
      for (const [id, sys] of [["lc_a", S.ISO], ["lc_b", S.L2], ["lc_c", S.L1]]) {
        env.tx((db) => {
          const r = env.camps.createCamp(db, { campId: id, factionId: SANSHA, fleetId: `fleet_${id}`,
            operationId: `op_${id}`, systemId: sys, seed: 1, plannedAt: at - 3000, arriveAt: at - 2000, untilAt: at },
          `test:${id}`);
          assert.ok(r.ok, JSON.stringify(r));
        });
      }
      const steps = () => env.q("SELECT aggregate_id FROM world_scheduled_events WHERE event_type = ? "
        + "ORDER BY aggregate_id", LS.STEP_EVENT).map((r) => r.aggregate_id);
      const plan = (r) => env.runPlan({ eventId: `test-plan-${r}`, eventType: LS.PLAN_EVENT,
        aggregateId: "lowsec", dueAt: r * env.cfg.lowsec.planPeriodMs, payload: { round: r },
        idempotencyKey: LS.planKey(r) });
      plan(round);
      const after1 = steps();
      plan(round + 1);
      const after2 = steps();
      const logs = env.lines.filter((l) => l.startsWith("lowsec: plan overdue="));
      assert.deepStrictEqual({ after1, after2, logs }, { after1: ["lc_a", "lc_b"], after2: ["lc_a", "lc_b", "lc_c"],
        logs: ["lowsec: plan overdue=2 reconciled=2 exhausted=0 refused=0",
          "lowsec: plan overdue=2 reconciled=1 exhausted=0 refused=0"] });
    } finally {
      env.stop();
    }
  }));

  needsDriver("LSC10 fleetScanMax counts IDLE fleets of a camp role; more IDLE fleets of "
    + "other roles with lower ids than the limit do not hide the patrol fleet (was NO_FLEET)",
  () => H.withStore(driver, async (reopen) => {
    const shared = H.sharedOf();
    const env = boot(reopen(), shared, testConfig({ fleetScanMax: 2 }));
    try {
      assert.deepStrictEqual(env.started, { ok: true }, env.lines.join("\n"));
      const others = ["r1", "r2", "r3"].map((tag) => newFleet(env, tag, SANSHA, S.N0, "reserve"));
      const f = newFleet(env, "p1", SANSHA, S.N0);
      assert.ok(others.every((id) => id < f), JSON.stringify({ others, f }));
      const round = planRound(env);
      await env.drive(round * env.cfg.lowsec.planPeriodMs);
      const camps = env.campRows();
      const status = env.ctx.lowsec.getStatus();
      assert.deepStrictEqual([camps.map((c) => [c.faction_id, c.fleet_id]), status.skipByReason.NO_FLEET || 0],
        [[[SANSHA, f]], 1], JSON.stringify(status));
    } finally {
      env.stop();
    }
  }));

  needsDriver("LSC11 a patrol fleet in an own INVASION claim is no camp candidate; "
    + "an expired claim (age >= claimHoldMaxMs) or claimHoldEnabled=false -> it camps as before", async () => {
    const run = (sinceAgo, enabled) => H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const cfg = testConfig({});
      cfg.strategy.claimHoldEnabled = enabled;
      const round = planRound({ shared, cfg }) + 3;
      const at = round * cfg.lowsec.planPeriodMs;
      const reads = [];
      const world = { repository: { listByOccupier: (db, factionId, o) => {
        reads.push([factionId, o.limit]);
        return { ok: true, nextAfterSystemId: null, systems: factionId !== SANSHA ? [] : [{ systemId: S.N0,
          occupationState: "INVASION", occupierFactionId: SANSHA, lastStateChangeAt: at - sinceAgo }] };
      } } };
      const env = boot(reopen(), shared, cfg, { world });
      try {
        assert.deepStrictEqual(env.started, { ok: true }, env.lines.join("\n"));
        const f = newFleet(env, "holder", SANSHA, S.N0);
        shared.clock.set(at);
        env.runPlan({ eventId: `test-plan-${round}`, eventType: LS.PLAN_EVENT, aggregateId: "lowsec", dueAt: at,
          payload: { round }, idempotencyKey: LS.planKey(round) });
        return { camps: env.campRows().map((c) => c.fleet_id), f, reads, state: env.fleet(f).state };
      } finally {
        env.stop();
      }
    });
    const maxMs = testConfig().strategy.claimHoldMaxMs;
    const held = await run(1000, true);
    assert.deepStrictEqual([held.camps, held.state], [[], "IDLE"]);
    assert.ok(held.reads.some(([fid, limit]) => fid === SANSHA && limit === testConfig().strategy.maxOpenOperationsRead),
      JSON.stringify(held.reads));
    const expired = await run(maxMs, true);
    assert.deepStrictEqual(expired.camps, [expired.f]);
    const off = await run(1000, false);
    assert.deepStrictEqual([off.camps, off.reads], [[off.f], []]);
  });
};
