"use strict";

const assert = require("node:assert");
const { createRepository } = require("../../lib/virtualCorps/identityRepository");
const { upVirtualIdentities } = require("../../lib/virtualCorps/schema");
const { createReviewService } = require("../../lib/strategy/reviewService");
const { startStrategy } = require("../../lib/strategy");
const { buildFleetsView } = require("../../lib/fleets/fleetsView");
const { startVirtualCorps } = require("../../lib/virtualCorps");
const { resolveSqliteDriver } = require("../../lib/adapter/sqliteDriver");
const { findServerSrcOnDisk, GAMESTORE_SEARCH_MAX_DEPTH } = require("../../lib/adapter/locator");
const path = require("node:path");
const fs = require("node:fs");

const MOD_DIR = path.resolve(__dirname, "..", "..");

function loadSqliteDriver() {
  const found = findServerSrcOnDisk(MOD_DIR, GAMESTORE_SEARCH_MAX_DEPTH, fs.existsSync);
  if (!found.ok) return { ok: false, detail: found.reason };
  return resolveSqliteDriver(found.srcDir);
}

function createTestDb() {
  const driverResult = loadSqliteDriver();
  if (!driverResult.ok) {
    return { skipped: `better-sqlite3 not available: ${driverResult.detail}` };
  }
  const db = new driverResult.Database(":memory:");
  upVirtualIdentities(db);
  return { ok: true, db };
}

function createTestConfig() {
  return {
    modules: { virtualCorps: { enabled: true }, fleets: { enabled: true }, strategy: { enabled: true } },
    virtualCorps: { corpsPerFaction: 2, membersPerCorp: 3, maxCharacters: 64, fleetCorporations: true },
    fleets: {
      maxCompositionEntries: 10, maxShipsPerFleet: 50, maxFleetsPerOperation: 5,
      maxJsonBytes: 65536, maxListLimit: 100,
      travelTimeFactor: 1.0, refitMs: 300000, operationMaxOverdueRounds: 3, refitPolicy: "station"
    },
    limits: { maxVirtualFleets: 100 },
    scheduler: { retryBaseMs: 1000, retryMaxMs: 60000, catchUpLagMs: 300000 },
    strategy: {
      reviewIntervalMs: 3600000, maxReviewsPerPass: 10, maxActiveFrontsPerFaction: 3,
      mobilizeResourcePerShip: 10, mobilizeReservePerShip: 5, maxBorderSystems: 10, maxBorderScanSystems: 20,
      borderEnabled: true, aiEnabled: false,
      maxAssemblyJumps: 10, maxTerritoryRead: 50, maxExpansionSystems: 20
    },
    graph: { routeMaxJumps: 20 },
    observer: { galaxyEnabled: true, galaxyFleetsEnabled: true, galaxyFleetsMaxItems: 50, galaxyFleetsRefreshMs: 5000, fleetsPanelRows: 10 }
  };
}

function createMockPersistence(db, worldSeed = 12345) {
  const journal = {
    write: (aggregate, key, type, payload) => ({ ok: true }),
    applyOnce: (key, aggregate, type, payload, fn) => fn(),
  };
  return { ok: true, store: { db, limits: { maxRowsPerTransaction: 1000 } }, journal, worldSeed };
}

function createMockClock() {
  let now = 1000000;
  return { now: () => now, advance: (ms) => { now += ms; } };
}

function createMockLogger() {
  const logs = [];
  return { log: (msg) => logs.push(msg), logs: () => logs };
}

