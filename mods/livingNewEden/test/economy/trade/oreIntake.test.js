"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const config = require("../../../config");
const { createJournal } = require("../../../lib/persistence/journal");
const { startTrade } = require("../../../lib/economy/trade");
const { createViewRegistry } = require("../../../lib/observer/views");
const { readTradePricesFrom } = require("../../../lib/adapter/marketPrices");
const { readItemTypeFactsFrom } = require("../../../lib/adapter/itemTypeFacts");
const { createBudgetRepository } = require("../../../lib/economy/trade/budgetRepository");
const { createOfferRepository } = require("../../../lib/economy/trade/offerRepository");
const { buildTradeCatalog } = require("../../../lib/economy/trade/tradeCatalog");
const { stepAccepted, stepIntake } = require("../../../lib/economy/trade/intake");
const ORE_TYPES = require("../../../lib/economy/data/oreTypes");
const S = require("../../../lib/economy/trade/schema");
const { harness: H } = require("../../battle/settlement.test");
const { createFakeTradeAdapter } = require("../../_support/fakeTradeAdapter");

const driver = H.loadDriver();
const MOD_DIR = path.join(__dirname, "..", "..", "..");
const DEFAULTS = config.resolveConfig({ modDir: MOD_DIR, env: {} }).config;
const F = 500019;
const CORP = 999999;
const SYSTEM = 30000001;
const GRACE = 600000;

const REGISTRY = { resolveItemByTypeID: (id) => ({ typeID: id, name: `Ore ${id}`, volume: 0.1, portionSize: 100 }) };

function marketSeam(seen) {
  const marketDaemon = { call: async (method) => (method === "GetOrders" ? { buys: [{ price: 5 }], sells: [{ price: 7 }] } : []) };
  const industryPricing = { resolveAdjustedAverageTypePrice: () => 6 };
  return (spec) => { seen.push(spec.typeIds.length); return readTradePricesFrom(marketDaemon, industryPricing, spec); };
}

function boot(opened, tradeOverrides = {}, shared = H.sharedOf()) {
  const seen = [];
  const timers = [];
  const adapter = { ...createFakeTradeAdapter(), readTradePrices: marketSeam(seen),
    readItemTypeFacts: (ids) => readItemTypeFactsFrom(REGISTRY, ids) };
  const journal = createJournal({ clock: shared.clock, maxPayloadBytes: 16384, maxRows: 500 });
  const cfg = { ...DEFAULTS, trade: { ...DEFAULTS.trade, enabled: true, hullOffersEnabled: false, ...tradeOverrides } };
  const started = startTrade({ config: cfg, persistence: { ok: true, store: opened.store, journal },
    clock: shared.clock, ids: shared.ids, views: createViewRegistry(), adapter, logger: { log() {} },
    getStations: () => ({ getMode: () => "ready" }), getGraph: () => null,
    setTimer: (fn) => { const t = { fn, cancelled: false, cancel() { t.cancelled = true; } }; timers.push(t); return t; } });
  assert.ok(started.ok, JSON.stringify(started));
  const firePass = async () => {
    const t = timers.filter((x) => !x.cancelled).pop();
    assert.ok(t, "executor armed");
    t.cancelled = true;
    await t.fn();
  };
  const tx = (fn) => { const r = opened.store.transaction("test", fn); assert.ok(r.ok, JSON.stringify(r)); return r.value; };
  return { trade: started.trade, shared, seen, firePass, tx };
}

function offerSpec(at, over = {}) {
  return { factionId: F, stationId: "npc-1", systemId: SYSTEM, issuerCorporationId: CORP, itemKind: "ore",
    itemKey: "type:1230", typeId: 1230, quantity: 1000, unitPriceMilli: 5000, iskTotal: 5000000, refPriceMilli: 5000,
    capPriceMilli: 6860, priceSource: "bid", expiresAt: at + 259200000, at, ...over };
}

function fund(tx, budgets, at) {
  const r = tx((db) => budgets.fundInTx(db, { factionId: F, units: 100000, paidUntilTo: at, iskPerUnit: 1000,
    capIsk: 1000000000, at }, `fund:${at}`));
  assert.ok(r.ok, JSON.stringify(r));
}

