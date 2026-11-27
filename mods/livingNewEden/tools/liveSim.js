"use strict";

const fs = require("node:fs");
const path = require("node:path");

const { findServerSrcOnDisk, GAMESTORE_SEARCH_MAX_DEPTH } = require("../lib/adapter/locator");
const { resolveSqliteDriver } = require("../lib/adapter/sqliteDriver");
const { createServiceRegistry } = require("../lib/runtime/services");
const { buildSdeWorld, loadPiratePolicy, loadSecurityBand } = require("./campaign/sdeWorld");
const { parseArgs, DEFAULTS } = require("./liveSim/args");
const { prepareDataDir } = require("./liveSim/dataDir");
const { resumeAnchor, createScaledClock, readAnchor, writeAnchor, schedulerParity } = require("./liveSim/clock");
const { buildLiveConfig } = require("./liveSim/profile");
const { parseComposeEnv, compareWithSchema } = require("./liveSim/compose");
const { createShutdownHooks } = require("./liveSim/shutdown");
const { createLiveAdapter } = require("./liveSim/liveAdapter");
const { collectStatus, formatStatus } = require("./liveSim/status");
const { runLiveCheck, takeCheckSnapshot, formatLiveCheck, checkRecord, nextCheckDelayMs,
  advanceCheckAt } = require("./liveSim/checks");

const MOD_DIR = path.resolve(__dirname, "..");
const MANIFEST = path.join(MOD_DIR, "evejs-launcher.mod.json");
const SHIM_DIR = path.join(__dirname, "liveSim", "sqliteShim");
const MS_PER_HOUR = 3600000;
const ADDRESS_POLL_MS = 50;
const ADDRESS_WAIT_MS = 2000;
const EXIT_FALLBACK_MS = 3000;
const SIGNALS = Object.freeze(["SIGINT", "SIGTERM", "SIGBREAK", "SIGHUP"]);
const BOOT_WAITS = Object.freeze(["graph", "strategy", "stations", "construction", "siege"]);
const EXIT_REFUSED = 2;
const EXIT_FORCED = 1;

function messageOf(err) {
  return String((err && err.message) || err);
}

function consoleLogger() {
  return { log: (line) => process.stdout.write(`${line}\n`), logError: (m, e) => process.stderr.write(`${m}: ${messageOf(e)}\n`) };
}

function refusal(reason, detail) {
  return { ok: false, reason, ...(detail ? { detail: String(detail) } : {}) };
}

function modVersion() {
  try {
    const v = JSON.parse(fs.readFileSync(MANIFEST, "utf8")).version;
    return typeof v === "string" ? v : null;
  } catch (_err) {
    return null;
  }
}

function prepareWorld(opts) {
  const found = findServerSrcOnDisk(MOD_DIR, GAMESTORE_SEARCH_MAX_DEPTH, fs.existsSync);
  if (!found.ok) return refusal("SERVER_SRC_NOT_FOUND", found.reason);
  const driver = resolveSqliteDriver(found.srcDir);
  if (!driver || !driver.ok) return refusal("SQLITE_DRIVER_UNAVAILABLE", driver && (driver.detail || driver.reason));
  const rss0 = process.memoryUsage().rss;
  const t0 = Date.now();
  const sde = buildSdeWorld(opts.sde, { statics: opts.statics });
  if (!sde.ok) return sde;
  const sdeInfo = { ms: Date.now() - t0, rssDeltaMB: Math.round((process.memoryUsage().rss - rss0) / 1048576) };
  const band = loadSecurityBand(found.srcDir);
  if (!band.ok) return band;
  const policy = loadPiratePolicy(found.srcDir, sde.world.worldData);
  if (!policy.ok) return policy;
  return { ok: true, serverSrc: found.srcDir, driver, world: sde.world, band: band.band, policy: policy.policy,
    sdeInfo };
}

