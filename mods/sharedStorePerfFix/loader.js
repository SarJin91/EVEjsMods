"use strict";

const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const { isMainThread } = require("node:worker_threads");
const { createMirrorSkip } = require("./lib/mirrorSkip");

const MOD_VERSION = "1.2.0";
const MOD_DIR = __dirname;
const RUNTIME_ROOT = path.resolve(MOD_DIR, "../..");
const LOG_PREFIX = "[sharedStorePerfFix]";
const INSTALL_FLAG = "__sharedStorePerfFixLoaderInstalled";
const API_SYMBOL = "evejs.sharedStorePerfFix";
const NO_INSTALL_ENV = "EVEJS_SSPF_NO_INSTALL";
const ROLE_ENV = "EVEJS_GAMESTORE_OWNER_ROLE";
const WRAPPED = Symbol.for("evejs.sharedStorePerfFix.wrapped");
// The scheduler and wallet owners run no game loop, so a longer lock wait cannot stall the simulation.
const OFF_LOOP_OWNER_ROLES = Object.freeze(["scheduler", "wallet"]);

const TARGET = "server/src/gameStore/sqliteStore.js";
const MIRROR_TARGET = "server/src/services/structure/structureState.js";
const VENDOR_FILES = Object.freeze({
  structureSchema: "server/src/gameStore/shared-schema/structureSchema.js",
  version: "server/src/gameStore/shared-schema/version.js",
  packageJson: "server/package.json",
});

const COUNTERS = Object.freeze({
  PINNED: "pinned",
  ALREADY_PINNED: "alreadyPinned",
  VENDOR_FIXED: "vendorFixed",
  DRIFT: "drift",
  BUSY: "busy",
  PLAN_NOT_FIXED: "planNotFixed",
  READ_ONLY: "readOnly",
  NOT_SHARED: "notShared",
  DISABLED: "disabled",
});

function log(message) {
  console.log(`${LOG_PREFIX} ${message}`);
}

function logWarn(message) {
  console.warn(`${LOG_PREFIX} ${message}`);
}

function logError(message, error = null) {
  console.error(`${LOG_PREFIX} ${message}`);
  if (error && error.stack) console.error(error.stack);
}

