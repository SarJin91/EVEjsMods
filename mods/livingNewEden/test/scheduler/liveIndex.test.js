"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { findServerSrcOnDisk, GAMESTORE_SEARCH_MAX_DEPTH } = require("../../lib/adapter/locator");
const { resolveSqliteDriver } = require("../../lib/adapter/sqliteDriver");
const { MIGRATIONS, LATEST_SCHEMA_VERSION } = require("../../lib/persistence/migrations");
const { openStore } = require("../../lib/persistence/store");
const { createManualClock } = require("../../lib/util/clock");
const { createRng } = require("../../lib/util/rng");
const { createIdGenerator } = require("../../lib/util/ids");
const { createEventStore } = require("../../lib/scheduler/eventStore");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const START_MS = 1760000000000;
const ROLLBACK = new Error("li1-rollback");
const ROWS = Object.freeze([
  ["ev-q1", "QUEUED", 3, 500, 0], ["ev-q2", "QUEUED", 1, 900, 0], ["ev-q3", "QUEUED", 3, 100, 0],
  ["ev-r1", "RETRY", 3, 100, 1], ["ev-r2", "RETRY", 2, 50, 2], ["ev-r3", "RETRY", 1, 900, 1],
  ["ev-c1", "CLAIMED", 2, 300, 1], ["ev-c2", "CLAIMED", 1, 400, 5], ["ev-c3", "CLAIMED", 2, 200, 1],
  ["ev-x1", "QUARANTINED", 4, 10, 5], ["ev-x2", "QUARANTINED", 1, 20, 5], ["ev-x3", "QUARANTINED", 4, 5, 5],
  ["ev-d1", "DONE", 1, 1, 1], ["ev-d2", "DONE", 3, 100, 1], ["ev-d3", "DONE", 2, 50, 1],
]);

function loadDriver() {
  const found = findServerSrcOnDisk(MOD_DIR, GAMESTORE_SEARCH_MAX_DEPTH, fs.existsSync);
  if (!found.ok) return { ok: false, detail: found.reason };
  return resolveSqliteDriver(found.srcDir);
}

function open(driver, file, migrations) {
  const opened = openStore({ filePath: file, openDatabase: (f) => new driver.Database(f), exclusiveLock: true,
    busyTimeoutMs: 0, maxRowsPerTransaction: 500, maxWriteMsPerPass: 5, randomSeed: () => 1, migrations });
  assert.ok(opened.ok, JSON.stringify(opened));
  return opened;
}

function insertRows(db) {
  const ins = db.prepare(`INSERT INTO world_scheduled_events (event_id, idempotency_key, event_type, aggregate_type,
    aggregate_id, priority, due_at, payload, payload_hash, state, attempts, last_error, outcome, created_at,
    claimed_at, finished_at, version) VALUES (?, ?, 'STRATEGY_REVIEW', 'faction', '500019', ?, ?, '{}', ?, ?, ?, ?, ?,
    0, ?, ?, 1)`);
  for (const [id, state, priority, dueAt, attempts] of ROWS) {
    ins.run(id, `k:${id}`, priority, dueAt, "0".repeat(64), state, attempts,
      state === "QUARANTINED" ? "boom" : null, state === "DONE" ? "OK" : null,
      state === "CLAIMED" ? 1 : null, state === "DONE" || state === "QUARANTINED" ? 2 : null);
  }
}

function readAll(opened, events) {
  const r = opened.store.transaction("li1.read", (tx) => {
    const loaded = [];
    const load = events.loadOpen(tx, (...row) => loaded.push(row));
    return { load, loaded, count: events.countQuarantined(tx), list: events.listQuarantined(tx, 2),
      listAll: events.listQuarantined(tx, 10) };
  });
  assert.ok(r.ok, JSON.stringify(r));
  let recovered = null;
  const rb = opened.store.transaction("li1.recover", (tx) => {
    const res = events.recoverClaimed(tx, 2, START_MS);
    const rows = tx.prepare(`SELECT event_id, state, last_error FROM world_scheduled_events WHERE state <> 'DONE'
      ORDER BY event_id`).all().map((x) => ({ ...x }));
    recovered = { res, rows };
    throw ROLLBACK;
  });
  assert.strictEqual(rb.ok, false);
  return { ...r.value, recovered };
}

module.exports = ({ test, skip }) => {
  const driver = loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  needsDriver("LI1 migration 49 on a schema-48 database with rows in every state: state index dropped, live "
    + "index partial, rows untouched; loadOpen/recoverClaimed/countQuarantined/listQuarantined identical", () => {
    assert.ok(LATEST_SCHEMA_VERSION >= 49);
    assert.strictEqual(MIGRATIONS[48].name, "scheduled_events_live_index");
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lne-li1-"));
    const file = path.join(tmp, "world.sqlite");
    const clock = createManualClock(START_MS);
    const events = createEventStore({ clock, ids: createIdGenerator({ clock, rng: createRng(3) }),
      limits: { maxPayloadBytes: 4096, maxAttempts: 5, retryBaseMs: 1000, retryMaxMs: 60000 } });
    const dump = (opened) => {
      const r = opened.store.transaction("li1.dump", (tx) => tx.prepare(
        "SELECT * FROM world_scheduled_events ORDER BY event_id").all().map((x) => ({ ...x })));
      assert.ok(r.ok);
      return r.value;
    };
    const indexes = (opened) => {
      const r = opened.store.transaction("li1.idx", (tx) => tx.prepare("PRAGMA index_list(world_scheduled_events)")
        .all().map((x) => `${x.name}:${x.partial}`).sort());
      return r.value;
    };
    try {
      const old = open(driver, file, MIGRATIONS.slice(0, 48));
      assert.strictEqual(old.schemaVersion, 48);
      assert.ok(old.store.transaction("li1.seed", insertRows).ok);
      const before = readAll(old, events);
      const rowsBefore = dump(old);
      assert.ok(indexes(old).includes("world_scheduled_events_state:0"));
      old.store.close("li1");

      const cur = open(driver, file, MIGRATIONS.slice(0, 49));
      assert.deepStrictEqual([cur.schemaVersion, cur.applied], [49, 1]);
      const idx = indexes(cur);
      assert.ok(idx.includes("world_scheduled_events_live:1") && !idx.some((n) => n.startsWith(
        "world_scheduled_events_state:")), idx.join(","));
      assert.deepStrictEqual(dump(cur), rowsBefore);
      const after = readAll(cur, events);
      cur.store.close("li1");

      assert.deepStrictEqual(after, before);
      assert.deepStrictEqual(before.loaded.map((r) => r[0]), ["ev-q2", "ev-r3", "ev-r2", "ev-q3", "ev-r1", "ev-q1"]);
      assert.deepStrictEqual([before.count.count, before.list.events.map((e) => e.eventId)], [3, ["ev-x2", "ev-x3"]]);
      assert.deepStrictEqual(before.recovered.res, { ok: true, retried: 1, quarantined: 1 });
    } finally {
      try {
        fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      } catch (_err) {
      }
    }
  });
};
