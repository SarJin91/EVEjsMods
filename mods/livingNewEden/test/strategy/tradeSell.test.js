"use strict";

const assert = require("node:assert");
const path = require("node:path");

const config = require("../../config");
const { planTrade, tierStateOf } = require("../../lib/strategy/ai/trade");
const { hullCandidates } = require("../../lib/strategy/ai/tradeHulls");
const { quoteSell } = require("../../lib/economy/trade/pricing");
const { createTradeService } = require("../../lib/economy/trade/tradeService");
const { buildTradeView } = require("../../lib/economy/trade/tradeView");
const { reviewRowBound } = require("../../lib/strategy/reviewRows");
const { createReviewService } = require("../../lib/strategy/reviewService");
const { NOTE_DICTIONARY } = require("../../lib/strategy/activity/notes");
const TS = require("../../lib/economy/trade/schema");
const { HULL_GROUPS } = require("../../lib/fleets/schema");
const { GROUPS: HULL_RECIPES } = require("../../lib/economy/data/hullRecipes");
const HULL_TYPES = require("../../lib/economy/data/hullTradeTypes");
const { harness: H } = require("../battle/settlement.test");
const { harness: W } = require("../economy/tradeSellEscrow.test");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const AT = 1000000;
const MINERALS = [34, 35, 36, 37, 38, 39, 40];
const RECIPES = {};
for (const [group, data] of Object.entries(HULL_RECIPES)) RECIPES[group] = { minerals: { ...data.minerals } };
const STOCKED = Object.fromEntries(MINERALS.map((t) => [`type:${t}`, 1e9]));
const RACE = HULL_TYPES.RACES["4"];
const HULLS = { cruiser: { typeId: RACE.cruiser, itemKey: "group:cruiser" },
  frigate: { typeId: RACE.frigate, itemKey: "group:frigate" } };
const buyQuote = (unitMilli) => ({ ok: true, unitMilli, refMilli: unitMilli, capMilli: unitMilli * 2, source: "bid",
  capped: false });
const sellQuote = (unitMilli) => ({ ok: true, unitMilli, refMilli: unitMilli - 1, capMilli: null, source: "ask" });
const SELL_UNIT = { 34: 6000, 35: 12000, 36: 50000, 37: 150000, 38: 600000, 39: 420000, 40: 1050000 };
const SELL_QUOTES = { ...Object.fromEntries(MINERALS.map((t) => [`type:${t}`, sellQuote(SELL_UNIT[t])])),
  "group:cruiser": sellQuote(10500000000), "group:frigate": sellQuote(1050000000) };
const QUOTES = { ...Object.fromEntries(MINERALS.map((t) => [`type:${t}`, buyQuote(5000)])),
  "group:cruiser": buyQuote(10000000000), "group:frigate": buyQuote(1000000000) };
const keepOf = (t, runs = 16) => Math.max(RECIPES.cruiser.minerals[`type:${t}`], RECIPES.frigate.minerals[`type:${t}`])
  * runs;

function station(stationId, systemId, extra = {}) {
  return { stationId, systemId, kind: "npc", ownerCorporationId: 1000001, lines: 0, activeJobs: [], minerals: {},
    hulls: {}, ...extra };
}
const MOB = (extra = {}) => station("npc-1", 30000001, { lines: 1, minerals: { ...STOCKED },
  hulls: { cruiser: 24, frigate: 10 }, ...extra });

function snapshot({ stations, trade = {}, logistics, template } = {}) {
  const st = stations || [MOB(), station("npc-2", 30000002, { minerals: { "type:40": 3 * keepOf(40) } })];
  return {
    at: AT, seed: 1, factionId: 500019,
    faction: { status: "ACTIVE", homeSystemId: 30000001, doctrineId: "test-v1", version: 1 },
    doctrine: { doctrineId: "test-v1", templates: { combat: template || [{ hullGroup: "cruiser", count: 24 },
      { hullGroup: "frigate", count: 10 }] } },
    stationsMode: "ready",
    stations: st.map((s) => ({ stationId: s.stationId, systemId: s.systemId, kind: s.kind,
      ownerCorporationId: s.ownerCorporationId })),
    neighbors: () => [],
    supply: { frontTargets: [30000001] },
    production: { mode: "ready", recipes: RECIPES, recipesVersion: 1, stations: st, inProduction: {},
      activeJobsTotal: 0, truncated: false },
    logistics: logistics || { mode: "ready", open: [], busyFleetIds: [], carriers: {}, truncated: false },
    trade: {
      mode: "ready", galaxy: { open: 0, factions: 7 }, budget: { availableIsk: 100000000, reservedIsk: 0 },
      open: [], openTruncated: false,
      stations: st.map((s) => ({ stationId: s.stationId, systemId: s.systemId, ownerCorporationId: s.ownerCorporationId,
        kind: s.kind })),
      quotes: { ...QUOTES }, privateQuotes: {}, suppliers: [], hulls: HULLS,
      sellQuotes: { ...SELL_QUOTES }, buyUnitMax: {},
      ...trade,
    },
  };
}

