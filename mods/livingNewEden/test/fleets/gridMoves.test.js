"use strict";

const assert = require("node:assert");

const { harness: H } = require("../battle/settlement.test");
const { createJournal } = require("../../lib/persistence/journal");
const { startScheduler } = require("../../lib/scheduler");
const { getEventType } = require("../../lib/scheduler/eventTypes");
const { startFleets, createUnavailableFleets } = require("../../lib/fleets");
const { createViewRegistry } = require("../../lib/observer/views");
const { createGrid } = require("../../lib/fleets/grid");
const { OPERATION_TYPES } = require("../../lib/fleets/schema");
const { WORK_TARGETS, workTargetOf, pickBelt } = require("../../lib/fleets/grid/work");
const { inSystemMoveMs } = require("../../lib/fleets/grid/moveTime");
const { gridArrivalKey } = require("../../lib/fleets/grid/moves");
const { controlPointOf } = require("../../lib/fleets/grid/anchors");
const { pickMinerAnchor } = require("../../lib/fleetExposure/rules");
const { CLASSES } = require("../../lib/retention/classes");

const { S, FACTION_A, FACTION_B } = H;
const AU = 149597870700;
const COMP = Object.freeze([{ hullGroup: "cruiser", count: 2 }]);
const GATE_TO_L1 = 50001001;
const GATE_TO_N5 = 50001002;
const STATION = 60001001;
const BELTS = Object.freeze([40001003, 40001001, 40001002]);
const GRID_ON = Object.freeze({ enabled: true, contactRangeM: 250000, maxAnchorsPerSystem: 64, anchorCacheSystems: 16,
  dynamicAnchorTtlMs: 300000, visitPurgePerWrite: 4, maxPositionsPerCall: 256, movesEnabled: true,
  maxMovesPerVisit: 4, workTargetScanFleets: 8, moveArrivalMaxPerPass: 64 });
const GRID_METHODS = ["addGridArrivalListener", "addWorkTargetOverride", "getStatus", "isEnabled", "moveGroupInTx",
  "moveInTx", "movesEnabled", "placeInTx", "positionsOf", "readSystemGrid"];

const anchor = (kind, id, position, extra = {}) => ({ kind, id, position, toSystemId: null, lneStationId: null,
  lneSovStructureId: null, ownerCorpId: null, ...extra });
const at = (x) => ({ x, y: 0, z: 0 });

function fakeAdapter() {
  return { readGridAnchors(systemId) {
    if (systemId === S.L2) {
      return { ok: true, truncated: false, anchors: [anchor("gate", GATE_TO_L1, at(0), { toSystemId: S.L1 }),
        anchor("gate", GATE_TO_N5, at(AU), { toSystemId: S.N5 }), anchor("station", STATION, at(5 * AU)),
        ...BELTS.map((id, i) => anchor("belt", id, at((7 + i) * AU)))] };
    }
    if (systemId === S.N0) {
      return { ok: true, truncated: false, anchors: [anchor("station", STATION + 1, at(0)),
        anchor("gate", GATE_TO_L1 + 10, at(2 * AU), { toSystemId: S.L1 })] };
    }
    return { ok: true, truncated: false, anchors: [] };
  } };
}

function fakeTelemetry() {
  const counts = new Map();
  return { counts, count(name, n) { counts.set(name, (counts.get(name) || 0) + n); }, observe() {}, gauge() {} };
}

