"use strict";

const assert = require("node:assert");
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
const { startStrategy } = require("../../lib/strategy");
const { startOccupation } = require("../../lib/world/occupation");
const { createWorldStateRepository } = require("../../lib/world/worldStateRepository");
const { planTerritoryTrim } = require("../../lib/strategy/ai/territoryTrim");
const { TRIM_EVENT } = require("../../lib/strategy/territoryTrimService");
const { resolveConfig } = require("../../config");
const { harness: H } = require("../battle/settlement.test");
const { k3StaticMap } = require("./fixtures/k3Cluster.fixture");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const START = 1760000000000;
const I = 900000;
const AMARR = 500003;
const SAMINER = 30001721;
const p = (n) => 30000000 + n;
const KEPT = [p(1957), p(1956)];
const FAR = [p(1954), p(1953), p(1955), p(1952), p(1951), p(1948)];
const CAPTURED = p(1949);
const LIMITS = Object.freeze({ maxFactionsPerSystem: 8, maxBatchReadIds: 400, maxListLimit: 500 });

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
      return { ok: true, records: list.filter((s) => s.factionId === f && (!opts || !opts.states
        || opts.states.includes(s.state))) };
    },
  } };
}

async function boot(opened, env, rngSeed) {
  const clock = createManualClock(START);
  const ids = createIdGenerator({ clock, rng: createRng(typeof rngSeed === "number" ? rngSeed : 5) });
  const built = buildUniverseGraph(k3StaticMap());
  assert.ok(built.ok);
  const graph = Object.freeze({ ...built.graph, ...createRouteFinder(built.graph, { cacheSize: 64, maxJumps: 40 })
    .publicApi });
  const graphService = { whenReady: () => Promise.resolve({ ok: true, graph }), getGraph: () => ({ ok: true, graph }) };
  const r = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_DATA_ROOT: os.tmpdir(),
    EVEJS_LNE_STRATEGY_ACTIVE_FACTIONS: String(AMARR), EVEJS_LNE_STRATEGY_CAMPAIGNS: "none",
    EVEJS_LNE_STRATEGY_BORDER_ENABLED: "0", ...env } });
  assert.deepStrictEqual(r.errors || [], []);
  const config = r.config;
  const journal = createJournal({ clock, maxPayloadBytes: 16384, maxRows: 500 });
  const persistence = { ok: true, store: opened.store, journal, worldSeed: opened.worldSeed };
  const tx = (fn) => {
    const t = opened.store.transaction("test", fn);
    assert.ok(t.ok, JSON.stringify(t));
    return t.value;
  };
  const repo = createWorldStateRepository({ journal, clock, limits: LIMITS });
  const reads = { n: 0 };
  const world = { repository: { ...repo, listControlledByFaction(db, f, opts) {
    if (!(opts && opts.capturedOnly === true)) reads.n += 1;
    return repo.listControlledByFaction(db, f, opts);
  } } };
  const stations = fakeStations([{ stationId: "st:amarr", systemId: SAMINER, factionId: AMARR, state: "ONLINE" }]);
  const sr = startScheduler({ config, persistence: { ok: true, store: opened.store }, clock, ids, nowMs: () => 0 });
  assert.ok(sr.ok);
  const fr = startFleets({ config, persistence, clock, ids, scheduler: sr.scheduler, graph: graphService,
    presence: null, views: createViewRegistry(), getStations: () => stations });
  assert.ok(fr.ok);
  const or = startOccupation({ config, persistence, clock, scheduler: sr.scheduler, fleets: fr.fleets, world,
    graph: graphService, getStations: () => stations, nowMs: () => 0 });
  assert.ok(or.ok, JSON.stringify(or));
  const lines = [];
  const st = startStrategy({ config, persistence, clock, graph: graphService, world, scheduler: sr.scheduler,
    fleets: fr.fleets, getStations: () => stations, getOccupation: () => or.occupation, views: createViewRegistry(),
    logger: { log: (l) => lines.push(l) } });
  assert.ok(st.ok, JSON.stringify(st));
  return { clock, graph, config, journal, tx, repo, reads, scheduler: sr.scheduler, occupation: or.occupation,
    strategy: st.strategy, lines, async start() {
      await st.strategy.whenReady();
    } };
}

