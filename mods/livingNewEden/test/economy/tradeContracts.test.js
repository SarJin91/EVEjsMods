"use strict";

const assert = require("node:assert");
const { createJournal } = require("../../lib/persistence/journal");
const { openStore } = require("../../lib/persistence/store");
const { LATEST_SCHEMA_VERSION, MIGRATIONS } = require("../../lib/persistence/migrations");
const { createBudgetRepository } = require("../../lib/economy/trade/budgetRepository");
const { createOfferRepository } = require("../../lib/economy/trade/offerRepository");
const { createTradeExecutor } = require("../../lib/economy/trade/tradeExecutor");
const { createFakeTradeAdapter } = require("../_support/fakeTradeAdapter");
const { buildIssuePayload } = require("../../lib/economy/trade/executorRules");
const { harness: H } = require("../battle/settlement.test");
const S = require("../../lib/economy/trade/schema");

const driver = H.loadDriver();

const F = 500019;
const CORP = 999999;
const CEO = 123456789;
const STATION = "npc-1";
const STATION_ID = 60003760;
const SYSTEM = 30000001;
const AT = 1000000;
const CLOCK = { now: () => AT };

let idCounter = 0;
const IDS = { next: (p) => `${p}_${++idCounter}` };

function insertStation(store, clock) {
  const now = clock.now();
  const tx = store.transaction("test.insertStation", (db) => {
    const stmt = db.prepare(`
      INSERT INTO world_stations (station_id, kind, npc_station_id, type_id, structure_family, system_id,
        owner_faction_id, owner_corporation_id, state, state_until_at, name, position_json, origin,
        evejs_item_id, destroyed_at, created_at, updated_at, version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(STATION, "npc", STATION_ID, 35834, "Sansha", SYSTEM, F, CORP, "ONLINE", null, "Sansha Testing Station", '{"x":0,"y":0,"z":0}', "seed", null, null, now, now, 1);
    return { ok: true };
  });
  if (!tx.ok) throw new Error(`insertStation failed: ${JSON.stringify(tx)}`);
  return tx.value;
}

function makeOffer(overrides = {}) {
  return {
    offerId: IDS.next("to"),
    factionId: F,
    stationId: STATION,
    systemId: SYSTEM,
    issuerCorporationId: CORP,
    itemKind: "mineral",
    itemKey: "type:34",
    typeId: 34,
    quantity: 1000,
    unitPriceMilli: 1100,
    iskTotal: 1100,
    refPriceMilli: 1000,
    capPriceMilli: 1960,
    priceSource: "bid",
    state: "PLANNED",
    stateSeq: 0,
    endReason: null,
    contractId: null,
    acceptorCharacterId: null,
    deliveredQuantity: 0,
    createdAt: AT,
    expiresAt: AT + 259200000,
    updatedAt: AT,
    endedAt: null,
    version: 1,
    at: AT,
    ...overrides,
  };
}

function makeConfig(overrides = {}) {
  const baseTrade = {
    contractsEnabled: true, cleanupOnDisable: false, walletAccountKey: 1006,
    contractTtlMs: 259200000, executorPollMs: 60000, maxIssuesPerPass: 2,
    maxPollsPerPass: 16, maxClosesPerPass: 4, issueTimeoutMs: 1800000,
    priceRegionId: 10000002, maxPriceRegions: 8, priceRefreshMs: 1800000,
  };
  return {
    ...overrides,
    trade: { ...baseTrade, ...(overrides.trade || {}) },
  };
}

function createRepos() {
  const journal = createJournal({ clock: CLOCK, maxPayloadBytes: 16384, maxRows: 500 });
  const budgets = createBudgetRepository({ journal, clock: CLOCK });
  const offers = createOfferRepository({ journal, budgets, ids: IDS, clock: CLOCK });
  const priceCache = { put() {}, peek() { return null; }, getStatus() { return { entries: 0, source: "none", newestAt: null }; } };
  return { journal, budgets, offers, priceCache };
}

function createExecutor({ store, journal, offers, budgets, adapter, priceCache, config, getStations, getGraph, telemetry, getVirtualCorps, mode = "run" }) {
  const cfg = config || makeConfig();
  const pc = priceCache || { put() {}, peek() { return null; }, getStatus() { return { entries: 0, source: "none", newestAt: null }; } };
  return createTradeExecutor({
    store, journal, offers, budgets,
    getStations: () => getStations || { [STATION]: { stationId: STATION_ID, kind: "npc", ownerCorporationId: CORP, systemId: SYSTEM, destroyed: false } },
    getGraph: () => getGraph || null, adapter, priceCache: pc, config: cfg, clock: CLOCK,
    mode, getGovernor: () => ({ admits: () => true }),
    factionNames: new Map([[F, "Sansha"]]), telemetry: telemetry || null, getVirtualCorps,
    logger: { log: () => {} },
  });
}

function fundBudget(tx, budgets) {
  tx((db) => budgets.fundInTx(db, { factionId: F, units: 100, paidUntilTo: AT, iskPerUnit: 1000, capIsk: 1000000, at: AT }, "fund:1"));
}

function createOffer(tx, offers, offerId, stationId = STATION, itemKey = "type:34", typeId = 34) {
  const offerSpec = makeOffer({ offerId, stationId, itemKey, typeId });
  const r = tx((db) => offers.createOfferInTx(db, offerSpec, `ik:${offerId}:offer:${offerId}:${stationId}`));
  assert.ok(r.ok && !r.duplicate, `create offer ${offerId}`);
  return r.offer;
}

function issueOffer(tx, offers, journal, offerId, now, npcStationId = STATION_ID) {
  const offerSpec = makeOffer({ offerId });
  const r = tx((db) => offers.createOfferInTx(db, offerSpec, `ik:${offerId}:offer:${offerId}`));
  assert.ok(r.ok && !r.duplicate, `create offer ${offerId}`);
  const offer = r.offer;
  tx((db) => offers.transitionOfferInTx(db, {
    offerId: offer.offerId, expectedVersion: 1, from: S.PLANNED, to: S.ISSUING, reason: "", at: now,
    patch: { expiresAt: now + makeConfig().trade.contractTtlMs }
  }, S.transitionKey(offer.offerId, 1, S.ISSUING)));
  tx((db) => journal.enqueueOutbox(db, {
    key: S.issueOutboxKey(offer.offerId),
    aggregate: { type: S.OFFER_AGGREGATE, id: offer.offerId },
    eventType: S.EVENT_OUTBOX_ISSUE,
    payload: { offerId: offer.offerId, corporationId: CORP, ceoId: CEO, accountKey: 1006, npcStationId,
      typeId: 34, quantity: 1000, rewardIsk: 1100, minutesExpire: 4320, title: "Sansha: purchase order",
      description: `[LNE:${offer.offerId}] Sansha buys 1000 units of this item for its station. Deliver to this station.` }
  }));
  return offer;
}

function openOffer(tx, offers, journal, offerId, now, contractId, npcStationId = STATION_ID) {
  const offerSpec = makeOffer({ offerId, state: "OPEN", stateSeq: 2, contractId, version: 3 });
  let r = tx((db) => offers.createOfferInTx(db, offerSpec, `ik:${offerId}:offer:${offerId}`));
  assert.ok(r.ok && !r.duplicate, `create offer ${offerId}`);
  let offer = r.offer;
  tx((db) => offers.transitionOfferInTx(db, { offerId: offer.offerId, expectedVersion: 1, from: "PLANNED", to: "ISSUING", reason: "", at: now, patch: { expiresAt: now + makeConfig().trade.contractTtlMs } }, S.transitionKey(offer.offerId, 1, "ISSUING")));
  tx((db) => offers.transitionOfferInTx(db, { offerId: offer.offerId, expectedVersion: 2, from: "ISSUING", to: "OPEN", reason: "", at: now + 1000, patch: { contractId } }, S.transitionKey(offer.offerId, 2, "OPEN")));
  return offer;
}

function runExecutorAndAssert(pass, { issued = 0, opened = 0, accepted = 0, closed = 0, aborted = 0, retried = 0 } = {}) {
  assert.ok(pass.ok);
  if (issued !== undefined) assert.strictEqual(pass.issued, issued, `issued ${issued}`);
  if (opened !== undefined) assert.strictEqual(pass.opened, opened, `opened ${opened}`);
  if (accepted !== undefined) assert.strictEqual(pass.accepted, accepted, `accepted ${accepted}`);
  if (closed !== undefined) assert.strictEqual(pass.closed, closed, `closed ${closed}`);
  if (aborted !== undefined) assert.strictEqual(pass.aborted, aborted, `aborted ${aborted}`);
  if (retried !== undefined) assert.strictEqual(pass.retried, retried, `retried ${retried}`);
}

function getOffer(tx, offers, offerId) {
  return tx((db) => offers.getOffer(db, offerId)).offer;
}

function getBudget(tx, budgets) {
  return tx((db) => budgets.getBudget(db, F)).budget;
}

function advanceClock(ms) {
  const oldNow = CLOCK.now;
  CLOCK.now = () => oldNow() + ms;
  return () => { CLOCK.now = oldNow; };
}

module.exports = ({ test, skip, bench, benchEnabled }) => {
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  needsDriver("TC1 happy path: PLANNED → OPEN → ACCEPTED, reserved/spent, reserved === sumOpenReserved", () => H.withStore(driver, async (reopen) => {
    const opened = reopen();
    insertStation(opened.store, CLOCK);
    const adapter = createFakeTradeAdapter();
    const { journal, budgets, offers, priceCache } = createRepos();
    const tx = (fn) => { const r = opened.store.transaction("test", fn); assert.ok(r.ok, JSON.stringify(r)); return r.value; };
    fundBudget(tx, budgets);
    const offer = issueOffer(tx, offers, journal, "tc1", AT);

    const executor = createExecutor({ store: opened.store, journal, offers, budgets, adapter, priceCache });
    executor.start();
    const pass1 = await executor.runPass();
    runExecutorAndAssert(pass1, { issued: 1, opened: 1 });

    const offerAfterIssue = getOffer(tx, offers, offer.offerId);
    assert.strictEqual(offerAfterIssue.state, "OPEN");
    assert.ok(Number.isSafeInteger(offerAfterIssue.contractId) && offerAfterIssue.contractId > 0);

    const outboxKey = S.issueOutboxKey(offer.offerId);
    const outbox = tx((db) => journal.findByKey(db, outboxKey));
    assert.ok(outbox.ok && outbox.found && outbox.entry.state === "APPLIED", "outbox APPLIED");

    const adapterState = adapter._state;
    assert.strictEqual(adapterState.receipts.has(`lne:trade:${offer.offerId}:fund`), true, "fund receipt exists");
    assert.strictEqual(adapterState.contracts.size, 1, "1 contract created");

    const contractId = offerAfterIssue.contractId;
    const contract = adapterState.contracts.get(contractId);
    contract.status = "FINISHED";
    contract.acceptorId = 999;
    contract.acceptorWallet = { kind: "character" };

    const pass2 = await executor.runPass();
    runExecutorAndAssert(pass2, { accepted: 1 });

    const offerAccepted = getOffer(tx, offers, offer.offerId);
    assert.strictEqual(offerAccepted.state, "ACCEPTED");
    assert.strictEqual(offerAccepted.acceptorCharacterId, 999);

    const budget = getBudget(tx, budgets);
    assert.strictEqual(budget.reservedIsk, 0, "reserved 0 after accept");
    assert.strictEqual(budget.spentTotal, 1100, "spentTotal 1100");

    const sum = tx((db) => offers.sumOpenReserved(db, F));
    assert.strictEqual(sum.total, 0, "sumOpenReserved 0");
    assert.strictEqual(budget.reservedIsk, sum.total, "invariant holds");

    executor.stop();
  }));

  needsDriver("TC2a restart in issue: basic restart → 1 contract & 1 fund", () => H.withStore(driver, async (reopen) => {
    const opened = reopen();
    insertStation(opened.store, CLOCK);
    const adapter = createFakeTradeAdapter();
    const { journal, budgets, offers, priceCache } = createRepos();
    const tx = (fn) => { const r = opened.store.transaction("test", fn); assert.ok(r.ok, JSON.stringify(r)); return r.value; };
    fundBudget(tx, budgets);
    const now = AT + 1000;
    const offer = issueOffer(tx, offers, journal, "tc2a", now);

    const executor1 = createExecutor({ store: opened.store, journal, offers, budgets, adapter, priceCache });
    executor1.start();
    const pass1 = await executor1.runPass();
    runExecutorAndAssert(pass1, { issued: 1, opened: 1 });

    const adapterState = adapter._state;
    assert.strictEqual(adapterState.receipts.has(`lne:trade:${offer.offerId}:fund`), true, "fund receipt exists");
    assert.strictEqual(adapterState.contracts.size, 1, "1 contract created");

    adapter._reset();
    const executor2 = createExecutor({ store: opened.store, journal, offers, budgets, adapter, priceCache });
    executor2.start();
    const pass2 = await executor2.runPass();
    runExecutorAndAssert(pass2, { retried: 1 });
    const adapterState2 = adapter._state;
    assert.strictEqual(adapterState2.receipts.has(`lne:trade:${offer.offerId}:fund`), true, "fund receipt still 1 (replay duplicate)");
    assert.strictEqual(adapterState2.contracts.size, 1, "contract still 1 (found existing)");
    executor2.stop();
  }));

  needsDriver("TC2b restart in issue: transient create failure → replay → 1 contract", () => H.withStore(driver, async (reopen) => {
    const opened = reopen();
    insertStation(opened.store, CLOCK);
    const adapter = createFakeTradeAdapter();
    const { journal, budgets, offers, priceCache } = createRepos();
    const tx = (fn) => { const r = opened.store.transaction("test", fn); assert.ok(r.ok, JSON.stringify(r)); return r.value; };
    fundBudget(tx, budgets);
    const now = AT + 1000;
    const offer = issueOffer(tx, offers, journal, "tc2b", now);

    const originalCreate = adapter.tradeCreateContract;
    let failOnce = false;
    adapter.tradeCreateContract = async (payload) => {
      if (!failOnce) { failOnce = true; return { ok: false, reason: "CONTRACT_CREATE_FAILED", permanent: false, detail: "transient" }; }
      return originalCreate(payload);
    };

    const executor = createExecutor({ store: opened.store, journal, offers, budgets, adapter, priceCache });
    executor.start();
    const pass1 = await executor.runPass();
    runExecutorAndAssert(pass1, { retried: 1 });
    const pass2 = await executor.runPass();
    runExecutorAndAssert(pass2, { issued: 1, opened: 1 });

    const adapterState = adapter._state;
    assert.strictEqual(adapterState.contracts.size, 1, "1 contract after replay");
    executor.stop();
  }));

  needsDriver("TC2c restart in issue: pending create → waits, then completes", () => H.withStore(driver, async (reopen) => {
    const opened = reopen();
    insertStation(opened.store, CLOCK);
    const adapter = createFakeTradeAdapter();
    const { journal, budgets, offers, priceCache } = createRepos();
    const tx = (fn) => { const r = opened.store.transaction("test", fn); assert.ok(r.ok, JSON.stringify(r)); return r.value; };
    fundBudget(tx, budgets);
    const now = AT + 1000;
    const offer = issueOffer(tx, offers, journal, "tc2c", now);

    const fp = JSON.stringify({ info: { description: `[LNE:${offer.offerId}]` }, session: {} });
    adapter._state.pendingCreates.set(fp, { contractId: 888888, payload: { info: { description: `[LNE:${offer.offerId}]` } } });

    const executor = createExecutor({ store: opened.store, journal, offers, budgets, adapter, priceCache });
    executor.start();
    const pass1 = await executor.runPass();
    runExecutorAndAssert(pass1, { retried: 1 });

    adapter._state.pendingCreates.clear();
    adapter._state.contracts.set(888888, {
      contractId: 888888, offerId: offer.offerId, corporationId: CORP,
      status: "OUTSTANDING", payload: { info: { description: `[LNE:${offer.offerId}]` } }, createdAt: Date.now()
    });

    const pass2 = await executor.runPass();
    runExecutorAndAssert(pass2, { issued: 1, opened: 1 });
    executor.stop();
  }));

  needsDriver("TC3a close: expires_at → deleteContract → defund → CANCELLED EXPIRED", () => H.withStore(driver, async (reopen) => {
    const opened = reopen();
    insertStation(opened.store, CLOCK);
    const adapter = createFakeTradeAdapter();
    const { journal, budgets, offers, priceCache } = createRepos();
    const tx = (fn) => { const r = opened.store.transaction("test", fn); assert.ok(r.ok, JSON.stringify(r)); return r.value; };
    fundBudget(tx, budgets);
    const now = AT + 1000;
    const offer = openOffer(tx, offers, journal, "tc3a", now, 111111);

    adapter._state.contracts.set(111111, { contractId: 111111, offerId: offer.offerId, corporationId: CORP, status: "OUTSTANDING", payload: {}, createdAt: Date.now() });

    const executor1 = createExecutor({ store: opened.store, journal, offers, budgets, adapter, priceCache });
    executor1.start();
    const pass1 = await executor1.runPass();
    runExecutorAndAssert(pass1, { retried: 1 });
    executor1.stop();

    const restoreClock = advanceClock(259200000 + 1000);
    let executor2;
    try {
      executor2 = createExecutor({ store: opened.store, journal, offers, budgets, adapter, priceCache });
      executor2.start();
      const pass2 = await executor2.runPass();
      runExecutorAndAssert(pass2, { closed: 1 });

      const offerClosed = getOffer(tx, offers, offer.offerId);
      assert.strictEqual(offerClosed.state, "CANCELLED");
      assert.strictEqual(offerClosed.endReason, "EXPIRED");

      const budget = getBudget(tx, budgets);
      assert.strictEqual(budget.reservedIsk, 0);
      assert.strictEqual(budget.releasedTotal, 1100);
      assert.strictEqual(budget.availableIsk, 100000);
    } finally {
      restoreClock();
      if (executor2) executor2.stop();
    }
  }));

  needsDriver("TC3b close: restart after deleteContract → DELETED → replay defund", () => H.withStore(driver, async (reopen) => {
    const opened = reopen();
    insertStation(opened.store, CLOCK);
    const adapter = createFakeTradeAdapter();
    const { journal, budgets, offers, priceCache } = createRepos();
    const tx = (fn) => { const r = opened.store.transaction("test", fn); assert.ok(r.ok, JSON.stringify(r)); return r.value; };
    fundBudget(tx, budgets);
    const now = AT + 1000;
    const offer = openOffer(tx, offers, journal, "tc3b", now, 222222);

    adapter._state.contracts.set(222222, { contractId: 222222, offerId: offer.offerId, corporationId: CORP, status: "DELETED", payload: {}, createdAt: Date.now() });

    const executor = createExecutor({ store: opened.store, journal, offers, budgets, adapter, priceCache });
    executor.start();
    const pass1 = await executor.runPass();
    runExecutorAndAssert(pass1, { closed: 1 });

    const offerClosed = getOffer(tx, offers, offer.offerId);
    assert.strictEqual(offerClosed.state, "CANCELLED");
    const budget = getBudget(tx, budgets);
    assert.strictEqual(budget.reservedIsk, 0);
    assert.strictEqual(budget.releasedTotal, 1100);
    executor.stop();
  }));

  needsDriver("TC3c close: acceptance during delete → next pass ACCEPTED", () => H.withStore(driver, async (reopen) => {
    const opened = reopen();
    insertStation(opened.store, CLOCK);
    const adapter = createFakeTradeAdapter();
    const { journal, budgets, offers, priceCache } = createRepos();
    const tx = (fn) => { const r = opened.store.transaction("test", fn); assert.ok(r.ok, JSON.stringify(r)); return r.value; };
    fundBudget(tx, budgets);
    const now = AT + 1000;
    const offer = openOffer(tx, offers, journal, "tc3c", now, 333333);

    adapter._state.contracts.set(333333, { contractId: 333333, offerId: offer.offerId, corporationId: CORP, status: "OUTSTANDING", payload: {}, createdAt: Date.now(), pendingKind: "terminal" });

    const executor = createExecutor({ store: opened.store, journal, offers, budgets, adapter, priceCache });
    executor.start();
    const pass1 = await executor.runPass();
    runExecutorAndAssert(pass1, { retried: 1 });

    adapter._state.contracts.set(333333, { contractId: 333333, offerId: offer.offerId, corporationId: CORP, status: "FINISHED",
      acceptorId: 777, acceptorWallet: { kind: "character" }, rewardEscrow: 1100, issuerOwnerId: CORP, pendingKind: null });

    const pass2 = await executor.runPass();
    runExecutorAndAssert(pass2, { accepted: 1 });
    executor.stop();
  }));

  needsDriver("TC3d close: station taken → STATION_GONE", () => H.withStore(driver, async (reopen) => {
    const opened = reopen();
    insertStation(opened.store, CLOCK);
    const adapter = createFakeTradeAdapter();
    const { journal, budgets, offers, priceCache } = createRepos();
    const tx = (fn) => { const r = opened.store.transaction("test", fn); assert.ok(r.ok, JSON.stringify(r)); return r.value; };
    fundBudget(tx, budgets);
    const now = AT + 1000;
    const offer = openOffer(tx, offers, journal, "tc3d", now, 444444);

    adapter._state.contracts.set(444444, { contractId: 444444, offerId: offer.offerId, corporationId: CORP, status: "OUTSTANDING", payload: {}, createdAt: Date.now() });

    tx((db) => {
      const stmt = db.prepare("UPDATE world_stations SET owner_corporation_id = ? WHERE station_id = ?");
      stmt.run(888888, STATION);
      return { ok: true };
    });

    const executor = createExecutor({ store: opened.store, journal, offers, budgets, adapter, priceCache });
    executor.start();
    const pass1 = await executor.runPass();
    runExecutorAndAssert(pass1, { closed: 1 });

    const offerGone = getOffer(tx, offers, offer.offerId);
    assert.strictEqual(offerGone.endReason, "STATION_GONE");
    executor.stop();
  }));

  needsDriver("TC3e close: *_REINFORCE → no change", () => H.withStore(driver, async (reopen) => {
    const opened = reopen();
    insertStation(opened.store, CLOCK);
    const adapter = createFakeTradeAdapter();
    const { journal, budgets, offers, priceCache } = createRepos();
    const tx = (fn) => { const r = opened.store.transaction("test", fn); assert.ok(r.ok, JSON.stringify(r)); return r.value; };
    fundBudget(tx, budgets);
    const now = AT + 1000;
    const offer = openOffer(tx, offers, journal, "tc3e", now, 555555);

    adapter._state.contracts.set(555555, { contractId: 555555, offerId: offer.offerId, corporationId: CORP, status: "OUTSTANDING", payload: {}, createdAt: Date.now() });

    const executor = createExecutor({
      store: opened.store, journal, offers, budgets, adapter, priceCache,
      getStations: { [STATION]: { stationId: STATION_ID, kind: "npc_reinforce", ownerCorporationId: CORP, systemId: SYSTEM, destroyed: false } }
    });
    executor.start();
    const pass1 = await executor.runPass();
    runExecutorAndAssert(pass1, { closed: 0, retried: 1 });

    const offerReinforce = getOffer(tx, offers, offer.offerId);
    assert.strictEqual(offerReinforce.state, "OPEN");
    executor.stop();
  }));

  needsDriver("TC4a abort: not a station → fund + defund + CANCELLED ISSUE_FAILED", () => H.withStore(driver, async (reopen) => {
    const opened = reopen();
    insertStation(opened.store, CLOCK);
    const adapter = createFakeTradeAdapter();
    const { journal, budgets, offers, priceCache } = createRepos();
    const tx = (fn) => { const r = opened.store.transaction("test", fn); assert.ok(r.ok, JSON.stringify(r)); return r.value; };
    fundBudget(tx, budgets);
    const now = AT + 1000;
    const offer = issueOffer(tx, offers, journal, "tc4a", now, 99999999);

    adapter.tradeCreateContract = async () => ({ ok: false, reason: "CONTRACT_CREATE_FAILED", permanent: true, detail: "Start location is not a station" });

    const executor = createExecutor({ store: opened.store, journal, offers, budgets, adapter, priceCache });
    executor.start();
    const pass1 = await executor.runPass();
    runExecutorAndAssert(pass1, { aborted: 1 });

    const offerAborted = getOffer(tx, offers, offer.offerId);
    assert.strictEqual(offerAborted.state, "CANCELLED");
    assert.strictEqual(offerAborted.endReason, "ISSUE_FAILED");

    const budget = getBudget(tx, budgets);
    assert.strictEqual(budget.reservedIsk, 0);
    assert.strictEqual(budget.releasedTotal, 1100);
    executor.stop();
  }));

  needsDriver("TC4b abort: transient error → waits, then aborts after timeout", () => H.withStore(driver, async (reopen) => {
    const opened = reopen();
    insertStation(opened.store, CLOCK);
    const adapter = createFakeTradeAdapter();
    const { journal, budgets, offers, priceCache } = createRepos();
    const tx = (fn) => { const r = opened.store.transaction("test", fn); assert.ok(r.ok, JSON.stringify(r)); return r.value; };
    fundBudget(tx, budgets);
    const now = AT + 1000;
    const offer = issueOffer(tx, offers, journal, "tc4b", now);

    adapter.tradeCreateContract = async () => ({ ok: false, reason: "CONTRACT_CREATE_FAILED", permanent: false, detail: "does not have enough funds" });

    const executor = createExecutor({ store: opened.store, journal, offers, budgets, adapter, priceCache });
    executor.start();
    const pass1 = await executor.runPass();
    runExecutorAndAssert(pass1, { retried: 1 });

    const offerRetry = getOffer(tx, offers, offer.offerId);
    assert.strictEqual(offerRetry.state, "ISSUING", "still ISSUING");

    const restoreClock = advanceClock(makeConfig().trade.issueTimeoutMs + 1000);
    try {
      const pass2 = await executor.runPass();
      runExecutorAndAssert(pass2, { aborted: 1 });
    } finally {
      restoreClock();
    }
    executor.stop();
  }));

  needsDriver("TC4c abort: pending create → never aborts", () => H.withStore(driver, async (reopen) => {
    const opened = reopen();
    insertStation(opened.store, CLOCK);
    const adapter = createFakeTradeAdapter();
    const { journal, budgets, offers, priceCache } = createRepos();
    const tx = (fn) => { const r = opened.store.transaction("test", fn); assert.ok(r.ok, JSON.stringify(r)); return r.value; };
    fundBudget(tx, budgets);
    const now = AT + 1000;
    const offer = issueOffer(tx, offers, journal, "tc4c", now);

    const fp = JSON.stringify({ info: { description: `[LNE:${offer.offerId}]` }, session: {} });
    adapter._state.pendingCreates.set(fp, { contractId: 777777, payload: { info: { description: `[LNE:${offer.offerId}]` } } });

    const executor = createExecutor({ store: opened.store, journal, offers, budgets, adapter, priceCache });
    executor.start();
    const pass1 = await executor.runPass();
    runExecutorAndAssert(pass1, { retried: 1 });

    const restoreClock = advanceClock(makeConfig().trade.issueTimeoutMs + 1000);
    try {
      const pass2 = await executor.runPass();
      runExecutorAndAssert(pass2, { aborted: 0, issued: 0, retried: 1 });

      const offerPending = getOffer(tx, offers, offer.offerId);
      assert.strictEqual(offerPending.state, "ISSUING", "still ISSUING with pending");
    } finally {
      restoreClock();
    }
    executor.stop();
  }));

  needsDriver("TC5a disable: no seam → TRADE_SEAM_UNAVAILABLE", () => H.withStore(driver, async (reopen) => {
    const opened = reopen();
    insertStation(opened.store, CLOCK);
    const tx = (fn) => { const r = opened.store.transaction("test", fn); assert.ok(r.ok, JSON.stringify(r)); return r.value; };

    const { journal, budgets, offers } = createRepos();
    const badAdapter = { checkTradeSeams: () => ({ ok: false, reason: "TRADE_SEAM_UNAVAILABLE", missing: ["seam"] }) };
    const executorNoSeam = createTradeExecutor({
      store: opened.store, journal, offers, budgets,
      getStations: () => ({ [STATION]: { stationId: STATION_ID, kind: "npc", ownerCorporationId: CORP, systemId: SYSTEM, destroyed: false } }),
      getGraph: () => null, adapter: badAdapter,
      priceCache: { put() {}, peek() { return null; }, getStatus() { return { entries: 0, source: "none", newestAt: null }; } },
      config: makeConfig({ trade: { contractsEnabled: true } }),
      clock: CLOCK, mode: "run",
      getGovernor: () => ({ admits: () => true }), factionNames: new Map([[F, "Sansha"]]),
      telemetry: null, logger: { log: () => {} },
    });
    const seamCheck = badAdapter.checkTradeSeams();
    assert.ok(!seamCheck.ok);
    assert.strictEqual(seamCheck.reason, "TRADE_SEAM_UNAVAILABLE");
  }));

  needsDriver("TC5b disable: contractsEnabled=false → PLANNED untouched", () => H.withStore(driver, async (reopen) => {
    const opened = reopen();
    insertStation(opened.store, CLOCK);
    const STATION_5B = "npc-5b";
    const STATION_5B_ID = 60003761;
    const now = CLOCK.now();
    const tx = (fn) => { const r = opened.store.transaction("test", fn); assert.ok(r.ok, JSON.stringify(r)); return r.value; };
    tx((db) => {
      const stmt = db.prepare(`
        INSERT INTO world_stations (station_id, kind, npc_station_id, type_id, structure_family, system_id,
          owner_faction_id, owner_corporation_id, state, state_until_at, name, position_json, origin,
          evejs_item_id, destroyed_at, created_at, updated_at, version)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      stmt.run(STATION_5B, "npc", STATION_5B_ID, 35834, "Sansha", SYSTEM, F, CORP, "ONLINE", null, "Sansha Station 5B", '{"x":0,"y":0,"z":0}', "seed", null, null, now, now, 1);
      return { ok: true };
    });

    const { journal, budgets, offers } = createRepos();
    fundBudget(tx, budgets);

    const adapterFresh = createFakeTradeAdapter();
    const offer = createOffer(tx, offers, "tc5b", STATION_5B);

    const configNoContracts = makeConfig({ trade: { contractsEnabled: false } });
    const executorNoContracts = createTradeExecutor({
      store: opened.store, journal, offers, budgets,
      getStations: () => ({ [STATION_5B]: { stationId: STATION_5B_ID, kind: "npc", ownerCorporationId: CORP, systemId: SYSTEM, destroyed: false } }),
      getGraph: () => null, adapter: adapterFresh,
      priceCache: { put() {}, peek() { return null; }, getStatus() { return { entries: 0, source: "none", newestAt: null }; } },
      config: configNoContracts,
      clock: CLOCK, mode: "run",
      getGovernor: () => ({ admits: () => true }), factionNames: new Map([[F, "Sansha"]]),
      telemetry: null, logger: { log: () => {} },
    });
    executorNoContracts.start();
    const pass1 = await executorNoContracts.runPass();
    runExecutorAndAssert(pass1, { issued: 0, opened: 0 });
    const offerStillPlanned = getOffer(tx, offers, offer.offerId);
    assert.strictEqual(offerStillPlanned.state, "PLANNED", "PLANNED untouched");
    executorNoContracts.stop();
  }));

  needsDriver("TC5c disable: cleanupOnDisable=true → CANCELLED DISABLED", () => H.withStore(driver, async (reopen) => {
    const opened = reopen();
    insertStation(opened.store, CLOCK);
    const STATION_5C = "npc-5c";
    const STATION_5C_ID = 60003762;
    const STATION_5D = "npc-5d";
    const STATION_5D_ID = 60003763;
    const now = CLOCK.now();
    const tx = (fn) => { const r = opened.store.transaction("test", fn); assert.ok(r.ok, JSON.stringify(r)); return r.value; };
    tx((db) => {
      const stmt = db.prepare(`
        INSERT INTO world_stations (station_id, kind, npc_station_id, type_id, structure_family, system_id,
          owner_faction_id, owner_corporation_id, state, state_until_at, name, position_json, origin,
          evejs_item_id, destroyed_at, created_at, updated_at, version)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      stmt.run(STATION_5C, "npc", STATION_5C_ID, 35834, "Sansha", SYSTEM, F, CORP, "ONLINE", null, "Sansha Station 5C", '{"x":0,"y":0,"z":0}', "seed", null, null, now, now, 1);
      stmt.run(STATION_5D, "npc", STATION_5D_ID, 35834, "Sansha", SYSTEM, F, CORP, "ONLINE", null, "Sansha Station 5D", '{"x":0,"y":0,"z":0}', "seed", null, null, now, now, 1);
      return { ok: true };
    });

    const { journal, budgets, offers } = createRepos();
    fundBudget(tx, budgets);

    const adapter5c = createFakeTradeAdapter();
    const offer5c1 = createOffer(tx, offers, "tc5c1", STATION_5C);
    const offer5c2 = createOffer(tx, offers, "tc5c2", STATION_5D);

    const executor1 = createExecutor({ store: opened.store, journal, offers, budgets, adapter: adapter5c, priceCache: { put() {}, peek() { return null; }, getStatus() { return { entries: 0, source: "none", newestAt: null }; } } });
    executor1.start();
    await executor1.runPass();
    await executor1.runPass();
    executor1.stop();

    const o1 = getOffer(tx, offers, offer5c1.offerId);
    const o2 = getOffer(tx, offers, offer5c2.offerId);
    assert.strictEqual(o1.state, "OPEN");
    assert.strictEqual(o2.state, "OPEN");

    adapter5c._state.contracts.set(o1.contractId, { contractId: o1.contractId, offerId: offer5c1.offerId, corporationId: CORP, status: "OUTSTANDING", payload: {}, createdAt: Date.now() });
    adapter5c._state.contracts.set(o2.contractId, { contractId: o2.contractId, offerId: offer5c2.offerId, corporationId: CORP, status: "OUTSTANDING", payload: {}, createdAt: Date.now() });

    const configCleanup = makeConfig({ trade: { cleanupOnDisable: true } });
    const executorCleanup = createTradeExecutor({
      store: opened.store, journal, offers, budgets,
      getStations: () => ({
        [STATION_5C]: { stationId: STATION_5C_ID, kind: "npc", ownerCorporationId: CORP, systemId: SYSTEM, destroyed: false },
        [STATION_5D]: { stationId: STATION_5D_ID, kind: "npc", ownerCorporationId: CORP, systemId: SYSTEM, destroyed: false }
      }),
      getGraph: () => null, adapter: adapter5c,
      priceCache: { put() {}, peek() { return null; }, getStatus() { return { entries: 0, source: "none", newestAt: null }; } },
      config: configCleanup,
      clock: CLOCK, mode: "cleanup",
      getGovernor: () => ({ admits: () => true }), factionNames: new Map([[F, "Sansha"]]),
      telemetry: null, logger: { log: () => {} },
    });
    executorCleanup.start();
    const pass1 = await executorCleanup.runPass();
    runExecutorAndAssert(pass1, { closed: 2 });
    const offerCleanup1 = getOffer(tx, offers, offer5c1.offerId);
    const offerCleanup2 = getOffer(tx, offers, offer5c2.offerId);
    assert.strictEqual(offerCleanup1.state, "CANCELLED");
    assert.strictEqual(offerCleanup1.endReason, "DISABLED");
    assert.strictEqual(offerCleanup2.state, "CANCELLED");
    assert.strictEqual(offerCleanup2.endReason, "DISABLED");
    const budgetCleanup = getBudget(tx, budgets);
    assert.strictEqual(budgetCleanup.reservedIsk, 0, "reserved=0 after cleanup");
    assert.strictEqual(adapter5c._balance(CORP, 1006), 0, "balance 0 after cleanup (fund + escrow refunded)");
    executorCleanup.stop();
  }));

  needsDriver("TC5d disable: cleanupOnDisable=false → zero fake calls", () => H.withStore(driver, async (reopen) => {
    const opened = reopen();
    insertStation(opened.store, CLOCK);
    const STATION_5E = "npc-5e";
    const STATION_5E_ID = 60003764;
    const STATION_5F = "npc-5f";
    const STATION_5F_ID = 60003765;
    const now = CLOCK.now();
    const tx = (fn) => { const r = opened.store.transaction("test", fn); assert.ok(r.ok, JSON.stringify(r)); return r.value; };
    tx((db) => {
      const stmt = db.prepare(`
        INSERT INTO world_stations (station_id, kind, npc_station_id, type_id, structure_family, system_id,
          owner_faction_id, owner_corporation_id, state, state_until_at, name, position_json, origin,
          evejs_item_id, destroyed_at, created_at, updated_at, version)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      stmt.run(STATION_5E, "npc", STATION_5E_ID, 35834, "Sansha", SYSTEM, F, CORP, "ONLINE", null, "Sansha Station 5E", '{"x":0,"y":0,"z":0}', "seed", null, null, now, now, 1);
      stmt.run(STATION_5F, "npc", STATION_5F_ID, 35834, "Sansha", SYSTEM, F, CORP, "ONLINE", null, "Sansha Station 5F", '{"x":0,"y":0,"z":0}', "seed", null, null, now, now, 1);
      return { ok: true };
    });

    const { journal, budgets, offers } = createRepos();
    fundBudget(tx, budgets);

    const adapter5d = createFakeTradeAdapter();
    const offer5d1 = createOffer(tx, offers, "tc5d1", STATION_5E);
    const offer5d2 = createOffer(tx, offers, "tc5d2", STATION_5F);

    const executor1 = createExecutor({ store: opened.store, journal, offers, budgets, adapter: adapter5d, priceCache: { put() {}, peek() { return null; }, getStatus() { return { entries: 0, source: "none", newestAt: null }; } } });
    executor1.start();
    await executor1.runPass();
    await executor1.runPass();
    executor1.stop();

    const o1 = getOffer(tx, offers, offer5d1.offerId);
    const o2 = getOffer(tx, offers, offer5d2.offerId);
    assert.strictEqual(o1.state, "OPEN");
    assert.strictEqual(o2.state, "OPEN");

    adapter5d._state.contracts.set(o1.contractId, { contractId: o1.contractId, offerId: offer5d1.offerId, corporationId: CORP, status: "OUTSTANDING", payload: {}, createdAt: Date.now() });
    adapter5d._state.contracts.set(o2.contractId, { contractId: o2.contractId, offerId: offer5d2.offerId, corporationId: CORP, status: "OUTSTANDING", payload: {}, createdAt: Date.now() });
    adapter5d._reset();

    const adapterCleanup = createFakeTradeAdapter();
    for (const [k, v] of adapter5d._state.contracts) {
      adapterCleanup._state.contracts.set(k, v);
    }

    const executorNoCleanup = createTradeExecutor({
      store: opened.store, journal, offers, budgets,
      getStations: () => ({
        [STATION_5E]: { stationId: STATION_5E_ID, kind: "npc", ownerCorporationId: CORP, systemId: SYSTEM, destroyed: false },
        [STATION_5F]: { stationId: STATION_5F_ID, kind: "npc", ownerCorporationId: CORP, systemId: SYSTEM, destroyed: false }
      }),
      getGraph: () => null, adapter: adapterCleanup,
      priceCache: { put() {}, peek() { return null; }, getStatus() { return { entries: 0, source: "none", newestAt: null }; } },
      config: makeConfig({ trade: { cleanupOnDisable: false } }),
      clock: CLOCK, mode: "cleanup",
      getGovernor: () => ({ admits: () => true }), factionNames: new Map([[F, "Sansha"]]),
      telemetry: null, logger: { log: () => {} },
    });
    executorNoCleanup.start();
    const pass1 = await executorNoCleanup.runPass();
    runExecutorAndAssert(pass1, { issued: 0, opened: 0, closed: 0 });
    const adapterState = adapterCleanup._state;
    assert.strictEqual(adapterState.contracts.size, 2, "no new contracts");
    assert.strictEqual(adapterState.receipts.size, 0, "no wallet calls during cleanup");
    executorNoCleanup.stop();
  }));

  const countingTelemetry = () => {
    const counts = {};
    return { counts, count(name, v) { counts[name] = (counts[name] || 0) + v; }, observe() {} };
  };

  needsDriver("TC9a rejected create -> retry + createRejected, restart keeps wallet, no contractId -> retry, fund once, balance S", () => H.withStore(driver, async (reopen) => {
    const opened = reopen();
    insertStation(opened.store, CLOCK);
    const adapter = createFakeTradeAdapter();
    const { journal, budgets, offers, priceCache } = createRepos();
    const tx = (fn) => { const r = opened.store.transaction("test", fn); assert.ok(r.ok, JSON.stringify(r)); return r.value; };
    fundBudget(tx, budgets);
    const S0 = 5000;
    adapter._setWalletBalance(CORP, 1006, S0);
    const offer = issueOffer(tx, offers, journal, "tc9a", AT + 1000);
    const telemetry = countingTelemetry();

    adapter._rejectNextCreate();
    const executor1 = createExecutor({ store: opened.store, journal, offers, budgets, adapter, priceCache, telemetry });
    executor1.start();
    runExecutorAndAssert(await executor1.runPass(), { retried: 1 });
    executor1.stop();
    const afterReject = getOffer(tx, offers, offer.offerId);
    assert.strictEqual(afterReject.state, "ISSUING", "rejected create keeps ISSUING");
    assert.strictEqual(afterReject.contractId, null, "no contractId after a rejected saga");
    assert.strictEqual(telemetry.counts["trade.createRejected"], 1, "createRejected +1");
    assert.strictEqual(telemetry.counts["trade.seamError"] || 0, 0, "rejection is not a seam error");
    assert.strictEqual(adapter._state.contracts.size, 0, "rejected saga leaves no record");
    assert.strictEqual(adapter._balance(CORP, 1006), S0 + 1100, "funded once, the vendor refunded the reward debit");

    adapter._reset();
    assert.strictEqual(adapter._balance(CORP, 1006), S0 + 1100, "wallet survives _reset()");
    const realCreate = adapter.tradeCreateContract;
    adapter.tradeCreateContract = async () => { adapter.tradeCreateContract = realCreate; return { ok: true, contractId: 0 }; };
    adapter._collideNextWallet();
    const executor2 = createExecutor({ store: opened.store, journal, offers, budgets, adapter, priceCache, telemetry });
    executor2.start();
    runExecutorAndAssert(await executor2.runPass(), { retried: 1 });
    assert.strictEqual(getOffer(tx, offers, offer.offerId).state, "ISSUING", "contractId 0 -> still ISSUING");
    assert.strictEqual(telemetry.counts["trade.createRejected"], 2, "no contract id counted as createRejected");
    assert.strictEqual(telemetry.counts["trade.walletKeyCollision"], 1, "fingerprintMismatch on fund counted");
    assert.strictEqual(telemetry.counts["trade.seamError"] || 0, 0, "contractId 0 is not a seam error");

    runExecutorAndAssert(await executor2.runPass(), { issued: 1, opened: 1 });
    executor2.stop();
    const openedOffer = getOffer(tx, offers, offer.offerId);
    assert.strictEqual(openedOffer.state, "OPEN");
    assert.ok(Number.isSafeInteger(openedOffer.contractId) && openedOffer.contractId > 0);
    assert.strictEqual(adapter._state.contracts.size, 1, "one contract");
    assert.strictEqual([...adapter._state.receipts].filter((k) => k === `lne:trade:${offer.offerId}:fund`).length, 1, "one fund receipt");
    assert.strictEqual(adapter._balance(CORP, 1006), S0, "S + reward - escrow = S");
  }));

  needsDriver("TC9b balance: issue/DISABLED/defund = S; rejected/timeout/abort = S; CORPORATION_NOT_FOUND abort = S", () => H.withStore(driver, async (reopen) => {
    const opened = reopen();
    insertStation(opened.store, CLOCK);
    const adapter = createFakeTradeAdapter();
    const { journal, budgets, offers, priceCache } = createRepos();
    const tx = (fn) => { const r = opened.store.transaction("test", fn); assert.ok(r.ok, JSON.stringify(r)); return r.value; };
    fundBudget(tx, budgets);
    const S0 = 5000;
    adapter._setWalletBalance(CORP, 1006, S0);

    const o1 = issueOffer(tx, offers, journal, "tc9b1", AT + 1000);
    const ex1 = createExecutor({ store: opened.store, journal, offers, budgets, adapter, priceCache });
    ex1.start();
    runExecutorAndAssert(await ex1.runPass(), { issued: 1, opened: 1 });
    ex1.stop();
    assert.strictEqual(adapter._balance(CORP, 1006), S0, "fund + escrow = S while OPEN");
    adapter._reset();
    const cleanupCfg = makeConfig();
    cleanupCfg.trade.cleanupOnDisable = true;
    const exClean = createExecutor({ store: opened.store, journal, offers, budgets, adapter, priceCache, mode: "cleanup", config: cleanupCfg });
    exClean.start();
    runExecutorAndAssert(await exClean.runPass(), { closed: 1 });
    exClean.stop();
    const c1 = getOffer(tx, offers, o1.offerId);
    assert.strictEqual(c1.state, "CANCELLED");
    assert.strictEqual(c1.endReason, "DISABLED");
    assert.ok(adapter._state.receipts.has(`lne:trade:${o1.offerId}:defund`), "defund leg");
    assert.strictEqual(adapter._balance(CORP, 1006), S0, "issue -> DISABLED -> defund = S");

    const o2 = issueOffer(tx, offers, journal, "tc9b2", AT + 1000);
    adapter._rejectNextCreate("INSUFFICIENT_FUNDS");
    const ex2 = createExecutor({ store: opened.store, journal, offers, budgets, adapter, priceCache });
    ex2.start();
    runExecutorAndAssert(await ex2.runPass(), { retried: 1 });
    assert.strictEqual(adapter._balance(CORP, 1006), S0 + 1100, "funded, reward refunded by the vendor");
    const restoreClock = advanceClock(makeConfig().trade.issueTimeoutMs + 1000);
    try {
      runExecutorAndAssert(await ex2.runPass(), { aborted: 1 });
    } finally {
      restoreClock();
    }
    ex2.stop();
    const c2 = getOffer(tx, offers, o2.offerId);
    assert.strictEqual(c2.state, "CANCELLED");
    assert.strictEqual(c2.endReason, "ISSUE_FAILED");
    assert.ok(adapter._state.receipts.has(`lne:trade:${o2.offerId}:defund`), "one defund leg");
    assert.strictEqual(adapter._balance(CORP, 1006), S0, "rejected -> timeout -> abort = S");

    const o3 = issueOffer(tx, offers, journal, "tc9b3", AT + 1000);
    adapter._rejectNextCreate("CORPORATION_NOT_FOUND");
    const ex3 = createExecutor({ store: opened.store, journal, offers, budgets, adapter, priceCache });
    ex3.start();
    runExecutorAndAssert(await ex3.runPass(), { aborted: 1 });
    ex3.stop();
    const c3 = getOffer(tx, offers, o3.offerId);
    assert.strictEqual(c3.state, "CANCELLED");
    assert.strictEqual(c3.endReason, "ISSUE_FAILED");
    assert.strictEqual(adapter._balance(CORP, 1006), S0, "permanent rejection abort = S");
    assert.strictEqual(adapter._state.contracts.size, 0, "no contract left");
  }));

  needsDriver("TC9d WTB ConTooManyContractsMax -> CONTRACT_LIMIT abort in the same pass, one create, balance S "
    + "breaker untouched", () => H.withStore(driver, async (reopen) => {
    const { createWantToBuyFrom } = require("../../lib/adapter/tradeContracts");
    const opened = reopen();
    insertStation(opened.store, CLOCK);
    const adapter = createFakeTradeAdapter();
    const { journal, budgets, offers, priceCache } = createRepos();
    const tx = (fn) => { const r = opened.store.transaction("test", fn); assert.ok(r.ok, JSON.stringify(r)); return r.value; };
    fundBudget(tx, budgets);
    const S0 = 5000;
    adapter._setWalletBalance(CORP, 1006, S0);
    const o = issueOffer(tx, offers, journal, "tc9d", AT + 1000);
    const err = new Error("Wrapped remote exception");
    err.machoErrorResponse = { errorCode: 2, payload: { type: "objectex1", header: [
      { type: "token", value: "eveexceptions.UserError" },
      ["ConTooManyContractsMax", { type: "dict", entries: [["max", 10]] }]] } };
    let creates = 0;
    adapter.tradeCreateContract = (payload) => {
      creates += 1;
      return createWantToBuyFrom({ createContract: async () => { throw err; } }, payload);
    };
    const telemetry = countingTelemetry();
    const ex = createExecutor({ store: opened.store, journal, offers, budgets, adapter, priceCache, telemetry });
    ex.start();
    runExecutorAndAssert(await ex.runPass(), { aborted: 1 });
    runExecutorAndAssert(await ex.runPass(), {});
    const market = ex.getStatus().market;
    ex.stop();
    const c = getOffer(tx, offers, o.offerId);
    assert.deepStrictEqual([c.state, c.endReason], ["CANCELLED", "ISSUE_FAILED"]);
    assert.strictEqual(creates, 1, "no retry");
    assert.strictEqual(telemetry.counts["trade.contractLimit"], 1);
    assert.ok(adapter._state.receipts.has(`lne:trade:${o.offerId}:defund`), "defund leg");
    assert.strictEqual(adapter._balance(CORP, 1006), S0, "fund + defund = S");
    assert.deepStrictEqual([market.tripped, market.issueFailures], [false, 0], "Counts market orders only");
  }));

  needsDriver("TC9c cleanup ISSUING + record -> OPEN -> DISABLED, one defund, balance S, no orphan; pending -> retry", () => H.withStore(driver, async (reopen) => {
    const opened = reopen();
    insertStation(opened.store, CLOCK);
    const adapter = createFakeTradeAdapter();
    const { journal, budgets, offers, priceCache } = createRepos();
    const tx = (fn) => { const r = opened.store.transaction("test", fn); assert.ok(r.ok, JSON.stringify(r)); return r.value; };
    fundBudget(tx, budgets);
    const S0 = 5000;
    adapter._setWalletBalance(CORP, 1006, S0);
    const telemetry = countingTelemetry();
    const orphanReceipts = () => [...adapter._state.receipts].filter((k) => k.startsWith("lne:trade:orphan:"));

    const o1 = issueOffer(tx, offers, journal, "tc9c1", AT + 1000);
    const outbox = tx((db) => journal.findByKey(db, S.issueOutboxKey(o1.offerId)));
    assert.ok(outbox.found, "issue outbox");
    const fundRes = await adapter.tradeAdjustWallet({ corporationId: CORP, accountKey: 1006, deltaIsk: outbox.entry.payload.rewardIsk,
      commandId: S.walletCommandId(o1.offerId, "fund"), description: `lne-trade fund ${o1.offerId}` });
    assert.strictEqual(fundRes.ok, true);
    const createRes = await adapter.tradeCreateContract(outbox.entry.payload);
    assert.strictEqual(createRes.ok, true);
    adapter._reset();
    assert.strictEqual(adapter._balance(CORP, 1006), S0, "fund + escrow = S");

    const cleanupCfg = makeConfig({ trade: { cleanupOnDisable: true } });
    const stationsMap = new Map([[STATION, { stationId: STATION_ID, kind: "npc", ownerCorporationId: CORP, systemId: SYSTEM, destroyed: false, online: true }]]);
    const ex = createExecutor({ store: opened.store, journal, offers, budgets, adapter, priceCache, mode: "cleanup",
      config: cleanupCfg, getStations: stationsMap, telemetry });
    ex.start();
    runExecutorAndAssert(await ex.runPass(), { issued: 1, opened: 1, closed: 0 });
    const p1 = getOffer(tx, offers, o1.offerId);
    assert.strictEqual(p1.state, "OPEN", "cleanup opens an ISSUING offer with a contract");
    assert.strictEqual(p1.contractId, createRes.contractId);
    assert.ok(!adapter._state.receipts.has(`lne:trade:${o1.offerId}:defund`), "no defund in pass 1");
    assert.strictEqual(adapter._balance(CORP, 1006), S0, "pass 1 balance S");
    assert.ok(adapter._state.contracts.has(createRes.contractId), "contract alive after pass 1");

    runExecutorAndAssert(await ex.runPass(), { closed: 1 });
    const p2 = getOffer(tx, offers, o1.offerId);
    assert.strictEqual(p2.state, "CANCELLED");
    assert.strictEqual(p2.endReason, "DISABLED");
    assert.ok(adapter._state.receipts.has(`lne:trade:${o1.offerId}:defund`), "defund with the offer key");
    assert.deepStrictEqual(orphanReceipts(), [], "no orphan defund");
    assert.ok(!adapter._state.contracts.has(createRes.contractId), "contract deleted by the issuer (ceoId check passed)");
    assert.strictEqual(adapter._balance(CORP, 1006), S0, "two passes: balance S");
    assert.strictEqual(telemetry.counts["trade.orphans"] || 0, 0, "no orphan");
    assert.strictEqual(telemetry.counts["trade.defundShort"] || 0, 0, "defund not short");

    const o2 = issueOffer(tx, offers, journal, "tc9c2", AT + 1000);
    const receiptsBefore = adapter._state.receipts.size;
    adapter._state.pendingCreates.set("tc9c2-fp", { contractId: 888888, payload: { info: { description: `[LNE:${o2.offerId}]` } } });
    runExecutorAndAssert(await ex.runPass(), { retried: 1 });
    assert.strictEqual(getOffer(tx, offers, o2.offerId).state, "ISSUING", "pending create -> still ISSUING");
    assert.strictEqual(adapter._state.receipts.size, receiptsBefore, "no wallet calls on pending");
    assert.strictEqual(telemetry.counts["trade.issueRetry"], 1, "issueRetry counted");
    assert.strictEqual(adapter._balance(CORP, 1006), S0, "balance S");
    ex.stop();
  }));

  needsDriver("TC10a character issuer: fund -> create forCorp:false -> OPEN -> DISABLED -> delete -> defund, character S, NPC division untouched, seams gate", () => H.withStore(driver, async (reopen) => {
    const opened = reopen();
    insertStation(opened.store, CLOCK);
    const adapter = createFakeTradeAdapter();
    const { journal, budgets, offers, priceCache } = createRepos();
    const tx = (fn) => { const r = opened.store.transaction("test", fn); assert.ok(r.ok, JSON.stringify(r)); return r.value; };
    fundBudget(tx, budgets);
    const S0 = 0;
    const CORP_S = 5000;
    adapter._setWalletBalance(CHAR, 1000, S0);
    adapter._setWalletBalance(CORP, 1006, CORP_S);
    const legs = countWalletLegs(adapter);

    const o0 = issueCharacterOffer(tx, offers, journal, "tc10a0", AT + 1000);
    adapter.tradeVirtualIssuerSeams = () => ({ ok: false, missing: ["services/account/walletState.adjustCharacterBalanceAsync"] });
    const ex0 = createExecutor({ store: opened.store, journal, offers, budgets, adapter, priceCache });
    ex0.start();
    runExecutorAndAssert(await ex0.runPass(), { retried: 1 });
    ex0.stop();
    assert.strictEqual(getOffer(tx, offers, o0.offerId).state, S.ISSUING);
    assert.strictEqual(legs.calls.length, 0, "no wallet leg without the seams");
    assert.strictEqual(adapter._state.contracts.size, 0, "no contract without the seams");
    adapter.tradeVirtualIssuerSeams = () => ({ ok: true });
    const o1 = issueCharacterOffer(tx, offers, journal, "tc10a1", AT + 1000, "type:35", 35);

    const ex1 = createExecutor({ store: opened.store, journal, offers, budgets, adapter, priceCache });
    ex1.start();
    runExecutorAndAssert(await ex1.runPass(), { issued: 2, opened: 2 });
    ex1.stop();
    const open1 = getOffer(tx, offers, o1.offerId);
    assert.strictEqual(open1.state, "OPEN");
    const contract = adapter._state.contracts.get(open1.contractId);
    assert.strictEqual(contract.payload.info.forCorp, false, "character contract forCorp:false");
    assert.deepStrictEqual(contract.walletRef, { kind: "character", ownerId: CHAR, accountKey: 1000 });
    assert.strictEqual(contract.issuerOwnerId, CHAR);
    assert.strictEqual(adapter._balance(CHAR, 1000), S0, "fund + escrow = S on the character");
    const fund1 = legs.calls.filter((c) => c.commandId === S.walletCommandId(o1.offerId, "fund"));
    assert.deepStrictEqual(fund1.map((c) => [c.ownerKind, c.ownerId, c.corporationId, c.accountKey, c.deltaIsk, c.description]),
      [["character", CHAR, VCORP, 1000, 1100, `lne-trade fund ${o1.offerId}`]], "one fund leg on the character");

    adapter._reset();
    const cleanupCfg = makeConfig({ trade: { cleanupOnDisable: true } });
    const exClean = createExecutor({ store: opened.store, journal, offers, budgets, adapter, priceCache, mode: "cleanup", config: cleanupCfg });
    exClean.start();
    runExecutorAndAssert(await exClean.runPass(), { closed: 2 });
    exClean.stop();
    const closed1 = getOffer(tx, offers, o1.offerId);
    assert.deepStrictEqual([closed1.state, closed1.endReason], ["CANCELLED", "DISABLED"]);
    assert.ok(!adapter._state.contracts.has(open1.contractId), "deleted by the character (ceoId check of the fake)");
    const defund1 = legs.calls.filter((c) => c.commandId === S.walletCommandId(o1.offerId, "defund"));
    assert.deepStrictEqual(defund1.map((c) => [c.ownerKind, c.ownerId, c.deltaIsk]), [["character", CHAR, -1100]], "one defund leg");
    assert.strictEqual(adapter._balance(CHAR, 1000), S0, "issue -> DISABLED -> defund = S on the character");
    assert.strictEqual(adapter._balance(CORP, 1006), CORP_S, "NPC division untouched");
    assert.ok(legs.calls.every((c) => c.ownerKind === "character"), "every leg on the character wallet");
    const budget = getBudget(tx, budgets);
    assert.deepStrictEqual([budget.reservedIsk, budget.releasedTotal], [0, 2200], "reserved -> released for both offers");
  }));

  needsDriver("TC10b character issuer restart after create before OPEN: find by character -> OPEN, no second fund", () => H.withStore(driver, async (reopen) => {
    const opened = reopen();
    insertStation(opened.store, CLOCK);
    const adapter = createFakeTradeAdapter();
    const { journal, budgets, offers, priceCache } = createRepos();
    const tx = (fn) => { const r = opened.store.transaction("test", fn); assert.ok(r.ok, JSON.stringify(r)); return r.value; };
    fundBudget(tx, budgets);
    adapter._setWalletBalance(CHAR, 1000, 0);
    const o1 = issueCharacterOffer(tx, offers, journal, "tc10b", AT + 1000);
    const outbox = tx((db) => journal.findByKey(db, S.issueOutboxKey(o1.offerId)));
    assert.deepStrictEqual([outbox.entry.payload.issuerKind, outbox.entry.payload.ownerId, outbox.entry.payload.ceoId,
      outbox.entry.payload.corporationId, outbox.entry.payload.accountKey], ["character", CHAR, CHAR, VCORP, 1000]);
    const fundRes = await adapter.tradeAdjustWallet({ ownerKind: "character", ownerId: CHAR, corporationId: VCORP, accountKey: 1000,
      deltaIsk: 1100, commandId: S.walletCommandId(o1.offerId, "fund"), description: `lne-trade fund ${o1.offerId}` });
    assert.strictEqual(fundRes.ok, true);
    const createRes = await adapter.tradeCreateContract(outbox.entry.payload);
    assert.strictEqual(createRes.ok, true, JSON.stringify(createRes));
    adapter._reset();

    const legs = countWalletLegs(adapter);
    const ex = createExecutor({ store: opened.store, journal, offers, budgets, adapter, priceCache });
    ex.start();
    runExecutorAndAssert(await ex.runPass(), { issued: 1, opened: 1 });
    ex.stop();
    const p = getOffer(tx, offers, o1.offerId);
    assert.deepStrictEqual([p.state, p.contractId], ["OPEN", createRes.contractId]);
    assert.strictEqual(legs.calls.length, 0, "no second fund after the restart");
    assert.deepStrictEqual([...adapter._state.receipts].filter((k) => k.endsWith(":fund")), [S.walletCommandId(o1.offerId, "fund")]);
    assert.strictEqual(adapter._balance(CHAR, 1000), 0, "fund once + escrow = S");
    assert.strictEqual(adapter._state.contracts.size, 1, "one contract");
  }));
  needsDriver("TC11a virtualIssuers=false: NPC issuer, no virtualCorps lookup", () => H.withStore(driver, async (reopen) => {
    const opened = reopen();
    insertStation(opened.store, CLOCK);
    const adapter = createFakeTradeAdapter();
    const { journal, budgets, offers, priceCache } = createRepos();
    const tx = (fn) => { const r = opened.store.transaction("test", fn); assert.ok(r.ok, JSON.stringify(r)); return r.value; };
    fundBudget(tx, budgets);
    const _S0 = 0;
    const telemetry = countingTelemetry();

    const cfg = makeConfig({ trade: { virtualIssuers: false, maxIssuesPerPass: 2 } });
    const ex = createExecutor({ store: opened.store, journal, offers, budgets, adapter, priceCache, config: cfg, getStations: { [STATION]: { stationId: STATION_ID, kind: "npc", ownerCorporationId: CORP, systemId: SYSTEM, destroyed: false, online: true } }, telemetry, getVirtualCorps: adapter.getVirtualCorps });

    ex.start();
    const o = createOffer(tx, offers, "tc11a1", STATION);
    const pass = await ex.runPass();
    runExecutorAndAssert(pass, { issued: 1, opened: 1 });
    const offer = getOffer(tx, offers, o.offerId);
    assert.strictEqual(offer.state, "OPEN");
    assert.strictEqual(offer.issuerCharacterId, null);
    assert.strictEqual(offer.issuerCharacterCorpId, null);
    ex.stop();
  }));

  needsDriver("TC11b 2 issuers 3 offers: slots 0, 1, 0, forCorp:false, issuerVirtual counters", () => H.withStore(driver, async (reopen) => {
    const opened = reopen();
    insertStation(opened.store, CLOCK);
    const adapter = createFakeTradeAdapter();
    adapter._setVirtualCorpsIssuers([
      { factionId: F, slot: 0, corporationId: 900001, characterId: 100001 },
      { factionId: F, slot: 1, corporationId: 900002, characterId: 100002 },
    ]);
    adapter._setVirtualCorpsNames({ 900001: "Sansha Corp 1", 900002: "Sansha Corp 2" });
    adapter._setWalletBalance(100001, 1000, 10000000);
    adapter._setWalletBalance(100002, 1000, 10000000);

    const { journal, budgets, offers, priceCache } = createRepos();
    const tx = (fn) => { const r = opened.store.transaction("test", fn); assert.ok(r.ok, JSON.stringify(r)); return r.value; };
    fundBudget(tx, budgets);
    const _S0 = 0;
    const telemetry = countingTelemetry();

    const cfg = makeConfig({ trade: { virtualIssuers: true, maxIssuesPerPass: 3 } });
    const ex = createExecutor({ store: opened.store, journal, offers, budgets, adapter, priceCache, config: cfg, getStations: { [STATION]: { stationId: STATION_ID, kind: "npc", ownerCorporationId: CORP, systemId: SYSTEM, destroyed: false, online: true } }, telemetry, getVirtualCorps: adapter.getVirtualCorps });

    ex.start();
    const o1 = createOffer(tx, offers, "tc11b1", STATION, "type:34", 34);
    const o2 = createOffer(tx, offers, "tc11b2", STATION, "type:35", 35);
    const o3 = createOffer(tx, offers, "tc11b3", STATION, "type:36", 36);

    const pass1 = await ex.runPass();
    runExecutorAndAssert(pass1, { issued: 3, opened: 3 });

    const o1r = getOffer(tx, offers, o1.offerId);
    const o2r = getOffer(tx, offers, o2.offerId);
    const o3r = getOffer(tx, offers, o3.offerId);
    assert.ok(o1r.issuerCharacterId === 100001 || o1r.issuerCharacterId === 100002, "o1 has character issuer");
    assert.ok(o2r.issuerCharacterId === 100001 || o2r.issuerCharacterId === 100002, "o2 has character issuer");
    assert.ok(o3r.issuerCharacterId === 100001 || o3r.issuerCharacterId === 100002, "o3 has character issuer");

    assert.strictEqual(o1r.issuerCharacterId, 100001, "first offer -> slot 0");
    assert.strictEqual(o2r.issuerCharacterId, 100002, "second offer -> slot 1");
    assert.strictEqual(o3r.issuerCharacterId, 100001, "third offer -> slot 0 again");

    assert.strictEqual(telemetry.counts["trade.issuerVirtual"], 3, "issuerVirtual = 3");
    assert.strictEqual(telemetry.counts["trade.issuerFallback"] || 0, 0, "issuerFallback = 0");
    assert.strictEqual(telemetry.counts["trade.issuerWait"] || 0, 0, "issuerWait = 0");

    for (const [, contract] of adapter._state.contracts) {
      assert.strictEqual(contract.payload.info.forCorp, false, "contract forCorp:false");
      assert.strictEqual(contract.payload.info.session.characterID, contract.walletRef.ownerId, "session.characterID matches walletRef");
      assert.strictEqual(contract.walletRef.accountKey, 1000, "walletRef accountKey 1000");
    }

    ex.stop();
  }));

  needsDriver("TC11c virtualCorps seams unavailable: NPC fallback, issuerFallback counter", () => H.withStore(driver, async (reopen) => {
    const opened = reopen();
    insertStation(opened.store, CLOCK);
    const adapter = createFakeTradeAdapter();
    adapter.tradeVirtualIssuerSeams = () => ({ ok: false, missing: ["walletState.adjustCharacterBalanceAsync"] });
    const { journal, budgets, offers, priceCache } = createRepos();
    const tx = (fn) => { const r = opened.store.transaction("test", fn); assert.ok(r.ok, JSON.stringify(r)); return r.value; };
    fundBudget(tx, budgets);
    const telemetry = countingTelemetry();

    const cfg = makeConfig({ trade: { virtualIssuers: true, maxIssuesPerPass: 2 } });
    const ex = createExecutor({ store: opened.store, journal, offers, budgets, adapter, priceCache, config: cfg, getStations: { [STATION]: { stationId: STATION_ID, kind: "npc", ownerCorporationId: CORP, systemId: SYSTEM, destroyed: false, online: true } }, telemetry, getVirtualCorps: adapter.getVirtualCorps });

    ex.start();
    const o = createOffer(tx, offers, "tc11c1", STATION);
    const pass = await ex.runPass();
    runExecutorAndAssert(pass, { issued: 1, opened: 1 });

    const offer = getOffer(tx, offers, o.offerId);
    assert.strictEqual(offer.issuerCharacterId, null);
    assert.strictEqual(offer.issuerCharacterCorpId, null);
    assert.strictEqual(telemetry.counts["trade.issuerFallback"], 1, "issuerFallback = 1");
    assert.strictEqual(telemetry.counts["trade.issuerVirtual"] || 0, 0, "issuerVirtual = 0");

    ex.stop();
  }));

  needsDriver("TC11d virtualCorps not ready: offer waits, then after issueTimeoutMs -> NPC", () => H.withStore(driver, async (reopen) => {
    const opened = reopen();
    insertStation(opened.store, CLOCK);
    const adapter = createFakeTradeAdapter();
    adapter._setVirtualCorpsIssuers([]);
    const vcFacade = adapter.getVirtualCorps();
    const _origList = vcFacade.listTradeIssuers;
    vcFacade.listTradeIssuers = (fid) => ({ ok: true, ready: false, issuers: [] });

    const { journal, budgets, offers, priceCache } = createRepos();
    const tx = (fn) => { const r = opened.store.transaction("test", fn); assert.ok(r.ok, JSON.stringify(r)); return r.value; };
    fundBudget(tx, budgets);
    const telemetry = countingTelemetry();

    const cfg = makeConfig({ trade: { virtualIssuers: true, maxIssuesPerPass: 2, issueTimeoutMs: 5000 } });
    const ex = createExecutor({ store: opened.store, journal, offers, budgets, adapter, priceCache, config: cfg, getStations: { [STATION]: { stationId: STATION_ID, kind: "npc", ownerCorporationId: CORP, systemId: SYSTEM, destroyed: false, online: true } }, telemetry, getVirtualCorps: adapter.getVirtualCorps });

    ex.start();
    const o = createOffer(tx, offers, "tc11d1", STATION);
    const pass1 = await ex.runPass();
    runExecutorAndAssert(pass1, { issued: 0, opened: 0, retried: 0 });
    assert.strictEqual(getOffer(tx, offers, o.offerId).state, "PLANNED");
    assert.strictEqual(telemetry.counts["trade.issuerWait"], 1, "issuerWait = 1");

    const restore = advanceClock(6000);
    const pass2 = await ex.runPass();
    runExecutorAndAssert(pass2, { issued: 1, opened: 1 });
    const offer2 = getOffer(tx, offers, o.offerId);
    assert.strictEqual(offer2.issuerCharacterId, null);
    assert.strictEqual(telemetry.counts["trade.issuerFallback"], 1, "issuerFallback = 1 after timeout");
    assert.strictEqual(telemetry.counts["trade.issuerVirtual"] || 0, 0, "issuerVirtual = 0");

    restore();
    ex.stop();
  }));
};

