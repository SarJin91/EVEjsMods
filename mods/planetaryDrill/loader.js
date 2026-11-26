"use strict";

const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const { isMainThread } = require("node:worker_threads");

const MOD_VERSION = "1.1.0";
const MOD_DIR = __dirname;
const RUNTIME_ROOT = path.resolve(MOD_DIR, "../..");
const LOG_PREFIX = "[planetaryDrill]";
const INSTALL_FLAG = "__planetaryDrillLoaderInstalled";
const API_SYMBOL = "evejs.planetaryDrill";
const NO_INSTALL_ENV = "EVEJS_PDRILL_NO_INSTALL";
const WRAPPED = Symbol.for("evejs.planetaryDrill.wrapped");

const TARGETS = Object.freeze({
  world: "server/src/space/worldData.js",
  sov: "server/src/services/sovereignty/sovStaticData.js",
  launch: "server/src/services/ship/orbitalLaunchRuntime.js",
});

function log(message) {
  console.log(`${LOG_PREFIX} ${message}`);
}

function logError(message, error = null) {
  console.error(`${LOG_PREFIX} ${message}`);
  if (error && error.stack) console.error(error.stack);
}

function exportHas(value, property, expectedType) {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return false;
  if (!Object.prototype.hasOwnProperty.call(value, property)) return false;
  return typeof value[property] === expectedType;
}

