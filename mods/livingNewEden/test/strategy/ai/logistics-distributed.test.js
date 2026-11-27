"use strict";

const assert = require("node:assert");
const { planLogistics } = require("../../../lib/strategy/ai/logistics");
const { planProduction } = require("../../../lib/strategy/ai/production");
const { createHullLedger } = require("../../../lib/strategy/ai/hulls");
const RECIPES = require("../../../lib/economy/data/hullRecipes");
const { HULL_GROUPS } = require("../../../lib/fleets/schema");

const AMARR = 500003;
const SAMINER = 30001721;
const HOME = 30001868;
const AT = 1760000000000;

const recipes = Object.fromEntries(Object.entries(RECIPES.GROUPS).map(([g, r]) => [g, { minerals: r.minerals }]));

const PROD = Object.freeze({ maxJobsPerReview: 8, maxRunsPerJob: 4, maxActiveJobsPerFaction: 8, targetStockFleets: 1,
  mobilizeHulls: "required", miningNeedsHulls: false, mobilizationStations: 1, hullGroups: [...HULL_GROUPS] });

const LOG = Object.freeze({
  enabled: true, maxFleetsPerFaction: 3, maxOpenConvoysPerFaction: 4, maxDispatchesPerReview: 8,
  maxHullConvoysPerReview: 8, maxMobilizationsPerReview: 1, carrierCapacityM3: 60000, maxCargoItems: 12,
  minLoadVolume: 50000, factoryRunsTarget: 2, maxConvoyJumps: 20, needsHulls: false,
  watchGraceMs: 900000, watchRecheckMs: 1800000, maxWatchRounds: 12, convoyRetentionMs: 604800000,
  pruneBatch: 8, reconcileMaxConvoys: 500, reconcileMaxAttempts: 8, maxStepsPerPass: 20,
  replenishEnabled: true, maxReplenishPerReview: 2, frontStationMaxJumps: 6,
  retireEnabled: true, maxRetiresPerReview: 2, convoysEnabled: true, volumes: { mineral: 1, hulls: { cruiser: 50000, industrial: 60000 }, unitsPerM3: 100, carrierGroups: ["industrial"] } });

const times = (g, n) => Object.fromEntries(Object.entries(RECIPES.GROUPS[g].minerals).map(([k, v]) => [k, v * n]));
const st = (stationId, systemId, minerals, hulls = {}, activeJobs = [], lines = 2) => ({
  stationId, systemId, kind: "npc", lines, activeJobs, minerals, hulls, deficit: {} });
const prodOf = (stations, extra = {}) => ({ mode: "ready", recipesVersion: 1, recipes, inProduction: {},
  activeJobsTotal: 0, truncated: false, stations, ...extra });
const logOf = (open = [], extra = {}) => ({ mode: "ready", open, busyFleetIds: [], carriers: {}, truncated: false, ...extra });
const snap = (factionId, o = {}) => ({
  v: 1, factionId, round: 7, at: AT, seed: 12345,
  faction: { status: "ACTIVE", homeSystemId: HOME, doctrineId: "d", resourceUnits: 20000, reserveUnits: 300, frontLimit: 1, version: 3 },
  doctrine: { doctrineId: "d", canOccupy: false, operationTypes: [], reachJumps: 10,
    templates: { invasion: [{ hullGroup: "cruiser", count: 5 }], logistics: [{ hullGroup: "industrial", count: 2 }] } },
  stationsMode: "ready",
  stations: (o.stations || [SAMINER]).map((systemId, i) => ({ systemId, stationId: "st" + i })),
  systems: [],
  neighbors: () => [],
  regionOf: () => null,
  isHostile: () => false,
  fleets: [],
  production: o.production || prodOf([]),
  logistics: o.logistics || logOf(),
});

