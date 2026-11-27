"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { findServerSrcOnDisk, GAMESTORE_SEARCH_MAX_DEPTH } = require("../../lib/adapter/locator");
const { resolveSqliteDriver } = require("../../lib/adapter/sqliteDriver");
const { MIGRATIONS } = require("../../lib/persistence/migrations");
const { openStore } = require("../../lib/persistence/store");
const { createJournal } = require("../../lib/persistence/journal");
const { seedDbFile } = require("../_support/dbTemplate");
const { createFakeDungeonRuntime } = require("../_support/fakeDungeonRuntime");
const dungeonSites = require("../../lib/adapter/dungeonSites");
const nw = require("../../lib/adapter/nativeWrecks");
const { resolveConfig } = require("../../config");
const { createSiteService } = require("../../lib/events/sites/siteService");
const { createWreckRepository } = require("../../lib/world/wreckRepository");
const anomalyRepo = require("../../lib/events/salvage/anomalyRepository");
const { createSalvageAnomalyService } = require("../../lib/events/salvage/anomalyService");
const { placeSpecOf } = require("../../lib/events/salvage/plan");
const data = require("../../lib/events/salvage/data");
const { STATE } = require("../../lib/events/salvage/schema");
const { createSpikeAttribution } = require("../../lib/telemetry/spikeAttribution");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const T0 = 1700000000000;
const HOUR = 3600000;
const SYS = 30000011;
const SYS2 = 30000012;
const WRECK_TYPE = Object.freeze({ typeID: 26563, groupID: 186, categoryID: 2, groupName: "Wreck",
  name: "Guristas Medium Wreck" });

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

