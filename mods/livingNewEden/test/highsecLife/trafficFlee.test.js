"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { resolveConfig } = require("../../config");
const { trafficSettingsOf } = require("../../lib/highsecLife/schema");
const { noteAggression, fleeStepOf, fleeTargetOf } = require("../../lib/highsecLife/traffic/flee");
const { createTraffic } = require("../../lib/highsecLife/traffic/service");
const seams = require("../../lib/adapter/highsecTrafficScene");
const { TRAFFIC_HAULER_PROFILES } = require("../../lib/adapter/data/trafficProfiles");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const SERVER_SRC = path.resolve(MOD_DIR, "..", "..", "server", "src");
const T0 = Date.UTC(2026, 10, 27, 20, 0, 0);
const SYS = 30000144;
const FROM = 30000143;
const NEXT = 30000145;

const DEFAULTS = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_DATA_ROOT: os.tmpdir() } }).config;

function T(over) {
  const r = trafficSettingsOf({ highsecLife: { traffic: { ...DEFAULTS.highsecLife.traffic, ...(over || {}) } } });
  assert.ok(r.ok, JSON.stringify(r));
  return r.settings;
}

const node = (itemId, x, toSystemId) => ({ itemId, position: { x, y: 0, z: 0 }, radius: 5000,
  ...(toSystemId ? { toSystemId } : {}) });
const NODES = Object.freeze({ gates: [node(50001, 0), node(50002, 1e9)], stations: [], belts: [] });
const ONE_SHIP = Object.freeze({ stationTargetPermille: 0, maxShipsPerSystem: 1, spawnIntervalMs: 3600000,
  maxWarpAttempts: 50 });

function harness(settings, opts = {}) {
  const clock = { t: T0, now() { return clock.t; } };
  const presence = { observedSystems: () => [SYS], getSystemPresence: () => ({ space: 1 }) };
  const warps = [];
  const reads = [];
  const alive = new Map();
  const hits = new Map();
  const inWarp = new Set();
  const nodes = opts.nodes || NODES;
  let next = 9000;
  const scene = {
    readNodes: () => ({ ok: true, ...nodes }),
    readPlayers: () => ({ ok: true, ships: [{ characterId: 1 }] }),
    spawnCivilian: () => {
      next += 1;
      alive.set(next, { x: 0, y: 0, z: 0 });
      return { ok: true, entityId: next };
    },
    warpTo: (...args) => {
      warps.push(args);
      const r = opts.warpOf ? opts.warpOf(args) : null;
      if (r) return r;
      const o = args[3];
      if (o && o.align === true) return { ok: true, warped: true, aligned: true };
      alive.set(args[1], args[2]);
      return { ok: true, warped: true };
    },
    readShips: (...args) => {
      reads.push(args);
      const [, ids, o] = args;
      return { ok: true, sceneLoaded: true,
        live: ids.filter((e) => alive.has(e)).map((e) => ({ entityId: e, position: alive.get(e), inWarp: inWarp.has(e),
          ...(o && o.aggression === true ? { playerAggressedAt: hits.get(e) || 0 } : {}) })),
        gone: ids.filter((e) => !alive.has(e)) };
    },
    despawn: (_id, ids) => {
      for (const e of ids) alive.delete(e);
      return { ok: true, removed: ids.length, missing: 0 };
    },
    listTrafficIds: () => ({ ok: true, ids: [] }),
    dockPointOf: () => ({ ok: false, reason: "NO_STATION" }),
  };
  const made = createTraffic({ settings, scene, clock, rng: () => 0, getPresence: () => presence,
    describeSystem: () => ({ secClass: "highsec" }), wantedOf: () => 45, profiles: TRAFFIC_HAULER_PROFILES,
    getGovernor: () => ({ admits: () => true }), ...(opts.populationLive ? { populationLive: opts.populationLive } : {}) });
  assert.ok(made.ok, JSON.stringify(made));
  const step = (ms) => {
    clock.t += ms;
    made.traffic.tick();
  };
  return { traffic: made.traffic, step, warps, reads, alive, hits, inWarp, counters: () => made.traffic.status().counters };
}

