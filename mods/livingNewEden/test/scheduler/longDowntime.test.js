"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const config = require("../../config");
const { findServerSrcOnDisk, GAMESTORE_SEARCH_MAX_DEPTH } = require("../../lib/adapter/locator");
const { resolveSqliteDriver } = require("../../lib/adapter/sqliteDriver");
const { openStore } = require("../../lib/persistence/store");
const { seedDbFile } = require("../_support/dbTemplate");
const { createManualClock } = require("../../lib/util/clock");
const { createRng } = require("../../lib/util/rng");
const { createIdGenerator } = require("../../lib/util/ids");
const { startScheduler } = require("../../lib/scheduler");
const { planUpkeep } = require("../../lib/strategy/ai/upkeep");
const { planTreasury } = require("../../lib/strategy/ai/treasury");
const { createJournal } = require("../../lib/persistence/journal");
const { startTrade } = require("../../lib/economy/trade");
const { startTreasury } = require("../../lib/economy/treasury");
const { treasuryParamsOf } = require("../../lib/strategy/reviewService");
const { FACTION_AGGREGATE, EVENT_STRATEGY_INTENT } = require("../../lib/strategy/schema");
const { wrapCampaignBinding, runCampaignRetry } = require("../../lib/adapter/sovCampaignSpread");
const { harness: H } = require("../battle/settlement.test");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const DAY = 86400000;
const DOWNTIME_MS = 30 * DAY;
const AT = 1760000000000;
const EVENTS = 400;
const OVERFLOW_JOBS = 500;
const F = 500003;
const LNE_SYSTEM = 30004711;
const LNE_ALLIANCE = 99000001;
const HUB0 = 1000000123456;

function defaultsOf(prefix) {
  const out = {};
  for (const row of config.SCHEMA) {
    const rest = typeof row.key === "string" && row.key.startsWith(prefix) ? row.key.slice(prefix.length) : null;
    if (rest && !rest.includes(".")) out[rest] = row.default;
  }
  return out;
}
const defaultOf = (key) => config.SCHEMA.find((r) => r.key === key).default;

function loadDriver() {
  const found = findServerSrcOnDisk(MOD_DIR, GAMESTORE_SEARCH_MAX_DEPTH, fs.existsSync);
  if (!found.ok) return { ok: false, detail: found.reason };
  return resolveSqliteDriver(found.srcDir);
}

