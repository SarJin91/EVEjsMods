"use strict";

const VIEW_ID = "extraction";
const VIEW_ORDER = 77;
const WORK_CLASS = "MAINTENANCE";
const TOP_SYSTEMS = 10;

function call(fn, fallback) {
  try {
    return fn();
  } catch (_err) {
    return fallback;
  }
}

function buildExtractionView(deps) {
  const getGovernor = typeof deps.getGovernor === "function" ? deps.getGovernor : () => null;
  const names = deps.factionNames instanceof Map ? deps.factionNames : new Map();

  function admitted() {
    const governor = call(getGovernor, null);
    return !governor || typeof governor.admits !== "function"
      || call(() => governor.admits(WORK_CLASS), true) !== false;
  }

  function systemName(id) {
    const res = deps.graph && typeof deps.graph.getGraph === "function"
      ? call(() => deps.graph.getGraph(), null) : null;
    const vertex = res && res.ok === true && res.graph ? call(() => res.graph.getSystem(id), null) : null;
    return vertex && vertex.name ? vertex.name : id;
  }

  function getData() {
    if (!admitted()) return { available: false, reason: "GOVERNOR_HOLD" };
    const st = call(() => deps.getStatus(), {}) || {};
    const top = call(() => deps.topSystems(TOP_SYSTEMS), []) || [];
    return { available: true, mode: st.mode || null, state: st.state || null, lastRefusal: st.lastRefusal || null,
      cachedSystems: st.cachedSystems === undefined ? null : st.cachedSystems, counters: st.counters || null,
      lastCycleByFaction: (st.lastCycleByFaction || []).map((c) => ({ faction: names.get(c.factionId) || c.factionId,
        bucket: c.bucket, systems: c.systems, moonUnits: c.moonUnits, piUnits: c.piUnits, lostUnits: c.lostUnits })),
      topSystems: top.map((t) => ({ system: systemName(t.systemId), faction: names.get(t.factionId) || t.factionId,
        units: t.units })) };
  }

  function cacheKey() {
    if (!admitted()) return null;
    const st = call(() => deps.getStatus(), {}) || {};
    return `x${st.seq === undefined ? 0 : st.seq}|${st.mode || ""}`;
  }

  return { title: "Moon / PI extraction", order: VIEW_ORDER, cacheKey, getData };
}

module.exports = { VIEW_ID, buildExtractionView };
