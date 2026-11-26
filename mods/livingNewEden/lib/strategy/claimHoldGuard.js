"use strict";

const { parseClaimHoldStates } = require("./ai/claimHold");
const { parseFleetRoleList } = require("../fleets/schema");

function claimHoldGuardOf(config) {
  const S = config && config.strategy;
  if (!S || S.claimHoldEnabled !== true) return null;
  const states = parseClaimHoldStates(S.claimHoldStates) || Object.freeze([]);
  const roles = parseFleetRoleList(S.claimHoldRoles) || Object.freeze([]);
  if (states.length === 0 || roles.length === 0) return null;
  return Object.freeze({ maxMs: S.claimHoldMaxMs, states, roles, readLimit: S.maxOpenOperationsRead });
}

function heldClaimSystemsOf(rows, factionId, at, guard) {
  const out = new Set();
  for (const x of rows || []) {
    if (!x || x.occupierFactionId !== factionId || !guard.states.includes(x.occupationState)) continue;
    if (!Number.isSafeInteger(x.lastStateChangeAt) || at - x.lastStateChangeAt >= guard.maxMs) continue;
    out.add(x.systemId);
  }
  return out;
}

function readClaimHoldInTx(db, world, factionId, at, guard) {
  if (!guard || !world || typeof world.listByOccupier !== "function") return { ok: true, holds: () => false };
  const o = world.listByOccupier(db, factionId, { limit: guard.readLimit });
  if (!o || o.ok !== true) return o || { ok: false, reason: "CLAIMS_READ_FAILED" };
  const systems = heldClaimSystemsOf(o.systems, factionId, at, guard);
  return { ok: true,
    holds: (f) => Boolean(f) && systems.has(f.currentSystemId) && guard.roles.includes(f.fleetRole) };
}

module.exports = { claimHoldGuardOf, heldClaimSystemsOf, readClaimHoldInTx };
