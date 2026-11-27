#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const config = require("../../config");
const { parseComposeEnv } = require("../liveSim/compose");
const { mergeComposeEnvFile } = require("../liveSim/profile");
const { rowBoundsOfConfig, rowBoundOverflow, BOUND_NAMES } = require("../../lib/strategy/reviewBound");

const MOD_DIR = path.resolve(__dirname, "..", "..");
const DEFAULT_COMPOSE = "compose.yaml";
const MOD_DEFAULT_LIMIT = 1000;
const MAX_LIMIT = 10000;
const ON = "1";
const ROW_WARNING_RE = / may write \d+ rows > /;
const ENV_NAME_RE = /EVEJS_LNE_[A-Z0-9_]+/g;

const DOCKER_KNOWN_ON = Object.freeze([
  "EVEJS_LNE_INVASIONS_REVIEW_FOOTHOLDS_ENABLED",
  "EVEJS_LNE_INVASIONS_REFIT_AT_FOOTHOLD_ENABLED",
  "EVEJS_LNE_INVASIONS_HOME_BASE_ENABLED",
  "EVEJS_LNE_INVASIONS_REFIT_AT_HOME_ENABLED",
  "EVEJS_LNE_FORTRESS_ROUTE_AVERSION_ENABLED",
  "EVEJS_LNE_FORTRESS_CHECKPOINT_ENABLED",
  "EVEJS_LNE_FORTRESS_HALT_MEMORY_ENABLED",
  "EVEJS_LNE_STRATEGY_BLOCKADE_ENABLED",
  "EVEJS_LNE_STRATEGY_ATTACK_LOSS_MEMORY_ENABLED",
  "EVEJS_LNE_STRATEGY_ATTACK_LOSS_ISK_GATE_ENABLED",
  "EVEJS_LNE_HUNT_ENABLED",
  "EVEJS_LNE_GRID_ENABLED",
  "EVEJS_LNE_GRID_MOVES_ENABLED",
  "EVEJS_LNE_BATTLE_GRID_CONTACTS_ENABLED",
  "EVEJS_LNE_GRID_DEFENSE_ENABLED",
  "EVEJS_LNE_GRID_CROSSINGS_ENABLED",
  "EVEJS_LNE_GRID_CROSSINGS_BLOCKADE_GATE_ENABLED",
  "EVEJS_LNE_SIEGE_GRID_ENABLED",
  "EVEJS_LNE_SENTRIES_BATTLE_GRID_ENABLED",
  "EVEJS_LNE_MATERIALIZATION_GRID_ANCHOR_ENABLED",
  "EVEJS_LNE_GRID_DEFENSE_STRIKE_PURSUIT_ENABLED",
]);

const ENABLE_BATCH_ON = Object.freeze([
  "EVEJS_LNE_INVADER_ECONOMY_ENABLED",
  "EVEJS_LNE_INVADER_ECONOMY_HOME_POOL_ENABLED",
  "EVEJS_LNE_INVADER_ECONOMY_CONDUIT_ENABLED",
  "EVEJS_LNE_INVADER_ECONOMY_RAIDS_ENABLED",
  "EVEJS_LNE_STRATEGY_HQ_GARRISON_ENABLED",
]);

const WORST_FLAGS = Object.freeze([
  "modules.strategy.enabled",
  "mining.enabled",
  "production.enabled",
  "production.industryEnabled",
  "upkeep.enabled",
  "logistics.enabled",
  "logistics.needsHulls",
  "logistics.replenishEnabled",
  "logistics.replenishReturnEnabled",
  "logistics.retireEnabled",
  "logistics.strandedReturnEnabled",
  "construction.enabled",
  "stations.enabled",
  "siege.enabled",
  "siege.reliefEnabled",
  "trade.enabled",
  "trade.wtsEnabled",
  "strategy.defenseEnabled",
  "tribute.enabled",
  "treasury.enabled",
  "strategy.mergeEnabled",
  "sentries.enabled",
  "sentries.faction.enabled",
  "strategy.territoryTrimEnabled",
  "strategy.garrisonReleaseEnabled",
  "strategy.strandedReturnEnabled",
  "strategy.borderPostsEnabled",
  "strategy.blockadeEnabled",
  "strategy.interceptEnabled",
  "grid.enabled",
  "grid.movesEnabled",
  "grid.defense.enabled",
  "grid.crossings.enabled",
  "grid.crossings.blockadeGateEnabled",
  "fortress.checkpointEnabled",
]);

