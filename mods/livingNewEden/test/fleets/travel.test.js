"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");

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
const { HULL_GROUPS } = require("../../lib/fleets/schema");
const { HULL_TRAVEL } = require("../../lib/fleets/data/travelProfiles");
const { jumpMsForComposition, positionAt } = require("../../lib/fleets/travel");
const { loadSecurityBand } = require("../graph/fixtures/staticMap.fixture");
const { S, OUTSIDE, rawWorld } = require("../graph/fixtures/routeMap.fixture");

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
    galaxyFleetsRefreshMs: 5000,
    galaxyInvasionsEnabled: true, galaxyInvasionsMaxSystems: 1000, galaxyInvasionsMaxLines: 6, galaxyInvasionsRefreshMs: 60000 },
});

function loadDriver() {
  const found = findServerSrcOnDisk(MOD_DIR, GAMESTORE_SEARCH_MAX_DEPTH, fs.existsSync);
  if (!found.ok) return { ok: false, detail: found.reason };
  return resolveSqliteDriver(found.srcDir);
}

function fixtureGraph() {
  const read = readStaticMapFrom({ ensureLoaded: () => rawWorld() }, loadSecurityBand());
  assert.strictEqual(read.ok, true, JSON.stringify(read));
  const built = buildUniverseGraph(read.map);
  assert.strictEqual(built.ok, true);
  const finder = createRouteFinder(built.graph, { cacheSize: 64, maxJumps: 40 });
  return { graph: Object.freeze({ ...built.graph, ...finder.publicApi }), finder };
}

