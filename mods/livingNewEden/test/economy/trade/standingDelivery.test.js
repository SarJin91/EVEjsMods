"use strict";

const assert = require("node:assert");
const os = require("node:os");
const path = require("node:path");

const S = require("../../../lib/economy/trade/schema");
const { createDeliveryStanding, StandingRollback } = require("../../../lib/economy/trade/deliveryStanding");
const { applyStandingGrantFrom } = require("../../../lib/adapter/standingWrite");
const { resolveConfig } = require("../../../config");
const { harness: H } = require("../../battle/settlement.test");

const MOD_DIR = path.resolve(__dirname, "..", "..", "..");
const DAY_MS = 86400000;

function configOf(env = {}) {
  const r = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_DATA_ROOT: os.tmpdir(), ...env } });
  assert.deepStrictEqual(r.errors || [], [], JSON.stringify(r.errors));
  return r.config;
}

function fakeRuntime() {
  const receipts = new Map();
  const rt = { applied: 0, duplicate: 0, calls: 0, throwNext: false,
    applyStandingChanges(characterID, changes, options) {
      rt.calls += 1;
      if (rt.throwNext) throw new Error("vendor boom");
      const key = options.idempotencyKey;
      const fp = JSON.stringify({ characterID, changes, disableDerived: options.disableDerived === true,
        preservePrecision: options.preservePrecision === true });
      if (receipts.has(key)) {
        if (receipts.get(key) !== fp) return { success: false, errorMsg: "IDEMPOTENCY_KEY_REUSED" };
        rt.duplicate += 1;
        return { success: true, duplicate: true, data: { modifications: [], appliedChanges: [] } };
      }
      receipts.set(key, fp);
      rt.applied += 1;
      return { success: true, data: { modifications: [], appliedChanges: [{ fromID: changes[0].ownerID,
        toID: characterID, rawChange: changes[0].rawChange, previousStanding: 0, standing: 10 * changes[0].rawChange }] } };
    } };
  return rt;
}

function fakeAdapter(rt) {
  const spy = { writes: 0 };
  return { spy, applyStandingGrant(grant, data) {
    spy.writes += 1;
    return applyStandingGrantFrom(rt, grant, data);
  }, checkStandingWrite: () => ({ ok: true }), readPirateFactionIds: () => ({ ok: true, ids: new Set() }),
  readCharacterStanding: () => ({ ok: true, found: true, standing: 0 }), checkStandingRead: () => ({ ok: true }) };
}

function bootStanding(opened, shared, envOver, rt) {
  const config = configOf(envOver);
  const env = H.boot(opened, shared);
  const adapter = fakeAdapter(rt);
  const lines = [];
  const captured = {};
  const scheduler = { ...env.scheduler, registerHandler(type, fn, opts) {
    captured[type] = fn;
    return env.scheduler.registerHandler(type, fn, opts);
  } };
  const standing = createDeliveryStanding({
    journal: env.journal,
    scheduler,
    adapter,
    clock: shared.clock,
    config,
    maxRows: 500,
    logger: { log: (l) => lines.push(l) },
    nowMs: () => 0,
  });
  const reg = scheduler.registerHandler(S.EVENT_STANDING_GRANT, standing.handler, { maxPerPass: 10 });
  return { ...env, standing, adapter, lines, handler: captured["TRADE_STANDING_GRANT"], config };
}

function makeOffer(opts = {}) {
  return {
    offerId: opts.offerId || "offer-1",
    factionId: opts.factionId || 500001,
    acceptorCharacterId: opts.acceptorCharacterId === undefined ? 1001 : opts.acceptorCharacterId,
    iskTotal: opts.iskTotal || 1000000000,
    contractId: opts.contractId || 12345,
    state: S.ACCEPTED,
    stateSeq: opts.stateSeq || 1,
    version: opts.version || 2,
  };
}

function tx(env, fn) {
  const r = env.store.transaction("test", fn);
  assert.ok(r.ok, JSON.stringify(r));
  return r.value;
}

