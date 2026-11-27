"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { findServerSrcOnDisk, GAMESTORE_SEARCH_MAX_DEPTH } = require("../../lib/adapter/locator");
const { resolveSqliteDriver } = require("../../lib/adapter/sqliteDriver");
const { MIGRATIONS, LATEST_SCHEMA_VERSION } = require("../../lib/persistence/migrations");
const { openStore } = require("../../lib/persistence/store");
const { seedDbFile } = require("../_support/dbTemplate");
const { createFakeDungeonRuntime } = require("../_support/fakeDungeonRuntime");
const dungeonSites = require("../../lib/adapter/dungeonSites");
const { resolveConfig } = require("../../config");
const siteRepository = require("../../lib/events/sites/siteRepository");
const { createSiteService, buildEnsureSpec } = require("../../lib/events/sites/siteService");
const { startSites, unavailableSites } = require("../../lib/events/sites");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const T0 = 1700000000000;
const HOUR = 3600000;
const SYS = [30000001, 30000002, 30000003, 30000004, 30000005, 30000006];

function loadDriver() {
  const found = findServerSrcOnDisk(MOD_DIR, GAMESTORE_SEARCH_MAX_DEPTH, fs.existsSync);
  if (!found.ok) return { ok: false, detail: found.reason };
  return resolveSqliteDriver(found.srcDir);
}

function configOf(env = {}) {
  const r = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_SITES_ENABLED: "1", ...env } });
  assert.deepStrictEqual(r.errors, []);
  return r.config;
}

