"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const Module = require("node:module");
const { performance } = require("node:perf_hooks");

const { buildUniverseGraph, SEC_CLASSES } = require("../../lib/graph/universeGraph");
const { createRouteFinder } = require("../../lib/graph/routes");
const { readStaticMapFrom } = require("../../lib/adapter/staticMap");
const { findServerSrcOnDisk } = require("../../lib/adapter/locator");
const { createRng } = require("../../lib/util/rng");
const { loadSecurityBand } = require("./fixtures/staticMap.fixture");
const { R1, S, rawWorld } = require("./fixtures/routeMap.fixture");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const RANGE_REGION = 32767;

function fixtureGraph() {
  const read = readStaticMapFrom({ ensureLoaded: () => rawWorld() }, loadSecurityBand());
  assert.strictEqual(read.ok, true, JSON.stringify(read));
  const built = buildUniverseGraph(read.map);
  assert.strictEqual(built.ok, true);
  return built.graph;
}

function finderOn(graph, extra = {}) {
  return createRouteFinder(graph, { cacheSize: 64, maxJumps: 40, ...extra });
}

function fakeTelemetry() {
  const counts = {};
  const gauges = {};
  const observed = [];
  return { counts, gauges, observed,
    count: (n, v = 1) => { counts[n] = (counts[n] || 0) + v; },
    gauge: (n, v) => { gauges[n] = v; },
    observe: (n, v) => observed.push([n, v]) };
}

function syntheticMap(cols, rows, extra, seed) {
  const classes = ["highsec", "lowsec", "nullsec"];
  const idAt = (c, r) => 30000001 + r * cols + c;
  const systems = [];
  const gates = [];
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const id = idAt(c, r);
      systems.push({ id, name: `G${id}`, regionId: 10000001 + Math.floor(c / 10), constellationId: 20000001,
        security: 0, trueSecurity: 0, secClass: classes[c % classes.length], factionId: 0 });
      if (c + 1 < cols) gates.push({ fromSystemId: id, toSystemId: idAt(c + 1, r) });
      if (r + 1 < rows) gates.push({ fromSystemId: id, toSystemId: idAt(c, r + 1) });
    }
  }
  const rng = createRng(seed);
  for (let i = 0; i < extra; i += 1) {
    gates.push({ fromSystemId: idAt(rng.nextInt(0, cols - 1), rng.nextInt(0, rows - 1)),
      toSystemId: idAt(rng.nextInt(0, cols - 1), rng.nextInt(0, rows - 1)) });
  }
  return { systems, gates };
}

