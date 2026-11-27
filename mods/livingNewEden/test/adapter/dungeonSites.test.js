"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { createFakeDungeonRuntime } = require("../_support/fakeDungeonRuntime");
const dungeonSites = require("../../lib/adapter/dungeonSites");
const { createAdapter } = require("../../lib/adapter");

const SERVER_SRC = path.resolve(__dirname, "..", "..", "..", "..", "server", "src");

function readSource(relPath) {
  const full = path.join(SERVER_SRC, relPath);
  if (!fs.existsSync(full)) return "";
  return fs.readFileSync(full, "utf8");
}

function makeMods(fakeRuntime, overrides = {}) {
  const fakeAuthority = {
    getTemplateByID: (id) => {
      if (id === "missing") return null;
      return {
        templateID: id,
        siteFamily: "combat",
        siteKind: "anomaly",
        entryObjectTypeID: 12345,
      };
    },
  };
  const fakeSiteService = {
    isUniverseSiteTeardownParked: () => false,
  };
  const fakePlacement = {
    buildAnchorRelativeSignaturePlacement: (candidates, seed, opts) => ({
      anchorIndex: 0,
      anchorItemID: candidates[0]?.itemID || 1,
      anchorPosition: candidates[0]?.position || { x: 0, y: 0, z: 0 },
      direction: { x: 1, y: 0, z: 0 },
      distanceAu: 4,
      distanceMeters: 4 * 149597870700,
      position: { x: 149597870700 * 4, y: 0, z: 0 },
    }),
  };
  const fakeWorldData = {
    getCelestialsForSystem: () => [{ itemID: 40000001, position: { x: 1e9, y: 0, z: 0 }, groupID: 1 }],
    getAsteroidBeltsForSystem: () => [{ itemID: 40000002, position: { x: 2e9, y: 0, z: 0 } }],
    getStationsForSystem: () => [{ stationID: 60000001, position: { x: 3e9, y: 0, z: 0 } }],
    getStargatesForSystem: () => [{ itemID: 50000001, position: { x: 4e9, y: 0, z: 0 } }],
    getSolarSystemByID: (id) => id === 30000001 ? { radius: 1e10 } : null,
  };
  const fakeGameStore = {
    flushTableSync: () => ({ success: true, errorMsg: null }),
  };
  return {
    dungeonRuntime: fakeRuntime,
    dungeonAuthority: overrides.dungeonAuthority || fakeAuthority,
    siteService: overrides.siteService || fakeSiteService,
    placement: overrides.placement || fakePlacement,
    worldData: overrides.worldData || fakeWorldData,
    gameStore: overrides.gameStore !== undefined ? overrides.gameStore : fakeGameStore,
  };
}

function validSpec(overrides = {}) {
  return {
    siteKey: "lne:test-event-1",
    systemId: 30000001,
    templateId: "dungeon_combat_1",
    label: "Test Site",
    position: null,
    placementSeed: "seed-123",
    placementBaseDistanceAu: 4,
    vendorExpiresAtMs: Date.now() + 3600000,
    nowMs: Date.now(),
    eventId: "evt-1",
    slot: 0,
    durable: true,
    ...overrides,
  };
}

