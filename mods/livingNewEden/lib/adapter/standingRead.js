"use strict";

const STANDING_READ_INVALID = Object.freeze({ ok: false, reason: "STANDING_READ_INVALID" });
const STANDING_READ_THREW = Object.freeze({ ok: false, reason: "STANDING_READ_THREW" });
const SEAM_UNAVAILABLE = Object.freeze({ ok: false, reason: "SEAM_UNAVAILABLE" });

function readCharacterStandingFrom(characterState, standingRuntime, characterId, ownerId) {
  if (!Number.isSafeInteger(characterId) || characterId <= 0) {
    return { ok: false, reason: "STANDING_READ_INVALID", detail: "characterId" };
  }
  if (!Number.isSafeInteger(ownerId) || ownerId <= 0) {
    return { ok: false, reason: "STANDING_READ_INVALID", detail: "ownerId" };
  }

  if (!characterState || typeof characterState.peekCharacterRecord !== "function") {
    return { ok: false, reason: "SEAM_UNAVAILABLE", detail: "peekCharacterRecord_missing" };
  }
  if (!standingRuntime || typeof standingRuntime.getCharacterRawStandingFromRecord !== "function") {
    return { ok: false, reason: "SEAM_UNAVAILABLE", detail: "getCharacterRawStandingFromRecord_missing" };
  }

  let record;
  try {
    record = characterState.peekCharacterRecord(characterId);
  } catch (err) {
    return { ok: false, reason: "STANDING_READ_THREW", detail: String((err && err.message) || err) };
  }

  if (!record) {
    return { ok: true, found: false, standing: 0 };
  }

  let raw;
  try {
    raw = standingRuntime.getCharacterRawStandingFromRecord(record, ownerId, characterId);
  } catch (err) {
    return { ok: false, reason: "STANDING_READ_THREW", detail: String((err && err.message) || err) };
  }

  let standing = 0;
  if (raw !== null && raw !== undefined) {
    const value = typeof raw === "object" ? raw.standing : raw;
    const num = typeof value === "number" || typeof value === "string" ? Number(value) : NaN;
    if (Number.isFinite(num)) standing = num;
  }

  return { ok: true, found: true, standing };
}

module.exports = { readCharacterStandingFrom };