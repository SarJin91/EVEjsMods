"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { readWormholePairsFrom } = require("../../lib/adapter/wormholePairs");
const { createAdapter } = require("../../lib/adapter");
const { findServerSrcOnDisk } = require("../../lib/adapter/locator");
const { GAME_MODULES } = require("../../lib/adapter/gameModules");
const { readStaticMapFrom } = require("../../lib/adapter/staticMap");
const { buildUniverseGraph } = require("../../lib/graph/universeGraph");
const { createRouteFinder } = require("../../lib/graph/routes");
const { startWormholes } = require("../../lib/graph/wormholes");
const { loadSecurityBand } = require("../graph/fixtures/staticMap.fixture");
const { S, rawWorld } = require("../graph/fixtures/routeMap.fixture");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const FIXTURE = path.join(MOD_DIR, "test", "graph", "fixtures", "wormholeState.v4.json");
const STATE_REL = "services/exploration/wormholes/wormholeRuntimeState";
const SRC = path.join(path.sep, "x", "server", "src");

function bodyOf(source, header) {
  const start = source.indexOf(header);
  assert.ok(start >= 0, `${header} not found`);
  const end = source.indexOf("\n}\n", start);
  assert.ok(end > start, `end of ${header} not found`);
  return source.slice(start, end);
}

function loadFixture() {
  return JSON.parse(fs.readFileSync(FIXTURE, "utf8"));
}

