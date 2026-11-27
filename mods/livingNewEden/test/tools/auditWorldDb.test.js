"use strict";

const assert = require("node:assert");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { findServerSrcOnDisk, GAMESTORE_SEARCH_MAX_DEPTH } = require("../../lib/adapter/locator");
const { resolveSqliteDriver } = require("../../lib/adapter/sqliteDriver");
const { MIGRATIONS, LATEST_SCHEMA_VERSION } = require("../../lib/persistence/migrations");
const { resolveConfig } = require("../../config");
const tool = require("../../tools/auditWorldDb");
const { seedDbFile } = require("../_support/dbTemplate");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const NOW = Date.UTC(2026, 9, 30, 12, 0, 0);
const H = 3600000;
const HASH = "c".repeat(64);
const SYS = 30000001;
const SYS2 = 30000002;
const GURISTAS = 500010;
const CONFIG = resolveConfig({ modDir: MOD_DIR, env: {} }).config;

function loadDriver() {
  const found = findServerSrcOnDisk(MOD_DIR, GAMESTORE_SEARCH_MAX_DEPTH, fs.existsSync);
  if (!found.ok) return { ok: false, detail: found.reason };
  return resolveSqliteDriver(found.srcDir);
}

const sha256 = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

function insertFleet(db, f) {
  db.prepare("INSERT INTO virtual_fleets (fleet_id, faction_id, current_system_id, target_system_id, route_json, "
    + "leg_seq, fleet_role, composition_json, ship_count, supply_state, operation_id, state, next_action_at, "
    + "created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, 1, 'patrol', ?, ?, 100, ?, ?, ?, ?, ?, 1)")
    .run(f.id, GURISTAS, SYS, f.target || null, f.route ? JSON.stringify(f.route) : null,
      JSON.stringify([{ hullGroup: "frigate", typeId: null, count: f.ships }]), f.ships, f.op || null, f.state,
      f.next || null, NOW - 3 * H, NOW - 2 * H);
}

function insertEvent(db, e) {
  db.prepare("INSERT INTO world_scheduled_events (event_id, idempotency_key, event_type, aggregate_type, aggregate_id, "
    + "priority, due_at, payload, payload_hash, state, attempts, last_error, outcome, created_at, claimed_at, "
    + "finished_at, version) VALUES (?, ?, ?, ?, ?, 3, ?, '{}', ?, ?, ?, ?, ?, ?, ?, ?, 1)")
    .run(e.id, e.key, e.type, e.aggType, e.aggId, e.due, HASH, e.state, e.attempts || 0, e.lastError || null,
      e.outcome || null, e.created, e.claimed || null, e.finished || null);
}

function insertJournal(db, key, eventType, aggType, aggId, created) {
  db.prepare("INSERT INTO world_event_journal (idempotency_key, kind, aggregate_type, aggregate_id, event_type, "
    + "payload, payload_hash, state, created_at, applied_at) VALUES (?, 'APPLY', ?, ?, ?, '{}', ?, 'APPLIED', ?, ?)")
    .run(key, aggType, aggId, eventType, HASH, created, created);
}

function insertBattle(db, b) {
  db.prepare("INSERT INTO battle_records (battle_id, idempotency_key, system_id, environment, objective, mode, state, "
    + "resolver_version, input_hash, seed, input_json, fleet_ids, hold_reason, settlement_key, claim_seq, created_at, "
    + "updated_at, settled_at, version) VALUES (?, ?, ?, 'nullsec', 'patrol', 'VIRTUAL', ?, 'v1', ?, 7, '{}', '[]', ?, "
    + "?, 0, ?, ?, ?, 1)")
    .run(b.id, `battle:create:${b.id}`, SYS, b.state, HASH, b.hold || null, b.settleKey || null, b.updated, b.updated,
      b.settled || null);
}

