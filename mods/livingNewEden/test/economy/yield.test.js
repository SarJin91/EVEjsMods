"use strict";

const assert = require("node:assert");
const path = require("node:path");

const config = require("../../config");
const { richnessOf, computeLoad, scaleBands, mineralFactors, scaleCargo, cargoUnits } =
  require("../../lib/economy/mining/yield");
const HULL_RECIPES = require("../../lib/economy/data/hullRecipes");
const { createMiningRates, fleetRatePermille } = require("../../lib/economy/mining/rates");
const { createIndustryCatalog } = require("../../lib/economy/industry/catalog");
const { YIELD_SEC_CLASSES } = require("../../lib/economy/schema");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const DEFAULTS = config.resolveConfig({ modDir: MOD_DIR, env: {} }).config;
const PARAMS = Object.freeze({ bandFactorPermille: { highsec: 500, lowsec: 750, nullsec: 1000 }, beltCap: 20,
  anomalySitesPerSystem: 2, siteSaturation: 6, refineYieldPermille: 720 });
const SHIFT_2H = 7200000;

const g = (hullGroup, count) => ({ hullGroup, count });

module.exports = ({ test }) => {
  test("M1 yield: richness per band + wormhole 0, beltCap / siteSaturation, scaleCargo floor + clamp", () => {
    assert.deepStrictEqual(richnessOf({ secClass: "nullsec", belts: 4 }, PARAMS),
      { richnessPermille: 1000, secClass: "nullsec", belts: 4 });
    assert.strictEqual(richnessOf({ secClass: "lowsec", belts: 4 }, PARAMS).richnessPermille, 750);
    assert.strictEqual(richnessOf({ secClass: "highsec", belts: 1 }, PARAMS).richnessPermille, 250, "(1+2)/6 x 500");
    assert.strictEqual(richnessOf({ secClass: "highsec", belts: 0 }, PARAMS).richnessPermille, 166, "2/6 floor");
    assert.strictEqual(richnessOf({ secClass: "wormhole", belts: 9 }, PARAMS).richnessPermille, 0);
    assert.strictEqual(richnessOf({ secClass: "other", belts: 9 }, PARAMS).richnessPermille, 0);
    const capped = { ...PARAMS, beltCap: 1, siteSaturation: 12, anomalySitesPerSystem: 0 };
    assert.strictEqual(richnessOf({ secClass: "nullsec", belts: 100 }, capped).richnessPermille, 83);
    const strong = { ...PARAMS, bandFactorPermille: { ...PARAMS.bandFactorPermille, nullsec: 2000 } };
    assert.strictEqual(richnessOf({ secClass: "nullsec", belts: 9 }, strong).richnessPermille, 1000);

    assert.deepStrictEqual(scaleCargo({ "type:34": 10, "type:35": 3 }, 3, 2),
      { deliver: { "type:34": 6, "type:35": 2 }, lostUnits: 5 });
    assert.deepStrictEqual(scaleCargo({ "type:34": 10 }, 3, 5), { deliver: { "type:34": 10 }, lostUnits: 0 },
      "ratio above 1 clamped");
    assert.deepStrictEqual(scaleCargo({ "type:34": 10 }, 3, 0), { deliver: {}, lostUnits: 10 });
  });

  const made = createIndustryCatalog();
  const rates = createMiningRates(DEFAULTS.mining);
  const bands = made.ok ? Object.fromEntries(YIELD_SEC_CLASSES.map((c) => [c,
    made.catalog.oreBand(c).mineralsPerMillionM3])) : {};

  test("Y1 3 x mining_frigate, richness 1000, 2 h, nullsec -> 140 400 m3, minerals from the catalogue band "
    + "wormhole -> 0", () => {
    assert.ok(made.ok, JSON.stringify(made));
    const load = computeLoad({ composition: [g("mining_frigate", 3)], shiftMs: SHIFT_2H, richnessPermille: 1000,
      secClass: "nullsec" }, PARAMS, rates, bands);
    assert.strictEqual(load.oreM3, 140400);
    const band = made.catalog.oreBand("nullsec").mineralsPerMillionM3;
    const want = {};
    for (const k of Object.keys(band).sort()) {
      const n = Math.floor((140400 * band[k] * 720) / 1e9);
      if (n > 0) want[k] = n;
    }
    assert.strictEqual(Object.keys(want).length, 7, "all 7 minerals");
    assert.deepStrictEqual(load.minerals, want);
    assert.deepStrictEqual([load.boosted, load.booster], [0, null]);
    assert.ok(cargoUnits(load.minerals) > 0);
    assert.deepStrictEqual(computeLoad({ composition: [g("mining_frigate", 3)], shiftMs: SHIFT_2H,
      richnessPermille: 1000, secClass: "wormhole" }, PARAMS, rates, bands),
    { oreM3: 0, minerals: {}, boosted: 0, booster: null });
  });

  test("Y2 boosts: Porpoise boosts 5 of 6 exhumers; Orca beats Porpoise; Rorqual own rate + 15 boosted "
    + "2 x Rorqual both 1000 permille", () => {
    const p = fleetRatePermille([g("porpoise", 1), g("exhumer", 6)], rates);
    assert.deepStrictEqual(p, { sum: BigInt(5 * 1950 * 2600 + 1950 * 1000), booster: "porpoise", boosted: 5,
      miners: 6 });
    const o = fleetRatePermille([g("orca", 1), g("porpoise", 1), g("mining_barge", 3)], rates);
    assert.deepStrictEqual(o, { sum: BigInt(3 * 1410 * 2600), booster: "orca", boosted: 3, miners: 3 });
    const r = fleetRatePermille([g("rorqual", 1), g("exhumer", 16)], rates);
    assert.deepStrictEqual(r, { sum: BigInt(21600 * 1000 + 15 * 1950 * 2600 + 1950 * 1000), booster: "rorqual",
      boosted: 15, miners: 17 });
    const rr = fleetRatePermille([g("rorqual", 2)], rates);
    assert.deepStrictEqual(rr, { sum: BigInt(2 * 21600 * 1000), booster: "rorqual", boosted: 0, miners: 2 });
  });

  test("Y3 legacy: 3 x industrial in the mining role = 3 x mining_frigate", () => {
    const spec = { shiftMs: SHIFT_2H, richnessPermille: 1000, secClass: "nullsec" };
    assert.deepStrictEqual(computeLoad({ ...spec, composition: [g("industrial", 3)] }, PARAMS, rates, bands),
      computeLoad({ ...spec, composition: [g("mining_frigate", 3)] }, PARAMS, rates, bands));
  });

  test("MF1 scaleBands: factors {} and 1000 -> input; Zydrine 15000 -> type:39 x 15 floor, rest same "
    + "input untouched, result frozen", () => {
    assert.ok(made.ok, JSON.stringify(made));
    const before = JSON.parse(JSON.stringify(bands));
    assert.deepStrictEqual(scaleBands(bands, {}), before);
    const ones = Object.fromEntries([34, 35, 36, 37, 38, 39, 40].map((id) => [`type:${id}`, 1000]));
    assert.deepStrictEqual(scaleBands(bands, ones), before);
    const zyd = scaleBands({ ...bands, odd: { "type:39": 7 }, none: null }, { "type:39": 15000 });
    for (const c of Object.keys(bands)) {
      for (const k of Object.keys(bands[c])) {
        const want = k === "type:39" ? Math.floor((bands[c][k] * 15000) / 1000) : bands[c][k];
        assert.strictEqual(zyd[c][k], want, `${c} ${k}`);
      }
      assert.ok(Object.isFrozen(zyd[c]), c);
    }
    assert.strictEqual(zyd.odd["type:39"], 105);
    assert.ok(!("none" in zyd), "null band skipped");
    assert.ok(Object.isFrozen(zyd));
    assert.deepStrictEqual(bands, before, "input not mutated");
    assert.deepStrictEqual(Object.keys(mineralFactors(DEFAULTS.mining)), Object.keys(ones));
  });

  test("MF2 regression: 3 x mining_frigate, highsec, richness 500, default shift -> cruiser <= 2 shifts "
    + "battleship <= 30", () => {
    assert.ok(made.ok, JSON.stringify(made));
    const M = DEFAULTS.mining;
    const load = computeLoad({ composition: [g("mining_frigate", 3)], shiftMs: M.shiftMs, richnessPermille: 500,
      secClass: "highsec" }, { refineYieldPermille: M.refineYieldPermille }, rates,
    scaleBands(bands, mineralFactors(M)));
    const shifts = (group) => {
      const recipe = HULL_RECIPES.GROUPS[group].minerals;
      let worst = 0;
      for (const k of Object.keys(recipe)) {
        const have = load.minerals[k] || 0;
        worst = Math.max(worst, have > 0 ? Math.ceil(recipe[k] / have) : Infinity);
      }
      return worst;
    };
    assert.ok(shifts("cruiser") <= 2, `cruiser ${shifts("cruiser")} ${JSON.stringify(load.minerals)}`);
    assert.ok(shifts("battleship") <= 30, `battleship ${shifts("battleship")} ${JSON.stringify(load.minerals)}`);
  });
};
