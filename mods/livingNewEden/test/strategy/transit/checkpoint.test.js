"use strict";

const assert = require("node:assert");
const path = require("node:path");

const config = require("../../../config");
const { startTransit } = require("../../../lib/strategy/transit");
const { createRiskIndex } = require("../../../lib/strategy/transit/riskIndex");
const { createTransitService, checkpointKey, haltKeyOf, battleKeyOf, budgetKeyOf,
  CHECKPOINT_EVENT } = require("../../../lib/strategy/transit/service");
const { picketDefensesOf } = require("../../../lib/strategy/transit/rules");
const { pairKeyOf } = require("../../../lib/battle/contacts");
const { lazySentriesConsequence } = require("../../../lib/battle");
const { createUnavailablePresence } = require("../../../lib/presence");
const { rowBoundsOfConfig, BOUND_NAMES } = require("../../../lib/strategy/reviewBound");
const { transitTxRowsOf } = require("../../../lib/strategy/reviewRows");
const { startWorld } = require("../../../lib/world");
const { startScheduler } = require("../../../lib/scheduler");
const { createJournal } = require("../../../lib/persistence/journal");
const seams = require("../../../lib/adapter/sentrySeams");
const { startSentries } = require("../../../lib/sentries");
const { harness: H } = require("../../battle/settlement.test");
const { harness: C } = require("../../battle/contacts.test");
const { fakeVendor } = require("../../sentries/factionSentries.test");

const MOD_DIR = path.resolve(__dirname, "..", "..", "..");
const S = H.S;
const DEATHLESS = 500029;
const HOUR = 3600000;
const WORLD_SEED = 11;
const AVOID = Object.freeze({ avoidSecClasses: ["highsec", "lowsec"] });
const TEN = Object.freeze([{ hullGroup: "cruiser", count: 10 }]);
const SURE = Object.freeze({ basePermille: 1000, maxChancePermille: 1000 });
const NEVER = Object.freeze({ basePermille: 0, controlPermille: 0 });

function cfgOf(env, transit = {}) {
  const c = JSON.parse(JSON.stringify(env.cfg));
  c.modules.strategy = { enabled: true };
  c.persistence.maxRowsPerTransaction = 1100;
  c.transit = { ...c.transit, enabled: true, mode: "on", ...transit };
  return c;
}

const sysRow = (systemId, controllerFactionId = DEATHLESS, influence = 0) => ({ systemId, securityClass: "nullsec",
  controllerFactionId, influence: [{ systemId, factionId: controllerFactionId, influenceScore: influence,
    garrisonStrength: 0 }] });

function fakeWorld(rows) {
  const byId = new Map(rows.map((r) => [r.systemId, r]));
  const sorted = [...rows].sort((a, b) => a.systemId - b.systemId);
  return { getStatus: () => ({ state: "ready" }), listSystems(opts) {
    const page = sorted.filter((r) => r.systemId > opts.afterSystemId).slice(0, opts.limit);
    return { ok: true, systems: page, nextAfterSystemId: page.length === opts.limit ? page[page.length - 1].systemId
      : null };
  }, repository: {
    getSystem: (_tx, id) => ({ ok: true, system: byId.get(id) || null }),
    getSystems: (_tx, ids) => ({ ok: true, systems: ids.map((id) => byId.get(id)).filter(Boolean),
      missing: ids.filter((id) => !byId.has(id)) }),
  } };
}

function fakeTimers() {
  const list = [];
  return { list, setTimer(fn, ms) {
    const t = { fn, ms, cancelled: false };
    list.push(t);
    return { cancel: () => {
      t.cancelled = true;
    }, hasRef: () => false };
  }, run() {
    for (const t of list.filter((x) => !x.cancelled && !x.fired)) {
      t.fired = true;
      t.cancelled = true;
      t.fn();
    }
  } };
}

