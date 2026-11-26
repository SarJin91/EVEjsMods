"use strict";

const path = require("node:path");
const fs = require("node:fs");
const { GAME_MODULES } = require("./gameModules");

const STATUS = Object.freeze({ OK: "ok", DRIFT: "DRIFT", MISSING: "MISSING" });
const WORLD_ROLE = "world";
const GAMESTORE_SEARCH_MAX_DEPTH = 6;
const GAMESTORE_ENTRY = path.join("gameStore", "index.js");

function hasOwn(value, property) {
  return value !== null && (typeof value === "object" || typeof value === "function")
    && Object.prototype.hasOwnProperty.call(value, property);
}

function isObjectLike(value) {
  return value !== null && (typeof value === "object" || typeof value === "function");
}

function findServerSrcInCache(cache, startFile, maxDepth = GAMESTORE_SEARCH_MAX_DEPTH) {
  if (!cache || typeof startFile !== "string" || startFile === "") {
    return { ok: false, reason: "gamestore_not_cached" };
  }
  let dir = path.dirname(startFile);
  for (let depth = 0; depth < maxDepth; depth += 1) {
    for (const srcDir of [dir, path.join(dir, "src")]) {
      const key = path.join(srcDir, GAMESTORE_ENTRY);
      if (hasOwn(cache, key)) {
        const entry = cache[key];
        return { ok: true, srcDir, gameStoreExports: entry ? entry.exports : undefined };
      }
    }
    const parentDir = path.dirname(dir);
    if (parentDir === dir) break;
    dir = parentDir;
  }
  return { ok: false, reason: "gamestore_not_cached" };
}

function processRoleFromWorld(world) {
  if (!hasOwn(world, "database") || !isObjectLike(world.database)) return { ok: false, reason: "world_invalid" };
  const database = world.database;
  return { ok: true, processRole: hasOwn(database, "_processRole") ? database._processRole : undefined };
}

function evaluateWorldGate(input) {
  let reason = null;
  if (input.isMainThread !== true) reason = "not_main_thread";
  else if (input.envRole !== WORLD_ROLE) reason = `env_role_not_world:${input.envRole || "unset"}`;
  else if (input.processRole === undefined) reason = "gamestore_role_unknown";
  else if (input.processRole !== WORLD_ROLE) reason = `gamestore_role_not_world:${input.processRole}`;
  return { ok: reason === null, reason };
}

function symbolPresent(exportsObject, symbol) {
  const name = symbol.name;
  switch (symbol.kind) {
    case "export":
      return hasOwn(exportsObject, name) && typeof exportsObject[name] === (symbol.valueType || "function");
    case "prototypeMethod": {
      if (!isObjectLike(exportsObject)) return false;
      const proto = Object.getPrototypeOf(exportsObject);
      return hasOwn(proto, name) && typeof proto[name] === "function";
    }
    case "classPrototypeMethod":
      return typeof exportsObject === "function" && isObjectLike(exportsObject.prototype)
        && hasOwn(exportsObject.prototype, name) && typeof exportsObject.prototype[name] === "function";
    case "exportClassPrototypeMethod": {
      if (!hasOwn(exportsObject, symbol.exportName)) return false;
      const cls = exportsObject[symbol.exportName];
      return typeof cls === "function" && isObjectLike(cls.prototype)
        && hasOwn(cls.prototype, name) && typeof cls.prototype[name] === "function";
    }
    case "exportClassInstanceField": {
      if (!hasOwn(exportsObject, symbol.exportName)) return false;
      const cls = exportsObject[symbol.exportName];
      return typeof cls === "function" && Function.prototype.toString.call(cls).includes(`this.${name} =`);
    }
    case "property":
      return hasOwn(exportsObject, name);
    default:
      return false;
  }
}

function safePresent(exportsObject, symbol) {
  try {
    return symbolPresent(exportsObject, symbol);
  } catch (_err) {
    return false;
  }
}

function safeLoad(load, relPath) {
  try {
    const result = load(relPath);
    if (result && result.ok === true) return result;
    return { ok: false, reason: (result && result.reason) || "load_failed" };
  } catch (err) {
    return { ok: false, reason: `require_failed: ${(err && err.message) || err}` };
  }
}

