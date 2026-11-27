"use strict";

const assert = require("node:assert");
const path = require("node:path");

const { resolveConfig } = require("../../config");
const { trafficSettingsOf } = require("../../lib/highsecLife/schema");
const { createTraffic } = require("../../lib/highsecLife/traffic/service");
const { followMetersOf } = require("../../lib/util/miningBeamPlan");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const T0 = Date.UTC(2026, 10, 27, 20, 0, 0);
const SYS = 30000144;
const SYS2 = 30000145;
const BELT = 40001;

function trafficOf(env) {
  return resolveConfig({ modDir: MOD_DIR, env: env || {} }).config.highsecLife.traffic;
}

function T(over) {
  const r = trafficSettingsOf({ highsecLife: { traffic: { ...trafficOf(), minerEnabled: true, minerPermille: 1000,
    spawnIntervalMs: 3600000, ...(over || {}) } } });
  assert.ok(r.ok, JSON.stringify(r));
  return r.settings;
}

const node = (itemId, x) => ({ itemId, position: { x, y: 0, z: 0 }, radius: 5000 });
const NODES = Object.freeze({ gates: [node(50001, 0), node(50002, 1e9)], stations: [], belts: [node(BELT, 3e8)] });

function harness(settings, opts) {
  const o = opts || {};
  const clock = { t: T0, now() { return clock.t; } };
  const systems = o.systems || [SYS];
  const presence = { observedSystems: () => systems, getSystemPresence: () => ({ space: 1 }) };
  const alive = new Map();
  const beams = [];
  let reads = 0;
  let next = 9000;
  const scene = {
    readNodes: () => ({ ok: true, ...NODES }),
    readPlayers: () => {
      reads += 1;
      return { ok: true, ships: [{ characterId: 1, entityId: 1e9, position: { x: 3e8, y: 0, z: 0 }, inWarp: false }] };
    },
    spawnCivilian: () => {
      next += 1;
      alive.set(next, { x: 0, y: 0, z: 0 });
      return { ok: true, entityId: next };
    },
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
  };
  if (o.approach === true) {
    scene.presentMiningBeams = (systemId, req) => {
      beams.push([systemId, req]);
      const n = Math.min(req.maxFx, req.start.length);
      return { ok: true, started: [], released: (req.release || []).slice(), stopped: 0, noRock: [], skipped: [],
        busy: [], refused: 0, fxSent: 0, ordersSent: n, budgetCut: req.start.length - n,
        approaching: req.start.slice(0, n).map((s) => ({ entityId: s.entityId, rockId: 700 + s.entityId })) };
    };
  } else if (o.noSeam !== true) {
    scene.presentMiningBeams = (systemId, req) => {
      beams.push([systemId, req]);
      const n = Math.min(req.maxFx, req.stop.length + req.start.length);
      const stops = Math.min(n, req.stop.length);
      const started = req.start.slice(0, n - stops).map((s) => ({ entityId: s.entityId, rockId: 700 + s.entityId }));
      return { ok: true, started, stopped: stops, noRock: [], skipped: [], fxSent: n,
        budgetCut: req.stop.length + req.start.length - n };
    };
  }
  const made = createTraffic({ settings, scene, clock, rng: () => 0, getPresence: () => presence,
    describeSystem: () => ({ secClass: "highsec" }), wantedOf: () => 45,
    profiles: [{ profileId: "vendor", weight: 1 }], getGovernor: () => ({ admits: () => true }) });
  assert.ok(made.ok, JSON.stringify(made));
  const step = (ms) => {
    clock.t += ms;
    made.traffic.tick();
  };
  const toMining = () => {
    step(0);
    step(settings.departDelayMs);
    step(1);
  };
  return { traffic: made.traffic, step, toMining, beams, reads: () => reads, alive };
}

