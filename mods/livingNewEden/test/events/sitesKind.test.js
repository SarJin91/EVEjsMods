"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { findServerSrcOnDisk, GAMESTORE_SEARCH_MAX_DEPTH } = require("../../lib/adapter/locator");
const { resolveSqliteDriver } = require("../../lib/adapter/sqliteDriver");
const { MIGRATIONS } = require("../../lib/persistence/migrations");
const { openStore } = require("../../lib/persistence/store");
const { seedDbFile } = require("../_support/dbTemplate");
const { fingerprint } = require("../../lib/util/fingerprint");
const dungeonSites = require("../../lib/adapter/dungeonSites");
const { resolveConfig } = require("../../config");
const siteRepository = require("../../lib/events/sites/siteRepository");
const { createSiteService, buildEnsureSpec } = require("../../lib/events/sites/siteService");
const { unavailableSites } = require("../../lib/events/sites");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const SERVER_SRC = path.resolve(MOD_DIR, "..", "..", "server", "src");
const T0 = 1700000000000;
const HOUR = 3600000;
const SYS = 30000001;
const TEMPLATE = Object.freeze({ templateID: "client-dungeon:6366", siteFamily: "ore", siteKind: "anomaly",
  entryObjectTypeID: 12345 });

function loadDriver() {
  const found = findServerSrcOnDisk(MOD_DIR, GAMESTORE_SEARCH_MAX_DEPTH, fs.existsSync);
  if (!found.ok) return { ok: false, detail: found.reason };
  return resolveSqliteDriver(found.srcDir);
}

function readSource(rel) {
  return fs.readFileSync(path.join(SERVER_SRC, rel), "utf8").replace(/\r\n/g, "\n");
}

function withService(driver, fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lne-sites-kind-"));
  const file = path.join(tmp, "world.sqlite");
  let store = null;
  try {
    seedDbFile(driver, file, { migrations: MIGRATIONS, seed: 1 });
    const opened = openStore({ filePath: file, openDatabase: (f) => new driver.Database(f), exclusiveLock: true,
      busyTimeoutMs: 0, maxRowsPerTransaction: 500, maxWriteMsPerPass: 5, randomSeed: () => 1,
      migrations: MIGRATIONS });
    assert.ok(opened.ok, JSON.stringify(opened));
    store = opened.store;
    const r = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_SITES_ENABLED: "1" } });
    assert.deepStrictEqual(r.errors, []);
    const config = r.config;
    const svc = createSiteService({ store, adapter: {}, clock: { now: () => T0 }, config, logger: { log() {} } });
    const tx = (f) => {
      const res = store.transaction("test", f);
      assert.ok(res.ok, JSON.stringify(res));
      return res.value;
    };
    return fn({ svc, tx, config, row: (eventId, slot) => tx((db) => siteRepository.getByEventSlotInTx(db, eventId,
      slot)) });
  } finally {
    if (store) store.close("test");
    try {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch (_err) {
    }
  }
}

function req(eventId, slot, extra = {}) {
  return { eventId, slot, systemId: SYS, templateId: TEMPLATE.templateID, label: "LNE beacon", factionId: 500010,
    expiresAt: T0 + HOUR, ...extra };
}

function specBefore(row, now, P) {
  return {
    siteKey: row.siteKey, systemId: row.systemId, templateId: row.templateId, label: row.label, eventId: row.eventId,
    slot: row.slot, position: null, placementSeed: `lne-site:${row.eventId}:${row.slot}`,
    placementBaseDistanceAu: P.placementBaseDistanceAu, vendorExpiresAtMs: row.expiresAt + P.vendorExpiryGraceMs,
    nowMs: now, durable: P.durableCreate === true,
  };
}

