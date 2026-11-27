"use strict";

const assert = require("node:assert");
const path = require("node:path");

const config = require("../../config");
const { createJournal } = require("../../lib/persistence/journal");
const { LATEST_SCHEMA_VERSION, MIGRATIONS } = require("../../lib/persistence/migrations");
const { startScheduler } = require("../../lib/scheduler");
const { startFleets } = require("../../lib/fleets");
const { startStations } = require("../../lib/stations");
const { canTransitionStation } = require("../../lib/stations/stateMachine");
const { startLogistics } = require("../../lib/economy/logistics");
const { convoyStepRows } = require("../../lib/economy/schema");
const { startConstruction, createUnavailableConstruction } = require("../../lib/stations/construction");
const { BUILD_TRANSITIONS, ACTION, ACTION_EDGES, decideBuildStep } =
  require("../../lib/stations/construction/buildMachine");
const { receiveOf, parsePayload } = require("../../lib/stations/construction/constructionService");
const { CONSTRUCTION_RECEIVE_ROWS, constructionDeliverRows, buildDueKey } =
  require("../../lib/stations/construction/schema");
const { buildKitTable } = require("../../lib/stations/data/buildKits");
const { createIndustryCatalog } = require("../../lib/economy/industry/catalog");
const { createViewRegistry } = require("../../lib/observer/views");
const { harness: H } = require("../battle/settlement.test");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const { S, FACTION_A, FACTION_B } = H;
const DEFAULTS = config.resolveConfig({ modDir: MOD_DIR, env: {} }).config;
const BUILD_KITS = buildKitTable(createIndustryCatalog().catalog, {
  componentWeightPermille: DEFAULTS.production.componentWeightPermille,
  componentFactorMaxPermille: DEFAULTS.production.componentFactorMaxPermille,
  kitComponentFactorPermille: DEFAULTS.construction.kitComponentFactorPermille }).kits;
const OLD_ASTRAHUS = Object.freeze({ kind: "upwell", structureFamily: "astrahus", typeId: 35832,
  items: Object.freeze({ "mineral/type:34": 16800000, "mineral/type:35": 4200000, "mineral/type:36": 1050000,
    "mineral/type:37": 260000, "mineral/type:38": 66000, "mineral/type:39": 32000, "mineral/type:40": 12000 }) });
const HOUR = 3600000;
const CORP = 1000162;
const CONVOY = Object.freeze([{ hullGroup: "industrial", count: 2 }, { hullGroup: "frigate", count: 2 }]);
const M34 = "mineral/type:34";
const M35 = "mineral/type:35";
const KITS = Object.freeze({ mini: Object.freeze({ kind: "upwell", structureFamily: "astrahus", typeId: 35832,
  items: Object.freeze({ [M34]: 3000, [M35]: 1000 }) }) });
const FULL = Object.freeze([{ itemKind: "mineral", itemKey: "type:34", quantity: 3500 },
  { itemKind: "mineral", itemKey: "type:35", quantity: 1000 }]);

function testConfig(opts = {}) {
  return { ...H.CONFIG, modules: { ...H.CONFIG.modules, strategy: { enabled: true } },
    fleets: { ...H.CONFIG.fleets, refitPolicy: "station", refitSeekRecheckMs: HOUR, refitSeekMaxRounds: 24 },
    stations: { ...DEFAULTS.stations, refitSeekRecheckMs: HOUR },
    logistics: { ...DEFAULTS.logistics, enabled: true },
    production: { ...DEFAULTS.production },
    construction: { ...DEFAULTS.construction, kitId: opts.kitId || "mini", supplyTimeoutMs: 4 * HOUR, recheckMs: HOUR,
      anchoringMs: 2 * HOUR, enabled: opts.construction !== false, ...(opts.cx || {}) },
    persistence: { ...H.CONFIG.persistence, maxRowsPerTransaction: 500 } };
}

const graphService = (graph) => ({ whenReady: () => Promise.resolve({ ok: true, graph }),
  getGraph: () => ({ ok: true, graph }) });

function fakeWorld(systems) {
  return { repository: { getSystems(tx, ids) {
    return { ok: true, systems: ids.filter((id) => systems.has(id)).map((id) => ({ systemId: id, ...systems.get(id) })),
      missing: ids.filter((id) => !systems.has(id)) };
  } } };
}

const registry = Object.freeze({
  getFaction: (id) => ([FACTION_A, FACTION_B].includes(Number(id))
    ? { factionId: Number(id), startStations: [], ownerCorporationId: CORP } : null),
  listFactions: () => [{ factionId: FACTION_A }],
  listActiveFactions: () => [],
  isActive: (id) => [FACTION_A, FACTION_B].includes(Number(id)),
  corporationFor: (id) => ([FACTION_A, FACTION_B].includes(Number(id)) ? CORP : null),
});

