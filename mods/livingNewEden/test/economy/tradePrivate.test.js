"use strict";

const assert = require("node:assert");
const { createJournal } = require("../../lib/persistence/journal");
const { openStore } = require("../../lib/persistence/store");
const { LATEST_SCHEMA_VERSION, MIGRATIONS, runMigrations } = require("../../lib/persistence/migrations");
const { createBudgetRepository } = require("../../lib/economy/trade/budgetRepository");
const { createOfferRepository } = require("../../lib/economy/trade/offerRepository");
const { createTradeExecutor } = require("../../lib/economy/trade/tradeExecutor");
const { createPrivateContract, listPrivateContracts, rejectPrivateContract, expirePrivateContracts, cleanupRejected } = require("../../lib/economy/trade/privateContracts");
const { createFakeTradeAdapter } = require("../_support/fakeTradeAdapter");
const { buildWantToBuyCall } = require("../../lib/adapter/tradeContracts");
const { buildIssuePayload, fundIskOf } = require("../../lib/economy/trade/executorRules");
const { harness: H } = require("../battle/settlement.test");
const S = require("../../lib/economy/trade/schema");
const { createAdapter } = require("../../lib/adapter/index");
const { GAME_MODULES } = require("../../lib/adapter/gameModules");

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
    assigneeCharacterId: null,
    standingBonusPermille: 0,
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
    contractTtlMs: 259200000, privateOfferTtlMs: 86400000, standingThreshold: 5.0,
    executorPollMs: 60000, maxIssuesPerPass: 2,
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

function createExecutor({ store, journal, offers, budgets, adapter, priceCache, config, getStations, getGraph, telemetry, mode = "run" }) {
  const cfg = config || makeConfig();
  const pc = priceCache || { put() {}, peek() { return null; }, getStatus() { return { entries: 0, source: "none", newestAt: null }; } };
  return createTradeExecutor({
    store, journal, offers, budgets,
    getStations: () => getStations || { [STATION]: { stationId: STATION_ID, kind: "npc", ownerCorporationId: CORP, systemId: SYSTEM, destroyed: false } },
    getGraph: () => getGraph || null, adapter, priceCache: pc, config: cfg, clock: CLOCK,
    mode, getGovernor: () => ({ admits: () => true }),
    factionNames: new Map([[F, "Sansha"]]), telemetry: telemetry || null,
    logger: { log: () => {} },
  });
}

function fundBudget(tx, budgets) {
  tx((db) => budgets.fundInTx(db, { factionId: F, units: 100, paidUntilTo: AT, iskPerUnit: 1000, capIsk: 1000000, at: AT }, "fund:1"));
}

const offerKey = (offerId) => `ik:${offerId}:offer:${offerId}:${STATION}`;

function createOffer(tx, offers, offerId, overrides = {}) {
  const offerSpec = makeOffer({ offerId, ...overrides });
  const r = tx((db) => offers.createOfferInTx(db, offerSpec, offerKey(offerId)));
  assert.ok(r.ok && !r.duplicate, `create offer ${offerId}: ${JSON.stringify(r)}`);
  return r.offer;
}

