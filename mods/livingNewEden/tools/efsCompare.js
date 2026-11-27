"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { performance } = require("node:perf_hooks");

const { resolveConfig } = require("../config");
const { createStrengthCatalog } = require("../lib/battle/strength");
const { buildResolverParams } = require("../lib/battle/resolverParams");
const resolver = require("../lib/battle/resolverInternalV1");
const { createRng, deriveSeed } = require("../lib/util/rng");
const { BENCH_COMPOSITIONS } = require("../lib/fleets/data/benchProfile");
const scenarios = require("../test/battle/scenarios");

const MOD_DIR = path.resolve(__dirname, "..");
const RESULTS_VERSION = 1;
const DEFAULT_SEEDS = 1000;
const L1_RNG_SEED = 1;
const P95 = 0.95;
const OUTCOMES = ["A_WIN", "B_WIN", "DRAW", "BOTH_RETREAT"];

const benchSide = (i) => [{ ships: BENCH_COMPOSITIONS[i].map((e) => scenarios.ships(e.hullGroup, e.count)) }];
const benchPair = (i, j) => (seed) => scenarios.makeInput({ seed, sideA: benchSide(i), sideB: benchSide(j) });
const l1 = (seed) => ({ ...scenarios.mediumBattle(createRng(L1_RNG_SEED), 0), seed });

const BUILDERS = Object.freeze({
  S1: (seed) => scenarios.SCENARIOS.similar(seed),
  S2: (seed) => scenarios.SCENARIOS.outnumber(seed, false),
  S3: (seed) => scenarios.SCENARIOS.outnumber(seed, true),
  S4: (seed) => scenarios.SCENARIOS.logistics(seed, true),
  S5: (seed) => scenarios.SCENARIOS.logistics(seed, false),
  S6: (seed) => scenarios.SCENARIOS.carrierVsHauler(seed),
  S7: benchPair(0, 1),
  S8: benchPair(1, 2),
  S9: benchPair(2, 0),
  L1: l1,
});

const round3 = (v) => Math.round(v * 1000) / 1000;
const pctOf = (n, d) => (d > 0 ? Math.round((1000 * n) / d) / 10 : 0);

function pct(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
}

const flatten = (side) => side.fleets.flatMap((f) => f.composition.map((c) => ({ fleetId: f.fleetId,
  hullGroup: c.hullGroup, typeId: c.typeId, count: c.count })));

function exportScenarios() {
  return Object.keys(BUILDERS).map((id) => {
    const input = BUILDERS[id](1);
    return { id, input, sideA: flatten(input.sideA), sideB: flatten(input.sideB) };
  });
}

function typedInput(input, fitMap) {
  const mapSide = (side) => ({ ...side, fleets: side.fleets.map((f) => ({ ...f, composition: f.composition.map((c) =>
    (c.typeId === null && fitMap[c.hullGroup] ? { ...c, typeId: fitMap[c.hullGroup].typeID } : c)) })) });
  return { ...input, sideA: mapSide(input.sideA), sideB: mapSide(input.sideB) };
}

function lossFractions(input, result) {
  const total = (side) => side.fleets.reduce((s, f) => s + f.composition.reduce((t, c) => t + c.count, 0), 0);
  const fleetsA = new Set(input.sideA.fleets.map((f) => f.fleetId));
  let lostA = 0;
  let lostB = 0;
  for (const g of result.destroyedShips) {
    if (fleetsA.has(g.fleetId)) lostA += g.count;
    else lostB += g.count;
  }
  return { a: lostA / Math.max(1, total(input.sideA)), b: lostB / Math.max(1, total(input.sideB)) };
}

