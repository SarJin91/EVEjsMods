"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { performance } = require("node:perf_hooks");

const { resolveConfig } = require("../config");
const { findServerSrcOnDisk, GAMESTORE_SEARCH_MAX_DEPTH } = require("../lib/adapter/locator");
const { resolveSqliteDriver } = require("../lib/adapter/sqliteDriver");
const { buildUniverseGraph } = require("../lib/graph/universeGraph");
const { createRouteFinder } = require("../lib/graph/routes");
const { openStore } = require("../lib/persistence/store");
const { createJournal } = require("../lib/persistence/journal");
const { createManualClock } = require("../lib/util/clock");
const { createRng, deriveSeed } = require("../lib/util/rng");
const { createIdGenerator } = require("../lib/util/ids");
const { createViewRegistry } = require("../lib/observer/views");
const { startScheduler } = require("../lib/scheduler");
const { startFleets } = require("../lib/fleets");
const { checkBenchInvariants, BENCH_EVENT_TYPE } = require("../lib/fleets/bench");
const { startWrecks } = require("../lib/world/wrecks");
const { startBattle } = require("../lib/battle");
const { checkBattleInvariants, formatBattleCheck } = require("../lib/battle/checks");
const { normalizeOptions, createLoadGovernor } = require("../lib/telemetry/loadGovernor");
const { governorOptionsFromConfig } = require("../lib/telemetry/governorService");
const { createCheckpointer } = require("../lib/persistence/checkpointer");
const { CHECKPOINT_TIMING } = require("../lib/persistence/store");

const MOD_DIR = path.resolve(__dirname, "..");
const START_MS = 1760000000000;
const MS_PER_MINUTE = 60000;
const MS_PER_HOUR = 3600000;
const MS_PER_DAY = 86400000;
const BYTES_PER_MB = 1048576;
const CHAIN_BOUND = 3;
const MAP_REGION_SIZE = 100;
const MAP_HIGHSEC = 0.25;
const MAP_LOWSEC = 0.15;
const MAP_TREE_WINDOW = 6;
const MAP_EXTRA_EDGES = 0.35;
const MAP_EXTRA_WINDOW = 20;
const REBUILD_SIZES = Object.freeze([50000, 100000]);
const REBUILD_FAR_MS = 30 * MS_PER_DAY;
const FLOOD_FLEETS = 1000;
const FLOOD_FACTOR = 1.5;
const FLOOD_MS = 10 * MS_PER_MINUTE;
const FLOOD_PROBE_PASSES = 20;
const NEARFULL_FACTOR = 1.05;
const MODE_MS = 10 * MS_PER_MINUTE;
const MODE_TICK = Object.freeze({ NORMAL: 100, CONSTRAINED: 125, OVERLOADED: 135, SHED: 550 });
const TICKS_PER_PASS = 10;
const BATCH_SIZES = Object.freeze([1, 2, 4, 8, 16, 32]);
const BATCH_HOURS = 1;
const DRAIN_MAX_MS = 6 * MS_PER_HOUR;
const P50 = 0.5;
const P95 = 0.95;
const ALL_STEADY = Object.freeze([[1000, 24], [5000, 24], [10000, 6]]);
const PASS_P95_TARGET_MS = 12;

const DEFAULTS = Object.freeze({ fleets: 5000, hours: 24, dwellMin: 30, roamMaxJumps: 5, offlineHours: 0,
  scenario: "steady", memory: false, dbDir: null, seed: 1, mapSystems: 2000, set: {}, json: null, quiet: false });

function pct(values, p) {
  if (values.length === 0) return 0;
  const sorted = Float64Array.from(values).sort();
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))];
}

const round2 = (v) => Math.round(v * 100) / 100;
const round3 = (v) => Math.round(v * 1000) / 1000;

function loadDriver() {
  const found = findServerSrcOnDisk(MOD_DIR, GAMESTORE_SEARCH_MAX_DEPTH, fs.existsSync);
  if (!found.ok) return { ok: false, reason: "SERVER_SRC_NOT_FOUND", detail: found.reason };
  return resolveSqliteDriver(found.srcDir);
}

function syntheticGraph(systems, seed, maxJumps) {
  const rng = createRng(deriveSeed(seed, "bench-map", systems));
  const list = [];
  const gates = [];
  const firstId = 30000001;
  for (let i = 0; i < systems; i += 1) {
    const roll = rng.nextFloat();
    const secClass = roll < MAP_HIGHSEC ? "highsec" : (roll < MAP_HIGHSEC + MAP_LOWSEC ? "lowsec" : "nullsec");
    const security = secClass === "highsec" ? 0.7 : (secClass === "lowsec" ? 0.3 : -0.3);
    const region = 10000001 + Math.floor(i / MAP_REGION_SIZE);
    list.push({ id: firstId + i, name: `B-${i}`, regionId: region, constellationId: 20000001 + Math.floor(i / 10),
      security, trueSecurity: security, secClass, factionId: 0, position: { x: i * 1e15, y: 0, z: (i % 97) * 1e15 } });
    if (i > 0) {
      const j = Math.max(0, i - rng.nextInt(1, MAP_TREE_WINDOW));
      gates.push({ fromSystemId: firstId + i, toSystemId: firstId + j }, { fromSystemId: firstId + j,
        toSystemId: firstId + i });
    }
  }
  const extra = Math.floor(systems * MAP_EXTRA_EDGES);
  for (let k = 0; k < extra; k += 1) {
    const a = rng.nextInt(0, systems - 1);
    const b = Math.min(systems - 1, a + rng.nextInt(2, MAP_EXTRA_WINDOW));
    if (a === b) continue;
    gates.push({ fromSystemId: firstId + a, toSystemId: firstId + b }, { fromSystemId: firstId + b,
      toSystemId: firstId + a });
  }
  const built = buildUniverseGraph({ systems: list, gates });
  if (!built.ok) throw new Error(`synthetic graph: ${built.reason}`);
  const finder = createRouteFinder(built.graph, { cacheSize: 2048, maxJumps });
  return Object.freeze({ ...built.graph, ...finder.publicApi });
}

