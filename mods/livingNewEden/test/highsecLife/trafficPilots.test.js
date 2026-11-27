"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { resolveConfig } = require("../../config");
const { trafficSettingsOf } = require("../../lib/highsecLife/schema");
const { createTraffic } = require("../../lib/highsecLife/traffic/service");
const { planPilot } = require("../../lib/highsecLife/traffic/plan");
const { createRng } = require("../../lib/util/rng");
const { TRAFFIC_HAULER_PROFILES } = require("../../lib/adapter/data/trafficProfiles");
const { createSpawnBackoff, failureReasonOf } = require("../../lib/materialization/spawnBackoff");
const seams = require("../../lib/adapter/highsecTrafficScene");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const SERVER_SRC = path.resolve(MOD_DIR, "..", "..", "server", "src");
const T0 = Date.UTC(2026, 10, 20, 12, 0, 0);
const SYS = 30000144;
const FROM = 30000143;
const NEXT = 30000145;
const STEP_MS = 5000;

const DEFAULTS = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_DATA_ROOT: os.tmpdir() } }).config;

function T(over) {
  const r = trafficSettingsOf({ highsecLife: { traffic: { ...DEFAULTS.highsecLife.traffic, ...(over || {}) } } });
  assert.ok(r.ok, JSON.stringify(r));
  return r.settings;
}

const LIVE_ON = Object.freeze({ ...DEFAULTS.population.live, trafficEnabled: true });
const node = (itemId, x, toSystemId) => ({ itemId, position: { x, y: 0, z: 0 }, radius: 5000,
  ...(toSystemId ? { toSystemId } : {}) });
const NODES = Object.freeze({ gates: [node(50001, 0, FROM), node(50002, 1e9, NEXT), node(50003, -1e9)],
  stations: [node(60001, 5e8)], belts: [] });

