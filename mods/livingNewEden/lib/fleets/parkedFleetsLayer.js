"use strict";

const { crewSummaryIn, crewSuffix } = require("./crewSummary");

const LAYER_ID = "layer-fleets-parked";
const LAYER_ORDER = 15;
const GALAXY_WORK_CLASS = "MAINTENANCE";
const METRIC_BUILD_MS = "observer.galaxyParkedMs";
const MS_DECIMALS = 10;

const PARKED_STYLES = Object.freeze([
  Object.freeze({ styleId: "engaged", label: "engaged", states: Object.freeze(["ENGAGED"]), colour: "#ff2850",
    shape: "diamond2", dash: "solid" }),
  Object.freeze({ styleId: "staged", label: "staged / waiting", states: Object.freeze(["STAGED", "PLANNED"]),
    colour: "#ff8c1a", shape: "diamond", dash: "dashed" }),
  Object.freeze({ styleId: "refitting", label: "refitting", states: Object.freeze(["REFITTING"]),
    colour: "#b36bff", shape: "diamond", dash: "dashdot" }),
  Object.freeze({ styleId: "idle", label: "idle", states: Object.freeze(["IDLE"]), colour: "#c0c8d4",
    shape: "diamond", dash: "dotted" }),
]);
const LEGEND = Object.freeze(PARKED_STYLES.map((p) => Object.freeze([p.styleId, p.label, p.colour, p.shape, null,
  p.dash])));
const HEADER_STATES = Object.freeze(PARKED_STYLES.flatMap((p) => p.states));
const PRIORITY = new Map(PARKED_STYLES.flatMap((p, rank) => p.states.map((st) => [st, rank])));

function call(obj, name) {
  try {
    return obj && typeof obj[name] === "function" ? obj[name]() : undefined;
  } catch (_err) {
    return undefined;
  }
}

function dominantRank(counts) {
  let best = PARKED_STYLES.length;
  for (const [state, n] of Object.entries(counts)) {
    if (n > 0 && PRIORITY.has(state)) best = Math.min(best, PRIORITY.get(state));
  }
  return best;
}

function sumOver(obj, states) {
  let n = 0;
  for (const st of states) n += (obj && obj[st]) || 0;
  return n;
}

function orderFactions(sys, rank) {
  if (!sys || !(sys.byFaction instanceof Map) || sys.byFaction.size === 0) return [];
  const style = PARKED_STYLES[rank];
  const states = style ? style.states : [];
  const rows = [...sys.byFaction].map(([id, f]) => ({ id, fleets: f.fleets, ships: f.ships,
    inState: sumOver(f.counts, states), shipsInState: sumOver(f.shipCounts, states) }));
  rows.sort((a, b) => b.fleets - a.fleets || a.id - b.id);
  let top = 0;
  for (let i = 1; i < rows.length; i += 1) {
    const a = rows[i];
    const t = rows[top];
    if (a.inState > t.inState || (a.inState === t.inState && (a.shipsInState > t.shipsInState
      || (a.shipsInState === t.shipsInState && a.id < t.id)))) top = i;
  }
  const [first] = rows.splice(top, 1);
  return [first, ...rows].map((r) => [r.id, r.fleets]);
}

function buildParkedFleetsLayerView(deps) {
  const { store, repository, clock } = deps;
  const getGovernor = typeof deps.getGovernor === "function" ? deps.getGovernor : () => null;
  const telemetry = deps.telemetry || null;
  const nowMs = typeof deps.nowMs === "function" ? deps.nowMs : () => performance.now();
  const maxSystems = Math.max(0, Math.trunc(Number(deps.maxSystems) || 0));
  const maxLines = Math.max(0, Math.trunc(Number(deps.maxLines) || 0));
  const refreshMs = Math.max(1, Math.trunc(Number(deps.refreshMs) || 1));

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

  function toItem(sys, crews) {
    const rank = dominantRank(sys.counts);
    const style = PARKED_STYLES[Math.min(rank, PARKED_STYLES.length - 1)];
    const parts = HEADER_STATES.filter((st) => sys.counts[st] > 0).map((st) => `${st} ${sys.counts[st]}`);
    const lines = [`${parts.join(" · ")} - ${sys.ships} ships`];
    const factions = orderFactions(sys, rank);
    if (factions.length >= 2) {
      lines.push(`factions ${factions.map(([id]) => {
        const f = sys.byFaction.get(id);
        return `${id} ${f.fleets}/${f.ships}`;
      }).join(" · ")}`);
    }
    for (const l of sys.lines) {
      lines.push(`${l.fleetId} - faction ${l.factionId} - ${l.state} - ${l.shipCount} ships - op `
        + `${l.operationId === null ? "-" : l.operationId}${crewSuffix(crews, l.fleetId)}`);
    }
    const more = sys.fleets - sys.lines.length;
    if (more > 0) lines.push(`+${more} more`);
    return { rank, item: [sys.systemId, style.styleId, `${sys.fleets}/${sys.ships}`, lines,
      factions.length > 0 ? factions : null], fleets: sys.fleets };
  }

  function getData() {
    if (call(store, "isOpen") !== true) return { available: false, reason: "STORE_CLOSED" };
    if (!admitted()) return { available: false, reason: "GOVERNOR_HOLD" };
    const now = clock.now();
    const legend = LEGEND.map((l) => [...l]);
    if (maxSystems === 0) {
      return { available: true, key: keyAt(now), legend, items: [], note: "0 parked fleets (layer limit 0)" };
    }
    const t0 = nowMs();
    const tx = store.transaction("observer.galaxyParkedFleets", (db) => {
      const r = repository.summarizeStationary(db, { states: HEADER_STATES, maxLinesPerSystem: maxLines });
      if (!r || !r.ok || typeof deps.getCrewSummary !== "function") return r;
      const ids = r.systems.flatMap((x) => x.lines.map((l) => l.fleetId));
      return { ...r, crews: crewSummaryIn(deps.getCrewSummary, db, ids) };
    });
    const read = tx.ok ? tx.value : tx;
    if (!tx.ok || !read || !read.ok) {
      return { available: false, reason: String((read && read.reason) || "TX_FAILED") };
    }
    const built = read.systems.map((sys) => toItem(sys, read.crews || null));
    let fleets = 0;
    for (const b of built) fleets += b.fleets;
    built.sort((a, b) => a.rank - b.rank || b.fleets - a.fleets || a.item[0] - b.item[0]);
    const truncated = built.length > maxSystems;
    const items = built.slice(0, maxSystems).map((b) => b.item);
    observe(nowMs() - t0);
    const note = `${fleets} parked fleets in ${built.length} systems (label = fleets/ships)`;
    return { available: true, key: keyAt(now), legend, items, note: truncated ? `${note} (truncated)` : note };
  }

  function cacheKey() {
    if (call(store, "isOpen") !== true || !admitted()) return null;
    return keyAt(clock.now());
  }

  return { title: "Parked fleets", listed: false, mapLayer: { kind: "marks", order: LAYER_ORDER }, cacheKey,
    getData };
}

module.exports = { LAYER_ID, LEGEND, PARKED_STYLES, buildParkedFleetsLayerView, orderFactions };