async function testMobilizeWithVirtualCorps() {
  const dbResult = createTestDb();
  assert.ok(!dbResult.skipped, dbResult.skipped);
  const db = dbResult.db;
  const repo = createRepository(db);

  const now = Date.now();
  const stmt = db.prepare(`
    INSERT INTO world_virtual_identities (identity_key, founding_op, kind, owner_kind, owner_id, evejs_id, state, name, ticker, created_at, updated_at, version)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
  `);
  stmt.run("f:500019:alliance", "lne:v1:f:500019:alliance", "alliance", "faction", 500019, 9000001, "linked", "Kuvakei Dominion", "KUVAD", now, now);
  stmt.run("f:500019:corp:0", "lne:v1:f:500019:corp:0", "corporation", "faction", 500019, 9000101, "linked", "True Slaves Vanguard", "TSVG", now, now);
  stmt.run("f:500019:corp:1", "lne:v1:f:500019:corp:1", "corporation", "faction", 500019, 9000102, "linked", "Nation Reclamation", "NRCL", now, now);

  const mockVirtualCorps = {
    enabled: true,
    fleetCorporations: true,
    getMapVersion: () => 1,
    corporationForRole: (factionId, role) => {
      if (!mockVirtualCorps.enabled || !mockVirtualCorps.fleetCorporations) return null;
      if (role === "station") return null;
      const corpIds = [9000101, 9000102];
      const roleSlots = { default: 0, mining: 1, logistics: 1, salvage: 1, patrol: 0 };
      const slot = Math.min(roleSlots[role] ?? roleSlots.default, corpIds.length - 1);
      return corpIds[slot] || null;
    },
    nameOf: (id) => {
      if (id === 9000101) return "True Slaves Vanguard";
      if (id === 9000102) return "Nation Reclamation";
      return null;
    },
  };

  const mockRegistry = {
    getFaction: (id) => ({ id, name: "Test Faction", activity: "active", doctrineId: "doctrine_pirate" }),
    listActiveFactions: () => [500019],
    corporationFor: (factionId, role) => 1000001,
    getCorporation: (id) => id === 1000001 ? { name: "SDE Corp One" } : null,
    getDoctrine: (id) => ({ doctrineId: "doctrine_pirate", expandsBeyondTheatre: false, consolidates: true }),
  };

  const mockFleetsRepo = {
    createFleet: (db, input, key) => ({ ok: true, fleetId: 12345, version: 1, duplicate: false }),
  };
  const mockFleets = { repository: mockFleetsRepo };

  const mockStore = {
    transaction: (name, fn) => {
      const result = fn(db);
      return { ok: true, value: result };
    },
  };

  const deps = {
    store: mockStore,
    journal: { write: () => ({ ok: true }), applyOnce: (k, a, t, p, fn) => fn() },
    strategyRepository: { applyFactionChange: () => ({ ok: true, record: { version: 1 } }) },
    intelRepository: {},
    registry: mockRegistry,
    kinds: { list: [], get: () => null },
    scheduler: { registerHandler: () => ({ ok: true }), getStatus: () => ({ state: "ready" }) },
    fleets: mockFleets,
    clock: createMockClock(),
    worldSeed: 12345,
    config: createTestConfig(),
    getVirtualCorps: () => mockVirtualCorps,
    hostility: { valueOf: () => 0 },
    isCampaignOk: () => true,
    telemetry: null,
    logger: createMockLogger(),
    nowMs: () => Date.now(),
  };

  const service = createReviewService(deps);

  const virtualCorpFor = (f, role) => {
    const vc = deps.getVirtualCorps();
    return vc && typeof vc.corporationForRole === "function" ? vc.corporationForRole(f, role) : null;
  };

  const patrolCorp = virtualCorpFor(500019, "patrol");
  assert.strictEqual(patrolCorp, 9000101, "patrol role should map to slot 0 (True Slaves Vanguard)");

  const miningCorp = virtualCorpFor(500019, "mining");
  assert.strictEqual(miningCorp, 9000102, "mining role should map to slot 1 (Nation Reclamation)");

  const logisticsCorp = virtualCorpFor(500019, "logistics");
  assert.strictEqual(logisticsCorp, 9000102, "logistics role should map to slot 1");

  const salvageCorp = virtualCorpFor(500019, "salvage");
  assert.strictEqual(salvageCorp, 9000102, "salvage role should map to slot 1");

  mockVirtualCorps.fleetCorporations = false;
  assert.strictEqual(virtualCorpFor(500019, "patrol"), null, "fleetCorporations=false should return null");

  mockVirtualCorps.fleetCorporations = true;
  assert.strictEqual(virtualCorpFor(500019, "station"), null, "station role should always return null");

  let capturedCorpId = null;
  mockFleetsRepo.createFleet = (db, input, key) => {
    capturedCorpId = input.corporationId;
    return { ok: true, fleetId: 12345, version: 1, duplicate: false };
  };

  mockVirtualCorps.fleetCorporations = true;
  const corpId = virtualCorpFor(500019, "patrol") ?? mockRegistry.corporationFor(500019, "patrol");
  mockFleetsRepo.createFleet(db, { factionId: 500019, corporationId: corpId, currentSystemId: 30000001, homeSystemId: 30000001, fleetRole: "patrol", doctrineId: "doctrine_pirate", composition: [] }, "test-key");
  assert.strictEqual(capturedCorpId, 9000101, "MOBILIZE should use virtual corporation ID for patrol");

  mockVirtualCorps.enabled = false;
  const fallbackCorpId = virtualCorpFor(500019, "patrol") ?? mockRegistry.corporationFor(500019, "patrol");
  assert.strictEqual(fallbackCorpId, 1000001, "Should fall back to registry when virtualCorps disabled");
}

