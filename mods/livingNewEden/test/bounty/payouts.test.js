"use strict";

const assert = require("node:assert");
const os = require("node:os");
const path = require("node:path");

const config = require("../../config");
const R = require("../../lib/bounty/repository");
const S = require("../../lib/bounty/schema");
const { createBountyPayoutPump } = require("../../lib/bounty/payouts");
const { TABLE_POLICY, ACTION } = require("../../lib/persistence/worldReset");
const { loadDriver, withStoreAsync } = require("../notices/storeHelper");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const T0 = 1760000000000;
const KILLER = 140000042;

let base = null;
function settings(over = {}) {
  if (!base) {
    const r = config.resolveConfig({ modDir: MOD_DIR, env: { EVEJS_DATA_ROOT: os.tmpdir() } });
    assert.deepStrictEqual(r.errors || [], []);
    base = r.config.bountyHunters;
  }
  return { ...base, enabled: true, liveEnabled: true, payoutEnabled: true, ...over };
}

function fakeWallet() {
  const w = { calls: [], receipts: new Set(), balance: new Map(), answer: null };
  w.rewardCreditIsk = async (spec) => {
    w.calls.push(spec);
    if (w.answer) return w.answer(spec);
    if (w.receipts.has(spec.commandId)) return { ok: true, duplicate: true, fingerprintMismatch: false };
    w.receipts.add(spec.commandId);
    w.balance.set(spec.characterId, (w.balance.get(spec.characterId) || 0) + spec.amountIsk);
    return { ok: true, duplicate: false, fingerprintMismatch: false };
  };
  return w;
}

function killOne(opened, slot, at, killAt) {
  const r = opened.store.transaction("pt.kill", (tx) => {
    const made = R.createInTx(tx, { slot, cycle: 1, factionId: 500010, characterId: 91000000 + slot, level: 2,
      archetype: "BRAWLER", smuggler: 0, systemId: 30000100 + slot, nextMoveAt: at + 3600000,
      expiresAt: at + 86400000, rewardIsk: 12000000, seed: 7 + slot }, at);
    assert.ok(made.ok, JSON.stringify(made));
    const live = R.markLiveInTx(tx, made.target, at);
    assert.ok(live.ok, JSON.stringify(live));
    const k = R.killInTx(tx, live.target.wantedId, live.target.version, KILLER, killAt);
    assert.ok(k.ok, JSON.stringify(k));
    return { wantedId: k.target.wantedId, key: k.payout.payoutKey, planned: k.payout.planned };
  });
  assert.ok(r.ok, JSON.stringify(r));
  return r.value;
}

function payoutOf(opened, key) {
  const r = opened.store.transaction("pt.read", (tx) => R.getPayoutInTx(tx, key));
  assert.ok(r.ok, JSON.stringify(r));
  return r.value;
}

function pumpOf(opened, P, wallet, opts = {}) {
  const counters = {};
  const txNames = [];
  const store = { ...opened.store, transaction(name, fn) {
    txNames.push(name);
    return opened.store.transaction(name, fn);
  } };
  const pump = createBountyPayoutPump({ store, settings: P, rewardCreditIsk: wallet.rewardCreditIsk,
    bump: (n, k = 1) => { counters[n] = (counters[n] || 0) + k; }, log() {},
    isStopped: opts.isStopped || (() => false) });
  assert.strictEqual(pump.boot().ok, true);
  return { pump, counters, txNames };
}

