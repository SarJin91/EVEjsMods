"use strict";

const assert = require("node:assert");
const path = require("node:path");

const config = require("../../config");
const { createJournal } = require("../../lib/persistence/journal");
const { startScheduler } = require("../../lib/scheduler");
const { startFleets } = require("../../lib/fleets");
const { startStations } = require("../../lib/stations");
const { startMining } = require("../../lib/economy/mining");
const { createViewRegistry } = require("../../lib/observer/views");
const { createReviewService } = require("../../lib/strategy/reviewService");
const { planMining } = require("../../lib/strategy/ai/mining");
const { canMineIn, stationExemptionOf } = require("../../lib/strategy/ai/miningControl");
const { mineralCoverOf } = require("../../lib/strategy/ai/miningCover");
const { createManualClock } = require("../../lib/util/clock");
const { createRng } = require("../../lib/util/rng");
const { createIdGenerator } = require("../../lib/util/ids");
const { harness: H } = require("../battle/settlement.test");
const { harness: R } = require("./review.test");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const DEFAULTS = config.resolveConfig({ modDir: MOD_DIR, env: {} }).config;
const FLAG_ENV = "EVEJS_LNE_MINING_OWN_STATION_SYSTEMS_ENABLED";
const MIN_ENV = "EVEJS_LNE_MINING_OWN_STATION_MIN_INFLUENCE";
const D10665 = Object.freeze({ ownStationSystemsEnabled: true, ownStationMinInfluence: 0 });
const SOE = 500016;
const CALDARI = 500001;
const AMARR = 500003;
const X7 = 30001978;
const JC = 30001977;
const RO = 30001983;
const MINER = Object.freeze([{ hullGroup: "industrial", count: 3 }]);
const { S, FACTION_A, FACTION_B } = H;

function serviceParams(env) {
  const resolved = config.resolveConfig({ modDir: MOD_DIR, env });
  assert.deepStrictEqual(resolved.errors || [], []);
  return createReviewService({ store: {}, journal: {}, strategyRepository: { limits: { maxResourceUnits: 1 } },
    intelRepository: {}, registry: {}, kinds: { list: [], get: () => null }, powerTable: {}, scoring: {},
    scheduler: {}, fleets: {}, clock: { now: () => 0 }, worldSeed: 1, config: resolved.config, hostility: () => true,
    isCampaignOk: () => true, industryCatalog: {} }).params;
}

function soeSnapshot(sites, o = {}) {
  const row = (systemId, controllerFactionId, occupierFactionId = null) => ({ systemId, controllerFactionId,
    occupierFactionId, occupationState: "STABLE" });
  return { factionId: SOE, faction: { status: "ACTIVE", homeSystemId: X7 }, stationsMode: "ready",
    stations: [["s1", X7], ["s2", X7], ["s3", X7], ["s4", JC], ["s5", RO]]
      .map(([stationId, systemId]) => ({ stationId, systemId, kind: "npc" })),
    systems: [row(X7, SOE), row(JC, CALDARI, o.occupierJ || null), row(RO, CALDARI)],
    neighbors: () => [], fleetsTruncated: false, operations: [], operationsTruncated: false, intel: [], at: 0,
    doctrine: { templates: { mining: MINER } },
    fleets: [{ fleetId: "fl-1", version: 1, state: "STAGED", fleetRole: "mining", systemId: X7, refitPending: false,
      operationId: "op-1" }],
    mining: { mode: "ready", sites: sites.map((systemId) => ({ systemId, richnessPermille: 400, projected: false })),
      openByBelt: [{ systemId: X7, n: 1 }], busyFleetIds: ["fl-1"] } };
}
const SUPPLY = Object.freeze({ stationSystems: [X7, JC, RO].sort((a, b) => a - b),
  affordable: { resourceUnits: 1e9, reserveUnits: 1e9 } });
const plannerParams = (mining) => ({ mining, maxBfsSystems: 256, intelTtlMs: 3600000, mobilizeResourcePerShip: 1,
  mobilizeReservePerShip: 1 });

function fakeWorld(controllers, influences) {
  const rowOf = (id) => ({ systemId: id, controllerFactionId: controllers.get(id),
    ...(influences && influences.has(id) ? { influence: influences.get(id) } : {}) });
  return { repository: { limits: { maxBatchReadIds: 8 },
    getSystem: (tx, id) => ({ ok: true, system: controllers.has(id) ? rowOf(id) : null }),
    getSystems: (tx, ids) => ({ ok: true, systems: ids.filter((id) => controllers.has(id)).map(rowOf),
      missing: ids.filter((id) => !controllers.has(id)) }) } };
}

