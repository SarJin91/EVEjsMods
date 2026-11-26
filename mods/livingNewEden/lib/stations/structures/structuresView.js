"use strict";

const VIEW_ID = "structures";
const VIEW_ORDER = 61;
const WORK_CLASS = "MAINTENANCE";

function call(fn, fallback) {
  try {
    return fn();
  } catch (_err) {
    return fallback;
  }
}

function buildStructuresView(deps) {
  const { service } = deps;
  const getGovernor = typeof deps.getGovernor === "function" ? deps.getGovernor : () => null;

  function admitted() {
    const governor = call(getGovernor, null);
    return !governor || typeof governor.admits !== "function"
      || call(() => governor.admits(WORK_CLASS), true) !== false;
  }

  function getData() {
    if (!admitted()) return { available: false, reason: "GOVERNOR_HOLD" };
    const st = call(() => service.getStatus(), null);
    if (!st) return { available: false, reason: "STATUS_UNAVAILABLE" };
    const rows = call(() => service.listBindings(deps.maxRows), []);
    return { available: true, mode: st.mode, state: st.state, projected: st.projected, pending: st.pending,
      blocked: st.blocked, waiting: st.waiting, remaining: st.remaining, cleanup: st.cleanup, passes: st.passes,
      lastPassAt: st.lastPassAt, lastFullAt: st.lastFullAt, lastError: st.lastError, counters: st.counters,
      stations: rows.map((r) => ({ station: r.stationId, structureId: r.structureId, lastOp: r.lastOp,
        lastError: r.lastError, at: r.at })) };
  }

  function cacheKey() {
    if (!admitted()) return null;
    const st = call(() => service.getStatus(), null);
    return st ? `s${st.seq}` : null;
  }

  return { title: "Upwell structures in EveJS", order: VIEW_ORDER, cacheKey, getData };
}

module.exports = { VIEW_ID, VIEW_ORDER, buildStructuresView };
