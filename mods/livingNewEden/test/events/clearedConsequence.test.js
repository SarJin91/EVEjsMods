"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { MIGRATIONS, JOURNAL_TABLE } = require("../../lib/persistence/migrations");
const { openStore } = require("../../lib/persistence/store");
const { createJournal } = require("../../lib/persistence/journal");
const { seedDbFile } = require("../_support/dbTemplate");
const { resolveConfig } = require("../../config");
const { createManualClock } = require("../../lib/util/clock");
const { createIdGenerator } = require("../../lib/util/ids");
const { createRng } = require("../../lib/util/rng");
const { startScheduler } = require("../../lib/scheduler");
const { createWorldStateRepository } = require("../../lib/world/worldStateRepository");
const { createOccupationService } = require("../../lib/world/occupation/occupationService");
const { createUnavailableOccupation } = require("../../lib/world/occupation");
const { createSiteService } = require("../../lib/events/sites/siteService");
const siteRepository = require("../../lib/events/sites/siteRepository");
const repo = require("../../lib/events/eventRepository");
const { createEventService } = require("../../lib/events/eventService");
const { startEvents, pulseRowBound } = require("../../lib/events");
const { validateCatalog, EVENT_CATALOG } = require("../../lib/events/catalog");
const { harness: H } = require("../battle/settlement.test");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const I = 300000;
const T0 = 5666667 * I;
const SANSHA = 500019;
const AMARR = 500003;
const SYS = 30001001;
const LIMITS = Object.freeze({ maxFactionsPerSystem: 8, maxBatchReadIds: 400, maxListLimit: 500 });
const CATALOG = validateCatalog(EVENT_CATALOG).catalog;
const POINTS = Object.freeze({ EVEJS_LNE_EVENTS_CLEARED_INFLUENCE_POINTS: "5" });
const OFF = Object.freeze({ EVEJS_LNE_EVENTS_CLEARED_INFLUENCE_POINTS: "0" });
const GRAPH = { getGraph: () => ({ ok: true, graph: { getSystem: (id) => ({ id, regionId: 10000060 }) } }) };

function configOf(env = {}) {
  const r = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_DATA_ROOT: os.tmpdir(), EVEJS_LNE_EVENTS_ENABLED: "1",
    EVEJS_LNE_SITES_ENABLED: "1", EVEJS_LNE_EVENTS_PRESENCE_ACTIVATION: "0", ...env } });
  assert.deepStrictEqual(r.errors, []);
  return r.config;
}

function fakeTelemetry() {
  const counters = {};
  return { counters, count(name, n = 1) { counters[name] = (counters[name] || 0) + n; return true; },
    gauge() { return true; }, observe() { return true; } };
}

