"use strict";

const { performance } = require("node:perf_hooks");
const { REINFORCE_STATES, ANCHORING_STATE } = require("./schema");

const LAYER_ID = "layer-stations";
const LAYER_ORDER = 13;
const GALAXY_WORK_CLASS = "MAINTENANCE";
const METRIC_BUILD_MS = "observer.galaxyStationsMs";
const MS_DECIMALS = 10;
const SHAPE = "square";
const STATION_COLOUR = "#c8d0dc";
const STATION_STYLES = Object.freeze([
  Object.freeze({ styleId: "station", label: "faction station", colour: STATION_COLOUR }),
  Object.freeze({ styleId: "station-reinforced", label: "station in reinforce", colour: "#ff8c42" }),
  Object.freeze({ styleId: "station-anchoring", label: "station anchoring", colour: STATION_COLOUR, dash: "dashed" }),
]);
const LEGEND = Object.freeze(STATION_STYLES.map((s) => Object.freeze(s.dash
  ? [s.styleId, s.label, s.colour, SHAPE, null, s.dash] : [s.styleId, s.label, s.colour, SHAPE])));

function call(obj, name) {
  try {
    return obj && typeof obj[name] === "function" ? obj[name]() : undefined;
  } catch (_err) {
    return undefined;
  }
}

function buildStationsLayerView(deps) {
  const { store, repository, clock } = deps;
  const getGovernor = typeof deps.getGovernor === "function" ? deps.getGovernor : () => null;
  const telemetry = deps.telemetry || null;
  const nowMs = typeof deps.nowMs === "function" ? deps.nowMs : () => performance.now();
  const int = (v, min) => Math.max(min, Math.trunc(Number(v) || 0));
  const maxStations = int(deps.maxStations, 1);
  const maxSystems = int(deps.maxSystems, 0);
  const maxLines = int(deps.maxLines, 0);
  const refreshMs = int(deps.refreshMs, 1);
  const names = deps.factionNames instanceof Map ? deps.factionNames : new Map();

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

  function line(s, items) {
    const faction = names.get(s.ownerFactionId) || String(s.ownerFactionId);
    return `${s.name || s.stationId} · ${faction} · ${s.kind} · ${s.state} · ${items} items`;
  }

  function getData() {
    if (call(store, "isOpen") !== true) return { available: false, reason: "STORE_CLOSED" };
    if (!admitted()) return { available: false, reason: "GOVERNOR_HOLD" };
    const now = clock.now();
    const legend = LEGEND.map((l) => [...l]);
    if (maxSystems === 0) {
      return { available: true, key: keyAt(now), legend, items: [], note: "0 stations (layer limit 0)" };
    }
    const t0 = nowMs();
    const tx = store.transaction("observer.galaxyStations", (db) => {
      const live = repository.listLiveStations(db, { limit: maxStations });
      if (!live.ok) return live;
      const stock = repository.summarizeStock(db, { topLines: 0 });
      if (!stock.ok) return stock;
      return { ok: true, records: live.records, truncated: live.truncated, stock: stock.byStation };
    });
    const read = tx.ok ? tx.value : tx;
    if (!tx.ok || !read || !read.ok) return { available: false, reason: String((read && read.reason) || "TX_FAILED") };
    const bySystem = new Map();
    for (const s of read.records) {
      let sys = bySystem.get(s.systemId);
      if (!sys) {
        sys = { systemId: s.systemId, stations: [], perFaction: new Map(), reinforced: false, anchoring: false };
        bySystem.set(s.systemId, sys);
      }
      sys.stations.push(s);
      sys.perFaction.set(s.ownerFactionId, (sys.perFaction.get(s.ownerFactionId) || 0) + 1);
      if (REINFORCE_STATES.includes(s.state)) sys.reinforced = true;
      if (s.state === ANCHORING_STATE) sys.anchoring = true;
    }
    const built = [...bySystem.values()];
    built.sort((a, b) => b.stations.length - a.stations.length || a.systemId - b.systemId);
    const truncated = built.length > maxSystems;
    const items = built.slice(0, maxSystems).map((sys) => {
      const factions = [...sys.perFaction].sort((a, b) => b[1] - a[1] || a[0] - b[0]);
      const lines = sys.stations.slice(0, maxLines).map((s) => {
        const entry = read.stock.get(s.stationId);
        return line(s, entry ? entry.items : 0);
      });
      const more = sys.stations.length - Math.min(maxLines, sys.stations.length);
      if (more > 0) lines.push(`+${more} more`);
      const style = sys.reinforced ? "station-reinforced" : (sys.anchoring ? "station-anchoring" : "station");
      return [sys.systemId, style, factions.map((f) => f[1]).join("/"),
        lines, factions.map((f) => [f[0], f[1]])];
    });
    observe(nowMs() - t0);
    const note = `${read.records.length} stations in ${built.length} systems (label = stations per faction)`;
    return { available: true, key: keyAt(now), legend, items,
      note: truncated || read.truncated ? `${note} (truncated)` : note };
  }

  function cacheKey() {
    if (call(store, "isOpen") !== true || !admitted()) return null;
    return keyAt(clock.now());
  }

  return { title: "Faction stations", listed: false, mapLayer: { kind: "marks", order: LAYER_ORDER }, cacheKey,
    getData };
}

module.exports = { LAYER_ID, LEGEND, STATION_STYLES, buildStationsLayerView };
