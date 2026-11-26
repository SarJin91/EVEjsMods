"use strict";

const crypto = require("node:crypto");
const nodePath = require("node:path");
const { FILE_FINGERPRINTS: ESS_FILE_FINGERPRINTS, functionBody, fingerprintFunctions } = require("./essRepositoryFast");

const COUNTER_NAMES = Object.freeze(["hit", "miss", "bypass", "drift"]);
const MARK_SCOPE = Symbol.for("livingNewEden.dbsKillmailCache.scope");
const MARK_GET_ALL = Symbol.for("livingNewEden.dbsKillmailCache.getAll");
const SCOPE_EXPORTS = Object.freeze(["maintain", "recoverLosses"]);
const GET_ALL = "getAllKillmailRecords";
const STATS = "getKillmailProjectionStats";
const DETAIL_MAX = 200;
const MS_PER_MINUTE = 60000;

const DBS_FILES = Object.freeze(["services/dynamic/dynamicBountyRuntime.js", "services/dynamic/essSettlementRuntime.js"]);
const FILE_FINGERPRINTS = Object.freeze({
  ...Object.fromEntries(DBS_FILES.map((rel) => [rel, ESS_FILE_FINGERPRINTS[rel]])),
  "abyssal/domain/abyssalHostLocation.js": "aff3810d8e4752bc5fae09da89aee40cc04fe5ce",
});
const FUNCTION_FINGERPRINTS = Object.freeze({
  "services/killmail/killmailState.js": Object.freeze({
    getAllKillmailRecords: "c7735f40cd392ab4facdcefd758f9992720ee9d2",
    getKillmailProjectionStats: "0f3904a25a93148712e6befa83ba05519eeaefd6",
    redactReservedAbyssalHostFromKillmail: "07ded21f8b86f3ae3340046cd9e9ef976ea1b5d8",
    redactReservedAbyssalHostsFromKillmails: "0fd791708b8a80a968e130748fc9206d1a665981",
    ensureKillmailIndexes: "3de21eeb1c471a28a1d5600ebd4442d29afbd1c0",
    markKillmailIndexesDirty: "12a994379c023b4f4953bf5f0a1fc1c35600f7c7",
    writeKillmailTable: "c28738f294e2cabafb49e5136ca33dd4cc7e684e",
    commitPreparedKillmailRecord: "59ec28b1d74d3df3bcce7d0707be4f84c28f2faa",
    createKillmailRecordIdempotent: "27ce656248bbc82c3d4e7fc4889fb59c720cbeeb",
  }),
});
const OWNER_SUFFIXES = Object.freeze(["/services/killmail/killmailState.js", "/services/dynamic/dynamicBountyRuntime.js"]);

function lf(text) {
  return String(text).replace(/\r\n/g, "\n");
}

function fit(text) {
  const s = String(text);
  return s.length > DETAIL_MAX ? s.slice(0, DETAIL_MAX) : s;
}

function sha1(text) {
  return crypto.createHash("sha1").update(text).digest("hex");
}

function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return value;
}

function checkFingerprints(srcDir, readFile) {
  for (const rel of Object.keys(FILE_FINGERPRINTS)) {
    const text = readFile(nodePath.join(srcDir, ...rel.split("/")));
    if (typeof text !== "string") return `${rel} missing`;
    if (sha1(lf(text)) !== FILE_FINGERPRINTS[rel]) return rel;
  }
  for (const rel of Object.keys(FUNCTION_FINGERPRINTS)) {
    const text = readFile(nodePath.join(srcDir, ...rel.split("/")));
    if (typeof text !== "string") return `${rel} missing`;
    const expected = FUNCTION_FINGERPRINTS[rel];
    const got = fingerprintFunctions(text, Object.keys(expected));
    for (const name of Object.keys(expected)) if (got.get(name) !== expected[name]) return `${rel}#${name}`;
  }
  return null;
}

function obsoleteDetail(srcDir, readFile) {
  const rel = DBS_FILES[0];
  const text = readFile(nodePath.join(srcDir, ...rel.split("/")));
  if (typeof text !== "string") return null;
  const recover = functionBody(text, "recoverLosses");
  if (recover === null || lf(text).includes(GET_ALL)) return null;
  return `${rel} never calls ${GET_ALL}`;
}

function locateSrcDir(exportsObj, requireCache) {
  if (!requireCache || typeof requireCache !== "object") return null;
  for (const file of Object.keys(requireCache)) {
    const entry = requireCache[file];
    if (!entry || entry.exports !== exportsObj) continue;
    const norm = file.replace(/\\/g, "/");
    if (!OWNER_SUFFIXES.some((suffix) => norm.endsWith(suffix))) continue;
    return nodePath.dirname(nodePath.dirname(nodePath.dirname(file)));
  }
  return null;
}

