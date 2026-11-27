"use strict";

const assert = require("node:assert");

const T = require("../../lib/fleets/grid/transit");
const { decideIntercept, decidePosition, nextArrivalOf } = require("../../lib/strategy/blockade/rules");
const { decideAmbush, campGateOf } = require("../../lib/strategy/lowsec/campRules");
const { startBlockade } = require("../../lib/strategy/blockade");
const { crossingKey, haltKeyOf, positionKey, INTERCEPT_EVENT, POSITION_EVENT } =
  require("../../lib/strategy/blockade/blockadeService");
const { withDepartureRows, borderPostScanRowsOf, blockadeGateRowsOf } = require("../../lib/strategy/reviewRows");
const { rowBoundsOfConfig } = require("../../lib/strategy/reviewBound");
const LS = require("../../lib/strategy/lowsec/schema");
const { harness: GD } = require("./gridDefense.test");
const { harness: C } = require("../battle/contacts.test");
const { harness: H } = require("../battle/settlement.test");
const { harness: A } = require("./lowsec/ambush.test");

const S = H.S;
const { SANSHA, GURISTAS } = C;
const cruisers = (n) => [{ hullGroup: "cruiser", count: n }];
const HOUR = 3600000;
const ON = Object.freeze({ ...GD.ON, "grid.crossings.blockadeGateEnabled": true, "modules.strategy.enabled": true,
  "strategy.blockadeEnabled": true, "strategy.blockadeInterceptChancePermille": 1000,
  "persistence.maxRowsPerTransaction": 5000 });
const OFF = Object.freeze({ ...ON, "grid.crossings.blockadeGateEnabled": false });
const gate = (id) => ({ kind: "gate", id });