function withStore(driver, fn, { fresh = false } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lne-sites-"));
  const file = path.join(tmp, "world.sqlite");
  let store = null;
  try {
    if (!fresh) seedDbFile(driver, file, { migrations: MIGRATIONS, seed: 1 });
    const opened = openStore({ filePath: file, openDatabase: (f) => new driver.Database(f), exclusiveLock: true,
      busyTimeoutMs: 0, maxRowsPerTransaction: 500, maxWriteMsPerPass: 5, randomSeed: () => 1,
      migrations: MIGRATIONS });
    assert.ok(opened.ok, JSON.stringify(opened));
    store = opened.store;
    return fn(store, opened);
  } finally {
    if (store) store.close("test");
    try {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch (_err) {
    }
  }
}

function fakeWorld() {
  const raw = createFakeDungeonRuntime();
  const calls = { create: [], setLifecycle: [], purge: [] };
  const flags = { parked: false };
  const runtime = {
    ...raw,
    createInstance(opts) {
      calls.create.push(opts.siteKey);
      return raw.createInstance(opts);
    },
    setLifecycleState(id, state, opts) {
      calls.setLifecycle.push({ id, state, expiresAtMs: opts && opts.expiresAtMs });
      return raw.setLifecycleState(id, state, opts);
    },
    purgeInstance(id) {
      calls.purge.push(id);
      return raw.purgeInstance(id);
    },
  };
  const mods = {
    dungeonRuntime: runtime,
    dungeonAuthority: { getTemplateByID: (id) => (id === "missing" ? null
      : { templateID: id, siteFamily: "combat", siteKind: "anomaly", entryObjectTypeID: 12345 }) },
    siteService: { isUniverseSiteTeardownParked: () => flags.parked },
    placement: { buildAnchorRelativeSignaturePlacement: (candidates) => ({
      position: { x: candidates[0].position.x + 598391482800, y: 0, z: 0 } }) },
    worldData: {
      getCelestialsForSystem: () => [{ itemID: 40000001, position: { x: 1e9, y: 0, z: 0 }, groupID: 7 }],
      getAsteroidBeltsForSystem: () => [],
      getStationsForSystem: () => [],
      getStargatesForSystem: () => [],
      getSolarSystemByID: () => ({ radius: 1e10 }),
    },
    gameStore: { flushTableSync: () => ({ success: true }) },
  };
  const seam = {
    ok: true,
    ensureSite: (spec) => dungeonSites.ensureSiteFrom(mods, spec),
    readSite: (key) => dungeonSites.readSiteFrom(mods, key),
    extendSite: (key, at, now) => dungeonSites.extendSiteFrom(mods, key, at, now),
    despawnSite: (key, reason, now) => dungeonSites.despawnSiteFrom(mods, key, reason, now),
    purgeSite: (key, sys) => dungeonSites.purgeSiteFrom(mods, key, sys),
  };
  const adapter = { getDungeonSites: () => seam, checkDungeonSites: () => ({ ok: true }) };
  return { raw, calls, flags, adapter };
}

function fakeTelemetry() {
  const counters = {};
  return { counters, count(name, n = 1) { counters[name] = (counters[name] || 0) + n; return true; },
    observe() { return true; } };
}

function harness(store, opts = {}) {
  const world = opts.world || fakeWorld();
  const clock = { t: T0, now() { return this.t; } };
  const telemetry = fakeTelemetry();
  const config = opts.config || configOf(opts.env);
  const make = (extra = {}) => createSiteService({ store, adapter: world.adapter, clock, config, telemetry,
    logger: { log() {} }, ...extra });
  const svc = make();
  const events = [];
  svc.addSiteStateListener((e) => events.push(e));
  const tx = (fn) => {
    const r = store.transaction("test", fn);
    assert.ok(r.ok, JSON.stringify(r));
    return r.value;
  };
  return {
    world, clock, telemetry, config, svc, events, make, tx,
    create: (req, s = svc) => tx((db) => s.createSiteInTx(db, req)),
    pass(at, s = svc) {
      clock.t = at;
      const r = s.runPass(at);
      assert.ok(r.ok, JSON.stringify(r));
      return r;
    },
    rows: (eventId) => {
      const r = svc.listSitesByEvent(eventId);
      assert.ok(r.ok, JSON.stringify(r));
      return r.sites;
    },
    raw: (eventId) => tx((db) => siteRepository.listByEventInTx(db, eventId)),
  };
}

function req(eventId, slot, systemId, extra = {}) {
  return { eventId, slot, systemId, templateId: "tpl_combat", label: "LNE site", factionId: 500001,
    expiresAt: T0 + HOUR, ...extra };
}

module.exports = ({ test, skip }) => {
  const driver = loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  needsDriver("B0 migration 25 world_event_sites from zero: STRICT table, partial due index, stub refuses",
    () => withStore(driver, (store, opened) => {
      assert.deepStrictEqual([opened.schemaVersion, opened.applied], [LATEST_SCHEMA_VERSION, LATEST_SCHEMA_VERSION]);
      assert.ok(LATEST_SCHEMA_VERSION >= 25);
      assert.deepStrictEqual([MIGRATIONS[24].version, MIGRATIONS[24].name], [25, "world_event_sites"]);
      const r = store.transaction("t", (db) => db.prepare("SELECT name, sql FROM sqlite_master "
        + "WHERE tbl_name = 'world_event_sites' ORDER BY name").all());
      const byName = Object.fromEntries(r.value.map((x) => [x.name, x.sql || ""]));
      assert.ok(/\) STRICT$/.test(byName.world_event_sites.trim()), byName.world_event_sites);
      assert.ok(/WHERE state NOT IN \('PURGED', 'FAILED'\)/.test(byName.world_event_sites_due));
      assert.ok(byName.world_event_sites_system);
      const stub = unavailableSites("SITES_DISABLED");
      assert.strictEqual(stub.createSiteInTx({}, {}).reason, "SITES_DISABLED");
      assert.strictEqual(stub.listSitesByEvent("e").reason, "SITES_DISABLED");
      assert.strictEqual(typeof stub.addSiteStateListener(() => {}), "function");
      const defaults = resolveConfig({ modDir: MOD_DIR, env: {} });
      assert.deepStrictEqual([defaults.config.modules.sites.enabled, defaults.warnings], [false, []]);
      assert.strictEqual(startSites({ config: defaults.config }).reason, "disabled_by_config");
    }, { fresh: true }));

  needsDriver("B1 request: same request twice -> one row, one createInstance; other template -> "
    + "IDEMPOTENCY_CONFLICT; 3rd site in the system window -> SYSTEM_WINDOW_FULL; maxActiveSites -> SITES_FULL",
  () => withStore(driver, (store) => {
    const h = harness(store, { env: { EVEJS_LNE_SITES_MAX_ACTIVE_SITES: "3" } });
    const first = h.create(req("ev1", 0, SYS[0]));
    assert.deepStrictEqual(first, { ok: true, siteKey: "lne:ev1:0", created: true, state: "CREATING" });
    assert.deepStrictEqual(h.create(req("ev1", 0, SYS[0])),
      { ok: true, siteKey: "lne:ev1:0", created: false, state: "CREATING" });
    h.pass(T0 + 1000);
    assert.strictEqual(h.create(req("ev1", 0, SYS[0])).created, false);
    h.pass(T0 + 2000);
    assert.deepStrictEqual(h.world.calls.create, ["lne:ev1:0"]);
    assert.strictEqual(h.rows("ev1").length, 1);
    assert.strictEqual(h.create(req("ev1", 0, SYS[0], { templateId: "tpl_other" })).reason,
      "IDEMPOTENCY_CONFLICT");
    assert.strictEqual(h.create(req("ev1", 1, SYS[0])).created, true);
    assert.strictEqual(h.create(req("ev1", 2, SYS[0])).reason, "SYSTEM_WINDOW_FULL");
    assert.strictEqual(h.create(req("ev2", 0, SYS[1])).created, true);
    assert.strictEqual(h.create(req("ev3", 0, SYS[2])).reason, "SITES_FULL");
    assert.strictEqual(h.create(req("ev3", 4, SYS[2])).reason, "SITE_REQUEST_INVALID");
    assert.strictEqual(h.create(req("ev3", 0, SYS[2], { expiresAt: T0 - 1 })).reason, "SITE_REQUEST_INVALID");
    assert.strictEqual(h.telemetry.counters["sites.refused.IDEMPOTENCY_CONFLICT"], 1);
    const row = h.raw("ev2")[0];
    assert.strictEqual(dungeonSites.validateSpec(buildEnsureSpec(row, T0 + 3000, h.config.sites)), null);
    assert.strictEqual(h.tx(() => h.svc.listSitesByEvent("ev1")).reason, "TX_ACTIVE");
  }));

  needsDriver("B2 budget: 5 requests, maxWritesPerPass 2 -> createInstance 2, 2, 1; governor without "
    + "OPERATIONAL -> 0", () => withStore(driver, (store) => {
    const h = harness(store);
    for (let i = 0; i < 5; i += 1) assert.strictEqual(h.create(req(`ev${i}`, 0, SYS[i])).created, true);
    const held = h.make({ getGovernor: () => ({ admits: (c) => c !== "OPERATIONAL" }) });
    const r0 = h.pass(T0 + 500, held);
    assert.deepStrictEqual([r0.skipped, r0.vendorWrites, h.world.calls.create.length], ["GOVERNOR", 0, 0]);
    const writes = [];
    const creates = [];
    for (const at of [T0 + 1000, T0 + 2000, T0 + 3000]) {
      const before = h.world.calls.create.length;
      writes.push(h.pass(at).vendorWrites);
      creates.push(h.world.calls.create.length - before);
    }
    assert.deepStrictEqual([writes, creates], [[2, 2, 1], [2, 2, 1]]);
    assert.strictEqual(h.telemetry.counters["sites.created"], 5);
  }));

  needsDriver("B3 crash and instance ID reuse: (a) crash before the ACTIVE commit -> adoption "
    + "one createInstance; (b) vendor rollback + foreign instance with our ID -> LOST, one recreation; (c) cleanup "
    + "of an ACTIVE row caching a foreign ID -> no mutation of that ID, PURGED", () => {
    withStore(driver, (store) => {
      const h = harness(store);
      let thrown = false;
      const crashing = { ...siteRepository, transitionInTx(tx, row, patch) {
        if (patch.state === "ACTIVE" && !thrown) {
          thrown = true;
          throw new Error("crash before the ACTIVE commit");
        }
        return siteRepository.transitionInTx(tx, row, patch);
      } };
      h.create(req("eva", 0, SYS[0]));
      h.pass(T0 + 1000, h.make({ repository: crashing }));
      assert.deepStrictEqual([thrown, h.raw("eva")[0].state, h.world.calls.create.length], [true, "CREATING", 1]);
      const restarted = h.make();
      h.pass(T0 + 2000, restarted);
      const adopted = h.raw("eva")[0];
      assert.deepStrictEqual([adopted.state, adopted.vendorExpiresAt, h.telemetry.counters["sites.adopted"]],
        ["ACTIVE", null, 1]);
      h.pass(T0 + 3000, restarted);
      assert.strictEqual(h.raw("eva")[0].vendorExpiresAt, T0 + HOUR + HOUR, "synced without a write");
      assert.deepStrictEqual([h.world.calls.create.length, h.world.calls.setLifecycle.length], [1, 0]);
    });
    withStore(driver, (store) => {
      const h = harness(store);
      h.create(req("evb", 0, SYS[0]));
      h.world.raw.snapshot();
      h.pass(T0 + 1000);
      const ourId = h.raw("evb")[0].instanceId;
      h.world.raw.restore();
      const foreign = h.world.raw.createInstance({ siteKey: "native:1", templateID: "x", solarSystemID: SYS[0] });
      assert.strictEqual(foreign.instanceID, ourId, "the foreign instance reuses our ID");
      h.pass(T0 + 1000 + 30000);
      assert.strictEqual(h.raw("evb")[0].state, "LOST");
      h.pass(T0 + 32000);
      h.pass(T0 + 33000);
      const row = h.raw("evb")[0];
      assert.deepStrictEqual([row.state, row.recreateCount], ["ACTIVE", 1]);
      assert.notStrictEqual(row.instanceId, ourId);
      assert.deepStrictEqual(h.world.calls.create, ["lne:evb:0", "lne:evb:0"]);
      const ours = [...h.world.raw._instances.values()].filter((i) => i.siteKey === "lne:evb:0");
      assert.strictEqual(ours.length, 1, "one active instance of our siteKey");
      assert.deepStrictEqual([h.world.calls.setLifecycle, h.world.calls.purge], [[], []]);
      assert.deepStrictEqual(h.events.map((e) => e.state), ["LOST"]);
    });
    withStore(driver, (store) => {
      const h = harness(store);
      h.create(req("evc", 0, SYS[0]));
      h.world.raw.snapshot();
      h.pass(T0 + 1000);
      const cachedId = h.raw("evc")[0].instanceId;
      h.world.raw.restore();
      h.world.raw.createInstance({ siteKey: "native:2", templateID: "x", solarSystemID: SYS[0] });
      assert.deepStrictEqual(h.tx((db) => h.svc.cleanupSitesInTx(db, "evc", "EVENT_END")), { ok: true, released: 1 });
      h.pass(T0 + 2000);
      h.pass(T0 + 2000 + 600000);
      assert.strictEqual(h.raw("evc")[0].state, "PURGED");
      assert.deepStrictEqual([h.world.calls.setLifecycle.filter((c) => c.id === cachedId),
        h.world.calls.purge.filter((id) => id === cachedId)], [[], []]);
      assert.strictEqual(h.world.raw._instances.has(String(cachedId)), true, "the foreign instance survives");
    });
  });

  needsDriver("B4 cleanup: twice -> released 1 then 0, one despawn; ACTIVE after expires_at -> CLEANING -> "
    + "CLEANED -> PURGED; parked teardown -> deferred, then purged; PURGED listener once per site", () =>
    withStore(driver, (store) => {
      const h = harness(store);
      h.create(req("eva", 0, SYS[0]));
      h.create(req("evb", 0, SYS[1]));
      h.pass(T0 + 1000);
      const idA = h.raw("eva")[0].instanceId;
      h.clock.t = T0 + 2000;
      assert.deepStrictEqual(h.tx((db) => h.svc.cleanupSitesInTx(db, "eva", "EVENT_END")), { ok: true, released: 1 });
      assert.deepStrictEqual(h.tx((db) => h.svc.cleanupSitesInTx(db, "eva", "EVENT_END")), { ok: true, released: 0 });
      h.pass(T0 + 3000);
      h.pass(T0 + 4000);
      assert.deepStrictEqual(h.world.calls.setLifecycle.filter((c) => c.id === idA).map((c) => c.state),
        ["despawned"]);
      assert.strictEqual(h.raw("eva")[0].state, "CLEANED");
      h.world.flags.parked = true;
      h.pass(T0 + 3000 + 600000);
      assert.deepStrictEqual([h.raw("eva")[0].state, h.telemetry.counters["sites.purgeDeferred"]], ["CLEANED", 1]);
      h.world.flags.parked = false;
      h.pass(T0 + 3000 + 600000 + 60000);
      assert.deepStrictEqual([h.raw("eva")[0].state, h.world.calls.purge], ["PURGED", [idA]]);
      const end = T0 + HOUR;
      h.pass(end);
      assert.strictEqual(h.raw("evb")[0].state, "CLEANING");
      h.pass(end + 1000);
      assert.strictEqual(h.raw("evb")[0].state, "CLEANED");
      h.pass(end + 1000 + 600000);
      assert.strictEqual(h.raw("evb")[0].state, "PURGED");
      assert.deepStrictEqual(h.events.map((e) => [e.siteKey, e.state]),
        [["lne:eva:0", "PURGED"], ["lne:evb:0", "PURGED"]]);
      assert.strictEqual(h.telemetry.counters["sites.despawned"], 2);
    }));

  needsDriver("B5 extend + completion + recreation: extend -> one setLifecycleState with expires_at + grace "
    + "completed -> COMPLETED, listener once; extend after COMPLETED -> no write; LOST twice with maxRecreate 1 -> "
    + "one recreation, then CLEANED RECREATE_LIMIT", () => withStore(driver, (store) => {
    const h = harness(store);
    h.create(req("ev1", 0, SYS[0]));
    h.create(req("ev2", 0, SYS[1]));
    h.pass(T0 + 1000);
    const id1 = h.raw("ev1")[0].instanceId;
    const grace = h.config.sites.vendorExpiryGraceMs;
    h.clock.t = T0 + 2000;
    const e2 = T0 + 2 * HOUR;
    assert.deepStrictEqual(h.tx((db) => h.svc.extendSitesInTx(db, "ev1", e2)), { ok: true, updated: 1 });
    h.pass(T0 + 3000);
    assert.deepStrictEqual(h.world.calls.setLifecycle, [{ id: id1, state: "active", expiresAtMs: e2 + grace }]);
    h.world.raw.setLifecycleState(id1, "completed", { nowMs: T0 + 3500 });
    h.pass(T0 + 4000);
    assert.strictEqual(h.raw("ev1")[0].state, "COMPLETED");
    h.clock.t = T0 + 5000;
    assert.deepStrictEqual(h.tx((db) => h.svc.extendSitesInTx(db, "ev1", T0 + 3 * HOUR)), { ok: true, updated: 1 });
    h.pass(T0 + 6000);
    assert.strictEqual(h.world.calls.setLifecycle.length, 1, "no EveJS write after COMPLETED");
    assert.deepStrictEqual(h.events.map((e) => e.state), ["COMPLETED"]);

    const idA = h.raw("ev2")[0].instanceId;
    h.world.raw.setLifecycleState(idA, "despawned", { nowMs: T0 + 6500 });
    h.pass(T0 + 31000);
    h.pass(T0 + 32000);
    h.pass(T0 + 33000);
    h.pass(T0 + 34000);
    const again = h.raw("ev2")[0];
    assert.deepStrictEqual([again.state, again.recreateCount], ["ACTIVE", 1]);
    h.world.raw.setLifecycleState(again.instanceId, "despawned", { nowMs: T0 + 35000 });
    h.pass(T0 + 34000 + 30000);
    h.pass(T0 + 65000);
    const last = h.raw("ev2")[0];
    assert.deepStrictEqual([last.state, last.failReason], ["CLEANED", "RECREATE_LIMIT"]);
    assert.deepStrictEqual(h.events.map((e) => e.state), ["COMPLETED", "LOST", "LOST"]);
    assert.deepStrictEqual(h.world.calls.create, ["lne:ev1:0", "lne:ev2:0", "lne:ev2:0"]);
    assert.deepStrictEqual(h.world.calls.purge, [idA]);
  }));
};