module.exports = ({ test, bench }) => {
  test("R1 findRoute: BFS, constraints, start exempt, refusals, Dijkstra weights, validateRoute", () => {
    const f = finderOn(fixtureGraph());
    const r = f.findRoute(S.N0, S.N9);
    assert.deepStrictEqual([[...r.route], r.jumps, r.cost, r.graphVersion, r.ok], [[S.N0, S.H1, S.N9], 2, 2, 1, true]);
    assert.ok(Object.isFrozen(r) && Object.isFrozen(r.route));
    assert.deepStrictEqual([...f.findRoute(S.N0, S.N9, { avoidSecClasses: ["highsec"] }).route],
      [S.N0, S.L1, S.L2, S.N9]);
    assert.deepStrictEqual([...f.findRoute(S.N0, S.N9, { avoidSecClasses: ["highsec"], forbiddenSystems: [S.L1] })
      .route], [S.N0, S.N5, S.N6, S.N7, S.N9]);
    const regions = f.findRoute(S.N0, S.N9, { avoidSecClasses: ["highsec"], forbiddenSystems: [S.L1],
      allowedRegions: [R1] });
    assert.deepStrictEqual([regions.ok, regions.reason, regions.detail], [false, "UNREACHABLE", "NO_PATH"]);
    const far = f.findRoute(S.N0, S.N9, { maxJumps: 1 });
    assert.deepStrictEqual([far.ok, far.reason, far.jumps], [false, "TOO_FAR", 2]);
    assert.strictEqual(f.findRoute(S.N0, S.ISO).reason, "UNREACHABLE");
    assert.deepStrictEqual([f.findRoute(S.N0, 99999999).reason, f.findRoute(S.N0, 99999999).detail],
      ["UNKNOWN_SYSTEM", "to"]);
    assert.strictEqual(f.findRoute(99999999, S.N0).detail, "from");
    for (const bad of [{ avoidSecClass: ["highsec"] }, { avoidSecClasses: ["hisec"] }, { allowedRegions: [] },
      { maxJumps: -1 }, { maxJumps: 1.5 }, { forbiddenSystems: [1.5] }, { secClassCost: { highsec: -1 } },
      { secClassCost: { highsec: Infinity } }, "x"]) {
      assert.strictEqual(f.findRoute(S.N0, S.N9, bad).reason, "INVALID_CONSTRAINTS", JSON.stringify(bad));
    }
    assert.strictEqual(f.findRoute(S.N0, S.N9, { avoidSecClass: [] }).detail, "avoidSecClass");
    const excluded = f.findRoute(S.N0, S.H1, { avoidSecClasses: ["highsec"] });
    assert.deepStrictEqual([excluded.reason, excluded.detail], ["UNREACHABLE", "DESTINATION_EXCLUDED"]);
    const fromHigh = f.findRoute(S.H1, S.N9, { avoidSecClasses: ["highsec"] });
    assert.deepStrictEqual([fromHigh.ok, [...fromHigh.route]], [true, [S.H1, S.N9]], "start system exempt");
    const self = f.findRoute(S.N0, S.N0);
    assert.deepStrictEqual([[...self.route], self.jumps, self.cost], [[S.N0], 0, 0]);
    const weighted = f.findRoute(S.N0, S.N9, { secClassCost: { highsec: 10 } });
    assert.deepStrictEqual([[...weighted.route], weighted.jumps, weighted.cost], [[S.N0, S.L1, S.L2, S.N9], 3, 3]);
    assert.strictEqual(f.findRoute(S.N0, S.N9, { secClassCost: {} }).cost, 2);
    assert.deepStrictEqual(f.validateRoute([S.N0, S.H1, S.N9]), { ok: true });
    assert.deepStrictEqual(f.validateRoute([S.N0, S.N9]), { ok: false, reason: "BROKEN_EDGE", at: 0 });
    assert.deepStrictEqual(f.validateRoute([S.N0, 99999999]), { ok: false, reason: "UNKNOWN_SYSTEM", at: 1 });
    assert.deepStrictEqual(f.validateRoute([]), { ok: false, reason: "INVALID_ARGUMENT" });
    assert.deepStrictEqual(f.validateRoute("x"), { ok: false, reason: "INVALID_ARGUMENT" });
    assert.strictEqual(f.validateRoute([S.L2, S.N9]).ok, true, "one-sided gate is an edge both ways");
  });

  test("R2 route cache: same object on hit, invalidate by system, graphVersion bump, LRU eviction, off", () => {
    const graph = fixtureGraph();
    const telemetry = fakeTelemetry();
    let t = 0;
    const f = finderOn(graph, { telemetry, nowMs: () => { t += 0.5; return t; } });
    const avoid = f.findRoute(S.N0, S.N9, { avoidSecClasses: ["lowsec", "highsec"], forbiddenSystems: [S.N7, S.N6] });
    const again = f.findRoute(S.N0, S.N9,
      { forbiddenSystems: [S.N6, S.N7, S.N6], avoidSecClasses: ["highsec", "lowsec"] });
    assert.strictEqual(again, avoid);
    assert.strictEqual(f.getRouteStats().hits, 1);
    const viaL1 = f.findRoute(S.N0, S.N9, { avoidSecClasses: ["highsec"] });
    const viaH1 = f.findRoute(S.N0, S.N9);
    assert.deepStrictEqual(f.invalidateRouteCache([S.L1]), { ok: true, removed: 1 });
    assert.strictEqual(f.getRouteStats().invalidated, 1);
    const missesBefore = f.getRouteStats().misses;
    assert.notStrictEqual(f.findRoute(S.N0, S.N9, { avoidSecClasses: ["highsec"] }), viaL1);
    assert.strictEqual(f.getRouteStats().misses, missesBefore + 1);
    assert.strictEqual(f.findRoute(S.N0, S.N9), viaH1, "route through H1 stays cached");
    assert.deepStrictEqual(f.invalidateRouteCache([]), { ok: true, removed: 0 });
    assert.deepStrictEqual(f.invalidateRouteCache(5), { ok: false, reason: "INVALID_ARGUMENT" });
    assert.deepStrictEqual(f.invalidateRouteCache(new Set([S.N10])), { ok: true, removed: 0 });

    assert.strictEqual(f.bumpGraphVersion(), 2);
    assert.strictEqual(f.getRouteStats().size, 0);
    assert.strictEqual(f.findRoute(S.N0, S.N9).graphVersion, 2);
    assert.strictEqual(f.getGraphVersion(), 2);
    assert.strictEqual(f.publicApi.bumpGraphVersion, undefined, "bump is not public");
    assert.ok(Object.isFrozen(f.publicApi));

    const before = f.getRouteStats();
    assert.deepStrictEqual(f.updateWormholeEdge("x", {}), { ok: false, reason: "INVALID_ARGUMENT", detail: "state" });
    assert.deepStrictEqual(f.updateWormholeEdge(1, null), { ok: false, reason: "INVALID_ARGUMENT" });
    assert.deepStrictEqual([f.getGraphVersion(), f.getRouteStats().size, f.getWormholeVersion()],
      [before.graphVersion, before.size, 0]);

    for (const name of ["graph.routeQueries", "graph.routeCacheHits", "graph.routeCacheMisses",
      "graph.routeInvalidations"]) assert.ok(telemetry.counts[name] > 0, name);
    assert.strictEqual(telemetry.gauges["graph.version"], 2);
    assert.ok(telemetry.observed.every(([n, v]) => n === "graph.routeSearchMs" && v === 0.5));

    const small = finderOn(graph, { cacheSize: 2 });
    small.findRoute(S.N0, S.N9);
    small.findRoute(S.N0, S.N10);
    small.findRoute(S.N0, S.L2);
    assert.deepStrictEqual([small.getRouteStats().evictions, small.getRouteStats().size], [1, 2]);
    const m = small.getRouteStats().misses;
    small.findRoute(S.N0, S.N9);
    assert.strictEqual(small.getRouteStats().misses, m + 1, "oldest entry was evicted");

    const off = finderOn(graph, { cacheSize: 0 });
    off.findRoute(S.N0, S.N9);
    off.findRoute(S.N0, S.N9);
    assert.deepStrictEqual([off.getRouteStats().size, off.getRouteStats().hits, off.getRouteStats().misses], [0, 0, 2]);
  });

  test("R3 vendor parity: findRoute jumps == marketTopology.getJumpCount on all 100 fixture pairs", () => {
    const found = findServerSrcOnDisk(MOD_DIR, 5, fs.existsSync);
    assert.ok(found.ok, found.reason);
    const topologyFile = path.join(found.srcDir, "services", "market", "marketTopology.js");
    const worldDataFile = path.join(found.srcDir, "space", "worldData.js");
    const source = fs.readFileSync(topologyFile, "utf8");
    assert.strictEqual((source.match(/require\(/g) || []).length, 2, "marketTopology.js pulls only path + worldData");
    const raw = rawWorld();
    const previousWorld = require.cache[worldDataFile];
    const previousTopology = require.cache[topologyFile];
    let topology;
    try {
      const fake = new Module(worldDataFile);
      fake.filename = worldDataFile;
      fake.loaded = true;
      fake.exports = { getSolarSystems: () => raw.solarSystems,
        getStargatesForSystem: (id) => raw.stargates.filter((g) => g.solarSystemID === id) };
      require.cache[worldDataFile] = fake;
      delete require.cache[topologyFile];
      topology = require(topologyFile);
      const f = finderOn(fixtureGraph(), { cacheSize: 0 });
      const ids = raw.solarSystems.map((s) => s.solarSystemID);
      let pairs = 0;
      for (const a of ids) {
        for (const b of ids) {
          const route = f.findRoute(a, b);
          const vendor = topology.getJumpCount(a, b);
          if (vendor === RANGE_REGION) assert.strictEqual(route.reason, "UNREACHABLE", `${a}->${b}`);
          else assert.strictEqual(route.jumps, vendor, `${a}->${b}`);
          pairs += 1;
        }
      }
      assert.strictEqual(pairs, 100);
    } finally {
      delete require.cache[topologyFile];
      if (previousTopology) require.cache[topologyFile] = previousTopology;
      delete require.cache[worldDataFile];
      if (previousWorld) require.cache[worldDataFile] = previousWorld;
    }
  });

  bench("R4 micro-benchmark (informational): 1000 routes on a synthetic 8000-node graph", () => {
    const built = buildUniverseGraph(syntheticMap(80, 100, 500, 20261016));
    assert.strictEqual(built.ok, true);
    assert.strictEqual(built.stats.systems, 8000);
    const t0 = performance.now();
    const uncached = createRouteFinder(built.graph, { cacheSize: 0, maxJumps: 1000 });
    const t1 = performance.now();
    const ids = built.graph.getSystemIds();
    const rng = createRng(42);
    const pairs = Array.from({ length: 1000 }, () => [ids[rng.nextInt(0, ids.length - 1)],
      ids[rng.nextInt(0, ids.length - 1)]]);
    const okOrUnreachable = (r) => r.ok === true || r.reason === "UNREACHABLE";
    for (const [a, b] of pairs) assert.ok(okOrUnreachable(uncached.findRoute(a, b)));
    const t2 = performance.now();
    const weights = { secClassCost: { highsec: 0.5, nullsec: 2 } };
    for (const [a, b] of pairs) assert.ok(okOrUnreachable(uncached.findRoute(a, b, weights)));
    const t3 = performance.now();
    const cached = createRouteFinder(built.graph, { cacheSize: 2000, maxJumps: 1000 });
    for (const [a, b] of pairs) cached.findRoute(a, b);
    const hitsBefore = cached.getRouteStats().hits;
    const t4 = performance.now();
    for (const [a, b] of pairs) cached.findRoute(a, b);
    const t5 = performance.now();
    assert.strictEqual(cached.getRouteStats().hits - hitsBefore, 1000);
    const ms = (x) => (Math.round(x * 10) / 10).toFixed(1);
    console.log(`R4 bench: build index ${ms(t1 - t0)}ms, bfs 1000 ${ms(t2 - t1)}ms, dijkstra 1000 ${ms(t3 - t2)}ms, `
      + `cached 1000 ${ms(t5 - t4)}ms`);
  });

  test("R5 leftovers: SEC_CLASSES graph == adapter, probe consumers of graph", () => {
    assert.deepStrictEqual(SEC_CLASSES, require("../../lib/adapter/staticMapData").SEC_CLASSES);
    const { GAME_MODULES } = require("../../lib/adapter/gameModules");
    const graphSymbols = [];
    for (const mod of GAME_MODULES) {
      for (const s of mod.symbols) if (s.consumers.includes("graph")) graphSymbols.push(`${mod.path}.${s.name}`);
    }
    assert.deepStrictEqual(graphSymbols.sort(), ["space/runtime/systemSecurityBand.getSolarSystemPseudoSecurity",
      "space/runtime/systemSecurityBand.getSystemSecurityClass", "space/worldData.ensureLoaded"]);
  });

  test("R6 wormhole overlay: only on request, gate cache kept on open, closed edge never in a new route", () => {
    const telemetry = fakeTelemetry();
    const f = finderOn(fixtureGraph(), { telemetry });
    const gate = f.findRoute(S.N0, S.N9);
    const noWay = f.findRoute(S.N0, S.ISO);
    assert.strictEqual(noWay.reason, "UNREACHABLE");
    const open = { fromSystemId: S.N0, toSystemId: S.ISO, status: "open", expiresAtMs: 0 };
    assert.deepStrictEqual(f.updateWormholeEdge("11@1", open), { ok: true, changed: true, wormholeVersion: 1 });
    assert.deepStrictEqual(f.updateWormholeEdge("11@1", open), { ok: true, changed: false, wormholeVersion: 1 });
    assert.strictEqual(f.findRoute(S.N0, S.N9), gate);
    assert.strictEqual(f.findRoute(S.N0, S.ISO), noWay);
    assert.strictEqual(f.findRoute(S.N0, S.ISO, { wormholes: false }), noWay, "false = absent: same key and cache");
    assert.deepStrictEqual(Object.keys(gate), ["ok", "route", "jumps", "cost", "graphVersion"], "Shape");
    assert.strictEqual(f.getGraphVersion(), 1, "graphVersion = gate graph");

    const wh = f.findRoute(S.N0, S.ISO, { wormholes: true });
    assert.deepStrictEqual([[...wh.route], wh.jumps, wh.graphVersion, wh.wormholeVersion,
      wh.wormholeEdges.map((e) => ({ ...e }))], [[S.N0, S.ISO], 1, 1, 1, [{ i: 0, pairKey: "11@1", expiresAt: 0,
      createdAt: 0 }]]);
    assert.strictEqual(f.findRoute(S.N0, S.ISO, { wormholes: true }), wh, "own cache hit");
    const weighted = f.findRoute(S.N0, S.ISO, { wormholes: true, secClassCost: { lowsec: 1 } });
    assert.deepStrictEqual([[...weighted.route], weighted.cost], [[S.N0, S.ISO], 2], "Dijkstra reads the overlay");
    assert.strictEqual(f.findRoute(S.H1, S.ISO).reason, "UNREACHABLE", "a fresh gate search ignores the built overlay");
    assert.strictEqual(f.findRoute(S.H1, S.ISO, { secClassCost: { lowsec: 1 } }).reason, "UNREACHABLE");
    assert.deepStrictEqual([f.getRouteStats().whCacheSize, f.getRouteStats().wormholeEdges], [2, 1]);

    assert.deepStrictEqual(f.updateWormholeEdge("11@1", { ...open, status: "closed" }),
      { ok: true, changed: true, wormholeVersion: 1 });
    assert.strictEqual(f.getRouteStats().whCacheSize, 0, "routes through the closed pair dropped");
    assert.strictEqual(f.findRoute(S.N0, S.ISO, { wormholes: true }).reason, "UNREACHABLE");
    assert.strictEqual(f.validateRoute([S.N0, S.ISO]).reason, "BROKEN_EDGE");
    assert.strictEqual(f.findRoute(S.N0, S.N9), gate);
    assert.deepStrictEqual(f.updateWormholeEdge("11@1", { ...open, status: "closed" }),
      { ok: true, changed: false, wormholeVersion: 1 }, "unknown pair");
    assert.strictEqual(f.updateWormholeEdge("s@1", { ...open, toSystemId: S.N0 }).reason, "SAME_SYSTEM");
    assert.strictEqual(f.updateWormholeEdge("u@1", { ...open, toSystemId: 30009999 }).reason, "UNKNOWN_SYSTEM");
    assert.strictEqual(f.findRoute(S.N0, S.ISO, { wormholes: "yes" }).reason, "INVALID_CONSTRAINTS");
    assert.deepStrictEqual([telemetry.gauges["graph.wormholeEdges"], telemetry.gauges["graph.wormholeVersion"]], [0, 1]);
  });

  test("R7 wormholeEdges: gate edges skipped, latest expiry wins (0 best, tie -> smaller key), validateRoute", () => {
    const f = finderOn(fixtureGraph());
    const edge = (fromSystemId, toSystemId, expiresAtMs) => ({ fromSystemId, toSystemId, status: "open", expiresAtMs });
    assert.strictEqual(f.updateWormholeEdge("b@2", edge(S.N0, S.ISO, 9000)).ok, true);
    assert.strictEqual(f.updateWormholeEdge("a@1", edge(S.ISO, S.N0, 5000)).ok, true, "same ends, other way");
    const mixed = f.findRoute(S.N9, S.ISO, { wormholes: true });
    assert.deepStrictEqual([[...mixed.route], mixed.wormholeEdges.map((e) => [e.i, e.pairKey, e.expiresAt])],
      [[S.N9, S.H1, S.N0, S.ISO], [[2, "b@2", 9000]]]);
    assert.strictEqual(f.validateRoute(mixed.route), f.validateRoute([S.N0, S.H1]), "gates + open wormhole = VALID");

    assert.deepStrictEqual(f.updateWormholeEdge("c@3", edge(S.N0, S.ISO, 0)), { ok: true, changed: true,
      wormholeVersion: 3 });
    assert.deepStrictEqual(f.findRoute(S.N9, S.ISO, { wormholes: true }).wormholeEdges.map((e) => e.pairKey), ["c@3"]);
    assert.deepStrictEqual(f.updateWormholeEdge("b@2", edge(S.N0, S.ISO, 0)), { ok: true, changed: true,
      wormholeVersion: 3 });
    assert.deepStrictEqual(f.findRoute(S.N9, S.ISO, { wormholes: true }).wormholeEdges.map((e) => e.pairKey), ["b@2"]);
    assert.deepStrictEqual(f.updateWormholeEdge("b@2", edge(S.N0, S.N10, 0)), { ok: true, changed: true,
      wormholeVersion: 4 });
    const shortcut = f.findRoute(S.N10, S.ISO, { wormholes: true });
    assert.deepStrictEqual([[...shortcut.route], shortcut.wormholeEdges.map((e) => [e.i, e.pairKey])],
      [[S.N10, S.N0, S.ISO], [[0, "b@2"], [1, "c@3"]]]);
    assert.deepStrictEqual([f.getRouteStats().wormholeEdges, f.getRouteStats().graphVersion], [3, 1]);
  });

  test("A4 listWormholeEdges: frozen, ascending by pairKey, createdAt, limit; createdAt change = update "
    + "without a new wormholeVersion, routes see it; bad createdAt refused", () => {
    const f = finderOn(fixtureGraph());
    const edge = (fromSystemId, toSystemId, createdAtMs) => ({ fromSystemId, toSystemId, status: "open",
      expiresAtMs: 9000, ...(createdAtMs === undefined ? {} : { createdAtMs }) });
    assert.ok(f.updateWormholeEdge("c@3", edge(S.N0, S.ISO, 300)).ok);
    assert.ok(f.updateWormholeEdge("a@1", edge(S.N5, S.N10, 100)).ok);
    assert.ok(f.updateWormholeEdge("b@2", edge(S.L1, S.N9)).ok);
    const all = f.listWormholeEdges();
    assert.ok(Object.isFrozen(all) && all.every((e) => Object.isFrozen(e)), "frozen list and elements");
    assert.deepStrictEqual(all.map((e) => ({ ...e })), [
      { pairKey: "a@1", fromSystemId: S.N5, toSystemId: S.N10, expiresAt: 9000, createdAt: 100, maxJumpMass: 0 },
      { pairKey: "b@2", fromSystemId: S.L1, toSystemId: S.N9, expiresAt: 9000, createdAt: 0, maxJumpMass: 0 },
      { pairKey: "c@3", fromSystemId: S.N0, toSystemId: S.ISO, expiresAt: 9000, createdAt: 300, maxJumpMass: 0 }]);
    assert.deepStrictEqual(f.listWormholeEdges({ limit: 2 }).map((e) => e.pairKey), ["a@1", "b@2"]);
    assert.strictEqual(f.listWormholeEdges({ limit: 0 }).length, 3, "limit not a positive integer = no cut");
    const before = f.findRoute(S.N0, S.ISO, { wormholes: true });
    assert.deepStrictEqual(before.wormholeEdges.map((e) => e.createdAt), [300]);
    const version = f.getWormholeVersion();
    assert.deepStrictEqual(f.updateWormholeEdge("c@3", edge(S.N0, S.ISO, 400)),
      { ok: true, changed: true, wormholeVersion: version }, "same ends, other createdAt");
    assert.deepStrictEqual(f.findRoute(S.N0, S.ISO, { wormholes: true }).wormholeEdges.map((e) => e.createdAt), [400],
      "cached route of the ends dropped");
    assert.strictEqual(f.updateWormholeEdge("c@3", edge(S.N0, S.ISO, 400)).changed, false);
    for (const bad of [-1, 1.5, "1"]) {
      assert.deepStrictEqual(f.updateWormholeEdge("d@4", edge(S.N0, S.N9, bad)),
        { ok: false, reason: "INVALID_ARGUMENT", detail: "state" }, String(bad));
    }
    assert.strictEqual(typeof f.publicApi.listWormholeEdges, "function", "on the graph object (publicApi)");
  });

  test("MR4 wormholeMinJumpMass: the heavy pair on the longer route, 0 = the route and cache "
    + "key of before, the heavy pair of the same ends in wormholeEdges, mass change seen, needs wormholes", () => {
    const f = finderOn(fixtureGraph());
    const BN = 1000000000;
    const edge = (fromSystemId, toSystemId, maxJumpMass, expiresAtMs = 0) => ({ fromSystemId, toSystemId,
      status: "open", expiresAtMs, maxJumpMass });
    assert.ok(f.updateWormholeEdge("x@1", edge(S.N0, S.ISO, BN)).ok);
    assert.ok(f.updateWormholeEdge("y@2", edge(S.N9, S.ISO, 2 * BN)).ok);
    const shape = (r) => [[...r.route], r.wormholeEdges.map((e) => e.pairKey)];
    const plain = f.findRoute(S.N0, S.ISO, { wormholes: true });
    const heavy = f.findRoute(S.N0, S.ISO, { wormholes: true, wormholeMinJumpMass: 1300000000 });
    const zero = f.findRoute(S.N0, S.ISO, { wormholes: true, wormholeMinJumpMass: 0 });
    assert.deepStrictEqual([shape(plain), shape(heavy)], [[[S.N0, S.ISO], ["x@1"]],
      [[S.N0, S.H1, S.N9, S.ISO], ["y@2"]]]);
    assert.strictEqual(zero, plain, "0 = the same cache entry (same key) as no constraint");
    assert.strictEqual(f.findRoute(S.N0, S.ISO, { wormholes: true, wormholeMinJumpMass: 3 * BN }).reason, "UNREACHABLE");
    assert.ok(f.updateWormholeEdge("z@3", edge(S.N0, S.ISO, 2 * BN, 9000)).ok);
    assert.deepStrictEqual([shape(f.findRoute(S.N0, S.ISO, { wormholes: true })),
      shape(f.findRoute(S.N0, S.ISO, { wormholes: true, wormholeMinJumpMass: 1300000000 }))],
    [[[S.N0, S.ISO], ["x@1"]], [[S.N0, S.ISO], ["z@3"]]]);
    assert.ok(f.updateWormholeEdge("z@3", edge(S.N0, S.ISO, BN, 9000)).changed);
    assert.deepStrictEqual(shape(f.findRoute(S.N0, S.ISO, { wormholes: true, wormholeMinJumpMass: 1300000000 })),
      [[S.N0, S.H1, S.N9, S.ISO], ["y@2"]]);
    assert.deepStrictEqual(f.listWormholeEdges().map((e) => [e.pairKey, e.maxJumpMass]),
      [["x@1", BN], ["y@2", 2 * BN], ["z@3", BN]]);
    for (const bad of [{ wormholeMinJumpMass: 5 }, { wormholes: false, wormholeMinJumpMass: 5 },
      { wormholes: true, wormholeMinJumpMass: 1.5 }, { wormholes: true, wormholeMinJumpMass: "5" },
      { wormholes: true, wormholeMinJumpMass: -1 }]) {
      const r = f.findRoute(S.N0, S.ISO, bad);
      assert.deepStrictEqual([r.ok, r.reason, r.detail], [false, "INVALID_CONSTRAINTS", "wormholeMinJumpMass"],
        JSON.stringify(bad));
    }
    assert.ok(f.findRoute(S.N0, S.N9, { wormholeMinJumpMass: 0 }).ok, "0 without wormholes = no constraint");
  });
};
