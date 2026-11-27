"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const { resolveConfig } = require("../../config");
const { trafficSettingsOf } = require("../../lib/highsecLife/schema");
const { stepShip } = require("../../lib/highsecLife/traffic/plan");
const { createTraffic } = require("../../lib/highsecLife/traffic/service");
const seams = require("../../lib/adapter/highsecTrafficScene");
const fx = require("../../lib/adapter/gateJumpFx");
const { TRAFFIC_HAULER_PROFILES } = require("../../lib/adapter/data/trafficProfiles");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const SERVER_SRC = path.resolve(MOD_DIR, "..", "..", "server", "src");
const T0 = Date.UTC(2026, 10, 27, 17, 0, 0);
const SYS = 30000144;
const DEST = 30000145;

function trafficOf(env) {
  return resolveConfig({ modDir: MOD_DIR, env: env || {} }).config.highsecLife.traffic;
}

function T(over) {
  const r = trafficSettingsOf({ highsecLife: { traffic: { ...trafficOf(), ...(over || {}) } } });
  assert.ok(r.ok, JSON.stringify(r));
  return r.settings;
}

function readSource(rel) {
  return fs.readFileSync(path.join(SERVER_SRC, rel), "utf8").replace(/\r\n/g, "\n");
}

const node = (itemId, x) => ({ itemId, position: { x, y: 0, z: 0 }, radius: 5000 });
const NODES = Object.freeze({ gates: [node(50001, 0), node(50002, 1e9)], stations: [node(60001, 5e8)] });

function harness(settings, sentOut) {
  const clock = { t: T0, now() { return clock.t; } };
  const pilots = { space: 1 };
  const presence = { observedSystems: () => [SYS], getSystemPresence: () => ({ space: pilots.space }) };
  const specs = [];
  const jumpOuts = [];
  const order = [];
  const alive = new Map();
  let next = 9000;
  const scene = {
    readNodes: () => ({ ok: true, gates: NODES.gates, stations: NODES.stations }),
    readPlayers: () => ({ ok: true, ships: pilots.space > 0 ? [{ characterId: 1 }] : [] }),
    spawnCivilian: (_id, spec) => {
      specs.push(spec);
      next += 1;
      alive.set(next, { x: 0, y: 0, z: 0 });
      if (spec.jumpInMs === undefined) return { ok: true, entityId: next };
      return spec.gateEvents === true ? { ok: true, entityId: next, jumpIn: true, arrival: true }
        : { ok: true, entityId: next, jumpIn: true };
    },
    presentGateDeparture: (systemId, entityId, gateId) => {
      order.push(["departure", systemId, entityId, gateId]);
      return { ok: true, sent: true, queued: 1 };
    },
    warpTo: (_id, entityId, point) => {
      alive.set(entityId, point);
      return { ok: true, warped: true };
    },
    readShips: (_id, ids) => ({ ok: true, sceneLoaded: true,
      live: ids.filter((e) => alive.has(e)).map((e) => ({ entityId: e, position: alive.get(e), inWarp: false })),
      gone: ids.filter((e) => !alive.has(e)) }),
    despawn: (_id, ids) => {
      order.push(["despawn", ...ids]);
      for (const e of ids) alive.delete(e);
      return { ok: true, removed: ids.length, missing: 0 };
    },
    listTrafficIds: () => ({ ok: true, ids: [] }),
    dockPointOf: () => ({ ok: false, reason: "NO_STATION" }),
    presentGateJumpOut: (systemId, entityId, gateId) => {
      jumpOuts.push([systemId, entityId, gateId]);
      return { ok: true, sent: sentOut };
    },
  };
  const made = createTraffic({ settings, scene, clock, rng: () => 0, getPresence: () => presence,
    describeSystem: () => ({ secClass: "highsec" }), wantedOf: () => 45, profiles: TRAFFIC_HAULER_PROFILES,
    getGovernor: () => ({ admits: () => true }) });
  assert.ok(made.ok, JSON.stringify(made));
  const step = (ms) => {
    clock.t += ms;
    made.traffic.tick();
  };
  return { traffic: made.traffic, step, specs, jumpOuts, alive, order, pilots };
}

