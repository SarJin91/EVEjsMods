"use strict";

function num(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function createEntry(id, kind) {
  return { id, kind, nextAtSimMs: 0, applyAtSimMs: null, targetId: null, lastReason: null };
}

function isDue(entry, simMs) {
  return Boolean(entry) && num(simMs, 0) >= num(entry.nextAtSimMs, 0);
}

function advance(entry, durationMs, simMs) {
  const d = Math.max(1, num(durationMs, 1));
  const now = num(simMs, 0);
  let next = num(entry.nextAtSimMs, 0) + d;
  if (next + d <= now) next = now + d;
  entry.nextAtSimMs = next;
  entry.lastReason = null;
  return entry;
}

function pause(entry, retryMs, simMs, reason) {
  entry.nextAtSimMs = num(simMs, 0) + Math.max(0, num(retryMs, 0));
  if (reason !== undefined) entry.lastReason = reason === null ? null : String(reason);
  return entry;
}

function cycleOk(durationMs, data) {
  return { ok: true, durationMs, data: data || {} };
}

function cycleFail(reason, retryMs) {
  return { ok: false, reason: String(reason), retryMs: Number.isFinite(retryMs) && retryMs >= 0 ? retryMs : null };
}

function applyCycleResult(entry, result, simMs, fallbackRetryMs) {
  if (result && result.ok === true) return advance(entry, result.durationMs, simMs);
  const reason = result && typeof result.reason === "string" ? result.reason : "ERROR";
  const retry = result && Number.isFinite(result.retryMs) ? result.retryMs : fallbackRetryMs;
  return pause(entry, retry, simMs, reason);
}

function createTickBudget(limit) {
  const max = Math.max(0, Math.trunc(num(limit, 0)));
  let tickAt = null;
  let used = 0;
  let deferred = 0;
  return {
    take(nowMs) {
      if (nowMs !== tickAt) {
        tickAt = nowMs;
        used = 0;
        deferred = 0;
      }
      if (used < max) {
        used += 1;
        return true;
      }
      deferred += 1;
      return false;
    },
    get used() {
      return used;
    },
    get deferred() {
      return deferred;
    },
  };
}

module.exports = {
  createEntry, isDue, advance, pause, cycleOk, cycleFail, applyCycleResult, createTickBudget,
};