function boot(env, cfg, world, holder = {}) {
  const handlers = {};
  const listeners = [];
  const scheduler = { ...env.scheduler, registerHandler: (type, fn, o) => {
    handlers[type] = { fn, opts: o };
    return env.scheduler.registerHandler(type, fn, o);
  }, ...(holder.scanKeys ? { scanKeys: holder.scanKeys } : {}) };
  const travel = { ...env.fleets.travel, addDepartureListener: (fn) => {
    listeners.push(fn);
    return env.fleets.travel.addDepartureListener(fn);
  } };
  const timers = fakeTimers();
  const lines = [];
  const started = startTransit({ config: cfg, persistence: { ok: true, store: env.store, journal: env.journal,
    worldSeed: WORLD_SEED }, scheduler, fleets: { ...env.fleets, travel }, world, logger: { log: (l) => lines.push(l) },
  setTimer: timers.setTimer, getBattle: () => (holder.battle === undefined ? env.battle : holder.battle),
  getPresence: () => holder.presence || null });
  if (started.ok) timers.run();
  const run = (ev) => handlers[CHECKPOINT_EVENT].fn(ev, {});
  return { started, handlers, listeners, lines, run, facade: started.ok ? started.transit : null };
}

function opFleet(env, tag, factionId, fleetRole = "invasion", composition = TEN) {
  const r = env.fleets.createFleet({ factionId, currentSystemId: S.N0, homeSystemId: S.N0, fleetRole,
    composition: composition.map((e) => ({ ...e })) }, `t:f:${tag}`);
  assert.ok(r.ok, JSON.stringify(r));
  const op = env.fleets.createOperation({ operationType: "invasion", factionId, originSystemId: S.N0,
    targetSystemId: S.N9, objective: "capture", dueAt: env.clock.now() + HOUR,
    fleets: [{ fleetId: r.fleetId, expectedVersion: env.fleet(r.fleetId).version }] }, `t:op:${tag}`);
  assert.ok(op.ok, JSON.stringify(op));
  return r.fleetId;
}

function mover(env, tag, factionId, fleetRole) {
  const fleetId = opFleet(env, tag, factionId, fleetRole);
  const plan = env.fleets.planTravel({ fleetId, targetSystemId: S.N9, constraints: AVOID }, `t:plan:${tag}`);
  assert.ok(plan.ok, JSON.stringify(plan));
  return { fleetId, plan };
}

const rowsOf = (env) => env.q("SELECT idempotency_key, aggregate_id, due_at, payload, state, outcome "
  + "FROM world_scheduled_events WHERE event_type = ? ORDER BY due_at, idempotency_key", CHECKPOINT_EVENT)
  .map((r) => ({ ...r, payload: JSON.parse(r.payload) }));
const rowOf = (env, fleetId, systemId) => rowsOf(env).find((r) => r.payload.fleetId === fleetId
  && (systemId === undefined || r.payload.systemId === systemId));
const evOf = (row) => ({ eventType: CHECKPOINT_EVENT, idempotencyKey: row.idempotency_key, payload: row.payload,
  dueAt: row.due_at, aggregateId: row.aggregate_id });
const found = (env, key) => env.store.transaction("t.find", (db) => env.journal.findByKey(db, key)).value;

function settle(env, res, ev) {
  let v;
  if (typeof res.effect === "function") {
    const tx = env.store.transaction("t.effect", (db) => {
      v = res.effect(db, ev);
      if (v && v.ok === false) throw new Error("rollback");
      return v;
    });
    if (!tx.ok) return { committed: false, v };
  }
  if (typeof res.onCommitted === "function") res.onCommitted(v);
  return { committed: true, v };
}

const WORLD = () => fakeWorld([sysRow(S.N5), sysRow(S.N6), sysRow(S.N7)]);