module.exports = ({ test, skip }) => {
  const driver = loadDriver();
  if (!driver.ok) {
    skip("P1/P2/P5 bounty payouts on a store", `better-sqlite3 unavailable (${driver.detail})`);
    return;
  }

  test("P1 payoutEnabled off -> PENDING, no wallet call; on -> PAID with commandId lne:bounty:<id>:<created_at>",
    async () => {
      await withStoreAsync(driver, async (opened) => {
        const { wantedId, key, planned } = killOne(opened, 1, T0, T0 + 5000);
        assert.strictEqual(key, `lne:bounty:${wantedId}:${T0}`);
        assert.strictEqual(planned, true);
        const wallet = fakeWallet();
        const off = pumpOf(opened, settings({ payoutEnabled: false }), wallet);
        assert.deepStrictEqual(await off.pump.runPayoutPass(T0 + 10000), { ok: true, paid: 0, failed: 0, retried: 0 });
        assert.deepStrictEqual([wallet.calls.length, payoutOf(opened, key).state], [0, "PENDING"]);
        const on = pumpOf(opened, settings(), wallet);
        assert.strictEqual(on.pump.status().pending, 1);
        const r = await on.pump.runPayoutPass(T0 + 15000);
        assert.deepStrictEqual(r, { ok: true, paid: 1, failed: 0, retried: 0 });
        const [spec] = wallet.calls;
        assert.deepStrictEqual([spec.commandId, spec.characterId, spec.amountIsk, spec.systemId, spec.description,
          spec.source], [key, KILLER, 12000000, 30000101, S.PAYOUT_DESCRIPTION, S.ISK_SOURCE]);
        const p = payoutOf(opened, key);
        assert.deepStrictEqual([p.state, p.settledAt], ["PAID", T0 + 15000]);
        const t = opened.store.transaction("pt.t", (tx) => ({ ...tx.prepare("SELECT payout_state AS s FROM "
          + "world_bounty_targets WHERE wanted_id = ?").get(wantedId) }));
        assert.strictEqual(t.value.s, "PAID", "the mirror follows");
        assert.strictEqual(on.counters.paid, 1);
      });
    });

  test("P2 crash after the credit -> duplicate -> PAID (balance + 1x); permanent -> FAILED; attempt limit -> FAILED; "
    + "0 pending -> no transaction", async () => {
    await withStoreAsync(driver, async (opened) => {
      const a = killOne(opened, 1, T0, T0 + 5000);
      const wallet = fakeWallet();
      let stopped = false;
      const crash = pumpOf(opened, settings(), { rewardCreditIsk: async (spec) => {
        const r = await wallet.rewardCreditIsk(spec);
        stopped = true;
        return r;
      } }, { isStopped: () => stopped });
      assert.strictEqual((await crash.pump.runPayoutPass(T0 + 10000)).ok, false);
      assert.strictEqual(payoutOf(opened, a.key).state, "PENDING", "result not written after the stop");
      const again = pumpOf(opened, settings(), wallet);
      assert.deepStrictEqual(await again.pump.runPayoutPass(T0 + 20000), { ok: true, paid: 1, failed: 0, retried: 0 });
      assert.deepStrictEqual([payoutOf(opened, a.key).state, wallet.balance.get(KILLER), again.counters.payDuplicate],
        ["PAID", 12000000, 1]);
      const before = again.txNames.length;
      await again.pump.runPayoutPass(T0 + 25000);
      assert.deepStrictEqual(again.txNames.slice(before), [], "pending 0 -> no transaction");

      const b = killOne(opened, 2, T0, T0 + 30000);
      const perm = fakeWallet();
      perm.answer = () => ({ ok: false, reason: "CHARACTER_NOT_FOUND", permanent: true });
      const pp = pumpOf(opened, settings(), perm);
      assert.deepStrictEqual(await pp.pump.runPayoutPass(T0 + 31000), { ok: true, paid: 0, failed: 1, retried: 0 });
      assert.deepStrictEqual([payoutOf(opened, b.key).state, payoutOf(opened, b.key).lastReason],
        ["FAILED", "CHARACTER_NOT_FOUND"]);

      const c = killOne(opened, 3, T0, T0 + 40000);
      const flaky = fakeWallet();
      flaky.answer = () => ({ ok: false, reason: "WALLET_FAILED", permanent: false, detail: "busy" });
      const fp = pumpOf(opened, settings({ payoutMaxAttempts: 2 }), flaky);
      assert.deepStrictEqual(await fp.pump.runPayoutPass(T0 + 41000), { ok: true, paid: 0, failed: 0, retried: 1 });
      assert.deepStrictEqual([payoutOf(opened, c.key).state, payoutOf(opened, c.key).attempts], ["PENDING", 1]);
      assert.deepStrictEqual(payoutOf(opened, c.key).nextAttemptAt, T0 + 41000 + settings().payoutRetryBaseMs);
      assert.deepStrictEqual(await fp.pump.runPayoutPass(T0 + 46000), { ok: true, paid: 0, failed: 0, retried: 0 });
      assert.strictEqual(flaky.calls.length, 1, "no wallet call inside the backoff");
      assert.deepStrictEqual(await fp.pump.runPayoutPass(T0 + 41000 + settings().payoutRetryBaseMs),
        { ok: true, paid: 0, failed: 1, retried: 0 });
      assert.deepStrictEqual([payoutOf(opened, c.key).state, payoutOf(opened, c.key).attempts], ["FAILED", 2]);
    });
  });

  test("P5 world reset: targets WIPE, payouts KEEP; old PENDING paid after the reset; a new bnt:1:1 is a new credit",
    async () => {
      assert.deepStrictEqual([TABLE_POLICY.world_bounty_targets, TABLE_POLICY.world_bounty_payouts],
        [ACTION.WIPE, ACTION.KEEP]);
      await withStoreAsync(driver, async (opened) => {
        const wallet = fakeWallet();
        const old = killOne(opened, 1, T0, T0 + 5000);
        const first = pumpOf(opened, settings(), wallet);
        await first.pump.runPayoutPass(T0 + 6000);
        assert.strictEqual(payoutOf(opened, old.key).state, "PAID");
        const pendingOld = killOne(opened, 2, T0, T0 + 7000);
        const wipe = opened.store.transaction("pt.wipe", (tx) => tx.prepare("DELETE FROM world_bounty_targets").run());
        assert.ok(wipe.ok);
        const T1 = T0 + 9 * 86400000;
        const fresh = killOne(opened, 1, T1, T1 + 5000);
        assert.strictEqual(fresh.wantedId, old.wantedId, "the same wanted id in the new world");
        assert.notStrictEqual(fresh.key, old.key);
        const after = pumpOf(opened, settings(), wallet);
        assert.strictEqual(after.pump.status().pending, 2);
        assert.deepStrictEqual(await after.pump.runPayoutPass(T1 + 6000), { ok: true, paid: 2, failed: 0, retried: 0 });
        assert.deepStrictEqual([payoutOf(opened, pendingOld.key).state, payoutOf(opened, fresh.key).state],
          ["PAID", "PAID"]);
        assert.strictEqual(wallet.balance.get(KILLER), 3 * 12000000, "three credits, no duplicate");
        assert.strictEqual(after.counters.payDuplicate, undefined);
      });
    });

  test("PB1 backoff: WALLET_FAILED x3 over passes every payoutPassMs -> PAID with attempts 3 (< limit), no "
    + "transaction inside the backoff; a new kill is due at once; SEAM_UNAVAILABLE uses no attempt", async () => {
    await withStoreAsync(driver, async (opened) => {
      const P = settings();
      const a = killOne(opened, 1, T0, T0 + 1000);
      const wallet = fakeWallet();
      let fails = 3;
      const answers = [];
      const base = wallet.rewardCreditIsk;
      const w = { rewardCreditIsk: async (spec) => {
        answers.push(spec.commandId);
        if (spec.commandId === a.key && fails > 0) {
          fails -= 1;
          return { ok: false, reason: "WALLET_FAILED", permanent: false, detail: "busy" };
        }
        return base(spec);
      } };
      const pp = pumpOf(opened, P, w);
      let now = T0 + 2000;
      const end = now + 8 * P.payoutRetryBaseMs;
      for (; now <= end && payoutOf(opened, a.key).state === "PENDING"; now += P.payoutPassMs) {
        await pp.pump.runPayoutPass(now);
      }
      const pa = payoutOf(opened, a.key);
      assert.deepStrictEqual([pa.state, pa.attempts, answers.length], ["PAID", 3, 4]);
      assert.ok(pa.attempts < P.payoutMaxAttempts);
      assert.strictEqual(pp.txNames.filter((n) => n === "bounty.payoutRead").length, 4,
        "one read per due attempt, none inside the backoff");
      assert.ok(now - P.payoutPassMs >= T0 + 2000 + 7 * P.payoutRetryBaseMs);

      const b = killOne(opened, 2, T0, now);
      const c = killOne(opened, 3, T0, now);
      const seam = { bCalls: 0, rewardCreditIsk: async (spec) => {
        if (spec.commandId === b.key) seam.bCalls += 1;
        if (spec.commandId === b.key && seam.bCalls <= 2) {
          return { ok: false, reason: "SEAM_UNAVAILABLE", permanent: false };
        }
        if (spec.commandId === c.key) return { ok: false, reason: "WALLET_FAILED", permanent: false };
        return base(spec);
      } };
      const sp = pumpOf(opened, settings({ payoutBatch: 1 }), seam);
      await sp.pump.runPayoutPass(now + 1000);
      assert.deepStrictEqual([payoutOf(opened, b.key).attempts, payoutOf(opened, b.key).nextAttemptAt],
        [0, now + 1000 + P.payoutRetryBaseMs]);
      await sp.pump.runPayoutPass(now + 2000);
      assert.strictEqual(payoutOf(opened, c.key).attempts, 1);
      const d = killOne(opened, 4, T0, now + 3000);
      sp.pump.notePlanned();
      await sp.pump.runPayoutPass(now + 3000);
      assert.strictEqual(payoutOf(opened, d.key).state, "PAID", "the new kill is paid while b and c wait");
      let t = now + 1000 + P.payoutRetryBaseMs;
      for (let i = 0; i < 8 && payoutOf(opened, b.key).state === "PENDING"; i += 1, t += P.payoutRetryBaseMs) {
        await sp.pump.runPayoutPass(t);
      }
      assert.deepStrictEqual([payoutOf(opened, b.key).state, payoutOf(opened, b.key).attempts, seam.bCalls],
        ["PAID", 0, 3]);
    });
  });
};