function sdeStaticsLine(world, info) {
  const tail = `ms=${info.ms} rssDeltaMB=${info.rssDeltaMB}`;
  const s = world.statics;
  if (!s) return `liveSim: sde statics off ${tail}`;
  return `liveSim: sde statics suns=${s.suns} planets=${s.planets} belts=${s.belts} gates=${s.gates} `
    + `stations=${s.stations} ${tail}`;
}

function isShimDriver(serverSrc) {
  try {
    const resolved = require.resolve("better-sqlite3", { paths: [serverSrc] });
    return path.resolve(resolved).toLowerCase().startsWith(path.resolve(SHIM_DIR).toLowerCase());
  } catch (_err) {
    return false;
  }
}

function serverFilesLoaded(serverSrc) {
  const root = `${path.resolve(serverSrc)}${path.sep}`.toLowerCase();
  return Object.keys(require.cache).filter((k) => path.resolve(k).toLowerCase().startsWith(root))
    .map((k) => path.relative(serverSrc, k).split(path.sep).join("/")).sort();
}

function liveStarters(speed) {
  const realScheduler = require("../lib/scheduler").startScheduler;
  const setTimer = (fn, ms) => {
    const handle = setTimeout(fn, schedulerParity(ms, speed).wallMs);
    if (handle && typeof handle.unref === "function") handle.unref();
    return { cancel: () => clearTimeout(handle), hasRef: () => Boolean(handle && handle.hasRef && handle.hasRef()) };
  };
  return { startScheduler: (deps) => realScheduler({ ...deps, setTimer }) };
}

function serviceState(registry, name) {
  const s = registry.getStatus().services.find((x) => x.name === name);
  return s || { name, state: "missing", reason: null };
}

function statusCounts(registry) {
  const out = { running: 0, disabled: 0, failed: 0 };
  for (const s of registry.getStatus().services) if (out[s.state] !== undefined) out[s.state] += 1;
  return out;
}

function waitAddress(ctx) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const poll = () => {
      const addr = ctx.observer && typeof ctx.observer.address === "function" ? ctx.observer.address() : null;
      if (addr || Date.now() - startedAt >= ADDRESS_WAIT_MS) {
        resolve(addr);
        return;
      }
      setTimeout(poll, ADDRESS_POLL_MS);
    };
    poll();
  });
}

function readCompose(file) {
  if (!file) return { ok: true, file: null, parsed: null };
  let text;
  try {
    text = fs.readFileSync(path.resolve(file), "utf8");
  } catch (err) {
    return refusal("ARGS_INVALID", `--compose ${file}: ${messageOf(err)}`);
  }
  const parsed = parseComposeEnv(text);
  if (!parsed.ok) return refusal("ARGS_INVALID", `--compose ${file}: ${parsed.detail}`);
  return { ok: true, file: path.resolve(file), parsed };
}

function composeLines(compose) {
  if (!compose.parsed) {
    return ["liveSim: warning - config without compose defaults (SCHEMA < --settings < --env-file < --set; "
      + "Docker reads compose.yaml environment: too, use --compose compose.yaml)"];
  }
  const p = compose.parsed;
  const cmp = compareWithSchema(p.values);
  const lines = [`liveSim: compose defaults ${Object.keys(p.values).length} keys from service ${p.service} `
    + `(${p.keys} entries, ${p.fixed} fixed, ${p.keys - Object.keys(p.values).length} empty) - ${cmp.differ.length} `
    + `differ from SCHEMA - ${compose.file}`];
  if (cmp.unknown.length > 0) lines.push(`liveSim: warning - compose keys without a SCHEMA row: ${cmp.unknown.join(", ")}`);
  if (cmp.invalid.length > 0) lines.push(`liveSim: warning - compose values not of the row type: ${cmp.invalid.join(", ")}`);
  return lines;
}

function hours(ms) {
  return `${(ms / MS_PER_HOUR).toFixed(2)}h`;
}

