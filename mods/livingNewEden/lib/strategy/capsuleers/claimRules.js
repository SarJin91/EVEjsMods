"use strict";

const HELD = "HELD";
const LOST = "LOST";
const CLAIM_STATES = Object.freeze([HELD, LOST]);
const LOSS_REASONS = Object.freeze(["CONTROLLER", "NO_FLEET", "CORP_INACTIVE", "NO_ROW"]);
const NULLSEC = "nullsec";
const limitOf = (v) => (Number.isSafeInteger(v) && v > 0 ? v : 0);

function planClaims(snap, params) {
  const out = { losses: [], claims: [] };
  try {
    if (!snap || !params || params.claimsEnabled !== true) return out;
    const controllerOf = snap.controllerOf instanceof Map ? snap.controllerOf : new Map();
    const missing = snap.missing instanceof Set ? snap.missing : new Set();
    const excluded = snap.excludedRegionIds instanceof Set ? snap.excludedRegionIds : new Set();
    const known = (id) => controllerOf.has(id) || missing.has(id);
    const corps = [...(snap.corps || [])].filter((c) => c).sort((a, b) => a.corpSlot - b.corpSlot);
    const corpOf = new Map(corps.map((c) => [c.corpSlot, c]));
    const held = [...(snap.held || [])].filter((c) => c && c.state === HELD)
      .sort((a, b) => (a.claimId < b.claimId ? -1 : a.claimId > b.claimId ? 1 : 0));
    const lostIds = new Set();
    for (const claim of held) {
      const corp = corpOf.get(claim.corpSlot);
      let reason = null;
      if (!corp || corp.state !== "ACTIVE") reason = "CORP_INACTIVE";
      else if (!known(claim.systemId)) reason = null;
      else if (missing.has(claim.systemId)) reason = "NO_ROW";
      else if (controllerOf.get(claim.systemId) !== null) reason = "CONTROLLER";
      else if (snap.fleetsTruncated !== true && !snap.fleetNearClaim(claim)) reason = "NO_FLEET";
      if (!reason) continue;
      lostIds.add(claim.claimId);
      out.losses.push({ claimId: claim.claimId, slot: claim.corpSlot, systemId: claim.systemId,
        expectedVersion: claim.version, reason });
    }
    const maxReview = limitOf(params.maxClaimsPerReview);
    const maxCorp = limitOf(params.maxClaimsPerCorp);
    if (snap.fleetsTruncated === true || snap.heldTruncated === true || maxReview === 0 || maxCorp === 0) return out;
    const taken = new Set(held.map((c) => c.systemId));
    const keptBySlot = new Map();
    for (const c of held) {
      if (!lostIds.has(c.claimId)) keptBySlot.set(c.corpSlot, (keptBySlot.get(c.corpSlot) || 0) + 1);
    }
    const fleets = snap.fleets || [];
    const vertexOf = typeof snap.vertexOf === "function" ? snap.vertexOf : () => null;
    for (const corp of corps) {
      if (out.claims.length >= maxReview) break;
      if (corp.state !== "ACTIVE" || !corp.corporationId) continue;
      if (!fleets.some((f) => f && f.corporationId === corp.corporationId)) continue;
      if ((keptBySlot.get(corp.corpSlot) || 0) >= maxCorp) continue;
      const list = (snap.candidatesBySlot instanceof Map ? snap.candidatesBySlot.get(corp.corpSlot) : null) || [];
      const pick = list.filter((t) => {
        if (!t || !(t.jumps >= 1) || t.jumps > params.claimMaxJumps || taken.has(t.systemId)) return false;
        if (!controllerOf.has(t.systemId) || missing.has(t.systemId) || controllerOf.get(t.systemId) !== null) {
          return false;
        }
        const v = vertexOf(t.systemId);
        return Boolean(v && v.secClass === NULLSEC && !excluded.has(v.regionId));
      }).sort((a, b) => a.jumps - b.jumps || a.systemId - b.systemId)[0];
      if (!pick) continue;
      taken.add(pick.systemId);
      out.claims.push({ slot: corp.corpSlot, systemId: pick.systemId, jumps: pick.jumps });
    }
    return out;
  } catch (_err) {
    return { losses: [], claims: [] };
  }
}

module.exports = { planClaims, CLAIM_STATES, LOSS_REASONS, HELD, LOST };