function withEnv(driver, fn, { env = {} } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lne-cleared-"));
  const file = path.join(tmp, "world.sqlite");
  let store = null;
  let scheduler = null;
  try {
    seedDbFile(driver, file, { migrations: MIGRATIONS, seed: 1 });
    const opened = openStore({ filePath: file, openDatabase: (f) => new driver.Database(f), exclusiveLock: true,
      busyTimeoutMs: 0, maxRowsPerTransaction: 500, maxWriteMsPerPass: 5, randomSeed: () => 1,
      migrations: MIGRATIONS });
    assert.ok(opened.ok, JSON.stringify(opened));
    store = opened.store;
    const clock = createManualClock(T0);
    const ids = createIdGenerator({ clock, rng: createRng(7) });
    const config = configOf(env);
    const telemetry = fakeTelemetry();
    const journal = createJournal({ clock, maxPayloadBytes: 16384, maxRows: 500 });
    const worldRepo = createWorldStateRepository({ journal, clock, limits: LIMITS });
    const sr = startScheduler({ config: H.CONFIG, persistence: { ok: true, store }, clock, ids, nowMs: () => 0 });
    assert.ok(sr.ok, JSON.stringify(sr));
    scheduler = sr.scheduler;
    const sites = createSiteService({ store, adapter: {}, clock, config, telemetry, logger: { log() {} } });
    const strategy = { listActiveCampaigns: () => ({ ok: true, campaigns: [] }),
      getCampaign: () => ({ ok: false, reason: "CAMPAIGN_INACTIVE" }) };
    const occupation = createOccupationService({ store, journal, repository: worldRepo, fleets: null, scheduler,
      graph: GRAPH, getStations: () => null, clock, config });
    const spy = { calls: [] };
    const spied = { dropInfluenceInTx(tx, spec, key) {
      spy.calls.push([spec, key]);
      return occupation.dropInfluenceInTx(tx, spec, key);
    } };
    const lines = [];
    const tx = (f) => {
      const r = store.transaction("test", f);
      assert.ok(r.ok, JSON.stringify(r));
      return r.value;
    };
    const e = {
      store, clock, config, telemetry, worldRepo, scheduler, occupation, spied, spy, lines, tx,
      make: (occ, catalog = CATALOG) => createEventService({ config, store, clock, ids, scheduler,
        world: () => ({ repository: worldRepo }), strategy: () => strategy, presence: () => null, graph: () => GRAPH,
        sites: () => sites, telemetry, logger: { log: (l) => lines.push(l) }, catalog, worldSeed: opened.worldSeed,
        nowMs: () => 0,
        ...(occ === undefined ? {} : { occupation: occ }) }),
      pulse(svc, at) {
        clock.set(at);
        const res = svc.pulseHandler({ payload: { intervalMs: I, round: Math.floor(at / I) } },
          { now: at, anchorAt: at, lateMs: 0, catchUp: false });
        assert.ok(res.ok, JSON.stringify(res));
        let value;
        const r = store.transaction("test.complete", (db) => {
          value = res.effect(db);
          const n = res.reschedule;
          return scheduler.enqueue(n.eventType, n.aggregateId, n.dueAt, n.payload, n.idempotencyKey, { tx: db });
        });
        assert.ok(r.ok, JSON.stringify(r));
        res.onCommitted(value);
        return value;
      },
      events: () => tx((db) => db.prepare("SELECT * FROM world_events ORDER BY created_at, event_id").all()
        .map(repo.rowOf)),
      rawEvents: () => tx((db) => db.prepare("SELECT state, version, result_reference, result_json, due_at "
        + "FROM world_events ORDER BY created_at, event_id").all()),
      system: () => tx((db) => e.worldRepo.getSystem(db, SYS, { includeInfluence: true })).system,
      eventKeys: () => tx((db) => db.prepare(`SELECT idempotency_key AS k FROM ${JOURNAL_TABLE} `
        + "WHERE idempotency_key LIKE 'event:%'").all().map((r) => r.k)),
      findKey: (key) => tx((db) => journal.findByKey(db, key)),
      activeEvent(svc) {
        const a = tx((db) => worldRepo.applyChange(db, { systemId: SYS, expectedVersion: 0, reason: "SEED_CONTROL",
          state: { securityClass: "nullsec", controllerFactionId: AMARR },
          influence: [{ factionId: AMARR, influenceScore: 40 }, { factionId: SANSHA, influenceScore: 60 }] },
        "test:seed"));
        assert.ok(a.ok, JSON.stringify(a));
        e.setState({ occupationState: "CONTESTED", occupierFactionId: SANSHA });
        e.pulse(svc, T0);
        e.pulse(svc, T0 + I);
        const [ev] = e.events();
        assert.deepStrictEqual([ev.state, ev.factionId, ev.sitesCreated > 0], ["ACTIVE", SANSHA, true]);
        return ev;
      },
      setState(state) {
        const sys = e.system();
        const b = tx((db) => worldRepo.applyChange(db, { systemId: SYS, expectedVersion: sys.version,
          reason: "TEST_OCCUPATION", state }, `test:occ:${sys.version}`));
        assert.ok(b.ok, JSON.stringify(b));
      },
      sanshaControls(at) {
        e.setState({ occupationState: "STABLE", occupierFactionId: null, controllerFactionId: SANSHA,
          influenceEvaluatedAt: at });
      },
      completeSites(eventId) {
        tx((db) => {
          for (const row of siteRepository.listByEventInTx(db, eventId)) {
            const r = siteRepository.transitionInTx(db, row, { state: "COMPLETED", updated_at: clock.now() });
            assert.ok(r.ok, JSON.stringify(r));
          }
        });
      },
      influenceOf: (factionId) => e.system().influence.find((x) => x.factionId === factionId).influenceScore,
    };
    return fn(e);
  } finally {
    if (scheduler && typeof scheduler.stop === "function") scheduler.stop("test");
    if (store) store.close("test");
    try {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch (_err) {
    }
  }
}

module.exports = ({ test, skip }) => {
  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  needsDriver("CT1 APPLIED once: START_AFTERMATH drops the controller event faction by points under "
    + "event:<id>:cleared (EVENT_CLEARED), replay and the COMPLETING FINISH call nothing; FINISH/CLEARED straight "
    + "from ACTIVE after expiresAt clears too", () => {
    withEnv(driver, (e) => {
      const svc = e.make(() => e.spied);
      const ev = e.activeEvent(svc);
      const at = T0 + 2 * I;
      e.completeSites(ev.eventId);
      e.sanshaControls(at);
      const before = e.influenceOf(SANSHA);
      e.pulse(svc, at);
      const key = `event:${ev.eventId}:cleared`;
      assert.deepStrictEqual(e.spy.calls, [[{ systemId: SYS, factionId: SANSHA, points: 5, at,
        reason: "EVENT_CLEARED", allowNonController: true }, key]]);
      const done = e.events()[0];
      assert.strictEqual(done.state, "COMPLETING");
      assert.strictEqual(e.influenceOf(SANSHA), before - 5);
      const entry = e.findKey(key);
      assert.deepStrictEqual([entry.found, entry.entry.eventType], [true, "EVENT_CLEARED"]);
      assert.strictEqual(e.telemetry.counters["events.consequence.APPLIED"], 1);
      assert.ok(e.lines.includes(`events: cleared eventId=${ev.eventId} sys=${SYS} faction=${SANSHA} content=${SANSHA} points=5 `
        + `before=${before} next=${before - 5} written=true`), e.lines.join("\n"));
      e.pulse(svc, at);
      e.pulse(svc, done.dueAt);
      assert.deepStrictEqual([e.spy.calls.length, e.influenceOf(SANSHA), e.events()[0].state],
        [1, before - 5, "COMPLETED"], "replay and COMPLETING -> FINISH call nothing");
      const dup = e.tx((db) => e.occupation.dropInfluenceInTx(db, e.spy.calls[0][0], key));
      assert.deepStrictEqual(dup, { ok: true, outcome: "DUPLICATE" });
    }, { env: POINTS });
    withEnv(driver, (e) => {
      const svc = e.make(() => e.spied);
      const ev = e.activeEvent(svc);
      e.completeSites(ev.eventId);
      e.sanshaControls(ev.expiresAt);
      e.pulse(svc, ev.expiresAt);
      const done = e.events().find((x) => x.eventId === ev.eventId);
      assert.deepStrictEqual([done.state, done.resultReference, e.spy.calls.length,
        e.telemetry.counters["events.consequence.APPLIED"]], ["COMPLETED", "CLEARED", 1, 1]);
    }, { env: POINTS });
  });

  needsDriver("CT2 refusals keep the transition: a facade refusal OCCUPATION_STOPPED (log line, consequence.OTHER "
    + "no refusal.*, world untouched); throw -> OTHER, DUPLICATE -> DUPLICATE, refusal after a write -> OTHER and the write rolled "
    + "back (nested savepoint), APPLIED with next === before -> UNCHANGED", () => {
    withEnv(driver, (e) => {
      const stopped = { dropInfluenceInTx(tx, spec, key) {
        e.spy.calls.push([spec, key]);
        return { ok: false, reason: "OCCUPATION_STOPPED" };
      } };
      const svc = e.make(() => stopped);
      const ev = e.activeEvent(svc);
      e.completeSites(ev.eventId);
      const sysBefore = e.system();
      e.pulse(svc, T0 + 2 * I);
      assert.deepStrictEqual([e.events()[0].state, e.spy.calls.length], ["COMPLETING", 1]);
      const c = e.telemetry.counters;
      assert.strictEqual(c["events.consequence.OTHER"], 1);
      assert.deepStrictEqual(Object.keys(c).filter((k) => k.startsWith("events.refusal.")), []);
      assert.ok(e.lines.includes(`events: refused CONSEQUENCE eventId=${ev.eventId} reason=OCCUPATION_STOPPED`),
        e.lines.join("\n"));
      assert.deepStrictEqual([e.system(), e.eventKeys()], [sysBefore, []]);
    }, { env: POINTS });
    const variants = [
      ["OTHER", () => { throw new Error("boom"); }],
      ["DUPLICATE", () => ({ ok: true, outcome: "DUPLICATE" })],
      ["UNCHANGED", () => ({ ok: true, outcome: "APPLIED", written: true, before: 0, next: 0 })],
      ["OTHER", (e) => (tx) => {
        const sys = e.worldRepo.getSystem(tx, SYS, { includeInfluence: false }).system;
        const w = e.worldRepo.applyChange(tx, { systemId: SYS, expectedVersion: sys.version, reason: "TEST_WRITE",
          state: { occupationState: "STABLE" } }, "test:inner-write");
        if (!w.ok || w.duplicate) return { ok: false, reason: "TEST_WRITE_FAILED" };
        e.innerWrites = (e.innerWrites || 0) + 1;
        return { ok: false, reason: "OCCUPATION_STOPPED" };
      }],
    ];
    for (const [counter, make] of variants) {
      withEnv(driver, (e) => {
        assert.strictEqual(typeof e.occupation.dropInfluenceInTx, "function", "fake = method name of the facade");
        const impl = make.length === 0 ? make : make(e);
        const fake = { dropInfluenceInTx: (tx) => impl(tx) };
        const svc = e.make(() => fake);
        const ev = e.activeEvent(svc);
        e.completeSites(ev.eventId);
        const sysBefore = e.system();
        e.pulse(svc, T0 + 2 * I);
        assert.strictEqual(e.events()[0].state, "COMPLETING");
        assert.strictEqual(e.telemetry.counters[`events.consequence.${counter}`], 1, counter);
        assert.deepStrictEqual([e.system(), e.findKey("test:inner-write").found], [sysBefore, false]);
        if (make.length > 0) assert.strictEqual(e.innerWrites, 1, "the inner write ran before the refusal");
      }, { env: POINTS });
    }
  });

  needsDriver("CT3 off =: no dep / points 0 / unavailable stub / null getter -> identical rows and "
    + "counters, zero calls, no event: key; pulseRowBound 118 -> 198 with points, EVENTS_ROW_BOUND at 150", () => {
    const run = (env, occOf) => withEnv(driver, (e) => {
      const svc = e.make(occOf(e));
      const ev = e.activeEvent(svc);
      e.completeSites(ev.eventId);
      e.sanshaControls(T0 + 2 * I);
      e.pulse(svc, T0 + 2 * I);
      assert.deepStrictEqual([e.spy.calls.length, e.eventKeys()], [0, []]);
      return { rows: e.rawEvents(), counters: e.telemetry.counters };
    }, { env });
    const base = run(POINTS, () => undefined);
    assert.strictEqual(base.rows[0].state, "COMPLETING");
    assert.deepStrictEqual(run(OFF, (e) => () => e.spied), base);
    assert.deepStrictEqual(run(POINTS, () => () => createUnavailableOccupation("OCCUPATION_DISABLED")), base);
    assert.deepStrictEqual(run(POINTS, () => () => null), base);
    assert.deepStrictEqual([pulseRowBound(configOf(OFF)), pulseRowBound(configOf(POINTS)), pulseRowBound(configOf())],
      [118, 198, 198]);
    withEnv(driver, (e) => {
      const start = (env) => startEvents({ config: configOf({ EVEJS_LNE_PERSISTENCE_MAX_ROWS_PER_TRANSACTION: "150",
        ...env }), persistence: { ok: true, store: e.store, worldSeed: 1 }, clock: e.clock, ids: { next: () => "x" },
      scheduler: e.scheduler });
      assert.strictEqual(start(POINTS).reason, "EVENTS_ROW_BOUND");
      const ok = start(OFF);
      assert.ok(ok.ok, JSON.stringify(ok));
      ok.events.stop();
    });
  });

  needsDriver("CT4 EXPIRE, CANCEL and QUARANTINE from ACTIVE with points on and Sansha the "
    + "controller: no dropInfluenceInTx call, no events.consequence.* counter, influence and event: keys untouched",
  () => {
    const cases = [
      ["EXPIRE", "COMPLETED", "EXPIRED", (e, ev, svc) => {
        e.sanshaControls(ev.expiresAt);
        e.pulse(svc, ev.expiresAt);
      }],
      ["CANCEL", "CANCELLED", "CAUSE_GONE", (e, ev, svc) => {
        e.sanshaControls(T0 + 2 * I);
        e.pulse(svc, T0 + 2 * I);
      }],
      ["QUARANTINE", "QUARANTINED", "CATALOG_MISSING", (e, ev) => {
        const byType = Object.fromEntries(Object.entries(CATALOG.byType).filter(([k]) => k !== ev.eventType));
        const svc = e.make(() => e.spied, { ...CATALOG, byType });
        e.sanshaControls(T0 + 2 * I);
        e.pulse(svc, T0 + 2 * I);
      }],
    ];
    const seen = cases.map(([action, , , step]) => withEnv(driver, (e) => {
      const svc = e.make(() => e.spied);
      const ev = e.activeEvent(svc);
      const before = e.influenceOf(SANSHA);
      step(e, ev, svc);
      const done = e.events().find((x) => x.eventId === ev.eventId);
      return [action, done.state, done.resultReference, e.spy.calls.length, e.influenceOf(SANSHA) - before,
        e.eventKeys(), Object.keys(e.telemetry.counters).filter((k) => k.startsWith("events.consequence."))];
    }, { env: POINTS }));
    assert.deepStrictEqual(seen, cases.map(([action, state, result]) => [action, state, result, 0, 0, [], []]));
  });

  needsDriver("WEC4 default 20 points, the claimant (not the "
    + "controller) of pirate_incursion loses them under event:<id>:cleared, a replay is DUPLICATE; a row without "
    + "reason.contentFactionId drops factionId, a row with it drops the content faction", () => {
    withEnv(driver, (e) => {
      const svc = e.make(() => e.spied);
      const ev = e.activeEvent(svc);
      assert.strictEqual(ev.reason.contentFactionId, SANSHA, "SELF type: content = cause faction");
      e.completeSites(ev.eventId);
      const at = T0 + 2 * I;
      assert.deepStrictEqual([e.system().occupationState, e.system().controllerFactionId], ["CONTESTED", AMARR]);
      e.pulse(svc, at);
      const key = `event:${ev.eventId}:cleared`;
      assert.deepStrictEqual([e.spy.calls.length, e.spy.calls[0][1], e.spy.calls[0][0].points], [1, key, 20]);
      assert.deepStrictEqual([e.influenceOf(SANSHA), e.influenceOf(AMARR)], [40, 40]);
      assert.strictEqual(e.telemetry.counters["events.consequence.APPLIED"], 1);
      assert.strictEqual(e.findKey(key).found, true);
      e.pulse(svc, at);
      const dup = e.tx((db) => e.occupation.dropInfluenceInTx(db, e.spy.calls[0][0], key));
      assert.deepStrictEqual([dup, e.spy.calls.length, e.influenceOf(SANSHA)],
        [{ ok: true, outcome: "DUPLICATE" }, 1, 40]);
    });
    const contentRun = (reason) => withEnv(driver, (e) => {
      const svc = e.make(() => e.spied);
      const ev = e.activeEvent(svc);
      e.tx((db) => db.prepare("UPDATE world_events SET reason_json = ? WHERE event_id = ?")
        .run(JSON.stringify(reason(ev.reason)), ev.eventId));
      e.completeSites(ev.eventId);
      e.pulse(svc, T0 + 2 * I);
      return [e.spy.calls.map(([spec]) => spec.factionId), e.influenceOf(SANSHA), e.influenceOf(AMARR)];
    });
    const v1 = contentRun((r) => {
      const { contentFactionId, ...rest } = r;
      return rest;
    });
    assert.deepStrictEqual(v1, [[SANSHA], 40, 40], "v1 row -> factionId");
    assert.deepStrictEqual(contentRun((r) => ({ ...r, contentFactionId: AMARR })), [[AMARR], 60, 20],
      "content faction of the row");
  });

  needsDriver("CT5 the facade closes tx and throws: clearConsequence gives the original error up "
    + "(as inSavepoint), the pulse transaction fails with it and the event stays ACTIVE, no consequence counter", () => {
    withEnv(driver, (e) => {
      const boom = new Error("closed-boom");
      const fake = { dropInfluenceInTx: (tx) => {
        tx.exec("ROLLBACK");
        throw boom;
      } };
      const svc = e.make(() => fake);
      const ev = e.activeEvent(svc);
      e.completeSites(ev.eventId);
      const at = T0 + 2 * I;
      e.clock.set(at);
      const res = svc.pulseHandler({ payload: { intervalMs: I, round: Math.floor(at / I) } },
        { now: at, anchorAt: at, lateMs: 0, catchUp: false });
      assert.ok(res.ok, JSON.stringify(res));
      const r = e.store.transaction("test.complete", (db) => res.effect(db));
      assert.strictEqual(r.ok, false);
      assert.strictEqual(r.error, boom, `the original error, got ${r.error && r.error.message}`);
      assert.strictEqual(e.events().find((x) => x.eventId === ev.eventId).state, "ACTIVE");
      assert.deepStrictEqual(Object.keys(e.telemetry.counters).filter((k) => k.startsWith("events.consequence.")),
        []);
    }, { env: POINTS });
  });
};
