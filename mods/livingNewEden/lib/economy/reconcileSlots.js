"use strict";

const OPEN_EVENT_STATES = Object.freeze(["QUEUED", "CLAIMED", "RETRY"]);

function nextReconcileKey(scheduler, spec) {
  try {
    if (!scheduler || typeof scheduler.findByKey !== "function" || !spec || typeof spec.baseKey !== "string"
      || !Number.isSafeInteger(spec.maxAttempts) || spec.maxAttempts < 1) {
      return { ok: false, reason: "RECONCILE_INVALID_INPUT" };
    }
    const look = (key) => {
      const f = scheduler.findByKey(key);
      if (!f || f.ok !== true) return { ok: false, reason: (f && f.reason) || "FIND_FAILED" };
      if (!f.found) return { ok: true, state: null };
      return { ok: true, state: f.event && f.event.state };
    };
    for (const key of [spec.dueKey, spec.baseKey]) {
      if (typeof key !== "string") continue;
      const r = look(key);
      if (!r.ok) return r;
      if (OPEN_EVENT_STATES.includes(r.state)) return { ok: true, open: true };
    }
    for (let n = 0; n < spec.maxAttempts; n += 1) {
      const key = `${spec.baseKey}:${n}`;
      const r = look(key);
      if (!r.ok) return r;
      if (r.state === null) return { ok: true, key };
      if (OPEN_EVENT_STATES.includes(r.state)) return { ok: true, open: true };
    }
    return { ok: true, exhausted: true };
  } catch (err) {
    return { ok: false, reason: `RECONCILE_KEY_FAILED: ${String((err && err.message) || err).slice(0, 120)}` };
  }
}

module.exports = { nextReconcileKey, OPEN_EVENT_STATES };