async function boot(opened, shared, controllers, miningOver, influences) {
  const cfg = { ...H.CONFIG, modules: { ...H.CONFIG.modules, strategy: { enabled: true } },
    fleets: { ...H.CONFIG.fleets, refitPolicy: "station", refitSeekRecheckMs: 3600000, refitSeekMaxRounds: 24 },
    stations: { ...DEFAULTS.stations, refitSeekRecheckMs: 3600000 }, mining: { ...DEFAULTS.mining, ...miningOver },
    persistence: { ...H.CONFIG.persistence, maxRowsPerTransaction: 500 },
    observer: { ...H.CONFIG.observer, stationsPanelMaxRows: 200, stationsPanelStockLines: 5 } };
  const journal = createJournal({ clock: shared.clock, maxPayloadBytes: 16384, maxRows: 500 });
  const sr = startScheduler({ config: cfg, persistence: { ok: true, store: opened.store }, clock: shared.clock,
    ids: shared.ids, nowMs: () => 0 });
  assert.ok(sr.ok, JSON.stringify(sr));
  const holder = { stations: null };
  const persistence = { ok: true, store: opened.store, journal, worldSeed: opened.worldSeed };
  const graph = { whenReady: () => Promise.resolve({ ok: true, graph: shared.graph }),
    getGraph: () => ({ ok: true, graph: shared.graph }) };
  const fr = startFleets({ config: cfg, persistence, clock: shared.clock, ids: shared.ids, scheduler: sr.scheduler,
    graph, presence: null, views: createViewRegistry(), getStations: () => holder.stations });
  assert.ok(fr.ok, JSON.stringify(fr));
  const registry = { getFaction: (id) => ([FACTION_A, FACTION_B].includes(Number(id))
    ? { factionId: Number(id), startStations: [], doctrineId: `d${Number(id)}`, allies: [] } : null),
  getDoctrine: (d) => ({ doctrineId: d, ownSpace: null }), listFactions: () => [{ factionId: FACTION_A }],
  listActiveFactions: () => [{ factionId: FACTION_A }], isActive: (id) => [FACTION_A, FACTION_B].includes(Number(id)) };
  const st = startStations({ config: cfg, persistence, strategy: { registry }, graph, clock: shared.clock });
  assert.ok(st.ok, JSON.stringify(st));
  holder.stations = st.stations;
  await st.stations.whenReady();
  const mr = startMining({ config: cfg, persistence, clock: shared.clock, ids: shared.ids, scheduler: sr.scheduler,
    fleets: fr.fleets, world: fakeWorld(controllers, influences), strategy: { registry }, graph,
    getStations: () => holder.stations, views: createViewRegistry(), logger: { log() {} },
    adapter: { readSystemBelts: (list) => ({ ok: true, counts: new Map(list.map((id) => [id, 4])) }) } });
  assert.ok(mr.ok, JSON.stringify(mr));
  await Promise.resolve();
  await Promise.resolve();
  const tx = (fn) => {
    const r = opened.store.transaction("test", fn);
    assert.ok(r.ok, JSON.stringify(r));
    return r.value;
  };
  return { scheduler: sr.scheduler, fleets: fr.fleets, stations: st.stations, mining: mr.mining, tx, holder };
}