function testStartStrategyWiring() {
  const strategyIndexPath = path.join(__dirname, "../../lib/strategy/index.js");
  const reviewServicePath = path.join(__dirname, "../../lib/strategy/reviewService.js");
  const runtimeServicesPath = path.join(__dirname, "../../lib/runtime/services.js");

  const strategyIndexSource = fs.readFileSync(strategyIndexPath, "utf8");
  const reviewServiceSource = fs.readFileSync(reviewServicePath, "utf8");
  const runtimeServicesSource = fs.readFileSync(runtimeServicesPath, "utf8");

  assert.ok(
    strategyIndexSource.includes("getVirtualCorps: deps.getVirtualCorps"),
    "startStrategy should pass getVirtualCorps to createReviewService"
  );

  assert.ok(
    reviewServiceSource.includes("getVirtualCorps") &&
    reviewServiceSource.includes("virtualCorpFor"),
    "reviewService should use getVirtualCorps and virtualCorpFor"
  );

  assert.ok(
    reviewServiceSource.includes("virtualCorpFor(f, mob.role) ?? registry.corporationFor(f, mob.role)"),
    "mobilizeInTx should use virtualCorpFor with fallback to registry"
  );

  assert.ok(
    runtimeServicesSource.includes("getVirtualCorps: () => ctx.virtualCorps || null"),
    "runtime/services.js should pass getVirtualCorps getter to fleets"
  );
}

function testNameOfAndListIdentitiesOnRealRepo() {
  const dbResult = createTestDb();
  assert.ok(!dbResult.skipped, dbResult.skipped);
  const db = dbResult.db;
  const repo = createRepository(db);

  const now = Date.now();
  const stmt = db.prepare(`
    INSERT INTO world_virtual_identities (identity_key, founding_op, kind, owner_kind, owner_id, evejs_id, state, name, ticker, created_at, updated_at, version)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
  `);
  stmt.run("f:500019:alliance", "lne:v1:f:500019:alliance", "alliance", "faction", 500019, 9000001, "linked", "Test Alliance", "TSTA", now, now);
  stmt.run("f:500019:corp:0", "lne:v1:f:500019:corp:0", "corporation", "faction", 500019, 9000101, "linked", "Test Corp Alpha", "TCA", now, now);
  stmt.run("f:500019:corp:1", "lne:v1:f:500019:corp:1", "corporation", "faction", 500019, 9000102, "linked", "Test Corp Beta", "TCB", now, now);
  stmt.run("f:500019:corp:0:char:0", "lne:v1:f:500019:corp:0:char:0", "character", "faction", 500019, 9000201, "linked", "Test Pilot 1", null, now, now);

  const virtualCorps = require("../../lib/virtualCorps");
  virtualCorps.setRepoForTest(repo);

  const corpName = virtualCorps.nameOf(9000101);
  assert.strictEqual(corpName, "Test Corp Alpha", "nameOf should return corporation name from in-memory map");

  const allianceName = virtualCorps.nameOf(9000001);
  assert.strictEqual(allianceName, "Test Alliance", "nameOf should return alliance name from in-memory map");

  const missingName = virtualCorps.nameOf(9999999);
  assert.strictEqual(missingName, null, "nameOf should return null for non-existent ID");

  assert.ok(virtualCorps.isVirtualCorporation(9000101), "isVirtualCorporation should return true for virtual corp");
  assert.ok(!virtualCorps.isVirtualCorporation(9999999), "isVirtualCorporation should return false for non-virtual ID");

  assert.ok(virtualCorps.isVirtualAlliance(9000001), "isVirtualAlliance should return true for virtual alliance");
  assert.ok(!virtualCorps.isVirtualAlliance(9999999), "isVirtualAlliance should return false for non-virtual ID");

  const identities = virtualCorps.listIdentities();
  assert.ok(Array.isArray(identities), "listIdentities should return an array");
  assert.strictEqual(identities.length, 4, "listIdentities should return all LINKED identities");

  for (const id of identities) {
    assert.strictEqual(id.state, "linked", "All listed identities should be LINKED");
  }

  const version = virtualCorps.getMapVersion();
  assert.ok(typeof version === "number" && version > 0, "getMapVersion should return a positive number");

  const patrolCorp = virtualCorps.corporationForRole(500019, "patrol");
  assert.strictEqual(patrolCorp, 9000101, "corporationForRole should return slot 0 corp from in-memory map");

  const miningCorp = virtualCorps.corporationForRole(500019, "mining");
  assert.strictEqual(miningCorp, 9000102, "corporationForRole should return slot 1 corp for mining");

  const mockRegistry = {
    getCorporation: (id) => id === 1000001 ? { name: "SDE Corp One" } : null,
    corporationFor: (factionId, role) => 1000001,
  };
  const mockVirtualCorps = {
    nameOf: (id) => id === 9000101 ? "Test Corp Alpha" : (id === 9000102 ? "Test Corp Beta" : null),
  };

  const fleetWithVirtualCorp = { factionId: 500019, corporationId: 9000101, fleetRole: "patrol" };
  const result = require("../../lib/fleets/fleetsView").corporationOf(fleetWithVirtualCorp, mockRegistry, mockVirtualCorps);
  assert.ok(result, "corporationOf should return object for valid virtual corp ID");
  assert.strictEqual(result.id, 9000101, "ID should match");
  assert.strictEqual(result.name, "Test Corp Alpha", "Name should come from virtualCorps.nameOf");

  const mockStore = { isOpen: () => true };
  const mockClock = { now: () => 1000000 };
  const viewDeps = {
    store: mockStore,
    repository: { countByState: () => ({ ok: true, counts: {}, active: 0 }), countOperationsByState: () => ({ ok: true, counts: {} }), countOverdueInFlight: () => ({ ok: true, count: 0 }), listFleetsByState: () => ({ ok: true, fleets: [] }) },
    clock: mockClock,
    getGovernor: () => null,
    getStatus: () => ({}),
    getScheduler: () => null,
    getRegistry: () => mockRegistry,
    getVirtualCorps: () => ({ getMapVersion: () => 42 }),
    rows: 10,
    refreshMs: 5000,
    limit: 100,
    catchUpLagMs: 300000,
  };
  const view = buildFleetsView(viewDeps);
  const cacheKey = view.cacheKey();
  assert.ok(cacheKey.includes("v1"), "cacheKey should include virtualCorps version (v1)");
}

