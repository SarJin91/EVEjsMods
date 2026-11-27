"use strict";

const assert = require("node:assert");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");

const { findServerSrcOnDisk, GAMESTORE_SEARCH_MAX_DEPTH } = require("../../lib/adapter/locator");
const { resolveSqliteDriver } = require("../../lib/adapter/sqliteDriver");
const { readStaticMapFrom } = require("../../lib/adapter/staticMap");
const { buildUniverseGraph } = require("../../lib/graph/universeGraph");
const { createRouteFinder } = require("../../lib/graph/routes");
const { openStore } = require("../../lib/persistence/store");
const { seedDbFile } = require("../_support/dbTemplate");
const { createJournal } = require("../../lib/persistence/journal");
const { createManualClock } = require("../../lib/util/clock");
const { createRng } = require("../../lib/util/rng");
const { createIdGenerator } = require("../../lib/util/ids");
const { createViewRegistry } = require("../../lib/observer/views");
const { startScheduler } = require("../../lib/scheduler");
const { startFleets } = require("../../lib/fleets");
const { loadSecurityBand } = require("../graph/fixtures/staticMap.fixture");
const { S, rawWorld } = require("../graph/fixtures/routeMap.fixture");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const START_MS = 1760000000000;
const FACTION = 500019;
const COMPOSITION = Object.freeze([{ hullGroup: "frigate", count: 5 }, { hullGroup: "cruiser", count: 3 }]);
const AVOID = Object.freeze({ avoidSecClasses: ["highsec", "lowsec"] });
const REFIT_MS = 600000;

const CONFIG = Object.freeze({
  enabled: true,
  modules: { scheduler: { enabled: true }, fleets: { enabled: true } },
  scheduler: { maxAttempts: 5, retryBaseMs: 1000, retryMaxMs: 600000, maxOpenEvents: 50000, maxPayloadBytes: 4096,
    intervalMs: 1000, sliceMs: 4, claimBatchSize: 8, catchUpLagMs: 60000, backlogCountCap: 4096,
    chainedHeadroom: 1000 },
  limits: { maxDueEventsPerPass: 64, maxSchedulerWorkMs: 8, maxCatchUpEventsPerPass: 32, maxVirtualFleets: 50 },
  fleets: { maxCompositionEntries: 32, maxShipsPerFleet: 500, maxFleetsPerOperation: 16, maxJsonBytes: 4096,
    maxListLimit: 500, travelTimeFactor: 1, refitMs: REFIT_MS, operationMaxOverdueRounds: 12 },
  persistence: { journalMaxPayloadBytes: 8192 },
  observer: { galaxyEnabled: true, galaxyFleetsEnabled: true, galaxyFleetsMaxItems: 500,
    galaxyFleetsRefreshMs: 5000, galaxyInvasionsEnabled: true, galaxyInvasionsMaxSystems: 1000,
    galaxyInvasionsMaxLines: 6, galaxyInvasionsRefreshMs: 60000 },
});

function loadDriver() {
  const found = findServerSrcOnDisk(MOD_DIR, GAMESTORE_SEARCH_MAX_DEPTH, fs.existsSync);
  if (!found.ok) return { ok: false, detail: found.reason };
  return resolveSqliteDriver(found.srcDir);
}

function fixtureGraph() {
  const read = readStaticMapFrom({ ensureLoaded: () => rawWorld() }, loadSecurityBand());
  if (read.ok !== true) throw new Error(JSON.stringify(read));
  const built = buildUniverseGraph(read.map);
  if (built.ok !== true) throw new Error(JSON.stringify(built));
  const finder = createRouteFinder(built.graph, { cacheSize: 64, maxJumps: 40 });
  return { graph: Object.freeze({ ...built.graph, ...finder.publicApi }), finder, S };
}

async function withStore(driver, fn, { fresh = false } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lne-tg-"));
  const file = path.join(tmp, "world.sqlite");
  const open = [];
  const reopen = () => {
    if (!fresh) seedDbFile(driver, file, { seed: 1 });
    const opened = openStore({ filePath: file, openDatabase: (f) => new driver.Database(f), exclusiveLock: true,
      busyTimeoutMs: 0, maxRowsPerTransaction: 500, maxWriteMsPerPass: 5, randomSeed: () => 1 });
    if (!opened.ok) throw new Error(JSON.stringify(opened));
    open.push(opened.store);
    return opened;
  };
  try {
    return await fn(reopen);
  } finally {
    for (const s of open) s.close("test_cleanup");
    try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); } catch (_err) {}
  }
}

