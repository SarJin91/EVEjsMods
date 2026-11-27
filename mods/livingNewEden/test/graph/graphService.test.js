"use strict";

const assert = require("node:assert");
const os = require("node:os");
const path = require("node:path");

const { MODULE_NAMES } = require("../../config");
const { startGraph } = require("../../lib/graph");
const { createServiceRegistry } = require("../../lib/runtime/services");
const { readStaticMapFrom } = require("../../lib/adapter/staticMap");
const { rawWorld, loadSecurityBand } = require("./fixtures/staticMap.fixture");
const { bfsFrom, pickSources } = require("../../lib/graph/diameter");
const { createViewRegistry } = require("../../lib/observer/views");

const BUILT_LINE = new RegExp("^graph built: 20 systems, 12 edges, \\d+(\\.\\d)?ms \\(read \\d+(\\.\\d)?ms, "
  + "build \\d+(\\.\\d)?ms\\) regions=3 constellations=5 invalidSystems=0 invalidEdges=2 oneSidedEdges=1 "
  + "namedRegions=2/3 namedConstellations=1/5( SLOW>=\\d+ms)?$");

function manualDefer() {
  const queue = [];
  return {
    queue,
    defer(fn) {
      const entry = { fn, cancelled: false };
      queue.push(entry);
      return { cancel() { entry.cancelled = true; } };
    },
    run() {
      for (const entry of queue.splice(0)) if (!entry.cancelled) entry.fn();
    },
  };
}

function fakeTelemetry() {
  const gauges = {};
  const counts = {};
  return { gauges, counts, gauge: (n, v) => { gauges[n] = v; }, count: (n) => { counts[n] = (counts[n] || 0) + 1; } };
}

const config = { graph: { buildWarnMs: 250, routeCacheSize: 16, routeMaxJumps: 40 } };

