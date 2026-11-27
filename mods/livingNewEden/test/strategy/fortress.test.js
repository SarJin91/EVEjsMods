"use strict";

const assert = require("node:assert");

const { startFortress, createUnavailableFortress, REQUIRED, SOFT_ROOTS } = require("../../lib/strategy/fortress");
const { decideCheckpoint, defensesOf } = require("../../lib/strategy/fortress/rules");
const { checkpointKey, haltKeyOf, battleKeyOf, CHECKPOINT_EVENT } = require("../../lib/strategy/fortress/service");
const { createUnavailableBattle, lazySentriesConsequence } = require("../../lib/battle");
const { createUnavailablePresence } = require("../../lib/presence");
const { fortressTxRowsOf } = require("../../lib/strategy/reviewRows");
const { rowBoundsOfConfig, BOUND_NAMES } = require("../../lib/strategy/reviewBound");
const { createHaltMemoryRepository } = require("../../lib/strategy/fortress/memoryRepository");
const { MIGRATIONS } = require("../../lib/persistence/migrations");
const { TABLE_POLICY, ACTION } = require("../../lib/persistence/worldReset");
const { readStaticMapFrom } = require("../../lib/adapter/staticMap");
const { buildUniverseGraph } = require("../../lib/graph/universeGraph");
const { createRouteFinder } = require("../../lib/graph/routes");
const { createWormholeTransits } = require("../../lib/fleets/wormholeTransits");
const { loadSecurityBand } = require("../graph/fixtures/staticMap.fixture");
const { rawWorld } = require("../graph/fixtures/routeMap.fixture");
const { FORTRESSES } = require("../../lib/strategy/data/fortresses");
const { startScheduler } = require("../../lib/scheduler");
const { createJournal } = require("../../lib/persistence/journal");
const seams = require("../../lib/adapter/sentrySeams");
const { startSentries } = require("../../lib/sentries");
const { harness: H } = require("../battle/settlement.test");
const { harness: C } = require("../battle/contacts.test");
const { fakeVendor } = require("../sentries/factionSentries.test");

const S = H.S;
const DEATHLESS = 500029;
const HOUR = 3600000;
const WORLD_SEED = 11;
const AVOID = Object.freeze({ avoidSecClasses: ["highsec", "lowsec"] });
const FORT = Object.freeze({ systemId: S.N6, factionId: DEATHLESS });
const BATTERIES = 5;

function cfgOf(env, fortress = {}) {
  const c = JSON.parse(JSON.stringify(env.cfg));
  c.modules.strategy = { enabled: true };
  c.persistence.maxRowsPerTransaction = 1100;
  c.fortress = { ...c.fortress, checkpointEnabled: true, interceptChancePermille: 1000, batteryCount: BATTERIES,
    ...fortress };
  return c;
}

function bootFortress(env, cfg, holder = {}) {
  const handlers = {};
  const listeners = [];
  const advisors = [];
  const scheduler = { ...env.scheduler, registerHandler: (type, fn, o) => {
    handlers[type] = fn;
    return env.scheduler.registerHandler(type, fn, o);
  }, ...(holder.scanKeys ? { scanKeys: holder.scanKeys } : {}) };
  const travel = { ...env.fleets.travel, addDepartureListener: (fn) => {
    listeners.push(fn);
    return env.fleets.travel.addDepartureListener(fn);
  }, addRouteAdvisor: (fn) => {
    advisors.push(fn);
    return env.fleets.travel.addRouteAdvisor(fn);
  } };
  const lines = [];
  const started = startFortress({ config: cfg, persistence: { ok: true, store: env.store, journal: env.journal,
    worldSeed: WORLD_SEED }, scheduler, fleets: { ...env.fleets, travel }, logger: { log: (l) => lines.push(l) },
  getBattle: () => (holder.battle === undefined ? env.battle : holder.battle), getPresence: () => holder.presence || null,
  fortresses: [FORT] });
  return { started, handlers, listeners, advisors, lines, facade: started.ok ? started.fortress : null };
}

function opFleet(env, tag, factionId, target = S.N9, from = S.N0) {
  const fleetId = env.newFleet(tag, factionId, from);
  const op = env.fleets.createOperation({ operationType: "invasion", factionId, originSystemId: from,
    targetSystemId: target, objective: "capture", dueAt: env.clock.now() + HOUR,
    fleets: [{ fleetId, expectedVersion: env.fleet(fleetId).version }] }, `t:op:${tag}`);
  assert.ok(op.ok, JSON.stringify(op));
  return fleetId;
}

function mover(env, tag, factionId, target = S.N9) {
  const fleetId = opFleet(env, tag, factionId, target);
  const plan = env.fleets.planTravel({ fleetId, targetSystemId: target, constraints: AVOID }, `t:plan:${tag}`);
  assert.ok(plan.ok, JSON.stringify(plan));
  return { fleetId, plan, at: plan.departAt + 2 * plan.jumpMs };
}

function aversionGraph() {
  const read = readStaticMapFrom({ ensureLoaded: () => rawWorld() }, loadSecurityBand());
  assert.strictEqual(read.ok, true, JSON.stringify(read));
  const built = buildUniverseGraph(read.map);
  assert.strictEqual(built.ok, true);
  const finder = createRouteFinder(built.graph, { cacheSize: 64, maxJumps: 40,
    transitAversion: { systemIds: [S.N6], detourMaxJumps: 1 } });
  return Object.freeze({ ...built.graph, ...finder.publicApi });
}