function seedWorld(driver, file) {
  seedDbFile(driver, file, { migrations: MIGRATIONS, seed: 1 });
  const db = new driver.Database(file);
  try {
    db.prepare("INSERT INTO world_operations (operation_id, idempotency_key, operation_type, faction_id, "
      + "origin_system_id, target_system_id, fleet_ids, objective, state, planned_at, seed, updated_at, version) "
      + "VALUES ('op_1', 'op:1', 'patrol', ?, ?, ?, '[\"fleet_t\"]', 'patrol', 'ACTIVE', ?, 1, ?, 1)")
      .run(GURISTAS, SYS, SYS2, NOW - 3 * H, NOW - 3 * H);
    insertFleet(db, { id: "fleet_i", state: "IDLE", ships: 3 });
    insertFleet(db, { id: "fleet_t", state: "TRAVELLING", ships: 2, op: "op_1", target: SYS2,
      route: { systems: [SYS, SYS2] }, next: NOW + 24 * H });
    insertEvent(db, { id: "ev_arr", key: "arrival:fleet_t:1", type: "FLEET_ARRIVAL", aggType: "fleet",
      aggId: "fleet_t", state: "QUEUED", due: NOW + 24 * H, created: NOW - 2 * H });
    insertBattle(db, { id: "battle_c", state: "COMPLETED", settleKey: "settle:battle_c", updated: NOW - 2 * H,
      settled: NOW - 2 * H });
    insertJournal(db, "battle:settle:battle_c", "BATTLE_SETTLED", "battle", "battle_c", NOW - H / 2);
    insertEvent(db, { id: "ev_rec", key: `battle:reconcile:${NOW - H}`, type: "BATTLE_RECONCILE", aggType: "battle",
      aggId: "reconcile", state: "DONE", outcome: "OK", due: NOW - H, created: NOW - H, finished: NOW });
    db.prepare("INSERT INTO world_faction_treasury (faction_id, kind, initial_isk, isk_balance, created_at, updated_at, "
      + "version) VALUES (?, 'pirate', 1000, 1000, ?, ?, 1)").run(GURISTAS, NOW - 3 * H, NOW - 3 * H);
  } finally {
    db.close();
  }
}

let driver_ = null;

function copyOf(base, dir, name, inject) {
  const file = path.join(dir, `${name}.sqlite`);
  fs.copyFileSync(base, file);
  if (inject) {
    const db = new driver_.Database(file);
    try {
      inject(db);
    } finally {
      db.close();
    }
  }
  return file;
}

function runTool(file, argv, extra = {}) {
  const lines = [];
  const code = tool.main({ argv: ["--db", file, ...argv], env: {}, driver: driver_, config: CONFIG, now: () => NOW,
    print: (l) => lines.push(l), tmpDir: extra.tmpDir });
  const text = lines.join("\n");
  let json = null;
  if (argv.includes("--json")) {
    try {
      json = JSON.parse(text);
    } catch (_err) {
      json = null;
    }
  }
  return { code, lines, text, json };
}

const byId = (report) => new Map(report.findings.map((f) => [f.id, f]));

function withLockHolder(file, fn) {
  const holder = new driver_.Database(file);
  try {
    holder.pragma("locking_mode = EXCLUSIVE");
    holder.exec("BEGIN IMMEDIATE");
    holder.exec("COMMIT");
    fn();
  } finally {
    holder.close();
  }
}

const stalePending = (hold) => (db) => {
  insertBattle(db, { id: "battle_p", state: "PENDING", hold, updated: NOW - 3 * H });
  insertEvent(db, { id: "ev_res", key: "battle:resolve:battle_p", type: "BATTLE_RESOLUTION", aggType: "battle",
    aggId: "battle_p", state: "QUEUED", due: NOW + 24 * H, created: NOW - 3 * H });
};

const strategyReviews = (dueA, dueB) => (db) => {
  for (const [s, due] of [["a", dueA], ["b", dueB]]) {
    insertEvent(db, { id: `ev_sr_${s}`, key: `strategy:review:500001:${s}`, type: "FACTION_STRATEGY_REVIEW",
      aggType: "faction", aggId: "500001", state: "QUEUED", due, created: NOW - 2 * H });
  }
};

