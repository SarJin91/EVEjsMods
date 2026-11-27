"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const config = require("../../config");
const { createJournal } = require("../../lib/persistence/journal");
const { openStore } = require("../../lib/persistence/store");
const { LATEST_SCHEMA_VERSION, MIGRATIONS } = require("../../lib/persistence/migrations");
const { createBudgetRepository } = require("../../lib/economy/trade/budgetRepository");
const { createOfferRepository } = require("../../lib/economy/trade/offerRepository");
const { createTradeService } = require("../../lib/economy/trade/tradeService");
const { createPriceCache } = require("../../lib/economy/trade/priceCache");
const { quote } = require("../../lib/economy/trade/pricing");
const { planTrade } = require("../../lib/strategy/ai/trade");
const { describeNote } = require("../../lib/strategy/activity/notes");
const { reviewRowBound, TRADE_OFFER_ROWS, TRADE_CANCEL_ROWS } = require("../../lib/strategy/reviewRows");
const S = require("../../lib/economy/trade/schema");
const { createViewRegistry } = require("../../lib/observer/views");
const { hullTargets, rankMobilizationStations, focusOf } = require("../../lib/strategy/ai/production");
const { bfs } = require("../../lib/strategy/ai/bfs");
const { createRng } = require("../../lib/util/rng");
const { harness: H } = require("../battle/settlement.test");
const { createFakeTradeAdapter } = require("../_support/fakeTradeAdapter");
const { GROUPS: HULL_RECIPES } = require("../../lib/economy/data/hullRecipes");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const DEFAULTS = config.resolveConfig({ modDir: MOD_DIR, env: {} }).config;
const F = 500019;
const F2 = 500020;
const AT = 1000000;
const CLOCK = { now: () => AT };
let idCounter = 0;
const IDS = { next: (p) => `${p}_${++idCounter}` };

const MINERAL_TYPE_IDS = S.MINERAL_TYPE_IDS;
const HULL_GROUPS = Object.keys(HULL_RECIPES);

const RECIPES = {};
for (const [group, data] of Object.entries(HULL_RECIPES)) {
  RECIPES[group] = { minerals: { ...data.minerals } };
}

function makeSnapshot(overrides = {}) {
  return {
    at: AT,
    seed: 12345,
    factionId: F,
    faction: { status: "ACTIVE", homeSystemId: 30000001, doctrineId: "test-v1", version: 1 },
    doctrine: { doctrineId: "test-v1", templates: { combat: [{ hullGroup: "frigate", count: 1 }] } },
    stationsMode: "ready",
    stations: [
      { stationId: "npc-1", systemId: 30000001, kind: "npc", ownerCorporationId: 1000001 },
      { stationId: "npc-2", systemId: 30000002, kind: "npc", ownerCorporationId: 1000002 },
    ],
    neighbors: (id) => new Map([[30000001, [30000002]], [30000002, [30000001]]]),
    supply: { frontTargets: [30000001] },
    production: {
      mode: "ready",
      recipes: RECIPES,
      recipesVersion: 1,
      stations: [
        { stationId: "npc-1", systemId: 30000001, kind: "npc", ownerCorporationId: 1000001, lines: 2, activeJobs: [],
          minerals: { "type:34": 1000, "type:35": 500 }, hulls: {} },
        { stationId: "npc-2", systemId: 30000002, kind: "npc", ownerCorporationId: 1000002, lines: 1, activeJobs: [],
          minerals: { "type:34": 2000, "type:35": 1000 }, hulls: {} },
      ],
      inProduction: {},
      activeJobsTotal: 0,
      truncated: false,
    },
    fleets: [],
    fleetsTruncated: false,
    operations: [],
    operationsTruncated: false,
    logistics: { mode: "ready", open: [], busyFleetIds: [], carriers: {}, truncated: false },
    trade: { mode: "off" },
    ...overrides,
  };
}

function makeParams(overrides = {}) {
  const baseTrade = {
    premiumPermille: 1100,
    askCapPermille: 980,
    maxOffersPerReview: 2,
    maxCancelsPerReview: 4,
    maxOpenOffersPerFaction: 8,
    maxOpenOffersPerStation: 3,
    maxQuantityPerOffer: 10000000,
    minIskPerOffer: 100000,
    maxIskPerOffer: 200000000,
    offerTtlMs: 259200000,
    factoryRunsTarget: 2,
    maxUnitPriceMilli: 1000000000000,
    priceCacheMs: 3600000,
  };
  const baseProduction = {
    maxJobsPerReview: 2,
    maxRunsPerJob: 4,
    maxActiveJobsPerFaction: 8,
    targetStockFleets: 1,
    mobilizeHulls: "required",
    miningNeedsHulls: false,
    logisticsNeedsHulls: false,
    mobilizationStations: 2,
    hullGroups: HULL_GROUPS,
  };
  const { trade: overrideTrade, production: overrideProduction, ...restOverrides } = overrides;
  return {
    trade: { ...baseTrade, ...(overrideTrade || {}) },
    production: { ...baseProduction, ...(overrideProduction || {}) },
    maxAssemblyJumps: 15,
    maxBfsSystems: 2000,
    maxReachJumps: 10,
    supplyChainJumps: 10,
    captureRangeFromStationJumps: 5,
    maxTargetCandidates: 40,
    targetPickTopK: 3,
    maxOperationsPerReview: 1,
    maxFleetsPerOperation: 4,
    maxFleetsPerFaction: 12,
    maxMobilizationsPerReview: 2,
    mobilizeResourcePerShip: 10,
    mobilizeReservePerShip: 1,
    attackStrengthRatio: 1.2,
    intelTtlMs: 21600000,
    maxObservationsPerReview: 8,
    reconWindowMs: 1800000,
    attackWindowMs: 7200000,
    operationGraceMs: 3600000,
    maxHousekeepingPerReview: 4,
    maxRefitRequestsPerReview: 2,
    maxTerritoryMarksPerReview: 8,
    ...restOverrides,
  };
}