function parseValue(text) {
  if (text === "true") return true;
  if (text === "false") return false;
  const n = Number(text);
  return text !== "" && Number.isFinite(n) ? n : text;
}

function benchConfig(opts, extra) {
  const resolved = resolveConfig({ modDir: MOD_DIR, env: {} });
  const config = JSON.parse(JSON.stringify(resolved.config));
  for (const [dotted, value] of Object.entries({ ...(opts.set || {}), ...(extra || {}) })) {
    const parts = dotted.split(".");
    let node = config;
    for (const part of parts.slice(0, -1)) {
      if (!node[part] || typeof node[part] !== "object") node[part] = {};
      node = node[part];
    }
    node[parts[parts.length - 1]] = typeof value === "string" ? parseValue(value) : value;
  }
  config.persistence.dbFile = "bench.sqlite";
  config.testing.benchFleets = opts.fleets;
  config.testing.benchDwellMs = Math.round(opts.dwellMin * MS_PER_MINUTE);
  config.testing.benchRoamMaxJumps = opts.roamMaxJumps;
  config.limits.maxVirtualFleets = Math.max(config.limits.maxVirtualFleets, opts.fleets);
  if (!(extra && extra["scheduler.maxOpenEvents"] !== undefined)
    && !(opts.set && opts.set["scheduler.maxOpenEvents"] !== undefined)) {
    config.scheduler.maxOpenEvents = Math.max(config.scheduler.maxOpenEvents, 4 * opts.fleets);
  }
  return config;
}

function fakeTelemetry() {
  const counts = {};
  const gauges = {};
  return { counts, gauges,
    count(name, n = 1) {
      counts[name] = (counts[name] || 0) + n;
    },
    gauge(name, value) {
      gauges[name] = value;
    },
    observe() {},
    hooks: {} };
}

function createEnv(driver, opts, config, extra = {}) {
  const tmp = opts.memory ? null : fs.mkdtempSync(path.join(opts.dbDir || os.tmpdir(), "lne-bench-"));
  const file = opts.memory ? ":memory:" : path.join(tmp, config.persistence.dbFile);
  const p = config.persistence;
  const ckpt = { ms: [], frames: [] };
  const seedStats = { active: false, sliceMaxMs: 0 };
  const nowMs = typeof extra.nowMs === "function" ? extra.nowMs : () => performance.now();
  const opened = openStore({ filePath: file, openDatabase: (f) => new driver.Database(f), exclusiveLock: true,
    busyTimeoutMs: 0, maxRowsPerTransaction: p.maxRowsPerTransaction, maxWriteMsPerPass: p.maxWriteMsPerPass,
    managedCheckpoint: p.managedCheckpoint === true, walSafetyPages: p.walSafetyPages,
    checkpointFramesPerRowInitial: p.checkpointFramesPerRowInitial, checkpointFramesEwma: p.checkpointFramesEwma,
    nowMs, randomSeed: () => opts.seed >>> 0,
    onTiming: (name, ms, outcome, rows) => {
      if (name === CHECKPOINT_TIMING) {
        ckpt.ms.push(ms);
        ckpt.frames.push(rows || 0);
      } else if (seedStats.active && outcome !== undefined && ms > seedStats.sliceMaxMs) seedStats.sliceMaxMs = ms;
    } });
  if (!opened.ok) throw new Error(`store: ${opened.reason} ${opened.detail || ""}`);
  const store = opened.store;
  const clock = createManualClock(START_MS);
  const ids = createIdGenerator({ clock, rng: createRng(deriveSeed(opts.seed >>> 0, "bench-ids")) });
  const graph = extra.graph || syntheticGraph(opts.mapSystems, opts.seed >>> 0, config.graph.routeMaxJumps);
  const telemetry = fakeTelemetry();
  const lines = [];
  const logger = { log: (line) => lines.push(line) };
  const env = { store, clock, telemetry, lines, config, graph, file, scheduler: null, fleets: null, wrecks: null,
    battle: null,
    governor: extra.governor || null, startMs: 0, seedMs: 0, ckpt, seedStats, ready: Promise.resolve(null),
    checkpointer: null, afterPass: () => {} };
  if (p.managedCheckpoint === true) {
    let pendingTimer = null;
    const tickListeners = [];
    const checkpointer = createCheckpointer({ store, settings: p, nowMs, getGovernor: () => env.governor,
      addTickListener: (fn) => {
        tickListeners.push(fn);
        return { ok: true, remove: () => tickListeners.splice(tickListeners.indexOf(fn), 1) };
      },
      setTimer: (fn) => {
        const handle = { fn, cancel: () => {
          if (pendingTimer === handle) pendingTimer = null;
        } };
        pendingTimer = handle;
        return handle;
      },
      setImmediateFn: (fn) => fn(), metrics: telemetry, logger });
    checkpointer.start();
    env.checkpointer = checkpointer;
    env.afterPass = () => {
      const due = pendingTimer;
      pendingTimer = null;
      if (due) due.fn();
      for (const fn of tickListeners.slice()) fn({ intervalMs: 100 });
    };
  }

  function boot() {
    const journal = createJournal({ clock, maxPayloadBytes: p.journalMaxPayloadBytes,
      maxRows: store.limits.maxRowsPerTransaction });
    const startedAt = performance.now();
    const sr = startScheduler({ config, persistence: { ok: true, store }, clock, ids, telemetry, logger,
      nowMs, getGovernor: () => env.governor });
    if (!sr.ok) throw new Error(`scheduler: ${sr.reason} ${sr.detail || ""}`);
    env.scheduler = sr.scheduler;
    if (extra.noFleets) return;
    const fr = startFleets({ config, persistence: { ok: true, store, journal, worldSeed: opened.worldSeed,
      filePath: file }, clock,
      ids, telemetry, logger, scheduler: sr.scheduler, graph: { getGraph: () => ({ ok: true, graph }) },
      views: createViewRegistry(), nowMs: extra.nowMs });
    if (!fr.ok) throw new Error(`fleets: ${fr.reason} ${fr.detail || ""}`);
    env.fleets = fr.fleets;
    if (opts.battles) {
      const persistence = { ok: true, store, journal, worldSeed: opened.worldSeed, filePath: file };
      const wr = startWrecks({ config, persistence, clock, scheduler: sr.scheduler, telemetry, logger,
        nowMs: extra.nowMs });
      if (!wr.ok) throw new Error(`wrecks: ${wr.reason} ${wr.detail || ""}`);
      env.wrecks = wr.wrecks;
      const br = startBattle({ config, persistence, clock, ids, scheduler: sr.scheduler, fleets: fr.fleets,
        graph: { getGraph: () => ({ ok: true, graph }) }, wrecks: wr.wrecks, presence: null, telemetry, logger,
        resolver: extra.resolver, hooks: extra.hooks, nowMs: extra.nowMs });
      if (!br.ok) throw new Error(`battle: ${br.reason} ${br.detail || ""}`);
      env.battle = br.battle;
    }
    env.startMs = performance.now() - startedAt;
    const seedAt = performance.now();
    seedStats.active = true;
    env.ready = fr.fleets.benchReady().then((r) => {
      seedStats.active = false;
      env.seedMs = performance.now() - seedAt;
      return r;
    });
  }

  const stopBattles = (reason) => {
    if (env.battle) env.battle.stop(reason);
    if (env.wrecks) env.wrecks.stop(reason);
  };
  env.restart = () => {
    stopBattles("bench_restart");
    if (env.fleets) env.fleets.stop("bench_restart");
    env.scheduler.stop("bench_restart");
    boot();
  };
  env.close = () => {
    try {
      if (env.checkpointer) env.checkpointer.stop();
      stopBattles("bench_close");
      if (env.fleets) env.fleets.stop("bench_close");
      if (env.scheduler) env.scheduler.stop("bench_close");
    } finally {
      store.close("bench_close");
      if (tmp) {
        try {
          fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
        } catch (_err) {
        }
      }
    }
  };
  env.sizeBytes = () => {
    if (opts.memory) return 0;
    let total = 0;
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        total += fs.statSync(file + suffix).size;
      } catch (_err) {
      }
    }
    return total;
  };
  env.q = (sql, ...args) => {
    const r = store.transaction("bench.read", (db) => db.prepare(sql).all(...args));
    if (!r.ok) throw new Error(`read: ${r.reason}`);
    return r.value;
  };
  env.n = (sql, ...args) => env.q(sql, ...args)[0].n;
  boot();
  return env;
}

