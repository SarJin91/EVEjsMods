"use strict";

const NO_TIME_SCALE = 1;
const MIN_TIME_SCALE = 1;
const MAX_TIME_SCALE = 100;
const MIN_SCALED_DURATION_MS = 1;

function normalizeTimeScale(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return NO_TIME_SCALE;
  if (value < MIN_TIME_SCALE || value > MAX_TIME_SCALE) return NO_TIME_SCALE;
  return value;
}

function buildClock(readNow, timeScale) {
  let last = 0;

  function now() {
    const raw = Math.floor(Number(readNow()));
    if (Number.isFinite(raw) && raw > last) last = raw;
    return last;
  }

  function travelDurationMs(baseMs, opts) {
    if (typeof baseMs !== "number" || !Number.isFinite(baseMs) || baseMs < 0) {
      throw new RangeError(`travelDurationMs: baseMs must be a finite number >= 0, got ${String(baseMs)}`);
    }
    const observed = !(opts && opts.observed === false);
    if (observed) return Math.round(baseMs);
    return Math.max(MIN_SCALED_DURATION_MS, Math.round(baseMs / timeScale));
  }

  return { now, travelDurationMs, timeScale };
}

function createClock(opts = {}) {
  const nowFn = typeof opts.nowFn === "function" ? opts.nowFn : Date.now;
  const clock = buildClock(nowFn, normalizeTimeScale(opts.timeScale));
  return Object.freeze(clock);
}

function createManualClock(startMs = 0, opts = {}) {
  let current = Number(startMs);
  const clock = buildClock(() => current, normalizeTimeScale(opts.timeScale));
  function advance(ms) {
    if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) {
      throw new RangeError(`advance: ms must be a finite number >= 0, got ${String(ms)}`);
    }
    current += ms;
    return clock.now();
  }
  function set(ms) {
    current = Number(ms);
    return clock.now();
  }
  return Object.freeze({ ...clock, advance, set });
}

module.exports = { createClock, createManualClock };
