"use strict";

const { fingerprintFunctions } = require("./blueprintOwnerRead");
const { directCaller } = require("./templateReadOnly");

const DETAIL_MAX = 200;
const CALLER_FUNCTION = "listStoredDungeonNativeWreckIDs";
const CALLER_FILE = "dungeonUniverseSiteService.js";

const STORE_FUNCTIONS = Object.freeze([
  "listNativeWrecks", "isPendingMiningWreck", "readCollection", "readCollectionRaw",
  "ensureRootShape",
]);
const SITE_FUNCTIONS = Object.freeze([CALLER_FUNCTION]);

const FINGERPRINTS = Object.freeze({
  store: Object.freeze({
    listNativeWrecks: "48c138852cced0c512fda4a00668fc4d3422d543",
    isPendingMiningWreck: "4c9ac7cb4cd861cad92c76ef93e71c3008e8d0e5",
    readCollection: "76ba5a0b84f40f3d767aa76ac564441a71d9e218",
    readCollectionRaw: "f653a2059963c2e29fb1b928a3364ef373713580",
    ensureRootShape: "10f9616e4f54849f9a7c9eb1219afb486398b37a",
  }),
  site: Object.freeze({
    listStoredDungeonNativeWreckIDs: "2c3339dae445e6dce2efb0adc9c8ff2d1892fb86",
  }),
});

function fit(text) {
  const s = String(text);
  return s.length > DETAIL_MAX ? s.slice(0, DETAIL_MAX) : s;
}

function isObject(value) {
  return value !== null && typeof value === "object";
}

function markWrapped(wrapper, original) {
  Object.defineProperty(wrapper, "__hotPathPerfWreckList", { value: original });
  return wrapper;
}

const UPSTREAM_MATCHING = "listNativeWrecksMatching(";

function scopedFixedUpstream(siteSource) {
  const text = String(siteSource || "").replace(/\r\n/g, "\n");
  const start = text.indexOf(`\nfunction ${CALLER_FUNCTION}(`);
  if (start < 0) return false;
  const end = text.indexOf("\n}\n", start);
  const body = text.slice(start, end < 0 ? text.length : end);
  return body.includes(UPSTREAM_MATCHING) && !body.includes(".listNativeWrecks(");
}

function isScopedFrame(frame) {
  if (!frame) return false;
  const file = String(frame.getFileName() || "").replace(/\\/g, "/");
  return frame.getFunctionName() === CALLER_FUNCTION && file.endsWith(`/${CALLER_FILE}`);
}

function resolveExports(source) {
  if (typeof source === "function") return source();
  return source || null;
}

function sameJson(a, b) {
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch (_error) {
    return false;
  }
}

function emptyWindow() {
  return { calls: 0, scoped: 0, global: 0, rows: 0, rowsMax: 0, pendingHits: 0, fallback: {}, parityChecks: 0 };
}

