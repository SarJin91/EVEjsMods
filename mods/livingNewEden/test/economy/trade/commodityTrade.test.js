"use strict";

const assert = require("node:assert");
const path = require("node:path");

const config = require("../../../config");
const DATA = require("../../../lib/economy/data/commodities");
const ORE_TYPES = require("../../../lib/economy/data/oreTypes");
const HULL_TYPES = require("../../../lib/economy/data/hullTradeTypes");
const HULL_RECIPES_DATA = require("../../../lib/economy/data/hullRecipes");
const S = require("../../../lib/economy/trade/schema");
const { buildTradeCatalog, commodityCandidates, MAX_CATALOG_TYPES } = require("../../../lib/economy/trade/tradeCatalog");
const { buildCatalog } = require("../../../lib/economy/trade");
const { MAX_TYPES } = require("../../../lib/adapter/externalPrices");
const { quoteCommoditySell } = require("../../../lib/economy/trade/pricing");
const { chooseChannel } = require("../../../lib/economy/trade/marketRules");
const { createOfferRepository } = require("../../../lib/economy/trade/offerRepository");
const { createJournal } = require("../../../lib/persistence/journal");
const { createBudgetRepository } = require("../../../lib/economy/trade/budgetRepository");
const { createTradeExecutor } = require("../../../lib/economy/trade/tradeExecutor");
const { planTrade } = require("../../../lib/strategy/ai/trade");
const { commoditySellCandidates, planCommoditySells } = require("../../../lib/strategy/ai/tradeCommodities");
const { rowBoundsOfConfig } = require("../../../lib/strategy/reviewBound");
const { HULL_GROUPS } = require("../../../lib/fleets/schema");
const { createFakeTradeAdapter } = require("../../_support/fakeTradeAdapter");
const { harness: H } = require("../../battle/settlement.test");
const { harness: W } = require("../tradeSellEscrow.test");

const MOD_DIR = path.resolve(__dirname, "..", "..", "..");
const MOON = 16633;
const PI = 2312;
const MOON_KEY = `type:${MOON}`;
const PI_KEY = `type:${PI}`;
const ALL_COMMODITY_IDS = [...Object.keys(DATA.MOON_MATERIAL_TIER),
  ...Object.keys(DATA.PI_TIER).filter((k) => DATA.PI_TIER[k] >= 1)].map(Number);

function factsOf(ids, skip = []) {
  return { ok: true, facts: new Map(ids.filter((id) => !skip.includes(id)).map((id) => [id,
    { typeId: id, name: `T${id}`, volume: 0.05, portionSize: 1 }])) };
}
const commodityCatalog = (on = true) => buildTradeCatalog({ commodities: commodityCandidates(DATA, 96),
  commodityFacts: factsOf(ALL_COMMODITY_IDS), commodityOffersEnabled: on });

const F = 500019;
const CORP = 999999;
const NPC_CORP = 1000123;
const SYSTEM = 30000001;
const AT = 1000000;
const TTL = 259200000;
let clockNow = AT;
const CLOCK = { now: () => clockNow };
let idCounter = 0;
const IDS = { next: (p) => `${p}_${++idCounter}` };
const VENDOR_VOID = { ok: true, mode: "VENDOR_VOID", npcCorpMin: 1000000, npcCorpMax: 2000000 };

function insertStation(store, stationId, npcStationId) {
  const r = store.transaction("test.insertStation", (db) => db.prepare(
    "INSERT INTO world_stations (station_id, kind, npc_station_id, type_id, structure_family, system_id,"
    + "  owner_faction_id, owner_corporation_id, state, state_until_at, name, position_json, origin,"
    + "  evejs_item_id, destroyed_at, created_at, updated_at, version)"
    + " VALUES (?, 'npc', ?, 35834, 'Sansha', ?, ?, ?, 'ONLINE', NULL, 'MPT Station', '{\"x\":0,\"y\":0,\"z\":0}', 'seed',"
    + "  NULL, NULL, ?, ?, 1)").run(stationId, npcStationId, SYSTEM, F, CORP, AT, AT));
  assert.ok(r.ok, JSON.stringify(r));
}

