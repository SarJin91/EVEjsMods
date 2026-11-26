"use strict";

const Module = require("module");
const { isMainThread } = require("worker_threads");

const MOD_VERSION = "1.0.0";
const LOG_PREFIX = "[scenePerfFix]";
const INSTALL_FLAG = "__scenePerfFixLoaderInstalled";
const NO_INSTALL_ENV = "SCENEPERF_NO_INSTALL";

const TARGETS = Object.freeze({
  engine: "/space/runtime/destinyMovementEngine.js",
  registry: "/services/inventory/itemTypeRegistry.js",
});

function log(message) {
  console.log(`${LOG_PREFIX} ${message}`);
}

function exportHas(value, property, type) {
  return value !== null && typeof value === "object" &&
    Object.prototype.hasOwnProperty.call(value, property) &&
    typeof value[property] === type;
}

function targetOf(filename) {
  const normalized = String(filename || "").replace(/\\/g, "/");
  if (!normalized.includes("/server/src/")) return null;
  for (const [key, suffix] of Object.entries(TARGETS)) {
    if (normalized.endsWith(suffix)) return key;
  }
  return null;
}

function isGameModuleFile(filename) {
  return String(filename || "").replace(/\\/g, "/").includes("/server/src/space/");
}

function createState(config) {
  return {
    config,
    gameSeen: false,
    patched: { engine: false, registry: false },
    obsolete: { engine: false },
    drift: [],
    wreckStats: { ticks: 0, skipped: 0, maxSkippedPerTick: 0, errors: 0, lastError: null },
    nameStats: { hits: 0, misses: 0, clears: 0 },
  };
}

function isEngineWithoutPerEntityAdvance(exportsObject) {
  if (exportsObject === null || typeof exportsObject !== "object") return false;
  const hasOtherFunction = Object.keys(exportsObject).some((name) => typeof exportsObject[name] === "function");
  return hasOtherFunction &&
    !Object.prototype.hasOwnProperty.call(exportsObject, "advanceEntityForActiveSceneTick") &&
    !Object.prototype.hasOwnProperty.call(exportsObject, "markEntityMovementAdvancedForActiveTick");
}

function patchExports(key, exportsObject, state) {
  const { createAdvanceWrapper } = require("./lib/inertWrecks");
  const { createCachedResolver } = require("./lib/itemNameCache");
  if (key === "engine") {
    if (!state.config.skipInertWrecks) return true;
    if (state.obsolete.engine) return true;
    if (isEngineWithoutPerEntityAdvance(exportsObject)) {
      state.obsolete.engine = true;
      log(
        "inert wrecks: not needed — this EveJS version has no advanceEntityForActiveSceneTick " +
          "(Destiny Evolve computes movement once per tick for the whole scene), this part of the mod is inactive",
      );
      return true;
    }
    if (!exportHas(exportsObject, "advanceEntityForActiveSceneTick", "function")) return false;
    if (exportsObject.advanceEntityForActiveSceneTick.__scenePerfFix) return true;
    if (!exportHas(exportsObject, "markEntityMovementAdvancedForActiveTick", "function")) {
      state.drift.push("destinyMovementEngine.markEntityMovementAdvancedForActiveTick");
      return true;
    }
    const wrapped = createAdvanceWrapper(
      exportsObject.advanceEntityForActiveSceneTick,
      exportsObject.markEntityMovementAdvancedForActiveTick,
      state.config,
      state.wreckStats,
    );
    wrapped.__scenePerfFix = true;
    exportsObject.advanceEntityForActiveSceneTick = wrapped;
    state.patched.engine = true;
    log("inert wrecks: skipped in the movement tick");
    return true;
  }
  if (key === "registry") {
    if (!state.config.cacheItemNameLookups) return true;
    if (!exportHas(exportsObject, "resolveItemByName", "function")) return false;
    if (exportsObject.resolveItemByName.__scenePerfFix) return true;
    const wrapped = createCachedResolver(exportsObject.resolveItemByName, state.config, state.nameStats);
    wrapped.__scenePerfFix = true;
    exportsObject.resolveItemByName = wrapped;
    state.patched.registry = true;
    log("type lookup by name cache: enabled");
    return true;
  }
  return true;
}