function fakeGameScene(opts) {
  const log = [];
  const entities = new Map([[50002, { itemID: 50002, kind: "stargate", destinationSolarSystemID: DEST }],
    [40001, { itemID: 40001, kind: "planet" }]]);
  const scene = {
    getEntityByID: (id) => entities.get(id) || null,
    broadcastSpecialFx: (shipId, guid, options, visibility) => {
      log.push(["fx", shipId, guid, options, visibility]);
      if (opts && opts.throwFx) throw new Error("fx boom");
      return { stamp: 7, deliveredCount: opts && opts.delivered === 0 ? 0 : 1 };
    },
    sessions: new Map([[1, { clientID: 1 }]]),
    queueCharacterHistory: (_session, updates) => {
      log.push(["history", ...updates]);
      return 7;
    },
  };
  const runtime = { scenes: new Map([[SYS, scene]]), isSolarSystemSceneLoaded: (id) => id === SYS };
  let nextId = 9000;
  const spawn = {
    pickGridAnchor: () => ({ ok: true, anchorDescriptor: { kind: "entity", itemID: 50001 }, radiusMeters: 0 }),
    spawnShip: () => {
      nextId += 1;
      entities.set(nextId, { itemID: nextId, kind: "ship" });
      return { ok: true, entityId: nextId };
    },
    publish: (_sys, ids) => {
      log.push(["publish", ...ids]);
      return { ok: true, published: ids.length };
    },
    despawn: (_sys, ids) => {
      for (const id of ids) entities.delete(id);
      log.push(["despawn", ...ids]);
      return { ok: true };
    },
  };
  const requireGame = (rel) => (rel === "space/runtime" ? { ok: true, exports: runtime } : { ok: false });
  const seam = seams.createHighsecTrafficScene({ requireGame, getNpcSpawn: () => spawn, getHuntScene: () => null });
  return { seam, log, entities };
}