const BASE_TRADE = {
  premiumPermille: 1100, askCapPermille: 980, maxOffersPerReview: 4, maxCancelsPerReview: 4,
  maxOpenOffersPerFaction: 32, maxOpenOffersPerStation: 8, maxQuantityPerOffer: 10000000, minIskPerOffer: 100000,
  maxIskPerOffer: 200000000, offerTtlMs: 259200000, factoryRunsTarget: 2, maxUnitPriceMilli: 1000000000000,
  priceCacheMs: 3600000, stockpileRecallEnabled: true, stockpileRecallMinNeedPermille: 1000,
  hullOffersEnabled: true, hullOffersPerReview: 1, hullMaxPerOffer: 4, warReservedOffersPerFaction: 4,
};
const STOCKPILE = { stockpileEnabled: true, stockpileRuns: 8, stockpileMaxIskPerOffer: 5000000,
  stockpileFreeFloorPermille: 300, targetOpenContracts: 200 };
const WTS = { wtsEnabled: true, wtsTtlMs: 259200000, wtsOffersPerReview: 1, wtsMaxOpenPerFaction: 8,
  wtsStationSlotHeadroom: 1, wtsMineralSurplusRuns: 16, wtsHullSurplusPermille: 2000, wtsAskPermille: 1050,
  wtsBidPermille: 1100, wtsMaxIskPerOffer: 500000000 };

function params(trade = {}, { wts = true, stockpile = false } = {}) {
  return {
    trade: { ...BASE_TRADE, ...(stockpile ? STOCKPILE : {}), ...(wts ? WTS : {}), ...trade },
    production: { maxJobsPerReview: 2, maxRunsPerJob: 4, maxActiveJobsPerFaction: 8, targetStockFleets: 1,
      mobilizeHulls: "required", miningNeedsHulls: false, logisticsNeedsHulls: false, mobilizationStations: 1,
      hullGroups: HULL_GROUPS },
    maxAssemblyJumps: 15, maxBfsSystems: 2000,
  };
}

const plan = (snap, p, production = { intents: [] }, logistics = { intents: [] }) =>
  planTrade(snap, p, production, logistics);
const sells = (r) => r.intents.filter((i) => i.type === "TRADE_OFFER" && i.side === "sell");
const recalls = (r) => r.intents.filter((i) => i.type === "TRADE_CANCEL" && i.reason === "RECALLED");
const openOffer = (over) => ({ offerId: "to_x", stationId: "npc-3", itemKey: "type:1230", typeId: 1230, quantity: 1,
  state: "OPEN", version: 2, expiresAt: AT + 1e9, iskTotal: 5000, issuerCorporationId: 1000001,
  assigneeCharacterId: null, ...over });
const sellOpen = (over) => openOffer({ offerId: "ts_x", side: "sell", ...over });
const NO_LOGISTICS = { mode: "off", open: [], busyFleetIds: [], carriers: {}, truncated: false };
const NO_HULL_WTB = { hullOffersPerReview: 0 };

