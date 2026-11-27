"use strict";

const assert = require("node:assert");
const path = require("node:path");

const config = require("../../../config");
const { createJournal } = require("../../../lib/persistence/journal");
const { createViewRegistry } = require("../../../lib/observer/views");
const { startScheduler } = require("../../../lib/scheduler");
const { startFleets } = require("../../../lib/fleets");
const { startBattle, createUnavailableBattle } = require("../../../lib/battle");
const { buildDefaultServiceDefs } = require("../../../lib/runtime/services");
const { REQUIRED } = require("../../../lib/strategy/hunt");
const { harness: H } = require("../../battle/settlement.test");

const MOD_DIR = path.resolve(__dirname, "..", "..", "..");
const SANSHA = 500019;
const GURISTAS = 500010;
const HOUR = 3600000;
const S = H.S;

function testConfig() {
  return JSON.parse(JSON.stringify(config.resolveConfig({ modDir: MOD_DIR, env: {} }).config));
}

const huntDef = () => buildDefaultServiceDefs({}).find((d) => d.name === "hunt");

function boot(opened, shared, cfg) {
  const lines = [];
  const logger = { log: (l) => lines.push(l) };
  const store = opened.store;
  const journal = createJournal({ clock: shared.clock, maxPayloadBytes: cfg.persistence.journalMaxPayloadBytes,
    maxRows: 500 });
  const persistence = { ok: true, store, journal, worldSeed: opened.worldSeed, filePath: "test.sqlite" };
  const sr = startScheduler({ config: cfg, persistence: { ok: true, store }, clock: shared.clock, ids: shared.ids,
    logger, nowMs: () => 0 });
  assert.ok(sr.ok, JSON.stringify(sr));
  const graph = { getGraph: () => ({ ok: true, graph: shared.graph }) };
  const fr = startFleets({ config: cfg, persistence, clock: shared.clock, ids: shared.ids, scheduler: sr.scheduler,
    graph, presence: null, views: createViewRegistry(), logger });
  assert.ok(fr.ok, JSON.stringify(fr));
  const br = startBattle({ config: cfg, persistence, clock: shared.clock, ids: shared.ids, scheduler: sr.scheduler,
    fleets: fr.fleets, graph, views: createViewRegistry(), logger, nowMs: () => 0 });
  assert.ok(br.ok, JSON.stringify(br));
  const ctx = { config: cfg, persistence, scheduler: sr.scheduler, fleets: fr.fleets, battle: br.battle, graph,
    clock: shared.clock, ids: shared.ids, telemetry: null };
  const started = huntDef().start(ctx, { logger });
  const tx = (fn) => {
    const r = store.transaction("test", fn);
    assert.ok(r.ok, JSON.stringify(r));
    return r.value;
  };
  const env = { store, journal, ctx, started, lines, tx, shared, cfg, scheduler: sr.scheduler, fleets: fr.fleets };
  env.q = (sql, ...args) => tx((db) => db.prepare(sql).all(...args));
  env.n = (sql, ...args) => env.q(sql, ...args)[0].n;
  env.fleet = (id) => tx((db) => fr.fleets.repository.getFleet(db, id)).fleet;
  env.pins = () => env.q("SELECT * FROM world_hunt_pins ORDER BY pin_id");
  env.stop = () => {
    if (ctx.hunt) ctx.hunt.stop("test");
    br.battle.stop("test");
    fr.fleets.stop("test");
    sr.scheduler.stop("test");
  };
  env.drive = async (untilMs) => {
    for (let i = 0; i < 5000; i += 1) {
      const r = await sr.scheduler.runPass();
      assert.ok(r.ok, JSON.stringify(r));
      const now = shared.clock.now();
      if (!r.skipped && r.jobs > 0) continue;
      if (now >= untilMs) return;
      const next = sr.scheduler.getStatus().nextDueAt;
      shared.clock.set(Math.min(untilMs, next === null || next <= now ? now + cfg.scheduler.intervalMs : next));
    }
    throw new Error("drive: no end");
  };
  return env;
}

