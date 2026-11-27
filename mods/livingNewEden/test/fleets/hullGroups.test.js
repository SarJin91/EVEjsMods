"use strict";

const assert = require("node:assert");
const path = require("node:path");

const config = require("../../config");
const { HULL_GROUPS, HULL_GROUPS_V1, INDUSTRY_HULL_GROUPS, CAPITAL_HULL_GROUPS,
  parseHullGroupList } = require("../../lib/fleets/schema");
const SALVAGE = require("../../lib/events/salvage/data");
const { HULL_CLASS_BY_GROUP } = require("../../lib/adapter/data/liveProfiles");
const { EXCLUDED_HULL_GROUPS } = require("../../lib/strategy/expeditions/data/expeditionRules");
const { HULL_VALUE_FACTOR_PERMILLE } = require("../../lib/economy/data/mineralRefPrices");
const { REGISTRY_DATA_V1 } = require("../../lib/strategy/registry");
const { HULL_TRAVEL } = require("../../lib/fleets/data/travelProfiles");
const { HULL_VOLUMES } = require("../../lib/economy/data/cargoVolumes");
const { unitVolume } = require("../../lib/economy/logistics/cargo");
const { WRECK_YIELD } = require("../../lib/world/data/wreckYield");
const { GROUPS: STRENGTH_GROUPS } = require("../../lib/battle/data/strengthCatalog");
const { STRENGTH_ALIASES } = require("../../lib/battle/data/strengthAliases");
const { createStrengthCatalog, expandStrengthGroups } = require("../../lib/battle/strength");
const RECIPES = require("../../lib/economy/data/hullRecipes");
const { createRecipeTable } = require("../../lib/economy/production/recipes");
const { createIndustryCatalog } = require("../../lib/economy/industry/catalog");
const { INDUSTRY_HULL_CLASSES } = require("../../lib/economy/industry/classes");
const { HULL_TAKE_ROWS, MAX_GROUPS_PER_TAKE } = require("../../lib/strategy/reviewRows");
const { hullTargets } = require("../../lib/strategy/ai/production");
const { createHullLedger } = require("../../lib/strategy/ai/hulls");
const { createProductionService } = require("../../lib/economy/production/productionService");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const DEFAULTS = config.resolveConfig({ modDir: MOD_DIR, env: {} }).config;
const STRENGTH_PARAMS = Object.freeze({ groupConfidence: 0.9, unknownTypeConfidence: 0.6 });
const HULK_TYPE_ID = 22544;

const sorted = (list) => [...list].sort();
const sumOf = (minerals) => Object.values(minerals).reduce((a, b) => a + b, 0);
const recipeParams = (P, extra = {}) => ({ timeFactorPermille: P.timeFactorPermille, minRunMs: P.minRunMs,
  maxRunMs: P.maxRunMs, componentWeightPermille: P.componentWeightPermille,
  componentFactorMaxPermille: P.componentFactorMaxPermille, ...extra });

