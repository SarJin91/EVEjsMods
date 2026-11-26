"use strict";

const VIEW_ID = "player-sov";
const VIEW_ORDER = 65;
const WORK_CLASS = "MAINTENANCE";
const NAME_BATCH = 32;
const ROW_KEYS = Object.freeze(["claimId", "systemId", "system", "allianceId", "alliance", "corpId", "corp", "state",
  "baseState", "attackerFactionId", "attacker", "reinforcedUntil", "clockCreditedMs", "clockNeedMs", "origin",
  "firstSeenAt", "heldSinceAt", "endReason", "endedAt"]);

function call(fn, fallback) {
  try {
    return fn();
  } catch (_err) {
    return fallback;
  }
}

function buildDisabledPlayerSovView(reason) {
  return { title: "Player sovereignty", order: VIEW_ORDER,
    getData: () => ({ available: false, reason: "disabled", detail: String(reason) }) };
}

function orgNamesOf(readOrgNames, claims) {
  const alliances = new Map();
  const corps = new Map();
  if (typeof readOrgNames !== "function") return { alliances, corps };
  const aIds = [...new Set(claims.map((c) => c.allianceId).filter(Number.isSafeInteger))];
  const cIds = [...new Set(claims.map((c) => c.corpId).filter(Number.isSafeInteger))];
  for (let i = 0; i < Math.max(aIds.length, cIds.length); i += NAME_BATCH) {
    const r = call(() => readOrgNames({ allianceIds: aIds.slice(i, i + NAME_BATCH),
      corpIds: cIds.slice(i, i + NAME_BATCH) }), null);
    if (!r || r.ok !== true) continue;
    if (r.alliances instanceof Map) for (const [id, n] of r.alliances) alliances.set(id, n);
    if (r.corps instanceof Map) for (const [id, n] of r.corps) corps.set(id, n);
  }
  return { alliances, corps };
}

function buildPlayerSovView(deps) {
  const { store, repository } = deps;
  const getGovernor = typeof deps.getGovernor === "function" ? deps.getGovernor : () => null;
  const names = deps.factionNames instanceof Map ? deps.factionNames : new Map();
  const maxRows = Math.max(1, Math.trunc(Number(deps.maxRows) || 1));
  const clockRepo = deps.clockRepo && typeof deps.clockRepo.get === "function" ? deps.clockRepo : null;
  const needMs = deps.needMs || {};

  function admitted() {
    const governor = call(getGovernor, null);
    return !governor || typeof governor.admits !== "function" || call(() => governor.admits(WORK_CLASS), true) !== false;
  }

  function systemName(id) {
    const res = deps.graph && typeof deps.graph.getGraph === "function" ? call(() => deps.graph.getGraph(), null) : null;
    const vertex = res && res.ok === true && res.graph ? call(() => res.graph.getSystem(id), null) : null;
    return vertex && typeof vertex.name === "string" ? vertex.name : null;
  }

  const nameOf = (f) => (f === null ? null : (names.get(f) || null));
  const labelOf = (map, id) => (id === null || id === undefined ? null : (map.get(id) || String(id)));

  function clockOf(db, c) {
    if (clockRepo === null || !Number.isSafeInteger(needMs[c.state])) return null;
    const k = clockRepo.get(db, c.claimId);
    const clock = k && k.ok ? k.clock : null;
    const same = clock && clock.phase === c.state && clock.phaseKey === c.attackStartedAt;
    return { creditedMs: same ? clock.creditedMs : 0, needMs: needMs[c.state] };
  }

  function getData() {
    if (call(() => store.isOpen(), false) !== true) return { available: false, reason: "STORE_CLOSED" };
    if (!admitted()) return { available: false, reason: "GOVERNOR_HOLD" };
    const tx = store.transaction("observer.playerSov", (db) => {
      const r = repository.listForPanel(db, maxRows);
      if (!r || !r.ok) return r;
      return { ...r, clocks: r.claims.map((c) => clockOf(db, c)) };
    });
    const read = tx.ok ? tx.value : tx;
    if (!tx.ok || !read || !read.ok) return { available: false, reason: String((read && read.reason) || "TX_FAILED") };
    const org = orgNamesOf(deps.readOrgNames, read.claims);
    const rows = read.claims.map((c, i) => ({ claimId: c.claimId, systemId: c.systemId, system: systemName(c.systemId),
      allianceId: c.allianceId, alliance: labelOf(org.alliances, c.allianceId), corpId: c.corpId,
      corp: labelOf(org.corps, c.corpId), state: c.state, baseState: c.baseState,
      attackerFactionId: c.attackerFactionId, attacker: nameOf(c.attackerFactionId), reinforcedUntil: c.reinforcedUntil,
      clockCreditedMs: read.clocks[i] ? read.clocks[i].creditedMs : null,
      clockNeedMs: read.clocks[i] ? read.clocks[i].needMs : null,
      origin: c.origin, firstSeenAt: c.firstSeenAt, heldSinceAt: c.heldSinceAt, endReason: c.endReason,
      endedAt: c.endedAt }));
    return { available: true, claims: rows, truncated: read.truncated };
  }

  return { title: "Player sovereignty", order: VIEW_ORDER, getData };
}

module.exports = { VIEW_ID, ROW_KEYS, buildPlayerSovView, buildDisabledPlayerSovView };
