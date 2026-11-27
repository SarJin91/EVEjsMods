"use strict";

const assert = require("node:assert");
const path = require("node:path");

const { composeMiningFleet, poolRate, planIndustry, planUpgrades, recipeCost } =
  require("../../lib/strategy/ai/industry");
const { planMining } = require("../../lib/strategy/ai/mining");
const { createHullLedger } = require("../../lib/strategy/ai/hulls");
const { createMiningRates, fleetRatePermille, BOOSTER_ORDER } = require("../../lib/economy/mining/rates");
const { createRecipeTable } = require("../../lib/economy/production/recipes");
const RECIPES = require("../../lib/economy/data/hullRecipes");
const { HULL_GROUPS, INDUSTRY_HULL_GROUPS, parseHullGroupList } = require("../../lib/fleets/schema");
const config = require("../../config");
const { carrierCapacitiesM3 } = require("../../lib/economy/logistics/cargo");
const { createIndustryCatalog } = require("../../lib/economy/industry/catalog");
const { CAPITAL_CARRIER_GROUPS } = require("../../lib/economy/data/cargoVolumes");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const F = 500003;
const AT = 1760000000000;
const SYS = (i) => 30000000 + i;
const neighbors = (id) => [id - 1, id + 1].filter((x) => x >= SYS(1) && x <= SYS(12));

const DEF = config.resolveConfig({ modDir: MOD_DIR, env: {} }).config;
const rates = createMiningRates(DEF.mining);
const FREE = parseHullGroupList(DEF.production.freeHullGroups);

function industryParams(over = {}) {
  const minerOrder = HULL_GROUPS.filter((g) => rates.rateOf(g) > 0 && !BOOSTER_ORDER.includes(g) && !FREE.includes(g))
    .sort((a, b) => rates.rateOf(b) - rates.rateOf(a) || HULL_GROUPS.indexOf(a) - HULL_GROUPS.indexOf(b));
  return { industryEnabled: DEF.production.industryEnabled,
    maxIndustryJobsPerReview: DEF.production.maxIndustryJobsPerReview,
    maxActiveIndustryJobsPerFaction: DEF.production.maxActiveIndustryJobsPerFaction,
    maxUpgradesPerReview: DEF.strategy.maxUpgradesPerReview, minersPerFleetBase: DEF.mining.minersPerFleetBase,
    boosterOrder: [...BOOSTER_ORDER], boostedMiners: { porpoise: DEF.mining.boostedMinersPorpoise,
      orca: DEF.mining.boostedMinersOrca, rorqual: DEF.mining.boostedMinersRorqual },
    minerOrder, freeMiner: FREE.find((g) => rates.rateOf(g) > 0) || null,
    miningGroups: [...BOOSTER_ORDER, ...minerOrder].filter((g) => !FREE.includes(g)),
    industryGroups: INDUSTRY_HULL_GROUPS.filter((g) => !FREE.includes(g)), hullGroups: [...HULL_GROUPS],
    fleetRate: (c) => fleetRatePermille(c, rates).sum, ...over };
}

const PRODUCTION = { maxJobsPerReview: 8, maxRunsPerJob: 4, maxActiveJobsPerFaction: 8, targetStockFleets: 1,
  mobilizeHulls: "required", miningNeedsHulls: false, mobilizationStations: 1, hullGroups: [...HULL_GROUPS],
  freeHullGroups: FREE };

const table = createRecipeTable(RECIPES, { timeFactorPermille: 1000, minRunMs: 60000, maxRunMs: 172800000,
  componentWeightPermille: DEF.production.componentWeightPermille,
  componentFactorMaxPermille: DEF.production.componentFactorMaxPermille });
const recipes = Object.fromEntries(HULL_GROUPS.map((g) => [g, { minerals: table.lookup(g).minerals }]));

const miner = (fleetId, systemId, composition, extra = {}) => ({ fleetId, version: 3, state: "IDLE",
  fleetRole: "mining", systemId, homeSystemId: systemId, refitPending: false, operationId: null, composition,
  ...extra });