const SCENARIOS = Object.freeze(["compose", "docker-known", "docker-known+enable", "worst"]);
const REC_SCENARIOS = Object.freeze(["docker-known", "docker-known+enable"]);
const PROCESS_ENV = "process-env";
const DEFAULT_REC = Object.freeze({ floor: 1200, margin: 0.10, step: 100 });

const USAGE = "usage: node mods/livingNewEden/tools/measure/rowBoundProbe.js [--compose compose.yaml] "
  + "[--env-file <file>] [--process-env] [--json <file>]";

class UsageError extends Error {}

function isNum(v) {
  return typeof v === "number" && Number.isFinite(v);
}

function envOfKey(key) {
  const row = config.SCHEMA.find((r) => r.key === key);
  return row ? row.env : null;
}

function valueAt(obj, key) {
  return key.split(".").reduce((o, k) => (o && typeof o === "object" ? o[k] : undefined), obj);
}

function flagsOn(cfg) {
  const keys = new Set(WORST_FLAGS);
  for (const env of [...DOCKER_KNOWN_ON, ...ENABLE_BATCH_ON]) {
    const row = config.SCHEMA.find((r) => r.env === env);
    if (row) keys.add(row.key);
  }
  return [...keys].filter((k) => valueAt(cfg, k) === true).sort();
}

function probeConfig(cfg, limits, warnings) {
  const bounds = rowBoundsOfConfig(cfg);
  let max = { name: null, value: null };
  for (const name of BOUND_NAMES) {
    const v = bounds[name];
    if (isNum(v) && (max.value === null || v > max.value)) max = { name, value: v };
  }
  const p = cfg && cfg.persistence;
  const limit = p && Number.isSafeInteger(p.maxRowsPerTransaction) ? p.maxRowsPerTransaction : null;
  const overflow = {};
  for (const l of Array.isArray(limits) ? limits : []) {
    if (Number.isSafeInteger(l) && l > 0) overflow[String(l)] = rowBoundOverflow(bounds, l);
  }
  const rowWarnings = (Array.isArray(warnings) ? warnings : []).filter((w) => typeof w === "string"
    && ROW_WARNING_RE.test(w));
  return { bounds, max, limit, overflow, rowWarnings };
}

function recommendLimit(maxBound, opts = DEFAULT_REC) {
  const o = { ...DEFAULT_REC, ...(opts || {}) };
  if (!isNum(maxBound) || maxBound < 0) return o.floor;
  const perMille = Math.round((1 + o.margin) * 1000);
  const rec = Math.ceil((maxBound * perMille) / (1000 * o.step)) * o.step;
  return Math.min(MAX_LIMIT, Math.max(o.floor, rec));
}

function scenarioEnv(name, baseEnv) {
  const at = SCENARIOS.indexOf(name);
  if (at < 0) return null;
  const env = { ...(baseEnv || {}) };
  if (at >= 1) for (const n of DOCKER_KNOWN_ON) env[n] = ON;
  if (at >= 2) for (const n of ENABLE_BATCH_ON) env[n] = ON;
  if (at >= 3) {
    for (const key of WORST_FLAGS) {
      const n = envOfKey(key);
      if (n) env[n] = ON;
    }
  }
  return env;
}

function parseArgs(argv) {
  const out = { compose: path.resolve(DEFAULT_COMPOSE), envFile: null, processEnv: false, json: null };
  const file = (a, v) => {
    if (typeof v !== "string" || v === "" || v.startsWith("--")) throw new UsageError(`${a} needs a file`);
    return path.resolve(v);
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const v = argv[i + 1];
    if (a === "--process-env") {
      out.processEnv = true;
      continue;
    }
    if (a === "--compose") out.compose = file(a, v);
    else if (a === "--env-file") out.envFile = file(a, v);
    else if (a === "--json") out.json = file(a, v);
    else throw new UsageError(`unknown argument ${a}`);
    i += 1;
  }
  if (out.processEnv && out.envFile) throw new UsageError("--env-file is for the offline scenarios, not --process-env");
  return out;
}

function errorNames(errors) {
  const names = new Set();
  for (const e of errors || []) for (const m of String(e).match(ENV_NAME_RE) || []) names.add(m);
  return [...names].sort();
}

function readText(file, what) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new UsageError(`missing ${what}: ${file}`);
  return fs.readFileSync(file, "utf8");
}

const fmt = (v) => (v === null || v === undefined ? "-" : String(v));

