"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { findServerSrcOnDisk, GAMESTORE_SEARCH_MAX_DEPTH } = require("../../lib/adapter/locator");
const { resolveSqliteDriver } = require("../../lib/adapter/sqliteDriver");
const { readStaticMapFrom } = require("../../lib/adapter/staticMap");
const { buildUniverseGraph } = require("../../lib/graph/universeGraph");
const { createRouteFinder } = require("../../lib/graph/routes");
const { startWormholes } = require("../../lib/graph/wormholes");
const { openStore } = require("../../lib/persistence/store");
const { MIGRATIONS } = require("../../lib/persistence/migrations");
const { TABLE_POLICY } = require("../../lib/persistence/worldReset");
const { seedDbFile } = require("../_support/dbTemplate");
const { createJournal } = require("../../lib/persistence/journal");
const { createManualClock } = require("../../lib/util/clock");
const { createRng } = require("../../lib/util/rng");
const { createIdGenerator } = require("../../lib/util/ids");
const { startScheduler } = require("../../lib/scheduler");
const { startFleets, createUnavailableFleets } = require("../../lib/fleets");
const { loadSecurityBand } = require("../graph/fixtures/staticMap.fixture");
const { S, rawWorld } = require("../graph/fixtures/routeMap.fixture");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const START_MS = 1760000000000;
const FACTION = 500019;
const COMPOSITION = Object.freeze([{ hullGroup: "frigate", count: 5 }, { hullGroup: "cruiser", count: 3 }]);
const WH = Object.freeze({ wormholes: true });
const A = "11@1700";
const B = "12@1700";
const LEG_V1_KEYS = ["v", "mode", "systems", "departAt", "jumpMs", "arriveAt", "graphVersion", "observed"];
const CONFIG = Object.freeze({
  enabled: true,
  modules: { scheduler: { enabled: true }, fleets: { enabled: true }, graph: { enabled: true } },
  scheduler: { maxAttempts: 5, retryBaseMs: 1000, retryMaxMs: 600000, maxOpenEvents: 50000, maxPayloadBytes: 4096,
    intervalMs: 1000, sliceMs: 4, claimBatchSize: 8, catchUpLagMs: 60000, backlogCountCap: 4096,
    chainedHeadroom: 1000 },
  limits: { maxDueEventsPerPass: 64, maxSchedulerWorkMs: 8, maxCatchUpEventsPerPass: 32, maxVirtualFleets: 50 },
  fleets: { maxCompositionEntries: 32, maxShipsPerFleet: 500, maxFleetsPerOperation: 16, maxJsonBytes: 4096,
    maxListLimit: 500, travelTimeFactor: 1, refitMs: 600000, operationMaxOverdueRounds: 12 },
  persistence: { journalMaxPayloadBytes: 8192 },
  observer: {},
  wormholes: { enabled: true, syncIntervalMs: 30000, minRemainingMs: 0, maxPairs: 1000, expiryMarginMs: 600000,
    maxClosuresPerSync: 50, syncHoldMaxMs: 120000, syncHoldRecheckMs: 5000, transitRetentionMs: 86400000,
    maxPurgePerSync: 200 },
});

function loadDriver() {
  const found = findServerSrcOnDisk(MOD_DIR, GAMESTORE_SEARCH_MAX_DEPTH, fs.existsSync);
  if (!found.ok) return { ok: false, detail: found.reason };
  return resolveSqliteDriver(found.srcDir);
}

function composedGraph() {
  const built = buildUniverseGraph(readStaticMapFrom({ ensureLoaded: () => rawWorld() }, loadSecurityBand()).map);
  const finder = createRouteFinder(built.graph, { cacheSize: 64, maxJumps: 40 });
  return Object.freeze({ ...built.graph, ...finder.publicApi });
}

const pair = (pairKey, from, to, o = {}) => Object.freeze({ pairKey, pairId: Number(pairKey.split("@")[0]),
  fromSystemId: from, toSystemId: to, active: o.active !== false, createdAt: o.createdAt || 1700,
  expiresAt: o.expiresAt || 0,
  collapseAt: o.collapseAt || 0, maxJumpMass: 0 });

