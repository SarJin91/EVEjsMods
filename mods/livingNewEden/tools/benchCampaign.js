"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { fork } = require("node:child_process");
const { performance } = require("node:perf_hooks");

const { resolveConfig, SCHEMA } = require("../config");
const { findServerSrcOnDisk, GAMESTORE_SEARCH_MAX_DEPTH } = require("../lib/adapter/locator");
const { resolveSqliteDriver } = require("../lib/adapter/sqliteDriver");
const { createManualClock } = require("../lib/util/clock");
const { createServiceRegistry, buildDefaultServiceDefs } = require("../lib/runtime/services");
const { createUnavailableTrade } = require("../lib/economy/trade");
const { buildSdeWorld, loadPiratePolicy, loadSecurityBand } = require("./campaign/sdeWorld");
const { createBenchAdapter } = require("./campaign/benchAdapter");
const { fullDigest, semanticDigest, queryDigest, diffDigests } = require("./campaign/digest");
const { checkCampaignInvariants, snapshotForChecks, formatCheck } = require("./campaign/checks");
const { sampleDay, formatMd, OBSERVE_NAMES } = require("./campaign/metrics");
const { createNotesTap } = require("./campaign/notesTap");
const { createTxTap } = require("./campaign/txTap");
const { CHECKPOINT_TIMING } = require("../lib/persistence/store");
const { decideCheckpoint } = require("../lib/persistence/checkpointer");
const { createCheckpointDrive } = require("./campaign/checkpointDrive");

const OBSERVE_KEPT = new Set(OBSERVE_NAMES);

const MOD_DIR = path.resolve(__dirname, "..");
const DEFAULT_SDE_DIR = path.resolve(MOD_DIR, "..", "..", "_local", "sde", "eve-online-static-data-3396210-jsonl");
const SEGMENT_FILE = path.join(__dirname, "campaign", "segment.js");
const START_MS = 1760000000000;
const MS_PER_HOUR = 3600000;
const MS_PER_DAY = 24 * MS_PER_HOUR;
const DB_FILE = "campaign.sqlite";
const SEED_POLL_MS = 50;
const SETTLE_TURNS = 20;
const MAX_FAILED_PASSES = 50;
const DIFF_MAX = 20;
const BOOT_VOLATILE = Object.freeze(["world_scheduled_events"]);
const BOOT_ROWS_SQL = "SELECT * FROM world_scheduled_events WHERE created_at < ? ORDER BY event_id";
const DANGER_MODULES = Object.freeze(["events", "sites", "materialization", "virtualCorps", "sovProjection",
  "structures"]);
const BENCH_EXCLUSIONS = new Set(["presence", "standings", "trade", "observer", "beltNavy", "playerSiege", "sentries",
  ...DANGER_MODULES]);
const SEED_TERMINAL = new Set(["done", "already_applied", "skipped", "disabled"]);
const KEYS_05B = Object.freeze(["maxCapturedSystemsPerFaction", "captureRequiresAdjacency", "defenseEnabled",
  "maxDefensePerReview", "maxThreatsRead", "maxLostHomeRead", "territoryTrimEnabled"]);
const NOW_MS_STARTERS = Object.freeze([["startGraph", "../lib/graph"], ["startWorld", "../lib/world"],
  ["startFleets", "../lib/fleets"], ["startWrecks", "../lib/world/wrecks"], ["startOccupation", "../lib/world/occupation"],
  ["startLiberation", "../lib/world/liberation"], ["startBattle", "../lib/battle"], ["startStrategy", "../lib/strategy"],
  ["startStations", "../lib/stations"], ["startMining", "../lib/economy/mining"],
  ["startProduction", "../lib/economy/production"], ["startLogistics", "../lib/economy/logistics"],
  ["startConstruction", "../lib/stations/construction"], ["startSiege", "../lib/stations/siege"],
  ["startHunt", "../lib/strategy/hunt"], ["startInvasions", "../lib/world/invasions"],
  ["startSalvage", "../lib/world/salvage"]]);
const NO_PROCESS_API = Object.freeze({ once() {}, removeListener() {} });
const NEVER_TIMER = () => Object.freeze({ cancel() {}, hasRef: () => false });

const DEFAULTS = Object.freeze({
  sde: DEFAULT_SDE_DIR, days: 30, restart: "clean", restartDay: 15, offlineHours: 6, seed: 1, dbDir: null,
  budget: "fixed", tradeDrain: false, set: Object.freeze({}), childRequire: Object.freeze([]), json: null, md: null,
  progressDays: 1, seedTimeoutS: 600, factions: null, check: null, checkpoint: "between",
});
const CHECKPOINT_MODES = Object.freeze(["between", "inline"]);

function messageOf(err) {
  return String((err && err.message) || err);
}

function consoleLogger() {
  return { log: (line) => process.stdout.write(`${line}\n`), logError: (m, e) => process.stderr.write(`${m}: ${messageOf(e)}\n`) };
}

function refusal(reason, detail) {
  return { ok: false, reason, ...(detail ? { detail: String(detail) } : {}) };
}

function findServer() {
  const found = findServerSrcOnDisk(MOD_DIR, GAMESTORE_SEARCH_MAX_DEPTH, fs.existsSync);
  if (!found.ok) return refusal("SERVER_SRC_NOT_FOUND", found.reason);
  const driver = resolveSqliteDriver(found.srcDir);
  if (!driver || !driver.ok) return refusal("SQLITE_DRIVER_UNAVAILABLE", driver && (driver.detail || driver.reason));
  return { ok: true, srcDir: found.srcDir, driver };
}

