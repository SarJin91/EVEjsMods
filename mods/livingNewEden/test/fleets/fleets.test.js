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
const { createRng } = require("../../lib/util/rng");
const { createIdGenerator } = require("../../lib/util/ids");
const { FLEET_STATES, OPERATION_STATES } = require("../../lib/fleets/schema");
const { canTransitionFleet, canTransitionOperation } = require("../../lib/fleets/stateMachine");
const { subtractLosses } = require("../../lib/fleets/composition");
const { createFleetRepository } = require("../../lib/fleets/fleetRepository");
const { startFleets } = require("../../lib/fleets");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const START_MS = 1760000000000;
const FACTION = 500019;
const OTHER_FACTION = 500010;
const HOME = 30000142;
const TARGET = 30000144;
const LIMITS = Object.freeze({ maxVirtualFleets: 50, maxCompositionEntries: 32, maxShipsPerFleet: 500,
  maxFleetsPerOperation: 16, maxJsonBytes: 4096, maxListLimit: 500 });
const COMPOSITION = Object.freeze([{ hullGroup: "frigate", typeId: 587, count: 5 }, { hullGroup: "cruiser", count: 3 }]);

const EXPECTED_FLEET_EDGES = [
  "IDLE>PLANNED", "IDLE>ENGAGED", "IDLE>REFITTING", "IDLE>RETREATING", "IDLE>DESTROYED",
  "PLANNED>TRAVELLING", "PLANNED>STAGED", "PLANNED>IDLE", "PLANNED>ENGAGED",
  "TRAVELLING>TRAVELLING", "TRAVELLING>STAGED", "TRAVELLING>RETREATING", "TRAVELLING>ENGAGED",
  "STAGED>PLANNED", "STAGED>IDLE", "STAGED>RETREATING", "STAGED>ENGAGED",
  "ENGAGED>IDLE", "ENGAGED>STAGED", "ENGAGED>REFITTING", "ENGAGED>RETREATING", "ENGAGED>DESTROYED",
  "RETREATING>RETREATING", "RETREATING>REFITTING", "RETREATING>ENGAGED", "RETREATING>IDLE",
  "REFITTING>IDLE", "REFITTING>ENGAGED",
  "IDLE>MATERIALIZED", "MATERIALIZED>IDLE",
  "STAGED>MATERIALIZED", "MATERIALIZED>STAGED",
  "REFITTING>MATERIALIZED", "MATERIALIZED>REFITTING",
].sort();
const EXPECTED_OPERATION_EDGES = ["PLANNED>ACTIVE", "PLANNED>CANCELLED", "ACTIVE>COMPLETED", "ACTIVE>FAILED",
  "ACTIVE>CANCELLED"].sort();

function loadDriver() {
  const found = findServerSrcOnDisk(MOD_DIR, GAMESTORE_SEARCH_MAX_DEPTH, fs.existsSync);
  if (!found.ok) return { ok: false, detail: found.reason };
  return resolveSqliteDriver(found.srcDir);
}