function addStation(env, id, systemId, at) {
  const r = env.tx((db) => env.stations.repository.createStation(db, { stationId: id, kind: "upwell", typeId: 35832,
    structureFamily: "astrahus", systemId, ownerFactionId: FACTION_A, ownerCorporationId: 1000162, origin: "built",
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
const setStation = (env, id, state) => env.tx((db) => db.prepare("UPDATE world_stations SET state = ? WHERE "
  + "station_id = ?").run(state, id));

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
  test("T1 soe-mining-base cause: SoE with 1 candidate (X-7OMU) -> fleetsWanted 1 = live, no MOBILIZE, no "
    + "MINING_NO_HULLS (the limit is the candidates, not the hulls)", () => {
    const P = serviceParams({});
    const plan = planMining(soeSnapshot([X7]), SUPPLY, plannerParams(P.mining));
    assert.strictEqual(plan.fleetsWanted, 1, JSON.stringify(plan));
    assert.deepStrictEqual(plan.intents.filter((i) => i.type === "MOBILIZE" && i.role === "mining"), []);
    assert.ok(!plan.notes.includes("MINING_NO_HULLS") && !plan.notes.includes("MINING_NO_CANDIDATE"),
      plan.notes.join());
  });

  test("T2 soe-mining-base canMineIn truth table with {ownStationHere}; no opts = the old rule; the row-less branch "
    + "ignores opts", () => {
    const f = FACTION_A;
    const x = FACTION_B;
    const row = (c, o) => ({ controllerFactionId: c, occupierFactionId: o });
    const on = { ownStationHere: true };
    const off = { ownStationHere: false };
    for (const o of [on, off, null, undefined]) {
      assert.strictEqual(canMineIn(f, row(f, null), null, null, null, o), true, "own controller");
      assert.strictEqual(canMineIn(f, row(f, f), null, null, null, o), true, "own controller, own occupier");
      assert.strictEqual(canMineIn(f, row(f, x), null, null, null, o), false, "foreign pretender");
    }
    for (const c of [x, null]) {
      for (const o of [off, null, undefined, {}]) assert.strictEqual(canMineIn(f, row(c, null), null, null, null, o), false);
      assert.strictEqual(canMineIn(f, row(c, null), null, null, null, on), true, "new: own station here");
      assert.strictEqual(canMineIn(f, row(c, f), null, null, null, on), true, "own occupier");
      assert.strictEqual(canMineIn(f, row(c, AMARR), null, null, null, on), false, "foreign occupier blocks");
    }
    assert.strictEqual(canMineIn(f, { controllerFactionId: f, occupierFactionId: null }, null), true);
    assert.strictEqual(canMineIn(f, { controllerFactionId: f, occupierFactionId: x }, null), false);
    assert.strictEqual(canMineIn(f, { controllerFactionId: null }, { factionId: f }, { secClasses: ["nullsec"] }),
      false);
    assert.strictEqual(canMineIn(f, null, { factionId: x, secClass: "nullsec" }, null, null, on), false);
    assert.strictEqual(canMineIn(f, null, { factionId: f, secClass: "nullsec" }, null, null, off), true);
  });

  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  needsDriver("T3 soe-mining-base review: params.mining carries the flag; the real snapshot has the own station system "
    + "under a foreign controller only with the flag; the planner wants 3 SoE fleets, a foreign occupier drops J",
  async () => {
    assert.strictEqual(serviceParams({}).mining.ownStationSystemsEnabled, false);
    assert.strictEqual(serviceParams({ [FLAG_ENV]: "1" }).mining.ownStationSystemsEnabled, true);
    const graph = R.graphOf();
    const J = R.THEATRE.flatMap((id) => graph.getNeighbors(id) || []).filter((id) => !R.THEATRE.includes(id)
      && graph.getSystem(id)).sort((a, b) => a - b)[0];
    assert.ok(Number.isSafeInteger(J), "a system next to the theatre");
    const run = (flag) => H.withStore(driver, async (reopen) => {
      const clock = createManualClock(R.START_MS);
      const shared = { clock, ids: createIdGenerator({ clock, rng: createRng(7) }), graph,
        controllers: new Map([...R.THEATRE.map((id) => [id, R.SANSHA]), [J, R.AMARR]]) };
      const snaps = [];
      const hooks = { beforeEffect: (d, s) => {
        if (d.factionId === R.SANSHA) snaps.push(s);
        return d;
      } };
      const env = await R.bootAll(reopen(), shared, { EVEJS_LNE_STRATEGY_ACTIVE_FACTIONS: String(R.SANSHA),
        [FLAG_ENV]: flag, [MIN_ENV]: "0" }, { mining: true, hooks });
      assert.strictEqual(env.mining.getMode(), "ready");
      const created = env.tx((db) => env.stations.repository.createStation(db, { stationId: "t3-st", kind: "upwell",
        typeId: 35832, structureFamily: "astrahus", systemId: J, ownerFactionId: R.SANSHA,
        ownerCorporationId: env.strategy.registry.getFaction(R.SANSHA).ownerCorporationId, origin: "built",
        at: shared.clock.now() }, "t3:station"));
      assert.ok(created.ok, JSON.stringify(created));
      await R.passesAt(env, shared, R.START_MS + R.I);
      env.strategy.stop("test");
      assert.ok(snaps.length >= 1, "a Sansha round ran");
      const s = snaps[0];
      const rowJ = s.systems.find((x) => x.systemId === J);
      return { rowJ, site: s.mining.sites.find((x) => x.systemId === J) || null };
    });
    const off = await run("0");
    assert.ok(off.rowJ && off.rowJ.controllerFactionId === R.AMARR, "the station system has its world row (bases)");
    assert.strictEqual(off.site, null, "flag off: a foreign controller is no site");
    const on = await run("1");
    assert.ok(on.site && on.site.projected === false && on.site.richnessPermille > 0, JSON.stringify(on));

    const P = serviceParams({ [FLAG_ENV]: "1", [MIN_ENV]: "0" });
    const all = planMining(soeSnapshot([X7, JC, RO]), SUPPLY, plannerParams(P.mining));
    assert.strictEqual(all.fleetsWanted, 3, JSON.stringify(all));
    const plannedOff = planMining(soeSnapshot([X7, JC, RO]), SUPPLY, plannerParams(serviceParams({}).mining));
    assert.strictEqual(plannedOff.fleetsWanted, 1, "flag off in the planner: the controller rule");
    const occupied = planMining(soeSnapshot([X7, JC, RO], { occupierJ: AMARR }), SUPPLY, plannerParams(P.mining));
    assert.strictEqual(occupied.fleetsWanted, 2, JSON.stringify(occupied));
  });

  needsDriver("T4 soe-mining-base dispatch into a foreign-controlled system with an own ONLINE station: off "
    + "NOT_CONTROLLED, on MINING (belt in the station system), ARMOR_REINFORCE -> NOT_CONTROLLED", () =>
    H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const controllers = new Map([[S.N0, FACTION_A], [S.N5, FACTION_B]]);
      let opened = reopen();
      let env = await boot(opened, shared, controllers, {});
      addStation(env, "st-x", S.N0, shared.clock.now());
      addStation(env, "st-j", S.N5, shared.clock.now());
      const off = dispatch(env, shared, "t4:off", newMiner(env, "t4a", S.N5), S.N5);
      assert.deepStrictEqual([off.ok, off.reason], [false, "NOT_CONTROLLED"]);
      env.mining.stop("restart");
      opened.store.close("restart");
      opened = reopen();
      env = await boot(opened, shared, controllers, D10665);
      setStation(env, "st-j", "ARMOR_REINFORCE");
      const reinforced = dispatch(env, shared, "t4:rf", newMiner(env, "t4b", S.N5), S.N5);
      assert.deepStrictEqual([reinforced.ok, reinforced.reason], [false, "NOT_CONTROLLED"]);
      setStation(env, "st-j", "ONLINE");
      const on = dispatch(env, shared, "t4:on", newMiner(env, "t4c", S.N5), S.N5);
      assert.deepStrictEqual([on.ok, on.state], [true, "MINING"], JSON.stringify(on));
      const foreign = dispatch(env, shared, "t4:n6", newMiner(env, "t4d", S.N5), S.N6);
      assert.deepStrictEqual([foreign.ok, foreign.reason], [false, "NOT_CONTROLLED"], "no own station there");
    }));

  needsDriver("T5 soe-mining-base LOAD: own station ONLINE -> a load delivered there; HULL_REINFORCE before the LOAD "
    + "-> empty load (CONTROL_LOST), one return to the own station elsewhere", () => H.withStore(driver,
    async (reopen) => {
      const shared = H.sharedOf();
      const controllers = new Map([[S.N0, FACTION_A], [S.N5, FACTION_B]]);
      const env = await boot(reopen(), shared, controllers, D10665);
      addStation(env, "st-x", S.N0, shared.clock.now());
      addStation(env, "st-j", S.N5, shared.clock.now());
      const full = dispatch(env, shared, "t5:full", newMiner(env, "t5a", S.N5), S.N5);
      assert.deepStrictEqual([full.ok, full.state], [true, "MINING"], JSON.stringify(full));
      await settleAt(env, shared, tripOf(env, full.tripId).miningEndsAt);
      const loaded = tripOf(env, full.tripId);
      assert.deepStrictEqual([loaded.state, loaded.deliveredStationId], ["DELIVERED", "st-j"]);
      assert.ok(Object.values(loaded.delivered).reduce((a, b) => a + b, 0) > 0, JSON.stringify(loaded));

      const lost = dispatch(env, shared, "t5:lost", newMiner(env, "t5b", S.N5), S.N5);
      assert.deepStrictEqual([lost.ok, lost.state], [true, "MINING"], JSON.stringify(lost));
      setStation(env, "st-j", "HULL_REINFORCE");
      const emptyBefore = env.mining.getStatus().counters.emptyLoads;
      await settleAt(env, shared, tripOf(env, lost.tripId).miningEndsAt);
      const back = tripOf(env, lost.tripId);
      assert.deepStrictEqual([back.state, back.returnSystemId, back.cargo], ["RETURNING", S.N0, {}], JSON.stringify(back));
      assert.strictEqual(env.mining.getStatus().counters.emptyLoads, emptyBefore + 1, "one empty load");
      const returns = env.tx((db) => db.prepare("SELECT count(*) AS n FROM world_operations WHERE objective = 'deliver' "
        + "AND state IN ('PLANNED','ACTIVE')").get().n);
      assert.strictEqual(returns, 1, "one return");
    }));

  needsDriver("T6 soe-mining-base: LOAD with the stations not ready (flag on, foreign controller) -> "
    + "STATIONS_NOT_READY retry, no empty load; stations ready again -> the load is delivered", () => H.withStore(driver,
    async (reopen) => {
      const shared = H.sharedOf();
      const controllers = new Map([[S.N0, FACTION_A], [S.N5, FACTION_B]]);
      const env = await boot(reopen(), shared, controllers, D10665);
      addStation(env, "st-x", S.N0, shared.clock.now());
      addStation(env, "st-j", S.N5, shared.clock.now());
      const d = dispatch(env, shared, "t6:go", newMiner(env, "t6a", S.N5), S.N5);
      assert.deepStrictEqual([d.ok, d.state], [true, "MINING"], JSON.stringify(d));
      const endsAt = tripOf(env, d.tripId).miningEndsAt;
      const real = env.holder.stations;
      env.holder.stations = { getMode: () => "pending" };
      await settleAt(env, shared, endsAt);
      const waiting = tripOf(env, d.tripId);
      assert.strictEqual(waiting.state, "MINING", JSON.stringify(waiting));
      assert.strictEqual(env.mining.getStatus().counters.emptyLoads, 0, "no empty CONTROL_LOST load");
      env.holder.stations = real;
      await settleAt(env, shared, endsAt + 3600000);
      const loaded = tripOf(env, d.tripId);
      assert.deepStrictEqual([loaded.state, loaded.deliveredStationId], ["DELIVERED", "st-j"], JSON.stringify(loaded));
      assert.ok(Object.values(loaded.delivered).reduce((a, b) => a + b, 0) > 0, JSON.stringify(loaded));
      assert.strictEqual(env.mining.getStatus().counters.emptyLoads, 0);
    }));

  test("T7: stationExemptionOf truth table; the "
    + "planner drops a foreign-controlled station system without own raw influence (J-CIJV), keeps it with influence",
  () => {
    const GURISTAS = 500010;
    const spec = (o) => ({ factionId: GURISTAS, controllerFactionId: SOE, ownStationHere: true, ownInfluence: 0,
      minInfluence: 1, ...o });
    assert.strictEqual(stationExemptionOf(spec({})), false, "J-CIJV: SoE controller, Guristas influence 0, min 1");
    assert.strictEqual(stationExemptionOf(spec({ minInfluence: 0 })), true, "min 0 =");
    assert.strictEqual(stationExemptionOf(spec({ ownInfluence: 5 })), true, "own influence 5 >= 1");
    assert.strictEqual(stationExemptionOf(spec({ ownInfluence: 1 })), true, "boundary: equal");
    assert.strictEqual(stationExemptionOf(spec({ controllerFactionId: null })), true, "empty controller: as");
    assert.strictEqual(stationExemptionOf(spec({ controllerFactionId: GURISTAS })), true, "own controller");
    assert.strictEqual(stationExemptionOf(spec({ ownStationHere: false, ownInfluence: 99 })), false, "no station");
    assert.strictEqual(stationExemptionOf(spec({ ownInfluence: undefined })), false, "no raw influence field = 0");
    assert.strictEqual(stationExemptionOf(null), false);

    const P = serviceParams({ [FLAG_ENV]: "1" });
    assert.strictEqual(P.mining.ownStationMinInfluence, 1, "default 1 reaches params.mining");
    const none = planMining(soeSnapshot([X7, JC, RO]), SUPPLY, plannerParams(P.mining));
    assert.strictEqual(none.fleetsWanted, 1, `J-CIJV / ROIR-Y without own influence: ${JSON.stringify(none)}`);
    const withInf = soeSnapshot([X7, JC, RO]);
    withInf.systems = withInf.systems.map((s) => (s.systemId === JC ? { ...s, ownInfluenceRaw: 5 } : s));
    const one = planMining(withInf, SUPPLY, plannerParams(P.mining));
    assert.strictEqual(one.fleetsWanted, 2, `J-CIJV with own influence 5: ${JSON.stringify(one)}`);
  });

  needsDriver("T8: dispatch / LOAD with the default min 1: "
    + "foreign controller + own station + raw influence 0 -> NOT_CONTROLLED; 5 -> MINING; 0 again before the LOAD -> "
    + "empty load (CONTROL_LOST)", () => H.withStore(driver, async (reopen) => {
    const shared = H.sharedOf();
    const controllers = new Map([[S.N0, FACTION_A], [S.N5, FACTION_B]]);
    const influences = new Map([[S.N5, [{ factionId: FACTION_A, influenceScore: 0.9 }]]]);
    const env = await boot(reopen(), shared, controllers, { ownStationSystemsEnabled: true }, influences);
    addStation(env, "st-x", S.N0, shared.clock.now());
    addStation(env, "st-j", S.N5, shared.clock.now());
    const refused = dispatch(env, shared, "t8:none", newMiner(env, "t8a", S.N5), S.N5);
    assert.deepStrictEqual([refused.ok, refused.reason], [false, "NOT_CONTROLLED"], "floor(0.9) = 0 < 1");
    influences.set(S.N5, [{ factionId: FACTION_A, influenceScore: 5.4 }]);
    const go = dispatch(env, shared, "t8:go", newMiner(env, "t8b", S.N5), S.N5);
    assert.deepStrictEqual([go.ok, go.state], [true, "MINING"], JSON.stringify(go));
    influences.set(S.N5, [{ factionId: FACTION_A, influenceScore: 0 }]);
    const emptyBefore = env.mining.getStatus().counters.emptyLoads;
    await settleAt(env, shared, tripOf(env, go.tripId).miningEndsAt);
    const back = tripOf(env, go.tripId);
    assert.deepStrictEqual([back.state, back.endReason, back.cargo, back.delivered], ["DELIVERED", "EMPTY", {}, {}],
      JSON.stringify(back));
    assert.strictEqual(env.mining.getStatus().counters.emptyLoads, emptyBefore + 1, "one empty load");
  }));

  test("MC1: mineralCoverOf = min floor over minerals of "
    + "the hull buffer need, limiting mineral; truncated read / hullsRequired:false -> null", () => {
    const c = mineralCoverOf(coverSnapshot(), { production: COVER_PRODUCTION });
    assert.deepStrictEqual(c, { cover: 10, limiting: "type:35" });
    const truncated = coverSnapshot();
    truncated.production.truncated = true;
    assert.deepStrictEqual(mineralCoverOf(truncated, { production: COVER_PRODUCTION }), { cover: null, limiting: null });
    const free = coverSnapshot();
    free.doctrine.hullsRequired = false;
    assert.deepStrictEqual(mineralCoverOf(free, { production: COVER_PRODUCTION }), { cover: null, limiting: null });
  });

  test("MC2: flag on, cover >= threshold, 3 free miners, 0 open trips, coveredMaxOpenTrips 1 -> 1 "
    + "MINE_DISPATCH, 0 miner MOBILIZE, note MINING_STOCK_COVERED:10; 1 open trip -> 0 dispatches", () => {
    const P = serviceParams({ [COVER_ENV]: "1", "EVEJS_LNE_MINING_STOCK_COVER_REBUILDS": "5" });
    assert.deepStrictEqual([P.mining.stockCoverEnabled, P.mining.stockCoverRebuilds, P.mining.coveredMaxOpenTrips],
      [true, 5, 1]);
    const plan = planMining(coverSnapshot(), SOE_SUPPLY, coverParams(P.mining));
    assert.strictEqual(plan.intents.filter((i) => i.type === "MINE_DISPATCH").length, 1, JSON.stringify(plan));
    assert.strictEqual(plan.intents.filter((i) => i.type === "MOBILIZE").length, 0);
    assert.deepStrictEqual(plan.notes, ["MINING_STOCK_COVERED:10"]);
    assert.strictEqual(plan.fleetsWanted, 3, "min(desired, live)");
    const busy = planMining(coverSnapshot({ busy: true }), SOE_SUPPLY, coverParams(P.mining));
    assert.deepStrictEqual(busy.intents.filter((i) => i.type === "MINE_DISPATCH" || i.type === "MOBILIZE"), []);
    assert.deepStrictEqual(busy.notes, ["MINING_STOCK_COVERED:10"], "the cover limit is not MINING_NO_ROOM");
  });

  test("MC3: flag on, cover below the threshold -> the result deepEqual to flag off", () => {
    const off = serviceParams({});
    const on = serviceParams({ [COVER_ENV]: "1", "EVEJS_LNE_MINING_STOCK_COVER_REBUILDS": "11" });
    const a = planMining(coverSnapshot(), SOE_SUPPLY, coverParams(off.mining));
    const b = planMining(coverSnapshot(), SOE_SUPPLY, coverParams(on.mining));
    assert.deepStrictEqual(b, a);
    assert.ok(a.intents.some((i) => i.type === "MOBILIZE"), "the fixture mobilizes below the threshold");
  });

  test("MC4: flag off (defaults false/30/1), a huge stock -> mobilization and dispatch to the limits, no note",
    () => {
      const P = serviceParams({});
      assert.deepStrictEqual([P.mining.stockCoverEnabled, P.mining.stockCoverRebuilds, P.mining.coveredMaxOpenTrips],
        [false, 30, 1]);
      const plan = planMining(coverSnapshot({ stockScale: 1e6 }), SOE_SUPPLY, coverParams(P.mining));
      assert.strictEqual(plan.intents.filter((i) => i.type === "MOBILIZE").length, P.mining.maxMobilizationsPerReview);
      assert.strictEqual(plan.intents.filter((i) => i.type === "MINE_DISPATCH").length,
        Math.min(3, P.mining.maxDispatchesPerReview), JSON.stringify(plan));
      assert.ok(!plan.notes.some((n) => n.startsWith("MINING_STOCK_COVERED")), plan.notes.join());
    });
};

const COVER_ENV = "EVEJS_LNE_MINING_STOCK_COVER_ENABLED";
const COVER_PRODUCTION = Object.freeze({ targetStockFleets: 2, hullGroups: ["cruiser", "frigate", "industrial"],
  miningNeedsHulls: false });
const SOE_SUPPLY = Object.freeze({ stationSystems: [X7, JC, RO].sort((a, b) => a - b),
  affordable: { resourceUnits: 1e9, reserveUnits: 1e9 } });

function coverSnapshot(o = {}) {
  const k = o.stockScale || 1;
  const s = soeSnapshot([X7, JC, RO]);
  s.systems = s.systems.map((x) => ({ ...x, controllerFactionId: SOE }));
  s.doctrine = { templates: { mining: MINER, invasion: [{ hullGroup: "cruiser", count: 2 },
    { hullGroup: "frigate", count: 3 }] } };
  const miner = (fleetId, systemId, state) => ({ fleetId, version: 1, state, fleetRole: "mining", systemId,
    refitPending: false, operationId: null });
  s.fleets = [miner("m-a", X7, "IDLE"), miner("m-b", JC, "IDLE"), miner("m-c", RO, "IDLE")];
  s.mining = { ...s.mining, openByBelt: [], busyFleetIds: [] };
  if (o.busy) {
    s.fleets.push(miner("m-z", X7, "MOVING"));
    s.mining.busyFleetIds = ["m-z"];
  }
  s.production = { mode: "ready", truncated: false, recipesVersion: 1, inProduction: {}, activeJobsTotal: 0,
    recipes: { cruiser: { minerals: { "type:34": 100, "type:35": 10 } },
      frigate: { minerals: { "type:34": 20, "type:36": 5 } } },
    stations: [{ stationId: "s1", systemId: X7, minerals: { "type:34": 5200 * k, "type:35": 300 * k, "type:36": 10000 * k } },
      { stationId: "s2", systemId: JC, minerals: { "type:34": 520 * k, "type:35": 100 * k } }] };
  return s;
}

const coverParams = (mining) => ({ ...plannerParams({ ...mining, maxFleetsPerFaction: 64, fleetsPerStationPermille: 2000,
  targetFleetsPerSystemPermille: 3000, maxFleetsPerSystem: 4 }), production: COVER_PRODUCTION });
