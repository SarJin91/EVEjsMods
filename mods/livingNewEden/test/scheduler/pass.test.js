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
const { ADMISSION, WORK_CLASS_ORDER } = require("../../lib/telemetry/loadGovernor");
const { defaultSetTimer } = require("../../lib/scheduler/driver");
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

async function withStore(driver, fn, { fresh = false } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lne-p-"));
  const file = path.join(tmp, "world.sqlite");
  const open = [];
  const reopen = () => {
    if (!fresh) seedDbFile(driver, file, { seed: 1 });
    const opened = openStore({ filePath: file, openDatabase: (f) => new driver.Database(f), exclusiveLock: true,
      busyTimeoutMs: 0, maxRowsPerTransaction: 500, maxWriteMsPerPass: 5, randomSeed: () => 1 });
    assert.ok(opened.ok, JSON.stringify(opened));
    open.push(opened.store);
    return opened.store;
  };
  try {
    return await fn(reopen);
  } finally {
    for (const s of open) s.close("test_cleanup");
    try {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch (_err) {
    }
  }
}

function env(opts = {}) {
  const clock = createManualClock(START_MS);
  const ids = createIdGenerator({ clock, rng: createRng(1) });
  const counts = {};
  const gauges = {};
  const gaugeLog = [];
  const observed = {};
  const telemetry = { counts, count: (name, n) => { counts[name] = (counts[name] || 0) + n; },
    gauge: (name, value) => {
      gauges[name] = value;
      gaugeLog.push([name, value]);
    },
    observe: (name, value) => {
      (observed[name] = observed[name] || []).push(value);
    } };
  const lines = [];
  const logger = { lines, log: (line) => lines.push(line) };
  const config = { enabled: true, modules: { scheduler: { enabled: opts.enabled !== false } },
    scheduler: { ...SETTINGS, ...(opts.settings || {}) }, limits: { ...LIMITS, ...(opts.limits || {}) } };
  const start = (store, extra = {}) => startScheduler({ config, persistence: { ok: true, store }, clock, ids,
    telemetry, logger, nowMs: () => 0, ...extra });
  const startOk = (store, extra) => {
    const r = start(store, extra);
    assert.ok(r.ok, JSON.stringify(r));
    return r.scheduler;
  };
  return { clock, counts, gauges, gaugeLog, observed, lines, start, startOk };
}

const LATENESS_ON = Object.freeze({ latenessDetail: true, latenessSlowMs: 5000, latenessTopTypes: 12 });
const LATENESS_NEW_NAME = /^scheduler\.(lateness\.|stoppedBy\.|oldestDueAgeMs$)/;

const rows = (store, where = "1 = 1") => {
  const r = store.transaction("test", (db) => db.prepare(`SELECT * FROM world_scheduled_events WHERE ${where}
    ORDER BY due_at, event_id`).all());
  assert.ok(r.ok, JSON.stringify(r));
  return r.value;
};

function policyOf(mode, budgetMs, maxJobs) {
  const classes = {};
  for (const wc of WORK_CLASS_ORDER) {
    const admitted = ADMISSION[mode].includes(wc);
    classes[wc] = { admitted, budgetMs: admitted ? budgetMs : 0, maxJobs: admitted ? maxJobs : 0 };
  }
  return { mode, phase: mode.toLowerCase(), reason: "test", budgetMs, maxJobs, classes };
}

const drain = async () => {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

module.exports = ({ test, skip }) => {
  const driver = loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  needsDriver("P1 scheduler pass: 100 late events, catch-up 10 per pass -> 10 passes in due order", async () => {
    await withStore(driver, async (reopen) => {
      const store = reopen();
      const { startOk, clock } = env({ limits: { maxCatchUpEventsPerPass: 10, maxDueEventsPerPass: 64 } });
      const s = startOk(store);
      for (let i = 0; i < 100; i += 1) {
        const r = s.enqueue("FLEET_ARRIVAL", `fleet_${i}`, START_MS - 3600000 + i, { i }, `arrival:${i}`);
        assert.ok(r.ok, JSON.stringify(r));
      }
      const seen = [];
      assert.ok(s.registerHandler("FLEET_ARRIVAL", (ev, hctx) => {
        assert.strictEqual(hctx.catchUp, true);
        seen.push(ev.dueAt);
        return { ok: true };
      }).ok);
      assert.strictEqual(clock.now(), START_MS);
      for (let pass = 0; pass < 10; pass += 1) {
        const r = await s.runPass();
        assert.deepStrictEqual([r.ok, r.skipped, r.catchUp, r.jobs, r.done, r.stoppedBy],
          [true, false, true, 10, 10, "items"], JSON.stringify(r));
      }
      assert.strictEqual(seen.length, 100);
      assert.ok(seen.every((at, i) => i === 0 || seen[i - 1] <= at), "non-decreasing due_at");
      assert.strictEqual(rows(store, "state = 'DONE'").length, 100);
      const last = await s.runPass();
      assert.deepStrictEqual([last.jobs, last.stoppedBy, last.catchUp], [0, "empty", false]);
    });
  });

  needsDriver("P2 scheduler pass: handler throws -> RETRY, the other events of the pass DONE; P2b", async () => {
    await withStore(driver, async (reopen) => {
      const store = reopen();
      const { startOk, clock, counts } = env();
      const s = startOk(store);
      const keys = [];
      for (let i = 0; i < 5; i += 1) {
        keys.push(s.enqueue("FLEET_ARRIVAL", `fleet_${i}`, clock.now() - 10 + i, {}, `arrival:${i}`).event.eventId);
      }
      let calls = 0;
      s.registerHandler("FLEET_ARRIVAL", () => {
        calls += 1;
        if (calls === 2) throw new Error("handler boom");
        return { ok: true, outcome: "ARRIVED" };
      });
      const r = await s.runPass();
      assert.deepStrictEqual([r.jobs, r.done, r.retried, r.stoppedBy], [5, 4, 1, "empty"], JSON.stringify(r));
      const failed = rows(store, `event_id = '${keys[1]}'`)[0];
      assert.deepStrictEqual([failed.state, failed.attempts, failed.last_error], ["RETRY", 1, "handler boom"]);
      assert.strictEqual(rows(store, "state = 'DONE' AND outcome = 'ARRIVED'").length, 4);
      assert.strictEqual(counts["scheduler.handlerErrors"], 1);

      const journal = createJournal({ clock, maxPayloadBytes: 4096, maxRows: 500 });
      const x = s.enqueue("SUPPLY_RECHECK", 500001, clock.now(), {}, "supply:500001:1");
      assert.strictEqual(s.claimDue(clock.now(), 10, 1000, { workClasses: ["OPERATIONAL"] }).events.length, 1);
      const spec = { key: "effect:x:1", aggregate: { type: "faction", id: "500001" }, eventType: "SUPPLY_CHECKED",
        payload: {} };
      const c = s.complete(x.event.eventId, "OK", (tx, ev) => {
        assert.ok(journal.applyOnce(tx, spec, () => ({ ok: true })).ok);
        tx.prepare("UPDATE world_scheduled_events SET state = 'DONE', finished_at = 1, outcome = 'X'"
          + " WHERE event_id = ?").run(ev.eventId);
        return { ok: true };
      });
      assert.deepStrictEqual(c, { ok: false, reason: "EVENT_STATE_INVALID", detail: "effect_rolled_back" });
      assert.strictEqual(store.transaction("test", (tx) => journal.findByKey(tx, spec.key)).value.found, false);
      assert.strictEqual(rows(store, `event_id = '${x.event.eventId}'`)[0].state, "CLAIMED");
    });
  });

  needsDriver("P3 scheduler pass: OVERLOADED claims SETTLEMENT only, emergency delta skips one pass", async () => {
    await withStore(driver, async (reopen) => {
      const store = reopen();
      const { startOk, clock } = env();
      const gov = { policy: policyOf("OVERLOADED", 0.25, 1), n: 3 };
      const s = startOk(store, { getGovernor: () => ({ evaluate: (arg) => {
        assert.strictEqual(arg, undefined, "evaluate() without an argument");
        return gov.policy;
      }, getStatus: () => ({ counts: { emergencySamples: gov.n } }) }) });
      const battle = s.enqueue("BATTLE_RESOLUTION", "battle_1", clock.now(), {}, "battle:1").event.eventId;
      const review = s.enqueue("FACTION_STRATEGY_REVIEW", 500001, clock.now(), {}, "review:1").event.eventId;
      const handled = [];
      for (const type of ["BATTLE_RESOLUTION", "FACTION_STRATEGY_REVIEW"]) {
        s.registerHandler(type, (ev) => {
          handled.push(ev.eventType);
          return { ok: true };
        });
      }
      const first = await s.runPass();
      assert.deepStrictEqual([first.mode, first.jobs, first.done], ["OVERLOADED", 1, 1], JSON.stringify(first));
      assert.strictEqual(rows(store, `event_id = '${battle}'`)[0].state, "DONE");
      const waiting = rows(store, `event_id = '${review}'`)[0];
      assert.deepStrictEqual([waiting.state, waiting.attempts], ["QUEUED", 0]);

      gov.policy = policyOf("NORMAL", 8, 64);
      gov.n += 1;
      const skipped = await s.runPass();
      assert.deepStrictEqual(skipped, { ok: true, skipped: true, reason: "emergency_since_last_pass", mode: "NORMAL" });
      assert.strictEqual(rows(store, `event_id = '${review}'`)[0].state, "QUEUED");
      const next = await s.runPass();
      assert.deepStrictEqual([next.skipped, next.done], [false, 1]);
      assert.deepStrictEqual(handled, ["BATTLE_RESOLUTION", "FACTION_STRATEGY_REVIEW"]);
    });
  });

  needsDriver("P4 scheduler pass: crash after the effect, before complete -> handler again, effect once", async () => {
    await withStore(driver, async (reopen) => {
      const { startOk, clock } = env();
      const journal = createJournal({ clock, maxPayloadBytes: 4096, maxRows: 500 });
      const spec = { key: "arrival:f1:1:world:30000142", aggregate: { type: "fleet", id: "f1" },
        eventType: "FLEET_ARRIVED", payload: { systemId: 30000142 } };
      let store = reopen();
      let s = startOk(store);
      const ev = s.enqueue("FLEET_ARRIVAL", "f1", clock.now(), { legSeq: 1 }, "arrival:f1:1").event;
      assert.strictEqual(s.claimDue(clock.now(), 10, 1000).events.length, 1);
      const before = store.transaction("effect", (tx) => journal.applyOnce(tx, spec, () => ({ ok: true })));
      assert.deepStrictEqual([before.ok, before.value.duplicate], [true, false]);
      store.close("crash");

      store = reopen();
      s = startOk(store);
      assert.deepStrictEqual(s.getStatus().recovered, { retried: 1, quarantined: 0 });
      const effects = [];
      s.registerHandler("FLEET_ARRIVAL", () => {
        const r = store.transaction("handler", (tx) => journal.applyOnce(tx, spec, () => ({ ok: true })));
        effects.push(r.value.duplicate);
        return { ok: true };
      });
      const r = await s.runPass();
      assert.deepStrictEqual([r.done, effects], [1, [true]]);
      const count = store.transaction("test", (db) => db.prepare(
        "SELECT count(*) AS n FROM world_event_journal WHERE idempotency_key = ?").get(spec.key).n);
      assert.strictEqual(count.value, 1);
      assert.strictEqual(rows(store, `event_id = '${ev.eventId}'`)[0].state, "DONE");
    });
  });

  needsDriver("P5 scheduler driver: disabled -> no timer; unref'd timer, stop cancels; suspended store", async () => {
    await withStore(driver, async (reopen) => {
      const store = reopen();
      const calls = [];
      const spy = (fn, ms) => {
        const handle = defaultSetTimer(fn, ms);
        const entry = { fn, ms, handle, cancelled: false };
        calls.push(entry);
        return { cancel: () => { entry.cancelled = true; handle.cancel(); }, hasRef: handle.hasRef };
      };
      const off = env({ enabled: false }).start(store, { setTimer: spy });
      assert.deepStrictEqual([off.ok, off.reason, calls.length], [false, "disabled_by_config", 0]);

      const a = env().startOk(store, { setTimer: spy });
      assert.strictEqual(calls.length, 0, "no timer before startPasses");
      assert.deepStrictEqual(a.startPasses(), { ok: true });
      assert.deepStrictEqual([calls.length, calls[0].ms, calls[0].handle.hasRef()], [1, 1000, false]);
      assert.strictEqual(a.startPasses().reason, "already_started");
      a.stop("test");
      assert.strictEqual(calls[0].cancelled, true);
      assert.strictEqual(a.startPasses().reason, "SCHEDULER_STOPPED");

      const fired = [];
      const manual = (fn, ms) => {
        fired.push({ fn, ms });
        return { cancel() {}, hasRef: () => false };
      };
      const e = env();
      const b = e.startOk(store, { setTimer: manual });
      b.startPasses();
      store.suspend("TEST");
      fired[0].fn();
      await drain();
      const st = b.getStatus().driver;
      assert.deepStrictEqual([st.state, st.reason, fired.length], ["suspended", "STORE_SUSPENDED", 1]);
      assert.ok(e.lines.includes("scheduler: passes suspended - STORE_SUSPENDED (TEST)"), e.lines.join("|"));
    });
  });

  needsDriver("P6 scheduler pass: type without a handler is parked (QUEUED, attempts 0), handler releases it",
    async () => {
      await withStore(driver, async (reopen) => {
        const store = reopen();
        const { startOk, clock } = env();
        const s = startOk(store);
        const id = s.enqueue("SITE_REFRESH", 30000142, clock.now(), {}, "site:30000142:1").event.eventId;
        const first = await s.runPass();
        assert.deepStrictEqual([first.jobs, first.parkedNew], [0, 1], JSON.stringify(first));
        const row = rows(store, `event_id = '${id}'`)[0];
        assert.deepStrictEqual([row.state, row.attempts], ["QUEUED", 0]);
        assert.deepStrictEqual(s.getStatus().parked, { SITE_REFRESH: 1 });
        assert.strictEqual(s.getStatus().open, 1);
        assert.ok(s.registerHandler("SITE_REFRESH", () => ({ ok: true })).ok);
        assert.deepStrictEqual(s.getStatus().parked, {});
        const next = await s.runPass();
        assert.strictEqual(next.done, 1);
        assert.strictEqual(rows(store, `event_id = '${id}'`)[0].state, "DONE");
      });
    });

  needsDriver("P-BK scheduler gauges: dueBacklog/catchUpBacklog/parked before and after a pass (handled, parked, "
    + "future rows); backlogCountCap 2 -> capped, 0 -> no backlog gauges", async () => {
    const HOUR = 3600000;
    const T_A = "FLEET_ARRIVAL";
    const scene = async (settings) => {
      let out = null;
      await withStore(driver, async (reopen) => {
        const store = reopen();
        const e = env({ settings });
        const s = e.startOk(store);
        const now = e.clock.now();
        for (let i = 0; i < 3; i += 1) assert.ok(s.enqueue(T_A,`a_${i}`, now, {}, `a:${i}`).ok);
        assert.ok(s.enqueue(T_A,"a_late", now - SETTINGS.catchUpLagMs - 1, {}, "a:late").ok);
        assert.ok(s.enqueue("SITE_REFRESH", 30000142, now, {}, "site:30000142:1").ok);
        assert.ok(s.enqueue(T_A,"a_future", now + HOUR, {}, "a:future").ok);
        let handled = 0;
        assert.ok(s.registerHandler(T_A, () => {
          handled += 1;
          return { ok: true };
        }).ok);
        const from = e.gaugeLog.length;
        const r = await s.runPass();
        assert.ok(r.ok && !r.skipped, JSON.stringify(r));
        const pass = e.gaugeLog.slice(from).filter(([name]) => ["scheduler.parked", "scheduler.dueBacklog",
          "scheduler.catchUpBacklog"].includes(name));
        out = { pass, handled, parkedNew: r.parkedNew, parked: s.getStatus().parked };
      });
      return out;
    };

    const full = await scene({});
    assert.deepStrictEqual(full.pass, [
      ["scheduler.parked", 0], ["scheduler.dueBacklog", 5], ["scheduler.catchUpBacklog", 1],
      ["scheduler.parked", 1], ["scheduler.dueBacklog", 0], ["scheduler.catchUpBacklog", 0],
    ], JSON.stringify(full));
    assert.deepStrictEqual([full.handled, full.parkedNew, full.parked], [4, 1, { SITE_REFRESH: 1 }]);

    const capped = await scene({ backlogCountCap: 2 });
    assert.deepStrictEqual(capped.pass.slice(0, 3), [
      ["scheduler.parked", 0], ["scheduler.dueBacklog", 2], ["scheduler.catchUpBacklog", 1],
    ], JSON.stringify(capped));

    const off = await scene({ backlogCountCap: 0 });
    assert.deepStrictEqual(off.pass, [["scheduler.parked", 0], ["scheduler.parked", 1]], JSON.stringify(off));
  });

  needsDriver("P7 (B2) periodic anchor: 2 h late periodic -> anchorAt=now, fact -> dueAt; catch-up episode",
    async () => {
      await withStore(driver, async (reopen) => {
        const store = reopen();
        const { startOk, clock, counts, lines } = env();
        const s = startOk(store);
        const late = clock.now() - 2 * 3600000;
        s.enqueue("SUPPLY_RECHECK", 500001, late, {}, "supply:1");
        s.enqueue("FLEET_ARRIVAL", "fleet_1", late, {}, "arrival:1");
        const seen = {};
        for (const type of ["SUPPLY_RECHECK", "FLEET_ARRIVAL"]) {
          s.registerHandler(type, (ev, hctx) => {
            seen[ev.eventType] = { anchorAt: hctx.anchorAt, dueAt: ev.dueAt };
            return { ok: true };
          });
        }
        const r = await s.runPass();
        assert.deepStrictEqual([r.catchUp, r.done], [true, 2], JSON.stringify(r));
        assert.deepStrictEqual(seen, { SUPPLY_RECHECK: { anchorAt: clock.now(), dueAt: late },
          FLEET_ARRIVAL: { anchorAt: late, dueAt: late } });
        assert.strictEqual(counts["scheduler.periodicCoalesced"], 1);
        assert.strictEqual(s.getStatus().catchUp.active, true);
        await s.runPass();
        const st = s.getStatus().catchUp;
        assert.deepStrictEqual([st.active, st.episodes, st.lastEpisode.passes, st.lastEpisode.events,
          st.lastEpisode.maxPerPass], [false, 1, 1, 2, 2], JSON.stringify(st));
        assert.ok(lines.includes("scheduler: catch-up start lag=7200000 backlog=2"), lines.join("|"));
        assert.ok(lines.includes("scheduler: catch-up done passes=1 events=2 maxPerPass=2 in 0ms"), lines.join("|"));

        const near = clock.now() - 1000;
        s.enqueue("SUPPLY_RECHECK", 500001, near, {}, "supply:2");
        s.enqueue("FLEET_ARRIVAL", "fleet_1", near, {}, "arrival:2");
        await s.runPass();
        assert.deepStrictEqual([seen.SUPPLY_RECHECK.anchorAt, seen.FLEET_ARRIVAL.anchorAt], [near, near]);
        assert.strictEqual(counts["scheduler.periodicCoalesced"], 1);
      });
    });

  needsDriver("T4 scheduler pass D-d: adaptive claim batch stops the pass within ~1 event of the write limit",
    async () => {
      for (const [adaptive, expectedJobs] of [[true, 5], [false, 8]]) {
        await withStore(driver, async (reopen) => {
          const store = reopen();
          let t = 0;
          const e = env({ settings: { adaptiveClaimBatch: adaptive, costEwmaInitialMs: 1, costEwmaAlpha: 0.2 },
            limits: { maxSchedulerWorkMs: 50 } });
          const s = e.startOk(store, { nowMs: () => t });
          for (let i = 0; i < 40; i += 1) {
            assert.ok(s.enqueue("FLEET_ARRIVAL", `fleet_${i}`, START_MS - 1000 + i, { i }, `a:${i}`).ok);
          }
          assert.ok(s.registerHandler("FLEET_ARRIVAL", () => ({ ok: true, effect: () => {
            t += 1;
            return { ok: true };
          } })).ok);
          const r = await s.runPass();
          assert.ok(r.ok && !r.skipped, JSON.stringify(r));
          assert.deepStrictEqual([r.jobs, r.stoppedBy], [expectedJobs, "write"], JSON.stringify(r));
          if (adaptive) assert.ok(r.jobs <= 5 + 1, "overrun of at most one event");
          assert.strictEqual(rows(store, "state = 'CLAIMED'").length, 0, "nothing left CLAIMED");
          assert.strictEqual(rows(store, "state = 'DONE'").length, expectedJobs);
        });
      }
    });
  needsDriver("T4 scheduler: maxPerPass 10 of 50 battles -> 5 passes, p3 in pass 1, attempts 1; permanent "
    + "effect refusal -> QUARANTINED after 1 attempt; onCommitted once after commit, never after a refusal", async () => {
    await withStore(driver, async (reopen) => {
      const store = reopen();
      const { startOk, clock, counts } = env();
      const s = startOk(store);
      for (let i = 0; i < 50; i += 1) {
        assert.ok(s.enqueue("BATTLE_RESOLUTION", `battle_${i}`, clock.now(), { i }, `b:${i}`).ok);
      }
      assert.ok(s.enqueue("FLEET_ARRIVAL", "fleet_x", clock.now(), {}, "arr:x").ok);
      assert.deepStrictEqual(s.registerHandler("BATTLE_RESOLUTION", () => ({ ok: true }), { maxPerPass: 0 }),
        { ok: false, reason: "INVALID_HANDLER" });
      let battles = 0;
      let arrivals = 0;
      assert.ok(s.registerHandler("BATTLE_RESOLUTION", () => {
        battles += 1;
        return { ok: true };
      }, { maxPerPass: 10 }).ok);
      assert.ok(s.registerHandler("FLEET_ARRIVAL", () => {
        arrivals += 1;
        return { ok: true };
      }).ok);
      const perPass = [];
      for (let pass = 0; pass < 6; pass += 1) {
        const before = battles;
        const r = await s.runPass();
        assert.ok(r.ok && !r.skipped, JSON.stringify(r));
        perPass.push(battles - before);
        if (pass === 0) assert.strictEqual(arrivals, 1, "p3 event in the first pass");
      }
      assert.deepStrictEqual(perPass, [10, 10, 10, 10, 10, 0]);
      const done = rows(store, "event_type = 'BATTLE_RESOLUTION'");
      assert.ok(done.every((row) => row.state === "DONE" && row.attempts === 1), "no attempt used by the limit");
      assert.ok(counts["scheduler.quotaHeld"] >= 4, JSON.stringify(counts));

      assert.ok(s.enqueue("SITE_REFRESH", 1, clock.now(), {}, "site:perm").ok);
      assert.ok(s.enqueue("SITE_REFRESH", 2, clock.now(), {}, "site:temp").ok);
      assert.ok(s.enqueue("WRECK_FIELD_EXPIRE", "wf:1", clock.now(), {}, "wf:ok").ok);
      assert.ok(s.enqueue("WRECK_FIELD_EXPIRE", "wf:2", clock.now(), {}, "wf:no").ok);
      assert.ok(s.registerHandler("SITE_REFRESH", (ev) => ({ ok: true, effect: () => ({ ok: false, reason: "NOPE",
        permanent: ev.idempotencyKey === "site:perm" }) })).ok);
      const committed = [];
      assert.ok(s.registerHandler("WRECK_FIELD_EXPIRE", (ev) => ({ ok: true,
        effect: () => (ev.idempotencyKey === "wf:ok" ? { ok: true, tag: ev.idempotencyKey } : { ok: false, reason: "X" }),
        onCommitted: (v) => committed.push(v.tag) })).ok);
      await s.runPass();
      const st = (key) => rows(store, `idempotency_key = '${key}'`)[0];
      assert.deepStrictEqual([st("site:perm").state, st("site:perm").attempts], ["QUARANTINED", 1]);
      assert.strictEqual(st("site:temp").state, "RETRY");
      assert.deepStrictEqual(committed, ["wf:ok"]);
      assert.strictEqual(st("wf:no").state, "RETRY");
    });
  });

  needsDriver("A1 scheduler: {ok:false, deferUntil} -> RETRY at deferUntil (clamp retryMaxMs), attempts "
    + "returned, never QUARANTINED past maxAttempts; deferUntil < now / not an integer -> ordinary retry", async () => {
    await withStore(driver, async (reopen) => {
      const store = reopen();
      const { startOk, clock, counts } = env({ settings: { maxAttempts: 3 } });
      const s = startOk(store);
      const id = s.enqueue("FLEET_ARRIVAL", "fleet_d", clock.now(), {}, "arrival:fleet_d:1").event.eventId;
      let next = null;
      assert.ok(s.registerHandler("FLEET_ARRIVAL", () => ({ ok: false, reason: "X", ...next() })).ok);
      const row = () => rows(store, `event_id = '${id}'`)[0];
      const seen = [];
      for (let pass = 0; pass < 5; pass += 1) {
        const far = pass === 4;
        const until = clock.now() + (far ? 10 * SETTINGS.retryMaxMs : 1000);
        next = () => ({ deferUntil: until, permanent: true });
        const before = row().attempts;
        const r = await s.runPass();
        const after = row();
        seen.push([before, r.retried, after.state, after.attempts, after.due_at - clock.now(), after.last_error]);
        clock.set(after.due_at);
      }
      const held = [0, 1, "RETRY", 0, 1000, "X"];
      assert.deepStrictEqual(seen, [held, held, held, held, [0, 1, "RETRY", 0, SETTINGS.retryMaxMs, "X"]]);
      assert.deepStrictEqual([counts["scheduler.deferred"], counts["scheduler.quarantined"] || 0], [5, 0]);
      const plain = [];
      for (const until of [clock.now() - 1, 1.5, clock.now() - 1]) {
        next = () => ({ deferUntil: until });
        await s.runPass();
        const after = row();
        plain.push([after.state, after.attempts]);
        if (after.state === "RETRY") clock.set(after.due_at);
      }
      assert.deepStrictEqual(plain, [["RETRY", 1], ["RETRY", 2], ["QUARANTINED", 3]]);
      assert.deepStrictEqual([counts["scheduler.deferred"], counts["scheduler.quarantined"]], [5, 1]);
    });
  });

  needsDriver("A6 deferUntil == now -> due now + 1, the same pass never claims the row "
    + "again (one handler call per pass), attempts 0", async () => {
    await withStore(driver, async (reopen) => {
      const store = reopen();
      const { startOk, clock } = env({ settings: { maxAttempts: 3 } });
      const s = startOk(store);
      const id = s.enqueue("FLEET_ARRIVAL", "fleet_n", clock.now(), {}, "arrival:fleet_n:1").event.eventId;
      let calls = 0;
      assert.ok(s.registerHandler("FLEET_ARRIVAL", () => {
        calls += 1;
        return { ok: false, reason: "HOLD", deferUntil: clock.now() };
      }).ok);
      const r = await s.runPass();
      const after = rows(store, `event_id = '${id}'`)[0];
      assert.deepStrictEqual([calls, r.retried, after.state, after.attempts, after.due_at - clock.now()],
        [1, 1, "RETRY", 0, 1]);
    });
  });

  const ok = () => ({ ok: true });

  needsDriver("L1 scheduler lateness detail: FLEET_ARRIVAL 2 s late -> lateness.operational, FACTION_STRATEGY_REVIEW "
    + "7 s late -> lateness.strategic; scheduler.lateness still gets both; oldestDueAgeMs", async () => {
    await withStore(driver, async (reopen) => {
      const store = reopen();
      const { startOk, observed, gauges } = env({ settings: LATENESS_ON });
      const s = startOk(store);
      assert.ok(s.enqueue("FLEET_ARRIVAL", "fleet_a", START_MS - 2000, {}, "arrival:a").ok);
      assert.ok(s.enqueue("FACTION_STRATEGY_REVIEW", "faction_a", START_MS - 7000, {}, "review:a").ok);
      assert.ok(s.registerHandler("FLEET_ARRIVAL", ok).ok);
      assert.ok(s.registerHandler("FACTION_STRATEGY_REVIEW", ok).ok);
      assert.strictEqual(s.getStatus().latenessByType.types.length, 0);
      const r = await s.runPass();
      assert.deepStrictEqual([r.ok, r.jobs, r.done, r.stoppedBy], [true, 2, 2, "empty"], JSON.stringify(r));
      assert.deepStrictEqual(observed["scheduler.lateness"], [2000, 7000]);
      assert.deepStrictEqual(observed["scheduler.lateness.operational"], [2000]);
      assert.deepStrictEqual(observed["scheduler.lateness.strategic"], [7000]);
      for (const wc of ["settlement", "live", "maintenance"]) {
        assert.strictEqual(observed[`scheduler.lateness.${wc}`], undefined, wc);
      }
      assert.strictEqual(gauges["scheduler.oldestDueAgeMs"], 0);
    });
  });

  needsDriver("L2 scheduler latenessByType: n/avg/max/over per type (over >= latenessSlowMs), top latenessTopTypes by "
    + "maxMs, the rest as more", async () => {
    await withStore(driver, async (reopen) => {
      const store = reopen();
      const { startOk } = env({ settings: { ...LATENESS_ON, latenessTopTypes: 1 } });
      const s = startOk(store);
      assert.ok(s.enqueue("FLEET_ARRIVAL", "fleet_a", START_MS - 8000, {}, "arrival:a").ok);
      assert.ok(s.enqueue("FLEET_ARRIVAL", "fleet_b", START_MS - 2000, {}, "arrival:b").ok);
      assert.ok(s.enqueue("FACTION_STRATEGY_REVIEW", "faction_a", START_MS - 3000, {}, "review:a").ok);
      assert.ok(s.registerHandler("FLEET_ARRIVAL", ok).ok);
      assert.ok(s.registerHandler("FACTION_STRATEGY_REVIEW", ok).ok);
      assert.strictEqual((await s.runPass()).done, 3);
      assert.deepStrictEqual(JSON.parse(JSON.stringify(s.getStatus().latenessByType)),
        { types: [{ type: "FLEET_ARRIVAL", n: 2, avgMs: 5000, maxMs: 8000, over: 1 }], more: 1 });
    });
  });

  needsDriver("L3 scheduler stoppedBy: a pass ended by the time budget -> stoppedBy.time +1, by maxJobs -> "
    + "stoppedBy.items +1 (budgetExhausted counts both)", async () => {
    await withStore(driver, async (reopen) => {
      const store = reopen();
      let t = 0;
      const e = env({ settings: LATENESS_ON, limits: { maxDueEventsPerPass: 2 } });
      const s = e.startOk(store, { nowMs: () => t });
      for (let i = 0; i < 3; i += 1) {
        assert.ok(s.enqueue("FLEET_ARRIVAL", `fleet_${i}`, START_MS, {}, `arrival:${i}`).ok);
      }
      let costMs = 0;
      assert.ok(s.registerHandler("FLEET_ARRIVAL", () => {
        t += costMs;
        return { ok: true };
      }).ok);
      const byItems = await s.runPass();
      assert.deepStrictEqual([byItems.jobs, byItems.stoppedBy], [2, "items"]);
      assert.deepStrictEqual([e.counts["scheduler.stoppedBy.items"], e.counts["scheduler.stoppedBy.time"]],
        [1, undefined]);
      costMs = 10;
      const byTime = await s.runPass();
      assert.deepStrictEqual([byTime.jobs, byTime.stoppedBy], [1, "time"]);
      assert.deepStrictEqual([e.counts["scheduler.stoppedBy.items"], e.counts["scheduler.stoppedBy.time"],
        e.counts["scheduler.stoppedBy.write"], e.counts["scheduler.budgetExhausted"]], [1, 1, undefined, 2]);
    });
  });

  needsDriver("L4 scheduler latenessDetail=false: no new metric name, latenessByType null, the same pass results "
    + "as with the detail on", async () => {
    const runWith = async (settings) => {
      let names = null;
      let result = null;
      let byType;
      await withStore(driver, async (reopen) => {
        const store = reopen();
        const e = env({ settings, limits: { maxDueEventsPerPass: 1 } });
        const s = e.startOk(store);
        assert.ok(s.enqueue("FLEET_ARRIVAL", "fleet_a", START_MS - 2000, {}, "arrival:a").ok);
        assert.ok(s.enqueue("FACTION_STRATEGY_REVIEW", "faction_a", START_MS - 7000, {}, "review:a").ok);
        assert.ok(s.registerHandler("FLEET_ARRIVAL", ok).ok);
        assert.ok(s.registerHandler("FACTION_STRATEGY_REVIEW", ok).ok);
        result = [];
        for (let i = 0; i < 3; i += 1) {
          const r = await s.runPass();
          result.push([r.jobs, r.done, r.stoppedBy]);
        }
        names = [...new Set([...Object.keys(e.counts), ...Object.keys(e.gauges), ...Object.keys(e.observed)])].sort();
        byType = s.getStatus().latenessByType;
      });
      return { names, result, byType };
    };
    const off = await runWith({ latenessDetail: false, latenessSlowMs: 5000, latenessTopTypes: 12 });
    const on = await runWith(LATENESS_ON);
    assert.strictEqual(off.byType, null);
    assert.deepStrictEqual(off.names.filter((n) => LATENESS_NEW_NAME.test(n)), []);
    assert.deepStrictEqual(off.result, on.result);
    assert.deepStrictEqual(off.result, [[1, 1, "items"], [1, 1, "items"], [0, 0, "empty"]]);
    assert.deepStrictEqual(on.names.filter((n) => !off.names.includes(n)), ["scheduler.lateness.operational",
      "scheduler.lateness.strategic", "scheduler.oldestDueAgeMs", "scheduler.stoppedBy.items"]);
    assert.deepStrictEqual(off.names.filter((n) => !on.names.includes(n)), []);
  });
};
