"use strict";

const crypto = require("crypto");
const { fingerprintFunctions } = require("./blueprintOwnerRead");

const MARK = Symbol.for("evejs.hotPathPerf.configSnapshotMemo");
const FUNCTIONS = Object.freeze([
  "getRuntimeConfig", "normalizeCountryCode", "buildGlobalConfigEntries", "buildGlobalConfigDict", "getRuntimeGlobalConfigValue",
]);
const CONFIG_SLOTS = Object.freeze({
  normalizeCountryCode: 1,
  buildGlobalConfigEntries: 0,
  buildGlobalConfigDict: 0,
  getRuntimeGlobalConfigValue: 1,
});
const FINGERPRINTS = Object.freeze({
  getRuntimeConfig: "87908314b95aef47a12d2f1cee2bbcff80bd9ec9",
  normalizeCountryCode: "87048b06e840665f6bca5ac1a0083e2da1a44a1e",
  buildGlobalConfigEntries: "5053ede0e267ede6362eb6823dfe09a1a66831e3",
  buildGlobalConfigDict: "056a56af8f8d0f2b68b59400fc2c840c425f37c3",
  getRuntimeGlobalConfigValue: "c6406bd32cd63158121124f16e278199c6155ee9",
});
const MANAGER_FUNCTIONS = Object.freeze(["loadState", "readVersion"]);
const MANAGER_INDENT = "  ";
const MANAGER_FINGERPRINTS = Object.freeze({
  loadState: "0651ec64a0417d970c8e07756c6599aabbeda81c",
  readVersion: "681e9fc995bfe4f8e5dab25fd70b532933662e35",
});
const PARITY_WARN_INTERVAL_MS = 60000;
const STAT_NAMES = Object.freeze(["hits", "misses", "revalidations", "keyChanges", "passthroughErrors", "parityMismatches"]);

function isObject(value) {
  return value !== null && typeof value === "object";
}

function emptyStats() {
  return Object.fromEntries(STAT_NAMES.map((name) => [name, 0]));
}

function sameJson(a, b) {
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch (_error) {
    return false;
  }
}

function fingerprintNestedFunctions(sourceText, names, indent) {
  const text = String(sourceText || "").replace(/\r\n/g, "\n");
  const out = new Map();
  for (const name of names) {
    const start = new RegExp(`^${indent}function ${name}\\(`, "m").exec(text);
    const endAt = start ? text.indexOf(`\n${indent}}\n`, start.index) : -1;
    out.set(name, endAt < 0 ? null
      : crypto.createHash("sha1").update(text.slice(start.index, endAt + indent.length + 2)).digest("hex"));
  }
  return out;
}

function mark(wrapper, original) {
  Object.defineProperty(wrapper, MARK, { value: original });
  return wrapper;
}

