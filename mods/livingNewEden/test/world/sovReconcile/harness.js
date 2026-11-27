"use strict";

const assert = require("node:assert");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");

const { findServerSrcOnDisk, GAMESTORE_SEARCH_MAX_DEPTH } = require("../../../lib/adapter/locator");
const { resolveSqliteDriver } = require("../../../lib/adapter/sqliteDriver");
const { MIGRATIONS } = require("../../../lib/persistence/migrations");
const { openStore } = require("../../../lib/persistence/store");
const { seedDbFile } = require("../../_support/dbTemplate");
const { createJournal } = require("../../../lib/persistence/journal");
const { createWorldStateRepository } = require("../../../lib/world/worldStateRepository");
const { createOccupationService } = require("../../../lib/world/occupation/occupationService");
const { startSovProjection, stopSovProjection } = require("../../../lib/world/sovProjection");
const { getLog, upsertLog } = require("../../../lib/world/sovProjection/repository");
const { startSovReconcile, stopSovReconcile } = require("../../../lib/world/sovReconcile");
const { createAdapter } = require("../../../lib/adapter");
const { resolveConfig } = require("../../../config");
const { createLoadGovernor, normalizeOptions } = require("../../../lib/telemetry/loadGovernor");
const { governorOptionsFromConfig } = require("../../../lib/telemetry/governorService");
const { filetime } = require("../../_support/fakeSovNative");

const MOD_DIR = path.resolve(__dirname, "..", "..", "..");
const FAKE_SRC = path.resolve(os.tmpdir(), "lne-fake-evejs-src");
const T0 = 1700000000000;

function loadDriver() {
  const found = findServerSrcOnDisk(MOD_DIR, GAMESTORE_SEARCH_MAX_DEPTH, fs.existsSync);
  if (!found.ok) return { ok: false, detail: found.reason };
  return resolveSqliteDriver(found.srcDir);
}

function createVendor() {
  const claims = new Map();
  const receipts = new Map();
  const calls = [];
  const faults = { claimThrows: false };
  let marker = 0;
  const freeze = (o) => Object.freeze(o);
  const modules = {
    "services/sovereignty/sovGmState": {
      anchorSovereigntyHub: (ss, alliance, corp) => {
        calls.push(["anchor", ss, alliance]);
        claims.set(ss, freeze({ allianceID: alliance, corporationID: corp, claimStructureID: 1 }));
        return { success: true };
      },
      loseSystemSovereignty: (ss) => {
        calls.push(["lose", ss]);
        claims.delete(ss);
        return { success: true };
      },
      reinforceSystemHub: (ss) => {
        calls.push(["reinforce", ss]);
        return { success: true };
      },
    },
    "services/sovereignty/sovState": {
      getSystemSovClaim: (ss) => {
        if (faults.claimThrows) throw new Error("INJECTED_CLAIM_FAULT");
        return claims.get(ss) || null;
      },
      getSystemState: (ss) => freeze({ solarSystemID: ss,
        campaignOutcomeReceipts: freeze(Object.fromEntries(receipts.get(ss) || new Map())) }),
    },
    "services/sovereignty/sovStore": { readSovereigntyTableUpdatedAt: () => `m${(marker += 1)}` },
    "services/sovereignty/sovSystemRules": { isSovereigntyClaimableSolarSystem: () => true },
    "gameStore/index": { flushTableSync: () => ({ success: true }) },
  };
  function addReceipt(ss, { allianceId, result, completedAtMs, epoch }) {
    const map = receipts.get(ss) || new Map();
    receipts.set(ss, map);
    map.set(`${ss}:${epoch}`, freeze({ schemaVersion: 1, targetID: ss, solarSystemID: ss, campaignEpoch: epoch,
      defenderAllianceID: allianceId, result, completedAtTime: filetime(completedAtMs),
      destroyedNotificationDeliveredAtTime: "0", nodeIDs: freeze([]), drop: null }));
  }
  return {
    claims, calls, faults, modules, addReceipt,
    setClaim: (ss, allianceId) => claims.set(ss, freeze({ allianceID: allianceId, corporationID: allianceId + 1,
      claimStructureID: 1 })),
    destroyHub: (ss, allianceId, completedAtMs, epoch = `att-${ss}`) => {
      addReceipt(ss, { allianceId, result: "attacker", completedAtMs, epoch });
      claims.delete(ss);
    },
  };
}

