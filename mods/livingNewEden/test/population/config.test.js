"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");

const config = require("../../config");
const { startPopulation, createUnavailablePopulation, POPULATION_METHODS } = require("../../lib/population");
const { MIGRATIONS } = require("../../lib/persistence/migrations");
const { TABLE_POLICY, ACTION } = require("../../lib/persistence/worldReset");
const { mask } = require("../_support/sourceScan");
const { findCompose, readCompose } = require("../config/composeKeys.test");
const F = require("./fixture");

const MOD_DIR = path.resolve(__dirname, "..", "..");

function listJs(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listJs(full));
    else if (e.name.endsWith(".js")) out.push(full);
  }
  return out;
}

module.exports = ({ test }) => {
  test("PA5 config / off: disabled_by_config without timers or writes; compose + .env.example; migration 120 WIPE; "
    + "no server require", () => {
    let timers = 0;
    let txs = 0;
    const persistence = { ok: true, worldSeed: 1, store: { limits: { maxRowsPerTransaction: 500 },
      transaction: () => {
        txs += 1;
        return { ok: false, reason: "TEST" };
      } } };
    const base = { persistence, clock: { now: () => 0 }, setTimer: () => {
      timers += 1;
      return { cancel() {}, hasRef: () => false };
    }, getGraph: () => null, listStations: F.listStations, buildHubDistance: () => new Map() };
    for (const cfg of [{ population: F.populationConfig({ enabled: false }) }, {}]) {
      assert.deepStrictEqual(startPopulation({ ...base, config: cfg }), { ok: false, reason: "disabled_by_config" });
    }
    assert.deepStrictEqual([timers, txs], [0, 0]);
    const stub = createUnavailablePopulation("disabled_by_config");
    assert.deepStrictEqual(Object.keys(stub).sort(), [...POPULATION_METHODS].sort());
    assert.strictEqual(stub.getStatus().state, "disabled_by_config");
    assert.strictEqual(stub.countIn(1), 0);

    const rows = config.SCHEMA.filter((row) => row.key.startsWith("population."));
    assert.strictEqual(rows.length, 130, `population.* SCHEMA rows: ${rows.length}`);
    const envText = fs.readFileSync(path.join(MOD_DIR, ".env.example"), "utf8");
    const noEnv = rows.filter((row) => !envText.includes(`# ${row.env}=`)).map((row) => row.env);
    assert.deepStrictEqual(noEnv, [], `missing in .env.example: ${noEnv.join(", ")}`);
    const composeFile = findCompose();
    if (composeFile) {
      const text = fs.readFileSync(composeFile, "utf8");
      const { env } = readCompose(composeFile);
      const missing = rows.filter((row) => !Object.prototype.hasOwnProperty.call(env, row.env)).map((row) => row.env);
      assert.deepStrictEqual(missing, [], `missing in compose env: ${missing.join(", ")}`);
      const wrong = rows.filter((row) => {
        const want = row.type === "boolean" ? `\${${row.env}:-${row.default ? 1 : 0}}` : `\${${row.env}:-}`;
        return !text.includes(`${row.env}: ${want}`);
      }).map((row) => row.env);
      assert.deepStrictEqual(wrong, [], `compose default other than :-0 / :- : ${wrong.join(", ")}`);
    }

    const m = MIGRATIONS.find((x) => x.name === "population");
    assert.ok(m && m.version === 120, JSON.stringify(m && m.version));
    assert.strictEqual(TABLE_POLICY.world_npc_pilots, ACTION.WIPE);
    assert.strictEqual(TABLE_POLICY.world_npc_population, ACTION.WIPE);

    const offenders = [];
    for (const file of listJs(path.join(MOD_DIR, "lib", "population"))) {
      const text = mask(fs.readFileSync(file, "utf8"), { strings: false });
      for (const m2 of text.matchAll(/require\(\s*["'`]([^"'`]+)["'`]\s*\)/g)) {
        if (/server|adapter/.test(m2[1])) offenders.push(`${path.basename(file)}: ${m2[1]}`);
      }
      if (/Math\.random|setTimeout|setInterval/.test(text)) offenders.push(`${path.basename(file)}: timer / random`);
    }
    assert.deepStrictEqual(offenders, []);
  });
};
