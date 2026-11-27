"use strict";

const assert = require("node:assert");
const path = require("node:path");

const config = require("../../config");
const { createJournal } = require("../../lib/persistence/journal");
const { startScheduler } = require("../../lib/scheduler");
const { startFleets } = require("../../lib/fleets");
const { startStations } = require("../../lib/stations");
const { startMining, createUnavailableMining } = require("../../lib/economy/mining");
const { computeLoad, scaleBands, mineralFactors, scaleCargo, cargoUnits } = require("../../lib/economy/mining/yield");
const { createMiningRates } = require("../../lib/economy/mining/rates");
const { createIndustryCatalog } = require("../../lib/economy/industry/catalog");
const { planMining } = require("../../lib/strategy/ai/mining");
const { ROWS_PER_DISPATCH, nudgeKey, reconcileKey, dueKey, YIELD_SEC_CLASSES } = require("../../lib/economy/schema");
const { MINING_DISPATCH_ROWS } = require("../../lib/strategy/reviewRows");
const { createViewRegistry } = require("../../lib/observer/views");
const { harness: H } = require("../battle/settlement.test");
const { projectedController, ownSpaceSystems } = require("../../lib/economy/mining/ownSpace");
const { planProduction } = require("../../lib/strategy/ai/production");
const { canMineIn } = require("../../lib/strategy/ai/miningControl");
const RECIPES = require("../../lib/economy/data/hullRecipes");
const { createRecipeTable } = require("../../lib/economy/production/recipes");
const { HULL_GROUPS } = require("../../lib/fleets/schema");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const { S, FACTION_A, FACTION_B } = H;
const DEFAULTS = config.resolveConfig({ modDir: MOD_DIR, env: {} }).config;
const MINER = Object.freeze([{ hullGroup: "industrial", count: 3 }]);
const STATIONS = Object.freeze({ ...DEFAULTS.stations, refitSeekRecheckMs: 3600000 });
const BELTS = new Map([[S.N0, 6], [S.N5, 4], [S.N6, 2], [S.H1, 3]]);

function miningConfig(miningOver) {
  return { ...H.CONFIG, modules: { ...H.CONFIG.modules, strategy: { enabled: true } },
    fleets: { ...H.CONFIG.fleets, refitPolicy: "station", refitSeekRecheckMs: 3600000, refitSeekMaxRounds: 24 },
    stations: STATIONS, mining: { ...DEFAULTS.mining, ...(miningOver || {}) },
    persistence: { ...H.CONFIG.persistence, maxRowsPerTransaction: 500 },
    observer: { ...H.CONFIG.observer, stationsPanelMaxRows: 200, stationsPanelStockLines: 5 } };
}

function expectedLoad(composition, M) {
  const catalog = createIndustryCatalog().catalog;
  const bands = scaleBands(Object.fromEntries(YIELD_SEC_CLASSES.map((c) => [c,
    catalog.oreBand(c).mineralsPerMillionM3])), mineralFactors(M));
  return computeLoad({ composition, shiftMs: M.shiftMs, richnessPermille: 1000, secClass: "nullsec" },
    { refineYieldPermille: M.refineYieldPermille }, createMiningRates(M), bands);
}

const graphService = (graph) =>({ whenReady: () => Promise.resolve({ ok: true, graph }),
  getGraph: () => ({ ok: true, graph }) });

function fakeWorld(controllers) {
  return { repository: { limits: { maxBatchReadIds: 8 },
    getSystem: (tx, id) => ({ ok: true, system: controllers.has(id)
      ? { systemId: id, controllerFactionId: controllers.get(id) } : null }),
    getSystems: (tx, ids) => ({ ok: true, systems: ids.filter((id) => controllers.has(id))
      .map((id) => ({ systemId: id, controllerFactionId: controllers.get(id) })),
    missing: ids.filter((id) => !controllers.has(id)) }) } };
}

function withSdeFactions(shared, factions) {
  const base = shared.graph;
  const graph = { ...base, getSystem: (id) => {
    const v = base.getSystem(id);
    return v && factions.has(Number(id)) ? { ...v, factionId: factions.get(Number(id)) } : v;
  } };
  return { ...shared, graph };
}

async function boot(opened, shared, controllers, adapter, miningOver, ownSpaces) {
  const cfg = miningConfig(miningOver);
  const journal = createJournal({ clock: shared.clock, maxPayloadBytes: 16384, maxRows: 500 });
  const sr = startScheduler({ config: cfg, persistence: { ok: true, store: opened.store }, clock: shared.clock,
    ids: shared.ids, nowMs: () => 0 });
  assert.ok(sr.ok, JSON.stringify(sr));
  const holder = { stations: null };
  const persistence = { ok: true, store: opened.store, journal, worldSeed: opened.worldSeed };
  const fr = startFleets({ config: cfg, persistence, clock: shared.clock, ids: shared.ids, scheduler: sr.scheduler,
    graph: { getGraph: () => ({ ok: true, graph: shared.graph }) }, presence: null, views: createViewRegistry(),
    getStations: () => holder.stations });
  assert.ok(fr.ok, JSON.stringify(fr));
  const registry = { getFaction: (id) => ([FACTION_A, FACTION_B].includes(Number(id))
    ? { factionId: Number(id), startStations: [], doctrineId: `d${Number(id)}`, allies: [] } : null),
  getDoctrine: (d) => ({ doctrineId: d, ownSpace: (ownSpaces && ownSpaces.get(Number(String(d).slice(1)))) || null }),
  listFactions: () => [{ factionId: FACTION_A }],
  listActiveFactions: () => [{ factionId: FACTION_A }], isActive: (id) => [FACTION_A, FACTION_B].includes(Number(id)) };
  const st = startStations({ config: cfg, persistence, strategy: { registry }, graph: graphService(shared.graph),
    clock: shared.clock });
  assert.ok(st.ok, JSON.stringify(st));
  holder.stations = st.stations;
  await st.stations.whenReady();
  const views = createViewRegistry();
  const lines = [];
  const mr = startMining({ config: cfg, persistence, clock: shared.clock, ids: shared.ids, scheduler: sr.scheduler,
    fleets: fr.fleets, world: fakeWorld(controllers), strategy: { registry }, graph: graphService(shared.graph),
    getStations: () => holder.stations, views, logger: { log: (l) => lines.push(l) },
    adapter: adapter || { readSystemBelts: (list) => ({ ok: true,
      counts: new Map(list.map((id) => [id, BELTS.get(id) || 0])) }) } });
  assert.ok(mr.ok, JSON.stringify(mr));
  await Promise.resolve();
  await Promise.resolve();
  const tx = (fn) => {
    const r = opened.store.transaction("test", fn);
    assert.ok(r.ok, JSON.stringify(r));
    return r.value;
  };
  return { store: opened.store, scheduler: sr.scheduler, fleets: fr.fleets, stations: st.stations,
    mining: mr.mining, views, lines, tx };
}

