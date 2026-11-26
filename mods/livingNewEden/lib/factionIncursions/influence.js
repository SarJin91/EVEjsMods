// Port with changes of EveJS 261108.1 (AGPL-3.0-only, see CREDITS.md): - incursionLifecycleContract.js projectInfluence -> projectMilli (milli 0..1000 integers instead of the float 0..1; the decay is floored per call, the Python 2 integer minute division is kept),

"use strict";

const MILLI_MAX = 1000;
const SCORE_MAX = 100;
const MINUTE_MS = 60000;
const MINUTES_PER_HOUR = 60;

const isInt = (v) => Number.isSafeInteger(v);

function projectMilli(snap, now) {
  const s = snap || {};
  const { valueMilli, updatedAt, graceMinutes, decayMilliPerHour } = s;
  if (![valueMilli, updatedAt, graceMinutes, decayMilliPerHour, now].every(isInt) || valueMilli < 0
    || valueMilli > MILLI_MAX || graceMinutes < 0 || decayMilliPerHour < 0) {
    return null;
  }
  let projected = valueMilli;
  if (decayMilliPerHour > 0 && now - graceMinutes * MINUTE_MS > updatedAt) {
    const minutes = Math.max(Math.floor((now - updatedAt) / MINUTE_MS) - graceMinutes, 0);
    projected -= Math.floor((decayMilliPerHour * minutes) / MINUTES_PER_HOUR);
  }
  return projected < 0 ? 0 : projected;
}

function applyCompletion(snap, completedAt, expiresAt, perCompletionMilli) {
  if (!isInt(completedAt) || !isInt(expiresAt) || !isInt(perCompletionMilli) || perCompletionMilli < 0) return null;
  const clock = Math.max(snap && isInt(snap.updatedAt) ? snap.updatedAt : 0, completedAt);
  const before = projectMilli(snap, clock);
  if (before === null) return null;
  if (completedAt >= expiresAt) {
    return { accepted: false, before, valueMilli: snap.valueMilli, updatedAt: snap.updatedAt };
  }
  return { accepted: true, before, valueMilli: Math.min(MILLI_MAX, before + perCompletionMilli), updatedAt: clock };
}

function initialMilli(occupierScore, params) {
  const p = params || {};
  if (!isInt(p.initialMaxMilli) || !isInt(p.initialMinMilli)) return null;
  const score = Number.isFinite(occupierScore) ? Math.min(SCORE_MAX, Math.max(0, occupierScore)) : 0;
  const raw = Math.floor(p.initialMaxMilli - ((p.initialMaxMilli - p.initialMinMilli) * score) / SCORE_MAX + 0.5);
  const lo = Math.max(0, Math.min(p.initialMinMilli, p.initialMaxMilli));
  const hi = Math.min(MILLI_MAX, Math.max(p.initialMinMilli, p.initialMaxMilli));
  return Math.min(hi, Math.max(lo, raw));
}

module.exports = { MILLI_MAX, projectMilli, applyCompletion, initialMilli };