function createConfigSnapshotMemo(options = {}) {
  const fs = options.fs || require("fs");
  const now = options.now || Date.now;
  const revalidateMs = Number(options.revalidateMs) || 0;
  const parityCheck = options.parityCheck === true;
  const log = options.log || (() => {});
  const priv = {
    cached: null,
    key: null,
    paths: null,
    checkedAt: 0,
    pathsFailedAt: null,
    disabledReason: null,
    vendorConfig: null,
    origGet: null,
    lastParityWarnAt: null,
    total: emptyStats(),
    window: emptyStats(),
  };

  function bump(name) {
    priv.total[name] += 1;
    priv.window[name] += 1;
  }

  function disable(reason) {
    if (priv.disabledReason) return;
    priv.disabledReason = String(reason);
    priv.cached = null;
    priv.key = null;
    log(`WARN configSnapshotMemo disabled: ${priv.disabledReason}`);
  }

  function checkSource(sourceText) {
    const got = fingerprintFunctions(sourceText, FUNCTIONS);
    for (const name of FUNCTIONS) {
      if (got.get(name) !== FINGERPRINTS[name]) {
        disable(`drift:${name}`);
        return { ok: false, reason: `drift:${name}` };
      }
    }
    return { ok: true };
  }

  function checkManagerSource(sourceText) {
    const got = fingerprintNestedFunctions(sourceText, MANAGER_FUNCTIONS, MANAGER_INDENT);
    for (const name of MANAGER_FUNCTIONS) {
      if (got.get(name) !== MANAGER_FINGERPRINTS[name]) {
        disable(`drift:manager.${name}`);
        return { ok: false, reason: `drift:manager.${name}` };
      }
    }
    return { ok: true };
  }

  function setVendorConfig(cfg) {
    if (cfg !== null && (typeof cfg === "object" || typeof cfg === "function")) priv.vendorConfig = cfg;
  }

  function resolvePaths(t) {
    if (priv.paths) return "ok";
    let snapshot;
    try {
      snapshot = priv.vendorConfig.getConfigStateSnapshot();
    } catch (_error) {
      priv.pathsFailedAt = t;
      return "threw";
    }
    priv.pathsFailedAt = null;
    const files = snapshot && snapshot.configFilePaths;
    const versionPath = snapshot && snapshot.versionConfigPath;
    const list = isObject(files) ? Object.values(files) : [];
    if (list.length === 0 || list.some((p) => typeof p !== "string") || typeof versionPath !== "string") {
      disable("paths");
      return "bad";
    }
    priv.paths = [...list, versionPath];
    return "ok";
  }

  function inWindow(t, from) {
    return from !== null && Number.isFinite(t) && t >= from && t - from < revalidateMs;
  }

  function statKey() {
    return priv.paths.map((p) => {
      const st = fs.statSync(p, { bigint: true, throwIfNoEntry: false });
      return st ? `${st.mtimeNs}:${st.size}:${st.ino}` : "-";
    }).join("|");
  }

  function warnParity() {
    const t = now();
    if (priv.lastParityWarnAt !== null && t - priv.lastParityWarnAt < PARITY_WARN_INTERVAL_MS) return;
    priv.lastParityWarnAt = t;
    log(`WARN configSnapshotMemo parity mismatch (total=${priv.total.parityMismatches}), vendor result returned`);
  }

  function hit(forExport) {
    bump("hits");
    if (parityCheck) {
      const vendor = priv.origGet();
      if (!sameJson(vendor, priv.cached)) {
        bump("parityMismatches");
        warnParity();
        return vendor;
      }
    }
    if (!forExport) return priv.cached;
    try {
      return structuredClone(priv.cached);
    } catch (_error) {
      disable("clone");
      return priv.origGet();
    }
  }

  function lookup(forExport) {
    if (priv.disabledReason) return priv.origGet();
    if (!priv.vendorConfig || typeof priv.vendorConfig.getConfigStateSnapshot !== "function") {
      disable("deps");
      return priv.origGet();
    }
    const t = now();
    if (priv.cached && inWindow(t, priv.checkedAt)) return hit(forExport);
    if (!priv.paths && inWindow(t, priv.pathsFailedAt)) {
      bump("passthroughErrors");
      return priv.origGet();
    }
    const resolved = resolvePaths(t);
    if (resolved === "threw") {
      bump("passthroughErrors");
      return priv.vendorConfig;
    }
    if (resolved !== "ok") {
      bump("passthroughErrors");
      return priv.origGet();
    }
    let sig;
    try {
      sig = statKey();
    } catch (_error) {
      bump("passthroughErrors");
      return priv.origGet();
    }
    if (priv.cached && sig === priv.key) {
      priv.checkedAt = t;
      bump("revalidations");
      return hit(forExport);
    }
    const r = priv.origGet();
    if (r === priv.vendorConfig || !isObject(r)) {
      bump("passthroughErrors");
      return r;
    }
    let stored = r;
    if (forExport) {
      try {
        stored = structuredClone(r);
      } catch (_error) {
        disable("clone");
        return r;
      }
    }
    if (priv.key !== null) bump("keyChanges");
    priv.cached = stored;
    priv.key = sig;
    priv.checkedAt = t;
    bump("misses");
    return r;
  }

  function wrapGet(original) {
    return mark(function hotPathPerfGetRuntimeConfig() {
      if (priv.disabledReason) return original.apply(this, arguments);
      try {
        return lookup(true);
      } catch (error) {
        disable(`error:${error && error.message || error}`);
        return original.apply(this, arguments);
      }
    }, original);
  }

  function wrapSlot(name, original) {
    const slot = CONFIG_SLOTS[name];
    return mark(function hotPathPerfConfigMemoSlot() {
      if (priv.disabledReason || arguments[slot] !== undefined) return original.apply(this, arguments);
      const args = Array.prototype.slice.call(arguments);
      try {
        const rc = lookup(false);
        args[slot] = name === "normalizeCountryCode" ? rc.defaultCountryCode : rc;
      } catch (error) {
        disable(`error:${error && error.message || error}`);
        return original.apply(this, arguments);
      }
      return original.apply(this, args);
    }, original);
  }

  function patchExports(exportsObj) {
    if (!isObject(exportsObj)) return { ok: false, reason: "exports" };
    const current = exportsObj.getRuntimeConfig;
    if (typeof current === "function" && current[MARK]) return { ok: true };
    for (const name of FUNCTIONS) {
      const desc = Object.getOwnPropertyDescriptor(exportsObj, name);
      if (!desc || typeof desc.value !== "function" || desc.writable !== true) return { ok: false, reason: `missing:${name}` };
      if (desc.value.name !== name) return { ok: false, reason: `order:${name}` };
    }
    const originals = Object.fromEntries(FUNCTIONS.map((name) => [name, exportsObj[name]]));
    priv.origGet = originals.getRuntimeConfig;
    exportsObj.getRuntimeConfig = wrapGet(originals.getRuntimeConfig);
    for (const name of Object.keys(CONFIG_SLOTS)) exportsObj[name] = wrapSlot(name, originals[name]);
    return { ok: true };
  }

  function stateText() {
    if (priv.disabledReason) return `disabled:${priv.disabledReason}`;
    if (priv.cached) return "cached";
    return priv.origGet ? "armed" : "inactive";
  }

  function status() {
    return { disabledReason: priv.disabledReason, state: stateText() };
  }

  function stats() {
    return { ...status(), ...priv.total };
  }

  function statsLine() {
    const w = priv.window;
    return `stats configMemo=${priv.disabledReason ? `disabled:${priv.disabledReason}` : "on"} hits=${w.hits} misses=${w.misses} ` +
      `reval=${w.revalidations} keyChg=${w.keyChanges} errPass=${w.passthroughErrors} parity=${w.parityMismatches}`;
  }

  function drainStatsLines() {
    const line = statsLine();
    priv.window = emptyStats();
    return [line];
  }

  return {
    checkSource, checkManagerSource, setVendorConfig, patchExports, disable, status, stats, statsLine, drainStatsLines,
    _testing: {
      memoGet: () => lookup(false),
      reset() {
        priv.cached = null;
        priv.key = null;
        priv.paths = null;
        priv.checkedAt = 0;
        priv.pathsFailedAt = null;
        priv.lastParityWarnAt = null;
        priv.total = emptyStats();
        priv.window = emptyStats();
      },
    },
  };
}

module.exports = {
  createConfigSnapshotMemo, fingerprintNestedFunctions, FUNCTIONS, CONFIG_SLOTS, FINGERPRINTS,
  MANAGER_FUNCTIONS, MANAGER_INDENT, MANAGER_FINGERPRINTS, MARK, PARITY_WARN_INTERVAL_MS,
};