function createNativeWreckList(options) {
  const config = options.config;
  const log = options.log;
  const priv = {
    deps: null,
    fingerprintOk: false,
    disabledReason: null,
    shapedRoot: null,
    scopedObsolete: false,
    window: emptyWindow(),
  };

  function disable(reason, detail) {
    if (priv.disabledReason) return;
    priv.disabledReason = reason;
    log(`WARN nativeWreckList disabled: ${reason}${detail ? ` (${fit(detail)})` : ""}`);
  }

  function setDeps(storeExports, gameStore, deathWrecks, incursionWrecks) {
    if (priv.deps) return true;
    const table = storeExports && storeExports.TABLE;
    if (!isObject(table) || typeof table.WRECKS !== "string" || typeof table.CARGO !== "string") return false;
    if (!gameStore || typeof gameStore.read !== "function") return false;
    priv.deps = { wrecksTable: table.WRECKS, cargoTable: table.CARGO, gameStore, deathWrecks, incursionWrecks };
    return true;
  }

  function checkFingerprint(sources) {
    const scopedObsolete = scopedFixedUpstream(sources && sources.siteSource);
    const groups = [
      [fingerprintFunctions(sources && sources.storeSource, STORE_FUNCTIONS), FINGERPRINTS.store],
    ];
    if (!scopedObsolete) groups.push([fingerprintFunctions(sources && sources.siteSource, SITE_FUNCTIONS), FINGERPRINTS.site]);
    for (const [got, expected] of groups) {
      for (const name of Object.keys(expected)) {
        if (got.get(name) !== expected[name]) return { ok: false, reason: "drift", detail: name };
      }
    }
    priv.fingerprintOk = true;
    if (scopedObsolete && !priv.scopedObsolete) {
      priv.scopedObsolete = true;
      log(`WARN nativeWreckList scoped disabled: obsolete (EveJS reads it itself: ${CALLER_FUNCTION} → ${UPSTREAM_MATCHING.slice(0, -1)})`);
    }
    return scopedObsolete ? { ok: true, obsolete: ["scoped"] } : { ok: true };
  }

  function fallback(reason) {
    priv.window.fallback[reason] = (priv.window.fallback[reason] || 0) + 1;
  }

  function readRoot() {
    const result = priv.deps.gameStore.read(priv.deps.wrecksTable, "/");
    return result && result.success && isObject(result.data) ? result.data : null;
  }

  function isPending(record, death, incursion) {
    if (death.isPendingWreck(record)) return true;
    if (incursion.isPending(record)) return true;
    if (!record?.miningCargoTransferKey) return false;
    const transfer = priv.deps.gameStore.read(priv.deps.cargoTable, `/miningTransfers/${record.miningCargoTransferKey}`);
    return !transfer.success || transfer.data?.status !== "completed";
  }

  function wrapList(original) {
    const wrapped = function hotPathPerfNativeWreckList() {
      priv.window.calls += 1;
      if (priv.disabledReason || !priv.deps || !priv.fingerprintOk) {
        fallback(priv.disabledReason ? "disabled" : "waiting");
        return original.apply(this, arguments);
      }
      let rows;
      let scoped;
      try {
        const root = readRoot();
        if (root === null || root !== priv.shapedRoot) {
          fallback(priv.shapedRoot === null ? "first" : "root");
          const result = original.apply(this, arguments);
          priv.shapedRoot = readRoot();
          return result;
        }
        if (!isObject(root.wrecks)) {
          fallback("shape");
          return original.apply(this, arguments);
        }
        const death = resolveExports(priv.deps.deathWrecks);
        const incursion = resolveExports(priv.deps.incursionWrecks);
        if (!death || typeof death.isPendingWreck !== "function" || !incursion || typeof incursion.isPending !== "function") {
          fallback("deps");
          return original.apply(this, arguments);
        }
        rows = [];
        let pendingHits = 0;
        for (const record of Object.values(root.wrecks)) {
          if (record === undefined) continue;
          if (isPending(record, death, incursion)) {
            pendingHits += 1;
            continue;
          }
          rows.push(record);
        }
        rows.sort((left, right) => Number(left.wreckID || 0) - Number(right.wreckID || 0));
        scoped = !priv.scopedObsolete && isScopedFrame(directCaller(wrapped));
        if (!scoped) rows = JSON.parse(JSON.stringify(rows));
        priv.window.pendingHits += pendingHits;
      } catch (error) {
        disable("error", String(error && error.message || error));
        fallback("error");
        return original.apply(this, arguments);
      }
      if (config.nativeWreckListParityCheck === true) {
        const vendor = original.apply(this, arguments);
        priv.window.parityChecks += 1;
        if (!sameJson(rows, vendor)) {
          disable("parity", `rows=${rows.length} vendor=${Array.isArray(vendor) ? vendor.length : "?"}`);
          fallback("parity");
          return vendor;
        }
      }
      if (scoped) priv.window.scoped += 1;
      else priv.window.global += 1;
      priv.window.rows += rows.length;
      if (rows.length > priv.window.rowsMax) priv.window.rowsMax = rows.length;
      return rows;
    };
    return markWrapped(wrapped, original);
  }

  function stateText() {
    if (priv.disabledReason) return `disabled:${priv.disabledReason}`;
    return priv.deps && priv.fingerprintOk ? "ready" : "waiting";
  }

  function status() {
    return {
      enabled: priv.disabledReason === null,
      ready: priv.disabledReason === null && priv.deps !== null && priv.fingerprintOk,
      disabledReason: priv.disabledReason,
      state: stateText(),
      scoped: priv.scopedObsolete ? "obsolete" : "on",
    };
  }

  function statsSnapshot() {
    return { ...status(), ...priv.window, fallback: { ...priv.window.fallback } };
  }

  function statsLine() {
    const w = priv.window;
    const fb = Object.keys(w.fallback).sort().map((k) => `${k}:${w.fallback[k]}`).join(",");
    return `stats nativeWreckList state=${stateText()} calls=${w.calls} scoped=${w.scoped} global=${w.global} rows=${w.rows} ` +
      `rowsMax=${w.rowsMax} pendingHits=${w.pendingHits} fallback=${fb || "-"} parityChecks=${w.parityChecks}`;
  }

  function drainStatsLines() {
    const line = statsLine();
    priv.window = emptyWindow();
    return [line];
  }

  return { setDeps, checkFingerprint, wrapList, disable, status, statsSnapshot, statsLine, drainStatsLines };
}

module.exports = {
  createNativeWreckList, isScopedFrame, scopedFixedUpstream, UPSTREAM_MATCHING, STORE_FUNCTIONS, SITE_FUNCTIONS, FINGERPRINTS, CALLER_FUNCTION, CALLER_FILE,
};