module.exports = ({ test }) => {
  test("S1 graph service: loading -> ready after defer, telemetry + log; read fails -> fail(); stop", async () => {
    const band = loadSecurityBand();
    const d = manualDefer();
    const lines = [];
    const telemetry = fakeTelemetry();
    const adapter = { readStaticMap: () => readStaticMapFrom({ ensureLoaded: () => rawWorld() }, band) };
    let t = 0;
    const started = startGraph({ config, adapter, telemetry, logger: { log: (m) => lines.push(m) },
      defer: d.defer, nowMs: () => { t += 1.5; return t; } });
    assert.strictEqual(started.ok, true);
    const service = started.graph;
    assert.strictEqual(service.getGraph().reason, "GRAPH_LOADING");
    assert.strictEqual(service.getState().state, "loading");
    d.run();
    const ready = await service.whenReady();
    assert.strictEqual(ready.ok, true);
    assert.strictEqual(service.getGraph().graph.getNeighbors(30000007).length, 2);
    assert.strictEqual(service.getState().state, "ready");
    const universe = service.getGraph().graph;
    assert.strictEqual(typeof universe.findRoute, "function");
    assert.strictEqual(universe.getGraphVersion(), 1);
    assert.strictEqual(universe.findRoute(30000001, 30000014).jumps, 12);
    assert.deepStrictEqual([...universe.getNeighbors(30000002)], [30000001, 30000003]);
    assert.strictEqual(universe.bumpGraphVersion, undefined);
    assert.ok(Object.isFrozen(universe));
    assert.strictEqual(service.getGraph().graph, universe, "one composed object per build");
    for (const name of ["graph.buildMs", "graph.readMs", "graph.systems", "graph.edges", "graph.invalidEdges"]) {
      assert.ok(Object.prototype.hasOwnProperty.call(telemetry.gauges, name), name);
    }
    assert.deepStrictEqual([telemetry.gauges["graph.systems"], telemetry.gauges["graph.edges"],
      telemetry.gauges["graph.invalidEdges"], telemetry.gauges["graph.buildMs"]], [20, 12, 2, 1.5]);
    assert.strictEqual(lines.length, 1, lines.join("\n"));
    assert.match(lines[0], BUILT_LINE);
    const summary = service.getSummary();
    assert.deepStrictEqual([summary.state, summary.systems, summary.totalMs, summary.slow], ["ready", 20, 3, false]);
    assert.ok(Object.isFrozen(summary));

    const failed = [];
    const d2 = manualDefer();
    const lines2 = [];
    const t2 = fakeTelemetry();
    const broken = startGraph({ config, telemetry: t2, logger: { log: (m) => lines2.push(m) }, defer: d2.defer,
      adapter: { readStaticMap: () => ({ ok: false, reason: "STATIC_TABLE_EMPTY", detail: "solarSystems" }) },
      fail: (reason, detail) => failed.push([reason, detail]) }).graph;
    d2.run();
    assert.deepStrictEqual(failed, [["GRAPH_LOAD_FAILED", "STATIC_TABLE_EMPTY:solarSystems"]]);
    assert.deepStrictEqual(service.getGraph().ok, true, "the first service is untouched");
    assert.deepStrictEqual(broken.getGraph(),
      { ok: false, reason: "GRAPH_LOAD_FAILED", detail: "STATIC_TABLE_EMPTY:solarSystems" });
    assert.strictEqual((await broken.whenReady()).reason, "GRAPH_LOAD_FAILED");
    assert.deepStrictEqual(lines2, ["graph failed: STATIC_TABLE_EMPTY (solarSystems)"]);
    assert.strictEqual(t2.counts["graph.buildFailures"], 1);

    const d4 = manualDefer();
    const lines4 = [];
    const noNames = { ok: false, reason: "MAP_NAMES_UNREADABLE", detail: "ENOENT" };
    const fallback = startGraph({ config, logger: { log: (m) => lines4.push(m) }, defer: d4.defer,
      adapter: { readStaticMap: () => readStaticMapFrom({ ensureLoaded: () => rawWorld() }, band,
        { mapNames: noNames }) } }).graph;
    d4.run();
    assert.strictEqual(fallback.getGraph().ok, true, "a missing names file does not fail the graph");
    assert.strictEqual(lines4[0],
      "graph: map names unavailable - MAP_NAMES_UNREADABLE (ENOENT); using station names");
    assert.match(lines4[1], BUILT_LINE);
    assert.strictEqual(lines4.length, 2);

    let reads = 0;
    const d3 = manualDefer();
    const early = startGraph({ config, logger: { log() {} }, defer: d3.defer,
      adapter: { readStaticMap: () => { reads += 1; return { ok: false, reason: "x" }; } } }).graph;
    const pending = early.whenReady();
    early.stop("test");
    for (const entry of d3.queue) entry.fn();
    assert.strictEqual(reads, 0, "a callback after stop does nothing");
    assert.strictEqual(early.getGraph().reason, "GRAPH_STOPPED");
    assert.strictEqual((await pending).reason, "GRAPH_STOPPED");
    assert.deepStrictEqual(startGraph({ config, adapter: {} }), { ok: false, reason: "adapter_unavailable" });
  });

  test("C5 diameter sample: bfsFrom chain = 12, overLimit, pickSources, summary + one line, view", async () => {
    const band = loadSecurityBand();
    const map = readStaticMapFrom({ ensureLoaded: () => rawWorld() }, band).map;
    const g = require("../../lib/graph/universeGraph").buildUniverseGraph(map).graph;
    const end = bfsFrom(g, 30000014, 10);
    assert.deepStrictEqual([end.maxDist, end.farthestId, end.reached, end.overLimit], [12, 30000001, 12, 2]);
    const sources = pickSources(g, 4);
    assert.deepStrictEqual(sources, pickSources(g, 4));
    assert.strictEqual(sources.length, 4);
    assert.ok(sources.every((id) => g.getNeighbors(id).length > 0));
    assert.deepStrictEqual(pickSources(g, 0), []);

    const d = manualDefer();
    const lines = [];
    const telemetry = fakeTelemetry();
    const views = createViewRegistry();
    const service = startGraph({ config: { graph: { ...config.graph, diameterSampleSources: 3 } }, telemetry, views,
      adapter: { readStaticMap: () => readStaticMapFrom({ ensureLoaded: () => rawWorld() }, band) },
      logger: { log: (m) => lines.push(m) }, defer: d.defer }).graph;
    for (let i = 0; i < 10 && d.queue.length > 0; i += 1) d.run();
    assert.strictEqual((await service.whenReady()).ok, true);
    const sample = service.getSummary().diameterSample;
    assert.strictEqual(sample.maxJumps, 12);
    assert.strictEqual(telemetry.gauges["graph.diameterMaxJumps"], 12);
    const sampleLines = lines.filter((l) => l.startsWith("graph diameter sample:"));
    assert.strictEqual(sampleLines.length, 1, lines.join("\n"));
    assert.match(sampleLines[0], new RegExp("^graph diameter sample: max 12 jumps \\(\\d+ -> \\d+\\) sources=\\d+ "
      + "reached=\\d+ overLimit=[\\d.]+% \\(routeMaxJumps=40\\) in [\\d.]+ms$"));
    const view = views.getView("graph");
    assert.ok(view, "graph view registered");
    assert.strictEqual(view.getData().diameterSample.maxJumps, 12);
    assert.strictEqual(view.getData().routeMaxJumps, 40);
    service.stop("test");
    assert.strictEqual(views.getView("graph"), null, "view unregistered on stop");
  });

  test("S2 graph service: modules.graph.enabled=false -> disabled_by_config, no read, GRAPH_DISABLED", () => {
    let reads = 0;
    const adapter = {
      getProbeReport: () => ({}), getDisabledModules: () => ({}),
      registerShutdownHook: () => ({ ok: true, unregister() {} }),
      readStaticMap: () => { reads += 1; return { ok: false, reason: "x" }; },
    };
    const modules = Object.fromEntries(MODULE_NAMES.map((n) => [n, { enabled: n !== "graph" }]));
    const ctx = { config: { enabled: true, dataDir: path.join(os.tmpdir(), "lne-never-written"), testing: {},
      telemetry: { intervalSeconds: 5 }, graph: { buildWarnMs: 250 }, modules }, adapter };
    const starters = {
      startTelemetry: () => ({ ok: false, reason: "disabled_by_config" }),
      startPersistence: () => ({ ok: false, reason: "disabled_by_config" }),
      startGovernor: () => ({ ok: false, reason: "telemetry_unavailable" }),
      startObserver: () => ({ ok: true, observer: { stop() {} } }),
    };
    const lines = [];
    const registry = createServiceRegistry({ logger: { log: (m) => lines.push(m), logError: (m) => lines.push(m) },
      starters, randomSeed: () => 1 });
    assert.strictEqual(registry.startAll(ctx).ok, true);
    const graph = registry.getStatus().services.find((s) => s.name === "graph");
    assert.deepStrictEqual([graph.state, graph.reason], ["disabled", "disabled_by_config"]);
    assert.ok(lines.some((l) => l.includes("graph=disabled:disabled_by_config")), lines.join("\n"));
    assert.strictEqual(reads, 0);
    assert.deepStrictEqual(ctx.graph.getGraph(), { ok: false, reason: "GRAPH_DISABLED", detail: "disabled_by_config" });
    assert.strictEqual(ctx.graph.getState().state, "disabled");
    registry.stopAll("test");
  });
};