async function withStore(driver, fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lne-ld-"));
  const file = path.join(tmp, "world.sqlite");
  seedDbFile(driver, file, { seed: 1 });
  const opened = openStore({ filePath: file, openDatabase: (f) => new driver.Database(f), exclusiveLock: true,
    busyTimeoutMs: 0, maxRowsPerTransaction: 500, maxWriteMsPerPass: 5, randomSeed: () => 1 });
  assert.ok(opened.ok, JSON.stringify(opened));
  try {
    return await fn(opened.store);
  } finally {
    opened.store.close("test_cleanup");
    try {
      fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch (_err) {
    }
  }
}

const ON = Object.freeze({ EVEJS_LNE_TREASURY_ENABLED: "1", EVEJS_LNE_TRADE_CONTRACTS_ENABLED: "0" });
const AMARR_UPKEEP = Object.freeze({ mode: "ready", controlledCount: 10, stationCount: 5 });
const FLEETS = Object.freeze([{ composition: [{ hullGroup: "battleship", count: 3 }, { hullGroup: "frigate", count: 10 }] }]);

function bootTreasury(opened, shared) {
  const cfg = config.resolveConfig({ modDir: MOD_DIR, env: { ...ON } }).config;
  const journal = createJournal({ clock: shared.clock, maxPayloadBytes: 16384, maxRows: 500 });
  const persistence = { ok: true, store: opened.store, journal };
  const tr = startTrade({ config: cfg, persistence, clock: shared.clock, ids: shared.ids });
  assert.ok(tr.ok, JSON.stringify(tr));
  const h = { journal, store: opened.store, trade: tr.trade, params: treasuryParamsOf(cfg) };
  const t = startTreasury({ config: cfg, persistence, clock: shared.clock, getTrade: () => h.trade });
  assert.ok(t.ok, JSON.stringify(t));
  h.treasury = t.treasury;
  h.tx = (fn) => {
    const r = opened.store.transaction("test", fn);
    assert.ok(r.ok, JSON.stringify(r));
    return r.value;
  };
  return h;
}

function applyIntent(h, intent, at, ik) {
  let value = null;
  const res = h.tx((db) => h.journal.applyOnce(db, { key: ik, aggregate: { type: FACTION_AGGREGATE, id: String(F) },
    eventType: EVENT_STRATEGY_INTENT, payload: { seed: 1, intent } }, (tx) => {
    value = h.treasury.settleIntentInTx(tx, { ...intent, factionId: F, at }, ik);
    return value;
  }));
  return { res, value };
}

function reviewTreasury(h, at, round) {
  const read = h.tx((db) => h.treasury.readForReview(db, F, { at, npcStations: 1, kind: "empire" }));
  assert.ok(read.ok, JSON.stringify(read));
  const plan = planTreasury({ at, treasury: read.treasury, upkeep: AMARR_UPKEEP, fleets: FLEETS },
    { treasury: h.params }, { produce: 0 });
  if (plan.intents.length === 0) return { plan, res: null };
  const ik = `strategy:review:${F}:${round}:0:TREASURY`;
  return { plan, ik, ...applyIntent(h, plan.intents[0], at, ik) };
}

function windowJob(targetID, dueAtMs) {
  const captureEpoch = `owned-hub:${LNE_SYSTEM}:${targetID}:1790000000000`;
  return { jobID: `sovereignty-campaign:${targetID}:${captureEpoch}`, type: "sovereignty.campaign-tick", dueAtMs,
    payload: { targetID, captureEpoch, windowEventMs: dueAtMs } };
}

function fakeExports() {
  const state = { bound: null };
  return { state, exportsObject: {
    bindDurableScheduler(scheduler) {
      state.bound = scheduler;
      return true;
    },
    unbindDurableScheduler() {
      state.bound = null;
      return true;
    },
  } };
}

module.exports = ({ test, skip }) => {
  const driver = loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };
  const tDriver = H.loadDriver();
  const needsTreasuryDriver = (name, fn) => {
    if (tDriver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${tDriver.detail})`);
  };

  needsDriver("LD1 scheduler after 30 days: 400 events due over 30 d, every pass <= limits.maxCatchUpEventsPerPass "
    + "(defaults), each event exactly once, catch-up log lag >= 30 d - catchUpLagMs", async () => {
    const settings = defaultsOf("scheduler.");
    const limits = defaultsOf("limits.");
    const cap = limits.maxCatchUpEventsPerPass;
    assert.ok(Number.isSafeInteger(cap) && cap > 0 && cap < EVENTS, `cap ${cap}`);
    await withStore(driver, async (store) => {
      const clock = createManualClock(AT);
      const ids = createIdGenerator({ clock, rng: createRng(1) });
      const telemetry = { count() {}, gauge() {}, observe() {} };
      const lines = [];
      const r = startScheduler({ config: { enabled: true, modules: { scheduler: { enabled: true } }, scheduler: settings,
        limits }, persistence: { ok: true, store }, clock, ids, telemetry, logger: { log: (l) => lines.push(l) },
      nowMs: () => 0 });
      assert.ok(r.ok, JSON.stringify(r));
      const s = r.scheduler;
      const first = AT - DOWNTIME_MS;
      const last = AT - settings.catchUpLagMs - 1;
      const types = ["FLEET_ARRIVAL", "BATTLE_RESOLUTION"];
      for (let i = 0; i < EVENTS; i += 1) {
        const due = first + Math.floor((i * (last - first)) / (EVENTS - 1));
        const e = s.enqueue(types[i % 2], `agg_${i}`, due, { i }, `ld1:${i}`);
        assert.ok(e.ok, JSON.stringify(e));
      }
      const seen = new Map();
      for (const type of types) {
        assert.ok(s.registerHandler(type, (ev) => {
          seen.set(ev.eventId, (seen.get(ev.eventId) || 0) + 1);
          return { ok: true };
        }).ok);
      }
      const passes = [];
      for (let p = 0; p < EVENTS; p += 1) {
        const out = await s.runPass();
        assert.ok(out.ok && !out.skipped, JSON.stringify(out));
        passes.push(out);
        if (out.stoppedBy === "empty") break;
      }
      assert.strictEqual(passes[0].catchUp, true, "the first pass is a catch-up pass");
      assert.ok(passes.every((p) => p.jobs <= cap), `jobs per pass ${passes.map((p) => p.jobs)} <= ${cap}`);
      assert.strictEqual(passes[passes.length - 1].stoppedBy, "empty");
      assert.ok(passes.length >= Math.ceil(EVENTS / cap), `${passes.length} passes`);
      assert.strictEqual(seen.size, EVENTS);
      assert.ok([...seen.values()].every((n) => n === 1), "each event handled exactly once");
      const done = store.transaction("t", (db) => db.prepare("SELECT count(*) AS n FROM world_scheduled_events "
        + "WHERE state = 'DONE'").get());
      assert.strictEqual(done.value.n, EVENTS);
      const start = lines.find((l) => l.startsWith("scheduler: catch-up start lag="));
      assert.ok(start, lines.join("\n"));
      const lag = Number(/lag=(\d+)/.exec(start)[1]);
      assert.ok(lag >= DOWNTIME_MS - settings.catchUpLagMs, `lag ${lag}`);
    });
  });

  test("LD2 upkeep after 30 days: periods = 30 d / periodMs, charged = maxCatchUpPeriods (defaults), "
    + "UPKEEP_FORGIVEN:<rest>, paidUntilTo over every period, the next plan charges nothing", () => {
    const up = { ...defaultsOf("upkeep."), maxResourceUnits: defaultOf("strategy.maxResourceUnits") };
    const P = up.periodMs;
    const at = AT - (AT % P) + 1234;
    const paidUntil = at - (at % P) - DOWNTIME_MS;
    const periods = Math.floor(DOWNTIME_MS / P);
    assert.ok(periods > up.maxCatchUpPeriods, `${periods} > ${up.maxCatchUpPeriods}`);
    const snap = (paid) => ({ factionId: 500019, round: 3, at,
      faction: { status: "ACTIVE", resourceUnits: 1000, reserveUnits: 10, version: 2 },
      upkeep: { mode: "ready", paidUntil: paid, unpaidPeriods: 0, controlledCount: 10, captured: [],
        capturedTruncated: false, liveShips: 0, stationCount: 2, tradeReady: false } });
    const plan = planUpkeep(snap(paidUntil), null, { upkeep: up });
    const u = plan.intents[0];
    assert.deepStrictEqual([u.periods, u.charged, u.paidUntilTo], [periods, up.maxCatchUpPeriods, paidUntil + periods * P]);
    assert.ok(plan.notes.includes(`UPKEEP_FORGIVEN:${periods - up.maxCatchUpPeriods}`), JSON.stringify(plan.notes));
    const again = planUpkeep(snap(u.paidUntilTo), null, { upkeep: up });
    assert.deepStrictEqual(again.intents, [], "no second charge");
    assert.ok(!again.notes.some((n) => n.startsWith("UPKEEP_FORGIVEN")), JSON.stringify(again.notes));
  });

  needsTreasuryDriver("LD3 treasury after 30 days: charged = treasury.maxCatchUpPeriods (defaults), "
    + "TREASURY_FORGIVEN:<rest>, paid_until over every period, the same intent again = duplicate, the next review "
    + "charges nothing", () => H.withStore(tDriver, async (reopen) => {
    const P = defaultOf("treasury.periodMs");
    const maxCatchUp = defaultOf("treasury.maxCatchUpPeriods");
    const periods = Math.floor(DOWNTIME_MS / P);
    const shared = H.sharedOf();
    const h = bootTreasury(reopen(), shared);
    const at0 = Math.floor(shared.clock.now() / P) * P + 1000;
    const anchor = at0 - 1000;
    const r1 = reviewTreasury(h, at0, 1);
    assert.ok(r1.plan.notes.includes("TREASURY_ANCHOR") && r1.res.ok, JSON.stringify(r1.plan.notes));
    const rowOf = () => h.tx((db) => db.prepare("SELECT paid_until FROM world_faction_treasury WHERE faction_id = ?")
      .get(F));
    assert.strictEqual(rowOf().paid_until, anchor);
    const at2 = at0 + DOWNTIME_MS;
    const r2 = reviewTreasury(h, at2, 2);
    assert.deepStrictEqual([r2.plan.intents[0].periods, r2.plan.intents[0].charged], [periods, maxCatchUp]);
    assert.ok(r2.plan.notes.includes(`TREASURY_FORGIVEN:${periods - maxCatchUp}`), JSON.stringify(r2.plan.notes));
    assert.ok(r2.res.ok && !r2.res.duplicate, JSON.stringify(r2.res));
    assert.strictEqual(rowOf().paid_until, anchor + periods * P);
    const again = applyIntent(h, r2.plan.intents[0], at2, r2.ik);
    assert.ok(again.res.ok && again.res.duplicate === true, JSON.stringify(again.res));
    assert.strictEqual(rowOf().paid_until, anchor + periods * P, "the duplicate writes nothing");
    const r3 = reviewTreasury(h, at2, 3);
    assert.ok(r3.plan.intents.every((i) => i.periods === 0 && i.charged === 0), JSON.stringify(r3.plan.intents));
    assert.ok(!r3.plan.notes.some((n) => n.startsWith("TREASURY_FORGIVEN")), JSON.stringify(r3.plan.notes));
  }));

  test("LD4 sov campaign spread retry after 30 days: retryMax + 500 window jobs -> retry <= retryMax, exactly "
    + "ceil(size / batch) slices of <= batch writes, every job counted once; overdue jobs: no time after now + "
    + "spreadMs (provisional off and on); jobs of a new window in (now + delayMs, now + spreadMs): writes > 0 = "
    + "spread + restored (defaults)", async () => {
    const pre = "world.sovProjection.";
    const spreadMs = defaultOf(`${pre}campaignSpreadMs`);
    const retryMax = defaultOf(`${pre}campaignSpreadRetryMax`);
    const batch = defaultOf(`${pre}campaignSpreadRetryBatch`);
    const delayMs = defaultOf(`${pre}campaignSpreadRetryDelayMs`);
    assert.ok(retryMax > 0 && batch > 0 && spreadMs > 0);
    const now = AT;
    const total = retryMax + OVERFLOW_JOBS;
    const futureStep = Math.floor((spreadMs - delayMs - 2) / total);
    assert.ok(futureStep >= 1, `future step ${futureStep}`);
    const variants = [
      { name: "overdue", provisional: false, dueOf: (i) => now - DOWNTIME_MS + i * 1000 },
      { name: "overdue provisional", provisional: true, dueOf: (i) => now - DOWNTIME_MS + i * 1000 },
      { name: "new window", provisional: false, dueOf: (i) => now + delayMs + 1 + i * futureStep },
    ];
    for (const { name, provisional, dueOf } of variants) {
      const { exportsObject, state } = fakeExports();
      let ready = false;
      const wrapped = wrapCampaignBinding(exportsObject, { spreadMs, retryMax, provisional,
        allianceOfSystem: () => LNE_ALLIANCE, isVirtualAlliance: (id) => ready && id === LNE_ALLIANCE });
      assert.ok(wrapped.ok && wrapped.retry, JSON.stringify(wrapped));
      const scheduled = [];
      exportsObject.bindDurableScheduler(Object.freeze({ schedule(job) {
        scheduled.push(job);
        return Promise.resolve({ jobID: job.jobID });
      } }));
      const original = new Map();
      for (let i = 0; i < total; i += 1) {
        const job = windowJob(HUB0 + i, dueOf(i));
        original.set(job.jobID, job.dueAtMs);
        state.bound.schedule(job);
      }
      assert.strictEqual(scheduled.length, total, `${name}: each boot job reaches the vendor once`);
      const size = wrapped.retry.size();
      assert.strictEqual(size, retryMax, `${name}: retry holds retryMax of ${total}`);
      const marks = [];
      ready = true;
      const out = await runCampaignRetry(wrapped.retry, { whenReady: () => Promise.resolve(), nowMs: () => now, batch,
        delayMs, wait: (ms) => {
          marks.push({ ms, at: scheduled.length });
          return Promise.resolve();
        } });
      assert.ok(out.ok, JSON.stringify(out));
      assert.strictEqual(out.slices, Math.ceil(size / batch), `${name}: slices`);
      assert.strictEqual(marks.length, out.slices - 1, `${name}: one pause between slices`);
      assert.ok(marks.every((m) => m.ms === delayMs));
      const bounds = [total, ...marks.map((m) => m.at), scheduled.length];
      for (let k = 1; k < bounds.length; k += 1) {
        assert.ok(bounds[k] - bounds[k - 1] <= batch, `${name}: slice ${k} writes ${bounds[k] - bounds[k - 1]}`);
      }
      assert.strictEqual(out.spread + out.skipped + out.kept + out.restored, size, JSON.stringify(out));
      const writes = scheduled.slice(total);
      assert.strictEqual(writes.length, out.spread + out.restored, `${name}: writes = spread + restored`);
      if (name === "new window") {
        assert.ok(writes.length > batch, `${name}: writes ${writes.length} span several slices`);
        assert.ok(writes.every((j) => j.dueAtMs > original.get(j.jobID)
          && j.dueAtMs < original.get(j.jobID) + spreadMs), `${name}: moved by an offset in (0, spreadMs)`);
        assert.strictEqual(new Set(writes.map((j) => j.jobID)).size, writes.length, `${name}: one write per jobID`);
      } else {
        assert.deepStrictEqual([out.skipped, writes.length], [size, 0], name);
        assert.ok(scheduled.every((j) => j.dueAtMs <= now + spreadMs), `${name}: no time after now + spreadMs`);
      }
      assert.strictEqual(wrapped.retry.size(), 0);
    }
  });
};