function testListTradeIssuersOnRealRepo() {
  const dbResult = createTestDb();
  assert.ok(!dbResult.skipped, dbResult.skipped);
  const db = dbResult.db;
  const now = Date.now();
  const stmt = db.prepare(`
    INSERT INTO world_virtual_identities (identity_key, founding_op, kind, owner_kind, owner_id, evejs_id, state, name, ticker, created_at, updated_at, version)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
  `);
  const row = (key, kind, faction, evejsId, state) =>
    stmt.run(key, `lne:v1:${key}`, kind, "faction", faction, evejsId, state, null, null, now, now);
  row("f:500019:alliance", "alliance", 500019, 9000001, "linked");
  row("f:500019:corp:1", "corporation", 500019, 9000102, "linked");
  row("f:500019:corp:1:char:0", "character", 500019, 9000211, "created");
  row("f:500019:corp:1:char:1", "character", 500019, 9000212, "linked");
  row("f:500019:corp:0", "corporation", 500019, 9000101, "linked");
  row("f:500019:corp:0:char:0", "character", 500019, 9000201, "linked");
  row("f:500019:corp:0:char:1", "character", 500019, 9000202, "linked");
  row("f:500020:corp:0", "corporation", 500020, 9000301, "linked");
  row("f:500020:corp:0:char:0", "character", 500020, 9000401, "linked");

  const virtualCorps = require("../../lib/virtualCorps");
  try {
    virtualCorps.setRepoForTest(createRepository(db));
    assert.deepStrictEqual(virtualCorps.listTradeIssuers(500019), {
      ok: true, ready: false,
      issuers: [{ factionId: 500019, slot: 0, corporationId: 9000101, characterId: 9000201 }],
    });
    assert.deepStrictEqual(virtualCorps.listTradeIssuers().issuers.map((i) => [i.factionId, i.slot, i.characterId]),
      [[500019, 0, 9000201], [500020, 0, 9000401]]);
    assert.deepStrictEqual(virtualCorps.listTradeIssuers(123).issuers, []);
    assert.ok(Object.isFrozen(virtualCorps.listTradeIssuers(500019).issuers), "frozen list");
  } finally {
    virtualCorps.stopVirtualCorps({});
  }
  assert.deepStrictEqual(virtualCorps.listTradeIssuers(500019), { ok: false, reason: "NOT_STARTED" });
}

