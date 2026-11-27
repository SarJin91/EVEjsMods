"use strict";

const assert = require("node:assert");
const path = require("node:path");

const { resolveConfig } = require("../../config");
const R = require("../../lib/situations/repository");
const S = require("../../lib/situations/schema");
const { createSituationPayoutPump } = require("../../lib/situations/payouts");
const { createJournal } = require("../../lib/persistence/journal");
const { loadDriver, withStoreAsync } = require("../notices/storeHelper");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const T0 = 1763500000000;
const SYS = 30000144;
const HELPER = 140000042;

function settings(over) {
  const r = resolveConfig({ modDir: MOD_DIR, env: {} });
  const parsed = S.situationsSettingsOf({ situations: { ...r.config.situations, enabled: true, rewardsEnabled: true,
    ...(over || {}) } });
  assert.ok(parsed.ok, JSON.stringify(parsed));
  return parsed.settings;
}

function fakeVendor() {
  const v = { isk: [], std: [], receipts: new Set(), balance: 0, stdReceipts: new Map(), stdAnswer: null };
  v.rewardCreditIsk = async (spec) => {
    v.isk.push(spec);
    if (v.receipts.has(spec.commandId)) return { ok: true, duplicate: true };
    v.receipts.add(spec.commandId);
    v.balance += spec.amountIsk;
    return { ok: true, duplicate: false };
  };
  v.applyStandingGrant = (grant, data) => {
    v.std.push({ grant, data });
    if (v.stdAnswer) return v.stdAnswer(grant);
    if (v.stdReceipts.has(grant.key)) return { ok: true, outcome: "DUPLICATE" };
    v.stdReceipts.set(grant.key, grant.rawChange);
    return { ok: true, outcome: "APPLIED" };
  };
  return v;
}

function rescued(opened, journal, id, bucket, reward, helpers) {
  const r = opened.store.transaction("si3.make", (t) => {
    const s = R.startInTx(t, journal, { situationId: id, kind: "BELT_RAID", systemId: SYS, bucket, anchorKind: "belt",
      anchorId: 40001, speakerId: 90000001, pirateFactionId: 500010, victims: 2, bootAt: T0 }, T0);
    assert.ok(s.ok, JSON.stringify(s));
    return R.settleInTx(t, journal, s.situation, "RESCUED", { endReason: "PIRATES_DOWN", saved: 2,
      helpers: helpers || [HELPER], reward }, T0 + 1000);
  });
  assert.ok(r.ok && r.value.ok, JSON.stringify(r));
  return r.value;
}

function payoutOf(opened, key) {
  return opened.store.transaction("si3.read", (t) => ({ ok: true, p: R.getPayoutInTx(t, key) })).value.p;
}

function pumpOf(opened, P, vendor, isStopped) {
  const counters = {};
  const pump = createSituationPayoutPump({ store: opened.store, settings: P, rewardCreditIsk: vendor.rewardCreditIsk,
    applyStandingGrant: vendor.applyStandingGrant, bump: (n, k = 1) => { counters[n] = (counters[n] || 0) + k; },
    log() {}, isStopped: isStopped || (() => false) });
  assert.strictEqual(pump.boot().ok, true);
  return { pump, counters };
}

module.exports = ({ test, skip }) => {
  const driver = loadDriver();
  if (!driver.ok) {
    skip("SI3 situation payouts on a store", `better-sqlite3 unavailable (${driver.detail})`);
    return;
  }

  test("SI3 a payout is paid once (crash -> duplicate -> PAID); standing leg SKIPPED / once / KEY_REUSED -> FAILED; "
    + "day limit -> capped, no row", async () => {
    await withStoreAsync(driver, async (opened) => {
      const journal = createJournal({ clock: { now: () => T0 }, maxPayloadBytes: 4096, maxRows: 500 });
      const P = settings();
      const reward = { iskPerSaved: P.rewardIskPerSaved, standingMicro: 0, standingFactionId: 500014, maxPerDay: 3 };
      const a = rescued(opened, journal, "sa-1", 1, reward);
      const key = a.payoutKeys[0];
      const vendor = fakeVendor();
      const off = pumpOf(opened, settings({ rewardsEnabled: false }), vendor);
      await off.pump.runPayoutPass(T0 + 2000);
      assert.strictEqual(vendor.isk.length, 0, "rewardsEnabled off -> no vendor call");
      let stopped = false;
      const crash = pumpOf(opened, P, { rewardCreditIsk: async (spec) => {
        const r = await vendor.rewardCreditIsk(spec);
        stopped = true;
        return r;
      }, applyStandingGrant: vendor.applyStandingGrant }, () => stopped);
      assert.strictEqual((await crash.pump.runPayoutPass(T0 + 3000)).ok, false);
      assert.strictEqual(payoutOf(opened, key).state, "PENDING", "marker not written after the stop");
      const again = pumpOf(opened, P, vendor);
      assert.deepStrictEqual(await again.pump.runPayoutPass(T0 + 4000), { ok: true, paid: 1, failed: 0, retried: 0 });
      const p = payoutOf(opened, key);
      assert.deepStrictEqual([p.state, p.iskState, p.stdState, vendor.balance, again.counters.payoutDuplicates],
        ["PAID", "DONE", "SKIPPED", 2 * P.rewardIskPerSaved, 1]);
      assert.deepStrictEqual([vendor.isk[0].commandId, vendor.isk[0].description, vendor.std.length],
        [`lne:${key}:isk`, S.PAYOUT_DESCRIPTION, 0]);
      const calls = vendor.isk.length;
      await again.pump.runPayoutPass(T0 + 9000);
      assert.strictEqual(vendor.isk.length, calls, "a second pass pays nothing");

      const withStd = { ...reward, standingMicro: 2000 };
      const b = rescued(opened, journal, "sa-2", 2, withStd, [HELPER + 1]);
      const pumpB = pumpOf(opened, P, vendor);
      await pumpB.pump.runPayoutPass(T0 + 10000);
      const pb = payoutOf(opened, b.payoutKeys[0]);
      assert.deepStrictEqual([pb.state, pb.stdState, vendor.stdReceipts.get(`lne:${b.payoutKeys[0]}:std`)],
        ["PAID", "DONE", 0.002]);
      assert.deepStrictEqual([vendor.std[0].grant.factionId, vendor.std[0].data], [500014, S.STANDING_DATA]);
      const c = rescued(opened, journal, "sa-3", 3, withStd, [HELPER + 2]);
      vendor.stdAnswer = () => ({ ok: false, reason: "IDEMPOTENCY_KEY_REUSED", permanent: true });
      const pumpC = pumpOf(opened, P, vendor);
      await pumpC.pump.runPayoutPass(T0 + 11000);
      const pc = payoutOf(opened, c.payoutKeys[0]);
      assert.deepStrictEqual([pc.state, pc.iskState, pc.stdState], ["FAILED", "DONE", "FAILED"]);

      const d = rescued(opened, journal, "sa-4", 4, { ...reward, maxPerDay: 0 }, [HELPER + 3]);
      assert.deepStrictEqual([d.planned, d.capped, d.payoutKeys], [0, 1, []]);
    });
  });
};
