"use strict";

const assert = require("node:assert");

const { LATEST_SCHEMA_VERSION } = require("../../lib/persistence/migrations");
const { TABLE_POLICY, ACTION } = require("../../lib/persistence/worldReset");
const { createManualClock } = require("../../lib/util/clock");
const outboxModule = require("../../lib/freeCorps/outboxRepository");
const { planKillmail, backoffMs, spacingMs } = require("../../lib/freeCorps/killmails");
const { createKillmailPump } = require("../../lib/freeCorps/killmailPump");
const { writeVirtualKillmailWith } = require("../../lib/adapter/virtualKillmail");
const { TYPES } = require("../../lib/battle/data/strengthCatalog");
const { loadDriver, withStore } = require("../notices/storeHelper");
const H = require("./hunting.test").harness;

const KIND = "KILLMAIL";
const hullEhpOf = (typeId) => (TYPES[typeId] ? TYPES[typeId].ehp : null);

function fakeVendor() {
  const byEvent = new Map();
  const calls = [];
  let next = 41;
  const mod = { createKillmailRecordIdempotent(record, eventID) {
    calls.push(eventID);
    if (byEvent.has(eventID)) return { ...record, killID: byEvent.get(eventID) };
    const killID = next;
    next += 1;
    byEvent.set(eventID, killID);
    return { ...record, killID };
  } };
  return { byEvent, calls, write: (spec, eventId) => writeVirtualKillmailWith(mod, spec, eventId) };
}

const goodPayload = (n) => ({ v: 1, skirmishId: `fcs:fcv:1:${n}:1`, at: H.T0, systemId: H.L2, warId: null,
  victim: { characterId: 20, corporationId: 2, shipTypeId: 32880, damageTaken: 868 },
  attackers: [{ characterId: 10, corporationId: 1, shipTypeId: 587, damageDone: 868, securityStatus: -2 }] });

function enqueue(opened, rows, now) {
  const repo = outboxModule.createFreeCorpOutboxRepository();
  const r = opened.store.transaction("t.enqueue", (tx) => rows.map((x) => repo.enqueueInTx(tx, { key: x.key,
    kind: KIND, payload: x.payload, now })));
  assert.ok(r.ok && r.value.every((x) => x.ok), JSON.stringify(r));
}

function pumpOf(opened, { clock, write, S, outbox, counters }) {
  const repo = outbox || outboxModule.createFreeCorpOutboxRepository();
  const c = counters || {};
  return createKillmailPump({ store: opened.store, outbox: repo, clock, nowMs: () => 0, writeVirtualKillmail: write,
    virtualKillmailSeams: () => ({ ok: true }), getGovernor: () => null, workClass: "MAINTENANCE",
    isRunning: () => true, bump: (name, n = 1) => { c[name] = (c[name] || 0) + n; }, metric: () => {}, log: () => {},
    setTimer: () => ({ cancel() {}, hasRef: () => false }), S,
    retention: { ventureRetentionMs: 7 * 86400000, pruneBatch: 50 } });
}

const rowsOf = (opened) => H.all(opened, "SELECT * FROM world_free_corp_outbox ORDER BY key");

