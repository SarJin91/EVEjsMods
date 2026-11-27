"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { createJournal } = require("../../lib/persistence/journal");
const { openStore } = require("../../lib/persistence/store");
const { LATEST_SCHEMA_VERSION, MIGRATIONS, runMigrations } = require("../../lib/persistence/migrations");
const { createBudgetRepository } = require("../../lib/economy/trade/budgetRepository");
const { createOfferRepository } = require("../../lib/economy/trade/offerRepository");
const { createTradeService } = require("../../lib/economy/trade/tradeService");
const { createPriceCache } = require("../../lib/economy/trade/priceCache");
const { quote } = require("../../lib/economy/trade/pricing");
const { planTrade, pairTaken, planPrivateOffers, OPEN_OFFER_STATES } = require("../../lib/strategy/ai/trade");
const { reviewRowBound, TRADE_OFFER_ROWS, TRADE_CANCEL_ROWS } = require("../../lib/strategy/reviewRows");
const S = require("../../lib/economy/trade/schema");
const { createViewRegistry } = require("../../lib/observer/views");
const { hullTargets, rankMobilizationStations, focusOf } = require("../../lib/strategy/ai/production");
const { bfs } = require("../../lib/strategy/ai/bfs");
const { createRng } = require("../../lib/util/rng");
const { harness: H } = require("../battle/settlement.test");
const { createFakeTradeAdapter } = require("../_support/fakeTradeAdapter");
const config = require("../../config");
const { standingMilliOf, tiersFromConfig, bonusFor, computeStandingBonus } = require("../../lib/economy/trade/standingTiers");
const { startTrade } = require("../../lib/economy/trade/index");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const DEFAULTS = config.resolveConfig({ modDir: MOD_DIR, env: {} }).config;
const F = 500019;
const F2 = 500020;
const AT = 1000000;
const CLOCK = { now: () => AT };
let idCounter = 0;
const IDS = { next: (p) => `${p}_${++idCounter}` };

const MINERAL_TYPE_IDS = S.MINERAL_TYPE_IDS;
const { GROUPS: HULL_RECIPES } = require("../../lib/economy/data/hullRecipes");
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
    maxPrivateOffersPerReview: 2,
    maxOpenPrivateOffersPerFaction: 4,
    maxOpenPrivateOffersPerCharacter: 2,
    privateOfferTtlMs: 86400000,
    privateRejectCooldownMs: 604800000,
    supplierLookbackMs: 604800000,
    maxSuppliersPerReview: 20,
    standingThreshold1Min: 2.0,
    standingThreshold1Bonus: 30,
    standingThreshold2Min: 5.0,
    standingThreshold2Bonus: 60,
    standingThreshold3Min: 8.0,
    standingThreshold3Bonus: 100,
    privateOffersEnabled: true,
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

function makeTradeServiceDeps(overrides = {}) {
  const journal = createJournal({ clock: CLOCK, maxPayloadBytes: 16384, maxRows: 500 });
  const budgets = createBudgetRepository({ journal, clock: CLOCK });
  const offers = createOfferRepository({ journal, budgets, ids: IDS, clock: CLOCK });
  const priceCache = createPriceCache({ ttlMs: 3600000 });
  const tradeConfig = { ...DEFAULTS, ...overrides };
  return createTradeService({
    budgets, offers, config: tradeConfig, clock: CLOCK, telemetry: null, logger: { log: () => {} },
    readStanding: overrides.readStanding || null,
  });
}

function seedSupplier(tx, offers, { characterId, typeId, at, contractId }) {
  const created = tx((db) => offers.createOfferInTx(db, {
    factionId: F, stationId: "npc-1", systemId: 30000001, issuerCorporationId: 1000001,
    itemKind: "mineral", itemKey: `type:${typeId}`, typeId, quantity: 1000, unitPriceMilli: 1100,
    iskTotal: 1100, refPriceMilli: 1000, capPriceMilli: 1960, priceSource: "bid", expiresAt: at + 86400000, at,
  }, `ik:sup${characterId}:offer`));
  assert.ok(created.ok && created.offer, JSON.stringify(created));
  let offer = created.offer;
  const edges = [[S.PLANNED, S.ISSUING, { expiresAt: at + 86400000 }], [S.ISSUING, S.OPEN, { contractId }],
    [S.OPEN, S.ACCEPTED, { acceptorCharacterId: characterId }]];
  for (const [from, to, patch] of edges) {
    const r = tx((db) => offers.transitionOfferInTx(db, { offerId: offer.offerId, expectedVersion: offer.version, from, to,
      reason: "", at, patch }, S.transitionKey(offer.offerId, offer.stateSeq + 1, to)));
    assert.ok(r.ok, `${from}->${to} ${JSON.stringify(r)}`);
    offer = r.offer;
  }
  return offer;
}

