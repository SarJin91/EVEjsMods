"use strict";

const assert = require("node:assert");
const path = require("node:path");

const { resolveConfig } = require("../../config");
const { trafficSettingsOf } = require("../../lib/highsecLife/schema");
const { pickRole, pickRoute, pickProfile, pickIdleGate, stepShip } = require("../../lib/highsecLife/traffic/plan");
const { createTraffic } = require("../../lib/highsecLife/traffic/service");
const { createRng } = require("../../lib/util/rng");
const { TRAFFIC_HAULER_PROFILES } = require("../../lib/adapter/data/trafficProfiles");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const T0 = Date.UTC(2026, 10, 19, 17, 0, 0);
const SYS = 30000144;

function T(over) {
  const traffic = { ...resolveConfig({ modDir: MOD_DIR, env: {} }).config.highsecLife.traffic, ...(over || {}) };
  const r = trafficSettingsOf({ highsecLife: { traffic } });
  assert.ok(r.ok, JSON.stringify(r));
  return r.settings;
}

const node = (itemId, x) => ({ itemId, position: { x, y: 0, z: 0 }, radius: 5000 });
const NODES = Object.freeze({ gates: [node(50001, 0), node(50002, 1e9)], stations: [node(60001, 5e8)] });

function fakeScene() {
  const specs = [];
  const alive = new Map();
  let next = 9000;
  const scene = {
    readNodes: () => ({ ok: true, gates: NODES.gates, stations: NODES.stations }),
    readPlayers: () => ({ ok: true, ships: [{ characterId: 1 }] }),
    spawnCivilian: (_id, spec) => {
      specs.push(spec);
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
    dockPointOf: () => ({ ok: true, point: { x: 5e8, y: 0, z: 9000 }, direction: { x: 0, y: 0, z: 1 } }),
  };
  return { scene, specs, alive };
}

function harness(settings, extra) {
  const clock = { t: T0, now() { return clock.t; } };
  const presence = { observedSystems: () => [SYS], getSystemPresence: () => ({ space: 1 }) };
  const f = fakeScene();
  const made = createTraffic({ settings, scene: f.scene, clock, rng: () => 0, getPresence: () => presence,
    describeSystem: () => ({ secClass: "highsec" }), wantedOf: () => 45, profiles: TRAFFIC_HAULER_PROFILES,
    getGovernor: () => ({ admits: () => true }), ...(extra || {}) });
  assert.ok(made.ok, JSON.stringify(made));
  return { traffic: made.traffic, clock, ...f };
}

module.exports = ({ test }) => {
  test("TRV1 defaults: pickRole HAULER without a draw, route and profile draws bit for bit, spawn spec unchanged; "
    + "flags on: UNDOCK / GATE_IDLE by permille, no UNDOCK without a station", () => {
    const S = T();
    assert.deepStrictEqual([S.bands, S.undockEnabled, S.dockToPointEnabled, S.gateIdleEnabled, S.namesEnabled],
      [["highsec"], false, false, false, false]);
    let draws = 0;
    const base = createRng(7).nextFloat;
    const counted = () => { draws += 1; return base(); };
    for (let i = 0; i < 50; i += 1) assert.strictEqual(pickRole(counted, NODES, S), "HAULER");
    assert.strictEqual(draws, 0, "no draw with every role flag off");
    const sequence = (withRole) => {
      const rng = createRng(20261119).nextFloat;
      const out = [];
      for (let i = 0; i < 20; i += 1) {
        if (withRole) pickRole(rng, NODES, S);
        const r = pickRoute(NODES, rng, S);
        out.push([r.startGate.itemId, r.target.kind, r.target.itemId, pickProfile(TRAFFIC_HAULER_PROFILES, rng)]);
      }
      return out;
    };
    assert.deepStrictEqual(sequence(true), sequence(false));
    const h = harness(S);
    h.traffic.tick();
    assert.strictEqual(h.specs.length, 2);
    for (const spec of h.specs) assert.deepStrictEqual(Object.keys(spec).sort(), ["gateId", "profileId", "spawnOffsetMeters"]);

    const on = T({ undockEnabled: true, gateIdleEnabled: true, undockPermille: 300, gateIdlePermille: 150 });
    assert.deepStrictEqual([0, 0.299, 0.3, 0.449, 0.45, 0.99].map((v) => pickRole(() => v, NODES, on)),
      ["UNDOCK", "UNDOCK", "GATE_IDLE", "GATE_IDLE", "HAULER", "HAULER"]);
    assert.strictEqual(pickRole(() => 0, { gates: NODES.gates, stations: [] }, on), "GATE_IDLE", "no station");
    assert.deepStrictEqual([pickIdleGate(NODES, () => 0, on).idleMs, pickIdleGate(NODES, () => 0.9999999999, on).idleMs],
      [on.gateIdleMinMs, on.gateIdleMaxMs]);
    assert.deepStrictEqual(trafficSettingsOf({ highsecLife: { traffic: { ...resolveConfig({ modDir: MOD_DIR, env: {} })
      .config.highsecLife.traffic, gateIdleMinMs: 5000, gateIdleMaxMs: 4000 } } }).detail,
    "traffic.gateIdleMinMs>gateIdleMaxMs");
  });

  test("TRV2 UNDOCK SPAWNED -> RUNNING -> WARPING -> ARRIVED -> despawn; GATE_IDLE JUMPED at idleUntil; dock point; "
    + "lowsec band through secClassOf", () => {
    const S = T({ undockEnabled: true, undockPermille: 1000 });
    const ship = { role: "UNDOCK", state: "SPAWNED", spawnedAt: 0, arrivedAt: null, warpAttempts: 0,
      targetPoint: { x: 1e6, y: 0, z: 0 } };
    const seen = { live: true, inWarp: false, position: { x: 0, y: 0, z: 0 } };
    assert.deepStrictEqual(stepShip(ship, seen, 1, S), { kind: "run" });
    const running = { ...ship, state: "RUNNING" };
    assert.deepStrictEqual(stepShip(running, seen, S.departDelayMs - 1, S), { kind: "none" });
    assert.deepStrictEqual(stepShip(running, seen, S.departDelayMs, S), { kind: "warp" });
    assert.deepStrictEqual(stepShip({ ...ship, state: "WARPING" }, { ...seen, position: ship.targetPoint }, 20000, S),
      { kind: "arrived" });
    assert.deepStrictEqual(stepShip({ ...ship, state: "ARRIVED", arrivedAt: 30000 }, seen, 30000 + S.dockDelayMs, S),
      { kind: "despawn", reason: "ARRIVED" });
    const idler = { role: "GATE_IDLE", state: "IDLING", spawnedAt: 0, arrivedAt: null, warpAttempts: 0,
      idleUntil: 5000, targetPoint: null };
    assert.deepStrictEqual(stepShip(idler, seen, 4999, S), { kind: "none" });
    assert.deepStrictEqual(stepShip(idler, seen, 5000, S), { kind: "despawn", reason: "JUMPED" });

    const h = harness(S);
    h.traffic.tick();
    assert.deepStrictEqual(h.specs[0], { profileId: h.specs[0].profileId, stationId: 60001, undock: true,
      undockRunMeters: S.undockRunMeters, spawnOffsetMeters: S.spawnOffsetMeters });
    h.clock.t += 1;
    h.traffic.tick();
    h.clock.t += S.departDelayMs;
    h.traffic.tick();
    h.clock.t += 1;
    h.traffic.tick();
    h.clock.t += S.dockDelayMs;
    h.traffic.tick();
    let c = h.traffic.status().counters;
    assert.deepStrictEqual([c.undocked, c.arrived, h.traffic.shipsIn(SYS)], [2, 2, 0]);

    const I = T({ gateIdleEnabled: true, gateIdlePermille: 1000 });
    const g = harness(I);
    g.traffic.tick();
    assert.deepStrictEqual([g.specs[0].gateId, g.traffic.shipsIn(SYS)], [50001, 2]);
    g.clock.t += I.gateIdleMinMs;
    g.traffic.tick();
    c = g.traffic.status().counters;
    assert.deepStrictEqual([c.gateIdle, g.traffic.shipsIn(SYS)], [2, 0]);

    const D = T({ dockToPointEnabled: true, stationTargetPermille: 1000 });
    const d = harness(D);
    d.traffic.tick();
    for (const step of [D.departDelayMs, 1, D.dockDelayMs]) {
      d.clock.t += step;
      d.traffic.tick();
    }
    c = d.traffic.status().counters;
    assert.deepStrictEqual([c.arrived, c.docked], [2, 2]);
    assert.deepStrictEqual([...d.alive.values()], [], "despawned in the dock");

    const L = T({ bands: "highsec,lowsec" });
    const low = harness(L, { describeSystem: () => null, secClassOf: () => "lowsec" });
    low.traffic.tick();
    assert.strictEqual(low.specs.length, 2);
    const none = harness(T(), { describeSystem: () => null, secClassOf: () => "lowsec" });
    none.traffic.tick();
    assert.strictEqual(none.specs.length, 0, "default bands: no lowsec traffic");
  });

  test("TRV3 namesEnabled: no shared name in a system, a name back after the despawn, one read; no speakersOf -> "
    + "no slimName, noName", () => {
    const S = T({ namesEnabled: true });
    const reads = [];
    const names = new Map([[11, "Ann Civil"], [12, "Bob Civil"], [13, "Res Ident"], [14, "x"]]);
    const h = harness(S, {
      speakersOf: () => ({ ok: true, civilians: [12, 11, 14], residents: [13], atMs: T0 }),
      readCharacterNames: (ids) => {
        reads.push([...ids]);
        return { ok: true, names: new Map(ids.map((id) => [id, names.get(id) || null])) };
      },
    });
    h.traffic.tick();
    assert.deepStrictEqual(h.specs.map((s) => s.slimName), ["Bob Civil", "Ann Civil"], "civilians in speaker order");
    assert.deepStrictEqual(reads, [[12, 11, 14, 13]], "one read, the cache serves the second ship");
    h.alive.delete(9001);
    h.clock.t += S.spawnIntervalMs;
    h.traffic.tick();
    assert.deepStrictEqual(h.specs.slice(2).map((s) => s.slimName), ["Bob Civil", "Res Ident"]);
    let c = h.traffic.status().counters;
    assert.deepStrictEqual([c.named, c.noName, reads.length], [4, 0, 1]);

    const bare = harness(S);
    bare.traffic.tick();
    assert.ok(bare.specs.every((s) => !("slimName" in s)), "no speakersOf -> the vendor name");
    c = bare.traffic.status().counters;
    assert.deepStrictEqual([c.named, c.noName], [0, 2]);
  });
};
