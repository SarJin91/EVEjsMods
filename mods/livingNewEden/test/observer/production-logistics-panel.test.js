"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createViewRegistry } = require("../../lib/observer/views");
const { VIEW_ID: PROD_VIEW_ID, buildProductionView } = require("../../lib/economy/production/productionView");
const { VIEW_ID: LOG_VIEW_ID, buildLogisticsView } = require("../../lib/economy/logistics/logisticsView");
const { VIEW_ID: ACT_VIEW_ID, buildActivityView } = require("../../lib/strategy/activity/activityView");
const { findServerSrcOnDisk, GAMESTORE_SEARCH_MAX_DEPTH } = require("../../lib/adapter/locator");
const { resolveSqliteDriver } = require("../../lib/adapter/sqliteDriver");
const { MIGRATIONS } = require("../../lib/persistence/migrations");
const { openStore } = require("../../lib/persistence/store");
const { seedDbFile } = require("../_support/dbTemplate");
const { createJournal } = require("../../lib/persistence/journal");
const { createManualClock } = require("../../lib/util/clock");
const { HULL_GROUPS } = require("../../lib/fleets/schema");
const S = require("../../lib/economy/schema");
const RECIPES = require("../../lib/economy/data/hullRecipes");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const DEFAULTS = require("../../config").resolveConfig({ modDir: MOD_DIR, env: {} }).config;
const START_MS = 1760000000000;

function loadDriver() {
  const found = findServerSrcOnDisk(MOD_DIR, GAMESTORE_SEARCH_MAX_DEPTH, fs.existsSync);
  if (!found.ok) return { ok: false, detail: found.reason };
  return resolveSqliteDriver(found.srcDir);
}

