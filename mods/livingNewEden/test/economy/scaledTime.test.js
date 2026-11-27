"use strict";

const assert = require("node:assert");
const path = require("node:path");

const config = require("../../config");
const RECIPES = require("../../lib/economy/data/hullRecipes");
const CAPITAL = require("../../lib/economy/data/capitalRecipes");
const { createRecipeTable, recipeParamsOf } = require("../../lib/economy/production/recipes");
const { createIndustryCatalog } = require("../../lib/economy/industry/catalog");
const { HULL_GROUPS } = require("../../lib/fleets/schema");

const MOD_DIR = path.join(path.sep, "repo", "mods", "livingNewEden");
const resolve = (env) => config.resolveConfig({ modDir: MOD_DIR, env });
const DEFAULTS = resolve({}).config;
const P = DEFAULTS.production;
const CATALOG = createIndustryCatalog().catalog;

const OLD_PARAMS = Object.freeze({ timeFactorPermille: P.timeFactorPermille, minRunMs: P.minRunMs,
  maxRunMs: P.maxRunMs, componentWeightPermille: P.componentWeightPermille,
  componentFactorMaxPermille: P.componentFactorMaxPermille });
const SCALED = Object.freeze({ ...OLD_PARAMS, scaledTimeEnabled: true, titanRunMs: 28800000,
  scaledTimeReferenceSec: 9000000 });

function withCapitalTime(timeSec) {
  return { HEADER: RECIPES.HEADER, GROUPS: { ...RECIPES.GROUPS, capital: { ...RECIPES.GROUPS.capital, timeSec } } };
}