function canonicalize(filename) {
  const resolved = path.resolve(String(filename || ""));
  let canonical;
  try {
    canonical = (fs.realpathSync.native || fs.realpathSync)(resolved);
  } catch (_error) {
    canonical = resolved;
  }
  if (process.platform === "win32") {
    return path.win32.normalize(canonical.replace(/\//gu, "\\")).toLowerCase();
  }
  return path.posix.normalize(canonical.replace(/\\/gu, "/"));
}

function createRuntime({
  runtimeRoot = RUNTIME_ROOT,
  cfg,
  inspect = null,
  inspectLaunch = null,
  vendor = null,
  ledgerFile = null,
  defer = queueMicrotask,
  now = Date.now,
  logFn: rawLogFn = log,
  logErrorFn: rawLogErrorFn = logError,
} = {}) {
  const { guardLog } = require("./lib/launch");
  const logFn = guardLog(rawLogFn);
  const logErrorFn = guardLog(rawLogErrorFn);
  const { createSync } = require("./lib/overlay");
  const launchLedger = require("./lib/launchLedger");
  const state = {
    inert: false,
    wrapped: false,
    probed: false,
    worldData: null,
    launchExports: null,
    launchInert: false,
    launchWrapped: false,
    launchProbed: false,
    launchSwept: false,
  };
  const probe = inspect || (() => require("./lib/viability").inspect(runtimeRoot));
  const probeLaunch = inspectLaunch || (() => require("./lib/viability").inspectLaunch(runtimeRoot));
  const accessor = vendor || require("./lib/vendor").createVendor({
    runtimeRoot,
    worldData: () => state.worldData,
    launchRuntime: () => state.launchExports,
  });
  const launchStats = {
    launchCalls: 0,
    launchConverted: 0,
    launchRecorded: 0,
    launchReverted: 0,
    launchHeld: 0,
    launchRefused: 0,
    sweepRuns: 0,
    ledgerWriteErrors: 0,
    launchErrors: 0,
  };
  const held = new Set();
  let ledgerFileCache = ledgerFile;
  const ledgerFileOf = () => {
    if (!ledgerFileCache) ledgerFileCache = launchLedger.ledgerFileOf(accessor.dataRoot());
    return ledgerFileCache;
  };
  let launchStore = null;
  const storeOf = () => {
    if (!launchStore) {
      launchStore = require("./lib/launch").createLedgerStore({ ledgerFile: ledgerFileOf(), logErrorFn, stats: launchStats, now });
    }
    return launchStore;
  };
  const overlay = createSync({
    vendor: accessor,
    cfg,
    logFn,
    logErrorFn,
    defer,
    readLaunchLedger: () => (launchStore ? launchStore.load() : launchLedger.readLedger(ledgerFileOf(), { logErrorFn })),
  });

  function sweepNow(session = null) {
    if (!state.launchWrapped || state.launchInert) return { ok: false, reason: "inert" };
    return require("./lib/launch").sweep({
      vendor: accessor, cfg, store: storeOf(), now, logFn, logErrorFn, stats: launchStats, session, held,
    });
  }

  function maybeStartupSweep(result) {
    if (state.launchSwept || !state.launchWrapped || state.launchInert || !result || !result.ok) return;
    if (result.reason !== "rebuilt" && result.reason !== "unchanged" && result.reason !== "fast-path") return;
    state.launchSwept = true;
    defer(() => {
      try {
        sweepNow();
      } catch (error) {
        logErrorFn("startup launch sweep failed", error);
      }
    });
  }

  function launchDrift(symbol) {
    state.launchInert = true;
    logErrorFn(`DRIFT ${symbol} - Planetary Drill item conversion off (item ${cfg.launchTypeID} is not launched as a Skyhook); the overlay keeps working`);
    return { ok: false, reason: "drift" };
  }

  function applyLaunch(exports) {
    if (state.launchWrapped) return { ok: true };
    if (state.launchInert) return { ok: false, reason: "inert" };
    if (!exports || (typeof exports !== "object" && typeof exports !== "function")) return { ok: false, reason: "pending" };
    if (!exportHas(exports, "launchOrbitalsFromShip", "function")) {
      if (Object.keys(exports).length === 0) return { ok: false, reason: "pending" };
      return launchDrift("orbitalLaunchRuntime.launchOrbitalsFromShip");
    }
    if (!cfg.launchTypeID) {
      state.launchInert = true;
      logFn("Planetary Drill item conversion off (EVEJS_PDRILL_LAUNCH_TYPE_ID=0)");
      return { ok: false, reason: "off" };
    }
    if (!state.launchProbed) {
      state.launchProbed = true;
      const viable = probeLaunch();
      if (!viable.ok) {
        for (const report of viable.reports.filter((entry) => !entry.ok)) {
          logErrorFn(`DRIFT launch ${report.key}: ${report.reason}`);
        }
        return launchDrift("launch viability probe");
      }
    }
    const previous = exports.launchOrbitalsFromShip;
    state.launchExports = exports;
    if (previous[WRAPPED]) {
      state.launchWrapped = true;
      return { ok: true };
    }
    const { createLaunchWrapper } = require("./lib/launch");
    const wrapped = createLaunchWrapper({
      original: previous,
      vendor: accessor,
      cfg,
      store: storeOf,
      now,
      logFn,
      logErrorFn,
      stats: launchStats,
      held,
      isInert: () => state.launchInert || !accessor.launchReady(),
    });
    Object.defineProperty(wrapped, WRAPPED, { value: true });
    exports.launchOrbitalsFromShip = wrapped;
    state.launchWrapped = true;
    logFn(`v${MOD_VERSION} wrapped orbitalLaunchRuntime.launchOrbitalsFromShip (item ${cfg.launchTypeID} and variants 340102-340116 launch as Skyhook 81080, drillItemsOnly=${cfg.drillItemsOnly})`);
    return { ok: true };
  }

  function drift(symbol) {
    state.inert = true;
    logErrorFn(`DRIFT ${symbol} mod inert, WARN: skyhooks outside sov null-sec get no reagent; the next sovereignty bootstrap drops the drills' stock`);
    return { ok: false, reason: "drift" };
  }

  function applyWorld(exports) {
    if (exports && (typeof exports === "object" || typeof exports === "function")) state.worldData = exports;
    return { ok: true };
  }

  function applySov(exports) {
    if (state.wrapped) return { ok: true };
    if (state.inert) return { ok: false, reason: "inert" };
    if (!exports || (typeof exports !== "object" && typeof exports !== "function")) return { ok: false, reason: "pending" };
    if (!exportHas(exports, "getSovereigntyStaticSnapshot", "function")) {
      if (Object.keys(exports).length === 0) return { ok: false, reason: "pending" };
      return drift("sovStaticData.getSovereigntyStaticSnapshot");
    }
    if (!state.probed) {
      state.probed = true;
      const viable = probe();
      if (!viable.ok) {
        for (const report of viable.reports.filter((entry) => !entry.ok)) {
          logErrorFn(`DRIFT ${report.key}: ${report.reason}`);
        }
        return drift("viability probe");
      }
    }

    const previous = exports.getSovereigntyStaticSnapshot;
    if (previous[WRAPPED]) {
      state.wrapped = true;
      return { ok: true };
    }
    const wrapped = function getSovereigntyStaticSnapshot() {
      const snapshot = previous.apply(this, arguments);
      if (!state.inert) {
        try {
          maybeStartupSweep(overlay.sync(snapshot));
        } catch (error) {
          logErrorFn("overlay sync threw - snapshot returned unchanged", error);
        }
      }
      return snapshot;
    };
    Object.defineProperty(wrapped, WRAPPED, { value: true });
    exports.getSovereigntyStaticSnapshot = wrapped;
    state.wrapped = true;
    logFn(`v${MOD_VERSION} active - wrapped sovStaticData.getSovereigntyStaticSnapshot (probe ok, enabled=${cfg.enabled})`);
    return { ok: true };
  }

  return { state, stats: overlay.stats, launchStats, overlay, applyWorld, applySov, applyLaunch, sweepNow };
}

function installModuleHook(runtime, runtimeRoot, logErrorFn = logError) {
  const targets = new Map(
    Object.entries(TARGETS).map(([kind, relative]) => [
      canonicalize(path.resolve(runtimeRoot, ...relative.split("/"))),
      kind,
    ]),
  );
  const pending = new Set(Object.keys(TARGETS));
  const identities = new Map();

  function apply(kind, exports) {
    const result = kind === "world" ? runtime.applyWorld(exports)
      : kind === "launch" ? runtime.applyLaunch(exports) : runtime.applySov(exports);
    if (result.ok || result.reason !== "pending") pending.delete(kind);
  }

  function kindOf(filename) {
    if (!identities.has(filename)) identities.set(filename, targets.get(canonicalize(filename)) || null);
    return identities.get(filename);
  }

  const cached = Object.keys(Module._cache)
    .map((filename) => ({ filename, kind: kindOf(filename) }))
    .filter((entry) => entry.kind && Module._cache[entry.filename])
    .sort((left, right) => (left.kind === "world" ? -1 : 0) - (right.kind === "world" ? -1 : 0));
  for (const entry of cached) apply(entry.kind, Module._cache[entry.filename].exports);

  const previousLoad = Module._load;
  function hookedLoad(request, parent, isMain) {
    const exports = previousLoad.apply(this, arguments);
    if (pending.size === 0) return exports;
    try {
      if (typeof request !== "string" || Module.isBuiltin(request)) return exports;
      const filename = Module._resolveFilename(request, parent, isMain);
      const kind = kindOf(filename);
      if (kind && pending.has(kind)) apply(kind, exports);
    } catch (error) {
      logErrorFn(`hook error on ${String(request)} - ignored`, error);
    }
    return exports;
  }
  Module._load = hookedLoad;
  return { hookedLoad, previousLoad, pending };
}

function install(options = {}) {
  if (!isMainThread) return { active: false, reason: "worker-thread" };
  if (globalThis[INSTALL_FLAG]) return { active: false, reason: "already-installed" };

  const runtimeRoot = path.resolve(options.runtimeRoot || RUNTIME_ROOT);
  const environment = options.environment || process.env;
  const { guardLog } = require("./lib/launch");
  const logFn = guardLog(options.logFn || log);
  const logErrorFn = guardLog(options.logErrorFn || logError);
  const config = require("./config").load(MOD_DIR, environment);
  if (config.problems.length > 0) {
    for (const problem of config.problems) logErrorFn(problem);
    logErrorFn("invalid configuration - no hooks installed, vanilla skyhooks");
    return { active: false, reason: "invalid-config", config };
  }
  if (!config.enabled) return { active: false, reason: "disabled", config };

  const runtime = createRuntime({ runtimeRoot, cfg: config, logFn, logErrorFn });
  const hookState = installModuleHook(runtime, runtimeRoot, logErrorFn);
  const api = Object.freeze({
    version: MOD_VERSION,
    config,
    stats: () => ({
      ...runtime.stats,
      ...runtime.launchStats,
      inert: runtime.state.inert,
      wrapped: runtime.state.wrapped,
      launchInert: runtime.state.launchInert,
      launchWrapped: runtime.state.launchWrapped,
    }),
  });
  globalThis[Symbol.for(API_SYMBOL)] = api;
  const installState = Object.freeze({ active: true, api, config, runtimeRoot, runtime, hookState });
  globalThis[INSTALL_FLAG] = installState;
  return installState;
}

let installResult = null;
if (!process.env[NO_INSTALL_ENV]) {
  try {
    installResult = install();
  } catch (error) {
    logError("loader failed before activation - vanilla skyhooks", error);
    installResult = { active: false, reason: "exception", error };
  }
}

module.exports = {
  API_SYMBOL,
  INSTALL_FLAG,
  MOD_DIR,
  MOD_VERSION,
  NO_INSTALL_ENV,
  RUNTIME_ROOT,
  TARGETS,
  WRAPPED,
  install,
  installResult,
  _testing: Object.freeze({ canonicalize, createRuntime, exportHas, installModuleHook }),
};