module.exports = ({ test, skip }) => {
  test("GBG1 grid pure: preparedCatchOf, decidePosition, campGateOf, the gate step, budget rows", () => {
    const tl = { from: 1000, inUntil: 1700, outFrom: 2500, until: 3000 };
    const grids = { in: { anchor: gate(1), gridKey: "gate:1" }, out: { anchor: gate(2), gridKey: "gate:2" } };
    const pc = (over) => T.preparedCatchOf({ timeline: tl, grids, at: 1000, inGridKeys: new Set(),
      outGridKeys: new Set(), ...over });
    assert.deepStrictEqual(pc({ inGridKeys: new Set(["gate:1"]) }), { ok: true, gate: "in", catchAt: 1000,
      anchor: gate(1) });
    assert.deepStrictEqual(pc({ outGridKeys: new Set(["gate:2"]) }), { ok: true, gate: "out", catchAt: 2500,
      anchor: gate(2) }, "OUT: catchAt >= outFrom");
    assert.deepStrictEqual(pc({ at: 2600, inGridKeys: new Set(["gate:1"]), outGridKeys: new Set(["gate:2"]),
      onlyOut: true }), { ok: true, gate: "out", catchAt: 2600, anchor: gate(2) }, "onlyOut");
    assert.deepStrictEqual(pc({ at: 1700, inGridKeys: new Set(["gate:1"]) }), { ok: false, reason: "GATE_AWAY" },
      "after the IN phase");
    assert.deepStrictEqual(pc({}), { ok: false, reason: "GATE_AWAY" });
    assert.deepStrictEqual(pc({ grids: { in: null, out: null } }), { ok: false, reason: "NO_GATE" });
    const zero = { ...tl, inUntil: tl.from };
    assert.strictEqual(T.preparedCatchOf({ timeline: zero, grids, at: 1000, inGridKeys: new Set(["gate:1"]),
      outGridKeys: new Set() }).gate, "in", "an IN phase rounded to zero still holds `from`");
    assert.strictEqual(T.preparedCatchOf({ timeline: zero, grids, at: 1001, inGridKeys: new Set(["gate:1"]),
      outGridKeys: new Set() }).ok, false);
    const g2 = T.gateGridsOf([{ kind: "gate", id: 7, toSystemId: 1 }, { kind: "gate", id: 8, toSystemId: 3 }],
      new Map([["gate:7", "grid:a"]]), { systems: [1, 2, 3], departAt: 0, jumpMs: 10 }, 1);
    assert.deepStrictEqual(g2, { in: { anchor: gate(7), gridKey: "grid:a" }, out: { anchor: gate(8),
      gridKey: "gate:8" } });

    const p = { at: 1000, fleetId: "t", legSeq: 2, mode: "x", operationId: "op", round: 0, systemIndex: 1 };
    const op = { operationType: "blockade", state: "ACTIVE", dueAt: 1e6, targetSystemId: 5 };
    const at = (gridKey) => ({ kind: "anchor", gridKey });
    const b1 = { fleetId: "b1", legSeq: 0, position: at("station:9"), visit: null };
    const base = { p, operation: op, members: [], posted: [b1], crossing: { from: 5000, until: 9000 },
      target: { kind: "gate", id: 1, gridKey: "gate:1" }, claims: new Map(), nextArrivalAt: null };
    const dp = (over, maxRounds = 4) => decidePosition({ ...base, ...over }, { maxRounds });
    assert.deepStrictEqual(dp({}), { action: "MOVE", members: [{ fleetId: "b1", legSeq: 0, expectedMoveSeq: 0 }],
      preempted: false });
    assert.deepStrictEqual(dp({ posted: [{ ...b1, position: at("gate:1") }] }), { action: "IN_PLACE" });
    assert.deepStrictEqual(dp({ posted: [], nextArrivalAt: 3000 }), { action: "RECHECK", why: "WAIT", at: 3001 });
    assert.deepStrictEqual(dp({ posted: [], nextArrivalAt: 6000 }), { action: "STALE", reason: "POST_AWAY" });
    assert.deepStrictEqual(dp({ posted: [{ ...b1, position: { kind: "warp" }, visit: { moveSeq: 1, purpose: "WORK",
      targetFleetId: null, arriveAt: 2000 } }] }), { action: "RECHECK", why: "IN_WARP", at: 2001 });
    const claimed = (from, until) => ({ posted: [{ ...b1, visit: { moveSeq: 1, purpose: "POST", targetFleetId: "u",
      arriveAt: 900 } }], claims: new Map([["u", { from, until }]]) });
    assert.deepStrictEqual(dp(claimed(4000, 7000)), { action: "RECHECK", why: "HELD", at: 7000 });
    assert.deepStrictEqual(dp(claimed(4000, 9500)), { action: "STALE", reason: "CLAIMED" });
    assert.strictEqual(dp(claimed(6000, 9500)).preempted, true, "a later claim gives way");
    assert.deepStrictEqual(dp({ ...claimed(4000, 7000), p: { at: 1000, mode: "p", operationId: "op", round: 0 } }),
      { action: "STALE", reason: "CLAIMED" }, "a border post never takes the post of a crossing");
    assert.deepStrictEqual(dp({ posted: [], nextArrivalAt: 3000, p: { ...p, round: 3 } }),
      { action: "STALE", reason: "ROUNDS" });
    assert.deepStrictEqual(dp({ crossing: null }), { action: "STALE", reason: "LEG_MOVED" });
    assert.deepStrictEqual(dp({ target: null }), { action: "STALE", reason: "NO_GATE" });
    assert.deepStrictEqual(dp({ operation: { ...op, state: "COMPLETED" } }), { action: "STALE", reason: "OP_NOT_OPEN" });
    assert.strictEqual(nextArrivalOf([{ state: "TRAVELLING", targetSystemId: 5, nextActionAt: 70 },
      { state: "TRAVELLING", targetSystemId: 6, nextActionAt: 10 }, { state: "STAGED", targetSystemId: 5,
        nextActionAt: 5 }], 5), 70);

    const legOf = (systems, departAt = 0) => ({ fleetId: `f${systems.join("")}`, state: "TRAVELLING",
      route: { v: 1, systems, departAt, jumpMs: 100, arriveAt: departAt + 100 * (systems.length - 1),
        graphVersion: 1, mode: "travel", observed: false } });
    const gateOf = (list, now = 0) => campGateOf(5, list.map((f) => ({ fleetId: f.fleetId })),
      new Map(list.map((f) => [f.fleetId, f])), now);
    assert.deepStrictEqual(gateOf([legOf([1, 5, 2]), legOf([1, 5, 3])]), { toSystemId: 1, traffic: 2 });
    assert.deepStrictEqual(gateOf([legOf([3, 5, 2])]), { toSystemId: 2, traffic: 1 }, "tie -> smaller toSystemId");
    assert.strictEqual(gateOf([legOf([1, 5, 2])], 200), null, "the crossing is over");
    assert.strictEqual(gateOf([]), null);

    const T0 = 1000000;
    const JUMP = 60000;
    const route = { v: 1, systems: [10, 11, 12, 13], departAt: T0, jumpMs: JUMP, arriveAt: T0 + 3 * JUMP,
      graphVersion: 1, mode: "travel", observed: false };
    const P = { interceptChancePermille: 600, interceptOperationTypes: ["invasion"] };
    const ip = { operationId: "op1", fleetId: "fa", legSeq: 3, systemIndex: 2, at: T0 + 2 * JUMP };
    const facts = { p: ip, operation: { operationId: "op1", operationType: "blockade", factionId: 1,
      targetSystemId: 12, state: "ACTIVE", dueAt: T0 * 10 }, postFleets: [{ fleetId: "fb", state: "STAGED",
      currentSystemId: 12, operationId: "op1" }], target: { fleetId: "fa", factionId: 2, state: "TRAVELLING",
      legSeq: 3, route }, targetOperationType: "invasion", hostile: true, cooldownUntil: null, worldSeed: 42 };
    const xtl = { from: T0 + 2 * JUMP, inUntil: T0 + 2 * JUMP + 7000, outFrom: T0 + 2 * JUMP + 42000,
      until: T0 + 3 * JUMP };
    const xg = (inKeys, outKeys) => ({ timeline: xtl, grids, inGridKeys: new Set(inKeys),
      outGridKeys: new Set(outKeys) });
    const plain = decideIntercept(facts, P);
    assert.deepStrictEqual(Object.keys(plain).sort(), ["action", "roll"], "no facts.gate -> as before");
    assert.deepStrictEqual(decideIntercept({ ...facts, gate: { ...xg([], []), grids: { in: null, out: null } } }, P),
      plain, "NO_GATE -> as before");
    assert.deepStrictEqual(decideIntercept({ ...facts, gate: xg([], []) }, P), { action: "STALE", reason: "GATE_AWAY" });
    assert.deepStrictEqual(decideIntercept({ ...facts, gate: xg(["gate:1"], []) }, P), { ...plain, gate: "in",
      anchor: gate(1) });
    assert.deepStrictEqual(decideIntercept({ ...facts, gate: xg([], ["gate:2"]) }, P), { action: "DEFER",
      catchAt: xtl.outFrom, anchor: gate(2) });
    assert.deepStrictEqual(decideIntercept({ ...facts, p: { ...ip, at: xtl.outFrom, gate: "out" },
      gate: xg(["gate:1"], ["gate:2"]) }, P), { ...plain, gate: "out", anchor: gate(2) }, "`:o`: OUT only, same roll");
    const ap = { campId: "c", convoyId: "v", fleetId: "fa", legSeq: 3, systemIndex: 2, at: T0 + 2 * JUMP };
    const af = { p: ap, camp: { state: "ACTIVE", untilAt: T0 * 10, activeFrom: 0, systemId: 12, operationId: "op" },
      convoy: { state: "IN_TRANSIT", fleetId: "fa", factionId: 2 }, convoyFleet: facts.target,
      campFleet: { state: "STAGED", currentSystemId: 12, operationId: "op" }, hostile: true, cooldownUntil: null,
      worldSeed: 42 };
    const aplain = decideAmbush(af, { interceptChancePermille: 600 });
    assert.deepStrictEqual(Object.keys(aplain).sort(), ["action", "roll"]);
    assert.deepStrictEqual(decideAmbush({ ...af, gate: { ...xg([], []), grids: { in: null, out: null } } },
      { interceptChancePermille: 600 }), aplain);
    assert.deepStrictEqual(decideAmbush({ ...af, gate: xg([], []) }, { interceptChancePermille: 600 }),
      { action: "STALE", reason: "GATE_AWAY" });
    assert.strictEqual(decideAmbush({ ...af, gate: xg([], ["gate:2"]) }, { interceptChancePermille: 600 }).action,
      "DEFER");

    const cfg = (over) => C.testConfig(over);
    const on = cfg(ON);
    const off = cfg(OFF);
    assert.strictEqual(blockadeGateRowsOf(on), on.strategy.blockadeMaxCrossingsPerLeg);
    assert.strictEqual(blockadeGateRowsOf(off), 0);
    assert.strictEqual(withDepartureRows(off.strategy, off), off.strategy, "off: the strategy section as before");
    const st = withDepartureRows(on.strategy, on);
    const page = Math.min(on.strategy.borderPostScanMaxFleets, on.strategy.blockadeActivationScanMaxFleets);
    assert.deepStrictEqual([borderPostScanRowsOf(st), borderPostScanRowsOf(on.strategy)], [2 * page + 1, page]);
    assert.ok(rowBoundsOfConfig(on).review > rowBoundsOfConfig(off).review);
    assert.ok(rowBoundsOfConfig(on).reactive >= rowBoundsOfConfig(off).reactive);
  });

  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  function bootBlockade(env, cfg) {
    const handlers = {};
    const scheduler = { ...env.scheduler, registerHandler: (type, fn, o) => {
      handlers[type] = fn;
      return env.scheduler.registerHandler(type, fn, o);
    } };
    const world = { repository: { getSystems: (db, ids) => ({ ok: true, systems: ids.map((id) => ({ systemId: id,
      controllerFactionId: id === S.N6 ? GURISTAS : null })) }) } };
    const r = startBlockade({ config: cfg, persistence: env.battleDeps.persistence, scheduler, fleets: env.fleets,
      telemetry: env.telemetry, getBattle: () => env.battle, clock: env.clock, getWorld: () => world });
    assert.ok(r.ok, JSON.stringify(r));
    return { blockade: r.blockade, handlers };
  }

  function blockadeIn(env, tag) {
    const fleetId = env.fleetOf(tag, SANSHA, "patrol", cruisers(4));
    const dueAt = env.clock.now() + 4 * HOUR;
    const op = env.fleets.createOperation({ operationType: "blockade", factionId: SANSHA, originSystemId: S.N5,
      targetSystemId: S.N5, objective: "hold", dueAt, fleets: [{ fleetId, expectedVersion: env.fleet(fleetId).version }] },
    `gbg:op:${tag}`);
    assert.ok(op.ok, JSON.stringify(op));
    const st = env.tx((db) => env.fleets.travel.stageInPlaceInTx(db, { fleetId, at: env.clock.now() },
      `gbg:stage:${tag}`));
    assert.ok(st.ok, JSON.stringify(st));
    return { fleetId, operationId: op.operationId, dueAt };
  }

  const register = (env, bk, b, fleetIds) => {
    const spec = { operationId: b.operationId, systemId: S.N5, factionId: SANSHA, dueAt: b.dueAt,
      at: env.clock.now(), ...(fleetIds ? { fleetIds } : {}) };
    const scan = env.tx((db) => bk.blockade.registerBlockadeInTx(db, spec));
    assert.ok(scan.ok, JSON.stringify(scan));
    bk.blockade.countScan(scan);
    return scan;
  };
  const payloadOf = (env, key) => JSON.parse(env.event(key).payload);
  const posAt = (env, id, systemId, at) => {
    const fleet = env.fleet(id);
    return env.tx((db) => env.fleets.grid.positionsOf(db, systemId, [fleet], at)).positions.get(id);
  };
  const gateBattles = (env) => env.battles().filter((b) => b.grid_kind === "gate").map((b) => Number(b.grid_id));

  needsDriver("GBG2 grid intercept_post: POSITION moves the blockade to the entry gate, INTERCEPT on the IN "
    + "gate, battle in the gate grid; a blockade on the CP -> GATE_AWAY", async () => {
    const env = GD.createScene(driver, ON, { resolver: C.seamResolver(() => "A_WIN") });
    try {
      const bk = bootBlockade(env, env.cfg);
      const t = env.fleetOf("t", GURISTAS, "patrol", cruisers(2), S.N0);
      const trip = env.trip(t, GURISTAS, S.N0, S.N6, "invasion", "capture", "t");
      const b = blockadeIn(env, "b");
      const scan = register(env, bk, b, [t]);
      assert.deepStrictEqual([scan.queued, scan.positions, scan.positionRefused], [1, 1, 0]);
      const from = trip.departAt + trip.jumpMs;
      const pKey = positionKey({ mode: "x", operationId: b.operationId, fleetId: t, legSeq: trip.legSeq }, 0);
      assert.deepStrictEqual(payloadOf(env, pKey), { at: env.clock.now(), fleetId: t, legSeq: trip.legSeq, mode: "x",
        operationId: b.operationId, round: 0, systemIndex: 1 }, "lead > the jump: at = the scan time");
      await env.drive(from);
      assert.deepStrictEqual([env.event(pKey).state, env.event(pKey).outcome], ["DONE", "MOVE"]);
      const v = env.visit(b.fleetId);
      assert.deepStrictEqual([v.purpose, v.target_fleet_id, v.to_kind, Number(v.to_id)], ["POST", t, "gate",
        GD.GATE_N0]);
      assert.ok(Number(v.arrive_at) <= from, `${v.arrive_at} <= ${from}`);
      const key = crossingKey(b.operationId, t, trip.legSeq);
      assert.deepStrictEqual([env.event(key).state, env.event(key).outcome], ["DONE", "INTERCEPT"]);
      const f = env.fleet(t);
      assert.deepStrictEqual([f.currentSystemId, ["STAGED", "ENGAGED"].includes(f.state)], [S.N5, true], f.state);
      const pos = posAt(env, t, S.N5, from);
      assert.deepStrictEqual([pos.anchorKind, pos.anchorId], ["gate", GD.GATE_N0]);
      await env.drive(from + 60000);
      assert.deepStrictEqual(gateBattles(env), [GD.GATE_N0]);
      const c = bk.blockade.getStatus().counters;
      assert.deepStrictEqual([c.positionsQueued, c.positioned, c.positionLate, c.gateIn, c.intercepts], [1, 1, 0, 1, 1]);
      bk.blockade.stop();
    } finally {
      env.close();
    }

    const env2 = GD.createScene(driver, ON);
    try {
      const bk = bootBlockade(env2, env2.cfg);
      const t = env2.fleetOf("t", GURISTAS, "patrol", cruisers(2), S.N0);
      const trip = env2.trip(t, GURISTAS, S.N0, S.N6, "invasion", "capture", "t");
      const b = blockadeIn(env2, "b");
      register(env2, bk, b, [t]);
      const key = crossingKey(b.operationId, t, trip.legSeq);
      const row = env2.event(key);
      env2.clock.set(Number(row.due_at));
      const ev = { eventType: INTERCEPT_EVENT, idempotencyKey: key, dueAt: Number(row.due_at),
        payload: JSON.parse(row.payload) };
      const r = bk.handlers[INTERCEPT_EVENT](ev, {});
      assert.deepStrictEqual([r.ok, r.outcome, r.effect], [true, "STALE", undefined]);
      r.onCommitted();
      assert.strictEqual(bk.blockade.getStatus().staleByReason.GATE_AWAY, 1, "the blockade on the CP");
      bk.blockade.stop();
    } finally {
      env2.close();
    }
  });

  needsDriver("GBG3 grid border post: POSITION p to the hostile neighbour gate; exit by that gate -> DEFER "
    + "`:o`, INTERCEPT + placeInTx, battle in the exit gate grid", async () => {
    const env = GD.createScene(driver, ON, { resolver: C.seamResolver(() => "A_WIN") });
    try {
      const b = blockadeIn(env, "b");
      const offBk = bootBlockade(env, JSON.parse(JSON.stringify({ ...env.cfg, grid: { ...env.cfg.grid,
        crossings: { ...env.cfg.grid.crossings, blockadeGateEnabled: false } } })));
      const t = env.fleetOf("t", GURISTAS, "patrol", cruisers(2), S.N0);
      const trip = env.trip(t, GURISTAS, S.N0, S.N6, "invasion", "capture", "t");
      offBk.blockade.stop();
      assert.deepStrictEqual(env.rows(POSITION_EVENT), []);
      const bk = bootBlockade(env, env.cfg);
      register(env, bk, b, undefined);
      const pKey = positionKey({ mode: "p", operationId: b.operationId }, 0);
      assert.deepStrictEqual(payloadOf(env, pKey), { at: env.clock.now(), mode: "p", operationId: b.operationId,
        round: 0 });
      const key = crossingKey(b.operationId, t, trip.legSeq);
      await env.drive(Number(env.event(key).due_at));
      const v = env.visit(b.fleetId);
      assert.deepStrictEqual([v.purpose, v.target_fleet_id, v.to_kind, Number(v.to_id)], ["POST", null, "gate",
        GD.GATE_N6], "rankPosts: the gate to the hostile N6 first");
      assert.strictEqual(env.event(key).outcome, "DEFER");
      const oKey = `${key}:o`;
      const o = payloadOf(env, oKey);
      const tl = T.transitTimelineOf({ systems: [S.N0, S.N5, S.N6], departAt: trip.departAt, jumpMs: trip.jumpMs }, 1,
        cruisers(2));
      assert.deepStrictEqual(o, { at: tl.outFrom, fleetId: t, gate: "out", legSeq: trip.legSeq,
        operationId: b.operationId, systemIndex: 1 });
      await env.drive(tl.outFrom);
      assert.deepStrictEqual([env.event(oKey).state, env.event(oKey).outcome], ["DONE", "INTERCEPT"]);
      const sv = env.q("SELECT at_kind, at_id FROM world_fleet_grid_visits WHERE fleet_id = ?", t)[0];
      assert.deepStrictEqual([env.fleet(t).currentSystemId, sv.at_kind, Number(sv.at_id)], [S.N5, "gate", GD.GATE_N6]);
      const again = bk.handlers[INTERCEPT_EVENT]({ eventType: INTERCEPT_EVENT, idempotencyKey: oKey, dueAt: o.at,
        payload: o }, {});
      assert.deepStrictEqual([again.outcome, again.effect], ["STALE", undefined]);
      assert.deepStrictEqual([`${key}:hit`, haltKeyOf(`${key}:hit`)].map((k) => env.n("SELECT count(*) AS n FROM "
        + "world_event_journal WHERE idempotency_key = ?", k)), [1, 1]);
      await env.drive(tl.outFrom + 60000);
      assert.deepStrictEqual(gateBattles(env), [GD.GATE_N6]);
      const c = bk.blockade.getStatus().counters;
      assert.deepStrictEqual([c.gateDeferred, c.gateOut, c.intercepts], [1, 1, 1]);
      bk.blockade.stop();
    } finally {
      env.close();
    }
  });

  needsDriver("GBG4 grid lowsec camp: the plan picks the gate, KEEP moves the camp to its gate, a convoy "
    + "off that gate is not struck, a convoy entering by it is stopped on the IN gate", async () => {
    const L1_N0 = 50019001;
    const L1_L2 = 50019002;
    const L1_X = 50019003;
    const OTHER = 30000299;
    const adapter = { readGridAnchors: (systemId) => (systemId === S.L1 ? { ok: true, truncated: false, anchors: [
      GD.anchor("gate", L1_N0, 0, { toSystemId: S.N0 }), GD.anchor("gate", L1_L2, GD.AU, { toSystemId: S.L2 }),
      GD.anchor("gate", L1_X, 2 * GD.AU, { toSystemId: OTHER }), GD.anchor("station", 60019001, 5 * GD.AU)] }
      : { ok: true, truncated: false, anchors: [] }) };
    const base = A.testConfig({ campChoiceTopN: 1 });
    const D = C.testConfig({});
    const cfg = { ...base, grid: { ...D.grid, enabled: true, movesEnabled: true,
      crossings: { ...D.grid.crossings, blockadeGateEnabled: true } } };
    const registry = { listActiveFactions: () => [{ factionId: H.FACTION_B, kind: "pirate" }] };
    const part = (fn) => H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const env = await A.boot(reopen(), shared, cfg, { registry, adapter });
      try {
        await fn(env, shared);
      } finally {
        env.stop();
      }
    });

    await part(async (env, shared) => {
      const t0 = shared.clock.now();
      for (const [id, sys] of [["st-src", S.N0], ["st-dst", S.L2]]) {
        const r = env.tx((db) => env.stations.repository.createStation(db, { stationId: id, kind: "upwell",
          typeId: 35832, structureFamily: "astrahus", systemId: sys, ownerFactionId: H.FACTION_A,
          ownerCorporationId: 1000162, origin: "built", at: t0 }, `test:station:${id}`));
        assert.ok(r.ok, JSON.stringify(r));
      }
      const stock = env.tx((db) => env.stations.repository.applyStockChange(db, { stationId: "st-src",
        key: "test:stock", reason: "TEST", at: t0, deltas: [{ itemKind: "hull", itemKey: "group:battleship",
          delta: 5 }] }));
      assert.ok(stock.ok, JSON.stringify(stock));
      const cf = env.fleets.createFleet({ factionId: H.FACTION_B, currentSystemId: S.N0, homeSystemId: S.N0,
        fleetRole: "patrol", composition: A.CAMP_COMP }, "gbg4:campfleet");
      assert.ok(cf.ok, JSON.stringify(cf));
      A.convoy(env, "gbg4p");
      const round = Math.floor(t0 / env.cfg.lowsec.planPeriodMs) + 1;
      const plan = env.run(LS.PLAN_EVENT, { eventType: LS.PLAN_EVENT, dueAt: t0, payload: { round },
        idempotencyKey: LS.planKey(round) });
      assert.strictEqual(plan.v.created.length, 1, JSON.stringify(plan.v));
      const camp = env.camp(plan.v.created[0].campId);
      assert.deepStrictEqual([camp.systemId, camp.detail.gateToSystemId, camp.detail.gateTraffic],
        [S.L1, Math.min(S.N0, S.L2), 1]);
      assert.strictEqual(env.lowsec.getStatus().counters.campGatePicked, 1);
    });

    await part(async (env) => {
      const sc = await A.scene(env, 4 * HOUR, "lc_off", { gateToSystemId: OTHER, gateTraffic: 0 });
      const cv = A.convoy(env, "gbg4o");
      const q = env.scheduler.enqueue(LS.STEP_EVENT, sc.campId, cv.t1, { campId: sc.campId, stepSeq: 1, round: 0 },
        LS.stepKey(sc.campId, 1));
      assert.ok(q.ok, JSON.stringify(q));
      await env.settle(cv.t1 + 1000);
      const v = env.q("SELECT purpose, to_kind, to_id FROM world_fleet_grid_visits WHERE fleet_id = ?",
        sc.campFleet)[0];
      assert.deepStrictEqual([v.purpose, v.to_kind, Number(v.to_id)], ["POST", "gate", L1_X]);
      assert.deepStrictEqual(env.events(LS.AMBUSH_EVENT), []);
      const c = env.lowsec.getStatus().counters;
      assert.deepStrictEqual([c.campGateMoves, c.strikesOffGate, c.strikesScheduled], [1, 1, 0]);
    });

    await part(async (env) => {
      const sc = await A.scene(env, 4 * HOUR, "lc_in", { gateToSystemId: S.N0, gateTraffic: 1 });
      const cv = A.convoy(env, "gbg4i");
      const q = env.scheduler.enqueue(LS.STEP_EVENT, sc.campId, cv.t1, { campId: sc.campId, stepSeq: 1, round: 0 },
        LS.stepKey(sc.campId, 1));
      assert.ok(q.ok, JSON.stringify(q));
      await env.settle(cv.t1 + 1000);
      assert.deepStrictEqual(env.events(LS.AMBUSH_EVENT).map((s) => [s.idempotency_key, s.state]),
        [[LS.ambushKey(sc.campId, cv.convoyId), "DONE"]]);
      const f = env.fleet(cv.fleetId);
      assert.deepStrictEqual([f.state, f.currentSystemId], ["STAGED", S.L1]);
      const pos = env.tx((db) => env.fleets.grid.positionsOf(db, S.L1, [f], cv.t1)).positions.get(cv.fleetId);
      assert.deepStrictEqual([pos.anchorKind, pos.anchorId], ["gate", L1_N0]);
      const c = env.lowsec.getStatus().counters;
      assert.deepStrictEqual([c.campGateMoves, c.gateIn, c.intercepts], [0, 1, 1]);
    });
  });

  needsDriver("GBG5 grid idempotency and off: INTERCEPT / `:o` effects twice -> one stop, POSITION twice -> "
    + "one move; flag off -> no POSITION row, a queued one drains STALE GATE_OFF", async () => {
    const env = GD.createScene(driver, ON);
    try {
      const bk = bootBlockade(env, env.cfg);
      const t = env.fleetOf("t", GURISTAS, "patrol", cruisers(2), S.N0);
      const trip = env.trip(t, GURISTAS, S.N0, S.N6, "invasion", "capture", "t");
      const b = blockadeIn(env, "b");
      register(env, bk, b, [t]);
      const pKey = positionKey({ mode: "x", operationId: b.operationId, fleetId: t, legSeq: trip.legSeq }, 0);
      const prow = env.event(pKey);
      const pev = { eventType: POSITION_EVENT, idempotencyKey: pKey, dueAt: Number(prow.due_at),
        payload: JSON.parse(prow.payload) };
      const pr = bk.handlers[POSITION_EVENT](pev, {});
      assert.strictEqual(pr.outcome, "MOVE", JSON.stringify(pr));
      const m1 = env.tx((db) => pr.effect(db, pev));
      const m2 = env.tx((db) => pr.effect(db, pev));
      assert.deepStrictEqual([m1.action, m2.action], ["MOVE", "REFUSED"], JSON.stringify(m2));
      assert.strictEqual(env.n("SELECT count(*) AS n FROM world_scheduled_events WHERE idempotency_key LIKE ?",
        `grid:${b.fleetId}:%`), 1);
      const key = crossingKey(b.operationId, t, trip.legSeq);
      const row = env.event(key);
      await env.drive(Number(row.due_at) - 1);
      env.clock.set(Number(row.due_at));
      const ev = { eventType: INTERCEPT_EVENT, idempotencyKey: key, dueAt: Number(row.due_at),
        payload: JSON.parse(row.payload) };
      const r = bk.handlers[INTERCEPT_EVENT](ev, {});
      assert.strictEqual(r.outcome, "INTERCEPT", JSON.stringify(r));
      const first = env.tx((db) => r.effect(db, ev));
      const second = env.tx((db) => r.effect(db, ev));
      assert.deepStrictEqual([first.applied, first.action, second.action], [true, "INTERCEPT", "DUPLICATE"]);
      const oev = { eventType: INTERCEPT_EVENT, idempotencyKey: `${key}:o`, dueAt: Number(row.due_at) + 1000,
        payload: { ...ev.payload, at: Number(row.due_at) + 1000, gate: "out" } };
      const o1 = bk.handlers[INTERCEPT_EVENT](oev, {});
      assert.deepStrictEqual([o1.ok, o1.outcome], [true, "STALE"], "the stopped leg");
      const hits = env.n("SELECT count(*) AS n FROM world_event_journal WHERE idempotency_key = ?", `${key}:hit`);
      const halts = env.n("SELECT count(*) AS n FROM world_event_journal WHERE idempotency_key = ?",
        haltKeyOf(`${key}:hit`));
      assert.deepStrictEqual([hits, halts], [1, 1]);
      bk.blockade.stop();

      const offCfg = JSON.parse(JSON.stringify(env.cfg));
      offCfg.grid.crossings.blockadeGateEnabled = false;
      const off = bootBlockade(env, offCfg);
      const queued = env.scheduler.enqueue(POSITION_EVENT, b.operationId, env.clock.now(), { at: env.clock.now(),
        mode: "p", operationId: b.operationId, round: 0 }, positionKey({ mode: "p", operationId: b.operationId }, 0));
      assert.ok(queued.ok, JSON.stringify(queued));
      const before = env.rows(POSITION_EVENT).length;
      const u = env.fleetOf("u", GURISTAS, "patrol", cruisers(2), S.N0);
      env.trip(u, GURISTAS, S.N0, S.N6, "invasion", "capture", "u");
      const b2 = blockadeIn(env, "b2");
      register(env, off, b2, [u]);
      assert.strictEqual(env.rows(POSITION_EVENT).length, before, "off: no POSITION row");
      await env.drive(env.clock.now() + 1000);
      assert.strictEqual(env.event(positionKey({ mode: "p", operationId: b.operationId }, 0)).outcome, "STALE");
      assert.strictEqual(off.blockade.getStatus().positionStaleByReason.GATE_OFF, 1);
      off.blockade.stop();
    } finally {
      env.close();
    }
  });
};
