"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { performance } = require("node:perf_hooks");

const MOD_DIR = path.join(__dirname, "..", "..");
const RESOLVER_FILE = path.join(MOD_DIR, "lib", "battle", "resolverInternalV1.js");
const R3_TRIALS = 200;
const R3_SIMILAR_TRIALS = 1000;
const R3S_TRIALS = 20;
const SIMILAR_MAX_GAP = 0.1;
const FUZZ_ROLES = Object.freeze(["invasion", "garrison", "logistics", "scout", "patrol", "wormhole", "reserve"]);
const R2_FAST = 100;
const GOLDEN_FAST_HASH = "5e3f627298e474058ea448b7003ee7dcf3409aff93c61f2594461b71c0dd91bb";
const GOLDEN_DETERMINISM_HASH = "20e513f76fbf700c092916ec3a1b579020d1b02b832f3f73d9853fc424ba74a1";

let cached = null;
function setup() {
  if (cached) return cached;
  const config = require("../../config");
  const { createStrengthCatalog } = require("../../lib/battle/strength");
  const { buildResolverParams } = require("../../lib/battle/resolverParams");
  const resolver = require("../../lib/battle/resolverInternalV1");
  const resolved = config.resolveConfig({ modDir: MOD_DIR, env: {} });
  const made = createStrengthCatalog(undefined, { groupConfidence: 0.9, unknownTypeConfidence: 0.6 });
  assert.strictEqual(made.ok, true, JSON.stringify(made));
  const built = buildResolverParams(resolved.config);
  assert.strictEqual(built.ok, true, JSON.stringify(built));
  cached = { config: resolved.config, catalog: made.catalog, params: built.params, resolver,
    scenarios: require("./scenarios") };
  return cached;
}

function run(input) {
  const { resolver, catalog, params } = setup();
  return resolver.resolve(input, catalog, params);
}

function okResult(input) {
  const r = run(input);
  assert.strictEqual(r.ok, true, JSON.stringify(r));
  return r.result;
}

const sumCount = (list, pred = () => true) => list.filter(pred).reduce((n, g) => n + g.count, 0);
const sideOf = (g) => (g.fleetId.startsWith("fleet_a") ? "A" : "B");

