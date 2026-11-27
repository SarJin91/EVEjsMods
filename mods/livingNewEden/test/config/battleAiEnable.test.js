"use strict";

const assert = require("node:assert");
const path = require("node:path");
const config = require("../../config");
const { findCompose, readCompose } = require("./composeKeys.test");

const MOD_DIR = path.resolve(__dirname, "..", "..");

const FLAGS = Object.freeze({
  EVEJS_LNE_BATTLE_ASSEMBLY_ENABLED: "1",
  EVEJS_LNE_STRATEGY_ATTACK_LOSS_MEMORY_ENABLED: "1",
  EVEJS_LNE_BATTLE_DECLINE_ENABLED: "1",
  EVEJS_LNE_STRATEGY_ATTACK_LOSS_ISK_GATE_ENABLED: "1",
  EVEJS_LNE_TREASURY_PRESSURE_ENABLED: "1",
});

const W1 = "strategy.attackLossIskGateEnabled without";
const W2 = "battle.decline.enabled without modules.strategy";

function resolve(env) {
  const r = config.resolveConfig({ env, modDir: MOD_DIR });
  assert.deepStrictEqual(r.errors, [], `errors: ${r.errors.join("; ")}`);
  return r;
}

const startsWith = (warnings, s) => warnings.filter((w) => w.startsWith(s));

module.exports = ({ test, skip }) => {
  const file = findCompose();
  if (!file) {
    skip("BA1 battle AI enable", "compose.yaml not found above the mod (Docker image)");
  } else {
    test("BA1 battle AI enable: the Docker target config has no error and no battle AI warning", () => {
      const r = resolve({ ...readCompose(file).env, ...FLAGS });
      const c = r.config;
      assert.deepStrictEqual([c.battle.assembly.enabled, c.strategy.attackLossMemoryEnabled, c.battle.decline.enabled,
        c.strategy.attackLossIskGateEnabled, c.treasury.pressureEnabled], [true, true, true, true, true]);
      const bad = r.warnings.filter((w) => /attackLoss|assembly|decline|maxSettlementRows/.test(w));
      assert.deepStrictEqual(bad, [], `battle AI warnings: ${bad.join("; ")}`);
    });
  }

  test("BA2 battle AI enable: W1 ISK gate alone, W2 decline without strategy", () => {
    const iskOnly = resolve({ EVEJS_LNE_STRATEGY_ATTACK_LOSS_ISK_GATE_ENABLED: "1" });
    assert.strictEqual(startsWith(iskOnly.warnings, W1).length, 1, iskOnly.warnings.join("; "));
    const iskFull = resolve({ EVEJS_LNE_STRATEGY_ATTACK_LOSS_ISK_GATE_ENABLED: "1",
      EVEJS_LNE_STRATEGY_ATTACK_LOSS_MEMORY_ENABLED: "1", EVEJS_LNE_TREASURY_PRESSURE_ENABLED: "1" });
    assert.deepStrictEqual(startsWith(iskFull.warnings, W1), []);
    const declineNoStrategy = resolve({ EVEJS_LNE_BATTLE_DECLINE_ENABLED: "1", EVEJS_LNE_STRATEGY_ENABLED: "0" });
    assert.strictEqual(startsWith(declineNoStrategy.warnings, W2).length, 1, declineNoStrategy.warnings.join("; "));
    const declineOn = resolve({ EVEJS_LNE_BATTLE_DECLINE_ENABLED: "1" });
    assert.deepStrictEqual(startsWith(declineOn.warnings, W2), []);
    const defaults = resolve({});
    assert.deepStrictEqual([...startsWith(defaults.warnings, W1), ...startsWith(defaults.warnings, W2)], []);
  });
};
