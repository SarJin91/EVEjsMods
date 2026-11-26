"use strict";

const { performance } = require("node:perf_hooks");

const LAYER_ID = "layer-sov-projection";
const LAYER_ORDER = 6;
const GALAXY_WORK_CLASS = "MAINTENANCE";
const METRIC_BUILD_MS = "observer.galaxySovProjectionMs";
const METRIC_SYSTEMS = "observer.galaxySovProjectionSystems";
const METRIC_FACTIONS = "observer.galaxySovProjectionFactions";
const MS_DECIMALS = 10;
const STATIC_VIEW_ID = "galaxy-static";
const DISK_POINTS = 16;

function call(obj, name) {
  try {
    return obj && typeof obj[name] === "function" ? obj[name]() : undefined;
  } catch (_err) {
    return undefined;
  }
}

function buildDiskRing(x, y, radius) {
  const ring = new Array(DISK_POINTS * 2);
  for (let i = 0; i < DISK_POINTS; i += 1) {
    const angle = (i * 2 * Math.PI) / DISK_POINTS;
    ring[2 * i] = x + radius * Math.cos(angle);
    ring[2 * i + 1] = y + radius * Math.sin(angle);
  }
  return ring;
}

function formatLocalTime(ms) {
  try {
    return new Date(ms).toLocaleString();
  } catch (_err) {
    return String(ms);
  }
}

function buildSovProjectionLayerView(deps) {
  const { store, repository, getStaticView, config, factionNames, getGovernor, telemetry, clock, nowMs, settings } = deps;

  const int = (v, min) => Math.max(min, Math.trunc(Number(v) || 0));
  const maxSystems = int(settings.maxSystems, 0);
  const refreshMs = int(settings.refreshMs, 1);
  const radius = int(settings.radius, 50);

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

  function count(name, n) {
    if (!telemetry || typeof telemetry.count !== "function") return;
    try {
      telemetry.count(name, n);
    } catch (_err) {
    }
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

  function staticData() {
    const sk = staticKey();
    if (sk === null) return null;
    let view;
    try {
      view = getStaticView();
    } catch (_err) {
      return null;
    }
    if (!view || typeof view.getData !== "function") return null;
    try {
      const data = view.getData();
      if (!data || data.available !== true || !data.systems || !Array.isArray(data.systems.id)) return null;
      return data;
    } catch (_err) {
      return null;
    }
  }

  function cacheKey() {
    if (call(store, "isOpen") !== true || !admitted()) return null;
    const sk = staticKey();
    if (sk === null) return null;
    return `k${Math.floor(clock.now() / refreshMs)}|${sk}`;
  }

  function getData() {
    if (call(store, "isOpen") !== true) return { available: false, reason: "STORE_CLOSED" };
    if (!admitted()) {
      count("observer.galaxy.deferrals", 1);
      return { available: false, reason: "GOVERNOR_HOLD" };
    }
    if (maxSystems === 0) {
      const key = cacheKey();
      return { available: true, key, areas: [], names: [], cellSize: radius * 2, radius, stats: { systems: 0, factions: 0 }, details: [] };
    }

    const t0 = nowMs();
    const staticView = staticData();
    if (!staticView) {
      return { available: false, reason: "STATIC_UNAVAILABLE" };
    }

    const ids = staticView.systems.id;
    const xs = staticView.systems.x;
    const ys = staticView.systems.y;
    const systemPos = new Map();
    for (let i = 0; i < ids.length; i += 1) {
      systemPos.set(ids[i], { x: xs[i], y: ys[i] });
    }

    const sql = `
      SELECT wsl.system_id, wsl.last_controller, wsl.last_alliance, wsl.last_corp, wsl.last_action, wsl.last_seq, wsl.updated_at,
             wss.security_class
      FROM world_sov_projection_log wsl
      JOIN world_system_state wss ON wss.system_id = wsl.system_id
      WHERE wsl.last_alliance IS NOT NULL
      ORDER BY wsl.system_id
      LIMIT ?
    `;

    const tx = store.transaction("observer.galaxySovProjection", (db) => {
      const stmt = db.prepare(sql);
      return stmt.all(maxSystems);
    });

    if (!tx.ok) {
      return { available: false, reason: String((tx.reason) || "TX_FAILED"), detail: tx.detail || null };
    }

    const rows = tx.value || [];
    if (!Array.isArray(rows)) {
      return { available: true, key: cacheKey(), areas: [], names: [], cellSize: radius * 2, radius, stats: { systems: 0, factions: 0 }, details: [] };
    }

    const byFaction = new Map();
    const details = [];
    let totalSystems = 0;
    for (const row of rows) {
      const controller = row.last_controller === null ? null : Number(row.last_controller);
      if (controller === null) continue;
      const systemId = Number(row.system_id);
      const pos = systemPos.get(systemId);
      if (!pos) continue;

      const ring = buildDiskRing(pos.x, pos.y, radius);

      let entry = byFaction.get(controller);
      if (!entry) {
        entry = { systems: [], rings: [] };
        byFaction.set(controller, entry);
      }
      entry.systems.push(systemId);
      entry.rings.push(ring);
      totalSystems += 1;

      const allianceId = row.last_alliance ? Number(row.last_alliance) : null;
      const ticker = row.last_alliance && row.last_alliance > 0 ? `[${allianceId}]` : "-";
      const phaseSeq = row.last_seq !== null && row.last_seq !== undefined ? String(row.last_seq) : "-";
      const lastAction = row.last_action || "-";
      const updatedAt = row.updated_at ? formatLocalTime(Number(row.updated_at)) : "-";
      const lines = [
        `System: ${systemId}`,
        `Controller: ${factionNames.get(controller) || `faction ${controller}`}`,
        `Alliance: ${ticker} ${allianceId !== null ? allianceId : ""}`.trim(),
        `Phase: ${phaseSeq}`,
        `Action: ${lastAction}`,
        `Updated: ${updatedAt}`
      ];
      details.push([systemId, lines]);
    }

    const areas = [];
    const presentFactions = new Set();
    for (const [factionId, entry] of byFaction) {
      presentFactions.add(factionId);
      areas.push([factionId, 0, entry.systems, entry.rings]);
    }

    const names = [...presentFactions].sort((a, b) => a - b).map((id) => [id, factionNames.get(id) || null]);

    const key = cacheKey();
    observe(nowMs() - t0);
    count(METRIC_SYSTEMS, totalSystems);
    count(METRIC_FACTIONS, presentFactions.size);

    return {
      available: true,
      key,
      areas,
      names,
      cellSize: radius * 2,
      radius,
      stats: { systems: totalSystems, factions: presentFactions.size },
      details
    };
  }

  return {
    title: "Sovereignty projection",
    listed: false,
    mapLayer: { kind: "areas", order: LAYER_ORDER },
    cacheKey,
    getData
  };
}

module.exports = { LAYER_ID, LAYER_ORDER, buildSovProjectionLayerView };