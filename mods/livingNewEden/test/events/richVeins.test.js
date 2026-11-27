"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { resolveConfig } = require("../../config");
const { validateCatalog, anomalyCatalogOf, richVeinCatalogOf, EVENT_CATALOG, REWARD_EVENT_CATALOG,
  DENIED_TEMPLATE_IDS } = require("../../lib/events/catalog");
const { RICH_VEIN_TEMPLATES, RICH_VEIN_FRONT_TEMPLATES, MOON_VEIN_TEMPLATES, RICH_VEIN_EVENT_CATALOG,
  CONTENT } = require("../../lib/events/data/eventCatalog");
const { causesOfSystem, liberatedCauses, frontCauses } = require("../../lib/events/candidates");
const { gatherPulseContext, buildDirectorInput } = require("../../lib/events/context");
const { causeHolds } = require("../../lib/events/eventMachine");
const { chooseEvents } = require("../../lib/events/director");
const { createEventService } = require("../../lib/events/eventService");
const { startEvents, unavailableEvents } = require("../../lib/events");
const { createNoiseTracker } = require("../../lib/miningEncounters/noise");
const { startMiningEncounters } = require("../../lib/miningEncounters/index");
const { findServerSrcOnDisk, GAMESTORE_SEARCH_MAX_DEPTH } = require("../../lib/adapter/locator");
const { resolveSqliteDriver } = require("../../lib/adapter/sqliteDriver");
const { MIGRATIONS } = require("../../lib/persistence/migrations");
const { openStore } = require("../../lib/persistence/store");
const { seedDbFile } = require("../_support/dbTemplate");
const { createJournal } = require("../../lib/persistence/journal");
const { createManualClock } = require("../../lib/util/clock");
const { createWorldStateRepository } = require("../../lib/world/worldStateRepository");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const { findPack, packLabel } = require("../_support/contentPacks");

const ORE_PACK = findPack("ore-anomalies");
const HOUR = 3600000;
const I = 300000;
const T0 = 5666667 * I;
const GURISTAS = 500010;
const AMARR = 500003;
const CALDARI = 500001;
const REGION = 10000060;
const VEIN = "rich_vein_liberated";

const ON = Object.freeze({ EVEJS_LNE_RICH_VEINS_ENABLED: "1" });
const RELICS_ON = Object.freeze({ EVEJS_LNE_EVENT_ANOMALIES_DIRECTOR_KINDS_ENABLED: "1",
  EVEJS_LNE_EVENT_ANOMALIES_BATTLE_RELICS_WEIGHT: "1" });

function configOf(env = {}) {
  const r = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_DATA_ROOT: os.tmpdir(), EVEJS_LNE_EVENTS_ENABLED: "1",
    EVEJS_LNE_SITES_ENABLED: "1", EVEJS_LNE_EVENTS_PRESENCE_ACTIVATION: "0", ...env } });
  assert.deepStrictEqual(r.errors, []);
  return r.config;
}

function catalogOf(env) {
  const config = configOf(env);
  const r = validateCatalog([...EVENT_CATALOG, ...anomalyCatalogOf(config), ...richVeinCatalogOf(config)]);
  assert.ok(r.ok, JSON.stringify(r.errors));
  return r.catalog;
}

function liberatedOf(config) {
  const R = config.richVeins;
  return { windowMs: R.liberatedWindowMs, maxRows: R.maxLiberatedRows, maxOpen: R.maxOpen, eventTypes: new Set([VEIN]) };
}

function fakeTelemetry() {
  const counters = {};
  return { counters, count(name, n = 1) { counters[name] = (counters[name] || 0) + n; return true; },
    gauge() { return true; }, observe() { return true; } };
}

function fakeStore() {
  const tx = { inTransaction: true, transaction: (body) => (...args) => body(...args) };
  return { tx, transaction(name, fn) {
    try {
      return { ok: true, value: fn(tx) };
    } catch (err) {
      return { ok: false, reason: String(err && err.message) };
    }
  } };
}

function fakeWorld(systems, occ, liberated) {
  const calls = [];
  const w = { calls, limits: { maxBatchReadIds: 400 },
    getSystems: (tx, list) => ({ ok: true, systems: list.filter((id) => systems.has(id)).map((id) => systems.get(id)),
      missing: list.filter((id) => !systems.has(id)) }),
    listActiveOccupations: () => ({ ok: true, systems: occ, nextAfterSystemId: null }),
    listLiberatedSince: (tx, opts) => {
      calls.push(opts);
      return typeof liberated === "function" ? liberated(opts) : { ok: true, systems: liberated || [], truncated: false };
    } };
  return w;
}

function fakeEventRepo(state) {
  return {
    listOpen: () => ({ ok: true, events: state.open, truncated: false }),
    listPendingCleanup: () => ({ ok: true, events: [] }),
    listRecent: () => ({ ok: true, truncated: false, rows: state.recent }),
    transitionInTx: (tx, id, version, patch) => {
      state.transitions.push([id, patch.state]);
      return { ok: true, version: version + 1 };
    },
    countOpenInSystem: () => ({ ok: true, count: 0 }),
    insertPlannedInTx: (tx, p) => {
      state.inserted.push(p);
      return { ok: true, inserted: true };
    },
    deleteEndedBefore: () => ({ ok: true, deleted: 0 }),
  };
}

const GRAPH = { getGraph: () => ({ ok: true, graph: { getSystem: (id) => ({ id, regionId: REGION, factionId: null }) } }) };
const sys = (systemId, extra = {}) => ({ systemId, securityClass: "nullsec", occupationState: "STABLE",
  occupierFactionId: null, controllerFactionId: AMARR, previousControllerFactionId: null, lastStateChangeAt: 0,
  ...extra });
const freed = (systemId, changedAt, extra = {}) => sys(systemId, { controllerFactionId: null,
  previousControllerFactionId: AMARR, lastStateChangeAt: changedAt, ...extra });
const LIMITS = Object.freeze({ maxNewEventsPerPass: 4, maxOpenEvents: 10, maxOpenEventsPerSystem: 1,
  maxNewSitesPerSystemPerWindow: 2, siteWindowMs: HOUR, presenceRadius: 0, presenceBonus: 0, maxSkipped: 50 });

