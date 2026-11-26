"use strict";

const { cargoUnits } = require("./cargo");

const VIEW_ID = "logistics";
const VIEW_ORDER = 59;
const WORK_CLASS = "MAINTENANCE";
const DAY_MS = 86400000;
const MAX_RECENT_CONVOYS = 5000;
const FACTIONS_PER_PANEL = 64;

function call(fn, fallback) {
  try {
    return fn();
  } catch (_err) {
    return fallback;
  }
}

function buildLogisticsView(deps) {
  const { store, convoys, clock } = deps;
  const getGovernor = typeof deps.getGovernor === "function" ? deps.getGovernor : () => null;
  const names = deps.factionNames instanceof Map ? deps.factionNames : new Map();
  const openLimit = Math.max(1, deps.maxOpenRows || 1) * FACTIONS_PER_PANEL;

  function admitted() {
    const governor = call(getGovernor, null);
    return !governor || typeof governor.admits !== "function"
      || call(() => governor.admits(WORK_CLASS), true) !== false;
  }

  function getData() {
    if (call(() => store.isOpen(), false) !== true) return { available: false, reason: "STORE_CLOSED" };
    if (!admitted()) return { available: false, reason: "GOVERNOR_HOLD" };
    const since = Math.max(0, clock.now() - DAY_MS);
    const tx = store.transaction("observer.logistics", (db) => {
      const totals = convoys.listTotals(db);
      if (!totals.ok) return totals;
      const open = convoys.listOpen(db, { limit: openLimit });
      if (!open.ok) return open;
      const ended = convoys.recentEnded(db, since);
      if (!ended.ok) return ended;
      const delivered = convoys.recentDelivered(db, since, MAX_RECENT_CONVOYS);
      if (!delivered.ok) return delivered;
      return { ok: true, totals: totals.totals, open: open.convoys, ended: ended.rows, delivered: delivered.rows };
    });
    const read = tx.ok ? tx.value : tx;
    if (!tx.ok || !read || !read.ok) return { available: false, reason: String((read && read.reason) || "TX_FAILED") };
    const ids = new Set(call(() => (typeof deps.factionIds === "function" ? deps.factionIds() : []), []));
    for (const t of read.totals) ids.add(t.factionId);
    for (const c of read.open) ids.add(c.factionId);
    const st = call(() => deps.getStatus(), {}) || {};
    const factions = [...ids].filter((id) => Number.isSafeInteger(id)).sort((a, b) => a - b).map((f) => {
      const t = read.totals.find((x) => x.factionId === f) || null;
      const endedRows = read.ended.filter((r) => r.faction_id === f);
      const mine = read.delivered.filter((r) => r.factionId === f);
      return {
        faction: names.get(f) || f,
        open: read.open.filter((c) => c.factionId === f).map((c) => ({ convoy: c.convoyId, state: c.state,
          purpose: c.purpose, from: c.sourceStationId, to: c.destStationId, fleet: c.fleetId,
          loaded: c.cargo !== null, cargo: { ...(c.cargo || c.plan || {}) } })),
        totals: t ? { started: t.convoysStarted, delivered: t.convoysDelivered, aborted: t.convoysAborted,
          lost: t.convoysLost, unitsLoaded: t.unitsLoaded, unitsDelivered: t.unitsDelivered, unitsLost: t.unitsLost }
          : null,
        last24h: { delivered: mine.reduce((n, r) => n + cargoUnits(r.delivered), 0),
          lost: endedRows.reduce((n, r) => n + r.lost, 0),
          convoys: Object.fromEntries(endedRows.map((r) => [r.state, r.convoys])) },
      };
    });
    return { available: true, state: st.state || null, lastRefusal: st.lastRefusal || null,
      counters: st.counters || null, factions };
  }

  function cacheKey() {
    if (call(() => store.isOpen(), false) !== true || !admitted()) return null;
    const st = call(() => deps.getStatus(), {}) || {};
    return `l${convoys.getChangeCount()}|${st.seq === undefined ? 0 : st.seq}|${Math.floor(clock.now() / DAY_MS)}`;
  }

  return { title: "Faction convoys", order: VIEW_ORDER, cacheKey, getData };
}

module.exports = { VIEW_ID, buildLogisticsView };
