"use strict";

const { markWrapped } = require("./careerReadDispatch");
const { segmentCount } = require("./careerAbyssalRead");

const TABLE = "items";
const KEY = "__evejsCareerCombatOutcomes";
const ROW_KEY_SEP = "\u001f";
const DETAIL_MAX = 200;

function defaultNow() {
  return process.hrtime.bigint();
}

function fit(text) {
  const s = String(text);
  return s.length > DETAIL_MAX ? s.slice(0, DETAIL_MAX) : s;
}

function compareLedger(ours, vendor) {
  if (!vendor || typeof vendor !== "object") return "vendorNotObject";
  if (!ours || typeof ours !== "object") return "oursNotObject";
  const a = JSON.stringify(ours[KEY]);
  const b = JSON.stringify(vendor[KEY]);
  if (a === b) return null;
  const oa = ours[KEY] && typeof ours[KEY] === "object" ? Object.keys(ours[KEY]).length : -1;
  const ob = vendor[KEY] && typeof vendor[KEY] === "object" ? Object.keys(vendor[KEY]).length : -1;
  return fit(`ledger ours=${oa} vendor=${ob}`);
}

function emptyWindow() {
  return { served: 0, fallbackByReason: new Map(), serveMaxMs: 0, parityChecks: 0, parityRetries: 0 };
}

function createCareerCombatItemsRead(options) {
  const config = options.config;
  const log = options.log;
  const now = options.now || defaultNow;
  const openRowSource = options.openRowSource || require("./sqliteRowSource").openRowSource;
  const priv = {
    deps: null,
    depsFilename: null,
    disabledReason: null,
    depth: 0,
    serveNext: false,
    rowSource: null,
    lastRows: 0,
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
    log(`WARN careerCombatItemsRead disabled: ${reason}${detail ? ` (${fit(detail)})` : ""}`);
  }

  function setDeps(sqliteStoreExports, sqliteStoreFilename) {
    if (priv.deps) return true;
    if (priv.disabledReason) return false;
    const m = sqliteStoreExports;
    if (!m || typeof m !== "object") return false;
    if (typeof m.getDatabasePath !== "function" || typeof m.assembleFromRows !== "function" ||
        typeof sqliteStoreFilename !== "string" || sqliteStoreFilename === "") {
      return false;
    }
    if (m.ROW_KEY_SEP !== ROW_KEY_SEP) {
      disable("drift", `ROW_KEY_SEP=${JSON.stringify(m.ROW_KEY_SEP)}`);
      return false;
    }
    priv.deps = {
      getDatabasePath: () => m.getDatabasePath(),
      assembleFromRows: (table, rows) => m.assembleFromRows(table, rows),
    };
    priv.depsFilename = sqliteStoreFilename;
    return true;
  }

  function build(tx) {
    if (!tx.tableExists()) return { ok: false, reason: "NO_TABLE" };
    const rows = {};
    let count = 0;
    for (const row of tx.readEntry(KEY)) {
      rows[row.key] = JSON.parse(row.json);
      count += 1;
    }
    return { ok: true, value: priv.deps.assembleFromRows(TABLE, rows), rows: count };
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
          busyTimeoutMs: config.careerCombatItemsReadBusyTimeoutMs,
          table: TABLE,
        });
      } else if (priv.rowSource.dbPath !== dbPath) {
        return { ok: false, reason: "NO_DEPS" };
      }
      const started = now();
      const r = priv.rowSource.readSnapshot(build);
      if (!r.ok) return r;
      const ms = elapsedMs(started);
      if (ms > priv.window.serveMaxMs) priv.window.serveMaxMs = ms;
      priv.lastRows = r.rows;
      return { ok: true, value: r.value };
    } catch (error) {
      disable("error", String(error && error.message || error));
      return { ok: false, reason: "ERROR" };
    }
  }

  function wrapScope(original) {
    const wrapped = function hotPathPerfCareerCombatScope() {
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
    if (config.careerCombatItemsReadParityCheck === true) {
      const vendor = original.apply(thisArg, args);
      const w = priv.window;
      w.parityChecks += 1;
      let diff;
      try {
        diff = compareLedger(r.value, vendor);
        if (diff) {
          w.parityRetries += 1;
          const again = readSubset();
          if (!again.ok) {
            noteFallback(again.reason);
            return vendor;
          }
          diff = compareLedger(again.value, vendor);
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
      rows: priv.lastRows,
      served: w.served,
      fallbackByReason: new Map(w.fallbackByReason),
      serveMaxMs: w.serveMaxMs,
      parityChecks: w.parityChecks,
      parityRetries: w.parityRetries,
    };
  }

  function drainStatsLines() {
    const w = priv.window;
    const fallback = [...w.fallbackByReason].map(([reason, n]) => `${reason}:${n}`).join(",") || "0";
    const line = `stats careerCombatItemsRead state=${stateText()} rows=${priv.lastRows} served=${w.served} ` +
      `fallback=${fallback} serveMaxMs=${w.serveMaxMs.toFixed(1)} parityChecks=${w.parityChecks} parityRetries=${w.parityRetries}`;
    priv.window = emptyWindow();
    return [line];
  }

  return {
    setDeps, wrapScope, readSubset,
    wantsGate, arm, disarm, armedFor, serve,
    disable, status, statsSnapshot, drainStatsLines,
  };
}

module.exports = { createCareerCombatItemsRead, compareLedger, TABLE, KEY, ROW_KEY_SEP };
