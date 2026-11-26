"use strict";

const VIEW_ID = "materialization";
const VIEW_ORDER = 46;

const HUNT_PHASE_LABELS = Object.freeze({ SWEEP_DWELL: "holding at object", SWEEP_WARP: "warping to object",
  SCAN: "scanning", WARP_TO_TARGET: "warping to quarry", ENGAGED: "fighting" });
const HUNT_MODE_LABELS = Object.freeze({ SWEEP: "object sweep", SCAN: "scanner" });
const HUNT_STATE_LABELS = Object.freeze({ SPAWNING: "spawn", LIVE: "live", ENDING: "ending" });
const PATROL_PHASE_LABELS = Object.freeze({ PATROL_DWELL: "holding at object", PATROL_WARP: "warping to object",
  CAMP_HOLD: "gate camp", ENGAGED: "fighting", CAMP_WARP: "warping to exit gate" });
const PATROL_MODE_LABELS = Object.freeze({ PATROL: "patrol", GATE_CAMP: "gate camp" });
const SECOND_MS = 1000;
const MINUTE_S = 60;

function safeCall(fn) {
  try {
    return typeof fn === "function" ? fn() : null;
  } catch (_err) {
    return null;
  }
}

function durationText(ms) {
  if (!Number.isFinite(ms)) return "-";
  const s = Math.max(0, Math.floor(ms / SECOND_MS));
  const m = Math.floor(s / MINUTE_S);
  const rest = s - (m * MINUTE_S);
  return m > 0 ? `${m}m ${String(rest).padStart(2, "0")}s` : `${rest}s`;
}

function buildMaterializationView(deps) {
  let factionNames = null;

  function namesOnce() {
    if (factionNames !== null && factionNames.size > 0) return factionNames;
    const names = safeCall(deps.readFactionNames);
    const map = names instanceof Map ? names : new Map();
    if (map.size > 0) factionNames = map;
    return map;
  }

  function factionName(names, id) {
    return names.get(id) || String(id);
  }

  function systemName(id) {
    const g = safeCall(deps.getGraph);
    const res = g && typeof g.getGraph === "function" ? safeCall(() => g.getGraph()) : null;
    const vertex = res && res.ok === true && res.graph ? safeCall(() => res.graph.getSystem(id)) : null;
    return vertex && vertex.name ? vertex.name : String(id);
  }

  function huntsSection(h) {
    if (!h || h.state === "off") return { enabled: false, active: 0, rows: [] };
    const now = deps.clock && typeof deps.clock.now === "function" ? safeCall(() => deps.clock.now()) : null;
    const list = Array.isArray(h.hunts) ? h.hunts : [];
    const chase = Array.isArray(h.pursuits) ? h.pursuits : [];
    const names = list.length > 0 || chase.length > 0 ? namesOnce() : null;
    return {
      enabled: h.enabled === true,
      lossImport: h.lossImport,
      active: h.active,
      ships: h.ships,
      rows: list.map((x) => ({
        huntId: x.huntId,
        system: systemName(x.systemId),
        frakcja: factionName(names, x.factionId),
        ofiara: x.quarryName || String(x.characterId),
        tryb: x.mode,
        trybEtykieta: HUNT_MODE_LABELS[x.mode] || x.mode,
        stan: x.state,
        faza: x.phase,
        fazaEtykieta: x.state === "LIVE" ? HUNT_PHASE_LABELS[x.phase] || x.phase
          : HUNT_STATE_LABELS[x.state] || x.state,
        cykl: x.mode === "SCAN" ? x.scanCycle : null,
        statki: `${x.alive}/${x.ships}`,
        czas: Number.isFinite(now) && Number.isFinite(x.liveSince) ? durationText(now - x.liveSince) : "-",
      })),
      pursuits: chase.map((p) => ({
        chainId: p.chainId,
        fleetId: p.fleetId,
        frakcja: factionName(names, p.factionId),
        ofiara: p.quarryName || String(p.characterId),
        skad: systemName(p.fromSystemId),
        dokad: systemName(p.targetSystemId),
        skoki: p.hops,
        arriveAt: Number.isFinite(p.arriveAt) ? p.arriveAt : null,
        przylotZa: Number.isFinite(now) && Number.isFinite(p.arriveAt) ? durationText(p.arriveAt - now) : "-",
      })),
      counters: h.counters,
      lastRefusal: h.lastRefusal || null,
    };
  }

  function patrolsSection(p) {
    if (!p || p.state === "off") return { enabled: false, active: 0, rows: [] };
    const now = deps.clock && typeof deps.clock.now === "function" ? safeCall(() => deps.clock.now()) : null;
    const list = Array.isArray(p.list) ? p.list : [];
    const names = list.length > 0 ? namesOnce() : null;
    return {
      tytul: "Garrison patrols",
      enabled: p.enabled === true,
      lossImport: p.lossImport,
      active: p.active,
      ships: p.ships,
      rows: list.map((x) => ({
        huntId: x.huntId,
        system: systemName(x.systemId),
        frakcja: factionName(names, x.factionId),
        tryb: x.mode,
        trybEtykieta: PATROL_MODE_LABELS[x.mode] || x.mode,
        stan: x.state,
        faza: x.phase,
        fazaEtykieta: x.state === "LIVE" ? PATROL_PHASE_LABELS[x.phase] || x.phase
          : HUNT_STATE_LABELS[x.state] || x.state,
        statki: `${x.alive}/${x.ships}`,
        czas: Number.isFinite(now) && Number.isFinite(x.liveSince) ? durationText(now - x.liveSince) : "-",
      })),
      counters: p.counters,
      lastRefusal: p.lastRefusal || null,
    };
  }

  function getData() {
    const st = safeCall(() => deps.getStatus({ alive: true }));
    if (!st) return { available: false, reason: "STATUS_UNAVAILABLE" };
    const battle = safeCall(deps.getBattleStatus);
    const bc = (battle && battle.counters) || {};
    const refused = Number(bc["liveRecover.refused"]) || 0;
    const pending = Array.isArray(st.revertPending) ? st.revertPending : [];
    const budget = st.budget || null;
    return {
      available: true,
      alarm: {
        raised: pending.length > 0 || refused > 0,
        revertPending: pending.map((p) => ({ battleId: p.battleId, systemId: p.systemId, claimSeq: p.claimSeq,
          reason: p.reason, attempts: p.attempts })),
        liveRecoverRefused: refused,
      },
      liveRecoverStaleOwned: Number(bc["liveRecover.staleOwned"]) || 0,
      state: st.state,
      bootAt: st.bootAt,
      passes: st.passes,
      budget: budget ? { limits: budget.limits, reservedShips: budget.reservedShips,
        availableShips: budget.availableShips, reservationCount: budget.reservationCount,
        reservedBySystem: budget.reservedBySystem } : null,
      live: st.live,
      spawning: st.spawning,
      strays: st.strays,
      failedBattles: st.failedBattles,
      failedRecent: st.failedRecent,
      counters: st.counters,
      lastRefusal: st.lastRefusal,
      hunts: huntsSection(st.hunts),
      patrols: patrolsSection(st.patrols),
    };
  }

  return { title: "Live materialization", order: VIEW_ORDER, listed: true, getData };
}

module.exports = { VIEW_ID, VIEW_ORDER, buildMaterializationView };
