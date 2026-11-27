"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { findServerSrcOnDisk, GAMESTORE_SEARCH_MAX_DEPTH } = require("../../lib/adapter/locator");
const { resolveSqliteDriver } = require("../../lib/adapter/sqliteDriver");
const { openStore } = require("../../lib/persistence/store");
const { seedDbFile } = require("../_support/dbTemplate");
const { createJournal } = require("../../lib/persistence/journal");
const { createManualClock } = require("../../lib/util/clock");
const { HULL_GROUPS, FLEET_ROLES, OPERATION_TYPES } = require("../../lib/fleets/schema");
const { createHostility } = require("../../lib/battle/data/hostility");
const { REGISTRY_DATA_V1, createFactionRegistry } = require("../../lib/strategy/registry");
const { createFactionRepository } = require("../../lib/strategy/factionRepository");
const { runFactionSeed } = require("../../lib/strategy/factionSeed");
const { startStrategy } = require("../../lib/strategy");
const { selectHiveNodes } = require("../../lib/strategy/hive/nodes");
const { createHive } = require("../../lib/strategy/hive");
const { evaluateSupplyAndFronts } = require("../../lib/strategy/ai/supply");
const { stagingOf } = require("../../lib/strategy/ai/mobilize");
const { bfs } = require("../../lib/strategy/ai/bfs");
const { createRepairLocator } = require("../../lib/stations/repairLocator");
const { resolveConfig } = require("../../config");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const START_MS = 1760000000000;
const HIVE = 500025;
const HQ = 30001051;
const MALPAIS = 10000013;
const CTX = Object.freeze({ hullGroups: HULL_GROUPS, fleetRoles: FLEET_ROLES, operationTypes: OPERATION_TYPES,
  hostility: createHostility(), maxFactions: 64, maxCampaignSystems: 40, maxShipsPerFleet: 500,
  maxCompositionEntries: 32, maxResourceUnits: 1000000000 });

function registryOf(extra) {
  const r = createFactionRegistry(REGISTRY_DATA_V1, { ...CTX, ...extra });
  assert.ok(r.ok, JSON.stringify(r));
  return r.registry;
}

function loadDriver() {
  const found = findServerSrcOnDisk(MOD_DIR, GAMESTORE_SEARCH_MAX_DEPTH, fs.existsSync);
  if (!found.ok) return { ok: false, detail: found.reason };
  return resolveSqliteDriver(found.srcDir);
}

