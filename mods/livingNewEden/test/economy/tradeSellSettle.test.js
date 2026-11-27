"use strict";

const assert = require("node:assert");

const { createTradeExecutor } = require("../../lib/economy/trade/tradeExecutor");
const { runOrphanScan } = require("../../lib/economy/trade/orphans");
const { createTreasuryRepository } = require("../../lib/economy/treasury/treasuryRepository");
const { createTreasuryService } = require("../../lib/economy/treasury/treasuryService");
const { createFakeTradeAdapter } = require("../_support/fakeTradeAdapter");
const TS = require("../../lib/economy/trade/schema");
const TRS = require("../../lib/economy/treasury/schema");
const { harness: H } = require("../battle/settlement.test");
const { harness: W } = require("./tradeSellEscrow.test");

const F = H.FACTION_A;
const CEO = 3019001;
const NPC_A = 60000000 + "a".charCodeAt(0);
const BUYER = 92000001;
const KEY = W.DEFAULTS.trade.walletAccountKey;
const PRICE = 1100;

function fakeAdapter(opts = {}) {
  const fake = createFakeTradeAdapter({}, opts);
  fake.tradeReadIssuer = (corporationId) => Promise.resolve({ ok: true,
    issuer: { corporationId, ceoId: CEO, isNpc: true, hasRuntime: true } });
  const legs = [];
  const adjust = fake.tradeAdjustWallet;
  fake.tradeAdjustWallet = (spec) => { legs.push({ commandId: spec.commandId, deltaIsk: spec.deltaIsk }); return adjust(spec); };
  return { fake, legs, adjust };
}

function makeExec(env, shared, fake, over = {}, extra = {}) {
  const trade = { ...W.DEFAULTS.trade, enabled: true, contractsEnabled: true, wtsEnabled: true, virtualIssuers: false,
    externalPriceEnabled: false, maxBuyOrderOrphansPerPass: 0, maxRefundSweepsPerPass: 0, maxIssuesPerPass: 8,
    maxIntakesPerPass: 8, ...over };
  const { treasury, ...rest } = extra;
  return createTradeExecutor({
    store: env.store, journal: env.journal, offers: env.offers, budgets: env.budgets,
    getStations: () => env.stations, adapter: fake,
    priceCache: { put() {}, peek() { return null; }, getStatus() { return { entries: 0 }; } },
    config: { trade, ...(treasury ? { treasury } : {}) }, clock: shared.clock, mode: "run",
    getGovernor: () => ({ admits: () => true }), factionNames: new Map([[F, "Sansha"]]), logger: { log() {} }, ...rest,
  });
}

function realTreasury(env, shared, seed) {
  const repository = createTreasuryRepository({ journal: env.journal, clock: shared.clock });
  const service = createTreasuryService({ store: env.store, repository, clock: shared.clock, hullValues: { version: 1 },
    config: { treasury: { ...W.DEFAULTS.treasury, enabled: true }, strategy: {} } });
  if (seed) {
    const r = env.tx((db) => repository.seedInTx(db, { factionId: F, kind: "pirate", initialIsk: 5000, at: env.at },
      "test:treasury:seed"));
    assert.ok(r.ok, JSON.stringify(r));
  }
  return { service, repository, row: () => env.tx((db) => repository.getInDb(db, F)).treasury };
}

function telemetrySpy() {
  const counts = new Map();
  return { count(name, value = 1) { counts.set(name, (counts.get(name) || 0) + value); },
    observe() {}, sum: (name) => counts.get(name) || 0 };
}

const entryOf = (env, key) => env.tx((db) => env.journal.findByKey(db, key));
const budgetOf = (env) => env.tx((db) => env.budgets.getBudget(db, F)).budget;
const hangarTotal = (fake, typeId) => fake._hangarStacksOf(W.CORP, NPC_A).filter((s) => typeId === undefined
  || s.typeId === typeId).reduce((s, x) => s + x.quantity, 0);

