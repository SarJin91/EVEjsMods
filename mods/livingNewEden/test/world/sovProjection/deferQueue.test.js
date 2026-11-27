"use strict";

const assert = require("node:assert");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");

const { findServerSrcOnDisk, GAMESTORE_SEARCH_MAX_DEPTH } = require("../../../lib/adapter/locator");
const { resolveSqliteDriver } = require("../../../lib/adapter/sqliteDriver");
const { MIGRATIONS } = require("../../../lib/persistence/migrations");
const { openStore } = require("../../../lib/persistence/store");
const { createJournal } = require("../../../lib/persistence/journal");
const { seedDbFile } = require("../../_support/dbTemplate");
const { createSovProjectionFacade } = require("../../../lib/world/sovProjection");
const { createSovBudgetFromConfig, createProjectionPacer } = require("../../../lib/world/sovProjection/budget");
const { syncAll } = require("../../../lib/world/sovProjection/sync");
const { getLogsByIds } = require("../../../lib/world/sovProjection/repository");
const { MAX_LOG_IDS } = require("../../../lib/world/sovProjection/schema");

const MOD_DIR = path.resolve(__dirname, "..", "..", "..");
const FACTION = 500016;
const ALLIANCE = 98000001;
const CORP = 98100001;
const WINDOW_MS = 300000;

function loadDriver() {
  const found = findServerSrcOnDisk(MOD_DIR, GAMESTORE_SEARCH_MAX_DEPTH, fs.existsSync);
  if (!found.ok) return { ok: false, detail: found.reason };
  return resolveSqliteDriver(found.srcDir);
}