function fakeScene(opts = {}) {
  const log = [];
  const alive = new Map();
  const refuse = [];
  let next = opts.firstId || 9000;
  const scene = {
    readNodes: () => ({ ok: true, ...NODES }),
    readPlayers: () => ({ ok: true, ships: [{ characterId: 1 }] }),
    spawnCivilian: (_id, spec) => {
      log.push(["spawn", spec]);
      if (refuse.length > 0) return refuse.shift();
      next += 1;
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
    listTrafficIds: () => ({ ok: true, ids: opts.orphans ? [...opts.orphans] : [] }),
    dockPointOf: () => ({ ok: true, point: { x: 5e8, y: 0, z: 9000 }, direction: { x: 0, y: 0, z: 1 } }),
  };
  return { scene, log, alive, refuse };
}

function fakePopulation(cands, state = "running", opts = {}) {
  const calls = { status: 0, candidates: 0, claim: [], release: [], group: [], memberRelease: [] };
  const owned = new Map();
  let token = 0;
  const pop = {
    calls, owned, cands,
    getStatus: () => {
      calls.status += 1;
      return { state };
    },
    liveCandidatesIn: (_sys, _since, limit, acceptHull) => {
      calls.candidates += 1;
      const free = pop.cands.filter((c) => !owned.has(c.pilotId));
      const ok = opts.accept === true && typeof acceptHull === "function"
        ? free.filter((c) => acceptHull(c.shipTypeId)) : free;
      return ok.slice(0, limit);
    },
    claimLive: (id) => {
      calls.claim.push(id);
      if (opts.refuseClaim && opts.refuseClaim.has(id)) return { ok: false, reason: "OWNED_FULL" };
      if (owned.has(id)) return { ok: false, reason: "ALREADY_OWNED" };
      token += 1;
      owned.set(id, token);
      return { ok: true, token };
    },
    releaseLive: (id, tk, outcome) => {
      calls.release.push([id, outcome]);
      if (owned.get(id) !== tk) return { ok: true, applied: false };
      owned.delete(id);
      if (outcome === "JUMPED" || outcome === "KILLED") pop.cands = pop.cands.filter((c) => c.pilotId !== id);
      return { ok: true, applied: true };
    },
  };
  if (opts.groups instanceof Map) {
    pop.liveGroupOf = (leaderId) => {
      calls.group.push(leaderId);
      if (!owned.has(leaderId)) return { ok: false, reason: "NOT_OWNED" };
      return { ok: true, members: opts.groups.get(leaderId) || [] };
    };
    pop.releaseGroupMember = (memberId, leaderId, tk) => {
      const applied = owned.get(leaderId) === tk;
      calls.memberRelease.push([memberId, leaderId, tk, applied]);
      return { ok: true, applied };
    };
  }
  return pop;
}

const cand = (pilotId, role, exit, fromSystemId, toSystemId) => ({ pilotId, kind: role === "UNDOCK" ? "DEPART" : "ARRIVE",
  role, exit, fromSystemId, toSystemId, shipTypeId: 648, at: T0 });

function harness({ settings, pop, live, scene, rng, extra, groupSpawn, plExtra } = {}) {
  const clock = { t: T0, now() { return clock.t; } };
  const presence = { observedSystems: () => [SYS], getSystemPresence: () => ({ space: 1 }) };
  const f = scene || fakeScene();
  const holder = { pop: pop || null };
  const backoff = createSpawnBackoff(DEFAULTS.materialization.spawnBackoff);
  const made = createTraffic({ settings: settings || T(), scene: f.scene, clock, rng: rng || (() => 0),
    getPresence: () => presence, describeSystem: () => ({ secClass: "highsec" }), wantedOf: () => 45,
    profiles: TRAFFIC_HAULER_PROFILES, getGovernor: () => ({ admits: () => true }),
    ...(holder.pop || live ? { populationLive: { settings: live || LIVE_ON, getPopulation: () => holder.pop,
      leaseOf: () => ({ ok: true, characterId: null }), spawnBackoff: backoff, failureReasonOf,
      ...(groupSpawn ? { groupSpawn } : {}), ...(plExtra || {}) } } : {}),
    ...(extra || {}) });
  assert.ok(made.ok, JSON.stringify(made));
  const tick = (n = 1) => {
    for (let i = 0; i < n; i += 1) {
      made.traffic.tick();
      clock.t += STEP_MS;
    }
  };
  return { traffic: made.traffic, clock, holder, backoff, tick, ...f };
}

const spawns = (h) => h.log.filter((e) => e[0] === "spawn").map((e) => e[1]);

module.exports = ({ test }) => {
  test("PT1 flag off = on with a failed population = mix without candidates: same calls and counters, no live call",
    () => {
      const run = (opts) => {
        const h = harness({ rng: createRng(20261120).nextFloat, ...opts });
        h.tick(80);
        const st = h.traffic.status();
        return { log: JSON.stringify(h.log), counters: st.counters, ships: st.ships };
      };
      const off = run({});
      assert.ok(off.counters.spawned >= 2 && off.counters.arrived >= 1, JSON.stringify(off.counters));
      const failed = fakePopulation([cand(1, "HAULER", "GATE", FROM, NEXT)], "failed");
      const onFailed = run({ pop: failed });
      const empty = fakePopulation([]);
      const mixEmpty = run({ pop: empty, live: { ...LIVE_ON, trafficMode: "mix" } });
      assert.deepStrictEqual(onFailed, off);
      assert.deepStrictEqual(mixEmpty, off, "mix without candidates");
      assert.deepStrictEqual([failed.calls.candidates, failed.calls.claim.length, failed.calls.release.length],
        [0, 0, 0]);
      assert.deepStrictEqual([empty.calls.claim.length, empty.calls.release.length], [0, 0]);
      assert.ok(empty.calls.candidates > 0);
      for (const k of ["pilotSpawned", "pilotCapRefused", "pilotKilled"]) assert.strictEqual(off.counters[k], 0);
    });

  test("PT4 replace / mix: candidates only, gates from toSystemId, caps, KILLED, JUMPED, budget, backoff, one ship",
    () => {
      const pop = fakePopulation([cand(1, "HAULER", "GATE", FROM, NEXT), cand(2, "UNDOCK", "GATE", 0, NEXT)]);
      const h = harness({ pop });
      h.tick();
      assert.deepStrictEqual(spawns(h).map((s) => [s.gateId, s.stationId, s.undock]),
        [[50001, undefined, undefined], [undefined, 60001, true]]);
      assert.deepStrictEqual(pop.calls.claim, [1, 2]);
      assert.strictEqual(h.traffic.status().pilots, 2);
      const [, e1] = [...h.alive.keys()];
      h.alive.delete(e1);
      h.tick();
      assert.deepStrictEqual(pop.calls.release, [[2, "KILLED"]]);
      h.tick(10);
      const warp = h.log.find((e) => e[0] === "warp");
      assert.ok(Math.abs(warp[2].x - (1e9 - 7500)) < 1, JSON.stringify(warp));
      assert.deepStrictEqual(pop.calls.release, [[2, "KILLED"], [1, "JUMPED"]]);
      const c = h.traffic.status().counters;
      assert.deepStrictEqual([c.pilotSpawned, c.pilotKilled, c.spawned, h.traffic.status().pilots], [2, 1, 2, 0]);

      const many = () => fakePopulation([1, 2, 3, 4, 5, 6].map((id) => cand(id, "HAULER", "STATION", FROM, 0)));
      const capped = many();
      const hc = harness({ pop: capped, live: { ...LIVE_ON, maxSpawnsPerSystemPass: 10 } });
      hc.tick();
      assert.deepStrictEqual([spawns(hc).length, hc.traffic.status().counters.pilotCapRefused], [4, 2]);
      const global = many();
      const hg = harness({ pop: global, settings: T({ maxShipsGlobal: 3 }), live: { ...LIVE_ON,
        maxSpawnsPerSystemPass: 10 } });
      hg.tick();
      assert.deepStrictEqual([spawns(hg).length, hg.traffic.status().counters.pilotCapRefused], [3, 3]);
      const mixed = many();
      const hm = harness({ pop: mixed, live: { ...LIVE_ON, trafficMode: "mix", maxSpawnsPerSystemPass: 10 } });
      hm.tick();
      assert.deepStrictEqual([spawns(hm).length, hm.traffic.status().counters.pilotSpawned,
        hm.traffic.status().counters.pilotCapRefused], [2, 2, 4]);
      const one = fakePopulation([cand(7, "HAULER", "STATION", FROM, 0)]);
      const h1 = harness({ pop: one, live: { ...LIVE_ON, trafficMode: "mix" } });
      h1.tick();
      assert.deepStrictEqual([spawns(h1).length, h1.traffic.status().counters.pilotSpawned], [2, 1], "1 pilot + 1 random");

      const rp = fakePopulation([cand(8, "HAULER", "GATE", FROM, NEXT)]);
      const hr = harness({ pop: rp });
      hr.refuse.push({ ok: false, reason: "SCENE_NPC_BUDGET" });
      hr.tick();
      assert.deepStrictEqual(rp.calls.release, [[8, "REFUSED"]]);
      assert.strictEqual(hr.backoff.blocked("pop:8", hr.clock.t), null);
      hr.refuse.push({ ok: false, reason: "SPAWN_FAILED", detail: "NPC_NATIVE_NO_FREE_SLOT" });
      hr.tick(3);
      assert.deepStrictEqual(rp.calls.release, [[8, "REFUSED"], [8, "REFUSED"]]);
      assert.strictEqual(hr.backoff.blocked("pop:8", hr.clock.t).reason, "NPC_NATIVE_NO_FREE_SLOT");
      hr.tick(4);
      assert.strictEqual(spawns(hr).length, 2, "held by the backoff");
      assert.ok(hr.traffic.status().counters.pilotBackoff >= 1);
      const ng = fakePopulation([cand(9, "HAULER", "GATE", FROM, 30009999)]);
      const hn = harness({ pop: ng });
      hn.tick();
      assert.deepStrictEqual([ng.calls.claim.length, hn.traffic.status().counters.pilotNoGate], [0, 1]);

      const p1 = fakePopulation([cand(10, "HAULER", "STATION", FROM, 0)]);
      const hp = harness({ pop: p1 });
      hp.tick();
      const p2 = fakePopulation([cand(10, "HAULER", "STATION", FROM, 0)]);
      hp.holder.pop = p2;
      hp.tick(4);
      assert.deepStrictEqual([spawns(hp).length, p2.calls.claim.length], [1, 0]);
    });

  test("PT5 traffic restart, seam (toSystemId, SCENE_NPC_BUDGET, SEAM_METHODS), vendor fact, config W200 / W199",
    () => {
      const pop = fakePopulation([cand(11, "HAULER", "GATE", FROM, NEXT)]);
      const h = harness({ pop, scene: fakeScene({ orphans: [8001, 8002] }) });
      h.tick();
      const firstSpawn = h.log.findIndex((e) => e[0] === "spawn");
      const orphans = h.log.findIndex((e) => e[0] === "despawn" && e[1].includes(8001));
      assert.ok(orphans >= 0 && orphans < firstSpawn, JSON.stringify(h.log.slice(0, 3)));
      h.traffic.stop();
      assert.deepStrictEqual(pop.calls.release, [[11, "LEFT"]]);

      const statics = [{ kind: "stargate", itemID: 2, position: { x: 1, y: 0, z: 0 }, radius: 1,
        destinationSolarSystemID: NEXT }, { kind: "stargate", itemID: 3, position: { x: 2, y: 0, z: 0 }, radius: 1,
        destinationSolarSystemID: 0 }, { kind: "station", itemID: 4, position: { x: 3, y: 0, z: 0 }, radius: 1,
        destinationSolarSystemID: NEXT }];
      const scene = { staticEntities: statics, getEntityByID: () => null };
      const runtime = { scenes: new Map([[SYS, scene]]), isSolarSystemSceneLoaded: (id) => id === SYS };
      const spawn = { pickGridAnchor: () => ({ ok: true, anchorDescriptor: { kind: "gate" }, radiusMeters: 1 }),
        spawnShip: () => ({ ok: false, reason: "SCENE_NPC_BUDGET" }), publish: () => ({ ok: true, published: 1 }),
        despawn: () => ({ ok: true }) };
      const seam = seams.createHighsecTrafficScene({ getNpcSpawn: () => spawn, getHuntScene: () => null,
        requireGame: (rel) => (rel === "space/runtime" ? { ok: true, exports: runtime } : { ok: false }) });
      const nodes = seam.readNodes(SYS);
      assert.deepStrictEqual(nodes.gates.map((g) => [g.itemId, g.toSystemId]), [[2, NEXT], [3, undefined]]);
      assert.ok(!("toSystemId" in nodes.gates[1]) && !("toSystemId" in nodes.stations[0]));
      assert.deepStrictEqual(seam.spawnCivilian(SYS, { profileId: "p", gateId: 2, spawnOffsetMeters: 0 }),
        { ok: false, reason: "SCENE_NPC_BUDGET" });
      assert.deepStrictEqual(Object.keys(seam).sort(), [...seams.SEAM_METHODS, ...seams.AGGRO_METHODS,
        ...seams.RAT_AGGRO_METHODS, ...seams.FX_METHODS, ...seams.PATROL_METHODS, ...seams.EXPLORER_METHODS].sort());
      const src = fs.readFileSync(path.join(SERVER_SRC, "space", "runtime", "staticSceneEntity.js"), "utf8");
      assert.ok(src.includes("destinationSolarSystemID: stargate.destinationSolarSystemID"), "vendor fact");

      assert.deepStrictEqual([DEFAULTS.population.live.trafficEnabled, DEFAULTS.population.live.trafficMode], [false,
        "replace"]);
      assert.ok(!resolveConfig({ modDir: MOD_DIR, env: {} }).warnings.some((w) => /population\.live/.test(w)));
      const bad = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_POPULATION_LIVE_TRAFFIC_MODE: "both" } });
      assert.ok(bad.errors.some((e) => /trafficMode|TRAFFIC_MODE/.test(e)) || bad.warnings.some((w) => /TRAFFIC_MODE|trafficMode/.test(w)),
        JSON.stringify([bad.errors, bad.warnings]));
      const w200 = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_POPULATION_ENABLED: "1",
        EVEJS_LNE_POPULATION_LIVE_TRAFFIC_ENABLED: "1", EVEJS_LNE_POPULATION_LIVE_OWN_MAX_MS: "60000" } }).warnings;
      for (const re of [/without population\.near\.enabled - no arrival ring/, /without highsecLife\.enabled and highsecLife\.traffic\.enabled/,
        /ownMaxMs=60000 not above/]) {
        assert.ok(w200.some((w) => re.test(w)), `${re} in ${w200.join(" | ")}`);
      }
      const onDefaults = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_POPULATION_ENABLED: "1",
        EVEJS_LNE_POPULATION_LIVE_TRAFFIC_ENABLED: "1" } }).warnings;
      assert.ok(!onDefaults.some((w) => /ownMaxMs=.* not above/.test(w)), onDefaults.join(" | "));
      const w199 = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_POPULATION_ENABLED: "1",
        EVEJS_LNE_POPULATION_LIVE_LOCAL_ENABLED: "1" } }).warnings;
      assert.ok(w199.some((w) => w === "population.live.localEnabled without localPilots.enabled - no effect"));
    });

  test("PAE4 planPilot: RATTER / EXPLORER candidates without their own plan = NO_ROUTE, the known roles plan", () => {
    const rng = createRng(5).nextFloat;
    for (const role of ["RATTER", "EXPLORER", undefined]) {
      assert.deepStrictEqual(planPilot(cand(1, role, "NONE", 0, 0), NODES, rng, T()), { ok: false,
        reason: "NO_ROUTE" }, String(role));
    }
    assert.strictEqual(planPilot(cand(1, "HAULER", "GATE", FROM, NEXT), NODES, rng, T()).role, "HAULER");
    assert.strictEqual(planPilot(cand(1, "UNDOCK", "GATE", 0, NEXT), NODES, rng, T()).role, "UNDOCK");
  });
};

module.exports.rig = { harness, fakePopulation, cand, FROM, NEXT, LIVE_ON, T, SYS, NODES, fakeScene };
