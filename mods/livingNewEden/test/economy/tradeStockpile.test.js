"use strict";

const assert = require("node:assert");
const path = require("node:path");

const config = require("../../config");
const { createJournal } = require("../../lib/persistence/journal");
const { createViewRegistry } = require("../../lib/observer/views");
const { planTrade, planOversizeRecalls } = require("../../lib/strategy/ai/trade");
const { describeNote } = require("../../lib/strategy/activity/notes");
const { createReviewService } = require("../../lib/strategy/reviewService");
const { harness: H } = require("../battle/settlement.test");
const { createFakeTradeAdapter } = require("../_support/fakeTradeAdapter");
const { GROUPS: HULL_RECIPES } = require("../../lib/economy/data/hullRecipes");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const DEFAULTS = config.resolveConfig({ modDir: MOD_DIR, env: {} }).config;
const F = 500019;
const F2 = 500020;
const AMARR = 500003;
const AT = 1000000;
const MINERALS = [34, 35, 36, 37, 38, 39, 40];
const UNIT_MILLI = 5000;
let idCounter = 0;
const IDS = { next: (p) => `${p}_sp${++idCounter}` };

const RECIPES = {};
for (const [group, data] of Object.entries(HULL_RECIPES)) RECIPES[group] = { minerals: { ...data.minerals } };
const CRUISER = RECIPES.cruiser.minerals;

const quoteOf = (unitMilli) => ({ ok: true, unitMilli, refMilli: unitMilli, capMilli: unitMilli * 2, source: "bid",
  capped: false });
const QUOTES = Object.fromEntries(MINERALS.map((t) => [`type:${t}`, quoteOf(UNIT_MILLI)]));

function station(stationId, systemId, extra = {}) {
  return { stationId, systemId, kind: "npc", ownerCorporationId: 1000001, lines: 1, activeJobs: [],
    minerals: {}, hulls: { cruiser: 5 }, ...extra };
}

