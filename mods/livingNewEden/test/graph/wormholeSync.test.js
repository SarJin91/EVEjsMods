"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { resolveConfig } = require("../../config");
const { buildUniverseGraph } = require("../../lib/graph/universeGraph");
const { createRouteFinder } = require("../../lib/graph/routes");
const { readStaticMapFrom } = require("../../lib/adapter/staticMap");
const { readWormholePairsFrom } = require("../../lib/adapter/wormholePairs");
const { diffWormholeEdges } = require("../../lib/graph/wormholes/sync");
const { startWormholes } = require("../../lib/graph/wormholes");
const { createManualClock } = require("../../lib/util/clock");
const { loadSecurityBand } = require("./fixtures/staticMap.fixture");
const { S, rawWorld } = require("./fixtures/routeMap.fixture");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const STATE = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "wormholeState.v4.json"), "utf8"));
const T0 = 1700000100000;
const HOUR = 3600000;
const P11 = "11@1700000000000";
const P12 = "12@1700000100000";
const EOL_AT = 1700018100000 - 4 * HOUR;

function composedGraph() {
  const built = buildUniverseGraph(readStaticMapFrom({ ensureLoaded: () => rawWorld() }, loadSecurityBand()).map);
  const finder = createRouteFinder(built.graph, { cacheSize: 64, maxJumps: 40 });
  return Object.freeze({ ...built.graph, ...finder.publicApi });
}

function configWith(env) {
  const r = resolveConfig({ modDir: MOD_DIR, env });
  assert.deepStrictEqual(r.warnings, []);
  return r.config;
}

function pairsAt(view) {
  return readWormholePairsFrom({ WORMHOLE_RUNTIME_VERSION: 4, getStateView: () => view }, { maxPairs: 100 }).pairs;
}

