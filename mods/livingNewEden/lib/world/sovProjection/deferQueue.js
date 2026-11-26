"use strict";

function createDeferQueue(deps) {
  const maxSystems = Number.isSafeInteger(deps && deps.maxSystems) && deps.maxSystems > 0 ? deps.maxSystems : 1;
  const now = deps.now;
  const setTimer = deps.setTimer;
  const onDue = deps.onDue;
  const onDrop = typeof deps.onDrop === "function" ? deps.onDrop : null;
  const onEmpty = typeof deps.onEmpty === "function" ? deps.onEmpty : null;
  const entries = new Map();
  let timer = null;
  let timerAt = null;
  let dropped = 0;
  let minDueAt = null;
  let minValid = true;

  function cancelTimer() {
    const handle = timer;
    timer = null;
    timerAt = null;
    if (handle && typeof handle.cancel === "function") {
      try {
        handle.cancel();
      } catch (_err) {
      }
    }
  }

  function fire() {
    timer = null;
    timerAt = null;
    try {
      onDue();
    } catch (_err) {
    }
  }

  function nextDueAt() {
    if (minValid) return minDueAt;
    let min = null;
    for (const e of entries.values()) if (min === null || e.dueAt < min) min = e.dueAt;
    minDueAt = min;
    minValid = true;
    return min;
  }

  function noteDueAt(dueAt, oldDueAt) {
    if (!minValid) return;
    if (minDueAt === null || dueAt < minDueAt) minDueAt = dueAt;
    else if (oldDueAt !== null && oldDueAt === minDueAt && dueAt > oldDueAt) minValid = false;
  }

  function remove(systemId) {
    const e = entries.get(systemId);
    if (!e) return false;
    entries.delete(systemId);
    if (entries.size === 0) {
      minDueAt = null;
      minValid = true;
      if (onEmpty) {
        try {
          onEmpty();
        } catch (_err) {
        }
      }
    } else if (minValid && e.dueAt === minDueAt) {
      minValid = false;
    }
    return true;
  }

  return Object.freeze({
    defer(systemId, spec) {
      if (!Number.isSafeInteger(systemId) || systemId <= 0) return { ok: false, reason: "INVALID_SYSTEM" };
      const dueAt = spec && Number.isFinite(spec.dueAt) ? Math.trunc(spec.dueAt) : now();
      const reason = spec && typeof spec.reason === "string" ? spec.reason : "UNKNOWN";
      const failure = Boolean(spec && spec.failure);
      const existing = entries.get(systemId);
      if (existing) {
        const oldDueAt = existing.dueAt;
        existing.dueAt = dueAt;
        noteDueAt(dueAt, oldDueAt);
        existing.reason = reason;
        if (failure) existing.attempts += 1;
        return { ok: true, added: false, attempts: existing.attempts };
      }
      if (entries.size >= maxSystems) {
        dropped += 1;
        if (onDrop) {
          try {
            onDrop(systemId);
          } catch (_err) {
          }
        }
        return { ok: false, reason: "DEFER_FULL" };
      }
      const entry = { dueAt, reason, attempts: failure ? 1 : 0, firstAt: now() };
      entries.set(systemId, entry);
      noteDueAt(dueAt, null);
      return { ok: true, added: true, attempts: entry.attempts };
    },
    remove,
    has: (systemId) => entries.has(systemId),
    attemptsOf(systemId) {
      const e = entries.get(systemId);
      return e ? e.attempts : 0;
    },
    takeDue(atMs, max) {
      const out = [];
      const limit = Number.isSafeInteger(max) && max > 0 ? max : 1;
      for (const [systemId, e] of entries) {
        if (out.length >= limit) break;
        if (e.dueAt <= atMs) out.push(systemId);
      }
      return out;
    },
    size: () => entries.size,
    nextDueAt,
    arm(opts) {
      let at = nextDueAt();
      if (at === null) {
        cancelTimer();
        return;
      }
      if (opts && Number.isFinite(opts.notBefore) && opts.notBefore > at) at = Math.trunc(opts.notBefore);
      if (timer && timerAt === at) return;
      cancelTimer();
      timerAt = at;
      timer = setTimer(fire, Math.max(0, at - now()));
    },
    clear() {
      cancelTimer();
      entries.clear();
      minDueAt = null;
      minValid = true;
    },
    getStatus() {
      let oldestAt = null;
      for (const e of entries.values()) if (oldestAt === null || e.firstAt < oldestAt) oldestAt = e.firstAt;
      return { depth: entries.size, nextDueAt: nextDueAt(), oldestAt, dropped, armedAt: timerAt };
    },
  });
}

module.exports = { createDeferQueue };
