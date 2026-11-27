"use strict";

const assert = require("node:assert");
const path = require("node:path");

const config = require("../../config");
const { createJournal } = require("../../lib/persistence/journal");
const { createViewRegistry } = require("../../lib/observer/views");
const { planTrade } = require("../../lib/strategy/ai/trade");
const { createReviewService } = require("../../lib/strategy/reviewService");
const { OFFER_ID_PREFIX, OFFER_ID_PREFIX_STOCKPILE } = require("../../lib/strategy/data/tradeStates");
const { HULL_GROUPS } = require("../../lib/fleets/schema");
const { harness: H } = require("../battle/settlement.test");
const { createFakeTradeAdapter } = require("../_support/fakeTradeAdapter");
const HULL_RECIPES_DATA = require("../../lib/economy/data/hullRecipes");
const HULL_TYPES = require("../../lib/economy/data/hullTradeTypes");
const tradeModule = require("../../lib/strategy/ai/trade");
const { sizeHullOffer } = require("../../lib/strategy/ai/tradeHulls");
const { pairTaken } = require("../../lib/strategy/data/tradePairs");
const { TIER_KEYS, tierCfgOf, tierQuotas } = require("../../lib/strategy/data/tradeTiers");
const { buildTradeCatalog } = require("../../lib/economy/trade/tradeCatalog");
const { createTradeService } = require("../../lib/economy/trade/tradeService");
const { createBudgetRepository } = require("../../lib/economy/trade/budgetRepository");
const { createOfferRepository } = require("../../lib/economy/trade/offerRepository");

const HULL_RECIPES = HULL_RECIPES_DATA.GROUPS;

const MOD_DIR = path.resolve(__dirname, "..", "..");
const F = 500019;
const AT = 1000000;
const MINERALS = [34, 35, 36, 37, 38, 39, 40];
const UNIT_MILLI = 5000;
const HULL_UNIT_MILLI = 10000000000;
let idCounter = 0;
const IDS = { next: (p) => `${p}_th${++idCounter}` };

const RECIPES = {};
for (const [group, data] of Object.entries(HULL_RECIPES)) RECIPES[group] = { minerals: { ...data.minerals } };
const STOCKED = Object.fromEntries(MINERALS.map((t) => [`type:${t}`, 1e9]));

const quoteOf = (unitMilli) => ({ ok: true, unitMilli, refMilli: unitMilli, capMilli: unitMilli * 2, source: "bid",
  capped: false });
const QUOTES = Object.fromEntries(MINERALS.map((t) => [`type:${t}`, quoteOf(UNIT_MILLI)]));
const RACE = HULL_TYPES.RACES["4"];
const HULLS = { cruiser: { typeId: RACE.cruiser, itemKey: "group:cruiser" },
  frigate: { typeId: RACE.frigate, itemKey: "group:frigate" } };
const HULL_QUOTES = { "group:cruiser": quoteOf(HULL_UNIT_MILLI), "group:frigate": quoteOf(HULL_UNIT_MILLI) };

function station(stationId, systemId, extra = {}) {
  return { stationId, systemId, kind: "npc", ownerCorporationId: 1000001, lines: 1, activeJobs: [],
    minerals: { ...STOCKED }, hulls: {}, ...extra };
}

function makeSnapshot({ stations, trade = {}, logistics, template } = {}) {
  const st = stations || [station("npc-1", 30000001), station("npc-2", 30000002, { lines: 0 })];
  return {
    at: AT, seed: 1, factionId: F,
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
      mode: "ready", galaxy: { open: 0, factions: 7 },
      budget: { availableIsk: 100000000, reservedIsk: 0 },
      open: [], openTruncated: false,
      stations: st.map((s) => ({ stationId: s.stationId, systemId: s.systemId, ownerCorporationId: s.ownerCorporationId,
        kind: s.kind })),
      quotes: { ...QUOTES, ...HULL_QUOTES }, privateQuotes: {}, suppliers: [], hulls: HULLS,
      ...trade,
    },
  };
}