async function withStore(driver, fn, { fresh = false } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lne-v-"));
  const file = path.join(tmp, "world.sqlite");
  const open = [];
  const reopen = () => {
    if (!fresh) seedDbFile(driver, file, { seed: 1 });
    const opened = openStore({ filePath: file, openDatabase: (f) => new driver.Database(f), exclusiveLock: true,
      busyTimeoutMs: 0, maxRowsPerTransaction: 500, maxWriteMsPerPass: 5, randomSeed: () => 1 });
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

function boot(opened, shared, extra = {}) {
  const config = extra.config || CONFIG;
  const journal = createJournal({ clock: shared.clock, maxPayloadBytes: 8192, maxRows: 500 });
  const sr = startScheduler({ config, persistence: { ok: true, store: opened.store }, clock: shared.clock,
    ids: shared.ids, nowMs: () => 0 });
  assert.ok(sr.ok, JSON.stringify(sr));
  const views = createViewRegistry();
  const graph = extra.graph || shared.graph;
  const fr = startFleets({ config, persistence: { ok: true, store: opened.store, journal, worldSeed: opened.worldSeed },
    clock: shared.clock, ids: shared.ids, scheduler: sr.scheduler, graph: { getGraph: () => ({ ok: true, graph }) },
    presence: extra.presence || null, views, getGovernor: extra.getGovernor });
  assert.ok(fr.ok, JSON.stringify(fr));
  return { store: opened.store, scheduler: sr.scheduler, fleets: fr.fleets, views };
}

function sharedOf(opts = {}) {
  const clock = createManualClock(START_MS, opts.timeScale ? { timeScale: opts.timeScale } : {});
  return { clock, ids: createIdGenerator({ clock, rng: createRng(5) }), graph: fixtureGraph().graph };
}

function q(store, sql, ...args) {
  const r = store.transaction("test", (db) => db.prepare(sql).all(...args));
  assert.ok(r.ok, JSON.stringify(r));
  return r.value;
}

const n = (store, sql, ...args) => q(store, sql, ...args)[0].n;
const journalCount = (store, key) => n(store, "SELECT count(*) AS n FROM world_event_journal WHERE idempotency_key = ?",
  key);
const totals = (store) => ({
  journal: n(store, "SELECT count(*) AS n FROM world_event_journal"),
  events: n(store, "SELECT count(*) AS n FROM world_scheduled_events"),
});
const eventOf = (store, key) => q(store, "SELECT state, outcome, attempts, due_at FROM world_scheduled_events "
  + "WHERE idempotency_key = ?", key)[0];

function fleetOf(env, fleetId) {
  const r = env.fleets.getFleet(fleetId);
  assert.ok(r.ok, JSON.stringify(r));
  return r.fleet;
}

function orderedFleet(env, tag, opts = {}) {
  const created = env.fleets.createFleet({ factionId: FACTION, currentSystemId: opts.from || S.N0,
    homeSystemId: opts.home === undefined ? S.N0 : opts.home, fleetRole: "invasion",
    composition: opts.composition || COMPOSITION }, `${tag}:create`);
  assert.ok(created.ok, JSON.stringify(created));
  const op = env.fleets.createOperation({ operationType: "invasion", factionId: FACTION, originSystemId: S.N0,
    targetSystemId: S.N9, objective: "capture", ...(opts.dueAt === undefined ? {} : { dueAt: opts.dueAt }),
    fleets: [{ fleetId: created.fleetId, expectedVersion: 1 }] }, `${tag}:op`);
  assert.ok(op.ok, JSON.stringify(op));
  return { fleetId: created.fleetId, operationId: op.operationId };
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

function configWith(over) {
  const cfg = JSON.parse(JSON.stringify(CONFIG));
  for (const [section, values] of Object.entries(over)) Object.assign(cfg[section], values);
  return cfg;
}

function twoFleetOperation(env, shared, tag) {
  const [p, qf] = ["p", "q"].map((t) => {
    const r = env.fleets.createFleet({ factionId: FACTION, currentSystemId: S.N0, homeSystemId: S.N0,
      fleetRole: "invasion", composition: COMPOSITION }, `${tag}:${t}`);
    assert.ok(r.ok, JSON.stringify(r));
    return r.fleetId;
  });
  const op = env.fleets.createOperation({ operationType: "invasion", factionId: FACTION, originSystemId: S.N0,
    targetSystemId: S.N9, objective: "capture", dueAt: shared.clock.now() + 1000,
    fleets: [p, qf].map((fleetId) => ({ fleetId, expectedVersion: 1 })) }, `${tag}:op`);
  assert.ok(op.ok, JSON.stringify(op));
  const pp = planOk(env, { fleetId: p, targetSystemId: S.N5 }, `${tag}:p:plan`);
  const qq = planOk(env, { fleetId: qf, targetSystemId: S.N9, constraints: AVOID }, `${tag}:q:plan`);
  return { p, qf, operationId: op.operationId, pp, qq };
}

const lastErrorOf = (store, key) => q(store, "SELECT last_error AS e FROM world_scheduled_events WHERE "
  + "idempotency_key = ?", key)[0].e;

function listJs(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listJs(full));
    else if (entry.name.endsWith(".js")) out.push(full);
  }
  return out;
}

module.exports = ({ test, skip, bench }) => {
  const driver = loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  needsDriver("V1 travel: one arrival after the trip, positionAt from time without writes, O(1) writes per trip",
    async () => {
      const covered = HULL_GROUPS.filter((g) => !Object.prototype.hasOwnProperty.call(HULL_TRAVEL, g));
      assert.deepStrictEqual(covered, [], "travel profiles cover HULL_GROUPS");
      for (const file of listJs(path.join(MOD_DIR, "lib", "fleets"))) {
        const source = fs.readFileSync(file, "utf8");
        assert.ok(!/\bset(Interval|Timeout)\s*\(/.test(source), `${file}: no timer in lib/fleets`);
      }
      await withStore(driver, async (reopen) => {
        const shared = sharedOf();
        const env = boot(reopen(), shared);
        const trip = async (tag, target, constraints) => {
          const a = orderedFleet(env, tag);
          const before = { ...totals(env.store), version: fleetOf(env, a.fleetId).version };
          const plan = planOk(env, { fleetId: a.fleetId, targetSystemId: target,
            ...(constraints ? { constraints } : {}) }, `${tag}:plan`);
          shared.clock.set(plan.arriveAt - 1);
          assert.strictEqual((await pass(env)).done, 0, "nothing before arriveAt");
          assert.strictEqual(fleetOf(env, a.fleetId).state, "TRAVELLING");
          shared.clock.set(plan.arriveAt);
          assert.strictEqual((await pass(env)).done, 1);
          const after = { ...totals(env.store), version: fleetOf(env, a.fleetId).version };
          return { a, plan, delta: { journal: after.journal - before.journal, events: after.events - before.events,
            version: after.version - before.version } };
        };

        const long = orderedFleet(env, "v1:pos");
        const plan = planOk(env, { fleetId: long.fleetId, targetSystemId: S.N9, constraints: AVOID }, "v1:pos:plan");
        assert.deepStrictEqual([plan.jumps, plan.legSeq, plan.duplicate], [4, 1, false]);
        const flying = fleetOf(env, long.fleetId);
        assert.deepStrictEqual(flying.route.systems, [S.N0, S.N5, S.N6, S.N7, S.N9]);
        assert.strictEqual(flying.nextActionAt, plan.arriveAt);
        const quiet = totals(env.store);
        const mid = positionAt(flying, plan.departAt + 2.5 * plan.jumpMs);
        assert.deepStrictEqual([mid.inFlight, mid.index, mid.systemId, mid.nextSystemId], [true, 2, S.N6, S.N7]);
        const read = env.fleets.getPosition(long.fleetId, plan.departAt + Math.floor(2.5 * plan.jumpMs));
        assert.strictEqual(read.position.systemId, S.N6);
        assert.deepStrictEqual(totals(env.store), quiet, "positionAt / getPosition write nothing");

        shared.clock.set(plan.arriveAt);
        assert.strictEqual((await pass(env)).done, 1);
        const staged = fleetOf(env, long.fleetId);
        assert.deepStrictEqual([staged.state, staged.currentSystemId, staged.route, staged.nextActionAt],
          ["STAGED", S.N9, null, null]);
        assert.strictEqual(journalCount(env.store, `arrival:${long.fleetId}:1`), 1);
        assert.strictEqual((await pass(env)).done, 0, "a second pass does nothing");
        const again = env.scheduler.enqueue("FLEET_ARRIVAL", long.fleetId, plan.arriveAt,
          { fleetId: long.fleetId, legSeq: 1 }, `arrival:${long.fleetId}:1`);
        assert.strictEqual(again.duplicate, true);
        assert.strictEqual(eventOf(env.store, `arrival:${long.fleetId}:1`).outcome, "ARRIVED");

        const one = await trip("v1:one", S.N5);
        const four = await trip("v1:four", S.N9, AVOID);
        assert.deepStrictEqual([one.plan.jumps, four.plan.jumps], [1, 4]);
        assert.deepStrictEqual(one.delta, four.delta, "writes per trip do not depend on the number of jumps");
        assert.strictEqual(fleetOf(env, four.a.fleetId).currentSystemId, S.N9);
      });
    });

  needsDriver("V2 travel restart mid-flight and with a claimed arrival", () => restartPhases(["mid", "claimed"]));
  bench("V2 full travel restart in every phase: before departure, mid-flight, due before the pass, claimed",
    () => restartPhases(["before", "mid", "due", "claimed"]));

  async function restartPhases(phases) {
    for (const phase of phases) {
      await withStore(driver, async (reopen) => {
        const shared = sharedOf();
        let opened = reopen();
        let env = boot(opened, shared);
        const restart = () => {
          opened.store.close("restart");
          opened = reopen();
          env = boot(opened, shared);
        };
        const a = orderedFleet(env, `v2:${phase}`);
        const input = { fleetId: a.fleetId, targetSystemId: S.N9, constraints: AVOID };
        const key = `v2:${phase}:plan`;
        if (phase === "before") restart();
        const plan = planOk(env, input, key);
        if (phase === "mid") {
          shared.clock.set(plan.departAt + 2 * plan.jumpMs);
          restart();
          const retry = env.fleets.planTravel({ ...input, at: shared.clock.now() }, key);
          assert.deepStrictEqual([retry.ok, retry.duplicate], [true, true], `${phase}: ${JSON.stringify(retry)}`);
        }
        shared.clock.set(plan.arriveAt + 10);
        if (phase === "due") restart();
        if (phase === "claimed") {
          const claimed = env.scheduler.claimDue(shared.clock.now(), 10, 1000);
          assert.strictEqual(claimed.events.length, 1);
          restart();
        }
        await pass(env);
        await pass(env);
        const f = fleetOf(env, a.fleetId);
        assert.deepStrictEqual([f.state, f.currentSystemId, f.legSeq], ["STAGED", S.N9, 1], phase);
        assert.strictEqual(journalCount(env.store, `arrival:${a.fleetId}:1`), 1, `${phase}: one arrival`);
        assert.strictEqual(eventOf(env.store, `arrival:${a.fleetId}:1`).state, "DONE", phase);
      });
    }
  }

  needsDriver("V3 travel replan mid-flight: legSeq 1 -> 2 from positionAt, old arrival STALE, new one once",
    async () => {
      await withStore(driver, async (reopen) => {
        const shared = sharedOf();
        const env = boot(reopen(), shared);
        const a = orderedFleet(env, "v3");
        const first = planOk(env, { fleetId: a.fleetId, targetSystemId: S.N9, constraints: AVOID }, "v3:plan");
        shared.clock.set(first.departAt + Math.floor(1.5 * first.jumpMs));
        const second = planOk(env, { fleetId: a.fleetId, targetSystemId: S.N10 }, "v3:replan");
        assert.strictEqual(second.legSeq, 2);
        const f = fleetOf(env, a.fleetId);
        assert.deepStrictEqual([f.currentSystemId, f.route.systems[0], f.route.departAt],
          [S.N5, S.N5, shared.clock.now()], "starts from positionAt(at)");
        shared.clock.set(Math.max(first.arriveAt, second.arriveAt) + 10);
        await pass(env);
        await pass(env);
        assert.strictEqual(eventOf(env.store, `arrival:${a.fleetId}:1`).outcome, "STALE");
        assert.strictEqual(eventOf(env.store, `arrival:${a.fleetId}:2`).outcome, "ARRIVED");
        assert.strictEqual(journalCount(env.store, `arrival:${a.fleetId}:1`), 0, "the old arrival had no effect");
        assert.strictEqual(journalCount(env.store, `arrival:${a.fleetId}:2`), 1);
        const done = fleetOf(env, a.fleetId);
        assert.deepStrictEqual([done.state, done.currentSystemId], ["STAGED", S.N10]);
      });

      await withStore(driver, async (reopen) => {
        const shared = sharedOf();
        let broken = false;
        const base = shared.graph;
        const graph = Object.freeze({ ...base, validateRoute: (route) => (broken && route[1] === S.N5
          ? { ok: false, reason: "BROKEN_EDGE", at: 1 } : base.validateRoute(route)) });
        const env = boot(reopen(), shared, { graph });
        const a = orderedFleet(env, "v3k");
        const plan = planOk(env, { fleetId: a.fleetId, targetSystemId: S.N9, constraints: AVOID }, "v3k:plan");
        broken = true;
        shared.clock.set(plan.arriveAt);
        await pass(env);
        assert.strictEqual(eventOf(env.store, `arrival:${a.fleetId}:1`).outcome, "REPLANNED");
        const f = fleetOf(env, a.fleetId);
        assert.deepStrictEqual([f.state, f.legSeq, f.route.systems[0], f.route.departAt],
          ["TRAVELLING", 2, S.N5, plan.departAt + 2 * plan.jumpMs]);
        broken = false;
        shared.clock.set(f.route.arriveAt);
        await pass(env);
        assert.deepStrictEqual([fleetOf(env, a.fleetId).state, fleetOf(env, a.fleetId).currentSystemId],
          ["STAGED", S.N9]);
      });
    });

  needsDriver("V4 travel refusals change nothing: UNREACHABLE, TOO_FAR, SAME_SYSTEM, SCHEDULER_UNAVAILABLE",
    async () => {
    await withStore(driver, async (reopen) => {
      const shared = sharedOf();
      const env = boot(reopen(), shared);
      const a = orderedFleet(env, "v4");
      const snapshot = () => {
        const f = fleetOf(env, a.fleetId);
        return { ...totals(env.store), version: f.version, state: f.state };
      };
      const before = snapshot();
      const refuse = (input, reason) => {
        const r = env.fleets.planTravel({ fleetId: a.fleetId, ...input }, `v4:${reason}`);
        assert.deepStrictEqual([r.ok, r.reason], [false, reason], JSON.stringify(r));
        assert.deepStrictEqual(snapshot(), before, `${reason} wrote nothing`);
        return r;
      };
      refuse({ targetSystemId: S.ISO }, "UNREACHABLE");
      assert.strictEqual(refuse({ targetSystemId: S.N9, constraints: { ...AVOID, maxJumps: 2 } }, "TOO_FAR").jumps, 4);
      refuse({ targetSystemId: S.N0 }, "SAME_SYSTEM");
      env.scheduler.stop("test");
      refuse({ targetSystemId: S.N9 }, "SCHEDULER_UNAVAILABLE");
    });
  });

  needsDriver("V5 travel retreat -> refit -> idle, operation completion after the last arrival, test multiplier",
    async () => {
      await withStore(driver, async (reopen) => {
        const shared = sharedOf();
        const env = boot(reopen(), shared);
        const r = orderedFleet(env, "v5:r");
        const out = planOk(env, { fleetId: r.fleetId, targetSystemId: S.N10 }, "v5:r:plan");
        shared.clock.set(out.arriveAt);
        await pass(env);
        assert.strictEqual(fleetOf(env, r.fleetId).state, "STAGED");
        const same = env.fleets.retreat({ fleetId: r.fleetId, targetSystemId: S.N10 }, "v5:r:same");
        assert.strictEqual(same.reason, "SAME_SYSTEM", "a retreat into the system the fleet stands in is refused");
        const back = env.fleets.retreat({ fleetId: r.fleetId }, "v5:r:retreat");
        assert.deepStrictEqual([back.ok, back.mode, back.legSeq], [true, "retreat", 2], JSON.stringify(back));
        assert.strictEqual(fleetOf(env, r.fleetId).state, "RETREATING");
        shared.clock.set(back.arriveAt + 50);
        await pass(env);
        const refitting = fleetOf(env, r.fleetId);
        assert.deepStrictEqual([refitting.state, refitting.currentSystemId, refitting.nextActionAt],
          ["REFITTING", S.N0, back.arriveAt + REFIT_MS], "refit deadline from the leg, not from now");
        shared.clock.set(back.arriveAt + REFIT_MS);
        await pass(env);
        const idle = fleetOf(env, r.fleetId);
        assert.deepStrictEqual([idle.state, idle.operationId], ["IDLE", null]);

        const created = ["p", "q"].map((t) => env.fleets.createFleet({ factionId: FACTION, currentSystemId: S.N0,
          homeSystemId: S.N0, fleetRole: "invasion", composition: COMPOSITION }, `v5:op:${t}`).fleetId);
        const op = env.fleets.createOperation({ operationType: "invasion", factionId: FACTION, originSystemId: S.N0,
          targetSystemId: S.N9, objective: "capture", dueAt: shared.clock.now() + 1000,
          fleets: created.map((fleetId) => ({ fleetId, expectedVersion: 1 })) }, "v5:op");
        assert.ok(op.ok, JSON.stringify(op));
        const [p, qf] = created;
        const pp = planOk(env, { fleetId: p, targetSystemId: S.N5 }, "v5:op:p:plan");
        const qq = planOk(env, { fleetId: qf, targetSystemId: S.N9, constraints: AVOID }, "v5:op:q:plan");
        assert.strictEqual(env.fleets.getOperation(op.operationId).operation.state, "ACTIVE", "first departure");
        shared.clock.set(pp.arriveAt);
        await pass(env);
        await pass(env);
        assert.strictEqual(eventOf(env.store, `opdone:${op.operationId}`).outcome, "WAITING");
        shared.clock.set(qq.arriveAt);
        await pass(env);
        await pass(env);
        assert.strictEqual(eventOf(env.store, `opdone:${op.operationId}:next:1`).outcome, "COMPLETED");
        assert.strictEqual(eventOf(env.store, `opdone:${op.operationId}:next:1:next:2`), undefined);
        assert.strictEqual(n(env.store, "SELECT count(*) AS n FROM world_scheduled_events WHERE idempotency_key "
          + "LIKE ?", `opdone:${op.operationId}%`), 2, "exactly one reschedule");
        const closed = env.fleets.getOperation(op.operationId).operation;
        assert.deepStrictEqual([closed.state, closed.result], ["COMPLETED", { arrived: 2 }]);
        for (const id of created) assert.strictEqual(fleetOf(env, id).state, "IDLE");
      });

      await withStore(driver, async (reopen) => {
        const shared = sharedOf({ timeScale: 10 });
        const observed = new Set();
        let available = true;
        const presence = { getStatus: () => ({ available, stale: false }), isObserved: (id) => observed.has(id) };
        const env = boot(reopen(), shared, { presence });
        const base = jumpMsForComposition(COMPOSITION, { timeFactor: 1 }).baseJumpMs;
        const plan = (tag) => {
          const a = orderedFleet(env, tag);
          return planOk(env, { fleetId: a.fleetId, targetSystemId: S.N9, constraints: AVOID }, `${tag}:plan`);
        };
        const free = plan("v5:m:free");
        assert.deepStrictEqual([free.jumpMs, free.observed], [Math.round(base / 10), false]);
        observed.add(S.N6);
        const seen = plan("v5:m:seen");
        assert.deepStrictEqual([seen.jumpMs, seen.observed], [base, true]);
        observed.clear();
        available = false;
        const blind = plan("v5:m:blind");
        assert.deepStrictEqual([blind.jumpMs, blind.observed], [base, true]);
        assert.strictEqual(env.fleets.getStatus().travel.counters.accelerated, 1);
      });
    });

  needsDriver("V6a scheduler: a type unregistered inside the batch is parked with its attempt; secClassCost {} = BFS",
    async () => {
      const { finder } = fixtureGraph();
      const plain = finder.findRoute(S.N0, S.N9);
      assert.strictEqual(finder.findRoute(S.N0, S.N9, { secClassCost: {} }), plain, "same cache entry");
      assert.strictEqual(finder.findRoute(S.N0, S.N9, { secClassCost: { lowsec: 0 } }), plain);
      assert.strictEqual(finder.getRouteStats().searches, 1);

      await withStore(driver, async (reopen) => {
        const shared = sharedOf();
        const env = boot(reopen(), shared);
        const s = env.scheduler;
        const now = shared.clock.now();
        assert.ok(s.enqueue("SUPPLY_RECHECK", 500001, now - 2, {}, "v6:first").ok);
        assert.ok(s.enqueue("OCCUPATION_PHASE_CHANGE", 30000201, now - 1, {}, "v6:second").ok);
        let handle = null;
        assert.ok(s.registerHandler("SUPPLY_RECHECK", () => {
          handle.unregister();
          return { ok: true };
        }).ok);
        handle = s.registerHandler("OCCUPATION_PHASE_CHANGE", () => ({ ok: true }));
        assert.ok(handle.ok);
        const first = await pass(env);
        assert.strictEqual(first.done, 1);
        const parked = eventOf(env.store, "v6:second");
        assert.deepStrictEqual([parked.state, parked.attempts], ["RETRY", 0], "attempt returned");
        assert.strictEqual(s.getStatus().parked.OCCUPATION_PHASE_CHANGE, 1);
        assert.ok(s.registerHandler("OCCUPATION_PHASE_CHANGE", () => ({ ok: true })).ok);
        await pass(env);
        assert.strictEqual(eventOf(env.store, "v6:second").state, "DONE");
      });
    });

  needsDriver("V6b layer-fleets: one item at progress 0.5, time-bucket key, null on HOLD; client ingestPaths",
    async () => {
      await withStore(driver, async (reopen) => {
        const shared = sharedOf();
        let hold = false;
        const env = boot(reopen(), shared, { getGovernor: () => ({ admits: () => !hold }) });
        const a = orderedFleet(env, "v6b");
        const plan = planOk(env, { fleetId: a.fleetId, targetSystemId: S.N9, constraints: AVOID }, "v6b:plan");
        shared.clock.set(plan.departAt + 2 * plan.jumpMs);
        const view = env.views.getView("layer-fleets");
        assert.ok(view, "registered");
        const layers = env.views.listMapLayers().filter((l) => l.id === "layer-fleets" || l.id === "layer-invasions")
          .map((l) => [l.id, l.kind]);
        const expectedLayers = [["layer-fleets", "paths"]];
        const invasionLayer = layers.find((l) => l[0] === "layer-invasions");
        if (invasionLayer) assert.deepStrictEqual(invasionLayer, ["layer-invasions", "marks"]);
        assert.deepStrictEqual(layers.filter((l) => l[0] === "layer-fleets"), expectedLayers);
        const key = view.cacheKey();
        const data = view.getData();
        assert.strictEqual(data.available, true);
        assert.strictEqual(data.key, key);
        assert.strictEqual(data.items.length, 1);
        const item = data.items[0];
        assert.deepStrictEqual(item[0], [S.N0, S.N5, S.N6, S.N7, S.N9]);
        assert.ok(Math.abs(item[2] - 0.5) < 1e-9, String(item[2]));
        assert.strictEqual(item[4][0], a.fleetId);
        assert.strictEqual(item[5], fleetOf(env, a.fleetId).factionId);
        assert.deepStrictEqual(data.legend.map((l) => [l[0], l[3]]),
          [["travelling", "solid"], ["retreating", "dashed"]]);
        shared.clock.advance(CONFIG.observer.galaxyFleetsRefreshMs);
        assert.notStrictEqual(view.cacheKey(), key, "a new time bucket");
        hold = true;
        assert.strictEqual(view.cacheKey(), null);
        assert.strictEqual(view.getData().reason, "GOVERNOR_HOLD");

        const sandbox = { window: {} };
        vm.runInNewContext(fs.readFileSync(path.join(MOD_DIR, "web", "galaxy.js"), "utf8"), sandbox,
          { filename: "galaxy.js" });
        const pure = sandbox.window.LneGalaxy._pure;
        const idIndex = new Map(Object.values(S).map((id, i) => [id, i]));
        const ingested = pure.ingestPaths({ legend: data.legend,
          items: [...data.items, [[S.N0, OUTSIDE], "travelling", 0.2, "1", null]] }, idIndex);
        assert.strictEqual(ingested.offMap, 1);
        assert.strictEqual(ingested.items.length, 1);
        const flying = fleetOf(env, a.fleetId);
        assert.strictEqual(ingested.items[0].at, idIndex.get(positionAt(flying, plan.departAt + 2 * plan.jumpMs)
          .systemId));
        assert.strictEqual(ingested.items[0].color, "#ffb000");
        const lines = ingested.byIndex.get(ingested.items[0].at);
        assert.strictEqual(lines.label, "1");
        assert.strictEqual(lines.lines[0], a.fleetId);
        assert.strictEqual(pure.secColor(0, 2), "#8a1010", "LOW-4b: nullsec by class");
        env.fleets.stop("test");
        assert.strictEqual(env.views.getView("layer-fleets"), null, "unregistered on stop");
        assert.strictEqual(env.fleets.planTravel({ fleetId: a.fleetId, targetSystemId: S.N10 }, "v6b:late").reason,
          "TRAVEL_UNAVAILABLE");
      });
    });

  needsDriver("V7 travel: a full queue never quarantines an arrival; follow-ups are chained, ceiling holds",
    async () => {
      await withStore(driver, async (reopen) => {
        const shared = sharedOf();
        const env = boot(reopen(), shared, { config: configWith({ scheduler: { maxOpenEvents: 2,
          chainedHeadroom: 4 } }) });
        const t = twoFleetOperation(env, shared, "v7");
        for (const [i, opts] of [{}, { chained: true }].entries()) {
          const r = env.store.transaction("v7:new", (db) => env.scheduler.enqueue("FLEET_ARRIVAL", "x",
            t.qq.arriveAt, {}, `v7:new:${i}`, { tx: db, ...opts }));
          assert.strictEqual(r.ok, true);
          assert.strictEqual(r.value.reason, "QUEUE_FULL", JSON.stringify(opts));
        }
        shared.clock.set(t.pp.arriveAt);
        await pass(env);
        const arrival = eventOf(env.store, `arrival:${t.p}:1`);
        assert.strictEqual(arrival.state, "DONE", "accepted at once, no retry");
        assert.strictEqual(arrival.attempts, 1);
        assert.strictEqual(fleetOf(env, t.p).state, "STAGED");
        for (let i = 0; i < 40 && env.fleets.getOperation(t.operationId).operation.state === "ACTIVE"; i += 1) {
          shared.clock.set(Math.max(shared.clock.now() + 60000, t.qq.arriveAt));
          await pass(env);
        }
        assert.strictEqual(env.fleets.getOperation(t.operationId).operation.state, "COMPLETED");
        assert.strictEqual(fleetOf(env, t.p).state, "IDLE");
        assert.strictEqual(fleetOf(env, t.qf).state, "IDLE");
        assert.strictEqual(n(env.store, "SELECT count(*) AS n FROM world_scheduled_events "
          + "WHERE state = 'QUARANTINED'"), 0, "no quarantine");
      });
      await withStore(driver, async (reopen) => {
        const shared = sharedOf();
        const env = boot(reopen(), shared, { config: configWith({ scheduler: { maxOpenEvents: 2,
          chainedHeadroom: 0 } }) });
        const t = twoFleetOperation(env, shared, "v7c");
        shared.clock.set(t.pp.arriveAt);
        await pass(env);
        assert.strictEqual(eventOf(env.store, `arrival:${t.p}:1`).state, "RETRY");
        assert.match(lastErrorOf(env.store, `arrival:${t.p}:1`), /QUEUE_FULL/);
        assert.strictEqual(fleetOf(env, t.p).state, "TRAVELLING", "effect rolled back with its DONE");
      });
    });

  needsDriver("V8 travel: operation rechecks back off and stop after operationMaxOverdueRounds",
    async () => {
      await withStore(driver, async (reopen) => {
        const rounds = 4;
        const shared = sharedOf();
        const env = boot(reopen(), shared, { config: configWith({ scheduler: { retryMaxMs: 3000 },
          fleets: { operationMaxOverdueRounds: rounds } }) });
        const t = twoFleetOperation(env, shared, "v8");
        const lost = env.store.transaction("v8", (db) => db.prepare("UPDATE world_scheduled_events SET "
          + "state = 'QUARANTINED', finished_at = 1, last_error = 'test' WHERE idempotency_key = ?")
          .run(`arrival:${t.qf}:1`));
        assert.ok(lost.ok);
        shared.clock.set(t.qq.arriveAt + 10);
        for (let i = 0; i < 60; i += 1) {
          await pass(env);
          shared.clock.set(shared.clock.now() + 1000);
        }
        const like = `opdone:${t.operationId}%`;
        const rows = q(env.store, "SELECT idempotency_key AS k, state, due_at AS dueAt FROM world_scheduled_events "
          + "WHERE idempotency_key LIKE ? ORDER BY due_at", like);
        assert.strictEqual(rows.length, rounds + 2, JSON.stringify(rows.map((r) => r.k)));
        assert.strictEqual(rows[1].dueAt, t.qq.arriveAt, "a member on its way: wait for its arrival time");
        const gaps = rows.slice(2).map((r, i) => r.dueAt - rows[i + 1].dueAt);
        assert.deepStrictEqual(gaps, [1000, 2000, 3000, 3000], "backoff retryBaseMs * 2^n capped at retryMaxMs");
        assert.ok(rows.slice(0, -1).every((r) => r.state === "DONE"));
        const last = rows[rows.length - 1];
        assert.strictEqual(last.state, "QUARANTINED", "permanent: no retry, no next round");
        assert.match(lastErrorOf(env.store, last.k), new RegExp(`^OPERATION_MEMBERS_OVERDUE: .*${t.qf}@`));
        assert.strictEqual(env.fleets.getStatus().travel.counters.operationsOverdue, 1);
        for (let i = 0; i < 30; i += 1) {
          shared.clock.set(shared.clock.now() + 600000);
          await pass(env);
        }
        assert.strictEqual(n(env.store, "SELECT count(*) AS n FROM world_scheduled_events WHERE idempotency_key "
          + "LIKE ?", like), rounds + 2, "no new rows after the limit");
        assert.strictEqual(env.fleets.getOperation(t.operationId).operation.state, "ACTIVE");
        assert.strictEqual(fleetOf(env, t.p).state, "STAGED");
      });
    });

  needsDriver("V9 travel SWEEP: downtime longer than the backoff, member arrival in RETRY -> no quarantine, "
    + "operation COMPLETED", async () => {
    await withStore(driver, async (reopen) => {
      const rounds = 4;
      const retryMs = 40000;
      const shared = sharedOf();
      const env = boot(reopen(), shared, { config: configWith({ scheduler: { retryMaxMs: 3000 },
        fleets: { operationMaxOverdueRounds: rounds } }) });
      const t = twoFleetOperation(env, shared, "v9");
      shared.clock.set(t.pp.arriveAt + 10);
      await pass(env);
      assert.strictEqual(fleetOf(env, t.p).state, "STAGED");
      const now = t.qq.arriveAt + 3600000;
      const busy = env.store.transaction("v9", (db) => db.prepare("UPDATE world_scheduled_events SET "
        + "state = 'RETRY', attempts = 1, due_at = ?, last_error = 'test busy' WHERE idempotency_key = ?")
        .run(now + retryMs, `arrival:${t.qf}:1`));
      assert.ok(busy.ok);
      shared.clock.set(now);
      for (let i = 0; i < 20; i += 1) {
        await pass(env);
        shared.clock.set(shared.clock.now() + 1000);
      }
      const like = `opdone:${t.operationId}%`;
      assert.strictEqual(n(env.store, "SELECT count(*) AS n FROM world_scheduled_events WHERE idempotency_key "
        + "LIKE ? AND state = 'QUARANTINED'", like), 0, "an open arrival does not burn the overdue rounds");
      const waiting = q(env.store, "SELECT due_at AS dueAt, payload FROM world_scheduled_events WHERE "
        + "idempotency_key LIKE ? AND state = 'QUEUED'", like);
      assert.strictEqual(waiting.length, 1);
      assert.strictEqual(waiting[0].dueAt, now + retryMs + 1000, "queue time of the arrival + recheckMs");
      assert.strictEqual(JSON.parse(waiting[0].payload).overdue, 0);
      for (let i = 0; i < 10 && env.fleets.getOperation(t.operationId).operation.state === "ACTIVE"; i += 1) {
        shared.clock.set(shared.clock.now() + 60000);
        await pass(env);
      }
      assert.strictEqual(env.fleets.getOperation(t.operationId).operation.state, "COMPLETED");
      assert.strictEqual(fleetOf(env, t.p).state, "IDLE");
      assert.strictEqual(fleetOf(env, t.qf).state, "IDLE");
    });
  });
};
