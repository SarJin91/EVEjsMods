"use strict";

const { stableHash32 } = require("../../util/rng");

const ALERT_EVENT = "GRID_DEFENSE_ALERT";
const STEP_EVENT = "GRID_DEFENSE_STEP";
const ALERT_PHASE = Object.freeze({ SEEN: "SEEN", LOCATE: "LOCATE" });
const STEP_PHASE = Object.freeze({ POST: "POST", ARRIVED: "ARRIVED", LOCATE: "LOCATE", RETURN: "RETURN",
  STRIKE: "STRIKE" });
const ALERT_KEYS = Object.freeze(["appearAt", "at", "fleetId", "legSeq", "moveSeq", "phase", "systemId"]);
const STEP_KEYS = Object.freeze(["at", "attempt", "fleetId", "legSeq", "moveSeq", "phase", "round", "systemId",
  "targetFleetId"]);
const MAX_ID = 64;

const isId = (v) => Number.isSafeInteger(v) && v > 0;
const isNonNeg = (v) => Number.isSafeInteger(v) && v >= 0;
const isFleetId = (v) => typeof v === "string" && v.length >= 1 && v.length <= MAX_ID;
const isPlain = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const sameKeys = (p, keys) => Object.keys(p).sort().join() === keys.join();

const alertKey = (systemId, fleetId, legSeq, moveSeq) => `gdef:${systemId}:${fleetId}:${legSeq}:${moveSeq}`;
const locateAlertKey = (seenKey) => `${seenKey}:loc`;
const stepKey = (fleetId, legSeq, moveSeq, tag) => `gdstep:${fleetId}:${legSeq}:${moveSeq}:${tag}`;
const stepTag = Object.freeze({ post: () => "post", arr: () => "arr", loc: (n) => `loc${n}`, ret: (n) => `ret${n}`,
  sp: (n) => `sp${n}`, strike: () => "strike" });

function jitterOf(worldSeed, key, jitterMs) {
  if (!Number.isSafeInteger(jitterMs) || jitterMs <= 0) return 0;
  return stableHash32(Number.isSafeInteger(worldSeed) ? worldSeed : 0, key) % (jitterMs + 1);
}

function parseAlertPayload(p) {
  if (!isPlain(p) || !sameKeys(p, ALERT_KEYS)) return null;
  if (!isId(p.systemId) || !isFleetId(p.fleetId) || !isNonNeg(p.legSeq) || !isNonNeg(p.moveSeq)
    || !Object.values(ALERT_PHASE).includes(p.phase) || !isNonNeg(p.appearAt) || !isNonNeg(p.at)) return null;
  return p;
}

function parseStepPayload(p) {
  if (!isPlain(p) || !sameKeys(p, STEP_KEYS)) return null;
  if (!isId(p.systemId) || !isFleetId(p.fleetId) || !isNonNeg(p.legSeq) || !isNonNeg(p.moveSeq)
    || !Object.values(STEP_PHASE).includes(p.phase) || !isNonNeg(p.attempt) || !isNonNeg(p.round)
    || !isNonNeg(p.at)) return null;
  if (p.targetFleetId !== null && !isFleetId(p.targetFleetId)) return null;
  if (p.phase === STEP_PHASE.STRIKE) {
    return p.targetFleetId === null && p.attempt === 0 && p.round === 0 ? p : null;
  }
  if (p.phase !== STEP_PHASE.POST && p.targetFleetId === null) return null;
  return p;
}

const alertPayload = (v) => ({ systemId: v.systemId, fleetId: v.fleetId, legSeq: v.legSeq, moveSeq: v.moveSeq,
  phase: v.phase, appearAt: v.appearAt, at: v.at });
const stepPayload = (v) => ({ fleetId: v.fleetId, systemId: v.systemId, legSeq: v.legSeq, moveSeq: v.moveSeq,
  phase: v.phase, targetFleetId: v.targetFleetId === undefined ? null : v.targetFleetId, attempt: v.attempt || 0,
  round: v.round || 0, at: v.at });

module.exports = { ALERT_EVENT, STEP_EVENT, ALERT_PHASE, STEP_PHASE, alertKey, locateAlertKey, stepKey, stepTag,
  jitterOf, parseAlertPayload, parseStepPayload, alertPayload, stepPayload };