function createDbsKillmailCache(o) {
  const maxRecords = Number.isSafeInteger(o && o.maxRecords) && o.maxRecords > 0 ? o.maxRecords : 0;
  const onCount = o && typeof o.onCount === "function" ? o.onCount : () => {};
  let state = "waiting";
  let disabledDetail = null;
  let depth = 0;
  let statsFn = null;
  let entry = null;
  const total = { hit: 0, miss: 0, bypass: 0, drift: 0 };
  let win = { hit: 0, miss: 0, bypass: 0 };

  const count = (name) => {
    if (name in total) total[name] += 1;
    if (name in win) win[name] += 1;
    try {
      onCount(name);
    } catch (_err) {
    }
  };

  function disable(reason, detail) {
    if (state.startsWith("disabled:")) return;
    state = `disabled:${reason}`;
    disabledDetail = detail === undefined || detail === null ? null : fit(detail);
    entry = null;
    if (reason === "drift" || reason === "probe") count("drift");
  }

  function setDeps(killmailExports) {
    const fn = killmailExports && killmailExports[STATS];
    if (typeof fn !== "function") return false;
    statsFn = fn;
    if (state === "waiting") state = "ready";
    return true;
  }

  function versionKey() {
    const s = statsFn.call(null);
    if (!s || s.ready !== true || s.dirty !== false) return null;
    if (!Number.isSafeInteger(s.fullRebuilds) || !Number.isSafeInteger(s.incrementalUpdates)) return null;
    return `${s.fullRebuilds}:${s.incrementalUpdates}`;
  }

  function serve(original, self, args) {
    let before;
    try {
      before = versionKey();
      if (before !== null && entry !== null && entry.key === before) {
        count("hit");
        return entry.records;
      }
    } catch (err) {
      disable("error", err && err.message);
      return original.apply(self, args);
    }
    count("miss");
    const result = original.apply(self, args);
    try {
      if (!Array.isArray(result)) {
        entry = null;
        return result;
      }
      if (result.length > maxRecords) {
        entry = null;
        count("bypass");
        return result;
      }
      const after = versionKey();
      if (before === null || after !== before) {
        entry = null;
        return result;
      }
      entry = { key: before, records: deepFreeze(result) };
      return entry.records;
    } catch (err) {
      disable("error", err && err.message);
      return result;
    }
  }

  function wrapGetAll(original) {
    if (typeof original !== "function" || original[MARK_GET_ALL]) return original;
    const wrapped = function getAllKillmailRecords() {
      if (depth <= 0 || state !== "ready") return original.apply(this, arguments);
      return serve(original, this, arguments);
    };
    Object.defineProperty(wrapped, MARK_GET_ALL, { value: original });
    return wrapped;
  }

  function wrapScope(original) {
    if (typeof original !== "function" || original[MARK_SCOPE]) return original;
    const wrapped = function dbsKillmailScope() {
      depth += 1;
      try {
        return original.apply(this, arguments);
      } finally {
        depth -= 1;
      }
    };
    Object.defineProperty(wrapped, MARK_SCOPE, { value: original });
    return wrapped;
  }

  function status() {
    return { state, detail: disabledDetail, depth, cachedRecords: entry ? entry.records.length : 0,
      key: entry ? entry.key : null, maxRecords, counts: { ...total } };
  }

  function hasActivity() {
    return win.hit + win.miss + win.bypass > 0;
  }

  function resetWindow() {
    win = { hit: 0, miss: 0, bypass: 0 };
  }

  function statsLine() {
    return `dbsKillmailCache stats state=${state} hit=${win.hit} miss=${win.miss} bypass=${win.bypass} `
      + `records=${entry ? entry.records.length : 0} key=${entry ? entry.key : "-"}`;
  }

  return { wrapGetAll, wrapScope, setDeps, disable, status, statsLine, hasActivity, resetWindow,
    state: () => state };
}

function installGetAll(core, killmailExports, sourceText) {
  const exp = killmailExports;
  const d = exp && (typeof exp === "object" || typeof exp === "function")
    ? Object.getOwnPropertyDescriptor(exp, GET_ALL) : null;
  if (!d || typeof d.value !== "function" || typeof exp[STATS] !== "function") return { ok: false, reason: "missing" };
  if (d.writable !== true || Object.isFrozen(exp)) return { ok: false, reason: "not_writable" };
  if (d.value[MARK_GET_ALL]) return { ok: false, reason: "already_wrapped" };
  if (typeof sourceText === "string") {
    for (const name of [GET_ALL, STATS]) {
      const body = functionBody(sourceText, name);
      if (body === null || lf(Function.prototype.toString.call(exp[name])) !== body) {
        return { ok: false, reason: "foreign", detail: name };
      }
    }
  }
  core.setDeps(exp);
  exp[GET_ALL] = core.wrapGetAll(d.value);
  return { ok: true };
}

function installScope(core, dbsExports) {
  const exp = dbsExports;
  if (!exp || (typeof exp !== "object" && typeof exp !== "function")) return { ok: false, reason: "missing" };
  for (const name of SCOPE_EXPORTS) {
    const d = Object.getOwnPropertyDescriptor(exp, name);
    if (!d || typeof d.value !== "function") return { ok: false, reason: "missing" };
    if (d.writable !== true || Object.isFrozen(exp)) return { ok: false, reason: "not_writable" };
    if (d.value[MARK_SCOPE]) return { ok: false, reason: "already_wrapped" };
  }
  for (const name of SCOPE_EXPORTS) exp[name] = core.wrapScope(exp[name]);
  return { ok: true };
}

function statsPeriodMs(minutes) {
  return Number.isSafeInteger(minutes) && minutes > 0 ? minutes * MS_PER_MINUTE : 0;
}

module.exports = {
  COUNTER_NAMES, MARK_SCOPE, MARK_GET_ALL, SCOPE_EXPORTS, FILE_FINGERPRINTS, FUNCTION_FINGERPRINTS,
  checkFingerprints, obsoleteDetail, locateSrcDir, createDbsKillmailCache, installGetAll, installScope, statsPeriodMs,
};
