"use strict";

const assert = require("node:assert");

const { createPayoutPump, legKeyOf } = require("../../lib/world/liberation/payoutPump");
const { createRewardRepository } = require("../../lib/world/liberation/rewardRepository");
const { harness: H } = require("../battle/settlement.test");

const T0 = 1_800_000_000_000;
const DAY = 86400000;
const PARAMS = Object.freeze({ payoutEnabled: true, payoutMaxPerPass: 8, payoutMaxAttempts: 3, payoutRetryBaseMs: 60000,
  payoutRetryMaxMs: 900000, payoutRetentionMs: 30 * DAY, rewardPrunePerPass: 64, rewardContributionWindowMs: DAY });

function fakeAdapter() {
  const receipts = new Map();
  const credits = [];
  const a = {
    seams: true,
    failIsk: new Map(),
    failLp: new Map(),
    calls: 0,
    rewardSeams: () => (a.seams ? { ok: true } : { ok: false, missing: ["services/account/walletState: drift"] }),
    async rewardCreditIsk(spec) {
      a.calls += 1;
      const f = a.failIsk.get(spec.characterId);
      if (f) return f;
      if (receipts.has(spec.commandId)) return { ok: true, duplicate: true, fingerprintMismatch: false };
      receipts.set(spec.commandId, spec);
      credits.push(["isk", spec.characterId, spec.amountIsk, spec.commandId]);
      return { ok: true, duplicate: false, fingerprintMismatch: false };
    },
    rewardCreditLp(spec) {
      a.calls += 1;
      const f = a.failLp.get(spec.characterId);
      if (f) return f;
      if (receipts.has(spec.commandId)) return { ok: true, duplicate: true };
      receipts.set(spec.commandId, spec);
      credits.push(["lp", spec.characterId, spec.amountLp, spec.commandId]);
      return { ok: true, duplicate: false };
    },
  };
  return { adapter: a, credits };
}

function pumpOf(store, adapter, over = {}) {
  const counters = {};
  let stopped = false;
  const pump = createPayoutPump({ store, repo: createRewardRepository(), adapter, params: { ...PARAMS, ...over },
    getGovernor: over.governor ? () => over.governor : undefined,
    count: (name, n = 1) => { counters[name] = (counters[name] || 0) + n; }, isStopped: () => stopped });
  return { pump, counters, stop: () => { stopped = true; } };
}

const row = (sys, char, isk, lp, lpCorp = 1000035) => ({ payoutKey: `libpay:${sys}:0:${T0}:${char}`,
  liberationKey: `libpay:${sys}:0:${T0}`, systemId: sys, characterId: char, controllerFactionId: 500010,
  beneficiaryFactionId: lpCorp ? 500001 : null, lpCorporationId: lpCorp, kills: 5, iskAmount: isk, lpAmount: lp,
  description: `Living New Eden: liberation of ${sys}` });

function tx(store, fn) {
  const r = store.transaction("test", fn);
  assert.ok(r.ok, JSON.stringify(r));
  return r.value;
}

const rowsOf = (store) => tx(store, (db) => db.prepare(`SELECT payout_key AS k, isk_state AS i, lp_state AS l,
  state AS s, attempts AS a, next_attempt_at AS n, last_error AS e FROM world_liberation_payouts ORDER BY payout_key`)
  .all());

function seed(store, rows, now = T0) {
  const r = tx(store, (db) => createRewardRepository().insertPayoutsInTx(db, rows, now));
  assert.ok(r.ok, JSON.stringify(r));
}

