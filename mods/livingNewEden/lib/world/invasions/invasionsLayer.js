"use strict";

const { performance } = require("node:perf_hooks");
const { tagOf } = require("./data/invaderProfiles");

const LAYER_ID = "layer-invasions";
const LAYER_ORDER = 16;
const GALAXY_WORK_CLASS = "MAINTENANCE";
const METRIC_BUILD_MS = "observer.galaxyInvasionsMs";
const MS_DECIMALS = 10;
const SHAPE = "hexagon";
const BEACHHEAD_COLOUR = "#c040ff";

const INVASION_STYLES = Object.freeze([
  Object.freeze({ styleId: "beachhead", label: "invasion beachhead", colour: BEACHHEAD_COLOUR }),
  Object.freeze({ styleId: "beachhead-withdrawing", label: "beachhead withdrawing", colour: BEACHHEAD_COLOUR, dash: "dashed" }),
]);
const LEGEND = Object.freeze(INVASION_STYLES.map((s) => Object.freeze(s.dash
  ? [s.styleId, s.label, s.colour, SHAPE, null, s.dash] : [s.styleId, s.label, s.colour, SHAPE])));

function call(obj, name) {
  try {
    return obj && typeof obj[name] === "function" ? obj[name]() : undefined;
  } catch (_err) {
    return undefined;
  }
}

function fleetCountOf(json) {
  try {
    const ids = JSON.parse(json || "[]");
    return Array.isArray(ids) ? ids.length : 0;
  } catch (_err) {
    return 0;
  }
}

function iso(ms) {
  if (!Number.isSafeInteger(ms) || ms <= 0) return null;
  return new Date(ms).toISOString();
}

function buildInvasionsLayerView(deps) {
  const { store, repository, clock } = deps;
  const getGovernor = typeof deps.getGovernor === "function" ? deps.getGovernor : () => null;
  const telemetry = deps.telemetry || null;
  const nowMs = typeof deps.nowMs === "function" ? deps.nowMs : () => performance.now();
  const getStatus = typeof deps.getStatus === "function" ? deps.getStatus : () => ({});
  const effectiveWithdrawAt = typeof deps.effectiveWithdrawAt === "function" ? deps.effectiveWithdrawAt : (row) => row.withdraw_at;
  function withdrawLine(inv) {
    const w = effectiveWithdrawAt(inv);
    return w ? `withdraw ${iso(w)}` : null;
  }
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
    const now = clock.now();
    const legend = LEGEND.map((l) => [...l]);
    if (maxSystems === 0) {
      return { available: true, key: keyAt(now), legend, items: [], note: "0 invasions (layer limit 0)" };
    }
    const t0 = nowMs();
    const tx = store.transaction("observer.galaxyInvasions", (db) => {
      const open = repository.listOpen(db, { limit: maxSystems });
      if (!open.ok) return open;
      return { ok: true, invasions: open.invasions, truncated: open.truncated };
    });
    const read = tx.ok ? tx.value : tx;
    if (!tx.ok || !read || !read.ok) return { available: false, reason: String((read && read.reason) || "TX_FAILED") };

    const status = getStatus();
    const lastDecision = status.lastDecision || null;

    const items = read.invasions.map((inv) => {
      const isWithdrawing = inv.state === "WITHDRAWING";
      const styleId = isWithdrawing ? "beachhead-withdrawing" : "beachhead";
      const tag = tagOf(inv.profile_id);
      const lines = [
        tag,
        `state since ${iso(inv.started_at)}`,
        withdrawLine(inv),
        `fleets ${fleetCountOf(inv.fleet_ids_json)}`,
      ].filter((l) => l !== null).slice(0, maxLines);
      const factions = [[inv.faction_id, 1]];
      return [inv.beachhead_system_id, styleId, tag, lines, factions];
    });

    observe(nowMs() - t0);
    const note = `${read.invasions.length} open invasion(s)` + (read.truncated ? " (truncated)" : "");
    return { available: true, key: keyAt(now), legend, items, note };
  }

  function cacheKey() {
    if (call(store, "isOpen") !== true || !admitted()) return null;
    return keyAt(clock.now());
  }

  return { title: "Invasions", listed: false, mapLayer: { kind: "marks", order: LAYER_ORDER }, cacheKey, getData };
}

module.exports = { LAYER_ID, LEGEND, INVASION_STYLES, buildInvasionsLayerView };