"use strict";

const assert = require("node:assert");
const path = require("node:path");

const { resolveConfig } = require("../../config");
const { trafficSettingsOf } = require("../../lib/highsecLife/schema");
const { arrivalPoseOf } = require("../../lib/highsecLife/traffic/plan");
const { createTraffic } = require("../../lib/highsecLife/traffic/service");
const { TRAFFIC_HAULER_PROFILES } = require("../../lib/adapter/data/trafficProfiles");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const T0 = Date.UTC(2026, 10, 27, 18, 0, 0);
const SYS = 30000144;
const EPS = 1e-9;

function trafficOf(env) {
  return resolveConfig({ modDir: MOD_DIR, env: env || {} }).config.highsecLife.traffic;
}

function T(over) {
  const r = trafficSettingsOf({ highsecLife: { traffic: { ...trafficOf(), ...(over || {}) } } });
  assert.ok(r.ok, JSON.stringify(r));
  return r.settings;
}

function seq(values) {
  const rng = () => {
    rng.calls += 1;
    return values[(rng.calls - 1) % values.length];
  };
  rng.calls = 0;
  return rng;
}

function turnDeg(direction, from, to) {
  const h = Math.atan2(to.x - from.x, to.z - from.z);
  const d = Math.atan2(direction.x, direction.z);
  let a = (d - h) * 180 / Math.PI;
  while (a > 180) a -= 360;
  while (a < -180) a += 360;
  return a;
}

const node = (itemId, x) => ({ itemId, position: { x, y: 0, z: 0 }, radius: 5000 });
const NODES = Object.freeze({ gates: [node(50001, 0), node(50002, 1e9)], stations: [node(60001, 5e8)] });

