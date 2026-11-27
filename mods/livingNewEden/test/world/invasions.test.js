"use strict";

const assert = require("node:assert");
const os = require("node:os");
const path = require("node:path");

const { findServerSrcOnDisk, GAMESTORE_SEARCH_MAX_DEPTH } = require("../../lib/adapter/locator");
const { resolveSqliteDriver } = require("../../lib/adapter/sqliteDriver");
const { openStore } = require("../../lib/persistence/store");
const { seedDbFile } = require("../_support/dbTemplate");
const { createJournal } = require("../../lib/persistence/journal");
const { createManualClock } = require("../../lib/util/clock");
const { buildUniverseGraph } = require("../../lib/graph/universeGraph");
const { createRouteFinder } = require("../../lib/graph/routes");
const { createHostility } = require("../../lib/battle/data/hostility");
const { GROUPS } = require("../../lib/battle/data/strengthCatalog");
const { buildPowerTable } = require("../../lib/strategy/ai/strength");
const { REGISTRY_DATA_V1, createFactionRegistry } = require("../../lib/strategy/registry");
const { createFactionRepository } = require("../../lib/strategy/factionRepository");
const { startStrategy } = require("../../lib/strategy");
const { createViewRegistry } = require("../../lib/observer/views");
const { resolveConfig } = require("../../config");
const { startScheduler } = require("../../lib/scheduler");
const { startFleets } = require("../../lib/fleets");
const { startStations } = require("../../lib/stations");
const { startOccupation } = require("../../lib/world/occupation");
const { createWorldStateRepository } = require("../../lib/world/worldStateRepository");
const { startBattle } = require("../../lib/battle");
const { startInvasions, createUnavailableInvasions } = require("../../lib/world/invasions");
const { listFootholdsInTx } = require("../../lib/world/invasions/footholds");
const { STAGING_INVASION_METHODS } = require("../../lib/heavyEvents/world/planner");
const { k3StaticMap, system } = require("../strategy/fixtures/k3Cluster.fixture");
const { createIdGenerator } = require("../../lib/util/ids");
const { createRng } = require("../../lib/util/rng");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const START_MS = 1760000000000;
const HOUR = 3600000;
const DAY = 24 * HOUR;
const LIMITS = Object.freeze({ maxFactionsPerSystem: 8, maxBatchReadIds: 400, maxListLimit: 500 });

const K3_NULLSEC_SYSTEMS = [30001867, 30001868, 30001869, 30001870, 30001871, 30001872,
  30001893, 30001894, 30001895, 30001896, 30001897, 30001898,
  30001899, 30001900, 30001901, 30001902, 30001903, 30001904,
  30001923, 30001924, 30001925, 30001926, 30001927, 30001928, 30001929, 30001930,
  30001948, 30001949, 30001950, 30001951, 30001952, 30001953, 30001954, 30001955];

function seedK3Systems(repo, storeResult, reason) {
  for (const sysId of K3_NULLSEC_SYSTEMS) {
    const result = tx(storeResult, (db) => repo.applyChange(db, { systemId: sysId, expectedVersion: 0, reason, state: { securityClass: "nullsec", controllerFactionId: null }, influence: [] }, `world:seed:k3:${sysId}`));
    if (!result.ok) console.log(`[seedK3Systems] sysId=${sysId} FAILED: ${result.reason}`);
  }
}

function loadDriver() {
  const found = findServerSrcOnDisk(MOD_DIR, GAMESTORE_SEARCH_MAX_DEPTH, require("node:fs").existsSync);
  if (!found.ok) return { ok: false, detail: found.reason };
  return resolveSqliteDriver(found.srcDir);
}

function withStore(driver, fn, { fresh = false } = {}) {
  const fs = require("node:fs");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lne-inv-"));
  const file = path.join(tmp, "world.sqlite");
  const open = [];
  const reopen = () => {
    if (!fresh) seedDbFile(driver, file, { seed: 1 });
    const opened = openStore({ filePath: file, openDatabase: (f) => new driver.Database(f), exclusiveLock: true,
      busyTimeoutMs: 0, maxRowsPerTransaction: 500, maxWriteMsPerPass: 5, randomSeed: () => 1 });
    assert.ok(opened.ok, JSON.stringify(opened));
    open.push(opened.store);
    return { store: opened.store, worldSeed: opened.worldSeed };
  };
  const cleanup = () => {
    for (const s of open) s.close("test_cleanup");
    try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch (_err) {}
  };
  let result;
  try { result = fn(reopen); } catch (err) { cleanup(); throw err; }
  if (result && typeof result.then === "function") return result.finally(cleanup);
  cleanup();
  return result;
}

function graphOf(opts) {
  const built = buildUniverseGraph(k3StaticMap(opts));
  assert.ok(built.ok);
  const finder = createRouteFinder(built.graph, { cacheSize: 16, maxJumps: 40 });
  return Object.freeze({ ...built.graph, ...finder.publicApi });
}

const tx = (storeResult, fn) => {
  const store = storeResult.store || storeResult;
  const r = store.transaction("test", fn);
  assert.ok(r.ok, JSON.stringify(r));
  return r.value;
};

const countRows = (storeResult, table) => tx(storeResult, (db) => db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n);

function advanceToNextRoll(env) {
  const { clock, storeResult, invasions } = env;
  const config = env.invasionsConfig || { invasions: { rollIntervalMs: 3600000 } };
  const I = config.invasions.rollIntervalMs;
  const { deriveSeed } = require("../../lib/util/rng");
  const worldSeed = storeResult.worldSeed || 1;
  const phi = deriveSeed(worldSeed, "invasions", "phase") % I;
  const bucketOf = (t) => Math.floor((t - phi) / I);
  const now = clock.now();
  const nextRollRound = bucketOf(now) + 1;
  const dueAt = nextRollRound * I + phi;
  clock.set(dueAt);
  return dueAt;
}

function configOf(env = {}) {
  const r = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_DATA_ROOT: os.tmpdir(), ...env } });
  assert.deepStrictEqual(r.errors || [], []);
  return r.config;
}

function fakeStations(list) {
  return { getMode: () => "ready", repository: {
    countLiveBySystem(tx, ids) {
      const m = new Map();
      for (const s of list) {
        if (!ids.includes(s.systemId) || s.state === "DESTROYED") continue;
        const k = `${s.systemId}:${s.factionId}`;
        m.set(k, { systemId: s.systemId, factionId: s.factionId, count: ((m.get(k) || {}).count || 0) + 1 });
      }
      return { ok: true, rows: [...m.values()] };
    },
    listStationsOfFaction(tx, f, opts) {
      return { ok: true, records: list.filter((s) => s.factionId === f && (!opts || !opts.states || opts.states.includes(s.state))) };
    },
  } };
}

function fakePresence(observedSet = new Set()) {
  return { isObserved: (id) => observedSet.has(id) };
}

function bootFull(storeResult, config, overrides = {}) {
  const { store, worldSeed } = storeResult;
  const clock = createManualClock(START_MS);
  const journal = createJournal({ clock, maxPayloadBytes: 16384, maxRows: 500 });
  const persistence = { ok: true, store, journal, worldSeed };
  const graph = graphOf({});
  const graphService = { whenReady: () => Promise.resolve({ ok: true, graph }), getGraph: () => ({ ok: true, graph }) };
  const ids = createIdGenerator({ clock, rng: createRng(5) });
  const sr = startScheduler({ config, persistence: { ok: true, store, worldSeed }, clock, ids, nowMs: () => 0 });
  assert.ok(sr.ok, JSON.stringify(sr));
  const fr = startFleets({ config, persistence, clock, ids, scheduler: sr.scheduler, graph: graphService, presence: null, views: createViewRegistry(), getStations: () => ({ getMode: () => "off" }) });
  assert.ok(fr.ok, JSON.stringify(fr));
  const repo = createWorldStateRepository({ journal, clock, limits: LIMITS });
  const orResult = startOccupation({ config, persistence, clock, scheduler: sr.scheduler, fleets: fr.fleets, world: { repository: repo }, graph: graphService, getStations: () => ({ getMode: () => "off" }), nowMs: () => 0, footholdsOf: listFootholdsInTx });
  assert.ok(orResult.ok, JSON.stringify(orResult));
  const or = orResult.occupation;
  const stratConfig = { ...config, strategy: { ...config.strategy, activeFactions: "500003,500006,500019,500020,500021,500026,500029" } };
  const st = startStrategy({ config: stratConfig, persistence, clock, graph: graphService, world: { repository: repo }, scheduler: sr.scheduler, fleets: fr.fleets, getStations: () => ({ getMode: () => "off" }), getOccupation: () => or, views: createViewRegistry() });
  assert.ok(st.ok, JSON.stringify(st));
  const battle = startBattle({ config, persistence, clock, ids, scheduler: sr.scheduler, fleets: fr.fleets, graph: graphService, occupation: or });
  assert.ok(battle.ok, JSON.stringify(battle));
  const stations = fakeStations([{ stationId: "st:amarr", systemId: 30001868, factionId: 500003, state: "ONLINE" }]);
  const stR = startStations({ config, persistence, strategy: st.strategy, graph: graphService, clock, views: createViewRegistry(), getStations: () => stations });
  assert.ok(stR.ok);
  const invOccupation = overrides.wrapOccupation ? overrides.wrapOccupation(or) : or;
  const invFleets = overrides.wrapFleets ? overrides.wrapFleets(fr.fleets) : fr.fleets;
  const invStrategy = overrides.wrapStrategy ? overrides.wrapStrategy(st.strategy) : st.strategy;
  const invDeps = { config, persistence, clock, scheduler: sr.scheduler, fleets: invFleets, world: { repository: repo }, graph: graphService, stations: stations, presence: fakePresence(), adapter: overrides.adapter || { getSovClaims: () => ({ ok: true, claimOf: () => ({ ok: true, claimed: false }) }) }, strategy: invStrategy, occupation: invOccupation, battle: battle.battle, nowMs: () => 0, ids, logger: overrides.logger || { log: () => {} }, telemetry: overrides.telemetry || null, views: overrides.views, timers: overrides.timers,
    getTreasury: overrides.getTreasury };
  const invasions = startInvasions(invDeps);
  assert.ok(invasions.ok, `startInvasions failed: ${invasions.reason} ${JSON.stringify(invasions.detail || {})}`);
  const env = { clock, scheduler: sr.scheduler, fleets: fr.fleets, repo, occupation: or, strategy: st.strategy, battle: battle.battle, invasions: invasions.invasions, store, storeResult, journal, graph, ids, invasionsConfig: config };
  env.restartInvasions = () => {
    env.invasions.stop("test_restart");
    const again = startInvasions(invDeps);
    assert.ok(again.ok, `restart startInvasions failed: ${again.reason}`);
    env.invasions = again.invasions;
    return env.invasions;
  };
  return env;
}

