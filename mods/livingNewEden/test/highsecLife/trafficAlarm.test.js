"use strict";

const assert = require("node:assert");
const os = require("node:os");
const path = require("node:path");

const { resolveConfig } = require("../../config");
const { trafficSettingsOf } = require("../../lib/highsecLife/schema");
const { noteAggression, planAlarm, canFlee } = require("../../lib/highsecLife/traffic/flee");
const { createTraffic } = require("../../lib/highsecLife/traffic/service");
const { TRAFFIC_HAULER_PROFILES } = require("../../lib/adapter/data/trafficProfiles");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const T0 = Date.UTC(2026, 10, 27, 22, 0, 0);
const SYS = 30000144;
const DEFAULTS = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_DATA_ROOT: os.tmpdir() } }).config;

function T(over, hulls = false) {
  const r = trafficSettingsOf({ highsecLife: { civilianHullsEnabled: hulls,
    traffic: { ...DEFAULTS.highsecLife.traffic, ...(over || {}) } } });
  assert.ok(r.ok, JSON.stringify(r));
  return r.settings;
}

const node = (itemId, x) => ({ itemId, position: { x, y: 0, z: 0 }, radius: 5000 });
const NODES = Object.freeze({ gates: [node(50001, 0), node(50002, 1e9)], stations: [], belts: [node(40001, 5e8)] });
const at = (x) => ({ x, y: 0, z: 0 });
const BASE = 5e5;
const ROLL = Object.freeze({ GATE_IDLE: 0.1, MINER: 0.4, RATTER: 0.7, HAULER: 0.95 });
const SCENE = Object.freeze({ fleeEnabled: true, gateIdleEnabled: true, gateIdlePermille: 300, minerEnabled: true,
  minerPermille: 300, undockEnabled: false, maxShipsPerSystem: 4, pairCivilians: 500, spawnIntervalMs: 1000,
  departDelayMs: 10000, gateIdleMinMs: 600000, gateIdleMaxMs: 600000, alignBeforeWarpEnabled: true,
  gateJumpFxEnabled: false, miningBeamsEnabled: false, maxLifetimeMs: 3600000 });

function harness(settings) {
  const clock = { t: T0, now() { return clock.t; } };
  const presence = { observedSystems: () => [SYS], getSystemPresence: () => ({ space: 1 }) };
  const log = [];
  const reads = [];
  const alive = new Map();
  const hits = new Map();
  const roll = { v: ROLL.HAULER };
  let next = 9000;
  const scene = {
    readNodes: () => ({ ok: true, ...NODES }),
    readPlayers: () => ({ ok: true, ships: [{ characterId: 1 }] }),
    spawnCivilian: () => {
      next += 1;
      alive.set(next, at(0));
      log.push(["spawn", next]);
      return { ok: true, entityId: next };
    },
    warpTo: (_sys, entityId, point, o) => {
      log.push(["warp", entityId, point, o]);
      alive.set(entityId, point);
      return { ok: true, warped: true, ...(o && o.align === true ? { aligned: true } : {}) };
    },
    readShips: (...args) => {
      reads.push(args);
      const [, ids, o] = args;
      return { ok: true, sceneLoaded: true,
        live: ids.filter((e) => alive.has(e)).map((e) => ({ entityId: e, position: alive.get(e), inWarp: false,
          ...(o && o.aggression === true ? { playerAggressedAt: hits.get(e) || 0 } : {}) })),
        gone: ids.filter((e) => !alive.has(e)) };
    },
    despawn: (_id, ids) => {
      for (const e of ids) alive.delete(e);
      log.push(["despawn", [...ids]]);
      return { ok: true, removed: ids.length, missing: 0 };
    },
    listTrafficIds: () => ({ ok: true, ids: [] }),
    dockPointOf: () => ({ ok: false, reason: "NO_STATION" }),
    presentPatrolOrbit: (_sys, entityId) => {
      log.push(["orbit", entityId]);
      return { ok: true, orbiting: true };
    },
    releasePatrolMotion: (_sys, entityId) => {
      log.push(["release", entityId]);
      return { ok: true, released: true };
    },
  };
  const made = createTraffic({ settings, scene, clock, rng: () => roll.v, getPresence: () => presence,
    describeSystem: () => ({ secClass: "highsec" }), wantedOf: () => 200, profiles: TRAFFIC_HAULER_PROFILES,
    getGovernor: () => ({ admits: () => true }) });
  assert.ok(made.ok, JSON.stringify(made));
  const step = (ms, nextRoll) => {
    if (nextRoll !== undefined) roll.v = nextRoll;
    clock.t += ms;
    made.traffic.tick();
  };
  const spawned = () => log.filter((e) => e[0] === "spawn").map((e) => e[1]);
  const warpsOf = (id) => log.filter((e) => e[0] === "warp" && e[1] === id);
  return { step, log, reads, alive, hits, spawned, warpsOf, counters: () => made.traffic.status().counters };
}

