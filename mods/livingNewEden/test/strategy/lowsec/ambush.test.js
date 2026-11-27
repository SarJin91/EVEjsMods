"use strict";

const assert = require("node:assert");
const os = require("node:os");
const path = require("node:path");

const config = require("../../../config");
const { createJournal } = require("../../../lib/persistence/journal");
const { startScheduler } = require("../../../lib/scheduler");
const { startFleets } = require("../../../lib/fleets");
const { startStations } = require("../../../lib/stations");
const { startLogistics } = require("../../../lib/economy/logistics");
const { createLogisticsService } = require("../../../lib/economy/logistics/logisticsService");
const { convoyNudgeKey } = require("../../../lib/economy/schema");
const { createContactService } = require("../../../lib/battle/contactService");
const { createCooldownRepository } = require("../../../lib/battle/cooldownRepository");
const { createHostility } = require("../../../lib/battle/data/hostility");
const { createUnavailableBattle } = require("../../../lib/battle");
const { createViewRegistry } = require("../../../lib/observer/views");
const { createRng } = require("../../../lib/util/rng");
const { startLowsec, REQUIRED, SOFT_ROOTS } = require("../../../lib/strategy/lowsec");
const { crossingsOf, decideAmbush } = require("../../../lib/strategy/lowsec/campRules");
const { createCampRepository } = require("../../../lib/strategy/lowsec/campRepository");
const { staleKeyOf, ambushHaltKeyOf } = require("../../../lib/strategy/lowsec/campService");
const LS = require("../../../lib/strategy/lowsec/schema");
const { harness: H } = require("../../battle/settlement.test");

const MOD_DIR = path.resolve(__dirname, "..", "..", "..");
const { S, FACTION_A, FACTION_B } = H;
const DEFAULTS = config.resolveConfig({ modDir: MOD_DIR, env: {} }).config;
const CONVOY = Object.freeze([{ hullGroup: "industrial", count: 2 }, { hullGroup: "frigate", count: 2 }]);
const CAMP_COMP = Object.freeze([{ hullGroup: "cruiser", count: 4 }]);
const HOUR = 3600000;

function testConfig(lowsec = {}) {
  return { ...H.CONFIG, modules: { ...H.CONFIG.modules, strategy: { enabled: true } },
    fleets: { ...H.CONFIG.fleets, refitPolicy: "station", refitSeekRecheckMs: HOUR, refitSeekMaxRounds: 24 },
    stations: { ...DEFAULTS.stations, refitSeekRecheckMs: HOUR },
    logistics: { ...DEFAULTS.logistics, enabled: true },
    persistence: { ...H.CONFIG.persistence, maxRowsPerTransaction: 500 },
    lowsec: { ...DEFAULTS.lowsec, enabled: true, interceptChancePermille: 1000, ...lowsec } };
}

const graphService = (graph) => ({ whenReady: () => Promise.resolve({ ok: true, graph }),
  getGraph: () => ({ ok: true, graph }) });

async function boot(opened, shared, cfg, soft = {}) {
  const journal = createJournal({ clock: shared.clock, maxPayloadBytes: 16384, maxRows: 500 });
  const sr = startScheduler({ config: cfg, persistence: { ok: true, store: opened.store }, clock: shared.clock,
    ids: shared.ids, nowMs: () => 0 });
  assert.ok(sr.ok, JSON.stringify(sr));
  const order = [];
  const handlers = {};
  const scheduler = { ...sr.scheduler, registerHandler: (type, fn, o) => {
    handlers[type] = fn;
    return sr.scheduler.registerHandler(type, (ev, hctx) => {
      order.push(ev.eventType);
      return fn(ev, hctx);
    }, o);
  } };
  const holder = { stations: null };
  const persistence = { ok: true, store: opened.store, journal, worldSeed: opened.worldSeed };
  const fr = startFleets({ config: cfg, persistence, clock: shared.clock, ids: shared.ids, scheduler,
    graph: { getGraph: () => ({ ok: true, graph: shared.graph }) }, presence: null, views: createViewRegistry(),
    getStations: () => holder.stations, adapter: soft.adapter });
  assert.ok(fr.ok, JSON.stringify(fr));
  const registry = { getFaction: (id) => ([FACTION_A, FACTION_B].includes(Number(id))
    ? { factionId: Number(id), startStations: [] } : null), listFactions: () => [{ factionId: FACTION_A }],
  listActiveFactions: () => [{ factionId: FACTION_A }], isActive: (id) => [FACTION_A, FACTION_B].includes(Number(id)) };
  const st = startStations({ config: cfg, persistence, strategy: { registry }, graph: graphService(shared.graph),
    clock: shared.clock });
  assert.ok(st.ok, JSON.stringify(st));
  holder.stations = st.stations;
  await st.stations.whenReady();
  const lines = [];
  const logger = { log: (l) => lines.push(l) };
  const lr = startLogistics({ config: cfg, persistence, clock: shared.clock, ids: shared.ids, scheduler,
    fleets: fr.fleets, strategy: { registry }, getStations: () => holder.stations, views: createViewRegistry(),
    logger });
  assert.ok(lr.ok, JSON.stringify(lr));
  const cooldowns = createCooldownRepository({ journal, clock: shared.clock });
  const specs = [];
  const battleRepository = { createBattle: (tx, spec, key) => {
    specs.push({ spec: JSON.parse(JSON.stringify(spec)), key });
    return { ok: true, duplicate: false, battleId: `battle_test_${specs.length}` };
  } };
  const contact = createContactService({ store: opened.store, scheduler, battleRepository, cooldownRepository: cooldowns,
    fleetRepository: fr.fleets.repository, getGraph: () => shared.graph, worldRepository: null,
    resolverVersion: "internal-v1", settings: { engageDelayMs: 60000, recontactCooldownMs: HOUR,
      contactScanMaxFleets: 64, maxResolutionMs: 50 }, limits: { maxFleetsPerSide: 8, maxSettlementRows: 450 },
    isHostile: createHostility(), bump() {}, logger, isActive: () => true });
  fr.fleets.travel.addArrivalListener(contact.onArrival);
  scheduler.registerHandler("BATTLE_CONTACT_CHECK", contact.onContactCheck);
  scheduler.registerHandler("BATTLE_RESOLUTION", () => ({ ok: true, outcome: "TEST" }));
  const battle = { readCooldownsInTx: (tx, systemId) => cooldowns.listForSystem(tx, systemId),
    getStatus: () => ({ state: "ready" }) };
  const lowsecFleets = soft.travelOf ? { ...fr.fleets, travel: soft.travelOf(fr.fleets.travel) } : fr.fleets;
  const ls = startLowsec({ config: cfg, persistence, scheduler, fleets: lowsecFleets,
    strategy: { registry: soft.registry || { listActiveFactions: () => [] }, getStatus: () => ({ state: "running" }) },
    graph: graphService(shared.graph), clock: shared.clock, ids: shared.ids, logger,
    getLogistics: soft.getLogistics || (() => lr.logistics), getBattle: soft.getBattle || (() => battle),
    telemetry: soft.telemetry || null });
  assert.ok(ls.ok, JSON.stringify(ls));
  const tx = (fn) => {
    const r = opened.store.transaction("test", fn);
    assert.ok(r.ok, JSON.stringify(r));
    return r.value;
  };
  const env = { store: opened.store, scheduler: sr.scheduler, fleets: fr.fleets, stations: st.stations,
    logistics: lr.logistics, lowsec: ls.lowsec, contact, cooldowns, specs, order, handlers, lines, tx, shared, cfg,
    battle, camps: createCampRepository(), journal };
  env.q = (sql, ...args) => tx((db) => db.prepare(sql).all(...args));
  env.fleet = (id) => tx((db) => fr.fleets.repository.getFleet(db, id)).fleet;
  env.camp = (id) => tx((db) => env.camps.getCamp(db, id)).camp;
  env.events = (type) => env.q("SELECT idempotency_key, due_at, payload, state FROM world_scheduled_events "
    + "WHERE event_type = ? ORDER BY due_at, idempotency_key", type).map((r) => ({ ...r, payload: JSON.parse(r.payload) }));
  env.stop = () => {
    ls.lowsec.stop("test");
    lr.logistics.stop("test");
    fr.fleets.stop("test");
    sr.scheduler.stop("test");
  };
  env.settle = async (at) => {
    shared.clock.set(at);
    for (let i = 0; i < 40; i += 1) {
      const p = await sr.scheduler.runPass();
      assert.ok(p.ok, JSON.stringify(p));
      if (p.jobs === 0) return;
    }
    throw new Error("queue did not settle");
  };
  env.run = (type, ev) => {
    const res = handlers[type](ev, {});
    assert.ok(res.ok, JSON.stringify(res));
    const v = typeof res.effect === "function" ? tx((db) => res.effect(db, ev)) : undefined;
    if (typeof res.onCommitted === "function") res.onCommitted(v);
    return { res, v };
  };
  return env;
}

