"use strict";

const assert = require("node:assert");

const { createPayoutPump, legKeyOf } = require("../../lib/frontJobs/payoutPump");
const { createFrontJobRepository } = require("../../lib/frontJobs/repository");
const { harness: H } = require("../battle/settlement.test");

const T0 = 1_800_000_000_000;
const DAY = 86400000;
const CALDARI = 500001;
const GURISTAS = 500010;
const LP_CORP = 1000035;
const PARAMS = Object.freeze({ payoutEnabled: true, payoutMaxPerPass: 10, payoutMaxAttempts: 3,
  payoutRetryBaseMs: 60000, payoutRetryMaxMs: 3600000, retentionMs: 7 * DAY, payoutRetentionMs: 30 * DAY,
  prunePerPass: 200 });

function fakeAdapter() {
  const receipts = new Map();
  const credits = [];
  const calls = [];
  const fail = { isk: new Map(), lp: new Map(), std: new Map() };
  const a = {
    seams: true,
    rewardSeams: () => (a.seams ? { ok: true } : { ok: false, missing: ["services/account/walletState: drift"] }),
    async rewardCreditIsk(spec) {
      calls.push(["isk", spec]);
      const f = fail.isk.get(spec.characterId);
      if (f) return f;
      if (receipts.has(spec.commandId)) return { ok: true, duplicate: true, fingerprintMismatch: false };
      receipts.set(spec.commandId, spec);
      credits.push(["isk", spec.characterId, spec.amountIsk]);
      return { ok: true, duplicate: false, fingerprintMismatch: false };
    },
    rewardCreditLp(spec) {
      calls.push(["lp", spec]);
      const f = fail.lp.get(spec.characterId);
      if (f) return f;
      if (receipts.has(spec.commandId)) return { ok: true, duplicate: true };
      receipts.set(spec.commandId, spec);
      credits.push(["lp", spec.characterId, spec.amountLp]);
      return { ok: true, duplicate: false };
    },
    applyStandingGrant(grant, data) {
      calls.push(["std", grant, data]);
      const f = fail.std.get(grant.characterId);
      if (f) return f;
      if (receipts.has(grant.key)) return { ok: true, outcome: "DUPLICATE", previousStanding: 0, standing: 0 };
      receipts.set(grant.key, grant);
      credits.push(["std", grant.characterId, grant.rawChange]);
      return { ok: true, outcome: "APPLIED", previousStanding: 0, standing: grant.rawChange };
    },
  };
  return { adapter: a, credits, calls, fail };
}

function pumpOf(store, adapter, over = {}) {
  const counters = {};
  const pump = createPayoutPump({ store, repo: createFrontJobRepository(), adapter, params: { ...PARAMS, ...over },
    count: (name, n = 1) => { counters[name] = (counters[name] || 0) + n; }, isStopped: () => false });
  return { pump, counters };
}

function tx(store, fn) {
  const r = store.transaction("test", fn);
  assert.ok(r.ok, JSON.stringify(r));
  return r.value;
}

const job = (slot, createdAt, over = {}) => ({ jobId: `fj:1:${slot}:${createdAt}`, day: 1, slot, kind: "KILL",
  issuerFactionId: CALDARI, targetFactionId: GURISTAS, systemId: 30000001, regionId: null, targetCount: 10, ref: null,
  iskAmount: 2000000, lpAmount: 500, lpCorporationId: LP_CORP, standingMicro: 5000, maxCompletions: 3,
  description: "Front job: Guristas in Jita", createdAt, expiresAt: createdAt + DAY, ...over });

function seed(store, j, chars, at = j.createdAt) {
  const repo = createFrontJobRepository();
  return tx(store, (db) => {
    assert.ok(repo.insertJobInTx(db, j).ok);
    return chars.map((c) => {
      const r = repo.insertPayoutInTx(db, j, c, at);
      assert.ok(r.ok, JSON.stringify(r));
      return r.payoutKey;
    });
  });
}

const payoutsOf = (store) => tx(store, (db) => db.prepare(`SELECT payout_key AS k, isk_state AS i, lp_state AS l,
  std_state AS s, state, attempts AS a, next_attempt_at AS n, last_error AS e FROM world_front_job_payouts
  ORDER BY payout_key`).all());

