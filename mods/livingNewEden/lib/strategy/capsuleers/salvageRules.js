"use strict";

const { salvageTimes } = require("../../fleets/salvageOps");
const { claimShare } = require("../../world/wreckPool");
const { SALVAGE_ACTIVE_STATES, SALVAGE_TERMINAL_STATES } = require("../../world/salvageSchema");
const { SALVAGE_TRIP_KIND } = require("./schema");
const { CAPSULEER_ROLE } = require("./rattingRules");

const WRECK_ACTIVE = "ACTIVE";
const byFleetId = (a, b) => (a.fleetId < b.fleetId ? -1 : a.fleetId > b.fleetId ? 1 : 0);
const limitOf = (v) => (Number.isSafeInteger(v) && v > 0 ? v : 0);
const refuse = (reason) => ({ ok: false, reason });

function fieldEligible(c, params) {
  try {
    const f = c && c.field;
    if (!f || f.state !== WRECK_ACTIVE || !(f.expiresAt > c.at)) return refuse("NOT_ACTIVE");
    if (f.materializedAt !== null && f.materializedAt !== undefined) return refuse("MATERIALIZED");
    if (!(c.pool > 0)) return refuse("EMPTY");
    const sp = params.salvageParams || {};
    const share = claimShare(f, c.at, sp.claimPermille === undefined ? 1000 : sp.claimPermille);
    if (!share.ok || share.empty) return refuse("EMPTY");
    const winner = f.winnerFactionId === undefined ? null : f.winnerFactionId;
    const own = winner === null || winner === params.capsuleerFactionId;
    if (c.jobKnown !== false && c.job) {
      if (SALVAGE_ACTIVE_STATES.includes(c.job.state) || !SALVAGE_TERMINAL_STATES.includes(c.job.state)) {
        return refuse("JOB_ACTIVE");
      }
    } else if (!own) return refuse("FACTION_FIELD");
    const t = salvageTimes(params.salvageParams, { jumps: c.jumps, shipsLost: f.shipsLost });
    if (!t.ok) return refuse("PLAN_INVALID");
    if (c.at + t.travelMs + t.recoveryMs >= f.expiresAt) return refuse("TOO_LATE");
    return { ok: true };
  } catch (_err) {
    return refuse("PLAN_INVALID");
  }
}

function planSalvageDispatches(snap, params) {
  const out = [];
  try {
    const max = limitOf(params && params.maxSalvageDispatchesPerReview);
    if (!snap || snap.fleetsTruncated === true || params.salvageEnabled !== true || max === 0) return out;
    const busy = snap.openTripFleetIds instanceof Set ? snap.openTripFleetIds : new Set();
    const open = snap.openFieldIds instanceof Set ? snap.openFieldIds : new Set();
    const bySlot = snap.fieldsBySlot instanceof Map ? snap.fieldsBySlot : new Map();
    const used = new Set();
    const fleets = [...(snap.fleets || [])].filter((f) => f).sort(byFleetId);
    const corps = [...(snap.corps || [])].filter((c) => c && c.state === "ACTIVE" && c.corporationId)
      .sort((a, b) => a.corpSlot - b.corpSlot);
    for (const corp of corps) {
      for (const f of fleets) {
        if (out.length >= max) return out;
        if (f.corporationId !== corp.corporationId || f.fleetRole !== CAPSULEER_ROLE || f.state !== "IDLE"
          || f.refitPending === true || f.currentSystemId !== corp.baseSystemId || busy.has(f.fleetId)) continue;
        const pick = (bySlot.get(corp.corpSlot) || []).find((x) => x && !open.has(x.fieldId) && !used.has(x.fieldId));
        if (!pick) continue;
        used.add(pick.fieldId);
        out.push({ kind: SALVAGE_TRIP_KIND, slot: corp.corpSlot, fleetId: f.fleetId, expectedVersion: f.version,
          targetSystemId: pick.systemId, fieldId: pick.fieldId });
      }
    }
    return out;
  } catch (_err) {
    return out;
  }
}

module.exports = { fieldEligible, planSalvageDispatches, SALVAGE_TRIP_KIND };