function executorConfig() {
  return { trade: { enabled: true, contractsEnabled: true, cleanupOnDisable: false, walletAccountKey: 1006,
    contractTtlMs: TTL, executorPollMs: 60000, maxIssuesPerPass: 2, maxPollsPerPass: 16, maxClosesPerPass: 4,
    issueTimeoutMs: 1800000, priceRegionId: 10000002, maxPriceRegions: 8, priceRefreshMs: 1800000,
    maxIntakesPerPass: 4, intakeGraceMs: 600000, maxOrphansPerPass: 2, intakeMaxRetries: 100, buyOrdersEnabled: true,
    buyOrderWalletAccountKey: 1005, buyOrderTtlMs: TTL, buyOrderDurationDays: 7, buyOrderMinVolume: 1,
    maxBuyOrderPollsPerPass: 16, maxBuyOrderClosesPerPass: 4, maxBuyOrderOrphansPerPass: 0, maxRefundSweepsPerPass: 0,
    marketOrphanScanMs: 3600000, marketOrphanScanPage: 64 } };
}

const RECIPES = {};
for (const [group, data] of Object.entries(HULL_RECIPES_DATA.GROUPS)) RECIPES[group] = { minerals: { ...data.minerals } };
const STOCKED = Object.fromEntries([34, 35, 36, 37, 38, 39, 40].map((t) => [`type:${t}`, 1e9]));
const buyQuote = (unitMilli) => ({ ok: true, unitMilli, refMilli: unitMilli, capMilli: unitMilli * 2, source: "bid",
  capped: false });
const sellQuote = (unitMilli) => ({ ok: true, unitMilli, refMilli: unitMilli, capMilli: null, source: "ask" });

function station(stationId, systemId, extra = {}) {
  return { stationId, systemId, kind: "npc", ownerCorporationId: 1000001, lines: 0, activeJobs: [], minerals: {},
    hulls: {}, ...extra };
}
const STATIONS = () => [station("npc-1", 30000001, { lines: 1, minerals: { ...STOCKED }, hulls: { cruiser: 24, frigate: 10 },
  commodities: { [MOON_KEY]: 1000 } }), station("npc-2", 30000002, { commodities: { [PI_KEY]: 1000 } })];

function commodity(over = {}) {
  return { ok: true, enforced: { fuel: true, advanced: false },
    needs: [
      { stationId: "npc-2", kind: "npc", itemKind: "pi", itemKey: PI_KEY, typeId: PI, need: 500 },
      { stationId: "npc-1", kind: "npc", itemKind: "moon", itemKey: MOON_KEY, typeId: MOON, need: 200 },
      { stationId: "up-1", kind: "upwell", itemKind: "pi", itemKey: PI_KEY, typeId: PI, need: 61 }],
    reserve: { "npc-1": { [MOON_KEY]: 400 }, "npc-2": { [PI_KEY]: 1000 } },
    kinds: { [MOON_KEY]: "moon", [PI_KEY]: "pi" },
    quotes: { [PI_KEY]: buyQuote(500000), [MOON_KEY]: buyQuote(1000000) },
    sellQuotes: { [PI_KEY]: sellQuote(2000000), [MOON_KEY]: sellQuote(1200000) },
    ...over };
}

function snapshot(trade = {}, stations = STATIONS()) {
  return {
    at: AT, seed: 1, factionId: 500019,
    faction: { status: "ACTIVE", homeSystemId: 30000001, doctrineId: "test-v1", version: 1 },
    doctrine: { doctrineId: "test-v1", templates: { combat: [{ hullGroup: "cruiser", count: 24 },
      { hullGroup: "frigate", count: 10 }] } },
    stationsMode: "ready",
    stations: stations.map((s) => ({ stationId: s.stationId, systemId: s.systemId, kind: s.kind,
      ownerCorporationId: s.ownerCorporationId })),
    neighbors: () => [], supply: { frontTargets: [30000001] },
    production: { mode: "ready", recipes: RECIPES, recipesVersion: 1, stations, inProduction: {}, activeJobsTotal: 0,
      truncated: false },
    logistics: { mode: "ready", open: [], busyFleetIds: [], carriers: {}, truncated: false },
    trade: { mode: "ready", galaxy: { open: 0, factions: 7 }, budget: { availableIsk: 100000000, reservedIsk: 0 },
      open: [], openTruncated: false,
      stations: stations.map((s) => ({ stationId: s.stationId, systemId: s.systemId,
        ownerCorporationId: s.ownerCorporationId, kind: s.kind })),
      quotes: {}, privateQuotes: {}, suppliers: [], hulls: null, sellQuotes: {}, buyUnitMax: {}, ...trade },
  };
}