function wormholeGraph() {
  const read = readStaticMapFrom({ ensureLoaded: () => rawWorld() }, loadSecurityBand());
  assert.strictEqual(read.ok, true, JSON.stringify(read));
  const built = buildUniverseGraph(read.map);
  assert.strictEqual(built.ok, true);
  const finder = createRouteFinder(built.graph, { cacheSize: 64, maxJumps: 40 });
  for (const [key, from, to] of [["hm4:iso", S.ISO, S.N5], ["hm4:n0n9", S.N0, S.N9]]) {
    const r = finder.updateWormholeEdge(key, { fromSystemId: from, toSystemId: to, status: "open" });
    assert.ok(r.ok && r.changed, JSON.stringify(r));
  }
  return Object.freeze({ ...built.graph, ...finder.publicApi });
}
const WH = Object.freeze({ wormholes: true });

const memoryRows = (env) => env.q("SELECT system_id, faction_id, halts, last_halt_at, until_at, version FROM "
  + "world_fortress_halt_memory ORDER BY system_id, faction_id").map((r) => Object.fromEntries(Object.entries(r)
  .map(([k, v]) => [k, Number(v)])));
const MEMORY = Object.freeze({ haltMemoryEnabled: true });

const rowsOf = (env) => env.q("SELECT event_id, idempotency_key, aggregate_id, due_at, payload, state, outcome "
  + "FROM world_scheduled_events WHERE event_type = ? ORDER BY due_at, idempotency_key", CHECKPOINT_EVENT)
  .map((r) => ({ ...r, payload: JSON.parse(r.payload) }));
const evOf = (row) => ({ eventType: CHECKPOINT_EVENT, idempotencyKey: row.idempotency_key, payload: row.payload,
  dueAt: row.due_at, aggregateId: row.aggregate_id });
const found = (env, key) => env.store.transaction("t.find", (db) => env.journal.findByKey(db, key)).value;

function dump(env) {
  const tables = env.q("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").map((r) => r.name);
  return Object.fromEntries(tables.map((t) => [t, env.q(`SELECT * FROM "${t}"`).map((r) => JSON.stringify(r,
    (_k, v) => (typeof v === "bigint" ? String(v) : v))).sort()]));
}