module.exports = ({ test }) => {
  test("WS1 diffWormholeEdges + service: thresholds, no-op round, off = no pump, refusal = unavailable", async () => {
    const graph = composedGraph();
    const opts = (now) => ({ now, minRemainingMs: 4 * HOUR, hasSystem: (id) => graph.hasSystem(id) });
    const outside = { pairKey: "15@1", fromSystemId: S.N0, toSystemId: 30009999, active: true, expiresAt: 0,
      maxJumpMass: 0 };
    const first = diffWormholeEdges(new Map(), [...pairsAt(STATE), outside], opts(T0));
    assert.deepStrictEqual(first.changes.map((c) => [c.connectionId, c.state.status]), [[P11, "open"], [P12, "open"]],
      "collapsed 13, system 0 (14) and system outside the graph (15) give no edge");
    assert.deepStrictEqual(diffWormholeEdges(first.next, pairsAt(STATE), opts(EOL_AT)).changes, [],
      "exactly minRemainingMs left: still routable, nothing changes");
    const reborn = pairsAt(STATE).map((p) => (p.pairKey === P11 ? { ...p, createdAt: p.createdAt + 1 } : p));
    assert.deepStrictEqual(diffWormholeEdges(first.next, reborn, opts(T0)).changes
      .map((c) => [c.connectionId, c.state.status, c.state.createdAtMs]),
    [[P11, "open", reborn.find((p) => p.pairKey === P11).createdAt]]);
    assert.deepStrictEqual(diffWormholeEdges(first.next, pairsAt(STATE), opts(EOL_AT + 1)).changes
      .map((c) => [c.connectionId, c.state.status, c.state.fromSystemId]), [[P12, "closed", S.N5]]);

    assert.strictEqual(configWith({}).wormholes.enabled, true);
    const timers = [];
    const setTimer = (fn, ms) => {
      const t = { fn, ms, cancelled: false };
      timers.push(t);
      return { cancel: () => { t.cancelled = true; }, hasRef: () => false };
    };
    const clock = createManualClock(T0);
    let reads = 0;
    let admits = true;
    const adapter = { readWormholePairs: (o) => { reads += 1;
      return readWormholePairsFrom({ WORMHOLE_RUNTIME_VERSION: 4, getStateView: () => STATE }, o); } };
    const deps = { adapter, graph: { whenReady: () => Promise.resolve({ ok: true, graph }) }, clock, setTimer,
      getGovernor: () => ({ admits: () => admits }) };
    assert.deepStrictEqual(startWormholes({ ...deps, config: configWith({ EVEJS_LNE_WORMHOLES_ENABLED: "0",
      EVEJS_LNE_EXPEDITIONS_ENABLED: "0" }) }), { ok: false, reason: "disabled_by_config" });
    assert.strictEqual(timers.length, 0);

    const counts = {};
    const telemetry = { count: (n, v) => { counts[n] = (counts[n] || 0) + v; }, gauge() {}, observe() {} };
    const started = startWormholes({ ...deps, telemetry, config: configWith({ EVEJS_LNE_WORMHOLES_ENABLED: "1" }) });
    assert.strictEqual(started.ok, true);
    const wh = started.wormholes;
    assert.deepStrictEqual([wh.isSynced(), wh.syncNow().reason], [false, "GRAPH_NOT_READY"]);
    await Promise.resolve();
    await Promise.resolve();
    const live = timers.filter((t) => !t.cancelled);
    assert.deepStrictEqual(live.map((t) => t.ms), [0], "first sync at once, after the graph build");
    live[0].fn();
    assert.deepStrictEqual([wh.isSynced(), reads, graph.getWormholeVersion()], [true, 1, 2]);
    assert.deepStrictEqual([...graph.findRoute(S.N0, S.ISO, { wormholes: true }).route], [S.N0, S.ISO]);
    const pending = () => timers.filter((t) => !t.cancelled && t !== live[0]).map((t) => t.ms);
    assert.deepStrictEqual(pending(), [30000], "re-armed every syncIntervalMs");

    clock.set(EOL_AT + 1);
    assert.deepStrictEqual({ ...wh.syncNow() }, { ok: true, pairs: 3, edges: 1, opened: 0, closed: 1, refused: 0 });
    const gates = graph.findRoute(S.N5, S.N10, { wormholes: true });
    assert.deepStrictEqual([gates.jumps, gates.wormholeEdges.length], [4, 0], "N5->N10 by gates only");
    assert.strictEqual(graph.validateRoute([S.N5, S.N10]).reason, "BROKEN_EDGE", "closed edge is no edge");
    adapter.readWormholePairs = () => ({ ok: false, reason: "BENCH_UNSUPPORTED" });
    assert.strictEqual(wh.syncNow().reason, "BENCH_UNSUPPORTED");
    assert.deepStrictEqual([wh.getStatus().state, wh.isSynced(), counts["wormholes.syncFailed"]], ["unavailable", true, 1]);
    assert.deepStrictEqual([...graph.findRoute(S.N0, S.ISO, { wormholes: true }).route], [S.N0, S.ISO], "overlay kept");
    admits = false;
    assert.strictEqual(wh.syncNow().reason, "GOVERNOR_HOLD");
    assert.strictEqual(counts["wormholes.syncSkipped"], 1);
    wh.stop();
    assert.deepStrictEqual(pending(), [], "stop cancels the pump");
  });

  test("WS2: fleets stub (FLEETS_DISABLED / FLEETS_UNAVAILABLE) = no closures, not a refusal", async () => {
    const { createUnavailableFleets } = require("../../lib/fleets");
    for (const why of ["FLEETS_DISABLED", "FLEETS_UNAVAILABLE"]) {
      const graph = composedGraph();
      const counts = {};
      const telemetry = { count: (n, v) => { counts[n] = (counts[n] || 0) + v; }, gauge() {}, observe() {} };
      const fleets = createUnavailableFleets(why, "disabled_by_config");
      const adapter = { readWormholePairs: (o) => readWormholePairsFrom({ WORMHOLE_RUNTIME_VERSION: 4,
        getStateView: () => STATE }, o) };
      const started = startWormholes({ adapter, graph: { whenReady: () => Promise.resolve({ ok: true, graph }) },
        clock: createManualClock(T0), telemetry, setTimer: () => ({ cancel() {}, hasRef: () => false }),
        getFleets: () => fleets, config: configWith({ EVEJS_LNE_WORMHOLES_ENABLED: "1" }) });
      assert.strictEqual(started.ok, true);
      await Promise.resolve();
      await Promise.resolve();
      const r = started.wormholes.syncNow();
      assert.deepStrictEqual([r.ok, r.closures], [true, undefined], `${why}: round ok, no closure block`);
      assert.deepStrictEqual([started.wormholes.isSynced(), started.wormholes.getStatus().state,
        counts["wormholes.syncFailed"]], [true, "synced", undefined], why);
      started.wormholes.stop();
    }
    const graph = composedGraph();
    const broken = { listOpenWormholeTransitPairs: () => ({ ok: false, reason: "SCHEDULER_UNAVAILABLE" }),
      closeWormholeTransits: () => ({ ok: true, closed: 0, deferred: 0, purged: 0 }) };
    const started = startWormholes({ adapter: { readWormholePairs: (o) => readWormholePairsFrom({
      WORMHOLE_RUNTIME_VERSION: 4, getStateView: () => STATE }, o) },
    graph: { whenReady: () => Promise.resolve({ ok: true, graph }) }, clock: createManualClock(T0),
    setTimer: () => ({ cancel() {}, hasRef: () => false }), getFleets: () => broken,
    config: configWith({ EVEJS_LNE_WORMHOLES_ENABLED: "1" }) });
    await Promise.resolve();
    await Promise.resolve();
    assert.strictEqual(started.wormholes.syncNow().reason, "SCHEDULER_UNAVAILABLE");
    assert.deepStrictEqual([started.wormholes.isSynced(), started.wormholes.getStatus().state], [false, "unavailable"]);
    started.wormholes.stop();
  });
};