function acceptOffer(tx, offers, offer, contractId, acceptorCharacterId, at) {
  const step = (from, to, seq, version, patch) => {
    const r = tx((db) => offers.transitionOfferInTx(db, { offerId: offer.offerId, expectedVersion: version, from, to,
      reason: "", at, patch }, S.transitionKey(offer.offerId, seq, to)));
    assert.ok(r.ok, `${from}->${to} ${JSON.stringify(r)}`);
    return r.offer;
  };
  const issuing = step(S.PLANNED, S.ISSUING, 1, offer.version, { expiresAt: at + 259200000 });
  const open = step(S.ISSUING, S.OPEN, 2, issuing.version, { contractId });
  return step(S.OPEN, S.ACCEPTED, 3, open.version, { acceptorCharacterId });
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

  needsDriver("TP1a migration: fresh DB → schema 28 has assignee_character_id, standing_bonus_permille, supplier index", () => H.withStore(driver, async (reopen) => {
    const opened = reopen();
    const tx = (fn) => { const r = opened.store.transaction("test", fn); assert.ok(r.ok, JSON.stringify(r)); return r.value; };
    tx((db) => {
      const cols = db.prepare("PRAGMA table_info(world_trade_offers)").all().map(c => c.name);
      assert.ok(cols.includes("assignee_character_id"), "assignee_character_id column exists");
      assert.ok(cols.includes("standing_bonus_permille"), "standing_bonus_permille column exists");
      const idxs = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='world_trade_offers'").all().map(r => r.name);
      assert.ok(idxs.some(n => n.includes("supplier")), "supplier index exists");
    });
  }));

  needsDriver("TP1b migration: 27 → 28 adds columns with NULL/0 defaults, no data change", () => H.withStore(driver, async (reopen) => {
    const opened = reopen();
    const tx = (fn) => { const r = opened.store.transaction("test", fn); assert.ok(r.ok, JSON.stringify(r)); return r.value; };
    tx((db) => {
      const cols = db.prepare("PRAGMA table_info(world_trade_offers)").all().map(c => c.name);
      assert.ok(cols.includes("assignee_character_id"), "assignee_character_id column exists");
      assert.ok(cols.includes("standing_bonus_permille"), "standing_bonus_permille column exists");
      const sql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='world_trade_offers'").get();
      assert.ok(sql.sql.includes("assignee_character_id IS NULL OR assignee_character_id > 0"), "CHECK assignee > 0");
      assert.ok(sql.sql.includes("standing_bonus_permille BETWEEN 0 AND 1000"), "CHECK bonus 0..1000");
    });
  }));

  needsDriver("TP1c repo: createOfferInTx assignee null + bonus > 0 → TRADE_INVALID_INPUT", () => H.withStore(driver, async (reopen) => {
    const opened = reopen();
    insertStation(opened.store, CLOCK);
    const { journal, budgets, offers } = createRepos();
    const tx = (fn) => { const r = opened.store.transaction("test", fn); assert.ok(r.ok, JSON.stringify(r)); return r.value; };
    fundBudget(tx, budgets);
    const r = tx((db) => offers.createOfferInTx(db, makeOffer({ assigneeCharacterId: null, standingBonusPermille: 100 }), "ik:test:offer"));
    assert.ok(!r.ok);
    assert.strictEqual(r.reason, "TRADE_INVALID_INPUT");
    assert.ok(r.detail.includes("assignee_null_bonus_positive"), "detail mentions invariant");
  }));

  needsDriver("TP1d repo: public offer TRADE_OFFER_CREATED payload unchanged (no new keys)", () => H.withStore(driver, async (reopen) => {
    const opened = reopen();
    insertStation(opened.store, CLOCK);
    const { journal, budgets, offers } = createRepos();
    const tx = (fn) => { const r = opened.store.transaction("test", fn); assert.ok(r.ok, JSON.stringify(r)); return r.value; };
    fundBudget(tx, budgets);
    const offer = createOffer(tx, offers, "tp1d");
    const journalEntry = tx((db) => journal.findByKey(db, offerKey("tp1d")));
    assert.ok(journalEntry.ok && journalEntry.found);
    assert.strictEqual(journalEntry.entry.aggregateId, offer.offerId);
    const payload = journalEntry.entry.payload;
    const replay = tx((db) => offers.createOfferInTx(db, makeOffer({ offerId: "tp1d" }), offerKey("tp1d")));
    assert.ok(replay.ok && replay.duplicate && replay.offer && replay.offer.offerId === offer.offerId, JSON.stringify(replay));
    assert.ok(!("assigneeCharacterId" in payload), "no assigneeCharacterId in public payload");
    assert.ok(!("standingBonusPermille" in payload), "no standingBonusPermille in public payload");
    const expectedKeys = ["factionId", "stationId", "itemKey", "quantity", "unitPriceMilli", "iskTotal", "expiresAt"].sort();
    assert.deepStrictEqual(Object.keys(payload).sort(), expectedKeys, "payload keys match pre-25b");
  }));

  needsDriver("TP1e repo: listSuppliers returns correct order (lastAt desc) with since/limit", () => H.withStore(driver, async (reopen) => {
    const opened = reopen();
    insertStation(opened.store, CLOCK);
    const { journal, budgets, offers } = createRepos();
    const tx = (fn) => { const r = opened.store.transaction("test", fn); assert.ok(r.ok, JSON.stringify(r)); return r.value; };
    fundBudget(tx, budgets);
    const now = CLOCK.now();
    for (let i = 1; i <= 3; i++) {
      const offer = createOffer(tx, offers, `sup${i}`, { itemKey: `type:${33 + i}`, typeId: 33 + i });
      acceptOffer(tx, offers, offer, 500000 + i, 100 + i, now + i * 1000);
    }
    const res = tx((db) => offers.listSuppliers(db, F, { since: now, limit: 2 }));
    assert.ok(res.ok, JSON.stringify(res));
    assert.strictEqual(res.suppliers.length, 2, "limit works");
    assert.ok(res.suppliers[0].lastAt > res.suppliers[1].lastAt, "ordered by lastAt desc");
    assert.strictEqual(res.suppliers[0].characterId, 103, "most recent first");
    assert.strictEqual(res.suppliers[1].characterId, 102, "second most recent");
    assert.deepStrictEqual(res.suppliers[0], { characterId: 103, deliveries: 1, lastAt: now + 3000 });
    const late = tx((db) => offers.listSuppliers(db, F, { since: now + 2500, limit: 10 }));
    assert.deepStrictEqual(late.suppliers.map((s) => s.characterId), [103], "since cuts older deliveries");
    const other = tx((db) => offers.listSuppliers(db, 500020, { since: now, limit: 10 }));
    assert.deepStrictEqual(other.suppliers, [], "other faction");
  }));

  needsDriver("TP1f repo: lastRejectedAt respects window, other faction, other character", () => H.withStore(driver, async (reopen) => {
    const opened = reopen();
    insertStation(opened.store, CLOCK);
    const { journal, budgets, offers } = createRepos();
    const tx = (fn) => { const r = opened.store.transaction("test", fn); assert.ok(r.ok, JSON.stringify(r)); return r.value; };
    fundBudget(tx, budgets);
    const now = CLOCK.now();
    const offer = createOffer(tx, offers, "rej1", { assigneeCharacterId: 999, standingBonusPermille: 100 });
    const cancelled = tx((db) => offers.transitionOfferInTx(db, {
      offerId: offer.offerId, expectedVersion: 1, from: S.PLANNED, to: S.CANCELLED, reason: S.END_REASON_REJECTED, at: now,
    }, S.transitionKey(offer.offerId, 1, S.CANCELLED)));
    assert.ok(cancelled.ok && cancelled.offer.endReason === "REJECTED", JSON.stringify(cancelled));
    const res1 = tx((db) => offers.lastRejectedAt(db, F, 999, now - 10000));
    assert.ok(res1.ok);
    assert.strictEqual(res1.at, now, "found rejection in window");
    const res2 = tx((db) => offers.lastRejectedAt(db, F, 999, now + 10000));
    assert.ok(res2.ok);
    assert.strictEqual(res2.at, null, "no rejection in future window");
    const res3 = tx((db) => offers.lastRejectedAt(db, F, 888, now - 10000));
    assert.ok(res3.ok);
    assert.strictEqual(res3.at, null, "different character returns null");
    const res4 = tx((db) => offers.lastRejectedAt(db, 500020, 999, now - 10000));
    assert.ok(res4.ok);
    assert.strictEqual(res4.at, null, "different faction returns null");
  }));

  needsDriver("TP2a issuance: public offer payload & info byte-for-byte pre-25b", () => H.withStore(driver, async (reopen) => {
    const opened = reopen();
    insertStation(opened.store, CLOCK);
    const { journal, budgets, offers, priceCache } = createRepos();
    const tx = (fn) => { const r = opened.store.transaction("test", fn); assert.ok(r.ok, JSON.stringify(r)); return r.value; };
    fundBudget(tx, budgets);
    const offer = createOffer(tx, offers, "tp2a");
    const adapter = createFakeTradeAdapter();
    const executor = createExecutor({ store: opened.store, journal, offers, budgets, adapter, priceCache });
    executor.start();
    runExecutorAndAssert(await executor.runPass(), { issued: 1, opened: 1 });
    const outbox = tx((db) => journal.findByKey(db, S.issueOutboxKey(offer.offerId)));
    assert.ok(outbox.ok && outbox.found);
    const description = `[LNE:${offer.offerId}] Sansha buys 1000 units of this item for its station. Deliver to this station.`;
    const literal = {
      offerId: offer.offerId, corporationId: CORP, ceoId: CEO, accountKey: 1006, npcStationId: STATION_ID, typeId: 34,
      quantity: 1000, rewardIsk: 1100, minutesExpire: 4320, title: "Sansha: purchase order", description,
    };
    assert.deepStrictEqual(outbox.entry.payload, literal);
    const built = buildIssuePayload({ ...offer, assigneeCharacterId: null }, { stationId: STATION_ID, systemId: SYSTEM },
      { ceoId: CEO }, { accountKey: 1006, contractTtlMs: 259200000, privateOfferTtlMs: 86400000 }, "Sansha");
    assert.strictEqual(JSON.stringify(built), JSON.stringify(literal), "built payload byte-for-byte pre-25b");
    const contract = [...adapter._state.contracts.values()][0];
    assert.strictEqual(JSON.stringify(contract.payload.info), JSON.stringify({
      contractType: 1, isPrivate: false, assignedToID: 0, minutesExpire: 4320, numDays: 0, startStationID: STATION_ID,
      destinationID: 0, price: 0, reward: 1100, collateral: 0, title: "Sansha: purchase order", description, itemList: [],
      startStationDivision: 4, requestItemTypeList: [[34, 1000]], forCorp: true, multiContract: false,
    }));
    executor.stop();
  }));

  needsDriver("TP2b issuance: private offer → assigneeCharacterId at end, isPrivate:true, assignedToID, minutesExpire 1440, expiresAt = now + 1d", () => H.withStore(driver, async (reopen) => {
    const opened = reopen();
    insertStation(opened.store, CLOCK);
    const { journal, budgets, offers, priceCache } = createRepos();
    const tx = (fn) => { const r = opened.store.transaction("test", fn); assert.ok(r.ok, JSON.stringify(r)); return r.value; };
    fundBudget(tx, budgets);
    const offer = createOffer(tx, offers, "tp2b", { assigneeCharacterId: 777, standingBonusPermille: 500 });
    const adapter = createFakeTradeAdapter();
    const executor = createExecutor({ store: opened.store, journal, offers, budgets, adapter, priceCache });
    executor.start();
    runExecutorAndAssert(await executor.runPass(), { issued: 1, opened: 1 });
    const outbox = tx((db) => journal.findByKey(db, S.issueOutboxKey(offer.offerId)));
    assert.ok(outbox.ok && outbox.found);
    const payload = outbox.entry.payload;
    assert.strictEqual(payload.assigneeCharacterId, 777);
    const built = buildIssuePayload(offer, { stationId: STATION_ID, systemId: SYSTEM }, { ceoId: CEO },
      { accountKey: 1006, contractTtlMs: 259200000, privateOfferTtlMs: 86400000 }, "Sansha");
    const keys = Object.keys(built);
    assert.strictEqual(keys[keys.length - 1], "assigneeCharacterId", "assigneeCharacterId at end of the built payload");
    assert.deepStrictEqual(payload, built, "outbox = built payload");
    assert.strictEqual(payload.minutesExpire, 1440, "private minutesExpire = 1440 (1 day)");
    assert.strictEqual(getOffer(tx, offers, offer.offerId).expiresAt, AT + 86400000, "expiresAt = now + 1 d");
    assert.ok(payload.title.includes("private purchase order"), "private title");
    assert.ok(payload.description.includes("trusted supplier"), "private description has trusted supplier");
    const adapterState = adapter._state;
    const contract = [...adapterState.contracts.values()][0];
    assert.strictEqual(contract.payload.info.isPrivate, true, "info.isPrivate = true");
    assert.strictEqual(contract.payload.info.assignedToID, 777, "info.assignedToID = 777");
    executor.stop();
  }));

  needsDriver("TP2c issuance: public offer still 4320 / 3d", () => H.withStore(driver, async (reopen) => {
    const opened = reopen();
    insertStation(opened.store, CLOCK);
    const { journal, budgets, offers, priceCache } = createRepos();
    const tx = (fn) => { const r = opened.store.transaction("test", fn); assert.ok(r.ok, JSON.stringify(r)); return r.value; };
    fundBudget(tx, budgets);
    const offer = createOffer(tx, offers, "tp2c");
    const adapter = createFakeTradeAdapter();
    const executor = createExecutor({ store: opened.store, journal, offers, budgets, adapter, priceCache });
    executor.start();
    runExecutorAndAssert(await executor.runPass(), { issued: 1, opened: 1 });
    const outbox = tx((db) => journal.findByKey(db, S.issueOutboxKey(offer.offerId)));
    assert.ok(outbox.ok && outbox.found);
    const payload = outbox.entry.payload;
    assert.strictEqual(payload.minutesExpire, 4320, "public minutesExpire = 4320 (3 days)");
    assert.ok(!("assigneeCharacterId" in payload), "public payload has no assigneeCharacterId");
    assert.strictEqual(getOffer(tx, offers, offer.offerId).expiresAt, AT + 259200000, "expiresAt = now + 3 d");
    executor.stop();
  }));

  test("TP2d issuance: assigneeCharacterId null/negative/fraction → TRADE_CALL_INVALID", () => {
    const base = {
      offerId: "to_x", corporationId: CORP, ceoId: CEO, accountKey: 1006, npcStationId: STATION_ID, typeId: 34,
      quantity: 1000, rewardIsk: 1100, minutesExpire: 1440, title: "Sansha: private purchase order",
      description: "[LNE:to_x] Sansha buys 1000 units of this item for its station.",
    };
    for (const bad of [null, -5, 1.5, "777"]) {
      const r = buildWantToBuyCall({ ...base, assigneeCharacterId: bad });
      assert.deepStrictEqual(r, { ok: false, reason: "TRADE_CALL_INVALID", detail: "assigneeCharacterId" }, `assignee ${bad}`);
    }
    const pub = buildWantToBuyCall(base);
    assert.ok(pub.ok && pub.info.isPrivate === false && pub.info.assignedToID === 0, "absent -> public");
    const zero = buildWantToBuyCall({ ...base, assigneeCharacterId: 0 });
    assert.ok(zero.ok && zero.info.isPrivate === false && zero.info.assignedToID === 0, "0 -> public");
    const priv = buildWantToBuyCall({ ...base, assigneeCharacterId: 777 });
    assert.ok(priv.ok && priv.info.isPrivate === true && priv.info.assignedToID === 777, "777 -> private");
  });

  needsDriver("TP3a REJECTED: private contract OPEN → reject → deleted, 1 defund, offer CANCELLED REJECTED, budget released once", () => H.withStore(driver, async (reopen) => {
    const opened = reopen();
    insertStation(opened.store, CLOCK);
    const { journal, budgets, offers, priceCache } = createRepos();
    const tx = (fn) => { const r = opened.store.transaction("test", fn); assert.ok(r.ok, JSON.stringify(r)); return r.value; };
    fundBudget(tx, budgets);
    const offer = createOffer(tx, offers, "tp3a", { assigneeCharacterId: 777, standingBonusPermille: 500 });
    const adapter = createFakeTradeAdapter();
    const telemetryCounts = new Map();
    const telemetry = { count: (n, v) => telemetryCounts.set(n, (telemetryCounts.get(n) || 0) + v), observe() {} };
    const executor = createExecutor({ store: opened.store, journal, offers, budgets, adapter, priceCache, telemetry });
    executor.start();
    runExecutorAndAssert(await executor.runPass(), { issued: 1, opened: 1 });
    const contractId = getOffer(tx, offers, offer.offerId).contractId;
    adapter._state.pendingCreates.clear();
    assert.strictEqual(adapter.reject(contractId), true, "the assignee rejects the private contract");
    runExecutorAndAssert(await executor.runPass(), { closed: 1 });
    const offerClosed = getOffer(tx, offers, offer.offerId);
    assert.strictEqual(offerClosed.state, "CANCELLED", "offer CANCELLED");
    assert.strictEqual(offerClosed.endReason, "REJECTED", "endReason = REJECTED");
    const budget = getBudget(tx, budgets);
    assert.strictEqual(budget.reservedIsk, 0, "reserved 0");
    assert.strictEqual(budget.releasedTotal, 1100, "releasedTotal = 1100");
    assert.ok(!adapter._state.contracts.has(contractId), "contract deleted from adapter");
    assert.strictEqual(adapter._state.receipts.has(`lne:trade:${offer.offerId}:defund`), true, "1 defund receipt");
    assert.strictEqual(adapter._state.wallets.get(CORP)[1006], 0, "fund + defund: division net 0");
    assert.strictEqual(telemetryCounts.get("trade.privateRejected"), 1);
    runExecutorAndAssert(await executor.runPass(), {});
    assert.strictEqual(getBudget(tx, budgets).releasedTotal, 1100, "released once");
    executor.stop();
  }));

  needsDriver("TP3b REJECTED: crash after delete → next pass DELETED → defund duplicate, one leg net", () => H.withStore(driver, async (reopen) => {
    const opened = reopen();
    insertStation(opened.store, CLOCK);
    const { journal, budgets, offers, priceCache } = createRepos();
    const tx = (fn) => { const r = opened.store.transaction("test", fn); assert.ok(r.ok, JSON.stringify(r)); return r.value; };
    fundBudget(tx, budgets);
    const offer = createOffer(tx, offers, "tp3b", { assigneeCharacterId: 777 });
    const adapter = createFakeTradeAdapter({}, { leaveDeletedRecord: true });
    adapter._setWalletBalance(CORP, 1006, 5000);
    const defunds = [];
    const originalAdjust = adapter.tradeAdjustWallet;
    let crashed = false;
    adapter.tradeAdjustWallet = async (spec) => {
      const r = await originalAdjust(spec);
      if (spec.deltaIsk < 0) {
        defunds.push(r);
        if (!crashed) { crashed = true; throw new Error("crash after the defund"); }
      }
      return r;
    };
    const executor = createExecutor({ store: opened.store, journal, offers, budgets, adapter, priceCache });
    executor.start();
    runExecutorAndAssert(await executor.runPass(), { issued: 1, opened: 1 });
    const contractId = getOffer(tx, offers, offer.offerId).contractId;
    adapter._state.pendingCreates.clear();
    assert.strictEqual(adapter.reject(contractId), true);
    const pass2 = await executor.runPass();
    assert.strictEqual(pass2.errors, 1, JSON.stringify(pass2));
    assert.strictEqual(pass2.closed, 0);
    assert.strictEqual(getOffer(tx, offers, offer.offerId).state, "OPEN");
    assert.strictEqual(adapter._state.contracts.get(contractId).status, "DELETED");
    runExecutorAndAssert(await executor.runPass(), { closed: 1 });
    const offerClosed = getOffer(tx, offers, offer.offerId);
    assert.strictEqual(offerClosed.state, "CANCELLED", "offer CANCELLED");
    assert.strictEqual(offerClosed.endReason, "DELETED_EXTERNALLY");
    const budget = getBudget(tx, budgets);
    assert.strictEqual(budget.reservedIsk, 0, "reserved 0");
    assert.strictEqual(budget.releasedTotal, 1100, "releasedTotal = 1100 (only once)");
    assert.deepStrictEqual(defunds.map((r) => r.ok && r.duplicate), [false, true], "second defund is a duplicate");
    assert.strictEqual(adapter._state.wallets.get(CORP)[1006], 5000, "one defund leg net");
    executor.stop();
  }));

  needsDriver("TP4a seam: core read - no record → found:false", () => H.withStore(driver, async (reopen) => {
    const opened = reopen();
    const adapter = createAdapter({ moduleApi: { _cache: {} }, existsSync: () => false, gameModules: GAME_MODULES, logger: { log() {} } });
    adapter.setServerSrc(opened.store.options?.serverSrc || "nonexistent");
    const res = adapter.readCharacterStanding(123, 456);
    assert.ok(!res.ok);
    assert.strictEqual(res.reason, "SEAM_UNAVAILABLE");
  }));

  needsDriver("TP4b seam: real createAdapter() has readCharacterStanding & checkStandingRead (function)", () => H.withStore(driver, async (reopen) => {
    const opened = reopen();
    const adapter = createAdapter({ moduleApi: { _cache: {} }, existsSync: () => false, gameModules: GAME_MODULES, logger: { log() {} } });
    assert.strictEqual(typeof adapter.readCharacterStanding, "function", "readCharacterStanding is function");
    assert.strictEqual(typeof adapter.checkStandingRead, "function", "checkStandingRead is function");
  }));

  needsDriver("TP4c seam: consumers in GAME_MODULES for trade (characterState, standingRuntime)", () => {
    const charStateMod = GAME_MODULES.find(m => m.path === "services/character/characterState");
    assert.ok(charStateMod, "characterState module exists");
    const peekSym = charStateMod.symbols.find(s => s.name === "peekCharacterRecord" && s.consumers.includes("trade"));
    assert.ok(peekSym, "peekCharacterRecord has trade consumer");
    const standingMod = GAME_MODULES.find(m => m.path === "services/character/standingRuntime");
    assert.ok(standingMod, "standingRuntime module exists");
    const getRawSym = standingMod.symbols.find(s => s.name === "getCharacterRawStandingFromRecord" && s.consumers.includes("trade"));
    assert.ok(getRawSym, "getCharacterRawStandingFromRecord has trade consumer");
  });

  needsDriver("TP4d vendor fact: standingRuntime exports getCharacterRawStandingFromRecord, characterState exports peekCharacterRecord, contractRuntimeState has REJECTED", () => {
    const charStateMod = GAME_MODULES.find(m => m.path === "services/character/characterState");
    const standingMod = GAME_MODULES.find(m => m.path === "services/character/standingRuntime");
    const contractMod = GAME_MODULES.find(m => m.path === "services/contracts/contractRuntimeState");
    assert.ok(charStateMod && standingMod && contractMod, "all three modules in GAME_MODULES");
    assert.ok(charStateMod.symbols.some(s => s.name === "peekCharacterRecord"), "characterState exports peekCharacterRecord");
    assert.ok(standingMod.symbols.some(s => s.name === "getCharacterRawStandingFromRecord"), "standingRuntime exports getCharacterRawStandingFromRecord");
    assert.ok(contractMod.symbols.some(s => s.name === "CONTRACT_STATUS" && s.valueType === "object"), "contractRuntimeState exports CONTRACT_STATUS object");
  });

  const FEE = 10000;
  const counter = () => {
    const counts = new Map();
    return { counts, telemetry: { count: (n, v) => counts.set(n, (counts.get(n) || 0) + v), observe() {} } };
  };

  test("PF2 private fee: buildIssuePayload private -> brokerFeeIsk after assigneeCharacterId, public byte for byte; fundIskOf", () => {
    const cfg = { accountKey: 1006, contractTtlMs: 259200000, privateOfferTtlMs: 86400000, privateBrokerFeeIsk: FEE };
    const pub = makeOffer({ offerId: "pf2pub" });
    const builtPub = buildIssuePayload(pub, { stationId: STATION_ID, systemId: SYSTEM }, { ceoId: CEO }, cfg, "Sansha");
    const description = `[LNE:pf2pub] Sansha buys 1000 units of this item for its station. Deliver to this station.`;
    assert.strictEqual(JSON.stringify(builtPub), JSON.stringify({
      offerId: "pf2pub", corporationId: CORP, ceoId: CEO, accountKey: 1006, npcStationId: STATION_ID, typeId: 34,
      quantity: 1000, rewardIsk: 1100, minutesExpire: 4320, title: "Sansha: purchase order", description,
    }), "public payload = TP2a literal (no brokerFeeIsk)");
    const priv = makeOffer({ offerId: "pf2priv", assigneeCharacterId: 777 });
    const builtPriv = buildIssuePayload(priv, { stationId: STATION_ID, systemId: SYSTEM }, { ceoId: CEO }, cfg, "Sansha");
    const keys = Object.keys(builtPriv);
    assert.deepStrictEqual(keys.slice(-2), ["assigneeCharacterId", "brokerFeeIsk"]);
    assert.strictEqual(builtPriv.brokerFeeIsk, FEE);
    const { privateBrokerFeeIsk: _f, ...noFeeCfg } = cfg;
    assert.ok(!("brokerFeeIsk" in buildIssuePayload(priv, { stationId: STATION_ID, systemId: SYSTEM }, { ceoId: CEO }, noFeeCfg, "Sansha")),
      "no fee in cfg -> pre-change private payload");
    assert.strictEqual(fundIskOf(builtPub), 1100);
    assert.strictEqual(fundIskOf(builtPriv), 1100 + FEE);
    assert.strictEqual(fundIskOf({ rewardIsk: 1100, brokerFeeIsk: 0 }), 1100);
    const call = buildWantToBuyCall(builtPriv);
    assert.ok(call.ok && call.info.isPrivate === true && call.info.reward === 1100, JSON.stringify(call));
  });

  needsDriver("PF3 private fee: vendor wants reward + fee -> OPEN, fund R+F, budget pays F; expire -> defund R, division 0", () => H.withStore(driver, async (reopen) => {
    const opened = reopen();
    insertStation(opened.store, CLOCK);
    const { journal, budgets, offers, priceCache } = createRepos();
    const tx = (fn) => { const r = opened.store.transaction("test", fn); assert.ok(r.ok, JSON.stringify(r)); return r.value; };
    fundBudget(tx, budgets);
    const before = getBudget(tx, budgets);
    const offer = createOffer(tx, offers, "pf3", { assigneeCharacterId: 777 });
    const adapter = createFakeTradeAdapter({}, { privateBrokerFee: FEE });
    const { counts, telemetry } = counter();
    const executor = createExecutor({ store: opened.store, journal, offers, budgets, adapter, priceCache, telemetry });
    executor.start();
    runExecutorAndAssert(await executor.runPass(), { issued: 1, opened: 1 });
    const outbox = tx((db) => journal.findByKey(db, S.issueOutboxKey(offer.offerId)));
    assert.strictEqual(outbox.entry.payload.brokerFeeIsk, FEE, "fee frozen in the outbox");
    assert.strictEqual(getOffer(tx, offers, offer.offerId).state, "OPEN");
    assert.strictEqual(adapter._state.wallets.get(CORP)[1006], 0, "fund R+F, the vendor took R+F");
    const b = getBudget(tx, budgets);
    assert.strictEqual(b.availableIsk, before.availableIsk - 1100 - FEE, "available -= R (reserve) + F");
    assert.strictEqual(b.spentTotal, before.spentTotal + FEE, "spent_total += F");
    assert.strictEqual(counts.get("trade.privateFeeCharged"), 1);
    assert.strictEqual(counts.get("trade.privateFeeIsk"), FEE);
    assert.strictEqual(counts.get("trade.privateFeeShort") || 0, 0);
    adapter._state.pendingCreates.clear();
    const restore = advanceClock(86400000 + 1);
    let expirePass;
    try {
      expirePass = await executor.runPass();
    } finally { restore(); }
    assert.ok(expirePass.ok && expirePass.closed === 1, JSON.stringify(expirePass));
    const closedOffer = getOffer(tx, offers, offer.offerId);
    assert.strictEqual(closedOffer.state, "CANCELLED");
    assert.strictEqual(closedOffer.endReason, "EXPIRED");
    assert.strictEqual(adapter._state.wallets.get(CORP)[1006], 0, "delete refunds R, defund R -> division 0");
    const after = getBudget(tx, budgets);
    assert.strictEqual(after.availableIsk, before.availableIsk - FEE, "the reward is released, the fee stays spent");
    assert.strictEqual(after.spentTotal, before.spentTotal + FEE);
    executor.stop();
  }));

  needsDriver("PF4 private fee: the same ISSUING -> OPEN key charges once; available < F -> clipped, privateFeeShort, OPEN", () => H.withStore(driver, async (reopen) => {
    const opened = reopen();
    insertStation(opened.store, CLOCK);
    const { journal, budgets, offers, priceCache } = createRepos();
    const tx = (fn) => { const r = opened.store.transaction("test", fn); assert.ok(r.ok, JSON.stringify(r)); return r.value; };
    fundBudget(tx, budgets);
    const o = createOffer(tx, offers, "pf4a", { assigneeCharacterId: 777 });
    const issuing = tx((db) => offers.transitionOfferInTx(db, { offerId: o.offerId, expectedVersion: o.version, from: S.PLANNED,
      to: S.ISSUING, reason: "", at: AT, patch: { expiresAt: AT + 86400000 } }, S.transitionKey(o.offerId, 1, S.ISSUING)));
    assert.ok(issuing.ok);
    const badFee = tx((db) => offers.transitionOfferInTx(db, { offerId: o.offerId, expectedVersion: issuing.offer.version,
      from: S.ISSUING, to: S.CANCELLED, reason: "X", at: AT, feeIsk: FEE }, "pf4:bad"));
    assert.strictEqual(badFee.ok, false);
    assert.strictEqual(badFee.detail, "feeIsk", JSON.stringify(badFee));
    const spec = { offerId: o.offerId, expectedVersion: issuing.offer.version, from: S.ISSUING, to: S.OPEN, reason: "", at: AT,
      patch: { contractId: 4242 }, feeIsk: FEE };
    const key = S.transitionKey(o.offerId, 2, S.OPEN);
    const first = tx((db) => offers.transitionOfferInTx(db, spec, key));
    assert.ok(first.ok && first.duplicate === false, JSON.stringify(first));
    assert.strictEqual(first.feeChargedIsk, FEE);
    assert.strictEqual(first.feeShortIsk, 0);
    const mid = getBudget(tx, budgets);
    const again = tx((db) => offers.transitionOfferInTx(db, spec, key));
    assert.ok(again.ok && again.duplicate === true);
    assert.strictEqual(again.feeChargedIsk, 0, "replay charges nothing");
    assert.deepStrictEqual(getBudget(tx, budgets), mid, "budget unchanged by the replay");
    const entry = tx((db) => journal.findByKey(db, key));
    assert.strictEqual(entry.entry.payload.feeIsk, FEE, "journal payload carries feeIsk");
    const big = mid.availableIsk + 1100 + 5000;
    const o2 = createOffer(tx, offers, "pf4b", { assigneeCharacterId: 778, itemKey: "type:35", typeId: 35 });
    const pre = getBudget(tx, budgets);
    const avail = pre.availableIsk;
    const adapter = createFakeTradeAdapter({}, { privateBrokerFee: big });
    const { counts, telemetry } = counter();
    const executor = createExecutor({ store: opened.store, journal, offers, budgets, adapter, priceCache, telemetry });
    executor.start();
    const pass = await executor.runPass();
    assert.ok(pass.ok && pass.opened === 1, JSON.stringify(pass));
    assert.strictEqual(getOffer(tx, offers, o2.offerId).state, "OPEN", "a short fee does not block the transition");
    assert.strictEqual(getBudget(tx, budgets).spentTotal, pre.spentTotal + avail, "charged = available");
    assert.strictEqual(counts.get("trade.privateFeeIsk"), avail);
    assert.strictEqual(counts.get("trade.privateFeeShort"), 1);
    executor.stop();
  }));

  needsDriver("PF5 private fee drift: private stays PLANNED, no wallet call, privateFeeUnavailable; startTrade gate fee_unknown", () => H.withStore(driver, async (reopen) => {
    const opened = reopen();
    insertStation(opened.store, CLOCK);
    const { journal, budgets, offers, priceCache } = createRepos();
    const tx = (fn) => { const r = opened.store.transaction("test", fn); assert.ok(r.ok, JSON.stringify(r)); return r.value; };
    fundBudget(tx, budgets);
    const offer = createOffer(tx, offers, "pf5", { assigneeCharacterId: 777 });
    const adapter = createFakeTradeAdapter({}, { privateBrokerFee: FEE });
    const drift = { ok: false, reason: "PRIVATE_FEE_DRIFT", detail: "rule" };
    adapter.tradePrivateContractFee = () => drift;
    let walletCalls = 0;
    const adjust = adapter.tradeAdjustWallet;
    adapter.tradeAdjustWallet = (spec) => { walletCalls += 1; return adjust(spec); };
    const { counts, telemetry } = counter();
    const executor = createExecutor({ store: opened.store, journal, offers, budgets, adapter, priceCache, telemetry });
    executor.start();
    runExecutorAndAssert(await executor.runPass(), {});
    assert.strictEqual(getOffer(tx, offers, offer.offerId).state, "PLANNED");
    assert.strictEqual(walletCalls, 0, "no wallet leg");
    assert.strictEqual(adapter._state.contracts.size, 0, "no contract");
    assert.strictEqual(counts.get("trade.privateFeeUnavailable"), 1);
    executor.stop();

    const { startTrade } = require("../../lib/economy/trade/index");
    const { createViewRegistry } = require("../../lib/observer/views");
    const config = require("../../config");
    const path = require("node:path");
    const DEFAULTS = config.resolveConfig({ modDir: path.resolve(__dirname, "..", ".."), env: {} }).config;
    const tradeConfig = { ...DEFAULTS, trade: { ...DEFAULTS.trade, enabled: true, privateOffersEnabled: true, contractsEnabled: true } };
    const gateAdapter = createFakeTradeAdapter();
    gateAdapter.readCharacterStanding = () => ({ ok: true, found: false });
    gateAdapter.checkStandingRead = () => ({ ok: true });
    gateAdapter.tradePrivateContractFee = () => drift;
    const lines = [];
    const started = startTrade({
      config: tradeConfig, persistence: { ok: true, store: opened.store, journal },
      clock: H.sharedOf().clock, views: createViewRegistry(), ids: IDS, adapter: gateAdapter,
      setTimer: () => ({ cancel() {}, hasRef: () => false }), logger: { log: (m) => lines.push(String(m)) },
    });
    assert.ok(started.ok, JSON.stringify(started));
    const status = started.trade.getStatus();
    assert.deepStrictEqual(status.privateOffers, { gate: "off", reason: "fee_unknown" });
    assert.strictEqual(lines.filter((l) => l.includes("fee_unknown")).length, 1, lines.join("\n"));
    if (typeof started.trade.stop === "function") started.trade.stop();
  }));
};