function testViewWithSagaShapedData() {
  const { buildVirtualCorpsView } = require("../../lib/virtualCorps/view");
  const { IDENTITY_STATES } = require("../../lib/virtualCorps/schema");

  const mockVirtualCorps = {
    listIdentities: () => [
      { identity_key: "f:500019:alliance", founding_op: "lne:v1:f:500019:alliance", kind: "alliance", owner_kind: "faction", owner_id: 500019, evejs_id: 9000001, state: IDENTITY_STATES.LINKED, name: "Test Alliance", ticker: "TSTA" },
      { identity_key: "f:500019:corp:0", founding_op: "lne:v1:f:500019:corp:0", kind: "corporation", owner_kind: "faction", owner_id: 500019, evejs_id: 9000101, state: IDENTITY_STATES.LINKED, name: "Test Corp Alpha", ticker: "TCA" },
      { identity_key: "f:500019:corp:1", founding_op: "lne:v1:f:500019:corp:1", kind: "corporation", owner_kind: "faction", owner_id: 500019, evejs_id: 9000102, state: IDENTITY_STATES.LINKED, name: "Test Corp Beta", ticker: "TCB" },
      { identity_key: "f:500019:corp:0:char:0", founding_op: "lne:v1:f:500019:corp:0:char:0", kind: "character", owner_kind: "faction", owner_id: 500019, evejs_id: 9000201, state: IDENTITY_STATES.LINKED, name: "Pilot 1" },
      { identity_key: "f:500019:corp:0:char:1", founding_op: "lne:v1:f:500019:corp:0:char:1", kind: "character", owner_kind: "faction", owner_id: 500019, evejs_id: 9000202, state: IDENTITY_STATES.LINKED, name: "Pilot 2" },
      { identity_key: "f:500019:corp:1:char:0", founding_op: "lne:v1:f:500019:corp:1:char:0", kind: "character", owner_kind: "faction", owner_id: 500019, evejs_id: 9000211, state: IDENTITY_STATES.LINKED, name: "Pilot 3" },
    ],
    getMapVersion: () => 1,
  };

  const mockStrategy = {
    registry: {
      getFaction: (id) => ({ id, name: "Test Faction" }),
    },
  };

  const view = buildVirtualCorpsView({ virtualCorps: mockVirtualCorps, strategy: mockStrategy, config: {} });
  const data = view.getData();

  assert.ok(data.available, "view should be available");
  assert.strictEqual(data.rows.length, 1, "should have one faction row");
  const row = data.rows[0];
  assert.strictEqual(row.faction, "Test Faction");
  assert.strictEqual(row.state, IDENTITY_STATES.LINKED, "overall state should be LINKED");
  assert.strictEqual(row.characters, "3/3 LINKED", "characters should show 3/3 LINKED");
  assert.strictEqual(row.reason, "OK", "reason should be OK for LINKED");
  assert.ok(row.alliance.includes("Test Alliance"), "alliance name should be present");
  assert.ok(row.corporations.includes("Test Corp Alpha"), "corp name should be present");
  assert.ok(row.corporations.includes("Test Corp Beta"), "corp name should be present");
}

function testViewUsesAdapterFactionNames() {
  const { buildVirtualCorpsView } = require("../../lib/virtualCorps/view");
  const { IDENTITY_STATES } = require("../../lib/virtualCorps/schema");
  const mockVirtualCorps = {
    listIdentities: () => [
      { identity_key: "f:500001:alliance", kind: "alliance", owner_kind: "faction", owner_id: 500001, evejs_id: 9000001, state: IDENTITY_STATES.LINKED, name: "A", ticker: "A" },
      { identity_key: "f:500019:alliance", kind: "alliance", owner_kind: "faction", owner_id: 500019, evejs_id: 9000002, state: IDENTITY_STATES.LINKED, name: "B", ticker: "B" },
    ],
    getMapVersion: () => 1,
  };
  const view = buildVirtualCorpsView({ virtualCorps: mockVirtualCorps, strategy: { registry: { getFaction: (id) => ({ id }) } },
    config: {}, factionNames: new Map([[500001, "Caldari State"]]) });
  const byFaction = Object.fromEntries(view.getData().rows.map((r) => [r.faction, true]));
  assert.ok(byFaction["Caldari State"], JSON.stringify(byFaction));
  assert.ok(byFaction["Faction 500019"], "no name anywhere -> fallback label per faction");
}

function testViewWithRefusedState() {
  const { buildVirtualCorpsView } = require("../../lib/virtualCorps/view");
  const { IDENTITY_STATES } = require("../../lib/virtualCorps/schema");

  const mockVirtualCorps = {
    listIdentities: () => [
      { identity_key: "f:500019:alliance", founding_op: "lne:v1:f:500019:alliance", kind: "alliance", owner_kind: "faction", owner_id: 500019, evejs_id: 9000001, state: IDENTITY_STATES.LINKED, name: "Test Alliance", ticker: "TSTA" },
      { identity_key: "f:500019:corp:0", founding_op: "lne:v1:f:500019:corp:0", kind: "corporation", owner_kind: "faction", owner_id: 500019, evejs_id: 9000101, state: IDENTITY_STATES.REFUSED, name: "Test Corp", ticker: "TSTC", reason: "NAME_TAKEN" },
    ],
    getMapVersion: () => 1,
  };

  const view = buildVirtualCorpsView({ virtualCorps: mockVirtualCorps, strategy: null, config: {} });
  const data = view.getData();

  assert.ok(data.available);
  assert.strictEqual(data.rows.length, 1);
  const row = data.rows[0];
  assert.strictEqual(row.state, IDENTITY_STATES.REFUSED, "overall state should be REFUSED when corp is REFUSED");
  assert.strictEqual(row.reason, "NAME_TAKEN", "reason should be the refused reason");
}