async function runLiveSim(input, deps = {}) {
  const logger = deps.logger || consoleLogger();
  const wallNow = typeof deps.wallNow === "function" ? deps.wallNow : Date.now;
  const installSignals = deps.installSignals !== false;
  const opts = { ...DEFAULTS, ...(input || {}), set: { ...((input && input.set) || {}) } };
  for (const [flag, file] of [["--env-file", opts.envFile], ["--settings", opts.settings], ["--compose", opts.compose]]) {
    if (file && !fs.existsSync(path.resolve(file))) return refusal("ARGS_INVALID", `${flag} ${file} does not exist`);
  }
  const compose = readCompose(opts.compose);
  if (!compose.ok) return compose;

  const dir = prepareDataDir(opts, { env: deps.env || process.env });
  if (!dir.ok) return dir;
  const dataDir = dir.dataDir;
  const prev = readAnchor(dataDir);
  if (!prev.ok) return prev;
  const wallStart = wallNow();
  const resumed = resumeAnchor(prev.anchor, opts, wallStart);
  const anchor = resumed.anchor;

  const world = prepareWorld(opts);
  if (!world.ok) return world;
  if (isShimDriver(world.serverSrc)) logger.log("liveSim: sqlite driver = node:sqlite shim (timings are not a measurement)");
  else logger.log(`liveSim: sqlite driver = better-sqlite3 ${world.driver.version || ""}`.trim());

  const cfg = buildLiveConfig({ ...opts, composeEnv: compose.parsed ? compose.parsed.values : null,
    composeEntries: compose.parsed ? compose.parsed.entries : null }, { dataDir, modDir: MOD_DIR });
  if (!cfg.ok) return cfg;
  for (const line of composeLines(compose)) logger.log(line);
  for (const w of cfg.warnings) logger.log(`config: warning - ${w}`);
  for (const line of cfg.forced) logger.log(line);
  const parity = schedulerParity(cfg.config.scheduler.intervalMs, opts.speed);
  if (parity.warning) {
    logger.log(`liveSim: warning - speed ${opts.speed} > parity limit ${parity.parityLimit}, scheduler throughput per `
      + `virtual second is ${parity.parityLimit}/${opts.speed} of production`);
  }
  logger.log(sdeStaticsLine(world.world, world.sdeInfo));

  const shutdown = createShutdownHooks();
  const live = createLiveAdapter({ world: world.world, driver: world.driver, policy: world.policy, band: world.band,
    shutdown, stationsFromStatics: Boolean(cfg.config.population && cfg.config.population.enabled === true) });
  const clock = createScaledClock({ anchor, speed: opts.speed, wallNow });
  const anchorAt = (cleanStop) => ({ ...anchor, wallAt: wallNow(), virtualAt: clock.now(), cleanStop });
  if (dir.fresh) {
    const w = writeAnchor(dataDir, anchor);
    if (!w.ok) return refusal("DATA_DIR_REFUSED", w.detail);
  } else if (prev.anchor) {
    const p = writeAnchor(dataDir, { ...prev.anchor, pendingVirtualAt: anchor.virtualAt });
    if (!p.ok) logger.log(`liveSim: anchor write failed - ${p.detail}`);
  }
  let lastAnchorWallAt = wallNow();
  let maxWriteGapMs = 0;
  const writeAnchorNow = (cleanStop, patch) => {
    const at = wallNow();
    maxWriteGapMs = Math.max(maxWriteGapMs, at - lastAnchorWallAt);
    lastAnchorWallAt = at;
    const w = writeAnchor(dataDir, { ...anchorAt(cleanStop), ...(patch || {}),
      maxWriteGapS: Math.ceil(maxWriteGapMs / 1000) });
    if (!w.ok) logger.log(`liveSim: anchor write failed - ${w.detail}`);
    return w;
  };

  const ctx = { config: cfg.config, adapter: live.adapter, modDir: MOD_DIR, modVersion: modVersion(),
    state: { configResult: cfg.configResult, bootGate: { diag: { liveSim: true, speed: opts.speed } } } };
  const registry = createServiceRegistry({ logger, starters: liveStarters(opts.speed), clock,
    ...(opts.seed !== null ? { randomSeed: () => opts.seed >>> 0 } : {}) });
  ctx.services = registry;
  const started = registry.startAll(ctx);

  const hard = [["persistence", "PERSISTENCE_NOT_RUNNING"], ["scheduler", "SCHEDULER_NOT_RUNNING"]];
  let refused = started.ok ? null : refusal("SERVICES_NOT_STARTED", `${started.reason}${started.detail ? ` ${started.detail}` : ""}`);
  for (const [name, reason] of hard) {
    if (refused) break;
    const s = serviceState(registry, name);
    if (s.state !== "running") refused = refusal(reason, `${s.state}${s.reason ? `:${s.reason}` : ""}`);
  }
  if (refused) {
    await shutdown.run("refused");
    registry.stopAll("liveSim_refused");
    return refused;
  }
  const counts = statusCounts(registry);
  logger.log(`liveSim: services running=${counts.running} disabled=${counts.disabled} failed=${counts.failed}`);
  writeAnchorNow(false);

  Promise.all(BOOT_WAITS.map((n) => ctx[n]).filter((svc) => svc && typeof svc.whenReady === "function")
    .map((svc) => Promise.resolve(svc.whenReady()).catch(() => null)))
    .then(() => logger.log("liveSim: boot ready"), () => null);

  const addr = await waitAddress(ctx);
  const observerUrl = addr ? `http://127.0.0.1:${addr.port}/` : "-";
  logger.log(`liveSim: running speed=${opts.speed} virtual=${new Date(clock.now()).toISOString()} `
    + `offline=${opts.offline} gap=${hours(resumed.gapMs)} runs=${anchor.runs} observer=${observerUrl} data=${dataDir}`);

  const dbFile = path.join(dataDir, cfg.config.persistence.dbFile);
  const statusFile = opts.statusFile ? path.resolve(dataDir, opts.statusFile) : null;
  const statusInput = { clock, firstVirtualAt: anchor.firstVirtualAt, speed: opts.speed, ctx,
    getUnsupported: live.getUnsupported, dbFile, wallNow };
  const status = () => collectStatus(statusInput);
  const printStatus = () => {
    try {
      const s = status();
      logger.log(formatStatus(s));
      if (statusFile) fs.appendFileSync(statusFile, `${JSON.stringify(s)}\n`);
    } catch (err) {
      logger.logError("liveSim: status failed", err);
    }
  };
  const timers = [];
  timers.push(setInterval(printStatus, opts.statusMin * 60000));
  timers.push(setInterval(() => writeAnchorNow(false), opts.anchorEveryS * 1000));

  let stopping = null;
  let resolveDone;
  const done = new Promise((resolve) => {
    resolveDone = resolve;
  });
  const signalHandlers = [];
  const startVirtualAt = anchor.virtualAt;
  const checkEveryMs = opts.checksEveryVirtualH * MS_PER_HOUR;
  const checkStats = { runs: 0, pass: 0, fail: 0, error: 0, lastLine: null };
  let checkTimer = null;

  function stop(reason) {
    if (stopping !== null) return stopping;
    stopping = (async () => {
      for (const t of timers.splice(0)) {
        clearInterval(t);
        clearTimeout(t);
      }
      if (checkTimer !== null) clearTimeout(checkTimer);
      checkTimer = null;
      printStatus();
      const hooks = await shutdown.run(String(reason));
      for (const r of hooks.results) if (!r.success) logger.log(`liveSim: shutdown hook ${r.name} failed - ${r.error}`);
      if (!registry.getStatus().stopped) registry.stopAll(String(reason));
      const stopVirtualAt = clock.now();
      writeAnchorNow(true, { virtualAt: stopVirtualAt });
      const wallElapsedMs = wallNow() - wallStart;
      const report = { reason: String(reason), speed: opts.speed, runs: anchor.runs, dataDir,
        wallElapsedMs, virtualElapsedMs: stopVirtualAt - startVirtualAt, startVirtualAt, stopVirtualAt,
        gapMs: resumed.gapMs, offline: resumed.mode,
        services: registry.getStatus().services.map((s) => ({ name: s.name, state: s.state, reason: s.reason })),
        unsupported: live.getUnsupported(), serverFilesLoaded: serverFilesLoaded(world.serverSrc),
        checks: { everyVirtualH: opts.checksEveryVirtualH, ...checkStats } };
      if (opts.reportJson) {
        try {
          fs.writeFileSync(path.resolve(opts.reportJson), `${JSON.stringify(report, null, 2)}\n`);
        } catch (err) {
          logger.logError("liveSim: report write failed", err);
        }
      }
      for (const [sig, fn] of signalHandlers.splice(0)) process.removeListener(sig, fn);
      logger.log(`liveSim: stopped (${reason})`);
      resolveDone(report);
      return { ok: true, report };
    })().catch((err) => {
      logger.logError("liveSim: stop failed", err);
      const report = { reason: String(reason), error: messageOf(err) };
      resolveDone(report);
      return { ok: true, report };
    });
    return stopping;
  }

  if (checkEveryMs > 0) {
    const s = takeCheckSnapshot(ctx);
    let prevSnap = s.ok ? s.snap : null;
    if (!s.ok) logger.log(`liveSim: checks snapshot failed ${s.reason}${s.detail ? ` ${s.detail}` : ""}`);
    let nextAt = clock.now() + checkEveryMs;
    const arm = () => {
      if (stopping !== null) return;
      checkTimer = setTimeout(runCheck, nextCheckDelayMs(nextAt, clock.now(), opts.speed));
    };
    const runCheck = () => {
      checkTimer = null;
      if (stopping !== null) return;
      const now = clock.now();
      if (now < nextAt) {
        arm();
        return;
      }
      try {
        const r = runLiveCheck({ ctx, config: cfg.config, prev: prevSnap, now });
        if (r.ok) prevSnap = r.snap;
        const line = formatLiveCheck(r, now);
        logger.log(line);
        checkStats.runs += 1;
        if (!r.ok) checkStats.error += 1;
        else if (r.result.pass === true) checkStats.pass += 1;
        else checkStats.fail += 1;
        checkStats.lastLine = line;
        if (statusFile) fs.appendFileSync(statusFile, `${JSON.stringify(checkRecord(r, { wallAt: wallNow(), virtualAt: now }))}\n`);
      } catch (err) {
        logger.logError("liveSim: checks record failed", err);
      }
      writeAnchorNow(false);
      nextAt = advanceCheckAt(nextAt, clock.now(), checkEveryMs);
      arm();
    };
    arm();
  }

  if (opts.durationS !== null) timers.push(setTimeout(() => stop("duration"), opts.durationS * 1000));

  if (installSignals) {
    for (const sig of SIGNALS) {
      const fn = () => {
        if (stopping !== null) {
          logger.log("liveSim: forced exit");
          process.exit(EXIT_FORCED);
        }
        stop(`signal:${sig}`);
      };
      try {
        process.on(sig, fn);
        signalHandlers.push([sig, fn]);
      } catch (_err) {
      }
    }
  }

  const handle = Object.freeze({
    stop,
    clock,
    address: () => (ctx.observer && typeof ctx.observer.address === "function" ? ctx.observer.address() : null),
    status,
    done,
    ctx,
  });
  return { ok: true, handle };
}

async function main() {
  const logger = consoleLogger();
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed.ok) {
    logger.log(`liveSim: refused ${parsed.reason} ${parsed.detail}`);
    process.exitCode = EXIT_REFUSED;
    return;
  }
  let r;
  try {
    r = await runLiveSim(parsed.opts, { logger });
  } catch (err) {
    r = refusal("LIVESIM_THREW", messageOf(err));
  }
  if (!r.ok) {
    logger.log(`liveSim: refused ${r.reason}${r.detail ? ` ${r.detail}` : ""}`);
    process.exitCode = EXIT_REFUSED;
    return;
  }
  await r.handle.done;
  process.exitCode = 0;
  const t = setTimeout(() => process.exit(0), EXIT_FALLBACK_MS);
  t.unref();
}

if (require.main === module) main();

module.exports = { runLiveSim, liveStarters, serverFilesLoaded, readCompose, composeLines };
