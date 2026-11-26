"use strict";

const VIEW_ID = "sov-structures";
const SYSTEM_VIEW_ID = "sov-structures-system";
const SYSTEM_PARAM = "system";
const VIEW_ORDER = 64;
const WORK_CLASS = "MAINTENANCE";
const ROW_KEYS = Object.freeze(["structureId", "systemId", "system", "factionId", "faction", "state", "origin",
  "dueAt", "onlineAt", "attackerFactionId", "attacker", "attackStartedAt", "endReason", "endedAt", "costIsk"]);

const isId = (v) => Number.isSafeInteger(v) && v > 0;

function call(fn, fallback) {
  try {
    return fn();
  } catch (_err) {
    return fallback;
  }
}

function buildSovStructuresViews(deps) {
  const { store, repository } = deps;
  const getGovernor = typeof deps.getGovernor === "function" ? deps.getGovernor : () => null;
  const names = deps.factionNames instanceof Map ? deps.factionNames : new Map();
  const maxRows = Math.max(1, Math.trunc(Number(deps.maxRows) || 1));

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

  function getData(systemId) {
    if (call(() => store.isOpen(), false) !== true) return { available: false, reason: "STORE_CLOSED" };
    if (!admitted()) return { available: false, reason: "GOVERNOR_HOLD" };
    const tx = store.transaction("observer.sovStructures", (db) => repository.listForPanel(db, systemId, maxRows));
    const read = tx.ok ? tx.value : tx;
    if (!tx.ok || !read || !read.ok) return { available: false, reason: String((read && read.reason) || "TX_FAILED") };
    const rows = read.structures.map((s) => ({ structureId: s.structureId, systemId: s.systemId,
      system: systemName(s.systemId), factionId: s.factionId, faction: nameOf(s.factionId), state: s.state,
      origin: s.origin, dueAt: s.dueAt, onlineAt: s.onlineAt, attackerFactionId: s.attackerFactionId,
      attacker: nameOf(s.attackerFactionId), attackStartedAt: s.attackStartedAt, endReason: s.endReason,
      endedAt: s.endedAt, costIsk: s.costIsk }));
    return { available: true, systemId, structures: rows, truncated: read.truncated };
  }

  return {
    all: { title: "Sovereignty structures", order: VIEW_ORDER, getData: () => getData(null) },
    system: { title: "Sovereignty structures of a system", listed: false, param: SYSTEM_PARAM,
      getData: (req) => getData(req && isId(req.param) ? req.param : null) },
  };
}

module.exports = { VIEW_ID, SYSTEM_VIEW_ID, ROW_KEYS, buildSovStructuresViews };
