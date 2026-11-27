"use strict";

const assert = require("node:assert");
const path = require("node:path");

const { resolveConfig } = require("../../config");
const { startAmbientRats, createUnavailableAmbientRats, ambientRatDepsFromAdapter, SEAM_METHODS, FACADE_METHODS,
  ADAPTER_METHODS } = require("../../lib/ambientRats");
const { COUNTER_NAMES } = require("../../lib/ambientRats/schema");
const { buildDefaultServiceDefs } = require("../../lib/runtime/services");
const { PIRATE_KEY_BY_FACTION_ID } = require("../../lib/adapter/data/liveProfiles");
const { EMPIRE_FACTION_IDS } = require("../../lib/adapter/empireNavyCatalog");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const BASE = resolveConfig({ modDir: MOD_DIR, env: {} }).config;
const GURISTAS = 500010;
const SYS_A = 30001001;
const SYS_B = 30001002;
const T0 = 1_000_000;
const FAR = 5_000_000;
const TABLES = { pirateKeyByFactionId: PIRATE_KEY_BY_FACTION_ID, navyFactionIds: [...EMPIRE_FACTION_IDS] };

const P = (x, y = 0, z = 0) => ({ x, y, z });

function harness(overrides = {}, opts = {}) {
  const config = { ...BASE, ambientRats: { ...BASE.ambientRats, enabled: true, groupsNullsec: 2, ...overrides } };
  let now = T0;
  const shipsPerSpawn = opts.shipsPerSpawn || 3;
  const live = new Map();
  const dormant = new Set();
  const players = new Map();
  const space = new Map();
  const standings = new Map();
  const calls = { spawn: [], despawn: [], orders: [], paint: [], aggro: [], seq: [] };
  const aggro = new Map();
  const characters = new Map();
  const anchorsOf = () => [1, 2, 3].map((i) => ({ itemId: 40000000 + i, kind: "planet", position: P(FAR * i) }));
  let nextId = 9000;
  let admits = true;
  const timers = [];
  const bad = [];
  const counts = new Map();
  for (const systemId of opts.observe || []) space.set(systemId, 1);

  const seam = {
    bandOf: () => ({ ok: true, band: opts.band || "nullsec", eligible: true }),
    snapshot: (systemId) => ({ ok: true, anchors: anchorsOf(), blockers: [], ambientIds: [...live.keys()]
      .filter((id) => live.get(id).systemId === systemId) }),
    spawnGroup: (input) => {
      calls.spawn.push(input);
      const refusal = typeof opts.refusal === "function" ? opts.refusal() : null;
      if (refusal) return refusal;
      const anchor = anchorsOf().find((a) => a.itemId === input.anchorId);
      const entityIds = [];
      for (let i = 0; i < shipsPerSpawn; i += 1) {
        nextId += 1;
        live.set(nextId, { systemId: input.systemId, position: anchor.position });
        aggro.set(nextId, false);
        entityIds.push(nextId);
      }
      return { ok: true, entityIds, hulls: entityIds.map(() => "frigate") };
    },
    classifyIds: (_systemId, ids) => ({ ok: true, live: ids.filter((id) => live.has(id)),
      dormant: ids.filter((id) => !live.has(id) && dormant.has(id)),
      gone: ids.filter((id) => !live.has(id) && !dormant.has(id)) }),
    setAggro: (systemId, ids, armed, range) => {
      calls.seq.push("aggro");
      calls.aggro.push({ systemId, ids: [...ids], armed, range });
      let changed = 0;
      for (const id of ids) {
        if (aggro.get(id) !== armed) changed += 1;
        aggro.set(id, armed);
      }
      return { ok: true, changed, missing: 0 };
    },
  };
  const truncated = new Set();
  let playersFail = false;
  const hunt = { readPlayerShips: (systemId) => (playersFail ? { ok: false, reason: "READ_FAILED" }
    : { ok: true, ships: players.get(systemId) || [] }) };
  const scene = {
    readGroup: (_systemId, ids) => ({ ok: true, ships: ids.filter((id) => live.has(id)).map((id) => ({ entityId: id,
      position: live.get(id).position, manualTargetId: 0, aggressorEntityId: 0, aggressedAtMs: 0 })) }),
    orderGroup: (systemId, orders) => {
      calls.seq.push("order");
      calls.orders.push({ systemId, orders });
      return { ok: true, failed: [] };
    },
  };
  const spawn = {
    despawn: (systemId, ids) => {
      calls.despawn.push({ systemId, ids: [...ids] });
      for (const id of ids) {
        live.delete(id);
        dormant.delete(id);
      }
      return { ok: true, removed: ids.length, missing: 0, purged: 0 };
    },
    setRelation: (systemId, ids, relation) => {
      calls.paint.push({ systemId, ids: [...ids], relation });
      return { ok: true, changed: ids.length, unchanged: 0, missing: 0, broadcast: true };
    },
  };
  const presence = {
    observedSystems: () => [...space.keys()],
    getSystemPresence: (id) => (space.has(id) ? { systemId: id, space: space.get(id), docked: 0, transit: 0,
      characters: characters.get(id) || [], ...(truncated.has(id) ? { truncated: true } : {}) } : null),
    onSystemObserved: () => ({ ok: true, unsubscribe: () => {} }),
  };
  const telemetry = {
    count: (name, n) => {
      const short = name.replace(/^world\.ambientRats\./, "");
      if (short === name || !COUNTER_NAMES.includes(short)) bad.push(`BAD_NAME ${name}`);
      counts.set(short, (counts.get(short) || 0) + n);
    },
    gauge: () => {},
    observe: () => {},
  };
  const started = startAmbientRats({ config, clock: { now: () => now }, telemetry, logger: { log() {} },
    getGovernor: () => ({ admits: () => admits }), getPresence: () => presence,
    getWorld: () => ({ getControllerMemo: () => ({ ok: true,
      controllerFactionId: opts.controller === undefined ? GURISTAS : opts.controller }) }),
    getFactionKind: opts.kindOf || (() => "pirate"), seam, hunt, scene, spawn, ...(opts.deps || {}),
    readStanding: (c) => ({ ok: true, standing: standings.has(c) ? standings.get(c) : 0 }), tables: TABLES,
    rng: () => 0, setTimer: (fn, ms) => {
      const t = { fn, ms, cancelled: false, cancel() { t.cancelled = true; }, hasRef: () => false };
      timers.push(t);
      return t;
    }, nowMs: () => 0 });
  assert.strictEqual(started.ok, true, JSON.stringify(started));
  return { svc: started.ambientRats, calls, live, dormant, players, space, standings, timers, bad, counts, characters,
    aggro, truncated, failPlayers: (v) => { playersFail = v; },
    at: (t) => { now = t; }, setAdmits: (v) => { admits = v; },
    pass: (t) => { now = t; return started.ambientRats.runPass(); } };
}

