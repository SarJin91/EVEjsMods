"use strict";

const assert = require("node:assert");
const path = require("node:path");

const config = require("../../config");
const { createJournal } = require("../../lib/persistence/journal");
const { createBudgetRepository } = require("../../lib/economy/trade/budgetRepository");
const { createOfferRepository } = require("../../lib/economy/trade/offerRepository");
const { createTradeExecutor } = require("../../lib/economy/trade/tradeExecutor");
const { stepAccepted, stepIntake } = require("../../lib/economy/trade/intake");
const { listTaggedContractsFrom, readTradeContractFrom } = require("../../lib/adapter/tradeContracts");
const { createFakeTradeAdapter } = require("../_support/fakeTradeAdapter");
const { harness: H } = require("../battle/settlement.test");
const S = require("../../lib/economy/trade/schema");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const DEFAULTS = config.resolveConfig({ modDir: MOD_DIR, env: {} }).config;

const F = 500019;
const CORP = 999999;
const SYSTEM = 30000001;
const TYPE_ID = 34;
const QUANTITY = 1000;
const AT = 1000000;
const STATIONS = [["sw-st-1", 60004001], ["sw-st-2", 60004002], ["sw-st-3", 60004003]];
let clockNow = AT;
const CLOCK = { now: () => clockNow };
let idCounter = 0;
const IDS = { next: (p) => `${p}_${++idCounter}` };