module.exports = ({ test, skip }) => {
  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  needsDriver("TS1 happy path: ACCEPTED + grant, OUTBOX PENDING, event, handler APPLIED", () =>
    H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const rt = fakeRuntime();
      const env = bootStanding(reopen(), shared, {
        EVEJS_LNE_TRADE_STANDING_GRANT_ENABLED: "true",
        EVEJS_LNE_TRADE_STANDING_MAX_GRANTS_PER_CHARACTER_DAY: "100",
        EVEJS_LNE_TRADE_STANDING_GRANT_MAX_AGE_MS: "604800000",
      }, rt);

      const offer = makeOffer({ offerId: "offer-ts1", contractId: 111 });
      const at = shared.clock.now();

      let decision = null;
      tx(env, (db) => {
        decision = env.standing.decideInTx(db, offer, at);
        if (decision.ok !== true) throw new StandingRollback(decision);
        return { ok: true };
      });
      assert.deepStrictEqual(decision.outcome, "GRANTED");
      env.standing.noteCommitted(decision);

      const outbox = tx(env, (db) => env.journal.findByKey(db, decision.key));
      assert.ok(outbox.ok && outbox.found);
      assert.strictEqual(outbox.entry.state, "PENDING");

      const evs = tx(env, (db) => db.prepare(`SELECT * FROM world_scheduled_events WHERE event_type = ?`).all("TRADE_STANDING_GRANT"));
      assert.strictEqual(evs.length, 1);
      const ev = evs[0];
      assert.strictEqual(ev.idempotency_key, decision.key);
      const payload = JSON.parse(ev.payload);
      assert.deepStrictEqual(payload.characterId, offer.acceptorCharacterId);
      assert.deepStrictEqual(payload.factionId, offer.factionId);
      assert.deepStrictEqual(payload.offerId, offer.offerId);
      assert.deepStrictEqual(payload.rawChange, decision.rawChange);

      const hctx = { now: at };
      const h1 = env.handler({ ...ev, payload: JSON.parse(ev.payload), createdAt: at, dueAt: at, idempotencyKey: ev.idempotency_key }, hctx);
      assert.deepStrictEqual(h1.outcome, "APPLIED");
      assert.ok(typeof h1.effect === "function");

      tx(env, (db) => h1.effect(db));
      if (h1.onCommitted) h1.onCommitted();

      const outbox2 = tx(env, (db) => env.journal.findByKey(db, decision.key));
      assert.strictEqual(outbox2.entry.state, "APPLIED");

      assert.strictEqual(rt.calls, 1);
      assert.strictEqual(rt.applied, 1);
      assert.ok(env.lines.some((l) => l.includes("standing granted") && l.includes("char=1001")));
    }));

  needsDriver("TS2a QUEUE_FULL: transition rolled back, no rows", () =>
    H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const rt = fakeRuntime();
      const env = bootStanding(reopen(), shared, {
        EVEJS_LNE_TRADE_STANDING_GRANT_ENABLED: "true",
        EVEJS_LNE_TRADE_STANDING_MAX_GRANTS_PER_CHARACTER_DAY: "100",
        EVEJS_LNE_TRADE_STANDING_GRANT_MAX_AGE_MS: "604800000",
      }, rt);

      const offer = makeOffer({ offerId: "offer-ts2a", contractId: 222, version: 1, stateSeq: 0 });
      const at = shared.clock.now();

      const origScheduler = env.scheduler;
      const wrappedScheduler = Object.assign(Object.create(Object.getPrototypeOf(origScheduler)), origScheduler, {
        enqueue: () => ({ ok: false, reason: "QUEUE_FULL" }),
      });

      const standing2 = createDeliveryStanding({
        journal: env.journal,
        scheduler: wrappedScheduler,
        adapter: env.adapter,
        clock: shared.clock,
        config: env.config,
        maxRows: 500,
        logger: { log: () => {} },
        nowMs: () => 0,
      });

      let txRes = null;
      txRes = env.store.transaction("trade.open_accepted", (db) => {
        const transRes = { ok: true, offer: { ...offer, version: 2, state: S.ACCEPTED, stateSeq: 1 } };
        const d = standing2.decideInTx(db, transRes.offer, at);
        if (d.ok !== true) throw new StandingRollback(d);
        return { ok: true, offer: transRes.offer };
      });
      assert.ok(!txRes.ok);
      assert.ok(txRes.error instanceof StandingRollback);
      standing2.noteWriteFailed(txRes.error.refusal);

      const planKey = `lne:trd:1001:0:500001:offer-ts2a`;
      const found = tx(env, (db) => env.journal.findByKey(db, planKey));
      assert.ok(!found.ok || !found.found);

      const status = standing2.getStatus();
      assert.strictEqual(status.counters.writeFailed, 1);

      const standing3 = createDeliveryStanding({
        journal: env.journal,
        scheduler: origScheduler,
        adapter: env.adapter,
        clock: shared.clock,
        config: env.config,
        maxRows: 500,
        logger: { log: () => {} },
        nowMs: () => 0,
      });
      let decisionRetry = null;
      txRes = env.store.transaction("trade.open_accepted", (db) => {
        const transRes = { ok: true, offer: { ...offer, version: 2, state: S.ACCEPTED, stateSeq: 1 } };
        decisionRetry = standing3.decideInTx(db, transRes.offer, at);
        if (decisionRetry.ok !== true) throw new StandingRollback(decisionRetry);
        return { ok: true, offer: transRes.offer };
      });
      assert.ok(txRes.ok);
      assert.deepStrictEqual(decisionRetry.outcome, "GRANTED");
    }));

  needsDriver("TS2b handler twice: second DUPLICATE, only one vendor call", () =>
    H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const rt = fakeRuntime();
      const env = bootStanding(reopen(), shared, {
        EVEJS_LNE_TRADE_STANDING_GRANT_ENABLED: "true",
        EVEJS_LNE_TRADE_STANDING_MAX_GRANTS_PER_CHARACTER_DAY: "100",
        EVEJS_LNE_TRADE_STANDING_GRANT_MAX_AGE_MS: "604800000",
      }, rt);

      const offer = makeOffer({ offerId: "offer-ts2b", contractId: 333 });
      const at = shared.clock.now();

      let decision = null;
      tx(env, (db) => {
        decision = env.standing.decideInTx(db, offer, at);
        if (decision.ok !== true) throw new StandingRollback(decision);
        return { ok: true };
      });
      assert.deepStrictEqual(decision.outcome, "GRANTED");

      const evs = tx(env, (db) => db.prepare(`SELECT * FROM world_scheduled_events WHERE idempotency_key = ?`).all(decision.key));
      assert.strictEqual(evs.length, 1);
      const ev = evs[0];

      const hctx = { now: at };
      const h1 = env.handler({ ...ev, payload: JSON.parse(ev.payload), createdAt: at, dueAt: at, idempotencyKey: ev.idempotency_key }, hctx);
      const h2 = env.handler({ ...ev, payload: JSON.parse(ev.payload), createdAt: at, dueAt: at, idempotencyKey: ev.idempotency_key }, hctx);

      assert.deepStrictEqual(h1.outcome, "APPLIED");
      assert.deepStrictEqual(h2.outcome, "DUPLICATE");
      assert.strictEqual(rt.applied, 1);
      assert.strictEqual(rt.duplicate, 1);
    }));

  needsDriver("TS2c restart/new executor: zero new decisions, old event EXPIRED", () =>
    H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const rt = fakeRuntime();
      const opened = reopen();
      const env = bootStanding(opened, shared, {
        EVEJS_LNE_TRADE_STANDING_GRANT_ENABLED: "true",
        EVEJS_LNE_TRADE_STANDING_MAX_GRANTS_PER_CHARACTER_DAY: "100",
        EVEJS_LNE_TRADE_STANDING_GRANT_MAX_AGE_MS: "1000",
      }, rt);

      const offer = makeOffer({ offerId: "offer-ts2c", contractId: 444 });
      const at = shared.clock.now();

      let decision = null;
      tx(env, (db) => {
        decision = env.standing.decideInTx(db, offer, at);
        if (decision.ok !== true) throw new StandingRollback(decision);
        return { ok: true };
      });
      assert.deepStrictEqual(decision.outcome, "GRANTED");

      const env2 = bootStanding(opened, shared, {
        EVEJS_LNE_TRADE_STANDING_GRANT_ENABLED: "true",
        EVEJS_LNE_TRADE_STANDING_MAX_GRANTS_PER_CHARACTER_DAY: "100",
        EVEJS_LNE_TRADE_STANDING_GRANT_MAX_AGE_MS: "1000",
      }, rt);

      let decision2 = null;
      tx(env2, (db) => {
        decision2 = env2.standing.decideInTx(db, offer, at);
        if (decision2.ok !== true) throw new StandingRollback(decision2);
        return { ok: true };
      });
      assert.deepStrictEqual(decision2.outcome, "DUPLICATE");

      const evs = tx(env2, (db) => db.prepare(`SELECT * FROM world_scheduled_events WHERE idempotency_key = ?`).all(decision.key));
      assert.strictEqual(evs.length, 1);
      const oldEv = evs[0];
      const hctx = { now: at + 2000 };
      const h = env2.handler({ ...oldEv, payload: JSON.parse(oldEv.payload), createdAt: at, dueAt: at, idempotencyKey: oldEv.idempotency_key }, hctx);
      assert.deepStrictEqual(h.outcome, "EXPIRED");
      assert.strictEqual(rt.calls, 0);
    }));

  needsDriver("TS3 limit: 2 small grants → 3rd DAILY_CAP; next day grant; corporation → NO_CHARACTER", () =>
    H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const rt = fakeRuntime();
      const env = bootStanding(reopen(), shared, {
        EVEJS_LNE_TRADE_STANDING_GRANT_ENABLED: "true",
        EVEJS_LNE_TRADE_STANDING_MAX_GRANTS_PER_CHARACTER_DAY: "2",
        EVEJS_LNE_TRADE_STANDING_GRANT_MAX_AGE_MS: "604800000",
      }, rt);

      const at = shared.clock.now();

      let decision = tx(env, (db) => {
        const d = env.standing.decideInTx(db, makeOffer({ offerId: "offer-ts3-1", contractId: 555, iskTotal: 1000000 }), at);
        if (d.ok !== true) throw new StandingRollback(d);
        return d;
      });
      assert.strictEqual(decision.outcome, "GRANTED");
      assert.ok(decision.rawChange > 0);

      decision = tx(env, (db) => {
        const d = env.standing.decideInTx(db, makeOffer({ offerId: "offer-ts3-2", contractId: 556, iskTotal: 1000000 }), at);
        if (d.ok !== true) throw new StandingRollback(d);
        return d;
      });
      assert.strictEqual(decision.outcome, "GRANTED");

      decision = tx(env, (db) => {
        const d = env.standing.decideInTx(db, makeOffer({ offerId: "offer-ts3-3", contractId: 557, iskTotal: 1000000000 }), at);
        if (d.ok !== true) throw new StandingRollback(d);
        return d;
      });
      assert.deepStrictEqual(decision.outcome, "DAILY_CAP");

      decision = tx(env, (db) => {
        const d = env.standing.decideInTx(db, makeOffer({ offerId: "offer-ts3-4", contractId: 558, iskTotal: 1000000000 }), at + DAY_MS);
        if (d.ok !== true) throw new StandingRollback(d);
        return d;
      });
      assert.deepStrictEqual(decision.outcome, "GRANTED");

      decision = tx(env, (db) => {
        const d = env.standing.decideInTx(db, makeOffer({ offerId: "offer-ts3-corp", contractId: 559, acceptorCharacterId: null, iskTotal: 1000000000 }), at);
        if (d.ok !== true) throw new StandingRollback(d);
        return d;
      });
      assert.deepStrictEqual(decision.outcome, "NO_CHARACTER");
    }));

  needsDriver("TS3b limit per supplier: cap exhausted at faction A → grant from faction B same day; A still DAILY_CAP", () =>
    H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const rt = fakeRuntime();
      const env = bootStanding(reopen(), shared, {
        EVEJS_LNE_TRADE_STANDING_GRANT_ENABLED: "true",
        EVEJS_LNE_TRADE_STANDING_MAX_GRANTS_PER_CHARACTER_DAY: "1",
        EVEJS_LNE_TRADE_STANDING_GRANT_MAX_AGE_MS: "604800000",
      }, rt);
      const at = shared.clock.now();
      const decide = (offer) => tx(env, (db) => {
        const d = env.standing.decideInTx(db, offer, at);
        if (d.ok !== true) throw new StandingRollback(d);
        return d;
      });

      assert.strictEqual(decide(makeOffer({ offerId: "offer-ts3b-a1", contractId: 571, factionId: 500001 })).outcome, "GRANTED");
      assert.strictEqual(decide(makeOffer({ offerId: "offer-ts3b-a2", contractId: 572, factionId: 500001 })).outcome, "DAILY_CAP");
      assert.strictEqual(decide(makeOffer({ offerId: "offer-ts3b-b1", contractId: 573, factionId: 500002 })).outcome, "GRANTED");
      assert.strictEqual(decide(makeOffer({ offerId: "offer-ts3b-b2", contractId: 574, factionId: 500002 })).outcome, "DAILY_CAP");
    }));

  test("TS3b keys: day prefix contains factionId and is a prefix of the unchanged grant key; no cross-faction overlap", () => {
    const key = S.standingGrantKey({ characterId: 1001, day: 20000, factionId: 500001, offerId: "o-1" });
    assert.strictEqual(key, "lne:trd:1001:20000:500001:o-1");
    const pA = S.standingDayPrefix(1001, 20000, 500001);
    assert.strictEqual(pA, "lne:trd:1001:20000:500001:");
    const endA = S.standingDayRangeEnd(pA);
    assert.ok(key >= pA && key < endA);
    const otherFaction = S.standingGrantKey({ characterId: 1001, day: 20000, factionId: 5000010, offerId: "o-2" });
    assert.ok(!(otherFaction >= pA && otherFaction < endA));
  });

  needsDriver("TS4 toggle: standingGrantEnabled=false → STANDING_DISABLED, no vendor calls", () =>
    H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const rt = fakeRuntime();
      const env = bootStanding(reopen(), shared, {
        EVEJS_LNE_TRADE_STANDING_GRANT_ENABLED: "false",
      }, rt);

      const decision = tx(env, (db) => {
        const d = env.standing.decideInTx(db, makeOffer({ offerId: "offer-ts4", contractId: 666 }), shared.clock.now());
        if (d.ok !== true) throw new StandingRollback(d);
        return d;
      });
      assert.deepStrictEqual(decision.outcome, "STANDING_DISABLED");
      assert.strictEqual(rt.calls, 0);
    }));

  needsDriver("TS4 toggle: full service → handler exists, panel standing, stop() → stopped", () =>
    H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const rt = fakeRuntime();
      const env = bootStanding(reopen(), shared, {
        EVEJS_LNE_TRADE_STANDING_GRANT_ENABLED: "true",
        EVEJS_LNE_TRADE_STANDING_MAX_GRANTS_PER_CHARACTER_DAY: "100",
        EVEJS_LNE_TRADE_STANDING_GRANT_MAX_AGE_MS: "604800000",
      }, rt);

      assert.ok(env.handler);
      assert.strictEqual(typeof env.handler, "function");

      const status = env.standing.getStatus();
      assert.ok(status);
      assert.strictEqual(status.state, "ready");
      assert.ok(typeof status.counters === "object");

      env.standing.stop();
      assert.ok(env.standing.isStopped());
    }));

};