function runInternal(id, n, baseSeed, catalog, params, fitMap) {
  const counts = Object.fromEntries(OUTCOMES.map((o) => [o, 0]));
  let lossA = 0;
  let lossB = 0;
  let dur = 0;
  let ok = 0;
  const refusals = {};
  const ms = [];
  for (let i = 0; i < n; i += 1) {
    const base = BUILDERS[id](deriveSeed(baseSeed, "efs-compare", id, i));
    const input = fitMap ? typedInput(base, fitMap) : base;
    const t0 = performance.now();
    const r = resolver.resolve(input, catalog, params);
    ms.push(performance.now() - t0);
    if (!r.ok) {
      refusals[r.reason] = (refusals[r.reason] || 0) + 1;
      continue;
    }
    ok += 1;
    counts[r.result.outcome] += 1;
    const lf = lossFractions(input, r.result);
    lossA += lf.a;
    lossB += lf.b;
    dur += r.result.estimatedDurationSec;
  }
  const modal = OUTCOMES.reduce((best, o) => (counts[o] > counts[best] ? o : best), OUTCOMES[0]);
  return { n, ok, refusals, pct: Object.fromEntries(OUTCOMES.map((o) => [o, pctOf(counts[o], ok)])), modal,
    lossA: round3(lossA / Math.max(1, ok)), lossB: round3(lossB / Math.max(1, ok)),
    durationSec: round3(dur / Math.max(1, ok)), resolveP95Ms: round3(pct(ms, P95)) };
}

function checkResults(efs) {
  if (!efs || typeof efs !== "object") return "results is not an object";
  if (efs.v !== RESULTS_VERSION) return `results v ${efs.v} (expected ${RESULTS_VERSION})`;
  if (!Array.isArray(efs.scenarios)) return "results.scenarios missing";
  if (!efs.fitMap || typeof efs.fitMap !== "object") return "results.fitMap missing";
  const unknown = efs.scenarios.filter((s) => !Object.prototype.hasOwnProperty.call(BUILDERS, s && s.id));
  if (unknown.length > 0) return `unknown scenario id ${unknown.map((s) => s && s.id).join(",")}`;
  return null;
}

function defaultRun(efs, sc) {
  const runs = Array.isArray(sc.runs) ? sc.runs : [];
  if (runs.length === 0) return null;
  const byDistance = runs.find((r) => r.distance === efs.defaultDistance);
  return byDistance || runs[Math.floor(runs.length / 2)];
}

function compare(efs, opts) {
  const config = JSON.parse(JSON.stringify(resolveConfig({ modDir: MOD_DIR, env: {} }).config));
  const made = createStrengthCatalog(undefined, { groupConfidence: config.battle.strengthGroupConfidence,
    unknownTypeConfidence: config.battle.strengthUnknownTypeConfidence });
  const built = buildResolverParams(config);
  if (!made.ok || !built.ok) return { ok: false, reason: "catalog/params invalid" };
  const rows = [];
  for (const sc of efs.scenarios) {
    const group = runInternal(sc.id, opts.seeds, opts.seed, made.catalog, built.params, null);
    const typed = runInternal(sc.id, opts.seeds, opts.seed, made.catalog, built.params, efs.fitMap);
    const run = sc.skipped ? null : defaultRun(efs, sc);
    const agree = (iv) => (run ? { outcomeMatch: run.outcome === iv.modal,
      dLossA: round3(Math.abs(run.lossFractionA - iv.lossA)), dLossB: round3(Math.abs(run.lossFractionB - iv.lossB)) }
      : null);
    rows.push({ id: sc.id, skipped: sc.skipped || null, group, typed, efs: run ? { distance: run.distance,
      outcomes: (sc.runs || []).map((r) => `${r.outcome}@${Math.round(r.distance / 1000)}km`), outcome: run.outcome,
      lossA: round3(run.lossFractionA), lossB: round3(run.lossFractionB), simTimeSec: round3(run.simTimeSec),
      wallMs: round3(run.wallMs) } : null, agreeGroup: agree(group), agreeTyped: agree(typed) });
  }
  return { ok: true, seeds: opts.seeds, seed: opts.seed, efsCommit: efs.efsCommit || null, efsNode: efs.node || null,
    fitMap: efs.fitMap, rows };
}