function scenarioLines(s) {
  const b = s.bounds;
  const lines = [`scenario ${s.name}: ${BOUND_NAMES.map((n) => `${n}=${fmt(b[n])}`).join(" ")}; max ${fmt(s.max.name)}`
    + `=${fmt(s.max.value)}; limit ${fmt(s.limit)}`];
  for (const [l, o] of Object.entries(s.overflow)) lines.push(`  overflow @${l}: ${o === null ? "none" : o}`);
  lines.push(`  flags on (${s.flagsOn.length}): ${s.flagsOn.join(", ") || "-"}`);
  lines.push(`  row warnings: ${s.rowWarnings.length}`);
  for (const w of s.rowWarnings) lines.push(`    ${w}`);
  return lines;
}

function main(argv, io = {}) {
  const out = io.out || ((s) => process.stdout.write(`${s}\n`));
  const err = io.err || ((s) => process.stderr.write(`${s}\n`));
  let args;
  const resolved = [];
  try {
    args = parseArgs(argv);
    if (args.processEnv) {
      const loadOpts = { env: io.env || process.env };
      if (io.modDir) loadOpts.modDir = io.modDir;
      resolved.push({ name: PROCESS_ENV, result: config.loadConfig(loadOpts) });
    } else {
      const parsed = parseComposeEnv(readText(args.compose, "compose file"));
      if (!parsed.ok) throw new UsageError(`compose: ${parsed.detail}`);
      let base = parsed.values;
      if (args.envFile) {
        const envFile = config.parseEnvFile(readText(args.envFile, "env file")).values;
        base = mergeComposeEnvFile(parsed.values, parsed.entries, envFile, new Set()).layer;
      }
      for (const name of SCENARIOS) {
        resolved.push({ name, result: config.resolveConfig({ env: scenarioEnv(name, base), modDir: io.modDir || MOD_DIR }) });
      }
    }
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    err(`rowBoundProbe: ${e.message} (${USAGE})`);
    return 1;
  }
  for (const r of resolved) {
    const errors = r.result && Array.isArray(r.result.errors) ? r.result.errors : ["no config"];
    if (errors.length > 0 || !r.result.config) {
      err(`rowBoundProbe: ${r.name}: ${errors.length} config errors (names: ${errorNames(errors).join(", ") || "-"})`);
      return 2;
    }
  }
  const first = resolved.map((r) => ({ name: r.name, probe: probeConfig(r.result.config, [], []) }));
  const recFrom = args.processEnv ? [PROCESS_ENV] : [...REC_SCENARIOS];
  const recBound = Math.max(...first.filter((f) => recFrom.includes(f.name)).map((f) => f.probe.max.value)
    .filter(isNum), 0);
  const rec = recommendLimit(recBound);
  const scenarios = resolved.map((r) => {
    const cfg = r.result.config;
    const limits = [...new Set([MOD_DEFAULT_LIMIT, cfg.persistence.maxRowsPerTransaction, rec])];
    return { name: r.name, flagsOn: flagsOn(cfg), ...probeConfig(cfg, limits, r.result.warnings) };
  });
  const lines = [];
  for (const s of scenarios) lines.push(...scenarioLines(s));
  lines.push(`rec ${rec} (: max(1200, ceil(1.1 x ${recBound} / 100) x 100), from ${recFrom.join(", ")})`);
  const worst = scenarios.find((s) => s.name === "worst");
  const worstAboveRec = Boolean(worst && isNum(worst.max.value) && worst.max.value > rec);
  if (worst) lines.push(`worst max ${fmt(worst.max.value)} ${worstAboveRec ? ">" : "<="} rec ${rec} (report only)`);
  out(lines.join("\n"));
  if (args.json) {
    fs.mkdirSync(path.dirname(args.json), { recursive: true });
    fs.writeFileSync(args.json, `${JSON.stringify({ tool: "rowBoundProbe", mode: args.processEnv ? PROCESS_ENV
      : "offline", compose: args.processEnv ? null : path.basename(args.compose), envFile: Boolean(args.envFile),
    lists: { DOCKER_KNOWN_ON, ENABLE_BATCH_ON, WORST_FLAGS }, scenarios, rec, recBound, recFrom, worstAboveRec },
    null, 2)}\n`);
  }
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { probeConfig, recommendLimit, scenarioEnv, parseArgs, main, SCENARIOS, DOCKER_KNOWN_ON,
  ENABLE_BATCH_ON, WORST_FLAGS };