function newStats() {
  return { passes: 0, idle: 0, skipped: 0, events: 0, passMs: [], overrun: [], stoppedBy: {}, openMax: 0,
    backlogMax: 0, catchUpOver: 0, startedVirtual: 0, endedVirtual: 0, workMs: 0, writeMs: 0, saturatedPasses: 0,
    saturatedJobs: 0 };
}

function record(env, stats, r) {
  if (!r || r.ok !== true) {
    stats.stoppedBy.error = (stats.stoppedBy.error || 0) + 1;
    return;
  }
  if (r.skipped) {
    stats.skipped += 1;
    return;
  }
  stats.passes += 1;
  stats.events += r.jobs;
  stats.passMs.push(r.workMs);
  stats.workMs += r.workMs;
  stats.writeMs += r.writeMs;
  stats.overrun.push(Math.max(0, r.workMs - env.config.limits.maxSchedulerWorkMs));
  stats.stoppedBy[r.stoppedBy] = (stats.stoppedBy[r.stoppedBy] || 0) + 1;
  if (r.stoppedBy === "time" || r.stoppedBy === "write" || r.stoppedBy === "items") {
    stats.saturatedPasses += 1;
    stats.saturatedJobs += r.jobs;
  }
  if (r.catchUp && r.jobs > env.config.limits.maxCatchUpEventsPerPass) stats.catchUpOver += 1;
  const st = env.scheduler.getStatus();
  stats.openMax = Math.max(stats.openMax, st.open + st.inFlight);
  stats.backlogMax = Math.max(stats.backlogMax, env.telemetry.gauges["scheduler.dueBacklog"] || 0);
}

async function simulate(env, untilMs, stats, opts = {}) {
  const interval = env.config.scheduler.intervalMs;
  stats.startedVirtual = stats.startedVirtual || env.clock.now();
  while (env.clock.now() < untilMs) {
    if (opts.beforePass) opts.beforePass(env);
    const t0 = performance.now();
    const r = await env.scheduler.runPass();
    if (opts.onPassWall) opts.onPassWall(r, performance.now() - t0);
    record(env, stats, r);
    env.afterPass();
    if (opts.afterPass && opts.afterPass(env, r) === true) break;
    const now = env.clock.now();
    const next = env.scheduler.getStatus().nextDueAt;
    if (opts.idleSkip !== false && r && r.ok && !r.skipped && r.stoppedBy === "empty"
      && next !== null && next > now + interval) {
      stats.idle += 1;
      env.clock.set(Math.min(untilMs, next));
    } else if (opts.idleSkip !== false && next === null && r && r.ok && r.stoppedBy === "empty") {
      env.clock.set(untilMs);
    } else {
      env.clock.advance(interval);
    }
  }
  stats.endedVirtual = env.clock.now();
  return stats;
}