module.exports = ({ test }) => {
  test("WP1 vendor facts: runtime version 4, live getStateView, pair fields, expiry rule, lifecycle gate", () => {
    const found = findServerSrcOnDisk(MOD_DIR, 5, fs.existsSync);
    assert.ok(found.ok, found.reason);
    const dir = path.join(found.srcDir, "services", "exploration", "wormholes");
    const state = fs.readFileSync(path.join(dir, "wormholeRuntimeState.js"), "utf8").replace(/\r\n/g, "\n");
    assert.match(state, /\nconst WORMHOLE_RUNTIME_VERSION = 4;\n/);
    assert.match(state, /\nfunction getStateView\(\) \{\n\s+return loadState\(\);\n\}/, "getStateView = live cache");
    assert.match(state, /module\.exports = \{[^}]*\n {2}WORMHOLE_RUNTIME_VERSION,\n[^}]*\n {2}getStateView,\n/);
    assert.match(bodyOf(state, "function normalizeState("), /version: WORMHOLE_RUNTIME_VERSION,[\s\S]*pairsByID,/);
    const pair = bodyOf(state, "function normalizePair(");
    for (const field of ["pairID: toInt(pair.pairID, 0)", "state: String(pair.state || \"active\")",
      "createdAtMs: Math.max(0, toInt(pair.createdAtMs, 0))", "expiresAtMs: Math.max(0, toInt(pair.expiresAtMs, 0))",
      "collapseAtMs: Math.max(0, toInt(pair.collapseAtMs, 0))", "maxJumpMass: Math.max(0, toInt(pair.maxJumpMass, 0))",
      "source: normalizeEndpoint(pair.source || {})", "destination: normalizeEndpoint(pair.destination || {})"]) {
      assert.ok(pair.includes(field), `normalizePair: ${field}`);
    }
    const endpoint = bodyOf(state, "function normalizeEndpoint(");
    assert.ok(endpoint.includes("const systemID = toInt(endpoint.systemID, 0);") && endpoint.includes("\n    systemID,\n"),
      "normalizeEndpoint: systemID");

    const runtime = fs.readFileSync(path.join(dir, "wormholeRuntime.js"), "utf8").replace(/\r\n/g, "\n");
    assert.match(bodyOf(runtime, "function maintainPairByID("), /toInt\(current\.expiresAtMs, 0\) > 0 &&\n\s+toInt\(current\.expiresAtMs, 0\) <= nowMs/,
      "expiresAtMs === 0 = no expiry");
    const tcp = fs.readFileSync(path.join(found.srcDir, "network", "tcp", "index.js"), "utf8").replace(/\r\n/g, "\n");
    const gate = tcp.indexOf("if (config.wormholesEnabled === true) {");
    assert.ok(gate >= 0, "lifecycle gate");
    const block = tcp.slice(gate, tcp.indexOf("\n  }\n", gate));
    assert.ok(block.includes("wormholeRuntime.startLifecycleScheduler();"), "lifecycle scheduler under the flag");
  });

  test("WP2 readWormholePairs on the vanilla fixture: keys, numbers only, refusals TOO_LARGE/VERSION/DRIFT", () => {
    const view = loadFixture();
    const before = JSON.stringify(view);
    let reads = 0;
    const exportsOf = (v) => ({ WORMHOLE_RUNTIME_VERSION: 4, getStateView: () => { reads += 1; return v; } });
    const read = readWormholePairsFrom(exportsOf(view), { maxPairs: 4 });
    assert.strictEqual(read.ok, true, JSON.stringify(read));
    assert.strictEqual(read.skipped, 1, "pair 14 has destination system 0");
    assert.deepStrictEqual(read.pairs.map((p) => [p.pairKey, p.fromSystemId, p.toSystemId, p.active, p.expiresAt]), [
      ["11@1700000000000", 30000201, 30000210, true, 0],
      ["12@1700000100000", 30000205, 30000209, true, 1700018100000],
      ["13@1700000200000", 30000201, 30000208, false, 1700086600000],
    ]);
    assert.deepStrictEqual({ ...read.pairs[2] }, { pairKey: "13@1700000200000", pairId: 13, fromSystemId: 30000201,
      toSystemId: 30000208, active: false, createdAt: 1700000200000, expiresAt: 1700086600000,
      collapseAt: 1700000500000, maxJumpMass: 20000000 });
    assert.ok(Object.isFrozen(read) && Object.isFrozen(read.pairs) && read.pairs.every(Object.isFrozen));
    assert.strictEqual(JSON.stringify(view), before, "the live cache is never written");
    assert.strictEqual(reads, 1);

    assert.deepStrictEqual(readWormholePairsFrom(exportsOf(view), { maxPairs: 3 }),
      { ok: false, reason: "WORMHOLE_STATE_TOO_LARGE", detail: "4>3" });
    assert.strictEqual(readWormholePairsFrom({ ...exportsOf(view), WORMHOLE_RUNTIME_VERSION: 5 }, { maxPairs: 9 }).reason,
      "WORMHOLE_STATE_VERSION");
    assert.strictEqual(readWormholePairsFrom({ WORMHOLE_RUNTIME_VERSION: 4 }, { maxPairs: 9 }).reason,
      "WORMHOLE_STATE_DRIFT");
    assert.strictEqual(readWormholePairsFrom(exportsOf({ version: 4 }), { maxPairs: 9 }).reason, "WORMHOLE_STATE_DRIFT");

    const blind = createAdapter({ moduleApi: { _cache: {} } });
    blind.setServerSrc(SRC);
    assert.deepStrictEqual(blind.readWormholePairs({ maxPairs: 9 }),
      { ok: false, reason: "WORMHOLE_STATE_UNAVAILABLE", detail: "not_booted" });
    let current = view;
    const live = { WORMHOLE_RUNTIME_VERSION: 4, getStateView: () => current };
    const adapter = createAdapter({ moduleApi: { _cache: { [path.join(SRC, `${STATE_REL}.js`)]: { exports: live } } } });
    adapter.setServerSrc(SRC);
    assert.strictEqual(adapter.readWormholePairs({ maxPairs: 9 }).pairs.length, 3);
    current = { ...view, pairsByID: { 11: view.pairsByID["11"] } };
    assert.deepStrictEqual(adapter.readWormholePairs({ maxPairs: 9 }).pairs.map((p) => p.pairKey), ["11@1700000000000"],
      "the vendor replaces the cache object on write: read again, never kept");
  });

  test("A3 vendor wormholesEnabled: facts, empty read with vendorDisabled, GAME_MODULES entry, service closes "
    + "open transits at now with one log line and gauge 1", async () => {
    const found = findServerSrcOnDisk(MOD_DIR, 5, fs.existsSync);
    assert.ok(found.ok, found.reason);
    const world = fs.readFileSync(path.join(found.srcDir, "config", "schema", "world.js"), "utf8");
    assert.ok(world.includes("\"key\": \"wormholesEnabled\""), "schema key wormholesEnabled");
    const index = fs.readFileSync(path.join(found.srcDir, "config", "index.js"), "utf8").replace(/\r\n/g, "\n");
    assert.match(index, /module\.exports = createConfigManager\(\{/, "config/index = the config object");
    const runtime = fs.readFileSync(path.join(found.srcDir, "services", "exploration", "wormholes",
      "wormholeRuntime.js"),
      "utf8").replace(/\r\n/g, "\n");
    assert.ok(bodyOf(runtime, "function runLifecycleMaintenanceSlice(").includes("config.wormholesEnabled !== true"),
      "the vendor lifecycle stops when wormholesEnabled is not true");

    const view = loadFixture();
    const exportsOf = (v) => ({ WORMHOLE_RUNTIME_VERSION: 4, getStateView: () => v });
    const shape = (r) => [r.ok, r.pairs.length, r.vendorDisabled];
    assert.deepStrictEqual(shape(readWormholePairsFrom(exportsOf(view), { maxPairs: 9 }, { wormholesEnabled: false })),
      [true, 0, true]);
    assert.deepStrictEqual(shape(readWormholePairsFrom(exportsOf(view), { maxPairs: 9 }, {})), [true, 0, true],
      "absent = not true");
    for (const cfg of [{ wormholesEnabled: true }, null, undefined]) {
      assert.deepStrictEqual(shape(readWormholePairsFrom(exportsOf(view), { maxPairs: 9 }, cfg)), [true, 3, false],
        String(cfg && cfg.wormholesEnabled));
    }
    assert.strictEqual(readWormholePairsFrom({ WORMHOLE_RUNTIME_VERSION: 5, getStateView: () => view }, { maxPairs: 9 },
      { wormholesEnabled: false }).reason, "WORMHOLE_STATE_VERSION");
    const entry = GAME_MODULES.find((e) => e.path === "config/index");
    assert.deepStrictEqual(entry && entry.symbols.map((s) => [s.name, s.kind, [...s.consumers]]),
      [["wormholesEnabled", "property", ["wormholes"]],
        ["asteroidBeltNpcRatsEnabled", "property", ["miningEncounters"]],
        ["asteroidBeltNpcRatSpecialsEnabled", "property", ["miningEncounters"]],
        ["npcDefaultConcordGateAutoAggroNpcsEnabled", "property", ["ambientRatsHighsec"]]]);
    const vendorConfig = { wormholesEnabled: false };
    const adapter = createAdapter({ moduleApi: { _cache: {
      [path.join(SRC, `${STATE_REL}.js`)]: { exports: exportsOf(view) },
      [path.join(SRC, "config", "index.js")]: { exports: vendorConfig } } } });
    adapter.setServerSrc(SRC);
    assert.deepStrictEqual(shape(adapter.readWormholePairs({ maxPairs: 9 })), [true, 0, true]);
    vendorConfig.wormholesEnabled = true;
    assert.deepStrictEqual(shape(adapter.readWormholePairs({ maxPairs: 9 })), [true, 3, false]);

    const built = buildUniverseGraph(readStaticMapFrom({ ensureLoaded: () => rawWorld() }, loadSecurityBand()).map);
    const graph = Object.freeze({ ...built.graph, ...createRouteFinder(built.graph, { cacheSize: 8, maxJumps: 40 })
      .publicApi });
    const A = "11@1700";
    const pairs = [{ pairKey: A, pairId: 11, fromSystemId: S.N0, toSystemId: S.ISO, active: true, createdAt: 1700,
      expiresAt: 0, collapseAt: 0, maxJumpMass: 0 }];
    let disabled = false;
    const closures = [];
    const fleets = {
      listOpenWormholeTransitPairs: () => ({ ok: true, pairKeys: [A] }),
      closeWormholeTransits: (list) => {
        closures.push(...list.map((c) => ({ ...c })));
        return { ok: true, closed: list.length, enqueued: 0, deferred: 0, partial: 0, purged: 0 };
      },
    };
    const lines = [];
    const gauges = {};
    let now = 1760000000000;
    const wr = startWormholes({ config: { enabled: true, modules: { graph: { enabled: true } }, wormholes: {
      enabled: true, syncIntervalMs: 30000, minRemainingMs: 0, maxPairs: 100 } }, clock: { now: () => now },
    setTimer: () => ({ cancel() {}, hasRef: () => false }), logger: { log: (l) => lines.push(String(l)) },
    telemetry: { count() {}, observe() {}, gauge: (n, v) => { gauges[n] = v; } }, getFleets: () => fleets,
    adapter: { readWormholePairs: () => (disabled
      ? { ok: true, version: 4, skipped: 0, pairs: [], vendorDisabled: true }
      : { ok: true, version: 4, skipped: 0, pairs, vendorDisabled: false }) },
    graph: { whenReady: () => Promise.resolve({ ok: true, graph }) } });
    assert.ok(wr.ok, JSON.stringify(wr));
    for (let i = 0; i < 4; i += 1) await Promise.resolve();
    assert.strictEqual(wr.wormholes.syncNow().edges, 1);
    assert.deepStrictEqual([closures, gauges["wormholes.vendorDisabled"]], [[], 0]);
    disabled = true;
    now += 1000;
    const first = wr.wormholes.syncNow();
    now += 1000;
    wr.wormholes.syncNow();
    const isDisabledLine = (l) => l.includes("vendor wormholes disabled (wormholesEnabled=false); overlay empty");
    assert.deepStrictEqual([first.edges, first.closed, graph.listWormholeEdges().length, closures,
      gauges["wormholes.vendorDisabled"], wr.wormholes.getStatus().vendorDisabled, lines.filter(isDisabledLine).length],
    [0, 1, 0, [{ pairKey: A, closedAt: 1760000001000 }, { pairKey: A, closedAt: 1760000002000 }], 1, true, 1]);
    wr.wormholes.stop();
  });
};