function benchConfig(opts, dataDir) {
  const env = {};
  const set = { ...(opts.set || {}) };
  if (Array.isArray(opts.factions) && opts.factions.length > 0) set["strategy.activeFactions"] = opts.factions.join(",");
  for (const [key, value] of Object.entries(set)) {
    const row = SCHEMA.find((r) => r.key === key);
    if (!row || !row.env) return refusal("CONFIG_UNKNOWN_KEY", key);
    env[row.env] = String(value);
  }
  const resolved = resolveConfig({ modDir: MOD_DIR, env });
  if (!resolved.ok) return refusal("CONFIG_INVALID", resolved.errors.join("; "));
  const config = JSON.parse(JSON.stringify(resolved.config));
  const danger = DANGER_MODULES.filter((m) => config.modules[m] && config.modules[m].enabled === true);
  if (danger.length > 0) return refusal("CONFIG_DANGER", danger.join(","));
  const warnings = [...resolved.warnings];
  const forced = [["modules.presence.enabled", config.modules.presence.enabled],
    ["standings.enabled", config.standings.enabled], ["trade.enabled", config.trade.enabled]];
  for (const [key, value] of forced) if (value === true && set[key] !== undefined) warnings.push(`${key} forced off (bench)`);
  config.modules.presence.enabled = false;
  config.standings.enabled = false;
  config.trade.enabled = false;
  config.trade.cleanupOnDisable = false;
  config.trade.externalPriceEnabled = false;
  config.persistence.dbFile = DB_FILE;
  config.dataDir = dataDir;
  config.expectedBenchServices = computeExpectedBenchServices(config);
  return { ok: true, config, warnings };
}

function computeExpectedBenchServices(config) {
  const defs = buildDefaultServiceDefs({});

  const { isModuleEnabled } = require("../config");

  const expected = [];
  for (const def of defs) {
    const name = def.name;
    if (BENCH_EXCLUSIONS.has(name)) continue;

    let enabled = false;
    if (def.module) {
      enabled = isModuleEnabled(config, def.module);
      if (enabled) {
        if (config[name] && config[name].enabled === false) {
          enabled = false;
        }
        if (enabled && (name === "construction" || name === "siege" || name === "trade")) {
          if (!config.stations || config.stations.enabled !== true) {
            enabled = false;
          }
        }
      }
    } else {
      if (name === "governor") {
        enabled = isModuleEnabled(config, "telemetry");
      } else if (name === "trade") {
        enabled = config.trade && config.trade.enabled === true;
      } else if (name === "observer") {
        enabled = config.observer && config.observer.enabled === true;
      }
    }

    if (enabled) expected.push(name);
  }

  return expected;
}

function evaluateServiceStates(statuses, excludedNames) {
  const byName = new Map(statuses.map((s) => [s.name, s]));
  const problems = [];

  function dependencyChainOk(depName, visited = new Set()) {
    if (visited.has(depName)) return false;
    visited.add(depName);
    const dep = byName.get(depName);
    if (!dep) return false;
    if (dep.state === "running") return true;
    if (dep.reason === "disabled_by_config") return true;
    if (excludedNames.has(depName)) return true;
    if (dep.state === "disabled" && dep.reason && dep.reason.startsWith("dependency_disabled:")) {
      const nextDep = dep.reason.slice("dependency_disabled:".length);
      return dependencyChainOk(nextDep, visited);
    }
    return false;
  }

  for (const status of statuses) {
    const name = status.name;
    if (excludedNames.has(name)) continue;

    const state = status.state;
    const reason = status.reason;

    if (state === "running") continue;

    if (state === "disabled") {
      if (reason === "disabled_by_config") continue;
      if (reason && reason.startsWith("dependency_disabled:")) {
        const depName = reason.slice("dependency_disabled:".length);
        if (dependencyChainOk(depName)) continue;
        problems.push(`${name}:${state}:${reason}`);
        continue;
      }
      problems.push(`${name}:${state}:${reason || "unknown"}`);
      continue;
    }

    if (state === "failed") {
      problems.push(`${name}:${state}:${reason || "unknown"}`);
      continue;
    }

    problems.push(`${name}:${state}:${reason || "not_started"}`);
  }

  return problems;
}

function prepareEnv(opts, logger) {
  const server = findServer();
  if (!server.ok) return server;
  const sde = buildSdeWorld(opts.sde);
  if (!sde.ok) return sde;
  const band = loadSecurityBand(server.srcDir);
  if (!band.ok) return band;
  const policy = loadPiratePolicy(server.srcDir, sde.world.worldData);
  if (!policy.ok) return policy;
  const ownTmp = !opts.dbDir;
  const dataDir = opts.dbDir ? path.resolve(opts.dbDir) : fs.mkdtempSync(path.join(os.tmpdir(), "lne-campaign-"));
  const cfg = benchConfig(opts, dataDir);
  if (!cfg.ok) {
    if (ownTmp) fs.rmSync(dataDir, { recursive: true, force: true });
    return cfg;
  }
  const env = {
    opts, logger, config: cfg.config, warnings: cfg.warnings, driver: server.driver, world: sde.world,
    adapter: createBenchAdapter({ world: sde.world, driver: server.driver, policy: policy.policy, band: band.band }),
    clock: createManualClock(START_MS), dataDir, ownTmp, dbFile: path.join(dataDir, DB_FILE),
    nowMs: opts.budget === "fixed" ? () => 0 : () => performance.now(),
    counts: {}, reviewBase: 0, crash: false, ownSpace: new Map(),
    samples: [], cursor: null, prevCounters: null, prevSnap: null, nextSampleAt: START_MS + MS_PER_DAY,
    dayRun: newDayRun(), checkAgg: null, checkFailures: [], passFailures: 0, totals: { passes: 0, events: 0 },
    restarted: false, claimedAfterFirstPass: 0, notesTap: createNotesTap(null),
    txTap: createTxTap(), txStarts: [], checkpointMs: null, persistenceHandle: null,
  };
  env.checkpointDrive = newCheckpointDrive(env, null);
  env.starters = starters(env);
  return { ok: true, env };
}

