"use strict";

const assert = require("node:assert");
const os = require("node:os");
const path = require("node:path");

const { resolveConfig } = require("../../config");
const { trafficSettingsOf } = require("../../lib/highsecLife/schema");
const { createTraffic } = require("../../lib/highsecLife/traffic/service");
const { pickRole, pickRatterRoute, planPilot, stepShip, isExpired, SHIP_STATE } = require("../../lib/highsecLife/traffic/plan");
const { createRng } = require("../../lib/util/rng");
const CIV = require("../../lib/adapter/data/civilianLiveProfiles");
const rig = require("./trafficPilots.test.js").rig;

const MOD_DIR = path.resolve(__dirname, "..", "..");
const T0 = Date.UTC(2026, 10, 27, 21, 0, 0);
const SYS = 30000144;
const DEFAULTS = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_DATA_ROOT: os.tmpdir() } }).config;

function T(over, hulls = true) {
  const r = trafficSettingsOf({ highsecLife: { civilianHullsEnabled: hulls,
    traffic: { ...DEFAULTS.highsecLife.traffic, ratterEnabled: true, ...(over || {}) } } });
  assert.ok(r.ok, JSON.stringify(r));
  return r.settings;
}

const node = (itemId, x, toSystemId) => ({ itemId, position: { x, y: 0, z: 0 }, radius: 5000,
  ...(toSystemId ? { toSystemId } : {}) });
const BELTS = Object.freeze([node(40005, 5e8), node(40001, 1e8), node(40003, 3e8), node(40002, 2e8),
  node(40004, 4e8)]);
const NODES = Object.freeze({ gates: [node(50001, 0, rig.FROM), node(50002, 1e9, rig.NEXT)], stations: [],
  belts: BELTS });

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

function counted(rng) {
  const c = { n: 0 };
  c.rng = () => {
    c.n += 1;
    return rng();
  };
  return c;
}

function legacyRole(roll, S) {
  const undock = S.undockPermille;
  if (roll < undock) return "UNDOCK";
  if (roll < undock + S.minerPermille) return "MINER";
  return "HAULER";
}

function patrolScene(opts = {}) {
  const log = [];
  const alive = new Map();
  let next = 9000;
  const scene = {
    readNodes: () => ({ ok: true, ...NODES }),
    readPlayers: () => ({ ok: true, ships: [{ characterId: 1 }] }),
    spawnCivilian: (_id, spec) => {
      next += 1;
      log.push(["spawn", next, spec]);
      alive.set(next, { x: 0, y: 0, z: 0 });
      return { ok: true, entityId: next };
    },
    warpTo: (_id, entityId, point) => {
      log.push(["warp", entityId, point]);
      alive.set(entityId, point);
      return { ok: true, warped: true };
    },
    readShips: (_id, ids) => ({ ok: true, sceneLoaded: true,
      live: ids.filter((e) => alive.has(e)).map((e) => ({ entityId: e, position: alive.get(e), inWarp: false })),
      gone: ids.filter((e) => !alive.has(e)) }),
    despawn: (_id, ids) => {
      log.push(["despawn", [...ids]]);
      for (const e of ids) alive.delete(e);
      return { ok: true, removed: ids.length, missing: 0 };
    },
    listTrafficIds: () => ({ ok: true, ids: [] }),
    dockPointOf: () => ({ ok: false, reason: "NO_STATION" }),
    presentPatrolOrbit: (systemId, entityId, targetId, o) => {
      log.push(["orbit", entityId, targetId, o]);
      return { ok: true, orbiting: opts.orbit !== false, ...(opts.orbit === false ? { reason: "REFUSED" } : {}) };
    },
    releasePatrolMotion: (_id, entityId) => {
      log.push(["release", entityId]);
      return { ok: true, released: true };
    },
  };
  return { scene, log, alive };
}