function invariants(env) {
  const r = env.store.transaction("bench.check", (db) => checkBenchInvariants(db, { now: env.clock.now(),
    catchUpLagMs: env.config.scheduler.catchUpLagMs }));
  return r.ok ? r.value : { ok: false, reason: r.reason };
}

function throughput(env, stats) {
  const cfg = env.config;
  const perSecond = 1000 / cfg.scheduler.intervalMs;
  if (stats.events === 0) return { T: 0, costMs: 0, writeMsPerEvent: 0 };
  const costMs = stats.workMs / stats.events;
  const writeMsPerEvent = stats.writeMs / stats.events;
  const perPass = Math.min(cfg.limits.maxDueEventsPerPass, cfg.limits.maxSchedulerWorkMs / Math.max(costMs, 1e-6),
    cfg.persistence.maxWriteMsPerPass / Math.max(writeMsPerEvent, 1e-6));
  const actual = stats.saturatedPasses > 0 ? round2((stats.saturatedJobs / stats.saturatedPasses) * perSecond) : null;
  return { T: round2(perPass * perSecond), actual, costMs: round3(costMs), writeMsPerEvent: round3(writeMsPerEvent) };
}

function summary(env, name, stats, extra = {}) {
  const hours = (stats.endedVirtual - stats.startedVirtual) / MS_PER_HOUR;
  const fleets = env.config.testing.benchFleets;
  const inv = env.fleets ? invariants(env) : null;
  const journal = env.n("SELECT count(*) AS n FROM world_event_journal");
  const queue = env.n("SELECT count(*) AS n FROM world_scheduled_events");
  const done = env.n("SELECT count(*) AS n FROM world_scheduled_events WHERE state = 'DONE'");
  const trips = inv && inv.ok ? Math.max(1, inv.plans) : 1;
  const tp = throughput(env, stats);
  const days = Math.max(hours / 24, 1e-9);
  return {
    name, fleets, hours: round2(hours), passes: stats.passes, idle: stats.idle, skipped: stats.skipped,
    events: stats.events, eventsPerSec: round2(stats.events / Math.max(1, hours * 3600)),
    passMs: { p50: round2(pct(stats.passMs, P50)), p95: round2(pct(stats.passMs, P95)),
      max: round2(stats.passMs.reduce((a, b) => Math.max(a, b), 0)) },
    overrunP95: round2(pct(stats.overrun, P95)), stoppedBy: stats.stoppedBy, openMax: stats.openMax,
    openPerFleet: round2(stats.openMax / Math.max(1, fleets)), backlogMax: stats.backlogMax,
    backlogEnd: env.telemetry.gauges["scheduler.dueBacklog"] || 0,
    journalPerTrip: round2(journal / trips), queuePerTrip: round2(queue / trips),
    donePerFleetDay: round2(done / Math.max(1, fleets) / days), mbPerDay: round2(env.sizeBytes() / BYTES_PER_MB / days),
    throughput: tp, demand: round2(stats.events / Math.max(1, hours * 3600)),
    staleEntries: env.telemetry.counts["scheduler.staleEntries"] || 0,
    quarantinedEvents: env.n("SELECT count(*) AS n FROM world_scheduled_events WHERE state <> 'DONE' AND state = 'QUARANTINED'"),
    quarantineReasons: env.q("SELECT event_type || ' ' || substr(last_error, 1, 80) AS r, count(*) AS n FROM "
      + "world_scheduled_events WHERE state <> 'DONE' AND state = 'QUARANTINED' GROUP BY r ORDER BY n DESC LIMIT 5"),
    seedMs: round2(env.startMs), seedWallMs: round2(env.seedMs), seedSliceMaxMs: round2(env.seedStats.sliceMaxMs),
    invariants: inv,
    checkpoint: checkpointSummary(env, stats), tickBlockMs: round2(Math.max(
      stats.passMs.reduce((a, b) => Math.max(a, b), 0), env.ckpt.ms.reduce((a, b) => Math.max(a, b), 0),
      env.seedStats.sliceMaxMs)), ...extra,
  };
}

function checkpointSummary(env, stats) {
  const ms = env.ckpt.ms;
  const frames = env.ckpt.frames.reduce((a, b) => a + b, 0);
  return { managed: env.config.persistence.managedCheckpoint === true, n: ms.length,
    ms: { p50: round2(pct(ms, P50)), p95: round2(pct(ms, P95)), max: round2(ms.reduce((a, b) => Math.max(a, b), 0)) },
    framesPerCkpt: ms.length > 0 ? round2(frames / ms.length) : 0,
    framesPerEvent: stats.events > 0 ? round2(frames / stats.events) : 0 };
}

function steadyFailures(s, cfg) {
  const out = [];
  const inv = s.invariants;
  if (!inv || !inv.ok) out.push(`${s.name}: invariants ${(inv && inv.reason) || "missing"}`);
  else {
    for (const key of ["doubleArrivals", "lostArrivals", "inFlightMismatch", "quarantined", "claimed"]) {
      if (inv[key] !== 0) out.push(`${s.name}: ${key}=${inv[key]}`);
    }
  }
  if (s.staleEntries !== 0) out.push(`${s.name}: staleEntries=${s.staleEntries}`);
  if (s.backlogEnd > cfg.limits.maxDueEventsPerPass) out.push(`${s.name}: dueBacklog end ${s.backlogEnd}`);
  return out;
}