function harness(settings, opts) {
  const o = opts || {};
  const clock = { t: T0, now() { return clock.t; } };
  const presence = { observedSystems: () => [SYS], getSystemPresence: () => ({ space: 1 }) };
  const specs = [];
  const alive = new Map();
  let next = 9000;
  const rng = () => {
    rng.calls += 1;
    return 0;
  };
  rng.calls = 0;
  const scene = {
    readNodes: () => ({ ok: true, gates: NODES.gates, stations: NODES.stations }),
    readPlayers: () => ({ ok: true, ships: [{ characterId: 1 }] }),
    spawnCivilian: (_id, spec) => {
      specs.push(spec);
      next += 1;
      alive.set(next, { x: 0, y: 0, z: 0 });
      const out = { ok: true, entityId: next };
      if (spec.jumpInMs !== undefined) out.jumpIn = true;
      if (spec.gateEvents === true) out.arrival = true;
      if (spec.arrivalPose) {
        out.posed = true;
        out.rotated = spec.arrivalPose.rotate === true && o.rotateSent !== false;
      }
      return out;
    },
    presentGateDeparture: () => ({ ok: true, sent: true, queued: 1 }),
    warpTo: (_id, entityId, point) => {
      alive.set(entityId, point);
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
    presentGateJumpOut: () => ({ ok: true, sent: true }),
  };
  const made = createTraffic({ settings, scene, clock, rng, getPresence: () => presence,
    describeSystem: () => ({ secClass: "highsec" }), wantedOf: () => 45, profiles: TRAFFIC_HAULER_PROFILES,
    getGovernor: () => ({ admits: () => true }) });
  assert.ok(made.ok, JSON.stringify(made));
  const step = (ms) => {
    clock.t += ms;
    made.traffic.tick();
  };
  return { traffic: made.traffic, step, specs, rng };
}

module.exports = ({ test }) => {
  test("GAP1 arrival pose: point on the gate circle at the gate height, turn inside the band with the sign of the "
    + "third draw, exact turn when min equals max, a target straight above the gate has no heading, always three draws",
  () => {
    const gate = { position: { x: 1000, y: 250, z: -4000 }, radius: 8000 };
    const face = { x: 9e8, y: 1e5, z: 3e8 };
    const band = { gateArrivalTurnMinDeg: 60, gateArrivalTurnMaxDeg: 120 };
    const a = seq([0.25, 0.5, 0.9]);
    const p = arrivalPoseOf(gate, face, 11000, a, band);
    assert.ok(p.ok, JSON.stringify(p));
    assert.strictEqual(a.calls, 3);
    assert.ok(Math.abs(Math.hypot(p.position.x - 1000, p.position.z + 4000) - 11000) < 1e-6);
    assert.strictEqual(p.position.y, 250);
    assert.ok(Math.abs(p.position.x - 1000) < 1e-6 && p.position.z > -4000, "az = 0.25 turn lands on +z");
    assert.ok(Math.abs(Math.hypot(p.direction.x, p.direction.z) - 1) < EPS && p.direction.y === 0);
    const turn = turnDeg(p.direction, p.position, face);
    assert.ok(Math.abs(turn - 90) < 1e-6, `turn ${turn}`);

    const b = seq([0.6, 0.0, 0.1]);
    const q = arrivalPoseOf(gate, face, 11000, b, band);
    assert.ok(Math.abs(turnDeg(q.direction, q.position, face) + 60) < 1e-6, "low third draw turns the other way");

    const exact = arrivalPoseOf(gate, face, 0, seq([0.1, 0.77, 0.7]),
      { gateArrivalTurnMinDeg: 75, gateArrivalTurnMaxDeg: 75 });
    assert.ok(Math.abs(turnDeg(exact.direction, exact.position, face) - 75) < 1e-6);

    for (let i = 0; i < 50; i += 1) {
      const r = seq([(i * 0.37) % 1, (i * 0.61) % 1, (i * 0.13) % 1]);
      const s = arrivalPoseOf(gate, face, 11000, r, band);
      const t = Math.abs(turnDeg(s.direction, s.position, face));
      assert.ok(t >= 60 - 1e-6 && t <= 120 + 1e-6, `sample ${i} turn ${t}`);
    }

    const up = seq([0.3, 0.3, 0.3]);
    assert.deepStrictEqual(arrivalPoseOf(gate, { x: 1000, y: 9e9, z: -4000 }, 0, up, band),
      { ok: false, reason: "NO_HEADING" });
    assert.strictEqual(up.calls, 3);
    const none = seq([0.3]);
    assert.strictEqual(arrivalPoseOf(gate, face, -1, none, band).reason, "INVALID_INPUT");
    assert.strictEqual(arrivalPoseOf(gate, face, 1, none, { gateArrivalTurnMinDeg: 90, gateArrivalTurnMaxDeg: 80 })
      .reason, "INVALID_INPUT");
    assert.strictEqual(none.calls, 0);
  });

  test("GAP3 traffic: flag off sends no pose and draws nothing extra, flag on poses gate haulers only, the budget "
    + "is shared with the gate controller events and Arrival takes it first", () => {
    const base = { stationTargetPermille: 0 };
    const off = harness(T(base));
    off.step(0);
    off.step(1);
    const on = harness(T({ ...base, gateArrivalPoseEnabled: true }));
    on.step(0);
    on.step(1);
    const n = on.specs.length;
    assert.ok(n >= 2, `spawns ${n}`);
    assert.ok(off.specs.every((s) => !("arrivalPose" in s)), "flag off: spec unchanged");
    assert.deepStrictEqual(on.specs.map(({ arrivalPose, ...rest }) => rest), off.specs);
    assert.strictEqual(off.rng.calls, on.rng.calls - 3 * n, "three draws per pose and none with the flag off");
    for (const s of on.specs) {
      assert.strictEqual(s.gateId, 50001);
      assert.deepStrictEqual(s.arrivalPose.position, { x: 5000 + T().spawnOffsetMeters, y: 0, z: 0 });
      assert.ok(Math.abs(Math.atan2(s.arrivalPose.direction.x, s.arrivalPose.direction.z) - Math.PI / 6) < 1e-9);
      assert.strictEqual(s.arrivalPose.rotate, true);
    }
    let c = on.traffic.status().counters;
    assert.deepStrictEqual([c.gateArrivalPoses, c.gateArrivalRotations, c.gateArrivalPoseFailed,
      c.gateArrivalNoHeading, c.gateEventBudgetCut], [n, n, 0, 0, 0]);

    const idle = harness(T({ ...base, gateArrivalPoseEnabled: true, gateIdleEnabled: true, gateIdlePermille: 1000 }));
    idle.step(0);
    assert.ok(idle.specs.length > 0 && idle.specs.every((s) => s.gateId && !("arrivalPose" in s)), "gate idle");
    const undock = harness(T({ ...base, gateArrivalPoseEnabled: true, undockEnabled: true, undockPermille: 1000 }));
    undock.step(0);
    assert.ok(undock.specs.length > 0 && undock.specs.every((s) => s.undock === true && !("arrivalPose" in s)));

    const tight = harness(T({ ...base, gateArrivalPoseEnabled: true, gateControllerEventMaxPerPass: 1 }));
    tight.step(0);
    tight.step(1);
    assert.deepStrictEqual(tight.specs.map((s) => s.arrivalPose.rotate),
      [true, ...Array(tight.specs.length - 1).fill(false)]);
    c = tight.traffic.status().counters;
    assert.deepStrictEqual([c.gateArrivalPoses, c.gateArrivalRotations, c.gateEventBudgetCut],
      [tight.specs.length, 1, tight.specs.length - 1]);

    const shared = harness(T({ ...base, gateArrivalPoseEnabled: true, gateJumpFxEnabled: true,
      gateControllerEventsEnabled: true, gateControllerEventMaxPerPass: 1 }));
    shared.step(0);
    shared.step(1);
    assert.strictEqual(shared.specs[0].gateEvents, true, "Arrival takes the budget");
    assert.ok(shared.specs.every((s) => s.arrivalPose.rotate === false), "no budget left for the rotation");

    const failed = harness(T({ ...base, gateArrivalPoseEnabled: true }), { rotateSent: false });
    failed.step(0);
    failed.step(1);
    c = failed.traffic.status().counters;
    assert.deepStrictEqual([c.gateArrivalPoses, c.gateArrivalRotations, c.gateArrivalPoseFailed],
      [failed.specs.length, 0, failed.specs.length]);
  });

  test("GAP5 config: arrival pose defaults, turn band order checked by trafficSettingsOf", () => {
    const d = trafficOf();
    assert.deepStrictEqual([d.gateArrivalPoseEnabled, d.gateArrivalTurnMinDeg, d.gateArrivalTurnMaxDeg],
      [false, 60, 120]);
    const env = trafficOf({ EVEJS_LNE_HIGHSEC_LIFE_TRAFFIC_GATE_ARRIVAL_POSE_ENABLED: "1",
      EVEJS_LNE_HIGHSEC_LIFE_TRAFFIC_GATE_ARRIVAL_TURN_MIN_DEG: "0",
      EVEJS_LNE_HIGHSEC_LIFE_TRAFFIC_GATE_ARRIVAL_TURN_MAX_DEG: "180" });
    assert.deepStrictEqual([env.gateArrivalPoseEnabled, env.gateArrivalTurnMinDeg, env.gateArrivalTurnMaxDeg],
      [true, 0, 180]);
    const S = T({ gateArrivalPoseEnabled: true, gateArrivalTurnMinDeg: 30, gateArrivalTurnMaxDeg: 30 });
    assert.deepStrictEqual([S.gateArrivalPoseEnabled, S.gateArrivalTurnMinDeg, S.gateArrivalTurnMaxDeg],
      [true, 30, 30]);
    const bad = trafficSettingsOf({ highsecLife: { traffic: { ...trafficOf(), gateArrivalTurnMinDeg: 121 } } });
    assert.deepStrictEqual(bad, { ok: false, reason: "INVALID_SETTINGS",
      detail: "traffic.gateArrivalTurnMinDeg>gateArrivalTurnMaxDeg" });
  });
};
