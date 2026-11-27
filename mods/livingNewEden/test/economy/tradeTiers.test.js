"use strict";

const assert = require("node:assert");
const path = require("node:path");

const config = require("../../config");
const { createJournal } = require("../../lib/persistence/journal");
const { createViewRegistry } = require("../../lib/observer/views");
const { planTrade } = require("../../lib/strategy/ai/trade");
const { createReviewService } = require("../../lib/strategy/reviewService");
const { contractTtlOf, buildIssuePayload } = require("../../lib/economy/trade/executorRules");
const { tierCfgOf, tierOf } = require("../../lib/strategy/data/tradeTiers");
const { harness: H } = require("../battle/settlement.test");
const { createFakeTradeAdapter } = require("../_support/fakeTradeAdapter");
const { GROUPS: HULL_RECIPES } = require("../../lib/economy/data/hullRecipes");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const DEFAULTS = config.resolveConfig({ modDir: MOD_DIR, env: {} }).config;
const TC = tierCfgOf(DEFAULTS.trade);
const F = 500019;
const AT = 1000000;
const DAY = 86400000;
const MINERALS = [34, 35, 36, 37, 38, 39, 40];
const UNIT_MILLI = 18500;
let idCounter = 0;
const IDS = { next: (p) => `${p}_tt${++idCounter}` };

const RECIPES = {};
for (const [group, data] of Object.entries(HULL_RECIPES)) RECIPES[group] = { minerals: { ...data.minerals } };
const BS = RECIPES.battleship.minerals;

const quoteOf = (unitMilli) => ({ ok: true, unitMilli, refMilli: unitMilli, capMilli: unitMilli * 2, source: "bid",
  capped: false });
const quotesOf = (over = {}) => Object.fromEntries(MINERALS.map((t) => [`type:${t}`, quoteOf(over[t] || UNIT_MILLI)]));
const VOLUMES = Object.fromEntries(MINERALS.map((t) => [`type:${t}`, 1]));

function station(stationId, systemId, extra = {}) {
  return { stationId, systemId, kind: "npc", ownerCorporationId: 1000001, lines: 0, activeJobs: [],
    minerals: {}, hulls: {}, ...extra };
}