function newCheckpointDrive(env, state) {
  return createCheckpointDrive({ decide: decideCheckpoint, settings: env.config.persistence, nowMs: env.nowMs, state });
}

function newDayRun() {
  return { passes: 0, events: 0, wallMs: 0, passMs: [], observe: {} };
}

const BENCH_TX_PREFIX = "bench.";
const CHECKPOINT_PRAGMA = "wal_checkpoint";

function tapTiming(env, next) {
  return (name, ms, outcome, rows, why, failure) => {
    try {
      if (!String(name).startsWith(BENCH_TX_PREFIX)) {
        let wall = ms;
        if (name === CHECKPOINT_TIMING) {
          if (env.checkpointMs !== null) wall = env.checkpointMs;
          env.checkpointMs = null;
          if (env.opts.checkpoint === "inline" && outcome !== "failed") env.checkpointDrive.record(why);
        } else if (env.txStarts.length > 0) wall = performance.now() - env.txStarts[env.txStarts.length - 1];
        env.txTap.onTiming(name, wall, outcome, rows);
      }
    } catch (_err) {
    }
    if (typeof next === "function") next(name, ms, outcome, rows, why, failure);
  };
}

function timedDriver(driver, env) {
  if (!driver || !driver.ok || typeof driver.Database !== "function") return driver;
  const Base = driver.Database;
  class TimedDatabase extends Base {
    pragma(source, ...rest) {
      if (typeof source !== "string" || !source.trim().startsWith(CHECKPOINT_PRAGMA)) return super.pragma(source, ...rest);
      const t0 = performance.now();
      try {
        return super.pragma(source, ...rest);
      } finally {
        env.checkpointMs = performance.now() - t0;
      }
    }
  }
  return { ...driver, Database: TimedDatabase };
}

function starters(env) {
  const fixed = env.opts.budget === "fixed";
  const between = env.opts.checkpoint === "between";
  const out = {};
  for (const [name, file] of NOW_MS_STARTERS) {
    const real = require(file)[name];
    if (typeof real !== "function") throw new Error(`bench: ${file}.${name} is not a function`);
    out[name] = fixed ? (deps) => real({ ...deps, nowMs: env.nowMs }) : real;
  }
  const realPersistence = require("../lib/persistence").startPersistence;
  out.startPersistence = (deps) => {
    const adapter = deps.adapter ? Object.freeze({ ...deps.adapter,
      loadSqliteDriver: () => timedDriver(deps.adapter.loadSqliteDriver(), env) }) : deps.adapter;
    const r = realPersistence({ ...deps, adapter, nowMs: env.nowMs, processApi: NO_PROCESS_API,
      randomSeed: () => env.opts.seed >>> 0, onTiming: tapTiming(env, deps.onTiming),
      ...(between ? { setTimer: NEVER_TIMER } : {}) });
    if (!r || !r.ok) return r;
    const store = r.store;
    env.persistenceHandle = between ? { store, checkpointer: r.checkpointer || null } : null;
    const transaction = (name, fn, ...rest) => {
      env.txStarts.push(performance.now());
      try {
        return env.crash !== true ? store.transaction(name, fn, ...rest)
          : store.transaction(name, (db) => {
            const value = fn(db);
            process.kill(process.pid, "SIGKILL");
            return value;
          }, ...rest);
      } finally {
        env.txStarts.pop();
      }
    };
    return { ...r, store: Object.freeze({ ...store, transaction }) };
  };
  const realScheduler = require("../lib/scheduler").startScheduler;
  out.startScheduler = (deps) => realScheduler({ ...deps, setTimer: NEVER_TIMER, ...(fixed ? { nowMs: env.nowMs } : {}) });
  const realTelemetry = require("../lib/telemetry").startTelemetry;
  out.startTelemetry = (deps) => {
    const r = realTelemetry({ ...deps, timers: { setInterval: () => null, clearInterval: () => {} } });
    if (!r || !r.ok) return r;
    const api = r.telemetry;
    const count = (name, n) => {
      env.counts[name] = (env.counts[name] || 0) + (n === undefined ? 1 : n);
      return api.count(name, n);
    };
    const observe = (name, value, ...rest) => {
      if (OBSERVE_KEPT.has(name) && typeof value === "number" && Number.isFinite(value)) {
        const day = env.dayRun.observe || (env.dayRun.observe = {});
        (day[name] || (day[name] = [])).push(value);
      }
      return api.observe(name, value, ...rest);
    };
    const wrapped = typeof api.observe === "function" ? { count, observe } : { count };
    return { ok: true, telemetry: Object.freeze({ ...api, ...wrapped }) };
  };
  out.startObserver = () => ({ ok: true, observer: Object.freeze({ stop() {} }) });
  if (env.opts.tradeDrain) {
    out.startTrade = () => {
      const stub = createUnavailableTrade("BENCH_TRADE_DRAIN");
      return { ok: true, trade: Object.freeze({ ...stub, getMode: () => "ready",
        tradeReady: () => ({ ready: true, reason: null, headroomIsk: 0 }),
        fundFromUpkeepInTx: (_db, spec) => ({ ok: true, duplicate: false, fundedUnits: spec.units, fundedIsk: 0,
          capped: false }) }) };
    };
  }
  return out;
}