const PILOT_NODES = Object.freeze({ gates: [node(50001, 0, FROM), node(50002, 1e6, NEXT), node(50003, -1e8)],
  stations: [], belts: [] });

function pilotPopulation(release) {
  let owned = false;
  const pop = {
    getStatus: () => ({ state: "running" }),
    liveCandidatesIn: () => (owned ? [] : [{ pilotId: 1, kind: "ARRIVE", role: "HAULER", exit: "GATE",
      fromSystemId: FROM, toSystemId: NEXT, shipTypeId: 648, at: T0 }]),
    claimLive: () => {
      owned = true;
      return { ok: true, token: 1 };
    },
    releaseLive: (pilotId, _token, outcome) => {
      release.push([pilotId, outcome]);
      return { ok: true, applied: true };
    },
  };
  return { settings: { ...DEFAULTS.population.live, trafficEnabled: true }, getPopulation: () => pop,
    leaseOf: () => ({ ok: true, characterId: null }) };
}

function fakeGame({ controllers, entities, npc = true }) {
  const scene = { getEntityByID: (id) => entities.get(id) || null };
  const mods = {
    "space/runtime": { scenes: new Map([[SYS, scene]]), isSolarSystemSceneLoaded: (id) => id === SYS },
    ...(npc ? { "space/npc/npcService": { getControllerByEntityID: (id) => controllers.get(id) || null,
      setBehaviorOverrides: () => ({ success: true }) } } : {}),
  };
  return (rel) => (mods[rel] ? { ok: true, exports: mods[rel] } : { ok: false, reason: "MISSING" });
}

