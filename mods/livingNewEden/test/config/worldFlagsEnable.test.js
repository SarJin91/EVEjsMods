"use strict";

const assert = require("node:assert");
const path = require("node:path");
const config = require("../../config");

const MOD_DIR = path.resolve(__dirname, "..", "..");

const D10674 = Object.freeze({
  EVEJS_LNE_PRODUCTION_POOL_CAP_ENABLED: "1",
  EVEJS_LNE_PRODUCTION_POOL_CAP_RELEASE_ENABLED: "1",
  EVEJS_LNE_MINERAL_SWAP_ENABLED: "1",
  EVEJS_LNE_MINING_OWN_STATION_SYSTEMS_ENABLED: "1",
  EVEJS_LNE_UPKEEP_SHIP_CAP_ENABLED: "1",
  EVEJS_LNE_STRATEGY_CAPITAL_POWER_CALIBRATED: "1",
  EVEJS_LNE_PRODUCTION_CAPITAL_LADDER_ENABLED: "1",
});

const TARGET = Object.freeze({
  ...D10674,
  EVEJS_LNE_UPKEEP_HOME_SPACE_INCOME_ENABLED: "1",
  EVEJS_LNE_STRATEGY_HQ_GARRISON_ENABLED: "1",
  EVEJS_LNE_AMBIENT_RATS_ENABLED: "1",
  EVEJS_LNE_AMBIENT_RATS_HIGHSEC_NAVY: "1",
});

const NAVY = "ambientRats.highsecNavy without ambientRats.enabled";
const HQ_ROLES = "strategy.hqGarrisonEnabled with an empty strategy.hqGarrisonRoles";

function resolve(env) {
  const r = config.resolveConfig({ env, modDir: MOD_DIR });
  assert.deepStrictEqual(r.errors, [], `errors: ${r.errors.join("; ")}`);
  return r;
}

module.exports = ({ test }) => {
  test("WF1 world flags enable: the target config has no upkeep / HQ / navy warning; navy alone and HQ with no "
    + "role give exactly 1 line each", () => {
    for (const env of Object.keys(TARGET)) {
      assert.ok(config.SCHEMA.some((row) => row.env === env), `no SCHEMA row with env ${env}`);
    }
    const target = resolve({ ...TARGET });
    const c = target.config;
    assert.deepStrictEqual([c.upkeep.homeSpaceIncomeEnabled, c.upkeep.shipCapEnabled, c.strategy.hqGarrisonEnabled,
      c.ambientRats.enabled, c.ambientRats.highsecNavy], [true, true, true, true, true]);
    const bad = target.warnings.filter((w) => w.includes("upkeep.") || w.includes("hqGarrison")
      || w.includes("highsecNavy"));
    assert.deepStrictEqual(bad, [], bad.join("; "));

    const navy = resolve({ EVEJS_LNE_AMBIENT_RATS_HIGHSEC_NAVY: "1" }).warnings.filter((w) => w.includes("highsecNavy"));
    assert.strictEqual(navy.length, 1, navy.join("; "));
    assert.ok(navy[0].startsWith(NAVY), navy[0]);

    const hq = resolve({ EVEJS_LNE_STRATEGY_HQ_GARRISON_ENABLED: "1", EVEJS_LNE_STRATEGY_HQ_GARRISON_ROLES: "none" })
      .warnings.filter((w) => w.includes("hqGarrison"));
    assert.strictEqual(hq.length, 1, hq.join("; "));
    assert.ok(hq[0].startsWith(HQ_ROLES), hq[0]);

    const defaults = resolve({}).warnings.filter((w) => w.startsWith(NAVY) || w.startsWith(HQ_ROLES));
    assert.deepStrictEqual(defaults, [], defaults.join("; "));
  });
};