function newFleet(env, tag, factionId, systemId, fleetRole, composition) {
  const r = env.fleets.createFleet({ factionId, currentSystemId: systemId, homeSystemId: systemId, fleetRole,
    composition }, `test:${tag}`);
  assert.ok(r.ok, JSON.stringify(r));
  return r.fleetId;
}

function toPlanned(env, fleetId, factionId, from, to, tag) {
  const op = env.fleets.createOperation({ operationType: "patrol", factionId, originSystemId: from,
    targetSystemId: to, objective: "patrol", dueAt: env.shared.clock.now() + 2 * HOUR,
    fleets: [{ fleetId, expectedVersion: env.fleet(fleetId).version }] }, `test:op:${tag}`);
  assert.ok(op.ok, JSON.stringify(op));
  return op;
}

async function scene(env, beforeDrive) {
  const hunter = newFleet(env, "hunter", SANSHA, S.N5, "hunter", [{ hullGroup: "tackle", count: 10 }]);
  const target = newFleet(env, "target", GURISTAS, S.N6, "patrol", [{ hullGroup: "cruiser", count: 4 }]);
  const strike = newFleet(env, "strike", SANSHA, S.N0, "invasion", [{ hullGroup: "battleship", count: 20 }]);
  if (beforeDrive) beforeDrive(env, { hunter, target, strike });
  toPlanned(env, hunter, SANSHA, S.N5, S.N6, "hunter");
  const p = env.fleets.planTravel({ fleetId: hunter, targetSystemId: S.N6 }, "test:plan:hunter");
  assert.ok(p.ok, JSON.stringify(p));
  await env.drive(p.arriveAt);
  const scanKey = `hunt:scan:${S.N6}:arr:${hunter}:${p.legSeq}`;
  return { hunter, target, strike, p, scanKey };
}