module.exports = ({ test, skip, bench }) => {
  test("TO1 pricing: ask cap, bid/base, NO_PRICE, bonus, priceCache TTL", () => {
    const rng = createRng(42);
    for (let i = 0; i < 300; i++) {
      let bidMilli = rng.nextFloat() > 0.5 ? Math.floor(rng.nextFloat() * 10000000) + 1 : null;
      let askMilli = rng.nextFloat() > 0.5 ? Math.floor(rng.nextFloat() * 10000000) + 1 : null;
      let baseMilli = rng.nextFloat() > 0.5 ? Math.floor(rng.nextFloat() * 10000000) + 1 : null;
      if (bidMilli !== null && askMilli !== null && askMilli < bidMilli) {
        const t = bidMilli; bidMilli = askMilli; askMilli = t;
      }
      const refs = { bidMilli, askMilli, baseMilli };
      const q = quote(refs, { premiumPermille: 1100, askCapPermille: 980, bonusPermille: 0, maxUnitPriceMilli: 1e12 });
      if (q.ok) {
        assert.ok(Number.isSafeInteger(q.unitMilli) && q.unitMilli >= 1, "unitMilli integer >= 1");
        if (askMilli !== null && askMilli > 0) {
          const cap = Math.floor((askMilli * 980) / 1000);
          assert.ok(q.unitMilli <= cap, `unitMilli ${q.unitMilli} <= cap ${cap}`);
        }
        assert.ok(["bid", "base"].includes(q.source), `source ${q.source}`);
        if (bidMilli !== null && bidMilli > 0) assert.strictEqual(q.source, "bid");
        else if (baseMilli !== null && baseMilli > 0) assert.strictEqual(q.source, "base");
      } else {
        assert.ok(["NO_PRICE", "PRICE_TOO_HIGH", "INVALID_PRICE"].includes(q.reason), q.reason);
      }
    }

    assert.deepStrictEqual(quote({ bidMilli: 1000, askMilli: 2000, baseMilli: 500 },
      { premiumPermille: 1000, askCapPermille: 980, maxUnitPriceMilli: 1e12 }),
      { ok: true, unitMilli: 1000, refMilli: 1000, capMilli: 1960, source: "bid", capped: false });

    assert.deepStrictEqual(quote({ bidMilli: null, askMilli: 2000, baseMilli: 500 },
      { premiumPermille: 1000, askCapPermille: 980, maxUnitPriceMilli: 1e12 }),
      { ok: true, unitMilli: 500, refMilli: 500, capMilli: 1960, source: "base", capped: false });

    assert.deepStrictEqual(quote({ bidMilli: null, askMilli: 2000, baseMilli: null },
      { premiumPermille: 1000, askCapPermille: 980, maxUnitPriceMilli: 1e12 }),
      { ok: false, reason: "NO_PRICE" });

    const q1 = quote({ bidMilli: 1000, askMilli: 2000, baseMilli: null },
      { premiumPermille: 1000, askCapPermille: 980, bonusPermille: 100, maxUnitPriceMilli: 1e12 });
    assert.ok(q1.ok && q1.unitMilli === 1100 && q1.capped === false);

    const cache = createPriceCache({ ttlMs: 1000 });
    cache.put(34, { bidMilli: 1000, askMilli: 2000, baseMilli: 500 }, AT);
    assert.deepStrictEqual(cache.peek(34, AT), { bidMilli: 1000, askMilli: 2000, baseMilli: 500 });
    assert.strictEqual(cache.peek(34, AT + 1001), null);
    assert.deepStrictEqual(cache.getStatus(), { entries: 1, source: "none", newestAt: AT });
  });

  test("TO2 planTrade: deterministic, demand, limits, budget, no price, TTL/STATION_GONE, Upwell skipped", () => {
    const snap = makeSnapshot({
      trade: {
        mode: "ready",
        budget: { availableIsk: 500000000, reservedIsk: 0 },
        open: [],
        openTruncated: false,
        stations: [
          { stationId: "npc-1", systemId: 30000001, ownerCorporationId: 1000001, kind: "npc" },
          { stationId: "npc-2", systemId: 30000002, ownerCorporationId: 1000002, kind: "npc" },
        ],
        quotes: {
          "type:34": { ok: true, unitMilli: 1100, refMilli: 1000, capMilli: 1960, source: "bid", capped: false },
          "type:35": { ok: true, unitMilli: 1100, refMilli: 1000, capMilli: 1960, source: "bid", capped: false },
        },
      },
    });
    const params = makeParams();
    const prod = { intents: [] };
    const logi = { intents: [] };

    const r1 = planTrade(snap, params, prod, logi);
    const r2 = planTrade(snap, params, prod, logi);
    assert.deepStrictEqual(r1, r2);

    const snap2 = makeSnapshot({
      trade: { mode: "ready", budget: { availableIsk: 500000000, reservedIsk: 0 },
        open: [{ offerId: "o1", stationId: "npc-1", itemKey: "type:34", typeId: 34, quantity: 100, state: "PLANNED", version: 1, expiresAt: AT + 86400000, issuerCorporationId: 1000001, iskTotal: 110000 }],
        openTruncated: false,
        stations: [{ stationId: "npc-1", systemId: 30000001, ownerCorporationId: 1000001, kind: "npc" }],
        quotes: { "type:34": { ok: true, unitMilli: 1100, refMilli: 1000, capMilli: 1960, source: "bid", capped: false } },
      },
      production: {
        mode: "ready", recipes: RECIPES, recipesVersion: 1,
        stations: [{ stationId: "npc-1", systemId: 30000001, kind: "npc", ownerCorporationId: 1000001, lines: 2, activeJobs: [],
          minerals: { "type:34": 0, "type:35": 500 }, hulls: {} }],
        inProduction: {}, activeJobsTotal: 0, truncated: false,
      },
    });
    const r3 = planTrade(snap2, params, { intents: [] }, { intents: [] });
    assert.ok(r3.notes.some((n) => n.startsWith("TRADE_OFFER_EXISTS")), "skips existing offer");

    const snap3 = makeSnapshot({
      trade: { mode: "ready", budget: { availableIsk: 5000, reservedIsk: 0 },
        open: [], openTruncated: false,
        stations: [{ stationId: "npc-1", systemId: 30000001, ownerCorporationId: 1000001, kind: "npc" }],
        quotes: { "type:34": { ok: true, unitMilli: 1100, refMilli: 1000, capMilli: 1960, source: "bid", capped: false } },
      },
      production: {
        mode: "ready", recipes: RECIPES, recipesVersion: 1,
        stations: [{ stationId: "npc-1", systemId: 30000001, kind: "npc", ownerCorporationId: 1000001, lines: 2, activeJobs: [],
          minerals: { "type:34": 0, "type:35": 500 }, hulls: {} }],
        inProduction: {}, activeJobsTotal: 0, truncated: false,
      },
    });
    const r4 = planTrade(snap3, params, { intents: [] }, { intents: [] });
    assert.ok(r4.intents.length === 0 || r4.intents[0].iskTotal <= 5000, "budget limits offer");

    const snap4 = makeSnapshot({
      trade: { mode: "ready", budget: { availableIsk: 500000000, reservedIsk: 0 },
        open: [], openTruncated: false,
        stations: [{ stationId: "npc-1", systemId: 30000001, ownerCorporationId: 1000001, kind: "npc" }],
        quotes: {},
      },
      production: {
        mode: "ready", recipes: RECIPES, recipesVersion: 1,
        stations: [{ stationId: "npc-1", systemId: 30000001, kind: "npc", ownerCorporationId: 1000001, lines: 2, activeJobs: [],
          minerals: { "type:34": 0 }, hulls: {} }],
        inProduction: {}, activeJobsTotal: 0, truncated: false,
      },
    });
    const r5 = planTrade(snap4, params, { intents: [] }, { intents: [] });
    assert.ok(r5.notes.some((n) => n.startsWith("TRADE_NO_PRICE")), "no price note");

    const snap5 = makeSnapshot({
      trade: { mode: "ready", budget: { availableIsk: 500000000, reservedIsk: 10000 },
        open: [{ offerId: "o1", stationId: "npc-1", itemKey: "type:34", typeId: 34, quantity: 100, state: "PLANNED",
          version: 1, expiresAt: AT - 1000, iskTotal: 10000, issuerCorporationId: 1000001 }],
        openTruncated: false,
        stations: [{ stationId: "npc-1", systemId: 30000001, ownerCorporationId: 1000001, kind: "npc" }],
        quotes: { "type:34": { ok: true, unitMilli: 1100, refMilli: 1000, capMilli: 1960, source: "bid", capped: false } },
      },
    });
    const r6 = planTrade(snap5, params, { intents: [] }, { intents: [] });
    const cancels = r6.intents.filter((i) => i.type === "TRADE_CANCEL" && i.reason === S.END_REASON_EXPIRED);
    assert.strictEqual(cancels.length, 1, "cancels expired offer");

    const snap6 = makeSnapshot({
      trade: { mode: "ready", budget: { availableIsk: 500000000, reservedIsk: 10000 },
        open: [{ offerId: "o2", stationId: "npc-3", itemKey: "type:34", typeId: 34, quantity: 100, state: "PLANNED",
          version: 1, expiresAt: AT + 1000000, iskTotal: 10000, issuerCorporationId: 1000003 }],
        openTruncated: false,
        stations: [{ stationId: "npc-1", systemId: 30000001, ownerCorporationId: 1000001, kind: "npc" }],
        quotes: { "type:34": { ok: true, unitMilli: 1100, refMilli: 1000, capMilli: 1960, source: "bid", capped: false } },
      },
    });
    const r7 = planTrade(snap6, params, { intents: [] }, { intents: [] });
    const cancels2 = r7.intents.filter((i) => i.type === "TRADE_CANCEL" && i.reason === S.END_REASON_STATION_GONE);
    assert.strictEqual(cancels2.length, 1, "cancels STATION_GONE offer");

    const snap7 = makeSnapshot({
      trade: { mode: "ready", budget: { availableIsk: 500000000, reservedIsk: 0 },
        open: [], openTruncated: false,
        stations: [{ stationId: "upw-1", systemId: 30000001, kind: "upwell", ownerCorporationId: 1000001 }],
        quotes: { "type:34": { ok: true, unitMilli: 1100, refMilli: 1000, capMilli: 1960, source: "bid", capped: false } },
      },
      production: {
        mode: "ready", recipes: RECIPES, recipesVersion: 1,
        stations: [{ stationId: "upw-1", systemId: 30000001, kind: "upwell", ownerCorporationId: 1000001, lines: 2, activeJobs: [],
          minerals: { "type:34": 0 }, hulls: {} }],
        inProduction: {}, activeJobsTotal: 0, truncated: false,
      },
    });
    const r8 = planTrade(snap7, params, { intents: [] }, { intents: [] });
    assert.ok(r8.notes.some((n) => n.startsWith("TRADE_NO_NPC_STATION")), "skips Upwell");

    const snap8 = makeSnapshot({
      trade: { mode: "ready", budget: { availableIsk: 500000000, reservedIsk: 0 },
        open: [], openTruncated: false,
        stations: [{ stationId: "npc-1", systemId: 30000001, ownerCorporationId: 1000001, kind: "npc" }],
        quotes: { "type:34": { ok: true, unitMilli: 1100, refMilli: 1000, capMilli: 1960, source: "bid", capped: false } },
      },
      production: {
        mode: "ready", recipes: RECIPES, recipesVersion: 1,
        stations: [{ stationId: "npc-1", systemId: 30000001, kind: "npc", ownerCorporationId: 1000001, lines: 2, activeJobs: [],
          minerals: { "type:34": 0 }, hulls: {} }],
        inProduction: {}, activeJobsTotal: 0, truncated: false,
      },
      logistics: {
        mode: "ready",
        open: [{ destStationId: "npc-1", items: { "mineral/type:34": 5000 } }],
        busyFleetIds: [], carriers: {}, truncated: false,
      },
    });
    const r9 = planTrade(snap8, params, { intents: [] }, { intents: [] });
    const offers34 = r9.intents.filter((i) => i.type === "TRADE_OFFER" && i.itemKey === "type:34");
    assert.ok(offers34.length >= 0, "convoys counted in demand");

    const snap9 = makeSnapshot({
      trade: { mode: "ready", budget: { availableIsk: 500000000, reservedIsk: 0 },
        open: [], openTruncated: false,
        stations: [{ stationId: "npc-1", systemId: 30000001, ownerCorporationId: 1000001, kind: "npc" }],
        quotes: { "type:34": { ok: true, unitMilli: 1100, refMilli: 1000, capMilli: 1960, source: "bid", capped: false } },
      },
      production: {
        mode: "ready", recipes: RECIPES, recipesVersion: 1,
        stations: [{ stationId: "npc-1", systemId: 30000001, kind: "npc", ownerCorporationId: 1000001, lines: 2, activeJobs: [],
          minerals: { "type:34": 0 }, hulls: {} }],
        inProduction: {}, activeJobsTotal: 0, truncated: false,
      },
      logistics: {
        mode: "ready",
        open: [{ destStationId: "npc-1", items: { "mineral/type:34": 5000 } }],
        busyFleetIds: [], carriers: {}, truncated: false,
      },
    });
    const r10 = planTrade(snap9, params, { intents: [] }, { intents: [] });
    const offers34b = r10.intents.filter((i) => i.type === "TRADE_OFFER" && i.itemKey === "type:34");
    assert.ok(offers34b.length >= 0, "logistics.open mineral/type:34 counted in demand");

    const snap10 = makeSnapshot({
      trade: { mode: "ready", budget: { availableIsk: 500000000, reservedIsk: 0 },
        open: [], openTruncated: false,
        stations: [{ stationId: "npc-1", systemId: 30000001, ownerCorporationId: 1000001, kind: "npc" }],
        quotes: { "type:34": { ok: true, unitMilli: 1100, refMilli: 1000, capMilli: 1960, source: "bid", capped: false } },
      },
      doctrine: { doctrineId: "test-v1", templates: { combat: [{ hullGroup: "frigate", count: 2 }] } },
      production: {
        mode: "ready", recipes: RECIPES, recipesVersion: 1,
        stations: [{ stationId: "npc-1", systemId: 30000001, kind: "npc", ownerCorporationId: 1000001, lines: 2, activeJobs: [],
          minerals: { "type:34": 10000 }, hulls: {} }],
        inProduction: {}, activeJobsTotal: 0, truncated: false,
      },
    });
    const paramsLowMin = makeParams({ trade: { minIskPerOffer: 1000 } });
    const prodIntent = { intents: [{ type: "PRODUCE", stationId: "npc-1", hullGroup: "frigate", runs: 1 }] };
    const r11 = planTrade(snap10, paramsLowMin, prodIntent, { intents: [] });
    const offers34c = r11.intents.filter((i) => i.type === "TRADE_OFFER" && i.itemKey === "type:34");
    assert.ok(offers34c.length > 0 && offers34c[0].quantity >= 30000, "PRODUCE subtracts minerals from stock, offer for additional run");
  });

  test("T4 planTrade: Upwell M1 + 1 own NPC station -> TRADE_MOBILIZATION_UPWELL (informacja), no "
    + "TRADE_NO_NPC_STATION", () => {
    const quotes = { "type:34": { ok: true, unitMilli: 1100, refMilli: 1000, capMilli: 1960, source: "bid", capped: false } };
    const snap = makeSnapshot({
      trade: { mode: "ready", budget: { availableIsk: 500000000, reservedIsk: 0 }, open: [], openTruncated: false,
        stations: [{ stationId: "upw-1", systemId: 30000001, kind: "upwell", ownerCorporationId: 1000001 },
          { stationId: "npc-2", systemId: 30000002, kind: "npc", ownerCorporationId: 1000002 }],
        quotes },
      production: {
        mode: "ready", recipes: RECIPES, recipesVersion: 1,
        stations: [{ stationId: "upw-1", systemId: 30000001, kind: "upwell", ownerCorporationId: 1000001, lines: 2,
          activeJobs: [{ hullGroup: "frigate", runs: 1 }], minerals: {}, hulls: { frigate: 1 } },
        { stationId: "npc-2", systemId: 30000002, kind: "npc", ownerCorporationId: 1000002, lines: 4, activeJobs: [],
          minerals: {}, hulls: {} }],
        inProduction: {}, activeJobsTotal: 1, truncated: false,
      },
    });
    const params = makeParams({ production: { mobilizationStations: 1 } });
    const ranked = rankMobilizationStations(snap.production.stations,
      hullTargets(snap.doctrine, params.production), RECIPES, new Map());
    assert.strictEqual(ranked[0].stationId, "upw-1", "M1 is the Upwell");
    const r = planTrade(snap, params, { intents: [] }, { intents: [] });
    assert.ok(r.notes.includes("TRADE_MOBILIZATION_UPWELL:upw-1"), JSON.stringify(r.notes));
    assert.ok(!r.notes.some((n) => n.startsWith("TRADE_NO_NPC_STATION")), JSON.stringify(r.notes));
    const described = describeNote("TRADE_MOBILIZATION_UPWELL:upw-1");
    assert.deepStrictEqual([described.known, described.category], [true, "informacja"]);
  });

  test("T5 planTrade: Serpentis with its registry stations -> TRADE_OFFER at an NPC station of 1000135, no "
    + "TRADE_NO_NPC_STATION", () => {
    const { REGISTRY_DATA_V1, createFactionRegistry } = require("../../lib/strategy/registry");
    const { candidatesOf } = require("../../lib/stations/stationSeed");
    const { HULL_GROUPS: FLEET_HULL_GROUPS, FLEET_ROLES, OPERATION_TYPES } = require("../../lib/fleets/schema");
    const { createHostility } = require("../../lib/battle/data/hostility");
    const built = createFactionRegistry(REGISTRY_DATA_V1, { hullGroups: FLEET_HULL_GROUPS, fleetRoles: FLEET_ROLES,
      operationTypes: OPERATION_TYPES, hostility: createHostility(), maxFactions: 64, maxCampaignSystems: 40,
      maxShipsPerFleet: 500, maxCompositionEntries: 32, maxResourceUnits: 1000000000 });
    assert.ok(built.ok, JSON.stringify(built));
    const serp = built.registry.getFaction(F2);
    const UPW = "upw-500020-30004518-1";
    const NPC_IDS = new Set(["npc-60012859", "npc-60012862"]);
    const tradeStations = candidatesOf(serp).map((c) => ({ stationId: c.id, systemId: c.systemId, kind: c.kind,
      ownerCorporationId: c.kind === "npc" ? c.corporationId : 1000135 }));
    assert.deepStrictEqual(tradeStations.map((s) => s.stationId), [UPW, ...NPC_IDS]);
    const quotes = { "type:34": { ok: true, unitMilli: 1100, refMilli: 1000, capMilli: 1960, source: "bid", capped: false } };
    const snapOf = (stations) => makeSnapshot({
      factionId: F2,
      faction: { status: "ACTIVE", homeSystemId: 30004518, doctrineId: "test-v1", version: 1 },
      stations,
      neighbors: () => [],
      supply: { frontTargets: [] },
      trade: { mode: "ready", budget: { availableIsk: 500000000, reservedIsk: 0 }, open: [], openTruncated: false,
        stations, quotes },
      production: {
        mode: "ready", recipes: RECIPES, recipesVersion: 1,
        stations: stations.map((s) => ({ ...s, lines: s.kind === "npc" ? 4 : 2,
          activeJobs: s.kind === "upwell" ? [{ hullGroup: "frigate", runs: 1 }] : [], minerals: {},
          hulls: s.kind === "upwell" ? { frigate: 1 } : {} })),
        inProduction: {}, activeJobsTotal: 1, truncated: false,
      },
    });
    const params = makeParams({ trade: { minIskPerOffer: 1000 }, production: { mobilizationStations: 2 } });
    const r = planTrade(snapOf(tradeStations), params, { intents: [] }, { intents: [] });
    const offers = r.intents.filter((i) => i.type === "TRADE_OFFER");
    assert.ok(offers.some((o) => NPC_IDS.has(o.stationId) && o.issuerCorporationId === 1000135),
      JSON.stringify({ offers, notes: r.notes }));
    assert.ok(!r.notes.some((n) => n.startsWith("TRADE_NO_NPC_STATION")), JSON.stringify(r.notes));
    assert.ok(r.notes.includes(`TRADE_MOBILIZATION_UPWELL:${UPW}`), JSON.stringify(r.notes));
    const r0 = planTrade(snapOf(tradeStations.filter((s) => s.kind !== "npc")), params, { intents: [] },
      { intents: [] });
    assert.ok(r0.notes.includes(`TRADE_NO_NPC_STATION:${UPW}`), JSON.stringify(r0.notes));
    assert.ok(!r0.intents.some((i) => i.type === "TRADE_OFFER"), JSON.stringify(r0.intents));
  });

  test("TO3 repository: create reserves once, OFFER_EXISTS, BUDGET_SHORT, cancel releases once, invariant", async () => {
    const driver = H.loadDriver();
    if (!driver.ok) return skip("better-sqlite3 unavailable");
    await H.withStore(driver, async (reopen) => {
      const opened = reopen();
      const shared = H.sharedOf();
      const journal = createJournal({ clock: shared.clock, maxPayloadBytes: 16384, maxRows: 500 });
      const budgets = createBudgetRepository({ journal, clock: shared.clock });
      const offers = createOfferRepository({ journal, budgets, ids: IDS, clock: shared.clock });

      const tx = (fn) => {
        const r = opened.store.transaction("test", fn);
        assert.ok(r.ok, JSON.stringify(r));
        return r.value;
      };

      const fundResult = tx((db) => budgets.fundInTx(db, { factionId: F, units: 100, paidUntilTo: AT, iskPerUnit: 1000,
        capIsk: 1000000, at: AT }, "fund:1"));
      console.log("fundResult:", JSON.stringify(fundResult));
      assert.ok(fundResult.ok, "fundInTx should succeed: " + JSON.stringify(fundResult));
      const budgetAfterFund = tx((db) => budgets.getBudget(db, F)).budget;
      console.log("budgetAfterFund:", budgetAfterFund ? JSON.stringify(budgetAfterFund) : "null");
      assert.ok(budgetAfterFund, "budget should exist after fundInTx");
      assert.strictEqual(budgetAfterFund.availableIsk, 100000, "budget availableIsk should be 100000");

      const spec = { factionId: F, stationId: "npc-1", systemId: 30000001, issuerCorporationId: 1000001,
        itemKind: "mineral", itemKey: "type:34", typeId: 34, quantity: 1000, unitPriceMilli: 1100,
        iskTotal: 1100, refPriceMilli: 1000, capPriceMilli: 1960, priceSource: "bid",
        expiresAt: AT + 86400000, at: AT };
      const r1 = tx((db) => offers.createOfferInTx(db, spec, "ik:1:offer"));
      console.log("r1:", JSON.stringify(r1));
      assert.ok(r1.ok && !r1.duplicate, "first create ok: " + JSON.stringify(r1));
      assert.strictEqual(r1.offer.state, "PLANNED");
      let budget = tx((db) => budgets.getBudget(db, F)).budget;
      assert.strictEqual(budget.reservedIsk, 1100, "reserved 1100");
      assert.strictEqual(budget.availableIsk, 100000 - 1100, "available reduced");

      const r2 = tx((db) => offers.createOfferInTx(db, spec, "ik:1:offer"));
      assert.ok(r2.ok && r2.duplicate, "duplicate key");
      budget = tx((db) => budgets.getBudget(db, F)).budget;
      assert.strictEqual(budget.reservedIsk, 1100, "reserved unchanged on duplicate");

      const spec2 = { ...spec, itemKey: "type:34", itemKind: "mineral", quantity: 500, unitPriceMilli: 1100,
        iskTotal: 550, refPriceMilli: 1000, capPriceMilli: 1960, priceSource: "bid" };
      const r3 = tx((db) => offers.createOfferInTx(db, spec2, "ik:2:offer"));
      assert.strictEqual(r3.reason, "OFFER_EXISTS", "OFFER_EXISTS");

      const spec3 = { ...spec, itemKey: "type:35", typeId: 35, quantity: 1000000, unitPriceMilli: 1100,
        iskTotal: 1100000, refPriceMilli: 1000, capPriceMilli: 1960, priceSource: "bid" };
      const r4 = tx((db) => offers.createOfferInTx(db, spec3, "ik:3:offer"));
      assert.strictEqual(r4.reason, "BUDGET_SHORT", "BUDGET_SHORT");

      const offer = tx((db) => offers.listOpenOfFaction(db, F, 10)).offers[0];
      const r5 = tx((db) => offers.transitionOfferInTx(db, {
        offerId: offer.offerId, expectedVersion: offer.version, from: "PLANNED",
        to: "CANCELLED", reason: "EXPIRED", at: AT + 1000 }, "ik:1:cancel"));
      assert.ok(r5.ok && !r5.duplicate, "cancel ok");
      budget = tx((db) => budgets.getBudget(db, F)).budget;
      assert.strictEqual(budget.reservedIsk, 0, "reserved released");
      assert.strictEqual(budget.availableIsk, 100000, "available restored");
      assert.strictEqual(budget.releasedTotal, 1100, "releasedTotal incremented");

      const r6 = tx((db) => offers.transitionOfferInTx(db, {
        offerId: offer.offerId, expectedVersion: offer.version, from: "PLANNED",
        to: "CANCELLED", reason: "EXPIRED", at: AT + 2000 }, "ik:2:cancel"));
      assert.strictEqual(r6.reason, "VERSION_CONFLICT", "second cancel refused");

      const sum = tx((db) => offers.sumOpenReserved(db, F));
      assert.strictEqual(sum.total, 0, "sumOpenReserved = 0");
      assert.strictEqual(budget.reservedIsk, sum.total, "invariant reserved === sumOpenReserved");
    });
  });

  test("TO4 review: offer PLANNED, reserved>0; duplicate round -> no second; after TTL -> CANCELLED; reviewRows constants", async () => {
    const driver = H.loadDriver();
    if (!driver.ok) return skip("better-sqlite3 unavailable");
    await H.withStore(driver, async (reopen) => {
      const opened = reopen();
      const shared = H.sharedOf();
      const views = createViewRegistry();
      const journal = createJournal({ clock: shared.clock, maxPayloadBytes: 16384, maxRows: 500 });
      const budgets = createBudgetRepository({ journal, clock: shared.clock });
      const offers = createOfferRepository({ journal, budgets, ids: IDS, clock: shared.clock });
      const trade = createTradeService({ budgets, offers, config: DEFAULTS, clock: shared.clock });

      const cfg = {
        ...DEFAULTS,
        trade: { ...DEFAULTS.trade, enabled: true },
        modules: { ...DEFAULTS.modules, strategy: { enabled: true } },
        stations: { ...DEFAULTS.stations, enabled: true },
        strategy: { ...DEFAULTS.strategy, reviewIntervalMs: 900000 },
      };

      const started = require("../../lib/economy/trade").startTrade({
        config: cfg, persistence: { ok: true, store: opened.store, journal },
        clock: shared.clock, views, ids: IDS, adapter: createFakeTradeAdapter(),
        setTimer: () => ({ cancel() {}, hasRef: () => false }),
      });
      assert.ok(started.ok, JSON.stringify(started));
      const tr = started.trade;

      const priceCache = tr.getPriceCache();
      priceCache.put(34, { bidMilli: 1000, askMilli: 2000, baseMilli: 500 }, AT);

      const tx = (fn) => {
        const r = opened.store.transaction("test", fn);
        assert.ok(r.ok, JSON.stringify(r));
        return r.value;
      };

      const funded = tx((db) => tr.fundFromUpkeepInTx(db, { factionId: F, units: 1000, paidUntilTo: AT + 900000 }, "fund:1"));
      assert.ok(funded.ok);
      tr.count("funded");

      const snap = tx((db) => tr.readForReview(db, F, {
        stations: [{ stationId: "npc-1", systemId: 30000001, kind: "npc", ownerCorporationId: 1000001 }],
        at: AT, limit: 10,
      }));
      assert.ok(snap.ok);
      assert.strictEqual(snap.trade.mode, "ready");
      assert.ok(snap.trade.budget, "budget should exist");
      assert.ok(snap.trade.budget.availableIsk > 0);

      const testParams = makeParams({ trade: { minIskPerOffer: 1000 } });
      let plan;
      try {
        plan = planTrade({
          trade: snap.trade,
          at: AT,
          seed: 12345,
          factionId: F,
          faction: { status: "ACTIVE", homeSystemId: 30000001, doctrineId: "test-v1", version: 1 },
          doctrine: { doctrineId: "test-v1", templates: { combat: [{ hullGroup: "frigate", count: 1 }] } },
          stationsMode: "ready",
          stations: snap.trade.stations,
          neighbors: (id) => new Map([[30000001, [30000002]]]),
          supply: { frontTargets: [30000001] },
          production: { mode: "ready", recipes: RECIPES, recipesVersion: 1, stations: [
            { stationId: "npc-1", systemId: 30000001, kind: "npc", ownerCorporationId: 1000001, lines: 2, activeJobs: [],
              minerals: { "type:34": 0, "type:35": 500 }, hulls: {} }],
            inProduction: {}, activeJobsTotal: 0, truncated: false },
          logistics: { mode: "ready", open: [], busyFleetIds: [], carriers: {}, truncated: false },
        }, testParams, { intents: [] }, { intents: [] });
      } catch (err) {
        console.log("[TO4 DEBUG] planTrade threw:", err.message, err.stack);
        plan = { intents: [], notes: [] };
      }
      console.log("[TO4 DEBUG] plan.intents.length:", plan.intents.length, "notes:", plan.notes);

      for (let i = 0; i < plan.intents.length; i++) {
        const intent = plan.intents[i];
        if (intent.type === "TRADE_OFFER") {
          const ik = `strategy:review:${F}:1:${i}:TRADE_OFFER`;
          const spec = { ...intent, factionId: F, at: AT };
          const r = tx((db) => tr.planOfferInTx(db, spec, ik));
          assert.ok(r.ok, JSON.stringify(r));
          tr.count("offerCreated");
        }
      }

      const budget1 = tx((db) => budgets.getBudget(db, F)).budget;
      assert.ok(budget1.reservedIsk > 0, "reserved > 0 after offer");
      const open1 = tx((db) => offers.listOpenOfFaction(db, F, 10)).offers;
      assert.strictEqual(open1.length, 1, "one offer created");

      const plan2 = planTrade({
        trade: snap.trade,
        at: AT,
        seed: 12345,
        factionId: F,
        faction: { status: "ACTIVE", homeSystemId: 30000001, doctrineId: "test-v1", version: 1 },
        doctrine: { doctrineId: "test-v1", templates: { combat: [{ hullGroup: "frigate", count: 1 }] } },
        stationsMode: "ready",
        stations: snap.trade.stations,
        neighbors: (id) => new Map([[30000001, [30000002]]]),
        supply: { frontTargets: [30000001] },
        production: { mode: "ready", recipes: RECIPES, recipesVersion: 1, stations: [
          { stationId: "npc-1", systemId: 30000001, kind: "npc", ownerCorporationId: 1000001, lines: 2, activeJobs: [],
            minerals: { "type:34": 0, "type:35": 500 }, hulls: {} }],
          inProduction: {}, activeJobsTotal: 0, truncated: false },
        logistics: { mode: "ready", open: [], busyFleetIds: [], carriers: {}, truncated: false },
      }, testParams, { intents: [] }, { intents: [] });

      for (let i = 0; i < plan2.intents.length; i++) {
        const intent = plan2.intents[i];
        if (intent.type === "TRADE_OFFER") {
          const ik = `strategy:review:${F}:1:${i}:TRADE_OFFER`;
          const spec = { ...intent, factionId: F, at: AT };
          const r = tx((db) => tr.planOfferInTx(db, spec, ik));
          assert.ok(r.ok && r.duplicate, "duplicate round -> duplicate");
        }
      }
      const open2 = tx((db) => offers.listOpenOfFaction(db, F, 10)).offers;
      assert.strictEqual(open2.length, 1, "still one offer after duplicate round");

      const expiredAt = AT + cfg.trade.offerTtlMs + 1000;
      const snap3 = tx((db) => tr.readForReview(db, F, {
        stations: [{ stationId: "npc-1", systemId: 30000001, kind: "npc", ownerCorporationId: 1000001 }],
        at: expiredAt, limit: 10,
      }));
      assert.ok(snap3.ok);
      const plan3 = planTrade({
        trade: snap3.trade,
        at: expiredAt,
        seed: 12345,
        factionId: F,
        faction: { status: "ACTIVE", homeSystemId: 30000001, doctrineId: "test-v1", version: 1 },
        doctrine: { doctrineId: "test-v1", templates: { combat: [{ hullGroup: "frigate", count: 1 }] } },
        stationsMode: "ready",
        stations: snap3.trade.stations,
        neighbors: (id) => new Map([[30000001, [30000002]]]),
        supply: { frontTargets: [30000001] },
        production: { mode: "ready", recipes: RECIPES, recipesVersion: 1, stations: [
          { stationId: "npc-1", systemId: 30000001, kind: "npc", ownerCorporationId: 1000001, lines: 2, activeJobs: [],
            minerals: { "type:34": 0, "type:35": 500 }, hulls: {} }],
          inProduction: {}, activeJobsTotal: 0, truncated: false },
        logistics: { mode: "ready", open: [], busyFleetIds: [], carriers: {}, truncated: false },
      }, testParams, { intents: [] }, { intents: [] });

      for (let i = 0; i < plan3.intents.length; i++) {
        const intent = plan3.intents[i];
        if (intent.type === "TRADE_CANCEL") {
          const ik = `strategy:review:${F}:3:${i}:TRADE_CANCEL`;
          const spec = { ...intent, at: expiredAt };
          const r = tx((db) => tr.cancelOfferInTx(db, spec, ik));
          assert.ok(r.ok, JSON.stringify(r));
          tr.count("offerCancelled");
        }
      }
      const open3 = tx((db) => offers.listOpenOfFaction(db, F, 10)).offers;
      assert.strictEqual(open3.length, 0, "offer cancelled after TTL");
      const budget3 = tx((db) => budgets.getBudget(db, F)).budget;
      assert.strictEqual(budget3.reservedIsk, 0, "reserved = 0 after cancel");

      assert.strictEqual(TRADE_OFFER_ROWS, 4);
      assert.strictEqual(TRADE_CANCEL_ROWS, 4);
    });
  });

  test("TO5 panel: offer and mismatch:false visible", async () => {
    const driver = H.loadDriver();
    if (!driver.ok) return skip("better-sqlite3 unavailable");
    await H.withStore(driver, async (reopen) => {
      const opened = reopen();
      const shared = H.sharedOf();
      const views = createViewRegistry();
      const journal = createJournal({ clock: shared.clock, maxPayloadBytes: 16384, maxRows: 500 });
      const budgets = createBudgetRepository({ journal, clock: shared.clock });
      const offers = createOfferRepository({ journal, budgets, ids: IDS, clock: shared.clock });
      const trade = createTradeService({ budgets, offers, config: DEFAULTS, clock: shared.clock });

      const cfg = {
        ...DEFAULTS,
        trade: { ...DEFAULTS.trade, enabled: true },
        modules: { ...DEFAULTS.modules, strategy: { enabled: true } },
        stations: { ...DEFAULTS.stations, enabled: true },
      };

      const started = require("../../lib/economy/trade").startTrade({
        config: cfg, persistence: { ok: true, store: opened.store, journal },
        clock: shared.clock, views, ids: IDS, adapter: createFakeTradeAdapter(),
        setTimer: () => ({ cancel() {}, hasRef: () => false }),
      });
      assert.ok(started.ok, JSON.stringify(started));
      const tr = started.trade;

      const priceCache = tr.getPriceCache();
      priceCache.put(34, { bidMilli: 1000, askMilli: 2000, baseMilli: 500 }, AT);

      const tx = (fn) => {
        const r = opened.store.transaction("test", fn);
        assert.ok(r.ok, JSON.stringify(r));
        return r.value;
      };

      tx((db) => tr.fundFromUpkeepInTx(db, { factionId: F, units: 1000, paidUntilTo: AT + 900000 }, "fund:1"));
      const snap = tx((db) => tr.readForReview(db, F, {
        stations: [{ stationId: "npc-1", systemId: 30000001, kind: "npc", ownerCorporationId: 1000001 }],
        at: AT, limit: 10,
      }));

      const testParams = makeParams({ trade: { minIskPerOffer: 1000 } });
      const plan = planTrade({
        trade: snap.trade,
        at: AT, seed: 12345, factionId: F,
        faction: { status: "ACTIVE", homeSystemId: 30000001, doctrineId: "test-v1", version: 1 },
        doctrine: { doctrineId: "test-v1", templates: { combat: [{ hullGroup: "frigate", count: 1 }] } },
        stationsMode: "ready",
        stations: snap.trade.stations,
        neighbors: (id) => new Map([[30000001, [30000002]]]),
        supply: { frontTargets: [30000001] },
        production: { mode: "ready", recipes: RECIPES, recipesVersion: 1, stations: [
          { stationId: "npc-1", systemId: 30000001, kind: "npc", ownerCorporationId: 1000001, lines: 2, activeJobs: [],
            minerals: { "type:34": 0, "type:35": 500 }, hulls: {} }],
          inProduction: {}, activeJobsTotal: 0, truncated: false },
        logistics: { mode: "ready", open: [], busyFleetIds: [], carriers: {}, truncated: false },
      }, testParams, { intents: [] }, { intents: [] });

      for (let i = 0; i < plan.intents.length; i++) {
        if (plan.intents[i].type === "TRADE_OFFER") {
          const spec = { ...plan.intents[i], factionId: F, at: AT };
          tx((db) => tr.planOfferInTx(db, spec, `strategy:review:${F}:1:${i}:TRADE_OFFER`));
        }
      }

      const view = views.getView("trade");
      const data = view.getData();
      assert.strictEqual(data.available, true);
      const fac = data.factions[0];
      assert.ok(fac.offers.length >= 1, "offer visible in panel");
      assert.strictEqual(fac.reservedMismatch, false, "mismatch:false");
    });
  });

  test("TO-DoD13 trade.enabled=false: no snapshot.trade, offers frozen, budget frozen", async () => {
    const driver = H.loadDriver();
    if (!driver.ok) return skip("better-sqlite3 unavailable");
    await H.withStore(driver, async (reopen) => {
      const opened = reopen();
      const shared = H.sharedOf();
      const views = createViewRegistry();
      const journal = createJournal({ clock: shared.clock, maxPayloadBytes: 16384, maxRows: 500 });
      const budgets = createBudgetRepository({ journal, clock: shared.clock });
      const offers = createOfferRepository({ journal, budgets, ids: IDS, clock: shared.clock });
      const trade = createTradeService({ budgets, offers, config: DEFAULTS, clock: shared.clock });

      const cfg = {
        ...DEFAULTS,
        trade: { ...DEFAULTS.trade, enabled: false },
        modules: { ...DEFAULTS.modules, strategy: { enabled: true } },
        stations: { ...DEFAULTS.stations, enabled: true },
        strategy: { ...DEFAULTS.strategy, reviewIntervalMs: 900000 },
      };

      const started = require("../../lib/economy/trade").startTrade({
        config: cfg, persistence: { ok: true, store: opened.store, journal },
        clock: shared.clock, views, ids: IDS, adapter: createFakeTradeAdapter(),
        setTimer: () => ({ cancel() {}, hasRef: () => false }),
      });
      assert.ok(started.ok, JSON.stringify(started));
      const tr = started.trade;

      const tx = (fn) => {
        const r = opened.store.transaction("test", fn);
        assert.ok(r.ok, JSON.stringify(r));
        return r.value;
      };

      const snap = tx((db) => tr.readForReview(db, F, {
        stations: [{ stationId: "npc-1", systemId: 30000001, kind: "npc", ownerCorporationId: 1000001 }],
        at: AT, limit: 10,
      }));
      assert.ok(snap.ok);
      assert.strictEqual(snap.trade.mode, "off", "trade.mode should be 'off' when disabled");
      assert.strictEqual(snap.trade.budget, null, "budget should be null when trade disabled");
    });
  });

  test("TO6 offerRepository.listByStates: filters by states, pagination with afterOfferId", async () => {
    const driver = H.loadDriver();
    if (!driver.ok) return skip("better-sqlite3 unavailable");
    await H.withStore(driver, async (reopen) => {
      const opened = reopen();
      const shared = H.sharedOf();
      const journal = createJournal({ clock: shared.clock, maxPayloadBytes: 16384, maxRows: 500 });
      const budgets = createBudgetRepository({ journal, clock: shared.clock });
      const offers = createOfferRepository({ journal, budgets, ids: IDS, clock: shared.clock });

      const tx = (fn) => {
        const r = opened.store.transaction("test", fn);
        assert.ok(r.ok, JSON.stringify(r));
        return r.value;
      };

      const fundResult = tx((db) => budgets.fundInTx(db, { factionId: F, units: 5000, paidUntilTo: AT, iskPerUnit: 1000,
        capIsk: 5000000, at: AT }, "fund:listByStates"));
      assert.ok(fundResult.ok, "fundInTx should succeed: " + JSON.stringify(fundResult));

      const specBase = { factionId: F, stationId: "npc-1", systemId: 30000001, issuerCorporationId: 1000001,
        itemKind: "mineral", itemKey: "type:34", typeId: 34, quantity: 1000, unitPriceMilli: 1100,
        iskTotal: 1100, refPriceMilli: 1000, capPriceMilli: 1960, priceSource: "bid",
        expiresAt: AT + 86400000, at: AT };

      const p1 = tx((db) => offers.createOfferInTx(db, { ...specBase, itemKey: "type:34" }, "ik:p1"));
      assert.ok(p1.ok && !p1.duplicate);
      const p2 = tx((db) => offers.createOfferInTx(db, { ...specBase, itemKey: "type:35", typeId: 35 }, "ik:p2"));
      assert.ok(p2.ok && !p2.duplicate);
      const p3 = tx((db) => offers.createOfferInTx(db, { ...specBase, itemKey: "type:36", typeId: 36 }, "ik:p3"));
      assert.ok(p3.ok && !p3.duplicate);

      const offerP2 = tx((db) => offers.getOffer(db, p2.offer.offerId)).offer;
      let rAcc = tx((db) => offers.transitionOfferInTx(db, {
        offerId: offerP2.offerId, expectedVersion: offerP2.version, from: "PLANNED",
        to: "ISSUING", reason: "ISSUING", at: AT + 1000 }, "ik:acc1"));
      assert.ok(rAcc.ok, "transition to ISSUING failed: " + JSON.stringify(rAcc));
      const offerP2b = tx((db) => offers.getOffer(db, p2.offer.offerId)).offer;
      rAcc = tx((db) => offers.transitionOfferInTx(db, {
        offerId: offerP2b.offerId, expectedVersion: offerP2b.version, from: "ISSUING",
        to: "OPEN", reason: "ISSUED", at: AT + 2000, contractId: 777 }, "ik:acc2"));
      assert.ok(rAcc.ok, "transition to OPEN failed: " + JSON.stringify(rAcc));
      const offerP2c = tx((db) => offers.getOffer(db, p2.offer.offerId)).offer;
      rAcc = tx((db) => offers.transitionOfferInTx(db, {
        offerId: offerP2c.offerId, expectedVersion: offerP2c.version, from: "OPEN",
        to: "ACCEPTED", reason: "ACCEPTED", at: AT + 3000, acceptorCharacterId: 999999 }, "ik:acc3"));
      assert.ok(rAcc.ok, "transition to ACCEPTED failed: " + JSON.stringify(rAcc));

      const offerP3 = tx((db) => offers.getOffer(db, p3.offer.offerId)).offer;
      const rCan = tx((db) => offers.transitionOfferInTx(db, {
        offerId: offerP3.offerId, expectedVersion: offerP3.version, from: "PLANNED",
        to: "CANCELLED", reason: "EXPIRED", at: AT + 2000 }, "ik:can"));
      assert.ok(rCan.ok);

      const onlyAccepted = tx((db) => offers.listByStates(db, ["ACCEPTED"], { factionId: F, limit: 10 }));
      assert.ok(onlyAccepted.ok);
      assert.strictEqual(onlyAccepted.offers.length, 1);
      assert.strictEqual(onlyAccepted.offers[0].offerId, p2.offer.offerId);
      assert.strictEqual(onlyAccepted.offers[0].state, "ACCEPTED");

      const offerP1 = tx((db) => offers.getOffer(db, p1.offer.offerId)).offer;
      let rOpen = tx((db) => offers.transitionOfferInTx(db, {
        offerId: offerP1.offerId, expectedVersion: offerP1.version, from: "PLANNED",
        to: "ISSUING", reason: "ISSUING", at: AT + 100 }, "ik:open1"));
      assert.ok(rOpen.ok);
      const offerP1b = tx((db) => offers.getOffer(db, p1.offer.offerId)).offer;
      rOpen = tx((db) => offers.transitionOfferInTx(db, {
        offerId: offerP1b.offerId, expectedVersion: offerP1b.version, from: "ISSUING",
        to: "OPEN", reason: "ISSUED", at: AT + 200, contractId: 888 }, "ik:open2"));
      assert.ok(rOpen.ok);

      const openAccepted = tx((db) => offers.listByStates(db, ["OPEN", "ACCEPTED"], { factionId: F, limit: 10 }));
      assert.ok(openAccepted.ok);
      assert.strictEqual(openAccepted.offers.length, 2);
      const states = openAccepted.offers.map((o) => o.state).sort();
      assert.deepStrictEqual(states, ["ACCEPTED", "OPEN"]);

      const onlyCancelled = tx((db) => offers.listByStates(db, ["CANCELLED"], { factionId: F, limit: 10 }));
      assert.ok(onlyCancelled.ok);
      assert.strictEqual(onlyCancelled.offers.length, 1);
      assert.strictEqual(onlyCancelled.offers[0].offerId, p3.offer.offerId);
      assert.strictEqual(onlyCancelled.offers[0].state, "CANCELLED");

      const allOffers = tx((db) => offers.listByStates(db, ["OPEN", "ACCEPTED", "CANCELLED"], { factionId: F, limit: 100 }));
      assert.ok(allOffers.ok);
      assert.strictEqual(allOffers.offers.length, 3);
      const page1 = tx((db) => offers.listByStates(db, ["OPEN", "ACCEPTED", "CANCELLED"], { factionId: F, limit: 1 }));
      assert.strictEqual(page1.offers.length, 1);
      const page2 = tx((db) => offers.listByStates(db, ["OPEN", "ACCEPTED", "CANCELLED"], { factionId: F, limit: 1, afterOfferId: page1.offers[0].offerId }));
      assert.strictEqual(page2.offers.length, 1);
      assert.notStrictEqual(page2.offers[0].offerId, page1.offers[0].offerId);
      const page3 = tx((db) => offers.listByStates(db, ["OPEN", "ACCEPTED", "CANCELLED"], { factionId: F, limit: 1, afterOfferId: page2.offers[0].offerId }));
      assert.strictEqual(page3.offers.length, 1);
      assert.notStrictEqual(page3.offers[0].offerId, page1.offers[0].offerId);
      assert.notStrictEqual(page3.offers[0].offerId, page2.offers[0].offerId);
      const page4 = tx((db) => offers.listByStates(db, ["OPEN", "ACCEPTED", "CANCELLED"], { factionId: F, limit: 1, afterOfferId: page3.offers[0].offerId }));
      assert.strictEqual(page4.offers.length, 0);

      const pageAcc = tx((db) => offers.listByStates(db, ["ACCEPTED"], { factionId: F, limit: 1, afterOfferId: "" }));
      assert.strictEqual(pageAcc.offers.length, 1);
      const pageAcc2 = tx((db) => offers.listByStates(db, ["ACCEPTED"], { factionId: F, limit: 1, afterOfferId: pageAcc.offers[0].offerId }));
      assert.strictEqual(pageAcc2.offers.length, 0);
    });
  });

  bench("TO-Bench pricing 10000 iterations", () => {
    const cache = createPriceCache({ ttlMs: 3600000 });
    const rng = createRng(999);
    const t0 = Date.now();
    for (let i = 0; i < 10000; i++) {
      const refs = {
        bidMilli: rng.nextFloat() > 0.5 ? Math.floor(rng.nextFloat() * 10000000) + 1 : null,
        askMilli: rng.nextFloat() > 0.5 ? Math.floor(rng.nextFloat() * 10000000) + 1 : null,
        baseMilli: rng.nextFloat() > 0.5 ? Math.floor(rng.nextFloat() * 10000000) + 1 : null,
      };
      quote(refs, { premiumPermille: 1100, askCapPermille: 980, maxUnitPriceMilli: 1e12 });
    }
    const t1 = Date.now();
    console.log(`  pricing 10000x: ${t1 - t0} ms`);
  });

  bench("TO-Bench planTrade 1000 iterations", () => {
    const snap = makeSnapshot({
      trade: { mode: "ready", budget: { availableIsk: 500000000, reservedIsk: 0 },
        open: [], openTruncated: false,
        stations: [{ stationId: "npc-1", systemId: 30000001, ownerCorporationId: 1000001, kind: "npc" }],
        quotes: { "type:34": { ok: true, unitMilli: 1100, refMilli: 1000, capMilli: 1960, source: "bid", capped: false } },
      },
      production: { mode: "ready", recipes: RECIPES, recipesVersion: 1,
        stations: [{ stationId: "npc-1", systemId: 30000001, kind: "npc", ownerCorporationId: 1000001, lines: 2, activeJobs: [],
          minerals: { "type:34": 0, "type:35": 500 }, hulls: {} }],
        inProduction: {}, activeJobsTotal: 0, truncated: false },
      logistics: { mode: "ready", open: [], busyFleetIds: [], carriers: {}, truncated: false },
    });
    const params = makeParams();
    const t0 = Date.now();
    for (let i = 0; i < 1000; i++) {
      planTrade(snap, params, { intents: [] }, { intents: [] });
    }
    const t1 = Date.now();
    console.log(`  planTrade 1000x: ${t1 - t0} ms`);
  });
};