function addStation(env, id, systemId, factionId, at) {
  const r = env.tx((db) => env.stations.repository.createStation(db, { stationId: id, kind: "upwell", typeId: 35832,
    structureFamily: "astrahus", systemId, ownerFactionId: factionId, ownerCorporationId: 1000162, origin: "built",
    at }, `test:station:${id}`));
  assert.ok(r.ok, JSON.stringify(r));
}

function newMiner(env, tag, systemId) {
  const r = env.fleets.createFleet({ factionId: FACTION_A, currentSystemId: systemId, homeSystemId: systemId,
    fleetRole: "mining", composition: MINER }, `${tag}:create`);
  assert.ok(r.ok, JSON.stringify(r));
  return r.fleetId;
}

const fleetOf = (env, id) => env.tx((db) => env.fleets.repository.getFleet(db, id)).fleet;
const tripOf = (env, id) => env.tx((db) => env.mining.trips.getTrip(db, id)).trip;
const stockOf = (env, stationId) => env.tx((db) => db.prepare("SELECT item_key, quantity FROM world_station_stock "
  + "WHERE station_id = ? ORDER BY item_key").all(stationId))
  .reduce((o, r) => ({ ...o, [r.item_key]: r.quantity }), {});
const totalsOf = (env) => env.tx((db) => env.mining.trips.getTotals(db, FACTION_A)).totals;
const journalRows = (env) => env.tx((db) => db.prepare("SELECT count(*) AS n FROM world_event_journal").get().n);

