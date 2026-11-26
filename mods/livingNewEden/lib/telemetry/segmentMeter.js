"use strict";

const PASS_LABEL = "pass";

function noop() {}

function isThenable(value) {
  return value !== null && (typeof value === "object" || typeof value === "function") && typeof value.then === "function";
}

function createSegmentMeter(opts) {
  const nowMs = opts && typeof opts.nowMs === "function" ? opts.nowMs : () => 0;
  const onSegment = opts && typeof opts.onSegment === "function" ? opts.onSegment : noop;
  let inPass = false;
  let inFlight = 0;
  let open = false;
  let openAt = 0;
  let openLabel = PASS_LABEL;
  let segments = 0;
  let maxMs = 0;

  function openSegment(label) {
    open = true;
    openLabel = label;
    openAt = nowMs();
  }

  function closeSegment() {
    if (!open) return;
    open = false;
    const ms = Math.max(0, nowMs() - openAt);
    segments += 1;
    if (ms > maxMs) maxMs = ms;
    try {
      onSegment(openLabel, openAt, ms);
    } catch (_err) {
    }
  }

  function begin() {
    closeSegment();
    inPass = true;
    openSegment(PASS_LABEL);
  }

  function end() {
    closeSegment();
    inPass = false;
  }

  function resume(name) {
    inFlight = inFlight > 0 ? inFlight - 1 : 0;
    if (inPass && inFlight === 0 && !open) openSegment(name);
  }

  function wrapFacade(facade) {
    if (facade === null || typeof facade !== "object") return facade;
    const out = {};
    for (const key of Object.keys(facade)) {
      if (typeof facade[key] !== "function") {
        out[key] = facade[key];
        continue;
      }
      const onSettle = () => resume(key);
      out[key] = function meteredCall(...args) {
        const r = facade[key].apply(facade, args);
        if (isThenable(r)) {
          closeSegment();
          inFlight += 1;
          try {
            r.then(onSettle, onSettle);
          } catch (_err) {
            onSettle();
          }
        }
        return r;
      };
    }
    return out;
  }

  function wrapTimer(setTimer) {
    return (fn, ms) => setTimer(() => {
      begin();
      let p;
      try {
        p = fn();
      } catch (err) {
        end();
        throw err;
      }
      Promise.resolve(p).then(end, end);
      return p;
    }, ms);
  }

  return Object.freeze({
    wrapFacade,
    wrapTimer,
    getStatus: () => ({ segments, maxMs, inPass }),
  });
}

module.exports = { createSegmentMeter, PASS_LABEL };