function testFacadeObjectsHaveListTradeIssuers() {
  const virtualCorps = require("../../lib/virtualCorps");
  const logger = { log() {} };
  const objects = {
    disabled_by_config: virtualCorps.startVirtualCorps({ config: { modules: { virtualCorps: { enabled: false } } }, logger }),
    not_world_process: virtualCorps.startVirtualCorps({ config: { modules: { virtualCorps: { enabled: true } } }, logger,
      adapter: { getProcessRole: () => "gateway" } }),
    NO_PERSISTENCE_STORE: virtualCorps.startVirtualCorps({ config: { modules: { virtualCorps: { enabled: true } } }, logger,
      adapter: { getProcessRole: () => "world" }, persistence: {} }),
    catch: virtualCorps.startVirtualCorps({ logger }),
    unavailable: virtualCorps.createUnavailableVirtualCorps("SERVICE_UNAVAILABLE", "test"),
  };
  const reasons = { disabled_by_config: "DISABLED", not_world_process: "NOT_WORLD_PROCESS",
    NO_PERSISTENCE_STORE: "NO_PERSISTENCE_STORE", catch: "START_FAILED", unavailable: "SERVICE_UNAVAILABLE" };
  for (const [name, facade] of Object.entries(objects)) {
    assert.strictEqual(facade.ok, false, name);
    for (const method of ["listTradeIssuers", "corporationForRole", "getFactionIdentity"]) {
      assert.strictEqual(typeof facade[method], "function", `${name}.${method}`);
    }
    assert.deepStrictEqual(facade.listTradeIssuers(500019), { ok: false, reason: reasons[name] }, name);
    assert.strictEqual(facade.listTradeIssuers().reason, facade.getFactionIdentity(500019).reason, `${name}: same reason`);
    assert.strictEqual(facade.corporationForRole(500019, "patrol"), null, name);
  }
}

function fakeIdentityAdapterForStoreFail() {
  const characters = {};
  const corporations = {};
  const alliances = {};
  let next = 0;
  return {
    getProcessRole: () => "world",
    reserveCharacterId: () => {
      const id = 1000000 + (next += 1);
      characters[id] = { characterId: id, corporationID: 0, allianceID: 0 };
      return { ok: true, characterId: id };
    },
    writeCharacter: (record) => {
      characters[record.characterId] = { characterId: record.characterId, corporationID: record.corporationId,
        allianceID: record.allianceID || 0, lneIdentityKey: record.lneIdentityKey };
      return { ok: true };
    },
    pickCharacterName: (raceId) => ({ ok: true, name: `Pilot_${raceId}_${next += 1}` }),
    ensureCorporation: (_ceoId, spec) => {
      const id = 2000000 + Object.keys(corporations).length;
      corporations[id] = { corporationID: id, name: spec.name, allianceID: 0 };
      return { ok: true, corporationId: id };
    },
    ensureAlliance: (_creatorId, _execCorpId, spec) => {
      const id = 3000000 + Object.keys(alliances).length;
      alliances[id] = { allianceID: id, name: spec.name };
      return { ok: true, allianceId: id };
    },
    markAllianceNpc: () => ({ ok: 1, changed: true }),
    markCorporationNoWar: () => ({ ok: 1, changed: true }),
    joinCorporation: (characterId, corporationId, allianceId) => {
      if (characters[characterId]) Object.assign(characters[characterId], { corporationID: corporationId, allianceID: allianceId || 0 });
      return { ok: true };
    },
    joinAlliance: (corporationId, allianceId) => {
      if (corporations[corporationId]) corporations[corporationId].allianceID = allianceId;
      return { ok: true };
    },
    virtualIdentityExists: (kind, id) => ({ ok: true,
      found: Boolean((kind === "character" ? characters : kind === "corporation" ? corporations : alliances)[id]) }),
    scanVirtualCharacters: () => ({ ok: true,
      characters: Object.values(characters).filter((c) => typeof c.lneIdentityKey === "string") }),
    virtualIdentityFlush: () => ({ ok: true }),
    resolveCharacterCreationBloodlineProfile: () => ({ ok: true, raceId: 4, typeId: 401 }),
  };
}

