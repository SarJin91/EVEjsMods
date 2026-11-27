"use strict";

const assert = require("node:assert");
const path = require("node:path");
const config = require("../../config");

const MOD_DIR = path.resolve(__dirname, "..", "..");

const W = Object.freeze({
  W1: "capsuleers fleets capped by maxFleetsTotal=",
  W2: "capsuleer fleets may exhaust limits.maxVirtualFleets",
  W3: "owner characters above budget",
});

const START = Object.freeze({
  EVEJS_LNE_CAPSULEERS_MAX_CORPS: "12",
  EVEJS_LNE_CAPSULEERS_MEMBERS_PER_CORP: "5",
  EVEJS_LNE_CAPSULEERS_MAX_FOUNDINGS_PER_REVIEW: "2",
  EVEJS_LNE_CAPSULEERS_MAX_FLEET_BUYS_PER_REVIEW: "3",
  EVEJS_LNE_CAPSULEERS_FLEET_BUDGET_ENABLED: "1",
  EVEJS_LNE_CAPSULEERS_MAX_FLEETS_TOTAL: "36",
  EVEJS_LNE_CAPSULEERS_MIN_FLEET_HEADROOM: "150",
  EVEJS_LNE_HIGHSEC_LIFE_CIVILIAN_CORPS: "40",
});

function resolve(env) {
  const r = config.resolveConfig({ env, modDir: MOD_DIR });
  assert.deepStrictEqual(r.errors, [], `errors: ${r.errors.join("; ")}`);
  return r;
}

const starts = (warnings) => warnings.map((w) => Object.keys(W).find((k) => w.startsWith(W[k]))).filter(Boolean);

module.exports = ({ test }) => {
  test("FC1-1 free corps config: ranges, new keys and defaults, W1-W3 exactly at their condition", () => {
    const def = resolve({}).config;
    assert.deepStrictEqual([def.capsuleers.maxCorps, def.capsuleers.maxFoundingsPerReview,
      def.capsuleers.maxFleetBuysPerReview, def.capsuleers.fleetBudgetEnabled, def.capsuleers.maxFleetsTotal,
      def.capsuleers.minFleetHeadroom, def.highsecLife.civilianCorps, def.virtualCorps.ownerCharacterBudget],
    [4, 1, 1, false, 48, 100, 20, 2048], "defaults");

    const top = resolve({ EVEJS_LNE_CAPSULEERS_MAX_CORPS: "64", EVEJS_LNE_CAPSULEERS_MAX_FOUNDINGS_PER_REVIEW: "8",
      EVEJS_LNE_CAPSULEERS_MAX_FLEET_BUYS_PER_REVIEW: "8", EVEJS_LNE_HIGHSEC_LIFE_CIVILIAN_CORPS: "60" });
    assert.deepStrictEqual([top.config.capsuleers.maxCorps, top.config.capsuleers.maxFoundingsPerReview,
      top.config.capsuleers.maxFleetBuysPerReview, top.config.highsecLife.civilianCorps], [64, 8, 8, 60], "tops");
    assert.ok(!top.warnings.some((w) => w.includes("clamped")), top.warnings.join("; "));
    const over = resolve({ EVEJS_LNE_CAPSULEERS_MAX_CORPS: "65", EVEJS_LNE_HIGHSEC_LIFE_CIVILIAN_CORPS: "61" });
    assert.deepStrictEqual([over.config.capsuleers.maxCorps, over.config.highsecLife.civilianCorps], [64, 60]);
    assert.ok(over.warnings.some((w) => w.includes("CAPSULEERS_MAX_CORPS") && w.includes("clamped to 64")),
      over.warnings.join("; "));

    const CASES = [
      ["defaults", {}, []],
      ["Start scale", { ...START }, []],
      ["W1 budget on, 12 x 3 = 36 > 30", { ...START, EVEJS_LNE_CAPSULEERS_MAX_FLEETS_TOTAL: "30" }, ["W1"]],
      ["W1 budget off: no W1", { ...START, EVEJS_LNE_CAPSULEERS_MAX_FLEETS_TOTAL: "30",
        EVEJS_LNE_CAPSULEERS_FLEET_BUDGET_ENABLED: "0" }, []],
      ["W2 budget off, 12 x 3 = 36 > 100 - 70", { EVEJS_LNE_CAPSULEERS_MAX_CORPS: "12",
        EVEJS_LNE_MAX_VIRTUAL_FLEETS: "100", EVEJS_LNE_CAPSULEERS_MIN_FLEET_HEADROOM: "70" }, ["W2"]],
      ["W2 at the edge, 36 = 106 - 70", { EVEJS_LNE_CAPSULEERS_MAX_CORPS: "12",
        EVEJS_LNE_MAX_VIRTUAL_FLEETS: "106", EVEJS_LNE_CAPSULEERS_MIN_FLEET_HEADROOM: "70" }, []],
      ["W2 budget on: no W2", { ...START, EVEJS_LNE_MAX_VIRTUAL_FLEETS: "100",
        EVEJS_LNE_CAPSULEERS_MIN_FLEET_HEADROOM: "70" }, []],
      ["W3 12 x 5 + 40 x 10 = 460 > 459", { ...START, EVEJS_LNE_VIRTUAL_CORPS_OWNER_CHARACTER_BUDGET: "459" },
        ["W3"]],
      ["W3 at the edge 460", { ...START, EVEJS_LNE_VIRTUAL_CORPS_OWNER_CHARACTER_BUDGET: "460" }, []],
    ];
    for (const [name, env, want] of CASES) {
      const r = resolve(env);
      assert.deepStrictEqual(starts(r.warnings).sort(), want.slice().sort(), `${name}: ${r.warnings.join("; ")}`);
    }
  });
};