const INJECTIONS = [
  ["integrity", "ERROR", (db) => {
    db.pragma("ignore_check_constraints = ON");
    db.prepare("UPDATE world_faction_treasury SET isk_balance = -5").run();
  }, [], ["negativeResources"]],
  ["foreignKeys", "ERROR", (db) => {
    db.pragma("foreign_keys = OFF");
    db.prepare("INSERT INTO world_wreck_fields (field_id, battle_id, source, system_id, environment, state, ships_lost, "
      + "composition_json, salvage_units, loot_units, decay_floor_ppm, created_at, expires_at, updated_at, version) "
      + "VALUES ('wf_x', 'battle_gone', 'BATTLE', ?, 'nullsec', 'ACTIVE', 1, '[]', 0, 0, 0, 1, 2, 1, 1)").run(SYS);
  }, [], []],
  ["negativeResources", "ERROR", (db) => {
    db.prepare("INSERT INTO world_mining_trips (trip_id, idempotency_key, faction_id, fleet_id, origin_system_id, "
      + "belt_system_id, state, sec_class, richness_permille, cargo_json, dispatched_at, created_at, updated_at, "
      + "version) VALUES ('trip_1', 'mining:trip:1', ?, 'fleet_i', ?, ?, 'DELIVERED', 'nullsec', 500, '{\"34\":-1}', "
      + "1, 1, 1, 1)").run(GURISTAS, SYS, SYS);
  }, [], []],
  ["malformedJson", "ERROR", (db) => {
    db.pragma("ignore_check_constraints = ON");
    db.prepare("INSERT INTO world_mining_trips (trip_id, idempotency_key, faction_id, fleet_id, origin_system_id, "
      + "belt_system_id, state, sec_class, richness_permille, cargo_json, dispatched_at, created_at, updated_at, "
      + "version) VALUES ('trip_m', 'mining:trip:m', ?, 'fleet_i', ?, ?, 'DELIVERED', 'nullsec', 500, '{zly', "
      + "1, 1, 1, 1)").run(GURISTAS, SYS, SYS);
  }, [], ["integrity"]],
  ["malformedJson", "ERROR", (db) => {
    db.pragma("ignore_check_constraints = ON");
    db.prepare("UPDATE virtual_fleets SET composition_json = '[zly' WHERE fleet_id = 'fleet_i'").run();
  }, [], ["integrity"]],
  ["inFlightWithoutArrival", "ERROR", (db) => {
    db.prepare("DELETE FROM world_scheduled_events WHERE event_id = 'ev_arr'").run();
  }, [], []],
  ["refittingWithoutDeadline", "ERROR", (db) => {
    db.prepare("UPDATE virtual_fleets SET state = 'REFITTING', next_action_at = ? WHERE fleet_id = 'fleet_i'")
      .run(NOW + H);
  }, [], []],
  ["materializedWithoutHunt", "ERROR", (db) => {
    db.prepare("UPDATE virtual_fleets SET state = 'MATERIALIZED' WHERE fleet_id = 'fleet_i'").run();
  }, [], []],
  ["fleetInvariant", "ERROR", (db) => {
    db.prepare("UPDATE virtual_fleets SET ship_count = 5 WHERE fleet_id = 'fleet_i'").run();
  }, [], []],
  ["fleetInvariant", "ERROR", (db) => {
    db.prepare("UPDATE virtual_fleets SET composition_json = '[\"x\"]' WHERE fleet_id = 'fleet_i'").run();
  }, [], []],
  ["periodicChainsDoubled", "ERROR", strategyReviews(NOW + H, NOW + 2 * H), [], []],
  ["operationLinkBroken", "ERROR", (db) => {
    db.prepare("UPDATE world_operations SET state = 'COMPLETED', completed_at = ? WHERE operation_id = 'op_1'")
      .run(NOW - H);
    db.prepare("UPDATE virtual_fleets SET state = 'STAGED' WHERE fleet_id = 'fleet_t'").run();
  }, [], []],
  ["orphanEngaged", "ERROR", (db) => {
    db.prepare("UPDATE virtual_fleets SET state = 'ENGAGED' WHERE fleet_id = 'fleet_i'").run();
  }, [], []],
  ["staleOpenBattle", "ERROR", stalePending(null), ["--now", String(NOW + 2 * H)], []],
  ["quarantinedEvents", "ERROR", (db) => {
    insertEvent(db, { id: "ev_q", key: "hunt:scan:q", type: "HUNT_SCAN", aggType: "world_system", aggId: String(SYS),
      state: "QUARANTINED", attempts: 3, lastError: "boom", due: NOW - H, created: NOW - H, finished: NOW - H / 2 });
  }, [], []],
  ["staleHeldBattle", "WARN", stalePending("AWAITING_LIVE"), ["--now", String(NOW + 2 * H)], []],
  ["overdueEvents", "WARN", (db) => {
    insertEvent(db, { id: "ev_o", key: "hunt:scan:o", type: "HUNT_SCAN", aggType: "world_system", aggId: String(SYS),
      state: "QUEUED", due: NOW - H, created: NOW - 2 * H });
  }, [], []],
  ["periodicChainsConverging", "INFO", strategyReviews(NOW - H, NOW + H), [], []],
];