async function scene(env, untilMs = 4 * HOUR, campId = "lc_test", detail = undefined) {
  const t0 = env.shared.clock.now();
  for (const [id, sys] of [["st-src", S.N0], ["st-dst", S.L2]]) {
    const r = env.tx((db) => env.stations.repository.createStation(db, { stationId: id, kind: "upwell", typeId: 35832,
      structureFamily: "astrahus", systemId: sys, ownerFactionId: FACTION_A, ownerCorporationId: 1000162,
      origin: "built", at: t0 }, `test:station:${id}`));
    assert.ok(r.ok, JSON.stringify(r));
  }
  const stock = env.tx((db) => env.stations.repository.applyStockChange(db, { stationId: "st-src", key: "test:stock",
    reason: "TEST", at: t0, deltas: [{ itemKind: "hull", itemKey: "group:battleship", delta: 5 }] }));
  assert.ok(stock.ok, JSON.stringify(stock));
  const cf = env.fleets.createFleet({ factionId: FACTION_B, currentSystemId: S.N0, homeSystemId: S.N0,
    fleetRole: "patrol", composition: CAMP_COMP }, "test:campfleet");
  assert.ok(cf.ok, JSON.stringify(cf));
  const op = env.fleets.createOperation({ operationType: "camp", factionId: FACTION_B, originSystemId: S.N0,
    targetSystemId: S.L1, objective: "patrol", dueAt: t0 + untilMs, fleets: [{ fleetId: cf.fleetId,
      expectedVersion: 1 }] }, "test:campop");
  assert.ok(op.ok, JSON.stringify(op));
  const p = env.fleets.planTravel({ fleetId: cf.fleetId, targetSystemId: S.L1 }, "test:campplan");
  assert.ok(p.ok, JSON.stringify(p));
  await env.settle(p.arriveAt);
  assert.deepStrictEqual([env.fleet(cf.fleetId).state, env.fleet(cf.fleetId).currentSystemId], ["STAGED", S.L1]);
  const at = env.shared.clock.now();
  env.tx((db) => {
    const c = env.camps.createCamp(db, { campId, factionId: FACTION_B, fleetId: cf.fleetId,
      operationId: op.operationId, systemId: S.L1, seed: 1, plannedAt: t0, arriveAt: p.arriveAt,
      untilAt: t0 + untilMs, ...(detail === undefined ? {} : { detail }) }, "test:camp");
    assert.ok(c.ok, JSON.stringify(c));
    const a = env.camps.transitionCamp(db, { campId, expectedVersion: 1, from: "PLANNED", to: "ACTIVE",
      patch: { activeFrom: at, stepSeq: 1, watchRound: 0 } });
    assert.ok(a.ok, JSON.stringify(a));
  });
  return { campId, campFleet: cf.fleetId, operationId: op.operationId, t0 };
}

function convoy(env, tag) {
  const f = env.fleets.createFleet({ factionId: FACTION_A, currentSystemId: S.N0, homeSystemId: S.N0,
    fleetRole: "logistics", composition: CONVOY }, `${tag}:create`);
  assert.ok(f.ok, JSON.stringify(f));
  const d = env.tx((db) => env.logistics.dispatchInTx(db, { factionId: FACTION_A, fleetId: f.fleetId,
    expectedVersion: 1, purpose: "HULLS_TO_MOBILIZATION", sourceStationId: "st-src", destStationId: "st-dst",
    items: [{ itemKind: "hull", itemKey: "group:battleship", quantity: 1 }], at: env.shared.clock.now() }, tag));
  assert.deepStrictEqual([d.ok, d.state], [true, "IN_TRANSIT"], JSON.stringify(d));
  const fleet = env.fleet(f.fleetId);
  assert.deepStrictEqual(fleet.route.systems, [S.N0, S.L1, S.L2]);
  return { convoyId: d.convoyId, fleetId: f.fleetId, leg: fleet.route, legSeq: fleet.legSeq,
    t1: fleet.route.departAt + fleet.route.jumpMs };
}

const stepEvent = (env, campId, dueAt) => {
  const c = env.camp(campId);
  return { eventType: LS.STEP_EVENT, dueAt, payload: { campId, stepSeq: c.stepSeq, round: c.watchRound },
    idempotencyKey: LS.stepKey(campId, c.stepSeq) };
};
const ambushEvent = (payload) => ({ eventType: LS.AMBUSH_EVENT, dueAt: payload.at, payload,
  idempotencyKey: LS.ambushKey(payload.campId, payload.convoyId) });

