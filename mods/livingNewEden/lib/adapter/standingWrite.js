"use strict";

const PERMANENT_ERRORS = Object.freeze({
  CHARACTER_NOT_FOUND: "CHARACTER_NOT_FOUND",
  IDEMPOTENCY_KEY_REUSED: "IDEMPOTENCY_KEY_REUSED",
  IDEMPOTENCY_KEY_INVALID: "GRANT_INVALID",
  STANDING_CHANGE_REQUIRED: "GRANT_INVALID",
});
const MAX_DETAIL = 120;

const isId = (v) => Number.isSafeInteger(v) && v > 0;

function messageOf(err) {
  return String((err && err.message) || err).slice(0, MAX_DETAIL);
}

function buildStandingGrantCall(grant, data) {
  const bad = (detail) => ({ ok: false, reason: "GRANT_INVALID", detail });
  if (!grant || typeof grant !== "object") return bad("grant");
  if (typeof grant.key !== "string" || grant.key.trim() === "" || grant.key.trim() !== grant.key) return bad("key");
  if (!isId(grant.characterId)) return bad("characterId");
  if (!isId(grant.factionId)) return bad("factionId");
  if (typeof grant.rawChange !== "number" || !Number.isFinite(grant.rawChange) || grant.rawChange === 0) {
    return bad("rawChange");
  }
  if (!data || !isId(data.eventTypeId)) return bad("eventTypeId");
  const msg = data.msgByReason && Object.prototype.hasOwnProperty.call(data.msgByReason, grant.reason)
    ? data.msgByReason[grant.reason] : null;
  if (typeof msg !== "string" || msg === "") return bad("reason");
  return {
    ok: true,
    characterId: grant.characterId,
    changes: [{ ownerID: grant.factionId, rawChange: grant.rawChange, eventTypeID: data.eventTypeId,
      applySocial: false, msg }],
    options: { idempotencyKey: grant.key, disableDerived: true, preservePrecision: true },
  };
}

function standingOf(data, factionId) {
  const list = data && Array.isArray(data.appliedChanges) ? data.appliedChanges : [];
  const row = list.find((c) => c && c.fromID === factionId);
  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  return row ? { previousStanding: num(row.previousStanding), standing: num(row.standing) }
    : { previousStanding: null, standing: null };
}

function applyStandingGrantFrom(standingRuntime, grant, data) {
  try {
    const call = buildStandingGrantCall(grant, data);
    if (!call.ok) return { ok: false, reason: call.reason, permanent: true, detail: call.detail };
    const fn = standingRuntime && standingRuntime.applyStandingChanges;
    if (typeof fn !== "function") return { ok: false, reason: "SEAM_UNAVAILABLE", permanent: false };
    let r;
    try {
      r = fn.call(standingRuntime, call.characterId, call.changes, call.options);
    } catch (err) {
      return { ok: false, reason: "STANDING_THREW", permanent: false, detail: messageOf(err) };
    }
    if (!r || typeof r !== "object") {
      return { ok: false, reason: "STANDING_WRITE_FAILED", permanent: false, detail: "no result" };
    }
    if (r.success === true) {
      return { ok: true, outcome: r.duplicate === true ? "DUPLICATE" : "APPLIED", ...standingOf(r.data, grant.factionId) };
    }
    const errorMsg = typeof r.errorMsg === "string" ? r.errorMsg : "";
    if (Object.prototype.hasOwnProperty.call(PERMANENT_ERRORS, errorMsg)) {
      return { ok: false, reason: PERMANENT_ERRORS[errorMsg], permanent: true, detail: errorMsg };
    }
    return { ok: false, reason: "STANDING_WRITE_FAILED", permanent: false, detail: (errorMsg || "unknown")
      .slice(0, MAX_DETAIL) };
  } catch (err) {
    return { ok: false, reason: "STANDING_THREW", permanent: false, detail: messageOf(err) };
  }
}

function readPirateFactionIdsFrom(policy) {
  try {
    const table = policy && policy.PIRATE_FACTION_BY_FACTION_ID;
    if (!table || typeof table !== "object") return { ok: false, reason: "PIRATE_SET_UNAVAILABLE", detail: "table" };
    const ids = Object.keys(table).map(Number).filter(isId);
    if (ids.length === 0) return { ok: false, reason: "PIRATE_SET_UNAVAILABLE", detail: "empty" };
    return { ok: true, ids: Object.freeze(new Set(ids)) };
  } catch (err) {
    return { ok: false, reason: "PIRATE_SET_UNAVAILABLE", detail: messageOf(err) };
  }
}

module.exports = { buildStandingGrantCall, applyStandingGrantFrom, readPirateFactionIdsFrom, PERMANENT_ERRORS };