async function boot(reopen, shared) {
  const env = await W.boot(reopen(), shared, { wtsEnabled: true });
  W.addStation(env, "npc-a", F);
  return env;
}

async function openSell(env, shared, exec, itemKey, q, tag) {
  W.seed(env, "npc-a", itemKey, q, tag);
  const offer = W.create(env, W.sellSpec(env, "npc-a", itemKey, q), `wtp:${tag}`).offer;
  await exec.runPass();
  const o = W.offerOf(env, offer.offerId);
  assert.strictEqual(o.state, "OPEN", JSON.stringify(o));
  return o;
}

function fundBudget(env, isk) {
  const r = env.tx((db) => env.budgets.fundIskInTx(db, { factionId: F, isk, capIsk: 1e12, at: env.at }, "test:fund"));
  assert.ok(r.ok && r.fundedIsk === isk, JSON.stringify(r));
}

module.exports = ({ test, skip }) => {
  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  needsDriver("WTP1 d3 sale: FINISHED -> ACCEPTED (no budget edge, no standing) -> proceeds leg -> budget to the cap, "
    + "rest burned -> DELIVERED; crash after the leg -> duplicate leg, one credit", () => H.withStore(driver, async (reopen) => {
    const shared = H.sharedOf();
    const env = await boot(reopen, shared);
    fundBudget(env, 400);
    const { fake, legs, adjust } = fakeAdapter();
    fake._setWalletBalance(W.CORP, KEY, 5000);
    let decided = 0;
    const standing = { decideInTx() { decided += 1; return { ok: true }; }, noteCommitted() {}, noteWriteFailed() {} };
    const tel = telemetrySpy();
    const extra = { telemetry: tel, deliveryStanding: standing };
    const o = await openSell(env, shared, makeExec(env, shared, fake, { iskBudgetCap: 1000 }, extra), "type:34", 1000, "a");
    const b0 = budgetOf(env);
    assert.ok(fake._finishSell(o.contractId, BUYER));
    assert.strictEqual(fake._balance(W.CORP, KEY), 5000 + PRICE);

    const proceedsKey = TS.walletCommandId(o.offerId, "proceeds");
    fake.tradeAdjustWallet = async (spec) => {
      legs.push({ commandId: spec.commandId, deltaIsk: spec.deltaIsk });
      const r = await adjust(spec);
      if (spec.commandId === proceedsKey) throw new Error("crash");
      return r;
    };
    await makeExec(env, shared, fake, { iskBudgetCap: 1000 }, extra).runPass();
    const a = W.offerOf(env, o.offerId);
    assert.deepStrictEqual([a.state, a.acceptorCharacterId], ["ACCEPTED", BUYER]);
    const b1 = budgetOf(env);
    assert.deepStrictEqual([b1.availableIsk, b1.reservedIsk, b1.spentTotal, b1.wtsProceedsTotal],
      [b0.availableIsk, b0.reservedIsk, b0.spentTotal, 0], "OPEN -> ACCEPTED has no budget edge");
    assert.strictEqual(decided, 0, "no standing grant for a WTS sale");
    assert.strictEqual(fake._balance(W.CORP, KEY), 5000);

    fake.tradeAdjustWallet = (spec) => { legs.push({ commandId: spec.commandId, deltaIsk: spec.deltaIsk }); return adjust(spec); };
    await makeExec(env, shared, fake, { iskBudgetCap: 1000 }, extra).runPass();
    const d = W.offerOf(env, o.offerId);
    assert.deepStrictEqual([d.state, d.endReason, d.deliveredQuantity], ["DELIVERED", "DELIVERED", 1000]);
    assert.strictEqual(fake._balance(W.CORP, KEY), 5000, "the price left the wallet once");
    const b2 = budgetOf(env);
    assert.deepStrictEqual([b2.availableIsk, b2.reservedIsk, b2.spentTotal, b2.wtsProceedsTotal, b2.wtsTreasuryTotal,
      b2.wtsBurnedTotal], [1000, 0, 0, 600, 0, 500]);
    assert.deepStrictEqual(legs.map((l) => [l.commandId, l.deltaIsk]), [[proceedsKey, -PRICE], [proceedsKey, -PRICE]]);
    assert.deepStrictEqual([tel.sum("trade.wtsSold"), tel.sum("trade.wtsDelivered"), tel.sum("trade.wtsProceedsIsk"),
      tel.sum("trade.wtsProceedsBurned"), tel.sum("trade.wtsProceedsTreasury")], [1, 1, 600, 500, 0]);
    assert.strictEqual(entryOf(env, TS.proceedsBudgetKey(o.offerId)).found, true);
    assert.strictEqual(W.stockOf(env, "npc-a", "type:34"), 0, "the goods were sold");

    const again = env.tx((db) => env.budgets.creditProceedsInTx(db, { factionId: F, isk: PRICE, capIsk: 1e12,
      at: env.at }, TS.proceedsBudgetKey(o.offerId)));
    assert.deepStrictEqual([again.ok, again.duplicate, again.creditedIsk, again.overflowIsk], [true, true, 0, 0]);
    await makeExec(env, shared, fake, { iskBudgetCap: 1000 }, extra).runPass();
    assert.deepStrictEqual(budgetOf(env), b2);
    assert.strictEqual(legs.length, 2);
  }));

  needsDriver("WTP2 d3 overflow: treasury trade_in; treasury on but not ready -> waits; NO_TREASURY -> burned; leg "
    + "INSUFFICIENT_FUNDS -> LOST PROCEEDS_FAILED", () => H.withStore(driver, async (reopen) => {
    const shared = H.sharedOf();
    const env = await boot(reopen, shared);
    const { fake, legs } = fakeAdapter();
    const tel = telemetrySpy();
    const on = { enabled: true };
    const cap = { iskBudgetCap: 300 };

    const t = realTreasury(env, shared, true);
    const t0 = t.row();
    let exec = makeExec(env, shared, fake, cap, { telemetry: tel, treasury: on, getTreasury: () => t.service });
    const a = await openSell(env, shared, exec, "type:34", 1000, "a");
    fake._finishSell(a.contractId, BUYER);
    await exec.runPass();
    assert.strictEqual(W.offerOf(env, a.offerId).state, "DELIVERED");
    const t1 = t.row();
    assert.deepStrictEqual([t1.balanceIsk, t1.totals.tradeIn, t1.mode, t1.paidUntil, t1.totals.tradeOut],
      [t0.balanceIsk + 800, 800, t0.mode, t0.paidUntil, 0]);
    const tEntry = entryOf(env, TS.proceedsTreasuryKey(a.offerId));
    assert.deepStrictEqual([tEntry.found, tEntry.entry.eventType], [true, TRS.EVENT_SETTLED]);
    let b = budgetOf(env);
    assert.deepStrictEqual([b.availableIsk, b.wtsProceedsTotal, b.wtsTreasuryTotal, b.wtsBurnedTotal], [300, 300, 800, 0]);
    assert.strictEqual(tel.sum("trade.wtsProceedsTreasury"), 800);

    let treasury = null;
    exec = makeExec(env, shared, fake, cap, { telemetry: tel, treasury: on, getTreasury: () => treasury });
    const w = await openSell(env, shared, exec, "type:35", 1000, "w");
    fake._finishSell(w.contractId, BUYER);
    await exec.runPass();
    await exec.runPass();
    assert.strictEqual(W.offerOf(env, w.offerId).state, "ACCEPTED");
    assert.deepStrictEqual(budgetOf(env), b, "nothing credited while the treasury is not ready");
    assert.strictEqual(tel.sum("trade.wtsProceedsWait"), 1);
    assert.strictEqual(exec.getStatus().wts.proceedsWait, 1);
    treasury = t.service;
    await exec.runPass();
    assert.strictEqual(W.offerOf(env, w.offerId).state, "DELIVERED");
    assert.strictEqual(t.row().totals.tradeIn, 800 + PRICE, "the budget is full: the whole price to the treasury");
    assert.strictEqual(legs.filter((x) => x.commandId === TS.walletCommandId(w.offerId, "proceeds")).length, 1);
    assert.strictEqual(entryOf(env, TS.proceedsLegKey(w.offerId)).found, true);

    const empty = realTreasury(env, shared, false);
    env.tx((db) => db.prepare("DELETE FROM world_faction_treasury WHERE faction_id = ?").run(F));
    exec = makeExec(env, shared, fake, cap, { telemetry: tel, treasury: on, getTreasury: () => empty.service });
    const n = await openSell(env, shared, exec, "type:36", 1000, "n");
    fake._finishSell(n.contractId, BUYER);
    b = budgetOf(env);
    await exec.runPass();
    assert.strictEqual(W.offerOf(env, n.offerId).state, "DELIVERED");
    const bn = budgetOf(env);
    assert.deepStrictEqual([bn.availableIsk, bn.wtsBurnedTotal, bn.wtsTreasuryTotal], [b.availableIsk,
      b.wtsBurnedTotal + PRICE, b.wtsTreasuryTotal]);
    assert.strictEqual(entryOf(env, TS.proceedsTreasuryKey(n.offerId)).found, false);

    const l = await openSell(env, shared, exec, "type:37", 1000, "l");
    fake._finishSell(l.contractId, BUYER);
    fake._setWalletBalance(W.CORP, KEY, 0);
    await exec.runPass();
    const ol = W.offerOf(env, l.offerId);
    assert.deepStrictEqual([ol.state, ol.endReason], ["LOST", "PROCEEDS_FAILED"]);
    assert.deepStrictEqual(budgetOf(env), bn);
    assert.strictEqual(tel.sum("trade.wtsProceedsFailed"), 1);
  }));

  needsDriver("WTP3 d3 close: EXPIRED -> delete -> INTAKE -> return -> CANCELLED EXPIRED; DELETED -> DELETED_EXTERNALLY; "
    + "no record -> CONTRACT_MISSING; no wallet leg", () => H.withStore(driver, async (reopen) => {
    const shared = H.sharedOf();
    const env = await boot(reopen, shared);
    const { fake, legs } = fakeAdapter({ leaveDeletedRecord: true });
    const exec = makeExec(env, shared, fake);

    const e = await openSell(env, shared, exec, "type:34", 1000, "e");
    assert.strictEqual(W.stockOf(env, "npc-a", "type:34"), 0);
    shared.clock.advance(e.expiresAt - shared.clock.now());
    const p = await exec.runPass();
    assert.strictEqual(p.closed, 1, JSON.stringify(p));
    const oe = W.offerOf(env, e.offerId);
    assert.deepStrictEqual([oe.state, oe.endReason, oe.deliveredQuantity], ["CANCELLED", "EXPIRED", 1000]);
    const plan = entryOf(env, TS.returnOutboxKey(e.offerId)).entry;
    assert.deepStrictEqual([plan.state, plan.payload.reason, plan.payload.stacks.reduce((s, x) => s + x.quantity, 0)],
      ["APPLIED", "EXPIRED", 1000]);
    assert.strictEqual(fake._state.contracts.get(oe.contractId).status, "DELETED");
    assert.strictEqual(W.stockOf(env, "npc-a", "type:34"), 1000);
    assert.strictEqual(hangarTotal(fake, 34), 0);

    const x = await openSell(env, shared, exec, "type:35", 500, "x");
    const del = await fake.tradeDeleteContract({ contractId: x.contractId, ceoId: CEO, corporationId: W.CORP });
    assert.ok(del.ok, JSON.stringify(del));
    assert.strictEqual(hangarTotal(fake, 35), 500);
    await exec.runPass();
    const ox = W.offerOf(env, x.offerId);
    assert.deepStrictEqual([ox.state, ox.endReason], ["CANCELLED", "DELETED_EXTERNALLY"]);
    assert.strictEqual(W.stockOf(env, "npc-a", "type:35"), 500);

    const m = await openSell(env, shared, exec, "type:36", 200, "m");
    await fake.tradeDeleteContract({ contractId: m.contractId, ceoId: CEO, corporationId: W.CORP });
    fake._state.contracts.delete(m.contractId);
    await exec.runPass();
    const om = W.offerOf(env, m.offerId);
    assert.deepStrictEqual([om.state, om.endReason], ["CANCELLED", "CONTRACT_MISSING"]);
    assert.strictEqual(W.stockOf(env, "npc-a", "type:36"), 200);
    assert.deepStrictEqual(legs, [], "no wallet leg (no defund) on a WTS close");
  }));

  needsDriver("WTP4 d3 cleanup (cleanupOnDisable): sell PLANNED / ISSUING / OPEN / INTAKE / ACCEPTED all end; stock = "
    + "before minus the sold offer; buy ACCEPTED untouched", () => H.withStore(driver, async (reopen) => {
    const shared = H.sharedOf();
    const env = await boot(reopen, shared);
    const { fake, adjust } = fakeAdapter({ leaveDeletedRecord: true });
    const run = makeExec(env, shared, fake);
    const acc = await openSell(env, shared, run, "type:34", 1000, "acc");
    const itk = await openSell(env, shared, run, "type:35", 300, "itk");
    const opn = await openSell(env, shared, run, "type:36", 200, "opn");
    fake._finishSell(acc.contractId, BUYER);
    await fake.tradeDeleteContract({ contractId: itk.contractId, ceoId: CEO, corporationId: W.CORP });
    fake.tradeAdjustWallet = () => Promise.resolve({ ok: false, reason: "WALLET_BUSY", permanent: false });
    const voidStack = fake.tradeVoidStack;
    fake.tradeVoidStack = () => Promise.resolve({ ok: false, reason: "VOID_BUSY", permanent: false });
    await run.runPass();
    W.seed(env, "npc-a", "type:37", 100, "iss");
    const iss = W.create(env, W.sellSpec(env, "npc-a", "type:37", 100), "wtp:iss").offer;
    fake._failNextSellCreate("Another contract operation is already pending.");
    await run.runPass();
    W.seed(env, "npc-a", "type:38", 50, "pln");
    const pln = W.create(env, W.sellSpec(env, "npc-a", "type:38", 50), "wtp:pln").offer;
    const before = Object.fromEntries([[acc, "ACCEPTED"], [itk, "INTAKE"], [opn, "OPEN"], [iss, "ISSUING"],
      [pln, "PLANNED"]].map(([o, s]) => [s, W.offerOf(env, o.offerId).state]));
    assert.deepStrictEqual(before, { ACCEPTED: "ACCEPTED", INTAKE: "INTAKE", OPEN: "OPEN", ISSUING: "ISSUING",
      PLANNED: "PLANNED" });
    env.tx((db) => db.prepare("INSERT INTO world_trade_offers (offer_id, faction_id, station_id, system_id, "
      + "issuer_corporation_id, item_kind, item_key, type_id, quantity, unit_price_milli, isk_total, ref_price_milli, "
      + "price_source, state, created_at, expires_at, updated_at, version, side, contract_id) VALUES ('to_buy_acc', ?, "
      + "'npc-a', ?, ?, 'mineral', 'type:39', 39, 10, 1100, 11, 1000, 'bid', 'ACCEPTED', ?, ?, ?, 1, 'buy', 77)")
      .run(F, H.S.N0, W.CORP, env.at, env.at + 86400000, env.at));
    const buy0 = W.offerOf(env, "to_buy_acc");

    fake.tradeAdjustWallet = adjust;
    fake.tradeVoidStack = voidStack;
    fake._setWalletBalance(W.CORP, KEY, PRICE);
    const cleanup = makeExec(env, shared, fake, { cleanupOnDisable: true, intakeMaxRetries: 1 }, { mode: "cleanup" });
    const ids = [acc, itk, opn, iss, pln].map((o) => o.offerId);
    const terminal = () => ids.every((id) => ["DELIVERED", "CANCELLED", "LOST"].includes(W.offerOf(env, id).state));
    for (let i = 0; i < 4 && !terminal(); i += 1) await cleanup.runPass();
    assert.deepStrictEqual(ids.map((id) => [W.offerOf(env, id).state, W.offerOf(env, id).endReason]), [
      ["DELIVERED", "DELIVERED"], ["CANCELLED", "DELETED_EXTERNALLY"], ["CANCELLED", "DISABLED"],
      ["CANCELLED", "DISABLED"], ["CANCELLED", "DISABLED"]]);
    assert.deepStrictEqual(["type:34", "type:35", "type:36", "type:37", "type:38"].map((k) => W.stockOf(env, "npc-a", k)),
      [0, 300, 200, 100, 50], "every unsold unit back in the stock, the sold 1000 gone");
    assert.strictEqual(budgetOf(env).wtsProceedsTotal, PRICE);
    assert.strictEqual(hangarTotal(fake), 0);
    assert.deepStrictEqual(W.offerOf(env, "to_buy_acc"), buy0, "the buy offer in ACCEPTED is not touched");
  }));

  needsDriver("WTP5 d3 orphans: sell CANCELLED / DELIVERED contract -> delete, no leg; ts_ without a row "
    + "-> no leg; buy CANCELLED -> defund as before", () => H.withStore(driver, async (reopen) => {
    const shared = H.sharedOf();
    const env = await boot(reopen, shared);
    const { fake, legs } = fakeAdapter();
    const run = makeExec(env, shared, fake);
    const c = await openSell(env, shared, run, "type:34", 1000, "c");
    const d = await openSell(env, shared, run, "type:35", 400, "d");
    env.tx((db) => {
      db.prepare("UPDATE world_trade_offers SET state = 'CANCELLED', end_reason = 'DISABLED', ended_at = ? "
        + "WHERE offer_id = ?").run(env.at, c.offerId);
      db.prepare("UPDATE world_trade_offers SET state = 'DELIVERED', end_reason = 'DELIVERED', ended_at = ? "
        + "WHERE offer_id = ?").run(env.at, d.offerId);
    });
    const handMade = (contractId, offerId, reward) => fake._state.contracts.set(contractId, {
      contractId, offerId, corporationId: W.CORP, issuerOwnerId: W.CORP, status: "OUTSTANDING",
      payload: { info: { description: `[LNE:${offerId}] x`, reward, forCorp: true },
        session: { characterID: CEO, corporationID: W.CORP } },
      escrowIsk: reward, walletRef: { kind: "corporation", ownerId: W.CORP, accountKey: KEY } });
    handMade(7000001, "ts_ghost", 500);
    env.tx((db) => db.prepare("INSERT INTO world_trade_offers (offer_id, faction_id, station_id, system_id, "
      + "issuer_corporation_id, item_kind, item_key, type_id, quantity, unit_price_milli, isk_total, ref_price_milli, "
      + "price_source, state, created_at, expires_at, updated_at, version, side, end_reason, ended_at) VALUES "
      + "('to_buyx', ?, 'npc-a', ?, ?, 'mineral', 'type:36', 36, 10, 1100, 11, 1000, 'bid', 'CANCELLED', ?, ?, ?, 1, "
      + "'buy', 'EXPIRED', ?)").run(F, H.S.N0, W.CORP, env.at, env.at + 86400000, env.at, env.at));
    handMade(7000002, "to_buyx", 11);

    const tel = telemetrySpy();
    const res = await runOrphanScan({ store: env.store, journal: env.journal, offers: env.offers, adapter: fake,
      config: { trade: { ...W.DEFAULTS.trade, maxOrphansPerPass: 10 } }, clock: shared.clock, telemetry: tel,
      logger: { log() {} }, getStations: () => env.stations }, true, 0);
    assert.deepStrictEqual([res.deleted, res.errors], [4, 0], JSON.stringify(res));
    assert.strictEqual(fake._state.contracts.size, 0);
    assert.deepStrictEqual(legs.map((l) => [l.commandId, l.deltaIsk]), [["lne:trade:to_buyx:defund", -11]],
      "only the buy orphan is defunded");
    assert.deepStrictEqual([tel.sum("trade.wtsOrphans"), tel.sum("trade.orphans")], [3, 4]);
    assert.deepStrictEqual([hangarTotal(fake, 34), hangarTotal(fake, 35)], [1000, 400]);
    assert.deepStrictEqual([W.stockOf(env, "npc-a", "type:34"), W.stockOf(env, "npc-a", "type:35")], [0, 0]);
  }));

  needsDriver("WTP6 replayed proceeds leg below the price: the vendor receipt answers duplicate -> DELIVERED "
    + "one budget credit, no second debit", () => H.withStore(driver, async (reopen) => {
    const shared = H.sharedOf();
    const env = await boot(reopen, shared);
    const { fake, legs, adjust } = fakeAdapter();
    const tel = telemetrySpy();
    const cap = { iskBudgetCap: 1e9 };
    fundBudget(env, 400);
    fake._setWalletBalance(W.CORP, KEY, 0);
    const o = await openSell(env, shared, makeExec(env, shared, fake, cap, { telemetry: tel }), "type:34", 1000, "r");
    assert.ok(fake._finishSell(o.contractId, BUYER));
    const proceedsKey = TS.walletCommandId(o.offerId, "proceeds");
    const done = await adjust({ ownerKind: "corporation", corporationId: W.CORP, accountKey: KEY, deltaIsk: -PRICE,
      commandId: proceedsKey, description: `lne-trade proceeds ${o.offerId}` });
    assert.deepStrictEqual(done, { ok: true, duplicate: false, fingerprintMismatch: false });
    assert.strictEqual(fake._balance(W.CORP, KEY), 0);
    assert.strictEqual(entryOf(env, TS.proceedsLegKey(o.offerId)).found, false, "no marker before the pass");
    const b0 = budgetOf(env);

    await makeExec(env, shared, fake, cap, { telemetry: tel }).runPass();
    const d = W.offerOf(env, o.offerId);
    assert.deepStrictEqual([d.state, d.endReason], ["DELIVERED", "DELIVERED"], JSON.stringify(d));
    assert.deepStrictEqual(legs.map((l) => [l.commandId, l.deltaIsk]), [[proceedsKey, -PRICE]], "one replayed leg");
    assert.strictEqual(fake._balance(W.CORP, KEY), 0, "no second debit");
    assert.strictEqual(entryOf(env, TS.proceedsLegKey(o.offerId)).found, true);
    assert.strictEqual(entryOf(env, TS.proceedsBudgetKey(o.offerId)).found, true);
    const b1 = budgetOf(env);
    assert.deepStrictEqual([b1.availableIsk - b0.availableIsk, b1.wtsProceedsTotal], [PRICE, PRICE], "credited once");
    assert.strictEqual(tel.sum("trade.wtsProceedsFailed"), 0);
    await makeExec(env, shared, fake, cap, { telemetry: tel }).runPass();
    assert.deepStrictEqual(budgetOf(env), b1);
    assert.strictEqual(legs.length, 1);
  }));
};