module.exports = ({ test, skip }) => {
  test("WTN1 d4 regression: wtsEnabled false / no d4 keys / no sellQuotes = the planner without step 7; review rows "
    + "976 by default, 986 with trade.wtsEnabled", () => {
    const withMob = [MOB({ minerals: Object.fromEntries(MINERALS.filter((t) => t !== 34).map((t) => [`type:${t}`, 1e9])),
      hulls: {} }), station("npc-2", 30000002, { minerals: { "type:40": 3 * keepOf(40) } })];
    const snapOf = (withSell) => {
      const s = snapshot({ stations: withMob });
      if (!withSell) {
        delete s.trade.sellQuotes;
        delete s.trade.buyUnitMax;
      }
      return s;
    };
    const before = plan(snapOf(false), params({}, { wts: false, stockpile: true }));
    assert.ok(before.intents.some((i) => i.type === "TRADE_OFFER"), JSON.stringify(before));
    assert.deepStrictEqual(plan(snapOf(true), params({ wtsEnabled: false }, { stockpile: true })), before);
    assert.deepStrictEqual(plan(snapOf(true), params({}, { wts: false, stockpile: true })), before);
    assert.deepStrictEqual(plan(snapOf(false), params({}, { stockpile: true })), before);
    const on = plan(snapOf(true), params({ maxOffersPerReview: 8 }, { stockpile: true }));
    assert.strictEqual(sells(on).length, 1, JSON.stringify(on.notes));

    const rowsOf = (env) => {
      const c = config.resolveConfig({ modDir: MOD_DIR, env }).config;
      const t = { maxOffersPerReview: c.trade.maxOffersPerReview, maxCancelsPerReview: c.trade.maxCancelsPerReview,
        ...(c.trade.wtsEnabled === true ? { wtsOffersPerReview: c.trade.wtsOffersPerReview } : {}) };
      return reviewRowBound(c.strategy, c.mining, c.production, { maxAbandonsPerReview: c.upkeep.maxAbandonsPerReview,
        maxFactionsPerSystem: c.world.maxFactionsPerSystem }, c.logistics, c.construction,
      { maxReliefPerReview: c.siege.maxReliefPerReview }, t, { maxDefensePerReview: c.strategy.maxDefensePerReview });
    };
    assert.strictEqual(rowsOf({}), 976);
    assert.strictEqual(rowsOf({ EVEJS_LNE_TRADE_WTS_ENABLED: "true" }), 986);
  });

  test("WTN2 d4 minerals: net surplus over keep outside the mobilization, war mineral / mobilization station -> none, "
    + "hysteresis with the stockpile; quoteSell; unit >= buyUnitMax + 1; no WTS price", () => {
    const production = { intents: [{ type: "PRODUCE", stationId: "npc-2", hullGroup: "cruiser", runs: 1 }] };
    const logistics = { intents: [{ type: "CONVOY_DISPATCH", sourceStationId: "npc-2", destStationId: "npc-1",
      items: [{ itemKind: "mineral", itemKey: "mineral/type:40", quantity: 1000 }] }] };
    const r = plan(snapshot(), params(), production, logistics);
    const q = 3 * keepOf(40) - 500 - 1000 - keepOf(40);
    assert.deepStrictEqual(sells(r), [{ type: "TRADE_OFFER", side: "sell", slot: 0, stationId: "npc-2",
      systemId: 30000002, issuerCorporationId: 1000001, itemKind: "mineral", itemKey: "type:40", typeId: 40,
      quantity: q, unitPriceMilli: 1050000, iskTotal: Math.ceil((q * 1050000) / 1000), refPriceMilli: 1049999,
      capPriceMilli: null, priceSource: "ask", expiresAt: AT + WTS.wtsTtlMs }], JSON.stringify(r.notes));
    assert.ok(r.notes.includes("TRADE_WTS_OFFER:type:40@npc-2"));
    assert.ok(sells(plan(snapshot(), params({ wtsOffersPerReview: 8, maxOffersPerReview: 8 }))).every((i) =>
      i.stationId === "npc-2"));

    const war = snapshot({ logistics: NO_LOGISTICS, stations: [MOB({ hulls: {}, minerals: Object.fromEntries(MINERALS
      .filter((t) => t !== 40).map((t) => [`type:${t}`, 1e9])) }), station("npc-2", 30000002,
      { minerals: { "type:40": 3 * keepOf(40) } })] });
    war.trade.quotes["type:40"] = buyQuote(1000000);
    const rw = plan(war, params(NO_HULL_WTB));
    assert.ok(rw.intents.some((i) => i.type === "TRADE_OFFER" && i.itemKey === "type:40" && i.side === undefined));
    assert.deepStrictEqual(sells(rw), []);

    const after = snapshot({ stations: [MOB(), station("npc-2", 30000002, { minerals: { "type:40": keepOf(40) } })] });
    const rh = plan(after, params({ maxOffersPerReview: 8 }, { stockpile: true }));
    assert.deepStrictEqual(rh.intents.filter((i) => i.type === "TRADE_OFFER" && i.itemKey === "type:40"), []);
    assert.ok(rh.intents.some((i) => i.purpose === "stockpile"), "the stockpile runs (other minerals of npc-2)");

    const p = { askPermille: 1050, bidPermille: 1100, maxUnitPriceMilli: 1e12 };
    assert.deepStrictEqual(quoteSell({ bidMilli: 1000, askMilli: null, baseMilli: 900 }, p),
      { ok: false, reason: "NO_PRICE" });
    assert.deepStrictEqual({ ...quoteSell({ bidMilli: 1000, askMilli: 1000, baseMilli: null }, p) },
      { ok: true, unitMilli: 1100, refMilli: 1000, capMilli: null, source: "ask" });
    assert.strictEqual(quoteSell({ bidMilli: null, askMilli: 1001, baseMilli: null }, p).unitMilli, 1052);
    assert.strictEqual(quoteSell({ bidMilli: null, askMilli: 1000, baseMilli: null }, { ...p, maxUnitPriceMilli: 1000 })
      .reason, "PRICE_TOO_HIGH");
    const rb = plan(snapshot({ trade: { buyUnitMax: { 40: 2000000 } } }), params());
    assert.strictEqual(sells(rb)[0].unitPriceMilli, 2000001);
    const noPrice = { ...SELL_QUOTES };
    delete noPrice["type:40"];
    const rn = plan(snapshot({ trade: { sellQuotes: noPrice } }), params());
    assert.deepStrictEqual(sells(rn), []);
    assert.ok(rn.notes.includes("TRADE_WTS_NO_PRICE:type:40"), JSON.stringify(rn.notes));
  });

  test("WTN3 d4 hulls: sum 10, desired 3, permille 2000 -> 4 from the largest stock; hullMaxPerOffer cuts; "
    + "hulls {} -> none", () => {
    const snapOf = (trade = {}) => snapshot({ template: [{ hullGroup: "cruiser", count: 3 }], trade,
      stations: [MOB({ hulls: { cruiser: 3 } }), station("npc-2", 30000002, { hulls: { cruiser: 5 } }),
        station("npc-3", 30000003, { hulls: { cruiser: 2 } })] });
    const p = (over) => params({ wtsMineralSurplusRuns: 0, ...over });
    const r = plan(snapOf(), p());
    assert.deepStrictEqual(sells(r).map((i) => [i.stationId, i.itemKind, i.itemKey, i.typeId, i.quantity,
      i.unitPriceMilli, i.iskTotal]), [["npc-2", "hull", "group:cruiser", RACE.cruiser, 4, 10500000000, 42000000]],
    JSON.stringify(r.notes));
    assert.deepStrictEqual(sells(plan(snapOf(), p({ hullMaxPerOffer: 3 }))).map((i) => i.quantity), [3]);
    assert.deepStrictEqual(sells(plan(snapOf({ hulls: {} }), p())), []);
    assert.deepStrictEqual(sells(plan(snapOf(), p({ wtsHullSurplusPermille: 0 }))), []);
  });

  test("WTN4 d4 limits: per review, open per faction, slot headroom, cap with reserve, galaxy, WTB pair; open sell is "
    + "no incoming / tier; recall sell on a war pair / slot within maxCancelsPerReview", () => {
    const two = [MOB(), station("npc-2", 30000002, { minerals: { "type:40": 3 * keepOf(40),
      "type:39": 3 * keepOf(39) } })];
    const snapOf = (trade = {}) => snapshot({ stations: two, trade });
    const keysOf = (r) => sells(r).map((i) => i.itemKey);
    const r1 = plan(snapOf(), params());
    assert.deepStrictEqual(keysOf(r1), ["type:40"]);
    assert.ok(r1.notes.includes("TRADE_WTS_LIMIT"));
    assert.deepStrictEqual(keysOf(plan(snapOf(), params({ wtsOffersPerReview: 2 }))), ["type:40", "type:39"]);
    const rf = plan(snapOf({ open: [sellOpen({})] }), params({ wtsMaxOpenPerFaction: 1 }));
    assert.deepStrictEqual(keysOf(rf), []);
    assert.ok(rf.notes.includes("TRADE_WTS_LIMIT"));
    const at2 = (n) => Array.from({ length: n }, (_, i) => openOffer({ offerId: `to_h${i}`, stationId: "npc-2",
      itemKey: `type:${1230 + i}`, typeId: 1230 + i }));
    assert.deepStrictEqual(keysOf(plan(snapOf({ open: at2(6) }), params())), ["type:40"]);
    const rs = plan(snapOf({ open: at2(7) }), params());
    assert.deepStrictEqual(keysOf(rs), []);
    assert.ok(rs.notes.includes("TRADE_STATION_LIMIT:npc-2"));
    assert.deepStrictEqual(keysOf(plan(snapOf({ open: at2(7) }), params({ wtsStationSlotHeadroom: 0 }))), ["type:40"]);
    const two3 = [openOffer({ offerId: "to_a" }), openOffer({ offerId: "to_b", itemKey: "type:1231", typeId: 1231 })];
    assert.deepStrictEqual(keysOf(plan(snapOf({ open: two3 }), params({ maxOpenOffersPerFaction: 6 }))), []);
    assert.deepStrictEqual(keysOf(plan(snapOf({ open: two3 }), params({ maxOpenOffersPerFaction: 6,
      warReservedOffersPerFaction: 0 }))), ["type:40"]);
    assert.deepStrictEqual(keysOf(plan(snapOf({ galaxy: { open: 3, factions: 1 } }),
      params({ targetOpenContracts: 3 }))), []);
    assert.deepStrictEqual(keysOf(plan(snapOf({ open: [openOffer({ stationId: "npc-2", itemKey: "type:40",
      typeId: 40 })] }), params())), ["type:39"]);

    const warStations = [MOB({ hulls: {}, minerals: Object.fromEntries(MINERALS.filter((t) => t !== 40)
      .map((t) => [`type:${t}`, 1e9])) }), station("npc-2", 30000002)];
    const inc = plan(snapshot({ logistics: NO_LOGISTICS, stations: warStations, trade: { open: [sellOpen({
      stationId: "npc-1", itemKey: "type:40", typeId: 40, quantity: 1000000, state: "ACCEPTED" })] } }),
    params(NO_HULL_WTB));
    assert.ok(inc.notes.includes("TRADE_OFFER_EXISTS:type:40@npc-1"), JSON.stringify(inc.notes));
    const hc = (open) => hullCandidates({ trade: { hulls: HULLS, open }, T: BASE_TRADE,
      validChosen: [{ stationId: "npc-1", deficit: { cruiser: 10 } }], desired: { cruiser: 10 },
      incomingHulls: new Map(), production: null, stationsData: [], logisticsOpen: null, logisticsReady: false,
      chosenStationIds: new Set(["npc-1"]), hullGroups: HULL_GROUPS }).candidates.map((c) => c.need);
    assert.deepStrictEqual(hc([sellOpen({ stationId: "npc-1", itemKey: "group:cruiser", quantity: 6 })]), [10]);
    assert.deepStrictEqual(hc([openOffer({ stationId: "npc-1", itemKey: "group:cruiser", quantity: 6 })]), [4]);
    const D = config.resolveConfig({ modDir: MOD_DIR, env: {} }).config.trade;
    const ts = tierStateOf({ treasury: null }, { budget: null, open: [sellOpen({ iskTotal: 500000000 }),
      openOffer({ iskTotal: 5000000 })] }, { ...D, tiersEnabled: true }, []);
    assert.deepStrictEqual(ts.used, [1, 0, 0]);

    const miss = [MOB({ hulls: {}, minerals: Object.fromEntries([34, 35, 36, 37].map((t) => [`type:${t}`, 1e9])) }),
      station("npc-2", 30000002)];
    const pairs = [38, 39, 40].map((t) => sellOpen({ offerId: `ts_p${t}`, stationId: "npc-1", itemKey: `type:${t}`,
      typeId: t, state: "PLANNED", iskTotal: 1e12 }));
    const rr = plan(snapshot({ logistics: NO_LOGISTICS, stations: miss, trade: { open: pairs } }), params(NO_HULL_WTB));
    assert.deepStrictEqual(recalls(rr).map((i) => [i.offerId, i.from, i.side]).sort(),
      [["ts_p38", "PLANNED", "sell"], ["ts_p39", "PLANNED", "sell"], ["ts_p40", "PLANNED", "sell"]]);
    assert.ok(rr.notes.includes("TRADE_WTS_RECALL:type:40@npc-1"), JSON.stringify(rr.notes));
    assert.strictEqual(recalls(plan(snapshot({ logistics: NO_LOGISTICS, stations: miss, trade: { open: pairs } }),
      params({ ...NO_HULL_WTB, maxCancelsPerReview: 2 }))).length, 2);
    assert.strictEqual(recalls(plan(snapshot({ logistics: NO_LOGISTICS, stations: miss, trade: { open: pairs } }),
      params({ ...NO_HULL_WTB, maxCancelsPerReview: 0 }))).length, 0);
    const rhp = plan(snapshot({ stations: [MOB({ hulls: { frigate: 10 } }), station("npc-2", 30000002)],
      trade: { open: [sellOpen({ offerId: "ts_h", stationId: "npc-1", itemKey: "group:cruiser", typeId: RACE.cruiser,
        quantity: 2 })] } }), params());
    assert.deepStrictEqual(recalls(rhp).map((i) => [i.offerId, i.from, i.side]), [["ts_h", "OPEN", "sell"]]);
    const full = Array.from({ length: 8 }, (_, i) => sellOpen({ offerId: `ts_s${i}`, stationId: "npc-1",
      itemKey: `type:${1230 + i}`, typeId: 1230 + i, expiresAt: AT + 1e6 + i }));
    const rsl = plan(snapshot({ logistics: NO_LOGISTICS, stations: warStations, trade: { open: full } }),
      params(NO_HULL_WTB));
    assert.deepStrictEqual(recalls(rsl).map((i) => [i.offerId, i.side]), [["ts_s0", "sell"]]);
    assert.ok(rsl.notes.includes("TRADE_WTS_RECALL:type:1230@npc-1"));
  });

  test("WTN5 d4 readForReview sellQuotes / buyUnitMax, panel contracts.wts / byKind, notes, metrics, config", async () => {
    for (const c of ["TRADE_WTS_OFFER", "TRADE_WTS_NO_PRICE", "TRADE_WTS_LIMIT", "TRADE_WTS_RECALL"]) {
      assert.ok(NOTE_DICTIONARY[c], c);
    }
    const { config: cfg, warnings } = config.resolveConfig({ modDir: MOD_DIR, env: {} });
    assert.deepStrictEqual(["wtsOffersPerReview", "wtsMaxOpenPerFaction", "wtsStationSlotHeadroom",
      "wtsMineralSurplusRuns", "wtsHullSurplusPermille", "wtsAskPermille", "wtsBidPermille", "wtsMaxIskPerOffer"]
      .map((k) => cfg.trade[k]), [1, 8, 1, 16, 2000, 1050, 1100, 500000000]);
    assert.ok(!(warnings || []).some((x) => x.startsWith("trade.wts")), JSON.stringify(warnings));
    const w = config.resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_TRADE_WTS_ENABLED: "true",
      EVEJS_LNE_TRADE_WTS_MINERAL_SURPLUS_RUNS: "8", EVEJS_LNE_TRADE_WTS_ASK_PERMILLE: "1000",
      EVEJS_LNE_TRADE_ASK_CAP_PERMILLE: "1000", EVEJS_LNE_TRADE_WTS_OFFERS_PER_REVIEW: "8",
      EVEJS_LNE_TRADE_WTS_STATION_SLOT_HEADROOM: "16", EVEJS_LNE_TRADE_HULL_OFFERS_ENABLED: "false" } }).warnings;
    for (const p of ["trade.wtsMineralSurplusRuns <= trade.stockpileRuns", "trade.wtsAskPermille = trade.askCapPermille",
      "trade.wtsOffersPerReview > trade.maxOffersPerReview", "trade.wtsStationSlotHeadroom >= ",
      "trade.wtsHullSurplusPermille > 0"]) assert.ok(w.some((x) => x.startsWith(p)), `${p} ${JSON.stringify(w)}`);
    const rs = createReviewService({ store: {}, journal: {}, strategyRepository: { limits: { maxResourceUnits: 1 } },
      intelRepository: {}, registry: {}, kinds: { list: [], get: () => null }, powerTable: {}, scoring: {},
      scheduler: {}, fleets: {}, clock: { now: () => 0 }, worldSeed: 1, config: cfg, hostility: () => true,
      isCampaignOk: () => true, industryCatalog: {} });
    assert.deepStrictEqual(Object.keys(WTS).filter((k) => !Object.prototype.hasOwnProperty.call(rs.params.trade, k)), []);

    const driver = H.loadDriver();
    if (!driver.ok) return skip("WTN5 SQLite part: better-sqlite3 unavailable");
    await H.withStore(driver, async (reopen) => {
      const shared = H.sharedOf();
      const env = await W.boot(reopen(), shared, { wtsEnabled: true });
      W.addStation(env, "npc-a", 500019);
      W.seed(env, "npc-a", "type:35", 5000, "35");
      W.seed(env, "npc-a", "type:36", 5000, "36");
      env.tx((db) => env.budgets.fundIskInTx(db, { factionId: 500019, isk: 1e9, capIsk: 1e12, at: env.at }, "t:fund"));
      const buy = W.create(env, W.buySpec(env, "npc-a", "type:34"), "wtn5:buy").offer;
      const open = W.create(env, W.sellSpec(env, "npc-a", "type:35", 1000), "wtn5:sell").offer;
      const back = W.create(env, W.sellSpec(env, "npc-a", "type:36", 1000), "wtn5:back").offer;
      const c = env.tx((db) => env.offers.transitionOfferInTx(db, { offerId: back.offerId, expectedVersion: back.version,
        from: "PLANNED", to: "CANCELLED", reason: "EXPIRED", at: env.at }, TS.transitionKey(back.offerId, back.stateSeq + 1,
        "CANCELLED")));
      assert.ok(c.ok, JSON.stringify(c));
      env.tx((db) => {
        assert.ok(env.budgets.creditProceedsInTx(db, { factionId: 500019, isk: 700, capIsk: 1e12, at: env.at },
          "t:proceeds").ok);
        assert.ok(env.budgets.recordProceedsSplitInDb(db, 500019, { treasuryIsk: 300, burnedIsk: 200 }, env.at).ok);
      });

      const calls = new Map();
      const telemetry = { count(n, v = 1) { calls.set(n, (calls.get(n) || 0) + v); } };
      const svc = (trade, seams) => createTradeService({ budgets: env.budgets, offers: env.offers, config: { trade },
        clock: shared.clock, telemetry, logger: { log() {} }, sellSeamsOk: () => seams });
      const on = svc({ ...W.DEFAULTS.trade, wtsEnabled: true }, true);
      on.getPriceCache().put(34, { bidMilli: 1000, askMilli: 2000, baseMilli: null }, env.at);
      on.getPriceCache().put(40, { bidMilli: 1000000, askMilli: 1000000, baseMilli: null }, env.at);
      const opts = { stations: [{ stationId: "npc-a", systemId: H.S.N0, kind: "npc", ownerCorporationId: W.CORP }],
        at: env.at, limit: 50 };
      const t = env.tx((db) => on.readForReview(db, 500019, opts)).trade;
      assert.deepStrictEqual([t.sellQuotes["type:34"].unitMilli, t.sellQuotes["type:40"].unitMilli,
        Object.keys(t.sellQuotes).sort()], [2100, 1100000, ["type:34", "type:40"]]);
      assert.deepStrictEqual(t.buyUnitMax, { 34: buy.unitPriceMilli });
      assert.strictEqual(t.open.find((o) => o.offerId === open.offerId).side, "sell");
      assert.strictEqual(calls.get("trade.wtsNoPrice"), 5);
      for (const [trade, seams] of [[{ ...W.DEFAULTS.trade, wtsEnabled: false }, true],
        [{ ...W.DEFAULTS.trade, wtsEnabled: true }, false]]) {
        const off = env.tx((db) => svc(trade, seams).readForReview(db, 500019, opts)).trade;
        assert.ok(!("sellQuotes" in off) && !("buyUnitMax" in off), JSON.stringify(Object.keys(off)));
      }

      const view = buildTradeView({ store: env.store, budgets: env.budgets, offers: env.offers, clock: shared.clock,
        getStatus: () => ({ state: "ready", seq: 1, counters: {}, executor: { wts: { proceedsWait: 2 } } }),
        capIsk: 1e12, config: { trade: W.DEFAULTS.trade } });
      const data = view.getData();
      assert.strictEqual(data.available, true, JSON.stringify(data));
      assert.deepStrictEqual(data.contracts.wts, { open: 1, listed: 0, onMarket: 0, sold: 0, returned: 1, lost: 0,
        proceedsIsk: 700, treasuryIsk: 300, burnedIsk: 200, proceedsWait: 2 });
      assert.deepStrictEqual(data.contracts.byKind, { mineral: 1, ore: 0, hull: 0, commodity: 0 });
      assert.deepStrictEqual(data.factions[0].offers.map((o) => o.side).sort(), ["buy", "sell"]);
      assert.ok(view.cacheKey().endsWith("|w2"));
    });
  });
};
