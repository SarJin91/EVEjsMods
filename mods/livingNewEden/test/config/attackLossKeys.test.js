"use strict";

const assert = require("node:assert");
const path = require("node:path");
const config = require("../../config");

const MOD_DIR = path.resolve(__dirname, "..", "..");

const DEFAULTS = Object.freeze({
  "strategy.attackLossMemoryEnabled": false,
  "strategy.attackLossThreshold": 3,
  "strategy.attackLossCooldownMs": 21600000,
  "strategy.attackLossWindowMs": 86400000,
  "strategy.attackLossMaxMultiplier": 4,
  "strategy.attackLossStepPermille": 250,
  "strategy.maxAttackLossRowsPerFaction": 128,
  "strategy.attackLossSettleRows": 4,
  "strategy.attackLossIskGateEnabled": false,
  "strategy.attackLossSharePermille": 330,
  "strategy.maxAttackLossRoomPermille": 500,
  "battle.assembly.enabled": false,
  "battle.assemblyGraceMs": 1800000,
  "battle.decline.enabled": false,
  "battle.declineRatioPermille": 500,
});

const at = (obj, key) => key.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
const resolve = (env) => config.resolveConfig({ env, modDir: MOD_DIR });

function settlementRows(env) {
  const r = resolve({ EVEJS_LNE_PERSISTENCE_MAX_ROWS_PER_TRANSACTION: "100", ...env });
  const line = r.warnings.find((w) => w.startsWith("smallest full battle settles"));
  assert.ok(line, `no settlement rows warning: ${r.warnings.join("; ")}`);
  return { rows: Number(/ rows > (\d+) /.exec(line)[1]), line, reserve: r.config.battle.settleRowsReserve };
}

module.exports = ({ test }) => {
  test("AL1 attack loss keys: defaults of all 15 keys, internal (no launcher), flags off", () => {
    const r = resolve({});
    const byKey = new Map(config.SCHEMA.map((row) => [row.key, row]));
    for (const [key, value] of Object.entries(DEFAULTS)) {
      assert.strictEqual(at(r.config, key), value, key);
      assert.ok(!byKey.get(key).launcher, `${key} has a launcher field`);
    }
  });

  test("AL2 attack loss keys: a value out of range is clamped", () => {
    const r = resolve({ EVEJS_LNE_STRATEGY_ATTACK_LOSS_SETTLE_ROWS: "1",
      EVEJS_LNE_BATTLE_DECLINE_RATIO_PERMILLE: "5000" });
    assert.strictEqual(r.config.strategy.attackLossSettleRows, 3);
    assert.strictEqual(r.config.battle.declineRatioPermille, 1000);
  });

  test("AL3 maxSettlementRows: off = reserve only, on = minus strategy.attackLossSettleRows", () => {
    const off = settlementRows({});
    assert.strictEqual(off.rows, 100 - off.reserve);
    assert.ok(!off.line.includes("attackLossSettleRows"), off.line);
    const on = settlementRows({ EVEJS_LNE_STRATEGY_ATTACK_LOSS_MEMORY_ENABLED: "1",
      EVEJS_LNE_STRATEGY_ATTACK_LOSS_SETTLE_ROWS: "7" });
    assert.strictEqual(on.rows, off.rows - 7);
    assert.ok(on.line.includes(" - strategy.attackLossSettleRows"), on.line);
  });
};