module.exports = ({ test, skip, bench, benchEnabled }) => {
  const needsDriver = (name, fn) => {
    if (H.loadDriver().ok) test(name, fn);
    else skip(name, "better-sqlite3 unavailable");
  };

  test("TP5a standingTiers: computeStandingBonus boundaries 1999/2000/4999/8000", () => {
    assert.strictEqual(computeStandingBonus(1.999, [{min: 2.0, bonusPermille: 30}]), 0);
    assert.strictEqual(computeStandingBonus(2.0, [{min: 2.0, bonusPermille: 30}]), 30);
    assert.strictEqual(computeStandingBonus(4.9995, [{min: 2.0, bonusPermille: 30}, {min: 5.0, bonusPermille: 60}]), 30);
    assert.strictEqual(computeStandingBonus(5.0, [{min: 2.0, bonusPermille: 30}, {min: 5.0, bonusPermille: 60}]), 60);
    assert.strictEqual(computeStandingBonus(8.0, [
      {min: 2.0, bonusPermille: 30}, {min: 5.0, bonusPermille: 60}, {min: 8.0, bonusPermille: 100}
    ]), 100);
  });

  test("TP5b standingTiers: invalid tiers -> PRIVATE_TIERS_INVALID", () => {
    const r1 = tiersFromConfig({ standingThreshold1Min: 5.0, standingThreshold1Bonus: 30, standingThreshold2Min: 2.0, standingThreshold2Bonus: 60 });
    assert.ok(!r1.ok && r1.reason === "PRIVATE_TIERS_INVALID");
    const r2 = tiersFromConfig({ standingThreshold1Min: 2.0, standingThreshold1Bonus: 100, standingThreshold2Min: 5.0, standingThreshold2Bonus: 30 });
    assert.ok(!r2.ok && r2.reason === "PRIVATE_TIERS_INVALID");
    const r3 = tiersFromConfig({ standingThreshold1Min: 2.0, standingThreshold1Bonus: 1500 });
    assert.ok(!r3.ok && r3.reason === "PRIVATE_TIERS_INVALID");
  });

  test("TP5c standingTiers: tier with bonus 0 is skipped", () => {
    const r = tiersFromConfig({
      standingThreshold1Min: 2.0, standingThreshold1Bonus: 0,
      standingThreshold2Min: 5.0, standingThreshold2Bonus: 60,
    });
    assert.ok(r.ok);
    assert.strictEqual(r.tiers.length, 1);
    assert.strictEqual(r.tiers[0].minMilli, 5000);
    assert.strictEqual(r.tiers[0].bonusPermille, 60);
  });

  test("TP5d standingTiers: standingMilliOf and bonusFor helpers", () => {
    assert.strictEqual(standingMilliOf(5.0), 5000);
    assert.strictEqual(standingMilliOf(2.5), 2500);
    const tiers = [{minMilli: 2000, bonusPermille: 30}, {minMilli: 5000, bonusPermille: 60}];
    assert.strictEqual(bonusFor(1999, tiers), 0);
    assert.strictEqual(bonusFor(2000, tiers), 30);
    assert.strictEqual(bonusFor(4999, tiers), 30);
    assert.strictEqual(bonusFor(5000, tiers), 60);
    assert.strictEqual(bonusFor(10000, tiers), 60);
  });

  function makeTradeSnapshot(overrides = {}) {
    return {
      mode: "ready",
      budget: { availableIsk: 500000000, reservedIsk: 0 },
      open: overrides.open || [],
      openTruncated: false,
      stations: [
        { stationId: "npc-1", systemId: 30000001, ownerCorporationId: 1000001, kind: "npc" },
        { stationId: "npc-2", systemId: 30000002, ownerCorporationId: 1000002, kind: "npc" },
      ],
      quotes: {
        "type:34": { ok: true, unitMilli: 1100, refMilli: 1000, capMilli: 1960, source: "bid", capped: false },
        "type:35": { ok: true, unitMilli: 1100, refMilli: 1000, capMilli: 1960, source: "bid", capped: false },
      },
      privateQuotes: overrides.privateQuotes || {},
      suppliers: overrides.suppliers || [],
      ...overrides,
    };
  }

  function makeCandidates() {
    return [
      { station: { stationId: "npc-1", systemId: 30000001 }, stationId: "npc-1", typeId: 34, need: 100000, itemKey: "type:34", deficitPct: 500, rank: 0 },
      { station: { stationId: "npc-2", systemId: 30000002 }, stationId: "npc-2", typeId: 34, need: 50000, itemKey: "type:34", deficitPct: 300, rank: 1 },
    ];
  }

  test("TP6a planPrivateOffers: supplier with tier -> private intent with bonus, TTL, assignee", () => {
    const trade = makeTradeSnapshot({
      suppliers: [{ characterId: 777, standingMilli: 5000, bonusPermille: 60, rejectedAt: undefined }],
      privateQuotes: {
        60: { "type:34": { ok: true, unitMilli: 1166, refMilli: 1000, capMilli: 1960, source: "bid", capped: false } },
      },
    });
    const T = makeParams({ trade: { privateOffersEnabled: true } }).trade;
    const result = planPrivateOffers(trade, T, AT, makeCandidates(), []);
    assert.strictEqual(result.intents.length, 1);
    const intent = result.intents[0];
    assert.strictEqual(intent.assigneeCharacterId, 777);
    assert.strictEqual(intent.standingBonusPermille, 60);
    assert.strictEqual(intent.expiresAt, AT + T.privateOfferTtlMs);
    assert.strictEqual(intent.unitPriceMilli, 1166);
    assert.ok(result.notes.some(n => n.startsWith("TRADE_PRIVATE_OFFER")));
  });

  test("TP6b planPrivateOffers: pair taken in step 5 (P9) -> no duplicate", () => {
    const trade = makeTradeSnapshot({
      suppliers: [{ characterId: 777, standingMilli: 5000, bonusPermille: 60 }],
      privateQuotes: { 60: { "type:34": { ok: true, unitMilli: 1166, refMilli: 1000, capMilli: 1960, source: "bid", capped: false } } },
      open: [
        { state: "PLANNED", stationId: "npc-1", itemKey: "type:34" },
        { state: "PLANNED", stationId: "npc-2", itemKey: "type:34" },
      ],
    });
    const T = makeParams().trade;
    const result = planPrivateOffers(trade, T, AT, makeCandidates(), []);
    assert.strictEqual(result.intents.length, 0);
  });

  test("TP6c planPrivateOffers: public price at cap -> TRADE_PRIVATE_NO_GAIN, public offer created", () => {
    const trade = makeTradeSnapshot({
      suppliers: [{ characterId: 777, standingMilli: 5000, bonusPermille: 60 }],
      privateQuotes: { 60: { "type:34": { ok: true, unitMilli: 1100, refMilli: 1000, capMilli: 1100, source: "bid", capped: true } } },
      quotes: { "type:34": { ok: true, unitMilli: 1100, refMilli: 1000, capMilli: 1100, source: "bid", capped: true } },
    });
    const T = makeParams().trade;
    const result = planPrivateOffers(trade, T, AT, makeCandidates(), []);
    assert.strictEqual(result.intents.length, 0);
    assert.ok(result.notes.some(n => n.startsWith("TRADE_PRIVATE_NO_GAIN")));
  });

  test("TP6d planPrivateOffers: rejectedAt in cooldown -> TRADE_PRIVATE_COOLDOWN, next supplier gets offer", () => {
    const trade = makeTradeSnapshot({
      suppliers: [
        { characterId: 777, standingMilli: 5000, bonusPermille: 60, rejectedAt: AT - 1000 },
        { characterId: 888, standingMilli: 8000, bonusPermille: 100, rejectedAt: undefined },
      ],
      privateQuotes: {
        60: { "type:34": { ok: true, unitMilli: 1166, refMilli: 1000, capMilli: 1960, source: "bid", capped: false } },
        100: { "type:34": { ok: true, unitMilli: 1210, refMilli: 1000, capMilli: 1960, source: "bid", capped: false } },
      },
    });
    const T = makeParams().trade;
    const result = planPrivateOffers(trade, T, AT, makeCandidates(), []);
    assert.strictEqual(result.intents.length, 1);
    assert.strictEqual(result.intents[0].assigneeCharacterId, 888);
    assert.ok(result.notes.some(n => n.startsWith("TRADE_PRIVATE_COOLDOWN:777")));
  });

  test("TP6e planPrivateOffers: limits per character / faction / review", () => {
    const trade = makeTradeSnapshot({
      suppliers: [
        { characterId: 777, standingMilli: 5000, bonusPermille: 60 },
        { characterId: 888, standingMilli: 5000, bonusPermille: 60 },
      ],
      privateQuotes: { 60: { "type:34": { ok: true, unitMilli: 1166, refMilli: 1000, capMilli: 1960, source: "bid", capped: false } } },
      open: [
        { assigneeCharacterId: 777, state: "OPEN" },
        { assigneeCharacterId: 777, state: "OPEN" },
      ],
    });
    const T = makeParams().trade;
    const result = planPrivateOffers(trade, T, AT, makeCandidates(), []);
    assert.strictEqual(result.intents.length, 1);
    assert.strictEqual(result.intents[0].assigneeCharacterId, 888);
  });

  test("TP6f planPrivateOffers: pair with OPEN offer -> TRADE_OFFER_EXISTS", () => {
    const trade = makeTradeSnapshot({
      suppliers: [{ characterId: 777, standingMilli: 5000, bonusPermille: 60 }],
      privateQuotes: { 60: { "type:34": { ok: true, unitMilli: 1166, refMilli: 1000, capMilli: 1960, source: "bid", capped: false } } },
      open: [
        { state: "OPEN", stationId: "npc-1", itemKey: "type:34" },
        { state: "OPEN", stationId: "npc-2", itemKey: "type:34" },
      ],
    });
    const T = makeParams().trade;
    const result = planPrivateOffers(trade, T, AT, makeCandidates(), []);
    assert.strictEqual(result.intents.length, 0);
  });

  test("TP6h SWEEP-20261027 planPrivateOffers: quantity <= maxOfferVolumeM3, with and without tiers", () => {
    for (const tiersEnabled of [false, true]) {
      const trade = makeTradeSnapshot({
        suppliers: [{ characterId: 777, standingMilli: 5000, bonusPermille: 60 }],
        privateQuotes: { 60: { "type:34": { ok: true, unitMilli: 1166, refMilli: 1000, capMilli: 1960, source: "bid", capped: false } } },
        volumes: { "type:34": 1 },
      });
      const T = makeParams({ trade: { tiersEnabled, maxOfferVolumeM3: 500, minIskPerOffer: 1000 } }).trade;
      const result = planPrivateOffers(trade, T, AT, makeCandidates(), []);
      assert.strictEqual(result.intents.length, 1, `tiersEnabled=${tiersEnabled}`);
      assert.strictEqual(result.intents[0].quantity, 50000, `tiersEnabled=${tiersEnabled}`);
      assert.strictEqual(result.intents[0].iskTotal, Math.floor((50000 * 1166) / 1000));
    }
  });

  test("TP6g pairTaken: checks all OPEN_OFFER_STATES", () => {
    const openOffers = [
      { state: "PLANNED", stationId: "npc-1", itemKey: "type:34" },
      { state: "ISSUING", stationId: "npc-1", itemKey: "type:35" },
      { state: "OPEN", stationId: "npc-2", itemKey: "type:34" },
      { state: "ACCEPTED", stationId: "npc-2", itemKey: "type:35" },
      { state: "INTAKE", stationId: "npc-1", itemKey: "type:36" },
    ];
    assert.ok(pairTaken(openOffers, [], "npc-1", "type:34"));
    assert.ok(pairTaken(openOffers, [], "npc-1", "type:35"));
    assert.ok(pairTaken(openOffers, [], "npc-2", "type:34"));
    assert.ok(pairTaken(openOffers, [], "npc-2", "type:35"));
    assert.ok(pairTaken(openOffers, [], "npc-1", "type:36"));
    assert.ok(!pairTaken(openOffers, [], "npc-1", "type:37"));
    assert.ok(!pairTaken(openOffers, [], "npc-3", "type:34"));
  });

  needsDriver("TP7a readForReview: listSuppliers + fake readStanding -> suppliers sorted, privateQuotes", async () => {
    await H.withStore(H.loadDriver(), async (reopen) => {
      const opened = reopen();
      const shared = H.sharedOf();
      const journal = createJournal({ clock: shared.clock, maxPayloadBytes: 16384, maxRows: 500 });
      const budgets = createBudgetRepository({ journal, clock: shared.clock });
      const offers = createOfferRepository({ journal, budgets, ids: IDS, clock: shared.clock });
      const privateOn = { ...DEFAULTS, trade: { ...DEFAULTS.trade, privateOffersEnabled: true } };
      const trade = createTradeService({
        budgets, offers, config: privateOn, clock: shared.clock, telemetry: null, logger: { log: () => {} },
        readStanding: (charId, facId) => {
          if (charId === 111) return { ok: true, found: true, standing: 2.5 };
          if (charId === 222) return { ok: true, found: true, standing: 5.5 };
          if (charId === 333) return { ok: false, reason: "STANDING_READ_FAILED" };
          return { ok: true, found: false };
        },
      });
      trade.getPriceCache().put(34, { bidMilli: 1000, askMilli: 2000, baseMilli: 500 }, AT);

      const tx = (fn) => {
        const r = opened.store.transaction("test", fn);
        assert.ok(r.ok, JSON.stringify(r));
        return r.value;
      };

      tx((db) => budgets.fundInTx(db, { factionId: F, units: 1000, paidUntilTo: AT, iskPerUnit: 1000, capIsk: 1000000, at: AT }, "fund:1"));

      [111, 222, 333].forEach((characterId, i) => {
        seedSupplier(tx, offers, { characterId, typeId: 35 + i, at: AT - 1000 * (i + 1), contractId: 700000 + i });
      });

      const snap = tx((db) => trade.readForReview(db, F, {
        stations: [{ stationId: "npc-1", systemId: 30000001, kind: "npc", ownerCorporationId: 1000001 }],
        at: AT, limit: 10,
      }));

      assert.ok(snap.ok, JSON.stringify(snap));
      assert.strictEqual(snap.trade.mode, "ready");
      assert.deepStrictEqual(snap.trade.suppliers, [
        { characterId: 222, standingMilli: 5500, bonusPermille: 60 },
        { characterId: 111, standingMilli: 2500, bonusPermille: 30 },
      ]);
      assert.deepStrictEqual(Object.keys(snap.trade.privateQuotes).sort(), ["30", "60"]);
      assert.deepStrictEqual(Object.keys(snap.trade.privateQuotes[60]), ["type:34"]);
      assert.ok(snap.trade.privateQuotes[60]["type:34"].unitMilli > snap.trade.quotes["type:34"].unitMilli, "bonus raises the price");
      assert.strictEqual(trade.getStatus().counters.standingReadFailed, 1);
    });
  });

  needsDriver("TP7b readForReview: found:false and!ok -> skipped, standingReadFailed counter", async () => {
    await H.withStore(H.loadDriver(), async (reopen) => {
      const opened = reopen();
      const shared = H.sharedOf();
      const journal = createJournal({ clock: shared.clock, maxPayloadBytes: 16384, maxRows: 500 });
      const budgets = createBudgetRepository({ journal, clock: shared.clock });
      const offers = createOfferRepository({ journal, budgets, ids: IDS, clock: shared.clock });
      let standingReadFailed = 0;
      const privateOn = { ...DEFAULTS, trade: { ...DEFAULTS.trade, privateOffersEnabled: true } };
      const trade = createTradeService({
        budgets, offers, config: privateOn, clock: shared.clock, telemetry: null, logger: { log: () => {} },
        readStanding: (charId, facId) => {
          if (charId === 111) return { ok: true, found: false };
          if (charId === 222) { standingReadFailed++; return { ok: false, reason: "STANDING_READ_THREW" }; }
          return { ok: true, found: true, standing: 5.0 };
        },
      });

      const tx = (fn) => {
        const r = opened.store.transaction("test", fn);
        assert.ok(r.ok, JSON.stringify(r));
        return r.value;
      };

      tx((db) => budgets.fundInTx(db, { factionId: F, units: 1000, paidUntilTo: AT, iskPerUnit: 1000, capIsk: 1000000, at: AT }, "fund:1"));

      [111, 222, 333].forEach((characterId, i) => {
        seedSupplier(tx, offers, { characterId, typeId: 35 + i, at: AT - 1000, contractId: 710000 + i });
      });

      const snap = tx((db) => trade.readForReview(db, F, {
        stations: [{ stationId: "npc-1", systemId: 30000001, kind: "npc", ownerCorporationId: 1000001 }],
        at: AT, limit: 10,
      }));

      assert.ok(snap.ok);
      assert.strictEqual(snap.trade.suppliers.length, 1);
      assert.strictEqual(snap.trade.suppliers[0].characterId, 333);
      assert.strictEqual(standingReadFailed, 1);
      const status = trade.getStatus();
      assert.ok(status.counters.standingReadFailed >= 1);
    });
  });

  needsDriver("TP7c readForReview: gate off (privateOffersEnabled=false) -> suppliers empty", async () => {
    await H.withStore(H.loadDriver(), async (reopen) => {
      const opened = reopen();
      const shared = H.sharedOf();
      const journal = createJournal({ clock: shared.clock, maxPayloadBytes: 16384, maxRows: 500 });
      const budgets = createBudgetRepository({ journal, clock: shared.clock });
      const offers = createOfferRepository({ journal, budgets, ids: IDS, clock: shared.clock });
      const tradeConfig = { ...DEFAULTS, trade: { ...DEFAULTS.trade, privateOffersEnabled: false } };
      const trade = createTradeService({ budgets, offers, config: tradeConfig, clock: shared.clock, telemetry: null, logger: { log: () => {} } });

      const tx = (fn) => { const r = opened.store.transaction("test", fn); assert.ok(r.ok); return r.value; };
      tx((db) => budgets.fundInTx(db, { factionId: F, units: 1000, paidUntilTo: AT, iskPerUnit: 1000, capIsk: 1000000, at: AT }, "fund:1"));

      const now = shared.clock.now();
      const offerSpec = { factionId: F, stationId: "npc-1", systemId: 30000001, issuerCorporationId: 1000001,
        itemKind: "mineral", itemKey: "type:34", typeId: 34, quantity: 1000, unitPriceMilli: 1100,
        iskTotal: 1100, refPriceMilli: 1000, capPriceMilli: 1960, priceSource: "bid",
        expiresAt: AT + 86400000, at: AT, acceptorCharacterId: 999, updatedAt: now };
      tx((db) => offers.createOfferInTx(db, offerSpec, "ik:sup999:offer:sup999"));

      const snap = tx((db) => trade.readForReview(db, F, {
        stations: [{ stationId: "npc-1", systemId: 30000001, kind: "npc", ownerCorporationId: 1000001 }],
        at: AT, limit: 10,
      }));

      assert.ok(snap.ok);
      assert.strictEqual(snap.trade.suppliers.length, 0);
      assert.deepStrictEqual(snap.trade.privateQuotes, {});
    });
  });

  test("TP8a config: 13 new keys with defaults and ranges", () => {
    const cfg = config.resolveConfig({ modDir: MOD_DIR, env: {} }).config;
    assert.strictEqual(cfg.trade.privateOffersEnabled, false);
    assert.strictEqual(cfg.trade.maxPrivateOffersPerReview, 2);
    assert.strictEqual(cfg.trade.maxOpenPrivateOffersPerFaction, 4);
    assert.strictEqual(cfg.trade.maxOpenPrivateOffersPerCharacter, 2);
    assert.strictEqual(cfg.trade.privateOfferTtlMs, 86400000);
    assert.strictEqual(cfg.trade.privateRejectCooldownMs, 604800000);
    assert.strictEqual(cfg.trade.supplierLookbackMs, 604800000);
    assert.strictEqual(cfg.trade.maxSuppliersPerReview, 20);
    assert.strictEqual(cfg.trade.standingThreshold1Min, 2.0);
    assert.strictEqual(cfg.trade.standingThreshold1Bonus, 30);
    assert.strictEqual(cfg.trade.standingThreshold2Min, 5.0);
    assert.strictEqual(cfg.trade.standingThreshold2Bonus, 60);
    assert.strictEqual(cfg.trade.standingThreshold3Min, 8.0);
    assert.strictEqual(cfg.trade.standingThreshold3Bonus, 100);
  });

  test("TP8b config: warnings for invalid tiers and limits", () => {
    const on = { EVEJS_LNE_TRADE_ENABLED: "true", EVEJS_LNE_STRATEGY_ENABLED: "true", EVEJS_LNE_TRADE_PRIVATE_OFFERS_ENABLED: "true" };
    const cfg0 = config.resolveConfig({ modDir: MOD_DIR, env: on });
    assert.ok(!cfg0.warnings.some(w => w.includes("PRIVATE_TIERS_INVALID") || w.includes("maxPrivate") || w.includes("maxOpenPrivate")),
      JSON.stringify(cfg0.warnings));
    const cfg1 = config.resolveConfig({ modDir: MOD_DIR, env: { ...on, EVEJS_LNE_TRADE_STANDING_THRESHOLD_1_MIN: "5.0", EVEJS_LNE_TRADE_STANDING_THRESHOLD_2_MIN: "2.0" } });
    assert.ok(cfg1.warnings.some(w => w.includes("PRIVATE_TIERS_INVALID")), JSON.stringify(cfg1.warnings));
    const cfg1z = config.resolveConfig({ modDir: MOD_DIR, env: { ...on, EVEJS_LNE_TRADE_STANDING_THRESHOLD_2_BONUS: "0" } });
    assert.ok(!cfg1z.warnings.some(w => w.includes("PRIVATE_TIERS_INVALID")), JSON.stringify(cfg1z.warnings));

    const cfg2 = config.resolveConfig({ modDir: MOD_DIR, env: { ...on, EVEJS_LNE_TRADE_MAX_PRIVATE_OFFERS_PER_REVIEW: "5", EVEJS_LNE_TRADE_MAX_OFFERS_PER_REVIEW: "2" } });
    assert.ok(cfg2.warnings.some(w => w.includes("maxPrivateOffersPerReview > trade.maxOffersPerReview")));

    const cfg3 = config.resolveConfig({ modDir: MOD_DIR, env: { ...on, EVEJS_LNE_TRADE_MAX_OPEN_PRIVATE_OFFERS_PER_FACTION: "10", EVEJS_LNE_TRADE_MAX_OPEN_OFFERS_PER_FACTION: "8" } });
    assert.ok(cfg3.warnings.some(w => w.includes("maxOpenPrivateOffersPerFaction > trade.maxOpenOffersPerFaction")));
  });

  test("TP8c params.trade has 5 planner keys", () => {
    const params = makeParams();
    assert.ok("maxPrivateOffersPerReview" in params.trade);
    assert.ok("maxOpenPrivateOffersPerFaction" in params.trade);
    assert.ok("maxOpenPrivateOffersPerCharacter" in params.trade);
    assert.ok("privateOfferTtlMs" in params.trade);
    assert.ok("privateRejectCooldownMs" in params.trade);
  });

  test("TP8d E2E: supplier -> review -> createOfferInTx with assigneeCharacterId -> executor issues private contract (fake adapter)", async () => {
    await H.withStore(H.loadDriver(), async (reopen) => {
      const opened = reopen();
      const shared = H.sharedOf();
      const views = createViewRegistry();
      const journal = createJournal({ clock: shared.clock, maxPayloadBytes: 16384, maxRows: 500 });
      const budgets = createBudgetRepository({ journal, clock: shared.clock });
      const offers = createOfferRepository({ journal, budgets, ids: IDS, clock: shared.clock });

      const tradeConfig = {
        ...DEFAULTS,
        trade: { ...DEFAULTS.trade, enabled: true, privateOffersEnabled: true, contractsEnabled: true },
        modules: { ...DEFAULTS.modules, strategy: { enabled: true } },
        stations: { ...DEFAULTS.stations, enabled: true },
        strategy: { ...DEFAULTS.strategy, reviewIntervalMs: 900000 },
      };

      const fakeAdapter = createFakeTradeAdapter();
      fakeAdapter.readCharacterStanding = (charId, facId) => {
        if (charId === 999) return { ok: true, found: true, standing: 5.5 };
        return { ok: true, found: false };
      };
      fakeAdapter.checkStandingRead = () => ({ ok: true });

      const started = startTrade({
        config: tradeConfig, persistence: { ok: true, store: opened.store, journal },
        clock: shared.clock, views, ids: IDS, adapter: fakeAdapter,
        setTimer: () => ({ cancel() {}, hasRef: () => false }),
      });
      assert.ok(started.ok, JSON.stringify(started));
      const tr = started.trade;

      const status = tr.getStatus();
      assert.strictEqual(status.privateOffers.gate, "on");
      assert.strictEqual(status.privateOffers.reason, "ok");

      const priceCache = tr.getPriceCache();
      priceCache.put(34, { bidMilli: 1000, askMilli: 2000, baseMilli: 500 }, AT);

      const tx = (fn) => { const r = opened.store.transaction("test", fn); assert.ok(r.ok, JSON.stringify(r)); return r.value; };
      
      tx((db) => {
        const stmt = db.prepare(`
          INSERT INTO world_stations (station_id, kind, npc_station_id, type_id, structure_family, system_id,
            owner_faction_id, owner_corporation_id, state, state_until_at, name, position_json, origin,
            evejs_item_id, destroyed_at, created_at, updated_at, version)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        stmt.run("npc-1", "npc", 60003760, 35834, "Sansha", 30000001, F, 1000001, "ONLINE", null, "Sansha Testing Station", '{"x":0,"y":0,"z":0}', "seed", null, null, AT, AT, 1);
      });
      
      tx((db) => tr.fundFromUpkeepInTx(db, { factionId: F, units: 1000, paidUntilTo: AT + 900000 }, "fund:1"));
      seedSupplier(tx, offers, { characterId: 999, typeId: 35, at: AT - 1000, contractId: 720000 });
      tr.count("funded");

      const snap = tx((db) => tr.readForReview(db, F, {
        stations: [{ stationId: "npc-1", systemId: 30000001, kind: "npc", ownerCorporationId: 1000001 }],
        at: AT, limit: 10,
      }));
      assert.ok(snap.ok);
      assert.strictEqual(snap.trade.mode, "ready");
      assert.ok(snap.trade.suppliers.length > 0, "should have suppliers with bonus");

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
            minerals: { "type:34": 0 }, hulls: {} }],
          inProduction: {}, activeJobsTotal: 0, truncated: false },
        logistics: { mode: "ready", open: [], busyFleetIds: [], carriers: {}, truncated: false },
      }, testParams, { intents: [] }, { intents: [] });

      const privateOffers = plan.intents.filter(i => i.type === "TRADE_OFFER" && i.assigneeCharacterId);
      assert.ok(privateOffers.length > 0, "should create private offer");
      const privateOffer = privateOffers[0];
      assert.ok(privateOffer.assigneeCharacterId);
      assert.ok(privateOffer.standingBonusPermille > 0);
      assert.strictEqual(privateOffer.expiresAt, AT + testParams.trade.privateOfferTtlMs);

      const ik = `strategy:review:${F}:1:0:TRADE_OFFER`;
      const r = tx((db) => tr.planOfferInTx(db, { ...privateOffer, factionId: F, at: AT }, ik));
      assert.ok(r.ok, JSON.stringify(r));
      tr.count("offerCreated");

      const createdOffer = r.offer;
      assert.strictEqual(createdOffer.assigneeCharacterId, privateOffer.assigneeCharacterId);
      assert.strictEqual(createdOffer.standingBonusPermille, privateOffer.standingBonusPermille);

      const view = views.getView("trade");
      const data = view.getData();
      assert.strictEqual(data.available, true);
      const fac = data.factions[0];
      assert.ok(fac.privateOffers.suppliers.length > 0, "panel should show suppliers");
    });
  });

  bench("TP-Bench standingTiers 10000 iterations", () => {
    const t0 = Date.now();
    for (let i = 0; i < 10000; i++) {
      computeStandingBonus(5.0, [
        {min: 2.0, bonusPermille: 30},
        {min: 5.0, bonusPermille: 60},
        {min: 8.0, bonusPermille: 100},
      ]);
    }
    const t1 = Date.now();
    console.log(`  standingTiers 10000x: ${t1 - t0} ms`);
  });

  bench("TP-Bench planPrivateOffers 1000 iterations", () => {
    const trade = makeTradeSnapshot({
      suppliers: [{ characterId: 777, standingMilli: 5000, bonusPermille: 60 }],
      privateQuotes: { 60: { "type:34": { ok: true, unitMilli: 1166, refMilli: 1000, capMilli: 1960, source: "bid", capped: false } } },
    });
    const T = makeParams().trade;
    const candidates = makeCandidates();
    const t0 = Date.now();
    for (let i = 0; i < 1000; i++) {
      planPrivateOffers(trade, T, AT, candidates, []);
    }
    const t1 = Date.now();
    console.log(`  planPrivateOffers 1000x: ${t1 - t0} ms`);
  });
};