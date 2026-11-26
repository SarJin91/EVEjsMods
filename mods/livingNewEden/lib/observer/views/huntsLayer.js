"use strict";

const { performance } = require("node:perf_hooks");

const LAYER_ID = "layer-hunts";
const LAYER_ORDER = 18;
const MARK_KIND = "marks";
const MARK_SHAPE = "versus";
const GALAXY_WORK_CLASS = "MAINTENANCE";
const METRIC_BUILD_MS = "observer.galaxyHuntsMs";
const METRIC_SYSTEMS = "observer.galaxyHuntsSystems";
const METRIC_FACTIONS = "observer.galaxyHuntsFactions";
const MS_DECIMALS = 10;
const STATIC_VIEW_ID = "galaxy-static";

function call(obj, name) {
  try {
    return obj && typeof obj[name] === "function" ? obj[name]() : undefined;
  } catch (_err) {
    return undefined;
  }
}

function formatRelativeTime(ms, now) {
  try {
    const diff = ms - now;
    if (diff <= 0) return "expired";
    if (diff < 60000) return `${Math.ceil(diff / 1000)}s`;
    if (diff < 3600000) return `${Math.ceil(diff / 60000)}m`;
    return `${Math.ceil(diff / 3600000)}h`;
  } catch (_err) {
    return String(ms);
  }
}

function buildHuntsLayerView(deps) {
  const { store, repository, getStaticView, config, factionNames, getGovernor, telemetry, clock, nowMs, settings } = deps;

  const int = (v, min) => Math.max(min, Math.trunc(Number(v) || 0));
  const maxSystems = int(settings.maxSystems, 0);
  const refreshMs = int(settings.refreshMs, 1);

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
      return { available: true, key, legend: [], items: [], names: [], cellSize: 0, stats: { systems: 0, factions: 0 }, details: [] };
    }

    const t0 = nowMs();
    const now = clock.now();
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
      SELECT
        whp.pin_id,
        whp.hunter_fleet_id,
        whp.system_id,
        whp.target_fleet_id,
        whp.target_kind,
        whp.target_faction_id,
        whp.faction_id AS hunter_faction_id,
        whp.pinned_at,
        whp.until_at,
        whp.state,
        whp.outcome,
        vf.fleet_role as hunter_role,
        vf.faction_id as hunter_faction_id_check
      FROM world_hunt_pins whp
      LEFT JOIN virtual_fleets vf ON vf.fleet_id = whp.hunter_fleet_id
      WHERE whp.state = 'ACTIVE' AND whp.until_at > ?
      ORDER BY whp.system_id, whp.pin_id
      LIMIT ?
    `;

    const tx = store.transaction("observer.galaxyHunts", (db) => {
      const stmt = db.prepare(sql);
      return stmt.all(now, maxSystems);
    });

    if (!tx.ok) {
      return { available: false, reason: String((tx.reason) || "TX_FAILED"), detail: tx.detail || null };
    }

    const rows = tx.value || [];
    if (!Array.isArray(rows)) {
      return { available: true, key: cacheKey(), legend: [], items: [], names: [], cellSize: 0, stats: { systems: 0, factions: 0 }, details: [] };
    }

    const STYLE_HUNTER = "hunter";
    const STYLE_PIN = "huntPin";

    const bySystem = new Map();
    const presentFactions = new Set();
    const details = [];

    for (const row of rows) {
      const systemId = Number(row.system_id);
      const pos = systemPos.get(systemId);
      if (!pos) continue;

      const hunterFactionId = Number(row.hunter_faction_id);
      const targetFactionId = row.target_faction_id ? Number(row.target_faction_id) : null;

      if (hunterFactionId > 0) {
        presentFactions.add(hunterFactionId);
        if (!bySystem.has(systemId)) bySystem.set(systemId, { hunter: null, pin: null });
        bySystem.get(systemId).hunter = {
          factionId: hunterFactionId,
          fleetId: row.hunter_fleet_id,
        };
      }

      if (targetFactionId !== null && targetFactionId > 0) {
        presentFactions.add(targetFactionId);
        if (!bySystem.has(systemId)) bySystem.set(systemId, { hunter: null, pin: null });
        bySystem.get(systemId).pin = {
          factionId: targetFactionId,
          pinId: row.pin_id,
          targetFleetId: row.target_fleet_id,
          untilAt: Number(row.until_at),
        };
      }

      const hunterName = factionNames.get(hunterFactionId) || `faction ${hunterFactionId}`;
      const targetName = targetFactionId ? (factionNames.get(targetFactionId) || `faction ${targetFactionId}`) : "unknown";
      const untilStr = row.until_at ? formatRelativeTime(Number(row.until_at), now) : "-";
      const lines = [
        `System: ${systemId}`,
        `Hunter: ${hunterName}`,
        `Hunter Fleet: ${row.hunter_fleet_id || "-"}`,
        `Target: ${targetName}`,
        `Target Fleet: ${row.target_fleet_id || "-"}`,
        `Pin ID: ${row.pin_id}`,
        `Expires: ${untilStr}`,
        `State: ${row.state}`,
      ];
      details.push([systemId, lines]);
    }

    const items = [];
    for (const [systemId, data] of bySystem) {
      const pos = systemPos.get(systemId);
      if (!pos) continue;

      const hunter = data.hunter;
      const pin = data.pin;

      if (hunter && pin) {
        items.push([
          systemId,
          STYLE_PIN,
          `Pin: ${pin.pinId}`,
          details.find(d => d[0] === systemId)?.[1] || [],
          [[hunter.factionId, 1], [pin.factionId, 1]]
        ]);
      } else if (hunter) {
        items.push([
          systemId,
          STYLE_HUNTER,
          `Hunter: ${hunter.fleetId}`,
          details.find(d => d[0] === systemId)?.[1] || [],
          [[hunter.factionId, 1]]
        ]);
      } else if (pin) {
        items.push([
          systemId,
          STYLE_PIN,
          `Pin: ${pin.pinId}`,
          details.find(d => d[0] === systemId)?.[1] || [],
          [[pin.factionId, 1]]
        ]);
      }
    }

    const legend = [
      [STYLE_HUNTER, "Hunter", "#00ff00", "triangle", 1, null],
      [STYLE_PIN, "Hunt Pin", "#ff0000", "versus", 1, null],
    ];

    const names = [...presentFactions].sort((a, b) => a - b).map((id) => [id, factionNames.get(id) || null]);

    const key = cacheKey();
    observe(nowMs() - t0);
    count(METRIC_SYSTEMS, bySystem.size);
    count(METRIC_FACTIONS, presentFactions.size);

    return {
      available: true,
      key,
      legend,
      items,
      names,
      cellSize: 100,
      stats: { systems: bySystem.size, factions: presentFactions.size },
      details,
    };
  }

  return {
    title: "Hunters & Pins",
    listed: false,
    mapLayer: { kind: MARK_KIND, order: LAYER_ORDER, shape: MARK_SHAPE },
    cacheKey,
    getData,
  };
}

module.exports = { LAYER_ID, LAYER_ORDER, MARK_KIND, buildHuntsLayerView };