function startVCOnStore(virtualCorps, store, logs, counters) {
  return virtualCorps.startVirtualCorps({
    config: {
      modules: { virtualCorps: { enabled: true } },
      virtualCorps: { corpsPerFaction: 2, membersPerCorp: 3, maxCharacters: 64, seedOpsPerSlice: 4, fleetCorporations: true },
    },
    adapter: fakeIdentityAdapterForStoreFail(),
    persistence: { ok: true, store },
    logger: { log: (msg) => logs.push(msg) },
    fail: () => ({ ok: false }),
    clock: { now: () => 1000000 },
    telemetry: { count: (name, n = 1) => counters.set(name, (counters.get(name) || 0) + n), gauge: () => {}, observe: () => {} },
    strategy: { registry: { isActive: (id) => id === 500019 } },
  });
}

async function testStoreFailureSuspendKeepsMaps() {
  const virtualCorps = require("../../lib/virtualCorps");
  const { _resetLogFlagsForTest } = require("../../lib/virtualCorps/identityRepository");
  const driverResult = loadSqliteDriver();
  if (!driverResult.ok) return;
  const { openStore } = require("../../lib/persistence/store");
  const { MIGRATIONS } = require("../../lib/persistence/migrations");
  const opened = openStore({ filePath: ":memory:", openDatabase: () => new driverResult.Database(":memory:"),
    exclusiveLock: true, busyTimeoutMs: 0, maxRowsPerTransaction: 500, maxWriteMsPerPass: 5,
    randomSeed: () => 1, migrations: MIGRATIONS });
  assert.ok(opened.ok, JSON.stringify(opened));
  const store = opened.store;
  const logs = [];
  const counters = new Map();
  try {
    _resetLogFlagsForTest();

    const started = startVCOnStore(virtualCorps, store, logs, counters);
    assert.strictEqual(started.ok, true, JSON.stringify(started));
    await started.whenReady();

    const versionBefore = virtualCorps.getMapVersion();
    const identityBefore = virtualCorps.getFactionIdentity(500019);
    assert.strictEqual(identityBefore.ok, true, `identity before suspend: ${JSON.stringify(identityBefore)}`);
    assert.ok(versionBefore > 0, "mapVersion should be > 0 after seed");

    store.suspend("PERSISTENCE_OWNER_LOST");

    virtualCorps.rebuildMaps();

    assert.strictEqual(virtualCorps.getMapVersion(), versionBefore, "mapVersion must not change after failed read (1st)");
    const identityAfter1 = virtualCorps.getFactionIdentity(500019);
    assert.deepStrictEqual(identityAfter1, identityBefore, "getFactionIdentity must not change after failed read (1st)");

    const counterAfter1 = counters.get("virtualCorps.storeFailed");
    assert.ok(counterAfter1 >= 1,
      `virtualCorps.storeFailed counter must be >= 1 after 1st rebuildMaps, got ${counterAfter1}`);

    virtualCorps.rebuildMaps();

    assert.strictEqual(virtualCorps.getMapVersion(), versionBefore, "mapVersion must not change after failed read (2nd)");
    const identityAfter2 = virtualCorps.getFactionIdentity(500019);
    assert.deepStrictEqual(identityAfter2, identityBefore, "getFactionIdentity must not change after failed read (2nd)");

    const counterAfter2 = counters.get("virtualCorps.storeFailed");
    assert.ok(counterAfter2 > counterAfter1,
      `virtualCorps.storeFailed counter must increase after 2nd rebuildMaps (${counterAfter1} -> ${counterAfter2})`);

    const failLogs = logs.filter(l => l.includes("repository call") && l.includes("failed"));
    assert.strictEqual(failLogs.length, 1, `expected exactly one store-failed log line, got ${failLogs.length}: ${logs.join(" | ")}`);
  } finally {
    virtualCorps.stopVirtualCorps();
    store.close("wiring-1");
  }
}