module.exports = ({ test, skip }) => {
  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  needsDriver("LA1 strike -> intercept in L1 -> contact check triggered by the convoy -> objective escort "
    + "side A = convoy faction; no nudge; soft REQUIRED paths", () => H.withStore(driver, async (reopen) => {
    const shared = H.sharedOf();
    const env = await boot(reopen(), shared, testConfig());
    try {
      const sc = await scene(env);
      const cv = convoy(env, "la1");
      const q = env.scheduler.enqueue(LS.STEP_EVENT, sc.campId, cv.t1, { campId: sc.campId, stepSeq: 1, round: 0 },
        LS.stepKey(sc.campId, 1));
      assert.ok(q.ok, JSON.stringify(q));
      await env.settle(cv.t1 + 1000);
      const strikes = env.events(LS.AMBUSH_EVENT);
      assert.deepStrictEqual(strikes.map((s) => [s.idempotency_key, s.state, s.payload]),
        [[LS.ambushKey(sc.campId, cv.convoyId), "DONE", { campId: sc.campId, convoyId: cv.convoyId,
          fleetId: cv.fleetId, legSeq: cv.legSeq, systemIndex: 1, at: cv.t1 }]]);
      const f = env.fleet(cv.fleetId);
      assert.deepStrictEqual([f.state, f.currentSystemId, f.route, f.legSeq], ["STAGED", S.L1, null, cv.legSeq]);
      const checks = env.events("BATTLE_CONTACT_CHECK").filter((e) => e.payload.systemId === S.L1
        && e.payload.triggerFleetId === cv.fleetId);
      assert.deepStrictEqual(checks.map((c) => [c.payload.at, c.state]), [[cv.t1, "DONE"]]);
      assert.strictEqual(env.specs.length, 1, JSON.stringify(env.specs));
      const spec = env.specs[0].spec;
      assert.deepStrictEqual([spec.objective, spec.systemId, spec.sideA.factionId, spec.sideA.fleets[0].fleetId,
        spec.sideB.factionId], ["escort", S.L1, FACTION_A, cv.fleetId, FACTION_B]);
      assert.deepStrictEqual(env.events("CONVOY_DELIVERY").filter((e) => e.idempotency_key
        === convoyNudgeKey(cv.fleetId, cv.legSeq, "STAGED")), []);
      assert.strictEqual(env.logistics.getStatus().counters.nudgeSkippedIntercepted, 1);
      assert.strictEqual(env.tx((db) => env.logistics.convoys.getConvoy(db, cv.convoyId)).convoy.state, "IN_TRANSIT");
      const camp = env.camp(sc.campId);
      assert.deepStrictEqual([camp.intercepts, camp.lastInterceptAt, camp.detail.lastConvoyId],
        [1, cv.t1, cv.convoyId]);
      const st = env.lowsec.getStatus();
      assert.deepStrictEqual([st.counters.scans, st.counters.strikesScheduled, st.counters.intercepts,
        st.counters.escapes, st.scan], [1, 1, 1, 0, "on"]);
      assert.strictEqual(env.fleets.travel.getCounters().intercepts, 1);
      assert.ok(env.lines.includes(`lowsec: camp ${sc.campId} intercepted convoy ${cv.convoyId} system=${S.L1}`));
      const roots = { logistics: env.logistics, battle: env.battle };
      for (const p of REQUIRED.filter((x) => SOFT_ROOTS.includes(x.split(".")[0]))) {
        assert.strictEqual(typeof p.split(".").reduce((o, k) => (o ? o[k] : undefined), roots), "function", p);
      }
      assert.strictEqual(typeof env.fleets.travel.interceptInTx, "function");
    } finally {
      env.stop();
    }
  }));

  test("LA2 logistics onArrival: intercepted:true -> no row + counter; no field / false -> the nudge as "
    + "before", () => {
    const calls = [];
    const fake = { enqueue: (...args) => {
      calls.push(args);
      return { ok: true };
    } };
    const svc = createLogisticsService({ store: null, convoys: null, fleets: null, scheduler: fake,
      clock: { now: () => 0 }, ids: { next: () => "x" }, config: DEFAULTS });
    const tx = { inTransaction: true };
    const base = { fleetId: "fleet_c", factionId: FACTION_A, systemId: S.L1, at: 1000, state: "STAGED", legSeq: 3,
      fleetRole: "logistics" };
    const nudge = (a) => ["CONVOY_DELIVERY", "fleet_c", 1000, { fleetId: "fleet_c", legSeq: 3, state: "STAGED",
      at: 1000 }, convoyNudgeKey("fleet_c", 3, a.state), { tx, chained: true }];
    svc.onArrival(tx, base);
    svc.onArrival(tx, { ...base, intercepted: false });
    svc.onArrival(tx, { ...base, intercepted: true });
    svc.onArrival(tx, { ...base, fleetRole: "patrol", intercepted: true });
    assert.deepStrictEqual(calls, [nudge(base), nudge(base)]);
    assert.strictEqual(svc.getStatus().counters.nudgeSkippedIntercepted, 1);
    const ls = DEFAULTS.lowsec;
    assert.deepStrictEqual([ls.scanMaxConvoys, ls.maxStrikesPerScan, ls.interceptChancePermille], [256, 4, 800]);
    const warn = (env) => config.resolveConfig({ modDir: MOD_DIR, env: { EVEJS_DATA_ROOT: os.tmpdir(), ...env } })
      .warnings.filter((w) => w.startsWith("lowsec.enabled without"));
    assert.strictEqual(warn({ EVEJS_LNE_LOWSEC_ENABLED: "1", EVEJS_LNE_LOGISTICS_CONVOYS_ENABLED: "0" }).length, 1);
    assert.deepStrictEqual(warn({ EVEJS_LNE_LOWSEC_ENABLED: "1" }), []);
    assert.deepStrictEqual(warn({}), []);
  });

  needsDriver("LA3 idempotency: same strike twice = one stop; second scan = no new event; replan (new "
    + "legSeq) = no second strike; catch-up CONVOY_DELIVERY p1 -> strike -> FLEET_ARRIVAL in one run", async () => {
    await H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const env = await boot(reopen(), shared, testConfig());
      try {
        const sc = await scene(env);
        const cv = convoy(env, "la3");
        const s1 = env.run(LS.STEP_EVENT, stepEvent(env, sc.campId, cv.t1));
        assert.deepStrictEqual([s1.res.outcome, s1.v.strikes], ["KEEP", 1]);
        const s2 = env.run(LS.STEP_EVENT, stepEvent(env, sc.campId, cv.t1));
        assert.deepStrictEqual([s2.res.outcome, s2.v.strikes], ["KEEP", 0]);
        assert.strictEqual(env.events(LS.AMBUSH_EVENT).length, 1);
        const r = env.fleets.planTravel({ fleetId: cv.fleetId, targetSystemId: S.L2, at: cv.leg.departAt },
          "la3:replan");
        assert.ok(r.ok, JSON.stringify(r));
        const moved = env.fleet(cv.fleetId);
        assert.strictEqual(moved.legSeq, cv.legSeq + 1);
        const s3 = env.run(LS.STEP_EVENT, stepEvent(env, sc.campId, cv.t1));
        assert.strictEqual(s3.v.strikes, 0);
        const strike = env.events(LS.AMBUSH_EVENT)[0];
        const stale = env.run(LS.AMBUSH_EVENT, ambushEvent(strike.payload));
        assert.deepStrictEqual([stale.res.outcome, stale.v], ["STALE", undefined]);
        assert.strictEqual(env.lowsec.getStatus().counters.strikesStale, 1);
        const p = { ...strike.payload, legSeq: moved.legSeq, at: moved.route.departAt + moved.route.jumpMs };
        const one = env.run(LS.AMBUSH_EVENT, ambushEvent(p));
        assert.deepStrictEqual([one.v.applied, one.v.action], [true, "INTERCEPT"]);
        const halted = env.fleet(cv.fleetId);
        const ev2 = { ...ambushEvent(p) };
        const two = env.handlers[LS.AMBUSH_EVENT](ev2, {});
        assert.deepStrictEqual([two.ok, two.outcome], [true, "STALE"]);
        const replay = env.tx((db) => one.res.effect(db, ambushEvent(p)));
        assert.deepStrictEqual([replay.applied, replay.action], [false, "DUPLICATE"]);
        assert.strictEqual(env.fleet(cv.fleetId).version, halted.version);
        assert.strictEqual(env.camp(sc.campId).intercepts, 1);
        assert.strictEqual(env.fleets.travel.getCounters().intercepts, 1);
      } finally {
        env.stop();
      }
    });

    await H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const env = await boot(reopen(), shared, testConfig());
      try {
        const sc = await scene(env);
        const cv = convoy(env, "la3d");
        const c = env.tx((db) => env.logistics.convoys.getConvoy(db, cv.convoyId)).convoy;
        const due = env.scheduler.enqueue("CONVOY_DELIVERY", cv.convoyId, cv.leg.departAt, { convoyId: cv.convoyId,
          phaseSeq: c.phaseSeq, round: c.watchRound }, "test:due");
        assert.ok(due.ok, JSON.stringify(due));
        const s1 = env.run(LS.STEP_EVENT, stepEvent(env, sc.campId, cv.leg.departAt));
        assert.strictEqual(s1.v.strikes, 1);
        env.order.length = 0;
        await env.settle(cv.leg.arriveAt + 1000);
        const first = (t) => env.order.indexOf(t);
        assert.ok(first("CONVOY_DELIVERY") >= 0 && first("CONVOY_DELIVERY") < first(LS.AMBUSH_EVENT)
          && first(LS.AMBUSH_EVENT) < first("FLEET_ARRIVAL"), env.order.join(","));
        const f = env.fleet(cv.fleetId);
        assert.deepStrictEqual([f.currentSystemId, f.legSeq], [S.L1, cv.legSeq]);
        assert.ok(["STAGED", "ENGAGED"].includes(f.state), f.state);
        assert.strictEqual(env.tx((db) => env.logistics.convoys.getConvoy(db, cv.convoyId)).convoy.state, "IN_TRANSIT");
        assert.deepStrictEqual(env.events("CONVOY_DELIVERY").filter((e) => e.idempotency_key.startsWith("convoy:arr:")),
          []);
        assert.strictEqual(env.specs.length, 1);
        assert.strictEqual(env.specs[0].spec.objective, "escort");
      } finally {
        env.stop();
      }
    });
  });

  test("LA4 decideAmbush STALE cases (passed, legSeq, camp ended, camp fleet away, not hostile, cooldown "
    + "wormhole leg), ESCAPED / INTERCEPT by the roll", () => {
    const leg = { v: 1, mode: "travel", systems: [S.N0, S.L1, S.L2], departAt: 1000, jumpMs: 100, arriveAt: 1200,
      graphVersion: 1, observed: false };
    const p = { campId: "lc_1", convoyId: "cv_1", fleetId: "f_c", legSeq: 2, systemIndex: 1, at: 1100 };
    const facts = (o = {}) => ({ p, worldSeed: 7, hostile: true, cooldownUntil: null,
      camp: { state: "ACTIVE", activeFrom: 0, untilAt: 5000, systemId: S.L1, operationId: "op_c" },
      convoy: { state: "IN_TRANSIT", fleetId: "f_c", factionId: FACTION_A },
      convoyFleet: { state: "TRAVELLING", legSeq: 2, route: leg },
      campFleet: { state: "STAGED", currentSystemId: S.L1, operationId: "op_c" }, ...o });
    const go = { interceptChancePermille: 1000 };
    const reasonOf = (f) => decideAmbush(f, go).reason || decideAmbush(f, go).action;
    const got = [
      reasonOf(facts()),
      reasonOf(facts({ p: { ...p, at: 1200 } })),
      reasonOf(facts({ p: { ...p, legSeq: 1 } })),
      reasonOf(facts({ camp: { ...facts().camp, state: "ENDED" } })),
      reasonOf(facts({ camp: { ...facts().camp, untilAt: 1100 } })),
      reasonOf(facts({ campFleet: { ...facts().campFleet, currentSystemId: S.N0 } })),
      reasonOf(facts({ hostile: false })),
      reasonOf(facts({ cooldownUntil: 1101 })),
      reasonOf(facts({ cooldownUntil: 1100 })),
      reasonOf(facts({ convoy: { ...facts().convoy, state: "DELIVERED" } })),
      reasonOf(facts({ convoyFleet: { state: "TRAVELLING", legSeq: 2, route: { ...leg, v: 2, constraints: {},
        wormholeEdges: [{ i: 0, pairKey: "x", expiresAt: 9 }] } } })),
    ];
    assert.deepStrictEqual(got, ["INTERCEPT", "NOT_CROSSING", "LEG_MOVED", "CAMP_NOT_ACTIVE", "CAMP_WINDOW",
      "CAMP_FLEET_AWAY", "NOT_HOSTILE", "ON_COOLDOWN", "INTERCEPT", "CONVOY_GONE", "LEG_HAS_WORMHOLES"]);
    assert.strictEqual(decideAmbush(facts(), { interceptChancePermille: 0 }).action, "ESCAPED");
    const roll = decideAmbush(facts(), go).roll;
    assert.deepStrictEqual(decideAmbush(facts(), go).roll, roll, "deterministic");
    assert.strictEqual(decideAmbush(facts(), { interceptChancePermille: Math.floor(roll * 1000) }).action, "ESCAPED");
    assert.strictEqual(decideAmbush(facts(), { interceptChancePermille: Math.floor(roll * 1000) + 1 }).action,
      "INTERCEPT");
  });

  needsDriver("LA4b ESCAPED (interceptChancePermille 0) -> journal outcome ESCAPED, no stop; a cooldown of the "
    + "pair -> STALE strikesStale", () => H.withStore(driver, async (reopen) => {
    const shared = H.sharedOf();
    const env = await boot(reopen(), shared, testConfig({ interceptChancePermille: 0 }));
    try {
      const sc = await scene(env);
      const a = convoy(env, "la4a");
      const b = convoy(env, "la4b");
      env.tx((db) => {
        const r = env.cooldowns.recordInTx(db, { systemId: S.L1, factionA: FACTION_A, factionB: FACTION_B,
          untilAt: b.t1 + 1, battleId: "battle_cd" }, "test:cd");
        assert.ok(r.ok, JSON.stringify(r));
      });
      const s = env.run(LS.STEP_EVENT, stepEvent(env, sc.campId, Math.min(a.t1, b.t1)));
      assert.strictEqual(s.v.strikes, 2);
      const strikes = env.events(LS.AMBUSH_EVENT);
      const out = strikes.map((x) => env.run(LS.AMBUSH_EVENT, ambushEvent(x.payload)).res.outcome);
      assert.deepStrictEqual(out, ["STALE", "STALE"]);
      assert.strictEqual(env.lowsec.getStatus().counters.strikesStale, 2);
      env.tx((db) => db.prepare("DELETE FROM battle_contact_cooldowns").run());
      const esc = env.run(LS.AMBUSH_EVENT, ambushEvent(strikes[0].payload));
      assert.deepStrictEqual([esc.res.outcome, esc.v.applied, esc.v.action], ["ESCAPED", true, "ESCAPED"]);
      const j = env.q("SELECT payload FROM world_event_journal WHERE idempotency_key = ?",
        LS.hitKey(sc.campId, strikes[0].payload.convoyId)).map((r) => JSON.parse(r.payload));
      assert.deepStrictEqual(j.map((x) => x.outcome), ["ESCAPED"]);
      assert.strictEqual(env.fleet(strikes[0].payload.fleetId).state, "TRAVELLING");
      assert.strictEqual(env.lowsec.getStatus().counters.escapes, 1);
    } finally {
      env.stop();
    }
  }));

  needsDriver("LA6 scan windows: [a,a+s) + [a+s,a+2s) cover [a,a+2s) without a gap; two consecutive KEEP "
    + "steps over a crossing on the boundary -> one LOWSEC_AMBUSH", async () => {
    const rng = createRng(20261027);
    const fleets = new Map();
    const convoys = [];
    for (let n = 0; n < 200; n += 1) {
      const jumpMs = rng.nextInt(10, 400);
      const departAt = rng.nextInt(0, 2000);
      const id = `c${String(n).padStart(3, "0")}`;
      fleets.set(`f${id}`, { state: "TRAVELLING", legSeq: 1, route: { v: 1, mode: "travel",
        systems: [S.N0, S.L1, S.L2], departAt, jumpMs, arriveAt: departAt + 2 * jumpMs, graphVersion: 1,
        observed: false } });
      convoys.push({ convoyId: id, factionId: FACTION_A, fleetId: `f${id}` });
    }
    const camp = { systemId: S.L1 };
    const a = 700;
    const s = 300;
    const ids = (list) => new Set(list.map((x) => x.convoyId));
    const w1 = ids(crossingsOf(camp, convoys, fleets, { start: a, end: a + s }));
    const w2 = ids(crossingsOf(camp, convoys, fleets, { start: a + s, end: a + 2 * s }));
    const whole = ids(crossingsOf(camp, convoys, fleets, { start: a, end: a + 2 * s }));
    assert.deepStrictEqual([...new Set([...w1, ...w2])].sort(), [...whole].sort(), "no gap");
    const both = [...w1].filter((x) => w2.has(x)).sort();
    const straddle = convoys.filter((c) => {
      const r = fleets.get(c.fleetId).route;
      const t = r.departAt + r.jumpMs;
      return t < a + s && t + r.jumpMs > a + s;
    }).map((c) => c.convoyId).sort();
    assert.deepStrictEqual(both, straddle, "only the crossings over the boundary are in both windows");
    assert.ok(whole.size > 10 && both.length > 0, `${whole.size} ${both.length}`);

    await H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const env = await boot(reopen(), shared, testConfig());
      try {
        const sc = await scene(env);
        const cv = convoy(env, "la6");
        const step = env.cfg.lowsec.stepIntervalMs;
        const at1 = cv.t1 + Math.floor(cv.leg.jumpMs / 2) - step;
        const s1 = env.run(LS.STEP_EVENT, stepEvent(env, sc.campId, at1));
        const s2 = env.run(LS.STEP_EVENT, stepEvent(env, sc.campId, at1 + step));
        assert.deepStrictEqual([s1.res.outcome, s1.v.strikes, s2.res.outcome, s2.v.strikes], ["KEEP", 1, "KEEP", 0]);
        const strikes = env.events(LS.AMBUSH_EVENT);
        assert.deepStrictEqual(strikes.map((x) => x.payload.at), [Math.max(cv.t1, at1)]);
        assert.strictEqual(env.lowsec.getStatus().counters.scans, 2);
      } finally {
        env.stop();
      }
    });
  });

  needsDriver("LA7 soft deps and STALE branches: battle unavailable -> STALE BATTLE_UNAVAILABLE, no "
    + "stop; STALE_LEG at the effect -> STALE; camp fleet on another operation -> CAMP_FLEET_AWAY; no logistics -> "
    + "KEEP, scan off", async () => {
    const got = {};
    await H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const env = await boot(reopen(), shared, testConfig(), { getBattle: () => createUnavailableBattle("TEST_OFF") });
      try {
        const sc = await scene(env);
        const cv = convoy(env, "la7a");
        const s = env.run(LS.STEP_EVENT, stepEvent(env, sc.campId, cv.t1));
        const strike = env.events(LS.AMBUSH_EVENT)[0];
        const a = env.run(LS.AMBUSH_EVENT, ambushEvent(strike.payload));
        const st = env.lowsec.getStatus();
        const f = env.fleet(cv.fleetId);
        got.battleOff = [s.v.strikes, a.res.outcome, st.counters.strikesStale, st.lastRefusal, f.state, f.legSeq,
          env.fleets.travel.getCounters().intercepts];
        got.battleOffExpected = [1, "STALE", 1, "AMBUSH_BATTLE_UNAVAILABLE", "TRAVELLING", cv.legSeq, 0];
      } finally {
        env.stop();
      }
    });
    await H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const env = await boot(reopen(), shared, testConfig());
      try {
        const sc = await scene(env);
        const cv = convoy(env, "la7b");
        env.run(LS.STEP_EVENT, stepEvent(env, sc.campId, cv.t1));
        const strike = env.events(LS.AMBUSH_EVENT)[0];
        const res = env.handlers[LS.AMBUSH_EVENT](ambushEvent(strike.payload), {});
        const r = env.fleets.planTravel({ fleetId: cv.fleetId, targetSystemId: S.L2, at: cv.leg.departAt },
          "la7b:replan");
        assert.ok(r.ok, JSON.stringify(r));
        const v = env.tx((db) => res.effect(db, ambushEvent(strike.payload)));
        res.onCommitted(v);
        const st = env.lowsec.getStatus();
        got.staleLeg = [res.outcome, v, st.counters.strikesStale, st.lastRefusal,
          env.q("SELECT count(*) AS n FROM world_event_journal WHERE idempotency_key = ?",
            LS.hitKey(sc.campId, cv.convoyId))[0].n, env.fleet(cv.fleetId).state];
        got.staleLegExpected = ["INTERCEPT", { ok: true, applied: false, action: "STALE", reason: "STALE_LEG" }, 1,
          "AMBUSH_STALE_LEG", 0, "TRAVELLING"];
      } finally {
        env.stop();
      }
    });
    await H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const env = await boot(reopen(), shared, testConfig(), { getLogistics: () => null });
      try {
        const sc = await scene(env);
        const cv = convoy(env, "la7c");
        const s = env.run(LS.STEP_EVENT, stepEvent(env, sc.campId, cv.t1));
        const st = env.lowsec.getStatus();
        got.noLogistics = [s.res.outcome, s.v.strikes, st.scan, st.lastScanRefusal, st.counters.scans,
          env.events(LS.AMBUSH_EVENT).length, env.camp(sc.campId).state];
        got.noLogisticsExpected = ["KEEP", 0, "off", "LOGISTICS_UNAVAILABLE", 0, 0, "ACTIVE"];
      } finally {
        env.stop();
      }
    });
    const leg = { v: 1, mode: "travel", systems: [S.N0, S.L1, S.L2], departAt: 1000, jumpMs: 100, arriveAt: 1200,
      graphVersion: 1, observed: false };
    const facts = (campFleetOp) => ({ p: { campId: "lc_1", convoyId: "cv_1", fleetId: "f_c", legSeq: 2,
      systemIndex: 1, at: 1100 }, worldSeed: 7, hostile: true, cooldownUntil: null,
    camp: { state: "ACTIVE", activeFrom: 0, untilAt: 5000, systemId: S.L1, operationId: "op_c" },
    convoy: { state: "IN_TRANSIT", fleetId: "f_c", factionId: FACTION_A },
    convoyFleet: { state: "TRAVELLING", legSeq: 2, route: leg },
    campFleet: { state: "STAGED", currentSystemId: S.L1, operationId: campFleetOp } });
    const go = { interceptChancePermille: 1000 };
    got.campOp = [decideAmbush(facts("op_c"), go).action, decideAmbush(facts("op_other"), go).reason,
      decideAmbush(facts(null), go).reason];
    got.campOpExpected = ["INTERCEPT", "CAMP_FLEET_AWAY", "CAMP_FLEET_AWAY"];
    const pick = (suffix) => Object.fromEntries(Object.entries(got).filter(([k]) => k.endsWith("Expected") === suffix)
      .map(([k, v]) => [suffix ? k.slice(0, -"Expected".length) : k, v]));
    assert.deepStrictEqual(pick(false), pick(true));
  });

  needsDriver("LA8 more IN_TRANSIT convoys than scanMaxConvoys + an older TO_SOURCE one: the "
    + "newest hostile convoy is struck by the next scan; scanTruncated", () => H.withStore(driver, async (reopen) => {
    const shared = H.sharedOf();
    const env = await boot(reopen(), shared, testConfig({ scanMaxConvoys: 2 }));
    try {
      const sc = await scene(env);
      const f = env.fleets.createFleet({ factionId: FACTION_A, currentSystemId: S.L2, homeSystemId: S.L2,
        fleetRole: "logistics", composition: CONVOY }, "la8:src:create");
      assert.ok(f.ok, JSON.stringify(f));
      const d = env.tx((db) => env.logistics.dispatchInTx(db, { factionId: FACTION_A, fleetId: f.fleetId,
        expectedVersion: 1, purpose: "HULLS_TO_MOBILIZATION", sourceStationId: "st-src", destStationId: "st-dst",
        items: [{ itemKind: "hull", itemKey: "group:battleship", quantity: 1 }], at: env.shared.clock.now() },
      "la8:src"));
      assert.deepStrictEqual([d.ok, d.state], [true, "TO_SOURCE"], JSON.stringify(d));
      const cvs = ["la8b", "la8c", "la8d"].map((tag) => convoy(env, tag));
      const ids = [d.convoyId, ...cvs.map((c) => c.convoyId)];
      assert.deepStrictEqual([...ids].sort(), ids, "convoy_id order = creation order");
      const cv = cvs[0];
      const step = env.cfg.lowsec.stepIntervalMs;
      const at1 = cv.t1 + Math.floor(cv.leg.jumpMs / 2) - step;
      const s1 = env.run(LS.STEP_EVENT, stepEvent(env, sc.campId, at1));
      const t1 = env.lowsec.getStatus().counters.scanTruncated;
      const s2 = env.run(LS.STEP_EVENT, stepEvent(env, sc.campId, at1 + step));
      const st = env.lowsec.getStatus();
      assert.deepStrictEqual([s1.res.outcome, s1.v.strikes, s2.res.outcome, s2.v.strikes, t1, st.counters.scanTruncated,
        st.counters.scans], ["KEEP", 2, "KEEP", 1, 1, 1, 2]);
      assert.deepStrictEqual(env.events(LS.AMBUSH_EVENT).map((e) => e.payload.convoyId).sort(),
        cvs.map((c) => c.convoyId));
    } finally {
      env.stop();
    }
  }));

  needsDriver("LA9 scanMaxConvoys 2, three IN_TRANSIT convoys: the scan after the short page starts "
    + "from the first convoy again (truncated again); a truncated plan read counts scanTruncated", () =>
    H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const registry = { listActiveFactions: () => [{ factionId: FACTION_B, kind: "pirate" }] };
      const env = await boot(reopen(), shared, testConfig({ scanMaxConvoys: 2 }), { registry });
      try {
        const sc = await scene(env);
        const cvs = ["la9b", "la9c", "la9d"].map((tag) => convoy(env, tag));
        const step = env.cfg.lowsec.stepIntervalMs;
        const at1 = cvs[0].t1 + Math.floor(cvs[0].leg.jumpMs / 2) - step;
        const truncated = () => env.lowsec.getStatus().counters.scanTruncated;
        const seen = [];
        for (let i = 0; i < 3; i += 1) {
          env.run(LS.STEP_EVENT, stepEvent(env, sc.campId, at1 + i * step));
          seen.push(truncated());
        }
        const round = Math.floor(env.shared.clock.now() / env.cfg.lowsec.planPeriodMs) + 1;
        const plan = env.run(LS.PLAN_EVENT, { eventType: LS.PLAN_EVENT, dueAt: env.shared.clock.now(),
          payload: { round }, idempotencyKey: LS.planKey(round) });
        seen.push(truncated());
        assert.deepStrictEqual({ seen, plans: env.lowsec.getStatus().counters.plans, outcome: plan.res.ok },
          { seen: [1, 1, 2, 3], plans: 1, outcome: true });
      } finally {
        env.stop();
      }
    }));

  const telemetryOf = () => {
    const counts = {};
    return { counts, count: (name, n) => {
      counts[name] = (counts[name] || 0) + n;
    }, gauge() {}, observe() {} };
  };

  needsDriver("LSF1 scan funnel: 3 hostile convoys (in the window, after it, known key) -> "
    + "scanHostileConvoys 3, scanCrossings 2, strikesKnown 1, strikesScheduled 1 (+ telemetry)", () =>
    H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const tel = telemetryOf();
      const env = await boot(reopen(), shared, testConfig(), { telemetry: tel });
      try {
        const sc = await scene(env);
        const a = convoy(env, "lsf1a");
        const known = convoy(env, "lsf1k");
        const step = env.cfg.lowsec.stepIntervalMs;
        const k = env.scheduler.enqueue(LS.AMBUSH_EVENT, sc.campId, known.t1, { campId: sc.campId,
          convoyId: known.convoyId, fleetId: known.fleetId, legSeq: known.legSeq, systemIndex: 1, at: known.t1 },
        LS.ambushKey(sc.campId, known.convoyId));
        assert.ok(k.ok, JSON.stringify(k));
        shared.clock.set(a.t1 + step);
        const late = convoy(env, "lsf1l");
        assert.ok(late.t1 >= a.t1 + step, `${late.t1} ${a.t1 + step}`);
        const s = env.run(LS.STEP_EVENT, stepEvent(env, sc.campId, a.t1));
        const st = env.lowsec.getStatus();
        const names = ["scanHostileConvoys", "scanCrossings", "strikesKnown", "strikesCapped", "strikesScheduled"];
        assert.deepStrictEqual({ outcome: s.res.outcome, strikes: s.v.strikes, funnel: st.funnel,
          tel: names.map((n) => tel.counts[`lowsec.${n}`] || 0),
          struck: env.events(LS.AMBUSH_EVENT).map((e) => e.payload.convoyId).sort() }, {
          outcome: "KEEP", strikes: 1,
          funnel: { scanHostileConvoys: 3, scanCrossings: 2, strikesKnown: 1, strikesCapped: 0, strikesScheduled: 1,
            escapes: 0, intercepts: 0, strikesStale: 0 },
          tel: [3, 2, 1, 0, 1],
          struck: [a.convoyId, known.convoyId].sort() });
      } finally {
        env.stop();
      }
    }));

  needsDriver("LSF2 staleByReason: interceptInTx STALE_LEG, camp fleet away "
    + "CAMP_FLEET_AWAY, unknown reason -> OTHER; totals in the `lowsec: stale` line of the next plan",
  () => H.withStore(driver, async (reopen) => {
    const shared = H.sharedOf();
    const registry = { listActiveFactions: () => [{ factionId: FACTION_B, kind: "pirate" }] };
    const env = await boot(reopen(), shared, testConfig(), { registry });
    try {
      const sc = await scene(env);
      const a = convoy(env, "lsf2a");
      const b = convoy(env, "lsf2b");
      const s = env.run(LS.STEP_EVENT, stepEvent(env, sc.campId, a.t1));
      assert.strictEqual(s.v.strikes, 2);
      const strikeOf = (cv) => env.events(LS.AMBUSH_EVENT).find((e) => e.payload.convoyId === cv.convoyId).payload;
      const pb = strikeOf(b);
      const pa = strikeOf(a);
      const res = env.handlers[LS.AMBUSH_EVENT](ambushEvent(pb), {});
      const r = env.fleets.planTravel({ fleetId: b.fleetId, targetSystemId: S.L2, at: b.leg.departAt }, "lsf2:replan");
      assert.ok(r.ok, JSON.stringify(r));
      res.onCommitted(env.tx((db) => res.effect(db, ambushEvent(pb))));
      env.tx((db) => db.prepare("UPDATE world_lowsec_camps SET operation_id = ? WHERE camp_id = ?")
        .run("op_other", sc.campId));
      const x = env.run(LS.AMBUSH_EVENT, ambushEvent(pa));
      const st = env.lowsec.getStatus();
      assert.deepStrictEqual({ outcome: x.res.outcome, stale: st.staleByReason, total: st.counters.strikesStale,
        funnel: st.funnel.strikesStale, last: st.lastRefusal,
        keys: ["NOPE", "__proto__", "STALE_LEG", "CAMP_FLEET_AWAY", undefined].map(staleKeyOf) }, {
        outcome: "STALE", stale: { STALE_LEG: 1, CAMP_FLEET_AWAY: 1 }, total: 2, funnel: 2,
        last: "AMBUSH_CAMP_FLEET_AWAY", keys: ["OTHER", "OTHER", "STALE_LEG", "CAMP_FLEET_AWAY", "OTHER"] });
      const round = Math.floor(env.shared.clock.now() / env.cfg.lowsec.planPeriodMs) + 1;
      env.run(LS.PLAN_EVENT, { eventType: LS.PLAN_EVENT, dueAt: env.shared.clock.now(), payload: { round },
        idempotencyKey: LS.planKey(round) });
      assert.deepStrictEqual(env.lines.filter((l) => l.startsWith("lowsec: stale ")),
        ["lowsec: stale CAMP_FLEET_AWAY=1 STALE_LEG=1"]);
    } finally {
      env.stop();
    }
  }));

  needsDriver("LSF4 plan funnel: a new camp on the convoy route -> planLowsecCrossings "
    + "campsOnRoute, planCrossingsInWindow, `lowsec: plan` line", () => H.withStore(driver, async (reopen) => {
    const shared = H.sharedOf();
    const registry = { listActiveFactions: () => [{ factionId: FACTION_B, kind: "pirate" }] };
    const env = await boot(reopen(), shared, testConfig({ campChoiceTopN: 1 }), { registry });
    try {
      const t0 = shared.clock.now();
      for (const [id, sys] of [["st-src", S.N0], ["st-dst", S.L2]]) {
        const r = env.tx((db) => env.stations.repository.createStation(db, { stationId: id, kind: "upwell",
          typeId: 35832, structureFamily: "astrahus", systemId: sys, ownerFactionId: FACTION_A,
          ownerCorporationId: 1000162, origin: "built", at: t0 }, `test:station:${id}`));
        assert.ok(r.ok, JSON.stringify(r));
      }
      const stock = env.tx((db) => env.stations.repository.applyStockChange(db, { stationId: "st-src",
        key: "test:stock", reason: "TEST", at: t0, deltas: [{ itemKind: "hull", itemKey: "group:battleship",
          delta: 5 }] }));
      assert.ok(stock.ok, JSON.stringify(stock));
      const cf = env.fleets.createFleet({ factionId: FACTION_B, currentSystemId: S.N0, homeSystemId: S.N0,
        fleetRole: "patrol", composition: CAMP_COMP }, "lsf4:campfleet");
      assert.ok(cf.ok, JSON.stringify(cf));
      const cv = convoy(env, "lsf4");
      const round = Math.floor(t0 / env.cfg.lowsec.planPeriodMs) + 1;
      const plan = env.run(LS.PLAN_EVENT, { eventType: LS.PLAN_EVENT, dueAt: t0, payload: { round },
        idempotencyKey: LS.planKey(round) });
      assert.strictEqual(plan.v.created.length, 1, JSON.stringify(plan.v));
      const camp = env.camp(plan.v.created[0].campId);
      const from = camp.untilAt - camp.detail.durationMs;
      const inWindow = cv.t1 >= from && cv.t1 < camp.untilAt ? 1 : 0;
      const c = env.lowsec.getStatus().counters;
      assert.deepStrictEqual({ system: camp.systemId, counters: [c.planLowsecCrossings, c.campsOnRoute,
        c.planCrossingsInWindow], lines: env.lines.filter((l) => l.startsWith("lowsec: plan round=")) }, {
        system: S.L1, counters: [1, 1, inWindow],
        lines: [`lowsec: plan round=${round} hostileConvoys=1 lowsecCrossings=1 routeSystems=1 newCamps=1 onRoute=1 `
          + `crossingsInWindow=${inWindow} truncated=0`] });
    } finally {
      env.stop();
    }
  }));

  const strikeRows = (env) => env.q("SELECT state, attempts, last_error FROM world_scheduled_events "
    + "WHERE event_type = ?", LS.AMBUSH_EVENT).map((r) => [r.state, r.attempts, r.last_error]);

  needsDriver("LA10 real-length ids (lc_ / cv_ of createIdGenerator): the stop key fits 64 -> the "
    + "convoy is stopped in L1, the strike DONE", () => H.withStore(driver, async (reopen) => {
    const shared = H.sharedOf();
    const env = await boot(reopen(), shared, testConfig());
    try {
      const sc = await scene(env, 4 * HOUR, shared.ids.next("lc"));
      const cv = convoy(env, "la10");
      const hit = LS.hitKey(sc.campId, cv.convoyId);
      assert.ok(`${hit}:halt`.length > 64, String(`${hit}:halt`.length));
      const q = env.scheduler.enqueue(LS.STEP_EVENT, sc.campId, cv.t1, { campId: sc.campId, stepSeq: 1, round: 0 },
        LS.stepKey(sc.campId, 1));
      assert.ok(q.ok, JSON.stringify(q));
      await env.settle(cv.t1 + 1000);
      assert.deepStrictEqual(strikeRows(env).map((r) => r[0]), ["DONE"], JSON.stringify(strikeRows(env)));
      const f = env.fleet(cv.fleetId);
      assert.deepStrictEqual([f.state, f.currentSystemId], ["STAGED", S.L1]);
      assert.strictEqual(env.camp(sc.campId).intercepts, 1);
      const haltKey = ambushHaltKeyOf(hit);
      assert.ok(haltKey.length <= 64, haltKey);
      const halt = env.tx((db) => env.journal.findByKey(db, haltKey));
      assert.deepStrictEqual([halt.found, halt.entry.aggregateType, halt.entry.aggregateId], [true, "fleet",
        cv.fleetId]);
      assert.strictEqual(ambushHaltKeyOf(hit), haltKey);
      assert.notStrictEqual(ambushHaltKeyOf(LS.hitKey(sc.campId, "cv_other")), haltKey);
    } finally {
      env.stop();
    }
  }));

  needsDriver("LA11 interceptInTx FLEET_INVALID_INPUT -> permanent refusal: the strike QUARANTINED "
    + "after one attempt, nothing written", () => H.withStore(driver, async (reopen) => {
    const shared = H.sharedOf();
    const travelOf = (t) => ({ ...t, interceptInTx: () => ({ ok: false, reason: "FLEET_INVALID_INPUT",
      detail: "idempotencyKey" }) });
    const env = await boot(reopen(), shared, testConfig(), { travelOf });
    try {
      const sc = await scene(env);
      const cv = convoy(env, "la11");
      const q = env.scheduler.enqueue(LS.STEP_EVENT, sc.campId, cv.t1, { campId: sc.campId, stepSeq: 1, round: 0 },
        LS.stepKey(sc.campId, 1));
      assert.ok(q.ok, JSON.stringify(q));
      await env.settle(cv.t1 + 1000);
      const rows = strikeRows(env);
      assert.deepStrictEqual(rows.map((r) => [r[0], r[1]]), [["QUARANTINED", 1]], JSON.stringify(rows));
      assert.ok(String(rows[0][2]).includes("FLEET_INVALID_INPUT"), JSON.stringify(rows));
      assert.strictEqual(env.fleet(cv.fleetId).state, "TRAVELLING");
      assert.strictEqual(env.camp(sc.campId).intercepts, 0);
      const hit = env.tx((db) => env.journal.findByKey(db, LS.hitKey(sc.campId, cv.convoyId)));
      assert.strictEqual(hit.found, false);
    } finally {
      env.stop();
    }
  }));
};

Object.assign(module.exports, { harness: Object.freeze({ boot, scene, convoy, stepEvent, ambushEvent, testConfig,
  CAMP_COMP }) });