module.exports = ({ test, skip }) => {
  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  needsDriver("TH1 hunt wiring: buildDefaultServiceDefs hunt starts on the real facades (running, REQUIRED "
    + "resolves); battle stub -> BATTLE_UNAVAILABLE, never HUNT_FACADE_MISSING", () => H.withStore(driver,
    async (reopen) => {
      const env = boot(reopen(), H.sharedOf(), testConfig());
      try {
        assert.deepStrictEqual(env.started, { ok: true }, env.lines.join("\n"));
        assert.strictEqual(env.ctx.hunt.getState(), "running");
        const roots = { fleets: env.ctx.fleets, scheduler: env.ctx.scheduler, persistence: env.ctx.persistence,
          battle: env.ctx.battle, clock: env.ctx.clock, ids: env.ctx.ids };
        for (const p of REQUIRED) {
          const v = p.split(".").reduce((o, k) => (o ? o[k] : undefined), roots);
          assert.strictEqual(typeof v, "function", p);
        }
        env.ctx.hunt.stop("test");
        assert.strictEqual(env.ctx.hunt.getState(), "off");
        const ctx2 = { ...env.ctx, hunt: undefined, battle: createUnavailableBattle("BATTLE_DISABLED") };
        const r = huntDef().start(ctx2, { logger: { log() {} } });
        assert.strictEqual(r.ok, false);
        assert.strictEqual(r.reason, "BATTLE_UNAVAILABLE");
      } finally {
        env.stop();
      }
    }));

  needsDriver("TH2 hunt scan from the hunter's arrival: 1 pin, 1 intercept ACTIVE, strike TRAVELLING, 1 expiry"
    + " replayed scan key -> duplicate; restart -> nothing doubled", () => H.withStore(driver, async (reopen) => {
    const shared = H.sharedOf();
    const cfg = testConfig();
    let env = boot(reopen(), shared, cfg);
    try {
      const sc = await scene(env);
      const contact = env.q("SELECT state, outcome FROM world_scheduled_events WHERE idempotency_key = ?",
        `contact:${S.N6}:arr:${sc.hunter}:${sc.p.legSeq}`)[0];
      assert.deepStrictEqual(contact, { state: "DONE", outcome: "NO_HOSTILES" });
      assert.strictEqual(env.n("SELECT count(*) AS n FROM battle_records"), 0);
      assert.notStrictEqual(env.fleet(sc.target).state, "ENGAGED");
      assert.strictEqual(env.fleet(sc.hunter).state, "STAGED");
      const scan = env.q("SELECT state, outcome FROM world_scheduled_events WHERE idempotency_key = ?", sc.scanKey)[0];
      assert.deepStrictEqual(scan, { state: "DONE", outcome: "PIN" }, JSON.stringify(env.ctx.hunt.getStatus()));
      const pins = env.pins();
      assert.strictEqual(pins.length, 1);
      const pin = pins[0];
      assert.deepStrictEqual([pin.state, pin.hunter_fleet_id, pin.target_fleet_id, pin.strike_fleet_id, pin.system_id,
        pin.faction_id], ["ACTIVE", sc.hunter, sc.target, sc.strike, S.N6, SANSHA]);
      const op = env.fleets.getOperation(pin.strike_operation_id).operation;
      assert.deepStrictEqual([op.operationType, op.state, op.targetSystemId], ["intercept", "ACTIVE", S.N6]);
      const strike = env.fleet(sc.strike);
      assert.deepStrictEqual([strike.state, strike.targetSystemId], ["TRAVELLING", S.N6]);
      const detail = JSON.parse(pin.detail_json);
      assert.strictEqual(pin.until_at, detail.arriveAt + cfg.hunt.pinGraceMs, "strike ETA + grace < pinMs");
      assert.strictEqual(detail.arriveAt, strike.route.arriveAt);
      const expireCount = () => env.n("SELECT count(*) AS n FROM world_scheduled_events WHERE event_type = "
        + "'HUNT_PIN_EXPIRE'");
      assert.strictEqual(expireCount(), 1);
      const again = env.scheduler.enqueue("HUNT_SCAN", String(S.N6), sc.p.arriveAt, { systemId: S.N6,
        at: sc.p.arriveAt, hunterFleetId: sc.hunter }, sc.scanKey);
      assert.deepStrictEqual([again.ok, again.duplicate], [true, true]);

      env.stop();
      env.store.close("restart");
      env = boot(reopen(), shared, cfg);
      assert.strictEqual(env.ctx.hunt.getState(), "running");
      await env.drive(shared.clock.now() + 1000);
      assert.strictEqual(env.pins().length, 1);
      assert.strictEqual(env.n("SELECT count(*) AS n FROM world_operations WHERE operation_type = 'intercept'"), 1);
      assert.strictEqual(expireCount(), 1);
    } finally {
      env.stop();
    }
  }));

  needsDriver("TH3 hunt departure guard: target and hunter FLEET_PINNED; ok after hunt.stop(); pinned again "
    + "after a new start; ok after until_at", () => H.withStore(driver, async (reopen) => {
    const env = boot(reopen(), H.sharedOf(), testConfig());
    try {
      const sc = await scene(env);
      const pin = env.pins()[0];
      assert.ok(pin, "pin created");
      toPlanned(env, sc.target, GURISTAS, S.N6, S.N7, "target");
      toPlanned(env, sc.hunter, SANSHA, S.N6, S.N5, "hunter2");
      const go = (id, to, tag) => env.fleets.planTravel({ fleetId: id, targetSystemId: to }, `test:go:${tag}`);
      for (const [id, to, tag] of [[sc.target, S.N7, "t1"], [sc.hunter, S.N5, "h1"]]) {
        const r = go(id, to, tag);
        assert.deepStrictEqual([r.ok, r.reason, r.detail], [false, "FLEET_PINNED", pin.pin_id], tag);
      }
      env.ctx.hunt.stop("test");
      const t = go(sc.target, S.N7, "t2");
      assert.strictEqual(t.ok, true, JSON.stringify(t));
      const again = huntDef().start(env.ctx, { logger: { log() {} } });
      assert.deepStrictEqual(again, { ok: true });
      assert.strictEqual(go(sc.hunter, S.N5, "h2").reason, "FLEET_PINNED");
      env.shared.clock.set(pin.until_at);
      const h = go(sc.hunter, S.N5, "h3");
      assert.strictEqual(h.ok, true, JSON.stringify(h));
      assert.ok(env.ctx.hunt.getStatus().counters.departurePinned >= 1);
    } finally {
      env.stop();
    }
  }));

  needsDriver("TH4 hunt expiry: strike arrived -> STRUCK; hunter destroyed before the strike -> BROKEN, the "
    + "scheduled expiry after it -> ALREADY_CLOSED (pin version unchanged)", async () => {
    await H.withStore(driver, async (reopen) => {
      const env = boot(reopen(), H.sharedOf(), testConfig());
      try {
        await scene(env);
        const pin = env.pins()[0];
        await env.drive(pin.until_at + env.cfg.battle.engageDelayMs);
        const closed = env.pins()[0];
        assert.deepStrictEqual([closed.state, closed.outcome, closed.version], ["CLOSED", "STRUCK", 2]);
        assert.strictEqual(env.n("SELECT count(*) AS n FROM world_event_journal WHERE event_type = 'HUNT_PIN_CLOSED'"),
          1);
      } finally {
        env.stop();
      }
    });
    await H.withStore(driver, async (reopen) => {
      const env = boot(reopen(), H.sharedOf(), testConfig());
      try {
        const sc = await scene(env);
        const pin = env.pins()[0];
        env.tx((db) => {
          const repo = env.fleets.repository;
          const f = repo.getFleet(db, sc.hunter).fleet;
          const e = repo.transition(db, { fleetId: sc.hunter, expectedVersion: f.version, from: f.state,
            to: "ENGAGED" }, "test:engage:hunter");
          assert.ok(e.ok, JSON.stringify(e));
          const l = repo.applyLosses(db, { fleetId: sc.hunter, expectedVersion: e.version,
            losses: [{ hullGroup: "tackle", typeId: null, count: 10 }] }, "test:loss:hunter");
          assert.ok(l.ok && l.destroyed, JSON.stringify(l));
        });
        const now = env.shared.clock.now();
        const early = env.scheduler.enqueue("HUNT_PIN_EXPIRE", pin.pin_id, now, { pinId: pin.pin_id },
          "test:expire:early");
        assert.ok(early.ok, JSON.stringify(early));
        await env.drive(now);
        const broken = env.pins()[0];
        assert.deepStrictEqual([broken.state, broken.outcome, broken.version], ["CLOSED", "BROKEN", 2]);
        await env.drive(pin.until_at + env.cfg.battle.engageDelayMs);
        const ev = env.q("SELECT state, outcome FROM world_scheduled_events WHERE idempotency_key = ?",
          `hunt:pin:${pin.pin_id}:expire`)[0];
        assert.deepStrictEqual(ev, { state: "DONE", outcome: "ALREADY_CLOSED" });
        assert.deepStrictEqual([env.pins()[0].outcome, env.pins()[0].version], ["BROKEN", 2]);
        assert.strictEqual(env.ctx.hunt.getStatus().counters.pinsBroken, 1);
      } finally {
        env.stop();
      }
    });
  });

  needsDriver("TH5 hunt overdue pins (expiry never ran): the hunter's and the target's old ACTIVE pins do not "
    + "hold the limits (max 1), the scan closes them (decideExpire) and pins anew", () => H.withStore(driver,
    async (reopen) => {
      const cfg = testConfig();
      cfg.hunt.maxActivePins = 1;
      cfg.hunt.maxActivePinsPerFaction = 1;
      const env = boot(reopen(), H.sharedOf(), cfg);
      try {
        const stale = (tag, hunterFleetId, targetFleetId) => ({ pinId: `hp_stale_${tag}`,
          idempotencyKey: `test:stale:${tag}`, factionId: SANSHA, hunterFleetId, systemId: S.N6, targetFleetId,
          targetFactionId: GURISTAS, strikeOperationId: `op_ghost_${tag}`, strikeFleetId: `fl_ghost_s_${tag}`,
          pinnedAt: 0, untilAt: 1, detail: {} });
        const sc = await scene(env, (e, f) => e.tx((db) => {
          for (const spec of [stale("a", f.hunter, "fl_ghost_t"), stale("b", "fl_ghost_h", f.target)]) {
            const r = e.ctx.hunt.repository.createPin(db, spec);
            assert.ok(r.ok, JSON.stringify(r));
          }
        }));
        const scan = env.q("SELECT state, outcome FROM world_scheduled_events WHERE idempotency_key = ?", sc.scanKey)[0];
        assert.deepStrictEqual(scan, { state: "DONE", outcome: "PIN" }, JSON.stringify(env.ctx.hunt.getStatus()));
        const byId = new Map(env.pins().map((p) => [p.pin_id, p]));
        assert.strictEqual(byId.size, 3);
        assert.deepStrictEqual([byId.get("hp_stale_a").state, byId.get("hp_stale_a").outcome], ["CLOSED", "CANCELLED"]);
        assert.deepStrictEqual([byId.get("hp_stale_b").state, byId.get("hp_stale_b").outcome], ["CLOSED", "BROKEN"]);
        const fresh = [...byId.values()].filter((p) => p.state === "ACTIVE");
        assert.deepStrictEqual(fresh.map((p) => [p.hunter_fleet_id, p.target_fleet_id]), [[sc.hunter, sc.target]]);
        assert.strictEqual(env.n("SELECT count(*) AS n FROM world_event_journal WHERE event_type = 'HUNT_PIN_CLOSED'"),
          2);
        const c = env.ctx.hunt.getStatus().counters;
        assert.deepStrictEqual([c.pinsCreated, c.pinsCancelled, c.pinsBroken], [1, 1, 1]);
      } finally {
        env.stop();
      }
    }));

  needsDriver("TH6 strikeScanMaxFleets counts IDLE fleets of a strike role; more IDLE "
    + "fleets of other roles with lower ids than the limit do not hide the strike fleet (was no candidate)",
  () => H.withStore(driver, async (reopen) => {
    const cfg = testConfig();
    cfg.hunt.strikeScanMaxFleets = 2;
    const env = boot(reopen(), H.sharedOf(), cfg);
    try {
      const others = ["r1", "r2", "r3"].map((tag) => newFleet(env, tag, SANSHA, S.N0, "reserve",
        [{ hullGroup: "cruiser", count: 4 }]));
      const sc = await scene(env);
      assert.ok(others.every((id) => id < sc.strike), JSON.stringify({ others, strike: sc.strike }));
      const scan = env.q("SELECT state, outcome FROM world_scheduled_events WHERE idempotency_key = ?", sc.scanKey)[0];
      assert.deepStrictEqual(scan, { state: "DONE", outcome: "PIN" }, JSON.stringify(env.ctx.hunt.getStatus()));
      assert.deepStrictEqual(env.pins().map((p) => [p.hunter_fleet_id, p.target_fleet_id, p.strike_fleet_id]),
        [[sc.hunter, sc.target, sc.strike]]);
    } finally {
      env.stop();
    }
  }));

  needsDriver("TH7 role pages merged in fleet_id order and cut to strikeScanMaxFleets = 1 -> the "
    + "lower-id patrol strikes, not the nearer higher-id invasion fleet",
  () => H.withStore(driver, async (reopen) => {
    const cfg = testConfig();
    cfg.hunt.strikeScanMaxFleets = 1;
    const env = boot(reopen(), H.sharedOf(), cfg);
    try {
      const patrol = newFleet(env, "patrol", SANSHA, S.L1, "patrol", [{ hullGroup: "battleship", count: 20 }]);
      const sc = await scene(env);
      assert.ok(patrol < sc.strike, JSON.stringify({ patrol, strike: sc.strike }));
      const scan = env.q("SELECT state, outcome FROM world_scheduled_events WHERE idempotency_key = ?", sc.scanKey)[0];
      assert.deepStrictEqual(scan, { state: "DONE", outcome: "PIN" }, JSON.stringify(env.ctx.hunt.getStatus()));
      assert.deepStrictEqual(env.pins().map((p) => [p.hunter_fleet_id, p.target_fleet_id, p.strike_fleet_id]),
        [[sc.hunter, sc.target, patrol]]);
    } finally {
      env.stop();
    }
  }));
};
