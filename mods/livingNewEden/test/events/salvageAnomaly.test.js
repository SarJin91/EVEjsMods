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
const { TABLE_POLICY } = require("../../lib/persistence/worldReset");
const { seedDbFile } = require("../_support/dbTemplate");
const { createFakeDungeonRuntime } = require("../_support/fakeDungeonRuntime");
const dungeonSites = require("../../lib/adapter/dungeonSites");
const nw = require("../../lib/adapter/nativeWrecks");
const { resolveConfig, SCHEMA } = require("../../config");
const { createSiteService } = require("../../lib/events/sites/siteService");
const { createWreckRepository } = require("../../lib/world/wreckRepository");
const { effectivePool } = require("../../lib/world/wreckPool");
const { isMetricName } = require("../../lib/telemetry/registry");
const { MODULE_CHANNELS } = require("../../lib/telemetry/snapshot");
const anomalyRepo = require("../../lib/events/salvage/anomalyRepository");
const { createSalvageAnomalyService, COUNTER_NAMES } = require("../../lib/events/salvage/anomalyService");
const { startSalvageAnomaly, unavailableSalvageAnomaly } = require("../../lib/events/salvage");
const { planAnomaly, placeSpecOf } = require("../../lib/events/salvage/plan");
const data = require("../../lib/events/salvage/data");
const { TABLE_NAME, STATE } = require("../../lib/events/salvage/schema");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const T0 = 1700000000000;
const HOUR = 3600000;
const SYS = 30000011;
const SYS2 = 30000012;
const WRECK_TYPE = Object.freeze({ typeID: 26563, groupID: 186, categoryID: 2, groupName: "Wreck",
  name: "Guristas Medium Wreck" });
