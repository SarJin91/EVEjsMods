"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { findServerSrcOnDisk, GAMESTORE_SEARCH_MAX_DEPTH } = require("../../lib/adapter/locator");
const { resolveSqliteDriver } = require("../../lib/adapter/sqliteDriver");
const { openStore } = require("../../lib/persistence/store");
const { seedDbFile } = require("../_support/dbTemplate");
const { createManualClock } = require("../../lib/util/clock");
const { createRng } = require("../../lib/util/rng");
const { createIdGenerator } = require("../../lib/util/ids");
const { ADMISSION, WORK_CLASS_ORDER } = require("../../lib/telemetry/loadGovernor");
const { getEventType } = require("../../lib/scheduler/eventTypes");
const { createHeavyPacer } = require("../../lib/scheduler/heavyPacer");
const { startScheduler } = require("../../lib/scheduler");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const START_MS = 1760000000000;
const HOUR_MS = 3600000;
const SETTINGS = Object.freeze({ maxAttempts: 5, retryBaseMs: 1000, retryMaxMs: 600000, maxOpenEvents: 50000,
  maxPayloadBytes: 4096, intervalMs: 1000, sliceMs: 4, claimBatchSize: 8, catchUpLagMs: 60000, backlogCountCap: 4096,
  chainedHeadroom: 1000 });
const PACING = Object.freeze({ heavyPacing: true, heavyEventMs: 30, heavyPerWindow: 3, heavyWindowMs: 10000,
  costEwmaAlpha: 0.2, reescalationWindowMs: 60000, heavySampleCapFactor: 4, heavyMinSamples: 2 });
const LIMITS = Object.freeze({ maxDueEventsPerPass: 64, maxSchedulerWorkMs: 100000, maxCatchUpEventsPerPass: 32 });
const K = PACING.heavyPerWindow;
const WINDOW_MS = PACING.heavyWindowMs;
const HEAVY_COST_MS = 50;

const workClassOf = (t) => (getEventType(t) || {}).workClass || null;

function loadDriver() {
  const found = findServerSrcOnDisk(MOD_DIR, GAMESTORE_SEARCH_MAX_DEPTH, fs.existsSync);
  if (!found.ok) return { ok: false, detail: found.reason };
  return resolveSqliteDriver(found.srcDir);
}

