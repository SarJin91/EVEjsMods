"use strict";

const { performance } = require("node:perf_hooks");
const { progressToJson } = require("./progress");

const LAYER_ID = "layer-progress";
const LAYER_ORDER = 21;
const WORK_CLASS = "MAINTENANCE";
const METRIC_BUILD_MS = "observer.galaxyProgressMs";
const METRIC_DEFERRALS = "observer.galaxyProgress.deferrals";
const MS_DECIMALS = 10;

function call(obj, name) {
  try {
    return obj && typeof obj[name] === "function" ? obj[name]() : undefined;
  } catch (_err) {
    return undefined;
  }
}

function buildProgressLayerView(deps) {
  const { store, repository, readProgressInTx, clock } = deps;
  const getGovernor = typeof deps.getGovernor === "function" ? deps.getGovernor : () => null;
  const telemetry = deps.telemetry || null;
  const nowMs = typeof deps.nowMs === "function" ? deps.nowMs : () => performance.now();
  const getStatus = typeof deps.getStatus === "function" ? deps.getStatus : () => ({});
  const int = (v, min) => Math.max(min, Math.trunc(Number(v) || 0));
  const maxSystems = int(deps.maxSystems, 0);
  const maxDrawn = int(deps.maxDrawn, 0);
  const refreshMs = int(deps.refreshMs, 1);

  function admitted() {
    try {
      const governor = getGovernor();
      return !governor || typeof governor.admits !== "function" || governor.admits(WORK_CLASS) !== false;
    } catch (_err) {
      return true;
    }
  }

  function stopped() {
    try {
      const status = getStatus();
      return status && status.state === "stopped";
    } catch (_err) {
      return false;
    }
  }

  function metric(kind, name, value) {
    if (!telemetry || typeof telemetry[kind] !== "function") return;
    try {
      telemetry[kind](name, value);
    } catch (_err) {
    }
  }

  const keyAt = (now) => `p${Math.floor(now / refreshMs)}`;

  function getData() {
    if (call(store, "isOpen") !== true) return { available: false, reason: "STORE_CLOSED" };
    if (!admitted()) {
      metric("count", METRIC_DEFERRALS, 1);
      return { available: false, reason: "GOVERNOR_HOLD" };
    }
    if (stopped()) return { available: false, reason: "OCCUPATION_STOPPED" };
    const now = clock.now();
    if (maxSystems === 0) {
      return { available: true, key: keyAt(now), legend: [], maxDrawn, items: [],
        note: "0 systems (layer limit 0)" };
    }
    const t0 = nowMs();
    const tx = store.transaction("observer.galaxyProgress", (db) => {
      const active = repository.listActiveOccupations(db, { limit: maxSystems, includeInfluence: false });
      if (!active.ok) return active;
      const memo = new Map();
      const items = [];
      let skipped = 0;
      for (const sys of active.systems) {
        const r = readProgressInTx(db, sys.systemId, now, memo);
        const p = r && r.ok ? progressToJson(r.progress) : null;
        if (!p) {
          skipped += 1;
          continue;
        }
        items.push({ systemId: sys.systemId, attacker: p.attacker, defender: p.defender, state: p.state,
          ratio: p.ratio, status: p.status, etaMs: p.etaMs, fallback: p.fallback, blockers: p.blockers });
      }
      return { ok: true, items, skipped, truncated: active.nextAfterSystemId !== null };
    });
    const read = tx.ok ? tx.value : tx;
    if (!tx.ok || !read || !read.ok) return { available: false, reason: String((read && read.reason) || "TX_FAILED") };
    metric("observe", METRIC_BUILD_MS, Math.round((nowMs() - t0) * MS_DECIMALS) / MS_DECIMALS);
    const note = `${read.items.length} system(s)` + (read.truncated ? " (truncated)" : "")
      + (read.skipped > 0 ? `, ${read.skipped} skipped` : "");
    return { available: true, key: keyAt(now), legend: [], maxDrawn, items: read.items, note };
  }

  function cacheKey() {
    if (call(store, "isOpen") !== true || !admitted() || stopped()) return null;
    return keyAt(clock.now());
  }

  return { title: "Takeover progress", listed: false, mapLayer: { kind: "bars", order: LAYER_ORDER }, cacheKey, getData };
}

module.exports = { LAYER_ID, buildProgressLayerView };
