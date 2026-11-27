"use strict";

const assert = require("node:assert");
const path = require("node:path");

const config = require("../../config");
const { createJournal } = require("../../lib/persistence/journal");
const { LATEST_SCHEMA_VERSION, MIGRATIONS } = require("../../lib/persistence/migrations");
const { startScheduler } = require("../../lib/scheduler");
const { startFleets } = require("../../lib/fleets");
const { startStations } = require("../../lib/stations");
const { startLogistics, createUnavailableLogistics } = require("../../lib/economy/logistics");
const { CONVOY_TRANSITIONS, ACTION, ACTION_EDGES, decideConvoyStep } =
  require("../../lib/economy/logistics/convoyMachine");
const { scaleCargo, cargoVolume, capacityOf, fitCargo, carrierCapacitiesM3 } =
  require("../../lib/economy/logistics/cargo");
const { createIndustryCatalog } = require("../../lib/economy/industry/catalog");
const { convoyDispatchRows, convoyNudgeKey, convoyDeliverKey, CONVOY_STATES } = require("../../lib/economy/schema");
const { CONVOY_DISPATCH_BASE_ROWS, reviewRowBound } = require("../../lib/strategy/reviewRows");
const { convoyItemsOf } = require("../../lib/strategy/data/convoyItems");
const { createViewRegistry } = require("../../lib/observer/views");
const { createRng } = require("../../lib/util/rng");
const { harness: H } = require("../battle/settlement.test");
const { WRECKEDCONVOY_LOGISTICS_METHODS } = require("../../lib/heavyEvents/world/schema");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const { S, FACTION_A, FACTION_B } = H;
const DEFAULTS = config.resolveConfig({ modDir: MOD_DIR, env: {} }).config;
const CONVOY = Object.freeze([{ hullGroup: "industrial", count: 2 }, { hullGroup: "frigate", count: 2 }]);
const BS = "hull/group:battleship";

function logisticsConfig(enabled = true) {
  return { ...H.CONFIG, modules: { ...H.CONFIG.modules, strategy: { enabled: true } },
    fleets: { ...H.CONFIG.fleets, refitPolicy: "station", refitSeekRecheckMs: 3600000, refitSeekMaxRounds: 24 },
    stations: { ...DEFAULTS.stations, refitSeekRecheckMs: 3600000 },
    logistics: { ...DEFAULTS.logistics, enabled },
    persistence: { ...H.CONFIG.persistence, maxRowsPerTransaction: 500 } };
}

const graphService = (graph) => ({ whenReady: () => Promise.resolve({ ok: true, graph }),
  getGraph: () => ({ ok: true, graph }) });

async function boot(opened, shared, enabled = true, registryExtra = {}) {
  const cfg = logisticsConfig(enabled);
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
    ? { factionId: Number(id), startStations: [] } : null), listFactions: () => [{ factionId: FACTION_A }],
  listActiveFactions: () => [{ factionId: FACTION_A }], isActive: (id) => [FACTION_A, FACTION_B].includes(Number(id)),
  ...registryExtra };
  const st = startStations({ config: cfg, persistence, strategy: { registry }, graph: graphService(shared.graph),
    clock: shared.clock });
  assert.ok(st.ok, JSON.stringify(st));
  holder.stations = st.stations;
  await st.stations.whenReady();
  const views = createViewRegistry();
  const lines = [];
  const lr = startLogistics({ config: cfg, persistence, clock: shared.clock, ids: shared.ids, scheduler: sr.scheduler,
    fleets: fr.fleets, strategy: { registry }, getStations: () => holder.stations, views,
    logger: { log: (l) => lines.push(l) } });
  const tx = (fn) => {
    const r = opened.store.transaction("test", fn);
    assert.ok(r.ok, JSON.stringify(r));
    return r.value;
  };
  return { store: opened.store, scheduler: sr.scheduler, fleets: fr.fleets, stations: st.stations,
    logistics: lr.ok ? lr.logistics : null, started: lr, views, lines, tx };
}