function createSession(env, idsSeed) {
  const registry = createServiceRegistry({ logger: env.logger, starters: env.starters, randomSeed: () => idsSeed >>> 0,
    clock: env.clock, processApi: NO_PROCESS_API });
  const ctx = { config: env.config, adapter: env.adapter, modDir: MOD_DIR };
  const started = registry.startAll(ctx);
  if (!started.ok) {
    const statuses = registry.getStatus().services;
    env.serviceStates = statuses;
    return refusal("SERVICES_NOT_STARTED", started.reason);
  }
  const statuses = registry.getStatus().services;
  const problems = evaluateServiceStates(statuses, BENCH_EXCLUSIONS);
  if (problems.length > 0) {
    registry.stopAll("bench_refused");
    env.serviceStates = statuses;
    return refusal("SERVICE_NOT_RUNNING", problems.join(","));
  }
  env.serviceStates = statuses;
  return { ok: true, registry, ctx, store: ctx.persistence.store };
}

async function waitBoot(env, s) {
  const ctx = s.ctx;
  const timeoutMs = env.opts.seedTimeoutS * 1000;
  const deadline = Date.now() + timeoutMs;
  let timer = null;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  const waits = ["graph", "strategy", "stations", "construction", "siege"].map((n) => ctx[n])
    .filter((svc) => svc && typeof svc.whenReady === "function")
    .map((svc) => Promise.resolve(svc.whenReady()).catch(() => null));
  try {
    if (await Promise.race([Promise.all(waits).then(() => "ready"), timeout]) === "timeout") {
      return refusal("BOOT_TIMEOUT", "whenReady");
    }
    for (;;) {
      const seed = ctx.world && ctx.world.seed ? ctx.world.seed.getStatus() : null;
      if (seed && seed.state === "failed") return refusal("SEED_FAILED", seed.reason);
      const seedDone = !seed || SEED_TERMINAL.has(seed.state);
      const miningDone = !ctx.mining || typeof ctx.mining.getMode !== "function" || ctx.mining.getMode() !== "pending";
      if (seedDone && miningDone) break;
      if (Date.now() > deadline) return refusal("SEED_TIMEOUT", seed ? seed.state : "mining");
      await new Promise((resolve) => setTimeout(resolve, SEED_POLL_MS));
    }
    for (let i = 0; i < SETTLE_TURNS; i += 1) await new Promise((resolve) => setImmediate(resolve));
    return { ok: true };
  } finally {
    clearTimeout(timer);
  }
}

function tx(s, name, fn) {
  const r = s.store.transaction(name, fn);
  if (!r.ok) throw new Error(`${name}: ${r.reason}${r.error ? ` ${messageOf(r.error)}` : ""}`);
  return r.value;
}

function reviewLostHomeTruncated(s) {
  try {
    const st = s.ctx.strategy.getStatus();
    return (st.ai && st.ai.review && st.ai.review.counters && st.ai.review.counters.lostHomeTruncated) || 0;
  } catch (_err) {
    return 0;
  }
}

function counters(env, s) {
  return { ...env.counts, "strategy.review.lostHomeTruncated": env.reviewBase + reviewLostHomeTruncated(s) };
}

function stopSession(env, s, reason) {
  env.reviewBase += reviewLostHomeTruncated(s);
  s.registry.stopAll(reason);
}

function graphOf(s) {
  const g = s.ctx.graph && typeof s.ctx.graph.getGraph === "function" ? s.ctx.graph.getGraph() : null;
  return g && g.ok ? g.graph : null;
}

function ownSpaceOf(env, graph) {
  return (f) => {
    if (!env.ownSpace.has(f)) {
      env.ownSpace.set(f, new Set(graph ? graph.getSystemIds().filter((id) => graph.getSystem(id).factionId === f) : []));
    }
    return env.ownSpace.get(f);
  };
}

function fileSizes(file) {
  const size = (f) => {
    try {
      return fs.statSync(f).size;
    } catch (_err) {
      return 0;
    }
  };
  return { dbBytes: size(file), walBytes: size(`${file}-wal`) };
}

function viewSizes(views) {
  const out = { galaxyState: null, control: null };
  for (const [key, id] of [["galaxyState", "galaxy-state"], ["control", "control"]]) {
    try {
      const v = views && views.getView(id);
      const data = v ? v.getData({ url: "/", headers: {} }) : null;
      if (data && typeof data.then !== "function") out[key] = Buffer.byteLength(JSON.stringify(data));
    } catch (_err) {
      out[key] = null;
    }
  }
  return out;
}

const SUM_KEYS = new Set(["nonAdjacentCaptures", "footholdCaptures", "phaseSeqRegressions"]);

function mergeChecks(agg, chk) {
  if (agg === null) return { ...chk, counts: { ...chk.counts } };
  for (const [k, v] of Object.entries(chk.counts)) {
    agg.counts[k] = SUM_KEYS.has(k) ? (agg.counts[k] || 0) + v : Math.max(agg.counts[k] || 0, v);
  }
  agg.pass = agg.pass && chk.pass;
  agg.failing = [...new Set([...agg.failing, ...chk.failing])];
  for (const k of Object.keys(chk.details)) agg.details[k] = [...agg.details[k], ...chk.details[k]].slice(0, DIFF_MAX);
  return agg;
}

