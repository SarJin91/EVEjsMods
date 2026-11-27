"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { resolveConfig } = require("../../config");
const { createViewRegistry } = require("../../lib/observer/views");
const { buildSiegesLayerView, LAYER_ID, toItems, LEGEND } = require("../../lib/stations/siege/siegesLayer");
const { buildSiegesView, VIEW_ID } = require("../../lib/stations/siege/siegesView");
const { buildStructureWreckField, buildWreckField, checkSettings, SETTING_NAMES } = require("../../lib/world/wreckPool");
const { placeFieldInTx, createWreckConsequence, EXPIRE_EVENT } = require("../../lib/world/wreckConsequence");
const { WRECK_ACTIVE, WRECK_EXPIRED } = require("../../lib/world/wreckSchema");
const { createJournal } = require("../../lib/persistence/journal");
const { MIGRATIONS } = require("../../lib/persistence/migrations");
const { findServerSrcOnDisk, GAMESTORE_SEARCH_MAX_DEPTH } = require("../../lib/adapter/locator");
const { resolveSqliteDriver } = require("../../lib/adapter/sqliteDriver");
const { openStore } = require("../../lib/persistence/store");
const { seedDbFile } = require("../_support/dbTemplate");
const { createManualClock } = require("../../lib/util/clock");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const DEFAULTS = resolveConfig({ modDir: MOD_DIR, env: {} }).config;

const NOW_MS = 1760000000000;
const SYS_1 = 30000001;
const SYS_2 = 30000002;
const FACTION_ATTACKER = 500019;
const FACTION_OWNER = 500003;

function clockAt(ms) {
  return { now: () => ms };
}

function fakeStore(isOpen = true) {
  return {
    isOpen: () => isOpen,
    transaction: (name, fn) => {
      const tx = { inTransaction: true };
      try {
        const value = fn(tx);
        return { ok: true, value };
      } catch (err) {
        return { ok: false, reason: String(err) };
      }
    },
  };
}

function fakeRepository(sieges = [], totals = {}) {
  return {
    listOpen: (db, opts) => {
      const limit = opts && opts.limit ? opts.limit : sieges.length;
      return { ok: true, sieges: sieges.slice(0, limit), truncated: sieges.length > limit };
    },
    readTotals: () => ({ ok: true, totals }),
    getChangeCount: () => 42,
  };
}

function fakeGovernor(admits = true) {
  return { admits: (cls) => (cls === "MAINTENANCE" ? admits : true) };
}

function fakeTelemetry() {
  const obs = [];
  return {
    observe: (name, val) => obs.push({ name, val }),
    get obs() { return obs; },
  };
}

function fakeScheduler() {
  const enq = [];
  return {
    enqueue: (type, key, at, payload, idem, opts) => {
      enq.push({ type, key, at, payload, idem, opts });
      return { ok: true };
    },
    get enqueued() { return enq; },
  };
}

function fakeWreckRepository(fields = new Map()) {
  return {
    countActive: (tx, opts) => {
      let n = 0;
      for (const f of fields.values()) if (f.status === WRECK_ACTIVE) n++;
      return { ok: true, count: n };
    },
    oldestActive: (tx, opts) => {
      let oldest = null;
      for (const f of fields.values()) {
        if (f.status === WRECK_ACTIVE) {
          if (!oldest || f.createdAt < oldest.createdAt) oldest = f;
        }
      }
      return { ok: true, field: oldest || null };
    },
    insertInTx: (tx, field, idem) => {
      if (fields.has(field.fieldId)) return { ok: true, duplicate: true };
      fields.set(field.fieldId, { ...field, status: WRECK_ACTIVE, version: 1 });
      return { ok: true, duplicate: false };
    },
    transitionInTx: (tx, params, idem) => {
      const f = fields.get(params.fieldId);
      if (!f) return { ok: true, duplicate: true };
      f.status = params.to;
      f.endReason = params.endReason;
      f.version += 1;
      return { ok: true, duplicate: false };
    },
    get fields() { return fields; },
  };
}

function defaultWreckSettings() {
  return {
    fieldTtlMs: 604800000,
    decayFloor: 0.25,
    minShipsLost: 1,
    maxCompositionEntries: 64,
    salvageYieldFactor: 1,
    lootYieldFactor: 1,
    stockLootPermille: 100,
    maxFieldsPerSystem: 3,
    maxFieldsGlobal: 2000,
  };
}

