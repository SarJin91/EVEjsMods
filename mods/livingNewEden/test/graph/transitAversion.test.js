"use strict";

const assert = require("node:assert");

const { buildUniverseGraph } = require("../../lib/graph/universeGraph");
const { createRouteFinder } = require("../../lib/graph/routes");
const { startGraph } = require("../../lib/graph");
const { buildDefaultServiceDefs } = require("../../lib/runtime/services");
const { FORTRESSES } = require("../../lib/strategy/data/fortresses");

const H = 30000100;
const A = [30000001, 30000002, 30000003, 30000004, 30000005, 30000006, 30000007];
const B1 = 30000011;
const B2 = 30000012;
const C = Array.from({ length: 11 }, (_v, i) => 30000021 + i);
const DETOUR = 6;

function hubMap() {
  const systems = [];
  const add = (id, secClass) => systems.push({ id, name: `S${id}`, regionId: 10000001, constellationId: 20000001,
    security: 0, trueSecurity: 0, secClass, factionId: 0 });
  add(H, "nullsec");
  A.forEach((id, i) => add(id, i > 0 && i < A.length - 1 ? "lowsec" : "nullsec"));
  add(B1, "nullsec");
  add(B2, "nullsec");
  C.forEach((id) => add(id, "nullsec"));
  const gates = [];
  const link = (x, y) => gates.push({ fromSystemId: x, toSystemId: y });
  link(A[0], H);
  link(H, A[A.length - 1]);
  for (let i = 0; i + 1 < A.length; i += 1) link(A[i], A[i + 1]);
  link(B1, H);
  link(H, B2);
  const chain = [B1, ...C, B2];
  for (let i = 0; i + 1 < chain.length; i += 1) link(chain[i], chain[i + 1]);
  return { systems, gates };
}

function hubGraph() {
  const built = buildUniverseGraph(hubMap());
  assert.strictEqual(built.ok, true, JSON.stringify(built.reason));
  return built.graph;
}

function finderOn(graph, extra = {}) {
  return createRouteFinder(graph, { cacheSize: 64, maxJumps: 40, ...extra });
}

const ON = { systemIds: [H], detourMaxJumps: DETOUR };

const QUERIES = [
  [A[0], A[6]], [A[0], A[6]], [B1, B2], [H, A[6]], [A[0], H], [A[1], A[5]], [A[0], A[6], { secClassCost: { lowsec: 3 } }],
  [A[0], A[6], { maxJumps: 3 }], [A[0], A[6], { forbiddenSystems: [H] }], [A[0], A[6], { wormholes: true }],
];

function runAll(f) {
  return QUERIES.map(([from, to, c]) => f.findRoute(from, to, c));
}

function graphDepsOf(fortress) {
  let got = null;
  const defs = buildDefaultServiceDefs({ startGraph: (deps) => {
    got = deps;
    return { ok: true, graph: { stop() {} } };
  } });
  const def = defs.find((d) => d.name === "graph");
  const ctx = { config: { graph: {}, ...(fortress ? { fortress } : {}) }, adapter: {} };
  assert.deepStrictEqual(def.start(ctx, { logger: { log() {} }, fail() {} }), { ok: true });
  return got;
}