function insertStation(store, stationId, npcStationId) {
  const r = store.transaction("test.insertStation", (db) => db.prepare(`
    INSERT INTO world_stations (station_id, kind, npc_station_id, type_id, structure_family, system_id,
      owner_faction_id, owner_corporation_id, state, state_until_at, name, position_json, origin,
      evejs_item_id, destroyed_at, created_at, updated_at, version)
    VALUES (?, 'npc', ?, 35834, 'Sansha', ?, ?, ?, 'ONLINE', NULL, 'Sweep Station', '{"x":0,"y":0,"z":0}', 'seed',
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
      intakeMaxRetries: 100, ...trade,
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

function createOffer(tx, offers, offerId, stationId) {
  const spec = {
    offerId, factionId: F, stationId, systemId: SYSTEM, issuerCorporationId: CORP, itemKind: "mineral",
    itemKey: "type:34", typeId: TYPE_ID, quantity: QUANTITY, unitPriceMilli: 1100, iskTotal: QUANTITY * 1100,
    refPriceMilli: 1000, capPriceMilli: 1960, priceSource: "bid", state: "PLANNED", stateSeq: 0, endReason: null,
    contractId: null, acceptorCharacterId: null, deliveredQuantity: 0, createdAt: AT, expiresAt: AT + 259200000,
    updatedAt: AT, endedAt: null, version: 1, at: AT,
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

function toIssuing(tx, offers, seed, stationId) {
  const offerId = createOffer(tx, offers, seed, stationId).offerId;
  step(tx, offers, offerId, S.PLANNED, S.ISSUING, 1, { expiresAt: AT + 259200000 });
  return offerId;
}

async function toIntake(env, seed, stationId, npcStationId, itemId) {
  const { tx, offers } = env;
  const offerId = toIssuing(tx, offers, seed, stationId);
  step(tx, offers, offerId, S.ISSUING, S.OPEN, 2, { contractId: 700000 + itemId });
  step(tx, offers, offerId, S.OPEN, S.ACCEPTED, 3, { acceptorCharacterId: 999 });
  env.adapter._addHangarStack(CORP, npcStationId, itemId, TYPE_ID, QUANTITY);
  const offer = tx((db) => offers.getOffer(db, offerId)).offer;
  const r = await stepAccepted(env.deps, offer, { stationId: npcStationId, destroyed: false });
  assert.strictEqual(r.action, "PLAN", JSON.stringify(r));
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

function tagged(adapter, contractId, offerId) {
  adapter._state.contracts.set(contractId, { contractId, offerId, corporationId: CORP, status: "OUTSTANDING",
    payload: { info: { description: `[LNE:${offerId}] sweep`, reward: 5000 }, session: {} }, createdAt: 0 });
}

module.exports = ({ test }) => {
  const driver = H.loadDriver();

  test("SW1 orphan scan deferred by the governor in pass 1 -> pass 2 runs the full start-up scan (limit 1000)", () => H.withStore(driver, async (reopen) => {
    const opened = reopen();
    insertStation(opened.store, STATIONS[0][0], STATIONS[0][1]);
    const env = setup(opened);
    env.adapter = createFakeTradeAdapter();
    const limits = [];
    const origList = env.adapter.tradeListTaggedContracts;
    env.adapter.tradeListTaggedContracts = (spec) => { limits.push(spec.limit); return origList.call(env.adapter, spec); };
    let calls = 0;
    const ex = executorOf(opened, env, makeConfig(), { getGovernor: () => ({ admits: () => { calls += 1; return calls !== 2; } }) });
    await ex.runPass();
    assert.deepStrictEqual(limits, [], "pass 1: scan deferred");
    await ex.runPass();
    await ex.runPass();
    assert.deepStrictEqual(limits, [1000, 2], "pass 2 = the full scan, pass 3 periodic");
    ex.stop();
  }));

  test("SW2 periodic orphan scan with a cursor finds an orphan behind 2 live tagged contracts", () => H.withStore(driver, async (reopen) => {
    const opened = reopen();
    insertStation(opened.store, STATIONS[0][0], STATIONS[0][1]);
    const env = setup(opened);
    env.adapter = createFakeTradeAdapter();
    tagged(env.adapter, 100001, toIssuing(env.tx, env.offers, "sw2-a", STATIONS[0][0]));
    insertStation(opened.store, STATIONS[1][0], STATIONS[1][1]);
    tagged(env.adapter, 100002, toIssuing(env.tx, env.offers, "sw2-b", STATIONS[1][0]));
    const ex = executorOf(opened, env, makeConfig({ maxOrphansPerPass: 2 }));
    await ex.runPass();
    tagged(env.adapter, 100003, "sw2-gone");
    await ex.runPass();
    assert.ok(env.adapter._state.contracts.has(100003), "not reached yet");
    await ex.runPass();
    assert.ok(!env.adapter._state.contracts.has(100003), "orphan behind the live ones deleted");
    assert.ok(env.adapter._state.contracts.has(100001) && env.adapter._state.contracts.has(100002), "live ones kept");
    ex.stop();
  }));

  test("SW3 B1 adapter: CONTRACT_STATUS.OUTSTANDING = 0 is listed and read as OUTSTANDING; cursor + id order", () => {
    const records = [
      { contractID: 30, issuerOwnerID: CORP, status: 0, description: "[LNE:c] x", reward: 3 },
      { contractID: 10, issuerOwnerID: CORP, status: 0, description: "[LNE:a] x", reward: 1 },
      { contractID: 20, issuerOwnerID: CORP, status: 0, description: "[LNE:b] x", reward: 2 },
      { contractID: 40, issuerOwnerID: CORP, status: 2, description: "[LNE:d] x", reward: 4 },
    ];
    const runtime = { CONTRACT_STATUS: { OUTSTANDING: 0, FINISHED: 2 }, listContractRecords: () => records,
      getContractRecord: (id) => records.find((r) => r.contractID === id) || null };
    const first = listTaggedContractsFrom(runtime, { corporationIds: [CORP], limit: 2 });
    assert.deepStrictEqual(first.contracts.map((c) => c.contractId), [10, 20]);
    assert.strictEqual(first.truncated, true);
    const next = listTaggedContractsFrom(runtime, { corporationIds: [CORP], limit: 2, afterContractId: 20 });
    assert.deepStrictEqual(next.contracts.map((c) => c.offerId), ["c"]);
    assert.strictEqual(next.truncated, false);
    const read = readTradeContractFrom(runtime, { getPendingContractSettlement: () => null }, 10);
    assert.ok(read.ok && read.contract, JSON.stringify(read));
    assert.strictEqual(read.contract.status, "OUTSTANDING");
  });

  test("SW4 two INTAKE offers that always RETRY do not block a third; delivery bumps the station version", () => H.withStore(driver, async (reopen) => {
    const opened = reopen();
    for (const [id, npc] of STATIONS) insertStation(opened.store, id, npc);
    const env = setup(opened);
    env.adapter = createFakeTradeAdapter();
    env.deps = { store: opened.store, journal: env.journal, offers: env.offers, adapter: env.adapter,
      config: makeConfig(), clock: CLOCK, telemetry: null, logger: { log() {} } };
    clockNow = AT + 10000;
    const created = [];
    for (let i = 0; i < 3; i += 1) {
      const offerId = await toIntake(env, `sw4-${i}`, STATIONS[i][0], STATIONS[i][1], 4001 + i);
      created.push({ offerId, stationId: STATIONS[i][0] });
    }
    created.sort((x, y) => (x.offerId < y.offerId ? -1 : 1));
    const [stuckA, stuckB, good] = created;
    const origVoid = env.adapter.tradeVoidStack;
    env.adapter.tradeVoidStack = (spec) => (spec.key === S.voidKey(good.offerId, spec.itemId)
      ? origVoid.call(env.adapter, spec)
      : Promise.resolve({ ok: false, reason: "CUSTODY_FAILED", permanent: false, ambiguous: true }));
    const ex = executorOf(opened, env, makeConfig({ maxIntakesPerPass: 2 }));
    await ex.runPass();
    await ex.runPass();
    const state = (id) => env.tx((db) => env.offers.getOffer(db, id)).offer.state;
    assert.strictEqual(state(good.offerId), S.DELIVERED, "third offer delivered despite two stuck ones");
    assert.strictEqual(state(stuckA.offerId), S.INTAKE);
    assert.strictEqual(state(stuckB.offerId), S.INTAKE);
    const version = env.tx((db) => db.prepare("SELECT version FROM world_stations WHERE station_id = ?").get(good.stationId)).version;
    assert.strictEqual(version, 2, "stock write bumps world_stations.version");
    ex.stop();
    clockNow = AT;
  }));

  test("SW5 intakeMaxRetries failed passes -> LOST INTAKE_RETRIES_EXHAUSTED once, outbox FAILED, no stock", () => H.withStore(driver, async (reopen) => {
    const opened = reopen();
    insertStation(opened.store, STATIONS[0][0], STATIONS[0][1]);
    const env = setup(opened);
    env.adapter = createFakeTradeAdapter();
    env.deps = { store: opened.store, journal: env.journal, offers: env.offers, adapter: env.adapter,
      config: makeConfig(), clock: CLOCK, telemetry: null, logger: { log() {} } };
    clockNow = AT + 10000;
    const sw5 = await toIntake(env, "sw5-a", STATIONS[0][0], STATIONS[0][1], 5001);
    let voids = 0;
    env.adapter.tradeVoidStack = () => { voids += 1; return Promise.resolve({ ok: false, reason: "CUSTODY_FAILED", permanent: false, ambiguous: true }); };
    const counts = {};
    const telemetry = { count(name, v) { counts[name] = (counts[name] || 0) + v; } };
    const ex = executorOf(opened, env, makeConfig({ intakeMaxRetries: 3 }), { telemetry });
    const state = () => env.tx((db) => env.offers.getOffer(db, sw5)).offer;
    await ex.runPass();
    await ex.runPass();
    assert.strictEqual(state().state, S.INTAKE, "2 failures: still INTAKE");
    await ex.runPass();
    assert.strictEqual(state().state, S.LOST);
    assert.strictEqual(state().endReason, "INTAKE_RETRIES_EXHAUSTED");
    await ex.runPass();
    assert.strictEqual(voids, 3, "no try after LOST");
    assert.strictEqual(counts["trade.intakeRetriesExhausted"], 1);
    assert.strictEqual(counts["trade.lost"], 1);
    const outbox = env.tx((db) => env.journal.findByKey(db, S.intakeOutboxKey(sw5)));
    assert.strictEqual(outbox.entry.state, "FAILED");
    const stock = env.tx((db) => db.prepare("SELECT COUNT(*) AS n FROM world_station_stock WHERE station_id = ?").get(STATIONS[0][0])).n;
    assert.strictEqual(stock, 0, "nothing credited");
    ex.stop();
    clockNow = AT;
  }));

  test("SW6 no free stock item slot -> LOST STOCK_REFUSED before any void, the stack stays", () => H.withStore(driver, async (reopen) => {
    const opened = reopen();
    insertStation(opened.store, STATIONS[0][0], STATIONS[0][1]);
    const env = setup(opened);
    env.adapter = createFakeTradeAdapter();
    const cfg = makeConfig({}, { stations: { ...DEFAULTS.stations, maxStockItemsPerStation: 0 } });
    env.deps = { store: opened.store, journal: env.journal, offers: env.offers, adapter: env.adapter,
      config: cfg, clock: CLOCK, telemetry: null, logger: { log() {} } };
    clockNow = AT + 10000;
    const sw6 = await toIntake(env, "sw6-a", STATIONS[0][0], STATIONS[0][1], 6001);
    let voids = 0;
    const origVoid = env.adapter.tradeVoidStack;
    env.adapter.tradeVoidStack = (spec) => { voids += 1; return origVoid.call(env.adapter, spec); };
    const r = await stepIntake(env.deps, env.tx((db) => env.offers.getOffer(db, sw6)).offer);
    assert.deepStrictEqual(r, { action: "LOST", reason: "STOCK_REFUSED" });
    assert.strictEqual(voids, 0, "no void");
    assert.strictEqual(env.adapter._state.hangarStacks.get(CORP).get(STATIONS[0][1]).get(6001).quantity, QUANTITY);
    const outbox = env.tx((db) => env.journal.findByKey(db, S.intakeOutboxKey(sw6)));
    assert.strictEqual(outbox.entry.state, "APPLIED");
    clockNow = AT;
  }));

  test("SW7 hook install throws -> TRADE_START_FAILED, pump timer cancelled, hooks uninstalled, view unregistered", () => H.withStore(driver, async (reopen) => {
    const opened = reopen();
    const journal = createJournal({ clock: CLOCK, maxPayloadBytes: 16384, maxRows: 500 });
    const timers = [];
    const setTimer = (fn, ms) => { const t = { fn, ms, cancelled: false, cancel() { t.cancelled = true; } }; timers.push(t); return t; };
    const adapter = createFakeTradeAdapter();
    const calls = [];
    adapter.setTradeNudge = () => { calls.push("set"); return { ok: true }; };
    adapter.installTradeHooks = () => { calls.push("install"); throw new Error("boom"); };
    adapter.uninstallTradeHooks = () => { calls.push("uninstall"); return { ok: true }; };
    let unregistered = 0;
    const views = { registerView: () => ({ ok: true, unregister() { unregistered += 1; } }) };
    const cfg = { ...DEFAULTS, trade: { ...DEFAULTS.trade, enabled: true, contractsEnabled: true },
      stations: { ...DEFAULTS.stations, enabled: true } };
    const { startTrade } = require("../../lib/economy/trade");
    const started = startTrade({ config: cfg, persistence: { ok: true, store: opened.store, journal },
      clock: CLOCK, ids: IDS, adapter, setTimer, views });
    assert.strictEqual(started.ok, false);
    assert.strictEqual(started.reason, "TRADE_START_FAILED");
    assert.deepStrictEqual(calls, ["set", "install", "uninstall"]);
    assert.ok(timers.length === 1 && timers[0].cancelled, "pump timer cancelled");
    assert.strictEqual(unregistered, 1, "view unregistered");
  }));
};