function dispatch(env, shared, tag, fleetId, beltSystemId) {
  const f = fleetOf(env, fleetId);
  return env.tx((db) => env.mining.dispatchInTx(db, { factionId: FACTION_A, fleetId, expectedVersion: f.version,
    beltSystemId, at: shared.clock.now() }, tag));
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

module.exports = ({ test, skip }) => {
  test("M0 config mining.*: defaults, clamp, review bound with dispatches, warnings", () => {
    const c = DEFAULTS.mining;
    assert.deepStrictEqual([c.enabled, c.maxFleetsPerFaction, c.maxFleetsPerSystem, c.shiftMs, c.refineYieldPermille,
      c.maxWatchRounds], [true, 10, 2, 7200000, 720, 12]);
    assert.strictEqual(MINING_DISPATCH_ROWS, ROWS_PER_DISPATCH, "reviewRows literal = economy/schema");
    const r = config.resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_MINING_MAX_FLEETS_PER_SYSTEM: "99",
      EVEJS_LNE_MINING_MAX_TRIP_JUMPS: "20", EVEJS_LNE_GRAPH_ROUTE_MAX_JUMPS: "10",
      EVEJS_LNE_MINING_MAX_FLEETS_PER_FACTION: "64", EVEJS_LNE_PERSISTENCE_MAX_ROWS_PER_TRANSACTION: "150",
      EVEJS_LNE_STRATEGY_MAX_FLEETS_READ_PER_REVIEW: "128",
      EVEJS_LNE_PRODUCTION_ENABLED: "0", EVEJS_LNE_UPKEEP_ENABLED: "0",
      EVEJS_LNE_LOGISTICS_ENABLED: "0", EVEJS_LNE_CONSTRUCTION_ENABLED: "0", EVEJS_LNE_SIEGE_RELIEF_ENABLED: "0" } });
    assert.strictEqual(r.config.mining.maxFleetsPerSystem, 16, "clamped");
    const text = r.warnings.join("\n");
    assert.ok(text.includes("mining.maxTripJumps=20 above graph.routeMaxJumps=10"), text);
    assert.ok(text.includes("mining.maxFleetsPerFaction + logistics.maxFleetsPerFaction") || text.includes("strategy.maxFleetsPerFaction + mining.maxFleetsPerFaction + logistics.maxFleetsPerFaction"), text);
    assert.ok(text.includes("strategy review may write") && text.includes("persistence.maxRowsPerTransaction=150"), text);
    const off = config.resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_MINING_ENABLED: "0",
      EVEJS_LNE_PERSISTENCE_MAX_ROWS_PER_TRANSACTION: "150", EVEJS_LNE_PRODUCTION_ENABLED: "0",
      EVEJS_LNE_UPKEEP_ENABLED: "0", EVEJS_LNE_LOGISTICS_ENABLED: "0", EVEJS_LNE_SIEGE_RELIEF_ENABLED: "0" } });
    const miningReviewWarnings = off.warnings.filter(w => w.includes("review may write") && w.includes("mining"));
    assert.strictEqual(miningReviewWarnings.length, 0, "mining review warnings should not appear when mining disabled: " + off.warnings.join("\n"));
    assert.strictEqual(createUnavailableMining("x").getMode(), "off");
    assert.strictEqual(createUnavailableMining("x").dispatchInTx().reason, "MINING_UNAVAILABLE");
  });

  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  needsDriver("M3 full cycle exactly once: dispatch -> arrival -> shift -> return -> stock; duplicates, a second "
    + "trigger and a restart change nothing; belt in the station system -> MINING at once", () => H.withStore(driver,
    async (reopen) => {
      const shared = H.sharedOf();
      const controllers = new Map([[S.N0, FACTION_A], [S.N5, FACTION_A], [S.N6, FACTION_B]]);
      let opened = reopen();
      let env = await boot(opened, shared, controllers);
      assert.strictEqual(env.mining.getMode(), "ready");
      const t0 = shared.clock.now();
      addStation(env, "st-a", S.N0, FACTION_A, t0);
      const fleetId = newMiner(env, "m3", S.N0);
      const rich = env.mining.richnessOf(S.N5);
      assert.deepStrictEqual(rich, { ok: true, richnessPermille: 1000, secClass: "nullsec", belts: 4 });

      const d = dispatch(env, shared, "m3:d", fleetId, S.N5);
      assert.deepStrictEqual([d.ok, d.duplicate, d.state], [true, false, "OUTBOUND"], JSON.stringify(d));
      const again = env.tx((db) => env.mining.dispatchInTx(db, { factionId: FACTION_A, fleetId, expectedVersion: 99,
        beltSystemId: S.N5, at: t0 }, "m3:d"));
      assert.deepStrictEqual([again.ok, again.duplicate, again.tripId], [true, true, d.tripId], "same key = duplicate");
      const tripId = d.tripId;

      await settleAt(env, shared, d.arriveAt);
      let trip = tripOf(env, tripId);
      assert.deepStrictEqual([trip.state, trip.miningStartedAt, trip.phaseSeq], ["MINING", d.arriveAt, 1]);
      assert.strictEqual(fleetOf(env, fleetId).state, "STAGED");
      await settleAt(env, shared, d.arriveAt + DEFAULTS.mining.watchGraceMs);
      assert.strictEqual(tripOf(env, tripId).version, trip.version, "old deadline changed nothing");

      await settleAt(env, shared, trip.miningEndsAt);
      trip = tripOf(env, tripId);
      assert.deepStrictEqual([trip.state, trip.returnSystemId, trip.shipsAtLoad], ["RETURNING", S.N0, 3]);
      const expected = expectedLoad(MINER, DEFAULTS.mining);
      assert.deepStrictEqual(trip.cargo, expected.minerals);
      const back = fleetOf(env, fleetId);
      assert.strictEqual(back.state, "TRAVELLING");
      await settleAt(env, shared, back.nextActionAt);
      trip = tripOf(env, tripId);
      assert.deepStrictEqual([trip.state, trip.deliveredStationId, trip.lostUnits], ["DELIVERED", "st-a", 0]);
      assert.deepStrictEqual(stockOf(env, "st-a"), expected.minerals, "stock = the frozen load");
      assert.strictEqual(fleetOf(env, fleetId).state, "IDLE");
      const totals = totalsOf(env);
      assert.deepStrictEqual([totals.tripsStarted, totals.tripsDelivered, totals.oreUnits, totals.mineralUnits],
        [1, 1, expected.oreM3, cargoUnits(expected.minerals)]);
      const ops = env.tx((db) => db.prepare("SELECT objective, state FROM world_operations ORDER BY planned_at, "
        + "objective").all().map((r) => `${r.objective}:${r.state}`));
      assert.deepStrictEqual(ops.sort(), ["deliver:COMPLETED", "mine:COMPLETED"]);

      const rows = journalRows(env);
      const arrival = env.tx((db) => db.prepare("SELECT idempotency_key FROM world_scheduled_events WHERE "
        + "idempotency_key LIKE 'mining:arr:%' ORDER BY idempotency_key").all().map((r) => r.idempotency_key));
      assert.strictEqual(arrival.length, 2, "two nudges: belt + station");
      const f = fleetOf(env, fleetId);
      const dup = env.scheduler.enqueue("MINING_TRIP_STEP", fleetId, shared.clock.now(), { fleetId,
        legSeq: f.legSeq, state: "STAGED", at: shared.clock.now() }, nudgeKey(fleetId, f.legSeq, "STAGED"));
      assert.ok(dup.ok, JSON.stringify(dup));
      for (const [k, p] of [["test:nudge", { fleetId, legSeq: f.legSeq, state: "STAGED", at: shared.clock.now() }],
        ["test:due", { tripId, phaseSeq: 2, round: 0 }]]) {
        assert.ok(env.scheduler.enqueue("MINING_TRIP_STEP", tripId, shared.clock.now(), p, k).ok);
      }
      await settleAt(env, shared, shared.clock.now() + 1000);
      assert.deepStrictEqual(stockOf(env, "st-a"), expected.minerals);
      assert.deepStrictEqual(totalsOf(env), { ...totals, version: totals.version, updatedAt: totals.updatedAt });
      assert.strictEqual(journalRows(env), rows, "no new journal row");

      const before = { stock: stockOf(env, "st-a"), totals: totalsOf(env), rows: journalRows(env) };
      env.mining.stop("restart");
      opened.store.close("restart");
      opened = reopen();
      env = await boot(opened, shared, controllers);
      assert.deepStrictEqual([stockOf(env, "st-a"), totalsOf(env), journalRows(env)],
        [before.stock, before.totals, before.rows]);

      const local = newMiner(env, "m3b", S.N0);
      const l = dispatch(env, shared, "m3:local", local, S.N0);
      assert.deepStrictEqual([l.ok, l.state], [true, "MINING"], JSON.stringify(l));
      assert.strictEqual(fleetOf(env, local).state, "STAGED");
      const lt = tripOf(env, l.tripId);
      env.tx((db) => db.prepare("DELETE FROM world_scheduled_events WHERE aggregate_id = ?").run(l.tripId));
      env.mining.stop("restart");
      opened.store.close("restart");
      opened = reopen();
      env = await boot(opened, shared, controllers);
      assert.ok(env.lines.some((x) => x.startsWith("mining: reconcile open=1 enqueued=1")), env.lines.join("\n"));
      await settleAt(env, shared, lt.miningEndsAt);
      const ld = tripOf(env, l.tripId);
      assert.deepStrictEqual([ld.state, ld.deliveredStationId], ["DELIVERED", "st-a"], "load + delivery here");
      const twice = {};
      for (const [k, v] of Object.entries(expected.minerals)) twice[k] = 2 * v;
      assert.deepStrictEqual(stockOf(env, "st-a"), twice);
      assert.strictEqual(env.mining.getStatus().counters.delivered, 1, "this process delivered once");
    }));

  needsDriver("Y4 frozen load: RETURNING at the defaults, restart with rateMiningFrigateM3PerMin=1 -> the "
    + "delivery = the frozen cargo_json; a trip with an old-format cargo_json delivers exactly it", () =>
    H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const controllers = new Map([[S.N0, FACTION_A], [S.N5, FACTION_A]]);
      let opened = reopen();
      let env = await boot(opened, shared, controllers);
      addStation(env, "st-a", S.N0, FACTION_A, shared.clock.now());
      const [fresh, old] = ["y4a", "y4b"].map((t) => newMiner(env, t, S.N0));
      const da = dispatch(env, shared, "y4:a", fresh, S.N5);
      const db2 = dispatch(env, shared, "y4:b", old, S.N5);
      for (const x of [da, db2]) assert.ok(x.ok, JSON.stringify(x));
      await settleAt(env, shared, Math.max(da.arriveAt, db2.arriveAt));
      const ends = Math.max(tripOf(env, da.tripId).miningEndsAt, tripOf(env, db2.tripId).miningEndsAt);
      await settleAt(env, shared, ends);
      const expected = expectedLoad(MINER, DEFAULTS.mining);
      assert.deepStrictEqual([tripOf(env, da.tripId).state, tripOf(env, da.tripId).cargo], ["RETURNING",
        expected.minerals]);
      const OLD = Object.freeze({ "type:34": 756000, "type:35": 475200, "type:40": 108000 });
      env.tx((db) => db.prepare("UPDATE world_mining_trips SET cargo_json = ? WHERE trip_id = ?")
        .run(JSON.stringify(OLD), db2.tripId));
      assert.deepStrictEqual(tripOf(env, db2.tripId).cargo, OLD);
      const backAt = Math.max(fleetOf(env, fresh).nextActionAt, fleetOf(env, old).nextActionAt);

      env.mining.stop("restart");
      opened.store.close("restart");
      opened = reopen();
      env = await boot(opened, shared, controllers, null, { rateMiningFrigateM3PerMin: 1 });
      await settleAt(env, shared, backAt);
      for (const id of [da.tripId, db2.tripId]) assert.strictEqual(tripOf(env, id).state, "DELIVERED", id);
      const want = { ...expected.minerals };
      for (const [k, v] of Object.entries(OLD)) want[k] = (want[k] || 0) + v;
      assert.deepStrictEqual(stockOf(env, "st-a"), want, "frozen loads, not the new rate");
    }));

  needsDriver("M4 loss and battle: destroyed on the way back -> LOST; retreat with 2/3 ships -> floor(2/3) "
    + "delivered; control lost -> empty load DELIVERED; NOT_CONTROLLED writes nothing; panel", () => H.withStore(driver,
    async (reopen) => {
      const shared = H.sharedOf();
      const controllers = new Map([[S.N0, FACTION_A], [S.N5, FACTION_A], [S.H1, FACTION_A], [S.N7, FACTION_B]]);
      const env = await boot(reopen(), shared, controllers);
      addStation(env, "st-a", S.N0, FACTION_A, shared.clock.now());
      const [lose, retreat, empty] = ["m4l", "m4r", "m4e"].map((t) => newMiner(env, t, S.N0));
      const dl = dispatch(env, shared, "m4:l", lose, S.N5);
      const dr = dispatch(env, shared, "m4:r", retreat, S.N5);
      const de = dispatch(env, shared, "m4:e", empty, S.H1);
      for (const x of [dl, dr, de]) assert.ok(x.ok, JSON.stringify(x));
      const rows = journalRows(env);
      const refused = dispatch(env, shared, "m4:n", newMiner(env, "m4n", S.N0), S.N7);
      assert.deepStrictEqual([refused.ok, refused.reason], [false, "NOT_CONTROLLED"]);
      assert.strictEqual(journalRows(env), rows + 1, "only the createFleet of the test, no dispatch write");
      const full = dispatch(env, shared, "m4:f", newMiner(env, "m4f", S.N0), S.N5);
      assert.deepStrictEqual([full.ok, full.reason], [false, "MINING_SYSTEM_FULL"]);

      await settleAt(env, shared, Math.max(dl.arriveAt, de.arriveAt));
      const ends = tripOf(env, dl.tripId).miningEndsAt;
      controllers.set(S.H1, FACTION_B);
      await settleAt(env, shared, Math.max(ends, tripOf(env, de.tripId).miningEndsAt));
      for (const id of [dl.tripId, dr.tripId, de.tripId]) assert.strictEqual(tripOf(env, id).state, "RETURNING");
      assert.deepStrictEqual(tripOf(env, de.tripId).cargo, {}, "no control at the end of the shift -> empty load");

      const engage = (fleetId, lost, tag) => env.tx((db) => {
        const f = env.fleets.repository.getFleet(db, fleetId).fleet;
        const e = env.fleets.repository.transition(db, { fleetId, expectedVersion: f.version, from: f.state,
          to: "ENGAGED" }, `${tag}:engage`);
        assert.ok(e.ok, JSON.stringify(e));
        const r = env.fleets.repository.applyLosses(db, { fleetId, expectedVersion: e.version,
          losses: [{ hullGroup: "industrial", typeId: null, count: lost }] }, `${tag}:loss`);
        assert.ok(r.ok, JSON.stringify(r));
        return r;
      });
      assert.strictEqual(engage(lose, 3, "m4l").destroyed, true);
      const hurt = engage(retreat, 1, "m4r");
      const rel = env.tx((db) => env.fleets.travel.releaseFromBattleInTx(db, { fleetId: retreat,
        expectedVersion: hurt.version, at: shared.clock.now(), disposition: "RETREAT", retreatTargets: [S.N0] },
      "m4r:release"));
      assert.deepStrictEqual([rel.ok, rel.disposition], [true, "RETREATING"], JSON.stringify(rel));
      const lostCargo = tripOf(env, dl.tripId).cargo;
      const retreatCargo = tripOf(env, dr.tripId).cargo;
      await settleAt(env, shared, Math.max(fleetOf(env, retreat).nextActionAt, fleetOf(env, empty).nextActionAt));
      await settleAt(env, shared, shared.clock.now() + DEFAULTS.mining.watchGraceMs + DEFAULTS.mining.watchRecheckMs);
      const tl = tripOf(env, dl.tripId);
      assert.deepStrictEqual([tl.state, tl.endReason], ["LOST", "FLEET_DESTROYED"]);
      const tr = tripOf(env, dr.tripId);
      assert.deepStrictEqual([tr.state, ["REFITTING", "IDLE"].includes(fleetOf(env, retreat).state)],
        ["DELIVERED", true]);
      const scaled = scaleCargo(retreatCargo, 3, 2);
      assert.deepStrictEqual(tr.delivered, scaled.deliver);
      assert.strictEqual(tr.lostUnits, scaled.lostUnits);
      const te = tripOf(env, de.tripId);
      assert.deepStrictEqual([te.state, te.endReason], ["DELIVERED", "EMPTY"]);
      assert.deepStrictEqual(stockOf(env, "st-a"), scaled.deliver, "only the retreated load reached the stock");
      const t = totalsOf(env);
      const units = (o) => Object.values(o).reduce((a, b) => a + b, 0);
      assert.deepStrictEqual([t.tripsStarted, t.tripsDelivered, t.tripsLost, t.lostMineralUnits],
        [3, 2, 1, units(lostCargo) + scaled.lostUnits]);
      const c = env.mining.getStatus().counters;
      assert.deepStrictEqual([c.lost, c.emptyLoads, c.delivered >= 2], [1, 1, true]);
      const ops = env.tx((db) => db.prepare("SELECT count(*) AS n FROM world_operations WHERE state IN "
        + "('PLANNED','ACTIVE') AND operation_type = 'mining'").get().n);
      assert.strictEqual(ops, 0, "no mining operation left open");

      const view = env.views.getView("mining");
      assert.ok(view, "panel registered");
      const data = view.getData();
      assert.strictEqual(data.available, true, JSON.stringify(data));
      const a = data.factions.find((x) => x.faction === FACTION_A);
      assert.deepStrictEqual([a.mineralStock.total, a.totals.lost, a.last24h.delivered, a.miners.live],
        [units(scaled.deliver), 1, units(scaled.deliver), 4]);
      assert.ok(a.mineralStock.minerals.some((m) => m.mineral === "Tritanium"));
    }));

  needsDriver("P0 /4/5/6: a terminal reconcile event -> suffix:0, a second start nothing; MINE_RELEASE of "
    + "an orphan (not of a miner on a trip) -> IDLE + operation closed; transitionTrip duplicate returns the trip; a "
    + "belt fallback is not cached", () => H.withStore(driver, async (reopen) => {
    const shared = H.sharedOf();
    const controllers = new Map([[S.N0, FACTION_A], [S.N5, FACTION_A]]);
    let opened = reopen();
    let env = await boot(opened, shared, controllers);
    addStation(env, "st-a", S.N0, FACTION_A, shared.clock.now());
    const local = newMiner(env, "p0l", S.N0);
    const l = dispatch(env, shared, "p0:local", local, S.N0);
    assert.deepStrictEqual([l.ok, l.state], [true, "MINING"], JSON.stringify(l));
    const t1 = tripOf(env, l.tripId);
    const dup = env.tx((db) => env.mining.trips.transitionTrip(db, { tripId: l.tripId, expectedVersion: 1,
      from: "OUTBOUND", to: "MINING" }, "p0:local:start"));
    assert.deepStrictEqual([dup.ok, dup.duplicate, dup.trip && dup.trip.version], [true, true, t1.version]);

    const base = reconcileKey(l.tripId, 1, 0);
    env.tx((db) => db.prepare("UPDATE world_scheduled_events SET idempotency_key = ?, state = 'QUARANTINED', "
      + "finished_at = 1, last_error = 'x' WHERE idempotency_key = ?").run(base, dueKey(l.tripId, 1, 0)));
    const restart = async () => {
      env.mining.stop("restart");
      opened.store.close("restart");
      opened = reopen();
      env = await boot(opened, shared, controllers);
    };
    await restart();
    const keys = () => env.tx((db) => db.prepare("SELECT idempotency_key AS k, state FROM world_scheduled_events "
      + "WHERE aggregate_id = ? ORDER BY idempotency_key").all(l.tripId).map((r) => `${r.k}=${r.state}`));
    assert.deepStrictEqual(keys(), [`${base}=QUARANTINED`, `${base}:0=QUEUED`]);
    await restart();
    assert.deepStrictEqual(keys(), [`${base}=QUARANTINED`, `${base}:0=QUEUED`], "second start: nothing new");

    env.tx((db) => db.prepare("UPDATE world_mining_trips SET state = 'ABORTED', ended_at = 1 WHERE trip_id = ?")
      .run(l.tripId));
    const busy = newMiner(env, "p0b", S.N0);
    const b = dispatch(env, shared, "p0:busy", busy, S.N0);
    assert.ok(b.ok, JSON.stringify(b));
    const of = (id) => fleetOf(env, id);
    const row = (id) => ({ fleetId: id, version: of(id).version, state: of(id).state, fleetRole: "mining",
      systemId: S.N0, refitPending: false, operationId: of(id).operationId });
    const ops = env.tx((db) => db.prepare("SELECT operation_id AS id FROM world_operations WHERE state = 'ACTIVE'")
      .all()).map((r) => ({ operationId: r.id, operationType: "mining" }));
    const snapshot = { factionId: FACTION_A, faction: { status: "DORMANT", homeSystemId: null }, stationsMode: "ready",
      fleets: [row(local), row(busy)], fleetsTruncated: false, operations: ops, operationsTruncated: false,
      mining: { mode: "ready", sites: [], openByBelt: [], busyFleetIds: [busy] } };
    const plan = planMining(snapshot, { stationSystems: [], affordable: { resourceUnits: 0, reserveUnits: 0 } },
      { mining: { ...DEFAULTS.mining } });
    assert.deepStrictEqual(plan.intents, [{ type: "MINE_RELEASE", slot: 0, fleetId: local,
      expectedVersion: of(local).version }], "only the orphan, before the early exit");
    const opId = of(local).operationId;
    const busyVersion = of(busy).version;
    const localVersion = of(local).version;
    const refused = env.tx((db) => env.mining.releaseOrphanInTx(db, { factionId: FACTION_A, fleetId: busy,
      expectedVersion: busyVersion }, "p0:rel:busy"));
    assert.strictEqual(refused.reason, "TRIP_OPEN");
    const rel = env.tx((db) => env.mining.releaseOrphanInTx(db, { factionId: FACTION_A, fleetId: local,
      expectedVersion: localVersion }, "p0:rel"));
    assert.ok(rel.ok, JSON.stringify(rel));
    assert.deepStrictEqual([of(local).state, env.tx((db) => db.prepare("SELECT state FROM world_operations WHERE "
      + "operation_id = ?").get(opId).state)], ["IDLE", "FAILED"]);

    let calls = 0;
    const flaky = { readSystemBelts: (list) => {
      if (list.includes(S.N5) && (calls += 1) === 1) return { ok: false, reason: "NOT_BOOTED" };
      return { ok: true, counts: new Map(list.map((id) => [id, BELTS.get(id) || 0])) };
    } };
    env.mining.stop("restart");
    opened.store.close("restart");
    opened = reopen();
    env = await boot(opened, shared, controllers, flaky);
    assert.strictEqual(env.mining.richnessOf(S.N5).belts, DEFAULTS.mining.defaultBeltsPerSystem);
    assert.strictEqual(env.mining.richnessOf(S.N5).belts, BELTS.get(S.N5));
    assert.strictEqual(calls, 2, "asked again after the refusal");
  }));

  test("T1 ownSpace: the row wins (also a null controller), no row -> SDE factionId, 0 -> null; BFS "
    + "respects maxJumps and maxSystems", () => {
    assert.strictEqual(projectedController({ controllerFactionId: FACTION_B }, { factionId: FACTION_A }), FACTION_B);
    assert.strictEqual(projectedController({ controllerFactionId: null }, { factionId: FACTION_A }), null);
    assert.strictEqual(projectedController(null, { factionId: FACTION_A }), FACTION_A);
    assert.strictEqual(projectedController(null, { factionId: 0 }), null);
    assert.strictEqual(projectedController(null, null), null);
    const shared = withSdeFactions(H.sharedOf(), new Map([[S.H1, FACTION_A], [S.N9, FACTION_A], [S.N0, FACTION_A],
      [S.L1, FACTION_B]]));
    const input = (o) => ({ fromSystemIds: [S.H1], factionId: FACTION_A, getSystem: (id) => shared.graph.getSystem(id),
      neighbors: (id) => shared.graph.getNeighbors(id), maxJumps: 5, maxSystems: 256, ...o });
    assert.deepStrictEqual(ownSpaceSystems(input({})), [S.N0, S.H1, S.N9], "own SDE only, sorted");
    assert.deepStrictEqual(ownSpaceSystems(input({ maxJumps: 0 })), [S.H1]);
    assert.deepStrictEqual(ownSpaceSystems(input({ maxSystems: 1 })), [S.H1], "one system visited");
    assert.deepStrictEqual(ownSpaceSystems(input({ maxSystems: 0 })), []);
  });

  test("T2 planMining: a projected site without a row is a candidate (MOBILIZE / MINE_DISPATCH) "
    + "projected:false without a row or a row of a foreign controller -> MINING_NO_CANDIDATE", () => {
    const graph = H.sharedOf().graph;
    const site = (projected) => ({ systemId: S.H1, richnessPermille: 416, projected });
    const mk = (o) => ({ factionId: FACTION_A, faction: { status: "ACTIVE", homeSystemId: S.H1 }, stationsMode: "ready",
      systems: o.systems || [], neighbors: (id) => graph.getNeighbors(id), fleets: o.fleets || [],
      fleetsTruncated: false, operations: [], operationsTruncated: false, intel: [], at: 0,
      doctrine: { templates: { mining: MINER } },
      mining: { mode: "ready", sites: [site(o.projected)], openByBelt: [], busyFleetIds: [] } });
    const supply = { stationSystems: [S.H1], affordable: { resourceUnits: 1e9, reserveUnits: 1e9 } };
    const params = { mining: { ...DEFAULTS.mining }, maxBfsSystems: 256, intelTtlMs: 3600000,
      mobilizeResourcePerShip: 1, mobilizeReservePerShip: 1 };
    const mob = planMining(mk({ projected: true }), supply, params);
    assert.ok(!mob.notes.includes("MINING_NO_CANDIDATE"), mob.notes.join());
    assert.deepStrictEqual(mob.intents.filter((i) => i.type === "MOBILIZE").map((i) => [i.role, i.systemId]),
      [["mining", S.H1]]);
    const free = { fleetId: "fl-m", version: 1, state: "IDLE", fleetRole: "mining", systemId: S.H1, refitPending: false,
      operationId: null };
    const disp = planMining(mk({ projected: true, fleets: [free] }), supply, params);
    assert.deepStrictEqual(disp.intents.map((i) => [i.type, i.beltSystemId]), [["MINE_DISPATCH", S.H1]]);
    assert.ok(planMining(mk({ projected: false }), supply, params).notes.includes("MINING_NO_CANDIDATE"));
    const foreign = planMining(mk({ projected: true, systems: [{ systemId: S.H1, controllerFactionId: FACTION_B,
      occupierFactionId: null }] }), supply, params);
    assert.ok(foreign.notes.includes("MINING_NO_CANDIDATE"), "the row wins over the projection");
  });

  needsDriver("T3-T5 own space without a world row: dispatch -> MINING -> DELIVERED once, stock > 0 "
    + "PRODUCE frigate; foreign SDE -> NOT_CONTROLLED; readOwnSpaceSites skips rows / foreign SDE; scan 0 -> old "
    + "behaviour", () => H.withStore(driver, async (reopen) => {
    const shared = withSdeFactions(H.sharedOf(), new Map([[S.H1, FACTION_A], [S.N9, FACTION_A], [S.N0, FACTION_A],
      [S.L1, FACTION_B]]));
    const controllers = new Map([[S.N0, FACTION_A]]);
    let opened = reopen();
    let env = await boot(opened, shared, controllers);
    addStation(env, "st-h", S.H1, FACTION_A, shared.clock.now());

    const fleetId = newMiner(env, "t3", S.H1);
    const d = dispatch(env, shared, "t3:d", fleetId, S.H1);
    assert.deepStrictEqual([d.ok, d.state], [true, "MINING"], JSON.stringify(d));
    const ends = tripOf(env, d.tripId).miningEndsAt;
    await settleAt(env, shared, ends);
    const trip = tripOf(env, d.tripId);
    assert.deepStrictEqual([trip.state, trip.deliveredStationId], ["DELIVERED", "st-h"]);
    const stock = stockOf(env, "st-h");
    assert.ok(stock["type:34"] > 0, JSON.stringify(stock));
    await settleAt(env, shared, ends + 1000);
    assert.deepStrictEqual(stockOf(env, "st-h"), stock, "a second pass changes nothing");
    const foreign = dispatch(env, shared, "t3:f", newMiner(env, "t3f", S.H1), S.L1);
    assert.deepStrictEqual([foreign.ok, foreign.reason], [false, "NOT_CONTROLLED"]);

    const table = createRecipeTable(RECIPES, { timeFactorPermille: 500, minRunMs: 60000, maxRunMs: 172800000,
      componentWeightPermille: 1000, componentFactorMaxPermille: 4000 });
    const produce = (minerals) => planProduction({ factionId: FACTION_A, stationsMode: "ready",
      faction: { status: "ACTIVE", homeSystemId: S.H1 }, neighbors: (id) => shared.graph.getNeighbors(id),
      doctrine: { templates: { invasion: [{ hullGroup: "frigate", count: 2 }] } },
      production: { mode: "ready", recipesVersion: table.version,
        recipes: { frigate: { minerals: table.lookup("frigate").minerals } }, inProduction: {}, activeJobsTotal: 0,
        truncated: false, stations: [{ stationId: "st-h", systemId: S.H1, kind: "upwell", lines: 1, activeJobs: [],
          minerals, hulls: {} }] } }, null,
    { production: { ...DEFAULTS.production, hullGroups: HULL_GROUPS }, maxAssemblyJumps: 10, maxBfsSystems: 256 });
    const made = produce(stock);
    const job = made.intents.find((i) => i.type === "PRODUCE");
    assert.ok(job && job.hullGroup === "frigate" && job.runs >= 1, JSON.stringify(made));
    assert.ok(!made.notes.includes("PRODUCTION_NO_MINERALS:frigate"), made.notes.join());
    assert.ok(produce({}).notes.includes("PRODUCTION_NO_MINERALS:frigate"), "the test measures the delivery");

    const sitesOf = () => env.tx((db) => env.mining.readOwnSpaceSites(db, FACTION_A, [S.H1]));
    let r = sitesOf();
    assert.ok(r.ok, JSON.stringify(r));
    let ids = r.sites.map((x) => x.systemId);
    assert.ok(ids.includes(S.H1) && !ids.includes(S.N0) && !ids.includes(S.L1), JSON.stringify(r));
    assert.ok(r.sites.every((x) => x.projected === true && x.richnessPermille > 0));
    controllers.set(S.H1, FACTION_A);
    ids = sitesOf().sites.map((x) => x.systemId);
    assert.ok(!ids.includes(S.H1), "a world row is never projected");
    controllers.delete(S.H1);

    env.mining.stop("restart");
    opened.store.close("restart");
    opened = reopen();
    env = await boot(opened, shared, controllers, undefined, { ownSpaceScanSystems: 0 });
    r = sitesOf();
    assert.deepStrictEqual([r.ok, r.sites], [true, []]);
    const off = dispatch(env, shared, "t4:off", newMiner(env, "t4", S.H1), S.H1);
    assert.deepStrictEqual([off.ok, off.reason], [false, "NOT_CONTROLLED"]);
  }));

  needsDriver("T6 CONCORD: planner -> MINE_DISPATCH -> dispatch into a foreign-SDE system without a row "
    + "(doctrine ownSpace any) -> MINING -> DELIVERED with a load; without ownSpace NOT_CONTROLLED; canMineIn = one "
    + "rule (row / trim null / occupier / sovereignty)", () => H.withStore(driver, async (reopen) => {
    const shared = withSdeFactions(H.sharedOf(), new Map([[S.H1, FACTION_B]]));
    const vertex = shared.graph.getSystem(S.H1);
    const ownSpace = { secClasses: [vertex.secClass], sovereignty: "any" };
    assert.strictEqual(canMineIn(FACTION_A, { controllerFactionId: FACTION_A, occupierFactionId: null }, null), true);
    assert.strictEqual(canMineIn(FACTION_A, { controllerFactionId: FACTION_A, occupierFactionId: FACTION_B }, null),
      false, "a foreign pretender");
    assert.strictEqual(canMineIn(FACTION_A, { controllerFactionId: null }, { factionId: FACTION_A }, ownSpace), false,
      "a row released by the trim (controller null) is never mined, also own SDE / ownSpace");
    assert.strictEqual(canMineIn(FACTION_A, null, vertex, ownSpace), true);
    assert.strictEqual(canMineIn(FACTION_A, null, vertex, null), false);
    assert.strictEqual(canMineIn(FACTION_A, null, vertex, { ...ownSpace, sovereignty: "self" }), false);
    assert.strictEqual(canMineIn(FACTION_A, null, vertex, { ...ownSpace, sovereignty: "friendly" }, [FACTION_B]), true);
    assert.strictEqual(canMineIn(FACTION_A, null, vertex, { secClasses: ["wormhole"], sovereignty: "any" }), false);

    const env = await boot(reopen(), shared, new Map(), undefined, undefined, new Map([[FACTION_A, ownSpace]]));
    addStation(env, "st-c", S.H1, FACTION_A, shared.clock.now());
    const fleetId = newMiner(env, "t6", S.H1);
    const f = fleetOf(env, fleetId);
    const snap = { factionId: FACTION_A, faction: { status: "ACTIVE", homeSystemId: S.H1 }, stationsMode: "ready",
      systems: [], neighbors: (id) => shared.graph.getNeighbors(id), fleetsTruncated: false, operations: [],
      operationsTruncated: false, intel: [], at: 0, doctrine: { templates: { mining: MINER }, ownSpace },
      entry: { allies: [] },
      fleets: [{ fleetId, version: f.version, state: "IDLE", fleetRole: "mining", systemId: S.H1,
        refitPending: false, operationId: null }],
      mining: { mode: "ready", sites: [{ systemId: S.H1, richnessPermille: 416, projected: true }], openByBelt: [],
        busyFleetIds: [] } };
    const plan = planMining(snap, { stationSystems: [S.H1], affordable: { resourceUnits: 1e9, reserveUnits: 1e9 } },
      { mining: { ...DEFAULTS.mining }, maxBfsSystems: 256, intelTtlMs: 3600000, mobilizeResourcePerShip: 1,
        mobilizeReservePerShip: 1 });
    const intent = plan.intents.find((i) => i.type === "MINE_DISPATCH");
    assert.ok(intent && intent.beltSystemId === S.H1, JSON.stringify(plan));
    const bare = env.tx((db) => env.mining.dispatchInTx(db, { factionId: FACTION_A, fleetId,
      expectedVersion: intent.expectedVersion, beltSystemId: S.H1, at: shared.clock.now(), ownSpace: null,
      allies: [] }, "t6:bare"));
    assert.deepStrictEqual([bare.ok, bare.reason], [false, "NOT_CONTROLLED"], "no doctrinal ownSpace: refused");
    const d = env.tx((db) => env.mining.dispatchInTx(db, { factionId: FACTION_A, fleetId,
      expectedVersion: intent.expectedVersion, beltSystemId: S.H1, at: shared.clock.now(),
      ownSpace: snap.doctrine.ownSpace, allies: snap.entry.allies }, "t6:d"));
    assert.deepStrictEqual([d.ok, d.state], [true, "MINING"], JSON.stringify(d));
    await settleAt(env, shared, tripOf(env, d.tripId).miningEndsAt);
    const trip = tripOf(env, d.tripId);
    assert.deepStrictEqual([trip.state, trip.deliveredStationId], ["DELIVERED", "st-c"]);
    assert.ok(stockOf(env, "st-c")["type:34"] > 0, "the LOAD step uses the same rule (no CONTROL_LOST)");
  }));
};
