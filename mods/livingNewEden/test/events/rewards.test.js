"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { findServerSrcOnDisk, GAMESTORE_SEARCH_MAX_DEPTH } = require("../../lib/adapter/locator");
const { resolveSqliteDriver } = require("../../lib/adapter/sqliteDriver");
const { MIGRATIONS } = require("../../lib/persistence/migrations");
const { openStore } = require("../../lib/persistence/store");
const { createJournal } = require("../../lib/persistence/journal");
const { seedDbFile } = require("../_support/dbTemplate");
const { resolveConfig } = require("../../config");
const { validateCatalog, rewardLootIdIssue, EVENT_CATALOG, REWARD_EVENT_CATALOG } = require("../../lib/events/catalog");
const { REWARD_FACTIONS } = require("../../lib/events/data/eventCatalog");
const { startEvents } = require("../../lib/events");
const { createSiteService } = require("../../lib/events/sites/siteService");
const { FACADE_METHODS } = require("../../lib/adapter/nativeWrecks");
const { buildRewardLootTable } = require("../../lib/adapter/rewardLoot");
const { isMetricName } = require("../../lib/telemetry/registry");
const { MODULE_CHANNELS } = require("../../lib/telemetry/snapshot");
const { createEventRewardService, planCache, COUNTER_NAMES } = require("../../lib/events/rewards/rewardService");
const { startEventRewards, unavailableEventRewards } = require("../../lib/events/rewards");
const { buildDefaultServiceDefs } = require("../../lib/runtime/services");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const T0 = 1700000000000;
const HOUR = 3600000;
const DAY = Math.floor(T0 / 86400000);
const SYS = 30000011;
const SYS2 = 30000012;
const ANGEL = 500011;

function loadDriver() {
  const found = findServerSrcOnDisk(MOD_DIR, GAMESTORE_SEARCH_MAX_DEPTH, fs.existsSync);
  if (!found.ok) return { ok: false, detail: found.reason };
  return resolveSqliteDriver(found.srcDir);
}

function configOf(env = {}) {
  const r = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_EVENTS_ENABLED: "1", EVEJS_LNE_SITES_ENABLED: "1",
    EVEJS_LNE_EVENT_REWARDS_ENABLED: "1", ...env } });
  assert.deepStrictEqual(r.errors, []);
  return r.config;
}