async function withStore(driver, fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lne-sovdq-"));
  const file = path.join(tmp, "world.sqlite");
  seedDbFile(driver, file, { migrations: MIGRATIONS, seed: 1 });
  const opened = openStore({ filePath: file, openDatabase: (f) => new driver.Database(f), exclusiveLock: true,
    busyTimeoutMs: 0, maxRowsPerTransaction: 500, maxWriteMsPerPass: 5, randomSeed: () => 1, migrations: MIGRATIONS });
  assert.ok(opened.ok, JSON.stringify(opened));
  try {
    return await fn(opened.store);
  } finally {
    opened.store.close("test_cleanup");
    try {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch (_err) {
    }
  }
}

function fakeTelemetry() {
  const counters = new Map();
  return {
    count: (name, n = 1) => counters.set(name, (counters.get(name) || 0) + n),
    observe: () => {},
    gauge: () => {},
    get: (name) => counters.get(name) || 0,
  };
}

function fakeTimers() {
  const timers = [];
  return {
    setTimer: (fn, ms) => {
      const t = { fn, ms, cancelled: false };
      timers.push(t);
      return { cancel: () => { t.cancelled = true; } };
    },
    pending: () => timers.filter((t) => !t.cancelled && !t.fired),
  };
}

function harness(store, opts) {
  let now = 1000000;
  const clock = { now: () => now, advance: (ms) => { now += ms; } };
  const journal = createJournal({ clock, maxPayloadBytes: 4096, maxRows: 100000 });
  const claims = new Map();
  const vendorCalls = [];
  const sovModules = {
    "services/sovereignty/sovSystemRules": { isSovereigntyClaimableSolarSystem: () => true },
    "services/sovereignty/sovState": { getSystemSovClaim: (ss) => claims.get(ss) || null },
    "services/sovereignty/sovGmState": {},
  };
  const requireGame = (rel) => (sovModules[rel] ? { ok: true, exports: sovModules[rel] } : { ok: false, reason: "not_mocked" });
  const adapter = {
    requireGame,
    getSovProjection: () => ({
      requireGame,
      readSovState: async () => ({ ok: true }),
      projectSovCall: async (systemId, action, allianceId, corpId) => {
        vendorCalls.push([systemId, action]);
        clock.advance(opts.vendorMs || 0);
        const r = opts.vendorResult ? await opts.vendorResult(systemId) : { ok: true, action };
        if (r.ok) claims.set(systemId, { allianceID: allianceId, corporationID: corpId });
        return r;
      },
    }),
  };
  const systems = opts.systems.map((systemId) => ({ systemId, controllerFactionId: FACTION, occupationState: "OCCUPIED",
    phaseSeq: 1, capturedAt: 0 }));
  const world = {
    getSystem: (id) => {
      const system = systems.find((s) => s.systemId === id);
      return system ? { ok: true, system } : { ok: false, reason: "NOT_FOUND" };
    },
    listSystems: (o) => ({ systems: systems.filter((s) => s.systemId > (o.afterSystemId || 0)).slice(0, o.limit) }),
  };
  const virtualCorps = {
    getFactionIdentity: () => ({ ok: true, allianceId: ALLIANCE, corporationIds: [CORP] }),
    isVirtualAlliance: (a) => a === ALLIANCE,
  };
  const config = { world: { sovProjection: { syncBatchSize: 500, syncSliceMs: 4, invaderFactionIds: "500021" } },
    limits: { maxSovWritesPerWindow: opts.maxWrites || 8, sovWriteWindowMs: WINDOW_MS } };
  const telemetry = fakeTelemetry();
  const timers = fakeTimers();
  const logs = [];
  const logger = { log: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m) };
  const budget = createSovBudgetFromConfig(config, clock.now);
  const pacer = createProjectionPacer({ minSpacingMs: opts.minSpacingMs || 0, costFactor: opts.costFactor || 0,
    now: clock.now });
  const facade = createSovProjectionFacade({ adapter, budget, journal, persistence: { ok: true, store, journal },
    telemetry, config, clock, logger, world, virtualCorps, pacer, nowMs: clock.now, getGovernor: () => null,
    deferQueueDeps: { setTimer: timers.setTimer, maxSystems: 64, failureRetryMs: 60000,
      maxAttempts: opts.maxAttempts || 5, drainMaxPerPass: 16, sliceMs: 4, minSpacingMs: opts.minSpacingMs || 0 } });
  assert.ok(facade, "facade created");

  async function fireTimer() {
    const pending = timers.pending();
    assert.strictEqual(pending.length, 1, "exactly one armed timer");
    const t = pending[0];
    t.fired = true;
    clock.advance(t.ms);
    t.fn();
    for (let i = 0; i < 100 && facade.getDeferStatus().draining; i += 1) await new Promise((r) => setImmediate(r));
    assert.strictEqual(facade.getDeferStatus().draining, false, "drain settled");
  }

  const gain = (systemId) => ({ action: "GAIN", allianceId: ALLIANCE, executorCorpId: CORP,
    controllerFactionId: FACTION, phaseSeq: 1 });
  return { clock, journal, claims, vendorCalls, world, virtualCorps, config, telemetry, timers, logs, budget, pacer,
    facade, fireTimer, gain, store };
}

