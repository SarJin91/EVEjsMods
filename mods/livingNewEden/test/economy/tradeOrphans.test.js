"use strict";

const assert = require("node:assert");

const { createJournal } = require("../../lib/persistence/journal");
const { createBudgetRepository } = require("../../lib/economy/trade/budgetRepository");
const { createOfferRepository } = require("../../lib/economy/trade/offerRepository");
const { createTradeExecutor } = require("../../lib/economy/trade/tradeExecutor");
const { createFakeTradeAdapter } = require("../_support/fakeTradeAdapter");
const { harness: H } = require("../battle/settlement.test");
const S = require("../../lib/economy/trade/schema");


const F = 500019;
const CORP = 999999;
const CHAR_ISSUER = 888888;
const SYSTEM = 30000001;
const TYPE_ID = 34;
const QUANTITY = 1000;
const AT = 1000000;
const STATIONS = [["to-st-1", 60004001]];
let clockNow = AT;
const CLOCK = { now: () => clockNow };
let idCounter = 0;
const IDS = { next: (p) => `${p}_${++idCounter}` };

function insertStation(store, stationId, npcStationId) {
  const r = store.transaction("test.insertStation", (db) => db.prepare(`
    INSERT INTO world_stations (station_id, kind, npc_station_id, type_id, structure_family, system_id,
      owner_faction_id, owner_corporation_id, state, state_until_at, name, position_json, origin,
      evejs_item_id, destroyed_at, created_at, updated_at, version)
    VALUES (?, 'npc', ?, 35834, 'Sansha', ?, ?, ?, 'ONLINE', NULL, 'TO Station', '{"x":0,"y":0,"z":0}', 'seed',
      NULL, NULL, ?, ?, 1)`).run(stationId, npcStationId, SYSTEM, F, CORP, AT, AT));
  assert.ok(r.ok, JSON.stringify(r));
}

function makeConfig(trade = {}, extra = {}) {
  return {
    trade: {
      enabled: true, contractsEnabled: true, cleanupOnDisable: false, walletAccountKey: 1006,
      contractTtlMs: 259200000, executorPollMs: 60000, maxIssuesPerPass: 2, maxPollsPerPass: 16,
      maxClosesPerPass: 4, issueTimeoutMs: 1800000, priceRegionId: 10000002, maxPriceRegions: 8,
      priceRefreshMs: 1800000, maxIntakesPerPass: 2, intakeGraceMs: 600000, maxOrphansPerPass: 2,
      intakeMaxRetries: 100, virtualIssuers: false, ...trade,
    },
    ...extra,
  };
}

function setup(opened) {
  const journal = createJournal({ clock: CLOCK, maxPayloadBytes: 16384, maxRows: 500 });
  const budgets = createBudgetRepository({ journal, clock: CLOCK });
  const offers = createOfferRepository({ journal, budgets, ids: IDS, clock: CLOCK });
  const tx = (fn) => { const r = opened.store.transaction("test", fn); assert.ok(r.ok, JSON.stringify(r)); return r.value; };
  tx((db) => budgets.fundInTx(db, { factionId: F, units: 100000, paidUntilTo: AT, iskPerUnit: 1000,
    capIsk: 1000000000, at: AT }, "fund:1"));
  return { journal, budgets, offers, tx };
}

function createOffer(tx, offers, offerId, stationId, issuerCharacterId = null) {
  const spec = {
    offerId, factionId: F, stationId, systemId: SYSTEM, issuerCorporationId: CORP, itemKind: "mineral",
    itemKey: "type:34", typeId: TYPE_ID, quantity: QUANTITY, unitPriceMilli: 1100, iskTotal: QUANTITY * 1100,
    refPriceMilli: 1000, capPriceMilli: 1960, priceSource: "bid", state: "PLANNED", stateSeq: 0, endReason: null,
    contractId: null, acceptorCharacterId: null, deliveredQuantity: 0, createdAt: AT, expiresAt: AT + 259200000,
    updatedAt: AT, endedAt: null, version: 1, at: AT,
    issuerCharacterId,
  };
  const r = tx((db) => offers.createOfferInTx(db, spec, `ik:${offerId}:offer:${offerId}:${stationId}`));
  assert.ok(r.ok && !r.duplicate, `create offer ${offerId}`);
  return r.offer;
}

