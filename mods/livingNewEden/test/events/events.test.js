"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { MIGRATIONS, LATEST_SCHEMA_VERSION } = require("../../lib/persistence/migrations");
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
const { unavailableSites } = require("../../lib/events/sites");
const siteRepository = require("../../lib/events/sites/siteRepository");
const repo = require("../../lib/events/eventRepository");
const { createEventService, COUNTER_NAMES } = require("../../lib/events/eventService");
const { startEvents, unavailableEvents } = require("../../lib/events");
const { buildDefaultServiceDefs } = require("../../lib/runtime/services");
const { harness: H } = require("../battle/settlement.test");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const I = 300000;
const T0 = 5666667 * I;
const SANSHA = 500019;
const SANSHA_INCURSION = ["client-dungeon:2206", "client-dungeon:2329", "client-dungeon:2125", "client-dungeon:2165"];
const SYS = [30001001, 30001002, 30001003];
const AFTERMATH = 30 * 60000;
const LIMITS = Object.freeze({ maxFactionsPerSystem: 8, maxBatchReadIds: 400, maxListLimit: 500 });

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

const GRAPH = { getGraph: () => ({ ok: true, graph: { getSystem: (id) => ({ id, regionId: 10000060 }) } }) };

function withEnv(driver, fn, { fresh = false, env = {} } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lne-events-"));
  const file = path.join(tmp, "world.sqlite");
  let store = null;
  let scheduler = null;
  try {
    if (!fresh) seedDbFile(driver, file, { migrations: MIGRATIONS, seed: 1 });
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
    const realSites = createSiteService({ store, adapter: {}, clock, config, telemetry, logger: { log() {} } });
    const calls = { create: [], cleanup: [] };
    const counted = (s) => ({ ...s,
      createSiteInTx(tx, req) {
        calls.create.push(`${req.eventId}:${req.slot}:${req.templateId}`);
        return s.createSiteInTx(tx, req);
      },
      cleanupSitesInTx(tx, eventId, reason) {
        const r = s.cleanupSitesInTx(tx, eventId, reason);
        calls.cleanup.push([reason, r.ok ? r.released : r.reason]);
        return r;
      } });
    const holder = { sites: counted(realSites), strategy: { listActiveCampaigns: () => ({ ok: true, campaigns: [] }),
      getCampaign: () => ({ ok: false, reason: "CAMPAIGN_INACTIVE" }) } };
    const lines = [];
    const tx = (f) => {
      const r = store.transaction("test", f);
      assert.ok(r.ok, JSON.stringify(r));
      return r.value;
    };
    const e = {
      store, opened, clock, ids, config, telemetry, journal, worldRepo, scheduler, realSites, calls, holder, lines, tx,
      stubSites: () => counted(unavailableSites("SITES_DISABLED")),
      countedReal: () => counted(realSites),
      make: (over = {}) => createEventService({ config: over.config || config, store, clock, ids, scheduler,
        world: () => ({ repository: worldRepo }), strategy: () => holder.strategy, presence: () => null,
        graph: () => GRAPH, sites: () => holder.sites, telemetry, logger: { log: (l) => lines.push(l) },
        catalog: over.catalog || H_CATALOG, worldSeed: opened.worldSeed, nowMs: () => 0,
        repository: over.repository }),
      pulse(svc, at, opts = {}) {
        clock.set(at);
        const payload = opts.boot ? { intervalMs: I, round: Math.floor(at / I), boot: true }
          : { intervalMs: I, round: Math.floor(at / I) };
        const res = svc.pulseHandler({ payload }, { now: at, anchorAt: at, lateMs: 0, catchUp: false });
        assert.ok(res.ok, JSON.stringify(res));
        let value;
        const r = store.transaction("test.complete", (db) => {
          value = res.effect(db);
          const n = res.reschedule;
          const next = scheduler.enqueue(n.eventType, n.aggregateId, n.dueAt, n.payload, n.idempotencyKey, { tx: db });
          if (opts.throwAfter) throw new Error("crash before the commit");
          return next;
        });
        if (opts.throwAfter) {
          assert.strictEqual(r.ok, false);
          return { res, value, next: null };
        }
        assert.ok(r.ok, JSON.stringify(r));
        res.onCommitted(value);
        return { res, value, next: r.value };
      },
      events: () => tx((db) => db.prepare("SELECT * FROM world_events ORDER BY created_at, event_id").all()
        .map(repo.rowOf)),
      siteRows: (eventId) => tx((db) => siteRepository.listByEventInTx(db, eventId)),
      count: (table) => tx((db) => db.prepare(`SELECT count(*) AS n FROM ${table}`).get().n),
      seedSystem(systemId, occupationState = "CONTESTED", occupier = SANSHA) {
        const a = tx((db) => worldRepo.applyChange(db, { systemId, expectedVersion: 0, reason: "SEED_CONTROL",
          state: { securityClass: "nullsec", controllerFactionId: 500003 } }, `test:seed:${systemId}`));
        assert.ok(a.ok, JSON.stringify(a));
        if (occupationState !== "STABLE") e.setOccupation(systemId, occupationState, occupier);
      },
      setOccupation(systemId, occupationState, occupier, controller) {
        const sys = tx((db) => worldRepo.getSystem(db, systemId, { includeInfluence: false })).system;
        const state = { occupationState, occupierFactionId: occupier };
        if (controller !== undefined) state.controllerFactionId = controller;
        const b = tx((db) => worldRepo.applyChange(db, { systemId, expectedVersion: sys.version,
          reason: "TEST_OCCUPATION", state }, `test:occ:${systemId}:${sys.version}`));
        assert.ok(b.ok, JSON.stringify(b));
      },
      completeSites(eventId) {
        tx((db) => {
          for (const row of siteRepository.listByEventInTx(db, eventId)) {
            const r = siteRepository.transitionInTx(db, row, { state: "COMPLETED", updated_at: clock.now() });
            assert.ok(r.ok, JSON.stringify(r));
          }
        });
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

const H_CATALOG = require("../../lib/events/catalog").validateCatalog(
  require("../../lib/events/catalog").EVENT_CATALOG).catalog;

function planOf(over = {}) {
  return { planKey: "300000:1:30001001:pirate_incursion", eventType: "pirate_incursion", catalogVersion: 1,
    systemId: SYS[0], factionId: SANSHA, campaignId: null, cause: "OCCUPATION_CLAIM",
    templateIds: [SANSHA_INCURSION[0]],
    label: "Sansha Incursion Staging", dueAt: T0, expiresAt: T0 + 4 * 3600000, seed: 1, reason: { cause: "x" },
    ...over };
}

module.exports = ({ test, skip }) => {
  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  needsDriver("V1 migration 26 world_events from zero: 5 indexes, plan_key unique, CHECK cleanup_pending "
    + "transition table; row bound > maxRowsPerTransaction -> EVENTS_ROW_BOUND", () => withEnv(driver, (e) => {
    assert.ok(LATEST_SCHEMA_VERSION >= 26);
    assert.deepStrictEqual([e.opened.schemaVersion, e.opened.applied], [LATEST_SCHEMA_VERSION, LATEST_SCHEMA_VERSION]);
    assert.deepStrictEqual([MIGRATIONS[25].version, MIGRATIONS[25].name], [26, "world_events"]);
    const objs = e.tx((db) => db.prepare("SELECT name, sql FROM sqlite_master WHERE tbl_name = 'world_events' "
      + "AND name NOT LIKE 'sqlite_%' ORDER BY name").all());
    assert.deepStrictEqual(objs.map((o) => o.name), ["world_events", "world_events_cleanup", "world_events_created",
      "world_events_ended", "world_events_open", "world_events_system"]);
    assert.ok(/\) STRICT$/.test(objs[0].sql.trim()));
    const first = e.tx((db) => repo.insertPlannedInTx(db, planOf(), { eventId: "event_a", now: T0 }));
    const second = e.tx((db) => repo.insertPlannedInTx(db, planOf(), { eventId: "event_b", now: T0 }));
    assert.deepStrictEqual([first, second], [{ ok: true, inserted: true, eventId: "event_a" },
      { ok: true, inserted: false, eventId: "event_a" }]);
    assert.strictEqual(e.tx((db) => repo.insertPlannedInTx(db, planOf({ planKey: "k2", templateIds: [] }),
      { eventId: "event_c", now: T0 })).reason, "PLAN_INVALID");
    const bad = e.store.transaction("t", (db) => db.prepare("UPDATE world_events SET cleanup_pending = 'X'").run());
    assert.strictEqual(bad.reason, "TX_CONSTRAINT");
    assert.strictEqual(e.tx((db) => repo.transitionInTx(db, "event_a", 1, { state: "COMPLETED" }, T0)).reason,
      "TRANSITION_INVALID");
    assert.strictEqual(e.tx((db) => repo.transitionInTx(db, "event_a", 2, { state: "ACTIVE" }, T0)).reason,
      "VERSION_CONFLICT");
    const row = e.events()[0];
    assert.deepStrictEqual([row.state, row.spawnBudget, row.templateId, row.version], ["PLANNED", 1,
      SANSHA_INCURSION[0], 1]);
    const low = configOf({ EVEJS_LNE_PERSISTENCE_MAX_ROWS_PER_TRANSACTION: "100" });
    const refused = startEvents({ config: low, persistence: { ok: true, store: e.store, worldSeed: 1 },
      clock: e.clock, ids: e.ids, scheduler: e.scheduler });
    assert.strictEqual(refused.reason, "EVENTS_ROW_BOUND", JSON.stringify(refused));
  }, { fresh: true }));

  needsDriver("V2 happy path: CONTESTED Sansha nullsec -> PLANNED (OCCUPATION_CLAIM) -> ACTIVE + 1 site -> "
    + "COMPLETING -> after aftermathMs COMPLETED/CLEARED + 1x cleanup EVENT_END, sites CLEANING", () =>
    withEnv(driver, (e) => {
      e.seedSystem(SYS[0]);
      const svc = e.make();
      e.pulse(svc, T0);
      let [ev] = e.events();
      assert.deepStrictEqual([ev.state, ev.reason.cause, ev.factionId, ev.systemId], ["PLANNED", "OCCUPATION_CLAIM",
        SANSHA, SYS[0]]);
      assert.ok(SANSHA_INCURSION.includes(ev.templateId), ev.templateId);
      assert.strictEqual(ev.spawnBudget, ev.templateIds.length);
      e.pulse(svc, T0 + I);
      [ev] = e.events();
      assert.deepStrictEqual([ev.state, ev.sitesCreated, e.calls.create.length], ["ACTIVE", 1, 1]);
      const sites = e.siteRows(ev.eventId);
      assert.deepStrictEqual(sites.map((s) => [s.slot, s.templateId, s.expiresAt]), [[0, ev.templateId, ev.expiresAt]]);
      e.completeSites(ev.eventId);
      e.pulse(svc, T0 + 2 * I);
      [ev] = e.events();
      assert.deepStrictEqual([ev.state, ev.dueAt], ["COMPLETING", T0 + 2 * I + AFTERMATH]);
      e.pulse(svc, T0 + 2 * I + AFTERMATH - 1);
      assert.strictEqual(e.events()[0].state, "COMPLETING");
      e.pulse(svc, T0 + 2 * I + AFTERMATH);
      [ev] = e.events();
      assert.deepStrictEqual([ev.state, ev.resultReference, ev.endedAt, ev.cleanupPending, ev.result],
        ["COMPLETED", "CLEARED", T0 + 2 * I + AFTERMATH, null, { sitesReleased: 1 }]);
      assert.deepStrictEqual(e.calls.cleanup, [["EVENT_END", 1]]);
      assert.deepStrictEqual(e.siteRows(ev.eventId).map((s) => s.state), ["CLEANING"]);
      assert.strictEqual(e.calls.create.length, 1);
      const c = e.telemetry.counters;
      assert.deepStrictEqual([c["events.planned"], c["events.activated"], c["events.aftermath"], c["events.cleared"],
        c["events.siteCreated"]], [1, 1, 1, 1, 1]);
      assert.strictEqual(Object.keys(c).filter((k) => k.startsWith("events.")
        && !COUNTER_NAMES.includes(k.slice(7))).length, 0, "only closed names");
    }));

  needsDriver("V3 restart: rolled back effect -> 0 rows, retry -> 1 event; bootstrap 2x -> duplicates; after "
    + "ACTIVE 2 pulses -> no createSiteInTx; new service -> still 1 open event", () => withEnv(driver, (e) => {
    e.seedSystem(SYS[0]);
    const svc = e.make();
    e.pulse(svc, T0, { throwAfter: true });
    assert.deepStrictEqual([e.count("world_events"), e.count("world_event_sites")], [0, 0]);
    e.pulse(svc, T0);
    assert.strictEqual(e.count("world_events"), 1);
    const b1 = svc.bootstrap();
    const b2 = svc.bootstrap();
    assert.ok(b1.ok && b2.ok, JSON.stringify([b1, b2]));
    assert.deepStrictEqual([b2.chainDuplicate, b2.bootDuplicate], [true, true]);
    e.pulse(svc, T0 + I);
    assert.strictEqual(e.calls.create.length, 1);
    e.pulse(svc, T0 + 2 * I);
    e.pulse(svc, T0 + 3 * I);
    assert.strictEqual(e.calls.create.length, 1, "createSiteInTx only in ACTIVATE");
    const again = e.make();
    e.pulse(again, T0 + 4 * I);
    const open = e.events().filter((x) => ["PLANNED", "ACTIVE", "COMPLETING"].includes(x.state));
    assert.deepStrictEqual([e.count("world_events"), open.length, e.calls.create.length], [1, 1, 1]);
  }));

  needsDriver("V4 cause gone -> CANCELLED/CAUSE_GONE + cleanup EVENT_CANCELLED; sites stub -> ACTIVE with "
    + "siteRefusals; maxOpenEvents reached -> no plan; theatre campaign PENDING -> no cancel, gone -> cancel", () => {
    withEnv(driver, (e) => {
      e.seedSystem(SYS[0]);
      const svc = e.make();
      e.pulse(svc, T0);
      e.pulse(svc, T0 + I);
      e.setOccupation(SYS[0], "STABLE", null);
      e.pulse(svc, T0 + 2 * I);
      const [ev] = e.events();
      assert.deepStrictEqual([ev.state, ev.resultReference, ev.cleanupPending], ["CANCELLED", "CAUSE_GONE", null]);
      assert.deepStrictEqual(e.calls.cleanup, [["EVENT_CANCELLED", 1]]);
    });
    withEnv(driver, (e) => {
      e.holder.sites = e.stubSites();
      e.seedSystem(SYS[0]);
      const svc = e.make();
      e.pulse(svc, T0);
      e.pulse(svc, T0 + I);
      const [ev] = e.events();
      assert.deepStrictEqual([ev.state, ev.sitesCreated, ev.result],
        ["ACTIVE", 0, { siteRefusals: ["SITES_DISABLED"] }]);
      assert.strictEqual(e.telemetry.counters["events.siteRefused.SITES_DISABLED"], 1);
    });
    withEnv(driver, (e) => {
      e.seedSystem(SYS[0]);
      e.seedSystem(SYS[1]);
      const svc = e.make();
      e.pulse(svc, T0);
      e.pulse(svc, T0 + I);
      assert.strictEqual(e.count("world_events"), 1);
    }, { env: { EVEJS_LNE_EVENTS_MAX_OPEN_EVENTS: "1" } });
    withEnv(driver, (e) => {
      e.seedSystem(SYS[2], "STABLE");
      e.setOccupation(SYS[2], "STABLE", null, SANSHA);
      e.tx((db) => repo.insertPlannedInTx(db, planOf({ planKey: "t1", systemId: SYS[2], cause: "CAMPAIGN_THEATRE",
        campaignId: "c1", eventType: "pirate_outpost", dueAt: T0 + 10 * I, templateIds: ["client-dungeon:2135"] }),
      { eventId: "event_t", now: T0 }));
      e.holder.strategy = { listActiveCampaigns: () => ({ ok: true, campaigns: [{ campaignId: "c1", ok: false,
        reason: "CAMPAIGN_PENDING" }] }), getCampaign: () => ({ ok: false, reason: "CAMPAIGN_PENDING" }) };
      const svc = e.make();
      e.pulse(svc, T0 + I);
      assert.strictEqual(e.events()[0].state, "PLANNED", "a pending campaign is unknown, not gone");
      e.holder.strategy = { listActiveCampaigns: () => ({ ok: true, campaigns: [] }) };
      e.pulse(svc, T0 + 2 * I);
      assert.deepStrictEqual([e.events()[0].state, e.events()[0].resultReference], ["CANCELLED", "CAUSE_GONE"]);
    });
  });

  needsDriver("V5 start: checkTemplates missing -> removed from the catalog + events.templatesMissing "
    + "module off -> stub EVENTS_DISABLED; defaults -> no warnings; listOpenEvents in a tx -> TX_ACTIVE", () =>
    withEnv(driver, (e) => {
      const adapter = { getDungeonSites: () => ({ ok: true, checkTemplates: () => ({ ok: true,
        missing: ["client-dungeon:2206"] }) }) };
      const started = startEvents({ config: e.config, persistence: { ok: true, store: e.store, worldSeed: 1 },
        clock: e.clock, ids: e.ids, scheduler: e.scheduler, adapter, telemetry: e.telemetry,
        logger: { log: (l) => e.lines.push(l) } });
      assert.ok(started.ok, JSON.stringify(started));
      const inc = started.catalog.byType.pirate_incursion.templatesByFaction[SANSHA];
      assert.ok(!inc.includes("client-dungeon:2206") && inc.length === 3, inc.join(","));
      assert.strictEqual(e.telemetry.counters["events.templatesMissing"], 1);
      const st = started.events.getStatus();
      assert.deepStrictEqual([st.state, st.templates, st.templatesMissing, st.types, st.warnings],
        ["running", "checked", 1, 6, []]);
      assert.ok(e.lines.some((l) => /^events: running open=\? cleanupPending=\? catalog=v2 types=6 factions=7 /
        .test(l)), e.lines.join("\n"));
      assert.strictEqual(e.tx(() => started.events.listOpenEvents({ limit: 4 })).reason, "TX_ACTIVE");
      assert.deepStrictEqual(started.events.listOpenEvents({ limit: 4 }), { ok: true, events: [], truncated: false });
      started.events.stop("test");
      const defaults = resolveConfig({ modDir: MOD_DIR, env: {} });
      assert.deepStrictEqual([defaults.config.modules.events.enabled, defaults.warnings], [false, []]);
      assert.deepStrictEqual(e.config.events.maxOpenEvents, 8);
      assert.deepStrictEqual(resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_EVENTS_ENABLED: "1",
        EVEJS_LNE_SITES_ENABLED: "1" } }).warnings, []);
      assert.strictEqual(startEvents({ config: defaults.config }).reason, "disabled_by_config");
      const def = buildDefaultServiceDefs({}).find((d) => d.name === "events");
      assert.deepStrictEqual([def.module, def.requires], ["events", ["persistence", "scheduler"]]);
      const ctx = {};
      def.onUnavailable(ctx, "disabled_by_config");
      assert.strictEqual(ctx.events.listOpenEvents().reason, "EVENTS_DISABLED");
      assert.strictEqual(unavailableEvents("EVENTS_UNAVAILABLE").getEvent("x").reason, "EVENTS_UNAVAILABLE");
    }));

  needsDriver("V6 boot reconcile: site COMPLETED while stopped -> new service, bootstrap + boot pulse "
    + "-> COMPLETING, no plan, successor duplicate; cancel with the sites stub -> cleanup_pending, real sites -> "
    + "retried once", () => {
    withEnv(driver, (e) => {
      e.seedSystem(SYS[0]);
      const svc = e.make();
      e.pulse(svc, T0);
      e.pulse(svc, T0 + I);
      svc.stop();
      assert.strictEqual(svc.pulseHandler({ payload: {} }, { now: T0, anchorAt: T0 }).reason, "EVENTS_STOPPED");
      const [ev] = e.events();
      e.completeSites(ev.eventId);
      e.seedSystem(SYS[1]);
      const at = T0 + I + 1000;
      e.clock.set(at);
      const next = e.make();
      const b = next.bootstrap();
      assert.deepStrictEqual([b.ok, b.chainDuplicate, b.bootDuplicate], [true, true, false]);
      const r = e.pulse(next, at, { boot: true });
      assert.deepStrictEqual([e.events()[0].state, e.count("world_events")], ["COMPLETING", 1]);
      assert.strictEqual(r.next.duplicate, true, "successor = the live chain");
      assert.ok(e.lines.includes("events: boot reconcile open=1 transitions=1 cleanupPending=0"), e.lines.join("\n"));
      assert.strictEqual(e.telemetry.counters["events.bootPulses"], 1);
    });
    withEnv(driver, (e) => {
      e.seedSystem(SYS[0]);
      const svc = e.make();
      e.pulse(svc, T0);
      e.pulse(svc, T0 + I);
      e.holder.sites = e.stubSites();
      e.setOccupation(SYS[0], "STABLE", null);
      e.pulse(svc, T0 + 2 * I);
      let [ev] = e.events();
      assert.deepStrictEqual([ev.state, ev.cleanupPending], ["CANCELLED", "EVENT_CANCELLED"]);
      e.pulse(svc, T0 + 3 * I);
      assert.strictEqual(e.events()[0].cleanupPending, "EVENT_CANCELLED", "stub again -> still pending");
      e.holder.sites = e.countedReal();
      e.calls.cleanup.length = 0;
      e.pulse(svc, T0 + 4 * I);
      [ev] = e.events();
      assert.deepStrictEqual([ev.cleanupPending, ev.result.sitesReleased, e.calls.cleanup], [null, 1,
        [["EVENT_CANCELLED", 1]]]);
      assert.deepStrictEqual(e.siteRows(ev.eventId).map((s) => s.state), ["CLEANING"]);
      assert.strictEqual(e.telemetry.counters["events.cleanupRetried"], 1);
    });
  });

  needsDriver("V7 refusals: plan PLAN_INVALID + retention refusal -> counters + log once per window "
    + "cap per pulse; transitionInTx throws -> EFFECT_ERROR with eventId, cleanup retry -> transitionFailed (not "
    + "versionConflict); throw after registerHandler -> unregister", () => {
    const refusalLines = (e) => e.lines.filter((l) => l.startsWith("events: refused "));
    const closedOnly = (e) => assert.deepStrictEqual(Object.keys(e.telemetry.counters).filter((k) =>
      k.startsWith("events.") && !COUNTER_NAMES.includes(k.slice(7))), []);
    withEnv(driver, (e) => {
      e.seedSystem(SYS[0]);
      const repository = { ...repo,
        insertPlannedInTx: (tx, p, o) => repo.insertPlannedInTx(tx, { ...p, label: "x".repeat(65) }, o),
        deleteEndedBefore: () => ({ ok: false, reason: "DISK_FULL", detail: "a\nb" }) };
      const svc = e.make({ repository });
      e.pulse(svc, T0);
      const c = e.telemetry.counters;
      const planKey = /planKey=(\S+)/.exec(refusalLines(e)[0] || "");
      assert.deepStrictEqual(refusalLines(e).map((l) => l.replace(/planKey=\S+/, "planKey=K")), [
        "events: refused PLAN planKey=K reason=PLAN_INVALID detail=label",
        "events: refused RETENTION reason=DISK_FULL detail=a b"], e.lines.join("\n"));
      assert.ok(planKey && planKey[1].endsWith(":pirate_incursion"), String(planKey));
      assert.deepStrictEqual([c["events.planRefused"], c["events.retentionRefused"], c["events.refusal.PLAN_INVALID"],
        c["events.refusal.OTHER"], e.count("world_events")], [1, 1, 1, 1, 0]);
      e.pulse(svc, T0 + I);
      assert.deepStrictEqual(refusalLines(e).slice(2).map((l) => l.split(" planKey=")[0]), ["events: refused PLAN"]);
      assert.deepStrictEqual([c["events.planRefused"], c["events.failureLogSuppressed"]], [2, 1]);
      const capped = e.make({ repository, config: configOf({ EVEJS_LNE_EVENTS_MAX_FAILURE_LOGS_PER_PULSE: "1" }) });
      e.pulse(capped, T0 + 2 * I);
      assert.deepStrictEqual([refusalLines(e).length, c["events.failureLogSuppressed"]], [4, 2], "cap 1 per pulse");
      closedOnly(e);
    });
    withEnv(driver, (e) => {
      e.seedSystem(SYS[0]);
      e.pulse(e.make(), T0);
      const [ev] = e.events();
      const throwing = { ...repo, transitionInTx: () => {
        throw new Error("boom\nsqlite");
      } };
      e.pulse(e.make({ repository: throwing }), T0 + I);
      const c = e.telemetry.counters;
      assert.ok(refusalLines(e).includes(`events: refused ACTIVATE eventId=${ev.eventId} reason=EFFECT_ERROR `
        + "detail=boom sqlite"), e.lines.join("\n"));
      assert.deepStrictEqual([c["events.transitionFailed"], c["events.refusal.EFFECT_ERROR"],
        c["events.versionConflict"], e.events()[0].state, e.count("world_event_sites")], [1, 1, undefined, "PLANNED",
        0]);
      closedOnly(e);
    });
    withEnv(driver, (e) => {
      e.seedSystem(SYS[0]);
      const svc = e.make();
      e.pulse(svc, T0);
      e.pulse(svc, T0 + I);
      e.holder.sites = e.stubSites();
      e.setOccupation(SYS[0], "STABLE", null);
      e.pulse(svc, T0 + 2 * I);
      const [ev] = e.events();
      assert.strictEqual(ev.cleanupPending, "EVENT_CANCELLED");
      e.holder.sites = e.countedReal();
      const sitesBefore = e.siteRows(ev.eventId).map((s) => s.state);
      const throwing = { ...repo, transitionInTx: (tx, id, version, patch, at) => {
        if (!("state" in patch)) throw new Error("retry broke");
        return repo.transitionInTx(tx, id, version, patch, at);
      } };
      e.pulse(e.make({ repository: throwing }), T0 + 3 * I);
      const c = e.telemetry.counters;
      assert.deepStrictEqual([c["events.transitionFailed"], c["events.versionConflict"], c["events.cleanupRetried"],
        e.events()[0].cleanupPending], [1, undefined, undefined, "EVENT_CANCELLED"]);
      assert.ok(refusalLines(e).includes(`events: refused CLEANUP_RETRY eventId=${ev.eventId} reason=EFFECT_ERROR `
        + "detail=retry broke"), e.lines.join("\n"));
      assert.deepStrictEqual(e.siteRows(ev.eventId).map((s) => s.state), sitesBefore, "savepoint rolled back");
      assert.strictEqual(e.calls.cleanup.at(-1)[1], 1, "the cleanup ran and was rolled back with the transition");
    });
    withEnv(driver, (e) => {
      let unregistered = 0;
      const scheduler = { ...e.scheduler, registerHandler(type, fn, opts) {
        const r = e.scheduler.registerHandler(type, fn, opts);
        return r && r.ok ? { ...r, unregister() {
          unregistered += 1;
          r.unregister();
        } } : r;
      } };
      const started = startEvents({ config: e.config, persistence: { ok: true, store: e.store, worldSeed: 1 },
        clock: e.clock, ids: e.ids, scheduler, logger: { log(l) {
          if (/^events: running /.test(l)) throw new Error("logger broke");
        } } });
      assert.deepStrictEqual([started.ok, started.reason, started.detail, unregistered],
        [false, "EVENTS_START_FAILED", "logger broke", 1]);
      const again = e.scheduler.registerHandler("SITE_REFRESH", () => ({ ok: true }), { maxPerPass: 1 });
      assert.ok(again.ok, JSON.stringify(again));
      again.unregister();
    });
  });
};
