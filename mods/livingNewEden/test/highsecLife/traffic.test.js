"use strict";

const assert = require("node:assert");
const path = require("node:path");

const { resolveConfig } = require("../../config");
const { trafficSettingsOf, TRAFFIC_METRICS } = require("../../lib/highsecLife/schema");
const { trafficCapOf, planSpawns, pickRoute, stepShip } = require("../../lib/highsecLife/traffic/plan");
const { createTraffic } = require("../../lib/highsecLife/traffic/service");
const { startHighsecLife } = require("../../lib/highsecLife");
const { createRng } = require("../../lib/util/rng");
const { TRAFFIC_HAULER_PROFILES } = require("../../lib/adapter/data/trafficProfiles");
const VC_DATA = require("../../lib/strategy/data/virtualCorps");
const HS = require("./highsecLife.test").harness;

const MOD_DIR = path.resolve(__dirname, "..", "..");
const T0 = Date.UTC(2026, 10, 11, 17, 0, 0);
const SYS = 30000144;

function defaultTraffic(over) {
  return { ...resolveConfig({ modDir: MOD_DIR, env: {} }).config.highsecLife.traffic, ...(over || {}) };
}

function T(over) {
  const r = trafficSettingsOf({ highsecLife: { traffic: defaultTraffic(over) } });
  assert.ok(r.ok, JSON.stringify(r));
  return r.settings;
}

const node = (itemId, x) => ({ itemId, position: { x, y: 0, z: 0 }, radius: 5000 });

function fakeScene({ orphans = [] } = {}) {
  const calls = [];
  const alive = new Map();
  let next = 9000;
  const scene = {
    readNodes: (id) => {
      calls.push(["readNodes", id]);
      return { ok: true, gates: [node(50001, 0), node(50002, 1e9)], stations: [node(60001, 5e8)] };
    },
    readPlayers: (id) => {
      calls.push(["readPlayers", id]);
      return { ok: true, ships: scene.players };
    },
    spawnCivilian: (id, spec) => {
      calls.push(["spawnCivilian", id, spec.profileId, spec.gateId]);
      next += 1;
      alive.set(next, { x: 0, y: 0, z: 0 });
      return { ok: true, entityId: next };
    },
    warpTo: (id, entityId) => {
      calls.push(["warpTo", id, entityId]);
      return { ok: true, warped: true };
    },
    readShips: (id, ids) => ({ ok: true, sceneLoaded: true,
      live: ids.filter((e) => alive.has(e)).map((e) => ({ entityId: e, position: alive.get(e), inWarp: false })),
      gone: ids.filter((e) => !alive.has(e)) }),
    despawn: (id, ids) => {
      calls.push(["despawn", id, [...ids]]);
      for (const e of ids) alive.delete(e);
      return { ok: true, removed: ids.length, missing: 0 };
    },
    listTrafficIds: (id) => {
      calls.push(["listTrafficIds", id]);
      return { ok: true, ids: [...orphans, ...alive.keys()].sort((a, b) => a - b) };
    },
    dockPointOf: (id, stationId) => {
      calls.push(["dockPointOf", id, stationId]);
      return { ok: true, point: { x: 5e8, y: 0, z: 1000 }, direction: { x: 0, y: 0, z: 1 } };
    },
    players: [{ characterId: 1 }],
  };
  return { scene, calls };
}

function harness(over) {
  const clock = { t: T0, now() { return clock.t; } };
  const space = { value: 1 };
  const presence = { observedSystems: () => [SYS], getSystemPresence: () => ({ space: space.value }) };
  const metrics = [];
  const telemetry = {};
  for (const kind of ["count", "gauge", "observe"]) telemetry[kind] = (name, value) => metrics.push([kind, name, value]);
  const f = fakeScene(over);
  const made = createTraffic({ settings: T(), scene: f.scene, clock, rng: () => 0, getPresence: () => presence,
    describeSystem: () => ({ secClass: "highsec" }), wantedOf: () => 45, profiles: TRAFFIC_HAULER_PROFILES,
    getGovernor: () => ({ admits: () => true }), telemetry });
  assert.ok(made.ok, JSON.stringify(made));
  return { traffic: made.traffic, clock, space, metrics, ...f };
}