function gridScene(settings) {
  const h = harness(settings);
  h.step(0);
  h.step(1000, ROLL.MINER);
  h.step(1000, ROLL.GATE_IDLE);
  h.step(1000, ROLL.GATE_IDLE);
  h.step(settings.departDelayMs - 2000, ROLL.HAULER);
  h.step(1000);
  const [miner, idler, far, hauler] = h.spawned();
  assert.strictEqual(h.warpsOf(miner).length, 1, "the miner reached its belt");
  h.alive.set(hauler, at(BASE));
  h.alive.set(miner, at(BASE + 12000));
  h.alive.set(idler, at(BASE + 40000));
  h.alive.set(far, at(BASE + 300000));
  h.step(1000);
  return { h, miner, idler, far, hauler, warpsBefore: h.log.filter((e) => e[0] === "warp").length };
}

module.exports = ({ test }) => {
  test("GA1 planAlarm: radius, victim excluded, arrived and jumping skipped, fleeing skipped, nearest within the "
    + "budget, budget 0", () => {
    const S = T({ fleeEnabled: true, fleeAlarmEnabled: true, fleeAlarmMeters: 100000 });
    const now = 1000;
    const entry = (entityId, x, over) => ({ ship: { entityId, role: "MINER", state: "MINING", ...(over || {}) },
      seen: { live: true, inWarp: false, position: at(x) } });
    const victims = [{ entityId: 1, position: at(0) }];
    const ships = [entry(1, 0, { role: "HAULER", state: "RUNNING" }), entry(2, 30000), entry(3, 150000),
      entry(4, 10000, { state: "ARRIVED" }), entry(5, 10000, { state: "JUMPING" }),
      entry(6, 5000, { fleeUntil: now + 1 }), entry(7, 80000, { role: "GATE_IDLE", state: "IDLING" }),
      entry(8, 20000, { role: "RATTER", state: "DWELLING" })];
    assert.deepStrictEqual(planAlarm({ now, T: S, victims, ships, budget: 8 }), { alarmed: [2, 7, 8], cut: 0 });
    assert.deepStrictEqual(planAlarm({ now, T: S, victims, ships, budget: 1 }), { alarmed: [8], cut: 2 });
    assert.deepStrictEqual(planAlarm({ now, T: S, victims, ships, budget: 0 }), { alarmed: [], cut: 3 });
    const two = [{ entityId: 1, position: at(0) }, { entityId: 9, position: at(140000) }];
    assert.deepStrictEqual(planAlarm({ now, T: S, victims: two, ships, budget: 8 }).alarmed, [2, 3, 7, 8]);
    const off = T({ fleeEnabled: true });
    assert.deepStrictEqual(planAlarm({ now, T: off, victims, ships, budget: 8 }), { alarmed: [], cut: 0 });
    assert.strictEqual(canFlee({ role: "MINER", state: "MINING" }, off), false);
    assert.strictEqual(canFlee({ role: "MINER", state: "MINING" }, S), true);
  });

  test("GA2 alarm on: a player hits the hauler, the hauler, a mining miner at 12 km and a gate idler at 40 km warp "
    + "away with align, a ship 300 km off stays, the miner arrives instead of mining", () => {
    const S = T({ ...SCENE, fleeAlarmEnabled: true });
    const { h, miner, idler, far, hauler, warpsBefore } = gridScene(S);
    h.hits.set(hauler, 4242);
    h.step(1000);
    const fled = h.log.filter((e) => e[0] === "warp").slice(warpsBefore);
    assert.deepStrictEqual(fled.map((e) => e[1]).sort((a, b) => a - b), [miner, idler, hauler].sort((a, b) => a - b));
    for (const e of fled) {
      assert.deepStrictEqual(e[3], { align: true });
      assert.ok(BASE - e[2].x >= S.fleeMinMeters, JSON.stringify(e));
    }
    assert.ok(h.reads.every((a) => a[2] && a[2].aggression === true));
    let c = h.counters();
    assert.deepStrictEqual([c.fleeTriggered, c.fleeAlarmVictims, c.fleeAlarmed, c.fleeAlarmBudgetCut, c.fleeWarps],
      [1, 1, 2, 0, 3]);
    const arrivedBefore = c.arrived;
    h.step(1000);
    assert.strictEqual(h.log.filter((e) => e[0] === "warp").length, warpsBefore + 3, "one order per flee window");
    c = h.counters();
    assert.strictEqual(c.arrived - arrivedBefore, 3, "the miner lands as arrived, not mining");
    assert.strictEqual(h.warpsOf(far).length, 0);
  });

  test("GA3 alarm off keeps the hauler-only flee: the same scene warps only the hit hauler, a hit miner stays", () => {
    const S = T(SCENE);
    const { h, miner, hauler, warpsBefore } = gridScene(S);
    h.hits.set(hauler, 4242);
    h.step(1000);
    const fled = h.log.filter((e) => e[0] === "warp").slice(warpsBefore);
    assert.deepStrictEqual(fled.map((e) => e[1]), [hauler]);
    let c = h.counters();
    assert.deepStrictEqual([c.fleeTriggered, c.fleeWarps, c.fleeAlarmed, c.fleeAlarmVictims, c.fleeAlarmBudgetCut],
      [1, 1, 0, 0, 0]);
    h.hits.set(miner, 5151);
    h.step(1000);
    assert.strictEqual(h.warpsOf(miner).length, 1, "a hit miner does not flee with the alarm off");
    c = h.counters();
    assert.strictEqual(c.fleeTriggered, 1);

    const solo = harness(T({ ...SCENE, maxShipsPerSystem: 1 }));
    solo.step(0);
    solo.step(1000, ROLL.MINER);
    solo.step(1000);
    assert.ok(solo.reads.length > 0 && solo.reads.every((a) => a.length === 2), "no hauler = a plain read");
  });

  test("GA4 only a player raises the alarm: an aggressor without a session reads 0 and nothing changes", () => {
    const S = T({ ...SCENE, fleeAlarmEnabled: true });
    const ship = { entityId: 1, role: "MINER", state: "MINING", leg: "BELT", mineUntil: 5000 };
    const before = { ...ship };
    assert.strictEqual(noteAggression(ship, { playerAggressedAt: 0 }, 1000, S), false);
    assert.deepStrictEqual(planAlarm({ now: 1000, T: S, victims: [], budget: 8,
      ships: [{ ship, seen: { live: true, position: at(0) } }] }), { alarmed: [], cut: 0 });
    assert.deepStrictEqual(ship, before);

    const { h, warpsBefore } = gridScene(S);
    h.step(1000);
    assert.strictEqual(h.log.filter((e) => e[0] === "warp").length, warpsBefore);
    const c = h.counters();
    assert.deepStrictEqual([c.fleeTriggered, c.fleeAlarmed, c.fleeAlarmVictims, c.fleeWarps], [0, 0, 0, 0]);
  });

  test("GA5 an alarmed ratter dwelling in orbit releases the orbit before the flee warp and lands on its exit leg; "
    + "alarm config defaults, clamp and env", () => {
    const S = T({ ...SCENE, ratterEnabled: true, ratterPermille: 300, ratterMaxPerSystem: 1, maxShipsPerSystem: 2,
      fleeAlarmEnabled: true, ratterDwellMinMs: 600000, ratterDwellMaxMs: 600000 }, true);
    const h = harness(S);
    h.step(0);
    h.step(1000, ROLL.RATTER);
    h.step(1000, ROLL.GATE_IDLE);
    h.step(S.departDelayMs - 1000);
    h.step(1000);
    const [ratter, idler] = h.spawned();
    assert.ok(h.log.some((e) => e[0] === "orbit" && e[1] === ratter), "the ratter orbits its belt");
    h.alive.set(idler, at(BASE));
    h.alive.set(ratter, at(BASE + 20000));
    h.step(1000);
    const mark = h.log.length;
    h.hits.set(idler, 777);
    h.step(1000);
    const mine = h.log.slice(mark).filter((e) => e[1] === ratter).map((e) => e[0]);
    assert.deepStrictEqual(mine, ["release", "warp"]);
    const flight = h.warpsOf(ratter).at(-1);
    assert.ok(Math.abs(flight[2].x - (BASE + 20000)) >= S.fleeMinMeters, JSON.stringify(flight));
    const arrivedBefore = h.counters().arrived;
    h.step(1000);
    const c = h.counters();
    assert.deepStrictEqual([c.arrived - arrivedBefore, c.fleeAlarmed, c.patrolReleased], [2, 1, 1]);
    assert.strictEqual(h.log.filter((e) => e[0] === "orbit" && e[1] === ratter).length, 1, "no new dwell");

    const d = DEFAULTS.highsecLife.traffic;
    assert.deepStrictEqual([d.fleeAlarmEnabled, d.fleeAlarmMeters, d.fleeAlarmMaxPerPass], [false, 100000, 8]);
    const env = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_DATA_ROOT: os.tmpdir(),
      EVEJS_LNE_HIGHSEC_LIFE_TRAFFIC_FLEE_ALARM_ENABLED: "1",
      EVEJS_LNE_HIGHSEC_LIFE_TRAFFIC_FLEE_ALARM_METERS: "5",
      EVEJS_LNE_HIGHSEC_LIFE_TRAFFIC_FLEE_ALARM_MAX_PER_PASS: "999" } });
    const e = env.config.highsecLife.traffic;
    assert.deepStrictEqual([e.fleeAlarmEnabled, e.fleeAlarmMeters, e.fleeAlarmMaxPerPass], [true, 1000, 50]);
  });
};
