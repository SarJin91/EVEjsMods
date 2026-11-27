"use strict";

const assert = require("node:assert");

const { buildRecipes, RECIPE_METHOD } = require("../../tools/production/buildRecipes");
const RECIPES = require("../../lib/economy/data/hullRecipes");
const { createRecipeTable } = require("../../lib/economy/production/recipes");
const { hullDeltas } = require("../../lib/stations/stockKeys");
const { MINERALS, MINERAL_YIELD_VERSION } = require("../../lib/economy/data/mineralYield");
const { HULL_GROUPS_V1 } = require("../../lib/fleets/schema");
const { HEADER: STRENGTH_HEADER } = require("../../lib/battle/data/strengthCatalog");
const { ROWS_PER_START } = require("../../lib/economy/schema");
const { PRODUCTION_START_ROWS } = require("../../lib/strategy/reviewRows");

const bp = (blueprintTypeId, timeSec, materials, productQuantity = 1) => ({ blueprintTypeId, timeSec,
  materials: materials.map(([typeId, quantity]) => ({ typeId, quantity })), productQuantity });

module.exports = ({ test }) => {
  test("PR1 recipes: builder (T2 = T1 + component, skipped leaf, cycle, lower median, tie), generated file "
    + "table clamp + bill, hullDeltas, mineralYield v2", () => {
    const blueprints = new Map([
      [101, bp(1101, 600, [[34, 100]])],
      [102, bp(1102, 9000, [[101, 1], [900, 3], [16634, 5]])],
      [900, bp(1900, 60, [[35, 10]], 2)],
      [103, bp(1103, 700, [[34, 200]])],
      [104, bp(1104, 800, [[34, 150], [36, 50]])],
      [105, bp(1105, 900, [[905, 1], [34, 1]])],
      [905, bp(1905, 1, [[906, 1]])],
      [906, bp(1906, 1, [[905, 1]])],
    ]);
    const types = [101, 102, 103, 104, 105].map((typeId) => ({ typeId, groupId: 25, published: true }));
    const method = { ...RECIPE_METHOD, hullGroups: ["frigate"], sourceGroups: { frigate: [25] } };
    const r = buildRecipes({ sde: { buildNumber: 1, releaseDate: "x" }, types, blueprints }, method);
    assert.ok(r.ok, JSON.stringify(r));
    const g = r.groups.frigate;
    assert.deepStrictEqual([g.sampleSize, g.representativeTypeId, g.mineralSum, g.timeSec], [5, 102, 120, 9000],
      "lower median of 5 = the 3rd, own blueprint time");
    assert.deepStrictEqual(g.minerals, { "type:34": 100, "type:35": 20 });
    assert.strictEqual(r.header.ignoredMaterialTypes, 2, "moon material + the cycle part");
    const again = buildRecipes({ sde: { buildNumber: 1, releaseDate: "x" }, types, blueprints }, method);
    assert.strictEqual(again.source, r.source, "deterministic");
    const even = buildRecipes({ sde: { buildNumber: 1, releaseDate: "x" }, types: types.slice(1), blueprints },
      method);
    assert.strictEqual(even.groups.frigate.representativeTypeId, 102, "lower median of 4: (120, 200, 200(103), ...)");

    assert.deepStrictEqual(Object.keys(RECIPES.GROUPS).sort(), [...HULL_GROUPS_V1].sort());
    assert.strictEqual(RECIPES.HEADER.sdeBuild, STRENGTH_HEADER.sdeBuild);
    for (const [name, row] of Object.entries(RECIPES.GROUPS)) {
      assert.ok(Number.isSafeInteger(row.timeSec) && row.timeSec > 0, name);
      for (const [k, v] of Object.entries(row.minerals)) {
        assert.ok(Object.prototype.hasOwnProperty.call(MINERALS, k.slice("type:".length)), `${name} ${k}`);
        assert.ok(Number.isSafeInteger(v) && v > 0, `${name} ${k}`);
      }
    }
    assert.ok(Object.isFrozen(RECIPES.GROUPS.frigate.minerals));

    const table = createRecipeTable(RECIPES, { timeFactorPermille: 500, minRunMs: 60000, maxRunMs: 172800000,
      componentWeightPermille: 1000, componentFactorMaxPermille: 4000 });
    assert.strictEqual(table.lookup("frigate").runMs, RECIPES.GROUPS.frigate.timeSec * 500);
    assert.strictEqual(table.lookup("capital").runMs, 172800000, "ceiling");
    const fast = createRecipeTable(RECIPES, { timeFactorPermille: 1, minRunMs: 60000, maxRunMs: 172800000,
      componentWeightPermille: 1000, componentFactorMaxPermille: 4000 });
    assert.strictEqual(fast.lookup("frigate").runMs, 60000, "floor");
    assert.deepStrictEqual(table.billFor("cruiser", 3)["type:34"], 3 * RECIPES.GROUPS.cruiser.minerals["type:34"]);
    assert.strictEqual(table.billFor("cruiser", 0), null);
    assert.strictEqual(table.lookup("shuttle"), null);
    assert.throws(() => createRecipeTable({ HEADER: { recipesVersion: 1 },
      GROUPS: { frigate: RECIPES.GROUPS.frigate } },
      { timeFactorPermille: 1000, minRunMs: 1, maxRunMs: 2 }), TypeError);
    assert.strictEqual(PRODUCTION_START_ROWS, ROWS_PER_START, "reviewRows literal = economy/schema");

    assert.deepStrictEqual(hullDeltas([{ hullGroup: "cruiser", count: 2 }, { hullGroup: "frigate", count: 1 },
      { hullGroup: "cruiser", count: 3 }], -1), { ok: true, deltas: [
      { itemKind: "hull", itemKey: "group:cruiser", delta: -5 }, { itemKind: "hull", itemKey: "group:frigate",
        delta: -1 }] });
    assert.strictEqual(hullDeltas([{ hullGroup: "shuttle", count: 1 }], 1).reason, "INVALID_COMPOSITION");
    assert.strictEqual(hullDeltas([{ hullGroup: "frigate", count: 1 }], 2).reason, "INVALID_COMPOSITION");

    assert.strictEqual(MINERAL_YIELD_VERSION, 3);
  });
};
