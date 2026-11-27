"use strict";

const assert = require("node:assert");
const path = require("node:path");

const { resolveConfig } = require("../../config");
const { trafficSettingsOf } = require("../../lib/highsecLife/schema");
const { stepShip } = require("../../lib/highsecLife/traffic/plan");
const { createTraffic } = require("../../lib/highsecLife/traffic/service");
const { TRAFFIC_HAULER_PROFILES } = require("../../lib/adapter/data/trafficProfiles");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const T0 = Date.UTC(2026, 10, 27, 18, 0, 0);
const SYS = 30000144;

function trafficOf(env) {
  return resolveConfig({ modDir: MOD_DIR, env: env || {} }).config.highsecLife.traffic;
}

function T(over) {
  const r = trafficSettingsOf({ highsecLife: { traffic: { ...trafficOf(), ...(over || {}) } } });
  assert.ok(r.ok, JSON.stringify(r));
  return r.settings;
}

const node = (itemId, x) => ({ itemId, position: { x, y: 0, z: 0 }, radius: 5000 });
const NODES = Object.freeze({ gates: [node(50001, 0), node(50002, 1e9)], stations: [] });

function harness(settings, alignResult) {
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
      if (opts && opts.align === true) return { ok: true, warped: true, aligned: alignResult };
      alive.set(args[1], args[2]);
      return { ok: true, warped: true };
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
  return { traffic: made.traffic, step, warps };
}

module.exports = ({ test }) => {
  test("TAL1 plan: an aligning ship out of warp and far from the target past alignTimeoutMs asks for an immediate "
    + "warp; before the timeout, in warp or in immediate mode it waits", () => {
    const S = T({ alignBeforeWarpEnabled: true });
    const far = { live: true, inWarp: false, position: { x: 0, y: 0, z: 0 } };
    const ship = { role: "HAULER", state: "WARPING", spawnedAt: 0, warpAttempts: 0, warpAt: 1000, warpMode: "align",
      targetPoint: { x: 1e9, y: 0, z: 0 } };
    const due = 1000 + S.alignTimeoutMs;
    assert.deepStrictEqual(stepShip(ship, far, due, S), { kind: "warp", immediate: true });
    assert.deepStrictEqual(stepShip(ship, far, due - 1, S), { kind: "none" });
    assert.deepStrictEqual(stepShip(ship, { ...far, inWarp: true }, due, S), { kind: "none" });
    assert.deepStrictEqual(stepShip({ ...ship, warpMode: "immediate" }, far, due, S), { kind: "none" });
    assert.deepStrictEqual(stepShip(ship, { ...far, position: { x: 1e9, y: 0, z: 0 } }, due, S), { kind: "arrived" });
  });

  test("TAL2 service: flag off calls warpTo with three arguments, flag on asks for align and the timeout clears "
    + "the order once; a fallback warp counts alignFellBack; config defaults and clamp", () => {
    const off = harness(T({ stationTargetPermille: 0 }), true);
    off.step(0);
    off.step(T().departDelayMs);
    assert.ok(off.warps.length > 0 && off.warps.every((a) => a.length === 3), "flag off: spec as before");

    const S = T({ alignBeforeWarpEnabled: true, stationTargetPermille: 0 });
    const on = harness(S, true);
    on.step(0);
    on.step(S.departDelayMs);
    const n = on.warps.length;
    assert.ok(n > 0 && on.warps.every((a) => a.length === 4 && a[3].align === true && !("clearAlignOrder" in a[3])));
    on.step(S.alignTimeoutMs - 1);
    assert.strictEqual(on.warps.length, n, "no rescue before the timeout");
    on.step(1);
    assert.deepStrictEqual(on.warps.slice(n).map((a) => a[3]), Array.from({ length: n }, () => ({ clearAlignOrder: true })));
    let c = on.traffic.status().counters;
    assert.deepStrictEqual([c.alignWarps, c.alignTimeouts, c.alignFellBack], [n, n, 0]);
    const first = new Set(on.warps.slice(0, n).map((a) => a[1]));
    on.step(S.alignTimeoutMs);
    const rescues = on.warps.filter((a) => first.has(a[1]) && a[3] && a[3].clearAlignOrder === true);
    assert.strictEqual(rescues.length, n, "a second timeout never happens");

    const fallback = harness(S, false);
    fallback.step(0);
    fallback.step(S.departDelayMs);
    fallback.step(S.alignTimeoutMs);
    c = fallback.traffic.status().counters;
    assert.deepStrictEqual([c.alignWarps, c.alignTimeouts, c.alignFellBack], [0, 0, fallback.warps.length]);

    const d = trafficOf();
    assert.deepStrictEqual([d.alignBeforeWarpEnabled, d.alignTimeoutMs], [false, 30000]);
    const hi = trafficOf({ EVEJS_LNE_HIGHSEC_LIFE_TRAFFIC_ALIGN_BEFORE_WARP_ENABLED: "1",
      EVEJS_LNE_HIGHSEC_LIFE_TRAFFIC_ALIGN_TIMEOUT_MS: "1" });
    assert.deepStrictEqual([hi.alignBeforeWarpEnabled, hi.alignTimeoutMs], [true, 5000]);
  });
};