const CHAR = 90000123;
const VCORP = 98000001;

function issueCharacterOffer(tx, offers, journal, offerId, now, itemKey = "type:34", typeId = 34) {
  const r = tx((db) => offers.createOfferInTx(db, makeOffer({ offerId, itemKey, typeId }), `ik:${offerId}:offer:${offerId}`));
  assert.ok(r.ok && !r.duplicate, `create offer ${offerId}`);
  const expiresAt = now + makeConfig().trade.contractTtlMs;
  const t = tx((db) => offers.transitionOfferInTx(db, {
    offerId: r.offer.offerId, expectedVersion: 1, from: S.PLANNED, to: S.ISSUING, reason: "", at: now,
    patch: { expiresAt, issuerCharacterId: CHAR, issuerCharacterCorpId: VCORP },
  }, S.transitionKey(r.offer.offerId, 1, S.ISSUING)));
  assert.ok(t.ok, JSON.stringify(t));
  const cfg = makeConfig().trade;
  const payload = buildIssuePayload({ ...t.offer, rewardIsk: t.offer.iskTotal }, { stationId: STATION_ID, systemId: SYSTEM },
    null, { accountKey: cfg.walletAccountKey, contractTtlMs: cfg.contractTtlMs }, "Sansha");
  tx((db) => journal.enqueueOutbox(db, { key: S.issueOutboxKey(r.offer.offerId),
    aggregate: { type: S.OFFER_AGGREGATE, id: r.offer.offerId }, eventType: S.EVENT_OUTBOX_ISSUE, payload }));
  return t.offer;
}

function countWalletLegs(adapter) {
  const orig = adapter.tradeAdjustWallet;
  const calls = [];
  adapter.tradeAdjustWallet = (spec) => { calls.push(spec); return orig.call(adapter, spec); };
  return { calls };
}