module.exports = ({ test, skip }) => {
  const driver = loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  needsDriver("DQ1 budget 1, 3 GAIN: syncAll 1 processed + 2 deferred, timer drains to 3 vendor calls, queue empty", async () => {
    await withStore(driver, async (store) => {
      const ids = [30000101, 30000102, 30000103];
      const h = harness(store, { maxWrites: 1, systems: ids });
      const refusals = [];
      const facade = { ...h.facade, projectSystem: async (...a) => {
        const r = await h.facade.projectSystem(...a);
        if (r.reason === "BUDGET_EXCEEDED") refusals.push(a[0]);
        return r;
      } };
      const r = await syncAll({ sovProjection: facade, world: h.world, persistence: { ok: true, store },
        virtualCorps: h.virtualCorps, config: h.config, telemetry: h.telemetry, logger: { warn() {}, error() {} },
        clock: h.clock, nowMs: h.clock.now, yieldFn: async () => {} });
      assert.ok(r.ok, JSON.stringify(r));
      assert.deepStrictEqual([r.processed, r.deferred, r.failed], [1, 2, 0], JSON.stringify(r));
      assert.strictEqual(h.vendorCalls.length, 1);
      assert.strictEqual(h.facade.getDeferStatus().depth, 2);

      for (let i = 0; i < 10 && h.facade.getDeferStatus().depth > 0; i += 1) await h.fireTimer();
      assert.strictEqual(h.facade.getDeferStatus().depth, 0, "queue empty");
      assert.deepStrictEqual(h.vendorCalls.map((c) => c[0]).sort(), ids, "3 vendor calls, one per system");
      assert.strictEqual(h.timers.pending().length, 0, "empty queue = no timer");
      assert.strictEqual(refusals.length, 2);
      assert.strictEqual(h.telemetry.get("sovProjection.budgetExceeded"), 3, "one count per refusal, no double count");
      assert.strictEqual(h.telemetry.get("sovProjection.deferDrained"), 2);
      const logs = store.transaction("t.logs", (tx) => getLogsByIds(tx, ids));
      assert.ok(logs.ok && logs.value.ok, JSON.stringify(logs));
      assert.deepStrictEqual([...logs.value.value.values()].map((l) => [l.system_id, l.last_action, l.last_seq]),
        ids.map((id) => [id, "GAIN", 1]));
    });
  });

  needsDriver("DQ2 pacing: second write inside the gap is PROJECTION_PACED (retryAt end+2000), token kept", async () => {
    await withStore(driver, async (store) => {
      const h = harness(store, { maxWrites: 8, minSpacingMs: 1000, costFactor: 20, vendorMs: 100,
        systems: [30000101, 30000102] });
      const r1 = await h.facade.projectSystem(30000101, h.gain());
      assert.deepStrictEqual([r1.ok, r1.skipped], [true, false], JSON.stringify(r1));
      const end = h.clock.now();
      const tokensAfterFirst = h.budget.getStatus().tokens;
      const r2 = await h.facade.projectSystem(30000102, h.gain());
      assert.deepStrictEqual([r2.ok, r2.reason, r2.deferred, r2.retryAt], [false, "PROJECTION_PACED", true, end + 2000],
        JSON.stringify(r2));
      assert.strictEqual(h.budget.getStatus().tokens, tokensAfterFirst, "paced refusal does not use a token");
      assert.strictEqual(h.vendorCalls.length, 1);
      assert.strictEqual(h.telemetry.get("sovProjection.paced"), 1);
      assert.strictEqual(h.timers.pending()[0].ms, 2000, "timer at retryAt");
      await h.fireTimer();
      assert.strictEqual(h.vendorCalls.length, 2, "drain projects after the gap");
      assert.strictEqual(h.facade.getDeferStatus().depth, 0);
    });
  });

  test("DQ3 syncAll: per-system slices with yields, one getLogs tx per page, log shortcut skips projectSystem", async () => {
    let perf = 0;
    const ids = Array.from({ length: 20 }, (_, i) => 30000101 + i);
    const systems = ids.map((systemId) => ({ systemId, controllerFactionId: FACTION, occupationState: "OCCUPIED",
      phaseSeq: 3, capturedAt: 0 }));
    const txNames = [];
    const synced = ids[0];
    const rows = new Map([[synced, { system_id: synced, last_controller: FACTION, last_alliance: ALLIANCE,
      last_corp: CORP, last_action: "GAIN", last_seq: 3, updated_at: 0, version: 1 }]]);
    const store = {
      transaction: (name, fn) => {
        txNames.push(name);
        const tx = { inTransaction: true, prepare: () => ({ all: (json) => JSON.parse(json).map((id) => rows.get(id)).filter(Boolean) }) };
        return { ok: true, value: fn(tx), rows: 0 };
      },
    };
    const projected = [];
    const sovProjection = {
      requireGame: (rel) => ({ ok: true, exports: rel.endsWith("sovSystemRules")
        ? { isSovereigntyClaimableSolarSystem: () => { perf += 1; return true; } }
        : { getSystemSovClaim: () => null } }),
      isVirtualAlliance: (a) => a === ALLIANCE,
      projectSystem: async (systemId) => {
        projected.push(systemId);
        return { ok: true, action: "GAIN", skipped: false };
      },
    };
    let yieldCalls = 0;
    const r = await syncAll({ sovProjection, persistence: { ok: true, store },
      world: { listSystems: (o) => ({ systems: systems.filter((s) => s.systemId > o.afterSystemId).slice(0, o.limit) }) },
      virtualCorps: { getFactionIdentity: () => ({ ok: true, allianceId: ALLIANCE, corporationIds: [CORP] }) },
      config: { world: { sovProjection: { syncBatchSize: 10, syncSliceMs: 4 } } }, telemetry: null,
      logger: { warn() {}, error() {} }, clock: { now: () => 0 }, nowMs: () => perf,
      yieldFn: async () => { yieldCalls += 1; } });
    assert.ok(r.ok, JSON.stringify(r));
    assert.ok(r.yields >= 4, `yields ${r.yields}`);
    assert.strictEqual(r.yields, yieldCalls);
    assert.ok(r.maxSliceMs <= 5, `maxSliceMs ${r.maxSliceMs}`);
    assert.deepStrictEqual(txNames, ["sovProjection.getLogs", "sovProjection.getLogs"], "one log read per page (2 pages)");
    assert.ok(!projected.includes(synced), "log matching controller and phaseSeq -> no projectSystem");
    assert.strictEqual(projected.length, 19);
    assert.deepStrictEqual([r.processed, r.skipped, r.deferred, r.failed], [19, 1, 0, 0]);
    const tooMany = getLogsByIds({ prepare: () => assert.fail("no SQL for refused input") },
      Array.from({ length: MAX_LOG_IDS + 1 }, (_, i) => i + 1));
    assert.deepStrictEqual([tooMany.ok, tooMany.reason], [false, "REPO_INVALID_INPUT"]);
  });

  needsDriver("DQ4 failures: transient -> attempts then give up; permanent -> no entry; IN_FLIGHT -> entry kept", async () => {
    await withStore(driver, async (store) => {
      let mode = "transient";
      let gate = null;
      const h = harness(store, { systems: [30000101, 30000102, 30000103], maxAttempts: 2,
        vendorResult: async () => {
          if (gate) await gate;
          if (mode === "transient") return { ok: false, reason: "FLUSH_FAILED", permanent: false };
          if (mode === "permanent") return { ok: false, reason: "NOT_CLAIMABLE", permanent: true };
          return { ok: true, action: "GAIN" };
        } });
      const r = await h.facade.projectSystem(30000101, h.gain());
      assert.deepStrictEqual([r.ok, r.reason], [false, "FLUSH_FAILED"]);
      assert.strictEqual(h.facade.getDeferStatus().depth, 1, "transient failure -> entry");
      assert.strictEqual(h.timers.pending()[0].ms, 60000, "retry after deferFailureRetryMs");
      await h.fireTimer();
      assert.strictEqual(h.facade.getDeferStatus().depth, 1);
      await h.fireTimer();
      assert.strictEqual(h.facade.getDeferStatus().depth, 0, "given up");
      assert.strictEqual(h.telemetry.get("sovProjection.deferGaveUp"), 1);
      assert.strictEqual(h.telemetry.get("sovProjection.deferDrained"), 0, "Given up is not drained");
      assert.strictEqual(h.vendorCalls.length, 3);
      assert.strictEqual(h.logs.filter((l) => l.includes("gave up system 30000101")).length, 1);

      mode = "permanent";
      const p = await h.facade.projectSystem(30000102, h.gain());
      assert.deepStrictEqual([p.ok, p.permanent], [false, true]);
      assert.strictEqual(h.facade.getDeferStatus().depth, 0, "permanent failure -> no entry");

      mode = "ok";
      let release;
      gate = new Promise((res) => { release = res; });
      const first = h.facade.projectSystem(30000103, h.gain());
      await new Promise((res) => setImmediate(res));
      const second = await h.facade.projectSystem(30000103);
      assert.deepStrictEqual([second.ok, second.reason, second.deferred], [true, "IN_FLIGHT", true]);
      assert.strictEqual(h.facade.getDeferStatus().depth, 1, "IN_FLIGHT -> entry");
      gate = null;
      release();
      const done = await first;
      assert.deepStrictEqual([done.ok, done.skipped], [true, false], JSON.stringify(done));
      assert.strictEqual(h.facade.getDeferStatus().depth, 1, "the running projection does not settle the IN_FLIGHT entry");
      await h.fireTimer();
      assert.strictEqual(h.facade.getDeferStatus().depth, 0, "re-read: ALREADY_SYNCED, settled");
      h.facade.dispose();
      assert.strictEqual(h.timers.pending().length, 0);
    });
  });

  needsDriver("DQ5: controller change during syncAll yields -> no vendor write for the stale controller", async () => {
    await withStore(driver, async (store) => {
      const SS = 30000101;
      const FACTION_B = 500017;
      const ALLIANCE_B = 98000002;
      const CORP_B = 98100002;
      const h = harness(store, { systems: [SS] });
      h.virtualCorps.getFactionIdentity = (f) => (f === FACTION_B
        ? { ok: true, allianceId: ALLIANCE_B, corporationIds: [CORP_B] }
        : { ok: true, allianceId: ALLIANCE, corporationIds: [CORP] });
      h.virtualCorps.isVirtualAlliance = (a) => a === ALLIANCE || a === ALLIANCE_B;
      let current = { systemId: SS, controllerFactionId: FACTION, occupationState: "OCCUPIED", phaseSeq: 1, capturedAt: 0 };
      h.world.getSystem = (id) => (id === SS ? { ok: true, system: current } : { ok: false, reason: "NOT_FOUND" });
      const stale = [{ ...current }];
      let flipped = false;
      let perf = 0;
      const r = await syncAll({ sovProjection: h.facade, persistence: { ok: true, store },
        world: { listSystems: (o) => ({ systems: stale.filter((s) => s.systemId > o.afterSystemId).slice(0, o.limit) }) },
        virtualCorps: h.virtualCorps, config: h.config, telemetry: h.telemetry, logger: { warn() {}, error() {} },
        clock: h.clock, nowMs: () => (perf += 10),
        yieldFn: async () => {
          if (flipped) return;
          flipped = true;
          current = { ...current, controllerFactionId: FACTION_B, phaseSeq: 2 };
          const l = await h.facade.projectSystem(SS);
          assert.deepStrictEqual([l.ok, l.action, l.skipped], [true, "GAIN", false], JSON.stringify(l));
        } });
      assert.ok(r.ok, JSON.stringify(r));
      assert.ok(flipped, "the yield ran between the listing and phase C");
      assert.deepStrictEqual(h.vendorCalls, [[SS, "GAIN"]], "only the listener's write, no TRANSFER to the stale alliance");
      assert.strictEqual(h.claims.get(SS).allianceID, ALLIANCE_B, "EveJS keeps controller B");
      const log = store.transaction("t.log", (tx) => getLogsByIds(tx, [SS]));
      const row = log.value.value.get(SS);
      assert.deepStrictEqual([row.last_controller, row.last_alliance, row.last_seq], [FACTION_B, ALLIANCE_B, 2]);
      assert.strictEqual(r.processed + r.skipped, 1, JSON.stringify(r));
    });
  });

  test("DQ6: cached nextDueAt follows add, move and remove of the minimum", () => {
    const { createDeferQueue } = require("../../../lib/world/sovProjection/deferQueue");
    const q = createDeferQueue({ maxSystems: 8, now: () => 0, setTimer: () => ({ cancel() {} }), onDue() {} });
    assert.strictEqual(q.nextDueAt(), null);
    q.defer(1, { dueAt: 500 });
    q.defer(2, { dueAt: 300 });
    q.defer(3, { dueAt: 400 });
    assert.strictEqual(q.nextDueAt(), 300);
    q.defer(2, { dueAt: 900 });
    assert.strictEqual(q.nextDueAt(), 400);
    q.defer(1, { dueAt: 100 });
    assert.strictEqual(q.nextDueAt(), 100);
    q.remove(1);
    assert.strictEqual(q.nextDueAt(), 400);
    q.remove(3);
    q.remove(2);
    assert.strictEqual(q.nextDueAt(), null);
    q.defer(4, { dueAt: 700 });
    assert.strictEqual(q.nextDueAt(), 700);
  });
};