function boot(opened, shared, extra = {}) {
  const config = extra.config || CONFIG;
  const journal = createJournal({ clock: shared.clock, maxPayloadBytes: 8192, maxRows: 500 });
  const sr = startScheduler({ config, persistence: { ok: true, store: opened.store }, clock: shared.clock,
    ids: shared.ids, nowMs: () => 0 });
  if (!sr.ok) throw new Error(JSON.stringify(sr));
  const views = createViewRegistry();
  const graph = extra.graph || shared.graph;
  const fr = startFleets({ config, persistence: { ok: true, store: opened.store, journal, worldSeed: opened.worldSeed },
    clock: shared.clock, ids: shared.ids, scheduler: sr.scheduler, graph: { getGraph: () => ({ ok: true, graph }) },
    presence: extra.presence || null, views, getGovernor: extra.getGovernor });
  if (!fr.ok) throw new Error(JSON.stringify(fr));
  return { store: opened.store, scheduler: sr.scheduler, fleets: fr.fleets, views };
}

function sharedOf(opts = {}) {
  const clock = createManualClock(START_MS, opts.timeScale ? { timeScale: opts.timeScale } : {});
  return { clock, ids: createIdGenerator({ clock, rng: createRng(5) }), graph: fixtureGraph().graph };
}

function q(store, sql, ...args) {
  const r = store.transaction("test", (db) => db.prepare(sql).all(...args));
  if (!r.ok) throw new Error(JSON.stringify(r));
  return r.value;
}

const n = (store, sql, ...args) => q(store, sql, ...args)[0].n;

function fleetOf(env, fleetId) {
  const r = env.fleets.getFleet(fleetId);
  if (!r.ok) throw new Error(JSON.stringify(r));
  return r.fleet;
}

function orderedFleet(env, tag, opts = {}) {
  const created = env.fleets.createFleet({ factionId: FACTION, currentSystemId: opts.from || S.N0,
    homeSystemId: opts.home === undefined ? S.N0 : opts.home, fleetRole: "invasion",
    composition: opts.composition || COMPOSITION }, `${tag}:create`);
  if (!created.ok) throw new Error(JSON.stringify(created));
  const op = env.fleets.createOperation({ operationType: "invasion", factionId: FACTION, originSystemId: S.N0,
    targetSystemId: S.N9, objective: "capture", ...(opts.dueAt === undefined ? {} : { dueAt: opts.dueAt }),
    fleets: [{ fleetId: created.fleetId, expectedVersion: 1 }] }, `${tag}:op`);
  if (!op.ok) throw new Error(JSON.stringify(op));
  return { fleetId: created.fleetId, operationId: op.operationId };
}

function planOk(env, input, key) {
  const r = env.fleets.planTravel(input, key);
  if (!r.ok) throw new Error(JSON.stringify(r));
  return r;
}

async function pass(env) {
  const r = await env.scheduler.runPass();
  if (!r.ok) throw new Error(JSON.stringify(r));
  return r;
}

