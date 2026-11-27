"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { findServerSrcOnDisk, GAMESTORE_SEARCH_MAX_DEPTH } = require("../../lib/adapter/locator");
const { resolveSqliteDriver } = require("../../lib/adapter/sqliteDriver");
const { openStore } = require("../../lib/persistence/store");
const { seedDbFile } = require("../_support/dbTemplate");
const { createJournal } = require("../../lib/persistence/journal");
const { createManualClock } = require("../../lib/util/clock");
const { createRng } = require("../../lib/util/rng");
const { createIdGenerator } = require("../../lib/util/ids");
const { createViewRegistry } = require("../../lib/observer/views");
const { DeadlineQueue } = require("../../lib/scheduler/deadlineQueue");
const { createDueIndex } = require("../../lib/scheduler/dueIndex");
const { startScheduler } = require("../../lib/scheduler");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const START_MS = 1760000000000;
const SETTINGS = Object.freeze({ maxAttempts: 5, retryBaseMs: 1000, retryMaxMs: 600000, maxOpenEvents: 50000,
  maxPayloadBytes: 4096, intervalMs: 1000, sliceMs: 4, claimBatchSize: 8, catchUpLagMs: 60000, backlogCountCap: 4096, chainedHeadroom: 1000 });
const LIMITS = Object.freeze({ maxDueEventsPerPass: 64, maxSchedulerWorkMs: 8, maxCatchUpEventsPerPass: 32 });

function loadDriver() {
  const found = findServerSrcOnDisk(MOD_DIR, GAMESTORE_SEARCH_MAX_DEPTH, fs.existsSync);
  if (!found.ok) return { ok: false, detail: found.reason };
  return resolveSqliteDriver(found.srcDir);
}

