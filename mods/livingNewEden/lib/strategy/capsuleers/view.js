"use strict";

const VIEW_ID = "capsuleers";
const VIEW_ORDER = 205;

function safeCall(fn, fallback) {
  try {
    return typeof fn === "function" ? fn() : fallback;
  } catch (_err) {
    return fallback;
  }
}

function buildCapsuleersView(deps) {
  function cacheKey() {
    const st = safeCall(deps.getStatus, null);
    const vc = safeCall(deps.getVirtualCorps, null);
    const mv = vc && typeof vc.getMapVersion === "function" ? safeCall(() => vc.getMapVersion(), 0) : 0;
    const tv = safeCall(deps.getTripsVersion, 0) || 0;
    const cv = safeCall(deps.getContractsVersion, 0) || 0;
    const lv = safeCall(deps.getClaimsVersion, 0) || 0;
    return `caps-r${st && st.lastRound !== null && st.lastRound !== undefined ? st.lastRound : "-"}-v${mv}-t${tv}`
      + `-c${cv}-l${lv}`;
  }

  function getData() {
    const st = safeCall(deps.getStatus, null);
    if (!st) return { available: false, reason: "STATUS_UNAVAILABLE" };
    const corps = safeCall(deps.listCorps, []) || [];
    const rows = corps.map((c) => ({
      slot: c.corpSlot,
      corporation: `${c.name} [${c.ticker}]`,
      state: c.reason ? `${c.state} (${c.reason})` : c.state,
      base: `${c.baseSystemId} / ${c.baseStationId}`,
      isk: c.iskBalance,
      fleets: `${c.fleetsAlive || 0}/${c.fleetsBought}`,
      corporationId: c.corporationId || "-",
    }));
    const trips = (safeCall(deps.listTrips, []) || []).map((t) => ({
      slot: t.corpSlot,
      fleet: t.fleetId,
      kind: t.kind,
      state: t.abortReason ? `${t.state} (${t.abortReason})` : t.state,
      target: t.targetSystemId || "-",
      round: t.watchRound,
      kills: t.kills,
      haul: t.haulUnits || 0,
      isk: t.iskEarned,
    }));
    const contracts = (safeCall(deps.listContracts, []) || []).map((c) => ({
      slot: c.corpSlot,
      fleet: c.fleetId,
      kind: c.kind,
      state: c.endReason ? `${c.state} (${c.endReason})` : c.state,
      employer: c.employerFactionId,
      enemy: c.enemyFactionId,
      target: c.targetSystemId,
      fee: c.feeIsk,
      paid: c.paidIsk,
      refunded: c.refundedIsk,
    }));
    const claims = (safeCall(deps.listClaims, []) || []).map((c) => ({
      slot: c.corpSlot,
      system: c.systemId,
      state: c.lostReason ? `${c.state} (${c.lostReason})` : c.state,
      since: c.state === "LOST" ? c.lostAt : c.claimedAt,
    }));
    return { available: true, state: st.state, lastRound: st.lastRound, lastRefusal: st.lastRefusal,
      counters: st.counters, rows, trips, contracts, claims };
  }

  return { title: "Capsuleer Corporations", order: VIEW_ORDER, listed: true, cacheKey, getData };
}

module.exports = { VIEW_ID, VIEW_ORDER, buildCapsuleersView };