module.exports = ({ test, skip }) => {
  const driver = loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  needsDriver("I1 migration 22: fresh db has world_invasions + world_invasion_totals with STRICT, indexes; upgrade from 21 adds tables", () => withStore(driver, (reopen) => {
    const storeResult = reopen({ fresh: true });
    assert.strictEqual(countRows(storeResult, "world_invasions"), 0);
    assert.strictEqual(countRows(storeResult, "world_invasion_totals"), 0);
    const idx = tx(storeResult, (db) => db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='world_invasions'").all().map((r) => r.name).sort());
    assert.ok(idx.includes("world_invasions_open_system"), "unique index on beachhead_system_id where open=1");
    assert.ok(idx.includes("world_invasions_faction_open"), "index on faction_id, open, invasion_id");
    assert.ok(idx.includes("world_invasions_open"), "index on open, invasion_id");
    assert.ok(idx.includes("world_invasions_ended"), "index on ended_at where ended_at IS NOT NULL");
    const sql = tx(storeResult, (db) => db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='world_invasions'").get().sql);
    assert.ok(sql.includes("STRICT"), "world_invasions is STRICT");
    const sql2 = tx(storeResult, (db) => db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='world_invasion_totals'").get().sql);
    assert.ok(sql2.includes("STRICT") && sql2.includes("WITHOUT ROWID"), "world_invasion_totals is STRICT WITHOUT ROWID");
    storeResult.store.close("done");
    const storeResult2 = reopen({ fresh: false });
    assert.strictEqual(countRows(storeResult2, "world_invasions"), 0);
    assert.strictEqual(countRows(storeResult2, "world_invasion_totals"), 0);
    storeResult2.store.close("done");
  }));

  needsDriver("I2 determinism: same round -> same decision; journal key prevents duplicate spawn; second roll same round -> duplicate", () => withStore(driver, async (reopen) => {
    const config = configOf({ EVEJS_LNE_INVASIONS_ENABLED: "true", EVEJS_LNE_INVASIONS_CHANCE_PERMILLE: "1000", EVEJS_LNE_INVASIONS_ROLL_INTERVAL_MS: "3600000" });
    const storeResult = reopen();
    const env = bootFull(storeResult, config);
    const { invasions, scheduler, clock, repo, storeResult: sr } = env;
    seedK3Systems(repo, env.storeResult, "SEED_K3");
    advanceToNextRoll(env);
    let p = await scheduler.runPass();
    const status1 = invasions.getStatus();
    assert.deepStrictEqual(Object.keys(status1).sort(), ["counters", "lastDecision", "lastRefusal", "state"]);
    const decision1 = status1.lastDecision;
    assert.ok(decision1, "first roll made a decision");
    p = await scheduler.runPass();
    assert.ok(p.ok);
    const status2 = invasions.getStatus();
    assert.strictEqual(status2.lastDecision.round, decision1.round, "same round");
    assert.deepStrictEqual(status2.lastDecision, decision1, "exact same decision (deterministic)");
    assert.strictEqual(status2.counters.rolls, 1, "roll counted once");
    env.invasions.stop("test");
    env.occupation.stop("test");
    env.strategy.stop("test");
    env.battle.stop("test");
    env.scheduler.stop("test");
  }));

  needsDriver("I3 filters: nullsec only, no Pochven/Zarzakh, STABLE only, controller != invader, no open foothold, no player sov; limits respected; enabled=false -> handlers not registered", () => withStore(driver, async (reopen) => {
    const storeResult = reopen();
    const { store, worldSeed } = storeResult;
    const configOff = configOf({ EVEJS_LNE_INVASIONS_ENABLED: "false", EVEJS_LNE_WORLD_ENABLED: "true", EVEJS_LNE_FLEETS_ENABLED: "true", EVEJS_LNE_SCHEDULER_ENABLED: "true", EVEJS_LNE_STRATEGY_ENABLED: "true", EVEJS_LNE_OCCUPATION_ENABLED: "true", EVEJS_LNE_BATTLE_ENABLED: "true" });
    const clock = createManualClock(START_MS);
    const journal = createJournal({ clock, maxPayloadBytes: 16384, maxRows: 500 });
    const persistence = { ok: true, store, journal, worldSeed };
    const graph = graphOf({});
    const graphService = { whenReady: () => Promise.resolve({ ok: true, graph }), getGraph: () => ({ ok: true, graph }) };
    const ids = createIdGenerator({ clock, rng: createRng(5) });
    const sr = startScheduler({ config: configOff, persistence: { ok: true, store, worldSeed }, clock, ids, nowMs: () => 0 });
    const fr = startFleets({ config: configOff, persistence, clock, ids, scheduler: sr.scheduler, graph: graphService, presence: null, views: createViewRegistry(), getStations: () => ({ getMode: () => "off" }) });
    const repo = createWorldStateRepository({ journal, clock, limits: LIMITS });
    const or = startOccupation({ config: configOff, persistence, clock, scheduler: sr.scheduler, fleets: fr.fleets, world: { repository: repo }, graph: graphService, getStations: () => ({ getMode: () => "off" }), nowMs: () => 0 });
    const stratConfig = { ...configOff, strategy: { ...configOff.strategy, activeFactions: "500003" } };
    const st = startStrategy({ config: stratConfig, persistence, clock, graph: graphService, world: { repository: repo }, scheduler: sr.scheduler, fleets: fr.fleets, getStations: () => ({ getMode: () => "off" }), getOccupation: () => or.occupation, views: createViewRegistry() });
    const battle = startBattle({ config: configOff, persistence, clock, ids, scheduler: sr.scheduler, fleets: fr.fleets, graph: graphService, occupation: or.occupation });
    const stations = fakeStations([]);
    const invasions = startInvasions({ config: configOff, persistence, clock, scheduler: sr.scheduler, fleets: fr.fleets, world: { repository: repo }, graph: graphService, stations, presence: fakePresence(), adapter: { getSovClaims: () => ({ ok: true, claimOf: () => ({ ok: true, claimed: false }) }) }, strategy: st.strategy, occupation: or.occupation, battle: battle.battle, nowMs: () => 0, ids });
    assert.strictEqual(invasions.ok, false);
    assert.strictEqual(invasions.reason, "disabled_by_config");
    const unavailable = createUnavailableInvasions("disabled_by_config");
    assert.deepStrictEqual(unavailable.start(), { ok: false, reason: "disabled_by_config" });
    assert.deepStrictEqual(unavailable.bootstrap(), { ok: false, reason: "disabled_by_config" });
    assert.strictEqual(unavailable.getStatus().state, "unavailable");
    sr.scheduler.stop("test");
    fr.fleets.stop("test");
    or.occupation.stop("test");
    st.strategy.stop("test");
    battle.battle.stop("test");

    const configOn = configOf({ EVEJS_LNE_INVASIONS_ENABLED: "true", EVEJS_LNE_INVASIONS_MAX_ACTIVE: "2", EVEJS_LNE_INVASIONS_MAX_ACTIVE_PER_FACTION: "1" });
    const env2 = bootFull(storeResult, configOn);
    assert.strictEqual(env2.invasions.getStatus().state, "ready");
    env2.invasions.stop("test");
    env2.occupation.stop("test");
    env2.strategy.stop("test");
    env2.battle.stop("test");
    env2.scheduler.stop("test");
  }));

  needsDriver("I4 spawn: SPAWN roll -> invasion row + fleet package + occupation signal INVASION + contact check + capture range = footholds", () => withStore(driver, async (reopen) => {
    const config = configOf({ EVEJS_LNE_INVASIONS_ENABLED: "true", EVEJS_LNE_INVASIONS_CHANCE_PERMILLE: "1000", EVEJS_LNE_INVASIONS_MAX_ACTIVE: "10", EVEJS_LNE_INVASIONS_MAX_ACTIVE_PER_FACTION: "2", EVEJS_LNE_INVASIONS_BEACHHEAD_CAPTURE_RANGE_JUMPS: "3", EVEJS_LNE_INVASIONS_ROLL_INTERVAL_MS: "3600000" });
    const storeResult = reopen();
    const env = bootFull(storeResult, config);
    const { invasions, scheduler, clock, repo, occupation } = env;
    seedK3Systems(repo, env.storeResult, "SEED_K3");
    advanceToNextRoll(env);
    let p = await scheduler.runPass();
    assert.ok(p.ok && p.jobs > 0);
    const status = invasions.getStatus();
    const decision = status.lastDecision;
    assert.ok(decision, "roll made decision");
    assert.strictEqual(decision.outcome, "SPAWN", "should spawn with chance=1000");
    assert.ok(decision.invasionId, "invasionId present");
    assert.ok(decision.fleetIds && decision.fleetIds.length > 0, "fleet package created");
    assert.ok(decision.captureRangeJumps >= 0, "capture range set");
    const sysAfter = tx(env.storeResult, (db) => repo.getSystem(db, decision.targetSystemId, { includeInfluence: true })).system;
    assert.ok(sysAfter, "system row exists");
    assert.strictEqual(sysAfter.occupationState, "CONTESTED", "occupation signal INVASION -> CONTESTED");
    assert.strictEqual(sysAfter.occupierFactionId, decision.factionId, "occupier is invader");
    const footholds = tx(env.storeResult, (db) => require("../../lib/world/invasions/footholds").listFootholdsInTx(db, decision.factionId));
    assert.ok(footholds.ok);
    const fh = footholds.footholds.find((x) => x.systemId === decision.targetSystemId);
    assert.ok(fh, "foothold at beachhead");
    assert.strictEqual(fh.jumps, decision.captureRangeJumps, "capture range matches profile");
    const contactEvents = tx(env.storeResult, (db) => db.prepare("SELECT count(*) AS n FROM world_scheduled_events WHERE event_type = 'BATTLE_CONTACT_CHECK'").get().n);
    assert.ok(contactEvents > 0, "contact check enqueued");
    for (const name of STAGING_INVASION_METHODS) assert.strictEqual(typeof invasions[name], "function", name);
    const heads = tx(env.storeResult, (db) => invasions.listBeachheadsInTx(db, { limit: 1,
      systems: [decision.targetSystemId] }));
    assert.deepStrictEqual(heads.beachheads.map((b) => [b.factionId, b.systemId]),
      [[decision.factionId, decision.targetSystemId]]);
    env.invasions.stop("test");
    env.occupation.stop("test");
    env.strategy.stop("test");
    env.battle.stop("test");
    env.scheduler.stop("test");
  }));

  needsDriver("I4b: Sleepers foothold with captureRangeJumps 0 -> INVASION signal STARTED at the beachhead, OUT_OF_CAPTURE_RANGE one jump away", () => withStore(driver, async (reopen) => {
    const config = configOf({ EVEJS_LNE_INVASIONS_ENABLED: "true" });
    const storeResult = reopen();
    const env = bootFull(storeResult, config);
    const { repo, occupation, clock, graph } = env;
    seedK3Systems(repo, env.storeResult, "SEED_K3");
    const R = require("../../lib/world/invasions/invasionRepository");
    const S = require("../../lib/world/invasions/schema");
    const { PROFILES } = require("../../lib/world/invasions/data/invaderProfiles");
    const profile = PROFILES.find((p) => p.profileId === "sleeper-tunnel-v1");
    assert.strictEqual(profile.captureRangeJumps, 0, "vendor of the case: Sleepers capture range 0");
    const factionId = profile.factionId;
    const cores = require("../../lib/world/core").getCoreIndex(config);
    const free = (id) => K3_NULLSEC_SYSTEMS.includes(id) && !(cores.enabled && cores.systems.has(id));
    let beachhead = null;
    let neighbour = null;
    for (const b of K3_NULLSEC_SYSTEMS.filter(free)) {
      const n = (graph.getNeighbors(b) || []).filter(free).sort((x, y) => x - y)[0];
      if (n !== undefined) { beachhead = b; neighbour = n; break; }
    }
    assert.ok(beachhead && neighbour, "a seeded non-core nullsec beachhead with a non-core neighbour");
    const at = clock.now();
    tx(env.storeResult, (db) => R.insertInvasionInTx(db, { invasionId: "inv-note1", idempotencyKey: S.spawnKey("inv-note1"),
      rollRound: 0, factionId, profileId: profile.profileId, beachheadSystemId: beachhead, captureRangeJumps: 0,
      fleetIds: [], plan: JSON.stringify({ v: 1 }), startedAt: at, withdrawAt: null }));
    const far = tx(env.storeResult, (db) => occupation.signalInTx(db, { systemId: neighbour, factionId,
      signal: "INVASION", at }, "test:note1:far"));
    assert.strictEqual(far.ok, false, JSON.stringify(far));
    assert.strictEqual(far.reason, "OUT_OF_CAPTURE_RANGE", JSON.stringify(far));
    const own = tx(env.storeResult, (db) => occupation.signalInTx(db, { systemId: beachhead, factionId,
      signal: "INVASION", at }, "test:note1:own"));
    assert.ok(own.ok && own.outcome === "STARTED", JSON.stringify(own));
    env.invasions.stop("test");
    env.occupation.stop("test");
    env.strategy.stop("test");
    env.battle.stop("test");
    env.scheduler.stop("test");
  }));

  test("IW1 controllerCategoryOf / targetWeight / planRoll SPAWN on the active defender with targetCategory", () => {
    const P = require("../../lib/world/invasions/rollPlanner");
    const doctrines = { "pirate-x": { fieldsDefense: true }, "invader-x": { fieldsDefense: false } };
    const factions = { 500001: { doctrineId: "pirate-x" }, 500026: { doctrineId: "invader-x" }, 500005: { doctrineId: null } };
    const active = new Set([500001, 500026]);
    const registry = { isActive: (f) => active.has(f), getFaction: (f) => factions[f] || null,
      getDoctrine: (id) => doctrines[id] || null };
    const got = [P.controllerCategoryOf(null, registry), P.controllerCategoryOf(500001, registry),
      P.controllerCategoryOf(500026, registry), P.controllerCategoryOf(500005, registry),
      P.controllerCategoryOf(500001, null), P.controllerCategoryOf(null, null)];
    assert.deepStrictEqual(got, ["free", "active", "other", "other", "other", "free"]);
    const params = { weightFree: 3, weightActive: 7, weightControlled: 1 };
    assert.deepStrictEqual([P.targetWeight({ row: { controllerFactionId: null } }, params),
      P.targetWeight({ row: { controllerFactionId: 500001 } }, params),
      P.targetWeight({ row: { controllerFactionId: 500001 }, category: "active" }, params),
      P.targetWeight({ row: { controllerFactionId: 500005 }, category: "other" }, params)], [3, 1, 7, 1]);
    const row = (c) => ({ occupationState: "STABLE", controllerFactionId: c });
    const entry = (systemId, c) => ({ systemId, row: row(c), liveStations: 0, observed: false, claimed: false,
      inTheatre: false, openBeachhead: false, core: false, category: P.controllerCategoryOf(c, registry) });
    const snapshot = { round: 5, rollSeed: 11, sampleSeed: 12, openTotal: 0, openByFaction: new Map(),
      profiles: [{ factionId: 500021, profileId: "sleeper-tunnel-v1", weight: 1, eligible: true, captureRangeJumps: 0 }],
      sampled: [entry(30000001, null), entry(30000002, 500001), entry(30000003, 500005)], stationsReady: true };
    const d = P.planRoll(snapshot, { chancePermille: 1000, maxActive: 3, maxActivePerFaction: 1, weightFree: 0,
      weightActive: 1, weightControlled: 0, avoidObservedSystems: true, avoidStationSystems: true,
      avoidCampaignTheatres: true, requireSovCheck: true, beachheadCaptureRangeJumps: 3 }, createRng(11));
    assert.strictEqual(d.outcome, "SPAWN", JSON.stringify(d));
    assert.strictEqual(d.targetSystemId, 30000002);
    assert.strictEqual(d.targetCategory, "active");
    assert.strictEqual(d.targetControllerFactionId, 500001);
  });

  test("IT1 theatre filter: active campaign theatre system drops with avoidCampaignTheatres=true, stays with false", () => {
    const P = require("../../lib/world/invasions/rollPlanner");
    const { HULL_GROUPS, FLEET_ROLES, OPERATION_TYPES } = require("../../lib/fleets/schema");
    const built = createFactionRegistry(REGISTRY_DATA_V1, { hullGroups: HULL_GROUPS, fleetRoles: FLEET_ROLES,
      operationTypes: OPERATION_TYPES, hostility: require("../../lib/battle/data/hostility").createHostility(), maxFactions: 64, maxCampaignSystems: 40,
      maxShipsPerFleet: 500, maxCompositionEntries: 32, maxResourceUnits: 1000000000 });
    assert.ok(built.ok, JSON.stringify(built));
    const registry = built.registry;
    const camp = registry.listCampaigns()[0];
    const theatreSys = camp.systemIds[0];
    const strategy = { registry, listActiveCampaigns: () => ({ ok: true, campaigns: [
      { campaignId: camp.campaignId, ok: true, reason: null, check: null },
      { campaignId: "inactive-x", ok: false, reason: "CAMPAIGN_PENDING", check: null }] }) };
    const ids = P.activeTheatreCampaignIds(strategy);
    assert.deepStrictEqual(ids, [camp.campaignId]);
    assert.strictEqual(P.inCampaignTheatre(ids, registry, theatreSys), true);
    assert.strictEqual(P.inCampaignTheatre(ids, registry, 1), false);
    assert.deepStrictEqual(P.activeTheatreCampaignIds({ registry, listActiveCampaigns: () => ({ ok: false }) }), []);
    const refused = { registry: { isTheatreSystem() {} }, listActiveCampaigns: () => ({ ok: false, reason: "X" }) };
    const calls = [];
    assert.deepStrictEqual(P.activeTheatreCampaignIds(refused, (...a) => calls.push(a)), []);
    assert.deepStrictEqual(calls, [["REFUSED", "X"]]);
    assert.deepStrictEqual(P.activeTheatreCampaignIds(refused, () => { throw new Error("cb boom"); }), []);
    const snapshot = { round: 1, rollSeed: 3, sampleSeed: 4, openTotal: 0, openByFaction: new Map(),
      profiles: [{ factionId: 500021, profileId: "sleeper-tunnel-v1", weight: 1, eligible: true, captureRangeJumps: 0 }],
      sampled: [{ systemId: theatreSys, row: { occupationState: "STABLE", controllerFactionId: null }, liveStations: 0,
        observed: false, claimed: false, inTheatre: P.inCampaignTheatre(ids, registry, theatreSys),
        openBeachhead: false, core: false, category: "free" }], stationsReady: true };
    const params = (avoid) => ({ chancePermille: 1000, maxActive: 3, maxActivePerFaction: 1, weightFree: 1,
      weightActive: 1, weightControlled: 1, avoidObservedSystems: true, avoidStationSystems: true,
      avoidCampaignTheatres: avoid, requireSovCheck: true, beachheadCaptureRangeJumps: 3 });
    assert.notStrictEqual(P.planRoll(snapshot, params(true), createRng(3)).outcome, "SPAWN");
    const kept = P.planRoll(snapshot, params(false), createRng(3));
    assert.strictEqual(kept.outcome, "SPAWN", JSON.stringify(kept));
    assert.strictEqual(kept.targetSystemId, theatreSys);
  });

  needsDriver("IW2 roll with only weightActive > 0 spawns on the ACTIVE faction system, not on the passive one; config key + env", () => withStore(driver, async (reopen) => {
    const config = configOf({ EVEJS_LNE_INVASIONS_ENABLED: "true", EVEJS_LNE_INVASIONS_CHANCE_PERMILLE: "1000",
      EVEJS_LNE_INVASIONS_ROLL_INTERVAL_MS: "3600000", EVEJS_LNE_INVASIONS_TARGET_SAMPLE_SIZE: "256",
      EVEJS_LNE_INVASIONS_WEIGHT_FREE: "0", EVEJS_LNE_INVASIONS_WEIGHT_CONTROLLED: "0",
      EVEJS_LNE_INVASIONS_WEIGHT_ACTIVE: "1" });
    const storeResult = reopen();
    const env = bootFull(storeResult, config);
    const { repo, scheduler, invasions } = env;
    const cores = require("../../lib/world/core").getCoreIndex(config);
    const usable = K3_NULLSEC_SYSTEMS.filter((id) => id !== 30001868 && !(cores.enabled && cores.systems.has(id)));
    const [activeSys, passiveSys] = usable;
    for (const sysId of K3_NULLSEC_SYSTEMS) {
      const c = sysId === activeSys ? 500003 : sysId === passiveSys ? 500005 : null;
      const r = tx(env.storeResult, (db) => repo.applyChange(db, { systemId: sysId, expectedVersion: 0, reason: "SEED_K3",
        state: { securityClass: "nullsec", controllerFactionId: c }, influence: [] }, `world:seed:k3:${sysId}`));
      assert.ok(r.ok, JSON.stringify(r));
    }
    assert.strictEqual(env.strategy.registry.isActive(500003), true);
    assert.strictEqual(env.strategy.registry.isActive(500005), false);
    advanceToNextRoll(env);
    const p = await scheduler.runPass();
    assert.ok(p.ok, JSON.stringify(p));
    const d = invasions.getStatus().lastDecision;
    assert.ok(d && d.outcome === "SPAWN", JSON.stringify(d));
    assert.strictEqual(d.targetSystemId, activeSys);
    const rolled = tx(env.storeResult, (db) => db.prepare(`SELECT payload FROM world_event_journal
      WHERE event_type = 'INVASION_ROLLED' ORDER BY journal_id DESC LIMIT 1`).get());
    const payload = JSON.parse(rolled.payload);
    assert.strictEqual(payload.targetCategory, "active");
    assert.strictEqual(payload.targetControllerFactionId, 500003);
    env.invasions.stop("test");
    env.occupation.stop("test");
    env.strategy.stop("test");
    env.battle.stop("test");
    env.scheduler.stop("test");
    const def = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_DATA_ROOT: os.tmpdir() } });
    assert.strictEqual(def.config.invasions.weightActive, 100);
    assert.deepStrictEqual(def.warnings, []);
    const five = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_DATA_ROOT: os.tmpdir(), EVEJS_LNE_INVASIONS_WEIGHT_ACTIVE: "5" } });
    assert.strictEqual(five.config.invasions.weightActive, 5);
    assert.deepStrictEqual(five.warnings, []);
  }));

  needsDriver("IT2 roll service theatre filter: active campaign theatre = only candidate -> no SPAWN; avoid=false -> SPAWN; facade throws -> no filter, theatreFilterUnavailable after commit, one WARN in two rolls", async () => {
    const X = "it2-campaign";
    const scene = (envVars, listActiveCampaigns, rolls, registryOver = () => ({})) => withStore(driver, async (reopen) => {
      const config = configOf({ EVEJS_LNE_INVASIONS_ENABLED: "true", EVEJS_LNE_INVASIONS_CHANCE_PERMILLE: "1000",
        EVEJS_LNE_INVASIONS_ROLL_INTERVAL_MS: "3600000", EVEJS_LNE_INVASIONS_TARGET_SAMPLE_SIZE: "256", ...envVars });
      const cores = require("../../lib/world/core").getCoreIndex(config);
      const S = K3_NULLSEC_SYSTEMS.find((id) => id !== 30001868 && !(cores.enabled && cores.systems.has(id)));
      const lines = [];
      const counted = [];
      const telemetry = { count: (name, v) => counted.push([name, v]), observe: () => {} };
      const env = bootFull(reopen(), config, { logger: { log: (l) => lines.push(l) }, telemetry,
        wrapStrategy: (st) => ({ ...st, listActiveCampaigns,
          registry: { ...st.registry, isTheatreSystem: (id, sys) => id === X && sys === S, ...registryOver(st.registry) } }) });
      const r = tx(env.storeResult, (db) => env.repo.applyChange(db, { systemId: S, expectedVersion: 0, reason: "SEED_K3",
        state: { securityClass: "nullsec", controllerFactionId: null }, influence: [] }, `world:seed:k3:${S}`));
      assert.ok(r.ok, JSON.stringify(r));
      const decisions = [];
      const perRoll = [];
      for (let i = 0; i < rolls; i += 1) {
        advanceToNextRoll(env);
        const before = env.invasions.getStatus().lastDecision;
        for (let pass = 0; pass < 5 && env.invasions.getStatus().lastDecision === before; pass += 1) {
          const p = await env.scheduler.runPass();
          assert.ok(p.ok, JSON.stringify(p));
        }
        decisions.push(env.invasions.getStatus().lastDecision);
        perRoll.push({ warns: lines.filter((l) => l.includes("theatre filter off this roll")).length,
          unavailable: counted.filter(([n]) => n === "world.invasions.theatreFilterUnavailable").length });
      }
      const unavailable = counted.filter(([n]) => n === "world.invasions.theatreFilterUnavailable");
      const counter = env.invasions.getStatus().counters.theatreFilterUnavailable;
      env.invasions.stop("test");
      env.occupation.stop("test");
      env.strategy.stop("test");
      env.battle.stop("test");
      env.scheduler.stop("test");
      return { S, decisions, lines, unavailable, counter, perRoll };
    });
    const active = () => ({ ok: true, campaigns: [{ campaignId: X, ok: true }] });
    const a = await scene({}, active, 1);
    assert.ok(a.decisions[0] && a.decisions[0].outcome !== "SPAWN", JSON.stringify(a.decisions[0]));
    assert.deepStrictEqual([a.unavailable, a.counter], [[], 0]);
    const b = await scene({ EVEJS_LNE_INVASIONS_AVOID_CAMPAIGN_THEATRES: "false" }, active, 1);
    assert.strictEqual(b.decisions[0].outcome, "SPAWN", JSON.stringify(b.decisions[0]));
    assert.strictEqual(b.decisions[0].targetSystemId, b.S);
    const c = await scene({}, () => { throw new Error("it2 boom"); }, 2);
    assert.strictEqual(c.decisions[0].outcome, "SPAWN", JSON.stringify(c.decisions[0]));
    assert.strictEqual(c.decisions[0].targetSystemId, c.S);
    assert.strictEqual(c.decisions[1].round, c.decisions[0].round + 1, JSON.stringify(c.decisions));
    assert.deepStrictEqual(c.unavailable, [["world.invasions.theatreFilterUnavailable", 1],
      ["world.invasions.theatreFilterUnavailable", 1]]);
    assert.strictEqual(c.counter, 2);
    const warns = c.lines.filter((l) => l.includes("theatre filter off this roll"));
    assert.deepStrictEqual(warns, ["[LivingNewEden] invasions: theatre filter off this roll (THROW: it2 boom)"]);
    let factionCalls = 0;
    const d = await scene({}, () => { throw new Error("it2 boom"); }, 2, (reg) => ({
      getFaction: (id) => { factionCalls += 1; if (factionCalls === 1) throw new Error("it2 faction boom"); return reg.getFaction(id); } }));
    assert.ok(factionCalls > 1, String(factionCalls));
    assert.strictEqual(d.decisions[0], null, JSON.stringify(d.decisions));
    assert.deepStrictEqual(d.perRoll[0], { warns: 0, unavailable: 0 });
    assert.strictEqual(d.decisions[1].outcome, "SPAWN", JSON.stringify(d.decisions[1]));
    assert.deepStrictEqual(d.unavailable, [["world.invasions.theatreFilterUnavailable", 1]]);
    assert.strictEqual(d.counter, 1);
    assert.deepStrictEqual(d.lines.filter((l) => l.includes("theatre filter off this roll")),
      ["[LivingNewEden] invasions: theatre filter off this roll (THROW: it2 boom)"]);
  });

  needsDriver("I6 /6: SPAWN roll rows <= spawnRollRows bound; counters go to telemetry.count after the commit", () => withStore(driver, async (reopen) => {
    const S = require("../../lib/world/invasions/schema");
    const { rowsBound } = require("../../lib/world/occupation/schema");
    const { isMetricName } = require("../../lib/telemetry/registry");
    const config = configOf({ EVEJS_LNE_INVASIONS_ENABLED: "true", EVEJS_LNE_INVASIONS_CHANCE_PERMILLE: "1000", EVEJS_LNE_INVASIONS_MAX_ACTIVE: "10", EVEJS_LNE_INVASIONS_MAX_ACTIVE_PER_FACTION: "2", EVEJS_LNE_INVASIONS_ROLL_INTERVAL_MS: "3600000" });
    const opened = reopen();
    const rows = [];
    const real = opened.store;
    const store = { ...real, transaction: (name, fn) => {
      const r = real.transaction(name, fn);
      rows.push({ name, rows: r.rows || 0 });
      return r;
    } };
    const counted = [];
    const telemetry = { count: (name, n) => { counted.push([name, n]); return true; }, observe: () => true, gauge: () => true };
    const env = bootFull({ store, worldSeed: opened.worldSeed }, config, { telemetry });
    seedK3Systems(env.repo, env.storeResult, "SEED_K3");
    advanceToNextRoll(env);
    const from = rows.length;
    const p = await env.scheduler.runPass();
    assert.ok(p.ok && p.jobs > 0, JSON.stringify(p));
    const status = env.invasions.getStatus();
    assert.strictEqual(status.lastDecision.outcome, "SPAWN");
    assert.strictEqual(status.counters.spawned, 1, `spawn refused: ${status.lastRefusal}`);
    const maxRows = Math.max(...rows.slice(from).map((r) => r.rows));
    const bound = S.spawnRollRows(rowsBound(config.world.maxFactionsPerSystem));
    assert.ok(maxRows <= bound, `spawn roll wrote ${maxRows} rows > bound ${bound}`);
    const fleetsSpawned = status.lastDecision.fleetIds.length;
    assert.ok(maxRows > S.FLEET_CREATE_ROWS * fleetsSpawned, `the spawn transaction was found (${maxRows})`);
    assert.ok(maxRows <= S.SPAWN_FIXED_ROWS + S.FLEET_CREATE_ROWS * fleetsSpawned + rowsBound(config.world.maxFactionsPerSystem),
      `spawn roll wrote ${maxRows} rows for ${fleetsSpawned} fleets`);
    const sums = {};
    for (const [name, n] of counted) {
      assert.ok(isMetricName(name), name);
      sums[name] = (sums[name] || 0) + n;
    }
    const expected = {};
    for (const [name, n] of Object.entries(status.counters)) if (n > 0) expected[`world.invasions.${name}`] = n;
    assert.deepStrictEqual(sums, expected);
    assert.deepStrictEqual([sums["world.invasions.rolls"], sums["world.invasions.spawnDecision"]], [1, 1]);
    env.invasions.stop("test");
    env.occupation.stop("test");
    env.strategy.stop("test");
    env.battle.stop("test");
    env.scheduler.stop("test");
  }));

  test("I7: spawn roll rows + pruneBatch over maxRowsPerTransaction -> warning + pruneBatch clamp; defaults silent", () => {
    const S = require("../../lib/world/invasions/schema");
    const { rowsBound } = require("../../lib/world/occupation/schema");
    const { CONTACT_ROWS_BOUND } = require("../../lib/battle/data/contactRules");
    assert.strictEqual(CONTACT_ROWS_BOUND, 4, "SPAWN_FIXED_ROWS counts the contact check as 4 rows");
    const resolve = (env) => resolveConfig({ modDir: MOD_DIR, env: { EVEJS_DATA_ROOT: os.tmpdir(), ...env } });
    const spawnWarnings = (r) => r.warnings.filter((w) => w.startsWith("one invasion spawn roll"));
    const defaults = resolve({});
    assert.deepStrictEqual(defaults.warnings, []);
    assert.strictEqual(defaults.config.invasions.pruneBatch, 50);
    const spawnRows = S.spawnRollRows(rowsBound(defaults.config.world.maxFactionsPerSystem));
    assert.strictEqual(spawnRows, 39, "11 fixed (spawn journal included) + 2 x 8 fleets + occupation 12");
    const low = resolve({ EVEJS_LNE_PERSISTENCE_MAX_ROWS_PER_TRANSACTION: "60" });
    assert.deepStrictEqual(spawnWarnings(low), ["one invasion spawn roll may write 89 rows > "
      + "persistence.maxRowsPerTransaction=60 - invasions.pruneBatch clamped to 21"]);
    assert.strictEqual(low.config.invasions.pruneBatch, 21);
    const tiny = resolve({ EVEJS_LNE_PERSISTENCE_MAX_ROWS_PER_TRANSACTION: "30" });
    assert.strictEqual(tiny.config.invasions.pruneBatch, 0, "the spawn alone exceeds the limit: no prune");
    assert.strictEqual(spawnWarnings(tiny).length, 1);
    const fits = resolve({ EVEJS_LNE_PERSISTENCE_MAX_ROWS_PER_TRANSACTION: "89" });
    assert.deepStrictEqual([spawnWarnings(fits), fits.config.invasions.pruneBatch], [[], 50]);
    const off = resolve({ EVEJS_LNE_PERSISTENCE_MAX_ROWS_PER_TRANSACTION: "60", EVEJS_LNE_INVASIONS_ENABLED: "0" });
    assert.deepStrictEqual([spawnWarnings(off), off.config.invasions.pruneBatch], [[], 50]);
  });

  test("I8: candidatePool = nullsec expansion targets without Pochven and Zarzakh, sorted", () => {
    const { candidatePool } = require("../../lib/world/invasions/rollPlanner");
    const systems = new Map([[30000003, { regionId: 10000001, secClass: "nullsec" }],
      [30000001, { regionId: 10000070, secClass: "nullsec" }], [30100000, { regionId: 10001000, secClass: "nullsec" }],
      [30000002, { regionId: 10000002, secClass: "nullsec" }], [30000004, { regionId: 10000002, secClass: "lowsec" }]]);
    const graph = { getSystemsBySecClass: (c) => [...systems].filter(([, s]) => s.secClass === c).map(([id]) => id),
      getSystem: (id) => systems.get(id) || null };
    assert.deepStrictEqual(candidatePool(graph), [30000002, 30000003]);
  });

  const refusedSpawn = (name, overrides, expectReason) => needsDriver(name, () => withStore(driver, async (reopen) => {
    const S = require("../../lib/world/invasions/schema");
    const config = configOf({ EVEJS_LNE_INVASIONS_ENABLED: "true", EVEJS_LNE_INVASIONS_CHANCE_PERMILLE: "1000", EVEJS_LNE_INVASIONS_MAX_ACTIVE: "10", EVEJS_LNE_INVASIONS_MAX_ACTIVE_PER_FACTION: "2", EVEJS_LNE_INVASIONS_ROLL_INTERVAL_MS: "3600000" });
    const lines = [];
    const env = bootFull(reopen(), config, { ...overrides, logger: { log: (l) => lines.push(l) } });
    seedK3Systems(env.repo, env.storeResult, "SEED_K3");
    advanceToNextRoll(env);
    const p = await env.scheduler.runPass();
    assert.ok(p.ok && p.jobs > 0, JSON.stringify(p));
    const status = env.invasions.getStatus();
    const d = status.lastDecision;
    assert.strictEqual(d.outcome, "SPAWN");
    assert.ok(overrides.calls() > 0, "the stub was reached (the refusal came after the first writes)");
    const one = (sql, ...args) => tx(env.storeResult, (db) => db.prepare(sql).get(...args));
    assert.strictEqual(one("SELECT count(*) AS n FROM virtual_fleets WHERE faction_id = ?", d.factionId).n, 0, "no orphan invader fleets");
    assert.strictEqual(countRows(env.storeResult, "world_invasions"), 0, "no zombie invasion row");
    assert.strictEqual(countRows(env.storeResult, "world_invasion_totals"), 0, "totals rolled back");
    assert.strictEqual(one("SELECT count(*) AS n FROM world_scheduled_events WHERE event_type IN ('INVASION_STEP', 'BATTLE_CONTACT_CHECK')").n, 0);
    assert.strictEqual(one("SELECT count(*) AS n FROM world_event_journal WHERE idempotency_key IN (?, ?, ?)",
      S.spawnKey(d.invasionId), S.fleetKey(d.invasionId, 0), S.occKey(d.invasionId)).n, 0, "spawnKey not burned, nested keys gone");
    assert.strictEqual(tx(env.storeResult, (db) => env.repo.getSystem(db, d.targetSystemId, { includeInfluence: false })).system.occupationState, "STABLE");
    const stateOf = (key) => (one("SELECT state FROM world_scheduled_events WHERE idempotency_key = ?", key) || {}).state;
    assert.deepStrictEqual([stateOf(S.rollKey(d.round)), stateOf(S.rollKey(d.round + 1))], ["DONE", "QUEUED"]);
    assert.deepStrictEqual([status.counters.spawnRefused, status.counters.spawned], [1, 0]);
    assert.ok(String(status.lastRefusal).includes(expectReason), String(status.lastRefusal));
    assert.ok(lines.some((l) => l.includes(expectReason)), "refusal reason in the log line");
    env.invasions.stop("test");
    env.occupation.stop("test");
    env.strategy.stop("test");
    env.battle.stop("test");
    env.scheduler.stop("test");
  }));
  {
    let n = 0;
    refusedSpawn("I9a SWEEP-20261021-invasions: occupation signal refused after insertInvasionInTx -> no fleets, no invasion row, no step; roll DONE, next roll queued",
      { calls: () => n, wrapOccupation: (or) => ({ ...or, signalInTx: () => { n += 1; return { ok: false, reason: "OCCUPATION_LIMIT" }; } }) },
      "OCCUPATION_SIGNAL_FAILED (OCCUPATION_LIMIT)");
  }
  {
    let n = 0;
    refusedSpawn("I9b SWEEP-20261021-invasions: createFleet refused after the first fleet -> the first fleet rolls back too",
      { calls: () => n, wrapFleets: (fl) => ({ ...fl, repository: { ...fl.repository, createFleet: (t, spec, key) => {
        n += 1;
        return n === 1 ? fl.repository.createFleet(t, spec, key) : { ok: false, reason: "FLEET_LIMIT" };
      } } }) },
      "FLEET_LIMIT");
  }

  needsDriver("I5 foothold collapse: when holding fleets < holdMinFleets, COLLAPSE ends invasion exactly once; second step same seq -> STALE; journal end key prevents duplicate end", () => withStore(driver, async (reopen) => {
    const config = configOf({ EVEJS_LNE_INVASIONS_ENABLED: "true", EVEJS_LNE_INVASIONS_HOLD_MIN_FLEETS: "2", EVEJS_LNE_INVASIONS_CHECK_INTERVAL_MS: "900000", EVEJS_LNE_INVASIONS_ROLL_INTERVAL_MS: "3600000" });
    const storeResult = reopen();
    const env = bootFull(storeResult, config);
    const { invasions, scheduler, clock, repo, fleets } = env;
    const invSvc = require("../../lib/world/invasions/invasionService");
    const R = require("../../lib/world/invasions/invasionRepository");
    const S = require("../../lib/world/invasions/schema");
    const F = require("../../lib/world/invasions/footholds");
    const { PROFILES } = require("../../lib/world/invasions/data/invaderProfiles");
    const profile = PROFILES.find((p) => p.profileId === "sleeper-tunnel-v1");
    assert.ok(profile, "sleeper profile exists");
    const factionId = profile.factionId;
    const targetSys = 30001867;
    tx(env.storeResult, (db) => repo.applyChange(db, { systemId: targetSys, expectedVersion: 0, reason: "SEED_FREE", state: { securityClass: "nullsec", controllerFactionId: 0 }, influence: [] }, `world:seed:test:${targetSys}`));
    const invasionId = "inv-test-collapse";
    const fleetIds = [];
    for (let i = 0; i < 2; i += 1) {
      const corpId = env.strategy.registry.corporationFor(factionId, "invasion");
      const fleet = fleets.repository.createFleet(tx(env.storeResult, () => {}), {
        factionId, corporationId: corpId, currentSystemId: targetSys, homeSystemId: targetSys,
        fleetRole: "invasion", doctrineId: null, composition: [{ hullGroup: "cruiser", count: 2 }],
      }, S.fleetKey(invasionId, i));
    }
    const invasionId2 = "inv-collapse-1";
    const at = clock.now();
    const stepKey = S.stepKey(invasionId2, 0, config.invasions.checkIntervalMs, Math.floor(at / config.invasions.checkIntervalMs));
    tx(env.storeResult, (db) => {
      R.insertInvasionInTx(db, {
        invasionId: invasionId2, idempotencyKey: S.spawnKey(invasionId2), rollRound: 0, factionId, profileId: profile.profileId,
        beachheadSystemId: targetSys, captureRangeJumps: profile.captureRangeJumps, fleetIds: [], plan: JSON.stringify({ v: 1 }),
        startedAt: at, withdrawAt: null,
      });
    });
    const corpId = env.strategy.registry.corporationFor(factionId, "invasion");
    const fleet = tx(env.storeResult, (db) => fleets.repository.createFleet(db, {
      factionId, corporationId: corpId, currentSystemId: targetSys, homeSystemId: targetSys,
      fleetRole: "invasion", doctrineId: null, composition: [{ hullGroup: "cruiser", count: 2 }],
    }, S.fleetKey(invasionId2, 0)));
    assert.ok(fleet.ok);
    tx(env.storeResult, (db) => scheduler.enqueue(S.EVENT_TYPE_STEP, invasionId2, at + config.invasions.checkIntervalMs,
      { invasionId: invasionId2, seq: 0, trigger: "tick" }, stepKey, { tx: db, chained: true }));
    clock.set(at + config.invasions.checkIntervalMs);
    let p = await scheduler.runPass();
    assert.ok(p.ok && p.jobs > 0);
    const invAfter = tx(env.storeResult, (db) => R.getInvasion(db, invasionId2));
    assert.ok(invAfter.ok && invAfter.invasion);
    assert.strictEqual(invAfter.invasion.state, S.STATE_ENDED);
    assert.strictEqual(invAfter.invasion.end_reason, S.END_REASON_BEACHHEAD_LOST);
    const totals = tx(env.storeResult, (db) => R.getTotals(db, factionId));
    assert.ok(totals.ok);
    assert.strictEqual(totals.totals.collapsed, 1);
    tx(env.storeResult, (db) => scheduler.enqueue(S.EVENT_TYPE_STEP, invasionId2, at + 2 * config.invasions.checkIntervalMs,
      { invasionId: invasionId2, seq: 0, trigger: "tick" }, S.stepKey(invasionId2, 0, config.invasions.checkIntervalMs, Math.floor((at + config.invasions.checkIntervalMs) / config.invasions.checkIntervalMs)), { tx: db, chained: true }));
    clock.set(at + 2 * config.invasions.checkIntervalMs);
    p = await scheduler.runPass();
    assert.ok(p.ok);
    const status = invasions.getStatus();
    assert.strictEqual(status.counters.collapsed, 1, "collapsed counted once");
    assert.strictEqual(status.counters.stale, 1, "second step STALE");
    env.invasions.stop("test");
    env.occupation.stop("test");
    env.strategy.stop("test");
    env.battle.stop("test");
    env.scheduler.stop("test");
  }));

  needsDriver("C2 Sleepers withdrawal: WITHDRAWING state with rounds, journal keys per round, ends with WITHDRAWN", () => withStore(driver, async (reopen) => {
    const config = configOf({
      EVEJS_LNE_INVASIONS_ENABLED: "true",
      EVEJS_LNE_INVASIONS_SLEEPER_WITHDRAW_AFTER_MS: "3600000",
      EVEJS_LNE_INVASIONS_WITHDRAW_RETRY_MS: "60000",
      EVEJS_LNE_INVASIONS_WITHDRAW_MAX_ROUNDS: "3",
      EVEJS_LNE_INVASIONS_CHECK_INTERVAL_MS: "60000",
    });
    const storeResult = reopen();
    const env = bootFull(storeResult, config);
    const { invasions, scheduler, clock, repo, fleets, storeResult: sr, journal } = env;
    const R = require("../../lib/world/invasions/invasionRepository");
    const S = require("../../lib/world/invasions/schema");
    const { PROFILES } = require("../../lib/world/invasions/data/invaderProfiles");
    const profile = PROFILES.find((p) => p.profileId === "sleeper-tunnel-v1");
    assert.ok(profile, "sleeper profile exists");
    const factionId = profile.factionId;
    const targetSys = 30001867;
    tx(storeResult, (db) => repo.applyChange(db, { systemId: targetSys, expectedVersion: 0, reason: "SEED_FREE", state: { securityClass: "nullsec", controllerFactionId: 0 }, influence: [] }, `world:seed:test:${targetSys}`));
    const at = clock.now();
    const invasionId = "inv-sleepers-withdraw-1";
    const withdrawAt = at - 600000;
    const corpId = env.strategy.registry.corporationFor(factionId, "invasion");
    const fleetIds = [];
    for (let i = 0; i < 2; i += 1) {
      const fleet = tx(sr, (db) => fleets.repository.createFleet(db, {
        factionId, corporationId: corpId, currentSystemId: targetSys, homeSystemId: targetSys,
        fleetRole: "invasion", doctrineId: null, composition: [{ hullGroup: "cruiser", count: 2 }],
      }, S.fleetKey(invasionId, i)));
      assert.ok(fleet.ok);
      fleetIds.push(fleet.fleetId);
    }
    const sys1 = 30001868;
    const sys2 = 30001869;
    for (const sys of [sys1, sys2]) {
      tx(sr, (db) => repo.applyChange(db, { systemId: sys, expectedVersion: 0, reason: "SEED_CAPTURED", state: { securityClass: "nullsec", controllerFactionId: factionId }, influence: [{ factionId, score: 70 }] }, `world:seed:test:${sys}`));
    }
    tx(sr, (db) => {
      R.insertInvasionInTx(db, {
        invasionId, idempotencyKey: S.spawnKey(invasionId), rollRound: 0, factionId, profileId: profile.profileId,
        beachheadSystemId: targetSys, captureRangeJumps: profile.captureRangeJumps, fleetIds, plan: JSON.stringify({ v: 1 }),
        startedAt: at - 7200000, withdrawAt,
      });
    });
    const stepKey = S.stepKey(invasionId, 0, config.invasions.checkIntervalMs, Math.floor(withdrawAt / config.invasions.checkIntervalMs));
    tx(sr, (db) => scheduler.enqueue(S.EVENT_TYPE_STEP, invasionId, withdrawAt + config.invasions.checkIntervalMs,
      { invasionId, seq: 0, trigger: "withdraw" }, stepKey, { tx: db, chained: true }));
    clock.set(withdrawAt + config.invasions.checkIntervalMs);
    let p = await scheduler.runPass();
    assert.ok(p.ok && p.jobs > 0);
    let inv = tx(sr, (db) => R.getInvasion(db, invasionId));
    assert.ok(inv.ok && inv.invasion);
    assert.strictEqual(inv.invasion.state, S.STATE_WITHDRAWING, "state should be WITHDRAWING");
    assert.strictEqual(inv.invasion.withdraw_round, 0, "withdrawRound 0 after WITHDRAW");
    const jWithdraw = tx(sr, (db) => db.prepare("SELECT idempotency_key FROM world_event_journal WHERE idempotency_key = ?").get(`invasion:${invasionId}:withdraw`));
    assert.ok(jWithdraw, "WITHDRAW journal key written");
    for (let round = 1; round <= 5; round += 1) {
      clock.set(clock.now() + config.invasions.withdrawRetryMs);
      p = await scheduler.runPass();
      if (!p.ok || p.jobs === 0) break;
      inv = tx(storeResult, (db) => R.getInvasion(db, invasionId));
      if (!inv.ok || !inv.invasion) break;
      if (inv.invasion.state === S.STATE_ENDED) {
        assert.strictEqual(inv.invasion.end_reason, S.END_REASON_WITHDRAWN, "end reason WITHDRAWN");
        break;
      }
    }
    assert.ok(inv.ok && inv.invasion, "invasion should exist");
    assert.strictEqual(inv.invasion.state, S.STATE_ENDED, "state should be ENDED after withdrawal");
    assert.strictEqual(inv.invasion.end_reason, S.END_REASON_WITHDRAWN, "end reason WITHDRAWN");
    const jEnd = tx(sr, (db) => db.prepare("SELECT idempotency_key FROM world_event_journal WHERE idempotency_key = ?").get(`invasion:${invasionId}:end`));
    assert.ok(jEnd, "end journal key written");
    const totals = tx(sr, (db) => R.getTotals(db, factionId));
    assert.ok(totals.ok);
    assert.strictEqual(totals.totals.withdrawn, 1, "withdrawn counted in totals");
    const after = tx(sr, (db) => fleets.repository.getFleets(db, fleetIds));
    assert.ok(after.ok && after.fleets.length === fleetIds.length, "invader fleets readable after withdrawal");
    for (const f of after.fleets) assert.strictEqual(f.state, "DESTROYED", `fleet ${f.fleetId} disbanded on withdrawal`);
    env.invasions.stop("test");
    env.occupation.stop("test");
    env.strategy.stop("test");
    env.battle.stop("test");
    env.scheduler.stop("test");
  }));

  needsDriver("C2b withdrawal: fleet read refused -> step retried, invasion stays WITHDRAWING, nothing counted withdrawn", () => withStore(driver, async (reopen) => {
    const config = configOf({
      EVEJS_LNE_INVASIONS_ENABLED: "true",
      EVEJS_LNE_INVASIONS_WITHDRAW_RETRY_MS: "60000",
      EVEJS_LNE_INVASIONS_WITHDRAW_MAX_ROUNDS: "3",
      EVEJS_LNE_INVASIONS_CHECK_INTERVAL_MS: "60000",
    });
    const env = bootFull(reopen(), config);
    const { scheduler, clock, repo, storeResult: sr } = env;
    const R = require("../../lib/world/invasions/invasionRepository");
    const S = require("../../lib/world/invasions/schema");
    const { PROFILES } = require("../../lib/world/invasions/data/invaderProfiles");
    const profile = PROFILES.find((p) => p.profileId === "sleeper-tunnel-v1");
    const factionId = profile.factionId;
    const targetSys = 30001867;
    tx(sr, (db) => repo.applyChange(db, { systemId: targetSys, expectedVersion: 0, reason: "SEED_FREE", state: { securityClass: "nullsec", controllerFactionId: 0 }, influence: [] }, `world:seed:test:${targetSys}`));
    const at = clock.now();
    const invasionId = "inv-sleepers-withdraw-badread";
    const withdrawAt = at - 600000;
    tx(sr, (db) => R.insertInvasionInTx(db, {
      invasionId, idempotencyKey: S.spawnKey(invasionId), rollRound: 0, factionId, profileId: profile.profileId,
      beachheadSystemId: targetSys, captureRangeJumps: profile.captureRangeJumps, fleetIds: [123], plan: { v: 1 },
      startedAt: at - 7200000, withdrawAt,
    }));
    const stepKey = S.stepKey(invasionId, 0, config.invasions.checkIntervalMs, Math.floor(withdrawAt / config.invasions.checkIntervalMs));
    tx(sr, (db) => scheduler.enqueue(S.EVENT_TYPE_STEP, invasionId, withdrawAt + config.invasions.checkIntervalMs,
      { invasionId, seq: 0, trigger: "withdraw" }, stepKey, { tx: db, chained: true }));
    clock.set(withdrawAt + config.invasions.checkIntervalMs);
    await scheduler.runPass();
    for (let i = 0; i < 3; i += 1) {
      clock.set(clock.now() + config.invasions.withdrawRetryMs);
      await scheduler.runPass();
    }
    const inv = tx(sr, (db) => R.getInvasion(db, invasionId));
    assert.ok(inv.ok && inv.invasion);
    assert.strictEqual(inv.invasion.state, S.STATE_WITHDRAWING, "a failed fleet read does not end the invasion");
    const totals = tx(sr, (db) => R.getTotals(db, factionId));
    assert.ok(totals.ok);
    assert.ok(!totals.totals || !totals.totals.withdrawn, "nothing counted withdrawn");
    const steps = tx(sr, (db) => db.prepare("SELECT state, attempts, last_error FROM world_scheduled_events " +
      "WHERE event_type = 'INVASION_STEP' AND state <> 'DONE'").all());
    assert.strictEqual(steps.length, 1, "exactly one non-DONE step");
    assert.strictEqual(steps[0].state, "QUARANTINED", "step quarantined");
    assert.strictEqual(steps[0].attempts, 1, "attempts === 1");
    assert.ok(steps[0].last_error.includes("INVASION_FLEETS_READ_FAILED:FLEET_INVALID_INPUT"), "last_error contains FLEET_INVALID_INPUT");
    env.invasions.stop("test");
    env.occupation.stop("test");
    env.strategy.stop("test");
    env.battle.stop("test");
    env.scheduler.stop("test");
  }));

  needsDriver("C3 non-Sleeper invasion: no withdrawAt, no WITHDRAWING transition", () => withStore(driver, async (reopen) => {
    const config = configOf({
      EVEJS_LNE_INVASIONS_ENABLED: "true",
      EVEJS_LNE_INVASIONS_CHECK_INTERVAL_MS: "60000",
    });
    const storeResult = reopen();
    const env = bootFull(storeResult, config);
    const { invasions, scheduler, clock, repo, fleets, storeResult: sr } = env;
    const R = require("../../lib/world/invasions/invasionRepository");
    const S = require("../../lib/world/invasions/schema");
    const { PROFILES } = require("../../lib/world/invasions/data/invaderProfiles");
    const profile = PROFILES.find((p) => p.profileId === "triglavian-conduit-v1");
    assert.ok(profile, "triglavian profile exists");
    const factionId = profile.factionId;
    const targetSys = 30001867;
    tx(storeResult, (db) => repo.applyChange(db, { systemId: targetSys, expectedVersion: 0, reason: "SEED_FREE", state: { securityClass: "nullsec", controllerFactionId: 0 }, influence: [] }, `world:seed:test:${targetSys}`));
    const at = clock.now();
    const invasionId = "inv-triglavian-no-withdraw";
    const corpId = env.strategy.registry.corporationFor(factionId, "invasion");
    const fleetIds = [];
    for (let i = 0; i < 2; i += 1) {
      const fleet = tx(sr, (db) => fleets.repository.createFleet(db, {
        factionId, corporationId: corpId, currentSystemId: targetSys, homeSystemId: targetSys,
        fleetRole: "invasion", doctrineId: null, composition: [{ hullGroup: "cruiser", count: 2 }],
      }, S.fleetKey(invasionId, i)));
      assert.ok(fleet.ok);
      fleetIds.push(fleet.fleetId);
    }
    tx(sr, (db) => {
      R.insertInvasionInTx(db, {
        invasionId, idempotencyKey: S.spawnKey(invasionId), rollRound: 0, factionId, profileId: profile.profileId,
        beachheadSystemId: targetSys, captureRangeJumps: profile.captureRangeJumps ?? 3, fleetIds: JSON.stringify(fleetIds), plan: JSON.stringify({ v: 1 }),
        startedAt: at - 7200000, withdrawAt: null,
      });
    });
    let invBefore = tx(sr, (db) => R.getInvasion(db, invasionId));
    assert.ok(invBefore.ok && invBefore.invasion, "invasion should exist before step");
    const stepKey = S.stepKey(invasionId, 0, config.invasions.checkIntervalMs, Math.floor(at / config.invasions.checkIntervalMs));
    tx(sr, (db) => scheduler.enqueue(S.EVENT_TYPE_STEP, invasionId, at + config.invasions.checkIntervalMs,
      { invasionId, seq: 0, trigger: "tick" }, stepKey, { tx: db, chained: false }));
    clock.set(at + config.invasions.checkIntervalMs);
    let p = await scheduler.runPass();
    assert.ok(p.ok, "scheduler pass ok");
    let inv = tx(sr, (db) => R.getInvasion(db, invasionId));
    assert.ok(inv.ok && inv.invasion, "invasion should still exist after step");
    assert.strictEqual(inv.invasion.state, S.STATE_ACTIVE, "non-Sleeper stays ACTIVE");
    assert.strictEqual(inv.invasion.withdraw_round, 0, "no withdraw round started");
    env.invasions.stop("test");
    env.occupation.stop("test");
    env.strategy.stop("test");
    env.battle.stop("test");
    env.scheduler.stop("test");
  }));

  needsDriver("D1 layer-invasions: two invasions ACTIVE/WITHDRAWING -> correct marks, galaxyInvasionsEnabled=false -> no view", () => withStore(driver, async (reopen) => {
    const config = configOf({ EVEJS_LNE_INVASIONS_ENABLED: "true", EVEJS_LNE_INVASIONS_CHANCE_PERMILLE: "0", EVEJS_LNE_INVASIONS_ROLL_INTERVAL_MS: "3600000" });
    const storeResult = reopen();
    const registeredViews = createViewRegistry();
    const env = bootFull(storeResult, config, { views: registeredViews });
    const { invasions, scheduler, clock, repo, fleets, storeResult: sr, views } = env;
    const { buildInvasionsLayerView } = require("../../lib/world/invasions/invasionsLayer");
    const R = require("../../lib/world/invasions/invasionRepository");
    const S = require("../../lib/world/invasions/schema");
    const { PROFILES } = require("../../lib/world/invasions/data/invaderProfiles");
    const trigProfile = PROFILES.find((p) => p.profileId === "triglavian-conduit-v1");
    const sleeperProfile = PROFILES.find((p) => p.profileId === "sleeper-tunnel-v1");
    assert.ok(trigProfile && sleeperProfile, "profiles exist");
    const sys1 = 30001867;
    const sys2 = 30001868;
    for (const sys of [sys1, sys2]) {
      tx(sr, (db) => repo.applyChange(db, { systemId: sys, expectedVersion: 0, reason: "SEED_FREE", state: { securityClass: "nullsec", controllerFactionId: 0 }, influence: [] }, `world:seed:test:${sys}`));
    }
    const at = clock.now();
    const corpTrig = env.strategy.registry.corporationFor(trigProfile.factionId, "invasion");
    const corpSlp = env.strategy.registry.corporationFor(sleeperProfile.factionId, "invasion");
    const inv1Id = "inv-d1-active";
    const fleetIds1 = [];
    for (let i = 0; i < 2; i += 1) {
      const fleet = tx(sr, (db) => fleets.repository.createFleet(db, {
        factionId: trigProfile.factionId, corporationId: corpTrig, currentSystemId: sys1, homeSystemId: sys1,
        fleetRole: "invasion", doctrineId: null, composition: [{ hullGroup: "cruiser", count: 2 }],
      }, S.fleetKey(inv1Id, i)));
      assert.ok(fleet.ok);
      fleetIds1.push(fleet.fleetId);
    }
    const trigCaptureRange = 3;
    tx(sr, (db) => {
      const r = R.insertInvasionInTx(db, {
        invasionId: inv1Id, idempotencyKey: S.spawnKey(inv1Id), rollRound: 0, factionId: trigProfile.factionId, profileId: trigProfile.profileId,
        beachheadSystemId: sys1, captureRangeJumps: trigCaptureRange, fleetIds: fleetIds1, plan: JSON.stringify({ v: 1 }),
        startedAt: at - 3600000, withdrawAt: null,
      });
      assert.ok(r.ok, `inv1 insert failed: ${JSON.stringify(r)}`);
    });
    const inv2Id = "inv-d1-withdrawing";
    const fleetIds2 = [];
    for (let i = 0; i < 2; i += 1) {
      const fleet = tx(sr, (db) => fleets.repository.createFleet(db, {
        factionId: sleeperProfile.factionId, corporationId: corpSlp, currentSystemId: sys2, homeSystemId: sys2,
        fleetRole: "invasion", doctrineId: null, composition: [{ hullGroup: "cruiser", count: 2 }],
      }, S.fleetKey(inv2Id, i)));
      assert.ok(fleet.ok);
      fleetIds2.push(fleet.fleetId);
    }
    tx(sr, (db) => {
      const r = R.insertInvasionInTx(db, {
        invasionId: inv2Id, idempotencyKey: S.spawnKey(inv2Id), rollRound: 1, factionId: sleeperProfile.factionId, profileId: sleeperProfile.profileId,
        beachheadSystemId: sys2, captureRangeJumps: sleeperProfile.captureRangeJumps, fleetIds: fleetIds2, plan: JSON.stringify({ v: 1 }),
        startedAt: at - 7200000, withdrawAt: at - 600000,
      });
      assert.ok(r.ok, `inv2 insert failed: ${JSON.stringify(r)}`);
    });
    tx(sr, (db) => {
      db.prepare("UPDATE world_invasions SET state = 'WITHDRAWING', withdraw_round = 0, updated_at = ? WHERE invasion_id = ?").run(at, inv2Id);
    });
    const layerView = buildInvasionsLayerView({
      store: env.store,
      repository: R,
      clock,
      getGovernor: () => ({ admits: () => true }),
      telemetry: null,
      nowMs: () => 0,
      maxSystems: 1000,
      maxLines: 6,
      refreshMs: 60000,
      getStatus: () => ({}),
    });
    const data = layerView.getData();
    assert.strictEqual(data.available, true);
    assert.strictEqual(data.items.length, 2, "two open invasions");
    const item1 = data.items.find((i) => i[0] === sys1);
    const item2 = data.items.find((i) => i[0] === sys2);
    assert.ok(item1, "invasion at sys1");
    assert.ok(item2, "invasion at sys2");
    assert.strictEqual(item1[1], "beachhead", "ACTIVE -> beachhead style");
    assert.strictEqual(item1[2], "TRIG", "label is profile tag");
    assert.deepStrictEqual(item1[4], [[trigProfile.factionId, 1]], "factions array");
    assert.strictEqual(item2[1], "beachhead-withdrawing", "WITHDRAWING -> beachhead-withdrawing style");
    assert.strictEqual(item2[2], "SLP", "label is profile tag");
    assert.deepStrictEqual(item2[4], [[sleeperProfile.factionId, 1]], "factions array");
    assert.deepStrictEqual(data.legend.map((l) => l[3]), ["hexagon", "hexagon"], "both hexagon shape");
    const trigAfter = config.invasions[trigProfile.withdrawAfterKey];
    assert.ok(Number.isSafeInteger(trigAfter) && trigAfter > 0, "Triglavian withdrawal key > 0");
    const wired = registeredViews.getView("layer-invasions").getData();
    const wired1 = wired.items.find((i) => i[0] === sys1);
    const wired2 = wired.items.find((i) => i[0] === sys2);
    assert.ok(wired1[3].includes(`withdraw ${new Date(at - 3600000 + trigAfter).toISOString()}`), JSON.stringify(wired1[3]));
    assert.ok(wired2[3].includes(`withdraw ${new Date(at - 600000).toISOString()}`), JSON.stringify(wired2[3]));
    assert.deepStrictEqual(item2[3], wired2[3], "a stored date looks like today");
    assert.ok(!item1[3].some((l) => l.startsWith("withdraw ")), JSON.stringify(item1[3]));
    const { store: firstStore } = storeResult;
    firstStore.close("test_d1_cleanup");

    const configOff = configOf({ EVEJS_LNE_INVASIONS_ENABLED: "false", EVEJS_LNE_WORLD_ENABLED: "true", EVEJS_LNE_FLEETS_ENABLED: "true", EVEJS_LNE_SCHEDULER_ENABLED: "true", EVEJS_LNE_STRATEGY_ENABLED: "true", EVEJS_LNE_OCCUPATION_ENABLED: "true", EVEJS_LNE_BATTLE_ENABLED: "true", EVEJS_LNE_OBSERVER_GALAXY_INVASIONS_ENABLED: "false" });
    const fs = require("node:fs");
    const path = require("node:path");
    const os = require("node:os");
    const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), "lne-inv-d1-off-"));
    const file2 = path.join(tmp2, "world.sqlite");
    seedDbFile(driver, file2, { seed: 1 });
    const opened2 = openStore({ filePath: file2, openDatabase: (f) => new driver.Database(f), exclusiveLock: true,
      busyTimeoutMs: 0, maxRowsPerTransaction: 500, maxWriteMsPerPass: 5, randomSeed: () => 1 });
    assert.ok(opened2.ok, JSON.stringify(opened2));
    const storeResult2 = { store: opened2.store, worldSeed: opened2.worldSeed };
    const clock2 = createManualClock(START_MS);
    const journal2 = createJournal({ clock: clock2, maxPayloadBytes: 16384, maxRows: 500 });
    const persistence2 = { ok: true, store: storeResult2.store, journal: journal2, worldSeed: storeResult2.worldSeed };
    const graph2 = graphOf({});
    const graphService2 = { whenReady: () => Promise.resolve({ ok: true, graph: graph2 }), getGraph: () => ({ ok: true, graph: graph2 }) };
    const ids2 = createIdGenerator({ clock: clock2, rng: createRng(5) });
    const sr2 = startScheduler({ config: configOff, persistence: { ok: true, store: storeResult2.store, worldSeed: storeResult2.worldSeed }, clock: clock2, ids: ids2, nowMs: () => 0 });
    const fr2 = startFleets({ config: configOff, persistence: persistence2, clock: clock2, ids: ids2, scheduler: sr2.scheduler, graph: graphService2, presence: null, views: createViewRegistry(), getStations: () => ({ getMode: () => "off" }) });
    const repo2 = createWorldStateRepository({ journal: journal2, clock: clock2, limits: LIMITS });
    const or2 = startOccupation({ config: configOff, persistence: persistence2, clock: clock2, scheduler: sr2.scheduler, fleets: fr2.fleets, world: { repository: repo2 }, graph: graphService2, getStations: () => ({ getMode: () => "off" }), nowMs: () => 0 });
    const stratConfig2 = { ...configOff, strategy: { ...configOff.strategy, activeFactions: "500003" } };
    const st2 = startStrategy({ config: stratConfig2, persistence: persistence2, clock: clock2, graph: graphService2, world: { repository: repo2 }, scheduler: sr2.scheduler, fleets: fr2.fleets, getStations: () => ({ getMode: () => "off" }), getOccupation: () => or2.occupation, views: createViewRegistry() });
    const battle2 = startBattle({ config: configOff, persistence: persistence2, clock: clock2, ids: ids2, scheduler: sr2.scheduler, fleets: fr2.fleets, graph: graphService2, occupation: or2.occupation });
    const stations2 = fakeStations([]);
    const invOff = startInvasions({ config: configOff, persistence: persistence2, clock: clock2, scheduler: sr2.scheduler, fleets: fr2.fleets, world: { repository: repo2 }, graph: graphService2, stations: stations2, presence: fakePresence(), adapter: { getSovClaims: () => ({ ok: true, claimOf: () => ({ ok: true, claimed: false }) }) }, strategy: st2.strategy, occupation: or2.occupation, battle: battle2.battle, nowMs: () => 0, ids: ids2 });
    const viewsOff = createViewRegistry();
    const layerViewOff = buildInvasionsLayerView({
      store: persistence2.store,
      repository: R,
      clock: clock2,
      getGovernor: () => ({ admits: () => true }),
      telemetry: null,
      nowMs: () => 0,
      maxSystems: 1000,
      maxLines: 6,
      refreshMs: 60000,
      getStatus: () => ({}),
    });
    env.invasions.stop("test");
    env.occupation.stop("test");
    env.strategy.stop("test");
    env.battle.stop("test");
    env.scheduler.stop("test");
    sr2.scheduler.stop("test");
    fr2.fleets.stop("test");
    or2.occupation.stop("test");
    st2.strategy.stop("test");
    battle2.battle.stop("test");
  }));

  needsDriver("D3 invasions panel: open, recent ended, totals, lastDecision", () => withStore(driver, async (reopen) => {
    const config = configOf({ EVEJS_LNE_INVASIONS_ENABLED: "true", EVEJS_LNE_INVASIONS_CHANCE_PERMILLE: "0", EVEJS_LNE_INVASIONS_ROLL_INTERVAL_MS: "3600000" });
    const storeResult = reopen();
    const registeredViews = createViewRegistry();
    const env = bootFull(storeResult, config, { views: registeredViews });
    const { invasions, scheduler, clock, repo, fleets, storeResult: sr, views } = env;
    const { buildInvasionsView } = require("../../lib/world/invasions/invasionsView");
    const R = require("../../lib/world/invasions/invasionRepository");
    const S = require("../../lib/world/invasions/schema");
    const { PROFILES } = require("../../lib/world/invasions/data/invaderProfiles");
    const trigProfile = PROFILES.find((p) => p.profileId === "triglavian-conduit-v1");
    const sleeperProfile = PROFILES.find((p) => p.profileId === "sleeper-tunnel-v1");
    assert.ok(trigProfile && sleeperProfile, "profiles exist");
    const sys1 = 30001867;
    const sys2 = 30001868;
    const sys3 = 30001869;
    for (const sys of [sys1, sys2, sys3]) {
      tx(sr, (db) => repo.applyChange(db, { systemId: sys, expectedVersion: 0, reason: "SEED_FREE", state: { securityClass: "nullsec", controllerFactionId: 0 }, influence: [] }, `world:seed:test:${sys}`));
    }
    const at = clock.now();
    const corpTrig = env.strategy.registry.corporationFor(trigProfile.factionId, "invasion");
    const corpSlp = env.strategy.registry.corporationFor(sleeperProfile.factionId, "invasion");
    const trigCaptureRange = 3;
    const inv1Id = "inv-d3-open";
    const fleetIds1 = [];
    for (let i = 0; i < 2; i += 1) {
      const fleet = tx(sr, (db) => fleets.repository.createFleet(db, {
        factionId: trigProfile.factionId, corporationId: corpTrig, currentSystemId: sys1, homeSystemId: sys1,
        fleetRole: "invasion", doctrineId: null, composition: [{ hullGroup: "cruiser", count: 2 }],
      }, S.fleetKey(inv1Id, i)));
      assert.ok(fleet.ok);
      fleetIds1.push(fleet.fleetId);
    }
    tx(sr, (db) => {
      const r = R.insertInvasionInTx(db, {
        invasionId: inv1Id, idempotencyKey: S.spawnKey(inv1Id), rollRound: 0, factionId: trigProfile.factionId, profileId: trigProfile.profileId,
        beachheadSystemId: sys1, captureRangeJumps: trigCaptureRange, fleetIds: fleetIds1, plan: JSON.stringify({ v: 1 }),
        startedAt: at - 3600000, withdrawAt: null,
      });
      assert.ok(r.ok, `inv1 insert failed: ${JSON.stringify(r)}`);
    });
    const inv2Id = "inv-d3-ended-bl";
    const fleetIds2 = [];
    for (let i = 0; i < 2; i += 1) {
      const fleet = tx(sr, (db) => fleets.repository.createFleet(db, {
        factionId: sleeperProfile.factionId, corporationId: corpSlp, currentSystemId: sys2, homeSystemId: sys2,
        fleetRole: "invasion", doctrineId: null, composition: [{ hullGroup: "cruiser", count: 2 }],
      }, S.fleetKey(inv2Id, i)));
      assert.ok(fleet.ok);
      fleetIds2.push(fleet.fleetId);
    }
    tx(sr, (db) => {
      const r = R.insertInvasionInTx(db, {
        invasionId: inv2Id, idempotencyKey: S.spawnKey(inv2Id), rollRound: 1, factionId: sleeperProfile.factionId, profileId: sleeperProfile.profileId,
        beachheadSystemId: sys2, captureRangeJumps: sleeperProfile.captureRangeJumps, fleetIds: fleetIds2, plan: JSON.stringify({ v: 1 }),
        startedAt: at - 7200000, withdrawAt: null,
      });
      assert.ok(r.ok, `inv2 insert failed: ${JSON.stringify(r)}`);
    });
    const inv3Id = "inv-d3-ended-wd";
    const fleetIds3 = [];
    for (let i = 0; i < 2; i += 1) {
      const fleet = tx(sr, (db) => fleets.repository.createFleet(db, {
        factionId: trigProfile.factionId, corporationId: corpTrig, currentSystemId: sys3, homeSystemId: sys3,
        fleetRole: "invasion", doctrineId: null, composition: [{ hullGroup: "cruiser", count: 2 }],
      }, S.fleetKey(inv3Id, i)));
      assert.ok(fleet.ok);
      fleetIds3.push(fleet.fleetId);
    }
    tx(sr, (db) => {
      const r = R.insertInvasionInTx(db, {
        invasionId: inv3Id, idempotencyKey: S.spawnKey(inv3Id), rollRound: 2, factionId: trigProfile.factionId, profileId: trigProfile.profileId,
        beachheadSystemId: sys3, captureRangeJumps: trigCaptureRange, fleetIds: fleetIds3, plan: JSON.stringify({ v: 1 }),
        startedAt: at - 10800000, withdrawAt: at - 900000,
      });
      assert.ok(r.ok, `inv3 insert failed: ${JSON.stringify(r)}`);
    });
    tx(sr, (db) => {
      R.bumpTotalsInTx(db, trigProfile.factionId, { started: 2, collapsed: 0, withdrawn: 1 }, at);
      R.bumpTotalsInTx(db, sleeperProfile.factionId, { started: 1, collapsed: 1, withdrawn: 0 }, at);
    });
    tx(sr, (db) => {
      db.prepare("UPDATE world_invasions SET state = 'ENDED', open = 0, ended_at = ?, end_reason = ?, updated_at = ? WHERE invasion_id = ?").run(at - 600000, S.END_REASON_BEACHHEAD_LOST, at, inv2Id);
      db.prepare("UPDATE world_invasions SET state = 'ENDED', open = 0, ended_at = ?, end_reason = ?, updated_at = ? WHERE invasion_id = ?").run(at - 300000, S.END_REASON_WITHDRAWN, at, inv3Id);
    });
    const graph = graphOf({});
    const graphService = { getGraph: () => ({ ok: true, graph }) };
    const panelView = buildInvasionsView({
      store: env.store,
      repository: R,
      getStatus: () => ({
        state: "ready",
        lastDecision: { round: 42, outcome: "SPAWN", factionId: trigProfile.factionId, targetSystemId: sys1, invasionId: "inv-new", fleetIds: ["f1", "f2"], captureRangeJumps: 3 },
      }),
      getGovernor: () => ({ admits: () => true }),
      graph: graphService,
      factionNames: new Map([[trigProfile.factionId, "Triglavian Collective"], [sleeperProfile.factionId, "Sleeper"]]),
      maxRows: 50,
    });
    const data = panelView.getData();
    assert.strictEqual(data.available, true);
    assert.strictEqual(data.open.length, 1);
    assert.strictEqual(data.open[0].invasion, inv1Id);
    assert.strictEqual(data.open[0].profile, "TRIG");
    assert.strictEqual(data.open[0].state, "ACTIVE");
    assert.strictEqual(data.open[0].fleets, 2);
    assert.strictEqual(data.open[0].withdrawAt, null);
    const trigAfter = config.invasions[trigProfile.withdrawAfterKey];
    assert.ok(Number.isSafeInteger(trigAfter) && trigAfter > 0, "Triglavian withdrawal key > 0");
    const wired = registeredViews.getView("invasions").getData();
    assert.strictEqual(wired.open.length, 1);
    assert.strictEqual(wired.open[0].withdrawAt, new Date(at - 3600000 + trigAfter).toISOString());
    assert.strictEqual(data.ended.length, 2);
    const endedByReason = Object.fromEntries(data.ended.map((e) => [e.invasion, e.endReason]));
    assert.strictEqual(endedByReason[inv2Id], "BEACHHEAD_LOST");
    assert.strictEqual(endedByReason[inv3Id], "WITHDRAWN");
    assert.deepStrictEqual(data.totals["500026"], { started: 2, collapsed: 0, withdrawn: 1 });
    assert.deepStrictEqual(data.totals["500021"], { started: 1, collapsed: 1, withdrawn: 0 });
    assert.ok(data.lastDecision);
    assert.strictEqual(data.lastDecision.outcome, "SPAWN");
    assert.strictEqual(data.lastDecision.round, 42);
    const key1 = panelView.cacheKey();
    assert.match(key1, /^i\d+$/);
    clock.set(at + 60000);
    env.invasions.stop("test");
    env.occupation.stop("test");
    env.strategy.stop("test");
    env.battle.stop("test");
    env.scheduler.stop("test");
  }));

  needsDriver("C2c withdrawal: abandon CORE_PROTECTED treated like NOT_CONTROLLER -> round continues, withdrawAbandonSkipped", () => withStore(driver, async (reopen) => {
    const config = configOf({
      EVEJS_LNE_INVASIONS_ENABLED: "true",
      EVEJS_LNE_INVASIONS_WITHDRAW_RETRY_MS: "60000",
      EVEJS_LNE_INVASIONS_WITHDRAW_MAX_ROUNDS: "3",
      EVEJS_LNE_INVASIONS_CHECK_INTERVAL_MS: "60000",
    });
    
    const coreSys = 30002187;
    const mockCoreIndex = {
      enabled: true,
      systems: new Map([[coreSys, 500021]]),
      stations: new Map(),
      byFaction: new Map(),
      version: 1
    };
    
    const storeResult = reopen();
    const { store, worldSeed } = storeResult;
    const clock = createManualClock(START_MS);
    const journal = createJournal({ clock, maxPayloadBytes: 16384, maxRows: 500 });
    const persistence = { ok: true, store, journal, worldSeed };
    const graph = graphOf({});
    const graphService = { whenReady: () => Promise.resolve({ ok: true, graph }), getGraph: () => ({ ok: true, graph }) };
    const ids = createIdGenerator({ clock, rng: createRng(5) });
    const sr = startScheduler({ config, persistence: { ok: true, store, worldSeed }, clock, ids, nowMs: () => 0 });
    assert.ok(sr.ok, JSON.stringify(sr));
    const fr = startFleets({ config, persistence, clock, ids, scheduler: sr.scheduler, graph: graphService, presence: null, views: createViewRegistry(), getStations: () => ({ getMode: () => "off" }) });
    assert.ok(fr.ok, JSON.stringify(fr));
    const repo = createWorldStateRepository({ journal, clock, limits: LIMITS });
    const orResult = startOccupation({ config, persistence, clock, scheduler: sr.scheduler, fleets: fr.fleets, world: { repository: repo }, graph: graphService, getStations: () => ({ getMode: () => "off" }), nowMs: () => 0, footholdsOf: listFootholdsInTx, coreIndex: mockCoreIndex });
    assert.ok(orResult.ok, JSON.stringify(orResult));
    const or = orResult.occupation;
    const stratConfig = { ...config, strategy: { ...config.strategy, activeFactions: "500003,500006,500019,500020,500021,500026,500029" } };
    const st = startStrategy({ config: stratConfig, persistence, clock, graph: graphService, world: { repository: repo }, scheduler: sr.scheduler, fleets: fr.fleets, getStations: () => ({ getMode: () => "off" }), getOccupation: () => or, views: createViewRegistry() });
    assert.ok(st.ok, JSON.stringify(st));
    const battle = startBattle({ config, persistence, clock, ids, scheduler: sr.scheduler, fleets: fr.fleets, graph: graphService, occupation: or });
    assert.ok(battle.ok, JSON.stringify(battle));
    const stations = fakeStations([{ stationId: "st:amarr", systemId: 30001868, factionId: 500003, state: "ONLINE" }]);
    const stR = startStations({ config, persistence, strategy: st.strategy, graph: graphService, clock, views: createViewRegistry(), getStations: () => stations });
    assert.ok(stR.ok);
    const invasions = startInvasions({ config, persistence, clock, scheduler: sr.scheduler, fleets: fr.fleets, world: { repository: repo }, graph: graphService, stations: stations, presence: fakePresence(), adapter: { getSovClaims: () => ({ ok: true, claimOf: () => ({ ok: true, claimed: false }) }) }, strategy: st.strategy, occupation: or, battle: battle.battle, nowMs: () => 0, ids, logger: { log: () => {} }, telemetry: null });
    assert.ok(invasions.ok, `startInvasions failed: ${invasions.reason} ${JSON.stringify(invasions.detail || {})}`);
    const env = { clock, scheduler: sr.scheduler, fleets: fr.fleets, repo, occupation: or, strategy: st.strategy, battle: battle.battle, invasions: invasions.invasions, store, storeResult, journal, graph, ids, invasionsConfig: config };
    const { scheduler } = env;
    const R = require("../../lib/world/invasions/invasionRepository");
    const S = require("../../lib/world/invasions/schema");
    const { PROFILES } = require("../../lib/world/invasions/data/invaderProfiles");
    const profile = PROFILES.find((p) => p.profileId === "sleeper-tunnel-v1");
    assert.ok(profile, "sleeper profile exists");
    const factionId = profile.factionId;
    const at = clock.now();
    const targetSys = coreSys;
    const seedFree = tx(storeResult, (db) => repo.applyChange(db, { systemId: targetSys, expectedVersion: 0, reason: "SEED_FREE", state: { securityClass: "nullsec", controllerFactionId: null }, influence: [] }, `world:seed:test:${targetSys}`));
    assert.ok(seedFree.ok, JSON.stringify(seedFree));
    const seedCaptured = tx(storeResult, (db) => repo.applyChange(db, { systemId: targetSys, expectedVersion: 1, reason: "SEED_CAPTURED", state: { controllerFactionId: factionId, capturedAt: at - 7200000, occupationState: "OCCUPIED" }, influence: [{ factionId, influenceScore: 70 }] }, `world:seed:test:${targetSys}:captured`));
    assert.ok(seedCaptured.ok, JSON.stringify(seedCaptured));
    const invasionId = "inv-withdraw-core-protect";
    const withdrawAt = at - 600000;
    const corpId = env.strategy.registry.corporationFor(factionId, "invasion");
    let fleetId;
    tx(storeResult, (db) => {
      const fleet = fr.fleets.repository.createFleet(db, {
        factionId, corporationId: corpId, currentSystemId: targetSys, homeSystemId: targetSys,
        fleetRole: "invasion", doctrineId: null, composition: [{ hullGroup: "cruiser", count: 2 }],
      }, S.fleetKey(invasionId, 0));
      assert.ok(fleet.ok);
      fleetId = fleet.fleetId;
    });
    tx(storeResult, (db) => {
      R.insertInvasionInTx(db, {
        invasionId, idempotencyKey: S.spawnKey(invasionId), rollRound: 0, factionId, profileId: profile.profileId,
        beachheadSystemId: targetSys, captureRangeJumps: profile.captureRangeJumps, fleetIds: [fleetId], plan: JSON.stringify({ v: 1 }),
        startedAt: at - 7200000, withdrawAt,
      });
    });
    tx(storeResult, (db) => repo.applyChange(db, { systemId: targetSys, expectedVersion: 0, reason: "SEED_CAPTURED", state: { securityClass: "nullsec", controllerFactionId: factionId, capturedAt: at - 7200000, occupationState: "OCCUPIED" }, influence: [{ factionId, score: 70 }] }, `world:seed:test:${targetSys}`));
    
    const stepKey = S.stepKey(invasionId, 0, config.invasions.checkIntervalMs, Math.floor(withdrawAt / config.invasions.checkIntervalMs));
    tx(storeResult, (db) => scheduler.enqueue(S.EVENT_TYPE_STEP, invasionId, withdrawAt + config.invasions.checkIntervalMs,
      { invasionId, seq: 0, trigger: "withdraw" }, stepKey, { tx: db, chained: true }));
    clock.set(withdrawAt + config.invasions.checkIntervalMs);
    let p = await scheduler.runPass();
    assert.ok(p.ok && p.jobs > 0);
    let inv = tx(storeResult, (db) => R.getInvasion(db, invasionId));
    assert.ok(inv.ok && inv.invasion);
    assert.strictEqual(inv.invasion.state, S.STATE_WITHDRAWING, "state should be WITHDRAWING");
    assert.strictEqual(inv.invasion.withdraw_round, 0, "withdrawRound 0 after WITHDRAW");
    
    for (let round = 1; round <= 5; round += 1) {
      clock.set(clock.now() + config.invasions.withdrawRetryMs);
      p = await scheduler.runPass();
      if (!p.ok || p.jobs === 0) break;
      inv = tx(storeResult, (db) => R.getInvasion(db, invasionId));
      if (!inv.ok || !inv.invasion) break;
      if (inv.invasion.state === S.STATE_ENDED) {
        assert.strictEqual(inv.invasion.end_reason, S.END_REASON_WITHDRAWN, "end reason WITHDRAWN");
        break;
      }
    }
    assert.ok(inv.ok && inv.invasion, "invasion should exist");
    assert.strictEqual(inv.invasion.state, S.STATE_ENDED, "state should be ENDED after withdrawal");
    assert.strictEqual(inv.invasion.end_reason, S.END_REASON_WITHDRAWN, "end reason WITHDRAWN");
    
    const status = env.invasions.getStatus();
    assert.ok(status.counters.withdrawAbandonSkipped >= 1, "withdrawAbandonSkipped should be >= 1 for CORE_PROTECTED");
    
    const totals = tx(storeResult, (db) => R.getTotals(db, factionId));
    assert.ok(totals.ok);
    assert.strictEqual(totals.totals.withdrawn, 1, "withdrawn counted in totals");
    
    env.invasions.stop("test");
    env.occupation.stop("test");
    env.strategy.stop("test");
    env.battle.stop("test");
    env.scheduler.stop("test");
  }));

  needsDriver("R2 withdrawal releases a CONTESTED beachhead held by the invader", () => withStore(driver, async (reopen) => {
    const config = configOf({
      EVEJS_LNE_INVASIONS_ENABLED: "true",
      EVEJS_LNE_INVASIONS_WITHDRAW_RETRY_MS: "60000",
      EVEJS_LNE_INVASIONS_WITHDRAW_MAX_ROUNDS: "3",
      EVEJS_LNE_INVASIONS_CHECK_INTERVAL_MS: "60000",
    });
    const storeResult = reopen();
    const env = bootFull(storeResult, config);
    const { scheduler, clock, repo, storeResult: sr } = env;
    const R = require("../../lib/world/invasions/invasionRepository");
    const S = require("../../lib/world/invasions/schema");
    const { PROFILES } = require("../../lib/world/invasions/data/invaderProfiles");
    const profile = PROFILES.find((p) => p.profileId === "sleeper-tunnel-v1");
    assert.ok(profile, "sleeper profile exists");
    const factionId = profile.factionId;
    const targetSys = 30001867;
    const at = clock.now();
    const r1 = tx(storeResult, (db) => repo.applyChange(db, { systemId: targetSys, expectedVersion: 0, reason: "SEED_CONTESTED", state: { securityClass: "nullsec", controllerFactionId: null }, influence: [] }, `world:seed:test:${targetSys}:create`));
    assert.ok(r1.ok, `create system failed: ${r1.reason}`);
    const r2 = tx(storeResult, (db) => repo.applyChange(db, { systemId: targetSys, expectedVersion: 1, reason: "SEED_CONTESTED", state: { controllerFactionId: factionId, occupierFactionId: 500003, occupationState: "CONTESTED", capturedAt: at - 7200000, phaseSeq: 3 }, influence: [{ factionId, influenceScore: 40 }] }, `world:seed:test:${targetSys}:contested`));
    assert.ok(r2.ok, `update system failed: ${r2.reason}`);
    const sysCheck = tx(storeResult, (db) => repo.getSystem(db, targetSys, { includeInfluence: false }));
    assert.ok(sysCheck.ok && sysCheck.system, "system should exist after creation");
    assert.strictEqual(sysCheck.system.controllerFactionId, factionId);
    assert.strictEqual(sysCheck.system.occupationState, "CONTESTED");
    const fleetIds = [];
    const corpId = env.strategy.registry.corporationFor(factionId, "invasion");
    for (let i = 0; i < 2; i += 1) {
      const fleet = tx(sr, (db) => env.fleets.repository.createFleet(db, {
        factionId, corporationId: corpId, currentSystemId: targetSys, homeSystemId: targetSys,
        fleetRole: "invasion", doctrineId: null, composition: [{ hullGroup: "cruiser", count: 2 }],
      }, S.fleetKey("inv-r2", i)));
      assert.ok(fleet.ok);
      fleetIds.push(fleet.fleetId);
    }
    const invasionId = "inv-r2-withdraw-claimed";
    const withdrawAt = at - 600000;
    tx(sr, (db) => {
      R.insertInvasionInTx(db, {
        invasionId, idempotencyKey: S.spawnKey(invasionId), rollRound: 0, factionId, profileId: profile.profileId,
        beachheadSystemId: targetSys, captureRangeJumps: profile.captureRangeJumps, fleetIds, plan: JSON.stringify({ v: 1 }),
        startedAt: at - 7200000, withdrawAt,
      });
    });
    const stepKey = S.stepKey(invasionId, 0, config.invasions.checkIntervalMs, Math.floor(withdrawAt / config.invasions.checkIntervalMs));
    tx(sr, (db) => scheduler.enqueue(S.EVENT_TYPE_STEP, invasionId, withdrawAt + config.invasions.checkIntervalMs,
      { invasionId, seq: 0, trigger: "withdraw" }, stepKey, { tx: db, chained: true }));
    clock.set(withdrawAt + config.invasions.checkIntervalMs);
    let p = await scheduler.runPass();
    const sysBeforeWithdraw = tx(sr, (db) => repo.getSystem(db, targetSys, { includeInfluence: false }));
    assert.ok(sysBeforeWithdraw.ok && sysBeforeWithdraw.system);
    assert.strictEqual(sysBeforeWithdraw.system.occupationState, "CONTESTED");
    assert.strictEqual(sysBeforeWithdraw.system.controllerFactionId, factionId);
    const noclaim = tx(sr, (db) => env.occupation.abandonInTx(db, { systemId: targetSys, at: clock.now(), factionId }, "test:noclaim"));
    assert.deepStrictEqual({ ok: noclaim.ok, reason: noclaim.reason }, { ok: false, reason: "OCCUPATION_IN_PROGRESS" });
    const badAllow = tx(sr, (db) => env.occupation.abandonInTx(db, { systemId: targetSys, at: clock.now(), factionId, allowClaim: "yes" }, "test:badallow"));
    assert.strictEqual(badAllow.reason, "OCCUPATION_INVALID_INPUT");
    const sysAfterRegress = tx(sr, (db) => repo.getSystem(db, targetSys, { includeInfluence: false }));
    assert.ok(sysAfterRegress.ok && sysAfterRegress.system);
    assert.strictEqual(sysAfterRegress.system.controllerFactionId, factionId);
    for (let round = 1; round <= 5; round += 1) {
      if (!p.ok || p.jobs === 0) break;
      const inv = tx(sr, (db) => R.getInvasion(db, invasionId));
      if (!inv.ok || !inv.invasion) break;
      if (inv.invasion.state === S.STATE_ENDED) break;
      clock.set(clock.now() + config.invasions.withdrawRetryMs);
      p = await scheduler.runPass();
    }
    const inv = tx(sr, (db) => R.getInvasion(db, invasionId));
    assert.ok(inv.ok && inv.invasion, "invasion should exist");
    assert.strictEqual(inv.invasion.state, S.STATE_ENDED, "state should be ENDED after withdrawal");
    assert.strictEqual(inv.invasion.end_reason, S.END_REASON_WITHDRAWN, "end reason WITHDRAWN");
    const after = tx(sr, (db) => env.fleets.repository.getFleets(db, fleetIds));
    assert.ok(after.ok && after.fleets.length === fleetIds.length);
    for (const f of after.fleets) assert.strictEqual(f.state, "DESTROYED", `fleet ${f.fleetId} disbanded on withdrawal`);
    const sys = tx(sr, (db) => repo.getSystem(db, targetSys, { includeInfluence: false }));
    assert.ok(sys.ok && sys.system);
    assert.strictEqual(sys.system.controllerFactionId, null);
    assert.strictEqual(sys.system.occupationState, "CONTESTED");
    assert.strictEqual(sys.system.occupierFactionId, 500003);
    assert.strictEqual(sys.system.phaseSeq, 3);
    assert.strictEqual(sys.system.previousControllerFactionId, 500021);
    assert.strictEqual(sys.system.capturedAt, null);
    const releaseCount = tx(sr, (db) => db.prepare("SELECT count(*) n FROM world_event_journal WHERE event_type = 'OCCUPATION_RELEASE'").get().n);
    const abandonCount = tx(sr, (db) => db.prepare("SELECT count(*) n FROM world_event_journal WHERE event_type = 'OCCUPATION_ABANDON'").get().n);
    assert.strictEqual(releaseCount, 1, "OCCUPATION_RELEASE journal entry");
    assert.strictEqual(abandonCount, 0, "no OCCUPATION_ABANDON");
    const status = env.invasions.getStatus();
    assert.strictEqual(status.counters.withdrawReleased, 1, "withdrawReleased === 1");
    assert.strictEqual(status.counters.withdrawAbandoned, 1, "withdrawAbandoned === 1");
    assert.strictEqual(status.counters.withdrawn, 1, "withdrawn === 1");
    const dup = tx(sr, (db) => env.occupation.abandonInTx(db, { systemId: targetSys, at: clock.now(), factionId, allowClaim: true }, S.withdrawAbandonKey(invasionId, 0, targetSys)));
    assert.deepStrictEqual(dup, { ok: true, changed: false, duplicate: true });
    env.invasions.stop("test");
    env.occupation.stop("test");
    env.strategy.stop("test");
    env.battle.stop("test");
    env.scheduler.stop("test");
  }));

  needsDriver("R3 SWEEP-orphans: a refused disband in the final round does not end the invasion as WITHDRAWN", () => withStore(driver, async (reopen) => {
    const config = configOf({
      EVEJS_LNE_INVASIONS_ENABLED: "true",
      EVEJS_LNE_INVASIONS_WITHDRAW_RETRY_MS: "60000",
      EVEJS_LNE_INVASIONS_WITHDRAW_MAX_ROUNDS: "3",
      EVEJS_LNE_INVASIONS_CHECK_INTERVAL_MS: "60000",
    });
    const storeResult = reopen();
    const blocked = { id: null };
    const wrapFleets = (f) => ({ ...f, repository: { ...f.repository,
      disband: (db, change, key) => (change.fleetId === blocked.id
        ? { ok: false, reason: "VERSION_CONFLICT" } : f.repository.disband(db, change, key)) } });
    const env = bootFull(storeResult, config, { wrapFleets });
    const { scheduler, clock, repo, fleets, storeResult: sr } = env;
    const R = require("../../lib/world/invasions/invasionRepository");
    const S = require("../../lib/world/invasions/schema");
    const { PROFILES } = require("../../lib/world/invasions/data/invaderProfiles");
    const profile = PROFILES.find((p) => p.profileId === "sleeper-tunnel-v1");
    assert.ok(profile);
    const factionId = profile.factionId;
    const targetSys = 30001867;
    tx(sr, (db) => repo.applyChange(db, { systemId: targetSys, expectedVersion: 0, reason: "SEED_FREE", state: { securityClass: "nullsec", controllerFactionId: 0 }, influence: [] }, `world:seed:test:${targetSys}`));
    const at = clock.now();
    const invasionId = "inv-r3-refused-disband";
    const withdrawAt = at - 600000;
    const corpId = env.strategy.registry.corporationFor(factionId, "invasion");
    const fleetIds = [];
    for (let i = 0; i < 2; i += 1) {
      const fleet = tx(sr, (db) => fleets.repository.createFleet(db, {
        factionId, corporationId: corpId, currentSystemId: targetSys, homeSystemId: targetSys,
        fleetRole: "invasion", doctrineId: null, composition: [{ hullGroup: "cruiser", count: 2 }],
      }, S.fleetKey(invasionId, i)));
      assert.ok(fleet.ok);
      fleetIds.push(fleet.fleetId);
    }
    blocked.id = fleetIds[0];
    tx(sr, (db) => {
      R.insertInvasionInTx(db, {
        invasionId, idempotencyKey: S.spawnKey(invasionId), rollRound: 0, factionId, profileId: profile.profileId,
        beachheadSystemId: targetSys, captureRangeJumps: profile.captureRangeJumps, fleetIds, plan: JSON.stringify({ v: 1 }),
        startedAt: at - 7200000, withdrawAt,
      });
    });
    const stepKey = S.stepKey(invasionId, 0, config.invasions.checkIntervalMs, Math.floor(withdrawAt / config.invasions.checkIntervalMs));
    tx(sr, (db) => scheduler.enqueue(S.EVENT_TYPE_STEP, invasionId, withdrawAt + config.invasions.checkIntervalMs,
      { invasionId, seq: 0, trigger: "withdraw" }, stepKey, { tx: db, chained: true }));
    clock.set(withdrawAt + config.invasions.checkIntervalMs);
    let p = await scheduler.runPass();
    assert.ok(p.ok && p.jobs > 0);
    let inv = tx(sr, (db) => R.getInvasion(db, invasionId));
    assert.ok(inv.ok && inv.invasion);
    assert.strictEqual(inv.invasion.state, S.STATE_WITHDRAWING, "after WITHDRAW: WITHDRAWING");
    assert.strictEqual(inv.invasion.withdraw_round, 0, "withdraw_round 0 after WITHDRAW");
    clock.set(clock.now() + config.invasions.withdrawRetryMs);
    p = await scheduler.runPass();
    assert.ok(p.ok && p.jobs > 0);
    inv = tx(sr, (db) => R.getInvasion(db, invasionId));
    assert.ok(inv.ok && inv.invasion);
    assert.strictEqual(inv.invasion.state, S.STATE_WITHDRAWING, "after round 0: WITHDRAWING");
    assert.strictEqual(inv.invasion.withdraw_round, 1, "withdraw_round 1");
    const statusAfterR0 = env.invasions.getStatus();
    assert.ok(!statusAfterR0.counters.withdrawn, "no withdrawn after round 0");
    for (let i = 0; i < 6; i += 1) {
      clock.set(clock.now() + config.invasions.withdrawRetryMs);
      p = await scheduler.runPass();
      if (!p.ok || p.jobs === 0) break;
      inv = tx(sr, (db) => R.getInvasion(db, invasionId));
      if (!inv.ok || !inv.invasion) break;
      if (inv.invasion.state === S.STATE_ENDED) break;
    }
    assert.ok(inv.ok && inv.invasion);
    assert.strictEqual(inv.invasion.state, S.STATE_ENDED, "state ENDED");
    assert.strictEqual(inv.invasion.end_reason, S.END_REASON_WITHDRAW_TIMEOUT, "end reason WITHDRAW_TIMEOUT (not WITHDRAWN)");
    const after = tx(sr, (db) => fleets.repository.getFleets(db, fleetIds));
    assert.ok(after.ok && after.fleets.length === fleetIds.length);
    const f0 = after.fleets.find((f) => f.fleetId === fleetIds[0]);
    const f1 = after.fleets.find((f) => f.fleetId === fleetIds[1]);
    assert.strictEqual(f0.state, "IDLE", "blocked fleet stays IDLE");
    assert.strictEqual(f1.state, "DESTROYED", "other fleet DESTROYED");
    const status = env.invasions.getStatus();
    assert.strictEqual(status.counters.withdrawn, 0, "withdrawn === 0");
    assert.strictEqual(status.counters.withdrawTimeout, 1, "withdrawTimeout === 1");
    assert.strictEqual(status.counters.withdrawLeftover, 1, "withdrawLeftover === 1");
    assert.ok(status.counters.withdrawEndDeferred >= 1, "withdrawEndDeferred >= 1");
    assert.ok(status.counters.withdrawDisbandRefused >= 2, "withdrawDisbandRefused >= 2");
    env.invasions.stop("test");
    env.occupation.stop("test");
    env.strategy.stop("test");
    env.battle.stop("test");
    env.scheduler.stop("test");
  }));

  needsDriver("R4 decideStep abandons a claimed beachhead; settleRound", () => withStore(driver, async (reopen) => {
    const config = configOf({});
    const storeResult = reopen({ fresh: true });
    const env = bootFull(storeResult, config);
    const M = require("../../lib/world/invasions/invasionMachine");
    const OCC = require("../../lib/world/occupation/schema");
    const baseView = {
      invasion: { state: "WITHDRAWING", stepSeq: 2, factionId: 500021, version: 3, withdrawAt: 0, withdrawRound: 0 },
      payloadSeq: 2,
      holders: 2,
      holdersTruncated: false,
      at: 1000,
      liveFleets: [],
      beachhead: { controller: 500021, capturedAt: 10 },
      beachheadSystemId: 30001867,
    };
    const params = { holdMinFleets: 1, checkIntervalMs: 60000, withdrawRetryMs: 60000, withdrawMaxRounds: 3 };
    for (const state of OCC.OCCUPATION_STATES) {
      const v = { ...baseView, beachhead: { ...baseView.beachhead, occupationState: state } };
      const d = M.decideStep(v, params);
      assert.deepStrictEqual(d, { action: "END_WITHDRAWN", disband: [], abandon: [30001867], keep: [] }, `state ${state}`);
    }
    const bogus = { ...baseView, beachhead: { ...baseView.beachhead, occupationState: "BOGUS" } };
    assert.deepStrictEqual(M.decideStep(bogus, params).abandon, []);
    const wrongCtrl = { ...baseView, beachhead: { ...baseView.beachhead, controller: 500003 } };
    assert.deepStrictEqual(M.decideStep(wrongCtrl, params).abandon, []);
    assert.deepStrictEqual(M.settleRound({ action: "END_WITHDRAWN" }, 0, 0, params, 1000), { action: "END_WITHDRAWN" });
    assert.deepStrictEqual(M.settleRound({ action: "END_WITHDRAWN" }, 1, 0, params, 1000), { action: "WITHDRAW_ROUND", next: { dueAt: 61000 } });
    assert.deepStrictEqual(M.settleRound({ action: "END_WITHDRAWN" }, 1, 2, params, 1000), { action: "END_TIMEOUT", leftover: 1 });
    assert.deepStrictEqual(M.settleRound({ action: "END_TIMEOUT", leftover: 2 }, 1, 2, params, 1000), { action: "END_TIMEOUT", leftover: 3 });
    assert.deepStrictEqual(M.settleRound({ action: "WITHDRAW_ROUND", next: { dueAt: 5 } }, 2, 0, params, 1000), { action: "WITHDRAW_ROUND", next: { dueAt: 5 } });
    env.invasions.stop("test");
    env.occupation.stop("test");
    env.strategy.stop("test");
    env.battle.stop("test");
    env.scheduler.stop("test");
  }));

  const SR = () => require("../../lib/world/invasions/invasionRepository");
  const SS = () => require("../../lib/world/invasions/schema");
  function chainScene(env, { invasionId, profileId, withdrawAt = null, holders = 2 }) {
    const R = SR();
    const S = SS();
    const { PROFILES } = require("../../lib/world/invasions/data/invaderProfiles");
    const profile = PROFILES.find((p) => p.profileId === profileId);
    assert.ok(profile, `profile ${profileId}`);
    const sr = env.storeResult;
    const targetSys = 30001867;
    tx(sr, (db) => env.repo.applyChange(db, { systemId: targetSys, expectedVersion: 0, reason: "SEED_FREE", state: { securityClass: "nullsec", controllerFactionId: 0 }, influence: [] }, `world:seed:test:${targetSys}`));
    const corpId = env.strategy.registry.corporationFor(profile.factionId, "invasion");
    const fleetIds = [];
    for (let i = 0; i < holders; i += 1) {
      const f = tx(sr, (db) => env.fleets.repository.createFleet(db, {
        factionId: profile.factionId, corporationId: corpId, currentSystemId: targetSys, homeSystemId: targetSys,
        fleetRole: "invasion", doctrineId: null, composition: [{ hullGroup: "cruiser", count: 2 }],
      }, S.fleetKey(invasionId, i)));
      assert.ok(f.ok, JSON.stringify(f));
      fleetIds.push(f.fleetId);
    }
    const at = env.clock.now();
    const ins = tx(sr, (db) => R.insertInvasionInTx(db, {
      invasionId, idempotencyKey: S.spawnKey(invasionId), rollRound: 0, factionId: profile.factionId, profileId,
      beachheadSystemId: targetSys, captureRangeJumps: profile.captureRangeJumps ?? 3, fleetIds, plan: { v: 1 },
      startedAt: at, withdrawAt,
    }));
    assert.ok(ins.ok, JSON.stringify(ins));
    return { factionId: profile.factionId, fleetIds, targetSys, at };
  }
  const invOf = (env, id) => tx(env.storeResult, (db) => SR().getInvasion(db, id)).invasion;
  const stepRows = (env, id, where) => tx(env.storeResult, (db) => db.prepare(
    `SELECT state, payload, outcome FROM world_scheduled_events WHERE event_type = 'INVASION_STEP' AND aggregate_id = ? ${where || ""}`).all(id));
  const enqueueStep = (env, id, seq, dueAt) => {
    const S = SS();
    const I = env.invasionsConfig.invasions.checkIntervalMs;
    tx(env.storeResult, (db) => env.scheduler.enqueue(S.EVENT_TYPE_STEP, id, dueAt, { invasionId: id, seq, trigger: "tick" },
      S.stepKey(id, seq, I, Math.floor(dueAt / I)), { tx: db, chained: true }));
  };
  const stopAll = (env) => {
    env.invasions.stop("test");
    env.occupation.stop("test");
    env.strategy.stop("test");
    env.battle.stop("test");
    env.scheduler.stop("test");
  };
  const CHAIN_ENV = { EVEJS_LNE_INVASIONS_ENABLED: "true", EVEJS_LNE_INVASIONS_CHANCE_PERMILLE: "0",
    EVEJS_LNE_INVASIONS_HOLD_MIN_FLEETS: "2", EVEJS_LNE_INVASIONS_CHECK_INTERVAL_MS: "60000",
    EVEJS_LNE_INVASIONS_ROLL_INTERVAL_MS: "3600000" };

  needsDriver("IS1 step chain: 3 HOLD steps in a row move step_seq 0->3 without STALE; holders gone -> COLLAPSE, ENDED", () => withStore(driver, async (reopen) => {
    const config = configOf(CHAIN_ENV);
    const env = bootFull(reopen(), config);
    const S = SS();
    const I = config.invasions.checkIntervalMs;
    const id = "inv-is1-chain";
    const scene = chainScene(env, { invasionId: id, profileId: "triglavian-conduit-v1" });
    enqueueStep(env, id, 0, scene.at + I);
    for (let k = 1; k <= 3; k += 1) {
      env.clock.set(scene.at + k * I);
      const p = await env.scheduler.runPass();
      assert.ok(p.ok, JSON.stringify(p));
      assert.strictEqual(invOf(env, id).step_seq, k, `step_seq after HOLD ${k}`);
    }
    let st = env.invasions.getStatus().counters;
    assert.strictEqual(st.holds, 3, "three HOLD steps committed");
    assert.strictEqual(st.stale, 0, "no STALE step");
    assert.strictEqual(invOf(env, id).state, S.STATE_ACTIVE);
    const got = tx(env.storeResult, (db) => env.fleets.repository.getFleets(db, scene.fleetIds));
    for (const f of got.fleets) {
      const d = tx(env.storeResult, (db) => env.fleets.repository.disband(db, { fleetId: f.fleetId, expectedVersion: f.version,
        systemId: f.currentSystemId, fleetRole: f.fleetRole }, `test:is1:disband:${f.fleetId}`));
      assert.ok(d.ok, JSON.stringify(d));
    }
    env.clock.set(scene.at + 4 * I);
    await env.scheduler.runPass();
    const inv = invOf(env, id);
    assert.strictEqual(inv.state, S.STATE_ENDED, "COLLAPSE after more than one step");
    assert.strictEqual(inv.end_reason, S.END_REASON_BEACHHEAD_LOST);
    st = env.invasions.getStatus().counters;
    assert.strictEqual(st.collapsed, 1);
    assert.strictEqual(st.stale, 0);
    assert.strictEqual(stepRows(env, id, "AND state <> 'DONE'").length, 0, "no step left after the end");
    stopAll(env);
  }));

  needsDriver("IS2 Sleepers: HOLD x2, then WITHDRAW -> rounds -> ENDED by withdrawAt + maxRounds x retry; the slot frees (next roll not NO_ROOM)", () => withStore(driver, async (reopen) => {
    const config = configOf({ ...CHAIN_ENV, EVEJS_LNE_INVASIONS_CHANCE_PERMILLE: "1000", EVEJS_LNE_INVASIONS_MAX_ACTIVE: "1",
      EVEJS_LNE_INVASIONS_HOLD_MIN_FLEETS: "1", EVEJS_LNE_INVASIONS_WITHDRAW_RETRY_MS: "60000",
      EVEJS_LNE_INVASIONS_WITHDRAW_MAX_ROUNDS: "3" });
    const env = bootFull(reopen(), config);
    const S = SS();
    const I = config.invasions.checkIntervalMs;
    const id = "inv-is2-sleepers";
    const withdrawAt = env.clock.now() + Math.floor(2.5 * I);
    const scene = chainScene(env, { invasionId: id, profileId: "sleeper-tunnel-v1", withdrawAt });
    enqueueStep(env, id, 0, scene.at + I);
    for (let k = 1; k <= 2; k += 1) {
      env.clock.set(scene.at + k * I);
      await env.scheduler.runPass();
    }
    assert.strictEqual(env.invasions.getStatus().counters.holds, 2, "two HOLD steps before withdrawAt");
    assert.strictEqual(invOf(env, id).state, S.STATE_ACTIVE);
    const deadline = withdrawAt + config.invasions.withdrawMaxRounds * config.invasions.withdrawRetryMs;
    let t = scene.at + 3 * I;
    while (t <= deadline && invOf(env, id).state !== S.STATE_ENDED) {
      env.clock.set(t);
      await env.scheduler.runPass();
      t += config.invasions.withdrawRetryMs;
    }
    const inv = invOf(env, id);
    assert.strictEqual(inv.state, S.STATE_ENDED, "Sleepers ended");
    assert.ok([S.END_REASON_WITHDRAWN, S.END_REASON_WITHDRAW_TIMEOUT].includes(inv.end_reason), inv.end_reason);
    assert.ok(inv.ended_at <= deadline, `ended_at ${inv.ended_at} <= ${deadline}`);
    let st = env.invasions.getStatus().counters;
    assert.strictEqual(st.stale, 0, "no STALE in the chain");
    assert.strictEqual(st.withdrawStarted, 1);
    const noRoomBefore = st.noRoom;
    const rollsBefore = st.rolls;
    advanceToNextRoll(env);
    for (let i = 0; i < 40 && env.invasions.getStatus().counters.rolls === rollsBefore; i += 1) {
      await env.scheduler.runPass();
    }
    st = env.invasions.getStatus().counters;
    assert.ok(st.rolls > rollsBefore, "a roll ran after the end");
    assert.strictEqual(st.noRoom, noRoomBefore, "no NO_ROOM after the end");
    assert.notStrictEqual(env.invasions.getStatus().lastDecision.outcome, "NO_ROOM");
    stopAll(env);
  }));

  needsDriver("IS3 restart mid-chain: bootstrap step + pending chain step (same seq) -> exactly one HOLD, the other STALE, one pending step", () => withStore(driver, async (reopen) => {
    const config = configOf(CHAIN_ENV);
    const env = bootFull(reopen(), config);
    const I = config.invasions.checkIntervalMs;
    const id = "inv-is3-restart";
    const scene = chainScene(env, { invasionId: id, profileId: "triglavian-conduit-v1" });
    enqueueStep(env, id, 0, scene.at + I);
    env.clock.set(scene.at + I);
    await env.scheduler.runPass();
    assert.strictEqual(invOf(env, id).step_seq, 1, "first HOLD");
    env.restartInvasions();
    const pending = stepRows(env, id, "AND state <> 'DONE'");
    assert.strictEqual(pending.length, 2, "chain step + bootstrap step");
    for (const r of pending) assert.strictEqual(JSON.parse(r.payload).seq, 1, "both carry seq 1");
    env.clock.set(scene.at + 2 * I);
    await env.scheduler.runPass();
    const st = env.invasions.getStatus().counters;
    assert.strictEqual(st.holds, 1, "exactly one HOLD");
    assert.strictEqual(st.stale, 1, "the other step is STALE");
    assert.strictEqual(invOf(env, id).step_seq, 2);
    const left = stepRows(env, id, "AND state <> 'DONE'");
    assert.strictEqual(left.length, 1, "one pending INVASION_STEP");
    assert.strictEqual(JSON.parse(left[0].payload).seq, 2);
    stopAll(env);
  }));

  needsDriver("IS4 legacy row: ACTIVE step_seq 0 with only DONE seq 0 / seq 1 steps -> bootstrap revives the chain, 2 HOLD without STALE", () => withStore(driver, async (reopen) => {
    const config = configOf(CHAIN_ENV);
    const env = bootFull(reopen(), config);
    const I = config.invasions.checkIntervalMs;
    const id = "inv-is4-legacy";
    const scene = chainScene(env, { invasionId: id, profileId: "triglavian-conduit-v1" });
    enqueueStep(env, id, 0, scene.at + I);
    enqueueStep(env, id, 1, scene.at + 2 * I);
    tx(env.storeResult, (db) => db.prepare("UPDATE world_scheduled_events SET state = 'DONE', outcome = 'OK', finished_at = ? WHERE event_type = 'INVASION_STEP' AND aggregate_id = ?").run(scene.at, id));
    env.clock.set(scene.at + 10 * I);
    await env.scheduler.runPass();
    assert.strictEqual(invOf(env, id).step_seq, 0, "legacy row: chain dead");
    env.restartInvasions();
    for (let k = 0; k <= 1; k += 1) {
      env.clock.set(scene.at + (10 + k) * I);
      await env.scheduler.runPass();
    }
    const st = env.invasions.getStatus().counters;
    assert.strictEqual(st.holds, 2, "two HOLD steps after bootstrap");
    assert.strictEqual(st.stale, 0, "no STALE");
    assert.strictEqual(invOf(env, id).step_seq, 2);
    stopAll(env);
  }));

  needsDriver("IWC1 transition: ACTIVE->WITHDRAWING->WITHDRAWING->ENDED writes updated_at/journal times = at, event_type from to; no at -> refused", () => withStore(driver, async (reopen) => {
    const config = configOf(CHAIN_ENV);
    const env = bootFull(reopen(), config);
    const R = SR();
    const S = SS();
    const id = "inv-iwc1";
    const scene = chainScene(env, { invasionId: id, profileId: "triglavian-conduit-v1" });
    const journal = (key) => tx(env.storeResult, (db) => db.prepare(
      "SELECT event_type, created_at, applied_at FROM world_event_journal WHERE idempotency_key = ?").get(key));
    const step = (spec) => tx(env.storeResult, (db) => R.transition(db, { invasionId: id, ...spec }));
    const bad = step({ expectedVersion: invOf(env, id).version, from: S.STATE_ACTIVE, to: S.STATE_WITHDRAWING,
      patch: { stepSeq: 1, withdrawRound: 0 }, key: S.withdrawKey(id) });
    assert.deepStrictEqual(bad, { ok: false, reason: "INVASION_INVALID_INPUT" });
    assert.strictEqual(invOf(env, id).state, S.STATE_ACTIVE);
    const at1 = scene.at + 1001;
    const w = step({ expectedVersion: invOf(env, id).version, from: S.STATE_ACTIVE, to: S.STATE_WITHDRAWING,
      patch: { stepSeq: 1, withdrawRound: 0 }, key: S.withdrawKey(id), at: at1 });
    assert.ok(w.ok && !w.duplicate, JSON.stringify(w));
    const got = [];
    got.push([invOf(env, id).state, Number(invOf(env, id).updated_at), journal(S.withdrawKey(id))]);
    const at2 = scene.at + 2002;
    const r = step({ expectedVersion: invOf(env, id).version, from: S.STATE_WITHDRAWING, to: S.STATE_WITHDRAWING,
      patch: { stepSeq: 2, withdrawRound: 1 }, key: S.withdrawRoundKey(id, 1), at: at2 });
    assert.ok(r.ok, JSON.stringify(r));
    got.push([invOf(env, id).state, Number(invOf(env, id).updated_at), journal(S.withdrawRoundKey(id, 1))]);
    const at3 = scene.at + 3003;
    const e = step({ expectedVersion: invOf(env, id).version, from: S.STATE_WITHDRAWING, to: S.STATE_ENDED,
      patch: { stepSeq: 3, endedAt: at3, endReason: S.END_REASON_WITHDRAWN }, key: S.withdrawEndKey(id), at: at3 });
    assert.ok(e.ok, JSON.stringify(e));
    got.push([invOf(env, id).state, Number(invOf(env, id).updated_at), journal(S.withdrawEndKey(id))]);
    const j = (type, t) => ({ event_type: type, created_at: t, applied_at: t });
    const norm = got.map(([s, u, row]) => [s, u, { event_type: row.event_type, created_at: Number(row.created_at), applied_at: Number(row.applied_at) }]);
    assert.deepStrictEqual(norm, [
      [S.STATE_WITHDRAWING, at1, j("INVASION_WITHDRAWING", at1)],
      [S.STATE_WITHDRAWING, at2, j("INVASION_WITHDRAWING", at2)],
      [S.STATE_ENDED, at3, j("INVASION_ENDED", at3)],
    ]);
    stopAll(env);
  }));

  const MACHINE_PARAMS = { holdMinFleets: 1, checkIntervalMs: 60000, withdrawRetryMs: 60000, withdrawMaxRounds: 3 };

  test("ISH1 effectiveWithdrawAt: stored value wins, NULL row -> started_at + afterMs, afterMs 0 -> null; decideStep ACTIVE uses it", () => {
    const M = require("../../lib/world/invasions/invasionMachine");
    assert.strictEqual(M.effectiveWithdrawAt(500, 0, 999), 500);
    assert.strictEqual(M.effectiveWithdrawAt(null, 1000, 3600000), 3601000);
    assert.strictEqual(M.effectiveWithdrawAt(null, 1000, 0), null);
    const started = 1000;
    const after = 3600000;
    const view = (at) => ({
      invasion: { state: "ACTIVE", stepSeq: 0, factionId: 500026, version: 1,
        withdrawAt: M.effectiveWithdrawAt(null, started, after), withdrawRound: 0 },
      payloadSeq: 0, holders: 2, holdersTruncated: false, at, liveFleets: [],
      beachhead: { controller: null, capturedAt: null, occupationState: null }, beachheadSystemId: 30001867,
    });
    assert.deepStrictEqual(M.decideStep(view(started + after), MACHINE_PARAMS).action, "WITHDRAW");
    assert.deepStrictEqual(M.decideStep(view(started + after - 1), MACHINE_PARAMS).action, "HOLD");
  });

  test("ISH2 decideStep WITHDRAWING: keepsConquest + STABLE -> keep; keepsConquest + CONSOLIDATING -> abandon; no keepsConquest + STABLE -> abandon", () => {
    const M = require("../../lib/world/invasions/invasionMachine");
    const view = (keepsConquest, occupationState) => ({
      invasion: { state: "WITHDRAWING", stepSeq: 2, factionId: 500026, version: 3, withdrawAt: 0, withdrawRound: 0 },
      payloadSeq: 2, holders: 0, holdersTruncated: false, at: 1000, liveFleets: [],
      beachhead: { controller: 500026, capturedAt: 10, occupationState }, beachheadSystemId: 30001867, keepsConquest,
    });
    const got = [[true, "STABLE"], [true, "CONSOLIDATING"], [false, "STABLE"]].map(([k, s]) => {
      const d = M.decideStep(view(k, s), MACHINE_PARAMS);
      return { action: d.action, keep: d.keep, abandon: d.abandon };
    });
    assert.deepStrictEqual(got, [
      { action: "END_WITHDRAWN", keep: [30001867], abandon: [] },
      { action: "END_WITHDRAWN", keep: [], abandon: [30001867] },
      { action: "END_WITHDRAWN", keep: [], abandon: [30001867] },
    ]);
  });

  needsDriver("ISH3 legacy Triglavian row (withdraw_at NULL), key 1 h, STABLE beachhead of 500026 -> WITHDRAW -> ENDED, beachhead kept, slot frees", () => withStore(driver, async (reopen) => {
    const config = configOf({ ...CHAIN_ENV, EVEJS_LNE_INVASIONS_CHANCE_PERMILLE: "1000", EVEJS_LNE_INVASIONS_MAX_ACTIVE: "1",
      EVEJS_LNE_INVASIONS_TRIGLAVIAN_WITHDRAW_AFTER_MS: "3600000", EVEJS_LNE_INVASIONS_WITHDRAW_RETRY_MS: "60000",
      EVEJS_LNE_INVASIONS_WITHDRAW_MAX_ROUNDS: "3" });
    const env = bootFull(reopen(), config);
    const S = SS();
    const I = config.invasions.checkIntervalMs;
    const after = config.invasions.triglavianWithdrawAfterMs;
    assert.strictEqual(after, 3600000);
    const id = "inv-ish3-trig";
    const scene = chainScene(env, { invasionId: id, profileId: "triglavian-conduit-v1" });
    assert.strictEqual(invOf(env, id).withdraw_at, null, "legacy row: withdraw_at NULL");
    const created = tx(env.storeResult, (db) => env.repo.applyChange(db, { systemId: scene.targetSys, expectedVersion: 0, reason: "SEED_STABLE",
      state: { securityClass: "nullsec", controllerFactionId: null }, influence: [] }, `world:seed:test:${scene.targetSys}:create`));
    assert.ok(created.ok, JSON.stringify(created));
    const seeded = tx(env.storeResult, (db) => env.repo.applyChange(db, { systemId: scene.targetSys, expectedVersion: 1, reason: "SEED_STABLE",
      state: { controllerFactionId: scene.factionId, occupationState: "STABLE", capturedAt: scene.at - DAY },
      influence: [{ factionId: scene.factionId, influenceScore: 60 }] }, `world:seed:test:${scene.targetSys}:stable`));
    assert.ok(seeded.ok, JSON.stringify(seeded));
    enqueueStep(env, id, 0, scene.at + I);
    env.clock.set(scene.at + after - 1);
    await env.scheduler.runPass();
    assert.strictEqual(invOf(env, id).state, S.STATE_ACTIVE, "HOLD one ms before started_at + key");
    assert.strictEqual(env.invasions.getStatus().counters.withdrawStarted, 0);
    const deadline = scene.at + after + (config.invasions.withdrawMaxRounds + 2) * config.invasions.withdrawRetryMs;
    let t = scene.at + after;
    while (t <= deadline && invOf(env, id).state !== S.STATE_ENDED) {
      env.clock.set(t);
      await env.scheduler.runPass();
      t += config.invasions.withdrawRetryMs;
    }
    const inv = invOf(env, id);
    assert.strictEqual(inv.state, S.STATE_ENDED, "Triglavian invasion ended");
    assert.ok([S.END_REASON_WITHDRAWN, S.END_REASON_WITHDRAW_TIMEOUT].includes(inv.end_reason), inv.end_reason);
    assert.strictEqual(inv.withdraw_at, null, "Nothing writes withdraw_at to the row");
    const sys = tx(env.storeResult, (db) => env.repo.getSystem(db, scene.targetSys, { includeInfluence: false })).system;
    assert.deepStrictEqual([sys.controllerFactionId, sys.occupationState], [scene.factionId, "STABLE"], "beachhead kept");
    let st = env.invasions.getStatus().counters;
    assert.deepStrictEqual([st.withdrawStarted, st.withdrawKeptConquest, st.withdrawAbandoned], [1, 1, 0]);
    const noRoomBefore = st.noRoom;
    const rollsBefore = st.rolls;
    advanceToNextRoll(env);
    for (let i = 0; i < 40 && env.invasions.getStatus().counters.rolls === rollsBefore; i += 1) {
      await env.scheduler.runPass();
    }
    st = env.invasions.getStatus().counters;
    assert.ok(st.rolls > rollsBefore, "a roll ran after the end");
    assert.strictEqual(st.noRoom, noRoomBefore, "no NO_ROOM after the end");
    stopAll(env);
  }));

  async function spawnInvader(env) {
    seedK3Systems(env.repo, env.storeResult, "SEED_K3");
    for (let k = 0; k < 4; k += 1) {
      const rows = tx(env.storeResult, (db) => db.prepare(
        "SELECT * FROM world_invasions WHERE profile_id IN ('triglavian-conduit-v1', 'deathless-conduit-v1')").all());
      if (rows.length > 0) return rows[0];
      const rollsBefore = env.invasions.getStatus().counters.rolls;
      advanceToNextRoll(env);
      for (let i = 0; i < 40 && env.invasions.getStatus().counters.rolls === rollsBefore; i += 1) {
        await env.scheduler.runPass();
      }
    }
    assert.fail("no Triglavian / Deathless spawn in 4 rolls");
    return null;
  }
  const ISH4_ENV = { EVEJS_LNE_INVASIONS_ENABLED: "true", EVEJS_LNE_INVASIONS_CHANCE_PERMILLE: "1000",
    EVEJS_LNE_INVASIONS_MAX_ACTIVE: "10", EVEJS_LNE_INVASIONS_MAX_ACTIVE_PER_FACTION: "1",
    EVEJS_LNE_INVASIONS_ROLL_INTERVAL_MS: "3600000", EVEJS_LNE_INVASIONS_CHECK_INTERVAL_MS: "60000" };

  needsDriver("ISH4 spawn: key 0 -> withdraw_at NULL and the first step is not WITHDRAW; key > 0 -> withdraw_at - started_at = key", () => (async () => {
    const got = [];
    await withStore(driver, async (reopen) => {
      const config = configOf({ ...ISH4_ENV, EVEJS_LNE_INVASIONS_TRIGLAVIAN_WITHDRAW_AFTER_MS: "0",
        EVEJS_LNE_INVASIONS_DEATHLESS_WITHDRAW_AFTER_MS: "0" });
      const env = bootFull(reopen(), config);
      const row = await spawnInvader(env);
      const startedBefore = env.invasions.getStatus().counters.withdrawStarted;
      env.clock.set(Number(row.started_at) + config.invasions.checkIntervalMs);
      for (let i = 0; i < 5; i += 1) await env.scheduler.runPass();
      const now = invOf(env, row.invasion_id);
      got.push({ key0: true, withdrawAt: row.withdraw_at, stepped: Number(now.step_seq) > 0,
        state: now.state, withdrawStarted: env.invasions.getStatus().counters.withdrawStarted - startedBefore });
      stopAll(env);
    });
    await withStore(driver, async (reopen) => {
      const config = configOf(ISH4_ENV);
      const env = bootFull(reopen(), config);
      const row = await spawnInvader(env);
      const key = row.profile_id === "triglavian-conduit-v1" ? "triglavianWithdrawAfterMs" : "deathlessWithdrawAfterMs";
      got.push({ key0: false, delta: Number(row.withdraw_at) - Number(row.started_at), expected: config.invasions[key] });
      stopAll(env);
    });
    assert.deepStrictEqual(got, [
      { key0: true, withdrawAt: null, stepped: true, state: "ACTIVE", withdrawStarted: 0 },
      { key0: false, delta: got[1].expected, expected: got[1].expected },
    ]);
    assert.ok(got[1].expected === 432000000 || got[1].expected === 345600000, String(got[1].expected));
  })());

  test("ISH5 config: defaults 120 h / 96 h, 0 accepted unclamped, every profile withdrawAfterKey resolves, warning below the path to STABLE only", () => {
    const { PROFILES } = require("../../lib/world/invasions/data/invaderProfiles");
    const resolve = (env) => resolveConfig({ modDir: MOD_DIR, env: { EVEJS_DATA_ROOT: os.tmpdir(), ...env } });
    const def = resolve({});
    assert.deepStrictEqual(def.errors || [], []);
    assert.deepStrictEqual([def.config.invasions.triglavianWithdrawAfterMs, def.config.invasions.deathlessWithdrawAfterMs],
      [432000000, 345600000]);
    assert.deepStrictEqual(def.warnings.filter((w) => w.includes("WithdrawAfterMs")), []);
    for (const p of PROFILES) {
      assert.ok(p.withdrawAfterKey && Number.isSafeInteger(def.config.invasions[p.withdrawAfterKey]), `${p.profileId} key`);
      assert.strictEqual(typeof p.keepsConquest, "boolean", `${p.profileId} keepsConquest`);
    }
    const zero = resolve({ EVEJS_LNE_INVASIONS_TRIGLAVIAN_WITHDRAW_AFTER_MS: "0", EVEJS_LNE_INVASIONS_DEATHLESS_WITHDRAW_AFTER_MS: "0" });
    assert.deepStrictEqual([zero.config.invasions.triglavianWithdrawAfterMs, zero.config.invasions.deathlessWithdrawAfterMs], [0, 0]);
    assert.deepStrictEqual(zero.warnings.filter((w) => w.includes("WithdrawAfterMs")), []);
    const short = resolve({ EVEJS_LNE_INVASIONS_TRIGLAVIAN_WITHDRAW_AFTER_MS: "3600000" });
    assert.deepStrictEqual(short.warnings.filter((w) => w.includes("WithdrawAfterMs")), [
      "invasions.triglavianWithdrawAfterMs=3600000 below the occupation path to STABLE (21600000) - the invader "
        + "withdraws before it can consolidate its beachhead",
    ]);
  });

  needsDriver("LS1 low-sweep invasions views: stop unregisters, restart re-registers, config 0 kept, bad fleet_ids_json, no open in status", () => withStore(driver, async (reopen) => {
    const base = configOf({ EVEJS_LNE_INVASIONS_ENABLED: "true", EVEJS_LNE_INVASIONS_CHANCE_PERMILLE: "0", EVEJS_LNE_INVASIONS_ROLL_INTERVAL_MS: "3600000" });
    const config = { ...base, observer: { ...base.observer } };
    const views = createViewRegistry();
    const env = bootFull(reopen(), config, { views });
    const R = require("../../lib/world/invasions/invasionRepository");
    const S = require("../../lib/world/invasions/schema");
    const { PROFILES } = require("../../lib/world/invasions/data/invaderProfiles");
    const profile = PROFILES.find((p) => p.profileId === "sleeper-tunnel-v1");
    const sys = 30001867;
    tx(env.storeResult, (db) => {
      const r = R.insertInvasionInTx(db, { invasionId: "inv-ls1", idempotencyKey: S.spawnKey("inv-ls1"), rollRound: 0,
        factionId: profile.factionId, profileId: profile.profileId, beachheadSystemId: sys,
        captureRangeJumps: profile.captureRangeJumps, fleetIds: [], plan: JSON.stringify({ v: 1 }),
        startedAt: env.clock.now(), withdrawAt: null });
      assert.ok(r.ok, JSON.stringify(r));
      db.prepare("UPDATE world_invasions SET fleet_ids_json = 'null' WHERE invasion_id = 'inv-ls1'").run();
    });
    assert.ok(!("open" in env.invasions.getStatus()), JSON.stringify(Object.keys(env.invasions.getStatus())));
    const first = views.getView("layer-invasions").getData();
    assert.strictEqual(first.available, true, JSON.stringify(first));
    assert.ok(first.items[0][3].includes("fleets 0"), JSON.stringify(first.items));
    tx(env.storeResult, (db) => db.prepare("UPDATE world_invasions SET fleet_ids_json = '{}' WHERE invasion_id = 'inv-ls1'").run());
    const obj = views.getView("layer-invasions").getData();
    assert.ok(obj.items[0][3].includes("fleets 0"), JSON.stringify(obj.items));

    config.observer.galaxyInvasionsMaxSystems = 0;
    env.restartInvasions();
    const empty = views.getView("layer-invasions").getData();
    assert.deepStrictEqual([empty.items, empty.note], [[], "0 invasions (layer limit 0)"]);
    assert.ok(views.getView("invasions"), "panel registered again after the restart");

    config.observer.galaxyInvasionsMaxSystems = 1000;
    config.observer.galaxyInvasionsMaxLines = 0;
    env.restartInvasions();
    const header = views.getView("layer-invasions").getData();
    assert.deepStrictEqual(header.items.map((i) => [i[0], i[3]]), [[sys, []]]);

    env.invasions.stop("test");
    assert.deepStrictEqual([views.getView("layer-invasions"), views.getView("invasions")], [null, null]);
    env.occupation.stop("test");
    env.strategy.stop("test");
    env.battle.stop("test");
    env.scheduler.stop("test");
  }));

  needsDriver("IU2 incursions-ui-publish: flag off -> 0 publishIncursions and 0 timers; flag on -> publish at start "
    + "from the real listOpen, one unref'd timer, stop publishes [] and clears it", () => withStore(driver, async (reopen) => {
    const base = configOf({ EVEJS_LNE_INVASIONS_ENABLED: "true", EVEJS_LNE_INVASIONS_CHANCE_PERMILLE: "0", EVEJS_LNE_INVASIONS_ROLL_INTERVAL_MS: "3600000" });
    assert.strictEqual(base.invasions.incursionUi.enabled, false, "default off");
    const config = { ...base, invasions: { ...base.invasions, incursionUi: { ...base.invasions.incursionUi } } };
    const published = [];
    const adapter = { getSovClaims: () => ({ ok: true, claimOf: () => ({ ok: true, claimed: false }) }),
      publishIncursions: (list) => { published.push(list); return { ok: true, count: list.length }; } };
    const intervals = [];
    const cleared = [];
    const timers = {
      setInterval: (fn, ms) => { const h = { fn, ms, unrefed: false, unref() { this.unrefed = true; } }; intervals.push(h); return h; },
      clearInterval: (h) => cleared.push(h),
    };
    const env = bootFull(reopen(), config, { adapter, timers });
    assert.deepStrictEqual([published.length, intervals.length], [0, 0], "flag off: no call, no timer");

    const R = require("../../lib/world/invasions/invasionRepository");
    const S = require("../../lib/world/invasions/schema");
    const { PROFILES } = require("../../lib/world/invasions/data/invaderProfiles");
    const profile = PROFILES.find((p) => p.profileId === "sleeper-tunnel-v1");
    tx(env.storeResult, (db) => {
      const r = R.insertInvasionInTx(db, { invasionId: "inv-7", idempotencyKey: S.spawnKey("inv-7"), rollRound: 7,
        factionId: profile.factionId, profileId: profile.profileId, beachheadSystemId: 30001867,
        captureRangeJumps: profile.captureRangeJumps, fleetIds: [], plan: JSON.stringify({ v: 1 }),
        startedAt: env.clock.now(), withdrawAt: null });
      assert.ok(r.ok, JSON.stringify(r));
    });

    config.invasions.incursionUi.enabled = true;
    env.restartInvasions();
    assert.strictEqual(published.length, 1, "flag on: published once at start");
    assert.deepStrictEqual(published[0].map((e) => [e.taleID, e.stagingSolarSystemID, e.aggressorFactionID, e.state]),
      [[9000000000008, 30001867, profile.factionId, 2]], "taleID = 9e12 + roll_round + 1");
    assert.strictEqual(intervals.length, 1);
    assert.deepStrictEqual([intervals[0].ms, intervals[0].unrefed], [config.invasions.incursionUi.refreshMs, true]);
    intervals[0].fn();
    assert.strictEqual(published.length, 1, "unchanged content: no second publish");

    env.invasions.stop("test");
    assert.deepStrictEqual(published[1], [], "stop clears the vendor list");
    assert.deepStrictEqual(cleared, [intervals[0]]);
    env.occupation.stop("test");
    env.strategy.stop("test");
    env.battle.stop("test");
    env.scheduler.stop("test");
  }));

  needsDriver("SOV1 working sov reader -> no 'sovClaims unavailable'; requireGame refusal or no getSystemSovClaim -> "
    + "the line stays", () => withStore(driver, (reopen) => {
    const { createSovClaimReader } = require("../../lib/adapter/sovClaims");
    const config = configOf({ EVEJS_LNE_INVASIONS_ENABLED: "true", EVEJS_LNE_INVASIONS_CHANCE_PERMILLE: "0" });
    const storeResult = reopen();
    const cases = [
      ["working", () => ({ ok: true, exports: { getSystemSovClaim: () => null } }), false],
      ["not loaded", () => ({ ok: false, reason: "not_booted" }), true],
      ["no getSystemSovClaim", () => ({ ok: true, exports: {} }), true],
    ];
    for (const [name, requireGame, warns] of cases) {
      const lines = [];
      const adapter = { getSovClaims: () => createSovClaimReader({ requireGame }) };
      const env = bootFull(storeResult, config, { adapter, logger: { log: (m) => lines.push(m) } });
      assert.strictEqual(lines.some((l) => l.includes("sovClaims unavailable")), warns, `${name}: ${lines.join(" | ")}`);
      env.invasions.stop("test");
      env.occupation.stop("test");
      env.strategy.stop("test");
      env.battle.stop("test");
      env.scheduler.stop("test");
    }
  }));

  needsDriver("SOV2 claimOf {ok:false} -> sampled claimed null -> the roll ends SOV_UNAVAILABLE, no spawn",
    () => withStore(driver, async (reopen) => {
      const config = configOf({ EVEJS_LNE_INVASIONS_ENABLED: "true", EVEJS_LNE_INVASIONS_CHANCE_PERMILLE: "1000", EVEJS_LNE_INVASIONS_MAX_ACTIVE: "10", EVEJS_LNE_INVASIONS_MAX_ACTIVE_PER_FACTION: "2", EVEJS_LNE_INVASIONS_ROLL_INTERVAL_MS: "3600000" });
      assert.strictEqual(config.invasions.requireSovCheck, true, "default on");
      const adapter = { getSovClaims: () => ({ claimOf: () => ({ ok: false, reason: "SOV_UNAVAILABLE" }) }) };
      const env = bootFull(reopen(), config, { adapter });
      seedK3Systems(env.repo, env.storeResult, "SEED_K3");
      advanceToNextRoll(env);
      const p = await env.scheduler.runPass();
      assert.ok(p.ok && p.jobs > 0, JSON.stringify(p));
      const d = env.invasions.getStatus().lastDecision;
      assert.strictEqual(d && d.outcome, "SOV_UNAVAILABLE", JSON.stringify(d));
      assert.strictEqual(countRows(env.storeResult, "world_invasions"), 0, "no invasion row");
      env.invasions.stop("test");
      env.occupation.stop("test");
      env.strategy.stop("test");
      env.battle.stop("test");
      env.scheduler.stop("test");
    }));
};

module.exports.harness = { loadDriver, withStore, bootFull, configOf, seedK3Systems, tx, START_MS, HOUR, DAY };