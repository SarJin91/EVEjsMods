"use strict";

const assert = require("node:assert");
const os = require("node:os");
const path = require("node:path");

const S = require("../../../lib/economy/trade/schema");
const { planSupplierGrant } = require("../../../lib/economy/trade/supplierStandingRules");
const { createDeliveryStanding, StandingRollback } = require("../../../lib/economy/trade/deliveryStanding");
const { stepPollSell } = require("../../../lib/economy/trade/sellSteps");
const { applyStandingGrantFrom } = require("../../../lib/adapter/standingWrite");
const { createNoticeRepository } = require("../../../lib/notices/repository");
const { resolveConfig } = require("../../../config");
const { harness: H } = require("../../battle/settlement.test");

const MOD_DIR = path.resolve(__dirname, "..", "..", "..");
const ZERO_DAY = Object.freeze({ creditIsk: 0, wtsIsk: 0, gainMicro: 0, grants: 0 });
const ZERO_WIN = Object.freeze({ creditIsk: 0, wtsIsk: 0, gainMicro: 0 });
const PARAMS = Object.freeze({ iskPer01: 20000000, growthPermille: 1600, dailyCap: 0.3, windowCap: 0, ceiling: 3,
  minGrant: 0.001, maxGrantsPerDay: 0 });
const ON = Object.freeze({ EVEJS_LNE_TRADE_STANDING_GRANT_ENABLED: "true" });

function configOf(env = {}) {
  const r = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_DATA_ROOT: os.tmpdir(), ...env } });
  assert.deepStrictEqual(r.errors || [], [], JSON.stringify(r.errors));
  return r.config;
}

function fakeWorld() {
  const receipts = new Map();
  const w = { standing: 0, readOk: true, calls: 0 };
  w.runtime = { applyStandingChanges(characterID, changes, options) {
    w.calls += 1;
    const fp = JSON.stringify({ characterID, changes });
    if (receipts.has(options.idempotencyKey)) {
      if (receipts.get(options.idempotencyKey) !== fp) return { success: false, errorMsg: "IDEMPOTENCY_KEY_REUSED" };
      return { success: true, duplicate: true, data: { appliedChanges: [] } };
    }
    receipts.set(options.idempotencyKey, fp);
    const before = w.standing;
    w.standing = 10 - (10 - before) * (1 - changes[0].rawChange);
    return { success: true, data: { appliedChanges: [{ fromID: changes[0].ownerID, toID: characterID,
      previousStanding: before, standing: w.standing }] } };
  } };
  w.adapter = {
    applyStandingGrant: (grant, data) => applyStandingGrantFrom(w.runtime, grant, data),
    checkStandingWrite: () => ({ ok: true }),
    readCharacterStanding: () => (w.readOk ? { ok: true, found: true, standing: w.standing }
      : { ok: false, reason: "STANDING_READ_THREW" }),
    checkStandingRead: () => ({ ok: true }),
  };
  return w;
}

function bootService(opened, shared, world, env = ON) {
  const base = H.boot(opened, shared);
  const repo = createNoticeRepository();
  const standing = createDeliveryStanding({ journal: base.journal, scheduler: base.scheduler, adapter: world.adapter,
    clock: shared.clock, config: configOf(env), maxRows: 500, factionNames: new Map([[500001, "Caldari State"]]),
    getNotices: () => ({ enqueueItemsInTx: (tx, items, now) => repo.enqueueItemsInTx(tx, items, now) }),
    logger: { log() {} }, nowMs: () => 0 });
  return { ...base, standing };
}

function offerOf(o = {}) {
  return { offerId: o.offerId || "o-1", factionId: o.factionId || 500001, side: o.side || S.SIDE_BUY,
    acceptorCharacterId: o.acceptorCharacterId === undefined ? 1001 : o.acceptorCharacterId,
    iskTotal: o.iskTotal || 90000000, standingBonusPermille: o.bonus || 0, state: S.ACCEPTED, stateSeq: 1, version: 2 };
}

