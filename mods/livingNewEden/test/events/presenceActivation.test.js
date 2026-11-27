"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { MIGRATIONS } = require("../../lib/persistence/migrations");
const { openStore } = require("../../lib/persistence/store");
const { createJournal } = require("../../lib/persistence/journal");
const { seedDbFile } = require("../_support/dbTemplate");
const { resolveConfig } = require("../../config");
const { createManualClock } = require("../../lib/util/clock");
const { createIdGenerator } = require("../../lib/util/ids");
const { createRng } = require("../../lib/util/rng");
const { startScheduler } = require("../../lib/scheduler");
const { createWorldStateRepository } = require("../../lib/world/worldStateRepository");
const { createSiteService } = require("../../lib/events/sites/siteService");
const siteRepository = require("../../lib/events/sites/siteRepository");
const repo = require("../../lib/events/eventRepository");
const { createEventService } = require("../../lib/events/eventService");
const { startEvents } = require("../../lib/events");
const { decideEventStep } = require("../../lib/events/eventMachine");
const { validateCatalog, EVENT_CATALOG } = require("../../lib/events/catalog");
const { createUnavailablePresence } = require("../../lib/presence");
const { createViewRegistry } = require("../../lib/observer/views");
const { harness: H } = require("../battle/settlement.test");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const I = 300000;
const N = 30000;
const T0 = 5666667 * I;
const SANSHA = 500019;
const SYS = [30001001, 30001002, 30001003];
const LIMITS = Object.freeze({ maxFactionsPerSystem: 8, maxBatchReadIds: 400, maxListLimit: 500 });
const CATALOG = validateCatalog(EVENT_CATALOG).catalog;
const ON = Object.freeze({ EVEJS_LNE_EVENTS_PRESENCE_ACTIVATION: "1" });
const OFF = Object.freeze({ EVEJS_LNE_EVENTS_PRESENCE_ACTIVATION: "0" });

function configOf(env = {}) {
  const r = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_DATA_ROOT: os.tmpdir(), EVEJS_LNE_EVENTS_ENABLED: "1",
    EVEJS_LNE_SITES_ENABLED: "1", ...env } });
  assert.deepStrictEqual(r.errors, []);
  return r.config;
}

function fakeTelemetry() {
  const counters = {};
  const gauges = {};
  return { counters, gauges, count(name, n = 1) { counters[name] = (counters[name] || 0) + n; return true; },
    gauge(name, v) { gauges[name] = v; return true; }, observe() { return true; } };
}

function fakePresence() {
  const st = { available: true, stale: false, dist: new Map(), listeners: new Set(), subs: 0 };
  const facade = {
    getStatus: () => ({ available: st.available, stale: st.stale }),
    distanceToObserved: (systemId, radius) => {
      const d = st.dist.get(systemId);
      return { ok: true, distance: d !== undefined && d <= radius ? d : null };
    },
    onSystemObserved(cb) {
      st.subs += 1;
      st.listeners.add(cb);
      return { ok: true, unsubscribe: () => { st.listeners.delete(cb); } };
    },
  };
  return { facade, st, emit: (systemId) => { for (const cb of [...st.listeners]) cb(systemId); } };
}

function manualTimers() {
  const pending = [];
  return {
    pending,
    setTimer(fn, ms) {
      const t = { fn, ms, cancelled: false, cancel() { t.cancelled = true; } };
      pending.push(t);
      return t;
    },
    run() {
      for (const t of pending.splice(0)) if (!t.cancelled) t.fn();
    },
  };
}

const GRAPH = { getGraph: () => ({ ok: true, graph: { getSystem: (id) => ({ id, regionId: 10000060 }) } }) };

