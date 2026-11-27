"use strict";

const assert = require("node:assert");
const path = require("node:path");

const config = require("../../config");
const { pressureOf, warPriceParams, pressureParamsOf } = require("../../lib/strategy/data/warPricePressure");
const { quote } = require("../../lib/economy/trade/pricing");
const { createTradeService } = require("../../lib/economy/trade/tradeService");
const { planTrade, planWarReprices } = require("../../lib/strategy/ai/trade");
const { createReviewService } = require("../../lib/strategy/reviewService");
const { describeNote } = require("../../lib/strategy/activity/notes");
const { createJournal } = require("../../lib/persistence/journal");
const { startTrade } = require("../../lib/economy/trade");
const { startTreasury } = require("../../lib/economy/treasury");
const TS = require("../../lib/economy/treasury/schema");
const { GROUPS: HULL_RECIPES } = require("../../lib/economy/data/hullRecipes");
const { harness: H } = require("../battle/settlement.test");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const DEFAULTS = config.resolveConfig({ modDir: MOD_DIR, env: {} }).config;
const F = 500019;
const AT = 1000000;
const MINERALS = [34, 35, 36, 37, 38, 39, 40];
const DAY = 86400000;

const P = pressureParamsOf(DEFAULTS.trade);

const quoteOf = (unitMilli) => ({ ok: true, unitMilli, refMilli: unitMilli, capMilli: unitMilli * 2, source: "bid",
  capped: false });

const RECIPES = {};
for (const [group, data] of Object.entries(HULL_RECIPES)) RECIPES[group] = { minerals: { ...data.minerals } };

function station(stationId, systemId, extra = {}) {
  return { stationId, systemId, kind: "npc", ownerCorporationId: 1000001, lines: 1, activeJobs: [],
    minerals: {}, hulls: { cruiser: 5 }, ...extra };
}

function makeSnapshot(trade = {}) {
  const st = [station("npc-1", 30000001, { hulls: {} }), station("npc-2", 30000002, { lines: 0 })];
  return {
    at: AT, seed: 1, factionId: F,
    faction: { status: "ACTIVE", homeSystemId: 30000001, doctrineId: "test-v1", version: 1 },
    doctrine: { doctrineId: "test-v1", templates: { combat: [{ hullGroup: "cruiser", count: 1 }] } },
    stationsMode: "ready",
    stations: st.map((s) => ({ stationId: s.stationId, systemId: s.systemId, kind: s.kind,
      ownerCorporationId: s.ownerCorporationId })),
    neighbors: () => [],
    supply: { frontTargets: [30000001] },
    production: { mode: "ready", recipes: RECIPES, recipesVersion: 1, stations: st, inProduction: {},
      activeJobsTotal: 0, truncated: false },
    logistics: { mode: "ready", open: [], busyFleetIds: [], carriers: {}, truncated: false },
    trade: {
      mode: "ready", galaxy: { open: 0, factions: 7 },
      budget: { availableIsk: 100000000, reservedIsk: 0 },
      open: [], openTruncated: false,
      stations: st.map((s) => ({ stationId: s.stationId, systemId: s.systemId, ownerCorporationId: s.ownerCorporationId,
        kind: s.kind })),
      quotes: Object.fromEntries(MINERALS.map((t) => [`type:${t}`, quoteOf(5000)])), privateQuotes: {}, suppliers: [],
      ...trade,
    },
  };
}