function takeSample(env, s) {
  const at = env.nextSampleAt;
  const day = Math.round((at - START_MS) / MS_PER_DAY);
  const graph = graphOf(s);
  const now = counters(env, s);
  const views = viewSizes(s.ctx.views);
  const files = fileSizes(env.dbFile);
  Object.assign(env.dayRun, env.txTap.takeDay());
  env.dayRun.checkpoint = { ...env.dayRun.checkpoint, byReason: env.checkpointDrive.takeDay() };
  const res = tx(s, "bench.sample", (db) => {
    const out = sampleDay(db, { config: env.config, day, fromAt: at - MS_PER_DAY, at, cursor: env.cursor,
      counters: now, prevCounters: env.prevCounters, run: env.dayRun, observe: env.dayRun.observe, files, views,
      tradeMode: env.opts.tradeDrain ? "drain" : "off(bench)", reviewNotes: env.notesTap.drain() });
    const chk = checkCampaignInvariants(db, { config: env.config, prev: env.prevSnap, graph,
      ownSpaceOf: ownSpaceOf(env, graph), restarted: env.restarted, claimedAfterFirstPass: env.claimedAfterFirstPass,
      sovUnavailable: now["world.invasions.sovUnavailable"] || 0, now: at });
    return { out, chk, snap: snapshotForChecks(db) };
  });
  if (!res.chk.ok) env.checkFailures.push(`day ${day}: ${res.chk.reason} ${res.chk.detail || ""}`.trim());
  else env.checkAgg = mergeChecks(env.checkAgg, res.chk);
  env.samples.push(res.out.sample);
  env.cursor = res.out.cursor;
  env.prevCounters = now;
  env.prevSnap = res.snap;
  env.dayRun = newDayRun();
  env.nextSampleAt += MS_PER_DAY;
  if (day % Math.max(1, env.opts.progressDays) === 0) {
    const g = res.out.sample.global;
    env.logger.log(`campaign: day ${day}/${env.opts.days} passes=${g.passes} events=${g.events} wall=${g.wallMs}ms `
      + `journal=${g.journalRows} open=${g.openSchedulerEvents} fleets=${g.liveFleets} battles=${g.battlesSettled} `
      + `tx=${g.tx ? g.tx.n : 0} ckpt=${g.checkpoint ? g.checkpoint.n : 0}`);
  }
}

async function simulate(env, s, untilMs) {
  const interval = env.config.scheduler.intervalMs;
  const scheduler = s.ctx.scheduler;
  for (;;) {
    const now = env.clock.now();
    if (now >= env.nextSampleAt && env.nextSampleAt <= untilMs) {
      takeSample(env, s);
      continue;
    }
    if (now >= untilMs) return { ok: true };
    const t0 = performance.now();
    const r = await scheduler.runPass();
    const ms = performance.now() - t0;
    env.dayRun.passes += 1;
    env.dayRun.wallMs += ms;
    env.dayRun.passMs.push(ms);
    if (env.persistenceHandle) env.checkpointDrive.afterPass(env.persistenceHandle);
    env.totals.passes += 1;
    if (r && r.ok === true) {
      env.dayRun.events += r.jobs || 0;
      env.totals.events += r.jobs || 0;
    } else if (++env.passFailures > MAX_FAILED_PASSES) {
      return refusal("PASS_FAILED", r ? `${r.reason}${r.detail ? ` ${r.detail}` : ""}` : "no result");
    }
    if (s.afterFirstPass) {
      const fn = s.afterFirstPass;
      s.afterFirstPass = null;
      fn();
    }
    env.notesTap.observeViews(s.ctx.views);
    const limit = Math.min(untilMs, env.nextSampleAt);
    const next = scheduler.getStatus().nextDueAt;
    const empty = r && r.ok === true && !r.skipped && r.stoppedBy === "empty";
    if (empty && next === null) env.clock.set(limit);
    else if (empty && next > now + interval) env.clock.set(Math.min(limit, next));
    else env.clock.set(Math.min(limit, now + interval));
  }
}

function digestFile(driver, file) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lne-campaign-f2-"));
  const copy = path.join(dir, path.basename(file));
  try {
    fs.copyFileSync(file, copy);
    if (fs.existsSync(`${file}-wal`)) fs.copyFileSync(`${file}-wal`, `${copy}-wal`);
    const db = new driver.Database(copy, { fileMustExist: true });
    try {
      return fullDigest(db);
    } finally {
      db.close();
    }
  } catch (err) {
    return refusal("DIGEST_FILE_FAILED", messageOf(err));
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch (_err) {
    }
  }
}

function compareDigests(restart, failures) {
  if (!restart.F1 || !restart.F2 || !restart.F1.ok || !restart.F2.ok) {
    failures.push(`RESTART_DIGEST_FAILED ${(restart.F2 && restart.F2.detail) || ""}`.trim());
    return;
  }
  restart.fullEqual = restart.F1.digest === restart.F2.digest;
  if (!restart.fullEqual) failures.push(`RESTART_FULL_DIFF ${diffDigests(restart.F1, restart.F2, DIFF_MAX).join(",")}`);
  if (restart.S1 && restart.S2) {
    restart.semanticEqual = restart.S1.digest === restart.S2.digest;
    if (!restart.semanticEqual) {
      failures.push(`RESTART_SEMANTIC_DIFF ${diffDigests(restart.S1, restart.S2, DIFF_MAX).join(",")}`);
    }
  }
}

async function startSegmentTwo(env) {
  const s = createSession(env, (env.opts.seed >>> 0) + 1);
  if (!s.ok) return s;
  const boot = await waitBoot(env, s);
  if (!boot.ok) {
    stopSession(env, s, "bench_boot_failed");
    return boot;
  }
  env.restarted = true;
  env.notesTap.resetRounds();
  s.afterFirstPass = () => {
    env.claimedAfterFirstPass = tx(s, "bench.read", (db) => db.prepare(
      "SELECT count(*) AS n FROM world_scheduled_events WHERE state <> 'DONE' AND state = 'CLAIMED'").get().n);
  };
  const recovered = s.ctx.scheduler.getStatus().recovered;
  return { ...s, recovered: recovered ? { ...recovered } : null };
}

