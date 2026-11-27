"use strict";

const assert = require("node:assert");
const path = require("node:path");

const { loadDriver, withStore } = require("../notices/storeHelper");
const { resolveConfig } = require("../../config");
const { createJournal } = require("../../lib/persistence/journal");
const { createStationRepository } = require("../../lib/stations/stationRepository");
const { hullDeltas } = require("../../lib/stations/stockKeys");
const { HULL_GROUPS } = require("../../lib/fleets/schema");
const S = require("../../lib/heavyEvents/schema");
const { startHeavyEvents, createUnavailableHeavyEvents, FACADE_METHODS } = require("../../lib/heavyEvents");
const { createHeavyEventRepository } = require("../../lib/heavyEvents/repository");
const { endInTx } = require("../../lib/heavyEvents/planner");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const NOW = Date.UTC(2026, 10, 7, 12, 0, 0);
const PIRATE = 500010;
const SYS = 30000142;
const STATION = "st:hev:1";
const STOCK_PER_GROUP = 50;
const GROUPS = ["cruiser", "tackle", "ewar", "logistics", "battlecruiser", "battleship", "dreadnought"];

const BASE = resolveConfig({ modDir: MOD_DIR, env: {} }).config;
function configOf(enabled) {
  const modules = { ...BASE.modules, world: { ...BASE.modules.world, enabled: true },
    sites: { ...BASE.modules.sites, enabled: true } };
  return { ...BASE, enabled: true, modules, heavyEvents: { ...BASE.heavyEvents, enabled } };
}

const run = (store, fn) => {
  const r = store.transaction("t", fn);
  assert.ok(r.ok, JSON.stringify(r));
  return r.value;
};

function harness(store, h = {}) {
  const clock = { now: () => h.now };
  h.now = NOW;
  const journal = createJournal({ clock, maxPayloadBytes: 16384, maxRows: 500 });
  const stations = createStationRepository({ journal, isKnownFaction: () => true, hullGroups: HULL_GROUPS,
    limits: { maxPerSystem: 8, maxPerSystemPerFaction: 3, maxPerFaction: 64, maxStations: 2000,
      maxStockItemsPerStation: 256, maxStockQuantity: 1000000000000, maxDeltasPerChange: 32 } });
  const sites = { calls: [], refuse: null,
    createSiteInTx(tx, req) {
      assert.strictEqual(tx.inTransaction, true);
      if (this.refuse) return { ok: false, reason: this.refuse };
      this.calls.push(["create", req.eventId, req.label, req.slot]);
      return { ok: true, siteKey: `${req.eventId}:0`, created: true, state: "CREATING" };
    },
    cleanupSitesInTx(tx, eventId, reason) {
      assert.strictEqual(tx.inTransaction, true);
      this.calls.push(["cleanup", eventId, reason]);
      return { ok: true, released: 1 };
    } };
  const ctx = { persistence: { ok: true, store, journal, worldSeed: 7 },
    stations: { getMode: () => "ready", repository: stations }, sites,
    world: { repository: { getSystem: (_tx, id) => ({ ok: true, system: { systemId: id, controllerFactionId: PIRATE } }) } },
    graph: { getGraph: () => ({ ok: true, graph: { getSystem: () => ({ secClass: "nullsec" }) } }) },
    presence: { getStatus: () => ({ available: true, stale: false }),
      observedWithin: () => ({ ok: true, systems: [[SYS, 0]] }) } };
  const start = (enabled) => startHeavyEvents({ config: configOf(enabled), ctx, clock, getFactionKind: () => "pirate",
    setTimer: () => ({ cancel() {}, hasRef: () => false }), logger: { log() {} } });
  const repo = createHeavyEventRepository({ journal });
  const hulls = () => run(store, (tx) => stations.getStock(tx, STATION)).items
    .filter((i) => i.itemKind === "hull").reduce((a, i) => a + i.quantity, 0);
  const rows = () => run(store, (tx) => tx.prepare(`SELECT event_id, state, open, abandons, end_reason, reward_state
    FROM ${S.TABLE} ORDER BY event_id`).all());
  const hasKey = (key) => run(store, (tx) => journal.findByKey(tx, key));
  run(store, (tx) => {
    assert.ok(stations.createStation(tx, { stationId: STATION, kind: "upwell", structureFamily: "astrahus",
      systemId: SYS, ownerFactionId: PIRATE, ownerCorporationId: 1000101, origin: "seed", at: NOW }, "hevt:st").ok);
    const deltas = hullDeltas(GROUPS.map((hullGroup) => ({ hullGroup, count: STOCK_PER_GROUP })), 1).deltas;
    assert.ok(stations.applyStockChange(tx, { stationId: STATION, key: "hevt:stock", reason: "seed", at: NOW,
      deltas }).ok);
  });
  const env = { repo, settings: configOf(true).heavyEvents, getStations: () => ctx.stations, getSites: () => sites };
  return Object.assign(h, { ctx, sites, start, repo, hulls, rows, hasKey, journal, env });
}