function makeParams() {
  return {
    trade: { premiumPermille: 1100, askCapPermille: 980, maxOffersPerReview: 16, maxCancelsPerReview: 4,
      maxOpenOffersPerFaction: 32, maxOpenOffersPerStation: 16, maxQuantityPerOffer: 10000000, minIskPerOffer: 100000,
      maxIskPerOffer: 200000000, offerTtlMs: 259200000, factoryRunsTarget: 2, maxUnitPriceMilli: 1000000000000,
      priceCacheMs: 3600000, stockpileEnabled: true, stockpileRuns: 4, stockpileMaxIskPerOffer: 5000000,
      stockpileFreeFloorPermille: 300, targetOpenContracts: 200 },
    production: { maxJobsPerReview: 2, maxRunsPerJob: 4, maxActiveJobsPerFaction: 8, targetStockFleets: 1,
      mobilizeHulls: "required", miningNeedsHulls: false, logisticsNeedsHulls: false, mobilizationStations: 1,
      hullGroups: Object.keys(HULL_RECIPES) },
    maxAssemblyJumps: 15, maxBfsSystems: 2000,
  };
}

const offersOf = (r, purpose) => r.intents.filter((i) => i.type === "TRADE_OFFER" && i.purpose === purpose);

function tradeServiceOf(trade) {
  const open = [{ offerId: "o1", stationId: "npc-1", itemKey: "type:34", typeId: 34, quantity: 10, state: "OPEN",
    expiresAt: AT + 1e9, version: 1, iskTotal: 10, unitPriceMilli: 1000, issuerCorporationId: 1000001,
    assigneeCharacterId: null }];
  const budgets = { getBudget: () => ({ ok: true, budget: null }), listBudgets: () => ({ ok: true, budgets: [] }) };
  const offers = { listOpenOfFaction: () => ({ ok: true, offers: open, truncated: false }),
    countOpenAll: () => ({ ok: true, open: open.length }) };
  const svc = createTradeService({ budgets, offers, clock: { now: () => AT },
    config: { ...DEFAULTS, trade: { ...DEFAULTS.trade, hullOffersEnabled: false, ...trade } } });
  const cache = svc.getPriceCache();
  cache.put(34, { bidMilli: 1000, askMilli: 1050, baseMilli: null }, AT);
  cache.put(35, { bidMilli: 1000, askMilli: 5000, baseMilli: null }, AT);
  cache.put(36, { bidMilli: 1000, askMilli: null, baseMilli: null }, AT);
  return svc;
}

const READ = { stations: [{ stationId: "npc-1", systemId: 30000001, kind: "npc", ownerCorporationId: 1000001 }],
  at: AT, limit: 32 };