function rig({ config, catalog, liberated = null, front = null, world, open = [], recent = [], occupation = null,
  siteStates = {} }) {
  const store = fakeStore();
  const state = { open, recent, transitions: [], inserted: [] };
  const telemetry = fakeTelemetry();
  const sites = { listSitesByEvent: (id) => ({ ok: true, sites: (siteStates[id] || []).map((s) => ({ state: s })) }) };
  const svc = createEventService({ config, store, clock: { now: () => T0 }, ids: { next: () => "ev-new" },
    scheduler: { enqueue: () => ({ ok: true }), registerHandler: () => ({ ok: true }) }, catalog,
    world: () => ({ repository: world }), strategy: () => ({ listActiveCampaigns: () => ({ ok: true, campaigns: [] }) }),
    presence: () => null, graph: () => GRAPH, sites: () => sites, occupation: () => occupation, telemetry,
    logger: { log() {} }, worldSeed: 1, nowMs: () => 0, repository: fakeEventRepo(state),
    ...(liberated ? { liberated } : {}), ...(front ? { front } : {}) });
  return { state, telemetry, svc,
    pulse(at, extra = {}) {
      const res = svc.pulseHandler({ payload: { intervalMs: config.events.refreshIntervalMs, ...extra } },
        { now: at, anchorAt: at, lateMs: 0, catchUp: false });
      assert.ok(res.ok, JSON.stringify(res));
      const value = res.effect(store.tx);
      res.onCommitted(value);
      return value;
    } };
}

function startTypes(config, adapter = null) {
  const lines = [];
  const started = startEvents({ config, persistence: { ok: true, store: fakeStore(), worldSeed: 1 },
    clock: { now: () => T0 }, ids: { next: () => "id" }, scheduler: { registerHandler: () => ({ ok: true, unregister() {} }),
      enqueue: () => ({ ok: true }) }, logger: { log: (l) => lines.push(l) }, ...(adapter ? { adapter } : {}) });
  assert.ok(started.ok, JSON.stringify(started));
  started.events.stop("test");
  return { types: started.catalog.types.map((t) => t.eventType), catalog: started.catalog, lines };
}

function readOf({ open = [], recent = [], occ = [], aftermath, liberated }) {
  const out = { ok: true, open: { events: open }, pending: { events: [] }, openSystems: new Map(), siteStates: new Map(),
    campaigns: { known: true, byId: new Map(), active: [] }, occ: { systems: occ, nextAfterSystemId: null },
    theatre: [], recent: { rows: recent, truncated: false }, stats: { readRefused: 0, siteReadRefused: 0 } };
  if (aftermath !== undefined) out.aftermath = aftermath;
  if (liberated !== undefined) out.liberated = liberated;
  return out;
}

const openVein = (eventId, systemId) => Object.freeze({ eventId, eventType: VEIN, systemId, cause: "LIBERATED",
  factionId: AMARR, campaignId: null, state: "PLANNED", sitesCreated: 0, dueAt: T0 + HOUR, expiresAt: T0 + 36 * HOUR,
  createdAt: T0 - HOUR, version: 1, templateIds: [RICH_VEIN_TEMPLATES[0]], label: "Rich Ore Vein",
  reason: { contentFactionId: 0 }, result: null, corrupt: false, spawnBudget: 1 });

function loadDriver() {
  const found = findServerSrcOnDisk(MOD_DIR, GAMESTORE_SEARCH_MAX_DEPTH, fs.existsSync);
  if (!found.ok) return { ok: false, detail: found.reason };
  return resolveSqliteDriver(found.srcDir);
}

function packTemplates(file) {
  const pack = JSON.parse(fs.readFileSync(file, "utf8"));
  return (pack.payload && pack.payload.dungeon && pack.payload.dungeon.templatesByID) || {};
}

