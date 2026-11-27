"use strict";

const assert = require("node:assert");

const { watchedOf, crossingsOfLeg, sizeClassOf, effectRowsOf } = require("../../lib/listeningPosts/rules");
const { createListeningPostService } = require("../../lib/listeningPosts/service");
const { createSightingRepository } = require("../../lib/listeningPosts/repository");
const { startListeningPosts, createUnavailableListeningPosts, FACADE_METHODS } = require("../../lib/listeningPosts");
const LS = require("../../lib/listeningPosts/schema");
const { listeningPostTxRowsOf } = require("../../lib/strategy/reviewRows");
const { rowBoundsOfConfig } = require("../../lib/strategy/reviewBound");
const { MIGRATIONS } = require("../../lib/persistence/migrations");
const { TABLE_POLICY, ACTION } = require("../../lib/persistence/worldReset");
const { harness: H } = require("../battle/settlement.test");
const { harness: C } = require("../battle/contacts.test");

const S = H.S;
const HOUR = 3600000;
const AVOID = Object.freeze({ avoidSecClasses: ["highsec", "lowsec"] });
const SETTINGS = Object.freeze({ rangeJumps: 0, maxChecksPerLeg: 4, maxEnqueuesPerTransaction: 2,
  maxSightingsPerPass: 16, smallMaxShips: 5, largeMinShips: 20, sightingRetentionMs: 86400000, pruneBatch: 50,
  watchRefreshMs: 60000 });

function cfgOf(env, lp = {}) {
  const c = JSON.parse(JSON.stringify(env.cfg));
  c.modules.strategy = { enabled: true };
  c.persistence.maxRowsPerTransaction = 1100;
  c.listeningPost = { ...c.listeningPost, enabled: true, ...lp };
  return c;
}

function fakeSentries(posts, armed) {
  return { listLiveOfKind: (kind) => (kind === "listening_post" ? posts.map((p) => ({ ...p })) : []),
    isArmed: (itemId) => armed.has(itemId) };
}

function boot(env, cfg, sentries, extra = {}) {
  const handlers = {};
  const scheduler = { ...env.scheduler, registerHandler: (type, fn, o) => {
    handlers[type] = { fn, opts: o };
    return env.scheduler.registerHandler(type, fn, o);
  } };
  const lines = [];
  const timers = [];
  const started = startListeningPosts({ config: cfg, persistence: { ok: true, store: env.store }, scheduler,
    fleets: env.fleets, getSentries: () => sentries, clock: env.clock, logger: { log: (l) => lines.push(l) },
    setTimer: (fn, ms) => {
      timers.push({ fn, ms });
      return { cancel() {}, hasRef: () => false };
    }, ...extra });
  return { started, handlers, lines, timers, facade: started.ok ? started.listeningPosts : null };
}

function mover(env, tag, composition) {
  const r = env.fleets.createFleet({ factionId: C.SANSHA, currentSystemId: S.N0, homeSystemId: S.N0,
    fleetRole: "invasion", composition }, `lp:f:${tag}`);
  assert.ok(r.ok, JSON.stringify(r));
  const op = env.fleets.createOperation({ operationType: "invasion", factionId: C.SANSHA, originSystemId: S.N0,
    targetSystemId: S.N9, objective: "capture", dueAt: env.clock.now() + HOUR,
    fleets: [{ fleetId: r.fleetId, expectedVersion: env.fleet(r.fleetId).version }] }, `lp:op:${tag}`);
  assert.ok(op.ok, JSON.stringify(op));
  const plan = env.fleets.planTravel({ fleetId: r.fleetId, targetSystemId: S.N9, constraints: AVOID },
    `lp:plan:${tag}`);
  assert.ok(plan.ok, JSON.stringify(plan));
  return { fleetId: r.fleetId, plan };
}

const rowsOf = (env) => env.q("SELECT idempotency_key, aggregate_id, due_at, payload, state FROM "
  + "world_scheduled_events WHERE event_type = ? ORDER BY due_at, idempotency_key", LS.EVENT_TYPE)
  .map((r) => ({ ...r, payload: JSON.parse(r.payload) }));
const evOf = (row) => ({ eventType: LS.EVENT_TYPE, idempotencyKey: row.idempotency_key, payload: row.payload,
  dueAt: row.due_at, aggregateId: row.aggregate_id });

function settle(env, res) {
  let v;
  if (typeof res.effect === "function") {
    const tx = env.store.transaction("t.effect", (db) => {
      v = res.effect(db);
      if (v && v.ok === false) throw new Error("rollback");
      return v;
    });
    if (!tx.ok) return { committed: false, v };
  }
  if (typeof res.onCommitted === "function") res.onCommitted(v);
  return { committed: true, v };
}

