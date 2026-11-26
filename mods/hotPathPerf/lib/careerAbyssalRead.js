"use strict";

const { createCareerReadDispatch, markWrapped } = require("./careerReadDispatch");

const TABLE = "dungeonRuntimeState";
const GROUP = "instancesByID";
const ROW_KEY_SEP = "\u001f";
const ENTITY_PREFIX = GROUP + ROW_KEY_SEP;
const DETAIL_MAX = 200;

function defaultNow() {
  return process.hrtime.bigint();
}

function segmentCount(pth) {
  return String(pth || "/").split("/").filter(Boolean).length;
}

function fit(text) {
  const s = String(text);
  return s.length > DETAIL_MAX ? s.slice(0, DETAIL_MAX) : s;
}

function isCandidateRecord(instance) {
  return Boolean(instance) && instance.siteFamily === "abyssal" && instance.siteKind === "abyssal-pocket";
}

function compareSubset(ours, vendor) {
  if (!vendor || typeof vendor !== "object") return "vendorNotObject";
  if (!ours || typeof ours !== "object") return "oursNotObject";
  const scalarKeys = (o) => Object.keys(o).filter((k) => k !== GROUP).sort();
  const a = scalarKeys(ours);
  const b = scalarKeys(vendor);
  if (a.join("\u0000") !== b.join("\u0000")) return fit(`scalarKeys ours=${a.join(",")} vendor=${b.join(",")}`);
  for (const key of a) {
    if (JSON.stringify(ours[key]) !== JSON.stringify(vendor[key])) return fit(`scalar=${key}`);
  }
  const og = ours[GROUP] && typeof ours[GROUP] === "object" ? ours[GROUP] : {};
  const vg = vendor[GROUP] && typeof vendor[GROUP] === "object" ? vendor[GROUP] : {};
  const ourIds = Object.keys(og).sort();
  const vendorIds = Object.keys(vg).filter((id) => isCandidateRecord(vg[id])).sort();
  const n = Math.max(ourIds.length, vendorIds.length);
  for (let i = 0; i < n; i += 1) {
    if (ourIds[i] !== vendorIds[i]) {
      return fit(`ids ours=${ourIds.length} vendor=${vendorIds.length} firstDiff=${ourIds[i] !== undefined ? ourIds[i] : vendorIds[i]}`);
    }
  }
  for (const id of ourIds) {
    if (JSON.stringify(og[id]) !== JSON.stringify(vg[id])) return fit(`instance=${id}`);
  }
  return null;
}

function emptyWindow() {
  return {
    served: 0, fallbackByReason: new Map(), classified: 0, reclassified: 0,
    serveMaxMs: 0, parityChecks: 0, parityRetries: 0,
  };
}