function withStore(driver, fn, { fresh = false, onTiming, walPerTx } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lne-s-"));
  const file = path.join(tmp, "world.sqlite");
  const open = [];
  const reopen = () => {
    if (!fresh) seedDbFile(driver, file, { seed: 1 });
    const opened = openStore({ filePath: file, openDatabase: (f) => new driver.Database(f), exclusiveLock: true,
      busyTimeoutMs: 0, maxRowsPerTransaction: 500, maxWriteMsPerPass: 5, randomSeed: () => 1, onTiming, walPerTx });
    assert.ok(opened.ok, JSON.stringify(opened));
    open.push(opened.store);
    return opened.store;
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

function fakeTelemetry() {
  const counts = {};
  return { counts, count: (name, n) => { counts[name] = (counts[name] || 0) + n; }, gauge() {}, observe() {} };
}

function env(settings = SETTINGS) {
  const clock = createManualClock(START_MS);
  const ids = createIdGenerator({ clock, rng: createRng(1) });
  const telemetry = fakeTelemetry();
  const ticker = { t: 0, step: 0 };
  const config = { enabled: true, modules: { scheduler: { enabled: true } }, scheduler: { ...settings },
    limits: { ...LIMITS } };
  const start = (store, extra = {}) => {
    const r = startScheduler({ config, persistence: { ok: true, store }, clock, ids, telemetry,
      nowMs: () => { ticker.t += ticker.step; return ticker.t; }, ...extra });
    assert.ok(r.ok, JSON.stringify(r));
    return r.scheduler;
  };
  return { clock, telemetry, ticker, start };
}

const rows = (store, where = "1 = 1") => {
  const r = store.transaction("test", (db) => db.prepare(`SELECT * FROM world_scheduled_events WHERE ${where}`).all());
  assert.ok(r.ok, JSON.stringify(r));
  return r.value;
};

module.exports = ({ test, skip }) => {
  const driver = loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  needsDriver("S1 scheduler enqueue: same key twice -> one row + duplicate, other payload -> conflict", () => {
    withStore(driver, (reopen) => {
      const store = reopen();
      const { start, clock, telemetry } = env();
      const s = start(store);
      const now = clock.now();
      const first = s.enqueue("FLEET_ARRIVAL", "fleet_1", now + 100, { legSeq: 1 }, "arrival:fleet_1:1");
      assert.ok(first.ok && first.duplicate === false, JSON.stringify(first));
      const again = s.enqueue("FLEET_ARRIVAL", "fleet_1", now + 900, { legSeq: 1 }, "arrival:fleet_1:1");
      assert.deepStrictEqual([again.ok, again.duplicate, again.eventId, again.state],
        [true, true, first.event.eventId, "QUEUED"]);
      assert.strictEqual(rows(store).length, 1);
      const conflict = s.enqueue("FLEET_ARRIVAL", "fleet_1", now + 100, { legSeq: 2 }, "arrival:fleet_1:1");
      assert.deepStrictEqual([conflict.ok, conflict.reason], [false, "IDEMPOTENCY_CONFLICT"]);
      assert.strictEqual(rows(store).length, 1);
      assert.deepStrictEqual([telemetry.counts["scheduler.duplicates"], telemetry.counts["scheduler.conflicts"],
        telemetry.counts["scheduler.enqueued"]], [1, 1, 1]);
      const [row] = rows(store);
      assert.deepStrictEqual([row.priority, row.state, row.attempts, row.aggregate_type, row.version],
        [3, "QUEUED", 0, "fleet", 1]);
      assert.strictEqual(s.getStatus().open, 1);
    });
  });

  needsDriver("S1w: complete() labels scheduler.complete with the "
    + "event type of the claimed event (walPerTx on); off = no 7th argument", () => {
    for (const walPerTx of [true, false]) {
      const seen = [];
      withStore(driver, (reopen) => {
        const store = reopen();
        const { start, clock } = env();
        const s = start(store);
        const now = clock.now();
        const cur = s.enqueue("FLEET_ARRIVAL", "fleet_w", now, { legSeq: 1 }, "wal:1");
        assert.strictEqual(s.claimDue(now, 10, 1000).events.length, 1);
        assert.strictEqual(s.complete(cur.event.eventId, "OK").ok, true);
      }, { walPerTx, onTiming: (...args) => {
        if (args[0] === "scheduler.complete") seen.push(args);
      } });
      assert.strictEqual(seen.length, 1);
      if (walPerTx) assert.strictEqual(seen[0][6].label, "FLEET_ARRIVAL");
      else assert.strictEqual(seen[0].length, 6);
    }
  });

  needsDriver("S1c: a conflict logs one line (key, types, during) up to "
    + "scheduler.conflictLogLimit; a conflict in a complete() effect rolls it back as TX_ABORTED scheduler.complete "
    + "(not TX_FAILED); an effect throw stays TX_FAILED with its own error", () => {
    const outcomes = [];
    const failures = [];
    withStore(driver, (reopen) => {
      const store = reopen();
      const { start, clock, telemetry } = env({ ...SETTINGS, conflictLogLimit: 2 });
      const lines = [];
      const s = start(store, { logger: { log: (m) => lines.push(m) } });
      const now = clock.now();
      s.enqueue("FLEET_ARRIVAL", "fleet_1", now + 100, { legSeq: 1 }, "next:1");
      assert.strictEqual(s.enqueue("FLEET_ARRIVAL", "fleet_1", now, { legSeq: 9 }, "next:1").reason,
        "IDEMPOTENCY_CONFLICT");
      const cur = s.enqueue("FLEET_ARRIVAL", "fleet_2", now, { legSeq: 1 }, "cur:1");
      assert.strictEqual(s.claimDue(now, 10, 1000).events.length, 1);
      const c = s.complete(cur.event.eventId, "OK", (tx) =>
        s.enqueue("FLEET_ARRIVAL", "fleet_1", now + 100, { legSeq: 2 }, "next:1", { tx, chained: true }));
      assert.deepStrictEqual([c.ok, c.reason, c.refusal && c.refusal.reason],
        [false, "EFFECT_REFUSED", "IDEMPOTENCY_CONFLICT"]);
      assert.strictEqual(rows(store, `event_id = '${cur.event.eventId}'`)[0].state, "CLAIMED", "effect rolled back");
      s.enqueue("FLEET_ARRIVAL", "fleet_1", now, { legSeq: 3 }, "next:1");
      const logged = lines.filter((l) => l.startsWith("scheduler: idempotency conflict "));
      const first = rows(store, "idempotency_key = 'next:1'")[0].event_id;
      assert.deepStrictEqual(logged, [
        `scheduler: idempotency conflict key=next:1 eventType=FLEET_ARRIVAL aggregate=fleet_1 existing=${first} `
          + "FLEET_ARRIVAL fleet_1 QUEUED during=- - (1/2)",
        `scheduler: idempotency conflict key=next:1 eventType=FLEET_ARRIVAL aggregate=fleet_1 existing=${first} `
          + `FLEET_ARRIVAL fleet_1 QUEUED during=${cur.event.eventId} FLEET_ARRIVAL (2/2)`]);
      assert.strictEqual(telemetry.counts["scheduler.conflicts"], 3, "the counter keeps counting");
      assert.ok(outcomes.includes("scheduler.complete:TX_ABORTED"), outcomes.join(","));
      assert.ok(!outcomes.includes("scheduler.complete:TX_FAILED"), outcomes.join(","));
      const boom = s.complete(cur.event.eventId, "OK", (tx) => tx.prepare("SELECT * FROM no_such_table").all());
      assert.deepStrictEqual([boom.ok, boom.reason], [false, "EFFECT_FAILED"], JSON.stringify(boom));
      assert.ok(boom.detail.includes("no_such_table"), boom.detail);
      assert.strictEqual(rows(store, `event_id = '${cur.event.eventId}'`)[0].state, "CLAIMED", "rolled back");
      const failed = failures.filter((f) => f.name === "scheduler.complete");
      assert.deepStrictEqual([failed.length, failed[0].outcome], [1, "TX_FAILED"]);
      assert.ok(String(failed[0].failure && failed[0].failure.message).includes("no_such_table"),
        JSON.stringify(failed[0].failure));
    }, { onTiming: (name, ms, outcome, rows_, why, failure) => {
      outcomes.push(`${name}:${outcome}`);
      if (outcome === "TX_FAILED") failures.push({ name, outcome, failure });
    } });
  });

  needsDriver("S2 scheduler claimDue: only due, (priority, due_at) order, item and time budget, workClasses", () => {
    withStore(driver, (reopen) => {
      const store = reopen();
      const { start, clock, ticker } = env();
      const s = start(store);
      const now = clock.now();
      const add = (type, key, dueAt) => {
        const r = s.enqueue(type, key, dueAt, { k: key }, key);
        assert.ok(r.ok, JSON.stringify(r));
        return r.event.eventId;
      };
      const e1 = add("BATTLE_RESOLUTION", "b1", now - 10);
      const e2 = add("CONVOY_DELIVERY", "c1", now - 50);
      const e3 = add("FLEET_ARRIVAL", "f1", now - 100);
      const e4 = add("SITE_REFRESH", "s1", now - 200);
      add("FACTION_STRATEGY_REVIEW", "r1", now + 1000);
      add("BATTLE_RESOLUTION", "b2", now + 500);
      const first = s.claimDue(now, 3, 1000);
      assert.ok(first.ok, JSON.stringify(first));
      assert.deepStrictEqual(first.events.map((e) => e.eventId), [e2, e1, e3]);
      assert.strictEqual(first.stoppedBy, "items");
      assert.ok(first.events.every((e) => e.state === "CLAIMED" && e.attempts === 1 && e.dueAt <= now));

      const late = [add("FLEET_ARRIVAL", "f2", now - 5), add("FLEET_ARRIVAL", "f3", now - 4),
        add("FLEET_ARRIVAL", "f4", now - 3)];
      ticker.step = 10;
      const timed = s.claimDue(now, 10, 15);
      ticker.step = 0;
      assert.strictEqual(timed.stoppedBy, "time");
      assert.ok(timed.events.length >= 1 && timed.events.length <= 2, JSON.stringify(timed.events.length));
      assert.deepStrictEqual(timed.events.map((e) => e.eventId), late.slice(0, timed.events.length));

      const b3 = add("BATTLE_RESOLUTION", "b3", now - 1);
      const settle = s.claimDue(now, 10, 1000, { workClasses: ["SETTLEMENT"] });
      assert.deepStrictEqual(settle.events.map((e) => e.eventId), [b3]);
      assert.deepStrictEqual(s.claimDue(now, 10, 1000, { workClasses: ["NOPE"] }).reason, "SCHEDULER_INVALID_INPUT");

      const rest = s.claimDue(now, 10, 1000);
      assert.deepStrictEqual(rest.events.map((e) => e.eventId), [...late.slice(timed.events.length), e4]);
      assert.strictEqual(rest.stoppedBy, "empty");
      assert.deepStrictEqual(s.claimDue(now, 10, 1000).events, [], "future events never come early");
      assert.strictEqual(s.getStatus().inFlight, 8);
      assert.strictEqual(s.getStatus().nextDueAt, now + 500);
    });
  });

  needsDriver("S3 scheduler crash: CLAIMED comes back, DONE never; effect rolled back with the event", () => {
    withStore(driver, (reopen) => {
      const { start, clock } = env();
      const journal = createJournal({ clock, maxPayloadBytes: 4096, maxRows: 500 });
      let store = reopen();
      let s = start(store);
      const now = clock.now();
      const a = s.enqueue("FLEET_ARRIVAL", "fleet_a", now, { legSeq: 1 }, "arrival:a:1");
      const b = s.enqueue("FLEET_ARRIVAL", "fleet_b", now, { legSeq: 1 }, "arrival:b:1");
      assert.strictEqual(s.claimDue(now, 10, 1000).events.length, 2);
      assert.deepStrictEqual(s.complete(a.event.eventId, "OK"), { ok: true, alreadyDone: false, value: undefined });
      assert.strictEqual(s.complete(a.event.eventId, "OK").alreadyDone, true);
      store.close("crash");

      store = reopen();
      s = start(store);
      assert.deepStrictEqual(s.getStatus().recovered, { retried: 1, quarantined: 0 });
      const back = s.claimDue(clock.now(), 10, 1000);
      assert.deepStrictEqual(back.events.map((e) => [e.eventId, e.attempts, e.lastError]),
        [[b.event.eventId, 2, "CLAIM_INTERRUPTED"]]);
      const dupA = s.enqueue("FLEET_ARRIVAL", "fleet_a", now + 5, { legSeq: 1 }, "arrival:a:1");
      assert.deepStrictEqual([dupA.duplicate, dupA.state], [true, "DONE"]);
      assert.deepStrictEqual(s.claimDue(clock.now() + 1e6, 10, 1000).events, [], "A never comes back");

      const spec = { key: "effect:b:1", aggregate: { type: "fleet", id: "fleet_b" }, eventType: "FLEET_ARRIVED",
        payload: { legSeq: 1 } };
      const failed = s.complete(b.event.eventId, "OK", (tx) => {
        assert.ok(journal.applyOnce(tx, spec, () => ({ ok: true })).ok);
        throw new Error("handler boom");
      });
      assert.deepStrictEqual([failed.ok, failed.reason, failed.detail], [false, "EFFECT_FAILED", "handler boom"]);
      const refused = s.complete(b.event.eventId, "OK", () => ({ ok: false, reason: "NOT_NOW" }));
      assert.deepStrictEqual([refused.reason, refused.refusal.reason], ["EFFECT_REFUSED", "NOT_NOW"]);
      assert.strictEqual(rows(store, `event_id = '${b.event.eventId}'`)[0].state, "CLAIMED");
      const seen = store.transaction("test", (tx) => journal.findByKey(tx, spec.key)).value;
      assert.strictEqual(seen.found, false, "effect not written");

      const done = s.complete(b.event.eventId, "OK", (tx, event) => {
        const next = s.enqueue("FLEET_ARRIVAL", event.aggregateId, now, { legSeq: 2 }, "arrival:b:2", { tx });
        assert.strictEqual(s.getStatus().open, 0, "buffered until commit");
        return next;
      });
      assert.deepStrictEqual([done.ok, done.value.duplicate], [true, false]);
      assert.strictEqual(s.getStatus().open, 1);
      assert.deepStrictEqual(s.claimDue(clock.now(), 10, 1000).events.map((e) => e.idempotencyKey), ["arrival:b:2"]);
    });
  });

  needsDriver("S4 scheduler retryOrQuarantine: attempts, exponential due, QUARANTINED, counter, panel", () => {
    withStore(driver, (reopen) => {
      const { start, clock, telemetry } = env({ ...SETTINGS, maxAttempts: 3 });
      let store = reopen();
      const views = createViewRegistry();
      let s = start(store, { views });
      const x = s.enqueue("SUPPLY_RECHECK", 500001, clock.now(), {}, "supply:500001:1");
      const delays = [];
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const claimed = s.claimDue(clock.now(), 10, 1000);
        assert.deepStrictEqual(claimed.events.map((e) => e.attempts), [attempt]);
        const r = s.retryOrQuarantine(x.event.eventId, new Error(`boom ${attempt}`));
        assert.strictEqual(r.attempts, attempt);
        if (attempt < 3) {
          assert.strictEqual(r.state, "RETRY");
          delays.push(r.dueAt - clock.now());
          assert.deepStrictEqual(s.claimDue(clock.now(), 10, 1000).events, [], "not before its due time");
          clock.set(r.dueAt);
        } else {
          assert.strictEqual(r.state, "QUARANTINED");
        }
      }
      assert.deepStrictEqual(delays, [1000, 2000]);
      const [row] = rows(store);
      assert.deepStrictEqual([row.state, row.last_error, row.attempts], ["QUARANTINED", "boom 3", 3]);
      assert.strictEqual(telemetry.counts["scheduler.quarantined"], 1);
      assert.deepStrictEqual(s.claimDue(clock.now() + 1e9, 10, 1000).events, []);

      const y = s.enqueue("SUPPLY_RECHECK", 500002, clock.now(), {}, "supply:500002:1");
      s.claimDue(clock.now(), 10, 1000);
      const permanent = s.retryOrQuarantine(y.event.eventId, "bad input", { permanent: true });
      assert.deepStrictEqual([permanent.state, permanent.attempts], ["QUARANTINED", 1]);
      const panel = views.getView("scheduler").getData();
      assert.deepStrictEqual([panel.available, panel.quarantined.count], [true, 2]);

      store.close("restart");
      store = reopen();
      s = start(store);
      assert.deepStrictEqual([s.getStatus().open, s.getStatus().recovered.quarantined], [0, 0]);
      assert.deepStrictEqual(s.claimDue(clock.now() + 1e9, 10, 1000).events, []);
      s.stop("test");
      assert.strictEqual(s.claimDue(clock.now(), 1, 1).reason, "SCHEDULER_STOPPED");
    });
  });

  test("S5 dueIndex: 10 000 due entries, popDue(64) compares O(budget log n), not O(n)", () => {
    const index = createDueIndex();
    for (let i = 0; i < 10000; i += 1) {
      index.add(`event_${String(i).padStart(5, "0")}`, (i % 5) + 1, i, "FLEET_ARRIVAL");
    }
    const original = DeadlineQueue.prototype._compare;
    let compares = 0;
    DeadlineQueue.prototype._compare = function counted(left, right) {
      compares += 1;
      return original.call(this, left, right);
    };
    let popped;
    try {
      popped = index.popDue(1e9, { maxItems: 64 });
    } finally {
      DeadlineQueue.prototype._compare = original;
    }
    assert.strictEqual(popped.entries.length, 64);
    assert.strictEqual(popped.stoppedBy, "items");
    assert.ok(popped.entries.every((e, i) => e.priority === 1 && e.dueAt === i * 5), "priority 1 by due time");
    assert.ok(compares < 64 * 4 * Math.ceil(Math.log2(10000)), `compares=${compares}`);
    assert.strictEqual(index.size(), 10000 - 64);
  });

  needsDriver("S6 scheduler: unknown type / bad dueAt refused, nothing written; QUEUE_FULL only for 3-5", () => {
    withStore(driver, (reopen) => {
      const store = reopen();
      const { start, clock } = env({ ...SETTINGS, maxOpenEvents: 1 });
      const s = start(store);
      const now = clock.now();
      assert.deepStrictEqual(s.enqueue("NOPE", "x", now, {}, "nope:1"),
        { ok: false, reason: "UNKNOWN_EVENT_TYPE", eventType: "NOPE" });
      for (const dueAt of [-1, 1.5]) {
        assert.strictEqual(s.enqueue("FLEET_ARRIVAL", "f", dueAt, {}, `bad:${dueAt}`).reason,
          "SCHEDULER_INVALID_INPUT");
      }
      assert.strictEqual(rows(store).length, 0);
      assert.ok(s.enqueue("FLEET_ARRIVAL", "f", now, {}, "a:1").ok);
      assert.deepStrictEqual(s.enqueue("SITE_REFRESH", 30000142, now, {}, "site:1"),
        { ok: false, reason: "QUEUE_FULL", limit: 1 });
      assert.ok(s.enqueue("BATTLE_RESOLUTION", "battle_1", now, {}, "battle:1").ok, "settlements always accepted");
      assert.strictEqual(rows(store).length, 2);
    });
  });
};
