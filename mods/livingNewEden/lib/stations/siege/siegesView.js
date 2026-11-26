"use strict";

const VIEW_ID = "sieges";
const VIEW_ORDER = 60;
const WORK_CLASS = "MAINTENANCE";

function call(obj, name) {
  try {
    return obj && typeof obj[name] === "function" ? obj[name]() : undefined;
  } catch (_err) {
    return undefined;
  }
}

function phaseLabel(phaseEndsAt, now) {
  const MS_PER_HOUR = 3600000;
  const remaining = Math.max(0, Math.ceil((phaseEndsAt - now) / MS_PER_HOUR));
  return `${remaining}h`;
}

function buildSiegesView(deps) {
  const { store, repository } = deps;
  const clock = deps.clock && typeof deps.clock.now === "function" ? deps.clock : { now: () => Date.now() };
  const getGovernor = typeof deps.getGovernor === "function" ? deps.getGovernor : () => null;
  const names = deps.factionNames instanceof Map ? deps.factionNames : new Map();
  const maxRows = Math.max(1, Math.trunc(Number(deps.maxRows) || 1));
  const getPlayerSiege = typeof deps.getPlayerSiege === "function" ? deps.getPlayerSiege : () => null;

  function playerSiegeReady() {
    try {
      const ps = getPlayerSiege();
      return ps && typeof ps.getMode === "function" && typeof ps.listOpen === "function" && ps.getMode() === "ready"
        ? ps : null;
    } catch (_err) {
      return null;
    }
  }

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
    const now = clock.now();
    const ps = playerSiegeReady();
    const tx = store.transaction("observer.sieges", (db) => {
      const open = repository.listOpen(db, { limit: maxRows });
      if (!open.ok) return open;
      const totals = repository.readTotals(db);
      if (!totals.ok) return totals;
      let player = null;
      if (ps) {
        try {
          player = ps.listOpen(db, { limit: maxRows });
        } catch (_err) {
          player = null;
        }
      }
      return { ok: true, sieges: open.sieges, truncated: open.truncated, totals: totals.totals,
        player: player && player.ok === true && Array.isArray(player.sieges) ? player : null };
    });
    const read = tx.ok ? tx.value : tx;
    if (!tx.ok || !read || !read.ok) return { available: false, reason: String((read && read.reason) || "TX_FAILED") };
    const st = call({ getStatus: deps.getStatus }, "getStatus") || {};
    const playerPart = ps ? { playerStructures: read.player ? {
      available: true,
      truncated: read.player.truncated === true,
      sieges: read.player.sieges.slice(0, maxRows).map((s) => ({
        siegeId: s.siegeId,
        system: systemName(s.systemId) || s.systemId,
        structureTypeId: s.structureTypeId,
        ownerCorpId: s.ownerCorpId,
        attacker: names.get(s.attackerFactionId) || s.attackerFactionId,
        state: s.state,
        phaseEndsAt: s.phaseEndsAt,
        phaseLabel: phaseLabel(s.phaseEndsAt, now),
      })),
    } : { available: false } } : {};
    return {
      available: true,
      state: st.state || null,
      truncated: read.truncated,
      sieges: read.sieges.map((s) => ({
        siege: s.siegeId,
        station: s.stationId,
        system: systemName(s.systemId) || s.systemId,
        attacker: names.get(s.attackerFactionId) || s.attackerFactionId,
        owner: names.get(s.ownerFactionId) || s.ownerFactionId,
        state: s.state,
        phaseEndsAt: s.phaseEndsAt,
        phaseLabel: phaseLabel(s.phaseEndsAt, now),
        waitRound: s.waitRound,
      })),
      totals: Object.fromEntries(
        Object.entries(read.totals).map(([factionId, t]) => [
          names.get(Number(factionId)) || factionId,
          {
            started: t.started,
            won: t.won,
            repelled: t.repelled,
            besieged: t.besieged,
            defended: t.defended,
            lostDestroyed: t.lost_destroyed,
            lostCaptured: t.lost_captured,
            sacked: t.sacked,
            gainedCaptured: t.gained_captured,
            stockUnitsLost: t.stock_units_lost,
          }
        ])
      ),
      ...playerPart,
    };
  }

  function cacheKey() {
    if (call(store, "isOpen") !== true || !admitted()) return null;
    const st = call({ getStatus: deps.getStatus }, "getStatus") || {};
    const key = `s${repository.getChangeCount()}|${st.seq === undefined ? 0 : st.seq}`;
    const ps = playerSiegeReady();
    if (!ps) return key;
    const pst = call(ps, "getStatus") || {};
    return `${key}|p${pst.seq === undefined ? 0 : pst.seq}`;
  }

  return { title: "Open sieges", order: VIEW_ORDER, cacheKey, getData };
}

module.exports = { VIEW_ID, buildSiegesView };