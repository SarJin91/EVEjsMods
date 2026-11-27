"use strict";

const assert = require("node:assert");
const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");

const config = require("../../../config");
const { readStaticMapFrom } = require("../../../lib/adapter/staticMap");
const { buildUniverseGraph } = require("../../../lib/graph/universeGraph");
const { createRouteFinder } = require("../../../lib/graph/routes");
const { startWormholes } = require("../../../lib/graph/wormholes");
const { createJournal } = require("../../../lib/persistence/journal");
const { MIGRATIONS, LATEST_SCHEMA_VERSION } = require("../../../lib/persistence/migrations");
const { TABLE_POLICY, ACTION } = require("../../../lib/persistence/worldReset");
const { createViewRegistry } = require("../../../lib/observer/views");
const { startScheduler } = require("../../../lib/scheduler");
const { startFleets } = require("../../../lib/fleets");
const { startStrategy } = require("../../../lib/strategy");
const { buildDefaultServiceDefs } = require("../../../lib/runtime/services");
const { REQUIRED, SOFT_ROOTS, GRAPH_METHODS, startExpeditions } = require("../../../lib/strategy/expeditions");
const { createExpeditionRepository } = require("../../../lib/strategy/expeditions/expeditionRepository");
const X = require("../../../lib/strategy/expeditions/schema");
const { loadSecurityBand } = require("../../graph/fixtures/staticMap.fixture");
const { S, rawWorld } = require("../../graph/fixtures/routeMap.fixture");
const { harness: H } = require("../../battle/settlement.test");

const MOD_DIR = path.resolve(__dirname, "..", "..", "..");
const SANSHA = 500019;
const AMARR = 500003;
const J1 = 31000001;
const J2 = 31000002;
const COMP = Object.freeze([{ hullGroup: "cruiser", count: 4 }]);
const PAIR_A = "11@1700";
const PAIR_B = "12@1700";
const PAIR_C = "13@1700";
const PAIR_D = "14@1700";
const HOUR = 3600000;

function testConfig(ex) {
  const env = ex ? {} : { EVEJS_LNE_EXPEDITIONS_ENABLED: "0" };
  const cfg = JSON.parse(JSON.stringify(config.resolveConfig({ modDir: MOD_DIR, env }).config));
  Object.assign(cfg.wormholes, { enabled: true, minRemainingMs: 0 });
  if (ex) Object.assign(cfg.expeditions, { enabled: true, expeditionMinMs: HOUR, expeditionMaxMs: HOUR }, ex);
  return cfg;
}

function worldWithJSpace() {
  const w = rawWorld();
  for (const id of [J1, J2]) {
    w.solarSystems.push({ regionID: 11000001, constellationID: 21000001, solarSystemID: id, solarSystemName: `J${id}`,
      security: -0.99, factionID: 0, radius: 1 });
  }
  return w;
}

function composedGraph() {
  const read = readStaticMapFrom({ ensureLoaded: () => worldWithJSpace() }, loadSecurityBand());
  assert.ok(read.ok, JSON.stringify(read));
  const built = buildUniverseGraph(read.map);
  assert.ok(built.ok);
  const finder = createRouteFinder(built.graph, { cacheSize: 64, maxJumps: 40 });
  return Object.freeze({ ...built.graph, ...finder.publicApi });
}

const pair = (pairKey, from, to) => Object.freeze({ pairKey, pairId: Number(pairKey.split("@")[0]),
  fromSystemId: from, toSystemId: to, active: true, createdAt: 1700, expiresAt: 0, collapseAt: 0, maxJumpMass: 0 });
const noTimer = () => ({ cancel() {}, hasRef: () => false });
const tick = async () => {
  for (let i = 0; i < 4; i += 1) await Promise.resolve();
};
const fakeStrategy = () => ({ registry: { listActiveFactions: () => [{ factionId: AMARR, kind: "empire" },
  { factionId: SANSHA, kind: "pirate" }] }, getStatus: () => ({ state: "running" }) });
const expeditionsDef = () => buildDefaultServiceDefs({}).find((d) => d.name === "expeditions");