function bootGrid(opened, shared, grid, telemetry) {
  const journal = createJournal({ clock: shared.clock, maxPayloadBytes: 16384, maxRows: 500 });
  const rows = { max: 0 };
  const store = { ...opened.store, transaction(name, fn) {
    const r = opened.store.transaction(name, fn);
    if (r && Number.isSafeInteger(r.rows)) rows.max = Math.max(rows.max, r.rows);
    return r;
  } };
  const config = { ...H.CONFIG, grid };
  const sr = startScheduler({ config, persistence: { ok: true, store }, clock: shared.clock, ids: shared.ids,
    nowMs: () => 0 });
  assert.ok(sr.ok, JSON.stringify(sr));
  const adapter = fakeAdapter();
  const fr = startFleets({ config, persistence: { ok: true, store, journal, worldSeed: opened.worldSeed },
    clock: shared.clock, ids: shared.ids, scheduler: sr.scheduler, telemetry,
    graph: { getGraph: () => ({ ok: true, graph: shared.graph }) }, presence: null, views: createViewRegistry(),
    adapter });
  assert.ok(fr.ok, JSON.stringify(fr));
  const tx = (fn) => {
    const r = opened.store.transaction("test", fn);
    assert.ok(r.ok, JSON.stringify(r));
    return r.value;
  };
  const gridOf = (over = {}) => createGrid({ config: { ...config, grid: { ...grid, ...(over.grid || {}) } }, adapter,
    clock: shared.clock, telemetry, store: opened.store, repository: fr.fleets.repository,
    scheduler: over.scheduler || sr.scheduler, worldSeed: opened.worldSeed });
  return { store: opened.store, scheduler: sr.scheduler, fleets: fr.fleets, tx, rows, config, gridOf,
    worldSeed: opened.worldSeed };
}

function planToL2(env, tag, opType = "invasion", objective = "capture") {
  const fleetId = H.newFleet(env, tag, FACTION_A, COMP, S.N5);
  const op = env.fleets.createOperation({ operationType: opType, factionId: FACTION_A, originSystemId: S.N0,
    targetSystemId: S.L2, objective, dueAt: null, fleets: [{ fleetId, expectedVersion: 1 }] }, `${tag}:op`);
  assert.ok(op.ok, JSON.stringify(op));
  const p = env.fleets.planTravel({ fleetId, targetSystemId: S.L2 }, `${tag}:plan`);
  assert.ok(p.ok, JSON.stringify(p));
  const f = env.tx((db) => env.fleets.repository.getFleet(db, fleetId)).fleet;
  assert.deepStrictEqual(f.route.systems, [S.N0, S.L1, S.L2]);
  return f;
}

async function drain(env) {
  for (let i = 0; i < 8; i += 1) {
    const r = await env.scheduler.runPass();
    assert.ok(r.ok, JSON.stringify(r));
    if (r.jobs === 0) break;
  }
}

async function flyToL2(env, shared, tag) {
  const f0 = planToL2(env, tag);
  shared.clock.set(f0.route.arriveAt + 1);
  await drain(env);
  const f = env.tx((db) => env.fleets.repository.getFleet(db, f0.fleetId)).fleet;
  assert.deepStrictEqual([f.state, f.currentSystemId], ["STAGED", S.L2]);
  return f;
}

const num = (v) => (v === null ? null : Number(v));
const visitOf = (env, fleetId) => {
  const r = env.tx((db) => db.prepare("SELECT system_id, leg_seq, arrived_at, entered_via, move_seq, at_kind, at_id, "
    + "to_kind, to_id, depart_at, arrive_at, purpose, version FROM world_fleet_grid_visits WHERE fleet_id = ?")
    .get(fleetId));
  if (!r) return null;
  return { ...r, system_id: num(r.system_id), leg_seq: num(r.leg_seq), arrived_at: num(r.arrived_at),
    move_seq: num(r.move_seq), at_id: num(r.at_id), to_id: num(r.to_id), depart_at: num(r.depart_at),
    arrive_at: num(r.arrive_at), version: num(r.version) };
};
const gridEvents = (env) => env.tx((db) => db.prepare("SELECT idempotency_key, due_at, state FROM "
  + "world_scheduled_events WHERE event_type = 'FLEET_GRID_ARRIVAL' ORDER BY idempotency_key").all())
  .map((r) => ({ key: r.idempotency_key, dueAt: Number(r.due_at), state: r.state }));

const moveMsOf = (shared, from, to) => {
  const t = inSystemMoveMs(COMP, { position: from }, { position: to }, { timeFactor: 1 });
  assert.ok(t.ok, JSON.stringify(t));
  return Math.max(1, shared.clock.travelDurationMs(t.baseMs, { observed: false }));
};

const sysOf = (anchors, systemId) => ({ systemId, anchors, cp: controlPointOf(anchors, systemId) });

