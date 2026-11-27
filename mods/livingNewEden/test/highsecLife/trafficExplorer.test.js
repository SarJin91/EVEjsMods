"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { resolveConfig } = require("../../config");
const { trafficSettingsOf } = require("../../lib/highsecLife/schema");
const { createTraffic } = require("../../lib/highsecLife/traffic/service");
const { pickRole, safeSpotOf, pickExplorerRoute, pickSites, planPilot, stepShip, SHIP_STATE } =
  require("../../lib/highsecLife/traffic/plan");
const { createRng } = require("../../lib/util/rng");
const CIV = require("../../lib/adapter/data/civilianLiveProfiles");
const rig = require("./trafficPilots.test.js").rig;

const MOD_DIR = path.resolve(__dirname, "..", "..");
const T0 = Date.UTC(2026, 10, 27, 22, 0, 0);
const SYS = 30000144;
const DEFAULTS = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_DATA_ROOT: os.tmpdir() } }).config;

function T(over, hulls = true) {
  const r = trafficSettingsOf({ highsecLife: { civilianHullsEnabled: hulls,
    traffic: { ...DEFAULTS.highsecLife.traffic, explorerEnabled: true, ...(over || {}) } } });
  assert.ok(r.ok, JSON.stringify(r));
  return r.settings;
}

const node = (itemId, x, toSystemId) => ({ itemId, position: { x, y: 0, z: 0 }, radius: 5000,
  ...(toSystemId ? { toSystemId } : {}) });
const NODES = Object.freeze({ gates: [node(50001, 0, rig.FROM), node(50002, 1e9, rig.NEXT)], stations: [],
  belts: [node(40001, 3e8)] });
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const at = (x, z = 0) => ({ x, y: 0, z });
const A = Object.freeze({ siteId: 101, family: "data", position: at(2e8, 5e8) });
const B = Object.freeze({ siteId: 102, family: "relic", position: at(6e8, 5e8) });

function counted(rng) {
  const c = { n: 0 };
  c.rng = () => {
    c.n += 1;
    return rng();
  };
  return c;
}

function exploreScene(state) {
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
    presentPatrolOrbit: (_s, entityId) => {
      log.push(["orbit", entityId]);
      return { ok: true, orbiting: true };
    },
    releasePatrolMotion: () => ({ ok: true, released: true }),
    readExplorerSites: (systemId, opts) => {
      log.push(["read", systemId, opts]);
      return { ok: true, sites: state.sites.slice(), read: state.sites.length, npcBlocked: state.blocked || 0 };
    },
  };
  return { scene, log };
}

function harness(settings, state) {
  const clock = { t: T0, now() { return clock.t; } };
  const presence = { observedSystems: () => [SYS], getSystemPresence: () => ({ space: 1 }) };
  const f = exploreScene(state);
  const made = createTraffic({ settings, scene: f.scene, clock, rng: () => 0, getPresence: () => presence,
    describeSystem: () => ({ secClass: "highsec" }), wantedOf: () => 45,
    profiles: [{ profileId: "vendor", weight: 1 }], getGovernor: () => ({ admits: () => true }) });
  assert.ok(made.ok, JSON.stringify(made));
  const step = (ms) => {
    clock.t += ms;
    made.traffic.tick();
  };
  const of = (id) => f.log.filter((e) => e[1] === id || (e[0] === "despawn" && e[1].includes(id)));
  return { traffic: made.traffic, step, of, ...f };
}