async function scenarioSteady(driver, opts, label) {
  const config = benchConfig(opts);
  const env = createEnv(driver, opts, config);
  const wall = performance.now();
  try {
    await env.ready;
    const stats = newStats();
    await simulate(env, START_MS + Math.round(opts.hours * MS_PER_HOUR), stats);
    const s = summary(env, label || `steady ${opts.fleets}x${opts.hours}h`, stats,
      { wallS: round2((performance.now() - wall) / 1000) });
    s.okCriteria = { demandHalfT: s.demand <= 0.5 * s.throughput.T,
      passP95: s.passMs.p95 <= PASS_P95_TARGET_MS };
    s.failures = steadyFailures(s, config);
    return s;
  } finally {
    env.close();
  }
}

async function scenarioOffline(driver, opts) {
  const config = benchConfig(opts);
  const env = createEnv(driver, opts, config);
  const wall = performance.now();
  const failures = [];
  try {
    await env.ready;
    const warm = newStats();
    await simulate(env, START_MS + Math.round(opts.hours * MS_PER_HOUR), warm);
    env.scheduler.stop("offline");
    if (env.fleets) env.fleets.stop("offline");
    env.clock.advance(Math.round(opts.offlineHours * MS_PER_HOUR));
    const tRestart = env.clock.now();
    env.restart();
    await env.ready;
    const st0 = env.scheduler.getStatus();
    const open0 = st0.open;
    const offlineSql = "SELECT count(*) AS n FROM world_scheduled_events WHERE state <> 'DONE' AND state IN ('QUEUED','RETRY') "
      + "AND due_at <= ?";
    let backlog = env.n(offlineSql, tRestart);
    const backlog0 = backlog;
    const trail = [backlog];
    let increases = 0;
    const drain = newStats();
    await simulate(env, tRestart + DRAIN_MAX_MS, drain, { idleSkip: false, afterPass: () => {
      const now = env.n(offlineSql, tRestart);
      if (now > backlog) increases += 1;
      backlog = now;
      trail.push(now);
      return now === 0;
    } });
    const drainMs = env.clock.now() - tRestart;
    const drainEvents = drain.events;
    const drainOverdue = env.n("SELECT count(*) AS n FROM world_scheduled_events WHERE state IN ('DONE','QUARANTINED') "
      + "AND due_at <= ? AND finished_at >= ?", tRestart, tRestart);
    if (backlog !== 0) failures.push(`offline: backlog left ${backlog}`);
    if (increases > 0) failures.push(`offline: backlog grew in ${increases} passes`);
    if (drain.catchUpOver > 0) failures.push(`offline: ${drain.catchUpOver} catch-up passes over the cap`);
    if (drainOverdue > CHAIN_BOUND * Math.max(1, open0)) {
      failures.push(`offline: overdue events ${drainOverdue} > ${CHAIN_BOUND} x ${open0}`);
    }
    const after = newStats();
    await simulate(env, env.clock.now() + Math.round(Math.min(opts.hours, 1) * MS_PER_HOUR), after);
    const s = summary(env, `offline ${opts.fleets} warm ${opts.hours}h + ${opts.offlineHours}h down`, after, {
      wallS: round2((performance.now() - wall) / 1000), offline: { open0, rebuildMs: round2(st0.rebuildMs), backlog0,
        drainPasses: drain.passes, drainEvents, drainOverdue, drainMinutes: round2(drainMs / MS_PER_MINUTE), increases,
        coalesced: env.telemetry.counts["scheduler.periodicCoalesced"] || 0,
        lastEpisode: env.scheduler.getStatus().catchUp ? env.scheduler.getStatus().catchUp.lastEpisode : null,
        logLines: env.lines.filter((l) => l.startsWith("scheduler: catch-up")), trailHead: trail.slice(0, 8) } });
    s.offline.catchUpMaxPerPass = s.offline.lastEpisode ? s.offline.lastEpisode.maxPerPass : 0;
    s.failures = [...failures, ...steadyFailures(s, config)];
    return s;
  } finally {
    env.close();
  }
}

async function scenarioRebuild(driver, opts) {
  const out = { name: "rebuild", rows: [], failures: [] };
  for (const size of REBUILD_SIZES) {
    const config = benchConfig({ ...opts, fleets: 1 }, { "scheduler.maxOpenEvents": size + 1000 });
    const env = createEnv(driver, { ...opts, fleets: 1 }, config, { noFleets: true,
      graph: { getSystemsBySecClass: () => [] } });
    try {
      const batch = env.store.limits.maxRowsPerTransaction;
      const t0 = performance.now();
      for (let from = 0; from < size; from += batch) {
        const specs = [];
        for (let i = from; i < Math.min(size, from + batch); i += 1) {
          specs.push({ eventType: BENCH_EVENT_TYPE, aggregateId: `lnebench-r${i}`, dueAt: START_MS + REBUILD_FAR_MS + i,
            payload: { index: i, round: 0 }, idempotencyKey: `bench:rebuild:${i}` });
        }
        const r = env.scheduler.enqueueMany(specs);
        if (!r.ok || r.refusal) throw new Error(`rebuild insert: ${r.reason || r.refusal.reason}`);
      }
      const insertS = (performance.now() - t0) / 1000;
      env.restart();
      const st = env.scheduler.getStatus();
      out.rows.push({ open: st.open, rebuildMs: round2(st.rebuildMs), insertS: round2(insertS),
        mb: round2(env.sizeBytes() / BYTES_PER_MB) });
    } finally {
      env.close();
    }
  }
  return out;
}