function cacheOf(vendor) {
  const cache = {};
  for (const [rel, exportsObject] of Object.entries(vendor.modules)) {
    cache[path.join(FAKE_SRC, `${rel}.js`)] = { exports: exportsObject };
  }
  return cache;
}

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

async function settle(n = 5) {
  for (let i = 0; i < n; i += 1) await new Promise((r) => setImmediate(r));
}

async function withHarness(fn, opts = {}) {
  const driver = loadDriver();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lne-sovrec-"));
  const file = path.join(tmp, "world.sqlite");
  seedDbFile(driver, file, { migrations: MIGRATIONS, seed: 1 });
  const opened = openStore({ filePath: file, openDatabase: (f) => new driver.Database(f), exclusiveLock: true,
    busyTimeoutMs: 0, maxRowsPerTransaction: 500, maxWriteMsPerPass: 5, randomSeed: () => 1, migrations: MIGRATIONS });
  assert.ok(opened.ok, JSON.stringify(opened));
  const store = opened.store;
  const started = [];
  try {
    const resolved = resolveConfig({ modDir: MOD_DIR, env: {
      EVEJS_LNE_SOVPROJECTION_ENABLED: "1",
      EVEJS_LNE_WORLD_SOVRECONCILE_ENABLED: "1",
      EVEJS_LNE_WORLD_SOVPROJECTION_PROJECTION_MIN_SPACING_MS: "0",
      EVEJS_LNE_WORLD_SOVPROJECTION_PROJECTION_COST_FACTOR: "0",
      ...(opts.env || {}),
    } });
    const config = resolved.config;
    let now = T0;
    const clock = { now: () => now, advance: (ms) => { now += ms; } };
    const journal = createJournal({ clock, maxPayloadBytes: 4096, maxRows: 100000 });
    const repo = createWorldStateRepository({ journal, clock, limits: { maxFactionsPerSystem: config.world.maxFactionsPerSystem,
      maxBatchReadIds: config.world.maxBatchReadIds, maxListLimit: config.world.maxListLimit } });
    const unwrap = (r) => (r && r.ok ? r.value : { ok: false, reason: (r && r.reason) || "TX_FAILED" });
    const world = {
      repository: repo,
      getSystem: (id, o) => unwrap(store.transaction("world.getSystem", (tx) => repo.getSystem(tx, id, o))),
      listSystems: () => ({ ok: true, systems: [], nextAfterSystemId: null }),
    };
    const occupation = createOccupationService({ store, repository: repo,
      fleets: { repository: { listFleetsInSystem: () => ({ ok: true, fleets: [] }) } }, scheduler: null, clock, config });
    started.push(() => occupation.stop && occupation.stop());

    const identities = new Map(opts.identities || []);
    const vcReady = deferred();
    vcReady.resolve();
    const virtualCorps = {
      whenReady: () => vcReady.promise,
      getFactionIdentity: (f) => (identities.has(f)
        ? { ok: true, allianceId: identities.get(f), corporationIds: [identities.get(f) + 1], characterIds: [] }
        : { ok: true, allianceId: 0, corporationIds: [], characterIds: [] }),
      isVirtualAlliance: (a) => [...identities.values()].includes(a),
    };

    const vendor = createVendor();
    const adapter = createAdapter({ moduleApi: { _cache: cacheOf(vendor) } });
    adapter.setServerSrc(FAKE_SRC);
    adapter.markBooted();
    adapter.getProcessRole = () => "world";

    const options = normalizeOptions({ ...governorOptionsFromConfig(config), signal: "p95" }).options;
    const governor = createLoadGovernor({ options, tickAvailable: true, nowMs: 0 });
    let govAt = 0;
    const feedAt = (tickMs, at) => {
      for (let i = 0; i < options.sampleCount; i += 1) governor.record(tickMs, at);
      return governor.evaluate(at).mode;
    };
    const setLoad = (tickMs) => {
      govAt += 1000;
      let mode = feedAt(tickMs, govAt);
      for (let i = 0; i < 8 && mode !== "NORMAL" && tickMs < options.warningP95Ms; i += 1) {
        govAt += Math.max(options.recoveryMs, options.minModeHoldMs) + 1;
        mode = feedAt(tickMs, govAt);
      }
      return mode;
    };
    setLoad(100);

    const logs = [];
    const logger = { log: (m) => logs.push(m), error: (m) => logs.push(m) };
    const telemetry = { count() {}, gauge() {}, observe() {} };
    const timers = [];
    const setTimer = (f, ms) => { timers.push(ms); return { cancel() {}, hasRef: () => false }; };
    const ctx = { config, persistence: { ok: true, store, journal }, adapter, virtualCorps, occupation, world,
      telemetry, logger, clock, getGovernor: () => governor, fail: () => {}, setTimer };

    const proj = startSovProjection(ctx);
    assert.ok(proj.ok, JSON.stringify(proj));
    started.push(() => stopSovProjection(ctx));
    await proj.whenReady;
    for (let i = 0; i < 50 && !["done", "failed"].includes(ctx.sovProjection.getStatus().syncState); i += 1) await settle(1);
    assert.strictEqual(ctx.sovProjection.getStatus().syncState, "done");

    const h = {
      store, clock, journal, repo, world, occupation, virtualCorps, vendor, adapter, config, governor, setLoad, logs,
      ctx, identities,
      seedSystem(ss, factionId, state = {}) {
        const r = store.transaction("t.seed", (tx) => repo.applyChange(tx, { systemId: ss, expectedVersion: 0,
          reason: "SEED_CONTROL", state: { securityClass: "nullsec", controllerFactionId: factionId },
          influence: [{ factionId, influenceScore: 60 }] }, `t:seed:${ss}`));
        assert.ok(r.ok && r.value.ok, JSON.stringify(r));
        if (Object.keys(state).length > 0) h.setState(ss, state);
      },
      setState(ss, state) {
        const cur = h.system(ss);
        const r = store.transaction("t.state", (tx) => repo.applyChange(tx, { systemId: ss, expectedVersion: cur.version,
          reason: "TEST_STATE", state }, `t:state:${ss}:${cur.version}`));
        assert.ok(r.ok && r.value.ok, JSON.stringify(r));
      },
      system: (ss) => world.getSystem(ss, { includeInfluence: true }).system,
      influenceOf: (ss, f) => (h.system(ss).influence || []).find((i) => i.factionId === f)?.influenceScore,
      logOf(ss) {
        const r = store.transaction("t.getLog", (tx) => getLog(tx, ss));
        return r.value.ok ? r.value.value : null;
      },
      writeLog(ss, spec) {
        const cur = h.logOf(ss);
        const r = store.transaction("t.upsertLog", (tx) => upsertLog(tx, { systemId: ss, controller: null, alliance: null,
          corp: null, action: "LOSS", seq: 0, ...spec, expectedVersion: cur ? cur.version : 0, now: clock.now() }));
        assert.ok(r.ok && r.value.ok, JSON.stringify(r));
      },
      episodes: (ss) => store.transaction("t.ep", (tx) => tx.prepare(
        "SELECT * FROM world_sov_reconcile WHERE system_id = ?").all(ss)).value,
      facts: (like) => store.transaction("t.facts", (tx) => tx.prepare(
        "SELECT idempotency_key, event_type FROM world_event_journal WHERE idempotency_key LIKE ? ORDER BY journal_id")
        .all(like)).value,
      async gain(ss) {
        const r = await ctx.sovProjection.requestProject(ss);
        assert.ok(r.ok && r.action === "GAIN", JSON.stringify(r));
      },
      async startReconcile(over = {}) {
        const rctx = { ...ctx, ...over };
        const r = startSovReconcile(rctx);
        assert.ok(r.ok, JSON.stringify(r));
        started.push(() => stopSovReconcile(rctx));
        await settle(1);
        return r.service;
      },
    };
    await fn(h);
  } finally {
    for (const stop of started.reverse()) {
      try { stop(); } catch (_err) {}
    }
    store.close("test_cleanup");
    try {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch (_err) {
    }
  }
}

module.exports = { withHarness, loadDriver, deferred, settle, T0, FAKE_SRC };