function canonicalize(filename) {
  const resolved = path.resolve(String(filename || ""));
  let canonical;
  try {
    canonical = (fs.realpathSync.native || fs.realpathSync)(resolved);
  } catch (_error) {
    canonical = resolved;
  }
  if (process.platform === "win32") return path.win32.normalize(canonical.replace(/\//gu, "\\")).toLowerCase();
  return path.posix.normalize(canonical.replace(/\\/gu, "/"));
}

function vendorPath(runtimeRoot, relative) {
  return path.resolve(runtimeRoot, ...relative.split("/"));
}

function readVendorVersion(runtimeRoot) {
  try {
    const parsed = JSON.parse(fs.readFileSync(vendorPath(runtimeRoot, VENDOR_FILES.packageJson), "utf8"));
    return typeof parsed.version === "string" ? parsed.version : "unknown";
  } catch (_error) {
    return "unknown";
  }
}

function loadVendorFacts(runtimeRoot) {
  const version = require(vendorPath(runtimeRoot, VENDOR_FILES.version));
  const schema = require(vendorPath(runtimeRoot, VENDOR_FILES.structureSchema));
  if (!Number.isSafeInteger(version.APPLICATION_ID)) return { ok: false, detail: "version.APPLICATION_ID" };
  if (typeof schema.structuresSchema !== "function") return { ok: false, detail: "structureSchema.structuresSchema" };
  return {
    ok: true,
    applicationId: version.APPLICATION_ID,
    vendorSchemaSql: () => schema.structuresSchema(),
    vendorVersion: readVendorVersion(runtimeRoot),
  };
}

function describe(result, vendorVersion) {
  const parts = [`v${MOD_VERSION}`, result.reason];
  if (result.table) parts.push(result.table);
  if (result.indexName) parts.push(`index=${result.indexName}`);
  if (result.pinRows) parts.push(`rows=${result.pinRows}`);
  parts.push(`vendor=${vendorVersion}`);
  if (result.probe) {
    const good = result.probe.total - result.probe.bad;
    parts.push(`probe=${good}/${result.probe.total} good`);
  }
  if (result.removed !== undefined) parts.push(`removed=${result.removed}`);
  if (result.detail) parts.push(`(${result.detail})`);
  parts.push(`${result.ms}ms`);
  return parts.join(" ");
}

function lockWaitMs(config, role) {
  const base = config.busyTimeoutMs > 0 ? config.busyTimeoutMs : 0;
  const owner = OFF_LOOP_OWNER_ROLES.includes(role) && config.ownerBusyTimeoutMs > 0 ? config.ownerBusyTimeoutMs : 0;
  return Math.max(base, owner);
}

function createRuntime({
  runtimeRoot = RUNTIME_ROOT,
  config,
  logFn = log,
  warnFn = logWarn,
  logErrorFn = logError,
  vendorFacts = null,
  applyPin = null,
  roleFn = () => String(process.env[ROLE_ENV] || "").trim(),
  mainThread = isMainThread,
} = {}) {
  const stats = { inits: 0, errors: 0, lockWaitMs: 0 };
  for (const name of Object.values(COUNTERS)) stats[name] = 0;
  const state = { inert: false, wrapped: false, facts: vendorFacts, logged: new Set(), settled: new WeakMap(), cache: {} };
  const pin = applyPin || require("./lib/plannerPin").applyPlannerPin;

  function applyLockWait(db, role) {
    const waitMs = lockWaitMs(config, role);
    if (waitMs <= 0) return;
    db.pragma(`busy_timeout = ${waitMs}`);
    if (stats.lockWaitMs !== waitMs && mainThread && waitMs !== config.busyTimeoutMs) {
      logFn(`v${MOD_VERSION} lock wait ${waitMs}ms for the ${role} owner connections`);
    }
    stats.lockWaitMs = waitMs;
  }

  function drift(detail) {
    state.inert = true;
    stats.drift += 1;
    logErrorFn(`DRIFT ${detail} - mod inert, structures writes stay as vanilla`);
  }

  function facts() {
    if (!state.facts) {
      try {
        state.facts = loadVendorFacts(runtimeRoot);
      } catch (error) {
        state.facts = { ok: false, detail: `vendor schema modules (${String(error && error.message)})` };
      }
    }
    return state.facts;
  }

  function report(result) {
    const counter = COUNTERS[result.reason];
    if (counter) stats[counter] += 1;
    if (result.reason === "ALREADY_PINNED") return;
    const line = describe(result, state.facts ? state.facts.vendorVersion : "unknown");
    if (result.reason === "BUSY") {
      warnFn(`${line} - will retry on the next store open`);
      return;
    }
    if (state.logged.has(result.reason)) return;
    state.logged.add(result.reason);
    if (result.reason === "PLAN_NOT_FIXED") logErrorFn(`${line} - structures writes stay quadratic`);
    else if (result.reason === "DRIFT") logErrorFn(`${line} - structures writes stay as vanilla`);
    else logFn(line);
  }

  function afterInit(db, options) {
    stats.inits += 1;
    if (state.inert || !db || typeof db.prepare !== "function" || typeof db.pragma !== "function") return;
    const readOnly = Boolean(options && options.readOnly === true);
    if (!readOnly) applyLockWait(db, roleFn());
    if (state.settled.has(db)) return;
    const vendor = facts();
    if (!vendor.ok) {
      drift(vendor.detail);
      return;
    }
    const result = pin(db, {
      enabled: config.enabled,
      readOnly,
      pinRows: config.pinRows,
      applicationId: vendor.applicationId,
      vendorSchemaSql: vendor.vendorSchemaSql,
      cache: state.cache,
    });
    report(result);
    if (result.reason !== "BUSY") state.settled.set(db, result.reason);
  }

  function wrapInit(exports) {
    if (state.wrapped) return { ok: true };
    if (state.inert) return { ok: false, reason: "inert" };
    if (!exports || (typeof exports !== "object" && typeof exports !== "function")) return { ok: false, reason: "pending" };
    if (typeof exports.init !== "function") {
      if (Object.keys(exports).length === 0) return { ok: false, reason: "pending" };
      drift("sqliteStore.init");
      return { ok: false, reason: "drift" };
    }
    const previous = exports.init;
    if (previous[WRAPPED]) {
      state.wrapped = true;
      return { ok: true };
    }
    const wrapped = function init() {
      const db = previous.apply(this, arguments);
      try {
        afterInit(db, arguments[1]);
      } catch (error) {
        stats.errors += 1;
        if (stats.errors === 1) logErrorFn("planner pin failed - structures writes stay as vanilla", error);
      }
      return db;
    };
    Object.defineProperty(wrapped, WRAPPED, { value: true });
    exports.init = wrapped;
    state.wrapped = true;
    return { ok: true };
  }

  return { state, stats, afterInit, wrapInit };
}

function installModuleHook(runtime, runtimeRoot, logErrorFn = logError, mirror = null) {
  const targets = [{ file: canonicalize(vendorPath(runtimeRoot, TARGET)), owner: runtime, wrap: runtime.wrapInit }];
  if (mirror) targets.push({ file: canonicalize(vendorPath(runtimeRoot, MIRROR_TARGET)), owner: mirror, wrap: mirror.wrapExports });
  const identities = new Map();
  const targetOf = (filename) => {
    if (!identities.has(filename)) {
      const canonical = canonicalize(filename);
      identities.set(filename, targets.find((target) => target.file === canonical) || null);
    }
    return identities.get(filename);
  };
  const settled = (target) => target.owner.state.wrapped || target.owner.state.inert;

  for (const filename of Object.keys(Module._cache)) {
    const target = targetOf(filename);
    if (target && Module._cache[filename]) target.wrap(Module._cache[filename].exports);
  }

  const previousLoad = Module._load;
  function hookedLoad(request, parent, isMain) {
    const exports = previousLoad.apply(this, arguments);
    if (targets.every(settled)) return exports;
    try {
      if (typeof request !== "string" || Module.isBuiltin(request)) return exports;
      const target = targetOf(Module._resolveFilename(request, parent, isMain));
      if (target && !settled(target)) target.wrap(exports);
    } catch (error) {
      logErrorFn(`hook error on ${String(request)} - ignored`, error);
    }
    return exports;
  }
  Module._load = hookedLoad;
  return { hookedLoad, previousLoad };
}

function install(options = {}) {
  if (globalThis[INSTALL_FLAG]) return { active: false, reason: "already-installed" };
  const runtimeRoot = path.resolve(options.runtimeRoot || RUNTIME_ROOT);
  const environment = options.environment || process.env;
  const logFn = options.logFn || log;
  const logErrorFn = options.logErrorFn || logError;
  const config = require("./config").load(options.modDir || MOD_DIR, environment, options.configOptions || {});
  if (config.problems.length > 0) {
    for (const problem of config.problems) logErrorFn(problem);
    logErrorFn("invalid configuration - no hooks installed, structures writes stay as vanilla");
    return { active: false, reason: "invalid-config", config };
  }
  if (!config.enabled) return { active: false, reason: "disabled", config };

  const runtime = createRuntime({
    runtimeRoot,
    config,
    logFn,
    warnFn: options.warnFn || logWarn,
    logErrorFn,
    vendorFacts: options.vendorFacts || null,
  });
  const mirror = config.mirrorSkip
    ? createMirrorSkip({ logErrorFn, publish: options.publishMirrorStats !== false })
    : null;
  const hookState = installModuleHook(runtime, runtimeRoot, logErrorFn, mirror);
  const api = Object.freeze({
    version: MOD_VERSION,
    config,
    stats: () => ({
      ...runtime.stats,
      inert: runtime.state.inert,
      wrapped: runtime.state.wrapped,
      mirror: mirror ? { ...mirror.stats, inert: mirror.state.inert, wrapped: mirror.state.wrapped } : null,
    }),
  });
  globalThis[Symbol.for(API_SYMBOL)] = api;
  if (isMainThread && options.quiet !== true) {
    const mirrorPart = mirror ? " and skips sovereignty mirror writes that change nothing" : "";
    logFn(`v${MOD_VERSION} active - pins the structures planner statistic after each game store open${mirrorPart}`);
  }
  const installState = Object.freeze({ active: true, api, config, runtimeRoot, runtime, mirror, hookState });
  globalThis[INSTALL_FLAG] = installState;
  return installState;
}

let installResult = null;
if (!process.env[NO_INSTALL_ENV]) {
  try {
    installResult = install();
  } catch (error) {
    logError("loader failed before activation - structures writes stay as vanilla", error);
    installResult = { active: false, reason: "exception", error };
  }
}

module.exports = {
  API_SYMBOL,
  INSTALL_FLAG,
  MIRROR_TARGET,
  MOD_DIR,
  MOD_VERSION,
  NO_INSTALL_ENV,
  OFF_LOOP_OWNER_ROLES,
  ROLE_ENV,
  RUNTIME_ROOT,
  TARGET,
  WRAPPED,
  install,
  installResult,
  _testing: Object.freeze({ canonicalize, createRuntime, describe, installModuleHook, loadVendorFacts, lockWaitMs }),
};
