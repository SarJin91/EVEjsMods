"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createJournal } = require("../../lib/persistence/journal");
const { createManualClock } = require("../../lib/util/clock");
const { createRng } = require("../../lib/util/rng");
const { createIdGenerator } = require("../../lib/util/ids");
const { buildUniverseGraph } = require("../../lib/graph/universeGraph");
const { createRouteFinder } = require("../../lib/graph/routes");
const { createViewRegistry } = require("../../lib/observer/views");
const { startScheduler } = require("../../lib/scheduler");
const { startFleets } = require("../../lib/fleets");
const { startStations } = require("../../lib/stations");
const { startStrategy } = require("../../lib/strategy");
const { startMining } = require("../../lib/economy/mining");
const { startProduction } = require("../../lib/economy/production");
const { startConstruction } = require("../../lib/stations/construction");
const { startLogistics } = require("../../lib/economy/logistics");
const { startTrade } = require("../../lib/economy/trade");
const { startTreasury } = require("../../lib/economy/treasury");
const { feeOf: treasuryFeeOf } = require("../../lib/economy/treasury/austerity");
const RECIPES = require("../../lib/economy/data/hullRecipes");
const { resolveConfig } = require("../../config");
const { openStore } = require("../../lib/persistence/store");
const { MIGRATIONS } = require("../../lib/persistence/migrations");
const { harness: H } = require("../battle/settlement.test");
const { harness: LH } = require("../economy/logistics.test");
const { k3StaticMap, system } = require("./fixtures/k3Cluster.fixture");
const { REGISTRY_DATA_V1, createFactionRegistry } = require("../../lib/strategy/registry");
const { HULL_GROUPS, FLEET_ROLES, OPERATION_TYPES } = require("../../lib/fleets/schema");
const { createHostility } = require("../../lib/battle/data/hostility");
const { buildFleetsView, corporationOf } = require("../../lib/fleets/fleetsView");
const { createUnavailableSiege } = require("../../lib/stations/siege");
const { bfs } = require("../../lib/strategy/ai/bfs");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const START_MS = 1760000000000;
const AMARR = 500003;
const CONCORD = 500006;
const SANSHA = 500019;
const SERPENTIS = 500020;
const SAMINER = 30001721;
const A_DZA8 = 30001954;
const REVIEW = "FACTION_STRATEGY_REVIEW";
const I = 900000;
const THEATRE = [1867, 1868, 1869, 1870, 1871, 1872, 1893, 1894, 1895, 1896, 1897, 1898, 1899, 1900, 1901, 1902, 1903,
  1904, 1923, 1924, 1925, 1926, 1927, 1928, 1929, 1930, 1948, 1949, 1950, 1951, 1952, 1953, 1954, 1955]
  .map((n) => 30000000 + n);

function graphOf(opts) {
  const built = buildUniverseGraph(k3StaticMap(opts));
  assert.ok(built.ok);
  return Object.freeze({ ...built.graph, ...createRouteFinder(built.graph, { cacheSize: 64, maxJumps: 40 }).publicApi });
}

const K3_FACTIONS = "500003,500006,500019,500020";

function configOf(env) {
  const r = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_DATA_ROOT: os.tmpdir(),
    EVEJS_LNE_STRATEGY_ACTIVE_FACTIONS: K3_FACTIONS, ...env } });
  assert.deepStrictEqual(r.errors || [], []);
  return r.config;
}

function fakeWorld(controllers) {
  return { repository: { limits: { maxBatchReadIds: 8 }, getChangeCount: () => 0,
    getSystem: (tx, id) => ({ ok: true, system: controllers.has(id)
      ? { systemId: id, controllerFactionId: controllers.get(id) } : null }),
    getSystems(tx, ids) {
    return { ok: true, systems: ids.filter((id) => controllers.has(id)).map((id) => ({ systemId: id,
      controllerFactionId: controllers.get(id), occupationState: "STABLE", influence: [] })), missing: [] };
  } } };
}

async function bootAll(opened, shared, env, extra = {}) {
  const config = configOf(env);
  const journal = createJournal({ clock: shared.clock, maxPayloadBytes: 16384, maxRows: 500 });
  const graphService = { whenReady: () => Promise.resolve({ ok: true, graph: shared.graph }),
    getGraph: () => ({ ok: true, graph: shared.graph }) };
  const persistence = { ok: true, store: opened.store, journal, worldSeed: opened.worldSeed };
  const sr = startScheduler({ config, persistence: { ok: true, store: opened.store }, clock: shared.clock,
    ids: shared.ids, nowMs: () => 0 });
  assert.ok(sr.ok, JSON.stringify(sr));
  const holder = { stations: null, mining: null, production: null, construction: null, logistics: null,
    views: createViewRegistry() };
  const fr = startFleets({ config, persistence, clock: shared.clock, ids: shared.ids, scheduler: sr.scheduler,
    graph: graphService, presence: null, views: createViewRegistry(), getStations: () => holder.stations });
  assert.ok(fr.ok, JSON.stringify(fr));
  const lines = [];
  const startAi = () => {
    const st = startStrategy({ config, persistence, clock: shared.clock, graph: graphService,
      world: extra.world || fakeWorld(shared.controllers),
      scheduler: extra.wrapScheduler ? extra.wrapScheduler(sr.scheduler) : sr.scheduler, fleets: fr.fleets,
      getOccupation: extra.occupation ? () => extra.occupation : undefined,
      getStations: () => holder.stations, views: extra.strategyViews || createViewRegistry(),
      logger: { log: (l) => lines.push(l) },
      getTreasury: extra.treasury ? () => holder.treasury : undefined,
      hooks: extra.hooks, getMining: extra.mining ? () => holder.mining : undefined,
      telemetry: extra.telemetry,
      getProduction: extra.production ? () => holder.production : undefined,
      getConstruction: extra.construction ? () => holder.construction : undefined,
      getLogistics: extra.logistics ? () => holder.logistics : undefined,
      getTrade: extra.getTrade || (extra.trade ? () => holder.trade : undefined), getSiege: extra.getSiege, getHunt: extra.getHunt,
      getBlockade: extra.getBlockade,
      getPlayerSovSiege: extra.getPlayerSovSiege,
      getTransit: extra.getTransit,
      beachheadsOf: extra.beachheadsOf,
      getDevIndices: extra.getDevIndices });
    assert.ok(st.ok, JSON.stringify(st));
    return st.strategy;
  };
  const strategy = startAi();
  await strategy.whenReady();
  const stR = startStations({ config, persistence, strategy, graph: graphService, clock: shared.clock,
    views: createViewRegistry() });
  assert.ok(stR.ok, JSON.stringify(stR));
  holder.stations = stR.stations;
  await stR.stations.whenReady();
  if (extra.mining) {
    const mr = startMining({ config, persistence, clock: shared.clock, ids: shared.ids, scheduler: sr.scheduler,
      fleets: fr.fleets, world: fakeWorld(shared.controllers), strategy, graph: graphService,
      getStations: () => holder.stations, adapter: { readSystemBelts: (list) => ({ ok: true,
        counts: new Map(list.map((id) => [id, 4])) }) } });
    assert.ok(mr.ok, JSON.stringify(mr));
    holder.mining = mr.mining;
    await Promise.resolve();
    await Promise.resolve();
  }
  if (extra.production) {
    const pr = startProduction({ config, persistence, clock: shared.clock, ids: shared.ids, scheduler: sr.scheduler,
      strategy, getStations: () => holder.stations });
    assert.ok(pr.ok, JSON.stringify(pr));
    holder.production = pr.production;
  }
  if (extra.construction) {
    const cr = startConstruction({ config, persistence, clock: shared.clock, ids: shared.ids,
      scheduler: sr.scheduler, world: extra.world || fakeWorld(shared.controllers), strategy,
      getStations: () => holder.stations, views: holder.views, kitsData: extra.kitsData });
    assert.ok(cr.ok, JSON.stringify(cr));
    holder.construction = cr.construction;
  }
  if (extra.logistics) {
    const lr = startLogistics({ config, persistence, clock: shared.clock, ids: shared.ids, scheduler: sr.scheduler,
      fleets: fr.fleets, strategy, getStations: () => holder.stations, getConstruction: () => holder.construction,
      views: holder.views });
    assert.ok(lr.ok, JSON.stringify(lr));
    holder.logistics = lr.logistics;
  }
  if (extra.trade) {
    const tr = startTrade({ config, persistence, clock: shared.clock, ids: shared.ids, views: holder.views });
    assert.ok(tr.ok, JSON.stringify(tr));
    holder.trade = tr.trade;
  }
  if (extra.treasury) {
    const ty = startTreasury({ config, persistence, clock: shared.clock, getTrade: () => holder.trade || null });
    assert.ok(ty.ok, JSON.stringify(ty));
    holder.treasury = ty.treasury;
  }
  const tx = (fn) => {
    const r = opened.store.transaction("test", fn);
    assert.ok(r.ok, JSON.stringify(r));
    return r.value;
  };
  const q = (sql, ...args) => tx((db) => db.prepare(sql).all(...args));
  return { config, scheduler: sr.scheduler, fleets: fr.fleets, stations: stR.stations, strategy, startAi, tx, q, lines,
    journal, mining: holder.mining, production: holder.production, construction: holder.construction,
    logistics: holder.logistics, trade: holder.trade || null, views: holder.views, treasury: holder.treasury || null };
}

async function passesAt(env, shared, at) {
  shared.clock.set(at);
  for (let i = 0; i < 20; i += 1) {
    const p = await env.scheduler.runPass();
    assert.ok(p.ok, JSON.stringify(p));
    if (!p.jobs) return;
  }
}

async function driveUntil(env, shared, until, stepMs, done) {
  for (let t = shared.clock.now() + stepMs; t <= until; t += stepMs) {
    await passesAt(env, shared, t);
    if (done && done()) return true;
  }
  return false;
}

const reviews = (env, factionId, state) => env.q(`SELECT idempotency_key AS k, state, due_at AS due, payload
  FROM world_scheduled_events WHERE event_type = ? AND aggregate_id = ?${state ? " AND state = ?" : ""}
  ORDER BY due_at`, REVIEW, String(factionId), ...(state ? [state] : []));
const factionRow = (env, id) => env.q("SELECT * FROM world_factions WHERE faction_id = ?", id)[0];
const fleetsOf = (env, id) => env.q("SELECT * FROM virtual_fleets WHERE faction_id = ? ORDER BY created_at, fleet_id",
  id);
const opsOf = (env, id) => env.q("SELECT * FROM world_operations WHERE faction_id = ? ORDER BY planned_at, operation_id",
  id);

function upkeepWorld(controllers, captured) {
  const base = fakeWorld(controllers).repository;
  const rowOf = (id) => ({ systemId: id, controllerFactionId: controllers.get(id), occupationState: "STABLE",
    capturedAt: 1, detachedSinceAt: captured.get(id), phaseDueAt: null });
  return { repository: { ...base,
    listByOccupier: () => ({ ok: true, systems: [] }),
    countControlledByFaction: (tx, f) => ({ ok: true, count: [...controllers.values()].filter((c) => c === f).length }),
    listControlledByFaction: (tx, f, opts) => ({ ok: true, systems: [...captured.keys()].sort((a, b) => a - b)
      .filter((id) => controllers.get(id) === f).slice(0, opts.limit).map(rowOf) }) } };
}

