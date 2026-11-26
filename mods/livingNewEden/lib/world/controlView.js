"use strict";

const { readAllSystems } = require("./readAllSystems");

const SECURITY_DECIMALS = 10;

function round1(value) {
  return Math.round(value * SECURITY_DECIMALS) / SECURITY_DECIMALS;
}

function call(obj, name) {
  try {
    return obj && typeof obj[name] === "function" ? obj[name]() : undefined;
  } catch (_err) {
    return undefined;
  }
}

function buildControlView(deps) {
  const { store, repository, maxListLimit } = deps;
  const factionNames = deps.factionNames instanceof Map ? deps.factionNames : new Map();
  const getSeedStatus = typeof deps.getSeedStatus === "function" ? deps.getSeedStatus : () => null;

  function readyGraph() {
    const res = deps.graph && typeof deps.graph.getGraph === "function" ? deps.graph.getGraph() : null;
    return res && res.ok === true ? res.graph : null;
  }

  function getData() {
    const seed = getSeedStatus();
    if (call(store, "isOpen") !== true) {
      return { available: false, reason: "STORE_CLOSED", seed };
    }
    const tx = readAllSystems(store, repository, { label: "observer.control", maxListLimit });
    const read = tx.ok ? tx.value : tx;
    if (!tx.ok || !read || !read.ok) {
      return { available: false, reason: String((read && read.reason) || "TX_FAILED"),
        detail: (read && read.detail) || null, seed };
    }
    const graph = readyGraph();
    const factionCounts = new Map();
    const regions = new Map();
    const systems = [];
    let controlled = 0;
    for (const s of read.systems) {
      const vertex = graph ? graph.getSystem(s.systemId) : null;
      const regionId = vertex ? vertex.regionId : null;
      const controller = s.controllerFactionId;
      const influence = (s.influence || []).map((i) => [i.factionId, Math.round(i.influenceScore)]);
      const own = controller === null ? null : influence.find(([id]) => id === controller);
      systems.push([s.systemId, vertex ? vertex.name : null, regionId, vertex ? round1(vertex.security) : null,
        controller, own ? own[1] : null, influence]);
      let region = regions.get(regionId);
      if (!region) {
        region = { systems: 0, controlled: 0, byFaction: new Map() };
        regions.set(regionId, region);
      }
      region.systems += 1;
      if (controller !== null) {
        controlled += 1;
        region.controlled += 1;
        region.byFaction.set(controller, (region.byFaction.get(controller) || 0) + 1);
        factionCounts.set(controller, (factionCounts.get(controller) || 0) + 1);
      }
    }
    const seen = new Set(factionCounts.keys());
    for (const row of systems) for (const [id] of row[6]) seen.add(id);
    const names = [...seen].sort((a, b) => a - b).map((id) => [id, factionNames.get(id) || null]);
    const factions = [...factionCounts]
      .sort((a, b) => b[1] - a[1] || a[0] - b[0])
      .map(([id, n]) => [id, factionNames.get(id) || null, n]);
    const regionRows = [...regions].map(([regionId, r]) => {
      let top = null;
      let topCount = 0;
      for (const [id, n] of r.byFaction) if (n > topCount || (n === topCount && id < top)) { top = id; topCount = n; }
      const name = graph && regionId !== null ? graph.getRegionName(regionId) : null;
      return [regionId, name, r.systems, r.controlled, top, topCount];
    });
    regionRows.sort((a, b) => (a[1] === null) - (b[1] === null) || String(a[1] || "").localeCompare(String(b[1] || ""))
      || (a[0] || 0) - (b[0] || 0));
    return {
      available: true,
      seed,
      graphReady: graph !== null,
      totals: { systems: systems.length, controlled, uncontrolled: systems.length - controlled },
      factions,
      factionNames: names,
      regions: regionRows,
      systems,
    };
  }

  function cacheKey() {
    const seed = getSeedStatus();
    return `${repository.getChangeCount()}|${seed ? seed.seq : "-"}|${readyGraph() ? 1 : 0}|`
      + `${call(store, "isOpen") === true ? 1 : 0}`;
  }

  return { title: "Territory control", order: 30, getData, cacheKey };
}

module.exports = { buildControlView };
