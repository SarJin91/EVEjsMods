"use strict";

const assert = require("node:assert");

const { createViewRegistry } = require("../../../lib/observer/views");
const { planHousekeeping } = require("../../../lib/strategy/ai/housekeeping");
const { PANEL_OPEN_ROWS, PANEL_ENDED_ROWS } = require("../../../lib/strategy/expeditions/expeditionService");
const X = require("../../../lib/strategy/expeditions/schema");
const { harness: E } = require("./expeditionService.test");

const { boot, newFleet, planOne, pair, testConfig, H, S, SANSHA, J1, J2, PAIR_A, PAIR_B, PAIR_D, HOUR } = E;
const DECISION_MS = 2 * HOUR;

function housekeepingOf(env) {
  const at = env.shared.clock.now();
  const snap = env.tx((db) => {
    const l = env.fleets.repository.listFleetsByFaction(db, SANSHA, { limit: 50 });
    assert.ok(l.ok, JSON.stringify(l));
    const ops = db.prepare("SELECT operation_id, state, due_at, version FROM world_operations WHERE faction_id = ? "
      + "AND state IN ('PLANNED','ACTIVE') ORDER BY operation_id").all(SANSHA);
    return { at, sightings: [], fleetsTruncated: false,
      fleets: l.fleets.filter((f) => f.state !== "DESTROYED").map((f) => ({ fleetId: f.fleetId, state: f.state,
        operationId: f.operationId, refitPending: f.refitPending === true, version: f.version, legSeq: f.legSeq,
        systemId: f.currentSystemId })),
      operations: ops.map((o) => ({ operationId: o.operation_id, state: o.state, dueAt: o.due_at,
        version: o.version })) };
  });
  const hk = planHousekeeping(snap, { operationGraceMs: env.cfg.strategy.operationGraceMs,
    maxHousekeepingPerReview: env.cfg.strategy.maxHousekeepingPerReview,
    maxRefitRequestsPerReview: env.cfg.strategy.maxRefitRequestsPerReview });
  return { refit: hk.intents.filter((i) => i.type === "REQUEST_REFIT").map((i) => i.fleetId),
    close: hk.intents.filter((i) => i.type === "CLOSE_OPERATION").map((i) => [i.operationId, i.result.reason]) };
}

const openStep = (env, id) => env.q("SELECT * FROM world_scheduled_events WHERE event_type = ? AND aggregate_id = ? "
  + "AND state IN ('QUEUED','RETRY') ORDER BY due_at", X.STEP_EVENT, id)[0] || null;
const journalKeys = (env, prefix) => env.q("SELECT idempotency_key AS k FROM world_event_journal "
  + "WHERE idempotency_key LIKE ? ORDER BY idempotency_key", `${prefix}%`).map((r) => r.k);

const hasKey = (env, key) => env.n("SELECT count(*) AS n FROM world_event_journal WHERE idempotency_key = ?", key);

async function planOpen(env) {
  if (env.rows().every((r) => r.faction_id !== SANSHA)) return (await planOne(env)).exp;
  await env.drive(env.planRound() * env.cfg.expeditions.planPeriodMs);
  const rows = env.rows().filter((r) => r.faction_id === SANSHA && r.state !== "ENDED");
  assert.strictEqual(rows.length, 1, JSON.stringify(env.status()));
  return rows[0];
}

async function cutOffOne(env, pairs) {
  const C = env.cfg.expeditions;
  const exp = await planOpen(env);
  await env.drive(exp.arrive_at);
  assert.strictEqual(env.row(exp.expedition_id).state, "ACTIVE");
  pairs.list = [];
  env.sync();
  const cutAt = exp.arrive_at + C.stepIntervalMs;
  await env.drive(cutAt);
  const cut = env.row(exp.expedition_id);
  assert.strictEqual(cut.state, "CUT_OFF");
  return { exp, id: exp.expedition_id, cutAt, cut };
}