function markdown(cmp) {
  const out = [];
  const iv = (r) => `${r.pct.A_WIN}/${r.pct.B_WIN}/${r.pct.DRAW}/${r.pct.BOTH_RETREAT} | ${r.lossA}/${r.lossB} | `
    + `${r.durationSec} | ${r.resolveP95Ms}`;
  out.push(`internal-v1, ${cmp.seeds} seeds (A_WIN/B_WIN/DRAW/BOTH_RETREAT %, losses A/B, time s, resolve p95 ms):`);
  out.push("");
  out.push("| id | group: outcomes % | losses A/B | time s | p95 ms | typed: outcomes % | losses A/B | time s | p95 ms |");
  out.push("|---|---|---|---|---|---|---|---|---|");
  for (const r of cmp.rows) out.push(`| ${r.id} | ${iv(r.group)} | ${iv(r.typed)} |`);
  out.push("");
  out.push("EFS (default distance) vs the modal internal-v1 outcome:");
  out.push("");
  out.push("| id | EFS outcomes (distance variants) | EFS losses A/B | EFS sim time s | EFS ms/sim | group agreement "
    + "(outcome, ΔA, ΔB) | typed agreement (outcome, ΔA, ΔB) |");
  out.push("|---|---|---|---|---|---|---|");
  const ag = (a) => (a ? `${a.outcomeMatch ? "yes" : "NO"}, ${a.dLossA}, ${a.dLossB}` : "-");
  for (const r of cmp.rows) {
    if (!r.efs) {
      out.push(`| ${r.id} | skipped: ${r.skipped || "no runs"} | - | - | - | - | - |`);
      continue;
    }
    out.push(`| ${r.id} | ${r.efs.outcomes.join(", ")} | ${r.efs.lossA}/${r.efs.lossB} | ${r.efs.simTimeSec} | `
      + `${r.efs.wallMs} | ${ag(r.agreeGroup)} | ${ag(r.agreeTyped)} |`);
  }
  return out.join("\n");
}

function parseArgs(argv) {
  const opts = { exportPath: null, efsPath: null, seeds: DEFAULT_SEEDS, seed: 1, json: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`${a} needs a value`);
      return argv[i];
    };
    if (a === "--export") opts.exportPath = next();
    else if (a === "--efs") opts.efsPath = next();
    else if (a === "--seeds") opts.seeds = Number(next());
    else if (a === "--seed") opts.seed = Number(next());
    else if (a === "--json") opts.json = next();
    else throw new Error(`unknown argument ${a}`);
  }
  if (!opts.exportPath && !opts.efsPath) throw new Error("--export <file> or --efs <file>");
  if (!Number.isSafeInteger(opts.seeds) || opts.seeds < 1) throw new Error("--seeds needs a positive integer");
  if (!Number.isSafeInteger(opts.seed) || opts.seed < 0) throw new Error("--seed needs an integer >= 0");
  return opts;
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
    if (opts.exportPath) {
      const list = exportScenarios();
      fs.mkdirSync(path.dirname(path.resolve(opts.exportPath)), { recursive: true });
      fs.writeFileSync(opts.exportPath, JSON.stringify(list, null, 2));
      process.stdout.write(`exported ${list.length} scenarios: ${list.map((s) => s.id).join(", ")}\n`);
    }
    if (opts.efsPath) {
      const efs = JSON.parse(fs.readFileSync(opts.efsPath, "utf8"));
      const bad = checkResults(efs);
      if (bad) throw new Error(bad);
      const cmp = compare(efs, opts);
      if (!cmp.ok) throw new Error(cmp.reason);
      process.stdout.write(`${markdown(cmp)}\n`);
      if (opts.json) fs.writeFileSync(opts.json, JSON.stringify(cmp, null, 2));
    }
  } catch (err) {
    process.stdout.write(`efs-compare: FAIL ${err.message}\n`);
    process.exitCode = 1;
    return;
  }
  process.stdout.write("efs-compare: OK\n");
}

if (require.main === module) main();

module.exports = { BUILDERS, exportScenarios, typedInput, compare, checkResults, markdown };