module.exports = ({ test, skip }) => {
  const driver = loadDriver();
  const names = [
    "AW1 auditWorldDb: clean world -> exit 0, errors 0, lastBootAt + refNow from the db, file and side files unchanged",
    "AW2 auditWorldDb: every injected fault is found by exactly its check (ERROR exit 4, WARN exit 0)",
    "AW3 auditWorldDb: lock -> 2, --snapshot reads a copy under the lock and removes it, bad --integrity -> 1",
    "AW4 auditWorldDb: exact duplicate key (no UNIQUE) -> duplicateKeys 1 exit 4; schema newer than the tool -> 2",
    "AW5 auditWorldDb: --json --out + --baseline -> delta journal.libkillApply per hour; baseline formatVersion 2 -> 1",
    "AW6 auditWorldDb: --snapshot integrity throws -> 3 one copy; CHECK violation -> 4 one copy; quick skips CHECK scan",
    "AW7 auditWorldDb: periodicChainsDoubled sample = <eventType>:<aggregateId>:<sorted keys joined by |>",
  ];
  if (!driver.ok) {
    for (const n of names) skip(n, `better-sqlite3 unavailable (${driver.detail})`);
    return;
  }
  driver_ = driver;

  const withTmp = (prefix, fn) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    try {
      const base = path.join(tmp, "base.sqlite");
      seedWorld(driver, base);
      fn(tmp, base);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  };

  test(names[0], () => withTmp("lne-aw1-", (tmp, base) => {
    const before = sha256(base);
    const list = fs.readdirSync(tmp).sort();
    const r = runTool(base, ["--json"]);
    assert.strictEqual(r.code, tool.EXIT.OK, r.text);
    assert.ok(r.json, r.text);
    assert.strictEqual(r.json.summary.errors, 0, r.text);
    assert.strictEqual(r.json.summary.pass, true);
    assert.strictEqual(r.json.refNowSource, "db");
    assert.strictEqual(r.json.refNow, NOW);
    assert.strictEqual(r.json.lastBootAt, NOW - H);
    assert.strictEqual(r.json.integrity.ok, true);
    assert.strictEqual(r.json.schemaVersion, LATEST_SCHEMA_VERSION);
    assert.strictEqual(r.json.growth.tables.virtual_fleets, 2);
    const ids = r.json.findings.map((f) => f.id);
    assert.strictEqual(new Set(ids).size, ids.length, "one finding per check");
    for (const [id] of INJECTIONS) assert.ok(ids.includes(id), `finding ${id} present`);
    const text = runTool(base, []);
    assert.strictEqual(text.code, tool.EXIT.OK, text.text);
    assert.ok(text.lines[0].startsWith("auditWorldDb (read-only): database "), text.text);
    assert.ok(text.lines.some((l) => l.startsWith("result: PASS errors=0")), text.text);
    assert.strictEqual(sha256(base), before, "the audit must not change the file");
    assert.deepStrictEqual(fs.readdirSync(tmp).sort(), list, "no new side files next to the database");
  }));

  test(names[1], () => withTmp("lne-aw2-", (tmp, base) => {
    const got = [];
    const want = [];
    INJECTIONS.forEach(([id, severity, inject, argv, allowed], i) => {
      const file = copyOf(base, tmp, `inj${i}`, inject);
      const r = runTool(file, ["--json", ...argv]);
      const f = r.json ? byId(r.json) : new Map();
      const hit = f.get(id);
      const otherErrors = r.json ? r.json.findings.filter((x) => x.severity === "ERROR" && x.count > 0
        && x.id !== id && !allowed.includes(x.id)).map((x) => `${x.id}=${x.count}`) : ["no json"];
      got.push({ id, code: r.code, severity: hit ? hit.severity : null, found: Boolean(hit && hit.count >= 1),
        otherErrors, allowed: allowed.map((a) => Boolean(f.get(a) && f.get(a).count >= 1)) });
      want.push({ id, code: severity === "ERROR" ? tool.EXIT.FINDINGS : tool.EXIT.OK, severity, found: true,
        otherErrors: [], allowed: allowed.map(() => true) });
    });
    assert.deepStrictEqual(got, want);
  }));

  test(names[2], () => withTmp("lne-aw3-", (tmp, base) => {
    const snaps = path.join(tmp, "snaps");
    fs.mkdirSync(snaps);
    const live = copyOf(base, tmp, "live");
    const before = sha256(live);
    withLockHolder(live, () => {
      const locked = runTool(live, []);
      assert.strictEqual(locked.code, tool.EXIT.REFUSED, locked.text);
      assert.ok(locked.lines.some((l) => l.startsWith("REFUSED") && l.includes("--snapshot")), locked.text);
      const snap = runTool(live, ["--snapshot", "--tmp-dir", snaps, "--json"]);
      assert.strictEqual(snap.code, tool.EXIT.OK, snap.text);
      assert.deepStrictEqual(snap.json.snapshot, { used: true, attempts: 1 });
      assert.strictEqual(snap.json.file, path.resolve(live), "the report names the live file, not the copy");
    });
    assert.deepStrictEqual(fs.readdirSync(snaps), [], "the lne-audit-* copy is removed");
    assert.strictEqual(sha256(live), before, "the live file is unchanged");
    assert.strictEqual(runTool(live, ["--integrity", "zly"]).code, tool.EXIT.USAGE);
  }));

  test(names[3], () => withTmp("lne-aw4-", (tmp, base) => {
    const dup = copyOf(base, tmp, "dup", (db) => {
      db.exec("CREATE TABLE j2 AS SELECT * FROM world_event_journal; DROP TABLE world_event_journal; "
        + "ALTER TABLE j2 RENAME TO world_event_journal;");
      for (const id of [100, 101]) {
        db.prepare("INSERT INTO world_event_journal (journal_id, idempotency_key, kind, aggregate_type, aggregate_id, "
          + "event_type, payload, payload_hash, state, created_at, applied_at) VALUES (?, 'twice:1', 'APPLY', 'test', "
          + "'a', 'TEST', '{}', ?, 'APPLIED', ?, ?)").run(id, HASH, NOW - H, NOW - H);
      }
    });
    const r = runTool(dup, ["--json"]);
    assert.strictEqual(r.code, tool.EXIT.FINDINGS, r.text);
    const f = byId(r.json).get("duplicateKeys");
    assert.strictEqual(f.count, 1, JSON.stringify(f));
    assert.deepStrictEqual(f.sample, ["world_event_journal.idempotency_key=twice:1"]);
    const errors = r.json.findings.filter((x) => x.severity === "ERROR" && x.count > 0).map((x) => x.id);
    assert.deepStrictEqual(errors, ["duplicateKeys"]);

    const newer = copyOf(base, tmp, "newer", (db) => {
      db.prepare("UPDATE lne_meta SET value = ? WHERE key = 'schema_version'").run(BigInt(LATEST_SCHEMA_VERSION + 1));
    });
    const n = runTool(newer, []);
    assert.strictEqual(n.code, tool.EXIT.REFUSED, n.text);
    assert.ok(n.text.includes("newer than the tool"), n.text);
  }));

  test(names[4], () => withTmp("lne-aw5-", (tmp, base) => {
    const file = copyOf(base, tmp, "w");
    const outA = path.join(tmp, "a.json");
    const a = runTool(file, ["--json", "--out", outA]);
    assert.strictEqual(a.code, tool.EXIT.OK, a.text);
    assert.strictEqual(a.json.formatVersion, 1);
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(outA, "utf8")), a.json, "--out = the --json report");
    const db = new driver.Database(file);
    try {
      for (const k of ["libkill:1", "libkill:2", "libkill:3"]) insertJournal(db, k, "LIBKILL", "kill", k, NOW);
    } finally {
      db.close();
    }
    const b = runTool(file, ["--json", "--now", String(NOW + H), "--baseline", outA]);
    assert.strictEqual(b.code, tool.EXIT.OK, b.text);
    assert.strictEqual(b.json.delta.hours, 1);
    assert.deepStrictEqual(b.json.delta.rows["journal.libkillApply"], { from: 0, to: 3, delta: 3, perHour: 3 });
    assert.deepStrictEqual(b.json.delta.rows["tables.world_event_journal"], { from: 1, to: 4, delta: 3, perHour: 3 });
    const outV2 = path.join(tmp, "v2.json");
    fs.writeFileSync(outV2, JSON.stringify({ ...a.json, formatVersion: 2 }));
    const bad = runTool(file, ["--baseline", outV2]);
    assert.strictEqual(bad.code, tool.EXIT.USAGE, bad.text);
  }));

  test(names[5], () => withTmp("lne-aw6-", (tmp, base) => {
    const snaps = path.join(tmp, "snaps");
    fs.mkdirSync(snaps);
    const calls = { opens: 0, integrity: 0 };
    class ThrowingDb extends driver.Database {
      constructor(file, options) {
        super(file, options);
        if (String(file).startsWith(snaps)) calls.opens += 1;
      }

      pragma(source, options) {
        if (String(source).startsWith("integrity_check")) {
          calls.integrity += 1;
          throw new Error("boom integrity");
        }
        return super.pragma(source, options);
      }
    }
    const lines = [];
    const code = tool.main({ argv: ["--db", base, "--snapshot", "--tmp-dir", snaps], env: {},
      driver: { ...driver, Database: ThrowingDb }, config: CONFIG, now: () => NOW, print: (l) => lines.push(l) });
    const text = lines.join("\n");
    assert.strictEqual(code, tool.EXIT.FAILED, text);
    assert.ok(lines.some((l) => l.startsWith("auditWorldDb: FAILED integrity: boom integrity")), text);
    assert.deepStrictEqual(calls, { opens: 1, integrity: 1 }, "one copy, no retry");
    assert.deepStrictEqual(fs.readdirSync(snaps), [], "the copy is removed");

    const neg = copyOf(base, tmp, "neg", INJECTIONS[0][2]);
    const b = runTool(neg, ["--snapshot", "--tmp-dir", snaps, "--json"]);
    assert.strictEqual(b.code, tool.EXIT.FINDINGS, b.text);
    assert.strictEqual(b.json.snapshot.attempts, 1, b.text);
    const bi = byId(b.json).get("integrity");
    assert.ok(bi.count >= 1 && bi.detail.checkScan === "done", JSON.stringify(bi));
    assert.deepStrictEqual(fs.readdirSync(snaps), []);

    const q = runTool(neg, ["--integrity", "quick", "--json"]);
    assert.strictEqual(q.code, tool.EXIT.FINDINGS, q.text);
    const qf = byId(q.json);
    assert.strictEqual(qf.get("integrity").detail.checkScan, "skipped");
    assert.strictEqual(qf.get("integrity").count, 0);
    assert.ok(qf.get("negativeResources").count >= 1, JSON.stringify(qf.get("negativeResources")));
  }));

  test(names[6], () => withTmp("lne-aw7-", (tmp, base) => {
    const file = copyOf(base, tmp, "doubled", strategyReviews(NOW + H, NOW + 2 * H));
    const r = runTool(file, ["--json"]);
    assert.strictEqual(r.code, tool.EXIT.FINDINGS, r.text);
    const f = byId(r.json).get("periodicChainsDoubled");
    assert.strictEqual(f.count, 1, JSON.stringify(f));
    assert.deepStrictEqual(f.sample,
      ["FACTION_STRATEGY_REVIEW:500001:strategy:review:500001:a|strategy:review:500001:b"]);

    const conv = copyOf(base, tmp, "converging", strategyReviews(NOW - H, NOW + H));
    const c = runTool(conv, ["--json"]);
    assert.strictEqual(c.code, tool.EXIT.OK, c.text);
    const cf = byId(c.json).get("periodicChainsConverging");
    assert.strictEqual(cf.severity, "INFO", JSON.stringify(cf));
    assert.strictEqual(cf.count, 1, JSON.stringify(cf));
    assert.deepStrictEqual(cf.sample,
      ["FACTION_STRATEGY_REVIEW:500001:strategy:review:500001:a|strategy:review:500001:b"]);
    assert.deepStrictEqual(byId(c.json).get("periodicChainsDoubled").sample, []);
  }));
};