async function scenarioFlood(driver, opts) {
  const o = { ...opts, fleets: Math.min(opts.fleets, FLOOD_FLEETS) };
  const config = benchConfig(o);
  const env = createEnv(driver, o, config);
  try {
    await env.ready;
    let handled = 0;
    env.scheduler.registerHandler("CONVOY_DELIVERY", () => {
      handled += 1;
      return { ok: true, outcome: "BENCH_NOOP" };
    });
    const warm = newStats();
    await simulate(env, START_MS + config.testing.benchDwellMs, warm);
    const tp = throughput(env, warm);
    let seq = 0;
    const convoys = (count) => {
      const specs = [];
      for (let i = 0; i < count; i += 1) {
        seq += 1;
        specs.push({ eventType: "CONVOY_DELIVERY", aggregateId: `convoy-${seq}`, dueAt: env.clock.now(), payload: {},
          idempotencyKey: `bench:convoy:${seq}` });
      }
      for (let from = 0; from < specs.length; from += env.store.limits.maxRowsPerTransaction) {
        env.scheduler.enqueueMany(specs.slice(from, from + env.store.limits.maxRowsPerTransaction));
      }
    };
    const probeSize = FLOOD_PROBE_PASSES * config.limits.maxDueEventsPerPass;
    convoys(probeSize);
    const before = handled;
    const probe = newStats();
    await simulate(env, env.clock.now() + DRAIN_MAX_MS, probe, { idleSkip: false,
      afterPass: () => handled - before >= probeSize });
    const capacityPerPass = probeSize / Math.max(1, probe.passes);
    const perPass = Math.max(1, Math.ceil(FLOOD_FACTOR * capacityPerPass));
    const floodStart = env.clock.now();
    const floodEnd = floodStart + FLOOD_MS;
    const flood = newStats();
    await simulate(env, floodEnd, flood, { idleSkip: false, beforePass: () => convoys(perPass) });
    const recover = newStats();
    let recoveredAt = null;
    await simulate(env, floodEnd + DRAIN_MAX_MS, recover, { idleSkip: false, afterPass: () => {
      const due = env.n("SELECT count(*) AS n FROM world_scheduled_events WHERE state <> 'DONE' AND state IN ('QUEUED','RETRY') "
        + "AND due_at <= ?", env.clock.now());
      if (due <= config.limits.maxDueEventsPerPass) {
        recoveredAt = env.clock.now();
        return true;
      }
      return false;
    } });
    const late = (priority) => env.q("SELECT finished_at - due_at AS l FROM world_scheduled_events WHERE state = 'DONE'"
      + " AND priority = ? AND due_at >= ? AND due_at < ?", priority, floodStart, floodEnd).map((r) => r.l);
    const p3 = late(3);
    const p4 = late(4);
    const s = summary(env, `flood ${o.fleets} + p1 x${FLOOD_FACTOR}`, flood, { flood: {
      T: tp.T, actual: tp.actual, convoyCapacityPerPass: round2(capacityPerPass), inflowPerPass: perPass,
      convoys: seq, handled,
      p3: { n: p3.length, p95Ms: pct(p3, P95), maxMs: p3.reduce((a, b) => Math.max(a, b), 0) },
      p4: { n: p4.length, p95Ms: pct(p4, P95), maxMs: p4.reduce((a, b) => Math.max(a, b), 0) },
      recoverMinutes: recoveredAt === null ? null : round2((recoveredAt - floodEnd) / MS_PER_MINUTE) } });
    s.failures = recoveredAt === null ? ["flood: backlog not recovered"] : [];
    const inv = s.invariants;
    for (const key of ["doubleArrivals", "quarantined", "claimed"]) {
      if (inv && inv.ok && inv[key] !== 0) s.failures.push(`flood: ${key}=${inv[key]}`);
    }
    return s;
  } finally {
    env.close();
  }
}

async function scenarioNearfull(driver, opts, steadyOpen) {
  const open = steadyOpen || Math.ceil(2 * opts.fleets);
  const limit = Math.max(100, Math.floor(NEARFULL_FACTOR * open));
  const config = benchConfig(opts, { "scheduler.maxOpenEvents": limit });
  const env = createEnv(driver, opts, config);
  try {
    await env.ready;
    const stats = newStats();
    let maxOver = 0;
    await simulate(env, START_MS + Math.round(Math.min(opts.hours, 6) * MS_PER_HOUR), stats, { afterPass: () => {
      const st = env.scheduler.getStatus();
      maxOver = Math.max(maxOver, st.open + st.inFlight - limit);
      return false;
    } });
    const queueFullQuarantined = env.n("SELECT count(*) AS n FROM world_scheduled_events WHERE state <> 'DONE' AND state = 'QUARANTINED'"
      + " AND last_error LIKE '%QUEUE_FULL%'");
    const s = summary(env, `nearfull ${opts.fleets} maxOpenEvents=${limit}`, stats, { nearfull: { limit,
      queueFull: env.telemetry.counts["scheduler.queueFull"] || 0,
      chainedOverLimit: env.telemetry.counts["scheduler.chainedOverLimit"] || 0, maxOver, queueFullQuarantined } });
    s.failures = queueFullQuarantined > 0 ? [`nearfull: ${queueFullQuarantined} QUEUE_FULL quarantines`] : [];
    return s;
  } finally {
    env.close();
  }
}

