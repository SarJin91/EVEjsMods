"use strict";

const PATHS = Object.freeze({ crimewatchRuntime: "services/security/crimewatchRuntimeState",
  characterState: "services/character/characterState" });

const isObj = (v) => Boolean(v) && typeof v === "object";
const isId = (v) => Number.isSafeInteger(v) && v > 0;
const fail = (reason) => ({ ok: false, reason });

function readCrimeFlagsFrom(mods, playerId) {
  const m = isObj(mods) ? mods.crimewatchRuntime : null;
  if (!isObj(m) || typeof m.getCharacterState !== "function") return fail("SEAM_UNAVAILABLE");
  if (!isId(playerId)) return fail("INVALID_INPUT");
  let state;
  try {
    state = m.getCharacterState(playerId);
  } catch (_err) {
    return fail("READ_FAILED");
  }
  if (!isObj(state)) return { ok: true, found: false, criminal: false, suspect: false, timerExpiresAtMs: 0 };
  const exp = Number(state.criminalTimerExpiresAtMs);
  const criminal = state.criminal === true;
  return { ok: true, found: true, criminal, suspect: !criminal && state.suspect === true,
    timerExpiresAtMs: Number.isFinite(exp) && exp > 0 ? exp : 0 };
}

function readSecurityStatusFrom(mods, playerId) {
  const m = isObj(mods) ? mods.characterState : null;
  if (!isObj(m) || typeof m.peekCharacterRecord !== "function") return fail("SEAM_UNAVAILABLE");
  if (!isId(playerId)) return fail("INVALID_INPUT");
  try {
    const rec = m.peekCharacterRecord(playerId);
    if (!isObj(rec)) return { ok: true, securityStatus: null };
    const raw = rec.securityStatus ?? rec.securityRating;
    const sec = raw === null || raw === undefined ? NaN : Number(raw);
    return { ok: true, securityStatus: Number.isFinite(sec) ? sec : null };
  } catch (_err) {
    return fail("READ_FAILED");
  }
}

module.exports = { readCrimeFlagsFrom, readSecurityStatusFrom, PATHS };
