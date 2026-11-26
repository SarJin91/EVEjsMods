"use strict";

const { STATE: S, STATES, TYPE, END_REASON } = require("./schema");
const { phaseCountOf: heavyPhaseCountOf } = require("./catalog");
const P = require("./power/schema");
const { phaseCountOf: powerPhaseCountOf, pocketCountOf, pocketOfPhase, hasWaves } = require("./power/catalog");

const TRANSITIONS = Object.freeze({
  PLANNED: Object.freeze([S.ENGAGED, S.EXPIRED, S.CANCELLED]),
  ENGAGED: Object.freeze([S.ENGAGED, S.CLEARED, S.PLANNED, S.EXPIRED, S.FAILED, S.CANCELLED]),
  CLEARED: Object.freeze([S.COMPLETED]),
  COMPLETED: Object.freeze([]),
  FAILED: Object.freeze([]),
  EXPIRED: Object.freeze([]),
  CANCELLED: Object.freeze([]),
});

const isTime = (v) => Number.isSafeInteger(v) && v >= 0;

function canTransition(from, to) {
  if (!STATES.includes(from) || !STATES.includes(to)) return { ok: false, reason: "UNKNOWN_STATE", from, to };
  if (!TRANSITIONS[from].includes(to)) return { ok: false, reason: "TRANSITION_NOT_ALLOWED", from, to };
  return { ok: true };
}

function decidePlanned(row, facts) {
  if (!row || row.state !== S.PLANNED || !facts || !isTime(facts.now)) {
    return { action: "WAIT", reason: "INVALID_INPUT" };
  }
  if (isTime(row.expiresAt) && facts.now >= row.expiresAt) return { action: "EXPIRE", reason: "EXPIRED" };
  if (facts.causeHolds === false) return { action: "CANCEL", reason: "CANCELLED" };
  if (facts.siteActive !== true) return { action: "WAIT", reason: "SITE_NOT_ACTIVE" };
  if (facts.sceneLoaded !== true) return { action: "WAIT", reason: "SCENE_NOT_LOADED" };
  if (!(facts.gridPlayers >= 1)) return { action: "WAIT", reason: "NO_PLAYER" };
  return { action: "ENGAGE" };
}

function decideEngaged(row, facts, cfg) {
  if (!row || row.state !== S.ENGAGED || !facts || !isTime(facts.now) || !cfg) {
    return { action: "HOLD", reason: "INVALID_INPUT" };
  }
  const isPower = P.isPowerType(row.eventType);
  const powerParams = isPower && row.eventType === P.TYPE.MUSTER
    ? { trailPockets: cfg.trailPockets, musterWaves: cfg.musterWaves, musterWaveGrowthPermille: cfg.musterWaveGrowthPermille }
    : { trailPockets: cfg.trailPockets };
  const phases = isPower
    ? powerPhaseCountOf(row.eventType, row.tier, row.variant, powerParams)
    : heavyPhaseCountOf(row.eventType, row.tier, cfg, row.variant);
  if (phases === null || !Number.isSafeInteger(row.phase)) return { action: "HOLD", reason: "INVALID_INPUT" };
  const now = facts.now;
  if (isTime(row.engagedAt) && now >= row.engagedAt + cfg.engagedMaxMs) return { action: "FAIL", reason: "TIMEOUT" };
  const integrity = facts.integrity !== undefined && facts.integrity !== null ? facts.integrity : row.integrity;
  if (row.eventType === TYPE.DEFENSE && typeof integrity === "number" && integrity <= 0) {
    return { action: "FAIL", reason: "INTEGRITY" };
  }
  if (facts.sceneLoaded !== true) return { action: "ABANDON", reason: "SCENE_GONE" };
  if (!(facts.gridPlayers >= 1)) {
    const seen = isTime(facts.lastGridSeenAt) ? facts.lastGridSeenAt : row.engagedAt;
    if (!isTime(seen) || now - seen >= cfg.abandonGraceMs) return { action: "ABANDON", reason: "NO_PLAYER" };
    return { action: "HOLD", reason: "NO_PLAYER_GRACE" };
  }
  if (isPower && (row.eventType === P.TYPE.HUNT || row.eventType === P.TYPE.CONVOY)) {
    const left = Number.isSafeInteger(facts.haulersLeft) ? facts.haulersLeft : 0;
    if (row.eventType === P.TYPE.HUNT) {
      if (facts.objectiveDestroyed === true) return { action: "CLEAR" };
      if (left === 0) return { action: "FAIL", reason: END_REASON.ESCAPED };
    } else if (left === 0) {
      return facts.haulersDestroyed >= 1 ? { action: "CLEAR" } : { action: "FAIL", reason: END_REASON.ESCAPED };
    }
    const escapeAfterMs = Number.isSafeInteger(cfg.escapeAfterMs) ? cfg.escapeAfterMs : 0;
    if (escapeAfterMs > 0 && facts.escapeDue === true) return { action: "ESCAPE" };
  }
  const last = row.phase >= phases;
  if (facts.phaseAlive === 0) {
    if (Number.isSafeInteger(row.phase) && phases !== null && row.phase === phases) {
      return { action: "CLEAR" };
    }
    if (P.isPowerType(row.eventType)) {
      const trailParams = { trailPockets: cfg.trailPockets };
      const pockets = pocketCountOf(row.eventType, row.tier, row.variant, trailParams);
      const currentPocket = pocketOfPhase(row.eventType, row.tier, row.variant, row.phase, trailParams);
      if (pockets !== null && currentPocket !== null && currentPocket < pockets - 1) {
        return { action: "NEXT_POCKET", reason: "POCKET" };
      }
    }
    return { action: "NEXT_PHASE", reason: "PHASE_WIPED" };
  }
  if (hasWaves(row.eventType) && !last && isTime(row.dueAt) && now >= row.dueAt) {
    return { action: "NEXT_PHASE", reason: "WAVE_DUE" };
  }
  return { action: "HOLD" };
}

function abandonTargetOf(row, cfg) {
  const abandons = (row && Number.isSafeInteger(row.abandons) ? row.abandons : 0) + 1;
  return abandons >= cfg.maxAbandons ? S.EXPIRED : S.PLANNED;
}

module.exports = { TRANSITIONS, canTransition, decidePlanned, decideEngaged, abandonTargetOf };
