"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { performance } = require("node:perf_hooks");

const { resolveConfig } = require("../config");
const { createStrengthCatalog } = require("../lib/battle/strength");
const { buildResolverParams } = require("../lib/battle/resolverParams");
const resolver = require("../lib/battle/resolverInternalV1");
const { fingerprint } = require("../lib/util/fingerprint");
const { createRng, deriveSeed } = require("../lib/util/rng");
const { BENCH_COMPOSITIONS } = require("../lib/fleets/data/benchProfile");
const { checkBattleInvariants } = require("../lib/battle/checks");
const bench = require("./benchScheduler");

const MOD_DIR = path.resolve(__dirname, "..");
const MAX_SIDE_FLEETS = 8;
const DETERMINISM_SAMPLES = 100;
const BALANCE_SEEDS = 1000;
const BALANCE_MAX_GAP = 0.1;
const PASS_MAX_BATTLES = 2500;
const PASS_FLEET_LIMIT = 5000;
const PASS_MAX_PASSES = 100000;
const QUOTA_MIN = 2;
const QUOTA_MAX = 16;
const QUOTA_SHARE = 0.5;
const FACTION_A = 500019;
const FACTION_B = 500010;
const P50 = 0.5;
const P95 = 0.95;

const round3 = (v) => Math.round(v * 1000) / 1000;

function pct(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
}

const stats = (values) => ({ p50: round3(pct(values, P50)), p95: round3(pct(values, P95)),
  max: round3(values.length ? Math.max(...values) : 0) });

function defaults() {
  return JSON.parse(JSON.stringify(resolveConfig({ modDir: MOD_DIR, env: {} }).config));
}

function syntheticInput(scenarios, seed, i) {
  const k = 1 + (i % MAX_SIDE_FLEETS);
  const side = (offset) => Array.from({ length: k }, (_v, j) => ({
    ships: BENCH_COMPOSITIONS[(i + j + offset) % BENCH_COMPOSITIONS.length].map((e) => ({ hullGroup: e.hullGroup,
      typeId: null, count: e.count })) }));
  return scenarios.makeInput({ seed: deriveSeed(seed, "bench-battles", i), battleNo: i + 1, sideA: side(0),
    sideB: side(1) });
}

function runPure(n, seed) {
  const config = defaults();
  const scenarios = require("../test/battle/scenarios");
  const made = createStrengthCatalog(undefined, { groupConfidence: config.battle.strengthGroupConfidence,
    unknownTypeConfidence: config.battle.strengthUnknownTypeConfidence });
  const built = buildResolverParams(config);
  if (!made.ok || !built.ok) return { mode: "pure", n, failures: ["catalog/params invalid"] };
  const ms = [];
  const work = [];
  const refusals = {};
  const prints = [];
  for (let i = 0; i < n; i += 1) {
    const input = syntheticInput(scenarios, seed, i);
    const t0 = performance.now();
    const r = resolver.resolve(input, made.catalog, built.params);
    ms.push(performance.now() - t0);
    if (!r.ok) {
      refusals[r.reason] = (refusals[r.reason] || 0) + 1;
      if (i < DETERMINISM_SAMPLES) prints.push(r.reason);
      continue;
    }
    work.push(r.result.diagnostics.workUnits);
    if (i < DETERMINISM_SAMPLES) prints.push(fingerprint(r.result));
  }
  let mismatches = 0;
  for (let i = 0; i < Math.min(n, DETERMINISM_SAMPLES); i += 1) {
    const r = resolver.resolve(syntheticInput(scenarios, seed, i), made.catalog, built.params);
    if ((r.ok ? fingerprint(r.result) : r.reason) !== prints[i]) mismatches += 1;
  }
  const outcomes = { A_WIN: 0, B_WIN: 0, DRAW: 0, BOTH_RETREAT: 0 };
  const seeds = BALANCE_SEEDS;
  for (let s = 1; s <= seeds; s += 1) {
    const r = resolver.resolve(scenarios.SCENARIOS.similar(s), made.catalog, built.params);
    if (r.ok) outcomes[r.result.outcome] += 1;
  }
  const gap = (outcomes.B_WIN - outcomes.A_WIN) / seeds;
  const resolveMs = stats(ms);
  const failures = [];
  if (mismatches > 0) failures.push(`pure ${n}: determinism ${mismatches} mismatches`);
  if (Math.abs(gap) > BALANCE_MAX_GAP) failures.push(`pure ${n}: balance B-A ${round3(gap * 100)} pp`);
  if (resolveMs.p95 > config.battle.maxResolutionMs) failures.push(`pure ${n}: resolve p95 ${resolveMs.p95} ms`);
  return { mode: "pure", n, resolveMs, workUnitsP95: pct(work, P95), refusals, determinism: { samples:
    Math.min(n, DETERMINISM_SAMPLES), mismatches }, balance: { seeds, ...outcomes, gapPp: round3(gap * 100),
    pass: Math.abs(gap) <= BALANCE_MAX_GAP }, failures };
}