module.exports = ({ test, skip }) => {
  test("LPR1 rules: watchedOf armed only + rangeJumps, crossingsOfLeg enterAt / ends / max, sizeClassOf, row bounds",
    () => {
      const posts = [{ systemId: 10, ownerCorpId: 7, armed: true }, { systemId: 10, ownerCorpId: 3, armed: true },
        { systemId: 20, ownerCorpId: 7, armed: false }, { systemId: 30, ownerCorpId: null, armed: true }];
      const nb = (id) => ({ 10: [11, 12] }[id] || []);
      assert.deepStrictEqual([...watchedOf(posts, nb, 0).watched], [[10, [3, 7]]]);
      assert.deepStrictEqual([...watchedOf(posts, nb, 1).watched], [[10, [3, 7]], [11, [3, 7]], [12, [3, 7]]]);
      const watched = new Map([[1, [7]], [3, [7]], [5, [7]]]);
      const leg = { systems: [1, 2, 3, 4, 5], departAt: 1000, jumpMs: 60 };
      assert.deepStrictEqual(crossingsOfLeg(leg, watched, 4), [{ systemId: 1, systemIndex: 0, enterAt: 1000 },
        { systemId: 3, systemIndex: 2, enterAt: 1120 }, { systemId: 5, systemIndex: 4, enterAt: 1240 }]);
      assert.deepStrictEqual(crossingsOfLeg(leg, watched, 2).length, 2);
      assert.deepStrictEqual(crossingsOfLeg(leg, watched, 4, 3), [{ systemId: 5, systemIndex: 4, enterAt: 1240 }]);
      assert.deepStrictEqual(crossingsOfLeg(leg, new Map(), 4), []);
      assert.deepStrictEqual([null, 0, 5, 6, 19, 20, 500].map((n) => sizeClassOf(n, SETTINGS)),
        ["medium", "small", "small", "medium", "medium", "large", "large"]);
      assert.strictEqual(effectRowsOf(SETTINGS), 52);
      assert.strictEqual(effectRowsOf({ ...SETTINGS, mailEnabled: true, maxCorpsPerSighting: 4, mailMaxRecipients: 10 }),
        92);
      const base = C.testConfig();
      base.modules.strategy = { enabled: true };
      const on = JSON.parse(JSON.stringify(base));
      on.listeningPost.enabled = true;
      assert.deepStrictEqual([listeningPostTxRowsOf(base), listeningPostTxRowsOf(on),
        listeningPostTxRowsOf({ listeningPost: { enabled: true } })], [0, 2, 1]);
      assert.strictEqual(rowBoundsOfConfig(on).review - rowBoundsOfConfig(base).review, 2);
      assert.strictEqual(rowBoundsOfConfig(on).reactive - rowBoundsOfConfig(base).reactive, 2);
    });

  test("LPL1 listener: zero SQL, one enqueue per departure (exact payload), tx budget, errors counted / rethrown",
    () => {
      const calls = [];
      let seq = 1;
      let refuse = null;
      const store = { getTxSeq: () => seq, transaction() {
        throw new Error("no SQL in the listener");
      } };
      const scheduler = { enqueue: (...a) => {
        if (refuse) throw refuse;
        calls.push(a);
        return { ok: true, duplicate: false };
      } };
      const svc = createListeningPostService({ store, scheduler, fleetRepository: {}, repo: {},
        settings: { ...SETTINGS, maxEnqueuesPerTransaction: 1 },
        getSentries: () => fakeSentries([{ itemId: 1, systemId: 3, ownerCorpId: 7 },
          { itemId: 2, systemId: 5, ownerCorpId: 8 }], new Set([1, 2])) });
      svc.refreshWatch();
      const d = (fleetId, systems) => ({ fleetId, factionId: 500019, fleetRole: "invasion", shipCount: 4,
        operationId: null, legSeq: 2, leg: { systems, departAt: 1000, jumpMs: 60 }, wormholes: false, chained: true });
      const tx = { inTransaction: true };
      svc.onDeparture(tx, d("f1", [1, 2, 3, 4, 5]));
      assert.deepStrictEqual(calls, [[LS.EVENT_TYPE, "3", 1120, { check: 0, enterAt: 1120, fleetId: "f1", legSeq: 2,
        systemId: 3, systemIndex: 2 }, "lpost:3:x:f1:2", { tx, chained: true }]]);
      svc.onDeparture(tx, d("f2", [5, 6]));
      svc.onDeparture(tx, d("f3", [1, 2]));
      assert.strictEqual(calls.length, 1, "budget 1 per transaction; no watched system = no enqueue");
      seq = 2;
      svc.onDeparture(tx, d("f2", [5, 6]));
      assert.strictEqual(calls.length, 2);
      refuse = new Error("boom");
      seq = 3;
      svc.onDeparture(tx, d("f4", [3]));
      assert.throws(() => svc.onDeparture({ inTransaction: false }, d("f5", [3])), /boom/);
      const c = svc.getStatus().counters;
      assert.deepStrictEqual([c.legsSeen, c.sightingsQueued, c.listenerBudgetPass, c.listenerErrors],
        [6, 2, 1, 1]);
    });

  test("LPW1 watch refresh: getGraph neighbours, no graph = watchNoGraph, sentries throw "
    + "missing = watchErrors + one log line per reason", () => {
    const lines = [];
    const logger = { log: (l) => lines.push(l) };
    const sentries = fakeSentries([{ itemId: 1, systemId: 10, ownerCorpId: 7 }], new Set([1]));
    const getNeighbors = (id) => (id === 10 ? [11, 12] : []);
    const svcOf = (extra) => createListeningPostService({ store: {}, scheduler: {}, fleetRepository: {}, repo: {},
      settings: { ...SETTINGS, rangeJumps: 1 }, logger, ...extra });
    const withGraph = svcOf({ getSentries: () => sentries,
      getGraph: () => ({ getGraph: () => ({ ok: true, graph: { getNeighbors } }) }) });
    withGraph.refreshWatch();
    assert.deepStrictEqual([withGraph.watchedSystems(), withGraph.getStatus().counters.watchNoGraph], [[10, 11, 12], 0]);
    const noGraph = svcOf({ getSentries: () => sentries });
    noGraph.refreshWatch();
    assert.deepStrictEqual([noGraph.watchedSystems(), noGraph.getStatus().counters.watchNoGraph,
      noGraph.getStatus().lastRefusal], [[10], 1, "WATCH:NO_GRAPH"]);
    let boom = false;
    const flaky = svcOf({ getSentries: () => {
      if (boom) throw new Error("boom");
      return sentries;
    }, getGraph: () => ({ getGraph: () => ({ ok: true, graph: { getNeighbors } }) }) });
    flaky.refreshWatch();
    boom = true;
    flaky.refreshWatch();
    assert.deepStrictEqual([flaky.watchedSystems(), flaky.getStatus().counters.watchErrors], [[10, 11, 12], 1],
      "an exception keeps the previous map");
    flaky.refreshWatch();
    assert.strictEqual(flaky.getStatus().counters.watchErrors, 2);
    assert.deepStrictEqual(lines, ["listeningPost: watch refresh failed - boom"], "one line for the same reason");
    const none = svcOf({ getSentries: () => null });
    none.refreshWatch();
    assert.deepStrictEqual([none.watchedSystems(), none.getStatus().counters.watchErrors,
      none.getStatus().lastRefusal], [[], 1, "WATCH:NO_SENTRIES"]);
    assert.strictEqual(lines[1], "listeningPost: watch refresh failed - NO_SENTRIES");
  });

  const driver = H.loadDriver();
  if (!driver.ok) {
    skip("LPH1/LPH2/LPH3 listening post handler on a store", `better-sqlite3 unavailable (${driver.detail})`);
    return;
  }

  test("LPH3: arrival before the N9 row -> SIGHTED without from / to; route null elsewhere = "
    + "STALE ROUTE_CHANGED; after stop() OFF", async () => {
    const env = C.createEnv(driver);
    try {
      const posts = [{ itemId: 71, systemId: S.N5, ownerCorpId: 98000001 },
        { itemId: 79, systemId: S.N9, ownerCorpId: 98000001 }];
      const lp = boot(env, cfgOf(env), fakeSentries(posts, new Set([71, 79])));
      assert.ok(lp.started.ok, JSON.stringify(lp.started));
      const m = mover(env, "end", [{ hullGroup: "cruiser", count: 4 }]);
      await env.drive(m.plan.departAt + 4 * m.plan.jumpMs);
      const rows = env.q("SELECT system_id, system_index, from_system_id, to_system_id FROM world_post_sightings "
        + "WHERE fleet_id = ? ORDER BY system_index", m.fleetId);
      assert.deepStrictEqual(rows.map((r) => [r.system_id, r.system_index, r.from_system_id, r.to_system_id]),
        [[S.N5, 1, S.N0, S.N6], [S.N9, 4, null, null]]);
      const fleet = env.fleet(m.fleetId);
      assert.deepStrictEqual([fleet.route, fleet.currentSystemId], [null, S.N9]);
      const handler = lp.handlers[LS.EVENT_TYPE].fn;
      const payload = { check: 1, enterAt: m.plan.departAt + 3 * m.plan.jumpMs, fleetId: m.fleetId,
        legSeq: m.plan.legSeq, systemId: S.N7, systemIndex: 3 };
      const stale = handler({ eventType: LS.EVENT_TYPE, payload }, { now: env.clock.now() });
      assert.strictEqual(stale.outcome, "STALE");
      settle(env, stale);
      assert.strictEqual(lp.facade.getStatus().staleByReason.ROUTE_CHANGED, 1);
      lp.facade.stop();
      const off = handler({ eventType: LS.EVENT_TYPE, payload }, { now: env.clock.now() });
      assert.deepStrictEqual([off.ok, off.outcome], [true, "OFF"]);
      settle(env, off);
      assert.strictEqual(lp.facade.getStatus().counters.off, 1);
    } finally {
      env.close();
    }
  });

  test("LPH1 handler: SIGHTED row, replay = duplicate, chain, legSeq changed = STALE, NO_POST, bad payload", () => {
    const env = C.createEnv(driver);
    try {
      const posts = [{ itemId: 71, systemId: S.N5, ownerCorpId: 98000001 },
        { itemId: 72, systemId: S.N7, ownerCorpId: 98000002 }];
      const sentries = fakeSentries(posts, new Set([71, 72]));
      const lp = boot(env, cfgOf(env), sentries);
      assert.ok(lp.started.ok, JSON.stringify(lp.started));
      assert.deepStrictEqual([lp.facade.getMode(), lp.handlers[LS.EVENT_TYPE].opts, lp.facade.getStatus().watchedSystems,
        lp.timers.map((t) => t.ms)], ["on", { maxPerPass: 16 }, 2, [60000]]);
      assert.deepStrictEqual(Object.keys(lp.facade).sort(), [...FACADE_METHODS].sort());
      assert.ok(lp.lines[0].startsWith("listeningPost: on range=0 checks/leg=4 budget=2"), lp.lines[0]);
      const m = mover(env, "a", [{ hullGroup: "cruiser", count: 10 }]);
      const legSeq = m.plan.legSeq;
      let rows = rowsOf(env);
      assert.strictEqual(rows.length, 1, "one row per departure");
      const first = rows[0];
      assert.deepStrictEqual([first.idempotency_key, first.aggregate_id, first.due_at],
        [LS.sightingKey(S.N5, m.fleetId, legSeq), String(S.N5), m.plan.departAt + m.plan.jumpMs]);
      assert.deepStrictEqual(first.payload, { check: 0, enterAt: m.plan.departAt + m.plan.jumpMs, fleetId: m.fleetId,
        legSeq, systemId: S.N5, systemIndex: 1 });
      const run = (ev) => lp.handlers[LS.EVENT_TYPE].fn(ev, { now: m.plan.departAt + m.plan.jumpMs });
      const res = run(evOf(first));
      assert.strictEqual(res.outcome, "SIGHTED");
      assert.strictEqual(settle(env, res).committed, true);
      const sightings = env.q("SELECT * FROM world_post_sightings");
      assert.strictEqual(sightings.length, 1);
      const s0 = sightings[0];
      assert.deepStrictEqual([s0.system_id, s0.fleet_id, s0.leg_seq, s0.system_index, s0.faction_id, s0.fleet_role,
        s0.size_class, s0.from_system_id, s0.to_system_id, s0.seen_at],
      [S.N5, m.fleetId, legSeq, 1, C.SANSHA, "invasion", "medium", S.N0, S.N6, first.payload.enterAt]);
      assert.strictEqual(settle(env, run(evOf(first))).v.duplicate, true);
      assert.strictEqual(env.n("SELECT COUNT(*) AS n FROM world_post_sightings"), 1);
      rows = rowsOf(env);
      const chained = rows.find((r) => r.payload.check === 1);
      assert.deepStrictEqual(chained.payload, { check: 1, enterAt: m.plan.departAt + 3 * m.plan.jumpMs,
        fleetId: m.fleetId, legSeq, systemId: S.N7, systemIndex: 3 });
      assert.strictEqual(rows.length, 2, "N6 is not watched: no row");
      const stale = run({ ...evOf(chained), payload: { ...chained.payload, legSeq: legSeq + 1 } });
      assert.strictEqual(stale.outcome, "STALE");
      settle(env, stale);
      posts.splice(1, 1);
      lp.timers[0].fn();
      const none = run(evOf(chained));
      assert.strictEqual(none.outcome, "NO_POST");
      assert.deepStrictEqual(settle(env, none).v, { ok: true, queued: false });
      assert.strictEqual(env.n("SELECT COUNT(*) AS n FROM world_post_sightings"), 1);
      const bad = run({ ...evOf(first), payload: { ...first.payload, extra: 1 } });
      assert.deepStrictEqual([bad.ok, bad.permanent], [false, true]);
      const st = lp.facade.getStatus();
      assert.deepStrictEqual([st.counters.sightings, st.counters.duplicates, st.counters.chainQueued,
        st.counters.stale, st.counters.staleLegChanged, st.counters.noPost, st.staleByReason.LEG_CHANGED],
      [1, 1, 1, 1, 1, 1, 1]);
      lp.facade.stop();
      assert.strictEqual(lp.facade.getMode(), "off");
    } finally {
      env.close();
    }
  });

  test("LPH2 retention <= pruneBatch in the effect; migration 111 + WIPE; start refusals; stub = facade methods",
    () => {
      const env = C.createEnv(driver);
      try {
        assert.deepStrictEqual(MIGRATIONS.filter((m) => m.version === 111).map((m) => [m.name, m.up]),
          [["post_sightings", LS.upPostSightings]]);
        assert.strictEqual(TABLE_POLICY.world_post_sightings, ACTION.WIPE);
        const repo = createSightingRepository();
        const now = env.clock.now();
        const old = (fleetId, seenAt) => env.store.transaction("t.old", (db) => repo.insertInTx(db, { systemId: 30000001,
          fleetId, legSeq: 0, systemIndex: 0, factionId: C.SANSHA, fleetRole: "patrol", sizeClass: "small",
          fromSystemId: null, toSystemId: null, seenAt }, seenAt));
        for (const [i, at] of [[1, 10], [2, 20], [3, 30]]) assert.ok(old(`old${i}`, at).ok);
        assert.ok(old("young", now - 1000).ok);
        const lp = boot(env, cfgOf(env, { pruneBatch: 2 }), fakeSentries([{ itemId: 71, systemId: S.N5,
          ownerCorpId: 98000001 }], new Set([71])));
        assert.ok(lp.started.ok, JSON.stringify(lp.started));
        const m = mover(env, "r", [{ hullGroup: "frigate", count: 3 }]);
        const [row] = rowsOf(env);
        const res = lp.handlers[LS.EVENT_TYPE].fn(evOf(row), { now: now + 2 * 86400000 });
        assert.deepStrictEqual(settle(env, res).v, { ok: true, duplicate: false, pruned: 2, queued: false });
        assert.deepStrictEqual(env.q("SELECT fleet_id AS f, size_class AS c FROM world_post_sightings ORDER BY seen_at")
          .map((x) => [x.f, x.c]), [["old3", "small"], ["young", "small"], [m.fleetId, "small"]]);
        assert.strictEqual(lp.facade.getStatus().counters.pruned, 2);
        lp.facade.stop();
        const off = cfgOf(env, { enabled: false });
        assert.deepStrictEqual(boot(env, off, null).started, { ok: false, reason: "disabled_by_config" });
        const small = cfgOf(env, { pruneBatch: 500 });
        small.persistence.maxRowsPerTransaction = 300;
        assert.deepStrictEqual(boot(env, small, null).started, { ok: false, reason: "LISTENING_POST_ROW_BOUND",
          detail: "sighting effect=502 > persistence.maxRowsPerTransaction=300" });
        assert.deepStrictEqual(boot(env, cfgOf(env, { rangeJumps: 2 }), null).started,
          { ok: false, reason: "INVALID_CONFIG", detail: "listeningPost.rangeJumps" });
        const stub = createUnavailableListeningPosts("LISTENING_POST_DISABLED", "disabled_by_config");
        assert.deepStrictEqual(Object.keys(stub).sort(), [...FACADE_METHODS].sort());
        assert.deepStrictEqual([stub.getMode(), stub.getStatus().state], ["off", "unavailable"]);
      } finally {
        env.close();
      }
    });
};

Object.assign(module.exports, { harness: Object.freeze({ SETTINGS, cfgOf, fakeSentries, boot, mover, rowsOf, evOf,
  settle }) });
