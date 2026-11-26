"use strict";

const { OPERATION_KINDS_V1 } = require("../data/operationKinds");
const { EVASIVE_ROLES } = require("../../battle/data/contactRules");

const DEFENDER_STATES = Object.freeze(["IDLE", "STAGED"]);
const NON_COMBAT_ROLES = Object.freeze(["logistics", "mining", "scout"]);
const OFFENSIVE_OPERATION_TYPES = Object.freeze([...new Set(OPERATION_KINDS_V1.filter((k) => k.offensive === true)
  .map((k) => k.operationType))].sort());
const TARGET_STAND_STATES = Object.freeze(["IDLE", "STAGED", "PLANNED", "REFITTING"]);
const PERMILLE = 1000;

const byId = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function isDefender(fleet, operation, settings) {
  try {
    if (!fleet || !settings.roles.includes(fleet.fleetRole) || !DEFENDER_STATES.includes(fleet.state)) return false;
    return !operation || !OFFENSIVE_OPERATION_TYPES.includes(operation.operationType);
  } catch (_err) {
    return false;
  }
}

function isStrikeOperation(op) {
  try {
    return Boolean(op) && op.operationType === "intercept" && op.objective === "destroy";
  } catch (_err) {
    return false;
  }
}

function isStrikeFleet(fleet, op, settings) {
  try {
    if (!fleet) return false;
    return isStrikeOperation(op) || !settings.roles.includes(fleet.fleetRole);
  } catch (_err) {
    return false;
  }
}

function pursuitWindowMs(settings) {
  return (1 + settings.returnMaxRounds) * settings.returnAfterMs
    + settings.maxPursuitAttempts * (settings.locateMs + settings.reactionJitterMs);
}

function activePursuitOf(visit, at, settings) {
  try {
    if (!visit || visit.purpose !== "PURSUIT" || typeof visit.targetFleetId !== "string" || !visit.targetFleetId) {
      return null;
    }
    if (!Number.isFinite(visit.arriveAt) || !Number.isFinite(at)) return null;
    return at - visit.arriveAt <= pursuitWindowMs(settings) ? visit.targetFleetId : null;
  } catch (_err) {
    return null;
  }
}

function decideResponse(input) {
  try {
    const { intruder, settings } = input;
    if (EVASIVE_ROLES.includes(intruder.fleetRole)) return { kind: "EVASIVE" };
    if (NON_COMBAT_ROLES.includes(intruder.fleetRole) && settings.chaseNonCombat !== true) {
      return { kind: "NON_COMBAT_SKIPPED" };
    }
    const hostile = (a, b) => {
      try {
        return input.isHostile(a, b) === true;
      } catch (_err) {
        return false;
      }
    };
    const defenders = (input.defenders || []).filter((d) => d.fleetId !== intruder.fleetId
      && Number.isFinite(d.strength) && d.strength > 0 && hostile(d.factionId, intruder.factionId));
    if (defenders.length === 0) return { kind: "NO_DEFENDERS" };
    if (defenders.some((d) => d.gridKey === intruder.gridKey)) return { kind: "IN_GRID" };
    const cooldown = input.cooldownFactions instanceof Set ? input.cooldownFactions : new Set();
    const open = defenders.filter((d) => !cooldown.has(d.factionId));
    if (open.length === 0) return { kind: "COOLDOWN" };
    const sums = new Map();
    for (const d of open) sums.set(d.factionId, (sums.get(d.factionId) || 0) + d.strength);
    const factionId = [...sums.entries()].sort((a, b) => (b[1] - a[1]) || (a[0] - b[0]))[0][0];
    const pursuits = input.pursuitsByFaction instanceof Map ? input.pursuitsByFaction.get(factionId) : undefined;
    const targets = pursuits instanceof Set ? pursuits : new Set();
    if (targets.has(intruder.fleetId) || targets.size >= settings.maxPursuitsPerSystem) return { kind: "BUSY" };
    let candidates = open.filter((d) => d.factionId === factionId && (d.pursuing === null || d.pursuing === undefined));
    if (intruder.gridKey !== input.cpGridKey && settings.minHoldAtCp > 0) {
      const hold = new Set(candidates.filter((d) => d.gridKey === input.cpGridKey).map((d) => d.fleetId).sort(byId)
        .slice(0, settings.minHoldAtCp));
      candidates = candidates.filter((d) => !hold.has(d.fleetId));
    }
    candidates.sort((a, b) => (a.etaMs - b.etaMs) || byId(a.fleetId, b.fleetId));
    const need = Math.max(1, Math.ceil(intruder.strength * settings.strengthRatioPermille / PERMILLE));
    const pursuers = [];
    let sum = 0;
    for (const d of candidates) {
      if (sum >= need || pursuers.length >= settings.maxPursuersPerIntruder) break;
      pursuers.push(d.fleetId);
      sum += d.strength;
    }
    if (sum < need) return { kind: "OUTMATCHED" };
    return { kind: "PURSUE", factionId, pursuers, need, sum };
  } catch (_err) {
    return { kind: "NO_DEFENDERS" };
  }
}

function decideStep(input) {
  try {
    const { phase, settings, self, target } = input;
    if (self.state === "ENGAGED") {
      if (input.round < settings.returnMaxRounds) return { kind: "WAIT_ENGAGED", round: input.round + 1 };
      return { kind: "STALE", reason: "ENGAGED_LIMIT" };
    }
    if (!DEFENDER_STATES.includes(self.state)) return { kind: "STALE", reason: "NOT_MOVABLE" };
    if (phase === "RETURN") return { kind: "RETURN", reason: "RETURN_DUE" };
    if (!target || !target.inSystem || !TARGET_STAND_STATES.includes(target.state)) {
      return { kind: "RETURN", reason: "TARGET_GONE" };
    }
    const pos = target.position;
    if (!pos || pos.kind === "transit") return { kind: "RETURN", reason: "TARGET_GONE" };
    if (pos.kind === "anchor" && self.gridKey !== null && pos.gridKey === self.gridKey) return { kind: "CONTACT" };
    if (phase === "LOCATE" && pos.kind === "anchor") return { kind: "RETARGET", attempts: input.attempt };
    if (input.attempt + 1 < settings.maxPursuitAttempts) return { kind: "LOCATE", attempt: input.attempt + 1 };
    return { kind: "RETURN", reason: "ATTEMPTS" };
  } catch (_err) {
    return { kind: "STALE", reason: "DECIDE_FAILED" };
  }
}

const STRIKE_TARGET_STATES = Object.freeze([...TARGET_STAND_STATES, "ENGAGED"]);

module.exports = { isDefender, decideResponse, decideStep, pursuitWindowMs, activePursuitOf, isStrikeOperation,
  isStrikeFleet, OFFENSIVE_OPERATION_TYPES, NON_COMBAT_ROLES, DEFENDER_STATES, STRIKE_TARGET_STATES };