module.exports = ({ test }) => {
  test("ST1 scaled time off: runMs of every hull group = formula (keys absent, false, junk ignored)", () => {
    const timeSecOf = (g) => (RECIPES.GROUPS[g] ? RECIPES.GROUPS[g].timeSec
      : CAPITAL.GROUPS[g] ? CAPITAL.GROUPS[g].timeSec : CATALOG.hull(g).timeSec);
    const legacy = createRecipeTable(RECIPES, OLD_PARAMS, CATALOG);
    const viaConfig = createRecipeTable(RECIPES, recipeParamsOf(P), CATALOG);
    const offJunk = createRecipeTable(RECIPES, { ...OLD_PARAMS, scaledTimeEnabled: false, titanRunMs: 0,
      scaledTimeReferenceSec: -1 }, CATALOG);
    assert.strictEqual(P.scaledTimeEnabled, false);
    for (const g of HULL_GROUPS) {
      const raw = Math.floor((timeSecOf(g) * 1000 * P.timeFactorPermille) / 1000);
      const expected = Math.min(P.maxRunMs, Math.max(P.minRunMs, raw));
      assert.strictEqual(legacy.lookup(g).runMs, expected, g);
      assert.strictEqual(viaConfig.lookup(g).runMs, expected, `${g} recipeParamsOf`);
      assert.strictEqual(offJunk.lookup(g).runMs, expected, `${g} false`);
    }
  });

  test("ST2 scaled time on: titan row 8 h, battleship floor, logistics 768 000, Orca 4 800 000", () => {
    const table = createRecipeTable(withCapitalTime(9000000), SCALED, CATALOG);
    assert.strictEqual(table.lookup("capital").runMs, 28800000, "reference row = titanRunMs");
    assert.strictEqual(RECIPES.GROUPS.battleship.timeSec, 18000);
    assert.strictEqual(table.lookup("battleship").runMs, 60000, "57 600 -> minRunMs");
    assert.strictEqual(RECIPES.GROUPS.logistics.timeSec, 240000);
    assert.strictEqual(table.lookup("logistics").runMs, 768000);
    assert.strictEqual(CATALOG.hull("orca").timeSec, 1500000);
    assert.strictEqual(table.lookup("orca").runMs, 4800000);
    const viaConfig = createRecipeTable(withCapitalTime(9000000),
      recipeParamsOf({ ...P, scaledTimeEnabled: true }), CATALOG);
    assert.strictEqual(viaConfig.lookup("logistics").runMs, 768000, "recipeParamsOf carries the 3 keys");
    const above = createRecipeTable(withCapitalTime(18000000), { ...SCALED, maxRunMs: 60000 }, CATALOG);
    assert.strictEqual(above.lookup("capital").runMs, 28800000);
  });

  test("ST3 scaled time: overflow and bad params -> TypeError", () => {
    assert.throws(() => createRecipeTable(withCapitalTime(1e12), SCALED, CATALOG),
      (err) => err instanceof TypeError && err.message === "recipes: scaled time overflow capital");
    for (const bad of [{ titanRunMs: 0 }, { scaledTimeReferenceSec: 0 }, { titanRunMs: undefined },
      { titanRunMs: 59999 }]) {
      assert.throws(() => createRecipeTable(RECIPES, { ...SCALED, ...bad }, CATALOG), TypeError, JSON.stringify(bad));
    }
  });

  test("ST4 config: defaults, env, ranges clamped, warning titanRunMs < minRunMs with the flag on", () => {
    assert.deepStrictEqual([P.scaledTimeEnabled, P.titanRunMs, P.scaledTimeReferenceSec], [false, 28800000, 9000000]);
    assert.deepStrictEqual(resolve({}).warnings, []);
    const on = resolve({ EVEJS_LNE_PRODUCTION_SCALED_TIME_ENABLED: "1" });
    assert.strictEqual(on.config.production.scaledTimeEnabled, true);
    assert.deepStrictEqual(on.warnings, []);
    const low = resolve({ EVEJS_LNE_PRODUCTION_TITAN_RUN_MS: "1", EVEJS_LNE_PRODUCTION_SCALED_TIME_REFERENCE_SEC: "0" });
    assert.deepStrictEqual([low.config.production.titanRunMs, low.config.production.scaledTimeReferenceSec], [60000, 1]);
    const high = resolve({ EVEJS_LNE_PRODUCTION_TITAN_RUN_MS: "999999999999",
      EVEJS_LNE_PRODUCTION_SCALED_TIME_REFERENCE_SEC: "999999999999" });
    assert.deepStrictEqual([high.config.production.titanRunMs, high.config.production.scaledTimeReferenceSec],
      [604800000, 100000000]);
    const env = { EVEJS_LNE_PRODUCTION_TITAN_RUN_MS: "60000", EVEJS_LNE_PRODUCTION_MIN_RUN_MS: "120000" };
    const has = (r) => r.warnings.some((w) => w.includes("production.titanRunMs=60000 below production.minRunMs=120000"));
    assert.strictEqual(has(resolve(env)), false, "flag off = no warning");
    assert.strictEqual(has(resolve({ ...env, EVEJS_LNE_PRODUCTION_SCALED_TIME_ENABLED: "1" })), true);
  });

  test("ST5: reference = generated titan timeSec (titan row 8 h), floor of a remainder "
    + "titanRunMs == minRunMs accepted (every group at 60 000)", () => {
    assert.strictEqual(P.scaledTimeReferenceSec, CAPITAL.GROUPS.titan.timeSec, "titan time is the reference");
    assert.strictEqual(createRecipeTable(RECIPES, SCALED, CATALOG).lookup("titan").runMs, 28800000);
    const remainder = createRecipeTable(withCapitalTime(18753), SCALED, CATALOG);
    assert.strictEqual(remainder.lookup("capital").runMs, 60009);
    const equal = createRecipeTable(RECIPES, { ...SCALED, titanRunMs: P.minRunMs }, CATALOG);
    assert.strictEqual(P.minRunMs, 60000);
    for (const g of HULL_GROUPS) assert.strictEqual(equal.lookup(g).runMs, 60000, g);
  });
};
