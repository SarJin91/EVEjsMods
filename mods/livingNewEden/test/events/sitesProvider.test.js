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
const dungeonSites = require("../../lib/adapter/dungeonSites");
const siteHacks = require("../../lib/adapter/siteHacks");
const { resolveConfig } = require("../../config");
const siteRepository = require("../../lib/events/sites/siteRepository");
const { createSiteService, buildEnsureSpec, MAX_PROVIDERS } = require("../../lib/events/sites/siteService");
const { unavailableSites } = require("../../lib/events/sites");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const SERVER_SRC = path.resolve(MOD_DIR, "..", "..", "server", "src");
const T0 = 1700000000000;
const HOUR = 3600000;
const SYS = 30000001;

function loadDriver() {
  const found = findServerSrcOnDisk(MOD_DIR, GAMESTORE_SEARCH_MAX_DEPTH, fs.existsSync);
  if (!found.ok) return { ok: false, detail: found.reason };
  return resolveSqliteDriver(found.srcDir);
}

function withService(driver, fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lne-sites-provider-"));
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
    const specs = [];
    const counts = new Map();
    const seam = { ok: true, ensureSite: (spec) => {
      specs.push(spec);
      return { ok: true, adopted: false, instanceId: specs.length, siteId: 100 + specs.length,
        position: { x: 1, y: 2, z: 3 }, durable: true, vendorWrites: 1 };
    } };
    const telemetry = { count: (name, n) => counts.set(name, (counts.get(name) || 0) + n) };
    const svc = createSiteService({ store, adapter: { getDungeonSites: () => seam }, clock: { now: () => T0 }, config,
      logger: { log() {} }, telemetry });
    const tx = (f) => {
      const res = store.transaction("test", f);
      assert.ok(res.ok, JSON.stringify(res));
      return res.value;
    };
    return fn({ svc, tx, config, specs, counts,
      row: (eventId, slot) => tx((db) => siteRepository.getByEventSlotInTx(db, eventId, slot)) });
  } finally {
    if (store) store.close("test");
    try {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch (_err) {
    }
  }
}

let nextSystem = SYS;
function req(eventId) {
  nextSystem += 1;
  return { eventId, slot: 0, systemId: nextSystem, templateId: "client-dungeon:1808", label: "LNE archive",
    factionId: 500010, expiresAt: T0 + HOUR };
}

const ARCHIVE = Object.freeze({ key: "lne_archive", analyzer: "relic", label: "Drifter Lattice Node",
  hackingDifficulty: 3, offsetMeters: 3000, explicitLoot: [{ typeId: 5, quantity: 1, runs: 10 }] });

function relicTemplate() {
  return { templateID: "client-dungeon:1808", siteFamily: "relic", siteKind: "signature", entryObjectTypeID: 1,
    populationHints: { siteFamily: "relic", containers: [
      { role: "data", analyzer: "data", count: 1, typeID: 222, label: "Data" },
      { role: "relic", analyzer: "relic", count: 2, typeID: 111, roomKey: "room1", positionOffset: { x: 10, y: 20, z: 30 },
        lootProfile: "relic_low", lootTags: ["ruins"], dunObjectID: 77, typeNameCandidates: ["Ruins"] },
    ] } };
}

function readSource(rel) {
  const full = path.join(SERVER_SRC, rel);
  return fs.existsSync(full) ? fs.readFileSync(full, "utf8").replace(/\r\n/g, "\n") : "";
}