async function boot(opened, shared, cfg, pairs, opts = {}) {
  const lines = [];
  const logger = { log: (l) => lines.push(l) };
  const store = opened.store;
  const graph = composedGraph();
  const journal = createJournal({ clock: shared.clock, maxPayloadBytes: cfg.persistence.journalMaxPayloadBytes,
    maxRows: 500 });
  const persistence = { ok: true, store, journal, worldSeed: opened.worldSeed, filePath: "test.sqlite" };
  const sr = startScheduler({ config: cfg, persistence: { ok: true, store }, clock: shared.clock, ids: shared.ids,
    logger, nowMs: () => 0 });
  assert.ok(sr.ok, JSON.stringify(sr));
  const env = { lines, shared, cfg, pairs, whOverride: null };
  let realWh = null;
  const getWormholes = () => env.whOverride || realWh;
  const graphFacade = { getGraph: () => ({ ok: true, graph }) };
  const fr = startFleets({ config: cfg, persistence, clock: shared.clock, ids: shared.ids, scheduler: sr.scheduler,
    graph: graphFacade, presence: null, views: createViewRegistry(), getWormholes, logger });
  assert.ok(fr.ok, JSON.stringify(fr));
  const wr = startWormholes({ config: cfg, clock: shared.clock, setTimer: noTimer, logger,
    adapter: { readWormholePairs: () => ({ ok: true, version: 4, skipped: 0, pairs: pairs.list }) },
    graph: { whenReady: () => Promise.resolve({ ok: true, graph }) }, getFleets: () => fr.fleets });
  assert.ok(wr.ok, JSON.stringify(wr));
  realWh = wr.wormholes;
  await tick();
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
  const fleets = opts.travel ? { ...fr.fleets, travel: { ...fr.fleets.travel, ...opts.travel(fr.fleets.travel) } }
    : fr.fleets;
  const ctx = { config: cfg, persistence, scheduler, fleets, strategy: opts.strategy || fakeStrategy(),
    graph: graphFacade, clock: shared.clock, ids: shared.ids, telemetry: null, views: opts.views || null };
  Object.defineProperty(ctx, "wormholes", { get: getWormholes, enumerable: true });
  const tx = (fn) => {
    const r = store.transaction("test", fn);
    assert.ok(r.ok, JSON.stringify(r));
    return r.value;
  };
  Object.assign(env, { store, journal, ctx, tx, calls, handlers, graph, scheduler: sr.scheduler, fleets: fr.fleets,
    wormholes: wr.wormholes, repo: createExpeditionRepository() });
  env.sync = () => {
    const r = wr.wormholes.syncNow();
    assert.strictEqual(r.ok, true, JSON.stringify(r));
  };
  env.sync();
  const def = expeditionsDef();
  env.started = null;
  if (opts.noStart !== true) {
    env.started = def.start(ctx, { logger });
    if (!env.started.ok) def.onUnavailable(ctx, env.started.reason);
  }
  env.q = (sql, ...args) => tx((db) => db.prepare(sql).all(...args).map((r) => ({ ...r })));
  env.n = (sql, ...args) => env.q(sql, ...args)[0].n;
  env.fleet = (id) => tx((db) => fr.fleets.repository.getFleet(db, id)).fleet;
  env.rows = () => env.q("SELECT * FROM world_wh_expeditions ORDER BY expedition_id");
  env.row = (id) => env.q("SELECT * FROM world_wh_expeditions WHERE expedition_id = ?", id)[0];
  env.event = (key) => env.q("SELECT * FROM world_scheduled_events WHERE idempotency_key = ?", key)[0] || null;
  env.totals = () => ({ exp: env.n("SELECT count(*) AS n FROM world_wh_expeditions"),
    ops: env.n("SELECT count(*) AS n FROM world_operations"),
    journal: env.n("SELECT count(*) AS n FROM world_event_journal"),
    events: env.n("SELECT count(*) AS n FROM world_scheduled_events"),
    transits: env.n("SELECT count(*) AS n FROM world_wormhole_transits") });
  env.stop = () => {
    if (ctx.expeditions) ctx.expeditions.stop("test");
    wr.wormholes.stop();
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
  env.asEvent = (row) => ({ eventId: row.event_id, eventType: row.event_type, aggregateId: row.aggregate_id,
    dueAt: row.due_at, payload: JSON.parse(row.payload), idempotencyKey: row.idempotency_key });
  env.planRound = () => Math.floor(shared.clock.now() / cfg.expeditions.planPeriodMs) + 1;
  env.status = () => ctx.expeditions.getStatus();
  return env;
}

function newFleet(env, tag, factionId, systemId) {
  const r = env.fleets.createFleet({ factionId, currentSystemId: systemId, homeSystemId: systemId,
    fleetRole: "patrol", composition: COMP }, `test:${tag}`);
  assert.ok(r.ok, JSON.stringify(r));
  return r.fleetId;
}

async function planOne(env) {
  const at = env.planRound() * env.cfg.expeditions.planPeriodMs;
  await env.drive(at);
  const rows = env.rows().filter((r) => r.faction_id === SANSHA);
  assert.strictEqual(rows.length, 1, JSON.stringify(env.status()));
  return { at, exp: rows[0] };
}

module.exports = ({ test, skip }) => {
  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  needsDriver("EX1 flag off: stub, no handler / enqueue / whexp event / row; wormholes off -> "
    + "WORMHOLES_DISABLED + warning; 5 warnings; migration 46 WIPE, 27 keys; REQUIRED on the real facades",
  () => H.withStore(driver, async (reopen) => {
    const got = {};
    {
      const shared = H.sharedOf();
      const env = await boot(reopen(), shared, testConfig(), { list: [pair(PAIR_A, S.N0, J1)] });
      try {
        newFleet(env, "off", SANSHA, S.N0);
        await env.drive(shared.clock.now() + 2 * env.cfg.expeditions.planPeriodMs);
        got.off = [env.started.ok, env.started.reason, env.ctx.expeditions.getMode(),
          env.ctx.expeditions.getStatus().reason, env.calls, env.n("SELECT count(*) AS n FROM world_scheduled_events "
            + "WHERE idempotency_key LIKE 'whexp:%'"), env.n("SELECT count(*) AS n FROM world_wh_expeditions")];
      } finally {
        env.stop();
        env.store.close("next");
      }
    }
    got.offBare = startExpeditions({ config: testConfig(), scheduler: {} }).reason;
    const noWh = testConfig({});
    noWh.wormholes.enabled = false;
    got.noWh = startExpeditions({ config: noWh, scheduler: {} }).reason;
    const warn = (env) => config.resolveConfig({ modDir: MOD_DIR, env: { EVEJS_DATA_ROOT: os.tmpdir(), ...env } })
      .warnings.filter((w) => w.startsWith("expeditions.") || w.startsWith("world.seedScope contains"))
      .map((w) => w.split(" ")[0]);
    const defaults = config.resolveConfig({ modDir: MOD_DIR, env: {} }).config;
    got.defaults = [defaults.expeditions.enabled, defaults.wormholes.enabled];
    got.warnDefault = warn({});
    got.warnNoWh = warn({ EVEJS_LNE_WORMHOLES_ENABLED: "0" });
    got.warn5 = warn({ EVEJS_LNE_WORMHOLES_ENABLED: "0", EVEJS_LNE_EXPEDITIONS_EXPEDITION_MIN_MS: "3600000",
      EVEJS_LNE_EXPEDITIONS_EXPEDITION_MAX_MS: "600000", EVEJS_LNE_EXPEDITIONS_STEP_INTERVAL_MS: "3600000",
      EVEJS_LNE_EXPEDITIONS_RETURN_MARGIN_MS: "0", EVEJS_LNE_WORLD_SEED_SCOPE: "nullsec,wormhole" });
    const m = MIGRATIONS[45];
    got.migration = [m.version, m.name, LATEST_SCHEMA_VERSION >= 46, TABLE_POLICY.world_wh_expeditions === ACTION.WIPE];
    const keys = config.SCHEMA.filter((r) => r.key.startsWith("expeditions."));
    const example = fs.readFileSync(path.join(MOD_DIR, ".env.example"), "utf8");
    got.keys = [keys.length, keys.filter((r) => !example.includes(`# ${r.env}=`)).map((r) => r.env),
      keys.filter((r) => r.launcher).length];
    {
      const shared = H.sharedOf();
      const opened = reopen();
      const cfg = testConfig({});
      const journal = createJournal({ clock: shared.clock, maxPayloadBytes: 16384, maxRows: 500 });
      const st = startStrategy({ config: cfg, persistence: { ok: true, store: opened.store, journal,
        worldSeed: opened.worldSeed }, clock: shared.clock, views: createViewRegistry(), graph: null,
      logger: { log() {} } });
      assert.ok(st.ok, JSON.stringify(st));
      const env = await boot(opened, shared, cfg, { list: [pair(PAIR_A, S.N0, J1)] }, { strategy: st.strategy });
      try {
        const roots = { fleets: env.ctx.fleets, scheduler: env.scheduler, persistence: env.ctx.persistence,
          strategy: env.ctx.strategy, graph: env.ctx.graph, clock: env.ctx.clock, ids: env.ctx.ids,
          wormholes: env.wormholes };
        const missing = REQUIRED.filter((p) => typeof p.split(".").reduce((o, k) => (o ? o[k] : undefined), roots)
          !== "function");
        const g = env.ctx.graph.getGraph().graph;
        got.real = [env.started, env.ctx.expeditions.getMode(), missing, SOFT_ROOTS,
          GRAPH_METHODS.filter((k) => typeof g[k] !== "function"), env.calls.registerHandler];
        env.ctx.expeditions.stop("test");
        got.realStopped = env.ctx.expeditions.getMode();
      } finally {
        env.stop();
        st.strategy.stop("test");
      }
    }
    assert.deepStrictEqual(got, {
      off: [false, "disabled_by_config", "off", "EXPEDITIONS_DISABLED", { registerHandler: 0, enqueue: 0 }, 0, 0],
      offBare: "disabled_by_config",
      noWh: "WORMHOLES_DISABLED",
      defaults: [true, true],
      warnDefault: [],
      warnNoWh: ["expeditions.enabled"],
      warn5: ["expeditions.enabled", "expeditions.expeditionMinMs=3600000", "expeditions.stepIntervalMs=3600000",
        "expeditions.returnMarginMs=0", "world.seedScope"],
      migration: [46, "world_wh_expeditions", true, true],
      keys: [27, [], 0],
      real: [{ ok: true }, "ready", [], ["wormholes"], [], 2],
      realStopped: "off",
    });
  }));

  needsDriver("EX2 full cycle: plan -> leg v2 -> ACTIVE 100 -> KEEP 200 -> EVACUATE expedition/return -> "
    + "ENDED RETURNED presence 0; J1 world row unchanged, no influence row; replays write nothing", () => H.withStore(
    driver, async (reopen) => {
      const shared = H.sharedOf();
      const env = await boot(reopen(), shared, testConfig({ maxActiveExpeditionsPerFaction: 2, candidateTopN: 1,
        planPeriodMs: 86400000 }), { list: [pair(PAIR_A, S.N0, J1), pair(PAIR_B, S.N0, J2)] });
      try {
        assert.deepStrictEqual(env.started, { ok: true }, env.lines.join("\n"));
        const t0 = shared.clock.now();
        env.tx((db) => db.prepare("INSERT INTO world_system_state (system_id, security_class, controller_faction_id, "
          + "occupation_state, threat_level, last_state_change_at, next_strategy_review_at, updated_at, version) "
          + "VALUES (?, 'wormhole', NULL, 'NEUTRAL', 0, ?, NULL, ?, 1)").run(J1, t0, t0));
        const worldBefore = env.q("SELECT * FROM world_system_state WHERE system_id = ?", J1);
        const f = newFleet(env, "s1", SANSHA, S.N0);
        newFleet(env, "s2", SANSHA, S.N0);
        newFleet(env, "amarr", AMARR, S.N0);
        const C = env.cfg.expeditions;
        const { at, exp } = await planOne(env);
        const detail = JSON.parse(exp.detail_json);
        const op = env.fleets.getOperation(exp.operation_id).operation;
        const fl = env.fleet(f);
        const got = {};
        got.plan = [exp.state, exp.fleet_id, exp.system_id, exp.origin_system_id, exp.entry_pair_key, exp.planned_at,
          exp.presence_permille, exp.arrive_at - at, exp.evacuate_at - exp.arrive_at];
        got.op = [op.operationType, op.objective, op.dueAt - exp.evacuate_at, op.targetSystemId, op.state];
        got.leg = [fl.state, fl.route.v, fl.route.wormholeEdges.map((e) => [e.i, e.pairKey]), fl.nextActionAt];
        got.transits = env.q("SELECT pair_key FROM world_wormhole_transits WHERE fleet_id = ?", f).map((r) => r.pair_key);
        const step0 = env.event(X.stepKey(exp.expedition_id, 0));
        got.step0 = [step0.due_at, JSON.parse(step0.payload), step0.state];
        const round = at / C.planPeriodMs;
        got.nextPlan = env.event(X.planKey(round + 1)).state;
        const before = env.totals();
        const planEv = env.asEvent(env.event(X.planKey(round)));
        const res = env.handlers[X.PLAN_EVENT](planEv, { anchorAt: planEv.dueAt });
        const v = env.tx((db) => res.effect(db, planEv));
        got.planReplay = [v.created.length, v.duplicates, v.refused];
        assert.deepStrictEqual(env.totals(), before);
        await env.drive(exp.arrive_at);
        const a = env.row(exp.expedition_id);
        got.active = [a.state, a.active_from, a.presence_permille, env.fleet(f).state, env.fleet(f).currentSystemId];
        await env.drive(exp.arrive_at + C.stepIntervalMs);
        got.keep = env.row(exp.expedition_id).presence_permille;
        await env.drive(exp.evacuate_at);
        const e = env.row(exp.expedition_id);
        const back = env.fleet(f);
        const rop = env.fleets.getOperation(e.return_operation_id).operation;
        got.evac = [e.state, e.presence_permille, e.evac_seq, rop.operationType, rop.objective, rop.targetSystemId,
          back.state, back.targetSystemId, back.legSeq - fl.legSeq, back.route.v,
          back.route.wormholeEdges.map((w) => w.pairKey)];
        got.transits2 = env.q("SELECT pair_key FROM world_wormhole_transits WHERE fleet_id = ?", f).length;
        await env.drive(back.nextActionAt + C.stepRecheckMs);
        const end = env.row(exp.expedition_id);
        got.end = [end.state, end.outcome, end.end_reason, end.presence_permille, end.ended_at, env.fleet(f)
          .currentSystemId];
        got.world = [JSON.stringify(env.q("SELECT * FROM world_system_state WHERE system_id = ?", J1))
          === JSON.stringify(worldBefore), env.n("SELECT count(*) AS n FROM world_system_influence WHERE system_id = ?",
          J1)];
        const done = env.totals();
        const outcomes = env.q("SELECT * FROM world_scheduled_events WHERE event_type = ? ORDER BY due_at",
          X.STEP_EVENT).map((r) => {
          const out = env.handlers[X.STEP_EVENT](env.asEvent(r), {});
          return [out.ok, out.outcome, typeof out.effect];
        });
        got.stepReplay = [...new Set(outcomes.map((o) => o.join("/")))];
        assert.deepStrictEqual(env.totals(), done);
        const st = env.status().counters;
        got.counters = [st.planned, st.activated, st.evacuated, st.returned, st.cutOff, env.status().open];
        assert.deepStrictEqual(got, {
          plan: ["PLANNED", f, J1, S.N0, PAIR_A, at, 0, detail.etaMs, C.expeditionMinMs],
          op: ["expedition", "expedition", C.stepRecheckMs, J1, "ACTIVE"],
          leg: ["TRAVELLING", 2, [[0, PAIR_A]], exp.arrive_at],
          transits: [PAIR_A],
          step0: [exp.arrive_at, { expeditionId: exp.expedition_id, stepSeq: 0, round: 0 }, "QUEUED"],
          nextPlan: "QUEUED",
          planReplay: [0, 1, []],
          active: ["ACTIVE", exp.arrive_at, 100, "STAGED", J1],
          keep: 200,
          evac: ["EVACUATING", 0, 1, "expedition", "return", S.N0, "TRAVELLING", S.N0, 1, 2, [PAIR_A]],
          transits2: 2,
          end: ["ENDED", "RETURNED", "RETURNED", 0, end.ended_at, S.N0],
          world: [true, 0],
          stepReplay: ["true/STALE/undefined"],
          counters: [1, 1, 1, 1, 0, 0],
        });
        assert.ok(end.ended_at >= back.nextActionAt, JSON.stringify(end));
      } finally {
        env.stop();
      }
    }));

  needsDriver("EX3 link loss: ACTIVE + pair closed -> CUT_OFF with decision_at; new pair -> EVACUATE "
    + "RECOVERED; cut in flight halted in J-space -> CUT_OFF, halted in k-space -> CANCELLED CUT_BEFORE_ENTRY",
  async () => {
    await H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const pairs = { list: [pair(PAIR_A, S.N0, J1)] };
      const env = await boot(reopen(), shared, testConfig({}), pairs);
      try {
        const C = env.cfg.expeditions;
        const f = newFleet(env, "s1", SANSHA, S.N0);
        const { exp } = await planOne(env);
        await env.drive(exp.arrive_at);
        assert.strictEqual(env.row(exp.expedition_id).state, "ACTIVE");
        pairs.list = [];
        env.sync();
        const cutAt = exp.arrive_at + C.stepIntervalMs;
        await env.drive(cutAt);
        const c = env.row(exp.expedition_id);
        const next = env.event(X.stepKey(exp.expedition_id, c.step_seq));
        const got = { cut: [c.state, c.cut_off_at, c.decision_at - c.cut_off_at, c.presence_permille,
          next.due_at - cutAt, next.state, env.fleet(f).state] };
        pairs.list = [pair(PAIR_D, S.N9, J1)];
        env.sync();
        await env.drive(cutAt + C.cutOffRecheckMs - 1);
        shared.clock.set(cutAt + C.cutOffRecheckMs);
        const ev = env.asEvent(next);
        const res = env.handlers[X.STEP_EVENT](ev, {});
        pairs.list = [];
        env.sync();
        const opsBefore = env.n("SELECT count(*) AS n FROM world_operations");
        const raced = env.tx((db) => res.effect(db, ev));
        const w = env.row(exp.expedition_id);
        const rf = env.fleet(f);
        const evKeys = env.n("SELECT count(*) AS n FROM world_event_journal WHERE idempotency_key IN (?, ?, ?)",
          `${ev.idempotencyKey}:unhold`, `${ev.idempotencyKey}:holdclose`, `${ev.idempotencyKey}:evac`);
        got.race = [res.outcome, raced.action, raced.reason, w.state, w.decision_at, w.watch_round,
          env.n("SELECT count(*) AS n FROM world_operations") - opsBefore, rf.state,
          w.hold_operation_id === c.hold_operation_id, rf.operationId === c.hold_operation_id,
          env.fleets.getOperation(c.hold_operation_id).operation.state, evKeys];
        pairs.list = [pair(PAIR_D, S.N9, J1)];
        env.sync();
        await env.drive(cutAt + 2 * C.cutOffRecheckMs);
        const r = env.row(exp.expedition_id);
        const fl = env.fleet(f);
        got.recovered = [r.state, r.evac_seq, fl.state, fl.targetSystemId, fl.route.wormholeEdges.map((w) => w.pairKey),
          env.status().counters.recovered];
        await env.drive(fl.nextActionAt + C.stepRecheckMs);
        const e = env.row(exp.expedition_id);
        got.end = [e.state, e.outcome, e.end_reason, env.fleet(f).currentSystemId];
        assert.deepStrictEqual(got, {
          cut: ["CUT_OFF", cutAt, C.cutOffDecisionMs, 0, C.cutOffRecheckMs, "QUEUED", "PLANNED"],
          race: ["EVACUATE", "WAIT", "UNREACHABLE", "CUT_OFF", c.decision_at, 1, 0, "PLANNED", true, true, "PLANNED",
            0],
          recovered: ["EVACUATING", 1, "TRAVELLING", S.N0, [PAIR_D], 1],
          end: ["ENDED", "RETURNED", "RETURNED", S.N0],
        });
      } finally {
        env.stop();
      }
    });

    await H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const pairs = { list: [pair(PAIR_A, S.N0, J1), pair(PAIR_C, J1, J2), pair(PAIR_B, S.N10, J2)] };
      const env = await boot(reopen(), shared, testConfig({}), pairs);
      try {
        const t0 = shared.clock.now();
        const dummy = env.tx((db) => env.repo.createExpedition(db, { expeditionId: "wx_dummy", factionId: AMARR,
          fleetId: "fleet_dummy", operationId: "op_dummy", originSystemId: S.N0, systemId: J1, entryPairKey: PAIR_A,
          seed: 1, plannedAt: t0, arriveAt: t0, evacuateAt: t0 + HOUR }, "test:dummy"));
        assert.ok(dummy.ok, JSON.stringify(dummy));
        const f = newFleet(env, "s1", SANSHA, S.N0);
        const { at, exp } = await planOne(env);
        const leg = env.fleet(f).route;
        await env.drive(at + Math.floor(1.5 * leg.jumpMs));
        pairs.list = [];
        env.sync();
        await env.drive(exp.arrive_at);
        const c = env.row(exp.expedition_id);
        const fl = env.fleet(f);
        assert.deepStrictEqual([exp.system_id, leg.systems, fl.state, fl.currentSystemId, c.state, c.cut_off_at,
          c.decision_at - c.cut_off_at], [J2, [S.N0, J1, J2], "PLANNED", J1, "CUT_OFF", exp.arrive_at,
          env.cfg.expeditions.cutOffDecisionMs]);
      } finally {
        env.stop();
      }
    });

    await H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const pairs = { list: [pair(PAIR_A, S.N0, J1)] };
      const env = await boot(reopen(), shared, testConfig({}), pairs);
      try {
        const f = newFleet(env, "s1", SANSHA, S.N0);
        const { at, exp } = await planOne(env);
        await env.drive(at + Math.floor(env.fleet(f).route.jumpMs / 2));
        pairs.list = [];
        env.sync();
        await env.drive(exp.arrive_at);
        const e = env.row(exp.expedition_id);
        assert.deepStrictEqual([env.fleet(f).currentSystemId, e.state, e.outcome, e.end_reason],
          [S.N0, "ENDED", "CANCELLED", "CUT_BEFORE_ENTRY"]);
      } finally {
        env.stop();
      }
    });

    await H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const env = await boot(reopen(), shared, testConfig({}), { list: [pair(PAIR_A, S.N0, J1)] }, {
        travel: (real) => ({ planInTx: (...args) => {
          const r = real.planInTx(...args);
          return r && r.ok === true ? { ...r, arriveAt: r.arriveAt + HOUR } : r;
        } }) });
      try {
        const f = newFleet(env, "s1", SANSHA, S.N0);
        const ops = env.n("SELECT count(*) AS n FROM world_operations");
        await env.drive(env.planRound() * env.cfg.expeditions.planPeriodMs);
        const st = env.status();
        assert.deepStrictEqual([env.rows().length, env.n("SELECT count(*) AS n FROM world_operations") - ops,
          env.fleet(f).state, st.skipByReason.PLAN_REFUSED, st.lastRefusal], [0, 0, "IDLE", 1, "EXPEDITION_TOO_SHORT"]);
      } finally {
        env.stop();
      }
    });
  });

  needsDriver("EX4 restart: ACTIVE without a step -> 1 reconcile step, second start none; step before the "
    + "sync -> RETRY attempts 0 due now + syncWaitMs; plan before the sync -> NOT_SYNCED, next round queued",
  () => H.withStore(driver, async (reopen) => {
    const shared = H.sharedOf();
    const cfg = testConfig({});
    const pairs = { list: [pair(PAIR_A, S.N0, J1)] };
    let env = await boot(reopen(), shared, cfg, pairs, { noStart: true });
    const t0 = shared.clock.now();
    env.tx((db) => {
      const c = env.repo.createExpedition(db, { expeditionId: "wx_r", factionId: SANSHA, fleetId: "fleet_r",
        operationId: "op_r", originSystemId: S.N0, systemId: J1, entryPairKey: PAIR_A, seed: 1, plannedAt: t0 - 2000,
        arriveAt: t0 - 1000, evacuateAt: t0 + HOUR }, "test:r");
      assert.ok(c.ok, JSON.stringify(c));
      const t = env.repo.transitionExpedition(db, { expeditionId: "wx_r", expectedVersion: 1, from: "PLANNED",
        to: "ACTIVE", at: t0 - 1000, patch: { activeFrom: t0 - 1000, presencePermille: 100, stepSeq: 3,
          watchRound: 0 } });
      assert.ok(t.ok, JSON.stringify(t));
      const bad = env.repo.transitionExpedition(db, { expeditionId: "wx_r", expectedVersion: 2, from: "ACTIVE",
        to: "ENDED", at: t0, patch: { outcome: "WON", endReason: "RETURNED", endedAt: t0, presencePermille: 0 } });
      assert.deepStrictEqual([bad.reason, bad.detail], ["EXPEDITION_INVALID_INPUT", "patch.outcome"]);
    });
    const recRows = () => env.q("SELECT idempotency_key, payload, state, attempts, due_at FROM world_scheduled_events "
      + "WHERE idempotency_key LIKE 'whexp:rec:%'");
    const restart = async () => {
      env.stop();
      env.store.close("restart");
      env = await boot(reopen(), shared, cfg, pairs);
    };
    try {
      const got = {};
      await restart();
      got.first = recRows().map((r) => [r.idempotency_key, JSON.parse(r.payload), r.state]);
      got.line = env.lines.find((l) => l.startsWith("expeditions: running "));
      await restart();
      got.second = recRows().length;
      env.whOverride = { isSynced: () => false, getStatus: () => ({ state: "starting" }) };
      const now = shared.clock.now();
      await env.scheduler.runPass();
      const held = recRows()[0];
      got.held = [held.state, held.attempts, held.due_at - now, env.status().counters.syncDeferred];
      const round = env.planRound();
      await env.drive(round * cfg.expeditions.planPeriodMs);
      const plan = env.event(X.planKey(round));
      got.plan = [plan.state, plan.outcome, env.event(X.planKey(round + 1)).state, env.status().skipByReason.NOT_SYNCED,
        env.n("SELECT count(*) AS n FROM world_wh_expeditions")];
      assert.deepStrictEqual(got, {
        first: [[`${X.recBaseKey("wx_r", 3)}:0`, { expeditionId: "wx_r", stepSeq: 3, round: 0 }, "QUEUED"]],
        line: "expeditions: running open=1 plan=" + (Math.floor(t0 / cfg.expeditions.planPeriodMs) + 1)
          + " reconciled=1 exhausted=0 refused=0",
        second: 1,
        held: ["RETRY", 0, cfg.expeditions.syncWaitMs, 1],
        plan: ["DONE", "NOT_SYNCED", "QUEUED", 1, 1],
      });
    } finally {
      env.stop();
    }
  }));

  needsDriver("EX5 fleetScanMax counts IDLE fleets of the expedition role; more "
    + "IDLE fleets of other roles with lower ids than the limit do not hide a patrol fleet (was NO_FLEET)",
  () => H.withStore(driver, async (reopen) => {
    const shared = H.sharedOf();
    const env = await boot(reopen(), shared, testConfig({ fleetScanMax: 2 }), { list: [pair(PAIR_A, S.N0, J1)] });
    try {
      assert.deepStrictEqual(env.started, { ok: true }, env.lines.join("\n"));
      const others = ["r1", "r2", "r3"].map((tag) => {
        const r = env.fleets.createFleet({ factionId: SANSHA, currentSystemId: S.N0, homeSystemId: S.N0,
          fleetRole: "reserve", composition: COMP }, `test:${tag}`);
        assert.ok(r.ok, JSON.stringify(r));
        return r.fleetId;
      });
      const f = newFleet(env, "p1", SANSHA, S.N0);
      assert.ok(others.every((id) => id < f), JSON.stringify({ others, f }));
      const { exp } = await planOne(env);
      assert.deepStrictEqual([exp.fleet_id, exp.state, env.status().skipByReason.NO_FLEET || 0], [f, "PLANNED", 0]);
      const list = (opts) => env.tx((db) => env.fleets.repository.listFleetsByFaction(db, SANSHA, opts));
      assert.deepStrictEqual(list({ states: ["IDLE", "PLANNED", "TRAVELLING"], role: "reserve", limit: 2 }).fleets
        .map((x) => x.fleetId), others.slice(0, 2));
      assert.strictEqual(list({ states: ["IDLE", "DESTROYED"], role: "patrol", limit: 2 }).ok, false);
      assert.strictEqual(list({ role: "patrol", limit: 2 }).ok, false);
      assert.strictEqual(list({ states: ["IDLE"], role: "pirate-king", limit: 2 }).reason, "UNKNOWN_FLEET_ROLE");
    } finally {
      env.stop();
    }
  }));
};

Object.assign(module.exports, { harness: Object.freeze({ boot, newFleet, planOne, pair, testConfig, H, S, SANSHA,
  AMARR, J1, J2, PAIR_A, PAIR_B, PAIR_D, HOUR }) });