module.exports = ({ test }) => {
  const industryMade = createIndustryCatalog();
  assert.ok(industryMade.ok, JSON.stringify(industryMade));
  const industry = industryMade.catalog;

  test("B1 coverage: HULL_GROUPS = V1 ++ INDUSTRY ++ CAPITAL (23), every per-group table covers exactly "
    + "HULL_GROUPS, HULL_TAKE_ROWS, travel rows = industry catalogue", () => {
    assert.deepStrictEqual([...HULL_GROUPS], [...HULL_GROUPS_V1, ...INDUSTRY_HULL_GROUPS, ...CAPITAL_HULL_GROUPS]);
    assert.strictEqual(HULL_GROUPS.length, 23);
    assert.strictEqual(new Set(HULL_GROUPS).size, 23);
    assert.deepStrictEqual(INDUSTRY_HULL_CLASSES.filter((c) => !HULL_GROUPS.includes(c)), []);
    assert.deepStrictEqual(INDUSTRY_HULL_CLASSES.filter((c) => c !== "industrial"), [...INDUSTRY_HULL_GROUPS]);
    const want = sorted(HULL_GROUPS);
    const table = createRecipeTable(RECIPES, recipeParams(DEFAULTS.production), industry);
    const tables = { HULL_TRAVEL: Object.keys(HULL_TRAVEL), HULL_VOLUMES: Object.keys(HULL_VOLUMES),
      WRECK_YIELD: Object.keys(WRECK_YIELD), recipes: table.groups,
      expandStrengthGroups: Object.keys(expandStrengthGroups(STRENGTH_GROUPS)),
      strengthCoverage: [...Object.keys(STRENGTH_GROUPS), ...Object.keys(STRENGTH_ALIASES)],
      HULL_SIZE: Object.keys(SALVAGE.HULL_SIZE), HULL_CLASS: Object.keys(SALVAGE.HULL_CLASS),
      LOOT_SOURCE_BAND: Object.keys(SALVAGE.LOOT_SOURCE_BAND) };
    for (const [name, keys] of Object.entries(tables)) assert.deepStrictEqual(sorted(keys), want, name);
    for (const cls of CAPITAL_HULL_GROUPS) {
      assert.deepStrictEqual(HULL_TRAVEL[cls], HULL_TRAVEL.capital, `${cls} travel`);
      assert.strictEqual(HULL_VOLUMES[cls], null, `${cls} cargo`);
      assert.deepStrictEqual(WRECK_YIELD[cls], WRECK_YIELD.capital, `${cls} wreck yield`);
      assert.strictEqual(SALVAGE.HULL_SIZE[cls], SALVAGE.HULL_SIZE.capital, `${cls} size`);
      assert.strictEqual(SALVAGE.LOOT_SOURCE_BAND[cls], "battleship", `${cls} loot band`);
      assert.strictEqual(HULL_CLASS_BY_GROUP[cls], undefined, `${cls} no live proxy`);
      assert.ok(EXCLUDED_HULL_GROUPS.includes(cls), `${cls} no wormhole expedition`);
      assert.ok(Number.isSafeInteger(HULL_VALUE_FACTOR_PERMILLE[cls]), `${cls} value factor`);
      assert.strictEqual(STRENGTH_ALIASES[cls], "capital", `${cls} strength alias`);
    }
    assert.strictEqual(HULL_TAKE_ROWS, MAX_GROUPS_PER_TAKE + 2);
    assert.strictEqual(HULL_TAKE_ROWS, 20);
    const maxTemplateGroups = Math.max(...REGISTRY_DATA_V1.doctrines.flatMap((d) => Object.values(d.templates)
      .map((entries) => new Set(entries.map((e) => e.hullGroup)).size)));
    assert.ok(MAX_GROUPS_PER_TAKE >= maxTemplateGroups + 1, `max template groups ${maxTemplateGroups}`);
    for (const g of HULL_GROUPS) {
      assert.strictEqual(unitVolume(`hull/group:${g}`), HULL_VOLUMES[g], `${g} cargo volume`);
    }
    const TRAVEL_OVERRIDES = ["jump_freighter"];
    for (const g of INDUSTRY_HULL_GROUPS.filter((x) => !TRAVEL_OVERRIDES.includes(x))) {
      const t = industry.hull(g).travel;
      const row = HULL_TRAVEL[g];
      assert.strictEqual(row.warpSpeedAu, t.warpSpeedAu, `${g} warp`);
      assert.ok(Math.abs(row.alignSeconds - t.alignSeconds) <= 1, `${g} align ${row.alignSeconds} vs ${t.alignSeconds}`);
      assert.strictEqual(row.maxVelocityMs, t.maxVelocityMs, `${g} velocity`);
    }
  });

  test("B2 strength alias: exhumer = industrial group row, Hulk type row, alias over a catalogue group "
    + "refused", () => {
    const made = createStrengthCatalog(undefined, STRENGTH_PARAMS);
    assert.ok(made.ok, JSON.stringify(made));
    const { catalog } = made;
    assert.strictEqual(catalog.lookup("exhumer", null), catalog.lookup("industrial", null));
    const hulk = catalog.lookup("exhumer", HULK_TYPE_ID);
    assert.deepStrictEqual([hulk.source, hulk.confidence, hulk.note], ["type", 1, null]);
    const bad = createStrengthCatalog(undefined, STRENGTH_PARAMS, { ...STRENGTH_ALIASES, frigate: "industrial" });
    assert.strictEqual(bad.reason, "STRENGTH_CATALOG_INVALID", JSON.stringify(bad));
    const expanded = expandStrengthGroups(STRENGTH_GROUPS);
    assert.strictEqual(expanded.orca, STRENGTH_GROUPS.industrial);
    assert.ok(Object.isFrozen(expanded));
  });

  test("B3 industry recipes: exhumer >= barge, version 2, weight 0 = catalogue minerals, Orca at the "
    + "ceiling, V1 groups unchanged", () => {
    const P = DEFAULTS.production;
    assert.deepStrictEqual([P.componentWeightPermille, P.componentFactorMaxPermille], [1000, 4000]);
    const table = createRecipeTable(RECIPES, recipeParams(P), industry);
    assert.strictEqual(table.version, 2);
    assert.ok(sumOf(table.lookup("exhumer").minerals) >= sumOf(table.lookup("mining_barge").minerals));
    assert.strictEqual(table.factorOf("orca"), 4000, "ceiling");
    assert.strictEqual(table.factorOf("exhumer"), industry.hull("exhumer").componentFactorPermille);
    for (const g of HULL_GROUPS_V1) {
      assert.deepStrictEqual(table.lookup(g).minerals, RECIPES.GROUPS[g].minerals, g);
      assert.strictEqual(table.factorOf(g), 1000, g);
    }
    const plain = createRecipeTable(RECIPES, recipeParams(P, { componentWeightPermille: 0 }), industry);
    for (const g of INDUSTRY_HULL_GROUPS) {
      const raw = Object.fromEntries(Object.entries(industry.hull(g).minerals).filter(([, v]) => v > 0));
      assert.deepStrictEqual({ ...plain.lookup(g).minerals }, raw, g);
      assert.strictEqual(plain.factorOf(g), 1000, g);
    }
  });

  test("B4 free hull groups: parse + config check, hullTargets skips them, ledger takes only paid groups "
    + "startJob FREE_HULL_GROUP", () => {
    assert.strictEqual(parseHullGroupList("mining_frigate,foo"), null);
    assert.strictEqual(parseHullGroupList("frigate,frigate"), null);
    assert.deepStrictEqual(parseHullGroupList("none"), []);
    assert.deepStrictEqual(parseHullGroupList(" mining_frigate , industrial "), ["mining_frigate", "industrial"]);
    assert.strictEqual(DEFAULTS.production.freeHullGroups, "mining_frigate,industrial");
    const bad = config.resolveConfig({ modDir: MOD_DIR, env: {
      EVEJS_LNE_PRODUCTION_FREE_HULL_GROUPS: "mining_frigate,foo" } });
    assert.strictEqual(bad.config.production.freeHullGroups, "mining_frigate,industrial");
    assert.ok(bad.warnings.some((w) => w.includes("EVEJS_LNE_PRODUCTION_FREE_HULL_GROUPS") && w.includes("ignored")),
      bad.warnings.join("\n"));

    const free = parseHullGroupList(DEFAULTS.production.freeHullGroups);
    const doctrine = { templates: { invasion: [{ hullGroup: "industrial", count: 2 }, { hullGroup: "frigate",
      count: 3 }] } };
    const targetParams = { targetStockFleets: 1, miningNeedsHulls: false, hullGroups: HULL_GROUPS };
    assert.deepStrictEqual(hullTargets(doctrine, { ...targetParams, freeHullGroups: free }), { frigate: 3 });
    assert.deepStrictEqual(hullTargets(doctrine, targetParams), { industrial: 2, frigate: 3 }, "no free groups");

    const snapshot = { production: { mode: "ready", stations: [{ stationId: "st-a", hulls: { frigate: 5 } }] } };
    const ledger = createHullLedger(snapshot, { production: { mobilizeHulls: "required", freeHullGroups: free } });
    const picked = ledger.pick([{ hullGroup: "industrial", count: 2 }, { hullGroup: "frigate", count: 2 }],
      [{ stationId: "st-a", systemId: 1 }]);
    assert.deepStrictEqual(picked, { stationId: "st-a", systemId: 1, hulls: [{ itemKey: "group:frigate", count: 2 }] });
    assert.deepStrictEqual(ledger.pick([{ hullGroup: "industrial", count: 2 }], [{ stationId: "st-b", systemId: 2 }]),
      { stationId: "st-b", systemId: 2, hulls: [] }, "free-only template");

    const recipes = createRecipeTable(RECIPES, recipeParams(DEFAULTS.production), industry);
    const service = createProductionService({ store: {}, scheduler: {}, recipes, config: DEFAULTS,
      jobs: { jobIdOfKey: () => ({ ok: true, duplicate: false }) }, clock: { now: () => 0 }, ids: { next: () => "x" } });
    const r = service.startJobInTx({ inTransaction: true }, { factionId: 500003, stationId: "st-a",
      hullGroup: "mining_frigate", runs: 1, at: 1 }, "test:b4");
    assert.deepStrictEqual(r, { ok: false, reason: "FREE_HULL_GROUP" });
  });
};
