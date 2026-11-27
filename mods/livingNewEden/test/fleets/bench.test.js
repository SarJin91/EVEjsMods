"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { resolveConfig } = require("../../config");
const { findServerSrcOnDisk, GAMESTORE_SEARCH_MAX_DEPTH } = require("../../lib/adapter/locator");
const { resolveSqliteDriver } = require("../../lib/adapter/sqliteDriver");
const { openStore } = require("../../lib/persistence/store");
const { createJournal } = require("../../lib/persistence/journal");
const { createManualClock } = require("../../lib/util/clock");
const { createRng } = require("../../lib/util/rng");
const { createIdGenerator } = require("../../lib/util/ids");
const { createViewRegistry } = require("../../lib/observer/views");
const { startScheduler } = require("../../lib/scheduler");
const { startFleets } = require("../../lib/fleets");
const { runBench, syntheticGraph } = require("../../tools/benchScheduler");
const { buildUniverseGraph } = require("../../lib/graph/universeGraph");
const { createRouteFinder } = require("../../lib/graph/routes");
const { createBench, fleetIdOf, OUTCOME } = require("../../lib/fleets/bench");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const START_MS = 1760000000000;

function loadDriver() {
  const found = findServerSrcOnDisk(MOD_DIR, GAMESTORE_SEARCH_MAX_DEPTH, fs.existsSync);
  if (!found.ok) return { ok: false, detail: found.reason };
  return resolveSqliteDriver(found.srcDir);
}

function configOf(env) {
  return resolveConfig({ modDir: MOD_DIR, env: { EVEJS_DATA_ROOT: "/tmp/lne-bench-test", ...env } }).config;
}

function graphWithIsolated() {
  const systems = [];
  const gates = [];
  for (let i = 0; i < 40; i += 1) {
    systems.push({ id: 30000001 + i, name: `N-${i}`, regionId: 10000001, constellationId: 20000001, security: -0.3,
      trueSecurity: -0.3, secClass: "nullsec", factionId: 0, position: { x: i, y: 0, z: 0 } });
    if (i > 0 && i < 10) gates.push({ fromSystemId: 30000000 + i, toSystemId: 30000001 + i },
      { fromSystemId: 30000001 + i, toSystemId: 30000000 + i });
  }
  const built = buildUniverseGraph({ systems, gates });
  assert.ok(built.ok, JSON.stringify(built));
  return { ...built.graph, ...createRouteFinder(built.graph, { cacheSize: 64, maxJumps: 40 }).publicApi };
}

function assertOfflineBench(r, fleets) {
  assert.deepStrictEqual(r.failures, []);
  assert.strictEqual(r.ok, true);
  const s = r.scenarios[0];
  assert.strictEqual(s.invariants.fleets, fleets);
  for (const key of ["doubleArrivals", "lostArrivals", "inFlightMismatch", "quarantined", "claimed"]) {
    assert.strictEqual(s.invariants[key], 0, key);
  }
  assert.ok(s.offline.lastEpisode.maxPerPass <= 32, JSON.stringify(s.offline.lastEpisode));
  assert.ok(s.offline.drainOverdue > 0 && s.offline.drainOverdue <= 3 * s.offline.open0, JSON.stringify(s.offline));
  assert.deepStrictEqual([s.offline.increases, s.offline.trailHead[0] > 0], [0, true]);
  assert.ok(s.offline.coalesced > 0, "periodic ROAM rows coalesced after the downtime");
}

const offlineBench = (fleets) => runBench({ fleets, hours: 0.05, dwellMin: 2, offlineHours: 6, scenario: "offline",
  memory: true, seed: 1, mapSystems: 300, quiet: true });

