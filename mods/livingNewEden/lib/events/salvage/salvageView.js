"use strict";

const { STATE } = require("./schema");

const VIEW_ID = "salvage";
const VIEW_ORDER = 57;
const WORK_CLASS = "MAINTENANCE";
const ENDED_ROWS = 20;
const COUNT_STATES = Object.freeze([STATE.SITE_PENDING, STATE.PLACING, STATE.PLACED, STATE.ENDING, STATE.ENDED]);

function call(obj, name) {
  try {
    return obj && typeof obj[name] === "function" ? obj[name]() : undefined;
  } catch (_err) {
    return undefined;
  }
}

function buildSalvageView(deps) {
  const { store, repository } = deps;
  const getGovernor = typeof deps.getGovernor === "function" ? deps.getGovernor : () => null;
  const getPresence = typeof deps.getPresence === "function" ? deps.getPresence : () => null;
  const maxRows = Math.max(1, Math.trunc(Number(deps.maxRows) || 1));

  function admitted() {
    try {
      const governor = getGovernor();
      return !governor || typeof governor.admits !== "function" || governor.admits(WORK_CLASS) !== false;
    } catch (_err) {
      return true;
    }
  }

  function status() {
    return call({ getStatus: deps.getStatus }, "getStatus") || {};
  }

  function systemName(id) {
    const res = deps.graph && typeof deps.graph.getGraph === "function" ? call(deps.graph, "getGraph") : null;
    let vertex = null;
    try {
      vertex = res && res.ok === true && res.graph ? res.graph.getSystem(id) : null;
    } catch (_err) {
      vertex = null;
    }
    return vertex && vertex.name ? vertex.name : null;
  }

  function observedSet() {
    try {
      const presence = getPresence();
      if (!presence || typeof presence.observedSystems !== "function") return null;
      const list = presence.observedSystems();
      return Array.isArray(list) ? new Set(list.map(Number)) : null;
    } catch (_err) {
      return null;
    }
  }

  function getData() {
    if (call(store, "isOpen") !== true) return { available: false, reason: "STORE_CLOSED" };
    if (!admitted()) return { available: false, reason: "GOVERNOR_HOLD" };
    const tx = store.transaction("observer.salvage", (db) => ({
      ok: true,
      counts: repository.countByStateInTx(db),
      live: repository.listLiveInTx(db, maxRows + 1),
      ended: repository.listRecentEndedInTx(db, ENDED_ROWS),
    }));
    const read = tx && tx.ok ? tx.value : null;
    if (!read || read.ok !== true) return { available: false, reason: "TX_FAILED" };
    const st = status();
    const observed = observedSet();
    const counts = {};
    for (const s of COUNT_STATES) counts[s] = Number(read.counts[s]) || 0;
    const systemOf = (r) => systemName(r.systemId) || r.systemId;
    return {
      available: true,
      state: st.state || null,
      passes: Number.isSafeInteger(st.passes) ? st.passes : null,
      listening: typeof st.listening === "boolean" ? st.listening : null,
      lootTablesMissing: Number.isSafeInteger(st.lootTablesMissing) ? st.lootTablesMissing : null,
      last: st.last || null,
      counts,
      truncated: read.live.length > maxRows,
      live: read.live.slice(0, maxRows).map((r) => ({ anomaly: r.anomalyId, system: systemOf(r),
        systemId: r.systemId, observed: observed === null ? null : observed.has(r.systemId), state: r.state,
        wrecksPlanned: r.wrecksPlanned, wrecksPlaced: r.wrecksPlaced, wrecksRemaining: r.wrecksRemaining,
        haulSalvage: r.haulSalvage, haulLoot: r.haulLoot, createdAt: r.createdAt, expiresAt: r.expiresAt })),
      ended: read.ended.map((r) => ({ anomaly: r.anomalyId, system: systemOf(r), systemId: r.systemId,
        endReason: r.endReason, wrecksPlanned: r.wrecksPlanned, wrecksPlaced: r.wrecksPlaced, endedAt: r.endedAt })),
    };
  }

  function cacheKey() {
    if (call(store, "isOpen") !== true || !admitted()) return null;
    const st = status();
    return `p${Number.isSafeInteger(st.passes) ? st.passes : 0}`;
  }

  return { title: "Salvage anomalies", order: VIEW_ORDER, cacheKey, getData };
}

module.exports = { VIEW_ID, VIEW_ORDER, ENDED_ROWS, buildSalvageView };
