"use strict";

const VIEW_ID = "battles";
const VIEW_ORDER = 45;
const VIEW_ROWS = 20;

function call(obj, name) {
  try {
    return obj && typeof obj[name] === "function" ? obj[name]() : undefined;
  } catch (_err) {
    return undefined;
  }
}

function buildBattlesView(deps) {
  const { store, repository } = deps;

  function collect(tx) {
    const counted = repository.countByState(tx);
    if (!counted.ok) return counted;
    const open = [];
    for (const state of ["PENDING", "RESOLVING"]) {
      if (open.length >= VIEW_ROWS) break;
      const page = repository.listByState(tx, state, { limit: VIEW_ROWS - open.length });
      if (!page.ok) return page;
      open.push(...page.battles);
    }
    const q = repository.listByState(tx, "QUARANTINED", { limit: VIEW_ROWS });
    if (!q.ok) return q;
    return { ok: true, counts: counted.counts, open, quarantined: q.battles };
  }

  function getData() {
    if (call(store, "isOpen") !== true) return { available: false, reason: "STORE_CLOSED" };
    const tx = store.transaction("observer.battles", (db) => collect(db));
    const read = tx.ok ? tx.value : tx;
    if (!tx.ok || !read || !read.ok) return { available: false, reason: String((read && read.reason) || "TX_FAILED") };
    const st = call({ getStatus: deps.getStatus }, "getStatus") || {};
    const wrecks = typeof deps.getWrecks === "function" ? deps.getWrecks() : null;
    const ws = wrecks ? call(wrecks, "getStatus") : null;
    return {
      available: true,
      state: st.state || null,
      byState: read.counts,
      counters: st.counters || null,
      quota: st.quota === undefined ? null : st.quota,
      presencePolicy: st.presencePolicy || null,
      consequences: st.consequences || [],
      lastQuarantine: st.lastQuarantine || null,
      lastRefusal: st.lastRefusal || null,
      recentSettled: st.recentSettled || [],
      open: read.open.map((b) => ({ battleId: b.battleId, systemId: b.systemId, state: b.state,
        holdReason: b.holdReason, createdAt: b.createdAt })),
      quarantined: read.quarantined.map((b) => ({ battleId: b.battleId, systemId: b.systemId, error: b.error })),
      wrecks: ws && ws.state === "ready" && ws.counters ? ws.counters : null,
    };
  }

  function cacheKey() {
    if (call(store, "isOpen") !== true) return null;
    const st = call({ getStatus: deps.getStatus }, "getStatus") || {};
    return `b${st.seq === undefined ? 0 : st.seq}`;
  }

  return { title: "Battles", order: VIEW_ORDER, listed: true, cacheKey, getData };
}

module.exports = { VIEW_ID, buildBattlesView };
