"use strict";

const assert = require("node:assert");
const path = require("node:path");

const { harness: H } = require("../battle/settlement.test");
const { S } = require("../graph/fixtures/routeMap.fixture");
const { createWorldStateRepository } = require("../../lib/world/worldStateRepository");
const { createOccupationService } = require("../../lib/world/occupation/occupationService");
const { createStationRepository } = require("../../lib/stations/stationRepository");
const { createJournal } = require("../../lib/persistence/journal");
const { startScheduler } = require("../../lib/scheduler");
const { createHostility } = require("../../lib/battle/data/hostility");
const { FLEET_ROLES, OPERATION_TYPES, HULL_GROUPS } = require("../../lib/fleets/schema");
const { GROUPS: STRENGTH_GROUPS } = require("../../lib/battle/data/strengthCatalog");
const { buildPowerTable } = require("../../lib/strategy/ai/strength");
const { resolveConfig } = require("../../config");
const { createFactionRegistry } = require("../../lib/strategy/registry");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const AMARR = 500003;
const LIMITS = Object.freeze({ maxFactionsPerSystem: 8, maxBatchReadIds: 400, maxListLimit: 500 });

const REGISTRY_DATA_V1 = require("../../lib/strategy/registry").REGISTRY_DATA_V1;

function configOf(env = {}) {
  const r = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_DATA_ROOT: path.dirname(require("node:os").tmpdir()), ...env } });
  assert.deepStrictEqual(r.errors || [], []);
  return r.config;
}

function seedSystem(tx, repo, systemId, controller, influence) {
  const r = repo.applyChange(tx, { systemId, expectedVersion: 0, reason: "SEED_CONTROL",
    state: { securityClass: "nullsec", controllerFactionId: controller },
    influence: Object.entries(influence).map(([f, s]) => ({ factionId: Number(f), influenceScore: s })) },
  `world:seed:v1:${systemId}`);
  assert.ok(r.ok, JSON.stringify(r));
}

