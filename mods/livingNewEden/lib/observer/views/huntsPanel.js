"use strict";

const { performance } = require("node:perf_hooks");

const PANEL_ID = "hunts";
const GALAXY_WORK_CLASS = "MAINTENANCE";
const METRIC_BUILD_MS = "observer.huntsPanelMs";
const METRIC_ROWS = "observer.huntsPanelRows";
const MS_DECIMALS = 10;

function call(obj, name) {
  try {
    return obj && typeof obj[name] === "function" ? obj[name]() : undefined;
  } catch (_err) {
    return undefined;
  }
}

function formatLocalTime(ms) {
  try {
    return new Date(ms).toLocaleString();
  } catch (_err) {
    return String(ms);
  }
}

function buildHuntsPanelView(deps) {
  const { store, repository, config, factionNames, getGovernor, telemetry, clock, nowMs, settings } = deps;

  const int = (v, min) => Math.max(min, Math.trunc(Number(v) || 0));
  const maxRows = int(settings.maxRows, 0);
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
    } catch (_err) {}
  }

  function count(name, n) {
    if (!telemetry || typeof telemetry.count !== "function") return;
    try {
      telemetry.count(name, n);
    } catch (_err) {}
  }

  function cacheKey() {
    if (call(store, "isOpen") !== true || !admitted()) return null;
    return `k${Math.floor(clock.now() / refreshMs)}`;
  }

  function getData() {
    if (call(store, "isOpen") !== true) return { available: false, reason: "STORE_CLOSED" };
    if (!admitted()) {
      count("observer.panel.deferrals", 1);
      return { available: false, reason: "GOVERNOR_HOLD" };
    }
    if (maxRows === 0) {
      const key = cacheKey();
      return { available: true, key, pins: [], hunters: [], limits: { perFaction: [], global: null }, stats: { pins: 0, hunters: 0 } };
    }

    const t0 = nowMs();
    const now = clock.now();

    const pinsSql = `
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
        whp.pin_ms,
        whp.state,
        whp.outcome,
        vf.fleet_role as hunter_role,
        vf.current_system_id as hunter_current_system
      FROM world_hunt_pins whp
      LEFT JOIN virtual_fleets vf ON vf.fleet_id = whp.hunter_fleet_id
      WHERE whp.state = 'ACTIVE' AND whp.until_at > ?
      ORDER BY whp.until_at ASC
      LIMIT ?
    `;

    const huntersSql = `
      SELECT
        vf.fleet_id,
        vf.faction_id,
        vf.current_system_id,
        vf.state,
        vf.operation_id,
        vf.updated_at
      FROM virtual_fleets vf
      WHERE vf.fleet_role = 'hunter' AND vf.state != 'DESTROYED'
      ORDER BY vf.faction_id, vf.fleet_id
      LIMIT ?
    `;

    const tx = store.transaction("observer.huntsPanel", (db) => {
      const pinsStmt = db.prepare(pinsSql);
      const huntersStmt = db.prepare(huntersSql);
      return {
        pins: pinsStmt.all(now, maxRows),
        hunters: huntersStmt.all(maxRows),
      };
    });

    if (!tx.ok) {
      return { available: false, reason: String((tx.reason) || "TX_FAILED"), detail: tx.detail || null };
    }

    const pins = tx.value?.pins || [];
    const hunters = tx.value?.hunters || [];

    const huntConfig = config.hunt || {};
    const maxActivePinsPerFaction = Number.isSafeInteger(huntConfig.maxActivePinsPerFaction) ? huntConfig.maxActivePinsPerFaction : 2;
    const maxActivePins = Number.isSafeInteger(huntConfig.maxActivePins) ? huntConfig.maxActivePins : 64;
    const maxHuntersPerFaction = Number.isSafeInteger(huntConfig.maxHuntersPerFaction) ? huntConfig.maxHuntersPerFaction : 2;

    const pinsPerFaction = new Map();
    for (const pin of pins) {
      const fid = Number(pin.hunter_faction_id);
      if (!pinsPerFaction.has(fid)) pinsPerFaction.set(fid, 0);
      pinsPerFaction.set(fid, pinsPerFaction.get(fid) + 1);
    }

    const huntersPerFaction = new Map();
    for (const hunter of hunters) {
      const fid = Number(hunter.faction_id);
      if (!huntersPerFaction.has(fid)) huntersPerFaction.set(fid, 0);
      huntersPerFaction.set(fid, huntersPerFaction.get(fid) + 1);
    }

    const allFactionIds = new Set([...pinsPerFaction.keys(), ...huntersPerFaction.keys()]);
    const perFactionLimits = [];
    for (const fid of allFactionIds) {
      const pinCount = pinsPerFaction.get(fid) || 0;
      const hunterCount = huntersPerFaction.get(fid) || 0;
      perFactionLimits.push({
        factionId: fid,
        factionName: factionNames.get(fid) || `faction ${fid}`,
        activePins: pinCount,
        maxPins: maxActivePinsPerFaction,
        hunters: hunterCount,
        maxHunters: maxHuntersPerFaction,
        pinLimitReached: pinCount >= maxActivePinsPerFaction,
        hunterLimitReached: hunterCount >= maxHuntersPerFaction,
      });
    }
    perFactionLimits.sort((a, b) => a.factionId - b.factionId);

    const formattedPins = pins.slice(0, maxRows).map((pin) => ({
      pinId: pin.pin_id,
      hunterFleetId: pin.hunter_fleet_id,
      systemId: pin.system_id,
      targetFleetId: pin.target_fleet_id,
      targetKind: pin.target_kind,
      targetFactionId: pin.target_faction_id ? Number(pin.target_faction_id) : null,
      targetFactionName: pin.target_faction_id ? (factionNames.get(Number(pin.target_faction_id)) || `faction ${pin.target_faction_id}`) : null,
      hunterFactionId: Number(pin.hunter_faction_id),
      hunterFactionName: factionNames.get(Number(pin.hunter_faction_id)) || `faction ${pin.hunter_faction_id}`,
      pinnedAt: formatLocalTime(pin.pinned_at),
      untilAt: formatLocalTime(pin.until_at),
      pinMs: pin.pin_ms,
      remainingMs: Math.max(0, Number(pin.until_at) - now),
      state: pin.state,
      outcome: pin.outcome,
    }));

    const formattedHunters = hunters.slice(0, maxRows).map((h) => ({
      fleetId: h.fleet_id,
      factionId: Number(h.faction_id),
      factionName: factionNames.get(Number(h.faction_id)) || `faction ${h.faction_id}`,
      systemId: h.current_system_id,
      state: h.state,
      operationId: h.operation_id,
      updatedAt: formatLocalTime(h.updated_at),
    }));

    const globalLimits = {
      activePins: pins.length,
      maxPins: maxActivePins,
      limitReached: pins.length >= maxActivePins,
    };

    const key = cacheKey();
    observe(nowMs() - t0);
    count(METRIC_ROWS, formattedPins.length + formattedHunters.length);

    return {
      available: true,
      key,
      pins: formattedPins,
      hunters: formattedHunters,
      limits: { perFaction: perFactionLimits, global: globalLimits },
      stats: { pins: pins.length, hunters: hunters.length },
    };
  }

  return {
    title: "Hunters & Pins",
    listed: true,
    order: 90,
    cacheKey,
    getData,
  };
}

module.exports = { PANEL_ID, buildHuntsPanelView };