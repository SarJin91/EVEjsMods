"use strict";

const {
  DEFAULT_OCCUPATION_STATE,
  SCORE_MIN,
  SCORE_MAX,
  DEFAULT_THREAT_LEVEL,
  isOccupationState,
  isSecurityClass,
} = require("./schema");

const REASON_RE = /^[A-Z][A-Z0-9_]*$/;
const CHANGE_KEYS = Object.freeze(["systemId", "expectedVersion", "reason", "state", "influence"]);
const OCCUPATION_ID_KEYS = Object.freeze(["occupierFactionId", "previousControllerFactionId"]);
const OCCUPATION_TIME_KEYS = Object.freeze(["phaseDueAt", "influenceEvaluatedAt", "capturedAt", "detachedSinceAt"]);
const STATE_KEYS = Object.freeze(["securityClass", "controllerFactionId", "occupationState", "threatLevel",
  "nextStrategyReviewAt", ...OCCUPATION_ID_KEYS, "phaseSeq", ...OCCUPATION_TIME_KEYS]);
const AMOUNT_KEYS = Object.freeze(["garrisonStrength", "localSupply", "supplyCapacity"]);
const INFLUENCE_KEYS = Object.freeze(["factionId", "influenceScore", ...AMOUNT_KEYS]);
const CREATE_VERSION = 0;