async function runPass(n, seed) {
  const failures = [];
  if (n > PASS_MAX_BATTLES) return { mode: "pass", n, failures: [`pass ${n}: above ${PASS_MAX_BATTLES} (2N fleets)`] };
  const driver = bench.loadDriver();
  if (!driver.ok) return { mode: "pass", n, failures: [`pass: driver ${driver.reason}`] };
  const opts = { ...bench.DEFAULTS, memory: true, fleets: 0, hours: 0, seed, mapSystems: Math.max(n, 12),
    battles: true, set: {} };
  const config = bench.benchConfig(opts, { "limits.maxVirtualFleets": PASS_FLEET_LIMIT });
  const env = bench.createEnv(driver, opts, config);
  try {
    const systems = env.graph.getSystemIds().slice(0, n);
    for (const [i, sys] of systems.entries()) {
      for (const [tag, factionId] of [["a", FACTION_A], ["b", FACTION_B]]) {
        const r = env.fleets.createFleet({ factionId, currentSystemId: sys, homeSystemId: sys, fleetRole: "patrol",
          composition: BENCH_COMPOSITIONS[(i + (tag === "a" ? 0 : 1)) % BENCH_COMPOSITIONS.length]
            .map((e) => ({ ...e })) }, `bench-battles:${tag}:${i}`);
        if (!r.ok) throw new Error(`createFleet ${JSON.stringify(r)}`);
      }
    }
    const now = env.clock.now();
    const specs = systems.map((sys) => ({ eventType: "BATTLE_CONTACT_CHECK", aggregateId: sys, dueAt: now,
      payload: { systemId: sys, at: now, triggerFleetId: null }, idempotencyKey: `contact:${sys}:bench:v1` }));
    const chunk = env.store.limits.maxRowsPerTransaction;
    for (let i = 0; i < specs.length; i += chunk) {
      const r = env.scheduler.enqueueMany(specs.slice(i, i + chunk));
      if (!r.ok || r.refusal) throw new Error(`enqueueMany ${JSON.stringify(r)}`);
    }
    const interval = config.scheduler.intervalMs;
    const settledCount = () => env.telemetry.counts["battle.resolution.settled"] || 0;
    for (let i = 0; i < PASS_MAX_PASSES && env.n("SELECT count(*) AS n FROM battle_records") < n; i += 1) {
      const r = await env.scheduler.runPass();
      if (!r.ok) throw new Error(`pass ${JSON.stringify(r)}`);
      env.afterPass();
      if (env.n("SELECT count(*) AS n FROM world_scheduled_events WHERE event_type = 'BATTLE_CONTACT_CHECK' "
        + "AND state <> 'DONE'") === 0) break;
    }
    const created = env.n("SELECT count(*) AS n FROM battle_records");
    if (created !== n) failures.push(`pass ${n}: ${created} battles created`);
    env.clock.set(now + config.battle.engageDelayMs);
    const changes = () => env.q("SELECT total_changes() AS n")[0].n;
    const rows0 = changes();
    const passMs = [];
    const perPass = [];
    const costs = [];
    const writes = [];
    let passes = 0;
    const open = () => env.n("SELECT count(*) AS n FROM battle_records WHERE created_at <= ? AND state NOT IN "
      + "('COMPLETED', 'FAILED', 'QUARANTINED')", now);
    for (let i = 0; i < PASS_MAX_PASSES && open() > 0; i += 1) {
      const before = settledCount();
      const r = await env.scheduler.runPass();
      if (!r.ok) throw new Error(`pass ${JSON.stringify(r)}`);
      env.afterPass();
      env.clock.advance(interval);
      if (r.skipped) continue;
      passes += 1;
      const battles = settledCount() - before;
      passMs.push(r.workMs);
      perPass.push(battles);
      if (battles > 0 && battles === r.jobs) {
        costs.push(r.workMs / r.jobs);
        writes.push(r.writeMs / r.jobs);
      }
    }
    const rows = changes() - rows0;
    const settled = settledCount();
    const windowEnd = now + config.battle.engageDelayMs + config.battle.recontactCooldownMs;
    for (let i = 0; i < PASS_MAX_PASSES && env.clock.now() < windowEnd; i += 1) {
      const r = await env.scheduler.runPass();
      if (!r.ok) throw new Error(`pass ${JSON.stringify(r)}`);
      env.afterPass();
      const t = env.clock.now();
      const next = env.scheduler.getStatus().nextDueAt;
      if (!r.skipped && r.jobs > 0) env.clock.set(Math.min(windowEnd, t + interval));
      else env.clock.set(Math.min(windowEnd, next === null || next <= t ? t + interval : next));
    }
    const windowBattles = env.n("SELECT count(*) AS n FROM battle_records");
    if (windowBattles !== created) failures.push(`pass ${n}: ${windowBattles} battles in the cooldown window (chase)`);
    const read = env.store.transaction("bench.battles", (db) => checkBattleInvariants(db));
    const inv = read.ok ? read.value : { ok: false, reason: read.reason };
    if (!inv.ok || !inv.pass) failures.push(`pass ${n}: invariants ${JSON.stringify(inv)}`);
    const costP95 = pct(costs, P95);
    const quota = costP95 > 0 ? Math.min(QUOTA_MAX, Math.max(QUOTA_MIN,
      Math.floor((QUOTA_SHARE * config.limits.maxSchedulerWorkMs) / costP95))) : QUOTA_MAX;
    return { mode: "pass", n, battles: created, settled, passes, windowBattles,
      battlesPerPair: round3(windowBattles / Math.max(1, n)), battlesPerPass: { p50: pct(perPass, P50),
      max: perPass.length ? Math.max(...perPass) : 0 }, passMs: stats(passMs), battleEventCostMs: stats(costs),
    battleEventWriteMs: stats(writes), battlePassesSampled: costs.length, rowsPerBattle: round3(rows / Math.max(1, settled)),
    quotaSuggested: quota, quotaConfigured: config.limits.maxBattleResolutionsPerPass,
    maxSchedulerWorkMs: config.limits.maxSchedulerWorkMs, invariants: inv, failures };
  } finally {
    env.close();
  }
}