async function restartClean(env, s, failures) {
  const restart = { mode: "clean", at: env.clock.now() };
  restart.S1 = tx(s, "bench.digest", (db) => semanticDigest(db, { volatile: BOOT_VOLATILE }));
  restart.F1 = tx(s, "bench.digest", (db) => fullDigest(db));
  const bootAt = env.clock.now() + env.opts.offlineHours * MS_PER_HOUR;
  const B1 = tx(s, "bench.digest", (db) => queryDigest(db, BOOT_ROWS_SQL, [bootAt]));
  stopSession(env, s, "bench_restart");
  restart.F2 = digestFile(env.driver, env.dbFile);
  env.clock.set(bootAt);
  const s2 = await startSegmentTwo(env);
  if (!s2.ok) return { restart, failed: `RESTART_START ${s2.reason} ${s2.detail || ""}`.trim() };
  restart.S2 = tx(s2, "bench.digest", (db) => semanticDigest(db, { volatile: BOOT_VOLATILE }));
  const B2 = tx(s2, "bench.digest", (db) => queryDigest(db, BOOT_ROWS_SQL, [bootAt]));
  restart.bootRowsEqual = B1.ok && B2.ok && B1.digest === B2.digest;
  restart.bootAdded = B2.ok ? tx(s2, "bench.read", (db) => db.prepare(
    "SELECT count(*) AS n FROM world_scheduled_events WHERE created_at >= ?").get(bootAt).n) : null;
  if (!restart.bootRowsEqual) failures.push(`RESTART_BOOT_CHANGED world_scheduled_events rows ${B1.rows}->${B2.rows}`);
  restart.recovered = s2.recovered;
  compareDigests(restart, failures);
  return { restart, session: s2 };
}

async function runSegmentOne(input, send) {
  const opts = { ...DEFAULTS, ...input };
  const logger = { log: (line) => process.stdout.write(`${line}\n`), logError: (m, e) => process.stdout.write(`${m}: ${messageOf(e)}\n`) };
  const prepared = prepareEnv(opts, logger);
  if (!prepared.ok) {
    await send({ type: "refused", reason: prepared.reason, detail: prepared.detail || null });
    return;
  }
  const env = prepared.env;
  const s = createSession(env, opts.seed >>> 0);
  if (!s.ok) {
    await send({ type: "refused", reason: s.reason, detail: s.detail || null });
    return;
  }
  const boot = await waitBoot(env, s);
  if (!boot.ok) {
    await send({ type: "refused", reason: boot.reason, detail: boot.detail || null });
    return;
  }
  const restartAt = START_MS + opts.restartDay * MS_PER_DAY;
  const run = await simulate(env, s, restartAt);
  if (!run.ok) {
    await send({ type: "refused", reason: run.reason, detail: run.detail || null });
    return;
  }
  const F1 = tx(s, "bench.digest", (db) => fullDigest(db));
  env.crash = true;
  await send({ type: "F1", F1, at: env.clock.now(), state: {
    counts: env.counts, reviewBase: env.reviewBase + reviewLostHomeTruncated(s), samples: env.samples, cursor: env.cursor,
    prevCounters: env.prevCounters, prevSnap: env.prevSnap, nextSampleAt: env.nextSampleAt, dayRun: env.dayRun,
    checkAgg: env.checkAgg, checkFailures: env.checkFailures, passFailures: env.passFailures, totals: env.totals,
    notesTap: env.notesTap.state(), txTap: env.txTap.state(), checkpointDrive: env.checkpointDrive.state() } });
  await simulate(env, s, START_MS + opts.days * MS_PER_DAY);
  await send({ type: "noCrash" });
}

function runChild(env) {
  return new Promise((resolve) => {
    const execArgv = [...process.execArgv, ...env.opts.childRequire.flatMap((f) => ["--require", path.resolve(f)])];
    const child = fork(SEGMENT_FILE, [], { execArgv, serialization: "advanced", stdio: ["ignore", "pipe", "pipe", "ipc"] });
    const tail = [];
    const keep = (prefix) => (chunk) => {
      for (const line of String(chunk).split(/\r?\n/)) {
        if (line === "") continue;
        tail.push(`${prefix}${line}`);
        if (tail.length > DIFF_MAX) tail.shift();
      }
    };
    child.stdout.on("data", keep(""));
    child.stderr.on("data", keep("err: "));
    let message = null;
    child.on("message", (m) => {
      if (m && m.type !== "noCrash") message = m;
      else if (m) message = { ...message, noCrash: true };
    });
    child.on("error", (err) => resolve({ message, exit: { error: messageOf(err) }, tail }));
    child.on("exit", (code, signal) => resolve({ message, exit: { code, signal }, tail }));
    const { logger, ...plain } = env.opts;
    child.send({ type: "start", opts: { ...plain, dbDir: env.dataDir } });
  });
}

async function restartKill(env, failures) {
  const restart = { mode: "kill" };
  const child = await runChild(env);
  restart.exit = child.exit;
  const m = child.message;
  if (!m || m.type !== "F1") {
    const why = m && m.type === "refused" ? `${m.reason} ${m.detail || ""}` : `no F1 (${child.tail.join(" | ")})`;
    return { restart, failed: `KILL_SEGMENT1 ${why}`.trim(), refused: m && m.type === "refused" ? m.reason : null };
  }
  if (m.noCrash) failures.push("KILL_NOT_TRIGGERED");
  Object.assign(env, m.state, { notesTap: createNotesTap(m.state.notesTap || null),
    txTap: createTxTap({ state: m.state.txTap || null }),
    checkpointDrive: newCheckpointDrive(env, m.state.checkpointDrive || null) });
  restart.at = m.at;
  restart.F1 = m.F1;
  restart.F2 = digestFile(env.driver, env.dbFile);
  env.clock.set(m.at + env.opts.offlineHours * MS_PER_HOUR);
  const s2 = await startSegmentTwo(env);
  if (!s2.ok) return { restart, failed: `RESTART_START ${s2.reason} ${s2.detail || ""}`.trim() };
  restart.recovered = s2.recovered;
  compareDigests(restart, failures);
  return { restart, session: s2 };
}