module.exports = ({ test, skip }) => {
  const driver = loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  needsDriver("A6 sites content providers: no provider = buildEnsureSpec bit for bit; prefix match adds "
    + "extraContainers; throw / refusal -> retry; BAD_PROVIDER / DUPLICATE / FULL; stub", () => withService(driver,
    (h) => {
      const P = h.config.sites;
      h.tx((db) => h.svc.createSiteInTx(db, req("evt-plain")));
      const plain = h.row("evt-plain", 0);
      h.svc.runPass(T0);
      assert.strictEqual(h.specs.length, 1);
      assert.deepStrictEqual(h.specs[0], buildEnsureSpec(plain, T0, P));
      assert.ok(!Object.prototype.hasOwnProperty.call(h.specs[0], "extraContainers"));
      const built = [];
      const reg = h.svc.registerContentProvider({ prefix: "arc:", build: (eventId, slot) => {
        built.push([eventId, slot]);
        return eventId.endsWith(":r0") ? { ok: true, containers: [ARCHIVE] } : { ok: true, containers: [] };
      } });
      assert.strictEqual(reg.ok, true);
      h.tx((db) => h.svc.createSiteInTx(db, req("arc:s0:1:1:s1:r0")));
      h.tx((db) => h.svc.createSiteInTx(db, req("arc:s0:1:1:s1:r1")));
      h.tx((db) => h.svc.createSiteInTx(db, req("other-evt")));
      const arcRow = h.row("arc:s0:1:1:s1:r0", 0);
      for (let i = 0; i < 3; i += 1) h.svc.runPass(T0);
      const byEvent = new Map(h.specs.slice(1).map((s) => [s.eventId, s]));
      assert.deepStrictEqual(byEvent.get("arc:s0:1:1:s1:r0").extraContainers, [ARCHIVE]);
      const { extraContainers: _x, ...rest } = byEvent.get("arc:s0:1:1:s1:r0");
      assert.deepStrictEqual(rest, buildEnsureSpec(arcRow, T0, P));
      assert.ok(!("extraContainers" in byEvent.get("arc:s0:1:1:s1:r1")), "empty list = the plain spec");
      assert.ok(!("extraContainers" in byEvent.get("other-evt")), "another prefix");
      assert.deepStrictEqual(built.map((b) => b[1]), [0, 0]);
      assert.strictEqual(h.counts.get("sites.providerContainers"), 1);
      reg.unregister();
      const n = h.specs.length;
      const thrower = h.svc.registerContentProvider({ prefix: "arc:", build: () => {
        throw new Error("boom");
      } });
      h.tx((db) => h.svc.createSiteInTx(db, req("arc:s0:2:1:s1:r0")));
      h.svc.runPass(T0);
      assert.strictEqual(h.specs.length, n);
      const waiting = h.row("arc:s0:2:1:s1:r0", 0);
      assert.deepStrictEqual([waiting.state, waiting.nextAttemptAt], ["CREATING", T0 + P.retryDelayMs]);
      thrower.unregister();
      h.svc.registerContentProvider({ prefix: "arc:", build: () => ({ ok: false, retry: true }) });
      h.svc.runPass(T0 + P.retryDelayMs);
      assert.strictEqual(h.specs.length, n);
      assert.strictEqual(h.counts.get("sites.providerRetry"), 2);
      for (const bad of [null, { prefix: "ARC:", build() {} }, { prefix: "a:", build() {} }, { prefix: "arc", build() {} },
        { prefix: "abc:" }]) {
        assert.deepStrictEqual(h.svc.registerContentProvider(bad), { ok: false, reason: "BAD_PROVIDER" });
      }
      assert.deepStrictEqual(h.svc.registerContentProvider({ prefix: "arc:", build() {} }),
        { ok: false, reason: "DUPLICATE" });
      const more = ["bb:", "cc:", "dd:"].map((prefix) => h.svc.registerContentProvider({ prefix, build() {} }));
      assert.ok(more.every((m) => m.ok), "4 providers");
      assert.strictEqual(MAX_PROVIDERS, 4);
      assert.deepStrictEqual(h.svc.registerContentProvider({ prefix: "ee:", build() {} }), { ok: false, reason: "FULL" });
      more[0].unregister();
      assert.strictEqual(h.svc.registerContentProvider({ prefix: "ee:", build() {} }).ok, true);
      assert.deepStrictEqual(unavailableSites("SITES_DISABLED").registerContentProvider({ prefix: "arc:", build() {} }),
        { ok: false, reason: "SITES_UNAVAILABLE" });
    }));

  test("A6 adapter archive container: archiveHintsOf first + inherited fields, createInstance options, "
    + "SITE_SPEC_INVALID templates, validateSpec, readSiteHackWinsFrom", () => {
    const tpl = relicTemplate();
    const frozen = JSON.stringify(tpl);
    const hints = dungeonSites.archiveHintsOf(tpl, [ARCHIVE]);
    assert.strictEqual(JSON.stringify(tpl), frozen, "the template is not touched");
    assert.strictEqual(hints.containers.length, 3);
    assert.deepStrictEqual(hints.containers[0], { role: "relic", analyzer: "relic", count: 1, typeID: 111,
      roomKey: "room1", positionOffset: { x: 3010, y: 20, z: 30 }, lootProfile: "relic_low", lootTags: ["ruins"],
      label: "Drifter Lattice Node", contentKey: "container:lne_archive", failureNeverDestroys: true,
      hackingDifficulty: 3, explicitLoot: [{ typeID: 5, quantity: 1, runsRemaining: 10 }] });
    assert.deepStrictEqual(hints.containers.slice(1), tpl.populationHints.containers);
    const spec = { siteKey: "lne:arc:s0:1:1:s1:r0:0", systemId: SYS, templateId: tpl.templateID, label: "LNE archive",
      eventId: "arc:s0:1:1:s1:r0", slot: 0, position: null, placementSeed: "x", placementBaseDistanceAu: 4,
      vendorExpiresAtMs: T0 + HOUR, nowMs: T0, durable: false };
    assert.strictEqual(dungeonSites.validateSpec({ ...spec, extraContainers: [ARCHIVE] }), null);
    const opts = dungeonSites.buildInstanceOptions({ ...spec, extraContainers: [ARCHIVE] }, tpl, 1, { x: 0, y: 0, z: 0 });
    assert.strictEqual(opts.spawnState.populationHints.containers[0].contentKey, "container:lne_archive");
    const plainOpts = dungeonSites.buildInstanceOptions(spec, tpl, 1, { x: 0, y: 0, z: 0 });
    assert.deepStrictEqual(Object.keys(plainOpts.spawnState), ["siteID", "label", "entryObjectTypeID"]);
    let created = 0;
    const modsOf = (template) => ({ dungeonRuntime: { findInstanceBySiteKey: () => null, peekNextInstanceID: () => 1,
      createInstance: () => {
        created += 1;
        throw new Error("must not be called");
      } }, dungeonAuthority: { getTemplateByID: () => template } });
    const combat = { ...relicTemplate(), populationHints: { containers: [{ role: "cargo", analyzer: "", count: 1,
      typeID: 9 }] } };
    const untyped = { ...relicTemplate(), populationHints: { containers: [{ role: "relic", analyzer: "relic",
      count: 2 }] } };
    for (const t of [combat, untyped, { ...relicTemplate(), populationHints: null }]) {
      const res = dungeonSites.ensureSiteFrom(modsOf(t), { ...spec, position: { x: 1, y: 1, z: 1 },
        extraContainers: [ARCHIVE] });
      assert.deepStrictEqual([res.ok, res.reason, res.detail], [false, "SITE_SPEC_INVALID", "extraContainers"]);
    }
    assert.strictEqual(created, 0);
    for (const bad of [[ARCHIVE, ARCHIVE], [ARCHIVE, { ...ARCHIVE, key: "lne_b" }, { ...ARCHIVE, key: "lne_c" }],
      [{ ...ARCHIVE, label: "Archiwum jowiańskie" }], [{ ...ARCHIVE, key: "archive" }],
      [{ ...ARCHIVE, hackingDifficulty: 6 }], [{ ...ARCHIVE, offsetMeters: 20001 }],
      [{ ...ARCHIVE, explicitLoot: [{ typeId: 5, quantity: 1001 }] }], "x"]) {
      assert.strictEqual(dungeonSites.validateSpec({ ...spec, extraContainers: bad }), "extraContainers");
    }
    const own = { siteKey: spec.siteKey, siteOrigin: "lne_event", lifecycleState: "completed", instanceID: 9,
      metadata: { providerID: "livingNewEden", lneSiteKey: spec.siteKey } };
    const ref = Object.freeze({ spawnState: Object.freeze({ hackingContainers: Object.freeze({
      "container:lne_archive": Object.freeze({ outcomes: Object.freeze({
        b: Object.freeze({ outcome: "won", characterID: 7, atMs: 20 }),
        a: Object.freeze({ outcome: "won", characterID: 8, atMs: 10 }),
        c: Object.freeze({ outcome: "lost", characterID: 7, atMs: 5 }) }) }) }) }) });
    const rt = (summary) => ({ findInstanceBySiteKey: () => summary, getInstanceRef: (id) => (id === 9 ? ref : null) });
    assert.deepStrictEqual(siteHacks.readSiteHackWinsFrom(rt(own), spec.siteKey), { ok: true, state: "completed",
      wins: [{ contentKey: "container:lne_archive", characterId: 8, outcomeId: "a", atMs: 10 },
        { contentKey: "container:lne_archive", characterId: 7, outcomeId: "b", atMs: 20 }] });
    assert.deepStrictEqual(siteHacks.readSiteHackWinsFrom(rt({ ...own, siteOrigin: "x" }), spec.siteKey),
      { ok: false, reason: "SITE_FOREIGN" });
    assert.deepStrictEqual(siteHacks.readSiteHackWinsFrom(rt(null), spec.siteKey), { ok: true, state: "missing",
      wins: [] });
    assert.strictEqual(siteHacks.readSiteHackWinsFrom({}, spec.siteKey).reason, "SEAM_UNAVAILABLE");
    assert.strictEqual(siteHacks.readSiteHackWinsFrom(rt(own), "bad").reason, "SITE_KEY_INVALID");
  });

  test("A9 vendor facts: spawnState.populationHints in resolvePopulationHints, failureNeverDestroys in the spec, "
    + "explicitLoot before lootProfile, 24 containers, promotion only without typeID, neverDestroys, getInstanceRef",
  () => {
    const site = readSource("services/dungeon/dungeonUniverseSiteService.js");
    if (!site) {
      skip("A9 vendor facts", "server/src not found");
      return;
    }
    const fnBody = (src, name) => {
      const start = src.indexOf(`\nfunction ${name}(`);
      assert.ok(start >= 0, `${name} not found`);
      const next = src.slice(start + 1).search(/\n(async )?function /);
      return src.slice(start, next < 0 ? src.length : start + 1 + next);
    };
    assert.ok(fnBody(site, "resolvePopulationHints").includes("instance.spawnState.populationHints"));
    assert.ok(site.includes("failureNeverDestroys: container && container.failureNeverDestroys === true"));
    assert.ok(site.includes("const SITE_CONTENT_MAX_CONTAINER_COUNT = 24;"));
    const loot = fnBody(site, "buildBaseLootGrantEntriesForContainer");
    assert.ok(loot.indexOf("dungeonSiteContentExplicitLoot") >= 0
      && loot.indexOf("dungeonSiteContentExplicitLoot") < loot.indexOf("dungeonSiteContentLootProfile"));
    const promote = fnBody(site, "resolveEnvPromotedContainerSpecs");
    assert.ok(/const hasTypedSpec = specs\.some\(\(spec\) =>\s*Math\.max\(0, toInt\(spec && spec\.typeID, 0\)\) > 0/
      .test(promote), "hasTypedSpec from typeID");
    assert.ok(/if \(hasTypedSpec \|\| hasAuthoredBehaviorSpec\) \{\s*return null;/.test(promote));
    const hacking = readSource("services/exploration/hackingContainerState.js");
    assert.ok(hacking.includes("neverDestroys: entity?.dungeonSiteContentFailureNeverDestroys === true"));
    assert.ok(hacking.includes("!policy.neverDestroys"));
    const runtime = readSource("services/dungeon/dungeonRuntime.js");
    assert.ok(/function getInstanceRef\(instanceID\) \{\s*return runtimeState\.getInstanceRef\(instanceID\);/
      .test(runtime));
    assert.ok(runtime.includes("function findInstanceBySiteKey(siteKey, options = {})"));
  });
};