module.exports = ({ test }) => {
  test("logistics-distributed: HULLS_TO_MOBILIZATION convoy from production station to M", () => {
    const P = { production: PROD, logistics: { ...LOG, volumes: { mineral: 1, hulls: { cruiser: 50000, industrial: 60000 }, unitsPerM3: 100, carrierGroups: ["industrial"] } } };
    const s = snap(AMARR);
    s.production = prodOf([
      st("stM", SAMINER, {}, {}, [{ hullGroup: "cruiser", runs: 1 }], 2),
      st("stA", HOME, times("cruiser", 4), {}, [], 2),
      st("stB", HOME + 1, times("cruiser", 4), {}, [], 2),
    ]);

    const production = { intents: [
      { type: "PRODUCE", stationId: "stA", hullGroup: "cruiser", runs: 3, recipesVersion: 1, slot: 0 },
      { type: "PRODUCE", stationId: "stB", hullGroup: "cruiser", runs: 2, recipesVersion: 1, slot: 1 },
    ]};

    const ledger = createHullLedger(s, { production: PROD });
    const supply = { frontTargets: [], affordable: { resourceUnits: 10000, reserveUnits: 1000 } };
    s.fleets = [
      { fleetId: "lf1", state: "IDLE", fleetRole: "logistics", systemId: HOME, composition: [{ hullGroup: "industrial", count: 2 }], refitPending: false, version: 1 },
      { fleetId: "lf2", state: "IDLE", fleetRole: "logistics", systemId: HOME + 1, composition: [{ hullGroup: "industrial", count: 2 }], refitPending: false, version: 1 }
    ];
    s.logistics.carriers = { lf1: 2, lf2: 2 };
    const plan = planLogistics(s, supply, P, production, ledger, null);

    const hullConvoys = plan.intents.filter((i) => i.type === "CONVOY_DISPATCH" && i.purpose === "HULLS_TO_MOBILIZATION");
    assert.ok(hullConvoys.length >= 2, "at least two HULLS_TO_MOBILIZATION convoys: " + JSON.stringify(hullConvoys));
    const fromA = hullConvoys.find((c) => c.sourceStationId === "stA");
    const fromB = hullConvoys.find((c) => c.sourceStationId === "stB");
    assert.ok(fromA, "convoy from stA to stM: " + JSON.stringify(hullConvoys));
    assert.ok(fromB, "convoy from stB to stM: " + JSON.stringify(hullConvoys));
    const aItems = fromA.items.filter((it) => it.itemKind === "hull" && it.itemKey === "group:cruiser");
    const bItems = fromB.items.filter((it) => it.itemKind === "hull" && it.itemKey === "group:cruiser");
    assert.strictEqual(aItems[0]?.quantity, 3, "stA convoy carries 3 cruisers");
    assert.strictEqual(bItems[0]?.quantity, 1, "stB convoy carries 1 cruiser (limited by remaining deficit)");
  });

  test("logistics-distributed: no double counting (production + convoy = 1 deficit)", () => {
    const P = { production: PROD, logistics: { ...LOG, volumes: { mineral: 1, hulls: { cruiser: 50000, industrial: 60000 }, unitsPerM3: 100 } } };
    const s = snap(AMARR);
    s.production = prodOf([
      st("stM", SAMINER, {}, {}, [{ hullGroup: "cruiser", runs: 1 }], 2),
      st("stA", HOME, times("cruiser", 4), {}, [], 2),
      st("stB", HOME + 1, times("cruiser", 4), {}, [], 2),
    ]);

    const production = { intents: [
      { type: "PRODUCE", stationId: "stA", hullGroup: "cruiser", runs: 2, recipesVersion: 1, slot: 0 },
      { type: "PRODUCE", stationId: "stB", hullGroup: "cruiser", runs: 2, recipesVersion: 1, slot: 1 },
    ]};

    const ledger = createHullLedger(s, { production: PROD });
    const supply = { frontTargets: [], affordable: { resourceUnits: 10000, reserveUnits: 1000 } };
    s.fleets = [
      { fleetId: "lf1", state: "IDLE", fleetRole: "logistics", systemId: HOME, composition: [{ hullGroup: "industrial", count: 2 }], refitPending: false, version: 1 },
      { fleetId: "lf2", state: "IDLE", fleetRole: "logistics", systemId: HOME + 1, composition: [{ hullGroup: "industrial", count: 2 }], refitPending: false, version: 1 }
    ];
    s.logistics.carriers = { lf1: 2, lf2: 2 };
    const plan = planLogistics(s, supply, P, production, ledger, null);

    const hullConvoys = plan.intents.filter((i) => i.type === "CONVOY_DISPATCH" && i.purpose === "HULLS_TO_MOBILIZATION");
    let totalConveyed = 0;
    for (const c of hullConvoys) {
      for (const it of c.items) {
        if (it.itemKind === "hull" && it.itemKey === "group:cruiser") totalConveyed += it.quantity;
      }
    }
    assert.strictEqual(totalConveyed, 4, "total conveyed hulls = M's deficit (4), not double counted: " + totalConveyed);
  });

  test("logistics-distributed: maxHullConvoysPerReview limit respected", () => {
    const limitedLog = { ...LOG, maxHullConvoysPerReview: 2, volumes: { mineral: 1, hulls: { cruiser: 50000, industrial: 60000 }, unitsPerM3: 100, carrierGroups: ["industrial"] } };
    const P = { production: PROD, logistics: limitedLog };
    const s = snap(AMARR);
    const stations = [st("stM", SAMINER, {}, {}, [{ hullGroup: "cruiser", runs: 1 }], 2)];
    for (let i = 0; i < 5; i += 1) {
      stations.push(st("st" + i, HOME + i, times("cruiser", 4), {}, [], 2));
    }
    s.production = prodOf(stations);

    const production = { intents: [
      { type: "PRODUCE", stationId: "st0", hullGroup: "cruiser", runs: 2, recipesVersion: 1, slot: 0 },
      { type: "PRODUCE", stationId: "st1", hullGroup: "cruiser", runs: 2, recipesVersion: 1, slot: 1 },
      { type: "PRODUCE", stationId: "st2", hullGroup: "cruiser", runs: 2, recipesVersion: 1, slot: 2 },
      { type: "PRODUCE", stationId: "st3", hullGroup: "cruiser", runs: 2, recipesVersion: 1, slot: 3 },
      { type: "PRODUCE", stationId: "st4", hullGroup: "cruiser", runs: 2, recipesVersion: 1, slot: 4 },
    ]};

    const ledger = createHullLedger(s, { production: PROD });
    const supply = { frontTargets: [], affordable: { resourceUnits: 10000, reserveUnits: 1000 } };
    s.fleets = [
      { fleetId: "lf1", state: "IDLE", fleetRole: "logistics", systemId: HOME, composition: [{ hullGroup: "industrial", count: 2 }], refitPending: false, version: 1 },
      { fleetId: "lf2", state: "IDLE", fleetRole: "logistics", systemId: HOME + 1, composition: [{ hullGroup: "industrial", count: 2 }], refitPending: false, version: 1 }
    ];
    s.logistics.carriers = { lf1: 2, lf2: 2 };
    const plan = planLogistics(s, supply, P, production, ledger, null);

    const hullConvoys = plan.intents.filter((i) => i.type === "CONVOY_DISPATCH" && i.purpose === "HULLS_TO_MOBILIZATION");
    assert.ok(hullConvoys.length <= 2, "maxHullConvoysPerReview=2 limits convoys: " + hullConvoys.length);
    for (const c of hullConvoys) {
      assert.strictEqual(c.purpose, "HULLS_TO_MOBILIZATION", "all are HULLS_TO_MOBILIZATION: " + JSON.stringify(c));
    }
  });

  const TRIT = "type:34";

  const LOG_WITH_MINERALS = Object.freeze({
    ...LOG,
    mineralSurplusThreshold: 1000,
    maxMineralConvoysPerReview: 4,
    mineralConvoyMinLoad: 100,
    volumes: { mineral: 1, hulls: { cruiser: 50000, industrial: 60000 }, unitsPerM3: 100, carrierGroups: ["industrial"] }
  });

  test("logistics-distributed (Plaster 3): mineral convoy from surplus station to station without raw materials", () => {
    const P = { production: PROD, logistics: LOG_WITH_MINERALS };
    const s = snap(AMARR);
    s.production = prodOf([
      st("stM", SAMINER, {}, {}, [{ hullGroup: "cruiser", runs: 1 }], 2),
      st("stA", HOME, { [TRIT]: 100 }, {}, [], 2),
      st("stB", HOME + 1, { [TRIT]: 1000000 }, {}, [], 0),
    ]);

    const production = { intents: [] };

    const ledger = createHullLedger(s, { production: PROD });
    const supply = { frontTargets: [], affordable: { resourceUnits: 10000, reserveUnits: 1000 } };
    s.fleets = [
      { fleetId: "lf1", state: "IDLE", fleetRole: "logistics", systemId: HOME + 1, composition: [{ hullGroup: "industrial", count: 2 }], refitPending: false, version: 1 }
    ];
    s.logistics.carriers = { lf1: 2 };
    const plan = planLogistics(s, supply, P, production, ledger, null);

    const mineralConvoys = plan.intents.filter((i) => i.type === "CONVOY_DISPATCH" && i.purpose === "MINERALS_TO_FACTORY");
    assert.ok(mineralConvoys.length >= 1, "at least one MINERALS_TO_FACTORY convoy: " + JSON.stringify(mineralConvoys));
    const convoy = mineralConvoys[0];
    assert.strictEqual(convoy.sourceStationId, "stB", "source is stB (surplus station)");
    assert.strictEqual(convoy.destStationId, "stA", "dest is stA (station without minerals)");
    const tritItems = convoy.items.filter((it) => it.itemKind === "mineral" && it.itemKey === TRIT);
    assert.ok(tritItems.length >= 1, "convoy carries type:34 (tritanium)");
    const expectedQty = RECIPES.GROUPS.cruiser.minerals[TRIT] - 100;
    assert.strictEqual(tritItems[0].quantity, expectedQty, "quantity = needed (no per-mineral cap)");
    const totalVolume = convoy.items.reduce((sum, it) => sum + it.quantity * 1, 0);
    assert.ok(totalVolume >= 100, "total volume >= mineralConvoyMinLoad");
  });

  test("logistics-distributed (Plaster 3): does not transport minerals from source that has free lines (will use them)", () => {
    const P = { production: PROD, logistics: LOG_WITH_MINERALS };
    const s = snap(AMARR);
    s.production = prodOf([
      st("stM", SAMINER, {}, {}, [{ hullGroup: "cruiser", runs: 1 }], 2),
      st("stA", HOME, { [TRIT]: 100 }, {}, [], 2),
      st("stB", HOME + 1, { [TRIT]: 1000000 }, {}, [], 2),
      st("stC", HOME + 2, { [TRIT]: 1000000 }, {}, [], 0),
    ]);

    const production = { intents: [] };

    const ledger = createHullLedger(s, { production: PROD });
    const supply = { frontTargets: [], affordable: { resourceUnits: 10000, reserveUnits: 1000 } };
    s.fleets = [
      { fleetId: "lf1", state: "IDLE", fleetRole: "logistics", systemId: HOME + 2, composition: [{ hullGroup: "industrial", count: 2 }], refitPending: false, version: 1 }
    ];
    s.logistics.carriers = { lf1: 2 };
    const plan = planLogistics(s, supply, P, production, ledger, null);

    const mineralConvoys = plan.intents.filter((i) => i.type === "CONVOY_DISPATCH" && i.purpose === "MINERALS_TO_FACTORY");
    const fromB = mineralConvoys.find((c) => c.sourceStationId === "stB");
    const fromC = mineralConvoys.find((c) => c.sourceStationId === "stC");
    assert.strictEqual(fromB, undefined, "no convoy from stB because it has free lines and will use minerals itself");
    assert.ok(fromC, "convoy from stC (surplus, no free lines): " + JSON.stringify(mineralConvoys));
  });

  test("logistics-distributed (Plaster 3): maxMineralConvoysPerReview limit respected", () => {
    const limitedLog = { ...LOG_WITH_MINERALS, maxMineralConvoysPerReview: 2 };
    const P = { production: PROD, logistics: limitedLog };
    const s = snap(AMARR);
    s.production = prodOf([
      st("stM", SAMINER, {}, {}, [{ hullGroup: "cruiser", runs: 1 }], 2),
      st("stA", HOME, { [TRIT]: 100 }, {}, [], 2),
      st("stB", HOME + 1, { [TRIT]: 100 }, {}, [], 2),
      st("stC", HOME + 2, { [TRIT]: 100 }, {}, [], 2),
      st("stSource", HOME + 3, { [TRIT]: 1000000 }, {}, [], 0),
    ]);

    const production = { intents: [] };

    const ledger = createHullLedger(s, { production: PROD });
    const supply = { frontTargets: [], affordable: { resourceUnits: 10000, reserveUnits: 1000 } };
    s.fleets = [
      { fleetId: "lf1", state: "IDLE", fleetRole: "logistics", systemId: HOME + 3, composition: [{ hullGroup: "industrial", count: 2 }], refitPending: false, version: 1 }
    ];
    s.logistics.carriers = { lf1: 2 };
    const plan = planLogistics(s, supply, P, production, ledger, null);

    const mineralConvoys = plan.intents.filter((i) => i.type === "CONVOY_DISPATCH" && i.purpose === "MINERALS_TO_FACTORY");
    assert.ok(mineralConvoys.length <= 2, "maxMineralConvoysPerReview=2 limits convoys: " + mineralConvoys.length);
    for (const c of mineralConvoys) {
      assert.strictEqual(c.purpose, "MINERALS_TO_FACTORY", "all are MINERALS_TO_FACTORY: " + JSON.stringify(c));
    }
  });

  test("logistics-distributed (Plaster 4): restart during convoy - ledger preserves in-transit hulls", () => {
    const P = { production: PROD, logistics: { ...LOG, volumes: { mineral: 1, hulls: { cruiser: 50000, industrial: 60000 }, unitsPerM3: 100, carrierGroups: ["industrial"] } } };
    const s = snap(AMARR);
    s.production = prodOf([
      st("stM", SAMINER, {}, {}, [{ hullGroup: "cruiser", runs: 1 }], 2),
      st("stA", HOME, times("cruiser", 4), {}, [], 2),
      st("stB", HOME + 1, times("cruiser", 4), {}, [], 2),
    ]);

    const production = { intents: [
      { type: "PRODUCE", stationId: "stA", hullGroup: "cruiser", runs: 3, recipesVersion: 1, slot: 0 },
      { type: "PRODUCE", stationId: "stB", hullGroup: "cruiser", runs: 2, recipesVersion: 1, slot: 1 },
    ]};

    const ledger1 = createHullLedger(s, { production: PROD });
    const supply = { frontTargets: [], affordable: { resourceUnits: 10000, reserveUnits: 1000 } };
    s.fleets = [
      { fleetId: "lf1", state: "IDLE", fleetRole: "logistics", systemId: HOME, composition: [{ hullGroup: "industrial", count: 2 }], refitPending: false, version: 1 },
      { fleetId: "lf2", state: "IDLE", fleetRole: "logistics", systemId: HOME + 1, composition: [{ hullGroup: "industrial", count: 2 }], refitPending: false, version: 1 }
    ];
    s.logistics.carriers = { lf1: 2, lf2: 2 };
    const plan1 = planLogistics(s, supply, P, production, ledger1, null);

    const hullConvoys1 = plan1.intents.filter((i) => i.type === "CONVOY_DISPATCH" && i.purpose === "HULLS_TO_MOBILIZATION");
    assert.ok(hullConvoys1.length >= 2, "at least two HULLS_TO_MOBILIZATION convoys on first round");

    let totalConveyed1 = 0;
    for (const c of hullConvoys1) {
      for (const it of c.items) {
        if (it.itemKind === "hull" && it.itemKey === "group:cruiser") totalConveyed1 += it.quantity;
      }
    }
    assert.strictEqual(totalConveyed1, 4, "total conveyed = M's deficit (4)");

    const convoyItemsA = hullConvoys1.find((c) => c.sourceStationId === "stA").items.filter((it) => it.itemKind === "hull");
    const convoyItemsB = hullConvoys1.find((c) => c.sourceStationId === "stB").items.filter((it) => it.itemKind === "hull");
    s.logistics.open = [
      { convoyId: "cv1", state: "IN_TRANSIT", purpose: "HULLS_TO_MOBILIZATION", sourceStationId: "stA", destStationId: "stM", fleetId: "lf1", items: convoyItemsA },
      { convoyId: "cv2", state: "IN_TRANSIT", purpose: "HULLS_TO_MOBILIZATION", sourceStationId: "stB", destStationId: "stM", fleetId: "lf2", items: convoyItemsB },
    ];
    s.logistics.busyFleetIds = ["lf1", "lf2"];

    const ledger2 = createHullLedger(s, { production: PROD });
    const plan2 = planLogistics(s, supply, P, { intents: [] }, ledger2, null);

    const hullConvoys2 = plan2.intents.filter((i) => i.type === "CONVOY_DISPATCH" && i.purpose === "HULLS_TO_MOBILIZATION");
    assert.strictEqual(hullConvoys2.length, 0, "no new convoys after restart because in-transit hulls cover deficit: " + JSON.stringify(hullConvoys2));

  });

  test("logistics-distributed (Plaster 4): restart during mineral convoy - ledger preserves in-transit minerals", () => {
    const P = { production: PROD, logistics: { ...LOG_WITH_MINERALS, volumes: { mineral: 1, hulls: { cruiser: 50000, industrial: 60000 }, unitsPerM3: 100, carrierGroups: ["industrial"] } } };
    const s = snap(AMARR);
    s.production = prodOf([
      st("stM", SAMINER, {}, {}, [{ hullGroup: "cruiser", runs: 1 }], 2),
      st("stA", HOME, { [TRIT]: 100 }, {}, [], 2),
      st("stB", HOME + 1, { [TRIT]: 1000000 }, {}, [], 0),
    ]);

    const production = { intents: [] };

    const ledger1 = createHullLedger(s, { production: PROD });
    const supply = { frontTargets: [], affordable: { resourceUnits: 10000, reserveUnits: 1000 } };
    s.fleets = [
      { fleetId: "lf1", state: "IDLE", fleetRole: "logistics", systemId: HOME + 1, composition: [{ hullGroup: "industrial", count: 2 }], refitPending: false, version: 1 }
    ];
    s.logistics.carriers = { lf1: 2 };
    const plan1 = planLogistics(s, supply, P, production, ledger1, null);

    const mineralConvoys1 = plan1.intents.filter((i) => i.type === "CONVOY_DISPATCH" && i.purpose === "MINERALS_TO_FACTORY");
    assert.ok(mineralConvoys1.length >= 1, "at least one MINERALS_TO_FACTORY convoy on first round");
    const convoy1 = mineralConvoys1[0];
    assert.strictEqual(convoy1.sourceStationId, "stB");
    assert.strictEqual(convoy1.destStationId, "stA");

    const mineralItems = convoy1.items.filter((it) => it.itemKind === "mineral");
    s.logistics.open = [
      { convoyId: "cv1", state: "IN_TRANSIT", purpose: "MINERALS_TO_FACTORY", sourceStationId: "stB", destStationId: "stA", fleetId: "lf1", items: mineralItems },
    ];
    s.logistics.busyFleetIds = ["lf1"];

    const ledger2 = createHullLedger(s, { production: PROD });
    const plan2 = planLogistics(s, supply, P, { intents: [] }, ledger2, null);

    const mineralConvoys2 = plan2.intents.filter((i) => i.type === "CONVOY_DISPATCH" && i.purpose === "MINERALS_TO_FACTORY");
    assert.strictEqual(mineralConvoys2.length, 0, "no new mineral convoys after restart because in-transit covers need");
  });

  test("logistics-distributed: mineral convoy contains multiple mineral types and total volume >= mineralConvoyMinLoad", () => {
    const P = { production: PROD, logistics: { ...LOG_WITH_MINERALS, volumes: { mineral: 1, hulls: { cruiser: 50000, industrial: 60000 }, unitsPerM3: 100, carrierGroups: ["industrial"] } } };
    const s = snap(AMARR);
    const PYERITE = "type:35";
    s.production = prodOf([
      st("stM", SAMINER, {}, {}, [{ hullGroup: "cruiser", runs: 1 }], 2),
      st("stA", HOME, { [TRIT]: 100, [PYERITE]: 50 }, {}, [], 2),
      st("stB", HOME + 1, { [TRIT]: 1000000, [PYERITE]: 500000 }, {}, [], 0),
    ]);

    const production = { intents: [] };

    const ledger = createHullLedger(s, { production: PROD });
    const supply = { frontTargets: [], affordable: { resourceUnits: 10000, reserveUnits: 1000 } };
    s.fleets = [
      { fleetId: "lf1", state: "IDLE", fleetRole: "logistics", systemId: HOME + 1, composition: [{ hullGroup: "industrial", count: 2 }], refitPending: false, version: 1 }
    ];
    s.logistics.carriers = { lf1: 2 };
    const plan = planLogistics(s, supply, P, production, ledger, null);

    const mineralConvoys = plan.intents.filter((i) => i.type === "CONVOY_DISPATCH" && i.purpose === "MINERALS_TO_FACTORY");
    assert.ok(mineralConvoys.length >= 1, "at least one MINERALS_TO_FACTORY convoy");
    const convoy = mineralConvoys[0];
    assert.strictEqual(convoy.sourceStationId, "stB");
    assert.strictEqual(convoy.destStationId, "stA");
    const tritItems = convoy.items.filter((it) => it.itemKind === "mineral" && it.itemKey === TRIT);
    const pyeriteItems = convoy.items.filter((it) => it.itemKind === "mineral" && it.itemKey === PYERITE);
    assert.ok(tritItems.length >= 1, "convoy carries tritanium");
    assert.ok(pyeriteItems.length >= 1, "convoy carries pyerite");
    const totalVolume = convoy.items.reduce((sum, it) => sum + it.quantity * 1, 0);
    assert.ok(totalVolume >= 100, `total volume ${totalVolume} >= mineralConvoyMinLoad (100)`);
  });

  test("logistics-distributed: source with lines=2, activeJobs=2 has NO free lines and is NOT used as mineral source", () => {
    const P = { production: PROD, logistics: { ...LOG_WITH_MINERALS, volumes: { mineral: 1, hulls: { cruiser: 50000, industrial: 60000 }, unitsPerM3: 100, carrierGroups: ["industrial"] } } };
    const s = snap(AMARR);
    s.production = prodOf([
      st("stM", SAMINER, {}, {}, [{ hullGroup: "cruiser", runs: 1 }], 2),
      st("stA", HOME, { [TRIT]: 100 }, {}, [], 2),
      st("stB", HOME + 1, { [TRIT]: 1000000 }, {}, [{hullGroup:"cruiser",runs:1}, {hullGroup:"cruiser",runs:1}], 2),
      st("stC", HOME + 2, { [TRIT]: 1000000 }, {}, [], 0),
    ]);

    const production = { intents: [] };

    const ledger = createHullLedger(s, { production: PROD });
    const supply = { frontTargets: [], affordable: { resourceUnits: 10000, reserveUnits: 1000 } };
    s.fleets = [
      { fleetId: "lf1", state: "IDLE", fleetRole: "logistics", systemId: HOME + 2, composition: [{ hullGroup: "industrial", count: 2 }], refitPending: false, version: 1 }
    ];
    s.logistics.carriers = { lf1: 2 };
    const plan = planLogistics(s, supply, P, production, ledger, null);

    const mineralConvoys = plan.intents.filter((i) => i.type === "CONVOY_DISPATCH" && i.purpose === "MINERALS_TO_FACTORY");
    const fromB = mineralConvoys.find((c) => c.sourceStationId === "stB");
    const fromC = mineralConvoys.find((c) => c.sourceStationId === "stC");
    assert.strictEqual(fromB, undefined, "no convoy from stB because activeJobs=lines -> no free capacity");
    assert.ok(fromC, "convoy from stC (surplus, lines=0): " + JSON.stringify(mineralConvoys));
  });

  test("logistics-distributed: source with 1M tritanium but 900k reserved for own production -> effective surplus 100k", () => {
    const P = { production: PROD, logistics: { ...LOG_WITH_MINERALS, volumes: { mineral: 1, hulls: { cruiser: 50000, industrial: 60000 }, unitsPerM3: 100, carrierGroups: ["industrial"] } } };
    P.logistics.mobilizeResourcePerShip = 100;
    P.logistics.mobilizeReservePerShip = 10;
    P.mobilizeResourcePerShip = 100;
    P.mobilizeReservePerShip = 10;
    const s = snap(AMARR);
    s.production = prodOf([
      st("stM", SAMINER, {}, {}, [{ hullGroup: "cruiser", runs: 1 }], 2),
      st("stA", HOME, { [TRIT]: 100 }, {}, [], 2),
      st("stB", HOME + 1, { [TRIT]: 1000000 }, {}, [], 0),
    ]);

    const CRUISER_TRIT = RECIPES.GROUPS.cruiser.minerals[TRIT];
    const productionRuns = 1;
    const production = { intents: [
      { type: "PRODUCE", stationId: "stB", hullGroup: "cruiser", runs: productionRuns, recipesVersion: 1, slot: 0 },
    ]};

    const ledger = createHullLedger(s, { production: PROD });
    const supply = { frontTargets: [], affordable: { resourceUnits: 10000, reserveUnits: 1000 } };
    s.fleets = [
      { fleetId: "lf1", state: "IDLE", fleetRole: "logistics", systemId: HOME + 1, composition: [{ hullGroup: "industrial", count: 2 }], refitPending: false, version: 1 },
      { fleetId: "lf2", state: "IDLE", fleetRole: "logistics", systemId: HOME + 1, composition: [{ hullGroup: "industrial", count: 2 }], refitPending: false, version: 1 }
    ];
    s.logistics.carriers = { lf1: 2, lf2: 2 };
    const plan = planLogistics(s, supply, P, production, ledger, null);

    const mineralConvoys = plan.intents.filter((i) => i.type === "CONVOY_DISPATCH" && i.purpose === "MINERALS_TO_FACTORY");
    assert.ok(mineralConvoys.length >= 1, "at least one MINERALS_TO_FACTORY convoy: " + JSON.stringify(mineralConvoys));
    const convoy = mineralConvoys[0];
    assert.strictEqual(convoy.sourceStationId, "stB", "source is stB");
    const tritItems = convoy.items.filter((it) => it.itemKind === "mineral" && it.itemKey === TRIT);
    assert.ok(tritItems.length >= 1, "convoy carries tritanium");
    const expectedNeeded = CRUISER_TRIT - 100;
    assert.ok(tritItems[0].quantity <= expectedNeeded, "quantity limited by destination need");
    assert.ok(tritItems[0].quantity > 0, "positive quantity");
  });

  test("logistics-distributed: production 5, deficit 3 -> convoys total 3 (limited by deficit)", () => {
    const P = { production: PROD, logistics: { ...LOG, volumes: { mineral: 1, hulls: { cruiser: 50000, industrial: 60000 }, unitsPerM3: 100, carrierGroups: ["industrial"] } } };
    const s = snap(AMARR);
    s.production = prodOf([
      st("stM", SAMINER, {}, {}, [{ hullGroup: "cruiser", runs: 2 }], 2),
      st("stA", HOME, times("cruiser", 6), {}, [], 2),
    ]);

    const production = { intents: [
      { type: "PRODUCE", stationId: "stA", hullGroup: "cruiser", runs: 5, recipesVersion: 1, slot: 0 },
    ]};

    const ledger = createHullLedger(s, { production: PROD });
    const supply = { frontTargets: [], affordable: { resourceUnits: 10000, reserveUnits: 1000 } };
    s.fleets = [
      { fleetId: "lf1", state: "IDLE", fleetRole: "logistics", systemId: HOME, composition: [{ hullGroup: "industrial", count: 2 }], refitPending: false, version: 1 }
    ];
    s.logistics.carriers = { lf1: 2 };
    const plan = planLogistics(s, supply, P, production, ledger, null);

    const hullConvoys = plan.intents.filter((i) => i.type === "CONVOY_DISPATCH" && i.purpose === "HULLS_TO_MOBILIZATION");
    let totalConveyed = 0;
    for (const c of hullConvoys) {
      for (const it of c.items) {
        if (it.itemKind === "hull" && it.itemKey === "group:cruiser") totalConveyed += it.quantity;
      }
    }
    assert.strictEqual(totalConveyed, 3, "total conveyed hulls = M's deficit (3), not production (5): " + totalConveyed);
  });

  test("L0 TDZ: no station with lines > 0 (and an empty doctrine) -> planLogistics does not throw", () => {
    const P = { production: PROD, logistics: LOG };
    const supply = { frontTargets: [], affordable: { resourceUnits: 10000, reserveUnits: 1000 } };
    const production = { intents: [{ type: "PRODUCE", stationId: "stA", hullGroup: "cruiser", runs: 1, recipesVersion: 1,
      slot: 0 }] };
    for (const variant of ["noLines", "noDoctrine"]) {
      const s = snap(AMARR);
      s.production = prodOf([st("stA", HOME, times("cruiser", 4), {}, [], variant === "noLines" ? 0 : 2)]);
      if (variant === "noDoctrine") s.doctrine = { ...s.doctrine, templates: {} };
      const ledger = createHullLedger(s, { production: PROD });
      const plan = planLogistics(s, supply, P, production, ledger, null);
      assert.ok(Array.isArray(plan.intents) && Array.isArray(plan.notes), variant + ": " + JSON.stringify(plan));
      assert.ok(plan.cost && typeof plan.cost.resourceUnits === "number", variant + " cost");
    }
  });

  test("E3 reach of a jump freighter fleet: source 30 jumps away -> CONVOY_DISPATCH with a JF fleet "
    + "(jumpFreighterReachJumps 40), none with industrials (maxConvoyJumps 20)", () => {
    const SYS = (i) => 31000000 + i;
    const line = (id) => [id - 1, id + 1].filter((x) => x >= SYS(0) && x <= SYS(40));
    const V = { mineral: 1, hulls: { cruiser: 50000, industrial: 60000 }, unitsPerM3: 100,
      carrierGroups: ["industrial", "freighter", "jump_freighter"],
      capacityM3: { industrial: 60000, freighter: 870000, jump_freighter: 270000 } };
    const P = { production: PROD, logistics: { ...LOG, maxConvoyJumps: 20, jumpFreighterReachJumps: 40, volumes: V },
      maxBfsSystems: 2000 };
    const run = (composition) => {
      const s = snap(AMARR, { stations: [SYS(0), SYS(30)] });
      s.neighbors = line;
      s.production = prodOf([st("stM", SYS(0), {}, {}, [{ hullGroup: "cruiser", runs: 1 }], 2),
        st("stA", SYS(30), times("cruiser", 4), {}, [], 2)]);
      s.fleets = [{ fleetId: "lf1", state: "IDLE", fleetRole: "logistics", systemId: SYS(0), composition,
        refitPending: false, version: 1 }];
      s.logistics.carriers = { lf1: composition.filter((e) => V.carrierGroups.includes(e.hullGroup))
        .reduce((n, e) => n + e.count, 0) };
      const production = { intents: [{ type: "PRODUCE", stationId: "stA", hullGroup: "cruiser", runs: 3,
        recipesVersion: 1, slot: 0 }] };
      return planLogistics(s, { frontTargets: [], affordable: { resourceUnits: 10000, reserveUnits: 1000 } }, P,
        production, createHullLedger(s, { production: PROD }), null);
    };
    const jf = run([{ hullGroup: "jump_freighter", count: 1 }, { hullGroup: "frigate", count: 2 }]);
    const sent = jf.intents.filter((i) => i.type === "CONVOY_DISPATCH");
    assert.deepStrictEqual(sent.map((i) => [i.fleetId, i.sourceStationId, i.destStationId]), [["lf1", "stA", "stM"]],
      JSON.stringify(jf));
    assert.ok(jf.notes.includes("LOGISTICS_JF_REACH"), jf.notes.join());
    const ind = run([{ hullGroup: "industrial", count: 2 }, { hullGroup: "frigate", count: 2 }]);
    assert.deepStrictEqual(ind.intents.filter((i) => i.type === "CONVOY_DISPATCH"), [], JSON.stringify(ind));
    assert.ok(ind.notes.includes("LOGISTICS_MOBILIZE") || ind.notes.includes("LOGISTICS_NO_FLEET"), ind.notes.join());
  });
};