function probeModules(table, load) {
  const modules = [];
  const counts = { ok: 0, drift: 0, missing: 0 };
  const disabled = {};
  for (const entry of Array.isArray(table) ? table : []) {
    const symbols = Array.isArray(entry.symbols) ? entry.symbols : [];
    const loaded = safeLoad(load, entry.path);
    const failed = loaded.ok ? symbols.filter((s) => !safePresent(loaded.exports, s)) : symbols;
    const affects = [];
    for (const s of failed) {
      const label = s.optional === true ? `${s.consumer} (optional)` : s.consumer;
      if (!affects.includes(label)) affects.push(label);
      if (s.optional === true) continue;
      if (!hasOwn(disabled, s.consumer)) {
        disabled[s.consumer] = loaded.ok ? `drift:${entry.path}.${s.name}` : `missing:${entry.path}`;
      }
    }
    let status = STATUS.OK;
    if (!loaded.ok) status = STATUS.MISSING;
    else if (failed.length > 0) status = STATUS.DRIFT;
    counts[status === STATUS.OK ? "ok" : status === STATUS.DRIFT ? "drift" : "missing"] += 1;
    modules.push({ path: entry.path, status, missing: failed.map((s) => s.name),
      reason: loaded.ok ? null : loaded.reason, affects });
  }
  return { modules, passed: counts.drift === 0 && counts.missing === 0, counts, disabled };
}

function formatProbeLog(report) {
  const counts = report.counts || { ok: 0, drift: 0, missing: 0 };
  const suffix = report.error ? ` - ${report.error}` : "";
  const lines = [`probe ${report.passed ? "passed" : "failed"} `
    + `(${counts.ok} ok, ${counts.drift} drift, ${counts.missing} missing)${suffix}`];
  for (const m of report.modules || []) {
    if (m.status === STATUS.OK) continue;
    const affects = `(affects: ${m.affects.length > 0 ? m.affects.join(", ") : "none"})`;
    if (m.status === STATUS.DRIFT) lines.push(`probe DRIFT ${m.path} - missing ${m.missing.join(", ")} ${affects}`);
    else lines.push(`probe MISSING ${m.path} - ${m.reason} ${affects}`);
  }
  return lines;
}

function createAdapter(deps = {}) {
  const moduleApi = deps.moduleApi || {};
  const requireFn = typeof deps.requireFn === "function" ? deps.requireFn : (absolutePath) => require(absolutePath);
  const existsSync = typeof deps.existsSync === "function" ? deps.existsSync : fs.existsSync;
  const gameModules = Array.isArray(deps.gameModules) ? deps.gameModules : GAME_MODULES;
  const allowed = new Set(gameModules.map((entry) => entry.path));
  const state = { serverSrc: null, booted: false, report: null, loadedOutsideCache: [] };

  function setServerSrc(srcDir) {
    if (typeof srcDir !== "string" || srcDir === "") return { ok: false, reason: "server_src_invalid" };
    if (state.serverSrc !== null) {
      return state.serverSrc === srcDir ? { ok: true, reason: null } : { ok: false, reason: "server_src_already_set" };
    }
    state.serverSrc = srcDir;
    return { ok: true, reason: null };
  }

  function requireGame(relPath) {
    if (state.serverSrc === null) return { ok: false, reason: "server_src_unknown" };
    if (!allowed.has(relPath)) return { ok: false, reason: "not_in_game_modules" };
    const absolutePath = path.join(state.serverSrc, `${relPath}.js`);
    try {
      const cache = moduleApi._cache;
      if (hasOwn(cache, absolutePath) && cache[absolutePath]) return { ok: true, exports: cache[absolutePath].exports };
      if (!state.booted) return { ok: false, reason: "not_booted" };
      if (!existsSync(absolutePath)) return { ok: false, reason: "file_not_found" };
      const exportsObject = requireFn(absolutePath);
      if (!state.loadedOutsideCache.includes(relPath)) state.loadedOutsideCache.push(relPath);
      return { ok: true, exports: exportsObject };
    } catch (err) {
      return { ok: false, reason: `require_failed: ${(err && err.message) || err}` };
    }
  }

  function runProbe() {
    if (state.serverSrc === null) {
      const disabled = {};
      for (const entry of gameModules) {
        for (const s of entry.symbols || []) {
          if (!hasOwn(disabled, s.consumer)) disabled[s.consumer] = "server_src_not_found";
        }
      }
      state.report = { modules: [], passed: false, counts: { ok: 0, drift: 0, missing: 0 }, disabled,
        error: "server_src_not_found" };
    } else {
      state.report = probeModules(gameModules, requireGame);
    }
    return state.report;
  }

  return {
    setServerSrc,
    requireGame,
    markBooted() { state.booted = true; },
    runProbe,
    getReport: () => state.report,
    isConsumerAvailable: (consumer) => state.report !== null && !hasOwn(state.report.disabled, consumer),
    getLoadedOutsideCache: () => [...state.loadedOutsideCache],
  };
}

module.exports = {
  STATUS, WORLD_ROLE, GAMESTORE_SEARCH_MAX_DEPTH,
  findServerSrcInCache, processRoleFromWorld, evaluateWorldGate,
  symbolPresent, probeModules, formatProbeLog, createAdapter,
};