function addStation(env, id, systemId, at, ownerFactionId = FACTION_A) {
  const r = env.tx((db) => env.stations.repository.createStation(db, { stationId: id, kind: "upwell", typeId: 35832,
    structureFamily: "astrahus", systemId, ownerFactionId, ownerCorporationId: 1000162, origin: "built",
    at }, `test:station:${id}`));
  assert.ok(r.ok, JSON.stringify(r));
}

function putStock(env, stationId, deltas, key, at) {
  const r = env.tx((db) => env.stations.repository.applyStockChange(db, { stationId, key, reason: "TEST", at,
    deltas }));
  assert.ok(r.ok, JSON.stringify(r));
}

function newConvoyFleet(env, tag, systemId, composition = CONVOY) {
  const r = env.fleets.createFleet({ factionId: FACTION_A, currentSystemId: systemId, homeSystemId: systemId,
    fleetRole: "logistics", composition }, `${tag}:create`);
  assert.ok(r.ok, JSON.stringify(r));
  return r.fleetId;
}

const fleetOf = (env, id) => env.tx((db) => env.fleets.repository.getFleet(db, id)).fleet;
const convoyOf = (env, id) => env.tx((db) => env.logistics.convoys.getConvoy(db, id)).convoy;
const stockOf = (env, stationId) => env.tx((db) => db.prepare("SELECT item_kind, item_key, quantity FROM "
  + "world_station_stock WHERE station_id = ? ORDER BY item_key").all(stationId))
  .reduce((o, r) => ({ ...o, [`${r.item_kind}/${r.item_key}`]: r.quantity }), {});