module.exports = ({ test, skip }) => {
  test("RV1 flag off bit for bit: richVeinCatalogOf [] (off, on + weight 0), startEvents types = v2 and log line of "
    + "today, causesOfSystem with null liberated = today, zero listLiberatedSince calls, no liberated keys", () => {
    const off = configOf({ EVEJS_LNE_RICH_VEINS_LIBERATED_WEIGHT: "100" });
    assert.strictEqual(off.richVeins.enabled, false, "default off");
    assert.deepStrictEqual(richVeinCatalogOf(off), []);
    const zero = configOf({ ...ON, EVEJS_LNE_RICH_VEINS_LIBERATED_WEIGHT: "0" });
    assert.deepStrictEqual(richVeinCatalogOf(zero), []);
    const v2 = EVENT_CATALOG.map((t) => t.eventType);
    assert.deepStrictEqual(startTypes(off).types, v2);
    const offLines = startTypes(off).lines;
    assert.ok(offLines.some((l) => /^events: running .* director-kinds=none$/.test(l)), offLines.join("\n"));
    assert.deepStrictEqual(startTypes(zero).types, v2);
    assert.ok(startTypes(zero).lines.some((l) => / director-kinds=none rich-veins=none$/.test(l)));

    const s = freed(1, T0 - HOUR);
    assert.deepStrictEqual(causesOfSystem(s, [], null, null), causesOfSystem(s, []));
    assert.deepStrictEqual(causesOfSystem(s, [], null, undefined), causesOfSystem(s, []));
    assert.deepStrictEqual(causesOfSystem(s, []), []);

    const held = sys(201, { occupationState: "OCCUPIED", occupierFactionId: GURISTAS });
    const world = fakeWorld(new Map([[201, held]]), [held], [s]);
    const r = rig({ config: off, catalog: catalogOf({}), world });
    r.pulse(T0);
    assert.strictEqual(world.calls.length, 0);
    assert.deepStrictEqual(Object.keys(r.telemetry.counters).filter((k) => /liberated|richVeins/.test(k)), []);
    assert.deepStrictEqual(r.state.inserted.map((x) => x.eventType), ["pirate_stronghold"]);
    const read = fakeStore().transaction("t", (tx) => gatherPulseContext(tx, { repo: fakeEventRepo({ open: [],
      recent: [] }), worldRepository: world, sites: null, strategy: null, P: off.events, maxBatchReadIds: 400,
    lookbackMs: HOUR, cursor: 0 }, { at: T0, boot: false })).value;
    assert.ok(read.ok && !("liberated" in read) && !("liberatedStats" in read));
    assert.strictEqual(world.calls.length, 0);
  });

  test("RV2 catalog: validates with v2 + rewards + anomaly kinds, key 0 only in NEUTRAL, label noun, no consequence, "
    + "effective cooldown >= window, config times; the validator refuses NEUTRAL with a faction key, SELF with key 0, "
    + "LIBERATED outside STABLE", () => {
    const config = configOf({ ...ON, ...RELICS_ON, EVEJS_LNE_EVENT_ANOMALIES_DED_COMPLEX_WEIGHT: "1" });
    const rich = richVeinCatalogOf(config);
    assert.deepStrictEqual(rich.map((t) => [t.eventType, t.cause, t.content, t.weight, t.durationMs, t.cooldownMs,
      t.aftermathMs, "weightKey" in t]), [[VEIN, "LIBERATED", "NEUTRAL", 3, 36 * HOUR, 48 * HOUR, 600000, false]]);
    const r = validateCatalog([...EVENT_CATALOG, ...REWARD_EVENT_CATALOG, ...anomalyCatalogOf(config), ...rich]);
    assert.ok(r.ok, JSON.stringify(r.errors));
    for (const t of r.catalog.types) {
      assert.strictEqual("0" in t.templatesByFaction, t.content === CONTENT.NEUTRAL, t.eventType);
    }
    const vein = r.catalog.byType[VEIN];
    assert.deepStrictEqual([...vein.templatesByFaction[0]], [...RICH_VEIN_TEMPLATES]);
    assert.deepStrictEqual([vein.labelNoun, vein.clearedConsequence, vein.reward, [...vein.securityClasses],
      [...vein.startStates]], ["Rich Ore Vein", false, undefined, ["nullsec"], ["STABLE"]]);
    const c0 = richVeinCatalogOf(configOf({ ...ON, EVEJS_LNE_RICH_VEINS_COOLDOWN_MS: "0" }))[0];
    assert.strictEqual(c0.cooldownMs, 6 * HOUR);
    const wide = richVeinCatalogOf(configOf({ ...ON, EVEJS_LNE_RICH_VEINS_COOLDOWN_MS: String(HOUR),
      EVEJS_LNE_RICH_VEINS_LIBERATED_WINDOW_MS: String(24 * HOUR) }))[0];
    assert.strictEqual(wide.cooldownMs, 24 * HOUR);
    const short = richVeinCatalogOf(configOf({ ...ON, EVEJS_LNE_RICH_VEINS_DURATION_MS: "600000",
      EVEJS_LNE_RICH_VEINS_AFTERMATH_MS: "3600000" }));
    assert.strictEqual(short[0].aftermathMs, 600000);
    assert.ok(validateCatalog([...short]).ok);
    const base = rich[0];
    assert.deepStrictEqual(validateCatalog([{ ...base, templatesByFaction: { [GURISTAS]: ["client-dungeon:1562"] } }])
      .errors, ["catalog[0].templatesByFaction for NEUTRAL must have exactly the key 0"]);
    assert.deepStrictEqual(validateCatalog([{ ...EVENT_CATALOG[0], templatesByFaction: { 0: ["client-dungeon:1562"] } }])
      .errors, ["catalog[0].templatesByFaction key 0 only for NEUTRAL content"]);
    assert.deepStrictEqual(validateCatalog([{ ...base, startStates: ["STABLE", "RECON"] }]).errors,
      ["catalog[0].startStates for LIBERATED must be [\"STABLE\"], got RECON"]);
    assert.deepStrictEqual(RICH_VEIN_EVENT_CATALOG.map((t) => t.weightKey), ["liberatedWeight", "frontWeight"]);
  });

  const driver = loadDriver();
  const rv3Name = "RV3 listLiberatedSince on SQLite (DESC, window, truncated, refusals) and the pulse: a vein of the "
    + "abandon in the window, no cause outside it / with a controller / without a previous one; one candidate for a "
    + "system of both paths; maxOpen with 2 systems in one pulse; refused read -> liberated.refused, others plan";
  if (!driver.ok) skip(rv3Name, `better-sqlite3 unavailable (${driver.detail})`);
  else {
    test(rv3Name, () => {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lne-rv-"));
      const file = path.join(tmp, "world.sqlite");
      try {
        seedDbFile(driver, file, { migrations: MIGRATIONS, seed: 1 });
        const opened = openStore({ filePath: file, openDatabase: (f) => new driver.Database(f), exclusiveLock: true,
          busyTimeoutMs: 0, maxRowsPerTransaction: 500, maxWriteMsPerPass: 5, randomSeed: () => 1,
          migrations: MIGRATIONS });
        assert.ok(opened.ok, JSON.stringify(opened));
        try {
          const clock = createManualClock(T0);
          const journal = createJournal({ clock, maxPayloadBytes: 8192, maxRows: 500 });
          const world = createWorldStateRepository({ journal, clock,
            limits: { maxFactionsPerSystem: 8, maxBatchReadIds: 8, maxListLimit: 64 } });
          const tx = (f) => {
            const r = opened.store.transaction("test", f);
            assert.ok(r.ok, JSON.stringify(r));
            return r.value;
          };
          tx((db) => {
            const ins = db.prepare(`INSERT INTO world_system_state (system_id, security_class, controller_faction_id,
              occupation_state, threat_level, last_state_change_at, updated_at, version, previous_controller_faction_id)
              VALUES (?, 'nullsec', ?, ?, 0, ?, 0, 1, ?)`);
            ins.run(1, null, "STABLE", 1000, CALDARI);
            ins.run(2, null, "STABLE", 3000, AMARR);
            ins.run(3, null, "STABLE", 4000, null);
            ins.run(4, AMARR, "STABLE", 5000, CALDARI);
            ins.run(5, null, "CONTESTED", 6000, CALDARI);
            ins.run(6, null, "STABLE", 3000, GURISTAS);
            ins.run(7, null, "STABLE", 500, CALDARI);
          });
          const ids = (r) => [r.systems.map((s) => s.systemId), r.truncated];
          assert.deepStrictEqual(ids(tx((db) => world.listLiberatedSince(db, { sinceMs: 900, limit: 10 }))),
            [[2, 6, 1], false]);
          assert.deepStrictEqual(ids(tx((db) => world.listLiberatedSince(db, { sinceMs: 900, limit: 2 }))),
            [[2, 6], true]);
          const one = tx((db) => world.listLiberatedSince(db, { sinceMs: 2000, limit: 10 }));
          assert.deepStrictEqual([one.systems[0].previousControllerFactionId, one.systems[0].lastStateChangeAt,
            one.systems[0].controllerFactionId, one.systems[0].securityClass], [AMARR, 3000, null, "nullsec"]);
          assert.strictEqual(tx((db) => world.listLiberatedSince(db, { sinceMs: -1, limit: 1 })).reason,
            "WORLD_INVALID_INPUT");
          assert.strictEqual(tx((db) => world.listLiberatedSince(db, { sinceMs: 0, limit: 0 })).reason,
            "WORLD_INVALID_INPUT");
          assert.strictEqual(world.listLiberatedSince(null, { sinceMs: 0, limit: 1 }).reason, "TX_REQUIRED");
        } finally {
          opened.store.close("test_cleanup");
        }
      } finally {
        try {
          fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
        } catch (_err) {
        }
      }

      const config = configOf(ON);
      const catalog = catalogOf(ON);
      const L = liberatedOf(config);
      const rows = [freed(101, T0 - HOUR), freed(102, T0 - 7 * HOUR), freed(103, T0 - HOUR, { controllerFactionId: CALDARI }),
        freed(104, T0 - HOUR, { previousControllerFactionId: null })];
      const world = fakeWorld(new Map(), [], rows);
      const r = rig({ config, catalog, liberated: L, world });
      r.pulse(T0);
      assert.deepStrictEqual(world.calls, [{ sinceMs: T0 - 6 * HOUR, limit: 64 }]);
      assert.strictEqual(r.state.inserted.length, 1);
      const p = r.state.inserted[0];
      assert.deepStrictEqual([p.eventType, p.cause, p.systemId, p.factionId, p.contentFactionId, p.label, p.spawnBudget,
        p.expiresAt - p.dueAt], [VEIN, "LIBERATED", 101, AMARR, 0, "Rich Ore Vein", 1, 36 * HOUR]);
      assert.ok(RICH_VEIN_TEMPLATES.includes(p.templateIds[0]), p.templateIds[0]);
      assert.strictEqual(p.reason.contentFactionId, 0);
      assert.deepStrictEqual([r.telemetry.counters["events.liberated.read"], r.telemetry.counters["events.liberated.causes"],
        r.telemetry.counters["events.liberated.refused"]], [1, 1, undefined]);

      const both = configOf({ ...ON, ...RELICS_ON });
      const bothCatalog = catalogOf({ ...ON, ...RELICS_ON });
      const A = both.eventAnomalies;
      const aftermath = { windowMs: A.battleRelicsWindowMs, minLosses: A.battleRelicsMinLosses, maxLossRows: A.maxLossRows,
        maxSystems: A.battleRelicsMaxSystems, factions: new Set([GURISTAS]), getBattleRepository: () => null };
      const s101 = freed(101, T0 - HOUR);
      const read = readOf({ aftermath: { losses: [{ systemId: 101, factionId: GURISTAS, count: 3, settledAt: T0 - HOUR }],
        systems: [s101], truncated: false, systemsTruncated: false }, liberated: { systems: [s101], truncated: false } });
      const input = buildDirectorInput(read, { catalog: bothCatalog, P: both.events, limits: LIMITS,
        graph: GRAPH.getGraph().graph, presence: null, excludedRegionIds: [], aftermath, liberated: liberatedOf(both) },
      { at: T0, seed: 7, round: 1, intervalMs: I, boot: false });
      assert.deepStrictEqual(input.context.candidates.map((c) => [c.systemId, c.causes.map((x) => x.cause)]),
        [[101, ["BATTLE_AFTERMATH", "LIBERATED"]]]);
      assert.deepStrictEqual([input.aftermathCauses, input.liberatedCauses, input.richVeinsCapped], [1, 1, 0]);
      const chosen = chooseEvents(input.context);
      assert.ok(chosen.ok, JSON.stringify(chosen));
      assert.strictEqual(chosen.plans.length, 1);

      const two = [freed(301, T0 - 3 * HOUR), freed(302, T0 - HOUR)];
      const full = rig({ config, catalog, liberated: L, world: fakeWorld(new Map(), [], two),
        open: [openVein("V1", 401), openVein("V2", 402)] });
      full.pulse(T0);
      assert.deepStrictEqual(full.state.inserted, []);
      assert.strictEqual(full.telemetry.counters["events.richVeins.capped"], 2);
      const half = buildDirectorInput(readOf({ open: [openVein("V1", 401)], liberated: { systems: two, truncated: false } }),
        { catalog, P: config.events, limits: LIMITS, graph: GRAPH.getGraph().graph, presence: null,
          excludedRegionIds: [], liberated: L }, { at: T0, seed: 7, round: 1, intervalMs: I, boot: false });
      assert.deepStrictEqual(half.context.candidates.map((c) => c.systemId), [302]);
      assert.deepStrictEqual([half.liberatedCauses, half.richVeinsCapped], [1, 1]);
      const planned = chooseEvents(half.context);
      assert.deepStrictEqual(planned.plans.map((x) => [x.eventType, x.systemId]), [[VEIN, 302]]);
      const cooled = buildDirectorInput(readOf({ open: [openVein("V1", 401)], recent: [{ systemId: 302, eventType: VEIN,
        createdAt: T0 - 2 * HOUR, spawnBudget: 1, resultReference: null }], liberated: { systems: two, truncated: false } }),
      { catalog, P: config.events, limits: LIMITS, graph: GRAPH.getGraph().graph, presence: null,
        excludedRegionIds: [], liberated: L }, { at: T0, seed: 7, round: 1, intervalMs: I, boot: false });
      assert.deepStrictEqual(chooseEvents(cooled.context).plans.map((x) => x.systemId), [301]);

      const held = sys(201, { occupationState: "OCCUPIED", occupierFactionId: GURISTAS });
      const refusing = rig({ config, catalog, liberated: L,
        world: fakeWorld(new Map([[201, held]]), [held], () => ({ ok: false, reason: "TX_REQUIRED" })) });
      refusing.pulse(T0);
      assert.strictEqual(refusing.telemetry.counters["events.liberated.refused"], 1);
      assert.strictEqual(refusing.telemetry.counters["events.liberated.read"], undefined);
      assert.deepStrictEqual(refusing.state.inserted.map((x) => [x.eventType, x.systemId]), [["pirate_stronghold", 201]]);
    });
  }

  test("RV4 machine: causeHolds LIBERATED true (also CONTESTED again); ACTIVE vein with mined-out site -> "
    + "START_AFTERMATH, COMPLETING past dueAt -> FINISH CLEARED, zero dropInfluenceInTx at 20 points", () => {
    const row = { cause: "LIBERATED", factionId: AMARR, campaignId: null };
    assert.strictEqual(causeHolds(row, freed(1, T0), []), true);
    assert.strictEqual(causeHolds(row, sys(1, { occupationState: "CONTESTED", occupierFactionId: GURISTAS }), []), true);
    assert.strictEqual(causeHolds(row, null, []), null);
    assert.deepStrictEqual(liberatedCauses(freed(1, T0), null), []);

    const config = configOf(ON);
    assert.strictEqual(config.events.clearedInfluencePoints, 20);
    const catalog = catalogOf(ON);
    const calls = [];
    const occupation = { dropInfluenceInTx: (tx, spec, key) => {
      calls.push(key);
      return { ok: true, outcome: "APPLIED", written: true, before: 30, next: 10 };
    } };
    const vein = (eventId, systemId, state, dueAt) => ({ ...openVein(eventId, systemId), state, sitesCreated: 1, dueAt,
      version: 2 });
    const contested = sys(503, { occupationState: "CONTESTED", occupierFactionId: GURISTAS, controllerFactionId: null });
    const r = rig({ config, catalog, occupation, world: fakeWorld(new Map([[501, freed(501, T0)], [502, freed(502, T0)],
      [503, contested]]), [], []),
    open: [vein("E1", 501, "ACTIVE", T0 - HOUR), vein("E2", 502, "COMPLETING", T0 - 1), vein("E3", 503, "ACTIVE", T0 - HOUR)],
    siteStates: { E1: ["COMPLETED"], E3: ["ACTIVE"] } });
    r.pulse(T0);
    assert.deepStrictEqual(r.state.transitions, [["E1", "COMPLETING"], ["E2", "COMPLETED"]], "E3 claimed again stays");
    assert.deepStrictEqual(calls, []);
  });

  const packPresent = ORE_PACK !== null;
  const REPO_ROOT = path.resolve(MOD_DIR, "..", "..");
  const RESOURCE_COMPILER = path.join(REPO_ROOT, "tools", "ClientDungeonCompiler", "lib", "resourceCompiler.js");
  const RESOURCE_BINDING = path.join(REPO_ROOT, "server", "src", "contentPacks", "generatedResourceBinding.js");
  const rv5 = "RV5 vendor fact (pack + setup binding): every rich vein template (liberated + front) is an ore "
    + "anomaly bound to the generated ore layout, without an authored faction or encounters, completed by "
    + "deplete_all_mining_rocks; none is DENIED";
  if (!packPresent) skip(rv5, `${packLabel("ore-anomalies")} not found`);
  else if (!fs.existsSync(RESOURCE_COMPILER) || !fs.existsSync(RESOURCE_BINDING)) {
    skip(rv5, "the setup resource compiler or the generated resource binding not found");
  } else {
    test(rv5, () => {
      const compiler = fs.readFileSync(RESOURCE_COMPILER, "utf8");
      assert.ok(compiler.includes("completion: { objectiveMode: \"deplete_all_mining_rocks\" },"),
        "the generated ore layout ends when the rocks are mined out");
      const binding = fs.readFileSync(RESOURCE_BINDING, "utf8");
      assert.ok(binding.includes("const result = mergeAuthoring(native, template);")
        && binding.includes("native.resourceFamily !== family"), "the pack authoring is merged over the native layout");
      const templates = packTemplates(ORE_PACK);
      const problems = [];
      for (const id of [...RICH_VEIN_TEMPLATES, ...RICH_VEIN_FRONT_TEMPLATES]) {
        const t = templates[id];
        if (!t) {
          problems.push(`${id} missing`);
          continue;
        }
        const hints = t.populationHints || {};
        const ok = t.siteFamily === "ore" && t.siteKind === "anomaly"
          && t.nativeResourceBinding && t.nativeResourceBinding.resourceFamily === "ore"
          && !Object.prototype.hasOwnProperty.call(t, "factionID")
          && Array.isArray(hints.encounters) && hints.encounters.length === 0 && !hints.encounter;
        if (!ok) problems.push(`${id} not a faction-free mined-out ore anomaly`);
        if (DENIED_TEMPLATE_IDS.includes(id)) problems.push(`${id} denied`);
      }
      assert.deepStrictEqual(problems, []);
    });
  }

  const FRONT = "rich_vein_front";
  const FRONT_ON = Object.freeze({ ...ON, EVEJS_LNE_RICH_VEINS_FRONT_WEIGHT: "1" });
  const MOON_ON = Object.freeze({ ...ON, EVEJS_LNE_RICH_VEINS_MOON_TEMPLATES_ENABLED: "1" });
  const frontSettingsOf = (config) => ({ maxOpen: config.richVeins.maxOpen, eventTypes: new Set([FRONT]) });
  const disputed = (systemId, state, changedAt, extra = {}) => sys(systemId, { occupationState: state,
    occupierFactionId: GURISTAS, lastStateChangeAt: changedAt, ...extra });
  const inputOf = (read, config, catalog, more) => buildDirectorInput(read, { catalog, P: config.events, limits: LIMITS,
    graph: GRAPH.getGraph().graph, presence: null, excludedRegionIds: [], ...more },
  { at: T0, seed: 7, round: 1, intervalMs: I, boot: false });
  const openOf = (eventId, eventType, systemId, cause) => Object.freeze({ ...openVein(eventId, systemId), eventType, cause });
  const claimRecent = (catalog, systemId, createdAt) => catalog.types.filter((t) => t.cause === "OCCUPATION_CLAIM")
    .map((t) => ({ systemId, eventType: t.eventType, createdAt, spawnBudget: 1, resultReference: null }));

  test("RVF1 off bit for bit: frontWeight 0 and moonTemplatesEnabled false by default -> the catalog of "
    + "start line rich-veins=rich_vein_liberated, causesOfSystem with null front =, no frontCauses key", () => {
    const config = configOf(ON);
    assert.deepStrictEqual([config.richVeins.frontWeight, config.richVeins.moonTemplatesEnabled], [0, false]);
    const rich = richVeinCatalogOf(config);
    assert.deepStrictEqual(rich.map((t) => t.eventType), [VEIN]);
    assert.strictEqual(rich[0].templatesByFaction, RICH_VEIN_EVENT_CATALOG[0].templatesByFaction);
    assert.ok(startTypes(config).lines.some((l) => / director-kinds=none rich-veins=rich_vein_liberated$/.test(l)));
    const s = disputed(1, "CONTESTED", T0);
    assert.deepStrictEqual(causesOfSystem(s, [], null, null, null), causesOfSystem(s, []));
    assert.deepStrictEqual(causesOfSystem(s, [], null, null, undefined), causesOfSystem(s, []));
    assert.ok(!causesOfSystem(s, []).some((c) => c.cause === "FRONT_LINE"));
    const input = inputOf(readOf({ occ: [s] }), config, catalogOf(ON), { liberated: liberatedOf(config) });
    assert.ok(!("frontCauses" in input));
    assert.ok(!input.context.candidates.some((c) => c.causes.some((x) => x.cause === "FRONT_LINE")));
  });

  test("RVF2 FRONT_LINE: CONTESTED / INVASION with an occupier -> cause, causeHolds true; type rich_vein_front; "
    + "the combat type (weight 3) wins the slot, the vein is SYSTEM_BUSY, then plans in the combat cooldown", () => {
    const cause = (state) => ({ cause: "FRONT_LINE", factionId: GURISTAS, campaignId: null, occupationState: state,
      opponents: [] });
    assert.deepStrictEqual(frontCauses(disputed(1, "CONTESTED", T0)), [cause("CONTESTED")]);
    assert.deepStrictEqual(frontCauses(disputed(1, "INVASION", T0)), [cause("INVASION")]);
    for (const state of ["RECON", "OCCUPIED", "CONSOLIDATING", "STABLE"]) {
      assert.deepStrictEqual(frontCauses(disputed(1, state, T0)), [], state);
    }
    assert.deepStrictEqual(frontCauses(disputed(1, "CONTESTED", T0, { occupierFactionId: null })), []);
    const row = { cause: "FRONT_LINE", factionId: GURISTAS, campaignId: null };
    assert.strictEqual(causeHolds(row, sys(1), []), true, "the dispute ended");
    assert.strictEqual(causeHolds(row, disputed(1, "CONTESTED", T0), []), true);

    const config = configOf(FRONT_ON);
    const rich = richVeinCatalogOf(config);
    assert.deepStrictEqual(rich.map((t) => [t.eventType, t.cause, t.content, t.weight, [...t.startStates],
      [...t.securityClasses], t.labelNoun, t.clearedConsequence, t.cooldownMs]),
    [[VEIN, "LIBERATED", "NEUTRAL", 3, ["STABLE"], ["nullsec"], "Rich Ore Vein", false, 48 * HOUR],
      [FRONT, "FRONT_LINE", "NEUTRAL", 1, ["CONTESTED", "INVASION"], ["nullsec"], "Frontline Ore Vein", false, 48 * HOUR]]);
    assert.deepStrictEqual([...rich[1].templatesByFaction[0]], [...RICH_VEIN_FRONT_TEMPLATES]);
    const c0 = richVeinCatalogOf(configOf({ ...FRONT_ON, EVEJS_LNE_RICH_VEINS_COOLDOWN_MS: "0" }));
    assert.deepStrictEqual(c0.map((t) => t.cooldownMs), [6 * HOUR, 0], "the window only for LIBERATED");
    assert.deepStrictEqual(validateCatalog([{ ...rich[1], startStates: ["CONTESTED", "STABLE"] }]).errors,
      ["catalog[0].startStates for FRONT_LINE must be subset of CLAIM_STATES, got STABLE"]);
    assert.ok(startTypes(config).lines.some((l) => / rich-veins=rich_vein_liberated,rich_vein_front$/.test(l)));

    const catalog = catalogOf(FRONT_ON);
    const F = frontSettingsOf(config);
    const s = disputed(601, "CONTESTED", T0 - HOUR);
    const first = inputOf(readOf({ occ: [s] }), config, catalog, { front: F });
    assert.deepStrictEqual(first.context.candidates[0].causes.map((x) => x.cause), ["FRONT_LINE", "OCCUPATION_CLAIM"]);
    assert.deepStrictEqual([first.frontCauses, first.richVeinsCapped], [1, 0]);
    assert.deepStrictEqual(chooseEvents(first.context).plans.map((p) => [p.eventType, p.systemId]),
      [["pirate_incursion", 601]]);
    const busy = chooseEvents(inputOf(readOf({ occ: [s], open: [openOf("C1", "pirate_incursion", 601,
      "OCCUPATION_CLAIM")] }), config, catalog, { front: F }).context);
    assert.deepStrictEqual(busy.plans, []);
    assert.ok(busy.skipped.some((x) => x.systemId === 601 && x.eventType === FRONT && x.reason === "SYSTEM_BUSY"));

    const world = fakeWorld(new Map(), [s], []);
    const r = rig({ config, catalog, front: F, world, recent: claimRecent(catalog, 601, T0 - 2 * HOUR) });
    r.pulse(T0);
    assert.strictEqual(world.calls.length, 0);
    assert.strictEqual(r.state.inserted.length, 1);
    const p = r.state.inserted[0];
    assert.deepStrictEqual([p.eventType, p.cause, p.systemId, p.factionId, p.contentFactionId, p.label,
      p.expiresAt - p.dueAt], [FRONT, "FRONT_LINE", 601, GURISTAS, 0, "Frontline Ore Vein", 36 * HOUR]);
    assert.ok(RICH_VEIN_FRONT_TEMPLATES.includes(p.templateIds[0]), p.templateIds[0]);
    assert.strictEqual(r.telemetry.counters["events.front.causes"], 1);
  });

  test("RVF3 richVeins.maxOpen counts the front veins with the abandon veins: full -> the FRONT_LINE cause is cut "
    + "(the claim cause stays); one free place, the newer front system taken by the combat type -> the abandon plans "
    + "", () => {
    const config = configOf(FRONT_ON);
    const catalog = catalogOf(FRONT_ON);
    const L = liberatedOf(config);
    const F = { maxOpen: config.richVeins.maxOpen, eventTypes: new Set([FRONT]) };
    const s = disputed(601, "CONTESTED", T0 - HOUR);
    const full = inputOf(readOf({ occ: [s], open: [openVein("V1", 401), openOf("V2", FRONT, 402, "FRONT_LINE")],
      liberated: { systems: [], truncated: false } }), config, catalog, { liberated: L, front: F });
    assert.deepStrictEqual(full.context.candidates.map((c) => [c.systemId, c.causes.map((x) => x.cause)]),
      [[601, ["OCCUPATION_CLAIM"]]]);
    assert.deepStrictEqual([full.frontCauses, full.liberatedCauses, full.richVeinsCapped], [0, 0, 1]);
    const onlyFront = inputOf(readOf({ occ: [s], open: [openOf("V1", FRONT, 401, "FRONT_LINE"),
      openOf("V2", FRONT, 402, "FRONT_LINE")] }), config, catalog, { front: F });
    assert.deepStrictEqual([onlyFront.frontCauses, onlyFront.richVeinsCapped, "liberatedCauses" in onlyFront],
      [0, 1, false]);
    const half = inputOf(readOf({ occ: [s], open: [openVein("V1", 401)],
      liberated: { systems: [freed(302, T0 - 3 * HOUR)], truncated: false } }), config, catalog, { liberated: L, front: F });
    assert.deepStrictEqual(half.context.candidates.map((c) => [c.systemId, c.causes.map((x) => x.cause)]),
      [[601, ["FRONT_LINE", "OCCUPATION_CLAIM"]], [302, ["LIBERATED"]]]);
    assert.deepStrictEqual([half.frontCauses, half.liberatedCauses, half.richVeinsCapped], [1, 1, 0]);
    assert.deepStrictEqual(chooseEvents(half.context).plans.map((p) => [p.eventType, p.systemId]).sort(),
      [["pirate_incursion", 601], [VEIN, 302]]);
  });

  test("RVF4 moon templates: the validator takes evejs-mod:moon-ore:r(4|8|16|32|64):v<n> only; with the flag the "
    + "abandon vein lists R16/R32/R64; a seam without the moonOre mod removes them at start", () => {
    assert.deepStrictEqual([...MOON_VEIN_TEMPLATES], ["evejs-mod:moon-ore:r16:v1", "evejs-mod:moon-ore:r32:v1",
      "evejs-mod:moon-ore:r64:v1"]);
    assert.ok(MOON_VEIN_TEMPLATES.every((id) => !DENIED_TEMPLATE_IDS.includes(id)));
    const base = richVeinCatalogOf(configOf(ON))[0];
    const ok = ["evejs-mod:moon-ore:r4:v1", "evejs-mod:moon-ore:r8:v2", "evejs-mod:moon-ore:r64:v10"];
    assert.ok(validateCatalog([{ ...base, templatesByFaction: { 0: ok } }]).ok);
    for (const bad of ["evejs-mod:moon-ore:r12:v1", "evejs-mod:moon-ore:r16", "evejs-mod:moon-gas:r16:v1"]) {
      assert.deepStrictEqual(validateCatalog([{ ...base, templatesByFaction: { 0: [bad] } }]).errors,
        [`catalog[0].templatesByFaction[0] contains invalid template ID: ${bad}`], bad);
    }
    const config = configOf(MOON_ON);
    const rich = richVeinCatalogOf(config);
    assert.deepStrictEqual([...rich[0].templatesByFaction[0]], [...RICH_VEIN_TEMPLATES, ...MOON_VEIN_TEMPLATES]);
    assert.ok(validateCatalog([...EVENT_CATALOG, ...rich]).ok);
    const both = richVeinCatalogOf(configOf({ ...MOON_ON, EVEJS_LNE_RICH_VEINS_FRONT_WEIGHT: "1" }));
    assert.deepStrictEqual([...both[1].templatesByFaction[0]], [...RICH_VEIN_FRONT_TEMPLATES], "front without moon");

    const seam = (missing) => ({ getDungeonSites: () => ({ ok: true,
      checkTemplates: (ids) => ({ ok: true, missing: ids.filter(missing) }) }) });
    const noMod = startTypes(config, seam((id) => id.startsWith("evejs-mod:moon-ore:")));
    assert.deepStrictEqual([...noMod.catalog.byType[VEIN].templatesByFaction[0]], [...RICH_VEIN_TEMPLATES]);
    assert.ok(noMod.lines.some((l) => l.startsWith("events: templates missing in EveJS")
      && MOON_VEIN_TEMPLATES.every((id) => l.includes(id))), noMod.lines.join("\n"));
    assert.ok(noMod.lines.some((l) => / rich-veins=rich_vein_liberated$/.test(l)));
    const withMod = startTypes(config, seam(() => false));
    assert.deepStrictEqual([...withMod.catalog.byType[VEIN].templatesByFaction[0]],
      [...RICH_VEIN_TEMPLATES, ...MOON_VEIN_TEMPLATES]);
  });

  test("RVS1 richVeinSystems: empty before the first pulse; after a committed pulse (boot too) the systems of the "
    + "vein rows in ACTIVE / COMPLETING after the effect, frozen; no vein type / stopped / unavailable -> empty", () => {
    const config = configOf(ON);
    const catalog = catalogOf(ON);
    const vein = (eventId, systemId, state, dueAt) => ({ ...openVein(eventId, systemId), state, sitesCreated: 1, dueAt,
      version: 2 });
    const contested = sys(503, { occupationState: "CONTESTED", occupierFactionId: GURISTAS, controllerFactionId: null });
    const setup = (more) => rig({ config, catalog, world: fakeWorld(new Map([[501, freed(501, T0)],
      [502, freed(502, T0)], [503, contested]]), [], []),
    open: [vein("E1", 501, "ACTIVE", T0 - HOUR), vein("E2", 502, "COMPLETING", T0 - 1),
      vein("E3", 503, "ACTIVE", T0 - HOUR), openVein("E4", 504),
      { ...vein("E5", 505, "ACTIVE", T0 - HOUR), eventType: "pirate_stronghold", cause: "OCCUPATION_CLAIM" }],
    siteStates: { E1: ["COMPLETED"], E3: ["ACTIVE"], E5: ["ACTIVE"] }, ...more });
    const r = setup({ liberated: liberatedOf(config) });
    assert.strictEqual(r.svc.richVeinSystems().size, 0);
    r.pulse(T0, { boot: true });
    assert.deepStrictEqual(r.state.transitions.slice(0, 2), [["E1", "COMPLETING"], ["E2", "COMPLETED"]]);
    const set = r.svc.richVeinSystems();
    assert.deepStrictEqual([...set].sort(), [501, 503]);
    assert.ok(Object.isFrozen(set) && set instanceof Set);
    assert.throws(() => set.add(1), TypeError);
    assert.strictEqual(r.svc.richVeinSystems(), set, "one instance between pulses (memory only)");
    r.pulse(T0 + I);
    assert.deepStrictEqual([...r.svc.richVeinSystems()].sort(), [501, 503]);
    const off = setup({});
    off.pulse(T0, { boot: true });
    assert.strictEqual(off.svc.richVeinSystems().size, 0);
    assert.strictEqual(unavailableEvents("EVENTS_DISABLED").richVeinSystems().size, 0);
    const started = startEvents({ config, persistence: { ok: true, store: fakeStore(), worldSeed: 1 },
      clock: { now: () => T0 }, ids: { next: () => "id" }, scheduler: { registerHandler: () => ({ ok: true,
        unregister() {} }), enqueue: () => ({ ok: true }) }, logger: { log() {} } });
    assert.ok(started.ok);
    assert.strictEqual(started.events.richVeinSystems().size, 0);
    started.events.stop("test");
    assert.strictEqual(started.events.richVeinSystems().size, 0);
  });

  test("RVS2 miningEncounters.richVeinNoisePermille (default 2000): an ore event in a vein system makes x2 noise, "
    + "elsewhere / ice x1; floor with min noisePerEvent, then the scaled maxNoisePerMinute; 1000 = bit for bit "
    + "no getter call",
  () => {
    const D = configOf({}).miningEncounters;
    assert.strictEqual(D.richVeinNoisePermille, 2000);
    assert.strictEqual(configOf({ EVEJS_LNE_MINING_ENCOUNTERS_RICH_VEIN_NOISE_PERMILLE: "1000" }).miningEncounters
      .richVeinNoisePermille, 1000);
    const S = { ...D, noisePerEvent: 1, maxNoisePerMinute: 3, threshold: 1000 };
    const tracker = createNoiseTracker({ config: S, rng: () => 0.99 });
    const ev = (systemId, m, atMs = T0) => ({ characterId: 7, systemId, band: "nullsec", yieldKind: "ore", atMs,
      ...(m === undefined ? {} : { noiseMultiplierPermille: m }) });
    assert.deepStrictEqual([ev(1, 2000), ev(1, 2000), ev(2), ev(3, 1000), ev(4, 2500), ev(5, 1500)]
      .map((e) => tracker.noteEvent(e).added), [2, 2, 1, 1, 2, 1], "The vein minute ceiling is 3 x 2 = 6");
    const two = createNoiseTracker({ config: { ...S, noisePerEvent: 2, maxNoisePerMinute: 10 }, rng: () => 0.99 });
    assert.strictEqual(two.noteEvent(ev(1, 1500)).added, 3);

    const seam = { bandOf: () => ({ ok: true, band: "nullsec", eligible: true, baseMin: 1, baseMax: 2, security: -0.5 }),
      locate: () => ({ ok: false, reason: "READ_FAILED" }), spawnWave: () => ({ ok: false, reason: "SPAWN_FAILED" }),
      readVendorBeltFlags: () => ({ ok: true, ratsEnabled: true }) };
    let reads = 0;
    const veins = new Set([30002]);
    const events = { richVeinSystems: () => {
      reads += 1;
      return veins;
    } };
    const run = (over, getEvents) => {
      const counts = new Map();
      const telemetry = { count: (name, n) => counts.set(name, (counts.get(name) || 0) + n), observe() {} };
      const started = startMiningEncounters({ config: { miningEncounters: { ...S, enabled: true, ...over } },
        clock: { now: () => T0 }, telemetry, seam, rng: () => 0.99, defer: () => {},
        ...(getEvents ? { getEvents } : {}) });
      assert.ok(started.ok);
      const send = (characterId, systemId, yieldKind) => started.encounters.onLedgerEvent({ characterId, systemId,
        yieldKind, atMs: T0 });
      send(1, 30002, "ore");
      send(2, 30003, "ore");
      send(3, 30002, "ice");
      return [counts.get("world.miningEncounters.noise") || 0, counts.get("world.miningEncounters.hookError") || 0];
    };
    assert.deepStrictEqual(run({}, () => events), [4, 0], "2 + 1 + 1");
    assert.strictEqual(reads, 2, "ice never reads the set");
    const today = run({}, null);
    assert.deepStrictEqual(today, [3, 0]);
    assert.deepStrictEqual(run({ richVeinNoisePermille: 1000 }, () => events), today);
    assert.strictEqual(reads, 2, "1000 = no getter call");
    assert.deepStrictEqual(run({}, () => unavailableEvents("EVENTS_DISABLED")), today);
    assert.deepStrictEqual(run({}, () => {
      throw new Error("boom");
    }), today, "a getter fault = x1, no hookError");
  });

  test("RVS3: a newer abandon refused by a Director gate (WINDOW_FULL, REGION_EXCLUDED) takes no "
    + "place of free, the older one plans; a lowsec abandon is not counted in liberated.causes nor in capped", () => {
    const config = configOf(ON);
    const catalog = catalogOf(ON);
    const two = [freed(301, T0 - 3 * HOUR), freed(302, T0 - HOUR)];
    const base = { catalog, P: config.events, limits: LIMITS, graph: GRAPH.getGraph().graph, presence: null,
      excludedRegionIds: [], liberated: liberatedOf(config) };
    const opts = { at: T0, seed: 7, round: 1, intervalMs: I, boot: false };
    const window = buildDirectorInput(readOf({ open: [openVein("V1", 401)], recent: [{ systemId: 302,
      eventType: "pirate_stronghold", createdAt: T0 - 600000, spawnBudget: LIMITS.maxNewSitesPerSystemPerWindow,
      resultReference: null }], liberated: { systems: two, truncated: false } }), base, opts);
    assert.deepStrictEqual([window.liberatedCauses, window.richVeinsCapped], [2, 0]);
    const w = chooseEvents(window.context);
    assert.deepStrictEqual(w.plans.map((p) => [p.eventType, p.systemId]), [[VEIN, 301]]);
    assert.ok(w.skipped.some((x) => x.systemId === 302 && x.reason === "WINDOW_FULL"));
    const OTHER = 10000070;
    const graph = { getSystem: (id) => ({ id, regionId: id === 302 ? OTHER : REGION, factionId: null }) };
    const region = buildDirectorInput(readOf({ open: [openVein("V1", 401)], liberated: { systems: two,
      truncated: false } }), { ...base, graph, excludedRegionIds: [OTHER] }, opts);
    assert.deepStrictEqual(chooseEvents(region.context).plans.map((p) => [p.eventType, p.systemId]), [[VEIN, 301]]);
    const both = buildDirectorInput(readOf({ open: [openVein("V1", 401)], liberated: { systems: two,
      truncated: false } }), base, opts);
    assert.deepStrictEqual([both.context.candidates.map((c) => c.systemId), both.richVeinsCapped], [[302], 1]);
    const low = buildDirectorInput(readOf({ liberated: { systems: [freed(303, T0 - HOUR, { securityClass: "lowsec" })],
      truncated: false } }), base, opts);
    assert.deepStrictEqual([low.context.candidates.length, low.liberatedCauses, low.richVeinsCapped], [1, 0, 0]);
    const cut = buildDirectorInput(readOf({ open: [openVein("V1", 401), openVein("V2", 402)], liberated: { systems:
      [freed(303, T0 - HOUR, { securityClass: "lowsec" }), freed(301, T0 - 3 * HOUR)], truncated: false } }), base, opts);
    assert.deepStrictEqual([cut.context.candidates.length, cut.liberatedCauses, cut.richVeinsCapped], [0, 0, 1]);
  });

  test("RVS4: with the default noise config 1, 2, 3 and 5 ledger rows a minute make x2 noise in a vein "
    + "system (the minute ceiling scales too); 1000 = the same noise as no multiplier", () => {
    const D = configOf({}).miningEncounters;
    assert.deepStrictEqual([D.noisePerEvent, D.maxNoisePerMinute], [1, 3]);
    const S = { ...D, threshold: 100000 };
    const MIN = 60000;
    const noiseOf = (rows, m) => {
      const tracker = createNoiseTracker({ config: S, rng: () => 0.99 });
      let sum = 0;
      for (let minute = 0; minute < 10; minute += 1) {
        for (let k = 0; k < rows; k += 1) {
          sum += tracker.noteEvent({ characterId: 7, systemId: 1, band: "nullsec", yieldKind: "ore",
            atMs: T0 + minute * MIN + Math.floor((k * MIN) / rows),
            ...(m === undefined ? {} : { noiseMultiplierPermille: m }) }).added;
        }
      }
      return sum;
    };
    assert.deepStrictEqual([1, 2, 3, 5].map((rows) => [noiseOf(rows), noiseOf(rows, 2000), noiseOf(rows, 1000)]),
      [[10, 20, 10], [20, 40, 20], [30, 60, 30], [30, 60, 30]]);
  });
};
