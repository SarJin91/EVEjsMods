"use strict";

const { performance } = require("node:perf_hooks");

const LAYER_ID = "layer-front";
const LAYER_ORDER = 11;
const GALAXY_WORK_CLASS = "MAINTENANCE";
const METRIC_BUILD_MS = "observer.galaxyFrontMs";
const MS_DECIMALS = 10;
const SHAPE = "square";

const STATE_STYLES = Object.freeze([
  Object.freeze({ state: "RECON", styleId: "front-recon", label: "REC", colour: "#ffff00", dash: "dotted" }),
  Object.freeze({ state: "CONTESTED", styleId: "front-contested", label: "CON", colour: "#ff8000", dash: "dashed" }),
  Object.freeze({ state: "INVASION", styleId: "front-invasion", label: "INV", colour: "#ff0000", dash: "dashed" }),
  Object.freeze({ state: "OCCUPIED", styleId: "front-occupied", label: "OCC", colour: "#8000ff", dash: "solid" }),
  Object.freeze({ state: "CONSOLIDATING", styleId: "front-consolidating", label: "CSL", colour: "#0080ff", dash: "dashdot" }),
]);
const LEGEND = Object.freeze(STATE_STYLES.map((s) => Object.freeze([
  s.styleId, s.label, s.colour, SHAPE, null, s.dash
])));

function call(obj, name) {
  try {
    return obj && typeof obj[name] === "function" ? obj[name]() : undefined;
  } catch (_err) {
    return undefined;
  }
}

function iso(ms) {
  if (!Number.isSafeInteger(ms) || ms <= 0) return null;
  return new Date(ms).toISOString();
}

function buildFrontLayerView(deps) {
  const { store, repository, clock } = deps;
  const getGovernor = typeof deps.getGovernor === "function" ? deps.getGovernor : () => null;
  const telemetry = deps.telemetry || null;
  const nowMs = typeof deps.nowMs === "function" ? deps.nowMs : () => performance.now();
  const getStatus = typeof deps.getStatus === "function" ? deps.getStatus : () => ({});
  const int = (v, min) => Math.max(min, Math.trunc(Number(v) || 0));
  const maxSystems = int(deps.maxSystems, 0);
  const maxLines = int(deps.maxLines, 0);
  const refreshMs = int(deps.refreshMs, 1);

  function admitted() {
    try {
      const governor = getGovernor();
      return !governor || typeof governor.admits !== "function" || governor.admits(GALAXY_WORK_CLASS) !== false;
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

  function observe(ms) {
    if (!telemetry || typeof telemetry.observe !== "function") return;
    try {
      telemetry.observe(METRIC_BUILD_MS, Math.round(ms * MS_DECIMALS) / MS_DECIMALS);
    } catch (_err) {
    }
  }

  const keyAt = (now) => `k${Math.floor(now / refreshMs)}`;

  function getData() {
    if (call(store, "isOpen") !== true) return { available: false, reason: "STORE_CLOSED" };
    if (!admitted()) return { available: false, reason: "GOVERNOR_HOLD" };
    if (stopped()) return { available: false, reason: "OCCUPATION_STOPPED" };
    const now = clock.now();
    const legend = LEGEND.map((l) => [...l]);
    if (maxSystems === 0) {
      return { available: true, key: keyAt(now), legend, items: [], note: "0 front systems (layer limit 0)" };
    }
    const t0 = nowMs();
    const tx = store.transaction("observer.galaxyFront", (db) => {
      const active = repository.listActiveOccupations(db, { limit: maxSystems });
      if (!active.ok) return active;
      return { ok: true, systems: active.systems, truncated: active.nextAfterSystemId !== null };
    });
    const read = tx.ok ? tx.value : tx;
    if (!tx.ok || !read || !read.ok) return { available: false, reason: String((read && read.reason) || "TX_FAILED") };

    const items = read.systems.map((sys) => {
      const state = sys.occupationState;
      const style = STATE_STYLES.find((s) => s.state === state) || STATE_STYLES[0];
      const styleId = style.styleId;
      const label = style.label;
      const lines = [
        `${state} since ${iso(sys.lastStateChangeAt)}`,
        sys.phaseDueAt !== null ? `due ${iso(sys.phaseDueAt)}` : null,
      ].filter((l) => l !== null).slice(0, maxLines);
      const factions = [];
      if (sys.occupierFactionId !== null) factions.push([sys.occupierFactionId, 1]);
      if (sys.controllerFactionId !== null) factions.push([sys.controllerFactionId, 1]);
      return [sys.systemId, styleId, label, lines, factions];
    });

    observe(nowMs() - t0);
    const note = `${read.systems.length} front system(s)` + (read.truncated ? " (truncated)" : "");
    return { available: true, key: keyAt(now), legend, items, note };
  }

  function cacheKey() {
    if (call(store, "isOpen") !== true || !admitted() || stopped()) return null;
    return keyAt(clock.now());
  }

  return { title: "Front", listed: false, mapLayer: { kind: "marks", order: LAYER_ORDER }, cacheKey, getData };
}

module.exports = { LAYER_ID, LEGEND, STATE_STYLES, buildFrontLayerView };