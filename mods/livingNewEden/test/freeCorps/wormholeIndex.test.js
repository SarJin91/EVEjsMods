"use strict";

const assert = require("node:assert");
const path = require("node:path");

const config = require("../../config");
const { createRouteFinder } = require("../../lib/graph/routes");
const { bfs } = require("../../lib/strategy/ai/bfs");
const { createWormholeIndex } = require("../../lib/freeCorps/wormholeIndex");
const V = require("../../lib/freeCorps/ventures");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const ON_ENV = Object.freeze({ EVEJS_LNE_FREE_CORPS_ENABLED: "1", EVEJS_LNE_VIRTUALCORPS_ENABLED: "1" });
const T0 = 2000000000000;
const E = 30000001;
const E2 = 30000002;
const J1 = 31000001;
const J2 = 31000002;
const REFRESH = 600000;

function graphOf() {
  const systems = new Map([[E, { band: "highsec", links: [E2] }], [E2, { band: "highsec", links: [E] }],
    [J1, { band: "wormhole", links: [] }], [J2, { band: "wormhole", links: [] }]]);
  const base = { getSystemIds: () => [...systems.keys()],
    getSystem: (id) => (systems.has(id) ? { id, name: `S${id}`, regionId: id > 31000000 ? 11000001 : 10000002,
      constellationId: 20000020, secClass: systems.get(id).band } : null),
    getNeighbors: (id) => (systems.has(id) ? systems.get(id).links.slice() : []),
    hasSystem: (id) => systems.has(Number(id)) };
  const finder = createRouteFinder(base, { cacheSize: 64, maxJumps: 40 });
  for (const [key, from, to] of [["e-j1", E, J1], ["j1-j2", J1, J2], ["j2-e2", J2, E2]]) {
    const r = finder.updateWormholeEdge(key, { fromSystemId: from, toSystemId: to, status: "open" });
    assert.ok(r.ok && r.changed, JSON.stringify(r));
  }
  return { graph: Object.freeze({ ...base, ...finder.publicApi }), finder };
}

module.exports = ({ test }) => {
  test("FC6-2 index on a real route finder: closed E-J1 not linked, findExit J1 -> [J1, J2, E2], WORKING -> "
    + "WH_REROUTE, the key follows the edge count", () => {
    const { graph, finder } = graphOf();
    const idx = createWormholeIndex({ graph, excluded: new Set(), bfs,
      settings: { maxWhJumps: 3, maxBfsSystems: 200, maxExitCandidates: 4, maxReturnJumps: 20, indexRefreshMs: REFRESH },
      nowMs: () => 0 });
    const first = idx.refresh(T0);
    assert.deepStrictEqual([first.ok, first.rebuilt, first.key], [true, true, "3:3"]);
    assert.deepStrictEqual(idx.entriesOf(E).map((x) => x.jSystemId), [J1]);
    assert.strictEqual(idx.isLinked([J1, E]), true);

    const version = graph.getWormholeVersion();
    const closed = finder.updateWormholeEdge("e-j1", { fromSystemId: E, toSystemId: J1, status: "closed" });
    assert.ok(closed.ok && closed.changed);
    assert.strictEqual(graph.getWormholeVersion(), version, "a removal never bumps wormholeVersion");
    assert.strictEqual(idx.isLinked([J1, E]), false, "exact, the stale index does not matter");
    assert.deepStrictEqual(idx.refresh(T0 + 1).rebuilt, false, "inside indexRefreshMs: no rebuild");
    const again = idx.refresh(T0 + REFRESH);
    assert.deepStrictEqual([again.rebuilt, again.key], [true, "3:2"], "the edge count changes the key");
    assert.deepStrictEqual(idx.entriesOf(E), []);

    const exit = idx.findExit(J1, E, null);
    assert.deepStrictEqual(exit, { ok: true, route: [J1, J2, E2], hops: 2, gateJumps: 1 });

    const r = config.resolveConfig({ modDir: MOD_DIR, env: ON_ENV });
    const f = r.config.freeCorps;
    const S = { ...f, ventures: { ...f.ventures, enabled: true, jumpsPerStep: 2 },
      wormholes: { ...f.wormholes, enabled: true } };
    const venture = { venture_id: "fcv:1:1", corp_id: 1, seq: 1, kind: "EXPLORE_WH", state: "WORKING", open: 1,
      home_system_id: E, system_id: J1, target_system_id: J1, target_station_id: null, sec_band: "wormhole", jumps: 1,
      crew: 3, crew_lost: 0, step: 2, travel_steps: 1, work_steps: 3, steps_total: 5, holds: 0, yield_isk: 7000000,
      cost_isk: 0, started_at: T0, step_due_at: T0, updated_at: T0, ended_at: null, end_reason: null, version: 1,
      wh_route: JSON.stringify([J1, E]), wh_entry_system_id: E, stranded_steps: 0 };
    const corp = { corp_id: 1, archetype: "explorer", state: "ACTIVE", isk: 0, seed: 9, venture_seq: 1,
      members_target: 3, recover_until: 0, recover_crew: 0, ventures_done: 0, ventures_lost: 0, isk_earned: 0,
      isk_lost: 0, struggle_count: 0, last_review_at: 0, ended_at: null, end_reason: null };
    const env = { now: T0, linkedCount: 3, memberRoom: 0, reachOf: () => null, beltsOf: () => null,
      stationsOf: () => [], isObserved: () => false,
      wh: { mode: "LIVE", minLifeMs: 0, entriesOf: idx.entriesOf, isLinked: idx.isLinked,
        findExit: (j, home) => idx.findExit(j, home, null) } };
    const out = V.stepCorpVenture(corp, venture, env, S);
    const row = out.venture.row;
    assert.deepStrictEqual([row.state, row.end_reason, row.system_id, row.wh_route, row.steps_total, row.yield_isk],
      ["RETURNING", "WH_REROUTE", J1, JSON.stringify([J1, J2, E2]), 2 + Math.ceil((2 + 1) / 2), 7000000]);
  });
};
