"use strict";

const S = require("./schema");

const METRIC_NUDGE_ENQUEUED = "events.nudgeEnqueued";
const METRIC_NUDGE_DUPLICATE = "events.nudgeDuplicate";
const METRIC_NUDGE_REFUSED = "events.nudgeRefused";

function createPresenceTrigger(deps) {
  const { scheduler, clock, P } = deps;
  const telemetry = deps.telemetry || null;
  const setTimer = typeof deps.setTimer === "function" ? deps.setTimer : null;
  let current = null;
  let unsubscribe = null;
  let subscribed = false;
  let planned = new Set();
  let handle = null;
  let armed = false;
  let stopped = false;
  let lastNudgeAt = null;

  function count(name) {
    if (!telemetry || typeof telemetry.count !== "function") return;
    try {
      telemetry.count(name, 1);
    } catch (_err) {
    }
  }

  function presenceNow() {
    try {
      const p = typeof deps.getPresence === "function" ? deps.getPresence() : null;
      return p && typeof p === "object" ? p : null;
    } catch (_err) {
      return null;
    }
  }

  function clearTimer() {
    const h = handle;
    handle = null;
    armed = false;
    if (!h) return;
    try {
      if (typeof h.cancel === "function") h.cancel();
      else if (typeof h.clear === "function") h.clear();
    } catch (_err) {
    }
  }

  function dropSubscription() {
    const u = unsubscribe;
    unsubscribe = null;
    subscribed = false;
    if (!u) return;
    try {
      u();
    } catch (_err) {
    }
  }

  function arm(ms) {
    if (stopped || armed || !setTimer) return;
    try {
      armed = true;
      handle = setTimer(fire, Math.max(0, ms));
    } catch (_err) {
      armed = false;
      handle = null;
    }
  }

  function enqueueNudge() {
    const now = clock.now();
    const N = P.nudgeMinIntervalMs;
    const I = P.refreshIntervalMs;
    const slot = Math.floor(now / N);
    let r = null;
    try {
      r = scheduler.enqueue(S.PULSE_EVENT, S.PULSE_AGGREGATE_ID, now, { intervalMs: I, nudge: slot },
        S.nudgeKey(I, N, slot));
    } catch (_err) {
      r = null;
    }
    if (r && r.ok === true && r.duplicate !== true) {
      count(METRIC_NUDGE_ENQUEUED);
      lastNudgeAt = now;
    } else if (r && r.ok === true) {
      count(METRIC_NUDGE_DUPLICATE);
      arm((slot + 1) * N - now);
    } else {
      count(METRIC_NUDGE_REFUSED);
    }
  }

  function fire() {
    handle = null;
    armed = false;
    try {
      if (stopped || planned.size === 0) return;
      const p = presenceNow();
      if (!p || typeof p.getStatus !== "function" || typeof p.distanceToObserved !== "function") return;
      const status = p.getStatus();
      if (!status || !status.available || status.stale) return;
      const R = Math.min(P.activationRadius, P.presenceRadius);
      for (const sys of [...planned].sort((a, b) => a - b)) {
        const d = p.distanceToObserved(sys, P.presenceRadius);
        if (d && d.ok === true && Number.isSafeInteger(d.distance) && d.distance <= R) {
          enqueueNudge();
          return;
        }
      }
    } catch (_err) {
    }
  }

  function onObserved() {
    arm(0);
  }

  function ensureSubscribed() {
    if (stopped) return;
    const p = presenceNow();
    if (p === current) return;
    dropSubscription();
    current = p;
    if (!p || typeof p.onSystemObserved !== "function") return;
    try {
      const r = p.onSystemObserved(onObserved);
      if (r && r.ok === true && typeof r.unsubscribe === "function") {
        unsubscribe = r.unsubscribe;
        subscribed = true;
      }
    } catch (_err) {
    }
  }

  function setPlanned(systemIds) {
    if (stopped) return;
    const next = new Set((Array.isArray(systemIds) ? systemIds : []).filter((id) => Number.isSafeInteger(id)));
    let fresh = false;
    for (const id of next) {
      if (!planned.has(id)) {
        fresh = true;
        break;
      }
    }
    planned = next;
    if (fresh) arm(0);
  }

  function getStatus() {
    return Object.freeze({ subscribed, planned: planned.size, lastNudgeAt, armed });
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    clearTimer();
    dropSubscription();
    current = null;
    planned = new Set();
  }

  return Object.freeze({ setPlanned, ensureSubscribed, getStatus, stop });
}

module.exports = { createPresenceTrigger, METRIC_NUDGE_ENQUEUED, METRIC_NUDGE_DUPLICATE, METRIC_NUDGE_REFUSED };