function harness(settings, opts) {
  const clock = { t: T0, now() { return clock.t; } };
  const presence = { observedSystems: () => [SYS], getSystemPresence: () => ({ space: 1 }) };
  const f = patrolScene(opts);
  const made = createTraffic({ settings, scene: f.scene, clock, rng: () => 0, getPresence: () => presence,
    describeSystem: () => ({ secClass: "highsec" }), wantedOf: () => 45,
    profiles: [{ profileId: "vendor", weight: 1 }], getGovernor: () => ({ admits: () => true }) });
  assert.ok(made.ok, JSON.stringify(made));
  const step = (ms) => {
    clock.t += ms;
    made.traffic.tick();
  };
  return { traffic: made.traffic, step, ...f };
}

module.exports = ({ test }) => {
  test("RP1 ratter route: belts in range without repeats, landing distance, dwell range, stay formula; role draw "
    + "with the flag off unchanged, full system never draws a ratter; pilot start gate / station / fallback", () => {
    const S = T({ ratterBeltsMin: 2, ratterBeltsMax: 4 });
    for (let seed = 1; seed <= 40; seed += 1) {
      const r = pickRatterRoute(NODES, createRng(seed).nextFloat, S);
      assert.ok(r.ok, JSON.stringify(r));
      const k = r.legs.length;
      assert.ok(k >= 2 && k <= 4, `k=${k}`);
      assert.strictEqual(new Set(r.legs.map((l) => l.targetId)).size, k, "no repeated belt");
      let dwell = 0;
      for (const leg of r.legs) {
        const belt = BELTS.find((b) => b.itemId === leg.targetId);
        assert.ok(Math.abs(dist(leg.point, belt.position) - S.ratterLandingMeters) < 1e-3);
        assert.ok(leg.dwellMs >= S.ratterDwellMinMs && leg.dwellMs <= S.ratterDwellMaxMs);
        dwell += leg.dwellMs;
      }
      assert.strictEqual(r.stayMs, dwell + k * S.ratterLegMs);
      assert.strictEqual(r.exit.kind, "stargate");
    }
    const one = pickRatterRoute({ ...NODES, belts: [BELTS[0]] }, createRng(3).nextFloat, S);
    assert.strictEqual(one.legs.length, 1, "never more legs than belts");
    assert.deepStrictEqual(pickRatterRoute({ ...NODES, belts: [] }, () => 0, S), { ok: false, reason: "NO_ROUTE" });

    const legacy = { undockEnabled: true, undockPermille: 200, minerEnabled: true, minerPermille: 300,
      ratterPermille: 1000 };
    const nodes = { ...NODES, stations: [node(60001, 7e8)] };
    for (const S2 of [T({ ...legacy, ratterEnabled: false }), T(legacy, false)]) {
      const src = counted(createRng(11).nextFloat);
      const ref = createRng(11).nextFloat;
      for (let i = 0; i < 200; i += 1) {
        assert.strictEqual(pickRole(src.rng, nodes, S2), legacyRole(ref() * 1000, S2));
      }
      assert.strictEqual(src.n, 200, "one draw per role");
    }
    const full = T({ ratterPermille: 1000 });
    const roles = new Set();
    for (let i = 0; i < 100; i += 1) {
      roles.add(pickRole(createRng(i + 1).nextFloat, NODES, full, { RATTER: full.ratterMaxPerSystem }));
    }
    assert.deepStrictEqual([...roles], ["HAULER"]);
    assert.strictEqual(pickRole(() => 0, NODES, full, { RATTER: 0 }), "RATTER");

    const cand = (fromSystemId) => ({ pilotId: 1, role: "RATTER", exit: "NONE", fromSystemId, toSystemId: 0 });
    const viaGate = planPilot(cand(rig.FROM), NODES, () => 0.9, S);
    assert.deepStrictEqual([viaGate.ok, viaGate.role, viaGate.patrol.start.kind, viaGate.patrol.start.node.itemId],
      [true, "RATTER", "stargate", 50001]);
    const withStation = { ...NODES, stations: [node(60001, 7e8)] };
    const activity = planPilot(cand(0), withStation, () => 0, S);
    assert.deepStrictEqual([activity.ok, activity.patrol.start.kind, activity.patrol.start.node.itemId],
      [true, "station", 60001], "an activity candidate undocks");
    assert.strictEqual(planPilot(cand(0), NODES, () => 0, S).patrol.start.kind, "stargate",
      "no station = a gate start, not NO_ROUTE");
    assert.deepStrictEqual(planPilot(cand(rig.FROM), NODES, () => 0, T({ ratterEnabled: false })),
      { ok: false, reason: "NO_ROUTE" });
    assert.deepStrictEqual(planPilot(cand(rig.FROM), NODES, () => 0, T({}, false)), { ok: false, reason: "NO_ROUTE" });
  });

  test("RP2 stepShip of a patrol: arrival on a PATROL leg = dwell, before dwellUntil none, then nextLeg, last leg "
    + "leave, EXIT arrival = arrived; isExpired adds stayMs", () => {
    const S = T();
    const p = { x: 0, y: 0, z: 0 };
    const legs = [{ kind: "BELT", targetId: 1, point: p, dwellMs: 1 }, { kind: "BELT", targetId: 2, point: p, dwellMs: 1 }];
    const seen = { live: true, inWarp: false, position: p };
    const ship = (over) => ({ role: "RATTER", state: SHIP_STATE.WARPING, leg: "PATROL", legs, legIndex: 0,
      spawnedAt: 0, warpAttempts: 0, warpMode: "immediate", targetPoint: p, stayMs: 1000, dwellUntil: null, ...over });
    assert.deepStrictEqual(stepShip(ship(), seen, 10, S), { kind: "dwell" });
    const dwelling = ship({ state: SHIP_STATE.DWELLING, dwellUntil: 100 });
    assert.deepStrictEqual(stepShip(dwelling, seen, 99, S), { kind: "none" });
    assert.deepStrictEqual(stepShip(dwelling, seen, 100, S), { kind: "nextLeg" });
    assert.deepStrictEqual(stepShip({ ...dwelling, legIndex: 1 }, seen, 100, S), { kind: "leave" });
    assert.deepStrictEqual(stepShip({ ...dwelling, warpAttempts: S.maxWarpAttempts }, seen, 50, S),
      { kind: "despawn", reason: "STUCK" });
    assert.deepStrictEqual(stepShip(ship({ leg: "EXIT" }), seen, 10, S), { kind: "arrived" });
    assert.strictEqual(isExpired(ship(), S.maxLifetimeMs + 999, S), false);
    assert.strictEqual(isExpired(ship(), S.maxLifetimeMs + 1000, S), true);
  });

  test("RP3 traffic: ratter warps to belt 1, orbits it, releases before the warp to belt 2, then exit and despawn; "
    + "refused orbit keeps the dwell; limit per system; aggro never reads a ratter; capped pilot not claimed", () => {
    const S = T({ ratterPermille: 1000, ratterMaxPerSystem: 1, ratterBeltsMin: 2, ratterBeltsMax: 2,
      spawnIntervalMs: 3600000 });
    const h = harness(S);
    h.step(0);
    const spawned = h.log.filter((e) => e[0] === "spawn");
    assert.strictEqual(spawned.length, 2);
    const id = spawned[0][1];
    h.step(S.departDelayMs);
    h.step(1);
    h.step(S.ratterDwellMinMs);
    h.step(1);
    h.step(S.ratterDwellMinMs);
    h.step(1);
    h.step(S.dockDelayMs);
    const mine = h.log.filter((e) => e[1] === id || (e[0] === "despawn" && e[1].includes(id)))
      .map((e) => (e[0] === "orbit" ? [e[0], e[2], e[3]] : [e[0]]));
    const orbitOpts = { meters: S.ratterOrbitMeters, speedFraction: S.ratterOrbitSpeedPermille / 1000 };
    assert.deepStrictEqual(mine, [["spawn"], ["warp"], ["orbit", 40001, orbitOpts], ["release"], ["warp"],
      ["orbit", 40002, orbitOpts], ["release"], ["warp"], ["despawn"]]);
    const c = h.traffic.status().counters;
    assert.deepStrictEqual([c.ratters, c.ratterBelts, c.ratterOrbits, c.ratterOrbitRefused, c.patrolReleased],
      [1, 2, 2, 0, 2]);
    assert.strictEqual(spawned[1][2].gateId !== undefined, true, "the second ship of the pass is a hauler");

    const r = harness(S, { orbit: false });
    r.step(0);
    r.step(S.departDelayMs);
    r.step(1);
    r.step(1);
    assert.strictEqual(r.traffic.status().counters.ratterOrbitRefused, 1);
    r.step(S.ratterDwellMinMs);
    assert.deepStrictEqual(r.log.filter((e) => e[0] === "release"), [], "no release without our order");
    const rid = r.log.find((e) => e[0] === "spawn")[1];
    assert.strictEqual(r.log.filter((e) => e[0] === "warp" && e[1] === rid).length, 2, "dwell then the next belt");

    const f = rig.fakeScene();
    f.scene.readNodes = () => ({ ok: true, ...NODES });
    f.scene.presentPatrolOrbit = () => ({ ok: true, orbiting: true });
    f.scene.releasePatrolMotion = () => ({ ok: true, released: true });
    const reads = [];
    f.scene.readThreats = (sys, ids) => {
      reads.push([...ids]);
      return { ok: true, threats: [] };
    };
    f.scene.armPilotTarget = () => ({ ok: false, reason: "X" });
    f.scene.disarmPilotTarget = () => ({ ok: true, released: 0, kept: 0, releaseFailed: 0 });
    const pop = rig.fakePopulation([rig.cand(1, "HAULER", "GATE", rig.FROM, rig.NEXT),
      rig.cand(2, "RATTER", "NONE", rig.FROM, 0), rig.cand(3, "RATTER", "NONE", 0, 0)]);
    pop.standings = () => ({ profileOf: (x) => x, relationOf: () => 0 });
    const live = { ...rig.LIVE_ON, standingAggroEnabled: true };
    const p = rig.harness({ settings: S, pop, live, scene: f });
    p.tick(1);
    p.clock.t += live.spawnGapMs;
    p.tick(1);
    assert.deepStrictEqual(pop.calls.claim, [1, 2], "the capped ratter pilot is not claimed");
    const st = p.traffic.status();
    assert.deepStrictEqual([st.counters.ratterCapped > 0, st.counters.ratters], [true, 1]);
    assert.ok(reads.length > 0 && reads.every((ids) => !ids.includes(9002)), JSON.stringify(reads));
  });

  test("RP5 data: every RATTER hull has the empty loadout; ratter config defaults off with the documented values", () => {
    const ratters = CIV.CIVILIAN_HULLS.filter((h) => h.roles.includes("RATTER"));
    assert.deepStrictEqual(ratters.map((h) => h.key), ["catalyst", "brutix"]);
    assert.ok(ratters.every((h) => h.loadoutId === "retail_empty_npc_entity_loadout"));
    const d = DEFAULTS.highsecLife.traffic;
    assert.deepStrictEqual([d.ratterEnabled, d.ratterPermille, d.ratterMaxPerSystem, d.ratterBeltsMin,
      d.ratterBeltsMax, d.ratterDwellMinMs, d.ratterDwellMaxMs, d.ratterLandingMeters, d.ratterOrbitMeters,
      d.ratterOrbitSpeedPermille, d.ratterLegMs], [false, 150, 2, 2, 3, 45000, 90000, 10000, 7500, 600, 60000]);
    const bad = trafficSettingsOf({ highsecLife: { traffic: { ...d, ratterBeltsMin: 4, ratterBeltsMax: 3 } } });
    assert.deepStrictEqual(bad, { ok: false, reason: "INVALID_SETTINGS", detail: "traffic.ratterBeltsMin>ratterBeltsMax" });
  });
};