module.exports = ({ test }) => {
  test("TMF1 flag off = no beam call and no extra readPlayers; a miner in MINING with a player near = one call "
    + "with starts; two systems share the budget of the pass; config defaults", () => {
    const off = harness(T());
    off.toMining();
    const bare = harness(T({ miningBeamsEnabled: true }), { noSeam: true });
    bare.toMining();
    assert.deepStrictEqual([off.beams.length, off.reads()], [0, bare.reads()]);

    const S = T({ miningBeamsEnabled: true });
    const on = harness(S);
    on.toMining();
    assert.strictEqual(on.beams.length, 1);
    const [systemId, req] = on.beams[0];
    const miners = [...on.alive.keys()];
    assert.deepStrictEqual([systemId, req.stop, req.rockRangeMeters, req.maxFx],
      [SYS, [], S.miningBeamRockMeters, S.miningBeamMaxFxPerPass]);
    assert.deepStrictEqual(req.start, miners.map((entityId) => ({ entityId, beltId: BELT })));
    assert.strictEqual(on.reads(), off.reads() + 1, "one readPlayers for the beams");
    let c = on.traffic.status().counters;
    assert.deepStrictEqual([c.miningBeamRefresh, c.miningBeamFx, c.miningBeamBudgetCut], [1, miners.length, 0]);
    on.step(1);
    assert.strictEqual(on.beams.length, 1, "shown beams and the same viewer = no call");

    const budget = miners.length + 1;
    const two = harness(T({ miningBeamsEnabled: true, miningBeamMaxFxPerPass: budget }), { systems: [SYS, SYS2] });
    two.toMining();
    assert.deepStrictEqual(two.beams.map(([id, r]) => [id, r.maxFx]), [[SYS, budget], [SYS2, 1]]);
    c = two.traffic.status().counters;
    assert.deepStrictEqual([c.miningBeamFx, c.miningBeamBudgetCut], [budget, miners.length - 1]);
    two.step(1);
    assert.deepStrictEqual(two.beams.slice(2).map(([id, r]) => [id, r.start.length]), [[SYS2, miners.length - 1]],
      "the cut beams come back in the next pass");

    const d = trafficOf();
    assert.deepStrictEqual([d.miningBeamsEnabled, d.miningBeamViewMeters, d.miningBeamRockMeters,
      d.miningBeamRefreshMs, d.miningBeamMaxFxPerPass], [false, 150000, 60000, 30000, 40]);
  });

  test("TMF2 approach flag off = request without approach; on = approach from config, follow orders take the "
    + "beam budget of the pass, a miner that left MINING is released", () => {
    const off = harness(T({ miningBeamsEnabled: true }));
    off.toMining();
    assert.deepStrictEqual(["approach" in off.beams[0][1], "release" in off.beams[0][1]], [false, false]);

    const stay = { minerStayMinMs: 10000, minerStayMaxMs: 10000 };
    const S = T({ miningBeamsEnabled: true, miningBeamApproachEnabled: true, ...stay });
    const one = harness(S, { approach: true });
    one.toMining();
    const miners = [...one.alive.keys()];
    const [, req] = one.beams[0];
    assert.deepStrictEqual([req.approach, req.release, req.start.length],
      [{ startMeters: S.miningBeamStartMeters, followMeters: S.miningBeamApproachMeters }, [], miners.length]);
    let c = one.traffic.status().counters;
    assert.deepStrictEqual([c.miningBeamApproachOrders, c.miningBeamApproaching, c.miningBeamFx],
      [miners.length, miners.length, 0]);
    one.step(1);
    assert.strictEqual(one.beams.length, 1, "approaching before retryAt = no call");

    one.step(stay.minerStayMinMs);
    const last = one.beams[one.beams.length - 1][1];
    assert.deepStrictEqual([last.start, [...last.release].sort()], [[], [...miners].sort()]);
    c = one.traffic.status().counters;
    assert.strictEqual(c.miningBeamApproachReleased, miners.length);

    const budget = miners.length + 1;
    const two = harness(T({ miningBeamsEnabled: true, miningBeamApproachEnabled: true, miningBeamMaxFxPerPass: budget }),
      { systems: [SYS, SYS2], approach: true });
    two.toMining();
    assert.deepStrictEqual(two.beams.map(([id, r]) => [id, r.maxFx]), [[SYS, budget], [SYS2, 1]]);
  });

  test("TMF3 approach config: defaults off, follow range kept below the start range in traffic and exposure "
    + "settings", () => {
    const d = trafficOf();
    assert.deepStrictEqual([d.miningBeamApproachEnabled, d.miningBeamStartMeters, d.miningBeamApproachMeters,
      d.miningBeamRetryMs], [false, 10000, 7500, 5000]);
    assert.strictEqual(T().miningBeamApproachMeters, 7500);
    const env = { EVEJS_LNE_HIGHSEC_LIFE_TRAFFIC_MINING_BEAM_APPROACH_METERS: "20000",
      EVEJS_LNE_FLEET_EXPOSURE_MINER_BEAM_APPROACH_METERS: "20000" };
    const raised = trafficSettingsOf({ highsecLife: { traffic: trafficOf(env) } });
    assert.deepStrictEqual([raised.ok, raised.settings.miningBeamStartMeters, raised.settings.miningBeamApproachMeters],
      [true, 10000, 9000]);
    const fe = resolveConfig({ modDir: MOD_DIR, env: {} }).config.fleetExposure;
    assert.deepStrictEqual([fe.minerBeamApproachEnabled, fe.minerBeamStartMeters, fe.minerBeamApproachMeters,
      fe.minerBeamRetryMs], [false, 10000, 7500, 5000]);
    const feRaised = resolveConfig({ modDir: MOD_DIR, env }).config.fleetExposure;
    assert.strictEqual(followMetersOf(feRaised.minerBeamApproachMeters, feRaised.minerBeamStartMeters), 9000);
  });
};
