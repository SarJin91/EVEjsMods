"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const config = require("../../config");
const { planTrade } = require("../../lib/strategy/ai/trade");
const { expectedYield, portionsFor, primaryOf } = require("../../lib/strategy/data/oreYield");
const { NOTE_DICTIONARY } = require("../../lib/strategy/activity/notes");
const { createReviewService } = require("../../lib/strategy/reviewService");
const { createJournal } = require("../../lib/persistence/journal");
const { createViewRegistry } = require("../../lib/observer/views");
const { startTrade } = require("../../lib/economy/trade");
const { createTradeService } = require("../../lib/economy/trade/tradeService");
const { createBudgetRepository } = require("../../lib/economy/trade/budgetRepository");
const { createOfferRepository } = require("../../lib/economy/trade/offerRepository");
const { buildTradeCatalog, oreCandidates } = require("../../lib/economy/trade/tradeCatalog");
const { stepAccepted, stepIntake } = require("../../lib/economy/trade/intake");
const { readItemTypeFactsFrom } = require("../../lib/adapter/itemTypeFacts");
const ORE_TYPES = require("../../lib/economy/data/oreTypes");
const S = require("../../lib/economy/trade/schema");
const { harness: H } = require("../battle/settlement.test");
const { createFakeTradeAdapter } = require("../_support/fakeTradeAdapter");
const { GROUPS: HULL_RECIPES } = require("../../lib/economy/data/hullRecipes");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const DEFAULTS = config.resolveConfig({ modDir: MOD_DIR, env: {} }).config;
const F = 500019;
const AT = 1000000;
const CORP = 1000001;
const MINERALS = [34, 35, 36, 37, 38, 39, 40];
const EFF = 800;

const RECIPES = {};
for (const [group, data] of Object.entries(HULL_RECIPES)) RECIPES[group] = { minerals: { ...data.minerals } };
const BS = RECIPES.battleship.minerals;

const REGISTRY = { resolveItemByTypeID: (id) => ({ typeID: id, name: `Ore ${id}`, volume: 0.1, portionSize: 100 }) };
const CATALOG = buildTradeCatalog({ oreTypes: ORE_TYPES,
  factsRead: readItemTypeFactsFrom(REGISTRY, oreCandidates(ORE_TYPES).take), oreOffersEnabled: true });
const ORE_YIELDS = Object.fromEntries(CATALOG.entries.filter((e) => e.itemKind === "ore")
  .map((e) => [e.itemKey, { portionSize: e.portionSize, minerals: e.minerals.map((p) => [p[0], p[1]]) }]));

const quoteOf = (unitMilli) => ({ ok: true, unitMilli, refMilli: unitMilli, capMilli: unitMilli * 2, source: "bid",
  capped: false });
const MINERAL_MILLI = { 34: 4000, 35: 5000, 36: 60000 };
const ORES = [18, 1224, 1228, 1230];
const QUOTES = Object.fromEntries([...MINERALS.map((t) => [`type:${t}`, quoteOf(MINERAL_MILLI[t] || 18500)]),
  ...ORES.map((b) => [`type:${b}`, quoteOf(10000)])]);
const VOLUMES = { ...Object.fromEntries(MINERALS.map((t) => [`type:${t}`, 1])),
  "type:18": 35, "type:1224": 30, "type:1228": 15, "type:1230": 10 };
const oreRow = (b, distance = 0) => ({ baseTypeId: b, itemKey: `type:${b}`, distance });
const HIGHSEC = { ores: ORES.map((b) => oreRow(b)), minerals: ["type:34", "type:35", "type:36"], pending: false };

function station(stationId, systemId, extra = {}) {
  return { stationId, systemId, kind: "npc", ownerCorporationId: CORP, lines: 0, activeJobs: [],
    minerals: {}, hulls: {}, ...extra };
}

