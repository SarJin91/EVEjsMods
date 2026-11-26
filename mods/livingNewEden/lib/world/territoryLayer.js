"use strict";

const { performance } = require("node:perf_hooks");
const { readAllSystems } = require("./readAllSystems");
const { buildTerritoryAreas, SRC_SDE } = require("./territoryAreas");

const TERRITORY_WORK_CLASS = "MAINTENANCE";
const MS_DECIMALS = 10;
const STATIC_VIEW_ID = "galaxy-static";

const isId = (v) => Number.isSafeInteger(v) && v > 0;

function call(obj, name) {
  try {
    return obj && typeof obj[name] === "function" ? obj[name]() : undefined;
  } catch (_err) {
    return undefined;
  }
}

function buildTerritoryLayerView(deps) {
  const { store, repository, settings } = deps;
  const factionNames = deps.factionNames instanceof Map ? deps.factionNames : new Map();
  const getSeedStatus = typeof deps.getSeedStatus === "function" ? deps.getSeedStatus : () => null;
  const getGovernor = typeof deps.getGovernor === "function" ? deps.getGovernor : () => null;
  const getStaticView = typeof deps.getStaticView === "function" ? deps.getStaticView : () => null;
  const nowMs = typeof deps.nowMs === "function" ? deps.nowMs : () => performance.now();
  const telemetry = deps.telemetry || null;
  const opts = Object.freeze({ cellSize: settings.cellSize, radius: settings.radius, maxCells: settings.maxCells,
    maxStampOps: settings.maxStampOps, maxPoints: settings.maxPoints, maxCoarsenSteps: settings.maxCoarsenSteps,
    simplifyPercent: settings.simplifyPercent });
  const paramsKey = JSON.stringify([opts, settings.projectEmpireSpace === true]);
  let memo = null;

  function metric(kind, name, value) {
    if (!telemetry || typeof telemetry[kind] !== "function") return;
    try {
      telemetry[kind](name, value);
    } catch (_err) {
    }
  }

  const round = (ms) => Math.round(ms * MS_DECIMALS) / MS_DECIMALS;

  function admitted() {
    const governor = getGovernor();
    return !governor || typeof governor.admits !== "function" || governor.admits(TERRITORY_WORK_CLASS) !== false;
  }

  function staticKey() {
    let view;
    try {
      view = getStaticView();
    } catch (_err) {
      return null;
    }
    if (!view || typeof view.cacheKey !== "function") return null;
    try {
      const k = view.cacheKey();
      return k === undefined || k === null ? null : String(k);
    } catch (_err) {
      return null;
    }
  }

  function readyGraph() {
    const g = deps.graph;
    if (!g || typeof g.getGraph !== "function") return null;
    try {
      const res = g.getGraph();
      return res && res.ok === true ? res.graph : null;
    } catch (_err) {
      return null;
    }
  }

  function cacheKey() {
    if (call(store, "isOpen") !== true || !admitted()) return null;
    const sk = staticKey();
    if (sk === null) return null;
    const seed = getSeedStatus();
    return `${repository.getChangeCount()}|${seed ? seed.seq : "-"}|${sk}`;
  }

  function getData() {
    if (call(store, "isOpen") !== true) return { available: false, reason: "STORE_CLOSED" };
    if (!admitted()) {
      metric("count", "observer.galaxy.deferrals", 1);
      return { available: false, reason: "GOVERNOR_HOLD" };
    }
    const t0 = nowMs();
    const sk = staticKey();
    let stat = null;
    try {
      const view = sk === null ? null : getStaticView();
      stat = view ? view.getData() : null;
    } catch (_err) {
      stat = null;
    }
    if (sk === null || !stat || stat.available !== true || !stat.systems || !Array.isArray(stat.systems.id)) {
      return { available: false, reason: "STATIC_UNAVAILABLE" };
    }
    const seed = getSeedStatus();
    const key = `${repository.getChangeCount()}|${seed ? seed.seq : "-"}|${sk}`;
    const tx = readAllSystems(store, repository, { label: "observer.galaxyTerritory",
      maxListLimit: settings.maxListLimit, includeInfluence: false });
    const read = tx.ok ? tx.value : tx;
    if (!tx.ok || !read || !read.ok) {
      return { available: false, reason: String((read && read.reason) || "TX_FAILED"),
        detail: (read && read.detail) || null };
    }
    const rows = new Map();
    for (const s of read.systems) rows.set(s.systemId, s.controllerFactionId);
    const graph = settings.projectEmpireSpace === true ? readyGraph() : null;
    const ids = stat.systems.id;
    const owners = new Array(ids.length);
    const sig = [];
    for (let i = 0; i < ids.length; i += 1) {
      const id = ids[i];
      let owner;
      if (rows.has(id)) {
        const c = rows.get(id);
        owner = { factionId: isId(c) ? c : null, source: "world" };
      } else {
        const vertex = graph ? graph.getSystem(id) : null;
        owner = { factionId: vertex && isId(vertex.factionId) ? vertex.factionId : null, source: SRC_SDE };
      }
      owners[i] = owner;
      if (owner.factionId !== null) sig.push(`${id}:${owner.factionId}:${owner.source === SRC_SDE ? 1 : 0}`);
    }
    const signature = sig.join(",");
    let built;
    if (memo && memo.staticKey === sk && memo.paramsKey === paramsKey && memo.signature === signature) {
      metric("count", "observer.galaxyTerritoryMemoHits", 1);
      built = memo.built;
    } else {
      const b0 = nowMs();
      built = buildTerritoryAreas({ systems: stat.systems, grid: stat.grid || { width: 0, height: 0 },
        ownerOf: (i) => owners[i], opts });
      metric("observe", "observer.galaxyTerritoryBuildMs", round(nowMs() - b0));
      memo = { staticKey: sk, paramsKey, signature, built };
    }
    metric("observe", "observer.galaxyTerritoryMs", round(nowMs() - t0));
    if (!built.ok) {
      return { available: false, reason: built.reason, detail: built.detail || null };
    }
    const present = new Set();
    const areas = built.areas.map((a) => {
      present.add(a.factionId);
      return [a.factionId, a.source === SRC_SDE ? 1 : 0, a.systems, a.rings];
    });
    const names = [...present].sort((a, b) => a - b).map((id) => [id, factionNames.get(id) || null]);
    return { available: true, key, cellSize: built.cellSize, radius: built.radius, areas, names,
      stats: { ...built.stats } };
  }

  return {
    title: "Faction territory",
    listed: false,
    mapLayer: { kind: "areas", order: 5 },
    cacheKey,
    getData,
    reset() {
      memo = null;
    },
  };
}

module.exports = { STATIC_VIEW_ID, buildTerritoryLayerView };
