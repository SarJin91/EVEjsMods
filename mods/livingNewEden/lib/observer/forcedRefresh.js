"use strict";

const WINDOW_MS = 60000;

function positiveOrZero(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function createForcedRefreshLimiter(options) {
  const maxStaleMs = positiveOrZero(options && options.maxStaleMs);
  const maxPerMinute = positiveOrZero(options && options.maxPerMinute);
  const enabled = maxStaleMs > 0 && maxPerMinute > 0;
  const lastForcedAtMs = new Map();
  const recent = [];

  function prune(nowMs) {
    while (recent.length > 0 && nowMs - recent[0] >= WINDOW_MS) recent.shift();
  }

  function check(slot, lastGoodAtMs, nowMs) {
    if (!enabled) return { ok: false, reason: "OFF" };
    if (lastGoodAtMs !== null && nowMs - lastGoodAtMs <= maxStaleMs) return { ok: false, reason: "FRESH" };
    const last = lastForcedAtMs.get(slot);
    if (last !== undefined && nowMs - last < maxStaleMs) return { ok: false, reason: "SLOT_RATE" };
    prune(nowMs);
    if (recent.length >= maxPerMinute) return { ok: false, reason: "GLOBAL_CAP" };
    return { ok: true };
  }

  function commit(slot, nowMs) {
    lastForcedAtMs.set(slot, nowMs);
    recent.push(nowMs);
  }

  function forget(slot) {
    lastForcedAtMs.delete(slot);
  }

  return Object.freeze({ enabled, check, commit, forget });
}

module.exports = { WINDOW_MS, createForcedRefreshLimiter };