function dispatch(env, shared, tag, fleetId, items, purpose = "HULLS_TO_MOBILIZATION") {
  const f = fleetOf(env, fleetId);
  return env.tx((db) => env.logistics.dispatchInTx(db, { factionId: FACTION_A, fleetId, expectedVersion: f.version,
    purpose, sourceStationId: "st-b", destStationId: "st-a", items, at: shared.clock.now() }, tag));
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

const fleetFacts = (o) => ({ fleetId: "f", state: "IDLE", currentSystemId: 1, operationId: null,
  refitPending: false, ...o });

const TRIBUTE_REGISTRY = Object.freeze({ tributeRecipientOf: (f) => (Number(f) === FACTION_A ? FACTION_B : null) });
const MINERAL = "mineral/type:34";

async function tributeScene(reopen, shared) {
  const env = await boot(reopen(), shared, true, TRIBUTE_REGISTRY);
  const t0 = shared.clock.now();
  addStation(env, "st-pay", S.N5, t0);
  addStation(env, "st-rcv", S.N0, t0, FACTION_B);
  putStock(env, "st-pay", [{ itemKind: "mineral", itemKey: "type:34", delta: 5000 },
    { itemKind: "hull", itemKey: "group:battleship", delta: 1 }], "test:stock:pay", t0);
  return env;
}

function tributeDispatch(env, shared, tag, fleetId, items, purpose = "TRIBUTE") {
  const f = fleetOf(env, fleetId);
  return env.tx((db) => env.logistics.dispatchInTx(db, { factionId: FACTION_A, fleetId, expectedVersion: f.version,
    purpose, sourceStationId: "st-pay", destStationId: "st-rcv", items, at: shared.clock.now() }, tag));
}

async function untilEnded(env, shared, convoyId) {
  for (let i = 0; i < 8; i += 1) {
    if (["DELIVERED", "ABORTED", "LOST"].includes(convoyOf(env, convoyId).state)) return convoyOf(env, convoyId);
    await settleAt(env, shared, shared.clock.now() + DEFAULTS.logistics.watchGraceMs);
  }
  return convoyOf(env, convoyId);
}

module.exports = ({ test, skip }) => {
  test("C0 config logistics.*, row bounds, unavailable stub; C5 scaleCargo / volumes; C3 fuzz "
    + "decideConvoyStep -> only edges of CONVOY_TRANSITIONS", () => {
    const c = DEFAULTS.logistics;
    assert.deepStrictEqual([c.enabled, c.maxFleetsPerFaction, c.maxOpenConvoysPerFaction, c.carrierCapacityM3,
      c.maxCargoItems, c.needsHulls], [true, 4, 6, 60000, 12, false]);
    assert.strictEqual(convoyDispatchRows(0), CONVOY_DISPATCH_BASE_ROWS, "reviewRows literal = economy/schema");
    const base = { maxObservationsPerReview: 0, maxHousekeepingPerReview: 0, maxRefitRequestsPerReview: 0,
      maxOperationsPerReview: 0, maxMobilizationsPerReview: 0, maxFleetsPerOperation: 0 };
    assert.strictEqual(reviewRowBound(base, null, null, null, c) - reviewRowBound(base, null, null, null, null),
      2 * (1 + 18 + 12 + 8) + 5 + 2 * (1 + 20 + 2 + 2) + 2 * 23);
    assert.strictEqual(reviewRowBound(base, null, null, null, c)
      - reviewRowBound(base, null, null, null, { ...c, retireEnabled: false, strandedReturnEnabled: false }),
    c.maxRetiresPerReview * 23);
    assert.deepStrictEqual([c.retireEnabled, c.maxRetiresPerReview], [true, 2]);
    assert.strictEqual(reviewRowBound(base, null, null, null, c, DEFAULTS.construction)
      - reviewRowBound(base, null, null, null, c, null), 5);
    const r = config.resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_LOGISTICS_MAX_CARGO_ITEMS: "64",
      EVEJS_LNE_STATIONS_MAX_DELTAS_PER_CHANGE: "16", EVEJS_LNE_PRODUCTION_ENABLED: "0" } });
    const text = r.warnings.join("\n");
    assert.ok(text.includes("logistics.maxCargoItems=64 above stations.maxDeltasPerChange=16"), text);
    assert.ok(text.includes("logistics.enabled with production.enabled=false"), text);
    assert.strictEqual(createUnavailableLogistics("x").getMode(), "off");
    assert.strictEqual(createUnavailableLogistics("x").dispatchInTx().reason, "LOGISTICS_UNAVAILABLE");

    assert.deepStrictEqual(scaleCargo({ [BS]: 3, "mineral/type:34": 1001 }, 2, 1),
      { deliver: { [BS]: 1, "mineral/type:34": 500 }, lostUnits: 2 + 501 });
    assert.deepStrictEqual(scaleCargo({ [BS]: 3 }, 2, 2), { deliver: { [BS]: 3 }, lostUnits: 0 });
    assert.strictEqual(cargoVolume({ "hull/group:capital": 1 }).reason, "CARGO_INVALID");
    assert.strictEqual(capacityOf(CONVOY, c), 2 * 60000 * 100);
    assert.deepStrictEqual(fitCargo({ [BS]: 3 }, capacityOf(CONVOY, c)), { [BS]: 2 }, "50 000 m3 each");

    const rng = createRng(20261017);
    const states = ["IDLE", "IDLE", "PLANNED", "TRAVELLING", "STAGED", "STAGED", "ENGAGED", "RETREATING", "REFITTING",
      "DESTROYED"];
    const seen = new Set();
    for (let n = 0; n < 500; n += 1) {
      const convoy = { state: rng.pick(CONVOY_STATES), sourceSystemId: 1, destSystemId: 2,
        operationId: rng.pick(["op1", null]), watchRound: rng.nextInt(0, 14) };
      const fleet = rng.chance(0.1) ? null : fleetFacts({ state: rng.pick(states), currentSystemId: rng.pick([1, 2, 3]),
        operationId: rng.pick(["op1", "op2", null]), refitPending: rng.chance(0.2) });
      const facts = { at: 1, trigger: rng.pick(["arrival", "due", "reconcile"]), sourceOk: rng.chance(0.8),
        destOk: rng.chance(0.6), stationHereId: rng.pick([null, "here"]), stationsMode: rng.pick(["ready", "ready",
          "pending"]), carriers: rng.pick([0, 1, 2, 2]) };
      const d = decideConvoyStep(convoy, fleet, facts, { maxWatchRounds: 12 });
      assert.ok(Object.prototype.hasOwnProperty.call(ACTION_EDGES, d.action), d.action);
      seen.add(d.action);
      const edge = ACTION_EDGES[d.action];
      if (edge === null) continue;
      assert.strictEqual(edge[0], convoy.state, `${d.action} from ${convoy.state}`);
      assert.ok(CONVOY_TRANSITIONS[edge[0]].includes(edge[1]), `${edge[0]} -> ${edge[1]}`);
    }
    for (const a of Object.values(ACTION)) assert.ok(seen.has(a), `fuzz reached ${a}: ${[...seen].join()}`);
  });

  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  needsDriver("C1/C2 convoy exactly once: local LOAD (source -, destination unchanged) -> arrival -> DELIVERED "
    + "(+1 once despite replays and the delivery key by hand); remote TO_SOURCE -> LOAD -> destroyed -> LOST; "
    + "logistics off keeps the convoy frozen, the next start continues; migration 17 from zero", () => H.withStore(
    driver, async (reopen) => {
      const shared = H.sharedOf();
      let opened = reopen();
      assert.strictEqual(opened.schemaVersion, LATEST_SCHEMA_VERSION);
      assert.strictEqual(MIGRATIONS[16].name, "world_convoys");
      let env = await boot(opened, shared);
      assert.strictEqual(env.logistics.getMode(), "ready");
      const t0 = shared.clock.now();
      addStation(env, "st-a", S.N0, t0);
      addStation(env, "st-b", S.N5, t0);
      putStock(env, "st-b", [{ itemKind: "hull", itemKey: "group:battleship", delta: 1 },
        { itemKind: "mineral", itemKey: "type:34", delta: 5000 }], "test:stock:b", t0);

      const local = newConvoyFleet(env, "c1l", S.N5);
      const d = dispatch(env, shared, "c1:d", local, [{ itemKind: "hull", itemKey: "group:battleship", quantity: 1 }]);
      assert.deepStrictEqual([d.ok, d.state, d.loaded], [true, "IN_TRANSIT", { [BS]: 1 }], JSON.stringify(d));
      assert.deepStrictEqual(stockOf(env, "st-b"), { "mineral/type:34": 5000 }, "source stock down at the load");
      assert.deepStrictEqual(stockOf(env, "st-a"), {}, "nothing at the destination before the delivery");
      const dup = env.tx((db) => env.logistics.dispatchInTx(db, { factionId: FACTION_A, fleetId: local,
        expectedVersion: 99, purpose: "HULLS_TO_MOBILIZATION", sourceStationId: "st-b", destStationId: "st-a",
        items: [{ itemKind: "hull", itemKey: "group:battleship", quantity: 1 }], at: t0 }, "c1:d"));
      assert.deepStrictEqual([dup.ok, dup.duplicate, dup.convoyId], [true, true, d.convoyId]);
      const nothing = dispatch(env, shared, "c1:none", newConvoyFleet(env, "c1n", S.N5),
        [{ itemKind: "hull", itemKey: "group:cruiser", quantity: 1 }]);
      assert.strictEqual(nothing.reason, "NOTHING_TO_LOAD", "nothing written");
      await settleAt(env, shared, d.arriveAt);
      const c = convoyOf(env, d.convoyId);
      assert.deepStrictEqual([c.state, c.deliveredStationId, c.delivered, c.lostUnits], ["DELIVERED", "st-a",
        { [BS]: 1 }, 0]);
      assert.deepStrictEqual(stockOf(env, "st-a"), { [BS]: 1 });
      assert.strictEqual(fleetOf(env, local).state, "IDLE");

      const f = fleetOf(env, local);
      const nudge = { fleetId: local, legSeq: f.legSeq, state: "STAGED", at: d.arriveAt };
      for (const [id, k, p] of [[local, convoyNudgeKey(local, f.legSeq, "STAGED"), nudge], [local, "test:nudge", nudge],
        [d.convoyId, "test:due", { convoyId: d.convoyId, phaseSeq: 1, round: 0 }]]) {
        const q = env.scheduler.enqueue("CONVOY_DELIVERY", id, d.arriveAt, p, k);
        assert.ok(q.ok, JSON.stringify(q));
      }
      await settleAt(env, shared, shared.clock.now() + 1000);
      const byHand = env.tx((db) => env.stations.repository.applyStockChange(db, { stationId: "st-a",
        key: convoyDeliverKey(d.convoyId), reason: "CONVOY_DELIVERY", at: shared.clock.now(),
        deltas: [{ itemKind: "hull", itemKey: "group:battleship", delta: 1 }] }));
      assert.deepStrictEqual([byHand.ok, byHand.duplicate], [true, true]);
      assert.deepStrictEqual(stockOf(env, "st-a"), { [BS]: 1 }, "one increment");
      assert.strictEqual(convoyOf(env, d.convoyId).version, c.version);

      const remote = newConvoyFleet(env, "c1r", S.N0);
      const r = dispatch(env, shared, "c1:r", remote, [{ itemKind: "mineral", itemKey: "type:34", quantity: 4000 }],
        "MINERALS_TO_FACTORY");
      assert.deepStrictEqual([r.ok, r.state], [true, "TO_SOURCE"], JSON.stringify(r));
      assert.deepStrictEqual([stockOf(env, "st-b"), stockOf(env, "st-a")], [{ "mineral/type:34": 5000 }, { [BS]: 1 }]);
      env.logistics.stop("restart");
      opened.store.close("restart");
      opened = reopen();
      env = await boot(opened, shared, false);
      assert.deepStrictEqual([env.started.ok, env.started.reason], [false, "disabled_by_config"]);
      await settleAt(env, shared, r.arriveAt + 60000);
      const frozen = env.tx((db) => db.prepare("SELECT state, plan_json FROM world_convoys WHERE convoy_id = ?")
        .get(r.convoyId));
      assert.deepStrictEqual([frozen.state, JSON.parse(frozen.plan_json)], ["TO_SOURCE", { "mineral/type:34": 4000 }]);
      assert.deepStrictEqual(stockOf(env, "st-b"), { "mineral/type:34": 5000 }, "nothing loaded while off");
      opened.store.close("restart");
      opened = reopen();
      env = await boot(opened, shared, true);
      await settleAt(env, shared, r.arriveAt + DEFAULTS.logistics.watchGraceMs);
      const loaded = convoyOf(env, r.convoyId);
      assert.deepStrictEqual([loaded.state, loaded.cargo], ["IN_TRANSIT", { "mineral/type:34": 4000 }],
        env.lines.join("\n"));
      assert.deepStrictEqual([stockOf(env, "st-b"), stockOf(env, "st-a")], [{ "mineral/type:34": 1000 }, { [BS]: 1 }]);
      const page = env.tx((db) => env.logistics.listInTransitInTx(db, { limit: 10 }));
      const row = page.convoys.find((x) => x.convoyId === r.convoyId);
      assert.ok(Number.isSafeInteger(loaded.carriersAtLoad) && loaded.carriersAtLoad >= 1, String(loaded.carriersAtLoad));
      assert.deepStrictEqual([row.cargo, row.carriersAtLoad], [{ "mineral/type:34": 4000 }, loaded.carriersAtLoad]);

      env.tx((db) => {
        const x = env.fleets.repository.getFleet(db, remote).fleet;
        const e = env.fleets.repository.transition(db, { fleetId: remote, expectedVersion: x.version, from: x.state,
          to: "ENGAGED" }, "c1r:engage");
        assert.ok(e.ok, JSON.stringify(e));
        const l = env.fleets.repository.applyLosses(db, { fleetId: remote, expectedVersion: e.version,
          losses: CONVOY.map((s) => ({ hullGroup: s.hullGroup, typeId: null, count: s.count })) }, "c1r:loss");
        assert.ok(l.ok && l.destroyed, JSON.stringify(l));
      });
      await settleAt(env, shared, shared.clock.now() + DEFAULTS.logistics.watchGraceMs
        + DEFAULTS.logistics.watchRecheckMs * 2);
      const lost = convoyOf(env, r.convoyId);
      assert.deepStrictEqual([lost.state, lost.endReason, lost.lostUnits], ["LOST", "FLEET_DESTROYED", 4000]);
      assert.deepStrictEqual(stockOf(env, "st-a"), { [BS]: 1 }, "destination unchanged");
      const totals = env.tx((db) => env.logistics.convoys.getTotals(db, FACTION_A)).totals;
      assert.deepStrictEqual([totals.convoysStarted, totals.convoysDelivered, totals.convoysLost, totals.unitsLost],
        [2, 1, 1, 4000]);
      const panel = env.views.getView("logistics").getData();
      assert.strictEqual(panel.available, true, JSON.stringify(panel));

      for (const name of WRECKEDCONVOY_LOGISTICS_METHODS) {
        assert.deepStrictEqual([typeof env.logistics[name], typeof createUnavailableLogistics("x")[name]],
          ["function", "function"], name);
      }
      const lostRow = (c) => ({ convoyId: c.convoyId, factionId: c.factionId, fleetId: c.fleetId,
        systemId: fleetOf(env, c.fleetId).currentSystemId, lostUnits: c.lostUnits, endedAt: c.endedAt });
      const lostPage = (opts) => env.tx((db) => env.logistics.listLostInTx(db, opts));
      assert.deepStrictEqual(lostPage({ sinceMs: 0, limit: 10 }), { ok: true, truncated: false,
        convoys: [lostRow(lost)] }, "the DELIVERED convoy is not listed");
      assert.deepStrictEqual(lostPage({ sinceMs: lost.endedAt + 1, limit: 10 }).convoys, []);
      const setLost = (endReason) => env.tx((db) => db.prepare("UPDATE world_convoys SET state = 'LOST', ended_at = ?, "
        + "end_reason = ? WHERE convoy_id = ?").run(lost.endedAt - 1, endReason, d.convoyId));
      for (const endReason of ["STOCK_FULL", "TIMEOUT"]) {
        setLost(endReason);
        assert.deepStrictEqual(lostPage({ sinceMs: 0, limit: 10 }).convoys.map((c) => c.convoyId), [r.convoyId],
          endReason);
      }
      setLost("CARRIERS_LOST");
      assert.deepStrictEqual(lostPage({ sinceMs: 0, limit: 1 }), { ok: true, truncated: true,
        convoys: [lostRow(lost)] });
      assert.deepStrictEqual(lostPage({ sinceMs: 0, limit: 2 }).convoys.map((c) => c.convoyId),
        [r.convoyId, d.convoyId]);
      assert.strictEqual(lostPage({ sinceMs: 0, limit: 0 }).reason, "LOGISTICS_INVALID_INPUT");
      assert.strictEqual(createUnavailableLogistics("x").listLostInTx().reason, "LOGISTICS_UNAVAILABLE");
    }, { fresh: true }));

  const made = createIndustryCatalog();
  const FREIGHT = Object.freeze([{ hullGroup: "freighter", count: 1 }, { hullGroup: "frigate", count: 2 }]);
  test("E1 capacity per carrier group: freighter = cargoMedianM3 (never the Bowhead cargoM3) x 2000 permille "
    + "{freighter 1, frigate 2} = cap.freighter x 100; old params keep industrial x carrierCapacityM3", () => {
    assert.ok(made.ok, JSON.stringify(made));
    const row = made.catalog.hull("freighter");
    assert.ok(row.cargoMedianM3 > 100000, `freighter median ${row.cargoMedianM3}`);
    assert.notStrictEqual(row.cargoMedianM3, row.cargoM3, "the median, not the representative");
    const cap = carrierCapacitiesM3(DEFAULTS.logistics, made.catalog);
    assert.strictEqual(DEFAULTS.logistics.capitalCargoPermille, 2000);
    assert.deepStrictEqual(cap, { industrial: 60000, freighter: Math.floor((row.cargoMedianM3 * 2000) / 1000),
      jump_freighter: Math.floor((made.catalog.hull("jump_freighter").cargoMedianM3 * 2000) / 1000) });
    assert.strictEqual(capacityOf(FREIGHT, { capacityM3: cap }), cap.freighter * 100);
    assert.strictEqual(capacityOf(FREIGHT, DEFAULTS.logistics), 0, "no map: capitals carry nothing");
    assert.deepStrictEqual(carrierCapacitiesM3(DEFAULTS.logistics, null), { industrial: 60000, freighter: 0,
      jump_freighter: 0 });
  });

  needsDriver("E1 dispatchInTx with {freighter 1, frigate 2}: one unit above the capacity -> CARGO_TOO_LARGE "
    + "exactly the capacity -> ok", () => H.withStore(driver, async (reopen) => {
    const shared = H.sharedOf();
    const env = await boot(reopen(), shared);
    const t0 = shared.clock.now();
    addStation(env, "st-a", S.N0, t0);
    addStation(env, "st-b", S.N5, t0);
    const units = carrierCapacitiesM3(DEFAULTS.logistics, made.catalog).freighter * 100;
    const fleetId = newConvoyFleet(env, "e1", S.N0, FREIGHT);
    const over = dispatch(env, shared, "e1:over", fleetId, [{ itemKind: "mineral", itemKey: "type:34",
      quantity: units + 1 }], "MINERALS_TO_FACTORY");
    assert.deepStrictEqual([over.ok, over.reason, over.capacity], [false, "CARGO_TOO_LARGE", units], JSON.stringify(over));
    const fits = dispatch(env, shared, "e1:fit", fleetId, [{ itemKind: "mineral", itemKey: "type:34",
      quantity: units }], "MINERALS_TO_FACTORY");
    assert.deepStrictEqual([fits.ok, fits.state], [true, "TO_SOURCE"], JSON.stringify(fits));
    env.logistics.stop("test");
  }, { fresh: true }));

  needsDriver("TA2 TRIBUTE to the ONLINE receiver station (local LOAD) -> DELIVERED once "
    + "(receiver + cargo, payer - cargo, replayed step STALE); same target as MINERALS_TO_FACTORY -> DEST_INVALID; "
    + "hull item in TRIBUTE -> CARGO_INVALID; readOpen has destSystemId", () => H.withStore(driver, async (reopen) => {
    const shared = H.sharedOf();
    const env = await tributeScene(reopen, shared);
    const fleetId = newConvoyFleet(env, "ta2", S.N5);
    const minerals = [{ itemKind: "mineral", itemKey: "type:34", quantity: 3000 }];
    const asFactory = tributeDispatch(env, shared, "ta2:factory", fleetId, minerals, "MINERALS_TO_FACTORY");
    assert.deepStrictEqual([asFactory.ok, asFactory.reason, asFactory.detail], [false, "DEST_INVALID", undefined]);
    const hull = tributeDispatch(env, shared, "ta2:hull", fleetId,
      [...minerals, { itemKind: "hull", itemKey: "group:battleship", quantity: 1 }]);
    assert.deepStrictEqual([hull.ok, hull.reason, hull.detail], [false, "CARGO_INVALID", "TRIBUTE_ITEM"]);

    const d = tributeDispatch(env, shared, "ta2:d", fleetId, minerals);
    assert.deepStrictEqual([d.ok, d.state, d.loaded], [true, "IN_TRANSIT", { [MINERAL]: 3000 }], JSON.stringify(d));
    assert.deepStrictEqual(stockOf(env, "st-pay"), { [BS]: 1, [MINERAL]: 2000 });
    const open = env.tx((db) => env.logistics.readOpen(db, FACTION_A));
    assert.deepStrictEqual(open.convoys.map((c) => [c.purpose, c.destStationId, c.destSystemId]),
      [["TRIBUTE", "st-rcv", S.N0]]);
    assert.deepStrictEqual([open.convoys[0].items, convoyItemsOf(open.convoys[0])], [{ [MINERAL]: 3000 },
      [{ itemKind: "mineral", itemKey: "type:34", quantity: 3000 }]]);
    const c = await untilEnded(env, shared, d.convoyId);
    assert.deepStrictEqual([c.state, c.deliveredStationId, c.delivered], ["DELIVERED", "st-rcv", { [MINERAL]: 3000 }]);
    assert.deepStrictEqual(stockOf(env, "st-rcv"), { [MINERAL]: 3000 });

    const q = env.scheduler.enqueue("CONVOY_DELIVERY", d.convoyId, shared.clock.now(),
      { convoyId: d.convoyId, phaseSeq: 1, round: 0 }, "ta2:replay");
    assert.ok(q.ok, JSON.stringify(q));
    const staleBefore = env.logistics.getStatus().counters.stale;
    await settleAt(env, shared, shared.clock.now() + 1000);
    const counters = env.logistics.getStatus().counters;
    assert.strictEqual(counters.stale, staleBefore + 1);
    assert.deepStrictEqual(stockOf(env, "st-rcv"), { [MINERAL]: 3000 }, "one increment");
    assert.deepStrictEqual(stockOf(env, "st-pay"), { [BS]: 1, [MINERAL]: 2000 });
    assert.deepStrictEqual([counters.tributeDelivered, counters.tributeDeliveredUnits, counters.tributeLost],
      [1, 3000, 0]);
    env.logistics.stop("test");
  }, { fresh: true }));

  needsDriver("TA3 tribute: the receiver station destroyed while IN_TRANSIT -> REDIRECT, the cargo "
    + "delivered home (payer station), nothing to the receiver, tributeLost 0", () => H.withStore(driver,
    async (reopen) => {
      const shared = H.sharedOf();
      const env = await tributeScene(reopen, shared);
      const fleetId = newConvoyFleet(env, "ta3", S.N5);
      const d = tributeDispatch(env, shared, "ta3:d", fleetId,
        [{ itemKind: "mineral", itemKey: "type:34", quantity: 1000 }]);
      assert.deepStrictEqual([d.ok, d.state], [true, "IN_TRANSIT"], JSON.stringify(d));
      assert.deepStrictEqual(stockOf(env, "st-pay"), { [BS]: 1, [MINERAL]: 4000 });
      env.tx((db) => {
        const repo = env.stations.repository;
        for (const [from, to] of [["ONLINE", "ARMOR_REINFORCE"], ["ARMOR_REINFORCE", "HULL_REINFORCE"],
          ["HULL_REINFORCE", "DESTROYED"]]) {
          const s = repo.getStation(db, "st-rcv").record;
          const r = repo.transitionStation(db, { stationId: "st-rcv", expectedVersion: s.version, from, to,
            key: `ta3:${to}`, reason: "TEST", at: shared.clock.now() });
          assert.ok(r.ok, JSON.stringify(r));
        }
      });
      const c = await untilEnded(env, shared, d.convoyId);
      assert.deepStrictEqual([c.state, c.deliveredStationId, c.delivered], ["DELIVERED", "st-pay",
        { [MINERAL]: 1000 }], env.lines.join("\n"));
      assert.deepStrictEqual(stockOf(env, "st-pay"), { [BS]: 1, [MINERAL]: 5000 }, "the tribute came home");
      assert.deepStrictEqual(stockOf(env, "st-rcv"), {}, "nothing to the receiver");
      const counters = env.logistics.getStatus().counters;
      assert.ok(counters.redirected >= 1, JSON.stringify(counters));
      assert.deepStrictEqual([counters.tributeDelivered, counters.tributeDeliveredUnits, counters.tributeLost],
        [0, 0, 0]);
      env.logistics.stop("test");
    }, { fresh: true }));
};

Object.assign(module.exports, { harness: Object.freeze({ boot, addStation, putStock, newConvoyFleet, fleetOf,
  convoyOf, stockOf, settleAt, tributeScene, tributeDispatch, untilEnded, TRIBUTE_REGISTRY }) });