module.exports = ({ test, skip }) => {
  const driver = loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };
  const KM_ON = { killmails: { enabled: true } };

  needsDriver("KM2 a FIGHT enqueues one killmail in the pass transaction; replay; planKillmail pure; flag off = "
    + "no outbox read / write, no seam call", () => {
    withStore(driver, (opened) => {
      const cfg = H.cfgOf(KM_ON);
      let seamCalls = 0;
      const env = H.scene(opened, cfg, null, { hullEhpOf, writeVirtualKillmail: () => ({ ok: false, reason: "X" }),
        virtualKillmailSeams: () => { seamCalls += 1; return { ok: true }; } });
      env.vc.identities.set(1, H.linked(3, 98000001));
      env.vc.identities.set(2, H.linked(3, 98000002));
      const st = H.pass(env);
      const sk = H.all(opened, "SELECT * FROM world_free_corp_skirmishes")[0];
      const rows = rowsOf(opened);
      assert.strictEqual(rows.length, 1);
      const row = rows[0];
      assert.deepStrictEqual([row.key, row.kind, row.state, row.attempts, row.attempted_at, row.version],
        [`lne:fc:km:${sk.skirmish_id}`, KIND, "PENDING", 0, null, 1]);
      const p = JSON.parse(row.payload);
      const aWins = sk.outcome === "ATTACKER_WIN";
      assert.strictEqual(p.victim.corporationId, aWins ? 98000002 : 98000001, "victim = the losing corporation");
      assert.ok(p.attackers.length >= 1 && p.attackers.length <= cfg.freeCorps.killmails.maxAttackers);
      assert.ok(p.attackers.every((a) => a.corporationId === (aWins ? 98000001 : 98000002)));
      assert.ok(p.victim.damageTaken > 0);
      assert.strictEqual(p.attackers.reduce((s, a) => s + a.damageDone, 0), p.victim.damageTaken);
      assert.strictEqual(st.counters.kmEnqueued, 1);
      assert.strictEqual(seamCalls, 1, "the seam once per pass");
      assert.deepStrictEqual(Object.keys(st.killmails).sort(), ["enabled", "lastCallMs", "pending", "seam", "slowUntil"]);
      H.pass(env);
      assert.strictEqual(rowsOf(opened).length, 1, "still one row");
      const input = { skirmish: sk, attacker: { archetype: "hunter", identity: H.linked(3, 98000001) },
        defender: { archetype: "miner", identity: H.linked(3, 98000002) }, maxAttackers: 5, hullEhpOf };
      assert.deepStrictEqual(planKillmail(input), planKillmail(input));
      assert.deepStrictEqual(planKillmail(input).payload, p, "the payload of the pass");
      env.fc.stop();
    });
    const real = outboxModule.createFreeCorpOutboxRepository;
    let created = 0;
    let calls = 0;
    outboxModule.createFreeCorpOutboxRepository = () => {
      created += 1;
      const r = real();
      return Object.fromEntries(Object.entries(r).map(([k, fn]) => [k, (...a) => { calls += 1; return fn(...a); }]));
    };
    try {
      withStore(driver, (opened) => {
        let seamCalls = 0;
        const env = H.scene(opened, H.cfgOf({ killmails: { enabled: false } }), null, { hullEhpOf,
          virtualKillmailSeams: () => { seamCalls += 1; return { ok: true }; } });
        const st = H.pass(env);
        assert.strictEqual(H.all(opened, "SELECT COUNT(*) AS n FROM world_free_corp_skirmishes")[0].n, 1);
        assert.strictEqual(rowsOf(opened).length, 0);
        assert.deepStrictEqual([created, calls, seamCalls], [0, 0, 0]);
        assert.strictEqual("killmails" in st, false);
        env.fc.stop();
      });
    } finally {
      outboxModule.createFreeCorpOutboxRepository = real;
    }
  });

  needsDriver("KM3 pump: DONE, a crash before the settle replays the same eventId -> one killmail, transient "
    + "refusals -> FAILED after maxAttempts with backoff, INVALID_INPUT -> FAILED at once", () => {
    const S0 = H.cfgOf().freeCorps.killmails;
    withStore(driver, (opened) => {
      const S = { ...S0, enabled: true };
      const gap = spacingMs(S.maxPerHour);
      const clock = createManualClock(H.T0);
      const vendor = fakeVendor();
      enqueue(opened, [{ key: "lne:fc:km:fcs:fcv:1:1:1", payload: goodPayload(1) },
        { key: "lne:fc:km:fcs:fcv:1:2:1", payload: goodPayload(2) }], H.T0);
      const r1 = pumpOf(opened, { clock, write: vendor.write, S }).runNow();
      assert.deepStrictEqual([r1.ok, r1.outcome, r1.key], [true, "done", "lne:fc:km:fcs:fcv:1:1:1"]);
      assert.deepStrictEqual([rowsOf(opened)[0].state, rowsOf(opened)[0].result_id], ["DONE", 41]);
      clock.set(H.T0 + gap);
      const real = outboxModule.createFreeCorpOutboxRepository();
      const broken = { ...real, completeInTx: () => { throw new Error("crash before settle"); } };
      const r2 = pumpOf(opened, { clock, write: vendor.write, S, outbox: broken }).runNow();
      assert.strictEqual(r2.reason, "SETTLE_FAILED");
      const mid = rowsOf(opened)[1];
      assert.deepStrictEqual([mid.state, mid.attempts, mid.attempted_at], ["PENDING", 1, H.T0 + gap]);
      const counters = {};
      const fresh = pumpOf(opened, { clock, write: vendor.write, S, counters });
      assert.strictEqual(fresh.runNow().reason, "SPACING");
      clock.set(H.T0 + 2 * gap);
      const r3 = fresh.runNow();
      assert.deepStrictEqual([r3.outcome, r3.call], ["done", { ok: true, killId: 42 }]);
      assert.deepStrictEqual(vendor.calls, ["lne:fc:km:fcs:fcv:1:1:1", "lne:fc:km:fcs:fcv:1:2:1",
        "lne:fc:km:fcs:fcv:1:2:1"]);
      assert.strictEqual(vendor.byEvent.size, 2, "one killmail per key");
      assert.deepStrictEqual([rowsOf(opened)[1].state, rowsOf(opened)[1].result_id, rowsOf(opened)[1].attempts],
        ["DONE", 42, 2]);
      assert.deepStrictEqual([counters.kmSpacing, counters.kmCalls, counters.kmDone], [1, 1, 1]);
    });
    withStore(driver, (opened) => {
      const S = { ...S0, enabled: true, maxAttempts: 3, maxPerHour: 12 };
      const gap = spacingMs(S.maxPerHour);
      const clock = createManualClock(H.T0);
      enqueue(opened, [{ key: "lne:fc:km:fcs:fcv:1:1:1", payload: goodPayload(1) }], H.T0);
      const counters = {};
      let t = H.T0;
      const failing = () => ({ ok: false, reason: "VENDOR_THROW", detail: "disk full" });
      const pump = pumpOf(opened, { clock, write: failing, S, counters });
      const nexts = [];
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        const r = pump.runNow();
        assert.strictEqual(r.key, "lne:fc:km:fcs:fcv:1:1:1");
        const row = rowsOf(opened)[0];
        if (attempt < 3) {
          assert.deepStrictEqual([row.state, row.attempts, row.next_at], ["PENDING", attempt, t + backoffMs(attempt, S)]);
          nexts.push(row.next_at - t);
          t = Math.max(row.next_at, t + gap);
          clock.set(t);
        } else {
          assert.deepStrictEqual([row.state, row.attempts, row.last_error], ["FAILED", 3, "VENDOR_THROW disk full"]);
        }
      }
      assert.ok(nexts[1] > nexts[0], "backoff grows");
      enqueue(opened, [{ key: "lne:fc:km:fcs:fcv:9:9:9", payload: { v: 2 } }], t);
      clock.set(t + gap);
      const r = pumpOf(opened, { clock, write: fakeVendor().write, S, counters }).runNow();
      assert.strictEqual(r.key, "lne:fc:km:fcs:fcv:9:9:9");
      const bad = rowsOf(opened)[1];
      assert.deepStrictEqual([bad.state, bad.attempts, bad.last_error.startsWith("INVALID_INPUT")], ["FAILED", 1, true]);
      assert.deepStrictEqual([counters.kmRetry, counters.kmFailed], [2, 2]);
    });
  });

  needsDriver("KM4 maxPerHour 6: 10 PENDING rows, a run every 60 s for an hour -> 6 vendor calls, also across a "
    + "pump restart; kind indexes; reset policy, migration 77", () => {
    withStore(driver, (opened) => {
      const S = { ...H.cfgOf().freeCorps.killmails, enabled: true, maxPerHour: 6, pumpMs: 60000 };
      const clock = createManualClock(H.T0);
      const vendor = fakeVendor();
      enqueue(opened, Array.from({ length: 10 }, (_v, i) => ({ key: `lne:fc:km:fcs:fcv:1:${i + 1}:1`,
        payload: goodPayload(i + 1) })), H.T0);
      let pump = pumpOf(opened, { clock, write: vendor.write, S });
      for (let k = 0; k < 60; k += 1) {
        if (k === 30) pump = pumpOf(opened, { clock, write: vendor.write, S });
        clock.set(H.T0 + k * S.pumpMs);
        pump.runNow();
      }
      assert.strictEqual(vendor.calls.length, 6);
      assert.strictEqual(H.all(opened, "SELECT COUNT(*) AS n FROM world_free_corp_outbox WHERE state = 'DONE'")[0].n, 6);
      const repo = outboxModule.createFreeCorpOutboxRepository();
      const plans = opened.store.transaction("t.plan", (db) => {
        const seen = [];
        const spy = { prepare: (sql) => { seen.push(sql); return db.prepare(sql); } };
        repo.nextDueInTx(spy, { kind: KIND, now: H.T0 });
        const nextSql = seen.find((s) => s.includes("next_at <= ?"));
        const lastSql = seen.find((s) => s.includes("MAX(attempted_at)"));
        const plan = (sql, args) => db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...args).map((r) => r.detail).join(" | ");
        return { next: plan(nextSql, [KIND, H.T0]), last: plan(lastSql, [KIND]) };
      });
      assert.ok(plans.ok, JSON.stringify(plans));
      assert.ok(plans.value.next.includes("world_free_corp_outbox_kind_due"), plans.value.next);
      assert.ok(plans.value.last.includes("world_free_corp_outbox_kind_attempted"), plans.value.last);
    });
    assert.strictEqual(TABLE_POLICY.world_free_corp_outbox, ACTION.KEEP);
    assert.ok(LATEST_SCHEMA_VERSION >= 77, "migration 78 (contracts) after 77");
  });
};