module.exports = ({ test }) => {
  test("EV2 explorer plan: safe spot deterministic and clear of every node, none in a crowded system; sites without "
    + "repeats at the landing distance; role draw unchanged with the flag off; pilot start and flags", () => {
    const S = T();
    for (let seed = 1; seed <= 30; seed += 1) {
      const a = safeSpotOf(at(0), NODES, createRng(seed).nextFloat, S);
      assert.deepStrictEqual(a, safeSpotOf(at(0), NODES, createRng(seed).nextFloat, S), "same seed, same spot");
      if (a === null) continue;
      for (const n of [...NODES.gates, ...NODES.belts]) {
        assert.ok(dist(n.position, a) >= S.explorerSafeSpotMinMeters, JSON.stringify(a));
      }
    }
    assert.notStrictEqual(safeSpotOf(at(0), NODES, () => 0, S), null);
    assert.strictEqual(safeSpotOf(at(0), NODES, () => 0, T({ explorerSafeSpotMinMeters: 100000000,
      explorerSafeSpotOffsetMeters: 0 })), null, "no room = no safe spot");

    const two = T({ explorerMaxSites: 2 });
    const pool = [B, A, { siteId: 103, family: "data", position: at(9e8, 5e8) }];
    const from = at(0, 1.5e6);
    for (let seed = 1; seed <= 20; seed += 1) {
      const legs = pickSites(pool, createRng(seed).nextFloat, two, from);
      assert.strictEqual(legs.length, 2);
      assert.strictEqual(new Set(legs.map((l) => l.targetId)).size, 2, "no repeated site");
      for (const leg of legs) {
        const s = pool.find((p) => p.siteId === leg.targetId);
        assert.ok(Math.abs(dist(leg.point, s.position) - two.explorerSiteOffsetMeters) < 1e-3);
        assert.ok(dist(leg.point, from) < dist(s.position, from), "landing on the near side");
        assert.deepStrictEqual([leg.kind, leg.dwellMs], ["SITE", two.explorerSiteDwellMs]);
      }
    }
    assert.deepStrictEqual(pickSites([], () => 0, two, from), []);
    const route = pickExplorerRoute(NODES, () => 0, S);
    const k = S.explorerMaxSites;
    assert.strictEqual(route.stayMs, S.explorerScanMs * k + k * S.explorerSiteDwellMs + (k + 2) * S.explorerLegMs);

    const legacy = { undockEnabled: true, undockPermille: 200, minerEnabled: true, minerPermille: 300,
      explorerPermille: 1000 };
    const nodes = { ...NODES, stations: [node(60001, 7e8)] };
    for (const S2 of [T({ ...legacy, explorerEnabled: false }), T(legacy, false)]) {
      const src = counted(createRng(11).nextFloat);
      const ref = createRng(11).nextFloat;
      for (let i = 0; i < 200; i += 1) {
        const roll = ref() * 1000;
        const want = roll < 200 ? "UNDOCK" : roll < 500 ? "MINER" : "HAULER";
        assert.strictEqual(pickRole(src.rng, nodes, S2), want);
      }
      assert.strictEqual(src.n, 200, "one draw per role");
    }
    const full = T({ explorerPermille: 1000 });
    assert.strictEqual(pickRole(() => 0, NODES, full, { EXPLORER: 0 }), "EXPLORER");
    assert.strictEqual(pickRole(() => 0, NODES, full, { EXPLORER: full.explorerMaxPerSystem }), "HAULER");

    const cand = (fromSystemId) => ({ pilotId: 1, role: "EXPLORER", exit: "NONE", fromSystemId, toSystemId: 0 });
    const viaGate = planPilot(cand(rig.FROM), NODES, () => 0.9, S);
    assert.deepStrictEqual([viaGate.ok, viaGate.role, viaGate.explore.start.node.itemId], [true, "EXPLORER", 50001]);
    assert.strictEqual(planPilot(cand(0), nodes, () => 0, S).explore.start.kind, "station");
    assert.strictEqual(planPilot(cand(0), NODES, () => 0, S).explore.start.kind, "stargate");
    assert.deepStrictEqual(planPilot(cand(rig.FROM), NODES, () => 0, T({ explorerEnabled: false })),
      { ok: false, reason: "NO_ROUTE" });
    assert.deepStrictEqual(planPilot(cand(rig.FROM), NODES, () => 0, T({}, false)), { ok: false, reason: "NO_ROUTE" });

    const p = at(0);
    const seen = { live: true, inWarp: false, position: p };
    const ship = { role: "EXPLORER", state: SHIP_STATE.SPAWNED, targetPoint: null, spawnedAt: 0, warpAttempts: 0,
      leg: "PATROL", legs: [{ kind: "SAFE", targetId: 0, point: null, dwellMs: 1 }], legIndex: 0, stayMs: 1 };
    assert.deepStrictEqual(stepShip(ship, seen, S.departDelayMs, S), { kind: "dwell" }, "scan in place");
    const dwelling = { ...ship, state: SHIP_STATE.DWELLING, dwellUntil: 10 };
    assert.deepStrictEqual(stepShip(dwelling, seen, 10, S), { kind: "explore" });
    assert.deepStrictEqual(stepShip({ ...dwelling, leg: "EXIT" }, seen, 10, S), { kind: "leave" });
  });

  test("EV3 traffic explorer: safe spot, scan, read, site 1, re-read without site 2 = gone, exit; no site = exit "
    + "after the scan; read budget keeps the second explorer dwelling; no orbit; aggro never reads an explorer", () => {
    const S = T({ explorerPermille: 1000, explorerMaxPerSystem: 1, explorerMaxSites: 2, spawnIntervalMs: 3600000 });
    const state = { sites: [B, A], blocked: 1 };
    const h = harness(S, state);
    h.step(0);
    const id = h.log.find((e) => e[0] === "spawn")[1];
    h.step(S.departDelayMs);
    h.step(1);
    h.step(S.explorerScanMs * S.explorerMaxSites);
    h.step(1);
    state.sites = [A];
    h.step(S.explorerSiteDwellMs);
    h.step(1);
    h.step(S.dockDelayMs);
    const mine = h.of(id).map((e) => e[0]);
    assert.deepStrictEqual(mine, ["spawn", "warp", "warp", "warp", "despawn"]);
    const warps = h.of(id).filter((e) => e[0] === "warp").map((e) => e[2]);
    assert.ok(Math.abs(warps[0].y - S.explorerSafeSpotOffsetMeters) < 1e-6, "safe spot above the gates");
    assert.ok(Math.abs(dist(warps[1], A.position) - S.explorerSiteOffsetMeters) < 1e-3, "site 101 first");
    const reads = h.log.filter((e) => e[0] === "read");
    assert.strictEqual(reads.length, 2);
    assert.deepStrictEqual(reads[0].slice(1), [SYS, { families: ["data", "relic"], npcClearMeters: S.explorerNpcClearMeters,
      maxSites: 2 }]);
    assert.deepStrictEqual(h.log.filter((e) => e[0] === "orbit"), [], "an explorer never orbits");
    const c = h.traffic.status().counters;
    assert.deepStrictEqual([c.explorers, c.explorerScans, c.explorerSites, c.explorerSiteGone, c.explorerNpcBlocked,
      c.explorerNoSite, c.explorerNoSafeSpot], [1, 1, 1, 1, 2, 0, 0]);

    const empty = harness(S, { sites: [] });
    empty.step(0);
    const eid = empty.log.find((e) => e[0] === "spawn")[1];
    empty.step(S.departDelayMs);
    empty.step(1);
    empty.step(S.explorerScanMs * S.explorerMaxSites);
    assert.strictEqual(empty.of(eid).filter((e) => e[0] === "warp").length, 2, "safe spot, then the exit");
    assert.strictEqual(empty.traffic.status().counters.explorerNoSite, 1);

    const pair = harness(T({ explorerPermille: 1000, explorerMaxPerSystem: 2, explorerSiteReadsPerPass: 1,
      spawnIntervalMs: 3600000 }), { sites: [A] });
    pair.step(0);
    const ids = pair.log.filter((e) => e[0] === "spawn").map((e) => e[1]);
    assert.strictEqual(ids.length, 2);
    pair.step(S.departDelayMs);
    pair.step(1);
    pair.step(S.explorerScanMs * S.explorerMaxSites);
    const warpsOf = (x) => pair.of(x).filter((e) => e[0] === "warp").length;
    assert.deepStrictEqual(ids.map(warpsOf), [2, 1], "the second explorer waits for the read budget");
    assert.strictEqual(pair.traffic.status().counters.explorerReadBudget, 1);
    pair.step(1);
    assert.deepStrictEqual(ids.map(warpsOf), [2, 2], "next pass reads for the second explorer");

    const skip = harness(T({ explorerPermille: 1000, explorerMaxPerSystem: 1, explorerSiteReadsPerPass: 0,
      spawnIntervalMs: 3600000 }), { sites: [A] });
    skip.step(0);
    skip.step(S.departDelayMs);
    skip.step(1);
    skip.step(S.explorerScanMs * S.explorerMaxSites);
    assert.deepStrictEqual(skip.log.filter((e) => e[0] === "read"), [], "0 reads per pass = no site read");
    assert.strictEqual(skip.traffic.status().counters.explorerNoSite, 1);

    const f = rig.fakeScene();
    f.scene.readNodes = () => ({ ok: true, ...NODES });
    f.scene.readExplorerSites = () => ({ ok: true, sites: [], read: 0, npcBlocked: 0 });
    const threatReads = [];
    f.scene.readThreats = (sys, list) => {
      threatReads.push([...list]);
      return { ok: true, threats: [] };
    };
    f.scene.armPilotTarget = () => ({ ok: false, reason: "X" });
    f.scene.disarmPilotTarget = () => ({ ok: true, released: 0, kept: 0, releaseFailed: 0 });
    const pop = rig.fakePopulation([rig.cand(1, "HAULER", "GATE", rig.FROM, rig.NEXT),
      rig.cand(2, "EXPLORER", "NONE", rig.FROM, 0)]);
    pop.standings = () => ({ profileOf: (x) => x, relationOf: () => 0 });
    const live = { ...rig.LIVE_ON, standingAggroEnabled: true };
    const p = rig.harness({ settings: S, pop, live, scene: f });
    p.tick(1);
    p.clock.t += live.spawnGapMs;
    p.tick(1);
    assert.deepStrictEqual(pop.calls.claim, [1, 2]);
    assert.strictEqual(p.traffic.status().counters.explorers, 1);
    assert.ok(threatReads.length > 0 && threatReads.every((list) => !list.includes(9002)), JSON.stringify(threatReads));
  });

  test("EV5 explorer config and data: defaults off with the documented values, family parser, env lines in compose, "
    + "EXPLORER hulls with the empty loadout", () => {
    const d = DEFAULTS.highsecLife.traffic;
    assert.deepStrictEqual([d.explorerEnabled, d.explorerPermille, d.explorerMaxPerSystem, d.explorerFamilies,
      d.explorerMaxSites, d.explorerScanMs, d.explorerSiteDwellMs, d.explorerSiteOffsetMeters, d.explorerNpcClearMeters,
      d.explorerSafeSpotOffsetMeters, d.explorerSafeSpotMinMeters, d.explorerSafeSpotTries, d.explorerSiteReadsPerPass,
      d.explorerLegMs], [false, 100, 2, "data,relic", 2, 20000, 60000, 5000, 150000, 1500000, 1000000, 4, 4, 60000]);
    assert.deepStrictEqual(T({ explorerFamilies: "relic" }).explorerFamilies, ["relic"]);
    for (const bad of ["data,combat", "", "data,data", "combat_hacking"]) {
      assert.deepStrictEqual(trafficSettingsOf({ highsecLife: { traffic: { ...d, explorerFamilies: bad } } }),
        { ok: false, reason: "INVALID_SETTINGS", detail: "traffic.explorerFamilies" }, bad);
    }
    const env = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_DATA_ROOT: os.tmpdir(),
      EVEJS_LNE_HIGHSEC_LIFE_TRAFFIC_EXPLORER_FAMILIES: "wormhole" } });
    assert.ok([...env.errors, ...env.warnings].some((w) => /explorerFamilies|EXPLORER_FAMILIES/.test(w)),
      JSON.stringify([env.errors, env.warnings]));
    const compose = fs.readFileSync(path.resolve(MOD_DIR, "..", "..", "compose.yaml"), "utf8");
    const names = (compose.match(/EVEJS_LNE_HIGHSEC_LIFE_TRAFFIC_EXPLORER_[A-Z_]+:/g) || []);
    assert.strictEqual(new Set(names).size, 14, "explorerEnabled + 13 explorer keys");
    const hulls = CIV.CIVILIAN_HULLS.filter((h) => h.roles.includes("EXPLORER"));
    assert.deepStrictEqual(hulls.map((h) => [h.key, h.weight]), [["astero", 1], ["stratios", 1]]);
    assert.ok(hulls.every((h) => h.loadoutId === "retail_empty_npc_entity_loadout"));
  });
};