module.exports = ({ test, skip }) => {
  const driver = loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  needsDriver("TG1 departure guard: blocks departure when guard returns refusal", async () => {
    await withStore(driver, async (reopen) => {
      const shared = sharedOf();
      const env = boot(reopen(), shared);
      const { fleetId } = orderedFleet(env, "tg1");
      const fleetBefore = fleetOf(env, fleetId);
      assert.strictEqual(fleetBefore.state, "PLANNED");

      const guardResult = { ok: false, reason: "FLEET_PINNED", detail: "pinned by hunter" };
      let guardCalls = 0;
      const remove = env.fleets.addDepartureGuard(() => { guardCalls++; return guardResult; });
      assert.ok(remove.ok);

      const r = env.fleets.planTravel({ fleetId, targetSystemId: S.N5, constraints: AVOID }, "tg1:plan");
      assert.deepStrictEqual([r.ok, r.reason], [false, "FLEET_PINNED"]);
      assert.strictEqual(guardCalls, 1);

      const fleet = fleetOf(env, fleetId);
      assert.strictEqual(fleet.state, "PLANNED");

      remove.remove();
    });
  });

  needsDriver("TG2 departure guard: allows departure when guard returns ok", async () => {
    await withStore(driver, async (reopen) => {
      const shared = sharedOf();
      const env = boot(reopen(), shared);
      const { fleetId } = orderedFleet(env, "tg2");
      let guardCalls = 0;
      const remove = env.fleets.addDepartureGuard(() => { guardCalls++; return { ok: true }; });
      assert.ok(remove.ok);

      const r = env.fleets.planTravel({ fleetId, targetSystemId: S.N5, constraints: AVOID }, "tg2:plan");
      assert.strictEqual(r.ok, true);
      assert.strictEqual(guardCalls, 1);

      remove.remove();
    });
  });

  needsDriver("TG3 departure guard: exception in guard is fail-open (counted)", async () => {
    await withStore(driver, async (reopen) => {
      const shared = sharedOf();
      const env = boot(reopen(), shared);
      const { fleetId } = orderedFleet(env, "tg3");
      const remove = env.fleets.addDepartureGuard(() => { throw new Error("guard boom"); });
      assert.ok(remove.ok);

      const r = env.fleets.planTravel({ fleetId, targetSystemId: S.N5, constraints: AVOID }, "tg3:plan");
      assert.strictEqual(r.ok, true, "fail-open: departure allowed despite guard exception");

      const counters = env.fleets.travel.getCounters();
      assert.ok(counters.guardErrors >= 1, "guardErrors counter incremented");

      remove.remove();
    });
  });

  needsDriver("TG4 departure guard: multiple guards, first refusal wins", async () => {
    await withStore(driver, async (reopen) => {
      const shared = sharedOf();
      const env = boot(reopen(), shared);
      const { fleetId } = orderedFleet(env, "tg4");
      env.fleets.addDepartureGuard(() => ({ ok: true }));
      env.fleets.addDepartureGuard(() => ({ ok: false, reason: "SECOND_BLOCKS" }));
      env.fleets.addDepartureGuard(() => ({ ok: false, reason: "THIRD_BLOCKS" }));

      const r = env.fleets.planTravel({ fleetId, targetSystemId: S.N5, constraints: AVOID }, "tg4:plan");
      assert.deepStrictEqual([r.ok, r.reason], [false, "SECOND_BLOCKS"]);
    });
  });

  needsDriver("TG5 departure guard: not called for retreat mode", async () => {
    await withStore(driver, async (reopen) => {
      const shared = sharedOf();
      const env = boot(reopen(), shared);
      const { fleetId } = orderedFleet(env, "tg5");
      const plan = planOk(env, { fleetId, targetSystemId: S.N5, constraints: AVOID }, "tg5:plan");
      shared.clock.set(plan.arriveAt);
      await pass(env);

      let guardCalls = 0;
      env.fleets.addDepartureGuard(() => { guardCalls++; return { ok: false, reason: "SHOULD_NOT_RUN" }; });

      const retreat = env.fleets.retreat({ fleetId }, "tg5:retreat");
      assert.strictEqual(retreat.ok, true, JSON.stringify(retreat));
      assert.strictEqual(guardCalls, 0, "guards not called for retreat");
    });
  });

  needsDriver("TG6 departure guard: remove() works", async () => {
    await withStore(driver, async (reopen) => {
      const shared = sharedOf();
      const env = boot(reopen(), shared);
      const { fleetId } = orderedFleet(env, "tg6");
      const remove = env.fleets.addDepartureGuard(() => ({ ok: false, reason: "BLOCKED" }));
      assert.ok(remove.ok);
      remove.remove();

      const r = env.fleets.planTravel({ fleetId, targetSystemId: S.N5, constraints: AVOID }, "tg6:plan");
      assert.strictEqual(r.ok, true, "guard removed, departure allowed");
    });
  });

  needsDriver("TG7 RETREAT_SKIP_REASONS includes FLEET_PINNED", async () => {
    await withStore(driver, async (reopen) => {
      const shared = sharedOf();
      const env = boot(reopen(), shared);
      const { fleetId } = orderedFleet(env, "tg7");
      const plan = planOk(env, { fleetId, targetSystemId: S.N5, constraints: AVOID }, "tg7:plan");
      shared.clock.set(plan.arriveAt);
      await pass(env);

      env.fleets.addDepartureGuard(() => ({ ok: false, reason: "FLEET_PINNED" }));

      const retreat = env.fleets.retreat({ fleetId, retreatTargets: [S.N0] }, "tg7:retreat");
      const { RETREAT_SKIP_REASONS } = require("../../lib/fleets/travelService");
      assert.ok(RETREAT_SKIP_REASONS.includes("FLEET_PINNED"), "FLEET_PINNED in RETREAT_SKIP_REASONS");
    });
  });
};