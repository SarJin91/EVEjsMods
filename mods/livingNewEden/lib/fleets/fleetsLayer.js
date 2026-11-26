"use strict";

const { positionAt } = require("./travel");
const { crewSummaryIn, pilotsLine } = require("./crewSummary");

const LAYER_ID = "layer-fleets";
const LAYER_ORDER = 20;
const GALAXY_WORK_CLASS = "MAINTENANCE";
const MS_PER_MINUTE = 60000;
const METRIC_BUILD_MS = "observer.galaxyFleetsMs";
const MS_DECIMALS = 10;
const LAYER_STATES = Object.freeze([["TRAVELLING", "travelling"], ["RETREATING", "retreating"]]);
const LEGEND = Object.freeze([
  Object.freeze(["travelling", "in transit", "#ffb000", "solid"]),
  Object.freeze(["retreating", "retreating", "#ff5a5a", "dashed"]),
]);

function call(obj, name) {
  try {
    return obj && typeof obj[name] === "function" ? obj[name]() : undefined;
  } catch (_err) {
    return undefined;
  }
}

function buildFleetsLayerView(deps) {
  const { store, repository, clock } = deps;
  const getGovernor = typeof deps.getGovernor === "function" ? deps.getGovernor : () => null;
  const maxItems = Math.max(0, Math.trunc(Number(deps.maxItems) || 0));
  const refreshMs = Math.max(1, Math.trunc(Number(deps.refreshMs) || 1));
  const telemetry = deps.telemetry || null;
  const nowMs = typeof deps.nowMs === "function" ? deps.nowMs : () => performance.now();

  function admitted() {
    try {
      const governor = getGovernor();
      return !governor || typeof governor.admits !== "function" || governor.admits(GALAXY_WORK_CLASS) !== false;
    } catch (_err) {
      return true;
    }
  }

  const keyAt = (now) => `f${Math.floor(now / refreshMs)}`;

  function collect(tx) {
    const fleets = [];
    let truncated = false;
    for (const [state] of LAYER_STATES) {
      let after = "";
      for (;;) {
        const remaining = maxItems - fleets.length;
        if (remaining <= 0) {
          const more = repository.listFleetsByState(tx, state, { limit: 1, afterFleetId: after });
          if (!more.ok) return more;
          if (more.fleets.length > 0) truncated = true;
          break;
        }
        const page = repository.listFleetsByState(tx, state, { limit: remaining, afterFleetId: after });
        if (!page.ok) return page;
        fleets.push(...page.fleets);
        if (page.nextAfterFleetId === null) break;
        after = page.nextAfterFleetId;
      }
    }
    return { ok: true, fleets, truncated };
  }

  function getData() {
    if (call(store, "isOpen") !== true) return { available: false, reason: "STORE_CLOSED" };
    if (!admitted()) return { available: false, reason: "GOVERNOR_HOLD" };
    const now = clock.now();
    const t0 = nowMs();
    const tx = store.transaction("observer.galaxyFleets", (db) => {
      const r = collect(db);
      return r.ok ? { ...r, crews: crewSummaryIn(deps.getCrewSummary, db, r.fleets.map((f) => f.fleetId)) } : r;
    });
    const read = tx.ok ? tx.value : tx;
    if (!tx.ok || !read || !read.ok) {
      return { available: false, reason: String((read && read.reason) || "TX_FAILED") };
    }
    const style = new Map(LAYER_STATES);
    const items = [];
    for (const f of read.fleets) {
      const pos = positionAt(f, now);
      if (!pos.inFlight) continue;
      const eta = Math.max(0, Math.ceil((pos.arriveAt - now) / MS_PER_MINUTE));
      const lines = [
        f.fleetId,
        `faction ${f.factionId}`,
        `${f.fleetRole} - ${f.shipCount} ships`,
        `op ${f.operationId === null ? "-" : f.operationId}`,
        `-> ${f.targetSystemId} ETA ${eta} min`,
        `leg ${f.legSeq}`,
      ];
      const pilots = pilotsLine(read.crews, f.fleetId);
      if (pilots !== null) lines.push(pilots);
      items.push([[...f.route.systems], style.get(f.state), pos.progress, String(f.shipCount), lines,
        f.factionId > 0 ? f.factionId : null]);
    }
    if (telemetry && typeof telemetry.observe === "function") {
      try {
        telemetry.observe(METRIC_BUILD_MS, Math.round((nowMs() - t0) * MS_DECIMALS) / MS_DECIMALS);
      } catch (_err) {
      }
    }
    return { available: true, key: keyAt(now), legend: LEGEND.map((l) => [...l]), items,
      note: `${items.length} fleets in flight${read.truncated ? " (truncated)" : ""}` };
  }

  function cacheKey() {
    if (call(store, "isOpen") !== true || !admitted()) return null;
    return keyAt(clock.now());
  }

  return { title: "Fleets", listed: false, mapLayer: { kind: "paths", order: LAYER_ORDER }, cacheKey, getData };
}

module.exports = { LAYER_ID, LEGEND, buildFleetsLayerView };