const station = (stationId, systemId, o = {}) => ({ stationId, systemId, kind: "npc", lines: o.lines === undefined
  ? 2 : o.lines, activeJobs: o.activeJobs || [], minerals: o.minerals || {}, hulls: o.hulls || {} });

function snap(o = {}) {
  const stations = o.stations || [station("st1", SYS(1))];
  return { factionId: F, at: AT, round: 3, faction: { status: "ACTIVE", homeSystemId: SYS(1) },
    doctrine: { templates: { mining: [{ hullGroup: "mining_frigate", count: 3 }] } }, stationsMode: "ready",
    stations: stations.map((s) => ({ stationId: s.stationId, systemId: s.systemId })), neighbors,
    systems: [], intel: [], fleets: o.fleets || [], fleetsTruncated: false, operations: [],
    production: { mode: "ready", recipesVersion: table.version, recipes, stations, inProduction: {},
      activeJobsTotal: o.activeJobsTotal || 0, truncated: false },
    mining: o.mining || { mode: "ready", sites: [], openByBelt: [], busyFleetIds: o.busy || [] } };
}
const params = (over = {}) => ({ production: PRODUCTION, industry: industryParams(over), maxBfsSystems: 2000,
  intelTtlMs: 3600000, mobilizeResourcePerShip: 10, mobilizeReservePerShip: 1 });
const ships = (list) => list.reduce((n, e) => n + e.count, 0);