function planRow(store, h, eventId, groups) {
  const members = groups.map((hullGroup, i) => ({ key: `p1:${i}`, phase: 1, step: null, hullGroup, state: "RESERVED" }));
  run(store, (tx) => assert.ok(h.repo.planInTx(tx, { eventId, planKey: `1:${eventId}`, eventType: "redoubt", tier: 1,
    systemId: SYS, factionId: PIRATE, beneficiaryFactionId: null, stationId: STATION, members, funded: true,
    integrity: null, seed: 1, at: NOW, expiresAt: NOW + 1000, dueAt: null }).ok));
}

function move(store, h, eventId, from, to, patch) {
  return run(store, (tx) => {
    const row = h.repo.getInTx(tx, eventId).row;
    const r = h.repo.transitionInTx(tx, { eventId, expectedVersion: row.version, from, to, patch: patch || {}, at: NOW });
    assert.ok(r.ok, JSON.stringify(r));
    return r.row;
  });
}

module.exports = ({ test, skip }) => {
  const driver = loadDriver();
  if (!driver.ok) {
    skip("HP1-HP5 heavy events planner", `better-sqlite3 unavailable (${driver.detail})`);
    return;
  }
  const full = STOCK_PER_GROUP * GROUPS.length;

  test("HP1 plan = row + fund + site in one tx; a second pass of the bucket is a duplicate; stub = facade", () => {
    withStore(driver, ({ store }) => {
      const h = harness(store);
      const started = h.start(true);
      assert.ok(started.ok, JSON.stringify(started));
      const svc = started.heavyEvents;
      assert.deepStrictEqual(Object.keys(svc).sort(), [...FACADE_METHODS].sort());
      assert.deepStrictEqual(Object.keys(createUnavailableHeavyEvents("x")).sort(), [...FACADE_METHODS].sort());
      svc.runPass(NOW);
      const st = svc.getStatus();
      const eventId = S.eventIdOf(Math.floor(NOW / BASE.heavyEvents.planIntervalMs), 0);
      assert.deepStrictEqual(h.rows().map((r) => [r.event_id, r.state, r.open]), [[eventId, "PLANNED", 1]],
        JSON.stringify(st));
      const funded = st.counters.hullsFunded;
      assert.ok(funded > 0 && funded <= BASE.heavyEvents.maxShipsPerEvent, `funded ${funded}`);
      assert.strictEqual(st.counters["planned.redoubt"], 1);
      assert.strictEqual(h.hulls(), full - funded);
      assert.deepStrictEqual(h.sites.calls, [["create", eventId, "an unknown faction Redoubt", 0]]);
      for (const key of [S.fundKeyOf(eventId), S.planJournalKeyOf(eventId)]) assert.strictEqual(h.hasKey(key).found, true);
      svc.stop("test");
      const again = h.start(true).heavyEvents;
      again.runPass(NOW + 60000);
      assert.strictEqual(again.getStatus().counters["planned.redoubt"], 0);
      assert.strictEqual(h.hulls(), full - funded);
      assert.strictEqual(h.sites.calls.length, 1);
      assert.strictEqual(h.rows().length, 1);
      again.stop("test");
      assert.deepStrictEqual(again.runPass(NOW), { ok: false, reason: "HEAVY_EVENTS_UNAVAILABLE" });
    });
  });

  test("HP2 SITES_FULL rolls back the fund and the row (refused.SITES_FULL)", () => {
    withStore(driver, ({ store }) => {
      const h = harness(store);
      h.sites.refuse = "SITES_FULL";
      const svc = h.start(true).heavyEvents;
      svc.runPass(NOW);
      const eventId = S.eventIdOf(Math.floor(NOW / BASE.heavyEvents.planIntervalMs), 0);
      assert.strictEqual(svc.getStatus().counters["refused.SITES_FULL"], 1);
      assert.deepStrictEqual(h.rows(), []);
      assert.strictEqual(h.hulls(), full);
      assert.strictEqual(h.hasKey(S.fundKeyOf(eventId)).found, false);
      assert.strictEqual(h.hasKey(S.planJournalKeyOf(eventId)).found, false);
      svc.stop("test");
    });
  });

  test("HP3 EXPIRE returns the hulls exactly once; a repeated step with the stale row is a journal duplicate", () => {
    withStore(driver, ({ store }) => {
      const h = harness(store);
      const svc = h.start(true).heavyEvents;
      svc.runPass(NOW);
      const eventId = h.rows()[0].event_id;
      const stale = run(store, (tx) => h.repo.getInTx(tx, eventId).row);
      assert.ok(h.hulls() < full);
      svc.runPass(stale.expiresAt);
      assert.deepStrictEqual(h.rows().map((r) => [r.state, r.open, r.end_reason]), [["EXPIRED", 0, "EXPIRED"]]);
      assert.strictEqual(h.hulls(), full);
      assert.deepStrictEqual(h.sites.calls.slice(-1), [["cleanup", eventId, "EVENT_CANCELLED"]]);
      const counters = svc.getStatus().counters;
      assert.deepStrictEqual([counters.expired, counters.hullsReturned], [1, counters.hullsFunded]);
      const again = run(store, (tx) => endInTx(tx, h.env, stale, { to: "EXPIRED", reason: "EXPIRED" },
        stale.expiresAt + 5));
      assert.deepStrictEqual([again.duplicate, again.returned], [true, 0]);
      assert.strictEqual(h.hulls(), full);
      svc.stop("test");
    });
  });

  test("HP4 recovery: ENGAGED -> PLANNED (abandons + 1, RESTART), at maxAbandons EXPIRED with the hulls back", () => {
    withStore(driver, ({ store }) => {
      const h = harness(store);
      const max = BASE.heavyEvents.maxAbandons;
      planRow(store, h, "hev:1:0", ["cruiser"]);
      planRow(store, h, "hev:2:0", ["cruiser", "cruiser"]);
      move(store, h, "hev:1:0", "PLANNED", "ENGAGED");
      move(store, h, "hev:2:0", "PLANNED", "ENGAGED", { abandons: max - 1 });
      const before = h.hulls();
      h.ctx.presence = { getStatus: () => ({ available: false }) };
      const ready = h.ctx.stations;
      h.ctx.stations = { getMode: () => "pending", repository: ready.repository };
      const svc = h.start(true).heavyEvents;
      assert.deepStrictEqual(svc.runPass(NOW), { ok: true, mode: "running", waiting: "STATIONS_NOT_READY" });
      assert.deepStrictEqual(h.rows().map((r) => r.state), ["ENGAGED", "ENGAGED"]);
      assert.strictEqual(svc.getStatus().counters.errors, 0);
      h.ctx.stations = ready;
      svc.runPass(NOW);
      assert.deepStrictEqual(h.rows().map((r) => [r.event_id, r.state, r.open, r.abandons, r.end_reason]),
        [["hev:1:0", "PLANNED", 1, 1, null], ["hev:2:0", "EXPIRED", 0, max - 1, "RESTART"]]);
      const entry = h.hasKey(`${S.transitionKeyOf("hev:1:0", "ENGAGED", "PLANNED", 0)}:2`);
      assert.deepStrictEqual([entry.found, entry.entry.payload.reason], [true, "RESTART"]);
      assert.strictEqual(h.hulls(), before + 2);
      assert.deepStrictEqual([svc.getStatus().counters.restartReset, svc.getStatus().counters.expired], [2, 1]);
      svc.stop("test");
      const again = h.start(true).heavyEvents;
      again.runPass(NOW);
      assert.strictEqual(again.getStatus().counters.restartReset, 0);
      again.stop("test");
    });
  });

  test("HP5 drain with the flag off: PLANNED -> CANCELLED (DISABLED) + hulls back, CLEARED -> COMPLETED, stop", () => {
    withStore(driver, ({ store }) => {
      const h = harness(store);
      assert.deepStrictEqual(h.start(false), { ok: false, reason: "disabled_by_config" });
      planRow(store, h, "hev:1:0", ["cruiser", "battleship"]);
      planRow(store, h, "hev:2:0", ["cruiser"]);
      move(store, h, "hev:2:0", "PLANNED", "ENGAGED");
      move(store, h, "hev:2:0", "ENGAGED", "CLEARED");
      const before = h.hulls();
      const started = h.start(false);
      assert.ok(started.ok, JSON.stringify(started));
      const svc = started.heavyEvents;
      assert.strictEqual(svc.getStatus().state, "drain");
      assert.strictEqual(svc.runPass(NOW).left, 0);
      assert.deepStrictEqual(h.rows().map((r) => [r.event_id, r.state, r.open, r.end_reason, r.reward_state]),
        [["hev:1:0", "CANCELLED", 0, "DISABLED", "NONE"], ["hev:2:0", "COMPLETED", 0, "CLEARED", "SKIPPED"]]);
      assert.strictEqual(h.hulls(), before + 2);
      assert.deepStrictEqual(h.sites.calls, [["cleanup", "hev:1:0", "EVENT_CANCELLED"],
        ["cleanup", "hev:2:0", "EVENT_END"]]);
      const counters = svc.getStatus().counters;
      assert.deepStrictEqual([counters["cancelled.DISABLED"], counters["reward.skipped"], counters["planned.redoubt"]],
        [1, 1, 0]);
      assert.strictEqual(svc.getStatus().state, "stopped");
      assert.deepStrictEqual(h.start(false), { ok: false, reason: "disabled_by_config" });
      const fi = startHeavyEvents({ config: { ...configOf(false), factionIncursions: { ...BASE.factionIncursions,
        enabled: true } }, ctx: h.ctx, clock: { now: () => NOW }, getFactionKind: () => "pirate",
      setTimer: () => ({ cancel() {}, hasRef: () => false }), logger: { log() {} } });
      assert.ok(fi.ok, JSON.stringify(fi));
      assert.strictEqual(fi.heavyEvents.getStatus().state, "running");
      fi.heavyEvents.stop("test");
    });
  });

  test("HP6 funding station captured: hulls go to another station of the funder, none left -> orphaned", () => {
    withStore(driver, ({ store }) => {
      const h = harness(store);
      h.ctx.presence = { getStatus: () => ({ available: false }) };
      const st = h.ctx.stations.repository;
      const OTHER = "st:hev:2";
      const hullsOf = (id) => run(store, (tx) => st.getStock(tx, id)).items
        .filter((i) => i.itemKind === "hull").reduce((a, i) => a + i.quantity, 0);
      const capture = (stationId, key) => run(store, (tx) => {
        const rec = st.getStation(tx, stationId).record;
        const r = st.transitionStation(tx, { stationId, expectedVersion: rec.version, from: "ONLINE",
          to: "ARMOR_REINFORCE", key: `${key}:r`, reason: "siege", at: NOW });
        assert.ok(r.ok, JSON.stringify(r));
        const c = st.captureStation(tx, { stationId, expectedVersion: r.record.version, from: "ARMOR_REINFORCE",
          ownerFactionId: 500011, ownerCorporationId: 1000102, key, reason: "siege", at: NOW });
        assert.ok(c.ok, JSON.stringify(c));
      });
      run(store, (tx) => assert.ok(st.createStation(tx, { stationId: OTHER, kind: "upwell", structureFamily: "astrahus",
        systemId: SYS + 1, ownerFactionId: PIRATE, ownerCorporationId: 1000101, origin: "seed", at: NOW }, "hevt:st2").ok));
      planRow(store, h, "hev:1:0", ["cruiser", "cruiser"]);
      capture(STATION, "hevt:cap1");
      const svc = h.start(true).heavyEvents;
      svc.runPass(NOW);
      assert.deepStrictEqual(h.rows().map((r) => [r.state, r.end_reason]), [["CANCELLED", "CANCELLED"]]);
      assert.deepStrictEqual([h.hulls(), hullsOf(OTHER)], [0, 2]);
      planRow(store, h, "hev:2:0", ["cruiser"]);
      capture(OTHER, "hevt:cap2");
      svc.runPass(NOW + 1);
      assert.deepStrictEqual([h.hulls(), hullsOf(OTHER)], [0, 0]);
      const c = svc.getStatus().counters;
      assert.deepStrictEqual([c.hullsReturned, c.hullsOrphaned, c.errors], [2, 1, 0]);
      svc.stop("test");
    });
  });

  test("HP7 PRESENCE refusal keeps the bucket open (counted once), the next pass plans in the same bucket", () => {
    withStore(driver, ({ store }) => {
      const h = harness(store);
      const live = h.ctx.presence;
      h.ctx.presence = { getStatus: () => ({ available: false }) };
      const svc = h.start(true).heavyEvents;
      svc.runPass(NOW);
      svc.runPass(NOW + 1);
      assert.deepStrictEqual([svc.getStatus().counters["refused.PRESENCE"], h.rows().length], [1, 0]);
      h.ctx.presence = live;
      svc.runPass(NOW + 2);
      assert.strictEqual(svc.getStatus().counters["planned.redoubt"], 1);
      svc.stop("test");
    });
  });
};