function withStore(driver, fn, { fresh = false } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lne-f-"));
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

function makeRepo(opened, { clock = createManualClock(START_MS), limits = LIMITS, ids } = {}) {
  const journal = createJournal({ clock, maxPayloadBytes: 8192, maxRows: 500 });
  const idGen = ids || createIdGenerator({ clock, rng: createRng(7) });
  const repo = createFleetRepository({ journal, clock, ids: idGen, worldSeed: opened.worldSeed, limits });
  const store = opened.store;
  const tx = (fn) => {
    const r = store.transaction("test", fn);
    assert.ok(r.ok, JSON.stringify(r));
    return r.value;
  };
  return { repo, store, clock, tx };
}

const counts = (tx) => tx((db) => ({
  journal: db.prepare("SELECT count(*) AS n FROM world_event_journal").get().n,
  fleets: db.prepare("SELECT count(*) AS n FROM virtual_fleets").get().n,
  operations: db.prepare("SELECT count(*) AS n FROM world_operations").get().n,
}));

function create(h, key, extra = {}) {
  const r = h.tx((db) => h.repo.createFleet(db, { factionId: FACTION, currentSystemId: HOME, homeSystemId: HOME,
    fleetRole: "invasion", composition: COMPOSITION, ...extra }, key));
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  return r.fleetId;
}

const fleetOf = (h, fleetId) => h.tx((db) => h.repo.getFleet(db, fleetId)).fleet;

function step(h, fleetId, to, patch, key) {
  const f = fleetOf(h, fleetId);
  const r = h.tx((db) => h.repo.transition(db, { fleetId, expectedVersion: f.version, from: f.state, to,
    ...(patch ? { patch } : {}) }, key));
  assert.strictEqual(r.ok, true, `${f.state}->${to}: ${JSON.stringify(r)}`);
  return r;
}

function operation(h, key, fleetIds, factionId = FACTION) {
  const fleets = fleetIds.map((fleetId) => ({ fleetId, expectedVersion: fleetOf(h, fleetId).version }));
  return h.tx((db) => h.repo.createOperation(db, { operationType: "invasion", factionId, originSystemId: HOME,
    targetSystemId: TARGET, objective: "capture", dueAt: START_MS + 60000, fleets }, key));
}

const FLIGHT = Object.freeze({ targetSystemId: TARGET, route: { systems: [HOME, 30000143, TARGET] },
  routeGraphVersion: 1, nextActionAt: START_MS + 30000, legSeq: 1 });

module.exports = ({ test, skip }) => {
  const driver = loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  needsDriver("F1 fleets migration 5: from 4 keeps data, STRICT tables, query plans use the indexes", () => {
    withStore(driver, (reopen) => {
      const old = reopen(MIGRATIONS.slice(0, 4));
      assert.strictEqual(old.schemaVersion, 4);
      const seeded = old.store.transaction("seed", (db) => db.prepare("INSERT INTO world_system_state (system_id, "
        + "security_class, controller_faction_id, occupation_state, threat_level, last_state_change_at, updated_at, "
        + "version) VALUES (30000142, 'nullsec', 500019, 'STABLE', 0, 1, 1, 1)").run());
      assert.ok(seeded.ok, JSON.stringify(seeded));
      old.store.close("upgrade");
      const upgraded = reopen();
      assert.deepStrictEqual([upgraded.schemaVersion, upgraded.applied], [LATEST_SCHEMA_VERSION, LATEST_SCHEMA_VERSION - 4]);
      const h = makeRepo(upgraded);
      h.tx((db) => {
        assert.strictEqual(db.prepare("SELECT count(*) AS n FROM world_system_state").get().n, 1, "seed kept");
        const strict = db.prepare("SELECT name, strict FROM pragma_table_list WHERE name IN ('virtual_fleets', "
          + "'world_operations') ORDER BY name").all();
        assert.deepStrictEqual(strict.map((r) => [r.name, r.strict]), [["virtual_fleets", 1], ["world_operations", 1]]);
        const plan = (sql) => db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all().map((r) => r.detail).join(" | ");
        const cases = [
          ["SELECT * FROM virtual_fleets WHERE current_system_id = 1", /USING (COVERING )?INDEX virtual_fleets_system/],
          ["SELECT * FROM virtual_fleets WHERE faction_id = 1", /USING (COVERING )?INDEX virtual_fleets_faction/],
          ["SELECT * FROM virtual_fleets WHERE state = 'IDLE'", /USING (COVERING )?INDEX virtual_fleets_state/],
          ["SELECT * FROM virtual_fleets WHERE state = 'TRAVELLING' AND fleet_id > '' ORDER BY fleet_id LIMIT 256",
            /USING (COVERING )?INDEX virtual_fleets_state/],
          ["SELECT * FROM virtual_fleets WHERE operation_id = 'op_x'", /USING (COVERING )?INDEX virtual_fleets_operation/],
        ];
        for (const [sql, re] of cases) assert.match(plan(sql), re, sql);
      });
    }, { fresh: true });
  });

  needsDriver("F2 fleets transition tables: 34 + 5 edges, terminal states, refusal writes no journal row", () => {
    const fleetEdges = [];
    for (const from of FLEET_STATES) {
      for (const to of FLEET_STATES) {
        const r = canTransitionFleet(from, to);
        if (r.ok) fleetEdges.push(`${from}>${to}`);
        else assert.deepStrictEqual(r, { ok: false, reason: "ILLEGAL_TRANSITION", from, to });
      }
    }
    assert.deepStrictEqual(fleetEdges.sort(), EXPECTED_FLEET_EDGES);
    assert.strictEqual(fleetEdges.length, 34);
    assert.ok(!fleetEdges.some((e) => e.startsWith("DESTROYED>")));
    assert.deepStrictEqual(fleetEdges.filter((e) => e.includes("MATERIALIZED")).sort(),
      ["IDLE>MATERIALIZED", "MATERIALIZED>IDLE", "MATERIALIZED>REFITTING", "MATERIALIZED>STAGED",
        "REFITTING>MATERIALIZED", "STAGED>MATERIALIZED"]);
    assert.deepStrictEqual(canTransitionFleet("IDLE", "FLYING"), { ok: false, reason: "UNKNOWN_STATE", state: "FLYING" });
    const opEdges = [];
    for (const from of OPERATION_STATES) {
      for (const to of OPERATION_STATES) {
        const r = canTransitionOperation(from, to);
        if (r.ok) opEdges.push(`${from}>${to}`);
        else assert.strictEqual(r.reason, "ILLEGAL_TRANSITION");
      }
    }
    assert.deepStrictEqual(opEdges.sort(), EXPECTED_OPERATION_EDGES);
    withStore(driver, (reopen) => {
      const h = makeRepo(reopen());
      const fleetId = create(h, "test:create:f2");
      const before = counts(h.tx);
      const r = h.tx((db) => h.repo.transition(db, { fleetId, expectedVersion: 1, from: "IDLE", to: "TRAVELLING",
        patch: FLIGHT }, "test:f2:illegal"));
      assert.deepStrictEqual(r, { ok: false, reason: "ILLEGAL_TRANSITION", from: "IDLE", to: "TRAVELLING" });
      assert.deepStrictEqual(counts(h.tx), before);
      assert.strictEqual(h.tx((db) => h.repo.isApplied(db, "test:f2:illegal")).applied, false);
    });
  });

  needsDriver("F3 fleets idempotency: duplicate transition/create, conflicts, operation rolled back as a whole", () => {
    withStore(driver, (reopen) => {
      const h = makeRepo(reopen());
      const fleetId = create(h, "test:create:a");
      const change = { fleetId, expectedVersion: 1, from: "IDLE", to: "REFITTING", patch: { nextActionAt: START_MS + 5 } };
      const first = h.tx((db) => h.repo.transition(db, change, "test:refit:a"));
      assert.deepStrictEqual([first.ok, first.duplicate, first.version], [true, false, 2]);
      const again = h.tx((db) => h.repo.transition(db, change, "test:refit:a"));
      assert.deepStrictEqual([again.ok, again.duplicate], [true, true]);
      assert.strictEqual(fleetOf(h, fleetId).version, 2);
      const conflict = h.tx((db) => h.repo.transition(db, { ...change, patch: { nextActionAt: START_MS + 6 } },
        "test:refit:a"));
      assert.strictEqual(conflict.reason, "IDEMPOTENCY_CONFLICT");
      const stale = h.tx((db) => h.repo.transition(db, { fleetId, expectedVersion: 1, from: "REFITTING", to: "IDLE" },
        "test:idle:a"));
      assert.deepStrictEqual(stale, { ok: false, reason: "VERSION_CONFLICT", expectedVersion: 1, actualVersion: 2 });
      const wrongFrom = h.tx((db) => h.repo.transition(db, { fleetId, expectedVersion: 2, from: "ENGAGED", to: "IDLE" },
        "test:idle:a"));
      assert.deepStrictEqual(wrongFrom, { ok: false, reason: "STATE_MISMATCH", expected: "ENGAGED", actual: "REFITTING" });

      const spec = { factionId: FACTION, currentSystemId: HOME, fleetRole: "patrol", composition: COMPOSITION };
      const c1 = h.tx((db) => h.repo.createFleet(db, spec, "test:create:b"));
      const c2 = h.tx((db) => h.repo.createFleet(db, spec, "test:create:b"));
      assert.deepStrictEqual([c1.duplicate, c2.duplicate, c2.fleetId], [false, true, c1.fleetId]);
      assert.strictEqual(counts(h.tx).fleets, 2);

      const other = create(h, "test:create:c", { factionId: OTHER_FACTION });
      const before = counts(h.tx);
      const refused = operation(h, "test:op:mixed", [c1.fleetId, other]);
      assert.strictEqual(refused.reason, "FLEET_FACTION_MISMATCH", JSON.stringify(refused));
      assert.deepStrictEqual(counts(h.tx), before);
      assert.deepStrictEqual([fleetOf(h, c1.fleetId).state, fleetOf(h, c1.fleetId).version], ["IDLE", 1]);
      const ok = operation(h, "test:op:one", [c1.fleetId]);
      assert.deepStrictEqual([ok.ok, ok.duplicate], [true, false], JSON.stringify(ok));
      const retry = operation(h, "test:op:one", [c1.fleetId]);
      assert.deepStrictEqual([retry.ok, retry.duplicate, retry.operationId], [true, true, ok.operationId]);
      assert.strictEqual(fleetOf(h, c1.fleetId).operationId, ok.operationId);
    });
  });

  needsDriver("F4 fleets losses and limit: no clamp, all lost -> DESTROYED, FLEET_LIMIT frees on destruction", () => {
    const pure = subtractLosses(COMPOSITION, [{ hullGroup: "cruiser", typeId: null, count: 4 }]);
    assert.deepStrictEqual(pure, { ok: false, reason: "NEGATIVE_COMPOSITION", hullGroup: "cruiser", typeId: null,
      have: 3, lost: 4 });
    withStore(driver, (reopen) => {
      const h = makeRepo(reopen(), { limits: { ...LIMITS, maxVirtualFleets: 2 } });
      const a = create(h, "test:create:a");
      const b = create(h, "test:create:b");
      const third = h.tx((db) => h.repo.createFleet(db, { factionId: FACTION, currentSystemId: HOME,
        fleetRole: "invasion", composition: COMPOSITION }, "test:create:c"));
      assert.deepStrictEqual(third, { ok: false, reason: "FLEET_LIMIT", limit: 2, count: 2 });

      const idle = h.tx((db) => h.repo.applyLosses(db, { fleetId: a, expectedVersion: 1,
        losses: [{ hullGroup: "cruiser", count: 1 }] }, "test:loss:idle"));
      assert.deepStrictEqual(idle, { ok: false, reason: "FLEET_NOT_ENGAGED", state: "IDLE" });
      step(h, a, "ENGAGED", null, "test:engage:a");
      const kill = h.tx((db) => h.repo.transition(db, { fleetId: a, expectedVersion: 2, from: "ENGAGED",
        to: "DESTROYED" }, "test:kill:a"));
      assert.deepStrictEqual(kill, { ok: false, reason: "FLEET_INVARIANT", field: "shipCount", state: "DESTROYED" });
      const before = fleetOf(h, a);
      for (const losses of [[{ hullGroup: "cruiser", count: 4 }], [{ hullGroup: "battleship", count: 1 }]]) {
        const r = h.tx((db) => h.repo.applyLosses(db, { fleetId: a, expectedVersion: 2, losses }, "test:loss:over"));
        assert.strictEqual(r.reason, "NEGATIVE_COMPOSITION", JSON.stringify(r));
      }
      assert.deepStrictEqual(fleetOf(h, a), before, "row unchanged");
      const all = h.tx((db) => h.repo.applyLosses(db, { fleetId: a, expectedVersion: 2,
        losses: COMPOSITION.map((e) => ({ ...e })) }, "test:loss:all"));
      assert.deepStrictEqual([all.ok, all.destroyed, all.shipCount, all.composition], [true, true, 0, []]);
      const dead = fleetOf(h, a);
      assert.deepStrictEqual([dead.state, dead.shipCount, dead.route, dead.nextActionAt, dead.targetSystemId],
        ["DESTROYED", 0, null, null, null]);
      const c = h.tx((db) => h.repo.createFleet(db, { factionId: FACTION, currentSystemId: HOME,
        fleetRole: "invasion", composition: COMPOSITION }, "test:create:c"));
      assert.strictEqual(c.ok, true, JSON.stringify(c));
      assert.deepStrictEqual(h.tx((db) => h.repo.countByState(db)), { ok: true, counts: { DESTROYED: 1, IDLE: 2 },
        active: 2 });
      assert.ok(b);
    });
  });

  needsDriver("F5 fleets restart: every reachable state and an ACTIVE operation survive a new store and repo", () => {
    withStore(driver, (reopen) => {
      const clock = createManualClock(START_MS);
      const ids = createIdGenerator({ clock, rng: createRng(9) });
      const first = reopen();
      const h = makeRepo(first, { clock, ids });
      const byState = {};
      byState.IDLE = create(h, "test:create:idle");
      const [p, t, s] = ["planned", "travelling", "staged"].map((n) => create(h, `test:create:${n}`));
      const op = operation(h, "test:op:main", [p, t, s]);
      assert.strictEqual(op.ok, true, JSON.stringify(op));
      byState.PLANNED = p;
      step(h, t, "TRAVELLING", FLIGHT, "test:travel:t");
      byState.TRAVELLING = t;
      step(h, s, "STAGED", null, "test:stage:s");
      byState.STAGED = s;
      byState.ENGAGED = create(h, "test:create:engaged");
      step(h, byState.ENGAGED, "ENGAGED", null, "test:engage:e");
      byState.RETREATING = create(h, "test:create:retreating");
      step(h, byState.RETREATING, "ENGAGED", null, "test:engage:r");
      step(h, byState.RETREATING, "RETREATING", { ...FLIGHT, targetSystemId: HOME }, "test:retreat:r");
      byState.REFITTING = create(h, "test:create:refitting");
      step(h, byState.REFITTING, "REFITTING", { nextActionAt: START_MS + 900000 }, "test:refit:x");
      byState.DESTROYED = create(h, "test:create:destroyed");
      step(h, byState.DESTROYED, "ENGAGED", null, "test:engage:d");
      const loss = h.tx((db) => h.repo.applyLosses(db, { fleetId: byState.DESTROYED, expectedVersion: 2,
        losses: COMPOSITION.map((e) => ({ ...e })) }, "test:loss:d"));
      assert.strictEqual(loss.destroyed, true);
      const active = h.tx((db) => h.repo.transitionOperation(db, { operationId: op.operationId, expectedVersion: 1,
        from: "PLANNED", to: "ACTIVE" }, "test:op:activate"));
      assert.strictEqual(active.ok, true, JSON.stringify(active));

      const snapshot = (hh) => ({
        fleets: Object.fromEntries(Object.entries(byState).map(([st, id]) => [st, fleetOf(hh, id)])),
        operation: hh.tx((db) => hh.repo.getOperation(db, op.operationId)).operation,
      });
      const before = snapshot(h);
      for (const [st, f] of Object.entries(before.fleets)) assert.strictEqual(f.state, st);
      assert.strictEqual(before.fleets.TRAVELLING.nextActionAt, FLIGHT.nextActionAt);
      assert.strictEqual(before.operation.state, "ACTIVE");
      first.store.close("restart");

      const h2 = makeRepo(reopen(), { clock, ids });
      assert.deepStrictEqual(snapshot(h2), before);
      const members = h2.tx((db) => h2.repo.listFleetsOfOperation(db, op.operationId)).fleets.map((f) => f.fleetId);
      assert.deepStrictEqual(members, [p, t, s].sort());
      const inSystem = h2.tx((db) => h2.repo.listFleetsInSystem(db, HOME, { limit: 3 }));
      assert.strictEqual(inSystem.fleets.length, 3);
      assert.ok(inSystem.nextAfterFleetId);
      const closed = h2.tx((db) => h2.repo.transitionOperation(db, { operationId: op.operationId, expectedVersion: 2,
        from: "ACTIVE", to: "COMPLETED" }, "test:op:complete"));
      assert.deepStrictEqual(closed, { ok: false, reason: "OPERATION_HAS_FLEETS", count: 3 });
    });
  });
  needsDriver("F6 fleets: ordered state needs an open operation, member limit on join, truncated, start fit", () => {
    withStore(driver, (reopen) => {
      const opened = reopen();
      const h = makeRepo(opened, { limits: { ...LIMITS, maxFleetsPerOperation: 2 } });
      const activate = (opId, key) => h.tx((db) => h.repo.transitionOperation(db, { operationId: opId,
        expectedVersion: 1, from: "PLANNED", to: "ACTIVE" }, key));
      const complete = (opId, key) => h.tx((db) => h.repo.transitionOperation(db, { operationId: opId,
        expectedVersion: 2, from: "ACTIVE", to: "COMPLETED" }, key));
      const tryStep = (fleetId, to, patch, key) => {
        const f = fleetOf(h, fleetId);
        return h.tx((db) => h.repo.transition(db, { fleetId, expectedVersion: f.version, from: f.state, to,
          ...(patch ? { patch } : {}) }, key));
      };

      const a = create(h, "f6:create:a");
      const op = operation(h, "f6:op:a", [a]);
      assert.strictEqual(op.ok, true, JSON.stringify(op));
      step(h, a, "TRAVELLING", FLIGHT, "f6:travel:a");
      step(h, a, "ENGAGED", null, "f6:engage:a");
      assert.strictEqual(activate(op.operationId, "f6:op:a:act").ok, true);
      assert.strictEqual(complete(op.operationId, "f6:op:a:done").ok, true);
      const before = counts(h.tx);
      const staged = tryStep(a, "STAGED", null, "f6:staged:a");
      assert.deepStrictEqual(staged, { ok: false, reason: "OPERATION_CLOSED", operationId: op.operationId,
        state: "COMPLETED" });
      assert.deepStrictEqual(counts(h.tx), before, "refusal writes nothing");
      assert.strictEqual(fleetOf(h, a).state, "ENGAGED");
      step(h, a, "IDLE", null, "f6:idle:a");
      assert.strictEqual(fleetOf(h, a).operationId, null);

      const other = create(h, "f6:create:other", { factionId: OTHER_FACTION });
      const join = tryStep(other, "PLANNED", { operationId: op.operationId }, "f6:join:other");
      assert.strictEqual(join.reason, "OPERATION_CLOSED");

      const b1 = create(h, "f6:create:b1");
      const b2 = create(h, "f6:create:b2");
      const b3 = create(h, "f6:create:b3");
      const opb = operation(h, "f6:op:b", [b1, b2]);
      assert.strictEqual(opb.ok, true, JSON.stringify(opb));
      const full = tryStep(b3, "PLANNED", { operationId: opb.operationId }, "f6:join:b3");
      assert.deepStrictEqual(full, { ok: false, reason: "TOO_MANY_FLEETS", operationId: opb.operationId, count: 3,
        limit: 2 });
      step(h, b1, "STAGED", null, "f6:staged:b1");
      step(h, b1, "PLANNED", { operationId: opb.operationId }, "f6:replan:b1");
      step(h, b2, "ENGAGED", null, "f6:engage:b2");
      const b2Version = fleetOf(h, b2).version;
      const lost = h.tx((db) => h.repo.applyLosses(db, { fleetId: b2, expectedVersion: b2Version,
        losses: COMPOSITION.map((e) => ({ ...e })) }, "f6:loss:b2"));
      assert.strictEqual(lost.destroyed, true);
      step(h, b3, "PLANNED", { operationId: opb.operationId }, "f6:join:b3:again");
      const listed = h.tx((db) => h.repo.listFleetsOfOperation(db, opb.operationId));
      assert.strictEqual(listed.truncated, true);
      assert.deepStrictEqual(listed.fleets.map((f) => f.fleetId), [b1, b3].sort());
      const small = h.tx((db) => h.repo.listFleetsOfOperation(db, op.operationId));
      assert.deepStrictEqual([small.fleets.length, small.truncated], [0, false]);

      const config = { enabled: true, modules: { fleets: { enabled: true } }, limits: { maxVirtualFleets: 50 },
        persistence: { journalMaxPayloadBytes: 8192 },
        fleets: { maxCompositionEntries: 32, maxShipsPerFleet: 500, maxFleetsPerOperation: 16, maxJsonBytes: 4096,
          maxListLimit: 500 } };
      const persistence = { ok: true, store: opened.store, journal: createJournal({ clock: h.clock,
        maxPayloadBytes: 8192, maxRows: 500 }), worldSeed: opened.worldSeed };
      const deps = (cfg) => ({ config: cfg, persistence, clock: h.clock,
        ids: createIdGenerator({ clock: h.clock, rng: createRng(9) }) });
      assert.strictEqual(startFleets(deps(config)).ok, true);
      const rows = startFleets(deps({ ...config, fleets: { ...config.fleets, maxFleetsPerOperation: 250 } }));
      assert.strictEqual(rows.reason, "FLEETS_START_FAILED");
      assert.match(rows.detail, /502 rows > persistence\.maxRowsPerTransaction=500/);
      const bytes = startFleets(deps({ ...config, fleets: { ...config.fleets, maxJsonBytes: 8192 } }));
      assert.strictEqual(bytes.reason, "FLEETS_START_FAILED");
      assert.match(bytes.detail, /fleets\.maxJsonBytes=8192 must be < persistence\.journalMaxPayloadBytes=8192/);
    });
  });

  needsDriver("FB1 listFleetsInSystems: per system exactly listFleetsInSystem(states, limit) "
    + "(over the limit, empty system, 2 lists, 2 limits); UNKNOWN_STATE first; on the real repository and the facade",
  () => {
    withStore(driver, (reopen) => {
      const opened = reopen();
      const h = makeRepo(opened);
      const MID = 30000143;
      const plan = [[HOME, "IDLE"], [HOME, "STAGED"], [HOME, "IDLE"], [HOME, "TRAVELLING"], [HOME, "IDLE"],
        [TARGET, "IDLE"], [TARGET, "DESTROYED"], [TARGET, "STAGED"]];
      const ids = plan.map((_p, i) => create(h, `fb1:${i}`));
      h.tx((db) => plan.forEach(([sys, state], i) => db.prepare(`UPDATE virtual_fleets SET current_system_id = ?,
        state = ? WHERE fleet_id = ?`).run(sys, state, ids[i])));
      const systems = [TARGET, MID, HOME];
      for (const states of [["STAGED", "IDLE"], ["IDLE", "PLANNED", "STAGED", "ENGAGED", "REFITTING", "MATERIALIZED"]]) {
        for (const limitPerSystem of [2, 10]) {
          const got = h.tx((db) => h.repo.listFleetsInSystems(db, systems, { states, limitPerSystem }));
          assert.strictEqual(got.ok, true, JSON.stringify(got));
          assert.deepStrictEqual([...got.bySystem.keys()], [HOME, MID, TARGET]);
          for (const id of systems) {
            const one = h.tx((db) => h.repo.listFleetsInSystem(db, id, { states, limit: limitPerSystem }));
            assert.deepStrictEqual(got.bySystem.get(id), one.fleets, `${id} ${states} ${limitPerSystem}`);
          }
        }
      }
      const home = h.tx((db) => h.repo.listFleetsInSystems(db, [HOME], { states: ["IDLE"], limitPerSystem: 2 }));
      assert.strictEqual(home.bySystem.get(HOME).length, 2, "3 IDLE in HOME, limit 2");
      assert.deepStrictEqual(h.tx((db) => h.repo.listFleetsInSystems(db, [HOME], { states: ["IDLE", "BOGUS"],
        limitPerSystem: 2 })), { ok: false, reason: "UNKNOWN_STATE", state: "BOGUS" });
      const config = { enabled: true, modules: { fleets: { enabled: true } }, limits: { maxVirtualFleets: 50 },
        persistence: { journalMaxPayloadBytes: 8192 },
        fleets: { maxCompositionEntries: 32, maxShipsPerFleet: 500, maxFleetsPerOperation: 16, maxJsonBytes: 4096,
          maxListLimit: 500 } };
      const persistence = { ok: true, store: opened.store, journal: createJournal({ clock: h.clock,
        maxPayloadBytes: 8192, maxRows: 500 }), worldSeed: opened.worldSeed };
      const facade = startFleets({ config, persistence, clock: h.clock,
        ids: createIdGenerator({ clock: h.clock, rng: createRng(9) }) });
      assert.strictEqual(facade.ok, true, JSON.stringify(facade));
      const viaFacade = facade.fleets.listFleetsInSystems(systems, { states: ["IDLE"], limitPerSystem: 10 });
      assert.strictEqual(viaFacade.ok, true, JSON.stringify(viaFacade));
      assert.deepStrictEqual(viaFacade.bySystem.get(HOME).map((f) => f.fleetId),
        [ids[0], ids[2], ids[4]].sort());
    });
  });

  needsDriver("F7 disband: IDLE logistics fleet -> DESTROYED (composition [], removed = composition), duplicate "
    + "key, STAGED / refit_pending / wrong system / role refused, countByState.active - 1", () => {
    withStore(driver, (reopen) => {
      const h = makeRepo(reopen());
      const comp = [{ hullGroup: "frigate", count: 2 }, { hullGroup: "destroyer", count: 1 }];
      const a = create(h, "test:create:d1", { fleetRole: "logistics", composition: comp });
      const before = h.tx((db) => h.repo.countByState(db)).active;
      const go = (fleetId, extra, key) => {
        const expectedVersion = fleetOf(h, fleetId).version;
        return h.tx((db) => h.repo.disband(db, { fleetId, expectedVersion, systemId: HOME, fleetRole: "logistics",
          ...extra }, key));
      };
      assert.strictEqual(go(a, { systemId: TARGET }, "test:d:loc").reason, "LOCATION_MISMATCH");
      assert.strictEqual(go(a, { fleetRole: "patrol" }, "test:d:role").reason, "ROLE_MISMATCH");
      const r = go(a, {}, "test:d:a");
      assert.deepStrictEqual([r.ok, r.duplicate, r.version, r.removed], [true, false, 2,
        [{ hullGroup: "destroyer", count: 1 }, { hullGroup: "frigate", count: 2 }]], JSON.stringify(r));
      const dead = fleetOf(h, a);
      assert.deepStrictEqual([dead.state, dead.shipCount, dead.composition.length, dead.refitPending,
        dead.operationId], ["DESTROYED", 0, 0, false, null]);
      const again = h.tx((db) => h.repo.disband(db, { fleetId: a, expectedVersion: 1, systemId: HOME,
        fleetRole: "logistics" }, "test:d:a"));
      assert.deepStrictEqual([again.ok, again.duplicate], [true, true]);
      assert.strictEqual(h.tx((db) => h.repo.countByState(db)).active, before - 1);
      const b = create(h, "test:create:d2", { fleetRole: "logistics", composition: comp });
      assert.strictEqual(operation(h, "test:op:d2", [b]).ok, true);
      step(h, b, "STAGED", null, "test:stage:d2");
      assert.strictEqual(go(b, {}, "test:d:b").reason, "STATE_MISMATCH");
      const c = create(h, "test:create:d3", { fleetRole: "logistics", composition: comp });
      step(h, c, "ENGAGED", null, "test:engage:d3");
      step(h, c, "IDLE", { refitPending: true }, "test:idle:d3");
      assert.strictEqual(go(c, {}, "test:d:c").reason, "REFIT_PENDING");
      const d = create(h, "test:create:d4", { fleetRole: "logistics", composition: comp });
      assert.deepStrictEqual(h.tx((db) => h.repo.transition(db, { fleetId: d, expectedVersion: 1, from: "IDLE",
        to: "DESTROYED" }, "test:d:kill")), { ok: false, reason: "FLEET_INVARIANT", field: "shipCount",
        state: "DESTROYED" });
    });
  });

  needsDriver("C4 fleet disband with allowRefitPending: true disbands REFIT_PENDING fleet, config defaults for invasions.enabled", () => withStore(driver, (reopen) => {
    const h = makeRepo(reopen());
    const comp = [{ hullGroup: "frigate", count: 2 }, { hullGroup: "destroyer", count: 1 }];
    const c = create(h, "test:create:c4a", { fleetRole: "logistics", composition: comp });
    step(h, c, "ENGAGED", null, "test:engage:c4a");
    step(h, c, "IDLE", { refitPending: true }, "test:idle:c4a");
    const before = h.tx((db) => h.repo.countByState(db)).active;
    const cVersion = fleetOf(h, c).version;
    const r = h.tx((db) => h.repo.disband(db, {
      fleetId: c, expectedVersion: cVersion, systemId: HOME, fleetRole: "logistics",
      allowRefitPending: true
    }, "test:d:c4a"));
    assert.deepStrictEqual([r.ok, r.duplicate, r.version, r.removed.length], [true, false, 4, 2], JSON.stringify(r));
    const dead = fleetOf(h, c);
    assert.deepStrictEqual([dead.state, dead.shipCount, dead.refitPending, dead.operationId], ["DESTROYED", 0, false, null]);
    assert.strictEqual(h.tx((db) => h.repo.countByState(db)).active, before - 1, "active count decreased");

    const d2 = create(h, "test:create:c4b", { fleetRole: "logistics", composition: comp });
    step(h, d2, "ENGAGED", null, "test:engage:c4b");
    step(h, d2, "IDLE", { refitPending: true }, "test:idle:c4b");
    const d2Version = fleetOf(h, d2).version;
    const r2 = h.tx((db) => h.repo.disband(db, {
      fleetId: d2, expectedVersion: d2Version, systemId: HOME, fleetRole: "logistics"
    }, "test:d:c4b"));
    assert.strictEqual(r2.reason, "REFIT_PENDING", "default false still refuses");

    const config = require("../../config");
    const resolved = config.resolveConfig({ modDir: path.resolve(__dirname, "..", ".."), env: { EVEJS_DATA_ROOT: os.tmpdir() } });
    assert.deepStrictEqual(resolved.errors || [], []);
    assert.strictEqual(resolved.config.invasions.enabled, true, "invasions.enabled default is true");
    assert.strictEqual(resolved.config.invasions.sleeperWithdrawAfterMs, 259200000);
    assert.strictEqual(resolved.config.invasions.withdrawRetryMs, 900000);
    assert.strictEqual(resolved.config.invasions.withdrawMaxRounds, 16);
  }));
};