const VENDOR_UNRESOLVED = new Set(["Amarr Battleship Wreck", "Caldari Battleship Wreck", "Gallente Battleship Wreck",
  "Minmatar Battleship Wreck", "Orca Wreck", "Sleeper Small Wreck", "Sleeper Medium Wreck", "Sleeper Large Wreck",
  "Battlecruiser Wreck", "Destroyer Wreck", "Dreadnought Wreck", "Freighter Wreck", "Hauler Wreck",
  "Mining Barge Wreck"]);

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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lne-salv-"));
  const file = path.join(tmp, "world.sqlite");
  let store = null;
  try {
    seedDbFile(driver, file, { migrations: MIGRATIONS, seed: 1 });
    const opened = openStore({ filePath: file, openDatabase: (f) => new driver.Database(f), exclusiveLock: true,
      busyTimeoutMs: 0, maxRowsPerTransaction: 500, maxWriteMsPerPass: 5, randomSeed: () => 1,
      migrations: MIGRATIONS });
    assert.ok(opened.ok, JSON.stringify(opened));
    store = opened.store;
    assert.strictEqual(store.db, undefined, "production shape: no store.db");
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
  const mods = {
    dungeonRuntime: raw,
    dungeonAuthority: { getTemplateByID: (id) => (id === "missing" ? null
      : { templateID: id, siteFamily: "ore", siteKind: "anomaly", entryObjectTypeID: 19728 }) },
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

function fakeVendor(dungeonRuntime) {
  const wrecks = new Map();
  const items = new Map();
  const calls = { place: 0, remove: 0, flush: 0 };
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
      items.set(record.wreckItemID, { ...record });
      return { success: true };
    },
    listNativeWrecks: () => [...wrecks.values()].map((w) => ({ ...w })),
    listNativeWreckItemsForWreck: (id) => [...items.values()].filter((i) => i.wreckID === id),
    removeNativeWreckCascade(id) {
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
    npcData: { getNpcLootTable: (id) => (id.startsWith("parity_") || id.startsWith("loot_belt_normal_") || id === "generic_random_any" ? { id, minEntries: 1, maxEntries: 3 } : null) },
    npcLoot: { rollNpcLootEntries: () => [{ itemType: { typeID: 34, name: "Tritanium" }, quantity: 5 }] },
    itemStore: { ITEM_FLAGS: Object.freeze({ HANGAR: 4 }), getItemMetadata: () => ({ groupID: 18, categoryID: 4 }) },
    typeRegistry: {
      resolveItemByTypeID: () => null,
      resolveItemByName: (name) => ((name === "Wreck" || name.endsWith(" Wreck")) && !VENDOR_UNRESOLVED.has(name)
        ? { success: true, match: { ...WRECK_TYPE, typeID: 26500, name } } : { success: false }),
    },
    runtime: Object.assign(Object.create(Runtime.prototype), { scenes: new Map() }),
    dungeonRuntime,
    gameStore: null,
  };
  const facade = nw.createNativeWrecksFacade(mods);
  const counted = { ...facade,
    place: (spec) => { calls.place += 1; return facade.place(spec); },
    remove: (...args) => { calls.remove += 1; return facade.remove(...args); },
    flush: () => { calls.flush += 1; return facade.flush(); } };
  return { mods, wrecks, items, calls, facade: counted };
}

function fakeTelemetry() {
  const counters = {};
  return { counters, count(name, n = 1) { counters[name] = (counters[name] || 0) + n; return true; },
    observe() { return true; } };
}

function harness(store, opts = {}) {
  const clock = { t: T0, now() { return this.t; } };
  const config = opts.config || configOf(opts.env);
  const world = fakeWorld();
  const vendor = fakeVendor(world.raw);
  const adapter = { getDungeonSites: () => world.seam, checkDungeonSites: () => ({ ok: true }),
    getNativeWrecks: () => vendor.facade, checkNativeWrecks: () => ({ ok: true }) };
  const journal = createJournal({ clock, maxPayloadBytes: 16384, maxRows: 500 });
  const wreckRepo = createWreckRepository({ journal });
  const logger = { lines: [], log(line) { this.lines.push(line); } };
  const siteService = createSiteService({ store, adapter, clock, config, telemetry: null, logger });
  const nudges = { n: 0 };
  const sites = { ...siteService, getStatus: () => ({ state: "running" }), nudge: () => { nudges.n += 1; } };
  const presence = { status: { available: true, stale: false }, systems: [SYS, SYS2],
    getStatus() { return this.status; }, observedSystems() { return this.systems; } };
  const telemetry = fakeTelemetry();
  const make = () => createSalvageAnomalyService({ store, journal, worldSeed: 1, adapter, clock, config, telemetry,
    logger, getPresence: () => presence, getSites: () => sites,
    getWrecks: () => ({ repository: h.repoWrap ? h.repoWrap(wreckRepo) : wreckRepo }),
    ...(Object.prototype.hasOwnProperty.call(opts, "getOfficerSpawns")
      ? { getOfficerSpawns: opts.getOfficerSpawns } : {}) });
  const tx = (fn) => {
    const r = store.transaction("test", fn);
    assert.ok(r.ok, JSON.stringify(r));
    return r.value;
  };
  const h = {
    clock, config, world, vendor, adapter, journal, wreckRepo, sites, nudges, presence, telemetry, logger, tx,
    repoWrap: null,
    svc: null,
    restart() { h.svc = make(); },
    pass(at) {
      clock.t = at;
      const r = h.svc.runPass(at);
      assert.ok(r.ok, JSON.stringify(r));
      return r;
    },
    sitesPass(at) {
      clock.t = at;
      const r = siteService.runPass(at);
      assert.ok(r.ok, JSON.stringify(r));
      return r;
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
    field: (fieldId) => tx((db) => wreckRepo.get(db, fieldId)).field,
    anomaly: (fieldId) => tx((db) => anomalyRepo.getByFieldInTx(db, fieldId)),
    count: () => tx((db) => db.prepare(`SELECT COUNT(*) AS n FROM ${TABLE_NAME}`).get().n),
    siteRows: (eventId) => tx((db) => siteService.listSitesByEvent(eventId, db)).sites,
    allSites: () => tx((db) => db.prepare("SELECT event_id, state FROM world_event_sites ORDER BY event_id").all()),
    journalKeys: (prefix) => tx((db) => db.prepare(
      "SELECT idempotency_key AS k FROM world_event_journal WHERE idempotency_key LIKE ? ORDER BY k").all(`${prefix}%`)
      .map((r) => r.k)),
  };
  h.svc = make();
  return h;
}

const PARAMS = Object.freeze({ maxWrecksPerAnomaly: 12, lootUnitsPerRoll: 4, maxLootRollsPerWreck: 3,
  wreckSpreadM: 10000 });

module.exports = ({ test, skip }) => {
  const driver = loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  test("SA1 planAnomaly: deterministic, wreck limit, loot split + rolls, typeId 0 -> fallback names "
    + "older field -> fewer wrecks", () => {
    const field = { composition: [[500010, "frigate", 0, 4], [500010, "cruiser", 17715, 2],
      [500020, "battleship", 640, 1]], shipsLost: 7, salvageUnits: 24, lootUnits: 18 };
    const a = planAnomaly(field, { salvage: 24, loot: 18 }, PARAMS, 4242);
    const b = planAnomaly(field, { salvage: 24, loot: 18 }, PARAMS, 4242);
    assert.ok(a.ok, JSON.stringify(a));
    assert.deepStrictEqual(a, b, "same seed -> same plan");
    assert.notDeepStrictEqual(planAnomaly(field, { salvage: 24, loot: 18 }, PARAMS, 4243).rows, a.rows);
    assert.deepStrictEqual(a.wrecks.map((w) => [w.slot, w.hullGroup, w.factionId, w.shipTypeId]),
      [[0, "battleship", 500020, 640], [1, "cruiser", 500010, 17715], [2, "cruiser", 500010, 17715],
        [3, "frigate", 500010, 0], [4, "frigate", 500010, 0], [5, "frigate", 500010, 0], [6, "frigate", 500010, 0]]);
    assert.deepStrictEqual(a.wrecks.map((w) => [w.lootUnits, w.lootRolls]),
      [[8, 2], [3, 1], [3, 1], [1, 1], [1, 1], [1, 1], [1, 1]]);
    assert.strictEqual(a.label, "Guristas Wreckage", "label of the faction with most hulls");
    const rich = planAnomaly(field, { salvage: 24, loot: 100 }, PARAMS, 4242);
    assert.deepStrictEqual(rich.wrecks.map((w) => w.lootUnits), [45, 17, 17, 6, 5, 5, 5]);
    assert.deepStrictEqual(rich.wrecks.map((w) => w.lootRolls), [3, 3, 3, 1, 1, 1, 1]);
    assert.strictEqual(planAnomaly(field, { salvage: 24, loot: 18 }, { ...PARAMS, maxWrecksPerAnomaly: 3 }, 1)
      .wrecks.length, 3);
    assert.strictEqual(planAnomaly(field, { salvage: 12, loot: 9 }, PARAMS, 1).wrecks.length, 4);
    assert.strictEqual(planAnomaly(field, { salvage: 0, loot: 0 }, PARAMS, 1).wrecks.length, 1);
    for (const w of a.wrecks) {
      assert.ok(Object.values(w.offset).every(Number.isSafeInteger));
      assert.ok(Math.hypot(w.offset.x, w.offset.y * 4, w.offset.z) <= PARAMS.wreckSpreadM + 4);
    }
    for (let i = 0; i < a.wrecks.length; i += 1) {
      for (let j = i + 1; j < a.wrecks.length; j += 1) {
        const p = a.wrecks[i].offset;
        const q = a.wrecks[j].offset;
        assert.ok(Math.hypot(p.x - q.x, p.y - q.y, p.z - q.z) >= 500, `${i}-${j}`);
      }
    }
    const row = { anomalyId: "salv:x", systemId: SYS, expiresAt: T0 + HOUR };
    const ctx = { siteKey: "lne:salv:x:0", nowMs: T0, lootTableFor: (f, hg) => data.lootTableOf(f, hg) };
    const frigate = placeSpecOf(row, a.wrecks[3], ctx);
    assert.deepStrictEqual([frigate.shipTypeId, frigate.fallbackWreckNames, frigate.ownerId, frigate.lootTableId,
      frigate.factionName], [0, ["Guristas Small Wreck", "Frigate Wreck", "Mission Generic Small Wreck", "Wreck"],
      1000127, "loot_belt_normal_small", "Guristas Pirates"]);
    const bs = placeSpecOf(row, a.wrecks[0], ctx);
    assert.deepStrictEqual([bs.fallbackWreckNames, bs.lootTableId, bs.lootRolls], [[], "loot_belt_normal_large", 2]);
    assert.deepStrictEqual([frigate.lootSourceNpcTypeId, bs.lootSourceNpcTypeId], [2382, 11921]);
    assert.strictEqual(data.lootSourceNpcTypeOf(500021, "frigate"), 0, "Sleepers: no pirate source");
    assert.strictEqual(data.lootSourceNpcTypeOf(500010, "no_such_hull"), 0);
    assert.strictEqual(data.lootSourceNpcTypeOf(500018, "destroyer"), 0, "Mordu has no destroyer group");
    for (const hg of Object.keys(data.HULL_CLASS)) assert.ok(data.LOOT_SOURCE_BAND[hg], `band of ${hg}`);
    assert.strictEqual(data.LOOT_SOURCE_BAND.capital, "battleship");
    assert.strictEqual(data.lootSourceNpcTypeOf(500020, "capital"), 11921, "Serpentis capital -> battleship NPC");
    assert.strictEqual(data.lootSourceNpcTypeOf(500020, "capital"), data.lootSourceNpcTypeOf(500020, "battleship"));
    assert.strictEqual(nw.validatePlaceSpec(frigate), null, "spec accepted by the seam");
    const noLoot = placeSpecOf(row, a.wrecks[0], { ...ctx, lootTableFor: () => null });
    assert.deepStrictEqual([noLoot.lootTableId, noLoot.lootRolls], [null, 0]);
    assert.deepStrictEqual([data.ownerCorporationOf(500021), data.lootTableOf(500021, "battleship"),
      data.wreckFactionNameOf(500021)], [data.FALLBACK_OWNER_CORPORATION_ID, "loot_sleeper_blue_large", "Sleeper"]);
    assert.deepStrictEqual(Object.keys(data.HULL_CLASS).sort(), Object.keys(data.HULL_SIZE).sort());
  });

  test("SA-LR planAnomaly: a wreck with loot units gets at least 1 roll, units 0 / maxLootRollsPerWreck 0 -> 0, "
    + "capped at the maximum", () => {
    const fieldOf = (n) => ({ composition: [[500010, "cruiser", 17715, n]], shipsLost: n, salvageUnits: 4 * n,
      lootUnits: 100 });
    const plan = (n, loot, params = PARAMS) => planAnomaly(fieldOf(n), { salvage: 4 * n, loot }, params, 7);
    const got = [
      plan(3, 5).wrecks.map((w) => [w.lootUnits, w.lootRolls]),
      plan(2, 4).wrecks.map((w) => [w.lootUnits, w.lootRolls]),
      plan(3, 0).wrecks.map((w) => w.lootRolls),
      plan(3, 5, { ...PARAMS, maxLootRollsPerWreck: 0 }).wrecks.map((w) => w.lootRolls),
      plan(3, 1000).wrecks.map((w) => w.lootRolls),
    ];
    assert.deepStrictEqual(got, [[[2, 1], [2, 1], [1, 1]], [[2, 1], [2, 1]], [0, 0, 0], [0, 0, 0], [3, 3, 3]]);
    assert.deepStrictEqual(plan(3, 5).rows.map((r) => r[4]), [1, 1, 1]);
  });

  test("SA-WN fallbackWreckNamesOf: faction + size names, unambiguous in EveJS, every list ends with Wreck", () => {
    const cases = [
      [["destroyer", 500010], ["Guristas Small Wreck", "Frigate Wreck", "Mission Generic Small Wreck", "Wreck"]],
      [["battlecruiser", 500001], ["Caldari Battlecruiser Wreck", "Cruiser Wreck", "Mission Generic Medium Wreck",
        "Wreck"]],
      [["battleship", 500003], ["Battleship Wreck", "Mission Generic Large Wreck", "Wreck"]],
      [["industrial", 500004], ["Gallente Hauler Wreck", "Cruiser Wreck", "Mission Generic Medium Wreck", "Wreck"]],
      [["capital", 500019], ["Sansha Dreadnought Wreck", "Sanshas Large Wreck", "Battleship Wreck",
        "Mission Generic Large Wreck", "Wreck"]],
      [["rorqual", 500014], ["ORE Rorqual Wreck", "Battleship Wreck", "Mission Generic Large Wreck", "Wreck"]],
      [["freighter", 500014], ["ORE Freighter Wreck", "Battleship Wreck", "Mission Generic Large Wreck", "Wreck"]],
      [["frigate", 500021], ["Sleeper Small Basic Wreck", "Frigate Wreck", "Mission Generic Small Wreck", "Wreck"]],
      [["nieznana", null], ["Cruiser Wreck", "Mission Generic Medium Wreck", "Wreck"]],
    ];
    for (const [[g, f], want] of cases) assert.deepStrictEqual(data.fallbackWreckNamesOf(g, f), want, `${g}/${f}`);
    const first = data.fallbackWreckNamesOf("frigate", 500010);
    first.push("x");
    assert.strictEqual(data.fallbackWreckNamesOf("frigate", 500010).length, 4, "a new array on every call");
    const { HULL_GROUPS } = require("../../lib/fleets/schema");
    const factions = [null, 999999, 500014, ...Object.keys(data.RACE_WRECK_PREFIX).map(Number),
      ...Object.keys(data.PIRATE_SIZE_WRECK).map(Number)];
    for (const g of HULL_GROUPS) {
      for (const f of factions) {
        const list = data.fallbackWreckNamesOf(g, f);
        assert.ok(list.length > 0, `${g}/${f}`);
        assert.strictEqual(new Set(list).size, list.length, `${g}/${f} duplicates`);
        assert.strictEqual(list[list.length - 1], "Wreck", `${g}/${f}`);
      }
    }
    const GOLDEN = ["Amarr Battlecruiser Wreck", "Amarr Cruiser Wreck", "Amarr Destroyer Wreck",
      "Amarr Dreadnought Wreck", "Amarr Freighter Wreck", "Amarr Frigate Wreck", "Amarr Hauler Wreck",
      "Amarr Mining Barge Wreck", "Angel Dreadnought Wreck", "Angel Large Wreck", "Angel Medium Wreck",
      "Angel Small Wreck", "Battleship Wreck", "Blood Dreadnought Wreck", "Blood Large Wreck", "Blood Medium Wreck",
      "Blood Small Wreck", "Caldari Battlecruiser Wreck", "Caldari Cruiser Wreck", "Caldari Destroyer Wreck",
      "Caldari Dreadnought Wreck", "Caldari Freighter Wreck", "Caldari Frigate Wreck", "Caldari Hauler Wreck",
      "Caldari Mining Barge Wreck", "Cruiser Wreck", "Frigate Wreck", "Gallente Battlecruiser Wreck",
      "Gallente Cruiser Wreck", "Gallente Destroyer Wreck", "Gallente Dreadnought Wreck", "Gallente Freighter Wreck",
      "Gallente Frigate Wreck", "Gallente Hauler Wreck", "Gallente Mining Barge Wreck", "Guristas Dreadnought Wreck",
      "Guristas Large Wreck", "Guristas Medium Wreck", "Guristas Small Wreck", "Minmatar Battlecruiser Wreck",
      "Minmatar Cruiser Wreck", "Minmatar Destroyer Wreck", "Minmatar Dreadnought Wreck", "Minmatar Freighter Wreck",
      "Minmatar Frigate Wreck", "Minmatar Hauler Wreck", "Minmatar Mining Barge Wreck", "Mission Generic Large Wreck",
      "Mission Generic Medium Wreck", "Mission Generic Small Wreck", "ORE Freighter Wreck", "ORE Rorqual Wreck",
      "Rogue Carrier Wreck", "Rogue Large Wreck", "Rogue Medium Wreck", "Rogue Small Wreck",
      "Sansha Dreadnought Wreck", "Sanshas Large Wreck", "Sanshas Medium Wreck", "Sanshas Small Wreck",
      "Serpentis Dreadnought Wreck", "Serpentis Large Wreck", "Serpentis Medium Wreck", "Serpentis Small Wreck",
      "Sleeper Large Basic Wreck", "Sleeper Medium Basic Wreck", "Sleeper Small Basic Wreck", "Wreck"];
    const all = data.allFallbackWreckNames();
    assert.deepStrictEqual(all, [...GOLDEN].sort());
    assert.deepStrictEqual(all, GOLDEN, "golden is sorted");
    for (const list of Object.values(data.GENERIC_WRECK)) for (const n of list) assert.ok(all.includes(n), n);
    assert.strictEqual(VENDOR_UNRESOLVED.size, 14);
    for (const n of VENDOR_UNRESOLVED) assert.ok(!all.includes(n), n);
  });

  needsDriver("SA2 claim: once per field (second pass, restart), pool taken (no NPC salvage) "
    + "SITES_FULL -> nothing written", () => {
    withStore(driver, (store) => {
      const h = harness(store);
      const f = h.addField("wf:test:1", SYS);
      const pool = effectivePool(h.field(f.fieldId), T0);
      const first = h.pass(T0);
      assert.strictEqual(first.claimed, 1);
      const a = h.anomaly(f.fieldId);
      assert.strictEqual(a.state, STATE.SITE_PENDING);
      assert.strictEqual(a.anomalyId, anomalyRepo.anomalyIdOf(f.fieldId));
      assert.ok(a.anomalyId.length <= 64);
      assert.deepStrictEqual([a.haulSalvage, a.haulLoot], [pool.salvage, pool.loot]);
      assert.strictEqual(a.wrecksPlanned, a.plan.length);
      assert.strictEqual(a.expiresAt, f.expiresAt);
      const sites = h.siteRows(a.anomalyId);
      assert.deepStrictEqual(sites.map((s) => [s.slot, s.state, s.templateId, s.systemId]),
        [[0, "CREATING", "client-dungeon:4088", SYS]]);
      const field = h.field(f.fieldId);
      assert.strictEqual(field.materializedAt, T0);
      assert.deepStrictEqual([field.salvagedSalvageUnits, field.salvagedLootUnits], [12, 10]);
      assert.strictEqual(effectivePool(field, T0 + 1).total, 0, "the salvager sees an empty pool");
      assert.deepStrictEqual(h.journalKeys("salv:"), [`salv:${f.fieldId}:claim`, `salv:${f.fieldId}:take`]);

      assert.strictEqual(h.pass(T0 + 1000).claimed, 0);
      h.restart();
      assert.strictEqual(h.pass(T0 + 2000).claimed, 0);
      assert.strictEqual(h.count(), 1);
      assert.strictEqual(h.allSites().length, 1);
      assert.strictEqual(h.telemetry.counters["salvageAnomaly.claimed"], 1);
    });

    withStore(driver, (store) => {
      const h = harness(store, { env: { EVEJS_LNE_SITES_MAX_ACTIVE_SITES: "1" } });
      h.tx((db) => h.sites.createSiteInTx(db, { eventId: "other", slot: 0, systemId: SYS2, templateId: "tpl",
        label: "Other", factionId: null, expiresAt: T0 + HOUR }));
      const f = h.addField("wf:test:full", SYS);
      assert.strictEqual(h.pass(T0).claimed, 0);
      assert.strictEqual(h.telemetry.counters["salvageAnomaly.refused.SITES_FULL"], 1);
      assert.strictEqual(h.count(), 0, "no anomaly row");
      const field = h.field(f.fieldId);
      assert.deepStrictEqual([field.materializedAt, field.salvagedSalvageUnits, field.salvagedLootUnits, field.version],
        [null, 0, 0, 1], "field untouched");
      assert.deepStrictEqual(h.allSites().map((s) => s.event_id), ["other"], "no site row");
      assert.deepStrictEqual(h.journalKeys("salv:"), [], "no journal row");
    });
  });

  needsDriver("SA3 presence unavailable / stale -> no claim (presenceUnsafe), a PLACING anomaly goes on", () => {
    withStore(driver, (store) => {
      const h = harness(store, { env: { EVEJS_LNE_SALVAGE_ANOMALY_MAX_LOOT_ROLLS_PER_WRECK: "0" } });
      const f = h.addField("wf:test:p1", SYS);
      h.presence.status = { available: false, reason: "UNAVAILABLE" };
      assert.deepStrictEqual([h.pass(T0).claimed, h.pass(T0).presence], [0, "unsafe"]);
      h.presence.status = { available: true, stale: true, staleReason: "READ_FAILED" };
      assert.strictEqual(h.pass(T0 + 1).claimed, 0);
      assert.strictEqual(h.count(), 0);
      assert.strictEqual(h.telemetry.counters["salvageAnomaly.presenceUnsafe"], 3);
      assert.strictEqual(h.field(f.fieldId).materializedAt, null);

      h.presence.status = { available: true, stale: false };
      assert.strictEqual(h.pass(T0 + 2).claimed, 1);
      h.sitesPass(T0 + 3);
      h.pass(T0 + 20000);
      assert.strictEqual(h.anomaly(f.fieldId).state, STATE.PLACING);
      h.presence.status = { available: false, reason: "UNAVAILABLE" };
      h.pass(T0 + 20001);
      assert.ok(h.vendor.wrecks.size > 0, "wrecks placed without presence");
      assert.ok(h.anomaly(f.fieldId).wrecksPlaced > 0);
      assert.strictEqual(h.telemetry.counters["salvageAnomaly.presenceUnsafe"], 4);
    });
  });

  needsDriver("SA4 pump: SITE_PENDING -> PLACING in the write budget, restart adopts a written wreck "
    + "PLACED -> ENDED(CLEARED) + site cleanup; expired field -> ENDING(FIELD_GONE) removes the wrecks",
  () => {
    const env = { EVEJS_LNE_SALVAGE_ANOMALY_MAX_LOOT_ROLLS_PER_WRECK: "0",
      EVEJS_LNE_SALVAGE_ANOMALY_MAX_WRECK_WRITES_PER_PASS: "4" };
    withStore(driver, (store) => {
      const h = harness(store, { env });
      const f = h.addField("wf:test:c1", SYS);
      h.pass(T0);
      const a0 = h.anomaly(f.fieldId);
      assert.strictEqual(a0.wrecksPlanned, 6);
      h.pass(T0 + 1);
      assert.strictEqual(h.anomaly(f.fieldId).state, STATE.SITE_PENDING, "site still CREATING");
      h.sitesPass(T0 + 2);
      assert.strictEqual(h.siteRows(a0.anomalyId)[0].state, "ACTIVE");
      h.pass(T0 + 20000);
      assert.strictEqual(h.anomaly(f.fieldId).state, STATE.PLACING);
      const p1 = h.pass(T0 + 30000);
      assert.deepStrictEqual([p1.wreckOps, p1.vendorWrites], [4, 4], "budget maxWreckWritesPerPass (no loot)");
      let a = h.anomaly(f.fieldId);
      assert.deepStrictEqual([a.state, a.wrecksPlaced, h.vendor.wrecks.size], [STATE.PLACING, 4, 4]);

      const siteKey = h.siteRows(a.anomalyId)[0].siteKey;
      const wreck4 = { slot: a.plan[4][0], shipTypeId: a.plan[4][1], hullGroup: a.plan[4][2], factionId: a.plan[4][3],
        lootRolls: a.plan[4][4], offset: { x: a.plan[4][5], y: a.plan[4][6], z: a.plan[4][7] } };
      const orphan = h.vendor.facade.place(placeSpecOf(a, wreck4, { siteKey, nowMs: T0 + 30001,
        lootTableFor: () => null }));
      assert.strictEqual(orphan.adopted, false);
      h.restart();
      h.pass(T0 + 40000);
      a = h.anomaly(f.fieldId);
      assert.deepStrictEqual([a.state, a.wrecksPlaced, a.wrecksRemaining, h.vendor.wrecks.size],
        [STATE.PLACED, 6, 6, 6], "no second wreck for slot 4");
      assert.ok(a.placed.some((p) => p[0] === 4 && p[1] === orphan.wreckId));
      assert.strictEqual(h.telemetry.counters["salvageAnomaly.wrecksAdopted"], 1);
      assert.strictEqual(h.telemetry.counters["salvageAnomaly.wrecksPlaced"], 5);

      const ids = [...h.vendor.wrecks.keys()];
      for (const id of ids.slice(0, 2)) h.vendor.mods.store.removeNativeWreckCascade(id);
      h.pass(T0 + 40000 + 60000);
      a = h.anomaly(f.fieldId);
      assert.deepStrictEqual([a.state, a.wrecksRemaining], [STATE.PLACED, 4]);
      for (const id of ids.slice(2)) h.vendor.mods.store.removeNativeWreckCascade(id);
      h.pass(T0 + 40000 + 120000);
      a = h.anomaly(f.fieldId);
      assert.deepStrictEqual([a.state, a.endReason, a.endedAt], [STATE.ENDED, "CLEARED", T0 + 40000 + 120000]);
      assert.strictEqual(h.siteRows(a.anomalyId)[0].state, "CLEANING");
      assert.deepStrictEqual([h.telemetry.counters["salvageAnomaly.wrecksCollected"],
        h.telemetry.counters["salvageAnomaly.ended.CLEARED"]], [6, 1]);
      h.pass(T0 + 40000 + 180000);
      assert.strictEqual(h.anomaly(f.fieldId).state, STATE.ENDED, "ENDED is final");
    });

    withStore(driver, (store) => {
      const h = harness(store, { env });
      const f = h.addField("wf:test:gone", SYS2, { expiresAt: T0 + HOUR });
      h.pass(T0);
      h.sitesPass(T0 + 1);
      h.pass(T0 + 20000);
      h.pass(T0 + 20001);
      h.pass(T0 + 20002);
      assert.strictEqual(h.anomaly(f.fieldId).state, STATE.PLACED);
      assert.strictEqual(h.vendor.wrecks.size, 6);
      h.pass(T0 + HOUR);
      assert.deepStrictEqual([h.anomaly(f.fieldId).state, h.anomaly(f.fieldId).endReason],
        [STATE.ENDING, "FIELD_GONE"]);
      h.pass(T0 + HOUR + 1);
      assert.strictEqual(h.vendor.wrecks.size, 2, "4 removals per pass (budget)");
      h.pass(T0 + HOUR + 2);
      assert.strictEqual(h.vendor.wrecks.size, 0);
      h.pass(T0 + HOUR + 3);
      assert.strictEqual(h.anomaly(f.fieldId).state, STATE.ENDED);
      assert.deepStrictEqual([h.telemetry.counters["salvageAnomaly.wrecksRemoved"],
        h.telemetry.counters["salvageAnomaly.ended.FIELD_GONE"]], [6, 1]);
      assert.strictEqual(h.siteRows(h.anomaly(f.fieldId).anomalyId)[0].state, "CLEANING");
    });
  });

  needsDriver("SA4b: with loot one pass places maxWreckWritesPerPass wrecks "
    + "(place = 1 operation, loot item writes not counted)", () => {
    const env = { EVEJS_LNE_SALVAGE_ANOMALY_MAX_WRECK_WRITES_PER_PASS: "4" };
    withStore(driver, (store) => {
      const h = harness(store, { env });
      const f = h.addField("wf:test:loot", SYS, { lootUnits: 40 });
      h.pass(T0);
      h.sitesPass(T0 + 1);
      h.pass(T0 + 20000);
      const a0 = h.anomaly(f.fieldId);
      assert.strictEqual(a0.state, STATE.PLACING);
      assert.ok(a0.plan.some((r) => r[4] > 0), "plan has loot rolls");
      const p1 = h.pass(T0 + 30000);
      const a = h.anomaly(f.fieldId);
      assert.deepStrictEqual([a.wrecksPlaced, h.vendor.wrecks.size, p1.wreckOps], [4, 4, 4], "4 wrecks in one pass");
      assert.ok(h.vendor.items.size > 0, "loot written");
      assert.ok(p1.vendorWrites > 4, `vendor writes reported (${p1.vendorWrites})`);
      h.pass(T0 + 30001);
      assert.deepStrictEqual([h.anomaly(f.fieldId).state, h.vendor.wrecks.size], [STATE.PLACED, 6]);
    });
  });

  needsDriver("SA6: a permanent claim refusal does not block the system (logged once per field) "
    + "PLACING -> ENDING(FIELD_GONE) keeps the placed wrecks in wrecksRemaining", () => {
    withStore(driver, (store) => {
      const h = harness(store, { env: { EVEJS_LNE_SALVAGE_ANOMALY_MAX_FIELDS_PER_ANOMALY: "1" } });
      const refused = h.addField("wf:test:refA", SYS, { expiresAt: T0 + HOUR });
      const next = h.addField("wf:test:okB", SYS, { expiresAt: T0 + 2 * HOUR });
      h.tx((db) => h.sites.createSiteInTx(db, { eventId: anomalyRepo.anomalyIdOf(refused.fieldId), slot: 0,
        systemId: SYS2, templateId: "tpl", label: "Other", factionId: null, expiresAt: T0 + HOUR }));
      const logged = () => h.logger.lines.filter((l) => l.includes(`claim of ${refused.fieldId} refused`)).length;
      assert.strictEqual(h.pass(T0).claimed, 0);
      assert.strictEqual(logged(), 1);
      assert.strictEqual(h.pass(T0 + 10000).claimed, 1, "the next field of the system is claimed");
      assert.strictEqual(h.anomaly(next.fieldId).state, STATE.SITE_PENDING);
      assert.strictEqual(h.anomaly(refused.fieldId), null);
      h.pass(T0 + 20000);
      assert.deepStrictEqual([logged(), h.telemetry.counters["salvageAnomaly.refused.OTHER"]], [1, 1], "log once");
    });

    withStore(driver, (store) => {
      const h = harness(store, { env: { EVEJS_LNE_SALVAGE_ANOMALY_MAX_LOOT_ROLLS_PER_WRECK: "0",
        EVEJS_LNE_SALVAGE_ANOMALY_MAX_WRECK_WRITES_PER_PASS: "4" } });
      const f = h.addField("wf:test:low1", SYS, { expiresAt: T0 + HOUR });
      h.pass(T0);
      h.sitesPass(T0 + 1);
      h.pass(T0 + 20000);
      h.pass(T0 + 20001);
      assert.deepStrictEqual([h.anomaly(f.fieldId).state, h.anomaly(f.fieldId).wrecksPlaced], [STATE.PLACING, 4]);
      h.pass(T0 + HOUR);
      const a = h.anomaly(f.fieldId);
      assert.deepStrictEqual([a.state, a.endReason, a.wrecksRemaining], [STATE.ENDING, "FIELD_GONE", 4]);
    });
  });

  needsDriver("SA5 registry: config keys, start refusals, facade = stub methods, TABLE_POLICY, migration 32 "
    + "metrics", () => {
    const rows = SCHEMA.filter((r) => r.key.startsWith("salvageAnomaly."));
    assert.strictEqual(rows.length, 26, "7 keys; one-anomaly-per-system: +1 "
      + "1");
    assert.ok(rows.every((r) => !r.launcher), "internal keys");
    const example = fs.readFileSync(path.join(MOD_DIR, ".env.example"), "utf8");
    assert.deepStrictEqual(rows.filter((r) => !example.includes(`${r.env}=`)).map((r) => r.env), []);
    const defaults = configOf().salvageAnomaly;
    assert.deepStrictEqual([defaults.enabled, defaults.templateId, defaults.maxActiveAnomalies, defaults.maxPerSystem,
      defaults.maxWreckWritesPerPass, defaults.fallbackLootTableId],
    [true, "client-dungeon:4088", 8, 2, 4, "generic_random_any"]);
    const clamped = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_SALVAGE_ANOMALY_MAX_ACTIVE_ANOMALIES: "1001",
      EVEJS_LNE_SITES_MAX_ACTIVE_SITES: "16" } });
    assert.strictEqual(clamped.config.salvageAnomaly.maxActiveAnomalies, 1000);
    assert.ok(clamped.warnings.some((w) => w.startsWith("salvageAnomaly.maxActiveAnomalies=1000 above")));

    assert.deepStrictEqual([MIGRATIONS[31].version, MIGRATIONS[31].name], [32, TABLE_NAME]);
    assert.strictEqual(TABLE_POLICY[TABLE_NAME], "WIPE");

    assert.ok(MODULE_CHANNELS.includes("salvageAnomaly"));
    for (const name of [...COUNTER_NAMES, "passMs", "vendorScanMs", "claimMs"]) {
      assert.ok(isMetricName(`salvageAnomaly.${name}`), name);
    }

    withStore(driver, (store, opened) => {
      assert.ok(store.transaction("t", (db) => db.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(TABLE_NAME)).value);
      const h = harness(store);
      const timers = [];
      const persistence = { ok: true, store, journal: h.journal, worldSeed: opened.worldSeed };
      let listeners = 0;
      const presence = { getStatus: () => ({ available: true }), observedSystems: () => [],
        onSystemObserved: () => { listeners += 1; return { ok: true, unsubscribe: () => { listeners -= 1; } }; } };
      const deps = (over = {}) => ({ config: configOf(), persistence, clock: h.clock, adapter: h.adapter,
        logger: h.logger, getPresence: () => presence, getSites: () => h.sites,
        getWrecks: () => ({ repository: h.wreckRepo }),
        setTimer: (fn, ms) => { timers.push(ms); return { cancel() {}, hasRef: () => false }; }, ...over });

      assert.strictEqual(startSalvageAnomaly(deps({ config: resolveConfig({ modDir: MOD_DIR, env: {} }).config }))
        .reason, "disabled_by_config", "modules.sites off");
      assert.strictEqual(startSalvageAnomaly(deps({ config: configOf({ EVEJS_LNE_SALVAGE_ANOMALY_ENABLED: "false" }) }))
        .reason, "disabled_by_config");
      assert.strictEqual(startSalvageAnomaly(deps({ getSites: () => null })).reason, "dependency_disabled:sites");
      assert.strictEqual(startSalvageAnomaly(deps({ adapter: { ...h.adapter,
        checkNativeWrecks: () => ({ ok: false, reason: "SEAM_UNAVAILABLE", detail: "x" }) } })).reason,
      "SEAM_UNAVAILABLE");
      const missingTemplate = configOf({ EVEJS_LNE_SALVAGE_ANOMALY_TEMPLATE_ID: "missing" });
      assert.strictEqual(startSalvageAnomaly(deps({ config: missingTemplate })).reason, "TEMPLATE_MISSING");

      const started = startSalvageAnomaly(deps());
      assert.strictEqual(started.ok, true, JSON.stringify(started));
      const facade = started.salvageAnomaly;
      const stub = unavailableSalvageAnomaly("SALVAGE_ANOMALY_DISABLED");
      assert.deepStrictEqual(Object.keys(facade).sort(), ["getStatus", "listBoardRows", "runPass", "stop"]);
      assert.deepStrictEqual(Object.keys(stub).sort(), Object.keys(facade).sort());
      assert.strictEqual(stub.runPass(T0).reason, "SALVAGE_ANOMALY_DISABLED");
      assert.deepStrictEqual([facade.getStatus().state, facade.getStatus().listening, listeners, timers],
        ["running", true, 1, [10000]]);
      const MISSING_PREFIX = "salvageAnomaly: fallback wreck names missing in EveJS: ";
      assert.ok(!h.logger.lines.some((l) => l.startsWith(MISSING_PREFIX)), h.logger.lines.join("\n"));
      assert.ok(h.logger.lines.some((l) => l.includes("loot tables missing") && l.includes("loot_sleeper_blue_small")));
      assert.strictEqual(facade.runPass(T0).ok, true);
      facade.stop();
      assert.deepStrictEqual([facade.getStatus().state, listeners], ["stopped", 0]);
      const noGeneric = { ...h.adapter, getNativeWrecks: () => ({ ...h.vendor.facade,
        checkWreckNames: (names) => ({ ok: true, missing: names.filter((n) => n === "Wreck") }) }) };
      const second = startSalvageAnomaly(deps({ adapter: noGeneric }));
      assert.strictEqual(second.ok, true, JSON.stringify(second));
      assert.deepStrictEqual(h.logger.lines.filter((l) => l.startsWith(MISSING_PREFIX)), [`${MISSING_PREFIX}Wreck`]);
      second.salvageAnomaly.stop();
      assert.strictEqual(listeners, 0);
    });
  });

  function placedAnomaly(h, fieldId, systemId, extra = {}, afterClaim = null) {
    const f = h.addField(fieldId, systemId, extra);
    h.pass(T0);
    if (afterClaim) afterClaim();
    h.sitesPass(T0 + 1);
    h.pass(T0 + 20000);
    h.pass(T0 + 20001);
    const a = h.anomaly(f.fieldId);
    assert.strictEqual(a.state, STATE.PLACED);
    return a;
  }
  const FAST = { EVEJS_LNE_SALVAGE_ANOMALY_MAX_LOOT_ROLLS_PER_WRECK: "0",
    EVEJS_LNE_SALVAGE_ANOMALY_MAX_WRECK_WRITES_PER_PASS: "16" };

  needsDriver("SA7: observed PLACED -> next_at + trackObservedIntervalMs and "
    + "observedLive; 0 wrecks -> ENDED(CLEARED) + site CLEANING in one pass, nudge; respawnDelayMs blocks the system; "
    + "not observed -> trackIntervalMs", () => {
    withStore(driver, (store) => {
      const h = harness(store, { env: FAST });
      const a = placedAnomaly(h, "wf:test:fast", SYS);
      assert.strictEqual(a.nextAt, T0 + 20001 + 3000, "observed system: trackObservedIntervalMs");
      const r = h.pass(T0 + 23001);
      assert.strictEqual(r.observedLive, 1, "PLACED row of an observed system");
      assert.strictEqual(h.anomaly(a.fieldId).nextAt, T0 + 23001 + 3000);
      for (const id of [...h.vendor.wrecks.keys()]) h.vendor.mods.store.removeNativeWreckCascade(id);
      const nudgesBefore = h.nudges.n;
      h.pass(T0 + 26001);
      const ended = h.anomaly(a.fieldId);
      assert.deepStrictEqual([ended.state, ended.endReason, ended.endedAt], [STATE.ENDED, "CLEARED", T0 + 26001]);
      assert.strictEqual(h.siteRows(ended.anomalyId)[0].state, "CLEANING");
      assert.strictEqual(h.nudges.n, nudgesBefore + 1);
      assert.strictEqual(h.telemetry.counters["salvageAnomaly.ended.CLEARED"], 1);
      h.addField("wf:test:fast2", SYS);
      assert.strictEqual(h.pass(T0 + 40000).claimed, 0, "respawn delay");
      assert.strictEqual(h.pass(T0 + 26001 + 300000).claimed, 1);
    });
    withStore(driver, (store) => {
      const h = harness(store, { env: FAST });
      const a = placedAnomaly(h, "wf:test:far", SYS2, {}, () => { h.presence.systems = [SYS]; });
      assert.strictEqual(a.nextAt, T0 + 20001 + 60000, "not observed: trackIntervalMs");
      assert.strictEqual(h.pass(T0 + 20002).observedLive, 0);
    });
  });

  needsDriver("SA8: LOOTED = every wreck empty + a visit + no player for lootedGraceMs "
    + "-> ENDING(LOOTED), next_at + ttl, site cleanup; without a visit (restart) nothing; a full wreck nothing; "
    + "default grace 300 s", () => {
    const GRACE = 300000;
    assert.strictEqual(configOf().salvageAnomaly.lootedGraceMs, GRACE, "Default");
    withStore(driver, (store) => {
      const h = harness(store, { env: FAST });
      const a = placedAnomaly(h, "wf:test:loot", SYS);
      const center = h.siteRows(a.anomalyId)[0].position;
      assert.ok(center, "site position for the grid");
      const empty = new Map([...h.vendor.wrecks.keys()].map((id) => [id, true]));
      const dynamic = new Map();
      h.vendor.mods.runtime.scenes.set(SYS, { dynamicEntities: dynamic,
        getEntityByID: (id) => (empty.has(id) ? { itemID: id, isEmpty: empty.get(id) } : null) });
      const player = { kind: "ship", charID: 90000001, position: { x: center.x + 1000, y: center.y, z: center.z } };
      let t = T0 + 30000;
      const step = (ms = 3000) => {
        t += ms;
        return h.pass(t);
      };
      step();
      step(GRACE + 10000);
      assert.strictEqual(h.anomaly(a.fieldId).state, STATE.PLACED, "no visit -> no LOOTED");
      dynamic.set(1, player);
      step();
      h.restart();
      dynamic.delete(1);
      step();
      step(GRACE + 10000);
      assert.strictEqual(h.anomaly(a.fieldId).state, STATE.PLACED, "restart: a new visit is needed");
      dynamic.set(1, player);
      step();
      dynamic.delete(1);
      const firstId = [...empty.keys()][0];
      empty.set(firstId, false);
      step();
      step(GRACE + 10000);
      assert.strictEqual(h.anomaly(a.fieldId).state, STATE.PLACED, "a wreck with loot -> no LOOTED");
      empty.set(firstId, true);
      step();
      const since = t;
      step(27000);
      assert.strictEqual(h.anomaly(a.fieldId).state, STATE.PLACED, "30 s away: the anomaly stays");
      step(GRACE - 30001);
      assert.strictEqual(h.anomaly(a.fieldId).state, STATE.PLACED, "grace not over");
      const nudgesBefore = h.nudges.n;
      step(3001);
      assert.strictEqual(t - since, GRACE);
      const looted = h.anomaly(a.fieldId);
      assert.deepStrictEqual([looted.state, looted.endReason, looted.nextAt, looted.wrecksRemaining],
        [STATE.ENDING, "LOOTED", t + 600000, 6]);
      assert.strictEqual(h.siteRows(a.anomalyId)[0].state, "CLEANING", "scanner entry goes now");
      assert.strictEqual(h.nudges.n, nudgesBefore + 1);
      assert.ok(h.telemetry.counters["salvageAnomaly.gridReads"] > 0);
      h.vendor.mods.runtime.scenes.delete(SYS);
      h.pass(t + 600000);
      assert.strictEqual(h.vendor.wrecks.size, 0);
      h.pass(t + 600001);
      assert.strictEqual(h.anomaly(a.fieldId).state, STATE.ENDED);
      assert.strictEqual(h.telemetry.counters["salvageAnomaly.ended.LOOTED"], 1);
    });
  });

  function officerRig(store, opts) {
    const h = harness(store, { env: FAST, ...opts });
    const a = placedAnomaly(h, "wf:test:officer", SYS);
    const center = h.siteRows(a.anomalyId)[0].position;
    const dynamic = new Map();
    const ids = new Set(h.vendor.wrecks.keys());
    h.vendor.mods.runtime.scenes.set(SYS, { dynamicEntities: dynamic,
      getEntityByID: (id) => (ids.has(id) ? { itemID: id, isEmpty: true } : null) });
    const player = { kind: "ship", charID: 90000001, position: { x: center.x + 1000, y: center.y, z: center.z } };
    let t = T0 + 30000;
    const step = (ms, onGrid) => {
      if (onGrid) dynamic.set(1, player);
      else dynamic.delete(1);
      t += ms;
      return h.pass(t);
    };
    return { h, a, step };
  }

  function fakeOfficers(result) {
    return { calls: [], trySalvage(i) { this.calls.push(i); return typeof result === "function" ? result() : result; } };
  }

  test("OFS2a dominantFactionOfWrecks: most wrecks wins, tie -> smaller id, nothing -> null", () => {
    const { dominantFactionOfWrecks } = require("../../lib/events/salvage/plan");
    assert.strictEqual(dominantFactionOfWrecks([{ factionId: 7 }, { factionId: 5 }, { factionId: 7 }]), 7);
    assert.strictEqual(dominantFactionOfWrecks([{ factionId: 9 }, { factionId: 5 }]), 5);
    assert.strictEqual(dominantFactionOfWrecks([]), null);
    assert.strictEqual(dominantFactionOfWrecks([{ factionId: 0 }, null]), null);
  });

  needsDriver("OFS2: first visit to a PLACED anomaly -> trySalvage once (dominant wreck faction) "
    + "later passes with the player -> none; officerSpawned / officerRefused in the status", () => {
    withStore(driver, (store) => {
      const officers = fakeOfficers({ ok: true, spawned: true, entityIds: [1] });
      const { h, a, step } = officerRig(store, { getOfficerSpawns: () => officers });
      step(3000, false);
      assert.deepStrictEqual(officers.calls, [], "nobody on the grid");
      step(3000, true);
      assert.deepStrictEqual(officers.calls, [{ anomalyId: a.anomalyId, systemId: SYS, characterId: 90000001,
        factionId: 500010 }]);
      step(3000, true);
      step(3000, false);
      step(3000, true);
      assert.strictEqual(officers.calls.length, 1, "one roll per anomaly per process");
      assert.deepStrictEqual(h.svc.getPassStatus().officer, { spawned: 1, refused: 0 });
      assert.strictEqual(h.telemetry.counters["salvageAnomaly.officerSpawned"], 1);
    });
    withStore(driver, (store) => {
      const results = [{ ok: false, reason: "CHANCE_MISS" }];
      const officers = fakeOfficers(() => results.shift());
      const { h, step } = officerRig(store, { getOfficerSpawns: () => officers });
      step(3000, true);
      assert.deepStrictEqual(h.svc.getPassStatus().officer, { spawned: 0, refused: 0 }, "CHANCE_MISS is quiet");
      h.restart();
      results.push({ ok: false, reason: "DUPLICATE" });
      step(3000, true);
      assert.strictEqual(officers.calls.length, 2, "restart: a new first visit (answers DUPLICATE)");
      assert.deepStrictEqual(h.svc.getPassStatus().officer, { spawned: 0, refused: 1 });
      assert.strictEqual(h.telemetry.counters["salvageAnomaly.officerRefused"], 1);
    });
    const { createUnavailableOfficerSpawns } = require("../../lib/officers");
    for (const [why, refused] of [["OFFICER_SPAWNS_DISABLED", 0], ["stopped", 0], ["OFFICER_SPAWNS_UNAVAILABLE", 1]]) {
      withStore(driver, (store) => {
        const { h, step } = officerRig(store, { getOfficerSpawns: () => createUnavailableOfficerSpawns(why) });
        step(3000, true);
        assert.deepStrictEqual(h.svc.getPassStatus().officer, { spawned: 0, refused }, why);
        assert.strictEqual(h.telemetry.counters["salvageAnomaly.officerRefused"] || 0, refused, why);
      });
    }
  });

  needsDriver("OFS3: getOfficerSpawns absent / null / throws / trySalvage throws -> the "
    + "endWhenLooted path gives the same row and counters; playerCharacterId null -> no call", () => {
    const GRACE = configOf().salvageAnomaly.lootedGraceMs;
    const run = (opts) => withStore(driver, (store) => {
      const { h, a, step } = officerRig(store, opts);
      step(3000, false);
      step(3000, true);
      step(3000, false);
      step(GRACE + 3000, false);
      const counters = Object.fromEntries(Object.entries(h.telemetry.counters)
        .filter(([k]) => !k.startsWith("salvageAnomaly.officer")));
      return { row: h.anomaly(a.fieldId), counters };
    });
    const before = run({});
    assert.strictEqual(before.row.endReason, "LOOTED", "the baseline ends LOOTED");
    const throwing = () => { throw new Error("boom"); };
    for (const [label, opts] of [["null", { getOfficerSpawns: () => null }], ["throws", { getOfficerSpawns: throwing }],
      ["trySalvage throws", { getOfficerSpawns: () => ({ trySalvage: throwing }) }],
      ["refused", { getOfficerSpawns: () => fakeOfficers({ ok: false, reason: "NO_SHIP" }) }]]) {
      assert.deepStrictEqual(run(opts), before, label);
    }
    withStore(driver, (store) => {
      const officers = fakeOfficers({ ok: true, spawned: true, entityIds: [] });
      const { h, step } = officerRig(store, { getOfficerSpawns: () => officers });
      const readGrid = h.vendor.facade.readGrid;
      h.vendor.facade.readGrid = (...args) => ({ ...readGrid(...args), playerCharacterId: null });
      const r = step(3000, true);
      assert.ok(r.ok);
      assert.deepStrictEqual(officers.calls, [], "playerOnGrid without a pilot id -> no roll");
    });
  });

  needsDriver("SA9: 3 fields, maxFieldsPerAnomaly 2 -> 1 anomaly of the 2 oldest, primary = later "
    + "expiresAt, both materialized, the 3rd still a candidate; mergedFieldIds in the journal; a repeated pass "
    + "changes nothing", () => {
    withStore(driver, (store) => {
      const h = harness(store, { env: { EVEJS_LNE_SALVAGE_ANOMALY_MAX_FIELDS_PER_ANOMALY: "2",
        EVEJS_LNE_SALVAGE_ANOMALY_MAX_PER_SYSTEM: "1" } });
      const f1 = h.addField("wf:test:m1", SYS, { expiresAt: T0 + HOUR });
      const f2 = h.addField("wf:test:m2", SYS, { expiresAt: T0 + 2 * HOUR, shipsLost: 2,
        composition: [[500020, "battleship", 640, 2]], salvageUnits: 24, lootUnits: 16 });
      const f3 = h.addField("wf:test:m3", SYS, { expiresAt: T0 + 3 * HOUR });
      const pools = [f1, f2].map((f) => effectivePool(h.field(f.fieldId), T0));
      assert.strictEqual(h.pass(T0).claimed, 1);
      assert.strictEqual(h.count(), 1);
      const a = h.anomaly(f2.fieldId);
      assert.ok(a, "primary = the later expiresAt");
      assert.strictEqual(h.anomaly(f1.fieldId), null);
      assert.deepStrictEqual([a.anomalyId, a.expiresAt, a.haulSalvage, a.haulLoot],
        [anomalyRepo.anomalyIdOf(f2.fieldId), f2.expiresAt, pools[0].salvage + pools[1].salvage,
          pools[0].loot + pools[1].loot]);
      assert.ok(a.plan.some((r) => r[2] === "battleship") && a.plan.some((r) => r[2] === "cruiser"), "merged hulls");
      assert.deepStrictEqual([f1, f2, f3].map((f) => h.field(f.fieldId).materializedAt), [T0, T0, null]);
      assert.deepStrictEqual(h.journalKeys("salv:"), [`salv:${f1.fieldId}:take`, `salv:${f2.fieldId}:claim`,
        `salv:${f2.fieldId}:take`]);
      const payload = h.tx((db) => db.prepare("SELECT payload FROM world_event_journal WHERE idempotency_key = ?")
        .get(`salv:${f2.fieldId}:claim`).payload);
      assert.deepStrictEqual(JSON.parse(payload).mergedFieldIds, [f1.fieldId]);
      assert.strictEqual(h.telemetry.counters["salvageAnomaly.mergedFields"], 1);
      h.pass(T0 + 10000);
      h.restart();
      h.pass(T0 + 20000);
      assert.strictEqual(h.count(), 1);
      assert.strictEqual(h.field(f3.fieldId).materializedAt, null);
      const listed = h.tx((db) => h.wreckRepo.listUnmaterializedInSystem(db, { systemId: SYS, at: T0, limit: 8 }));
      assert.deepStrictEqual(listed.fields.map((f) => f.fieldId), [f3.fieldId], "the 3rd is still a candidate");
    });
  });

  test("SA10: maxWrecksPerAnomaly 1200 -> PLAN_ROWS_CAP rows, plan_json within 8192; config "
    + "warning", () => {
    const { PLAN_ROWS_CAP, MAX_JSON_LENGTH } = require("../../lib/events/salvage/schema");
    const { stableJson } = require("../../lib/util/fingerprint");
    assert.strictEqual(PLAN_ROWS_CAP, 102);
    const field = { composition: [[500010, "jump_freighter", 9999999, 1500]], shipsLost: 1500, salvageUnits: 1500,
      lootUnits: 1500 };
    const plan = planAnomaly(field, { salvage: 1500, loot: 1500 }, { maxWrecksPerAnomaly: 1200, lootUnitsPerRoll: 1,
      maxLootRollsPerWreck: 10, wreckSpreadM: 100000 }, 99);
    assert.ok(plan.ok, JSON.stringify(plan));
    assert.strictEqual(plan.rows.length, PLAN_ROWS_CAP);
    assert.ok(stableJson(plan.rows).length <= MAX_JSON_LENGTH, String(stableJson(plan.rows).length));
    const r = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_SALVAGE_ANOMALY_MAX_WRECKS_PER_ANOMALY: "1200" } });
    assert.ok(r.warnings.some((w) => w.startsWith("salvageAnomaly.maxWrecksPerAnomaly=1200 above 102")),
      r.warnings.join("; "));
  });

  const ALL_FIELDS = { EVEJS_LNE_SALVAGE_ANOMALY_MAX_FIELDS_PER_ANOMALY: "300" };
  function addFields(h, n, systemId, hulls = 1, prefix = "wf:one") {
    const out = [];
    for (let i = 0; i < n; i += 1) {
      out.push(h.addField(`${prefix}:${String(i).padStart(2, "0")}`, systemId, { expiresAt: T0 + HOUR + i * 1000,
        shipsLost: hulls, composition: [[500010, "cruiser", 17715, hulls]], salvageUnits: 4 * hulls,
        lootUnits: 3 * hulls }));
    }
    return out;
  }
  const claimPayload = (h, fieldId) => JSON.parse(h.tx((db) => db.prepare(
    "SELECT payload FROM world_event_journal WHERE idempotency_key = ?").get(`salv:${fieldId}:claim`).payload));
  const materialized = (h, fields) => fields.map((f) => h.field(f.fieldId).materializedAt);

  needsDriver("SA11 one anomaly per system: 20 fields, 0 anomalies -> 1 anomaly of all 20 "
    + "mergedFieldIds = 19, later passes and a restart make no second anomaly", () => {
    withStore(driver, (store) => {
      const h = harness(store, { env: { ...ALL_FIELDS, EVEJS_LNE_SALVAGE_ANOMALY_MAX_ROWS_PER_PASS: "8",
        EVEJS_LNE_SALVAGE_ANOMALY_MAX_WRECKS_PER_ANOMALY: "60" } });
      const fields = addFields(h, 20, SYS);
      const primary = fields[19];
      assert.strictEqual(h.pass(T0).claimed, 1);
      assert.strictEqual(h.count(), 1);
      assert.ok(h.anomaly(primary.fieldId), "primary = the latest expiresAt");
      assert.deepStrictEqual(materialized(h, fields), fields.map(() => T0));
      const keys = h.journalKeys("salv:");
      assert.deepStrictEqual([keys.length, keys.filter((k) => k.endsWith(":claim"))], [21,
        [`salv:${primary.fieldId}:claim`]]);
      assert.deepStrictEqual(claimPayload(h, primary.fieldId).mergedFieldIds,
        fields.slice(0, 19).map((f) => f.fieldId).sort());
      assert.strictEqual(h.telemetry.counters["salvageAnomaly.mergedFields"], 19);
      assert.strictEqual(h.telemetry.counters["salvageAnomaly.mergeCapped"], undefined);
      h.pass(T0 + 10000);
      h.restart();
      h.pass(T0 + 20000);
      assert.strictEqual(h.count(), 1);
      assert.deepStrictEqual(materialized(h, fields), fields.map(() => T0));
    });
  });

  needsDriver("SA12 one anomaly per system: plan wrecks <= min(maxWrecksPerAnomaly, PLAN_ROWS_CAP) "
    + "haul = sum of the effective pools of the taken fields, loot rolls capped", () => {
    const { PLAN_ROWS_CAP } = require("../../lib/events/salvage/schema");
    for (const [wrecks, cap] of [["1200", PLAN_ROWS_CAP], ["60", 60]]) {
      withStore(driver, (store) => {
        const h = harness(store, { env: { ...ALL_FIELDS, EVEJS_LNE_SALVAGE_ANOMALY_MAX_WRECKS_PER_ANOMALY: wrecks } });
        const fields = addFields(h, 20, SYS, 10);
        const pools = new Map(fields.map((f) => [f.fieldId, effectivePool(h.field(f.fieldId), T0)]));
        assert.strictEqual(h.pass(T0).claimed, 1);
        const taken = fields.filter((f) => h.field(f.fieldId).materializedAt === T0);
        const a = h.anomaly(taken[taken.length - 1].fieldId);
        assert.ok(a, `anomaly (${wrecks})`);
        assert.ok(a.plan.length >= 1 && a.plan.length <= cap, `${a.plan.length} <= ${cap}`);
        assert.strictEqual(a.haulSalvage, taken.reduce((n, f) => n + pools.get(f.fieldId).salvage, 0));
        assert.strictEqual(a.haulLoot, taken.reduce((n, f) => n + pools.get(f.fieldId).loot, 0));
        assert.ok(a.plan.every((r) => r[4] <= h.config.salvageAnomaly.maxLootRollsPerWreck), "loot rolls");
      });
    }
  });

  needsDriver("SA12b one anomaly per system: the merge stops once the hulls reach maxWrecksPerAnomaly "
    + "the first field is always taken", () => {
    const env = { ...ALL_FIELDS, EVEJS_LNE_SALVAGE_ANOMALY_MAX_WRECKS_PER_ANOMALY: "25",
      EVEJS_LNE_SALVAGE_ANOMALY_MAX_PER_SYSTEM: "1" };
    withStore(driver, (store) => {
      const h = harness(store, { env });
      const fields = addFields(h, 10, SYS, 10);
      const before = fields.map((f) => effectivePool(h.field(f.fieldId), T0));
      assert.strictEqual(h.pass(T0).claimed, 1);
      assert.deepStrictEqual(materialized(h, fields), [T0, T0, T0, null, null, null, null, null, null, null],
        "10 + 10 + 10 = 30 >= 25 after the 3rd field");
      assert.deepStrictEqual(fields.slice(3).map((f) => effectivePool(h.field(f.fieldId), T0)), before.slice(3));
      const a = h.anomaly(fields[2].fieldId);
      assert.ok(a.plan.length <= 25, String(a.plan.length));
      assert.deepStrictEqual(claimPayload(h, fields[2].fieldId).mergedFieldIds, [fields[0].fieldId, fields[1].fieldId]);
      assert.strictEqual(h.telemetry.counters["salvageAnomaly.mergeCapped"], 1);
    });
    withStore(driver, (store) => {
      const h = harness(store, { env });
      const big = h.addField("wf:one:big", SYS, { expiresAt: T0 + HOUR, shipsLost: 40,
        composition: [[500010, "cruiser", 17715, 40]], salvageUnits: 160, lootUnits: 120 });
      const small = addFields(h, 1, SYS, 10, "wf:one:small")[0];
      assert.strictEqual(h.pass(T0).claimed, 1);
      assert.deepStrictEqual(materialized(h, [big, small]), [T0, null], "40 hulls >= 25: one field");
      assert.strictEqual(claimPayload(h, big.fieldId).mergedFieldIds, undefined);
      assert.ok(h.anomaly(big.fieldId).plan.length <= 25);
    });
  });

  needsDriver("SA13 one anomaly per system (idempotency): a refused take of the 20th field rolls everything back; "
    + "a repeated claim after the commit makes no second anomaly and counts the pool once", () => {
    withStore(driver, (store) => {
      const h = harness(store, { env: { ...ALL_FIELDS, EVEJS_LNE_SALVAGE_ANOMALY_MAX_WRECKS_PER_ANOMALY: "60" } });
      const fields = addFields(h, 20, SYS);
      let takes = 0;
      h.repoWrap = (repo) => ({ ...repo, claimForAnomalyInTx: (...args) => {
        takes += 1;
        return takes === 20 ? { ok: false, reason: "VERSION_CONFLICT" } : repo.claimForAnomalyInTx(...args);
      } });
      assert.strictEqual(h.pass(T0).claimed, 0);
      assert.strictEqual(takes, 20);
      assert.deepStrictEqual([h.count(), h.journalKeys("salv:").length, h.allSites().length], [0, 0, 0]);
      assert.deepStrictEqual(materialized(h, fields), fields.map(() => null));
      h.repoWrap = null;
      h.restart();
      assert.strictEqual(h.pass(T0).claimed, 1);
      const a = h.anomaly(fields[19].fieldId);
      const keys = h.journalKeys("salv:");
      assert.strictEqual(keys.length, 21);
      h.restart();
      assert.strictEqual(h.pass(T0).claimed, 0);
      const again = h.anomaly(fields[19].fieldId);
      assert.deepStrictEqual([h.count(), again.haulSalvage, again.haulLoot, h.journalKeys("salv:")],
        [1, a.haulSalvage, a.haulLoot, keys]);
    });
  });

  needsDriver("SA14 one anomaly per system: maxFieldsPerAnomaly 5 of 8 fields -> the 5 oldest "
    + "mergeCapped; fieldCapOf", () => {
    const { fieldCapOf } = require("../../lib/events/salvage/schema");
    assert.deepStrictEqual([fieldCapOf(300, 1000), fieldCapOf(300, 9), fieldCapOf(5, undefined), fieldCapOf(300, 2)],
      [300, 3, 5, 1]);
    withStore(driver, (store) => {
      const h = harness(store, { env: { EVEJS_LNE_SALVAGE_ANOMALY_MAX_FIELDS_PER_ANOMALY: "5" } });
      const fields = addFields(h, 8, SYS);
      assert.strictEqual(h.pass(T0).claimed, 1);
      assert.deepStrictEqual(materialized(h, fields), [T0, T0, T0, T0, T0, null, null, null]);
      assert.ok(h.anomaly(fields[4].fieldId));
      assert.strictEqual(h.telemetry.counters["salvageAnomaly.mergeCapped"], 1);
    });
  });

  needsDriver("SA15 one anomaly per system: a field born during the anomaly does not join; maxPerSystem 1 -> "
    + "it waits for the end + respawnDelayMs; maxPerSystem 2 -> a second anomaly in the next claim window", () => {
    withStore(driver, (store) => {
      const h = harness(store, { env: { ...FAST, ...ALL_FIELDS, EVEJS_LNE_SALVAGE_ANOMALY_MAX_PER_SYSTEM: "1" } });
      const fields = addFields(h, 3, SYS);
      h.pass(T0);
      h.sitesPass(T0 + 1);
      h.pass(T0 + 20000);
      h.pass(T0 + 20001);
      const a = h.anomaly(fields[2].fieldId);
      assert.strictEqual(a.state, STATE.PLACED);
      assert.deepStrictEqual(materialized(h, fields), [T0, T0, T0]);
      const late = h.addField("wf:one:late", SYS);
      assert.strictEqual(h.pass(T0 + 30000).claimed, 0, "the system window is taken");
      assert.strictEqual(h.anomaly(late.fieldId), null);
      for (const id of [...h.vendor.wrecks.keys()]) h.vendor.mods.store.removeNativeWreckCascade(id);
      const endAt = h.anomaly(a.fieldId).nextAt;
      h.pass(endAt);
      assert.deepStrictEqual([h.anomaly(a.fieldId).state, h.anomaly(a.fieldId).endReason], [STATE.ENDED, "CLEARED"]);
      assert.strictEqual(h.pass(endAt + 10000).claimed, 0, "respawn delay");
      assert.strictEqual(h.pass(endAt + 300000).claimed, 1);
      assert.strictEqual(h.anomaly(late.fieldId).state, STATE.SITE_PENDING);
    });
    withStore(driver, (store) => {
      const h = harness(store, { env: { ...ALL_FIELDS } });
      const fields = addFields(h, 3, SYS);
      assert.strictEqual(h.pass(T0).claimed, 1);
      const late = h.addField("wf:one:late", SYS);
      assert.strictEqual(h.pass(T0 + 10000).claimed, 1);
      assert.ok(h.anomaly(late.fieldId), "second anomaly of the new field");
      assert.ok(h.anomaly(fields[2].fieldId));
      assert.strictEqual(h.count(), 2);
    });
  });

  needsDriver("SA16 one anomaly per system: config range, defaults, warnings "
    + "maxClaimFieldsPerPass ends the claims of a pass", () => {
    const resolve = (env) => resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_SITES_ENABLED: "1", ...env } });
    const fieldWarn = (r) => r.warnings.filter((w) => w.startsWith("salvageAnomaly.maxFieldsPerAnomaly="));
    assert.strictEqual(resolve({ EVEJS_LNE_SALVAGE_ANOMALY_MAX_FIELDS_PER_ANOMALY: "400" }).config.salvageAnomaly
      .maxFieldsPerAnomaly, 300);
    const defaults = resolve({});
    assert.deepStrictEqual([defaults.config.salvageAnomaly.maxFieldsPerAnomaly,
      defaults.config.salvageAnomaly.maxClaimFieldsPerPass, fieldWarn(defaults)], [8, 300, []]);
    assert.deepStrictEqual(fieldWarn(resolve({ EVEJS_LNE_SALVAGE_ANOMALY_MAX_FIELDS_PER_ANOMALY: "2" })),
      ["salvageAnomaly.maxFieldsPerAnomaly=2 below wrecks.maxFieldsPerSystem=3 - a system with more fields gives a "
        + "run of anomalies"]);
    assert.deepStrictEqual(fieldWarn(resolve({ EVEJS_LNE_SALVAGE_ANOMALY_MAX_FIELDS_PER_ANOMALY: "300",
      EVEJS_LNE_PERSISTENCE_MAX_ROWS_PER_TRANSACTION: "100" })),
    ["salvageAnomaly.maxFieldsPerAnomaly=300 above persistence.maxRowsPerTransaction=100 - claim clamped to 48 "
      + "fields"]);
    assert.deepStrictEqual(fieldWarn(resolve({ ...ALL_FIELDS, EVEJS_LNE_WRECKS_MAX_FIELDS_PER_SYSTEM: "300" })), [],
      "compose 300 / 300 / 1000 rows: no warning");
    withStore(driver, (store) => {
      const h = harness(store, { env: { EVEJS_LNE_SALVAGE_ANOMALY_MAX_NEW_PER_PASS: "4",
        EVEJS_LNE_SALVAGE_ANOMALY_MAX_CLAIM_FIELDS_PER_PASS: "3" } });
      addFields(h, 3, SYS, 1, "wf:one:a");
      addFields(h, 3, SYS2, 1, "wf:one:b");
      assert.strictEqual(h.pass(T0).claimed, 1, "3 fields taken -> no second claim in the pass");
      assert.strictEqual(h.pass(T0 + 10000).claimed, 1, "the other system in the next pass");
      assert.strictEqual(h.count(), 2);
    });
  });
};
