"use strict";

const VIEW_ID = "liberation";
const VIEW_ORDER = 34;
const WORK_CLASS = "MAINTENANCE";

function call(obj, name) {
  try {
    return obj && typeof obj[name] === "function" ? obj[name]() : undefined;
  } catch (_err) {
    return undefined;
  }
}

function buildLiberationView(deps) {
  const { store, repository } = deps;
  const getGovernor = typeof deps.getGovernor === "function" ? deps.getGovernor : () => null;
  const names = deps.factionNames instanceof Map ? deps.factionNames : new Map();
  const nameOf = (f) => (f === null || f === undefined ? null : (names.get(f) || String(f)));
  const maxRows = Math.max(1, Math.trunc(Number(deps.maxRows) || 1));

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
    const tx = store.transaction("observer.liberation", (db) => repository.listLiberated(db,
      { limit: maxRows + 1 }));
    const read = tx.ok ? tx.value : tx;
    if (!tx.ok || !read || !read.ok) return { available: false, reason: String((read && read.reason) || "TX_FAILED") };
    const st = call({ getStatus: deps.getStatus }, "getStatus") || {};
    return {
      available: true,
      state: st.state || null,
      countersSinceStart: st.counters || null,
      lastRefusal: st.lastRefusal || null,
      truncated: read.systems.length > maxRows || typeof read.nextAfterSystemId === "number",
      liberated: read.systems.slice(0, maxRows).map((s) => ({ systemId: s.systemId, name: systemName(s.systemId),
        previousController: nameOf(s.previousControllerFactionId), freedSince: s.lastStateChangeAt,
        seq: s.phaseSeq })),
    };
  }

  function cacheKey() {
    if (call(store, "isOpen") !== true || !admitted()) return null;
    const st = call({ getStatus: deps.getStatus }, "getStatus") || {};
    return `l${st.seq === undefined ? 0 : st.seq}|${call(repository, "getChangeCount") || 0}`;
  }

  return { title: "Abandoned systems (no controller)", order: VIEW_ORDER, listed: true, cacheKey, getData };
}

module.exports = { VIEW_ID, buildLiberationView };