module.exports = ({ test }) => {
  test("D1 composeMiningFleet: {orca 1, exhumer 4, mining_barge 10} -> orca + 4 exhumer + 6 barge; {} -> 3 "
    + "mining_frigate; no free miner -> 0 ships; the pool is not mutated", () => {
    const p = industryParams();
    const pool = Object.freeze({ orca: 1, exhumer: 4, mining_barge: 10 });
    const c = composeMiningFleet(pool, p);
    assert.deepStrictEqual(c.composition, [{ hullGroup: "mining_barge", count: 6 }, { hullGroup: "exhumer", count: 4 },
      { hullGroup: "orca", count: 1 }]);
    assert.deepStrictEqual([c.ships, c.booster, c.paid], [11, "orca", { orca: 1, exhumer: 4, mining_barge: 6 }]);
    assert.deepStrictEqual(composeMiningFleet({}, p).composition, [{ hullGroup: "mining_frigate", count: 3 }]);
    assert.strictEqual(composeMiningFleet({}, industryParams({ freeMiner: null })).ships, 0);
    const venture = [{ hullGroup: "mining_frigate", count: 3 }];
    assert.strictEqual(poolRate({}, 2, p), 2n * fleetRatePermille(venture, rates).sum);
  });

  test("D2 planIndustry: 2 Venture fleets, minerals for everything -> the first PRODUCE = argmax gain/cost "
    + "computed from poolRate and the recipes; industryEnabled=false -> nothing; the job limit -> INDUSTRY_JOB_LIMIT",
  () => {
    const minerals = {};
    for (const g of HULL_GROUPS) {
      for (const [k, v] of Object.entries(recipes[g].minerals)) minerals[k] = Math.max(minerals[k] || 0, v * 4);
    }
    const venture = [{ hullGroup: "mining_frigate", count: 3 }];
    const s = snap({ stations: [station("st1", SYS(1), { minerals })],
      fleets: [miner("m1", SYS(1), venture), miner("m2", SYS(1), venture)] });
    const P = params();
    const X = P.industry;
    let best = null;
    for (const g of X.miningGroups) {
      const gain = poolRate({ [g]: 1 }, 2, X) - poolRate({}, 2, X);
      const cost = BigInt(recipeCost(recipes[g]));
      if (gain > 0n && (best === null || gain * best.cost > best.gain * cost)) best = { g, gain, cost };
    }
    const out = planIndustry(s, P, { intents: [] }, { fleetsWanted: 2 });
    assert.ok(out.intents.length >= 1, JSON.stringify(out));
    assert.deepStrictEqual([out.intents[0].type, out.intents[0].hullGroup, out.intents[0].runs,
      out.intents[0].stationId], ["PRODUCE", best.g, 1, "st1"], JSON.stringify(out));
    assert.ok(out.intents.length <= X.maxIndustryJobsPerReview);
    assert.deepStrictEqual(planIndustry(s, params({ industryEnabled: false }), { intents: [] }, { fleetsWanted: 2 }),
      { intents: [], notes: [] });
    const busy = snap({ stations: [station("st1", SYS(1), { minerals, lines: 4,
      activeJobs: [{ hullGroup: "porpoise", runs: 1 }, { hullGroup: "mining_barge", runs: 1 }] })],
    fleets: [miner("m1", SYS(1), venture)], activeJobsTotal: 2 });
    const limited = planIndustry(busy, P, { intents: [] }, { fleetsWanted: 1 });
    assert.deepStrictEqual([limited.intents, limited.notes], [[], ["INDUSTRY_JOB_LIMIT"]]);
  });

  test("D3 planUpgrades: Venture fleet at a station with {porpoise 1, exhumer 2} -> add porpoise + 2 exhumer "
    + "a travelling fleet or one on an open trip is no candidate; maxUpgradesPerReview -> FLEET_UPGRADE_LIMIT", () => {
    const venture = [{ hullGroup: "mining_frigate", count: 3 }];
    const st = [station("st1", SYS(1), { hulls: { porpoise: 1, exhumer: 2 } })];
    const s = snap({ stations: st, fleets: [miner("m1", SYS(1), venture)] });
    const P = params();
    const ledger = createHullLedger(s, P);
    const out = planUpgrades(s, P, ledger);
    assert.deepStrictEqual(out.intents, [{ type: "FLEET_UPGRADE", slot: 0, fleetId: "m1", expectedVersion: 3,
      fleetRole: "mining", stationId: "st1", systemId: SYS(1), add: [{ hullGroup: "exhumer", count: 2 },
        { hullGroup: "porpoise", count: 1 }], remove: [] }]);
    assert.deepStrictEqual([out.fleetIds, ledger.available("st1", "exhumer"), ledger.available("st1", "porpoise")],
      [["m1"], 0, 0]);
    for (const fleets of [[miner("m1", SYS(1), venture, { state: "TRAVELLING" })], [miner("m1", SYS(1), venture)]]) {
      const t = snap({ stations: st, fleets, busy: fleets[0].state === "IDLE" ? ["m1"] : [] });
      assert.deepStrictEqual(planUpgrades(t, P, createHullLedger(t, P)).intents, []);
    }
    const two = snap({ stations: [station("st1", SYS(1), { hulls: { exhumer: 9 } })],
      fleets: [miner("m1", SYS(1), venture), miner("m2", SYS(1), venture)] });
    const lim = planUpgrades(two, params({ maxUpgradesPerReview: 1 }), createHullLedger(two, P));
    assert.deepStrictEqual([lim.fleetIds, lim.notes], [["m1"], ["FLEET_UPGRADE", "FLEET_UPGRADE_LIMIT"]]);
  });

  test("D4 fleet count: 2 ONLINE stations, 10 candidates -> fleetsWanted 3; a mobilization at a station with "
    + "{mining_barge 2} -> barge 2 + mining_frigate 1, hulls [group:mining_barge 2]", () => {
    const MP = { ...DEF.mining, fleetsPerStationPermille: 1500 };
    const P = { ...params(), mining: { ...MP, maxMobilizationsPerReview: 8 } };
    const sites = Array.from({ length: 10 }, (_v, i) => ({ systemId: SYS(i + 1), richnessPermille: 800,
      projected: true }));
    const st = [station("st1", SYS(1), { hulls: { mining_barge: 2 } }), station("st2", SYS(2))];
    const s = snap({ stations: st, mining: { mode: "ready", sites, openByBelt: [], busyFleetIds: [] } });
    const supply = { stationSystems: [SYS(1), SYS(2)], affordable: { resourceUnits: 100000, reserveUnits: 10000 } };
    const out = planMining(s, supply, P, createHullLedger(s, P));
    assert.strictEqual(out.fleetsWanted, 3);
    const mobs = out.intents.filter((i) => i.type === "MOBILIZE");
    assert.strictEqual(mobs.length, 3, JSON.stringify(out));
    const barge = mobs.find((m) => m.hulls.length > 0);
    assert.deepStrictEqual([barge.stationId, barge.composition, barge.hulls], ["st1",
      [{ hullGroup: "mining_frigate", typeId: null, count: 1 }, { hullGroup: "mining_barge", typeId: null, count: 2 }],
      [{ itemKey: "group:mining_barge", count: 2 }]], JSON.stringify(mobs));
    assert.strictEqual(barge.cost.resourceUnits, 3 * P.mobilizeResourcePerShip);
  });

  test("D5 no worse fleet: porpoise 1 + exhumer 5 at {mining_barge 5} -> nothing; legacy industrial 3 at "
    + "{mining_barge 1} -> add mining_frigate 2 + barge 1, remove industrial 3 (1170 -> 2190 m3/min), stock -1", () => {
    const P = params();
    const strong = snap({ stations: [station("st1", SYS(1), { hulls: { mining_barge: 5 } })],
      fleets: [miner("m1", SYS(1), [{ hullGroup: "exhumer", count: 5 }, { hullGroup: "porpoise", count: 1 }])] });
    assert.deepStrictEqual(planUpgrades(strong, P, createHullLedger(strong, P)).intents, []);
    const legacy = snap({ stations: [station("st1", SYS(1), { hulls: { mining_barge: 1 } })],
      fleets: [miner("m1", SYS(1), [{ hullGroup: "industrial", count: 3 }])] });
    const ledger = createHullLedger(legacy, P);
    const out = planUpgrades(legacy, P, ledger);
    assert.strictEqual(out.intents.length, 1, JSON.stringify(out));
    assert.deepStrictEqual([out.intents[0].add, out.intents[0].remove], [[{ hullGroup: "mining_frigate", count: 2 },
      { hullGroup: "mining_barge", count: 1 }], [{ hullGroup: "industrial", count: 3 }]]);
    const rate = (c) => Number(fleetRatePermille(c, rates).sum / 1000n);
    assert.deepStrictEqual([rate([{ hullGroup: "industrial", count: 3 }]), rate([{ hullGroup: "mining_frigate",
      count: 2 }, { hullGroup: "mining_barge", count: 1 }])], [1170, 2190]);
    assert.strictEqual(ledger.available("st1", "mining_barge"), 0);
  });

  const catalog = createIndustryCatalog().catalog;
  const LOGP = { maxConvoyJumps: 20, volumes: { capacityM3: carrierCapacitiesM3(DEF.logistics, catalog),
    capitalCarrierGroups: CAPITAL_CARRIER_GROUPS } };
  const TRANSPORT = { freighterTargetPerFaction: 1, jumpFreighterTargetPerFaction: 1 };
  const withLogistics = (s, busy = []) => ({ ...s, logistics: { mode: "ready", open: [], busyFleetIds: busy,
    carriers: {}, truncated: false } });
  const hauler = (fleetId, systemId, composition) => ({ ...miner(fleetId, systemId, composition),
    fleetRole: "logistics" });
  const IND2 = [{ hullGroup: "industrial", count: 2 }, { hullGroup: "frigate", count: 2 }];

  test("E2 planUpgrades logistics: industrial 2 + frigate 2 at {freighter 1} -> add freighter 1, remove "
    + "industrial 2, ledger -1; only {jump_freighter 1} -> jump_freighter; a fleet with a freighter or on a convoy is "
    + "no candidate", () => {
    const P = { ...params(), logistics: LOGP };
    const s = withLogistics(snap({ stations: [station("st1", SYS(1), { hulls: { freighter: 1 } })],
      fleets: [hauler("l1", SYS(1), IND2)] }));
    const ledger = createHullLedger(s, P);
    const out = planUpgrades(s, P, ledger);
    assert.deepStrictEqual(out.intents, [{ type: "FLEET_UPGRADE", slot: 0, fleetId: "l1", expectedVersion: 3,
      fleetRole: "logistics", stationId: "st1", systemId: SYS(1), add: [{ hullGroup: "freighter", count: 1 }],
      remove: [{ hullGroup: "industrial", count: 2 }] }]);
    assert.deepStrictEqual([out.notes, ledger.available("st1", "freighter")], [["FLEET_UPGRADE_LOGISTICS"], 0]);
    const jf = withLogistics(snap({ stations: [station("st1", SYS(1), { hulls: { jump_freighter: 1 } })],
      fleets: [hauler("l1", SYS(1), IND2)] }));
    assert.deepStrictEqual(planUpgrades(jf, P, createHullLedger(jf, P)).intents[0].add,
      [{ hullGroup: "jump_freighter", count: 1 }]);
    const st = [station("st1", SYS(1), { hulls: { freighter: 2 } })];
    for (const t of [withLogistics(snap({ stations: st, fleets: [hauler("l1", SYS(1),
      [{ hullGroup: "freighter", count: 1 }, { hullGroup: "industrial", count: 1 }])] })),
    withLogistics(snap({ stations: st, fleets: [hauler("l1", SYS(1), IND2)] }), ["l1"]),
    { ...withLogistics(snap({ stations: st, fleets: [hauler("l1", SYS(1), IND2)] })), logistics: { mode: "ready",
      open: [], busyFleetIds: [], carriers: {}, truncated: true } }]) {
      assert.deepStrictEqual(planUpgrades(t, P, createHullLedger(t, P)).intents, []);
    }
  });

  test("E4 planIndustry transport: no freighter + minerals for one -> the first PRODUCE = freighter; a "
    + "freighter in stock -> jump_freighter; params.logistics null -> no transport job", () => {
    const minerals = {};
    for (const g of ["freighter", "jump_freighter"]) {
      for (const [k, v] of Object.entries(recipes[g].minerals)) minerals[k] = Math.max(minerals[k] || 0, v);
    }
    const P = { ...params({ transport: TRANSPORT }), logistics: LOGP };
    const s = snap({ stations: [station("st1", SYS(1), { minerals })] });
    const out = planIndustry(s, P, { intents: [] }, { fleetsWanted: 0 });
    assert.deepStrictEqual([out.intents.map((i) => [i.type, i.hullGroup, i.runs, i.stationId]), out.notes],
      [[["PRODUCE", "freighter", 1, "st1"]], ["INDUSTRY_TRANSPORT:freighter"]], JSON.stringify(out));
    const stocked = snap({ stations: [station("st1", SYS(1), { minerals, hulls: { freighter: 1 } })] });
    assert.deepStrictEqual(planIndustry(stocked, P, { intents: [] }, { fleetsWanted: 0 }).intents
      .map((i) => i.hullGroup), ["jump_freighter"]);
    assert.deepStrictEqual(planIndustry(s, { ...P, logistics: null }, { intents: [] }, { fleetsWanted: 0 }),
      { intents: [], notes: [] });
    const poor = snap({ fleets: [miner("m1", SYS(1), [{ hullGroup: "mining_frigate", count: 3 }])] });
    const blocked = planIndustry(poor, params(), { intents: [] }, { fleetsWanted: 1 }).notes;
    assert.strictEqual(blocked.filter((n) => n.startsWith("INDUSTRY_NO_MINERALS:")).length, 1, blocked.join());
    const MP = { ...DEF.mining, maxMobilizationsPerReview: 8 };
    const noTpl = { ...snap({ stations: [station("st1", SYS(1), { hulls: { mining_barge: 2 } })],
      mining: { mode: "ready", sites: [{ systemId: SYS(1), richnessPermille: 800, projected: true }], openByBelt: [],
        busyFleetIds: [] } }), doctrine: { templates: { mining: [] } } };
    const mined = planMining(noTpl, { stationSystems: [SYS(1)], affordable: { resourceUnits: 100000,
      reserveUnits: 10000 } }, { ...params(), mining: MP }, createHullLedger(noTpl, params()));
    assert.deepStrictEqual([mined.intents.filter((i) => i.type === "MOBILIZE"), mined.notes.includes(
      "MINING_NO_TEMPLATE")], [[], true], JSON.stringify(mined.notes));
  });
};
