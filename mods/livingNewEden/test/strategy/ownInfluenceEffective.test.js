"use strict";

const assert = require("node:assert");
const os = require("node:os");
const path = require("node:path");

const { resolveConfig } = require("../../config");
const { ownInfluenceOf } = require("../../lib/strategy/reviewService");
const { categoryOf } = require("../../lib/strategy/ai/targeting");
const { effectiveScores } = require("../../lib/world/occupation/influenceRules");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const HOUR = 3600000;
const AT = 1760000000000;
const F = 500003;
const C = 500025;
const SYS = 30004537;

function configOf(env) {
  const r = resolveConfig({ modDir: MOD_DIR, env: { EVEJS_DATA_ROOT: os.tmpdir(), ...env } });
  assert.deepStrictEqual(r.errors || [], []);
  return r.config;
}

const CONFIG = configOf({});
const effectiveScoreOf = (sys, factionId, at) => {
  const s = effectiveScores(sys, at, CONFIG.occupation).get(factionId);
  return s === undefined ? 0 : s;
};
const rowOf = (hoursBack) => ({ systemId: SYS, controllerFactionId: C, occupationState: "STABLE",
  influenceEvaluatedAt: AT - hoursBack * HOUR,
  influence: [{ factionId: C, influenceScore: 100 }, { factionId: F, influenceScore: 100 }] });
const categoryAt = (ownInfluence) => {
  const sys = { systemId: SYS, controllerFactionId: C, occupationState: "STABLE", homeFactionId: null, ownInfluence };
  return categoryOf({ factionId: F, theatre: [], doctrine: { canOccupy: true } },
    { reclaimMinInfluence: CONFIG.strategy.reclaimMinInfluence }, { sys, controller: C, hostileController: true }, SYS);
};

module.exports = ({ test }) => {
  test("OI1: foreign STABLE row 100, anchor 100 h back -> ownInfluence 0, hostile; 50 h back -> 50 "
    + "contested", () => {
    assert.strictEqual(CONFIG.occupation.stableForeignDecayPointsPerHour, 1);
    const old = ownInfluenceOf(rowOf(100), F, AT, effectiveScoreOf);
    assert.strictEqual(old, 0);
    assert.strictEqual(categoryAt(old), "hostile");
    const fresh = ownInfluenceOf(rowOf(50), F, AT, effectiveScoreOf);
    assert.strictEqual(fresh, 50);
    assert.strictEqual(categoryAt(fresh), "contested");
    assert.strictEqual(ownInfluenceOf({ ...rowOf(100), influence: [] }, F, AT, effectiveScoreOf), 0);
  });

  test("OI2 rollback: flag default true, env 0 -> false; no effectiveScoreOf or a throw -> stored 100 "
    + "contested", () => {
    assert.strictEqual(CONFIG.strategy.ownInfluenceEffective, true);
    assert.strictEqual(configOf({ EVEJS_LNE_STRATEGY_OWN_INFLUENCE_EFFECTIVE: "0" }).strategy.ownInfluenceEffective,
      false);
    const stored = ownInfluenceOf(rowOf(100), F, AT, null);
    assert.strictEqual(stored, 100);
    assert.strictEqual(categoryAt(stored), "contested");
    assert.strictEqual(ownInfluenceOf(rowOf(100), F, AT, () => {
      throw new Error("boom");
    }), 100);
  });
};