module.exports = ({ test, skip }) => {
  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  needsDriver("EC1 HOLD at the CUT_OFF entry: operation expedition/hold, fleet PLANNED, out of "
    + "REQUEST_REFIT; unhold + hold operation CANCELLED UNHOLD + EVACUATE RECOVERED, replay DUPLICATE; re-cut held "
    + "again, keeps cut_off_at / decision_at", () => H.withStore(
    driver, async (reopen) => {
      const shared = H.sharedOf();
      const pairs = { list: [pair(PAIR_A, S.N0, J1)] };
      const env = await boot(reopen(), shared, testConfig({ cutOffDecisionMs: DECISION_MS }), pairs);
      try {
        const C = env.cfg.expeditions;
        const f = newFleet(env, "s1", SANSHA, S.N0);
        const { id, cutAt, cut: h } = await cutOffOne(env, pairs);
        const fl = env.fleet(f);
        const op = env.fleets.getOperation(h.hold_operation_id).operation;
        const got = {};
        got.hold = [h.state, h.cut_off_at, h.decision_at, fl.state, fl.operationId === h.hold_operation_id,
          op.operationType, op.objective, op.originSystemId, op.targetSystemId, op.dueAt, op.state,
          openStep(env, id).due_at, env.status().counters.held, hasKey(env, `${X.stepKey(id, h.step_seq - 1)}:hold`)];
        const ctl = newFleet(env, "ctl", SANSHA, S.N0);
        env.tx((db) => db.prepare("UPDATE virtual_fleets SET refit_pending = 1 WHERE fleet_id IN (?, ?)").run(f, ctl));
        got.hk1 = housekeepingOf(env);
        env.tx((db) => db.prepare("UPDATE virtual_fleets SET refit_pending = 0 WHERE fleet_id IN (?, ?)").run(f, ctl));
        pairs.list = [pair(PAIR_D, S.N9, J1)];
        env.sync();
        const recAt = cutAt + C.cutOffRecheckMs;
        await env.drive(recAt - 1);
        const wev = env.asEvent(openStep(env, id));
        shared.clock.set(recAt);
        const wres = env.handlers[X.STEP_EVENT](wev, {});
        await env.drive(recAt);
        const r = env.row(id);
        const back = env.fleet(f);
        const holdOp = env.fleets.getOperation(h.hold_operation_id).operation;
        const wk = wev.idempotencyKey;
        got.recovered = [wres.outcome, r.state, r.evac_seq, back.state, back.targetSystemId,
          back.route.wormholeEdges.map((w) => w.pairKey), env.status().counters.recovered, hasKey(env, `${wk}:unhold`),
          holdOp.state, holdOp.result, hasKey(env, `${wk}:holdclose`)];
        const before = env.totals();
        got.replay = env.tx((db) => wres.effect(db, wev)).action;
        assert.deepStrictEqual(env.totals(), before);
        got.hk2 = housekeepingOf(env);
        await env.drive(recAt + Math.floor(back.route.jumpMs / 2));
        pairs.list = [];
        env.sync();
        await env.drive(openStep(env, id).due_at);
        const again = env.row(id);
        const fa = env.fleet(f);
        got.recut = [again.state, again.cut_off_at, again.decision_at, fa.currentSystemId, env.status().counters.cutOff,
          again.hold_operation_id !== h.hold_operation_id, fa.state, fa.operationId === again.hold_operation_id,
          env.status().counters.held];
        assert.deepStrictEqual(got, {
          hold: ["CUT_OFF", cutAt, cutAt + DECISION_MS, "PLANNED", true, "expedition", "hold", J1, J1,
            cutAt + DECISION_MS, "PLANNED", cutAt + C.cutOffRecheckMs, 1, 1],
          hk1: { refit: [ctl], close: [] },
          recovered: ["EVACUATE", "EVACUATING", 1, "TRAVELLING", S.N0, [PAIR_D], 1, 1, "CANCELLED",
            { closedBy: "expedition", reason: "UNHOLD" }, 1],
          replay: "DUPLICATE",
          hk2: { refit: [], close: [] },
          recut: ["CUT_OFF", cutAt, cutAt + DECISION_MS, J1, 2, true, "PLANNED", true, 2],
        });
      } finally {
        env.stop();
      }
    }));

  needsDriver("EC2 WRITE_OFF at decision_at: crash + restart, disband, ENDED LOST WRITTEN_OFF, 1 log line "
    + "keys once, replay DUPLICATE; plan limit freed; ENGAGED at the deadline -> WAIT, then WRITE_OFF",
  () => H.withStore(driver, async (reopen) => {
    const shared = H.sharedOf();
    const cfg = testConfig({ cutOffDecisionMs: DECISION_MS });
    const C = cfg.expeditions;
    const pairs = { list: [pair(PAIR_A, S.N0, J1)] };
    let env = await boot(reopen(), shared, cfg, pairs);
    try {
      const got = {};
      const f = newFleet(env, "s1", SANSHA, S.N0);
      const one = await cutOffOne(env, pairs);
      await env.drive(one.cutAt + C.cutOffRecheckMs);
      assert.strictEqual(env.fleet(f).state, "PLANNED");
      env.tx((db) => db.prepare("UPDATE virtual_fleets SET refit_pending = 1 WHERE fleet_id = ?").run(f));
      const decision = one.cut.decision_at;
      await env.drive(decision - 1);
      got.limitBefore = env.status().skipByReason.FACTION_LIMIT > 0;
      const row = openStep(env, one.id);
      shared.clock.set(decision);
      const ev = env.asEvent(row);
      const k = ev.idempotencyKey;
      const res = env.handlers[X.STEP_EVENT](ev, {});
      const stockOf = () => env.q("SELECT count(*) AS n, coalesce(sum(quantity), 0) AS q FROM world_station_stock")[0];
      const stock = stockOf();
      const crash = env.store.transaction("crash", (db) => {
        res.effect(db, ev);
        throw new Error("crash");
      });
      got.crash = [row.due_at, res.outcome, crash.ok, env.fleet(f).state, env.row(one.id).state,
        journalKeys(env, `${k}:`).length];
      env.stop();
      env.store.close("restart");
      env = await boot(reopen(), shared, cfg, pairs);
      const res2 = env.handlers[X.STEP_EVENT](ev, {});
      await env.drive(decision);
      const end = env.row(one.id);
      const dead = env.fleet(f);
      got.writeOff = [res2.outcome, end.state, end.outcome, end.end_reason, end.ended_at, dead.state, dead.shipCount,
        dead.refitPending, JSON.stringify(stockOf()) === JSON.stringify(stock), journalKeys(env, `${k}:`),
        env.lines.filter((l) => l.includes("written off")), env.status().counters.writtenOff,
        env.status().counters.lost, env.tx((db) => env.repo.countOpen(db, {})).count,
        env.fleets.getOperation(one.cut.hold_operation_id).operation.result];
      const before = env.totals();
      got.replay = [env.tx((db) => res2.effect(db, ev)).action, env.handlers[X.STEP_EVENT](ev, {}).outcome];
      assert.deepStrictEqual(env.totals(), before);
      const g = newFleet(env, "s2", SANSHA, S.N0);
      pairs.list = [pair(PAIR_A, S.N0, J1)];
      env.sync();
      const two = await cutOffOne(env, pairs);
      got.again = [two.exp.fleet_id === g, env.tx((db) => env.repo.countOpen(db, { factionId: SANSHA })).count];
      await env.drive(two.cutAt + C.cutOffRecheckMs);
      const v = env.fleet(g).version;
      const eng = env.fleets.transition({ fleetId: g, expectedVersion: v, from: "PLANNED", to: "ENGAGED", patch: {} },
        "test:engage");
      assert.ok(eng.ok, JSON.stringify(eng));
      const d2 = two.cut.decision_at;
      await env.drive(d2);
      const w = env.row(two.id);
      const waitEv = openStep(env, two.id);
      got.busy = [w.state, w.watch_round > 0, waitEv.due_at - d2, waitEv.idempotency_key
        === X.waitKey(two.id, w.step_seq, w.watch_round)];
      const stay = env.fleets.transition({ fleetId: g, expectedVersion: eng.version, from: "ENGAGED", to: "IDLE",
        patch: {} }, "test:stay");
      assert.ok(stay.ok, JSON.stringify(stay));
      await env.drive(d2 + C.cutOffRecheckMs);
      const e2 = env.row(two.id);
      got.second = [e2.state, e2.outcome, e2.end_reason, env.fleet(g).state,
        journalKeys(env, `${waitEv.idempotency_key}:`).map((x) => x.slice(waitEv.idempotency_key.length)),
        env.status().counters.writtenOff, env.fleets.getOperation(two.cut.hold_operation_id).operation.state];
      assert.deepStrictEqual(got, {
        limitBefore: true,
        crash: [decision, "WRITE_OFF", false, "PLANNED", "CUT_OFF", 0],
        writeOff: ["WRITE_OFF", "ENDED", "LOST", "WRITTEN_OFF", decision, "DESTROYED", 0, false, true,
          [`${k}:apply`, `${k}:holdclose`, `${k}:unhold`, `${k}:writeoff`],
          [`expeditions: ${one.id} fleet ${f} written off in ${J1} after cut-off since ${one.cutAt}`], 1, 1, 0,
          { closedBy: "expedition", reason: "WRITTEN_OFF" }],
        replay: ["DUPLICATE", "STALE"],
        again: [true, 1],
        busy: ["CUT_OFF", true, C.cutOffRecheckMs, true],
        second: ["ENDED", "LOST", "WRITTEN_OFF", "DESTROYED", [":apply", ":holdclose", ":writeoff"], 2,
          "CANCELLED"],
      });
    } finally {
      env.stop();
    }
  }));

  needsDriver("EC3 panel expeditions: off -> no view; empty; row shape; open limit + truncation; latest "
    + "ENDED first + limit; governor hold -> no read; stop -> unregistered",
  () => H.withStore(driver, async (reopen) => {
    const got = {};
    {
      const shared = H.sharedOf();
      const views = createViewRegistry();
      const env = await boot(reopen(), shared, testConfig(), { list: [] }, { views });
      try {
        got.off = [env.started.ok, views.getView("expeditions")];
      } finally {
        env.stop();
        env.store.close("next");
      }
    }
    const shared = H.sharedOf();
    const views = createViewRegistry();
    const env = await boot(reopen(), shared, testConfig({}), { list: [] }, { views });
    try {
      const view = views.getView("expeditions");
      got.def = [view.title, view.listed, view.mapLayer];
      const empty = view.getData();
      got.empty = [empty.available, empty.open, empty.ended, empty.openTruncated];
      const t0 = shared.clock.now();
      const n = PANEL_OPEN_ROWS + 2;
      const m = PANEL_ENDED_ROWS + 2;
      env.tx((db) => {
        for (let i = 0; i < n + m; i += 1) {
          const id = `wx_${String(i).padStart(3, "0")}`;
          const c = env.repo.createExpedition(db, { expeditionId: id, factionId: SANSHA, fleetId: `fleet_${i}`,
            operationId: `op_${i}`, originSystemId: S.N0, systemId: J2 + 100 + i, entryPairKey: PAIR_B, seed: i,
            plannedAt: t0, arriveAt: t0, evacuateAt: t0 + HOUR }, `test:${id}`);
          assert.ok(c.ok, JSON.stringify(c));
          if (i === 0) {
            const t = env.repo.transitionExpedition(db, { expeditionId: id, expectedVersion: 1, from: "PLANNED",
              to: "CUT_OFF", at: t0, patch: { cutOffAt: t0, decisionAt: t0 + DECISION_MS, presencePermille: 0,
                stepSeq: 1, watchRound: 0 } });
            assert.ok(t.ok, JSON.stringify(t));
            const hd = env.repo.transitionExpedition(db, { expeditionId: id, expectedVersion: 2, from: "CUT_OFF",
              to: "CUT_OFF", at: t0, patch: { holdOperationId: "op_hold", stepSeq: 2, watchRound: 0 } });
            assert.ok(hd.ok, JSON.stringify(hd));
          }
          if (i >= n) {
            const t = env.repo.transitionExpedition(db, { expeditionId: id, expectedVersion: 1, from: "PLANNED",
              to: "ENDED", at: t0 + i, patch: { outcome: "LOST", endReason: "WRITTEN_OFF", endedAt: t0 + i,
                presencePermille: 0 } });
            assert.ok(t.ok, JSON.stringify(t));
          }
        }
      });
      shared.clock.set(t0 + env.cfg.observer.journalCacheMs);
      const data = view.getData();
      got.counts = [data.available, data.open.length, data.openTruncated, data.ended.length];
      got.first = data.open[0];
      got.ended = [data.ended[0].id, data.ended[PANEL_ENDED_ROWS - 1].id, data.ended[0].result];
      got.firstWant = { id: "wx_000", faction: SANSHA, state: "CUT_OFF", system: J2 + 100, presence: 0,
        evacuateAt: t0 + HOUR, decisionAt: t0 + DECISION_MS, result: null, fleet: "fleet_0", hold: "op_hold",
        endedAt: null };
      env.ctx.governor = { admits: () => false };
      const held = view.getData();
      got.held = [held.available, held.reason, view.cacheKey()];
      env.ctx.governor = null;
      got.key = typeof view.cacheKey() === "string";
      env.ctx.expeditions.stop("test");
      got.stopped = views.getView("expeditions");
    } finally {
      env.stop();
    }
    assert.deepStrictEqual(got.first, got.firstWant);
    delete got.first;
    delete got.firstWant;
    const idOf = (i) => `wx_${String(i).padStart(3, "0")}`;
    const last = PANEL_OPEN_ROWS + 2 + PANEL_ENDED_ROWS + 1;
    assert.deepStrictEqual(got, {
      off: [false, null],
      def: ["Wormhole expeditions", true, null],
      empty: [true, [], [], false],
      counts: [true, PANEL_OPEN_ROWS, true, PANEL_ENDED_ROWS],
      ended: [idOf(last), idOf(last - PANEL_ENDED_ROWS + 1), "LOST/WRITTEN_OFF"],
      held: [false, "GOVERNOR_HOLD", null],
      key: true,
      stopped: null,
    });
  }));

  needsDriver("EC4 CUT_BEFORE_ENTRY releases the fleet and cancels the departure operation; fleet "
    + "version conflict -> refusal + retry, row conflict -> STALE", async () => {
    await H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const pairs = { list: [pair(PAIR_A, S.N0, J1)] };
      const env = await boot(reopen(), shared, testConfig({}), pairs);
      try {
        const f = newFleet(env, "s1", SANSHA, S.N0);
        const { at, exp } = await planOne(env);
        await env.drive(at + Math.floor(env.fleet(f).route.jumpMs / 2));
        pairs.list = [];
        env.sync();
        await env.drive(exp.arrive_at);
        const e = env.row(exp.expedition_id);
        const fl = env.fleet(f);
        const op = env.fleets.getOperation(exp.operation_id).operation;
        assert.deepStrictEqual([e.state, e.outcome, e.end_reason, fl.state, fl.operationId, fl.currentSystemId,
          op.state, op.result], ["ENDED", "CANCELLED", "CUT_BEFORE_ENTRY", "IDLE", null, S.N0, "CANCELLED",
          { closedBy: "expedition", reason: "CUT_BEFORE_ENTRY" }]);
      } finally {
        env.stop();
      }
    });
    await H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const pairs = { list: [pair(PAIR_A, S.N0, J1)] };
      const env = await boot(reopen(), shared, testConfig({}), pairs);
      try {
        const f = newFleet(env, "s1", SANSHA, S.N0);
        const exp = await planOpen(env);
        const id = exp.expedition_id;
        await env.drive(exp.arrive_at);
        pairs.list = [];
        env.sync();
        const row = openStep(env, id);
        await env.drive(row.due_at - 1);
        shared.clock.set(row.due_at);
        const ev = env.asEvent(row);
        const res = env.handlers[X.STEP_EVENT](ev, {});
        const fl = env.fleet(f);
        const moved = env.fleets.transition({ fleetId: f, expectedVersion: fl.version, from: "STAGED", to: "IDLE",
          patch: {} }, "test:idle");
        assert.ok(moved.ok, JSON.stringify(moved));
        const fleetConflict = env.tx((db) => res.effect(db, ev));
        const after1 = [env.fleet(f).state, env.row(id).state, env.row(id).hold_operation_id];
        const res2 = env.handlers[X.STEP_EVENT](ev, {});
        env.tx((db) => db.prepare("UPDATE world_wh_expeditions SET version = version + 1 WHERE expedition_id = ?")
          .run(id));
        const ops = env.totals().ops;
        const rowConflict = env.tx((db) => res2.effect(db, ev));
        const opsDelta = env.totals().ops - ops;
        await env.drive(row.due_at);
        const h = env.row(id);
        assert.deepStrictEqual([res.outcome, fleetConflict.ok, fleetConflict.reason, after1, rowConflict, opsDelta,
          h.state, h.hold_operation_id !== null, env.fleet(f).state], ["CUT_OFF", false, "VERSION_CONFLICT",
          ["IDLE", "ACTIVE", null], { ok: true, applied: false, action: "STALE" }, 0, "CUT_OFF", true, "PLANNED"]);
      } finally {
        env.stop();
      }
    });
  });

  needsDriver("EC5: an evacuation refused on the way into CUT_OFF holds the parked fleet in the "
    + "same effect; replay DUPLICATE; the hold survives a restart and the next step only waits",
  () => H.withStore(driver, async (reopen) => {
    const shared = H.sharedOf();
    const cfg = testConfig({});
    const C = cfg.expeditions;
    const pairs = { list: [pair(PAIR_A, S.N0, J1)] };
    let env = await boot(reopen(), shared, cfg, pairs);
    try {
      const got = {};
      const f = newFleet(env, "s1", SANSHA, S.N0);
      const exp = await planOpen(env);
      const id = exp.expedition_id;
      await env.drive(exp.arrive_at);
      const row = openStep(env, id);
      await env.drive(row.due_at - 1);
      shared.clock.set(row.due_at);
      const fl = env.fleet(f);
      const moved = env.fleets.transition({ fleetId: f, expectedVersion: fl.version, from: "STAGED", to: "IDLE",
        patch: {} }, "test:idle");
      assert.ok(moved.ok, JSON.stringify(moved));
      const ev = env.asEvent(row);
      const k = ev.idempotencyKey;
      const res = env.handlers[X.STEP_EVENT](ev, {});
      pairs.list = [];
      env.sync();
      const v = env.tx((db) => res.effect(db, ev));
      const c = env.row(id);
      const held = env.fleet(f);
      const op = env.fleets.getOperation(c.hold_operation_id).operation;
      got.entry = [res.outcome, v.action, v.reason, v.held, c.state, held.state,
        held.operationId === c.hold_operation_id, op.objective, op.dueAt === c.decision_at, hasKey(env, `${k}:hold`), hasKey(env, `${k}:evac`)];
      const before = env.totals();
      got.replay = env.tx((db) => res.effect(db, ev)).action;
      assert.deepStrictEqual(env.totals(), before);
      env.stop();
      env.store.close("restart");
      env = await boot(reopen(), shared, cfg, pairs);
      const r1 = env.fleet(f);
      got.restart = [r1.state, r1.operationId === c.hold_operation_id];
      await env.drive(row.due_at + C.cutOffRecheckMs);
      const w = env.row(id);
      const r2 = env.fleet(f);
      got.next = [w.state, w.watch_round, w.hold_operation_id === c.hold_operation_id, r2.state,
        r2.operationId === c.hold_operation_id];
      assert.deepStrictEqual(got, {
        entry: ["EVACUATE", "CUT_OFF", "UNREACHABLE", true, "CUT_OFF", "PLANNED", true, "hold", true, 1, 0],
        replay: "DUPLICATE",
        restart: ["PLANNED", true],
        next: ["CUT_OFF", 1, true, "PLANNED", true],
      });
    } finally {
      env.stop();
    }
  }));

  needsDriver("EC6: STAY + refused evacuation in CUT_OFF -> HOLD; STAY + no route -> "
    + "HOLD, old hold CANCELLED REHOLD; END FLEET_LOST / RETURNED out of CUT_OFF close the hold",
  () => H.withStore(driver, async (reopen) => {
    const shared = H.sharedOf();
    const cfg = testConfig({ cutOffDecisionMs: DECISION_MS });
    const C = cfg.expeditions;
    const pairs = { list: [pair(PAIR_A, S.N0, J1)] };
    const env = await boot(reopen(), shared, cfg, pairs);
    const battle = (fleetId, tag, to) => {
      const eng = env.fleets.transition({ fleetId, expectedVersion: env.fleet(fleetId).version, from: "PLANNED",
        to: "ENGAGED", patch: {} }, `test:${tag}:engage`);
      assert.ok(eng.ok, JSON.stringify(eng));
      const losses = env.fleet(fleetId).composition;
      const end = to === "DESTROYED"
        ? env.tx((db) => env.fleets.repository.applyLosses(db, { fleetId, expectedVersion: eng.version, losses },
          `test:${tag}:end`))
        : env.fleets.transition({ fleetId, expectedVersion: eng.version, from: "ENGAGED", to, patch: {} },
          `test:${tag}:end`);
      assert.ok(end.ok, JSON.stringify(end));
      assert.strictEqual(env.fleet(fleetId).state, to);
    };
    const opOf = (id) => env.fleets.getOperation(id).operation;
    const stepNow = async (id) => {
      const row = openStep(env, id);
      await env.drive(row.due_at);
      return row.idempotency_key;
    };
    try {
      const got = {};
      const f = newFleet(env, "s1", SANSHA, S.N0);
      const { id, cut: h1 } = await cutOffOne(env, pairs);
      battle(f, "a", "IDLE");
      pairs.list = [pair(PAIR_D, S.N9, J1)];
      env.sync();
      const row = openStep(env, id);
      await env.drive(row.due_at - 1);
      shared.clock.set(row.due_at);
      const ev = env.asEvent(row);
      const k = ev.idempotencyKey;
      const res = env.handlers[X.STEP_EVENT](ev, {});
      pairs.list = [];
      env.sync();
      const v = env.tx((db) => res.effect(db, ev));
      await env.drive(row.due_at);
      const a = env.row(id);
      const fa = env.fleet(f);
      got.low3 = [res.outcome, v.action, v.reason, v.held, a.state, a.decision_at, fa.state,
        fa.operationId === a.hold_operation_id, a.hold_operation_id !== h1.hold_operation_id,
        opOf(a.hold_operation_id).dueAt === a.decision_at, opOf(h1.hold_operation_id).state,
        opOf(h1.hold_operation_id).result, hasKey(env, `${k}:evac`), hasKey(env, `${k}:hold`),
        hasKey(env, `${k}:holdclose`), openStep(env, id).due_at - row.due_at];
      battle(f, "b", "IDLE");
      const kb = await stepNow(id);
      const b = env.row(id);
      const fb = env.fleet(f);
      got.rehold = [b.hold_operation_id !== a.hold_operation_id, fb.state, fb.operationId === b.hold_operation_id,
        opOf(a.hold_operation_id).state, opOf(a.hold_operation_id).result, hasKey(env, `${kb}:holdclose`),
        hasKey(env, `${kb}:hold`)];
      battle(f, "c", "DESTROYED");
      const kc = await stepNow(id);
      const c = env.row(id);
      got.lost = [c.state, c.outcome, c.end_reason, env.fleet(f).operationId === b.hold_operation_id,
        opOf(b.hold_operation_id).state, opOf(b.hold_operation_id).result, hasKey(env, `${kc}:holdclose`)];
      const g = newFleet(env, "s2", SANSHA, S.N0);
      pairs.list = [pair(PAIR_A, S.N0, J1)];
      env.sync();
      const two = await cutOffOne(env, pairs);
      battle(g, "d", "IDLE");
      env.tx((db) => db.prepare("UPDATE virtual_fleets SET current_system_id = ? WHERE fleet_id = ?").run(S.N0, g));
      const kd = await stepNow(two.id);
      const d = env.row(two.id);
      got.returned = [two.exp.fleet_id === g, d.state, d.outcome, d.end_reason, opOf(two.cut.hold_operation_id).state,
        opOf(two.cut.hold_operation_id).result, hasKey(env, `${kd}:holdclose`)];
      const reason = (r) => ({ closedBy: "expedition", reason: r });
      assert.deepStrictEqual(got, {
        low3: ["EVACUATE", "HOLD", "UNREACHABLE", true, "CUT_OFF", h1.decision_at, "PLANNED", true, true, true,
          "CANCELLED", reason("REHOLD"), 0, 1, 1, C.cutOffRecheckMs],
        rehold: [true, "PLANNED", true, "CANCELLED", reason("REHOLD"), 1, 1],
        lost: ["ENDED", "LOST", "FLEET_LOST", true, "CANCELLED", reason("FLEET_LOST"), 1],
        returned: [true, "ENDED", "RETURNED", "RETURNED", "CANCELLED", reason("RETURNED"), 1],
      });
    } finally {
      env.stop();
    }
  }));

  needsDriver("EC7 held fleet + refused evacuation -> WAIT, hold kept; STAY + refused "
    + "evacuation at decision_at -> HOLD, next step at + cutOffRecheckMs (03d)",
  () => H.withStore(driver, async (reopen) => {
    const shared = H.sharedOf();
    const cfg = testConfig({ cutOffDecisionMs: DECISION_MS });
    const C = cfg.expeditions;
    const pairs = { list: [pair(PAIR_A, S.N0, J1)] };
    const env = await boot(reopen(), shared, cfg, pairs);
    const opOf = (id) => env.fleets.getOperation(id).operation;
    const refusedStep = (row) => {
      shared.clock.set(row.due_at);
      pairs.list = [pair(PAIR_D, S.N9, J1)];
      env.sync();
      const ev = env.asEvent(row);
      const res = env.handlers[X.STEP_EVENT](ev, {});
      pairs.list = [];
      env.sync();
      return { k: ev.idempotencyKey, res, v: env.tx((db) => res.effect(db, ev)) };
    };
    try {
      const got = {};
      const f = newFleet(env, "s1", SANSHA, S.N0);
      const { id, cut } = await cutOffOne(env, pairs);
      const row = openStep(env, id);
      await env.drive(row.due_at - 1);
      const a = refusedStep(row);
      await env.drive(row.due_at);
      const ra = env.row(id);
      const fa = env.fleet(f);
      got.held = [a.res.outcome, a.v.action, ra.state, ra.decision_at === cut.decision_at,
        ra.hold_operation_id === cut.hold_operation_id, fa.state, fa.operationId === cut.hold_operation_id,
        opOf(cut.hold_operation_id).state, hasKey(env, `${a.k}:unhold`), hasKey(env, `${a.k}:holdclose`),
        hasKey(env, `${a.k}:evac`)];
      let next = openStep(env, id);
      while (next.due_at < cut.decision_at) {
        await env.drive(next.due_at);
        next = openStep(env, id);
      }
      const eng = env.fleets.transition({ fleetId: f, expectedVersion: env.fleet(f).version, from: "PLANNED",
        to: "ENGAGED", patch: {} }, "test:b:engage");
      assert.ok(eng.ok, JSON.stringify(eng));
      const stay = env.fleets.transition({ fleetId: f, expectedVersion: eng.version, from: "ENGAGED", to: "IDLE",
        patch: {} }, "test:b:end");
      assert.ok(stay.ok, JSON.stringify(stay));
      await env.drive(next.due_at - 1);
      const b = refusedStep(next);
      await env.drive(next.due_at);
      const rb = env.row(id);
      const fb = env.fleet(f);
      got.late = [next.due_at >= cut.decision_at, b.res.outcome, b.v.action, rb.state, fb.state,
        fb.operationId === rb.hold_operation_id, rb.hold_operation_id !== cut.hold_operation_id,
        openStep(env, id).due_at - next.due_at];
      assert.deepStrictEqual(got, {
        held: ["EVACUATE", "WAIT", "CUT_OFF", true, true, "PLANNED", true, "PLANNED", 0, 0, 0],
        late: [true, "EVACUATE", "HOLD", "CUT_OFF", "PLANNED", true, true, C.cutOffRecheckMs],
      });
    } finally {
      env.stop();
    }
  }));
};
