"use strict";

const STATUS_VIEW_ID = "sov-projection";
const VIEW_ORDER = 63;

function safeCall(fn) {
  try {
    return fn();
  } catch (_err) {
    return undefined;
  }
}

function buildSovProjectionStatusView(deps) {
  const getStatus = deps && typeof deps.getStatus === "function" ? deps.getStatus : null;
  const getGovernor = deps && typeof deps.getGovernor === "function" ? deps.getGovernor : null;

  function drainAdmitted() {
    const governor = getGovernor ? safeCall(getGovernor) : null;
    if (!governor || typeof governor.admits !== "function") return null;
    const admits = safeCall(() => governor.admits("OPERATIONAL"));
    return admits === undefined ? null : admits !== false;
  }

  function getData() {
    const st = getStatus ? safeCall(getStatus) : null;
    if (!st || typeof st !== "object") return { available: false, reason: "SOV_PROJECTION_STATUS_UNAVAILABLE" };
    return {
      available: true,
      state: st.state ?? null,
      syncState: st.syncState ?? null,
      scanning: st.scanning ?? null,
      lastSync: st.lastSync ?? null,
      defer: st.defer ?? null,
      budget: st.budget ?? null,
      pacer: st.pacer ?? null,
      verify: st.verify ?? null,
      resyncNeeded: st.resyncNeeded === true,
      drainAdmitted: drainAdmitted(),
    };
  }

  return {
    title: "Sov projection",
    order: VIEW_ORDER,
    getData,
    cacheKey: () => null,
  };
}

module.exports = { buildSovProjectionStatusView, STATUS_VIEW_ID, VIEW_ORDER };