async function withStore(driver, fn, maxRowsPerTransaction = 500) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lne-wt-"));
  const file = path.join(tmp, "world.sqlite");
  const open = [];
  const reopen = () => {
    seedDbFile(driver, file, { seed: 1 });
    const opened = openStore({ filePath: file, openDatabase: (f) => new driver.Database(f), exclusiveLock: true,
      busyTimeoutMs: 0, maxRowsPerTransaction, maxWriteMsPerPass: 5, randomSeed: () => 1 });
    assert.ok(opened.ok, JSON.stringify(opened));
    open.push(opened.store);
    return opened;
  };
  try {
    return await fn(reopen);
  } finally {
    for (const s of open) s.close("test_cleanup");
    try {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch (_err) {
    }
  }
}

const noTimer = () => ({ cancel() {}, hasRef: () => false });
const tick = async () => {
  for (let i = 0; i < 4; i += 1) await Promise.resolve();
};

async function boot(opened, shared, pairs, logger = null, config = CONFIG) {
  const graph = composedGraph();
  const journal = createJournal({ clock: shared.clock, maxPayloadBytes: 8192, maxRows: 500 });
  const sr = startScheduler({ config, persistence: { ok: true, store: opened.store }, clock: shared.clock,
    ids: shared.ids, nowMs: () => 0 });
  assert.ok(sr.ok, JSON.stringify(sr));
  let wormholes = null;
  const fr = startFleets({ config, persistence: { ok: true, store: opened.store, journal,
    worldSeed: opened.worldSeed }, clock: shared.clock, ids: shared.ids, scheduler: sr.scheduler,
  graph: { getGraph: () => ({ ok: true, graph }) }, getWormholes: () => wormholes, logger });
  assert.ok(fr.ok, JSON.stringify(fr));
  const wr = startWormholes({ config, clock: shared.clock, setTimer: noTimer,
    adapter: { readWormholePairs: () => ({ ok: true, version: 4, skipped: 0, pairs: pairs.list }) },
    graph: { whenReady: () => Promise.resolve({ ok: true, graph }) }, getFleets: () => fr.fleets });
  assert.ok(wr.ok, JSON.stringify(wr));
  wormholes = wr.wormholes;
  await tick();
  return { store: opened.store, scheduler: sr.scheduler, fleets: fr.fleets, wormholes, graph };
}

function sharedOf() {
  const clock = createManualClock(START_MS);
  return { clock, ids: createIdGenerator({ clock, rng: createRng(5) }) };
}

function q(store, sql, ...args) {
  const r = store.transaction("test", (db) => db.prepare(sql).all(...args));
  assert.ok(r.ok, JSON.stringify(r));
  return r.value;
}

const transitRows = (store, fleetId) => q(store, "SELECT leg_seq, edge_index, pair_key, from_system_id, to_system_id, "
  + "cross_at, expires_at, closed_at FROM world_wormhole_transits WHERE fleet_id = ? ORDER BY leg_seq, edge_index",
fleetId).map((r) => ({ ...r }));
const eventOf = (store, key) => {
  const rows = q(store, "SELECT state, outcome, due_at, last_error FROM world_scheduled_events WHERE idempotency_key = ?",
    key);
  return rows.length ? { ...rows[0] } : null;
};
const journalCount = (store, key) => q(store, "SELECT count(*) AS n FROM world_event_journal WHERE "
  + "idempotency_key = ?", key)[0].n;
const totals = (store) => ({
  journal: q(store, "SELECT count(*) AS n FROM world_event_journal")[0].n,
  events: q(store, "SELECT count(*) AS n FROM world_scheduled_events")[0].n,
  transits: q(store, "SELECT count(*) AS n FROM world_wormhole_transits")[0].n,
});

function fleetOf(env, fleetId) {
  const r = env.fleets.getFleet(fleetId);
  assert.ok(r.ok, JSON.stringify(r));
  return r.fleet;
}

function orderedFleet(env, tag, from, target) {
  const created = env.fleets.createFleet({ factionId: FACTION, currentSystemId: from, homeSystemId: from,
    fleetRole: "invasion", composition: COMPOSITION }, `${tag}:create`);
  assert.ok(created.ok, JSON.stringify(created));
  const op = env.fleets.createOperation({ operationType: "invasion", factionId: FACTION, originSystemId: from,
    targetSystemId: target, objective: "capture", fleets: [{ fleetId: created.fleetId, expectedVersion: 1 }] },
  `${tag}:op`);
  assert.ok(op.ok, JSON.stringify(op));
  return created.fleetId;
}

function planOk(env, input, key) {
  const r = env.fleets.planTravel(input, key);
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  return r;
}

async function pass(env) {
  const r = await env.scheduler.runPass();
  assert.ok(r.ok, JSON.stringify(r));
  return r;
}

