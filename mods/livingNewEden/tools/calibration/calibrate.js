"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { performance } = require("node:perf_hooks");
const { CALIBRATION_METHOD } = require("./method");
const { evaluate } = require("./metrics");
const { search } = require("./search");
const { resolveConfig } = require("../../config");
const { createStrengthCatalog } = require("../../lib/battle/strength");
const resolver = require("../../lib/battle/resolverInternalV1");
const { BUILDERS } = require("../efsCompare");
const scenarios = require("../../test/battle/scenarios");

const MOD_DIR = path.join(__dirname, "..", "..");
const REPO_ROOT = path.join(MOD_DIR, "..", "..");
const DEFAULTS = {
  dataset: path.join(REPO_ROOT, "Kanban", "research", "m5-calibration", "battles-v1.json"),
  efs: path.join(REPO_ROOT, "_local", "research", "efs", "out", "efs-results.json"),
  out: path.join(REPO_ROOT, "Kanban", "research", "m5-calibration", "calibration-result.json"),
};
const KNOB_KEYS = [...new Set(CALIBRATION_METHOD.search.steps.flatMap((s) => s.knobs))];
const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const r4 = (v) => (v === null || v === undefined ? v : Number(v.toFixed(4)));

function parseArgs(argv) {
  const args = { ...DEFAULTS, report: false, result: DEFAULTS.out };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const v = argv[i + 1];
    if (a === "--report") args.report = true;
    else if (["--dataset", "--efs", "--out", "--result"].includes(a) && v) { args[a.slice(2)] = path.resolve(v); i += 1; }
    else throw new Error(`unknown argument ${a}`);
  }
  return args;
}

function setup(args) {
  const config = resolveConfig({ modDir: MOD_DIR, env: {} }).config;
  const made = createStrengthCatalog(undefined, { groupConfidence: config.battle.strengthGroupConfidence,
    unknownTypeConfidence: config.battle.strengthUnknownTypeConfidence });
  if (!made.ok) throw new Error(`strength catalog ${made.reason}`);
  const datasetBytes = fs.readFileSync(args.dataset);
  const dataset = JSON.parse(datasetBytes.toString("utf8"));
  const efsBytes = fs.existsSync(args.efs) ? fs.readFileSync(args.efs) : null;
  const efs = efsBytes ? JSON.parse(efsBytes.toString("utf8")) : null;
  const split = (name) => ({ battles: dataset.battles.filter((b) => b.split === name) });
  const ctx = { method: CALIBRATION_METHOD, resolver, catalog: made.catalog, config, efsBuilders: BUILDERS, scenarios };
  const start = Object.fromEntries(KNOB_KEYS.map((k) => [k, config.battle[k]]));
  return { ctx, dataset, efs, train: split("train"), validation: split("validation"), start,
    datasetSha256: sha256(datasetBytes), efsResultsSha256: efsBytes ? sha256(efsBytes) : null };
}

function summary(ev) {
  const perClass = {};
  for (const [name, m] of Object.entries(ev.perClass)) {
    perClass[name] = { battles: m.battles, weight: m.weight, lowData: m.lowData, score: r4(m.score),
      w1Strong: r4(m.w1Strong), w1Weak: r4(m.w1Weak), dWin: r4(m.dWin), dNotDestroyed: r4(m.dNotDestroyed),
      obs: Object.fromEntries(Object.entries(m.obs).map(([k, v]) => [k, r4(v)])),
      sim: Object.fromEntries(Object.entries(m.sim).map(([k, v]) => [k, r4(v)])) };
  }
  const efs = ev.efs ? { score: r4(ev.efs.score), winnerMiss: ev.efs.winnerMiss,
    meanDurationMiss: r4(ev.efs.meanDurationMiss), meanDLossWinner: r4(ev.efs.meanDLossWinner),
    rows: ev.efs.rows.map((r) => ({ ...r, drawShare: r4(r.drawShare), durationMiss: r4(r.durationMiss),
      dLossWinner: r4(r.dLossWinner), medianDurationSec: r4(r.medianDurationSec) })) } : null;
  return { J: r4(ev.J), battles: ev.battles, refusals: ev.refusals, perClass, efs };
}