function withStore(driver, fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lne-hive-"));
  const file = path.join(tmp, "world.sqlite");
  seedDbFile(driver, file, { seed: 1 });
  const opened = openStore({ filePath: file, openDatabase: (f) => new driver.Database(f), exclusiveLock: true,
    busyTimeoutMs: 0, maxRowsPerTransaction: 500, maxWriteMsPerPass: 5, randomSeed: () => 1 });
  assert.ok(opened.ok, JSON.stringify(opened));
  try {
    return fn(opened.store);
  } finally {
    opened.store.close("test_cleanup");
    try {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch (_err) {
    }
  }
}

function graphOf(edges, regions) {
  const nb = new Map();
  const add = (a, b) => {
    if (!nb.has(a)) nb.set(a, []);
    nb.get(a).push(b);
  };
  for (const [a, b] of edges) {
    add(a, b);
    add(b, a);
  }
  for (const ids of Object.values(regions)) for (const id of ids) if (!nb.has(id)) nb.set(id, []);
  return { getNeighbors: (id) => (nb.has(id) ? [...nb.get(id)].sort((x, y) => x - y) : null),
    getSystemsInRegion: (r) => regions[r] || [] };
}

const LINE_EDGES = [[101, 102], [102, 103], [103, 104], [104, 105], [105, 106], [106, 201], [201, 202], [202, 203]];
const LINE_REGIONS = { 1: [101, 102, 103, 104, 105, 106], 2: [201, 202, 203], 3: [301] };

module.exports = ({ test, skip }) => {
  const driver = loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  test("HV1 gate: no flag 14 active (SoE), hive flag 15, explicit list with 500025 without the flag "
    + "refused; startStrategy hive.enabled 15 + facade, default 14 + stub", () => {
    const off = registryOf({});
    const on = registryOf({ enabledFlags: ["hive"] });
    assert.deepStrictEqual([off.listActiveFactions().length, off.isActive(HIVE), on.listActiveFactions().length,
      on.isActive(HIVE)], [14, false, 15, true]);
    assert.deepStrictEqual(createFactionRegistry(REGISTRY_DATA_V1, { ...CTX, activeFactionIds: [500003, HIVE] }),
      { ok: false, reason: "REGISTRY_INVALID", detail: "ctx.activeFactionIds[1]" });
    assert.ok(createFactionRegistry(REGISTRY_DATA_V1, { ...CTX, enabledFlags: ["hive"],
      activeFactionIds: [500003, HIVE] }).ok);
    assert.deepStrictEqual(createFactionRegistry(REGISTRY_DATA_V1, { ...CTX, enabledFlags: ["x"] }),
      { ok: false, reason: "REGISTRY_INVALID", detail: "ctx.enabledFlags" });

    const configOf = (env) => {
      const r = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_DATA_ROOT: os.tmpdir(), ...env } });
      assert.deepStrictEqual(r.warnings, []);
      return r.config;
    };
    const clock = createManualClock(START_MS);
    const journal = createJournal({ clock, maxPayloadBytes: 4096, maxRows: 500 });
    const start = (env) => startStrategy({ config: configOf(env), persistence: { ok: true, store: {}, journal },
      clock });
    const def = start({});
    const hive = start({ EVEJS_LNE_HIVE_ENABLED: "1" });
    assert.ok(def.ok && hive.ok, JSON.stringify([def, hive]));
    assert.deepStrictEqual([def.strategy.registry.listActiveFactions().length, def.strategy.hive.enabled,
      def.strategy.hive.isHive(HIVE), hive.strategy.registry.listActiveFactions().length, hive.strategy.hive.enabled,
      hive.strategy.hive.isHive(HIVE), hive.strategy.hive.isHive(500003)], [14, false, false, 15, true, true, false]);
    assert.deepStrictEqual(start({ EVEJS_LNE_STRATEGY_ACTIVE_FACTIONS: "500003,500025" }),
      { ok: false, reason: "STRATEGY_ACTIVE_FACTIONS_INVALID", detail: "500025" });
    def.strategy.stop("test");
    hive.strategy.stop("test");
  });

  needsDriver("HV1b seed: runFactionSeed with the hive flag creates the 500025 row once (restart -> "
    + "existing), without the flag no row", () => withStore(driver, (store) => {
    const clock = createManualClock(START_MS);
    const journal = createJournal({ clock, maxPayloadBytes: 4096, maxRows: 500 });
    const repository = createFactionRepository({ journal,
      limits: { maxResourceUnits: 1000000000, maxFrontLimit: 16, maxListLimit: 64 } });
    const seed = (registry) => runFactionSeed({ store, repository, registry, clock, settings: { budgetFactor: 1,
      maxResourceUnits: 1000000000, maxActiveFrontsPerFaction: 16, maxRowsPerTransaction: 500,
      registryVersion: registry.version.factions } });
    const row = () => store.transaction("t", (db) => db.prepare(
      "SELECT home_system_id AS home, doctrine_id AS d, resource_units AS r, front_limit AS fl FROM world_factions "
        + "WHERE faction_id = ?").get(HIVE)).value;
    const off = seed(registryOf({}));
    assert.deepStrictEqual([off.ok, off.created, row()], [true, 14, undefined]);
    const first = seed(registryOf({ enabledFlags: ["hive"] }));
    const again = seed(registryOf({ enabledFlags: ["hive"] }));
    assert.deepStrictEqual([first.created, first.existing, again.created, again.existing, again.failed],
      [1, 14, 0, 15, 0]);
    assert.deepStrictEqual({ ...row() }, { home: HQ, d: "rogue-hive-v1", r: 20000, fl: 3 });
  }));

  test("HV2 selectHiveNodes: HQ first, farthest-first, perRegion, region without gates empty "
    + "deterministic for any input order", () => {
    const g = graphOf(LINE_EDGES, LINE_REGIONS);
    const input = (extra) => ({ regionIds: [3, 2, 1], hqSystemId: 103, perRegion: 2,
      systemsInRegion: (r) => g.getSystemsInRegion(r), neighbors: (id) => g.getNeighbors(id), ...extra });
    const two = selectHiveNodes(input({}));
    assert.deepStrictEqual(two, { nodes: [103, 106, 201, 203], homeSystems: 10 });
    const shuffled = selectHiveNodes(input({ regionIds: [1, 3, 2, 1],
      systemsInRegion: (r) => [...g.getSystemsInRegion(r)].reverse() }));
    assert.deepStrictEqual(shuffled, two);
    assert.deepStrictEqual(selectHiveNodes(input({ perRegion: 1 })).nodes, [103, 201]);
    assert.deepStrictEqual(selectHiveNodes(input({ hqSystemId: 999, perRegion: 1 })).nodes, [102, 201]);
    assert.deepStrictEqual(selectHiveNodes(input({ perRegion: 9 })).nodes,
      [101, 102, 103, 104, 105, 106, 201, 202, 203]);
    assert.deepStrictEqual(selectHiveNodes(null), { nodes: [], homeSystems: 0 });
    assert.deepStrictEqual(selectHiveNodes(input({ neighbors: () => { throw new Error("x"); } })),
      { nodes: [103], homeSystems: 10 });
  });

  test("HV3 listNodesInTx: active nodes = controller 500025, a lost node drops out, another faction "
    + "without a read, graph not ready -> empty and not cached, disabled stub", () => {
    const registry = registryOf({ enabledFlags: ["hive"] });
    const g = graphOf([[HQ, 1001], [1001, 1002], [1002, 1003]], { [MALPAIS]: [HQ, 1001, 1002, 1003] });
    let graphReady = false;
    const controllers = new Map([[HQ, HIVE], [1001, HIVE], [1002, HIVE], [1003, HIVE]]);
    const reads = [];
    const repo = { limits: { maxBatchReadIds: 1 }, getSystems: (tx, ids, opts) => {
      reads.push([tx, ids, opts.includeInfluence]);
      return { ok: true, systems: ids.map((systemId) => ({ systemId, controllerFactionId: controllers.get(systemId) })),
        missing: [] };
    } };
    const lines = [];
    const hive = createHive({ registry, getGraph: () => (graphReady ? g : null), getWorldRepository: () => repo,
      settings: { enabled: true, nodesPerRegion: 2, nodeCaptureRangeJumps: 10 }, logger: { log: (l) => lines.push(l) } });
    assert.deepStrictEqual([hive.listNodesInTx("tx", HIVE), hive.homeSystemCount(), reads.length],
      [{ ok: true, footholds: [] }, 0, 0]);
    graphReady = true;
    assert.deepStrictEqual(hive.listNodesInTx("tx", HIVE), { ok: true, footholds: [{ systemId: 1003, jumps: 10 },
      { systemId: HQ, jumps: 10 }].sort((a, b) => a.systemId - b.systemId) });
    assert.deepStrictEqual(reads, [["tx", [1003], false], ["tx", [HQ], false]]);
    assert.deepStrictEqual([hive.homeSystemCount(), lines],
      [4, [`strategy: hive ${HIVE} nodes=2 homeSystems=4 uncovered=0 rangeJumps=10`]]);
    controllers.set(1003, 500003);
    assert.deepStrictEqual(hive.listNodesInTx("tx", HIVE), { ok: true, footholds: [{ systemId: HQ, jumps: 10 }] });
    assert.deepStrictEqual([...hive.repairNodesOf("tx", HIVE).systems], [HQ]);
    const before = reads.length;
    assert.deepStrictEqual([hive.listNodesInTx("tx", 500003), [...hive.repairNodesOf("tx", 500003).systems],
      reads.length - before, lines.length], [{ ok: true, footholds: [] }, [], 0, 1]);
    const failing = createHive({ registry, getGraph: () => g, getWorldRepository: () => ({ getSystems: () =>
      ({ ok: false, reason: "TX_REQUIRED" }) }), settings: { enabled: true, nodesPerRegion: 1,
      nodeCaptureRangeJumps: 3 } });
    assert.deepStrictEqual(failing.listNodesInTx("tx", HIVE), { ok: false, reason: "TX_REQUIRED" });
    for (const stub of [createHive({ registry, getGraph: () => g, getWorldRepository: () => repo,
      settings: { enabled: false } }), createHive({ registry: registryOf({}), getGraph: () => g,
      getWorldRepository: () => repo, settings: { enabled: true, nodesPerRegion: 1, nodeCaptureRangeJumps: 1 } })]) {
      assert.deepStrictEqual([stub.enabled, stub.isHive(HIVE), stub.listNodesInTx("tx", HIVE), stub.homeSystemCount()],
        [false, false, { ok: true, footholds: [] }, 0]);
    }
  });

  test("HV4 reach: hive doctrine -> chain 0 (anchors = nodes + HQ), captureReach from the nodes "
    + "footholdSystems in the report; stagingOf picks the nearest node, never the HQ", () => {
    const f = HIVE;
    const ids = Array.from({ length: 20 }, (_, i) => i + 1);
    const neighbors = (id) => (id < 1 || id > 20 ? null : [id - 1, id + 1].filter((x) => x >= 1 && x <= 20));
    const snapshot = (hive) => ({ factionId: f, at: START_MS, stationsMode: "ready", stations: [], captureAnchors: [],
      systems: ids.map((systemId) => ({ systemId, controllerFactionId: f })),
      faction: { homeSystemId: 1, frontLimit: 3, status: "ACTIVE", resourceUnits: 0, reserveUnits: 0 },
      entry: { maxActiveFronts: 3 }, footholds: [{ systemId: 10, jumps: 2 }, { systemId: 18, jumps: 2 }],
      neighbors, doctrine: { reachJumps: 1, capturesStations: false, hive }, operations: [], occupations: [],
      capturedIds: [] });
    const params = { maxBfsSystems: 100, supplyChainJumps: 3, maxReachJumps: 10, routeMaxJumps: 40,
      captureRangeFromStationJumps: 5, kinds: [], claimFrontGraceMs: 0, frontLimitCap: 16 };
    const hive = evaluateSupplyAndFronts(snapshot(true), params);
    const other = evaluateSupplyAndFronts(snapshot(false), params);
    assert.deepStrictEqual([hive.anchors, hive.footholdSystems, [...hive.captureReach.keys()].sort((a, b) => a - b)],
      [[1, 10, 18], [10, 18], [8, 9, 10, 11, 12, 16, 17, 18, 19, 20]]);
    assert.deepStrictEqual(other.anchors, [1, 2, 3, 4, 7, 8, 9, 10, 11, 12, 13, 15, 16, 17, 18, 19, 20]);
    const distT = (t) => bfs([t], neighbors, { maxJumps: 40, maxSystems: 100 });
    const snap = snapshot(true);
    assert.deepStrictEqual([stagingOf(snap, hive, distT(15), 15), stagingOf(snap, hive, distT(18), 18),
      stagingOf(snap, { ...hive, footholdSystems: [] }, distT(5), 5)], [18, 10, null]);
    assert.strictEqual(stagingOf(snapshot(false), { ...other, stationSystems: [] }, distT(5), 5), 1);
  });

  test("HV5 refit: repairNodesOf -> hasRepairStation hive-node id and findNearestStations reach the node "
    + "without it stations only; the hive module loads nothing outside lib/strategy (no new seam)", () => {
    const stations = [{ stationId: "s1", systemId: 2, ownerFactionId: 500003, state: "ONLINE" }];
    const repository = {
      listStationsOfFaction: (tx, factionId) => ({ ok: true,
        records: stations.filter((s) => s.ownerFactionId === factionId) }),
      listStationsInSystem: (tx, systemId) => ({ ok: true, records: stations.filter((s) => s.systemId === systemId) }),
    };
    const g = graphOf([[1, 2], [2, 3], [3, 4], [4, 5]], { 1: [1, 2, 3, 4, 5] });
    const limits = { repairSearchMaxJumps: 10, repairSearchMaxSystems: 100, repairMaxCandidates: 4 };
    const nodeCalls = [];
    const repairNodesOf = (tx, factionId) => {
      nodeCalls.push(factionId);
      return { ok: true, systems: new Set(factionId === HIVE ? [5] : []) };
    };
    const with_ = createRepairLocator({ repository, getGraph: () => g, getMode: () => "ready", limits, repairNodesOf });
    const without = createRepairLocator({ repository, getGraph: () => g, getMode: () => "ready", limits });
    assert.deepStrictEqual([with_.hasRepairStation("tx", HIVE, 5), with_.hasRepairStation("tx", HIVE, 4),
      with_.findNearestStations("tx", { factionId: HIVE, fromSystemId: 1 }),
      with_.hasRepairStation("tx", 500003, 2), with_.findNearestStations("tx", { factionId: 500003, fromSystemId: 1 })],
    [{ ok: true, stationId: "hive-node:5" }, { ok: true, stationId: null }, { ok: true, targets: [5], visited: 4 },
      { ok: true, stationId: "s1" }, { ok: true, targets: [2], visited: 4 }]);
    assert.deepStrictEqual([without.hasRepairStation("tx", HIVE, 5),
      without.findNearestStations("tx", { factionId: HIVE, fromSystemId: 1 })],
    [{ ok: true, stationId: null }, { ok: true, targets: [], visited: 0 }]);
    const failing = createRepairLocator({ repository, getGraph: () => g, getMode: () => "ready", limits,
      repairNodesOf: () => ({ ok: false, reason: "TX_REQUIRED" }) });
    assert.deepStrictEqual(failing.hasRepairStation("tx", HIVE, 4), { ok: false, reason: "TX_REQUIRED" });

    const hiveDir = path.join(MOD_DIR, "lib", "strategy");
    const owned = Object.keys(require.cache).filter((k) => k.startsWith(path.join(hiveDir, "hive"))
      || k === path.join(hiveDir, "ai", "bfs.js"));
    for (const k of owned) delete require.cache[k];
    const before = new Set(Object.keys(require.cache));
    require("../../lib/strategy/hive");
    const loaded = Object.keys(require.cache).filter((k) => !before.has(k));
    assert.deepStrictEqual(loaded.filter((k) => !k.startsWith(hiveDir)), []);
    assert.ok(loaded.length >= 2, loaded.join(","));
  });
};
