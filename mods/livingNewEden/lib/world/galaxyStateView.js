"use strict";

const { performance } = require("node:perf_hooks");
const { readAllSystems } = require("./readAllSystems");

const GALAXY_WORK_CLASS = "MAINTENANCE";
const MS_DECIMALS = 10;

function call(obj, name) {
  try {
    return obj && typeof obj[name] === "function" ? obj[name]() : undefined;
  } catch (_err) {
    return undefined;
  }
}

function byScoreDesc(a, b) {
  return b[1] - a[1] || a[0] - b[0];
}

function buildGalaxyStateView(deps) {
  const { store, repository, maxListLimit, influenceTop } = deps;
  const factionNames = deps.factionNames instanceof Map ? deps.factionNames : new Map();
  const getSeedStatus = typeof deps.getSeedStatus === "function" ? deps.getSeedStatus : () => null;
  const getGovernor = typeof deps.getGovernor === "function" ? deps.getGovernor : () => null;
  const nowMs = typeof deps.nowMs === "function" ? deps.nowMs : () => performance.now();
  const telemetry = deps.telemetry || null;
  const bastionsOf = () => {
    try {
      const m = typeof deps.getBastions === "function" ? deps.getBastions() : null;
      return m instanceof Map ? m : new Map();
    } catch (_err) {
      return new Map();
    }
  };

  function metric(kind, name, value) {
    if (!telemetry || typeof telemetry[kind] !== "function") return;
    try {
      telemetry[kind](name, value);
    } catch (_err) {
    }
  }

  function sourceKey() {
    const seed = getSeedStatus();
    return `${repository.getChangeCount()}|${seed ? seed.seq : "-"}|${call(store, "isOpen") === true ? 1 : 0}`;
  }

  function admitted() {
    const governor = getGovernor();
    return !governor || typeof governor.admits !== "function" || governor.admits(GALAXY_WORK_CLASS) !== false;
  }

  function getData() {
    const seedStatus = getSeedStatus() || {};
    const seed = { state: seedStatus.state || null, scope: seedStatus.scope || null };
    if (call(store, "isOpen") !== true) return { available: false, reason: "STORE_CLOSED", seed };
    if (!admitted()) {
      metric("count", "observer.galaxy.deferrals", 1);
      return { available: false, reason: "GOVERNOR_HOLD", seed };
    }
    const key = sourceKey();
    const t0 = nowMs();
    const tx = readAllSystems(store, repository, { label: "observer.galaxyState", maxListLimit });
    const read = tx.ok ? tx.value : tx;
    if (!tx.ok || !read || !read.ok) {
      return { available: false, reason: String((read && read.reason) || "TX_FAILED"),
        detail: (read && read.detail) || null, seed };
    }
    const counts = new Map();
    const seen = new Set();
    const systems = [];
    for (const s of read.systems) {
      const controller = s.controllerFactionId;
      const influence = (s.influence || []).map((i) => [i.factionId, Math.round(i.influenceScore)]);
      for (const [id] of influence) seen.add(id);
      influence.sort(byScoreDesc);
      systems.push([s.systemId, controller, s.occupationState, influence.slice(0, influenceTop)]);
      if (controller !== null) {
        counts.set(controller, (counts.get(controller) || 0) + 1);
        seen.add(controller);
      }
    }
    const bastions = [...bastionsOf()].sort((a, b) => a[0] - b[0]);
    for (const [, f] of bastions) seen.add(f);
    const factions = [...counts].sort(byScoreDesc).map(([id, n]) => [id, factionNames.get(id) || null, n]);
    const names = [...seen].sort((a, b) => a - b).map((id) => [id, factionNames.get(id) || null]);
    let controlled = 0;
    for (const n of counts.values()) controlled += n;
    metric("observe", "observer.galaxy.stateBuildMs", Math.round((nowMs() - t0) * MS_DECIMALS) / MS_DECIMALS);
    return { available: true, key, systems, factions, names, bastions, totals: { rows: systems.length, controlled },
      seed };
  }

  function cacheKey() {
    if (call(store, "isOpen") !== true || !admitted()) return null;
    return sourceKey();
  }

  return { title: "Galaxy state", listed: false, getData, cacheKey };
}

module.exports = { buildGalaxyStateView };