function withStore(driver, fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lne-salvs-"));
  const file = path.join(tmp, "world.sqlite");
  let store = null;
  try {
    seedDbFile(driver, file, { migrations: MIGRATIONS, seed: 1 });
    const opened = openStore({ filePath: file, openDatabase: (f) => new driver.Database(f), exclusiveLock: true,
      busyTimeoutMs: 0, maxRowsPerTransaction: 500, maxWriteMsPerPass: 5, randomSeed: () => 1,
      migrations: MIGRATIONS });
    assert.ok(opened.ok, JSON.stringify(opened));
    store = opened.store;
    return fn(store);
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
  const mods = {
    dungeonRuntime: raw,
    dungeonAuthority: { getTemplateByID: (id) => ({ templateID: id, siteFamily: "ore", siteKind: "anomaly",
      entryObjectTypeID: 19728 }) },
    siteService: { isUniverseSiteTeardownParked: () => false },
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
    checkTemplates: (ids) => dungeonSites.checkTemplatesFrom(mods, ids),
  };
  return { raw, seam };
}

function fakeVendor(dungeonRuntime, opts = {}) {
  const wrecks = new Map();
  const items = new Map();
  const calls = { scans: 0, itemScans: 0, gets: 0 };
  const fails = { item: opts.failItemWrites || 0, cascade: opts.failCascades || 0 };
  let nextWreck = 9000000;
  let nextItem = 9500000;
  const store = {
    TABLE: Object.freeze({ WRECKS: "npcWrecks", WRECK_ITEMS: "npcWreckItems" }),
    allocateWreckID: () => ({ success: true, data: ++nextWreck }),
    allocateWreckItemID: () => ({ success: true, data: ++nextItem }),
    upsertNativeWreck(record) {
      wrecks.set(record.wreckID, JSON.parse(JSON.stringify(record)));
      return { success: true };
    },
    upsertNativeWreckItem(record) {
      if (fails.item > 0) {
        fails.item -= 1;
        return { success: false, errorMsg: "ITEM_WRITE_FAILED" };
      }
      items.set(record.wreckItemID, { ...record });
      return { success: true };
    },
    listNativeWrecks() {
      calls.scans += 1;
      return [...wrecks.values()].map((w) => ({ ...w }));
    },
    getNativeWreck(id) {
      calls.gets += 1;
      const w = wrecks.get(Number(id));
      return w ? { ...w } : null;
    },
    listNativeWreckItemsForWreck(id) {
      calls.itemScans += 1;
      return [...items.values()].filter((i) => i.wreckID === id);
    },
    removeNativeWreckCascade(id) {
      if (fails.cascade > 0) {
        fails.cascade -= 1;
        return { success: false, errorMsg: "CASCADE_FAILED" };
      }
      for (const [k, v] of items) if (v.wreckID === id) items.delete(k);
      wrecks.delete(id);
      return { success: true };
    },
  };
  class Runtime {
    isSolarSystemSceneLoaded(id) { return this.scenes.has(id); }
  }
  const mods = {
    store,
    wreckService: { spawnNativeWreck: () => ({ success: true }), destroyNativeWreck: () => ({ success: true }) },
    wreckUtils: { resolveEntityWreckType: () => WRECK_TYPE, resolveShipWreckType: () => null },
    npcData: { getNpcLootTable: (id) => ({ id, minEntries: 1, maxEntries: 3 }) },
    npcLoot: { rollNpcLootEntries: () => (opts.emptyRolls ? []
      : [{ itemType: { typeID: 34, name: "Tritanium" }, quantity: 5 }]) },
    itemStore: { ITEM_FLAGS: Object.freeze({ HANGAR: 4 }), getItemMetadata: () => ({ groupID: 18, categoryID: 4 }) },
    typeRegistry: {
      resolveItemByTypeID: () => null,
      resolveItemByName: (name) => (name === "Wreck" || name.endsWith(" Wreck")
        ? { success: true, match: { ...WRECK_TYPE, typeID: 26500, name } } : { success: false }),
    },
    runtime: Object.assign(Object.create(Runtime.prototype), { scenes: new Set() }),
    dungeonRuntime,
    gameStore: null,
  };
  return { mods, wrecks, items, calls, facade: nw.createNativeWrecksFacade(mods) };
}

function harness(store, opts = {}) {
  const clock = { t: T0, now() { return this.t; } };
  const config = configOf(opts.env);
  const world = fakeWorld();
  const vendor = fakeVendor(world.raw, opts.vendor);
  const adapter = { getDungeonSites: () => world.seam, checkDungeonSites: () => ({ ok: true }),
    getNativeWrecks: () => vendor.facade, checkNativeWrecks: () => ({ ok: true }) };
  const journal = createJournal({ clock, maxPayloadBytes: 16384, maxRows: 500 });
  const wreckRepo = createWreckRepository({ journal });
  const logger = { lines: [], log(line) { this.lines.push(line); } };
  const siteService = createSiteService({ store, adapter, clock, config, telemetry: null, logger });
  const sites = { ...siteService, getStatus: () => ({ state: "running" }) };
  const presence = { systems: [SYS, SYS2], getStatus: () => ({ available: true, stale: false }),
    observedSystems() { return this.systems; } };
  const counters = {};
  const ops = [];
  const telemetry = { count(name, n = 1) { counters[name] = (counters[name] || 0) + n; return true; },
    observe() { return true; }, noteOp(kind, label, startMs, ms) { ops.push([kind, label, startMs, ms]); } };
  const make = () => createSalvageAnomalyService({ store, journal, worldSeed: 1, adapter, clock, config, telemetry,
    logger, getPresence: () => presence, getSites: () => sites, getWrecks: () => ({ repository: wreckRepo }),
    ...(opts.deps || {}) });
  const tx = (fn) => {
    const r = store.transaction("test", fn);
    assert.ok(r.ok, JSON.stringify(r));
    return r.value;
  };
  const h = {
    clock, config, vendor, sites, presence, logger, tx, ops, svc: make(),
    c: (name) => counters[`salvageAnomaly.${name}`] || 0,
    restart() { h.svc = make(); },
    pass(at) {
      clock.t = at;
      const r = h.svc.runPass(at);
      assert.ok(r.ok, JSON.stringify(r));
      return r;
    },
    sitesPass(at) {
      clock.t = at;
      assert.ok(siteService.runPass(at).ok);
    },
    addField(fieldId, systemId, extra = {}) {
      const field = { fieldId, battleId: null, source: "structure", systemId, environment: "nullsec", outcome: null,
        winnerFactionId: null, shipsLost: 6, composition: [[500010, "cruiser", 17715, 2], [500010, "frigate", 0, 4]],
        salvageUnits: 12, lootUnits: 10, decayFloorPpm: 500000, createdAt: T0 - 1000, expiresAt: T0 + 2 * HOUR,
        ...extra };
      const r = tx((db) => wreckRepo.insertInTx(db, field, `test:${fieldId}`));
      assert.ok(r.ok, JSON.stringify(r));
      return field;
    },
    anomaly: (fieldId) => tx((db) => anomalyRepo.getByFieldInTx(db, fieldId)),
    siteRows: (eventId) => tx((db) => siteService.listSitesByEvent(eventId, db)).sites,
  };
  return h;
}

function toPlacing(h, fieldId) {
  h.pass(T0);
  h.sitesPass(T0 + 1);
  h.pass(T0 + 20000);
  const a = h.anomaly(fieldId);
  assert.strictEqual(a.state, STATE.PLACING);
  return a;
}

module.exports = ({ test, skip }) => {
  const driver = loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };
  const env = { EVEJS_LNE_SALVAGE_ANOMALY_MAX_LOOT_ROLLS_PER_WRECK: "0",
    EVEJS_LNE_SALVAGE_ANOMALY_MAX_WRECK_WRITES_PER_PASS: "4" };

  needsDriver("SAS1 scans: 1 adoption scan per anomaly per process, PLACED / ENDING by known IDs "
    + "1 full scan before ENDED; restart in PLACING scans again and adopts the orphan", () => {
    withStore(driver, (store) => {
      const h = harness(store, { env });
      const f = h.addField("wf:scale:1", SYS, { expiresAt: T0 + HOUR });
      toPlacing(h, f.fieldId);
      const calls = h.vendor.calls;
      assert.strictEqual(calls.scans, 0);
      h.pass(T0 + 30000);
      h.pass(T0 + 30001);
      let a = h.anomaly(f.fieldId);
      assert.deepStrictEqual([a.state, a.wrecksPlaced, h.vendor.wrecks.size], [STATE.PLACED, 6, 6]);
      assert.deepStrictEqual([calls.scans, h.c("adoptionScans")], [1, 1], "one adoption scan, none in place");

      h.pass(T0 + 30001 + 60000);
      h.pass(T0 + 30001 + 120000);
      assert.strictEqual(h.anomaly(f.fieldId).state, STATE.PLACED);
      assert.deepStrictEqual([calls.scans, calls.itemScans], [1, 0], "tracking reads known IDs only");
      assert.ok(calls.gets >= 12, `getNativeWreck per known wreck (${calls.gets})`);

      h.pass(T0 + HOUR);
      a = h.anomaly(f.fieldId);
      assert.deepStrictEqual([a.state, a.endReason], [STATE.ENDING, "FIELD_GONE"]);
      h.pass(T0 + HOUR + 1);
      h.pass(T0 + HOUR + 2);
      assert.deepStrictEqual([h.vendor.wrecks.size, calls.scans], [0, 1], "removal by known IDs, no scan");
      h.pass(T0 + HOUR + 3);
      a = h.anomaly(f.fieldId);
      assert.strictEqual(a.state, STATE.ENDED);
      assert.strictEqual(calls.scans, 2, "one full scan before ENDED");
      assert.strictEqual(h.c("wrecksRemoved"), 6);
    });

    withStore(driver, (store) => {
      const h = harness(store, { env });
      const f = h.addField("wf:scale:2", SYS);
      toPlacing(h, f.fieldId);
      h.pass(T0 + 30000);
      let a = h.anomaly(f.fieldId);
      assert.deepStrictEqual([a.wrecksPlaced, h.vendor.calls.scans], [4, 1]);
      const siteKey = h.siteRows(a.anomalyId)[0].siteKey;
      const r = a.plan[4];
      const orphan = h.vendor.facade.place({ ...placeSpecOf(a, { slot: r[0], shipTypeId: r[1], hullGroup: r[2],
        factionId: r[3], lootRolls: r[4], offset: { x: r[5], y: r[6], z: r[7] } },
      { siteKey, nowMs: T0 + 30001, lootTableFor: () => null }), adopt: false });
      assert.strictEqual(orphan.ok, true);
      const before = h.vendor.calls.scans;
      const scansBefore = h.c("adoptionScans");
      h.restart();
      h.pass(T0 + 40000);
      a = h.anomaly(f.fieldId);
      assert.deepStrictEqual([a.state, a.wrecksPlaced, h.vendor.wrecks.size], [STATE.PLACED, 6, 6], "no duplicate");
      assert.ok(a.placed.some((p) => p[0] === 4 && p[1] === orphan.wreckId));
      assert.deepStrictEqual([h.c("adoptionScans") - scansBefore, h.c("wrecksAdopted")], [1, 1]);
      assert.strictEqual(h.vendor.calls.scans - before, 2);
    });
  });

  needsDriver("SAS2 claims: a full site window blocks only its system for sites.retryDelayMs", () => {
    withStore(driver, (store) => {
      const h = harness(store);
      for (const slot of [0, 1]) {
        const r = h.tx((db) => h.sites.createSiteInTx(db, { eventId: "other", slot, systemId: SYS,
          templateId: "tpl", label: "Other", factionId: null, expiresAt: T0 + HOUR }));
        assert.ok(r.ok, JSON.stringify(r));
      }
      const fa = h.addField("wf:hol:a", SYS);
      const fb = h.addField("wf:hol:b", SYS2);
      assert.strictEqual(h.pass(T0).claimed, 1);
      assert.strictEqual(h.anomaly(fb.fieldId).state, STATE.SITE_PENDING, "B claimed in the same pass");
      assert.strictEqual(h.anomaly(fa.fieldId), null);
      assert.strictEqual(h.c("refused.SYSTEM_WINDOW_FULL"), 1);
      assert.strictEqual(h.pass(T0 + 10000).claimed, 0);
      assert.strictEqual(h.c("refused.SYSTEM_WINDOW_FULL"), 1, "A not tried again before retryDelayMs");
      h.pass(T0 + h.config.sites.retryDelayMs);
      assert.strictEqual(h.c("refused.SYSTEM_WINDOW_FULL"), 2, "A tried again after retryDelayMs");
    });
  });

  needsDriver("SAS3 counters: wrecksNoLootTable + one log line per faction, wrecksEmpty", () => {
    const loud = { EVEJS_LNE_SALVAGE_ANOMALY_MAX_WRECK_WRITES_PER_PASS: "16" };
    withStore(driver, (store) => {
      const h = harness(store, { env: loud,
        deps: { lootTablesMissing: data.allLootTableIds(), fallbackLootUsable: false } });
      const f = h.addField("wf:loot:none", SYS, { composition: [[500010, "cruiser", 17715, 2]], shipsLost: 2 });
      const a = toPlacing(h, f.fieldId);
      const withLoot = a.plan.filter((row) => row[4] > 0).length;
      assert.strictEqual(withLoot, 2, "both wrecks planned with loot");
      h.pass(T0 + 30000);
      assert.strictEqual(h.anomaly(f.fieldId).state, STATE.PLACED);
      assert.deepStrictEqual([h.c("wrecksNoLootTable"), h.c("wrecksEmpty")], [2, 0]);
      assert.strictEqual(h.logger.lines.filter((l) => l.includes("no loot table for faction 500010")).length, 1);
    });

    withStore(driver, (store) => {
      const h = harness(store, { env: loud, vendor: { emptyRolls: true } });
      const f = h.addField("wf:loot:empty", SYS);
      const a = toPlacing(h, f.fieldId);
      const withLoot = a.plan.filter((row) => row[4] > 0).length;
      assert.ok(withLoot > 0, "plan has loot rolls");
      h.pass(T0 + 30000);
      assert.strictEqual(h.anomaly(f.fieldId).state, STATE.PLACED);
      assert.deepStrictEqual([h.c("wrecksEmpty"), h.c("wrecksNoLootTable")], [withLoot, 0]);
    });
  });

  needsDriver("SAS4 failed place with a vendor write and a failed cascade: the next step scans again "
    + "and adopts the half-written wreck (1 wreck per slot)", () => {
    withStore(driver, (store) => {
      const h = harness(store, { env: { EVEJS_LNE_SALVAGE_ANOMALY_MAX_WRECK_WRITES_PER_PASS: "16" },
        vendor: { failItemWrites: 1, failCascades: 1 } });
      const f = h.addField("wf:note1", SYS);
      const a0 = toPlacing(h, f.fieldId);
      assert.ok(a0.plan.some((row) => row[4] > 0), "plan has loot rolls (item writes happen)");
      h.pass(T0 + 30000);
      let a = h.anomaly(f.fieldId);
      assert.strictEqual(a.state, STATE.PLACING, "step failed on the item write");
      assert.strictEqual(h.vendor.wrecks.size, a.wrecksPlaced + 1, "half-written wreck stays (cascade failed)");
      assert.strictEqual(h.c("adoptionScans"), 1);
      h.pass(T0 + 30000 + h.config.salvageAnomaly.pumpIntervalMs);
      a = h.anomaly(f.fieldId);
      assert.strictEqual(a.state, STATE.PLACED);
      assert.strictEqual(h.c("adoptionScans"), 2, "second adoption scan after the failed place");
      assert.strictEqual(h.c("wrecksAdopted"), 1);
      assert.strictEqual(h.vendor.wrecks.size, a.plan.length, "1 wreck per slot");
      const placedIds = new Set(a.placed.map((p) => p[1]));
      assert.ok([...h.vendor.wrecks.keys()].every((id) => placedIds.has(id)), "no orphan outside placed_json");
    });
  });

  needsDriver("SAS5 vendor calls of the step phase -> noteOp adapter:salvage.<method>; the spike line "
    + "attributes them to lne (adapter), not rest", () => {
    withStore(driver, (store) => {
      let perf = 1000;
      const h = harness(store, { env, deps: { nowMs: () => (perf += 5) } });
      const f = h.addField("wf:meter", SYS);
      toPlacing(h, f.fieldId);
      h.ops.length = 0;
      h.pass(T0 + 30000);
      assert.strictEqual(h.anomaly(f.fieldId).wrecksPlaced, 4, "same result through the metered seam");
      const labels = h.ops.map((o) => `${o[0]}:${o[1]}`);
      assert.deepStrictEqual(labels.filter((l) => l === "adapter:salvage.place").length, 4);
      assert.ok(labels.includes("adapter:salvage.listOwn") && labels.includes("adapter:salvage.flush"), labels.join());
      assert.ok(h.ops.every((o) => o[3] === 5), "duration = one call");

      const lines = [];
      const counters = {};
      const a = createSpikeAttribution({ thresholdMs: 1, log: (l) => lines.push(l),
        count: (n) => { counters[n] = (counters[n] || 0) + 1; } });
      const gapStart = h.ops[0][2] - 1;
      const gapEnd = h.ops[h.ops.length - 1][2] + 10;
      for (const o of h.ops) a.noteOp(o[0], o[1], o[2], o[3]);
      a.onTick({ atMs: gapEnd, intervalMs: gapEnd - gapStart, latenessMs: h.ops.length * 5, workMs: 0 });
      a.resolve(gapEnd);
      a.resolve(gapEnd + 1);
      assert.strictEqual(lines.length, 1, lines.join("\n"));
      assert.ok(/ source=lne /.test(lines[0]) && lines[0].includes("adapter:salvage.place/5"), lines[0]);
      assert.strictEqual(counters["telemetry.spikeLne.adapter"], 1);
    });
  });
};