module.exports = ({ test }) => {
  test("TR1 planner: no player = no spawn, cap per system, global ceiling, pair, route never the start gate", () => {
    const S = T();
    const cand = (o) => ({ systemId: SYS, wanted: 80, players: 1, live: 0, nextSpawnAt: 0, ...o });
    assert.deepStrictEqual(planSpawns({ now: 1, globalLive: 0, candidates: [cand({ players: 0 })] }, S), []);
    assert.deepStrictEqual([trafficCapOf(80, S), trafficCapOf(45, S), trafficCapOf(2, S)], [4, 3, 0]);
    assert.deepStrictEqual(planSpawns({ now: 1, globalLive: 0, candidates: [cand({ live: 4 })] }, S), [],
      "a full system (cap 4) spawns nothing");
    const nearFull = planSpawns({ now: 1, globalLive: S.maxShipsGlobal - 1,
      candidates: [cand({}), cand({ systemId: SYS + 1 })] }, S);
    assert.deepStrictEqual(nearFull, [{ systemId: SYS, count: 1 }], "one ship left globally");
    assert.deepStrictEqual(planSpawns({ now: 1, globalLive: 0, candidates: [cand({ wanted: S.pairCivilians })] }, S),
      [{ systemId: SYS, count: 2 }]);
    assert.deepStrictEqual(planSpawns({ now: 1, globalLive: 0, candidates: [cand({ wanted: 10 })] }, S),
      [{ systemId: SYS, count: 1 }]);
    const rng = createRng(20261111).nextFloat;
    for (let i = 0; i < 100; i += 1) {
      const r = pickRoute({ gates: [node(1, 0), node(2, 1e9)], stations: [] }, rng, S);
      assert.ok(r.ok && r.target.kind === "stargate" && r.target.itemId !== r.startGate.itemId, JSON.stringify(r));
    }
    assert.deepStrictEqual(pickRoute({ gates: [node(1, 0)], stations: [] }, rng, S), { ok: false, reason: "NO_ROUTE" });
    assert.strictEqual(pickRoute({ gates: [node(1, 0)], stations: [node(3, 5)] }, rng, S).target.kind, "station");
  });

  test("TR2 stepShip: warp after departDelayMs, arrived, despawn after dockDelayMs, EXPIRED first, STUCK", () => {
    const S = T();
    const ship = { state: "SPAWNED", spawnedAt: 0, arrivedAt: null, warpAttempts: 0, targetPoint: { x: 1e6, y: 0, z: 0 } };
    const seen = { live: true, inWarp: false, position: { x: 0, y: 0, z: 0 } };
    assert.deepStrictEqual(stepShip(ship, seen, S.departDelayMs - 1, S), { kind: "none" });
    assert.deepStrictEqual(stepShip(ship, seen, S.departDelayMs, S), { kind: "warp" });
    const warping = { ...ship, state: "WARPING" };
    assert.deepStrictEqual(stepShip(warping, { ...seen, inWarp: true, position: warping.targetPoint }, 20000, S),
      { kind: "none" }, "still in warp");
    assert.deepStrictEqual(stepShip(warping, { ...seen, position: { x: 1e6 - 1000, y: 0, z: 0 } }, 20000, S),
      { kind: "arrived" });
    const arrived = { ...ship, state: "ARRIVED", arrivedAt: 30000 };
    assert.deepStrictEqual(stepShip(arrived, seen, 30000 + S.dockDelayMs - 1, S), { kind: "none" });
    assert.deepStrictEqual(stepShip(arrived, seen, 30000 + S.dockDelayMs, S), { kind: "despawn", reason: "ARRIVED" });
    assert.deepStrictEqual(stepShip(warping, { ...seen, position: warping.targetPoint }, S.maxLifetimeMs, S),
      { kind: "despawn", reason: "EXPIRED" }, "EXPIRED before the arrival");
    assert.deepStrictEqual(stepShip({ ...ship, warpAttempts: S.maxWarpAttempts }, seen, S.departDelayMs, S),
      { kind: "despawn", reason: "STUCK" });
  });

  test("TR3 service: orphan before spawn, 2 haulers, LEFT after exitGraceMs, stop despawns, metrics; "
    + "startHighsecLife flag off = zero getTrafficScene calls", async () => {
    const h = harness({ orphans: [777] });
    h.traffic.tick();
    const names = h.calls.map((c) => c[0]);
    assert.deepStrictEqual(h.calls.find((c) => c[0] === "despawn"), ["despawn", SYS, [777]]);
    assert.ok(names.indexOf("despawn") < names.indexOf("spawnCivilian"), "the orphan goes before the spawn");
    assert.deepStrictEqual(h.calls.filter((c) => c[0] === "spawnCivilian"),
      [["spawnCivilian", SYS, "ore_mining_bestower_hauler", 50001], ["spawnCivilian", SYS, "ore_mining_bestower_hauler",
        50001]]);
    let st = h.traffic.status();
    assert.deepStrictEqual([st.ships, st.counters.spawned, st.counters.orphans], [2, 2, 1]);
    h.space.value = 0;
    h.clock.t += 1000;
    h.traffic.tick();
    assert.strictEqual(h.traffic.status().ships, 2, "within the grace");
    h.clock.t += T().exitGraceMs;
    h.traffic.tick();
    st = h.traffic.status();
    assert.deepStrictEqual([st.ships, st.counters.left], [0, 2]);
    assert.deepStrictEqual(h.calls.filter((c) => c[0] === "despawn").pop(), ["despawn", SYS, [9001, 9002]]);
    const metricNames = new Set(Object.values(TRAFFIC_METRICS));
    assert.ok(h.metrics.length > 0 && h.metrics.every(([, name]) => metricNames.has(name)), JSON.stringify(h.metrics));

    const s = harness();
    s.traffic.tick();
    assert.strictEqual(s.traffic.status().ships, 2);
    s.traffic.stop();
    assert.deepStrictEqual([s.calls.pop(), s.traffic.status().ships, s.traffic.tick().reason],
      [["despawn", SYS, [9001, 9002]], 0, "STOPPED"]);

    const boot = async (enabled) => {
      let asked = 0;
      const metrics = [];
      const base = HS.baseConfig();
      const config = { ...base, highsecLife: { ...base.highsecLife, traffic: defaultTraffic({ enabled }) } };
      const vc = { ensureOwnerIdentity: () => ({ ok: true }), getOwnerIdentity: () => ({ ok: true, state: "LINKED",
        characterIds: Array.from({ length: 10 }, (_, i) => 92000000 + i), refusedMemberCount: 0 }) };
      const r = startHighsecLife({ config, worldSeed: HS.SEED, clock: { now: () => T0 },
        telemetry: { count: (n) => metrics.push(n), gauge: (n) => metrics.push(n), observe: (n) => metrics.push(n) },
        setTimer: () => ({ cancel() {}, hasRef: () => false }),
        getGraph: () => ({ whenReady: () => Promise.resolve({ ok: true, graph: HS.fakeGraph() }) }),
        getVirtualCorps: () => vc, listStations: () => ({ ok: true, stations: [] }),
        bloodlinesOf: (fid) => (VC_DATA.getById(fid) ? VC_DATA.getById(fid).bloodlineIds : null),
        getPresence: () => ({ observedSystems: () => [], getSystemPresence: () => null }),
        getTrafficScene: () => {
          asked += 1;
          return { ok: true, seam: fakeScene().scene };
        },
        trafficProfiles: TRAFFIC_HAULER_PROFILES });
      assert.ok(r.ok, JSON.stringify(r));
      await r.highsecLife.whenReady();
      return { hs: r.highsecLife, asked: () => asked, metrics };
    };
    const off = await boot(false);
    assert.deepStrictEqual([off.asked(), off.hs.getStatus().traffic.state], [0, "off"]);
    assert.ok(!off.metrics.some((n) => String(n).startsWith("highsecLife.traffic")), "no traffic metric off");
    const on = await boot(true);
    assert.deepStrictEqual([on.asked(), on.hs.getStatus().traffic.state], [1, "running"]);
    on.hs.stop();
    assert.strictEqual(on.hs.getStatus().traffic.state, "stopped");
  });
};