const BASE_TRADE = {
  premiumPermille: 1100, askCapPermille: 980, maxOffersPerReview: 4, maxCancelsPerReview: 4,
  maxOpenOffersPerFaction: 32, maxOpenOffersPerStation: 8, maxQuantityPerOffer: 10000000, minIskPerOffer: 100000,
  maxIskPerOffer: 200000000, offerTtlMs: 259200000, factoryRunsTarget: 2, maxUnitPriceMilli: 1000000000000,
  priceCacheMs: 3600000,
};
const STOCKPILE = { stockpileEnabled: true, stockpileRuns: 4, stockpileMaxIskPerOffer: 5000000,
  stockpileFreeFloorPermille: 300, targetOpenContracts: 200 };
const RECALL = { stockpileRecallEnabled: true, stockpileRecallMinNeedPermille: 1000 };
const HULL_KEYS = { hullOffersEnabled: true, hullOffersPerReview: 1, hullMaxPerOffer: 4,
  warReservedOffersPerFaction: 4 };

function makeParams(trade = {}, { stockpile = false, hull = true } = {}) {
  return {
    trade: { ...BASE_TRADE, ...RECALL, ...(stockpile ? STOCKPILE : {}), ...(hull ? HULL_KEYS : {}), ...trade },
    production: { maxJobsPerReview: 2, maxRunsPerJob: 4, maxActiveJobsPerFaction: 8, targetStockFleets: 1,
      mobilizeHulls: "required", miningNeedsHulls: false, logisticsNeedsHulls: false, mobilizationStations: 1,
      hullGroups: HULL_GROUPS },
    maxAssemblyJumps: 15, maxBfsSystems: 2000,
  };
}

const plan = (snap, params, production = { intents: [] }) => planTrade(snap, params, production, { intents: [] });
const offersOf = (r, purpose) => r.intents.filter((i) => i.type === "TRADE_OFFER" && i.purpose === purpose);
const recallsOf = (r) => r.intents.filter((i) => i.type === "TRADE_CANCEL" && i.reason === "RECALLED");