function syncOk(env) {
  const r = env.wormholes.syncNow();
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  return r;
}

module.exports = ({ test, skip }) => {
  const driver = loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  needsDriver("WT1 plan: leg v2 + transit rows, WORMHOLE_CLOSES_EN_ROUTE writes nothing, no flag = leg v1 "
    + "facade + migration 33 + WIPE", async () => {
    const migration = MIGRATIONS.find((m) => m.version === 33);
    assert.deepStrictEqual([migration && migration.name, TABLE_POLICY.world_wormhole_transits],
      ["world_wormhole_transits", "WIPE"]);
    for (const facade of [createUnavailableFleets("FLEETS_DISABLED")]) {
      assert.strictEqual(facade.closeWormholeTransits([], { now: 1 }).reason, "FLEETS_DISABLED");
    }
    await withStore(driver, async (reopen) => {
      const shared = sharedOf();
      const pairs = { list: [pair(A, S.N0, S.N9)] };
      const env = await boot(reopen(), shared, pairs);
      for (const name of ["listOpenWormholeTransitPairs", "closeWormholeTransits"]) {
        assert.strictEqual(typeof env.fleets[name], "function", `real ctx.fleets.${name}`);
      }
      syncOk(env);

      const plain = orderedFleet(env, "wt1:v1", S.N0, S.N10);
      planOk(env, { fleetId: plain, targetSystemId: S.N10 }, "wt1:v1:plan");
      const v1 = fleetOf(env, plain).route;
      assert.deepStrictEqual([Object.keys(v1).sort(), v1.v, v1.systems],
        [[...LEG_V1_KEYS].sort(), 1, [S.N0, S.H1, S.N9, S.N10]]);
      assert.strictEqual(totals(env.store).transits, 0);

      const fleetId = orderedFleet(env, "wt1:v2", S.N0, S.N10);
      const plan = planOk(env, { fleetId, targetSystemId: S.N10, constraints: WH }, "wt1:v2:plan");
      const v2 = fleetOf(env, fleetId).route;
      assert.deepStrictEqual([Object.keys(v2).sort(), v2.v, v2.systems, v2.constraints, v2.wormholeEdges],
        [[...LEG_V1_KEYS, "constraints", "wormholeEdges"].sort(), 2, [S.N0, S.N9, S.N10], { wormholes: true },
          [{ i: 0, pairKey: A, expiresAt: 0 }]]);
      assert.deepStrictEqual(transitRows(env.store, fleetId), [{ leg_seq: 1, edge_index: 0, pair_key: A,
        from_system_id: S.N0, to_system_id: S.N9, cross_at: plan.departAt + plan.jumpMs, expires_at: 0,
        closed_at: null }]);
      assert.deepStrictEqual({ ...env.fleets.listOpenWormholeTransitPairs({ now: shared.clock.now(), limit: 10 }) },
        { ok: true, pairKeys: [A] });

      pairs.list = [pair(B, S.N0, S.N9, { expiresAt: shared.clock.now() + plan.jumpMs + 1000 })];
      syncOk(env);
      const late = orderedFleet(env, "wt1:late", S.N0, S.N10);
      const before = { ...totals(env.store), version: fleetOf(env, late).version };
      const refused = env.fleets.planTravel({ fleetId: late, targetSystemId: S.N10, constraints: WH }, "wt1:late:plan");
      assert.deepStrictEqual([refused.ok, refused.reason, refused.pairKey, refused.i],
        [false, "WORMHOLE_CLOSES_EN_ROUTE", B, 0]);
      assert.deepStrictEqual({ ...totals(env.store), version: fleetOf(env, late).version }, before, "nothing written");
      assert.strictEqual(fleetOf(env, late).state, "PLANNED");
      env.wormholes.stop();
    });
  });

  needsDriver("WT2 closure on the way -> replan through the second pair, one arrival, old arrival STALE",
    async () => {
      await withStore(driver, async (reopen) => {
        const shared = sharedOf();
        const pairs = { list: [pair(A, S.N0, S.ISO), pair(B, S.N0, S.ISO)] };
        const env = await boot(reopen(), shared, pairs);
        syncOk(env);
        const fleetId = orderedFleet(env, "wt2", S.H1, S.ISO);
        const plan = planOk(env, { fleetId, targetSystemId: S.ISO, constraints: WH }, "wt2:plan");
        assert.deepStrictEqual(fleetOf(env, fleetId).route.wormholeEdges, [{ i: 1, pairKey: A, expiresAt: 0 }]);
        const closedAt = plan.departAt + Math.floor(1.5 * plan.jumpMs);
        shared.clock.set(closedAt);
        pairs.list = [pair(B, S.N0, S.ISO)];
        const synced = syncOk(env);
        assert.deepStrictEqual([synced.closures, synced.deferred], [1, 0]);
        const expireKey = `wh:expire:${A}:${fleetId}:1`;
        assert.deepStrictEqual([eventOf(env.store, expireKey).state, eventOf(env.store, expireKey).due_at],
          ["QUEUED", closedAt]);
        await pass(env);
        assert.strictEqual(eventOf(env.store, expireKey).outcome, "REPLANNED");
        const f = fleetOf(env, fleetId);
        assert.deepStrictEqual([f.state, f.legSeq, f.currentSystemId, f.route.systems, f.route.departAt,
          f.route.constraints, f.route.wormholeEdges.map((e) => e.pairKey)],
        ["TRAVELLING", 2, S.N0, [S.N0, S.ISO], closedAt, { wormholes: true }, [B]]);
        shared.clock.set(Math.max(plan.arriveAt, f.route.arriveAt));
        await pass(env);
        await pass(env);
        const done = fleetOf(env, fleetId);
        assert.deepStrictEqual([done.state, done.currentSystemId], ["STAGED", S.ISO]);
        assert.strictEqual(eventOf(env.store, `arrival:${fleetId}:1`).outcome, "STALE");
        assert.strictEqual(eventOf(env.store, `arrival:${fleetId}:2`).outcome, "ARRIVED");
        assert.deepStrictEqual([journalCount(env.store, `arrival:${fleetId}:1`),
          journalCount(env.store, `arrival:${fleetId}:2`)], [0, 1], "exactly one arrival");
        assert.strictEqual(fleetOf(env, fleetId).route, null);
        assert.strictEqual(env.fleets.getStatus().travel.counters.wormholeReplanned, 1);
        env.wormholes.stop();
      });
    });

  needsDriver("WT3 closure on the way without an alternative -> cut off in the system of the closure "
    + "never through the closed edge", async () => {
    await withStore(driver, async (reopen) => {
      const shared = sharedOf();
      const pairs = { list: [pair(A, S.N0, S.ISO)] };
      const env = await boot(reopen(), shared, pairs);
      syncOk(env);
      const fleetId = orderedFleet(env, "wt3", S.H1, S.ISO);
      const plan = planOk(env, { fleetId, targetSystemId: S.ISO, constraints: WH }, "wt3:plan");
      const closedAt = plan.departAt + Math.floor(1.5 * plan.jumpMs);
      shared.clock.set(closedAt);
      pairs.list = [];
      assert.strictEqual(syncOk(env).closures, 1);
      await pass(env);
      assert.strictEqual(eventOf(env.store, `wh:expire:${A}:${fleetId}:1`).outcome, "ROUTE_BROKEN_HALTED");
      const f = fleetOf(env, fleetId);
      assert.deepStrictEqual([f.state, f.currentSystemId, f.legSeq, f.route], ["STAGED", S.N0, 1, null],
        "cut off in N0 (the system of the closure), never ISO");
      assert.strictEqual(journalCount(env.store, `arrival:${fleetId}:1`), 1, "one halt under the arrival key");
      shared.clock.set(plan.arriveAt + 1);
      await pass(env);
      assert.strictEqual(eventOf(env.store, `arrival:${fleetId}:1`).outcome, "STALE", "no arrival at the target");
      assert.strictEqual(fleetOf(env, fleetId).currentSystemId, S.N0);
      assert.strictEqual(env.fleets.getStatus().travel.counters.wormholeHalted, 1);
      env.wormholes.stop();
    });
  });

  needsDriver("WT4 restart: closure found from the transit table, arrival held until the first sync "
    + "Refused open keeps the pair", async () => {
    await withStore(driver, async (reopen) => {
      const shared = sharedOf();
      const pairs = { list: [pair(A, S.N0, S.ISO)] };
      let opened = reopen();
      let env = await boot(opened, shared, pairs);
      syncOk(env);
      const fleetId = orderedFleet(env, "wt4", S.H1, S.ISO);
      const plan = planOk(env, { fleetId, targetSystemId: S.ISO, constraints: WH }, "wt4:plan");
      env.wormholes.stop();
      const collapseAt = plan.departAt + Math.floor(1.5 * plan.jumpMs);
      pairs.list = [pair(A, S.N0, S.ISO, { active: false, collapseAt })];
      shared.clock.set(plan.arriveAt + 1000);
      opened.store.close("restart");
      opened = reopen();
      env = await boot(opened, shared, pairs);
      assert.strictEqual(env.wormholes.isSynced(), false);
      await pass(env);
      const held = eventOf(env.store, `arrival:${fleetId}:1`);
      assert.deepStrictEqual([held.state, /WORMHOLE_SYNC_PENDING/.test(held.last_error)], ["RETRY", true]);
      assert.strictEqual(fleetOf(env, fleetId).state, "TRAVELLING");
      assert.strictEqual(env.fleets.getStatus().travel.counters.wormholeSyncHeld, 1);
      const synced = syncOk(env);
      assert.deepStrictEqual([synced.edges, synced.closures], [0, 1]);
      assert.strictEqual(eventOf(env.store, `wh:expire:${A}:${fleetId}:1`).due_at, collapseAt);
      shared.clock.advance(5000);
      await pass(env);
      await pass(env);
      const f = fleetOf(env, fleetId);
      assert.deepStrictEqual([f.state, f.currentSystemId], ["STAGED", S.N0]);
      assert.deepStrictEqual([eventOf(env.store, `wh:expire:${A}:${fleetId}:1`).outcome,
        eventOf(env.store, `arrival:${fleetId}:1`).outcome].sort(), ["ROUTE_BROKEN_HALTED", "STALE"]);
      assert.strictEqual(journalCount(env.store, `arrival:${fleetId}:1`), 1, "one halt");
      assert.strictEqual(transitRows(env.store, fleetId)[0].closed_at, collapseAt);
      env.wormholes.stop();

      const graph = composedGraph();
      let refuseOpen = false;
      const target = Object.freeze({ ...graph, updateWormholeEdge: (id, st) => {
        if (refuseOpen && st.status === "open") return { ok: false, reason: "INVALID_ARGUMENT" };
        return graph.updateWormholeEdge(id, st);
      } });
      const list = { list: [pair(B, S.N5, S.N10, { expiresAt: START_MS + 9e7 })] };
      const wr = startWormholes({ config: CONFIG, clock: shared.clock, setTimer: noTimer,
        adapter: { readWormholePairs: () => ({ ok: true, version: 4, skipped: 0, pairs: list.list }) },
        graph: { whenReady: () => Promise.resolve({ ok: true, graph: target }) } });
      await tick();
      assert.strictEqual(wr.wormholes.syncNow().edges, 1);
      refuseOpen = true;
      list.list = [pair(B, S.N5, S.N10, { expiresAt: START_MS + 9e7 + 1 })];
      assert.deepStrictEqual([wr.wormholes.syncNow().refused, wr.wormholes.getStatus().edges], [1, 1]);
      list.list = [];
      assert.strictEqual(wr.wormholes.syncNow().closed, 1);
      assert.strictEqual(graph.validateRoute([S.N5, S.N10]).reason, "BROKEN_EDGE", "closed edge left the overlay");
      wr.wormholes.stop();
    });
  });

  needsDriver("WT5 closure after the crossing -> no cut, normal arrival (crossed edge not validated)",
    async () => {
      await withStore(driver, async (reopen) => {
        const shared = sharedOf();
        const pairs = { list: [pair(A, S.N0, S.N9)] };
        const env = await boot(reopen(), shared, pairs);
        syncOk(env);
        const fleetId = orderedFleet(env, "wt5", S.N0, S.N10);
        const plan = planOk(env, { fleetId, targetSystemId: S.N10, constraints: WH }, "wt5:plan");
        assert.strictEqual(plan.jumps, 2);
        shared.clock.set(plan.departAt + Math.floor(1.5 * plan.jumpMs));
        pairs.list = [];
        const synced = syncOk(env);
        assert.deepStrictEqual([synced.closures, eventOf(env.store, `wh:expire:${A}:${fleetId}:1`)], [1, null],
          "no leg crosses A after the closure: no WORMHOLE_EXPIRE");
        assert.strictEqual(env.graph.validateRoute([S.N0, S.N9, S.N10]).reason, "BROKEN_EDGE");
        shared.clock.set(plan.arriveAt);
        await pass(env);
        const f = fleetOf(env, fleetId);
        assert.deepStrictEqual([f.state, f.currentSystemId, f.legSeq], ["STAGED", S.N10, 1]);
        assert.strictEqual(eventOf(env.store, `arrival:${fleetId}:1`).outcome, "ARRIVED");
        env.wormholes.stop();
      });
    });

  needsDriver("A2 hold = scheduler deferral: maxAttempts + 1 holds keep attempts 0, no hold after "
    + "syncHoldMaxMs; isSynced only after a sync without deferred closures", async () => {
    const attemptsOf = (store, key) => q(store, "SELECT attempts FROM world_scheduled_events WHERE idempotency_key = ?",
      key)[0].attempts;
    await withStore(driver, async (reopen) => {
      const shared = sharedOf();
      const pairs = { list: [pair(A, S.N0, S.ISO)] };
      let opened = reopen();
      let env = await boot(opened, shared, pairs);
      syncOk(env);
      const fleetId = orderedFleet(env, "a2a", S.H1, S.ISO);
      const plan = planOk(env, { fleetId, targetSystemId: S.ISO, constraints: WH }, "a2a:plan");
      env.wormholes.stop();
      shared.clock.set(plan.arriveAt + 1000);
      opened.store.close("restart");
      opened = reopen();
      env = await boot(opened, shared, pairs);
      const bootAt = shared.clock.now();
      const key = `arrival:${fleetId}:1`;
      const holds = [];
      for (let k = 0; k < CONFIG.scheduler.maxAttempts + 1; k += 1) {
        await pass(env);
        const ev = eventOf(env.store, key);
        holds.push([ev.state, attemptsOf(env.store, key), ev.due_at - shared.clock.now(), ev.last_error]);
        shared.clock.set(ev.due_at);
      }
      const held = ["RETRY", 0, CONFIG.wormholes.syncHoldRecheckMs, "WORMHOLE_SYNC_PENDING"];
      assert.deepStrictEqual(holds, Array.from({ length: CONFIG.scheduler.maxAttempts + 1 }, () => held));
      assert.strictEqual(env.fleets.getStatus().travel.counters.wormholeSyncHeld, CONFIG.scheduler.maxAttempts + 1);
      shared.clock.set(bootAt + CONFIG.wormholes.syncHoldMaxMs);
      await pass(env);
      assert.deepStrictEqual([eventOf(env.store, key).state, env.fleets.getStatus().travel.counters.wormholeSyncHeld],
        ["DONE", CONFIG.scheduler.maxAttempts + 1]);
      env.wormholes.stop();
    });

    await withStore(driver, async (reopen) => {
      const shared = sharedOf();
      const C = "13@1700";
      const config = { ...CONFIG, wormholes: { ...CONFIG.wormholes, maxClosuresPerSync: 1 } };
      const pairs = { list: [pair(A, S.N0, S.ISO), pair(C, S.N0, S.N9)] };
      let opened = reopen();
      let env = await boot(opened, shared, pairs, null, config);
      syncOk(env);
      const other = orderedFleet(env, "a2b:a", S.H1, S.ISO);
      planOk(env, { fleetId: other, targetSystemId: S.ISO, constraints: WH }, "a2b:a:plan");
      const fleetId = orderedFleet(env, "a2b:c", S.N0, S.N10);
      const plan = planOk(env, { fleetId, targetSystemId: S.N10, constraints: WH }, "a2b:c:plan");
      assert.deepStrictEqual(fleetOf(env, fleetId).route.wormholeEdges.map((e) => e.pairKey), [C]);
      env.wormholes.stop();
      const collapseAt = plan.departAt + Math.floor(plan.jumpMs / 2);
      pairs.list = [pair(A, S.N0, S.ISO, { active: false, collapseAt }), pair(C, S.N0, S.N9, { active: false,
        collapseAt })];
      shared.clock.set(plan.arriveAt + 1000);
      opened.store.close("restart");
      opened = reopen();
      env = await boot(opened, shared, pairs, null, config);
      const key = `arrival:${fleetId}:1`;
      await pass(env);
      assert.strictEqual(eventOf(env.store, key).last_error, "WORMHOLE_SYNC_PENDING");
      const first = syncOk(env);
      assert.deepStrictEqual([first.closures, first.deferred, env.wormholes.isSynced()], [1, 1, false],
        "A closed, C deferred: not synced");
      shared.clock.advance(CONFIG.wormholes.syncHoldRecheckMs);
      await pass(env);
      const still = eventOf(env.store, key);
      assert.deepStrictEqual([still.state, still.last_error, attemptsOf(env.store, key), fleetOf(env, fleetId).state],
        ["RETRY", "WORMHOLE_SYNC_PENDING", 0, "TRAVELLING"], "still held while C is not closed");
      const second = syncOk(env);
      assert.deepStrictEqual([second.closures, second.deferred, env.wormholes.isSynced()], [1, 0, true]);
      shared.clock.advance(CONFIG.wormholes.syncHoldRecheckMs);
      await pass(env);
      await pass(env);
      const f = fleetOf(env, fleetId);
      assert.deepStrictEqual([f.state, f.legSeq, f.currentSystemId, f.route.systems, f.route.departAt],
        ["TRAVELLING", 2, S.N0, [S.N0, S.H1, S.N9, S.N10], collapseAt], "cut by C in N0, replanned over gates");
      assert.notStrictEqual(eventOf(env.store, key).outcome, "ARRIVED", "never through C");
      env.wormholes.stop();
    });
  });

  needsDriver("A4 WORMHOLE_NOT_YET_OPEN: a plan crossing a pair before its createdAt writes nothing; a replan "
    + "after a cut in the past through a newer pair halts", async () => {
    await withStore(driver, async (reopen) => {
      const shared = sharedOf();
      const pairs = { list: [pair(B, S.N0, S.N9, { createdAt: START_MS + 1e9 })] };
      const env = await boot(reopen(), shared, pairs);
      syncOk(env);
      const early = orderedFleet(env, "a4:early", S.N0, S.N10);
      const before = { ...totals(env.store), version: fleetOf(env, early).version };
      const refused = env.fleets.planTravel({ fleetId: early, targetSystemId: S.N10, constraints: WH },
        "a4:early:plan");
      assert.deepStrictEqual([refused.ok, refused.reason, refused.pairKey, refused.i],
        [false, "WORMHOLE_NOT_YET_OPEN", B, 0]);
      assert.deepStrictEqual({ ...totals(env.store), version: fleetOf(env, early).version }, before, "nothing written");
      assert.strictEqual(fleetOf(env, early).state, "PLANNED");

      pairs.list = [pair(A, S.N0, S.ISO)];
      syncOk(env);
      const fleetId = orderedFleet(env, "a4:cut", S.H1, S.ISO);
      const plan = planOk(env, { fleetId, targetSystemId: S.ISO, constraints: WH }, "a4:cut:plan");
      const collapseAt = plan.departAt + Math.floor(1.5 * plan.jumpMs);
      shared.clock.set(collapseAt + 3 * plan.jumpMs);
      pairs.list = [pair(A, S.N0, S.ISO, { active: false, collapseAt }),
        pair(B, S.N0, S.ISO, { createdAt: collapseAt + 2 * plan.jumpMs })];
      assert.strictEqual(syncOk(env).closures, 1);
      assert.strictEqual(env.graph.findRoute(S.N0, S.ISO, WH).ok, true, "B is routable now");
      await pass(env);
      await pass(env);
      const f = fleetOf(env, fleetId);
      assert.deepStrictEqual([f.state, f.currentSystemId, f.legSeq, f.route], ["STAGED", S.N0, 1, null],
        "halted in the system of the cut, never through B");
      assert.deepStrictEqual([journalCount(env.store, `arrival:${fleetId}:1`),
        journalCount(env.store, `arrival:${fleetId}:1:replan`)], [1, 0]);
      const c = env.fleets.getStatus().travel.counters;
      assert.deepStrictEqual([c.wormholeHalted, c.wormholeReplanned || 0], [1, 0]);
      env.wormholes.stop();
    });
  });

  needsDriver("WT6: a pair over the row limit closes in portions across syncs, only legs in flight "
    + "one log at the first deferral", async () => {
    await withStore(driver, async (reopen) => {
      const shared = sharedOf();
      const pairs = { list: [pair(A, S.N0, S.ISO)] };
      const lines = [];
      const env = await boot(reopen(), shared, pairs, { log: (line) => lines.push(String(line)) });
      syncOk(env);
      const done = orderedFleet(env, "wt6:done", S.N0, S.ISO);
      const donePlan = planOk(env, { fleetId: done, targetSystemId: S.ISO, constraints: WH }, "wt6:done:plan");
      shared.clock.set(donePlan.arriveAt);
      await pass(env);
      assert.deepStrictEqual([fleetOf(env, done).state, fleetOf(env, done).currentSystemId], ["STAGED", S.ISO]);
      const flying = [];
      let plan = null;
      for (let k = 0; k < 24; k += 1) {
        const fleetId = orderedFleet(env, `wt6:${k}`, S.H1, S.ISO);
        plan = planOk(env, { fleetId, targetSystemId: S.ISO, constraints: WH }, `wt6:${k}:plan`);
        flying.push(fleetId);
      }
      const closedAt = plan.departAt + Math.floor(1.5 * plan.jumpMs);
      shared.clock.set(closedAt);
      pairs.list = [];
      const first = syncOk(env);
      assert.deepStrictEqual([first.closures, first.deferred, first.partial], [0, 1, 1], "portion 1: not closed yet");
      const closedRows = () => q(env.store, "SELECT count(*) AS n FROM world_wormhole_transits WHERE pair_key = ? "
        + "AND closed_at IS NOT NULL", A)[0].n;
      assert.strictEqual(closedRows(), 20, "portion 1: 20 legs x (1 row + 1 WORMHOLE_EXPIRE) = 40 rows");
      assert.strictEqual(lines.filter((l) => l.includes(A)).length, 1, "one log at the first deferral");
      shared.clock.advance(1000);
      const second = syncOk(env);
      assert.deepStrictEqual([second.closures, second.deferred], [1, 0], "portion 2: closed");
      assert.strictEqual(lines.filter((l) => l.includes(A)).length, 1, "no second log");
      for (const fleetId of flying) {
        assert.deepStrictEqual(transitRows(env.store, fleetId).map((r) => r.closed_at), [closedAt]);
        const ev = eventOf(env.store, `wh:expire:${A}:${fleetId}:1`);
        assert.deepStrictEqual([ev && ev.state, ev && ev.due_at], ["QUEUED", closedAt], fleetId);
      }
      assert.deepStrictEqual(transitRows(env.store, done).map((r) => r.closed_at), [null], "finished leg untouched");
      assert.deepStrictEqual({ ...env.fleets.listOpenWormholeTransitPairs({ now: shared.clock.now(), limit: 10 }) },
        { ok: true, pairKeys: [] });
      assert.strictEqual(syncOk(env).deferred, 0);
      env.wormholes.stop();
    }, 40);

    await withStore(driver, async (reopen) => {
      const shared = sharedOf();
      const C = "13@1700";
      const pairs = { list: [pair(C, S.N0, S.N9)] };
      const env = await boot(reopen(), shared, pairs);
      syncOk(env);
      const fly = (tag) => {
        const fleetId = orderedFleet(env, tag, S.N0, S.N10);
        return { fleetId, plan: planOk(env, { fleetId, targetSystemId: S.N10, constraints: WH }, `${tag}:plan`) };
      };
      const early = [];
      for (let k = 0; k < 4; k += 1) early.push(fly(`a5:before:${k}`));
      const { jumpMs, departAt } = early[0].plan;
      shared.clock.set(departAt + Math.floor(0.75 * jumpMs));
      const late = [];
      for (let k = 0; k < 20; k += 1) late.push(fly(`a5:after:${k}`));
      const closedAt = departAt + Math.floor(1.5 * jumpMs);
      shared.clock.set(closedAt);
      const crossings = (list) => list.map((x) => transitRows(env.store, x.fleetId)[0].cross_at < closedAt);
      assert.deepStrictEqual([crossings(early), crossings(late)], [early.map(() => true), late.map(() => false)]);
      assert.ok(early.every((x) => x.plan.arriveAt > closedAt), "legs before are still in flight");
      pairs.list = [];
      const first = syncOk(env);
      assert.deepStrictEqual([first.closures, first.deferred, first.partial], [0, 1, 1]);
      const after1 = late.map((x) => {
        const ev = eventOf(env.store, `wh:expire:${C}:${x.fleetId}:1`);
        return [transitRows(env.store, x.fleetId)[0].closed_at, ev && ev.state];
      });
      assert.deepStrictEqual(after1, late.map(() => [closedAt, "QUEUED"]), "portion 1 = every leg crossing later");
      assert.deepStrictEqual(early.map((x) => transitRows(env.store, x.fleetId)[0].closed_at), early.map(() => null));
      shared.clock.advance(1000);
      assert.deepStrictEqual([syncOk(env).closures], [1]);
      assert.deepStrictEqual(early.map((x) => [transitRows(env.store, x.fleetId)[0].closed_at,
        eventOf(env.store, `wh:expire:${C}:${x.fleetId}:1`)]), early.map(() => [closedAt, null]));
      env.wormholes.stop();
    }, 40);
  });
};