function makeSnapshot({ stations, trade = {}, local = true } = {}) {
  const st = stations || [station("npc-1", 30000001)];
  const base = {
    mode: "ready", galaxy: { open: 0, factions: 13 },
    budget: { availableIsk: 10000000000, reservedIsk: 0 },
    open: [], openTruncated: false,
    stations: st.map((s) => ({ stationId: s.stationId, systemId: s.systemId, ownerCorporationId: s.ownerCorporationId,
      kind: s.kind })),
    quotes: QUOTES, privateQuotes: {}, suppliers: [], volumes: VOLUMES,
  };
  if (local) {
    base.localOre = Object.fromEntries(st.map((s) => [s.stationId, HIGHSEC]));
    base.oreYields = ORE_YIELDS;
    base.oreRefineEfficiencyPermille = EFF;
  }
  return {
    at: AT, seed: 1, factionId: F,
    faction: { status: "ACTIVE", homeSystemId: 30000001, doctrineId: "test-v1", version: 1 },
    doctrine: { doctrineId: "test-v1", templates: { combat: [{ hullGroup: "battleship", count: 1 }] } },
    stationsMode: "ready",
    stations: st.map((s) => ({ stationId: s.stationId, systemId: s.systemId, kind: s.kind,
      ownerCorporationId: s.ownerCorporationId })),
    neighbors: () => [],
    supply: { frontTargets: [30000001] },
    production: { mode: "ready", recipes: RECIPES, recipesVersion: 1, stations: st, inProduction: {},
      activeJobsTotal: 0, truncated: false },
    logistics: { mode: "ready", open: [], busyFleetIds: [], carriers: {}, truncated: false },
    trade: { ...base, ...trade },
  };
}

const BASE_TRADE = {
  premiumPermille: 1100, askCapPermille: 980, maxOffersPerReview: 8, maxCancelsPerReview: 4,
  maxOpenOffersPerFaction: 32, maxOpenOffersPerStation: 8, maxQuantityPerOffer: 100000000, minIskPerOffer: 100000,
  maxIskPerOffer: 1000000000, offerTtlMs: 259200000, factoryRunsTarget: 2, maxUnitPriceMilli: 1000000000000,
  priceCacheMs: 3600000, stockpileEnabled: true, stockpileRuns: 8, stockpileMaxIskPerOffer: 5000000,
  stockpileFreeFloorPermille: 300, targetOpenContracts: 200,
};
const TIER_KEYS = ["tiersEnabled", "tier1Isk", "tier2Isk", "tier3Isk", "tier2SharePermille", "tier3SharePermille",
  "tier1TtlMs", "tier2TtlMs", "tier3TtlMs", "tierMinOfferIsk", "tierMaxBudgetSharePermille", "maxOfferVolumeM3"];
const TIERS = Object.fromEntries(TIER_KEYS.map((k) => [k, DEFAULTS.trade[k]]));
const LOCAL_ON = { stockpileLocalOnly: true, oreOffersEnabled: true };

function makeParams(trade = LOCAL_ON, { tiers = true } = {}) {
  return {
    trade: { ...BASE_TRADE, ...(tiers ? TIERS : {}), ...trade },
    production: { maxJobsPerReview: 2, maxRunsPerJob: 4, maxActiveJobsPerFaction: 8, targetStockFleets: 1,
      mobilizeHulls: "required", miningNeedsHulls: false, logisticsNeedsHulls: false, mobilizationStations: 1,
      hullGroups: Object.keys(HULL_RECIPES) },
    maxAssemblyJumps: 15, maxBfsSystems: 2000,
  };
}

const plan = (snap, params) => planTrade(snap, params, { intents: [] }, { intents: [] });
const offersOf = (r, purpose) => r.intents.filter((i) => i.type === "TRADE_OFFER" && (!purpose || i.purpose === purpose));
const yieldOf = (portions, b, k) => (expectedYield(portions, ORE_YIELDS[`type:${b}`].minerals, EFF)
  .find((p) => p[0] === k) || [k, 0])[1];
const asOpen = (i, n, state = "OPEN") => ({ offerId: `o${n}`, stationId: i.stationId, itemKey: i.itemKey,
  typeId: i.typeId, quantity: i.quantity, state, expiresAt: AT + 86400000, version: 1, iskTotal: i.iskTotal,
  issuerCorporationId: CORP });

