"use strict";

const VIEW_ORDER = 75;
const MAX_ROWS = 32;
const WORK_CLASS = "MAINTENANCE";

function call(fn, fallback) {
  try {
    return fn();
  } catch (_err) {
    return fallback;
  }
}

function rowsOf(chains) {
  return (Array.isArray(chains) ? chains : []).map((c) => ({ theme: c.theme, stage: `${c.stageNo}/${c.stageCount}`,
    stageState: c.stageState, stageKind: c.stageKind, systemId: c.stageSystemId, regionId: c.stageRegionId,
    deadlineAt: c.deadlineAt }));
}

function buildArchaeologyPanel(deps) {
  const { store, repo, clock } = deps;
  const getGovernor = typeof deps.getGovernor === "function" ? deps.getGovernor : () => null;
  const pollMs = Math.max(1, Math.trunc(Number(deps.settings && deps.settings.pollMs) || 0));

  function admitted() {
    const governor = call(getGovernor, null);
    return !governor || typeof governor.admits !== "function"
      || call(() => governor.admits(WORK_CLASS), true) !== false;
  }

  function cacheKey() {
    if (call(() => store.isOpen(), false) !== true || !admitted()) return null;
    return `p${Math.floor(clock.now() / pollMs)}`;
  }

  function getData() {
    if (call(() => store.isOpen(), false) !== true) return { available: false, reason: "STORE_CLOSED" };
    if (!admitted()) return { available: false, reason: "GOVERNOR_HOLD" };
    const tx = store.transaction("observer.archaeology", (db) => repo.listActiveInTx(db, MAX_ROWS));
    const v = tx && tx.ok ? tx.value : null;
    if (!v || v.ok !== true) return { available: false, reason: String((tx && tx.reason) || (v && v.reason) || "TX_FAILED") };
    const st = typeof deps.getStatus === "function" ? call(deps.getStatus, null) : null;
    return { available: true, active: rowsOf(v.chains), truncated: v.chains.length >= MAX_ROWS,
      status: st ? { state: st.state, queued: st.queued, passes: st.passes, chainsActive: st.chainsActive,
        seasonKey: st.seasonKey } : null,
      counters: st && st.counters ? st.counters : null, generatedAt: clock.now() };
  }

  return { title: "Archaeology", order: VIEW_ORDER, listed: true, cacheKey, getData };
}

module.exports = { VIEW_ORDER, MAX_ROWS, rowsOf, buildArchaeologyPanel };
