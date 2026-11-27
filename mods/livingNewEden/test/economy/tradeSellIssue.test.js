"use strict";

const assert = require("node:assert");

const { createTradeExecutor } = require("../../lib/economy/trade/tradeExecutor");
const { buildWantToSellCall } = require("../../lib/adapter/tradeContracts");
const { createFakeTradeAdapter } = require("../_support/fakeTradeAdapter");
const TS = require("../../lib/economy/trade/schema");
const { harness: H } = require("../battle/settlement.test");
const { harness: W } = require("./tradeSellEscrow.test");

const F = H.FACTION_A;
const CEO = 3019001;
const NPC_A = 60000000 + "a".charCodeAt(0);
const CHAR = 91000001;
const CHAR_CORP = 98000001;
const ISSUE_TIMEOUT_MS = 1800000;
const WATCHED = ["tradeGrantStock", "tradeGrantReceipt", "tradeCreateSellContract", "tradeCreateContract",
  "tradeAdjustWallet", "tradeVoidStack"];

function fakeAdapter() {
  const fake = createFakeTradeAdapter();
  fake.tradeReadIssuer = (corporationId) => Promise.resolve({ ok: true,
    issuer: { corporationId, ceoId: CEO, isNpc: true, hasRuntime: true } });
  const calls = [];
  for (const name of WATCHED) {
    const fn = fake[name];
    fake[name] = (...args) => { calls.push(name); return fn(...args); };
  }
  return { fake, calls };
}

function makeExec(env, shared, fake, over = {}, extra = {}) {
  const trade = { ...W.DEFAULTS.trade, enabled: true, contractsEnabled: true, wtsEnabled: true, virtualIssuers: false,
    externalPriceEnabled: false, maxBuyOrderOrphansPerPass: 0, maxRefundSweepsPerPass: 0,
    issueTimeoutMs: ISSUE_TIMEOUT_MS, ...over };
  return createTradeExecutor({
    store: env.store, journal: env.journal, offers: env.offers, budgets: env.budgets,
    getStations: () => env.stations, adapter: fake,
    priceCache: { put() {}, peek() { return null; }, getStatus() { return { entries: 0 }; } },
    config: { trade }, clock: shared.clock, mode: "run", getGovernor: () => ({ admits: () => true }),
    factionNames: new Map([[F, "Sansha"]]), logger: { log() {} }, ...extra,
  });
}

async function setup(reopen, shared, quantity = 1000) {
  const env = await W.boot(reopen(), shared, { wtsEnabled: true });
  W.addStation(env, "npc-a", F);
  W.seed(env, "npc-a", "type:34", 5000, "34");
  const offer = W.create(env, W.sellSpec(env, "npc-a", "type:34", quantity), "wti:sell:offer").offer;
  assert.strictEqual(W.stockOf(env, "npc-a", "type:34"), 5000 - quantity);
  return { env, offer };
}

const entryOf = (env, key) => env.tx((db) => env.journal.findByKey(db, key));
const hangarTotal = (fake, owner, npc) => fake._hangarStacksOf(owner, npc).reduce((s, x) => s + x.quantity, 0);

function telemetrySpy() {
  const counts = new Map();
  return { count(name, value = 1) { counts.set(name, (counts.get(name) || 0) + value); },
    observe() {}, sum: (name) => counts.get(name) || 0 };
}