module.exports = ({ test, skip }) => {
  test("TLO1 tiers-3b highsec station: ore offers for the main minerals 34 / 36, mineral offer only 35, filter 37-40, "
    + "portions, determinism", () => {
    assert.deepStrictEqual(ORES.map((b) => primaryOf(ORE_YIELDS[`type:${b}`].minerals, QUOTES)),
      ["type:36", "type:36", "type:34", "type:34"]);
    const r = plan(makeSnapshot(), makeParams());
    const sp = offersOf(r, "stockpile");
    assert.deepStrictEqual(sp.map((i) => [i.itemKind, i.itemKey, i.typeId]),
      [["ore", "type:1228", 1228], ["ore", "type:18", 18], ["mineral", "type:35", 35]], JSON.stringify(r.notes));
    for (const i of sp.slice(0, 2)) {
      assert.strictEqual(i.quantity % 100, 0, String(i.quantity));
      assert.ok(i.quantity > 0 && i.tier >= 1, JSON.stringify(i));
      assert.strictEqual(i.iskTotal, Math.floor((i.quantity * 10000) / 1000));
    }
    assert.strictEqual(sp[0].quantity, 3333300);
    assert.strictEqual(sp[2].quantity, BS["type:35"] * 8 - yieldOf(sp[0].quantity / 100, 1228, "type:35"));
    assert.deepStrictEqual(r.notes.filter((n) => n.startsWith("TRADE_LOCAL_")), ["TRADE_LOCAL_FILTERED:4"]);
    assert.deepStrictEqual(r.notes.filter((n) => n.startsWith("TRADE_ORE_OFFER")),
      ["TRADE_ORE_OFFER:type:1228@npc-1", "TRADE_ORE_OFFER:type:18@npc-1"]);
    assert.deepStrictEqual(r.notes.filter((n) => n.startsWith("TRADE_STOCKPILE_OFFER")),
      ["TRADE_STOCKPILE_OFFER:type:35@npc-1"]);
    assert.deepStrictEqual(plan(makeSnapshot(), makeParams()), r, "pure");

    for (const [need, b, k] of [[BS["type:34"] * 8, 1230, "type:34"], [BS["type:36"] * 8, 18, "type:36"], [1, 1230,
      "type:34"], [321, 1230, "type:34"], [320, 1230, "type:34"]]) {
      const y = ORE_YIELDS[`type:${b}`].minerals.find((p) => p[0] === k)[1];
      const n = portionsFor(need, y, EFF);
      assert.ok(yieldOf(n, b, k) >= need && yieldOf(n - 1, b, k) < need, `${need} ${b} ${n}`);
    }
    assert.strictEqual(portionsFor(0, 400, EFF), 0);
    assert.strictEqual(portionsFor(10, 0, EFF), 0);
    assert.deepStrictEqual(expectedYield(3, [["type:34", 150], ["type:35", 0]], EFF), [["type:34", 360]]);
  });

  test("TLO2 tiers-3b mobilization Megacyte despite the filter, pending, no local ore, localOre null", () => {
    const war = makeSnapshot({ stations: [station("npc-1", 30000001, { lines: 1 }), station("npc-2", 30000002)] });
    war.trade.localOre = { "npc-1": { ores: [oreRow(1230)], minerals: ["type:34"], pending: false }, "npc-2": HIGHSEC };
    const rw = plan(war, makeParams());
    assert.ok(offersOf(rw, "mobilization").some((i) => i.itemKey === "type:40" && i.itemKind === "mineral"),
      JSON.stringify(rw.intents.map((i) => [i.purpose, i.itemKey])));

    const pend = makeSnapshot({ stations: [station("npc-1", 30000001), station("npc-2", 30000002)] });
    pend.trade.localOre = { "npc-1": { ores: [], minerals: ["type:34"], pending: true },
      "npc-2": { ores: [], minerals: [], pending: false } };
    const rp = plan(pend, makeParams());
    assert.deepStrictEqual(offersOf(rp, "stockpile"), []);
    assert.deepStrictEqual(rp.notes.filter((n) => n.startsWith("TRADE_LOCAL_")),
      ["TRADE_LOCAL_PENDING:npc-1", "TRADE_LOCAL_NONE:npc-2"]);
    const missing = makeSnapshot({ stations: [station("npc-1", 30000001)], trade: { localOre: {} } });
    assert.ok(plan(missing, makeParams()).notes.includes("TRADE_LOCAL_PENDING:npc-1"));

    const off = plan(makeSnapshot({ trade: { localOre: null } }), makeParams());
    assert.deepStrictEqual(off, plan(makeSnapshot({ local: false }), makeParams()));
    assert.deepStrictEqual(off.notes.filter((n) => n.startsWith("TRADE_LOCAL_") || n.startsWith("TRADE_ORE")), []);
    assert.ok(offersOf(off).some((i) => i.itemKey === "type:37"), JSON.stringify(off.notes));
  });

  test("TLO3 tiers-3b open ore offers are incoming minerals: no second offer for 34; ACCEPTED Scordite lowers need_35",
    () => {
      const local = { ores: [oreRow(1230)], minerals: ["type:34", "type:35", "type:36"], pending: false };
      const snap = (open) => makeSnapshot({ trade: { open, localOre: { "npc-1": local } } });
      const first = plan(snap([]), makeParams());
      const veld = offersOf(first).find((i) => i.itemKey === "type:1230");
      assert.ok(veld && veld.itemKind === "ore", JSON.stringify(first.intents));
      const portions = portionsFor(BS["type:34"] * 8, 400, EFF);
      const covering = { ...veld, quantity: portions * 100 };
      const second = plan(snap([asOpen(covering, 1)]), makeParams());
      assert.deepStrictEqual(offersOf(second).filter((i) => i.itemKey === "type:34" || i.itemKey === "type:1230"), []);
      assert.ok(offersOf(second).some((i) => i.itemKey === "type:35"), JSON.stringify(second.notes));

      const scordite = { stationId: "npc-1", itemKey: "type:1228", typeId: 1228, quantity: 10050, iskTotal: 100500 };
      const without = offersOf(plan(snap([]), makeParams())).find((i) => i.itemKey === "type:35");
      const withAcc = offersOf(plan(snap([asOpen(scordite, 2, "ACCEPTED")]), makeParams()))
        .find((i) => i.itemKey === "type:35");
      assert.strictEqual(without.quantity - withAcc.quantity, Math.floor((100 * 110 * 800) / 1000));
      const odd = plan(snap([asOpen({ ...scordite, typeId: 34 }, 3, "ACCEPTED")]), makeParams());
      assert.strictEqual(offersOf(odd).find((i) => i.itemKey === "type:35").quantity, without.quantity);
    });

  test("TLO4 tiers-3b DoD 13 regression: both flags false + localOre / oreYields = the planner without them", () => {
    const flagsOff = { stockpileLocalOnly: false, oreOffersEnabled: false };
    for (const tiers of [true, false]) {
      const snaps = [
        [makeSnapshot(), makeSnapshot({ local: false })],
        [makeSnapshot({ stations: [station("npc-1", 30000001, { lines: 1 }), station("npc-2", 30000002)] }),
          makeSnapshot({ stations: [station("npc-1", 30000001, { lines: 1 }), station("npc-2", 30000002)],
            local: false })],
      ];
      for (const [withLocal, plain] of snaps) {
        const legacy = plan(plain, makeParams({}, { tiers }));
        assert.ok(offersOf(legacy).length >= 1);
        assert.deepStrictEqual(plan(withLocal, makeParams(flagsOff, { tiers })), legacy, `tiers ${tiers}`);
        assert.ok(offersOf(legacy).every((i) => i.itemKind === "mineral"));
      }
    }
  });

  test("TLO7: filter off + ore on keeps the minerals of a pending / no-ore station; unknown = no filter",
    () => {
      const two = () => makeSnapshot({ stations: [station("npc-1", 30000001), station("npc-2", 30000002)] });
      const legacy = plan(makeSnapshot({ stations: [station("npc-1", 30000001), station("npc-2", 30000002)],
        local: false }), makeParams({}));
      assert.ok(offersOf(legacy, "stockpile").length >= 1);
      const pend = two();
      pend.trade.localOre = { "npc-1": { ores: [], minerals: ["type:34"], pending: true },
        "npc-2": { ores: [], minerals: [], pending: false } };
      const r = plan(pend, makeParams({ stockpileLocalOnly: false, oreOffersEnabled: true }));
      assert.deepStrictEqual(r, legacy, JSON.stringify(r.notes));
      const missing = two();
      missing.trade.localOre = {};
      assert.deepStrictEqual(plan(missing, makeParams({ stockpileLocalOnly: false, oreOffersEnabled: true })), legacy);
      const unknown = two();
      unknown.trade.localOre = { "npc-1": { ores: [], minerals: [], pending: true, unknown: true },
        "npc-2": { ...HIGHSEC, unknown: true } };
      const ru = plan(unknown, makeParams());
      assert.deepStrictEqual(ru.notes.filter((n) => n.startsWith("TRADE_LOCAL_")), []);
      assert.deepStrictEqual(offersOf(ru, "stockpile").map((i) => [i.stationId, i.itemKey]),
        offersOf(legacy, "stockpile").map((i) => [i.stationId, i.itemKey]));
      assert.ok(offersOf(ru).every((i) => i.itemKind === "mineral"));
    });

  test("TLO8 default config = tiers-1 minerals; filter on + ore off: main minerals as mineral offers",
    () => {
    assert.deepStrictEqual([DEFAULTS.trade.stockpileLocalOnly, DEFAULTS.trade.oreOffersEnabled], [false, false]);
    const defaults = { stockpileLocalOnly: DEFAULTS.trade.stockpileLocalOnly,
      oreOffersEnabled: DEFAULTS.trade.oreOffersEnabled };
    const d = plan(makeSnapshot(), makeParams(defaults));
    assert.deepStrictEqual(d, plan(makeSnapshot({ local: false }), makeParams({})), "tiers-1 planner");
    assert.ok(offersOf(d).every((i) => i.itemKind === "mineral"));
    assert.ok(offersOf(d, "stockpile").some((i) => i.itemKey === "type:37"), "Isogen (no local mineral) is bought");
    assert.deepStrictEqual(d.notes.filter((n) => n.startsWith("TRADE_LOCAL_") || n.startsWith("TRADE_ORE")), []);

    const r = plan(makeSnapshot(), makeParams({ stockpileLocalOnly: true,
      oreOffersEnabled: DEFAULTS.trade.oreOffersEnabled }));
    assert.deepStrictEqual(r.intents.filter((i) => i.itemKind === "ore"), []);
    assert.deepStrictEqual(r.notes.filter((n) => n.startsWith("TRADE_ORE_OFFER")), []);
    const sp = offersOf(r, "stockpile");
    assert.deepStrictEqual(sp.map((i) => [i.itemKind, i.itemKey]).sort(),
      [["mineral", "type:34"], ["mineral", "type:35"], ["mineral", "type:36"]], JSON.stringify(r.notes));
    assert.strictEqual(sp.find((i) => i.itemKey === "type:35").quantity, BS["type:35"] * 8);
    assert.deepStrictEqual(r.notes.filter((n) => n.startsWith("TRADE_LOCAL_")), ["TRADE_LOCAL_FILTERED:4"]);
    });

  const driver = H.loadDriver();
  const needsDriver = (name, fn) => {
    if (driver.ok) test(name, fn);
    else skip(name, `better-sqlite3 unavailable (${driver.detail})`);
  };

  needsDriver("TLO5 tiers-3b readForReview localOre / oreYields (peek), takePendingLocal, localDrain, panel byKind / "
    + "byLocality / oreOffersOpen, config, params, notes, counters", () => H.withStore(driver, async (reopen) => {
    const opened = reopen();
    const shared = H.sharedOf();
    const journal = createJournal({ clock: shared.clock, maxPayloadBytes: 16384, maxRows: 500 });
    const tx = (fn) => { const r = opened.store.transaction("test", fn); assert.ok(r.ok, JSON.stringify(r)); return r.value; };
    const budgets = createBudgetRepository({ journal, clock: shared.clock });
    const offers = createOfferRepository({ journal, budgets, ids: shared.ids, clock: shared.clock, catalog: CATALOG });
    const peeks = [];
    let local = {
      localResourcesFor(ids, opts) {
        peeks.push(opts);
        const m = new Map();
        if (ids.includes(1)) {
          m.set(1, { pending: false, ores: [{ baseTypeId: 18, distance: 0 }, { baseTypeId: 19, distance: 0 },
            { baseTypeId: 1230, distance: 1 }] });
        }
        if (ids.includes(2)) m.set(2, { pending: true, ores: [] });
        return m;
      },
    };
    const counts = {};
    const telemetry = { count(name, n) { counts[name] = (counts[name] || 0) + n; } };
    const cfg = { ...DEFAULTS, trade: { ...DEFAULTS.trade, enabled: true },
      stations: { ...DEFAULTS.stations, maxDeltasPerChange: 4 } };
    const service = createTradeService({ budgets, offers, config: cfg, clock: shared.clock, telemetry,
      logger: { log() {} }, catalog: CATALOG, oreTypes: ORE_TYPES, getLocalResources: () => local });
    const st = (id, systemId) => ({ stationId: id, systemId, kind: "npc", ownerCorporationId: CORP });
    const read = tx((db) => service.readForReview(db, F, { stations: [st("npc-1", 1), st("npc-2", 2), st("npc-3", 3)],
      at: AT, limit: 32 }));
    assert.ok(read.ok, JSON.stringify(read));
    assert.deepStrictEqual(peeks, [{ read: false }], "one peek, never a vendor read");
    assert.deepStrictEqual(read.trade.localOre, {
      "npc-1": { ores: [{ baseTypeId: 18, itemKey: "type:18", distance: 0 },
        { baseTypeId: 1230, itemKey: "type:1230", distance: 1 }],
      minerals: ["type:34", "type:36", "type:37", "type:38", "type:39", "type:40"], pending: false },
      "npc-2": { ores: [], minerals: [], pending: true },
      "npc-3": { ores: [], minerals: [], pending: true },
    }, "Spodumain (5 minerals > 4) is no offer, its minerals stay local");
    assert.deepStrictEqual(read.trade.oreYields["type:1230"], { portionSize: 100, minerals: [["type:34", 400]] });
    assert.strictEqual(Object.keys(read.trade.oreYields).length, CATALOG.summary.ores);
    assert.strictEqual(read.trade.oreRefineEfficiencyPermille, DEFAULTS.trade.oreRefineEfficiencyPermille);
    assert.deepStrictEqual(service.takePendingLocal(), [2, 3]);
    assert.deepStrictEqual(service.takePendingLocal(), [], "cleared");
    local = null;
    const noLocal = tx((db) => service.readForReview(db, F, { stations: [st("npc-1", 1)], at: AT, limit: 32 }));
    assert.strictEqual(noLocal.trade.localOre, null);
    service.count("oreOffers", 2);
    service.count("localFiltered", 3);
    assert.deepStrictEqual([counts["trade.oreOffers"], counts["trade.localFiltered"]], [2, 3]);
    assert.deepStrictEqual([service.getStatus().counters.oreOffers, service.getStatus().counters.localFiltered], [2, 3]);

    const vendorReads = [];
    const timers = [];
    const adapter = { ...createFakeTradeAdapter(),
      readItemTypeFacts: (ids) => readItemTypeFactsFrom(REGISTRY, ids),
      readLocalResources: (ids) => {
        vendorReads.push([...ids]);
        const systems = new Map(ids.map((id) => [id, { systemId: id, beltCount: 1, poolSource: "ENRICHED",
          ores: [{ typeId: id === 30000001 ? 1230 : 1228, name: null }], ice: { typeIds: [], names: [] },
          anomaly: null }]));
        return { ok: true, systems, drift: [], issues: [] };
      } };
    const gateGraph = { getNeighbors: (id) => (id === 30000001 ? [30000002] : id === 30000002 ? [30000001] : []) };
    const records = [{ stationId: "npc-1", name: "Station One", systemId: 30000001, ownerFactionId: F }];
    const stations = { getMode: () => "ready",
      repository: { listStationsOfFaction: (db, factionId) => ({ ok: true,
        records: records.filter((s) => s.ownerFactionId === factionId) }) } };
    const views = createViewRegistry();
    const started = startTrade({ config: { ...DEFAULTS, trade: { ...DEFAULTS.trade, enabled: true,
      oreOffersEnabled: true } },
      persistence: { ok: true, store: opened.store, journal }, clock: shared.clock, ids: shared.ids, views, adapter,
      logger: { log() {} }, getStations: () => stations,
      getGraph: () => ({ getGraph: () => ({ ok: true, graph: gateGraph }) }),
      setTimer: (fn) => { const t = { fn, cancelled: false, cancel() { t.cancelled = true; } }; timers.push(t); return t; } });
    assert.ok(started.ok, JSON.stringify(started));
    const tr = started.trade;
    assert.strictEqual(typeof tr.takePendingLocal, "undefined", "not on the facade");
    await Promise.resolve();
    const review = () => tx((db) => tr.readForReview(db, F, { stations: [st("npc-1", 30000001)], at: AT, limit: 32 }));
    assert.strictEqual(review().trade.localOre["npc-1"].pending, true);
    assert.deepStrictEqual(vendorReads, [], "the review never reads the vendor");
    const pass = async () => {
      const t = timers.filter((x) => !x.cancelled).pop();
      assert.ok(t, "executor armed");
      t.cancelled = true;
      await t.fn();
    };
    await pass();
    assert.deepStrictEqual(vendorReads, [[30000001, 30000002]], "localDrain: one read (system + radius) in the pass");
    assert.deepStrictEqual(review().trade.localOre["npc-1"],
      { ores: [{ baseTypeId: 1230, itemKey: "type:1230", distance: 0 },
        { baseTypeId: 1228, itemKey: "type:1228", distance: 1 }], minerals: ["type:34", "type:35"], pending: false });
    await pass();
    assert.strictEqual(vendorReads.length, 1, "nothing pending -> no read");

    const fund = tx((db) => tr.fundFromUpkeepInTx(db, { factionId: F, units: 20000, paidUntilTo: AT }, `tlo5:fund`));
    assert.ok(fund.ok, JSON.stringify(fund));
    const make = (itemKind, typeId, i) => {
      const r = tx((db) => tr.planOfferInTx(db, { factionId: F, stationId: "npc-1", systemId: 30000001,
        issuerCorporationId: CORP, itemKind, itemKey: `type:${typeId}`, typeId, quantity: 1000, unitPriceMilli: 1000,
        iskTotal: 1000, refPriceMilli: 1000, capPriceMilli: 2000, priceSource: "bid", expiresAt: AT + 86400000,
        at: AT }, `strategy:review:${F}:1:${i}:TRADE_OFFER`));
      assert.ok(r.ok && !r.duplicate, JSON.stringify(r));
    };
    make("mineral", 34, 0);
    make("ore", 1230, 1);
    make("ore", 1228, 2);
    make("ore", 20, 3);
    const data = views.getView("trade").getData();
    assert.deepStrictEqual(data.contracts.byKind, { mineral: 1, ore: 3, hull: 0, commodity: 0 });
    assert.deepStrictEqual(data.contracts.byLocality, { local: 1, near: 1, unknown: 1 });
    assert.deepStrictEqual(data.local.stations.map((s) => [s.stationId, s.oreOffersOpen]), [["npc-1", 3]]);
    tr.stop();

    const row = config.SCHEMA.find((r) => r.key === "trade.stockpileLocalOnly");
    assert.deepStrictEqual([row.type, row.default], ["boolean", false]);
    assert.ok(fs.readFileSync(path.join(MOD_DIR, ".env.example"), "utf8")
      .includes("# EVEJS_LNE_TRADE_STOCKPILE_LOCAL_ONLY="));
    const env = { EVEJS_LNE_TRADE_ENABLED: "true", EVEJS_LNE_TRADE_STOCKPILE_LOCAL_ONLY: "true",
      EVEJS_LNE_TRADE_ORE_OFFERS_ENABLED: "true" };
    const rs = createReviewService({ store: {}, journal: {}, strategyRepository: { limits: { maxResourceUnits: 1 } },
      intelRepository: {}, registry: {}, kinds: { list: [], get: () => null }, powerTable: {}, scoring: {},
      scheduler: {}, fleets: {}, clock: { now: () => 0 }, worldSeed: 1,
      config: config.resolveConfig({ modDir: MOD_DIR, env }).config, hostility: () => true,
      isCampaignOk: () => true, industryCatalog: {} });
    assert.deepStrictEqual([rs.params.trade.stockpileLocalOnly, rs.params.trade.oreOffersEnabled], [true, true]);
    for (const code of ["TRADE_LOCAL_PENDING", "TRADE_LOCAL_NONE", "TRADE_LOCAL_FILTERED", "TRADE_ORE_OFFER"]) {
      assert.ok(NOTE_DICTIONARY[code], code);
    }
  }));

  needsDriver("TLO6 tiers-3b intake: STOCK_DELTAS_LIMIT before void; ORE_NOT_IN_CATALOG once ERROR, then WAIT",
    () => H.withStore(driver, async (reopen) => {
      const opened = reopen();
      const shared = H.sharedOf();
      const clock = shared.clock;
      const at = clock.now();
      const journal = createJournal({ clock, maxPayloadBytes: 16384, maxRows: 500 });
      const budgets = createBudgetRepository({ journal, clock });
      const offers = createOfferRepository({ journal, budgets, ids: shared.ids, clock, catalog: CATALOG });
      const adapter = createFakeTradeAdapter();
      let voids = 0;
      const realVoid = adapter.tradeVoidStack;
      adapter.tradeVoidStack = (spec) => { voids += 1; return realVoid(spec); };
      const logs = [];
      const counts = {};
      const telemetry = { count(name, n) { counts[name] = (counts[name] || 0) + n; } };
      const tx = (fn) => { const r = opened.store.transaction("test", fn); assert.ok(r.ok, JSON.stringify(r)); return r.value; };
      const GRACE = 600000;
      const deps = (extra = {}) => ({ store: opened.store, journal, offers, adapter, clock, telemetry, catalog: CATALOG,
        logger: { log(m) { logs.push(String(m)); } },
        config: { ...DEFAULTS, trade: { ...DEFAULTS.trade, enabled: true, intakeGraceMs: GRACE },
          stations: { ...DEFAULTS.stations, maxDeltasPerChange: 1 } }, ...extra });
      const offerOf = (id) => tx((db) => offers.getOffer(db, id)).offer;
      const station = (npc) => ({ stationId: npc, kind: "npc", ownerCorporationId: CORP, systemId: 30000001,
        destroyed: false });
      const fund = tx((db) => budgets.fundInTx(db, { factionId: F, units: 100000, paidUntilTo: at, iskPerUnit: 1000,
        capIsk: 1000000000, at }, `fund:${at}`));
      assert.ok(fund.ok, JSON.stringify(fund));
      let contract = 0;
      const accepted = (stationId, npc) => {
        tx((db) => db.prepare(`INSERT INTO world_stations (station_id, kind, npc_station_id, type_id, structure_family,
          system_id, owner_faction_id, owner_corporation_id, state, state_until_at, name, position_json, origin,
          evejs_item_id, destroyed_at, created_at, updated_at, version) VALUES (?, 'npc', ?, 35834, 'Sansha', 30000001,
          ?, ?, 'ONLINE', NULL, 'Test Station', '{"x":0,"y":0,"z":0}', 'seed', NULL, NULL, ?, ?, 1)`)
          .run(stationId, npc, F, CORP, at, at));
        const r = tx((db) => offers.createOfferInTx(db, { factionId: F, stationId, systemId: 30000001,
          issuerCorporationId: CORP, itemKind: "ore", itemKey: "type:1228", typeId: 1228, quantity: 200,
          unitPriceMilli: 5000, iskTotal: 1000, refPriceMilli: 5000, capPriceMilli: 6000, priceSource: "bid",
          expiresAt: at + 259200000, at }, `ik:${stationId}:offer`));
        assert.ok(r.ok && !r.duplicate, JSON.stringify(r));
        const id = r.offer.offerId;
        const step = (v, from, to, dt, patch) => {
          const t = tx((db) => offers.transitionOfferInTx(db, { offerId: id, expectedVersion: v, from, to, reason: "",
            at: at + dt, patch }, S.transitionKey(id, v, to)));
          assert.ok(t.ok, JSON.stringify(t));
        };
        step(1, S.PLANNED, S.ISSUING, 0, { expiresAt: at + 259200000 });
        contract += 1;
        step(2, S.ISSUING, S.OPEN, 1000, { contractId: 810000 + contract });
        step(3, S.OPEN, S.ACCEPTED, 2000, { acceptorCharacterId: 999 });
        return id;
      };

      const id = accepted("st-f", 61000006);
      adapter._addHangarStack(CORP, 61000006, 7101, 1228, 200);
      clock.advance(2000 + GRACE + 1);
      assert.strictEqual((await stepAccepted(deps(), offerOf(id), station(61000006))).action, "PLAN");
      const before = voids;
      assert.deepStrictEqual(await stepIntake(deps(), offerOf(id)), { action: "LOST", reason: "STOCK_REFUSED" });
      assert.strictEqual(voids, before, "no void before the LOST");
      assert.ok(logs.some((m) => m.includes("before void (STOCK_DELTAS_LIMIT)")), logs.join("\n"));
      assert.strictEqual(tx((db) => db.prepare("SELECT COUNT(*) AS n FROM world_station_stock WHERE station_id = ?")
        .get("st-f")).n, 0);

      const id2 = accepted("st-g", 61000007);
      const minerals = buildTradeCatalog({});
      const seen = new Set();
      const err0 = counts["trade.seamError"] || 0;
      const r1 = await stepAccepted(deps({ catalog: minerals, oreMissSeen: seen }), offerOf(id2), station(61000007));
      assert.deepStrictEqual(r1, { action: "ERROR", reason: "ORE_NOT_IN_CATALOG" });
      assert.strictEqual(counts["trade.seamError"], err0 + 1);
      const logsBefore = logs.length;
      const r2 = await stepAccepted(deps({ catalog: minerals, oreMissSeen: seen }), offerOf(id2), station(61000007));
      assert.deepStrictEqual(r2, { action: "WAIT", reason: "ORE_NOT_IN_CATALOG" });
      assert.strictEqual(counts["trade.seamError"], err0 + 1, "no metric on the repeat");
      assert.strictEqual(logs.length, logsBefore, "no log on the repeat");
      assert.strictEqual(offerOf(id2).state, S.ACCEPTED);
      for (let i = 0; i < 2; i += 1) {
        const r = await stepAccepted(deps({ catalog: minerals }), offerOf(id2), station(61000007));
        assert.strictEqual(r.action, "ERROR");
      }
      assert.strictEqual(counts["trade.seamError"], err0 + 3);
    }));
};
