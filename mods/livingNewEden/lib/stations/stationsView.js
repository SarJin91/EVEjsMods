"use strict";

const VIEW_ID = "stations";
const VIEW_ORDER = 55;
const WORK_CLASS = "MAINTENANCE";

function call(obj, name) {
  try {
    return obj && typeof obj[name] === "function" ? obj[name]() : undefined;
  } catch (_err) {
    return undefined;
  }
}

function buildStationsView(deps) {
  const { store, repository } = deps;
  const getGovernor = typeof deps.getGovernor === "function" ? deps.getGovernor : () => null;
  const names = deps.factionNames instanceof Map ? deps.factionNames : new Map();
  const maxRows = Math.max(1, Math.trunc(Number(deps.maxRows) || 1));
  const stockLines = Math.max(0, Math.trunc(Number(deps.stockLines) || 0));

  function admitted() {
    try {
      const governor = getGovernor();
      return !governor || typeof governor.admits !== "function" || governor.admits(WORK_CLASS) !== false;
    } catch (_err) {
      return true;
    }
  }

  function systemName(id) {
    const res = deps.graph && typeof deps.graph.getGraph === "function" ? call(deps.graph, "getGraph") : null;
    const vertex = res && res.ok === true && res.graph ? res.graph.getSystem(id) : null;
    return vertex ? vertex.name : null;
  }

  function getData() {
    if (call(store, "isOpen") !== true) return { available: false, reason: "STORE_CLOSED" };
    if (!admitted()) return { available: false, reason: "GOVERNOR_HOLD" };
    const tx = store.transaction("observer.stations", (db) => {
      const live = repository.listLiveStations(db, { limit: maxRows });
      if (!live.ok) return live;
      const stock = repository.summarizeStock(db, { topLines: stockLines });
      if (!stock.ok) return stock;
      return { ok: true, records: live.records, truncated: live.truncated, stock: stock.byStation };
    });
    const read = tx.ok ? tx.value : tx;
    if (!tx.ok || !read || !read.ok) return { available: false, reason: String((read && read.reason) || "TX_FAILED") };
    const st = call({ getStatus: deps.getStatus }, "getStatus") || {};
    return {
      available: true,
      state: st.state || null,
      reason: st.reason || null,
      seed: st.seed || null,
      truncated: read.truncated,
      stations: read.records.map((s) => {
        const stock = read.stock.get(s.stationId) || { items: 0, total: 0, top: [] };
        return {
          station: s.name || s.stationId,
          faction: names.get(s.ownerFactionId) || s.ownerFactionId,
          system: systemName(s.systemId) || s.systemId,
          kind: s.kind,
          state: s.state,
          version: s.version,
          items: stock.items,
          quantity: stock.total,
          stock: stock.top.map((i) => `${i.itemKind} ${i.itemKey} x${i.quantity}`),
        };
      }),
    };
  }

  function cacheKey() {
    if (call(store, "isOpen") !== true || !admitted()) return null;
    const st = call({ getStatus: deps.getStatus }, "getStatus") || {};
    return `s${repository.getChangeCount()}|${st.seq === undefined ? 0 : st.seq}`;
  }

  return { title: "Faction stations", order: VIEW_ORDER, cacheKey, getData };
}

module.exports = { VIEW_ID, buildStationsView };