function decide(env, offer, at) {
  return env.tx((db) => {
    const d = env.standing.decideInTx(db, offer, at);
    if (d.ok !== true) throw new StandingRollback(d);
    return d;
  });
}

const ledgerRows = (env, c = 1001) => env.tx((db) => db.prepare(
  "SELECT faction_id, day, credit_isk, wts_isk, gain_micro, grants FROM world_supplier_standing WHERE character_id = ? "
  + "ORDER BY faction_id").all(c));
const eventOf = (env, key) => {
  const row = env.tx((db) => db.prepare("SELECT * FROM world_scheduled_events WHERE idempotency_key = ?").get(key));
  return { ...row, payload: JSON.parse(row.payload), idempotencyKey: row.idempotency_key, createdAt: row.created_at };
};
const runHandler = (env, ev, now) => {
  const h = env.standing.handler(ev, { now });
  if (h.ok === true && typeof h.effect === "function") env.tx((db) => h.effect(db));
  return h;
};
const noticeCount = (env, key) => env.tx((db) => db.prepare(
  "SELECT count(*) AS n FROM world_notice_items WHERE event_key = ? AND kind = 'SUPPLIER_STANDING'").get(key)).n;

module.exports = ({ test, skip }) => {
  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  test("T1 curve: first +0.1 per day at s 0/3/5, split invariance, negative standing, inverse of the vendor", () => {
    const high = { ...PARAMS, ceiling: 10 };
    for (const [s, isk] of [[0, 24300000], [3, 99600000], [5, 255100000]]) {
      const r = planSupplierGrant({ standing: s, valueIsk: isk, today: ZERO_DAY, window: ZERO_WIN }, high);
      assert.strictEqual(r.outcome, "GRANT", `s=${s}`);
      assert.ok(Math.abs(r.gainMicro - 100000) <= 1000, `s=${s} gain ${r.gainMicro}`);
    }
    const one = planSupplierGrant({ standing: 0, valueIsk: 90000000, today: ZERO_DAY, window: ZERO_WIN }, PARAMS);
    let today = { ...ZERO_DAY };
    let sum = 0;
    for (let i = 0; i < 3; i += 1) {
      const r = planSupplierGrant({ standing: 0, valueIsk: 30000000, today, window: ZERO_WIN }, PARAMS);
      assert.strictEqual(r.outcome, "GRANT");
      sum += r.gainMicro;
      today = { creditIsk: today.creditIsk + r.creditIsk, wtsIsk: 0, gainMicro: today.gainMicro + r.gainMicro,
        grants: today.grants + 1 };
    }
    assert.ok(Math.abs(sum - one.gainMicro) <= 2, `split ${sum} vs ${one.gainMicro}`);
    const neg = planSupplierGrant({ standing: -4, valueIsk: 90000000, today: ZERO_DAY, window: ZERO_WIN }, PARAMS);
    assert.strictEqual(neg.gainMicro, one.gainMicro);
    assert.ok(Math.abs(neg.rawChange * 14 - neg.gainMicro / 1e6) < 1e-6);
    assert.ok(Math.abs(one.rawChange * 10 - one.gainMicro / 1e6) < 1e-6);
  });

  test("T2 caps: daily saturation, rolling window, carry of a small credit, ceiling", () => {
    const sat = planSupplierGrant({ standing: 0, valueIsk: 1000000000000, today: ZERO_DAY, window: ZERO_WIN }, PARAMS);
    assert.ok(sat.gainMicro <= 300000 && sat.gainMicro >= 299000, String(sat.gainMicro));
    const after = planSupplierGrant({ standing: 0, valueIsk: 1000000000, today: { creditIsk: 1000000000000, wtsIsk: 0,
      gainMicro: sat.gainMicro, grants: 1 }, window: ZERO_WIN }, PARAMS);
    assert.strictEqual(after.outcome, "CARRY");

    const W = { ...PARAMS, windowCap: 0.6 };
    const near = planSupplierGrant({ standing: 0, valueIsk: 1000000000, today: ZERO_DAY,
      window: { creditIsk: 0, wtsIsk: 0, gainMicro: 590000 } }, W);
    assert.ok(near.outcome === "GRANT" && near.gainMicro <= 10000, JSON.stringify(near));
    const full = planSupplierGrant({ standing: 0, valueIsk: 1000000000, today: ZERO_DAY,
      window: { creditIsk: 0, wtsIsk: 0, gainMicro: 600000 } }, W);
    assert.strictEqual(full.outcome, "WINDOW_CAP");

    const small = planSupplierGrant({ standing: 0, valueIsk: 150000, today: ZERO_DAY, window: ZERO_WIN }, PARAMS);
    assert.strictEqual(small.outcome, "CARRY");
    const next = planSupplierGrant({ standing: 0, valueIsk: 150000, today: { ...ZERO_DAY, creditIsk: 150000 },
      window: ZERO_WIN }, PARAMS);
    assert.strictEqual(next.outcome, "GRANT");
    assert.ok(next.gainMicro > 1400 && next.gainMicro < 1550, String(next.gainMicro));

    assert.strictEqual(planSupplierGrant({ standing: 3, valueIsk: 1000000000, today: ZERO_DAY, window: ZERO_WIN },
      PARAMS).outcome, "CEILING");
    const rest = planSupplierGrant({ standing: 2.95, valueIsk: 1000000000, today: ZERO_DAY, window: ZERO_WIN }, PARAMS);
    assert.strictEqual(rest.gainMicro, 50000);
  });

  needsDriver("T3 decision: ledger + OUTBOX + event once, duplicate offer, restart handler once, unreadable standing",
    () => H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const world = fakeWorld();
      const opened = reopen();
      const env = bootService(opened, shared, world);
      const at = shared.clock.now();
      const d = decide(env, offerOf({ offerId: "t3" }), at);
      assert.strictEqual(d.outcome, "GRANTED");
      const expected = planSupplierGrant({ standing: 0, valueIsk: 90000000, today: ZERO_DAY, window: ZERO_WIN }, PARAMS);
      assert.strictEqual(d.rawChange, expected.rawChange);
      const rows = ledgerRows(env);
      assert.deepStrictEqual(rows.map((r) => [r.credit_isk, r.gain_micro, r.grants]),
        [[90000000, expected.gainMicro, 1]]);
      const out = env.tx((db) => env.journal.findByKey(db, d.key));
      assert.strictEqual(out.entry.state, "PENDING");
      const ev = eventOf(env, d.key);
      assert.deepStrictEqual(Object.keys(ev.payload).sort(), ["characterId", "factionId", "journalId", "offerId",
        "rawChange"]);

      assert.strictEqual(decide(env, offerOf({ offerId: "t3" }), at).outcome, "DUPLICATE");
      assert.deepStrictEqual(ledgerRows(env), rows);

      const env2 = bootService(opened, shared, world);
      assert.strictEqual(runHandler(env2, ev, at).outcome, "APPLIED");
      assert.strictEqual(runHandler(env2, ev, at).outcome, "DUPLICATE");
      assert.strictEqual(world.calls, 2);
      assert.ok(Math.abs(world.standing - expected.gainMicro / 1e6) < 1e-6, String(world.standing));

      world.readOk = false;
      const u = decide(env2, offerOf({ offerId: "t3-u", acceptorCharacterId: 1002 }), at);
      assert.strictEqual(u.outcome, "STANDING_UNREADABLE");
      assert.deepStrictEqual(ledgerRows(env2, 1002), []);
    }));

  needsDriver("T4 handler gates: OVERSIZE and CEILING without vendor call, APPLIED -> one notice line", () =>
    H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const world = fakeWorld();
      const env = bootService(reopen(), shared, world);
      const at = shared.clock.now();
      const a = decide(env, offerOf({ offerId: "t4-a" }), at);
      const evA = eventOf(env, a.key);
      const old = runHandler(env, { ...evA, payload: { ...evA.payload, rawChange: 0.5 } }, at);
      assert.strictEqual(old.outcome, "FAILED");
      assert.strictEqual(env.tx((db) => env.journal.findByKey(db, a.key)).entry.state, "FAILED");
      assert.strictEqual(world.calls, 0);
      assert.strictEqual(env.standing.getStatus().counters.oversize, 1);

      const b = decide(env, offerOf({ offerId: "t4-b", factionId: 500002 }), at);
      world.standing = 3;
      assert.strictEqual(runHandler(env, eventOf(env, b.key), at).outcome, "FAILED");
      assert.strictEqual(world.calls, 0);
      assert.strictEqual(env.standing.getStatus().counters.ceilingAtApply, 1);

      world.standing = 0;
      const c = decide(env, offerOf({ offerId: "t4-c", factionId: 500001, iskTotal: 30000000 }), at);
      const evC = eventOf(env, c.key);
      assert.strictEqual(runHandler(env, evC, at).outcome, "APPLIED");
      assert.strictEqual(noticeCount(env, c.key), 1);
      const line = env.tx((db) => db.prepare("SELECT line FROM world_notice_items WHERE event_key = ?").get(c.key)).line;
      assert.ok(line.startsWith("Dostawy dla Caldari State: standing +"), line);
      assert.strictEqual(runHandler(env, evC, at).outcome, "DUPLICATE");
      assert.strictEqual(noticeCount(env, c.key), 1);
    }));

  needsDriver("T5 WTS debit through stepPollSell eats the credit, other faction untouched, flag off", () =>
    H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const world = fakeWorld();
      const opened = reopen();
      const env = bootService(opened, shared, world);
      const at = shared.clock.now();
      const X = 50000000;
      const sell = offerOf({ offerId: "t5-wts", side: S.SIDE_SELL, iskTotal: X });
      const sellDeps = (standing) => ({ store: env.store, clock: shared.clock, config: configOf(ON), mode: "run",
        telemetry: null, deliveryStanding: standing,
        adapter: { tradeReadContract: async () => ({ ok: true, contract: { status: "FINISHED",
          acceptorKind: "character", acceptorId: 1001 } }) },
        offers: { transitionOfferInTx: (db, spec) => ({ ok: true, duplicate: false,
          offer: { ...sell, acceptorCharacterId: spec.patch.acceptorCharacterId } }) } });
      assert.deepStrictEqual(await stepPollSell(sellDeps(env.standing), { ...sell, state: S.OPEN }, null),
        { action: "accepted" });
      assert.strictEqual(ledgerRows(env)[0].wts_isk, X);
      assert.strictEqual(decide(env, offerOf({ offerId: "t5-wtb", iskTotal: X }), at).outcome, "CARRY");
      assert.strictEqual(decide(env, offerOf({ offerId: "t5-other", factionId: 500002, iskTotal: X }), at).outcome,
        "GRANTED");

      const off = bootService(opened, shared, world, { EVEJS_LNE_TRADE_STANDING_GRANT_ENABLED: "false" });
      assert.strictEqual(decide(off, offerOf({ offerId: "t5-off", acceptorCharacterId: 1003 }), at).outcome,
        "STANDING_DISABLED");
      assert.deepStrictEqual(ledgerRows(off, 1003), []);
      const before = ledgerRows(off);
      assert.deepStrictEqual(await stepPollSell(sellDeps(off.standing), { ...sell, state: S.OPEN }, null),
        { action: "accepted" });
      assert.deepStrictEqual(ledgerRows(off), before, "flag off: the WTS is not noted");
    }));
};