async function scenarioModes(driver, opts) {
  const config = benchConfig(opts);
  const { options } = normalizeOptions({ ...governorOptionsFromConfig(config), signal: "p95" });
  const env = createEnv(driver, opts, config);
  try {
    await env.ready;
    const core = createLoadGovernor({ options, tickAvailable: true, nowMs: env.clock.now() });
    env.governor = { evaluate: () => core.evaluate(env.clock.now()), getStatus: () => core.getStatus(),
      admits: (wc) => core.admits(wc) };
    let tick = MODE_TICK.NORMAL;
    const feed = () => {
      const now = env.clock.now();
      for (let i = 0; i < TICKS_PER_PASS; i += 1) {
        core.record(tick, now - (TICKS_PER_PASS - 1 - i) * (config.scheduler.intervalMs / TICKS_PER_PASS));
      }
    };
    const dueByPriority = () => {
      const rows = env.q("SELECT priority, count(*) AS n FROM world_scheduled_events WHERE state <> 'DONE' AND state IN ('QUEUED','RETRY')"
        + " AND due_at <= ? GROUP BY priority", env.clock.now());
      return Object.fromEntries(rows.map((r) => [`p${r.priority}`, r.n]));
    };
    await simulate(env, START_MS + config.testing.benchDwellMs, newStats(), { beforePass: feed });
    const phases = [];
    const skipWall = [];
    for (const mode of ["CONSTRAINED", "OVERLOADED", "SHED"]) {
      tick = MODE_TICK[mode];
      const before = dueByPriority();
      const stats = newStats();
      await simulate(env, env.clock.now() + MODE_MS, stats, { idleSkip: false, beforePass: feed,
        onPassWall: (r, ms) => {
          if (mode === "SHED" && r && r.skipped) skipWall.push(ms);
        } });
      phases.push({ mode, governor: core.getStatus().mode, before, after: dueByPriority(), passes: stats.passes,
        skipped: stats.skipped, events: stats.events });
    }
    tick = MODE_TICK.NORMAL;
    let back = null;
    const t0 = env.clock.now();
    const recover = newStats();
    await simulate(env, t0 + DRAIN_MAX_MS, recover, { idleSkip: false, beforePass: feed, afterPass: () => {
      const due = env.n("SELECT count(*) AS n FROM world_scheduled_events WHERE state <> 'DONE' AND state IN ('QUEUED','RETRY') "
        + "AND due_at <= ?", env.clock.now());
      if (core.getStatus().mode === "NORMAL" && due <= config.limits.maxDueEventsPerPass) {
        back = env.clock.now();
        return true;
      }
      return false;
    } });
    const s = summary(env, `modes ${opts.fleets}`, recover, { modes: { phases,
      shedSkipWallMs: { p95: round3(pct(skipWall, P95)), max: round3(skipWall.reduce((a, b) => Math.max(a, b), 0)),
        n: skipWall.length },
      recoverMinutes: back === null ? null : round2((back - t0) / MS_PER_MINUTE) } });
    s.failures = back === null ? ["modes: backlog not back to 0 in NORMAL"] : [];
    const inv = s.invariants;
    for (const key of ["doubleArrivals", "quarantined", "claimed"]) {
      if (inv && inv.ok && inv[key] !== 0) s.failures.push(`modes: ${key}=${inv[key]}`);
    }
    return s;
  } finally {
    env.close();
  }
}

async function scenarioBatch(driver, opts) {
  const out = { name: "batch", rows: [], failures: [] };
  for (const size of BATCH_SIZES) {
    const o = { ...opts, hours: Math.min(opts.hours, BATCH_HOURS) };
    const s = await scenarioSteady(driver, { ...o, set: { ...(opts.set || {}), "scheduler.claimBatchSize": size } },
      `batch ${size}`);
    out.rows.push({ claimBatchSize: size, overrunP95: s.overrunP95, passP95: s.passMs.p95, passMax: s.passMs.max,
      stoppedBy: s.stoppedBy, wallS: s.wallS });
    out.failures.push(...s.failures);
  }
  return out;
}

async function runBench(input) {
  const opts = { ...DEFAULTS, ...(input || {}) };
  const driver = loadDriver();
  if (!driver.ok) return { ok: false, failures: [`driver: ${driver.reason} ${driver.detail || ""}`], scenarios: [] };
  const scenarios = [];
  const say = (s) => {
    scenarios.push(s);
    if (!opts.quiet) process.stdout.write(`${formatScenario(s)}\n`);
  };
  try {
    const name = opts.scenario;
    if (name === "steady") say(await scenarioSteady(driver, opts));
    else if (name === "offline") say(await scenarioOffline(driver, { ...opts, offlineHours: opts.offlineHours || 12 }));
    else if (name === "rebuild") say(await scenarioRebuild(driver, opts));
    else if (name === "flood") say(await scenarioFlood(driver, opts));
    else if (name === "nearfull") say(await scenarioNearfull(driver, opts, null));
    else if (name === "modes") say(await scenarioModes(driver, opts));
    else if (name === "batch") say(await scenarioBatch(driver, opts));
    else if (name === "all") {
      let open5000 = null;
      for (const [fleets, hours] of ALL_STEADY) {
        const s = await scenarioSteady(driver, { ...opts, fleets, hours });
        if (fleets === 5000) open5000 = s.openMax;
        say(s);
      }
      say(await scenarioOffline(driver, { ...opts, fleets: 5000, hours: 1, offlineHours: opts.offlineHours || 12 }));
      say(await scenarioRebuild(driver, opts));
      say(await scenarioFlood(driver, { ...opts, fleets: FLOOD_FLEETS }));
      say(await scenarioNearfull(driver, { ...opts, fleets: 5000, hours: 6 }, open5000));
      say(await scenarioModes(driver, { ...opts, fleets: 5000 }));
      say(await scenarioBatch(driver, { ...opts, fleets: 5000 }));
    } else return { ok: false, failures: [`unknown scenario ${name}`], scenarios };
  } catch (err) {
    return { ok: false, failures: [`error: ${(err && err.stack) || err}`], scenarios };
  }
  const failures = scenarios.flatMap((s) => s.failures || []);
  return { ok: failures.length === 0, failures, scenarios };
}

