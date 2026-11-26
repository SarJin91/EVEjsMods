"use strict";

const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const { isMainThread } = require("node:worker_threads");

const MOD_VERSION = "1.0.0";
const MOD_DIR = __dirname;
const RUNTIME_ROOT = path.resolve(MOD_DIR, "../..");
const LOG_PREFIX = "[dailyGoalsPersist]";
const INSTALL_FLAG = "__dailyGoalsPersistLoaderInstalled";
const API_SYMBOL = "evejs.dailyGoalsPersist";
const NO_INSTALL_ENV = "EVEJS_DAILY_GOALS_PERSIST_NO_INSTALL";

const TARGETS = Object.freeze({
  store: "server/src/gameStore/index.js",
  goals: "server/src/services/dailyGoals/dailyGoalsState.js",
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

function createRuntime({ config, now = Date.now, logFn = log, logErrorFn = logError }) {
  const wraps = require("./lib/wraps");
  const { createRedeemLog } = require("./lib/redeemLog");
  const state = { inert: false, storeWrapped: false, goalsWrapped: false };
  const stats = { forcedWrites: 0 };
  const redeemLog = createRedeemLog({ config, now, logFn });

  function drift(symbol) {
    state.inert = true;
    logErrorFn(`DRIFT ${symbol} - mod inert, vanilla daily goals`);
    return { ok: false, reason: "drift" };
  }

  function applyStore(exports) {
    if (state.storeWrapped) return { ok: true };
    if (state.inert) return { ok: false, reason: "inert" };
    if (!exportHas(exports, "read", "function")) return { ok: false, reason: "pending" };
    if (!exportHas(exports, "write", "function")) return drift("gameStore.write");
    const result = wraps.wrapStoreWrite(exports, { state, stats, onError: logErrorFn });
    if (!result.ok && result.reason !== "already-wrapped") return drift("gameStore.write");
    state.storeWrapped = true;
    logFn("wrapped gameStore.write (dailyGoals root writes forced)");
    return { ok: true };
  }

  function applyGoals(exports) {
    if (!config.redeemLog) return { ok: true };
    if (state.goalsWrapped) return { ok: true };
    if (state.inert) return { ok: false, reason: "inert" };
    if (!exportHas(exports, "getCurrentGoals", "function")) return { ok: false, reason: "pending" };
    if (!exportHas(exports, "redeemGoal", "function")) return drift("dailyGoalsState.redeemGoal");
    if (!exportHas(exports, "claimMonthlyMilestone", "function")) {
      return drift("dailyGoalsState.claimMonthlyMilestone");
    }
    const result = wraps.wrapRedeem(exports, { state, redeemLog, onError: logErrorFn });
    if (!result.ok && result.reason !== "already-wrapped") return drift("dailyGoalsState.redeemGoal");
    state.goalsWrapped = true;
    logFn("wrapped dailyGoalsState.redeemGoal/claimMonthlyMilestone (redeem 404 log)");
    return { ok: true };
  }

  return { state, stats, redeemLog, applyStore, applyGoals };
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
    const result = kind === "store" ? runtime.applyStore(exports) : runtime.applyGoals(exports);
    if (result.ok) pending.delete(kind);
  }

  function kindOf(filename) {
    if (!identities.has(filename)) identities.set(filename, targets.get(canonicalize(filename)) || null);
    return identities.get(filename);
  }

  for (const filename of Object.keys(Module._cache)) {
    const kind = kindOf(filename);
    if (kind && Module._cache[filename]) apply(kind, Module._cache[filename].exports);
  }

  const previousLoad = Module._load;
  function hookedLoad(request, parent, isMain) {
    const exports = previousLoad.apply(this, arguments);
    if (pending.size === 0 || runtime.state.inert) return exports;
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
  const logFn = options.logFn || log;
  const logErrorFn = options.logErrorFn || logError;
  const config = require("./config").load(MOD_DIR, environment);
  if (config.problems.length > 0) {
    for (const problem of config.problems) logErrorFn(problem);
    logErrorFn("invalid configuration - no hooks installed, vanilla daily goals");
    return { active: false, reason: "invalid-config", config };
  }
  if (!config.enabled) {
    logFn("disabled - vanilla daily goals (state not persisted by EveJS)");
    return { active: false, reason: "disabled", config };
  }

  const viable = require("./lib/viability").inspect(runtimeRoot);
  if (!viable.ok) {
    for (const report of viable.reports.filter((entry) => !entry.ok)) {
      logErrorFn(`DRIFT ${report.key}: ${report.reason}`);
    }
    logErrorFn("viability gate failed - mod inert, no hooks installed, vanilla daily goals");
    return { active: false, reason: "not-viable", config, viable };
  }

  const runtime = createRuntime({ config, logFn, logErrorFn });
  const hookState = installModuleHook(runtime, runtimeRoot, logErrorFn);
  const api = Object.freeze({
    version: MOD_VERSION,
    config,
    stats: () => ({
      ...runtime.stats,
      redeemLog: runtime.redeemLog.stats(),
      inert: runtime.state.inert,
      storeWrapped: runtime.state.storeWrapped,
      goalsWrapped: runtime.state.goalsWrapped,
    }),
  });
  globalThis[Symbol.for(API_SYMBOL)] = api;
  const installState = Object.freeze({ active: true, api, config, viable, runtimeRoot, runtime, hookState });
  globalThis[INSTALL_FLAG] = installState;
  logFn(
    `v${MOD_VERSION} active - dailyGoals root writes forced to disk, redeem 404 log ` +
      (config.redeemLog ? `on (1 line/key per ${config.logIntervalMs} ms, max ${config.logMaxPerInterval})` : "off"),
  );
  return installState;
}

let installResult = null;
if (!process.env[NO_INSTALL_ENV]) {
  try {
    installResult = install();
  } catch (error) {
    logError("loader failed before activation - vanilla daily goals", error);
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
  install,
  installResult,
  _testing: Object.freeze({ canonicalize, createRuntime, exportHas, installModuleHook }),
};
