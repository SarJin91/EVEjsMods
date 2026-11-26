"use strict";

const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const { isMainThread } = require("node:worker_threads");

const MOD_VERSION = "1.0.0";
const MOD_DIR = __dirname;
const RUNTIME_ROOT = path.resolve(MOD_DIR, "../..");
const LOG_PREFIX = "[skyhookOrphanFix]";
const INSTALL_FLAG = "__skyhookOrphanFixLoaderInstalled";
const API_SYMBOL = "evejs.skyhookOrphanFix";
const NO_INSTALL_ENV = "EVEJS_SKYHOOKFIX_NO_INSTALL";
const WRAPPED = Symbol.for("evejs.skyhookOrphanFix.wrapped");

const TARGETS = Object.freeze({
  world: "server/src/space/worldData.js",
  sov: "server/src/services/sovereignty/sovStaticData.js",
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

function createRuntime({ runtimeRoot = RUNTIME_ROOT, inspect = null, logFn = log, logErrorFn = logError } = {}) {
  const patch = require("./lib/patch");
  const state = { inert: false, wrapped: false, probed: false, worldData: null };
  const stats = { snapshotsPatched: 0, patchFailures: 0 };
  const probe = inspect || (() => require("./lib/viability").inspect(runtimeRoot));
  const emptyDefinitionFor = patch.createEmptyDefinitionResolver((id) => state.worldData.getCelestialByID(id));

  function drift(symbol) {
    state.inert = true;
    logErrorFn(`DRIFT ${symbol} - mod inert, vanilla skyhooks (404 outside sov null-sec)`);
    return { ok: false, reason: "drift" };
  }

  function applyWorld(exports) {
    if (exports && (typeof exports === "object" || typeof exports === "function")) state.worldData = exports;
    return { ok: true };
  }

  function patchReturned(snapshot) {
    try {
      const result = patch.patchSnapshot(snapshot, emptyDefinitionFor, logErrorFn);
      if (result.ok && result.reason !== "already-patched") {
        stats.snapshotsPatched += 1;
        if (stats.snapshotsPatched === 1) logFn("sov static snapshot patched (empty definition for non-sov planets)");
      } else if (!result.ok) {
        stats.patchFailures += 1;
        if (stats.patchFailures === 1) logErrorFn(`snapshot not patched (${result.reason}) - vanilla skyhooks`);
      }
    } catch (error) {
      stats.patchFailures += 1;
      if (stats.patchFailures === 1) logErrorFn("snapshot patch failed - vanilla skyhooks", error);
    }
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
    if (!exportHas(state.worldData, "getCelestialByID", "function")) return drift("worldData.getCelestialByID");

    const previous = exports.getSovereigntyStaticSnapshot;
    if (previous[WRAPPED]) {
      state.wrapped = true;
      return { ok: true };
    }
    const wrapped = function getSovereigntyStaticSnapshot() {
      const snapshot = previous.apply(this, arguments);
      if (!state.inert) patchReturned(snapshot);
      return snapshot;
    };
    Object.defineProperty(wrapped, WRAPPED, { value: true });
    exports.getSovereigntyStaticSnapshot = wrapped;
    state.wrapped = true;
    logFn(`v${MOD_VERSION} active - wrapped sovStaticData.getSovereigntyStaticSnapshot (probe ok)`);
    return { ok: true };
  }

  return { state, stats, emptyDefinitionFor, applyWorld, applySov };
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
    const result = kind === "world" ? runtime.applyWorld(exports) : runtime.applySov(exports);
    if (result.ok) pending.delete(kind);
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
    logErrorFn("invalid configuration - no hooks installed, vanilla skyhooks");
    return { active: false, reason: "invalid-config", config };
  }
  if (!config.enabled) return { active: false, reason: "disabled", config };

  const runtime = createRuntime({ runtimeRoot, logFn, logErrorFn });
  const hookState = installModuleHook(runtime, runtimeRoot, logErrorFn);
  const api = Object.freeze({
    version: MOD_VERSION,
    config,
    stats: () => ({ ...runtime.stats, inert: runtime.state.inert, wrapped: runtime.state.wrapped }),
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