function createCareerAbyssalRead(options) {
  const config = options.config;
  const log = options.log;
  const now = options.now || defaultNow;
  const openRowSource = options.openRowSource || require("./sqliteRowSource").openRowSource;
  const maxKeys = config.careerAbyssalReadMaxKeys;
  const reclassifyPerCall = Math.max(0, Math.floor(config.careerAbyssalReadReclassifyPerCall));
  const priv = {
    deps: null,
    depsFilename: null,
    disabledReason: null,
    depth: 0,
    serveNext: false,
    rowSource: null,
    classByKey: new Map(),
    order: [],
    cursor: 0,
    lastKeys: 0,
    lastCandidates: 0,
    firstBuildMs: null,
    window: emptyWindow(),
  };

  function elapsedMs(started) {
    return Number(now() - started) / 1e6;
  }

  function noteFallback(reason) {
    const map = priv.window.fallbackByReason;
    map.set(reason, (map.get(reason) || 0) + 1);
  }

  function disable(reason, detail) {
    if (priv.disabledReason) return;
    priv.disabledReason = reason;
    priv.serveNext = false;
    priv.classByKey = new Map();
    priv.order = [];
    priv.cursor = 0;
    log(`WARN careerAbyssalRead disabled: ${reason}${detail ? ` (${fit(detail)})` : ""}`);
  }

  function setDeps(sqliteStoreExports, sqliteStoreFilename) {
    if (priv.deps) return true;
    if (priv.disabledReason) return false;
    const m = sqliteStoreExports;
    if (!m || typeof m !== "object") return false;
    if (typeof m.getDatabasePath !== "function" || typeof m.assembleFromRows !== "function" ||
        typeof m.rowGroupsFor !== "function" || typeof sqliteStoreFilename !== "string" || sqliteStoreFilename === "") {
      return false;
    }
    if (m.ROW_KEY_SEP !== ROW_KEY_SEP) {
      disable("drift", `ROW_KEY_SEP=${JSON.stringify(m.ROW_KEY_SEP)}`);
      return false;
    }
    let groups;
    try {
      groups = m.rowGroupsFor(TABLE);
    } catch (error) {
      disable("drift", `rowGroupsFor threw: ${error && error.message || error}`);
      return false;
    }
    if (!Array.isArray(groups) || !groups.includes(GROUP)) {
      disable("drift", `rowGroupsFor(${TABLE})=${JSON.stringify(groups)}`);
      return false;
    }
    priv.deps = {
      getDatabasePath: () => m.getDatabasePath(),
      assembleFromRows: (table, rows) => m.assembleFromRows(table, rows),
    };
    priv.depsFilename = sqliteStoreFilename;
    return true;
  }

  function takeReclassify() {
    const order = priv.order;
    const count = Math.min(reclassifyPerCall, order.length);
    const out = [];
    for (let i = 0; i < count; i += 1) out.push(order[(priv.cursor + i) % order.length]);
    if (order.length > 0) priv.cursor = (priv.cursor + count) % order.length;
    return out;
  }

  function build(tx) {
    if (!tx.tableExists()) return { ok: false, reason: "NO_TABLE" };
    const keys = tx.listKeys();
    if (keys.length >= maxKeys) {
      disable("limit", `keys>=${maxKeys}`);
      return { ok: false, reason: "LIMIT" };
    }
    const other = [];
    const entity = [];
    for (const key of keys) (key.startsWith(ENTITY_PREFIX) ? entity : other).push(key);
    const rows = {};
    for (const row of tx.readRows(other)) {
      if (row.key === GROUP && row.json !== "{}") {
        disable("legacy", `${GROUP} skeleton length=${row.json.length}`);
        return { ok: false, reason: "LEGACY" };
      }
      rows[row.key] = JSON.parse(row.json);
    }
    const present = new Set(entity);
    let removed = false;
    for (const key of priv.classByKey.keys()) {
      if (!present.has(key)) {
        priv.classByKey.delete(key);
        removed = true;
      }
    }
    if (removed) {
      priv.order = priv.order.filter((key) => priv.classByKey.has(key));
      priv.cursor = priv.order.length > 0 ? priv.cursor % priv.order.length : 0;
    }
    const fresh = entity.filter((key) => !priv.classByKey.has(key));
    const again = takeReclassify();
    const results = tx.classify(fresh.length > 0 ? fresh.concat(again) : again);
    for (const row of results) {
      if (!priv.classByKey.has(row.key)) priv.order.push(row.key);
      priv.classByKey.set(row.key, row.abyssal === 1);
    }
    const candidates = entity.filter((key) => priv.classByKey.get(key) === true);
    for (const row of tx.readRows(candidates)) rows[row.key] = JSON.parse(row.json);
    return {
      ok: true,
      value: priv.deps.assembleFromRows(TABLE, rows),
      keys: keys.length,
      candidates: candidates.length,
      classified: fresh.length,
      reclassified: again.length,
    };
  }

  function readSubset() {
    if (priv.disabledReason) return { ok: false, reason: "DISABLED" };
    if (!priv.deps) return { ok: false, reason: "NO_DEPS" };
    try {
      const dbPath = priv.deps.getDatabasePath();
      if (typeof dbPath !== "string" || dbPath === "") return { ok: false, reason: "NO_DEPS" };
      if (!priv.rowSource) {
        priv.rowSource = openRowSource({
          sqliteStoreFilename: priv.depsFilename,
          dbPath,
          busyTimeoutMs: config.careerAbyssalReadBusyTimeoutMs,
        });
      } else if (priv.rowSource.dbPath !== dbPath) {
        return { ok: false, reason: "NO_DEPS" };
      }
      const started = now();
      const r = priv.rowSource.readSnapshot(build);
      if (!r.ok) return r;
      const ms = elapsedMs(started);
      const w = priv.window;
      w.classified += r.classified;
      w.reclassified += r.reclassified;
      if (ms > w.serveMaxMs) w.serveMaxMs = ms;
      if (priv.firstBuildMs === null) priv.firstBuildMs = ms;
      priv.lastKeys = r.keys;
      priv.lastCandidates = r.candidates;
      return { ok: true, value: r.value };
    } catch (error) {
      disable("error", String(error && error.message || error));
      return { ok: false, reason: "ERROR" };
    }
  }

  function wrapScope(original) {
    const wrapped = function hotPathPerfCareerScope() {
      priv.depth += 1;
      try {
        return original.apply(this, arguments);
      } finally {
        priv.depth -= 1;
      }
    };
    return markWrapped(wrapped, original);
  }

  function wantsGate(table, pth) {
    return priv.depth > 0 && !priv.disabledReason && table === TABLE && segmentCount(pth) === 0;
  }

  function arm() {
    priv.serveNext = true;
  }

  function disarm() {
    priv.serveNext = false;
  }

  function armedFor(table) {
    return priv.serveNext && table === TABLE;
  }

  function serve(original, thisArg, args) {
    priv.serveNext = false;
    let r;
    try {
      r = readSubset();
    } catch (error) {
      disable("error", String(error && error.message || error));
      return original.apply(thisArg, args);
    }
    if (!r.ok) {
      noteFallback(r.reason);
      return original.apply(thisArg, args);
    }
    if (config.careerAbyssalReadParityCheck === true) {
      const vendor = original.apply(thisArg, args);
      const w = priv.window;
      w.parityChecks += 1;
      let diff;
      try {
        diff = compareSubset(r.value, vendor);
        if (diff) {
          w.parityRetries += 1;
          const again = readSubset();
          if (!again.ok) {
            noteFallback(again.reason);
            return vendor;
          }
          diff = compareSubset(again.value, vendor);
          if (!diff) r = again;
        }
      } catch (error) {
        diff = `compareError=${String(error && error.message || error)}`;
      }
      if (diff) {
        disable("parity", diff);
        return vendor;
      }
    }
    priv.window.served += 1;
    return r.value;
  }

  function wrapGate(original) {
    return createCareerReadDispatch([api]).wrapGate(original);
  }

  function wrapServe(original) {
    return createCareerReadDispatch([api]).wrapServe(original);
  }

  function stateText() {
    if (priv.disabledReason) return `disabled:${priv.disabledReason}`;
    return priv.deps ? "ready" : "waiting";
  }

  function status() {
    return {
      enabled: priv.disabledReason === null,
      ready: priv.disabledReason === null && priv.deps !== null,
      disabledReason: priv.disabledReason,
      depth: priv.depth,
      serveNext: priv.serveNext,
      state: stateText(),
    };
  }

  function statsSnapshot() {
    const w = priv.window;
    return {
      ...status(),
      keys: priv.lastKeys,
      candidates: priv.lastCandidates,
      known: priv.classByKey.size,
      served: w.served,
      fallbackByReason: new Map(w.fallbackByReason),
      classified: w.classified,
      reclassified: w.reclassified,
      serveMaxMs: w.serveMaxMs,
      firstBuildMs: priv.firstBuildMs,
      parityChecks: w.parityChecks,
      parityRetries: w.parityRetries,
    };
  }

  function drainStatsLines() {
    const w = priv.window;
    const fallback = [...w.fallbackByReason].map(([reason, n]) => `${reason}:${n}`).join(",") || "0";
    const line = `stats careerAbyssalRead state=${stateText()} keys=${priv.lastKeys} candidates=${priv.lastCandidates} ` +
      `served=${w.served} fallback=${fallback} classified=${w.classified} reclassified=${w.reclassified} ` +
      `serveMaxMs=${w.serveMaxMs.toFixed(1)} firstBuildMs=${priv.firstBuildMs === null ? "-" : priv.firstBuildMs.toFixed(1)} ` +
      `parityChecks=${w.parityChecks} parityRetries=${w.parityRetries}`;
    priv.window = emptyWindow();
    return [line];
  }

  const api = {
    setDeps, wrapScope, wrapGate, wrapServe, readSubset,
    wantsGate, arm, disarm, armedFor, serve,
    disable, status, statsSnapshot, drainStatsLines,
  };
  return api;
}

module.exports = { createCareerAbyssalRead, compareSubset, segmentCount, TABLE, GROUP, ROW_KEY_SEP };