module.exports = ({ test, skip }) => {
  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  needsDriver("WTI1 d2 WTS issue: corp and character info (buildWantToSellCall), grant -> create, no wallet leg, OPEN",
    () => H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const { env, offer } = await setup(reopen, shared);
      const { fake, calls } = fakeAdapter();
      const pass = await makeExec(env, shared, fake).runPass();
      assert.strictEqual(pass.opened, 1, JSON.stringify(pass));
      const o = W.offerOf(env, offer.offerId);
      assert.strictEqual(o.state, "OPEN");
      assert.deepStrictEqual(calls, ["tradeGrantStock", "tradeCreateSellContract"]);
      const box = entryOf(env, TS.issueOutboxKey(offer.offerId)).entry;
      assert.strictEqual(box.state, "APPLIED");
      const p = box.payload;
      assert.deepStrictEqual([p.side, p.priceIsk, p.quantity, p.typeId, p.packaged, p.grantKey, p.npcStationId, p.ceoId],
        ["sell", 1100, 1000, 34, false, `lne:trade:${offer.offerId}:grant`, NPC_A, CEO]);
      assert.strictEqual(p.rewardIsk, undefined);
      assert.strictEqual(p.title, "Sansha sells 1000 x Tritanium");
      const c = fake._state.contracts.get(o.contractId);
      const expected = buildWantToSellCall({ ...p, itemList: c.itemList });
      assert.ok(expected.ok, JSON.stringify(expected));
      assert.deepStrictEqual(c.payload.info, expected.info);
      assert.deepStrictEqual([c.payload.info.contractType, c.payload.info.price, c.payload.info.reward,
        c.payload.info.requestItemTypeList, c.payload.info.startStationDivision, c.payload.info.forCorp],
      [1, 1100, 0, [], 62, true]);
      assert.strictEqual(c.itemList.reduce((s, x) => s + x[1], 0), 1000);
      assert.strictEqual(c.payload.session.corpAccountKey, W.DEFAULTS.trade.walletAccountKey);
      assert.strictEqual(hangarTotal(fake, W.CORP, NPC_A), 0, "the goods are in the contract");
      assert.strictEqual(W.stockOf(env, "npc-a", "type:34"), 4000);

      W.addStation(env, "npc-b", F);
      W.seed(env, "npc-b", "type:35", 800, "35");
      const b = W.create(env, W.sellSpec(env, "npc-b", "type:35", 300), "wti1:char:offer").offer;
      fake._setWalletBalance(CHAR, 1000, 0);
      const vc = { listTradeIssuers: () => ({ ok: true, ready: true,
        issuers: [{ characterId: CHAR, corporationId: CHAR_CORP, slot: 1 }] }) };
      calls.length = 0;
      const pass2 = await makeExec(env, shared, fake, { virtualIssuers: true }, { getVirtualCorps: () => vc }).runPass();
      assert.strictEqual(pass2.opened, 1, JSON.stringify(pass2));
      const ob = W.offerOf(env, b.offerId);
      assert.deepStrictEqual([ob.state, ob.issuerCharacterId, ob.issuerCharacterCorpId], ["OPEN", CHAR, CHAR_CORP]);
      assert.deepStrictEqual(calls, ["tradeGrantStock", "tradeCreateSellContract"]);
      const cb = fake._state.contracts.get(ob.contractId);
      assert.deepStrictEqual([cb.payload.info.startStationDivision, cb.payload.info.forCorp, cb.issuerOwnerId,
        cb.payload.session.corpAccountKey, cb.payload.info.price], [4, false, CHAR, undefined, b.iskTotal]);
      assert.deepStrictEqual(cb.itemList.map((x) => x[1]), [300]);
    }));

  needsDriver("WTI2 d2 WTS without the stock-out entry: SELL_STOCK_OUT_MISSING, no grant; timeout -> LOST, no stock-back",
    () => H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const env = await W.boot(reopen(), shared, { wtsEnabled: true });
      W.addStation(env, "npc-a", F);
      W.seed(env, "npc-a", "type:34", 5000, "34");
      env.tx((db) => db.prepare("INSERT INTO world_trade_offers (offer_id, faction_id, station_id, system_id, "
        + "issuer_corporation_id, item_kind, item_key, type_id, quantity, unit_price_milli, isk_total, ref_price_milli, "
        + "price_source, state, created_at, expires_at, updated_at, version, side) VALUES ('ts_raw', ?, 'npc-a', ?, ?, "
        + "'mineral', 'type:34', 34, 10, 1100, 11, 1000, 'ask', 'PLANNED', ?, ?, ?, 1, 'sell')")
        .run(F, H.S.N0, W.CORP, env.at, env.at + 86400000, env.at));
      const { fake, calls } = fakeAdapter();
      const exec = makeExec(env, shared, fake);
      const p1 = await exec.runPass();
      assert.ok(p1.errors >= 1, JSON.stringify(p1));
      assert.strictEqual(W.offerOf(env, "ts_raw").state, "ISSUING");
      assert.deepStrictEqual(calls, [], "no grant without the stock-out entry");
      shared.clock.advance(ISSUE_TIMEOUT_MS);
      const p2 = await exec.runPass();
      assert.strictEqual(p2.aborted, 1, JSON.stringify(p2));
      const o = W.offerOf(env, "ts_raw");
      assert.deepStrictEqual([o.state, o.endReason], ["LOST", "SELL_STOCK_OUT_MISSING"]);
      assert.deepStrictEqual(calls, []);
      assert.strictEqual(W.stockOf(env, "npc-a", "type:34"), 5000);
      assert.strictEqual(entryOf(env, TS.stockBackKey("ts_raw")).found, false);
      assert.strictEqual(entryOf(env, TS.issueOutboxKey("ts_raw")).entry.state, "FAILED");
    }));

  needsDriver("WTI3 d2 WTS restart: after the grant -> duplicate grant, one contract; after the create -> record -> OPEN",
    () => H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const { env, offer } = await setup(reopen, shared);
      const { fake, calls } = fakeAdapter();
      fake._failNextSellCreate("Another contract operation is already pending.");
      const p1 = await makeExec(env, shared, fake).runPass();
      assert.strictEqual(p1.retried, 1, JSON.stringify(p1));
      assert.strictEqual(W.offerOf(env, offer.offerId).state, "ISSUING");
      assert.strictEqual(hangarTotal(fake, W.CORP, NPC_A), 1000);
      const grantSpy = [];
      const grant = fake.tradeGrantStock;
      fake.tradeGrantStock = (spec) => { const r = grant(spec); grantSpy.push(r); return r; };
      const p2 = await makeExec(env, shared, fake).runPass();
      assert.strictEqual(p2.opened, 1, JSON.stringify(p2));
      assert.deepStrictEqual(grantSpy.map((r) => [r.ok, r.duplicate]), [[true, true]]);
      assert.strictEqual(fake._grantReceipts.size, 1);
      assert.strictEqual(fake._state.contracts.size, 1);
      assert.strictEqual(hangarTotal(fake, W.CORP, NPC_A), 0);

      W.seed(env, "npc-a", "type:36", 700, "36");
      const b = W.create(env, W.sellSpec(env, "npc-a", "type:36", 700), "wti3:b:offer").offer;
      const create = fake.tradeCreateSellContract;
      fake.tradeCreateSellContract = async (payload) => { await create(payload); throw new Error("crash"); };
      await makeExec(env, shared, fake).runPass();
      assert.strictEqual(W.offerOf(env, b.offerId).state, "ISSUING");
      assert.strictEqual(fake._state.contracts.size, 2);
      fake.tradeCreateSellContract = create;
      calls.length = 0;
      const p4 = await makeExec(env, shared, fake).runPass();
      assert.strictEqual(p4.opened, 1, JSON.stringify(p4));
      const ob = W.offerOf(env, b.offerId);
      assert.strictEqual(ob.state, "OPEN");
      assert.strictEqual(fake._state.contracts.get(ob.contractId).offerId, b.offerId);
      assert.deepStrictEqual(calls, [], "no second grant, no second create");
      assert.strictEqual(fake._state.contracts.size, 2);
    }));

  needsDriver("WTI4 d2 WTS abort: receipt found -> INTAKE -> CANCELLED + stock back; receipt not found -> CANCELLED; "
    + "merged stack 150 / q 100 -> void 100", () => H.withStore(driver, async (reopen) => {
    const shared = H.sharedOf();
    const { env, offer } = await setup(reopen, shared);
    const { fake, calls } = fakeAdapter();
    const exec = makeExec(env, shared, fake);
    fake._failNextSellCreate(`Item 1 cannot be added to a contract from its current hangar.`);
    const p1 = await exec.runPass();
    assert.strictEqual(p1.retried, 1, JSON.stringify(p1));
    const p2 = await exec.runPass();
    assert.strictEqual(p2.aborted, 1, JSON.stringify(p2));
    const o = W.offerOf(env, offer.offerId);
    assert.deepStrictEqual([o.state, o.endReason, o.deliveredQuantity], ["CANCELLED", "ISSUE_FAILED", 1000]);
    const plan = entryOf(env, TS.returnOutboxKey(offer.offerId)).entry;
    assert.strictEqual(plan.state, "APPLIED");
    assert.deepStrictEqual(plan.payload.stacks.map((s) => s.quantity), [1000]);
    assert.strictEqual(plan.payload.reason, "ISSUE_FAILED");
    assert.strictEqual(W.stockOf(env, "npc-a", "type:34"), 5000);
    assert.strictEqual(hangarTotal(fake, W.CORP, NPC_A), 0);
    assert.ok(!calls.includes("tradeAdjustWallet") && !calls.includes("tradeCreateContract"), calls.join(","));

    W.seed(env, "npc-a", "type:37", 400, "37");
    const g = W.create(env, W.sellSpec(env, "npc-a", "type:37", 400), "wti4:g:offer").offer;
    fake._failNextGrant("ITEM_TYPE_NOT_FOUND");
    await exec.runPass();
    assert.strictEqual(W.offerOf(env, g.offerId).state, "ISSUING");
    env.stockOn = false;
    const pWait = await exec.runPass();
    assert.strictEqual(W.offerOf(env, g.offerId).state, "ISSUING", JSON.stringify(pWait));
    env.stockOn = true;
    await exec.runPass();
    const og = W.offerOf(env, g.offerId);
    assert.deepStrictEqual([og.state, og.endReason], ["CANCELLED", "ISSUE_FAILED"]);
    assert.strictEqual(W.stockOf(env, "npc-a", "type:37"), 400);
    assert.strictEqual(entryOf(env, TS.returnOutboxKey(g.offerId)).found, false);

    W.seed(env, "npc-a", "type:38", 100, "38");
    fake._addHangarStack(W.CORP, NPC_A, 5, 38, 50);
    const m = W.create(env, W.sellSpec(env, "npc-a", "type:38", 100), "wti4:m:offer").offer;
    fake._failNextSellCreate("Item 5 does not have the requested quantity.");
    await exec.runPass();
    assert.deepStrictEqual(fake._hangarStacksOf(W.CORP, NPC_A).filter((s) => s.typeId === 38).map((s) => [s.itemId, s.quantity]),
      [[5, 150]]);
    await exec.runPass();
    const om = W.offerOf(env, m.offerId);
    assert.deepStrictEqual([om.state, om.deliveredQuantity], ["CANCELLED", 100]);
    assert.deepStrictEqual(entryOf(env, TS.returnOutboxKey(m.offerId)).entry.payload.stacks, [{ itemId: 5, quantity: 100 }]);
    assert.deepStrictEqual(fake._hangarStacksOf(W.CORP, NPC_A).filter((s) => s.typeId === 38).map((s) => [s.itemId, s.quantity]),
      [[5, 50]]);
    assert.strictEqual(W.stockOf(env, "npc-a", "type:38"), 100);
  }));

  needsDriver("WTI9 WTS over the vendor contract limit (NPC CEO and virtual character issuer): CONTRACT_LIMIT "
    + "aborts in the same pass (no retry pass), goods back, trade.contractLimit, market breaker untouched",
  () => H.withStore(driver, async (reopen) => {
    const shared = H.sharedOf();
    const { env, offer } = await setup(reopen, shared);
    const { fake, calls } = fakeAdapter();
    const telemetry = telemetrySpy();
    const exec = makeExec(env, shared, fake, {}, { telemetry });
    fake._failNextSellCreate("Wrapped remote exception ConTooManyContractsMax 10");
    const p1 = await exec.runPass();
    assert.deepStrictEqual([p1.aborted, p1.retried], [1, 0], JSON.stringify(p1));
    const o = W.offerOf(env, offer.offerId);
    assert.deepStrictEqual([o.state, o.endReason], ["CANCELLED", "ISSUE_FAILED"]);
    assert.strictEqual(telemetry.sum("trade.contractLimit"), 1);
    assert.deepStrictEqual(calls.filter((c) => c === "tradeCreateSellContract").length, 1, "one create, no retry");
    await exec.runPass();
    assert.strictEqual(W.stockOf(env, "npc-a", "type:34"), 5000, "the goods are back in the station stock");
    assert.deepStrictEqual(calls.filter((c) => c === "tradeCreateSellContract").length, 1, "still one create");
    const market = exec.getStatus().market;
    assert.deepStrictEqual([market.tripped, market.issueFailures], [false, 0], "Counts market orders only");

    W.addStation(env, "npc-b", F);
    W.seed(env, "npc-b", "type:35", 800, "35");
    const b = W.create(env, W.sellSpec(env, "npc-b", "type:35", 300), "wti9:char:offer").offer;
    fake._setWalletBalance(CHAR, 1000, 0);
    const vc = { listTradeIssuers: () => ({ ok: true, ready: true,
      issuers: [{ characterId: CHAR, corporationId: CHAR_CORP, slot: 1 }] }) };
    fake._failNextSellCreate("Wrapped remote exception ConTooManyContractsMax 1");
    const exec2 = makeExec(env, shared, fake, { virtualIssuers: true }, { getVirtualCorps: () => vc, telemetry });
    const p2 = await exec2.runPass();
    assert.deepStrictEqual([p2.aborted, p2.retried], [1, 0], JSON.stringify(p2));
    const ob = W.offerOf(env, b.offerId);
    assert.deepStrictEqual([ob.state, ob.endReason, ob.issuerCharacterId], ["CANCELLED", "ISSUE_FAILED", CHAR]);
    assert.strictEqual(telemetry.sum("trade.contractLimit"), 2);
  }));

  needsDriver("WTI5 d2 WTS return restart: after the void -> ALREADY_COMMITTED, stock-back once; empty plan -> LOST "
    + "NOTHING_RETURNED", () => H.withStore(driver, async (reopen) => {
    const shared = H.sharedOf();
    const { env, offer } = await setup(reopen, shared);
    const { fake } = fakeAdapter();
    const first = makeExec(env, shared, fake);
    fake._failNextSellCreate("Item 1 does not have the requested quantity.");
    await first.runPass();
    const voidStack = fake.tradeVoidStack;
    const outcomes = [];
    fake.tradeVoidStack = async (spec) => { const r = await voidStack(spec); outcomes.push(r.outcome); throw new Error("crash"); };
    await first.runPass();
    assert.strictEqual(W.offerOf(env, offer.offerId).state, "INTAKE");
    assert.strictEqual(W.stockOf(env, "npc-a", "type:34"), 4000);
    fake.tradeVoidStack = async (spec) => { const r = await voidStack(spec); outcomes.push(r.outcome); return r; };
    const exec = makeExec(env, shared, fake);
    await exec.runPass();
    await exec.runPass();
    assert.deepStrictEqual(outcomes, ["VOIDED", "ALREADY_COMMITTED"]);
    const o = W.offerOf(env, offer.offerId);
    assert.deepStrictEqual([o.state, o.deliveredQuantity], ["CANCELLED", 1000]);
    assert.strictEqual(W.stockOf(env, "npc-a", "type:34"), 5000, "stock-back once");

    W.seed(env, "npc-a", "type:39", 60, "39");
    const e = W.create(env, W.sellSpec(env, "npc-a", "type:39", 60), "wti5:e:offer").offer;
    fake._failNextSellCreate("Item 1 does not have the requested quantity.");
    await exec.runPass();
    fake._state.hangarStacks.get(W.CORP).get(NPC_A).clear();
    await exec.runPass();
    const oe = W.offerOf(env, e.offerId);
    assert.deepStrictEqual([oe.state, oe.endReason], ["LOST", "NOTHING_RETURNED"]);
    assert.deepStrictEqual(entryOf(env, TS.returnOutboxKey(e.offerId)).entry.payload.stacks, []);
    assert.strictEqual(W.stockOf(env, "npc-a", "type:39"), 0);
    assert.strictEqual(entryOf(env, TS.stockBackKey(e.offerId)).found, false);
  }));

  needsDriver("WTI6 wtsEnabled false: PLANNED sell -> CANCELLED DISABLED + stock-back, no grant; a destroyed "
    + "station counts trade.wtsStockLost", () => H.withStore(driver, async (reopen) => {
    const shared = H.sharedOf();
    const { env, offer } = await setup(reopen, shared);
    const { fake, calls } = fakeAdapter();
    const tel = telemetrySpy();
    const exec = makeExec(env, shared, fake, { wtsEnabled: false }, { telemetry: tel });
    const p1 = await exec.runPass();
    assert.strictEqual(p1.closed, 1, JSON.stringify(p1));
    const o = W.offerOf(env, offer.offerId);
    assert.deepStrictEqual([o.state, o.endReason], ["CANCELLED", "DISABLED"]);
    assert.strictEqual(W.stockOf(env, "npc-a", "type:34"), 5000);
    assert.strictEqual(entryOf(env, TS.stockBackKey(offer.offerId)).found, true);
    assert.deepStrictEqual(calls, [], "no grant, no contract, no wallet leg");
    assert.strictEqual(tel.sum("trade.wtsStockLost"), 0);

    W.addStation(env, "npc-b", F);
    W.seed(env, "npc-b", "type:35", 300, "35");
    const d = W.create(env, W.sellSpec(env, "npc-b", "type:35", 300), "wti6:d:offer").offer;
    env.tx((db) => db.prepare("UPDATE world_stations SET state = 'DESTROYED' WHERE station_id = 'npc-b'").run());
    await exec.runPass();
    const od = W.offerOf(env, d.offerId);
    assert.deepStrictEqual([od.state, od.endReason], ["CANCELLED", "DISABLED"]);
    assert.strictEqual(W.stockOf(env, "npc-b", "type:35"), 0);
    assert.strictEqual(tel.sum("trade.wtsStockLost"), 300);
    assert.deepStrictEqual(calls, []);
  }));

  needsDriver("WTI7 cleanup (cleanupOnDisable): ISSUING sell with the grant -> abort DISABLED -> INTAKE -> step 7 "
    + "returns -> CANCELLED DISABLED; a buy offer in INTAKE untouched", () => H.withStore(driver, async (reopen) => {
    const shared = H.sharedOf();
    const { env, offer } = await setup(reopen, shared);
    const { fake, calls } = fakeAdapter();
    fake._failNextSellCreate("Another contract operation is already pending.");
    const p1 = await makeExec(env, shared, fake).runPass();
    assert.strictEqual(p1.retried, 1, JSON.stringify(p1));
    assert.strictEqual(W.offerOf(env, offer.offerId).state, "ISSUING");
    assert.strictEqual(hangarTotal(fake, W.CORP, NPC_A), 1000);
    env.tx((db) => db.prepare("INSERT INTO world_trade_offers (offer_id, faction_id, station_id, system_id, "
      + "issuer_corporation_id, item_kind, item_key, type_id, quantity, unit_price_milli, isk_total, ref_price_milli, "
      + "price_source, state, created_at, expires_at, updated_at, version, side) VALUES ('to_buy_raw', ?, 'npc-a', ?, ?, "
      + "'mineral', 'type:36', 36, 10, 1100, 11, 1000, 'bid', 'INTAKE', ?, ?, ?, 1, 'buy')")
      .run(F, H.S.N0, W.CORP, env.at, env.at + 86400000, env.at));
    const buy0 = W.offerOf(env, "to_buy_raw");

    calls.length = 0;
    const cleanup = makeExec(env, shared, fake, { cleanupOnDisable: true, intakeMaxRetries: 1 }, { mode: "cleanup" });
    for (let i = 0; i < 3 && W.offerOf(env, offer.offerId).state !== "CANCELLED"; i += 1) await cleanup.runPass();
    const o = W.offerOf(env, offer.offerId);
    assert.deepStrictEqual([o.state, o.endReason, o.deliveredQuantity], ["CANCELLED", "DISABLED", 1000]);
    const plan = entryOf(env, TS.returnOutboxKey(offer.offerId)).entry;
    assert.deepStrictEqual([plan.state, plan.payload.reason], ["APPLIED", "DISABLED"]);
    assert.strictEqual(W.stockOf(env, "npc-a", "type:34"), 5000);
    assert.strictEqual(hangarTotal(fake, W.CORP, NPC_A), 0);
    assert.ok(!calls.includes("tradeGrantStock") && !calls.includes("tradeCreateSellContract"), calls.join(","));
    assert.strictEqual(fake._state.contracts.size, 0);
    assert.deepStrictEqual(W.offerOf(env, "to_buy_raw"), buy0, "the buy offer in INTAKE is not touched");
  }));

  needsDriver("WTI8: sell INTAKE whose return keeps failing -> LOST INTAKE_RETRIES_EXHAUSTED "
    + "trade.wtsStockLost += quantity", () => H.withStore(driver, async (reopen) => {
    const shared = H.sharedOf();
    const { env, offer } = await setup(reopen, shared);
    const { fake } = fakeAdapter();
    const tel = telemetrySpy();
    const exec = makeExec(env, shared, fake, { intakeMaxRetries: 1 }, { telemetry: tel });
    fake._failNextSellCreate("Item 1 does not have the requested quantity.");
    await exec.runPass();
    assert.strictEqual(W.offerOf(env, offer.offerId).state, "ISSUING");
    fake.tradeVoidStack = () => Promise.resolve({ ok: false, reason: "VOID_BUSY", permanent: false });
    await exec.runPass();
    const o = W.offerOf(env, offer.offerId);
    assert.deepStrictEqual([o.state, o.endReason], ["LOST", "INTAKE_RETRIES_EXHAUSTED"]);
    assert.strictEqual(entryOf(env, TS.returnOutboxKey(offer.offerId)).entry.state, "FAILED");
    assert.strictEqual(tel.sum("trade.wtsStockLost"), 1000);
    assert.strictEqual(tel.sum("trade.intakeRetriesExhausted"), 1);
    assert.strictEqual(W.stockOf(env, "npc-a", "type:34"), 4000, "no stock-back");
  }));
};