const KEYS_05E3_INVASIONS = Object.freeze(["weightFree", "weightActive", "weightControlled", "targetSampleSize",
  "maxActive", "maxActivePerFaction"]);

function keys05e3(config) {
  const inv = (config && config.invasions) || {};
  const out = {};
  for (const k of KEYS_05E3_INVASIONS) out[`invasions.${k}`] = inv[k] === undefined ? null : inv[k];
  out["strategy.reactiveEnabled"] = config && config.strategy ? config.strategy.reactiveEnabled : null;
  return out;
}

function header(env, s) {
  const st = env.config.strategy;
  const reg = s && s.ctx.strategy && s.ctx.strategy.registry;
  return {
    sde: env.opts.sde, sdeBuild: env.world.sdeBuild, systems: env.world.systemCount, npcStations: env.world.stationCount,
    belts: env.world.beltCount, seed: env.opts.seed, budget: env.opts.budget, checkpointMode: env.opts.checkpoint,
    tradeMode: env.opts.tradeDrain ? "drain" : "off(bench)",
    keys05b: Object.fromEntries(KEYS_05B.filter((k) => st[k] !== undefined).map((k) => [k, st[k]])),
    keys05e3: keys05e3(env.config),
    registryVersions: reg && reg.version ? { ...reg.version } : null,
    configWarnings: env.warnings, bootVolatile: BOOT_VOLATILE,
    services: env.serviceStates ? env.serviceStates.map((sv) => ({ name: sv.name, state: sv.state, reason: sv.reason }))
      : null,
    notes: ["review counters are global (the review journal has no per-faction decision notes)",
      "per-faction review notes come from the factions view (last review in memory) read after every pass",
      "lostHomeTruncated per faction null (review keeps a global counter)"],
  };
}