function seed(env, systemId, captured) {
  const r = env.tx((db) => env.repo.applyChange(db, { systemId, expectedVersion: 0, reason: "SEED_CONTROL",
    state: { securityClass: "nullsec", controllerFactionId: AMARR },
    influence: [{ factionId: AMARR, influenceScore: 60 }] }, `world:seed:v1:${systemId}`));
  assert.ok(r.ok, JSON.stringify(r));
  if (captured) {
    assert.ok(env.tx((db) => env.repo.applyChange(db, { systemId, expectedVersion: 1, reason: "TEST_CAPTURED",
      state: { capturedAt: START } }, `test:captured:${systemId}`)).ok);
  }
}

async function passesAt(env, at) {
  env.clock.set(at);
  for (let i = 0; i < 20; i += 1) {
    const r = await env.scheduler.runPass();
    assert.ok(r.ok, JSON.stringify(r));
    if (!r.jobs) return;
  }
}

const systemOf = (env, id) => env.tx((db) => env.repo.getSystem(db, id)).system;
const batches = (env) => env.tx((db) => db.prepare("SELECT idempotency_key AS k, state FROM world_scheduled_events "
  + "WHERE event_type = ? ORDER BY due_at, idempotency_key").all(TRIM_EVENT));
const doneFound = (env) => env.tx((db) => env.journal.findByKey(db, `strategy:trim:v1:done:${AMARR}`)).found;
const trimStatus = (env) => env.strategy.getStatus().ai.trim;