module.exports = ({ test, skip }) => {
  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  test("GM1 grid pure: WORK_TARGETS coverage, CP / belt / miner / STAY targets, inSystemMoveMs", () => {
    const tail = WORK_TARGETS.slice(-2);
    for (const type of OPERATION_TYPES) {
      assert.ok(WORK_TARGETS.some((r) => r.operationType === type && !tail.includes(r)), `rule for ${type}`);
    }
    const belts = BELTS.map((id, i) => anchor("belt", id, at(i)));
    const station = anchor("station", STATION, at(5 * AU));
    const sys = sysOf([anchor("gate", GATE_TO_L1, at(0)), station, ...belts], S.L2);
    const fleet = (fleetId, fleetRole = "invasion", factionId = FACTION_A) => ({ fleetId, factionId, fleetRole });
    const of = (f, operation, miners = []) => workTargetOf({ fleet: f, operation, sys, worldSeed: 12345, miners });

    const inv = of(fleet("f-inv"), { operationType: "invasion", objective: "capture" });
    assert.deepStrictEqual([inv.kind, inv.anchor, inv.missing], ["ANCHOR", { kind: "station", id: STATION }, false]);
    for (const id of ["f-m1", "f-m2", "f-m3", "f-m4"]) {
      const m = of(fleet(id, "mining"), { operationType: "mining", objective: "mine" });
      const live = pickMinerAnchor(BELTS.map((itemId) => ({ itemId })), 12345, id);
      assert.deepStrictEqual(m.anchor, { kind: "belt", id: live.itemId }, `belt of ${id} = LIVE belt`);
      assert.strictEqual(pickBelt(belts, 12345, id).id, live.itemId);
    }
    const hostile = { fleetId: "f-miner-b", factionId: FACTION_B };
    const own = { fleetId: "f-miner-a", factionId: FACTION_A };
    const gank = of(fleet("f-gank"), { operationType: "gank", objective: "raid" }, [own, hostile]);
    assert.deepStrictEqual(gank.anchor, { kind: "belt", id: pickBelt(belts, 12345, hostile.fleetId).id });
    const noMiner = of(fleet("f-gank"), { operationType: "gank", objective: "raid" }, [own]);
    assert.deepStrictEqual([noMiner.kind, noMiner.missing], ["STAY", true]);
    const escort = of(fleet("f-esc"), { operationType: "escort", objective: "hold" }, [hostile, own]);
    assert.deepStrictEqual(escort.anchor, { kind: "belt", id: pickBelt(belts, 12345, own.fleetId).id });
    assert.strictEqual(of(fleet("f-sc", "scout"), { operationType: "invasion", objective: "capture" }).kind, "STAY");
    const empty = workTargetOf({ fleet: fleet("f-x"), operation: null, sys: sysOf([], S.L2), worldSeed: 1,
      miners: [] });
    assert.deepStrictEqual([empty.kind, empty.rule], ["STAY", "NO_ANCHORS"]);

    const bs = inSystemMoveMs([{ hullGroup: "battleship" }], { position: at(0) }, { position: at(5 * AU) },
      { timeFactor: 1 });
    const fr = inSystemMoveMs([{ hullGroup: "frigate" }], { position: at(0) }, { position: at(5 * AU) },
      { timeFactor: 1 });
    assert.ok(bs.ok && fr.ok && bs.baseMs > fr.baseMs, `${bs.baseMs} > ${fr.baseMs}`);
    const fb = inSystemMoveMs(COMP, { position: null }, { position: at(0) }, { timeFactor: 1 });
    assert.deepStrictEqual([fb.fallbackDistance, fb.distanceM], [true, 15 * AU]);
    const x2 = inSystemMoveMs(COMP, { position: null }, { position: at(0) }, { timeFactor: 2 });
    assert.ok(Math.abs(x2.baseMs - 2 * fb.baseMs) <= 1, `${x2.baseMs} vs 2 x ${fb.baseMs}`);
    assert.strictEqual(inSystemMoveMs([{ hullGroup: "zeppelin" }], {}, {}, { timeFactor: 1 }).reason,
      "UNKNOWN_HULL_GROUP");
  });

  needsDriver("GM2 grid arrival: work move gate -> CP, one FLEET_GRID_ARRIVAL, warp / MOVE, the replay keeps the "
    + "row, movesEnabled off = move_seq 0, intercept plans no move", () =>
    H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const env = bootGrid(reopen(), shared, GRID_ON, fakeTelemetry());
      const heard = [];
      env.fleets.travel.addArrivalListener((tx, a) => heard.push(a));
      const f = await flyToL2(env, shared, "gm2a");
      const v = visitOf(env, f.fleetId);
      const moveMs = moveMsOf(shared, at(0), at(5 * AU));
      assert.deepStrictEqual(v, { system_id: S.L2, leg_seq: f.legSeq, arrived_at: v.arrived_at, entered_via: "GATE",
        move_seq: 1, at_kind: "gate", at_id: GATE_TO_L1, to_kind: "station", to_id: STATION,
        depart_at: v.arrived_at, arrive_at: v.arrived_at + moveMs, purpose: "WORK", version: 2 });
      const key = gridArrivalKey(f.fleetId, f.legSeq, 1);
      assert.deepStrictEqual(gridEvents(env), [{ key, dueAt: v.arrive_at, state: "QUEUED" }]);
      assert.ok(env.rows.max <= env.store.limits.maxRowsPerTransaction, `rows ${env.rows.max}`);

      const posAt = (t) => env.tx((db) => env.fleets.grid.positionsOf(db, S.L2, [f], t)).positions.get(f.fleetId);
      assert.strictEqual(posAt(v.depart_at + Math.floor(moveMs / 2)).kind, "warp");
      const there = posAt(v.arrive_at);
      assert.deepStrictEqual([there.kind, there.anchorKind, there.anchorId, there.source],
        ["anchor", "station", STATION, "MOVE"]);

      const again = env.gridOf();
      const ctx = { fleet: { fleetId: f.fleetId, factionId: f.factionId, fleetRole: f.fleetRole,
        composition: f.composition }, operation: { operationType: "invasion", objective: "capture" }, chained: false };
      assert.deepStrictEqual(env.tx((db) => again.recorder.recordArrivalInTx(db, heard[0], ctx)),
        { ok: true, written: false });
      assert.strictEqual(visitOf(env, f.fleetId).version, 2);
      assert.strictEqual(gridEvents(env).length, 1);

      const g = planToL2(env, "gm2i");
      const t1 = g.route.departAt + g.route.jumpMs;
      const r = env.tx((db) => env.fleets.travel.interceptInTx(db, { fleetId: g.fleetId, expectedVersion: g.version,
        legSeq: g.legSeq, systemIndex: 1, at: t1 }, "gm2i:halt"));
      assert.ok(r.ok, JSON.stringify(r));
      assert.deepStrictEqual([visitOf(env, g.fleetId).system_id, visitOf(env, g.fleetId).move_seq], [S.L1, 0]);
      assert.strictEqual(gridEvents(env).length, 1);
    }).then(() => H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const env = bootGrid(reopen(), shared, { ...GRID_ON, movesEnabled: false }, fakeTelemetry());
      const f = await flyToL2(env, shared, "gm2off");
      const v = visitOf(env, f.fleetId);
      assert.deepStrictEqual([v.move_seq, v.to_kind, v.depart_at, v.purpose, v.version], [0, null, null, null, 1]);
      assert.deepStrictEqual(gridEvents(env), []);
    })));

  needsDriver("GM3 grid FLEET_GRID_ARRIVAL: listener once in tx at arrive_at (also late), STALE moveSeq / new "
    + "plan, throwing listener counted, movesEnabled off STALE MOVES_OFF", () =>
    H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const env = bootGrid(reopen(), shared, GRID_ON, fakeTelemetry());
      const calls = [];
      assert.ok(env.fleets.grid.addGridArrivalListener((tx, a) => calls.push({ inTx: tx.inTransaction, ...a })).ok);
      const f = await flyToL2(env, shared, "gm3a");
      const v = visitOf(env, f.fleetId);
      assert.deepStrictEqual(calls, [], "not yet due");
      shared.clock.set(v.arrive_at + 3600000);
      await drain(env);
      assert.strictEqual(calls.length, 1, JSON.stringify(calls));
      assert.deepStrictEqual([calls[0].inTx, calls[0].at, calls[0].gridKey, calls[0].purpose, calls[0].moveSeq,
        calls[0].source], [true, v.arrive_at, `station:${STATION}`, "WORK", 1, "MOVE"]);
      assert.deepStrictEqual(gridEvents(env).map((e) => e.state), ["DONE"]);

      const ev = (moveSeq) => ({ eventId: "x", dueAt: v.arrive_at, payload: { fleetId: f.fleetId, systemId: S.L2,
        legSeq: f.legSeq, moveSeq } });
      const g = env.gridOf();
      let heard = 0;
      g.facade.addGridArrivalListener(() => {
        heard += 1;
        throw new Error("boom");
      });
      const h = g.handlers.FLEET_GRID_ARRIVAL;
      assert.strictEqual(h(ev(2)).outcome, "STALE", "another moveSeq");
      const ok = h(ev(1));
      assert.strictEqual(ok.outcome, "ARRIVED");
      assert.deepStrictEqual(env.tx((db) => ok.effect(db, ev(1))), { ok: true });
      assert.deepStrictEqual([heard, g.facade.getStatus().counters.gridListenerErrors], [1, 1]);

      const off = env.gridOf({ grid: { movesEnabled: false } });
      const offArrival = off.handlers.FLEET_GRID_ARRIVAL;
      assert.deepStrictEqual(offArrival(ev(1)), { ok: true, outcome: "STALE", detail: "MOVES_OFF" });

      const p = env.fleets.retreat({ fleetId: f.fleetId }, "gm3a:retreat");
      assert.ok(p.ok, JSON.stringify(p));
      assert.strictEqual(h(ev(1)).outcome, "STALE");
      assert.strictEqual(heard, 1);
    }));

  needsDriver("GM4 grid moveInTx: fresh NONE visit from CP, IN_WARP, next move, MOVE_LIMIT / POST, SAME_GRID "
    + "TARGET_UNKNOWN, STALE_VISIT, ENQUEUE_FAILED rolls back", () =>
    H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const env = bootGrid(reopen(), shared, { ...GRID_ON, maxMovesPerVisit: 2 }, fakeTelemetry());
      const fleetId = H.newFleet(env, "gm4", FACTION_A, COMP);
      const f = env.tx((db) => env.fleets.repository.getFleet(db, fleetId)).fleet;
      assert.deepStrictEqual([f.state, f.currentSystemId], ["IDLE", S.N0]);
      const gate = { kind: "gate", id: GATE_TO_L1 + 10 };
      const station = { kind: "station", id: STATION + 1 };
      const move = (t, to, purpose = "WORK", extra = {}, grid = env.fleets.grid) => env.tx((db) => grid.moveInTx(db,
        { fleetId, systemId: S.N0, legSeq: f.legSeq, at: t, to, purpose, ...extra }));
      const t0 = shared.clock.now();

      const m1 = move(t0, gate);
      assert.strictEqual(m1.ok, true, JSON.stringify(m1));
      const v1 = visitOf(env, fleetId);
      assert.deepStrictEqual([v1.entered_via, v1.move_seq, v1.at_kind, v1.at_id, v1.to_kind, v1.to_id, v1.depart_at,
        v1.arrived_at], ["NONE", 1, "station", STATION + 1, "gate", gate.id, t0, t0]);
      assert.strictEqual(move(t0 + 1, station).reason, "IN_WARP");
      assert.deepStrictEqual(visitOf(env, fleetId), v1, "a refusal writes nothing");

      const m2 = move(m1.arriveAt, station, "WORK", { expectedMoveSeq: 1 });
      assert.deepStrictEqual([m2.ok, m2.moveSeq, m2.from], [true, 2, gate]);
      assert.strictEqual(move(m2.arriveAt, gate).reason, "MOVE_LIMIT");
      const m3 = move(m2.arriveAt, gate, "POST");
      assert.deepStrictEqual([m3.ok, m3.moveSeq], [true, 3]);
      assert.deepStrictEqual(move(m3.arriveAt, gate, "POST"), { ok: true, moved: false, reason: "SAME_GRID",
        gridKey: `gate:${gate.id}` });
      assert.strictEqual(move(m3.arriveAt, { kind: "gate", id: 999 }, "POST").reason, "TARGET_UNKNOWN");
      assert.strictEqual(move(m3.arriveAt, station, "POST", { expectedMoveSeq: 2 }).reason, "STALE_VISIT");

      const before = visitOf(env, fleetId);
      const events = gridEvents(env).length;
      const refusing = env.gridOf({ scheduler: { enqueue: () => ({ ok: false, reason: "SCHEDULER_FULL" }) } });
      const failed = move(m3.arriveAt, station, "POST", {}, refusing.facade);
      assert.deepStrictEqual([failed.ok, failed.reason], [false, "ENQUEUE_FAILED"]);
      assert.deepStrictEqual(visitOf(env, fleetId), before, "the savepoint rolled the visit back");
      assert.deepStrictEqual([events, before.move_seq], [3, 3]);
    }));

  test("GM5 grid facades, event type, handler registry, retention class", () => {
    const methods = (grid) => Object.keys(grid).filter((k) => typeof grid[k] === "function").sort();
    const clock = { now: () => 0, travelDurationMs: (ms) => ms };
    const journal = createJournal({ clock, maxPayloadBytes: 16384, maxRows: 500 });
    const store = { transaction: (_name, fn) => ({ ok: true, value: fn({ inTransaction: true }), rows: 0 }),
      limits: { maxRowsPerTransaction: 500 } };
    const fakeScheduler = () => {
      const byType = new Map();
      return { byType, getStatus: () => ({ state: "ready", handlers: [...byType.keys()].sort() }),
        registerHandler(type, fn, opts) {
          byType.set(type, opts);
          return { ok: true, unregister: () => byType.delete(type) };
        }, enqueue: () => ({ ok: false, reason: "FAKE" }) };
    };
    for (const grid of [GRID_ON, { ...GRID_ON, enabled: false, movesEnabled: false }]) {
      const scheduler = fakeScheduler();
      const fr = startFleets({ config: { ...H.CONFIG, grid }, persistence: { ok: true, store, journal, worldSeed: 1 },
        clock, ids: { next: () => "x" }, scheduler });
      assert.ok(fr.ok, JSON.stringify(fr));
      assert.deepStrictEqual(methods(fr.fleets.grid), GRID_METHODS);
      assert.strictEqual(fr.fleets.grid.movesEnabled(), grid.movesEnabled);
      assert.deepStrictEqual(scheduler.byType.get("FLEET_GRID_ARRIVAL"), { maxPerPass: 64 }, "registered at start");
      fr.fleets.stop("test");
      assert.ok(!scheduler.byType.has("FLEET_GRID_ARRIVAL"), "gone after stop");
    }
    const unavailable = createUnavailableFleets("disabled_by_config");
    assert.deepStrictEqual(methods(unavailable.grid), GRID_METHODS);
    assert.deepStrictEqual(unavailable.grid.moveInTx(), { ok: false, reason: "GRID_OFF" });
    assert.deepStrictEqual(unavailable.grid.addGridArrivalListener(() => {}), { ok: false, reason: "GRID_OFF" });
    assert.strictEqual(unavailable.grid.movesEnabled(), false);

    const t = getEventType("FLEET_GRID_ARRIVAL");
    assert.deepStrictEqual([t.priority, t.aggregateType, t.periodic], [3, "fleet", false]);
    const cls = CLASSES.find((c) => c.id === "fleet-grid-arrival");
    assert.ok(cls, "retention class");
    assert.deepStrictEqual([cls.table, cls.eventType, cls.prefix, cls.family], ["events", "FLEET_GRID_ARRIVAL", "grid:",
      "F"]);
    assert.ok(cls.pattern.test(gridArrivalKey("fl-abc", 3, 1)));
    assert.ok(!cls.pattern.test("grid:fl-abc:3"));
  });
};