module.exports = ({ test, skip }) => {
  const driver = H.loadDriver();
  const t = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  t("FZ1 listener: a hostile leg through the fortress -> one FORTRESS_CHECKPOINT at from_i; owner / exempt faction / "
    + "fortress as destination / wormhole leg / flag off -> none", () => {
    const env = C.createEnv(driver);
    try {
      const fz = bootFortress(env, cfgOf(env, { exemptFactionIds: String(C.GURISTAS) }));
      assert.ok(fz.started.ok, JSON.stringify(fz.started));
      assert.deepStrictEqual([fz.facade.getMode(), fz.listeners.length, Object.keys(fz.handlers)],
        ["on", 1, [CHECKPOINT_EVENT]]);
      const m = mover(env, "hostile", C.SANSHA);
      const key = checkpointKey(S.N6, m.fleetId, m.plan.legSeq);
      assert.strictEqual(key, `fortress:${S.N6}:x:${m.fleetId}:${m.plan.legSeq}`);
      const rows = rowsOf(env);
      assert.deepStrictEqual(rows.map((r) => [r.idempotency_key, r.aggregate_id, r.due_at, r.state]),
        [[key, String(S.N6), m.at, "QUEUED"]]);
      assert.deepStrictEqual(rows[0].payload, { systemId: S.N6, fleetId: m.fleetId, legSeq: m.plan.legSeq,
        systemIndex: 2, at: m.at });
      mover(env, "owner", DEATHLESS);
      mover(env, "exempt", C.GURISTAS);
      mover(env, "dest", C.SANSHA, S.N6);
      const w = env.store.transaction("t.wh", (db) => fz.listeners[0](db, { fleetId: "wh_fleet", factionId: C.SANSHA,
        fleetRole: "patrol", operationId: null, legSeq: 1, leg: { systems: [S.N0, S.N5, S.N6, S.N7],
          departAt: env.clock.now(), jumpMs: 1000 }, wormholes: true, chained: false }));
      assert.ok(w.ok, JSON.stringify(w));
      assert.strictEqual(rowsOf(env).length, 1);
      const st = fz.facade.getStatus();
      assert.deepStrictEqual([st.counters.crossingsQueued, st.counters.listenerExempt, st.listeners, st.fortresses],
        [1, 3, 1, [S.N6]]);
      assert.deepStrictEqual([fortressTxRowsOf(cfgOf(env)), fz.advisors.length, st.advisors, st.memory],
        [1, 0, 0, "off"]);
      const pair = [opFleet(env, "two-a", C.SANSHA), opFleet(env, "two-b", C.SANSHA)];
      const two = env.store.transaction("t.two", (db) => pair.map((id) => env.fleets.travel.planInTx(db,
        { fleetId: id, targetSystemId: S.N9, constraints: AVOID }, `t:plan:${id}`)));
      assert.ok(two.ok && two.value.every((p) => p.ok === true), JSON.stringify(two));
      const after = (env2) => rowsOf(env2).map((r) => r.payload.fleetId);
      assert.deepStrictEqual(after(env).filter((id) => pair.includes(id)), [pair[0]]);
      const st2 = fz.facade.getStatus();
      assert.deepStrictEqual([st2.counters.budgetPass, st2.counters.crossingsQueued, st2.lastRefusal], [1, 2, "BUDGET"]);
      const next = mover(env, "next-tx", C.SANSHA);
      assert.ok(after(env).includes(next.fleetId));
      assert.deepStrictEqual([rowsOf(env).length, fz.facade.getStatus().counters.budgetPass], [3, 1]);
      fz.facade.stop();
    } finally {
      env.close();
    }
    const off = C.createEnv(driver);
    try {
      const fz = bootFortress(off, cfgOf(off, { checkpointEnabled: false }));
      assert.deepStrictEqual(fz.started, { ok: false, reason: "disabled_by_config" });
      assert.deepStrictEqual([fz.listeners.length, Object.keys(fz.handlers)], [0, []]);
      mover(off, "hostile", C.SANSHA);
      assert.deepStrictEqual(rowsOf(off), []);
      assert.strictEqual(fortressTxRowsOf(cfgOf(off, { checkpointEnabled: false })), 0);
    } finally {
      off.close();
    }
  });

  t("FZ2 HALT: interceptInTx + one fixed defense battle under :hit in one transaction; a refused battle rolls the stop "
    + "back; replay = DUPLICATE, still one battle; the battle settles VIRTUAL once", async () => {
    const env = C.createEnv(driver);
    try {
      const holder = {};
      const cfg = cfgOf(env);
      const fz = bootFortress(env, cfg, holder);
      assert.ok(fz.started.ok, JSON.stringify(fz.started));
      const m = mover(env, "halt", C.SANSHA);
      const r2 = mover(env, "refused", C.SANSHA);
      const rows = rowsOf(env);
      const rowOf = (fleetId) => rows.find((r) => r.payload.fleetId === fleetId);
      env.clock.set(m.at);

      holder.battle = { getStatus: () => ({ state: "ready" }),
        createFixedDefenseBattleInTx: () => ({ ok: false, reason: "GRAPH_NOT_READY" }) };
      const evR = evOf(rowOf(r2.fleetId));
      const resR = fz.handlers[CHECKPOINT_EVENT](evR, {});
      assert.strictEqual(resR.outcome, "HALT", JSON.stringify(resR));
      let refused = null;
      const rolled = env.store.transaction("t.refused", (db) => {
        refused = resR.effect(db, evR);
        if (!refused.ok) throw new Error("rollback");
      });
      assert.deepStrictEqual([rolled.ok, refused.ok, refused.reason], [false, false, "GRAPH_NOT_READY"]);
      const hitR = `${evR.idempotencyKey}:hit`;
      assert.deepStrictEqual([env.fleet(r2.fleetId).state, found(env, hitR).found,
        found(env, haltKeyOf(hitR)).found, env.battles().length], ["TRAVELLING", false, false, 0]);
      assert.strictEqual(fz.facade.getStatus().counters.haltRefused, 1);
      holder.battle = createUnavailableBattle("test");
      assert.deepStrictEqual(fz.handlers[CHECKPOINT_EVENT](evR, {}).outcome, "STALE");
      holder.battle = undefined;

      const ev = evOf(rowOf(m.fleetId));
      const res = fz.handlers[CHECKPOINT_EVENT](ev, {});
      assert.deepStrictEqual([res.ok, res.outcome], [true, "HALT"], JSON.stringify(res));
      const v = env.store.transaction("t.halt", (db) => res.effect(db, ev)).value;
      assert.deepStrictEqual([v.ok, v.applied, v.action, v.systemId], [true, true, "HALT", S.N6], JSON.stringify(v));
      res.onCommitted(v);
      const hit = `${ev.idempotencyKey}:hit`;
      const f = env.fleet(m.fleetId);
      assert.deepStrictEqual([f.state, f.currentSystemId, f.legSeq], ["ENGAGED", S.N6, m.plan.legSeq]);
      const halt = found(env, haltKeyOf(hit));
      assert.ok(halt.found && /^zfh:[0-9a-f]{40}$/.test(haltKeyOf(hit)), JSON.stringify(halt));
      const entry = found(env, hit).entry;
      assert.deepStrictEqual(entry.payload, { ...ev.payload, outcome: "HALT", roll: entry.payload.roll,
        battleKey: battleKeyOf(hit) });
      const battles = env.battles();
      assert.deepStrictEqual(battles.map((b) => [b.battle_id, b.idempotency_key, b.system_id, b.state, b.hold_reason]),
        [[v.battleId, battleKeyOf(hit), S.N6, "PENDING", "LIVE_UNSUPPORTED"]]);
      const input = JSON.parse(battles[0].input_json);
      const expected = defensesOf(FORT, { ...cfg.fortress });
      assert.strictEqual(input.fixedDefenses.entries.length, BATTERIES);
      assert.deepStrictEqual(input.fixedDefenses, { attackerRetreatLossPermille: 300, entries: [...expected.entries]
        .sort((a, b) => (a.sentryId < b.sentryId ? -1 : 1)) });
      assert.ok(input.fixedDefenses.entries.every((e) => e.sentryId.startsWith("zf:") && e.ownerKind === "faction"
        && e.ownerId === DEATHLESS), JSON.stringify(input.fixedDefenses));
      assert.deepStrictEqual(input.sideA.fleets.map((x) => x.fleetId), [m.fleetId]);

      const again = env.store.transaction("t.again", (db) => res.effect(db, ev)).value;
      assert.deepStrictEqual(again, { ok: true, applied: false, action: "DUPLICATE" });
      const late = fz.handlers[CHECKPOINT_EVENT](ev, {});
      assert.strictEqual(late.outcome, "STALE");
      late.onCommitted();
      assert.strictEqual(env.battles().length, 1);
      const st = fz.facade.getStatus();
      assert.deepStrictEqual([st.counters.halts, st.counters.battlesCreated, st.staleByReason.LEG_MOVED,
        st.staleByReason.BATTLE_UNAVAILABLE], [1, 1, 1, undefined]);
      assert.deepStrictEqual([memoryRows(env), v.memory, st.counters.memoryWrites], [[], undefined, 0]);

      await env.drive(m.at + cfg.battle.engageDelayMs);
      const done = env.battles().find((b) => b.battle_id === v.battleId);
      assert.deepStrictEqual([done.state, done.mode], ["COMPLETED", "VIRTUAL"]);
      assert.strictEqual(env.n("SELECT count(*) AS n FROM world_event_journal WHERE event_type = 'BATTLE_SETTLED' "
        + "AND aggregate_id = ?", v.battleId), 1);
      assert.strictEqual(rowsOf(env).every((r) => r.state === "DONE"), true);
      fz.facade.stop();
    } finally {
      env.close();
    }
  });

  t("FZ3 deterministic roll (threshold PASS / HALT), PASS writes nothing; a new plan before dueAt -> LEG_MOVED; a "
    + "player in the system -> observedPass", () => {
    const env = C.createEnv(driver);
    try {
      const holder = {};
      const fz = bootFortress(env, cfgOf(env, { interceptChancePermille: 0 }), holder);
      assert.ok(fz.started.ok, JSON.stringify(fz.started));
      const m = mover(env, "pass", C.SANSHA);
      const m3 = mover(env, "replan", C.SANSHA);
      const row = rowsOf(env).find((r) => r.payload.fleetId === m.fleetId);
      const ev = evOf(row);
      const ev3 = evOf(rowsOf(env).find((r) => r.payload.fleetId === m3.fleetId));
      env.clock.set(m3.plan.departAt + m3.plan.jumpMs);
      const re = env.fleets.planTravel({ fleetId: m3.fleetId, targetSystemId: S.N9, constraints: AVOID }, "t:replan");
      assert.ok(re.ok, JSON.stringify(re));
      const target = env.fleet(m.fleetId);
      const facts = { p: row.payload, target, hostile: true, exempt: false, observed: false, worldSeed: WORLD_SEED };
      const a = decideCheckpoint(facts, { interceptChancePermille: 0 });
      const b = decideCheckpoint(facts, { interceptChancePermille: 0 });
      assert.deepStrictEqual([a.action, a, typeof a.roll], ["PASS", b, "number"]);
      const k = Math.floor(a.roll * 1000);
      assert.deepStrictEqual([decideCheckpoint(facts, { interceptChancePermille: k }).action,
        decideCheckpoint(facts, { interceptChancePermille: k + 1 }).action], ["PASS", "HALT"]);
      assert.notStrictEqual(decideCheckpoint({ ...facts, worldSeed: WORLD_SEED + 1 }, { interceptChancePermille: 0 })
        .roll, a.roll);
      env.clock.set(m.at);
      const before = env.n("SELECT count(*) AS n FROM world_event_journal");
      const res = fz.handlers[CHECKPOINT_EVENT](ev, {});
      assert.deepStrictEqual([res.ok, res.outcome, res.effect], [true, "PASS", undefined]);
      res.onCommitted();
      assert.deepStrictEqual([env.n("SELECT count(*) AS n FROM world_event_journal"), env.fleet(m.fleetId).state],
        [before, "TRAVELLING"]);

      const moved = fz.handlers[CHECKPOINT_EVENT](ev3, {});
      assert.strictEqual(moved.outcome, "STALE");
      moved.onCommitted();
      const legs = rowsOf(env).filter((r) => r.payload.fleetId === m3.fleetId).map((r) => [r.payload.legSeq,
        r.payload.systemIndex]);
      assert.deepStrictEqual(legs, [[m3.plan.legSeq, 2], [re.legSeq, 1]]);

      holder.presence = { distanceToObserved: (systemId, radius) => ({ ok: true, distance: systemId === S.N6
        && radius === 0 ? 0 : null }) };
      fz.facade.stop();
      const fz2 = bootFortress(env, cfgOf(env, { interceptChancePermille: 1000 }), holder);
      assert.ok(fz2.started.ok, JSON.stringify(fz2.started));
      const p2 = mover(env, "observed", C.SANSHA);
      const row2 = rowsOf(env).find((r) => r.payload.fleetId === p2.fleetId);
      env.clock.set(p2.at);
      const obs = fz2.handlers[CHECKPOINT_EVENT](evOf(row2), {});
      assert.deepStrictEqual([obs.outcome, obs.effect], ["OBSERVED", undefined]);
      obs.onCommitted();
      const st = fz.facade.getStatus();
      assert.deepStrictEqual([st.counters.passed, st.staleByReason.LEG_MOVED, st.mode], [1, 1, "off"]);
      assert.strictEqual(fz2.facade.getStatus().counters.observedPass, 1);
      assert.strictEqual(env.battles().length, 0);
      fz2.facade.stop();
    } finally {
      env.close();
    }
  });

  t("FZ4 sentries battleConsequence skips the zf: entries (no SENTRY_BATTLE_DAMAGE, battleFortressSkipped); a sentry "
    + "entry next to them is projected as before", () => H.withStore(driver, async (reopen) => {
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
    const tx = (fn) => opened.store.transaction("t", fn).value;
    const cons = lazySentriesConsequence(() => started.sentries);
    const at = shared.clock.now();
    const fort = defensesOf(FORT, { ...C.testConfig().fortress, batteryCount: 3 }).entries
      .map((e) => ({ sentryId: e.sentryId, itemId: e.itemId, hp: e.hp, ehp: e.ehp, damage: 1000, destroyed: false }));
    const only = tx((db) => cons.apply(db, { battleId: "b-zf", systemId: S.N6, at, fixedDefenses: fort },
      "b-zf:c:sentries"));
    assert.deepStrictEqual(only, { ok: true, skipped: true });
    const mixed = tx((db) => cons.apply(db, { battleId: "b-mix", systemId: S.N6, at, fixedDefenses: [...fort,
      { sentryId: "sf-1", itemId: 7001, hp: 3000, ehp: 6000, damage: 1500, destroyed: false }] }, "b-mix:c:sentries"));
    assert.deepStrictEqual(mixed, { ok: true, duplicate: false, enqueued: "sbdmg:b-mix" });
    const events = tx((db) => db.prepare("SELECT idempotency_key, payload FROM world_scheduled_events WHERE "
      + "event_type = 'SENTRY_BATTLE_DAMAGE'").all());
    assert.deepStrictEqual(events.map((e) => [e.idempotency_key, JSON.parse(e.payload).hits]),
      [["sbdmg:b-mix", [{ sentryId: "sf-1", itemId: 7001, targetHp: 3000 - Math.floor(1500 * 3000 / 6000) }]]]);
    assert.strictEqual(started.service.getStatus().counters.battleFortressSkipped, 2);
    started.sentries.stop("test");
    sr.scheduler.stop("test");
  }));

  t("FZ5 REQUIRED on the real facades; flag off = no handler, no listener, no advisor, database bit for bit; defaults "
    + "+ flag on start (bounds off + 1), budget 8 -> FORTRESS_ROW_BOUND; drain: open row + flag off -> DONE STALE OFF; "
    + "refused drain scan -> drain + detail", async () => {
    const plain = C.createEnv(driver);
    const off = C.createEnv(driver);
    try {
      const fz = bootFortress(off, cfgOf(off, { checkpointEnabled: false, ...MEMORY }));
      assert.deepStrictEqual([fz.started, fz.listeners.length, Object.keys(fz.handlers), fz.advisors.length],
        [{ ok: false, reason: "disabled_by_config" }, 0, [], 0]);
      mover(plain, "x", C.SANSHA);
      mover(off, "x", C.SANSHA);
      assert.deepStrictEqual(dump(off), dump(plain));
      assert.deepStrictEqual(dump(off).world_fortress_halt_memory, []);
      const roots = { fleets: off.fleets, scheduler: off.scheduler, persistence: { store: off.store,
        journal: off.journal }, battle: off.battle, presence: createUnavailablePresence("test") };
      const missing = (r) => REQUIRED.filter((path) => {
        const parts = path.split(".");
        let v = r[parts[0]];
        for (let i = 1; i < parts.length && v; i += 1) v = v[parts[i]];
        return typeof v !== "function";
      });
      assert.deepStrictEqual([missing(roots), missing({ ...roots, battle: createUnavailableBattle("t") })], [[], []]);
      assert.deepStrictEqual([...SOFT_ROOTS], ["battle", "presence"]);
      const stub = createUnavailableFortress("FORTRESS_DISABLED");
      assert.deepStrictEqual([stub.getMode(), stub.getStatus().reason], ["off", "FORTRESS_DISABLED"]);
      assert.deepStrictEqual(FORTRESSES.map((f) => [f.systemId, f.factionId]), [[30100000, DEATHLESS]]);

      const def = cfgOf(off);
      def.persistence.maxRowsPerTransaction = 1000;
      const offCfg = cfgOf(off, { checkpointEnabled: false });
      const bOn = rowBoundsOfConfig(def);
      const bOff = rowBoundsOfConfig(offCfg);
      assert.deepStrictEqual(BOUND_NAMES.map((k) => bOn[k]), BOUND_NAMES.map((k) => (bOff[k] === null ? null
        : bOff[k] + 1)));
      assert.ok(bOn.review <= 1000, JSON.stringify(bOn));
      const fine = bootFortress(off, def);
      assert.ok(fine.started.ok, JSON.stringify(fine.started));
      fine.facade.stop();
      const bound = bootFortress(off, { ...def, fortress: { ...def.fortress, maxCheckpointsPerTransaction: 8 } });
      assert.deepStrictEqual(bound.started, { ok: false, reason: "FORTRESS_ROW_BOUND",
        detail: `review=${bOff.review + 8} > persistence.maxRowsPerTransaction=1000` });
      assert.deepStrictEqual(bootFortress(off, cfgOf(off, { batteryCount: 0 })).started,
        { ok: false, reason: "INVALID_CONFIG", detail: "fortress.batteryCount" });
    } finally {
      plain.close();
      off.close();
    }

    const env = C.createEnv(driver);
    try {
      const on = bootFortress(env, cfgOf(env));
      assert.ok(on.started.ok, JSON.stringify(on.started));
      const m = mover(env, "drain", C.SANSHA);
      on.facade.stop();
      const fz = bootFortress(env, cfgOf(env, { checkpointEnabled: false }));
      assert.ok(fz.started.ok, JSON.stringify(fz.started));
      assert.deepStrictEqual([fz.facade.getMode(), fz.listeners.length, Object.keys(fz.handlers),
        fz.facade.getStatus().listeners], ["drain", 0, [CHECKPOINT_EVENT], 0]);
      assert.ok(fz.lines.some((l) => l === `fortress: mode=drain systems=${S.N6}`), JSON.stringify(fz.lines));
      await env.drive(m.at);
      const [row] = rowsOf(env);
      assert.deepStrictEqual([row.state, row.outcome], ["DONE", "STALE"]);
      const st = fz.facade.getStatus();
      assert.deepStrictEqual([st.counters.drained, st.staleByReason.OFF, env.fleet(m.fleetId).state],
        [1, 1, "TRAVELLING"]);
      fz.facade.stop();
      assert.strictEqual(fz.facade.getMode(), "off");
      assert.deepStrictEqual(bootFortress(env, cfgOf(env, { checkpointEnabled: false })).started,
        { ok: false, reason: "disabled_by_config" });
      const refused = bootFortress(env, cfgOf(env, { checkpointEnabled: false }),
        { scanKeys: () => ({ ok: false, reason: "SCAN_REFUSED" }) });
      assert.ok(refused.started.ok, JSON.stringify(refused.started));
      assert.deepStrictEqual([refused.facade.getMode(), refused.facade.getStatus().detail, refused.listeners.length,
        refused.advisors.length], ["drain", "drain scan: SCAN_REFUSED", 0, 0]);
      assert.ok(refused.lines.includes(`fortress: mode=drain systems=${S.N6} (drain scan: SCAN_REFUSED)`),
        JSON.stringify(refused.lines));
      refused.facade.stop();
    } finally {
      env.close();
    }
  });

  t("HM1 HALT memory: the HALT writes one row in the :hit transaction; a refused battle -> no row; replay = DUPLICATE, "
    + "halts 1; another HALT of the faction -> halts + 1, until_at = max", () => {
    const env = C.createEnv(driver);
    try {
      const holder = {};
      const cfg = cfgOf(env, MEMORY);
      const fz = bootFortress(env, cfg, holder);
      assert.ok(fz.started.ok, JSON.stringify(fz.started));
      assert.deepStrictEqual([fz.advisors.length, fz.facade.getStatus().memory, fz.facade.getStatus().memoryEntries],
        [1, "ready", 0]);
      const m = mover(env, "hm-halt", C.SANSHA);
      const r2 = mover(env, "hm-refused", C.SANSHA);
      const rows = rowsOf(env);
      const evOfFleet = (fleetId) => evOf(rows.find((r) => r.payload.fleetId === fleetId));
      env.clock.set(m.at);
      holder.battle = { getStatus: () => ({ state: "ready" }),
        createFixedDefenseBattleInTx: () => ({ ok: false, reason: "GRAPH_NOT_READY" }) };
      const evR = evOfFleet(r2.fleetId);
      const resR = fz.handlers[CHECKPOINT_EVENT](evR, {});
      const rolled = env.store.transaction("t.refused", (db) => {
        if (!resR.effect(db, evR).ok) throw new Error("rollback");
      });
      assert.strictEqual(rolled.ok, false);
      assert.deepStrictEqual(memoryRows(env), []);
      holder.battle = undefined;
      const ev = evOfFleet(m.fleetId);
      const res = fz.handlers[CHECKPOINT_EVENT](ev, {});
      const v = env.store.transaction("t.halt", (db) => res.effect(db, ev)).value;
      assert.deepStrictEqual([v.ok, v.applied, v.memory], [true, true, { factionId: C.SANSHA,
        untilAt: ev.payload.at + cfg.fortress.haltMemoryMs }], JSON.stringify(v));
      res.onCommitted(v);
      assert.ok(found(env, `${ev.idempotencyKey}:hit`).found);
      assert.deepStrictEqual(memoryRows(env), [{ system_id: S.N6, faction_id: C.SANSHA, halts: 1,
        last_halt_at: ev.payload.at, until_at: ev.payload.at + cfg.fortress.haltMemoryMs, version: 1 }]);
      const again = env.store.transaction("t.again", (db) => res.effect(db, ev)).value;
      assert.deepStrictEqual([again.action, memoryRows(env)[0].halts, memoryRows(env)[0].version], ["DUPLICATE", 1, 1]);
      const res2 = fz.handlers[CHECKPOINT_EVENT](evR, {});
      const v2 = env.store.transaction("t.halt2", (db) => res2.effect(db, evR)).value;
      assert.deepStrictEqual([v2.applied, v2.memory.untilAt], [true, evR.payload.at + cfg.fortress.haltMemoryMs]);
      res2.onCommitted(v2);
      const older = env.store.transaction("t.older", (db) => createHaltMemoryRepository().recordHaltInTx(db,
        { systemId: S.N6, factionId: C.SANSHA, at: ev.payload.at - HOUR, untilAt: ev.payload.at - HOUR + 60000 })).value;
      const top = Math.max(ev.payload.at, evR.payload.at);
      assert.deepStrictEqual(older, { ok: true, untilAt: top + cfg.fortress.haltMemoryMs, halts: 3 });
      assert.deepStrictEqual(memoryRows(env).map((r) => [r.halts, r.last_halt_at, r.until_at, r.version]),
        [[3, top, top + cfg.fortress.haltMemoryMs, 3]]);
      const st = fz.facade.getStatus();
      assert.deepStrictEqual([st.counters.memoryWrites, st.memoryEntries], [2, 1]);
      fz.facade.stop();
    } finally {
      env.close();
    }
  });

  t("HM2 route advisor: the faction with memory avoids the hub (detour > routeDetourMaxJumps, <= haltMemory limit); "
    + "another faction, the hub as target, an expired memory -> through the hub; a short limit -> TOO_FAR "
    + "FORTRESS_AVOID before any write; an advisor exception -> plan as without it", () => {
    const env = C.createEnv(driver, { graph: aversionGraph() });
    try {
      const untilAt = env.clock.now() + HOUR;
      const seeded = env.store.transaction("t.seed", (db) => createHaltMemoryRepository().recordHaltInTx(db,
        { systemId: S.N6, factionId: C.SANSHA, at: env.clock.now(), untilAt })).value;
      assert.ok(seeded.ok, JSON.stringify(seeded));
      const cfg = cfgOf(env, { ...MEMORY, routeDetourMaxJumps: 1 });
      let fz = bootFortress(env, cfg);
      assert.ok(fz.started.ok, JSON.stringify(fz.started));
      const counters = () => env.fleets.travel.getCounters();
      const routeOf = (fleetId) => [...env.fleet(fleetId).route.systems];
      const plan = (tag, factionId, to) => {
        const id = opFleet(env, tag, factionId, to, S.N5);
        return { id, p: env.fleets.planTravel({ fleetId: id, targetSystemId: to }, `t:plan:${tag}`) };
      };
      const before = rowsOf(env).length;
      const a = plan("hm2-a", C.SANSHA, S.N7);
      assert.ok(a.p.ok, JSON.stringify(a.p));
      assert.deepStrictEqual(routeOf(a.id), [S.N5, S.N0, S.H1, S.N9, S.N7]);
      assert.deepStrictEqual([rowsOf(env).length, counters().routeAdvised], [before, 1]);
      const g = plan("hm2-g", C.GURISTAS, S.N7);
      assert.deepStrictEqual(routeOf(g.id), [S.N5, S.N6, S.N7]);
      const dest = plan("hm2-dest", C.SANSHA, S.N6);
      assert.deepStrictEqual([routeOf(dest.id), counters().routeAdvised], [[S.N5, S.N6], 1]);
      assert.strictEqual(fz.facade.getStatus().counters.avoidAdvised, 1);
      fz.facade.stop();
      fz = bootFortress(env, cfgOf(env, { ...MEMORY, haltMemoryDetourMaxJumps: 1 }));
      const shortId = opFleet(env, "hm2-short", C.SANSHA, S.N7, S.N5);
      const was = env.fleet(shortId);
      const refused = env.fleets.planTravel({ fleetId: shortId, targetSystemId: S.N7 }, "t:plan:hm2-short");
      assert.deepStrictEqual(refused, { ok: false, reason: "TOO_FAR", jumps: 4, detail: "FORTRESS_AVOID" });
      assert.deepStrictEqual([env.fleet(shortId).state, env.fleet(shortId).version, counters().routeAdviceRefused],
        [was.state, was.version, 1]);
      const role = env.fleet(shortId).fleetRole;
      const c1 = counters();
      const roleSum = Object.keys(c1).filter((k) => k.startsWith("adviceRefused_")).reduce((s, k) => s + c1[k], 0);
      assert.deepStrictEqual([c1.routeAdviceRefusedTooFar, c1.routeAdviceRefusedNoPath, c1[`adviceRefused_${role}`],
        roleSum], [1, 0, 1, c1.routeAdviceRefused], JSON.stringify({ role, c1 }));
      assert.strictEqual(c1.routeAdviceRefusedNoPathTooFar, 0);
      const npId = opFleet(env, "hm2-nptf", C.SANSHA, S.N7, S.N5);
      const npWas = env.fleet(npId);
      const np = env.fleets.planTravel({ fleetId: npId, targetSystemId: S.N7, constraints: { maxJumps: 3 } },
        "t:plan:hm2-nptf");
      assert.deepStrictEqual(np, { ok: false, reason: "TOO_FAR", jumps: 4, detail: "FORTRESS_AVOID" });
      const c2 = counters();
      assert.deepStrictEqual([c2.routeAdviceRefusedNoPath - c1.routeAdviceRefusedNoPath,
        c2.routeAdviceRefusedNoPathTooFar - c1.routeAdviceRefusedNoPathTooFar,
        c2.routeAdviceRefusedTooFar - c1.routeAdviceRefusedTooFar, env.fleet(npId).state, env.fleet(npId).version],
      [1, 1, 0, npWas.state, npWas.version], JSON.stringify(c2));
      const farId = opFleet(env, "hm2-far", C.SANSHA, S.N7, S.N5);
      const far = env.fleets.planTravel({ fleetId: farId, targetSystemId: S.N7, constraints: { maxJumps: 1 } },
        "t:plan:hm2-far");
      assert.deepStrictEqual([far.ok, far.reason], [false, "TOO_FAR"], JSON.stringify(far));
      assert.deepStrictEqual([counters().routeTooFar - c2.routeTooFar, counters().routeAdviceRefused],
        [1, c2.routeAdviceRefused]);
      fz.facade.stop();
      const thrower = env.fleets.travel.addRouteAdvisor(() => {
        throw new Error("advisor boom");
      });
      const x = plan("hm2-throw", C.SANSHA, S.N7);
      assert.deepStrictEqual([routeOf(x.id), counters().advisorErrors], [[S.N5, S.N6, S.N7], 1]);
      thrower.remove();
      fz = bootFortress(env, cfg);
      env.clock.set(untilAt);
      const late = plan("hm2-late", C.SANSHA, S.N7);
      assert.deepStrictEqual([routeOf(late.id), counters().routeAdvised], [[S.N5, S.N6, S.N7], 1]);
      fz.facade.stop();
    } finally {
      env.close();
    }
  });

  t("HM4 SWEEP-20261110-zarzakh: a leg with a wormhole edge gets no advice (through the hub, no FORTRESS_CHECKPOINT, "
    + "listenerExempt); a gate route advised onto a wormhole detour keeps the caller's constraints (no forbiddenSystems)",
  () => {
    const env = C.createEnv(driver, { graph: wormholeGraph() });
    try {
      const seeded = env.store.transaction("t.seed", (db) => createHaltMemoryRepository().recordHaltInTx(db,
        { systemId: S.N6, factionId: C.SANSHA, at: env.clock.now(), untilAt: env.clock.now() + HOUR })).value;
      assert.ok(seeded.ok, JSON.stringify(seeded));
      const fz = bootFortress(env, cfgOf(env, MEMORY));
      assert.ok(fz.started.ok, JSON.stringify(fz.started));
      const counters = () => env.fleets.travel.getCounters();
      const evac = opFleet(env, "hm4-wh", C.SANSHA, S.N7, S.ISO);
      const p = env.fleets.planTravel({ fleetId: evac, targetSystemId: S.N7, constraints: WH }, "t:plan:hm4-wh");
      assert.ok(p.ok, JSON.stringify(p));
      const leg = env.fleet(evac).route;
      assert.deepStrictEqual([leg.systems, leg.wormholeEdges.map((e) => e.i), leg.constraints],
        [[S.ISO, S.N5, S.N6, S.N7], [0], { wormholes: true }]);
      assert.deepStrictEqual([rowsOf(env).length, counters().routeAdvised, counters().routeAdviceRefused,
        fz.facade.getStatus().counters.avoidAdvised, fz.facade.getStatus().counters.listenerExempt], [0, 0, 0, 0, 1]);
      const det = opFleet(env, "hm4-det", C.SANSHA, S.N7, S.N5);
      const d = env.fleets.planTravel({ fleetId: det, targetSystemId: S.N7, constraints: WH }, "t:plan:hm4-det");
      assert.ok(d.ok, JSON.stringify(d));
      const leg2 = env.fleet(det).route;
      assert.deepStrictEqual([leg2.systems, leg2.wormholeEdges.map((e) => e.i), leg2.constraints],
        [[S.N5, S.N0, S.N9, S.N7], [1], { wormholes: true }]);
      assert.deepStrictEqual([rowsOf(env).length, counters().routeAdvised, fz.facade.getStatus().counters.avoidAdvised],
        [0, 1, 1]);
      fz.facade.stop();
    } finally {
      env.close();
    }
  });

  t("HM5: a leg v2 cut on its wormhole edge replans through the hub, the advice refuses the replan "
    + "(FORTRESS_AVOID) -> the fleet stops, replanAdviceHalted 1, no FORTRESS_CHECKPOINT; a replay changes nothing",
  async () => {
    const env = C.createEnv(driver, { graph: wormholeGraph() });
    try {
      const seeded = env.store.transaction("t.seed", (db) => createHaltMemoryRepository().recordHaltInTx(db,
        { systemId: S.N6, factionId: C.SANSHA, at: env.clock.now(), untilAt: env.clock.now() + 10 * HOUR })).value;
      assert.ok(seeded.ok, JSON.stringify(seeded));
      const fz = bootFortress(env, cfgOf(env, MEMORY));
      assert.ok(fz.started.ok, JSON.stringify(fz.started));
      const counters = () => env.fleets.travel.getCounters();
      const constraints = { wormholes: true, avoidSecClasses: ["highsec", "lowsec"] };
      const id = opFleet(env, "hm5", C.SANSHA, S.N5, S.N10);
      const p = env.fleets.planTravel({ fleetId: id, targetSystemId: S.N5, constraints }, "t:plan:hm5");
      assert.ok(p.ok, JSON.stringify(p));
      const leg = env.fleet(id).route;
      const legSeq = env.fleet(id).legSeq;
      assert.deepStrictEqual([leg.systems, leg.wormholeEdges.map((e) => e.i)], [[S.N10, S.N9, S.N0, S.N5], [1]]);
      const closed = env.graph.updateWormholeEdge("hm4:n0n9", { fromSystemId: S.N0, toSystemId: S.N9,
        status: "closed" });
      assert.ok(closed.ok && closed.changed, JSON.stringify(closed));
      const cut = env.store.transaction("t.cut", (db) => createWormholeTransits().closeLegInTx(db,
        leg.wormholeEdges[0].pairKey, { fleetId: id, legSeq, closedAt: leg.departAt })).value;
      assert.deepStrictEqual(cut, { ok: true, rows: 1 });
      const was = counters();
      await env.drive(leg.arriveAt);
      const f = env.fleet(id);
      const c1 = counters();
      assert.deepStrictEqual([f.state, f.currentSystemId, c1.replanAdviceHalted - was.replanAdviceHalted,
        c1.routeAdviceRefusedNoPath - was.routeAdviceRefusedNoPath, c1.wormholeHalted - was.wormholeHalted,
        rowsOf(env).length, c1.routeAdviceRefusedNoPathTooFar - was.routeAdviceRefusedNoPathTooFar],
      ["STAGED", S.N10, 1, 1, 1, 0, 0], JSON.stringify(f));
      const again = env.scheduler.enqueue("FLEET_ARRIVAL", id, env.clock.now(), { fleetId: id, legSeq },
        "t:hm5:again");
      assert.ok(again.ok, JSON.stringify(again));
      await env.drive(env.clock.now() + 1000);
      assert.deepStrictEqual([env.fleet(id).version, env.fleet(id).state, counters().replanAdviceHalted],
        [f.version, f.state, c1.replanAdviceHalted]);
      fz.facade.stop();
    } finally {
      env.close();
    }
  });

  t("HM3 restart: a new service on the same database has the memory (ready, 1 entry, the advisor refuses "
    + "UNREACHABLE FORTRESS_AVOID without a detour); migration 71 table; world reset wipes it", () => {
    const env = C.createEnv(driver);
    try {
      const at = env.clock.now();
      const w = env.store.transaction("t.seed", (db) => createHaltMemoryRepository().recordHaltInTx(db,
        { systemId: S.N6, factionId: C.SANSHA, at, untilAt: at + HOUR })).value;
      assert.ok(w.ok, JSON.stringify(w));
      env.restart();
      const fz = bootFortress(env, cfgOf(env, MEMORY));
      assert.ok(fz.started.ok, JSON.stringify(fz.started));
      const st = fz.facade.getStatus();
      assert.deepStrictEqual([st.memory, st.memoryEntries, st.advisors], ["ready", 1, 1]);
      assert.ok(fz.lines.some((l) => l.includes("memory=ready entries=1")), JSON.stringify(fz.lines));
      const id = opFleet(env, "hm3", C.SANSHA);
      const r = env.fleets.planTravel({ fleetId: id, targetSystemId: S.N9, constraints: AVOID }, "t:plan:hm3");
      assert.deepStrictEqual([r.ok, r.reason, r.detail], [false, "UNREACHABLE", "FORTRESS_AVOID"]);
      fz.facade.stop();
      const mig = MIGRATIONS.find((x) => x.name === "world_fortress_halt_memory");
      assert.ok(mig && mig.version === 71, JSON.stringify(mig));
      assert.strictEqual(TABLE_POLICY.world_fortress_halt_memory, ACTION.WIPE);
    } finally {
      env.close();
    }
  });
};