const BASE_TRADE = { premiumPermille: 1100, askCapPermille: 980, maxOffersPerReview: 4, maxCancelsPerReview: 4,
  maxOpenOffersPerFaction: 32, maxOpenOffersPerStation: 8, maxQuantityPerOffer: 10000000, minIskPerOffer: 100000,
  maxIskPerOffer: 200000000, offerTtlMs: TTL, factoryRunsTarget: 2, maxUnitPriceMilli: 1000000000000,
  priceCacheMs: 3600000, warReservedOffersPerFaction: 4, wtsEnabled: true, wtsTtlMs: TTL, wtsOffersPerReview: 2,
  wtsMaxOpenPerFaction: 8, wtsStationSlotHeadroom: 1, wtsMineralSurplusRuns: 16, wtsHullSurplusPermille: 2000,
  wtsAskPermille: 1050, wtsBidPermille: 1100, wtsMaxIskPerOffer: 500000000 };
const COMMODITY_T = { commodityOffersEnabled: true, commodityOffersPerReview: 4, commodityFloatPermille: 100,
  commodityMinSellUnits: 10 };

function params(trade = {}) {
  return { trade: { ...BASE_TRADE, ...trade },
    production: { maxJobsPerReview: 2, maxRunsPerJob: 4, maxActiveJobsPerFaction: 8, targetStockFleets: 1,
      mobilizeHulls: "required", miningNeedsHulls: false, logisticsNeedsHulls: false, mobilizationStations: 1,
      hullGroups: HULL_GROUPS },
    maxAssemblyJumps: 15, maxBfsSystems: 2000 };
}
const plan = (snap, p) => planTrade(snap, p, { intents: [] }, { intents: [] });
const isCommodity = (i) => i.type === "TRADE_OFFER" && (i.itemKind === "moon" || i.itemKind === "pi");
const buys = (r) => r.intents.filter((i) => isCommodity(i) && i.side === undefined);
const commoditySells = (r) => r.intents.filter((i) => isCommodity(i) && i.side === "sell");