module.exports = ({ test, skip }) => {
  test("TH-P1 c2 hull offer: cruiser deficit 24, quote 10 mln -> one offer purpose hull, quantity 4, typeId of "
    + "trade.hulls, TRADE_HULL_OFFER, second group waits", () => {
    const snap = makeSnapshot({ stations: [station("npc-1", 30000001, { hulls: { frigate: 5 } }),
      station("npc-2", 30000002, { lines: 0 })] });
    const r = plan(snap, makeParams());
    assert.deepStrictEqual(r.intents.filter((i) => i.type === "TRADE_OFFER"), [{
      type: "TRADE_OFFER", slot: 0, stationId: "npc-1", systemId: 30000001, issuerCorporationId: 1000001,
      itemKind: "hull", itemKey: "group:cruiser", typeId: RACE.cruiser, quantity: 4, unitPriceMilli: HULL_UNIT_MILLI,
      iskTotal: 40000000, refPriceMilli: HULL_UNIT_MILLI, capPriceMilli: HULL_UNIT_MILLI * 2, priceSource: "bid",
      expiresAt: AT + BASE_TRADE.offerTtlMs, purpose: "hull" }], JSON.stringify(r));
    assert.ok(r.notes.includes("TRADE_HULL_OFFER:group:cruiser@npc-1"), JSON.stringify(r.notes));
    const two = plan(snap, makeParams({ hullOffersPerReview: 2 }));
    assert.deepStrictEqual(offersOf(two, "hull").map((i) => [i.itemKey, i.quantity, i.slot]),
      [["group:cruiser", 4, 0], ["group:frigate", 4, 1]]);
    const noType = plan(makeSnapshot({ trade: { hulls: {} } }), makeParams());
    assert.deepStrictEqual(offersOf(noType, "hull"), []);
    assert.deepStrictEqual(noType.notes.filter((n) => n.startsWith("TRADE_HULL")), ["TRADE_HULL_NO_TYPE"]);
  });

  test("TH-P2 c2 pipeline: PRODUCE / ACTIVE / stock elsewhere, open convoy and open hull offer cover the deficit "
    + "-> no hull offer; each part counts", () => {
    const openOffer = { offerId: "to_h1", stationId: "npc-1", itemKey: "group:cruiser", typeId: RACE.cruiser,
      quantity: 4, state: "OPEN", version: 1, expiresAt: AT + 1e9, iskTotal: 40000000, issuerCorporationId: 1000001,
      assigneeCharacterId: null };
    const convoy = { convoyId: "c1", destStationId: "npc-1", items: { "hull/group:cruiser": 6 } };
    const produce = { intents: [{ type: "PRODUCE", stationId: "npc-2", hullGroup: "cruiser", runs: 4 }] };
    const snapOf = ({ open = [openOffer], mode = "ready" } = {}) => makeSnapshot({
      template: [{ hullGroup: "cruiser", count: 24 }],
      stations: [station("npc-1", 30000001),
        station("npc-2", 30000002, { lines: 0, activeJobs: [{ hullGroup: "cruiser", runs: 5 }], hulls: { cruiser: 5 } })],
      trade: { open },
      logistics: { mode, open: [convoy], busyFleetIds: [], carriers: {}, truncated: false } });
    const covered = plan(snapOf(), makeParams(), produce);
    assert.deepStrictEqual(offersOf(covered, "hull"), [], JSON.stringify(covered));
    assert.ok(!covered.notes.some((n) => n.includes("group:cruiser")), JSON.stringify(covered.notes));
    const noOffer = plan(snapOf({ open: [] }), makeParams(), produce);
    assert.deepStrictEqual(offersOf(noOffer, "hull").map((i) => i.quantity), [4]);
    const noProduce = plan(snapOf(), makeParams());
    assert.ok(noProduce.notes.includes("TRADE_OFFER_EXISTS:group:cruiser@npc-1"), JSON.stringify(noProduce.notes));
    const notReady = plan(snapOf({ mode: "off" }), makeParams(), produce);
    assert.ok(notReady.notes.includes("TRADE_OFFER_EXISTS:group:cruiser@npc-1"), JSON.stringify(notReady.notes));
    assert.deepStrictEqual(offersOf(notReady, "hull"), []);
  });

  test("TH-P3 c2 regression: hullOffersEnabled false / params.trade without the c2 keys = the planner on a snapshot "
    + "without trade.hulls (stockpile + mobilization)", () => {
    const mobStock = Object.fromEntries(MINERALS.filter((t) => t !== 34).map((t) => [`type:${t}`, 1e9]));
    const snapOf = (withHulls) => {
      const s = makeSnapshot({ template: [{ hullGroup: "cruiser", count: 1 }],
        stations: [station("npc-1", 30000001, { minerals: mobStock }),
          station("npc-2", 30000002, { lines: 0, minerals: {} })] });
      if (!withHulls) {
        delete s.trade.hulls;
        delete s.trade.quotes["group:cruiser"];
        delete s.trade.quotes["group:frigate"];
      }
      return s;
    };
    const before = plan(snapOf(false), makeParams({}, { stockpile: true, hull: false }));
    assert.ok(offersOf(before, "mobilization").length >= 1 && offersOf(before, "stockpile").length >= 1,
      JSON.stringify(before));
    const off = plan(snapOf(true), makeParams({ hullOffersEnabled: false, warReservedOffersPerFaction: 0 },
      { stockpile: true }));
    assert.deepStrictEqual(off, before);
    const noKeys = plan(snapOf(true), makeParams({}, { stockpile: true, hull: false }));
    assert.deepStrictEqual(noKeys, before);
    const flagNoKeys = plan(snapOf(true), makeParams({ hullOffersEnabled: true }, { stockpile: true, hull: false }));
    assert.deepStrictEqual(flagNoKeys, before);
    const on = plan(snapOf(true), makeParams({}, { stockpile: true }));
    assert.deepStrictEqual(offersOf(on, "hull").map((i) => [i.itemKey, i.quantity]), [["group:cruiser", 1]]);
  });

  const fill = (over = {}) => [0, 1, 2, 3, 4, 5, 6, 7].map((i) => ({ offerId: `tp_s${i}`, stationId: "npc-1",
    itemKey: `type:${1230 + i}`, typeId: 1230 + i, quantity: 100, state: "OPEN", version: 2, expiresAt: AT + 1e6 + i,
    iskTotal: 5000, issuerCorporationId: 1000001, assigneeCharacterId: null, ...(over[i] || {}) }));

  test("TH-R1 c2 slot recall: full mobilization station -> RECALLED of the oldest tp_ (hull, mineral) "
    + "step 1 offer never recalled, its slot is free", () => {
    const snapOf = (open, extra = {}) => makeSnapshot({ trade: { open }, ...extra });
    const r = plan(snapOf(fill()), makeParams());
    assert.deepStrictEqual(recallsOf(r), [{ type: "TRADE_CANCEL", offerId: "tp_s0", expectedVersion: 2,
      reason: "RECALLED", from: "OPEN" }], JSON.stringify(r));
    assert.ok(r.notes.includes("TRADE_STOCKPILE_RECALL_SLOT:type:1230@npc-1"), JSON.stringify(r.notes));
    assert.ok(r.notes.includes("TRADE_STATION_LIMIT:npc-1"), JSON.stringify(r.notes));
    assert.deepStrictEqual(offersOf(r, "hull"), []);
    const minerals = Object.fromEntries(MINERALS.filter((t) => t !== 34).map((t) => [`type:${t}`, 1e9]));
    const rm = plan(snapOf(fill(), { stations: [station("npc-1", 30000001, { minerals }),
      station("npc-2", 30000002, { lines: 0, minerals: {} })] }), makeParams({ hullOffersEnabled: false }));
    assert.deepStrictEqual(recallsOf(rm).map((i) => i.offerId), ["tp_s0"], JSON.stringify(rm));
    assert.deepStrictEqual(recallsOf(plan(snapOf(fill()), makeParams({ stockpileRecallEnabled: false }))), []);

    const gone = fill({ 0: { state: "PLANNED", issuerCorporationId: 999 } });
    const r1 = plan(snapOf(gone), makeParams());
    assert.deepStrictEqual(r1.intents.filter((i) => i.type === "TRADE_CANCEL").map((i) => [i.offerId, i.reason]),
      [["tp_s0", "STATION_GONE"]], JSON.stringify(r1));
    const r2 = plan(snapOf(gone), makeParams({ hullOffersPerReview: 2 }));
    assert.deepStrictEqual(r2.intents.filter((i) => i.type === "TRADE_CANCEL").map((i) => [i.offerId, i.reason]),
      [["tp_s0", "STATION_GONE"], ["tp_s1", "RECALLED"]], JSON.stringify(r2));
    const expired = fill({ 0: { state: "PLANNED", expiresAt: AT } });
    const r3 = plan(snapOf(expired), makeParams({ hullOffersPerReview: 2 }));
    assert.deepStrictEqual(r3.intents.filter((i) => i.type === "TRADE_CANCEL").map((i) => [i.offerId, i.reason]),
      [["tp_s0", "EXPIRED"], ["tp_s1", "RECALLED"]]);
  });

  test("TH-S1 c2 reserve: stockpile ends at maxOpenOffersPerFaction - warReserved; 0 = before c2; config "
    + "defaults, warnings, params.trade", () => {
    const open = Array.from({ length: 26 }, (_, i) => ({ offerId: `to_o${i}`, stationId: "x-1",
      itemKey: `type:${2000 + i}`, typeId: 2000 + i, quantity: 1, state: "OPEN", version: 1, expiresAt: AT + 1e9,
      iskTotal: 5, issuerCorporationId: 1000001, assigneeCharacterId: null }));
    const snap = makeSnapshot({ stations: [station("npc-1", 30000001, { minerals: {}, hulls: { cruiser: 24,
      frigate: 10 } }), station("npc-2", 30000002, { lines: 0, minerals: {} })],
    trade: { open, galaxy: { open: 26, factions: 1 } } });
    const params = (reserve) => makeParams({ targetOpenContracts: 2000, warReservedOffersPerFaction: reserve },
      { stockpile: true });
    const r = plan(snap, params(4));
    assert.strictEqual(offersOf(r, "stockpile").length, 2, JSON.stringify(r));
    assert.ok(r.notes.includes("TRADE_TARGET_REACHED"), JSON.stringify(r.notes));
    const r0 = plan(snap, params(0));
    assert.strictEqual(offersOf(r0, "stockpile").length, 4);
    assert.ok(!r0.notes.includes("TRADE_TARGET_REACHED"));

    const { config: cfg, warnings } = config.resolveConfig({ modDir: MOD_DIR, env: {} });
    assert.deepStrictEqual([cfg.trade.hullOffersPerReview, cfg.trade.hullMaxPerOffer,
      cfg.trade.warReservedOffersPerFaction], [1, 4, 4]);
    assert.ok(!(warnings || []).some((x) => x.startsWith("trade.hullOffersPerReview")
      || x.startsWith("trade.warReservedOffersPerFaction")), JSON.stringify(warnings));
    const w = config.resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_TRADE_HULL_OFFERS_PER_REVIEW: "8",
      EVEJS_LNE_TRADE_WAR_RESERVED_OFFERS_PER_FACTION: "32" } }).warnings || [];
    assert.ok(w.some((x) => x.startsWith("trade.hullOffersPerReview > trade.maxOffersPerReview")), JSON.stringify(w));
    assert.ok(w.some((x) => x.startsWith("trade.warReservedOffersPerFaction >= trade.maxOpenOffersPerFaction")));
    const env = { EVEJS_LNE_TRADE_HULL_OFFERS_PER_REVIEW: "2", EVEJS_LNE_TRADE_HULL_MAX_PER_OFFER: "7",
      EVEJS_LNE_TRADE_WAR_RESERVED_OFFERS_PER_FACTION: "0" };
    const service = createReviewService({ store: {}, journal: {}, strategyRepository: { limits: { maxResourceUnits: 1 } },
      intelRepository: {}, registry: {}, kinds: { list: [], get: () => null }, powerTable: {}, scoring: {},
      scheduler: {}, fleets: {}, clock: { now: () => 0 }, worldSeed: 1,
      config: config.resolveConfig({ modDir: MOD_DIR, env }).config, hostility: () => true,
      isCampaignOk: () => true, industryCatalog: {} });
    const p = service.params.trade;
    assert.deepStrictEqual([p.hullOffersPerReview, p.hullMaxPerOffer, p.warReservedOffersPerFaction], [2, 7, 0]);
  });

  test("TH-D278 c2 SQLite: id prefix of stockpile / mobilization / hull offers = tradeStates constants; panel "
    + "contracts.byKind.hull", async () => {
    const driver = H.loadDriver();
    if (!driver.ok) return skip("better-sqlite3 unavailable");
    const DEFAULTS = config.resolveConfig({ modDir: MOD_DIR, env: {} }).config;
    await H.withStore(driver, async (reopen) => {
      const opened = reopen();
      const shared = H.sharedOf();
      const journal = createJournal({ clock: shared.clock, maxPayloadBytes: 16384, maxRows: 500 });
      const views = createViewRegistry();
      const cfg = { ...DEFAULTS, trade: { ...DEFAULTS.trade, enabled: true },
        modules: { ...DEFAULTS.modules, strategy: { enabled: true } }, stations: { ...DEFAULTS.stations, enabled: true } };
      const started = require("../../lib/economy/trade").startTrade({
        config: cfg, persistence: { ok: true, store: opened.store, journal }, clock: shared.clock,
        views, ids: IDS, adapter: createFakeTradeAdapter(), logger: { log() {} },
        getStations: () => ({ getMode: () => "ready" }), getGraph: () => null,
        setTimer: () => ({ cancel() {}, hasRef: () => false }),
      });
      assert.ok(started.ok, JSON.stringify(started));
      const tr = started.trade;
      const tx = (fn) => {
        const r = opened.store.transaction("test", fn);
        assert.ok(r.ok, JSON.stringify(r));
        return r.value;
      };
      assert.ok(tx((db) => tr.fundFromUpkeepInTx(db, { factionId: F, units: 1000, paidUntilTo: AT }, "fund:h")).ok);
      const spec = (extra) => ({ factionId: F, stationId: "npc-1", systemId: 30000001, issuerCorporationId: 1000001,
        quantity: 2, unitPriceMilli: 5000, iskTotal: 10, refPriceMilli: 5000, capPriceMilli: 9000, priceSource: "bid",
        expiresAt: AT + 86400000, at: AT, ...extra });
      const ik = (n) => `strategy:review:${F}:9:${n}:TRADE`;
      const mk = (n, extra) => {
        const r = tx((db) => tr.planOfferInTx(db, spec(extra), ik(n)));
        assert.ok(r.ok, JSON.stringify(r));
        return r.offer.offerId;
      };
      const sp = mk(1, { itemKind: "mineral", itemKey: "type:34", typeId: 34, purpose: "stockpile" });
      const mob = mk(2, { itemKind: "mineral", itemKey: "type:35", typeId: 35, purpose: "mobilization" });
      const hull = mk(3, { itemKind: "hull", itemKey: "group:cruiser", typeId: RACE.cruiser, purpose: "hull" });
      assert.ok(sp.startsWith(`${OFFER_ID_PREFIX_STOCKPILE}_`), sp);
      assert.ok(mob.startsWith(`${OFFER_ID_PREFIX}_`), mob);
      assert.ok(hull.startsWith(`${OFFER_ID_PREFIX}_`), hull);
      const data = views.getView("trade").getData();
      assert.deepStrictEqual(data.contracts.byKind, { mineral: 2, ore: 0, hull: 1, commodity: 0 },
        JSON.stringify(data.contracts));
      tr.stop();
    });
    return undefined;
  });

  const DEFAULTS = config.resolveConfig({ modDir: MOD_DIR, env: {} }).config;
  const TIERS = Object.fromEntries([...TIER_KEYS, "tiersEnabled", "tierMaxBudgetSharePermille", "tierMinOfferIsk"]
    .map((k) => [k, DEFAULTS.trade[k]]));

  test("TH-SW1 sweep: one pair rule for trade / tradeHulls / tradeSell (data/tradePairs), table", () => {
    assert.strictEqual(tradeModule.pairTaken, pairTaken, "trade.pairTaken is the shared function");
    const shared = require.resolve("../../lib/strategy/data/tradePairs");
    for (const f of ["../../lib/strategy/ai/trade", "../../lib/strategy/ai/tradeHulls", "../../lib/strategy/ai/tradeSell"]) {
      const m = require.cache[require.resolve(f)];
      assert.ok(m && m.children.some((c) => c.filename === shared), `${f} requires data/tradePairs`);
    }
    const o = (state, extra = {}) => ({ offerId: "x1", stationId: "s1", itemKey: "group:cruiser", state, ...extra });
    const rows = [
      ...["PLANNED", "ISSUING", "OPEN", "ACCEPTED", "INTAKE"].map((st) => [`open ${st}`, [o(st)], [], true]),
      ...["DELIVERED", "CANCELLED", "LOST"].map((st) => [`terminal ${st}`, [o(st)], [], false]),
      ["WTS offer holds the pair", [o("OPEN", { side: "sell" })], [], true],
      ["other station", [o("OPEN", { stationId: "s2" })], [], false],
      ["other item", [o("OPEN", { itemKey: "type:34" })], [], false],
      ["offer of this round", [], [{ stationId: "s1", itemKey: "group:cruiser" }], true],
      ["new offer of another pair", [], [{ stationId: "s1", itemKey: "type:34" }], false],
      ["nothing", [], [], false],
    ];
    for (const [name, open, fresh, want] of rows) {
      assert.strictEqual(pairTaken(open, fresh, "s1", "group:cruiser"), want, name);
    }
  });

  test("TH-SW2 sweep: tiers on - hull offer tier / TTL of the tier, AUSTERITY cap; sizeHullOffer one tier down "
    + "while the quota is used, TRADE_TIER_FULL once", () => {
    const snapOf = (unitMilli, extra = {}) => makeSnapshot({ template: [{ hullGroup: "cruiser", count: 24 }],
      trade: { budget: { availableIsk: 1000000000, reservedIsk: 0 },
        quotes: { ...QUOTES, "group:cruiser": quoteOf(unitMilli) } }, ...extra });
    const hullOf = (r) => offersOf(r, "hull").map((i) => [i.quantity, i.iskTotal, i.tier, i.expiresAt - AT]);
    const params = makeParams(TIERS);
    assert.deepStrictEqual(hullOf(plan(snapOf(HULL_UNIT_MILLI), params)),
      [[4, 40000000, 2, TIERS.tier2TtlMs]]);
    assert.deepStrictEqual(hullOf(plan(snapOf(30000000000), params)), [[4, 120000000, 3, TIERS.tier3TtlMs]]);
    const austerity = snapOf(30000000000);
    austerity.treasury = { mode: "ready", accountMode: "AUSTERITY" };
    assert.deepStrictEqual(hullOf(plan(austerity, params)), [[3, 90000000, 2, TIERS.tier2TtlMs]]);

    const TC = tierCfgOf(TIERS);
    const quota = tierQuotas(BASE_TRADE.maxOpenOffersPerFaction, TC);
    const T = { ...BASE_TRADE, ...HULL_KEYS };
    const tiersOf = (used) => ({ cfg: TC, gateIsk: 1000000000, austerity: false, used, fullNoted: false });
    const size = (tiers, unitMilli, need, notes) => sizeHullOffer({ T, tiers, quota, q: quoteOf(unitMilli), need,
      itemKey: "group:cruiser", budgetLeft: 1000000000, notes });
    const notes = [];
    assert.deepStrictEqual(size(tiersOf([0, 0, 0]), HULL_UNIT_MILLI, 4, notes),
      { ok: true, quantity: 4, iskTotal: 40000000, cls: 2, ttlMs: TC.tier2TtlMs });
    assert.deepStrictEqual(size(tiersOf([0, quota[1], 0]), HULL_UNIT_MILLI, 4, notes),
      { ok: true, quantity: 1, iskTotal: 10000000, cls: 1, ttlMs: TC.tier1TtlMs });
    assert.deepStrictEqual(notes, []);
    const full = tiersOf([0, 0, quota[2]]);
    assert.deepStrictEqual(size(full, 200000000000, 1, notes), { ok: false });
    assert.deepStrictEqual(size(full, 200000000000, 1, notes), { ok: false });
    assert.deepStrictEqual(notes, ["TRADE_TIER_FULL"]);
  });

  test("TH-SW3 sweep: catalog.hullsAvailable; trade.hulls null with the flag on -> no TRADE_HULL_NO_TYPE",
    () => {
      const cat = (over) => buildTradeCatalog({ hullTypes: HULL_TYPES, hullRecipes: HULL_RECIPES_DATA,
        hullOffersEnabled: true, ...over });
      const noRecipes = cat({ hullRecipes: null });
      assert.strictEqual(noRecipes.summary.hullState, "no_recipes");
      assert.deepStrictEqual([cat({}), noRecipes, cat({ hullTypes: null }), cat({ hullOffersEnabled: false })]
        .map((c) => c.hullsAvailable), [true, false, false, false]);
      const r = plan(makeSnapshot({ trade: { hulls: null } }), makeParams());
      assert.deepStrictEqual(offersOf(r, "hull"), []);
      assert.deepStrictEqual(r.notes.filter((n) => n.startsWith("TRADE_HULL")), [], JSON.stringify(r.notes));
    });

  test("TH-SW3b sweep SQLite: readForReview trade.hulls = null for a catalog without hulls (no_recipes, no "
    + "race map), the race hulls with the table", async () => {
    const driver = H.loadDriver();
    if (!driver.ok) return skip("better-sqlite3 unavailable");
    await H.withStore(driver, async (reopen) => {
      const opened = reopen();
      const shared = H.sharedOf();
      const journal = createJournal({ clock: shared.clock, maxPayloadBytes: 16384, maxRows: 500 });
      const budgets = createBudgetRepository({ journal, clock: shared.clock });
      const cfg = { ...DEFAULTS, trade: { ...DEFAULTS.trade, enabled: true } };
      assert.strictEqual(cfg.trade.hullOffersEnabled, true, "default flag on");
      const hullsOf = (over) => {
        const catalog = buildTradeCatalog({ hullTypes: HULL_TYPES, hullRecipes: HULL_RECIPES_DATA,
          hullOffersEnabled: true, ...over });
        const offers = createOfferRepository({ journal, budgets, ids: shared.ids, clock: shared.clock, catalog });
        const service = createTradeService({ budgets, offers, config: cfg, clock: shared.clock,
          logger: { log() {} }, catalog });
        const r = opened.store.transaction("test", (db) => service.readForReview(db, F,
          { stations: [], at: AT, limit: 32 }));
        assert.ok(r.ok && r.value.ok, JSON.stringify(r));
        return r.value.trade.hulls;
      };
      const table = hullsOf({});
      assert.deepStrictEqual(table.cruiser, { typeId: RACE.cruiser, itemKey: "group:cruiser" });
      assert.strictEqual(hullsOf({ hullRecipes: null }), null, "no_recipes");
      assert.strictEqual(hullsOf({ hullTypes: null }), null, "no race map");
    });
    return undefined;
  });

  test("TH-SW4 sweep: a hull pair held by a step 1 offer (PLANNED EXPIRED) needs a slot -> recall in the same "
    + "review", () => {
    const open = [{ offerId: "to_h0", stationId: "npc-1", itemKey: "group:cruiser", typeId: RACE.cruiser, quantity: 1,
      state: "PLANNED", version: 1, expiresAt: AT, iskTotal: 10000000, issuerCorporationId: 1000001,
      assigneeCharacterId: null }, ...fill().slice(1)];
    const r = plan(makeSnapshot({ trade: { open } }), makeParams({ hullOffersPerReview: 2 }));
    assert.deepStrictEqual(r.intents.filter((i) => i.type === "TRADE_CANCEL").map((i) => [i.offerId, i.reason]),
      [["to_h0", "EXPIRED"], ["tp_s1", "RECALLED"]], JSON.stringify(r));
    assert.ok(r.notes.includes("TRADE_STOCKPILE_RECALL_SLOT:type:1231@npc-1"), JSON.stringify(r.notes));
    const one = plan(makeSnapshot({ trade: { open }, template: [{ hullGroup: "cruiser", count: 24 }] }), makeParams());
    assert.deepStrictEqual(recallsOf(one), []);
  });
};