function cleanup(env) {
  if (!env.ownTmp) return;
  try {
    fs.rmSync(env.dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  } catch (_err) {
  }
}

function result(env, wallStart, fields) {
  return { ok: false, failures: [], samples: env ? env.samples : [], restart: null, checks: null, digest: null,
    header: null, wall: Math.round(performance.now() - wallStart), ...fields };
}

async function runCampaignInner(opts, wallStart, input) {
  const logger = opts.logger || consoleLogger();
  if (!["clean", "kill", "none"].includes(opts.restart)) return result(null, wallStart, { failures: ["OPTS restart"] });
  if (!["fixed", "real"].includes(opts.budget)) return result(null, wallStart, { failures: ["OPTS budget"] });
  if (!CHECKPOINT_MODES.includes(opts.checkpoint)) return result(null, wallStart, { failures: ["OPTS checkpoint"] });
  if (!(Number.isSafeInteger(opts.days) && opts.days >= 1)) return result(null, wallStart, { failures: ["OPTS days"] });
  if (opts.restart !== "none" && opts.restartDay >= opts.days && input.restartDay === undefined) {
    opts.restartDay = Math.max(1, Math.floor(opts.days / 2));
  }
  if (opts.restart !== "none" && !(Number.isSafeInteger(opts.restartDay) && opts.restartDay >= 1
    && opts.restartDay < opts.days)) {
    return result(null, wallStart, { failures: ["OPTS restartDay must be within 1..days-1"] });
  }
  const prepared = prepareEnv(opts, logger);
  if (!prepared.ok) {
    return result(null, wallStart, { failures: [`${prepared.reason} ${prepared.detail || ""}`.trim()],
      refused: prepared.reason });
  }
  const env = prepared.env;
  const failures = [];
  const endMs = START_MS + opts.days * MS_PER_DAY;
  let s = null;
  let restart = { mode: opts.restart };
  try {
    if (opts.restart === "kill") {
      const k = await restartKill(env, failures);
      restart = k.restart;
      if (!k.session) return result(env, wallStart, { failures: [k.failed], restart, refused: k.refused || undefined });
      s = k.session;
    } else {
      s = createSession(env, opts.seed >>> 0);
      if (!s.ok) return result(env, wallStart, { failures: [`${s.reason} ${s.detail || ""}`.trim()] });
      const boot = await waitBoot(env, s);
      if (!boot.ok) return result(env, wallStart, { failures: [`${boot.reason} ${boot.detail || ""}`.trim()] });
      const g = graphOf(s);
      logger.log(`campaign: boot OK systems=${g ? g.getSystemIds().length : 0} sdeBuild=${env.world.sdeBuild} `
        + `stations=${tx(s, "bench.read", (db) => db.prepare("SELECT count(*) AS n FROM world_stations").get().n)} `
        + `controlled=${tx(s, "bench.read", (db) => db.prepare(
          "SELECT count(*) AS n FROM world_system_state WHERE controller_faction_id IS NOT NULL").get().n)}`);
      if (opts.restart === "clean") {
        const run = await simulate(env, s, START_MS + opts.restartDay * MS_PER_DAY);
        if (!run.ok) failures.push(`${run.reason} ${run.detail || ""}`.trim());
        else {
          const c = await restartClean(env, s, failures);
          restart = c.restart;
          if (!c.session) {
            s = null;
            failures.push(c.failed);
          } else s = c.session;
        }
      }
    }
    if (s && failures.every((f) => !f.startsWith("PASS_FAILED"))) {
      const run = await simulate(env, s, endMs);
      if (!run.ok) failures.push(`${run.reason} ${run.detail || ""}`.trim());
    }
    let digest = null;
    if (s) {
      const sem = tx(s, "bench.digest", (db) => semanticDigest(db, { volatile: BOOT_VOLATILE }));
      digest = { semantic: sem.digest, semanticTables: (sem && sem.tables) || null,
        full: tx(s, "bench.digest", (db) => fullDigest(db)).digest };
    }
    const checks = env.checkAgg;
    if (env.checkFailures.length > 0) failures.push(`CHECK_FAILED ${env.checkFailures.join("; ")}`);
    if (checks && !checks.pass) failures.push(`CHECKS ${checks.failing.map((k) => `${k}=${checks.counts[k]}`).join(",")}`);
    if (!checks && failures.length === 0) failures.push("NO_SAMPLE");
    if (checks && checks.counts.sovUnavailable > 0) failures.push(`SOV_UNAVAILABLE ${checks.counts.sovUnavailable}`);
    const report = { ok: failures.length === 0, failures, seed: opts.seed, days: opts.days, restart,
      header: header(env, s), samples: env.samples, checks, checksLine: checks ? formatCheck(checks) : "none", digest,
      passes: env.totals.passes, events: env.totals.events, txByName: env.txTap.totals(),
      wall: Math.round(performance.now() - wallStart) };
    if (opts.json) fs.writeFileSync(opts.json, JSON.stringify(report, jsonReplacer, 2));
    if (opts.md) fs.writeFileSync(opts.md, formatMd(report));
    logger.log(report.checksLine);
    return report;
  } finally {
    if (s && s.registry) stopSession(env, s, "bench_done");
    cleanup(env);
  }
}

function jsonReplacer(_key, value) {
  if (value instanceof Map) return Object.fromEntries(value);
  if (value instanceof Set) return [...value];
  return value;
}

async function runCampaign(input) {
  const opts = { ...DEFAULTS, ...(input || {}) };
  const wallStart = performance.now();
  if (opts.check) return runCheck(opts.check);
  try {
    return await runCampaignInner(opts, wallStart, input || {});
  } catch (err) {
    return result(null, wallStart, { failures: [`CAMPAIGN_THREW ${messageOf(err)}`] });
  }
}

function runCheck(file) {
  const server = findServer();
  if (!server.ok) return { ok: false, failures: [`${server.reason} ${server.detail || ""}`.trim()] };
  if (!fs.existsSync(file)) return { ok: false, failures: [`CHECK_FILE_MISSING ${file}`] };
  const resolved = resolveConfig({ modDir: MOD_DIR, env: {} });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lne-campaign-check-"));
  const copy = path.join(dir, "check.sqlite");
  try {
    fs.copyFileSync(file, copy);
    if (fs.existsSync(`${file}-wal`)) fs.copyFileSync(`${file}-wal`, `${copy}-wal`);
    const db = new server.driver.Database(copy, { fileMustExist: true });
    let r;
    try {
      r = checkCampaignInvariants(db, { config: resolved.config, prev: null, graph: null, disabledInformational: true });
    } finally {
      db.close();
    }
    const line = formatCheck(r);
    process.stdout.write(`${line}\n`);
    if (r.ok && r.notes.length > 0) process.stdout.write(`check-campaign notes: ${r.notes.join("; ")}\n`);
    return { ok: r.ok && r.pass, failures: r.ok && r.pass ? [] : [line], checks: r };
  } catch (err) {
    return { ok: false, failures: [`CHECK_FAILED ${messageOf(err)}`] };
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch (_err) {
    }
  }
}

function parseArgs(argv) {
  const opts = { set: {}, childRequire: [] };
  const num = (v, name) => {
    const n = Number(v);
    if (!Number.isFinite(n)) throw new Error(`--${name} needs a number`);
    return n;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`${a} needs a value`);
      return argv[i];
    };
    if (a === "--sde") opts.sde = next();
    else if (a === "--days") opts.days = num(next(), "days");
    else if (a === "--restart") opts.restart = next();
    else if (a === "--restart-day") opts.restartDay = num(next(), "restart-day");
    else if (a === "--offline-hours") opts.offlineHours = num(next(), "offline-hours");
    else if (a === "--seed") opts.seed = num(next(), "seed");
    else if (a === "--db-dir") opts.dbDir = next();
    else if (a === "--budget") opts.budget = next();
    else if (a === "--trade-drain") opts.tradeDrain = true;
    else if (a === "--set") {
      const kv = next();
      const eq = kv.indexOf("=");
      if (eq < 1) throw new Error("--set needs key=value");
      opts.set[kv.slice(0, eq)] = kv.slice(eq + 1);
    } else if (a === "--child-require") opts.childRequire.push(next());
    else if (a === "--json") opts.json = next();
    else if (a === "--md") opts.md = next();
    else if (a === "--progress-days") opts.progressDays = num(next(), "progress-days");
    else if (a === "--seed-timeout-s") opts.seedTimeoutS = num(next(), "seed-timeout-s");
    else if (a === "--factions") opts.factions = next().split(",").map((x) => x.trim()).filter(Boolean).map(Number);
    else if (a === "--check") opts.check = next();
    else if (a === "--checkpoint") {
      opts.checkpoint = next();
      if (!CHECKPOINT_MODES.includes(opts.checkpoint)) {
        throw new Error(`--checkpoint needs ${CHECKPOINT_MODES.join("|")} (got ${opts.checkpoint})`);
      }
    } else throw new Error(`unknown argument ${a}`);
  }
  return opts;
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stdout.write(`campaign: FAIL ${err.message}\n`);
    process.exitCode = 1;
    return;
  }
  const r = await runCampaign(opts);
  process.stdout.write(r.ok ? "campaign: PASS\n" : `campaign: FAIL ${r.failures.join("; ")}\n`);
  process.exitCode = r.ok ? 0 : 1;
}

if (require.main === module) main();

module.exports = { runCampaign, runCheck, runSegmentOne, parseArgs, benchConfig, DEFAULTS, BOOT_VOLATILE, START_MS,
  MS_PER_DAY, computeExpectedBenchServices, evaluateServiceStates, BENCH_EXCLUSIONS };
