"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { findServerSrcOnDisk, GAMESTORE_SEARCH_MAX_DEPTH } = require("../../lib/adapter/locator");
const { resolveSqliteDriver } = require("../../lib/adapter/sqliteDriver");
const { MIGRATIONS, LATEST_SCHEMA_VERSION } = require("../../lib/persistence/migrations");
const { openStore } = require("../../lib/persistence/store");
const { seedDbFile } = require("../_support/dbTemplate");
const { createJournal } = require("../../lib/persistence/journal");
const { createManualClock } = require("../../lib/util/clock");
const { SCORE_MIN, SCORE_MAX } = require("../../lib/world/schema");
const { createWorldStateRepository } = require("../../lib/world/worldStateRepository");
const { startWorld, createUnavailableWorld } = require("../../lib/world");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const START_MS = 1760000000000;
const LIMITS = Object.freeze({ maxFactionsPerSystem: 8, maxBatchReadIds: 400, maxListLimit: 500 });

function loadDriver() {
  const found = findServerSrcOnDisk(MOD_DIR, GAMESTORE_SEARCH_MAX_DEPTH, fs.existsSync);
  if (!found.ok) return { ok: false, detail: found.reason };
  return resolveSqliteDriver(found.srcDir);
}

function withStore(driver, fn, { fresh = false } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lne-w-"));
  const file = path.join(tmp, "world.sqlite");
  const open = [];
  const reopen = (migrations = MIGRATIONS) => {
    if (!fresh) seedDbFile(driver, file, { migrations, seed: 1 });
    const opened = openStore({ filePath: file, openDatabase: (f) => new driver.Database(f), exclusiveLock: true,
      busyTimeoutMs: 0, maxRowsPerTransaction: 500, maxWriteMsPerPass: 5, randomSeed: () => 1, migrations });
    assert.ok(opened.ok, JSON.stringify(opened));
    open.push(opened.store);
    return opened;
  };
  try {
    return fn(reopen);
  } finally {
    for (const s of open) s.close("test_cleanup");
    try {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch (_err) {
    }
  }
}

function makeRepo(clock = createManualClock(START_MS)) {
  const journal = createJournal({ clock, maxPayloadBytes: 4096, maxRows: 500 });
  return { journal, clock, repo: createWorldStateRepository({ journal, clock, limits: LIMITS }) };
}

const tx = (store, fn) => {
  const r = store.transaction("test", fn);
  assert.ok(r.ok, JSON.stringify(r));
  return r.value;
};

const counts = (store) => tx(store, (db) => ({
  journal: db.prepare("SELECT count(*) AS n FROM world_event_journal").get().n,
  state: db.prepare("SELECT count(*) AS n FROM world_system_state").get().n,
  influence: db.prepare("SELECT count(*) AS n FROM world_system_influence").get().n,
}));

const create = (systemId, extra = {}) => ({ systemId, expectedVersion: 0, reason: "SEED_CONTROL",
  state: { securityClass: "lowsec", ...(extra.state || {}) }, ...(extra.influence ? { influence: extra.influence } : {}) });

function countingTx(db, counter) {
  return new Proxy(db, {
    get(target, prop) {
      if (prop === "prepare") {
        return (sql) => {
          const stmt = target.prepare(sql);
          const wrap = (name) => (...args) => { counter.n += 1; return stmt[name](...args); };
          return { all: wrap("all"), get: wrap("get"), run: wrap("run"), iterate: wrap("iterate") };
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function makeCachedRepo(store, journal, clock, maxSystems = 100) {
  const counts = {};
  const onCount = (name, n) => { counts[name] = (counts[name] || 0) + n; };
  const repo = createWorldStateRepository({ journal, clock, limits: LIMITS, onCount,
    readCache: { maxSystems, txSeq: () => store.getTxSeq() } });
  return { repo, counts };
}

function seedThree(store, repo) {
  const seeds = [
    create(30000101),
    create(30000102, { state: { controllerFactionId: 500001, threatLevel: 12.5 },
      influence: [{ factionId: 500001, influenceScore: 37.5 }, { factionId: 500003, influenceScore: 50 }] }),
    create(30000103, { state: { securityClass: "nullsec", controllerFactionId: 500002 },
      influence: [{ factionId: 500002 }] }),
  ];
  for (const seed of seeds) {
    const r = tx(store, (db) => repo.applyChange(db, seed, `world:seed:v1:${seed.systemId}`));
    assert.strictEqual(r.ok, true, JSON.stringify(r));
  }
}
const RC_IDS = [30000103, 30000999, 30000101, 30000102, 30000101];
const rcRead = (store, repo, ids = RC_IDS) => tx(store, (db) => ({
  full: repo.getSystems(db, ids), plain: repo.getSystems(db, ids, { includeInfluence: false }),
  one: repo.getSystem(db, 30000102), onePlain: repo.getSystem(db, 30000102, { includeInfluence: false }),
  none: repo.getSystem(db, 30000999), nonePlain: repo.getSystem(db, 30000999, { includeInfluence: false }),
}));

module.exports = ({ test, skip }) => {
  const driver = loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  needsDriver("W1 world migration 3: fresh and from 2, STRICT tables, indexes, DDL ranges", () => {
    withStore(driver, (reopen) => {
      const old = reopen(MIGRATIONS.slice(0, 2));
      assert.strictEqual(old.schemaVersion, 2);
      old.store.close("upgrade");
      const upgraded = reopen();
      assert.deepStrictEqual([upgraded.schemaVersion, upgraded.applied],
        [LATEST_SCHEMA_VERSION, LATEST_SCHEMA_VERSION - 2]);
      const store = upgraded.store;
      tx(store, (db) => {
        const strict = db.prepare("SELECT name, strict FROM pragma_table_list WHERE name LIKE 'world_system_%'"
          + " AND name <> 'world_system_dev' ORDER BY name").all();
        assert.deepStrictEqual(strict.map((r) => [r.name, r.strict]),
          [["world_system_influence", 1], ["world_system_state", 1]]);
        const firstColumns = db.prepare("SELECT name, origin FROM pragma_index_list('world_system_influence')").all()
          .map((ix) => [ix.origin, db.prepare("SELECT name FROM pragma_index_info(?) WHERE seqno = 0").get(ix.name).name]);
        assert.ok(firstColumns.some(([origin, col]) => origin === "pk" && col === "system_id"), JSON.stringify(firstColumns));
        assert.ok(firstColumns.some(([, col]) => col === "faction_id"), JSON.stringify(firstColumns));
        const ddl = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'world_system_influence'").get().sql;
        assert.ok(ddl.includes(`BETWEEN ${SCORE_MIN} AND ${SCORE_MAX}`), ddl);
      });
    }, { fresh: true });
    withStore(driver, (reopen) => {
      const fresh = reopen();
      assert.deepStrictEqual([fresh.schemaVersion, fresh.applied], [LATEST_SCHEMA_VERSION, LATEST_SCHEMA_VERSION]);
    }, { fresh: true });
  });

  needsDriver("W2 world validation: ranges, negative supply, unknown enums -> refusal, nothing written", () => {
    withStore(driver, (reopen) => {
      const store = reopen().store;
      const { repo } = makeRepo();
      const ok = tx(store, (db) => repo.applyChange(db, create(30000001, { influence: [{ factionId: 500001 }] }), "w:a"));
      assert.strictEqual(ok.ok, true, JSON.stringify(ok));
      const before = counts(store);
      const update = (influence) => ({ systemId: 30000001, expectedVersion: 1, reason: "TEST", influence });
      const cases = [
        [update([{ factionId: 500001, influenceScore: 101 }]),
          { ok: false, reason: "INFLUENCE_OUT_OF_RANGE", factionId: 500001, value: 101 }],
        [update([{ factionId: 500001, influenceScore: -1 }]),
          { ok: false, reason: "INFLUENCE_OUT_OF_RANGE", factionId: 500001, value: -1 }],
        [update([{ factionId: 500001, localSupply: -1 }]),
          { ok: false, reason: "NEGATIVE_AMOUNT", field: "localSupply", factionId: 500001, value: -1 }],
        [{ systemId: 30000001, expectedVersion: 1, reason: "TEST", state: { occupationState: "PEACE" } },
          { ok: false, reason: "UNKNOWN_OCCUPATION_STATE", value: "PEACE" }],
        [create(30000002, { state: { securityClass: "deepspace" } }),
          { ok: false, reason: "UNKNOWN_SECURITY_CLASS", value: "deepspace" }],
      ];
      for (const [change, expected] of cases) {
        assert.deepStrictEqual(tx(store, (db) => repo.applyChange(db, change, "w:bad")), expected);
        assert.deepStrictEqual(counts(store), before);
      }
    });
  });

  needsDriver("W3 world idempotency + version: duplicate, VERSION_CONFLICT, IDEMPOTENCY_CONFLICT, SYSTEM_EXISTS", () => {
    withStore(driver, (reopen) => {
      const store = reopen().store;
      const { repo } = makeRepo();
      const created = tx(store, (db) => repo.applyChange(db, create(30000010), "world:seed:v1:30000010"));
      assert.deepStrictEqual([created.ok, created.version, created.created], [true, 1, true]);
      const change = (expectedVersion, occupationState = "CONTESTED") => ({ systemId: 30000010, expectedVersion,
        reason: "TEST_UPDATE", state: { occupationState, controllerFactionId: 500002 },
        influence: [{ factionId: 500002, influenceScore: 40 }] });
      const first = tx(store, (db) => repo.applyChange(db, change(1), "K"));
      assert.deepStrictEqual([first.ok, first.duplicate, first.version], [true, false, 2]);
      const again = tx(store, (db) => repo.applyChange(db, change(2), "K"));
      assert.deepStrictEqual(again, { ok: true, duplicate: true, journalId: first.journalId });
      const system = tx(store, (db) => repo.getSystem(db, 30000010)).system;
      assert.strictEqual(system.version, 2);
      const keyRows = tx(store, (db) => db.prepare("SELECT count(*) AS n FROM world_event_journal"
        + " WHERE idempotency_key = 'K'").get().n);
      assert.strictEqual(keyRows, 1);
      const stale = tx(store, (db) => repo.applyChange(db, change(1, "INVASION"), "K2"));
      assert.deepStrictEqual(stale, { ok: false, reason: "VERSION_CONFLICT", expectedVersion: 1, actualVersion: 2 });
      assert.deepStrictEqual(tx(store, (db) => repo.isApplied(db, "K2")), { ok: true, applied: false });
      assert.deepStrictEqual(tx(store, (db) => repo.isApplied(db, "K")), { ok: true, applied: true });
      const conflict = tx(store, (db) => repo.applyChange(db, change(2, "OCCUPIED"), "K"));
      assert.deepStrictEqual(conflict, { ok: false, reason: "IDEMPOTENCY_CONFLICT", journalId: first.journalId });
      assert.deepStrictEqual(tx(store, (db) => repo.applyChange(db, create(30000010), "world:seed:other")),
        { ok: false, reason: "SYSTEM_EXISTS" });
      const before = counts(store);
      const crowd = Array.from({ length: LIMITS.maxFactionsPerSystem }, (_, i) => ({ factionId: 500100 + i }));
      const tooMany = tx(store, (db) => repo.applyChange(db, { systemId: 30000010, expectedVersion: 2, reason: "TEST",
        state: { occupationState: "INVASION" }, influence: crowd }, "K3"));
      assert.deepStrictEqual(tooMany, { ok: false, reason: "TOO_MANY_FACTIONS", count: LIMITS.maxFactionsPerSystem + 1,
        limit: LIMITS.maxFactionsPerSystem });
      const after = tx(store, (db) => repo.getSystem(db, 30000010)).system;
      assert.deepStrictEqual([after.version, after.occupationState], [2, "CONTESTED"]);
      assert.deepStrictEqual(counts(store), before);
    });
  });

  needsDriver("W4 world restart: write -> close -> new store + new repository -> identical state", () => {
    withStore(driver, (reopen) => {
      let store = reopen().store;
      const clock = createManualClock(START_MS);
      let { repo } = makeRepo(clock);
      const seeds = [
        create(30000101),
        create(30000102, { state: { controllerFactionId: 500001, threatLevel: 12.5 },
          influence: [{ factionId: 500001, influenceScore: 37.5, garrisonStrength: 10, localSupply: 5,
            supplyCapacity: 20 }, { factionId: 500003, influenceScore: 50 }] }),
        create(30000103, { state: { securityClass: "nullsec" }, influence: [{ factionId: 500002 }] }),
      ];
      for (const seed of seeds) {
        const r = tx(store, (db) => repo.applyChange(db, seed, `world:seed:v1:${seed.systemId}`));
        assert.strictEqual(r.ok, true, JSON.stringify(r));
      }
      clock.advance(1000);
      const upd = tx(store, (db) => repo.applyChange(db, { systemId: 30000102, expectedVersion: 1, reason: "TEST",
        state: { threatLevel: 20 }, influence: [{ factionId: 500003, influenceScore: 60 }] }, "world:test:1"));
      assert.strictEqual(upd.version, 2, JSON.stringify(upd));
      const ids = [30000101, 30000102, 30000103];
      const read = (s, r) => tx(s, (db) => ({ list: r.listSystems(db, { limit: 10 }), batch: r.getSystems(db, ids) }));
      const before = read(store, repo);
      const sys = before.batch.systems[1];
      assert.strictEqual(sys.threatLevel, 20);
      assert.strictEqual(sys.influence[1].influenceScore, 60);
      assert.strictEqual(sys.influence[0].influenceScore, 37.5);
      assert.strictEqual(sys.influence[1].version, 2);
      assert.strictEqual(sys.lastStateChangeAt, START_MS);
      assert.strictEqual(sys.updatedAt, START_MS + 1000);
      store.close("restart");
      store = reopen().store;
      repo = makeRepo(createManualClock(START_MS + 5000)).repo;
      assert.deepStrictEqual(read(store, repo), before);
      const replay = tx(store, (db) => repo.applyChange(db, seeds[0], "world:seed:v1:30000101"));
      assert.deepStrictEqual([replay.ok, replay.duplicate], [true, true]);
    });
  });

  needsDriver("W5 world batch read: getSystems = 2 queries for 300 ids, 1 without influence, BATCH_TOO_LARGE = 0", () => {
    withStore(driver, (reopen) => {
      const store = reopen().store;
      const { repo } = makeRepo();
      for (let i = 0; i < 5; i += 1) {
        const id = 30000200 + i * 2;
        tx(store, (db) => repo.applyChange(db, create(id, { influence: [{ factionId: 500001 }] }), `world:seed:${id}`));
      }
      const ids = Array.from({ length: 300 }, (_, i) => 30000499 - i);
      tx(store, (db) => {
        const counter = { n: 0 };
        const counted = countingTx(db, counter);
        const r = repo.getSystems(counted, ids);
        assert.strictEqual(counter.n, 2);
        assert.deepStrictEqual(r.systems.map((s) => s.systemId), [30000200, 30000202, 30000204, 30000206, 30000208]);
        assert.strictEqual(r.missing.length, 295);
        assert.deepStrictEqual(r.missing, [...r.missing].sort((a, b) => a - b));
        assert.ok(!r.missing.includes(30000204) && r.missing.includes(30000201));
        counter.n = 0;
        repo.getSystems(counted, ids, { includeInfluence: false });
        assert.strictEqual(counter.n, 1);
        counter.n = 0;
        const tooMany = Array.from({ length: LIMITS.maxBatchReadIds + 1 }, (_, i) => i + 1);
        assert.deepStrictEqual(repo.getSystems(counted, tooMany),
          { ok: false, reason: "BATCH_TOO_LARGE", count: LIMITS.maxBatchReadIds + 1, limit: LIMITS.maxBatchReadIds });
        assert.strictEqual(counter.n, 0);
      });
    });
  });

  needsDriver("P5 world.getController: controller/null, 1 query, TX_ACTIVE keeps the outer tx", () => {
    withStore(driver, (reopen) => {
      const store = reopen().store;
      const clock = createManualClock(START_MS);
      const journal = createJournal({ clock, maxPayloadBytes: 4096, maxRows: 500 });
      const counter = { n: 0 };
      const counting = { ...store, isInTransaction: () => store.isInTransaction(),
        transaction: (name, fn) => store.transaction(name, (db) => fn(countingTx(db, counter))) };
      const config = { enabled: true, modules: { world: { enabled: true } }, world: { seedEnabled: false, ...LIMITS } };
      const started = startWorld({ config, persistence: { ok: true, store: counting, journal }, clock,
        logger: { log() {} } });
      assert.strictEqual(started.ok, true, JSON.stringify(started));
      const world = started.world;
      assert.strictEqual(world.applyChange(create(30000301, { state: { controllerFactionId: 500019 },
        influence: [{ factionId: 500019 }] }), "world:test:301").ok, true);

      counter.n = 0;
      assert.deepStrictEqual(world.getController(30000301), { ok: true, controllerFactionId: 500019 });
      assert.strictEqual(counter.n, 1, "one query, no influence rows");
      assert.deepStrictEqual(world.getController(30000999), { ok: true, controllerFactionId: null }, "no row");
      assert.strictEqual(world.getController(0).ok, false, "invalid id refused");

      let inner = null;
      const outer = store.transaction("test.outer", (db) => {
        db.prepare("UPDATE world_system_state SET threat_level = 7 WHERE system_id = 30000301").run();
        inner = world.getController(30000301);
        return true;
      });
      assert.strictEqual(outer.ok, true, JSON.stringify(outer));
      assert.deepStrictEqual(inner, { ok: false, reason: "TX_ACTIVE" });
      assert.strictEqual(world.getSystem(30000301, { includeInfluence: false }).system.threatLevel, 7,
        "the outer write committed");
      world.stop("test");
      assert.strictEqual(createUnavailableWorld("WORLD_UNAVAILABLE").getController(1).ok, false);
    });
  });

  needsDriver("P5a world.getControlState: row with influence, no row, TX_ACTIVE, stub", () => {
    withStore(driver, (reopen) => {
      const store = reopen().store;
      const clock = createManualClock(START_MS);
      const journal = createJournal({ clock, maxPayloadBytes: 4096, maxRows: 500 });
      const config = { enabled: true, modules: { world: { enabled: true } }, world: { seedEnabled: false, ...LIMITS } };
      const started = startWorld({ config, persistence: { ok: true, store, journal }, clock, logger: { log() {} } });
      assert.strictEqual(started.ok, true, JSON.stringify(started));
      const world = started.world;
      assert.strictEqual(world.applyChange(create(30000301, { state: { controllerFactionId: 500019 },
        influence: [{ factionId: 500019, influenceScore: 40 }] }), "world:test:301").ok, true);
      const read = world.getControlState(30000301);
      assert.strictEqual(read.ok, true, JSON.stringify(read));
      assert.strictEqual(read.system.controllerFactionId, 500019);
      assert.strictEqual(read.system.occupationState, "STABLE");
      assert.deepStrictEqual(read.system.influence.map((i) => [i.factionId, i.influenceScore]), [[500019, 40]]);
      assert.deepStrictEqual(world.getControlState(30000999), { ok: true, system: null }, "no row");
      assert.strictEqual(world.getControlState(0).ok, false, "invalid id refused");
      let inner = null;
      store.transaction("test.outer", () => {
        inner = world.getControlState(30000301);
        return true;
      });
      assert.deepStrictEqual(inner, { ok: false, reason: "TX_ACTIVE" });
      world.stop("test");
      assert.strictEqual(createUnavailableWorld("WORLD_UNAVAILABLE").getControlState(1).ok, false);
    });
  });

  needsDriver("P5b world.getControllerMemo: N reads of one wake-up = 1 transaction "
    + "per system; a controller write of X drops X only; bound clears; memo 0 and TX_ACTIVE = getController", () => {
    withStore(driver, (reopen) => {
      const store = reopen().store;
      const clock = createManualClock(START_MS);
      const journal = createJournal({ clock, maxPayloadBytes: 4096, maxRows: 500 });
      const txs = { n: 0 };
      const counting = { ...store, isInTransaction: () => store.isInTransaction(), isOpen: () => store.isOpen(),
        transaction: (name, fn) => { if (name === "world.getController") txs.n += 1; return store.transaction(name, fn); } };
      const counts = {};
      const startWith = (memoMax) => {
        const config = { enabled: true, modules: { world: { enabled: true } },
          world: { seedEnabled: false, controllerMemoMaxSystems: memoMax, ...LIMITS } };
        const started = startWorld({ config, persistence: { ok: true, store: counting, journal }, clock,
          logger: { log() {} }, telemetry: { hooks: { onCount: (n, k) => { counts[n] = (counts[n] || 0) + k; } } } });
        assert.strictEqual(started.ok, true, JSON.stringify(started));
        return started.world;
      };
      const world = startWith(2);
      const A = 30000401;
      const B = 30000402;
      assert.strictEqual(world.applyChange(create(A, { state: { controllerFactionId: 500019 } }), "world:test:a").ok, true);
      assert.strictEqual(world.applyChange(create(B, { state: { controllerFactionId: 500010 } }), "world:test:b").ok, true);

      txs.n = 0;
      for (let i = 0; i < 10; i += 1) {
        assert.deepStrictEqual(world.getControllerMemo(A), { ok: true, controllerFactionId: 500019 });
        assert.deepStrictEqual(world.getControllerMemo(B), { ok: true, controllerFactionId: 500010 });
      }
      assert.strictEqual(txs.n, 2, "N calls = 1 read per system");
      assert.deepStrictEqual([counts["world.controllerMemo.misses"], counts["world.controllerMemo.hits"]], [2, 18]);

      assert.strictEqual(world.applyChange({ systemId: A, expectedVersion: 1, reason: "TEST",
        state: { controllerFactionId: 500010 } }, "world:test:a2").ok, true);
      txs.n = 0;
      assert.deepStrictEqual(world.getControllerMemo(A), { ok: true, controllerFactionId: 500010 });
      assert.deepStrictEqual(world.getControllerMemo(B), { ok: true, controllerFactionId: 500010 });
      assert.strictEqual(txs.n, 1, "only the written system is read again");
      const SENTINEL = new Error("rollback");
      const rolled = store.transaction("test.rollback", (db) => {
        const r = world.repository.applyChange(db, { systemId: B, expectedVersion: 1, reason: "TEST",
          state: { controllerFactionId: 500019 } }, "world:test:b-rolled");
        assert.strictEqual(r.ok, true, JSON.stringify(r));
        throw SENTINEL;
      });
      assert.strictEqual(rolled.ok, false);
      txs.n = 0;
      assert.deepStrictEqual(world.getControllerMemo(B), { ok: true, controllerFactionId: 500010 });
      assert.strictEqual(txs.n, 1);

      const before = counts["world.controllerMemo.resets"] || 0;
      assert.deepStrictEqual(world.getControllerMemo(30000999), { ok: true, controllerFactionId: null }, "no row");
      assert.strictEqual(counts["world.controllerMemo.resets"], before + 1);
      let inner = null;
      store.transaction("test.outer", () => { inner = world.getControllerMemo(30000999); return true; });
      assert.deepStrictEqual(inner, { ok: false, reason: "TX_ACTIVE" });
      assert.strictEqual(world.getControllerMemo(0).ok, false);
      txs.n = 0;
      world.getControllerMemo(0);
      world.getControllerMemo(String(A));
      world.getControllerMemo(String(A));
      assert.strictEqual(txs.n, 3);
      world.stop("test");

      const off = startWith(0);
      txs.n = 0;
      off.getControllerMemo(A);
      off.getControllerMemo(A);
      assert.strictEqual(txs.n, 2);
      off.stop("test");
      assert.strictEqual(createUnavailableWorld("WORLD_UNAVAILABLE").getControllerMemo(1).ok, false);
    });
  });

  needsDriver("W6 world migration 29: home_faction_id column, backfill, partial index, repo methods", () => {
    withStore(driver, (reopen) => {
      const migrations28 = MIGRATIONS.slice(0, 28);
      const old = reopen(migrations28);
      assert.strictEqual(old.schemaVersion, 28);
      const clock = createManualClock(START_MS);

      tx(old.store, (db) => {
        const now = clock.now();
        db.prepare("INSERT INTO world_system_state (system_id, security_class, controller_faction_id, occupation_state, threat_level, last_state_change_at, next_strategy_review_at, updated_at, version, occupier_faction_id, previous_controller_faction_id, phase_seq, phase_due_at, influence_evaluated_at, captured_at, detached_since_at) VALUES (?, 'lowsec', 100, 'STABLE', 0, ?, ?, ?, 1, 100, NULL, 0, NULL, ?, NULL, NULL)").run(40000001, now, now, now, now);
        db.prepare("INSERT INTO world_system_influence (system_id, faction_id, influence_score, garrison_strength, local_supply, supply_capacity, last_updated_at, version) VALUES (?, 100, 50, 0, 0, 0, ?, 1)").run(40000001, now);

        clock.advance(1000);
        const now2 = clock.now();
        db.prepare("INSERT INTO world_system_state (system_id, security_class, controller_faction_id, occupation_state, threat_level, last_state_change_at, next_strategy_review_at, updated_at, version, occupier_faction_id, previous_controller_faction_id, phase_seq, phase_due_at, influence_evaluated_at, captured_at, detached_since_at) VALUES (?, 'nullsec', 300, 'OCCUPIED', 0, ?, ?, ?, 1, 300, 200, 0, ?, ?, ?, NULL)").run(40000002, now2, now2, now2, now2, now2, now2);
        db.prepare("INSERT INTO world_system_influence (system_id, faction_id, influence_score, garrison_strength, local_supply, supply_capacity, last_updated_at, version) VALUES (?, 300, 60, 0, 0, 0, ?, 1)").run(40000002, now2);
        db.prepare("INSERT INTO world_system_influence (system_id, faction_id, influence_score, garrison_strength, local_supply, supply_capacity, last_updated_at, version) VALUES (?, 200, 40, 0, 0, 0, ?, 1)").run(40000002, now2);

        clock.advance(1000);
        const now3 = clock.now();
        db.prepare("INSERT INTO world_system_state (system_id, security_class, controller_faction_id, occupation_state, threat_level, last_state_change_at, next_strategy_review_at, updated_at, version, occupier_faction_id, previous_controller_faction_id, phase_seq, phase_due_at, influence_evaluated_at, captured_at, detached_since_at) VALUES (?, 'highsec', NULL, 'STABLE', 0, ?, ?, ?, 1, NULL, NULL, 0, NULL, ?, NULL, NULL)").run(40000003, now3, now3, now3, now3);
      });

      old.store.close("upgrade");

      const upgraded = reopen();
      assert.strictEqual(upgraded.schemaVersion, LATEST_SCHEMA_VERSION);
      assert.strictEqual(upgraded.applied, LATEST_SCHEMA_VERSION - 28);
      const store = upgraded.store;
      const { repo: repo2 } = makeRepo(createManualClock(clock.now()));

      const cols = tx(store, (db) => db.prepare("PRAGMA table_info(world_system_state)").all()
        .map((r) => r.name));
      assert.ok(cols.includes("home_faction_id"), "home_faction_id column missing: " + cols.join(","));

      const idx = tx(store, (db) => db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='world_system_state_lost_home'").get());
      assert.ok(idx, "partial index world_system_state_lost_home missing");

      const sys1 = tx(store, (db) => repo2.getSystem(db, 40000001)).system;
      const sys2 = tx(store, (db) => repo2.getSystem(db, 40000002)).system;
      const sys3 = tx(store, (db) => repo2.getSystem(db, 40000003)).system;
      assert.strictEqual(sys1.homeFactionId, 100, "heartland: home should equal controller");
      assert.strictEqual(sys2.homeFactionId, 200, "captured: home should equal previous_controller");
      assert.strictEqual(sys3.homeFactionId, null, "free: home should be null");

      const created = tx(store, (db) => repo2.applyChange(db, {
        systemId: 40000004, expectedVersion: 0, reason: "SEED_CONTROL",
        state: { securityClass: "lowsec", controllerFactionId: 400, occupationState: "STABLE" },
        influence: [{ factionId: 400, influenceScore: 50 }]
      }, "w:seed:40000004"));
      assert.strictEqual(created.ok, true);
      const sys4 = tx(store, (db) => repo2.getSystem(db, 40000004)).system;
      assert.strictEqual(sys4.homeFactionId, 400, "new row: home should equal controller");

      clock.advance(1000);
      const upd = tx(store, (db) => repo2.applyChange(db, {
        systemId: 40000001, expectedVersion: sys1.version, reason: "TEST",
        state: { controllerFactionId: 999 }
      }, "w:test:chgctrl"));
      assert.strictEqual(upd.ok, true);
      const sys1b = tx(store, (db) => repo2.getSystem(db, 40000001)).system;
      assert.strictEqual(sys1b.controllerFactionId, 999, "controller changed");
      assert.strictEqual(sys1b.homeFactionId, 100, "home unchanged after controller change");

      clock.advance(1000);
      const created5 = tx(store, (db) => repo2.applyChange(db, {
        systemId: 40000005, expectedVersion: 0, reason: "SEED_CONTROL",
        state: { securityClass: "lowsec", controllerFactionId: 999 },
        influence: [{ factionId: 999, influenceScore: 40 }]
      }, "w:seed:40000005"));
      assert.strictEqual(created5.ok, true);
      const updated5 = tx(store, (db) => repo2.applyChange(db, {
        systemId: 40000005, expectedVersion: created5.version, reason: "TEST",
        state: { occupationState: "CONTESTED", occupierFactionId: 888 },
        influence: [{ factionId: 888, influenceScore: 60 }]
      }, "w:test:upd5"));
      assert.strictEqual(updated5.ok, true);
      const threatened = tx(store, (db) => repo2.listThreatened(db, 999, { limit: 10 }));
      assert.strictEqual(threatened.ok, true);
      assert.ok(threatened.systems.some((s) => s.systemId === 40000005), "listThreatened finds CONTESTED");
      const badThreat = tx(store, (db) => repo2.listThreatened(db, 0, { limit: 10 }));
      assert.deepStrictEqual(badThreat, { ok: false, reason: "WORLD_INVALID_INPUT", detail: "factionId" });

      const lost = tx(store, (db) => repo2.listLostHome(db, 100, { limit: 10 }));
      assert.strictEqual(lost.ok, true);
      assert.ok(lost.systems.some((s) => s.systemId === 40000001), "listLostHome finds lost home");
      const lostWithInf = tx(store, (db) => repo2.listLostHome(db, 100, { limit: 10, includeInfluence: true }));
      assert.strictEqual(lostWithInf.ok, true);
      assert.ok(lostWithInf.systems[0].influence, "includeInfluence adds influence");
      const badLost = tx(store, (db) => repo2.listLostHome(db, -1, { limit: 10 }));
      assert.deepStrictEqual(badLost, { ok: false, reason: "WORLD_INVALID_INPUT", detail: "factionId" });

      const clear1 = tx(store, (db) => repo2.clearHomeInTx(db, 40000001, 100));
      assert.deepStrictEqual(clear1, { ok: true, changed: true });
      const sys1c = tx(store, (db) => repo2.getSystem(db, 40000001)).system;
      assert.strictEqual(sys1c.homeFactionId, null, "home cleared");
      const clear2 = tx(store, (db) => repo2.clearHomeInTx(db, 40000001, 100));
      assert.deepStrictEqual(clear2, { ok: true, changed: false }, "second call idempotent");
      const badClear = tx(store, (db) => repo2.clearHomeInTx(db, 40000001, 0));
      assert.deepStrictEqual(badClear, { ok: false, reason: "WORLD_INVALID_INPUT", detail: "systemId or factionId" });
      const badClear2 = tx(store, (db) => repo2.clearHomeInTx(db, 0, 100));
      assert.deepStrictEqual(badClear2, { ok: false, reason: "WORLD_INVALID_INPUT", detail: "systemId or factionId" });
    }, { fresh: true });
  });

  needsDriver("W6 listLostHome pagination: 5 lost homes, limit 3, cursor advances correctly "
    + "system with home = controller never returned", () => withStore(driver, async (reopen) => {
    const opened = reopen();
    const clock = createManualClock(START_MS);
    const journal = createJournal({ clock, maxPayloadBytes: 4096, maxRows: 500 });
    const repo = createWorldStateRepository({ journal, clock, limits: LIMITS });
    const F = 100;
    const OTHER = 200;
    const sys = [40000001, 40000002, 40000003, 40000004, 40000005];
    for (const id of sys) {
      const r = tx(opened.store, (db) => repo.applyChange(db, {
        systemId: id, expectedVersion: 0, reason: "SEED_CONTROL",
        state: { securityClass: "lowsec", controllerFactionId: OTHER },
        influence: [{ factionId: F, influenceScore: 50 }, { factionId: OTHER, influenceScore: 60 }]
      }, `w6:seed:${id}`));
      assert.strictEqual(r.ok, true);
      tx(opened.store, (db) => db.prepare("UPDATE world_system_state SET home_faction_id = ? WHERE system_id = ?").run(F, id));
    }
    const rHome = tx(opened.store, (db) => repo.applyChange(db, {
      systemId: 40000006, expectedVersion: 0, reason: "SEED_CONTROL",
      state: { securityClass: "lowsec", controllerFactionId: F },
      influence: [{ factionId: F, influenceScore: 80 }]
    }, "w6:seed:home"));
    assert.strictEqual(rHome.ok, true);

    const p1 = tx(opened.store, (db) => repo.listLostHome(db, F, { limit: 3, afterSystemId: 0 }));
    assert.strictEqual(p1.ok, true);
    assert.deepStrictEqual(p1.systems.map((s) => s.systemId), [40000001, 40000002, 40000003]);
    assert.strictEqual(p1.nextAfterSystemId, 40000003);

    const p2 = tx(opened.store, (db) => repo.listLostHome(db, F, { limit: 3, afterSystemId: 40000003 }));
    assert.strictEqual(p2.ok, true);
    assert.deepStrictEqual(p2.systems.map((s) => s.systemId), [40000004, 40000005]);
    assert.strictEqual(p2.nextAfterSystemId, null);

    const p3 = tx(opened.store, (db) => repo.listLostHome(db, F, { limit: 3, afterSystemId: 40000005 }));
    assert.strictEqual(p3.ok, true);
    assert.deepStrictEqual(p3.systems, []);
    assert.strictEqual(p3.nextAfterSystemId, null);

    const all = tx(opened.store, (db) => repo.listLostHome(db, F, { limit: 10, afterSystemId: 0 }));
    assert.ok(!all.systems.some((s) => s.systemId === 40000006), "home=controller system not in lostHome");

    const bad = tx(opened.store, (db) => repo.listLostHome(db, 0, { limit: 3 }));
    assert.deepStrictEqual(bad, { ok: false, reason: "WORLD_INVALID_INPUT", detail: "factionId" });
  }, { fresh: true }));
  needsDriver("RC1 read cache: getSystems/getSystem equal to the uncached repository (with and without "
    + "influence, order, missing = negative entries), hits on the second read; off / bound 1 -> equal, 0 hits", () => {
    withStore(driver, (reopen) => {
      const store = reopen().store;
      const { repo, journal, clock } = makeRepo();
      seedThree(store, repo);
      const expected = rcRead(store, repo);
      assert.deepStrictEqual(expected.full.missing, [30000999]);
      const cached = makeCachedRepo(store, journal, clock);
      assert.deepStrictEqual(rcRead(store, cached.repo), expected, "first read (misses)");
      assert.deepStrictEqual(rcRead(store, cached.repo), expected, "second read (hits)");
      assert.ok(cached.counts["world.readCache.hits"] >= 3 + 3 + 4, JSON.stringify(cached.counts));
      assert.ok(cached.counts["world.readCache.misses"] > 0, JSON.stringify(cached.counts));
      const off = makeCachedRepo(store, journal, clock, 0);
      const tiny = makeCachedRepo(store, journal, clock, 1);
      for (let i = 0; i < 2; i += 1) {
        assert.deepStrictEqual(rcRead(store, off.repo), expected, "cache off");
        assert.deepStrictEqual(rcRead(store, tiny.repo), expected, "bound 1");
      }
      assert.deepStrictEqual(off.counts, {});
      assert.ok(tiny.counts["world.readCache.resets"] > 0, JSON.stringify(tiny.counts));
    });
  });

  needsDriver("RC2 read cache invalidation: applyChange (state + influence), clearHomeInTx and a new system "
    + "-> the next transaction reads the new values", () => {
    withStore(driver, (reopen) => {
      const store = reopen().store;
      const { repo, journal, clock } = makeRepo();
      seedThree(store, repo);
      const cached = makeCachedRepo(store, journal, clock);
      rcRead(store, cached.repo);
      rcRead(store, cached.repo, [30000103]);
      clock.advance(1000);
      const upd = tx(store, (db) => cached.repo.applyChange(db, { systemId: 30000102, expectedVersion: 1,
        reason: "TEST", state: { threatLevel: 20 }, influence: [{ factionId: 500003, influenceScore: 60 }] }, "rc2:1"));
      assert.strictEqual(upd.ok, true, JSON.stringify(upd));
      assert.deepStrictEqual(tx(store, (db) => cached.repo.clearHomeInTx(db, 30000103, 500002)),
        { ok: true, changed: true });
      const created = tx(store, (db) => cached.repo.applyChange(db, create(30000999), "rc2:new"));
      assert.strictEqual(created.ok, true, JSON.stringify(created));
      const after = rcRead(store, cached.repo);
      assert.deepStrictEqual(after, rcRead(store, repo), "equal to the uncached read");
      assert.strictEqual(after.one.system.threatLevel, 20);
      assert.strictEqual(after.one.system.influence[1].influenceScore, 60);
      assert.strictEqual(after.full.systems.find((x) => x.systemId === 30000103).homeFactionId, null);
      assert.deepStrictEqual(after.full.missing, []);
      assert.strictEqual(after.none.system.systemId, 30000999);
      assert.ok(cached.counts["world.readCache.invalidations"] >= 4, JSON.stringify(cached.counts));
    });
  });

  needsDriver("RC3 read cache rollback: read X, write X, read X (new value) then the tx throws -> the next tx "
    + "reads the committed X; the same with a savepoint rolled back by an applyOnce refusal", () => {
    withStore(driver, (reopen) => {
      const store = reopen().store;
      const { repo, journal, clock } = makeRepo();
      seedThree(store, repo);
      const committed = rcRead(store, repo);
      const cached = makeCachedRepo(store, journal, clock);
      const change = { systemId: 30000102, expectedVersion: 1, reason: "TEST", state: { threatLevel: 77 },
        influence: [{ factionId: 500001, influenceScore: 1 }] };
      const SENTINEL = new Error("rollback");
      const thrown = store.transaction("rc3", (db) => {
        assert.strictEqual(cached.repo.getSystem(db, 30000102).system.threatLevel, 12.5);
        assert.strictEqual(cached.repo.applyChange(db, change, "rc3:tx").ok, true);
        assert.strictEqual(cached.repo.getSystem(db, 30000102).system.threatLevel, 77);
        assert.strictEqual(cached.repo.getSystems(db, [30000102], { includeInfluence: false }).systems[0]
          .threatLevel, 77);
        throw SENTINEL;
      });
      assert.strictEqual(thrown.error, SENTINEL);
      assert.deepStrictEqual(rcRead(store, cached.repo), committed, "after the rollback of the tx");
      const inner = tx(store, (db) => {
        assert.strictEqual(cached.repo.getSystem(db, 30000102).system.threatLevel, 12.5);
        const r = journal.applyOnce(db, { key: "rc3:sp", aggregate: { type: "test", id: 1 }, eventType: "TEST",
          payload: {} }, (sp) => {
          assert.strictEqual(cached.repo.applyChange(sp, change, "rc3:sp:world").ok, true);
          assert.strictEqual(cached.repo.getSystem(sp, 30000102).system.threatLevel, 77);
          return { ok: false, reason: "TEST_REFUSED" };
        });
        assert.strictEqual(r.reason, "APPLY_REFUSED");
        return cached.repo.getSystem(db, 30000102).system.threatLevel;
      });
      assert.strictEqual(inner, 12.5, "same tx after the savepoint rollback");
      assert.deepStrictEqual(rcRead(store, cached.repo), committed, "after the savepoint rollback");
      assert.deepStrictEqual(rcRead(store, repo), committed);
    });
  });
  test("RC4 guard: outside the repository and the migration DDL no runtime source (lib, tools) writes "
    + "world_system_state / world_system_influence (a new writer must call the cache invalidate)", () => {
    const WRITE = /\b(UPDATE|INSERT(\s+OR\s+\w+)?\s+INTO|DELETE\s+FROM|REPLACE\s+INTO)\s+["`]?(world_system_(state|influence)\b|\$\{(STATE|INFLUENCE)_TABLE_NAME\})/i;
    const WRITE_CALL = /\bupdateWithVersion\s*\(\s*[^,()]+,\s*(\w+\.)?(STATE|INFLUENCE)_TABLE\b/;
    const writes = (src) => WRITE.test(src) || WRITE_CALL.test(src);
    const repoLines = fs.readFileSync(path.join(MOD_DIR, "lib/world/worldStateRepository.js"), "utf8").split("\n")
      .filter(writes);
    for (const known of ["INSERT INTO ${STATE_TABLE_NAME}", "UPDATE ${STATE_TABLE_NAME}", "UPDATE ${INFLUENCE_TABLE_NAME}",
      "INSERT INTO ${INFLUENCE_TABLE_NAME}", "updateWithVersion(db, STATE_TABLE,"]) {
      assert.ok(repoLines.some((line) => line.includes(known)), `${known} not matched:\n${repoLines.join("\n")}`);
    }
    assert.deepStrictEqual(["updateWithVersion(tx, W.STATE_TABLE, id, v, patch)", "updateWithVersion(db, FLEET_TABLE, id",
      "SELECT x FROM ${STATE_TABLE_NAME}", "DELETE FROM world_system_influence WHERE"].map(writes),
    [true, false, false, true]);
    const ALLOWED = new Set(["lib/world/worldStateRepository.js", "lib/world/schema.js", "lib/world/occupation/schema.js"]);
    const offenders = [];
    const walk = (rel) => {
      for (const e of fs.readdirSync(path.join(MOD_DIR, rel), { withFileTypes: true })) {
        const child = `${rel}/${e.name}`;
        if (e.isDirectory()) walk(child);
        else if (e.name.endsWith(".js") && !ALLOWED.has(child)
          && writes(fs.readFileSync(path.join(MOD_DIR, child), "utf8"))) offenders.push(child);
      }
    };
    walk("lib");
    walk("tools");
    assert.deepStrictEqual(offenders, []);
  });
};