module.exports = ({ test, skip }) => {
  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  test("MPT1 catalog: flag off = catalog of before (no fact read); on = 20 moon + 68 pi, chunks 64 + 24, limits 192, "
    + "missing, truncated, commodityKinds", () => {
    assert.strictEqual(MAX_CATALOG_TYPES, 192);
    assert.strictEqual(MAX_TYPES, 192);
    const cand = commodityCandidates(DATA, 96);
    assert.strictEqual(cand.take.length, 88);
    assert.deepStrictEqual([cand.take.filter((c) => c.kind === "moon").length,
      cand.take.filter((c) => c.kind === "pi").length], [20, 68]);
    assert.deepStrictEqual(cand.take.map((c) => c.typeId), [...cand.take.map((c) => c.typeId)].sort((a, b) => a - b));
    assert.strictEqual(commodityCandidates(null, 96), null);

    const spec = { oreTypes: ORE_TYPES, factsRead: null, hullTypes: HULL_TYPES, hullRecipes: HULL_RECIPES_DATA,
      hullOffersEnabled: true };
    const before = buildTradeCatalog(spec);
    const off = buildTradeCatalog({ ...spec, commodities: cand, commodityFacts: factsOf(ALL_COMMODITY_IDS),
      commodityOffersEnabled: false });
    assert.deepStrictEqual([off.entries, off.priceTypeIds, off.volumes], [before.entries, before.priceTypeIds,
      before.volumes]);
    assert.deepStrictEqual([off.offerable("moon", MOON_KEY, MOON), off.get(MOON_KEY), off.summary.commodityState,
      off.commodityKinds], [false, null, "off", {}]);

    const calls = [];
    const adapter = { readItemTypeFacts: (ids) => { calls.push(ids.length); return factsOf(ids, [PI]); } };
    const logs = [];
    const logger = { log: (l) => logs.push(l) };
    const offCat = buildCatalog(adapter, { oreOffersEnabled: false, hullOffersEnabled: true }, logger);
    assert.deepStrictEqual(calls, [24]);
    assert.strictEqual(offCat.summary.commodities, 0);
    assert.ok(logs[0].endsWith(" commodities=0 commodityState=off"), logs[0]);
    calls.length = 0;
    const on = buildCatalog(adapter, { oreOffersEnabled: false, hullOffersEnabled: true, commodityOffersEnabled: true,
      maxCommodityTypes: 96 }, logger);
    assert.deepStrictEqual(calls, [24, 64, 24], "ores, then commodity facts in chunks <= 64");
    assert.deepStrictEqual(on.summary.commodityMissing, [PI], "no fact -> commodityMissing");
    assert.strictEqual(on.summary.commodities, 87);
    assert.ok(on.priceTypeIds.length <= 192);
    assert.ok(/ commodities=87 commodityState=on commodityMissing=1$/.test(logs[1]), logs[1]);
    assert.strictEqual(on.offerable("pi", PI_KEY, PI), false, "missing type is not offerable");

    const full = commodityCatalog();
    assert.strictEqual(full.entries.filter((e) => e.itemKind === "moon" || e.itemKind === "pi").length, 88);
    assert.deepStrictEqual(full.get(MOON_KEY), { itemKind: "moon", itemKey: MOON_KEY, typeId: MOON, name: `T${MOON}`,
      volumeUnits: 5, portionSize: 1 });
    assert.strictEqual(full.volumes[PI_KEY], 5);
    assert.ok(full.priceTypeIds.includes(MOON) && full.priceTypeIds.includes(PI));
    assert.deepStrictEqual([full.offerable("moon", MOON_KEY, MOON), full.offerable("pi", PI_KEY, PI),
      full.offerable("pi", MOON_KEY, MOON), full.offerable("moon", MOON_KEY, PI)], [true, true, false, false]);
    assert.deepStrictEqual([full.commodityKinds[MOON_KEY], full.commodityKinds[PI_KEY],
      Object.keys(full.commodityKinds).length], ["moon", "pi", 88]);
    const ten = buildTradeCatalog({ commodities: commodityCandidates(DATA, 10), commodityFacts: factsOf(ALL_COMMODITY_IDS),
      commodityOffersEnabled: true });
    assert.deepStrictEqual([ten.summary.commodities, ten.summary.commodityTruncated.length], [10, 78]);
    assert.strictEqual(buildTradeCatalog({ commodities: cand, commodityFacts: null, commodityOffersEnabled: true })
      .summary.commodityState, "no_seam");
  });

  needsDriver("MPT2 repository and channel: moon buy by contract, flag off refused, market at create refused, pi escrow "
    + "on the pi row, market edge only with allowCommodityMarket, chooseChannel", () => H.withStore(driver, async (reopen) => {
    const shared = H.sharedOf();
    const env = await W.boot(reopen(), shared);
    W.addStation(env, "npc-a", H.FACTION_A);
    const seedPi = env.tx((db) => env.repo.applyStockChange(db, { stationId: "npc-a", key: "mpt2:seed:pi",
      reason: "TEST", at: env.at, deltas: [{ itemKind: "pi", itemKey: PI_KEY, delta: 5000 }] }));
    assert.ok(seedPi.ok, JSON.stringify(seedPi));
    env.tx((db) => env.budgets.fundInTx(db, { factionId: H.FACTION_A, units: 100, paidUntilTo: env.at,
      iskPerUnit: 1000000, capIsk: 1e12, at: env.at }, "mpt2:fund"));
    const repoOf = (catalog) => createOfferRepository({ journal: env.journal, budgets: env.budgets, ids: shared.ids,
      clock: shared.clock, catalog, getStockRepository: () => env.repo });
    const on = repoOf(commodityCatalog(true));
    const off = repoOf(commodityCatalog(false));
    const spec = (over) => ({ ...W.buySpec(env, "npc-a", MOON_KEY, 100), itemKind: "moon", ...over });
    const create = (repo, s, key) => env.tx((db) => repo.createOfferInTx(db, s, key));
    const refused = { ok: false, reason: "TRADE_INVALID_INPUT", detail: "commodity" };

    assert.deepStrictEqual(create(off, spec(), "mpt2:off:offer"), refused, "flag off -> not offerable");
    assert.deepStrictEqual(create(on, spec({ channel: "market" }), "mpt2:mk:offer"), refused, "market at create");
    assert.deepStrictEqual(create(on, spec({ itemKind: "pi" }), "mpt2:kind:offer"), refused, "kind of the entry");
    const buy = create(on, spec(), "mpt2:buy:offer");
    assert.ok(buy.ok && buy.offer.itemKind === "moon" && buy.offer.side === "buy", JSON.stringify(buy));

    const toIssuing = (extra, key) => env.tx((db) => on.transitionOfferInTx(db, { offerId: buy.offer.offerId,
      expectedVersion: 1, from: S.PLANNED, to: S.ISSUING, reason: "", at: env.at,
      patch: { expiresAt: env.at + TTL, channel: S.CHANNEL_MARKET }, ...extra }, key));
    assert.deepStrictEqual(toIssuing({}, "mpt2:iss:a"), { ok: false, reason: "TRADE_INVALID_INPUT",
      detail: "channel:market" });
    assert.deepStrictEqual(toIssuing({ allowHullMarket: true }, "mpt2:iss:b").detail, "channel:market");
    const iss = toIssuing({ allowCommodityMarket: true }, "mpt2:iss:c");
    assert.ok(iss.ok && iss.offer.channel === S.CHANNEL_MARKET, JSON.stringify(iss));

    const piRow = () => env.tx((db) => db.prepare("SELECT item_kind AS k, quantity AS q FROM world_station_stock "
      + "WHERE station_id = 'npc-a' AND item_key = ?").all(PI_KEY).map((r) => `${r.k}:${r.q}`));
    const sell = create(on, { ...W.sellSpec(env, "npc-a", PI_KEY, 1000), itemKind: "pi" }, "mpt2:sell:offer");
    assert.ok(sell.ok && sell.offer.side === "sell", JSON.stringify(sell));
    assert.deepStrictEqual(piRow(), ["pi:4000"]);
    const cancel = env.tx((db) => on.transitionOfferInTx(db, { offerId: sell.offer.offerId, expectedVersion: 1,
      from: S.PLANNED, to: S.CANCELLED, reason: S.END_REASON_EXPIRED, at: env.at }, "mpt2:sell:cancel"));
    assert.ok(cancel.ok && cancel.stockBack && cancel.stockBack.credited === 1000, JSON.stringify(cancel));
    assert.deepStrictEqual(piRow(), ["pi:5000"]);

    const flags = (over) => ({ buyOrdersEnabled: true, contractsEnabled: true, marketReady: true, marketDown: false,
      commodityBuyOrdersEnabled: true, ...over });
    const offer = (over) => ({ side: "buy", itemKind: "moon", itemKey: MOON_KEY, typeId: MOON, unitPriceMilli: 1000000,
      assigneeCharacterId: null, issuerCharacterId: null, ...over });
    const npc = { kind: "npc" };
    assert.strictEqual(chooseChannel(offer(), npc, flags()), S.CHANNEL_MARKET);
    assert.strictEqual(chooseChannel(offer({ itemKind: "pi" }), npc, flags()), S.CHANNEL_MARKET);
    assert.strictEqual(chooseChannel(offer(), npc, flags({ commodityBuyOrdersEnabled: false })), S.CHANNEL_CONTRACT);
    assert.strictEqual(chooseChannel(offer(), npc, flags({ commodityBuyOrdersEnabled: undefined, hullBuyOrdersEnabled: true })),
      S.CHANNEL_CONTRACT);
    assert.strictEqual(chooseChannel(offer({ side: "sell" }), npc, flags()), S.CHANNEL_CONTRACT);
    assert.strictEqual(chooseChannel(offer(), { kind: "upwell" }, flags()), S.CHANNEL_CONTRACT);
  }));

  needsDriver("MPT3 intake: market moon vendor-void -> moon stock; contract pi stacks -> pi stock; mineral unchanged",
    () => H.withStore(driver, async (reopen) => {
      const opened = reopen();
      clockNow = AT;
      insertStation(opened.store, "mpt-st", 60004001);
      const journal = createJournal({ clock: CLOCK, maxPayloadBytes: 16384, maxRows: 500 });
      const budgets = createBudgetRepository({ journal, clock: CLOCK });
      const offers = createOfferRepository({ journal, budgets, ids: IDS, clock: CLOCK, catalog: commodityCatalog() });
      const tx = (fn) => { const r = opened.store.transaction("test", fn); assert.ok(r.ok, JSON.stringify(r)); return r.value; };
      tx((db) => budgets.fundInTx(db, { factionId: F, units: 100000, paidUntilTo: AT, iskPerUnit: 1000,
        capIsk: 1000000000, at: AT }, "fund:1"));
      const adapter = createFakeTradeAdapter({}, { marketFillMode: VENDOR_VOID });
      const step = (offerId, from, to, version, patch, extra) => {
        const r = tx((db) => offers.transitionOfferInTx(db, { offerId, expectedVersion: version, from, to, reason: "",
          at: AT + version * 1000, patch, ...extra }, S.transitionKey(offerId, version, to)));
        assert.ok(r.ok, JSON.stringify(r));
      };
      const create = (over) => {
        const r = tx((db) => offers.createOfferInTx(db, { factionId: F, stationId: "mpt-st", systemId: SYSTEM,
          issuerCorporationId: NPC_CORP, itemKind: "mineral", itemKey: "type:34", typeId: 34, quantity: 100,
          unitPriceMilli: 1000000, iskTotal: 100000, refPriceMilli: 1000000, capPriceMilli: 2000000, priceSource: "bid",
          expiresAt: AT + TTL, at: AT, ...over }, `mpt3:${++idCounter}:offer`));
        assert.ok(r.ok, JSON.stringify(r));
        return r.offer.offerId;
      };
      const market = (over, filled) => {
        const id = create(over);
        step(id, S.PLANNED, S.ISSUING, 1, { expiresAt: AT + TTL, channel: "market" }, { allowCommodityMarket: true });
        step(id, S.ISSUING, S.OPEN, 2, { marketOrderId: `ord-${id}` });
        step(id, S.OPEN, S.ACCEPTED, 3, { filledQuantity: filled, acceptorCharacterId: null });
        return id;
      };
      const moonId = market({ itemKind: "moon", itemKey: MOON_KEY, typeId: MOON }, 60);
      const mineralId = market({}, 40);
      const piId = create({ itemKind: "pi", itemKey: PI_KEY, typeId: PI, issuerCorporationId: CORP, quantity: 70,
        iskTotal: 70000 });
      step(piId, S.PLANNED, S.ISSUING, 1, { expiresAt: AT + TTL });
      step(piId, S.ISSUING, S.OPEN, 2, { contractId: 7001 });
      step(piId, S.OPEN, S.ACCEPTED, 3, { acceptorCharacterId: null });
      adapter._addHangarStack(CORP, 60004001, 1001, PI, 70);

      const executor = createTradeExecutor({ store: opened.store, journal, offers, budgets, adapter,
        priceCache: { put() {}, peek() { return null; } }, config: executorConfig(), clock: CLOCK, mode: "run",
        getStations: () => ({ getMode: () => "ready", getStatus: () => ({ mode: "ready" }), getStation: () => null,
          listStationsInSystem: () => [] }),
        getGovernor: () => ({ admits: () => true }), factionNames: new Map([[F, "Sansha"]]), telemetry: null,
        logger: { log() {} }, getGraph: () => ({ getRegionForSystem: () => 10000002 }) });
      for (let i = 0; i < 2; i += 1) {
        clockNow += 10000;
        const res = await executor.runPass();
        assert.strictEqual(res.errors, 0, JSON.stringify(res));
      }
      executor.stop();
      const states = [moonId, mineralId, piId].map((id) => {
        const o = tx((db) => offers.getOffer(db, id)).offer;
        return `${o.state}:${o.deliveredQuantity}`;
      });
      assert.deepStrictEqual(states, ["DELIVERED:60", "DELIVERED:40", "DELIVERED:70"]);
      const stock = tx((db) => db.prepare("SELECT item_kind AS k, item_key AS key, quantity AS q FROM world_station_stock "
        + "WHERE station_id = 'mpt-st' ORDER BY item_kind, item_key").all().map((r) => `${r.k}:${r.key}:${r.q}`));
      assert.deepStrictEqual(stock, [`mineral:type:34:40`, `moon:${MOON_KEY}:60`, `pi:${PI_KEY}:70`]);
    }));

  test("MPT4 buy planner 6c: npc needs in readNeeds order, Upwell note, limits, budget, pair, no price, deterministic, "
    + "refused read, flag off bit for bit", () => {
    const p = params(COMMODITY_T);
    const r = plan(snapshot({ commodity: commodity() }), p);
    assert.deepStrictEqual(buys(r).map((i) => [i.itemKind, i.itemKey, i.stationId, i.quantity, i.iskTotal]),
      [["pi", PI_KEY, "npc-2", 500, 250000], ["moon", MOON_KEY, "npc-1", 200, 200000]], JSON.stringify(r.notes));
    assert.deepStrictEqual(buys(r)[0], { type: "TRADE_OFFER", slot: buys(r)[0].slot, stationId: "npc-2",
      systemId: 30000002, issuerCorporationId: 1000001, itemKind: "pi", itemKey: PI_KEY, typeId: PI, quantity: 500,
      unitPriceMilli: 500000, iskTotal: 250000, refPriceMilli: 500000, capPriceMilli: 1000000, priceSource: "bid",
      expiresAt: AT + TTL });
    assert.ok(r.notes.includes("TRADE_COMMODITY_UPWELL:1") && r.notes.includes(`TRADE_COMMODITY_BUY:${PI_KEY}@npc-2`));
    assert.deepStrictEqual(plan(snapshot({ commodity: commodity() }), p), r, "deterministic");
    const upNeeds = [MOON, PI, MOON + 1].map((typeId, i) => ({ stationId: "up-1", kind: "upwell", itemKind: "pi",
      itemKey: `type:${typeId}`, typeId, need: 10 + i }));
    const fallback = plan(snapshot({ commodity: commodity({ needs: upNeeds }) }), p);
    assert.ok(fallback.notes.includes("TRADE_COMMODITY_UPWELL:1"), JSON.stringify(fallback.notes));
    const zero = plan(snapshot({ commodity: commodity({ needs: upNeeds, noDonorStations: 0 }) }), p);
    assert.ok(!zero.notes.some((n) => n.startsWith("TRADE_COMMODITY_UPWELL")), JSON.stringify(zero.notes));

    const one = plan(snapshot({ commodity: commodity() }), params({ ...COMMODITY_T, commodityOffersPerReview: 1 }));
    assert.deepStrictEqual([buys(one).length, one.notes.includes("TRADE_COMMODITY_LIMIT")], [1, true]);
    const poor = plan(snapshot({ commodity: commodity(), budget: { availableIsk: 150000, reservedIsk: 0 } }), p);
    assert.deepStrictEqual(buys(poor).map((i) => [i.itemKey, i.quantity, i.iskTotal]), [[PI_KEY, 300, 150000]]);
    assert.ok(poor.notes.includes("TRADE_COMMODITY_LIMIT"));
    const open = [{ offerId: "to_x", stationId: "npc-2", itemKey: PI_KEY, typeId: PI, quantity: 1, state: "OPEN",
      version: 2, expiresAt: AT + 1e9, iskTotal: 5000, issuerCorporationId: 1000001, assigneeCharacterId: null }];
    const taken = plan(snapshot({ commodity: commodity({ quotes: { [PI_KEY]: buyQuote(500000) } }), open }), p);
    assert.deepStrictEqual(buys(taken), []);
    assert.ok(taken.notes.includes(`TRADE_OFFER_EXISTS:${PI_KEY}@npc-2`)
      && taken.notes.includes(`TRADE_COMMODITY_NO_PRICE:${MOON_KEY}`), JSON.stringify(taken.notes));

    const refused = plan(snapshot({ commodity: { ok: false, reason: "EXTRACTION_UNAVAILABLE" } }), p);
    assert.deepStrictEqual([buys(refused).length, refused.notes.filter((n) => n.startsWith("TRADE_COMMODITY"))],
      [0, ["TRADE_COMMODITY_OFF:EXTRACTION_UNAVAILABLE"]]);
    const without = plan(snapshot(), params());
    assert.deepStrictEqual(plan(snapshot({ commodity: commodity() }), params()), without);
    assert.deepStrictEqual(plan(snapshot(), p), without, "flag on without trade.commodity = no step");
  });

  test("MPT5 WTS price, sell candidates (surplus / float / need / min / no reserve), maxNew, wtsEnabled off, "
    + "reviewRowBound unchanged", () => {
    const P = { sellAskPermille: 980, sellBidFloorPermille: 1020, maxUnitPriceMilli: 1e12 };
    const q = (bidMilli, askMilli) => quoteCommoditySell({ bidMilli, askMilli, baseMilli: null }, P);
    assert.deepStrictEqual(q(900, 1000), { ok: true, unitMilli: 980, refMilli: 1000, capMilli: null, source: "ask" });
    assert.deepStrictEqual(q(990, 1000), { ok: false, reason: "SPREAD_TOO_TIGHT" });
    assert.strictEqual(q(null, 1000).unitMilli, 980);
    assert.deepStrictEqual(q(900, null), { ok: false, reason: "NO_PRICE" });

    const T = { ...BASE_TRADE, ...COMMODITY_T };
    const cand = (c, stations = STATIONS()) => commoditySellCandidates({ trade: snapshot({ commodity: c }, stations).trade,
      T, stationsData: stations });
    const base = cand(commodity({ needs: [] }));
    assert.deepStrictEqual(base.candidates.map((c) => [c.stationId, c.itemKind, c.itemKey, c.surplus]),
      [["npc-1", "moon", MOON_KEY, 600], ["npc-2", "pi", PI_KEY, 100]]);
    assert.deepStrictEqual(cand(commodity()).candidates.map((c) => c.stationId), []);
    assert.deepStrictEqual(commoditySellCandidates({ trade: snapshot({ commodity: commodity({ needs: [] }) }).trade,
      T: { ...T, commodityMinSellUnits: 101 }, stationsData: STATIONS() }).candidates.map((c) => c.surplus), [600]);
    const noRes = cand(commodity({ needs: [], reserve: { "npc-1": {} } }));
    assert.deepStrictEqual([noRes.candidates.map((c) => c.stationId), noRes.notes],
      [["npc-1"], ["TRADE_COMMODITY_NO_RESERVE:npc-2"]]);
    const noDemand = cand(commodity({ needs: [], reserve: {}, enforced: { fuel: false, advanced: false } }));
    assert.deepStrictEqual(noDemand.candidates.map((c) => c.surplus), [1000, 1000]);

    const sellArgs = (newOffers, usedBuys, over = {}) => {
      const s = snapshot({ commodity: commodity({ needs: [] }) });
      const intents = [];
      const state = { budgetLeft: 1e9, openFactionCount: 0, openPerStation: new Map(), offersCreated: newOffers.length };
      const out = planCommoditySells({ trade: s.trade, T: { ...T, maxOffersPerReview: 8, ...over }, at: AT,
        newOffers: [...newOffers], state, intents, notes: [], volCap: () => T.maxQuantityPerOffer,
        stationsData: s.production.stations, usedBuys });
      return { maxNew: out.maxNew, sells: intents.length };
    };
    const mineralSell = { side: "sell", stationId: "npc-9", itemKey: "type:34", typeId: 34, unitPriceMilli: 1 };
    assert.deepStrictEqual(sellArgs([], 0), { maxNew: 2, sells: 2 });
    assert.deepStrictEqual(sellArgs([mineralSell], 0), { maxNew: 1, sells: 1 });
    assert.deepStrictEqual(sellArgs([], 3), { maxNew: 1, sells: 1 });
    assert.deepStrictEqual(sellArgs([], 4), { maxNew: 0, sells: 0 });

    const snap = () => snapshot({ commodity: commodity({ needs: [] }) });
    const on = plan(snap(), params({ ...COMMODITY_T, maxOffersPerReview: 8 }));
    assert.deepStrictEqual(commoditySells(on).map((i) => [i.itemKey, i.stationId, i.quantity, i.unitPriceMilli]),
      [[MOON_KEY, "npc-1", 600, 1200000], [PI_KEY, "npc-2", 100, 2000000]]);
    assert.deepStrictEqual(commoditySells(plan(snap(), params({ ...COMMODITY_T, wtsEnabled: false }))), []);

    const boundOf = (env) => rowBoundsOfConfig(config.resolveConfig({ modDir: MOD_DIR,
      env: { EVEJS_LNE_TRADE_ENABLED: "1", EVEJS_LNE_TRADE_WTS_ENABLED: "1", ...env } }).config).review;
    const off = boundOf({});
    assert.ok(Number.isSafeInteger(off) && off > 0);
    assert.strictEqual(boundOf({ EVEJS_LNE_TRADE_COMMODITY_OFFERS_ENABLED: "1",
      EVEJS_LNE_TRADE_COMMODITY_BUY_ORDERS_ENABLED: "1" }), off);
  });
};