function parseArgs(argv) {
  const opts = { battles: 1000, mode: "pure", seed: 1, json: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`${a} needs a value`);
      return argv[i];
    };
    if (a === "--battles") opts.battles = Number(next());
    else if (a === "--mode") opts.mode = next();
    else if (a === "--seed") opts.seed = Number(next());
    else if (a === "--json") opts.json = next();
    else throw new Error(`unknown argument ${a}`);
  }
  if (!Number.isSafeInteger(opts.battles) || opts.battles < 1) throw new Error("--battles needs a positive integer");
  if (!["pure", "pass", "all"].includes(opts.mode)) throw new Error("--mode pure|pass|all");
  return opts;
}

async function runBattles(opts) {
  const results = [];
  try {
    if (opts.mode === "pure" || opts.mode === "all") results.push(runPure(opts.battles, opts.seed));
    if (opts.mode === "pass" || opts.mode === "all") {
      results.push(await runPass(Math.min(opts.battles, PASS_MAX_BATTLES), opts.seed));
    }
  } catch (err) {
    return { ok: false, failures: [`error: ${(err && err.stack) || err}`], results };
  }
  const failures = results.flatMap((r) => r.failures || []);
  return { ok: failures.length === 0, failures, results };
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stdout.write(`bench-battles: FAIL ${err.message}\n`);
    process.exitCode = 1;
    return;
  }
  const r = await runBattles(opts);
  for (const res of r.results) process.stdout.write(`${JSON.stringify(res)}\n`);
  if (opts.json) fs.writeFileSync(opts.json, JSON.stringify(r, null, 2));
  process.stdout.write(r.ok ? "bench-battles: PASS\n" : `bench-battles: FAIL ${r.failures.join("; ")}\n`);
  process.exitCode = r.ok ? 0 : 1;
}

if (require.main === module) main();

module.exports = { runBattles, runPure, runPass };