function insertStation(tx, stationId, npcId, at) {
  tx((db) => db.prepare(`INSERT INTO world_stations (station_id, kind, npc_station_id, type_id, structure_family,
    system_id, owner_faction_id, owner_corporation_id, state, state_until_at, name, position_json, origin, evejs_item_id,
    destroyed_at, created_at, updated_at, version) VALUES (?, 'npc', ?, 35834, 'Sansha', ?, ?, ?, 'ONLINE', NULL,
    'Test Station', '{"x":0,"y":0,"z":0}', 'seed', NULL, NULL, ?, ?, 1)`).run(stationId, npcId, SYSTEM, F, CORP, at, at));
}

let contractSeq = 0;

function acceptedOreOffer(tx, offers, stationId, quantity, at, over = {}) {
  const r = tx((db) => offers.createOfferInTx(db, offerSpec(at, { stationId, quantity, iskTotal: quantity * 5000, ...over }),
    `ik:${stationId}:offer`));
  assert.ok(r.ok && !r.duplicate, JSON.stringify(r));
  const id = r.offer.offerId;
  const step = (v, from, to, dt, patch) => {
    const t = tx((db) => offers.transitionOfferInTx(db, { offerId: id, expectedVersion: v, from, to, reason: "",
      at: at + dt, patch }, S.transitionKey(id, v, to)));
    assert.ok(t.ok, JSON.stringify(t));
  };
  step(1, S.PLANNED, S.ISSUING, 0, { expiresAt: at + 259200000 });
  contractSeq += 1;
  step(2, S.ISSUING, S.OPEN, 1000, { contractId: 700000 + contractSeq });
  step(3, S.OPEN, S.ACCEPTED, 2000, { acceptorCharacterId: 999 });
  return id;
}