async function boot(opened, shared, world, opts = {}) {
  const cfg = testConfig(opts);
  const journal = createJournal({ clock: shared.clock, maxPayloadBytes: 16384, maxRows: 500 });
  const sr = startScheduler({ config: cfg, persistence: { ok: true, store: opened.store }, clock: shared.clock,
    ids: shared.ids, nowMs: () => 0 });
  assert.ok(sr.ok, JSON.stringify(sr));
  const holder = { stations: null, construction: null };
  const persistence = { ok: true, store: opened.store, journal, worldSeed: opened.worldSeed };
  const fr = startFleets({ config: cfg, persistence, clock: shared.clock, ids: shared.ids, scheduler: sr.scheduler,
    graph: { getGraph: () => ({ ok: true, graph: shared.graph }) }, presence: null, views: createViewRegistry(),
    getStations: () => holder.stations });
  assert.ok(fr.ok, JSON.stringify(fr));
  const st = startStations({ config: cfg, persistence, strategy: { registry }, graph: graphService(shared.graph),
    clock: shared.clock });
  assert.ok(st.ok, JSON.stringify(st));
  holder.stations = st.stations;
  await st.stations.whenReady();
  const lines = [];
  const logger = { log: (l) => lines.push(l) };
  const lr = startLogistics({ config: cfg, persistence, clock: shared.clock, ids: shared.ids, scheduler: sr.scheduler,
    fleets: fr.fleets, strategy: { registry }, getStations: () => holder.stations,
    getConstruction: () => holder.construction, logger });
  assert.ok(lr.ok, JSON.stringify(lr));
  const cr = startConstruction({ config: cfg, persistence, clock: shared.clock, ids: shared.ids,
    scheduler: sr.scheduler, world, strategy: { registry }, getStations: () => holder.stations, logger,
    kitsData: opts.kitsData === undefined ? KITS : opts.kitsData });
  holder.construction = cr.ok ? cr.construction : null;
  const tx = (fn) => {
    const r = opened.store.transaction("test", fn);
    assert.ok(r.ok, JSON.stringify(r));
    return r.value;
  };
  return { store: opened.store, scheduler: sr.scheduler, fleets: fr.fleets, stations: st.stations,
    logistics: lr.logistics, construction: holder.construction, started: cr, lines, tx };
}

function stopAll(env) {
  if (env.construction) env.construction.stop("restart");
  env.logistics.stop("restart");
  env.stations.stop("restart");
  env.store.close("restart");
}

function addStation(env, id, systemId, at) {
  const r = env.tx((db) => env.stations.repository.createStation(db, { stationId: id, kind: "upwell", typeId: 35832,
    structureFamily: "astrahus", systemId, ownerFactionId: FACTION_A, ownerCorporationId: CORP, origin: "built",
    at }, `test:station:${id}`));
  assert.ok(r.ok, JSON.stringify(r));
}

function putStock(env, stationId, deltas, key, at) {
  const r = env.tx((db) => env.stations.repository.applyStockChange(db, { stationId, key, reason: "TEST", at,
    deltas }));
  assert.ok(r.ok, JSON.stringify(r));
}

function newConvoyFleet(env, tag, systemId) {
  const r = env.fleets.createFleet({ factionId: FACTION_A, currentSystemId: systemId, homeSystemId: systemId,
    fleetRole: "logistics", composition: CONVOY }, `${tag}:create`);
  assert.ok(r.ok, JSON.stringify(r));
  return r.fleetId;
}

const fleetOf = (env, id) => env.tx((db) => env.fleets.repository.getFleet(db, id)).fleet;
const convoyOf = (env, id) => env.tx((db) => env.logistics.convoys.getConvoy(db, id)).convoy;
const buildOf = (env, id) => env.tx((db) => env.construction.builds.getBuild(db, id)).build;
const stationOf = (env, id) => env.tx((db) => env.stations.repository.getStation(db, id)).record;
const countOf = (env, sql, ...args) => env.tx((db) => db.prepare(sql).get(...args)).n;
const stockOf = (env, stationId) => env.tx((db) => db.prepare("SELECT item_kind, item_key, quantity FROM "
  + "world_station_stock WHERE station_id = ? ORDER BY item_key").all(stationId))
  .reduce((o, r) => ({ ...o, [`${r.item_kind}/${r.item_key}`]: r.quantity }), {});
const repairAt = (env, systemId) => env.tx((db) => env.stations.locator.hasRepairStation(db, FACTION_A, systemId))
  .stationId;

