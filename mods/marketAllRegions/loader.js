"use strict";

const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const { AsyncLocalStorage } = require("node:async_hooks");
const { isMainThread } = require("node:worker_threads");

const MOD_VERSION = "1.0.0";
const MOD_DIR = __dirname;
const RUNTIME_ROOT = path.resolve(MOD_DIR, "../..");
const LOG_PREFIX = "[marketAllRegions]";
const INSTALL_FLAG = "__marketAllRegionsLoaderInstalled";
const API_SYMBOL = "evejs.marketAllRegions";
const NO_INSTALL_ENV = "EVEJS_MARKET_ALL_REGIONS_NO_INSTALL";

const TARGETS = Object.freeze({
  proxy: "server/src/services/market/marketProxyService.js",
  daemon: "server/src/services/market/marketDaemonClient.js",
});
const WORLD_DATA = "server/src/space/worldData";

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

function createRuntime({ config, listRegionIDs, now = Date.now, logFn = log, logErrorFn = logError }) {
  const { createAllRegionsReader } = require("./lib/allRegions");
  const wraps = require("./lib/wraps");
  const als = new AsyncLocalStorage();
  const state = { inert: false, proxyWrapped: false, daemonWrapped: false };
  const reader = createAllRegionsReader({
    config,
    listRegionIDs,
    now,
    log: logFn,
    logError: logErrorFn,
  });

  function drift(symbol) {
    state.inert = true;
    logErrorFn(`DRIFT ${symbol} - mod inert, vanilla market`);
    return { ok: false, reason: "drift" };
  }

  function applyDaemon(exports) {
    if (state.daemonWrapped) return { ok: true };
    if (state.inert) return { ok: false, reason: "inert" };
    if (!exportHas(exports, "MarketDaemonClient", "function")) return { ok: false, reason: "pending" };
    const proto = exports.MarketDaemonClient.prototype;
    if (!proto || typeof proto.call !== "function") {
      return drift("services/market/marketDaemonClient.MarketDaemonClient.prototype.call");
    }
    wraps.wrapDaemonCall(proto, { als, state, reader });
    state.daemonWrapped = true;
    logFn("wrapped daemon (MarketDaemonClient.prototype.call)");
    return { ok: true };
  }

  function applyProxy(exports) {
    if (state.proxyWrapped) return { ok: true };
    if (state.inert) return { ok: false, reason: "inert" };
    if (typeof exports !== "function" || !exportHas(exports, "prototype", "object")) {
      return { ok: false, reason: "pending" };
    }
    if (typeof exports.prototype.Handle_GetOrders !== "function") {
      return drift("services/market/marketProxyService.Handle_GetOrders");
    }
    wraps.wrapGetOrders(exports.prototype, { als, state });
    state.proxyWrapped = true;
    logFn("wrapped proxy (MarketProxyService.prototype.Handle_GetOrders)");
    return { ok: true };
  }

  return { als, state, reader, applyDaemon, applyProxy };
}

function createWorldRegionLister(loadWorldData, config) {
  const { computeRegionIDs } = require("./lib/allRegions");
  return function listRegionIDs() {
    const worldData = loadWorldData();
    return computeRegionIDs(worldData.getSolarSystems(), {
      includeWormholeRegions: config.includeWormholeRegions,
    });
  };
}

function applyToExports({ proxyExports, daemonExports, worldData, config, now, logFn, logErrorFn }) {
  if (!config || !config.enabled) return { applied: false, reason: "disabled" };
  const runtime = createRuntime({
    config,
    listRegionIDs: createWorldRegionLister(() => worldData, config),
    now,
    logFn,
    logErrorFn,
  });
  const daemon = runtime.applyDaemon(daemonExports);
  const proxy = runtime.applyProxy(proxyExports);
  return { applied: daemon.ok && proxy.ok, reason: daemon.ok && proxy.ok ? undefined : (daemon.reason || proxy.reason), runtime };
}

function installModuleHook(runtime, runtimeRoot) {
  const targets = new Map(
    Object.entries(TARGETS).map(([kind, relative]) => [
      canonicalize(path.resolve(runtimeRoot, ...relative.split("/"))),
      kind,
    ]),
  );
  const pending = new Set(Object.keys(TARGETS));
  const identities = new Map();

  function apply(kind, exports) {
    const result = kind === "proxy" ? runtime.applyProxy(exports) : runtime.applyDaemon(exports);
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
      logError(`hook error on ${String(request)} - ignored`, error);
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
  const config = require("./config").load(MOD_DIR, environment);
  if (config.problems.length > 0) {
    for (const problem of config.problems) logError(problem);
    logError("invalid configuration - no hooks installed, vanilla market");
    return { active: false, reason: "invalid-config", config };
  }
  if (!config.enabled) {
    log("disabled - vanilla market (session region only)");
    return { active: false, reason: "disabled", config };
  }

  const viable = require("./lib/viability").inspect(runtimeRoot);
  if (!viable.ok) {
    logError("viability gate failed - no hooks installed, vanilla market");
    for (const report of viable.reports.filter((entry) => !entry.ok)) {
      logError(`${report.key}: ${report.reason}`);
    }
    return { active: false, reason: "not-viable", config, viable };
  }

  const worldDataPath = path.join(runtimeRoot, ...WORLD_DATA.split("/"));
  const runtime = createRuntime({
    config,
    listRegionIDs: createWorldRegionLister(() => require(worldDataPath), config),
  });
  const hookState = installModuleHook(runtime, runtimeRoot);
  const api = Object.freeze({
    version: MOD_VERSION,
    config,
    stats: () => ({
      ...runtime.reader.stats(),
      inert: runtime.state.inert,
      proxyWrapped: runtime.state.proxyWrapped,
      daemonWrapped: runtime.state.daemonWrapped,
    }),
  });
  globalThis[Symbol.for(API_SYMBOL)] = api;
  const installState = Object.freeze({ active: true, api, config, viable, runtimeRoot, runtime, hookState });
  globalThis[INSTALL_FLAG] = installState;
  log(
    `v${MOD_VERSION} active - foreign rows/side ${config.maxForeignRowsPerSide}, ` +
      `cache ${config.cacheTtlMs} ms, regions computed lazily`,
  );
  return installState;
}

let installResult = null;
if (!process.env[NO_INSTALL_ENV]) {
  try {
    installResult = install();
  } catch (error) {
    logError("loader failed before activation - vanilla market", error);
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
  install,
  installResult,
  _testing: Object.freeze({ applyToExports, createRuntime, exportHas, installModuleHook }),
};