function makeSnapshot({ stations, trade = {}, treasury } = {}) {
  const st = stations || [station("npc-1", 30000001), station("npc-2", 30000002)];
  const snap = {
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
    trade: {
      mode: "ready", galaxy: { open: 0, factions: 13 },
      budget: { availableIsk: 10000000000, reservedIsk: 0 },
      open: [], openTruncated: false,
      stations: st.map((s) => ({ stationId: s.stationId, systemId: s.systemId, ownerCorporationId: s.ownerCorporationId,
        kind: s.kind })),
      quotes: quotesOf(), privateQuotes: {}, suppliers: [], volumes: VOLUMES,
      ...trade,
    },
  };
  if (treasury) snap.treasury = treasury;
  return snap;
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

function makeParams(trade = {}, { tiers = true, mobilizationStations = 1 } = {}) {
  return {
    trade: { ...BASE_TRADE, ...(tiers ? TIERS : {}), ...trade },
    production: { maxJobsPerReview: 2, maxRunsPerJob: 4, maxActiveJobsPerFaction: 8, targetStockFleets: 1,
      mobilizeHulls: "required", miningNeedsHulls: false, logisticsNeedsHulls: false, mobilizationStations,
      hullGroups: Object.keys(HULL_RECIPES) },
    maxAssemblyJumps: 15, maxBfsSystems: 2000,
  };
}

const plan = (snap, params) => planTrade(snap, params, { intents: [] }, { intents: [] });
const offersOf = (r, purpose) => r.intents.filter((i) => i.type === "TRADE_OFFER" && (!purpose || i.purpose === purpose));
const clsOf = (list) => list.map((i) => tierOf(i.iskTotal, TC));
const ttlOfCls = (c) => (c === 1 ? 3 * DAY : c === 2 ? 7 * DAY : 14 * DAY);
const asOpen = (i, n) => ({ offerId: `o${n}`, stationId: i.stationId, itemKey: i.itemKey, typeId: i.typeId,
  quantity: i.quantity, state: "PLANNED", expiresAt: i.expiresAt, version: 1, iskTotal: i.iskTotal,
  issuerCorporationId: i.issuerCorporationId });

module.exports = ({ test, skip }) => {
  test("TT1 tiers: quotas [9,5,2] of factionCap 16 -> tier 3 x2, then tier 2 (100 mln), then tier 1; TTL per "
    + "tier; determinism; second round with the offers open -> no new tier 3 / 2", () => {
    assert.deepStrictEqual([TC.tier1Isk, TC.tier2Isk, TC.tier3Isk], [1e7, 1e8, 1e9]);
    const r = plan(makeSnapshot(), makeParams());
    assert.ok(r.notes.includes("TRADE_NO_MOBILIZATION_STATION"), JSON.stringify(r.notes));
    const sp = offersOf(r, "stockpile");
    assert.strictEqual(sp.length, 8, JSON.stringify(r));
    assert.deepStrictEqual(clsOf(sp), [3, 3, 2, 2, 2, 2, 2, 1], JSON.stringify(sp.map((i) => i.iskTotal)));
    assert.deepStrictEqual(sp.map((i) => i.tier), [3, 3, 2, 2, 2, 2, 2, 1]);
    assert.deepStrictEqual(sp.slice(0, 2).map((i) => [i.stationId, i.itemKey, i.quantity, i.iskTotal]),
      [["npc-1", "type:34", 50000000, 925000000], ["npc-2", "type:34", 50000000, 925000000]]);
    assert.strictEqual(sp[2].itemKey, "type:35");
    assert.ok(sp[2].iskTotal <= 1e8 && sp[2].iskTotal > 1e8 - 19, String(sp[2].iskTotal));
    const mex = sp.find((i) => i.stationId === "npc-1" && i.itemKey === "type:36");
    assert.strictEqual(mex.quantity, BS["type:36"] * 8);
    assert.ok(sp[7].iskTotal <= 1e7 && sp[7].iskTotal >= TIERS.tierMinOfferIsk, String(sp[7].iskTotal));
    for (const i of sp) assert.strictEqual(i.expiresAt, AT + ttlOfCls(tierOf(i.iskTotal, TC)));
    assert.deepStrictEqual(plan(makeSnapshot(), makeParams()), r, "pure");

    const stations = [station("npc-1", 30000001), station("npc-2", 30000002), station("npc-3", 30000003)];
    const r2 = plan(makeSnapshot({ stations, trade: { open: sp.map(asOpen), galaxy: { open: 8, factions: 13 } } }),
      makeParams());
    const sp2 = offersOf(r2, "stockpile");
    assert.ok(sp2.length >= 1, JSON.stringify(r2));
    assert.deepStrictEqual([...new Set(clsOf(sp2))], [1], JSON.stringify(sp2.map((i) => i.iskTotal)));
    assert.ok(sp2.some((i) => i.stationId === "npc-3" && i.itemKey === "type:34"));
  });

  test("TT2 gate 20% of held, AUSTERITY, mobilization station tier 1, mobilization deficit in the quotas "
    + "volume cap", () => {
    const low = plan(makeSnapshot({ trade: { budget: { availableIsk: 300000000, reservedIsk: 0 } } }), makeParams());
    const lowOffers = offersOf(low);
    assert.ok(lowOffers.length >= 1, JSON.stringify(low));
    for (const i of lowOffers) assert.ok(i.iskTotal <= 60000000, String(i.iskTotal));

    const aus = plan(makeSnapshot({ treasury: { mode: "ready", accountMode: "AUSTERITY" } }), makeParams());
    const ausOffers = offersOf(aus);
    assert.ok(ausOffers.length >= 1);
    assert.ok(!clsOf(ausOffers).includes(3), JSON.stringify(ausOffers.map((i) => i.iskTotal)));
    assert.deepStrictEqual(aus.notes.filter((n) => n === "TRADE_TIER_AUSTERITY"), ["TRADE_TIER_AUSTERITY"]);
    assert.ok(clsOf(offersOf(plan(makeSnapshot({ treasury: { mode: "ready", accountMode: "NORMAL" } }), makeParams())))
      .includes(3));

    const oneRun = Object.fromEntries(MINERALS.map((t) => [`type:${t}`, BS[`type:${t}`]]));
    const mob = plan(makeSnapshot({ stations: [station("npc-1", 30000001, { lines: 1, minerals: oneRun }),
      station("npc-2", 30000002)] }), makeParams());
    assert.deepStrictEqual(offersOf(mob, "mobilization"), []);
    const atMob = offersOf(mob, "stockpile").filter((i) => i.stationId === "npc-1");
    assert.ok(atMob.length >= 1, JSON.stringify(mob));
    assert.deepStrictEqual([...new Set(clsOf(atMob))], [1]);
    assert.ok(clsOf(offersOf(mob, "stockpile").filter((i) => i.stationId === "npc-2")).includes(3));

    const open = [{ offerId: "o-open", stationId: "npc-9", itemKey: "type:34", typeId: 34, quantity: 1, state: "OPEN",
      version: 1, expiresAt: AT + DAY, iskTotal: 500000000, issuerCorporationId: 1000001 }];
    const war = plan(makeSnapshot({ stations: [station("npc-1", 30000001, { lines: 1 }), station("npc-2", 30000002)],
      trade: { open, quotes: quotesOf({ 34: 200000 }) } }), makeParams());
    const m34 = offersOf(war, "mobilization").find((i) => i.itemKey === "type:34");
    assert.ok(m34, JSON.stringify(war));
    assert.deepStrictEqual([m34.iskTotal, m34.tier, m34.expiresAt], [1000000000, 3, AT + 14 * DAY]);
    const sp = offersOf(war, "stockpile");
    assert.strictEqual(sp.length, 1, JSON.stringify(war));
    assert.deepStrictEqual([sp[0].stationId, sp[0].itemKey, sp[0].iskTotal, sp[0].tier], ["npc-2", "type:34", 1e8, 2]);

    for (const r of [low, aus, mob, war]) for (const i of offersOf(r)) assert.ok(i.quantity <= 50000000, String(i.quantity));
  });

  test("TT3 executor TTL per tier: contractTtlOf 3 / 7 / 14 days, private = min, payload of tier 1 = without "
    + "tiers", () => {
    const C = DEFAULTS.trade.contractTtlMs;
    const P = DEFAULTS.trade.privateOfferTtlMs;
    assert.deepStrictEqual([5e6, 5e7, 5e8].map((iskTotal) => contractTtlOf({ iskTotal }, C, P, TC)),
      [3 * DAY, 7 * DAY, 14 * DAY]);
    assert.strictEqual(contractTtlOf({ iskTotal: 5e8, assigneeCharacterId: 90000001 }, C, DAY, TC), DAY);
    assert.strictEqual(contractTtlOf({ iskTotal: 5e6, assigneeCharacterId: 90000001 }, C, 30 * DAY, TC), 3 * DAY);
    const offer = (iskTotal) => ({ offerId: "tro_1", factionId: F, stationId: "60000001", issuerCorporationId: 1000001,
      typeId: 34, quantity: 1000, iskTotal, rewardIsk: iskTotal });
    const st = { stationId: 60000001, systemId: 30000001 };
    const cfg = { accountKey: DEFAULTS.trade.walletAccountKey, contractTtlMs: C, privateOfferTtlMs: P };
    const base = buildIssuePayload(offer(5e6), st, { ceoId: 3000001 }, { ...cfg, tiers: null }, "Sansha");
    assert.deepStrictEqual(buildIssuePayload(offer(5e6), st, { ceoId: 3000001 }, { ...cfg, tiers: TC }, "Sansha"), base);
    assert.deepStrictEqual(buildIssuePayload(offer(5e6), st, { ceoId: 3000001 }, cfg, "Sansha"), base);
    assert.strictEqual(buildIssuePayload(offer(5e8), st, { ceoId: 3000001 }, { ...cfg, tiers: TC }, "Sansha")
      .minutesExpire, 20160);
  });

  test("TT4 DoD 13 regression: tiersEnabled=false = the planner without the tier keys, contract TTL = contractTtlMs",
    () => {
      const snaps = [makeSnapshot(), makeSnapshot({ stations: [station("npc-1", 30000001, { lines: 1 }),
        station("npc-2", 30000002)], trade: { quotes: quotesOf({ 34: 200000 }) },
      treasury: { mode: "ready", accountMode: "AUSTERITY" } })];
      for (const snap of snaps) {
        const legacy = plan(snap, makeParams({}, { tiers: false }));
        assert.ok(offersOf(legacy).length >= 1);
        assert.deepStrictEqual(plan(snap, makeParams({ tiersEnabled: false })), legacy);
        assert.ok(offersOf(legacy).every((i) => i.tier === undefined && i.expiresAt === AT + BASE_TRADE.offerTtlMs));
        assert.ok(offersOf(legacy, "stockpile").every((i) => i.iskTotal <= BASE_TRADE.stockpileMaxIskPerOffer));
        assert.ok(offersOf(legacy).some((i) => i.quantity > 10000));
        const capped = plan(snap, makeParams({ tiersEnabled: false, maxOfferVolumeM3: 100 }));
        assert.ok(offersOf(capped).length >= 1);
        assert.ok(offersOf(capped).every((i) => i.quantity <= 10000 && i.tier === undefined), JSON.stringify(capped));
        assert.deepStrictEqual(offersOf(capped, "mobilization").length > 0, offersOf(legacy, "mobilization").length > 0);
      }
      assert.ok(offersOf(plan(snaps[1], makeParams({ tiersEnabled: false, maxOfferVolumeM3: 100 })), "mobilization")
        .some((i) => i.quantity === 10000), "mobilization capped by volume");
      const C = DEFAULTS.trade.contractTtlMs;
      assert.strictEqual(contractTtlOf({ iskTotal: 5e8 }, C, DAY, null), C);
      assert.strictEqual(contractTtlOf({ iskTotal: 5e8 }, C, DAY), C);
      assert.strictEqual(contractTtlOf({ iskTotal: 5e8, assigneeCharacterId: 7 }, C, DAY, null), DAY);
      assert.strictEqual(tierCfgOf({ ...DEFAULTS.trade, tiersEnabled: false }), null);
    });

  test("TT5 config + panel: defaults without tier warnings, params.trade with the 12 keys, contracts.tiers / byTier / "
    + "byFaction[].tiers", async () => {
    const { config: cfg0, warnings } = config.resolveConfig({ modDir: MOD_DIR, env: {} });
    assert.ok(!(warnings || []).some((x) => x.startsWith("trade.tier")), JSON.stringify(warnings));
    const t = cfg0.trade;
    assert.deepStrictEqual(TIER_KEYS.map((k) => t[k]), [true, 1e7, 1e8, 1e9, 350, 150, 3 * DAY, 7 * DAY, 14 * DAY,
      5e6, 200, 500000]);
    assert.deepStrictEqual([t.stockpileRuns, t.maxIskPerOffer, t.maxQuantityPerOffer], [8, 1e9, 1e8]);
    const bad = config.resolveConfig({ modDir: MOD_DIR, env: { EVEJS_LNE_TRADE_TIER1_ISK: "200000000" } });
    assert.ok((bad.warnings || []).some((x) => x.startsWith("trade.tier1Isk < trade.tier2Isk")));
    const env = { EVEJS_LNE_TRADE_TIER2_ISK: "200000000", EVEJS_LNE_TRADE_TIERS_ENABLED: "false" };
    const service = createReviewService({ store: {}, journal: {}, strategyRepository: { limits: { maxResourceUnits: 1 } },
      intelRepository: {}, registry: {}, kinds: { list: [], get: () => null }, powerTable: {}, scoring: {},
      scheduler: {}, fleets: {}, clock: { now: () => 0 }, worldSeed: 1,
      config: config.resolveConfig({ modDir: MOD_DIR, env }).config, hostility: () => true,
      isCampaignOk: () => true, industryCatalog: {} });
    const p = service.params.trade;
    assert.deepStrictEqual(TIER_KEYS.filter((k) => !Object.prototype.hasOwnProperty.call(p, k)), []);
    assert.deepStrictEqual([p.tiersEnabled, p.tier2Isk], [false, 200000000]);

    const driver = H.loadDriver();
    if (!driver.ok) return skip("better-sqlite3 unavailable");
    await H.withStore(driver, async (reopen) => {
      const opened = reopen();
      const shared = H.sharedOf();
      const views = createViewRegistry();
      const journal = createJournal({ clock: shared.clock, maxPayloadBytes: 16384, maxRows: 500 });
      const cfg = { ...DEFAULTS, trade: { ...DEFAULTS.trade, enabled: true, hullOffersEnabled: false },
        modules: { ...DEFAULTS.modules, strategy: { enabled: true } }, stations: { ...DEFAULTS.stations, enabled: true } };
      const started = require("../../lib/economy/trade").startTrade({
        config: cfg, persistence: { ok: true, store: opened.store, journal }, clock: shared.clock, views, ids: IDS,
        adapter: createFakeTradeAdapter(), setTimer: () => ({ cancel() {}, hasRef: () => false }),
      });
      assert.ok(started.ok, JSON.stringify(started));
      const tr = started.trade;
      const tx = (fn) => {
        const r = opened.store.transaction("test", fn);
        assert.ok(r.ok, JSON.stringify(r));
        return r.value;
      };
      const funded = tx((db) => tr.fundFromUpkeepInTx(db, { factionId: F, units: 20000, paidUntilTo: AT }, `fund:${F}`));
      assert.ok(funded.ok, JSON.stringify(funded));
      const read = tx((db) => tr.readForReview(db, F, { stations: [{ stationId: "npc-1", systemId: 30000001,
        kind: "npc", ownerCorporationId: 1000001 }], at: AT, limit: 32 }));
      assert.deepStrictEqual(read.trade.volumes, VOLUMES);
      const isk = [5e6, 5e7, 5e8];
      isk.forEach((iskTotal, i) => {
        const typeId = 34 + i;
        const made = tx((db) => tr.planOfferInTx(db, { factionId: F, stationId: "npc-1", systemId: 30000001,
          issuerCorporationId: 1000001, itemKind: "mineral", itemKey: `type:${typeId}`, typeId, quantity: iskTotal / 10,
          unitPriceMilli: 10000, iskTotal, refPriceMilli: 10000, capPriceMilli: 20000, priceSource: "bid",
          expiresAt: AT + DAY, at: AT }, `strategy:review:${F}:1:${i}:TRADE_OFFER`));
        assert.ok(made.ok && !made.duplicate, JSON.stringify(made));
      });
      const c = views.getView("trade").getData().contracts;
      assert.deepStrictEqual(c.tiers, TC);
      assert.deepStrictEqual(c.byTier, [{ tier: 1, open: 1, isk: 5e6 }, { tier: 2, open: 1, isk: 5e7 },
        { tier: 3, open: 1, isk: 5e8 }]);
      assert.deepStrictEqual(c.byFaction.map((x) => x.tiers), [[1, 1, 1]]);
      tr.stop();
    });
  });
};
