"use strict";

const assert = require("node:assert");

const R = require("../../lib/situations/repository");
const S = require("../../lib/situations/schema");
const { createJournal } = require("../../lib/persistence/journal");
const { MIGRATIONS } = require("../../lib/persistence/migrations");
const { TABLE_POLICY, ACTION } = require("../../lib/persistence/worldReset");
const { loadDriver, withStore } = require("../notices/storeHelper");

const T0 = 1763500000000;
const SYS = 30000144;
const BOOT_A = T0 - 60000;
const BOOT_B = T0;

function journalOf(clockAt) {
  return createJournal({ clock: { now: () => clockAt.now }, maxPayloadBytes: 4096, maxRows: 500 });
}

function spec(id, over) {
  return { situationId: id, kind: "BELT_RAID", systemId: SYS, bucket: 489861, anchorKind: "belt", anchorId: 40001,
    speakerId: 90000001, pirateFactionId: 500010, victims: 3, bootAt: BOOT_A, ...(over || {}) };
}

function run(opened, name, fn) {
  const r = opened.store.transaction(name, fn);
  assert.ok(r.ok, JSON.stringify(r));
  return r.value;
}

const REWARD = { iskPerSaved: 200000, standingMicro: 0, standingFactionId: 500014, maxPerDay: 3 };

module.exports = ({ test, skip }) => {
  const driver = loadDriver();
  if (!driver.ok) {
    skip("SI2 situations repository on a store", `better-sqlite3 unavailable (${driver.detail})`);
    return;
  }

  test("SI2 start duplicate per (system, bucket); second settle DUPLICATE without payout rows; cancelStale only "
    + "another boot", () => {
    assert.ok(MIGRATIONS.some((m) => m.version === 112 && m.up === S.upSituations), "migration 112");
    assert.deepStrictEqual([TABLE_POLICY.world_situations, TABLE_POLICY.world_situation_payouts],
      [ACTION.WIPE, ACTION.KEEP]);
    withStore(driver, (opened) => {
      const clockAt = { now: T0 };
      const journal = journalOf(clockAt);
      const idx = run(opened, "si2.idx", (t) => ({ ok: true, rows: t.prepare(`SELECT name, sql FROM sqlite_master
        WHERE type = 'index' AND tbl_name IN ('world_situations', 'world_situation_payouts') ORDER BY name`).all() }));
      const names = idx.rows.map((r) => r.name);
      for (const n of ["idx_situations_open", "idx_situations_ended", "idx_situation_payouts_due",
        "idx_situation_payouts_character"]) assert.ok(names.includes(n), n);
      assert.ok(idx.rows.find((r) => r.name === "idx_situations_open").sql.includes("WHERE state = 'OPEN'"));

      const a = run(opened, "si2.start", (t) => R.startInTx(t, journal, spec("sa-1"), T0));
      assert.strictEqual(a.situation.state, "OPEN");
      assert.deepStrictEqual(run(opened, "si2.dup", (t) => ({ ok: true, r: R.startInTx(t, journal, spec("sa-2"), T0) }))
        .r, { ok: false, reason: "DUPLICATE" }, "same (system, bucket), another id");
      assert.deepStrictEqual(run(opened, "si2.dup2", (t) => ({ ok: true,
        r: R.startInTx(t, journal, spec("sb-1", { bootAt: BOOT_B }), T0) })).r, { ok: false, reason: "DUPLICATE" },
      "another boot, same bucket");
      const other = run(opened, "si2.start2", (t) => R.startInTx(t, journal, spec("sa-3", { bucket: 489862 }), T0));
      const current = run(opened, "si2.start3", (t) => R.startInTx(t, journal,
        spec("sb-2", { bucket: 489863, bootAt: BOOT_B }), T0));

      const settled = run(opened, "si2.settle", (t) => R.settleInTx(t, journal, a.situation, "RESCUED",
        { endReason: "PIRATES_DOWN", saved: 2, helpers: [140000002, 140000001], reward: REWARD }, T0 + 5000));
      assert.deepStrictEqual([settled.situation.state, settled.situation.victimsSaved, settled.planned, settled.capped],
        ["RESCUED", 2, 2, 0]);
      assert.deepStrictEqual(settled.payoutKeys, ["sit:sa-1:140000001", "sit:sa-1:140000002"]);
      const p = run(opened, "si2.p", (t) => ({ ok: true, p: R.getPayoutInTx(t, "sit:sa-1:140000001") })).p;
      assert.deepStrictEqual([p.amountIsk, p.iskState, p.stdState, p.state], [400000, "PENDING", "SKIPPED", "PENDING"]);
      const again = run(opened, "si2.settle2", (t) => ({ ok: true, r: R.settleInTx(t, journal, a.situation, "RESCUED",
        { endReason: "PIRATES_DOWN", saved: 2, helpers: [140000002, 140000001], reward: REWARD }, T0 + 9000) })).r;
      assert.deepStrictEqual(again, { ok: false, reason: "DUPLICATE" });
      const count = run(opened, "si2.count", (t) => ({ ok: true, n: t.prepare(
        "SELECT COUNT(*) AS n FROM world_situation_payouts").get().n })).n;
      assert.strictEqual(Number(count), 2, "no new payout rows");
      const fact = run(opened, "si2.j", (t) => ({ ok: true, row: t.prepare(`SELECT aggregate_type, event_type, payload
        FROM world_event_journal WHERE idempotency_key = ?`).get("sit:sa-1:settle") })).row;
      assert.deepStrictEqual([fact.aggregate_type, fact.event_type], ["situation", "SITUATION_RESOLVED"]);
      assert.deepStrictEqual(JSON.parse(fact.payload),
        { kind: "BELT_RAID", outcome: "RESCUED", saved: 2, systemId: SYS, victims: 3 });
      assert.ok(!fact.payload.includes("14000000"), "no player id in the fact");

      const capRow = run(opened, "si2.cap", (t) => R.settleInTx(t, journal, other.situation, "RESCUED",
        { endReason: "PIRATES_DOWN", saved: 1, helpers: [140000001], reward: { ...REWARD, maxPerDay: 1 } }, T0 + 6000));
      assert.deepStrictEqual([capRow.planned, capRow.capped], [0, 1]);

      const cancel = run(opened, "si2.cancel", (t) => R.cancelStaleInTx(t, BOOT_B, T0 + 10000, 100));
      assert.strictEqual(cancel.cancelled, 0, "the only OPEN row is of the current boot");
      const stale = run(opened, "si2.start4", (t) => R.startInTx(t, journal, spec("sa-4", { bucket: 489864 }), T0));
      const c2 = run(opened, "si2.cancel2", (t) => R.cancelStaleInTx(t, BOOT_B, T0 + 11000, 100));
      assert.strictEqual(c2.cancelled, 1);
      const rows = run(opened, "si2.rows", (t) => ({ ok: true, a: R.getInTx(t, stale.situation.situationId),
        b: R.getInTx(t, current.situation.situationId) }));
      assert.deepStrictEqual([rows.a.state, rows.a.endReason, rows.b.state], ["CANCELLED", "RESTART", "OPEN"]);
    });
  });
};