module.exports = ({ test, skip }) => {
  const driver = H.loadDriver();
  const t = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  t("TR8 HALT PICKET: one row per leg, exact payload; stop + one VIRTUAL battle with tp: + :hit + trn:hb:; replay = "
    + "DUPLICATE; a refused battle rolls the whole effect back", () => {
    const env = C.createEnv(driver);
    try {
      const holder = {};
      const cfg = cfgOf(env, SURE);
      const tr = boot(env, cfg, WORLD(), holder);
      assert.ok(tr.started.ok, JSON.stringify(tr.started));
      assert.deepStrictEqual([tr.facade.getMode(), tr.listeners.length, tr.handlers[CHECKPOINT_EVENT].opts,
        tr.facade.getStatus().index.state], ["on", 1, { maxPerPass: 32 }, "warm"]);
      assert.ok(tr.lines[0].startsWith("transit: mode=on handler=on secClasses=nullsec "), tr.lines[0]);
      assert.ok(tr.lines[0].endsWith(" budget=2 halts/h=6"), tr.lines[0]);
      const m = mover(env, "halt", C.SANSHA);
      const r2 = mover(env, "refused", C.SANSHA);
      const at = m.plan.departAt + m.plan.jumpMs;
      const key = checkpointKey(S.N5, m.fleetId, m.plan.legSeq);
      assert.strictEqual(key, `transit:${S.N5}:x:${m.fleetId}:${m.plan.legSeq}`);
      const row = rowOf(env, m.fleetId);
      assert.deepStrictEqual([row.idempotency_key, row.aggregate_id, row.due_at, row.state],
        [key, String(S.N5), at, "QUEUED"]);
      assert.deepStrictEqual(row.payload, { at, check: 0, fleetId: m.fleetId, legSeq: m.plan.legSeq, systemId: S.N5,
        systemIndex: 1 });
      assert.strictEqual(rowsOf(env).length, 2, "one row per leg");
      env.clock.set(at);

      holder.battle = { getStatus: () => ({ state: "ready" }), readCooldownsInTx: env.battle.readCooldownsInTx,
        createFixedDefenseBattleInTx: () => ({ ok: false, reason: "GRAPH_NOT_READY" }) };
      const evR = evOf(rowOf(env, r2.fleetId));
      const resR = tr.run(evR);
      assert.deepStrictEqual([resR.outcome], ["HALT"], JSON.stringify(resR));
      const sr = settle(env, resR, evR);
      assert.deepStrictEqual([sr.committed, sr.v.reason], [false, "GRAPH_NOT_READY"]);
      const hitR = `${evR.idempotencyKey}:hit`;
      const markR = budgetKeyOf(DEATHLESS, Math.floor(at / HOUR), r2.fleetId, r2.plan.legSeq);
      assert.deepStrictEqual([env.fleet(r2.fleetId).state, found(env, hitR).found, found(env, haltKeyOf(hitR)).found,
        found(env, markR).found, env.battles().length], ["TRAVELLING", false, false, false, 0]);
      holder.battle = undefined;

      const ev = evOf(row);
      const res = tr.run(ev);
      assert.deepStrictEqual([res.ok, res.outcome], [true, "HALT"], JSON.stringify(res));
      const s = settle(env, res, ev);
      assert.deepStrictEqual([s.committed, s.v.applied, s.v.kind, s.v.systemId], [true, true, "PICKET", S.N5]);
      const f = env.fleet(m.fleetId);
      assert.deepStrictEqual([f.state, f.currentSystemId, f.legSeq], ["ENGAGED", S.N5, m.plan.legSeq]);
      const hit = `${key}:hit`;
      assert.ok(found(env, haltKeyOf(hit)).found && /^tsh:[0-9a-f]{40}$/.test(haltKeyOf(hit)));
      const entry = found(env, hit).entry;
      assert.deepStrictEqual(entry.payload, { ...row.payload, outcome: "HALT", kind: "PICKET", roll: entry.payload.roll,
        chancePermille: 1000, controllerFactionId: DEATHLESS, battleKey: battleKeyOf(hit) });
      assert.strictEqual(found(env, budgetKeyOf(DEATHLESS, Math.floor(at / HOUR), m.fleetId, m.plan.legSeq)).found,
        true);
      const battles = env.battles();
      assert.deepStrictEqual(battles.map((b) => [b.battle_id, b.idempotency_key, b.system_id, b.state, b.hold_reason]),
        [[s.v.battleId, battleKeyOf(hit), S.N5, "PENDING", "LIVE_UNSUPPORTED"]]);
      const input = JSON.parse(battles[0].input_json);
      const S2 = { ...cfg.transit };
      const expected = picketDefensesOf(S.N5, DEATHLESS, 1000, S2);
      assert.deepStrictEqual(input.fixedDefenses, { attackerRetreatLossPermille: 150, entries: [...expected.entries]
        .sort((a, b) => (a.sentryId < b.sentryId ? -1 : 1)) });
      assert.strictEqual(input.fixedDefenses.entries.length, 8);
      assert.ok(input.fixedDefenses.entries.every((e) => e.sentryId.startsWith(`tp:${S.N5}:`)));

      assert.deepStrictEqual(env.store.transaction("t.again", (db) => res.effect(db, ev)).value,
        { ok: true, applied: false, action: "DUPLICATE" });
      const late = tr.run(ev);
      assert.deepStrictEqual([late.outcome, late.effect], ["STALE", undefined]);
      late.onCommitted();
      assert.strictEqual(env.battles().length, 1);
      const st = tr.facade.getStatus();
      assert.deepStrictEqual([st.counters.halts, st.counters.haltsPicket, st.counters.battlesCreated,
        st.counters.haltRefused, st.staleByReason.LEG_MOVED, st.counters.legsPassed],
      [1, 1, 1, 1, 1, 1]);
      tr.facade.stop();
    } finally {
      env.close();
    }
  });

  t("TR8s sentries battleConsequence skips the tp: entries (battleTransitSkipped 1, battleFortressSkipped 0)", () =>
    H.withStore(driver, async (reopen) => {
      const opened = reopen();
      const shared = H.sharedOf();
      const cfg = { ...H.CONFIG, modules: { ...H.CONFIG.modules, strategy: { enabled: true } },
        sentries: { ...C.testConfig().sentries, enabled: true, battle: { ...C.testConfig().sentries.battle,
          enabled: true } } };
      const journal = createJournal({ clock: shared.clock, maxPayloadBytes: 16384, maxRows: 500 });
      const sr = startScheduler({ config: cfg, persistence: { ok: true, store: opened.store }, clock: shared.clock,
        ids: shared.ids, nowMs: () => 0 });
      assert.ok(sr.ok, JSON.stringify(sr));
      const v = fakeVendor();
      const seam = seams.createSentrySeam({ requireGame: (rel) => ({ ok: true, exports: v.modules[rel] }) });
      const started = startSentries({ config: cfg, persistence: { ok: true, store: opened.store, journal },
        clock: shared.clock, scheduler: sr.scheduler,
        adapter: { sentrySeams: () => ({ ok: true, seam, optional: {} }), bindSentryPolicy: () => ({ ok: true }) },
        graph: { getGraph: () => ({ ok: true, graph: { getSystem: (id) => ({ systemId: id, secClass: "nullsec" }) } }) } });
      assert.ok(started.ok, JSON.stringify(started));
      const cons = lazySentriesConsequence(() => started.sentries);
      const picket = picketDefensesOf(S.N5, DEATHLESS, 120, { ...C.testConfig().transit }).entries
        .map((e) => ({ sentryId: e.sentryId, itemId: e.itemId, hp: e.hp, ehp: e.ehp, damage: 1000, destroyed: false }));
      const r = opened.store.transaction("t", (db) => cons.apply(db, { battleId: "b-tp", systemId: S.N5,
        at: shared.clock.now(), fixedDefenses: picket }, "b-tp:c:sentries")).value;
      assert.deepStrictEqual(r, { ok: true, skipped: true });
      const c = started.service.getStatus().counters;
      assert.deepStrictEqual([c.battleTransitSkipped, c.battleFortressSkipped], [1, 0]);
      started.sentries.stop("test");
      sr.scheduler.stop("test");
    }));

  t("TR9 CONTACT with a controller garrison (no fixed defense battle, a contact check row); a hunter -> PICKET; PASS "
    + "chains N5 -> N6 -> N7 -> legsPassed; maxChecksPerLeg 1 -> chainCut", () => {
    const env = C.createEnv(driver);
    try {
      const tr = boot(env, cfgOf(env, { ...SURE, evasiveRolePermille: 1000 }), WORLD());
      assert.ok(tr.started.ok, JSON.stringify(tr.started));
      const g = env.fleets.createFleet({ factionId: DEATHLESS, currentSystemId: S.N5, homeSystemId: S.N5,
        fleetRole: "garrison", composition: TEN.map((e) => ({ ...e })) }, "t:garrison");
      assert.ok(g.ok, JSON.stringify(g));
      const m = mover(env, "contact", C.SANSHA);
      const h = mover(env, "hunter", C.SANSHA, "hunter");
      env.clock.set(m.plan.departAt + m.plan.jumpMs);
      const before = env.n("SELECT count(*) AS n FROM world_scheduled_events WHERE event_type = 'BATTLE_CONTACT_CHECK'");
      const ev = evOf(rowOf(env, m.fleetId));
      const res = tr.run(ev);
      const s = settle(env, res, ev);
      assert.deepStrictEqual([res.outcome, s.v.kind, s.v.battleId, env.fleet(m.fleetId).state,
        env.fleet(m.fleetId).currentSystemId, env.battles().length], ["HALT", "CONTACT", null, "STAGED", S.N5, 0]);
      assert.strictEqual(found(env, `${ev.idempotencyKey}:hit`).entry.payload.battleKey, null);
      assert.ok(env.n("SELECT count(*) AS n FROM world_scheduled_events WHERE event_type = 'BATTLE_CONTACT_CHECK'")
        > before, "the arrival of the stop queued a contact check");
      const evH = evOf(rowOf(env, h.fleetId));
      const sH = settle(env, tr.run(evH), evH);
      assert.deepStrictEqual([sH.v.kind, env.battles().length], ["PICKET", 1]);
      const st = tr.facade.getStatus().counters;
      assert.deepStrictEqual([st.halts, st.haltsContact, st.haltsPicket, st.battlesCreated], [2, 1, 1, 1]);
      tr.facade.stop();
    } finally {
      env.close();
    }

    const env2 = C.createEnv(driver);
    try {
      const tr = boot(env2, cfgOf(env2, NEVER), WORLD());
      assert.ok(tr.started.ok, JSON.stringify(tr.started));
      const m = mover(env2, "pass", C.SANSHA);
      env2.clock.set(m.plan.departAt + 3 * m.plan.jumpMs);
      for (const [sys, check] of [[S.N5, 0], [S.N6, 1], [S.N7, 2]]) {
        const row = rowOf(env2, m.fleetId, sys);
        assert.ok(row, `row of ${sys}`);
        assert.strictEqual(row.payload.check, check);
        const res = tr.run(evOf(row));
        assert.strictEqual(res.outcome, "PASS", JSON.stringify(res));
        settle(env2, res, evOf(row));
      }
      const c = tr.facade.getStatus().counters;
      assert.deepStrictEqual([c.checks, c.passed, c.chainQueued, c.legsPassed, c.legsPassed5plus, c.chainCut],
        [3, 3, 2, 1, 0, 0]);
      tr.facade.stop();
      const one = boot(env2, cfgOf(env2, { ...NEVER, maxChecksPerLeg: 1 }), WORLD());
      assert.ok(one.started.ok, JSON.stringify(one.started));
      const m1 = mover(env2, "cut", C.SANSHA);
      const row = rowOf(env2, m1.fleetId);
      settle(env2, one.run(evOf(row)), evOf(row));
      assert.deepStrictEqual([rowsOf(env2).filter((r) => r.payload.fleetId === m1.fleetId).length,
        one.facade.getStatus().counters.chainCut, one.facade.getStatus().counters.legsPassed], [1, 1, 1]);
      one.facade.stop();
    } finally {
      env2.close();
    }
  });

  t("TR10 budgets and gates: listenerBudgetPass; haltsPerControllerHour BUDGET + chain, another hour HALT; COOLDOWN; "
    + "OBSERVED; interceptInTx STALE_LEG -> STALE without a write", () => {
    const env = C.createEnv(driver);
    try {
      const holder = {};
      const tr = boot(env, cfgOf(env, { ...SURE, maxCheckpointsPerTransaction: 1, haltsPerControllerHour: 1 }),
        WORLD(), holder);
      assert.ok(tr.started.ok, JSON.stringify(tr.started));
      const pair = [opFleet(env, "two-a", C.SANSHA), opFleet(env, "two-b", C.SANSHA)];
      const two = env.store.transaction("t.two", (db) => pair.map((id) => env.fleets.travel.planInTx(db,
        { fleetId: id, targetSystemId: S.N9, constraints: AVOID }, `t:plan:${id}`)));
      assert.ok(two.ok && two.value.every((p) => p.ok === true), JSON.stringify(two));
      assert.deepStrictEqual(rowsOf(env).map((r) => r.payload.fleetId), [pair[0]]);
      assert.deepStrictEqual([tr.facade.getStatus().counters.listenerBudgetPass, tr.facade.getStatus().lastRefusal],
        [1, "BUDGET"]);

      const a = mover(env, "a", C.SANSHA);
      const b = mover(env, "b", C.SANSHA);
      env.clock.set(a.plan.departAt + a.plan.jumpMs);
      const evA = evOf(rowOf(env, a.fleetId));
      assert.strictEqual(settle(env, tr.run(evA), evA).v.applied, true);
      const evB = evOf(rowOf(env, b.fleetId));
      const resB = tr.run(evB);
      assert.strictEqual(resB.outcome, "BUDGET");
      settle(env, resB, evB);
      assert.deepStrictEqual(rowOf(env, b.fleetId, S.N6).payload.check, 1);
      env.clock.set(Math.ceil((a.plan.departAt + 1) / HOUR) * HOUR + 1);
      const c = mover(env, "c", C.SANSHA);
      env.clock.set(c.plan.departAt + c.plan.jumpMs);
      const evC = evOf(rowOf(env, c.fleetId));
      assert.notStrictEqual(Math.floor(evC.payload.at / HOUR), Math.floor(evA.payload.at / HOUR));
      assert.strictEqual(tr.run(evC).outcome, "HALT");
      assert.strictEqual(tr.facade.getStatus().counters.budgetPass, 1);

      const d = mover(env, "d", C.SANSHA);
      env.clock.set(d.plan.departAt + d.plan.jumpMs);
      const evD = evOf(rowOf(env, d.fleetId));
      holder.battle = { ...env.battle, readCooldownsInTx: () => ({ ok: true, cooldowns: new Map([[pairKeyOf(DEATHLESS,
        C.SANSHA), Number.MAX_SAFE_INTEGER]]) }) };
      assert.strictEqual(tr.run(evD).outcome, "COOLDOWN");
      holder.battle = undefined;
      holder.presence = { distanceToObserved: (systemId, radius) => ({ ok: true, distance: systemId === S.N5
        && radius === 0 ? 0 : null }) };
      assert.strictEqual(tr.run(evD).outcome, "OBSERVED");
      holder.presence = createUnavailablePresence("t");

      const res = tr.run(evC);
      const version = env.fleet(c.fleetId).version;
      const other = env.store.transaction("t.other", (db) => env.fleets.travel.interceptInTx(db, { fleetId: c.fleetId,
        expectedVersion: version, legSeq: c.plan.legSeq, systemIndex: 1, at: evC.payload.at },
      "t:other-stop", { chained: true }));
      assert.ok(other.ok && other.value.ok, JSON.stringify(other));
      const s = settle(env, res, evC);
      assert.deepStrictEqual(s.v, { ok: true, applied: false, action: "STALE", reason: "STALE_LEG" });
      assert.strictEqual(found(env, `${evC.idempotencyKey}:hit`).found, false);
      assert.strictEqual(tr.facade.getStatus().staleByReason.STALE_LEG, 1);
      tr.facade.stop();
    } finally {
      env.close();
    }
  });

  t("TR11 start: mode on on the real facades; enabled off + open row -> drain (STALE OFF, no chain, no listener); no "
    + "row -> disabled_by_config; TRANSIT_ROW_BOUND; W62 W64 W138 W139; failed seed -> warm degraded index", async () => {
    const env = C.createEnv(driver);
    try {
      const wr = startWorld({ config: env.cfg, persistence: { ok: true, store: env.store, journal: env.journal },
        clock: env.clock });
      assert.ok(wr.ok, JSON.stringify(wr));
      try {
        const real = boot(env, cfgOf(env), wr.world);
        assert.ok(real.started.ok, JSON.stringify(real.started));
        assert.deepStrictEqual([real.facade.getMode(), real.listeners.length, Object.keys(real.handlers)],
          ["on", 1, [CHECKPOINT_EVENT]]);
        real.facade.stop();
      } finally {
        wr.world.stop("test");
      }
      assert.deepStrictEqual([transitTxRowsOf(cfgOf(env)), transitTxRowsOf(cfgOf(env, { mode: "observe" })),
        transitTxRowsOf(cfgOf(env, { enabled: false }))], [2, 0, 0]);

      const on = boot(env, cfgOf(env, SURE), WORLD());
      const m = mover(env, "drain", C.SANSHA);
      on.facade.stop();
      const dr = boot(env, cfgOf(env, { enabled: false }), WORLD());
      assert.ok(dr.started.ok, JSON.stringify(dr.started));
      assert.deepStrictEqual([dr.facade.getMode(), dr.listeners.length, Object.keys(dr.handlers),
        dr.facade.getStatus().listeners, dr.facade.getStatus().index], ["drain", 0, [CHECKPOINT_EVENT], 0, null]);
      assert.deepStrictEqual(dr.lines, ["transit: mode=drain handler=drain"]);
      await env.drive(m.plan.departAt + m.plan.jumpMs);
      const rows = rowsOf(env);
      assert.deepStrictEqual(rows.map((r) => [r.state, r.outcome]), [["DONE", "STALE"]]);
      const st = dr.facade.getStatus();
      assert.deepStrictEqual([st.counters.drained, st.staleByReason.OFF, env.fleet(m.fleetId).state],
        [1, 1, "TRAVELLING"]);
      dr.facade.stop();
      const none = boot(env, cfgOf(env, { enabled: false }), WORLD());
      assert.deepStrictEqual([none.started, Object.keys(none.handlers)], [{ ok: false, reason: "disabled_by_config" },
        []]);
      const on2 = boot(env, cfgOf(env, SURE), WORLD());
      mover(env, "drain2", C.SANSHA);
      on2.facade.stop();
      const obs = boot(env, cfgOf(env, { mode: "observe" }), WORLD());
      assert.deepStrictEqual([obs.facade.getMode(), obs.listeners.length, obs.facade.getStatus().handler],
        ["observe", 1, "drain"]);
      obs.facade.stop();

      const off = cfgOf(env, { mode: "observe" });
      const bOff = rowBoundsOfConfig(off);
      const top = Math.max(...BOUND_NAMES.map((k) => bOff[k]).filter((v) => Number.isFinite(v)));
      const tight = cfgOf(env);
      tight.persistence.maxRowsPerTransaction = top + 1;
      const bound = boot(env, tight, WORLD());
      assert.strictEqual(bound.started.reason, "TRANSIT_ROW_BOUND", JSON.stringify(bound.started));
      assert.ok(/ > persistence\.maxRowsPerTransaction=/.test(bound.started.detail), bound.started.detail);
    } finally {
      env.close();
    }

    const warn = (env) => config.resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_TRANSIT_ENABLED: "1",
      EVEJS_LNE_TRANSIT_MODE: "on", ...env } }).warnings.filter((w) => w.startsWith("transit."));
    assert.deepStrictEqual(warn({}), []);
    assert.ok(warn({ EVEJS_LNE_BATTLE_ENABLED: "0" }).includes("transit.mode=on without modules.battle - every HALT "
      + "ends STALE BATTLE_UNAVAILABLE (the fleet flies on)"));
    assert.ok(warn({ EVEJS_LNE_TRANSIT_HALTS_PER_CONTROLLER_HOUR: "0" }).includes("transit.mode=on with "
      + "transit.haltsPerControllerHour=0 - checkpoints roll but never stop a fleet (BUDGET)"));
    assert.ok(warn({ EVEJS_LNE_TRANSIT_HALTS_PER_CONTROLLER_HOUR: "900", EVEJS_LNE_PERSISTENCE_MAX_ROWS_PER_TRANSACTION:
      "800" }).some((w) => w.startsWith("transit.haltsPerControllerHour=900 above persistence.maxRowsPerTransaction="
      + "800 - effectively")));
    assert.ok(warn({ EVEJS_LNE_PERSISTENCE_MAX_ROWS_PER_TRANSACTION: "100" }).some((w) => w.startsWith(
      "transit.mode=on with a row bound over the limit (") && w.endsWith("(TRANSIT_ROW_BOUND)")));

    const seed = { state: "failed" };
    const world = fakeWorld([sysRow(101), sysRow(102)]);
    world.seed = { getStatus: () => ({ state: seed.state }) };
    const lines = [];
    const holder = {};
    const settings = (() => {
      const c = JSON.parse(JSON.stringify(config.resolveConfig({ modDir: MOD_DIR, env: {} }).config));
      return require("../../../lib/strategy/transit").settingsOf(c).settings;
    })();
    const index = createRiskIndex({ world, settings, nowMs: () => 1000, perfNow: () => 0,
      onSeedDegraded: (s) => holder.service.noteIndexSeedDegraded(s), onWaitSeed: () => holder.service
        .noteIndexWaitSeed() });
    holder.service = createTransitService({ fleetRepository: { getOperation: () => null }, index, settings,
      isHostile: () => true, logger: { log: (l) => lines.push(l) } });
    index.step();
    assert.deepStrictEqual([index.isWarm(), index.getStatus().seedDegraded, holder.service.getStatus().counters
      .indexSeedDegraded], [true, "failed", 1]);
    assert.deepStrictEqual(lines, ["transit: index built while the world control seed is failed - checkpoints use the "
      + "partial world state (world.seed.failures)"]);
    const cold = createRiskIndex({ world: { ...fakeWorld([sysRow(101)]), seed: { getStatus: () => ({ state:
      "running" }) } }, settings });
    cold.step();
    assert.deepStrictEqual([cold.isWarm(), cold.getStatus().waitSeed, cold.getStatus().seedDegraded],
      [false, "running", null]);
  });
};