function step(tx, offers, offerId, from, to, version, patch) {
  const r = tx((db) => offers.transitionOfferInTx(db, { offerId, expectedVersion: version, from, to, reason: "",
    at: AT + version * 1000, ...(patch ? { patch } : {}) }, S.transitionKey(offerId, version, to)));
  assert.ok(r.ok, JSON.stringify(r));
}

function toIssuing(tx, offers, seed, stationId, issuerCharacterId = null) {
  const offerId = createOffer(tx, offers, seed, stationId, issuerCharacterId).offerId;
  const patch = { expiresAt: AT + 259200000 };
  if (issuerCharacterId) {
    patch.issuerCharacterId = issuerCharacterId;
    patch.issuerCharacterCorpId = CORP;
  }
  step(tx, offers, offerId, S.PLANNED, S.ISSUING, 1, patch);
  return offerId;
}

function executorOf(opened, env, cfg, extra = {}) {
  return createTradeExecutor({ store: opened.store, journal: env.journal, offers: env.offers, budgets: env.budgets,
    adapter: env.adapter, priceCache: { put() {}, peek() { return null; } }, config: cfg, clock: CLOCK,
    getStations: () => new Map([[STATIONS[0][0], { stationId: STATIONS[0][1], kind: "npc", ownerCorporationId: CORP,
      systemId: SYSTEM, destroyed: false, online: true }]]),
    getGraph: () => null, mode: "run", getGovernor: () => ({ admits: () => true }),
    factionNames: new Map([[F, "Sansha"]]), telemetry: null, logger: { log() {} }, ...extra });
}

function tagged(adapter, contractId, offerId, issuerOwnerId, issuerWallet = { kind: "character", ownerId: CHAR_ISSUER, accountKey: 1000 }, session = { characterID: CHAR_ISSUER }) {
  adapter._state.contracts.set(contractId, {
    contractId,
    offerId,
    corporationId: CORP,
    issuerOwnerId,
    status: "OUTSTANDING",
    payload: { info: { description: `[LNE:${offerId}] orphan`, reward: 5000, forCorp: false, session }, session },
    createdAt: 0,
    escrowIsk: 5000,
    walletRef: issuerWallet,
  });
}