module.exports = ({ test, skip }) => {
  const driver = loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  needsDriver("PK1 regression: no siteKind -> request_hash of before, site_kind NULL, ensure spec and "
    + "createInstance options of before", () => withService(driver, (h) => {
    assert.strictEqual(h.tx((db) => h.svc.createSiteInTx(db, req("pk1", 0))).created, true);
    assert.strictEqual(h.tx((db) => h.svc.createSiteInTx(db, req("pk1", 1, { siteKind: null }))).created, true);
    const row = h.row("pk1", 0);
    assert.strictEqual(row.requestHash, fingerprint({ systemId: SYS, templateId: TEMPLATE.templateID,
      label: "LNE beacon", factionId: 500010 }));
    assert.strictEqual(h.row("pk1", 1).requestHash, row.requestHash);
    assert.strictEqual(row.siteKind, null);
    const spec = buildEnsureSpec(row, T0, h.config.sites);
    assert.deepStrictEqual(spec, specBefore(row, T0, h.config.sites));
    assert.strictEqual(dungeonSites.validateSpec(spec), null);
    const opts = dungeonSites.buildInstanceOptions(spec, TEMPLATE, 1, { x: 1, y: 2, z: 3 });
    assert.deepStrictEqual([opts.siteKind, opts.siteFamily], ["anomaly", "ore"]);
  }));

  needsDriver("PK2 siteKind signature -> row site_kind, spec siteKind, options siteKind signature + family combat"
    + " the kind enters the hash (other kind on the same slot = IDEMPOTENCY_CONFLICT)", () => withService(driver, (h) => {
    assert.strictEqual(h.tx((db) => h.svc.createSiteInTx(db, req("pk2", 0, { siteKind: "signature" }))).created,
      true);
    const row = h.row("pk2", 0);
    assert.strictEqual(row.siteKind, "signature");
    assert.deepStrictEqual(h.tx((db) => h.svc.createSiteInTx(db, req("pk2", 0, { siteKind: "signature" }))),
      { ok: true, siteKey: "lne:pk2:0", created: false, state: "CREATING" });
    assert.strictEqual(h.tx((db) => h.svc.createSiteInTx(db, req("pk2", 0))).reason, "IDEMPOTENCY_CONFLICT");
    const spec = buildEnsureSpec(row, T0, h.config.sites);
    assert.deepStrictEqual(spec, { ...specBefore(row, T0, h.config.sites), siteKind: "signature" });
    assert.strictEqual(dungeonSites.validateSpec(spec), null);
    const opts = dungeonSites.buildInstanceOptions(spec, TEMPLATE, 1, { x: 1, y: 2, z: 3 });
    assert.deepStrictEqual([opts.siteKind, opts.siteFamily], ["signature", "combat"]);
    const anomaly = dungeonSites.buildInstanceOptions({ ...spec, siteKind: "anomaly" }, TEMPLATE, 1, null);
    assert.deepStrictEqual([anomaly.siteKind, anomaly.siteFamily], ["anomaly", "combat"]);
  }));

  needsDriver("PK3 bad siteKind -> SITE_REQUEST_INVALID siteKind (no row) and SITE_SPEC_INVALID siteKind",
    () => withService(driver, (h) => {
      for (const bad of ["Signature", "combat", "", 1]) {
        assert.deepStrictEqual(h.tx((db) => h.svc.createSiteInTx(db, req("pk3", 0, { siteKind: bad }))),
          { ok: false, reason: "SITE_REQUEST_INVALID", detail: "siteKind" });
      }
      assert.strictEqual(h.row("pk3", 0), null);
      h.tx((db) => h.svc.createSiteInTx(db, req("pk3", 0)));
      const spec = buildEnsureSpec(h.row("pk3", 0), T0, h.config.sites);
      assert.strictEqual(dungeonSites.validateSpec({ ...spec, siteKind: "wormhole" }), "siteKind");
      const res = dungeonSites.ensureSiteFrom({}, { ...spec, siteKind: "wormhole" });
      assert.deepStrictEqual([res.ok, res.reason, res.detail], [false, "SITE_SPEC_INVALID", "siteKind"]);
    }));

  needsDriver("PK4 releaseSlotInTx: only the given slot -> CLEANING, second call released 0, bad input refused "
    + "the stub refuses", () => withService(driver, (h) => {
    h.tx((db) => h.svc.createSiteInTx(db, req("pk4", 0)));
    h.tx((db) => h.svc.createSiteInTx(db, req("pk4", 1, { siteKind: "signature" })));
    assert.deepStrictEqual(h.tx((db) => h.svc.releaseSlotInTx(db, "pk4", 0, "EVENT_END")), { ok: true, released: 1 });
    assert.deepStrictEqual(h.tx((db) => h.svc.releaseSlotInTx(db, "pk4", 0, "EVENT_END")), { ok: true, released: 0 });
    const slot0 = h.row("pk4", 0);
    const slot1 = h.row("pk4", 1);
    assert.deepStrictEqual([slot0.state, slot0.failReason, slot0.nextAttemptAt], ["CLEANING", null, T0]);
    assert.deepStrictEqual([slot1.state, slot1.version], ["CREATING", 1]);
    assert.deepStrictEqual(h.tx((db) => h.svc.releaseSlotInTx(db, "pk4", 1, "EVENT_CANCELLED")),
      { ok: true, released: 1 });
    assert.strictEqual(h.row("pk4", 1).failReason, "EVENT_CANCELLED");
    assert.strictEqual(h.tx((db) => h.svc.releaseSlotInTx(db, "pk4", 1, "OTHER")).detail, "reason");
    assert.strictEqual(h.tx((db) => h.svc.releaseSlotInTx(db, "pk4", -1, "EVENT_END")).detail, "slot");
    assert.strictEqual(h.svc.releaseSlotInTx(null, "pk4", 0, "EVENT_END").detail, "tx");
    assert.strictEqual(unavailableSites("SITES_DISABLED").releaseSlotInTx({}, "pk4", 0, "EVENT_END").reason,
      "SITES_DISABLED");
  }));

  test("PK5 vendor facts: createInstance takes siteKind / siteFamily from the options before the template "
    + "the probe list filters signalTrackerSignatureSite; a combat beacon without plans never completes", () => {
    const runtime = readSource("services/dungeon/dungeonRuntime.js");
    assert.ok(runtime.includes("normalizeText(options.siteKind,"), "dungeonRuntime: options.siteKind");
    assert.ok(runtime.includes("normalizeText(options.siteFamily,"), "dungeonRuntime: options.siteFamily");
    const provider = readSource("services/exploration/signatures/providers/sceneSignatureSiteProvider.js");
    assert.ok(provider.includes("signalTrackerSignatureSite === true"), "sceneSignatureSiteProvider filter");
    const universe = readSource("services/dungeon/dungeonUniverseSiteService.js");
    const start = universe.indexOf("\nfunction isEncounterCompletionSatisfied(");
    assert.ok(start >= 0, "isEncounterCompletionSatisfied not found");
    const next = universe.slice(start + 1).search(/\n(async )?function /);
    const body = universe.slice(start, next < 0 ? universe.length : start + 1 + next);
    assert.ok(/plans\.length <= 0\) \{\s*return false;/.test(body), "empty plans -> false");
  });
};