function defaultSiegeSettings() {
  return {
    maxOpenSieges: 100,
    maxOpenSiegesPerFaction: 10,
    timerScale: 1,
    assaultMinMs: 3600000,
    assaultMaxMs: 10800000,
    stockLootPermille: 100,
    captureUpwell: false,
    allowHighsec: false,
    retentionMs: 604800000,
    sackCooldownMs: 259200000,
    pruneBatch: 16,
    reconcileMaxSieges: 256,
    maxChecksPerPass: 32,
    maxStepsPerPass: 16,
    maxWaitRounds: 4,
    maxFleetsReadPerCheck: 32,
    recheckMs: 3600000,
  };
}

function defaultObserverSettings() {
  return {
    galaxyEnabled: true,
    galaxySiegesEnabled: true,
    galaxySiegesMaxSystems: 1000,
    galaxySiegesRefreshMs: 15000,
    siegesPanelMaxRows: 100,
  };
}

module.exports = ({ test, skip }) => {

  test("M1 layer-sieges: toItems produces one mark per system with versus shape", () => {
    const sieges = [
      { siegeId: "s1", systemId: SYS_1, state: "SHIELD_ASSAULT", phaseEndsAt: NOW_MS + 3600000,
        attackerFactionId: FACTION_ATTACKER, ownerFactionId: FACTION_OWNER },
      { siegeId: "s2", systemId: SYS_1, state: "ARMOR_TIMER", phaseEndsAt: NOW_MS + 7200000,
        attackerFactionId: FACTION_ATTACKER, ownerFactionId: FACTION_OWNER },
      { siegeId: "s3", systemId: SYS_2, state: "HULL_ASSAULT", phaseEndsAt: NOW_MS + 10800000,
        attackerFactionId: 500020, ownerFactionId: 500001 },
    ];
    const items = toItems(sieges, 6, NOW_MS);
    assert.strictEqual(items.length, 2, "one mark per system");
    const sys1 = items.find((i) => i[0] === SYS_1);
    assert.ok(sys1, "SYS_1 mark exists");
    assert.strictEqual(sys1[1], "siege-assault", "style for assault phase");
    assert.strictEqual(sys1[2], `${FACTION_ATTACKER}v${FACTION_OWNER} ×2`, "label shows count");
    assert.strictEqual(sys1[5], "solid", "dash solid for assault");
    assert.deepStrictEqual(sys1[4], [[FACTION_ATTACKER, 1], [FACTION_OWNER, 1]], "factions both sides");
    const sys2 = items.find((i) => i[0] === SYS_2);
    assert.ok(sys2, "SYS_2 mark exists");
    assert.strictEqual(sys1[5], "solid", "assault is solid");
  });

  test("M1 layer-sieges: timer phase (ARMOR_TIMER) uses dashed style", () => {
    const sieges = [
      { siegeId: "s1", systemId: SYS_1, state: "ARMOR_TIMER", phaseEndsAt: NOW_MS + 3600000,
        attackerFactionId: FACTION_ATTACKER, ownerFactionId: FACTION_OWNER },
    ];
    const items = toItems(sieges, 6, NOW_MS);
    assert.strictEqual(items[0][1], "siege-timer", "style for timer phase");
    assert.strictEqual(items[0][5], "dashed", "dash dashed for timer");
  });

  test("M1 layer-sieges: view registry register/unregister, cacheKey buckets by refreshMs", () => {
    const views = createViewRegistry();
    const store = fakeStore();
    const repo = fakeRepository([]);
    const clock = clockAt(NOW_MS);
    const telemetry = fakeTelemetry();
    const gov = fakeGovernor();
    const nowMs = () => NOW_MS;
    const cfg = defaultObserverSettings();
    const view = buildSiegesLayerView({
      store, repository: repo, clock, getGovernor: () => gov, telemetry,
      nowMs, maxSieges: 100, maxSystems: cfg.galaxySiegesMaxSystems,
      maxLines: 6, refreshMs: cfg.galaxySiegesRefreshMs,
    });
    const reg = views.registerView(LAYER_ID, view);
    assert.strictEqual(reg.ok, true);
    assert.strictEqual(views.getView(LAYER_ID).title, "Sieges");
    assert.strictEqual(views.getView(LAYER_ID).mapLayer.kind, "marks");
    assert.strictEqual(views.getView(LAYER_ID).mapLayer.order, 14);

    const key1 = view.cacheKey();
    assert.strictEqual(key1, `k${Math.floor(NOW_MS / cfg.galaxySiegesRefreshMs)}`);

    const view2 = buildSiegesLayerView({
      store, repository: repo, clock, getGovernor: () => gov, telemetry,
      nowMs: () => NOW_MS + 100, maxSieges: 100, maxSystems: cfg.galaxySiegesMaxSystems,
      maxLines: 6, refreshMs: cfg.galaxySiegesRefreshMs,
    });
    assert.strictEqual(view2.cacheKey(), key1, "same bucket = same cacheKey");

    const nextBucket = NOW_MS + cfg.galaxySiegesRefreshMs;
    const view3 = buildSiegesLayerView({
      store, repository: repo, clock: clockAt(nextBucket), getGovernor: () => gov, telemetry,
      nowMs: () => nextBucket, maxSieges: 100, maxSystems: cfg.galaxySiegesMaxSystems,
      maxLines: 6, refreshMs: cfg.galaxySiegesRefreshMs,
    });
    assert.notStrictEqual(view3.cacheKey(), key1, "next bucket = new cacheKey");

    reg.unregister();
    assert.strictEqual(views.getView(LAYER_ID), null);
  });

  test("M1 layer-sieges: governor hold -> cacheKey null, available false", () => {
    const views = createViewRegistry();
    const store = fakeStore();
    const repo = fakeRepository([]);
    const clock = clockAt(NOW_MS);
    const telemetry = fakeTelemetry();
    const gov = fakeGovernor(false);
    const view = buildSiegesLayerView({
      store, repository: repo, clock, getGovernor: () => gov, telemetry,
      nowMs: () => NOW_MS, maxSieges: 100, maxSystems: 1000,
      maxLines: 6, refreshMs: 15000,
    });
    const reg = views.registerView(LAYER_ID, view);
    assert.strictEqual(view.cacheKey(), null, "hold -> no cacheKey");
    const data = view.getData();
    assert.strictEqual(data.available, false);
    assert.strictEqual(data.reason, "GOVERNOR_HOLD");
    reg.unregister();
  });

  test("M1 layer-sieges: closed store -> available false", () => {
    const views = createViewRegistry();
    const store = fakeStore(false);
    const repo = fakeRepository([]);
    const clock = clockAt(NOW_MS);
    const telemetry = fakeTelemetry();
    const gov = fakeGovernor();
    const view = buildSiegesLayerView({
      store, repository: repo, clock, getGovernor: () => gov, telemetry,
      nowMs: () => NOW_MS, maxSieges: 100, maxSystems: 1000,
      maxLines: 6, refreshMs: 15000,
    });
    const reg = views.registerView(LAYER_ID, view);
    const data = view.getData();
    assert.strictEqual(data.available, false);
    assert.strictEqual(data.reason, "STORE_CLOSED");
    reg.unregister();
  });

  test("M1 layer-sieges: galaxySiegesEnabled=false -> layer not registered in startSiege (config gating)", () => {
    const offConfig = { ...defaultObserverSettings(), galaxySiegesEnabled: false };
    const views = createViewRegistry();
    const store = fakeStore();
    const repo = fakeRepository([]);
    const clock = clockAt(NOW_MS);
    const telemetry = fakeTelemetry();
    const gov = fakeGovernor();
    const view = buildSiegesLayerView({
      store, repository: repo, clock, getGovernor: () => gov, telemetry,
      nowMs: () => NOW_MS, maxSieges: 100, maxSystems: offConfig.galaxySiegesMaxSystems,
      maxLines: 6, refreshMs: offConfig.galaxySiegesRefreshMs,
    });
    assert.ok(typeof view.getData === "function");
  });

  test("M1 panel sieges: view registry, cacheKey includes changeCount + seq, data shape", () => {
    const views = createViewRegistry();
    const store = fakeStore();
    const repo = fakeRepository(
      [{ siegeId: "s1", stationId: "st1", systemId: SYS_1, state: "SHIELD_ASSAULT",
        phaseEndsAt: NOW_MS + 3600000, attackerFactionId: FACTION_ATTACKER, ownerFactionId: FACTION_OWNER,
        waitRound: 0 }],
      { [FACTION_ATTACKER]: { started: 1, won: 0, repelled: 0, besieged: 1, defended: 0, lost_destroyed: 0, lost_captured: 0, sacked: 0, gained_captured: 0, stock_units_lost: 0 },
        [FACTION_OWNER]: { started: 0, won: 0, repelled: 0, besieged: 1, defended: 0, lost_destroyed: 0, lost_captured: 0, sacked: 0, gained_captured: 0, stock_units_lost: 100 } }
    );
    const clock = clockAt(NOW_MS);
    const gov = fakeGovernor();
    const factionNames = new Map([[FACTION_ATTACKER, "Sansha's Nation"], [FACTION_OWNER, "Amarr Empire"]]);
    const graph = { getGraph: () => ({ ok: true, graph: { getSystem: (id) => ({ name: `System ${id}` }) } }) };
    const getStatus = () => ({ state: "running", reason: null, seed: 1, seq: 7 });
    const view = buildSiegesView({
      store, repository: repo, getStatus, clock, getGovernor: () => gov,
      graph, factionNames, maxRows: 100,
    });
    const reg = views.registerView(VIEW_ID, view);
    assert.strictEqual(reg.ok, true);
    assert.strictEqual(views.getView(VIEW_ID).title, "Open sieges");
    assert.strictEqual(views.getView(VIEW_ID).order, 60);

    const key = view.cacheKey();
    assert.strictEqual(key, "s42|7");

    const data = view.getData();
    assert.strictEqual(data.available, true);
    assert.strictEqual(data.sieges.length, 1);
    const s = data.sieges[0];
    assert.strictEqual(s.siege, "s1");
    assert.strictEqual(s.station, "st1");
    assert.strictEqual(s.system, `System ${SYS_1}`);
    assert.strictEqual(s.attacker, "Sansha's Nation");
    assert.strictEqual(s.owner, "Amarr Empire");
    assert.strictEqual(s.state, "SHIELD_ASSAULT");
    assert.strictEqual(s.phaseLabel, "1h", "Label counts from the injected mod clock");
    assert.strictEqual(s.waitRound, 0);
    assert.ok(data.totals["Sansha's Nation"]);
    assert.ok(data.totals["Amarr Empire"]);
    assert.strictEqual(data.totals["Amarr Empire"].stockUnitsLost, 100);

    reg.unregister();
    assert.strictEqual(views.getView(VIEW_ID), null);
  });

  test("M1 panel sieges: closed store / governor hold -> available false, cacheKey null", () => {
    const views = createViewRegistry();
    const store = fakeStore(false);
    const repo = fakeRepository([]);
    const getStatus = () => ({ state: "running", seq: 1 });
    const gov = fakeGovernor();
    const view = buildSiegesView({
      store, repository: repo, getStatus, getGovernor: () => gov,
      graph: null, factionNames: new Map(), maxRows: 100,
    });
    const reg = views.registerView(VIEW_ID, view);
    assert.strictEqual(view.cacheKey(), null);
    const data = view.getData();
    assert.strictEqual(data.available, false);
    assert.strictEqual(data.reason, "STORE_CLOSED");
    reg.unregister();
  });

  test("M1 panel sieges: config gating siegesPanelMaxRows respected in listOpen limit", () => {
    const manySieges = Array.from({ length: 150 }, (_, i) => ({
      siegeId: `s${i}`, stationId: `st${i}`, systemId: SYS_1 + (i % 10),
      state: "SHIELD_ASSAULT", phaseEndsAt: NOW_MS + 3600000,
      attackerFactionId: FACTION_ATTACKER, ownerFactionId: FACTION_OWNER, waitRound: 0,
    }));
    const repo = fakeRepository(manySieges, {});
    const store = fakeStore();
    const getStatus = () => ({ state: "running", seq: 1 });
    const gov = fakeGovernor();
    const view = buildSiegesView({
      store, repository: repo, getStatus, getGovernor: () => gov,
      graph: null, factionNames: new Map(), maxRows: 50,
    });
    const data = view.getData();
    assert.strictEqual(data.sieges.length, 50, "limited by maxRows");
    assert.strictEqual(data.truncated, true, "truncated flag set");
  });

  test("M2 buildStructureWreckField: creates field with correct shape and id", () => {
    const params = {
      stationId: "st-123",
      siegeNo: 1,
      systemId: SYS_1,
      environment: "nullsec",
      ownerFactionId: FACTION_OWNER,
      winnerFactionId: FACTION_ATTACKER,
      typeId: 35832,
      family: "astrahus",
      lostUnits: 5000,
      at: NOW_MS,
    };
    const settings = defaultWreckSettings();
    const result = buildStructureWreckField(params, settings);
    assert.strictEqual(result.ok, true);
    const f = result.field;
    assert.strictEqual(f.fieldId, "wf:st:st-123:1");
    assert.strictEqual(f.source, "structure");
    assert.strictEqual(f.systemId, SYS_1);
    assert.strictEqual(f.environment, "nullsec");
    assert.strictEqual(f.outcome, "DESTROYED");
    assert.strictEqual(f.winnerFactionId, FACTION_ATTACKER);
    assert.strictEqual(f.shipsLost, 1);
    assert.deepStrictEqual(f.composition, [[FACTION_OWNER, "capital", 35832, 1]]);
    assert.ok(Number.isSafeInteger(f.salvageUnits) && f.salvageUnits >= 0);
    assert.ok(Number.isSafeInteger(f.lootUnits) && f.lootUnits >= 0);
    assert.ok(f.lootUnits >= f.salvageUnits || f.lootUnits >= 0);
    assert.strictEqual(f.createdAt, NOW_MS);
    assert.strictEqual(f.expiresAt, NOW_MS + settings.fieldTtlMs);
  });

  test("M2 buildStructureWreckField: validation rejects bad input", () => {
    const good = {
      stationId: "st-123", siegeNo: 1, systemId: SYS_1, environment: "nullsec",
      ownerFactionId: FACTION_OWNER, winnerFactionId: FACTION_ATTACKER,
      typeId: 35832, family: "astrahus", lostUnits: 5000, at: NOW_MS,
    };
    const settings = defaultWreckSettings();
    assert.strictEqual(buildStructureWreckField({ ...good, stationId: "" }, settings).reason, "WRECK_INPUT_INVALID");
    assert.strictEqual(buildStructureWreckField({ ...good, siegeNo: 0 }, settings).reason, "WRECK_INPUT_INVALID");
    assert.strictEqual(buildStructureWreckField({ ...good, systemId: 0 }, settings).reason, "WRECK_INPUT_INVALID");
    assert.strictEqual(buildStructureWreckField({ ...good, ownerFactionId: 0 }, settings).reason, "WRECK_INPUT_INVALID");
    assert.strictEqual(buildStructureWreckField({ ...good, winnerFactionId: 0 }, settings).reason, "WRECK_INPUT_INVALID");
    assert.strictEqual(buildStructureWreckField({ ...good, typeId: -1 }, settings).reason, "WRECK_INPUT_INVALID");
    assert.strictEqual(buildStructureWreckField({ ...good, family: "" }, settings).reason, "WRECK_INPUT_INVALID");
    assert.strictEqual(buildStructureWreckField({ ...good, lostUnits: -1 }, settings).reason, "WRECK_INPUT_INVALID");
    assert.strictEqual(buildStructureWreckField({ ...good, at: -1 }, settings).reason, "WRECK_INPUT_INVALID");
  });

  test("M2 placeFieldInTx: evicts oldest in system, then world, inserts field, enqueues expiry", () => {
    const fields = new Map();
    const repo = fakeWreckRepository(fields);
    const scheduler = fakeScheduler();
    const settings = defaultWreckSettings();
    const clock = clockAt(NOW_MS);
    const journal = createJournal({ clock, maxPayloadBytes: 4096, maxRows: 500 });
    const store = openStore({ filePath: ":memory:", openDatabase: () => require("better-sqlite3")(":memory:"),
      exclusiveLock: true, busyTimeoutMs: 5000, maxRowsPerTransaction: 500, maxWriteMsPerPass: 5,
      randomSeed: () => 1, migrations: MIGRATIONS });

    const old1 = { fieldId: "wf:old1", systemId: SYS_1, createdAt: NOW_MS - 100000, expiresAt: NOW_MS + 500000, status: WRECK_ACTIVE, version: 1 };
    const old2 = { fieldId: "wf:old2", systemId: SYS_2, createdAt: NOW_MS - 200000, expiresAt: NOW_MS + 500000, status: WRECK_ACTIVE, version: 1 };
    fields.set(old1.fieldId, old1);
    fields.set(old2.fieldId, old2);

    const newField = {
      fieldId: "wf:st:st-123:1",
      battleId: null,
      source: "structure",
      systemId: SYS_1,
      environment: "nullsec",
      outcome: "DESTROYED",
      winnerFactionId: FACTION_ATTACKER,
      shipsLost: 1,
      composition: [[FACTION_OWNER, "capital", 35832, 1]],
      salvageUnits: 100,
      lootUnits: 200,
      decayFloorPpm: 250000,
      createdAt: NOW_MS,
      expiresAt: NOW_MS + settings.fieldTtlMs,
    };

    const tx = { inTransaction: true };
    const deps = {
      repository: repo,
      scheduler,
      settings,
      onCount: () => {},
      settled: { systemId: SYS_1, at: NOW_MS },
      ck: "test:ck",
    };

    const result = placeFieldInTx(tx, newField, "test:ck:wreck", deps);
    assert.strictEqual(result.ok, true, JSON.stringify(result));
    assert.strictEqual(result.fieldId, "wf:st:st-123:1");

    assert.ok(fields.has("wf:st:st-123:1"), "new field inserted");
    assert.strictEqual(fields.get("wf:st:st-123:1").status, WRECK_ACTIVE);

    assert.strictEqual(scheduler.enqueued.length, 1);
    assert.strictEqual(scheduler.enqueued[0].type, EXPIRE_EVENT);
    assert.strictEqual(scheduler.enqueued[0].key, "wf:st:st-123:1");
    assert.ok(scheduler.enqueued[0].opts.chained === true, "chained enqueue");
  });

  test("M2 placeFieldInTx: idempotency key prevents duplicate field on retry", () => {
    const fields = new Map();
    const repo = fakeWreckRepository(fields);
    const scheduler = fakeScheduler();
    const settings = defaultWreckSettings();
    const newField = {
      fieldId: "wf:st:st-123:1",
      battleId: null,
      source: "structure",
      systemId: SYS_1,
      environment: "nullsec",
      outcome: "DESTROYED",
      winnerFactionId: FACTION_ATTACKER,
      shipsLost: 1,
      composition: [[FACTION_OWNER, "capital", 35832, 1]],
      salvageUnits: 100,
      lootUnits: 200,
      decayFloorPpm: 250000,
      createdAt: NOW_MS,
      expiresAt: NOW_MS + settings.fieldTtlMs,
    };
    const tx = { inTransaction: true };
    const deps = {
      repository: repo, scheduler, settings,
      onCount: () => {}, settled: { systemId: SYS_1, at: NOW_MS }, ck: "test:ck",
    };

    const r1 = placeFieldInTx(tx, newField, "test:ck:wreck", deps);
    assert.strictEqual(r1.ok, true);
    assert.strictEqual(r1.duplicate, false);

    const r2 = placeFieldInTx(tx, newField, "test:ck:wreck", deps);
    assert.strictEqual(r2.ok, false);
    assert.strictEqual(r2.reason, "NESTED_KEY_REUSED");
    assert.strictEqual(r2.stage, "insert");
  });

  test("M3 buildWreckField: battle wreck still builds correctly (regression)", () => {
    const settled = {
      battleId: "b123",
      systemId: SYS_1,
      environment: "nullsec",
      outcome: "A_WIN",
      winnerFactionId: FACTION_ATTACKER,
      at: NOW_MS,
      losses: [
        { factionId: FACTION_ATTACKER, hullGroup: "battleship", typeId: 0, count: 5 },
        { factionId: FACTION_OWNER, hullGroup: "battlecruiser", typeId: 0, count: 10 },
      ],
    };
    const settings = defaultWreckSettings();
    const result = buildWreckField(settled, settings);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.skip, null);
    const f = result.field;
    assert.strictEqual(f.fieldId, "wf:b123");
    assert.strictEqual(f.source, "battle");
    assert.strictEqual(f.battleId, "b123");
    assert.strictEqual(f.systemId, SYS_1);
    assert.strictEqual(f.winnerFactionId, FACTION_ATTACKER);
    assert.strictEqual(f.shipsLost, 15);
    assert.ok(f.composition.length >= 1);
    assert.ok(Number.isSafeInteger(f.salvageUnits));
    assert.ok(Number.isSafeInteger(f.lootUnits));
    assert.strictEqual(f.createdAt, NOW_MS);
    assert.strictEqual(f.expiresAt, NOW_MS + settings.fieldTtlMs);
  });

  test("M3 placeFieldInTx: battle wreck field uses same eviction/insert/expiry logic", () => {
    const fields = new Map();
    const repo = fakeWreckRepository(fields);
    const scheduler = fakeScheduler();
    const settings = defaultWreckSettings();
    const battleField = {
      fieldId: "wf:b456",
      battleId: "b456",
      source: "battle",
      systemId: SYS_1,
      environment: "nullsec",
      outcome: "A_WIN",
      winnerFactionId: FACTION_ATTACKER,
      shipsLost: 10,
      composition: [[FACTION_ATTACKER, "battleship", 0, 3], [FACTION_OWNER, "battlecruiser", 0, 7]],
      salvageUnits: 150,
      lootUnits: 300,
      decayFloorPpm: 250000,
      createdAt: NOW_MS,
      expiresAt: NOW_MS + settings.fieldTtlMs,
    };
    const tx = { inTransaction: true };
    const deps = {
      repository: repo, scheduler, settings,
      onCount: () => {}, settled: { systemId: SYS_1, at: NOW_MS }, ck: "settle:ck",
    };
    const result = placeFieldInTx(tx, battleField, "settle:ck:wreck", deps);
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.fieldId, "wf:b456");
    assert.ok(fields.has("wf:b456"));
    assert.strictEqual(fields.get("wf:b456").status, WRECK_ACTIVE);
    assert.strictEqual(scheduler.enqueued.length, 1);
    assert.strictEqual(scheduler.enqueued[0].type, EXPIRE_EVENT);
  });

  test("M3 createWreckConsequence: apply -> placeFieldInTx, skipped for BELOW_MIN_SHIPS", () => {
    const fields = new Map();
    const repo = fakeWreckRepository(fields);
    const scheduler = fakeScheduler();
    const settings = { ...defaultWreckSettings(), minShipsLost: 2 };
    const consequence = createWreckConsequence({ repository: repo, scheduler, settings, onCount: () => {} });

    const settled = {
      battleId: "b1", systemId: SYS_1, environment: "nullsec", outcome: "A_WIN",
      winnerFactionId: FACTION_ATTACKER, at: NOW_MS,
      losses: [{ factionId: FACTION_ATTACKER, hullGroup: "frigate", typeId: 0, count: 1 }],
    };
    const tx = { inTransaction: true };
    const r1 = consequence.apply(tx, settled, "ck1");
    assert.strictEqual(r1.ok, true);
    assert.strictEqual(r1.skipped, "BELOW_MIN_SHIPS");

    settled.losses = [{ factionId: FACTION_ATTACKER, hullGroup: "battleship", typeId: 0, count: 5 }];
    const r2 = consequence.apply(tx, settled, "ck2");
    assert.strictEqual(r2.ok, true);
    assert.ok(r2.fieldId.startsWith("wf:b1"));
    assert.ok(fields.has(r2.fieldId));
  });

  test("Config: one key wrecks.stockLootPermille; the old siege env is ignored with a warning", () => {
    const r = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_SIEGE_STOCK_LOOT_PERMILLE: "7" } });
    assert.strictEqual(r.config.wrecks.stockLootPermille, 100);
    assert.strictEqual(r.config.siege.stockLootPermille, undefined);
    assert.ok(r.warnings.some((w) => w.includes("EVEJS_LNE_SIEGE_STOCK_LOOT_PERMILLE is not a setting of this mod")),
      JSON.stringify(r.warnings));
  });

  test("Config: observer.galaxySieges* and siegesPanelMaxRows exist", () => {
    const cfg = resolveConfig({ modDir: MOD_DIR, env: {} }).config;
    const o = cfg.observer;
    assert.strictEqual(typeof o.galaxySiegesEnabled, "boolean");
    assert.ok(Number.isSafeInteger(o.galaxySiegesMaxSystems) && o.galaxySiegesMaxSystems >= 0);
    assert.ok(Number.isSafeInteger(o.galaxySiegesRefreshMs) && o.galaxySiegesRefreshMs >= 1000);
    assert.ok(Number.isSafeInteger(o.siegesPanelMaxRows) && o.siegesPanelMaxRows >= 1);
  });
};