module.exports = ({ test }) => {
  test("TA1 transitAversion absent / null / [] / unknown ids = findRoute and stats of before; flag off = no option",
    () => {
      const graph = hubGraph();
      const base = finderOn(graph);
      const expected = runAll(base);
      const expectedStats = base.getRouteStats();
      for (const transitAversion of [undefined, null, { systemIds: [], detourMaxJumps: DETOUR },
        { systemIds: [39999999], detourMaxJumps: DETOUR }]) {
        const f = finderOn(graph, { transitAversion });
        assert.deepStrictEqual(runAll(f), expected, JSON.stringify(transitAversion));
        assert.deepStrictEqual(f.getRouteStats(), expectedStats, JSON.stringify(transitAversion));
      }
      assert.deepStrictEqual([...expected[0].route], [A[0], H, A[6]]);
      assert.throws(() => finderOn(graph, { transitAversion: { systemIds: [1.5], detourMaxJumps: 1 } }), TypeError);
      assert.throws(() => finderOn(graph, { transitAversion: { systemIds: [H], detourMaxJumps: -1 } }), TypeError);
      assert.strictEqual("transitAversion" in graphDepsOf(null), false);
      assert.strictEqual("transitAversion" in graphDepsOf({ routeAversionEnabled: false, routeDetourMaxJumps: 6 }),
        false);
    });

  test("TA2 detour <= detourMaxJumps -> route without the hub, aversionApplied; log line; composition on", async () => {
    const f = finderOn(hubGraph(), { transitAversion: ON });
    const r = f.findRoute(A[0], A[6]);
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual([...r.route], A);
    assert.deepStrictEqual([r.jumps, r.cost], [6, 6]);
    let s = f.getRouteStats();
    assert.deepStrictEqual([s.searches, s.aversionChecks, s.aversionApplied, s.aversionKept], [2, 1, 1, 0]);
    assert.strictEqual(f.findRoute(A[0], A[6]), r);
    assert.strictEqual(f.invalidateRouteCache([H]).removed, 1);
    f.findRoute(A[0], A[6]);
    s = f.getRouteStats();
    assert.deepStrictEqual([s.hits, s.searches, s.aversionApplied], [1, 4, 2]);

    const lines = [];
    const counts = {};
    const telemetry = { count: (n, v = 1) => { counts[n] = (counts[n] || 0) + v; }, gauge() {}, observe() {} };
    let pending = null;
    const started = startGraph({ config: { graph: { buildWarnMs: 250, routeCacheSize: 16, routeMaxJumps: 40 } },
      adapter: { readStaticMap: () => ({ ok: true, map: hubMap() }) }, telemetry, logger: { log: (m) => lines.push(m) },
      defer: (fn) => { pending = fn; return { cancel() {} }; },
      transitAversion: { systemIds: [H, 39999999], detourMaxJumps: DETOUR } });
    assert.strictEqual(started.ok, true);
    pending();
    const ready = await started.graph.whenReady();
    assert.deepStrictEqual([...ready.graph.findRoute(A[0], A[6]).route], A);
    assert.ok(lines.includes(`graph: transit aversion systems=${H},39999999 neighbours=4,0 detour=${DETOUR}`), lines);
    assert.ok(lines.includes("graph: WARNING transit aversion system 39999999 has no gate neighbours - no effect"));
    assert.deepStrictEqual([counts["graph.routeAversionChecks"], counts["graph.routeAversionApplied"]], [1, 1]);
    started.graph.stop("test");

    assert.deepStrictEqual(graphDepsOf({ routeAversionEnabled: true, routeDetourMaxJumps: 9 }).transitAversion,
      { systemIds: FORTRESSES.map((x) => x.systemId), detourMaxJumps: 9 });
    assert.deepStrictEqual(FORTRESSES, [{ systemId: 30100000, factionId: 500029, name: "Zarzakh" }]);
  });

  test("TA3 detour > detourMaxJumps (or over maxJumps) -> route through the hub, aversionKept", () => {
    const f = finderOn(hubGraph(), { transitAversion: ON });
    const r = f.findRoute(B1, B2);
    assert.deepStrictEqual([...r.route], [B1, H, B2]);
    assert.deepStrictEqual([r.jumps, r.cost], [2, 2]);
    assert.deepStrictEqual([...f.findRoute(A[0], A[6], { maxJumps: 5 }).route], [A[0], H, A[6]]);
    const s = f.getRouteStats();
    assert.deepStrictEqual([s.searches, s.aversionChecks, s.aversionApplied, s.aversionKept], [4, 2, 0, 2]);
    assert.strictEqual(finderOn(hubGraph(), { transitAversion: { systemIds: [H], detourMaxJumps: 64 } })
      .findRoute(B1, B2).jumps, 12);
  });

  test("TA4 hub as start or destination -> no second search", () => {
    const f = finderOn(hubGraph(), { transitAversion: ON });
    assert.deepStrictEqual([...f.findRoute(H, A[6]).route], [H, A[6]]);
    assert.strictEqual(f.getRouteStats().searches, 1);
    assert.deepStrictEqual([...f.findRoute(A[0], H).route], [A[0], H]);
    const s = f.getRouteStats();
    assert.deepStrictEqual([s.searches, s.aversionChecks], [2, 0]);
  });

  test("TA5 Dijkstra (secClassCost) compares the weighted cost of the detour, not its jumps", () => {
    const f = finderOn(hubGraph(), { transitAversion: ON });
    const kept = f.findRoute(A[0], A[6], { secClassCost: { lowsec: 3 } });
    assert.deepStrictEqual([...kept.route], [A[0], H, A[6]]);
    assert.strictEqual(kept.cost, 2);
    const applied = f.findRoute(A[0], A[6], { secClassCost: { nullsec: 1 } });
    assert.deepStrictEqual([...applied.route], A);
    assert.strictEqual(applied.cost, 7);
    const s = f.getRouteStats();
    assert.deepStrictEqual([s.aversionChecks, s.aversionApplied, s.aversionKept], [2, 1, 1]);
  });

  test("TA6: the detour search adds a graph.routeSearchMs sample; samples = growth of searches", () => {
    const samples = [];
    const telemetry = { count() {}, gauge() {}, observe: (name, v) => {
      if (name === "graph.routeSearchMs") samples.push(v);
    } };
    let t = 0;
    const f = finderOn(hubGraph(), { transitAversion: ON, telemetry, nowMs: () => (t += 1) });
    const step = (from, to) => {
      const before = [samples.length, f.getRouteStats().searches];
      const r = f.findRoute(from, to);
      assert.strictEqual(r.ok, true, JSON.stringify(r));
      const added = samples.length - before[0];
      assert.strictEqual(added, f.getRouteStats().searches - before[1]);
      return added;
    };
    assert.deepStrictEqual([step(A[0], A[6]), step(B1, B2), step(A[1], A[3]), step(A[0], A[6])], [2, 2, 1, 0]);
    assert.ok(samples.every((v) => v === 1), JSON.stringify(samples));
  });
};
