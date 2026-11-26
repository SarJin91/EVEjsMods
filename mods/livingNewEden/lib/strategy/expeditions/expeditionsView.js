"use strict";

const VIEW_ID = "expeditions";
const VIEW_ORDER = 62;
const WORK_CLASS = "MAINTENANCE";

function call(fn, fallback) {
  try {
    return fn();
  } catch (_err) {
    return fallback;
  }
}

function rowOf(e) {
  return {
    id: e.expeditionId,
    faction: e.factionId,
    state: e.state,
    system: e.systemId,
    presence: e.presencePermille,
    evacuateAt: e.evacuateAt,
    decisionAt: e.decisionAt,
    result: e.outcome === null || e.outcome === undefined ? null : `${e.outcome}/${e.endReason}`,
    fleet: e.fleetId,
    hold: e.holdOperationId || null,
    endedAt: e.endedAt,
  };
}

function buildExpeditionsView(deps) {
  const getGovernor = typeof deps.getGovernor === "function" ? deps.getGovernor : () => null;
  const refreshMs = Math.max(1, Math.trunc(Number(deps.refreshMs) || 1));

  function admitted() {
    const governor = call(getGovernor, null);
    return !governor || typeof governor.admits !== "function"
      || call(() => governor.admits(WORK_CLASS), true) !== false;
  }

  const storeOpen = () => call(() => deps.store.isOpen(), false) === true;

  function cacheKey() {
    if (!storeOpen() || !admitted()) return null;
    const st = call(() => deps.getStatus(), null) || {};
    const counters = st.counters || {};
    const sum = Object.values(counters).reduce((n, v) => n + (Number.isSafeInteger(v) ? v : 0), 0);
    const bucket = Math.floor(call(() => deps.clock.now(), 0) / refreshMs);
    return `x${sum}|${st.open === undefined ? "-" : st.open}|${bucket}`;
  }

  function getData() {
    if (!storeOpen()) return { available: false, reason: "STORE_CLOSED" };
    if (!admitted()) return { available: false, reason: "GOVERNOR_HOLD" };
    const read = call(() => deps.readPanel(), null);
    if (!read || read.ok !== true) return { available: false, reason: String((read && read.reason) || "READ_FAILED") };
    const st = call(() => deps.getStatus(), null) || {};
    return { available: true, state: st.state || null, lastRefusal: st.lastRefusal || null,
      counters: st.counters || null, open: read.open.map(rowOf), openTruncated: read.openTruncated === true,
      ended: read.ended.map(rowOf) };
  }

  return { title: "Wormhole expeditions", order: VIEW_ORDER, listed: true, cacheKey, getData };
}

module.exports = { VIEW_ID, VIEW_ORDER, buildExpeditionsView, rowOf };