async function withStore(driver, fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lne-hp-"));
  const file = path.join(tmp, "world.sqlite");
  let store = null;
  try {
    seedDbFile(driver, file, { seed: 1 });
    const opened = openStore({ filePath: file, openDatabase: (f) => new driver.Database(f), exclusiveLock: true,
      busyTimeoutMs: 0, maxRowsPerTransaction: 500, maxWriteMsPerPass: 5, randomSeed: () => 1 });
    assert.ok(opened.ok, JSON.stringify(opened));
    store = opened.store;
    return await fn(store);
  } finally {
    if (store) store.close("test_cleanup");
    try {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch (_err) {
    }
  }
}

function policyOf(mode) {
  const classes = {};
  for (const wc of WORK_CLASS_ORDER) {
    const admitted = ADMISSION[mode].includes(wc);
    classes[wc] = { admitted, budgetMs: admitted ? LIMITS.maxSchedulerWorkMs : 0, maxJobs: admitted ? 64 : 0 };
  }
  return { mode, phase: mode.toLowerCase(), reason: "test", budgetMs: LIMITS.maxSchedulerWorkMs, maxJobs: 64,
    classes };
}

function env(store, settings) {
  const clock = createManualClock(START_MS);
  const ids = createIdGenerator({ clock, rng: createRng(1) });
  const counts = {};
  const gauges = {};
  const telemetry = { count: (name, n) => { counts[name] = (counts[name] || 0) + n; },
    gauge: (name, v) => { gauges[name] = v; }, observe() {} };
  const fake = { t: 0 };
  const gov = { tickAvailable: true, baseMode: "NORMAL" };
  const config = { enabled: true, modules: { scheduler: { enabled: true } }, scheduler: { ...SETTINGS, ...settings },
    limits: { ...LIMITS } };
  const r = startScheduler({ config, persistence: { ok: true, store }, clock, ids, telemetry,
    logger: { log() {} }, nowMs: () => fake.t,
    getGovernor: () => ({ evaluate: () => policyOf("NORMAL"),
      getStatus: () => ({ counts: { emergencySamples: 0 }, tickAvailable: gov.tickAvailable,
        baseMode: gov.baseMode }) }) });
  assert.ok(r.ok, JSON.stringify(r));
  const s = r.scheduler;
  const seen = [];
  const heavy = (ev) => {
    seen.push({ type: ev.eventType, id: String(ev.aggregateId), at: fake.t });
    fake.t += HEAVY_COST_MS;
    return { ok: true };
  };
  const light = (ev) => {
    seen.push({ type: ev.eventType, id: String(ev.aggregateId), at: fake.t });
    return { ok: true };
  };
  async function pass() {
    fake.t += 1000;
    clock.advance(1000);
    return s.runPass();
  }
  return { s, clock, counts, gauges, fake, gov, seen, heavy, light, pass };
}

function maxInWindow(times, windowMs) {
  let max = 0;
  for (const t of times) {
    const n = times.filter((x) => x > t - windowMs && x <= t).length;
    if (n > max) max = n;
  }
  return max;
}

function simulate(pacer, type, passTimes, demand, costMs = HEAVY_COST_MS) {
  const out = [];
  let maxPerPass = 0;
  for (const t of passTimes) {
    if (!demand(t)) continue;
    const grant = pacer.beginPass();
    let taken = 0;
    for (let i = 0; i < 5; i += 1) {
      if (pacer.allowance(type, t, grant) - taken <= 0) break;
      taken += 1;
      pacer.noteDispatch(type, t, grant);
      pacer.observe(type, costMs);
      out.push(t);
    }
    if (taken > maxPerPass) maxPerPass = taken;
  }
  return { times: out, maxPerPass };
}

module.exports = ({ test, skip }) => {
  const driver = loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };
  const newPacer = () => createHeavyPacer({ heavyEventMs: PACING.heavyEventMs, perWindow: K, windowMs: WINDOW_MS,
    alpha: PACING.costEwmaAlpha, sampleCapFactor: PACING.heavySampleCapFactor, minSamples: PACING.heavyMinSamples,
    workClassOf });
  const passTimes = Array.from({ length: 60 }, (_, i) => i * 1000);

  test("HP1 R1 heavy pacer: sliding window K=3 per 10 s, 1 per pass, 18 in 60 s (continuous and sporadic demand)",
    () => {
      const a = newPacer();
      a.observe("FACTION_STRATEGY_REVIEW", HEAVY_COST_MS);
      a.observe("FACTION_STRATEGY_REVIEW", HEAVY_COST_MS);
      const cont = simulate(a, "FACTION_STRATEGY_REVIEW", passTimes, () => true);
      const b = newPacer();
      b.observe("FACTION_STRATEGY_REVIEW", HEAVY_COST_MS);
      b.observe("FACTION_STRATEGY_REVIEW", HEAVY_COST_MS);
      const spor = simulate(b, "FACTION_STRATEGY_REVIEW", passTimes, (t) => t === 0 || t >= 8000);
      assert.deepStrictEqual({
        contTotal: cont.times.length, contPerPass: cont.maxPerPass, contWindow: maxInWindow(cont.times, WINDOW_MS),
        sporTimes: spor.times, sporPerPass: spor.maxPerPass, sporWindow: maxInWindow(spor.times, WINDOW_MS),
        tokensAfter: b.tokens(59000),
      }, {
        contTotal: 18, contPerPass: 1, contWindow: K,
        sporTimes: [0, 8000, 9000, 10000, 18000, 19000, 20000, 28000, 29000, 30000, 38000, 39000, 40000,
          48000, 49000, 50000, 58000, 59000],
        sporPerPass: 1, sporWindow: K, tokensAfter: 0,
      });
    });

  test("HP3 R1 heavy pacer: unmeasured 1 per pass without a token, light many, SETTLEMENT Infinity, EWMA down -> light",
    () => {
      const p = createHeavyPacer({ heavyEventMs: 30, perWindow: K, windowMs: WINDOW_MS, alpha: 0.5, sampleCapFactor: 4,
        minSamples: 1, workClassOf });
      const g1 = p.beginPass();
      const unmeasured = [p.classify("FLEET_ARRIVAL"), p.allowance("FLEET_ARRIVAL", 0, g1)];
      p.noteDispatch("FLEET_ARRIVAL", 0, g1);
      p.observe("FLEET_ARRIVAL", 2);
      unmeasured.push(p.allowance("FLEET_ARRIVAL", 0, g1), p.tokens(0), p.getStatus(0).unmeasuredRuns);
      const g2 = p.beginPass();
      const light = [p.classify("FLEET_ARRIVAL"), p.allowance("FLEET_ARRIVAL", 1000, g2)];
      const settle = [p.classify("BATTLE_RESOLUTION"), p.allowance("BATTLE_RESOLUTION", 1000, g2)];
      p.observe("BATTLE_RESOLUTION", 500);
      settle.push(p.classify("BATTLE_RESOLUTION"), p.allowance("BATTLE_RESOLUTION", 1000, g2),
        p.allowance("NOT_A_TYPE", 1000, g2));
      p.observe("FACTION_STRATEGY_REVIEW", 50);
      const down = [p.classify("FACTION_STRATEGY_REVIEW"), p.heavyCount()];
      p.observe("FACTION_STRATEGY_REVIEW", 0);
      down.push(p.classify("FACTION_STRATEGY_REVIEW"), p.heavyCount());
      assert.deepStrictEqual({ unmeasured, light, settle, down }, {
        unmeasured: ["unmeasured", 1, 1, K, 1],
        light: ["light", Infinity],
        settle: ["exempt", Infinity, "exempt", Infinity, Infinity],
        down: ["heavy", 1, "light", 0],
      });
    });

  needsDriver("HP2 R1 pass: 30 heavy STRATEGIC + 5 SETTLEMENT after NORMAL -> settlements first pass, <= K heavy "
    + "per window, queue drains", async () => {
    await withStore(driver, async (store) => {
      const e = env(store, PACING);
      for (let i = 0; i < 30; i += 1) {
        assert.ok(e.s.enqueue("FACTION_STRATEGY_REVIEW", 500001 + i, START_MS - HOUR_MS + i, {}, `review:${i}`).ok);
      }
      for (let i = 0; i < 5; i += 1) {
        assert.ok(e.s.enqueue("BATTLE_RESOLUTION", `battle_${i}`, START_MS - HOUR_MS + 100 + i, {}, `b:${i}`).ok);
      }
      e.s.registerHandler("FACTION_STRATEGY_REVIEW", e.heavy);
      e.s.registerHandler("BATTLE_RESOLUTION", e.light);
      const first = await e.pass();
      const firstTypes = e.seen.map((x) => x.type);
      let passes = 1;
      while (e.seen.length < 35 && passes < 200) {
        await e.pass();
        passes += 1;
      }
      const reviews = e.seen.filter((x) => x.type === "FACTION_STRATEGY_REVIEW").map((x) => x.at);
      const heavyTimes = reviews.slice(PACING.heavyMinSamples);
      const lastAt = reviews[reviews.length - 1];
      const status = e.s.getStatus().pacing;
      assert.deepStrictEqual({
        firstOk: first.ok, firstBattles: firstTypes.filter((t) => t === "BATTLE_RESOLUTION").length,
        firstReviews: firstTypes.filter((t) => t === "FACTION_STRATEGY_REVIEW").length,
        reviews: reviews.length, maxHeavyInWindow: maxInWindow(heavyTimes, WINDOW_MS),
        drainedInTime: lastAt <= (30 / K) * WINDOW_MS + 2 * WINDOW_MS,
        heavyDispatched: e.counts["scheduler.heavyDispatched"], heavyUnmeasured: e.counts["scheduler.heavyUnmeasured"],
        active: status.active, heavyTypes: status.heavy.map((h) => h.type), gaugeTypes: e.gauges["scheduler.heavyTypes"],
      }, {
        firstOk: true, firstBattles: 5, firstReviews: 1, reviews: 30, maxHeavyInWindow: K, drainedInTime: true,
        heavyDispatched: 28, heavyUnmeasured: 2, active: true, heavyTypes: ["FACTION_STRATEGY_REVIEW"], gaugeTypes: 1,
      });
      const done = store.transaction("t", (db) => db.prepare(
        "SELECT COUNT(*) AS n FROM world_scheduled_events WHERE state = 'DONE'").get().n);
      assert.strictEqual(done.value, 35);
    });
  });

  needsDriver("HP4 R1 pass parity: tickAvailable=false or heavyPacing=false -> the same events in the same order "
    + "as without a pacer", async () => {
    async function run(settings, tickAvailable) {
      return withStore(driver, async (store) => {
        const e = env(store, settings);
        e.gov.tickAvailable = tickAvailable;
        for (let i = 0; i < 6; i += 1) {
          assert.ok(e.s.enqueue("FACTION_STRATEGY_REVIEW", 500001 + i, START_MS - HOUR_MS + i, {}, `r:${i}`).ok);
          assert.ok(e.s.enqueue("FLEET_ARRIVAL", `fleet_${i}`, START_MS - HOUR_MS + i, {}, `a:${i}`).ok);
        }
        e.s.registerHandler("FACTION_STRATEGY_REVIEW", e.heavy);
        e.s.registerHandler("FLEET_ARRIVAL", e.light);
        const perPass = [];
        for (let p = 0; p < 4; p += 1) {
          const before = e.seen.length;
          const r = await e.pass();
          perPass.push([r.jobs, r.stoppedBy, ...e.seen.slice(before).map((x) => `${x.type}:${x.id}`)]);
        }
        const pacing = e.s.getStatus().pacing;
        return { perPass, pacing: pacing === null ? null : pacing.active };
      });
    }
    const plain = await run({}, true);
    const noTick = await run(PACING, false);
    const off = await run({ ...PACING, heavyPacing: false }, true);
    const paced = await run(PACING, true);
    assert.deepStrictEqual(noTick.perPass, plain.perPass);
    assert.deepStrictEqual(off.perPass, plain.perPass);
    assert.deepStrictEqual([plain.pacing, noTick.pacing, off.pacing, paced.pacing], [null, false, null, true]);
    assert.notDeepStrictEqual(paced.perPass, plain.perPass, "pacing on must change the order (test has teeth)");
  });

  test("HP6 estimator: 300 ms first sample -> still unmeasured, seeded light; a 900 ms spike on a light type "
    + "is capped at 4 x heavyEventMs and keeps it light", () => {
    const p = newPacer();
    p.observe("FLEET_ARRIVAL", 300);
    const afterOne = [p.classify("FLEET_ARRIVAL"), p.heavyCount()];
    p.observe("FLEET_ARRIVAL", 2);
    const afterTwo = [p.classify("FLEET_ARRIVAL"), p.heavyCount()];
    p.observe("FLEET_ARRIVAL", 900);
    const afterSpike = [p.classify("FLEET_ARRIVAL"), p.heavyCount()];
    const q = newPacer();
    q.observe("FACTION_STRATEGY_REVIEW", 1000);
    q.observe("FACTION_STRATEGY_REVIEW", 1000);
    assert.deepStrictEqual({ afterOne, afterTwo, afterSpike, capped: q.getStatus(0).heavy,
      capMs: q.getStatus(0).sampleCapMs, minSamples: q.getStatus(0).minSamples }, {
      afterOne: ["unmeasured", 0], afterTwo: ["light", 0], afterSpike: ["light", 0],
      capped: [{ type: "FACTION_STRATEGY_REVIEW", ewmaMs: 120 }], capMs: 120, minSamples: 2,
    });
  });

  test("HP7 a type steadily at 80 ms is still paced: 2 unmeasured passes, then <= K per window, 1 per pass",
    () => {
      const p = newPacer();
      const r = simulate(p, "FACTION_STRATEGY_REVIEW", passTimes, () => true, 80);
      assert.deepStrictEqual({ first: r.times.slice(0, 5), total: r.times.length, perPass: r.maxPerPass,
        window: maxInWindow(r.times.slice(PACING.heavyMinSamples), WINDOW_MS), cls: p.classify("FACTION_STRATEGY_REVIEW"),
        status: p.getStatus(59000).unmeasuredRuns }, {
        first: [0, 1000, 2000, 3000, 4000], total: 20, perPass: 1, window: K, cls: "heavy", status: 2,
      });
    });

  needsDriver("HP8 pass: a light p3 type whose first dispatch after a restart costs 300 ms does not hold p3 "
    + "(FLEET_ARRIVAL ahead of CAPSULEER_TRIP_STEP) longer than one window", async () => {
    async function run(settings) {
      return withStore(driver, async (store) => {
        const e = env(store, settings);
        for (let i = 0; i < 12; i += 1) {
          assert.ok(e.s.enqueue("FLEET_ARRIVAL", `fleet_${i}`, START_MS - HOUR_MS + i, {}, `a:${i}`).ok);
          assert.ok(e.s.enqueue("CAPSULEER_TRIP_STEP", `trip_${i}`, START_MS - HOUR_MS + 100 + i, {}, `c:${i}`).ok);
        }
        let n = 0;
        e.s.registerHandler("FLEET_ARRIVAL", (ev) => {
          e.light(ev);
          e.fake.t += n === 0 ? 300 : (n === 5 ? 900 : 1);
          n += 1;
          return { ok: true };
        });
        e.s.registerHandler("CAPSULEER_TRIP_STEP", e.light);
        const startT = e.fake.t;
        let passes = 0;
        while (e.seen.length < 24 && passes < 100) {
          await e.pass();
          passes += 1;
        }
        const last = e.seen[e.seen.length - 1].at;
        return { all: e.seen.length, withinWindow: last - startT <= WINDOW_MS,
          heavy: e.counts["scheduler.heavyDispatched"] || 0, types: e.s.getStatus().pacing.heavy.length };
      });
    }
    const fixed = await run(PACING);
    const before = await run({ ...PACING, heavySampleCapFactor: 100, heavyMinSamples: 1 });
    assert.deepStrictEqual({ fixed, beforeWithin: before.withinWindow },
      { fixed: { all: 24, withinWindow: true, heavy: 0, types: 0 }, beforeWithin: false });
  });

  needsDriver("HP5 R1 re-escalation: base NORMAL -> OVERLOADED 30 s after catch-up start = 1, after 90 s = 0, "
    + "second escalation of the same start still 1", async () => {
    async function run(escalateAfterMs, twice) {
      return withStore(driver, async (store) => {
        const e = env(store, { reescalationWindowMs: PACING.reescalationWindowMs });
        assert.ok(e.s.enqueue("FLEET_ARRIVAL", "fleet_1", START_MS - 2 * HOUR_MS, {}, "a:1").ok);
        e.s.registerHandler("FLEET_ARRIVAL", e.light);
        const first = await e.pass();
        assert.strictEqual(first.catchUp, true);
        e.clock.advance(escalateAfterMs - 1000);
        e.gov.baseMode = "OVERLOADED";
        await e.pass();
        if (twice) {
          e.gov.baseMode = "NORMAL";
          await e.pass();
          e.gov.baseMode = "OVERLOADED";
          await e.pass();
        }
        return e.counts["scheduler.catchUpReescalations"] || 0;
      });
    }
    assert.deepStrictEqual([await run(30000, false), await run(90000, false), await run(30000, true)], [1, 0, 1]);
  });
};