module.exports = ({ test }) => {
  test("TFL1 adapter readShips: a player aggressor gives lastAggressedAtMs, an NPC or a vanished aggressor 0, "
    + "no opts keeps the shape, a non-boolean aggression is INVALID_INPUT", () => {
    const ships = [1001, 1002, 1003, 1004].map((entityId) => ({ entityId, position: { x: 1, y: 2, z: 3 } }));
    const controllers = new Map([[1001, { lastAggressorID: 7001, lastAggressedAtMs: 4242 }],
      [1002, { lastAggressorID: 7002, lastAggressedAtMs: 5151 }], [1003, { lastAggressorID: 7999, lastAggressedAtMs: 6161 }]]);
    const entities = new Map([[7001, { itemID: 7001, session: { characterID: 1 } }], [7002, { itemID: 7002 }]]);
    const getHuntScene = () => ({ readShips: () => ({ ok: true, ships }) });
    const seam = seams.createHighsecTrafficScene({ requireGame: fakeGame({ controllers, entities }), getHuntScene });
    const ids = ships.map((s) => s.entityId);
    const on = seam.readShips(SYS, ids, { aggression: true });
    assert.deepStrictEqual(on.live.map((s) => s.playerAggressedAt), [4242, 0, 0, 0]);
    const plain = seam.readShips(SYS, ids);
    assert.deepStrictEqual(Object.keys(plain.live[0]), ["entityId", "position", "inWarp"]);
    assert.deepStrictEqual(seam.readShips(SYS, ids, { aggression: false }), plain);
    assert.deepStrictEqual(seam.readShips(SYS, ids, { aggression: "1" }), { ok: false, reason: "INVALID_INPUT" });
    const noNpc = seams.createHighsecTrafficScene({ requireGame: fakeGame({ controllers, entities, npc: false }),
      getHuntScene });
    assert.deepStrictEqual(noNpc.readShips(SYS, ids, { aggression: true }).live.map((s) => s.playerAggressedAt),
      [0, 0, 0, 0]);
  });

  test("TFL2 flee.js: a window opens only on a higher value; step none/hold/flee; target kept, first far gate, "
    + "station, NO_TARGET", () => {
    const S = T({ fleeEnabled: true });
    const ship = { role: "HAULER", state: "SPAWNED", targetPoint: { x: 1e9, y: 0, z: 0 } };
    assert.strictEqual(noteAggression(ship, { playerAggressedAt: 100 }, 1000, S), true);
    assert.strictEqual(ship.fleeUntil, 1000 + S.fleeWindowMs);
    assert.strictEqual(noteAggression(ship, { playerAggressedAt: 100 }, 2000, S), false);
    assert.strictEqual(noteAggression({ ...ship, role: "MINER" }, { playerAggressedAt: 200 }, 2000, S), false);
    const seen = { live: true, inWarp: false, position: { x: 0, y: 0, z: 0 } };
    assert.deepStrictEqual(fleeStepOf(ship, seen, 1500, S), { kind: "flee", needTarget: false });
    assert.deepStrictEqual(fleeStepOf({ ...ship, role: "MINER" }, seen, 1500, S), { kind: "none" });
    assert.deepStrictEqual(fleeStepOf({ ...ship, state: "ARRIVED" }, seen, 1500, S), { kind: "none" });
    assert.deepStrictEqual(fleeStepOf(ship, seen, ship.fleeUntil, S), { kind: "none" });
    assert.deepStrictEqual(fleeStepOf(ship, { ...seen, inWarp: true }, 1500, S), { kind: "hold" });
    assert.deepStrictEqual(fleeStepOf({ ...ship, fleeNextAt: 1501 }, seen, 1500, S), { kind: "hold" });
    assert.deepStrictEqual(fleeStepOf({ ...ship, fleeOrdered: true, state: "WARPING" }, seen, 1500, S),
      { kind: "none" });
    assert.deepStrictEqual(fleeStepOf({ ...ship, targetPoint: { x: 1000, y: 0, z: 0 } }, seen, 1500, S),
      { kind: "flee", needTarget: true });

    const from = { x: 0, y: 0, z: 0 };
    const near = node(50002, 1000);
    const nodes = { gates: [node(50001, 0), near, node(50003, 1e9), node(50004, 2e9)], stations: [node(60001, 5e8)] };
    const kept = fleeTargetOf(from, nodes, { kind: "stargate", ...node(50004, 2e9) }, S);
    assert.deepStrictEqual([kept.ok, kept.keptRoute, kept.target.itemId], [true, true, 50004]);
    const gate = fleeTargetOf(from, nodes, { kind: "stargate", ...near }, S);
    assert.deepStrictEqual([gate.keptRoute, gate.target.kind, gate.target.itemId], [false, "stargate", 50003]);
    const station = fleeTargetOf(from, { gates: [node(50001, 0)], stations: [node(60001, 5e8)] }, null, S);
    assert.deepStrictEqual([station.target.kind, station.target.itemId], ["station", 60001]);
    assert.deepStrictEqual(fleeTargetOf(from, { gates: [near], stations: [] }, null, S),
      { ok: false, reason: "NO_TARGET" });
  });

  test("TFL3 service: a hit hauler warps at once with align, a refused warp retries after fleeRetryMs, after the "
    + "window the plan takes over, flag off reads without options", () => {
    const S = T({ ...ONE_SHIP, fleeEnabled: true, alignBeforeWarpEnabled: true, departDelayMs: 120000 });
    const h = harness(S);
    h.step(0);
    const [id] = [...h.alive.keys()];
    h.hits.set(id, 7777);
    h.step(1000);
    assert.strictEqual(h.warps.length, 1);
    assert.deepStrictEqual(h.warps[0][3], { align: true });
    assert.ok(Math.abs(h.warps[0][2].x - (1e9 - 5000 - S.landingOffsetMeters)) < 1, JSON.stringify(h.warps[0]));
    assert.ok(h.reads.every((a) => a[2] && a[2].aggression === true));
    h.step(1000);
    assert.strictEqual(h.warps.length, 1, "one order per hit");
    let c = h.counters();
    assert.deepStrictEqual([c.fleeTriggered, c.fleeWarps, c.fleeRetry], [1, 1, 0]);

    const W = T({ ...ONE_SHIP, fleeEnabled: true, fleeWindowMs: 20000, fleeRetryMs: 5000, departDelayMs: 120000 });
    const r = harness(W, { warpOf: () => ({ ok: true, warped: false }) });
    r.step(0);
    r.hits.set([...r.alive.keys()][0], 1);
    r.step(1000);
    r.step(W.fleeRetryMs - 1);
    assert.strictEqual(r.warps.length, 1, "no retry before fleeRetryMs");
    r.step(1);
    assert.strictEqual(r.warps.length, 2);
    r.step(W.fleeWindowMs);
    r.step(W.fleeRetryMs);
    assert.strictEqual(r.warps.length, 2, "after the window the depart delay rules again");
    c = r.counters();
    assert.deepStrictEqual([c.fleeTriggered, c.fleeWarps, c.fleeRetry], [1, 0, 2]);

    const off = harness(T({ ...ONE_SHIP, departDelayMs: 120000 }));
    off.step(0);
    off.hits.set([...off.alive.keys()][0], 1);
    off.step(1000);
    assert.ok(off.reads.length > 0 && off.reads.every((a) => a.length === 2));
    assert.strictEqual(off.warps.length, 0);
  });

  test("TFL4 lifetime beats the flight; a population pilot fleeing to another node ends LEFT", () => {
    const L = T({ ...ONE_SHIP, fleeEnabled: true, fleeWindowMs: 600000, maxLifetimeMs: 30000, departDelayMs: 120000 });
    const e = harness(L, { warpOf: () => ({ ok: true, warped: false }) });
    e.step(0);
    e.hits.set([...e.alive.keys()][0], 1);
    e.step(1000);
    e.step(L.maxLifetimeMs - 1000);
    assert.deepStrictEqual([e.counters().expired, e.traffic.status().ships], [1, 0]);

    const release = [];
    const P = T({ ...ONE_SHIP, fleeEnabled: true, fleeMinMeters: 10000000, departDelayMs: 120000 });
    const p = harness(P, { nodes: PILOT_NODES, populationLive: pilotPopulation(release) });
    p.step(0);
    const [id] = [...p.alive.keys()];
    assert.ok(Number.isSafeInteger(id), "pilot spawned");
    p.hits.set(id, 1);
    p.step(1000);
    assert.ok(Math.abs(p.warps[0][2].x - (-1e8 + 5000 + P.landingOffsetMeters)) < 1, JSON.stringify(p.warps));
    p.step(1000);
    p.step(P.dockDelayMs);
    assert.deepStrictEqual(release, [[1, "LEFT"]]);
  });

  test("TFL5 a failed rescue warp after the align timeout puts the ship back to its pre-warp state and the normal "
    + "retry warps again", () => {
    const S = T({ ...ONE_SHIP, alignBeforeWarpEnabled: true });
    const h = harness(S, { warpOf: (args) => (args[3] && args[3].clearAlignOrder === true
      ? { ok: true, warped: false } : null) });
    h.step(0);
    h.step(S.departDelayMs);
    h.step(S.alignTimeoutMs);
    h.step(1000);
    assert.deepStrictEqual(h.warps.map((a) => a[3]), [{ align: true }, { clearAlignOrder: true }, { align: true }]);
    const c = h.counters();
    assert.deepStrictEqual([c.alignWarps, c.alignTimeouts, c.warpFailed], [2, 1, 1]);
  });

  test("TFL6 vendor facts: noteIncomingAggression writes the aggressor and the sim time, the runtime schema "
    + "persists lastAggressedAtMs", () => {
    const loop = fs.readFileSync(path.join(SERVER_SRC, "space", "npc", "npcBehaviorLoop.js"), "utf8")
      .replace(/\r\n/g, "\n");
    const start = loop.indexOf("\nfunction noteIncomingAggression(");
    assert.ok(start >= 0, "noteIncomingAggression");
    const body = loop.slice(start, loop.indexOf("\nfunction ", start + 1));
    assert.ok(body.includes("controller.lastAggressorID = normalizedAttackerEntityID;"));
    assert.ok(body.includes("controller.lastAggressedAtMs = "));
    const schema = fs.readFileSync(path.join(SERVER_SRC, "gameStore", "shared-schema", "npcRuntimeSchemas.js"), "utf8");
    assert.ok(schema.includes("real(\"lastAggressedAtMs\", \"last_aggro_sim_ms\")"));
  });

  test("TFL7 a hauler hit during its normal warp lands at its own gate and the pilot ends JUMPED", () => {
    const S = T({ fleeEnabled: true });
    const landed = { live: true, inWarp: false, position: { x: 1e9, y: 0, z: 0 } };
    const warping = { role: "HAULER", state: "WARPING", targetPoint: landed.position, fleeUntil: 2000 };
    assert.deepStrictEqual(fleeStepOf(warping, landed, 1500, S), { kind: "none" });

    const release = [];
    const P = T({ ...ONE_SHIP, fleeEnabled: true, fleeMinMeters: 10000000, alignBeforeWarpEnabled: false,
      gateJumpFxEnabled: false });
    const p = harness(P, { nodes: PILOT_NODES, populationLive: pilotPopulation(release) });
    p.step(0);
    const [id] = [...p.alive.keys()];
    assert.ok(Number.isSafeInteger(id), "pilot spawned");
    p.step(P.departDelayMs);
    assert.strictEqual(p.warps.length, 1);
    p.inWarp.add(id);
    p.hits.set(id, 1);
    p.step(1000);
    p.inWarp.delete(id);
    p.step(1000);
    p.step(P.dockDelayMs);
    assert.strictEqual(p.warps.length, 1, "no second warp after landing");
    assert.deepStrictEqual(release, [[1, "JUMPED"]]);
    const c = p.counters();
    assert.deepStrictEqual([c.fleeTriggered, c.fleeWarps, c.arrived], [1, 0, 1]);
  });

  test("TFL8 a ship that still enters warp after a failed rescue is tracked as warping and arrives", () => {
    const S = T({ ...ONE_SHIP, alignBeforeWarpEnabled: true });
    const h = harness(S, { warpOf: (args) => (args[3] && args[3].clearAlignOrder === true
      ? { ok: true, warped: false } : null) });
    h.step(0);
    const [id] = [...h.alive.keys()];
    h.step(S.departDelayMs);
    h.step(S.alignTimeoutMs);
    h.inWarp.add(id);
    h.step(1000);
    h.inWarp.delete(id);
    h.alive.set(id, h.warps[0][2]);
    h.step(1000);
    assert.deepStrictEqual(h.warps.map((a) => a[3]), [{ align: true }, { clearAlignOrder: true }]);
    const c = h.counters();
    assert.deepStrictEqual([c.arrived, c.stuck, c.warpFailed], [1, 0, 1]);
  });

  test("TFL9 adapter readShips: a drone hit counts when its controlling ship has a session", () => {
    const ships = [2001, 2002].map((entityId) => ({ entityId, position: { x: 1, y: 2, z: 3 } }));
    const controllers = new Map([[2001, { lastAggressorID: 8001, lastAggressedAtMs: 4343 }],
      [2002, { lastAggressorID: 8002, lastAggressedAtMs: 5454 }]]);
    const entities = new Map([[7001, { itemID: 7001, session: { characterID: 1 } }], [7002, { itemID: 7002 }],
      [8001, { itemID: 8001, controllerID: 7001 }], [8002, { itemID: 8002, controllerID: 7002 }]]);
    const getHuntScene = () => ({ readShips: () => ({ ok: true, ships }) });
    const seam = seams.createHighsecTrafficScene({ requireGame: fakeGame({ controllers, entities }), getHuntScene });
    assert.deepStrictEqual(seam.readShips(SYS, [2001, 2002], { aggression: true }).live
      .map((s) => s.playerAggressedAt), [4343, 0]);
  });
};
