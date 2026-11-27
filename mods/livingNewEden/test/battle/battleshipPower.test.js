"use strict";

const assert = require("node:assert");
const path = require("node:path");

const MOD_DIR = path.join(__dirname, "..", "..");

module.exports = ({ test }) => {
  const { expandStrengthGroups } = require("../../lib/battle/strength");
  const { buildPowerTable } = require("../../lib/strategy/ai/strength");
  const { CAPITAL_STRENGTH_ROWS, capitalPowerOverlayOf, BATTLESHIP_POWER_KEY } =
    require("../../lib/battle/data/capitalStrengthRows");
  const { GROUPS } = require("../../lib/battle/data/strengthCatalog");
  const { resolveConfig } = require("../../config");
  const tool = require("../../tools/calibration/battleshipScenarios");

  const configOf = (env) => resolveConfig({ env, settings: {}, envFile: {}, modDir: MOD_DIR });
  const tableOf = (strategy) => buildPowerTable(expandStrengthGroups(GROUPS, null, capitalPowerOverlayOf(strategy)));
  const bsPowerOf = (permille) => Math.round(Math.sqrt(268.3 * 0.653 * 38030.6) * permille / 1000);

  test("BSP1 battleship power flag off: overlay = CAPITAL_STRENGTH_ROWS (same object), battleship 2581", () => {
    const defaults = configOf({}).config.strategy;
    for (const strategy of [{ battleshipPowerCalibrated: false, battleshipPowerPermille: 520 },
      { battleshipPowerCalibrated: 1 }, defaults]) {
      assert.strictEqual(capitalPowerOverlayOf(strategy), CAPITAL_STRENGTH_ROWS, JSON.stringify(strategy));
    }
    assert.strictEqual(tableOf(defaults).battleship, 2581);
    assert.deepStrictEqual(tableOf(defaults), buildPowerTable(expandStrengthGroups(GROUPS)));
  });

  test("BSP2 battleship power flag on: battleship corrected, other keys unchanged, with capitals, ladder", () => {
    const resolved = configOf({ EVEJS_LNE_STRATEGY_BATTLESHIP_POWER_CALIBRATED: "1" });
    assert.deepStrictEqual(resolved.errors, []);
    const strategy = resolved.config.strategy;
    assert.strictEqual(strategy.battleshipPowerCalibrated, true);
    const d = strategy[BATTLESHIP_POWER_KEY];
    assert.strictEqual(d, 520);
    const overlay = capitalPowerOverlayOf(strategy);
    assert.ok(Object.isFrozen(overlay) && overlay !== CAPITAL_STRENGTH_ROWS);
    const off = tableOf({});
    const on = tableOf(strategy);
    assert.strictEqual(on.battleship, bsPowerOf(d));
    assert.strictEqual(on.battleship, 1342);
    assert.deepStrictEqual(Object.keys(on), Object.keys(off));
    for (const key of Object.keys(off)) if (key !== "battleship") assert.strictEqual(on[key], off[key], key);
    assert.ok(on.battlecruiser > on.battleship && on.battleship > on.cruiser,
      `battlecruiser ${on.battlecruiser} > battleship ${on.battleship} > cruiser ${on.cruiser}`);
    assert.strictEqual(on.battlecruiser, 1791);
    assert.strictEqual(on.cruiser, 1023);

    const both = configOf({ EVEJS_LNE_STRATEGY_BATTLESHIP_POWER_CALIBRATED: "1",
      EVEJS_LNE_STRATEGY_CAPITAL_POWER_CALIBRATED: "1" });
    assert.deepStrictEqual(both.errors, []);
    const table = tableOf(both.config.strategy);
    const EXPECTED = { carrier: 8253, dreadnought: 7037, force_auxiliary: 10021, supercarrier: 21411, titan: 25704 };
    for (const [cls, power] of Object.entries(EXPECTED)) assert.strictEqual(table[cls], power, cls);
    assert.strictEqual(table.battleship, 1342);
  });

  test("BSP3 expandStrengthGroups: an overlay row of a key in groups replaces it only with powerPermille", () => {
    assert.strictEqual(expandStrengthGroups(GROUPS, null, { battleship: { dps: 1 } }).battleship, GROUPS.battleship);
    const own = { battleship: { dps: 100, ehp: 400, applicationFactor: 1, remoteRepPerSec: 0 } };
    const merged = expandStrengthGroups(own, {}, { battleship: { powerPermille: 500 } }).battleship;
    assert.deepStrictEqual(merged, { dps: 100, ehp: 400, applicationFactor: 1, remoteRepPerSec: 0, powerPermille: 500 });
    assert.ok(Object.isFrozen(merged));
    assert.strictEqual(buildPowerTable({ battleship: merged }).battleship, 100);
    const bad = expandStrengthGroups(own, {}, { battleship: { powerPermille: 2.5 } });
    assert.strictEqual(bad.battleship, own.battleship);
    const without = expandStrengthGroups({ cruiser: GROUPS.cruiser }, {}, { battleship: { powerPermille: 500 } });
    assert.ok(!Object.hasOwn(without, "battleship"));
  });

  test("BSP4 config: battleshipPowerCalibrated false / battleshipPowerPermille 520, clamp 100..2000", () => {
    const d = configOf({});
    assert.deepStrictEqual(d.errors, []);
    assert.strictEqual(d.config.strategy.battleshipPowerCalibrated, false);
    assert.strictEqual(d.config.strategy.battleshipPowerPermille, 520);
    for (const [raw, expected] of [["50", 100], ["5000", 2000]]) {
      const r = configOf({ EVEJS_LNE_STRATEGY_BATTLESHIP_POWER_PERMILLE: raw });
      assert.deepStrictEqual(r.errors, [], raw);
      assert.strictEqual(r.config.strategy.battleshipPowerPermille, expected, raw);
    }
  });

  test("BSP5 battleshipScenarios helpers: garrisonOverlaySidesOf, c1LabelOf, c2RatioOf (no resolver)", () => {
    const templates = { empire: { overlay: { garrison: false, invasion: true } },
      pirate: { overlay: { garrison: true, invasion: true } } };
    assert.deepStrictEqual(tool.garrisonOverlaySidesOf(templates), ["pirate"]);
    assert.strictEqual(tool.c1LabelOf(templates, "pirate"), "bs/bs");
    assert.strictEqual(tool.c1LabelOf(templates, "empire"), "bs/v18");
    const e = (hullGroup, count) => ({ hullGroup, typeId: null, count });
    const base = [e("cruiser", 6), e("battlecruiser", 4), e("logistics", 2), e("tackle", 2)];
    const row = { compA: [...base, e("battleship", 2)], compB: [e("cruiser", 8), e("battlecruiser", 4),
      e("logistics", 2), e("tackle", 2)] };
    const table520 = tableOf({ battleshipPowerCalibrated: true, battleshipPowerPermille: 520 });
    assert.strictEqual(tool.c2RatioOf(row, table520), Number(((16552 + 2670) / 18576).toFixed(3)));
    assert.strictEqual(tool.c2RatioOf(row, table520), 1.035);
    assert.strictEqual(tool.c2RatioOf({ compA: row.compA, compB: null }, table520), null);
  });
};