module.exports = ({ test, skip }) => {
  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  needsDriver("FP1 three legs -> PAID; vendor keys lne:<payout_key>:isk|lp|std, rawChange 0.005, source", () =>
    H.withStore(driver, async (reopen) => {
      const { store } = reopen();
      const [key] = seed(store, job(0, T0), [9001]);
      const { adapter, credits, calls } = fakeAdapter();
      const p = pumpOf(store, adapter);
      const s = await p.pump.runPass(T0);
      assert.deepStrictEqual([s.outcome, s.paid, s.failed, s.retries], ["DONE", 1, 0, 0]);
      assert.deepStrictEqual(payoutsOf(store).map((r) => [r.i, r.l, r.s, r.state]),
        [["DONE", "DONE", "DONE", "PAID"]]);
      const [isk, lp, std] = calls;
      assert.deepStrictEqual(isk[1], { characterId: 9001, amountIsk: 2000000, commandId: `lne:${key}:isk`,
        issuerCorporationId: null, systemId: 30000001, description: "Front job: Guristas in Jita",
        source: "lne-frontjobs" });
      assert.deepStrictEqual(lp[1], { characterId: 9001, amountLp: 500, issuerCorporationId: LP_CORP,
        commandId: `lne:${key}:lp` });
      assert.deepStrictEqual(std[1], { key: `lne:${key}:std`, characterId: 9001, factionId: CALDARI, rawChange: 0.005,
        reason: "FRONT_JOB" });
      assert.deepStrictEqual(std[2], { eventTypeId: 486, msgByReason: { FRONT_JOB: "Front job (Living New Eden)" } });
      assert.strictEqual(legKeyOf("fj:1:0:5:7", "std"), "lne:fj:1:0:5:7:std");
      assert.deepStrictEqual(credits.map((c) => c[0]), ["isk", "lp", "std"]);
      assert.strictEqual(p.counters.payoutsPaid, 1);
      await p.pump.runPass(T0 + 1000);
      assert.strictEqual(calls.length, 3, "a PAID row never returns to the pump");
    }));

  needsDriver("FP2 crash between the vendor and the marker: retry = vendor duplicate on every leg, one credit", () =>
    H.withStore(driver, async (reopen) => {
      const { store } = reopen();
      seed(store, job(0, T0), [9001]);
      const { adapter, credits } = fakeAdapter();
      const crashing = { limits: store.limits, transaction: (name, fn) => (name === "frontJobs.payoutMark"
        ? { ok: false, reason: "TX_FAILED", error: new Error("crash") } : store.transaction(name, fn)) };
      const first = pumpOf(crashing, adapter);
      const s1 = await first.pump.runPass(T0);
      assert.deepStrictEqual([s1.paid, s1.markFailed], [0, 1]);
      assert.deepStrictEqual(payoutsOf(store).map((r) => r.state), ["PENDING"]);
      const second = pumpOf(store, adapter);
      const s2 = await second.pump.runPass(T0 + 1);
      assert.strictEqual(s2.paid, 1);
      assert.deepStrictEqual(payoutsOf(store).map((r) => [r.i, r.l, r.s, r.state]),
        [["DONE", "DONE", "DONE", "PAID"]]);
      assert.deepStrictEqual(credits.map((c) => c[0]), ["isk", "lp", "std"], "one credit per leg");
      assert.strictEqual(second.counters.legDuplicates, 3);
    }));

  needsDriver("FP3 transient LP -> backoff, ISK + standing DONE; permanent -> FAILED; standing key reused", () =>
    H.withStore(driver, async (reopen) => {
      const { store } = reopen();
      const [k1, k2] = seed(store, job(0, T0), [9001, 9002]);
      const { adapter, credits, fail } = fakeAdapter();
      fail.lp.set(9001, { ok: false, reason: "LP_AMBIGUOUS", permanent: false, detail: "LP_WALLET_FLUSH_FAILED" });
      fail.std.set(9002, { ok: false, reason: "IDEMPOTENCY_KEY_REUSED", permanent: true,
        detail: "IDEMPOTENCY_KEY_REUSED" });
      const p = pumpOf(store, adapter);
      let s = await p.pump.runPass(T0);
      assert.deepStrictEqual([s.paid, s.failed, s.retries], [0, 1, 1]);
      let rows = payoutsOf(store);
      const byKey = (k) => rows.find((r) => r.k === k);
      assert.deepStrictEqual([byKey(k1).i, byKey(k1).l, byKey(k1).s, byKey(k1).state, byKey(k1).a, byKey(k1).n],
        ["DONE", "PENDING", "DONE", "PENDING", 1, T0 + 60000]);
      assert.deepStrictEqual([byKey(k2).i, byKey(k2).l, byKey(k2).s, byKey(k2).state], ["DONE", "DONE", "FAILED",
        "FAILED"]);
      assert.strictEqual(p.counters.keyReused, 1);
      fail.lp.set(9001, { ok: false, reason: "INVALID_OWNER_OR_ISSUER", permanent: true });
      s = await p.pump.runPass(T0 + 60000);
      rows = payoutsOf(store);
      assert.deepStrictEqual([byKey(k1).i, byKey(k1).l, byKey(k1).s, byKey(k1).state], ["DONE", "FAILED", "DONE",
        "FAILED"]);
      assert.strictEqual(byKey(k1).e, "INVALID_OWNER_OR_ISSUER");
      assert.strictEqual(credits.filter((c) => c[1] === 9001 && c[0] === "isk").length, 1);
      assert.deepStrictEqual([p.counters.payoutsFailed, p.counters.legRetries], [2, 1]);
    }));

  needsDriver("FP4 payoutEnabled=false: no adapter call, prune old job + progress + closed payout, never PENDING", () =>
    H.withStore(driver, async (reopen) => {
      const { store } = reopen();
      const old = T0 - 8 * DAY;
      const repo = createFrontJobRepository();
      seed(store, job(0, old, { iskAmount: 0, lpAmount: 0, standingMicro: 0 }), [9001], T0 - 31 * DAY);
      tx(store, (db) => {
        assert.ok(repo.writeProgressInTx(db, { jobId: `fj:1:0:${old}`, characterId: 9002, progress: 3,
          state: "ACTIVE", at: old }).ok);
        db.prepare("UPDATE world_front_jobs SET state = 'EXPIRED'").run();
      });
      const [pending] = seed(store, job(1, old), [9003], T0 - 31 * DAY);
      const { adapter, calls } = fakeAdapter();
      const off = pumpOf(store, adapter, { payoutEnabled: false });
      const s = await off.pump.runPass(T0);
      assert.deepStrictEqual([s.outcome, calls.length, s.pruned], ["DONE", 0, 3]);
      const left = tx(store, (db) => ({ jobs: db.prepare("SELECT job_id AS j, state FROM world_front_jobs").all(),
        progress: db.prepare("SELECT count(*) AS n FROM world_front_job_progress").get().n }));
      assert.deepStrictEqual([left.jobs.map((r) => [r.j, r.state]), left.progress],
        [[[`fj:1:1:${old}`, "OPEN"]], 0]);
      assert.deepStrictEqual(payoutsOf(store).map((r) => [r.k, r.state]), [[pending, "PENDING"]]);
      adapter.seams = false;
      const on = pumpOf(store, adapter);
      const m = await on.pump.runPass(T0);
      assert.deepStrictEqual([m.outcome, calls.length, on.counters.seamsMissing], ["SEAMS_MISSING", 0, 1]);
      assert.ok(on.pump.getStatus().lastRefusal.startsWith("frontJobs.payoutSeams"), on.pump.getStatus().lastRefusal);
      assert.deepStrictEqual(payoutsOf(store).map((r) => r.state), ["PENDING"]);
    }));

  needsDriver("FP6 standing seam missing: ISK + LP paid, standing leg PENDING without an attempt, never FAILED", () =>
    H.withStore(driver, async (reopen) => {
      const { store } = reopen();
      seed(store, job(0, T0), [9001]);
      const { adapter, calls } = fakeAdapter();
      adapter.checkStandingWrite = () => ({ ok: false, reason: "applyStandingChanges_not_a_function" });
      const p = pumpOf(store, adapter, { payoutMaxAttempts: 1 });
      const s = await p.pump.runPass(T0);
      assert.deepStrictEqual([s.paid, s.failed, s.retries], [0, 0, 0]);
      assert.deepStrictEqual(payoutsOf(store).map((r) => [r.i, r.l, r.s, r.state, r.a, r.n]),
        [["DONE", "DONE", "PENDING", "PENDING", 0, T0 + 60000]]);
      assert.deepStrictEqual(calls.map((c) => c[0]), ["isk", "lp"], "no standing call");
      assert.strictEqual(p.pump.getStatus().standingMissing, true);
      adapter.checkStandingWrite = () => ({ ok: true });
      await p.pump.runPass(T0 + 60000);
      assert.deepStrictEqual(payoutsOf(store).map((r) => [r.s, r.state, r.a]), [["DONE", "PAID", 0]]);
    }));
};