module.exports = ({ test, skip }) => {
  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  test("F1a corporations (pure): corporationFor = corporationRoles[role]?? owner, bad role / foreign "
    + "corporation -> REGISTRY_INVALID with the path; a fleet with corporation_id NULL shows the main corporation",
  () => {
    const CTX = { hullGroups: HULL_GROUPS, fleetRoles: FLEET_ROLES, operationTypes: OPERATION_TYPES,
      hostility: createHostility(), maxFactions: 64, maxCampaignSystems: 40, maxShipsPerFleet: 500,
      maxCompositionEntries: 32, maxResourceUnits: 1000000000 };
    const built = createFactionRegistry(REGISTRY_DATA_V1, CTX);
    assert.ok(built.ok, JSON.stringify(built));
    const reg = built.registry;
    const amarr = reg.getFaction(AMARR);
    assert.deepStrictEqual(amarr.corporationRoles, { mining: 1000063 });
    assert.deepStrictEqual([reg.corporationFor(AMARR, "mining"), reg.corporationFor(AMARR, "patrol"),
      reg.corporationFor(AMARR, "logistics"), reg.corporationFor(AMARR, "station"), reg.corporationFor(SANSHA, "mining"),
      reg.corporationFor(999, "patrol")], [1000063, amarr.ownerCorporationId, amarr.ownerCorporationId,
      amarr.ownerCorporationId, reg.getFaction(SANSHA).ownerCorporationId, null]);
    assert.strictEqual(reg.getCorporation(1000063).factionId, AMARR);
    const at = REGISTRY_DATA_V1.factions.findIndex((f) => f.factionId === AMARR);
    const clone = (v) => JSON.parse(JSON.stringify(v));
    const badRole = clone(REGISTRY_DATA_V1);
    badRole.factions[at].corporationRoles = { wizard: 1000063 };
    const foreign = clone(REGISTRY_DATA_V1);
    foreign.factions[at].corporationRoles = { mining: reg.getFaction(SANSHA).ownerCorporationId };
    for (const [data, detail] of [[badRole, `factions[${at}].corporationRoles.wizard`],
      [foreign, `factions[${at}].corporationRoles.mining`]]) {
      assert.deepStrictEqual(createFactionRegistry(data, CTX), { ok: false, reason: "REGISTRY_INVALID", detail });
    }
    const old = { factionId: AMARR, corporationId: null, fleetRole: "patrol" };
    assert.deepStrictEqual(corporationOf(old, reg), { id: amarr.ownerCorporationId,
      name: reg.getCorporation(amarr.ownerCorporationId).name });
    assert.deepStrictEqual(corporationOf({ ...old, fleetRole: "mining" }, reg), { id: 1000063,
      name: "Amarr Constructions" });
    assert.deepStrictEqual(corporationOf({ ...old, corporationId: 1000066 }, null), { id: 1000066, name: null });
    assert.strictEqual(corporationOf(old, null), null);
    const fleet = { fleetId: "f-1", factionId: AMARR, corporationId: null, fleetRole: "patrol", state: "TRAVELLING",
      route: null, targetSystemId: SAMINER };
    const page = { ok: true, fleets: [fleet] };
    const view = buildFleetsView({ store: { isOpen: () => true, transaction: (n, fn) => ({ ok: true, value: fn({}) }) },
      repository: { countByState: () => ({ ok: true, counts: {}, active: 1 }),
        countOperationsByState: () => ({ ok: true, counts: {} }), countOverdueInFlight: () => ({ ok: true, count: 0 }),
        listFleetsByState: () => page }, clock: { now: () => START_MS }, getStatus: () => ({}),
      getRegistry: () => reg, rows: 1, refreshMs: 60000, limit: 1000, catchUpLagMs: 0 });
    assert.deepStrictEqual(view.getData().inFlight[0].corporation, { id: amarr.ownerCorporationId,
      name: reg.getCorporation(amarr.ownerCorporationId).name });
    assert.strictEqual(fleet.corporationId, null, "read only");
  });

  needsDriver("T4 review: bootstrap -> mobilized scout + recon in reach, restart duplicates, intel -> invasion "
    + "downtime -> one run", () => H.withStore(driver, async (reopen) => {
    const clock = createManualClock(START_MS);
    const shared = { clock, ids: createIdGenerator({ clock, rng: createRng(7) }), graph: graphOf(),
      controllers: new Map(THEATRE.map((id) => [id, SANSHA])) };
    const ENV = { EVEJS_LNE_STRATEGY_TARGET_PICK_TOP_K: "1", EVEJS_LNE_STRATEGY_MAX_REVIEWS_PER_PASS: "8",
      EVEJS_LNE_MAX_ACTIVE_FRONTS_PER_FACTION: "1",
      EVEJS_LNE_STRATEGY_CAPTURE_REQUIRES_ADJACENCY: "0" };
    let police = null;
    const hooks = { beforeEffect: (d, s) => {
      if (police === null && d.factionId === CONCORD) police = { d, s };
      return d;
    } };
    const opened = reopen();
    const env = await bootAll(opened, shared, ENV, { hooks });
    assert.strictEqual(env.strategy.getStatus().ai.state, "on");
    assert.deepStrictEqual(env.strategy.getStatus().ai.review.bootstrap, { enqueued: 4, duplicates: 0, reason: null });
    for (const f of [AMARR, CONCORD, SANSHA, SERPENTIS]) assert.strictEqual(reviews(env, f, "QUEUED").length, 1);
    const reserve0 = factionRow(env, AMARR).reserve_units;

    const t1 = START_MS + I;
    await passesAt(env, shared, t1);
    const scouts = fleetsOf(env, AMARR);
    assert.deepStrictEqual(scouts.map((f) => [f.fleet_role, f.home_system_id, f.state]),
      [["scout", SAMINER, "TRAVELLING"]]);
    assert.deepStrictEqual(scouts.map((f) => f.corporation_id), [env.strategy.registry.getFaction(AMARR)
      .ownerCorporationId]);
    assert.strictEqual(factionRow(env, AMARR).reserve_units, reserve0 - 1, "one scout paid once");
    const recon = opsOf(env, AMARR);
    assert.deepStrictEqual(recon.map((o) => [o.operation_type, o.target_system_id, o.state]),
      [["recon", A_DZA8, "ACTIVE"]]);
    assert.strictEqual(env.q("SELECT state FROM world_scheduled_events WHERE idempotency_key = ?",
      `arrival:${scouts[0].fleet_id}:1`)[0].state, "QUEUED");
    const open = reviews(env, AMARR, "QUEUED");
    assert.strictEqual(open.length, 1);
    assert.ok(open[0].due > t1 && open[0].due <= t1 + I, "successor b+1");
    assert.ok(env.lines.some((l) => l.startsWith(`strategy: ${AMARR} r`) && l.includes(`launch recon -> ${A_DZA8}`)),
      env.lines.join("\n"));
    assert.ok(police !== null, "a CONCORD round ran");
    assert.deepStrictEqual([police.s.doctrine.confinedToBelt, police.s.doctrine.hullsRequired, police.s.border.mode, police.d.outcome, police.d.reason],
      [true, false, "ready", "REVIEWED", null]);
    for (const l of police.d.intents.filter((i) => i.type === "LAUNCH" && i.kind !== "return")) {
      assert.ok(police.s.border.reach.has(l.target.systemId), JSON.stringify(l.target));
    }
    assert.deepStrictEqual(env.q(`SELECT outcome FROM world_scheduled_events WHERE event_type = ? AND aggregate_id = ?
      AND state = 'DONE'`, REVIEW, String(CONCORD)).map((r) => r.outcome), ["REVIEWED"]);

    env.strategy.stop("restart");
    const again = env.startAi();
    await again.whenReady();
    assert.deepStrictEqual(again.getStatus().ai.review.bootstrap, { enqueued: 0, duplicates: 4, reason: null });
    for (const f of [AMARR, CONCORD, SANSHA, SERPENTIS]) assert.strictEqual(reviews(env, f, "QUEUED").length, 1);

    const invaded = await driveUntil(env, shared, t1 + 12 * 3600000, 300000,
      () => opsOf(env, AMARR).some((o) => o.operation_type === "invasion"));
    assert.ok(invaded, JSON.stringify(opsOf(env, AMARR)));
    const intel = env.q("SELECT * FROM world_faction_intel WHERE faction_id = ?", AMARR);
    assert.deepStrictEqual(intel.map((r) => [r.system_id, r.hostile_strength, r.source]), [[A_DZA8, 0, "fleet"]]);
    const inv = opsOf(env, AMARR).find((o) => o.operation_type === "invasion");
    assert.deepStrictEqual([inv.target_system_id, inv.state], [A_DZA8, "ACTIVE"]);
    assert.ok(fleetsOf(env, AMARR).some((f) => f.fleet_role === "invasion" && f.home_system_id === SAMINER));

    const doneBefore = reviews(env, AMARR, "DONE").length;
    const down = shared.clock.now() + 10 * I;
    await passesAt(env, shared, down);
    assert.strictEqual(reviews(env, AMARR, "DONE").length, doneBefore + 1);
    const after = reviews(env, AMARR, "QUEUED");
    assert.strictEqual(after.length, 1);
    assert.ok(after[0].due > down && after[0].due <= down + I, `${after[0].due} vs ${down}`);
    again.stop("test");
  }));

  needsDriver("RCH1 restart after a downtime > I: the overdue round of the old chain + the bootstrap round "
    + "-> periodicChainsDoubled 0, converging 4 (old rule 4); the first pass merges them by the duplicate key",
  () => H.withStore(driver, async (reopen) => {
    const { periodicChainCounts } = require("../../tools/campaign/checks");
    const clock = createManualClock(START_MS);
    const shared = { clock, ids: createIdGenerator({ clock, rng: createRng(11) }), graph: graphOf(),
      controllers: new Map(THEATRE.map((id) => [id, SANSHA])) };
    const ENV = { EVEJS_LNE_STRATEGY_TARGET_PICK_TOP_K: "1", EVEJS_LNE_STRATEGY_MAX_REVIEWS_PER_PASS: "8",
      EVEJS_LNE_MAX_ACTIVE_FRONTS_PER_FACTION: "1", EVEJS_LNE_STRATEGY_CAPTURE_REQUIRES_ADJACENCY: "0",
      EVEJS_LNE_STRATEGY_REACTIVE_ENABLED: "0" };
    const FACTIONS = [AMARR, CONCORD, SANSHA, SERPENTIS];
    const opened = reopen();
    const env = await bootAll(opened, shared, ENV);
    const counts = (now) => {
      const r = opened.store.transaction("rc1", (db) => periodicChainCounts(db, now, []));
      assert.ok(r.ok, JSON.stringify(r));
      return r.value;
    };
    await passesAt(env, shared, START_MS + I);
    for (const f of FACTIONS) assert.strictEqual(reviews(env, f, "QUEUED").length, 1);

    const now = START_MS + 6 * I;
    shared.clock.set(now);
    env.strategy.stop("restart");
    const again = env.startAi();
    await again.whenReady();
    assert.deepStrictEqual(again.getStatus().ai.review.bootstrap, { enqueued: 4, duplicates: 0, reason: null });
    const bootKey = new Map();
    const doneBefore = new Map();
    for (const f of FACTIONS) {
      const open = reviews(env, f, "QUEUED");
      assert.strictEqual(open.length, 2, JSON.stringify(open));
      assert.ok(open[0].due <= now && open[1].due > now, JSON.stringify(open));
      bootKey.set(f, open[1].k);
      doneBefore.set(f, reviews(env, f, "DONE").length);
    }
    assert.deepStrictEqual(counts(now), { doubled: 0, converging: 4 });
    assert.deepStrictEqual(counts(null), { doubled: 4, converging: 0 });

    await passesAt(env, shared, now);
    for (const f of FACTIONS) {
      const open = reviews(env, f, "QUEUED");
      assert.deepStrictEqual(open.map((r) => r.k), [bootKey.get(f)], `${f} ${JSON.stringify(open)}`);
      assert.strictEqual(reviews(env, f, "DONE").length, doneBefore.get(f) + 1, String(f));
    }
    assert.deepStrictEqual(counts(now), { doubled: 0, converging: 0 });
    again.stop("test");
  }));

  needsDriver("R2 active set: only Sansha active -> 1 row, stations of Sansha only, 1 review queued "
    + "restart with none -> its row stays (not an orphan), its review SKIPPED INACTIVE without a successor",
  () => H.withStore(driver, async (reopen) => {
    const clock = createManualClock(START_MS);
    const shared = { clock, ids: createIdGenerator({ clock, rng: createRng(11) }), graph: graphOf(),
      controllers: new Map(THEATRE.map((id) => [id, SANSHA])) };
    const opened = reopen();
    const env = await bootAll(opened, shared, { EVEJS_LNE_STRATEGY_ACTIVE_FACTIONS: String(SANSHA) });
    const st = env.strategy.getStatus();
    assert.deepStrictEqual([st.state, st.activeFactions, st.seed.created], ["running", [SANSHA], 1]);
    assert.deepStrictEqual(env.q("SELECT faction_id FROM world_factions").map((r) => r.faction_id), [SANSHA]);
    const owners = env.q("SELECT DISTINCT owner_faction_id AS f FROM world_stations").map((r) => r.f);
    assert.deepStrictEqual(owners, [SANSHA]);
    assert.deepStrictEqual(st.ai.review.bootstrap, { enqueued: 1, duplicates: 0, reason: null });
    assert.strictEqual(reviews(env, SANSHA, "QUEUED").length, 1);
    assert.strictEqual(reviews(env, AMARR).length, 0);
    assert.strictEqual(env.strategy.getCampaign("k3-stain").reason, "CAMPAIGN_FACTION_INACTIVE");

    env.strategy.stop("restart");
    const graphService = { whenReady: () => Promise.resolve({ ok: true, graph: shared.graph }),
      getGraph: () => ({ ok: true, graph: shared.graph }) };
    const r2 = startStrategy({ config: configOf({ EVEJS_LNE_STRATEGY_ACTIVE_FACTIONS: "none" }),
      persistence: { ok: true, store: opened.store, journal: env.journal, worldSeed: opened.worldSeed },
      clock: shared.clock, graph: graphService, world: fakeWorld(shared.controllers), scheduler: env.scheduler,
      fleets: env.fleets, getStations: () => env.stations, views: createViewRegistry(), logger: { log() {} } });
    assert.ok(r2.ok, JSON.stringify(r2));
    const st2 = await r2.strategy.whenReady();
    assert.deepStrictEqual([st2.activeFactions, st2.seed.created, st2.seed.existing, st2.seed.orphans],
      [[], 0, 0, 0]);
    assert.deepStrictEqual(st2.ai.review.bootstrap, { enqueued: 0, duplicates: 0, reason: null });
    await passesAt(env, shared, START_MS + I);
    assert.deepStrictEqual(env.q(`SELECT state, outcome FROM world_scheduled_events WHERE event_type = ?
      AND aggregate_id = ?`, REVIEW, String(SANSHA)), [{ state: "DONE", outcome: "SKIPPED" }]);
    assert.strictEqual(r2.strategy.getStatus().ai.review.counters.inactive, 1);
    assert.deepStrictEqual(env.q("SELECT faction_id FROM world_factions").map((r) => r.faction_id), [SANSHA]);
    r2.strategy.stop("test");
  }));

  needsDriver("D2 d 7 active (the list): seed of 7 world_factions rows + 27 start stations, 7 reviews "
    + "bootstrapped; upgrade to the registry (10 active): +3 rows, +15 stations, +3 reviews, the rest "
    + "duplicates; restart = duplicates only; the restore list -> the 4 factions of", () =>
    H.withStore(driver, async (reopen) => {
      const clock = createManualClock(START_MS);
      const extra = [[30001290, 10000015, 20000188], [30001291, 10000015, 20000188], [30001269, 10000015, 20000185],
        [30001045, 10000012, 20000153], [30001047, 10000012, 20000153], [30001044, 10000012, 20000153],
        [30001048, 10000012, 20000153], [30004709, 10000060, 20000688], [30004707, 10000060, 20000688],
        [30004706, 10000060, 20000688], [30004708, 10000060, 20000688], [30004518, 10000057, 20000659]]
        .map(([id, region, constellation]) => system(id, region, constellation, "nullsec"));
      extra.push(...[[30045307, 10000069, 20000781, "lowsec", 500001], [30001447, 10000016, 20000212, "lowsec", 500001],
        [30001429, 10000016, 20000209, "highsec", 500001], [30000205, 10000002, 20000029, "lowsec", 500001],
        [30000200, 10000002, 20000028, "lowsec", 500001], [30002420, 10000028, 20000355, "lowsec", 500002],
        [30003466, 10000042, 20000505, "lowsec", 500002], [30002086, 10000042, 20000307, "lowsec", 500002],
        [30003471, 10000042, 20000506, "lowsec", 500002], [30002419, 10000028, 20000355, "lowsec", 500002],
        [30003820, 10000048, 20000558, "lowsec", 500004], [30003830, 10000048, 20000560, "highsec", 500004],
        [30005328, 10000068, 20000779, "lowsec", 500004], [30003573, 10000044, 20000521, "lowsec", 500004],
        [30003793, 10000048, 20000553, "lowsec", 500004]]
        .map(([id, region, constellation, secClass, f]) => system(id, region, constellation, secClass, f)));
      const shared = { clock, ids: createIdGenerator({ clock, rng: createRng(13) }), graph: graphOf({ extra }),
        controllers: new Map(THEATRE.map((id) => [id, SANSHA])) };
      const ALL = [AMARR, CONCORD, 500010, 500011, 500012, SANSHA, SERPENTIS];
      const opened = reopen();
      const SEVEN = { EVEJS_LNE_STRATEGY_ACTIVE_FACTIONS: ALL.join(",") };
      const REGISTRY = { EVEJS_LNE_STRATEGY_ACTIVE_FACTIONS: "registry" };
      const env = await bootAll(opened, shared, SEVEN);
      const st = env.strategy.getStatus();
      assert.deepStrictEqual([st.state, st.activeFactions, st.seed.created], ["running", ALL, 7]);
      assert.deepStrictEqual(env.q("SELECT faction_id FROM world_factions ORDER BY faction_id")
        .map((r) => r.faction_id), ALL);
      const perFaction = () => env.q("SELECT owner_faction_id AS f, count(*) AS n FROM world_stations "
        + "GROUP BY owner_faction_id ORDER BY owner_faction_id").map((r) => [r.f, r.n]);
      assert.deepStrictEqual(perFaction(), [[AMARR, 5], [CONCORD, 1], [500010, 5], [500011, 5], [500012, 5],
        [SANSHA, 5], [SERPENTIS, 1]]);
      const keys = (prefix) => env.q("SELECT count(*) AS n FROM world_event_journal WHERE idempotency_key LIKE ?",
        `${prefix}%`)[0].n;
      assert.deepStrictEqual([keys("strategy:faction:seed:v1:"), keys("stations:seed:v1:")], [7, 27]);
      assert.deepStrictEqual(st.ai.review.bootstrap, { enqueued: 7, duplicates: 0, reason: null });
      for (const f of ALL) assert.strictEqual(reviews(env, f, "QUEUED").length, 1, String(f));
      const graphService = { whenReady: () => Promise.resolve({ ok: true, graph: shared.graph }),
        getGraph: () => ({ ok: true, graph: shared.graph }) };
      const persistence = { ok: true, store: opened.store, journal: env.journal, worldSeed: opened.worldSeed };
      const restart = async (activeEnv) => {
        const config = configOf(activeEnv);
        const r = startStrategy({ config, persistence, clock, graph: graphService, world: fakeWorld(shared.controllers),
          scheduler: env.scheduler, fleets: env.fleets, getStations: () => null, views: createViewRegistry(),
          logger: { log() {} } });
        assert.ok(r.ok, JSON.stringify(r));
        const status = await r.strategy.whenReady();
        const stR = startStations({ config, persistence, strategy: r.strategy, graph: graphService, clock,
          views: createViewRegistry() });
        assert.ok(stR.ok, JSON.stringify(stR));
        await stR.stations.whenReady();
        const seed = stR.stations.getStatus().seed;
        stR.stations.stop("test");
        r.strategy.stop("restart");
        return { status, stations: [seed.created, seed.existing] };
      };
      env.strategy.stop("restart");
      env.stations.stop("restart");

      const INVADERS = [500021, 500026, 500029];
      const ALL13 = [500001, 500002, AMARR, 500004, CONCORD, 500010, 500011, 500012, 500016, SANSHA, SERPENTIS,
        ...INVADERS];
      const up = await restart(REGISTRY);
      assert.deepStrictEqual([up.status.activeFactions, up.status.seed.created, up.status.seed.existing],
        [ALL13, 7, 7]);
      assert.deepStrictEqual(up.status.ai.review.bootstrap, { enqueued: 7, duplicates: 7, reason: null });
      assert.deepStrictEqual(up.stations, [15, 27]);
      assert.deepStrictEqual(env.q("SELECT faction_id FROM world_factions ORDER BY faction_id")
        .map((r) => r.faction_id), ALL13);
      assert.deepStrictEqual(perFaction(), [[500001, 5], [500002, 5], [AMARR, 5], [500004, 5], [CONCORD, 1],
        [500010, 5], [500011, 5], [500012, 5], [SANSHA, 5], [SERPENTIS, 1]]);
      assert.deepStrictEqual([keys("strategy:faction:seed:v1:"), keys("stations:seed:v1:")], [14, 42]);
      for (const f of ALL13) assert.strictEqual(reviews(env, f, "QUEUED").length, 1, String(f));
      const journal = env.q("SELECT count(*) AS n FROM world_event_journal")[0].n;

      const again = await restart(REGISTRY);
      assert.deepStrictEqual([again.status.seed.created, again.status.seed.existing], [0, 14]);
      assert.deepStrictEqual(again.status.ai.review.bootstrap, { enqueued: 0, duplicates: 14, reason: null });
      assert.deepStrictEqual(again.stations, [0, 42]);
      assert.strictEqual(env.q("SELECT count(*) AS n FROM world_event_journal")[0].n, journal);

      const r4 = startStrategy({ config: configOf({ EVEJS_LNE_STRATEGY_ACTIVE_FACTIONS: K3_FACTIONS }),
        persistence, clock, graph: graphService, world: fakeWorld(shared.controllers), scheduler: env.scheduler,
        fleets: env.fleets, getStations: () => null, views: createViewRegistry(), logger: { log() {} } });
      assert.ok(r4.ok, JSON.stringify(r4));
      const st4 = await r4.strategy.whenReady();
      assert.deepStrictEqual([st4.activeFactions, st4.seed.existing], [[AMARR, CONCORD, SANSHA, SERPENTIS], 4]);
      r4.strategy.stop("test");
    }));

  needsDriver("T5 housekeeping: PLANNED empty -> CANCELLED, ACTIVE orphan -> FAILED, stranded -> RETREATING "
    + "no station -> nothing; one refused intent keeps the others", () => H.withStore(driver, async (reopen) => {
    const clock = createManualClock(START_MS);
    const shared = { clock, ids: createIdGenerator({ clock, rng: createRng(9) }), graph: graphOf(),
      controllers: new Map(THEATRE.map((id) => [id, SANSHA])) };
    let inject = true;
    const hooks = { beforeEffect: (d) => {
      if (!inject || d.factionId !== SERPENTIS) return d;
      inject = false;
      return { ...d, intents: d.intents.map((i) => (i.type === "CLOSE_OPERATION" && i.from === "PLANNED"
        ? { ...i, expectedVersion: i.expectedVersion + 5 } : i)) };
    } };
    const env = await bootAll(reopen(), shared, { EVEJS_LNE_STRATEGY_CAMPAIGNS: "none",
      EVEJS_LNE_STRATEGY_OPERATION_GRACE_MS: "0", EVEJS_LNE_STRATEGY_MAX_REVIEWS_PER_PASS: "8" }, { hooks });
    const f = env.fleets;
    const mk = (tag) => {
      const r = f.createFleet({ factionId: SERPENTIS, currentSystemId: 30001949, homeSystemId: 30001949,
        fleetRole: "patrol", composition: [{ hullGroup: "frigate", count: 2 }] }, `t5:${tag}`);
      assert.ok(r.ok, JSON.stringify(r));
      return r.fleetId;
    };
    const ok = (r) => {
      assert.ok(r && r.ok, JSON.stringify(r));
      return r;
    };
    const f1 = mk("f1");
    const op1 = ok(f.createOperation({ operationType: "patrol", factionId: SERPENTIS, originSystemId: 30001949,
      targetSystemId: 30001950, objective: "patrol", dueAt: START_MS, fleets: [{ fleetId: f1, expectedVersion: 1 }] },
    "t5:op1")).operationId;
    ok(f.transition({ fleetId: f1, expectedVersion: 2, from: "PLANNED", to: "IDLE" }, "t5:f1:idle"));
    const f2 = mk("f2");
    const op2 = ok(f.createOperation({ operationType: "patrol", factionId: SERPENTIS, originSystemId: 30001949,
      targetSystemId: 30001950, objective: "patrol", dueAt: START_MS, fleets: [{ fleetId: f2, expectedVersion: 1 }] },
    "t5:op2")).operationId;
    const plan = ok(f.planTravel({ fleetId: f2, targetSystemId: 30001950 }, "t5:f2:go"));
    ok(f.transition({ fleetId: f2, expectedVersion: plan.version, from: "TRAVELLING", to: "STAGED",
      patch: { currentSystemId: 30001950, route: null, routeGraphVersion: null, nextActionAt: null } }, "t5:f2:st"));
    ok(f.transition({ fleetId: f2, expectedVersion: plan.version + 1, from: "STAGED", to: "IDLE" }, "t5:f2:idle"));
    const f3 = mk("f3");
    env.tx((db) => db.prepare("UPDATE virtual_fleets SET refit_pending = 1 WHERE fleet_id = ?").run(f3));
    const opState = (id) => env.q("SELECT state, result_json FROM world_operations WHERE operation_id = ?", id)[0];

    await passesAt(env, shared, START_MS + I);
    assert.strictEqual(opState(op1).state, "PLANNED", "refused intent rolled back alone");
    assert.deepStrictEqual([opState(op2).state, JSON.parse(opState(op2).result_json)],
      ["FAILED", { closedBy: "strategy", reason: "NO_ORDERED_MEMBERS" }]);
    const f3row = () => env.q("SELECT state, version, refit_pending FROM virtual_fleets WHERE fleet_id = ?", f3)[0];
    assert.deepStrictEqual([f3row().state, f3row().refit_pending], ["IDLE", 1]);
    const st = env.strategy.getStatus().ai.review;
    assert.ok(st.counters.intentRefused >= 1 && /CLOSE_OPERATION:VERSION_CONFLICT/.test(st.lastRefusal),
      JSON.stringify(st));
    assert.strictEqual(reviews(env, SERPENTIS, "QUEUED").length, 1, "successor despite the refusal");
    assert.ok(factionRow(env, SERPENTIS).last_review_at !== null, "touch applied");

    const created = env.tx((db) => env.stations.repository.createStation(db, { stationId: "t5-st", kind: "upwell",
      typeId: 35832, structureFamily: "astrahus", systemId: 30001950, ownerFactionId: SERPENTIS,
      ownerCorporationId: 1000135, origin: "built", at: shared.clock.now() }, "t5:station"));
    assert.ok(created.ok, JSON.stringify(created));
    await passesAt(env, shared, START_MS + 2 * I);
    assert.deepStrictEqual([opState(op1).state, JSON.parse(opState(op1).result_json)],
      ["CANCELLED", { closedBy: "strategy", reason: "NO_MEMBERS" }]);
    assert.strictEqual(f3row().state, "RETREATING");
    env.strategy.stop("test");
  }));

  needsDriver("M6 review + mining: a review mobilizes a miner (role mining, 3 mining frigates), the next one dispatches it "
    + "(MINE_DISPATCH -> one trip), counters after the commit", () => H.withStore(driver, async (reopen) => {
    const clock = createManualClock(START_MS);
    const shared = { clock, ids: createIdGenerator({ clock, rng: createRng(7) }), graph: graphOf(),
      controllers: new Map(THEATRE.map((id) => [id, SANSHA])) };
    let sanshaEffect = null;
    const wrapScheduler = (sch) => ({ ...sch, registerHandler: (type, h, o) => sch.registerHandler(type, (ev, hctx) => {
      const r = h(ev, hctx);
      if (type === REVIEW && r && r.effect && ev.payload.factionId === SANSHA && sanshaEffect === null) {
        sanshaEffect = r.effect;
      }
      return r;
    }, o) });
    const env = await bootAll(reopen(), shared, { EVEJS_LNE_STRATEGY_MAX_REVIEWS_PER_PASS: "8",
      EVEJS_LNE_MINING_MAX_MOBILIZATIONS_PER_REVIEW: "1" }, { mining: true, wrapScheduler });
    assert.strictEqual(env.mining.getMode(), "ready");
    await passesAt(env, shared, START_MS + I);
    const miners = () => fleetsOf(env, SANSHA).filter((x) => x.fleet_role === "mining");
    assert.strictEqual(miners().length, 1, JSON.stringify(fleetsOf(env, SANSHA).map((x) => x.fleet_role)));
    assert.deepStrictEqual(JSON.parse(miners()[0].composition_json), [{ count: 3, hullGroup: "mining_frigate",
      typeId: null }]);
    const reg = env.strategy.registry;
    assert.strictEqual(miners()[0].corporation_id, reg.getFaction(SANSHA).ownerCorporationId);
    for (const f of env.q("SELECT faction_id, fleet_role, corporation_id FROM virtual_fleets")) {
      assert.strictEqual(f.corporation_id, reg.corporationFor(f.faction_id, f.fleet_role), JSON.stringify(f));
      if (f.faction_id === AMARR && f.fleet_role === "mining") assert.strictEqual(f.corporation_id, 1000063);
    }
    assert.ok(typeof sanshaEffect === "function", "the round effect of Sansha was captured");
    const replay = env.tx((db) => sanshaEffect(db));
    assert.ok(replay.ok, JSON.stringify(replay));
    assert.strictEqual(miners().length, 1);
    await passesAt(env, shared, START_MS + 2 * I);
    const trips = env.q("SELECT faction_id, fleet_id, state FROM world_mining_trips");
    assert.strictEqual(trips.length, 1, JSON.stringify(trips));
    assert.deepStrictEqual([trips[0].faction_id, trips[0].fleet_id], [SANSHA, miners()[0].fleet_id]);
    assert.ok(["OUTBOUND", "MINING"].includes(trips[0].state), trips[0].state);
    const c = env.strategy.getStatus().ai.review.counters;
    assert.ok(c.minersMobilized >= 1 && c.mineDispatched === 1, JSON.stringify(c));
    assert.strictEqual(env.mining.getStatus().counters.dispatched, 1);
  }));

  needsDriver("TP3 hunt review: fieldsHunters + hunt service running -> MOBILIZE hunter in the station system "
    + "(no refusal, onCommitted counts 1), the next review sends it on a hunt patrol", () => H.withStore(driver,
    async (reopen) => {
      const clock = createManualClock(START_MS);
      const shared = { clock, ids: createIdGenerator({ clock, rng: createRng(7) }), graph: graphOf(),
        controllers: new Map(THEATRE.map((id) => [id, SANSHA])) };
      const decisions = [];
      const hooks = { beforeEffect: (d) => {
        decisions.push(d);
        return d;
      } };
      const env = await bootAll(reopen(), shared, { EVEJS_LNE_STRATEGY_ACTIVE_FACTIONS: String(SANSHA) },
        { hooks, getHunt: () => ({ getState: () => "running" }) });
      await passesAt(env, shared, START_MS + I);
      const hunters = () => fleetsOf(env, SANSHA).filter((x) => x.fleet_role === "hunter");
      assert.strictEqual(hunters().length, 1, JSON.stringify(fleetsOf(env, SANSHA).map((x) => x.fleet_role)));
      const mob = decisions[0].intents.find((i) => i.type === "MOBILIZE" && i.role === "hunter");
      assert.ok(mob && Number.isSafeInteger(mob.systemId) && typeof mob.stationId === "string", JSON.stringify(mob));
      const stationSystems = env.q("SELECT system_id FROM world_stations WHERE owner_faction_id = ?", SANSHA)
        .map((r) => r.system_id);
      assert.ok(stationSystems.includes(hunters()[0].current_system_id), JSON.stringify(stationSystems));
      const st1 = env.strategy.getStatus().ai.review;
      assert.ok(!/MOBILIZE/.test(st1.lastRefusal || ""), String(st1.lastRefusal));
      assert.strictEqual(st1.counters.huntersMobilized, 1, JSON.stringify(st1.counters));

      await passesAt(env, shared, START_MS + 2 * I);
      const st2 = env.strategy.getStatus().ai.review;
      assert.ok(!/LAUNCH/.test(st2.lastRefusal || ""), String(st2.lastRefusal));
      assert.strictEqual(st2.counters.hunterPatrolsLaunched, 1, JSON.stringify(st2.counters));
      const patrol = opsOf(env, SANSHA).filter((o) => o.operation_type === "patrol");
      assert.strictEqual(patrol.length, 1, JSON.stringify(opsOf(env, SANSHA)));
      assert.notStrictEqual(patrol[0].target_system_id, patrol[0].origin_system_id);
      env.strategy.stop("test");
    }));

  needsDriver("M7 review + mining: readMining has the gate of "
    + "miningService.controlOf - mining.ownSpaceScanSystems = 0 -> no CONCORD site without a world row and no "
    + "NOT_CONTROLLED refusal; 1 -> one system scanned (the config reaches the planner)", async () => {
    const PAYE = 30001718;
    const AMARR_HQ = 30002187;
    const run = (scan) => H.withStore(driver, async (reopen) => {
      const clock = createManualClock(START_MS);
      const shared = { clock, ids: createIdGenerator({ clock, rng: createRng(7) }), graph: graphOf(),
        controllers: new Map(THEATRE.map((id) => [id, SANSHA])) };
      const snaps = [];
      const hooks = { beforeEffect: (d, s) => {
        if (d.factionId === CONCORD) snaps.push(s);
        return d;
      } };
      const ENV = { EVEJS_LNE_STRATEGY_MAX_REVIEWS_PER_PASS: "8" };
      if (scan !== null) ENV.EVEJS_LNE_MINING_OWN_SPACE_SCAN_SYSTEMS = scan;
      const base = fakeWorld(shared.controllers).repository;
      const world = { repository: { ...base, getSystems: (tx, ids) => ({ ...base.getSystems(tx, ids),
        missing: ids.filter((id) => !shared.controllers.has(id)) }) } };
      const env = await bootAll(reopen(), shared, ENV, { mining: true, hooks, world });
      assert.strictEqual(env.mining.getMode(), "ready");
      const created = env.tx((db) => env.stations.repository.createStation(db, { stationId: "m7-st", kind: "upwell",
        typeId: 35832, structureFamily: "astrahus", systemId: AMARR_HQ, ownerFactionId: CONCORD,
        ownerCorporationId: env.strategy.registry.getFaction(CONCORD).ownerCorporationId, origin: "built",
        at: shared.clock.now() }, "m7:station"));
      assert.ok(created.ok, JSON.stringify(created));
      await passesAt(env, shared, START_MS + I);
      await passesAt(env, shared, START_MS + 2 * I);
      assert.ok(snaps.length >= 1, "a CONCORD round ran");
      const review = env.strategy.getStatus().ai.review;
      env.strategy.stop("test");
      return { projected: snaps[0].mining.sites.filter((x) => x.projected).map((x) => x.systemId),
        lastRefusal: review.lastRefusal, trips: env.q("SELECT state FROM world_mining_trips WHERE faction_id = ?",
          CONCORD) };
    });
    const all = await run(null);
    assert.deepStrictEqual(all.projected, [PAYE, AMARR_HQ], `default 256: both sources (${JSON.stringify(all)})`);
    assert.ok(all.trips.length >= 1, `default: the projection feeds the dispatch (${JSON.stringify(all)})`);
    const off = await run("0");
    assert.deepStrictEqual([off.projected, off.trips], [[], []], JSON.stringify(off));
    assert.ok(!/NOT_CONTROLLED/.test(String(off.lastRefusal)), JSON.stringify(off));
    const one = await run("1");
    assert.deepStrictEqual(one.projected, [PAYE], `the config limit reaches the planner (${JSON.stringify(one)})`);
  });

  needsDriver("PR5 review + hulls: the stock changed between the snapshot and the effect -> INSUFFICIENT_STOCK "
    + "(no fleet, no cost, hulls unchanged); hulls back -> the LAUNCH mobilizes and takes them in one intent; PRODUCE "
    + "through the effect starts a job", () => H.withStore(driver, async (reopen) => {
    const clock = createManualClock(START_MS);
    const shared = { clock, ids: createIdGenerator({ clock, rng: createRng(7) }), graph: graphOf(),
      controllers: new Map(THEATRE.map((id) => [id, SANSHA])) };
    const holder = { env: null, steal: true };
    const hullAt = (stationId) => (holder.env.q("SELECT quantity FROM world_station_stock WHERE station_id = ? AND "
      + "item_key = 'group:frigate'", stationId)[0] || { quantity: 0 }).quantity;
    const stock = (stationId, key, deltas) => holder.env.tx((db) => holder.env.stations.repository.applyStockChange(db,
      { stationId, key, reason: "TEST", at: clock.now(), deltas }));
    let station = null;
    const hooks = { beforeEffect: (d) => {
      if (d.factionId !== AMARR || !holder.steal) return d;
      holder.steal = false;
      assert.ok(stock(station, "pr5:steal", [{ itemKind: "hull", itemKey: "group:frigate", delta: -1 }]).ok);
      return d;
    } };
    const env = await bootAll(reopen(), shared, { EVEJS_LNE_STRATEGY_TARGET_PICK_TOP_K: "1",
      EVEJS_LNE_STRATEGY_MAX_REVIEWS_PER_PASS: "8", EVEJS_LNE_PRODUCTION_LINES_PER_UPWELL_STATION: "1" },
    { hooks, production: true });
    holder.env = env;
    assert.strictEqual(env.production.getMode(), "ready");
    station = env.q("SELECT station_id FROM world_stations WHERE owner_faction_id = ? AND state = 'ONLINE' "
      + "AND kind = 'upwell' ORDER BY station_id", AMARR)[0].station_id;
    const minerals = Object.entries(RECIPES.GROUPS.frigate.minerals).sort().map(([k, v]) => ({ itemKind: "mineral",
      itemKey: k, delta: v * 20 }));
    assert.ok(stock(station, "pr5:seed", [...minerals, { itemKind: "hull", itemKey: "group:frigate", delta: 1 }]).ok);
    const reserve0 = factionRow(env, AMARR).reserve_units;

    await passesAt(env, shared, START_MS + I);
    assert.deepStrictEqual([fleetsOf(env, AMARR).length, factionRow(env, AMARR).reserve_units, hullAt(station)],
      [0, reserve0, 0], "the LAUNCH rolled back as a whole");
    const st1 = env.strategy.getStatus().ai.review;
    assert.strictEqual(st1.lastRefusal, "LAUNCH:INSUFFICIENT_STOCK", JSON.stringify(st1));
    const jobs = env.q("SELECT faction_id, station_id, state FROM world_production_jobs");
    assert.deepStrictEqual(jobs.map((j) => [j.faction_id, j.station_id, j.state]), [[AMARR, station, "ACTIVE"]]);
    assert.strictEqual(st1.counters.produced, 1);
    assert.strictEqual(env.production.getStatus().counters.started, 1);

    assert.ok(stock(station, "pr5:back", [{ itemKind: "hull", itemKey: "group:frigate", delta: 1 }]).ok);
    await passesAt(env, shared, START_MS + 2 * I);
    const scouts = fleetsOf(env, AMARR);
    assert.deepStrictEqual(scouts.map((x) => [x.fleet_role, x.home_system_id]), [["scout", SAMINER]]);
    assert.deepStrictEqual([factionRow(env, AMARR).reserve_units, hullAt(station)], [reserve0 - 1, 0]);
    assert.strictEqual(env.strategy.getStatus().ai.review.counters.hullsTaken, 1);
    env.strategy.stop("test");
    env.production.stop("test");
  }));

  needsDriver("A3 BUILD_PLAN in the review effect -> exactly one build (SUPPLYING, its deadline), counters "
    + "after the commit; the replayed effect is a duplicate (no second build); panel construction",
  () => H.withStore(driver, async (reopen) => {
    const clock = createManualClock(START_MS);
    const shared = { clock, ids: createIdGenerator({ clock, rng: createRng(17) }), graph: graphOf(),
      controllers: new Map(THEATRE.map((id) => [id, SANSHA])) };
    const SITE = 30001955;
    const holder = { inject: true, mark: false, effect: null };
    const hooks = { beforeEffect: (d) => {
      if (!holder.inject || d.factionId !== SANSHA || d.outcome !== "REVIEWED") return d;
      holder.inject = false;
      holder.mark = true;
      return { ...d, intents: [{ type: "BUILD_PLAN", slot: 0, systemId: SITE, kitId: "astrahus" }, ...d.intents] };
    } };
    const wrapScheduler = (sch) => ({ ...sch, registerHandler: (type, h, o) => sch.registerHandler(type, (ev, hctx) => {
      const r = h(ev, hctx);
      if (r && r.effect && holder.mark) {
        holder.mark = false;
        holder.effect = r.effect;
      }
      return r;
    }, o) });
    const env = await bootAll(reopen(), shared, { EVEJS_LNE_STRATEGY_MAX_REVIEWS_PER_PASS: "8" },
      { hooks, wrapScheduler, construction: true });
    await passesAt(env, shared, START_MS + I);
    assert.ok(holder.effect, "the injected review ran");
    const builds = () => env.q("SELECT faction_id AS f, system_id AS s, state FROM world_station_builds");
    assert.deepStrictEqual(builds(), [{ f: SANSHA, s: SITE, state: "SUPPLYING" }]);
    assert.strictEqual(env.q("SELECT count(*) AS n FROM world_scheduled_events WHERE event_type = "
      + "'STATION_BUILD_STEP'")[0].n, 1);
    assert.strictEqual(env.strategy.getStatus().ai.review.counters.buildsPlanned, 1);
    assert.strictEqual(env.construction.getStatus().counters.planned, 1, "one build planned");
    const replay = env.tx((db) => holder.effect(db));
    assert.ok(replay.ok && replay.applied.BUILD_PLAN === undefined, JSON.stringify(replay));
    assert.strictEqual(builds().length, 1, "duplicate: no second build");
    const panel = env.views.getView("construction").getData();
    assert.deepStrictEqual([panel.available, panel.open.map((b) => [b.faction, b.system, b.state, b.kitPercent,
      b.convoysLost]), panel.ended], [true, [[SANSHA, SITE, "SUPPLYING", 0, 0]], []]);
    env.construction.stop("test");
    env.strategy.stop("test");
  }));

  const L_SITE = 30001955;
  const L_KITS = Object.freeze({ astrahus: Object.freeze({ kind: "upwell", structureFamily: "astrahus", typeId: 35832,
    items: Object.freeze({ "mineral/type:34": 3000 }) }) });
  const lEnv = (o) => ({ EVEJS_LNE_STRATEGY_MAX_REVIEWS_PER_PASS: "8", EVEJS_LNE_PRODUCTION_TARGET_STOCK_FLEETS: "0",
    EVEJS_LNE_CONSTRUCTION_ANCHORING_MS: String(2 * I), ...o });
  async function lBoot(reopen, shared, env, holder) {
    const hooks = { beforeEffect: (d, snapshot) => {
      if (d.factionId !== SANSHA || d.outcome !== "REVIEWED") return d;
      holder.snaps.push(snapshot.logistics);
      if (d.intents.some((i) => i.type === "CONVOY_DISPATCH")) holder.mark = true;
      if (!holder.inject) return d;
      holder.inject = false;
      return { ...d, intents: [{ type: "BUILD_PLAN", slot: 0, systemId: L_SITE, kitId: "astrahus" }, ...d.intents] };
    } };
    const wrapScheduler = (sch) => ({ ...sch, registerHandler: (type, h, o) => sch.registerHandler(type, (ev, hctx) => {
      const r = h(ev, hctx);
      if (r && r.effect && holder.mark) {
        holder.mark = false;
        holder.effect = r.effect;
      }
      return r;
    }, o) });
    const e = await bootAll(reopen(), shared, env, { hooks, wrapScheduler, production: true, construction: true,
      logistics: true, kitsData: L_KITS });
    const src = e.q("SELECT station_id, system_id FROM world_stations WHERE owner_faction_id = ? AND state = 'ONLINE' "
      + "AND system_id <> ? ORDER BY station_id", SANSHA, L_SITE)[0];
    assert.ok(src, "a Sansha source station");
    assert.ok(e.tx((db) => e.stations.repository.applyStockChange(db, { stationId: src.station_id, key: "l:seed",
      reason: "TEST", at: shared.clock.now(), deltas: [{ itemKind: "mineral", itemKey: "type:34", delta: 5000 }] })).ok);
    return e;
  }
  const lBuilds = (env) => env.q("SELECT station_id AS id, state, end_reason AS why FROM world_station_builds");
  const lConvoys = (env) => env.q("SELECT convoy_id AS id, fleet_id AS fleet, purpose, dest_station_id AS dest, state "
    + "FROM world_convoys ORDER BY convoy_id");

  needsDriver("L1 review + real logistics: snapshot.logistics ready -> MOBILIZE logistics -> CONVOY_DISPATCH "
    + "CONSTRUCTION to the site -> DELIVERED, build ANCHORING -> COMPLETED, station ONLINE; one convoy, one "
    + "STATION_CREATED, the replayed dispatch effect is a duplicate", () => H.withStore(driver, async (reopen) => {
    const clock = createManualClock(START_MS);
    const shared = { clock, ids: createIdGenerator({ clock, rng: createRng(17) }), graph: graphOf(),
      controllers: new Map(THEATRE.map((id) => [id, SANSHA])) };
    const holder = { inject: true, mark: false, effect: null, snaps: [] };
    const env = await lBoot(reopen, shared, lEnv({}), holder);
    assert.strictEqual(env.logistics.getMode(), "ready");
    await passesAt(env, shared, START_MS + I);
    assert.strictEqual(lBuilds(env).length, 1, "the injected BUILD_PLAN");
    const site = lBuilds(env)[0].id;
    assert.ok(holder.snaps.length > 0 && holder.snaps.every((l) => l !== null && l.mode === "ready"),
      JSON.stringify(holder.snaps));
    const delivered = await driveUntil(env, shared, START_MS + 40 * I, I,
      () => lConvoys(env).some((c) => c.state === "DELIVERED"));
    const fleets = fleetsOf(env, SANSHA).filter((x) => x.fleet_role === "logistics");
    const convoys = lConvoys(env);
    assert.ok(delivered, JSON.stringify([convoys, lBuilds(env), env.strategy.getStatus().ai.review]));
    assert.strictEqual(fleets.length, 1, JSON.stringify(fleets.map((x) => x.state)));
    assert.deepStrictEqual(convoys.map((c) => [c.fleet, c.purpose, c.dest, c.state]),
      [[fleets[0].fleet_id, "CONSTRUCTION", site, "DELIVERED"]]);
    const c = env.strategy.getStatus().ai.review.counters;
    assert.ok(c.logisticsMobilized >= 1 && c.convoysDispatched === 1, JSON.stringify(c));
    assert.deepStrictEqual(lBuilds(env), [{ id: site, state: "ANCHORING", why: null }]);
    await driveUntil(env, shared, shared.clock.now() + 4 * I, I, () => lBuilds(env)[0].state === "COMPLETED");
    assert.deepStrictEqual(lBuilds(env), [{ id: site, state: "COMPLETED", why: "ONLINE" }]);
    assert.strictEqual(env.q("SELECT state FROM world_stations WHERE station_id = ?", site)[0].state, "ONLINE");
    assert.ok(typeof holder.effect === "function", "the dispatch round was captured");
    const replay = env.tx((db) => holder.effect(db));
    assert.ok(replay.ok && replay.applied.CONVOY_DISPATCH === undefined, JSON.stringify(replay));
    await passesAt(env, shared, shared.clock.now() + I);
    assert.strictEqual(lConvoys(env).filter((x) => x.purpose === "CONSTRUCTION").length, 1);
    assert.strictEqual(env.q("SELECT count(*) AS n FROM world_event_journal WHERE event_type = 'STATION_CREATED' "
      + "AND aggregate_id = ?", site)[0].n, 1);
    env.logistics.stop("test");
    env.construction.stop("test");
    env.production.stop("test");
    env.strategy.stop("test");
  }));

  needsDriver("L2 logistics.convoysEnabled=0: snapshot.logistics null, no convoy, the build stays SUPPLYING "
    + "REPLENISH unchanged (a patrol fleet short of 2 frigates gets them from the station)",
  () => H.withStore(driver, async (reopen) => {
    const clock = createManualClock(START_MS);
    const shared = { clock, ids: createIdGenerator({ clock, rng: createRng(17) }), graph: graphOf(),
      controllers: new Map(THEATRE.map((id) => [id, SANSHA])) };
    const holder = { inject: true, mark: false, effect: null, snaps: [] };
    const env = await lBoot(reopen, shared, lEnv({ EVEJS_LNE_LOGISTICS_CONVOYS_ENABLED: "0" }), holder);
    assert.deepStrictEqual([env.config.logistics.convoysEnabled, env.logistics.getMode()], [false, "ready"]);
    const src = env.q("SELECT station_id, system_id FROM world_stations WHERE owner_faction_id = ? AND state = 'ONLINE' "
      + "AND system_id <> ? ORDER BY station_id", SANSHA, L_SITE)[0];
    assert.ok(env.tx((db) => env.stations.repository.applyStockChange(db, { stationId: src.station_id, key: "l2:hulls",
      reason: "TEST", at: clock.now(), deltas: [{ itemKind: "hull", itemKey: "group:frigate", delta: 2 }] })).ok);
    const patrol = env.fleets.createFleet({ factionId: SANSHA, currentSystemId: src.system_id,
      homeSystemId: src.system_id, fleetRole: "patrol", composition: [{ hullGroup: "frigate", count: 2 },
        { hullGroup: "destroyer", count: 2 }] }, "l2:patrol");
    assert.ok(patrol.ok, JSON.stringify(patrol));
    await passesAt(env, shared, START_MS + I);
    await passesAt(env, shared, START_MS + 2 * I);
    await passesAt(env, shared, START_MS + 3 * I);
    assert.ok(holder.snaps.length >= 2 && holder.snaps.every((l) => l === null), JSON.stringify(holder.snaps));
    assert.deepStrictEqual([lConvoys(env).length, lBuilds(env).map((b) => b.state)], [0, ["SUPPLYING"]]);
    assert.strictEqual(fleetsOf(env, SANSHA).filter((x) => x.fleet_role === "logistics").length, 0);
    const c = env.strategy.getStatus().ai.review.counters;
    assert.deepStrictEqual([c.replenished, c.replenishHulls, c.convoysDispatched || 0], [1, 2, 0], JSON.stringify(c));
    env.logistics.stop("test");
    env.construction.stop("test");
    env.production.stop("test");
    env.strategy.stop("test");
  }));

  async function zombieRun(reopen, env, extra, K) {
    const clock = createManualClock(START_MS);
    const shared = { clock, ids: createIdGenerator({ clock, rng: createRng(23) }), graph: graphOf(),
      controllers: new Map(THEATRE.map((id) => [id, SANSHA])) };
    const e = await bootAll(reopen(), shared, { EVEJS_LNE_STRATEGY_ACTIVE_FACTIONS: String(SANSHA),
      EVEJS_LNE_STRATEGY_MAX_REVIEWS_PER_PASS: "8", EVEJS_LNE_PRODUCTION_TARGET_STOCK_FLEETS: "0", ...env },
    { logistics: true, ...extra });
    const base = e.q("SELECT station_id, system_id FROM world_stations WHERE owner_faction_id = ? AND state = 'ONLINE' "
      + "ORDER BY station_id", SANSHA)[0];
    assert.ok(base, "a Sansha station");
    const frigates = () => (e.q("SELECT quantity FROM world_station_stock WHERE station_id = ? AND item_key = "
      + "'group:frigate'", base.station_id)[0] || { quantity: 0 }).quantity;
    const live = () => e.q("SELECT count(*) AS n FROM virtual_fleets WHERE faction_id = ? AND fleet_role = 'logistics' "
      + "AND state <> 'DESTROYED'", SANSHA)[0].n;
    const counts = [];
    const stock = [];
    for (let k = 0; k < K; k += 1) {
      const z = e.fleets.createFleet({ factionId: SANSHA, currentSystemId: base.system_id, homeSystemId: base.system_id,
        fleetRole: "logistics", composition: [{ hullGroup: "frigate", count: 2 }] }, `lr2:zombie:${k}`);
      assert.ok(z.ok, JSON.stringify(z));
      await passesAt(e, shared, START_MS + (k + 1) * I);
      counts.push(live());
      stock.push(frigates());
    }
    const c = e.strategy.getStatus().ai.review.counters;
    const out = { counts, stock, counters: c, lines: e.lines.filter((l) => l.includes(" disband ")) };
    e.logistics.stop("test");
    if (e.production) e.production.stop("test");
    e.strategy.stop("test");
    return out;
  }

  needsDriver("LR2 criterion: a new logistics fleet without carriers in the base before each "
    + "of K=4 reviews -> DISBAND NO_CARRIERS each time, the live logistics fleets never grow; retireEnabled=0 -> they "
    + "grow (mutation check); escort hulls back to the stock only with logistics.needsHulls (+ required policy)",
  async () => {
    const K = 4;
    const on = await H.withStore(driver, (reopen) => zombieRun(reopen, {}, {}, K));
    const limit = 3 + 2;
    assert.ok(on.counts.every((n) => n <= limit) && on.counts[K - 1] <= on.counts[0], JSON.stringify(on));
    assert.deepStrictEqual([on.counts, on.counters.logisticsDisbanded, on.counters.logisticsRetireRefused],
      [[0, 0, 0, 0], K, 0], JSON.stringify(on.counters));
    assert.strictEqual(on.lines.length, K, JSON.stringify(on.lines));
    assert.match(on.lines[0], /^strategy: 500019 r\d+ disband \S+ NO_CARRIERS hulls=0$/);
    assert.deepStrictEqual(on.stock, [0, 0, 0, 0], "needsHulls false: no hulls from nothing");
    const off = await H.withStore(driver, (reopen) => zombieRun(reopen, { EVEJS_LNE_LOGISTICS_RETIRE_ENABLED: "0" },
      {}, K));
    assert.deepStrictEqual([off.counts, off.counters.logisticsDisbanded], [[1, 2, 3, 4], 0]);
    const hulls = await H.withStore(driver, (reopen) => zombieRun(reopen, { EVEJS_LNE_LOGISTICS_NEEDS_HULLS: "1" },
      { production: true }, 1));
    assert.deepStrictEqual([hulls.counts, hulls.stock, hulls.counters.logisticsDisbandHulls], [[0], [2], 2],
      JSON.stringify(hulls));
  });

  needsDriver("SLR3 tribute-c a stranded logistics fleet (carriers, 2+ jumps from every own "
    + "station at maxConvoyJumps 1) -> after the review an ACTIVE return operation with it, logisticsStrandedReturns 1, "
    + "logisticsRetireReturns 0; the replayed effect is a duplicate without a write",
  () => H.withStore(driver, async (reopen) => {
    const clock = createManualClock(START_MS);
    const shared = { clock, ids: createIdGenerator({ clock, rng: createRng(29) }), graph: graphOf(),
      controllers: new Map(THEATRE.map((id) => [id, SANSHA])) };
    const holder = { mark: false, effect: null };
    const hooks = { beforeEffect: (d) => {
      if (!holder.effect && d.factionId === SANSHA && (d.intents || []).some((i) => i.purpose === "LOGISTICS_STRANDED")) {
        holder.mark = true;
      }
      return d;
    } };
    const wrapScheduler = (sch) => ({ ...sch, registerHandler: (type, h, o) => sch.registerHandler(type, (ev, hctx) => {
      const r = h(ev, hctx);
      if (r && r.effect && holder.mark) {
        holder.mark = false;
        holder.effect = r.effect;
      }
      return r;
    }, o) });
    const e = await bootAll(reopen(), shared, { EVEJS_LNE_STRATEGY_ACTIVE_FACTIONS: String(SANSHA),
      EVEJS_LNE_STRATEGY_MAX_REVIEWS_PER_PASS: "8", EVEJS_LNE_PRODUCTION_TARGET_STOCK_FLEETS: "0",
      EVEJS_LNE_LOGISTICS_MAX_CONVOY_JUMPS: "1", EVEJS_LNE_LOGISTICS_STRANDED_RETURN_ENABLED: "1" },
    { logistics: true, hooks, wrapScheduler });
    const homes = e.q("SELECT DISTINCT system_id AS s FROM world_stations WHERE owner_faction_id = ? AND state = "
      + "'ONLINE'", SANSHA).map((r) => r.s);
    const dist = bfs(homes, (id) => shared.graph.getNeighbors(id), { maxJumps: 6, maxSystems: 5000 });
    const far = [...dist.entries()].filter(([, j]) => j >= 2).sort((a, b) => a[1] - b[1] || a[0] - b[0])[0];
    assert.ok(far, JSON.stringify(homes));
    const z = e.fleets.createFleet({ factionId: SANSHA, currentSystemId: far[0], homeSystemId: homes[0],
      fleetRole: "logistics", composition: [{ hullGroup: "industrial", count: 2 }] }, "slr3:stranded");
    assert.ok(z.ok, JSON.stringify(z));
    await passesAt(e, shared, START_MS + I);
    assert.ok(typeof holder.effect === "function", "the stranded return was planned");
    const ops = () => e.q("SELECT o.operation_type AS t, o.state, o.target_system_id AS s FROM world_operations o "
      + "JOIN virtual_fleets f ON f.operation_id = o.operation_id WHERE f.fleet_id = ?", z.fleetId);
    assert.deepStrictEqual(ops().map((o) => [o.t, o.state, homes.includes(o.s)]), [["return", "ACTIVE", true]]);
    const c = e.strategy.getStatus().ai.review.counters;
    assert.deepStrictEqual([c.logisticsStrandedReturns, c.logisticsRetireReturns || 0, c.logisticsStrandedRefused || 0],
      [1, 0, 0], JSON.stringify(c));
    const rows = () => e.q("SELECT (SELECT count(*) FROM world_operations) AS o, (SELECT count(*) FROM "
      + "world_event_journal) AS j")[0];
    const before = rows();
    const replay = e.tx((db) => holder.effect(db));
    assert.ok(replay.ok && replay.applied.LAUNCH === undefined, JSON.stringify(replay));
    assert.deepStrictEqual(rows(), before, "duplicate: no write");
    e.logistics.stop("test");
    e.strategy.stop("test");
  }));

  needsDriver("R2 REPLENISH on the base: stock gone in the effect -> the whole intent refused (fleet, stock "
    + "faction unchanged); then exactly once (stock -4, composition +4, ship_count +4, faction cost); the replayed "
    + "effect is a duplicate", () => H.withStore(driver, async (reopen) => {
    const clock = createManualClock(START_MS);
    const shared = { clock, ids: createIdGenerator({ clock, rng: createRng(13) }), graph: graphOf(),
      controllers: new Map(THEATRE.map((id) => [id, SANSHA])) };
    const holder = { env: null, steal: true, station: null };
    let lastEffect = null;
    const stock = (key, delta) => holder.env.tx((db) => holder.env.stations.repository.applyStockChange(db,
      { stationId: holder.station, key, reason: "TEST", at: clock.now(),
        deltas: [{ itemKind: "hull", itemKey: "group:cruiser", delta }] }));
    const hooks = { beforeEffect: (d) => {
      if (d.factionId === AMARR && holder.steal && d.intents.some((i) => i.type === "REPLENISH")) {
        holder.steal = false;
        assert.ok(stock("r2:steal", -1).ok);
      }
      return d;
    } };
    const wrapScheduler = (sch) => ({ ...sch, registerHandler: (type, h, o) => sch.registerHandler(type, (ev, hctx) => {
      const r = h(ev, hctx);
      if (r && r.effect && ev.payload.factionId === AMARR) lastEffect = r.effect;
      return r;
    }, o) });
    const env = await bootAll(reopen(), shared, { EVEJS_LNE_STRATEGY_MAX_REVIEWS_PER_PASS: "8",
      EVEJS_LNE_UPKEEP_ENABLED: "0" }, { hooks, production: true, wrapScheduler });
    holder.env = env;
    const row = env.q("SELECT station_id, system_id FROM world_stations WHERE owner_faction_id = ? AND state = 'ONLINE' "
      + "ORDER BY station_id", AMARR)[0];
    holder.station = row.station_id;
    assert.ok(stock("r2:seed", 4).ok);
    const created = env.fleets.createFleet({ factionId: AMARR, currentSystemId: row.system_id,
      homeSystemId: row.system_id, fleetRole: "invasion", composition: [{ hullGroup: "cruiser", count: 2 },
        { hullGroup: "battlecruiser", count: 4 }, { hullGroup: "logistics", count: 2 },
        { hullGroup: "tackle", count: 2 }] }, "r2:create");
    assert.ok(created.ok, JSON.stringify(created));
    const fleetRow = () => env.q("SELECT composition_json AS c, ship_count AS n, version AS v FROM virtual_fleets "
      + "WHERE fleet_id = ?", created.fleetId)[0];
    const cruisersAt = () => (env.q("SELECT quantity FROM world_station_stock WHERE station_id = ? AND "
      + "item_key = 'group:cruiser'", holder.station)[0] || { quantity: 0 }).quantity;
    const f0 = fleetRow();
    const res0 = factionRow(env, AMARR).resource_units;

    await passesAt(env, shared, START_MS + I);
    assert.deepStrictEqual([fleetRow(), cruisersAt(), factionRow(env, AMARR).resource_units], [f0, 3, res0],
      "the REPLENISH rolled back as a whole");
    assert.strictEqual(env.strategy.getStatus().ai.review.counters.replenishRefused, 1);
    assert.ok(stock("r2:back", 1).ok);

    await passesAt(env, shared, START_MS + 2 * I);
    const f1 = fleetRow();
    const cruisers = JSON.parse(f1.c).filter((e) => e.hullGroup === "cruiser").reduce((n, e) => n + e.count, 0);
    const rate = env.config.strategy.mobilizeResourcePerShip;
    assert.deepStrictEqual([cruisers, f1.n, cruisersAt(), factionRow(env, AMARR).resource_units],
      [6, 14, 0, res0 - 4 * rate], JSON.stringify(env.strategy.getStatus().ai.review));
    const c = env.strategy.getStatus().ai.review.counters;
    assert.deepStrictEqual([c.replenished, c.replenishHulls], [1, 4]);
    const replay = env.tx((db) => lastEffect(db));
    assert.ok(replay.ok && replay.applied.REPLENISH === undefined, JSON.stringify(replay));
    assert.deepStrictEqual([fleetRow(), cruisersAt()], [f1, 0], "duplicate: nothing changed");
    env.strategy.stop("test");
    env.production.stop("test");
  }));

  needsDriver("D3 FLEET_UPGRADE at the station: stock gone in the effect -> INSUFFICIENT_STOCK rolls the whole "
    + "intent back; then porpoise 1 + exhumer 2 + mining_frigate 3, stock -1/-2, no faction cost; the replayed effect "
    + "is a duplicate (stock taken once); the decision is plain JSON", () => H.withStore(driver, async (reopen) => {
    const clock = createManualClock(START_MS);
    const shared = { clock, ids: createIdGenerator({ clock, rng: createRng(17) }), graph: graphOf(),
      controllers: new Map(THEATRE.map((id) => [id, SANSHA])) };
    const holder = { env: null, steal: true, station: null, decisions: 0 };
    let lastEffect = null;
    const stock = (key, group, delta) => holder.env.tx((db) => holder.env.stations.repository.applyStockChange(db,
      { stationId: holder.station, key, reason: "TEST", at: clock.now(),
        deltas: [{ itemKind: "hull", itemKey: `group:${group}`, delta }] }));
    const hooks = { beforeEffect: (d) => {
      if (d.factionId === AMARR && d.intents.some((i) => i.type === "FLEET_UPGRADE")) {
        holder.decisions += 1;
        assert.doesNotThrow(() => JSON.stringify(d), "no BigInt in the decision (consultation 2d)");
        if (holder.steal) {
          holder.steal = false;
          assert.ok(stock("d3:steal", "exhumer", -1).ok);
        }
      }
      return d;
    } };
    const wrapScheduler = (sch) => ({ ...sch, registerHandler: (type, h, o) => sch.registerHandler(type, (ev, hctx) => {
      const r = h(ev, hctx);
      if (r && r.effect && ev.payload.factionId === AMARR) lastEffect = r.effect;
      return r;
    }, o) });
    const env = await bootAll(reopen(), shared, { EVEJS_LNE_STRATEGY_MAX_REVIEWS_PER_PASS: "8",
      EVEJS_LNE_UPKEEP_ENABLED: "0" }, { hooks, production: true, wrapScheduler });
    holder.env = env;
    const row = env.q("SELECT station_id, system_id FROM world_stations WHERE owner_faction_id = ? AND state = 'ONLINE' "
      + "ORDER BY station_id", AMARR)[0];
    holder.station = row.station_id;
    assert.ok(stock("d3:seed:p", "porpoise", 1).ok);
    assert.ok(stock("d3:seed:e", "exhumer", 2).ok);
    const created = env.fleets.createFleet({ factionId: AMARR, currentSystemId: row.system_id,
      homeSystemId: row.system_id, fleetRole: "mining", composition: [{ hullGroup: "mining_frigate", count: 3 }] },
    "d3:create");
    assert.ok(created.ok, JSON.stringify(created));
    const fleetRow = () => env.q("SELECT composition_json AS c, ship_count AS n, version AS v, state FROM virtual_fleets "
      + "WHERE fleet_id = ?", created.fleetId)[0];
    const at = (g) => (env.q("SELECT quantity FROM world_station_stock WHERE station_id = ? AND item_key = ?",
      holder.station, `group:${g}`)[0] || { quantity: 0 }).quantity;
    const f0 = fleetRow();
    const res0 = factionRow(env, AMARR).resource_units;

    await passesAt(env, shared, START_MS + I);
    assert.deepStrictEqual([fleetRow(), at("porpoise"), at("exhumer")], [f0, 1, 1], "rolled back as a whole");
    const c1 = env.strategy.getStatus().ai.review.counters;
    assert.deepStrictEqual([c1.upgrades, c1.upgradeRefused], [0, 1], JSON.stringify(c1));
    assert.strictEqual(env.strategy.getStatus().ai.review.lastRefusal, "FLEET_UPGRADE:INSUFFICIENT_STOCK");
    assert.ok(stock("d3:back", "exhumer", 1).ok);

    await passesAt(env, shared, START_MS + 2 * I);
    const f1 = fleetRow();
    const comp = Object.fromEntries(JSON.parse(f1.c).map((e) => [e.hullGroup, e.count]));
    assert.deepStrictEqual([comp, f1.n, f1.state, at("porpoise"), at("exhumer")],
      [{ exhumer: 2, mining_frigate: 3, porpoise: 1 }, 6, "IDLE", 0, 0], JSON.stringify(f1));
    assert.strictEqual(factionRow(env, AMARR).resource_units, res0, "no faction cost");
    const c2 = env.strategy.getStatus().ai.review.counters;
    assert.deepStrictEqual([c2.upgrades, c2.upgradeHulls], [1, 3]);
    const replay = env.tx((db) => lastEffect(db));
    assert.ok(replay.ok && replay.applied.FLEET_UPGRADE === undefined, JSON.stringify(replay));
    assert.deepStrictEqual([fleetRow(), at("porpoise"), at("exhumer")], [f1, 0, 0], "duplicate: stock taken once");
    assert.ok(holder.decisions >= 2);
    env.strategy.stop("test");
    env.production.stop("test");
  }));

  needsDriver("E2 FLEET_UPGRADE logistics: industrial 2 + frigate 2 at a station with {freighter 1} -> "
    + "freighter 1 + frigate 2, stock -1 freighter; the replayed effect is a duplicate (stock taken once)",
  () => H.withStore(driver, async (reopen) => {
    const clock = createManualClock(START_MS);
    const shared = { clock, ids: createIdGenerator({ clock, rng: createRng(23) }), graph: graphOf(),
      controllers: new Map(THEATRE.map((id) => [id, SANSHA])) };
    let lastEffect = null;
    const wrapScheduler = (sch) => ({ ...sch, registerHandler: (type, h, o) => sch.registerHandler(type, (ev, hctx) => {
      const r = h(ev, hctx);
      if (r && r.effect && ev.payload.factionId === AMARR) lastEffect = r.effect;
      return r;
    }, o) });
    const env = await bootAll(reopen(), shared, { EVEJS_LNE_STRATEGY_MAX_REVIEWS_PER_PASS: "8",
      EVEJS_LNE_UPKEEP_ENABLED: "0" }, { production: true, logistics: true, wrapScheduler });
    const row = env.q("SELECT station_id, system_id FROM world_stations WHERE owner_faction_id = ? AND state = 'ONLINE' "
      + "ORDER BY station_id", AMARR)[0];
    const seeded = env.tx((db) => env.stations.repository.applyStockChange(db, { stationId: row.station_id,
      key: "e2:seed", reason: "TEST", at: clock.now(), deltas: [{ itemKind: "hull", itemKey: "group:freighter",
        delta: 1 }] }));
    assert.ok(seeded.ok, JSON.stringify(seeded));
    const created = env.fleets.createFleet({ factionId: AMARR, currentSystemId: row.system_id,
      homeSystemId: row.system_id, fleetRole: "logistics", composition: [{ hullGroup: "industrial", count: 2 },
        { hullGroup: "frigate", count: 2 }] }, "e2:create");
    assert.ok(created.ok, JSON.stringify(created));
    const fleetRow = () => env.q("SELECT composition_json AS c, ship_count AS n, version AS v, state FROM virtual_fleets "
      + "WHERE fleet_id = ?", created.fleetId)[0];
    const freighters = () => (env.q("SELECT quantity FROM world_station_stock WHERE station_id = ? AND item_key = ?",
      row.station_id, "group:freighter")[0] || { quantity: 0 }).quantity;

    await passesAt(env, shared, START_MS + I);
    const f1 = fleetRow();
    const comp = Object.fromEntries(JSON.parse(f1.c).map((e) => [e.hullGroup, e.count]));
    assert.deepStrictEqual([comp, f1.n, freighters()], [{ freighter: 1, frigate: 2 }, 3, 0],
      JSON.stringify(env.strategy.getStatus().ai.review));
    const replay = env.tx((db) => lastEffect(db));
    assert.ok(replay.ok && replay.applied.FLEET_UPGRADE === undefined, JSON.stringify(replay));
    assert.deepStrictEqual([fleetRow(), freighters()], [f1, 0], "duplicate: stock taken once");
    env.strategy.stop("test");
    env.production.stop("test");
    env.logistics.stop("test");
  }));

  needsDriver("U3 UPKEEP exactly once: anchor, a replayed effect is a duplicate, one charge per period, unpaid "
    + "-> the detached captured system abandoned (controller null, unpaid 0); migration 16 fresh and from 15",
  () => H.withStore(driver, async (reopen) => {
    const clock = createManualClock(START_MS);
    const C1 = 30001955;
    const C2 = 30001954;
    const controllers = new Map(THEATRE.map((id) => [id, SANSHA]));
    controllers.set(SAMINER, AMARR);
    controllers.set(C1, AMARR);
    controllers.set(C2, AMARR);
    const captured = new Map([[C1, START_MS - 1], [C2, null]]);
    const shared = { clock, ids: createIdGenerator({ clock, rng: createRng(11) }), graph: graphOf(), controllers };
    const abandons = [];
    const occupation = { getStatus: () => ({ state: "ready" }), signalInTx: () => ({ ok: false, reason: "TEST" }),
      markDetachedInTx: () => ({ ok: true, changed: false }), count() {}, noteRefusal() {},
      territoryUpkeepFactor: (sys) => (sys.detachedSinceAt === null ? 1 : 2),
      abandonInTx(tx, spec, key) {
        if (controllers.get(spec.systemId) !== spec.factionId) return { ok: false, reason: "NOT_CONTROLLER" };
        abandons.push([spec.systemId, key]);
        controllers.set(spec.systemId, null);
        return { ok: true, changed: true };
      } };
    let lastEffect = null;
    const wrapScheduler = (sch) => ({ ...sch, registerHandler: (type, h, o) => sch.registerHandler(type, (ev, hctx) => {
      const r = h(ev, hctx);
      if (r && r.effect && ev.payload.factionId === AMARR) lastEffect = r.effect;
      return r;
    }, o) });
    const env = await bootAll(reopen(), shared, { EVEJS_LNE_STRATEGY_CAMPAIGNS: "none",
      EVEJS_LNE_MAX_ACTIVE_FRONTS_PER_FACTION: "1",
      EVEJS_LNE_STRATEGY_MAX_REVIEWS_PER_PASS: "8", EVEJS_LNE_UPKEEP_PERIOD_MS: String(I),
      EVEJS_LNE_UPKEEP_ABANDON_AFTER_UNPAID_PERIODS: "1", EVEJS_LNE_UPKEEP_INCOME_PER_SYSTEM: "0",
      EVEJS_LNE_UPKEEP_INCOME_PER_STATION: "0",
      EVEJS_LNE_STRATEGY_GARRISON_REINFORCE_ENABLED: "0" },
    { world: upkeepWorld(controllers, captured), occupation, wrapScheduler });
    const row0 = factionRow(env, AMARR);
    assert.deepStrictEqual([row0.upkeep_paid_until, row0.upkeep_unpaid_periods, row0.income_total], [null, 0, 0]);

    await passesAt(env, shared, START_MS + I);
    const row1 = factionRow(env, AMARR);
    assert.ok(row1.upkeep_paid_until !== null && row1.upkeep_paid_until % I === 0, JSON.stringify(row1));
    assert.deepStrictEqual([row1.resource_units, row1.upkeep_total], [19990, 0]);
    const replay = env.tx((db) => lastEffect(db));
    assert.ok(replay.ok && replay.applied.UPKEEP === undefined, JSON.stringify(replay));
    const rowAfterReplay = factionRow(env, AMARR);
    assert.deepStrictEqual({ resource_units: rowAfterReplay.resource_units, upkeep_total: rowAfterReplay.upkeep_total, upkeep_paid_until: rowAfterReplay.upkeep_paid_until },
      { resource_units: row1.resource_units, upkeep_total: row1.upkeep_total, upkeep_paid_until: row1.upkeep_paid_until });

    await passesAt(env, shared, START_MS + 2 * I);
    const row2 = factionRow(env, AMARR);
    assert.strictEqual(row2.upkeep_paid_until, row1.upkeep_paid_until + I);
    assert.ok(row2.upkeep_total > 0, JSON.stringify(row2));
    assert.strictEqual(row2.resource_units, 19990 - row2.upkeep_total);
    assert.strictEqual(env.strategy.getStatus().ai.review.counters.upkeepCharged, 4, "one period x 4 factions");

    env.tx((db) => db.prepare("UPDATE world_factions SET resource_units = 0 WHERE faction_id = ?").run(AMARR));
    await passesAt(env, shared, START_MS + 3 * I);
    const row3 = factionRow(env, AMARR);
    assert.deepStrictEqual(abandons.map((a) => a[0]), [C1]);
    assert.ok(abandons[0][1].endsWith(`:UPKEEP:abandon:${C1}`), abandons[0][1]);
    assert.deepStrictEqual([controllers.get(C1), controllers.get(C2), row3.resource_units, row3.upkeep_unpaid_periods],
      [null, AMARR, 0, 0]);
    assert.ok(row3.upkeep_unpaid_total > 0 && row3.upkeep_paid_until === row2.upkeep_paid_until + I);

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lne-m16-"));
    const dbFile = path.join(tmp, "world.sqlite");
    const open = (migrations) => {
      const o = openStore({ filePath: dbFile, openDatabase: (f) => new driver.Database(f), exclusiveLock: true,
        busyTimeoutMs: 0, maxRowsPerTransaction: 500, maxWriteMsPerPass: 5, randomSeed: () => 1, migrations });
      assert.ok(o.ok, JSON.stringify(o));
      return o;
    };
    const opened = [];
    try {
      const old = open(MIGRATIONS.slice(0, 15));
      old.store.transaction("t", (db) => db.prepare("INSERT INTO world_factions (faction_id, status, home_system_id, "
        + "doctrine_id, resource_units, reserve_units, front_limit, registry_version, last_review_at, created_at, "
        + "updated_at, version) VALUES (500003, 'ACTIVE', NULL, 'd', 5, 1, 1, 1, NULL, 0, 0, 1)").run());
      old.store.close("upgrade");
      const up = open(MIGRATIONS.slice(0, 16));
      opened.push(up.store);
      assert.deepStrictEqual([up.schemaVersion, up.applied, MIGRATIONS[15].name], [16, 1, "world_faction_upkeep"]);
      const r = up.store.transaction("t", (db) => db.prepare("SELECT upkeep_paid_until AS p, upkeep_unpaid_periods AS u, "
        + "income_total + upkeep_total + upkeep_unpaid_total + trade_funded_total AS t, resource_units AS r "
        + "FROM world_factions").get());
      assert.deepStrictEqual({ ...r.value }, { p: null, u: 0, t: 0, r: 5 });
    } finally {
      for (const st of opened) st.close("test");
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  }));

  needsDriver("TB4 UPKEEP with the trade budget (real startStrategy + getTrade wiring): funded once, budget = "
    + "units x rate; unpaid faction -> no trade share; faction at maxResourceUnits + budget one unit from the cap -> "
    + "UPKEEP applied, the rest back cut to the cap (no RESOURCE_CAP)", () => H.withStore(driver, async (reopen) => {
    const clock = createManualClock(START_MS);
    const controllers = new Map(THEATRE.map((id) => [id, SANSHA]));
    controllers.set(SAMINER, AMARR);
    const shared = { clock, ids: createIdGenerator({ clock, rng: createRng(23) }), graph: graphOf(), controllers };
    const upkeepOf = new Map();
    const hooks = { beforeEffect: (decision, snapshot) => {
      upkeepOf.set(snapshot.factionId, snapshot.upkeep);
      return decision;
    } };
    const env = await bootAll(reopen(), shared, { EVEJS_LNE_STRATEGY_CAMPAIGNS: "none",
      EVEJS_LNE_STRATEGY_MAX_REVIEWS_PER_PASS: "8", EVEJS_LNE_UPKEEP_PERIOD_MS: String(I),
      EVEJS_LNE_TRADE_ENABLED: "1", EVEJS_LNE_TRADE_CONTRACTS_ENABLED: "0" },
    { world: upkeepWorld(controllers, new Map()), trade: true, hooks });
    assert.strictEqual(env.trade.getMode(), "run-no-contracts");
    const RATE = env.config.trade.iskPerResourceUnit;
    const CAP = env.config.trade.iskBudgetCap;
    const MAX_RES = env.config.strategy.maxResourceUnits;
    const budget = (f) => env.tx((db) => env.trade.readBudget(db, f)).budget;

    await passesAt(env, shared, START_MS + I);
    assert.strictEqual(budget(SANSHA), null);
    assert.strictEqual(upkeepOf.get(SANSHA).tradeReady, true, JSON.stringify(upkeepOf.get(SANSHA)));
    assert.strictEqual(upkeepOf.get(AMARR).tradeReady, true, JSON.stringify(upkeepOf.get(AMARR)));
    assert.deepStrictEqual([upkeepOf.get(SERPENTIS).tradeReady, upkeepOf.get(SERPENTIS).tradeReason],
      [false, "NO_NPC_STATION"]);

    await passesAt(env, shared, START_MS + 2 * I);
    const s2 = factionRow(env, SANSHA);
    const b2 = budget(SANSHA);
    assert.ok(s2.trade_funded_total > 0, JSON.stringify(s2));
    assert.deepStrictEqual([b2.fundedUnitsTotal, b2.availableIsk, b2.reservedIsk, b2.version],
      [s2.trade_funded_total, s2.trade_funded_total * RATE, 0, 1]);
    assert.deepStrictEqual([factionRow(env, SERPENTIS).trade_funded_total, budget(SERPENTIS)], [0, null]);
    const a2 = factionRow(env, AMARR);
    assert.ok(a2.trade_funded_total > 0, JSON.stringify(a2));
    assert.strictEqual(budget(AMARR).fundedUnitsTotal, a2.trade_funded_total);
    const c2 = env.trade.getStatus().counters;
    assert.ok(c2.funded >= 2 && c2.fundedUnits === s2.trade_funded_total + a2.trade_funded_total
      && c2.notReady >= 1, JSON.stringify(c2));

    env.tx((db) => db.prepare("UPDATE world_factions SET upkeep_unpaid_periods = 1 WHERE faction_id = ?").run(SANSHA));
    await passesAt(env, shared, START_MS + 3 * I);
    const s3 = factionRow(env, SANSHA);
    assert.deepStrictEqual([upkeepOf.get(SANSHA).tradeReady, upkeepOf.get(SANSHA).tradeReason],
      [false, "UPKEEP_UNPAID"]);
    assert.deepStrictEqual([s3.upkeep_paid_until, s3.trade_funded_total, budget(SANSHA).version],
      [s2.upkeep_paid_until + I, s2.trade_funded_total, 1]);

    env.tx((db) => {
      db.prepare("UPDATE world_factions SET resource_units = ? WHERE faction_id = ?").run(MAX_RES, SANSHA);
      db.prepare("UPDATE world_trade_budgets SET isk_available = ? WHERE faction_id = ?").run(CAP - RATE, SANSHA);
    });
    await passesAt(env, shared, START_MS + 4 * I);
    const s4 = factionRow(env, SANSHA);
    const b4 = budget(SANSHA);
    assert.strictEqual(upkeepOf.get(SANSHA).tradeReady, true);
    assert.strictEqual(s4.upkeep_paid_until, s3.upkeep_paid_until + I, "UPKEEP applied (no RESOURCE_CAP)");
    assert.strictEqual(s4.trade_funded_total, s3.trade_funded_total + 1, "one unit fits under the cap");
    assert.deepStrictEqual([b4.availableIsk + b4.reservedIsk, b4.version], [CAP, 2]);
    assert.ok(s4.resource_units <= MAX_RES, JSON.stringify(s4));
    assert.ok(env.trade.getStatus().counters.fundCapped >= 1);
    env.strategy.stop("test");
  }));

  needsDriver("TB6 faction-isk-economy-1 wiring (real startStrategy + getTreasury + getTrade): TREASURY seeds and "
    + "funds the budget in ISK, UPKEEP funds no units (tradeReady false, no trade.notReady), counters after the "
    + "commit, panel field treasury", () => H.withStore(driver, async (reopen) => {
    const clock = createManualClock(START_MS);
    const controllers = new Map(THEATRE.map((id) => [id, SANSHA]));
    const shared = { clock, ids: createIdGenerator({ clock, rng: createRng(31) }), graph: graphOf(), controllers };
    const upkeepOf = new Map();
    const hooks = { beforeEffect: (decision, snapshot) => {
      upkeepOf.set(snapshot.factionId, snapshot.upkeep);
      return decision;
    } };
    const strategyViews = createViewRegistry();
    const env = await bootAll(reopen(), shared, { EVEJS_LNE_STRATEGY_CAMPAIGNS: "none",
      EVEJS_LNE_STRATEGY_MAX_REVIEWS_PER_PASS: "8", EVEJS_LNE_UPKEEP_PERIOD_MS: String(I),
      EVEJS_LNE_TRADE_ENABLED: "1", EVEJS_LNE_TRADE_CONTRACTS_ENABLED: "0", EVEJS_LNE_TREASURY_ENABLED: "1" },
    { world: upkeepWorld(controllers, new Map()), trade: true, treasury: true, hooks, strategyViews });
    assert.strictEqual(env.treasury.getMode(), "run");
    await passesAt(env, shared, START_MS + I);
    await passesAt(env, shared, START_MS + 2 * I);
    const u = upkeepOf.get(SANSHA);
    assert.deepStrictEqual([u.tradeReady, u.tradeReason], [false, null], JSON.stringify(u));
    assert.strictEqual(factionRow(env, SANSHA).trade_funded_total, 0, "no units go to the trade");
    const t = env.q("SELECT * FROM world_faction_treasury WHERE faction_id = ?", SANSHA)[0];
    assert.ok(t && t.kind === "pirate" && t.initial_isk === 1e12 && t.trade_out_total > 0, JSON.stringify(t));
    const b = env.tx((db) => env.trade.readBudget(db, SANSHA)).budget;
    assert.deepStrictEqual([b.fundedUnitsTotal, b.fundedTotal, b.availableIsk + b.reservedIsk],
      [0, t.trade_out_total, t.trade_out_total]);
    const c = env.treasury.getStatus().counters;
    assert.ok(c.seeded >= 1 && c.settled >= 2 && c.tradeFunded >= 1 && c.refused === 0, JSON.stringify(c));
    assert.strictEqual(env.trade.getStatus().counters.notReady, 0);
    const view = strategyViews.getView("factions").getData();
    const row = view.factions.find((x) => x.factionId === SANSHA);
    assert.deepStrictEqual([row.treasury.kind, row.treasury.balanceIsk, row.treasury.today.tradeOut],
      ["pirate", t.isk_balance, t.trade_out_total], JSON.stringify(row.treasury));
    env.strategy.stop("test");
  }));

  needsDriver("TA1b faction-isk-economy-2 wiring (real startStrategy + production + treasury): the fee = feeOf of "
    + "the applied PRODUCE only (a RECIPES_CHANGED refusal pays nothing), AUSTERITY entered once, counters "
    + "productionFeeIsk / austerityEntered after the commit, TREASURY_AUSTERITY_ENTER in the review memory",
  () => H.withStore(driver, async (reopen) => {
    const clock = createManualClock(START_MS);
    const shared = { clock, ids: createIdGenerator({ clock, rng: createRng(37) }), graph: graphOf(),
      controllers: new Map(THEATRE.map((id) => [id, SANSHA])) };
    const holder = { inject: false, injected: false };
    const hooks = { beforeEffect: (d, snapshot) => {
      if (!holder.inject || d.factionId !== AMARR || d.outcome !== "REVIEWED") return d;
      holder.inject = false;
      holder.injected = d.intents.some((i) => i.type === "TREASURY");
      const v = snapshot.production.recipesVersion;
      const job = (hullGroup, runs, recipesVersion) => ({ type: "PRODUCE", slot: 0, stationId: holder.station,
        systemId: SAMINER, hullGroup, runs, recipesVersion });
      return { ...d, intents: [job("frigate", 2, v), job("battleship", 1, v + 1000), ...d.intents] };
    } };
    const strategyViews = createViewRegistry();
    const env = await bootAll(reopen(), shared, { EVEJS_LNE_STRATEGY_ACTIVE_FACTIONS: String(AMARR),
      EVEJS_LNE_STRATEGY_MAX_REVIEWS_PER_PASS: "8", EVEJS_LNE_TREASURY_ENABLED: "1",
      EVEJS_LNE_PRODUCTION_LINES_PER_UPWELL_STATION: "4" }, { hooks, production: true, treasury: true, strategyViews });
    holder.station = env.q("SELECT station_id FROM world_stations WHERE owner_faction_id = ? AND state = 'ONLINE' "
      + "AND kind = 'upwell' ORDER BY station_id", AMARR)[0].station_id;
    await passesAt(env, shared, START_MS + I);
    const seeded = env.q("SELECT * FROM world_faction_treasury WHERE faction_id = ?", AMARR)[0];
    assert.ok(seeded && seeded.mode === "NORMAL", JSON.stringify(seeded));
    env.tx((db) => db.prepare("UPDATE world_faction_treasury SET isk_balance = ? WHERE faction_id = ?")
      .run(Math.floor(seeded.initial_isk / 20), AMARR));
    const minerals = Object.entries(RECIPES.GROUPS.frigate.minerals).sort().map(([k, n]) => ({ itemKind: "mineral",
      itemKey: k, delta: n * 20 }));
    assert.ok(env.tx((db) => env.stations.repository.applyStockChange(db, { stationId: holder.station,
      key: "ta1b:seed", reason: "TEST", at: clock.now(), deltas: minerals })).ok);
    const jobsBefore = new Set(env.q("SELECT job_id FROM world_production_jobs").map((j) => j.job_id));
    holder.inject = true;
    await passesAt(env, shared, START_MS + I + 3600000);
    assert.ok(holder.injected, "the injected review had a TREASURY intent");
    const jobs = env.q("SELECT job_id, hull_group, runs FROM world_production_jobs WHERE faction_id = ?", AMARR)
      .filter((j) => !jobsBefore.has(j.job_id));
    assert.ok(jobs.some((j) => j.hull_group === "frigate" && j.runs === 2), JSON.stringify(jobs));
    assert.ok(!jobs.some((j) => j.hull_group === "battleship"), "the refused PRODUCE started no job");
    const values = env.tx((db) => env.treasury.readForReview(db, AMARR, { at: clock.now(), npcStations: 0,
      kind: "empire" })).treasury.valueByGroup;
    const fee = jobs.reduce((n, j) => n + treasuryFeeOf(j.runs, values[j.hull_group], 100), 0);
    const row = env.q("SELECT * FROM world_faction_treasury WHERE faction_id = ?", AMARR)[0];
    assert.strictEqual(row.production_fee_total - seeded.production_fee_total, fee, JSON.stringify(jobs));
    assert.ok(fee >= treasuryFeeOf(2, values.frigate, 100) && fee > 0, String(fee));
    assert.deepStrictEqual([row.mode, row.mode_changed_at > 0], ["AUSTERITY", true]);
    const c = env.treasury.getStatus().counters;
    assert.deepStrictEqual([c.productionFeeIsk, c.austerityEntered, c.austerityExited], [fee, 1, 0], JSON.stringify(c));
    const view = strategyViews.getView("factions").getData().factions.find((x) => x.factionId === AMARR);
    assert.strictEqual(env.strategy.getStatus().ai.review.lastRefusal, "PRODUCE:RECIPES_CHANGED");
    assert.deepStrictEqual([view.treasury.mode, view.treasury.modeChangedAt], ["AUSTERITY", row.mode_changed_at]);
    assert.ok(view.lastReview.notes.includes("TREASURY_AUSTERITY_ENTER"), JSON.stringify(view.lastReview.notes));
    env.strategy.stop("test");
    env.production.stop("test");
  }));

  needsDriver("WC4 wiring (real startStrategy + treasury, pressure on): war_spend of the day = the "
    + "warIsk of the applied LAUNCH / MOBILIZE, counter warSpendIsk, decision.warChest; the same round effect again "
    + "-> duplicate, balance and war spend unchanged; the facades have the methods the new code calls",
  () => H.withStore(driver, async (reopen) => {
    const clock = createManualClock(START_MS);
    const shared = { clock, ids: createIdGenerator({ clock, rng: createRng(41) }), graph: graphOf(),
      controllers: new Map(THEATRE.map((id) => [id, SANSHA])) };
    const decisions = [];
    const hooks = { beforeEffect: (d) => {
      if (d.factionId === AMARR) decisions.push(d);
      return d;
    } };
    let effect = null;
    const wrapScheduler = (sch) => ({ ...sch, registerHandler: (type, h, o) => sch.registerHandler(type, (ev, hctx) => {
      const r = h(ev, hctx);
      if (type === REVIEW && r && r.effect && ev.payload.factionId === AMARR) effect = r.effect;
      return r;
    }, o) });
    const env = await bootAll(reopen(), shared, { EVEJS_LNE_STRATEGY_MAX_REVIEWS_PER_PASS: "8",
      EVEJS_LNE_TREASURY_ENABLED: "1", EVEJS_LNE_TREASURY_PRESSURE_ENABLED: "1", EVEJS_LNE_STRATEGY_TARGET_PICK_TOP_K: "1",
      EVEJS_LNE_MAX_ACTIVE_FRONTS_PER_FACTION: "1", EVEJS_LNE_STRATEGY_CAPTURE_REQUIRES_ADJACENCY: "0" },
    { hooks, wrapScheduler, treasury: true });
    assert.strictEqual(typeof env.treasury.settleIntentInTx, "function");
    assert.strictEqual(typeof env.treasury.count, "function");
    assert.ok("warSpendUnsettled" in env.treasury.getStatus().counters);
    assert.ok("warChestShort" in env.strategy.getStatus().ai.review.counters);
    await passesAt(env, shared, START_MS + I);
    const reviewed = decisions.filter((d) => d.outcome === "REVIEWED");
    assert.ok(reviewed.length >= 1 && reviewed.every((d) => d.warChest && d.warChest.room >= 0),
      JSON.stringify(decisions.map((d) => [d.outcome, d.warChest, d.notes])));
    const warOf = (i) => (i.warIsk || 0) + (i.type === "LAUNCH" ? i.mobilize.reduce((s, m) => s + (m.warIsk || 0), 0) : 0);
    const planned = reviewed.flatMap((d) => d.intents).filter((i) => i.type === "LAUNCH" || i.type === "MOBILIZE")
      .reduce((s, i) => s + warOf(i), 0);
    assert.ok(planned > 0, JSON.stringify(reviewed.map((d) => d.notes)));
    assert.strictEqual(env.strategy.getStatus().ai.review.counters.intentRefused || 0, 0,
      env.strategy.getStatus().ai.review.lastRefusal);
    const row = env.q("SELECT * FROM world_faction_treasury WHERE faction_id = ?", AMARR)[0];
    const days = env.q("SELECT SUM(war_spend) AS w FROM world_faction_treasury_days WHERE faction_id = ?", AMARR)[0];
    assert.deepStrictEqual([row.war_spend_total, days.w], [planned, planned], JSON.stringify(row));
    assert.strictEqual(env.treasury.getStatus().counters.warSpendIsk,
      env.q("SELECT SUM(war_spend_total) AS w FROM world_faction_treasury")[0].w);
    assert.strictEqual(env.treasury.getStatus().counters.warSpendUnsettled, 0);
    assert.ok(typeof effect === "function", "the round effect of Amarr was captured");
    const replay = env.tx((db) => effect(db));
    assert.ok(replay.ok, JSON.stringify(replay));
    const again = env.q("SELECT * FROM world_faction_treasury WHERE faction_id = ?", AMARR)[0];
    assert.deepStrictEqual([again.isk_balance, again.war_spend_total, again.version],
      [row.isk_balance, row.war_spend_total, row.version]);
    env.strategy.stop("test");
  }));

  needsDriver("TB5 an applied private TRADE_OFFER: onCommitted does not throw (applied[type] is a count) "
    + "privateOffers counted from the intent, the rest of the hook runs (trade counters, lastRefusal)",
  () => H.withStore(driver, async (reopen) => {
    const clock = createManualClock(START_MS);
    const shared = { clock, ids: createIdGenerator({ clock, rng: createRng(29) }), graph: graphOf(),
      controllers: new Map(THEATRE.map((id) => [id, SANSHA])) };
    const counts = [];
    const planned = [];
    const tradeStub = { fundFromUpkeepInTx: () => ({ ok: true }), readForReview: () => ({ ok: true, trade: { mode: "off" } }),
      planOfferInTx: (db, spec, key) => {
        planned.push({ spec, key });
        return { ok: true, offerId: `offer-${planned.length}` };
      },
      count: (name, n = 1) => counts.push([name, n]), noteRefusal: () => {} };
    const offer = (assigneeCharacterId) => ({ type: "TRADE_OFFER", stationId: 60000001, systemId: THEATRE[0],
      issuerCorporationId: 1000001, itemKind: "type", itemKey: "type:34", typeId: 34, quantity: 10,
      unitPriceMilli: 5000, iskTotal: 50, refPriceMilli: 5000, capPriceMilli: 6000, priceSource: "test",
      expiresAt: START_MS + 10 * I, ...(assigneeCharacterId ? { assigneeCharacterId } : {}) });
    let inject = true;
    const hooks = { beforeEffect: (d) => {
      if (!inject || d.factionId !== SANSHA) return d;
      inject = false;
      return { ...d, intents: [...d.intents, offer(90000001), offer(null),
        { type: "TRADE_CANCEL", offerId: "offer-x", expectedVersion: 1, reason: "test" }] };
    } };
    const env = await bootAll(reopen(), shared, { EVEJS_LNE_STRATEGY_CAMPAIGNS: "none",
      EVEJS_LNE_STRATEGY_ACTIVE_FACTIONS: String(SANSHA), EVEJS_LNE_STRATEGY_MAX_REVIEWS_PER_PASS: "8" },
    { hooks, getTrade: () => tradeStub });
    await passesAt(env, shared, START_MS + I);
    assert.strictEqual(inject, false, "the Sansha review ran");
    assert.strictEqual(planned.length, 2, JSON.stringify(planned));
    assert.strictEqual(planned[0].spec.assigneeCharacterId, 90000001);
    assert.deepStrictEqual(counts.filter(([n]) => n === "offerCreated" || n === "privateOffers"),
      [["offerCreated", 2], ["privateOffers", 1]]);
    const rv = env.strategy.getStatus().ai.review;
    assert.strictEqual(rv.lastRefusal, "TRADE_CANCEL:TRADE_UNAVAILABLE", JSON.stringify(rv));
    assert.ok(rv.counters.tradeOffers === 2 && rv.counters.intentRefused >= 1, JSON.stringify(rv.counters));
    env.strategy.stop("test");
  }));

  needsDriver("HC2 trade refund of the UPKEEP effect: fundFromUpkeepInTx funds 0 -> the refund of a hoardCapped "
    + "faction stops at the hoard ceiling; the same faction without hoardCapped gets the full refund (maxResourceUnits); "
    + "HC3 snapshot.doctrine of readSnapshot carries hoardCapped / raidsBeyondTheatre; RR4 the clipped "
    + "refund bumps strategy.review.upkeepHoardCapped and leaves UPKEEP_HOARD_CAP in the panel (off: neither)",
  async () => {
    const REFUND = 10000;
    const run = (capped) => H.withStore(driver, async (reopen) => {
      const clock = createManualClock(START_MS);
      const shared = { clock, ids: createIdGenerator({ clock, rng: createRng(41) }), graph: graphOf(),
        controllers: new Map(THEATRE.map((id) => [id, SANSHA])) };
      const tradeStub = { fundFromUpkeepInTx: () => ({ ok: true, fundedUnits: 0 }),
        readForReview: () => ({ ok: true, trade: { mode: "off" } }), count: () => {}, noteRefusal: () => {} };
      const seen = { res: null, income: null, doctrine: null };
      const hooks = { beforeEffect: (d, snapshot) => {
        if (seen.res !== null || d.factionId !== SANSHA) return d;
        seen.doctrine = { hoardCapped: snapshot.doctrine.hoardCapped,
          raidsBeyondTheatre: snapshot.doctrine.raidsBeyondTheatre, raidTargets: snapshot.raidTargets };
        if (!capped) snapshot.doctrine.hoardCapped = false;
        seen.res = snapshot.faction.resourceUnits;
        seen.income = Math.ceil((seen.res + 100) / 168);
        const u = d.intents.find((x) => x.type === "UPKEEP") || {};
        const upkeep = { type: "UPKEEP", cost: 0, periods: 1, paidUntilFrom: null, reserveDelta: 0, shortfall: 0,
          unpaidPeriodsTo: 0, abandon: [], paidUntilTo: START_MS + I - ((START_MS + I) % 3600000), ...u,
          income: seen.income, tradeUnits: REFUND, charged: 1, delta: 0 };
        return { ...d, intents: [upkeep], notes: d.notes.filter((n) => n !== "UPKEEP_HOARD_CAP") };
      } };
      const strategyViews = createViewRegistry();
      const env = await bootAll(reopen(), shared, { EVEJS_LNE_STRATEGY_CAMPAIGNS: "none",
        EVEJS_LNE_STRATEGY_ACTIVE_FACTIONS: String(SANSHA), EVEJS_LNE_STRATEGY_MAX_REVIEWS_PER_PASS: "8" },
      { hooks, getTrade: () => tradeStub, strategyViews });
      await passesAt(env, shared, START_MS + I);
      const after = Number(factionRow(env, SANSHA).resource_units);
      const counter = env.strategy.getStatus().ai.review.counters.upkeepHoardCapped || 0;
      const view = strategyViews.getView("factions").getData().factions.find((x) => x.factionId === SANSHA);
      const panelNote = Boolean(view && view.lastReview && view.lastReview.notes.includes("UPKEEP_HOARD_CAP"));
      env.strategy.stop("test");
      return { ...seen, after, counter, panelNote };
    });
    const on = await run(true);
    const off = await run(false);
    assert.ok(Number.isSafeInteger(on.res) && on.res < 168 * on.income, JSON.stringify(on));
    assert.deepStrictEqual({ on: [on.after, on.after <= 168 * on.income], off: off.after, doctrine: on.doctrine,
      rr4: { on: [on.counter >= 1, on.panelNote], off: [off.counter, off.panelNote] } },
      { on: [168 * on.income, true], off: off.res + REFUND,
        doctrine: { hoardCapped: true, raidsBeyondTheatre: false, raidTargets: [] },
        rr4: { on: [true, true], off: [0, false] } }, JSON.stringify({ on: on.counter, off: off.counter }));
  });

  needsDriver("RR3 readSnapshot raid scan in reachJumps (10) of the own ONLINE station: Amarr system "
    + "8 jumps (no station) and 9 jumps (live Amarr station); maxRaidTargets 1 -> [9 jumps] (hostile station first), "
    + "raidTargetPreference false -> [8 jumps], expansionRaidsEnabled false -> []", async () => {
    const C = (i) => 30009100 + i;
    const graphRR = () => {
      const map = k3StaticMap({ extra: Array.from({ length: 11 }, (_, i) => system(C(i), 10000063, 20000997,
        "nullsec")) });
      const link = (a, b) => map.gates.push({ fromSystemId: a, toSystemId: b }, { fromSystemId: b, toSystemId: a });
      link(30004932, C(0));
      for (let i = 1; i <= 10; i += 1) link(C(i - 1), C(i));
      const built = buildUniverseGraph(map);
      assert.ok(built.ok);
      return Object.freeze({ ...built.graph,
        ...createRouteFinder(built.graph, { cacheSize: 64, maxJumps: 40 }).publicApi });
    };
    const run = (env0) => H.withStore(driver, async (reopen) => {
      const clock = createManualClock(START_MS);
      const shared = { clock, ids: createIdGenerator({ clock, rng: createRng(43) }), graph: graphRR(),
        controllers: new Map([[C(8), AMARR], [C(9), AMARR]]) };
      let seen = null;
      const hooks = { beforeEffect: (d, snapshot) => {
        if (seen === null && d.factionId === SERPENTIS) seen = [...snapshot.raidTargets];
        return d;
      } };
      const env = await bootAll(reopen(), shared, { EVEJS_LNE_STRATEGY_CAMPAIGNS: "none",
        EVEJS_LNE_STRATEGY_ACTIVE_FACTIONS: `${AMARR},${SERPENTIS}`, EVEJS_LNE_STRATEGY_MAX_REVIEWS_PER_PASS: "8",
        EVEJS_LNE_STRATEGY_MAX_RAID_TARGETS: "1", ...env0 }, { hooks });
      for (const [stationId, systemId, owner, corp] of [["rr3-serp", C(0), SERPENTIS, 1000135],
        ["rr3-amarr", C(9), AMARR, 1000084]]) {
        const created = env.tx((db) => env.stations.repository.createStation(db, { stationId, kind: "upwell",
          typeId: 35832, structureFamily: "astrahus", systemId, ownerFactionId: owner, ownerCorporationId: corp,
          origin: "built", at: clock.now() }, `rr3:${stationId}`));
        assert.ok(created.ok, JSON.stringify(created));
      }
      await passesAt(env, shared, START_MS + I);
      env.strategy.stop("test");
      return seen;
    });
    const preferred = await run({});
    const plain = await run({ EVEJS_LNE_STRATEGY_RAID_TARGET_PREFERENCE: "false" });
    const off = await run({ EVEJS_LNE_STRATEGY_EXPANSION_RAIDS_ENABLED: "false" });
    assert.deepStrictEqual({ preferred, plain, off }, { preferred: [C(9)], plain: [C(8)], off: [] });
  });

  needsDriver("TB6 applied stockpile / mobilization / private TRADE_OFFERs: trade.stockpileOffers counted from "
    + "the intent, notePlan after the commit with the review time, created split and TRADE_ note codes",
  () => H.withStore(driver, async (reopen) => {
    const clock = createManualClock(START_MS);
    const shared = { clock, ids: createIdGenerator({ clock, rng: createRng(31) }), graph: graphOf(),
      controllers: new Map(THEATRE.map((id) => [id, SANSHA])) };
    const counts = [];
    const plans = [];
    const tradeStub = { fundFromUpkeepInTx: () => ({ ok: true }), readForReview: () => ({ ok: true, trade: { mode: "off" } }),
      planOfferInTx: () => ({ ok: true, offerId: "offer" }), count: (name, n = 1) => counts.push([name, n]),
      noteRefusal: () => {}, notePlan: (f, plan) => plans.push({ f, plan }) };
    const offer = (extra) => ({ type: "TRADE_OFFER", stationId: 60000001, systemId: THEATRE[0],
      issuerCorporationId: 1000001, itemKind: "mineral", itemKey: "type:34", typeId: 34, quantity: 10,
      unitPriceMilli: 5000, iskTotal: 50, refPriceMilli: 5000, capPriceMilli: 6000, priceSource: "test",
      expiresAt: START_MS + 10 * I, ...extra });
    let inject = true;
    const hooks = { beforeEffect: (d) => {
      if (!inject || d.factionId !== SANSHA) return d;
      inject = false;
      return { ...d, intents: [...d.intents, offer({ purpose: "stockpile" }), offer({ purpose: "mobilization" }),
        offer({ assigneeCharacterId: 90000001 })],
      notes: [...d.notes, "TRADE_STOCKPILE_OFFER:type:34@60000001", "TRADE_STOCKPILE_OFFER:type:35@60000001",
        "TRADE_TARGET_REACHED"] };
    } };
    const env = await bootAll(reopen(), shared, { EVEJS_LNE_STRATEGY_CAMPAIGNS: "none",
      EVEJS_LNE_STRATEGY_ACTIVE_FACTIONS: String(SANSHA), EVEJS_LNE_STRATEGY_MAX_REVIEWS_PER_PASS: "8" },
    { hooks, getTrade: () => tradeStub });
    await passesAt(env, shared, START_MS + I);
    assert.strictEqual(inject, false, "the Sansha review ran");
    assert.deepStrictEqual(counts.filter(([n]) => ["offerCreated", "privateOffers", "stockpileOffers"].includes(n)),
      [["offerCreated", 3], ["privateOffers", 1], ["stockpileOffers", 1]]);
    const mine = plans.filter((p) => p.f === SANSHA);
    assert.strictEqual(mine.length, 1, JSON.stringify(plans));
    const plan = mine[0].plan;
    assert.ok(Number.isSafeInteger(plan.at) && plan.at > START_MS && plan.at <= START_MS + I, JSON.stringify(plan));
    assert.deepStrictEqual([plan.tradeReason, plan.created], [null, { mobilization: 1, stockpile: 1, private: 1 }]);
    assert.strictEqual(plan.notes.TRADE_STOCKPILE_OFFER, 2);
    assert.strictEqual(plan.notes.TRADE_TARGET_REACHED, 1);
    assert.deepStrictEqual(Object.keys(plan.notes)[0], "TRADE_STOCKPILE_OFFER", "codes by count desc");
    env.strategy.stop("test");
  }));

  needsDriver("TB8 contract-volume a: TRADE_OFFER passes intent.purpose to the spec "
    + "TRADE_CANCEL passes intent.from only when set, trade.stockpileRecalls counted from the applied RECALLED cancels",
  () => H.withStore(driver, async (reopen) => {
    const clock = createManualClock(START_MS);
    const shared = { clock, ids: createIdGenerator({ clock, rng: createRng(37) }), graph: graphOf(),
      controllers: new Map(THEATRE.map((id) => [id, SANSHA])) };
    const counts = [];
    const planned = [];
    const cancels = [];
    const tradeStub = { fundFromUpkeepInTx: () => ({ ok: true }), readForReview: () => ({ ok: true, trade: { mode: "off" } }),
      planOfferInTx: (db, spec) => {
        planned.push(spec);
        return { ok: true, offerId: "offer" };
      },
      cancelOfferInTx: (db, intent) => {
        cancels.push(intent);
        return { ok: true };
      },
      count: (name, n = 1) => counts.push([name, n]), noteRefusal: () => {}, notePlan: () => {} };
    const offer = (extra) => ({ type: "TRADE_OFFER", stationId: 60000001, systemId: THEATRE[0],
      issuerCorporationId: 1000001, itemKind: "mineral", itemKey: "type:34", typeId: 34, quantity: 10,
      unitPriceMilli: 5000, iskTotal: 50, refPriceMilli: 5000, capPriceMilli: 6000, priceSource: "test",
      expiresAt: START_MS + 10 * I, ...extra });
    let inject = true;
    const hooks = { beforeEffect: (d) => {
      if (!inject || d.factionId !== SANSHA) return d;
      inject = false;
      return { ...d, intents: [...d.intents, offer({ purpose: "stockpile" }), offer({}),
        { type: "TRADE_CANCEL", offerId: "tp_a", expectedVersion: 2, reason: "RECALLED", from: "OPEN" },
        { type: "TRADE_CANCEL", offerId: "tp_b", expectedVersion: 1, reason: "RECALLED", from: "PLANNED" },
        { type: "TRADE_CANCEL", offerId: "to_c", expectedVersion: 1, reason: "EXPIRED" }] };
    } };
    const env = await bootAll(reopen(), shared, { EVEJS_LNE_STRATEGY_CAMPAIGNS: "none",
      EVEJS_LNE_STRATEGY_ACTIVE_FACTIONS: String(SANSHA), EVEJS_LNE_STRATEGY_MAX_REVIEWS_PER_PASS: "8" },
    { hooks, getTrade: () => tradeStub });
    await passesAt(env, shared, START_MS + I);
    assert.strictEqual(inject, false, "the Sansha review ran");
    assert.deepStrictEqual(planned.map((s) => [Object.prototype.hasOwnProperty.call(s, "purpose"), s.purpose]),
      [[true, "stockpile"], [false, undefined]]);
    assert.deepStrictEqual(cancels.map((c) => [c.offerId, c.expectedVersion, c.reason,
      Object.prototype.hasOwnProperty.call(c, "from") ? c.from : "-"]),
    [["tp_a", 2, "RECALLED", "OPEN"], ["tp_b", 1, "RECALLED", "PLANNED"], ["to_c", 1, "EXPIRED", "-"]]);
    assert.deepStrictEqual(counts.filter(([n]) => ["offerCancelled", "stockpileRecalls"].includes(n)),
      [["offerCancelled", 3], ["stockpileRecalls", 2]]);
    env.strategy.stop("test");
  }));

  needsDriver("S2 return through readSnapshot: CONCORD sortie Paye -> Sagain COMPLETED, idle >= "
    + "returnAfterIdleMs -> LAUNCH return -> Paye; the replayed effect is a duplicate; restart in flight -> "
    + "FLEET_OPERATION_COMPLETE -> COMPLETED, IDLE in Paye", () => H.withStore(driver, async (reopen) => {
    const PAYE = 30001718;
    const SAGAIN = 30001719;
    const IDLE_MS = 60000;
    const clock = createManualClock(START_MS);
    const shared = { clock, ids: createIdGenerator({ clock, rng: createRng(17) }), graph: graphOf(),
      controllers: new Map(THEATRE.map((id) => [id, SANSHA])) };
    let lastEffect = null;
    const wrapScheduler = (sch) => ({ ...sch, registerHandler: (type, h, o) => sch.registerHandler(type, (ev, hctx) => {
      const r = h(ev, hctx);
      if (r && r.effect && ev.payload.factionId === CONCORD) lastEffect = r.effect;
      return r;
    }, o) });
    const ENV = { EVEJS_LNE_STRATEGY_CAMPAIGNS: "none", EVEJS_LNE_STRATEGY_BORDER_ENABLED: "0",
      EVEJS_LNE_STRATEGY_MAX_REVIEWS_PER_PASS: "8", EVEJS_LNE_UPKEEP_ENABLED: "0",
      EVEJS_LNE_STRATEGY_RETURN_AFTER_IDLE_MS: String(IDLE_MS), EVEJS_LNE_STRATEGY_RETURN_WINDOW_MS: "60000" };
    const opened = reopen();
    const env = await bootAll(opened, shared, ENV, { wrapScheduler });
    const ok = (r) => {
      assert.ok(r && r.ok, JSON.stringify(r));
      return r;
    };
    const fleetId = ok(env.fleets.createFleet({ factionId: CONCORD, currentSystemId: PAYE, homeSystemId: PAYE,
      fleetRole: "patrol", composition: [{ hullGroup: "frigate", count: 3 }, { hullGroup: "destroyer", count: 3 }] },
    "s2:fleet")).fleetId;
    const sortie = ok(env.fleets.createOperation({ operationType: "patrol", factionId: CONCORD, originSystemId: PAYE,
      targetSystemId: SAGAIN, objective: "patrol", dueAt: START_MS, fleets: [{ fleetId, expectedVersion: 1 }] },
    "s2:sortie")).operationId;
    ok(env.fleets.planTravel({ fleetId, targetSystemId: SAGAIN }, "s2:go"));
    const fleetRow = (e) => e.q("SELECT state, current_system_id AS sys, operation_id AS op, updated_at AS u "
      + "FROM virtual_fleets WHERE fleet_id = ?", fleetId)[0];
    const opRows = (e) => opsOf(e, CONCORD).map((o) => [o.operation_type, o.objective, o.target_system_id, o.state]);
    assert.ok(await driveUntil(env, shared, START_MS + I - IDLE_MS, 30000, () => fleetRow(env).state === "IDLE"),
      JSON.stringify(fleetRow(env)));
    assert.deepStrictEqual(opRows(env), [["patrol", "patrol", SAGAIN, "COMPLETED"]]);
    assert.deepStrictEqual([fleetRow(env).sys, fleetRow(env).op], [SAGAIN, null]);
    assert.ok(opsOf(env, CONCORD)[0].operation_id === sortie);

    await passesAt(env, shared, START_MS + I);
    assert.deepStrictEqual(opRows(env), [["patrol", "patrol", SAGAIN, "COMPLETED"], ["return", "return", PAYE, "ACTIVE"]],
      env.lines.join("\n"));
    assert.strictEqual(fleetRow(env).state, "TRAVELLING");
    const c = env.strategy.getStatus().ai.review.counters;
    assert.deepStrictEqual([c.returns, c.recon, c.attacks], [1, 0, 0], "a return is its own counter");
    assert.ok(env.lines.some((l) => l.startsWith(`strategy: ${CONCORD} r`) && l.includes(`launch return -> ${PAYE}`)),
      env.lines.join("\n"));
    const replay = env.tx((db) => lastEffect(db));
    assert.ok(replay.ok && replay.applied.LAUNCH === undefined, JSON.stringify(replay));
    assert.strictEqual(opsOf(env, CONCORD).length, 2);

    env.strategy.stop("restart");
    opened.store.close("restart");
    const env2 = await bootAll(reopen(), shared, ENV);
    assert.ok(await driveUntil(env2, shared, START_MS + 3 * I, 60000,
      () => opsOf(env2, CONCORD).some((o) => o.operation_type === "return" && o.state === "COMPLETED")),
    JSON.stringify(opRows(env2)));
    assert.deepStrictEqual(opRows(env2), [["patrol", "patrol", SAGAIN, "COMPLETED"],
      ["return", "return", PAYE, "COMPLETED"]]);
    assert.deepStrictEqual([fleetRow(env2).state, fleetRow(env2).sys, fleetRow(env2).op], ["IDLE", PAYE, null],
      "docked = IDLE in the system of the own station");
    await passesAt(env2, shared, START_MS + 4 * I);
    assert.strictEqual(opsOf(env2, CONCORD).length, 2);
    env2.strategy.stop("test");
  }));

  needsDriver("D6 defenseEnabled=false: threatened home + idle defense fleets -> 0 defenses, no LAUNCH defense", () => H.withStore(driver, async (reopen) => {
    const clock = createManualClock(START_MS);
    const shared = { clock, ids: createIdGenerator({ clock, rng: createRng(31) }), graph: graphOf(),
      controllers: new Map(THEATRE.map((id) => [id, SANSHA])) };
    const THREATENED = 30001953;
    shared.controllers.set(THREATENED, AMARR);
    shared.controllers.set(SAMINER, AMARR);

    const baseFake = fakeWorld(shared.controllers);
    const world = {
      repository: {
        ...baseFake.repository,
        listThreatened: (tx, factionId, opts) => {
          if (factionId !== AMARR) return { ok: true, systems: [] };
          return {
            ok: true,
            systems: [{
              systemId: THREATENED,
              controllerFactionId: AMARR,
              occupationState: "INVASION",
              occupierFactionId: SANSHA,
              phaseDueAt: START_MS + I,
              influence: [{ factionId: SANSHA, garrisonStrength: 1000 }]
            }]
          };
        },
        listLostHome: (tx, factionId, opts) => ({ ok: true, systems: [] }),
        listByOccupier: (tx, factionId, opts) => ({ ok: true, systems: [] }),
        listControlledByFaction: (tx, factionId, opts) => ({ ok: true, systems: [] }),
        countControlledByFaction: (tx, factionId) => ({ ok: true, count: 1 })
      }
    };

    const defenseFleet = (fleetId, systemId) => ({ factionId: AMARR, currentSystemId: systemId,
      homeSystemId: systemId, fleetRole: "patrol", composition: [{ hullGroup: "cruiser", count: 4 }] });

    const ENV_OFF = { EVEJS_LNE_STRATEGY_ACTIVE_FACTIONS: String(AMARR),
      EVEJS_LNE_STRATEGY_DEFENSE_ENABLED: "0", EVEJS_LNE_STRATEGY_MAX_REVIEWS_PER_PASS: "8",
      EVEJS_LNE_UPKEEP_ENABLED: "0", EVEJS_LNE_STRATEGY_BORDER_ENABLED: "0" };
    const envOff = await bootAll(reopen(), shared, ENV_OFF, { world });
    const f1 = envOff.fleets.createFleet(defenseFleet("d6-f1", SAMINER), "d6:f1");
    assert.ok(f1.ok, JSON.stringify(f1));
    const f2 = envOff.fleets.createFleet(defenseFleet("d6-f2", SAMINER), "d6:f2");
    assert.ok(f2.ok, JSON.stringify(f2));

    await passesAt(envOff, shared, START_MS + I);

    const countersOff = envOff.strategy.getStatus().ai.review.counters;
    assert.strictEqual(countersOff.defenses, 0, "defenseEnabled=false -> zero defenses");
    assert.ok(!envOff.lines.some((l) => l.includes('launch defense ->')),
      "no LAUNCH kind defense when disabled: " + envOff.lines.join("\n"));

    envOff.strategy.stop("test");
  }));

  needsDriver("defenseEnabled=true (defaults): threatened home + idle defense fleets -> 1 defense, LAUNCH kind defense", () => H.withStore(driver, async (reopen) => {
    const clock = createManualClock(START_MS);
    const shared = { clock, ids: createIdGenerator({ clock, rng: createRng(32) }), graph: graphOf(),
      controllers: new Map(THEATRE.map((id) => [id, SANSHA])) };
    const THREATENED = 30001953;
    shared.controllers.set(THREATENED, AMARR);
    shared.controllers.set(SAMINER, AMARR);

    const world = {
      repository: {
        ...fakeWorld(shared.controllers).repository,
        listThreatened: (tx, factionId, opts) => {
          if (factionId !== AMARR) return { ok: true, systems: [] };
          return {
            ok: true,
            systems: [{
              systemId: THREATENED,
              controllerFactionId: AMARR,
              occupationState: "INVASION",
              occupierFactionId: SANSHA,
              phaseDueAt: START_MS + I,
              influence: [{ factionId: SANSHA, garrisonStrength: 1000 }]
            }]
          };
        },
        listLostHome: (tx, factionId, opts) => ({ ok: true, systems: [] }),
        listByOccupier: (tx, factionId, opts) => ({ ok: true, systems: [] }),
        listControlledByFaction: (tx, factionId, opts) => ({ ok: true, systems: [] }),
        countControlledByFaction: (tx, factionId) => ({ ok: true, count: 1 })
      }
    };

    const defenseFleet = (fleetId, systemId) => ({ factionId: AMARR, currentSystemId: systemId,
      homeSystemId: systemId, fleetRole: "patrol", composition: [{ hullGroup: "cruiser", count: 4 }] });

    const ENV_ON = { EVEJS_LNE_STRATEGY_ACTIVE_FACTIONS: String(AMARR),
      EVEJS_LNE_STRATEGY_MAX_REVIEWS_PER_PASS: "8", EVEJS_LNE_UPKEEP_ENABLED: "0",
      EVEJS_LNE_STRATEGY_BORDER_ENABLED: "0",
      EVEJS_LNE_STRATEGY_REACTIVE_ENABLED: "0" };
    const envOn = await bootAll(reopen(), shared, ENV_ON, { world });
    const f1 = envOn.fleets.createFleet(defenseFleet("d6b-f1", SAMINER), "d6b:f1");
    assert.ok(f1.ok, JSON.stringify(f1));
    const f2 = envOn.fleets.createFleet(defenseFleet("d6b-f2", SAMINER), "d6b:f2");
    assert.ok(f2.ok, JSON.stringify(f2));

    await passesAt(envOn, shared, START_MS + I);

    const countersOn = envOn.strategy.getStatus().ai.review.counters;
    assert.strictEqual(countersOn.defenses, 1, "defaults -> one defense");
    assert.ok(envOn.lines.some((l) => l.includes('launch defense ->')),
      "LAUNCH kind defense present when enabled: " + envOn.lines.join("\n"));

    envOn.strategy.stop("test");
  }));

  needsDriver("D5 relief through the review: ctx.siege = stub -> snapshot siege off, no defense (DoD 13) "
    + "siege ready with a besieged own station -> LAUNCH defense written (operation + fleet plan), counter reliefs, "
    + "not recon", () => H.withStore(driver, async (reopen) => {
    const clock = createManualClock(START_MS);
    const shared = { clock, ids: createIdGenerator({ clock, rng: createRng(19) }), graph: graphOf(),
      controllers: new Map(THEATRE.map((id) => [id, SANSHA])) };
    const holder = { siege: createUnavailableSiege("test") };
    const seen = [];
    const hooks = { beforeEffect: (d, s) => {
      if (d.factionId === AMARR) seen.push(s.siege);
      return d;
    } };
    const ENV = { EVEJS_LNE_STRATEGY_CAMPAIGNS: "none", EVEJS_LNE_STRATEGY_BORDER_ENABLED: "0",
      EVEJS_LNE_STRATEGY_MAX_REVIEWS_PER_PASS: "8", EVEJS_LNE_UPKEEP_ENABLED: "0",
      EVEJS_LNE_STRATEGY_RETURN_AFTER_IDLE_MS: "86400000" };
    const env = await bootAll(reopen(), shared, ENV, { hooks, getSiege: () => holder.siege });
    const own = env.q("SELECT station_id AS id, system_id AS sys FROM world_stations WHERE owner_faction_id = ? "
      + "AND kind = 'upwell' ORDER BY station_id", AMARR)[0];
    assert.ok(own, "Amarr has a start station");
    const from = [...shared.graph.getNeighbors(own.sys)].sort((a, b) => a - b)[0];
    const made = env.fleets.createFleet({ factionId: AMARR, currentSystemId: from, homeSystemId: own.sys,
      fleetRole: "patrol", composition: [{ hullGroup: "cruiser", count: 4 }] }, "d5:fleet");
    assert.ok(made.ok, JSON.stringify(made));
    const defense = () => opsOf(env, AMARR).filter((o) => o.operation_type === "defense");

    await passesAt(env, shared, START_MS + I);
    assert.deepStrictEqual(seen[seen.length - 1], { mode: "off", attacking: [], defending: [], truncated: false });
    assert.deepStrictEqual(defense(), [], "stub: no relief");

    holder.siege = { getMode: () => "ready", readForFaction: (db, f) => ({ ok: true, attacking: [], truncated: false,
      defending: f === AMARR ? [{ siegeId: "sg_d5", stationId: own.id, systemId: own.sys, state: "SHIELD_ASSAULT",
        phaseEndsAt: START_MS + 3 * I, attackerFactionId: SANSHA, attackerStrength: 1 }] : [] }) };
    await passesAt(env, shared, START_MS + 2 * I);
    assert.strictEqual(seen[seen.length - 1].mode, "ready");
    assert.deepStrictEqual(defense().map((o) => [o.target_system_id, o.state, o.objective]),
      [[own.sys, "ACTIVE", "hold"]], env.lines.join("\n"));
    assert.strictEqual(fleetsOf(env, AMARR).find((x) => x.fleet_id === made.fleetId).state, "TRAVELLING");
    const c = env.strategy.getStatus().ai.review.counters;
    assert.strictEqual(c.reliefs, 1);
    assert.ok(env.lines.some((l) => l.includes(`launch defense -> ${own.sys}`)), env.lines.join("\n"));
    await passesAt(env, shared, START_MS + 3 * I);
    assert.strictEqual(defense().length, 1);
    env.strategy.stop("test");
  }));

  needsDriver("D7 lostHome cursor pagination across reviews + restart: fake listLostHome honors "
    + "afterSystemId/limit on 5 homes, records calls, EVEJS_LNE_STRATEGY_MAX_LOST_HOME_READ=2 -> "
    + "limit=3; 4 reviews give afterSystemId = 0, h1, h3, 0; lostHomeTruncated=3; restart -> cursor resets to 0", () => H.withStore(driver, async (reopen) => {
    const clock = createManualClock(START_MS);
    const shared = { clock, ids: createIdGenerator({ clock, rng: createRng(41) }), graph: graphOf(),
      controllers: new Map(THEATRE.map((id) => [id, SANSHA])) };
    const AMARR_F = AMARR;
    const homes = [30001960, 30001961, 30001962, 30001963, 30001964];
    homes.forEach((id) => shared.controllers.set(id, SANSHA));
    const calls = [];
    const fakeListLostHome = (tx, factionId, opts) => {
      const after = opts.afterSystemId === undefined ? 0 : opts.afterSystemId;
      const limit = opts.limit;
      calls.push({ afterSystemId: after, limit });
      const page = homes.filter((sid) => sid > after).sort((a, b) => a - b).slice(0, limit);
      const systems = page.map((systemId) => ({
        systemId,
        controllerFactionId: SANSHA,
        occupationState: "STABLE",
        occupierFactionId: null,
        homeFactionId: AMARR_F,
        influence: [{ factionId: AMARR_F, influenceScore: 50 }, { factionId: SANSHA, influenceScore: 60 }]
      }));
      const next = page.length === limit ? page[page.length - 1] : null;
      return { ok: true, systems, nextAfterSystemId: next };
    };
    const baseFake = fakeWorld(shared.controllers);
    const world = {
      repository: {
        ...baseFake.repository,
        listThreatened: (tx, factionId, opts) => ({ ok: true, systems: [] }),
        listLostHome: fakeListLostHome,
        listByOccupier: (tx, factionId, opts) => ({ ok: true, systems: [] }),
        listControlledByFaction: (tx, factionId, opts) => ({ ok: true, systems: [] }),
        countControlledByFaction: (tx, factionId) => ({ ok: true, count: 5 })
      }
    };

    const ENV = {
      EVEJS_LNE_STRATEGY_ACTIVE_FACTIONS: String(AMARR_F),
      EVEJS_LNE_STRATEGY_MAX_REVIEWS_PER_PASS: "8",
      EVEJS_LNE_UPKEEP_ENABLED: "0",
      EVEJS_LNE_STRATEGY_BORDER_ENABLED: "0",
      EVEJS_LNE_STRATEGY_MAX_LOST_HOME_READ: "2"
    };
    const opened = reopen();
    const env = await bootAll(opened, shared, ENV, { world });
    assert.strictEqual(env.strategy.getStatus().ai.state, "on");

    await passesAt(env, shared, START_MS + I);
    await passesAt(env, shared, START_MS + 2 * I);
    await passesAt(env, shared, START_MS + 3 * I);
    await passesAt(env, shared, START_MS + 4 * I);

    assert.strictEqual(calls.length, 4, "one listLostHome call per review");
    assert.deepStrictEqual(calls[0], { afterSystemId: 0, limit: 3 });
    assert.deepStrictEqual(calls[1], { afterSystemId: homes[1], limit: 3 });
    assert.deepStrictEqual(calls[2], { afterSystemId: homes[3], limit: 3 });
    assert.deepStrictEqual(calls[3], { afterSystemId: 0, limit: 3 });

    const c = env.strategy.getStatus().ai.review.counters;
    assert.strictEqual(c.lostHomeTruncated, 3, `lostHomeTruncated=${c.lostHomeTruncated}, expected 3`);

    const reliefs = c.reliefs;
    assert.ok(Number.isInteger(reliefs) && reliefs >= 0, `reliefs=${reliefs} is a non-negative integer`);

    env.strategy.stop("restart");
    opened.store.close("restart");
    const opened2 = reopen();
    const env2 = await bootAll(opened2, shared, ENV, { world });
    assert.strictEqual(env2.strategy.getStatus().ai.state, "on");

    await passesAt(env2, shared, START_MS + 5 * I);

    assert.strictEqual(calls.length, 5, "one more call after restart");
    assert.deepStrictEqual(calls[4], { afterSystemId: 0, limit: 3 });

    env2.strategy.stop("test");
  }));

  const TRIBUTE_ENV = Object.freeze({ EVEJS_LNE_STRATEGY_ACTIVE_FACTIONS: `${AMARR},${CONCORD}`,
    EVEJS_LNE_STRATEGY_CAMPAIGNS: "none", EVEJS_LNE_STRATEGY_MAX_REVIEWS_PER_PASS: "8", EVEJS_LNE_UPKEEP_ENABLED: "0" });
  const MINERAL_KEYS = [...new Set(Object.values(RECIPES.GROUPS).flatMap((r) => Object.keys(r.minerals)))].sort();
  async function tributeBoot(opened, shared, env, holder) {
    const hooks = { beforeEffect: (d, snapshot) => {
      holder.seen.push({ f: d.factionId, notes: [...d.notes], intents: d.intents, snapshot });
      return (holder.mutate && holder.mutate(d)) || d;
    } };
    const e = await bootAll(opened, shared, { ...TRIBUTE_ENV, ...env }, { hooks, production: true, logistics: true,
      strategyViews: holder.views });
    const stationOf = (f) => e.q("SELECT station_id AS id, system_id AS sys FROM world_stations WHERE owner_faction_id = ? "
      + "AND state = 'ONLINE' AND kind = 'upwell' ORDER BY station_id", f)[0];
    return { e, pay: stationOf(AMARR), rcv: stationOf(CONCORD) };
  }
  const tributeSeed = (e, stationId, deltas, key) => assert.ok(e.tx((db) => e.stations.repository.applyStockChange(db,
    { stationId, key, reason: "TEST", at: START_MS, deltas })).ok);
  const richDeltas = MINERAL_KEYS.map((k) => ({ itemKind: "mineral", itemKey: k, delta: 200000000 }));
  const amarrHauler = (e, tag) => {
    const r = e.fleets.createFleet({ factionId: AMARR, currentSystemId: SAMINER, homeSystemId: SAMINER,
      fleetRole: "logistics", composition: [{ hullGroup: "industrial", count: 2 }, { hullGroup: "frigate", count: 2 }] },
    tag);
    assert.ok(r.ok, JSON.stringify(r));
    return r.fleetId;
  };
  const tributeConvoys = (e) => e.q("SELECT faction_id AS f, source_station_id AS src, dest_station_id AS dst "
    + "FROM world_convoys WHERE purpose = 'TRIBUTE' ORDER BY convoy_id").map((c) => [c.f, c.src, c.dst]);
  const tributeMarkers = (e) => e.q("SELECT idempotency_key AS k, event_type AS t FROM world_event_journal "
    + "WHERE idempotency_key LIKE 'tribute:%' ORDER BY journal_id").map((x) => [x.k, x.t]);
  const tributeNotes = (seen) => seen.flatMap((x) => x.notes).filter((n) => n.startsWith("TRIBUTE_"));
  const tributeIntents = (seen) => seen.flatMap((x) => x.intents).filter((i) => i.purpose === "TRIBUTE");
  const stopAll = (e) => ["logistics", "production", "strategy"].forEach((k) => e[k] && e[k].stop("test"));
  const panelNotes = (holder) => {
    const v = holder.views.getView("factions").getData().factions.find((x) => x.factionId === AMARR);
    return v && v.lastReview ? [...v.lastReview.notes] : null;
  };

  needsDriver("TB2 concord-empire-tribute review: one TRIBUTE convoy + marker tribute:<f>:<bucket> per period "
    + "(logistics.tributeDispatched 1); the next review of the bucket and a restart plan nothing; a permanent refusal "
    + "(DEST_INVALID) forfeits the period: marker, no convoy, log line, the next review plans nothing",
  () => H.withStore(driver, async (reopen) => {
    const clock = createManualClock(START_MS);
    const shared = { clock, ids: createIdGenerator({ clock, rng: createRng(41) }), graph: graphOf(),
      controllers: new Map(THEATRE.map((id) => [id, SANSHA])) };
    const holder = { seen: [], mutate: null, views: createViewRegistry() };
    const opened = reopen();
    const { e: env, pay, rcv } = await tributeBoot(opened, shared, { EVEJS_LNE_TRIBUTE_ENABLED: "1" }, holder);
    assert.ok(pay && rcv && pay.sys === SAMINER, JSON.stringify([pay, rcv]));
    tributeSeed(env, pay.id, richDeltas, "tb2:seed");
    amarrHauler(env, "tb2:h1");
    amarrHauler(env, "tb2:h2");

    await passesAt(env, shared, START_MS + I);
    const first = holder.seen.filter((x) => x.f === AMARR);
    assert.strictEqual(first.length, 1, JSON.stringify(holder.seen.map((x) => [x.f, x.notes])));
    const T = first[0].snapshot.tribute;
    assert.deepStrictEqual([T.mode, T.paid, T.bucket, T.recipientFactionId, T.recipientStations.map((s) => s.stationId)],
      ["ready", false, Math.floor(first[0].snapshot.at / 86400000), CONCORD, [rcv.id]]);
    assert.deepStrictEqual(tributeIntents(first).map((i) => [i.sourceStationId, i.destStationId, i.tributeBucket]),
      [[pay.id, rcv.id, T.bucket]]);
    assert.ok(tributeNotes(first).includes("TRIBUTE_DISPATCHED"), JSON.stringify(first[0].notes));
    assert.deepStrictEqual(tributeConvoys(env), [[AMARR, pay.id, rcv.id]]);
    assert.deepStrictEqual(tributeMarkers(env), [[`tribute:${AMARR}:${T.bucket}`, "TRIBUTE_PAID"]]);
    assert.strictEqual(env.logistics.getStatus().counters.tributeDispatched, 1, "emitted after the commit");
    assert.strictEqual(env.logistics.getStatus().counters.tributeForfeited, 0);
    const sentNotes = panelNotes(holder);
    assert.ok(sentNotes && sentNotes.includes("TRIBUTE_DISPATCHED") && !sentNotes.includes("TRIBUTE_FORFEITED"),
      JSON.stringify(sentNotes));

    holder.seen.length = 0;
    await passesAt(env, shared, START_MS + 2 * I);
    const second = holder.seen.filter((x) => x.f === AMARR);
    assert.ok(second.length === 1 && second[0].snapshot.tribute.paid === true, JSON.stringify(second.map((x) => x.notes)));
    assert.deepStrictEqual([tributeNotes(second), tributeIntents(second).length, tributeConvoys(env).length,
      tributeMarkers(env).length], [[], 0, 1, 1]);

    stopAll(env);
    opened.store.close("restart");
    holder.seen.length = 0;
    const { e: env2 } = await tributeBoot(reopen(), shared, { EVEJS_LNE_TRIBUTE_ENABLED: "1" }, holder);
    await passesAt(env2, shared, START_MS + 3 * I);
    const third = holder.seen.filter((x) => x.f === AMARR);
    assert.ok(third.length >= 1 && third.every((x) => x.snapshot.tribute.paid === true));
    assert.deepStrictEqual([tributeNotes(third), tributeConvoys(env2).length, tributeMarkers(env2).length], [[], 1, 1]);
    stopAll(env2);
  }).then(() => H.withStore(driver, async (reopen) => {
    const clock = createManualClock(START_MS);
    const shared = { clock, ids: createIdGenerator({ clock, rng: createRng(43) }), graph: graphOf(),
      controllers: new Map(THEATRE.map((id) => [id, SANSHA])) };
    const holder = { seen: [], mutate: null, views: createViewRegistry() };
    const { e: env, pay } = await tributeBoot(reopen(), shared, { EVEJS_LNE_TRIBUTE_ENABLED: "1" }, holder);
    tributeSeed(env, pay.id, richDeltas, "tb2b:seed");
    amarrHauler(env, "tb2b:h1");
    amarrHauler(env, "tb2b:h2");
    holder.mutate = (d) => (d.factionId === AMARR ? { ...d, intents: d.intents.map((i) => (i.purpose === "TRIBUTE"
      ? { ...i, destStationId: pay.id } : i)) } : null);
    await passesAt(env, shared, START_MS + I);
    const first = holder.seen.filter((x) => x.f === AMARR);
    assert.strictEqual(tributeIntents(first).length, 1, "the planner sent it, the effect forfeits it");
    assert.deepStrictEqual([tributeConvoys(env), tributeMarkers(env).length], [[], 1]);
    assert.ok(env.lines.some((l) => l.startsWith(`strategy: ${AMARR} r`) && l.endsWith("tribute forfeited DEST_INVALID")),
      env.lines.join("\n"));
    assert.strictEqual(env.logistics.getStatus().counters.tributeDispatched, 0);
    assert.deepStrictEqual([env.logistics.getStatus().counters.dispatched,
      env.q("SELECT count(*) AS n FROM world_convoys")[0].n], [0, 0]);
    assert.ok(tributeNotes(first).includes("TRIBUTE_DISPATCHED"), JSON.stringify(first[0].notes));
    const lostNotes = panelNotes(holder);
    assert.ok(lostNotes && lostNotes.includes("TRIBUTE_FORFEITED") && !lostNotes.includes("TRIBUTE_DISPATCHED"),
      JSON.stringify(lostNotes));
    assert.strictEqual(lostNotes.filter((n) => n === "TRIBUTE_FORFEITED").length, 1, JSON.stringify(lostNotes));
    assert.strictEqual(env.logistics.getStatus().counters.tributeForfeited, 1, "INFO: the forfeit counted after commit");
    holder.mutate = null;
    holder.seen.length = 0;
    await passesAt(env, shared, START_MS + 2 * I);
    const next = holder.seen.filter((x) => x.f === AMARR);
    assert.ok(next.length === 1 && next[0].snapshot.tribute.paid === true);
    assert.deepStrictEqual([tributeNotes(next), tributeIntents(next).length, tributeConvoys(env).length], [[], 0, 0]);
    stopAll(env);
  })));

  needsDriver("TF2/TF3 tribute forfeit note: an intent bucket other than the snapshot's -> "
    + "TRIBUTE_STALE (no convoy, no marker), the next review pays; a copy of the paid intent in the same bucket -> "
    + "TRIBUTE_ALREADY_PAID (still 1 convoy, 1 marker, tributeForfeited 0)",
  () => H.withStore(driver, async (reopen) => {
    const clock = createManualClock(START_MS);
    const shared = { clock, ids: createIdGenerator({ clock, rng: createRng(53) }), graph: graphOf(),
      controllers: new Map(THEATRE.map((id) => [id, SANSHA])) };
    const holder = { seen: [], mutate: null, views: createViewRegistry() };
    const { e: env, pay } = await tributeBoot(reopen(), shared, { EVEJS_LNE_TRIBUTE_ENABLED: "1" }, holder);
    tributeSeed(env, pay.id, richDeltas, "tf:seed");
    amarrHauler(env, "tf:h1");
    amarrHauler(env, "tf:h2");
    const lgStatus = () => env.logistics.getStatus();

    holder.mutate = (d) => (d.factionId === AMARR ? { ...d, intents: d.intents.filter((i) => i.type !== "PRODUCE")
      .map((i) => (i.purpose === "TRIBUTE" ? { ...i, tributeBucket: i.tributeBucket + 1 } : i)) } : null);
    await passesAt(env, shared, START_MS + I);
    assert.strictEqual(tributeIntents(holder.seen.filter((x) => x.f === AMARR)).length, 1);
    assert.deepStrictEqual([tributeConvoys(env).length, tributeMarkers(env).length, lgStatus().counters.dispatchRefused,
      lgStatus().lastRefusal, lgStatus().counters.tributeDispatched, lgStatus().counters.tributeForfeited],
    [0, 0, 1, "dispatch:TRIBUTE_STALE", 0, 0]);

    holder.mutate = null;
    holder.seen.length = 0;
    await passesAt(env, shared, START_MS + 2 * I);
    const paid = holder.seen.filter((x) => x.f === AMARR);
    assert.ok(paid.length === 1 && paid[0].snapshot.tribute.paid === false, JSON.stringify(paid.map((x) => x.notes)));
    const T = paid[0].snapshot.tribute;
    const paidIntent = tributeIntents(paid)[0];
    assert.ok(paidIntent && paidIntent.tributeBucket === T.bucket, JSON.stringify([paidIntent, paid[0].notes]));
    assert.deepStrictEqual([tributeConvoys(env).length, tributeMarkers(env), lgStatus().counters.tributeDispatched],
      [1, [[`tribute:${AMARR}:${T.bucket}`, "TRIBUTE_PAID"]], 1]);

    holder.mutate = (d) => (d.factionId === AMARR ? { ...d, intents: [...d.intents, { ...paidIntent }] } : null);
    holder.seen.length = 0;
    await passesAt(env, shared, START_MS + 3 * I);
    const again = holder.seen.filter((x) => x.f === AMARR);
    assert.ok(again.length === 1 && again[0].snapshot.tribute.paid === true && again[0].snapshot.tribute.bucket === T.bucket,
      JSON.stringify(again.map((x) => x.snapshot.tribute)));
    assert.deepStrictEqual([tributeConvoys(env).length, tributeMarkers(env).length, lgStatus().lastRefusal,
      lgStatus().counters.tributeDispatched, lgStatus().counters.tributeForfeited],
    [1, 1, "dispatch:TRIBUTE_ALREADY_PAID", 1, 0]);
    stopAll(env);
  }));

  needsDriver("TB3 concord-empire-tribute tribute.enabled=false: no snapshot.tribute, no TRIBUTE_* note / intent / "
    + "marker, CONCORD hullsRequired false; on + recipientBuildsHulls: CONCORD hullsRequired true, Amarr unchanged "
    + "(true); TN2 on + defaults: CONCORD hullsRequired false, Amarr true, 1 convoy", async () => {
    const run = (env) => H.withStore(driver, async (reopen) => {
      const clock = createManualClock(START_MS);
      const shared = { clock, ids: createIdGenerator({ clock, rng: createRng(47) }), graph: graphOf(),
        controllers: new Map(THEATRE.map((id) => [id, SANSHA])) };
      const holder = { seen: [], mutate: null };
      const { e, pay } = await tributeBoot(reopen(), shared, env, holder);
      tributeSeed(e, pay.id, richDeltas, "tb3:seed");
      amarrHauler(e, "tb3:h1");
      await passesAt(e, shared, START_MS + I);
      const of = (f) => holder.seen.filter((x) => x.f === f);
      assert.ok(of(AMARR).length === 1 && of(CONCORD).length === 1, JSON.stringify(holder.seen.map((x) => x.f)));
      const out = { amarr: of(AMARR)[0], concord: of(CONCORD)[0], convoys: tributeConvoys(e).length,
        markers: tributeMarkers(e).length, notes: tributeNotes(holder.seen), intents: tributeIntents(holder.seen).length };
      stopAll(e);
      return out;
    });
    const off = await run({});
    assert.deepStrictEqual(["tribute" in off.amarr.snapshot, "tribute" in off.concord.snapshot, off.notes, off.intents,
      off.convoys, off.markers], [false, false, [], 0, 0, 0]);
    assert.deepStrictEqual([off.concord.snapshot.doctrine.hullsRequired, off.amarr.snapshot.doctrine.hullsRequired],
      [false, true]);
    const on = await run({ EVEJS_LNE_TRIBUTE_ENABLED: "1", EVEJS_LNE_TRIBUTE_RECIPIENT_BUILDS_HULLS: "1" });
    assert.deepStrictEqual([on.concord.snapshot.doctrine.hullsRequired, on.amarr.snapshot.doctrine.hullsRequired,
      on.concord.snapshot.tribute.mode, on.amarr.snapshot.tribute.mode, on.convoys], [true, true, "none", "ready", 1]);
    const plain = await run({ EVEJS_LNE_TRIBUTE_ENABLED: "1" });
    assert.deepStrictEqual([plain.concord.snapshot.doctrine.hullsRequired, plain.amarr.snapshot.doctrine.hullsRequired,
      plain.amarr.snapshot.tribute.mode, plain.convoys], [false, true, "ready", 1]);
  });

  needsDriver("TB4 concord-empire-tribute CONCORD without miners builds hulls from the tribute: a TRIBUTE convoy "
    + "(dispatchInTx, as TA2) delivers frigate minerals to Paye, the next CONCORD review gives PRODUCE in Paye and an "
    + "ACTIVE job that consumes them; findLastEndedOfFaction on the real facade = DELIVERED",
  () => H.withStore(driver, async (reopen) => {
    const clock = createManualClock(START_MS);
    const shared = { clock, ids: createIdGenerator({ clock, rng: createRng(53) }), graph: graphOf(),
      controllers: new Map(THEATRE.map((id) => [id, SANSHA])) };
    const holder = { seen: [], mutate: null };
    const { e: env, pay, rcv } = await tributeBoot(reopen(), shared, { EVEJS_LNE_TRIBUTE_ENABLED: "1",
      EVEJS_LNE_TRIBUTE_RECIPIENT_BUILDS_HULLS: "1" }, holder);
    const RUNS = 4;
    const minerals = Object.entries(RECIPES.GROUPS.frigate.minerals).sort();
    tributeSeed(env, pay.id, minerals.map(([k, v]) => ({ itemKind: "mineral", itemKey: k, delta: v * RUNS })),
      "tb4:seed");
    const hauler = amarrHauler(env, "tb4:h1");
    const version = env.tx((db) => env.fleets.repository.getFleet(db, hauler)).fleet.version;
    const d = env.tx((db) => env.logistics.dispatchInTx(db, { factionId: AMARR, fleetId: hauler,
      expectedVersion: version, purpose: "TRIBUTE", sourceStationId: pay.id, destStationId: rcv.id,
      items: minerals.map(([k, v]) => ({ itemKind: "mineral", itemKey: k, quantity: v * RUNS })), at: clock.now() },
    "tb4:dispatch"));
    assert.deepStrictEqual([d.ok, d.state], [true, "IN_TRANSIT"], JSON.stringify(d));
    assert.deepStrictEqual(LH.stockOf(env, rcv.id), {}, "CONCORD starts without minerals and without miners");
    const convoyState = () => LH.convoyOf(env, d.convoyId).state;
    assert.ok(await driveUntil(env, shared, START_MS + 20 * I, I / 4, () => convoyState() === "DELIVERED"),
      convoyState());
    const got = LH.stockOf(env, rcv.id);
    assert.deepStrictEqual(got, Object.fromEntries(minerals.map(([k, v]) => [`mineral/${k}`, v * RUNS])));
    assert.strictEqual(typeof env.logistics.findLastEndedOfFaction, "function");
    const last = env.tx((db) => env.logistics.findLastEndedOfFaction(db, AMARR, "TRIBUTE"));
    assert.deepStrictEqual([last.ok, last.convoy.convoyId, last.convoy.state], [true, d.convoyId, "DELIVERED"]);

    holder.seen.length = 0;
    await passesAt(env, shared, clock.now() + I);
    const produce = holder.seen.filter((x) => x.f === CONCORD).flatMap((x) => x.intents)
      .filter((i) => i.type === "PRODUCE");
    assert.ok(produce.length >= 1 && produce.every((i) => i.stationId === rcv.id), JSON.stringify(holder.seen
      .filter((x) => x.f === CONCORD).map((x) => x.notes)));
    const jobs = env.q("SELECT station_id AS s, state FROM world_production_jobs WHERE faction_id = ?", CONCORD);
    assert.ok(jobs.length >= 1 && jobs.every((j) => j.s === rcv.id && j.state === "ACTIVE"), JSON.stringify(jobs));
    const left = LH.stockOf(env, rcv.id);
    assert.ok(minerals.some(([k]) => (left[`mineral/${k}`] || 0) < got[`mineral/${k}`]), JSON.stringify(left));
    assert.strictEqual(env.q("SELECT count(*) AS n FROM virtual_fleets WHERE faction_id = ? AND fleet_role = 'mining'",
      CONCORD)[0].n, 0);
    stopAll(env);
  }));
};

module.exports.harness = { bootAll, passesAt, graphOf, THEATRE, START_MS, I, AMARR, CONCORD, SANSHA, SERPENTIS,
  upkeepWorld };