module.exports = ({ test, bench }) => {
  test("R1 resolver determinism: same input+seed 100x deep-equal; seeds 1..50 give varied losses and outcomes", () => {
    const { SCENARIOS } = setup().scenarios;
    const first = okResult(SCENARIOS.similar(4242));
    for (let i = 0; i < 100; i += 1) assert.deepStrictEqual(okResult(SCENARIOS.similar(4242)), first);
    const totals = new Set();
    const outcomes = new Set();
    for (let seed = 1; seed <= 50; seed += 1) {
      const r = okResult(SCENARIOS.similar(seed));
      totals.add(sumCount(r.destroyedShips));
      outcomes.add(r.outcome);
    }
    assert.ok(totals.size >= 5, `distinct destroyed totals ${[...totals]}`);
    assert.ok(outcomes.size >= 2, `outcomes ${[...outcomes]}`);
  });

  test(`R2 resolver balance fuzz: ${R2_FAST} random inputs ok + validateResult; winner survives; hash Node 24 = 26`,
    () => runFuzz(R2_FAST, GOLDEN_FAST_HASH));
  bench("R2 full resolver balance fuzz: 1000 random inputs, golden hash", () => runFuzz(1000, GOLDEN_DETERMINISM_HASH));

  function runFuzz(count, golden) {
    const { catalog, scenarios } = setup();
    const { createRng } = require("../../lib/util/rng");
    const { fingerprint } = require("../../lib/util/fingerprint");
    const { validateInput, validateResult } = require("../../lib/battle/contract");
    const { HULL_GROUPS_V1 } = require("../../lib/fleets/schema");
    const { BATTLE_OBJECTIVES, ENVIRONMENTS } = require("../../lib/battle/schema");
    const { TYPES } = require("../../lib/battle/data/strengthCatalog");
    const typesByGroup = {};
    for (const key of Object.keys(TYPES)) (typesByGroup[TYPES[key].hullGroup] ||= []).push(TYPES[key].typeId);
    const lists = { hullGroups: HULL_GROUPS_V1, typesByGroup, objectives: BATTLE_OBJECTIVES, environments: ENVIRONMENTS,
      roles: FUZZ_ROLES };
    const { params } = setup();
    const rng = createRng(777);
    const hashes = [];
    for (let n = 0; n < count; n += 1) {
      const input = scenarios.randomInput(rng, n, lists);
      const r = setup().resolver.resolve(input, catalog, params);
      assert.strictEqual(r.ok, true, `#${n} ${JSON.stringify(r)}`);
      const norm = validateInput(input, params.limits).input;
      const again = validateResult(norm, r.result, { maxResultBytes: params.limits.maxResultBytes });
      assert.strictEqual(again.ok, true, `#${n} ${JSON.stringify(again)}`);
      const res = r.result;
      assert.strictEqual(typeof res.objectiveAchieved, "boolean");
      if (res.outcome === "A_WIN") assert.ok(res.survivingShips.some((g) => sideOf(g) === "A"), `#${n} A survives`);
      if (res.outcome === "B_WIN") assert.ok(res.survivingShips.some((g) => sideOf(g) === "B"), `#${n} B survives`);
      if (res.outcome === "BOTH_RETREAT") assert.deepStrictEqual(res.survivingShips, [], `#${n}`);
      hashes.push(fingerprint(res));
    }
    const hash = fingerprint(hashes);
    console.log(`resolver determinism hash: ${hash}`);
    assert.strictEqual(hash, golden, "R2 golden hash (update on a deliberate model change)");
  }

  function runScenarios(TRIALS, SIMILAR_TRIALS, full) {
    const pct = (n) => Math.round((n / TRIALS) * 1000) / 10;
    const { SCENARIOS } = setup().scenarios;
    const trials = (build) => {
      const out = [];
      for (let seed = 1; seed <= TRIALS; seed += 1) out.push(okResult(build(seed)));
      return out;
    };
    const table = [];

    const big = trials((s) => SCENARIOS.outnumber(s, false));
    const swapped = trials((s) => SCENARIOS.outnumber(s, true));
    const aWins = big.filter((r) => r.outcome === "A_WIN").length;
    const bWins = swapped.filter((r) => r.outcome === "B_WIN").length;
    const smallEscaped = big.filter((r) => sumCount(r.escapedShips, (g) => sideOf(g) === "B") > 0).length;
    table.push(`a 30v10 A_WIN ${pct(aWins)}%, 10v30 B_WIN ${pct(bWins)}%, small side escaped ${pct(smallEscaped)}%`);
    if (full) {
      assert.ok(aWins >= 0.9 * TRIALS && bWins >= 0.9 * TRIALS, table[table.length - 1]);
      assert.ok(smallEscaped >= 0.5 * TRIALS, table[table.length - 1]);
    } else assert.ok(aWins > TRIALS / 2 && bWins > TRIALS / 2 && smallEscaped > 0, table[table.length - 1]);

    const lossBc = (rs) => rs.reduce((n, r) => n + sumCount(r.destroyedShips,
      (g) => sideOf(g) === "A" && g.hullGroup === "battlecruiser"), 0) / TRIALS;
    const withLogi = lossBc(trials((s) => SCENARIOS.logistics(s, true)));
    const noLogi = lossBc(trials((s) => SCENARIOS.logistics(s, false)));
    table.push(`b BC losses of A: with logistics ${withLogi.toFixed(2)}, without ${noLogi.toFixed(2)}`);
    assert.ok(withLogi < noLogi, table[table.length - 1]);

    const escapedShare = (rs) => rs.reduce((n, r) => n + sumCount(r.escapedShips, (g) => sideOf(g) === "B"), 0)
      / (3 * TRIALS);
    const scoutFree = escapedShare(trials((s) => SCENARIOS.scout(s, false)));
    const scoutTackled = escapedShare(trials((s) => SCENARIOS.scout(s, true)));
    table.push(`c scouts escaped: ${scoutFree.toFixed(3)}, with 4 tackle ${scoutTackled.toFixed(3)}`);
    assert.ok((!full || scoutFree >= 0.5) && scoutTackled < scoutFree, table[table.length - 1]);

    const esc = trials(SCENARIOS.escort);
    const escOk = esc.filter((r) => r.objectiveAchieved && sumCount(r.destroyedShips, (g) => sideOf(g) === "A") > 0)
      .length;
    const escAchieved = esc.filter((r) => r.objectiveAchieved).length;
    table.push(`d escort achieved ${pct(escAchieved)}%, achieved with A losses ${pct(escOk)}%`);
    assert.ok(full ? escOk >= 0.1 * TRIALS : escAchieved > 0, table[table.length - 1]);
    assert.ok(esc.every((r) => r.diagnostics.convoyInitial === 5 && r.diagnostics.escortNoConvoy === 0));

    const bWin = (rs) => rs.filter((r) => r.outcome === "B_WIN").length;
    const garr = trials((s) => SCENARIOS.capture(s, true));
    const bare = trials((s) => SCENARIOS.capture(s, false));
    table.push(`e capture B_WIN with garrison ${pct(bWin(garr))}%, without ${pct(bWin(bare))}%`);
    assert.ok(bWin(garr) > bWin(bare) + (full ? 0.15 * TRIALS : 0), table[table.length - 1]);
    assert.ok(garr.every((r) => r.diagnostics.garrisonRemaining >= 0) && bare.every((r) =>
      r.diagnostics.garrisonRemaining === -1));

    const del = trials(SCENARIOS.delay);
    const delOk = del.filter((r) => r.objectiveAchieved).length;
    const delLost = del.filter((r) => r.objectiveAchieved && r.outcome === "B_WIN").length;
    table.push(`f delay achieved ${pct(delOk)}%, of it B_WIN ${pct(delLost)}%`);
    assert.ok(full ? delOk >= 0.5 * TRIALS && delLost > 0 : delOk > 0, table[table.length - 1]);

    let simA = 0;
    let simB = 0;
    const sim = [];
    for (let seed = 1; seed <= SIMILAR_TRIALS; seed += 1) {
      const outcome = okResult(SCENARIOS.similar(seed)).outcome;
      if (seed <= TRIALS) sim.push({ outcome });
      if (outcome === "A_WIN") simA += 1;
      else if (outcome === "B_WIN") simB += 1;
    }
    table.push(`similar 10v10 A_WIN ${pct(sim.filter((r) => r.outcome === "A_WIN").length)}%, B_WIN `
      + `${pct(sim.filter((r) => r.outcome === "B_WIN").length)}%, DRAW `
      + `${pct(sim.filter((r) => r.outcome === "DRAW").length)}%, BOTH_RETREAT `
      + `${pct(sim.filter((r) => r.outcome === "BOTH_RETREAT").length)}%`);
    const simDiffPp = Math.round(((simB - simA) / SIMILAR_TRIALS) * 1000) / 10;
    table.push(`similar 10v10 N=${SIMILAR_TRIALS} A_WIN ${Math.round((simA / SIMILAR_TRIALS) * 1000) / 10}%, B_WIN `
      + `${Math.round((simB / SIMILAR_TRIALS) * 1000) / 10}%, B-A ${simDiffPp} pp`);
    if (!full) return;
    for (const line of table) console.log(`resolver R3 ${line}`);
    assert.ok(Math.abs(simB - simA) <= SIMILAR_MAX_GAP * SIMILAR_TRIALS, table[table.length - 1]);
  }

  bench(`R3 resolver scenarios (N=${R3_TRIALS}): numbers, logistics, scouts, escort, garrison, delay`,
    () => runScenarios(R3_TRIALS, R3_SIMILAR_TRIALS, true));
  test(`R3s resolver scenarios short (N=${R3S_TRIALS}): the same directions, no share thresholds`,
    () => runScenarios(R3S_TRIALS, R3S_TRIALS, false));

  test("R4 resolver refusals and stalemate: INPUT_INVALID, version, budget, BOTH_RETREAT without a win", () => {
    const { scenarios, catalog, params, resolver } = setup();
    const { makeInput, ships, SCENARIOS } = scenarios;
    const refusals = [];
    const expectRefusal = (r, reason) => {
      assert.strictEqual(r.ok, false, JSON.stringify(r));
      assert.strictEqual(r.reason, reason, JSON.stringify(r));
      assert.strictEqual(typeof r.detail, "string");
      refusals.push(r);
    };
    const empty = makeInput({ sideA: [{ ships: [ships("cruiser", 3)] }], sideB: [] });
    expectRefusal(run(empty), "INPUT_INVALID");
    expectRefusal(run(makeInput({ sideA: [{ ships: [ships("no_such_hull", 3)] }], sideB: [{ ships: [ships("cruiser",
      3)] }] })), "INPUT_INVALID");
    expectRefusal(run(makeInput({ sideA: [{ ships: [ships("frigate", 3, "587")] }], sideB: [{ ships: [ships("cruiser",
      3)] }] })), "INPUT_INVALID");
    expectRefusal(run({ ...SCENARIOS.similar(1), resolverVersion: "efs-adapter" }), "RESOLVER_VERSION_MISMATCH");
    const tight = Object.freeze({ ...params, workUnitsPerMs: 1 });
    expectRefusal(resolver.resolve(SCENARIOS.similar(1), catalog, tight), "RESOLVER_BUDGET");
    expectRefusal(resolver.resolve(SCENARIOS.similar(1), catalog, { ...params }), "PARAMS_INVALID");
    expectRefusal(resolver.resolve(SCENARIOS.similar(1), {}, params), "CATALOG_INVALID");
    for (const r of refusals) assert.ok(!("result" in r));

    assert.ok(catalog.lookup("capital", 23757).strength.dps > 0, "Archon fighters");
    assert.strictEqual(catalog.lookup("industrial", 20183).strength.dps, 0);
    assert.strictEqual(catalog.lookup("industrial", 2863).strength.dps, 0);
    const pat = okResult(SCENARIOS.stalemate(9));
    assert.strictEqual(pat.outcome, "BOTH_RETREAT");
    assert.deepStrictEqual(pat.destroyedShips, []);
    assert.deepStrictEqual(pat.survivingShips, []);
    assert.strictEqual(pat.diagnostics.endReason, "STALEMATE");
    assert.strictEqual(pat.objectiveAchieved, false);
  });

  test("R5 resolver isolation, model tables = schema enums", () => {
    const source = fs.readFileSync(RESOLVER_FILE, "utf8");
    const requires = new Set([...source.matchAll(/require\(\s*"([^"]+)"\s*\)/g)].map((m) => m[1]));
    assert.deepStrictEqual([...requires].sort(), ["../util/rng", "./contract"]);
    const banned = /Math\.(random|pow|exp|log|sin|cos|tan|sqrt|cbrt|hypot)|Date\.now|performance/;
    assert.ok(!banned.test(source), `banned call: ${(source.match(banned) || [])[0]}`);

    const { resolver, params } = setup();
    const { BATTLE_OBJECTIVES, OUTCOMES, ENVIRONMENTS } = require("../../lib/battle/schema");
    const { RESOLVER_MODEL_V1 } = require("../../lib/battle/resolverParams");
    const sorted = (xs) => [...xs].sort();
    assert.deepStrictEqual(sorted(Object.keys(resolver.OBJECTIVE_RULES)), sorted(BATTLE_OBJECTIVES));
    assert.deepStrictEqual(sorted(new Set(Object.values(resolver.END_OUTCOME))), sorted(OUTCOMES));
    assert.deepStrictEqual(sorted(resolver.ENVIRONMENT_KEYS), sorted(ENVIRONMENTS));
    assert.deepStrictEqual(sorted(Object.keys(RESOLVER_MODEL_V1.objectiveMorale)), sorted(BATTLE_OBJECTIVES));
    assert.deepStrictEqual(sorted(Object.keys(RESOLVER_MODEL_V1.escapeEnv)), sorted(ENVIRONMENTS));
    assert.strictEqual(resolver.RESOLVER_VERSION, "internal-v1");
    assert.ok(Object.isFrozen(params) && Object.isFrozen(params.model) && Object.isFrozen(params.limits));
    assert.strictEqual(params.limits.maxResultBytes, 131072);
  });

  bench("R5b resolver benchmark (informative): 1000 medium battles, avg < battle.maxResolutionMs", () => {
    const { resolver, params, catalog, scenarios, config } = setup();
    const { createRng } = require("../../lib/util/rng");
    const { validateInput } = require("../../lib/battle/contract");
    const rng = createRng(2026);
    const inputs = [];
    for (let n = 0; n < 1000; n += 1) inputs.push(scenarios.mediumBattle(rng, n));
    let units = 0;
    for (const input of inputs) units += resolver.estimateWorkUnits(validateInput(input, params.limits).input, params);
    const t0 = performance.now();
    for (const input of inputs) assert.strictEqual(resolver.resolve(input, catalog, params).ok, true);
    const ms = performance.now() - t0;
    const avg = ms / inputs.length;
    console.log(`resolver bench: 1000 battles, avg ${avg.toFixed(3)} ms, ${Math.round(units / ms)} units/ms`);
    assert.ok(avg < config.battle.maxResolutionMs, `avg ${avg} ms`);
  });
};
