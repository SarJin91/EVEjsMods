"use strict";

const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const { isMainThread } = require("node:worker_threads");

const MOD_VERSION = "1.0.0";
const MOD_DIR = __dirname;
const RUNTIME_ROOT = path.resolve(MOD_DIR, "../..");
const LOG_PREFIX = "[missionStructureRestore]";
const INSTALL_FLAG = "__missionStructureRestoreLoaderInstalled";
const API_SYMBOL = "evejs.missionStructureRestore";
const NO_INSTALL_ENV = "EVEJS_MISSION_STRUCTURE_RESTORE_NO_INSTALL";

const TARGETS = Object.freeze({
  service: "server/src/services/dungeon/dungeonUniverseSiteService.js",
});

const TESTING_FUNCTIONS = Object.freeze([
  "resolvePopulationHints",
  "resolveEncounterPlans",
  "buildSpawnedIdentityMap",
  "applyNpcSentryEncounterProgressPolicy",
]);

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

function missingServiceMember(exports) {
  if (!exportHas(exports, "ensureSiteContentsMaterialized", "function")) return "ensureSiteContentsMaterialized";
  if (!exportHas(exports, "buildSiteEntity", "function")) return "buildSiteEntity";
  if (!exportHas(exports, "homefrontPorts", "object")) return "homefrontPorts";
  if (!exportHas(exports.homefrontPorts, "structure", "function")) return "homefrontPorts.structure";
  if (!exportHas(exports.homefrontPorts, "roomAnchor", "function")) return "homefrontPorts.roomAnchor";
  if (!exportHas(exports, "_testing", "object")) return "_testing";
  for (const name of TESTING_FUNCTIONS) {
    if (!exportHas(exports._testing, name, "function")) return `_testing.${name}`;
  }
  return null;
}

function createLazyDeps(serviceExports, serviceFilename) {
  const dir = path.dirname(String(serviceFilename || ""));
  let runtime = null;
  let authority = null;
  return {
    service: serviceExports,
    get dungeonRuntime() {
      if (!runtime) runtime = require(path.join(dir, "dungeonRuntime.js"));
      return runtime;
    },
    get dungeonAuthority() {
      if (!authority) authority = require(path.join(dir, "dungeonAuthority.js"));
      return authority;
    },
  };
}

function emptySkipped() {
  const { SKIP_REASONS } = require("./lib/restorePlan");
  return Object.fromEntries(SKIP_REASONS.map((reason) => [reason, 0]));
}

function createRuntime({ config, now = Date.now, logFn = log, logErrorFn = logError, depsFor = createLazyDeps }) {
  const wraps = require("./lib/wraps");
  const { restoreAfterMaterialize } = require("./lib/restore");
  const state = { inert: false, wrapped: false };
  const stats = { calls: 0, applicable: 0, restored: 0, skipped: emptySkipped(), patchFailed: 0, errors: 0 };

  function drift(symbol) {
    state.inert = true;
    logErrorFn(`DRIFT ${symbol} - mod inert, vanilla mission structures`);
    return { ok: false, reason: "drift" };
  }

  function record(outcome) {
    if (!outcome || outcome.reason === "NOT_APPLICABLE") return;
    stats.applicable += 1;
    if (!outcome.ok && Object.prototype.hasOwnProperty.call(stats.skipped, outcome.reason)) {
      stats.skipped[outcome.reason] += 1;
    }
    for (const [reason, count] of Object.entries(outcome.skipped || {})) {
      if (Object.prototype.hasOwnProperty.call(stats.skipped, reason)) stats.skipped[reason] += count;
    }
    stats.restored += Math.max(0, Number(outcome.restored) || 0);
    if (outcome.reason === "PATCH_FAILED") stats.patchFailed += Math.max(1, Number(outcome.patchFailed) || 0);
  }

  function applyService(exports, filename) {
    if (state.wrapped) return { ok: true };
    if (state.inert) return { ok: false, reason: "inert" };
    if (typeof exports !== "function") return { ok: false, reason: "pending" };
    const missing = missingServiceMember(exports);
    if (missing) return drift(`DungeonUniverseSiteService.${missing}`);
    const deps = depsFor(exports, filename);
    deps.nowMs = deps.nowMs || now;
    deps.log = config.log ? logFn : () => {};
    deps.logError = logErrorFn;
    const result = wraps.wrapEnsure(exports, {
      restore: (scene, materialized, options) => {
        if (state.inert) return;
        record(restoreAfterMaterialize(deps, scene, materialized, options));
      },
      stats,
      onError: logErrorFn,
    });
    if (!result.ok && result.reason !== "already-wrapped") return drift("DungeonUniverseSiteService.ensureSiteContentsMaterialized");
    state.wrapped = true;
    logFn("wrapped DungeonUniverseSiteService.ensureSiteContentsMaterialized (mission objective structures restored)");
    return { ok: true };
  }

  return { state, stats, applyService };
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

  function apply(kind, exports, filename) {
    const result = runtime.applyService(exports, filename);
    if (result.ok) pending.delete(kind);
  }

  function kindOf(filename) {
    if (!identities.has(filename)) identities.set(filename, targets.get(canonicalize(filename)) || null);
    return identities.get(filename);
  }

  for (const filename of Object.keys(Module._cache)) {
    const kind = kindOf(filename);
    if (kind && Module._cache[filename]) apply(kind, Module._cache[filename].exports, filename);
  }

  const previousLoad = Module._load;
  function hookedLoad(request, parent, isMain) {
    const exports = previousLoad.apply(this, arguments);
    if (pending.size === 0 || runtime.state.inert) return exports;
    try {
      if (typeof request !== "string" || Module.isBuiltin(request)) return exports;
      const filename = Module._resolveFilename(request, parent, isMain);
      const kind = kindOf(filename);
      if (kind && pending.has(kind)) apply(kind, exports, filename);
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
    logErrorFn("invalid configuration - no hooks installed, vanilla mission structures");
    return { active: false, reason: "invalid-config", config };
  }
  if (!config.enabled) {
    logFn("disabled - vanilla mission structures (not restored after a restart)");
    return { active: false, reason: "disabled", config };
  }

  const viable = require("./lib/viability").inspect(runtimeRoot);
  if (!viable.ok) {
    for (const report of viable.reports.filter((entry) => !entry.ok)) {
      logErrorFn(`DRIFT ${report.key}: ${report.reason}`);
    }
    logErrorFn("viability gate failed - mod inert, no hooks installed, vanilla mission structures");
    return { active: false, reason: "not-viable", config, viable };
  }

  const runtime = createRuntime({ config, logFn, logErrorFn });
  const hookState = installModuleHook(runtime, runtimeRoot, logErrorFn);
  const api = Object.freeze({
    version: MOD_VERSION,
    config,
    stats: () => ({
      ...runtime.stats,
      skipped: { ...runtime.stats.skipped },
      inert: runtime.state.inert,
      wrapped: runtime.state.wrapped,
    }),
  });
  globalThis[Symbol.for(API_SYMBOL)] = api;
  const installState = Object.freeze({ active: true, api, config, viable, runtimeRoot, runtime, hookState });
  globalThis[INSTALL_FLAG] = installState;
  logFn(`v${MOD_VERSION} active - mission objective structures restored after restart, log ${config.log ? "on" : "off"}`);
  return installState;
}

let installResult = null;
if (!process.env[NO_INSTALL_ENV]) {
  try {
    installResult = install();
  } catch (error) {
    logError("loader failed before activation - vanilla mission structures", error);
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
  _testing: Object.freeze({ canonicalize, createLazyDeps, createRuntime, exportHas, installModuleHook, missingServiceMember }),
};
