"use strict";

const assert = require("node:assert");
const path = require("node:path");
const config = require("../../config");

const MOD_DIR = path.resolve(__dirname, "..", "..");

const GRID_FLAGS = Object.freeze([
  "EVEJS_LNE_GRID_ENABLED",
  "EVEJS_LNE_GRID_MOVES_ENABLED",
  "EVEJS_LNE_BATTLE_GRID_CONTACTS_ENABLED",
  "EVEJS_LNE_GRID_DEFENSE_ENABLED",
  "EVEJS_LNE_GRID_CROSSINGS_ENABLED",
  "EVEJS_LNE_SIEGE_GRID_ENABLED",
  "EVEJS_LNE_GRID_CROSSINGS_BLOCKADE_GATE_ENABLED",
  "EVEJS_LNE_SENTRIES_BATTLE_GRID_ENABLED",
  "EVEJS_LNE_MATERIALIZATION_GRID_ANCHOR_ENABLED",
  "EVEJS_LNE_GRID_DEFENSE_STRIKE_PURSUIT_ENABLED",
]);

const FULL = Object.freeze({ ...Object.fromEntries(GRID_FLAGS.map((k) => [k, "1"])), EVEJS_LNE_HUNT_ENABLED: "1" });
const LOW1 = "observer.systemInteriorMaxFleets above";

function resolve(env) {
  const r = config.resolveConfig({ env, modDir: MOD_DIR });
  assert.deepStrictEqual(r.errors, [], `errors: ${r.errors.join("; ")}`);
  return r.warnings;
}

const gridLines = (warnings) => warnings.filter((w) => /grid|Grid/.test(w));

module.exports = ({ test }) => {
  test("GE1 grid enable: 10 flags + hunt = no error, no grid warning; contacts without defense warn", () => {
    assert.deepStrictEqual(gridLines(resolve({ ...FULL })), []);
    const partial = resolve({ EVEJS_LNE_BATTLE_GRID_CONTACTS_ENABLED: "1", EVEJS_LNE_GRID_ENABLED: "1",
      EVEJS_LNE_GRID_MOVES_ENABLED: "1" });
    assert.ok(partial.some((w) => w.includes("passes the garrison unseen; enable them together")), partial.join("; "));
  });

  test("GE2 grid enable: systemInteriorMaxFleets above maxPositionsPerCall warns once, only with grid.enabled", () => {
    const above = resolve({ EVEJS_LNE_GRID_ENABLED: "1", EVEJS_LNE_OBSERVER_SYSTEM_INTERIOR_MAX_FLEETS: "300" });
    assert.strictEqual(above.filter((w) => w.startsWith(LOW1)).length, 1, above.join("; "));
    const equal = resolve({ EVEJS_LNE_GRID_ENABLED: "1", EVEJS_LNE_OBSERVER_SYSTEM_INTERIOR_MAX_FLEETS: "256" });
    assert.strictEqual(equal.filter((w) => w.startsWith(LOW1)).length, 0, equal.join("; "));
    const off = resolve({ EVEJS_LNE_GRID_ENABLED: "0", EVEJS_LNE_OBSERVER_SYSTEM_INTERIOR_MAX_FLEETS: "300" });
    assert.strictEqual(off.filter((w) => w.startsWith(LOW1)).length, 0, off.join("; "));
  });

  test("GE3 grid enable: strikePursuitEnabled without defense warns; reaction after the pin expiry warns", () => {
    const noDefense = resolve({ EVEJS_LNE_GRID_DEFENSE_STRIKE_PURSUIT_ENABLED: "1", EVEJS_LNE_HUNT_ENABLED: "1" });
    assert.ok(noDefense.some((w) => w.includes("strikePursuitEnabled without grid.defense.enabled or hunt.enabled")),
      noDefense.join("; "));
    const late = resolve({ ...FULL, EVEJS_LNE_GRID_DEFENSE_SEEN_REACTION_MS: "60000",
      EVEJS_LNE_GRID_DEFENSE_REACTION_JITTER_MS: "30000" });
    assert.ok(late.some((w) => w.includes("the strike step comes after the pin expiry")), late.join("; "));
  });
};