module.exports = ({ test, skip }) => {
  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  needsDriver("PP1 payout pump happy path: both legs DONE, row PAID, deterministic vendor keys, nothing twice", () =>
    H.withStore(driver, async (reopen) => {
      const { store } = reopen();
      seed(store, [row(30000001, 7, 1000, 40), row(30000001, 8, 500, 0)]);
      const { adapter, credits } = fakeAdapter();
      const p = pumpOf(store, adapter);
      const s = await p.pump.runPass(T0);
      assert.deepStrictEqual([s.outcome, s.paid, s.failed, s.retries], ["DONE", 2, 0, 0]);
      assert.deepStrictEqual(rowsOf(store).map((r) => [r.i, r.l, r.s, r.a]), [["DONE", "DONE", "PAID", 0],
        ["DONE", "SKIPPED", "PAID", 0]]);
      assert.deepStrictEqual(credits, [["isk", 7, 1000, `lne:libpay:30000001:0:${T0}:7:isk`],
        ["lp", 7, 40, `lne:libpay:30000001:0:${T0}:7:lp`], ["isk", 8, 500, `lne:libpay:30000001:0:${T0}:8:isk`]]);
      assert.strictEqual(legKeyOf(`libpay:1:2:3:4`, "lp"), "lne:libpay:1:2:3:4:lp");
      assert.strictEqual(p.counters.payoutsPaid, 2);
      const calls = adapter.calls;
      await p.pump.runPass(T0 + 1000);
      assert.strictEqual(adapter.calls, calls, "a PAID row never returns to the pump");
    }));

  needsDriver("PP2 crash between the vendor and the marker: the retry is a vendor duplicate, one credit per leg", () =>
    H.withStore(driver, async (reopen) => {
      const { store } = reopen();
      seed(store, [row(30000002, 7, 1000, 40)]);
      const { adapter, credits } = fakeAdapter();
      const crashing = { transaction: (name, fn) => (name === "liberation.payoutMark"
        ? { ok: false, reason: "TX_FAILED", error: new Error("crash") } : store.transaction(name, fn)) };
      const first = pumpOf(crashing, adapter);
      const s1 = await first.pump.runPass(T0);
      assert.deepStrictEqual([s1.paid, s1.markFailed], [0, 1]);
      assert.deepStrictEqual(rowsOf(store).map((r) => [r.i, r.l, r.s]), [["PENDING", "PENDING", "PENDING"]]);
      const second = pumpOf(store, adapter);
      const s2 = await second.pump.runPass(T0 + 1);
      assert.strictEqual(s2.paid, 1);
      assert.deepStrictEqual(rowsOf(store).map((r) => [r.i, r.l, r.s]), [["DONE", "DONE", "PAID"]]);
      assert.deepStrictEqual(credits.map((c) => c[0]), ["isk", "lp"], "one credit per leg");
      assert.strictEqual(second.counters.payoutDuplicates, 2);
    }));

  needsDriver("PP3 permanent ISK failure: LP still paid, row FAILED; transient LP failure: backoff, FAILED at the "
    + "attempt limit", () =>
    H.withStore(driver, async (reopen) => {
      const { store } = reopen();
      seed(store, [row(30000003, 7, 1000, 40), row(30000003, 8, 600, 30)]);
      const { adapter, credits } = fakeAdapter();
      adapter.failIsk.set(7, { ok: false, reason: "CHARACTER_NOT_FOUND", permanent: true });
      adapter.failLp.set(8, { ok: false, reason: "LP_AMBIGUOUS", permanent: false, detail: "LP_WALLET_FLUSH_FAILED" });
      const p = pumpOf(store, adapter);
      let s = await p.pump.runPass(T0);
      assert.deepStrictEqual([s.paid, s.failed, s.retries], [0, 1, 1]);
      let rows = rowsOf(store);
      assert.deepStrictEqual(rows.map((r) => [r.i, r.l, r.s, r.a]), [["FAILED", "DONE", "FAILED", 0],
        ["DONE", "PENDING", "PENDING", 1]]);
      assert.strictEqual(rows[0].e, "CHARACTER_NOT_FOUND");
      assert.deepStrictEqual([rows[1].n, rows[1].e], [T0 + 60000, "LP_AMBIGUOUS:LP_WALLET_FLUSH_FAILED"]);
      assert.deepStrictEqual(credits.map((c) => [c[0], c[1]]), [["lp", 7], ["isk", 8]]);
      const calls = adapter.calls;
      await p.pump.runPass(T0 + 59999);
      assert.strictEqual(adapter.calls, calls);
      await p.pump.runPass(T0 + 60000);
      rows = rowsOf(store);
      assert.deepStrictEqual([rows[1].a, rows[1].n, rows[1].s], [2, T0 + 60000 + 120000, "PENDING"]);
      s = await p.pump.runPass(T0 + 180000);
      rows = rowsOf(store);
      assert.deepStrictEqual([rows[1].i, rows[1].l, rows[1].s, rows[1].a], ["DONE", "FAILED", "FAILED", 3]);
      assert.deepStrictEqual([s.failed, p.counters.payoutsFailed, p.counters.payoutRetries], [1, 2, 2]);
      assert.strictEqual(credits.filter((c) => c[0] === "isk" && c[1] === 8).length, 1, "the DONE leg is not repeated");
    }));

  needsDriver("PP4 seams missing -> rows wait PENDING; governor refusal -> deferred; prune of old closed rows and "
    + "contributions outside the window", () =>
    H.withStore(driver, async (reopen) => {
      const { store } = reopen();
      seed(store, [row(30000004, 7, 1000, 40)]);
      seed(store, [{ ...row(30000005, 9, 10, 0), payoutKey: "libpay:old:9" }], T0 - 40 * DAY);
      tx(store, (db) => {
        db.prepare(`UPDATE world_liberation_payouts SET state = 'PAID', isk_state = 'DONE'
          WHERE payout_key = 'libpay:old:9'`).run();
        const ins = db.prepare(`INSERT INTO world_liberation_contributions (system_id, controller_faction_id,
          character_id, kills, first_at, last_at) VALUES (?, 500010, ?, 3, ?, ?)`);
        ins.run(30000004, 7, T0 - 2 * DAY, T0 - 2 * DAY);
        ins.run(30000004, 8, T0 - 1000, T0 - 1000);
      });
      const { adapter } = fakeAdapter();
      adapter.seams = false;
      const lines = [];
      const counters = {};
      const pump = createPayoutPump({ store, repo: createRewardRepository(), adapter, params: PARAMS,
        count: (n, k = 1) => { counters[n] = (counters[n] || 0) + k; }, log: (l) => lines.push(l),
        isStopped: () => false });
      let s = await pump.runPass(T0);
      assert.deepStrictEqual([s.outcome, adapter.calls], ["SEAMS_MISSING", 0]);
      assert.deepStrictEqual(rowsOf(store).map((r) => [r.k, r.s]), [[`libpay:30000004:0:${T0}:7`, "PENDING"]],
        "the old PAID row is pruned (retention), the PENDING row waits");
      assert.ok(lines.some((l) => l.includes("payout seams missing")), lines.join("\n"));
      assert.ok(pump.getStatus().seamsMissing && pump.getStatus().lastRefusal.startsWith("liberation.payoutSeams"));
      const left = tx(store, (db) => db.prepare(`SELECT character_id AS c FROM world_liberation_contributions`).all());
      assert.deepStrictEqual(left, [{ c: 8 }], "The contribution outside the window is pruned");
      assert.deepStrictEqual([counters.payoutsPruned, counters.contributionsPruned], [1, 1]);
      const g = pumpOf(store, { ...adapter, seams: true }, { governor: { admits: (c) => c !== "MAINTENANCE" } });
      s = await g.pump.runPass(T0);
      assert.deepStrictEqual([s.outcome, g.counters.payoutDeferred, adapter.calls], ["DEFERRED", 1, 0]);
      adapter.seams = true;
      s = await pump.runPass(T0 + 1);
      assert.deepStrictEqual([s.paid, rowsOf(store)[0].s], [1, "PAID"]);
    }));
};
