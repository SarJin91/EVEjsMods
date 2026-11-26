"use strict";

const { createRng, deriveSeed, stableHash32 } = require("../../util/rng");
const { EVASIVE_ROLES } = require("../../battle/data/contactRules");

const PRESENT_STATES = Object.freeze(["IDLE", "PLANNED", "STAGED", "REFITTING", "ENGAGED", "MATERIALIZED"]);
const VICTIM_ID_RANGE = 2147483646;
const CAPSULEER_ROLE = "capsuleer";
const MERC_ROLE = "mercenary";
const CAPSULEER_ROLES = Object.freeze([CAPSULEER_ROLE, MERC_ROLE]);
const SWEEP_STATES = Object.freeze(["STAGED", "PLANNED"]);
const byFleetId = (a, b) => (a.fleetId < b.fleetId ? -1 : a.fleetId > b.fleetId ? 1 : 0);
const limitOf = (v) => (Number.isSafeInteger(v) && v > 0 ? v : 0);

function planDispatches(snap, params) {
  const out = [];
  try {
    const ratMax = limitOf(params.maxDispatchesPerReview);
    const homeMax = limitOf(params.maxHomeDispatchesPerReview);
    if (!snap || snap.fleetsTruncated === true || (ratMax === 0 && homeMax === 0)) return out;
    const open = new Map(snap.openByTarget instanceof Map ? snap.openByTarget : []);
    const busy = snap.openTripFleetIds instanceof Set ? snap.openTripFleetIds : new Set();
    const fleets = [...(snap.fleets || [])].filter((f) => f).sort(byFleetId);
    const corps = [...(snap.corps || [])].filter((c) => c && c.state === "ACTIVE" && c.corporationId)
      .sort((a, b) => a.corpSlot - b.corpSlot);
    const homes = [];
    for (const corp of corps) {
      for (const f of fleets) {
        if (f.corporationId !== corp.corporationId || f.state !== "IDLE" || f.refitPending === true
          || busy.has(f.fleetId)) continue;
        if (f.currentSystemId !== corp.baseSystemId) {
          if (CAPSULEER_ROLES.includes(f.fleetRole)) {
            homes.push({ kind: "home", slot: corp.corpSlot, fleetId: f.fleetId, expectedVersion: f.version,
              targetSystemId: null });
          }
          continue;
        }
        if (f.fleetRole !== CAPSULEER_ROLE || params.rattingEnabled !== true || out.length >= ratMax) continue;
        const targets = (snap.targetsBySlot instanceof Map ? snap.targetsBySlot.get(corp.corpSlot) : null) || [];
        const ranked = targets.filter((t) => (open.get(t.systemId) || 0) < params.rattingMaxFleetsPerSystem)
          .map((t) => ({ systemId: t.systemId, jumps: t.jumps, open: open.get(t.systemId) || 0,
            claim: t.claim === true }))
          .sort((a, b) => a.open - b.open || (a.claim ? 1 : 0) - (b.claim ? 1 : 0) || a.jumps - b.jumps
            || a.systemId - b.systemId)
          .slice(0, Math.max(1, params.rattingTargetsTop));
        if (ranked.length === 0) continue;
        const pick = createRng(deriveSeed(corp.seed, "rat", snap.round, f.fleetId)).pick(ranked) || ranked[0];
        open.set(pick.systemId, pick.open + 1);
        out.push({ kind: "rat", slot: corp.corpSlot, fleetId: f.fleetId, expectedVersion: f.version,
          targetSystemId: pick.systemId });
      }
    }
    const n = homes.length;
    const start = n > 0 && Number.isSafeInteger(snap.round) ? ((snap.round % n) + n) % n : 0;
    for (let i = 0; i < Math.min(homeMax, n); i += 1) out.push(homes[(start + i) % n]);
    return out;
  } catch (_err) {
    return out;
  }
}

function planSweeps(fleets, openTripFleetIds, params) {
  try {
    const max = limitOf(params && params.orphanSweepsPerReview);
    if (!params || params.truncated === true || max === 0) return [];
    const busy = openTripFleetIds instanceof Set ? openTripFleetIds : new Set();
    return [...(fleets || [])].filter((f) => f && CAPSULEER_ROLES.includes(f.fleetRole)
      && SWEEP_STATES.includes(f.state) && f.operationId !== null && f.operationId !== undefined
      && !busy.has(f.fleetId)).sort(byFleetId).slice(0, max)
      .map((f) => ({ fleetId: f.fleetId, expectedVersion: f.version }));
  } catch (_err) {
    return [];
  }
}

function hostilesPresent(fleets, ctx) {
  try {
    if (ctx.truncated === true) return true;
    for (const f of fleets || []) {
      if (!f || f.factionId === ctx.selfFactionId || EVASIVE_ROLES.includes(f.fleetRole)) continue;
      if (ctx.isHostile(ctx.selfFactionId, f.factionId)) return true;
    }
    return false;
  } catch (_err) {
    return true;
  }
}

function stepKills(s, params) {
  const ids = Array.isArray(s && s.characterIds) ? s.characterIds.filter((v) => Number.isSafeInteger(v) && v > 0)
    : [];
  const k = Number.isSafeInteger(params.rattingKillsPerStep) && params.rattingKillsPerStep > 0
    ? params.rattingKillsPerStep : 0;
  if (ids.length === 0 || k === 0) return [];
  const out = [];
  for (let n = 0; n < k; n += 1) {
    out.push({ characterId: ids[(s.round * k + n) % ids.length], victimFactionId: s.victimFactionId,
      systemId: s.systemId, atMs: s.atMs,
      victimId: 1 + (stableHash32("capsuleer-kill", s.tripId, s.phaseSeq, s.round, n) % VICTIM_ID_RANGE) });
  }
  return out;
}

function bountyOf(kills, balance, params) {
  const want = Math.max(0, kills) * Math.max(0, params.rattingBountyIskPerKill);
  const room = params.maxIskBalance - balance;
  const v = Math.min(want, room);
  return Number.isSafeInteger(v) && v > 0 ? v : 0;
}

module.exports = { planDispatches, planSweeps, hostilesPresent, stepKills, bountyOf, PRESENT_STATES, VICTIM_ID_RANGE,
  CAPSULEER_ROLE, CAPSULEER_ROLES, MERC_ROLE };