function testStoreFailureClosedStore() {
  const { IDENTITY_STATES } = require("../../lib/virtualCorps/schema");
  const driverResult = loadSqliteDriver();
  if (!driverResult.ok) return;
  const { openStore } = require("../../lib/persistence/store");
  const { MIGRATIONS } = require("../../lib/persistence/migrations");
  const opened = openStore({ filePath: ":memory:", openDatabase: () => new driverResult.Database(":memory:"),
    exclusiveLock: true, busyTimeoutMs: 0, maxRowsPerTransaction: 500, maxWriteMsPerPass: 5,
    randomSeed: () => 1, migrations: MIGRATIONS });
  assert.ok(opened.ok, JSON.stringify(opened));
  const store = opened.store;
  const logs = [];
  const counters = new Map();
  try {
    const { createStoreRepository, _resetLogFlagsForTest } = require("../../lib/virtualCorps/identityRepository");
    _resetLogFlagsForTest();
    const repo = createStoreRepository(store, {
      telemetry: { count: (name, n = 1) => counters.set(name, (counters.get(name) || 0) + n) },
      logger: { log: (msg) => logs.push(msg) },
    });

    store.close("wiring-2");

    const readRes = repo.readByState(IDENTITY_STATES.LINKED);
    assert.strictEqual(readRes.ok, false, `readByState on closed store should be ok:false, got ${JSON.stringify(readRes)}`);
    assert.strictEqual(readRes.reason, "STORE_CLOSED", `readByState on closed store should be STORE_CLOSED, got ${readRes.reason}`);

    const counterAfterRead = counters.get("virtualCorps.storeFailed");
    assert.ok(counterAfterRead >= 1, `virtualCorps.storeFailed counter must be >= 1 after readByState, got ${counterAfterRead}`);

    const readFailLogs = logs.filter(l => l.includes("repository call readByState failed") && l.includes("STORE_CLOSED"));
    assert.strictEqual(readFailLogs.length, 1, `expected exactly one readByState log line with STORE_CLOSED, got ${readFailLogs.length}: ${logs.join(" | ")}`);

    const listRes = repo.listByState(IDENTITY_STATES.LINKED);
    assert.ok(Array.isArray(listRes), "listByState on closed store should return array");
    assert.strictEqual(listRes.length, 0, `listByState on closed store should return [], got ${listRes.length}`);

    const counterAfterList = counters.get("virtualCorps.storeFailed");
    assert.ok(counterAfterList > counterAfterRead,
      `virtualCorps.storeFailed counter must increase after listByState (${counterAfterRead} -> ${counterAfterList})`);

    const failLogsTotal = logs.filter(l => l.includes("repository call") && l.includes("failed"));
    assert.strictEqual(failLogsTotal.length, 1, `expected exactly one store-failed log line total (shared flag), got ${failLogsTotal.length}: ${logs.join(" | ")}`);

    const getRes = repo.getByKey("f:500019:alliance");
    assert.strictEqual(getRes.ok, false, `getByKey on closed store should be ok:false, got ${JSON.stringify(getRes)}`);
    assert.strictEqual(getRes.reason, "STORE_CLOSED", `getByKey on closed store should be STORE_CLOSED, got ${getRes.reason}`);
    const counterAfterGet = counters.get("virtualCorps.storeFailed");
    assert.ok(counterAfterGet > counterAfterList,
      `virtualCorps.storeFailed counter must increase after getByKey (${counterAfterList} -> ${counterAfterGet})`);
  } finally {
    store.close("wiring-2-finally");
  }
}

module.exports = ({ test, skip, bench, benchEnabled }) => {
  const driver = loadSqliteDriver();
  const needsDriver = (name, fn) => (driver.ok ? test(name, fn)
    : skip(name, `better-sqlite3 not available: ${driver.detail}`));
  needsDriver("virtualCorps wiring: MOBILIZE with mock getVirtualCorps (patrol->slot 0, mining->slot 1, fallback)", testMobilizeWithVirtualCorps);
  test("virtualCorps wiring: startStrategy passes getVirtualCorps to reviewService (source check)", testStartStrategyWiring);
  needsDriver("virtualCorps wiring: nameOf/listIdentities on real repo with in-memory map", testNameOfAndListIdentitiesOnRealRepo);
  needsDriver("VC36a listTradeIssuers: slot heads from LINKED corp + char:0, slot without LINKED char:0 skipped, all factions, NOT_STARTED after stop", testListTradeIssuersOnRealRepo);
  test("VC36b facade objects (disabled, not world, no store, catch, unavailable) have listTradeIssuers + corporationForRole", testFacadeObjectsHaveListTradeIssuers);
  test("VC-NOTE1 view.js: saga-shaped data (lowercase states) -> LINKED row with 3/3 LINKED characters", testViewWithSagaShapedData);
  test("VC-NOTE1 view.js: REFUSED state in data -> overall REFUSED with reason", testViewWithRefusedState);
  test("OR-A3 view.js: factionNames from the adapter -> faction name instead of Faction <id>", testViewUsesAdapterFactionNames);
  needsDriver("VC-NOTE2-1 store.suspend -> rebuildMaps keeps maps/version, counter >= 1, one log line", testStoreFailureSuspendKeepsMaps);
  needsDriver("VC-NOTE2-2 closed store -> readByState {ok:false,STORE_CLOSED}, listByState []", testStoreFailureClosedStore);
};