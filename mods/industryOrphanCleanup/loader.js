"use strict";

const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const { isMainThread } = require("node:worker_threads");

const MOD_VERSION = "1.0.0";
const MOD_DIR = __dirname;
const RUNTIME_ROOT = path.resolve(MOD_DIR, "../..");
const LOG_PREFIX = "[industryOrphanCleanup]";
const INSTALL_FLAG = "__industryOrphanCleanupLoaderInstalled";
const API_SYMBOL = "evejs.industryOrphanCleanup";
const NO_INSTALL_ENV = "EVEJS_INDUSTRY_ORPHAN_CLEANUP_NO_INSTALL";

const TARGETS = Object.freeze({
  deletion: "server/src/services/character/characterDeletionRuntime.js",
  industry: "server/src/services/industry/industryRuntimeState.js",
  items: "server/src/services/inventory/itemStore.js",
  store: "server/src/gameStore/index.js",
});

const REFERENCE_METHODS = Object.freeze({
  industry: Object.freeze(["getBlueprintState", "removeBlueprintState"]),
  items: Object.freeze(["findItemById"]),
  store: Object.freeze(["read"]),
});

const DELETION_PROBE = "prepareCharacterForDelete";

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

function createRuntime({ config, logFn = log, logErrorFn = logError }) {
  const wraps = require("./lib/wraps");
  const state = { inert: false, wrapped: false };
  const stats = { deletes: 0, cleanups: 0, removed: 0, skipped: 0, skippedDeps: 0, errors: 0 };
  const deps = { industry: null, items: null, store: null };

  function drift(symbol) {
    state.inert = true;
    logErrorFn(`DRIFT ${symbol} - mod inert, vanilla character deletion`);
    return { ok: false, reason: "drift" };
  }

  function applyDeletion(exports) {
    if (state.wrapped) return { ok: true };
    if (state.inert) return { ok: false, reason: "inert" };
    if (!exportHas(exports, DELETION_PROBE, "function")) return { ok: false, reason: "pending" };
    if (!exportHas(exports, "deleteCharacter", "function")) return drift("characterDeletionRuntime.deleteCharacter");
    const result = wraps.wrapDeleteCharacter(exports, { state, stats, deps, config, logFn, onError: logErrorFn });
    if (!result.ok && result.reason !== "already-wrapped") return drift("characterDeletionRuntime.deleteCharacter");
    state.wrapped = true;
    logFn("wrapped characterDeletionRuntime.deleteCharacter (orphan blueprint state cleanup)");
    return { ok: true };
  }

  function applyReference(kind, exports) {
    if (deps[kind]) return { ok: true };
    if (!REFERENCE_METHODS[kind].every((method) => exportHas(exports, method, "function"))) {
      return { ok: false, reason: "pending" };
    }
    deps[kind] = exports;
    return { ok: true };
  }

  function apply(kind, exports) {
    return kind === "deletion" ? applyDeletion(exports) : applyReference(kind, exports);
  }

  return { state, stats, deps, apply, applyDeletion, applyReference };
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
    if (runtime.apply(kind, exports).ok) pending.delete(kind);
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
    logErrorFn("invalid configuration - no hooks installed, vanilla character deletion");
    return { active: false, reason: "invalid-config", config };
  }
  if (!config.enabled) {
    logFn("disabled - vanilla character deletion (blueprint state of deleted characters kept)");
    return { active: false, reason: "disabled", config };
  }

  const viable = require("./lib/viability").inspect(runtimeRoot);
  if (!viable.ok) {
    for (const report of viable.reports.filter((entry) => !entry.ok)) {
      logErrorFn(`DRIFT ${report.key}: ${report.reason}`);
    }
    logErrorFn("viability gate failed - mod inert, no hooks installed, vanilla character deletion");
    return { active: false, reason: "not-viable", config, viable };
  }

  const runtime = createRuntime({ config, logFn, logErrorFn });
  const hookState = installModuleHook(runtime, runtimeRoot, logErrorFn);
  const api = Object.freeze({
    version: MOD_VERSION,
    config,
    stats: () => ({ inert: runtime.state.inert, wrapped: runtime.state.wrapped, ...runtime.stats }),
  });
  globalThis[Symbol.for(API_SYMBOL)] = api;
  const installState = Object.freeze({ active: true, api, config, viable, runtimeRoot, runtime, hookState });
  globalThis[INSTALL_FLAG] = installState;
  logFn(`v${MOD_VERSION} active - orphan blueprint state removed after character deletion, log ${config.log ? "on" : "off"}`);
  return installState;
}

let installResult = null;
if (!process.env[NO_INSTALL_ENV]) {
  try {
    installResult = install();
  } catch (error) {
    logError("loader failed before activation - vanilla character deletion", error);
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