function withStore(fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lne-panel-test-"));
  const file = path.join(tmp, "world.sqlite");
  const open = [];
  const driver = loadDriver();
  const reopen = () => {
    seedDbFile(driver, file, { migrations: MIGRATIONS, seed: 1 });
    const opened = openStore({
      filePath: file,
      openDatabase: (f) => new driver.Database(f),
      exclusiveLock: true,
      busyTimeoutMs: 0,
      maxRowsPerTransaction: 5000,
      maxWriteMsPerPass: 5,
      randomSeed: () => 1,
      migrations: MIGRATIONS,
    });
    assert.ok(opened.ok, JSON.stringify(opened));
    open.push(opened.store);
    return opened.store;
  };
  const cleanup = () => {
    for (const s of open) s.close("test_cleanup");
    try {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch (_err) {
    }
  };
  let result;
  try {
    result = fn(reopen);
  } catch (err) {
    cleanup();
    throw err;
  }
  if (result && typeof result.then === "function") {
    return Promise.resolve(result).finally(cleanup);
  }
  cleanup();
  return result;
}

function fakeClock(ms) {
  return { now: () => ms };
}

function fakeStore(open = true) {
  return { 
    isOpen: () => open,
    transaction: (name, fn) => ({ ok: true, value: fn({ inTransaction: true }) }),
  };
}

function fakeJobs(jobsData = {}) {
  const { listTotals = () => ({ ok: true, totals: [] }),
    listActiveAll = () => ({ ok: true, jobs: [] }),
    recentEnded = () => ({ ok: true, rows: [] }),
    getChangeCount = () => 42 } = jobsData;
  return { listTotals, listActiveAll, recentEnded, getChangeCount };
}

function fakeConvoys(convoysData = {}) {
  const { listTotals = () => ({ ok: true, totals: [] }),
    listOpen = () => ({ ok: true, convoys: [] }),
    recentEnded = () => ({ ok: true, rows: [] }),
    recentDelivered = () => ({ ok: true, rows: [] }),
    getChangeCount = () => 42 } = convoysData;
  return { listTotals, listOpen, recentEnded, recentDelivered, getChangeCount };
}

function fakeStrategyStatus(statusData = {}) {
  return () => ({ state: "running", seq: 1, ai: { state: "on", reason: null }, ...statusData });
}

function fakeGovernor(admits = true) {
  return () => ({ admits: () => admits });
}

function fakeRegistry(activeFactions = []) {
  return {
    listActiveFactions: () => activeFactions.map((id) => ({ factionId: id })),
    getFaction: (id) => ({ factionId: id, doctrineId: "d1" }),
    getDoctrine: (id) => ({ doctrineId: id, canOccupy: false, operationTypes: [], reachJumps: 10,
      templates: { invasion: [{ hullGroup: "cruiser", count: 5 }], logistics: [{ hullGroup: "industrial", count: 2 }] } }),
    getCampaignsForFaction: () => [],
  };
}

function fakeAiService() {
  return {
    getSeq: () => 5,
    getMemory: () => ({ applied: [], notes: [], target: null, outcome: null, round: 0, refused: 0 }),
    getStatus: () => ({ lastRefusal: null }),
    schedule: { bucketOf: () => 1, reviewKey: () => "rev", dueOf: () => START_MS + 86400000, nextOf: () => ({ dueAt: START_MS + 86400000 }) },
  };
}

function fakeScheduler() {
  return { getStatus: () => ({ state: "ready" }), findByKey: () => ({ ok: true, found: false }) };
}

function fakeFleets() {
  return {
    repository: {
      listOperations: () => ({ ok: true, operations: [] }),
      listFleetsByFaction: () => ({ ok: true, fleets: [] }),
    },
  };
}

function fakeStations(stationsData = {}) {
  const { listLiveStations = (db, opts) => ({ ok: true, records: [], truncated: false }),
    getStock = (db, stationId) => ({ ok: true, items: [] }),
    getChangeCount = () => 10,
    listStationsOfFaction = (db, f, opts) => ({ ok: true, records: [] }),
    repository: {} } = stationsData;
  return {
    getMode: () => "ready",
    repository: { listLiveStations, getStock, getChangeCount, listStationsOfFaction },
  };
}

function fakeMining(custom = {}) {
  return {
    getMode: () => "ready",
    readSiteState: custom.readSiteState || (() => ({ ok: true, openByBelt: [] })),
  };
}

function fakeProduction(custom = {}) {
  return {
    getMode: () => "ready",
    readStationState: custom.readStationState || (() => ({ ok: true, stations: [], inProduction: {}, activeJobsTotal: 0 })),
    linesOf: custom.linesOf || (() => 2),
    getRecipes: custom.getRecipes || (() => ({ version: 1, groups: ["cruiser"], lookup: () => ({ minerals: { "type:34": 100 } }) })),
  };
}

function fakeLogistics(custom = {}) {
  return {
    getMode: () => "ready",
    readOpen: custom.readOpen || (() => ({ ok: true, convoys: [], truncated: false })),
  };
}

function fakeConstruction(custom = {}) {
  return {
    getMode: () => "ready",
    readOpen: custom.readOpen || (() => ({ ok: true, builds: [], truncated: false })),
  };
}

function fakeSiege(custom = {}) {
  return {
    getMode: () => "ready",
    readForFaction: custom.readForFaction || (() => ({ ok: true, attacking: [], defending: [], truncated: false })),
  };
}

function fakeServices() {
  return {
    getStatus: () => ({
      services: [
        { name: "persistence", state: "running" },
        { name: "scheduler", state: "running" },
        { name: "graph", state: "running" },
        { name: "world", state: "running" },
        { name: "fleets", state: "running" },
        { name: "stations", state: "running" },
        { name: "occupation", state: "running" },
        { name: "mining", state: "running" },
        { name: "production", state: "running" },
        { name: "logistics", state: "running" },
        { name: "construction", state: "running" },
        { name: "trade", state: "running" },
        { name: "siege", state: "running" },
      ],
    }),
  };
}

function fakeGraph() {
  return {
    getGraph: () => ({
      ok: true,
      graph: {
        getSystem: (id) => ({ systemId: id, name: `System ${id}` }),
      },
    }),
  };
}

function fakeWorldRepo() {
  return { listFactions: () => ({ ok: true, records: [] }) };
}

const FACTION_A = 500003;

const { harness: H } = require("../battle/settlement.test");
const { S: SYS } = H;
const CONVOY = Object.freeze([{ hullGroup: "industrial", count: 2 }, { hullGroup: "frigate", count: 2 }]);

function integrationConfig() {
  return { ...H.CONFIG, modules: { ...H.CONFIG.modules, strategy: { enabled: true } },
    fleets: { ...H.CONFIG.fleets, refitPolicy: "station", refitSeekRecheckMs: 3600000, refitSeekMaxRounds: 24 },
    stations: { ...DEFAULTS.stations, refitSeekRecheckMs: 3600000 },
    production: { ...DEFAULTS.production, maxRunsPerJob: 4, linesPerNpcStation: 2 }, logistics: DEFAULTS.logistics,
    persistence: { ...H.CONFIG.persistence, maxRowsPerTransaction: 500 },
    observer: { ...DEFAULTS.observer, ...H.CONFIG.observer } };
}

async function bootServices(reopen, shared) {
  const { startScheduler } = require("../../lib/scheduler");
  const { startFleets } = require("../../lib/fleets");
  const { startStations } = require("../../lib/stations");
  const { startProduction } = require("../../lib/economy/production");
  const { startLogistics } = require("../../lib/economy/logistics");

  const cfg = integrationConfig();
  const store = reopen();
  const journal = createJournal({ clock: shared.clock, maxPayloadBytes: 16384, maxRows: 500 });
  const persistence = { ok: true, store, journal, worldSeed: store.getWorldSeed() };
  const graphService = { whenReady: () => Promise.resolve({ ok: true, graph: shared.graph }),
    getGraph: () => ({ ok: true, graph: shared.graph }) };
  const sr = startScheduler({ config: cfg, persistence: { ok: true, store }, clock: shared.clock, ids: shared.ids,
    nowMs: () => 0 });
  assert.ok(sr.ok, JSON.stringify(sr));
  const holder = { stations: null };
  const fr = startFleets({ config: cfg, persistence, clock: shared.clock, ids: shared.ids, scheduler: sr.scheduler,
    graph: graphService, presence: null, views: createViewRegistry(), getStations: () => holder.stations });
  assert.ok(fr.ok, JSON.stringify(fr));
  const registry = { getFaction: (id) => (Number(id) === FACTION_A
    ? { factionId: FACTION_A, startStations: [], doctrineId: "d" } : null),
  listFactions: () => [{ factionId: FACTION_A }],
  listActiveFactions: () => [{ factionId: FACTION_A }], isActive: (id) => Number(id) === FACTION_A,
  getCampaignsForFaction: () => [],
  getDoctrine: () => ({ templates: { invasion: [{ hullGroup: "cruiser", count: 3 }] } }) };
  const st = startStations({ config: cfg, persistence, strategy: { registry }, graph: graphService,
    clock: shared.clock });
  assert.ok(st.ok, JSON.stringify(st));
  holder.stations = st.stations;
  await st.stations.whenReady();
  const views = createViewRegistry();
  const pr = startProduction({ config: cfg, persistence, clock: shared.clock, ids: shared.ids,
    scheduler: sr.scheduler, strategy: { registry }, getStations: () => holder.stations, views,
    getGovernor: shared.getGovernor, logger: { log: () => {} } });
  assert.ok(pr.ok, JSON.stringify(pr));
  const lr = startLogistics({ config: cfg, persistence, clock: shared.clock, ids: shared.ids, scheduler: sr.scheduler,
    fleets: fr.fleets, strategy: { registry }, getStations: () => holder.stations, views,
    getGovernor: shared.getGovernor, logger: { log: () => {} } });
  assert.ok(lr.ok, JSON.stringify(lr));

  return { store, journal, scheduler: sr.scheduler, fleets: fr.fleets, stations: st.stations, production: pr.production,
    logistics: lr.logistics, registry, views, tx: (fn) => {
      const r = store.transaction("test", fn);
      assert.ok(r.ok, `${JSON.stringify(r)} ${(r.error && r.error.stack) || ""}`);
      return r.value;
    } };
}

function newConvoyFleet(env, tag, systemId) {
  const r = env.fleets.createFleet({ factionId: FACTION_A, currentSystemId: systemId, homeSystemId: systemId,
    fleetRole: "logistics", composition: CONVOY }, `${tag}:create`);
  assert.ok(r.ok, JSON.stringify(r));
  return r.fleetId;
}

function fleetVersion(env, fleetId) {
  return env.tx((db) => env.fleets.repository.getFleet(db, fleetId)).fleet.version;
}

function addStation(env, stationId, kind, systemId, factionId, at) {
  const spec = kind === "npc"
    ? { kind, npcStationId: 60000000 + stationId.length * 7 + stationId.charCodeAt(stationId.length - 1) }
    : { kind, typeId: 35832, structureFamily: "astrahus" };
  const r = env.tx((db) => env.stations.repository.createStation(db, {
    stationId, ...spec, systemId,
    ownerFactionId: factionId, ownerCorporationId: 1000162, origin: kind === "npc" ? "seed" : "built", at },
  `test:station:${stationId}`));
  assert.ok(r.ok, JSON.stringify(r));
}

function seedMinerals(env, stationId, groups, at) {
  const sum = {};
  for (const [g, runs] of groups) {
    for (const [k, v] of Object.entries(RECIPES.GROUPS[g].minerals)) sum[k] = (sum[k] || 0) + v * runs;
  }
  const r = env.tx((db) => env.stations.repository.applyStockChange(db, {
    stationId, key: `test:seed:${stationId}`, reason: "TEST", at,
    deltas: Object.keys(sum).sort().map((k) => ({ itemKind: "mineral", itemKey: k, delta: sum[k] })) }));
  assert.ok(r.ok, JSON.stringify(r));
  return sum;
}

function startJob(env, stationId, hullGroup, runs, at, idempotencyKey) {
  return env.tx((db) => env.production.startJobInTx(db, { factionId: FACTION_A, stationId, hullGroup, runs, at }, idempotencyKey));
}

function dispatchConvoy(env, spec, idempotencyKey) {
  return env.tx((db) => env.logistics.dispatchInTx(db, spec, idempotencyKey));
}

module.exports = ({ test, skip }) => {
  const driver = loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  test("PL1 production view: returns correct view object structure", () => {
    const store = fakeStore();
    const jobs = fakeJobs();
    const clock = fakeClock(START_MS);
    const config = DEFAULTS;
    const getStatus = fakeStrategyStatus();
    const getGovernor = fakeGovernor();
    const factionNames = new Map([[500003, "Amarr Empire"]]);
    const getStations = () => fakeStations();
    const linesOf = () => 2;
    const registry = fakeRegistry([500003]);
    const getRecipes = () => ({ version: 1, groups: ["cruiser"], lookup: () => ({ minerals: { "type:34": 100 } }) });

    const view = buildProductionView({ store, jobs, clock, config, getStatus, getGovernor, factionNames,
      getStations, linesOf, registry, getRecipes });

    assert.strictEqual(view.title, "Hull production");
    assert.strictEqual(typeof view.getData, "function");
    assert.strictEqual(typeof view.cacheKey, "function");
    assert.ok(Number.isFinite(view.order));
  });

  test("PL2 production view: cacheKey null when store closed", () => {
    const store = fakeStore(false);
    const jobs = fakeJobs({ getChangeCount: () => 10 });
    const clock = fakeClock(START_MS);
    const config = DEFAULTS;
    const getStatus = fakeStrategyStatus();
    const getGovernor = fakeGovernor();
    const factionNames = new Map();
    const getStations = () => fakeStations();
    const linesOf = () => 2;

    const view = buildProductionView({ store, jobs, clock, config, getStatus, getGovernor, factionNames,
      getStations, linesOf });

    assert.strictEqual(view.cacheKey(), null);
  });

  test("PL3 production view: cacheKey null when governor holds", () => {
    const store = fakeStore(true);
    const jobs = fakeJobs({ getChangeCount: () => 10 });
    const clock = fakeClock(START_MS);
    const config = DEFAULTS;
    const getStatus = fakeStrategyStatus();
    const getGovernor = fakeGovernor(false);
    const factionNames = new Map();
    const getStations = () => fakeStations();
    const linesOf = () => 2;

    const view = buildProductionView({ store, jobs, clock, config, getStatus, getGovernor, factionNames,
      getStations, linesOf });

    assert.strictEqual(view.cacheKey(), null);
  });

  test("PL4 production view: cacheKey returns key when admitted", () => {
    const store = fakeStore(true);
    const jobs = fakeJobs({ getChangeCount: () => 10 });
    const clock = fakeClock(START_MS);
    const config = DEFAULTS;
    const getStatus = fakeStrategyStatus({ seq: 7 });
    const getGovernor = fakeGovernor(true);
    const factionNames = new Map();
    const getStations = () => fakeStations();
    const linesOf = () => 2;

    const view = buildProductionView({ store, jobs, clock, config, getStatus, getGovernor, factionNames,
      getStations, linesOf });

    const key = view.cacheKey();
    assert.ok(typeof key === "string" && key.startsWith("p10|7|"));
  });

  test("PL5 production view: getData returns available=false when store closed", () => {
    const store = fakeStore(false);
    const jobs = fakeJobs();
    const clock = fakeClock(START_MS);
    const config = DEFAULTS;
    const getStatus = fakeStrategyStatus();
    const getGovernor = fakeGovernor();
    const factionNames = new Map();
    const getStations = () => fakeStations();
    const linesOf = () => 2;

    const view = buildProductionView({ store, jobs, clock, config, getStatus, getGovernor, factionNames,
      getStations, linesOf });

    const data = view.getData();
    assert.deepStrictEqual(data, { available: false, reason: "STORE_CLOSED" });
  });

  test("PL6 production view: getData returns available=false when governor holds", () => {
    const store = fakeStore(true);
    const jobs = fakeJobs();
    const clock = fakeClock(START_MS);
    const config = DEFAULTS;
    const getStatus = fakeStrategyStatus();
    const getGovernor = fakeGovernor(false);
    const factionNames = new Map();
    const getStations = () => fakeStations();
    const linesOf = () => 2;

    const view = buildProductionView({ store, jobs, clock, config, getStatus, getGovernor, factionNames,
      getStations, linesOf });

    const data = view.getData();
    assert.deepStrictEqual(data, { available: false, reason: "GOVERNOR_HOLD" });
  });

  test("PL19 tribute-c: CONCORD receiver with the tribute on -> non-empty hull target (= the review "
    + "formula hullsRequiredOf); tribute off -> empty target as before; Amarr the same in both", () => {
    const { REGISTRY_DATA_V1, createFactionRegistry } = require("../../lib/strategy/registry");
    const { FLEET_ROLES, OPERATION_TYPES } = require("../../lib/fleets/schema");
    const { createHostility } = require("../../lib/battle/data/hostility");
    const { hullTargets, huntersNeedHullsOf } = require("../../lib/strategy/ai/production");
    const { parseHullGroupList } = require("../../lib/fleets/schema");
    const made = createFactionRegistry(REGISTRY_DATA_V1, { hullGroups: HULL_GROUPS, fleetRoles: FLEET_ROLES,
      operationTypes: OPERATION_TYPES, hostility: createHostility(), maxFactions: 64, maxCampaignSystems: 40,
      maxShipsPerFleet: 500, maxCompositionEntries: 32, maxResourceUnits: 1000000000 });
    assert.ok(made.ok, JSON.stringify(made));
    const real = made.registry;
    const CONCORD = 500006;
    const AMARR = 500003;
    const concordDoctrine = real.getDoctrine(real.getFaction(CONCORD).doctrineId);
    assert.deepStrictEqual([concordDoctrine.hullsRequired, real.isTributeRecipient(CONCORD),
      real.isTributeRecipient(AMARR)], [false, true, false]);
    const registry = { listActiveFactions: () => [{ factionId: AMARR }, { factionId: CONCORD }],
      getFaction: (f) => real.getFaction(f), getDoctrine: (d) => real.getDoctrine(d),
      isTributeRecipient: (f) => real.isTributeRecipient(f) };
    const deficitOf = (config) => {
      const view = buildProductionView({ store: fakeStore(), jobs: fakeJobs(), clock: fakeClock(START_MS), config,
        getStatus: fakeStrategyStatus(), getGovernor: fakeGovernor(), factionNames: new Map(),
        getStations: () => fakeStations(), linesOf: () => 2, registry, getRecipes: () => null });
      const data = view.getData();
      assert.strictEqual(data.available, true, JSON.stringify(data));
      return Object.fromEntries(data.factions.map((f) => [f.faction, f.deficit]));
    };
    const onConfig = require("../../config").resolveConfig({ modDir: MOD_DIR,
      env: { EVEJS_LNE_TRIBUTE_ENABLED: "1", EVEJS_LNE_TRIBUTE_RECIPIENT_BUILDS_HULLS: "1" } }).config;
    assert.deepStrictEqual([onConfig.tribute.enabled, DEFAULTS.tribute.enabled], [true, false]);
    const on = deficitOf(onConfig);
    const off = deficitOf(DEFAULTS);
    const params = { targetStockFleets: DEFAULTS.production.targetStockFleets,
      miningNeedsHulls: DEFAULTS.production.miningNeedsHulls, hullGroups: HULL_GROUPS,
      freeHullGroups: parseHullGroupList(DEFAULTS.production.freeHullGroups) || [],
      huntersNeedHulls: huntersNeedHullsOf(DEFAULTS) };
    const expected = hullTargets({ ...concordDoctrine, hullsRequired: true }, params);
    assert.ok(Object.keys(expected).length > 0, JSON.stringify(expected));
    assert.deepStrictEqual(on[CONCORD], expected, "no station: the deficit is the whole target");
    assert.deepStrictEqual(off[CONCORD], {}, "tribute off: the receiver builds no hulls (as before tribute-c)");
    assert.ok(Object.keys(on[AMARR]).length > 0);
    assert.deepStrictEqual(on[AMARR], off[AMARR], "a payer's target does not depend on the tribute");
    for (const rel of ["lib/strategy/reviewService.js", "lib/economy/production/productionView.js"]) {
      const src = fs.readFileSync(path.join(MOD_DIR, rel), "utf8");
      assert.ok(/hullsRequiredOf\(doctrine, /.test(src) && /tributeOnOf\(config\)/.test(src), `${rel} shared formula`);
    }
  });

  test("PL7 logistics view: returns correct view object structure", () => {
    const store = fakeStore();
    const convoys = fakeConvoys();
    const clock = fakeClock(START_MS);
    const getStatus = fakeStrategyStatus();
    const getGovernor = fakeGovernor();
    const factionNames = new Map([[500003, "Amarr Empire"]]);
    const factionIds = () => [500003];
    const maxOpenRows = 4;

    const view = buildLogisticsView({ store, convoys, clock, getStatus, getGovernor, factionNames,
      factionIds, maxOpenRows });

    assert.strictEqual(view.title, "Faction convoys");
    assert.strictEqual(typeof view.getData, "function");
    assert.strictEqual(typeof view.cacheKey, "function");
    assert.ok(Number.isFinite(view.order));
  });

  test("PL8 logistics view: cacheKey null when store closed", () => {
    const store = fakeStore(false);
    const convoys = fakeConvoys({ getChangeCount: () => 10 });
    const clock = fakeClock(START_MS);
    const getStatus = fakeStrategyStatus();
    const getGovernor = fakeGovernor();
    const factionNames = new Map();
    const factionIds = () => [];

    const view = buildLogisticsView({ store, convoys, clock, getStatus, getGovernor, factionNames,
      factionIds, maxOpenRows: 4 });

    assert.strictEqual(view.cacheKey(), null);
  });

  test("PL9 logistics view: cacheKey null when governor holds", () => {
    const store = fakeStore(true);
    const convoys = fakeConvoys({ getChangeCount: () => 10 });
    const clock = fakeClock(START_MS);
    const getStatus = fakeStrategyStatus();
    const getGovernor = fakeGovernor(false);
    const factionNames = new Map();
    const factionIds = () => [];

    const view = buildLogisticsView({ store, convoys, clock, getStatus, getGovernor, factionNames,
      factionIds, maxOpenRows: 4 });

    assert.strictEqual(view.cacheKey(), null);
  });

  test("PL10 logistics view: cacheKey returns key when admitted", () => {
    const store = fakeStore(true);
    const convoys = fakeConvoys({ getChangeCount: () => 10 });
    const clock = fakeClock(START_MS);
    const getStatus = fakeStrategyStatus({ seq: 7 });
    const getGovernor = fakeGovernor(true);
    const factionNames = new Map();
    const factionIds = () => [];

    const view = buildLogisticsView({ store, convoys, clock, getStatus, getGovernor, factionNames,
      factionIds, maxOpenRows: 4 });

    const key = view.cacheKey();
    assert.ok(typeof key === "string" && key.startsWith("l10|7|"));
  });

  test("PL11 logistics view: getData returns available=false when store closed", () => {
    const store = fakeStore(false);
    const convoys = fakeConvoys();
    const clock = fakeClock(START_MS);
    const getStatus = fakeStrategyStatus();
    const getGovernor = fakeGovernor();
    const factionNames = new Map();
    const factionIds = () => [];

    const view = buildLogisticsView({ store, convoys, clock, getStatus, getGovernor, factionNames,
      factionIds, maxOpenRows: 4 });

    const data = view.getData();
    assert.deepStrictEqual(data, { available: false, reason: "STORE_CLOSED" });
  });

  test("PL12 activity view: returns correct view object structure", () => {
    const store = fakeStore();
    const repository = fakeWorldRepo();
    const registry = fakeRegistry([500003]);
    const clock = fakeClock(START_MS);
    const config = DEFAULTS;
    const getGovernor = fakeGovernor();
    const factionNames = new Map([[500003, "Amarr Empire"]]);
    const getAiService = () => fakeAiService();
    const scheduler = fakeScheduler();
    const fleets = fakeFleets();
    const getStations = () => fakeStations();
    const getMining = () => fakeMining();
    const getProduction = () => fakeProduction();
    const getLogistics = () => fakeLogistics();
    const getConstruction = () => fakeConstruction();
    const getSiege = () => fakeSiege();
    const getServices = () => fakeServices();

    const view = buildActivityView({ store, repository, registry, getStatus: fakeStrategyStatus(),
      clock, config, getGovernor, factionNames, getAiService, scheduler, fleets,
      getStations, getMining, getProduction, getLogistics, getConstruction, getSiege, getServices });

    assert.strictEqual(view.title, "Faction activity");
    assert.strictEqual(typeof view.getData, "function");
    assert.strictEqual(typeof view.cacheKey, "function");
    assert.ok(Number.isFinite(view.order));
  });

  test("PL13 activity view: cacheKey null when store closed", () => {
    const store = fakeStore(false);
    const repository = fakeWorldRepo();
    const registry = fakeRegistry([]);
    const clock = fakeClock(START_MS);
    const config = DEFAULTS;
    const getGovernor = fakeGovernor();
    const factionNames = new Map();

    const view = buildActivityView({ store, repository, registry, getStatus: fakeStrategyStatus(),
      clock, config, getGovernor, factionNames });

    assert.strictEqual(view.cacheKey(), null);
  });

  test("PL14 activity view: getData returns available=false when store closed", () => {
    const store = fakeStore(false);
    const repository = fakeWorldRepo();
    const registry = fakeRegistry([]);
    const clock = fakeClock(START_MS);
    const config = DEFAULTS;
    const getGovernor = fakeGovernor();
    const factionNames = new Map();

    const view = buildActivityView({ store, repository, registry, getStatus: fakeStrategyStatus(),
      clock, config, getGovernor, factionNames });

    const data = view.getData();
    assert.deepStrictEqual(data, { available: false, reason: "STORE_CLOSED" });
  });

  test("PL15 activity view: getData returns available=false when governor holds", () => {
    const store = fakeStore(true);
    const repository = fakeWorldRepo();
    const registry = fakeRegistry([]);
    const clock = fakeClock(START_MS);
    const config = DEFAULTS;
    const getGovernor = fakeGovernor(false);
    const factionNames = new Map();

    const view = buildActivityView({ store, repository, registry, getStatus: fakeStrategyStatus(),
      clock, config, getGovernor, factionNames });

    const data = view.getData();
    assert.deepStrictEqual(data, { available: false, reason: "GOVERNOR_HOLD" });
  });

  needsDriver("PL16 production view: shows production in multiple stations via real services", async () => {
    return withStore((reopen) => {
      const shared = { ...H.sharedOf(), getGovernor: fakeGovernor(true) };

      return bootServices(reopen, shared).then(async (env) => {
        const { stations, production, views } = env;
        const now = START_MS;

        addStation(env, "stM", "npc", SYS.N0, FACTION_A, now);
        addStation(env, "stA", "npc", SYS.N5, FACTION_A, now);
        addStation(env, "stB", "upwell", SYS.N6, FACTION_A, now);

        seedMinerals(env, "stM", [["cruiser", 1]], now);
        seedMinerals(env, "stA", [["cruiser", 2], ["frigate", 3]], now);
        seedMinerals(env, "stB", [["cruiser", 1]], now);

        const r1 = startJob(env, "stM", "cruiser", 1, now, "j1");
        const r2 = startJob(env, "stA", "cruiser", 2, now, "j2");
        const r3 = startJob(env, "stA", "frigate", 3, now, "j3");
        const r4 = startJob(env, "stB", "cruiser", 1, now, "j4");
        assert.ok(r1.ok && !r1.duplicate, "j1: " + JSON.stringify(r1));
        assert.ok(r2.ok && !r2.duplicate, "j2: " + JSON.stringify(r2));
        assert.ok(r3.ok && !r3.duplicate, "j3: " + JSON.stringify(r3));
        assert.ok(r4.ok && !r4.duplicate, "j4: " + JSON.stringify(r4));

        const view = views.getView(PROD_VIEW_ID);
        const data = view.getData();
        assert.strictEqual(data.available, true, JSON.stringify(data));
        const f = data.factions.find((x) => x.faction === FACTION_A);
        assert.ok(f, "faction present: " + JSON.stringify(data.factions));

        assert.strictEqual(f.stations.length, 3, "three stations shown: " + JSON.stringify(f.stations.map((s) => s.station)));

        const stM = f.stations.find((s) => s.station === "stM");
        const stA = f.stations.find((s) => s.station === "stA");
        const stB = f.stations.find((s) => s.station === "stB");
        assert.ok(stM, "mobilization station stM present");
        assert.ok(stA, "non-mobilization station stA present");
        assert.ok(stB, "non-mobilization station stB present");

        assert.strictEqual(stM.jobs.length, 1, "stM has 1 job");
        assert.strictEqual(stM.jobs[0].hullGroup, "cruiser");
        assert.strictEqual(stM.jobs[0].runs, 1);

        assert.strictEqual(stA.jobs.length, 2, "stA has 2 jobs");
        const stAJobs = stA.jobs.map((j) => `${j.hullGroup}:${j.runs}`).sort();
        assert.deepStrictEqual(stAJobs, ["cruiser:2", "frigate:3"]);

        assert.strictEqual(stB.jobs.length, 1, "stB has 1 job");
        assert.strictEqual(stB.jobs[0].hullGroup, "cruiser");
        assert.strictEqual(stB.jobs[0].runs, 1);

        assert.strictEqual(stM.lines, "1/2", "stM shows 1/2 lines");
        assert.strictEqual(stA.lines, "2/2", "stA shows 2/2 lines");
        assert.strictEqual(stB.lines, `1/${DEFAULTS.production.linesPerUpwellStation}`, "stB (upwell) lines");
      });
    });
  });

  needsDriver("PL17 logistics view: shows HULLS_TO_MOBILIZATION and MINERALS_TO_FACTORY convoys via real services", async () => {
    return withStore((reopen) => {
      const shared = { ...H.sharedOf(), getGovernor: fakeGovernor(true) };

      return bootServices(reopen, shared).then(async (env) => {
        const { stations, production, logistics, views } = env;
        const now = START_MS;

        addStation(env, "stM", "npc", SYS.N0, FACTION_A, now);
        addStation(env, "stA", "npc", SYS.N5, FACTION_A, now);
        addStation(env, "stB", "upwell", SYS.N6, FACTION_A, now);

        const put = env.tx((db) => env.stations.repository.applyStockChange(db, { stationId: "stA", key: "test:hulls:stA",
          reason: "TEST", at: now, deltas: [{ itemKind: "hull", itemKey: "group:cruiser", delta: 2 }] }));
        assert.ok(put.ok, JSON.stringify(put));
        seedMinerals(env, "stB", [["cruiser", 1]], now);

        const lf1 = newConvoyFleet(env, "pl17:lf1", SYS.N0);
        const convoyResult = dispatchConvoy(env, { factionId: FACTION_A, fleetId: lf1,
          expectedVersion: fleetVersion(env, lf1), purpose: "MINERALS_TO_FACTORY", sourceStationId: "stB",
          destStationId: "stA", items: [{ itemKind: "mineral", itemKey: "type:34", quantity: 500 }], at: now }, "cv1");
        assert.ok(convoyResult.ok && !convoyResult.duplicate, "convoy: " + JSON.stringify(convoyResult));
        const lf2 = newConvoyFleet(env, "pl17:lf2", SYS.N0);
        const convoyResult2 = dispatchConvoy(env, { factionId: FACTION_A, fleetId: lf2,
          expectedVersion: fleetVersion(env, lf2), purpose: "HULLS_TO_MOBILIZATION", sourceStationId: "stA",
          destStationId: "stM", items: [{ itemKind: "hull", itemKey: "group:cruiser", quantity: 2 }], at: now }, "cv2");
        assert.ok(convoyResult2.ok && !convoyResult2.duplicate, "convoy2: " + JSON.stringify(convoyResult2));

        const data = views.getView(LOG_VIEW_ID).getData();
        assert.strictEqual(data.available, true, JSON.stringify(data));
        const f = data.factions.find((x) => x.faction === FACTION_A);
        assert.ok(f, "faction present: " + JSON.stringify(data.factions));

        assert.strictEqual(f.open.length, 2, "two open convoys: " + JSON.stringify(f.open));

        const hullConvoy = f.open.find((c) => c.purpose === "HULLS_TO_MOBILIZATION");
        const mineralConvoy = f.open.find((c) => c.purpose === "MINERALS_TO_FACTORY");
        assert.ok(hullConvoy, "HULLS_TO_MOBILIZATION convoy present: " + JSON.stringify(f.open));
        assert.ok(mineralConvoy, "MINERALS_TO_FACTORY convoy present: " + JSON.stringify(f.open));

        assert.strictEqual(hullConvoy.state, "TO_SOURCE");
        assert.strictEqual(hullConvoy.from, "stA");
        assert.strictEqual(hullConvoy.to, "stM");

        assert.strictEqual(mineralConvoy.state, "TO_SOURCE");
        assert.strictEqual(mineralConvoy.from, "stB");
        assert.strictEqual(mineralConvoy.to, "stA");

        assert.deepStrictEqual(hullConvoy.cargo, { "hull/group:cruiser": 2 });
        assert.deepStrictEqual(mineralConvoy.cargo, { "mineral/type:34": 500 });
      });
    });
  });

  needsDriver("PL18 activity view: shows production in multiple stations via real services", async () => {
    return withStore((reopen) => {
      const shared = { ...H.sharedOf(), getGovernor: fakeGovernor(true) };

      return bootServices(reopen, shared).then(async (env) => {
        const { stations, production, views } = env;
        const now = START_MS;

        addStation(env, "stM", "npc", SYS.N0, FACTION_A, now);
        addStation(env, "stA", "npc", SYS.N5, FACTION_A, now);
        addStation(env, "stB", "upwell", SYS.N6, FACTION_A, now);

        seedMinerals(env, "stM", [["cruiser", 1]], now);
        seedMinerals(env, "stA", [["cruiser", 2], ["frigate", 3]], now);
        seedMinerals(env, "stB", [["cruiser", 1]], now);

        const r1 = startJob(env, "stM", "cruiser", 1, now, "j1");
        const r2 = startJob(env, "stA", "cruiser", 2, now, "j2");
        const r3 = startJob(env, "stA", "frigate", 3, now, "j3");
        const r4 = startJob(env, "stB", "cruiser", 1, now, "j4");
        assert.ok(r1.ok && !r1.duplicate, "j1: " + JSON.stringify(r1));
        assert.ok(r2.ok && !r2.duplicate, "j2: " + JSON.stringify(r2));
        assert.ok(r3.ok && !r3.duplicate, "j3: " + JSON.stringify(r3));
        assert.ok(r4.ok && !r4.duplicate, "j4: " + JSON.stringify(r4));

        const view = buildActivityView({ store: env.store,
          repository: require("../../lib/strategy/factionRepository").createFactionRepository({ journal: env.journal,
            limits: { maxResourceUnits: 1000000000, maxFrontLimit: 2, maxListLimit: 64 } }),
          registry: env.registry,
          getStatus: production.getStatus,
          clock: shared.clock, config: DEFAULTS, getGovernor: shared.getGovernor,
          factionNames: new Map([[FACTION_A, "Amarr Empire"]]),
          getAiService: () => ({ getSeq: () => 5, getMemory: () => ({ applied: [], notes: [], target: null, outcome: null, round: 0, refused: 0 }), getStatus: () => ({ lastRefusal: null }), schedule: { bucketOf: () => 1, reviewKey: () => "rev", dueOf: () => START_MS + 86400000, nextOf: () => ({ dueAt: START_MS + 86400000 }) } }),
          scheduler: { getStatus: () => ({ state: "ready" }), findByKey: () => ({ ok: true, found: false }) },
          fleets: { repository: { listOperations: () => ({ ok: true, operations: [] }), listFleetsByFaction: () => ({ ok: true, fleets: [] }) } },
          getStations: () => stations,
          getMining: () => ({ getMode: () => "ready", readSiteState: () => ({ ok: true, openByBelt: [] }) }),
          getProduction: () => production,
          getLogistics: () => ({ getMode: () => "ready", readOpen: () => ({ ok: true, convoys: [], truncated: false }) }),
          getConstruction: () => ({ getMode: () => "ready", readOpen: () => ({ ok: true, builds: [], truncated: false }) }),
          getSiege: () => ({ getMode: () => "ready", readForFaction: () => ({ ok: true, attacking: [], defending: [], truncated: false }) }),
          getServices: () => ({ getStatus: () => ({ services: [{ name: "production", state: "running" }] }) }),
        });

        const data = view.getData();
        assert.strictEqual(data.available, true);
        const f = data.factions.find((x) => x.factionId === FACTION_A);
        assert.ok(f, "faction Amarr Empire present");

        const prod = f.now.sections.production;
        assert.strictEqual(prod.status, "ok");
        assert.strictEqual(prod.count, 4, "4 active jobs total across 3 stations");

        const systems = new Set(prod.items.map((i) => i.system.systemId));
        assert.ok(systems.has(SYS.N0), "stM system present");
        assert.ok(systems.has(SYS.N5), "stA system present");
        assert.ok(systems.has(SYS.N6), "stB system present");
      });
    });
  });
};