module.exports = ({ test, skip }) => {
  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  needsDriver("coreAudit: Amarr core + ONLINE station -> violations = 0", () =>
    H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const config = configOf({ EVEJS_LNE_OCCUPATION_EVAL_INTERVAL_MS: "3600000" });
      const opened = reopen();
      const journal = createJournal({ clock: shared.clock, maxPayloadBytes: 16384, maxRows: 500 });
      const sr = startScheduler({ config, persistence: { ok: true, store: opened.store }, clock: shared.clock, ids: shared.ids, nowMs: () => 0 });
      assert.ok(sr.ok, JSON.stringify(sr));

      const stationLimits = { maxPerSystem: 8, maxPerSystemPerFaction: 3, maxPerFaction: 64, maxStations: 2000, maxStockItemsPerStation: 256, maxStockQuantity: 1000000000000, maxDeltasPerChange: 32 };
      const registryResult = createFactionRegistry(REGISTRY_DATA_V1, {
        hullGroups: HULL_GROUPS,
        fleetRoles: FLEET_ROLES,
        operationTypes: OPERATION_TYPES,
        hostility: createHostility(),
        maxFactions: 64,
        maxCampaignSystems: 40,
        maxShipsPerFleet: 500,
        maxCompositionEntries: 32,
        maxResourceUnits: 1000000000
      });
      assert.ok(registryResult.ok, JSON.stringify(registryResult));
      const registry = registryResult.registry;
      const stationRepo = createStationRepository({ journal, limits: stationLimits, isKnownFaction: (id) => registry.isActive(id), hullGroups: HULL_GROUPS });

      const stationId = `upw-${S.N0}-001`;
      const createTx = opened.store.transaction("stations.create", (tx) =>
        stationRepo.createStation(tx, { stationId, kind: "upwell", npcStationId: null, typeId: 35832, structureFamily: "astrahus", systemId: S.N0, ownerFactionId: AMARR, ownerCorporationId: 1000001, name: "Amarr Core", position: { x: 0, y: 0, z: 0 }, origin: "seed", at: shared.clock.now(), initialState: "ONLINE" }, "test:station:create")
      );
      assert.ok(createTx.ok, JSON.stringify(createTx));
      assert.strictEqual(createTx.value.record.state, "ONLINE");
      assert.strictEqual(createTx.value.record.ownerFactionId, AMARR);

      const repo = createWorldStateRepository({ journal, clock: shared.clock, limits: LIMITS });
      opened.store.transaction("test", (db) => seedSystem(db, repo, S.N0, AMARR, { [AMARR]: 60 }));

      const stationsFacade = { getMode: () => "ready", repository: stationRepo };
      const mockCoreIndex = {
        enabled: true,
        systems: new Map([[S.N0, AMARR]]),
        stations: new Map([[stationId, AMARR]]),
        byFaction: new Map([[AMARR, { systemIds: [S.N0], stationId }]]),
        version: 1
      };

      const occ = createOccupationService({
        store: opened.store, journal, repository: repo, fleets: null, scheduler: sr.scheduler,
        graph: { getGraph: () => ({ ok: true, graph: shared.graph }) },
        getStations: () => stationsFacade, hostility: createHostility(), powerTable: buildPowerTable(STRENGTH_GROUPS),
        clock: shared.clock, config, coreIndex: mockCoreIndex
      });
      assert.ok(occ, "occupation service created");

      const audit = opened.store.transaction("test", (tx) => occ.auditCoresInTx(tx));
      assert.ok(audit.ok, JSON.stringify(audit));
      assert.strictEqual(audit.value.violations.length, 0, "expected 0 violations with ONLINE station owned by core owner");
    })
  );

  needsDriver("coreAudit: Amarr core + DESTROYED station -> violations = 1 (STATION_LOST)", () =>
    H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const config = configOf({ EVEJS_LNE_OCCUPATION_EVAL_INTERVAL_MS: "3600000" });
      const opened = reopen();
      const journal = createJournal({ clock: shared.clock, maxPayloadBytes: 16384, maxRows: 500 });
      const sr = startScheduler({ config, persistence: { ok: true, store: opened.store }, clock: shared.clock, ids: shared.ids, nowMs: () => 0 });
      assert.ok(sr.ok, JSON.stringify(sr));

      const stationLimits = { maxPerSystem: 8, maxPerSystemPerFaction: 3, maxPerFaction: 64, maxStations: 2000, maxStockItemsPerStation: 256, maxStockQuantity: 1000000000000, maxDeltasPerChange: 32 };
      const registryResult = createFactionRegistry(REGISTRY_DATA_V1, {
        hullGroups: HULL_GROUPS,
        fleetRoles: FLEET_ROLES,
        operationTypes: OPERATION_TYPES,
        hostility: createHostility(),
        maxFactions: 64,
        maxCampaignSystems: 40,
        maxShipsPerFleet: 500,
        maxCompositionEntries: 32,
        maxResourceUnits: 1000000000
      });
      assert.ok(registryResult.ok, JSON.stringify(registryResult));
      const registry = registryResult.registry;
      const stationRepo = createStationRepository({ journal, limits: stationLimits, isKnownFaction: (id) => registry.isActive(id), hullGroups: HULL_GROUPS });

      const stationId = `upw-${S.N0}-001`;
      let stationVersion = 1;
      let tx = opened.store.transaction("stations.create", (dbTx) =>
        stationRepo.createStation(dbTx, { stationId, kind: "upwell", npcStationId: null, typeId: 35832, structureFamily: "astrahus", systemId: S.N0, ownerFactionId: AMARR, ownerCorporationId: 1000001, name: "Amarr Core", position: { x: 0, y: 0, z: 0 }, origin: "seed", at: shared.clock.now(), initialState: "ONLINE" }, "test:station:create")
      );
      assert.ok(tx.ok, JSON.stringify(tx));
      stationVersion = tx.value.record.version;

      tx = opened.store.transaction("stations.transition", (dbTx) =>
        stationRepo.transitionStation(dbTx, { stationId, expectedVersion: stationVersion, from: "ONLINE", to: "ARMOR_REINFORCE", key: "test:armor", reason: "test", at: shared.clock.now() }, "test:station:armor")
      );
      assert.ok(tx.ok, JSON.stringify(tx));
      stationVersion = tx.value.record.version;

      tx = opened.store.transaction("stations.transition", (dbTx) =>
        stationRepo.transitionStation(dbTx, { stationId, expectedVersion: stationVersion, from: "ARMOR_REINFORCE", to: "HULL_REINFORCE", key: "test:hull", reason: "test", at: shared.clock.now() }, "test:station:hull")
      );
      assert.ok(tx.ok, JSON.stringify(tx));
      stationVersion = tx.value.record.version;

      tx = opened.store.transaction("stations.transition", (dbTx) =>
        stationRepo.transitionStation(dbTx, { stationId, expectedVersion: stationVersion, from: "HULL_REINFORCE", to: "DESTROYED", key: "test:destroyed", reason: "test", at: shared.clock.now() }, "test:station:destroyed")
      );
      assert.ok(tx.ok, JSON.stringify(tx));

      const repo = createWorldStateRepository({ journal, clock: shared.clock, limits: LIMITS });
      opened.store.transaction("test", (db) => seedSystem(db, repo, S.N0, AMARR, { [AMARR]: 60 }));

      const stationsFacade = { getMode: () => "ready", repository: stationRepo };
      const mockCoreIndex = {
        enabled: true,
        systems: new Map([[S.N0, AMARR]]),
        stations: new Map([[stationId, AMARR]]),
        byFaction: new Map([[AMARR, { systemIds: [S.N0], stationId }]]),
        version: 1
      };

      const occ = createOccupationService({
        store: opened.store, journal, repository: repo, fleets: null, scheduler: sr.scheduler,
        graph: { getGraph: () => ({ ok: true, graph: shared.graph }) },
        getStations: () => stationsFacade, hostility: createHostility(), powerTable: buildPowerTable(STRENGTH_GROUPS),
        clock: shared.clock, config, coreIndex: mockCoreIndex
      });

      const audit = opened.store.transaction("test", (tx) => occ.auditCoresInTx(tx));
      assert.ok(audit.ok, JSON.stringify(audit));
      assert.strictEqual(audit.value.violations.length, 1, "expected 1 violation with DESTROYED station");
      assert.strictEqual(audit.value.violations[0].kind, "STATION_LOST", "violation should be STATION_LOST");
      assert.strictEqual(audit.value.violations[0].factionId, AMARR, "violation should be for Amarr");
      assert.strictEqual(audit.value.violations[0].ref, stationId, "violation should reference the station");
    })
  );

  needsDriver("coreAudit: Amarr core + station owned by Sansha -> violations = 1 (STATION_LOST)", () =>
    H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const config = configOf({ EVEJS_LNE_OCCUPATION_EVAL_INTERVAL_MS: "3600000" });
      const opened = reopen();
      const journal = createJournal({ clock: shared.clock, maxPayloadBytes: 16384, maxRows: 500 });
      const sr = startScheduler({ config, persistence: { ok: true, store: opened.store }, clock: shared.clock, ids: shared.ids, nowMs: () => 0 });
      assert.ok(sr.ok, JSON.stringify(sr));

      const stationLimits = { maxPerSystem: 8, maxPerSystemPerFaction: 3, maxPerFaction: 64, maxStations: 2000, maxStockItemsPerStation: 256, maxStockQuantity: 1000000000000, maxDeltasPerChange: 32 };
      const registryResult = createFactionRegistry(REGISTRY_DATA_V1, {
        hullGroups: HULL_GROUPS,
        fleetRoles: FLEET_ROLES,
        operationTypes: OPERATION_TYPES,
        hostility: createHostility(),
        maxFactions: 64,
        maxCampaignSystems: 40,
        maxShipsPerFleet: 500,
        maxCompositionEntries: 32,
        maxResourceUnits: 1000000000
      });
      assert.ok(registryResult.ok, JSON.stringify(registryResult));
      const registry = registryResult.registry;
      const stationRepo = createStationRepository({ journal, limits: stationLimits, isKnownFaction: (id) => registry.isActive(id), hullGroups: HULL_GROUPS });

      const stationId = `upw-${S.N0}-001`;
      const tx = opened.store.transaction("stations.create", (dbTx) =>
        stationRepo.createStation(dbTx, { stationId, kind: "upwell", npcStationId: null, typeId: 35832, structureFamily: "astrahus", systemId: S.N0, ownerFactionId: H.FACTION_B || 500019, ownerCorporationId: 2000001, name: "Sansha Station", position: { x: 0, y: 0, z: 0 }, origin: "seed", at: shared.clock.now(), initialState: "ONLINE" }, "test:station:create")
      );
      assert.ok(tx.ok, JSON.stringify(tx));

      const repo = createWorldStateRepository({ journal, clock: shared.clock, limits: LIMITS });
      opened.store.transaction("test", (db) => seedSystem(db, repo, S.N0, AMARR, { [AMARR]: 60 }));

      const stationsFacade = { getMode: () => "ready", repository: stationRepo };
      const mockCoreIndex = {
        enabled: true,
        systems: new Map([[S.N0, AMARR]]),
        stations: new Map([[stationId, AMARR]]),
        byFaction: new Map([[AMARR, { systemIds: [S.N0], stationId }]]),
        version: 1
      };

      const occ = createOccupationService({
        store: opened.store, journal, repository: repo, fleets: null, scheduler: sr.scheduler,
        graph: { getGraph: () => ({ ok: true, graph: shared.graph }) },
        getStations: () => stationsFacade, hostility: createHostility(), powerTable: buildPowerTable(STRENGTH_GROUPS),
        clock: shared.clock, config, coreIndex: mockCoreIndex
      });

      const audit = opened.store.transaction("test", (tx) => occ.auditCoresInTx(tx));
      assert.ok(audit.ok, JSON.stringify(audit));
      assert.strictEqual(audit.value.violations.length, 1, "expected 1 violation with station owned by other faction");
      assert.strictEqual(audit.value.violations[0].kind, "STATION_LOST", "violation should be STATION_LOST");
      assert.strictEqual(audit.value.violations[0].factionId, AMARR, "violation should be for Amarr");
    })
  );
};