module.exports = ({ test, skip }) => {
  test("WP1 pressureOf: zero, AUSTERITY 200, full losses 700, + threats 1000, dead zone, step, no overflow", () => {
    const zero = { lossValueIsk: 0, initialIsk: 0, threatCount: 0, austerity: false };
    assert.strictEqual(pressureOf(zero, P), 0);
    assert.strictEqual(pressureOf({ ...zero, initialIsk: 1e12, austerity: true }, P), 200);
    const full = { ...zero, initialIsk: 1e12, lossValueIsk: 1e11 };
    assert.strictEqual(pressureOf(full, P), 700);
    assert.strictEqual(pressureOf({ ...full, threatCount: 4 }, P), 1000);
    assert.strictEqual(pressureOf({ ...full, threatCount: 64, austerity: true }, P), 1000);
    const unit = { ...P, lossWeightPermille: 1000 };
    assert.strictEqual(pressureOf({ ...zero, initialIsk: 10000, lossValueIsk: 90 }, unit), 0);
    assert.strictEqual(pressureOf({ ...zero, initialIsk: 10000, lossValueIsk: 349 }, unit), 300);
    assert.strictEqual(pressureOf({ ...zero, initialIsk: 1e15, lossValueIsk: 1e15 }, P), 700);
    assert.deepStrictEqual([pressureOf({ ...zero, lossValueIsk: -1 }, P), pressureOf(null, P),
      pressureOf({ ...zero, threatCount: "4" }, P)], [0, 0, 0]);
    assert.deepStrictEqual(warPriceParams(0, DEFAULTS.trade), { bonusPermille: 0, askCapPermille: 980,
      askCapCeilPermille: 1150 });
    assert.deepStrictEqual(warPriceParams(1000, DEFAULTS.trade), { bonusPermille: 300, askCapPermille: 1150,
      askCapCeilPermille: 1150 });
  });

  test("WP2 quote askCapCeilPermille: no ceil = values of before, ceil 1150 caps at ask x 1.15, askCap > ceil invalid",
    () => {
      const p = { premiumPermille: 1100, askCapPermille: 980, bonusPermille: 0, maxUnitPriceMilli: 1e12 };
      const pick = (q) => (q.ok ? [q.unitMilli, q.capMilli, q.source, q.capped] : q.reason);
      assert.deepStrictEqual([
        pick(quote({ bidMilli: 1000, askMilli: 1050, baseMilli: null }, p)),
        pick(quote({ bidMilli: 1000, askMilli: 5000, baseMilli: null }, p)),
        pick(quote({ bidMilli: null, askMilli: 5000, baseMilli: 800 }, p)),
        pick(quote({ bidMilli: 1000, askMilli: null, baseMilli: 800 }, p)),
        pick(quote({ bidMilli: 1000, askMilli: 5000, baseMilli: null }, { ...p, askCapPermille: 1001 })),
      ], [[1029, 1029, "bid", true], [1100, 4900, "bid", false], [880, 4900, "base", false], "NO_PRICE",
        "INVALID_PRICE"]);
      const refs = { bidMilli: 1000, askMilli: 1050, baseMilli: null };
      assert.deepStrictEqual(quote(refs, { ...p, askCapCeilPermille: 1000 }), quote(refs, p));
      const war = quote(refs, { ...p, bonusPermille: 300, askCapPermille: 1150, askCapCeilPermille: 1150 });
      assert.deepStrictEqual([war.ok, war.unitMilli, war.capped], [true, Math.floor((1050 * 1150) / 1000), true]);
      assert.strictEqual(quote(refs, { ...p, askCapPermille: 1200, askCapCeilPermille: 1150 }).reason, "INVALID_PRICE");
      assert.strictEqual(quote(refs, { ...p, askCapCeilPermille: 2001 }).reason, "INVALID_PRICE");
    });

  test("WP3 planTrade: mobilization Tritanium at the war quote, stockpile at the public one, no warQuotes = no war",
    () => {
      const base = planTrade(makeSnapshot(), makeParams(), { intents: [] }, { intents: [] });
      const war = planTrade(makeSnapshot({ warPressurePermille: 500,
        warQuotes: { "type:34": { ...quoteOf(6000), warPermille: 500 } } }), makeParams(), { intents: [] },
      { intents: [] });
      const mob34 = offersOf(war, "mobilization").find((i) => i.itemKey === "type:34");
      const sp34 = offersOf(war, "stockpile").find((i) => i.itemKey === "type:34");
      assert.ok(mob34 && sp34, JSON.stringify(war.intents.map((i) => `${i.purpose}/${i.stationId}/${i.itemKey}`)));
      assert.deepStrictEqual([mob34.stationId, mob34.unitPriceMilli, mob34.warPermille], ["npc-1", 6000, 500]);
      assert.deepStrictEqual([sp34.unitPriceMilli, "warPermille" in sp34], [5000, false]);
      assert.ok(war.notes.includes("TRADE_WAR_PRICE:type:34@npc-1:500"), JSON.stringify(war.notes));
      assert.strictEqual(describeNote("TRADE_WAR_PRICE:type:34@npc-1:500").known, true);
      assert.ok(offersOf(war, "mobilization").filter((i) => i.itemKey !== "type:34")
        .every((i) => i.unitPriceMilli === 5000 && !("warPermille" in i)));
      assert.ok(base.intents.every((i) => !("warPermille" in i)) && !base.notes.some((n) => n.startsWith("TRADE_WAR")));
      assert.deepStrictEqual(planTrade(makeSnapshot({ warPressurePermille: 0, warQuotes: {} }), makeParams(),
        { intents: [] }, { intents: [] }), base);
    });

  test("WP4 tradeService war quotes: only above the public price, flag off = before, readWarPricing per instance",
    () => {
      const on = tradeServiceOf({ warPricingEnabled: true });
      assert.deepStrictEqual(on.readWarPricing(F), { ok: true, found: false });
      const r = on.readForReview({}, F, { ...READ, warPressurePermille: 500 });
      assert.ok(r.ok, JSON.stringify(r));
      const t = r.trade;
      assert.strictEqual(t.warPressurePermille, 500);
      assert.deepStrictEqual(Object.keys(t.warQuotes).sort(), ["type:34", "type:35"]);
      assert.deepStrictEqual([t.warQuotes["type:34"].unitMilli, t.warQuotes["type:35"].unitMilli,
        t.warQuotes["type:34"].warPermille, t.quotes["type:34"].unitMilli], [1118, 1250, 500, 1029]);
      assert.strictEqual(t.open[0].unitPriceMilli, 1000);
      assert.deepStrictEqual(on.readWarPricing(F), { ok: true, found: true, at: AT, pressurePermille: 500, warItems: 2 });
      assert.strictEqual(on.getStatus().counters.warQuotes, 2);
      const flat = tradeServiceOf({ warPricingEnabled: true, warBonusMaxPermille: 0, warAskCapMaxPermille: 980 });
      assert.deepStrictEqual(flat.readForReview({}, F, { ...READ, warPressurePermille: 500 }).trade.warQuotes, {});

      const off = tradeServiceOf({});
      const withP = off.readForReview({}, F, { ...READ, warPressurePermille: 500 });
      assert.deepStrictEqual(withP, off.readForReview({}, F, READ));
      assert.deepStrictEqual(["warQuotes" in withP.trade, "warPressurePermille" in withP.trade,
        "unitPriceMilli" in withP.trade.open[0]], [false, false, false]);
      assert.deepStrictEqual(off.readWarPricing(F), { ok: true, found: false });
      assert.deepStrictEqual(tradeServiceOf({ warPricingEnabled: true }).readWarPricing(F), { ok: true, found: false });
    });

  const toOffer = (offerId, itemKey, unitPriceMilli, extra = {}) => ({ offerId, stationId: "npc-1", itemKey,
    typeId: Number(itemKey.slice(5)), quantity: 10, state: "OPEN", expiresAt: AT + DAY, version: 3,
    iskTotal: 10, unitPriceMilli, issuerCorporationId: 1000001, assigneeCharacterId: null, ...extra });
  const warQ = (unitMilli) => ({ ...quoteOf(unitMilli), warPermille: 500 });
  const reviewTradeParams = (env) => createReviewService({ store: {}, journal: {},
    strategyRepository: { limits: { maxResourceUnits: 1 } }, intelRepository: {}, registry: {},
    kinds: { list: [], get: () => null }, powerTable: {}, scoring: {}, scheduler: {}, fleets: {},
    clock: { now: () => 0 }, worldSeed: 1, config: config.resolveConfig({ modDir: MOD_DIR, env }).config,
    hostility: () => true, isCampaignOk: () => true, industryCatalog: {} }).params.trade;
  const REPRICE_KEYS = ["warPricingEnabled", "warRepriceEnabled", "warRepriceGapPermille", "warRepricePerReview"];
  const cancelsOf = (r) => r.intents.filter((i) => i.type === "TRADE_CANCEL");

  test("WR1 reprice: to_ OPEN 100000 under war 120000 (gap 50) recalled with purpose reprice, 118000 kept", () => {
    const rp = reviewTradeParams({ EVEJS_LNE_TRADE_WAR_PRICING_ENABLED: "1", EVEJS_LNE_TRADE_WAR_REPRICE_ENABLED: "1" });
    assert.deepStrictEqual(REPRICE_KEYS.map((k) => rp[k]), [true, true, 50, 2]);
    const params = makeParams();
    for (const k of REPRICE_KEYS) params.trade[k] = rp[k];
    const snap = makeSnapshot({ open: [toOffer("to_a", "type:34", 100000), toOffer("to_b", "type:35", 118000)],
      warQuotes: { "type:34": warQ(120000), "type:35": warQ(120000) } });
    const r = planTrade(snap, params, { intents: [] }, { intents: [] });
    assert.deepStrictEqual(cancelsOf(r), [{ type: "TRADE_CANCEL", offerId: "to_a", expectedVersion: 3,
      reason: "RECALLED", from: "OPEN", purpose: "reprice" }]);
    assert.ok(r.notes.includes("TRADE_WAR_REPRICE:type:34@npc-1"), JSON.stringify(r.notes));
    assert.strictEqual(describeNote("TRADE_WAR_REPRICE:type:34@npc-1").known, true);
    assert.ok(!r.intents.some((i) => i.type === "TRADE_OFFER" && i.itemKey === "type:34" && i.stationId === "npc-1"));
    assert.strictEqual(tradeServiceOf({}).getStatus().counters.warRepriced, 0);
    const lone = config.resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_TRADE_WAR_REPRICE_ENABLED: "1" } });
    assert.ok(lone.warnings.includes("trade.warRepriceEnabled without trade.warPricingEnabled - no reprice"),
      JSON.stringify(lone.warnings));
  });

  test("WR2 reprice limit: 2 of 3 by gap, never tp_ / private / sell, step 4b gets the cancels left", () => {
    const T = { ...makeParams().trade, warPricingEnabled: true, warRepriceEnabled: true, warRepriceGapPermille: 50,
      warRepricePerReview: 2 };
    const open = [toOffer("to_a", "type:34", 100000), toOffer("to_b", "type:35", 60000),
      toOffer("to_c", "type:36", 90000),
      toOffer("tp_d", "type:37", 1000), toOffer("to_e", "type:38", 1000, { assigneeCharacterId: 90000001 }),
      toOffer("to_f", "type:39", 1000, { side: "sell" })];
    const warQuotes = Object.fromEntries(MINERALS.map((t) => [`type:${t}`, warQ(120000)]));
    const trade = { open, warQuotes, quotes: {} };
    const r = planWarReprices(trade, T, AT, 4, new Set());
    assert.deepStrictEqual(r.intents.map((i) => i.offerId), ["to_b", "to_c"]);
    assert.deepStrictEqual([...r.recalledIds], ["to_b", "to_c"]);
    assert.deepStrictEqual(planWarReprices(trade, T, AT, 1, new Set(["to_b"])).intents.map((i) => i.offerId), ["to_c"]);
    assert.deepStrictEqual(planWarReprices(trade, T, AT, 0, new Set()).intents, []);

    const tp = toOffer("tp_x", "type:35", 5000, { quantity: 1, iskTotal: 5 });
    const stock = { stockpileRecallEnabled: true, stockpileRecallMinNeedPermille: 0 };
    const snapOf = () => makeSnapshot({ open: [tp, toOffer("to_a", "type:36", 100000),
      toOffer("to_b", "type:37", 60000)], warQuotes: { "type:36": warQ(120000), "type:37": warQ(120000) } });
    const p4 = makeParams();
    Object.assign(p4.trade, stock);
    const control = planTrade(snapOf(), p4, { intents: [] }, { intents: [] });
    assert.deepStrictEqual(cancelsOf(control).map((i) => i.offerId), ["tp_x"]);
    const p2 = makeParams();
    Object.assign(p2.trade, stock, T, { maxCancelsPerReview: 2 });
    const r2 = planTrade(snapOf(), p2, { intents: [] }, { intents: [] });
    assert.deepStrictEqual(cancelsOf(r2).map((i) => [i.offerId, i.purpose]), [["to_b", "reprice"], ["to_a", "reprice"]]);
  });

  test("WR3 reprice off: flag off, or war pricing off with the flag on = the plan without the keys", () => {
    const snap = () => makeSnapshot({ open: [toOffer("to_a", "type:34", 100000)],
      warQuotes: { "type:34": warQ(120000) } });
    const plan = (extra) => {
      const p = makeParams();
      Object.assign(p.trade, extra);
      return planTrade(snap(), p, { intents: [] }, { intents: [] });
    };
    const base = plan({});
    assert.deepStrictEqual(plan({ warPricingEnabled: true, warRepriceEnabled: false, warRepriceGapPermille: 50,
      warRepricePerReview: 2 }), base);
    assert.deepStrictEqual(plan({ warPricingEnabled: false, warRepriceEnabled: true, warRepriceGapPermille: 50,
      warRepricePerReview: 2 }), base);
    assert.ok(!base.intents.some((i) => i.purpose === "reprice"));
  });

  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  needsDriver("WP5 treasury lossWindow: no option = keys of before, 3 days sum only the rows of the window",
    () => H.withStore(driver, async (reopen) => {
      const opened = reopen();
      const shared = H.sharedOf();
      const cfg = config.resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_TREASURY_ENABLED: "1",
        EVEJS_LNE_TRADE_CONTRACTS_ENABLED: "0" } }).config;
      const journal = createJournal({ clock: shared.clock, maxPayloadBytes: 16384, maxRows: 500 });
      const persistence = { ok: true, store: opened.store, journal };
      const tr = startTrade({ config: cfg, persistence, clock: shared.clock, ids: shared.ids });
      assert.ok(tr.ok, JSON.stringify(tr));
      const ts = startTreasury({ config: cfg, persistence, clock: shared.clock, getTrade: () => tr.trade });
      assert.ok(ts.ok, JSON.stringify(ts));
      const tx = (fn) => {
        const r = opened.store.transaction("test", fn);
        assert.ok(r.ok, JSON.stringify(r));
        return r.value;
      };
      const at = 400 * DAY + 1000;
      const today = TS.dayOf(at);
      const insert = (day, lossValue, shipsLost) => tx((db) => db.prepare(`INSERT INTO world_faction_treasury_days
        (faction_id, day, income, fleet_upkeep, production_fees, losses, loss_value, ships_lost, trade_out, trade_in,
        unpaid, balance_end, updated_at, merc_fees, merc_refunds, admin, war_spend)
        VALUES (?, ?, 0, 0, 0, 0, ?, ?, 0, 0, 0, 0, ?, 0, 0, 0, 0)`).run(F, day, lossValue, shipsLost, at));
      insert(today, 1000, 1);
      insert(today - 2, 2000, 2);
      insert(today - 4, 40000, 40);
      const opts = { at, npcStations: 0, kind: "empire" };
      const before = tx((db) => ts.treasury.readForReview(db, F, opts));
      assert.ok(before.ok, JSON.stringify(before));
      assert.deepStrictEqual(Object.keys(before.treasury), ["mode", "seeded", "kind", "initialIsk", "balanceIsk",
        "accountMode", "paidUntil", "valueByGroup", "tradeHeldIsk", "tradeEligible", "factionTradeOutToday",
        "galaxyTradeOutToday"]);
      const win = tx((db) => ts.treasury.readForReview(db, F, { ...opts, lossWindowDays: 3 }));
      assert.ok(win.ok, JSON.stringify(win));
      const { lossWindow, ...rest } = win.treasury;
      assert.deepStrictEqual(rest, before.treasury);
      assert.deepStrictEqual(lossWindow, { days: 3, lossValueIsk: 3000, shipsLost: 3 });
      const zero = tx((db) => ts.treasury.readForReview(db, F, { ...opts, lossWindowDays: 0 }));
      assert.deepStrictEqual(zero, before);
      tr.trade.stop();
      ts.treasury.stop();
    }));
};

module.exports.fixtures = { makeSnapshot, makeParams, tradeServiceOf, quoteOf, READ, AT, F, DEFAULTS };
