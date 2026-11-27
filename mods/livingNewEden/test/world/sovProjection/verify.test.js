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
const { startSovProjection, stopSovProjection } = require("../../../lib/world/sovProjection");
const { verifyAll, syncAll } = require("../../../lib/world/sovProjection/sync");
const { createViewRegistry } = require("../../../lib/observer/views");

const MOD_DIR = path.resolve(__dirname, "..", "..", "..");
const FACTION = 500016;
const FACTION_B = 500017;
const NO_ID_FACTION = 500018;
const INVADER = 500021;
const ALLIANCE = 98000001;
const ALLIANCE_B = 98000002;
const CORP = 98100001;
const CORP_B = 98100002;
const PLAYER_ALLIANCE = 99000050;
const WINDOW_MS = 300000;
const STATUS_KEYS = ["state", "syncState", "lastSync", "defer", "budget", "pacer", "verify", "resyncNeeded"];

function loadDriver() {
  const found = findServerSrcOnDisk(MOD_DIR, GAMESTORE_SEARCH_MAX_DEPTH, fs.existsSync);
  if (!found.ok) return { ok: false, detail: found.reason };
  return resolveSqliteDriver(found.srcDir);
}

async function withStore(driver, fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lne-sovverify-"));
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
  const observes = new Map();
  const gauges = new Map();
  return {
    count: (name, n = 1) => counters.set(name, (counters.get(name) || 0) + n),
    observe: (name, v) => observes.set(name, [...(observes.get(name) || []), v]),
    gauge: (name, v) => gauges.set(name, v),
    get: (name) => counters.get(name) || 0,
    observed: (name) => observes.get(name) || [],
    gaugeOf: (name) => gauges.get(name),
  };
}

const tick = () => new Promise((r) => setImmediate(r));
async function until(pred) {
  for (let i = 0; i < 500 && !pred(); i += 1) await tick();
  return pred();
}

