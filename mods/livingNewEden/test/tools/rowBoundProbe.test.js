"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const config = require("../../config");
const { parseComposeEnv } = require("../../tools/liveSim/compose");
const { rowBoundsOfConfig, BOUND_NAMES } = require("../../lib/strategy/reviewBound");
const probe = require("../../tools/measure/rowBoundProbe");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const COMPOSE_FILE = "compose.yaml";
const COMPOSE_SEARCH_MAX_DEPTH = 5;

function findCompose() {
  let dir = path.dirname(MOD_DIR);
  for (let i = 0; i < COMPOSE_SEARCH_MAX_DEPTH; i += 1) {
    const file = path.join(dir, COMPOSE_FILE);
    if (fs.existsSync(file)) return file;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

const boundsOf = (env) => {
  const r = config.resolveConfig({ env, modDir: MOD_DIR });
  assert.deepStrictEqual(r.errors, [], `resolveConfig errors: ${r.errors.join("; ")}`);
  return rowBoundsOfConfig(r.config);
};

module.exports = ({ test, skip }) => {
  const file = findCompose();
  if (!file) {
    skip("RBP1 row bound probe on compose.yaml", "compose.yaml not found above the mod (Docker image)");
  } else {
    test("RBP1 row bound probe: recommendLimit rule; docker-known + replenish return = CK6 review bound "
      + "bounds grow over the 4 scenarios", () => {
      assert.deepStrictEqual([1033, 1150, 1300, 9990, 2000, 0].map((b) => probe.recommendLimit(b)),
        [1200, 1300, 1500, 10000, 2200, 1200]);

      const parsed = parseComposeEnv(fs.readFileSync(file, "utf8"));
      assert.strictEqual(parsed.ok, true, JSON.stringify(parsed));
      const base = parsed.values;
      assert.strictEqual(probe.scenarioEnv("bogus", base), null);
      const RETURN = "EVEJS_LNE_LOGISTICS_REPLENISH_RETURN_ENABLED";
      const known = probe.scenarioEnv("docker-known", base);
      const ck6 = { ...base };
      for (const n of ["EVEJS_LNE_STRATEGY_BLOCKADE_ENABLED", "EVEJS_LNE_STRATEGY_ATTACK_LOSS_MEMORY_ENABLED",
        "EVEJS_LNE_STRATEGY_ATTACK_LOSS_ISK_GATE_ENABLED", "EVEJS_LNE_FORTRESS_CHECKPOINT_ENABLED",
        "EVEJS_LNE_FORTRESS_ROUTE_AVERSION_ENABLED", "EVEJS_LNE_FORTRESS_HALT_MEMORY_ENABLED", "EVEJS_LNE_HUNT_ENABLED",
        "EVEJS_LNE_GRID_ENABLED", "EVEJS_LNE_GRID_MOVES_ENABLED", "EVEJS_LNE_BATTLE_GRID_CONTACTS_ENABLED",
        "EVEJS_LNE_GRID_DEFENSE_ENABLED", "EVEJS_LNE_GRID_CROSSINGS_ENABLED",
        "EVEJS_LNE_GRID_CROSSINGS_BLOCKADE_GATE_ENABLED", "EVEJS_LNE_SIEGE_GRID_ENABLED",
        "EVEJS_LNE_SENTRIES_BATTLE_GRID_ENABLED", RETURN]) ck6[n] = "1";
      const withReturn = boundsOf({ ...known, [RETURN]: "1" });
      assert.strictEqual(withReturn.review, boundsOf(ck6).review);

      const all = probe.SCENARIOS.map((name) => ({ name, b: boundsOf(probe.scenarioEnv(name, base)) }));
      for (let i = 1; i < all.length; i += 1) {
        for (const n of BOUND_NAMES) {
          const lo = all[i - 1].b[n];
          const hi = all[i].b[n];
          if (Number.isFinite(lo)) {
            assert.ok(Number.isFinite(hi) && lo <= hi, `${n}: ${all[i - 1].name}=${lo} > ${all[i].name}=${hi}`);
          }
        }
      }
      console.log(`     RBP1 review bounds: ${all.map((x) => `${x.name}=${x.b.review}`).join(" ")}`);
    });
  }

  test("RBP2 row bound probe: the lists are SCHEMA keys / env names; --process-env prints bounds, no other "
    + "values", () => {
    const byKey = new Map(config.SCHEMA.map((r) => [r.key, r]));
    const envs = new Set(config.SCHEMA.map((r) => r.env));
    const notBool = probe.WORST_FLAGS.filter((k) => !byKey.has(k) || byKey.get(k).type !== "boolean");
    assert.deepStrictEqual(notBool, [], `WORST_FLAGS not boolean SCHEMA keys: ${notBool.join(", ")}`);
    const unknown = [...probe.DOCKER_KNOWN_ON, ...probe.ENABLE_BATCH_ON].filter((n) => !envs.has(n));
    assert.deepStrictEqual(unknown, [], `env names outside SCHEMA: ${unknown.join(", ")}`);

    const secretEnv = byKey.get("alerts.webhookUrl").env;
    const SECRET = "https://hooks.example.invalid/rbp2-SECRET-VALUE";
    const modDir = fs.mkdtempSync(path.join(os.tmpdir(), "lne-rbp2-"));
    try {
      const out = [];
      const err = [];
      const env = { [secretEnv]: SECRET, EVEJS_LNE_FORTRESS_CHECKPOINT_ENABLED: "1", PATH: "x" };
      const code = probe.main(["--process-env"], { env, modDir, out: (l) => out.push(l), err: (l) => err.push(l) });
      assert.deepStrictEqual([code, err], [0, []]);
      const text = out.join("\n");
      assert.ok(/scenario process-env: review=\d+ /.test(text), text);
      assert.ok(text.includes("fortress.checkpointEnabled"), text);
      assert.ok(!text.includes("rbp2-SECRET"), "the probe printed a value of a key outside its lists");
      assert.strictEqual(probe.main(["--bogus"], { out() {}, err() {} }), 1);
      assert.strictEqual(probe.main(["--compose", path.join(modDir, "none.yaml")], { out() {}, err() {} }), 1);
    } finally {
      fs.rmSync(modDir, { recursive: true, force: true });
    }
  });
};