function withStore(driver, fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lne-evrwd-"));
  const file = path.join(tmp, "world.sqlite");
  let store = null;
  try {
    seedDbFile(driver, file, { migrations: MIGRATIONS, seed: 1 });
    const opened = openStore({ filePath: file, openDatabase: (f) => new driver.Database(f), exclusiveLock: true,
      busyTimeoutMs: 0, maxRowsPerTransaction: 500, maxWriteMsPerPass: 5, randomSeed: () => 1,
      migrations: MIGRATIONS });
    assert.ok(opened.ok, JSON.stringify(opened));
    store = opened.store;
    assert.strictEqual(store.db, undefined, "production shape: no store.db");
    return fn(store);
  } finally {
    if (store) store.close("test");
    try {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch (_err) {
    }
  }
}

function eventRow(eventId, extra = {}) {
  return { eventId, eventType: "pirate_war_depot", state: "ACTIVE", sitesCreated: 1, systemId: SYS,
    factionId: ANGEL, reason: { contentFactionId: ANGEL }, createdAt: T0 - HOUR, expiresAt: T0 + 2 * HOUR,
    seed: 12345, ...extra };
}

function fakeSeam() {
  const wrecks = new Map();
  const calls = [];
  let nextWreck = 9000000;
  return {
    ok: true,
    wrecks,
    calls,
    flushes: 0,
    refuse: null,
    place(spec) {
      calls.push(spec);
      if (this.refuse) return { ok: false, reason: this.refuse, vendorWrites: 0 };
      const old = wrecks.get(spec.anomalyId);
      if (old) return { ok: true, adopted: true, wreckId: old, items: 3, factionItems: 0, spawned: false, vendorWrites: 0 };
      nextWreck += 1;
      wrecks.set(spec.anomalyId, nextWreck);
      return { ok: true, adopted: false, wreckId: nextWreck, items: 3, factionItems: 1, spawned: false, vendorWrites: 4 };
    },
    flush() {
      this.flushes += 1;
      return { ok: true };
    },
  };
}

function harness(store, opts = {}) {
  const clock = { t: T0, now() { return this.t; } };
  const config = opts.config || configOf(opts.env);
  const journal = createJournal({ clock, maxPayloadBytes: 16384, maxRows: 500 });
  const rows = [];
  const sitesOf = new Map();
  const reads = { events: 0, sites: 0 };
  const events = { listOpenEvents(o, tx) {
    reads.events += 1;
    assert.strictEqual(tx && tx.inTransaction, true, "listOpenEvents in the read tx");
    return { ok: true, events: rows.slice(0, o.limit), truncated: false };
  } };
  const sites = { listSitesByEvent(eventId, tx) {
    reads.sites += 1;
    assert.strictEqual(tx && tx.inTransaction, true, "listSitesByEvent in the read tx");
    return { ok: true, sites: sitesOf.get(eventId) || [] };
  } };
  const seam = fakeSeam();
  const governor = { admit: true, admits(c) { return c === "OPERATIONAL" ? this.admit : true; } };
  const telemetry = { counters: {}, observed: [], count(name, n = 1) { this.counters[name] = (this.counters[name] || 0)
    + n; return true; }, observe(name, v) { this.observed.push([name, v]); return true; } };
  const logger = { lines: [], log(line) { this.lines.push(line); } };
  const tx = (fn) => {
    const r = store.transaction("test", fn);
    assert.ok(r.ok, JSON.stringify(r));
    return r.value;
  };
  const make = (s = store) => createEventRewardService({ config, store: s, journal, telemetry, logger,
    getEvents: () => events, getSites: () => sites, getWrecks: () => seam, getGovernor: () => governor });
  const h = {
    clock, config, journal, rows, sitesOf, reads, seam, governor, telemetry, logger, tx, svc: make(), make,
    add(eventId, extra = {}, siteState = "ACTIVE") {
      const row = eventRow(eventId, extra);
      rows.push(row);
      sitesOf.set(eventId, [{ siteKey: `lne:${eventId}:0`, slot: 0, state: siteState, systemId: row.systemId }]);
      return row;
    },
    pass(at = T0) {
      clock.t = at;
      return h.svc.runPass(at);
    },
    keys: () => tx((db) => db.prepare("SELECT idempotency_key AS k FROM world_event_journal "
      + "WHERE idempotency_key LIKE 'evrwd:%' ORDER BY k").all().map((r) => r.k)),
  };
  return h;
}

module.exports = ({ test, skip }) => {
  const driver = loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  needsDriver("ERW1 catalog: flag off -> startEvents validates exactly EVENT_CATALOG (6 types); on -> 8 types; "
    + "reward field checked (profile, faction prefixes, loot id)", () => withStore(driver, (store) => {
    const scheduler = { registerHandler: () => ({ ok: true, unregister() {} }), enqueue: () => ({ ok: true }) };
    const start = (env) => {
      const config = configOf(env);
      const started = startEvents({ config, persistence: { ok: true, store, worldSeed: 1 },
        clock: { now: () => T0 }, ids: { next: () => "id" }, scheduler });
      assert.ok(started.ok, JSON.stringify(started));
      started.events.stop("test");
      return started.catalog.types.map((t) => t.eventType);
    };
    assert.deepStrictEqual(start({ EVEJS_LNE_EVENT_REWARDS_ENABLED: "0" }), EVENT_CATALOG.map((t) => t.eventType));
    assert.strictEqual(EVENT_CATALOG.length, 6);
    assert.deepStrictEqual(start({}), [...EVENT_CATALOG, ...REWARD_EVENT_CATALOG].map((t) => t.eventType));
    assert.deepStrictEqual(REWARD_EVENT_CATALOG.map((t) => [t.eventType, t.cause, t.startStates.join("/"), t.weight,
      t.durationMs / HOUR, t.cooldownMs / HOUR, t.reward, Object.keys(t.templatesByFaction).join(",")]), [
      ["pirate_war_depot", "OCCUPATION_CLAIM", "CONTESTED/INVASION", 2, 3, 8, "depot", "500010,500011,500012,500019,500020"],
      ["pirate_war_vault", "OCCUPATION_HELD", "OCCUPIED/CONSOLIDATING", 1, 4, 12, "vault",
        "500010,500011,500012,500019,500020"]]);

    const depot = REWARD_EVENT_CATALOG[0];
    const bad = (entry) => validateCatalog([entry]);
    assert.deepStrictEqual(bad({ ...depot, reward: "x" }).errors, ["catalog[0].reward must be one of depot, vault"]);
    assert.deepStrictEqual(bad({ ...depot, templatesByFaction: { 500021: ["client-dungeon:3710"] },
      causeFactions: [500021] }).errors, ["catalog[0].reward faction without prefixes: 500021"]);
    assert.strictEqual(bad({ ...depot, reward: "x" }).reason, "CATALOG_INVALID");
    assert.deepStrictEqual(["depot_medium", "x_officer_1", "belt_commander_1", "Depot_1", "depot_500011"]
      .map(rewardLootIdIssue), ["size_suffix", "denied_part", "denied_part", "pattern", null]);
  }));

  needsDriver("ERW2 happy path: ACTIVE event + slot 0 ACTIVE -> 1 place with the rewardLoot of the content faction, "
    + "key evrwd:<day>:<sys>:<id> in the journal; second pass -> no place", () => withStore(driver, (store) => {
    const h = harness(store);
    h.add("ev-a");
    const r = h.pass();
    assert.deepStrictEqual(r, { ok: true, placed: 1, adopted: 0, skipped: {}, refused: {}, deferred: false });
    assert.strictEqual(h.seam.calls.length, 1);
    const spec = h.seam.calls[0];
    assert.deepStrictEqual([spec.anomalyId, spec.slot, spec.siteKey, spec.systemId, spec.shipTypeId, spec.hullGroup,
      spec.lootRolls, spec.expiresAtMs, spec.nowMs, spec.lootTableId, spec.lootSourceNpcTypeId],
    ["evrwd_ev-a", 0, "lne:ev-a:0", SYS, 0, "cruiser", 2, T0 + 2 * HOUR, T0, undefined, undefined]);
    assert.deepStrictEqual(spec.rewardLoot, { id: `depot_${ANGEL}`, sizeBand: "medium",
      itemPrefixes: [...REWARD_FACTIONS[ANGEL].itemPrefixes], deadspacePrefixes: [...REWARD_FACTIONS[ANGEL].deadspacePrefixes],
      factionAmmoWeight: 20, factionModuleWeight: 4, deadspaceModuleWeight: 0, minEntries: 2, maxEntries: 3 });
    assert.strictEqual(buildRewardLootTable(spec.rewardLoot).ok, true, "the adapter accepts the spec");
    assert.strictEqual(Math.round(Math.hypot(spec.offset.x, spec.offset.z) / 100), 50, "cacheOffsetM 5000");
    assert.strictEqual(spec.fallbackWreckNames.at(-1), "Wreck");
    assert.deepStrictEqual(h.keys(), [`evrwd:${DAY}:${SYS}:ev-a`]);
    const entry = h.tx((db) => h.journal.findByKey(db, `evrwd:${DAY}:${SYS}:ev-a`)).entry;
    assert.deepStrictEqual([entry.aggregateType, entry.aggregateId, entry.eventType, entry.payload],
      ["event_reward", "ev-a", "EVENT_REWARD_PLACED", { eventId: "ev-a", systemId: SYS, contentFactionId: ANGEL,
        profile: "depot" }]);
    assert.strictEqual(h.seam.flushes, 1);
    assert.deepStrictEqual([h.telemetry.counters["eventRewards.placed"], h.telemetry.counters["eventRewards.items"],
      h.telemetry.counters["eventRewards.factionItems"]], [1, 3, 1]);
    assert.ok(h.logger.lines.includes(`eventRewards: cache event=ev-a sys=${SYS} faction=${ANGEL} profile=depot `
      + "wreck=9000001 items=3 factionItems=1 adopted=false"), h.logger.lines.join("\n"));
    h.seam.wrecks.clear();
    assert.deepStrictEqual(h.pass(T0 + 60000).placed, 0);
    assert.strictEqual(h.seam.calls.length, 1);
    assert.deepStrictEqual(h.svc.getStatus(), { state: "running", lastPassAt: T0 + 60000, placedTotal: 1,
      lastRefusal: null });
    h.add("ev-b", { eventType: "pirate_war_vault", systemId: SYS2, factionId: 500001,
      reason: { contentFactionId: 500020 } });
    h.pass(T0 + 120000);
    const vault = h.seam.calls[1];
    assert.deepStrictEqual([vault.rewardLoot.id, vault.rewardLoot.sizeBand, vault.hullGroup, vault.lootRolls],
      ["vault_500020", "large", "battleship", 3]);
    for (const name of COUNTER_NAMES) assert.ok(isMetricName(`eventRewards.${name}`), name);
    assert.ok(MODULE_CHANNELS.includes("eventRewards"));
  }));

  needsDriver("ERW3 restart: place ok, mark tx throws -> next pass places again with adoption -> 1 journal entry, "
    + "same key (from createdAt)", () => withStore(driver, (store) => {
    const h = harness(store);
    h.add("ev-a", { expiresAt: T0 + 30 * HOUR });
    let failMark = true;
    const flaky = { ...store, limits: store.limits, transaction(name, fn) {
      if (name === "eventRewards.mark" && failMark) {
        failMark = false;
        return { ok: false, reason: "TX_FAILED", error: new Error("crash before commit") };
      }
      return store.transaction(name, fn);
    } };
    h.svc = h.make(flaky);
    const first = h.pass();
    assert.deepStrictEqual([first.placed, first.adopted], [0, 0]);
    assert.deepStrictEqual(h.keys(), []);
    assert.ok(h.logger.lines.some((l) => l.startsWith("eventRewards: cache of event=ev-a placed, mark failed")));
    h.svc = h.make();
    assert.strictEqual(Math.floor((T0 + 24 * HOUR) / 86400000), DAY + 1);
    const second = h.pass(T0 + 24 * HOUR);
    assert.deepStrictEqual([second.placed, second.adopted], [0, 1]);
    assert.strictEqual(h.seam.calls.length, 2);
    assert.strictEqual(h.seam.wrecks.size, 1, "no second cache");
    assert.deepStrictEqual(h.keys(), [`evrwd:${DAY}:${SYS}:ev-a`]);
    assert.ok(h.logger.lines.some((l) => l.endsWith("factionItems=n/a adopted=true")), h.logger.lines.join("\n"));
    assert.deepStrictEqual([h.telemetry.counters["eventRewards.adopted"], h.telemetry.counters["eventRewards.items"]],
      [1, 3]);
    assert.strictEqual(h.pass(T0 + 24 * HOUR + 15000).adopted, 0);
    assert.strictEqual(h.seam.calls.length, 2);
  }));

  needsDriver("ERW4 caps: maxCachesPerDay and maxCachesPerSystemPerDay reached -> no place, skipped.CAP_*, no write",
    () => withStore(driver, (store) => {
      const h = harness(store, { env: { EVEJS_LNE_EVENT_REWARDS_MAX_CACHES_PER_DAY: "2",
        EVEJS_LNE_EVENT_REWARDS_MAX_PLACES_PER_PASS: "4" } });
      h.add("ev-1");
      h.add("ev-2", { createdAt: T0 - HOUR + 1 });
      h.add("ev-3", { systemId: SYS2, createdAt: T0 - HOUR + 2 });
      h.add("ev-4", { systemId: 30000013, createdAt: T0 - HOUR + 3 });
      const r = h.pass();
      assert.deepStrictEqual([r.placed, r.skipped], [2, { CAP_SYSTEM: 1, CAP_DAY: 1 }]);
      assert.deepStrictEqual(h.seam.calls.map((s) => s.anomalyId), ["evrwd_ev-1", "evrwd_ev-3"]);
      assert.deepStrictEqual(h.keys(), [`evrwd:${DAY}:${SYS}:ev-1`, `evrwd:${DAY}:${SYS2}:ev-3`]);
      const again = h.pass(T0 + 15000);
      assert.deepStrictEqual([again.placed, again.skipped], [0, { CAP_DAY: 2 }]);
      assert.strictEqual(h.seam.calls.length, 2);
      assert.deepStrictEqual([h.telemetry.counters["eventRewards.skipped.CAP_DAY"],
        h.telemetry.counters["eventRewards.skipped.CAP_SYSTEM"]], [3, 1]);
      h.add("ev-5", { systemId: 30000013, createdAt: T0 + 24 * HOUR, expiresAt: T0 + 27 * HOUR });
      assert.strictEqual(h.pass(T0 + 24 * HOUR + 1000).placed, 1);
      const one = harness(store);
      one.add("ev-p1", { systemId: 30000016 });
      one.add("ev-p2", { systemId: 30000017, createdAt: T0 - HOUR + 1 });
      assert.deepStrictEqual([one.pass().placed, one.seam.calls.map((s) => s.anomalyId)], [1, ["evrwd_ev-p1"]]);
      assert.deepStrictEqual([one.pass(T0 + 15000).placed, one.seam.calls.length], [1, 2]);
      const zero = harness(store, { env: { EVEJS_LNE_EVENT_REWARDS_MAX_CACHES_PER_DAY: "0" } });
      zero.add("ev-z", { systemId: 30000014 });
      assert.deepStrictEqual([zero.pass().skipped, zero.seam.calls.length], [{ CAP_DAY: 1 }, 0]);
    }));

  needsDriver("ERW5 no OPERATIONAL / slot 0 not ACTIVE / expired -> no place; real facades have the methods; start, "
    + "stub, registry, config warnings", () => withStore(driver, (store) => {
    const h = harness(store);
    h.add("ev-a");
    h.governor.admit = false;
    assert.deepStrictEqual(h.pass(), { ok: true, placed: 0, adopted: 0, skipped: {}, refused: {}, deferred: true });
    assert.deepStrictEqual([h.reads.events, h.seam.calls.length], [0, 0], "deferred: no transaction, no place");
    h.governor.admit = true;
    h.sitesOf.get("ev-a")[0].state = "CREATING";
    h.add("ev-x", { createdAt: T0 - 2 * HOUR, expiresAt: T0 });
    h.add("ev-o", { reason: { contentFactionId: 500021 } });
    assert.deepStrictEqual(h.pass().skipped, { EXPIRED: 1, SITE_NOT_ACTIVE: 1, NO_REWARD_FACTION: 1 });
    assert.strictEqual(h.seam.calls.length, 0);
    h.sitesOf.get("ev-a")[0].state = "ACTIVE";
    h.seam.refuse = "SITE_NOT_ACTIVE";
    const refused = h.pass(T0 + 15000);
    assert.deepStrictEqual([refused.placed, refused.refused], [0, { SITE_NOT_ACTIVE: 1 }]);
    assert.deepStrictEqual(h.keys(), []);
    assert.strictEqual(h.svc.getStatus().lastRefusal, "SITE_NOT_ACTIVE");
    h.seam.refuse = null;
    assert.strictEqual(h.pass(T0 + 30000).placed, 1);
    assert.deepStrictEqual(planCache(eventRow("p", { eventType: "pirate_incursion" }), null, { profiles: {},
      factions: {}, rewardTypes: new Map(), P: {}, now: T0 }), { ok: false, reason: "NOT_REWARD_TYPE" });

    const config = configOf();
    const scheduler = { registerHandler: () => ({ ok: true, unregister() {} }), enqueue: () => ({ ok: true }) };
    const ev = startEvents({ config, persistence: { ok: true, store, worldSeed: 1 }, clock: { now: () => T0 },
      ids: { next: () => "id" }, scheduler });
    assert.ok(ev.ok, JSON.stringify(ev));
    const siteService = createSiteService({ store, adapter: null, clock: { now: () => T0 }, config, telemetry: null });
    assert.ok(FACADE_METHODS.includes("place") && FACADE_METHODS.includes("flush"));
    const real = createEventRewardService({ config, store, journal: h.journal, getEvents: () => ev.events,
      getSites: () => siteService, getWrecks: () => h.seam });
    assert.deepStrictEqual(real.runPass(T0), { ok: true, placed: 0, adopted: 0, skipped: {}, refused: {},
      deferred: false });
    ev.events.stop("test");
    const stubbed = createEventRewardService({ config, store, journal: h.journal, telemetry: h.telemetry,
      getEvents: () => ({ listOpenEvents: () => ({ ok: false, reason: "EVENTS_DISABLED" }) }),
      getSites: () => siteService, getWrecks: () => h.seam });
    assert.deepStrictEqual(stubbed.runPass(T0), { ok: false, reason: "READ_REFUSED",
      detail: "listOpenEvents EVENTS_DISABLED" });
    assert.strictEqual(h.telemetry.counters["eventRewards.readRefused"], 1);

    assert.strictEqual(startEventRewards({ config: configOf({ EVEJS_LNE_EVENT_REWARDS_ENABLED: "0" }) }).reason,
      "disabled_by_config");
    assert.strictEqual(startEventRewards({ config, persistence: { ok: true, store }, clock: { now: () => T0 } })
      .reason, "dependency_disabled:persistence");
    const timers = [];
    const started = startEventRewards({ config, persistence: { ok: true, store, journal: h.journal },
      clock: { now: () => T0 }, setTimer: (fn, ms) => { timers.push(ms); return { cancel() {}, hasRef: () => false }; },
      getEvents: () => ev.events, getSites: () => siteService, getAdapter: () => ({ getNativeWrecks: () => h.seam }) });
    assert.ok(started.ok, JSON.stringify(started));
    assert.deepStrictEqual(timers, [15000], "one timer, pumpIntervalMs");
    started.eventRewards.stop();
    assert.strictEqual(started.eventRewards.getStatus().state, "stopped");
    assert.deepStrictEqual(Object.keys(unavailableEventRewards("EVENT_REWARDS_DISABLED")).sort(),
      Object.keys(started.eventRewards).sort());
    assert.strictEqual(unavailableEventRewards("EVENT_REWARDS_DISABLED").runPass(T0).reason, "EVENT_REWARDS_DISABLED");
    const defs = buildDefaultServiceDefs({});
    const def = defs.find((d) => d.name === "eventRewards");
    assert.deepStrictEqual([def.module, def.requires], ["events", ["persistence"]]);
    assert.strictEqual(defs.indexOf(def), defs.findIndex((d) => d.name === "salvageAnomaly") + 1, "after salvageAnomaly");
    const ctx = {};
    def.onUnavailable(ctx, "disabled_by_config");
    assert.strictEqual(ctx.eventRewards.getStatus().reason, "EVENT_REWARDS_DISABLED");

    assert.deepStrictEqual(resolveConfig({ modDir: MOD_DIR, env: {} }).warnings, []);
    assert.strictEqual(resolveConfig({ modDir: MOD_DIR, env: {} }).config.eventRewards.enabled, false);
    const warn = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_EVENT_REWARDS_ENABLED: "1",
      EVEJS_LNE_EVENT_REWARDS_MAX_CACHES_PER_DAY: "0", EVEJS_LNE_EVENT_REWARDS_MIN_ENTRIES: "4",
      EVEJS_LNE_EVENT_REWARDS_MAX_ENTRIES: "2" } }).warnings;
    assert.deepStrictEqual(warn, [
      "eventRewards.enabled without modules.events.enabled and modules.sites.enabled - no reward event and no cache",
      "eventRewards.maxCachesPerDay=0 with eventRewards.enabled - the reward types start without caches",
      "eventRewards.maxEntries=2 below eventRewards.minEntries=4 - 4 entries per roll"]);
    const lean = harness(store, { env: { EVEJS_LNE_EVENT_REWARDS_MIN_ENTRIES: "4", EVEJS_LNE_EVENT_REWARDS_MAX_ENTRIES: "2" } });
    lean.add("ev-m", { systemId: 30000015 });
    lean.pass();
    assert.deepStrictEqual([lean.seam.calls[0].rewardLoot.minEntries, lean.seam.calls[0].rewardLoot.maxEntries], [4, 4]);
  }));
};