module.exports = ({ test }) => {
  test("AMS1 spawn: one per spawnIntervalMs up to groupsTarget, global ceiling, options, partial spawn", () => {
    const h = harness({}, { shipsPerSpawn: 2 });
    h.space.set(SYS_A, 1);
    h.players.set(SYS_A, [{ characterId: 7, entityId: 70, position: P(0) }]);
    const interval = BASE.ambientRats.spawnIntervalMs;
    h.pass(T0);
    assert.strictEqual(h.svc.getStatus().groups, 1);
    const first = h.calls.spawn[0];
    assert.deepStrictEqual([first.systemId, first.factionId, first.source, first.minCount, first.maxCount,
      first.distanceFromSurfaceMeters, typeof first.random],
    [SYS_A, GURISTAS, { type: "pirate", factionKey: "guristas" }, undefined, BASE.ambientRats.maxShipsPerGroup,
      BASE.ambientRats.distanceFromSurfaceMeters, "function"]);
    assert.strictEqual(h.svc.getStatus().shipsLive, 2);
    h.pass(T0 + 5000);
    assert.strictEqual(h.calls.spawn.length, 1, "interval");
    h.pass(T0 + interval);
    assert.strictEqual(h.calls.spawn.length, 2);
    assert.notStrictEqual(h.calls.spawn[0].anchorId, h.calls.spawn[1].anchorId, "one group per anchor");
    h.pass(T0 + 2 * interval);
    assert.strictEqual(h.calls.spawn.length, 2, "groupsTarget 2 reached");
    assert.ok(h.counts.get("deferred.SPAWN_INTERVAL") >= 1 && h.counts.get("deferred.SYSTEM_FULL") >= 1);

    const g = harness({ maxGroupsGlobal: 1 });
    for (const sys of [SYS_A, SYS_B]) {
      g.space.set(sys, 1);
      g.players.set(sys, [{ characterId: sys, entityId: 71, position: P(0) }]);
    }
    g.pass(T0);
    g.pass(T0 + interval);
    g.pass(T0 + 2 * interval);
    assert.strictEqual(g.calls.spawn.length, 1, "maxGroupsGlobal");
    assert.ok(g.counts.get("deferred.GLOBAL_FULL") >= 1);
    assert.deepStrictEqual([...h.bad, ...g.bad], []);
  });

  test("AMS2 aggression: hostile ordered, friendly not; colour via setRelation", () => {
    const h = harness();
    h.space.set(SYS_A, 1);
    h.players.set(SYS_A, [{ characterId: 7, entityId: 70, position: P(0) }]);
    h.pass(T0);
    const anchor = h.calls.spawn[0].anchorId;
    const near = P(FAR * (anchor - 40000000) + 1000);
    h.standings.set(7, 10);
    h.players.set(SYS_A, [{ characterId: 7, entityId: 70, position: near }]);
    h.pass(T0 + 1000);
    assert.strictEqual(h.calls.orders.length, 0, "friendly: no order");
    assert.strictEqual(h.calls.paint.at(-1).relation, "friendly");
    h.standings.set(8, -10);
    h.players.set(SYS_A, [{ characterId: 8, entityId: 80, position: near }]);
    h.pass(T0 + 2000);
    assert.strictEqual(h.calls.orders.length, 1);
    assert.ok(h.calls.orders[0].orders.length === 3 && h.calls.orders[0].orders.every((o) => o.targetId === 80));
    assert.strictEqual(h.calls.paint.at(-1).relation, "hostile");
    assert.strictEqual(h.counts.get("orders"), 3);
    assert.deepStrictEqual(h.bad, []);
  });

  test("AMS3 exit grace -> despawn and empty registry; WIPED -> cooldown blocks the spawn", () => {
    const S = BASE.ambientRats;
    const h = harness();
    h.space.set(SYS_A, 1);
    h.players.set(SYS_A, [{ characterId: 7, entityId: 70, position: P(0) }]);
    h.pass(T0);
    h.space.set(SYS_A, 0);
    h.players.set(SYS_A, []);
    h.pass(T0 + 1000);
    assert.strictEqual(h.svc.getStatus().groups, 1, "inside the grace");
    h.pass(T0 + 1000 + S.exitGraceMs);
    assert.strictEqual(h.svc.getStatus().groups, 0);
    assert.strictEqual(h.live.size, 0);
    assert.strictEqual(h.counts.get("left"), 1);

    let t = T0 + 1000 + S.exitGraceMs + S.spawnIntervalMs;
    h.space.set(SYS_A, 1);
    h.players.set(SYS_A, [{ characterId: 7, entityId: 70, position: P(0) }]);
    h.pass(t);
    assert.strictEqual(h.calls.spawn.length, 2);
    h.live.clear();
    t += 1000;
    h.pass(t);
    assert.strictEqual(h.counts.get("wiped"), 1);
    h.pass(t + S.spawnIntervalMs);
    assert.strictEqual(h.calls.spawn.length, 2, "cooldown");
    assert.ok(h.counts.get("deferred.COOLDOWN") >= 1);
    h.pass(t + S.respawnCooldownMs);
    assert.strictEqual(h.calls.spawn.length, 3, "after the cooldown");
    assert.deepStrictEqual(h.bad, []);
  });

  test("AMS4 governor refuses -> no spawn, aggression runs; stop() despawns everything", () => {
    const idle = harness();
    assert.strictEqual(idle.timers.length, 0, "no group, nobody observed: no timer");
    const h = harness({}, { observe: [SYS_A] });
    h.players.set(SYS_A, [{ characterId: 8, entityId: 80, position: P(0) }]);
    assert.strictEqual(h.timers.length, 1, "armed: presence observes a system");
    assert.strictEqual(h.timers[0].ms, BASE.ambientRats.pollMs);
    h.pass(T0);
    const anchor = h.calls.spawn[0].anchorId;
    h.setAdmits(false);
    h.standings.set(8, -10);
    h.players.set(SYS_A, [{ characterId: 8, entityId: 80, position: P(FAR * (anchor - 40000000) + 500) }]);
    h.pass(T0 + BASE.ambientRats.spawnIntervalMs);
    assert.strictEqual(h.calls.spawn.length, 1, "governor");
    assert.ok(h.counts.get("deferred.GOVERNOR") >= 1);
    assert.strictEqual(h.calls.orders.length, 1, "aggression still runs");
    h.svc.stop("test");
    assert.strictEqual(h.live.size, 0);
    assert.strictEqual(h.calls.despawn.length, 1);
    assert.strictEqual(h.timers[0].cancelled, true);
    assert.deepStrictEqual([h.svc.getStatus().state, h.svc.getStatus().groups], ["stopped", 0]);
    assert.deepStrictEqual(h.svc.runPass(), { ok: false, reason: "STOPPED" });
    assert.deepStrictEqual(h.bad, []);
  });

  test("AR-I setAggro before orderGroup: a docked friend disarms, enemies only arm; counters armed / disarmed", () => {
    const S = BASE.ambientRats;
    const h = harness();
    h.space.set(SYS_A, 1);
    h.players.set(SYS_A, [{ characterId: 8, entityId: 80, position: P(0) }]);
    h.pass(T0);
    const anchor = h.calls.spawn[0].anchorId;
    const near = P(FAR * (anchor - 40000000) + 1000);
    h.standings.set(8, -10);
    h.standings.set(9, 10);
    h.players.set(SYS_A, [{ characterId: 8, entityId: 80, position: near }]);
    h.characters.set(SYS_A, [{ characterId: 9, state: "docked" }, { characterId: 8, state: "space" }]);
    h.pass(T0 + 1000);
    assert.deepStrictEqual(h.calls.aggro.map((c) => [c.systemId, c.armed, c.ids.length]), [[SYS_A, false, 3]]);
    assert.deepStrictEqual(h.calls.seq, ["aggro", "order"], "disarm before the orders");
    assert.ok(h.calls.orders[0].orders.every((o) => o.targetId === 80), "the enemy still ordered");
    h.characters.set(SYS_A, [{ characterId: 8, state: "space" }]);
    h.pass(T0 + 2000);
    assert.deepStrictEqual([h.calls.aggro[1].armed, h.calls.aggro[1].range], [true, S.aggroRangeMeters]);
    assert.strictEqual(h.counts.get("armed"), 3);
    h.characters.set(SYS_A, [{ characterId: 9, state: "transit" }, { characterId: 8, state: "space" }]);
    h.pass(T0 + 3000);
    assert.deepStrictEqual([h.calls.aggro[2].armed, h.counts.get("disarmed")], [false, 3]);
    assert.deepStrictEqual(h.bad, []);
  });

  test("AR-N1 fail-safe: failed read / truncated presence disarm; armed group outside the rotation disarms", () => {
    const S = BASE.ambientRats;
    const allArmed = (h) => [...h.live.keys()].every((id) => h.aggro.get(id) === true);
    const noneArmed = (h) => [...h.live.keys()].every((id) => h.aggro.get(id) === false);
    const h = harness();
    h.space.set(SYS_A, 1);
    h.standings.set(8, -10);
    h.players.set(SYS_A, [{ characterId: 8, entityId: 80, position: P(0) }]);
    h.characters.set(SYS_A, [{ characterId: 8, state: "space" }]);
    h.pass(T0);
    h.pass(T0 + 1000);
    assert.ok(allArmed(h), "armed against the enemy");
    h.failPlayers(true);
    h.pass(T0 + 2000);
    assert.ok(noneArmed(h), "readPlayerShips failed -> disarm");
    assert.strictEqual(h.calls.aggro.at(-1).armed, false);
    h.failPlayers(false);
    h.pass(T0 + 3000);
    assert.ok(allArmed(h), "re-armed after the read recovers");
    h.truncated.add(SYS_A);
    h.pass(T0 + 4000);
    assert.ok(noneArmed(h), "truncated presence -> armed:false");

    const r = harness({ maxGroupsPerPass: 1 });
    r.space.set(SYS_A, 1);
    r.standings.set(8, -10);
    r.standings.set(9, 10);
    r.players.set(SYS_A, [{ characterId: 8, entityId: 80, position: P(0) }]);
    r.characters.set(SYS_A, [{ characterId: 8, state: "space" }]);
    let t = T0;
    for (let i = 0; i < 4; i += 1, t += S.spawnIntervalMs) r.pass(t);
    assert.strictEqual(r.svc.getStatus().groups, 2);
    assert.ok(allArmed(r), "both armed, the sweep keeps a group with no new pilot");
    r.characters.set(SYS_A, [{ characterId: 9, state: "docked" }, { characterId: 8, state: "space" }]);
    r.pass(t);
    assert.ok(noneArmed(r), "the unvisited group disarmed in the same pass");
    assert.deepStrictEqual([...h.bad, ...r.bad], []);
  });

  test("AMS-HS highsec navy: SDE controller 500001 for a CONCORD system, passive (never armed, no order on a hostile "
    + "standing); CONCORD flag true -> refused; pirate world controller -> HIGHSEC_PIRATE; flag off -> BAND_OFF and "
    + "zero graph / vendor config reads", () => {
    const JITA = 30000142;
    const rows = new Map([[JITA, 500006], [30000143, 500001], [30000144, 500001], [30000145, 500006]]);
    const graph = { getSystem: (id) => (rows.has(id) ? { factionId: rows.get(id), constellationId: 20000020,
      regionId: 10000002 } : null), getSystemsInConstellation: () => [...rows.keys()], getSystemsInRegion: () => [] };
    const reads = { graph: 0, concord: 0 };
    const hs = (concord, opts = {}, overrides = { highsecNavy: true }) => harness(overrides, { band: "highsec",
      controller: null, kindOf: (f) => (f === 500010 ? "pirate" : "empire"), ...opts,
      deps: { getGraph: () => { reads.graph += 1; return { getGraph: () => ({ ok: true, graph }) }; },
        readConcordGateAggro: () => { reads.concord += 1; return { ok: true, enabled: concord }; } } });
    const enemyNear = (h) => {
      const near = P(FAR * (h.calls.spawn[0].anchorId - 40000000) + 1000);
      h.standings.set(8, -10);
      h.players.set(JITA, [{ characterId: 8, entityId: 80, position: near }]);
      h.characters.set(JITA, [{ characterId: 8, state: "space" }]);
    };

    const a = hs(false);
    a.space.set(JITA, 1);
    a.players.set(JITA, [{ characterId: 8, entityId: 80, position: P(0) }]);
    a.pass(T0);
    assert.strictEqual(a.calls.spawn.length, 1, JSON.stringify([...a.counts]));
    assert.deepStrictEqual([a.calls.spawn[0].factionId, a.calls.spawn[0].source], [500001, { type: "navy" }]);
    enemyNear(a);
    for (let i = 1; i <= 3; i += 1) a.pass(T0 + i * 1000);
    assert.deepStrictEqual(a.calls.aggro, [], "setAggro never called (armed null)");
    assert.deepStrictEqual(a.calls.orders, [], "no order on a hostile standing");
    assert.ok(a.calls.paint.length > 0 && a.calls.paint.every((p) => p.relation !== "hostile"), "never red");
    assert.deepStrictEqual(a.svc.getStatus().highsec, { navy: true, concordGateAggro: false, factionsMemo: 1 });
    assert.strictEqual(reads.concord, 1, "read once at the start");
    const low = harness({}, { band: "lowsec", controller: 500001, kindOf: () => "empire" });
    low.space.set(JITA, 1);
    low.players.set(JITA, [{ characterId: 8, entityId: 80, position: P(0) }]);
    low.pass(T0);
    enemyNear(low);
    low.pass(T0 + 1000);
    low.pass(T0 + 2000);
    assert.ok(low.calls.orders.length > 0 && low.calls.aggro.some((c) => c.armed === true), "lowsec not passive");

    const b = hs(true);
    b.space.set(JITA, 1);
    b.players.set(JITA, [{ characterId: 8, entityId: 80, position: P(0) }]);
    b.pass(T0);
    assert.ok(b.counts.get("refused.CONCORD_AGGRO_NPC") > 0);
    assert.strictEqual(b.calls.spawn.length, 0);

    const c = hs(false, { controller: 500010 });
    c.space.set(JITA, 1);
    c.players.set(JITA, [{ characterId: 8, entityId: 80, position: P(0) }]);
    c.pass(T0);
    assert.ok(c.counts.get("refused.HIGHSEC_PIRATE") > 0);
    assert.strictEqual(c.calls.spawn.length, 0);

    reads.graph = 0;
    reads.concord = 0;
    const d = hs(false, {}, {});
    d.space.set(JITA, 1);
    d.players.set(JITA, [{ characterId: 8, entityId: 80, position: P(0) }]);
    d.pass(T0);
    assert.ok(d.counts.get("refused.BAND_OFF") > 0);
    assert.deepStrictEqual([reads.graph, reads.concord, d.calls.spawn.length], [0, 0, 0]);
    assert.deepStrictEqual(d.svc.getStatus().highsec, { navy: false, concordGateAggro: null, factionsMemo: 0 });

    const e = hs(false, { controller: 500001 }, { bands: "lowsec,nullsec,highsec" });
    e.space.set(JITA, 1);
    e.players.set(JITA, [{ characterId: 8, entityId: 80, position: P(0) }]);
    e.pass(T0);
    assert.strictEqual(e.calls.spawn.length, 1, JSON.stringify([...e.counts]));
    enemyNear(e);
    e.pass(T0 + 1000);
    e.pass(T0 + 2000);
    assert.ok(e.calls.orders.length > 0 && e.calls.aggro.some((x) => x.armed === true), "flag off: highsec not passive");
    assert.strictEqual(e.calls.paint.at(-1).relation, "hostile");
    assert.deepStrictEqual([...a.bad, ...low.bad, ...b.bad, ...c.bad, ...d.bad, ...e.bad], []);
  });

  test("AMS5 services.js entry, flag off = zero seam calls, facades of the real adapter", () => {
    const seen = [];
    const defs = buildDefaultServiceDefs({ startAmbientRats: (deps) => {
      seen.push(deps);
      return { ok: true, ambientRats: createUnavailableAmbientRats("x") };
    } });
    const names = defs.map((d) => d.name);
    const def = defs.find((d) => d.name === "ambientRats");
    assert.deepStrictEqual([def.module, def.requires], ["world", ["world"]]);
    assert.strictEqual(names.indexOf("ambientRats"), names.indexOf("miningEncounters") + 1);
    const ctx = { config: BASE, clock: { now: () => T0 }, adapter: { marker: 1 } };
    assert.deepStrictEqual(def.start(ctx, { logger: { log() {} } }), { ok: true });
    const d = seen[0];
    assert.strictEqual(d.adapter, ctx.adapter);
    assert.strictEqual(d.tables.pirateKeyByFactionId, PIRATE_KEY_BY_FACTION_ID);
    assert.deepStrictEqual([...d.tables.navyFactionIds].sort(), [...EMPIRE_FACTION_IDS].sort());
    for (const fn of ["getGovernor", "getPresence", "getWorld", "getFactionKind", "getGraph"]) {
      assert.strictEqual(typeof d[fn], "function", fn);
    }
    def.onUnavailable(ctx, "disabled_by_config");
    assert.strictEqual(ctx.ambientRats.getStatus().state, "unavailable");

    let touched = 0;
    const spy = new Proxy({}, { get: () => { touched += 1; return () => ({ ok: true }); } });
    assert.deepStrictEqual(startAmbientRats({ config: BASE, adapter: spy }),
      { ok: false, reason: "disabled_by_config" });
    assert.strictEqual(touched, 0);

    const { createAdapter } = require("../../lib/adapter");
    const adapter = createAdapter({ moduleApi: { _cache: {} } });
    assert.deepStrictEqual(ADAPTER_METHODS.filter((m) => typeof adapter[m] !== "function"), []);
    const facades = { hunt: adapter.getHuntScene(), scene: adapter.getBeltNavyScene(), spawn: adapter.getNpcSpawn() };
    for (const [key, methods] of Object.entries(FACADE_METHODS)) {
      assert.deepStrictEqual(methods.filter((m) => typeof facades[key][m] !== "function"), [], key);
    }
    assert.deepStrictEqual([...SEAM_METHODS].sort(), ["bandOf", "classifyIds", "setAggro", "snapshot", "spawnGroup"]);
    const refused = ambientRatDepsFromAdapter(adapter);
    assert.deepStrictEqual([refused.ok, refused.reason], [false, "SEAM_UNAVAILABLE"], "server src unknown");
    const on = { ...BASE, ambientRats: { ...BASE.ambientRats, enabled: true } };
    assert.strictEqual(startAmbientRats({ config: on, adapter }).reason, "SEAM_UNAVAILABLE");
  });
};

module.exports.harness = { harness, SYS_A, T0, P, BASE };