module.exports = ({ test }) => {
  test("S1 vendor facts: dungeonRuntime exports", () => {
    const src = readSource("services/dungeon/dungeonRuntime.js");
    const exportBlock = src.match(/module\.exports\s*=\s*\{[\s\S]*?\n\};/);
    assert.ok(exportBlock, "module.exports block found");
    const exports = exportBlock[0];
    assert.ok(exports.includes("createInstance"), "createInstance exported");
    assert.ok(exports.includes("findInstanceBySiteKey"), "findInstanceBySiteKey exported");
    assert.ok(exports.includes("setLifecycleState"), "setLifecycleState exported");
    assert.ok(exports.includes("purgeInstance"), "purgeInstance exported");
    assert.ok(exports.includes("peekNextInstanceID"), "peekNextInstanceID exported");
  });

  test("S1 vendor facts: DUNGEON_SITE_KEY_IN_USE in createInstance", () => {
    const src = readSource("services/dungeon/dungeonRuntime.js");
    const createInstanceFn = src.match(/function createInstance\([\s\S]*?^\}/m);
    assert.ok(createInstanceFn, "createInstance function found");
    assert.ok(createInstanceFn[0].includes("return writeInstance(template, options);"), "createInstance -> writeInstance");
    const writeFn = src.match(/function writeInstance\([\s\S]*?^\}/m);
    assert.ok(writeFn, "writeInstance function found");
    const guard = writeFn[0].indexOf("DUNGEON_SITE_KEY_IN_USE");
    assert.ok(guard > 0, "DUNGEON_SITE_KEY_IN_USE guard present");
    assert.ok(guard < writeFn[0].indexOf("commitRuntimeStateMutation("), "guard before the write");
  });

  test("S1 vendor facts: setLifecycleState accepts expiresAtMs", () => {
    const src = readSource("services/dungeon/dungeonRuntime.js");
    const setFn = src.match(/function setLifecycleState\([\s\S]*?^\}/m);
    assert.ok(setFn, "setLifecycleState function found");
    assert.ok(setFn[0].includes("options.expiresAtMs"), "expiresAtMs handling present");
  });

  test("S1 vendor facts: DUNGEON_RUNTIME_TABLE constant", () => {
    const src = readSource("services/dungeon/dungeonRuntimeState.js");
    assert.ok(src.includes('DUNGEON_RUNTIME_TABLE = "dungeonRuntimeState"'), "DUNGEON_RUNTIME_TABLE constant");
  });

  test("S1 vendor facts: ACTIVE_LIFECYCLE_STATES", () => {
    const src = readSource("services/dungeon/dungeonRuntimeState.js");
    assert.ok(src.includes("ACTIVE_LIFECYCLE_STATES"), "ACTIVE_LIFECYCLE_STATES defined");
    assert.ok(src.includes("seeded") && src.includes("active") && src.includes("paused"), "active states include seeded, active, paused");
  });

  test("S1 vendor facts: metadata.spawnFamilyKey first in resolveInstanceSpawnFamilyKey", () => {
    const src = readSource("services/dungeon/dungeonRuntimeState.js");
    const resolveFn = src.match(/function resolveInstanceSpawnFamilyKey\([\s\S]*?^\}/m);
    assert.ok(resolveFn, "resolveInstanceSpawnFamilyKey found");
    assert.ok(resolveFn[0].includes("metadata.spawnFamilyKey"), "metadata.spawnFamilyKey first");
  });

  test("S1 vendor facts: summary contains siteKey, siteOrigin, metadata", () => {
    const src = readSource("services/dungeon/dungeonRuntimeState.js");
    const buildFn = src.match(/function buildInstanceSummary\([\s\S]*?^\}/m);
    assert.ok(buildFn, "buildInstanceSummary found");
    assert.ok(buildFn[0].includes("siteKey"), "summary has siteKey");
    assert.ok(buildFn[0].includes("siteOrigin"), "summary has siteOrigin");
    assert.ok(buildFn[0].includes("metadata"), "summary has metadata");
  });

  test("S1 vendor facts: MANUAL_DUNGEON_SITE_ID_BASE", () => {
    const src = readSource("services/dungeon/dungeonUniverseSiteService.js");
    assert.ok(src.includes("MANUAL_DUNGEON_SITE_ID_BASE = 6_800_000_000_000"), "MANUAL_DUNGEON_SITE_ID_BASE constant");
  });

  test("S1 vendor facts: isUniverseSiteTeardownParked as static class field", () => {
    const src = readSource("services/dungeon/dungeonUniverseSiteService.js");
    assert.ok(src.includes("DungeonUniverseSiteService.isUniverseSiteTeardownParked"), "static field assignment present");
    assert.ok(src.includes("isUniverseSiteTeardownParked;"), "assignment to function");
  });

  test("S1 vendor facts: flushTableSync in gameStore/index exports", () => {
    const src = readSource("gameStore/index.js");
    const exportBlock = src.match(/module\.exports\s*=\s*\{[\s\S]*?\n\};/);
    assert.ok(exportBlock, "module.exports block found");
    assert.ok(exportBlock[0].includes("flushTableSync"), "flushTableSync exported");
  });

  test("S1 vendor facts: buildAnchorRelativeSignaturePlacement exported", () => {
    const src = readSource("services/exploration/signatures/signaturePlacement.js");
    const exportBlock = src.match(/module\.exports\s*=\s*\{[\s\S]*?\n\};/);
    assert.ok(exportBlock, "module.exports block found");
    assert.ok(exportBlock[0].includes("buildAnchorRelativeSignaturePlacement"), "buildAnchorRelativeSignaturePlacement exported");
  });

  test("S2 create/adopt: first ensureSite creates instance, second adopts", () => {
    const fake = createFakeDungeonRuntime();
    const mods = makeMods(fake);
    const spec = validSpec();

    const r1 = dungeonSites.ensureSiteFrom(mods, spec);
    assert.strictEqual(r1.ok, true, "first create ok");
    assert.strictEqual(r1.adopted, false, "first not adopted");
    assert.strictEqual(r1.vendorWrites, 1, "vendorWrites=1");
    const instanceId1 = r1.instanceId;
    const siteId1 = r1.siteId;

    assert.strictEqual(siteId1, dungeonSites.MANUAL_SITE_ID_BASE + instanceId1, "siteId = BASE + instanceID");

    const r2 = dungeonSites.ensureSiteFrom(mods, spec);
    assert.strictEqual(r2.ok, true, "second create ok");
    assert.strictEqual(r2.adopted, true, "second adopted");
    assert.strictEqual(r2.instanceId, instanceId1, "same instanceId");
    assert.strictEqual(r2.vendorWrites, 0, "vendorWrites=0 on adopt");

    const summary = fake.findInstanceBySiteKey(spec.siteKey);
    assert.ok(summary, "instance exists");
    assert.strictEqual(summary.siteOrigin, dungeonSites.SITE_ORIGIN, "siteOrigin set");
    assert.strictEqual(summary.spawnFamilyKey, dungeonSites.SPAWN_FAMILY_KEY, "spawnFamilyKey set");
    assert.strictEqual(summary.metadata.providerID, dungeonSites.PROVIDER_ID, "providerID set");
    assert.strictEqual(summary.metadata.lneSiteKey, spec.siteKey, "lneSiteKey set");
    assert.strictEqual(summary.metadata.siteID, siteId1, "siteID set");
  });

  test("S2 create/adopt: flushTableSync called once on create", () => {
    const fake = createFakeDungeonRuntime();
    let flushCount = 0;
    const mods = makeMods(fake, {
      gameStore: {
        flushTableSync: (table) => {
          flushCount++;
          assert.strictEqual(table, dungeonSites.DUNGEON_TABLE, "flushes correct table");
          return { success: true, errorMsg: null };
        },
      },
    });
    const spec = validSpec({ durable: true });

    dungeonSites.ensureSiteFrom(mods, spec);
    assert.strictEqual(flushCount, 1, "flushTableSync called once");

    dungeonSites.ensureSiteFrom(mods, spec);
    assert.strictEqual(flushCount, 1, "flushTableSync not called on adopt");
  });

  test("S2 create/adopt: DUNGEON_SITE_KEY_IN_USE exception triggers adoption", () => {
    const fake = createFakeDungeonRuntime();
    let createCallCount = 0;
    const wrappingRuntime = {
      ...fake,
      createInstance: (opts) => {
        createCallCount++;
        if (createCallCount === 2) {
          const err = new Error("Active dungeon instance already exists for site key " + opts.siteKey);
          err.code = "DUNGEON_SITE_KEY_IN_USE";
          throw err;
        }
        return fake.createInstance(opts);
      },
    };
    const mods = makeMods(wrappingRuntime);
    const spec = validSpec();

    const r1 = dungeonSites.ensureSiteFrom(mods, spec);
    assert.strictEqual(r1.ok, true);
    assert.strictEqual(r1.adopted, false);

    const r2 = dungeonSites.ensureSiteFrom(mods, spec);
    assert.strictEqual(r2.ok, true, "adoption on race ok");
    assert.strictEqual(r2.adopted, true, "adopted after race");
    assert.strictEqual(r2.instanceId, r1.instanceId, "same instance");
  });

  test("S3: crash before flush -> restore -> foreign instance gets same ID -> readSite=missing, mutations=0", () => {
    const fake = createFakeDungeonRuntime();
    let setLifecycleCalls = 0;
    let purgeCalls = 0;

    const mods = makeMods(fake, {
      dungeonRuntime: {
        ...fake,
        setLifecycleState: (id, state, opts) => {
          setLifecycleCalls++;
          return fake.setLifecycleState(id, state, opts);
        },
        purgeInstance: (id) => {
          purgeCalls++;
          return fake.purgeInstance(id);
        },
      },
      gameStore: {
        flushTableSync: () => ({ success: true, errorMsg: null }),
      },
    });

    const spec = validSpec({ durable: false });

    fake.snapshot();

    const rCreate = dungeonSites.ensureSiteFrom(mods, spec);
    assert.strictEqual(rCreate.ok, true);
    const createdId = rCreate.instanceId;

    fake.restore();

    assert.strictEqual(fake.getStats().nextInstanceSequence, 1, "sequence rolled back to 1");
    assert.strictEqual(fake.getStats().instanceCount, 0, "instances cleared");

    const foreignSpec = validSpec({ siteKey: "lne:foreign-1", templateId: "dungeon_combat_2" });
    const modsForeign = makeMods(fake, {
      gameStore: { flushTableSync: () => ({ success: true, errorMsg: null }) },
    });
    const rForeign = dungeonSites.ensureSiteFrom(modsForeign, foreignSpec);
    assert.strictEqual(rForeign.ok, true);
    assert.strictEqual(rForeign.instanceId, createdId, "foreign instance got same ID");

    const rRead = dungeonSites.readSiteFrom(mods, spec.siteKey);
    assert.strictEqual(rRead.ok, true);
    assert.strictEqual(rRead.state, "missing", "our siteKey missing after ID reuse");
    assert.strictEqual(rRead.foreign, false);

    const rDespawn = dungeonSites.despawnSiteFrom(mods, spec.siteKey, "lne_event_end", Date.now());
    assert.strictEqual(rDespawn.ok, true);
    assert.strictEqual(rDespawn.already, true);
    assert.strictEqual(rDespawn.vendorWrites, 0);

    const rExtend = dungeonSites.extendSiteFrom(mods, spec.siteKey, Date.now() + 10000, Date.now());
    assert.strictEqual(rExtend.ok, true);
    assert.strictEqual(rExtend.extended, false);
    assert.strictEqual(rExtend.vendorWrites, 0);

    const rPurge = dungeonSites.purgeSiteFrom(mods, spec.siteKey, spec.systemId);
    assert.strictEqual(rPurge.ok, true);
    assert.strictEqual(rPurge.purged, false);
    assert.strictEqual(rPurge.vendorWrites, 0);

    assert.strictEqual(setLifecycleCalls, 0, "no setLifecycleState calls");
    assert.strictEqual(purgeCalls, 0, "no purgeInstance calls");
  });

  test("S4 extendSite on active instance writes once, idempotent on same value", () => {
    const fake = createFakeDungeonRuntime();
    const mods = makeMods(fake);
    const spec = validSpec();

    const rCreate = dungeonSites.ensureSiteFrom(mods, spec);
    assert.strictEqual(rCreate.ok, true);
    const instanceId = rCreate.instanceId;

    const newExpiry = Date.now() + 7200000;
    const rExt1 = dungeonSites.extendSiteFrom(mods, spec.siteKey, newExpiry, Date.now());
    assert.strictEqual(rExt1.ok, true);
    assert.strictEqual(rExt1.extended, true);
    assert.strictEqual(rExt1.vendorWrites, 1);
    assert.strictEqual(rExt1.state, "active");

    const rExt2 = dungeonSites.extendSiteFrom(mods, spec.siteKey, newExpiry, Date.now());
    assert.strictEqual(rExt2.ok, true);
    assert.strictEqual(rExt2.extended, false);
    assert.strictEqual(rExt2.vendorWrites, 0);
  });

  test("S4 extendSite on completed instance -> no write", () => {
    const fake = createFakeDungeonRuntime();
    const mods = makeMods(fake);
    const spec = validSpec();

    const rCreate = dungeonSites.ensureSiteFrom(mods, spec);
    assert.strictEqual(rCreate.ok, true);
    const instanceId = rCreate.instanceId;

    fake.setLifecycleState(instanceId, "completed", { nowMs: Date.now() });

    const rExt = dungeonSites.extendSiteFrom(mods, spec.siteKey, Date.now() + 10000, Date.now());
    assert.strictEqual(rExt.ok, true);
    assert.strictEqual(rExt.extended, false);
    assert.strictEqual(rExt.vendorWrites, 0);
    assert.strictEqual(rExt.state, "completed");
  });

  test("S4: despawnSite on completed -> already:true", () => {
    const fake = createFakeDungeonRuntime();
    const mods = makeMods(fake);
    const spec = validSpec();

    const rCreate = dungeonSites.ensureSiteFrom(mods, spec);
    const instanceId = rCreate.instanceId;

    fake.setLifecycleState(instanceId, "completed", { nowMs: Date.now() });

    const rDespawn = dungeonSites.despawnSiteFrom(mods, spec.siteKey, "lne_event_end", Date.now());
    assert.strictEqual(rDespawn.ok, true);
    assert.strictEqual(rDespawn.already, true);
    assert.strictEqual(rDespawn.vendorWrites, 0);
  });

  test("S4: purgeSite on active -> SITE_STILL_ACTIVE", () => {
    const fake = createFakeDungeonRuntime();
    const mods = makeMods(fake);
    const spec = validSpec();

    const rCreate = dungeonSites.ensureSiteFrom(mods, spec);
    assert.strictEqual(rCreate.ok, true);

    const rPurge = dungeonSites.purgeSiteFrom(mods, spec.siteKey, spec.systemId);
    assert.strictEqual(rPurge.ok, false);
    assert.strictEqual(rPurge.reason, "SITE_STILL_ACTIVE");
  });

  test("S4: purgeSite on parked -> deferred:true, then purged:true", () => {
    const fake = createFakeDungeonRuntime();
    let teardownParked = true;

    const mods = makeMods(fake, {
      siteService: {
        isUniverseSiteTeardownParked: (sys, inst) => teardownParked,
      },
    });
    const spec = validSpec();

    const rCreate = dungeonSites.ensureSiteFrom(mods, spec);
    const instanceId = rCreate.instanceId;

    fake.setLifecycleState(instanceId, "despawned", { nowMs: Date.now() });

    const rPurge1 = dungeonSites.purgeSiteFrom(mods, spec.siteKey, spec.systemId);
    assert.strictEqual(rPurge1.ok, true);
    assert.strictEqual(rPurge1.purged, false);
    assert.strictEqual(rPurge1.deferred, true);

    teardownParked = false;
    const rPurge2 = dungeonSites.purgeSiteFrom(mods, spec.siteKey, spec.systemId);
    assert.strictEqual(rPurge2.ok, true);
    assert.strictEqual(rPurge2.purged, true);
    assert.strictEqual(rPurge2.deferred, false);
    assert.strictEqual(rPurge2.vendorWrites, 1);
  });

  test("S5 refusal: TEMPLATE_MISSING", () => {
    const fake = createFakeDungeonRuntime();
    const mods = makeMods(fake, {
      dungeonAuthority: {
        getTemplateByID: () => null,
      },
    });
    const r = dungeonSites.ensureSiteFrom(mods, validSpec());
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, "TEMPLATE_MISSING");
  });

  test("S5 refusal: SITE_KEY_INVALID (no lne: prefix)", () => {
    const fake = createFakeDungeonRuntime();
    const mods = makeMods(fake);
    const r = dungeonSites.ensureSiteFrom(mods, validSpec({ siteKey: "invalid-key" }));
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, "SITE_KEY_INVALID");
  });

  test("S5 refusal: SITE_KEY_INVALID (whitespace)", () => {
    const fake = createFakeDungeonRuntime();
    const mods = makeMods(fake);
    const r = dungeonSites.ensureSiteFrom(mods, validSpec({ siteKey: " lne:test " }));
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, "SITE_KEY_INVALID");
  });

  test("S5 refusal: SITE_KEY_INVALID (too long)", () => {
    const fake = createFakeDungeonRuntime();
    const mods = makeMods(fake);
    const longKey = "lne:" + "x".repeat(130);
    const r = dungeonSites.ensureSiteFrom(mods, validSpec({ siteKey: longKey }));
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, "SITE_KEY_INVALID");
  });

  test("S5 refusal: SYSTEM_UNKNOWN (planPositionFrom)", () => {
    const fake = createFakeDungeonRuntime();
    const mods = makeMods(fake, {
      worldData: {
        getCelestialsForSystem: () => [],
        getAsteroidBeltsForSystem: () => [],
        getStationsForSystem: () => [],
        getStargatesForSystem: () => [],
        getSolarSystemByID: () => null,
      },
    });
    const r = dungeonSites.ensureSiteFrom(mods, validSpec({ position: null }));
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, "SYSTEM_UNKNOWN");
  });

  test("S5 refusal: SITE_ID_MISMATCH (peekNextInstanceID returns different value)", () => {
    const fake = createFakeDungeonRuntime();
    let createCallCount = 0;
    const wrappingRuntime = {
      ...fake,
      peekNextInstanceID: () => 42,
      createInstance: (opts) => {
        createCallCount++;
        if (createCallCount === 1) {
          const instanceID = 43;
          const nowMs = Math.max(0, opts.nowMs || Date.now());
          const instance = {
            instanceID,
            templateID: opts.templateID || "",
            solarSystemID: Math.max(0, opts.solarSystemID || 0),
            siteKey: opts.siteKey || null,
            lifecycleState: (opts.lifecycleState || "active").toLowerCase(),
            lifecycleReason: opts.lifecycleReason || null,
            instanceScope: opts.instanceScope || "shared",
            siteFamily: (opts.siteFamily || "unknown").toLowerCase(),
            siteKind: (opts.siteKind || "anomaly").toLowerCase(),
            siteOrigin: opts.siteOrigin || "lne_event",
            source: opts.source || "manual",
            sourceDungeonID: opts.sourceDungeonID || 0,
            archetypeID: opts.archetypeID || 0,
            factionID: opts.factionID || 0,
            difficulty: opts.difficulty || 0,
            entryObjectTypeID: opts.entryObjectTypeID || null,
            dungeonNameID: opts.dungeonNameID || 0,
            position: opts.position || null,
            ownership: opts.ownership || {},
            timers: {
              ...(opts.timers || {}),
              lastUpdatedAtMs: nowMs,
              activatedAtMs: opts.activatedAtMs || nowMs,
              expiresAtMs: opts.expiresAtMs || null,
            },
            roomStatesByKey: {},
            gateStatesByKey: {},
            objectiveState: {},
            runtimeFlags: opts.runtimeFlags || {},
            metadata: opts.metadata || {},
            spawnState: opts.spawnState,
          };
          fake._instances.set(String(instanceID), instance);
          if (instance.siteKey) {
            fake._siteKeyIndex.set(instance.siteKey, instanceID);
          }
          return fake.buildInstanceSummary(instance);
        }
        return fake.createInstance(opts);
      },
    };
    const mods = makeMods(wrappingRuntime);
    const r = dungeonSites.ensureSiteFrom(mods, validSpec());
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, "SITE_ID_MISMATCH");
    assert.strictEqual(r.instanceId, 43);
    assert.strictEqual(r.vendorWrites, 1);
  });

  test("SH4: despawnSite parked:true -> systemId, siteId, the facade hides the site and asks the "
    + "scanner for a delta; parked:false -> no hide; purge forgets", () => {
    const SRC = path.join(path.sep, "x", "server", "src");
    const fake = createFakeDungeonRuntime();
    let parked = true;
    const mods = makeMods(fake, { siteService: { isUniverseSiteTeardownParked: () => parked } });
    const deltas = [];
    const sites = [];
    const provider = { listAnomalySites: () => sites };
    const cache = {};
    const put = (rel, exportsObject) => { cache[path.join(SRC, `${rel}.js`)] = { exports: exportsObject }; };
    put("services/dungeon/dungeonRuntime", mods.dungeonRuntime);
    put("services/dungeon/dungeonAuthority", mods.dungeonAuthority);
    put("services/dungeon/dungeonUniverseSiteService", mods.siteService);
    put("services/exploration/signatures/signaturePlacement", mods.placement);
    put("space/worldData", mods.worldData);
    put("gameStore/index", mods.gameStore);
    put("services/exploration/signatures/providers/sceneAnomalySiteProvider", provider);
    put("services/exploration/scanMgrService", { notifyAnomalyDeltaForSystem: (id) => deltas.push(id) });
    const adapter = createAdapter({ moduleApi: { _cache: cache } });
    assert.ok(adapter.setServerSrc(SRC).ok);
    assert.deepStrictEqual(adapter.installSiteScannerHide({ maxHidden: 16 }), { ok: true });
    assert.strictEqual(adapter.installSiteScannerHide({ maxHidden: 16 }).reason, "HOOK_ALREADY_INSTALLED");
    const seam = adapter.getDungeonSites();
    const a = seam.ensureSite(validSpec({ siteKey: "lne:sh4-a" }));
    assert.strictEqual(a.ok, true, JSON.stringify(a));
    sites.push({ siteID: a.siteId }, { siteID: 7 });

    const despawned = seam.despawnSite("lne:sh4-a", "lne_event_end", Date.now());
    assert.deepStrictEqual([despawned.ok, despawned.already, despawned.parked, despawned.systemId, despawned.siteId,
      despawned.scanner], [true, false, true, 30000001, a.siteId, "hidden"]);
    assert.deepStrictEqual(deltas, [30000001], "scanner delta of the system");
    assert.deepStrictEqual(provider.listAnomalySites(30000001).map((x) => x.siteID), [7], "hidden in the scanner");
    const again = seam.despawnSite("lne:sh4-a", "lne_event_end", Date.now());
    assert.deepStrictEqual([again.already, again.parked, again.siteId, again.scanner], [true, true, a.siteId, "hidden"]);
    assert.deepStrictEqual(deltas, [30000001, 30000001]);
    assert.deepStrictEqual(provider.listAnomalySites(30000001).map((x) => x.siteID), [7]);

    parked = false;
    const b = seam.ensureSite(validSpec({ siteKey: "lne:sh4-b", eventId: "evt-2" }));
    assert.strictEqual(b.ok, true, JSON.stringify(b));
    const plain = seam.despawnSite("lne:sh4-b", "lne_event_end", Date.now());
    assert.deepStrictEqual([plain.parked, plain.scanner, deltas.length], [false, undefined, 2]);

    const purged = seam.purgeSite("lne:sh4-a", 30000001);
    assert.deepStrictEqual([purged.purged, purged.siteId], [true, a.siteId]);
    assert.deepStrictEqual(provider.listAnomalySites(30000001).map((x) => x.siteID), [a.siteId, 7]);
    adapter.uninstallSiteScannerHide();
    assert.strictEqual(provider._lneWrapped, false);
  });

  test("SH5: a repeated despawn already:true + parked:true hides the site the first despawn did not "
    + "hide (commit of CLEANING->CLEANED failed); already + parked:false -> no hide", () => {
    const SRC = path.join(path.sep, "x", "server", "src");
    const fake = createFakeDungeonRuntime();
    let parked = true;
    const mods = makeMods(fake, { siteService: { isUniverseSiteTeardownParked: () => parked } });
    const deltas = [];
    const sites = [];
    const provider = { listAnomalySites: () => sites };
    const cache = {};
    const put = (rel, exportsObject) => { cache[path.join(SRC, `${rel}.js`)] = { exports: exportsObject }; };
    put("services/dungeon/dungeonRuntime", mods.dungeonRuntime);
    put("services/dungeon/dungeonAuthority", mods.dungeonAuthority);
    put("services/dungeon/dungeonUniverseSiteService", mods.siteService);
    put("services/exploration/signatures/signaturePlacement", mods.placement);
    put("space/worldData", mods.worldData);
    put("gameStore/index", mods.gameStore);
    put("services/exploration/signatures/providers/sceneAnomalySiteProvider", provider);
    put("services/exploration/scanMgrService", { notifyAnomalyDeltaForSystem: (id) => deltas.push(id) });
    const adapter = createAdapter({ moduleApi: { _cache: cache } });
    assert.ok(adapter.setServerSrc(SRC).ok);
    const seam = adapter.getDungeonSites();
    const a = seam.ensureSite(validSpec({ siteKey: "lne:sh5-a" }));
    assert.strictEqual(a.ok, true, JSON.stringify(a));
    sites.push({ siteID: a.siteId }, { siteID: 7 });

    const first = seam.despawnSite("lne:sh5-a", "lne_event_end", Date.now());
    assert.deepStrictEqual([first.ok, first.already, first.parked, first.scanner], [true, false, true, undefined]);
    assert.deepStrictEqual(provider.listAnomalySites(30000001).map((x) => x.siteID), [a.siteId, 7]);

    assert.deepStrictEqual(adapter.installSiteScannerHide({ maxHidden: 16 }), { ok: true });
    const retry = seam.despawnSite("lne:sh5-a", "lne_event_end", Date.now());
    assert.deepStrictEqual([retry.ok, retry.already, retry.parked, retry.siteId, retry.scanner],
      [true, true, true, a.siteId, "hidden"]);
    assert.deepStrictEqual(deltas, [30000001]);
    assert.deepStrictEqual(provider.listAnomalySites(30000001).map((x) => x.siteID), [7], "hidden in the scanner");

    parked = false;
    const late = seam.despawnSite("lne:sh5-a", "lne_event_end", Date.now());
    assert.deepStrictEqual([late.already, late.parked, late.scanner, deltas.length], [true, false, undefined, 1]);
    adapter.uninstallSiteScannerHide();
  });

  test("SP1: planPositionFrom keeps the sign of the anchor coordinates; an anchor with negative "
    + "x/z gives a position near the anchor", () => {
    const AU = 149597870700;
    const anchor = { x: -5e11, y: 2e9, z: -3e11 };
    const mods = makeMods(createFakeDungeonRuntime(), {
      worldData: {
        getCelestialsForSystem: () => [],
        getAsteroidBeltsForSystem: () => [{ itemID: 40000002, position: anchor }],
        getStationsForSystem: () => [],
        getStargatesForSystem: () => [],
        getSolarSystemByID: () => ({ radius: 1e12 }),
      },
      placement: {
        buildAnchorRelativeSignaturePlacement: (candidates, seed, opts) => {
          const a = candidates[0].position;
          return { position: { x: a.x + opts.baseDistanceAu * AU, y: a.y, z: a.z } };
        },
      },
    });
    const r = dungeonSites.planPositionFrom(mods, 30000001, "ore", "seed-1", 0.5);
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    const d = Math.hypot(r.position.x - anchor.x, r.position.y - anchor.y, r.position.z - anchor.z);
    assert.ok(d <= AU, `position ${JSON.stringify(r.position)} is ${d} m from the anchor`);
    assert.ok(r.position.x < 0 && r.position.z < 0, "sign kept");
    assert.deepStrictEqual(dungeonSites.extractStaticPosition({ position: { x: -1.7, y: "bad", z: -9 } }),
      { x: -1.7, y: 0, z: -9 });
  });
};