module.exports = ({ test, skip }) => {
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  needsDriver("OR1 tiers-3a ore prices, quotes, offers, flag off, config keys, status catalog",
    () => H.withStore(driver, async (reopen) => {
      const opened = reopen();
      const a = boot(opened, { oreOffersEnabled: true });
      await a.firePass();
      assert.deepStrictEqual(a.seen, [31], "7 minerals + 24 ores read");
      const now = a.shared.clock.now();
      assert.deepStrictEqual(a.trade.getPriceCache().peek(1230, now),
        { bidMilli: 5000, askMilli: 7000, baseMilli: 6000, origin: "local" });
      const review = a.tx((db) => a.trade.readForReview(db, F, { stations: [], at: now, limit: 10 }));
      assert.ok(review.ok, JSON.stringify(review));
      const quotes = review.trade.quotes;
      assert.strictEqual(quotes["type:1230"].itemKind, "ore", JSON.stringify(quotes["type:1230"]));
      assert.strictEqual(quotes["type:1230"].ok, true);
      assert.strictEqual(review.trade.volumes["type:1230"], 10);
      const st = a.trade.getStatus();
      assert.strictEqual(st.catalog.oreState, "on");
      assert.strictEqual(st.catalog.ores, 24);

      fund(a.tx, a.trade.budgets, now);
      const create = (over, key) => a.tx((db) => a.trade.offers.createOfferInTx(db, offerSpec(now, over), key));
      const ok = create({}, "or1:a");
      assert.ok(ok.ok && ok.offer.itemKind === "ore" && ok.offer.itemKey === "type:1230", JSON.stringify(ok));
      for (const [over, tag] of [[{ itemKey: "type:9999", typeId: 9999 }, "unknown"], [{ quantity: 150, iskTotal: 750000 },
        "portion"], [{ channel: "market", stationId: "npc-2" }, "market"], [{ itemKey: "type:1230", typeId: 1228 }, "typeId"]]) {
        assert.deepStrictEqual(create(over, `or1:${tag}`), { ok: false, reason: "TRADE_INVALID_INPUT", detail: "ore" }, tag);
      }
      assert.deepStrictEqual(create({}, "or1:b"), { ok: false, reason: "OFFER_EXISTS" });
      a.trade.stop();

      const b = boot(opened, {}, a.shared);
      await b.firePass();
      assert.deepStrictEqual(b.seen, [7]);
      const bNow = b.shared.clock.now();
      const bReview = b.tx((db) => b.trade.readForReview(db, F, { stations: [], at: bNow, limit: 10 }));
      assert.strictEqual(bReview.trade.quotes["type:1230"], undefined);
      const mineralQuotes = Object.fromEntries(Object.entries(quotes).filter(([, q]) => q.itemKind !== "ore"));
      assert.deepStrictEqual(bReview.trade.quotes, mineralQuotes, "mineral quotes identical with and without ore");
      assert.strictEqual(b.trade.getStatus().catalog.oreState, "off");
      const bCreate = (over, key) => b.tx((db) => b.trade.offers.createOfferInTx(db, offerSpec(bNow, over), key));
      assert.deepStrictEqual(bCreate({ stationId: "npc-4" }, "or1:off"),
        { ok: false, reason: "TRADE_INVALID_INPUT", detail: "ore" });
      const m2 = bCreate({ itemKind: "mineral", itemKey: "type:34", typeId: 34, stationId: "npc-4" }, "or1:offm");
      assert.ok(m2.ok, JSON.stringify(m2));
      b.trade.stop();

      const row = (k) => config.SCHEMA.find((r) => r.key === k);
      assert.strictEqual(row("trade.oreOffersEnabled").default, false);
      assert.strictEqual(row("trade.oreOffersEnabled").type, "boolean");
      const eff = row("trade.oreRefineEfficiencyPermille");
      assert.deepStrictEqual([eff.default, eff.min, eff.max], [800, 500, 1000]);
      const example = fs.readFileSync(path.join(MOD_DIR, ".env.example"), "utf8");
      assert.ok(example.includes("# EVEJS_LNE_TRADE_ORE_OFFERS_ENABLED="));
      assert.ok(example.includes("# EVEJS_LNE_TRADE_ORE_REFINE_EFFICIENCY_PERMILLE="));
    }));

  needsDriver("OI1 tiers-3a ore intake: frozen efficiency, STALE replay, markApplied throw, below portion, remainder",
    () => H.withStore(driver, async (reopen) => {
      const opened = reopen();
      const shared = H.sharedOf();
      const clock = shared.clock;
      const at = clock.now();
      const journal = createJournal({ clock, maxPayloadBytes: 16384, maxRows: 500 });
      const budgets = createBudgetRepository({ journal, clock });
      const catalog = buildTradeCatalog({ oreTypes: ORE_TYPES, factsRead: readItemTypeFactsFrom(REGISTRY, [1230]),
        oreOffersEnabled: true });
      const offers = createOfferRepository({ journal, budgets, ids: shared.ids, clock, catalog });
      const adapter = createFakeTradeAdapter();
      let voids = 0;
      const realVoid = adapter.tradeVoidStack;
      adapter.tradeVoidStack = (spec) => { voids += 1; return realVoid(spec); };
      const counts = {};
      const telemetry = { count(name, n) { counts[name] = (counts[name] || 0) + n; } };
      const tx = (fn) => { const r = opened.store.transaction("test", fn); assert.ok(r.ok, JSON.stringify(r)); return r.value; };
      const cfg = (eff) => ({ ...DEFAULTS, trade: { ...DEFAULTS.trade, enabled: true, intakeGraceMs: GRACE,
        oreRefineEfficiencyPermille: eff } });
      const deps = (eff, j = journal) => ({ store: opened.store, journal: j, offers, adapter, config: cfg(eff), clock,
        telemetry, logger: { log() {} }, catalog });
      const offerOf = (id) => tx((db) => offers.getOffer(db, id)).offer;
      const stock = (stationId) => tx((db) => db.prepare("SELECT quantity FROM world_station_stock WHERE station_id = ?"
        + " AND item_kind = 'mineral' AND item_key = 'type:34'").get(stationId));
      fund(tx, budgets, at);

      insertStation(tx, "st-a", 61000001, at);
      const idA = acceptedOreOffer(tx, offers, "st-a", 300, at);
      adapter._addHangarStack(CORP, 61000001, 7001, 1230, 250);
      clock.advance(2000 + GRACE + 1);
      const station = (npc) => ({ stationId: npc, kind: "npc", ownerCorporationId: CORP, systemId: SYSTEM, destroyed: false });
      const acc = await stepAccepted(deps(800), offerOf(idA), station(61000001));
      assert.strictEqual(acc.action, "PLAN", JSON.stringify(acc));
      const plan = tx((db) => journal.findByKey(db, S.intakeOutboxKey(idA))).entry.payload;
      assert.deepStrictEqual(plan.ore, { portionSize: 100, efficiencyPermille: 800, minerals: [["type:34", 400]] });
      const shortBefore = counts["trade.intakeShort"];
      const del = await stepIntake(deps(1000), offerOf(idA));
      assert.strictEqual(del.action, "DELIVERED", JSON.stringify(del));
      assert.strictEqual(del.deliveredQuantity, 200);
      assert.strictEqual(stock("st-a").quantity, 640, "frozen 800 permille, not 1000");
      assert.strictEqual(offerOf(idA).state, S.DELIVERED);
      assert.strictEqual(offerOf(idA).deliveredQuantity, 200);
      assert.strictEqual(counts["trade.oreRefinedPortions"], 2);
      assert.strictEqual(counts["trade.oreRemainder"], 50);
      assert.strictEqual(counts["trade.intakeShort"], shortBefore, "remainder alone is no short intake");
      const again = await stepIntake(deps(1000), offerOf(idA));
      assert.strictEqual(again.action, "STALE");
      assert.strictEqual(stock("st-a").quantity, 640, "replay: no second delta");

      insertStation(tx, "st-b", 61000002, at);
      const idB = acceptedOreOffer(tx, offers, "st-b", 300, clock.now() - 2000 - GRACE - 1);
      adapter._addHangarStack(CORP, 61000002, 7002, 1230, 250);
      assert.strictEqual((await stepAccepted(deps(800), offerOf(idB), station(61000002))).action, "PLAN");
      let armed = true;
      const flaky = Object.freeze({ ...journal, markApplied: (...args) => {
        if (armed) { armed = false; throw new Error("markApplied boom"); }
        return journal.markApplied(...args);
      } });
      const failed = await stepIntake(deps(800, flaky), offerOf(idB));
      assert.strictEqual(failed.action, "ERROR", JSON.stringify(failed));
      assert.strictEqual(stock("st-b"), undefined, "rolled back: no delta");
      assert.strictEqual(offerOf(idB).state, S.INTAKE);
      const retried = await stepIntake(deps(800, flaky), offerOf(idB));
      assert.strictEqual(retried.action, "DELIVERED", JSON.stringify(retried));
      assert.strictEqual(stock("st-b").quantity, 640, "delivered once");

      insertStation(tx, "st-c", 61000003, at);
      const idC = acceptedOreOffer(tx, offers, "st-c", 100, clock.now() - 2000 - GRACE - 1);
      adapter._addHangarStack(CORP, 61000003, 7003, 1230, 50);
      assert.strictEqual((await stepAccepted(deps(800), offerOf(idC), station(61000003))).action, "PLAN");
      const voidsBefore = voids;
      const lost = await stepIntake(deps(800), offerOf(idC));
      assert.deepStrictEqual(lost, { action: "LOST", reason: "STOCK_REFUSED" });
      assert.strictEqual(voids, voidsBefore, "no void before the LOST");
      assert.strictEqual(offerOf(idC).state, S.LOST);
      assert.strictEqual(offerOf(idC).endReason, "STOCK_REFUSED");
      assert.strictEqual(stock("st-c"), undefined);
    }));

  needsDriver("OI2 tiers-3a ore pre-check = refineOre rule: one mineral at the cap -> LOST before void "
    + "deliver tx ORE_BELOW_PORTION", () => H.withStore(driver, async (reopen) => {
    const opened = reopen();
    const shared = H.sharedOf();
    const clock = shared.clock;
    const at = clock.now();
    const journal = createJournal({ clock, maxPayloadBytes: 16384, maxRows: 500 });
    const budgets = createBudgetRepository({ journal, clock });
    const catalog = buildTradeCatalog({ oreTypes: ORE_TYPES, factsRead: readItemTypeFactsFrom(REGISTRY, [1230, 1228]),
      oreOffersEnabled: true });
    const offers = createOfferRepository({ journal, budgets, ids: shared.ids, clock, catalog });
    const adapter = createFakeTradeAdapter();
    let voids = 0;
    const realVoid = adapter.tradeVoidStack;
    adapter.tradeVoidStack = (spec) => { voids += 1; return realVoid(spec); };
    const logs = [];
    const tx = (fn) => { const r = opened.store.transaction("test", fn); assert.ok(r.ok, JSON.stringify(r)); return r.value; };
    const CAP = 1000;
    const deps = { store: opened.store, journal, offers, adapter, clock, telemetry: null, catalog,
      logger: { log(m) { logs.push(String(m)); } },
      config: { ...DEFAULTS, trade: { ...DEFAULTS.trade, enabled: true, intakeGraceMs: GRACE,
        oreRefineEfficiencyPermille: 800 }, stations: { ...DEFAULTS.stations, maxStockQuantity: CAP } } };
    const offerOf = (id) => tx((db) => offers.getOffer(db, id)).offer;
    const stockOf = (stationId, key) => tx((db) => db.prepare("SELECT quantity FROM world_station_stock WHERE"
      + " station_id = ? AND item_kind = 'mineral' AND item_key = ?").get(stationId, key));
    const station = (npc) => ({ stationId: npc, kind: "npc", ownerCorporationId: CORP, systemId: SYSTEM, destroyed: false });
    const scordite = { itemKey: "type:1228", typeId: 1228 };
    fund(tx, budgets, at);

    insertStation(tx, "st-d", 61000004, at);
    tx((db) => db.prepare("INSERT INTO world_station_stock (station_id, item_kind, item_key, quantity, updated_at)"
      + " VALUES ('st-d', 'mineral', 'type:35', ?, ?)").run(CAP, at));
    const idD = acceptedOreOffer(tx, offers, "st-d", 200, at, scordite);
    adapter._addHangarStack(CORP, 61000004, 7004, 1228, 200);
    clock.advance(2000 + GRACE + 1);
    assert.strictEqual((await stepAccepted(deps, offerOf(idD), station(61000004))).action, "PLAN");
    const planD = tx((db) => journal.findByKey(db, S.intakeOutboxKey(idD))).entry.payload;
    assert.deepStrictEqual(planD.ore.minerals, [["type:34", 150], ["type:35", 110]]);
    const voidsBefore = voids;
    const lost = await stepIntake(deps, offerOf(idD));
    assert.deepStrictEqual(lost, { action: "LOST", reason: "STOCK_REFUSED" });
    assert.strictEqual(voids, voidsBefore, "no tradeVoidStack before the LOST");
    assert.ok(logs.some((m) => m.includes("before void (STOCK_CAP)")), logs.join("\n"));
    assert.strictEqual(offerOf(idD).state, S.LOST);
    assert.strictEqual(offerOf(idD).endReason, "STOCK_REFUSED");
    assert.strictEqual(stockOf("st-d", "type:34"), undefined, "no partial credit");
    assert.strictEqual(stockOf("st-d", "type:35").quantity, CAP);
    const left = await adapter.tradeVoidStack({ ownerKind: S.ISSUER_KIND_CORPORATION, ownerId: CORP,
      npcStationId: 61000004, itemId: 7004, quantity: 200, key: S.voidKey("probe-oi2", 7004) });
    assert.strictEqual(left.outcome, "VOIDED", "the ore stays in the hangar after the LOST");

    insertStation(tx, "st-e", 61000005, at);
    const idE = acceptedOreOffer(tx, offers, "st-e", 200, clock.now() - 2000 - GRACE - 1);
    adapter._addHangarStack(CORP, 61000005, 7005, 1230, 100);
    adapter._addHangarStack(CORP, 61000005, 7006, 1230, 50);
    assert.strictEqual((await stepAccepted(deps, offerOf(idE), station(61000005))).action, "PLAN");
    adapter._addHangarStack(CORP, 61000005, 7005, 1230, 0);
    const lostE = await stepIntake(deps, offerOf(idE));
    assert.deepStrictEqual(lostE, { action: "LOST", reason: "STOCK_REFUSED" });
    assert.ok(logs.some((m) => m.includes("stock refused (ORE_BELOW_PORTION)")), logs.join("\n"));
    assert.strictEqual(offerOf(idE).state, S.LOST);
    assert.strictEqual(stockOf("st-e", "type:34"), undefined);
  }));
};
