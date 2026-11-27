"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const config = require("../../config");
const { createJournal } = require("../../lib/persistence/journal");
const { openStore } = require("../../lib/persistence/store");
const { createBudgetRepository } = require("../../lib/economy/trade/budgetRepository");
const { createOfferRepository } = require("../../lib/economy/trade/offerRepository");
const { createTradeExecutor } = require("../../lib/economy/trade/tradeExecutor");
const { createFakeTradeAdapter } = require("../_support/fakeTradeAdapter");
const { harness: H } = require("../battle/settlement.test");
const S = require("../../lib/economy/trade/schema");
const { planIntake } = require("../../lib/economy/trade/executorRules");
const { REGISTRY_DATA_V1, createFactionRegistry } = require("../../lib/strategy/registry");
const { HULL_GROUPS, FLEET_ROLES, OPERATION_TYPES } = require("../../lib/fleets/schema");
const { createHostility } = require("../../lib/battle/data/hostility");
const { runOrphanScan } = require("../../lib/economy/trade/orphans");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const DEFAULTS = config.resolveConfig({ modDir: MOD_DIR, env: {} }).config;

const F = 500019;
const CORP = 999999;
const CEO = 123456789;
const STATION = "npc-1";
const STATION_ID = 60003760;
const STATION2 = "npc-2";
const STATION2_ID = 60003761;
const STATION3 = "npc-3";
const STATION3_ID = 60003762;
const STATION4 = "npc-4";
const STATION4_ID = 60003763;
const STATION5 = "npc-5";
const STATION5_ID = 60003764;
const SYSTEM = 30000001;
const TYPE_ID = 34;
const QUANTITY = 1000;
const AT = 1000000;
let clockNow = AT;
const CLOCK = { now: () => clockNow };

let idCounter = 0;
const IDS = { next: (p) => `${p}_${++idCounter}` };