module.exports = ({ test, skip, bench }) => {
  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  needsDriver("TT3 trim: review -> batch:batch:<round> -> far seeded systems abandoned (controller null "
    + "previous Amarr, world key strategy:trim:v1); a replayed batch = duplicates; TRIM_STALE; the end marker after a "
    + "clean pass, then no page read", () => H.withStore(driver, async (reopen) => {
    const env = await boot(reopen(), {});
    for (const id of [...KEPT, ...FAR]) seed(env, id, false);
    seed(env, CAPTURED, true);
    await env.start();
    assert.strictEqual(env.strategy.getStatus().ai.state, "on");
    let t = START;
    while (batches(env).length === 0 && t < START + 3 * I) {
      t += I / 3;
      await passesAt(env, t);
    }
    const first = batches(env);
    assert.strictEqual(first.length, 1, env.lines.join("\n"));
    assert.ok(/^strategy:trim:v1:500003:batch:\d+$/.test(first[0].k), first[0].k);
    await passesAt(env, t);
    assert.strictEqual(batches(env)[0].state, "DONE");
    for (const id of FAR) {
      const s = systemOf(env, id);
      assert.deepStrictEqual([s.controllerFactionId, s.previousControllerFactionId, s.occupationState],
        [null, AMARR, "STABLE"], String(id));
      assert.ok(env.tx((db) => env.repo.isApplied(db, `strategy:trim:v1:${AMARR}:${id}`)).applied, String(id));
    }
    for (const id of [...KEPT, CAPTURED]) assert.strictEqual(systemOf(env, id).controllerFactionId, AMARR);
    assert.strictEqual(trimStatus(env).counters.trimmed, FAR.length);
    const payload = env.tx((db) => JSON.parse(db.prepare("SELECT payload FROM world_scheduled_events WHERE "
      + "idempotency_key = ?").get(first[0].k).payload));
    assert.strictEqual(env.scheduler.enqueue(TRIM_EVENT, String(AMARR), t, payload, first[0].k).duplicate, true);
    const versions = FAR.map((id) => systemOf(env, id).version);
    assert.ok(env.scheduler.enqueue(TRIM_EVENT, String(AMARR), t, payload, "test:trim:replay").ok);
    assert.ok(env.scheduler.enqueue(TRIM_EVENT, String(AMARR), t, { factionId: AMARR, round: 0,
      systemIds: [CAPTURED] }, "test:trim:stale").ok);
    await passesAt(env, t);
    assert.deepStrictEqual(FAR.map((id) => systemOf(env, id).version), versions);
    const c = trimStatus(env).counters;
    assert.deepStrictEqual([c.trimmed, c.duplicate, c.skipped, c.refused], [FAR.length, FAR.length, 1, 0]);
    assert.strictEqual(systemOf(env, CAPTURED).controllerFactionId, AMARR);
    while (!doneFound(env) && t < START + 8 * I) {
      t += I / 3;
      await passesAt(env, t);
    }
    assert.ok(doneFound(env), env.lines.join("\n"));
    assert.strictEqual(trimStatus(env).doneFactions, 1);
    const readsAtDone = env.reads.n;
    await passesAt(env, t + 2 * I);
    assert.strictEqual(env.reads.n, readsAtDone, "no page read after the marker");
    assert.strictEqual(batches(env).length, 3);
    env.strategy.stop("test");
    env.occupation.stop("test");
  }));

  needsDriver("TT3b strategy.territoryTrimEnabled=0: no page read, no batch, the seeded systems stay",
    () => H.withStore(driver, async (reopen) => {
      const env = await boot(reopen(), { EVEJS_LNE_STRATEGY_TERRITORY_TRIM_ENABLED: "0" });
      for (const id of FAR) seed(env, id, false);
      await env.start();
      await passesAt(env, START + I);
      await passesAt(env, START + 2 * I);
      assert.deepStrictEqual([env.reads.n, batches(env).length], [0, 0]);
      for (const id of FAR) assert.strictEqual(systemOf(env, id).controllerFactionId, AMARR);
      env.strategy.stop("test");
      env.occupation.stop("test");
    }));

  if (driver.ok) {
    bench("TT-bench planner 800 systems / page 256 / 5 stations; batch of 32 abandons", () => H.withStore(
      driver, async (reopen) => {
        const env = await boot(reopen(), {});
        const all = [...env.graph.getSystemIds()].sort((a, b) => a - b);
        const neighbors = (id) => env.graph.getNeighbors(id);
        const rows = Array.from({ length: 800 }, (_, i) => ({ systemId: 31000000 + i, state: "STABLE",
          capturedAt: null }));
        const snapshot = { factionId: AMARR, faction: { homeSystemId: null }, neighbors, theatre: [],
          border: null, trim: { mode: "ready", anchors: all.slice(0, 5), rows: rows.slice(0, 256), afterSystemId: 0,
            nextAfterSystemId: 31000255, passClean: true } };
        const P = { territoryTrimEnabled: true, startTerritoryJumps: 2, maxTrimsPerReview: 32,
          captureRangeFromStationJumps: 5, routeMaxJumps: 40, maxBfsSystems: 2000 };
        const ms = [];
        for (let i = 0; i < 50; i += 1) {
          const t0 = process.hrtime.bigint();
          planTerritoryTrim(snapshot, P);
          ms.push(Number(process.hrtime.bigint() - t0) / 1e6);
        }
        ms.sort((a, b) => a - b);
        const far = all.filter((id) => id !== SAMINER && !KEPT.includes(id)).slice(0, 32);
        for (const id of far) seed(env, id, false);
        await env.start();
        const t0 = process.hrtime.bigint();
        assert.ok(env.scheduler.enqueue(TRIM_EVENT, String(AMARR), START, { factionId: AMARR, round: 0,
          systemIds: far }, "bench:trim").ok);
        env.clock.set(START);
        await env.scheduler.runPass();
        const batchMs = Number(process.hrtime.bigint() - t0) / 1e6;
        process.stdout.write(`    planner p95 ${ms[Math.floor(ms.length * 0.95)].toFixed(3)} ms; batch of `
          + `${far.length}: ${batchMs.toFixed(1)} ms, trimmed ${trimStatus(env).counters.trimmed}\n`);
        env.strategy.stop("test");
        env.occupation.stop("test");
      }));
  }

  needsDriver("TT4 trim clears home_faction_id; duplicate batch no-op; clearHomeInTx refusal rolls back abandon", () => H.withStore(driver, async (reopen) => {
    const env = await boot(reopen(), {});
    const id1 = 30000900;
    const id2 = 30000901;
    const idStale = 30000902;
    seed(env, id1, false);
    seed(env, id2, false);
    seed(env, idStale, true);
    await env.start();
    let t = START;
    while (batches(env).length === 0 && t < START + 3 * I) {
      t += I / 3;
      await passesAt(env, t);
    }
    const first = batches(env);
    assert.strictEqual(first.length, 1);
    await passesAt(env, t);
    assert.strictEqual(batches(env)[0].state, "DONE");
    for (const id of [id1, id2]) {
      const s = systemOf(env, id);
      assert.deepStrictEqual([s.controllerFactionId, s.previousControllerFactionId, s.occupationState, s.homeFactionId],
        [null, AMARR, "STABLE", null], String(id));
      assert.ok(env.tx((db) => env.repo.isApplied(db, `strategy:trim:v1:${AMARR}:${id}`)).applied, String(id));
    }
    const sStale = systemOf(env, idStale);
    assert.strictEqual(sStale.controllerFactionId, AMARR);
    assert.strictEqual(sStale.homeFactionId, AMARR, "home_faction_id kept for STALE");
    const payload = env.tx((db) => JSON.parse(db.prepare("SELECT payload FROM world_scheduled_events WHERE idempotency_key = ?").get(first[0].k).payload));
    assert.strictEqual(env.scheduler.enqueue(TRIM_EVENT, String(AMARR), t, payload, first[0].k).duplicate, true);
    const versionsBefore = [id1, id2, idStale].map((id) => systemOf(env, id).version);
    await passesAt(env, t);
    assert.deepStrictEqual([id1, id2, idStale].map((id) => systemOf(env, id).version), versionsBefore);
    const clearResult = env.tx((db) => env.repo.clearHomeInTx(db, id1, AMARR));
    assert.deepStrictEqual(clearResult, { ok: true, changed: false });
    env.strategy.stop("test");
    env.occupation.stop("test");
  }));

  async function setupTrimScenario(env, systemIds, factionsPerSystem) {
    for (const id of systemIds) {
      const influence = [];
      for (let f = 0; f < factionsPerSystem; f++) {
        influence.push({ factionId: 500000 + f, influenceScore: 10 + f });
      }
      env.tx((db) => env.repo.applyChange(db, { systemId: id, expectedVersion: 0, reason: "SEED_TRIM",
        state: { securityClass: "nullsec", controllerFactionId: AMARR },
        influence }, `world:seed:trim:${id}`));
    }
  }

  async function runTrimBatch(env, systemIds, key) {
    const t = START;
    const payload = { factionId: AMARR, round: 0, systemIds };
    const result = env.scheduler.enqueue(TRIM_EVENT, String(AMARR), t, payload, key);
    assert.ok(result.ok, `enqueue failed: ${JSON.stringify(result)}`);
    await passesAt(env, t);
    return batches(env)[0];
  }

  function verifyTrimResult(env, systemIds) {
    for (const id of systemIds) {
      const s = systemOf(env, id);
      assert.deepStrictEqual([s.controllerFactionId, s.previousControllerFactionId, s.occupationState, s.homeFactionId],
        [null, AMARR, "STABLE", null], String(id));
      assert.ok(env.tx((db) => env.repo.isApplied(db, `strategy:trim:v1:${AMARR}:${id}`)).applied, String(id));
    }
  }

  function verifyNoChanges(env, systemIds) {
    for (const id of systemIds) {
      const s = systemOf(env, id);
      assert.strictEqual(s.controllerFactionId, AMARR, `controller should NOT change on TX_ROW_LIMIT (id=${id})`);
      assert.strictEqual(s.homeFactionId, AMARR, `home_faction_id should NOT change on TX_ROW_LIMIT (id=${id})`);
    }
  }

  async function measureTrimBatchRows(N, F, maxRowsPerTransactionHint) {
    const trimBatchRows = require("../../lib/strategy/reviewRows").trimBatchRows;
    const bound = trimBatchRows(N, F);
    const { openStore } = require("../../lib/persistence/store");
    const { resolveSqliteDriver } = require("../../lib/adapter/sqliteDriver");
    const { findServerSrcOnDisk, GAMESTORE_SEARCH_MAX_DEPTH } = require("../../lib/adapter/locator");
    const fs = require("node:fs");
    const os = require("node:os");
    const path = require("node:path");
    const MOD_DIR = path.resolve(__dirname, "..", "..");

    const found = findServerSrcOnDisk(MOD_DIR, GAMESTORE_SEARCH_MAX_DEPTH, fs.existsSync);
    assert.ok(found.ok, found.reason);
    const sqliteDriver = resolveSqliteDriver(found.srcDir);

    const seedTmp = fs.mkdtempSync(path.join(os.tmpdir(), "lne-trim-seed-"));
    const seedFile = path.join(seedTmp, "world.sqlite");
    const seedOpened = openStore({ filePath: seedFile, openDatabase: (f) => new sqliteDriver.Database(f), exclusiveLock: true,
      busyTimeoutMs: 0, maxRowsPerTransaction: 500, maxWriteMsPerPass: 5, randomSeed: () => 1 });
    assert.ok(seedOpened.ok, JSON.stringify(seedOpened));
    try {
      const seedEnv = await boot(seedOpened, { EVEJS_LNE_FLEETS_MAX_FLEETS_PER_OPERATION: "1" });
      const seedSystemIds = [30009000, 30009001];
      await setupTrimScenario(seedEnv, seedSystemIds, F);
      seedEnv.strategy.stop("test");
      seedEnv.occupation.stop("test");
    } finally {
      seedOpened.store.close("seed_cleanup");
    }

    let low = 1;
    let high = Math.max(bound, maxRowsPerTransactionHint || bound);
    let measured = high;

    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      const testTmp = fs.mkdtempSync(path.join(os.tmpdir(), `lne-trim-measure-${mid}-`));
      const testFile = path.join(testTmp, "world.sqlite");
      fs.copyFileSync(seedFile, testFile);
      let opened;
      try {
        opened = openStore({ filePath: testFile, openDatabase: (f) => new sqliteDriver.Database(f), exclusiveLock: true,
          busyTimeoutMs: 0, maxRowsPerTransaction: mid, maxWriteMsPerPass: 5, randomSeed: () => 1 });
        assert.ok(opened.ok, JSON.stringify(opened));

        const env = await boot(opened, { EVEJS_LNE_FLEETS_MAX_FLEETS_PER_OPERATION: "1" }, mid);
        const systemIds = [30009000, 30009001];
        await env.start();
        env.tx((db) => db.prepare("DELETE FROM world_scheduled_events WHERE event_type = ?").run(TRIM_EVENT));
        const batch = await runTrimBatch(env, systemIds, `measure:${mid}`);
        const passed = batch.state === "DONE";
        env.strategy.stop("test");
        env.occupation.stop("test");

        if (passed) {
          measured = mid;
          high = mid - 1;
        } else {
          low = mid + 1;
        }
      } finally {
        if (opened) opened.store.close("measure_cleanup");
        try { fs.rmSync(testTmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch (_err) {}
      }
    }

    try { fs.rmSync(seedTmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch (_err) {}

    return measured;
  }

  needsDriver("TT5 trim batch rows <= trimBatchRows: measure actual cost, assert measured <= bound, and batch at bound passes", () => {
    const trimBatchRows = require("../../lib/strategy/reviewRows").trimBatchRows;
    const MAX_F = 8;
    const N = 2;
    const bound = trimBatchRows(N, MAX_F);

    return H.withStore(driver, async (reopen) => {
      const measured = await measureTrimBatchRows(N, MAX_F, bound);
      console.log(`[TT5] Measured trim batch rows: ${measured}, theoretical bound (trimBatchRows): ${bound}`);
      assert.ok(measured <= bound, `measured ${measured} should be <= trimBatchRows ${bound}`);

      const opened = reopen();
      opened.store.close("test_reopen_for_bound_test");
      const { openStore } = require("../../lib/persistence/store");
      const { resolveSqliteDriver } = require("../../lib/adapter/sqliteDriver");
      const { findServerSrcOnDisk, GAMESTORE_SEARCH_MAX_DEPTH } = require("../../lib/adapter/locator");
      const fs = require("node:fs");
      const os = require("node:os");
      const path = require("node:path");
      const MOD_DIR = path.resolve(__dirname, "..", "..");
      const found = findServerSrcOnDisk(MOD_DIR, GAMESTORE_SEARCH_MAX_DEPTH, fs.existsSync);
      assert.ok(found.ok, found.reason);
      const sqliteDriver = resolveSqliteDriver(found.srcDir);
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lne-tt5-bound-"));
      const file = path.join(tmp, "world.sqlite");
      const opened2 = openStore({ filePath: file, openDatabase: (f) => new sqliteDriver.Database(f), exclusiveLock: true,
        busyTimeoutMs: 0, maxRowsPerTransaction: bound, maxWriteMsPerPass: 5, randomSeed: () => 1 });
      assert.ok(opened2.ok, JSON.stringify(opened2));
      try {
        const env = await boot(opened2, { EVEJS_LNE_FLEETS_MAX_FLEETS_PER_OPERATION: "10" });
        const systemIds = [30001900, 30001901];
        await setupTrimScenario(env, systemIds, MAX_F);
        await env.start();
        const batch = await runTrimBatch(env, systemIds, "test:tt5:batch:0");
        assert.strictEqual(batch.state, "DONE", "batch should complete at trimBatchRows budget");
        verifyTrimResult(env, systemIds);
        env.strategy.stop("test");
        env.occupation.stop("test");
      } finally {
        opened2.store.close("test_cleanup_tt5");
        try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch (_err) {}
      }
    });
  });

  needsDriver("TT5b trim batch control: maxRowsPerTransaction = measured - 1 -> TX_ROW_LIMIT, no changes", () => {
    const trimBatchRows = require("../../lib/strategy/reviewRows").trimBatchRows;
    const MAX_F = 8;
    const N = 2;
    const bound = trimBatchRows(N, MAX_F);

    return H.withStore(driver, async (reopen) => {
      const measured = await measureTrimBatchRows(N, MAX_F, bound);
      console.log(`[TT5b] Measured trim batch rows: ${measured}, theoretical bound (trimBatchRows): ${bound}`);
      assert.ok(measured <= bound, `measured ${measured} should be <= trimBatchRows ${bound}`);

      const controlLimit = measured - 1;
      if (controlLimit < 1) {
        console.log(`[TT5b] SKIP: measured=${measured}, controlLimit would be ${controlLimit} < 1`);
        return;
      }

      const { openStore } = require("../../lib/persistence/store");
      const { resolveSqliteDriver } = require("../../lib/adapter/sqliteDriver");
      const { findServerSrcOnDisk, GAMESTORE_SEARCH_MAX_DEPTH } = require("../../lib/adapter/locator");
      const fs = require("node:fs");
      const os = require("node:os");
      const path = require("node:path");
      const MOD_DIR = path.resolve(__dirname, "..", "..");
      const found = findServerSrcOnDisk(MOD_DIR, GAMESTORE_SEARCH_MAX_DEPTH, fs.existsSync);
      assert.ok(found.ok, found.reason);
      const sqliteDriver = resolveSqliteDriver(found.srcDir);

      const seedTmp = fs.mkdtempSync(path.join(os.tmpdir(), "lne-tt5b-seed-"));
      const seedFile = path.join(seedTmp, "world.sqlite");
      const seedOpened = openStore({ filePath: seedFile, openDatabase: (f) => new sqliteDriver.Database(f), exclusiveLock: true,
        busyTimeoutMs: 0, maxRowsPerTransaction: 500, maxWriteMsPerPass: 5, randomSeed: () => 1 });
      assert.ok(seedOpened.ok, JSON.stringify(seedOpened));
      try {
        const env = await boot(seedOpened, { EVEJS_LNE_FLEETS_MAX_FLEETS_PER_OPERATION: "3" });
        const systemIds = [30002900, 30002901];
        await setupTrimScenario(env, systemIds, MAX_F);
        env.strategy.stop("test");
        env.occupation.stop("test");
      } finally {
        seedOpened.store.close("seed_cleanup");
      }

      const testTmp = fs.mkdtempSync(path.join(os.tmpdir(), "lne-tt5b-control-"));
      const testFile = path.join(testTmp, "world.sqlite");
      fs.copyFileSync(seedFile, testFile);
      const opened2 = openStore({ filePath: testFile, openDatabase: (f) => new sqliteDriver.Database(f), exclusiveLock: true,
        busyTimeoutMs: 0, maxRowsPerTransaction: controlLimit, maxWriteMsPerPass: 5, randomSeed: () => 1 });
      assert.ok(opened2.ok, JSON.stringify(opened2));
      try {
        const env = await boot(opened2, { EVEJS_LNE_FLEETS_MAX_FLEETS_PER_OPERATION: "3" }, 999);
        const systemIds = [30002900, 30002901];
        await env.start();
        env.tx((db) => db.prepare("DELETE FROM world_scheduled_events WHERE event_type = ?").run(TRIM_EVENT));
        const batch = await runTrimBatch(env, systemIds, "test:tt5b:control:0");

        if (batch.state === "DONE") {
          throw new Error(`Control test FAIL: batch passed at maxRowsPerTransaction=${controlLimit} (measured=${measured}). Expected TX_ROW_LIMIT.`);
        }

        verifyNoChanges(env, systemIds);

        env.strategy.stop("test");
        env.occupation.stop("test");
      } finally {
        opened2.store.close("test_cleanup_tt5b");
        try { fs.rmSync(testTmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch (_err) {}
      }

      try { fs.rmSync(seedTmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch (_err) {}
    });
  });
};