function invalid(detail) {
  return { ok: false, reason: "WORLD_INVALID_INPUT", detail };
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isPositiveId(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function isTime(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function unknownKey(obj, allowed) {
  return Object.keys(obj).find((key) => !allowed.includes(key));
}

function has(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key) && obj[key] !== undefined;
}

function validateState(state, create) {
  if (state === undefined) {
    if (create) return invalid("state: required when creating (securityClass)");
    return { ok: true, value: {} };
  }
  if (!isPlainObject(state)) return invalid("state: not an object");
  const extra = unknownKey(state, STATE_KEYS);
  if (extra !== undefined) return invalid(`state: unknown key ${extra}`);
  const out = {};
  if (has(state, "securityClass")) {
    if (!create) return invalid("state.securityClass: only when creating");
    if (!isSecurityClass(state.securityClass)) {
      return { ok: false, reason: "UNKNOWN_SECURITY_CLASS", value: state.securityClass };
    }
    out.securityClass = state.securityClass;
  } else if (create) {
    return invalid("state.securityClass: required when creating");
  }
  if (has(state, "controllerFactionId") || create) {
    const v = has(state, "controllerFactionId") ? state.controllerFactionId : null;
    if (v !== null && !isPositiveId(v)) return invalid("state.controllerFactionId");
    out.controllerFactionId = v;
  }
  if (has(state, "occupationState") || create) {
    const v = has(state, "occupationState") ? state.occupationState : DEFAULT_OCCUPATION_STATE;
    if (!isOccupationState(v)) return { ok: false, reason: "UNKNOWN_OCCUPATION_STATE", value: v };
    out.occupationState = v;
  }
  if (has(state, "threatLevel") || create) {
    const v = has(state, "threatLevel") ? state.threatLevel : DEFAULT_THREAT_LEVEL;
    if (typeof v !== "number" || !Number.isFinite(v)) return invalid("state.threatLevel");
    if (v < SCORE_MIN || v > SCORE_MAX) return { ok: false, reason: "THREAT_OUT_OF_RANGE", value: v };
    out.threatLevel = v;
  }
  if (has(state, "nextStrategyReviewAt") || create) {
    const v = has(state, "nextStrategyReviewAt") ? state.nextStrategyReviewAt : null;
    if (v !== null && !isTime(v)) return invalid("state.nextStrategyReviewAt");
    out.nextStrategyReviewAt = v;
  }
  for (const key of OCCUPATION_ID_KEYS) {
    if (!has(state, key)) continue;
    if (create) return invalid(`state.${key}: only when updating`);
    if (state[key] !== null && !isPositiveId(state[key])) return invalid(`state.${key}`);
    out[key] = state[key];
  }
  if (has(state, "phaseSeq")) {
    if (create) return invalid("state.phaseSeq: only when updating");
    if (!isTime(state.phaseSeq)) return invalid("state.phaseSeq");
    out.phaseSeq = state.phaseSeq;
  }
  for (const key of OCCUPATION_TIME_KEYS) {
    if (!has(state, key)) continue;
    if (create) return invalid(`state.${key}: only when updating`);
    if (state[key] !== null && !isTime(state[key])) return invalid(`state.${key}`);
    out[key] = state[key];
  }
  return { ok: true, value: out };
}

function validateInfluence(influence, limit) {
  if (influence === undefined) return { ok: true, value: [] };
  if (!Array.isArray(influence)) return invalid("influence: not an array");
  if (influence.length > limit) return { ok: false, reason: "TOO_MANY_FACTIONS", count: influence.length, limit };
  const seen = new Set();
  const out = [];
  for (let i = 0; i < influence.length; i += 1) {
    const entry = influence[i];
    if (!isPlainObject(entry)) return invalid(`influence[${i}]: not an object`);
    const extra = unknownKey(entry, INFLUENCE_KEYS);
    if (extra !== undefined) return invalid(`influence[${i}]: unknown key ${extra}`);
    const factionId = entry.factionId;
    if (!isPositiveId(factionId)) return invalid(`influence[${i}].factionId`);
    if (seen.has(factionId)) return invalid(`influence: duplicate factionId ${factionId}`);
    seen.add(factionId);
    const item = { factionId };
    if (has(entry, "influenceScore")) {
      const v = entry.influenceScore;
      if (typeof v !== "number" || !Number.isFinite(v)) return invalid(`influence[${i}].influenceScore`);
      if (v < SCORE_MIN || v > SCORE_MAX) return { ok: false, reason: "INFLUENCE_OUT_OF_RANGE", factionId, value: v };
      item.influenceScore = v;
    }
    for (const field of AMOUNT_KEYS) {
      if (!has(entry, field)) continue;
      const v = entry[field];
      if (typeof v !== "number" || !Number.isFinite(v)) return invalid(`influence[${i}].${field}`);
      if (v < 0) return { ok: false, reason: "NEGATIVE_AMOUNT", field, factionId, value: v };
      if (!Number.isSafeInteger(v)) return invalid(`influence[${i}].${field}: not an integer`);
      item[field] = v;
    }
    out.push(item);
  }
  out.sort((a, b) => a.factionId - b.factionId);
  return { ok: true, value: out };
}

function validateChange(change, limits) {
  if (!isPlainObject(change)) return invalid("change: not an object");
  const extra = unknownKey(change, CHANGE_KEYS);
  if (extra !== undefined) return invalid(`change: unknown key ${extra}`);
  if (!isPositiveId(change.systemId)) return invalid("systemId");
  const expectedVersion = change.expectedVersion;
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < CREATE_VERSION) return invalid("expectedVersion");
  if (typeof change.reason !== "string" || !REASON_RE.test(change.reason)) return invalid("reason");
  const create = expectedVersion === CREATE_VERSION;
  const state = validateState(change.state, create);
  if (!state.ok) return state;
  const limit = limits && limits.maxFactionsPerSystem;
  if (!Number.isSafeInteger(limit) || limit < 1) return invalid("limits.maxFactionsPerSystem");
  const influence = validateInfluence(change.influence, limit);
  if (!influence.ok) return influence;
  if (!create && Object.keys(state.value).length === 0 && influence.value.length === 0) {
    return invalid("change: empty");
  }
  return {
    ok: true,
    normalized: {
      systemId: change.systemId,
      expectedVersion,
      reason: change.reason,
      create,
      state: state.value,
      influence: influence.value,
    },
  };
}

function toJournalPayload(normalized) {
  return {
    systemId: normalized.systemId,
    create: normalized.expectedVersion === CREATE_VERSION,
    state: normalized.state,
    influence: normalized.influence,
  };
}

module.exports = { validateChange, toJournalPayload, CREATE_VERSION };
