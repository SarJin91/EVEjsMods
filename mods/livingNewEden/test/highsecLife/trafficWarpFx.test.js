"use strict";

const assert = require("node:assert");
const path = require("node:path");

const { resolveConfig } = require("../../config");
const { trafficSettingsOf } = require("../../lib/highsecLife/schema");
const { createTraffic } = require("../../lib/highsecLife/traffic/service");
const { TRAFFIC_HAULER_PROFILES } = require("../../lib/adapter/data/trafficProfiles");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const T0 = Date.UTC(2026, 10, 27, 18, 0, 0);
const SYS = 30000144;

function trafficOf(env) {
  return resolveConfig({ modDir: MOD_DIR, env: env || {} }).config.highsecLife.traffic;
}

function T(over) {
  const r = trafficSettingsOf({ highsecLife: { traffic: { ...trafficOf(), stationTargetPermille: 0, ...(over || {}) } } });
  assert.ok(r.ok, JSON.stringify(r));
  return r.settings;
}

const node = (itemId, x) => ({ itemId, position: { x, y: 0, z: 0 }, radius: 5000 });
const NODES = Object.freeze({ gates: [node(50001, 0), node(50002, 1e9)], stations: [] });

function harness(settings) {
  const clock = { t: T0, now() { return clock.t; } };
  const presence = { observedSystems: () => [SYS], getSystemPresence: () => ({ space: 1 }) };
  const warps = [];
  const alive = new Map();
  let next = 9000;
  const scene = {
    readNodes: () => ({ ok: true, gates: NODES.gates, stations: NODES.stations }),
    readPlayers: () => ({ ok: true, ships: [{ characterId: 1 }] }),
    spawnCivilian: () => {
      next += 1;
      alive.set(next, { x: 0, y: 0, z: 0 });
      return { ok: true, entityId: next };
    },
    warpTo: (...args) => {
      warps.push(args);
      const opts = args[3];
      const fx = opts && opts.warpFx === true ? { warpFx: true } : {};
      if (opts && opts.align === true) return { ok: true, warped: true, aligned: true, ...fx };
      alive.set(args[1], args[2]);
      return { ok: true, warped: true, ...fx };
    },
    readShips: (_id, ids) => ({ ok: true, sceneLoaded: true,
      live: ids.filter((e) => alive.has(e)).map((e) => ({ entityId: e, position: alive.get(e), inWarp: false })),
      gone: ids.filter((e) => !alive.has(e)) }),
    despawn: (_id, ids) => {
      for (const e of ids) alive.delete(e);
      return { ok: true, removed: ids.length, missing: 0 };
    },
    listTrafficIds: () => ({ ok: true, ids: [] }),
    dockPointOf: () => ({ ok: false, reason: "NO_STATION" }),
  };
  const made = createTraffic({ settings, scene, clock, rng: () => 0, getPresence: () => presence,
    describeSystem: () => ({ secClass: "highsec" }), wantedOf: () => 45, profiles: TRAFFIC_HAULER_PROFILES,
    getGovernor: () => ({ admits: () => true }) });
  assert.ok(made.ok, JSON.stringify(made));
  const step = (ms) => {
    clock.t += ms;
    made.traffic.tick();
  };
  return { step, warps, counters: () => made.traffic.status().counters };
}

module.exports = ({ test }) => {
  test("TWF1 service: flag on adds warpFx on the plain, aligned and timeout warp; a budget of one leaves the "
    + "second ship without it and counts the cut; flag off keeps the options as before", () => {
    const plain = harness(T({ visibleWarpEnabled: true }));
    plain.step(0);
    plain.step(T().departDelayMs);
    assert.ok(plain.warps.length > 0);
    assert.ok(plain.warps.every((a) => a.length === 4 && JSON.stringify(a[3]) === JSON.stringify({ warpFx: true })));
    assert.strictEqual(plain.counters().visibleWarpFx, plain.warps.length);

    const S = T({ visibleWarpEnabled: true, alignBeforeWarpEnabled: true });
    const aligned = harness(S);
    aligned.step(0);
    aligned.step(S.departDelayMs);
    const n = aligned.warps.length;
    assert.ok(n > 0 && aligned.warps.every((a) => JSON.stringify(a[3]) === JSON.stringify({ align: true, warpFx: true })));
    aligned.step(S.alignTimeoutMs);
    assert.deepStrictEqual(aligned.warps.slice(n).map((a) => a[3]),
      Array.from({ length: n }, () => ({ clearAlignOrder: true, warpFx: true })));

    const one = harness(T({ visibleWarpEnabled: true, visibleWarpMaxFxPerPass: 1, maxShipsPerSystem: 2,
      minCivilians: 2 }));
    one.step(0);
    one.step(T().departDelayMs);
    assert.ok(one.warps.length >= 2, `ships warped: ${one.warps.length}`);
    assert.deepStrictEqual(one.warps[0][3], { warpFx: true });
    assert.ok(one.warps.slice(1).every((a) => a.length === 3));
    assert.deepStrictEqual([one.counters().visibleWarpFx, one.counters().visibleWarpFxCut], [1, one.warps.length - 1]);

    const off = harness(T());
    off.step(0);
    off.step(T().departDelayMs);
    assert.ok(off.warps.length > 0 && off.warps.every((a) => a.length === 3));
    assert.deepStrictEqual([off.counters().visibleWarpFx, off.counters().visibleWarpFxCut], [0, 0]);
  });

  test("TWF2 config: visible warp is off with a budget of 40 by default, the budget clamps to 0..500 and 0 "
    + "is valid", () => {
    const d = trafficOf();
    assert.deepStrictEqual([d.visibleWarpEnabled, d.visibleWarpMaxFxPerPass], [false, 40]);
    const hi = trafficOf({ EVEJS_LNE_HIGHSEC_LIFE_TRAFFIC_VISIBLE_WARP_ENABLED: "1",
      EVEJS_LNE_HIGHSEC_LIFE_TRAFFIC_VISIBLE_WARP_MAX_FX_PER_PASS: "9999" });
    assert.deepStrictEqual([hi.visibleWarpEnabled, hi.visibleWarpMaxFxPerPass], [true, 500]);
    assert.strictEqual(trafficOf({ EVEJS_LNE_HIGHSEC_LIFE_TRAFFIC_VISIBLE_WARP_MAX_FX_PER_PASS: "0" })
      .visibleWarpMaxFxPerPass, 0);
    assert.strictEqual(T({ visibleWarpEnabled: true, visibleWarpMaxFxPerPass: 0 }).visibleWarpMaxFxPerPass, 0);
    assert.strictEqual(trafficSettingsOf({ highsecLife: { traffic: { ...trafficOf(), visibleWarpMaxFxPerPass: -1 } } })
      .ok, false);
  });
};