function table(title, before, after) {
  const out = [`${title}`, "", "| class | battles | weight | obs losses S/W | before sim S/W | after sim S/W | obs not destr. W | "
    + "before | after | obs win S | before | after | class score before | after |", "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|"];
  for (const name of Object.keys(before.perClass)) {
    const b = before.perClass[name];
    const a = after.perClass[name];
    const flag = b.lowData ? " (too little data)" : "";
    out.push(`| ${name}${flag} | ${b.battles} | ${b.weight} | ${b.obs.lossStrong}/${b.obs.lossWeak} | `
      + `${b.sim.lossStrong}/${b.sim.lossWeak} | ${a.sim.lossStrong}/${a.sim.lossWeak} | ${b.obs.notDestroyedWeak} | `
      + `${b.sim.notDestroyedWeak} | ${a.sim.notDestroyedWeak} | ${b.obs.winStrong} | ${b.sim.winStrong} | `
      + `${a.sim.winStrong} | ${b.score} | ${a.score} |`);
  }
  out.push("", `J before ${before.J}, after ${after.J}`);
  if (before.efs && after.efs) {
    out.push("", "| EFS | EFS majority | before modal / DRAW | after modal / DRAW | durationMiss before/after | ΔwinnerLoss before/after |",
      "|---|---|---|---|---|---|");
    for (let i = 0; i < before.efs.rows.length; i += 1) {
      const b = before.efs.rows[i];
      const a = after.efs.rows[i];
      out.push(`| ${b.id} | ${b.efsMajority || "-"} | ${b.modal} / ${b.drawShare} | ${a.modal} / ${a.drawShare} | `
        + `${b.durationMiss}/${a.durationMiss} | ${b.dLossWinner === null ? "-" : b.dLossWinner}/`
        + `${a.dLossWinner === null ? "-" : a.dLossWinner} |`);
    }
    out.push("", `EFS: winnerMiss ${before.efs.winnerMiss} -> ${after.efs.winnerMiss}, score ${before.efs.score} -> `
      + `${after.efs.score}`);
  }
  return out.join("\n");
}

function main(argv) {
  const args = parseArgs(argv);
  const s = setup(args);
  if (args.report) {
    const result = JSON.parse(fs.readFileSync(args.result, "utf8"));
    const before = summary(evaluate(s.validation, s.efs, result.before.knobs, s.ctx));
    const after = summary(evaluate(s.validation, s.efs, result.after.knobs, s.ctx));
    process.stdout.write(`${table("Validation (split validation)", before, after)}\n`);
    return 0;
  }
  const t0 = performance.now();
  let evals = 0;
  const ctx = { ...s.ctx, evaluate: (...a) => { evals += 1; return evaluate(...a); },
    log: (line) => process.stdout.write(`${line} (${((performance.now() - t0) / 1000).toFixed(1)} s)\n`) };
  const r = search(s.train, s.efs, s.start, ctx);
  const validation = { before: summary(evaluate(s.validation, s.efs, s.start, s.ctx)),
    after: summary(evaluate(s.validation, s.efs, r.best, s.ctx)) };
  const result = {
    calibrationMethod: CALIBRATION_METHOD.version,
    datasetSha256: s.datasetSha256,
    efsResultsSha256: s.efsResultsSha256,
    strengthSourceHash: s.ctx.catalog.header.sourceHash,
    counts: { train: s.train.battles.length, validation: s.validation.battles.length },
    before: { knobs: s.start, ...summary(r.before) },
    after: { knobs: r.best, ...summary(r.after) },
    validation,
    path: r.path.map((p) => ({ ...p, J: r4(p.J) })),
    guards: { checked: r.guards.checked, rejected: r.guards.rejected, rejectedSample: r.guards.rejectedSample,
      start: r.guards.start, final: r.guards.final },
  };
  fs.mkdirSync(path.dirname(args.out), { recursive: true });
  fs.writeFileSync(args.out, `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`search: ${evals} evaluations, ${r.guards.checked} guard checks, `
    + `${((performance.now() - t0) / 1000).toFixed(1)} s -> ${args.out}\n`);
  process.stdout.write(`knobs before ${JSON.stringify(s.start)}\nknobs after  ${JSON.stringify(r.best)}\n\n`);
  process.stdout.write(`${table("Training (split train)", result.before, result.after)}\n\n`);
  process.stdout.write(`${table("Validation (split validation)", validation.before, validation.after)}\n`);
  return 0;
}

try {
  process.exitCode = main(process.argv.slice(2));
  process.stdout.write("calibration: OK\n");
} catch (err) {
  process.stderr.write(`${(err && err.stack) || err}\n`);
  process.stdout.write(`calibration: FAIL ${(err && err.message) || err}\n`);
  process.exitCode = 1;
}