module.exports = ({ test }) => {
  const driver = H.loadDriver();

  test("TO1 character issuer orphan (virtualIssuers=false) -> delete + defund to character wallet 1000", () => H.withStore(driver, async (reopen) => {
    const opened = reopen();
    insertStation(opened.store, STATIONS[0][0], STATIONS[0][1]);
    const env = setup(opened);
    env.adapter = createFakeTradeAdapter();
    const cfg = makeConfig({ virtualIssuers: false });
    env.deps = { store: opened.store, journal: env.journal, offers: env.offers, adapter: env.adapter,
      config: cfg, clock: CLOCK, telemetry: null, logger: { log() {} } };
    const ex = executorOf(opened, env, cfg);
    const offerId = toIssuing(env.tx, env.offers, "to1-char", STATIONS[0][0], CHAR_ISSUER);
    env.tx((db) => env.offers.transitionOfferInTx(db, { offerId, expectedVersion: 1, from: S.ISSUING, to: S.OPEN, reason: "",
      at: AT + 2000, patch: { contractId: 100001 } }, S.transitionKey(offerId, 2, S.OPEN)));
    tagged(env.adapter, 100002, "to1-gone", CHAR_ISSUER, { kind: "character", ownerId: CHAR_ISSUER, accountKey: 1000 }, { characterID: CHAR_ISSUER });
    env.adapter._setWalletBalance(CHAR_ISSUER, 1000, 2000000);
    
    const adjustCalls = [];
    const originalAdjustWallet = env.adapter.tradeAdjustWallet.bind(env.adapter);
    env.adapter.tradeAdjustWallet = async (spec) => {
      adjustCalls.push({ ...spec });
      return originalAdjustWallet(spec);
    };
    
    await ex.runPass();
    await ex.runPass();
    
    assert.ok(!env.adapter._state.contracts.has(100002), "orphan contract deleted");
    
    const defundCalls = adjustCalls.filter(c => c.commandId && c.commandId.endsWith(":defund") && c.deltaIsk < 0);
    assert.strictEqual(defundCalls.length, 1, "exactly one defund call");
    const defund = defundCalls[0];
    assert.strictEqual(defund.ownerKind, S.ISSUER_KIND_CHARACTER, "ownerKind character");
    assert.strictEqual(defund.ownerId, CHAR_ISSUER, "ownerId CHAR_ISSUER");
    assert.strictEqual(defund.accountKey, S.CHARACTER_ACCOUNT_KEY, "accountKey 1000");
    assert.ok(defund.deltaIsk < 0, "deltaIsk negative (defund)");
    
    const corpDefundCalls = adjustCalls.filter(c => c.commandId && c.commandId.endsWith(":defund") && c.deltaIsk < 0 && c.ownerKind === S.ISSUER_KIND_CORPORATION);
    assert.strictEqual(corpDefundCalls.length, 0, "no corporation defund for this orphan");
    
    ex.stop();
  }));

  test("TO2 character issuer orphan waits when seams unavailable", () => H.withStore(driver, async (reopen) => {
    const opened = reopen();
    insertStation(opened.store, STATIONS[0][0], STATIONS[0][1]);
    const env = setup(opened);
    env.adapter = createFakeTradeAdapter();
    const cfg = makeConfig({ virtualIssuers: false });
    env.adapter.tradeVirtualIssuerSeams = () => ({ ok: false });
    env.deps = { store: opened.store, journal: env.journal, offers: env.offers, adapter: env.adapter,
      config: cfg, clock: CLOCK, telemetry: null, logger: { log() {} } };
    const ex = executorOf(opened, env, cfg);
    const offerId = toIssuing(env.tx, env.offers, "to2-char", STATIONS[0][0], CHAR_ISSUER);
    env.tx((db) => env.offers.transitionOfferInTx(db, { offerId, expectedVersion: 1, from: S.ISSUING, to: S.OPEN, reason: "",
      at: AT + 2000, patch: { contractId: 100003 } }, S.transitionKey(offerId, 2, S.OPEN)));
    tagged(env.adapter, 100004, "to2-gone", CHAR_ISSUER, { kind: "character", ownerId: CHAR_ISSUER, accountKey: 1000 }, { characterID: CHAR_ISSUER });
    
    const adjustCalls = [];
    const originalAdjustWallet = env.adapter.tradeAdjustWallet.bind(env.adapter);
    env.adapter.tradeAdjustWallet = async (spec) => {
      adjustCalls.push({ ...spec });
      return originalAdjustWallet(spec);
    };
    
    await ex.runPass();
    await ex.runPass();
    
    assert.ok(env.adapter._state.contracts.has(100004), "orphan contract waits for seams");
    
    const defundCalls = adjustCalls.filter(c => c.commandId && c.commandId.endsWith(":defund") && c.deltaIsk < 0);
    assert.strictEqual(defundCalls.length, 0, "no defund call while seams unavailable");
    
    env.adapter.tradeVirtualIssuerSeams = () => ({ ok: true });
    adjustCalls.length = 0;
    await ex.runPass();
    
    assert.ok(!env.adapter._state.contracts.has(100004), "orphan contract deleted after seams restored (retry)");
    
    const defundCallsAfter = adjustCalls.filter(c => c.commandId && c.commandId.endsWith(":defund") && c.deltaIsk < 0);
    assert.strictEqual(defundCallsAfter.length, 1, "exactly one defund call after seams restored");
    const defund = defundCallsAfter[0];
    assert.strictEqual(defund.ownerKind, S.ISSUER_KIND_CHARACTER, "ownerKind character");
    assert.strictEqual(defund.ownerId, CHAR_ISSUER, "ownerId CHAR_ISSUER");
    assert.strictEqual(defund.accountKey, S.CHARACTER_ACCOUNT_KEY, "accountKey 1000");
    assert.ok(defund.deltaIsk < 0, "deltaIsk negative (defund)");
    
    ex.stop();
  }));
};