function withEnv(driver, fn, { env = {} } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lne-presence-act-"));
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
    const enqueued = [];
    const recording = { ...scheduler, enqueue(...args) {
      enqueued.push(args);
      return scheduler.enqueue(...args);
    } };
    const realSites = createSiteService({ store, adapter: {}, clock, config, telemetry, logger: { log() {} } });
    const calls = { create: [] };
    const sites = { ...realSites, createSiteInTx(tx, req) {
      calls.create.push(`${req.eventId}:${req.slot}`);
      return realSites.createSiteInTx(tx, req);
    } };
    const strategy = { listActiveCampaigns: () => ({ ok: true, campaigns: [] }),
      getCampaign: () => ({ ok: false, reason: "CAMPAIGN_INACTIVE" }) };
    const presence = fakePresence();
    const timers = manualTimers();
    const lines = [];
    const occReads = { n: 0 };
    const world = { repository: { ...worldRepo, listActiveOccupations(...a) {
      occReads.n += 1;
      return worldRepo.listActiveOccupations(...a);
    } } };
    const tx = (f) => {
      const r = store.transaction("test", f);
      assert.ok(r.ok, JSON.stringify(r));
      return r.value;
    };
    const e = {
      store, clock, config, telemetry, worldRepo, scheduler, enqueued, calls, presence, timers, lines, occReads, tx,
      make: (over = {}) => createEventService({ config: over.config || config, store, clock, ids,
        scheduler: recording, world: () => world, strategy: () => strategy, presence: () => presence.facade,
        graph: () => GRAPH, sites: () => sites, telemetry, logger: { log: (l) => lines.push(l) }, catalog: CATALOG,
        worldSeed: opened.worldSeed, nowMs: () => 0, repository: over.repository, setTimer: timers.setTimer }),
      pulse(svc, at, opts = {}) {
        clock.set(at);
        const payload = opts.boot ? { intervalMs: I, round: Math.floor(at / I), boot: true }
          : opts.nudge !== undefined ? { intervalMs: I, nudge: opts.nudge }
            : { intervalMs: I, round: Math.floor(at / I) };
        const res = svc.pulseHandler({ payload }, { now: at, anchorAt: at, lateMs: 0, catchUp: false });
        assert.ok(res.ok, JSON.stringify(res));
        let value;
        const r = store.transaction("test.complete", (db) => {
          value = res.effect(db);
          const n = res.reschedule;
          return scheduler.enqueue(n.eventType, n.aggregateId, n.dueAt, n.payload, n.idempotencyKey, { tx: db });
        });
        assert.ok(r.ok, JSON.stringify(r));
        res.onCommitted(value);
        return { res, value };
      },
      events: () => tx((db) => db.prepare("SELECT * FROM world_events ORDER BY created_at, event_id").all()
        .map(repo.rowOf)),
      siteRows: (eventId) => tx((db) => siteRepository.listByEventInTx(db, eventId)),
      count: (table) => tx((db) => db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n),
      nudges: () => enqueued.filter((a) => String(a[4]).startsWith("events:nudge:")),
      seedSystem(systemId) {
        const a = tx((db) => worldRepo.applyChange(db, { systemId, expectedVersion: 0, reason: "SEED_CONTROL",
          state: { securityClass: "nullsec", controllerFactionId: 500003 } }, `test:seed:${systemId}`));
        assert.ok(a.ok, JSON.stringify(a));
        const sys = tx((db) => worldRepo.getSystem(db, systemId, { includeInfluence: false })).system;
        const b = tx((db) => worldRepo.applyChange(db, { systemId, expectedVersion: sys.version,
          reason: "TEST_OCCUPATION", state: { occupationState: "CONTESTED", occupierFactionId: SANSHA } },
        `test:occ:${systemId}`));
        assert.ok(b.ok, JSON.stringify(b));
      },
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

  needsDriver("PT1 flag off =: PLANNED far from players activates at the next pulse, result_json "
    + "without activation, no subscription, no nudge; decideEventStep without activation === with null", () =>
    withEnv(driver, (e) => {
      const facadeKeys = Object.keys(createUnavailablePresence("x"));
      for (const k of Object.keys(e.presence.facade)) assert.ok(facadeKeys.includes(k), `presence has no ${k}`);
      assert.strictEqual(resolveConfig({ modDir: MOD_DIR, env: {} }).config.events.presenceActivation, true);
      assert.strictEqual(e.config.events.presenceActivation, false, "off by env");
      e.seedSystem(SYS[0]);
      const svc = e.make();
      e.pulse(svc, T0);
      e.timers.run();
      e.pulse(svc, T0 + I);
      e.timers.run();
      const [ev] = e.events();
      assert.deepStrictEqual([ev.state, ev.sitesCreated, ev.result, e.calls.create.length],
        ["ACTIVE", ev.templateIds.length, null, ev.templateIds.length]);
      assert.deepStrictEqual([e.presence.st.subs, e.nudges().length, e.timers.pending.length], [0, 0, 0]);
      assert.deepStrictEqual(e.lines.filter((l) => /^events: (activate|wait|nudge)/.test(l)), []);
      const st = svc.getStatus();
      assert.deepStrictEqual([st.presenceActivation, st.trigger, st.waiting], [false, null, null]);
      const row = { state: "PLANNED", dueAt: T0, expiresAt: T0 + 3600000, sitesCreated: 0, createdAt: T0 };
      for (const now of [T0 - 1, T0]) {
        const facts = { now, type: CATALOG.types[0], causeHolds: true, siteStates: [] };
        assert.deepStrictEqual(decideEventStep(row, facts), decideEventStep(row, { ...facts, activation: null }));
      }
      const wide = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_EVENTS_ACTIVATION_RADIUS: "3" } });
      assert.ok(wide.warnings.includes("events.activationRadius=3 above events.presenceRadius=2 (effective 2)"),
        wide.warnings.join("\n"));
      const long = configOf({ ...ON, EVEJS_LNE_EVENTS_PLANNED_WAIT_MS: "86400000" });
      const started = startEvents({ config: long, persistence: { ok: true, store: e.store, worldSeed: 1 },
        clock: e.clock, ids: { next: () => "x" }, scheduler: e.scheduler, setTimer: e.timers.setTimer });
      assert.ok(started.ok, JSON.stringify(started));
      const st2 = started.events.getStatus();
      started.events.stop();
      assert.deepStrictEqual([st2.warnings, st2.presenceActivation], [["EVENTS_PLANNED_WAIT_ABOVE_DURATION"], true]);
      const warnOf = (env) => resolveConfig({ modDir: MOD_DIR, env }).warnings.filter((w) => w.startsWith("events."));
      assert.deepStrictEqual([warnOf({ ...OFF, EVEJS_LNE_EVENTS_ACTIVATION_RADIUS: "3" }),
        warnOf({ EVEJS_LNE_EVENTS_ENABLED: "1", EVEJS_LNE_PRESENCE_ENABLED: "0" }),
        warnOf({ ...OFF, EVEJS_LNE_EVENTS_ENABLED: "1", EVEJS_LNE_PRESENCE_ENABLED: "0" }),
        warnOf({ EVEJS_LNE_PRESENCE_ENABLED: "0" })],
      [[], ["events.presenceActivation without modules.presence - the PLANNED events never activate"], [], []]);
    }, { env: OFF }));

  needsDriver("PT2 flag on: player far / at 2 jumps -> NONE; at 1 jump -> ACTIVE once with the sites and "
    + "activation.trigger=presence; second pulse, nudge pulse and leaving -> no new site, ACTIVE stays", () =>
    withEnv(driver, (e) => {
      e.seedSystem(SYS[0]);
      const svc = e.make();
      e.pulse(svc, T0);
      e.pulse(svc, T0 + I);
      e.presence.st.dist.set(SYS[0], 2);
      e.pulse(svc, T0 + 2 * I);
      let [ev] = e.events();
      assert.deepStrictEqual([ev.state, e.calls.create.length, svc.getStatus().waiting], ["PLANNED", 0, 1]);
      e.presence.st.dist.set(SYS[0], 1);
      e.pulse(svc, T0 + 3 * I);
      [ev] = e.events();
      const slots = ev.templateIds.length;
      assert.deepStrictEqual([ev.state, ev.sitesCreated, e.calls.create.length, ev.result],
        ["ACTIVE", slots, slots, { activation: { trigger: "presence", distance: 1 } }]);
      assert.ok(e.lines.includes(`events: activate eventId=${ev.eventId} sys=${SYS[0]} trigger=presence distance=1 `
        + `type=${ev.eventType} cause=${ev.cause} faction=${SANSHA}`), e.lines.join("\n"));
      e.pulse(svc, T0 + 4 * I);
      e.pulse(svc, T0 + 4 * I + 1000, { nudge: Math.floor((T0 + 4 * I) / N) });
      e.presence.st.dist.delete(SYS[0]);
      e.pulse(svc, T0 + 5 * I);
      [ev] = e.events();
      assert.deepStrictEqual([ev.state, e.calls.create.length, e.siteRows(ev.eventId).length, e.count("world_events")],
        ["ACTIVE", slots, slots, 1]);
      const c = e.telemetry.counters;
      assert.deepStrictEqual([c["events.activatedByPresence"], c["events.activated"]], [1, 1]);
    }, { env: ON }));

  needsDriver("PT3 no spawn bubble: observed without a PLANNED event in range -> no enqueue, no site; in range "
    + "-> one nudge events:nudge:<I>:<N>:<slot>, again in the slot -> duplicate + timer to the next slot; the nudge "
    + "pulse plans nothing and reads no occupation page", () =>
    withEnv(driver, (e) => {
      const svc = e.make();
      assert.strictEqual(e.presence.st.subs, 1, "subscribed at the start");
      e.presence.emit(SYS[2]);
      e.timers.run();
      e.seedSystem(SYS[0]);
      e.pulse(svc, T0);
      assert.strictEqual(e.timers.pending.length, 1, "a new planned system arms the timer");
      e.timers.run();
      assert.deepStrictEqual([e.nudges().length, e.calls.create.length, e.count("world_events")], [0, 0, 1]);
      e.presence.st.dist.set(SYS[0], 0);
      e.presence.emit(SYS[0]);
      e.presence.emit(SYS[0]);
      assert.strictEqual(e.timers.pending.length, 1, "one timer at a time");
      e.timers.run();
      const slot = Math.floor(T0 / N);
      assert.deepStrictEqual(e.nudges().map((a) => [a[0], a[1], a[2], a[3], a[4]]),
        [["SITE_REFRESH", "director", T0, { intervalMs: I, nudge: slot }, `events:nudge:${I}:${N}:${slot}`]]);
      e.presence.emit(SYS[0]);
      e.timers.run();
      assert.deepStrictEqual([e.nudges().length, e.timers.pending.map((t) => t.ms)], [2, [(slot + 1) * N - T0]]);
      const c = e.telemetry.counters;
      assert.deepStrictEqual([c["events.nudgeEnqueued"], c["events.nudgeDuplicate"], c["events.nudgeRefused"]],
        [1, 1, undefined]);
      e.seedSystem(SYS[1]);
      const reads = e.occReads.n;
      const { res } = e.pulse(svc, T0 + 1000, { nudge: slot });
      const [ev] = e.events();
      assert.deepStrictEqual([res.outcome, ev.state, e.count("world_events"), c["events.planned"], e.occReads.n],
        ["NUDGE", "ACTIVE", 1, 1, reads]);
      assert.ok(e.lines.includes(`events: nudge pulse slot=${slot} transitions=1 open=1`), e.lines.join("\n"));
      assert.deepStrictEqual([c["events.nudgePulses"], svc.getStatus().lastNudgeAt], [1, T0 + 1000]);
      svc.stop();
      assert.deepStrictEqual([e.presence.st.listeners.size, e.timers.pending.every((t) => t.cancelled)], [0, true]);
    }, { env: ON }));

  needsDriver("PT4 UNOBSERVED: presence stale past plannedWaitMs -> NONE + presenceUnknown; known, nobody "
    + "-> CANCELLED/UNOBSERVED, then a new plan in the same system (outside the cooldown); stale until expiresAt -> "
    + "EXPIRED_UNSTARTED", () => {
    const env = { ...ON, EVEJS_LNE_EVENTS_PLANNED_WAIT_MS: String(I) };
    withEnv(driver, (e) => {
      e.seedSystem(SYS[0]);
      const svc = e.make();
      e.pulse(svc, T0);
      e.presence.st.stale = true;
      e.pulse(svc, T0 + I);
      assert.strictEqual(e.events()[0].state, "PLANNED", "unknown presence never cancels");
      e.presence.st.stale = false;
      e.pulse(svc, T0 + 2 * I);
      const [ev] = e.events();
      assert.deepStrictEqual([ev.state, ev.resultReference, ev.cleanupPending, ev.sitesCreated],
        ["CANCELLED", "UNOBSERVED", null, 0]);
      const c = e.telemetry.counters;
      assert.deepStrictEqual([c["events.cancelled.UNOBSERVED"], c["events.presenceUnknown"]], [1, 1]);
      e.pulse(svc, T0 + 3 * I);
      const open = e.events().filter((x) => x.state === "PLANNED");
      assert.deepStrictEqual(open.map((x) => [x.systemId, x.eventType, x.createdAt]),
        [[SYS[0], ev.eventType, T0 + 3 * I]], "UNOBSERVED is outside the cooldown of its type and system");
      assert.strictEqual(e.calls.create.length, 0);
    }, { env });
    withEnv(driver, (e) => {
      e.seedSystem(SYS[0]);
      const svc = e.make();
      e.pulse(svc, T0);
      e.presence.st.stale = true;
      const [planned] = e.events();
      e.pulse(svc, planned.expiresAt - 1);
      assert.strictEqual(e.events()[0].state, "PLANNED");
      e.pulse(svc, planned.expiresAt);
      const ev = e.events()[0];
      assert.deepStrictEqual([ev.state, ev.resultReference, e.calls.create.length],
        ["CANCELLED", "EXPIRED_UNSTARTED", 0]);
    }, { env });
  });

  needsDriver("PT5 restart: transitionInTx throws in the ACTIVATE savepoint -> PLANNED, no site rows; a new "
    + "service on the same store, boot pulse with the player in range -> ACTIVE once, one createSiteInTx per slot",
  () =>
    withEnv(driver, (e) => {
      e.seedSystem(SYS[0]);
      e.pulse(e.make(), T0);
      e.presence.st.dist.set(SYS[0], 0);
      let thrown = 0;
      const throwing = { ...repo, transitionInTx(tx, id, version, patch, at) {
        if (patch.state === "ACTIVE" && thrown === 0) {
          thrown += 1;
          throw new Error("crash in the savepoint");
        }
        return repo.transitionInTx(tx, id, version, patch, at);
      } };
      e.pulse(e.make({ repository: throwing }), T0 + I);
      let [ev] = e.events();
      const slots = ev.templateIds.length;
      assert.deepStrictEqual([thrown, ev.state, e.count("world_event_sites"), e.calls.create.length],
        [1, "PLANNED", 0, slots], "createSiteInTx ran and was rolled back with the transition");
      e.calls.create.length = 0;
      const again = e.make();
      e.pulse(again, T0 + I + 1000, { boot: true });
      e.pulse(again, T0 + 2 * I);
      [ev] = e.events();
      assert.deepStrictEqual([ev.state, ev.sitesCreated, e.calls.create.length, e.count("world_event_sites")],
        ["ACTIVE", slots, slots, slots]);
      assert.deepStrictEqual(e.calls.create, [...Array(slots).keys()].map((s) => `${ev.eventId}:${s}`));
      assert.strictEqual(ev.result.activation.distance, 0);
    }, { env: ON }));

  needsDriver("PT6: registerHandler refused -> EVENTS_START_FAILED and the presence subscription of the "
    + "service is gone (subscribed once, no listener left)", () =>
    withEnv(driver, (e) => {
      const refusing = { registerHandler: () => ({ ok: false, reason: "HANDLER_EXISTS" }),
        enqueue: () => ({ ok: true }) };
      const r = startEvents({ config: e.config, persistence: { ok: true, store: e.store, worldSeed: 1 }, clock: e.clock,
        ids: { next: () => "x" }, scheduler: refusing, getPresence: () => e.presence.facade,
        setTimer: e.timers.setTimer });
      assert.deepStrictEqual([r.ok, r.reason], [false, "EVENTS_START_FAILED"]);
      assert.deepStrictEqual([e.presence.st.subs, e.presence.st.listeners.size], [1, 0]);
    }, { env: ON }));

  needsDriver("PT7: default config registers layer-events (marks, order 19), getStatus().layer, stop() "
    + "unregisters it; galaxyEventsEnabled=0 -> the same map layers as without views, start ok", () => {
    const startWith = (e, config, views) => startEvents({ config,
      persistence: { ok: true, store: e.store, worldSeed: 1 }, clock: e.clock, ids: { next: () => "x" },
      scheduler: e.scheduler, setTimer: e.timers.setTimer,
      ...(views ? { views } : {}) });
    withEnv(driver, (e) => {
      const views = createViewRegistry();
      const r = startWith(e, e.config, views);
      assert.ok(r.ok, JSON.stringify(r));
      assert.deepStrictEqual(views.listMapLayers().filter((l) => l.id === "layer-events"),
        [{ id: "layer-events", title: "Events", kind: "marks", order: 19 }]);
      assert.strictEqual(r.events.getStatus().layer, true);
      r.events.stop();
      assert.deepStrictEqual([views.getView("layer-events") || null, views.listMapLayers()], [null, []]);
    });
    withEnv(driver, (e) => {
      const views = createViewRegistry();
      const bare = createViewRegistry();
      const r = startWith(e, e.config, views);
      assert.ok(r.ok, JSON.stringify(r));
      assert.deepStrictEqual([views.listMapLayers(), r.events.getStatus().layer], [bare.listMapLayers(), false]);
      r.events.stop();
    }, { env: { EVEJS_LNE_OBSERVER_GALAXY_EVENTS_ENABLED: "0" } });
  });
};