function plan(env, shared, systemId, key) {
  const r = env.tx((db) => env.construction.planInTx(db, { factionId: FACTION_A, systemId, kitId: "mini",
    at: shared.clock.now() }, key));
  assert.ok(r.ok, JSON.stringify(r));
  return r;
}

function dispatch(env, shared, tag, fleetId, destStationId, items) {
  const f = fleetOf(env, fleetId);
  return env.tx((db) => env.logistics.dispatchInTx(db, { factionId: FACTION_A, fleetId, expectedVersion: f.version,
    purpose: "CONSTRUCTION", sourceStationId: "st-b", destStationId, items, at: shared.clock.now() }, tag));
}

async function settleAt(env, shared, at) {
  shared.clock.set(at);
  for (let i = 0; i < 12; i += 1) {
    const p = await env.scheduler.runPass();
    assert.ok(p.ok, JSON.stringify(p));
    if (p.jobs === 0) return;
  }
  throw new Error("queue did not settle");
}

async function setup(reopen, shared, opts = {}) {
  const systems = new Map([[S.N0, { controllerFactionId: FACTION_A, occupationState: "STABLE" }],
    [S.N5, { controllerFactionId: FACTION_A, occupationState: "STABLE" }],
    [S.N6, { controllerFactionId: FACTION_A, occupationState: "STABLE" }],
    [S.N7, { controllerFactionId: FACTION_A, occupationState: "STABLE" }]]);
  const world = fakeWorld(systems);
  const opened = reopen();
  const env = await boot(opened, shared, world, opts);
  assert.ok(env.started.ok, JSON.stringify(env.started));
  const t0 = shared.clock.now();
  addStation(env, "st-a", S.N0, t0);
  addStation(env, "st-b", S.N5, t0);
  putStock(env, "st-b", [{ itemKind: "mineral", itemKey: "type:34", delta: 20000 },
    { itemKind: "mineral", itemKey: "type:35", delta: 5000 }], "test:stock:b", t0);
  return { env, systems, world, opened };
}

const build = (o) => ({ state: "SUPPLYING", supplyDeadlineAt: 100, anchorUntilAt: null, ...o });

