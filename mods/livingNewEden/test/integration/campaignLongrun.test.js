"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const SDE_DIR = path.resolve(MOD_DIR, "..", "..", "_local", "sde", "eve-online-static-data-3396210-jsonl");

function adapterMethodsUsedByLib() {
  const used = new Set();
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (full !== path.join(MOD_DIR, "lib", "adapter")) walk(full);
      } else if (entry.name.endsWith(".js")) {
        const text = fs.readFileSync(full, "utf8");
        for (const m of text.matchAll(/\badapter\.([a-zA-Z_]\w*)\s*\(/g)) used.add(m[1]);
        for (const m of text.matchAll(/typeof\s+adapter\.([a-zA-Z_]\w*)\s*===\s*"function"/g)) used.add(m[1]);
      }
    }
  };
  walk(path.join(MOD_DIR, "lib"));
  return [...used].sort();
}

module.exports = ({ test, skip, bench, benchEnabled }) => {
  const benchScheduler = require("../../tools/benchScheduler");

  test("LR0 bench adapter has every adapter method the services call", () => {
    const { createBenchAdapter } = require("../../tools/campaign/benchAdapter");
    const world = { worldData: { ensureLoaded: () => ({ solarSystems: [], stargates: [], stations: [] }),
      getStationByID: () => null }, asteroidData: { getBeltsForSystem: () => [] }, sdeBuild: 1 };
    const adapter = createBenchAdapter({ world, driver: { ok: false, reason: "test" }, policy: null, band: null });
    const used = adapterMethodsUsedByLib();
    assert.ok(used.length >= 40, `grep found ${used.length} methods`);
    const missing = used.filter((name) => typeof adapter[name] !== "function");
    assert.deepStrictEqual(missing, [], "methods called by lib/ but absent from the bench adapter");
    assert.strictEqual(adapter.getProcessRole(), "world");
    assert.deepStrictEqual(adapter.getSovClaims().claimOf(30000001), { ok: true, claimed: false, allianceId: null });
    assert.deepStrictEqual(adapter.readSdeBuild(), { ok: true, build: 1 });
    assert.deepStrictEqual(adapter.requireGame("space/worldData"), { ok: false, reason: "BENCH_UNSUPPORTED" });
    assert.deepStrictEqual(adapter.readPresence({}), { ok: false, reason: "BENCH_UNSUPPORTED" });
  });

  const driver = benchScheduler.loadDriver();
  if (!driver.ok) {
    skip("LR1 digest + checks", `better-sqlite3 unavailable (${driver.detail})`);
    return;
  }

  function tmpDb(name) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `lne-lr1-${name}-`));
    return { dir, file: path.join(dir, "t.sqlite") };
  }

  function withDb(name, fn, seed) {
    const t = tmpDb(name);
    if (seed) seed(t.file);
    const db = new driver.Database(t.file);
    try {
      return fn(db, t);
    } finally {
      db.close();
      try {
        fs.rmSync(t.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      } catch (_err) {
      }
    }
  }

  test("LR1 digest: the same rows in another insert order -> the same full digest", () => {
    const { fullDigest } = require("../../tools/campaign/digest");
    const fill = (db, order) => {
      db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT, b BLOB); CREATE TABLE u (k TEXT, n INTEGER)");
      for (const id of order) db.prepare("INSERT INTO t (id, v, b) VALUES (?, ?, ?)").run(id, `v${id}`, Buffer.from([id]));
      db.prepare("INSERT INTO u (k, n) VALUES ('a', 1)").run();
      return fullDigest(db);
    };
    const a = withDb("a", (db) => fill(db, [1, 2, 3]));
    const b = withDb("b", (db) => fill(db, [3, 1, 2]));
    assert.strictEqual(a.ok, true, JSON.stringify(a));
    assert.strictEqual(a.tables.t.rows, 3);
    assert.strictEqual(a.digest, b.digest);
  });

  test("LR1 digest: one changed value (also a BLOB byte) -> another digest", () => {
    const { fullDigest } = require("../../tools/campaign/digest");
    withDb("c", (db) => {
      db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT, b BLOB)");
      db.prepare("INSERT INTO t (id, v, b) VALUES (1, 'a', ?)").run(Buffer.from([1, 2]));
      const d1 = fullDigest(db);
      db.prepare("UPDATE t SET v = 'z' WHERE id = 1").run();
      const d2 = fullDigest(db);
      db.prepare("UPDATE t SET b = ? WHERE id = 1").run(Buffer.from([1, 3]));
      const d3 = fullDigest(db);
      assert.notStrictEqual(d1.digest, d2.digest);
      assert.notStrictEqual(d2.digest, d3.digest);
      assert.notStrictEqual(d1.tables.t.digest, d2.tables.t.digest);
    });
  });

  test("LR1 semantic digest leaves out a volatile table and a volatile column only", () => {
    const { semanticDigest } = require("../../tools/campaign/digest");
    withDb("d", (db) => {
      db.exec("CREATE TABLE s (id INTEGER PRIMARY KEY, v TEXT, at INTEGER); CREATE TABLE vol (id INTEGER PRIMARY KEY, v TEXT)");
      db.prepare("INSERT INTO s (id, v, at) VALUES (1, 'x', 10)").run();
      db.prepare("INSERT INTO vol (id, v) VALUES (1, 'a')").run();
      const volatile = ["vol", "s.at"];
      const d1 = semanticDigest(db, { volatile });
      db.prepare("UPDATE vol SET v = 'b'").run();
      db.prepare("UPDATE s SET at = 11").run();
      const d2 = semanticDigest(db, { volatile });
      assert.strictEqual(d1.digest, d2.digest);
      assert.strictEqual(d1.tables.vol, undefined);
      db.prepare("UPDATE s SET v = 'y'").run();
      assert.notStrictEqual(semanticDigest(db, { volatile }).digest, d1.digest);
    });
  });

  test("LR1 checks: 1 over limit, 1 capture without adjacency, 1 disabled-module row, 1 foreign core -> "
    + "1/1/1/1 pass false; repaired -> pass true", () => {
    const { checkCampaignInvariants, snapshotForChecks } = require("../../tools/campaign/checks");
    const { seedDbFile } = require("../_support/dbTemplate");
    const { resolveConfig } = require("../../config");
    const base = resolveConfig({ modDir: MOD_DIR, env: {} }).config;
    const config = { ...base, strategy: { ...base.strategy, maxCapturedSystemsPerFaction: 1,
      captureRequiresAdjacency: true } };
    withDb("chk", (db) => {
      const sys = db.prepare(`INSERT INTO world_system_state (system_id, security_class, controller_faction_id,
        occupation_state, threat_level, last_state_change_at, updated_at, version, occupier_faction_id, captured_at,
        home_faction_id) VALUES (?, 'nullsec', ?, ?, 0, 0, 0, 1, ?, ?, ?)`);
      sys.run(31, 500020, "STABLE", null, null, 500020);
      const prev = snapshotForChecks(db);
      sys.run(32, 500020, "OCCUPIED", 500020, 1000, null);
      sys.run(35, 500020, "OCCUPIED", 500020, 1001, null);
      sys.run(30001868, 500020, "STABLE", null, null, 500019);
      db.prepare(`INSERT INTO world_sov_projection_log (system_id, last_controller, last_action, last_seq, updated_at,
        version) VALUES (40, 500020, 'GAIN', 1, 0, 1)`).run();
      const graph = { getNeighbors: (id) => ({ 31: [32], 32: [31, 33], 33: [32, 34], 34: [33, 35], 35: [34] }[id] || []) };
      const ctx = { config, prev, graph, ownSpaceOf: () => new Set() };
      const r = checkCampaignInvariants(db, ctx);
      assert.strictEqual(r.ok, true, JSON.stringify(r));
      assert.strictEqual(r.counts.capturedOverLimit, 1, JSON.stringify(r.details));
      assert.strictEqual(r.counts.nonAdjacentCaptures, 1, JSON.stringify(r.details));
      assert.deepStrictEqual(r.details.nonAdjacentCaptures, [{ systemId: 35, factionId: 500020 }]);
      assert.strictEqual(r.counts.disabledModuleRows, 1);
      assert.strictEqual(r.counts.coreViolations, 1);
      assert.strictEqual(r.counts.occupationInvariantViolations, 0);
      assert.strictEqual(r.pass, false);
      assert.deepStrictEqual(r.failing.sort(), ["capturedOverLimit", "coreViolations", "disabledModuleRows",
        "nonAdjacentCaptures"]);

      db.prepare("DELETE FROM world_system_state WHERE system_id = 35").run();
      db.prepare("UPDATE world_system_state SET controller_faction_id = 500019 WHERE system_id = 30001868").run();
      db.prepare("DELETE FROM world_sov_projection_log").run();
      const fixed = checkCampaignInvariants(db, ctx);
      assert.strictEqual(fixed.ok, true, JSON.stringify(fixed));
      assert.deepStrictEqual(fixed.failing, []);
      assert.strictEqual(fixed.pass, true, JSON.stringify(fixed.counts));
    }, (file) => seedDbFile(driver, file));
  });

  test("LR1 checks: an anchor lost later in the same interval still anchors (journal history); a capture "
    + "with no neighbour of F at any time is still counted", () => {
    const { checkCampaignInvariants, snapshotForChecks } = require("../../tools/campaign/checks");
    const { seedDbFile } = require("../_support/dbTemplate");
    const { resolveConfig } = require("../../config");
    const base = resolveConfig({ modDir: MOD_DIR, env: {} }).config;
    const config = { ...base, strategy: { ...base.strategy, maxCapturedSystemsPerFaction: 10,
      captureRequiresAdjacency: true } };
    const A = 500020;
    const B = 500012;
    withDb("chk-note2", (db) => {
      const sys = db.prepare(`INSERT INTO world_system_state (system_id, security_class, controller_faction_id,
        occupation_state, threat_level, last_state_change_at, updated_at, version, occupier_faction_id, captured_at,
        home_faction_id) VALUES (?, 'nullsec', ?, ?, 0, 0, 0, 1, ?, ?, ?)`);
      let seq = 0;
      const journal = (systemId, f, capturedAt) => {
        seq += 1;
        db.prepare(`INSERT INTO world_event_journal (idempotency_key, kind, aggregate_type, aggregate_id, event_type,
          payload, payload_hash, state, created_at, applied_at) VALUES (?, 'APPLY', 'world_system', ?, 'OCCUPATION_PHASE',
          ?, ?, 'APPLIED', ?, ?)`).run(`t:note2:${seq}`, String(systemId), JSON.stringify({ systemId, create: false,
          state: { controllerFactionId: f, capturedAt }, influence: [] }), "a".repeat(64), capturedAt, capturedAt);
      };
      sys.run(41, A, "STABLE", null, null, A);
      sys.run(51, A, "STABLE", null, null, A);
      sys.run(52, A, "STABLE", null, null, A);
      sys.run(40, B, "STABLE", null, null, B);
      const prev = snapshotForChecks(db);
      journal(42, A, 1000);
      journal(43, A, 2000);
      journal(42, B, 3000);
      sys.run(42, B, "OCCUPIED", B, 3000, null);
      sys.run(43, A, "OCCUPIED", A, 2000, null);
      journal(50, B, 4000);
      sys.run(50, B, "OCCUPIED", B, 4000, null);
      const graph = { getNeighbors: (id) => ({ 40: [42], 41: [42], 42: [40, 41, 43], 43: [42], 50: [51, 52],
        51: [50], 52: [50] }[id] || []) };
      const r = checkCampaignInvariants(db, { config, prev, graph, ownSpaceOf: () => new Set() });
      assert.strictEqual(r.ok, true, JSON.stringify(r));
      assert.strictEqual(r.counts.nonAdjacentCaptures, 1, JSON.stringify(r.details));
      assert.deepStrictEqual(r.details.nonAdjacentCaptures, [{ systemId: 50, factionId: B }]);
      assert.ok(r.failing.includes("nonAdjacentCaptures"), JSON.stringify(r.failing));

      db.prepare("DELETE FROM world_event_journal WHERE idempotency_key = 't:note2:1'").run();
      const old = checkCampaignInvariants(db, { config, prev, graph, ownSpaceOf: () => new Set() });
      assert.strictEqual(old.ok, true, JSON.stringify(old));
      assert.deepStrictEqual(old.details.nonAdjacentCaptures, [{ systemId: 43, factionId: A },
        { systemId: 50, factionId: B }]);
    }, (file) => seedDbFile(driver, file));
  });

  test("LR1 checks: own-space belt at 1 jump anchors (K4); a beachhead anchors only while its invasion is "
    + "open at the capture (K3)", () => {
    const { checkCampaignInvariants, snapshotForChecks } = require("../../tools/campaign/checks");
    const { seedDbFile } = require("../_support/dbTemplate");
    const { resolveConfig } = require("../../config");
    const base = resolveConfig({ modDir: MOD_DIR, env: {} }).config;
    const config = { ...base, strategy: { ...base.strategy, maxCapturedSystemsPerFaction: 10,
      captureRequiresAdjacency: true } };
    const A = 500020;
    withDb("chk-d9539", (db) => {
      const sys = db.prepare(`INSERT INTO world_system_state (system_id, security_class, controller_faction_id,
        occupation_state, threat_level, last_state_change_at, updated_at, version, occupier_faction_id, captured_at,
        home_faction_id) VALUES (?, 'nullsec', ?, ?, 0, 0, 0, 1, ?, ?, ?)`);
      const invasion = db.prepare(`INSERT INTO world_invasions (invasion_id, idempotency_key, roll_round, faction_id,
        profile_id, beachhead_system_id, capture_range_jumps, state, open, step_seq, fleet_ids_json, plan_json,
        started_at, ended_at, created_at, updated_at, version) VALUES (?, ?, ?, ?, 'p', ?, 0, ?, ?, 0, '[]', '{}', ?, ?,
        0, 0, 1)`);
      const prev = snapshotForChecks(db);
      sys.run(62, A, "OCCUPIED", A, 1000, null);
      invasion.run("inv-ended", "k-ended", 1, A, 64, "ENDED", 0, 500, 1500);
      sys.run(64, A, "OCCUPIED", A, 2000, null);
      invasion.run("inv-open", "k-open", 2, A, 70, "ACTIVE", 1, 500, null);
      sys.run(70, A, "OCCUPIED", A, 2000, null);
      const graph = { getNeighbors: (id) => ({ 60: [61], 61: [60, 62], 62: [61, 63], 63: [62, 64], 64: [63] }[id]
        || []) };
      const r = checkCampaignInvariants(db, { config, prev, graph,
        ownSpaceOf: (f) => (f === A ? new Set([60]) : new Set()) });
      assert.strictEqual(r.ok, true, JSON.stringify(r));
      assert.deepStrictEqual(r.details.nonAdjacentCaptures, [{ systemId: 64, factionId: A }]);
      assert.strictEqual(r.counts.nonAdjacentCaptures, 1);
      assert.strictEqual(r.counts.footholdCaptures, 1);
    }, (file) => seedDbFile(driver, file));
  });

  test("LR1 checks: periodicChainsDoubled counts doubled periodic chains", () => {
    const { checkCampaignInvariants, snapshotForChecks } = require("../../tools/campaign/checks");
    const { seedDbFile } = require("../_support/dbTemplate");
    const { resolveConfig } = require("../../config");
    const base = resolveConfig({ modDir: MOD_DIR, env: {} }).config;
    const config = { ...base, strategy: { ...base.strategy, maxCapturedSystemsPerFaction: 5 } };
    withDb("chk-periodic", (db) => {
      const prev = snapshotForChecks(db);
      const ctx = { config, prev, graph: { getNeighbors: () => [] }, ownSpaceOf: () => new Set() };
      const h64 = "a".repeat(64);

      db.prepare("INSERT INTO world_scheduled_events (event_id, idempotency_key, event_type, aggregate_type, aggregate_id, due_at, priority, payload, payload_hash, state, attempts, created_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, '{}', ?, ?, ?, ?, ?)")
        .run("evt1", "key1", "FACTION_STRATEGY_REVIEW", "faction", "500001", 1000, 4, h64, "QUEUED", 0, 0, 1);
      db.prepare("INSERT INTO world_scheduled_events (event_id, idempotency_key, event_type, aggregate_type, aggregate_id, due_at, priority, payload, payload_hash, state, attempts, created_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, '{}', ?, ?, ?, ?, ?)")
        .run("evt2", "key2", "FACTION_STRATEGY_REVIEW", "faction", "500001", 2000, 4, h64, "QUEUED", 0, 0, 1);
      let r = checkCampaignInvariants(db, ctx);
      assert.strictEqual(r.ok, true, JSON.stringify(r));
      assert.strictEqual(r.counts.periodicChainsDoubled, 1, JSON.stringify(r.counts));
      assert.strictEqual(r.pass, false);
      assert.ok(r.failing.includes("periodicChainsDoubled"), "periodicChainsDoubled should be in failing");

      db.prepare("DELETE FROM world_scheduled_events").run();
      db.prepare("INSERT INTO world_scheduled_events (event_id, idempotency_key, event_type, aggregate_type, aggregate_id, due_at, priority, payload, payload_hash, state, attempts, created_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, '{}', ?, ?, ?, ?, ?)")
        .run("evt3", "key3", "FACTION_STRATEGY_REVIEW", "faction", "500001", 1000, 4, h64, "QUEUED", 0, 0, 1);
      r = checkCampaignInvariants(db, ctx);
      assert.strictEqual(r.ok, true, JSON.stringify(r));
      assert.strictEqual(r.counts.periodicChainsDoubled, 0, JSON.stringify(r.counts));
      assert.ok(!r.failing.includes("periodicChainsDoubled"), "periodicChainsDoubled should NOT be in failing");

      db.prepare("DELETE FROM world_scheduled_events").run();
      db.prepare("INSERT INTO world_scheduled_events (event_id, idempotency_key, event_type, aggregate_type, aggregate_id, due_at, priority, payload, payload_hash, state, attempts, created_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, '{}', ?, ?, ?, ?, ?)")
        .run("evt4", "key4", "FACTION_STRATEGY_REVIEW", "faction", "500001", 1000, 4, h64, "QUEUED", 0, 0, 1);
      db.prepare("INSERT INTO world_scheduled_events (event_id, idempotency_key, event_type, aggregate_type, aggregate_id, due_at, priority, payload, payload_hash, state, attempts, created_at, version, finished_at, outcome) VALUES (?, ?, ?, ?, ?, ?, ?, '{}', ?, ?, ?, ?, ?, ?, ?)")
        .run("evt5", "key5", "FACTION_STRATEGY_REVIEW", "faction", "500001", 2000, 4, h64, "DONE", 0, 0, 1, 2000, "COMPLETED");
      r = checkCampaignInvariants(db, ctx);
      assert.strictEqual(r.ok, true, JSON.stringify(r));
      assert.strictEqual(r.counts.periodicChainsDoubled, 0, JSON.stringify(r.counts));
      assert.ok(!r.failing.includes("periodicChainsDoubled"), "periodicChainsDoubled should NOT be in failing");

      db.prepare("DELETE FROM world_scheduled_events").run();
      db.prepare("INSERT INTO world_scheduled_events (event_id, idempotency_key, event_type, aggregate_type, aggregate_id, due_at, priority, payload, payload_hash, state, attempts, created_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, '{}', ?, ?, ?, ?, ?)")
        .run("evt6", "key6", "FACTION_STRATEGY_REVIEW", "faction", "500001", 1000, 4, h64, "QUEUED", 0, 0, 1);
      db.prepare("INSERT INTO world_scheduled_events (event_id, idempotency_key, event_type, aggregate_type, aggregate_id, due_at, priority, payload, payload_hash, state, attempts, created_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, '{}', ?, ?, ?, ?, ?)")
        .run("evt7", "key7", "FACTION_STRATEGY_REVIEW", "faction", "500002", 2000, 4, h64, "QUEUED", 0, 0, 1);
      r = checkCampaignInvariants(db, ctx);
      assert.strictEqual(r.ok, true, JSON.stringify(r));
      assert.strictEqual(r.counts.periodicChainsDoubled, 0, JSON.stringify(r.counts));
      assert.ok(!r.failing.includes("periodicChainsDoubled"), "periodicChainsDoubled should NOT be in failing for different aggregate_id");

      db.prepare("DELETE FROM world_scheduled_events").run();
      db.prepare("INSERT INTO world_scheduled_events (event_id, idempotency_key, event_type, aggregate_type, aggregate_id, due_at, priority, payload, payload_hash, state, attempts, created_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, '{}', ?, ?, ?, ?, ?)")
        .run("evt8", "key8", "BATTLE_RECONCILE", "battle", "b100", 1000, 5, h64, "QUEUED", 0, 0, 1);
      db.prepare("INSERT INTO world_scheduled_events (event_id, idempotency_key, event_type, aggregate_type, aggregate_id, due_at, priority, payload, payload_hash, state, attempts, created_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, '{}', ?, ?, ?, ?, ?)")
        .run("evt9", "key9", "BATTLE_RECONCILE", "battle", "b100", 2000, 5, h64, "QUEUED", 0, 0, 1);
      r = checkCampaignInvariants(db, ctx);
      assert.strictEqual(r.ok, true, JSON.stringify(r));
      assert.strictEqual(r.counts.periodicChainsDoubled, 0, JSON.stringify(r.counts));
      assert.ok(!r.failing.includes("periodicChainsDoubled"), "periodicChainsDoubled should NOT be in failing for non-periodic type");
    }, (file) => seedDbFile(driver, file));
  });

  test("LR1 checks: with ctx.now only >=2 live rows (QUEUED, due_at > now) are periodicChainsDoubled "
    + "the rest periodicChainsConverging (informational)", () => {
    const { checkCampaignInvariants, snapshotForChecks } = require("../../tools/campaign/checks");
    const { seedDbFile } = require("../_support/dbTemplate");
    const { resolveConfig } = require("../../config");
    const base = resolveConfig({ modDir: MOD_DIR, env: {} }).config;
    const config = { ...base, strategy: { ...base.strategy, maxCapturedSystemsPerFaction: 5 } };
    withDb("chk-periodic-now", (db) => {
      const prev = snapshotForChecks(db);
      const ctxOf = (now) => ({ config, prev, graph: { getNeighbors: () => [] }, ownSpaceOf: () => new Set(), now });
      const h64 = "a".repeat(64);
      const ins = db.prepare("INSERT INTO world_scheduled_events (event_id, idempotency_key, event_type, aggregate_type, aggregate_id, due_at, priority, payload, payload_hash, state, attempts, created_at, version) VALUES (?, ?, ?, ?, ?, ?, ?, '{}', ?, ?, ?, ?, ?)");
      const two = (stateA, dueA, stateB, dueB) => {
        db.prepare("DELETE FROM world_scheduled_events").run();
        ins.run("evtA", "strategy:review:500001:9", "FACTION_STRATEGY_REVIEW", "faction", "500001", dueA, 4, h64, stateA, 0, 0, 1);
        ins.run("evtB", "strategy:review:500001:10", "FACTION_STRATEGY_REVIEW", "faction", "500001", dueB, 4, h64, stateB, 0, 0, 1);
      };

      two("QUEUED", 1000, "QUEUED", 2000);
      let r = checkCampaignInvariants(db, ctxOf(1500));
      assert.strictEqual(r.ok, true, JSON.stringify(r));
      assert.strictEqual(r.counts.periodicChainsDoubled, 0, JSON.stringify(r.counts));
      assert.strictEqual(r.counts.periodicChainsConverging, 1, JSON.stringify(r.counts));
      assert.ok(!r.failing.includes("periodicChainsDoubled") && !r.failing.includes("periodicChainsConverging"),
        JSON.stringify(r.failing));
      assert.deepStrictEqual(r.details.periodicChainsDoubled, []);
      const sample = [{ eventType: "FACTION_STRATEGY_REVIEW", aggregateId: "500001",
        keys: ["strategy:review:500001:10", "strategy:review:500001:9"] }];
      assert.deepStrictEqual(r.details.periodicChainsConverging, sample);
      r = checkCampaignInvariants(db, ctxOf(undefined));
      assert.strictEqual(r.counts.periodicChainsDoubled, 1, JSON.stringify(r.counts));
      assert.strictEqual(r.counts.periodicChainsConverging, 0, JSON.stringify(r.counts));
      assert.deepStrictEqual(r.details.periodicChainsConverging, []);
      assert.ok(r.notes.includes("no now: periodicChainsDoubled counts every open pair (old rule)"), JSON.stringify(r.notes));
      const keys = Object.keys(r.counts);
      assert.strictEqual(keys.indexOf("periodicChainsConverging"), keys.indexOf("periodicChainsDoubled") + 1);

      two("QUEUED", 1000, "QUEUED", 2000);
      r = checkCampaignInvariants(db, ctxOf(500));
      assert.strictEqual(r.counts.periodicChainsDoubled, 1, JSON.stringify(r.counts));
      assert.strictEqual(r.counts.periodicChainsConverging, 0, JSON.stringify(r.counts));
      assert.ok(r.failing.includes("periodicChainsDoubled"), JSON.stringify(r.failing));
      assert.strictEqual(r.pass, false);
      assert.deepStrictEqual(r.details.periodicChainsDoubled[0], { eventType: "FACTION_STRATEGY_REVIEW",
        aggregateId: "500001", keys: ["strategy:review:500001:10", "strategy:review:500001:9"] });
      assert.deepStrictEqual(r.details.periodicChainsConverging, []);

      two("RETRY", 3000, "QUEUED", 2000);
      r = checkCampaignInvariants(db, ctxOf(500));
      assert.strictEqual(r.ok, true, JSON.stringify(r));
      assert.strictEqual(r.counts.periodicChainsDoubled, 0, JSON.stringify(r.counts));
      assert.strictEqual(r.counts.periodicChainsConverging, 1, JSON.stringify(r.counts));
      assert.ok(!r.failing.includes("periodicChainsDoubled"), JSON.stringify(r.failing));
      assert.deepStrictEqual(r.details.periodicChainsConverging, sample);
    }, (file) => seedDbFile(driver, file));
  });

  test("LR1 checks: occupationTickChainsDoubled counts two live tick chains of one system, seq and interval", () => {
    const { checkCampaignInvariants, snapshotForChecks } = require("../../tools/campaign/checks");
    const { seedDbFile } = require("../_support/dbTemplate");
    const { resolveConfig } = require("../../config");
    const base = resolveConfig({ modDir: MOD_DIR, env: {} }).config;
    const config = { ...base, strategy: { ...base.strategy, maxCapturedSystemsPerFaction: 5 } };
    withDb("chk-occ", (db) => {
      const prev = snapshotForChecks(db);
      const h64 = "a".repeat(64);
      const ins = db.prepare("INSERT INTO world_scheduled_events (event_id, idempotency_key, event_type, aggregate_type, aggregate_id, due_at, priority, payload, payload_hash, state, attempts, created_at, version) VALUES (?, ?, 'OCCUPATION_PHASE_CHANGE', 'world_system', ?, ?, 3, '{}', ?, ?, 0, 0, 1)");
      const add = (id, key, agg, dueAt, state = "QUEUED") => ins.run(id, key, agg, dueAt, h64, state);

      const ctxWithNow = (now) => ({ config, prev, graph: { getNeighbors: () => [] }, ownSpaceOf: () => new Set(), now });

      db.prepare("DELETE FROM world_scheduled_events").run();
      add("o1", "occ:30000001:3:t:600000:17", "30000001", 10200000);
      add("o2", "occ:30000001:3:t:600000:18", "30000001", 10800000);
      let r = checkCampaignInvariants(db, ctxWithNow(10000000));
      assert.strictEqual(r.ok, true, JSON.stringify(r));
      assert.strictEqual(r.counts.occupationTickChainsDoubled, 1, JSON.stringify(r.counts));
      assert.strictEqual(r.pass, false, JSON.stringify(r.counts));
      assert.ok(r.failing.includes("occupationTickChainsDoubled"), "occupationTickChainsDoubled should be in failing");
      assert.deepStrictEqual(r.details.occupationTickChainsDoubled, [{ aggregateId: "30000001", seq: 3, intervalMs: 600000, keys: ["occ:30000001:3:t:600000:17", "occ:30000001:3:t:600000:18"] }], JSON.stringify(r.details));

      db.prepare("DELETE FROM world_scheduled_events").run();
      add("b1", "occ:30000001:3:t:600000:17", "30000001", 10200000);
      ins.run("b2", "occ:30000001:3:b:bat-1", "30000001", 10100000, h64, "QUEUED");
      r = checkCampaignInvariants(db, ctxWithNow(10000000));
      assert.strictEqual(r.ok, true, JSON.stringify(r));
      assert.strictEqual(r.counts.occupationTickChainsDoubled, 0, JSON.stringify(r.counts));
      assert.ok(!r.failing.includes("occupationTickChainsDoubled"), "occupationTickChainsDoubled should NOT be in failing");

      db.prepare("DELETE FROM world_scheduled_events").run();
      add("c1", "occ:30000001:3:t:600000:17", "30000001", 10200000);
      add("c2", "occ:30000001:3:t:3600000:3", "30000001", 10800000);
      r = checkCampaignInvariants(db, ctxWithNow(10000000));
      assert.strictEqual(r.ok, true, JSON.stringify(r));
      assert.strictEqual(r.counts.occupationTickChainsDoubled, 0, JSON.stringify(r.counts));
      assert.ok(!r.failing.includes("occupationTickChainsDoubled"), "occupationTickChainsDoubled should NOT be in failing for different interval");

      db.prepare("DELETE FROM world_scheduled_events").run();
      add("d1", "occ:30000001:3:t:600000:17", "30000001", 10200000);
      add("d2", "occ:30000001:4:t:600000:17", "30000001", 10200000);
      r = checkCampaignInvariants(db, ctxWithNow(10000000));
      assert.strictEqual(r.ok, true, JSON.stringify(r));
      assert.strictEqual(r.counts.occupationTickChainsDoubled, 0, JSON.stringify(r.counts));
      assert.ok(!r.failing.includes("occupationTickChainsDoubled"), "occupationTickChainsDoubled should NOT be in failing for different seq");

      db.prepare("DELETE FROM world_scheduled_events").run();
      add("e1", "occ:30000001:3:t:600000:16", "30000001", 9600000);
      add("e2", "occ:30000001:3:t:600000:17", "30000001", 10200000);
      r = checkCampaignInvariants(db, ctxWithNow(10000000));
      assert.strictEqual(r.ok, true, JSON.stringify(r));
      assert.strictEqual(r.counts.occupationTickChainsDoubled, 0, JSON.stringify(r.counts));
      assert.ok(!r.failing.includes("occupationTickChainsDoubled"), "occupationTickChainsDoubled should NOT be in failing for late tick");

      db.prepare("DELETE FROM world_scheduled_events").run();
      add("f1", "occ:30000001:3:t:600000:17", "30000001", 10200000, "QUEUED");
      db.prepare("INSERT INTO world_scheduled_events (event_id, idempotency_key, event_type, aggregate_type, aggregate_id, due_at, priority, payload, payload_hash, state, attempts, created_at, version, finished_at, outcome) VALUES (?, ?, 'OCCUPATION_PHASE_CHANGE', 'world_system', ?, ?, 3, '{}', ?, ?, 0, 0, 1, ?, ?)")
        .run("f2", "occ:30000001:3:t:600000:18", "30000001", 10800000, h64, "DONE", 10000000, "COMPLETED");
      r = checkCampaignInvariants(db, ctxWithNow(10000000));
      assert.strictEqual(r.ok, true, JSON.stringify(r));
      assert.strictEqual(r.counts.occupationTickChainsDoubled, 0, JSON.stringify(r.counts));
      assert.ok(!r.failing.includes("occupationTickChainsDoubled"), "occupationTickChainsDoubled should NOT be in failing for DONE row");

      db.prepare("DELETE FROM world_scheduled_events").run();
      add("g1", "occ:30000001:3:t:600000:17", "30000001", 10200000);
      add("g2", "occ:30000001:3:t:600000:18", "30000001", 10800000);
      r = checkCampaignInvariants(db, { config, prev, graph: { getNeighbors: () => [] }, ownSpaceOf: () => new Set() });
      assert.strictEqual(r.ok, true, JSON.stringify(r));
      assert.strictEqual(r.counts.occupationTickChainsDoubled, 0, JSON.stringify(r.counts));
      assert.ok(r.notes.includes("no now: occupationTickChainsDoubled not computed"), "note should mention occupationTickChainsDoubled");
    }, (file) => seedDbFile(driver, file));
  });

  test("LR-R1 sampleDay: reactive / reviewEcon day deltas, observe p50/p95/max, schedulerRows; reactive null "
    + "without strategy.reactive.runs; MD has the reactive table", () => {
    const { sampleDay, formatMd } = require("../../tools/campaign/metrics");
    const { seedDbFile } = require("../_support/dbTemplate");
    const { resolveConfig } = require("../../config");
    const config = resolveConfig({ modDir: MOD_DIR, env: {} }).config;
    withDb("rr1", (db) => {
      const ev = db.prepare(`INSERT INTO world_scheduled_events (event_id, idempotency_key, event_type, aggregate_type,
        aggregate_id, priority, due_at, payload, payload_hash, state, attempts, outcome, created_at, finished_at,
        version) VALUES (?, ?, 'T', 'a', 'a', 3, 0, '{}', ?, ?, 0, ?, 0, ?, 1)`);
      const done = (id) => ev.run(id, `k-${id}`, "0".repeat(64), "DONE", "OK", 0);
      ev.run("e1", "k-e1", "0".repeat(64), "QUEUED", null, null);
      done("e2");
      done("e3");
      const prevCounters = { "strategy.reactive.runs": 100, "strategy.reactive.defenses": 1, "strategy.reactive.capped": 2,
        "strategy.review.launches": 5, "strategy.review.produced": 7 };
      const counters = { "strategy.reactive.runs": 1540, "strategy.reactive.idle": 1400, "strategy.reactive.launches": 4,
        "strategy.reactive.defenses": 3, "strategy.reactive.reliefs": 1, "strategy.reactive.capped": 2,
        "strategy.review.launches": 9, "strategy.review.mobilized": 6, "strategy.review.produced": 10,
        "strategy.review.mineDispatched": 12 };
      const observe = { "strategy.reactiveReadMs": Array.from({ length: 20 }, (_, i) => 20 - i),
        "strategy.reviewReadMs": [4, 2], "other.name": [999] };
      const ctx = { config, day: 1, fromAt: 0, at: 86400000, cursor: null, counters, prevCounters, observe,
        run: { passes: 1, events: 1, wallMs: 1, passMs: [1] }, files: null, views: null, tradeMode: "off(bench)" };
      const g = sampleDay(db, ctx).sample.global;
      assert.deepStrictEqual(g.reactive, { runs: 1440, idle: 1400, reacted: 0, skipped: 0, deferred: 0, stale: 0,
        launches: 4, defenses: 2, reliefs: 1, capped: 0, capScanTruncated: 0, intentRefused: 0, pruned: 0, sweeps: 0,
        rowCapped: 0, readFailed: 0, superseded: 0, fullReads: 0 });
      assert.deepStrictEqual(g.reviewEcon, { launches: 4, mobilized: 6, produced: 3, mineDispatched: 12 });
      assert.deepStrictEqual(g.observe, {
        "strategy.reviewReadMs": { n: 2, p50: 2, p95: 4, max: 4 },
        "strategy.reactiveReadMs": { n: 20, p50: 10, p95: 19, max: 20 },
        "strategy.reactiveDecideMs": null,
      });
      assert.strictEqual(g.schedulerRows, 3);
      assert.strictEqual(g.openSchedulerEvents, 1);
      const off = sampleDay(db, { ...ctx, counters: { "strategy.review.launches": 3 }, prevCounters: null, observe: undefined })
        .sample.global;
      assert.strictEqual(off.reactive, null);
      assert.deepStrictEqual(off.observe["strategy.reviewReadMs"], { n: 0, p50: 0, p95: 0, max: 0 });
      assert.strictEqual(off.observe["strategy.reactiveReadMs"], null);
      const sample = { day: 1, perFaction: {}, global: g };
      const offSample = { day: 2, perFaction: {}, global: off };
      const md = formatMd({ seed: 1, days: 2, restart: { mode: "none" }, header: {}, samples: [sample, offSample],
        checksLine: "-", ok: true, failures: [] });
      assert.ok(md.includes("## Reactive review"), md);
      assert.ok(md.includes("| 1 | 1440 | 4 | 2 | 1 | 0 | 4 | 6 | 3 | 12 | 10/19/20 | 4 | 3 |"), md);
      assert.ok(md.includes("| 2 | - | - | - | - | - | 3 | 0 | 0 | 0 | - | 0 | 3 |"), md);
    }, (file) => seedDbFile(driver, file));
  });

  test("LR0b expected services from config minus bench exclusions", () => {
    const { resolveConfig } = require("../../config");
    const { computeExpectedBenchServices } = require("../../tools/benchCampaign");
    const MOD_DIR = path.resolve(__dirname, "..", "..");

    const base = resolveConfig({ modDir: MOD_DIR, env: {} }).config;

    const allEnabled = JSON.parse(JSON.stringify(base));
    for (const m of ["graph", "world", "fleets", "scheduler", "strategy", "battle", "persistence", "telemetry", "presence"]) {
      allEnabled.modules[m] = { ...allEnabled.modules[m], enabled: true };
    }
    allEnabled.wrecks = { ...(allEnabled.wrecks || {}), enabled: true };
    allEnabled.occupation = { ...(allEnabled.occupation || {}), enabled: true };
    allEnabled.liberation = { ...(allEnabled.liberation || {}), enabled: true };
    allEnabled.invasions = { ...(allEnabled.invasions || {}), enabled: true };
    allEnabled.salvage = { ...(allEnabled.salvage || {}), enabled: true };
    allEnabled.stations = { ...(allEnabled.stations || {}), enabled: true };
    allEnabled.mining = { ...(allEnabled.mining || {}), enabled: true };
    allEnabled.production = { ...(allEnabled.production || {}), enabled: true };
    allEnabled.logistics = { ...(allEnabled.logistics || {}), enabled: true };
    allEnabled.construction = { ...(allEnabled.construction || {}), enabled: true };
    allEnabled.siege = { ...(allEnabled.siege || {}), enabled: true };
    allEnabled.hunt = { ...(allEnabled.hunt || {}), enabled: true };
    allEnabled.trade = { ...(allEnabled.trade || {}), enabled: true };
    allEnabled.observer = { ...(allEnabled.observer || {}), enabled: true };

    const expected = computeExpectedBenchServices(allEnabled);
    assert.ok(expected.length > 0, "expected services not empty");
    assert.ok(!expected.includes("presence"), "presence excluded");
    assert.ok(!expected.includes("standings"), "standings excluded");
    assert.ok(!expected.includes("trade"), "trade excluded");
    assert.ok(!expected.includes("observer"), "observer excluded");
    assert.ok(!expected.includes("beltNavy"), "beltNavy excluded");
    assert.ok(!expected.includes("playerSiege"), "playerSiege excluded");
    assert.ok(!expected.includes("sentries"), "sentries excluded");
    assert.ok(!expected.includes("events"), "Danger events excluded");
    assert.ok(!expected.includes("sites"), "Danger sites excluded");
    assert.ok(!expected.includes("materialization"), "Danger materialization excluded");
    assert.ok(!expected.includes("virtualCorps"), "Danger virtualCorps excluded");
    assert.ok(!expected.includes("sovProjection"), "Danger sovProjection excluded");
    assert.ok(!expected.includes("structures"), "Danger structures excluded");
    assert.ok(expected.includes("graph"), "graph included");
    assert.ok(expected.includes("world"), "world included");
    assert.ok(expected.includes("fleets"), "fleets included");
    assert.ok(expected.includes("scheduler"), "scheduler included");
    assert.ok(expected.includes("persistence"), "persistence included");
    assert.ok(expected.includes("telemetry"), "telemetry included");
    assert.ok(expected.includes("battle"), "battle included");
    assert.ok(expected.includes("strategy"), "strategy included");
    assert.ok(expected.includes("stations"), "stations included");
    assert.ok(expected.includes("wrecks"), "wrecks included");
    assert.ok(expected.includes("occupation"), "occupation included");
    assert.ok(expected.includes("liberation"), "liberation included");
    assert.ok(expected.includes("invasions"), "invasions included");
    assert.ok(expected.includes("salvage"), "salvage included");
    assert.ok(expected.includes("mining"), "mining included");
    assert.ok(expected.includes("production"), "production included");
    assert.ok(expected.includes("logistics"), "logistics included");
    assert.ok(expected.includes("construction"), "construction included");
    assert.ok(expected.includes("siege"), "siege included");
    assert.ok(expected.includes("hunt"), "hunt included");

    const invasionsOff = JSON.parse(JSON.stringify(allEnabled));
    invasionsOff.invasions = { ...invasionsOff.invasions, enabled: false };
    const expected2 = computeExpectedBenchServices(invasionsOff);
    assert.ok(!expected2.includes("invasions"), "invasions disabled => not expected");

    const invasionsOn = JSON.parse(JSON.stringify(allEnabled));
    invasionsOn.invasions = { ...invasionsOn.invasions, enabled: true };
    const expected3 = computeExpectedBenchServices(invasionsOn);
    assert.ok(expected3.includes("invasions"), "invasions enabled => expected");
  });

  test("LR0b evaluateServiceStates: synthetic statuses", () => {
    const { evaluateServiceStates, BENCH_EXCLUSIONS } = require("../../tools/benchCampaign");

    const svc = (name, state, reason, requires = []) => ({ name, state, reason, detail: null, requires });

    const allRunning = [
      svc("telemetry", "running"),
      svc("persistence", "running"),
      svc("graph", "running"),
      svc("invasions", "running"),
    ];
    assert.deepStrictEqual(evaluateServiceStates(allRunning, BENCH_EXCLUSIONS), []);

    const withFailed = [
      svc("telemetry", "running"),
      svc("invasions", "failed", "DB_ERROR"),
    ];
    assert.deepStrictEqual(evaluateServiceStates(withFailed, BENCH_EXCLUSIONS), ["invasions:failed:DB_ERROR"]);

    const withDepDisabled = [
      svc("telemetry", "running"),
      svc("persistence", "failed", "DB_ERROR"),
      svc("invasions", "disabled", "dependency_disabled:persistence"),
    ];
    assert.deepStrictEqual(evaluateServiceStates(withDepDisabled, BENCH_EXCLUSIONS), [
      "persistence:failed:DB_ERROR",
      "invasions:disabled:dependency_disabled:persistence",
    ]);

    const withDisabledByConfig = [
      svc("telemetry", "running"),
      svc("invasions", "disabled", "disabled_by_config"),
    ];
    assert.deepStrictEqual(evaluateServiceStates(withDisabledByConfig, BENCH_EXCLUSIONS), []);

    const withExcludedFailed = [
      svc("telemetry", "running"),
      svc("presence", "failed", "SOME_ERROR"),
      svc("standings", "disabled", "dependency_disabled:presence"),
      svc("events", "failed", "PROBE_DRIFT"),
      svc("beltNavy", "failed", "BELT_NAVY_SEAM_UNAVAILABLE"),
      svc("playerSiege", "failed", "PLAYER_STRUCTURES_SEAM_UNAVAILABLE"),
      svc("sentries", "failed", "SENTRY_SEAM_UNAVAILABLE"),
    ];
    assert.deepStrictEqual(evaluateServiceStates(withExcludedFailed, BENCH_EXCLUSIONS), []);

    const withDepDisabledByConfig = [
      svc("telemetry", "running"),
      svc("persistence", "disabled", "disabled_by_config"),
      svc("invasions", "disabled", "dependency_disabled:persistence"),
    ];
    assert.deepStrictEqual(evaluateServiceStates(withDepDisabledByConfig, BENCH_EXCLUSIONS), []);

    const withDepExcluded = [
      svc("telemetry", "running"),
      svc("presence", "disabled", "disabled_by_config"),
      svc("standings", "disabled", "dependency_disabled:presence"),
    ];
    assert.deepStrictEqual(evaluateServiceStates(withDepExcluded, BENCH_EXCLUSIONS), []);

    const withPending = [
      svc("telemetry", "running"),
      svc("invasions", "pending"),
    ];
    assert.deepStrictEqual(evaluateServiceStates(withPending, BENCH_EXCLUSIONS), ["invasions:pending:not_started"]);

    const withStopped = [
      svc("telemetry", "running"),
      svc("invasions", "stopped", "bench_refused"),
    ];
    assert.deepStrictEqual(evaluateServiceStates(withStopped, BENCH_EXCLUSIONS), ["invasions:stopped:bench_refused"]);

    const transitiveOk = [
      svc("telemetry", "running"),
      svc("a", "disabled", "disabled_by_config"),
      svc("b", "disabled", "dependency_disabled:a"),
      svc("c", "disabled", "dependency_disabled:b"),
    ];
    assert.deepStrictEqual(evaluateServiceStates(transitiveOk, BENCH_EXCLUSIONS), []);

    const transitiveFail = [
      svc("telemetry", "running"),
      svc("a", "failed", "DB_ERROR"),
      svc("b", "disabled", "dependency_disabled:a"),
      svc("c", "disabled", "dependency_disabled:b"),
    ];
    assert.deepStrictEqual(evaluateServiceStates(transitiveFail, BENCH_EXCLUSIONS), [
      "a:failed:DB_ERROR",
      "b:disabled:dependency_disabled:a",
      "c:disabled:dependency_disabled:b",
    ]);
  });

  if (!benchEnabled) return;
  const sdeReady = fs.existsSync(path.join(SDE_DIR, "mapSolarSystems.jsonl"));
  const quiet = { log() {}, logError() {} };
  const counters05b = ["defenses", "defenseInsufficient", "reclaims", "territoryLimit", "captureNotAdjacent",
    "lostHomeTruncated", "reliefs"];

  function assertRun(r) {
    assert.strictEqual(r.ok, true, JSON.stringify({ failures: r.failures, restart: r.restart && {
      ...r.restart, S1: undefined, S2: undefined, F1: undefined, F2: undefined } }));
    assert.strictEqual(r.samples.length, 2);
    assert.strictEqual(r.checks.counts.sovUnavailable, 0);
    assert.strictEqual(r.checks.counts.disabledModuleRows, 0);
    for (const s of r.samples) {
      for (const name of counters05b) assert.ok(s.global.review[name] >= 0, `day ${s.day} review.${name}`);
    }
  }

  if (!sdeReady) {
    skip("LR2/LR3 campaign runs", `no SDE at ${SDE_DIR}`);
    return;
  }
  const { runCampaign } = require("../../tools/benchCampaign");

  bench("LR2 campaign 2 days, restart clean on day 1 -> PASS; same seed without restart -> same digest",
    async () => {
      const r = await runCampaign({ days: 2, restart: "clean", restartDay: 1, seed: 1, logger: quiet });
      assertRun(r);
      assert.strictEqual(r.restart.fullEqual, true);
      assert.strictEqual(r.restart.semanticEqual, true);
      const again = await runCampaign({ days: 1, restart: "none", seed: 1, logger: quiet });
      assert.strictEqual(again.ok, true, JSON.stringify(again.failures));
      assert.strictEqual(again.digest.semantic, r.restart.S1.digest, "determinism: day 1 without restart = S1");
      assert.strictEqual(again.digest.full, r.restart.F1.digest, "determinism: full digest of day 1 = F1");
      assert.strictEqual(r.restart.bootRowsEqual, true);
    });

  bench("LR3 campaign 2 days, restart kill on day 1 -> PASS, F1 = F2", async () => {
    const r = await runCampaign({ days: 2, restart: "kill", restartDay: 1, seed: 1, logger: quiet });
    assertRun(r);
    assert.strictEqual(r.restart.exit.signal === "SIGKILL" || r.restart.exit.code !== 0, true,
      JSON.stringify(r.restart.exit));
    assert.strictEqual(r.restart.F1.digest, r.restart.F2.digest);
  });

  bench("LR0b service states: all running => no SERVICE_NOT_RUNNING; invasions disabled => no FAIL; header.services populated", async () => {
    const { runCampaign } = require("../../tools/benchCampaign");

    const r1 = await runCampaign({ days: 1, restart: "none", seed: 1, logger: quiet });
    assert.strictEqual(r1.ok, true, `campaign failed: ${r1.failures.join("; ")}`);
    const failServiceNotRunning = r1.failures.find((f) => f.startsWith("SERVICE_NOT_RUNNING"));
    assert.strictEqual(failServiceNotRunning, undefined, "no SERVICE_NOT_RUNNING expected when all services running");
    assert.ok(r1.header && r1.header.services, "header.services should be present");
    assert.ok(Array.isArray(r1.header.services), "header.services should be an array");
    assert.ok(r1.header.services.length > 0, "header.services should not be empty");
    for (const svc of r1.header.services) {
      assert.ok(svc.name, "service should have name");
      assert.ok(svc.state, "service should have state");
      assert.ok(["running", "disabled", "failed", "pending", "stopped"].includes(svc.state), `service ${svc.name} has valid state`);
    }
    const expectedServices = r1.header.services.filter((svc) => svc.state === "running").map((svc) => svc.name);
    assert.ok(expectedServices.includes("graph"), "graph running");
    assert.ok(expectedServices.includes("world"), "world running");
    assert.ok(expectedServices.includes("invasions"), "invasions running (enabled by default)");

    const r2 = await runCampaign({ days: 1, restart: "none", seed: 1, logger: quiet, set: { "invasions.enabled": "false" } });
    assert.strictEqual(r2.ok, true, `campaign with invasions disabled failed: ${r2.failures.join("; ")}`);
    const failServiceNotRunning2 = r2.failures.find((f) => f.startsWith("SERVICE_NOT_RUNNING"));
    assert.strictEqual(failServiceNotRunning2, undefined, "no SERVICE_NOT_RUNNING expected when invasions disabled by config");
    assert.ok(r2.header && r2.header.services, "header.services should be present with invasions disabled");
    const invasionsSvc = r2.header.services.find((svc) => svc.name === "invasions");
    assert.ok(invasionsSvc, "invasions must be present in header.services");
    assert.strictEqual(invasionsSvc.state, "disabled", "invasions should be disabled when config disables it");
    assert.ok(invasionsSvc.reason && invasionsSvc.reason.includes("disabled_by_config"), "invasions disabled_by_config");
  });
};