function serviceHarness(store, opts) {
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
    getProcessRole: () => "world",
    getSovProjection: () => ({
      requireGame,
      readSovState: async () => ({ ok: true }),
      projectSovCall: async (systemId, action, allianceId, corpId) => {
        vendorCalls.push([systemId, action]);
        claims.set(systemId, { allianceID: allianceId, corporationID: corpId });
        return { ok: true, action };
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
    listSystems: opts.listSystems
      || ((o) => ({ systems: systems.filter((s) => s.systemId > (o.afterSystemId || 0)).slice(0, o.limit) })),
  };
  const identities = new Map([[FACTION, [ALLIANCE, CORP]], [FACTION_B, [ALLIANCE_B, CORP_B]]]);
  const virtualCorps = {
    whenReady: () => Promise.resolve(),
    getFactionIdentity: (f) => (identities.has(f)
      ? { ok: true, allianceId: identities.get(f)[0], corporationIds: [identities.get(f)[1]] }
      : { ok: true, allianceId: 0, corporationIds: [] }),
    isVirtualAlliance: (a) => a === ALLIANCE || a === ALLIANCE_B,
  };
  const config = {
    enabled: true,
    modules: { sovProjection: { enabled: true } },
    world: { sovProjection: { syncBatchSize: 500, syncSliceMs: 4, invaderFactionIds: "500021",
      projectionMinSpacingMs: 0, projectionCostFactor: 0, deferMaxSystems: opts.deferMaxSystems || 64,
      deferFailureRetryMs: 60000, deferMaxAttempts: 5, deferDrainMaxPerPass: 64, syncSeedWaitMs: 0,
      verifyAfterDrain: opts.verifyAfterDrain !== false,
      verifyMinIntervalMs: opts.verifyMinIntervalMs === undefined ? 600000 : opts.verifyMinIntervalMs,
      verifyMaxSamples: 20 } },
    limits: { maxSovWritesPerWindow: opts.maxWrites, sovWriteWindowMs: WINDOW_MS },
  };
  const timers = [];
  const setTimer = (fn, ms) => {
    const t = { fn, ms, cancelled: false, fired: false };
    timers.push(t);
    return { cancel: () => { t.cancelled = true; } };
  };
  const pending = () => timers.filter((t) => !t.cancelled && !t.fired);
  const telemetry = fakeTelemetry();
  const logs = [];
  const logger = { log: (m) => logs.push(m), warn: (m) => logs.push(m), error: (m) => logs.push(m) };
  let txCount = 0;
  const countingStore = { ...store, transaction: (name, fn) => {
    txCount += 1;
    return store.transaction(name, fn);
  } };
  const views = createViewRegistry();
  const ctx = { config, persistence: { ok: true, store: countingStore, journal }, adapter, virtualCorps,
    occupation: { registerOnControllerChanged: () => null }, world, telemetry, logger, clock,
    getGovernor: () => null, fail: () => {}, setTimer, nowMs: clock.now, views };
  const started = startSovProjection(ctx);
  assert.ok(started.ok, JSON.stringify(started));
  const svc = ctx.sovProjection;

  async function fireTimer() {
    const p = pending();
    assert.strictEqual(p.length, 1, "exactly one armed timer");
    p[0].fired = true;
    clock.advance(p[0].ms);
    p[0].fn();
    await settle();
  }
  async function settle() {
    await until(() => {
      const st = svc.getStatus();
      return st.defer.draining === false && st.scanning === null;
    });
  }
  const move = (systemId, factionId) => {
    const s = systems.find((x) => x.systemId === systemId);
    s.controllerFactionId = factionId;
    s.phaseSeq += 1;
  };
  return { ctx, svc, started, clock, claims, vendorCalls, telemetry, logs, views, pending, fireTimer, settle, move,
    txCount: () => txCount };
}

function pagedListing(systems, { maxListLimit = Infinity, refusePage = 0 } = {}) {
  const calls = [];
  const fn = (o) => {
    calls.push(o.afterSystemId);
    if (calls.length === refusePage) return { ok: false, reason: "TX_BUSY" };
    const limit = Math.min(o.limit, maxListLimit);
    const rows = systems.filter((s) => s.systemId > o.afterSystemId).slice(0, limit);
    return { ok: true, systems: rows, nextAfterSystemId: rows.length === limit ? rows[rows.length - 1].systemId : null };
  };
  fn.calls = calls;
  return fn;
}

function pureScanCtx(listSystems, syncBatchSize) {
  const projected = [];
  const sovProjection = {
    requireGame: (rel) => ({ ok: true, exports: rel.endsWith("sovSystemRules")
      ? { isSovereigntyClaimableSolarSystem: () => true }
      : { getSystemSovClaim: () => null } }),
    isVirtualAlliance: (a) => a === ALLIANCE,
    projectSystem: async (systemId) => { projected.push(systemId); return { ok: true, action: "GAIN" }; },
  };
  const ctx = { sovProjection, world: { listSystems },
    persistence: { ok: true, store: { transaction: () => ({ ok: false, reason: "NO_STORE" }) } },
    virtualCorps: { getFactionIdentity: () => ({ ok: true, allianceId: ALLIANCE, corporationIds: [CORP] }) },
    config: { world: { sovProjection: { syncBatchSize, syncSliceMs: 4, invaderFactionIds: "500021" } } },
    telemetry: fakeTelemetry(), logger: { warn() {}, error() {}, log() {} }, clock: { now: () => 0 }, nowMs: () => 0,
    yieldFn: async () => {} };
  return { ctx, projected };
}

const systemsOf = (n) => Array.from({ length: n }, (_, i) => ({ systemId: 30000101 + i, controllerFactionId: FACTION,
  occupationState: "OCCUPIED", phaseSeq: 1, capturedAt: 0 }));

module.exports = ({ test, skip }) => {
  const driver = loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  test("SV1 verifyAll: 5 systems per table row -> counts and sample, no projectSystem, no store transaction", async () => {
    const rows = [
      { cls: "invader", controller: INVADER, claim: null },
      { cls: "noIdentity", controller: NO_ID_FACTION, claim: null },
      { cls: "matched", controller: FACTION, claim: ALLIANCE },
      { cls: "playerProtected", controller: FACTION, claim: PLAYER_ALLIANCE, nullEvery: 2 },
      { cls: "mismatched", controller: FACTION, claim: null, otherVirtualEvery: 2 },
      { cls: "mismatched", controller: null, claim: ALLIANCE },
      { cls: "matched", controller: null, claim: null },
    ];
    const systems = [];
    const claims = new Map();
    let id = 30000100;
    const expectedMismatch = [];
    for (const row of rows) {
      for (let i = 0; i < 5; i += 1) {
        id += 1;
        const controller = row.nullEvery && i % row.nullEvery === 0 ? null : row.controller;
        systems.push({ systemId: id, controllerFactionId: controller, occupationState: "OCCUPIED", phaseSeq: 1 });
        const alliance = row.otherVirtualEvery && i % row.otherVirtualEvery === 0 ? ALLIANCE_B : row.claim;
        if (alliance !== null) claims.set(id, { allianceID: alliance, corporationID: CORP });
        if (row.cls === "mismatched") expectedMismatch.push(id);
      }
    }
    const notClaimable = new Set([30000990, 30000991]);
    for (const ss of notClaimable) systems.push({ systemId: ss, controllerFactionId: FACTION, phaseSeq: 1 });
    let projectCalls = 0;
    let txCalls = 0;
    let yields = 0;
    const sovProjection = {
      requireGame: (rel) => ({ ok: true, exports: rel.endsWith("sovSystemRules")
        ? { isSovereigntyClaimableSolarSystem: (ss) => !notClaimable.has(ss) }
        : { getSystemSovClaim: (ss) => claims.get(ss) || null } }),
      isVirtualAlliance: (a) => a === ALLIANCE || a === ALLIANCE_B,
      projectSystem: async () => { projectCalls += 1; return { ok: true }; },
    };
    const telemetry = fakeTelemetry();
    const r = await verifyAll({ sovProjection,
      persistence: { ok: true, store: { transaction: () => { txCalls += 1; return { ok: false, reason: "NO" }; } } },
      world: { listSystems: (o) => ({ systems: systems.filter((s) => s.systemId > o.afterSystemId).slice(0, o.limit) }) },
      virtualCorps: { getFactionIdentity: (f) => (f === FACTION ? { ok: true, allianceId: ALLIANCE, corporationIds: [CORP] }
        : { ok: true, allianceId: 0, corporationIds: [] }) },
      config: { world: { sovProjection: { syncBatchSize: 10, syncSliceMs: 4, invaderFactionIds: "500021" } } },
      telemetry, logger: { warn() {}, error() {}, log() {} }, clock: { now: () => 5000 }, nowMs: () => 0,
      yieldFn: async () => { yields += 1; }, verifyMaxSamples: 7 });
    assert.ok(r.ok, JSON.stringify(r));
    assert.deepStrictEqual([r.checked, r.matched, r.mismatched, r.playerProtected, r.noIdentity, r.invader, r.errors],
      [35, 10, 10, 5, 5, 5, 0], JSON.stringify(r));
    assert.deepStrictEqual(r.sample, expectedMismatch.slice(0, 7), "sample = first verifyMaxSamples mismatches");
    assert.strictEqual(r.at, 5000);
    assert.strictEqual(r.yields, yields);
    assert.ok(yields >= 3, "one macrotask between pages (37 systems / 10)");
    assert.strictEqual(projectCalls, 0, "no projectSystem");
    assert.strictEqual(txCalls, 0, "no store transaction");
    assert.strictEqual(telemetry.gaugeOf("sovProjection.verify.mismatched"), 10);
    assert.strictEqual(telemetry.observed("sovProjection.verifyMs").length, 1);
    assert.strictEqual(telemetry.get("sovProjection.syncYields"), 0, "verify does not count sync yields");
  });

  needsDriver("SV2 verify after the drain: once, not again before verifyMinIntervalMs, again at it; off = never", async () => {
    await withStore(driver, async (store) => {
      const [A, B] = [30000101, 30000102];
      const h = serviceHarness(store, { systems: [A, B], maxWrites: 1 });
      await h.started.whenReady;
      await h.settle();
      assert.strictEqual(h.svc.getStatus().syncState, "done");
      assert.strictEqual(h.svc.getStatus().defer.depth, 1, "boot syncAll: 1 projected, 1 deferred");
      assert.strictEqual(h.svc.getStatus().verify, null, "queue not empty -> no verify yet");

      await h.fireTimer();
      assert.strictEqual(h.svc.getStatus().defer.depth, 0);
      const v1 = h.svc.getStatus().verify;
      assert.ok(v1 && v1.ok, JSON.stringify(v1));
      assert.deepStrictEqual([v1.checked, v1.matched, v1.mismatched], [2, 2, 0], JSON.stringify(v1));
      assert.strictEqual(h.telemetry.observed("sovProjection.verifyMs").length, 1);
      const v1At = v1.at;

      h.move(A, FACTION_B);
      const r2 = await h.svc.requestProject(A);
      assert.strictEqual(r2.deferred, true, JSON.stringify(r2));
      await h.fireTimer();
      assert.strictEqual(h.svc.getStatus().defer.depth, 0);
      assert.strictEqual(h.telemetry.observed("sovProjection.verifyMs").length, 1, "inside the interval -> no verify");
      assert.strictEqual(h.svc.getStatus().verify.at, v1At);

      h.move(B, FACTION_B);
      const r3 = await h.svc.requestProject(B);
      assert.strictEqual(r3.deferred, true, JSON.stringify(r3));
      await h.fireTimer();
      assert.strictEqual(h.telemetry.observed("sovProjection.verifyMs").length, 2, "interval passed -> verify");
      assert.strictEqual(h.svc.getStatus().verify.at, v1At + 600000);
      assert.strictEqual(h.svc.getStatus().verify.mismatched, 0);
      assert.strictEqual(h.pending().length, 0, "empty queue = no timer");
      stopSovProjection(h.ctx);
    });
    await withStore(driver, async (store) => {
      const h = serviceHarness(store, { systems: [30000101, 30000102], maxWrites: 1, verifyAfterDrain: false });
      await h.started.whenReady;
      await h.settle();
      await h.fireTimer();
      assert.strictEqual(h.svc.getStatus().defer.depth, 0);
      assert.strictEqual(h.svc.getStatus().verify, null, "verifyAfterDrain=false -> never");
      assert.strictEqual(h.telemetry.observed("sovProjection.verifyMs").length, 0);
      stopSovProjection(h.ctx);
    });
  });

  needsDriver("SV3 DEFER_FULL: 17 deferred into 16 -> resyncNeeded; after the drain one resync syncAll, flag false", async () => {
    await withStore(driver, async (store) => {
      const ids = Array.from({ length: 18 }, (_, i) => 30000101 + i);
      const h = serviceHarness(store, { systems: ids, maxWrites: 1, deferMaxSystems: 16 });
      await h.started.whenReady;
      await h.settle();
      let st = h.svc.getStatus();
      assert.deepStrictEqual([st.syncState, st.defer.depth, st.defer.dropped, st.resyncNeeded], ["done", 16, 1, true],
        JSON.stringify(st));
      assert.strictEqual(st.lastSync.kind, "boot");
      assert.strictEqual(h.telemetry.get("sovProjection.deferDropped"), 1);

      for (let i = 0; i < 40 && h.pending().length > 0; i += 1) await h.fireTimer();
      st = h.svc.getStatus();
      assert.strictEqual(h.telemetry.get("sovProjection.resyncRuns"), 1, "one resync syncAll");
      assert.strictEqual(st.resyncNeeded, false);
      assert.strictEqual(st.lastSync.kind, "resync");
      assert.strictEqual(st.syncState, "done");
      assert.strictEqual(st.defer.depth, 0);
      assert.deepStrictEqual([...new Set(h.vendorCalls.map((c) => c[0]))].sort(), ids, "the dropped system projected too");
      assert.ok(st.verify && st.verify.ok && st.verify.mismatched === 0, JSON.stringify(st.verify));
      assert.strictEqual(h.logs.filter((l) => l.includes("resync syncAll")).length, 1);
      stopSovProjection(h.ctx);
    });
  });

  needsDriver("SV4 panel sov-projection: first verify after a boot syncAll with an empty queue; getData keys, no tx", async () => {
    await withStore(driver, async (store) => {
      const h = serviceHarness(store, { systems: [30000101], maxWrites: 8 });
      await h.started.whenReady;
      await h.settle();
      const view = h.views.getView("sov-projection");
      assert.ok(view, "panel registered");
      assert.strictEqual(view.order, 63);
      assert.strictEqual(view.cacheKey(), null);
      const before = h.txCount();
      const data = view.getData();
      assert.strictEqual(h.txCount(), before, "getData opens no transaction");
      for (const k of STATUS_KEYS) assert.ok(Object.prototype.hasOwnProperty.call(data, k), `key ${k}`);
      assert.deepStrictEqual([data.state, data.syncState, data.resyncNeeded], ["ready", "done", false]);
      assert.strictEqual(data.lastSync.ok, true);
      assert.strictEqual(data.defer.depth, 0);
      assert.ok(data.verify && data.verify.ok && data.verify.matched === 1, JSON.stringify(data.verify));
      assert.strictEqual(h.telemetry.gaugeOf("sovProjection.verify.mismatched"), 0);
      assert.ok(h.logs.some((l) => l.includes("[sovProjection] verify: checked=1")), "verify log line");
      JSON.stringify(data);
      stopSovProjection(h.ctx);
      assert.strictEqual(h.views.getView("sov-projection"), null, "stop unregisters the panel");
    });
  });

  test("SV5 verifyAll: listSystems refusal {ok:false} on page 2 -> ok:false LIST_SYSTEMS_FAILED", async () => {
    const listing = pagedListing(systemsOf(12), { refusePage: 2 });
    const { ctx } = pureScanCtx(listing, 5);
    const r = await verifyAll(ctx);
    assert.strictEqual(r.ok, false, JSON.stringify(r));
    assert.strictEqual(r.reason, "LIST_SYSTEMS_FAILED: TX_BUSY");
    assert.strictEqual(r.checked, undefined, "no partial counts");
    assert.deepStrictEqual(listing.calls, [0, 30000105], "stopped at the refused page");
    assert.strictEqual(ctx.telemetry.gaugeOf("sovProjection.verify.mismatched"), undefined, "no false 0 gauge");
  });

  needsDriver("SV6 syncAll: listSystems refusal on page 2 -> ok:false; service boot syncState failed", async () => {
    const listing = pagedListing(systemsOf(12), { refusePage: 2 });
    const { ctx, projected } = pureScanCtx(listing, 5);
    const r = await syncAll(ctx);
    assert.strictEqual(r.ok, false, JSON.stringify(r));
    assert.strictEqual(r.reason, "LIST_SYSTEMS_FAILED: TX_BUSY");
    assert.deepStrictEqual(projected, systemsOf(5).map((s) => s.systemId), "page 1 projected, then the scan stops");

    await withStore(driver, async (store) => {
      const h = serviceHarness(store, { systems: [30000101], maxWrites: 8,
        listSystems: () => ({ ok: false, reason: "TX_BUSY" }) });
      await h.started.whenReady;
      await h.settle();
      const st = h.svc.getStatus();
      assert.strictEqual(st.syncState, "failed", JSON.stringify(st));
      assert.strictEqual(h.vendorCalls.length, 0);
      stopSovProjection(h.ctx);
    });
  });

  test("SV7 syncBatchSize 5 > maxListLimit 2: pages by nextAfterSystemId, verify and syncAll see all 7", async () => {
    const all = systemsOf(7).map((s) => s.systemId);
    const vListing = pagedListing(systemsOf(7), { maxListLimit: 2 });
    const v = await verifyAll(pureScanCtx(vListing, 5).ctx);
    assert.ok(v.ok, JSON.stringify(v));
    assert.deepStrictEqual([v.checked, v.mismatched], [7, 7], JSON.stringify(v));
    assert.deepStrictEqual(vListing.calls, [0, 30000102, 30000104, 30000106], "4 trimmed pages, last one says null");

    const sListing = pagedListing(systemsOf(7), { maxListLimit: 2 });
    const s = pureScanCtx(sListing, 5);
    const r = await syncAll(s.ctx);
    assert.ok(r.ok, JSON.stringify(r));
    assert.deepStrictEqual(s.projected, all, "every system projected");
    assert.strictEqual(r.processed, 7);
  });

  test("SV8 listing without nextAfterSystemId that repeats the same page -> verifyAll and syncAll BAD_CURSOR", async () => {
    const stuckListing = () => {
      const calls = [];
      const fn = (o) => {
        calls.push(o.afterSystemId);
        if (calls.length > 10) throw new Error("LOOP_GUARD");
        return { ok: true, systems: systemsOf(3) };
      };
      fn.calls = calls;
      return fn;
    };
    const vListing = stuckListing();
    const v = await verifyAll(pureScanCtx(vListing, 5).ctx);
    assert.strictEqual(v.ok, false, JSON.stringify(v));
    assert.strictEqual(v.reason, "LIST_SYSTEMS_FAILED: BAD_CURSOR 30000103 after 30000103");
    assert.deepStrictEqual(vListing.calls, [0, 30000103], "stopped on the second (same) page");

    const sListing = stuckListing();
    const s = pureScanCtx(sListing, 5);
    const r = await syncAll(s.ctx);
    assert.strictEqual(r.ok, false, JSON.stringify(r));
    assert.strictEqual(r.reason, "LIST_SYSTEMS_FAILED: BAD_CURSOR 30000103 after 30000103");
    assert.deepStrictEqual(sListing.calls, [0, 30000103]);
  });
};