module.exports = ({ test, skip, bench }) => {
  test("B5 seed on a graph with gateless nullsec systems: every fleet seeded, no BENCH_NO_TARGET", () => {
    const graph = graphWithIsolated();
    const fleets = 60;
    const bench = createBench({ store: { transaction: (_n, fn) => ({ ok: true, value: fn(null) }), limits: {} },
      repository: { getFleet: () => ({ ok: true, fleet: null }) }, travel: {}, scheduler: {},
      graph: { getGraph: () => ({ ok: true, graph }) }, worldSeed: 11, clock: { now: () => START_MS },
      settings: { fleets, dwellMs: 600000, roamMaxJumps: 5 } });
    const handler = bench.handlers.BENCH_FLEET_ROAM;
    for (let index = 0; index < fleets; index += 1) {
      const r = handler({ payload: { index, round: 0 }, aggregateId: fleetIdOf(index), dueAt: START_MS }, {});
      assert.deepStrictEqual([r.ok, r.outcome, r.reason], [true, OUTCOME.SEEDED, undefined], `index ${index}`);
    }
    assert.deepStrictEqual([bench.getStatus().counters.seeded, bench.getStatus().counters.noTarget], [fleets, 0]);
  });

  const driver = loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  const B1_SHORT = "B1 bench 20 fleets: offline 6 h, catch-up capped, backlog non-increasing to 0, 0 dup/lost";
  if (driver.ok) bench(B1_SHORT, async () => assertOfflineBench(await offlineBench(20), 20));
  else skip(B1_SHORT, `better-sqlite3 unavailable (${driver.detail})`);

  const B1_FULL = "B1 bench 500 fleets: offline 6 h, catch-up capped, backlog non-increasing to 0";
  if (driver.ok) bench(B1_FULL, async () => assertOfflineBench(await offlineBench(500), 500));
  else skip(B1_FULL, `better-sqlite3 unavailable (${driver.detail})`);

  needsDriver("B3 bench guards: world.sqlite refused, seed 3 then restart duplicates, limit, panel fleets",
    async () => {
    const opened = openStore({ filePath: ":memory:", openDatabase: (f) => new driver.Database(f), exclusiveLock: true,
      busyTimeoutMs: 0, maxRowsPerTransaction: 500, maxWriteMsPerPass: 5, randomSeed: () => 7 });
    assert.ok(opened.ok, JSON.stringify(opened));
    const store = opened.store;
    try {
      const clock = createManualClock(START_MS);
      const ids = createIdGenerator({ clock, rng: createRng(3) });
      const graph = syntheticGraph(200, 7, 40);
      const roamRows = () => store.transaction("t", (db) => db.prepare("SELECT count(*) AS n FROM "
        + "world_scheduled_events WHERE event_type = 'BENCH_FLEET_ROAM'").get().n).value;
      const boot = async (env, openedFile) => {
        const config = configOf(env);
        const lines = [];
        const logger = { log: (l) => lines.push(l) };
        const sr = startScheduler({ config, persistence: { ok: true, store }, clock, ids, logger, nowMs: () => 0 });
        assert.ok(sr.ok, JSON.stringify(sr));
        const views = createViewRegistry();
        const journal = createJournal({ clock, maxPayloadBytes: 16384, maxRows: 500 });
        const filePath = openedFile !== undefined ? openedFile : path.join(config.dataDir, config.persistence.dbFile);
        const fr = startFleets({ config, persistence: { ok: true, store, journal, worldSeed: opened.worldSeed, filePath },
          clock, ids, logger, scheduler: sr.scheduler, graph: { getGraph: () => ({ ok: true, graph }) }, views });
        assert.ok(fr.ok, JSON.stringify(fr));
        await fr.fleets.benchReady();
        return { lines, views, scheduler: sr.scheduler, fleets: fr.fleets, stop() {
          fr.fleets.stop("t");
          sr.scheduler.stop("t");
        } };
      };

      const a = await boot({ EVEJS_LNE_TEST_BENCH_FLEETS: "3" });
      assert.deepStrictEqual(a.lines.filter((l) => l.startsWith("fleets: bench")),
        ["fleets: bench refused - BENCH_REQUIRES_SEPARATE_DB"]);
      assert.strictEqual(roamRows(), 0);
      a.stop();
      for (const file of ["/data/world.sqlite", null]) {
        const w = await boot({ EVEJS_LNE_TEST_BENCH_FLEETS: "3", EVEJS_LNE_PERSISTENCE_DB_FILE: "bench.sqlite" }, file);
        assert.ok(w.lines.includes("fleets: bench refused - BENCH_REQUIRES_SEPARATE_DB"), w.lines.join("|"));
        assert.strictEqual(roamRows(), 0);
        w.stop();
      }

      const c = await boot({ EVEJS_LNE_TEST_BENCH_FLEETS: "3", EVEJS_LNE_PERSISTENCE_DB_FILE: "bench.sqlite",
        EVEJS_LNE_MAX_VIRTUAL_FLEETS: "2" });
      assert.ok(c.lines.includes("fleets: bench refused - BENCH_EXCEEDS_LIMIT"), c.lines.join("|"));
      assert.strictEqual(roamRows(), 0);
      c.stop();

      const benchEnv = { EVEJS_LNE_TEST_BENCH_FLEETS: "3", EVEJS_LNE_PERSISTENCE_DB_FILE: "bench.sqlite" };
      const b = await boot(benchEnv);
      const on = (e, d) => `fleets: bench on fleets=3 enqueued=${e} duplicates=${d} dbFile=bench.sqlite dwellMs=300000`;
      assert.ok(b.lines.includes(on(3, 0)), b.lines.join("|"));
      assert.strictEqual(roamRows(), 3);
      b.stop();
      const b2 = await boot(benchEnv);
      assert.ok(b2.lines.includes(on(0, 3)), b2.lines.join("|"));

      const def = b2.views.getView("fleets");
      assert.ok(def, "view fleets registered");
      const data = def.getData();
      assert.strictEqual(data.available, true, JSON.stringify(data));
      assert.deepStrictEqual([typeof data.fleets.byState, typeof data.operations.byState, data.bench.target],
        ["object", "object", 3]);
      const key = def.cacheKey();
      clock.advance(1000);
      assert.strictEqual(def.cacheKey(), key, "same key inside the refresh bucket");
      b2.stop();
    } finally {
      store.close("t");
    }
  });

  test("T5 bench seed D-f: 250 fleets in slices of 100 with a yield between them; second seed duplicates",
    async () => {
      const calls = [];
      const keys = new Set();
      const scheduler = { enqueueMany(specs) {
        calls.push(specs.length);
        let enqueued = 0;
        let duplicates = 0;
        for (const spec of specs) {
          if (keys.has(spec.idempotencyKey)) duplicates += 1;
          else {
            keys.add(spec.idempotencyKey);
            enqueued += 1;
          }
        }
        return { ok: true, enqueued, duplicates };
      } };
      let yields = 0;
      const bench = createBench({ store: { transaction: () => ({ ok: false, reason: "unused" }),
        limits: { maxRowsPerTransaction: 500 } }, repository: {}, travel: {}, scheduler, graph: null, worldSeed: 1,
      clock: { now: () => START_MS }, settings: { fleets: 250, dwellMs: 600000, roamMaxJumps: 5, seedBatchRows: 100 },
      setImmediateFn: (fn) => {
        yields += 1;
        setImmediate(fn);
      } });
      const first = await bench.seed();
      assert.deepStrictEqual(first, { ok: true, enqueued: 250, duplicates: 0 });
      assert.deepStrictEqual(calls, [100, 100, 50]);
      assert.strictEqual(yields, 2, "the loop is given back between the slices");
      const second = await bench.seed();
      assert.deepStrictEqual(second, { ok: true, enqueued: 0, duplicates: 250 });
    });
};