function makeSnapshot({ stations, trade = {}, logistics } = {}) {
  const st = stations || [station("npc-1", 30000001), station("npc-2", 30000002)];
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
    logistics: logistics || { mode: "ready", open: [], busyFleetIds: [], carriers: {}, truncated: false },
    trade: {
      mode: "ready", galaxy: { open: 0, factions: 7 },
      budget: { availableIsk: 100000000, reservedIsk: 0 },
      open: [], openTruncated: false,
      stations: st.map((s) => ({ stationId: s.stationId, systemId: s.systemId, ownerCorporationId: s.ownerCorporationId,
        kind: s.kind })),
      quotes: QUOTES, privateQuotes: {}, suppliers: [],
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

function makeParams(trade = {}, { stockpile = true, mobilizationStations = 2 } = {}) {
  return {
    trade: { ...BASE_TRADE, ...(stockpile ? STOCKPILE : {}), ...trade },
    production: { maxJobsPerReview: 2, maxRunsPerJob: 4, maxActiveJobsPerFaction: 8, targetStockFleets: 1,
      mobilizeHulls: "required", miningNeedsHulls: false, logisticsNeedsHulls: false, mobilizationStations,
      hullGroups: Object.keys(HULL_RECIPES) },
    maxAssemblyJumps: 15, maxBfsSystems: 2000,
  };
}

const offersOf = (r, purpose) => r.intents.filter((i) => i.type === "TRADE_OFFER" && i.purpose === purpose);
const pairs = (list) => list.map((i) => `${i.stationId}/${i.itemKey}`);

module.exports = ({ test, skip }) => {
  test("T1 planTrade stockpile: 2 empty NPC stations, no mobilization demand -> 4 offers round-robin "
    + "<= stockpileMaxIskPerOffer, slot 0..3, notes", () => {
    const r = planTrade(makeSnapshot(), makeParams(), { intents: [] }, { intents: [] });
    assert.deepStrictEqual(offersOf(r, "mobilization"), []);
    const sp = offersOf(r, "stockpile");
    assert.strictEqual(r.intents.length, 4, JSON.stringify(r));
    assert.deepStrictEqual(pairs(sp), ["npc-1/type:34", "npc-2/type:34", "npc-1/type:35", "npc-2/type:35"]);
    assert.deepStrictEqual(sp.map((i) => i.slot), [0, 1, 2, 3]);
    for (const i of sp) {
      assert.ok(i.iskTotal <= STOCKPILE.stockpileMaxIskPerOffer && i.iskTotal >= BASE_TRADE.minIskPerOffer, i.iskTotal);
      assert.strictEqual(i.quantity, Math.min(CRUISER[i.itemKey] * STOCKPILE.stockpileRuns,
        Math.floor((STOCKPILE.stockpileMaxIskPerOffer * 1000) / UNIT_MILLI)));
      assert.strictEqual(i.expiresAt, AT + BASE_TRADE.offerTtlMs);
      assert.strictEqual(i.issuerCorporationId, 1000001);
      assert.strictEqual(i.systemId, i.stationId === "npc-1" ? 30000001 : 30000002);
    }
    assert.deepStrictEqual(r.notes.filter((n) => n.startsWith("TRADE_STOCKPILE_OFFER")),
      ["TRADE_STOCKPILE_OFFER:type:34@npc-1", "TRADE_STOCKPILE_OFFER:type:34@npc-2",
        "TRADE_STOCKPILE_OFFER:type:35@npc-1", "TRADE_STOCKPILE_OFFER:type:35@npc-2"]);
    assert.deepStrictEqual(planTrade(makeSnapshot(), makeParams(), { intents: [] }, { intents: [] }), r);
    const noLines = makeSnapshot({ stations: [station("npc-1", 30000001, { lines: 0 })] });
    const r2 = planTrade(noLines, makeParams(), { intents: [] }, { intents: [] });
    assert.ok(r2.notes.includes("TRADE_NO_MOBILIZATION_STATION"), JSON.stringify(r2.notes));
    assert.strictEqual(offersOf(r2, "stockpile").length, 4);
  });

  test("T2 limits: galaxy target reached (mobilization still planned), faction cap = ceil(target/factions) "
    + "free ISK floor", () => {
    const mob = makeSnapshot({ stations: [station("npc-1", 30000001, { hulls: {} }),
      station("npc-2", 30000002, { lines: 0 })], trade: { galaxy: { open: 200, factions: 7 } } });
    const r1 = planTrade(mob, makeParams({ maxOffersPerReview: 8 }, { mobilizationStations: 1 }), { intents: [] },
      { intents: [] });
    assert.ok(offersOf(r1, "mobilization").length >= 1, JSON.stringify(r1));
    assert.deepStrictEqual(offersOf(r1, "stockpile"), []);
    assert.ok(r1.notes.includes("TRADE_TARGET_REACHED"), JSON.stringify(r1.notes));

    const r2 = planTrade(makeSnapshot({ trade: { galaxy: { open: 0, factions: 50 } } }),
      makeParams({ maxOffersPerReview: 8 }), { intents: [] }, { intents: [] });
    assert.strictEqual(offersOf(r2, "stockpile").length, 4);
    assert.ok(r2.notes.includes("TRADE_TARGET_REACHED"));
    const open = [{ offerId: "o1", stationId: "npc-9", itemKey: "type:34", typeId: 34, quantity: 1, state: "OPEN",
      version: 1, expiresAt: AT + 1e9, iskTotal: 1, issuerCorporationId: 1000001 }];
    const r3 = planTrade(makeSnapshot({ trade: { galaxy: { open: 1, factions: 50 }, open } }),
      makeParams({ maxOffersPerReview: 8 }), { intents: [] }, { intents: [] });
    assert.strictEqual(offersOf(r3, "stockpile").length, 3);

    const r4 = planTrade(makeSnapshot({ trade: { budget: { availableIsk: 1000000, reservedIsk: 0 } } }), makeParams(),
      { intents: [] }, { intents: [] });
    assert.deepStrictEqual(offersOf(r4, "stockpile").map((i) => i.iskTotal), [700000]);
    assert.ok(r4.notes.includes("TRADE_STOCKPILE_FLOOR"), JSON.stringify(r4.notes));
    const r5 = planTrade(makeSnapshot({ trade: { budget: { availableIsk: 1000000, reservedIsk: 9000000 } } }),
      makeParams(), { intents: [] }, { intents: [] });
    assert.deepStrictEqual(r5.intents, []);
    assert.ok(r5.notes.includes("TRADE_STOCKPILE_FLOOR"));
  });

  test("T3 pairs and regression: open offer / convoy, no pair twice in a round, FULL, stockpile off = "
    + "mobilization-only planner", () => {
    const convoy35 = CRUISER["type:35"] * STOCKPILE.stockpileRuns - 20000;
    const open = [{ offerId: "o1", stationId: "npc-1", itemKey: "type:34", typeId: 34, quantity: 100000, state: "OPEN",
      version: 1, expiresAt: AT + 1e9, iskTotal: 500000, issuerCorporationId: 1000001 }];
    const snap = makeSnapshot({ stations: [station("npc-1", 30000001)], trade: { open },
      logistics: { mode: "ready", busyFleetIds: [], carriers: {}, truncated: false,
        open: [{ destStationId: "npc-1", items: { "mineral/type:35": convoy35 } }] } });
    const r1 = planTrade(snap, makeParams(), { intents: [] }, { intents: [] });
    const sp = offersOf(r1, "stockpile");
    assert.ok(!pairs(sp).includes("npc-1/type:34"), JSON.stringify(sp));
    const o35 = sp.find((i) => i.itemKey === "type:35");
    assert.ok(o35, JSON.stringify(r1));
    assert.strictEqual(o35.quantity, 20000, "need of 35 lowered by the convoy");

    const mob = makeSnapshot({ stations: [station("npc-1", 30000001, { hulls: {} })] });
    const r2 = planTrade(mob, makeParams({ maxOffersPerReview: 8 }, { mobilizationStations: 1 }), { intents: [] },
      { intents: [] });
    const all = pairs(r2.intents.filter((i) => i.type === "TRADE_OFFER"));
    assert.strictEqual(new Set(all).size, all.length, JSON.stringify(all));
    assert.ok(offersOf(r2, "mobilization").length >= 1);

    const full = Object.fromEntries(MINERALS.map((t) => [`type:${t}`, (CRUISER[`type:${t}`] || 0) * STOCKPILE.stockpileRuns]));
    const r3 = planTrade(makeSnapshot({ stations: [station("npc-1", 30000001, { minerals: full }),
      station("npc-2", 30000002, { minerals: full })] }), makeParams(), { intents: [] }, { intents: [] });
    assert.deepStrictEqual(r3.intents, []);
    assert.ok(r3.notes.includes("TRADE_STOCKPILE_FULL"), JSON.stringify(r3.notes));

    const regress = makeSnapshot({ stations: [station("npc-1", 30000001, { hulls: {} }),
      station("npc-2", 30000002, { lines: 0 })],
      trade: { quotes: Object.fromEntries(MINERALS.map((t) => [`type:${t}`, quoteOf(50000)])) } });
    const legacy = planTrade(regress, makeParams({ maxOffersPerReview: 2 }, { stockpile: false, mobilizationStations: 1 }),
      { intents: [] }, { intents: [] });
    for (const off of [{ stockpileEnabled: false }, { stockpileRuns: 0 }]) {
      assert.deepStrictEqual(planTrade(regress, makeParams({ maxOffersPerReview: 2, ...off }, { mobilizationStations: 1 }),
        { intents: [] }, { intents: [] }), legacy, JSON.stringify(off));
    }
    const strip = ({ purpose, ...rest }) => rest;
    assert.ok(legacy.intents.every((i) => i.purpose === "mobilization"));
    assert.deepStrictEqual(legacy.intents.map(strip), [34, 35].map((t, slot) => ({
      type: "TRADE_OFFER", slot, stationId: "npc-1", systemId: 30000001, issuerCorporationId: 1000001,
      itemKind: "mineral", itemKey: `type:${t}`, typeId: t, quantity: CRUISER[`type:${t}`], unitPriceMilli: 50000,
      iskTotal: CRUISER[`type:${t}`] * 50, refPriceMilli: 50000, capPriceMilli: 100000, priceSource: "bid",
      expiresAt: AT + BASE_TRADE.offerTtlMs })));
    assert.deepStrictEqual(legacy.notes, []);
  });

  test("T4 service + panel: galaxy {open, factions}, countOpenAll listed, plan of a faction without budget "
    + "bySecClass / byRegion from the graph, graph not ready -> other", async () => {
    const driver = H.loadDriver();
    if (!driver.ok) return skip("better-sqlite3 unavailable");
    await H.withStore(driver, async (reopen) => {
      const opened = reopen();
      const shared = H.sharedOf();
      const views = createViewRegistry();
      const journal = createJournal({ clock: shared.clock, maxPayloadBytes: 16384, maxRows: 500 });
      const cfg = { ...DEFAULTS, trade: { ...DEFAULTS.trade, enabled: true },
        modules: { ...DEFAULTS.modules, strategy: { enabled: true } }, stations: { ...DEFAULTS.stations, enabled: true } };
      const systems = new Map([[30000001, { secClass: "highsec", regionId: 10000001 }],
        [30000002, { secClass: "lowsec", regionId: 10000002 }]]);
      const graph = { getSystem: (id) => systems.get(Number(id)) || null,
        getRegionName: (id) => (id === 10000001 ? "Derelik" : null) };
      let graphReady = true;
      const graphFacade = { getGraph: () => (graphReady ? { ok: true, graph } : { ok: false, reason: "GRAPH_NOT_READY" }) };
      const started = require("../../lib/economy/trade").startTrade({
        config: cfg, persistence: { ok: true, store: opened.store, journal }, clock: shared.clock, views, ids: IDS,
        adapter: createFakeTradeAdapter(), getGraph: () => graphFacade,
        setTimer: () => ({ cancel() {}, hasRef: () => false }),
      });
      assert.ok(started.ok, JSON.stringify(started));
      const tr = started.trade;
      const tx = (fn) => {
        const r = opened.store.transaction("test", fn);
        assert.ok(r.ok, JSON.stringify(r));
        return r.value;
      };
      for (const f of [F, F2]) {
        const funded = tx((db) => tr.fundFromUpkeepInTx(db, { factionId: f, units: 1000, paidUntilTo: AT }, `fund:${f}`));
        assert.ok(funded.ok, JSON.stringify(funded));
      }
      const spec = (factionId, stationId, systemId, typeId) => ({ factionId, stationId, systemId,
        issuerCorporationId: 1000001, itemKind: "mineral", itemKey: `type:${typeId}`, typeId, quantity: 100,
        unitPriceMilli: 5000, iskTotal: 500, refPriceMilli: 5000, capPriceMilli: 9000, priceSource: "bid",
        expiresAt: AT + 86400000, at: AT });
      const made = [spec(F, "npc-1", 30000001, 34), spec(F, "npc-1", 30000001, 35), spec(F2, "npc-2", 30000002, 34)]
        .map((s, i) => tx((db) => tr.planOfferInTx(db, s, `strategy:review:${s.factionId}:1:${i}:TRADE_OFFER`)));
      for (const m of made) assert.ok(m.ok && !m.duplicate, JSON.stringify(m));
      tx((db) => db.prepare("UPDATE world_trade_offers SET state = 'OPEN' WHERE offer_id = ?").run(made[2].offer.offerId));

      const read = tx((db) => tr.readForReview(db, F, { stations: [{ stationId: "npc-1", systemId: 30000001,
        kind: "npc", ownerCorporationId: 1000001 }], at: AT, limit: 32 }));
      assert.ok(read.ok, JSON.stringify(read));
      assert.deepStrictEqual(read.trade.galaxy, { open: 3, factions: 2 });
      assert.deepStrictEqual(tx((db) => tr.offers.countOpenAll(db)), { ok: true, open: 3, listed: 1 });
      assert.strictEqual(tr.offers.countOpenAll(null).reason, "TX_REQUIRED");

      const seq0 = tr.getStatus().seq;
      tr.notePlan(AMARR, { at: AT, tradeReason: "NO_NPC_STATION", created: { mobilization: 0, stockpile: 0, private: 0 },
        notes: {} });
      tr.notePlan(F, { at: AT, tradeReason: null, created: { mobilization: 1, stockpile: 2, private: 0 },
        notes: { TRADE_STOCKPILE_OFFER: 2 } });
      assert.strictEqual(tr.getStatus().seq, seq0 + 2, "notePlan moves the panel cacheKey");
      const c = views.getView("trade").getData().contracts;
      assert.deepStrictEqual([c.target, c.open, c.listed], [200, 3, 1]);
      const cap = Math.min(cfg.trade.maxOpenOffersPerFaction, Math.ceil(200 / 2));
      assert.deepStrictEqual(c.byFaction, [{ faction: F, open: 2, cap, tiers: [2, 0, 0] },
        { faction: F2, open: 1, cap, tiers: [1, 0, 0] }]);
      assert.deepStrictEqual(c.bySecClass, { highsec: 2, lowsec: 1, nullsec: 0, other: 0 });
      assert.deepStrictEqual(c.byRegion, [["Derelik", 2], [10000002, 1]]);
      assert.deepStrictEqual(c.plans.map((p) => [p.faction, p.tradeReason, p.created.stockpile]),
        [[AMARR, "NO_NPC_STATION", 0], [F, null, 2]]);

      graphReady = false;
      const c2 = views.getView("trade").getData().contracts;
      assert.deepStrictEqual(c2.bySecClass, { highsec: 0, lowsec: 0, nullsec: 0, other: 3 });
      assert.deepStrictEqual(c2.byRegion, []);
      tr.stop();
    });
  });

  test("T5 config: defaults without trade / review row warnings, new defaults, params.trade has the 5 new keys",
    () => {
      const { config: cfg, warnings } = config.resolveConfig({ modDir: MOD_DIR, env: {} });
      const w = warnings || [];
      assert.ok(!w.some((x) => x.startsWith("trade rows per review") || x.startsWith("one strategy review may write")),
        JSON.stringify(w));
      assert.ok(!w.some((x) => x.startsWith("trade.stockpile")), JSON.stringify(w));
      const t = cfg.trade;
      assert.deepStrictEqual([t.stockpileEnabled, t.stockpileRuns, t.stockpileMaxIskPerOffer,
        t.stockpileFreeFloorPermille, t.targetOpenContracts, t.maxOffersPerReview, t.maxOpenOffersPerFaction,
        t.maxOpenOffersPerStation, t.maxIssuesPerPass], [true, 8, 5000000, 300, 200, 4, 32, 8, 4]);
      const low = config.resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_TRADE_STOCKPILE_MAX_ISK_PER_OFFER: "1000" } });
      assert.ok((low.warnings || []).some((x) => x.startsWith("trade.stockpileMaxIskPerOffer < trade.minIskPerOffer")));
      const env = { EVEJS_LNE_TRADE_STOCKPILE_RUNS: "7", EVEJS_LNE_TRADE_TARGET_OPEN_CONTRACTS: "0" };
      const service = createReviewService({ store: {}, journal: {}, strategyRepository: { limits: { maxResourceUnits: 1 } },
        intelRepository: {}, registry: {}, kinds: { list: [], get: () => null }, powerTable: {}, scoring: {},
        scheduler: {}, fleets: {}, clock: { now: () => 0 }, worldSeed: 1,
        config: config.resolveConfig({ modDir: MOD_DIR, env }).config, hostility: () => true,
        isCampaignOk: () => true, industryCatalog: {} });
      const p = service.params.trade;
      assert.ok(p, "params.trade with the default config");
      assert.deepStrictEqual([p.stockpileEnabled, p.stockpileRuns, p.stockpileMaxIskPerOffer,
        p.stockpileFreeFloorPermille, p.targetOpenContracts], [true, 7, 5000000, 300, 0]);
    });

  test("T6: private offer + stockpile in one round -> stockpile ISK <= availableIsk - private - floor",
    () => {
      const stocked = Object.fromEntries(MINERALS.filter((t) => t !== 34).map((t) => [`type:${t}`, 1e9]));
      const available = 10000000;
      const snap = makeSnapshot({
        stations: [station("npc-1", 30000001, { hulls: {}, minerals: stocked }), station("npc-2", 30000002, { lines: 0 })],
        trade: { budget: { availableIsk: available, reservedIsk: 0 },
          suppliers: [{ characterId: 777, standingMilli: 5000, bonusPermille: 60 }],
          privateQuotes: { 60: { "type:34": quoteOf(6000) } } },
      });
      const params = makeParams({ maxPrivateOffersPerReview: 2, maxOpenPrivateOffersPerFaction: 4,
        maxOpenPrivateOffersPerCharacter: 1, privateOfferTtlMs: 86400000 }, { mobilizationStations: 1 });
      const r = planTrade(snap, params, { intents: [] }, { intents: [] });
      const priv = r.intents.filter((i) => i.type === "TRADE_OFFER" && i.assigneeCharacterId === 777);
      assert.strictEqual(priv.length, 1, JSON.stringify(r));
      const privateIsk = priv[0].iskTotal;
      const floorIsk = Math.floor((available * STOCKPILE.stockpileFreeFloorPermille) / 1000);
      assert.ok(available - privateIsk - floorIsk > 0, "fixture: some room left above the floor");
      const sp = offersOf(r, "stockpile");
      assert.ok(sp.length >= 1, JSON.stringify(r.notes));
      const spIsk = sp.reduce((s, i) => s + i.iskTotal, 0);
      assert.ok(spIsk <= available - privateIsk - floorIsk, `stockpile ${spIsk} > ${available - privateIsk - floorIsk}`);
      assert.ok(r.notes.includes("TRADE_STOCKPILE_FLOOR"), JSON.stringify(r.notes));
    });

  const recallSnap = ({ hulls = {}, open = [] } = {}) => makeSnapshot({ stations: [station("npc-1", 30000001, { hulls })],
    trade: { open } });
  const recallParams = (trade = {}) => makeParams({ stockpileRecallEnabled: true, stockpileRecallMinNeedPermille: 1000,
    ...trade }, { mobilizationStations: 1 });
  const stockpileX = (extra = {}) => ({ offerId: "tp_x1", stationId: "npc-1", itemKey: "type:34", typeId: 34,
    quantity: 1000, state: "OPEN", version: 3, expiresAt: AT + 1e9, iskTotal: 5000, issuerCorporationId: 1000001,
    assigneeCharacterId: null, ...extra });
  const recallsOf = (r) => r.intents.filter((i) => i.type === "TRADE_CANCEL" && i.reason === "RECALLED");
  const plan = (snap, params) => planTrade(snap, params, { intents: [] }, { intents: [] });

  test("T7: review 1 stockpile on the mobilization station, review 2 deficit -> recall OPEN / PLANNED "
    + "before the offers, review 3 -> mobilization offer of the pair", () => {
    const r1 = plan(recallSnap({ hulls: { cruiser: 5 } }), recallParams());
    assert.deepStrictEqual(offersOf(r1, "mobilization"), []);
    assert.ok(offersOf(r1, "stockpile").some((i) => i.stationId === "npc-1" && i.itemKey === "type:34"),
      JSON.stringify(r1));
    const r2 = plan(recallSnap({ open: [stockpileX()] }), recallParams());
    assert.deepStrictEqual(recallsOf(r2), [{ type: "TRADE_CANCEL", offerId: "tp_x1", expectedVersion: 3,
      reason: "RECALLED", from: "OPEN" }], JSON.stringify(r2));
    const firstOffer = r2.intents.findIndex((i) => i.type === "TRADE_OFFER");
    assert.ok(firstOffer === -1 || firstOffer > r2.intents.indexOf(recallsOf(r2)[0]), "recall before the offers");
    assert.ok(r2.notes.includes("TRADE_STOCKPILE_RECALL:type:34@npc-1"), JSON.stringify(r2.notes));
    assert.ok(r2.notes.includes("TRADE_OFFER_EXISTS:type:34@npc-1"), JSON.stringify(r2.notes));
    assert.deepStrictEqual(r2.intents.filter((i) => i.type === "TRADE_OFFER" && i.stationId === "npc-1"
      && i.itemKey === "type:34"), []);
    const r2p = plan(recallSnap({ open: [stockpileX({ state: "PLANNED" })] }), recallParams());
    assert.deepStrictEqual(recallsOf(r2p).map((i) => [i.offerId, i.from]), [["tp_x1", "PLANNED"]]);
    const r3 = plan(recallSnap(), recallParams());
    assert.deepStrictEqual(recallsOf(r3), []);
    assert.ok(offersOf(r3, "mobilization").some((i) => i.stationId === "npc-1" && i.itemKey === "type:34"),
      JSON.stringify(r3));
  });

  test("T8 no recall: ACCEPTED / ISSUING, to_ prefix, private, expired, flag off, need below "
    + "the threshold, cancels used by step 1, ore offer; config keys, warning, params.trade", () => {
    const cases = [
      ["ACCEPTED", stockpileX({ state: "ACCEPTED" })],
      ["ISSUING", stockpileX({ state: "ISSUING" })],
      ["to_ prefix", stockpileX({ offerId: "to_x1" })],
      ["private", stockpileX({ assigneeCharacterId: 777 })],
      ["expired", stockpileX({ expiresAt: AT })],
      ["need below iskTotal", stockpileX({ iskTotal: 1e12 })],
    ];
    for (const [name, x] of cases) {
      const r = plan(recallSnap({ open: [x] }), recallParams());
      assert.deepStrictEqual(recallsOf(r), [], name);
      assert.ok(!r.notes.some((n) => n.startsWith("TRADE_STOCKPILE_RECALL")), name);
      assert.ok(r.notes.includes("TRADE_OFFER_EXISTS:type:34@npc-1"), `${name}: ${JSON.stringify(r.notes)}`);
    }
    const snap = recallSnap({ open: [stockpileX()] });
    const { stockpileRecallEnabled: _e, stockpileRecallMinNeedPermille: _p, ...withoutKeys } = recallParams().trade;
    const before = planTrade(snap, { ...recallParams(), trade: withoutKeys }, { intents: [] }, { intents: [] });
    assert.deepStrictEqual(plan(snap, recallParams({ stockpileRecallEnabled: false })), before);
    assert.deepStrictEqual(recallsOf(before), []);
    const expired = { offerId: "to_e1", stationId: "npc-1", itemKey: "type:40", typeId: 40, quantity: 1,
      state: "PLANNED", version: 1, expiresAt: AT, iskTotal: 5, issuerCorporationId: 1000001 };
    const used = plan(recallSnap({ open: [expired, stockpileX()] }), recallParams({ maxCancelsPerReview: 1 }));
    assert.deepStrictEqual(used.intents.filter((i) => i.type === "TRADE_CANCEL").map((i) => i.reason), ["EXPIRED"]);
    const two = plan(recallSnap({ open: [expired, stockpileX()] }), recallParams({ maxCancelsPerReview: 2 }));
    assert.deepStrictEqual(two.intents.filter((i) => i.type === "TRADE_CANCEL").map((i) => i.reason),
      ["EXPIRED", "RECALLED"]);
    const ore = { offerId: "tp_o1", stationId: "npc-1", itemKey: "type:1230", typeId: 1230, quantity: 100,
      state: "OPEN", version: 1, expiresAt: AT + 1e9, iskTotal: 5000, issuerCorporationId: 1000001 };
    const ro = plan(recallSnap({ open: [ore] }), recallParams());
    assert.deepStrictEqual(recallsOf(ro), []);
    assert.ok(!ro.notes.includes("TRADE_OFFER_EXISTS:type:34@npc-1"), JSON.stringify(ro.notes));
    assert.ok(offersOf(ro, "mobilization").some((i) => i.itemKey === "type:34"), JSON.stringify(ro));

    const { config: cfg, warnings } = config.resolveConfig({ modDir: MOD_DIR, env: {} });
    assert.deepStrictEqual([cfg.trade.stockpileRecallEnabled, cfg.trade.stockpileRecallMinNeedPermille], [true, 1000]);
    assert.ok(!(warnings || []).some((x) => x.startsWith("trade.stockpileRecallEnabled")), JSON.stringify(warnings));
    const zero = config.resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_TRADE_MAX_CANCELS_PER_REVIEW: "0" } });
    assert.ok((zero.warnings || []).some((x) => x.startsWith("trade.stockpileRecallEnabled")),
      JSON.stringify(zero.warnings));
    const env = { EVEJS_LNE_TRADE_STOCKPILE_RECALL_ENABLED: "false", EVEJS_LNE_TRADE_STOCKPILE_RECALL_MIN_NEED_PERMILLE: "0" };
    const service = createReviewService({ store: {}, journal: {}, strategyRepository: { limits: { maxResourceUnits: 1 } },
      intelRepository: {}, registry: {}, kinds: { list: [], get: () => null }, powerTable: {}, scoring: {},
      scheduler: {}, fleets: {}, clock: { now: () => 0 }, worldSeed: 1,
      config: config.resolveConfig({ modDir: MOD_DIR, env }).config, hostility: () => true,
      isCampaignOk: () => true, industryCatalog: {} });
    const p = service.params.trade;
    assert.deepStrictEqual([p.stockpileRecallEnabled, p.stockpileRecallMinNeedPermille], [false, 0]);
  });

  test("T9 SQLite: tp_/to_ prefix, payload without purpose, recall OPEN = expiresAt at + version "
    + "duplicate, closeWanted EXPIRED, stale executor read -> VERSION_CONFLICT then fresh retry, PLANNED RECALLED",
  async () => {
    const driver = H.loadDriver();
    if (!driver.ok) return skip("better-sqlite3 unavailable");
    const { closeWanted } = require("../../lib/economy/trade/executorRules");
    await H.withStore(driver, async (reopen) => {
      const opened = reopen();
      const shared = H.sharedOf();
      const journal = createJournal({ clock: shared.clock, maxPayloadBytes: 16384, maxRows: 500 });
      const cfg = { ...DEFAULTS, trade: { ...DEFAULTS.trade, enabled: true },
        modules: { ...DEFAULTS.modules, strategy: { enabled: true } }, stations: { ...DEFAULTS.stations, enabled: true } };
      const started = require("../../lib/economy/trade").startTrade({
        config: cfg, persistence: { ok: true, store: opened.store, journal }, clock: shared.clock,
        views: createViewRegistry(), ids: IDS, adapter: createFakeTradeAdapter(),
        setTimer: () => ({ cancel() {}, hasRef: () => false }),
      });
      assert.ok(started.ok, JSON.stringify(started));
      const tr = started.trade;
      const tx = (fn) => {
        const r = opened.store.transaction("test", fn);
        assert.ok(r.ok, JSON.stringify(r));
        return r.value;
      };
      assert.ok(tx((db) => tr.fundFromUpkeepInTx(db, { factionId: F, units: 1000, paidUntilTo: AT }, "fund:r")).ok);
      const budget = () => tx((db) => tr.readBudget(db, F)).budget;
      const spec = (typeId, extra = {}) => ({ factionId: F, stationId: "npc-1", systemId: 30000001,
        issuerCorporationId: 1000001, itemKind: "mineral", itemKey: `type:${typeId}`, typeId, quantity: 100,
        unitPriceMilli: 5000, iskTotal: 500, refPriceMilli: 5000, capPriceMilli: 9000, priceSource: "bid",
        expiresAt: AT + 86400000, at: AT, ...extra });
      const ik = (n) => `strategy:review:${F}:9:${n}:TRADE`;

      const sp = tx((db) => tr.planOfferInTx(db, spec(34, { purpose: "stockpile" }), ik(1)));
      assert.ok(sp.ok && sp.offer.offerId.startsWith("tp_"), JSON.stringify(sp));
      const mob = tx((db) => tr.planOfferInTx(db, spec(36, { purpose: "mobilization" }), ik(2)));
      const plain = tx((db) => tr.planOfferInTx(db, spec(37), ik(3)));
      assert.ok(mob.offer.offerId.startsWith("to_") && plain.offer.offerId.startsWith("to_"));
      assert.strictEqual(tx((db) => tr.planOfferInTx(db, spec(38, { purpose: "bogus" }), ik(4))).detail, "purpose");
      const entry = tx((db) => journal.findByKey(db, `${ik(1)}:offer`)).entry;
      assert.deepStrictEqual(Object.keys(entry.payload).sort(),
        ["expiresAt", "factionId", "iskTotal", "itemKey", "quantity", "stationId", "unitPriceMilli"]);
      assert.strictEqual(entry.aggregateId, sp.offer.offerId);

      const id = sp.offer.offerId;
      const step = (from, to, version, patch, key) => tx((db) => tr.offers.transitionOfferInTx(db,
        { offerId: id, expectedVersion: version, from, to, reason: "", at: AT, ...(patch ? { patch } : {}) }, key));
      const issuing = step("PLANNED", "ISSUING", sp.offer.version, null, "t:issuing");
      const open = step("ISSUING", "OPEN", issuing.offer.version, { contractId: 9001 }, "t:open");
      assert.ok(open.ok && open.offer.state === "OPEN", JSON.stringify(open));
      const stale = open.offer;
      const reservedBefore = budget().reservedIsk;

      const RECALL_AT = AT + 5000;
      const recall = { factionId: F, offerId: id, expectedVersion: stale.version, reason: "RECALLED", from: "OPEN",
        at: RECALL_AT };
      const rc = tx((db) => tr.cancelOfferInTx(db, recall, ik(5)));
      assert.ok(rc.ok && !rc.duplicate, JSON.stringify(rc));
      assert.deepStrictEqual([rc.offer.state, rc.offer.expiresAt, rc.offer.version, rc.offer.endReason],
        ["OPEN", RECALL_AT, stale.version + 1, null]);
      assert.strictEqual(budget().reservedIsk, reservedBefore);
      const dup = tx((db) => tr.cancelOfferInTx(db, recall, ik(5)));
      assert.ok(dup.ok && dup.duplicate === true && dup.offer.version === stale.version + 1, JSON.stringify(dup));
      const bad = tx((db) => tr.cancelOfferInTx(db, { ...recall, reason: "EXPIRED" }, ik(6)));
      assert.deepStrictEqual([bad.reason, bad.detail], ["TRADE_INVALID_INPUT", "from"]);

      const npc = { stationId: "npc-1", kind: "npc", ownerCorporationId: 1000001 };
      assert.strictEqual(closeWanted(rc.offer, npc, RECALL_AT, "run"), "EXPIRED");
      assert.strictEqual(closeWanted(stale, npc, RECALL_AT, "run"), null);
      const cancel = (version) => tx((db) => tr.offers.transitionOfferInTx(db, { offerId: id, expectedVersion: version,
        from: "OPEN", to: "CANCELLED", reason: "EXPIRED", at: RECALL_AT }, "t:cancelled"));
      assert.strictEqual(cancel(stale.version).reason, "VERSION_CONFLICT");
      const closed = cancel(rc.offer.version);
      assert.ok(closed.ok && !closed.duplicate, JSON.stringify(closed));
      assert.deepStrictEqual([closed.offer.state, closed.offer.endReason], ["CANCELLED", "EXPIRED"]);
      assert.strictEqual(budget().reservedIsk, reservedBefore - 500, "released by OPEN -> CANCELLED");
      const late = tx((db) => tr.offers.recallOfferInTx(db, { offerId: id, expectedVersion: closed.offer.version,
        at: RECALL_AT }, `${ik(7)}:cancel`));
      assert.strictEqual(late.reason, "INVALID_TRANSITION");

      const availableBefore = budget().availableIsk;
      const sp2 = tx((db) => tr.planOfferInTx(db, spec(35, { purpose: "stockpile" }), ik(8)));
      assert.ok(sp2.ok && sp2.offer.offerId.startsWith("tp_"));
      const pc = tx((db) => tr.cancelOfferInTx(db, { factionId: F, offerId: sp2.offer.offerId,
        expectedVersion: sp2.offer.version, reason: "RECALLED", from: "PLANNED", at: AT }, ik(9)));
      assert.ok(pc.ok, JSON.stringify(pc));
      assert.deepStrictEqual([pc.offer.state, pc.offer.endReason], ["CANCELLED", "RECALLED"]);
      assert.strictEqual(budget().availableIsk, availableBefore);
      tr.stop();
    });
  });

  test("T10: maxOffersPerReview 1 + one private offer -> no mobilization and no stockpile offer; control "
    + "without the supplier -> 1 mobilization offer", () => {
    const stocked = Object.fromEntries(MINERALS.filter((t) => t !== 34).map((t) => [`type:${t}`, 1e9]));
    const snapOf = (suppliers) => makeSnapshot({
      stations: [station("npc-1", 30000001, { hulls: {}, minerals: stocked }), station("npc-2", 30000002, { lines: 0 })],
      trade: { suppliers, privateQuotes: { 60: { "type:34": quoteOf(6000) } } },
    });
    const params = makeParams({ maxOffersPerReview: 1, maxPrivateOffersPerReview: 2, maxOpenPrivateOffersPerFaction: 4,
      maxOpenPrivateOffersPerCharacter: 1, privateOfferTtlMs: 86400000 }, { mobilizationStations: 1 });
    const r = plan(snapOf([{ characterId: 777, standingMilli: 5000, bonusPermille: 60 }]), params);
    const offers = r.intents.filter((i) => i.type === "TRADE_OFFER");
    assert.deepStrictEqual(offers.map((i) => i.assigneeCharacterId), [777], JSON.stringify(r));
    assert.deepStrictEqual([offersOf(r, "mobilization").length, offersOf(r, "stockpile").length], [0, 0]);
    const control = plan(snapOf([]), params);
    assert.deepStrictEqual(control.intents.filter((i) => i.type === "TRADE_OFFER").map((i) => [i.purpose, i.itemKey]),
      [["mobilization", "type:34"]]);
  });

  const LOT = 10000000;
  const TIER_KEYS = ["tiersEnabled", "tier1Isk", "tier2Isk", "tier3Isk", "tier2SharePermille", "tier3SharePermille",
    "tier1TtlMs", "tier2TtlMs", "tier3TtlMs", "tierMinOfferIsk", "tierMaxBudgetSharePermille", "maxOfferVolumeM3"];
  const TIERS = Object.fromEntries(TIER_KEYS.map((k) => [k, DEFAULTS.trade[k]]));
  const pyeSnap = (budget) => {
    const minerals = Object.fromEntries(MINERALS.map((t) => [`type:${t}`, 1e12]));
    minerals["type:35"] = CRUISER["type:35"] * 40 - 4730162;
    return makeSnapshot({ stations: [station("npc-1", 30000001, { lines: 0, minerals })],
      trade: { budget, quotes: { ...QUOTES, "type:35": quoteOf(15900) } } });
  };
  const RICH = { availableIsk: 9900000000, reservedIsk: 0 };

  test("LOT1 stockpile: tiers on -> lot 10 mln tier 1 (TTL tier 1, no FLOOR), lot 0 -> old tier 2 offer "
    + "tiers off -> min(stockpileMaxIskPerOffer, lot); the floor note stays for the free ISK", () => {
    const pye = (r) => offersOf(r, "stockpile").filter((i) => i.itemKey === "type:35");
    const on = plan(pyeSnap(RICH), makeParams({ ...TIERS, stockpileRuns: 40, publicLotMaxIsk: LOT }));
    assert.strictEqual(pye(on).length, 1, JSON.stringify(on));
    const o = pye(on)[0];
    assert.ok(o.iskTotal <= LOT, o.iskTotal);
    assert.deepStrictEqual([o.quantity, o.iskTotal, o.tier, o.expiresAt],
      [Math.floor((LOT * 1000) / 15900), Math.floor((Math.floor((LOT * 1000) / 15900) * 15900) / 1000), 1,
        AT + TIERS.tier1TtlMs]);
    assert.ok(!on.notes.some((n) => n === "TRADE_STOCKPILE_FLOOR" || n.startsWith("TRADE_BUDGET_SHORT")),
      JSON.stringify(on.notes));
    const off = plan(pyeSnap(RICH), makeParams({ ...TIERS, stockpileRuns: 40, publicLotMaxIsk: 0 }));
    const oldQ = Math.floor((Math.floor((4730162 * 15900) / 1000) * 1000) / 15900);
    assert.deepStrictEqual(pye(off).map((i) => [i.quantity, i.tier]), [[oldQ, 2]], JSON.stringify(off));
    const noTiers = (lot) => plan(pyeSnap(RICH), makeParams({ stockpileRuns: 40, stockpileMaxIskPerOffer: 50000000,
      publicLotMaxIsk: lot }));
    const nOn = noTiers(LOT);
    assert.deepStrictEqual(pye(nOn).map((i) => i.quantity), [Math.floor((LOT * 1000) / 15900)], JSON.stringify(nOn));
    assert.ok(pye(nOn)[0].iskTotal <= LOT);
    assert.ok(!nOn.notes.includes("TRADE_STOCKPILE_FLOOR"), JSON.stringify(nOn.notes));
    assert.deepStrictEqual(pye(noTiers(0)).map((i) => i.quantity), [Math.floor((50000000 * 1000) / 15900)]);
    const low = plan(makeSnapshot({ trade: { budget: { availableIsk: 1000000, reservedIsk: 0 } } }),
      makeParams({ publicLotMaxIsk: LOT }));
    assert.deepStrictEqual(offersOf(low, "stockpile").map((i) => i.iskTotal), [700000]);
    assert.ok(low.notes.includes("TRADE_STOCKPILE_FLOOR"), JSON.stringify(low.notes));
  });

  test("LOT2 mobilization: budget 9.9 bln -> offers <= lot, no BUDGET_SHORT; lot 0 -> whole need "
    + "lot < minIskPerOffer -> TRADE_OFFER_SMALL, not BUDGET_SHORT", () => {
    const snap = makeSnapshot({ stations: [station("npc-1", 30000001, { hulls: {} })],
      trade: { budget: RICH, quotes: { ...QUOTES, "type:34": quoteOf(100000) } } });
    const run = (lot) => plan(snap, makeParams({ publicLotMaxIsk: lot }, { stockpile: false, mobilizationStations: 1 }));
    const on = run(LOT);
    const mob = offersOf(on, "mobilization");
    assert.ok(mob.length >= 1 && mob.every((i) => i.iskTotal <= LOT), JSON.stringify(mob));
    const trit = mob.find((i) => i.itemKey === "type:34");
    assert.deepStrictEqual([trit.quantity, trit.iskTotal], [100000, LOT]);
    assert.ok(!on.notes.some((n) => n.startsWith("TRADE_BUDGET_SHORT")), JSON.stringify(on.notes));
    const old = offersOf(run(0), "mobilization").find((i) => i.itemKey === "type:34");
    assert.ok(old.iskTotal > LOT && old.quantity > 100000, JSON.stringify(old));
    const small = run(50000);
    assert.deepStrictEqual(offersOf(small, "mobilization"), []);
    assert.ok(small.notes.includes("TRADE_OFFER_SMALL:type:34"), JSON.stringify(small.notes));
    assert.ok(!small.notes.some((n) => n.startsWith("TRADE_BUDGET_SHORT")), JSON.stringify(small.notes));
  });

  test("OVR1 planOversizeRecalls: OPEN / PLANNED tp_ above the lot recalled (expiresAt order, cancelsLeft) "
    + "never small, to_, private, WTS, expired, ISSUING, step 1; off switches; step 4b does not recall it again", () => {
    const T = { publicLotMaxIsk: LOT, stockpileRecallEnabled: true };
    const x = (offerId, extra = {}) => stockpileX({ offerId, iskTotal: 75000000, expiresAt: AT + 200000, ...extra });
    const open = [
      x("tp_a"), x("tp_b", { state: "PLANNED", iskTotal: 20000000, expiresAt: AT + 100000, version: 7 }),
      x("tp_c", { iskTotal: 9000000 }), x("tp_lot", { iskTotal: LOT }), x("to_d"), x("tp_e", { assigneeCharacterId: 777 }),
      x("tp_f", { side: "sell" }), x("tp_g", { expiresAt: AT }), x("tp_h"), x("tp_i", { state: "ISSUING" }),
    ];
    const step1 = new Set(["tp_h"]);
    const r = planOversizeRecalls({ open }, T, AT, 10, step1);
    assert.deepStrictEqual(r.intents, [
      { type: "TRADE_CANCEL", offerId: "tp_b", expectedVersion: 7, reason: "RECALLED", from: "PLANNED" },
      { type: "TRADE_CANCEL", offerId: "tp_a", expectedVersion: 3, reason: "RECALLED", from: "OPEN" }]);
    assert.deepStrictEqual(r.notes, ["TRADE_STOCKPILE_RECALL_OVERSIZE:type:34@npc-1",
      "TRADE_STOCKPILE_RECALL_OVERSIZE:type:34@npc-1"]);
    assert.deepStrictEqual([...r.recalledIds], ["tp_b", "tp_a"]);
    assert.deepStrictEqual(planOversizeRecalls({ open }, T, AT, 1, step1).intents.map((i) => i.offerId), ["tp_b"]);
    for (const [name, t, left] of [["lot 0", { ...T, publicLotMaxIsk: 0 }, 10],
      ["recall off", { ...T, stockpileRecallEnabled: false }, 10], ["no cancels", T, 0]]) {
      assert.deepStrictEqual(planOversizeRecalls({ open }, t, AT, left, step1).intents, [], name);
    }
    const snap = makeSnapshot({ stations: [station("npc-1", 30000001, { hulls: {} })],
      trade: { open: [stockpileX({ iskTotal: 75000000 })], quotes: { ...QUOTES, "type:34": quoteOf(200000) } } });
    const withLot = plan(snap, recallParams({ publicLotMaxIsk: LOT }));
    assert.deepStrictEqual(recallsOf(withLot).map((i) => i.offerId), ["tp_x1"], JSON.stringify(withLot.intents));
    assert.ok(withLot.notes.includes("TRADE_STOCKPILE_RECALL_OVERSIZE:type:34@npc-1"), JSON.stringify(withLot.notes));
    assert.ok(!withLot.notes.includes("TRADE_STOCKPILE_RECALL:type:34@npc-1"), JSON.stringify(withLot.notes));
    assert.ok(withLot.notes.includes("TRADE_OFFER_EXISTS:type:34@npc-1"), "the pair stays taken in this round");
    const noLot = plan(snap, recallParams({ publicLotMaxIsk: 0 }));
    assert.deepStrictEqual(recallsOf(noLot).map((i) => i.offerId), ["tp_x1"]);
    assert.ok(noLot.notes.includes("TRADE_STOCKPILE_RECALL:type:34@npc-1"), JSON.stringify(noLot.notes));
  });

  test("CFG: defaults of both keys, lot warnings, params.trade.publicLotMaxIsk, panel lotMaxIsk source "
    + "TRADE_STOCKPILE_FLOOR expected, the oversize note in the dictionary", () => {
    const res = config.resolveConfig({ modDir: MOD_DIR, env: {} });
    assert.deepStrictEqual([res.config.trade.publicLotMaxIsk, res.config.trade.askCapIncludesExternal], [LOT, false]);
    const lotWarn = (w) => (w || []).filter((s) => s.startsWith("trade.publicLotMaxIsk"));
    assert.deepStrictEqual(lotWarn(res.warnings), []);
    const warnOf = (env) => lotWarn(config.resolveConfig({ modDir: MOD_DIR, env }).warnings)
      .map((s) => s.split(" - ")[0]);
    assert.deepStrictEqual(warnOf({ EVEJS_LNE_TRADE_PUBLIC_LOT_MAX_ISK: "50000" }),
      ["trade.publicLotMaxIsk < trade.minIskPerOffer", "trade.publicLotMaxIsk < trade.tierMinOfferIsk"]);
    assert.deepStrictEqual(warnOf({ EVEJS_LNE_TRADE_PUBLIC_LOT_MAX_ISK: "1000000" }),
      ["trade.publicLotMaxIsk < trade.tierMinOfferIsk"]);
    assert.deepStrictEqual(warnOf({ EVEJS_LNE_TRADE_PUBLIC_LOT_MAX_ISK: "1000000", EVEJS_LNE_TRADE_TIERS_ENABLED: "false" }),
      []);
    assert.deepStrictEqual(warnOf({ EVEJS_LNE_TRADE_PUBLIC_LOT_MAX_ISK: "0" }), []);
    const env = { EVEJS_LNE_TRADE_PUBLIC_LOT_MAX_ISK: "7000000", EVEJS_LNE_TRADE_ASK_CAP_INCLUDES_EXTERNAL: "true" };
    const cfg = config.resolveConfig({ modDir: MOD_DIR, env }).config;
    assert.deepStrictEqual([cfg.trade.publicLotMaxIsk, cfg.trade.askCapIncludesExternal], [7000000, true]);
    const service = createReviewService({ store: {}, journal: {}, strategyRepository: { limits: { maxResourceUnits: 1 } },
      intelRepository: {}, registry: {}, kinds: { list: [], get: () => null }, powerTable: {}, scoring: {},
      scheduler: {}, fleets: {}, clock: { now: () => 0 }, worldSeed: 1, config: cfg, hostility: () => true,
      isCampaignOk: () => true, industryCatalog: {} });
    assert.strictEqual(service.params.trade.publicLotMaxIsk, 7000000);
    assert.strictEqual(describeNote("TRADE_STOCKPILE_FLOOR").category, "oczekiwane");
    const n = describeNote("TRADE_STOCKPILE_RECALL_OVERSIZE:type:34@npc-1");
    assert.deepStrictEqual([n.known, n.category, n.arg], [true, "informacja", "type:34@npc-1"]);
  });
};
