"use strict";

const VIEW_ID = "construction";
const VIEW_ORDER = 56;
const WORK_CLASS = "MAINTENANCE";
const ENDED_ROWS = 20;
const PERCENT = 100;

function call(obj, name) {
  try {
    return obj && typeof obj[name] === "function" ? obj[name]() : undefined;
  } catch (_err) {
    return undefined;
  }
}

const sum = (o) => Object.keys(o || {}).reduce((n, k) => n + Math.max(0, Number(o[k]) || 0), 0);

function kitPercent(b) {
  const required = sum(b.required);
  if (required === 0) return PERCENT;
  let got = 0;
  for (const k of Object.keys(b.required)) got += Math.min(b.required[k], (b.delivered && b.delivered[k]) || 0);
  return Math.floor((got * PERCENT) / required);
}

function buildConstructionView(deps) {
  const { store, builds } = deps;
  const getGovernor = typeof deps.getGovernor === "function" ? deps.getGovernor : () => null;
  const names = deps.factionNames instanceof Map ? deps.factionNames : new Map();
  const maxRows = Math.max(1, Math.trunc(Number(deps.maxRows) || 1));

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

  const common = (b) => ({ station: b.stationId, faction: names.get(b.factionId) || b.factionId,
    system: systemName(b.systemId) || b.systemId, state: b.state });

  function getData() {
    if (call(store, "isOpen") !== true) return { available: false, reason: "STORE_CLOSED" };
    if (!admitted()) return { available: false, reason: "GOVERNOR_HOLD" };
    const tx = store.transaction("observer.construction", (db) => {
      const open = builds.listOpen(db, { limit: maxRows + 1 });
      if (!open.ok) return open;
      const ended = builds.listRecentEnded(db, { limit: ENDED_ROWS });
      if (!ended.ok) return ended;
      return { ok: true, open: open.builds, ended: ended.builds };
    });
    const read = tx.ok ? tx.value : tx;
    if (!tx.ok || !read || !read.ok) return { available: false, reason: String((read && read.reason) || "TX_FAILED") };
    const st = call({ getStatus: deps.getStatus }, "getStatus") || {};
    return {
      available: true,
      state: st.state || null,
      mode: st.mode || null,
      kitId: st.kitId || null,
      kitUnits: Number.isSafeInteger(st.kitUnits) ? st.kitUnits : null,
      kitFactorPermille: Number.isSafeInteger(st.kitFactorPermille) ? st.kitFactorPermille : null,
      counters: st.counters || null,
      lastRefusal: st.lastRefusal || null,
      truncated: read.open.length > maxRows,
      open: read.open.slice(0, maxRows).map((b) => ({ ...common(b), kitPercent: kitPercent(b),
        convoysDelivered: b.convoysDelivered, convoysLost: b.convoysLost,
        deadlineAt: b.state === "ANCHORING" ? b.anchorUntilAt : b.supplyDeadlineAt })),
      ended: read.ended.map((b) => ({ ...common(b), reason: b.endReason, endedAt: b.endedAt,
        lostUnits: b.lostUnits })),
    };
  }

  function cacheKey() {
    if (call(store, "isOpen") !== true || !admitted()) return null;
    const st = call({ getStatus: deps.getStatus }, "getStatus") || {};
    return `c${builds.getChangeCount()}|${st.seq === undefined ? 0 : st.seq}`;
  }

  return { title: "Station construction", order: VIEW_ORDER, cacheKey, getData };
}

module.exports = { VIEW_ID, buildConstructionView, kitPercent };