module.exports = ({ test }) => {
  test("TJF1 plan: JUMPING holds the despawn past maxLifetimeMs, then despawns with its jumpReason; GATE_IDLE end "
    + "despawns with the flag off and asks for a jumpOut with the flag on", () => {
    const S = T({ gateJumpFxEnabled: true });
    const seen = { live: true, inWarp: false, position: { x: 0, y: 0, z: 0 } };
    const jumping = { role: "HAULER", state: "JUMPING", spawnedAt: 0, warpAttempts: 0, jumpOutAt: S.maxLifetimeMs,
      jumpReason: "ARRIVED" };
    const holdUntil = S.maxLifetimeMs + S.gateJumpOutDespawnMs;
    assert.deepStrictEqual(stepShip(jumping, seen, holdUntil - 1, S), { kind: "none" });
    assert.deepStrictEqual(stepShip(jumping, seen, holdUntil, S), { kind: "despawn", reason: "ARRIVED" });
    assert.deepStrictEqual(stepShip({ ...jumping, jumpReason: "JUMPED" }, seen, holdUntil, S),
      { kind: "despawn", reason: "JUMPED" });
    const idler = { role: "GATE_IDLE", state: "IDLING", spawnedAt: 0, warpAttempts: 0, idleUntil: 5000,
      startGateId: 50001 };
    assert.deepStrictEqual(stepShip(idler, seen, 5000, T()), { kind: "despawn", reason: "JUMPED" });
    assert.deepStrictEqual(stepShip(idler, seen, 4999, S), { kind: "none" });
    assert.deepStrictEqual(stepShip(idler, seen, 5000, S), { kind: "jumpOut", gateId: 50001, reason: "JUMPED" });
  });

  test("TJF2 service: jumpInMs only for gate spawns with the flag on, JumpOut at the target gate holds the ship, "
    + "sent false falls back to dockDelayMs, station target and undock never ask", () => {
    const off = harness(T({ stationTargetPermille: 0 }), true);
    off.step(0);
    assert.ok(off.specs.length > 0 && off.specs.every((s) => !("jumpInMs" in s)), "flag off: spec unchanged");
    off.step(T().departDelayMs);
    off.step(1);
    assert.deepStrictEqual(off.jumpOuts, [], "flag off: no JumpOut");

    const S = T({ gateJumpFxEnabled: true, stationTargetPermille: 0 });
    const on = harness(S, true);
    on.step(0);
    const n = on.specs.length;
    assert.ok(n > 0 && on.specs.every((s) => s.gateId === 50001 && s.jumpInMs === S.gateJumpInDurationMs));
    on.step(S.departDelayMs);
    on.step(1);
    assert.deepStrictEqual(on.jumpOuts, [...on.alive.keys()].map((id) => [SYS, id, 50002]));
    on.step(S.gateJumpOutDespawnMs - 1);
    assert.strictEqual(on.traffic.shipsIn(SYS), n, "held while the tunnel plays");
    on.step(1);
    let c = on.traffic.status().counters;
    assert.deepStrictEqual([on.traffic.shipsIn(SYS), c.jumpInFx, c.jumpOutFx, c.jumpFxFailed, c.arrived],
      [0, n, n, 0, n]);

    const unsent = harness(S, false);
    unsent.step(0);
    unsent.step(S.departDelayMs);
    unsent.step(1);
    unsent.step(S.gateJumpOutDespawnMs);
    assert.strictEqual(unsent.traffic.shipsIn(SYS), n, "not sent: the old ARRIVED path");
    unsent.step(S.dockDelayMs);
    c = unsent.traffic.status().counters;
    assert.deepStrictEqual([unsent.traffic.shipsIn(SYS), c.jumpOutFx, c.jumpFxFailed], [0, 0, n]);

    const station = harness(T({ gateJumpFxEnabled: true, stationTargetPermille: 1000 }), true);
    station.step(0);
    station.step(S.departDelayMs);
    station.step(1);
    assert.deepStrictEqual(station.jumpOuts, [], "station target: no JumpOut");

    const undock = harness(T({ gateJumpFxEnabled: true, undockEnabled: true, undockPermille: 1000 }), true);
    undock.step(0);
    assert.ok(undock.specs.length > 0 && undock.specs.every((s) => s.undock === true && !("jumpInMs" in s)));
  });

  test("TJF3 adapter: JumpIn after publish with start/active/duration, a throwing FX keeps the spawn; "
    + "presentGateJumpOut payload, deliveredCount 0 = sent false, non-stargate = NO_GATE", () => {
    const g = fakeGameScene();
    const spec = { profileId: "p", gateId: 50001, spawnOffsetMeters: 0 };
    assert.deepStrictEqual(g.seam.spawnCivilian(SYS, spec), { ok: true, entityId: 9001 });
    assert.deepStrictEqual(g.log.map((e) => e[0]), ["publish"], "no FX without jumpInMs");
    assert.deepStrictEqual(g.seam.spawnCivilian(SYS, { ...spec, jumpInMs: 5000 }), { ok: true, entityId: 9002,
      jumpIn: true });
    const jin = g.log.slice(1);
    assert.deepStrictEqual(jin.map((e) => e[0]), ["publish", "fx"]);
    assert.deepStrictEqual(jin[1].slice(1, 4), [9002, "effects.JumpIn", { start: true, active: false, duration: 5000 }]);
    assert.strictEqual(jin[1][4], g.entities.get(9002), "visibility entity = the ship");
    for (const bad of [{ ...spec, jumpInMs: 0 }, { profileId: "p", stationId: 60001, spawnOffsetMeters: 0,
      jumpInMs: 5000 }]) {
      assert.strictEqual(g.seam.spawnCivilian(SYS, bad).reason, "INVALID_INPUT", JSON.stringify(bad));
    }

    const boom = fakeGameScene({ throwFx: true });
    assert.deepStrictEqual(boom.seam.spawnCivilian(SYS, { ...spec, jumpInMs: 5000 }), { ok: true, entityId: 9001,
      jumpIn: false });
    assert.ok(boom.entities.has(9001) && !boom.log.some((e) => e[0] === "despawn"), "the spawn stays");

    const out = g.seam.presentGateJumpOut(SYS, 9002, 50002);
    assert.deepStrictEqual(out, { ok: true, sent: true });
    const last = g.log[g.log.length - 1];
    assert.deepStrictEqual(last.slice(1, 4), [9002, "effects.JumpOut", { targetID: 50002,
      graphicInfo: { type: "tuple", items: [DEST, null] }, start: true, active: false, includeStopInSameUpdate: true }]);
    const quiet = fakeGameScene({ delivered: 0 });
    quiet.seam.spawnCivilian(SYS, spec);
    assert.deepStrictEqual(quiet.seam.presentGateJumpOut(SYS, 9001, 50002), { ok: true, sent: false });
    assert.deepStrictEqual(g.seam.presentGateJumpOut(SYS, 9002, 40001), { ok: false, reason: "NO_GATE" });
    assert.deepStrictEqual(g.seam.presentGateJumpOut(SYS, 9999, 50002), { ok: false, reason: "GONE" });
    assert.strictEqual(boom.seam.presentGateJumpOut(SYS, 9001, 50002).reason, "FX_FAILED");
    assert.strictEqual(g.seam.presentGateJumpOut(SYS, 0, 50002).reason, "INVALID_INPUT");

    const built = fx.jumpInOptionsOf((rel) => (rel === "space/runtime/staticSceneEntity"
      ? { ok: true, exports: { buildObserverStargateJumpFxOptions: (o) => ({ start: true, active: false, ...o }) } }
      : { ok: false }), 4000);
    assert.deepStrictEqual(built, { start: true, active: false, duration: 4000 });
    assert.deepStrictEqual(fx.jumpInOptionsOf(() => ({ ok: false }), 4000), built, "fallback literal");
  });

  test("TJF4 vendor facts: observer JumpIn options builder, JumpOut payload with includeStopInSameUpdate, "
    + "broadcastSpecialFx returns deliveredCount", () => {
    const statics = readSource("space/runtime/staticSceneEntity.js");
    const exportsBlock = statics.slice(statics.indexOf("module.exports = {"), statics.indexOf("};"));
    assert.ok(exportsBlock.includes("  buildObserverStargateJumpFxOptions,"), "exported");
    const start = statics.indexOf("function buildObserverStargateJumpFxOptions(");
    const body = statics.slice(start, statics.indexOf("\n}", start));
    assert.ok(start >= 0 && body.includes("start: true,") && body.includes("active: false,"), "builder body");
    const jump = readSource("space/runtime/spaceRuntime/stargateJump.js");
    const outAt = jump.indexOf("\"effects.JumpOut\"");
    assert.ok(outAt >= 0, "JumpOut guid");
    const outBlock = jump.slice(outAt, jump.indexOf("shipEntity,", outAt));
    for (const s of ["targetID: sourceGateEntity.itemID,", "graphicInfo,", "start: true,", "active: false,",
      "includeStopInSameUpdate: true,"]) assert.ok(outBlock.includes(s), s);
    assert.ok(jump.includes("type: \"tuple\",") && jump.includes("Number(sourceGateEntity.destinationSolarSystemID),"));
    assert.ok(jump.includes("\"effects.JumpIn\",\n      buildObserverStargateJumpFxOptions({"), "vendor JumpIn");
    const pres = readSource("space/runtime/scene/presentation.js");
    const fxAt = pres.indexOf("\nbroadcastSpecialFx(shipID, guid, options = {}, visibilityEntity = null) {");
    assert.ok(fxAt >= 0, "broadcastSpecialFx signature");
    const fxBody = pres.slice(fxAt, pres.indexOf("\n  },", fxAt));
    assert.ok(fxBody.includes("deliveredCount: 0,") && fxBody.includes("deliveredCount: stamp === null ? 0 : 1,"));
  });

  test("TJF5 config: defaults, clamp, trafficSettingsOf passes the new keys", () => {
    const d = trafficOf();
    assert.deepStrictEqual([d.gateJumpFxEnabled, d.gateJumpInDurationMs, d.gateJumpOutDespawnMs], [false, 5000, 3000]);
    const hi = trafficOf({ EVEJS_LNE_HIGHSEC_LIFE_TRAFFIC_GATE_JUMP_FX_ENABLED: "1",
      EVEJS_LNE_HIGHSEC_LIFE_TRAFFIC_GATE_JUMP_IN_DURATION_MS: "999999",
      EVEJS_LNE_HIGHSEC_LIFE_TRAFFIC_GATE_JUMP_OUT_DESPAWN_MS: "1" });
    assert.deepStrictEqual([hi.gateJumpFxEnabled, hi.gateJumpInDurationMs, hi.gateJumpOutDespawnMs],
      [true, 20000, 1000]);
    const S = T({ gateJumpFxEnabled: true, gateJumpInDurationMs: 7000, gateJumpOutDespawnMs: 4000 });
    assert.deepStrictEqual([S.gateJumpFxEnabled, S.gateJumpInDurationMs, S.gateJumpOutDespawnMs], [true, 7000, 4000]);
    assert.strictEqual(trafficSettingsOf({ highsecLife: { traffic: { ...trafficOf(), gateJumpOutDespawnMs: 0 } } })
      .detail, "traffic.gateJumpOutDespawnMs");
  });

  function jumpedOut(h, S) {
    h.step(0);
    h.step(S.departDelayMs);
    h.step(1);
    assert.strictEqual(h.jumpOuts.length, h.specs.length, "every ship got its JumpOut");
  }

  test("GCE3 traffic: controller flag off = no gateEvents and no Departure; both flags on = Arrival through the "
    + "spawn spec, Departure at the JumpOut gate right before the despawn; LEFT despawn without Departure; "
    + "budget 1 over two ships = one event and a budget cut", () => {
    const base = { gateJumpFxEnabled: true, stationTargetPermille: 0 };
    const off = harness(T(base), true);
    jumpedOut(off, T(base));
    off.step(T(base).gateJumpOutDespawnMs);
    assert.ok(off.specs.every((s) => !("gateEvents" in s)), "controller flag off: spec unchanged");
    assert.deepStrictEqual(off.order.filter((e) => e[0] === "departure"), []);
    const offFx = harness(T({ ...base, gateJumpFxEnabled: false, gateControllerEventsEnabled: true }), true);
    offFx.step(0);
    assert.ok(offFx.specs.every((s) => !("gateEvents" in s) && !("jumpInMs" in s)), "needs gateJumpFxEnabled");

    const S = T({ ...base, gateControllerEventsEnabled: true });
    const on = harness(S, true);
    jumpedOut(on, S);
    const n = on.specs.length;
    assert.ok(n >= 2 && on.specs.every((s) => s.gateEvents === true && s.jumpInMs === S.gateJumpInDurationMs));
    on.step(S.gateJumpOutDespawnMs);
    const ids = on.jumpOuts.map((j) => j[1]);
    assert.deepStrictEqual(on.order.filter((e) => e[0] === "departure"), ids.map((id) => ["departure", SYS, id, 50002]));
    for (const id of ids) {
      const dep = on.order.findIndex((e) => e[0] === "departure" && e[2] === id);
      const gone = on.order.findIndex((e) => e[0] === "despawn" && e.includes(id));
      assert.ok(dep >= 0 && gone > dep, `Departure of ${id} before its despawn`);
    }
    let c = on.traffic.status().counters;
    assert.deepStrictEqual([on.traffic.shipsIn(SYS), c.gateArrivalEvents, c.gateDepartureEvents, c.gateEventFailed,
      c.gateEventBudgetCut], [0, n, n, 0, 0]);

    const left = harness(T({ ...base, gateControllerEventsEnabled: true, exitGraceMs: 0 }), true);
    jumpedOut(left, S);
    left.pilots.space = 0;
    left.step(1);
    assert.strictEqual(left.traffic.shipsIn(SYS), 0, "LEFT despawn");
    assert.deepStrictEqual(left.order.filter((e) => e[0] === "departure"), [], "LEFT: no Departure");

    const g = fakeGameScene();
    g.entities.set(50001, { itemID: 50001, kind: "stargate", destinationSolarSystemID: DEST });
    const spec = { profileId: "p", gateId: 50001, spawnOffsetMeters: 0, jumpInMs: 5000 };
    assert.deepStrictEqual(g.seam.spawnCivilian(SYS, { ...spec, gateEvents: true }), { ok: true, entityId: 9001,
      jumpIn: true, arrival: true });
    assert.deepStrictEqual(g.log.map((e) => e[0]), ["publish", "fx", "history"]);
    assert.deepStrictEqual(g.log[2][1], ["OnClientControllerEvent", [50001, 9001, "Arrival"]]);
    assert.strictEqual(g.seam.spawnCivilian(SYS, { ...spec, jumpInMs: undefined, gateEvents: true }).reason,
      "INVALID_INPUT", "gateEvents needs jumpInMs");
    assert.deepStrictEqual(g.seam.presentGateDeparture(SYS, 9001, 50002), { ok: true, sent: true, queued: 1 });
    assert.deepStrictEqual(g.log[g.log.length - 1][1], ["OnClientControllerEvent", [50002, 9001, "Departure"]]);
    assert.strictEqual(g.seam.presentGateDeparture(SYS + 1, 9001, 50002).reason, "SCENE_NOT_LOADED");

    const tight = harness(T({ ...base, gateControllerEventsEnabled: true, gateControllerEventMaxPerPass: 1 }), true);
    jumpedOut(tight, S);
    assert.strictEqual(tight.specs.filter((s) => s.gateEvents === true).length, 1, "one Arrival in the spawn pass");
    tight.step(S.gateJumpOutDespawnMs);
    c = tight.traffic.status().counters;
    assert.deepStrictEqual([tight.order.filter((e) => e[0] === "departure").length, c.gateDepartureEvents,
      c.gateEventBudgetCut, tight.traffic.shipsIn(SYS)], [1, 1, 2 * (n - 1), 0]);
  });

  test("GCE5 config: gate controller defaults, clamp 501 -> 500, trafficSettingsOf passes the new keys", () => {
    const d = trafficOf();
    assert.deepStrictEqual([d.gateControllerEventsEnabled, d.gateControllerEventMaxPerPass], [false, 40]);
    const bounty = resolveConfig({ modDir: MOD_DIR, env: {} }).config.bountyHunters;
    assert.strictEqual(bounty.gateControllerEventsEnabled, false);
    const hi = trafficOf({ EVEJS_LNE_HIGHSEC_LIFE_TRAFFIC_GATE_CONTROLLER_EVENTS_ENABLED: "1",
      EVEJS_LNE_HIGHSEC_LIFE_TRAFFIC_GATE_CONTROLLER_EVENT_MAX_PER_PASS: "501" });
    assert.deepStrictEqual([hi.gateControllerEventsEnabled, hi.gateControllerEventMaxPerPass], [true, 500]);
    const S = T({ gateControllerEventsEnabled: true, gateControllerEventMaxPerPass: 0 });
    assert.deepStrictEqual([S.gateControllerEventsEnabled, S.gateControllerEventMaxPerPass], [true, 0]);
    assert.strictEqual(trafficSettingsOf({ highsecLife: { traffic: { ...trafficOf(),
      gateControllerEventsEnabled: "yes" } } }).detail, "traffic.gateControllerEventsEnabled");
  });
};
