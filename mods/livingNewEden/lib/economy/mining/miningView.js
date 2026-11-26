"use strict";

const { MINERALS } = require("../data/mineralYield");
const { cargoUnits } = require("./yield");
const S = require("../schema");

const VIEW_ID = "mining";
const VIEW_ORDER = 57;
const WORK_CLASS = "MAINTENANCE";
const DAY_MS = 86400000;
const TOP_BELTS = 5;
const LIVE_STATES = Object.freeze(["IDLE", "PLANNED", "TRAVELLING", "STAGED", "ENGAGED", "RETREATING", "REFITTING",
  "MATERIALIZED"]);
const MAX_RECENT_TRIPS = 5000;

function call(fn, fallback) {
  try {
    return fn();
  } catch (_err) {
    return fallback;
  }
}

function buildMiningView(deps) {
  const { store, trips, clock } = deps;
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
    const vertex = res && res.ok === true && res.graph ? res.graph.getSystem(id) : null;
    return vertex ? vertex.name : id;
  }

  function stockChanges() {
    const st = typeof deps.getStations === "function" ? call(deps.getStations, null) : null;
    const repo = st && st.repository;
    return repo && typeof repo.getChangeCount === "function" ? call(() => repo.getChangeCount(), 0) : 0;
  }

  function getData() {
    if (call(() => store.isOpen(), false) !== true) return { available: false, reason: "STORE_CLOSED" };
    if (!admitted()) return { available: false, reason: "GOVERNOR_HOLD" };
    const since = Math.max(0, clock.now() - DAY_MS);
    const tx = store.transaction("observer.mining", (db) => {
      const totals = trips.listTotals(db);
      if (!totals.ok) return totals;
      const open = trips.openCounts(db);
      if (!open.ok) return open;
      const ended = trips.recentEnded(db, since);
      if (!ended.ok) return ended;
      const delivered = trips.recentDelivered(db, since, MAX_RECENT_TRIPS);
      if (!delivered.ok) return delivered;
      const miners = db.prepare(`SELECT faction_id, state, count(*) AS n FROM virtual_fleets WHERE fleet_role = ?
        AND state IN (SELECT value FROM json_each(?)) GROUP BY faction_id, state`)
        .all(S.MINING_ROLE, JSON.stringify(LIVE_STATES));
      const stock = db.prepare(`SELECT s.owner_faction_id AS faction_id, k.item_key AS item_key,
        sum(k.quantity) AS quantity FROM world_station_stock k JOIN world_stations s ON s.station_id = k.station_id
        WHERE k.item_kind = ? AND s.state <> 'DESTROYED' GROUP BY s.owner_faction_id, k.item_key`)
        .all(S.MINERAL_ITEM_KIND);
      return { ok: true, totals: totals.totals, open: open.rows, ended: ended.rows, delivered: delivered.rows, miners,
        stock };
    });
    const read = tx.ok ? tx.value : tx;
    if (!tx.ok || !read || !read.ok) return { available: false, reason: String((read && read.reason) || "TX_FAILED") };
    const ids = new Set(call(() => (typeof deps.factionIds === "function" ? deps.factionIds() : []), []));
    for (const list of [read.totals, read.open, read.ended, read.miners, read.stock]) {
      for (const r of list) ids.add(r.factionId === undefined ? r.faction_id : r.factionId);
    }
    const st = call(() => deps.getStatus(), {}) || {};
    const factions = [...ids].filter((id) => Number.isSafeInteger(id)).sort((a, b) => a - b).map((f) => {
      const minerRows = read.miners.filter((r) => r.faction_id === f);
      const openRows = read.open.filter((r) => r.faction_id === f);
      const onTrip = openRows.reduce((n, r) => n + r.n, 0);
      const live = minerRows.reduce((n, r) => n + r.n, 0);
      const idle = minerRows.filter((r) => r.state === "IDLE").reduce((n, r) => n + r.n, 0);
      const t = read.totals.find((x) => x.factionId === f) || null;
      const endedRows = read.ended.filter((r) => r.faction_id === f);
      const mine = read.delivered.filter((r) => r.factionId === f);
      const byBelt = new Map();
      for (const r of mine) byBelt.set(r.beltSystemId, (byBelt.get(r.beltSystemId) || 0) + cargoUnits(r.delivered));
      const stock = read.stock.filter((r) => r.faction_id === f).sort((a, b) => b.quantity - a.quantity)
        .map((r) => ({ mineral: MINERALS[r.item_key.slice("type:".length)] || r.item_key, quantity: r.quantity }));
      return {
        faction: names.get(f) || f,
        miners: { live, idle, onTrip },
        trips: Object.fromEntries(S.OPEN_TRIP_STATES.map((s) => [s, openRows.filter((r) => r.state === s)
          .reduce((n, r) => n + r.n, 0)])),
        totals: t ? { started: t.tripsStarted, delivered: t.tripsDelivered, aborted: t.tripsAborted, lost: t.tripsLost,
          oreM3: t.oreUnits, mineralUnits: t.mineralUnits, lostMineralUnits: t.lostMineralUnits } : null,
        last24h: { delivered: mine.reduce((n, r) => n + cargoUnits(r.delivered), 0),
          lost: endedRows.reduce((n, r) => n + r.lost, 0),
          trips: Object.fromEntries(endedRows.map((r) => [r.state, r.trips])) },
        mineralStock: { total: stock.reduce((n, r) => n + r.quantity, 0), minerals: stock },
        topBelts: [...byBelt.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, TOP_BELTS)
          .map(([id, units]) => ({ system: systemName(id), units })),
      };
    });
    return { available: true, state: st.state || null, lastRefusal: st.lastRefusal || null,
      counters: st.counters || null, factions };
  }

  function cacheKey() {
    if (call(() => store.isOpen(), false) !== true || !admitted()) return null;
    const st = call(() => deps.getStatus(), {}) || {};
    return `m${trips.getChangeCount()}|${st.seq === undefined ? 0 : st.seq}|${stockChanges()}|`
      + `${Math.floor(clock.now() / DAY_MS)}`;
  }

  return { title: "Faction mining", order: VIEW_ORDER, cacheKey, getData };
}

module.exports = { VIEW_ID, buildMiningView };