function formatScenario(s) {
  if (s.rows) return `${s.name}: ${JSON.stringify(s.rows)}`;
  const head = `| ${s.name} | fleets ${s.fleets} | ${s.hours} h | passes ${s.passes}/${s.idle} idle`
    + ` | events ${s.events}`
    + ` (${s.eventsPerSec}/s) | passMs p50 ${s.passMs.p50} p95 ${s.passMs.p95} max ${s.passMs.max}`
    + ` | overrun p95 ${s.overrunP95} | stoppedBy ${JSON.stringify(s.stoppedBy)} | open max ${s.openMax}`
    + ` (${s.openPerFleet}/fleet) | backlog max ${s.backlogMax} end ${s.backlogEnd} | journal/trip ${s.journalPerTrip}`
    + ` | queue/trip ${s.queuePerTrip} | DONE/fleet/day ${s.donePerFleetDay} | MB/day ${s.mbPerDay}`
    + ` | T ${s.throughput.T}/s actual ${s.throughput.actual}/s cost ${s.throughput.costMs} ms`
    + ` write ${s.throughput.writeMsPerEvent} ms`
    + ` | start ${s.seedMs} ms seed ${s.seedWallMs} ms (slice max ${s.seedSliceMaxMs}) | tickBlock ${s.tickBlockMs} ms`
    + ` | wall ${s.wallS === undefined ? "-" : s.wallS} s |`;
  const inv = s.invariants && s.invariants.ok
    ? `\n  invariants: fleets=${s.invariants.fleets} plans=${s.invariants.plans}`
    + ` arrivals=${s.invariants.arrivals} inFlight=${s.invariants.inFlight}`
    + ` doubleArrivals=${s.invariants.doubleArrivals} lostArrivals=${s.invariants.lostArrivals}`
    + ` inFlightMismatch=${s.invariants.inFlightMismatch} quarantined=${s.invariants.quarantined}`
    + ` claimed=${s.invariants.claimed}` : "";
  const more = ["checkpoint", "offline", "flood", "nearfull", "modes", "okCriteria", "quarantineReasons"].filter((k) => s[k])
    .map((k) => `\n  ${k}: ${JSON.stringify(s[k])}`).join("");
  return head + inv + more;
}

function runCheck(file, lagMs) {
  const driver = loadDriver();
  if (!driver.ok) return { ok: false, line: `check: driver ${driver.reason}` };
  let db;
  try {
    db = new driver.Database(file, { readonly: true, fileMustExist: true });
  } catch (_err) {
    try {
      db = new driver.Database(file, { fileMustExist: true });
      db.pragma("query_only = 1");
    } catch (err) {
      return { ok: false, line: `check: open failed - ${(err && err.message) || err}` };
    }
  }
  try {
    const r = checkBenchInvariants(db, { now: Date.now(), catchUpLagMs: lagMs });
    const b = checkBattleInvariants(db);
    const battleLine = formatBattleCheck(b);
    if (!r.ok) return { ok: false, line: `check: ${r.reason} ${r.detail || ""}
${battleLine}` };
    return { ok: r.pass && b.ok === true && b.pass === true, line: `check: fleets=${r.fleets} plans=${r.plans}`
      + ` arrivals=${r.arrivals} inFlight=${r.inFlight}`
      + ` doubleArrivals=${r.doubleArrivals} lostArrivals=${r.lostArrivals} inFlightMismatch=${r.inFlightMismatch}`
      + ` quarantined=${r.quarantined} claimed=${r.claimed} -> ${r.pass ? "PASS" : "FAIL"}
${battleLine}` };
  } finally {
    db.close();
  }
}

function parseArgs(argv) {
  const opts = { set: {} };
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
    if (a === "--fleets") opts.fleets = num(next(), "fleets");
    else if (a === "--hours") opts.hours = num(next(), "hours");
    else if (a === "--dwell-min") opts.dwellMin = num(next(), "dwell-min");
    else if (a === "--roam-max-jumps") opts.roamMaxJumps = num(next(), "roam-max-jumps");
    else if (a === "--offline-hours") opts.offlineHours = num(next(), "offline-hours");
    else if (a === "--scenario") opts.scenario = next();
    else if (a === "--memory") opts.memory = true;
    else if (a === "--battles") opts.battles = true;
    else if (a === "--db-dir") opts.dbDir = next();
    else if (a === "--seed") opts.seed = num(next(), "seed");
    else if (a === "--map-systems") opts.mapSystems = num(next(), "map-systems");
    else if (a === "--json") opts.json = next();
    else if (a === "--check") opts.check = next();
    else if (a === "--lag-ms") opts.lagMs = num(next(), "lag-ms");
    else if (a === "--set") {
      const kv = next();
      const eq = kv.indexOf("=");
      if (eq < 1) throw new Error("--set needs key=value");
      opts.set[kv.slice(0, eq)] = kv.slice(eq + 1);
    } else throw new Error(`unknown argument ${a}`);
  }
  return opts;
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stdout.write(`bench: FAIL ${err.message}\n`);
    process.exitCode = 1;
    return;
  }
  if (opts.check) {
    const r = runCheck(opts.check, Number.isFinite(opts.lagMs) ? opts.lagMs : 60000);
    process.stdout.write(`${r.line}\n`);
    process.exitCode = r.ok ? 0 : 1;
    return;
  }
  const r = await runBench(opts);
  if (opts.json) fs.writeFileSync(opts.json, JSON.stringify(r, null, 2));
  process.stdout.write(r.ok ? "bench: PASS\n" : `bench: FAIL ${r.failures.join("; ")}\n`);
  process.exitCode = r.ok ? 0 : 1;
}

if (require.main === module) main();

module.exports = { runBench, runCheck, syntheticGraph, DEFAULTS, CHAIN_BOUND, createEnv, benchConfig, simulate,
  newStats, loadDriver, START_MS };