module.exports = ({ test, skip }) => {
  test("K0 pure: decideBuildStep, ANCHORING station edges, receive arithmetic, DELIVER rows on a site <= "
    + "convoyStepRows, construction.* defaults, the unavailable stub", () => {
    const ready = { stationsMode: "ready", site: { good: true, reason: null } };
    const P = { recheckMs: 10 };
    const cases = [
      [null, null, { ...ready, at: 1 }, ACTION.STALE],
      [build({ state: "COMPLETED" }), null, { ...ready, at: 1 }, ACTION.STALE],
      [build(), null, { ...ready, stationsMode: "pending", at: 1 }, ACTION.RETRY_LATER],
      [build(), null, { ...ready, at: 100 }, ACTION.CANCEL, "TIMEOUT"],
      [build(), null, { ...ready, at: 5, site: { good: false, reason: "SITE_NOT_OWN" } }, ACTION.CANCEL,
        "SITE_NOT_OWN"],
      [build(), null, { ...ready, at: 95 }, ACTION.WAIT, undefined, 100],
      [build(), null, { ...ready, at: 5 }, ACTION.WAIT, undefined, 15],
      [build({ state: "ANCHORING", anchorUntilAt: 50 }), { state: "ANCHORING" }, { ...ready, at: 20 }, ACTION.REARM,
        undefined, 50],
      [build({ state: "ANCHORING", anchorUntilAt: 50 }), { state: "ANCHORING" }, { ...ready, at: 50 }, ACTION.COMPLETE,
        "ONLINE"],
      [build({ state: "ANCHORING", anchorUntilAt: 50 }), { state: "ONLINE" }, { ...ready, at: 20 }, ACTION.COMPLETE],
      [build({ state: "ANCHORING", anchorUntilAt: 50 }), { state: "DESTROYED" }, { ...ready, at: 20 }, ACTION.FAIL,
        "DESTROYED"],
      [build({ state: "ANCHORING", anchorUntilAt: 50 }), null, { ...ready, at: 20 }, ACTION.FAIL, "DESTROYED"],
    ];
    for (const [b, st, facts, action, reason, dueAt] of cases) {
      const d = decideBuildStep(b, st, facts, P);
      assert.strictEqual(d.action, action, JSON.stringify([b, st, facts, d]));
      if (reason !== undefined) assert.strictEqual(d.reason, reason);
      if (dueAt !== undefined) assert.strictEqual(d.dueAt, dueAt);
      const edge = ACTION_EDGES[d.action];
      if (edge && b) assert.ok(edge[0] === b.state && BUILD_TRANSITIONS[edge[0]].includes(edge[1]), d.action);
    }
    assert.deepStrictEqual([canTransitionStation("ANCHORING", "ONLINE").ok,
      canTransitionStation("ANCHORING", "DESTROYED").ok, canTransitionStation("ANCHORING", "ARMOR_REINFORCE").reason],
    [true, true, "TRANSITION_NOT_ALLOWED"]);

    const r = receiveOf({ [M34]: 10, [M35]: 5 }, { [M34]: 4 }, { [M34]: 8, [M35]: 5 });
    assert.deepStrictEqual([r.acceptedUnits, r.surplusUnits, r.complete, r.delivered, r.surplus],
      [11, 2, true, { [M34]: 12, [M35]: 5 }, { [M34]: 2 }]);
    assert.strictEqual(receiveOf({ [M34]: 10, [M35]: 5 }, {}, { [M34]: 10 }).complete, false);
    assert.strictEqual(parsePayload({ stationId: "st_x", phaseSeq: 1, round: 0, extra: 1 }), null);

    const kitKeys = Object.keys(BUILD_KITS.astrahus.items).length;
    assert.strictEqual(CONSTRUCTION_RECEIVE_ROWS, 7);
    assert.ok(constructionDeliverRows(kitKeys) <= convoyStepRows(DEFAULTS.logistics.maxCargoItems),
      `${constructionDeliverRows(kitKeys)} > ${convoyStepRows(DEFAULTS.logistics.maxCargoItems)}`);
    assert.strictEqual(Object.values(BUILD_KITS.astrahus.items).reduce((a, b) => a + b, 0), 24329500, "");
    const c = DEFAULTS.construction;
    assert.deepStrictEqual([c.enabled, c.maxOpenBuildsPerFaction, c.supplyTimeoutMs, c.recheckMs, c.anchoringMs,
      c.maxLostConvoys, c.maxStepsPerPass, c.reconcileMaxBuilds, c.reconcileMaxAttempts, c.kitId],
    [true, 2, 259200000, 3600000, 43200000, 1, 20, 200, 8, "astrahus"]);
    assert.deepStrictEqual([c.maxBuildsPerReview, c.targetsGateMax, c.overdueMs, c.minGapMs, c.maxOpenBuildsTotal,
      c.maxLiveStationsTotal], [1, 3, 172800000, 21600000, 8, 100]);
    const stub = createUnavailableConstruction("x");
    assert.deepStrictEqual([stub.getMode(), stub.planInTx().reason, stub.receiveInTx().reason],
      ["off", "CONSTRUCTION_UNAVAILABLE", "CONSTRUCTION_UNAVAILABLE"]);
    assert.strictEqual(startConstruction({ config: testConfig({ construction: false }) }).reason, "disabled_by_config");
  });

  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  needsDriver("K1/K2 build exactly once: plan -> CONSTRUCTION convoy -> ANCHORING (surplus in the stock, no "
    + "repair) -> restart -> ONLINE (repair station); rolled back receive, replayed plan / receive / deadline and the "
    + "reconcile add nothing; migration 19 from zero", () => H.withStore(driver, async (reopen) => {
    const shared = H.sharedOf();
    const ctx = await setup(reopen, shared);
    let env = ctx.env;
    assert.ok(LATEST_SCHEMA_VERSION >= 19);
    assert.strictEqual(MIGRATIONS[18].name, "world_station_builds");
    const p = plan(env, shared, S.N6, "k1:plan");
    assert.deepStrictEqual([p.duplicate, p.state], [false, "SUPPLYING"]);
    const id = p.stationId;
    const again = env.tx((db) => env.construction.planInTx(db, { factionId: FACTION_A, systemId: S.N6, kitId: "mini",
      at: shared.clock.now() + 5 }, "k1:plan"));
    assert.deepStrictEqual([again.ok, again.duplicate, again.stationId], [true, true, id], "K2 plan replayed");
    assert.strictEqual(stationOf(env, id), null, "no station before the kit");

    const fleet = newConvoyFleet(env, "k1f", S.N5);
    const d = dispatch(env, shared, "k1:d", fleet, id, FULL);
    assert.deepStrictEqual([d.ok, d.state], [true, "IN_TRANSIT"], JSON.stringify(d));
    assert.deepStrictEqual(stockOf(env, "st-b"), { [M34]: 16500, [M35]: 4000 }, "source stock down at the load");

    const ROLLBACK = new Error("rollback");
    const rolled = env.store.transaction("test", (db) => {
      const r = env.construction.receiveInTx(db, { stationId: id, factionId: FACTION_A, convoyId: d.convoyId,
        cargo: { [M34]: 3500, [M35]: 1000 }, at: shared.clock.now() });
      assert.ok(r.ok && r.anchored, JSON.stringify(r));
      throw ROLLBACK;
    });
    assert.strictEqual(rolled.ok, false);
    assert.strictEqual(stationOf(env, id), null, "rolled back");

    await settleAt(env, shared, d.arriveAt);
    const c = convoyOf(env, d.convoyId);
    assert.deepStrictEqual([c.state, c.deliveredStationId], ["DELIVERED", id], env.lines.join("\n"));
    let b = buildOf(env, id);
    assert.deepStrictEqual([b.state, b.phaseSeq, b.watchRound, b.delivered, b.surplusUnits, b.convoysDelivered],
      ["ANCHORING", 1, 0, { [M34]: 3500, [M35]: 1000 }, 500, 1]);
    let station = stationOf(env, id);
    assert.deepStrictEqual([station.state, station.origin, station.stateUntilAt, station.ownerCorporationId,
      station.systemId], ["ANCHORING", "built", b.anchorUntilAt, CORP, S.N6]);
    assert.strictEqual(b.anchorUntilAt, b.anchorStartedAt + 2 * HOUR);
    assert.deepStrictEqual(stockOf(env, id), { [M34]: 500 }, "surplus over the kit in the new stock");
    assert.strictEqual(repairAt(env, S.N6), null, "ANCHORING repairs nothing");

    const dup = env.tx((db) => env.construction.receiveInTx(db, { stationId: id, factionId: FACTION_A,
      convoyId: d.convoyId, cargo: { [M34]: 3500, [M35]: 1000 }, at: shared.clock.now() }));
    assert.deepStrictEqual([dup.ok, dup.duplicate], [true, true]);

    stopAll(env);
    env = await boot(reopen(), shared, ctx.world);
    assert.strictEqual(env.construction.getStatus().counters.reconciled, 0, "open deadline -> no reconcile");
    assert.strictEqual(countOf(env, "SELECT count(*) AS n FROM world_scheduled_events WHERE idempotency_key = ? "
      + "AND state = 'QUEUED'", buildDueKey(id, 1, 0)), 1, "the anchoring deadline is open");
    assert.strictEqual(countOf(env, "SELECT count(*) AS n FROM world_scheduled_events WHERE idempotency_key LIKE "
      + "'build:rec:%'"), 0, "no reconcile event");

    await settleAt(env, shared, b.anchorUntilAt);
    b = buildOf(env, id);
    station = stationOf(env, id);
    assert.deepStrictEqual([b.state, b.endReason, station.state, station.stateUntilAt],
      ["COMPLETED", "ONLINE", "ONLINE", null], env.lines.join("\n"));
    assert.strictEqual(repairAt(env, S.N6), id, "ONLINE: a repair station of its faction");

    const q = env.scheduler.enqueue("STATION_BUILD_STEP", id, shared.clock.now(), { stationId: id, phaseSeq: 1,
      round: 0 }, "k2:due");
    assert.ok(q.ok, JSON.stringify(q));
    await settleAt(env, shared, shared.clock.now() + 1000);
    assert.strictEqual(buildOf(env, id).version, b.version);
    assert.strictEqual(countOf(env, "SELECT count(*) AS n FROM world_stations WHERE station_id = ?", id), 1);
    assert.strictEqual(countOf(env, "SELECT count(*) AS n FROM world_event_journal WHERE event_type = "
      + "'STATION_CREATED' AND aggregate_id = ?", id), 1);
    assert.strictEqual(countOf(env, "SELECT count(*) AS n FROM world_event_journal WHERE event_type = "
      + "'STATION_TRANSITION' AND aggregate_id = ?", id), 1);
    assert.strictEqual(env.construction.reconcile().enqueued, 0, "nothing open");
  }, { fresh: true }));

  needsDriver("K3 no kit, no station: half a kit -> SUPPLYING; the next convoy LOST -> CANCELLED CONVOYS_LOST "
    + "(delivered units lost); a build without deliveries -> CANCELLED TIMEOUT", () => H.withStore(driver,
    async (reopen) => {
      const shared = H.sharedOf();
      const { env } = await setup(reopen, shared);
      const p = plan(env, shared, S.N6, "k3:plan");
      const half = dispatch(env, shared, "k3:d1", newConvoyFleet(env, "k3f1", S.N5), p.stationId,
        [{ itemKind: "mineral", itemKey: "type:34", quantity: 1500 }]);
      assert.ok(half.ok, JSON.stringify(half));
      await settleAt(env, shared, half.arriveAt);
      let b = buildOf(env, p.stationId);
      assert.deepStrictEqual([b.state, b.delivered, b.convoysDelivered], ["SUPPLYING", { [M34]: 1500 }, 1],
        env.lines.join("\n"));
      assert.strictEqual(stationOf(env, p.stationId), null, "half a kit -> no station");

      const lostFleet = newConvoyFleet(env, "k3f2", S.N5);
      const rest = dispatch(env, shared, "k3:d2", lostFleet, p.stationId,
        [{ itemKind: "mineral", itemKey: "type:34", quantity: 1500 }, { itemKind: "mineral", itemKey: "type:35",
          quantity: 1000 }]);
      assert.ok(rest.ok, JSON.stringify(rest));
      env.tx((db) => {
        const x = env.fleets.repository.getFleet(db, lostFleet).fleet;
        const e = env.fleets.repository.transition(db, { fleetId: lostFleet, expectedVersion: x.version,
          from: x.state, to: "ENGAGED" }, "k3:engage");
        assert.ok(e.ok, JSON.stringify(e));
        const l = env.fleets.repository.applyLosses(db, { fleetId: lostFleet, expectedVersion: e.version,
          losses: CONVOY.map((s) => ({ hullGroup: s.hullGroup, typeId: null, count: s.count })) }, "k3:loss");
        assert.ok(l.ok && l.destroyed, JSON.stringify(l));
      });
      await settleAt(env, shared, rest.arriveAt + DEFAULTS.logistics.watchGraceMs);
      assert.strictEqual(convoyOf(env, rest.convoyId).state, "LOST");
      b = buildOf(env, p.stationId);
      assert.deepStrictEqual([b.state, b.endReason, b.convoysLost, b.lostUnits], ["CANCELLED", "CONVOYS_LOST", 1,
        1500], env.lines.join("\n"));
      assert.strictEqual(stationOf(env, p.stationId), null);

      const t = shared.clock.now();
      const idle = plan(env, shared, S.N7, "k3:plan2");
      await settleAt(env, shared, t + 4 * HOUR);
      const timedOut = buildOf(env, idle.stationId);
      assert.deepStrictEqual([timedOut.state, timedOut.endReason, timedOut.lostUnits], ["CANCELLED", "TIMEOUT", 0],
        env.lines.join("\n"));
      assert.strictEqual(stationOf(env, idle.stationId), null);
    }));

  needsDriver("K4 ANCHORING: no repair / ONLINE list, no reinforce edge, DESTROYED wipes the surplus "
    + "failBuildInTx -> FAILED once, the anchoring deadline after it is STALE", () => H.withStore(driver,
    async (reopen) => {
      const shared = H.sharedOf();
      const { env } = await setup(reopen, shared);
      const p = plan(env, shared, S.N6, "k4:plan");
      const id = p.stationId;
      const r = env.tx((db) => env.construction.receiveInTx(db, { stationId: id, factionId: FACTION_A,
        convoyId: "cv_k4", cargo: { [M34]: 3500, [M35]: 1000 }, at: shared.clock.now() }));
      assert.deepStrictEqual([r.ok, r.anchored, r.acceptedUnits, r.surplusUnits], [true, true, 4000, 500],
        JSON.stringify(r));
      const st = stationOf(env, id);
      assert.strictEqual(st.state, "ANCHORING");
      assert.strictEqual(repairAt(env, S.N6), null);
      const online = env.tx((db) => env.stations.repository.listStationsOfFaction(db, FACTION_A,
        { states: ["ONLINE"] })).records.map((s) => s.stationId);
      assert.deepStrictEqual(online.sort(), ["st-a", "st-b"]);
      const reinforce = env.tx((db) => env.stations.repository.transitionStation(db, { stationId: id,
        expectedVersion: st.version, from: "ANCHORING", to: "ARMOR_REINFORCE", key: "k4:reinforce", reason: "SIEGE",
        at: shared.clock.now() }));
      assert.strictEqual(reinforce.reason, "TRANSITION_NOT_ALLOWED");
      const [destroyed, failed] = env.tx((db) => [env.stations.repository.transitionStation(db, { stationId: id,
        expectedVersion: st.version, from: "ANCHORING", to: "DESTROYED", key: "k4:destroy", reason: "SIEGE",
        at: shared.clock.now() }), env.construction.failBuildInTx(db, { stationId: id, at: shared.clock.now(),
        reason: "DESTROYED" }, "k4:fail")]);
      assert.ok(destroyed.ok, JSON.stringify(destroyed));
      assert.deepStrictEqual(destroyed.lostStock.map((s) => [s.itemKey, s.quantity]), [["type:34", 500]]);
      assert.deepStrictEqual([failed.ok, failed.duplicate], [true, false], JSON.stringify(failed));
      const twice = env.tx((db) => env.construction.failBuildInTx(db, { stationId: id, at: shared.clock.now(),
        reason: "DESTROYED" }, "k4:fail"));
      assert.deepStrictEqual([twice.ok, twice.duplicate], [true, true]);
      const b = buildOf(env, id);
      assert.deepStrictEqual([b.state, b.endReason], ["FAILED", "DESTROYED"]);
      await settleAt(env, shared, b.anchorUntilAt);
      assert.strictEqual(stationOf(env, id).state, "DESTROYED", "the deadline after the fall -> STALE, no ONLINE");
      assert.strictEqual(buildOf(env, id).version, b.version);
      assert.ok(env.construction.getStatus().counters.stale >= 1, JSON.stringify(env.construction.getStatus()));
      assert.strictEqual(countOf(env, "SELECT count(*) AS n FROM world_scheduled_events WHERE idempotency_key = ? "
        + "AND state = 'DONE'", buildDueKey(id, 1, 0)), 1);
    }));

  needsDriver("K5 bad site and the switch: the controller changes in flight -> REDIRECT to an own station "
    + "(cargo kept), the build CANCELLED SITE_NOT_OWN; construction.enabled=false -> CONSTRUCTION dispatch "
    + "DEST_INVALID, an open build frozen", () => H.withStore(driver, async (reopen) => {
    const shared = H.sharedOf();
    const ctx = await setup(reopen, shared);
    let env = ctx.env;
    const p = plan(env, shared, S.N6, "k5:plan");
    const d = dispatch(env, shared, "k5:d", newConvoyFleet(env, "k5f", S.N5), p.stationId, FULL);
    assert.deepStrictEqual([d.ok, d.state], [true, "IN_TRANSIT"], JSON.stringify(d));
    ctx.systems.set(S.N6, { controllerFactionId: FACTION_B, occupationState: "OCCUPIED" });
    await settleAt(env, shared, d.arriveAt);
    await settleAt(env, shared, d.arriveAt + HOUR);
    await settleAt(env, shared, d.arriveAt + 3 * HOUR);
    const c = convoyOf(env, d.convoyId);
    assert.deepStrictEqual([c.state, c.deliveredStationId], ["DELIVERED", "st-b"], env.lines.join("\n"));
    assert.deepStrictEqual(stockOf(env, "st-b"), { [M34]: 20000, [M35]: 5000 }, "the cargo back in an own stock");
    const b = buildOf(env, p.stationId);
    assert.deepStrictEqual([b.state, b.endReason, b.lostUnits], ["CANCELLED", "SITE_NOT_OWN", 0]);
    assert.strictEqual(stationOf(env, p.stationId), null);

    const frozen = plan(env, shared, S.N7, "k5:plan2");
    stopAll(env);
    env = await boot(reopen(), shared, ctx.world, { construction: false });
    assert.deepStrictEqual([env.started.ok, env.started.reason, env.construction], [false, "disabled_by_config", null]);
    const refused = dispatch(env, shared, "k5:d2", newConvoyFleet(env, "k5f2", S.N5), frozen.stationId, FULL);
    assert.deepStrictEqual([refused.ok, refused.reason], [false, "DEST_INVALID"], JSON.stringify(refused));
    await settleAt(env, shared, shared.clock.now() + 2 * HOUR);
    const row = () => env.tx((db) => db.prepare("SELECT state, watch_round AS r FROM world_station_builds WHERE "
      + "station_id = ?").get(frozen.stationId));
    assert.deepStrictEqual([row().state, row().r], ["SUPPLYING", 0], "frozen while off");
    stopAll(env);
    env = await boot(reopen(), shared, ctx.world);
    await settleAt(env, shared, shared.clock.now() + 1000);
    assert.strictEqual(row().state, "SUPPLYING");
    assert.ok(row().r >= 1, "steps run again after switching on");
  }));

  needsDriver("CS1 planInTx global brakes: an open build of another faction at maxOpenBuildsTotal -> "
    + "BUILD_LIMIT_TOTAL; the receive of that build still anchors; live stations at maxLiveStationsTotal -> "
    + "GLOBAL_STATION_LIMIT", () => H.withStore(driver, async (reopen) => {
    const shared = H.sharedOf();
    const ctx = await setup(reopen, shared, { cx: { maxOpenBuildsTotal: 1, maxLiveStationsTotal: 3 } });
    let env = ctx.env;
    ctx.systems.set(S.N7, { controllerFactionId: FACTION_B, occupationState: "STABLE" });
    const other = env.tx((db) => env.construction.planInTx(db, { factionId: FACTION_B, systemId: S.N7, kitId: "mini",
      at: shared.clock.now() }, "cs1:b"));
    assert.ok(other.ok && !other.duplicate, JSON.stringify(other));
    const refusedA = env.tx((db) => env.construction.planInTx(db, { factionId: FACTION_A, systemId: S.N6,
      kitId: "mini", at: shared.clock.now() }, "cs1:a"));
    assert.deepStrictEqual([refusedA.ok, refusedA.reason], [false, "BUILD_LIMIT_TOTAL"]);
    const r = env.tx((db) => env.construction.receiveInTx(db, { stationId: other.stationId, factionId: FACTION_B,
      convoyId: "cv_cs1", cargo: { [M34]: 3000, [M35]: 1000 }, at: shared.clock.now() }));
    assert.ok(r.ok && r.anchored, JSON.stringify(r));
    stopAll(env);
    env = await boot(reopen(), shared, ctx.world, { cx: { maxOpenBuildsTotal: 8, maxLiveStationsTotal: 3 } });
    const refusedLive = env.tx((db) => env.construction.planInTx(db, { factionId: FACTION_A, systemId: S.N6,
      kitId: "mini", at: shared.clock.now() }, "cs1:a2"));
    assert.deepStrictEqual([refusedLive.ok, refusedLive.reason], [false, "GLOBAL_STATION_LIMIT"]);
    stopAll(env);
    env = await boot(reopen(), shared, ctx.world, { cx: { maxOpenBuildsTotal: 8, maxLiveStationsTotal: 4 } });
    const ok = env.tx((db) => env.construction.planInTx(db, { factionId: FACTION_A, systemId: S.N6, kitId: "mini",
      at: shared.clock.now() }, "cs1:a3"));
    assert.ok(ok.ok && !ok.duplicate, JSON.stringify(ok));
    stopAll(env);
  }));

  needsDriver("CS2 readOpen: openTotal, liveTotal, lastBuildAt (null before the first build, created_at after it "
    + "kept after CANCELLED)", () => H.withStore(driver, async (reopen) => {
    const shared = H.sharedOf();
    const { env } = await setup(reopen, shared);
    const read = (f) => {
      const r = env.tx((db) => env.construction.readOpen(db, f));
      assert.ok(r.ok, JSON.stringify(r));
      return [r.openTotal, r.liveTotal, r.lastBuildAt];
    };
    assert.deepStrictEqual(read(FACTION_A), [0, 2, null]);
    const t = shared.clock.now();
    plan(env, shared, S.N6, "cs2:plan");
    assert.deepStrictEqual(read(FACTION_A), [1, 3, t]);
    assert.deepStrictEqual(read(FACTION_B), [1, 3, null], "another faction: same totals, never built");
    await settleAt(env, shared, t + 4 * HOUR);
    assert.deepStrictEqual(read(FACTION_A), [0, 2, t], "CANCELLED TIMEOUT still counts for the gap");
    stopAll(env);
  }));

  needsDriver("K3 a build opened on the old kit (22.42 M) -> restart with the kits of the SDE -> the full old "
    + "required -> ANCHORING, required unchanged, typeId 35832", () => H.withStore(driver, async (reopen) => {
    const shared = H.sharedOf();
    const old = { kitId: "astrahus", kitsData: Object.freeze({ astrahus: OLD_ASTRAHUS }) };
    const ctx = await setup(reopen, shared, old);
    let env = ctx.env;
    const p = env.tx((db) => env.construction.planInTx(db, { factionId: FACTION_A, systemId: S.N6,
      kitId: "astrahus", at: shared.clock.now() }, "k3m33f:plan"));
    assert.ok(p.ok && !p.duplicate, JSON.stringify(p));
    assert.deepStrictEqual(buildOf(env, p.stationId).required, OLD_ASTRAHUS.items);
    stopAll(env);
    env = await boot(reopen(), shared, ctx.world, { kitId: "astrahus", kitsData: null });
    assert.ok(env.started.ok, JSON.stringify(env.started));
    const st = env.construction.getStatus();
    assert.deepStrictEqual([st.kitUnits, st.kitFactorPermille], [24329500, 2000], "new builds: the kit of the SDE");
    const r = env.tx((db) => env.construction.receiveInTx(db, { stationId: p.stationId, factionId: FACTION_A,
      convoyId: "cv_k3m33f", cargo: { ...OLD_ASTRAHUS.items }, at: shared.clock.now() }));
    assert.ok(r.ok && r.anchored && r.surplusUnits === 0, JSON.stringify(r));
    const b = buildOf(env, p.stationId);
    assert.deepStrictEqual([b.state, b.required], ["ANCHORING", OLD_ASTRAHUS.items]);
    const station = stationOf(env, p.stationId);
    assert.deepStrictEqual([station.state, station.typeId, station.structureFamily], ["ANCHORING", 35832, "astrahus"]);
    stopAll(env);
  }));
};