function insertStation(store, clock, stationId = STATION, stationItemId = STATION_ID, destroyed = false) {
  const now = clock.now();
  const tx = store.transaction("test.insertStation", (db) => {
    const stmt = db.prepare(`
      INSERT INTO world_stations (station_id, kind, npc_station_id, type_id, structure_family, system_id,
        owner_faction_id, owner_corporation_id, state, state_until_at, name, position_json, origin,
        evejs_item_id, destroyed_at, created_at, updated_at, version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(stationId, "npc", stationItemId, 35834, "Sansha", SYSTEM, F, CORP, "ONLINE", null,
      "Sansha Testing Station", '{"x":0,"y":0,"z":0}', "seed", null, destroyed ? now : null, now, now, 1);
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
    typeId: TYPE_ID,
    quantity: QUANTITY,
    unitPriceMilli: 1100,
    iskTotal: QUANTITY * 1100,
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
    enabled: true, contractsEnabled: true, cleanupOnDisable: false, walletAccountKey: 1006,
    contractTtlMs: 259200000, executorPollMs: 60000, maxIssuesPerPass: 2,
    maxPollsPerPass: 16, maxClosesPerPass: 4, issueTimeoutMs: 1800000,
    priceRegionId: 10000002, maxPriceRegions: 8, priceRefreshMs: 1800000,
    maxIntakesPerPass: 2, intakeGraceMs: 600000, maxOrphansPerPass: 2,
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

function fundBudget(tx, budgets) {
  tx((db) => budgets.fundInTx(db, { factionId: F, units: 100000, paidUntilTo: AT, iskPerUnit: 1000,
    capIsk: 1000000000, at: AT }, "fund:1"));
}

function createOffer(tx, offers, offerId, stationId = STATION) {
  const spec = makeOffer({ offerId, stationId });
  const r = tx((db) => offers.createOfferInTx(db, spec, `ik:${offerId}:offer:${offerId}:${stationId}`));
  assert.ok(r.ok && !r.duplicate, `create offer ${offerId}`);
  return r.offer;
}

function issueAndOpenOffer(tx, offers, journal, offerId, now, npcStationId = STATION_ID) {
  const offerSpec = makeOffer({ offerId });
  const r = tx((db) => offers.createOfferInTx(db, offerSpec, `ik:${offerId}:offer:${offerId}:${STATION}`));
  assert.ok(r.ok && !r.duplicate, `create offer ${offerId}`);
  let offer = r.offer;
  tx((db) => offers.transitionOfferInTx(db, {
    offerId: offer.offerId, expectedVersion: 1, from: S.PLANNED, to: S.ISSUING, reason: "", at: now,
    patch: { expiresAt: now + makeConfig().trade.contractTtlMs }
  }, S.transitionKey(offer.offerId, 1, S.ISSUING)));
  tx((db) => journal.enqueueOutbox(db, {
    key: S.issueOutboxKey(offer.offerId),
    aggregate: { type: S.OFFER_AGGREGATE, id: offer.offerId },
    eventType: S.EVENT_OUTBOX_ISSUE,
    payload: { offerId: offer.offerId, corporationId: CORP, ceoId: CEO, accountKey: 1006, npcStationId,
      typeId: TYPE_ID, quantity: QUANTITY, rewardIsk: QUANTITY * 1100, minutesExpire: 4320,
      title: "Sansha: purchase order",
      description: `[LNE:${offer.offerId}] Sansha buys ${QUANTITY} units of this item for its station. Deliver to this station.` }
  }));
  tx((db) => offers.transitionOfferInTx(db, {
    offerId: offer.offerId, expectedVersion: 2, from: S.ISSUING, to: S.OPEN, reason: "", at: now + 1000,
    patch: { contractId: 555555 }
  }, S.transitionKey(offer.offerId, 2, S.OPEN)));
  return offer;
}

function openOfferAccepted(tx, offers, journal, offerId, now, contractId, stationId = STATION, npcStationId = STATION_ID) {
  const offerSpec = makeOffer({ offerId, stationId });
  let r = tx((db) => offers.createOfferInTx(db, offerSpec, `ik:${offerId}:offer:${offerId}:${stationId}`));
  assert.ok(r.ok && !r.duplicate, `create offer ${offerId}`);
  let offer = r.offer;
  tx((db) => offers.transitionOfferInTx(db, {
    offerId: offer.offerId, expectedVersion: 1, from: S.PLANNED, to: S.ISSUING, reason: "", at: now,
    patch: { expiresAt: now + makeConfig().trade.contractTtlMs }
  }, S.transitionKey(offer.offerId, 1, S.ISSUING)));
  tx((db) => offers.transitionOfferInTx(db, {
    offerId: offer.offerId, expectedVersion: 2, from: S.ISSUING, to: S.OPEN, reason: "", at: now + 1000,
    patch: { contractId }
  }, S.transitionKey(offer.offerId, 2, S.OPEN)));
  tx((db) => offers.transitionOfferInTx(db, {
    offerId: offer.offerId, expectedVersion: 3, from: S.OPEN, to: S.ACCEPTED, reason: "", at: now + 2000,
    patch: { acceptorCharacterId: 999 }
  }, S.transitionKey(offer.offerId, 3, S.ACCEPTED)));
  return offer;
}

function getOffer(tx, offers, offerId) {
  return tx((db) => offers.getOffer(db, offerId)).offer;
}

function getBudget(tx, budgets) {
  return tx((db) => budgets.getBudget(db, F)).budget;
}

function advanceClock(ms) {
  const oldNow = clockNow;
  clockNow += ms;
  return () => { clockNow = oldNow; };
}

function countAdapterCalls(adapter) {
  const origVoidStack = adapter.tradeVoidStack;
  const origListDeliveredStacks = adapter.tradeListDeliveredStacks;
  let calls = 0;
  adapter.tradeVoidStack = async (...args) => { calls += 1; return origVoidStack.apply(adapter, args); };
  adapter.tradeListDeliveredStacks = async (...args) => { calls += 1; return origListDeliveredStacks.apply(adapter, args); };
  return () => calls;
}

module.exports = ({ test, skip }) => {
  const driver = H.loadDriver();

  test("TI1 happy path: ACCEPTED + 2 stacks (quantity+5) → INTAKE → DELIVERED, stock +quantity, surplus 5 remains, outbox APPLIED", () => H.withStore(driver, async (reopen) => {
    const opened = reopen();
    insertStation(opened.store, CLOCK);
    const adapter = createFakeTradeAdapter();
    const { journal, budgets, offers, priceCache } = createRepos();
    const tx = (fn) => { const r = opened.store.transaction("test", fn); assert.ok(r.ok, JSON.stringify(r)); return r.value; };
    fundBudget(tx, budgets);

    const offer = openOfferAccepted(tx, offers, journal, "ti1", AT, 555555);
    clockNow = AT + 10000;

    adapter._addHangarStack(CORP, STATION_ID, 1000, TYPE_ID, QUANTITY + 5);
    adapter._addHangarStack(CORP, STATION_ID, 1001, TYPE_ID, 5);

    const executor = createTradeExecutor({ store: opened.store, journal, offers, budgets, adapter,
      priceCache, config: makeConfig(), clock: CLOCK,
      getStations: () => ({ [STATION]: { stationId: STATION_ID, kind: "npc", ownerCorporationId: CORP, systemId: SYSTEM, destroyed: false, online: true } }),
      getGraph: () => null, mode: "run",
      getGovernor: () => ({ admits: () => true }), factionNames: new Map([[F, "Sansha"]]), telemetry: null,
      logger: { log: () => {} } });
    executor.start();

    const pass = await executor.runPass();
    assert.ok(pass.ok);

    const offerAfter = getOffer(tx, offers, offer.offerId);
    assert.strictEqual(offerAfter.state, "DELIVERED", "offer should be DELIVERED");
    assert.strictEqual(offerAfter.deliveredQuantity, QUANTITY, "deliveredQuantity should be quantity");

    const stockRow = tx((db) => {
      const stmt = db.prepare("SELECT quantity FROM world_station_stock WHERE station_id = ? AND item_kind = 'mineral' AND item_key = 'type:34'");
      return stmt.get(STATION);
    });
    assert.ok(stockRow, "stock row should exist");
    assert.strictEqual(stockRow.quantity, QUANTITY, "stock should increase by exactly quantity");

    const stack1000 = adapter._state.hangarStacks.get(CORP).get(STATION_ID).get(1000);
    const stack1001 = adapter._state.hangarStacks.get(CORP).get(STATION_ID).get(1001);
    assert.strictEqual(stack1000.quantity, 5, "stack 1000 should have 5 remaining (quantity+5 - quantity)");
    assert.strictEqual(stack1001.quantity, 5, "stack 1001 should be untouched (surplus)");

    const outboxKey = S.intakeOutboxKey(offer.offerId);
    const outbox = tx((db) => journal.findByKey(db, outboxKey));
    assert.ok(outbox.ok && outbox.found && outbox.entry.state === "APPLIED", "intake outbox APPLIED");

    executor.stop();
  }));

  test("TI2 restart: adapter stops after 1st stack (ambiguous) → new executor → 2nd stack, 1st ALREADY_COMMITTED, stock +quantity once", () => H.withStore(driver, async (reopen) => {
    const opened = reopen();
    insertStation(opened.store, CLOCK);
    const adapter = createFakeTradeAdapter();
    const { journal, budgets, offers, priceCache } = createRepos();
    const tx = (fn) => { const r = opened.store.transaction("test", fn); assert.ok(r.ok, JSON.stringify(r)); return r.value; };
    fundBudget(tx, budgets);

    const offer = openOfferAccepted(tx, offers, journal, "ti2", AT, 666666);
    clockNow = AT + 10000;

    adapter._addHangarStack(CORP, STATION_ID, 2000, TYPE_ID, QUANTITY);
    adapter._addHangarStack(CORP, STATION_ID, 2001, TYPE_ID, 5);

    let voidCallCount = 0;
    const origVoidStack = adapter.tradeVoidStack;
    adapter.tradeVoidStack = async (spec) => {
      voidCallCount++;
      if (voidCallCount === 1) {
        return { ok: false, reason: "CUSTODY_FAILED", permanent: false, ambiguous: true, detail: "transient" };
      }
      return origVoidStack(spec);
    };

    const executor1 = createTradeExecutor({ store: opened.store, journal, offers, budgets, adapter,
      priceCache, config: makeConfig(), clock: CLOCK,
      getStations: () => ({ [STATION]: { stationId: STATION_ID, kind: "npc", ownerCorporationId: CORP, systemId: SYSTEM, destroyed: false, online: true } }),
      getGraph: () => null, mode: "run",
      getGovernor: () => ({ admits: () => true }), factionNames: new Map([[F, "Sansha"]]), telemetry: null,
      logger: { log: () => {} } });
    executor1.start();

    const pass1 = await executor1.runPass();
    assert.ok(pass1.ok);

    const offerAfter1 = getOffer(tx, offers, offer.offerId);
    assert.strictEqual(offerAfter1.state, "INTAKE", "offer should be INTAKE after first pass");

    const stack2000 = adapter._state.hangarStacks.get(CORP).get(STATION_ID).get(2000);
    const stack2001 = adapter._state.hangarStacks.get(CORP).get(STATION_ID).get(2001);
    assert.strictEqual(stack2000.quantity, QUANTITY, "stack 2000 untouched after ambiguous void");
    assert.strictEqual(stack2001.quantity, 5, "stack 2001 untouched");

    executor1.stop();

    adapter.tradeVoidStack = origVoidStack;

    const executor2 = createTradeExecutor({ store: opened.store, journal, offers, budgets, adapter,
      priceCache, config: makeConfig(), clock: CLOCK,
      getStations: () => ({ [STATION]: { stationId: STATION_ID, kind: "npc", ownerCorporationId: CORP, systemId: SYSTEM, destroyed: false, online: true } }),
      getGraph: () => null, mode: "run",
      getGovernor: () => ({ admits: () => true }), factionNames: new Map([[F, "Sansha"]]), telemetry: null,
      logger: { log: () => {} } });
    executor2.start();

    const pass2 = await executor2.runPass();
    assert.ok(pass2.ok);

    const offerAfter2 = getOffer(tx, offers, offer.offerId);
    assert.strictEqual(offerAfter2.state, "DELIVERED", "offer should be DELIVERED after retry");
    assert.strictEqual(offerAfter2.deliveredQuantity, QUANTITY, "deliveredQuantity should be quantity");

    const stockRow = tx((db) => {
      const stmt = db.prepare("SELECT quantity FROM world_station_stock WHERE station_id = ? AND item_kind = 'mineral' AND item_key = 'type:34'");
      return stmt.get(STATION);
    });
    assert.strictEqual(stockRow.quantity, QUANTITY, "stock should be exactly quantity (no double delivery)");

    assert.strictEqual(stack2000.quantity, 0, "stack 2000 voided on retry");

    executor2.stop();

    adapter._reset();
    const executor3 = createTradeExecutor({ store: opened.store, journal, offers, budgets, adapter,
      priceCache, config: makeConfig(), clock: CLOCK,
      getStations: () => ({ [STATION]: { stationId: STATION_ID, kind: "npc", ownerCorporationId: CORP, systemId: SYSTEM, destroyed: false, online: true } }),
      getGraph: () => null, mode: "run",
      getGovernor: () => ({ admits: () => true }), factionNames: new Map([[F, "Sansha"]]), telemetry: null,
      logger: { log: () => {} } });
    executor3.start();

    const pass3 = await executor3.runPass();
    assert.ok(pass3.ok);
    assert.strictEqual(pass3.accepted, 0, "no new accepted after DELIVERED");

    executor3.stop();
  }));

  test("TI3 edges: no stacks → WAIT/LOST, partial → DELIVERED+intakeShort, DESTROYED → LOST STATION_GONE, STOCK_CAP → trimmed", () => H.withStore(driver, async (reopen) => {
    const opened = reopen();

    const adapterA = createFakeTradeAdapter();
    const { journal: jA, budgets: bA, offers: oA, priceCache: pcA } = createRepos();
    const txA = (fn) => { const r = opened.store.transaction("test", fn); assert.ok(r.ok, JSON.stringify(r)); return r.value; };
    fundBudget(txA, bA);
    insertStation(opened.store, CLOCK, STATION, STATION_ID);
    const offerA = openOfferAccepted(txA, oA, jA, "ti3a", AT, 777777);
    clockNow = AT + 10000;

    const executorA = createTradeExecutor({ store: opened.store, journal: jA, offers: oA, budgets: bA, adapter: adapterA,
      priceCache: pcA, config: makeConfig(), clock: CLOCK,
      getStations: () => ({ [STATION]: { stationId: STATION_ID, kind: "npc", ownerCorporationId: CORP, systemId: SYSTEM, destroyed: false, online: true } }),
      getGraph: () => null, mode: "run",
      getGovernor: () => ({ admits: () => true }), factionNames: new Map([[F, "Sansha"]]), telemetry: null,
      logger: { log: () => {} } });
    executorA.start();

    const passA = await executorA.runPass();
    const offerAAfter = getOffer(txA, oA, offerA.offerId);
    assert.strictEqual(offerAAfter.state, "ACCEPTED", "offer stays ACCEPTED when no stacks (WAIT)");
    executorA.stop();

    insertStation(opened.store, CLOCK, STATION2, STATION2_ID);
    const offerA2 = openOfferAccepted(txA, oA, jA, "ti3b", AT, 777778, STATION2, STATION2_ID);
    clockNow = AT + 602001;
    try {
      const executorB = createTradeExecutor({ store: opened.store, journal: jA, offers: oA, budgets: bA, adapter: adapterA,
        priceCache: pcA, config: makeConfig(), clock: CLOCK,
        getStations: () => ({ [STATION2]: { stationId: STATION2_ID, kind: "npc", ownerCorporationId: CORP, systemId: SYSTEM, destroyed: false, online: true } }),
        getGraph: () => null, mode: "run",
        getGovernor: () => ({ admits: () => true }), factionNames: new Map([[F, "Sansha"]]), telemetry: null,
        logger: { log: () => {} } });
      executorB.start();
      assert.deepStrictEqual(planIntake({ quantity: 5, updatedAt: AT + 2000 }, [], AT + 602001, 600000),
        { action: "LOST", reason: "NOTHING_DELIVERED" });
      await executorB.runPass();
      const offerBAfter = getOffer(txA, oA, offerA2.offerId);
      assert.strictEqual(offerBAfter.state, "LOST", "offer should be LOST after grace with no stacks");
      assert.strictEqual(offerBAfter.endReason, "NOTHING_DELIVERED", "end reason NOTHING_DELIVERED");
      executorB.stop();
    } finally {
      clockNow = AT + 10000;
    }

    const adapterC = createFakeTradeAdapter();
    const { journal: jC, budgets: bC, offers: oC, priceCache: pcC } = createRepos();
    const txC = (fn) => { const r = opened.store.transaction("test", fn); assert.ok(r.ok, JSON.stringify(r)); return r.value; };
    fundBudget(txC, bC);
    insertStation(opened.store, CLOCK, STATION3, STATION3_ID);
    const offerC = openOfferAccepted(txC, oC, jC, "ti3c", AT, 888888, STATION3, STATION3_ID);
    clockNow = AT + 602001;
    adapterC._addHangarStack(CORP, STATION3_ID, 3000, TYPE_ID, 300);

    const executorC = createTradeExecutor({ store: opened.store, journal: jC, offers: oC, budgets: bC, adapter: adapterC,
      priceCache: pcC, config: makeConfig(), clock: CLOCK,
      getStations: () => ({ [STATION3]: { stationId: STATION3_ID, kind: "npc", ownerCorporationId: CORP, systemId: SYSTEM, destroyed: false, online: true } }),
      getGraph: () => null, mode: "run",
      getGovernor: () => ({ admits: () => true }), factionNames: new Map([[F, "Sansha"]]), telemetry: null,
      logger: { log: () => {} } });
    executorC.start();
    const passC = await executorC.runPass();
    const offerCAfter = getOffer(txC, oC, offerC.offerId);
    assert.strictEqual(offerCAfter.state, "DELIVERED", "partial delivery → DELIVERED");
    assert.strictEqual(offerCAfter.deliveredQuantity, 300, "deliveredQuantity should be 300 (partial)");
    executorC.stop();
    clockNow = AT + 10000;

    const adapterD = createFakeTradeAdapter();
    const { journal: jD, budgets: bD, offers: oD, priceCache: pcD } = createRepos();
    const txD = (fn) => { const r = opened.store.transaction("test", fn); assert.ok(r.ok, JSON.stringify(r)); return r.value; };
    fundBudget(txD, bD);
    const offerD = openOfferAccepted(txD, oD, jD, "ti3d", AT, 999999, STATION4, STATION4_ID);
    clockNow = AT + 10000;
    insertStation(opened.store, CLOCK, STATION4, STATION4_ID, true);

    const executorD = createTradeExecutor({ store: opened.store, journal: jD, offers: oD, budgets: bD, adapter: adapterD,
      priceCache: pcD, config: makeConfig(), clock: CLOCK,
      getStations: () => ({ [STATION4]: { stationId: STATION4_ID, kind: "npc", ownerCorporationId: CORP, systemId: SYSTEM, destroyed: true, online: true } }),
      getGraph: () => null, mode: "run",
      getGovernor: () => ({ admits: () => true }), factionNames: new Map([[F, "Sansha"]]), telemetry: null,
      logger: { log: () => {} } });
    executorD.start();
    const passD = await executorD.runPass();
    const offerDAfter = getOffer(txD, oD, offerD.offerId);
    assert.strictEqual(offerDAfter.state, "LOST", "destroyed station → LOST");
    assert.strictEqual(offerDAfter.endReason, "STATION_GONE", "end reason STATION_GONE");
    executorD.stop();

    const adapterE = createFakeTradeAdapter();
    const { journal: jE, budgets: bE, offers: oE, priceCache: pcE } = createRepos();
    const txE = (fn) => { const r = opened.store.transaction("test", fn); assert.ok(r.ok, JSON.stringify(r)); return r.value; };
    fundBudget(txE, bE);
    insertStation(opened.store, CLOCK, STATION5, STATION5_ID);
    const offerE = openOfferAccepted(txE, oE, jE, "ti3e", AT, 111111, STATION5, STATION5_ID);
    clockNow = AT + 10000;
    adapterE._addHangarStack(CORP, STATION5_ID, 4000, TYPE_ID, QUANTITY);
    adapterE._addHangarStack(CORP, STATION5_ID, 4001, TYPE_ID, 50);

    const executorE = createTradeExecutor({ store: opened.store, journal: jE, offers: oE, budgets: bE, adapter: adapterE,
      priceCache: pcE, config: makeConfig(), clock: CLOCK,
      getStations: () => ({ [STATION5]: { stationId: STATION5_ID, kind: "npc", ownerCorporationId: CORP, systemId: SYSTEM, destroyed: false, online: true } }),
      getGraph: () => null, mode: "run",
      getGovernor: () => ({ admits: () => true }), factionNames: new Map([[F, "Sansha"]]), telemetry: null,
      logger: { log: () => {} } });
    executorE.start();
    const passE = await executorE.runPass();
    const offerEAfter = getOffer(txE, oE, offerE.offerId);
    assert.strictEqual(offerEAfter.state, "DELIVERED", "STOCK_CAP test: should still DELIVER");
    assert.ok(offerEAfter.deliveredQuantity > 0, "should deliver some quantity");
    executorE.stop();
  }));

  test("TI4 orphans + hook: contract without offer → deleted+defunded once; ISSUING → untouched; wrapper semantics", () => H.withStore(driver, async (reopen) => {
    const opened = reopen();
    insertStation(opened.store, CLOCK);

    const adapterA = createFakeTradeAdapter();
    const { journal: jA, budgets: bA, offers: oA } = createRepos();
    const txA = (fn) => { const r = opened.store.transaction("test", fn); assert.ok(r.ok, JSON.stringify(r)); return r.value; };
    fundBudget(txA, bA);

    adapterA._state.contracts.set(123456, {
      contractId: 123456, offerId: "orphan-1", corporationId: CORP,
      status: "OUTSTANDING", payload: { info: { description: `[LNE:orphan-1] orphan contract`, reward: 5000 }, session: {} },
      createdAt: Date.now(),
    });

    const executorA = createTradeExecutor({ store: opened.store, journal: jA, offers: oA, budgets: bA, adapter: adapterA,
      priceCache: { put() {}, peek() { return null; }, getStatus() { return { entries: 0, source: "none", newestAt: null }; } },
      config: makeConfig(), clock: CLOCK,
      getStations: () => new Map([[STATION, { stationId: STATION_ID, kind: "npc", ownerCorporationId: CORP, systemId: SYSTEM, destroyed: false, online: true }]]),
      getGraph: () => null, mode: "run",
      getGovernor: () => ({ admits: () => true }), factionNames: new Map([[F, "Sansha"]]), telemetry: null,
      logger: { log: () => {} } });
    executorA.start();
    const passA = await executorA.runPass();
    assert.ok(!adapterA._state.contracts.has(123456), "orphan contract deleted");
    executorA.stop();

    const executorA2 = createTradeExecutor({ store: opened.store, journal: jA, offers: oA, budgets: bA, adapter: adapterA,
      priceCache: { put() {}, peek() { return null; }, getStatus() { return { entries: 0, source: "none", newestAt: null }; } },
      config: makeConfig(), clock: CLOCK,
      getStations: () => new Map([[STATION, { stationId: STATION_ID, kind: "npc", ownerCorporationId: CORP, systemId: SYSTEM, destroyed: false }]]),
      getGraph: () => null, mode: "run",
      getGovernor: () => ({ admits: () => true }), factionNames: new Map([[F, "Sansha"]]), telemetry: null,
      logger: { log: () => {} } });
    executorA2.start();
    const passA2 = await executorA2.runPass();
    assert.ok(!adapterA._state.contracts.has(123456), "orphan contract still deleted on second pass");
    executorA2.stop();

    const adapterB = createFakeTradeAdapter();
    const { journal: jB, budgets: bB, offers: oB } = createRepos();
    const txB = (fn) => { const r = opened.store.transaction("test", fn); assert.ok(r.ok, JSON.stringify(r)); return r.value; };
    fundBudget(txB, bB);
    const offerB = createOffer(txB, oB, "ti4b-issuing");
    txB((db) => oB.transitionOfferInTx(db, {
      offerId: offerB.offerId, expectedVersion: 1, from: S.PLANNED, to: S.ISSUING, reason: "", at: AT,
      patch: { expiresAt: AT + 259200000 }
    }, S.transitionKey(offerB.offerId, 1, S.ISSUING)));

    adapterB._state.contracts.set(222222, {
      contractId: 222222, offerId: offerB.offerId, corporationId: CORP,
      status: "OUTSTANDING", payload: { info: { description: `[LNE:${offerB.offerId}] issuing contract`, reward: 5000 }, session: {} },
      createdAt: Date.now(),
    });

    const executorB = createTradeExecutor({ store: opened.store, journal: jB, offers: oB, budgets: bB, adapter: adapterB,
      priceCache: { put() {}, peek() { return null; }, getStatus() { return { entries: 0, source: "none", newestAt: null }; } },
      config: makeConfig(), clock: CLOCK,
      getStations: () => new Map([[STATION, { stationId: STATION_ID, kind: "npc", ownerCorporationId: CORP, systemId: SYSTEM, destroyed: false, online: true }]]),
      getGraph: () => null, mode: "run",
      getGovernor: () => ({ admits: () => true }), factionNames: new Map([[F, "Sansha"]]), telemetry: null,
      logger: { log: () => {} } });
    executorB.start();
    const passB = await executorB.runPass();
    assert.ok(adapterB._state.contracts.has(222222), "ISSUING offer contract not deleted");
    const offerBAfter = getOffer(txB, oB, offerB.offerId);
    assert.strictEqual(offerBAfter.state, S.ISSUING, "ISSUING offer unchanged");
    executorB.stop();

    const { wrapContractAccepted } = require("../../lib/adapter/contractHooks");
    const calls = [];
    const notificationsExports = {
      notifyContractAccepted: function (contract, sourceSession = null) {
        calls.push({ self: this, contract, sourceSession });
        return contract && contract.contractID ? 1 : 0;
      },
    };
    const original = notificationsExports.notifyContractAccepted;
    let nudgeCount = 0;
    const wrapRes = wrapContractAccepted(notificationsExports, () => { nudgeCount += 1; });
    assert.ok(wrapRes.ok, "wrap installed");

    const session = { characterID: 9 };
    const lneRecord = { contractID: 123456, issuerID: CORP, description: "[LNE:to_1] Sansha buys 1000 units" };
    const result1 = notificationsExports.notifyContractAccepted(lneRecord, session);
    assert.strictEqual(result1, 1, "original result returned unchanged and synchronously (not a Promise)");
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].contract, lneRecord, "same contract argument");
    assert.strictEqual(calls[0].sourceSession, session, "same session argument");
    assert.strictEqual(calls[0].self, notificationsExports, "same this");
    assert.strictEqual(nudgeCount, 1, "nudge once for an [LNE: contract");

    const result2 = notificationsExports.notifyContractAccepted({ contractID: 789012, description: "player contract" }, null);
    assert.strictEqual(result2, 1);
    assert.strictEqual(nudgeCount, 1, "no nudge for a contract without [LNE:");
    assert.strictEqual(notificationsExports.notifyContractAccepted(null), 0, "null contract passes through");
    assert.strictEqual(nudgeCount, 1);

    assert.deepStrictEqual(wrapContractAccepted(notificationsExports, () => {}), { ok: false, reason: "HOOK_ALREADY_INSTALLED" });
    assert.deepStrictEqual(wrapContractAccepted({}, () => {}), { ok: false, reason: "HOOK_SEAM_UNAVAILABLE" });

    wrapRes.uninstall();
    assert.strictEqual(notificationsExports.notifyContractAccepted, original, "uninstall restores the original");
    const wrapThrow = wrapContractAccepted(notificationsExports, () => { throw new Error("boom"); });
    assert.ok(wrapThrow.ok);
    assert.strictEqual(notificationsExports.notifyContractAccepted(lneRecord, null), 1, "original result even when onAccepted throws");
    wrapThrow.uninstall();
    const failing = { notifyContractAccepted() { throw new Error("vendor"); } };
    const wrapFail = wrapContractAccepted(failing, () => { nudgeCount += 1; });
    assert.throws(() => failing.notifyContractAccepted(lneRecord), /vendor/, "original error propagates");
    assert.strictEqual(nudgeCount, 1, "no nudge when the original throws");
    wrapFail.uninstall();
  }));

  test("TO1n orphans: offer defund key merges with CANCELLED, DELIVERED -> no defund, no offer -> one defund on the issuer division, issuer deletes", () => H.withStore(driver, async (reopen) => {
    const opened = reopen();
    insertStation(opened.store, CLOCK);
    const adapter = createFakeTradeAdapter();
    const { journal, budgets, offers, priceCache } = createRepos();
    const tx = (fn) => { const r = opened.store.transaction("test", fn); assert.ok(r.ok, JSON.stringify(r)); return r.value; };
    fundBudget(tx, budgets);
    const S0 = 2000000;
    const OTHER = 3000000;
    adapter._setWalletBalance(CORP, 1006, S0);
    adapter._setWalletBalance(CORP, 1005, OTHER);

    const offerA = createOffer(tx, offers, "to1a");
    tx((db) => offers.transitionOfferInTx(db, { offerId: offerA.offerId, expectedVersion: 1, from: S.PLANNED, to: S.CANCELLED,
      reason: "DISABLED", at: AT }, S.transitionKey(offerA.offerId, 1, S.CANCELLED)));
    adapter._state.receipts.add(S.walletCommandId(offerA.offerId, "defund"));
    const offerB = openOfferAccepted(tx, offers, journal, "to1b", AT, 555001);
    const step = (to, reason, patch) => {
      const cur = getOffer(tx, offers, offerB.offerId);
      const r = tx((db) => offers.transitionOfferInTx(db, { offerId: cur.offerId, expectedVersion: cur.version, from: cur.state, to,
        reason, at: AT + 3000, ...(patch ? { patch } : {}) }, S.transitionKey(cur.offerId, cur.stateSeq + 1, to)));
      assert.ok(r.ok, `${cur.state} -> ${to}: ${JSON.stringify(r)}`);
    };
    step(S.INTAKE, "");
    step(S.DELIVERED, "DELIVERED", { deliveredQuantity: QUANTITY });
    assert.strictEqual(getOffer(tx, offers, offerA.offerId).state, S.CANCELLED);
    assert.strictEqual(getOffer(tx, offers, offerB.offerId).state, S.DELIVERED);
    const TAG_C = "to1c-lost";
    const REWARD_C = 5000;

    const record = (contractId, offerId, reward) => ({
      contractId, offerId, corporationId: CORP, status: "OUTSTANDING", createdAt: Date.now(),
      payload: { info: { description: `[LNE:${offerId}] dup`, reward, forCorp: true },
        session: { characterID: CEO, corporationID: CORP, corpAccountKey: 1006 } },
      escrowIsk: reward, walletRef: { kind: "corporation", ownerId: CORP, accountKey: 1006 },
    });
    adapter._state.contracts.set(700001, record(700001, offerA.offerId, offerA.iskTotal));
    adapter._state.contracts.set(700002, record(700002, offerB.offerId, offerB.iskTotal));
    adapter._state.contracts.set(700003, record(700003, TAG_C, REWARD_C));

    const telemetry = { counts: {}, count(name, v) { this.counts[name] = (this.counts[name] || 0) + v; }, observe() {} };
    const executor = createTradeExecutor({ store: opened.store, journal, offers, budgets, adapter, priceCache,
      config: makeConfig({ trade: { walletAccountKey: 1005 } }), clock: CLOCK,
      getStations: () => new Map([[STATION, { stationId: STATION_ID, kind: "npc", ownerCorporationId: CORP, systemId: SYSTEM, destroyed: false, online: true }]]),
      getGraph: () => null, mode: "run",
      getGovernor: () => ({ admits: () => true }), factionNames: new Map([[F, "Sansha"]]), telemetry,
      logger: { log: () => {} } });
    executor.start();
    await executor.runPass();
    assert.strictEqual(adapter._state.contracts.size, 1, "full scan pass 1: two orphans deleted (budget 2)");
    await executor.runPass();
    executor.stop();

    assert.strictEqual(adapter._state.contracts.size, 0, "all three orphans deleted by the issuing CEO");
    assert.strictEqual(adapter._balance(CORP, 1006), S0 + offerA.iskTotal + offerB.iskTotal, "issuer division: S + escrows - (c) defund");
    assert.strictEqual(adapter._balance(CORP, 1005), OTHER, "config walletAccountKey division untouched");
    assert.ok(adapter._state.receipts.has(S.walletCommandId(offerA.offerId, "defund")), "(a) one defund receipt (offer key)");
    assert.ok(!adapter._state.receipts.has(S.walletCommandId(offerB.offerId, "defund")), "(b) no defund for DELIVERED");
    assert.ok(adapter._state.receipts.has(S.walletCommandId(TAG_C, "defund")), "(c) defund with the offer key of the tag");
    assert.deepStrictEqual([...adapter._state.receipts].filter((k) => k.startsWith("lne:trade:orphan:")), [], "no orphan key");
    assert.strictEqual(telemetry.counts["trade.orphans"], 3, "trade.orphans once per orphan");
    assert.strictEqual(telemetry.counts["trade.orphanDefundSkipped"], 1, "DELIVERED defund skipped");
    assert.strictEqual(telemetry.counts["trade.defundShort"] || 0, 0, "no short defund");
  }));

  test("TI6 startTrade run: pump started (timer armed), accept hook installed with executor.nudge; nudge re-arms one timer; stop uninstalls", () => H.withStore(driver, async (reopen) => {
    const opened = reopen();
    const journal = createJournal({ clock: CLOCK, maxPayloadBytes: 16384, maxRows: 500 });
    const timers = [];
    const setTimer = (fn, ms) => { const t = { fn, ms, cancelled: false, cancel() { t.cancelled = true; }, hasRef: () => false }; timers.push(t); return t; };
    const adapter = createFakeTradeAdapter();
    const hookCalls = [];
    let nudgeFn = null;
    adapter.setTradeNudge = (fn) => { hookCalls.push("set"); nudgeFn = fn; return { ok: true }; };
    adapter.installTradeHooks = () => { hookCalls.push("install"); return { ok: true }; };
    adapter.uninstallTradeHooks = () => { hookCalls.push("uninstall"); nudgeFn = null; return { ok: true }; };
    const cfg = { ...DEFAULTS, trade: { ...DEFAULTS.trade, enabled: true, contractsEnabled: true },
      stations: { ...DEFAULTS.stations, enabled: true } };
    const { startTrade } = require("../../lib/economy/trade");
    const started = startTrade({ config: cfg, persistence: { ok: true, store: opened.store, journal },
      clock: CLOCK, ids: IDS, adapter, setTimer });
    assert.ok(started.ok, JSON.stringify(started));
    const trade = started.trade;
    assert.strictEqual(trade.getMode(), "run");
    assert.strictEqual(trade.getStatus().executor.state, "running", "executor started");
    assert.strictEqual(timers.length, 1, "one poll timer armed");
    assert.strictEqual(timers[0].ms, cfg.trade.executorPollMs);
    assert.deepStrictEqual(hookCalls, ["set", "install"]);
    assert.strictEqual(typeof nudgeFn, "function");
    assert.strictEqual(trade.getStatus().acceptHook, "installed");

    nudgeFn();
    nudgeFn();
    assert.strictEqual(timers.length, 3);
    assert.strictEqual(timers[1].ms, 0, "nudge arms an immediate pass");
    assert.ok(timers[0].cancelled && timers[1].cancelled && !timers[2].cancelled, "only one live timer after nudges");

    trade.stop();
    assert.deepStrictEqual(hookCalls, ["set", "install", "uninstall"]);
    assert.ok(timers[2].cancelled, "stop cancels the timer");
    assert.strictEqual(trade.getStatus().acceptHook, "stopped");
  }));

  test("TI7 orphan scan respects the governor: admits at pass start, refuses before the scan -> no tradeListTaggedContracts", () => H.withStore(driver, async (reopen) => {
    const opened = reopen();
    insertStation(opened.store, CLOCK);
    const adapter = createFakeTradeAdapter();
    let listCalls = 0;
    const origList = adapter.tradeListTaggedContracts;
    adapter.tradeListTaggedContracts = async (...args) => { listCalls += 1; return origList.apply(adapter, args); };
    const { journal, budgets, offers, priceCache } = createRepos();
    let admitsCalls = 0;
    const executor = createTradeExecutor({ store: opened.store, journal, offers, budgets, adapter,
      priceCache, config: makeConfig(), clock: CLOCK,
      getStations: () => new Map([[STATION, { stationId: STATION_ID, kind: "npc", ownerCorporationId: CORP, systemId: SYSTEM, destroyed: false, online: true }]]),
      getGraph: () => null, mode: "run",
      getGovernor: () => ({ admits: () => { admitsCalls += 1; return admitsCalls === 1; } }),
      factionNames: new Map([[F, "Sansha"]]), telemetry: null, logger: { log: () => {} } });
    executor.start();
    const pass = await executor.runPass();
    executor.stop();
    assert.ok(pass.ok && !pass.skipped, "the pass itself was admitted");
    assert.strictEqual(admitsCalls, 2, "governor asked again by the orphan scan");
    assert.strictEqual(listCalls, 0, "orphan scan deferred");
  }));

  test("TI8 maxIntakesPerPass counts steps 6 and 7 together: budget 1 -> pass 1 INTAKE only, pass 2 DELIVERED", () => H.withStore(driver, async (reopen) => {
    const opened = reopen();
    insertStation(opened.store, CLOCK);
    const adapter = createFakeTradeAdapter();
    const { journal, budgets, offers, priceCache } = createRepos();
    const tx = (fn) => { const r = opened.store.transaction("test", fn); assert.ok(r.ok, JSON.stringify(r)); return r.value; };
    fundBudget(tx, budgets);
    const offer = openOfferAccepted(tx, offers, journal, "ti8", AT, 777777);
    clockNow = AT + 10000;
    adapter._addHangarStack(CORP, STATION_ID, 8000, TYPE_ID, QUANTITY);
    const executor = createTradeExecutor({ store: opened.store, journal, offers, budgets, adapter,
      priceCache, config: makeConfig({ trade: { maxIntakesPerPass: 1 } }), clock: CLOCK,
      getStations: () => ({ [STATION]: { stationId: STATION_ID, kind: "npc", ownerCorporationId: CORP, systemId: SYSTEM, destroyed: false, online: true } }),
      getGraph: () => null, mode: "run",
      getGovernor: () => ({ admits: () => true }), factionNames: new Map([[F, "Sansha"]]), telemetry: null,
      logger: { log: () => {} } });
    executor.start();
    await executor.runPass();
    assert.strictEqual(getOffer(tx, offers, offer.offerId).state, "INTAKE", "budget spent by step 6");
    await executor.runPass();
    assert.strictEqual(getOffer(tx, offers, offer.offerId).state, "DELIVERED", "step 7 on the next pass");
    executor.stop();
  }));

  test("TI9 deliver tx: station DESTROYED at intake -> LOST STATION_GONE + outbox APPLIED; replayed stepIntake after DELIVERED credits nothing", () => H.withStore(driver, async (reopen) => {
    const { stepAccepted, stepIntake } = require("../../lib/economy/trade/intake");
    const opened = reopen();
    insertStation(opened.store, CLOCK);
    insertStation(opened.store, CLOCK, STATION2, STATION2_ID);
    const adapter = createFakeTradeAdapter();
    const { journal, budgets, offers } = createRepos();
    const tx = (fn) => { const r = opened.store.transaction("test", fn); assert.ok(r.ok, JSON.stringify(r)); return r.value; };
    fundBudget(tx, budgets);
    clockNow = AT + 10000;
    const deps = { store: opened.store, journal, offers, adapter, config: makeConfig(), clock: CLOCK, telemetry: null, logger: { log: () => {} } };
    const stockOf = (stationId) => {
      const row = tx((db) => db.prepare("SELECT quantity FROM world_station_stock WHERE station_id = ? AND item_kind = 'mineral' AND item_key = 'type:34'").get(stationId));
      return row ? row.quantity : 0;
    };

    const a = openOfferAccepted(tx, offers, journal, "ti9a", AT, 919191, STATION2, STATION2_ID);
    adapter._addHangarStack(CORP, STATION2_ID, 9100, TYPE_ID, QUANTITY);
    const planA = await stepAccepted(deps, getOffer(tx, offers, a.offerId), { stationId: STATION2_ID, destroyed: false });
    assert.strictEqual(planA.action, "PLAN");
    tx((db) => db.prepare("UPDATE world_stations SET state = 'DESTROYED' WHERE station_id = ?").run(STATION2));
    const resA = await stepIntake(deps, getOffer(tx, offers, a.offerId));
    assert.deepStrictEqual(resA, { action: "LOST", reason: "STATION_GONE" });
    const offerA = getOffer(tx, offers, a.offerId);
    assert.strictEqual(offerA.state, "LOST");
    assert.strictEqual(offerA.endReason, "STATION_GONE", "reason from the deliver tx (was NOTHING_DELIVERED)");
    const outboxA = tx((db) => journal.findByKey(db, S.intakeOutboxKey(a.offerId)));
    assert.strictEqual(outboxA.entry.state, "APPLIED");
    assert.strictEqual(stockOf(STATION2), 0);

    const b = openOfferAccepted(tx, offers, journal, "ti9b", AT, 929292);
    adapter._addHangarStack(CORP, STATION_ID, 9200, TYPE_ID, QUANTITY);
    const planB = await stepAccepted(deps, getOffer(tx, offers, b.offerId), { stationId: STATION_ID, destroyed: false });
    assert.strictEqual(planB.action, "PLAN");
    const intakeSnapshot = getOffer(tx, offers, b.offerId);
    const first = await stepIntake(deps, intakeSnapshot);
    assert.deepStrictEqual(first, { action: "DELIVERED", deliveredQuantity: QUANTITY });
    const second = await stepIntake(deps, intakeSnapshot);
    assert.deepStrictEqual(second, { action: "STALE" });
    assert.strictEqual(stockOf(STATION), QUANTITY, "stock credited exactly once");
    const offerB = getOffer(tx, offers, b.offerId);
    assert.strictEqual(offerB.state, "DELIVERED");
    assert.strictEqual(offerB.deliveredQuantity, QUANTITY);
  }));

  test("TI5 config: trade.enabled default true, new keys in SCHEMA +.env.example, enabled=false → stub", () => {
    const { SCHEMA, LIMIT_KEYS, MODULE_NAMES, ENV_PREFIX } = require("../../config");
    const byKey = new Map(SCHEMA.map((row) => [row.key, row]));

    const enabledRow = byKey.get("trade.enabled");
    assert.ok(enabledRow, "trade.enabled in SCHEMA");
    assert.strictEqual(enabledRow.default, true, "trade.enabled default true");

    assert.ok(byKey.get("trade.maxIntakesPerPass"), "trade.maxIntakesPerPass in SCHEMA");
    assert.ok(byKey.get("trade.intakeGraceMs"), "trade.intakeGraceMs in SCHEMA");
    assert.ok(byKey.get("trade.maxOrphansPerPass"), "trade.maxOrphansPerPass in SCHEMA");

    const example = fs.readFileSync(path.join(MOD_DIR, ".env.example"), "utf8");
    assert.ok(example.includes("EVEJS_LNE_TRADE_ENABLED="), ".env.example: EVEJS_LNE_TRADE_ENABLED");
    for (const key of ["trade.maxIntakesPerPass", "trade.intakeGraceMs", "trade.maxOrphansPerPass"]) {
      const envName = byKey.get(key).env;
      assert.ok(envName.startsWith(`${ENV_PREFIX}TRADE_`), `${key} env ${envName} has the TRADE_ prefix`);
      assert.ok(example.includes(`${envName}=`), `.env.example: ${envName}`);
    }

    const resolved = config.resolveConfig({ modDir: MOD_DIR, env: {} });
    assert.strictEqual(resolved.config.trade.enabled, true, "trade.enabled true by default");
    assert.strictEqual(resolved.config.trade.maxIntakesPerPass, 2, "maxIntakesPerPass default 2");
    assert.strictEqual(resolved.config.trade.intakeGraceMs, 600000, "intakeGraceMs default 600000");
    assert.strictEqual(resolved.config.trade.maxOrphansPerPass, 2, "maxOrphansPerPass default 2");

    const disabled = config.resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_TRADE_ENABLED: "0" } });
    assert.strictEqual(disabled.config.trade.enabled, false, "trade.enabled=false");
    const { startTrade, createUnavailableTrade } = require("../../lib/economy/trade");
    const stub = createUnavailableTrade("TRADE_DISABLED", "disabled_by_config");
    assert.strictEqual(stub.getMode(), "off");
    assert.deepStrictEqual(stub.tradeReady({}, F, { npcStations: 3 }), { ready: false, reason: "TRADE_OFF", headroomIsk: 0 });
  });

  test("TI10 intake with a character issuer: stacks of (character, station, flag 4) voided with lne:trade:<id>:void:<itemId>, stock +qty, other station and NPC flag 62 untouched", () => H.withStore(driver, async (reopen) => {
    const opened = reopen();
    insertStation(opened.store, CLOCK);
    const adapter = createFakeTradeAdapter();
    const { journal, budgets, offers, priceCache } = createRepos();
    const tx = (fn) => { const r = opened.store.transaction("test", fn); assert.ok(r.ok, JSON.stringify(r)); return r.value; };
    fundBudget(tx, budgets);
    const offer = acceptCharacterOffer(tx, offers, "ti10", AT, 556001);
    const restore = advanceClock(10000);
    try {
      adapter._addHangarStack(VCHAR, STATION_ID, 2000, TYPE_ID, QUANTITY, 4);
      adapter._addHangarStack(VCHAR, STATION2_ID, 2001, TYPE_ID, 50, 4);
      adapter._addHangarStack(CORP, STATION_ID, 2002, TYPE_ID, QUANTITY, 62);
      const executor = createTradeExecutor({ store: opened.store, journal, offers, budgets, adapter,
        priceCache, config: makeConfig(), clock: CLOCK,
        getStations: () => ({ [STATION]: { stationId: STATION_ID, kind: "npc", ownerCorporationId: CORP, systemId: SYSTEM, destroyed: false, online: true } }),
        getGraph: () => null, mode: "run",
        getGovernor: () => ({ admits: () => true }), factionNames: new Map([[F, "Sansha"]]), telemetry: null,
        logger: { log: () => {} } });
      executor.start();
      await executor.runPass();
      executor.stop();

      const after = getOffer(tx, offers, offer.offerId);
      assert.deepStrictEqual([after.state, after.deliveredQuantity], ["DELIVERED", QUANTITY]);
      const stock = tx((db) => db.prepare("SELECT quantity FROM world_station_stock WHERE station_id = ? AND item_kind = 'mineral' AND item_key = 'type:34'").get(STATION));
      assert.strictEqual(stock.quantity, QUANTITY, "stock +quantity");
      assert.ok(adapter._state.receipts.has(S.voidKey(offer.offerId, 2000)), "void key of the character stack");
      assert.ok(!adapter._state.hangarStacks.get(VCHAR).get(STATION_ID).has(2000), "character stack at the station voided");
      assert.strictEqual(adapter._state.hangarStacks.get(VCHAR).get(STATION2_ID).get(2001).quantity, 50, "other station untouched");
      assert.strictEqual(adapter._state.hangarStacks.get(CORP).get(STATION_ID).get(2002).quantity, QUANTITY, "NPC flag 62 untouched");
      const plan = tx((db) => journal.findByKey(db, S.intakeOutboxKey(offer.offerId)));
      assert.deepStrictEqual([plan.entry.payload.ownerKind, plan.entry.payload.ownerId, plan.entry.payload.corporationId],
        ["character", VCHAR, VCORP], "plan frozen with the character owner");
    } finally {
      restore();
    }
  }));

  test("TO2 character orphans: owners include listIssuerCharacterIds, delete with ceoId = character, defund on the character wallet (whole ISK), NPC division untouched", () => H.withStore(driver, async (reopen) => {
    const opened = reopen();
    insertStation(opened.store, CLOCK);
    const adapter = createFakeTradeAdapter();
    const { journal, budgets, offers, priceCache } = createRepos();
    const tx = (fn) => { const r = opened.store.transaction("test", fn); assert.ok(r.ok, JSON.stringify(r)); return r.value; };
    fundBudget(tx, budgets);
    const S0 = 2000000;
    const CORP_S = 3000000;
    adapter._setWalletBalance(VCHAR, 1000, S0);
    adapter._setWalletBalance(CORP, 1006, CORP_S);

    const created = tx((db) => offers.createOfferInTx(db, makeOffer({ offerId: "to2a" }), "ik:to2a:offer:to2a:npc-1"));
    assert.ok(created.ok, JSON.stringify(created));
    const offerA = created.offer;
    const issuing = tx((db) => offers.transitionOfferInTx(db, { offerId: offerA.offerId, expectedVersion: 1, from: S.PLANNED,
      to: S.ISSUING, reason: "", at: AT, patch: { expiresAt: AT + 1000, issuerCharacterId: VCHAR, issuerCharacterCorpId: VCORP } },
      S.transitionKey(offerA.offerId, 1, S.ISSUING)));
    assert.ok(issuing.ok, JSON.stringify(issuing));
    tx((db) => offers.transitionOfferInTx(db, { offerId: offerA.offerId, expectedVersion: 2, from: S.ISSUING, to: S.CANCELLED,
      reason: "ISSUE_FAILED", at: AT }, S.transitionKey(offerA.offerId, 2, S.CANCELLED)));
    const TAG_B = "to2b-lost";
    const REWARD_B = 5000.5;

    const record = (contractId, offerId, reward) => ({
      contractId, offerId, corporationId: VCORP, issuerOwnerId: VCHAR, status: "OUTSTANDING", createdAt: Date.now(),
      payload: { info: { description: `[LNE:${offerId}] dup`, reward, forCorp: false },
        session: { characterID: VCHAR, corporationID: VCORP } },
      escrowIsk: reward, walletRef: { kind: "character", ownerId: VCHAR, accountKey: 1000 },
    });
    adapter._state.contracts.set(710001, record(710001, offerA.offerId, offerA.iskTotal));
    adapter._state.contracts.set(710002, record(710002, TAG_B, REWARD_B));
    const deletes = [];
    const origDelete = adapter.tradeDeleteContract;
    adapter.tradeDeleteContract = (spec) => { deletes.push(spec); return origDelete.call(adapter, spec); };
    const walletSpecs = [];
    const origWallet = adapter.tradeAdjustWallet;
    adapter.tradeAdjustWallet = (spec) => { walletSpecs.push(spec); return origWallet.call(adapter, spec); };

    const executor = createTradeExecutor({ store: opened.store, journal, offers, budgets, adapter, priceCache,
      config: makeConfig(), clock: CLOCK,
      getStations: () => new Map([[STATION, { stationId: STATION_ID, kind: "npc", ownerCorporationId: CORP, systemId: SYSTEM, destroyed: false, online: true }]]),
      getGraph: () => null, mode: "run",
      getGovernor: () => ({ admits: () => true }), factionNames: new Map([[F, "Sansha"]]), telemetry: null,
      logger: { log: () => {} } });
    executor.start();
    await executor.runPass();
    executor.stop();

    assert.strictEqual(adapter._state.contracts.size, 0, "both character orphans deleted");
    assert.deepStrictEqual(deletes.map((d) => [d.contractId, d.ceoId]), [[710001, VCHAR], [710002, VCHAR]], "ceoId = the character");
    assert.deepStrictEqual(walletSpecs.map((s) => [s.ownerKind, s.ownerId, s.accountKey, s.deltaIsk, s.commandId]), [
      ["character", VCHAR, 1000, -offerA.iskTotal, S.walletCommandId(offerA.offerId, "defund")],
      ["character", VCHAR, 1000, -5000, S.walletCommandId(TAG_B, "defund")],
    ], "defund on the character wallet, whole ISK");
    assert.strictEqual(adapter._balance(VCHAR, 1000), S0 + 0.5, "escrows back, defunds of R_a and floor(R_b)");
    assert.strictEqual(adapter._balance(CORP, 1006), CORP_S, "NPC division untouched");
  }));

  test("TO3 corporate orphans with the real stations facade: registry corporations after a reset (no offers), offer issuers for a lost offer, live offer contract untouched", () => H.withStore(driver, async (reopen) => {
    const opened = reopen();
    insertStation(opened.store, CLOCK);
    const built = createFactionRegistry(REGISTRY_DATA_V1, { hullGroups: HULL_GROUPS, fleetRoles: FLEET_ROLES,
      operationTypes: OPERATION_TYPES, hostility: createHostility(), maxFactions: 64, maxCampaignSystems: 40,
      maxShipsPerFleet: 500, maxCompositionEntries: 32, maxResourceUnits: 1000000000 });
    assert.ok(built.ok, JSON.stringify(built));
    const registry = built.registry;
    const npcStart = registry.listFactions().flatMap((f) => f.startStations || []).find((s) => s.kind === "npc");
    assert.ok(npcStart, "the registry has an NPC start station");
    const RCORP = npcStart.corporationId;
    assert.notStrictEqual(RCORP, CORP, "CORP is not a registry corporation");
    const facade = Object.freeze({ getStatus: () => ({ state: "running" }), getMode: () => "ready",
      getStation: () => ({ ok: true, record: null }), listStationsInSystem: () => ({ ok: true, records: [] }) });
    const adapter = createFakeTradeAdapter();
    const { journal, budgets, offers, priceCache } = createRepos();
    const tx = (fn) => { const r = opened.store.transaction("test", fn); assert.ok(r.ok, JSON.stringify(r)); return r.value; };
    fundBudget(tx, budgets);
    adapter._setWalletBalance(RCORP, 1006, 10000000);
    adapter._setWalletBalance(CORP, 1006, 10000000);
    const contract = (contractId, offerId, corporationId) => ({ contractId, offerId, corporationId, status: "OUTSTANDING",
      payload: { info: { description: `[LNE:${offerId}] buy order`, reward: 5000 }, session: {} }, createdAt: Date.now() });
    adapter._state.contracts.set(810001, contract(810001, "reset-gone-1", RCORP));
    adapter._state.contracts.set(810002, contract(810002, "lost-1", CORP));
    const run = async (getRegistry) => {
      const ex = createTradeExecutor({ store: opened.store, journal, offers, budgets, adapter, priceCache,
        config: makeConfig(), clock: CLOCK, getStations: () => facade, getGraph: () => null, mode: "run",
        getGovernor: () => ({ admits: () => true }), factionNames: new Map([[F, "Sansha"]]), telemetry: null,
        logger: { log: () => {} }, ...(getRegistry ? { getRegistry } : {}) });
      ex.start();
      await ex.runPass();
      ex.stop();
    };

    await run(null);
    assert.deepStrictEqual([...adapter._state.contracts.keys()].sort(), [810001, 810002], "facade alone finds nothing");

    await run(() => registry);
    assert.deepStrictEqual([...adapter._state.contracts.keys()].sort(), [810002], "registry orphan deleted after reset");

    const created = tx((db) => offers.createOfferInTx(db, makeOffer({ offerId: "to3-live" }), "ik:to3-live:offer:to3-live:npc-1"));
    assert.ok(created.ok, JSON.stringify(created));
    const liveId = created.offer.offerId;
    const step = (spec, seq, to) => {
      const t = tx((db) => offers.transitionOfferInTx(db, { offerId: liveId, reason: "", to, ...spec }, S.transitionKey(liveId, seq, to)));
      assert.ok(t.ok, JSON.stringify(t));
    };
    step({ expectedVersion: 1, from: S.PLANNED, at: AT, patch: { expiresAt: AT + 259200000 } }, 1, S.ISSUING);
    step({ expectedVersion: 2, from: S.ISSUING, at: AT + 1000, patch: { contractId: 810003 } }, 2, S.OPEN);
    adapter._state.contracts.set(810003, { ...contract(810003, liveId, CORP),
      payload: { info: { description: `[LNE:${liveId}] buy order`, reward: created.offer.iskTotal }, session: {} } });
    assert.deepStrictEqual(tx((db) => offers.listIssuerCorporationIds(db, 64)), { ok: true, corporationIds: [CORP] });
    await run(() => registry);
    assert.deepStrictEqual([...adapter._state.contracts.keys()].sort(), [810003], "lost-offer orphan deleted, live kept");
    assert.strictEqual(getOffer(tx, offers, liveId).state, S.OPEN, "live offer unchanged");
  }));

  test("TO4 offer read fails or store closes mid-scan -> live offer's contract stays, no delete/defund, deferred", () => H.withStore(driver, async (reopen) => {
    const opened = reopen();
    insertStation(opened.store, CLOCK);
    const env = orphanEnv(opened);
    const liveId = openLiveOffer(env.tx, env.offers, 820002);
    env.adapter._state.contracts.set(820002, env.contract(820002, liveId));

    const failing = Object.freeze({ ...env.offers, getOffer: () => ({ ok: false, reason: "TX_FAILED" }) });
    const resA = await runOrphanScan(env.deps({ offers: failing }), true, 0);
    assert.deepStrictEqual([resA.deferred, resA.errors >= 1, resA.deleted, resA.nextCursor], [true, true, 0, 0], JSON.stringify(resA));
    assert.deepStrictEqual([env.deletes.length, env.wallets.length], [0, 0], "no delete, no defund");
    assert.ok(env.adapter._state.contracts.has(820002), "live offer's contract stays");

    env.adapter._state.contracts.set(820001, env.contract(820001, "to4-gone"));
    env.onWallet = () => opened.store.close();
    const resB = await runOrphanScan(env.deps(), true, 0);
    assert.deepStrictEqual([resB.deferred, resB.deleted, resB.nextCursor], [true, 1, 820001], JSON.stringify(resB));
    assert.deepStrictEqual(env.deletes.map((d) => d.contractId), [820001], "only the orphan before the close is deleted");
    assert.ok(env.adapter._state.contracts.has(820002), "live offer's contract stays after the close");

    const resC = await runOrphanScan({ ...env.deps(), store: { ...opened.store, getState: () => "open" }, isStopped: () => true }, true, 0);
    assert.deepStrictEqual([resC.deferred, resC.processed, resC.deleted], [true, 0, 0], JSON.stringify(resC));
  }));

  test("TO5 full scan deletes at most maxOrphansPerPass per pass, the cursor finishes it, live contract kept", () => H.withStore(driver, async (reopen) => {
    const opened = reopen();
    insertStation(opened.store, CLOCK);
    const env = orphanEnv(opened);
    const liveId = openLiveOffer(env.tx, env.offers, 830002);
    env.adapter._state.contracts.set(830001, env.contract(830001, "to5-a"));
    env.adapter._state.contracts.set(830002, env.contract(830002, liveId));
    env.adapter._state.contracts.set(830003, env.contract(830003, "to5-b"));
    env.adapter._state.contracts.set(830004, env.contract(830004, "to5-c"));
    const res1 = await runOrphanScan(env.deps(), true, 0);
    assert.deepStrictEqual([res1.deleted, res1.deferred, res1.nextCursor], [2, true, 830003], JSON.stringify(res1));
    assert.deepStrictEqual([...env.adapter._state.contracts.keys()].sort(), [830002, 830004]);
    const res2 = await runOrphanScan(env.deps(), true, res1.nextCursor);
    assert.deepStrictEqual([res2.deleted, res2.deferred, res2.nextCursor], [1, undefined, 0], JSON.stringify(res2));
    assert.deepStrictEqual([...env.adapter._state.contracts.keys()], [830002], "live offer's contract kept");
    assert.strictEqual(env.wallets.length, 3, "one defund per deleted orphan");
  }));
};

const VCHAR = 90000123;
const VCORP = 98000001;

function orphanEnv(opened) {
  const adapter = createFakeTradeAdapter();
  const { journal, budgets, offers } = createRepos();
  const tx = (fn) => { const r = opened.store.transaction("test", fn); assert.ok(r.ok, JSON.stringify(r)); return r.value; };
  fundBudget(tx, budgets);
  adapter._setWalletBalance(CORP, 1006, 10000000);
  const env = { adapter, offers, tx, deletes: [], wallets: [], onWallet: null };
  const origDelete = adapter.tradeDeleteContract;
  adapter.tradeDeleteContract = (spec) => { env.deletes.push(spec); return origDelete.call(adapter, spec); };
  const origWallet = adapter.tradeAdjustWallet;
  adapter.tradeAdjustWallet = async (spec) => {
    env.wallets.push(spec);
    const r = await origWallet.call(adapter, spec);
    if (env.onWallet) env.onWallet();
    return r;
  };
  const facade = Object.freeze({ getStatus: () => ({ state: "running" }), getMode: () => "ready",
    getStation: () => ({ ok: true, record: null }), listStationsInSystem: () => ({ ok: true, records: [] }) });
  env.contract = (contractId, offerId) => ({ contractId, offerId, corporationId: CORP, status: "OUTSTANDING",
    payload: { info: { description: `[LNE:${offerId}] buy order`, reward: 5000 }, session: {} }, createdAt: Date.now() });
  env.deps = (over = {}) => ({ store: opened.store, journal, offers, adapter, config: makeConfig(), clock: CLOCK,
    telemetry: null, logger: { log: () => {} }, getStations: () => facade, getGovernor: null, getRegistry: null, ...over });
  return env;
}

function openLiveOffer(tx, offers, contractId) {
  const created = tx((db) => offers.createOfferInTx(db, makeOffer(), `ik:live-${contractId}:offer:${STATION}`));
  assert.ok(created.ok, JSON.stringify(created));
  const id = created.offer.offerId;
  const t1 = tx((db) => offers.transitionOfferInTx(db, { offerId: id, expectedVersion: 1, from: S.PLANNED, to: S.ISSUING,
    reason: "", at: AT, patch: { expiresAt: AT + 259200000 } }, S.transitionKey(id, 1, S.ISSUING)));
  assert.ok(t1.ok, JSON.stringify(t1));
  const t2 = tx((db) => offers.transitionOfferInTx(db, { offerId: id, expectedVersion: 2, from: S.ISSUING, to: S.OPEN,
    reason: "", at: AT + 1000, patch: { contractId } }, S.transitionKey(id, 2, S.OPEN)));
  assert.ok(t2.ok, JSON.stringify(t2));
  return id;
}

function acceptCharacterOffer(tx, offers, offerId, now, contractId) {
  const r = tx((db) => offers.createOfferInTx(db, makeOffer({ offerId }), `ik:${offerId}:offer:${offerId}:${STATION}`));
  assert.ok(r.ok && !r.duplicate, `create offer ${offerId}`);
  const step = (from, to, version, seq, patch, at) => {
    const t = tx((db) => offers.transitionOfferInTx(db, { offerId: r.offer.offerId, expectedVersion: version, from, to,
      reason: "", at, patch }, S.transitionKey(r.offer.offerId, seq, to)));
    assert.ok(t.ok, `${from}->${to} ${JSON.stringify(t)}`);
    return t.offer;
  };
  step(S.PLANNED, S.ISSUING, 1, 1, { expiresAt: now + makeConfig().trade.contractTtlMs, issuerCharacterId: VCHAR,
    issuerCharacterCorpId: VCORP }, now);
  step(S.ISSUING, S.OPEN, 2, 2, { contractId }, now + 1000);
  return step(S.OPEN, S.ACCEPTED, 3, 3, { acceptorCharacterId: 999 }, now + 2000);
}