function installHook(state) {
  const previousLoad = Module._load;
  const resolved = new Map();
  Module._load = function scenePerfFixLoad(request, parent, isMain) {
    const result = previousLoad.apply(this, arguments);
    try {
      if (!state.gameSeen && parent && isGameModuleFile(parent.filename)) state.gameSeen = true;
      if ((state.patched.engine || state.obsolete.engine) && state.patched.registry) return result;
      if (typeof request !== "string" || Module.isBuiltin(request)) return result;
      if (!/destinyMovementEngine|itemTypeRegistry/.test(request)) return result;
      let filename = resolved.get(request + "\u0000" + (parent && parent.filename));
      if (filename === undefined) {
        try {
          filename = Module._resolveFilename(request, parent, isMain);
        } catch (_error) {
          filename = null;
        }
        resolved.set(request + "\u0000" + (parent && parent.filename), filename);
      }
      const key = targetOf(filename);
      if (key) state.gameSeen = true;
      if (key && !state.patched[key]) patchExports(key, result, state);
    } catch (error) {
      console.error(`${LOG_PREFIX} hook error: ${error && error.stack || error}`);
    }
    return result;
  };
}

function startStatsLog(state) {
  const minutes = state.config.statsLogMinutes;
  if (!minutes) return;
  const timer = setInterval(() => {
    if (!state.gameSeen) return;
    const w = state.wreckStats;
    const n = state.nameStats;
    log(
      `ticks=${w.ticks} wrecksSkipped=${w.skipped} maxPerTick=${w.maxSkippedPerTick} errors=${w.errors}` +
        `${w.lastError ? ` (${w.lastError})` : ""} | names: hits=${n.hits} misses=${n.misses}`,
    );
  }, minutes * 60000);
  if (typeof timer.unref === "function") timer.unref();
}

function probeMessage(state) {
  if (!state.gameSeen) return null;
  const missing = [...state.drift];
  if (state.config.skipInertWrecks && !state.patched.engine && !state.obsolete.engine) missing.push("destinyMovementEngine.advanceEntityForActiveSceneTick");
  if (state.config.cacheItemNameLookups && !state.patched.registry) missing.push("itemTypeRegistry.resolveItemByName");
  if (missing.length > 0) return `DRIFT: not hooked ${missing.join(", ")} — this part of the mod does not work`;
  if (state.obsolete.engine) return "probe: passed (inert wrecks: inactive, not needed in this EveJS version)";
  return "probe: passed";
}

function startDriftProbe(state) {
  const timer = setTimeout(() => {
    const message = probeMessage(state);
    if (message) log(message);
  }, 60000);
  if (typeof timer.unref === "function") timer.unref();
}

function install() {
  if (process.env[NO_INSTALL_ENV] === "1" || !isMainThread || globalThis[INSTALL_FLAG]) return null;
  globalThis[INSTALL_FLAG] = true;
  try {
    const { loadConfig } = require("./config");
    const state = createState(loadConfig());
    installHook(state);
    startStatsLog(state);
    startDriftProbe(state);
    log(`v${MOD_VERSION} loaded (wrecks=${state.config.skipInertWrecks}, names=${state.config.cacheItemNameLookups})`);
    return state;
  } catch (error) {
    console.error(`${LOG_PREFIX} install failed, mod disabled: ${error && error.stack || error}`);
    return null;
  }
}

const installedState = install();

module.exports = { MOD_VERSION, TARGETS, targetOf, isGameModuleFile, isEngineWithoutPerEntityAdvance, createState, patchExports, installHook, probeMessage, installedState };
