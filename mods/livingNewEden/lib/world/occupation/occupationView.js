"use strict";

const VIEW_ID = "occupation";
const VIEW_ORDER = 33;
const WORK_CLASS = "MAINTENANCE";

function call(obj, name) {
  try {
    return obj && typeof obj[name] === "function" ? obj[name]() : undefined;
  } catch (_err) {
    return undefined;
  }
}

function buildOccupationView(deps) {
  const { store, repository } = deps;
  const getGovernor = typeof deps.getGovernor === "function" ? deps.getGovernor : () => null;
  const names = deps.factionNames instanceof Map ? deps.factionNames : new Map();
  const nameOf = (f) => (f === null ? null : (names.get(f) || String(f)));

  function admitted() {
    const governor = call({ getGovernor }, "getGovernor");
    return !governor || typeof governor.admits !== "function" || governor.admits(WORK_CLASS) !== false;
  }

  function systemName(id) {
    const g = deps.graph;
    const r = call(g, "getGraph");
    const v = r && r.ok && r.graph && typeof r.graph.getSystem === "function" ? r.graph.getSystem(id) : null;
    return v && typeof v.name === "string" ? v.name : String(id);
  }

  function getData() {
    if (call(store, "isOpen") !== true) return { available: false, reason: "STORE_CLOSED" };
    if (!admitted()) return { available: false, reason: "GOVERNOR_DEFERRED" };
    const tx = store.transaction("observer.occupation", (db) => {
      const active = repository.listActiveOccupations(db, { limit: deps.maxRows, includeInfluence: true });
      if (!active.ok) return active;
      const counted = repository.countDetachedByController(db);
      if (!counted.ok) return counted;
      return { ok: true, active: active.systems, detached: new Map(counted.rows.map((r) => [r.factionId, r.count])) };
    });
    const read = tx.ok ? tx.value : tx;
    if (!tx.ok || !read || !read.ok) return { available: false, reason: String((read && read.reason) || "TX_FAILED") };
    const st = call({ getStatus: deps.getStatus }, "getStatus") || {};
    const score = (s, f) => {
      const row = (s.influence || []).find((i) => i.factionId === f);
      return row ? Math.round(row.influenceScore) : null;
    };
    const garrison = (s, f) => {
      const row = (s.influence || []).find((i) => i.factionId === f);
      return row ? row.garrisonStrength : 0;
    };
    return {
      available: true,
      state: st.state || null,
      counters: st.counters || null,
      lastRefusal: st.lastRefusal || null,
      systems: read.active.map((s) => ({ systemId: s.systemId, name: systemName(s.systemId), state: s.occupationState,
        controller: nameOf(s.controllerFactionId), occupier: nameOf(s.occupierFactionId), since: s.lastStateChangeAt,
        phaseDueAt: s.phaseDueAt, controllerInfluence: score(s, s.controllerFactionId),
        occupierInfluence: score(s, s.occupierFactionId), controllerGarrison: garrison(s, s.controllerFactionId),
        occupierGarrison: garrison(s, s.occupierFactionId), seq: s.phaseSeq })),
      detachedByFaction: [...read.detached.entries()].sort((a, b) => a[0] - b[0])
        .map(([f, n]) => ({ faction: nameOf(f), systems: n })),
    };
  }

  function cacheKey() {
    if (call(store, "isOpen") !== true || !admitted()) return null;
    const st = call({ getStatus: deps.getStatus }, "getStatus") || {};
    return `o${st.seq === undefined ? 0 : st.seq}|${call(repository, "getChangeCount") || 0}`;
  }

  return { title: "Occupation", order: VIEW_ORDER, listed: true, cacheKey, getData };
}

module.exports = { VIEW_ID, buildOccupationView };
